// 外貌库 by character card (the way ST-BaiBai-Image keeps it): a 全局 look is a role's own appearance (the 角色 App);
// a 本卡 look belongs to one card and, in that card, is used instead of the global one with the same name.
// Looks: [{id, name, card, appearance, source: 'manual' | 'ai', at}]. cardNames: {cardKey: name}, to show where a look is from.
export const LOOK_LIMITS = Object.freeze({entries: 400, name: 40, appearance: 2000});

export function normalizeLooks(value) {
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const name = String(raw?.name ?? '').trim().slice(0, LOOK_LIMITS.name), card = String(raw?.card ?? '').trim().slice(0, 300);
    const appearance = String(raw?.appearance ?? '').trim().slice(0, LOOK_LIMITS.appearance);
    if (!name || !card || !appearance) continue;
    const id = String(raw?.id || '').slice(0, 80) || `look-${out.length}-${Date.now()}`;
    if (seen.has(id) || seen.has(card + '\n' + name)) continue;
    seen.add(id); seen.add(card + '\n' + name);
    out.push({id, name, card, appearance, source: raw?.source === 'ai' ? 'ai' : 'manual', at: Number.isFinite(raw?.at) ? raw.at : 0});
    if (out.length >= LOOK_LIMITS.entries) break;
  }
  return out;
}
export function normalizeCardNames(value) {
  const out = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, name] of Object.entries(value).slice(0, 300)) {
      const k = String(key).slice(0, 300), n = String(name ?? '').trim().slice(0, 80);
      if (k && n) out[k] = n;
    }
  }
  return out;
}

/**
 * The settings as the card open sees them: the card's own looks are used in place of the global ones with the same name, and a
 * look with no role of that name acts as a role without a voice that belongs to the card. Nothing is stored in this view:
 * pictures are planned and drawn from it.
 */
export function withLooks(settings, key) {
  const mine = key ? (settings.looks || []).filter(l => l.card === key) : [];
  if (!mine.length) return settings;
  const byName = new Map(mine.map(l => [l.name, l]));
  // A role with a look under this card belongs to the card's cast for the picture rules.
  const routes = settings.routes.map(r => byName.has(r.name) ? {...r, appearance: byName.get(r.name).appearance, cards: [...new Set([...(r.cards || []), key])]} : r);
  for (const l of mine) if (!routes.some(r => r.name === l.name)) routes.push({id: 'look:' + l.id, name: l.name, engine: 'fish', voice: '', language: '', appearance: l.appearance, cards: [key]});
  return {...settings, routes};
}
