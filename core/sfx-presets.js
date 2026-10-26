// 音效设定（声临其境移植）: a second SFX system that migrates st-immersive-sound's "音效设定" model into ST-iPhonie.
//
// 声临其境 的音效设定由两部分组成:
//   · 音效设定预设: 一组条目 {name, loop, enabled, content}, content 是每行一个资源名（可在末尾用括号写备注）。
//     loop=true 的条目是 LOOP 循环类（场景氛围），loop=false 是 ONCE 单次类（动作音效）。
//   · 资源预设: 每行 `key=url=uploader=volume%=vibration`, key 是资源名, url 是音频链接。一个 key 可以在不同预设里。
//
// 触发链（完整移植）: 新回复到达后, 用一次额外的 LLM 请求把条目和资源列表交给模型, 让它输出 <sfx> 块
// {name, start_text, end_text, kind}; 再把 start_text/end_text 这两段原文定位回回复正文, 得到字符区间 [start,end)。
//   · ONCE: 读到 start 时放一次。
//   · LOOP: 读到 start 时开始循环, 读到 end 时淡出停止。
// 资源加载是双模式: 资源预设里的 url 链接, 以及 iPhonie 的内置 sounds/ 文件和声音库（同名时也能用）。
//
// 纯: 无 DOM / 音频 / 网络, 由 host-sfx-presets.js 播放, 由 ui/sfx-presets.js 编辑。

// ---------- 设置默认值与归一化 ----------
export function defaultSfxPresets() {
  return {
    enabled: false,        // 音效设定系统总开关（与 sounds.enabled 各自独立）
    mode: 'llm',           // 'llm' = 二次 LLM 请求规划; 'tags' = 直接用 iPhonie 现有 <sfx>/<ambience> 标签名匹配条目资源
    volume: 0.85,          // 音效设定播放音量 0..1（独立于 sounds 的 sfxVolume）
    perSecond: 14,         // 阅读进度: 每秒字数, 用来把字符区间换算成延时
    autoPlan: true,        // 新回复自动发起二次 LLM 规划（关闭后只在「音效设定」面板里手动试运行）
    currentProfile: '默认音效设定',
    profiles: {'默认音效设定': {enabled: true, entries: []}},
    currentAssetProfile: '默认资源列表',
    assetProfiles: {'默认资源列表': {enabled: true, content: ''}}
  };
}
const clamp01 = v => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.85; };

// 条目 id 生成（host/UI 各自会调）, 这里只是个本地自增, 真正持久化用已有 id。
let _entryCounter = 0;
export function newEntryId() { return `sfx_entry_${Date.now()}_${++_entryCounter}`; }

export function normalizeSfxPresets(value) {
  const base = defaultSfxPresets();
  if (!value || typeof value !== 'object') return base;
  const profiles = {};
  const rawProfiles = value.profiles && typeof value.profiles === 'object' ? value.profiles : base.profiles;
  for (const [name, p] of Object.entries(rawProfiles)) {
    const np = normalizeProfile(p);
    profiles[String(name).slice(0, 60) || '未命名'] = np;
  }
  if (!Object.keys(profiles).length) profiles['默认音效设定'] = normalizeProfile(null);
  const assetProfiles = {};
  const rawAsset = value.assetProfiles && typeof value.assetProfiles === 'object' ? value.assetProfiles : base.assetProfiles;
  for (const [name, p] of Object.entries(rawAsset)) {
    assetProfiles[String(name).slice(0, 60) || '未命名'] = {
      enabled: p && p.enabled !== false,
      content: String(p && p.content || '').slice(0, 200000)
    };
  }
  if (!Object.keys(assetProfiles).length) assetProfiles['默认资源列表'] = {enabled: true, content: ''};
  return {
    enabled: value.enabled === true,
    mode: value.mode === 'tags' ? 'tags' : 'llm',
    volume: clamp01(value.volume),
    perSecond: Math.min(60, Math.max(3, Number(value.perSecond) || base.perSecond)),
    autoPlan: value.autoPlan !== false,
    currentProfile: profiles[value.currentProfile] ? value.currentProfile : Object.keys(profiles)[0],
    profiles,
    currentAssetProfile: assetProfiles[value.currentAssetProfile] ? value.currentAssetProfile : Object.keys(assetProfiles)[0],
    assetProfiles
  };
}
function normalizeProfile(p) {
  const out = {enabled: !(p && p.enabled === false), entries: []};
  if (p && Array.isArray(p.entries)) {
    out.entries = p.entries.map(normalizeEntry).filter(Boolean);
  } else if (p && typeof p.content === 'string' && p.content.trim()) {
    // 旧字符串型 content 迁移成条目
    out.entries = parseLegacyContent(p.content);
  }
  return out;
}
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id: typeof e.id === 'string' && e.id ? e.id : newEntryId(),
    name: String(e.name || '').trim().slice(0, 40) || '未命名',
    loop: e.loop === true,
    enabled: e.enabled !== false,
    content: String(e.content || '').slice(0, 50000)
  };
}

