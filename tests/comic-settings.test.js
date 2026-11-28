import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeComic, defaultComic, comicRules, comicTags, fixedPanels, canvasOptions, savePreset, newPreset, removePreset, presetFile, readPresetFile} from '../core/comic-settings.js';
import {comicRequest, parseComic, pageTags} from '../core/comic.js';

const board = n => JSON.stringify({pages: [{kind: 'page', panels: Array.from({length: n}, (_, i) => ({scene: 's' + i, who: [], lines: []}))}, {kind: 'splash', panels: [{scene: 'big', who: [], lines: []}]}]});

test('defaults change nothing: the request and tags are as before the settings existed', () => {
  assert.deepEqual(defaultComic(), {color: 'full', style: 'general', lang: 'zh', textSize: 'auto', textHide: false, bubble: 'round', gutter: 'none', size: 'portrait', artist: '', nai: {}, pagesEach: '', perPage: '', variety: 'normal', direction: 'ltr', reading: 'page', defaultOn: {}, drawStyle: '', stripNeg: true, note: '', preset: '', presets: [], textModel: ''});
  assert.deepEqual(comicRules(null), []);
  assert.deepEqual(comicTags(null), {tags: '', negative: ''});
  assert.equal(comicRequest({story: 'x'})[0].content, comicRequest({story: 'x', comic: defaultComic()})[0].content);
  assert.match(comicRequest({story: 'x'})[0].content, /text 用中文/);
});
test('normalizeComic drops what is not an option', () => {
  assert.deepEqual(normalizeComic({color: 'pink', style: 'nope', lang: 'fr', textSize: 9, textHide: 'yes', bubble: 'star', gutter: 7, note: 5, preset: 'zz', presets: 'x'}), defaultComic());
  assert.equal(normalizeComic({color: 'mono', textHide: true}).textHide, true);
  assert.deepEqual(normalizeComic(undefined), defaultComic());
});
test('mono, style, language and gutter reach the request and the tags', () => {
  const sys = comicRequest({story: 'x', comic: {color: 'mono', style: 'shonen', lang: 'ja', gutter: 'black'}})[0].content;
  assert.match(sys, /黑白漫画/); assert.match(sys, /少年热血/); assert.match(sys, /text 用日语/); assert.match(sys, /页面留白/);
  const page = parseComic(board(2)).pages[0];
  assert.match(pageTags(page, {color: 'mono', gutter: 'black'}), /^monochrome, greyscale, screentone, black border/);
  assert.equal(comicTags({color: 'mono'}).negative, 'color, colorful');
});
test('单图单格 and 上下两格 fix the panels of every page', () => {
  assert.equal(fixedPanels({style: 'single'}), 1); assert.equal(fixedPanels({style: 'two'}), 2); assert.equal(fixedPanels({style: 'koma'}), 0);
  const one = parseComic(board(4), {comic: {style: 'single'}});
  assert.deepEqual(one.pages.map(p => [p.kind, p.panels.length]), [['splash', 1], ['splash', 1]]);
  const two = parseComic(board(4), {comic: {style: 'two'}});
  assert.deepEqual(two.pages.map(p => [p.kind, p.panels.length]), [['page', 2], ['page', 1]]);
  assert.deepEqual(parseComic(board(4)).pages.map(p => [p.kind, p.panels.length]), [['page', 4], ['splash', 1]]);
});
test('canvasOptions', () => assert.deepEqual(canvasOptions({textSize: 'large', textHide: true, bubble: 'oval'}), {textSize: 'large', hide: true, bubble: 'oval', rtl: false}));

