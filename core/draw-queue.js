// NovelAI request queue. One account allows one image at a time; when friends share an account, requests that
// collide get 429 and too many of them can get the account flagged. So:
//   - requests from this browser run one at a time, also across tavern tabs (Web Locks when available);
//   - two requests are at least `gap` apart (the last request time is shared through localStorage);
//   - a 429 ("account busy") waits and retries with growing pauses, up to `retries` times, instead of failing.
//   - with a shared cloud queue (remote), each request also waits for its turn among everyone using the account;
//     when the cloud cannot be reached the job goes ahead with the local rules and remoteError says why.
// Lanes: each drawing engine has its own line (nai, pixai, gpt, comfy), so a long PixAI picture does not hold up another
// engine's pictures; within one engine everything above still holds. A job without a lane is NovelAI's.
// Job states: waiting (in line) · spacing (keeping the gap) · remote (waiting in the cloud queue) · busy (429, waiting to retry) · running.

const LAST_KEY = 'sttts.nai.lastRequest';
const cancelled = () => Object.assign(Error('已取消'), {cancelled: true});

function memoryStorage(key = LAST_KEY) {
  let value = 0;
  try {
    const s = globalThis.localStorage;
    if (s) return {get: () => Number(s.getItem(key)) || 0, set: v => { try { s.setItem(key, String(v)); } catch { value = v; } }};
  } catch { /* storage blocked */ }
  return {get: () => value, set: v => { value = v; }};
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(cancelled()); }, {once: true});
  });
}

export class DrawQueue {
  /**
   * gap(): milliseconds between two requests. retries(): how often a 429 is retried.
   * onChange(list, {remoteError}): called whenever the line changes. backoff(attempt): pause before retry `attempt` (1-based).
   * remote(): the shared cloud queue to wait in, or null.
   */
  constructor({gap = () => 3000, retries = () => 4, concurrency = () => 1, onChange = () => {}, remote = () => null, locks = globalThis.navigator?.locks, storage = memoryStorage(), now = Date.now, wait = pause,
    backoff = attempt => Math.min(120000, 15000 * 2 ** (attempt - 1)) + Math.random() * 3000} = {}) {
    Object.assign(this, {gap, retries, concurrency, onChange, remote, locks, storage, now, wait, backoff});
    this.jobs = [];
    this.remoteError = '';
    this.active = new Set(); // lanes that have a job running
    this.live = new Map(); // lane -> jobs running in it (more than one only where concurrency(lane) allows)
    this.stores = new Map([['nai', storage]]);
  }
  /** Where the time of a lane's last request is kept: the injected storage for NovelAI, one of its own for each other engine. */
  store(lane) {
    if (!this.stores.has(lane)) this.stores.set(lane, memoryStorage(`sttts.${lane}.lastRequest`));
    return this.stores.get(lane);
  }
  get running() { return this.active.size > 0; }
  /** Adds a job; the same key joins the job already in line. task(signal) makes the request. */
  add({key = crypto.randomUUID(), label = '', task, free = false, lane = 'nai'}) {
    const existing = this.jobs.find(j => j.key === key);
    // One that has already failed or finished (it only has not left the line yet) is not joined: asking again right away must draw anew.
    if (existing && !existing.settled) return existing.promise;
    if (existing) this.jobs.splice(this.jobs.indexOf(existing), 1);
    const job = {key, label, task, free, lane, state: 'waiting', attempt: 0, until: 0, controller: new AbortController()};
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.push(job);
    this.changed();
    this.pump();
    return job.promise;
  }
  list() {
    return this.jobs.map(({key, label, state, attempt, until, cloud}, position) => ({key, label, state, attempt, until, position, cloud: cloud || null}));
  }
  get(key) { return this.list().find(j => j.key === key) || null; }
  get pending() { return this.jobs.some(job => !job.settled); }
  /** Whether a picture of one of these lanes (any lane when none is named) is drawing or waiting. */
  pendingIn(...lanes) { return this.jobs.some(job => !job.settled && (!lanes.length || lanes.includes(job.lane))); }
  cancel(key) {
    const index = this.jobs.findIndex(j => j.key === key);
    if (index < 0) return false;
    const job = this.jobs[index];
    job.controller.abort();
    // A running job is stopped by its own run(); one still in line leaves right away.
    if (!job.started) { this.jobs.splice(index, 1); job.reject(cancelled()); this.changed(); }
    return true;
  }
  cancelAll() { for (const job of [...this.jobs].reverse()) this.cancel(job.key); }
  changed() { try { this.onChange(this.list(), {remoteError: this.remoteError}); } catch { /* a listener cannot stop the queue */ } }
  /** Takes a turn in the shared cloud queue; null when there is none or it cannot be reached. */
  async turn(job, signal) {
    const remote = this.remote(job.lane);
    if (!remote) { this.remoteError = ''; return null; }
    try {
      const lease = await remote.acquire({label: job.label, signal, onWait: info => {
        job.state = 'remote'; job.cloud = {position: info.position, holder: info.holder || '', cooldown: info.cooldown || 0}; this.changed();
      }});
      this.remoteError = '';
      return lease;
    } catch (error) {
      if (signal.aborted || error.cancelled) throw cancelled();
      this.remoteError = error.message;
      return null;
    }
  }