// ---------- 条目 content 解析与序列化（自 ui-audio-resources.js 移植, 去掉 jQuery） ----------
// 旧 profile.content 字符串解析为条目列表, 形如:
//   <名称>(loop)
//   line1
//   line2
//   </名称>
export function parseLegacyContent(content) {
  const entries = [];
  if (!content || !String(content).trim()) return entries;
  const re = /<([^<>\/\s][^<>\n]*?)>(\s*\(\s*loop\s*\))?\s*\r?\n([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    entries.push({
      id: newEntryId(),
      name: m[1].trim(),
      loop: !!m[2],
      content: (m[3] || '').replace(/^\s*\r?\n/, '').replace(/\r?\n\s*$/, ''),
      enabled: true
    });
  }
  if (!entries.length) entries.push({id: newEntryId(), name: '默认', loop: false, content: String(content), enabled: true});
  return entries;
}
// 把条目列表合成为注入用字符串（仅启用的条目）。
export function generateContentFromEntries(entries) {
  return (entries || []).filter(e => e && e.enabled !== false).map(e => {
    const name = String(e.name || '').trim() || 'untitled';
    const loop = e.loop ? '(loop)' : '';
    const body = String(e.content || '').replace(/^\s*\r?\n/, '').replace(/\r?\n\s*$/, '');
    return `<${name}>${loop}\n${body}\n</${name}>`;
  }).join('\n');
}
// 从条目内容的一行里抽取音效名（去掉末尾括号备注）。
export function extractNameFromLine(line) {
  let s = String(line || '').trim();
  if (!s || s.startsWith('#')) return '';
  s = s.replace(/[（(][^（()）]*[)）]\s*$/u, '').trim();
  return s;
}
/** 条目里所有出现的资源名（每行一个, 去备注）。 */
export function entryResourceNames(entry) {
  return String(entry && entry.content || '').split(/\r?\n/).map(extractNameFromLine).filter(Boolean);
}

// ---------- 资源映射（双模式: url + 内置文件） ----------
// 一行: key=url=uploader=volume%=vibration。url 为空时 key 用内置/声音库同名资源。
export function parseAssetLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  const parts = s.split('=');
  if (parts.length < 2) return null; // 至少要有 key=
  const [key = '', url = '', uploader = '', volume = '100', vibration = ''] = parts;
  if (!key.trim()) return null;
  const vol = Number(volume);
  return {
    key: key.trim(),
    url: url.trim(),
    uploader: String(uploader || '').trim(),
    volume: Number.isFinite(vol) ? Math.min(100, Math.max(0, vol)) : 100,
    vibration: String(vibration || '').trim()
  };
}
/** 一个资源预设里所有 key→资源 元素。 */
export function parseAssetProfileContent(content) {
  const out = new Map();
  for (const line of String(content || '').split(/\r?\n/)) {
    const a = parseAssetLine(line);
    if (a) out.set(a.key, a);
  }
  return out;
}
/** 合并所有启用的资源预设, 后者覆盖前者。 */
export function collectAssets(assetProfiles = {}) {
  const map = new Map();
  for (const p of Object.values(assetProfiles)) {
    if (!p || p.enabled === false) continue;
    for (const [k, v] of parseAssetProfileContent(p.content)) map.set(k, v);
  }
  return map;
}
/** 解析一个资源名到可播放形式: {url} | {builtinId} | {libraryName}。 */
export function resolveResource(name, assetMap = new Map(), libraryNames = new Set(), packRows = []) {
  const a = assetMap.get(name);
  if (a && a.url) return {kind: 'url', url: a.url, volume: a.volume / 100, vibration: a.vibration};
  // 内置 pack
  const pack = packRows.find(r => r.name === name);
  if (pack) return {kind: 'builtin', id: pack.id, volume: 0.85};
  // 用户声音库
  if (libraryNames.has(name)) return {kind: 'library', name, volume: 0.85};
  return null;
}

// ---------- 检测名称（Levenshtein 相似度, 自 ui-audio-resources.js 移植） ----------
export function levenshtein(a, b) {
  a = String(a); b = String(b);
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1), cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[bl];
}
export function similarityScore(a, b) {
  const aL = String(a).toLowerCase(), bL = String(b).toLowerCase();
  const max = Math.max(aL.length, bL.length);
  if (max === 0) return 1;
  return 1 - levenshtein(aL, bL) / max;
}
export function findTopMatches(name, allKeys = [], topN = 5) {
  if (!name || !allKeys.length) return [];
  return allKeys.map(k => ({key: k, score: similarityScore(name, k)})).sort((a, b) => b.score - a.score).slice(0, topN);
}

