// 音效设定（声临其境移植）: a dialog opened from the 音效 App. Manages the 音效设定 presets (entries: name + LOOP/ONCE
// + resource names), the 资源列表 (name=url=uploader=volume=vibration), and 检测名称 (Levenshtein match against the
// asset keys, the built-in pack names and the sound library names). Playback and the second-LLM trigger chain run in
// host-sfx-presets.js; this dialog only keeps the settings (api.saveSfxPresets).
import {esc, btn, field, input, select, toggle, groupTitle, help} from './common.js';
import {icon} from './icons.js';
import {
  generateContentFromEntries, extractNameFromLine, parseLegacyContent, newEntryId,
  collectAssets, findTopMatches, parseAssetLine
} from '../core/sfx-presets.js';

// ---------- 小工具 ----------
function downloadJson(data, filename, doc) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = (doc || document).createElement('a');
  a.href = url; a.download = filename; (doc || document).body.appendChild(a); a.click();
  (doc || document).body.removeChild(a); URL.revokeObjectURL(url);
}
function fileImport(doc, accept, cb) {
  const inp = (doc || document).createElement('input');
  inp.type = 'file'; inp.accept = accept;
  inp.onchange = async () => { const f = inp.files[0]; if (!f) return; cb(await f.text(), f.name); };
  inp.click();
}

// ---------- 检测名称 ----------
function runCheck(ctx, s, builtinKeys, libraryNames) {
  const profile = s.profiles[s.currentProfile] || {entries: []};
  const assetMap = collectAssets(s.assetProfiles);
  const allKeys = new Set([...assetMap.keys(), ...builtinKeys, ...libraryNames]);
  const results = [];
  for (const e of (profile.entries || [])) {
    for (const line of String(e.content || '').split(/\r?\n/)) {
      const name = extractNameFromLine(line);
      if (!name) continue;
      const found = allKeys.has(name);
      results.push({entry: e.name, name, found, rawLine: line.trim()});
    }
  }
  const missing = results.filter(r => !r.found);
  const html = `
    <p class="help-copy">已检测 <b>${results.length}</b> 个名称，命中 <b>${results.length - missing.length}</b>，未找到 <b>${missing.length}</b>。</p>
    <div class="group" style="max-height:46vh;overflow:auto">
      ${results.length ? results.map(r => {
        const matches = r.found ? [] : findTopMatches(r.name, [...allKeys], 5);
        return `<div class="list-row static" data-check-name="${esc(r.name)}" data-check-raw="${esc(r.rawLine)}" data-check-entry="${esc(r.entry)}">
          <span><strong>${esc(r.name)}</strong><small>${esc(r.entry)} · ${r.found ? '<span style="color:#2f9e95">已找到</span>' : '<span style="color:#d9534f">未找到</span>'}</small></span>
          ${r.found ? '' : `<span class="row-actions">${btn('check-suggest', icon('wand') + '相似', 'icon-button', `data-name="${esc(r.name)}"`)}</span>`}
        </div>
        <div class="suggest-panel" data-suggest-for="${esc(r.name)}" style="display:none"></div>`;
      }).join('') : empty}
    </div>
    <div class="actions">${btn('check-copy', '复制未找到', 'secondary')}${btn('check-close', '关闭', 'secondary')}</div>`;
  const d = ctx.dialog('名称检测结果', html);
  d.body.addEventListener('click', e => {
    const b = e.target.closest('[data-action]'); if (!b) return; e.preventDefault();
    const action = b.dataset.action;
    if (action === 'check-close') d.close();
    else if (action === 'check-copy') {
      const text = missing.map(r => r.name).join('\n');
      try { navigator.clipboard.writeText(text); } catch {}
      ctx.notify(`已复制 ${missing.length} 个名称`);
    } else if (action === 'check-suggest') {
      const name = b.dataset.name;
      const panel = d.body.querySelector(`[data-suggest-for="${CSS.escape(name)}"]`);
      if (!panel) return;
      const matches = findTopMatches(name, [...allKeys], 5);
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      panel.innerHTML = matches.length ? matches.map(m => {
        const pct = Math.round(m.score * 100);
        const color = m.score >= 0.6 ? '#2f9e95' : m.score >= 0.4 ? '#e0a800' : '#d9534f';
        return `<div class="list-row static"><span><strong style="color:${color}">${pct}%</strong> ${esc(m.key)}</span>${btn('check-pick', '选择', 'secondary small', `data-pick="${esc(m.key)}" data-orig="${esc(name)}"`)}</div>`;
      }).join('') : '<p class="hint">没有相似候选</p>';
    } else if (action === 'check-pick') {
      // 用建议名替换条目里那一行
      const pick = b.dataset.pick, orig = b.dataset.orig;
      const prof = s.profiles[s.currentProfile];
      const entries = prof.entries.map(e => {
        const lines = String(e.content || '').split(/\r?\n/);
        const changed = lines.map(line => extractNameFromLine(line) === orig ? line.replace(orig, pick) : line);
        return {...e, content: changed.join('\n')};
      });
      ctx.api.saveSfxPresets({profiles: {...s.profiles, [s.currentProfile]: {...prof, entries}}}).then(() => { d.close(); ctx.notify('已替换'); openSfxPresetsDialog(ctx); });
    }
  });
}

