// 漫画设置: how a comic is made. One small object kept in the phone's settings (state.comic), read by the 漫画 App
// and by the 画成漫画 button in the chat. The defaults are exactly how the comic was made before there were settings.
// The options and their wording come from the 漫画台 preset and the 智库 extension, rewritten for this plugin's way of
// working (the text model writes a JSON storyboard, the 绘图 App draws, the plugin lays on the words).

export const COMIC_COLORS = [['full', '全彩'], ['mono', '黑白']];
export const COMIC_STYLES = [
  ['general', '通用', ''],
  ['koma', '经典四格', '分镜节奏：经典四格漫画的起承转结。每页尽量 4 格，大小接近，格与格的节奏是起、承、转、结。'],
  ['shonen', '少年热血', '分镜节奏：少年热血动作漫画。动作最强的一格给最大的画面（可用 splash 页）；多用特写、低角度、冲击构图；scene 里可用 motion lines, speed lines, emphasis lines 这类标签；动作与冲击力优先于背景。'],
  ['suspense', '悬疑推理', '分镜节奏：青年悬疑漫画。节奏凝重克制；多用眼神与微表情的特写（close-up, shaded face），穿插物证与细节的特写；制造屏息、压迫、时间被拉长的感觉。'],
  ['shoujo', '少女装饰', '分镜节奏：装饰系少女漫画。重情绪与服饰、发丝的细节，多用竖向的全身构图；scene 里可加 falling petals, sparkles, flowers 这类装饰标签；情绪最高的地方用整页大图。'],
  ['daily', '轻松日常', '分镜节奏：轻松日常漫画。规整、无压力的节奏，「铺垫、铺垫、反应落差」的松弛三拍；以角色的表情（facial acting）为视觉重心；背景简单。'],
  ['comedy', '喜剧日常', '分镜节奏：喜剧日常漫画。每页 4 到 6 格，对话密集，吐槽紧凑；每页有起承转结和明确的笑点；表情反差要大（正常脸与崩坏脸快速切换）；背景简洁或省略，视觉重心在人物表情与互动。'],
  ['single', '单图单格', '页面形式：每页只有 1 格，全部页都用 splash，每页只画一个最有表现力的瞬间；先后发生的几个瞬间要拆成不同的页，不要压进同一页。'],
  ['two', '上下两格', '页面形式：每页恰好 2 格，上下各一格、大小相同；每页都用 page，不用 splash。']
];
export const COMIC_LANGS = [['zh', '简体中文'], ['ja', '日文']];
export const COMIC_TEXT_SIZES = [['small', '小'], ['auto', '自动'], ['large', '大']];
export const COMIC_BUBBLES = [['round', '圆角框'], ['oval', '椭圆'], ['box', '方框']];
export const COMIC_GUTTERS = [['none', '不指定'], ['white', '白边'], ['black', '黑线无白边'], ['bleed', '无边全出血']];

const GUTTER_TAGS = {white: 'white border', black: 'black border, thick black panel borders, no white margin', bleed: 'full bleed, no border'};
const GUTTER_WORDS = {white: 'Every panel sits inside an even white margin.', black: 'The panels touch each other and are separated only by thick black lines.', bleed: 'Every panel extends to the edges of the page with no margin.'};

