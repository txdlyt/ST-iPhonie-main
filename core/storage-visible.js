// iPhone Safari: an IndexedDB request made while the page is in the background (or just as it goes there) can hang for good, and
// everything asked after it waits behind it. So a request waits until the page is shown again, and what was left over from the
// background (an idle connection, an open() that never answered) is dropped when it comes back.

/** Resolves when the page is shown (at once if it already is), or after `ms` at the latest. */
export function whenVisible(ms = 30000) {
  const doc = globalThis.document;
  if (!doc?.addEventListener || doc.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    const done = () => { if (doc.visibilityState === 'hidden') return; doc.removeEventListener('visibilitychange', done); clearTimeout(timer); resolve(); };
    timer = setTimeout(() => { doc.removeEventListener('visibilitychange', done); resolve(); }, ms);
    doc.addEventListener('visibilitychange', done);
  });
}

/** Calls `fn` each time the page is shown again; returns what stops it. */
export function onShown(fn) {
  const doc = globalThis.document;
  if (!doc?.addEventListener) return () => {};
  const shown = () => { if (doc.visibilityState === 'visible') fn(); };
  doc.addEventListener('visibilitychange', shown);
  globalThis.addEventListener?.('pageshow', shown);
  return () => { doc.removeEventListener('visibilitychange', shown); globalThis.removeEventListener?.('pageshow', shown); };
}
