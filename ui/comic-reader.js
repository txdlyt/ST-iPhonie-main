// 漫画阅读器: a comic's drawn pages read in the 漫画 App itself — 翻书 (two pages open, a leaf turns), 卡片堆 (a row of
// cards, the middle one facing you), 上下滑 (page after page, vertically) — with a page bar, a 目录 of thumbnails and a
// 设置 sheet (字幕 shown or hidden). The way it looks and turns follows the 智库 extension's 漫画书 (src/comic.js).
import {esc} from './common.js';

const MODES = [['book', '翻书'], ['flow', '卡片堆'], ['scroll', '上下滑']];
const KEY = 'stiphonie.comic.reader';

/**
 * ctx: the phone's context. comic: {title}. load(): the pages' picture addresses in order (the words laid on or not, as
 * the 字幕 setting now says). caption: {get(), set(on)}. start: the first page shown (from 0). onClose(): the reader is gone.
 * Returns {close, reload}.
 */
export function openComicReader(ctx, {title = '漫画', load, caption, start = 0, parent, onClose = () => {}}) {
  const {doc, win} = ctx;
  let urls = [], mode = 'book', at = start, turned = 0, leaves = [], cards = [], sx = null, moved = false, drag = null, closed = false;
  try { const saved = JSON.parse(win.localStorage.getItem(KEY) || 'null'); if (MODES.some(([m]) => m === saved?.mode)) mode = saved.mode; } catch { /* no saved way of reading */ }
  const root = doc.createElement('div');
  root.className = 'cm-rd'; root.setAttribute('role', 'dialog');
  root.innerHTML = `<header><b></b><small></small><button class="bb" data-b="set">设置</button><button class="bb" data-b="toc">目录</button><button class="bb" data-b="x" aria-label="关闭">✕</button>
    <div class="seg">${MODES.map(([m, t]) => `<button data-mode="${m}">${t}</button>`).join('')}</div></header>
    <div class="cm-rd-stage"></div><div class="tip"></div>
    <footer><button class="bb" data-b="-1" aria-label="上一页">‹</button><input type="range" min="1" value="1" aria-label="翻到"><button class="bb" data-b="1" aria-label="下一页">›</button></footer>`;
  const stage = root.querySelector('.cm-rd-stage'), bar = root.querySelector('footer input'), tip = root.querySelector('.tip');
  const art = i => `<div class="cm-rd-art"><img src="${esc(urls[i])}" alt="第 ${i + 1} 页" draggable="false"><span>${i + 1}/${urls.length}</span></div>`;
  const leafCount = () => Math.ceil(urls.length / 2);
  const save = () => { try { win.localStorage.setItem(KEY, JSON.stringify({mode})); } catch { /* it can still be read */ } };

  function info() {
    root.querySelector('header b').textContent = title;
    const spread = mode === 'book' && turned > 0 && turned * 2 < urls.length ? `${turned * 2}–${turned * 2 + 1}` : String(at + 1);
    root.querySelector('header small').textContent = urls.length ? `${spread}/${urls.length}` : '';
    bar.max = mode === 'book' ? leafCount() + 1 : Math.max(1, urls.length);
    bar.value = (mode === 'book' ? turned : at) + 1;
    save();
  }
  // 翻书: leaf j has page 2j on its front (on the right) and page 2j+1 on its back (on the left once turned).
  function buildBook() {
    stage.innerHTML = '<div class="cm-rd-spread"><div class="cm-rd-lbase"><div class="cm-rd-blank">扉 页</div></div><div class="cm-rd-rbase"></div><div class="cm-rd-gutter"></div></div>';
    const spread = stage.firstChild; leaves = [];
    for (let j = 0; j < leafCount(); j++) {
      const f = 2 * j, b = 2 * j + 1, leaf = doc.createElement('div');
      leaf.className = 'cm-rd-leaf';
      leaf.innerHTML = `<div class="f">${art(f)}<div class="shade"></div></div><div class="b">${b < urls.length ? art(b) : '<div class="cm-rd-blank">完</div>'}</div>`;
      spread.appendChild(leaf); leaves.push(leaf);
    }
    turned = Math.ceil(at / 2); layoutBook();
    tip.textContent = '往左拖翻下一页 · 往右拖翻回去 · 点左右两边也能翻';
  }
  function layoutBook(dragging) {
    const n = leaves.length;
    leaves.forEach((leaf, k) => {
      const done = k < turned; let a = done ? -180 : 0;
      if (dragging && k === dragging.k) a = dragging.a;
      leaf.style.transform = `rotateY(${a}deg)`;
      leaf.style.zIndex = dragging && k === dragging.k ? 500 : done ? k + 1 : n - k + 1;
      leaf.style.visibility = ((done && k < turned - 1) || (!done && k > turned + 1)) && !(dragging && k === dragging.k) ? 'hidden' : 'visible';
      leaf.querySelector('.shade').style.opacity = String(Math.min(1, Math.abs(a) / 90) * 0.8);
    });
    at = turned === 0 ? 0 : Math.min(urls.length - 1, turned * 2 - 1);
    info();
  }
  // 卡片堆
  function buildFlow() {
    stage.innerHTML = '<div class="cm-rd-flow"></div>';
    cards = urls.map((_, k) => { const c = doc.createElement('div'); c.className = 'cm-rd-card'; c.dataset.k = k; c.innerHTML = art(k); stage.firstChild.appendChild(c); return c; });
    layoutFlow();
    tip.textContent = '左右滑动挑一页 · 点中间那张打开看';
  }
  function layoutFlow(off = 0) {
    cards.forEach((c, k) => {
      const d = k - at + off, ad = Math.abs(d);
      const x = d === 0 ? 0 : Math.sign(d) * (30 + (ad - 1) * 9), ry = d === 0 ? 0 : -Math.sign(d) * Math.min(55, 30 + ad * 8);
      c.style.transform = `translate(-50%,-50%) translateX(${x}vw) translateZ(${-ad * 90}px) rotateY(${ry}deg) scale(${d === 0 ? 1 : 0.82})`;
      c.style.zIndex = String(100 - Math.round(ad * 10));
      c.style.filter = `brightness(${1 - Math.min(0.55, ad * 0.18)})`;
      c.style.visibility = ad > 6 ? 'hidden' : 'visible';
    });
    info();
  }
  // 上下滑
  function buildScroll() {
    stage.innerHTML = '<div class="cm-rd-scroll">' + urls.map((_, k) => `<div class="cm-rd-vpage" data-k="${k}"><div class="holder">${art(k)}</div></div>`).join('') + '</div>';
    const scroller = stage.firstChild;
    scroller.querySelector(`[data-k="${at}"]`)?.scrollIntoView({block: 'center'});
    scroller.addEventListener('scroll', () => {
      const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
      let best = at, bd = 1e9;
      scroller.querySelectorAll('.cm-rd-vpage').forEach(el => { const r = el.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid); if (d < bd) { bd = d; best = Number(el.dataset.k); } });
      if (best !== at) { at = best; info(); }
    }, {passive: true});
    info(); tip.textContent = '上下滑动一页一页往下看';
  }
  function build() {
    root.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    root.querySelector('footer').hidden = !urls.length;
    if (!urls.length) { stage.innerHTML = '<div class="empty">这本漫画还没有画好的页<br>回到漫画页面，点「画」或「自动画」。</div>'; tip.textContent = ''; info(); return; }
    at = Math.max(0, Math.min(urls.length - 1, at));
    mode === 'book' ? buildBook() : mode === 'scroll' ? buildScroll() : buildFlow();
  }
  function go(n) {
    if (!urls.length) return;
    if (mode === 'book') { turned = Math.max(0, Math.min(leafCount(), turned + n)); layoutBook(); return; }
    at = Math.max(0, Math.min(urls.length - 1, at + n));
    if (mode === 'flow') layoutFlow(); else { stage.querySelector(`[data-k="${at}"]`)?.scrollIntoView({block: 'center', behavior: 'smooth'}); info(); }
  }
  async function reload() { urls = (await load()).filter(Boolean); if (!closed) build(); }

  function sheet(html) {
    root.querySelector('.cm-rd-sheet')?.remove();
    const el = doc.createElement('div'); el.className = 'cm-rd-sheet'; el.innerHTML = html; root.appendChild(el); return el;
  }
  const toc = () => sheet(`<h4>目录</h4>${urls.map((u, k) => `<button data-goto="${k}" class="toc-row" style="display:flex;gap:10px;align-items:center;width:100%;margin:0 0 8px;padding:6px;border:1.5px solid #3a2a22;border-radius:14px;background:#f4efe4;color:#3a2a22;font:inherit;text-align:left;cursor:pointer"><img src="${esc(u)}" alt="" style="width:44px;height:60px;object-fit:cover;object-position:top;border-radius:8px"><span>第 ${k + 1} 页</span></button>`).join('') || '<p>还没有画好的页</p>'}`);
  function settingsSheet() {
    const on = caption.get();
    sheet(`<h4>设置</h4><div class="row"><span>对白字幕</span><button data-cap="1" aria-pressed="${on}">显示</button><button data-cap="0" aria-pressed="${!on}">隐藏</button></div><p style="font-size:12px;color:#6e5a4d;line-height:1.6;margin:0">字幕是叠在图上的对白；隐藏后只看画面。这和漫画设置里的「对白叠字」是同一个开关。</p>`);
  }

  root.addEventListener('click', async ev => {
    const cap = ev.target.closest('[data-cap]');
    if (cap) { caption.set(cap.dataset.cap === '1'); root.querySelector('.cm-rd-sheet')?.remove(); await reload(); return; }
    const goto = ev.target.closest('[data-goto]');
    if (goto) { at = Number(goto.dataset.goto); root.querySelector('.cm-rd-sheet')?.remove(); build(); return; }
    if (ev.target.closest('.cm-rd-sheet')) return;
    root.querySelector('.cm-rd-sheet')?.remove();
    const m = ev.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; build(); return; }
    const b = ev.target.closest('[data-b]')?.dataset.b;
    if (b === 'x') close(); else if (b === 'toc') toc(); else if (b === 'set') settingsSheet(); else if (b) go(Number(b));
  });
  bar.addEventListener('input', () => {
    const v = Number(bar.value) - 1;
    if (mode === 'book') { turned = v; layoutBook(); } else { at = v; if (mode === 'flow') layoutFlow(); else { stage.querySelector(`[data-k="${at}"]`)?.scrollIntoView({block: 'center'}); info(); } }
  });
  stage.addEventListener('pointerdown', ev => { if (mode === 'scroll' || !urls.length) return; sx = ev.clientX; moved = false; drag = null; });
  stage.addEventListener('pointermove', ev => {
    if (sx == null) return;
    const dx = ev.clientX - sx;
    if (Math.abs(dx) > 6) moved = true;
    if (!moved) return;
    if (mode === 'book') {
      const w = stage.querySelector('.cm-rd-spread').offsetWidth / 2;
      drag = dx < 0 && turned < leaves.length ? {k: turned, a: Math.max(-180, dx / w * 180)} : dx > 0 && turned > 0 ? {k: turned - 1, a: Math.min(0, -180 + dx / w * 180)} : null;
      leaves.forEach(l => l.classList.add('drag')); layoutBook(drag);
    } else { cards.forEach(c => c.classList.add('drag')); layoutFlow(-dx / (win.innerWidth * 0.3)); }
  });
  stage.addEventListener('pointerup', ev => {
    if (sx == null) return;
    const dx = ev.clientX - sx; sx = null;
    leaves.forEach(l => l.classList.remove('drag')); cards.forEach(c => c.classList.remove('drag'));
    if (mode === 'book') {
      if (!moved) { const r = stage.getBoundingClientRect(); go(ev.clientX < r.left + r.width / 2 ? -1 : 1); return; }
      if (drag && drag.k === turned && drag.a < -60) turned++;
      else if (drag && drag.k === turned - 1 && drag.a > -120) turned--;
      layoutBook();
    } else if (moved) {
      go(Math.round(-dx / (win.innerWidth * 0.3)) || (dx < -30 ? 1 : dx > 30 ? -1 : 0));
    } else {
      const c = ev.target.closest('.cm-rd-card');
      if (!c) return;
      const k = Number(c.dataset.k);
      if (k === at) { mode = 'book'; build(); } else { at = k; layoutFlow(); }
    }
  });
  stage.addEventListener('pointercancel', () => { sx = null; if (mode === 'book') layoutBook(); else if (mode === 'flow') layoutFlow(); });
  const key = ev => { if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') go(1); else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') go(-1); else if (ev.key === 'Escape') close(); };
  doc.addEventListener('keydown', key);
  function close() { if (closed) return; closed = true; doc.removeEventListener('keydown', key); root.remove(); onClose(); }
  (parent || doc.body).appendChild(root);
  reload();
  return {close, reload, get closed() { return closed; }};
}
