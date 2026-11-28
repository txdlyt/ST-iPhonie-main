import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeComic, defaultComic} from '../core/comic-settings.js';
import {TTSBackend} from '../core/backend.js';

test('textModel: kept as given, anything else becomes "follow the engine"', () => {
  assert.equal(defaultComic().textModel, '');
  assert.equal(normalizeComic({textModel: 'tavern'}).textModel, 'tavern');
  assert.equal(normalizeComic({textModel: 'my-preset_2'}).textModel, 'my-preset_2');
  for (const bad of [null, 5, 'a b', '', 'x'.repeat(65), {}]) assert.equal(normalizeComic({textModel: bad}).textModel, '');
});

// generateText picks the connection for one request without touching the one set in 引擎
function backend(text) {
  const b = Object.create(TTSBackend.prototype), seen = [];
  b.settings = {text};
  b.requestLog = {run: (label, info, fn) => { seen.push(info); return fn(); }};
  b.ledger = {text() {}};
  b.generateTextRaw = async (_ctx, _req, _signal, _details, used) => { seen.push({used}); return 'ok'; };
  return {b, seen};
}
const presets = [{id: 'a', name: 'A', url: 'https://a/v1', model: 'model-a'}, {id: 'b', name: 'B', url: 'https://b/v1', model: 'model-b'}];
test('generateText: no connection follows the engine; tavern / a preset id is used for that request only', async () => {
  const {b, seen} = backend({source: 'custom', active: 'a', presets});
  await b.generateText({}, {use: 'book', prompt: 'x'});
  assert.deepEqual([seen.at(-1).used.source, seen.at(-1).used.model], ['custom', 'model-a']);
  await b.generateText({}, {use: 'book', prompt: 'x', connection: 'tavern'});
  assert.equal(seen.at(-1).used.source, 'tavern');
  await b.generateText({}, {use: 'book', prompt: 'x', connection: 'b'});
  assert.deepEqual([seen.at(-1).used.source, seen.at(-1).used.model, seen.at(-1).used.id], ['custom', 'model-b', 'b']);
  await b.generateText({}, {use: 'book', prompt: 'x', connection: 'gone'});
  assert.equal(seen.at(-1).used.model, 'model-a');
  assert.equal(b.settings.text.active, 'a'); assert.equal(b.settings.text.source, 'custom'); // the engine's own choice is untouched
});
test('generateText: a preset id used while the engine follows the tavern', async () => {
  const {b, seen} = backend({source: 'tavern', active: 'a', presets});
  await b.generateText({}, {use: 'book', prompt: 'x', connection: 'b'});
  assert.deepEqual([seen.at(-1).used.source, seen.at(-1).used.model], ['custom', 'model-b']);
  assert.deepEqual([seen[0].source, seen[0].model], ['custom', 'model-b']); // the request log shows the one really used
});
