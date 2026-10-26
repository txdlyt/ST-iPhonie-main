// 音效: ambience and sound effects for the story. The switch and the volumes, the sounds the story asked for that the
// library has none of (缺的声音: upload one, or have ElevenLabs make it), and the library by name: each name can have
// several versions (played in turn), an ambience a 底子 that loops and 点缀 now and then. Playing happens in the tavern
// page (host-sounds.js); this app only keeps the library.
import {createView, esc, btn, field, input, select, textArea, toggle, heading, groupTitle, plate, empty, size, help} from './common.js';
import {swipeRow, mountSwipeList} from './swipe-list.js';
import {icon} from './icons.js';
import {saveFile} from '../download.js';
import {KIND_NAMES, LAYER_NAMES, SOUND_SOURCES, soundName} from '../core/sounds.js';

const KINDS = [['sfx', '音效'], ['ambience|bed', '氛围音 · 底子'], ['ambience|dot', '氛围音 · 点缀']];
const STRENGTH_CHOICES = [['', '不分轻重'], ['轻', '轻'], ['重', '重']];
const kindValue = r => r.type === 'ambience' ? 'ambience|' + (r.layer === 'dot' ? 'dot' : 'bed') : 'sfx';
const kindPatch = value => { const [type, layer = ''] = String(value).split('|'); return {type, layer}; };
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
const volumeChoices = current => { const list = [0.5, 0.75, 1, 1.25, 1.5, 2]; if (!list.includes(current)) list.push(current); return list.sort((a, b) => a - b).map(n => [String(n), Math.round(n * 100) + '%']); };
const baseName = file => soundName(String(file?.name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')) || '新声音';

export function soundsApp(ctx) {
  const {api} = ctx, v = createView(ctx, 'sounds');
  let rows = [], missing = [], pack = null, epoch = 0, uploadFor = null, query = '';
  const state = () => api.getState().sounds;
  const live = () => { try { return api.soundState?.() || null; } catch { return null; } };
  const elevenKey = () => !!api.keyStatus?.('eleven');

  function names(type) {
    const groups = new Map();
    for (const r of rows.filter(r => r.type === type)) { if (!groups.has(r.name)) groups.set(r.name, []); groups.get(r.name).push(r); }
    return [...groups].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  }
  function nameRow([name, list]) {
    const sources = [...new Set(list.map(r => SOUND_SOURCES[r.source]))].join(' · ');
    const layers = list[0].type === 'ambience' ? ` · 底子 ${list.filter(r => r.layer !== 'dot').length} · 点缀 ${list.filter(r => r.layer === 'dot').length}` : '';
    return `<button class="list-row" data-action="open-name" data-type="${esc(list[0].type)}" data-name="${esc(name)}"><span><strong>${esc(name)}</strong><small>${list.length} 个版本${layers} · ${esc(sources)}</small></span>${icon('next')}</button>`;
  }
  async function render() {
    const ticket = ++epoch;
    const [all, gone, shipped] = await Promise.all([api.listSounds(), api.soundMissing(), api.packInfo?.().catch(() => null)]);
    if (v.disposed || ticket !== epoch) return;
    rows = all; missing = gone; pack = shipped;
    const s = state(), now = live(), key = elevenKey();
    const playing = now?.ambience ? `<span><strong>≋ ${esc(now.ambience)}</strong><small>正在放的氛围音</small></span>${btn('stop-ambience', icon('stop') + '停', 'secondary small')}`
      : now?.waiting ? `<span><strong>≋ ${esc(now.waiting)}</strong><small>点一下酒馆页面就开始放（浏览器要先点一下才允许出声）</small></span>`
      : '<span><strong>没有氛围音</strong><small>剧情写了氛围音就会在这里显示</small></span>';
    const making = now?.making?.length ? `<p class="hint" role="status">正在生成：${now.making.map(esc).join('、')}……</p>` : '';
    const percent = value => Math.round((value ?? 0) * 100);
    const slider = (keyName, label, value) => `<div class="field"><div class="meter-label"><span>${label}</span><output>${percent(value)}%</output></div><input class="slider" type="range" min="0" max="100" step="5" value="${percent(value)}" data-volume="${keyName}" aria-label="${label}"></div>`;
    v.draw(heading('音效', btn('sound-tools', icon('more'), 'round-button', 'aria-label="导入、导出音效包"'), `Ambience · ${rows.length} 个声音`)
      + `<div class="group">${toggle('enabled', '正文音效', s.enabled, '打开后，剧情模型会在正文里写氛围音和音效的标签，插件按读的速度放出来；开着朗读时跟着台词走。标签发给模型前会去掉，旧楼层不占上下文；每次只多一段说明和声音名单。声音库是空的、也没开 ElevenLabs 生成时，什么都不加。')}
        ${s.enabled ? `<div class="list-row static">${playing}</div>${slider('ambienceVolume', '氛围音音量', s.ambienceVolume)}${slider('sfxVolume', '音效音量', s.sfxVolume)}
        ${toggle('anchors', '可以指定在哪句话响起', s.anchors !== false, '打开后，会告诉故事模型：标签里可以写 |@几个字，让声音正好在这几个字处响起；氛围音可以写 @开始~结束，只在这一段里放；音效写 |等，朗读会等它放完再往下读。也能读懂声临其境的 <SFX> / <SFX_WAIT> / <Ambiance> 标签。关掉就不再提这些写法（已写好的仍然有效）。')}
        ${toggle('tapOnly', '只在点的时候放', s.tapOnly, '打开后，音效和氛围音都不再跟着读的速度、朗读或换聊天自己放，只有点正文里的 ♪ 才放；点氛围音的 ♪ 开始循环，再点一次停下。')}
        ${toggle('vary', '每次放得稍有不同', s.vary, '同一个声音每次稍微快一点或慢一点、轻一点或响一点；氛围音每次从不同的地方开始。听起来不像同一段录音反复放。')}` : ''}</div>${making}`
      + groupTitle('ElevenLabs 生成')
      + `<div class="group">${toggle('generate', '缺的声音让 ElevenLabs 做', s.generate, '剧情写了声音库里没有的声音时，模型会附一句英文描述，ElevenLabs 照着做出来存进声音库，下次直接用。会用掉 ElevenLabs 的额度。')}
        ${s.generate ? `${field('每个声音最多做几个版本', select('versions', s.versions, [1, 2, 3, 4, 5].map(n => [n, n + ' 个'])), '只有 ElevenLabs 做的声音会补新版本：不到这个数时，偶尔再做一个，以后轮流放，听不腻。你自己传的声音不会花额度。')}
          ${key ? '' : '<p class="hint">还没有填 ElevenLabs 的密钥：在引擎 App 的 ElevenLabs 里填好才能生成。</p>'}` : ''}</div>`
      + (pack?.count ? groupTitle('自带音效包') + `<div class="group">${toggle('pack', `用自带的声音（${pack.names} 个名字）`, s.pack !== false, '插件里带了一套 Freesound 上的 CC0 声音（雨夜、海边、篝火、敲门、脚步、翻书……），直接从插件文件夹里放，不占浏览器的空间。关掉后剧情只用你自己的声音和 ElevenLabs 做的。')}
        ${pack.hidden ? `<div class="list-row static"><span><strong>拿掉了 ${pack.hidden} 个自带声音</strong><small>拿掉的只是不用了，随时能找回</small></span>${btn('pack-restore', '找回', 'secondary small')}</div>` : ''}</div>` : '')
      + (missing.length ? groupTitle('缺的声音', `<small>${missing.length}</small>`) + `<div class="group">${missing.map(m => `<div class="list-row static sound-missing"><span><strong>${esc(m.name)}</strong><small>${KIND_NAMES[m.type]} · 想用过 ${m.count} 次${m.describe ? ' · ' + esc(m.describe) : ''}</small></span><span class="row-actions">${btn('missing-upload', icon('import'), 'icon-button', `data-type="${esc(m.type)}" data-name="${esc(m.name)}" aria-label="上传「${esc(m.name)}」"`)}${key ? btn('missing-make', icon('star'), 'icon-button', `data-type="${esc(m.type)}" data-name="${esc(m.name)}" data-describe="${esc(m.describe)}" aria-label="让 ElevenLabs 做「${esc(m.name)}」"`) : ''}${btn('missing-dismiss', icon('close'), 'icon-button', `data-type="${esc(m.type)}" data-name="${esc(m.name)}" aria-label="不要「${esc(m.name)}」"`)}</span></div>`).join('')}</div>` : '')
      + `<div class="actions">${`<label class="primary file-button">${icon('add')}添加声音<input type="file" data-sound-file multiple accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.opus,.webm" aria-label="选择声音文件"></label>`}${btn('add-link', icon('add') + '添加链接', 'secondary')}${key ? btn('make-new', icon('star') + 'ElevenLabs 做一个', 'secondary') : ''}</div>`
      + (rows.length > 12 ? `<input class="search sound-search" data-sound-search type="search" placeholder="找声音（按名字）" value="${esc(query)}" aria-label="找声音">` : '')
      + (rows.length
        ? ['ambience', 'sfx'].map(type => { const list = names(type); return list.length ? groupTitle(KIND_NAMES[type], `<small>${list.length}</small>`) + `<div class="group">${list.map(nameRow).join('')}</div>` : ''; }).join('')
        : empty('声音库还是空的', '添加自己的声音文件（雨声、敲门声……起好名字），或者打开 ElevenLabs 生成。名字就是剧情里写的名字，同一个名字可以放好几个版本。', 'music')));
  }

  // ---------- One name: its versions ----------
  function openName(type, name) {
    const list = rows.filter(r => r.type === type && r.name === name);
    if (!list.length) return render();
    const own = list.filter(r => r.source !== 'pack');
    const about = '这是自带的声音：剧情里写这个名字就会放。不喜欢哪个版本可以拿掉，也可以自己再加一个版本。\n\n'
      + '氛围音的底子一直循环（雨声、海浪），点缀偶尔在左边或右边响一下（雷声、鸟叫）。轻重：剧情写了「名字|轻」或「名字|重」时，先挑对应的版本，没有就挑不分轻重的。\n\n'
      + '点一个版本试听；左滑拿掉或删除；右滑多选。';
    const d = ctx.dialog(name, `${own.length ? `${field('名字', input('name', name, 'text', 'maxlength="20"'), '剧情里写的就是这个名字。改了以后，你自己的和 ElevenLabs 做的版本一起改名（自带的不变）。')}
      <div class="actions">${btn('rename', '改名', 'secondary')}</div>` : ''}
      ${groupTitle('版本', `${help(about)}<small>${list.length}</small>`)}
      <div class="group" data-version-list>${list.map(r => swipeRow(r.id, `<div class="sound-version" data-id="${esc(r.id)}">
        <div class="sound-version-head"><span class="disc play" aria-hidden="true">${icon('play')}</span><span><strong>${esc(SOUND_SOURCES[r.source])}${r.layer === 'dot' ? ' · 点缀' : ''}</strong><small>${r.seconds ? r.seconds + ' 秒 · ' : ''}${r.url && !r.size ? '' : size(r.size)}${r.url ? ' · ' + esc(hostOf(r.url)) : ''}${r.describe ? ' · ' + esc(r.describe) : ''}${r.credit ? ' · ' + esc(r.credit) : ''}</small></span></div>
        ${r.source === 'pack' ? '' : `<div class="sound-version-fields">${select('kind', kindValue(r), KINDS, `data-id="${esc(r.id)}" aria-label="种类"`)}${select('strength', r.strength, STRENGTH_CHOICES, `data-id="${esc(r.id)}" aria-label="轻重"`)}${select('volume', String(r.volume ?? 1), volumeChoices(r.volume ?? 1), `data-id="${esc(r.id)}" aria-label="这一条的音量"`)}</div>${r.url ? `<div class="sound-version-fields">${input('url', r.url, 'url', `data-id="${esc(r.id)}" maxlength="2000" aria-label="链接"`)}</div>` : ''}`}</div>`,
        [{key: 'delete', label: r.source === 'pack' ? '拿掉' : '删除', icon: 'trash', danger: true}], {label: SOUND_SOURCES[r.source]})).join('')}</div>
      <div class="actions"><label class="secondary file-button">${icon('add')}再加一个版本<input type="file" data-version-file multiple accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.opus,.webm" aria-label="选择声音文件"></label>${own.length ? btn('export-name', icon('download') + '导出', 'secondary') : ''}</div>`);
    /** Versions taken out (自带 ones can come back from 自带音效包). */
    const drop = async ids => {
      const packOnly = ids.every(id => id.startsWith('pack:'));
      if (!await ctx.confirm(ids.length > 1 ? `去掉这 ${ids.length} 个版本？` : packOnly ? '不用这个自带的版本？' : '删除这个版本？', packOnly ? '以后可以在「自带音效包」里找回。' : '')) return;
      await api.deleteSounds(ids);
      if (list.length <= ids.length) close(); else { d.close(); await render(); openName(type, name); }
    };
    const swipe = mountSwipeList(d.body.querySelector('[data-version-list]'), {ctx,
      onTap: async id => { const on = await api.soundListen?.(id); if (on === undefined) ctx.notify('在酒馆里打开小手机才能试听'); },
      onAction: (key, id) => { if (key === 'delete') drop([id]).catch(error => ctx.notify(error.message, {error: true})); },
      bulk: [{key: 'delete', label: '去掉', icon: 'trash', danger: true}], onBulk: (key, ids) => drop(ids)});
    d.onClose(() => swipe.dispose());
    const close = () => { d.close(); render(); };
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      e.preventDefault();
      (async () => {
        switch (b.dataset.action) {
          case 'rename': {
            const next = soundName(d.body.querySelector('[data-field=name]').value);
            if (!next) throw Error('给声音起个名字');
            for (const r of own) await api.updateSound(r.id, {name: next});
            ctx.notify(`改成了「${next}」`); close(); break;
          }
          case 'export-name': await download(own.map(r => r.id), name); break;
        }
      })().catch(error => ctx.notify(error.message, {error: true}));
    });
    d.body.addEventListener('change', e => {
      const el = e.target;
      (async () => {
        if (el.matches('[data-version-file]')) { const files = [...el.files]; el.value = ''; if (files.length) { d.close(); addFiles(files, {name, type, layer: list[0].layer}); } return; }
        if (el.dataset.field === 'kind') await api.updateSound(el.dataset.id, kindPatch(el.value));
        if (el.dataset.field === 'strength') await api.updateSound(el.dataset.id, {strength: el.value});
        if (el.dataset.field === 'volume') await api.updateSound(el.dataset.id, {volume: Number(el.value)});
        if (el.dataset.field === 'url') await api.updateSound(el.dataset.id, {url: el.value.trim()});
        const rest = rows.filter(r => r.id !== el.dataset.id);
        rows = [...rest, ...(await api.listSounds()).filter(r => r.id === el.dataset.id)];
        ctx.notify('已保存');
      })().catch(error => ctx.notify(error.message, {error: true}));
    });
  }

  // ---------- Adding files ----------
  /** Asks the name and kind of each file, then keeps them. preset: the name (and kind) they are versions of. */
  function addFiles(files, preset = null) {
    const kind = preset ? kindValue({type: preset.type, layer: preset.layer}) : 'sfx';
    const d = ctx.dialog(preset ? `给「${preset.name}」加版本` : '添加声音', `<p class="help-copy">名字就是剧情里写的名字（雨夜、敲门、脚步……）。同一个名字的几个文件是同一个声音的不同版本，会轮流放。氛围音的底子一直循环，点缀偶尔响一下。</p>
      <div class="group">${files.map((f, i) => `<div class="sound-version" data-i="${i}"><div class="sound-version-head"><span><strong>${esc(f.name)}</strong><small>${size(f.size)}</small></span></div>
        <div class="sound-version-fields">${input('name', preset?.name || baseName(f), 'text', `maxlength="20" data-i="${i}" aria-label="名字"`)}${select('kind', kind, KINDS, `data-i="${i}" aria-label="种类"`)}${select('strength', '', STRENGTH_CHOICES, `data-i="${i}" aria-label="轻重"`)}</div></div>`).join('')}</div>
      <div class="actions">${btn('keep-files', '保存', 'primary')}</div>`);
    d.body.addEventListener('click', e => {
      if (!e.target.closest('[data-action="keep-files"]')) return;
      e.preventDefault();
      const b = e.target.closest('button');
      v.busy(b, async () => {
        const value = (i, f) => d.body.querySelector(`[data-field="${f}"][data-i="${i}"]`).value;
        const list = files.map((file, i) => ({name: soundName(value(i, 'name')), ...kindPatch(value(i, 'kind')), strength: value(i, 'strength'), source: 'mine', blob: file}));
        if (list.some(x => !x.name)) throw Error('每个声音都要有名字');
        await api.addSounds(list);
        d.close(); await render();
        ctx.notify(`加好了 ${list.length} 个声音`);
      }).catch(error => ctx.notify(error.message, {error: true}));
    });
  }

  // ---------- 链接: sounds that stay on the web ----------
  /** One sound from a link: name, kind and the address (it is fetched when it plays; nothing is stored here). */
  function linkSheet() {
    const d = ctx.dialog('添加链接', `<p class="help-copy">声音留在原来的网站上，播放时才去取，不占浏览器空间。链接要能直接打开音频文件（mp3、wav、ogg 等），并且对方网站允许别的网站读取。</p>
      ${field('名字', input('name', '', 'text', 'maxlength="20" placeholder="比如 敲门"'))}
      ${field('种类', select('kind', 'sfx', KINDS))}
      ${field('链接', input('url', '', 'url', 'maxlength="2000" placeholder="https://…/knock.mp3"'))}
      ${field('音量', select('volume', '1', volumeChoices(1)))}
      <div class="actions">${btn('keep-link', '保存', 'primary')}</div>`);
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-action="keep-link"]');
      if (!b) return;
      e.preventDefault();
      v.busy(b, async () => {
        const get = f => d.body.querySelector(`[data-field="${f}"]`).value;
        const name = soundName(get('name'));
        if (!name) throw Error('给声音起个名字');
        if (!/^https?:\/\/\S+$/i.test(get('url').trim())) throw Error('链接要以 http:// 或 https:// 开头');
        await api.addSounds([{name, ...kindPatch(get('kind')), url: get('url').trim(), volume: Number(get('volume')), source: 'link'}]);
        d.close(); await render();
        ctx.notify('已添加链接「' + name + '」');
      }).catch(error => ctx.notify(error.message, {error: true}));
    });
  }
  /** Many at once, one per line as 声临其境 keeps them: 名字=链接=上传者=音量=震动 (the last three can be left out). */
  function linkLines() {
    const d = ctx.dialog('批量导入链接', `<p class="help-copy">每行一条：<code>名字=链接</code>。也可以直接粘贴声临其境的音效列表（<code>名字=链接=上传者=音量=震动</code>）：名字以 SFX_ 开头是音效，以 Ambiance_ 开头是氛围音，不带前缀按音效算；Music_ 开头的是音乐，这里不收。已有的同名同链接会跳过。</p>
      ${textArea('lines', '', 'rows="9" placeholder="SFX_敲门=https://…/knock.mp3\nAmbiance_下雨=https://…/rain.mp3"')}
      <div class="actions">${btn('keep-lines', '导入', 'primary')}</div>`);
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-action="keep-lines"]');
      if (!b) return;
      e.preventDefault();
      v.busy(b, async () => {
        const text = d.body.querySelector('[data-field="lines"]').value;
        if (!text.trim()) throw Error('先粘贴要导入的链接');
        const r = await api.importSoundLinks(text);
        if (!r.added && !r.skipped) throw Error(r.bad ? '没有读到能用的链接（每行要是 名字=https://…）' : '没有可导入的内容');
        d.close(); await render();
        ctx.notify(`已导入 ${r.added} 条` + (r.skipped ? `，${r.skipped} 条已有` : '') + (r.music ? `，${r.music} 条音乐没收` : '') + (r.bad ? `，${r.bad} 行读不懂` : ''));
      }).catch(error => ctx.notify(error.message, {error: true}));
    });
  }

  // ---------- ElevenLabs ----------
  function makeSheet({type = 'sfx', name = '', describe = ''} = {}) {
    const d = ctx.dialog('ElevenLabs 做一个声音', `${field('名字', input('name', name, 'text', 'maxlength="20" placeholder="比如：敲门"'))}${field('种类', select('type', type, [['sfx', '音效（一次）'], ['ambience', '氛围音（循环约 22 秒）']]))}
      ${field('英文描述', input('describe', describe, 'text', 'maxlength="200" placeholder="heavy wooden door knock, three times"'), '用英文写清楚是什么声音、在什么环境里。越具体越像。')}
      <p class="hint">会用掉 ElevenLabs 的额度。</p><div class="actions">${btn('make', icon('star') + '生成', 'primary')}</div>`);
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-action="make"]');
      if (!b) return;
      e.preventDefault();
      v.busy(b, async () => {
        const get = f => d.body.querySelector(`[data-field="${f}"]`).value;
        const n = soundName(get('name'));
        if (!n) throw Error('给声音起个名字');
        b.textContent = '正在生成……';
        const row = await api.generateSound({name: n, type: get('type'), describe: get('describe')});
        d.close(); await render();
        ctx.notify(`做好了「${row.name}」`);
        api.soundListen?.(row.id)?.catch?.(() => {});
      }).catch(error => { if (b.isConnected) b.innerHTML = icon('star') + '生成'; ctx.notify(error.message, {error: true}); });
    });
  }

  // ---------- 音效包 ----------
  async function download(ids, name) {
    const blob = await api.exportSounds(ids, name);
    ctx.notify('已下载 ' + await saveFile(ctx.doc, blob, (name ? name + ' ' : '') + '音效包.json'));
  }
  function tools() {
    const d = ctx.dialog('音效包', `<p class="help-copy">音效包是一个文件，里面是声音和它们的名字、种类、轻重。可以导出给别人，也可以导入别人分享的。</p>
      <div class="actions"><label class="secondary file-button">${icon('import')}导入音效包<input type="file" data-pack-file accept=".json,application/json" aria-label="选择音效包"></label>${btn('export-all', icon('download') + '导出全部', 'secondary', rows.length ? '' : 'disabled')}</div>
      <div class="actions">${btn('import-links', icon('import') + '批量导入链接', 'secondary')}</div>
      ${rows.length ? `<div class="actions">${btn('clear-all', icon('trash') + '清空声音库', 'danger')}</div>` : ''}`);
    d.body.addEventListener('change', e => {
      if (!e.target.matches('[data-pack-file]')) return;
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      api.importSounds(file).then(async r => { d.close(); await render(); ctx.notify(`导入了 ${r.added} 个声音${r.skipped ? `（${r.skipped} 个已经有了）` : ''}`); }).catch(error => ctx.notify(error.message, {error: true}));
    });
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      e.preventDefault();
      (async () => {
        if (b.dataset.action === 'export-all') await download(null, '');
        if (b.dataset.action === 'import-links') { d.close(); linkLines(); }
        if (b.dataset.action === 'clear-all') {
          if (!await ctx.confirm('清空声音库？', `${rows.length} 个声音都会删除。可以先导出备份。`)) return;
          await api.deleteSounds(rows.map(r => r.id)); d.close(); await render(); ctx.notify('声音库已清空');
        }
      })().catch(error => ctx.notify(error.message, {error: true}));
    });
  }

  v.refresh = () => render();
  v.on('change', '[data-field]', async el => {
    if (el.closest('.sheet')) return;
    const key = el.dataset.field, value = el.type === 'checkbox' ? el.checked : el.value;
    if (!['enabled', 'vary', 'tapOnly', 'generate', 'versions', 'pack', 'anchors'].includes(key)) return;
    api.saveSounds({[key]: key === 'versions' ? Number(value) : value});
    if (key === 'enabled' && value) ctx.notify('音效开了：之后的回复里会有氛围音和音效');
    await render();
  });
  // Finding a sound: the names that do not match are hidden in place (the box keeps its focus).
  v.on('input', '[data-sound-search]', el => {
    query = el.value.trim();
    for (const row of v.root.querySelectorAll('[data-action=open-name]')) row.hidden = !!query && !row.dataset.name.includes(query);
    for (const group of v.root.querySelectorAll('.group')) if (group.querySelector('[data-action=open-name]')) { const shown = !!group.querySelector('[data-action=open-name]:not([hidden])'); group.hidden = !shown; if (group.previousElementSibling?.classList.contains('group-title')) group.previousElementSibling.hidden = !shown; }
  });
  v.on('input', '[data-volume]', el => { const out = el.closest('.field')?.querySelector('output'); if (out) out.textContent = el.value + '%'; });
  v.on('change', '[data-volume]', el => { api.saveSounds({[el.dataset.volume]: Number(el.value) / 100}); });
  v.on('change', '[data-sound-file]', el => { const files = [...el.files]; el.value = ''; if (!files.length) return; const preset = uploadFor; uploadFor = null; addFiles(files, preset); });
  v.on('click', '[data-action]', async el => {
    switch (el.dataset.action) {
      case 'open-name': openName(el.dataset.type, el.dataset.name); break;
      case 'stop-ambience': api.soundStopAmbience?.(); await render(); break;
      case 'pack-restore': api.saveSounds({packHidden: []}); await render(); ctx.notify('自带的声音都找回来了'); break;
      case 'sound-tools': tools(); break;
      case 'add-link': linkSheet(); break;
      case 'make-new': makeSheet(); break;
      case 'missing-make': makeSheet({type: el.dataset.type, name: el.dataset.name, describe: el.dataset.describe}); break;
      case 'missing-dismiss': await api.dismissMissing(el.dataset.type, el.dataset.name); await render(); break;
      case 'missing-upload': {
        uploadFor = {name: el.dataset.name, type: el.dataset.type, layer: el.dataset.type === 'ambience' ? 'bed' : ''};
        v.root.querySelector('[data-sound-file]')?.click();
        break;
      }
    }
  });
  // The library and the ambience change from the tavern side too (a sound made, a scene changed).
  const off = api.subscribe?.(event => { if ((event.type === 'sounds' || event.type === 'sound-state') && ctx.visible('sounds')) render(); });
  const dispose = v.dispose;
  v.dispose = () => { off?.(); dispose(); };
  render().catch(error => ctx.notify(error.message));
  return v;
}