// ---------- 二次 LLM 请求: 规划 prompt 与回复解析 ----------
// 把当前音效设定预设里的条目（仅启用的）和资源列表交给模型, 配上回复正文, 让模型产出 SFX 放置计划。
// 输出约定: 一段 JSON 数组, 每项 {name, kind: "loop"|"once", start: "原文片段", end: "原文片段"}。
// start/end 是从回复里原样摘抄的片段（不可改写）, 用来定位区间; ONCE 只用 start。
export function buildPlanPrompt(entries, assetMap, replyText) {
  const enabled = (entries || []).filter(e => e && e.enabled !== false);
  const entryText = enabled.length ? enabled.map(e => {
    const tag = e.loop ? 'LOOP（循环到场景结束或下一次切换）' : 'ONCE（一次性音效）';
    const names = entryResourceNames(e).join('、') || '（无）';
    return `· [${tag}] ${e.name}\n  可用资源: ${names}`;
  }).join('\n') : '（没有配置任何条目）';
  const resourceText = assetMap.size ? [...assetMap.values()].map(a =>
    `${a.key}=${a.url || '（内置/声音库）'}`).join('\n') : '（没有配置任何资源链接）';
  return [
    '你是一个音效导演助手。下面给出了一篇故事正文，以及可用的音效设定条目和资源列表。',
    '请为这篇正文规划应该在什么时候播放哪些音效。要求：',
    '1. 只用条目里列出的条目名（name 字段）；不要发明新名字。',
    '2. 每个放置点给出: name（条目名）、kind（loop 或 once，与条目的 LOOP/ONCE 一致）、start（从正文里原样摘抄的一小段文字，用于定位开始位置）、end（仅 loop 需要，原样摘抄正文里该场景结束处的一小段文字）。',
    '3. start 与 end 必须是正文字面出现过的连续片段，越短越准（5~15 字最好），不要改写、不要翻译。',
    '4. ONCE 音效紧跟在发出声音的那句话后；LOOP 音效覆盖一个场景段落。一条回复一般 0~4 个放置点，别每句都加。',
    '5. 只输出一段 JSON 数组，不要任何解释、代码块标记或额外文字。空也要输出 []。',
    '',
    '可用音效设定条目：',
    entryText,
    '',
    '可用资源列表（名称=音频来源）：',
    resourceText,
    '',
    '正文：',
    '"""',
    String(replyText || ''),
    '"""'
  ].join('\n');
}

// 解析模型返回的 JSON（容错: 去掉 ``` 代码块、首尾多余文字）。
export function parsePlanReply(reply) {
  let text = String(reply || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  const slice = text.slice(start, end + 1);
  let arr;
  try { arr = JSON.parse(slice); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    if (!item || typeof item !== 'object') return null;
    const name = String(item.name || '').trim();
    const kind = item.kind === 'loop' ? 'loop' : 'once';
    if (!name) return null;
    return {
      name,
      kind,
      startText: String(item.start || item.start_text || '').trim(),
      endText: kind === 'loop' ? String(item.end || item.end_text || '').trim() : ''
    };
  }).filter(Boolean);
}

// ---------- 区间定位（自 index.js 混淆代码里还原的可读版本） ----------
// 在全文里找一个片段, 先用原文找; 找不到时把省略号变体也试一遍（… ↔ ...）。
function buildSearchVariants(text) {
  const out = new Set([String(text)]);
  const a = String(text);
  if (a.includes('…')) { out.add(a.replace(/…/g, '...')); out.add(a.replace(/\.\.\./g, '…')); }
  if (a.includes('...')) out.add(a.replace(/\.\.\./g, '…'));
  return [...out].filter(Boolean);
}
function findSnippetIndex(full, snippet, from = 0) {
  for (const variant of buildSearchVariants(snippet)) {
    const idx = String(full).indexOf(variant, Math.max(0, from));
    if (idx !== -1) return {index: idx, text: variant};
  }
  return null;
}
/** 在 full 里定位 [startText, endText] 区间, 返回 {start, end} 字符索引, 或 null。 */
export function locateRange(full, startText, endText = '') {
  const a = findSnippetIndex(full, startText);
  if (!a) return null;
  if (!endText) return {start: a.index, end: a.index + Math.max(1, a.text.length)};
  const b = findSnippetIndex(full, endText, a.index + a.text.length);
  if (!b) return {start: a.index, end: a.index + Math.max(1, a.text.length)};
  return {start: a.index, end: b.index + Math.max(1, b.text.length)};
}

/** 把一次规划解析成可调度放置点: [{entry(条目对象), kind, start, end}]。未定位到区间的丢弃。 */
export function computePlacements(plan, entries, fullText) {
  const byName = new Map((entries || []).filter(e => e.enabled !== false).map(e => [e.name, e]));
  const out = [];
  for (const p of plan) {
    const entry = byName.get(p.name);
    if (!entry) continue;
    if (entry.loop !== (p.kind === 'loop')) continue; // kind 与条目 LOOP/ONCE 不一致时跳过
    const range = locateRange(fullText, p.startText, p.endText);
    if (!range) continue;
    out.push({entry, kind: p.kind, start: range.start, end: range.end});
  }
  return out;
}

/** 阅读进度: 第 i 个放置点相对第 i-1 个的延时秒数（用区间内可读字数 ÷ 每秒字数）。 */
export function placementGaps(text, placements, {perSecond = 14, least = 0.4, most = 12} = {}) {
  const readable = t => String(t).replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
  let at = 0;
  return placements.map((p, i) => {
    const chars = readable(String(text).slice(at, p.start));
    at = p.end;
    const gap = chars / perSecond;
    return Math.round(Math.min(most, Math.max(i ? least : 0, gap)) * 100) / 100;
  });
}
