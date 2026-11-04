// 图片反推 sheet: a picture goes to your tagger, its tags come back sorted (core/tagger.js) to tick, and what is ticked goes where
// the caller says. Shared by the role editor (外貌 tag, 当前服装) and the album (copy, save as a role's look).
import {esc, btn} from './common.js';
import {groupTags, joinTags} from '../core/tagger.js';

/**
 * What is sent to the tagger: a big picture smaller (it looks at 448 pixels anyway, and a server takes only so much at once),
 * and a format the server may not read (HEIC from an iPhone, GIF, no type at all) turned into a jpeg.
 */
export async function shrinkForTagger(blob, {side = 1280, over = 1.5 * 1024 * 1024} = {}) {
  if (!blob || typeof blob.size !== 'number') return blob;
  const plain = /^image\/(?:jpe?g|png|webp)$/i.test(blob.type);
  if (plain && blob.size <= over) return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const draw = canvas.getContext('2d');
    draw.fillStyle = '#fff';
    draw.fillRect(0, 0, canvas.width, canvas.height);
    draw.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const small = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return small && (!plain || small.size < blob.size) ? small : blob;
  } catch { return blob; }
}

/** The ticked tags: {all, looks (who they are, hair, eyes), outfit, groups: {key: 'a, b'}}. */
function picked(groups, root) {
  const out = {groups: {}};
  for (const g of groups) {
    const items = g.items.filter(i => root.querySelector(`[data-tag="${i.id}"]`)?.getAttribute('aria-pressed') === 'true');
    out.groups[g.key] = joinTags(items);
  }
  const part = keys => keys.map(k => out.groups[k]).filter(Boolean).join(', ');
  out.looks = part(['body', 'hair', 'eyes']);
  out.outfit = out.groups.wear || '';
  out.all = part(['body', 'hair', 'eyes', 'wear', 'other', 'character']);
  return out;
}

/**
 * blob: the picture. actions: [{label, style?, run(selection) → false to keep the sheet open}].
 * Returns the sheet ({close}).
 */
export function openTagSheet(ctx, api, {blob, title = '图片反推 tag', actions = []}) {
  const d = ctx.dialog(title, '<p class="help-copy">正在识别……</p>');
  let groups = [];
  const failed = message => { d.body.innerHTML = `<p class="help-copy">${esc(message)}</p><div class="actions">${btn('tag-retry', '再试一次', 'secondary')}</div>`; };
  const pills = g => g.items.map(i => `<button type="button" class="tag-pill${i.checked ? ' on' : ''}" data-tag="${i.id}" aria-pressed="${i.checked}">${esc(i.tag)}${i.zh ? `<small>${esc(i.zh)}</small>` : ''}</button>`).join('');
  const count = g => { const on = g.items.filter(i => d.body.querySelector(`[data-tag="${i.id}"]`)?.getAttribute('aria-pressed') === 'true').length; return {on, all: on === g.items.length}; };
  const refresh = () => {
    for (const g of groups) {
      const {on, all} = count(g), head = d.body.querySelector(`[data-tag-head="${g.key}"]`);
      if (!head) continue;
      head.querySelector('small').textContent = `已选 ${on}/${g.items.length}`;
      const link = head.querySelector('[data-tag-group]');
      link.textContent = all ? '全不选' : '全选';
      link.dataset.on = all ? '0' : '1';
    }
  };
  const show = result => {
    groups = groupTags(result);
    if (!groups.length) { d.body.innerHTML = `<p class="help-copy">没有识别出 tag。图里可能没有人物，或者识别阈值太高（设置里的「图片反推」可以调低）。</p><div class="actions">${btn('tag-retry', '再试一次', 'secondary')}</div>`; return; }
    d.body.innerHTML = `${groups.map(g => `<div class="tag-group"><div class="tag-group-head" data-tag-head="${g.key}"><strong>${esc(g.label)}<small></small></strong><button type="button" class="tag-link" data-tag-group="${g.key}" data-on="1">全选</button></div><div class="tag-flow">${pills(g)}</div></div>`).join('')}
      <div class="actions tag-actions">${actions.map((a, n) => btn('tag-act', esc(a.label), a.style || 'secondary', `data-n="${n}"`)).join('')}</div>`;
    refresh();
  };
  const run = async () => {
    d.body.innerHTML = '<p class="help-copy">正在识别，大概要几秒……</p>';
    try { show(await api.tagImage(await shrinkForTagger(blob))); }
    catch (error) { failed(error.message); }
  };
  d.body.addEventListener('click', async e => {
    const pill = e.target.closest('.tag-pill');
    if (pill) {
      e.preventDefault();
      pill.setAttribute('aria-pressed', String(pill.getAttribute('aria-pressed') !== 'true'));
      pill.classList.toggle('on');
      refresh();
      return;
    }
    const group = e.target.closest('[data-tag-group]');
    if (group) {
      e.preventDefault();
      for (const i of groups.find(g => g.key === group.dataset.tagGroup)?.items || []) {
        const box = d.body.querySelector(`[data-tag="${i.id}"]`);
        if (box) { box.setAttribute('aria-pressed', group.dataset.on === '1' ? 'true' : 'false'); box.classList.toggle('on', group.dataset.on === '1'); }
      }
      refresh();
      return;
    }
    const b = e.target.closest('[data-action]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.action === 'tag-retry') { await run(); return; }
    if (b.dataset.action !== 'tag-act') return;
    const action = actions[Number(b.dataset.n)];
    if (!action) return;
    try { if (await action.run(picked(groups, d.body)) !== false) d.close(); }
    catch (error) { ctx.notify(error.message, {error: true}); }
  });
  run();
  return d;
}

/** Which role: a list to pick from → the role, or null. */
export function chooseRole(ctx, api, {title = '存给哪个角色'} = {}) {
  return new Promise(resolve => {
    const roles = api.getState().routes.filter(r => r.name && !r.name.startsWith('(') );
    let done = false;
    const d = ctx.dialog(title, roles.length
      ? `<div class="group">${roles.map(r => `<button type="button" class="list-row" data-pick-role="${esc(r.id)}"><span><strong class="tag-role-name">${esc(r.name)}</strong><small>${esc(r.appearance?.trim() ? '已有外貌：' + r.appearance.trim().slice(0, 28) : '还没写外貌')}</small></span></button>`).join('')}</div>`
      : '<p class="help-copy">还没有角色。先在角色页新增一个。</p>');
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-pick-role]');
      if (!b) return;
      e.preventDefault();
      done = true;
      d.close();
      resolve(roles.find(r => r.id === b.dataset.pickRole) || null);
    });
    // (a sheet put away with no pick leaves this open for ever unless it is told)
    const watch = setInterval(() => { if (!d.body.isConnected) { clearInterval(watch); if (!done) resolve(null); } }, 500);
  });
}
