// 漫画: one story message drawn as comic pages. The text model writes the storyboard (pages; a page is either several
// panels drawn as one picture, or a 高潮 page with one big panel); each page is drawn by the 绘图 App (its 画风, the looks
// of the people named); the words are put on afterwards by the plugin (core/comic-canvas.js), never drawn by the model.

/** What a page must not hold: the words and balloons are laid on by the plugin. */
import {comicRules, comicTags, fixedPanels, normalizeComic, storyEntries} from './comic-settings.js';

/** Words that must not be in the negative of a comic page: they take the panels, the margins and the screentone away. (Words about text and bubbles are not here: the words are put on by this plugin, so those stay out of the picture.) */
const NEG_FORBIDDEN = ['comic', 'comic panel', 'panels', 'multiple views', 'multiple scenes', '4koma', '2koma', 'sequence', 'full page comic', 'cut-in', 'border', 'white border', 'black border', 'ornate border', 'lace border', 'outside border', 'frame', 'outline', 'margins', 'negative space'];
const NEG_MONO = ['screentone', 'halftone', 'monochrome', 'greyscale', 'grayscale'];
const bareTag = t => String(t || '').trim().replace(/^-?\d+(?:\.\d+)?::/, '').replace(/::$/, '').replace(/[{}\[\]]/g, '').replace(/_/g, ' ').trim().toLowerCase();
/** The negative without the words that would undo the comic's own layout (and, for 黑白, the screentone words). */
export function stripComicNegative(negative, {mono = false} = {}) {
  const bad = new Set([...NEG_FORBIDDEN, ...(mono ? NEG_MONO : [])]);
  return String(negative || '').split(/[,\n]/).map(t => t.trim()).filter(t => t && !bad.has(bareTag(t))).join(', ');
}
export const COMIC_NEGATIVE = 'text, speech bubble, english text, chinese text, watermark';
export const COMIC_PAGES = {min: 1, max: 12, usual: 4};
export const clampPages = n => Math.max(COMIC_PAGES.min, Math.min(COMIC_PAGES.max, Math.round(Number(n)) || COMIC_PAGES.usual));

