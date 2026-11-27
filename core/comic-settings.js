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

export const defaultComic = () => ({color: 'full', style: 'general', lang: 'zh', textSize: 'auto', textHide: false, bubble: 'round', gutter: 'none'});
const pick = (list, value, fallback) => list.some(([k]) => k === value) ? value : fallback;
export function normalizeComic(value) {
  const base = defaultComic(), v = value && typeof value === 'object' ? value : {};
  return {
    color: pick(COMIC_COLORS, v.color, base.color), style: pick(COMIC_STYLES, v.style, base.style), lang: pick(COMIC_LANGS, v.lang, base.lang),
    textSize: pick(COMIC_TEXT_SIZES, v.textSize, base.textSize), textHide: v.textHide === true, bubble: pick(COMIC_BUBBLES, v.bubble, base.bubble), gutter: pick(COMIC_GUTTERS, v.gutter, base.gutter)
  };
}

/** Panels per page when the style fixes it (单图单格 → 1, 上下两格 → 2), else 0. */
export const fixedPanels = comic => ({single: 1, two: 2}[normalizeComic(comic).style] || 0);
/** The extra lines the storyboard request gets for these settings. */
export function comicRules(comic) {
  const c = normalizeComic(comic), rules = [];
  const style = COMIC_STYLES.find(([k]) => k === c.style)?.[2];
  if (style) rules.push(style);
  if (c.color === 'mono') rules.push('黑白漫画：scene 里只用灰阶明暗，不写任何颜色词（blue、red、brown 等一律不写）；写光源方向、明暗对比和网点（screentone）。');
  if (c.gutter !== 'none') rules.push('页面留白：' + GUTTER_WORDS[c.gutter]);
  return rules;
}
/** What the 绘图 App is told on top of a page's tags: [before, negative]. */
export function comicTags(comic) {
  const c = normalizeComic(comic), tags = [];
  if (c.color === 'mono') tags.push('monochrome', 'greyscale', 'screentone');
  if (c.gutter !== 'none') tags.push(GUTTER_TAGS[c.gutter]);
  return {tags: tags.join(', '), negative: c.color === 'mono' ? 'color, colorful' : ''};
}
/** What the words laid on a page look like: the font is the page's width divided by this. */
export const TEXT_DIVISOR = {small: 38, auto: 30, large: 24};
export const canvasOptions = comic => { const c = normalizeComic(comic); return {textSize: c.textSize, hide: c.textHide, bubble: c.bubble}; };
