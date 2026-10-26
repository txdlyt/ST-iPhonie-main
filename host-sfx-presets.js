// 音效设定（声临其境移植）: plays the SFX placements a second LLM request plans for a reply, from the 音效设定
// presets' resource map (URL links) and ST-iPhonie's built-in sounds / sound library. An AudioContext of its own, so
// the native soundHost (host-sounds.js) and the voice player are untouched: the two SFX systems run side by side.
//
// 触发链（完整移植自 st-immersive-sound）:
//   · mode 'llm': 新回复到达后, 用 backend.generateText 发一次额外的 LLM 请求（core/sfx-presets.buildPlanPrompt）,
//     解析返回的放置计划（parsePlanReply）, 把 start/end 原文片段定位回正文（locateRange）, 按阅读进度播放。
//   · mode 'tags': 不发额外请求, 直接用 iPhonie 现有的 <sfx>/<ambience> 标签名去 sfx-presets 资源映射里找资源播放
//     （让 URL 资源 / 内置文件能补上原生声音库没有的名字）。
//   ONCE → 一次性播放; LOOP → 循环到 end 区间淡出停止。
import {parseSounds, readingGaps} from './core/sounds.js';
import {buildPlanPrompt, parsePlanReply, computePlacements, placementGaps, collectAssets, resolveResource} from './core/sfx-presets.js';

const FADE = 2, KEEP = 30, LATE = 15000;