const empty = '<p class="hint">没有可检测的名称</p>';

// ---------- 条目编辑 ----------
function editEntryDialog(ctx, s, entry) {
  const html = `
    <div class="group">
      ${field('标签名', input('name', entry.name, 'text', 'maxlength="40"'), 'LOOP 类是循环氛围, ONCE 类是一次性音效。')}
      ${field('类型', select('loop', entry.loop ? '1' : '0', [['0', 'ONCE（单次）'], ['1', 'LOOP（循环）']]))}
      ${toggle('enabled', '启用', entry.enabled !== false)}
      ${field('资源名列表（每行一个，可在名称后用括号写备注）', `<textarea data-field="content" rows="10" style="width:100%;font-family:inherit">${esc(entry.content)}</textarea>`, '每行一个资源名，对应「资源列表」里的 key，或内置/声音库里的同名资源。')}
    </div>
    <div class="actions">${btn('save-entry', '保存', 'primary')}${btn('cancel-entry', '取消', 'secondary')}</div>`;
  const d = ctx.dialog('编辑音效条目', html);
  d.body.addEventListener('click', e => {
    const b = e.target.closest('[data-action]'); if (!b) return; e.preventDefault();
    if (b.dataset.action === 'cancel-entry') { d.close(); return; }
    if (b.dataset.action === 'save-entry') {
      const get = k => d.body.querySelector(`[data-field="${k}"]`);
      const prof = s.profiles[s.currentProfile];
      const entries = prof.entries.map(en => en.id === entry.id ? {
        ...en,
        name: String(get('name').value).trim() || '未命名',
        loop: get('loop').value === '1',
        enabled: get('enabled').checked,
        content: get('content').value
      } : en);
      ctx.api.saveSfxPresets({profiles: {...s.profiles, [s.currentProfile]: {...prof, entries}}}).then(() => { d.close(); ctx.notify('条目已保存'); openSfxPresetsDialog(ctx); });
    }
  });
}

// ---------- 资源行 ----------
function assetLineHtml(a) {
  return `<div class="list-row static"><span><strong>${esc(a.key)}</strong><small>${esc(a.url || '（内置/声音库）')}${a.uploader ? ' · ' + esc(a.uploader) : ''} · 音量 ${a.volume}%</small></span></div>`;
}

