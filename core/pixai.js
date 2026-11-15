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
/**
 * Two ways to draw, each with its own settings (changing one never touches the other):
 *   api    — the bridge sends PixAI's own request: the model, the size, the pictures per task and the LoRA weight all travel with
 *            the request (`api` below), the PixAI page is not touched.
 *   direct — the bridge clicks the PixAI page; the model, ratio, size and count are the page's own buttons (read back, not kept here).
 */
export const PIXAI_MODES = ['api', 'direct'];
// source: 'preset' — the model, LoRA and Recipe are the bridge's preset (each of LoRA / Recipe can be switched off);
//         'page'   — the model, LoRA, Recipe, steps … are what was set on the PixAI page and recorded by the bridge: this side only decides the prompt and the size.
// tplId: which recorded page setting is in use; tplKnown: the records seen so far (null = none yet), so a newly recorded one is noticed; tplLoras: per record, per LoRA {on, weight}.
export const defaultPixaiApi = () => ({tplId: '', tplKnown: null, tplLoras: {}, tplCovers: {}, tplNames: {}, source: 'page', model: '', useLora: true, useRecipe: true, ratio: '', size: '', width: 0, height: 0, count: 4, loraWeight: 0.7});
export const defaultPixai = () => ({url: '', style: '', mode: 'api', api: defaultPixaiApi()});
export function normalizePixaiApi(value) {
  const a = value && typeof value === 'object' ? value : {}, d = defaultPixaiApi();
  const dim = v => (Number.isInteger(v) && v >= 64 && v <= 8192 ? v : 0);
  const weight = Number.isFinite(Number(a.loraWeight)) ? Math.round(Math.min(1, Math.max(0, Number(a.loraWeight))) * 20) / 20 : d.loraWeight;
  const ratio = typeof a.ratio === 'string' && /^\d+:\d+$/.test(a.ratio.trim()) ? a.ratio.trim() : '', size = typeof a.size === 'string' && /^[A-Za-z]{1,3}$/.test(a.size.trim()) ? a.size.trim().toUpperCase() : '';
  const width = dim(a.width), height = dim(a.height);
  const text = (v, n) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v.slice(0, n) : '');
  const tplLoras = {};
  for (const [tid, map] of Object.entries(a.tplLoras && typeof a.tplLoras === 'object' ? a.tplLoras : {}).slice(0, 12)) {
    if (!text(tid, 40) || !map || typeof map !== 'object') continue;
    tplLoras[tid] = Object.fromEntries(Object.entries(map).slice(0, 20).filter(([k, v]) => /^\d{1,30}$/.test(k) && v && typeof v === 'object').map(([k, v]) => [k, {on: v.on !== false, weight: Number.isFinite(Number(v.weight)) ? Math.round(Math.min(1, Math.max(0, Number(v.weight))) * 20) / 20 : 0.7}]));
  }
  const tplCovers = {}, path = v => typeof v === 'string' && /^\/?user\/images\/[^"\\?#]+$/.test(v);
  for (const [tid, c] of Object.entries(a.tplCovers && typeof a.tplCovers === 'object' ? a.tplCovers : {}).slice(0, 24)) if (text(tid, 40) && c && path(c.thumb) && path(c.full)) tplCovers[tid] = {thumb: c.thumb, full: c.full};
  const tplNames = {};
  for (const [tid, n] of Object.entries(a.tplNames && typeof a.tplNames === 'object' ? a.tplNames : {}).slice(0, 24)) if (text(tid, 40) && typeof n === 'string' && n.trim()) tplNames[tid] = n.trim().slice(0, 40);
  return {tplId: text(a.tplId, 40), tplCovers, tplNames, tplKnown: Array.isArray(a.tplKnown) ? a.tplKnown.map(x => text(x, 40)).filter(Boolean).slice(0, 12) : null, tplLoras, source: 'page', useLora: a.useLora !== false, useRecipe: a.useRecipe !== false, model: typeof a.model === 'string' && /^[\w.-]{0,40}$/.test(a.model) ? a.model : '', ratio, size, width: width && height ? width : 0, height: width && height ? height : 0, count: Number(a.count) === 1 ? 1 : 4, loraWeight: weight};
}
export function normalizePixai(value) {
  const p = value && typeof value === 'object' ? value : {};
  let url = '';
  try { url = relayUrl(p.url, ''); } catch { url = ''; }
  return {url, style: typeof p.style === 'string' ? p.style.slice(0, 64) : '', mode: PIXAI_MODES.includes(p.mode) ? p.mode : 'api', api: normalizePixaiApi(p.api)};
}

/** The NovelAI client of this engine: no NovelAI host, and no key is fine (the bridge may not ask for one). */
/** What a proxy or gateway in front of the bridge says when it gives up waiting: the bridge may still be drawing, and have drawn it. */
export const PIXAI_CUT = new Set([408, 502, 503, 504, 520, 521, 522, 523, 524]);

