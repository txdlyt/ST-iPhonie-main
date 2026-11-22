// 当前服装: what each character wears now, kept for one chat (in the chat's own data: a new chat starts fresh, and
// switching back to an old chat brings its clothes back). The picture planner is told who wears what, and reports who
// changed clothes; the clothes themselves are still written by the model into each picture's own tags, so what the
// story says always wins over what is kept. A fixed outfit in the 世界书 is only where it starts: nothing is kept for
// a person until the story (or the planner) says what they wear.
//
// The book: {name: [{at, outfit, by}]}: at is the message number a change was reported in (oldest first), by is 'ai'
// or 'me'. Planning message N sees each person's latest entry made before N, so a redo of an older message, or a
// swipe, does not see clothes from later on.
export const OUTFIT_KEY = 'sttts_outfits';
export const OUTFIT_LIMITS = Object.freeze({names: 40, perName: 12, name: 40, outfit: 400});

const oneLine = (text, max) => String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/[<>|｜]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// One entry keeps the clothes twice, as the preset in use writes them: `outfit` (tags) and `outfitNl` (自然语言).
// A preset in 自然语言 reads and writes only outfitNl, one in tags only outfit: tag is tag, natural is natural.
const field = nl => nl ? 'outfitNl' : 'outfit';

export function normalizeBook(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [raw, list] of Object.entries(value).slice(0, OUTFIT_LIMITS.names)) {
    const name = oneLine(raw, OUTFIT_LIMITS.name);
    if (!name || !Array.isArray(list)) continue;
    const rows = list.map(e => ({at: Number.isFinite(Number(e?.at)) ? Math.max(0, Math.floor(Number(e.at))) : 0, outfit: oneLine(e?.outfit, OUTFIT_LIMITS.outfit), outfitNl: oneLine(e?.outfitNl, OUTFIT_LIMITS.outfit), by: e?.by === 'me' ? 'me' : 'ai'}))
      .filter(e => e.outfit || e.outfitNl).sort((a, b) => a.at - b.at).slice(-OUTFIT_LIMITS.perName);
    if (rows.length) out[name] = rows;
  }
  return out;
}

/** What each person wore just before message `at`, in the preset's way of writing (nl): [{name, outfit, at, by}], names optionally limited to a Set. */
export function outfitsBefore(book, at, names = null, nl = false) {
  const out = [];
  for (const [name, rows] of Object.entries(normalizeBook(book))) {
    if (names && !names.has(name)) continue;
    const hit = [...rows].reverse().find(e => e.at < at && e[field(nl)]);
    if (hit) out.push({name, outfit: hit[field(nl)], at: hit.at, by: hit.by});
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 14);
}

