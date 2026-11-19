// Documents of the smaller phone apps (论坛 posts and its 热搜, 查手机 snapshots; in a database of their own, 记忆), kept in
// this browser (IndexedDB) and scoped to the tavern account like the other local data. Each document is {id, kind, at, ...}; the apps check their own
// fields (core/forum.js, core/peek.js) before anything is written.
import {connectionLost, lostError, breath} from './idb.js';
import {whenVisible, onShown} from './storage-visible.js';
const fail = (message, code = 'INVALID') => Object.assign(new Error(message), {code});

export class AppStore {
  #scope; #factory; #name; #db = null; #opening = null; #closed = false; #busy = 0; #unshown = null; #openAt = 0;
  constructor(scope, {indexedDB = globalThis.indexedDB, database = 'st-iphonie-apps-v1'} = {}) {
    this.#scope = String(scope); this.#factory = indexedDB; this.#name = database;
    // Back from the background: nothing is using the connection, so it is dropped (it may be dead), and an open() still unanswered is let go.
    this.#unshown = onShown(() => { if (this.#closed) return; if (!this.#busy && this.#db) { try { this.#db.close(); } catch {} this.#db = null; } if (this.#opening && !this.#db && Date.now() - this.#openAt > 40000) this.#opening = null; });
  }
  async #open() {
    if (this.#closed) throw fail('已关闭', 'CLOSED');
    if (this.#db) return this.#db;
    if (!this.#factory?.open) throw fail('浏览器不支持本地保存，请检查存储权限', 'STORAGE_UNAVAILABLE');
    this.#opening ||= new Promise((resolve, reject) => {
      let abandoned = false;
      const req = this.#factory.open(this.#name, 2);
      req.onupgradeneeded = () => {
        const store = req.result.objectStoreNames.contains('docs') ? req.transaction.objectStore('docs') : req.result.createObjectStore('docs', {keyPath: ['scope', 'id']});
        if (!store.indexNames.contains('scope')) store.createIndex('scope', 'scope');
        if (!store.indexNames.contains('scope-kind')) store.createIndex('scope-kind', ['scope', 'kind']);
      };
      req.onerror = () => reject(fail('无法打开本地数据，请检查浏览器的存储权限', 'STORAGE_UNAVAILABLE'));
      req.onblocked = () => { abandoned = true; reject(fail('另一个页面占用了本地数据，请关闭旧页面后重试', 'STORAGE_BLOCKED')); };
      req.onsuccess = () => {
        if (abandoned || this.#closed) { req.result.close(); reject(fail('已关闭', 'CLOSED')); return; }
        this.#db = req.result;
        const db = this.#db;
        db.onversionchange = () => { db.close(); if (this.#db === db) this.#db = null; };
        db.onclose = () => { if (this.#db === db) this.#db = null; };
        resolve(db);
      };
    }).finally(() => { this.#opening = null; });
    return this.#opening;
  }
  // A dropped connection (iPhone Safari after the page sat in the background) is reopened once; nothing was written.
  /** The promise, or an error when it has not settled in `ms`: a hung request must not hold a page (or every later request) for good. */
  #guard(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('本地数据没有回应（浏览器的存储卡住了），请刷新页面后再试', 'STORAGE_TIMEOUT')), ms); })]).finally(() => clearTimeout(timer));
  }
  // A read that gets no answer in 8 s is asked again on a fresh connection; a write (60 s) is not: it may still go through.
  async #tx(mode, work, again = 2) {
    await whenVisible();
    this.#busy++;
    try { return await this.#txAttempt(mode, work, again); } finally { this.#busy--; }
  }
  async #txAttempt(mode, work, again) {
    const write = mode !== 'readonly', ms = write ? 60000 : 5000;
    // An open() that never answers would stay as the shared #opening for every later call: it is dropped, and asked once more.
    // A slow open() (an upgrade) is waited for, up to 40 s, not started again every few seconds.
    let db;
    if (!this.#opening) this.#openAt = Date.now();
    try { db = await this.#guard(this.#open(), 40000); }
    catch (error) {
      if (error?.code !== 'STORAGE_TIMEOUT' || this.#closed) throw error;
      this.#opening = null; this.#openAt = Date.now();
      db = await this.#guard(this.#open(), ms).catch(e => { if (e?.code === 'STORAGE_TIMEOUT') this.#opening = null; throw e; });
    }
    // The transaction is kept: one that got no answer is aborted, so it stops holding up the requests queued behind it.
    let live = null;
    try {
      return await this.#guard(new Promise((resolve, reject) => {
        let result, own, tx;
        try { tx = live = db.transaction('docs', mode); } catch (error) { reject(this.#closed ? fail('已关闭', 'CLOSED') : lostError(error)); return; }
        const store = tx.objectStore('docs');
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(own || (connectionLost(tx.error) ? lostError(tx.error) : fail(tx.error?.name === 'QuotaExceededError' ? '设备存储空间不足，没有保存' : '没有保存，请重试', 'STORAGE')));
        work(store, value => { result = value; }, error => { own = error; tx.abort(); });
      }), ms);
    } catch (error) {
      const timeout = error?.code === 'STORAGE_TIMEOUT';
      if (timeout) { try { live?.abort(); } catch {} }
      if ((error?.code !== 'STORAGE_LOST' && !(timeout && !write)) || this.#closed) throw error;
      if (this.#db === db) { try { db.close(); } catch {} this.#db = null; }
      if (timeout) this.#opening = null;
      if (again > 0) { await breath(); await whenVisible(); return this.#txAttempt(mode, work, again - 1); }
      throw error;
    }
  }
  #all(store, then) { const req = store.index('scope').getAll(this.#scope); req.onsuccess = () => then(req.result); }
  #public(row) { if (!row) return null; const {scope, ...rest} = row; return structuredClone(rest); }

  /** Documents of one kind, newest first. */
  async list(kind) {
    const rows = await this.#tx('readonly', (store, done) => {
      if (!kind) { this.#all(store, done); return; }
      const req = store.index('scope-kind').getAll([this.#scope, kind]); req.onsuccess = () => done(req.result);
    });
    return rows.sort((a, b) => b.at - a.at).map(r => this.#public(r));
  }
  /** Documents whose ids begin with this, the newest first, without reading the others (助手's memory can be big). */
  async listFrom(prefix) {
    const Range = globalThis.IDBKeyRange, begins = String(prefix);
    const rows = await this.#tx('readonly', (store, done) => {
      if (!Range) { this.#all(store, done); return; }
      const req = store.getAll(Range.bound([this.#scope, begins], [this.#scope, begins + '￿']));
      req.onsuccess = () => done(req.result);
    });
    return rows.filter(r => r.id.startsWith(begins)).sort((a, b) => b.at - a.at).map(r => this.#public(r));
  }
  async get(id) { return this.#tx('readonly', (store, done) => { const req = store.get([this.#scope, String(id)]); req.onsuccess = () => done(this.#public(req.result)); }); }
  async getMany(ids) {
    const keys = [...new Set(ids.map(String))];
    return this.#tx('readonly', (store, done) => {
      const rows = new Map(); let remaining = keys.length;
      if (!remaining) { done(rows); return; }
      for (const id of keys) {
        const req = store.get([this.#scope, id]);
        req.onsuccess = () => { rows.set(id, this.#public(req.result)); if (!--remaining) done(rows); };
      }
    });
  }
  /** Writes documents; keep: at most this many of their kind stay (the oldest go). */
  async put(docs, {keep = 0} = {}) {
    const rows = docs.map(d => ({...structuredClone(d), scope: this.#scope, id: String(d.id)}));
    return this.#tx('readwrite', (store, done) => {
      for (const row of rows) store.put(row);
      if (!keep) { done(rows.map(r => this.#public(r))); return; }
      this.#all(store, existing => {
        const kinds = new Set(rows.map(r => r.kind));
        for (const kind of kinds) {
          const all = [...existing.filter(r => r.kind === kind && !rows.some(x => x.id === r.id)), ...rows.filter(r => r.kind === kind)].sort((a, b) => b.at - a.at);
          for (const old of all.slice(keep)) store.delete([this.#scope, old.id]);
        }
        done(rows.map(r => this.#public(r)));
      });
    });
  }
  /** Changes one document in a transaction; change(doc) edits it in place. */
  async change(id, change) {
    return this.#tx('readwrite', (store, done, abort) => {
      const req = store.get([this.#scope, String(id)]);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) { abort(fail('这条内容已经不在了', 'MISSING')); return; }
        try { change(row); } catch (error) { abort(error); return; }
        store.put(row);
        done(this.#public(row));
      };
    });
  }
  /** Changes an owner and its related documents in one transaction, including across tabs.
   * Related values are mutable documents or null (delete); change returns the public result. */
  async changeRelated(id, relatedIds, change) {
    const ownerId = String(id), keys = [...new Set(relatedIds.map(String))];
    if (keys.includes(ownerId)) throw fail('关联记录不能包含自身');
    return this.#tx('readwrite', (store, done, abort) => {
      const found = new Map(); let remaining = keys.length + 1;
      for (const key of [ownerId, ...keys]) {
        const req = store.get([this.#scope, key]);
        req.onsuccess = () => {
          found.set(key, this.#public(req.result));
          if (--remaining) return;
          const owner = found.get(ownerId);
          if (!owner) { abort(fail('这条内容已经不在了', 'MISSING')); return; }
          found.delete(ownerId);
          try {
            const result = change(owner, found);
            store.put({...owner, id: ownerId, scope: this.#scope});
            for (const key of keys) {
              const row = found.get(key);
              if (row) store.put({...row, id: key, scope: this.#scope});
              else store.delete([this.#scope, key]);
            }
            done(structuredClone(result));
          } catch (error) { abort(error); }
        };
      }
    });
  }
  /** Replaces selected document kinds atomically within this account. change receives public rows and must
   * synchronously return their complete replacements; unrelated kinds and other accounts stay untouched. */
  async transformKinds(kinds, change) {
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => typeof kind !== 'string' || !kind.trim()) || typeof change !== 'function') throw fail('请选择有效的数据类型');
    const selected = new Set(kinds);
    return this.#tx('readwrite', (store, done, abort) => this.#all(store, existing => {
      try {
        const old = existing.filter(row => selected.has(row.kind));
        const result = change(old.map(row => this.#public(row)));
        if (!Array.isArray(result)) {
          if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
          throw fail('数据替换必须同步返回完整记录列表');
        }
        const existingKinds = new Map(existing.map(row => [row.id, row.kind])), ids = new Set();
        const rows = Array.from(result, value => {
          if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id.trim() || !selected.has(value.kind)) throw fail('数据替换包含无效记录');
          if (ids.has(value.id) || (existingKinds.has(value.id) && existingKinds.get(value.id) !== value.kind)) throw fail('数据 ID 重复或与其他应用记录冲突');
          ids.add(value.id);
          return {...this.#public(value), scope: this.#scope};
        });
        // Validate and clone the whole replacement before scheduling any deletes or writes.
        for (const row of old) store.delete([this.#scope, row.id]);
        for (const row of rows) store.put(row);
        done(rows.map(row => this.#public(row)));
      } catch (error) { abort(error); }
    }));
  }
  async remove(id) { return this.#tx('readwrite', (store, done) => { store.delete([this.#scope, String(id)]); done(true); }); }
  async removeMany(ids) { return this.#tx('readwrite', (store, done) => { for (const id of ids) store.delete([this.#scope, String(id)]); done(true); }); }
  async clear(kind) { return this.#tx('readwrite', (store, done) => this.#all(store, rows => { const gone = rows.filter(r => !kind || r.kind === kind); for (const r of gone) store.delete([this.#scope, r.id]); done(gone.length); })); }
  close() { this.#closed = true; this.#unshown?.(); this.#db?.close(); this.#db = null; }
}
