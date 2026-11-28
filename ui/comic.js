// 漫画: the story made into comic pages, shelf-style like 绘本. The shelf lists the comics being made; 做一本 picks the
// part of the chat, the page count (empty: the model decides) and how the pictures come (自动 / 手动); the text model
// writes the storyboard first, so the pages exist at once as placeholders (the panels' layout and words); then each page
// is drawn by the 绘图 App (automatically one after another with the progress shown, or one by one by hand); the words
// are laid on by the plugin. A finished comic goes onto the 书架 as a .cbz, where it is read.
import {createView, esc, heading, btn, help, field, select} from './common.js';
import {icon} from './icons.js';
import {writeZip} from '../core/model-files.js';
import {openBook} from '../core/bookshelf.js';
import {pictureInputs, sizeFor} from '../core/draw.js';
import {comicRequest, parseComic, panelRects, pageTags, pageCharacters, COMIC_NEGATIVE, COMIC_PAGES, clampPages} from '../core/comic.js';
import {composePage} from '../core/comic-canvas.js';
import {mountReader} from './comic-reader.js';
import {openAlbum} from './album-viewer.js';
import {normalizeDrawParams} from '../core/novelai.js';
import {saveFile} from '../download.js';
import {COMIC_COLORS, COMIC_STYLES, COMIC_LANGS, COMIC_TEXT_SIZES, COMIC_BUBBLES, COMIC_GUTTERS, COMIC_NOTE_MAX, normalizeComic, comicTags, canvasOptions, activePreset, newPreset, savePreset, removePreset, presetFile, readPresetFile, COMIC_ENTRY_TO, COMIC_SIZES, COMIC_PAGES_EACH, COMIC_PER_PAGE, COMIC_VARIETY, COMIC_DIRECTIONS, COMIC_READING, comicDrawParams, comicSizeWord} from '../core/comic-settings.js';
import {NAI_MODELS, NAI_MODEL_NAMES, NAI_SAMPLERS, NAI_SAMPLER_NAMES, NAI_SCHEDULES} from '../core/novelai.js';
import {bookRange, rangeMarkup, pickBookRange, readBookSource, bookForm, BOOK_SOURCES, BOOK_TEXT_LIMIT} from './book-setup.js';

const KEY = 'stiphonie.comic.drafts';
const MODES = [['auto', '自动出图'], ['hand', '手动出图']];
const SOURCES = BOOK_SOURCES.filter(([k]) => k !== 'theater');

