// 漫画阅读: the pages of a comic in 翻书 / 卡片堆 / 上下滑, shown inside the 书架's album viewer (ui/album-viewer.js), so the
// top bar (back, n / N, name), the progress slider and the bottom bar (目录 / 书签 / 设置) are the album's own. This only
// takes the place of the album's one-page-at-a-time stage. The way the pages look and turn is made after the 智库
// extension's 漫画书, written again for this plugin.
import {esc} from './common.js';

/**
 * root: the album viewer's element. urls: the pages' picture addresses in order. mode: 'book' | 'flow' | 'scroll'.
 * rtl: read from the right (the first page on the right). onAt(n): the page shown changed.
 * Returns {go(step), setAt(n), get at(), destroy()}.
 */
export function mountReader(root, {mode = 'book', urls = [], at = 0, rtl = false, onAt = () => {}}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  let turned = 0, leaves = [], cards = [], sx = null, moved = false, drag = null, dead = false;
  const old = root.querySelector('.album-stage');
  old.hidden = true;
  const stage = doc.createElement('div');
  stage.className = 'cm-rd-stage'; if (mode !== 'book') stage.dataset.fill = '1';
  root.prepend(stage);
  const count = root.querySelector('[data-av-count]');
  const art = i => `<div class="cm-rd-art"><img src="${esc(urls[i])}" alt="第 ${i + 1} 页" draggable="false"></div>`;
  const leafCount = () => Math.ceil(urls.length / 2);
  const say = () => {
    const spread = mode === 'book' && turned > 0 && turned * 2 < urls.length ? `${turned * 2}–${turned * 2 + 1}` : String(at + 1);
    if (count && count.textContent !== `${spread} / ${urls.length}`) count.textContent = `${spread} / ${urls.length}`;
  };
  // The album writes its own n / N when a picture loads; this keeps ours.
  const watch = new win.MutationObserver(say);
  if (count) watch.observe(count, {childList: true, characterData: true, subtree: true});
  const changed = () => { say(); onAt(at, mode === 'book' ? turned : at); };
  const chrome = () => { root.dataset.chrome = root.dataset.chrome === 'off' ? 'on' : 'off'; };

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
    changed();
  }
  function buildFlow() {
    stage.innerHTML = '<div class="cm-rd-flow"></div>';
    cards = urls.map((_, k) => { const c = doc.createElement('div'); c.className = 'cm-rd-card'; c.dataset.k = k; c.innerHTML = art(k); stage.firstChild.appendChild(c); return c; });
    layoutFlow();
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
    changed();
  }
  function buildScroll() {
    stage.innerHTML = '<div class="cm-rd-scroll">' + urls.map((_, k) => `<div class="cm-rd-vpage" data-k="${k}"><div class="holder">${art(k)}</div></div>`).join('') + '</div>';
    const scroller = stage.firstChild;
    scroller.querySelector(`[data-k="${at}"]`)?.scrollIntoView({block: 'center'});
    scroller.addEventListener('scroll', () => {
      const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
      let best = at, bd = 1e9;
      scroller.querySelectorAll('.cm-rd-vpage').forEach(el => { const r = el.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid); if (d < bd) { bd = d; best = Number(el.dataset.k); } });
      if (best !== at) { at = best; changed(); }
    }, {passive: true});
    changed();
  }
  /** One page on (+1) or back (-1): in the book, a leaf is two pages. */
  function go(step) {
    if (mode === 'book') { turned = Math.max(0, Math.min(leafCount(), turned + step)); layoutBook(); return; }
    at = Math.max(0, Math.min(urls.length - 1, at + step));
    if (mode === 'flow') layoutFlow(); else { stage.querySelector(`[data-k="${at}"]`)?.scrollIntoView({block: 'center', behavior: 'smooth'}); changed(); }
  }
  function setAt(n) {
    n = Math.max(0, Math.min(urls.length - 1, n));
    if (mode === 'book') { turned = Math.ceil(n / 2); layoutBook(); return; }
    at = n;
    if (mode === 'flow') layoutFlow(); else { stage.querySelector(`[data-k="${at}"]`)?.scrollIntoView({block: 'center'}); changed(); }
  }

  // The album's own arrows and arrow keys turn this stage instead.
  const arrows = ev => { const b = ev.target.closest?.('[data-av=prev],[data-av=next]'); if (!b) return; ev.stopPropagation(); ev.preventDefault(); go(b.dataset.av === 'next' ? 1 : -1); };
  root.addEventListener('click', arrows, true);
  const key = ev => { if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { ev.stopPropagation(); ev.preventDefault(); go(ev.key === 'ArrowRight' ? 1 : -1); } };
  doc.addEventListener('keydown', key, true);

  stage.addEventListener('pointerdown', ev => { if (mode === 'scroll') return; sx = ev.clientX; moved = false; drag = null; });
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
    if (mode === 'scroll') { chrome(); return; }
    if (sx == null) return;
    const dx = ev.clientX - sx; sx = null;
    leaves.forEach(l => l.classList.remove('drag')); cards.forEach(c => c.classList.remove('drag'));
    if (mode === 'book') {
      if (!moved) { const r = stage.getBoundingClientRect(), t = (ev.clientX - r.left) / r.width; if (t > .33 && t < .67) chrome(); else go(t < .5 ? -1 : 1); return; }
      if (drag && drag.k === turned && drag.a < -60) turned++;
      else if (drag && drag.k === turned - 1 && drag.a > -120) turned--;
      layoutBook();
    } else if (moved) {
      go(Math.round(-dx / (win.innerWidth * 0.3)) || (dx < -30 ? 1 : dx > 30 ? -1 : 0));
    } else {
      const c = ev.target.closest('.cm-rd-card');
      if (!c) { chrome(); return; }
      const k = Number(c.dataset.k);
      if (k === at) chrome(); else { at = k; layoutFlow(); }
    }
  });
  stage.addEventListener('pointercancel', () => { sx = null; if (mode === 'book') layoutBook(); else if (mode === 'flow') layoutFlow(); });

  at = Math.max(0, Math.min(urls.length - 1, at));
  mode === 'book' ? buildBook() : mode === 'scroll' ? buildScroll() : buildFlow();
  return {go, setAt, get at() { return at; }, destroy() { if (dead) return; dead = true; watch.disconnect(); root.removeEventListener('click', arrows, true); doc.removeEventListener('keydown', key, true); stage.remove(); old.hidden = false; }};
}
