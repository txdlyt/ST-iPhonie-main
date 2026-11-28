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
export const COMIC_TEXT_SIZES = [['xsmall', '特小'], ['small', '小'], ['auto', '中'], ['large', '大']];
export const COMIC_SIZES = [['portrait', '竖'], ['landscape', '横'], ['square', '方'], ['follow', '跟绘图设置']];
export const COMIC_PAGES_EACH = ['', '1', '2', '3', '4', '6', '8', '12'];
export const COMIC_PER_PAGE = ['', '1', '2', '3', '4', '5', '6'];
export const COMIC_VARIETY = [['normal', '不指定', ''],
  ['varied', '有变化', '分镜变化：各页的格数和格的大小要有变化，不要每页都排成同一个样子；特写、中景、全景交替。'],
  ['bold', '大胆', '分镜变化：大胆的分镜，景别反差大，该用大画面的地方就用大画面（高潮用 splash 整页），小格用来加快节奏。'],
  ['art', '艺术感', '分镜变化：有艺术感的分镜，重视构图与留白，镜头角度与取景不落俗套（仰视、俯视、框中框、局部特写），画面之间用意象衔接。'],
  ['tidy', '规整', '分镜变化：规整的分镜，每页格数相近，格的大小接近，节奏平稳，镜头变化克制。']];
export const COMIC_DIRECTIONS = [['ltr', '从左往右'], ['rtl', '从右往左（日漫）']];
export const COMIC_READING = [['page', '翻页（书架）'], ['book', '翻书'], ['flow', '卡片堆'], ['scroll', '上下滑']];
// NovelAI parameters a comic may keep of its own ('' = what the 绘图 App has); read from core/novelai.js when used.
export const COMIC_NAI_KEYS = ['model', 'steps', 'scale', 'cfgRescale', 'sampler', 'schedule'];
export const COMIC_BUBBLES = [['round', '圆角框'], ['oval', '椭圆'], ['box', '方框']];
export const COMIC_GUTTERS = [['none', '不指定'], ['white', '白边'], ['black', '黑线无白边'], ['bleed', '无边全出血']];

const GUTTER_TAGS = {white: 'white border', black: 'black border, thick black panel borders, no white margin', bleed: 'full bleed, no border'};
const GUTTER_WORDS = {white: 'Every panel sits inside an even white margin.', black: 'The panels touch each other and are separated only by thick black lines.', bleed: 'Every panel extends to the edges of the page with no margin.'};