/** The text model's request: the story → a storyboard as JSON. names: the people the 绘图 App knows. */
export function comicRequest({story, names = [], pages = 0, comic = null}) {
  const set = normalizeComic(comic), extra = comicRules(set);
  // pages 0 / empty: the model decides how many, by how much story there is.
  const count = Number(pages) > 0 ? clampPages(pages) : 0, big = count ? Math.max(1, Math.floor(count / 3)) : 0;
  const fixed = fixedPanels(set), fill = t => t.replace('{splash}', count ? `整本最多 ${big} 页 splash` : 'splash 不超过总页数的三分之一').replace('{lang}', set.lang === 'ja' ? '日语' : '中文');
  const entries = storyEntries(set).filter(e => !(fixed && e.skipFixed)).map(e => fill(e.title.trim() ? '【' + e.title.trim() + '】\n' + e.text.trim() : e.text.trim()));
  const system = [
    '你是漫画分镜师。把用户给的一段故事改成漫画分镜，只输出一个 JSON，不要任何别的文字，不要代码块。',
    count ? `共 ${count} 页。` : `页数由你按故事的长短定：故事短就少画，长就多画，最少 ${COMIC_PAGES.min} 页，最多 ${COMIC_PAGES.max} 页。`,
    ...extra,
    ...entries,
    '每格有 scene、who、lines；who 是这一格出现的人物名字数组，名字必须从下面「可用人物」里选；没有人就写空数组。',
    '输出格式：{"title":"漫画标题","pages":[{"kind":"page","panels":[{"scene":"...","who":["名字"],"lines":[{"who":"名字","text":"...","kind":"say"}]}]}]}'
  ].join('\n');
  const user = `可用人物：${names.length ? names.join('、') : '（没有登记，who 写空数组）'}\n\n故事：\n${String(story || '').trim().slice(0, 12000)}`;
  return [{role: 'system', content: system}, {role: 'user', content: user}];
}

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const LINE_KINDS = ['say', 'think', 'narr'];
/** The JSON object in a model's answer (it may come in a code block, or with a sentence before it). */
function jsonIn(reply) {
  const raw = String(reply ?? '').replace(/```(?:json)?/gi, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw Error('模型没有给出分镜（找不到 JSON），可以再试一次');
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { throw Error('模型给的分镜格式不对（JSON 读不出来），可以再试一次'); }
}
/** The storyboard as the app uses it: {title, pages: [{kind, panels: [{scene, who, lines}]}]}; what is not usable is left out. */
export function parseComic(reply, {maxPages = COMIC_PAGES.max, comic = null} = {}) {
  const fixed = fixedPanels(comic);
  const data = jsonIn(reply), pages = [];
  for (const page of Array.isArray(data.pages) ? data.pages : []) {
    const splash = String(page?.kind).toLowerCase() === 'splash', panels = [];
    for (const panel of Array.isArray(page?.panels) ? page.panels : []) {
      const scene = text(panel?.scene, 700), lines = [];
      for (const line of Array.isArray(panel?.lines) ? panel.lines : []) {
        const words = text(line?.text, 60);
        if (words && lines.length < 3) lines.push({who: text(line?.who, 30), text: words, kind: LINE_KINDS.includes(line?.kind) ? line.kind : 'say'});
      }
      if (!scene && !lines.length) continue;
      panels.push({scene, who: [...new Set((Array.isArray(panel?.who) ? panel.who : []).map(n => text(n, 40)).filter(Boolean))], lines});
    }
    if (!panels.length) continue;
    const one = fixed === 1 || (fixed !== 2 && splash);
    pages.push({kind: one ? 'splash' : 'page', panels: panels.slice(0, fixed || (splash ? 1 : 6))});
    if (pages.length >= maxPages) break;
  }
  if (!pages.length) throw Error('分镜里没有可画的页，可以再试一次');
  return {title: text(data.title, 40), pages};
}

const ROWS = {1: [1], 2: [1, 1], 3: [1, 2], 4: [2, 2], 5: [2, 2, 1], 6: [2, 2, 2]};
const LAYOUT_WORDS = {1: 'single panel', 2: '2 panels, stacked vertically', 3: '3 panels, one wide panel on top, two panels below',
  4: '4 panels, 2x2 grid', 5: '5 panels, three rows', 6: '6 panels, 3 rows of 2'};
/** The panels of a page as rectangles in a w×h picture (rows of cells; a gap between them): where each panel's words go. */
export function panelRects(count, w, h, gap = 0.02, rtl = false) {
  const rows = ROWS[Math.max(1, Math.min(6, count))], rects = [], rowH = (h - gap * h * (rows.length + 1)) / rows.length;
  rows.forEach((cells, r) => {
    const cellW = (w - gap * w * (cells + 1)) / cells;
    for (let c = 0; c < cells; c++) { const x = gap * w + c * (cellW + gap * w); rects.push({x: rtl ? w - x - cellW : x, y: gap * h + r * (rowH + gap * h), w: cellW, h: rowH}); }
  });
  return rects;
}
/** The picture's tags: a big panel is its scene; a page of panels says how it is divided, then each panel. */
export function pageTags(page, comic = null) {
  const panels = page.panels || [], extra = comicTags(comic).tags;
  if (page.kind === 'splash' || panels.length === 1) return [extra, panels[0]?.scene || ''].filter(Boolean).join(', ');
  const rtl = normalizeComic(comic).direction === 'rtl';
  return [extra, 'comic page', LAYOUT_WORDS[Math.min(6, panels.length)], ...(rtl ? ['manga, panels read from right to left, first panel at the top right'] : []), ...panels.map((p, i) => `panel ${i + 1}: ${p.scene}`)].filter(Boolean).join(', ');
}
/** Everyone named on a page, once. */
export const pageCharacters = page => [...new Set((page.panels || []).flatMap(p => p.who || []))];