export function comicApp(ctx) {
  const {api} = ctx, v = createView(ctx, 'comic'), urls = new Map(), failures = new Map();
  let view = 'shelf', drafts = load(), form = null, draft = null, job = null, reader = null, album = null;
  function load() { try { const list = JSON.parse(ctx.win.localStorage.getItem(KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } }
  function save() { try { ctx.win.localStorage.setItem(KEY, JSON.stringify(drafts.slice(0, 30))); } catch { ctx.notify('这台设备存不下漫画草稿了', {error: true}); } }
  const cfg = () => normalizeComic(api.getState().comic);
  const infoOf = () => { try { return api.bookInfo?.() || null; } catch { return null; } };
  const rowsOf = info => { try { return api.bookMessages?.() || []; } catch { return []; } };
  const routes = () => api.readState?.().routes || api.getState().routes;
  const roleNames = () => [...new Set([...routes().map(r => r.name), ...(infoOf()?.roles || [])])].filter(Boolean);
  const drawn = d => d.pages.filter(p => p.photo).length;
  const safe = d => (d.title || '漫画').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30) || '漫画';
  function newForm() { form = {...bookForm(infoOf()), pages: cfg().pagesEach, how: 'auto', title: ''}; if (form.kind === 'theater') form.kind = infoOf()?.length ? 'chat' : 'paste'; }

  // ---------- pictures ----------
  /** The page as it is read: the drawn picture with the words laid on (kept per page until it is drawn again). */
  async function pageUrl(d, i) {
    const p = d.pages[i];
    if (!p.photo) return '';
    const key = d.id + ':' + i + ':' + p.photo + ':' + JSON.stringify(canvasOptions(cfg()));
    if (urls.has(key)) return urls.get(key);
    const photo = await api.getPhoto(p.photo).catch(() => null);
    if (!photo?.blob) return '';
    const url = ctx.win.URL.createObjectURL(await composePage(photo.blob, p, {doc: ctx.doc, ...canvasOptions(cfg())}));
    urls.set(key, url);
    return url;
  }
  async function pageBlob(d, i) {
    const photo = await api.getPhoto(d.pages[i].photo);
    if (!photo?.blob) throw Error('第 ' + (i + 1) + ' 页的图不在相册里了');
    return composePage(photo.blob, d.pages[i], {doc: ctx.doc, ...canvasOptions(cfg())});
  }

  // ---------- the shelf ----------
  function shelf() {
    view = 'shelf'; draft = null; form = null;
    const card = d => {
      const n = d.pages.length, m = drawn(d);
      return `<button type="button" class="bk-card cm-card" data-cm-open="${esc(d.id)}" aria-label="${esc(d.title)}"><span class="bk-mini cm-cover"><b>${esc(d.title)}</b><i>${m}/${n} 页</i></span><span class="bk-badge">${d.shelved ? '已放进书架 · ' : ''}${n} 页${m < n ? ` · 差 ${n - m} 页没画` : ''}</span></button>`;
    };
    v.draw(heading('漫画', help('把酒馆里的故事做成漫画：文字模型先写分镜（每页几格、每格画什么、说什么），页面先在这里排出来；再用绘图 App 一页页画（自动画，或自己一页页点），对白由插件叠在图上。画完的漫画放进书架里读。\n做好的部分随时存着：中途停下，之后在漫画里接着画。草稿存在这台设备的浏览器里；图存在相册里。') + btn('cm-settings', icon('settings') + '设置', 'chip-button') + (drafts.length ? btn('cm-new', icon('add') + '做一本', 'chip-button') : ''), 'Comic')
      + `<div class="bk-shelf">${drafts.length ? drafts.map(card).join('') : btn('cm-new', icon('add') + '<span>做一本漫画</span>', 'bk-new')}</div>`);
  }

  // ---------- 设置 ----------
  const presetChoices = c => [['', c.presets.length ? '（不用预设）' : '（还没有预设）'], ...c.presets.map(p => [p.id, p.name])];
  const store = next => { try { api.saveComic(next); } catch (e) { ctx.notify(e.message, {error: true}); } };
  // ---------- 漫画预设: like the 绘图预设, a list of entries, each switched on or off and edited as text ----------
  let editing = null;
  function editPreset(preset) { editing = structuredClone(preset); presetEditor(); }
  function presetEditor() {
    view = 'preset'; draft = null; form = null;
    const p = editing, last = p.entries.length - 1;
    const entry = (e, i) => `<div class="group pad cm-entry">
        <div class="setting-row"><span class="switch-label">启用这一条</span><input class="switch" aria-label="启用这一条" type="checkbox" data-cm-entry="enabled" data-i="${i}"${e.enabled ? ' checked' : ''}></div>
        <div class="field"><span>标题</span><input data-cm-entry="title" data-i="${i}" value="${esc(e.title)}" maxlength="80" placeholder="这一条是什么"></div>
        <div class="field"><span>发给谁${help('给分镜的要求：写分镜时发给文字模型，比如镜头、节奏、对白怎么写。画面前缀：加在每一页画面提示词的最前面。负面词：加进每一页的负面提示词。')}</span>${select('cm-entry-to', e.to, COMIC_ENTRY_TO, `data-cm-entry="to" data-i="${i}"`)}</div>
        <div class="field"><span>内容</span><textarea rows="7" data-cm-entry="text" data-i="${i}" placeholder="写在这里">${esc(e.text)}</textarea></div>
        <div class="actions">${i > 0 ? btn('cm-entry-up', '上移', 'secondary', `data-i="${i}"`) : ''}${i < last ? btn('cm-entry-down', '下移', 'secondary', `data-i="${i}"`) : ''}${btn('cm-entry-del', '删除这一条', 'secondary', `data-i="${i}"`)}</div></div>`;
    v.draw(heading('编辑漫画预设', help('一条一条写分镜和出图的要求，每条可以单独开关；使用中的预设里打开的条目，会在每次写分镜、每次出图时加进去。可以导出成文件，也可以把文件交给 AI 改好再导入。'), 'Comic Preset')
      + `<div class="group pad bk-setup"><div class="field"><span>预设名</span><input data-cm-pname value="${esc(p.name)}" maxlength="60"></div></div>`
      + p.entries.map(entry).join('')
      + `<div class="actions">${btn('cm-entry-add', icon('add') + '加一条', 'secondary')}</div>
      <div class="actions"><button type="button" class="secondary" data-action="cm-preset-cancel">取消</button><button type="button" class="primary" data-action="cm-preset-save">保存并使用</button></div>`);
  }
  async function importPreset(file) {
    try { editPreset(readPresetFile(await file.text())); ctx.notify('读进来了，看一下再点「保存并使用」'); } catch (e) { ctx.notify(e.message, {error: true}); }
  }
  async function exportPreset() {
    const now = activePreset(cfg()); if (!now) return;
    try { ctx.notify('已导出 ' + await saveFile(ctx.doc, new Blob([presetFile(now)], {type: 'application/json'}), '漫画预设 ' + now.name)); } catch (e) { ctx.notify(e.message, {error: true}); }
  }
  async function deletePreset() {
    const now = activePreset(cfg()); if (!now || !await ctx.confirm('删除预设「' + now.name + '」？', '这个预设和它的条目会删掉。')) return;
    store(removePreset(cfg(), now.id)); settings();
  }
  const naiFields = c => {
    const n = c.nai, opt = (list, now) => list.map(([k, l]) => `<option value="${esc(k)}"${String(now ?? '') === String(k) ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const num = (k, label, attrs) => `<label class="cm-nai"><small>${label}</small><input type="number" data-cm-nai="${k}" value="${n[k] ?? ''}" placeholder="跟绘图" ${attrs}></label>`;
    const sel = (k, label, list) => `<label class="cm-nai"><small>${label}</small><span class="select"><select data-cm-nai="${k}">${opt([['', '跟绘图设置'], ...list], n[k])}</select></span></label>`;
    const engine = api.getState().draw?.engine;
    return `<div class="cm-nai-grid">${sel('model', '模型', NAI_MODELS.map(m => [m, NAI_MODEL_NAMES[m] || m]))}${num('steps', '步数', 'min="1" max="50" step="1"')}${num('scale', '提示词相关度 CFG', 'min="0" max="10" step="0.1"')}${num('cfgRescale', 'CFG Rescale', 'min="0" max="1" step="0.02"')}${sel('sampler', '采样器', NAI_SAMPLERS.map(m => [m, NAI_SAMPLER_NAMES[m] || m]))}${sel('schedule', '噪声调度', NAI_SCHEDULES.map(m => [m, m]))}</div>${engine && engine !== 'nai' ? '<small>绘图 App 现在用的不是 NovelAI，这几项暂时不生效。</small>' : ''}`;
  };
  function settings() {
    view = 'settings'; draft = null; form = null;
    const c = cfg();
    const seg = (key, list, now = c[key], wrap = '') => `<div class="segmented${wrap}">${list.map(([k, l]) => `<button type="button" data-cm-cfg="${key}" data-value="${k}" aria-pressed="${String(now) === String(k)}">${l}</button>`).join('')}</div>`;
    const styleNote = COMIC_STYLES.find(([k]) => k === c.style)?.[2] || '';
    v.draw(heading('漫画设置', '', 'Comic')
      + `<div class="group pad bk-setup">
        <div class="field"><span>漫画预设${help('出图和分镜的预设：一条一条的要求，每条可开关，写分镜、出图时加进去（和绘图预设一样的做法）。这里选使用哪一个；下面的色彩、分镜风格等选项照常生效，预设是在它们之上再加的。')}</span>${select('cm-preset', c.preset, presetChoices(c))}
          <div class="actions">${btn('cm-preset-new', '新建', 'secondary')}${c.preset ? btn('cm-preset-edit', '编辑', 'secondary') + btn('cm-preset-export', '导出', 'secondary') + btn('cm-preset-delete', '删除', 'secondary') : ''}<label class="chip-button">导入<input type="file" data-cm-import accept=".json,application/json,text/plain" hidden aria-label="选择漫画预设文件"></label></div></div>
        <div class="field"><span>阅读方式${help('看漫画时怎么翻。顶栏、底栏都是书架那一套，这里只换页面怎么动。阅读界面的「设置」里也能改。')}</span>${seg('reading', COMIC_READING, c.reading, ' cm-wrap')}</div>
        <div class="field"><span>阅读方向${help('从右往左：日漫的翻法。只对「翻页（书架）」生效：第 1 页在最右，往右滑是下一页；翻书、卡片堆、上下滑不受影响。')}</span>${seg('direction', COMIC_DIRECTIONS)}</div>
        <div class="field"><span>每次画几页${help('做一本漫画时「页数」栏的默认值。空：由文字模型按故事长短定。')}</span>${seg('pagesEach', COMIC_PAGES_EACH.map(k => [k, k || '自动']), c.pagesEach, ' cm-wrap')}</div>
        <div class="field"><span>每页几格${help('空：由文字模型定。单图单格、上下两格这两个分镜风格会固定格数，这一项就不管用。')}</span>${seg('perPage', COMIC_PER_PAGE.map(k => [k, k || '自动']), c.perPage, ' cm-wrap')}</div>
        <div class="field"><span>分镜变化${help('写进分镜要求里，决定各页的格数、景别是规整还是有起伏。')}</span>${seg('variety', COMIC_VARIETY.map(([k, l]) => [k, l]), c.variety, ' cm-wrap')}</div>
        <div class="field"><span>画面尺寸${help('每页图的方向。竖：竖版漫画页（默认）；跟绘图设置：用绘图 App 里设的宽高。')}</span>${seg('size', COMIC_SIZES, c.size, ' cm-wrap')}</div>
        <div class="field"><span>漫画画师串${help('加在每一页画面标签最前面的画师／画风标签。空：不加，用绘图 App 当前的画风。')}</span><textarea rows="2" data-cm-artist maxlength="500" placeholder="可以不写">${esc(c.artist)}</textarea></div>
        <div class="field"><span>画图参数${help('漫画自己用的 NovelAI 参数，不改绘图 App 里的。留空：用绘图 App 的。只有绘图 App 用 NovelAI 引擎时才生效。')}</span>${naiFields(c)}</div>
        <div class="field"><span>色彩${help('黑白：分镜里不写颜色，画图时加 monochrome、greyscale、screentone，并排除 color。')}</span>${seg('color', COMIC_COLORS)}</div>
        <div class="field"><span>分镜风格${help('影响文字模型怎么写分镜（每页几格、景别、节奏）。版式仍是插件固定的排法，斜切格、宽屏格画不出来。单图单格、上下两格会固定每页的格数。')}</span>${seg('style', COMIC_STYLES.map(([k, l]) => [k, l]), c.style, ' cm-wrap')}${styleNote ? `<small>${esc(styleNote)}</small>` : ''}</div>
        <div class="field"><span>对白语言${help('文字模型写分镜时，台词用这个语言。')}</span>${seg('lang', COMIC_LANGS)}</div>
        <div class="field"><span>对白字号</span>${seg('textSize', COMIC_TEXT_SIZES)}</div>
        <div class="field"><span>对白叠字${help('关掉：只出画面，不在图上叠对白（已画好的页也会不显示字）。')}</span>${seg('textHide', [[false, '显示'], [true, '隐藏']])}</div>
        <div class="field"><span>气泡形状</span>${seg('bubble', COMIC_BUBBLES)}</div>
        <div class="field"><span>额外要求${help('你自己写的分镜要求，原样加进文字模型的分镜请求里，比如「多用特写」「每页至少一格是全景」。最多 ' + COMIC_NOTE_MAX + ' 字。')}</span><textarea rows="4" data-cm-note maxlength="${COMIC_NOTE_MAX}" placeholder="可以不写">${esc(c.note)}</textarea></div>
        <div class="field"><span>页面留白${help('写进分镜要求和画图标签里，绘图模型会不会照做取决于模型。不指定：什么都不加。')}</span>${seg('gutter', COMIC_GUTTERS)}</div></div>
        <div class="actions"><button type="button" class="secondary" data-action="cm-shelf">返回</button></div>`);
  }

  // ---------- 做一本 ----------
  function make() {
    const info = infoOf();
    if (!form) newForm();
    view = 'make';
    if (form.chat !== (info?.chat ?? '')) { form.chat = info?.chat ?? ''; form.range = info?.length > 20 ? '20' : 'all'; }
    if (!info?.length && form.kind === 'chat') form.kind = 'paste';
    const rows = rowsOf(info), range = bookRange(info || {length: 0}, form);
    const seg = (key, list) => `<div class="segmented">${list.map(([k, l]) => `<button type="button" data-cm-set="${key}" data-value="${k}" aria-pressed="${form[key] === k}">${l}</button>`).join('')}</div>`;
    const source = form.kind === 'chat'
      ? field(info?.title || '当前剧情', '<button type="button" class="bk-range-preview" data-action="cm-range">' + rangeMarkup(rows, ...range) + '</button>')
      : field('故事正文', '<textarea rows="7" data-cm-field="text" maxlength="' + BOOK_TEXT_LIMIT + '" placeholder="粘贴要画成漫画的文字">' + esc(form.text) + '</textarea>');
    v.draw(heading('做一本漫画', '', 'New Comic')
      + `<div class="group pad bk-setup">
        <div class="field"><span>故事来源</span>${seg('kind', SOURCES)}</div>
        ${source}
        ${cfg().presets.length ? `<div class="field"><span>漫画预设${help('用哪一个漫画预设（一条条分镜、出图要求）。在右上角「设置」里新建、编辑。')}</span>${select('cm-make-preset', cfg().preset, presetChoices(cfg()))}</div>` : ''}
        <div class="field"><span>页数${help('不填：文字模型按故事长短定（' + COMIC_PAGES.min + '–' + COMIC_PAGES.max + ' 页）。填了：就画这么多页。高潮的地方会单独占一整页（一格大图），其余每页 2–6 格。')}</span><input data-cm-field="pages" type="number" inputmode="numeric" min="${COMIC_PAGES.min}" max="${COMIC_PAGES.max}" value="${esc(form.pages)}" placeholder="不填：按故事长短"></div>
        <div class="field"><span>出图${help('自动出图：分镜写好后，一页接一页地画，进度显示在页面上。手动出图：只排出页面，你想画哪一页就点那一页的「画」。两种都可以随时再画。')}</span>${seg('how', MODES)}</div>
        <div class="field"><span>漫画名（可以不填）</span><input data-cm-field="title" value="${esc(form.title)}" maxlength="40" placeholder="让文字模型起"></div></div>
        <div class="actions"><button type="button" class="secondary" data-action="cm-shelf">取消</button><button type="button" class="primary" data-action="cm-start">${icon('paint')}写分镜</button></div>`);
  }
  async function pickRange() {
    const info = infoOf(), range = bookRange(info || {length: 0}, form), rows = rowsOf(info);
    const chosen = await pickBookRange(ctx, rows, range, true);
    if (!chosen || info?.chat !== infoOf()?.chat) return;
    Object.assign(form, chosen);
    make();
  }
  function storyOf(source) {
    return source.messages.flatMap(m => m.steps.map(s => ((s.kind === 'say' && s.role) ? s.role + '：' : '') + (s.text || '')).filter(Boolean)).join('\n').trim();
  }
  /** Stage 1: the storyboard → the pages as placeholders. */
  async function start() {
    if (job) return;
    let story;
    try { story = storyOf(readBookSource(form, infoOf(), api, [], ctx.doc)); if (!story) throw Error('这一段没有可以画的文字'); } catch (e) { ctx.notify(e.message, {error: true}); return; }
    const count = Number(form.pages) > 0 ? clampPages(form.pages) : 0, how = form.how, title = form.title.trim();
    job = {stop: false}; view = 'board';
    v.draw(heading('正在写分镜', '', 'Storyboard') + `<div class="bk-progress"><b>文字模型在写分镜…</b><div class="bk-bar"><i style="width:35%"></i></div><small>写好后页面会先排出来，再画图。这一步没有进度条，要等文字模型写完。</small></div><div class="actions"><button type="button" class="secondary" data-action="cm-stop">取消</button></div>`);
    try {
      const request = comicRequest({story, names: roleNames(), pages: count, comic: cfg()});
      const reply = await api.bookWrite(request[0].content, request[1].content, {length: 3500});
      if (job.stop || v.disposed) return;
      const comic = parseComic(reply, {maxPages: count || undefined, comic: cfg()});
      draft = {id: 'c-' + Date.now().toString(36), title: title || comic.title || '漫画', at: Date.now(), how, pages: comic.pages};
      drafts.unshift(draft); save();
      job = null;
      work(draft);
      if (how === 'auto') drawAll();
    } catch (e) { job = null; ctx.notify(e.message, {error: true, logged: true}); if (view === 'board' && !draft) make(); }
  }

  // ---------- the pages ----------
  const stateOf = i => job?.current === i ? 'running' : job?.queue?.includes(i) ? 'waiting' : failures.has(draft?.id + ':' + i) ? 'failed' : '';
  async function work(d = draft) {
    view = 'work'; draft = d;
    const urlsOf = await Promise.all(d.pages.map((_, i) => pageUrl(d, i)));
    if (view !== 'work' || draft !== d || v.disposed) return;
    const n = d.pages.length, m = drawn(d), busy = !!job;
    const status = job ? `正在画第 ${(job.current ?? 0) + 1}/${n} 页 · 已画 ${m}/${n}${job.queue?.length ? ` · 还排着 ${job.queue.length} 页` : ''}` : `已画 ${m}/${n} 页`;
    const holder = (p, i) => {
      const rects = panelRects(p.panels.length, 200, 300);
      return `<span class="cm-sheet" style="aspect-ratio:2/3">${rects.map((r, k) => `<i class="cm-panel" style="left:${r.x / 2}%;top:${r.y / 3}%;width:${r.w / 2}%;height:${r.h / 3}%"><small>${esc((p.panels[k].lines || []).map(l => l.text).join(' ').slice(0, 40))}</small></i>`).join('')}</span>`;
    };
    const page = (p, i) => {
      const st = stateOf(i), src = urlsOf[i];
      return `<div class="cm-page" data-state="${st}"><div class="cm-pic">${src ? `<img src="${esc(src)}" alt="第 ${i + 1} 页">` : holder(p, i)}${st === 'running' ? '<em class="cm-busy">正在画…</em>' : ''}</div>
        <div class="cm-row"><b>第 ${i + 1} 页 · ${p.kind === 'splash' ? '高潮大图' : p.panels.length + ' 格'}</b><span>${st === 'running' ? '正在画' : st === 'waiting' ? '排队中' : st === 'failed' ? '没画成：' + esc(failures.get(draft.id + ':' + i) || '') : src ? '已画' : '没画'}</span>
        ${btn('cm-draw', src ? '重画' : '画', 'chip-button', `data-i="${i}"`)}</div></div>`;
    };
    v.draw(heading(d.title, '', 'Comic')
      + `<div class="bk-progress"><b>${esc(status)}</b><div class="bk-bar"><i style="width:${n ? Math.round(m / n * 100) : 0}%"></i></div></div>
      <div class="actions">${busy ? '<button type="button" class="secondary" data-action="cm-stop">停下</button>' : (m < n ? `<button type="button" class="primary" data-action="cm-all">${icon('paint')}自动画剩下的 ${n - m} 页</button>` : '')}
      ${m ? '<button type="button" class="primary" data-action="cm-read">阅读</button>' : ''}
      ${m && !busy ? `<button type="button" class="${m < n ? 'secondary' : 'primary'}" data-action="cm-shelve">放进书架${d.shelved ? '（更新）' : ''}</button>` : ''}
      ${d.shelved ? '<button type="button" class="secondary" data-action="cm-go">去书架</button>' : ''}</div>
      <div class="cm-pages">${d.pages.map(page).join('')}</div>
      <div class="actions"><button type="button" class="secondary" data-action="cm-delete">删除这本漫画</button></div>`);
  }
  /** One page drawn by the 绘图 App (people with their looks, 画风 as in the 绘图 App, a tall picture). */
  async function drawPage(d, i) {
    const p = d.pages[i], names = pageCharacters(p);
    const inputs = pictureInputs(api.getState(), {prompt: pageTags(p, cfg()), characters: names}, '');
    const state = api.getState(), word = comicSizeWord(cfg());
    inputs.params = {...inputs.params, ...(word ? sizeFor(inputs.params, word) : {})};
    const own = comicDrawParams(cfg(), state.draw?.engine);
    if (Object.keys(own).length) inputs.params = normalizeDrawParams({...inputs.params, ...own});
    inputs.negative = [inputs.negative, COMIC_NEGATIVE, comicTags(cfg()).negative].filter(Boolean).join(', ');
    const {names: _n, ...request} = inputs;
    const result = await api.generateImage({...request, allowPaid: true, name: '漫画-' + safe(d), key: `comic:${d.id}:${i}:${Date.now()}`, label: `漫画 · ${d.title} · 第 ${i + 1} 页`});
    p.photo = result.photoId;
    save();
  }
  /** Draws the pages in `list` one after another; a failed page is shown and the next one goes on. */
  async function run(d, list) {
    if (job) { ctx.notify('先等正在画的这页'); return; }
    job = {stop: false, queue: [...list], failed: {}, current: null};
    try {
      while (job.queue.length && !job.stop && !v.disposed) {
        const i = job.queue.shift(); job.current = i; if (view === 'work' && draft === d) work(d);
        failures.delete(d.id + ':' + i);
        try { await drawPage(d, i); } catch (e) { job.failed[i] = e.message; failures.set(d.id + ':' + i, e.message); ctx.notify(`第 ${i + 1} 页没画成：${e.message}`, {error: true, logged: true}); }
        job.current = null;
        if (view === 'work' && draft === d) await work(d);
      }
    } finally { const failed = job?.failed || {}; job = null; if (view === 'work' && draft === d) { await work(d); } const bad = Object.keys(failed).length; if (bad) ctx.notify(`有 ${bad} 页没画成，点那一页的「画」再试`, {error: true}); }
  }
  const drawAll = () => run(draft, draft.pages.map((_, i) => i).filter(i => !draft.pages[i].photo));

  // ---------- to the shelf ----------
  async function shelve() {
    const d = draft, ids = d.pages.map((_, i) => i).filter(i => d.pages[i].photo);
    if (!ids.length) return;
    try {
      const files = [];
      for (let k = 0; k < ids.length; k++) { ctx.notify(`正在整理：${k + 1}/${ids.length} 页`); files.push({path: String(k + 1).padStart(3, '0') + '.png', bytes: new Uint8Array(await (await pageBlob(d, ids[k])).arrayBuffer())}); }
      const zip = writeZip(files), name = safe(d) + '.cbz', book = await openBook(zip, name, ctx.win.DOMParser);
      if (d.shelved) { try { await api.deleteReadingBook(d.shelved); } catch { /* the old copy was already gone */ } }
      const saved = await api.addReadingBook({name, title: d.title, author: '小手机', type: book.type, estimatedPages: book.estimatedPages, chapters: book.chapters.map(c => c.image ? {title: c.title, source: c.source, image: c.image} : {title: c.title})}, zip, book.cover ? await book.image(book.cover) : null);
      d.shelved = saved?.id || true; save();
      ctx.notify(ids.length < d.pages.length ? `放进书架了（${ids.length}/${d.pages.length} 页，没画的页没有放）` : '放进书架了');
      await work(d);
    } catch (e) { ctx.notify(e.message, {error: true, logged: true}); }
  }

  // ---------- events ----------
  v.on('click', '[data-action=cm-new]', () => { newForm(); make(); });
  v.on('click', '[data-action=cm-shelf]', () => shelf());
  v.on('click', '[data-action=cm-settings]', () => settings());
  v.on('click', '[data-action=cm-preset-new]', () => editPreset(newPreset()));
  v.on('click', '[data-action=cm-preset-edit]', () => { const now = activePreset(cfg()); if (now) editPreset(now); });
  v.on('click', '[data-action=cm-preset-export]', exportPreset);
  v.on('click', '[data-action=cm-preset-delete]', deletePreset);
  v.on('click', '[data-action=cm-preset-cancel]', () => { editing = null; settings(); });
  v.on('click', '[data-action=cm-preset-save]', () => { try { store(savePreset(cfg(), editing)); editing = null; settings(); } catch (e) { ctx.notify(e.message, {error: true}); } });
  v.on('click', '[data-action=cm-entry-add]', () => { editing.entries.push({id: 'cp-' + Date.now().toString(36) + editing.entries.length, title: '', enabled: true, to: 'story', text: ''}); presetEditor(); });
  v.on('click', '[data-action=cm-entry-del]', el => { editing.entries.splice(Number(el.dataset.i), 1); presetEditor(); });
  v.on('click', '[data-action=cm-entry-up]', el => { const i = Number(el.dataset.i), e = editing.entries; [e[i - 1], e[i]] = [e[i], e[i - 1]]; presetEditor(); });
  v.on('click', '[data-action=cm-entry-down]', el => { const i = Number(el.dataset.i), e = editing.entries; [e[i + 1], e[i]] = [e[i], e[i + 1]]; presetEditor(); });
  v.on('change', '[data-field=cm-preset]', el => { store({...cfg(), preset: el.value}); settings(); });
  v.on('change', '[data-cm-import]', el => { const f = el.files?.[0]; el.value = ''; if (f) importPreset(f); });
  v.root.addEventListener('input', e => {
    if (!editing || view !== 'preset') return;
    const t = e.target;
    if (t.dataset?.cmPname !== undefined) editing.name = t.value;
    else if (t.dataset?.cmEntry) editing.entries[Number(t.dataset.i)][t.dataset.cmEntry] = t.dataset.cmEntry === 'enabled' ? t.checked : t.value;
  });
  v.root.addEventListener('change', e => { const t = e.target; if (editing && view === 'preset' && t.dataset?.cmEntry) editing.entries[Number(t.dataset.i)][t.dataset.cmEntry] = t.dataset.cmEntry === 'enabled' ? t.checked : t.value; });
  v.on('change', '[data-cm-note]', el => { store({...cfg(), note: el.value}); settings(); });
  v.on('change', '[data-field=cm-make-preset]', el => { store({...cfg(), preset: el.value}); make(); });
  v.on('change', '[data-cm-nai]', el => { const k = el.dataset.cmNai, nai = {...cfg().nai}; if (el.value === '') delete nai[k]; else nai[k] = el.type === 'number' ? Number(el.value) : el.value; store({nai}); settings(); });
  v.on('change', '[data-cm-artist]', el => { store({artist: el.value}); });
  v.on('click', '[data-cm-cfg]', el => { try { api.saveComic({[el.dataset.cmCfg]: el.dataset.cmCfg === 'textHide' ? el.dataset.value === 'true' : el.dataset.value}); } catch (e) { ctx.notify(e.message, {error: true}); } settings(); });
  v.on('click', '[data-action=cm-range]', pickRange);
  v.on('click', '[data-action=cm-start]', start);
  v.on('click', '[data-action=cm-stop]', () => { if (job) { job.stop = true; job.queue = []; } if (view === 'board') { job = null; make(); } ctx.notify('画完这一页就停'); });
  v.on('click', '[data-action=cm-all]', drawAll);
  v.on('click', '[data-action=cm-draw]', el => { if (draft) run(draft, [Number(el.dataset.i)]); });
  v.on('click', '[data-action=cm-shelve]', shelve);
  // ---------- 阅读: the 书架's way (ui/album-viewer.js: a page full screen, swipe, 目录 / 书签 / 设置 on the bar) ----------
  const marksOf = d => Array.isArray(d.marks) ? d.marks : (d.marks = []);
  const closeReading = () => { const a = album; album = reader = null; a?.close(); };
  const readingOpen = () => !!album?.open;
  /** Opens the comic of `d` at page `at` (an index among the drawn pages), the way 漫画设置 says (阅读方式 / 阅读方向 / 字幕). */
  async function read(at = 0, d = draft) {
    if (!d || readingOpen()) return;
    const ids = d.pages.map((_, i) => i).filter(i => d.pages[i].photo), mode = cfg().reading, rtl = cfg().direction === 'rtl' && mode === 'page';
    if (!ids.length) { ctx.notify('还没有画好的页'); return; }
    at = Math.max(0, Math.min(ids.length - 1, at));
    const order = rtl ? ids.map((_, n) => ids.length - 1 - n) : ids.map((_, n) => n);   // positions in the album → logical page n
    const now = () => reader ? reader.at : order[album?.index ?? 0] ?? at;
    const again = n => { closeReading(); read(n, d); };
    const toc = () => {
      const dlg = ctx.dialog('目录与书签', ids.map((page, n) => `<button type="button" class="bs-row-link" data-cm-go="${n}"><strong>第 ${n + 1} 页${marksOf(d).includes(page) ? ' ★' : ''}</strong><small>${d.pages[page].kind === 'splash' ? '高潮大图' : d.pages[page].panels.length + ' 格'}</small></button>`).join(''));
      dlg.body.addEventListener('click', e => { const b = e.target.closest('[data-cm-go]'); if (!b) return; dlg.close(); again(Number(b.dataset.cmGo)); });
    };
    const bookmark = () => {
      const page = ids[now()], marks = marksOf(d), found = marks.indexOf(page);
      if (found < 0) marks.push(page); else marks.splice(found, 1);
      save(); ctx.notify(found < 0 ? '已加书签' : '已移除书签');
    };
    const options = () => {
      const c = cfg();
      const seg = (key, list, cur) => `<div class="segmented">${list.map(([k, l]) => `<button type="button" data-cm-opt="${key}" data-value="${k}" aria-pressed="${String(cur) === String(k)}">${l}</button>`).join('')}</div>`;
      const dlg = ctx.dialog('阅读设置', field('阅读方式', seg('reading', COMIC_READING, c.reading)) + field('阅读方向', seg('direction', COMIC_DIRECTIONS, c.direction)) + field('对白字幕', seg('textHide', [['false', '显示'], ['true', '隐藏']], String(c.textHide))));
      dlg.body.addEventListener('click', e => {
        const b = e.target.closest('[data-cm-opt]'); if (!b) return;
        const at = now(); store({[b.dataset.cmOpt]: b.dataset.cmOpt === 'textHide' ? b.dataset.value === 'true' : b.dataset.value}); dlg.close(); again(at);
      });
    };
    album = openAlbum({ctx, host: v.root.closest('.screen') || v.root, ids: order.map(n => String(ids[n])), index: rtl ? ids.length - 1 - at : at, preload: true,
      load: async id => ({blob: await pageBlob(d, Number(id)), name: '第 ' + (ids.indexOf(Number(id)) + 1) + ' 页'}),
      onPullDown: bookmark, onClose: () => { album = null; reader = null; },
      actions: [{key: 'toc', icon: 'book', label: '目录', run: toc}, {key: 'bookmark', icon: 'star', label: '书签', run: bookmark}, {key: 'settings', icon: 'sliders', label: '设置', run: options}]});
    const mine = album;
    mine.root.setAttribute('aria-label', d.title); mine.root.querySelector('[data-av=close]').setAttribute('aria-label', '返回漫画');
    const slider = ctx.doc.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(ids.length - 1); slider.value = String(at); slider.setAttribute('aria-label', '漫画进度'); slider.className = 'reading-comic-progress';
    if (rtl) {
      slider.style.direction = 'rtl';
      // The album counts its own row (the last page first); the page number shown is the comic's.
      const num = mine.root.querySelector('[data-av-count]'), fix = () => { const t = `${now() + 1} / ${ids.length}`; if (num.textContent !== t) num.textContent = t; };
      new ctx.win.MutationObserver(fix).observe(num, {childList: true, characterData: true, subtree: true}); fix();
    }
    slider.onchange = () => { if (!reader) again(Number(slider.value)); };
    slider.oninput = () => { if (reader) reader.setAt(Number(slider.value)); };
    mine.root.querySelector('.album-bar').before(slider);
    if (mode !== 'page') {
      try {
        const urls = await Promise.all(ids.map(i => pageUrl(d, i)));
        if (album !== mine || !mine.open) return;
        reader = mountReader(mine.root, {mode, urls, at, onAt: n => { slider.value = String(n); }});
      } catch (e) { ctx.notify(e.message, {error: true, logged: true}); }
    }
  }
  v.on('click', '[data-action=cm-read]', () => read(0));
  /** From the tavern page (the 楼层 menu's 画成漫画): the making form with that message and page count filled in. */
  v.makeFrom = (id, pages) => {
    if (job) { ctx.notify('先等正在画的这本'); return; }
    newForm();
    if (!infoOf()?.length) { ctx.notify('先在酒馆选好一段剧情', {error: true}); return; }
    Object.assign(form, {kind: 'chat', range: 'pick', from: id, to: id, pages: Number(pages) > 0 ? String(pages) : ''});
    make();
  };
  v.on('click', '[data-action=cm-go]', () => ctx.open('bookshelf'));
  v.on('click', '[data-action=cm-delete]', async () => {
    if (!draft || !await ctx.confirm('删除这本漫画？', '草稿会删掉；相册里画好的图和书架里的那一本不动。')) return;
    drafts = drafts.filter(x => x !== draft); save(); shelf();
  });
  v.on('click', '[data-cm-open]', el => { const d = drafts.find(x => x.id === el.dataset.cmOpen); if (d) work(d); });
  v.on('click', '[data-cm-set]', el => { form[el.dataset.cmSet] = el.dataset.value; make(); });
  v.root.addEventListener('input', e => { const f = e.target.dataset?.cmField; if (form && f) form[f] = e.target.value; });
  v.back = () => { if (readingOpen()) { closeReading(); return true; } if (view === 'preset') { editing = null; settings(); return true; } if (view === 'shelf') return false; if (view === 'board') { if (job) job.stop = true; return true; } shelf(); return true; };
  v.refresh = () => { if (view === 'shelf') shelf(); };
  const dispose = v.dispose;
  v.dispose = () => { closeReading(); if (job) { job.stop = true; job.queue = []; } for (const u of urls.values()) ctx.win.URL.revokeObjectURL(u); dispose(); };
  shelf();
  return v;
}
