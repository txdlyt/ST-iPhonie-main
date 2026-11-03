// 图片反推: a WD14 tagger of your own (POST {url}/api/tag with an image, GET {url}/health). The phone sends a picture and gets
// back its tags with a category, a confidence and a Chinese name. This module keeps the setting and sorts the tags the way
// a person wants them: who they are, hair, eyes, what they wear, the rest.
export const TAGGER_DEFAULT_THRESHOLD = 0.35;

/** {url, threshold}: the address without a trailing / (or /api/tag, /health pasted by mistake), a threshold between .05 and .95. */
export function normalizeTagger(value) {
  const v = value && typeof value === 'object' ? value : {};
  let url = String(v.url ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/api\/tag$/i, '').replace(/\/health$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(url)) url = '';
  const t = Number(v.threshold);
  return {url: url.slice(0, 300), threshold: Number.isFinite(t) ? Math.min(0.95, Math.max(0.05, Math.round(t * 100) / 100)) : TAGGER_DEFAULT_THRESHOLD};
}
/** A page of the browser that is https cannot reach plain http, except a server on this machine or this network. */
export const reachableFromHttps = url => !/^http:\/\//i.test(url) || /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url);

// ---------- sorting the tags ----------
const NOT_EYES = /closed_eyes|half-closed|eye_contact|one_eye|wink|open_eyes|covering_eye|eyes_visible|looking_|eyes_closed|rolling_eyes|crossed_eyes/;
const ORNAMENT = /hair_ornament|hairband|hairclip|hair_ribbon|hair_bow|hair_flower|hair_tie|hair_scrunchie|hairpin|hair_stick|hair_accessory|hair_ring|hair_bell|hair_rings/;
const WEAR = /dress|skirt|shirt|blouse|uniform|jacket|coat|hoodie|sweater|cardigan|vest|pants|shorts|jeans|leggings|socks|thighhighs|kneehighs|stockings|pantyhose|tights|shoes|boots|sneakers|sandals|loafers|footwear|gloves|mittens|hat|cap$|beret|hood|ribbon|bow$|bowtie|necktie|tie$|scarf|choker|collar|necklace|earrings|bracelet|bangle|ring$|glasses|sunglasses|bikini|swimsuit|one-piece|lingerie|bra$|panties|underwear|kimono|yukata|apron|maid|armor|cape|cloak|belt|bag|backpack|sailor|serafuku|school_uniform|pleated|sleeves|sleeveless|frills|lace|garter|bodysuit|jumpsuit|overalls|pajamas|robe|tank_top|crop_top|camisole|turtleneck|miniskirt|headband|headphones|headwear|hair_ornament|mask|gown|tuxedo|suit|swimwear|leotard|corset|thong|naked_|topless|bottomless|barefoot|no_shoes|no_bra|no_panties|nude/;
const BODY = /skin|tanlines|^tan$|freckles|mole|scar|muscular|breasts|thighs|^tall|short_stature|petite|curvy|slim|slender|flat_chest|collarbone|^toned|^abs$|animal_ears|_ears$|^ears|tail|horns|wings|fang|elf|pointy|halo|^dark|^pale|^wide_hips|^narrow|^plump|^chubby|^skinny|^loli|^mature|^young|^old|^teen|body|height|^1girl$|^1boy$|^2girls$|^2boys$|^1other$|^multiple|^solo$|^androgynous|^trap|^futanari|^otoko_no_ko|^girl$|^boy$/;

/** Which group a tag belongs to: body (who), hair, eyes, wear (clothes and what is worn), other. */
export function groupOf(raw) {
  const t = String(raw || '').toLowerCase();
  if (ORNAMENT.test(t)) return 'wear';
  if (/(^|_)hair($|_)|^bangs$|bangs$|ponytail|twintails|twin_braids|braid|ahoge|sidelocks|hime_cut|bob_cut|drill|^bun$|hair_bun|double_bun|swept_|forehead/.test(t)) return 'hair';
  if (!NOT_EYES.test(t) && /(^|_)eyes?($|_)|pupils|eyelashes|eyeshadow|eyebrows|heterochromia|sanpaku|tsurime|tareme|jitome/.test(t)) return 'eyes';
  if (WEAR.test(t)) return 'wear';
  if (BODY.test(t)) return 'body';
  return 'other';
}
const ORDER = [['body', '性别和体型'], ['hair', '头发'], ['eyes', '眼睛'], ['wear', '服装和配饰'], ['other', '其他（动作、背景、表情……）'], ['character', '角色名和作品']];
const CHECKED = new Set(['body', 'hair', 'eyes']);
/** Underscores to spaces, the way prompts are written (an emoticon such as ^_^ or o_o is left as it is). */
export const prettyTag = raw => /[a-z]{2}/i.test(String(raw)) ? String(raw).replace(/_/g, ' ') : String(raw);

/**
 * The answer of the tagger ({tags: [{tag, category, confidence, zh}]}) as groups to choose from:
 * [{key, label, checked, items: [{id, tag, raw, zh, confidence, checked}]}]. The rating tags are left out; the groups
 * of who they are, hair and eyes start ticked, the rest not.
 */
export function groupTags(result) {
  const buckets = new Map(ORDER.map(([key]) => [key, []]));
  let id = 0;
  for (const t of Array.isArray(result?.tags) ? result.tags : []) {
    const raw = String(t?.tag ?? '').trim();
    if (!raw || t?.category === 'rating') continue;
    const key = t?.category === 'character' ? 'character' : groupOf(raw);
    buckets.get(key).push({id: 't' + id++, tag: prettyTag(raw), raw, zh: String(t?.zh ?? '').trim(), confidence: Math.min(1, Math.max(0, Number(t?.confidence) || 0)), checked: CHECKED.has(key)});
  }
  return ORDER.map(([key, label]) => ({key, label, checked: CHECKED.has(key), items: buckets.get(key)})).filter(g => g.items.length);
}
/** "a, b, c" from items. */
export const joinTags = items => items.map(i => i.tag).join(', ');