test('单图单格 / 上下两格: the request no longer also says "2–6 格 / splash 一成"', () => {
  const sys = comicRequest({story: 'x', comic: {style: 'single'}})[0].content;
  assert.doesNotMatch(sys, /2 到 6 格/); assert.doesNotMatch(sys, /splash 不超过/); assert.match(sys, /页面形式/);
  assert.match(comicRequest({story: 'x', comic: {style: 'koma'}})[0].content, /2 到 6 格/);
});
test('额外要求 reaches the request', () => {
  assert.match(comicRequest({story: 'x', comic: {note: '多用特写'}})[0].content, /额外要求.*多用特写/);
  assert.equal(normalizeComic({note: 'a'.repeat(3000)}).note.length, 2000);
});
test('presets are lists of entries: save, edit, switch off, remove', () => {
  let c = normalizeComic({});
  const made = newPreset('我的分镜'); made.entries.length = 1; made.entries[0].title = '分镜要求'; made.entries[0].text = '多用特写'; delete made.replace;
  made.entries.push({id: 'e2', title: '前缀', enabled: true, to: 'tags', text: 'masterpiece, '}, {id: 'e3', title: '负面', enabled: true, to: 'negative', text: 'text'}, {id: 'e4', title: '关着', enabled: false, to: 'story', text: '不会发'});
  c = savePreset(c, made);
  assert.equal(c.preset, made.id); assert.equal(c.presets[0].entries.length, 4);
  const rules = comicRules(c).join('\n');
  assert.match(rules, /【分镜要求】\n多用特写/); assert.doesNotMatch(rules, /不会发/);
  assert.equal(comicTags(c).tags, 'masterpiece'); assert.equal(comicTags(c).negative, 'text');
  const again = structuredClone(c.presets[0]); again.entries[0].enabled = false;
  c = savePreset(c, again); assert.equal(c.presets.length, 1); assert.doesNotMatch(comicRules(c).join(''), /多用特写/);
  c = removePreset(c, made.id); assert.deepEqual([c.presets.length, c.preset], [0, '']);
});
test('a preset file: out and back (new id), bare preset, wrong kind, empty', () => {
  const p = newPreset('导出'); p.entries.length = 1; p.entries[0].text = '写得紧凑';
  const back = readPresetFile(presetFile(p));
  assert.equal(back.name, '导出'); assert.notEqual(back.id, p.id); assert.equal(back.entries[0].text, '写得紧凑');
  assert.equal(JSON.parse(presetFile(p)).kind, 'comic');
  assert.equal(readPresetFile(JSON.stringify({name: 'x', entries: [{text: 'a'}]})).entries.length, 1);
  assert.throws(() => readPresetFile(JSON.stringify({format: 'st-iphonie-preset', kind: 'draw', preset: {entries: [{text: 'a'}]}})), /不是漫画预设/);
  assert.throws(() => readPresetFile('{"entries":[]}'), /没有预设的条目/);
  assert.throws(() => readPresetFile('nope'), /JSON/);
});
test('a preset in saved settings that is broken is cleaned up', () => {
  const c = normalizeComic({preset: 'a', presets: [{id: 'a', name: '', entries: [{text: 5}, {title: 't', to: 'zz', text: 'ok'}]}, {id: 'a', name: 'dup'}, null, {name: 'noid'}]});
  assert.equal(c.presets.length, 1); assert.equal(c.presets[0].name, '未命名'); assert.equal(c.preset, 'a');
  assert.deepEqual(c.presets[0].entries.map(e => [e.to, e.text]), [['story', ''], ['story', 'ok']]);
});

test('new options: unknown values drop, comic-own NovelAI parameters keep only given numbers/words, they reach tags and rules', async () => {
  const m = await import('../core/comic-settings.js');
  const c = m.normalizeComic({size: 'x', reading: 'y', direction: 'z', perPage: '9', pagesEach: '5', variety: 'q', nai: {steps: '28', scale: '', model: 'nai-diffusion-4-5-full', bad: 1, cfgRescale: 'abc'}});
  assert.equal(c.size, 'portrait'); assert.equal(c.reading, 'page'); assert.equal(c.direction, 'ltr'); assert.equal(c.perPage, ''); assert.equal(c.pagesEach, ''); assert.equal(c.variety, 'normal');
  assert.deepEqual(c.nai, {steps: 28, model: 'nai-diffusion-4-5-full'});
  assert.deepEqual(m.comicDrawParams(c, 'nai'), c.nai); assert.deepEqual(m.comicDrawParams(c, 'comfy'), {});
  assert.equal(m.comicSizeWord({size: 'follow'}), ''); assert.equal(m.comicSizeWord({size: 'landscape'}), '横');
  assert.match(m.comicTags({artist: 'artist:foo, '}).tags, /^artist:foo$/);
  assert.ok(m.comicRules({perPage: '4', variety: 'bold'}).some(r => /每页 4 格/.test(r)) && m.comicRules({variety: 'bold'}).some(r => /大胆/.test(r)));
  assert.ok(!m.comicRules({style: 'single', perPage: '4'}).some(r => /每页 4 格/.test(r)));
});

