import test from 'node:test';
import assert from 'node:assert/strict';
import {comicRequest, parseComic, pageTags, pageCharacters, panelRects, clampPages} from '../core/comic.js';

const reply = '好的，分镜如下：\n```json\n' + JSON.stringify({title: '雨夜', pages: [
  {kind: 'page', panels: [{scene: 'rain, street, night', who: ['小雪'], lines: [{who: '小雪', text: '好冷。', kind: 'say'}, {who: '', text: '', kind: 'say'}]}, {scene: 'close-up, eyes', who: ['小雪', '小雪'], lines: []}]},
  {kind: 'splash', panels: [{scene: 'lightning, wide shot', who: ['小雪'], lines: [{who: '旁白', text: '雷声炸开。', kind: 'narr'}]}, {scene: 'ignored second panel', who: [], lines: []}]},
  {kind: 'page', panels: []}
]}) + '\n```';

test('parseComic reads a fenced answer and tidies it', () => {
  const comic = parseComic(reply);
  assert.equal(comic.title, '雨夜');
  assert.equal(comic.pages.length, 2); // the empty page is left out
  assert.deepEqual(comic.pages[0].panels[0].lines, [{who: '小雪', text: '好冷。', kind: 'say'}]); // the empty line is left out
  assert.deepEqual(comic.pages[0].panels[1].who, ['小雪']); // a name once
  assert.equal(comic.pages[1].kind, 'splash');
  assert.equal(comic.pages[1].panels.length, 1); // a big panel is one panel
});
test('parseComic refuses what cannot be drawn', () => {
  assert.throws(() => parseComic('没有 JSON'), /找不到 JSON/);
  assert.throws(() => parseComic('{"pages": [}'), /读不出来/);
  assert.throws(() => parseComic('{"pages": []}'), /没有可画的页/);
});
test('parseComic keeps at most maxPages', () => {
  const many = JSON.stringify({pages: Array.from({length: 9}, () => ({kind: 'page', panels: [{scene: 'a', who: [], lines: []}]}))});
  assert.equal(parseComic(many, {maxPages: 4}).pages.length, 4);
});
test('pageTags: a big panel is its scene, a page says how it is divided', () => {
  const comic = parseComic(reply);
  assert.equal(pageTags(comic.pages[1]), 'lightning, wide shot');
  assert.equal(pageTags(comic.pages[0]), 'comic page, 2 panels, stacked vertically, panel 1: rain, street, night, panel 2: close-up, eyes');
  assert.deepEqual(pageCharacters(comic.pages[0]), ['小雪']);
});
test('panelRects: as many rectangles as panels, inside the page, none over another', () => {
  for (let n = 1; n <= 6; n++) {
    const rects = panelRects(n, 800, 1200);
    assert.equal(rects.length, n);
    for (const r of rects) { assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 800 + 1e-6 && r.y + r.h <= 1200 + 1e-6 && r.w > 0 && r.h > 0); }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = rects[i], b = rects[j];
      assert.ok(a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6, `panels ${i} and ${j} of ${n} overlap`);
    }
  }
});
test('comicRequest names the page count and the people', () => {
  const [system, user] = comicRequest({story: '雨夜', names: ['小雪', '阿明'], pages: 6});
  assert.match(system.content, /共 6 页/);
  assert.match(system.content, /最多 2 页 splash/);
  assert.match(user.content, /小雪、阿明/);
  assert.equal(clampPages(99), 12);
  assert.equal(clampPages('x'), 4);
});
