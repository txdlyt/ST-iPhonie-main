import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeComic, defaultComic, comicRules, comicTags, fixedPanels, canvasOptions} from '../core/comic-settings.js';
import {comicRequest, parseComic, pageTags} from '../core/comic.js';

const board = n => JSON.stringify({pages: [{kind: 'page', panels: Array.from({length: n}, (_, i) => ({scene: 's' + i, who: [], lines: []}))}, {kind: 'splash', panels: [{scene: 'big', who: [], lines: []}]}]});

test('defaults change nothing: the request and tags are as before the settings existed', () => {
  assert.deepEqual(defaultComic(), {color: 'full', style: 'general', lang: 'zh', textSize: 'auto', textHide: false, bubble: 'round', gutter: 'none'});
  assert.deepEqual(comicRules(null), []);
  assert.deepEqual(comicTags(null), {tags: '', negative: ''});
  assert.equal(comicRequest({story: 'x'})[0].content, comicRequest({story: 'x', comic: defaultComic()})[0].content);
  assert.match(comicRequest({story: 'x'})[0].content, /text 用中文/);
});
test('normalizeComic drops what is not an option', () => {
  assert.deepEqual(normalizeComic({color: 'pink', style: 'nope', lang: 'fr', textSize: 9, textHide: 'yes', bubble: 'star', gutter: 7}), defaultComic());
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
