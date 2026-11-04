// The card being played has its roles in its group on the 角色 page. A role belongs to a card by its `cards` (it can be several),
// but sits in one group only; so a role met first in another card was counted for this card ("这张卡 · 4") yet shown in the
// other card's group. Here the roles of the card being played are gathered into its group.
//
// A role the person put in a group of their own (no card on it) stays there, and one they took out of every group (loose)
// stays out. A role of several cards goes with the card being played. A group is made for a card only for two roles or more.
/**
 * routes, groups: as in the settings. key: the card (not the chat). Returns {routes, groups, changed}; the arrays are new
 * only when something moved.
 */
export function gatherCardRoles(routes, groups, key, name = '', makeId = () => crypto.randomUUID()) {
  const list = Array.isArray(groups) ? groups : [];
  if (!key) return {routes, groups: list, changed: false};
  const mine = routes.filter(r => Array.isArray(r.cards) && r.cards.includes(key) && !r.loose);
  let group = list.find(g => g.card === key);
  if (!group && mine.length < 2) return {routes, groups: list, changed: false};
  const byId = new Map(list.map(g => [g.id, g]));
  const move = mine.filter(r => { if (group && r.group === group.id) return false; const now = r.group ? byId.get(r.group) : null; return !now || !!now.card; });
  if (!move.length) return {routes, groups: list, changed: false};
  const nextGroups = [...list];
  if (!group) {
    group = {id: makeId(), name: String(name || key.replace(/^[a-z]+:/, '').replace(/\.[^.]+$/, '') || '角色').slice(0, 40), open: true, card: key};
    nextGroups.push(group);
  }
  const ids = new Set(move.map(r => r.id));
  return {routes: routes.map(r => ids.has(r.id) ? {...r, group: group.id} : r), groups: nextGroups, changed: true};
}