/** The latest entry of each person in that way of writing, whatever message it was made in (for the list the person edits). */
export function currentOutfits(book, nl = false) {
  const out = [];
  for (const [name, rows] of Object.entries(normalizeBook(book))) {
    const hit = [...rows].reverse().find(e => e[field(nl)]);
    if (hit) out.push({name, outfit: hit[field(nl)], at: hit.at, by: hit.by});
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Records what a reply said about who changed clothes, into the field of the way the preset writes (nl). Entries already made for this message are replaced (a redo does not pile up); the other way of writing stays. */
export function recordOutfits(book, at, list, by = 'ai', nl = false) {
  const next = normalizeBook(book);
  for (const item of Array.isArray(list) ? list : []) {
    const name = oneLine(item?.name, OUTFIT_LIMITS.name), outfit = oneLine(item?.outfit, OUTFIT_LIMITS.outfit);
    if (!name || !outfit) continue;
    const rows = next[name] || [], old = rows.find(e => e.at === at);
    next[name] = [...rows.filter(e => e.at !== at), {at, outfit: '', outfitNl: '', ...(old || {}), [field(nl)]: outfit, by}];
  }
  return normalizeBook(next);
}

export function forgetOutfit(book, name) {
  const next = normalizeBook(book);
  delete next[oneLine(name, OUTFIT_LIMITS.name)];
  return next;
}

/** The people who changed clothes, as an answer wrote them: `服装：名字｜衣服 tag` lines (the phone's blocks). */
export function outfitLines(reply) {
  const out = [];
  for (const m of String(reply ?? '').matchAll(/(?:^|\n)[ \t]*(?:[-*•·][ \t]*)?服装[ \t]*[:：][ \t]*([^｜|\n<]+?)[ \t]*[｜|][ \t]*([^\n<]+)/g)) {
    const name = oneLine(m[1], OUTFIT_LIMITS.name), outfit = oneLine(m[2], OUTFIT_LIMITS.outfit);
    if (name && outfit) out.push({name, outfit});
  }
  return out;
}

/** The 【角色当前服装】 part of a request. */
export function outfitBlock(list) {
  const rows = (Array.isArray(list) ? list : []).filter(r => r?.name && r?.outfit);
  return rows.length
    ? `【角色当前服装】[这个聊天里记下的，到上一条回复结束时]\n${rows.map(r => `- ${r.name}: ${r.outfit}`).join('\n')}`
    : '【角色当前服装】[这个聊天里还没有记录：每个人的起始服装看世界书和角色设定里写的固定服装]';
}

/** For the phone's own picture blocks: what the planner is told about clothes, and how it reports a change. */
export const OUTFIT_RULE = [
  '服装记录：用户消息里的【角色当前服装】是这个聊天里记下的、每个人此刻穿的衣服。',
  '- 每个人这一刻的 tag 里的衣服，从他当前的服装出发：没有新变化就沿用，正文里换了、脱了、弄湿了、弄破了就按正文改。',
  '- 记录里没有的人，起始服装看世界书和角色设定里写的固定服装；正文里的变化永远优先于设定。',
  '- 有人换了衣服（或第一次确定穿什么）时，在出图块里加一行「服装：名字｜现在穿的衣服和配饰 tag」，写他在这条回复结束时的服装；没变化就不写这一行。只写衣服和配饰，不写长相、姿势、动作。'
].join('\n');

/** The same rule for a preset in 自然语言: the clothes are written as Chinese, and a person with no record yet is always reported. */
export const OUTFIT_RULE_NL = [
  '服装记录：用户消息里的【角色当前服装】是这个聊天里记下的、每个人此刻穿的衣服。',
  '- 每个人这一刻的衣服，从他当前的服装出发：没有新变化就沿用，正文里换了、脱了、弄湿了、弄破了就按正文改。',
  '- 记录里没有的人，起始服装看世界书和角色设定里写的固定服装；正文里的变化永远优先于设定。',
  '- 【必须写】出图块里每个出场的人，只要「记录里没有他」或「他的衣服变了」，就在这个出图块里（「角色」行之后、</img> 之前）另起一行：「服装：名字｜他此刻穿的衣服和配饰」。名字和「角色」行里的名字完全一致；衣服用中文写（如「白色护士服，肉色丝袜」），只写衣服和配饰，不写长相、姿势、动作。这一行只用来记录，不参与画图。',
  '- 记录里已有且没变化的人，不写这一行。'
].join('\n');

/** For 柏宝绘: the same, as a rule of its contract (the answer is JSON: outfits). */
export const OUTFIT_RULE_BAIBAI = '角色当前服装（outfits）：用户消息里的【角色当前服装】是这个聊天里记下的、每个人此刻穿的衣服。画图时每个人的衣服从当前服装出发：没有新变化就沿用，目标正文里换装、脱衣、弄湿、损坏就按正文改，并从对应 P 位置起生效；记录里没有的人，起始服装看世界书和角色设定里写的固定服装，正文里的变化永远优先于设定。目标正文结束时，如果有人的服装与记录不同（含第一次确定），就在 outfits 里报告：{"name":"角色名","outfit":"white blouse, navy skirt","position":"P3"}，outfit 只写衣服和配饰的 danbooru tag（不写长相、姿势、动作），写的是该角色在目标正文结束时的服装；没有变化就返回空数组。即使 images 为空也要检查 outfits。';