  /** How many pictures of a lane may be drawn at once (1 unless the lane allows more: PixAI's API mode). */
  limit(lane) { const n = Math.floor(Number(this.concurrency(lane))); return Number.isFinite(n) && n > 1 ? Math.min(n, 8) : 1; }
  pump() {
    for (const lane of new Set(this.jobs.map(j => j.lane))) {
      const live = this.live.get(lane) || new Set(), cap = this.limit(lane);
      let busy = [...live].filter(j => !j.free).length;
      for (const job of this.jobs) {
        if (job.lane !== lane || job.started) continue;
        // In order: a picture that has to wait for a free place holds back the ones behind it. The 2nd–4th picture of one task are answered from the first's, so they take no place.
        if (!job.free && busy >= cap) break;
        if (!job.free) busy++;
        this.start(job);
      }
    }
  }
  async start(job) {
    const lane = job.lane;
    job.started = true;
    if (!this.live.has(lane)) this.live.set(lane, new Set());
    this.live.get(lane).add(job);
    this.active.add(lane);
    try {
      const run = () => this.run(job);
      // Web Locks keep tabs apart for a lane that draws one at a time; a lane that draws several at once has no use for them.
      try { await (this.locks?.request && this.limit(lane) === 1 ? this.locks.request('st-iphonie-' + (lane === 'nai' ? 'novelai' : lane), {signal: job.controller.signal}, run) : run()); }
      catch (error) { job.settled = true; job.reject(job.controller.signal.aborted ? cancelled() : error); }
    } finally {
      const index = this.jobs.indexOf(job);
      if (index >= 0) this.jobs.splice(index, 1);
      const live = this.live.get(lane);
      live?.delete(job);
      if (!live?.size) { this.live.delete(lane); this.active.delete(lane); }
      this.changed();
      this.pump();
    }
  }
  async run(job) {
    const signal = job.controller.signal;
    try {
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw cancelled();
        // free: answered from a cache that is already there (PixAI's 2nd–4th picture of one task), so no gap is kept.
        const par = this.limit(job.lane) > 1;
        const readyAt = job.free && attempt === 0 ? 0 : this.store(job.lane).get() + this.gap();
        // Several at once: the start is booked right now, so the next one starts a gap after it (not all at the same moment).
        if (par && readyAt) this.store(job.lane).set(Math.max(readyAt, this.now()));
        if (readyAt > this.now()) {
          job.state = 'spacing'; job.until = readyAt; this.changed();
          await this.wait(readyAt - this.now(), signal);
        }
        const lease = await this.turn(job, signal);
        job.state = 'running'; job.attempt = attempt; job.until = 0; job.cloud = null; this.changed();
        try {
          if (signal.aborted) throw cancelled();
          // 取消要立刻生效：任务本身可能卡在不认 abort 的地方（比如一直等着一个没有下文的响应），所以不只靠它自己停
          const work = job.task(signal);
          work.catch(() => {});
          const result = await Promise.race([work, new Promise((_, no) => { if (signal.aborted) no(cancelled()); else signal.addEventListener('abort', () => no(cancelled()), {once: true}); })]);
          if (signal.aborted) throw cancelled();
          if (!job.free && !par) this.store(job.lane).set(this.now());
          lease?.release('done');
          job.settled = true;
          job.resolve(result);
          return;
        } catch (error) {
          if (!par) this.store(job.lane).set(this.now());
          const delay = error?.status === 429 ? this.backoff(attempt + 1) : 0;
          // A 429 makes everyone in the cloud queue wait as well.
          lease?.release(delay ? 'busy' : 'done', delay);
          if (signal.aborted) throw cancelled();
          if (error?.status !== 429 || attempt >= this.retries()) throw error;
          job.state = 'busy'; job.attempt = attempt + 1; job.until = this.now() + delay; this.changed();
          await this.wait(delay, signal);
        }
      }
    } catch (error) {
      job.settled = true;
      job.reject(signal.aborted ? cancelled() : error);
    }
  }
}