export const defaultComic = () => ({color: 'full', style: 'general', lang: 'zh', textSize: 'auto', textHide: false, bubble: 'round', gutter: 'none', note: '', preset: '', presets: []});
const pick = (list, value, fallback) => list.some(([k]) => k === value) ? value : fallback;
export const COMIC_NOTE_MAX = 2000;
// 漫画预设: like the 绘图预设, a named list of entries, each one switched on or off and edited as text. Where an entry goes:
// to the text model that writes the storyboard, or to the 绘图 App with every page (before the page's tags / in its negative).
export const COMIC_ENTRY_TO = [['story', '给分镜的要求'], ['tags', '画面前缀'], ['negative', '负面词']];
export const COMIC_PRESET_MAX = 30, COMIC_ENTRY_MAX = 60, COMIC_ENTRY_TEXT = 8000;
const newId = () => 'cp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function normalizeEntries(list) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).filter(e => e && typeof e === 'object').slice(0, COMIC_ENTRY_MAX).map(e => {
    let id = typeof e.id === 'string' && /^[\w-]{1,64}$/.test(e.id) && !ids.has(e.id) ? e.id : newId() + ids.size;
    ids.add(id);
    return {id, title: String(e.title ?? '').slice(0, 80), enabled: e.enabled !== false, to: pick(COMIC_ENTRY_TO, e.to, 'story'), text: typeof e.text === 'string' ? e.text.slice(0, COMIC_ENTRY_TEXT) : ''};
  });
}
export function normalizeComic(value) {
  const v = value && typeof value === 'object' ? value : {}, base = defaultComic(), seen = new Set();
  const presets = (Array.isArray(v.presets) ? v.presets : []).filter(p => p && typeof p === 'object' && typeof p.id === 'string' && p.id && !seen.has(p.id) && seen.add(p.id))
    .slice(0, COMIC_PRESET_MAX).map(p => ({id: p.id, name: String(p.name ?? '').trim().slice(0, 60) || '未命名', entries: normalizeEntries(p.entries)}));
  return {
    color: pick(COMIC_COLORS, v.color, base.color), style: pick(COMIC_STYLES, v.style, base.style), lang: pick(COMIC_LANGS, v.lang, base.lang),
    textSize: pick(COMIC_TEXT_SIZES, v.textSize, base.textSize), textHide: v.textHide === true, bubble: pick(COMIC_BUBBLES, v.bubble, base.bubble), gutter: pick(COMIC_GUTTERS, v.gutter, base.gutter),
    note: typeof v.note === 'string' ? v.note.slice(0, COMIC_NOTE_MAX) : '', preset: presets.some(p => p.id === v.preset) ? v.preset : '', presets
  };
}
/** The preset in use, or null. */
export const activePreset = comic => { const c = normalizeComic(comic); return c.presets.find(p => p.id === c.preset) || null; };
/** A new preset with one empty entry. */
export const newPreset = (name = '新漫画预设') => ({id: newId(), name, entries: [{id: newId() + '0', title: '分镜要求', enabled: true, to: 'story', text: ''}]});
/** The preset saved (a new one is added, one with the same id is replaced) and made the one in use. Throws when there is no room. */
export function savePreset(comic, preset) {
  const c = normalizeComic(comic), p = normalizeComic({presets: [preset]}).presets[0];
  if (!p) throw Error('这个预设存不了');
  const at = c.presets.findIndex(x => x.id === p.id);
  if (at < 0 && c.presets.length >= COMIC_PRESET_MAX) throw Error('最多存 ' + COMIC_PRESET_MAX + ' 个预设');
  return normalizeComic({...c, preset: p.id, presets: at < 0 ? [...c.presets, p] : c.presets.map((x, i) => i === at ? p : x)});
}
export const removePreset = (comic, id) => { const c = normalizeComic(comic); return normalizeComic({...c, preset: c.preset === id ? '' : c.preset, presets: c.presets.filter(p => p.id !== id)}); };
/** One preset as a file (the same file shape as the other presets: format st-iphonie-preset, kind comic). */
export const presetFile = preset => JSON.stringify({format: 'st-iphonie-preset', version: 1, kind: 'comic', preset: (({id, ...rest}) => rest)(normalizeComic({presets: [preset]}).presets[0])}, null, 2);
/** A preset file read back (a bare preset counts too); it has no id, so saving makes it a new one. */
export function readPresetFile(text) {
  let data; try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { throw Error('这个文件不是预设（不是有效的 JSON）'); }
  const wrapped = data?.format === 'st-iphonie-preset', preset = wrapped ? data.preset : data;
  if (wrapped && data.kind !== 'comic') throw Error('这是「' + (data.kind || '别的') + '」预设，不是漫画预设');
  if (!preset || typeof preset !== 'object' || !Array.isArray(preset.entries)) throw Error('文件里没有预设的条目');
  const entries = normalizeEntries(preset.entries.filter(e => e && typeof e.text === 'string'));
  if (!entries.length) throw Error('文件里没有预设的条目');
  return {id: newId(), name: String(preset.name || '').trim().slice(0, 60) || '导入的预设', entries};
}
const entryTexts = (comic, to) => (activePreset(comic)?.entries || []).filter(e => e.enabled && e.to === to && e.text.trim());

/** Panels per page when the style fixes it (单图单格 → 1, 上下两格 → 2), else 0. */
export const fixedPanels = comic => ({single: 1, two: 2}[normalizeComic(comic).style] || 0);
/** The extra lines the storyboard request gets for these settings. */
export function comicRules(comic) {
  const c = normalizeComic(comic), rules = [];
  const style = COMIC_STYLES.find(([k]) => k === c.style)?.[2];
  if (style) rules.push(style);
  if (c.color === 'mono') rules.push('黑白漫画：scene 里只用灰阶明暗，不写任何颜色词（blue、red、brown 等一律不写）；写光源方向、明暗对比和网点（screentone）。');
  if (c.gutter !== 'none') rules.push('页面留白：' + GUTTER_WORDS[c.gutter]);
  if (c.note.trim()) rules.push('额外要求（来自用户，照着做）：' + c.note.trim());
  for (const e of entryTexts(c, 'story')) rules.push(e.title.trim() ? '【' + e.title.trim() + '】\n' + e.text.trim() : e.text.trim());
  return rules;
}
/** What the 绘图 App is told on top of a page's tags: [before, negative]. */
export function comicTags(comic) {
  const c = normalizeComic(comic), tags = [];
  if (c.color === 'mono') tags.push('monochrome', 'greyscale', 'screentone');
  if (c.gutter !== 'none') tags.push(GUTTER_TAGS[c.gutter]);
  const before = entryTexts(c, 'tags').map(e => e.text.trim().replace(/[\s,，]+$/, ''));
  const negative = [c.color === 'mono' ? 'color, colorful' : '', ...entryTexts(c, 'negative').map(e => e.text.trim().replace(/[\s,，]+$/, ''))].filter(Boolean);
  return {tags: [...before, ...tags].join(', '), negative: negative.join(', ')};
}
/** What the words laid on a page look like: the font is the page's width divided by this. */
export const TEXT_DIVISOR = {small: 38, auto: 30, large: 24};
export const canvasOptions = comic => { const c = normalizeComic(comic); return {textSize: c.textSize, hide: c.textHide, bubble: c.bubble}; };