export class PixaiClient extends NovelAIClient {
  get configured() { return !!this.relay; }
  headers() {
    const headers = {'Content-Type': 'application/json'};
    if (this.key) headers.Authorization = 'Bearer ' + this.key;
    return headers;
  }
  async generate(body, signal) {
    if (!this.relay) throw Error('还没有填写 PixAI 反代地址');
    try { return await super.generate(body, signal); }
    catch (error) {
      // 410: asked to only fetch a picture (bridge_batch.recover) the bridge no longer has: it was not drawn again.
      if (error?.status === 410) throw Object.assign(Error('PixAI 反代里已经没有这张图了（超过 10 分钟，或反代重启过）。点「重试」会重新画一张，会再扣一次积分'), {status: 410, code: 'PIXAI_EXPIRED'});
      if (PIXAI_CUT.has(error?.status)) throw Object.assign(Error(`连接在 PixAI 出图途中被切断了（${error.status}，多半是反代前面的 nginx / Cloudflare / 酒馆转发等得太久）。图可能已经画好了：点「重新获取」取回，不会重画`), {status: error.status, cut: true});
      // The client is NovelAI's: what it says about "NovelAI" is about this engine here.
      if (error && typeof error.message === 'string') error.message = error.message.replace(/NovelAI/g, PIXAI_NAME);
      throw error;
    }
  }
}

/** The first of these that is a usable pixel size, as it is: the page's own resolution (720×1280) is not rounded to NovelAI's multiples of 64. */
export const exactSize = (...values) => values.find(v => Number.isInteger(v) && v >= 64 && v <= 8192);

/** {run, index, size} of one picture in a request for several, or null: what the bridge reads as one drawing of `size` pictures. */
export function normalizeBatch(value) {
  if (!value || typeof value !== 'object') return null;
  const run = typeof value.run === 'string' ? value.run.slice(0, 80) : '', index = Number(value.index), size = Number(value.size);
  if (!run || !Number.isInteger(index) || !Number.isInteger(size) || size < 1 || size > 64 || index < 0 || index >= size) return null;
  return {run, index, size, ...(value.recover === true ? {recover: true} : {})};
}

/**
 * The body sent to the bridge: NovelAI's text-to-image shape, with the whole picture in `input` (PixAI has one prompt box:
 * everyone's caption follows the scene tags, as NovelAI V3 does) and none of NovelAI's own additions (no quality tags, no
 * 底图, no 角色参考, no vibes). parameters.characters keeps the people apart, for a script that wants them.
 */
export function pixaiRequest({prompt, negative = '', characters = [], params, batch, chunks = [], pixai = null}) {
  const p = normalizeDrawParams(params), expand = text => expandChunks(String(text || ''), chunks).trim();
  const people = (characters || []).filter(c => c?.enabled !== false && String(c?.prompt || '').trim()).map(c => ({prompt: expand(c.prompt), negative: expand(c.negative)}));
  const seed = p.seed >= 0 ? p.seed : Math.floor(Math.random() * 4294967295);
  const input = [expand(prompt), ...people.map(c => c.prompt)].filter(Boolean).join(', ');
  const unwanted = [expand(negative), ...people.map(c => c.negative)].filter(Boolean).join(', ');
  // API mode: the size picked in the plugin's own PixAI settings is the size, whatever the caller's NovelAI-style params say
  // (automatic drawing and re-draws pass none, and would otherwise draw at the NovelAI size).
  const own = pixai?.mode === 'api' && pixai.api?.width && pixai.api?.height ? pixai.api : null;
  const width = exactSize(own?.width, params?.width, p.width), height = exactSize(own?.height, params?.height, p.height);
  const parameters = {width, height, seed, n_samples: 1, negative_prompt: unwanted, characters: people,
    // A picture that is alone in its request still says so: the bridge then draws one, not four.
    bridge_batch: normalizeBatch(batch) || {run: crypto.randomUUID(), index: 0, size: 1},
    // Which way to draw, so the bridge does what this plugin's settings say (an older bridge ignores it).
    ...(pixai ? {bridge_mode: pixai.mode === 'direct' ? {mode: 'direct'} : {mode: 'api', source: pixai.api?.source === 'page' ? 'page' : 'preset', model: pixai.api?.model || '', loraWeight: pixai.api?.loraWeight ?? 0.7, useLora: pixai.api?.useLora !== false, useRecipe: pixai.api?.useRecipe !== false, template: pixai.api?.tplId || '', loraTweaks: pixai.api?.tplLoras?.[pixai.api?.tplId] || {}}} : {})};
  return {body: {input, model: p.model, action: 'generate', parameters}, seed, params: {width, height}};
}
