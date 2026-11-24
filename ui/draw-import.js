// 读图: a picture brought into the drawing app. With what NovelAI drew it with inside, choose what to take from it
// (as its own app lets you); whatever the picture, it can also go on as a base, a vibe or a reference.
import {esc, btn, help} from './common.js';
import {icon} from './icons.js';

/** 去掉权重括号, as NovelAI's app does it. */
export const cleanBrackets = text => String(text).replace(/[[\]{}]/g, '').replace(/,(?=[^ ])/g, ', ').replace(/ ,/g, ',');

// A tag that is no longer part of an artist string: the year, the quality words, who is in the picture.
const NOT_ARTIST = /^(year[ _]\d+|masterpiece|best quality|amazing quality|good quality|high quality|very aesthetic|aesthetic|absurdres|highres|incredibly absurdres|newest|recent|no text|\d+\+?(girl|boy|other)s?|solo|multiple (girls|boys))$/i;

/**
 * 读图 → 画风: a read prompt cut in two. The artist string is what comes before the first year / quality / people tag; the
 * rest goes to 固定正面. Cut at top-level commas only, so a weight group like 1.2::a, b:: is not torn apart. Nothing is
 * lost: artist + positive is the whole prompt. A guess, the editor opens right after for the person to move the line.
 */
export function splitStyleWords(prompt) {
  const tags = []; let depth = 0, start = 0;
  const text = String(prompt || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ',' && !depth) { tags.push(text.slice(start, i)); start = i + 1; }
  }
  tags.push(text.slice(start));
  const bare = tag => tag.trim().replace(/^[\d.]*::/, '').replace(/::[\d.]*$/, '').replace(/^[[{(]+|[\]})]+$/g, '').replace(/_/g, ' ').trim();
  let cut = tags.findIndex(tag => NOT_ARTIST.test(bare(tag)));
  if (cut < 0) cut = tags.length;
  const join = list => list.map(t => t.trim()).filter(Boolean).join(', ');
  return {artist: join(tags.slice(0, cut)), positive: join(tags.slice(cut))};
}
/** A name for a 画风 made from words: the first artist in them, or a plain one. */
export function styleNameOf(artist) {
  const first = /artist:\s*([^,:]+)/i.exec(artist)?.[1] || /(?:^|,)\s*(?:[\d.]*::)?\s*([^,:]+)/.exec(artist)?.[1] || '';
  return first.trim().replace(/[_ ]?\(.*$/, '').replace(/_/g, ' ').trim().slice(0, 30) || '读入的画风';
}

const row = (key, label, on, locked, note = '') => `<label class="setting-row import-row${locked ? ' locked' : ''}"><span>${esc(label)}${locked ? `<small>${icon('lock')}已锁定</small>` : note ? `<small>${esc(note)}</small>` : ''}</span><input class="switch" type="checkbox" data-import="${key}" aria-label="${esc(label)}"${on && !locked ? ' checked' : ''}${locked ? ' disabled' : ''}></label>`;
const how = (key, value, words) => `<div class="segmented import-how" role="group" aria-label="读进来的放哪">${words.map(([k, l]) => `<button type="button" data-how="${key}" data-value="${k}" aria-pressed="${value === k}">${l}</button>`).join('')}</div>`;

/**
 * file: the picture. found: readNovelAI's answer or null. carried: it has vibes inside as a file (naidata). locks: what
 * is locked. take(choice): the settings to read; use(kind): 'base' | 'vibe' | 'ref'; either may fail with a message.
 */
export function pictureSheet({ctx, file, found, carried = false, locks = [], take, use, saveStyle}) {
  const url = ctx.win.URL.createObjectURL(file), locked = key => locks.includes(key);
  const vibeCount = found?.vibes?.length || 0, people = found?.characters?.length || 0;
  const choice = {prompt: !!found, negative: !!found, characters: people > 0, addCharacters: false, vibes: vibeCount > 0, addVibes: false, settings: !!found, seed: Number.isInteger(found?.params?.seed), actual: false, clean: false};
  const d = ctx.dialog('读图', '');
  d.onClose(() => ctx.win.URL.revokeObjectURL(url));
  function draw() {
    const read = found ? `<div class="group">
        ${row('prompt', '提示词', choice.prompt, locked('prompt'))}${row('negative', '负面', choice.negative, locked('negative'))}
        ${people ? row('characters', `角色 · ${people} 个`, choice.characters, locked('characters')) + (choice.characters && !locked('characters') ? how('addCharacters', String(choice.addCharacters), [['false', '替换现在的'], ['true', '加在后面']]) : '') : ''}
        ${vibeCount ? row('vibes', `Vibe · ${vibeCount} 个`, choice.vibes, locked('vibes')) + (choice.vibes && !locked('vibes') ? how('addVibes', String(choice.addVibes), [['false', '用这些'], ['true', '加进在用的组']]) : '') : ''}
        ${row('settings', '参数', choice.settings, false, '模型、尺寸、步数、Scale、采样器…')}
        ${Number.isInteger(found.params?.seed) ? row('seed', `种子 · ${found.params.seed}`, choice.seed, locked('seed')) : ''}
      </div>
      <div class="group">
        ${found.actual ? row('actual', '用实际抽中的词', choice.actual, false, '提示词里的 ||a|b|| 换成这张图抽到的') : ''}
        ${row('clean', '去掉权重括号', choice.clean, false)}
      </div>
      <div class="actions">${btn('import-read', icon('import') + '读进来', 'primary')}${saveStyle ? btn('import-style', icon('paint') + '存为画风', 'secondary') : ''}</div>
      ${saveStyle ? '<p class="hint" data-keep-hint>「存为画风」不用一条条复制：整段提示词（放进画师串）、负面、模型/步数/CFG/采样器都存成一个新画风，这张图当它的效果图。</p>' : ''}` : `<p class="hint" data-keep-hint>这张图里没有 NovelAI 的参数${help('被压缩或转存过的图会丢掉它们。')}</p>`;
    const carriedRow = carried ? `<p class="hint" data-keep-hint>${icon('layers')}这张图里嵌着 Vibe，点「当 Vibe」就能读出来。</p>` : '';
    d.body.innerHTML = `<div class="import-picture"><img src="${esc(url)}" alt=""></div>${read}${carriedRow}
      <div class="actions import-uses">${btn('import-base', icon('image') + '当底图', 'secondary')}${btn('import-vibe', icon('layers') + '当 Vibe', 'secondary')}${btn('import-ref', icon('person') + '当参考', 'secondary')}</div>`;
  }
  draw();
  d.body.addEventListener('change', e => {
    const key = e.target.dataset?.import;
    if (key) { choice[key] = e.target.checked; draw(); }
  });
  d.body.addEventListener('click', async e => {
    const pick = e.target.closest('[data-how]');
    if (pick) { choice[pick.dataset.how] = pick.dataset.value === 'true'; draw(); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    try {
      if (action === 'import-read') { d.close(); await take(choice); }
      else if (action === 'import-style') { d.close(); await saveStyle(choice); }
      else if (action === 'import-base' || action === 'import-vibe' || action === 'import-ref') { d.close(); await use(action.slice(7)); }
    } catch (error) { ctx.notify(error.message, {error: true}); }
  });
  return d;
}
