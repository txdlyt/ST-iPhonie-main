import {createSelectionDraw} from './host-selection.js';
// Compact menus on the tavern page; colors inherit the active tavern theme.
// entry: whether the 楼层工具 button is shown on each reply (hidden() takes it away too, with the voice menu).
export function createStoryTools({doc = document, hidden, selectionEnabled = () => true, entry = () => true, message, valid, wave, actions, notice, narration = () => ({})}) {
 let menu = null, anchor = null, hold = null, suppress = null;
 const win = doc.defaultView;
 const selection=createSelectionDraw({doc,hidden:()=>hidden() || !selectionEnabled(),message,valid,scope:narration,draw:actions.drawSelection,notice});
 function close() { menu?.remove(); menu = null; anchor = null; }
 function cancel() { if (hold) win.clearTimeout(hold.timer); hold = null; }
 function show(button, rows) {
  close(); anchor = button;
  menu = doc.createElement('div'); menu.className = 'sttts-context-menu'; menu.setAttribute('role', 'menu');
  for (const [label, action] of rows) {
   const item = doc.createElement('button'); item.type = 'button'; item.textContent = label; item.setAttribute('role', 'menuitem');
   item.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); close(); Promise.resolve().then(action).catch(error => notice(error.message)); });
   menu.append(item);
  }
  doc.body.append(menu);
  const rect = button.getBoundingClientRect(), box = menu.getBoundingClientRect();
  const width = win.innerWidth, height = win.innerHeight;
  menu.style.left = Math.max(8, Math.min(rect.left, width - box.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 6, height - box.height - 8)) + 'px';
 }
 /** 画成漫画: how many pages (1–12); nothing typed = the model decides by the story. */
 function comicAsk(button, snap) {
  close(); anchor = button;
  menu = doc.createElement('div'); menu.className = 'sttts-context-menu sttts-comic-ask'; menu.setAttribute('role', 'dialog');
  menu.innerHTML = '<label>页数（1–12，不填 = 按故事长短自动）<input type="number" inputmode="numeric" min="1" max="12" step="1" placeholder="自动"></label><div><button type="button" data-go>开始画</button><button type="button" data-cancel>取消</button></div>';
  doc.body.append(menu);
  const rect = button.getBoundingClientRect(), box = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, win.innerWidth - box.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 6, win.innerHeight - box.height - 8)) + 'px';
  const input = menu.querySelector('input'), go = () => {
   const value = input.value.trim(), pages = value ? Math.max(1, Math.min(12, Math.round(Number(value)) || 0)) : 0;
   close(); Promise.resolve().then(checked(snap, () => actions.comic(snap.id, pages))).catch(error => notice(error.message));
  };
  menu.querySelector('[data-go]').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); go(); });
  menu.querySelector('[data-cancel]').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); close(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); go(); } });
  input.focus();
 }
 function scope(button) {
  const mes = button.closest('#chat .mes[mesid]');
  const snap = mes && message(Number(mes.getAttribute('mesid')));
  return snap || null;
 }
 function checked(snap, action) { return () => { if (hidden() || !valid(snap)) throw Error('楼层内容已变化，请重新打开菜单'); return action(); }; }
 function voiceMenu(button) {
  const snap = scope(button), line = snap && wave(button, snap);
  if (!line || hidden()) return false;
  show(button, [['下载', checked(snap, () => actions.download(line))], ['收藏', checked(snap, () => actions.favorite(line))], ['重新配音', checked(snap, () => actions.retake(line, snap, button))]]);
  return true;
 }
 function click(event) {
  if (suppress && Date.now() < suppress.until && suppress.button.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); suppress = null; return; }
  const button = event.target.closest?.('[data-sttts-tools]');
  if (!button) { if (menu && !menu.contains(event.target)) close(); return; }
  event.preventDefault(); event.stopImmediatePropagation();
  if (anchor === button) return close();
  const snap = scope(button); if (!snap || hidden()) return;
  // 给这层楼配音 (while 正文语音 is on): any reply's lines voiced again, not only the newest one's.
  const selected = selectionEnabled() && selection.forMessage(snap.id);
  show(button, [...(selected ? [['给选中文字生图', () => selection.activate(selected)]] : []), ['给这层楼生图', checked(snap, () => actions.draw(snap.id))], ...(actions.comic ? [['画成漫画…', () => comicAsk(button, snap)]] : []), ['重新配图', checked(snap, () => actions.redraw(snap.id))], ['重新生成提示词', checked(snap, () => actions.replan(snap.id))], ...(actions.canVoice?.() ? [['给这层楼配音', checked(snap, () => actions.voice(snap.id))]] : []), ['从这层看视觉小说', checked(snap, () => actions.vn(snap.id))], ['台词小窗', checked(snap, () => actions.dialogue(snap.id))], actions.playing?.(snap.id) ? ['停止播放', () => actions.stop()] : ['整条播放', checked(snap, () => actions.play(snap.id))]]);
 }
 function down(event) {
  cancel(); suppress = null; if (event.button !== 0 || hidden()) return;
  const button = event.target.closest?.('#chat [data-sttts-action="line"]'); if (!button) return;
  const x = event.clientX, y = event.clientY;
  hold = {x, y, id: event.pointerId, timer: win.setTimeout(() => { hold = null; if (button.isConnected && voiceMenu(button)) suppress = {button, until: Date.now() + 1500}; }, 500)};
 }
 function move(event) { if (hold && (event.pointerId !== hold.id || Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10)) cancel(); }
 function context(event) { const button = event.target.closest?.('#chat [data-sttts-action="line"]'); if (button && voiceMenu(button)) { cancel(); suppress = {button, until: Date.now() + 1500}; event.preventDefault(); } }
 function key(event) {
  if (!menu) return;
  if (event.key === 'Escape') { const previous = anchor; close(); previous?.focus(); event.preventDefault(); }
  else if (['ArrowDown', 'ArrowUp'].includes(event.key)) { const items = [...menu.querySelectorAll('button')], i = items.indexOf(doc.activeElement); items[i < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); event.preventDefault(); }
 }
 const listeners = [['click', click], ['pointerdown', down], ['pointermove', move], ['pointerup', cancel], ['pointercancel', cancel], ['contextmenu', context], ['keydown', key]];
 for (const [type, fn] of listeners) doc.addEventListener(type, fn, true);
 function buttons() {
  selection.refresh();
  if (hidden() || !entry()) close();
  for (const mes of doc.querySelectorAll('#chat .mes[mesid]')) {
   const old = mes.querySelector('[data-sttts-tools]');
   if (hidden() || !entry() || !message(Number(mes.getAttribute('mesid')))) { old?.remove(); continue; }
   if (old) continue;
   const bar = mes.querySelector('.mes_buttons'); if (!bar) continue;
   const button = doc.createElement('button'); button.type = 'button'; button.className = 'mes_button sttts-tools-entry'; button.dataset.stttsTools = ''; button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="var(--SmartThemeBlurTintColor,#242424)"/><circle cx="15" cy="12" r="2" fill="var(--SmartThemeBlurTintColor,#242424)"/><circle cx="9" cy="18" r="2" fill="var(--SmartThemeBlurTintColor,#242424)"/></svg>';
   button.title = '小手机工具'; button.setAttribute('aria-label', '小手机工具'); button.setAttribute('aria-haspopup', 'menu'); bar.prepend(button);
  }
 }
 return {buttons, close, dispose() { selection.dispose(); cancel(); close(); for (const [type, fn] of listeners) doc.removeEventListener(type, fn, true); doc.querySelectorAll('[data-sttts-tools]').forEach(el => el.remove()); }};
}