test('默认分镜预设: the default entries make the request; a copy stands in for them; direction rtl reaches rules, tags, rects', async () => {
  const m = await import('../core/comic-settings.js'), k = await import('../core/comic.js');
  const base = k.comicRequest({story: 'x'})[0].content;
  for (const e of m.DEFAULT_COMIC_ENTRIES.filter(e => e.enabled)) assert.ok(base.includes(e.text.split('{')[0].slice(0, 12)), e.id);
  const mine = m.newPreset('改'); mine.entries.find(e => e.title === '镜头变化').text = '全部用特写'; 
  const c = m.savePreset({}, mine);
  const req = k.comicRequest({story: 'x', comic: c})[0].content;
  assert.match(req, /全部用特写/); assert.doesNotMatch(req, /远景、近景、特写交替/);
  const off = structuredClone(c.presets[0]); off.entries.forEach(e => { if (e.title === '页面版式') e.enabled = false; });
  assert.doesNotMatch(k.comicRequest({story: 'x', comic: m.savePreset(c, off)})[0].content, /splash/);
  const rtl = {direction: 'rtl'};
  assert.match(k.comicRequest({story: 'x', comic: rtl})[0].content, /从右往左/);
  assert.match(k.pageTags({kind: 'page', panels: [{scene: 'a'}, {scene: 'b'}]}, rtl), /right to left/);
  const l = k.panelRects(4, 100, 100), r = k.panelRects(4, 100, 100, 0.02, true);
  assert.ok(l[0].x < l[1].x && r[0].x > r[1].x); assert.ok(Math.abs(l[0].x - (100 - r[0].x - r[0].w)) < 1e-9);
});

test('默认分镜预设 switches: grouped, one pacing style at a time, kept in comic.defaultOn, copies keep the switches', async () => {
  const m = await import('../core/comic-settings.js'), k = await import('../core/comic.js');
  assert.ok(m.DEFAULT_COMIC_ENTRIES.every(e => m.COMIC_GROUPS.some(g => g[0] === e.group) && e.desc));
  assert.equal(m.defaultEntries({}).filter(e => e.group === 'pacing' && e.enabled).length, 0);
  let list = m.setEntryOn(m.defaultEntries({}), 'p-daily', true); list = m.setEntryOn(list, 'p-action', true);
  assert.deepEqual(list.filter(e => e.group === 'pacing' && e.enabled).map(e => e.id), ['p-action']);
  assert.equal(list.find(e => e.id === 'grammar').enabled, true);   // other groups are left as they are
  const c = m.normalizeComic({defaultOn: Object.fromEntries(list.map(e => [e.id, e.enabled]).concat([['nope', true]]))});
  assert.ok(!('nope' in c.defaultOn));
  assert.match(k.comicRequest({story: 'x', comic: c})[0].content, /少年热血/); assert.doesNotMatch(k.comicRequest({story: 'x', comic: c})[0].content, /轻松日常/);
  assert.equal(m.newPreset('x', c).entries.find(e => e.id.length && e.title === '少年热血').enabled, true);
  const off = m.normalizeComic({defaultOn: {s_x: 1, grammar: false}}); assert.doesNotMatch(k.comicRequest({story: 'x', comic: off})[0].content, /主格/);
});

test('per-page ranges, comic-only strip of negative words that undo the layout', async () => {
  const m = await import('../core/comic-settings.js'), k = await import('../core/comic.js');
  assert.equal(m.normalizeComic({perPage: '3-4'}).perPage, '3-4'); assert.equal(m.normalizeComic({perPage: '7-9'}).perPage, '');
  assert.ok(m.comicRules({perPage: '3-4'}).some(r => /每页 3-4 格/.test(r)));
  assert.equal(m.normalizeComic({stripNeg: false}).stripNeg, false); assert.equal(m.normalizeComic({}).stripNeg, true);
  assert.equal(k.stripComicNegative('lowres, 1.2::border::, Comic Panel, margins, bad hands'), 'lowres, bad hands');
  assert.equal(k.stripComicNegative('lowres, monochrome, screentone', {mono: true}), 'lowres'); assert.equal(k.stripComicNegative('lowres, monochrome'), 'lowres, monochrome');
  assert.equal(k.stripComicNegative('text, speech bubble'), 'text, speech bubble');
});
