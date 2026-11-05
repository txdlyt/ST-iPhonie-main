// PixAI 反代: a drawing engine whose server (PixAI Bridge, see docs/pixai-bridge/) speaks NovelAI's interface:
// POST {url}/ai/generate-image with a NovelAI body, answered with a ZIP whose first file is the picture. So the request
// is built by the same code as NovelAI's (buildImageRequest) and read by the same client; what differs is only
//   · where it goes (draw.pixai.url, never NovelAI's own host),
//   · the key: the bridge's own token, optional (the bridge checks it only when BRIDGE_TOKEN is set),
//   · bridge_batch: which picture of one request this is, so the bridge can draw 4 at once and hand them out one by one.
// A script that stands in for the bridge (another site's reverse proxy, a local ComfyUI wrapper …) only has to read this
// body: input, parameters.{width,height,seed,negative_prompt}, parameters.bridge_batch, parameters.characters.
import {NovelAIClient, relayUrl, normalizeDrawParams, expandChunks} from './novelai.js';

export const PIXAI_NAME = 'PixAI 反代';
export const defaultPixai = () => ({url: '', style: ''});
export function normalizePixai(value) {
  const p = value && typeof value === 'object' ? value : {};
  let url = '';
  try { url = relayUrl(p.url, ''); } catch { url = ''; }
  return {url, style: typeof p.style === 'string' ? p.style.slice(0, 64) : ''};
}

/** The NovelAI client of this engine: no NovelAI host, and no key is fine (the bridge may not ask for one). */
export class PixaiClient extends NovelAIClient {
  get configured() { return !!this.relay; }
  headers() {
    const headers = {'Content-Type': 'application/json'};
    if (this.key) headers.Authorization = 'Bearer ' + this.key;
    return headers;
  }
  async generate(body, signal) {
    if (!this.relay) throw Error('还没有填写 PixAI 反代地址');
    return super.generate(body, signal);
  }
}

/** {run, index, size} of one picture in a request for several, or null: what the bridge reads as one drawing of `size` pictures. */
export function normalizeBatch(value) {
  if (!value || typeof value !== 'object') return null;
  const run = typeof value.run === 'string' ? value.run.slice(0, 80) : '', index = Number(value.index), size = Number(value.size);
  if (!run || !Number.isInteger(index) || !Number.isInteger(size) || size < 1 || size > 64 || index < 0 || index >= size) return null;
  return {run, index, size};
}

/**
 * The body sent to the bridge: NovelAI's text-to-image shape, with the whole picture in `input` (PixAI has one prompt box:
 * everyone's caption follows the scene tags, as NovelAI V3 does) and none of NovelAI's own additions (no quality tags, no
 * 底图, no 角色参考, no vibes). parameters.characters keeps the people apart, for a script that wants them.
 */
export function pixaiRequest({prompt, negative = '', characters = [], params, batch, chunks = []}) {
  const p = normalizeDrawParams(params), expand = text => expandChunks(String(text || ''), chunks).trim();
  const people = (characters || []).filter(c => c?.enabled !== false && String(c?.prompt || '').trim()).map(c => ({prompt: expand(c.prompt), negative: expand(c.negative)}));
  const seed = p.seed >= 0 ? p.seed : Math.floor(Math.random() * 4294967295);
  const input = [expand(prompt), ...people.map(c => c.prompt)].filter(Boolean).join(', ');
  const unwanted = [expand(negative), ...people.map(c => c.negative)].filter(Boolean).join(', ');
  const parameters = {width: p.width, height: p.height, seed, n_samples: 1, negative_prompt: unwanted, characters: people,
    // A picture that is alone in its request still says so: the bridge then draws one, not four.
    bridge_batch: normalizeBatch(batch) || {run: crypto.randomUUID(), index: 0, size: 1}};
  return {body: {input, model: p.model, action: 'generate', parameters}, seed, params: {width: p.width, height: p.height}};
}