export const defaultComic = () => ({color: 'full', style: 'general', lang: 'zh', textSize: 'auto', textHide: false, bubble: 'round', gutter: 'none', size: 'portrait', artist: '', nai: {}, pagesEach: '', perPage: '', variety: 'normal', direction: 'ltr', reading: 'page', defaultOn: {}, note: '', preset: '', presets: []});
const pick = (list, value, fallback) => list.some(([k]) => k === value) ? value : fallback;
export const COMIC_NOTE_MAX = 2000;
// 漫画预设: like the 绘图预设, a named list of entries, each one switched on or off and edited as text. Where an entry goes:
// to the text model that writes the storyboard, or to the 绘图 App with every page (before the page's tags / in its negative).
export const COMIC_ENTRY_TO = [['story', '告诉写分镜的 AI'], ['tags', '加到每页画图提示词前'], ['negative', '加到每页的负面词']];
/** The groups entries sit in. one: only one entry of the group is on at a time (turning one on turns the rest off). */
export const COMIC_GROUPS = [['base', '分镜基础', false], ['pacing', '分镜风格（选一个）', true], ['story', '承接剧情', false], ['look', '画面与人物', false], ['other', '我加的', false]];
export const COMIC_PRESET_MAX = 30, COMIC_ENTRY_MAX = 60, COMIC_ENTRY_TEXT = 8000;
const newId = () => 'cp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function normalizeEntries(list) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).filter(e => e && typeof e === 'object').slice(0, COMIC_ENTRY_MAX).map(e => {
    let id = typeof e.id === 'string' && /^[\w-]{1,64}$/.test(e.id) && !ids.has(e.id) ? e.id : newId() + ids.size;
    ids.add(id);
    return {id, title: String(e.title ?? '').slice(0, 80), enabled: e.enabled !== false, to: pick(COMIC_ENTRY_TO, e.to, 'story'), text: typeof e.text === 'string' ? e.text.slice(0, COMIC_ENTRY_TEXT) : '', group: COMIC_GROUPS.some(g => g[0] === e.group) ? e.group : 'other', desc: String(e.desc ?? '').slice(0, 120), ...(e.skipFixed === true ? {skipFixed: true} : {})};
  });
}
/** Only the numbers and words that are given; '' / missing means the 绘图 App's own. */
function naiOf(value) {
  const v = value && typeof value === 'object' ? value : {}, out = {};
  for (const k of COMIC_NAI_KEYS) {
    const x = v[k];
    if (x === undefined || x === null || x === '') continue;
    if (['steps', 'scale', 'cfgRescale'].includes(k)) { const n = Number(x); if (Number.isFinite(n)) out[k] = n; } else if (typeof x === 'string') out[k] = x.slice(0, 60);
  }
  return out;
}
export function normalizeComic(value) {
  const v = value && typeof value === 'object' ? value : {}, base = defaultComic(), seen = new Set();
  const presets = (Array.isArray(v.presets) ? v.presets : []).filter(p => p && typeof p === 'object' && typeof p.id === 'string' && p.id && !seen.has(p.id) && seen.add(p.id))
    .slice(0, COMIC_PRESET_MAX).map(p => ({id: p.id, name: String(p.name ?? '').trim().slice(0, 60) || '未命名', entries: normalizeEntries(p.entries), ...(p.replace === true ? {replace: true} : {})}));
  return {
    color: pick(COMIC_COLORS, v.color, base.color), style: pick(COMIC_STYLES, v.style, base.style), lang: pick(COMIC_LANGS, v.lang, base.lang),
    textSize: pick(COMIC_TEXT_SIZES, v.textSize, base.textSize), textHide: v.textHide === true, bubble: pick(COMIC_BUBBLES, v.bubble, base.bubble), gutter: pick(COMIC_GUTTERS, v.gutter, base.gutter),
    size: pick(COMIC_SIZES, v.size, base.size), artist: typeof v.artist === 'string' ? v.artist.slice(0, 500) : '', nai: naiOf(v.nai),
    pagesEach: COMIC_PAGES_EACH.includes(String(v.pagesEach ?? '')) ? String(v.pagesEach ?? '') : '', perPage: COMIC_PER_PAGE.includes(String(v.perPage ?? '')) ? String(v.perPage ?? '') : '',
    variety: pick(COMIC_VARIETY, v.variety, base.variety), direction: pick(COMIC_DIRECTIONS, v.direction, base.direction), reading: pick(COMIC_READING, v.reading, base.reading),
    defaultOn: Object.fromEntries(Object.entries(v.defaultOn && typeof v.defaultOn === 'object' ? v.defaultOn : {}).filter(([k, x]) => DEFAULT_COMIC_ENTRIES.some(e => e.id === k) && typeof x === 'boolean')),
    note: typeof v.note === 'string' ? v.note.slice(0, COMIC_NOTE_MAX) : '', preset: presets.some(p => p.id === v.preset) ? v.preset : '', presets
  };
}
/** The preset in use, or null. */
export const activePreset = comic => { const c = normalizeComic(comic); return c.presets.find(p => p.id === c.preset) || null; };
// 默认分镜预设: what the storyboard request says besides its fixed frame (the JSON shape, the people, the page count).
// {splash} and {lang} are filled in when the request is made. skipFixed: left out when the 分镜风格 fixes the panels per page.
export const DEFAULT_COMIC_ENTRIES = Object.freeze([
  {id: 'layout', group: 'base', title: '页面版式', desc: '一页分几格，什么时候用整页大图', to: 'story', enabled: true, skipFixed: true, text: '每页有 kind：「page」= 一页里有 2 到 6 格（panels 里写几格）；「splash」= 高潮页，整页只有一格大图（panels 里只写 1 格）。\n像真的漫画那样：平常的内容用 page，最有冲击或最动情的地方才用 splash，{splash}。'},
  {id: 'grammar', group: 'base', title: '通用分镜文法', desc: '主格、景别、一格一个瞬间', to: 'story', enabled: true, text: '每页先定一个主格（面积最大、戏剧重心所在），其余格按信息量分大小，同一页的格不要一样大。\n景别按目的选：远景交代空间，中景写人物互动，近景和特写突出细节；连续的反应镜头可以用同一景别。\n俯视、仰视、透视变形用来表现尺度和压迫感，但人物比例要看得出来。\n换地点或隔了一段时间，要有一格交代环境。\n每格只选一个明确的瞬间，围绕一个主要的视觉事件构图；先后发生的动作分到不同的格。'},
  {id: 'variety', group: 'base', title: '镜头变化', desc: '远近交替，不要一个镜头到底', to: 'story', enabled: true, text: '格子要有变化：远景、近景、特写交替，不要每格都是同一个镜头。'},
  {id: 'state', group: 'base', title: '状态接得上', desc: '手里拿的、穿的、站的位置跨格不变', to: 'story', enabled: true, text: '人物手里拿的东西、衣着、站位，从一格到下一格、一页到下一页要接得上。镜头切到局部时只写看得见的，画面外的部分仍然成立。剧情里真的发生了变化，才改。'},
  {id: 'p-suspense', group: 'pacing', title: '悬疑推理', desc: '凝重克制，眼神和物证的特写', to: 'story', enabled: false, text: '分镜风格是悬疑推理：节奏凝重克制。多用宽幅的横长格，眼神和微表情的特写，关键物证的细节格；用格子的大小和数量把紧张的停顿拉长；视线和物件的位置要交代清楚。'},
  {id: 'p-daily', group: 'pacing', title: '轻松日常', desc: '规整横格，铺垫—铺垫—反差', to: 'story', enabled: false, text: '分镜风格是轻松日常：以规整的横读格为主，间距均匀宽松；节奏是「铺垫、铺垫、反应落差」三拍；人物的表情是视觉重点；不用斜格和重叠格，格的边界清楚稳定。'},
  {id: 'p-shoujo', group: 'pacing', title: '恋爱少女（装饰）', desc: '花与蕾丝的画框，人物溢出格外', to: 'story', enabled: false, text: '分镜风格是装饰系少女漫画：画格的边框用花、藤蔓、羽毛、星屑、蕾丝之类的纹样代替直线；格与格之间散落花瓣和光点；人物可以溢出画格；多用竖向的全身构图，突出衣饰和发丝；情绪最高处用没有边框的满版格。scene 里可以用 ornate border、lace border、falling petals 这类标签。'},
  {id: 'p-action', group: 'pacing', title: '少年热血', desc: '大动势格，斜切对撞', to: 'story', enabled: false, text: '分镜风格是少年热血：核心的动势格要明显放大，占半页以上；相邻的格强烈对撞，至少两格用大角度的斜切边框；动作和冲击力优先于背景；scene 里可以用 motion lines、speed lines、emphasis lines。'},
  {id: 'p-comedy', group: 'pacing', title: '喜剧日常', desc: '方正的格，笑点落在表情反差', to: 'story', enabled: false, text: '分镜风格是喜剧日常：画格方正规整，排布服务于笑点，不靠格形抢戏；每页有起承转结，笑点落点明确；格数适中偏多，对话密集，吐槽一环扣一环；表情反差要大，正常脸和崩坏脸快速切换；背景简化甚至省略；花、闪光这类少女漫装饰只用来反讽。'},
  {id: 'p-koma', group: 'pacing', title: '经典四格', desc: '每页竖排四个等宽格，起承转结', to: 'story', enabled: false, text: '分镜风格是经典四格：每页就是竖排的四个等宽矩形格，严格按起、承、转、结的节奏。'},
  {id: 's-follow', group: 'story', title: '只画故事里有的', desc: '按原顺序，不加戏不跳过', to: 'story', enabled: true, text: '只画故事里写了的事，从第一个画面画到最后一个画面，按原来的顺序分到各页；不要自己加情节，不要跳过，也不要提前。每页最后一格的动作和物品要能接到下一页的第一格。'},
  {id: 's-words', group: 'story', title: '台词用原话', desc: '不改写，长句拆成短句', to: 'story', enabled: true, text: '台词用故事里的原话，保留语气和标点，不要改写。一句话里含好几段、不是一口气说完的，拆成几句短的，各写成 lines 里的一条。'},
  {id: 's-show', group: 'story', title: '能画的不要写成旁白', desc: '动作表情优先画出来', to: 'story', enabled: true, text: '动作、姿态、表情、距离、物品的位置、环境的变化，优先画成画面，不要写成旁白。故事里的比喻和夸张只取看得见的本体（身体、器物、空间），不要把喻体画进去。旁白只留理解事件必需、画面和对白又表达不了的完整短句。'},
  {id: 'scene', group: 'look', title: '画面（scene）怎么写', desc: '给画图模型的英文标签', to: 'story', enabled: true, text: 'scene 是给画图模型的英文标签，逗号分隔，写构图、动作、表情、场景、光线；不要写人物外貌，不要写台词，不要写文字。'},
  {id: 'lines', group: 'look', title: '台词（lines）怎么写', desc: '每格最多 3 句，分说话/心里话/旁白', to: 'story', enabled: true, text: 'lines 是这一格的台词数组，最多 3 句；每句 {who, text, kind}，kind 是 say（说话）、think（心里话）、narr（旁白）之一；text 用{lang}，短，不超过 24 个字；旁白的 who 写「旁白」。'},
  {id: 'cast', group: 'look', title: '人物出场', desc: '只写这一格里看得见的人', to: 'story', enabled: true, text: 'who 只写这一格里看得见的人。人物的外貌和衣着由绘图 App 按名字补上，scene 里不要写。人物的表情、姿态、视线，对应故事里已经写明的情绪和态度，不要自己加戏。'}
]);
/** The default entries as they are now: the person's on/off choices (comic.defaultOn) over the built-in ones. */
export const defaultEntries = comic => { const on = normalizeComic(comic).defaultOn; return DEFAULT_COMIC_ENTRIES.map(e => ({...e, enabled: e.id in on ? on[e.id] : e.enabled})); };
/** Turn entry `id` of `list` on or off; turning one on in a one-at-a-time group turns the others of it off. Returns the new list. */
export function setEntryOn(list, id, on) {
  const hit = list.find(e => e.id === id), one = COMIC_GROUPS.find(g => g[0] === hit?.group)?.[2];
  return list.map(e => e.id === id ? {...e, enabled: on} : on && one && e.group === hit.group ? {...e, enabled: false} : e);
}
/** A new preset: a copy of the 默认分镜预设 to change. It stands in for the default entries (replace), as a 绘图预设 does. */
export const newPreset = (name = '我的分镜预设', comic = null) => ({id: newId(), name, replace: true, entries: defaultEntries(comic).map((e, i) => ({...e, id: newId() + i}))});
/** The entries that tell the text model how to write the storyboard: the preset's when it stands in for the default, else the default. */
export function storyEntries(comic) {
  const p = activePreset(comic);
  return (p?.replace ? p.entries : defaultEntries(comic)).filter(e => e.enabled && e.to === 'story' && e.text.trim());
}
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
  const variety = COMIC_VARIETY.find(([k]) => k === c.variety)?.[2];
  if (variety && !fixedPanels(c)) rules.push(variety);
  if (c.perPage && !fixedPanels(c)) rules.push('每页 ' + c.perPage + ' 格（高潮的 splash 整页除外）。');
  if (c.color === 'mono') rules.push('黑白漫画：scene 里只用灰阶明暗，不写任何颜色词（blue、red、brown 等一律不写）；写光源方向、明暗对比和网点（screentone）。');
  if (c.gutter !== 'none') rules.push('页面留白：' + GUTTER_WORDS[c.gutter]);
  if (c.note.trim()) rules.push('额外要求（来自用户，照着做）：' + c.note.trim());
  if (c.direction === 'rtl') rules.push('日漫（从右往左读）：每页格子的先后顺序是从右上到左下，同一行里右边的格在前；scene 里人物的视线、动作和镜头的方向也按从右往左的阅读顺序安排。');
  if (!activePreset(c)?.replace) for (const e of entryTexts(c, 'story')) rules.push(e.title.trim() ? '【' + e.title.trim() + '】\n' + e.text.trim() : e.text.trim());
  return rules;
}
/** What the 绘图 App is told on top of a page's tags: [before, negative]. */
export function comicTags(comic) {
  const c = normalizeComic(comic), tags = [];
  if (c.artist.trim()) tags.push(c.artist.trim().replace(/[\s,，]+$/, ''));
  if (c.color === 'mono') tags.push('monochrome', 'greyscale', 'screentone');
  if (c.gutter !== 'none') tags.push(GUTTER_TAGS[c.gutter]);
  const before = entryTexts(c, 'tags').map(e => e.text.trim().replace(/[\s,，]+$/, ''));
  const negative = [c.color === 'mono' ? 'color, colorful' : '', ...entryTexts(c, 'negative').map(e => e.text.trim().replace(/[\s,，]+$/, ''))].filter(Boolean);
  return {tags: [...before, ...tags].join(', '), negative: negative.join(', ')};
}
/** What the words laid on a page look like: the font is the page's width divided by this. */
export const TEXT_DIVISOR = {xsmall: 46, small: 38, auto: 30, large: 24};
export const canvasOptions = comic => { const c = normalizeComic(comic); return {textSize: c.textSize, hide: c.textHide, bubble: c.bubble, rtl: c.direction === 'rtl'}; };
/** The drawing parameters this comic sets itself, over the 绘图 App's: only for NovelAI (the other engines are left as they are). */
export const comicDrawParams = (comic, engine) => engine === 'nai' ? normalizeComic(comic).nai : {};
/** 竖 / 横 / 方 for sizeFor; '' = the 绘图 App's own size. */
export const comicSizeWord = comic => ({portrait: '竖', landscape: '横', square: '方', follow: ''}[normalizeComic(comic).size]);
