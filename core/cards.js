// The names of the cards the phone has been opened under ({cardKey: name}), to say which card a photo or a role is from.
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
 * An earlier version kept a look for a card of its own (本卡外貌). They are gone: each one becomes the appearance of the role of
 * that name; a role that already has one keeps it, and a name with no role gets a role without a voice (under its card).
 * Returns the routes with those added; nothing else changes.
 */
export function migrateCardLooks(routes, looks, makeRoute) {
  const out = [...routes];
  const seen = new Set();
  for (const raw of Array.isArray(looks) ? looks : []) {
    const name = String(raw?.name ?? '').trim().slice(0, 40), appearance = String(raw?.appearance ?? '').trim().slice(0, 2000), card = String(raw?.card ?? '').trim().slice(0, 300);
    const dedupe = card + '\n' + name;
    if (!name || !appearance || seen.has(dedupe)) continue;
    seen.add(dedupe);
    // The role of that name in this card; else the global one; else none (a name another card has does not count: a role of this card is made).
    let at = out.findIndex(r => r.name === name && (r.cards || []).includes(card));
    if (at < 0) at = out.findIndex(r => r.name === name && !(r.cards || []).length);
    if (at >= 0) { if (!String(out[at].appearance || '').trim()) out[at] = {...out[at], appearance}; continue; }
    out.push(makeRoute({id: crypto.randomUUID(), name, engine: 'fish', voice: '', model: '', language: '', appearance, ...(card ? {cards: [card]} : {})}));
  }
  return out;
}
