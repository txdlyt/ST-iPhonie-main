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
import {openComicReader} from './comic-reader.js';
import {COMIC_COLORS, COMIC_STYLES, COMIC_LANGS, COMIC_TEXT_SIZES, COMIC_BUBBLES, COMIC_GUTTERS, COMIC_NOTE_MAX, normalizeComic, comicTags, canvasOptions, applyPreset, savePreset, removePreset, presetChanged} from '../core/comic-settings.js';
import {bookRange, rangeMarkup, pickBookRange, readBookSource, bookForm, BOOK_SOURCES, BOOK_TEXT_LIMIT} from './book-setup.js';

const KEY = 'stiphonie.comic.drafts';
const MODES = [['auto', '自动出图'], ['hand', '手动出图']];
const SOURCES = BOOK_SOURCES.filter(([k]) => k !== 'theater');

export function comicApp(ctx) {
  const {api} = ctx, v = createView(ctx, 'comic'), urls = new Map(), failures = new Map();
  let view = 'shelf', drafts = load(), form = null, draft = null, job = null, reader = null;
  function load() { try { const list = JSON.parse(ctx.win.localStorage.getItem(KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } }
  function save() { try { ctx.win.localStorage.setItem(KEY, JSON.stringify(drafts.slice(0, 30))); } catch { ctx.notify('这台设备存不下漫画草稿了', {error: true}); } }
  const cfg = () => normalizeComic(api.getState().comic);
  const infoOf = () => { try { return api.bookInfo?.() || null; } catch { return null; } };
  const rowsOf = info => { try { return api.bookMessages?.() || []; } catch { return []; } };
  const routes = () => api.readState?.().routes || api.getState().routes;
  const roleNames = () => [...new Set([...routes().map(r => r.name), ...(infoOf()?.roles || [])])].filter(Boolean);
  const drawn = d => d.pages.filter(p => p.photo).length;
  const safe = d => (d.title || '漫画').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 30) || '漫画';
  function newForm() { form = {...bookForm(infoOf()), pages: '', how: 'auto', title: ''}; if (form.kind === 'theater') form.kind = infoOf()?.length ? 'chat' : 'paste'; }

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
  const presetChoices = c => [['', c.presets.length ? '（不用预设）' : '（还没有预设）'], ...c.presets.map(p => [p.id, p.name + (p.id === c.preset && presetChanged(c) ? '（已改动）' : '')])];
  const store = next => { try { api.saveComic(next); } catch (e) { ctx.notify(e.message, {error: true}); } };
  /** A small dialog asking for a name; resolves to the name, or null when closed. */
  function askName(title, value = '') {
    const d = ctx.dialog(title, `<div class="field"><span>名字</span><input data-cm-name value="${esc(value)}" maxlength="30"></div><div class="actions"><button type="button" class="primary" data-cm-name-ok>存好</button></div>`);
    return new Promise(resolve => {
      let answer = null;
      d.onClose(() => resolve(answer));
      d.body.querySelector('[data-cm-name-ok]').addEventListener('click', () => { answer = d.body.querySelector('[data-cm-name]').value.trim(); if (!answer) { ctx.notify('先给预设起个名字'); return; } d.close(); });
    });
  }
  async function presetAction(what) {
    const c = cfg(), now = c.presets.find(p => p.id === c.preset);
    try {
      if (what === 'new') { const name = await askName('存为新预设'); if (name) store(savePreset(c, {name})); }
      else if (what === 'update' && now) { store(savePreset(c, {id: now.id})); ctx.notify('预设「' + now.name + '」已更新'); }
      else if (what === 'rename' && now) { const name = await askName('预设改名', now.name); if (name) store({...c, presets: c.presets.map(p => p.id === now.id ? {...p, name} : p)}); }
      else if (what === 'delete' && now) { if (!await ctx.confirm('删除预设「' + now.name + '」？', '现在用着的设置不变，只是这个预设没了。')) return; store(removePreset(c, now.id)); }
    } catch (e) { ctx.notify(e.message, {error: true}); }
    if (view === 'settings') settings();
  }
  function settings() {
    view = 'settings'; draft = null; form = null;
    const c = cfg();
    const seg = (key, list, now = c[key], wrap = '') => `<div class="segmented${wrap}">${list.map(([k, l]) => `<button type="button" data-cm-cfg="${key}" data-value="${k}" aria-pressed="${String(now) === String(k)}">${l}</button>`).join('')}</div>`;
    const styleNote = COMIC_STYLES.find(([k]) => k === c.style)?.[2] || '';
    v.draw(heading('漫画设置', '', 'Comic')
      + `<div class="group pad bk-setup">
        <div class="field"><span>漫画预设${help('把下面这一整套（色彩、分镜风格、语言、字号、气泡、留白、额外要求）存成一个名字，之后一点就套用。套用后再改下面的选项，预设不会变，点「更新」才会存进去。')}</span>${select('cm-preset', c.preset, presetChoices(c))}
          <div class="actions">${btn('cm-preset-new', '存为新预设', 'secondary')}${c.preset ? btn('cm-preset-update', '更新这个预设', 'secondary') + btn('cm-preset-rename', '改名', 'secondary') + btn('cm-preset-delete', '删除', 'secondary') : ''}</div></div>
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
        ${cfg().presets.length ? `<div class="field"><span>漫画预设${help('用哪一套漫画设置（色彩、分镜风格、对白……）。在右上角「设置」里存预设。')}</span>${select('cm-make-preset', cfg().preset, presetChoices(cfg()))}</div>` : ''}
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
    inputs.params = {...inputs.params, ...sizeFor(inputs.params, '竖')};
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
  v.on('click', '[data-action=cm-preset-new]', () => presetAction('new'));
  v.on('click', '[data-action=cm-preset-update]', () => presetAction('update'));
  v.on('click', '[data-action=cm-preset-rename]', () => presetAction('rename'));
  v.on('click', '[data-action=cm-preset-delete]', () => presetAction('delete'));
  v.on('change', '[data-field=cm-preset]', el => { store(el.value ? applyPreset(cfg(), el.value) : {...cfg(), preset: ''}); settings(); });
  v.on('change', '[data-cm-note]', el => { store({...cfg(), note: el.value}); settings(); });
  v.on('change', '[data-field=cm-make-preset]', el => { store(el.value ? applyPreset(cfg(), el.value) : {...cfg(), preset: ''}); make(); });
  v.on('click', '[data-cm-cfg]', el => { try { api.saveComic({[el.dataset.cmCfg]: el.dataset.cmCfg === 'textHide' ? el.dataset.value === 'true' : el.dataset.value}); } catch (e) { ctx.notify(e.message, {error: true}); } settings(); });
  v.on('click', '[data-action=cm-range]', pickRange);
  v.on('click', '[data-action=cm-start]', start);
  v.on('click', '[data-action=cm-stop]', () => { if (job) { job.stop = true; job.queue = []; } if (view === 'board') { job = null; make(); } ctx.notify('画完这一页就停'); });
  v.on('click', '[data-action=cm-all]', drawAll);
  v.on('click', '[data-action=cm-draw]', el => { if (draft) run(draft, [Number(el.dataset.i)]); });
  v.on('click', '[data-action=cm-shelve]', shelve);
  function read() {
    const d = draft; if (!d || reader && !reader.closed) return;
    const ids = () => d.pages.map((_, i) => i).filter(i => d.pages[i].photo);
    reader = openComicReader(ctx, {title: d.title, parent: ctx.doc.body, load: async () => Promise.all(ids().map(i => pageUrl(d, i))),
      caption: {get: () => !cfg().textHide, set: on => store({...cfg(), textHide: !on})}});
  }
  v.on('click', '[data-action=cm-read]', read);
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
  v.back = () => { if (reader && !reader.closed) { reader.close(); return true; } if (view === 'shelf') return false; if (view === 'board') { if (job) job.stop = true; return true; } shelf(); return true; };
  v.refresh = () => { if (view === 'shelf') shelf(); };
  const dispose = v.dispose;
  v.dispose = () => { reader?.close(); if (job) { job.stop = true; job.queue = []; } for (const u of urls.values()) ctx.win.URL.revokeObjectURL(u); dispose(); };
  shelf();
  return v;
}
