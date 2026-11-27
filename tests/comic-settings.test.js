import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeComic, defaultComic, comicRules, comicTags, fixedPanels, canvasOptions, savePreset, applyPreset, removePreset, presetChanged, comicValues} from '../core/comic-settings.js';
import {comicRequest, parseComic, pageTags} from '../core/comic.js';

const board = n => JSON.stringify({pages: [{kind: 'page', panels: Array.from({length: n}, (_, i) => ({scene: 's' + i, who: [], lines: []}))}, {kind: 'splash', panels: [{scene: 'big', who: [], lines: []}]}]});

test('defaults change nothing: the request and tags are as before the settings existed', () => {
  assert.deepEqual(defaultComic(), {color: 'full', style: 'general', lang: 'zh', textSize: 'auto', textHide: false, bubble: 'round', gutter: 'none', note: '', preset: '', presets: []});
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
test('canvasOptions', () => assert.deepEqual(canvasOptions({textSize: 'large', textHide: true, bubble: 'oval'}), {textSize: 'large', hide: true, bubble: 'oval'}));

test('单图单格 / 上下两格: the request no longer also says "2–6 格 / splash 一成"', () => {
  const sys = comicRequest({story: 'x', comic: {style: 'single'}})[0].content;
  assert.doesNotMatch(sys, /2 到 6 格/); assert.doesNotMatch(sys, /splash 不超过/); assert.match(sys, /页面形式/);
  assert.match(comicRequest({story: 'x', comic: {style: 'koma'}})[0].content, /2 到 6 格/);
});
test('额外要求 reaches the request', () => {
  assert.match(comicRequest({story: 'x', comic: {note: '多用特写'}})[0].content, /额外要求.*多用特写/);
  assert.equal(normalizeComic({note: 'a'.repeat(3000)}).note.length, 2000);
});
test('presets: save, apply, change, overwrite, remove', () => {
  let c = normalizeComic({color: 'mono', style: 'shonen', note: '特写'});
  assert.throws(() => savePreset(c, {name: ' '}), /名字/);
  c = savePreset(c, {name: '热血黑白'});
  assert.equal(c.presets.length, 1); assert.equal(c.preset, c.presets[0].id); assert.equal(presetChanged(c), false);
  const id = c.preset;
  c = normalizeComic({...c, color: 'full', lang: 'ja'});
  assert.equal(presetChanged(c), true);
  c = applyPreset(c, id);
  assert.deepEqual([c.color, c.style, c.lang, c.note], ['mono', 'shonen', 'zh', '特写']); assert.equal(presetChanged(c), false);
  c = savePreset(normalizeComic({...c, bubble: 'oval'}), {id});
  assert.equal(c.presets.length, 1); assert.equal(c.presets[0].values.bubble, 'oval'); assert.equal(c.presets[0].name, '热血黑白');
  c = savePreset(c, {id, name: '改名了'}); assert.equal(c.presets[0].name, '改名了');
  assert.equal(applyPreset(c, 'nope').preset, id);
  c = removePreset(c, id); assert.deepEqual([c.presets.length, c.preset], [0, '']);
  assert.deepEqual(Object.keys(comicValues(c)).sort(), ['bubble', 'color', 'gutter', 'lang', 'note', 'style', 'textHide', 'textSize']);
});
test('a preset in saved settings that is broken is cleaned up', () => {
  const c = normalizeComic({preset: 'a', presets: [{id: 'a', name: '', values: {color: 'pink'}}, {id: 'a', name: 'dup'}, null, {name: 'noid'}]});
  assert.equal(c.presets.length, 1); assert.equal(c.presets[0].name, '未命名'); assert.equal(c.presets[0].values.color, 'full'); assert.equal(c.preset, 'a');
});