// ---------- 主对话框 ----------
export function openSfxPresetsDialog(ctx) {
  const api = ctx.api;
  const s0 = api.getState().sfxPresets;
  // 内置包名 + 声音库名, 给检测名称用
  Promise.all([api.sfxPackRows?.().catch(() => []) || [], api.listSounds()]).then(([pack, lib]) => {
    draw(s0, pack.map(r => r.name), new Set(lib.map(r => r.name)));
  }).catch(() => draw(s0, [], new Set()));

  function draw(s, builtinKeys, libraryNames) {
    const profile = s.profiles[s.currentProfile] || {entries: []};
    const assetProfile = s.assetProfiles[s.currentAssetProfile] || {content: ''};
    const assets = [...collectAssets(s.assetProfiles).values()];
    const percent = Math.round((s.volume ?? 0.85) * 100);
    const html = `
      <div class="group">
        ${toggle('enabled', '启用音效设定', s.enabled, '打开后，每次新回复会按下面配置的条目和资源，自动规划并播放音效（声临其境式）。与「正文音效」各自独立，可以同时开。')}
        ${field('触发方式', select('mode', s.mode, [['llm', '二次 LLM 请求规划（完整移植）'], ['tags', '用正文 <sfx>/<ambience> 标签名匹配资源']]), 'LLM 模式：额外发一次文字请求让模型决定何时放什么音效，定位用原文片段。Tags 模式：不发额外请求，直接用 iPhonie 现有标签名去找资源（适合不想多花额度的场景）。')}
        ${field('音量', `<div class="field"><div class="meter-label"><span>音效设定音量</span><output>${percent}%</output></div><input class="slider" type="range" min="0" max="100" step="5" value="${percent}" data-field="volume"></div>`)}
        ${toggle('autoPlan', '新回复自动规划', s.autoPlan !== false, '关闭后，二次 LLM 规划不会自动发起；Tags 模式下仍会随标签播放。')}
      </div>
      ${groupTitle('音效设定预设', help('预设是一组条目。每条目有标签名、LOOP/ONCE 类型和一个资源名列表（每行一个）。模型按这些条目来决定放什么音效。'))}
      <div class="group">
        <div class="field"><span>预设</span>${select('profile', s.currentProfile, Object.keys(s.profiles).map(n => [n, n]))}</div>
        <div class="actions">${btn('new-profile', '新建', 'secondary')}${btn('save-profile', '保存', 'primary')}${btn('rename-profile', '改名', 'secondary')}${btn('delete-profile', '删除', 'danger')}${btn('export-profile', '导出', 'secondary')}${btn('import-profile', '导入', 'secondary')}</div>
        ${profile.entries.length ? profile.entries.map((e, i) => `
          <div class="list-row" data-entry-id="${esc(e.id)}">
            <span><span class="plate" data-loop="${e.loop ? '1' : '0'}">${e.loop ? 'LOOP' : 'ONCE'}</span><strong>${esc(e.name)}</strong><small>${esc(entryResourcePreview(e))}${e.enabled === false ? ' · 已禁用' : ''}</small></span>
            <span class="row-actions">${btn('entry-toggle', icon('eye'), 'icon-button', `data-id="${esc(e.id)}" aria-label="启用/禁用"`)}${btn('entry-edit', icon('edit'), 'icon-button', `data-id="${esc(e.id)}" aria-label="编辑"`)}${btn('entry-delete', icon('trash'), 'icon-button', `data-id="${esc(e.id)}" aria-label="删除"`)}</span>
          </div>`).join('') : '<p class="hint">还没有条目</p>'}
        <div class="actions">${btn('add-entry', icon('add') + '添加条目', 'secondary')}${btn('check-names', icon('wand') + '检测名称', 'secondary')}</div>
      </div>
      ${groupTitle('资源列表预设', help('每行格式：名称=链接=上传者=音量%=震动。链接为空时，该名称会去 iPhonie 的内置音效包和声音库里找同名资源。'))}
      <div class="group">
        <div class="field"><span>资源预设</span>${select('asset', s.currentAssetProfile, Object.keys(s.assetProfiles).map(n => [n, n]))}</div>
        <div class="actions">${btn('new-asset', '新建', 'secondary')}${btn('save-asset', '保存', 'primary')}${btn('rename-asset', '改名', 'secondary')}${btn('delete-asset', '删除', 'danger')}${btn('export-asset', '导出', 'secondary')}${btn('import-asset', '导入', 'secondary')}</div>
        <textarea data-field="asset-content" rows="8" style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:13px">${esc(assetProfile.content)}</textarea>
        <div class="field"><span>添加资源</span></div>
        <div class="group" style="background:var(--bg-2,#f4f4f8)">
          ${input('ak', '', 'text', 'placeholder="名称" maxlength="40"')}
          ${input('au', '', 'text', 'placeholder="链接 URL（可留空，用内置/声音库）" style="flex:1;min-width:60%"')}
          ${input('av', '100', 'text', 'placeholder="音量%" style="max-width:64px"')}
          ${btn('add-asset', '加入', 'secondary')}
        </div>
        ${assets.length ? groupTitle('当前所有资源', `<small>${assets.length}</small>`) + '<div class="group">' + assets.map(assetLineHtml).join('') + '</div>' : ''}
      </div>
      <div class="actions">${btn('close-main', '关闭', 'secondary')}</div>`;
    const d = ctx.dialog('音效设定（声临其境）', html);
    bind(d, s, builtinKeys, libraryNames);
  }

  function entryResourcePreview(e) {
    const names = String(e.content || '').split(/\r?\n/).map(extractNameFromLine).filter(Boolean);
    const preview = names.join('、').slice(0, 50);
    return preview || '(空)';
  }

  function bind(d, s, builtinKeys, libraryNames) {
    const body = d.body;
    const get = k => body.querySelector(`[data-field="${k}"]`);
    const save = patch => api.saveSfxPresets(patch).then(next => { d.close(); openSfxPresetsDialog(ctx); });
    body.addEventListener('change', e => {
      const el = e.target;
      if (el.dataset.field === 'mode') save({mode: el.value});
      if (el.dataset.field === 'enabled') save({enabled: el.checked});
      if (el.dataset.field === 'autoPlan') save({autoPlan: el.checked});
      if (el.dataset.field === 'profile') save({currentProfile: el.value});
      if (el.dataset.field === 'asset') save({currentAssetProfile: el.value});
      if (el.dataset.field === 'volume') save({volume: Number(el.value) / 100});
    });
    body.addEventListener('input', e => {
      if (e.target.dataset.field === 'volume') { const out = e.target.closest('.field')?.querySelector('output'); if (out) out.textContent = e.target.value + '%'; }
    });
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-action]'); if (!b) return; e.preventDefault();
      const action = b.dataset.action;
      if (action === 'close-main') d.close();
      else if (action === 'add-entry') {
        const prof = s.profiles[s.currentProfile];
        const entries = [...prof.entries, {id: newEntryId(), name: '条目 ' + (prof.entries.length + 1), loop: false, enabled: true, content: ''}];
        save({profiles: {...s.profiles, [s.currentProfile]: {...prof, entries}}});
      } else if (action === 'entry-edit') {
        const id = b.dataset.id;
        const entry = s.profiles[s.currentProfile].entries.find(en => en.id === id);
        if (entry) { d.close(); editEntryDialog(ctx, s, entry); }
      } else if (action === 'entry-toggle') {
        const id = b.dataset.id;
        const prof = s.profiles[s.currentProfile];
        const entries = prof.entries.map(en => en.id === id ? {...en, enabled: !(en.enabled !== false)} : en);
        save({profiles: {...s.profiles, [s.currentProfile]: {...prof, entries}}});
      } else if (action === 'entry-delete') {
        const id = b.dataset.id;
        const prof = s.profiles[s.currentProfile];
        const entries = prof.entries.filter(en => en.id !== id);
        save({profiles: {...s.profiles, [s.currentProfile]: {...prof, entries}}});
      } else if (action === 'check-names') { d.close(); runCheck(ctx, s, builtinKeys, libraryNames); }
      else if (action === 'new-profile') {
        const name = prompt('新预设名', '音效设定 ' + (Object.keys(s.profiles).length + 1));
        if (!name) return;
        if (s.profiles[name]) { ctx.notify('已存在同名预设', {error: true}); return; }
        save({profiles: {...s.profiles, [name]: {enabled: true, entries: []}}, currentProfile: name});
      } else if (action === 'save-profile') {
        // 条目已是实时保存的; 这里只存 content 同步
        const prof = s.profiles[s.currentProfile];
        api.saveSfxPresets({profiles: {...s.profiles, [s.currentProfile]: {...prof}}}).then(() => ctx.notify('已保存'));
      } else if (action === 'rename-profile') {
        const name = prompt('改名', s.currentProfile);
        if (!name || name === s.currentProfile) return;
        const next = {}; for (const [k, v] of Object.entries(s.profiles)) next[k === s.currentProfile ? name : k] = v;
        save({profiles: next, currentProfile: name});
      } else if (action === 'delete-profile') {
        if (Object.keys(s.profiles).length <= 1) { ctx.notify('至少保留一个预设', {error: true}); return; }
        if (!confirm(`删除预设「${s.currentProfile}」？`)) return;
        const next = {...s.profiles}; delete next[s.currentProfile];
        save({profiles: next, currentProfile: Object.keys(next)[0]});
      } else if (action === 'export-profile') {
        downloadJson(s.profiles[s.currentProfile], `sfx-presets-${s.currentProfile}.json`, ctx.doc);
      } else if (action === 'import-profile') {
        fileImport(ctx.doc, '.json,application/json', (text) => {
          try {
            const data = JSON.parse(text);
            const single = data && typeof data.enabled !== 'undefined' && Array.isArray(data.entries);
            if (single) { const name = prompt('导入为预设名', '导入的预设') || '导入的预设'; save({profiles: {...s.profiles, [name]: data}}); }
            else if (data && typeof data === 'object') { const merged = {...s.profiles, ...data}; save({profiles: merged}); }
            else ctx.notify('不是有效的预设文件', {error: true});
          } catch (err) { ctx.notify('导入失败：' + err.message, {error: true}); }
        });
      } else if (action === 'new-asset') {
        const name = prompt('新资源预设名', '资源列表 ' + (Object.keys(s.assetProfiles).length + 1));
        if (!name) return;
        save({assetProfiles: {...s.assetProfiles, [name]: {enabled: true, content: ''}}, currentAssetProfile: name});
      } else if (action === 'save-asset') {
        const content = get('asset-content').value;
        save({assetProfiles: {...s.assetProfiles, [s.currentAssetProfile]: {...s.assetProfiles[s.currentAssetProfile], content}}});
      } else if (action === 'rename-asset') {
        const name = prompt('改名', s.currentAssetProfile);
        if (!name || name === s.currentAssetProfile) return;
        const next = {}; for (const [k, v] of Object.entries(s.assetProfiles)) next[k === s.currentAssetProfile ? name : k] = v;
        save({assetProfiles: next, currentAssetProfile: name});
      } else if (action === 'delete-asset') {
        if (Object.keys(s.assetProfiles).length <= 1) { ctx.notify('至少保留一个资源预设', {error: true}); return; }
        if (!confirm(`删除资源预设「${s.currentAssetProfile}」？`)) return;
        const next = {...s.assetProfiles}; delete next[s.currentAssetProfile];
        save({assetProfiles: next, currentAssetProfile: Object.keys(next)[0]});
      } else if (action === 'export-asset') {
        downloadJson(s.assetProfiles[s.currentAssetProfile], `sfx-assets-${s.currentAssetProfile}.json`, ctx.doc);
      } else if (action === 'import-asset') {
        fileImport(ctx.doc, '.json,application/json', (text) => {
          try { const data = JSON.parse(text); const name = prompt('导入为资源预设名', '导入的资源') || '导入的资源';
            save({assetProfiles: {...s.assetProfiles, [name]: data}}); }
          catch (err) { ctx.notify('导入失败：' + err.message, {error: true}); }
        });
      } else if (action === 'add-asset') {
        const key = body.querySelector('[data-field="ak"]').value.trim();
        const url = body.querySelector('[data-field="au"]').value.trim();
        const vol = Number(body.querySelector('[data-field="av"]').value) || 100;
        if (!key) { ctx.notify('名称不能为空', {error: true}); return; }
        const cur = s.assetProfiles[s.currentAssetProfile];
        const line = `${key}=${url}==${vol}=`;
        save({assetProfiles: {...s.assetProfiles, [s.currentAssetProfile]: {...cur, content: (cur.content ? cur.content + '\n' : '') + line}}});
      }
    });
  }
}