export function createSfxPresetsHost({context, settings, backend, notice = () => {},
  AudioContextClass = globalThis.AudioContext, doc = globalThis.document, random = Math.random,
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id)}) {
  const opts = () => settings()?.sfxPresets || {};
  const on = () => opts().enabled === true;
  let ctx = null, master = null, closed = false;
  const buffers = new Map(), plans = new Map(), loopers = new Map();
  let libRows = [], packRows = [], loading = null, told = false;

  // ---------- The library + pack (lazy; only when on) ----------
  function reload() {
    if (!on()) { libRows = []; packRows = []; loading = null; return Promise.resolve([]); }
    loading = Promise.all([backend.listSounds(), backend.sfxPackRows?.() || []]).then(([a, b]) => {
      if (!closed) { libRows = a || []; packRows = b || []; }
      return libRows;
    }).catch(() => libRows);
    return loading;
  }
  const unsubscribe = backend.subscribe?.(event => { if (event?.type === 'sounds' || event?.type === 'settings') { reload(); if (event?.type === 'settings') refresh(); } });
  reload();

  const libraryNames = () => new Set(libRows.map(r => r.name));

  // ---------- Sound out ----------
  function audio() {
    if (!ctx && AudioContextClass && !closed) {
      ctx = new AudioContextClass();
      master = ctx.createGain();
      master.gain.value = opts().volume ?? 0.85;
      master.connect(ctx.destination);
    }
    return ctx;
  }
  const running = () => ctx?.state === 'running';
  function unlock() {
    if (closed || !on()) return Promise.resolve(false);
    const c = audio();
    if (!c) return Promise.resolve(false);
    return c.state === 'running' ? Promise.resolve(true) : Promise.resolve(c.resume()).then(() => running(), () => false);
  }
  function volume() { if (master) master.gain.value = opts().volume ?? 0.85; }
  async function buffer(res) {
    const key = res.kind === 'url' ? 'url:' + res.url : 'id:' + res.id;
    if (buffers.has(key)) return buffers.get(key);
    const job = (async () => {
      let data;
      if (res.kind === 'url') {
        const r = await fetch(res.url);
        if (!r.ok) throw Error('音效链接读不到（' + r.status + '）');
        data = await r.arrayBuffer();
      } else {
        const blob = await backend.soundBlob(res.id);
        if (!blob) throw Error('这个声音已经不在了');
        data = await blob.arrayBuffer();
      }
      return ctx.decodeAudioData(data);
    })().catch(() => { buffers.delete(key); return null; });
    buffers.set(key, job);
    while (buffers.size > KEEP) buffers.delete(buffers.keys().next().value);
    return job;
  }
  /** 一次性播放。 */
  async function shot(res, {gain = 1} = {}) {
    if (!res || !running()) return null;
    let data;
    try { data = await buffer(res); } catch { return null; }
    if (!data || closed || !running()) return null;
    const src = ctx.createBufferSource(), level = ctx.createGain();
    src.buffer = data; level.gain.value = (res.volume ?? 1) * gain * (opts().volume ?? 0.85);
    src.connect(level); level.connect(master);
    src.onended = () => { try { src.disconnect(); level.disconnect(); } catch {} };
    src.start();
    return src;
  }
  /** 循环播放（交叉淡入淡出无缝衔接）, 返回 {stop(seconds)}。 */
  function loopBed(data, res, {gain = 1} = {}) {
    const fade = Math.min(3, data.duration / 4), live = new Set();
    let timer = 0, stopped = false;
    function pass(from, fadeIn) {
      const src = ctx.createBufferSource(), level = ctx.createGain(), t = ctx.currentTime, rest = data.duration - from;
      src.buffer = data; src.connect(level); level.connect(master);
      try {
        level.gain.setValueAtTime(fadeIn ? 0 : 1, t);
        if (fadeIn) level.gain.linearRampToValueAtTime((res.volume ?? 1) * gain, t + fade);
        level.gain.setValueAtTime(level.gain.value, t + Math.max(fade, rest - fade));
        level.gain.linearRampToValueAtTime(0, t + rest);
      } catch {}
      src.onended = () => { live.delete(src); try { src.disconnect(); level.disconnect(); } catch {} };
      src.start(t, from);
      live.add(src);
      timer = setTimer(() => { if (!stopped && !closed) pass(0, true); }, Math.max(0.5, rest - fade) * 1000);
    }
    pass(Math.min(0, Math.max(0, data.duration - 3 * fade)), false);
    return {stop(seconds = FADE) {
      stopped = true; clearTimer(timer);
      // 各 pass 自己的 gain 节点随 src.onended 一并断开; 这里直接停源, 循环间的交叉淡入淡出已保证无缝。
      for (const s of live) { try { s.stop(); } catch {} }
      live.clear();
    }};
  }
  function ramp(param, value, seconds) { try { const t = ctx.currentTime; param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); param.linearRampToValueAtTime(value, t + Math.max(0.01, seconds)); } catch { param.value = value; } }

  /** 把一个资源名解析成可播放形式, 缺资源时记 missing。 */
  async function resolve(name) {
    if (loading) await loading;
    return resolveResource(name, collectAssets(opts().assetProfiles), libraryNames(), packRows);
  }

  // ---------- One placement ----------
  async function cue(placement) {
    if (!on() || closed) return;
    const res = await resolve(placement.entry.name);
    if (!res) { notice(`音效设定里没有「${placement.entry.name}」对应的资源（可在「音效设定」里检测名称）`); return; }
    if (placement.kind === 'once') { await shot(res); return; }
    // loop
    const old = loopers.get(placement.entry.name);
    if (old) { try { old.stop(FADE); } catch {} loopers.delete(placement.entry.name); }
    let data;
    try { data = await buffer(res); } catch { return; }
    if (!data || closed || !running()) return;
    loopers.set(placement.entry.name, loopBed(data, res));
  }
  function stopLoop(name) { const l = loopers.get(name); if (l) { try { l.stop(FADE); } catch {} loopers.delete(name); } }

  // ---------- A new reply, at reading pace ----------
  const message = id => context()?.chat?.[id];
  const rawOf = id => { const m = message(id); return m && !m.is_user && !m.is_system ? String(m.mes ?? '') : null; };
  function cancel(id) { const p = plans.get(id); if (p) { p.cancelled = true; clearTimer(p.timer); plans.delete(id); } }
  function cancelAll() { for (const id of [...plans.keys()]) cancel(id); for (const n of [...loopers.keys()]) stopLoop(n); }

  async function planLlm(id) {
    const raw = rawOf(id);
    if (raw === null) return;
    const profileName = opts().currentProfile, profile = opts().profiles?.[profileName];
    const entries = profile?.entries || [];
    const assetMap = collectAssets(opts().assetProfiles);
    if (!entries.length && !assetMap.size) return;
    const prompt = buildPlanPrompt(entries, assetMap, raw);
    let reply;
    try { reply = await backend.generateText(context(), {prompt, responseLength: 800}); }
    catch (e) { notice('音效设定规划失败：' + (e?.message || e)); return; }
    const plan = parsePlanReply(reply);
    if (!plan.length) return;
    const placements = computePlacements(plan, entries, raw);
    if (!placements.length) return;
    schedule(id, raw, placements);
  }

  /** mode 'tags': 用 iPhonie 现有 <sfx>/<ambience> 标签, 但走 sfx-presets 的资源映射（双模式 url/内置）。 */
  function planTags(id) {
    const raw = rawOf(id);
    if (raw === null) return;
    const tags = parseSounds(raw);
    if (!tags.length) return;
    // 把标签映射成 placement: sfx→once, ambience→loop; start/end 用标签自身区间。
    const profileName = opts().currentProfile, entries = opts().profiles?.[profileName]?.entries || [];
    const byName = new Map(entries.map(e => [e.name, e]));
    const placements = [];
    for (const t of tags) {
      const name = t.stop ? '' : t.name;
      if (!name) { if (t.kind === 'ambience') placements.push({entry: {name: '', loop: true}, kind: 'loop', start: t.start, end: t.end}); continue; }
      // 优先用同名条目; 没有就直接用标签名当资源名
      const entry = byName.get(name) || {name, loop: t.kind === 'ambience', enabled: true, content: name};
      placements.push({entry, kind: t.kind === 'ambience' ? 'loop' : 'once', start: t.start, end: t.end});
    }
    if (placements.length) schedule(id, raw, placements);
  }

  function schedule(id, raw, placements) {
    cancel(id);
    const gaps = placementGaps(raw, placements, {perSecond: opts().perSecond || 14});
    const plan = {cancelled: false, timer: 0};
    plans.set(id, plan);
    let i = 0;
    const step = () => {
      if (plan.cancelled || closed) return;
      if (rawOf(id) !== raw) { cancel(id); return; }
      const p = placements[i];
      if (p.kind === 'once') cue(p).catch(() => {});
      else {
        cue(p).catch(() => {}); // 在区间结束淡出停止: 按区间内可读字数 ÷ 每秒字数计时
        const span = String(raw).slice(p.start, p.end).replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
        const stopAfter = span / (opts().perSecond || 14);
        if (Number.isFinite(stopAfter) && stopAfter > 0) setTimer(() => { if (!plan.cancelled) stopLoop(p.entry.name); }, stopAfter * 1000);
      }
      if (++i >= placements.length) { plans.delete(id); return; }
      plan.timer = setTimer(step, gaps[i] * 1000);
    };
    plan.timer = setTimer(step, gaps[0] * 1000);
  }

  function received(id) { if (!on() || !Number.isInteger(Number(id))) return; id = Number(id);
    if (opts().autoPlan === false || opts().mode === 'tags') return;
    // 等回复渲染稳一点再发二次请求
    setTimer(() => { if (on() && opts().mode !== 'tags') planLlm(id).catch(() => {}); }, 1200);
  }
  function rendered(id) { if (!on() || !Number.isInteger(Number(id))) return; id = Number(id);
    if (opts().mode === 'tags') { planTags(id); return; }
    // llm 模式由 received 起调度; 兜底: 还没排上就补一次
    if (opts().autoPlan !== false && !plans.has(id)) setTimer(() => { if (on() && opts().mode !== 'tags' && !plans.has(id)) planLlm(id).catch(() => {}); }, 2000);
  }
  function messageChanged(id) { if (id === undefined) cancelAll(); else cancel(Number(id)); }
  function chatChanged() { cancelAll(); }
  function refresh() { volume(); if (!on()) cancelAll(); }
  function close() {
    closed = true; cancelAll(); unsubscribe?.();
    const c = ctx; ctx = null;
    setTimer(() => { try { c?.close(); } catch {} }, 200);
  }
  return {unlock, received, rendered, messageChanged, chatChanged, refresh, close, planLlm, planTags, state: () => ({loops: [...loopers.keys()], running: running()})};
}
