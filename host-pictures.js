import {storyDrawSource} from './core/draw.js';
import {replacePicture,storyPickerContext} from './ui/replace-picture.js';
import {replyBody, replyRevision} from './core/reply-revision.js';
import {storyScope, mapStory, cleanBody, cleanSkip, NARRATION_BODY, NARRATION_SKIP} from './core/story-scope.js';
// In-chat pictures: fills the placeholders left by <img>…</img> tags, generates them with NovelAI,
// uploads the result to the tavern's image folder and remembers it on the message (message.extra.sttts_pics),
// so every device that opens the chat sees the same picture.
//
// A finished picture shows only the image. One tap folds it to a line of text (and back); a double tap opens the
// viewer, which holds everything else: 收藏, the versions
// (‹ ›), the parameters (参数), redraw (also with the prompt changed first), open in the drawing app, fold and delete.
//
// Each tag keeps every version it was drawn in: {versions: [{url, seed, width, height, …}], index}.
// Redrawing adds a version (the old ones stay for comparison); deleting removes the shown version and its file.
// When the last version is deleted the record becomes {removed: true, versions: []}, so it is not drawn again
// automatically. Older records ({url, seed, …}) read as a single version.
import {storyReply} from './core/outgoing.js';
import {OUTFIT_KEY, normalizeBook, outfitsBefore, currentOutfits, recordOutfits, forgetOutfit} from './core/outfits.js';
import {lookOf, naturalLooks, drawSeparate, readOutfits, wantsOutfits, noneOk, usesBaibai, tavernPicture, sizeFor, parsePictures, pictureInputs, planRequest, planLength, tagTextRequest, tagTextAnswer, insertPlanned, withoutPictures, sameExact, suggestRequest, writeRequest, promptLength, readSuggestion, selectionRequest, selectionBlock, budgetNumbers, fillUpRequest, sameName, sentenceCount} from './core/draw.js';
import {tokenBudget, loadCounter, countField, tagCost, estimateTokens} from './core/tokens.js';
import {editTags} from './host-ask.js';
import {downloadAction} from './download.js';
import {plainStory, activeChatPreset} from './core/chat.js';
import {worldInfoFor, loreOptions} from './host-lore.js';
import {voicePlanBody, emptyVoiceBody, voicePlanRequest, combinedRequest, voicedRows, insertVoiced} from './core/voice-plan.js';
import {withPhone, phoneSection} from './core/chat.js';
import {TIER_NAMES, NAI_MODEL_NAMES} from './core/novelai.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const versionsOf = record => !record ? [] : Array.isArray(record.versions) ? record.versions : record.url ? [{...record}] : [];

/**
 * voice: 回复后单独配音 ({wanted(), has(text), rules(), format()}): whether it is on, whether a reply already has its
 * lines voiced, the voice preset's prompt for the speakers and its 台词格式. Without it replies are never voiced here.
 */
// the viewer (image-viewer.js) is loaded the first time a picture is opened, not with the tavern
let viewerLoad = null;
const viewerCode = () => viewerLoad ||= import('./image-viewer.js').catch(error => { viewerLoad = null; throw error; });
export function createPictureHost({context, redrawMessage = (id, message) => context().updateMessageBlock?.(id, message), settings, backend, marker, scheduleRender, openDraw, notice, voice = null, phone = null, speakers = () => [], voiced: lined = () => {}, outfitChanged = () => {}}) {
  const jobs = new Map(); // queue key -> {state: 'generating'|'error', message}
  const folds = new Map(); // `${id}:${hash}` -> true/false, this session's fold choice per picture
  const bars = new Set(); // `${id}:${hash}` of the pictures whose button bar (收起 / 重画) is showing; a tap outside the picture hides it

  const stored = (message, hash) => message?.extra?.sttts_pics?.[hash] || null;
  /** The version on screen, with its position: {…version, index, count}; null when there is none. */
  function shown(message, hash) {
    const record = stored(message, hash), list = versionsOf(record);
    if (!list.length) return null;
    const index = Math.min(list.length - 1, Math.max(0, Number.isInteger(record.index) ? record.index : list.length - 1));
    return {...list[index], index, count: list.length};
  }
  function keep(message, hash, list, index) {
    message.extra ??= {};
    message.extra.sttts_pics ??= {};
    message.extra.sttts_pics[hash] = list.length ? {versions: list, index: Math.min(list.length - 1, Math.max(0, index))} : {removed: true, versions: [], at: Date.now()};
  }
  const jobKey = (id, tag) => `pic:${context()?.chatId ?? ''}:${id}:${tag.hash}`;
  const saveSoon = () => (context().saveChatDebounced || context().saveChat)?.();

  // The queue changes often (positions, retry countdowns): redraw the placeholders when it does.
  backend.subscribe?.(event => { if (event.type === 'draw' && event.queue) scheduleRender(); });
  // 收藏 in the viewer: which album photos have the heart, read when it opens. A picture of the story has its copy in the
  // album (generate), or gets one when it is first given the heart.
  let hearts = new Set();
  /** The picture's copy in the album: the one it knows; else one of the same seed; else made from the tavern's file. */
  async function albumCopy(message, tag, list, index) {
    const version = list[index];
    if (version.photoId && await backend.library.getPhoto(version.photoId).catch(() => null)) return version.photoId;
    const named = version.seed >= 0 ? (await backend.library.listPhotos()).find(row => String(row.name).startsWith(`chat-${version.seed}.`)) : null;
    let id = named?.id;
    if (!id) {
      const response = await fetch(version.url);
      if (!response.ok) throw Error('读不到这张图的文件（' + response.status + '）');
      const blob = await response.blob();
      id = (await backend.mutateLibrary('photos', 'addPhoto', {name: `chat-${version.seed >= 0 ? version.seed : Date.now()}.${/webp/.test(blob.type) ? 'webp' : /jpe?g/.test(blob.type) ? 'jpg' : 'png'}`, blob, info: pictureInfo(version, tag).filter(row => row[1] !== undefined && row[1] !== null && row[1] !== '')})).id;
    }
    version.photoId = id;
    keep(message, tag.hash, list, shown(message, tag.hash)?.index ?? index);
    saveSoon();
    return id;
  }
  /** The heart of one version, given or taken away. */
  async function toggleHeart(message, tag, list, index) {
    const was = !!list[index]?.photoId && hearts.has(list[index].photoId), id = await albumCopy(message, tag, list, index);
    await backend.favoritePhotos([id], !was);
    if (was) hearts.delete(id); else hearts.add(id);
  }

  async function upload(blob, name, folder = context().name2 || 'ST-iPhonie') {
    const ctx = context();
    const base64 = await backend.base64(blob);
    const response = await fetch('/api/images/upload', {
      method: 'POST', headers: ctx.getRequestHeaders(),
      body: JSON.stringify({image: base64, format: ({'image/jpeg':'jpg','image/webp':'webp'})[blob.type] || 'png', ch_name: folder, filename: String(name).replace(/\./g, '_')})
    });
    if (!response.ok) throw Error('图片已生成，但上传到酒馆失败（' + response.status + '）');
    return tavernPicture((await response.json()).path);
  }
  /** Deletes a picture file from the tavern's image folder. A file that is already gone counts as deleted. */
  async function removeFile(url) {
    if (!url) return;
    const response = await fetch('/api/images/delete', {method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({path: url})});
    if (!response.ok && response.status !== 404) throw Error('没能从酒馆删除图片文件（' + response.status + '）');
  }

  /** Asks before spending Anlas (or paying for a GPT picture). Returns 'free', 'paid' or false (declined, or no key). params: the picture's, when they are its own; who: the other plugin asking. */
  async function allowed(interactive, params, who = '') {
    if (!backend.drawReady()) { if (interactive) notice(backend.drawMissing() + '，请在小手机的引擎卡包里填写'); return false; }
    const engine = settings().draw.engine;
    // Through a relay counted as Opus, a subscription it does not pass on is expected, not worth a notice.
    if (engine === 'nai') try { await backend.naiSubscription(); } catch (error) { const relay = settings().draw.relay; if (!relay.url&&interactive)notice(error.message);else backend.reportDiagnostic?.('绘图订阅查询',{message:error.message,drawStillAvailable:true},'warn'); }
    const quote = backend.drawQuote(params);
    if (quote.free === true) return 'free';
    if (!interactive) return false;
    const why = (who ? `「${who}」想用小手机画一张图。\n` : '') + (engine === 'gpt' ? 'GPT 生图每张都要花钱（按 OpenAI 或中转的价格）。' : quote.free === null ? '暂时读不到 NovelAI 订阅信息，无法确认是否免费。' : '按当前参数和订阅，这张图会扣 Anlas。');
    return globalThis.confirm(why + '\n确定要生成吗？') ? 'paid' : false;
  }

  /**
   * A picture another plugin asks for (host-public.js), drawn like one in the story: the engine, the 画风, the looks of the people
   * named. One that costs is asked about first; with ask: false it is refused. It goes in the album, and in the tavern's files for
   * its address. signal: an AbortSignal, to take it back.
   */
  async function drawFor({prompt, negative, characters = [], size, seed, ask = true, signal, from}) {
    const words = String(prompt ?? '').trim().slice(0, 4000), who = String(from ?? '').trim().slice(0, 40);
    if (!words) throw Object.assign(Error('请先写提示词'), {code: 'NO_PROMPT'});
    if (!backend.drawReady()) throw Object.assign(Error(backend.drawMissing()), {code: 'NOT_READY'});
    const s = settings(), own = {...sizeFor(s.draw.params, size), ...(Number.isInteger(seed) && seed >= 0 ? {seed} : {})};
    const inputs = pictureInputs({...s, draw: {...s.draw, params: {...s.draw.params, ...own}}}, {prompt: words, characters: characters.map(String), spec: null});
    const permission = await allowed(ask, inputs.params, who || '其他插件');
    if (!permission) throw Object.assign(Error(ask ? '这张图要花钱，没有确认' : '这张图要花钱，需要确认后再画'), {code: 'PAID'});
    if (signal?.aborted) throw Object.assign(Error('已取消'), {cancelled: true});
    const key = 'plugin-' + crypto.randomUUID(), stop = () => backend.drawQueue?.cancel(key);
    signal?.addEventListener('abort', stop, {once: true});
    try {
      const unwanted = String(negative ?? '').trim();
      const result = await backend.generateImage({...inputs, ...(unwanted ? {negative: [inputs.negative, unwanted].filter(Boolean).join(', ')} : {}), allowPaid: permission === 'paid', name: '插件', key, label: `${who || '其他插件'} · ${words.slice(0, 24)}`});
      // The picture is in the album either way: no address is no reason to lose it.
      const url = await upload(result.blob, 'st-iphonie-' + Date.now(), 'ST-iPhonie').catch(() => '');
      return {url, blob: result.blob, photoId: result.photoId, seed: result.seed, width: result.params.width, height: result.params.height, model: result.params.model, engine: result.engine, prompt: result.prompt};
    } finally { signal?.removeEventListener('abort', stop); }
  }

  /** Queues one picture. Redrawing adds a version; the earlier versions stay. */
  async function generate(id, tag, {interactive = false, permission = null, valid = null} = {}) {
    const ctx = context(), message = ctx.chat[id], key = jobKey(id, tag), swipe = message?.swipe_id;
    if (!message || selectionJobs.has(message)) return;
    if (jobs.get(key)?.state === 'generating') { if (interactive) notice('这张图已经在画了（或卡在队列里）。点「取消」后再重画'); return; }
    permission ??= await allowed(interactive, pictureInputs(settings(), tag, message.mes).params);
    if (!permission) {
      // Tapping 出图 / 重画 and getting nothing back is the worst answer: say why.
      if (interactive) notice(backend.drawReady() ? '没有出图：这张图要花钱，需要你确认（弹窗里点「确定」）' : (backend.drawMissing() || '没有出图：绘图引擎还没设好'));
      backend.reportDiagnostic?.('正文出图', {message: '点了出图但没有开始', ready: backend.drawReady(), engine: settings().draw.engine, interactive}, 'warn');
      return;
    }
    if (selectionJobs.has(message) || jobs.get(key)?.state === 'generating' || context().chat[id] !== message || message.swipe_id !== swipe || (valid && !valid())) return;
    jobs.set(key, {state: 'generating', engine: settings().draw.engine});
    scheduleRender();
    try {
      const inputs = pictureInputs(settings(), tag, message.mes);
      const result = await backend.generateImage({...inputs, allowPaid: permission === 'paid', valid, name: 'chat', key, label: '正文图片 · ' + tag.prompt.slice(0, 24)});
      const url = await upload(result.blob, 'st-iphonie-' + Date.now());
      // Only store the picture when the same message is still there with this tag.
      const now = context().chat[id];
      if (now === message && now.swipe_id === swipe && parsePictures(now.mes).some(t => t.hash === tag.hash)) {
        const list = versionsOf(stored(now, tag.hash));
        list.push({url, photoId: result.photoId, seed: result.seed, width: result.params.width, height: result.params.height, model: result.params.model, steps: result.params.steps, style: result.style, prompt: tag.prompt, characters: inputs.names, at: Date.now()});
        keep(now, tag.hash, list, list.length - 1);
        await context().saveChat();
        if (settings().general.hideStoryWaves) redrawMessage(id, now);
      }
      jobs.delete(key);
    } catch (error) {
      if (error.cancelled) jobs.delete(key); else { jobs.set(key, {state: 'error', message: error.message}); if (interactive || settings().general.hideStoryWaves) notice(error.message); backend.reportDiagnostic?.('正文出图', {message: error.message, engine: settings().draw.engine, interactive}, 'error'); }
    }
    scheduleRender();
  }

  const planning = new Set(), selectionJobs = new WeakSet();
  /** Who the rules may name: the open card's people and who speaks now (core/draw.js drawCast). */
  const castNow = () => backend.drawCast?.(speakers()) ?? null;
  /** 世界书 for planning pictures: what the tavern would turn on for this story, through the phone's choice of books. */
  async function storyLore(prior, source) {
    const preset = activeChatPreset(settings().chat);
    if (preset.lore === false) return '';
    return worldInfoFor(context, {...loreOptions(preset), report: (...args) => backend.reportDiagnostic?.(...args), persona: String(context()?.powerUserSettings?.persona_description || '').slice(0, 1500),
      texts: [...prior.map(m => `${m.name}: ${m.text}`), plainStory(withoutPictures(source), [], settings().narration)]});
  }
  /** The picture planner's request for one reply, with the story's 世界书 and the card's 名单. */
  async function pictureRequest(id, source, {manual = false} = {}) {
    const prior = before(id), s = settings();
    // manual: someone asked for this floor's pictures: at least one, even where 柏宝绘 may come back with none.
    return planRequest(s, {message: source, before: prior, only: castNow(), lore: await storyLore(prior, source), outfits: wantsOutfits(s.draw) ? outfitsNow(id) : [], min: manual ? 1 : null});
  }
  // ---------- 当前服装 (per chat, in the chat's own data) ----------
  const outfitBook = () => normalizeBook(context()?.chatMetadata?.[OUTFIT_KEY]);
  const outfitNl = () => naturalLooks(settings());
  function outfitsNow(id) { return outfitsBefore(outfitBook(), id, null, outfitNl()); }
  function saveBook(book) {
    const ctx = context();
    if (!ctx?.chatMetadata) throw Error('先在酒馆里打开一个聊天');
    ctx.chatMetadata[OUTFIT_KEY] = book;
    (ctx.saveMetadataDebounced || ctx.saveMetadata)?.call(ctx);
  }
  /** What an answer says about who changed clothes goes into the chat's record (when the preset keeps one). */
  function keepOutfits(id, reply) {
    try {
      if (!wantsOutfits(settings().draw)) return;
      const found = readOutfits(reply);
      if (!found.length && /<img\b/i.test(String(reply ?? ''))) backend.reportDiagnostic?.('当前服装', {message: '这次回复的出图块里没有「服装：名字｜衣服」行，当前服装没有更新（模型没按规则写）', reply: String(reply ?? '').slice(0, 1500)}, 'warn');
      if (found.length) { saveBook(recordOutfits(outfitBook(), id, found, 'ai', outfitNl())); try { outfitChanged(id, found); } catch { /* the 衣柜 not following is not worth a failed reply */ } }
    } catch { /* a record that could not be kept is not worth a failed reply */ }
  }
  const outfitsList = () => currentOutfits(outfitBook(), outfitNl());
  /** Said by hand: it starts from the floor before the newest, so the next picture already uses it. */
  function outfitSave(name, outfit) {
    const ctx = context();
    if (!ctx?.chat?.length) throw Error('先在酒馆里打开一个聊天');
    if (!String(name).trim() || !String(outfit).trim()) throw Error('名字和衣服都要写');
    saveBook(recordOutfits(outfitBook(), Math.max(0, ctx.chat.length - 2), [{name, outfit}], 'me', outfitNl()));
    return outfitsList();
  }
  /** What someone wears from message `at` on, said by another part (the 衣柜): the same record as the planner's own. */
  function outfitAt(list, at, by = 'ai') {
    if (!context()?.chatMetadata) return false;
    saveBook(recordOutfits(outfitBook(), Math.max(0, Number(at) || 0), list, by, outfitNl()));
    return true;
  }
  function outfitDelete(name) { saveBook(forgetOutfit(outfitBook(), name)); return outfitsList(); }
  function outfitsClear() { saveBook({}); return []; }
  /** Earlier messages for the planner: names and plain text, oldest first. */
  function before(id, limit = 2) {
    const chat = context().chat, out = [];
    for (let i = id - 1; i >= 0 && out.length < limit; i--) {
      const m = chat[i];
      if (!m || m.is_system) continue;
      const text = plainStory(withoutPictures(m.mes), [], settings().narration);
      if (text) out.unshift({name: m.name || (m.is_user ? '我' : '角色'), text: text.slice(0, 600)});
    }
    return out;
  }
  /** The pictures of a reply asked for on their own: put in, asked once more when none came out. {text, count} */
  async function planOnce(id, source, {manual = false} = {}, valid = () => true) {
    let last = {text: source, count: 0};
    // 柏宝绘 with 最少 0: a reply with nothing worth drawing is a proper answer, so it is not asked again.
    const rounds = !manual && noneOk(settings().draw) ? 1 : 2;
    for (let round = 0; round < rounds && !last.count; round++) {
      const prompt = await pictureRequest(id, source, {manual});
      if (!valid()) throw new DOMException('回复已变化，已取消旧的配图任务', 'AbortError');
      const reply = await backend.generateText(context(), {use: 'picture', prompt, trimNames: false, responseLength: planLength(settings(), activeDrawPreset().count)});
      if (!valid()) throw new DOMException('回复已变化，旧结果未写入', 'AbortError');
      last = {...insertPlanned(source, reply, {...settings().narration, outfits: wantsOutfits(settings().draw)}), reply};
      keepOutfits(id, reply);
      if (!last.count && rounds > 1) backend.reportDiagnostic?.('正文出图', {message: round ? '又试了一次，还是没有挑出画面' : '没有挑出画面，再试一次', reply: String(reply ?? '').slice(0, 2000)}, 'warn');
    }
    return last;
  }
  const activeDrawPreset = () => { const s = settings(); return s.draw.presets.find(p => p.id === s.draw.activePreset) || s.draw.presets[0]; };
  /**
   * 'separate' mode: after a reply is written, ask the model (its own request) for the picture blocks and put them
   * into the reply after the paragraphs it chose. force: plan again, replacing the blocks already there.
   */
  async function planPictures(id, {force = false} = {}) {
    const ctx = context(), message = ctx.chat[id];
    if (!message || message.is_user || message.is_system || planning.has(id)) return false;
    if (!force && parsePictures(message.mes).length) return false;
    planning.add(id);
    notice('正在给这条回复挑画面……');
    try {
      const raw = message.mes, swipe = message.swipe_id;
      const source = force ? withoutPictures(raw) : raw;
      const {text, count} = await planOnce(id, source, {manual: force}, () => context().chat[id] === message && message.mes === raw && message.swipe_id === swipe);
      if (context().chat[id] !== message || message.mes !== raw || message.swipe_id !== swipe) return false;
      if (!count && noneOk(settings().draw) && !force) { notice('这条回复没有值得画的画面'); return false; }
      if (!count) throw Error('这次没有挑出画面（试了两次），可以点这层楼右边的小手机工具按钮「给这层楼生图」再试；模型具体回了什么可以在小手机的「日志」App 里看');
      message.mes = text;
      if (Array.isArray(message.swipes)) message.swipes[message.swipe_id ?? 0] = text;
      await ctx.saveChat();
      redrawMessage(id, message);
      scheduleRender();
      return true;
    } finally { planning.delete(id); }
  }
  /**
   * 回复后单独配音, and with 回复后单独配图 on too, both in one request: voices the lines of a reply (and puts its
   * pictures in). force: do it again, replacing what is there. Returns what was done: {voiced, pictured}.
   */
  const pendingAnswers = new Map();
  const scopeKey = () => JSON.stringify([voice?.format(), settings().activePreset, settings().narration?.body, settings().narration?.skip]);
  const stage = (id, state, extra = {}, level = 'info') => backend.reportDiagnostic?.('正文配音与配图', {reply: id, state, ...extra}, level);
  function rememberAnswer(id, entry) {
    pendingAnswers.delete(id); pendingAnswers.set(id, entry);
    while (pendingAnswers.size > 8) pendingAnswers.delete(pendingAnswers.keys().next().value);
  }
  function reusable(id, wantVoice, wantPictures, revoice) {
    const e = pendingAnswers.get(id);
    if (!e || (!!e.revoice !== revoice && e.writtenBody === undefined) || Date.now() > e.until || e.key !== scopeKey() || wantVoice && !e.wantVoice || wantPictures && !e.wantPictures) return null;
    const current = e.revision.current();
    return current && (e.revision.target() || e.writtenBody !== undefined && replyBody(current.mes, e.scope) === e.writtenBody) ? e : null;
  }
  async function planReply(id, {voiced: wantVoice, pictured: wantPictures, force = false, phoned = false, revoice = false}) {
    const ctx = context(), s = settings(), original = ctx.chat[id];
    if (!original || original.is_user || original.is_system || (!wantVoice && !wantPictures)) return {voiced: 0, pictured: 0};
    if (planning.has(id)) throw Error('这条回复正在处理，请稍后再试');
    // 柏宝绘 answers in its own JSON, which cannot share one answer with the voice lines: two requests, one after the other.
    if (wantVoice && wantPictures && usesBaibai(s.draw)) {
      const a = await planReply(id, {voiced: true, pictured: false, force, phoned});
      const b = await planReply(id, {voiced: false, pictured: true, force});
      return {voiced: a.voiced, pictured: b.pictured};
    }
    planning.add(id);
    notice(wantVoice && wantPictures ? '正在给这条回复配音、挑画面……' : wantVoice ? '正在给这条回复配音……' : '正在给这条回复挑画面……');
    let entry = reusable(id, wantVoice, wantPictures, revoice);
    const voiceSource = (source, scope) => revoice && voice?.has(source) ? mapStory(source, scope, text => voice.strip(text)) : source;
    const skip = () => { stage(id, '未写入：正文、聊天或分支已变化', {}, 'warn'); return {voiced: 0, pictured: 0, skipped: true}; };
    try {
      if (!entry) {
        const scope = structuredClone(s.narration), format = voice?.format(), key = scopeKey();
        const revision = replyRevision(context, id, scope, () => backend.closed ? null : backend.space);
        const source = voiceSource(force && wantPictures ? withoutPictures(original.mes) : original.mes, scope);
        const body = wantVoice ? voicePlanBody(source, scope) : null;
        if (body) {
          const rawLength = String(original.mes ?? '').length;
          const reason = !rawLength ? '楼层原文为空' : revoice && body.length === 0 && source !== original.mes
            ? '清除旧配音标签后，正文范围内没有可配音的文字' : emptyVoiceBody;
          stage(id, body.length ? '已检查配音正文' : reason, {
            rawLength, filteredLength: body.length, revoice,
            bodyTags: cleanBody(scope?.body ?? NARRATION_BODY), skipRules: cleanSkip(scope?.skip ?? NARRATION_SKIP),
          }, body.length ? 'info' : 'warn');
          if (!body.length) {
            if (phoned) return {voiced: 0, pictured: 0, skipped: true, reason};
            throw Error(reason);
          }
        }
        const preset = s.draw.presets.find(p => p.id === s.draw.activePreset) || s.draw.presets[0];
        const pictures = wantPictures ? await pictureRequest(id, source, {manual: force}) : null;
        const asked = wantVoice && wantPictures ? combinedRequest({rules: voice.rules(), format, pictures})
          : wantVoice ? voicePlanRequest({rules: voice.rules(), format, body, before: before(id)}) : pictures;
        const phoneRule = phoned && phone?.wanted() ? await phone.rule() : '';
        const prompt = withPhone(asked, phoneRule);
        const length = (wantVoice ? Math.min(3000, 400 + source.length * 2) : 0) + (wantPictures ? planLength(s, preset.count) : 0) + (phoneRule ? 500 : 0);
        if (!revision?.target()) return skip();
        const answer = await backend.generateText(ctx, {use: 'picture', prompt, trimNames: false, responseLength: Math.min(10000, length)});
        entry = {revision, scope, format, answer, phoneRule, key, wantVoice, wantPictures, force, revoice, until: Date.now() + 5 * 60000};
        if (String(answer).length <= 512000) rememberAnswer(id, entry);
        stage(id, '模型已返回，等待匹配与写入');
      } else stage(id, '复用已返回结果，不重复请求模型');
      const valid = () => !!entry.revision.target() && entry.key === scopeKey();
      let current = entry.revision.current();
      const alreadyWritten = current && entry.writtenBody !== undefined && replyBody(current.mes, entry.scope) === entry.writtenBody;
      if (!valid() && !alreadyWritten) return skip();
      const {rest: reply, phone: sent} = entry.phoneRule ? phoneSection(entry.answer,s.general?.shortTags) : {rest: entry.answer, phone: ''};
      if (wantPictures && !entry.outfitsKept) { entry.outfitsKept = true; keepOutfits(id, reply); }
      const assemble = source => {
        let text = voiceSource(force && wantPictures ? withoutPictures(source) : source, entry.scope), voiced = 0, pictured = 0;
        if (wantPictures) ({text, count: pictured} = insertPlanned(text, reply, {...entry.scope, outfits: wantsOutfits(s.draw)}));
        if (wantVoice) ({text, count: voiced} = insertVoiced(text, reply, entry.format, entry.scope));
        if (wantPictures && !pictured && entry.extraReply) ({text, count: pictured} = insertPlanned(text, entry.extraReply, {...entry.scope, outfits: wantsOutfits(s.draw)}));
        return {text, voiced, pictured};
      };
      let result = alreadyWritten ? {text: current.mes, ...entry.counts} : assemble(current.mes);
      if (!alreadyWritten && wantPictures && !result.pictured && !entry.extraReply && !(noneOk(s.draw) && !force)) {
        const extra = await planOnce(id, result.text, {manual: force}, valid);
        entry.extraReply = extra.reply;
        if (!valid()) return skip();
        current = entry.revision.target(); result = assemble(current.mes);
      }
      if (!result.voiced && !result.pictured && !sent && wantPictures && !wantVoice && noneOk(s.draw) && !force) { pendingAnswers.delete(id); notice('这条回复没有值得画的画面'); return {voiced: 0, pictured: 0}; }
      const candidates=wantVoice ? voicedRows(reply,entry.format).length : 0;
      const quoted=wantVoice ? (storyScope(current.mes,entry.scope).masked.match(/[“「『"][^”」』"\n]+[”」』"]/g) || []).length : 0;
      if (!result.voiced && !result.pictured && !sent) {
        pendingAnswers.delete(id);
        stage(id, wantVoice ? (candidates ? '未匹配到正文台词：配音行有效，但在选定正文范围内找不到原句' : '模型返回中没有符合当前预设的配音行') : '未匹配到正文画面', {quoted,candidates,voiced: 0, pictured: 0}, 'warn');
        throw Error(wantVoice ? '模型已返回，但这次没有匹配上正文台词，可用「给这层楼配音」重试；具体原因见日志' : '这次没有挑出画面，可以用「给这层楼生图」重试');
      }
      // Re-read the whole current reply: ignored panels belong to other tools and are never replaced by our snapshot.
      if (!alreadyWritten) {
        current = entry.revision.target(); if (!current || entry.key !== scopeKey()) return skip();
        result = assemble(current.mes);
        if (sent && entry.phoneRule && phone?.wanted()) result.text += '\n' + sent;
      }
      const prior = current.mes, swipe = current.swipe_id, {text, voiced, pictured} = result;
      entry.writtenBody = replyBody(text, entry.scope); entry.counts = {voiced, pictured};
      current.mes = text;
      if (Array.isArray(current.swipes)) current.swipes[swipe ?? 0] = text;
      try { await ctx.saveChat(); }
      catch (error) {
        // Roll back only the bytes still owned by us. If a panel changed meanwhile, retry can save the already inserted body.
        const now = entry.revision.current();
        if (now?.mes === text) { now.mes = prior; if (Array.isArray(now.swipes) && now.swipes[swipe ?? 0] === text) now.swipes[swipe ?? 0] = prior; }
        stage(id, '台词已匹配但保存失败，已保留本次结果供补写', {message: error.message}, 'warn');
        throw Error('配音结果已保留，但正文没保存成功；用「给这层楼配音」可重试补写：' + error.message);
      }
      pendingAnswers.delete(id);
      stage(id, '已写入并保存正文', {quoted,candidates,voiced, pictured});
      const now = entry.revision.current();
      if (now) {
        redrawMessage(id, now); scheduleRender();
        if (sent && entry.phoneRule && phone?.wanted()) phone.deliver(id).catch(() => {});
        if (voiced) lined(id);
      }
      if (wantVoice && !voiced) notice('画面已写入，台词这次没配上，可用「给这层楼配音」重试');
      if (wantPictures && !pictured && !(noneOk(s.draw) && !force)) notice('台词已写入，画面这次没挑出，可用「给这层楼生图」重试');
      return {voiced, pictured, written: true};
    } finally { planning.delete(id); }
  }

  /** Saves 新外貌 lines of a reply to the 角色 App: new named characters, or roles that have no appearance yet. */
  function registerAppearances(message) {
    const added = [];
    // Only for a reply still in the open chat, and only once the open card is known: a role made after the chat was left, or
    // before the card was known, would be filed under the wrong card (or none).
    if (!message || context().chat.indexOf(message) < 0 || backend.here?.()?.pending) return added;
    const key = backend.cardKey?.() || '', save = backend.saveKey?.() || '';
    // A role of the same name in ANOTHER card is another person (each card's 姐姐 is her own): it neither has the look for this card
    // nor gets this card's. Only this card's roles, and the ones that belong to no card, count.
    const here = x => !x.cards?.length || x.cards.some(k => k === key || k === save || (!!key && k.split('#')[0] === key));
    for (const tag of parsePictures(message?.mes || '')) for (const r of tag.spec?.register || []) {
      const route = settings().routes.find(x => sameExact(x.name, r.name) && here(x));
      // Both looks are kept; a role that already has one only gets the one it lacks.
      const patch = {};
      if (r.appearance && !route?.appearance?.trim()) patch.appearance = r.appearance;
      if (r.appearanceNl && !route?.appearanceNl?.trim()) patch.appearanceNl = r.appearanceNl;
      if (!Object.keys(patch).length || added.includes(r.name)) continue;
      try {
        backend.saveRoute(route ? {...route, ...patch} : {name: r.name, engine: 'fish', voice: '', model: '', language: '', ...patch});
        added.push(r.name);
      } catch { /* an unusable name is skipped */ }
    }
    if (added.length) notice(`已记下新角色的外貌：${added.join('、')}。可以在小手机的角色 App 里修改`);
    return added;
  }

  /**
   * Called after a new reply is rendered. 'separate' mode plans its pictures first; then new characters' looks are
   * saved and, when automatic drawing is on and free, all its pictures are queued.
   */
  const afterReplies = new WeakMap(), replyTasks = new Map();
  function prepareReply(id, {retry = false, canDraw = () => true} = {}) {
    const ctx = context(), message = ctx.chat[id], s = settings(), chat = ctx.getCurrentChatId?.() ?? ctx.chatId;
    if (!message || message.is_user || message.is_system) return Promise.resolve();
    const sibling = replyTasks.get(id);
    const old = afterReplies.get(message) || (sibling?.revision?.current() === message ? sibling : null);
    if (old?.running) return old.promise;
    if (old && !retry && old.raw === message.mes && old.swipe === message.swipe_id && old.key === scopeKey()) return old.state === 'failed' ? Promise.resolve({failed: true}) : old.promise;
    const task = {raw: message.mes, swipe: message.swipe_id, running: true, state: 'running', key: scopeKey(), revision: replyRevision(context,id,s.narration,()=>backend.closed?null:backend.space)};
    afterReplies.set(message, task); replyTasks.set(id, task);
    while(replyTasks.size > 16) replyTasks.delete(replyTasks.keys().next().value);
    task.promise = Promise.resolve().then(async () => {
      if (context().chat[id] !== message || message.mes !== task.raw || message.swipe_id !== task.swipe || (context().getCurrentChatId?.() ?? context().chatId) !== chat) return;
      const wantVoice = !!voice?.wanted() && !voice.has(storyScope(message.mes, s.narration).masked);
      const wantPictures = canDraw() && s.draw.enabled && drawSeparate(s.draw) && !parsePictures(message.mes).length;
      if (!wantVoice && !storyScope(message.mes, s.narration).masked.replace(/<[^>]+>/g, '').trim()) return;
      const result = wantVoice || wantPictures ? await planReply(id, {voiced: wantVoice, pictured: wantPictures, phoned: true}) : {written: true};
      task.state = result.written ? 'written' : 'skipped';
      if (result.written) { const now = context().chat[id]; task.raw = now?.mes; if(now) afterReplies.set(now,task); }
      return result;
    }).catch(error => { task.state = 'failed'; throw error; }).finally(() => { task.running = false; });
    return task.promise;
  }
  async function autoPictures(id, canDraw = () => true) {
    if (!canDraw()) return;
    const s = settings(), ctx = context(), message = ctx.chat[id], chat = ctx.getCurrentChatId?.() ?? ctx.chatId, swipe = message?.swipe_id;
    if (!message || message.is_user || message.is_system) return;
    const current = () => {
      const now = context();
      return now.chat[id] === message && message.swipe_id === swipe && (now.getCurrentChatId?.() ?? now.chatId) === chat;
    };
    await prepareReply(id,{canDraw});
    if (!current()) return;
    if (!s.draw.enabled) return;
    registerAppearances(message);
    if (!s.draw.auto) return;
    const tags = parsePictures(message.mes).filter(tag => !stored(message, tag.hash));
    if (!tags.length) return;
    const source = storyDrawSource(s.draw);
    const authorized = () => !!source && settings().draw.storyPaidSource === source && storyDrawSource(settings().draw) === source;
    const valid = () => current() && canDraw() && settings().draw.enabled && settings().draw.auto && storyDrawSource(settings().draw) === source;
    // Subscription lookup can be asynchronous. Recheck the exact branch and connection before queueing.
    if (!backend.drawReady()) return;
    if (!valid()) return;
    let unreadTold = false;
    for (const tag of tags) {
      if (!valid()) break;
      if (s.draw.engine === 'nai') try { await backend.naiSubscription(); } catch { /* A relay may omit subscription details. */ }
      if (!valid() || stored(message,tag.hash)) continue;
      const params = pictureInputs(settings(),tag,message.mes).params;
      let quote = backend.drawQuote(params);
      // (fork) The subscription could not be read (a network hiccup, say): once more before giving up.
      if (quote.free === null) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (s.draw.engine === 'nai') try { await backend.naiSubscription(); } catch { /* as above */ }
        if (!valid() || stored(message,tag.hash)) continue;
        quote = backend.drawQuote(params);
      }
      const isFree = quote.free === true && !quote.paid;
      if (!isFree && !authorized()) {
        // (fork) Said out loud when it is the reading that failed (a picture that may cost is left undrawn without a word otherwise, as meant).
        if (quote.free === null && !unreadTold) {
          unreadTold = true;
          backend.reportDiagnostic?.('正文出图', {message:'自动出图未执行，当前设置无法确认免费额度',engine:s.draw.engine,relay:!!s.draw.relay.url}, 'warn');
          notice('自动出图没有执行：暂时读不到订阅信息，确认不了免不免费。可以点楼层菜单里的「给这层楼生图」手动画');
        }
        continue;
      }
      const stillWanted = () => {
        if (!valid() || !parsePictures(message.mes).some(t => t.hash === tag.hash)) return false;
        if (!isFree) return authorized();
        const currentQuote = backend.drawQuote(params);
        return currentQuote.free === true && !currentQuote.paid;
      };
      await generate(id,tag,{permission:isFree?'free':'paid', valid:stillWanted});
    }
  }

  /** The engine drawing, by its own name (PixAI 反代 speaks NovelAI's interface; it is still not NovelAI). */
  const engineName = () => ({nai: 'NovelAI', gpt: 'GPT 生图', comfy: 'ComfyUI', pixai: 'PixAI 反代'})[settings().draw.engine] || 'NovelAI';

  /** What the queue says about a job, for the placeholder. */
  function queueText(key) {
    const engine = jobs.get(key)?.engine || settings().draw.engine, name = {nai: 'NovelAI', gpt: 'GPT 生图', comfy: 'ComfyUI', pixai: 'PixAI 反代'}[engine] || '绘图服务';
    if (engine !== 'nai') return `${name} 正在画……`;
    const job = backend.drawQueue?.get?.(key);
    if (!job) return `${name} 正在画……`;
    if (job.state === 'running') return job.attempt ? `NovelAI 正在画……（第 ${job.attempt + 1} 次尝试）` : 'NovelAI 正在画……';
    if (job.state === 'busy') return `NovelAI 账号正忙，稍后自动重试（第 ${job.attempt} 次）`;
    if (job.state === 'spacing') return '排队中，马上开始';
    if (job.state === 'remote') {
      const c = job.cloud || {};
      if (c.position > 0) return `云端排队中，前面还有 ${c.position} 位${c.holder ? `（${c.holder} 正在画）` : ''}`;
      return c.cooldown > 5000 ? `账号刚才忙，大家一起等 ${Math.ceil(c.cooldown / 1000)} 秒` : '云端排队，马上轮到你';
    }
    return `排队中，前面还有 ${job.position} 张`;
  }

  function frame(inner) { return `<span class="sttts-pic-frame">${inner}</span>`; }
  // The button bar of an open picture. Showing or hiding it only adds or removes this element: the <img> is not made again,
  // so the picture does not blink (a new <img> is blank until the browser has decoded the whole file again).
  const BAR_HTML = '<span class="sttts-pic-ctl sttts-pic-ctl-on"><button type="button" class="sttts-pic-btn" data-sttts-pic-action="fold">收起</button><span class="sttts-pic-grp"><button type="button" class="sttts-pic-btn" data-sttts-pic-action="gen">生成图片</button><button type="button" class="sttts-pic-btn" data-sttts-pic-action="redo">刷新重绘</button></span></span>';
  const paidButtons = new WeakMap();
  function fill(el, id, message, tag) {
    const record = stored(message, tag.hash), pic = shown(message, tag.hash), key = jobKey(id, tag), job = jobs.get(key);
    const s = settings(), folded = folds.get(id + ':' + tag.hash) ?? s.draw.fold, bar = bars.has(id + ':' + tag.hash);
    const state = job?.state || (pic ? 'done' : record?.removed ? 'removed' : 'idle');
    const waiting = state === 'generating' ? queueText(key) : '';
    const quote = state === 'idle' && s.draw.auto && backend.drawReady() ? backend.drawQuote?.(pictureInputs(s,tag,message.mes).params) : null;
    const reason = state === 'idle' ? (!s.draw.enabled ? '正文出图没有开启' : !backend.drawReady() ? backend.drawMissing() : !s.draw.auto ? '自动出图已关闭' : s.draw.engine === 'gpt' ? 'GPT 生图每张都要花钱' : quote?.free === false || quote?.paid ? '这张图预计会扣点' : quote?.free === null ? '当前连接无法确认免费额度' : '这张图没有自动生成') : '';
    const paidSource = state === 'idle' && s.draw.enabled && s.draw.auto && backend.drawReady() &&
      (s.draw.engine === 'gpt' || quote?.free === false || quote?.free === null) ? storyDrawSource(s.draw) : '';
    const signature = JSON.stringify([paidSource, state, pic?.url, pic?.count, folded, bar, waiting, job?.message, reason]);
    if (el.dataset.stttsRendered === signature) return;
    el.dataset.stttsRendered = signature;
    el.dataset.state = state;
    el.toggleAttribute('data-folded', state === 'done' && folded);
    const open = state === 'done' && !folded, shownImg = open ? el.querySelector('.sttts-pic-card[data-collapsed="false"] .sttts-pic-zoom img') : null;
    if (open && shownImg && el.stttsOpen === pic.url + '|' + pic.count) {
      // Same picture, still open: only the bar changed.
      const card = el.querySelector('.sttts-pic-card'), ctl = card.querySelector(':scope > .sttts-pic-ctl');
      if (bar && !ctl) card.insertAdjacentHTML('afterbegin', BAR_HTML); else if (!bar && ctl) ctl.remove();
      return;
    }
    el.stttsOpen = '';
    if (state === 'done' && folded) {
      // The 砂糖生图 card, folded: only its bar, with one button that says what it is (the plugin's own words).
      el.innerHTML = `<span class="sttts-pic-card" data-collapsed="true"><span class="sttts-pic-ctl"><button type="button" class="sttts-pic-btn" data-sttts-pic-action="unfold" aria-label="展开图片"><span class="sttts-pic-fold-mark" aria-hidden="true">▸</span>图片已收起${pic.count > 1 ? ` · ${pic.count} 个版本` : ''} · 点一下展开</button></span></span>`;
    } else if (state === 'done') {
      el.innerHTML = `<span class="sttts-pic-card" data-collapsed="false">${bar ? BAR_HTML : ''}<span class="sttts-pic-body"><button type="button" class="sttts-pic-zoom" data-sttts-pic-action="tap" aria-label="点一下显示按钮，再点一下放大查看${pic.count > 1 ? `（${pic.count} 个版本）` : ''}、参数和操作"><img src="${esc(pic.url)}" alt="${esc(tag.prompt)}" loading="lazy"></button></span></span>`;
      // Folding and opening again brings back the same <img> (already decoded) instead of a new one.
      const fresh = el.querySelector('.sttts-pic-zoom img'), kept = el.stttsImg;
      if (kept && kept.getAttribute('src') === pic.url && kept.complete && kept.naturalWidth) fresh.replaceWith(kept); else el.stttsImg = fresh;
      el.stttsOpen = pic.url + '|' + pic.count;
    } else if (state === 'removed') {
      el.innerHTML = `<span class="sttts-pic-removed">图片已删除<button type="button" data-sttts-pic-action="draw">重新生成</button></span>`;
    } else if (state === 'generating') {
      // Redrawing keeps the current picture on screen with a small note over it.
      el.innerHTML = pic
        ? frame(`<button type="button" class="sttts-pic-zoom" data-sttts-pic-action="tap" aria-label="点一下显示按钮，再点一下放大查看"><img src="${esc(pic.url)}" alt="${esc(tag.prompt)}" loading="lazy"></button><span class="sttts-pic-note">${esc(waiting)}<button type="button" data-sttts-pic-action="cancel">取消</button></span>`)
        : frame(`<span class="sttts-pic-wait">${esc(waiting)}<br><button type="button" data-sttts-pic-action="cancel">取消</button></span>`);
    } else if (state === 'error') {
      const again = backend.pixaiRecoverable?.(key) && settings().draw.engine === 'pixai';
      el.innerHTML = frame(`<span class="sttts-pic-wait">${esc(job.message)}${again ? '<br>反代那边可能已经画好了，可以直接取回（不重画、不再扣积分）' : ''}<br><button type="button" data-sttts-pic-action="draw">${again ? '重新获取' : '重试'}</button></span>`);
    } else {
      const reason = !s.draw.enabled ? '正文出图没有开启' : !backend.drawReady() ? backend.drawMissing() : !s.draw.auto ? '自动出图已关闭' : s.draw.engine === 'gpt' && s.draw.gpt.ask ? 'GPT 生图每张都要花钱，点了才画' : '这张图没有自动生成';
      const again = backend.pixaiRecoverable?.(key) && s.draw.engine === 'pixai';
      el.innerHTML = frame(again ? `<span class="sttts-pic-wait">这张图刚才没有收到，PixAI 反代那边可能已经画好了<br><button type="button" data-sttts-pic-action="draw">重新获取</button></span>` : `<span class="sttts-pic-wait">${esc(reason)}<br><button type="button" data-sttts-pic-action="draw">${paidSource ? '同意可能扣点并生成' : '点击生成'}</button></span>`);
      if (paidSource) paidButtons.set(el.querySelector('button'), paidSource);
    }
  }

  /** Fills every picture placeholder in the rendered chat. The tavern's sanitizer renames classes in messages
   *  (sttts-pic becomes custom-sttts-pic), so placeholders are found by their data attributes. */
  function decorate(currentMessage) {
    for (const element of document.querySelectorAll('#chat .mes[mesid]')) {
      const placeholders = element.querySelectorAll('[data-sttts-pic]');
      if (!placeholders.length) continue;
      const id = Number(element.getAttribute('mesid')), message = context().chat[id];
      if (!message || !currentMessage(id)) continue;
      const tags = parsePictures(message.mes);
      for (const el of placeholders) {
        if (el.dataset.stttsToken !== marker) continue;
        const tag = tags.find(t => t.hash === el.dataset.stttsHash);
        if (tag) fill(el, id, message, tag);
      }
    }
  }

  /** Handles clicks inside picture blocks. Returns true when the click was ours. */
  function click(event) {
    // The button bar goes away only when the tap is outside the picture it belongs to.
    if (bars.size) {
      const inside = event.target?.closest?.('[data-sttts-pic]'), mine = inside && inside.dataset.stttsToken === marker ? Number(inside.closest('.mes[mesid]')?.getAttribute('mesid')) + ':' + inside.dataset.stttsHash : null;
      let hidden = false;
      for (const key of [...bars]) if (key !== mine) { bars.delete(key); hidden = true; }
      if (hidden) scheduleRender();
    }
    const button = event.target.closest('[data-sttts-pic-action]');
    const box = button?.closest('[data-sttts-pic]');
    if (!box || box.dataset.stttsToken !== marker) return false;
    event.preventDefault();
    const id = Number(box.closest('.mes[mesid]')?.getAttribute('mesid')), message = context().chat[id];
    const tag = message && parsePictures(message.mes).find(t => t.hash === box.dataset.stttsHash);
    if (!tag) return true;
    if (button.dataset.stttsPicAction === 'tap') tap(id, message, tag, button);
    else act(button.dataset.stttsPicAction, id, message, tag, button);
    return true;
  }
  /** A tap on a picture shows its button bar at once; a tap while the bar is showing opens the viewer. There is no double tap to wait for. */
  function tap(id, message, tag, source) {
    if (bars.has(id + ':' + tag.hash)) act('zoom', id, message, tag, source.closest('[data-sttts-pic]')?.querySelector('img') ? source : null);
    else act('bar', id, message, tag);
  }
  function act(action, id, message, tag, source = null) {
    const pic = shown(message, tag.hash);
    if (action === 'draw' || action === 'redo') {
      bars.delete(id + ':' + tag.hash);
      const paidSource = paidButtons.get(source);
      if (paidSource && paidSource === storyDrawSource(settings().draw)) {
        const swipe = message.swipe_id;
        const valid = () => context().chat[id] === message && message.swipe_id === swipe && backend.drawReady() &&
          storyDrawSource(settings().draw) === paidSource && parsePictures(message.mes).some(t => t.hash === tag.hash);
        generate(id, tag, {permission: 'paid', valid});
      } else generate(id, tag, {interactive: true});
    }
    if (action === 'cancel') backend.drawQueue?.cancel?.(jobKey(id, tag));
    if (action === 'open') openDraw({...pictureInputs(settings(), tag, message.mes), tag: tag.prompt, seed: pic?.seed});
    if (action === 'fold' || action === 'unfold') { const key = id + ':' + tag.hash; folds.set(key, action === 'fold'); if (action === 'unfold') bars.add(key); else bars.delete(key); scheduleRender(); }
    if (action === 'bar') { bars.add(id + ':' + tag.hash); scheduleRender(); }
    if ((action === 'prev' || action === 'next') && pic) {
      keep(message, tag.hash, versionsOf(stored(message, tag.hash)), pic.index + (action === 'next' ? 1 : -1));
      saveSoon();
      scheduleRender();
    }
    if (action === 'zoom' && pic) {
      let viewer; const swipe=message.swipe_id;
      const list = versionsOf(stored(message, tag.hash));
      // Paging in the viewer also changes which version the chat shows.
      const pick = i => { if (i !== shown(message, tag.hash)?.index) { keep(message, tag.hash, list, i); saveSoon(); scheduleRender(); } };
      Promise.all([viewerCode(), Promise.resolve(backend.favoritePhotoIds?.()).catch(() => null)]).then(([{openImageViewer}, ids]) => (hearts = new Set(ids || []), viewer=openImageViewer({doc: document, from: source?.querySelector?.('img') || source,
        gallery: {items: list.map(v => ({src: v.url, alt: tag.prompt, info: pictureInfo(v, tag)})), index: pic.index, onIndex: pick},
        actions: [
          {label: i => list[i].photoId && hearts.has(list[i].photoId) ? '♥ 已收藏' : '♡ 收藏', run: i => toggleHeart(message, tag, list, i).then(() => false, error => { notice(error.message); return false; })},
          downloadAction(document, i => ({source: list[i].url, name: [(list[i].characters || []).join('、') || context()?.name2 || 'ST-iPhonie', list[i].seed].filter(v => v !== undefined && v !== '').join('_')}), notice),
          {label: '重画', run: () => act('redo', id, message, tag)},
          {label: '改提示词再画', run: () => rewrite(id, tag).then(ok => ok ? undefined : false, error => { notice(error.message); return false; })},
          {label: '在绘图中打开', run: () => act('open', id, message, tag)},
          {label: '收起', run: () => act('fold', id, message, tag)},
          {label: '删除这版', danger: true, run: i => { pick(i); return remove(id, tag).then(done => done ? undefined : false, error => { notice(error.message); return false; }); }},
          {label:'替换图片',run:()=>replacePicture(storyPickerContext(document,notice),backend.api(),()=>viewer.close(),async photoId=>{
            const photo=await backend.library.getPhoto(photoId);
            if(!photo?.blob) throw Error('图片已不存在');
            const url=await upload(photo.blob,'st-iphonie-'+Date.now());
            if(context().chat[id]!==message || message.swipe_id!==swipe || !parsePictures(message.mes).some(t=>t.hash===tag.hash)) {
              await removeFile(url).catch(()=>{});
              throw Error('正文已变化，请重新打开插图');
            }
            const versions=[...versionsOf(stored(message,tag.hash)),{url,photoId,at:Date.now(),prompt:tag.prompt}];
            const previous=stored(message,tag.hash);
            keep(message,tag.hash,versions,versions.length-1);
            const changed=stored(message,tag.hash);
            try { await context().saveChat(); }
            catch(error) {
              if(stored(message,tag.hash)===changed) message.extra.sttts_pics[tag.hash]=previous;
              throw error;
            }
            scheduleRender();
          }).run()}
        ]}))).catch(error => notice(error.message));
    }
    if (action === 'delete') remove(id, tag).catch(error => notice(error.message));
  }
  /** The 参数 panel of the viewer for one version. */
  function pictureInfo(v, tag) {
    return [
      ['画风', v.style || ''],
      ['模型', NAI_MODEL_NAMES?.[v.model] || v.model],
      ['尺寸', v.width && v.height ? `${v.width} × ${v.height}` : ''],
      ['步数', v.steps],
      ['种子', v.seed],
      ['角色', v.characters ? (v.characters.length ? v.characters.join('、') : '没有补角色外貌') : ''],
      ['画于', v.at ? new Date(v.at).toLocaleString('zh-CN', {hour12: false}) : ''],
      ['出图块', tag.spec ? tag.body || '' : tag.prompt]
    ];
  }
  /** Deletes the version on screen (file and record). Returns false when the user cancels. */
  /** Reads a picture's English tags in Chinese ('translate'), or changes them the way the user says ('revise'), with the phone's text model. */
  /**
   * 从聊天读取: what this chat says about one role's looks and what she wears now. The text model reads the card and the
   * latest messages; nothing is saved here, the role page shows the answer and the person decides.
   */
  async function readLook(name) {
    name = String(name || '').trim();
    if (!name) throw Error('先写角色名');
    const ctx = context(), chat = ctx.chat || [];
    const lines = [];
    for (const m of chat.slice(-40)) {
      if (!m || m.is_system) continue;
      const text = plainStory(withoutPictures(m.mes || ''), [], settings().narration);
      if (text) lines.push(`${m.name || (m.is_user ? '我' : '角色')}：${text.slice(0, 700)}`);
    }
    if (!lines.length) throw Error('这个聊天里还没有内容可读');
    const card = ctx.characters?.[ctx.characterId], cardText = card ? [card.description, card.personality, card.scenario].filter(Boolean).join('\n').slice(0, 2500) : '';
    const prompt = [
      `你是出图提示词助手。读下面的角色卡和聊天，只写「${name}」这一个人。`,
      '输出恰好三行，不要别的话、不要引号、不要代码块：',
      '外貌：她固定的样子，用英文 tag，逗号分隔：发型发色、眼睛、体型、肤色、固定的特征（痣、疤、耳朵等）。不写衣服、配饰、表情、动作。',
      '自然语言：同样的外貌，写成一两句中文，不用 tag：年龄和性别、发型发色、瞳色、体型、肤色、固定的特征。同样不写衣服、配饰、表情、动作，内容和上一行一致。',
      outfitNl() ? '服装：聊天最后她身上穿戴的衣服和配饰，写成一句中文自然语言（如「白色护士服，肉色丝袜」），不用 tag。聊天里没有说，或脱了、没穿，就留空。' : '服装：聊天最后她身上穿戴的衣服和配饰，用英文 tag，逗号分隔。聊天里没有说，或脱了、没穿，就留空。',
      '只写文字里明确说了的；颜色写明了就原样用，没写的不要编。',
      '',
      cardText ? `【角色卡】\n${cardText}\n` : '',
      `【聊天，旧到新】\n${lines.join('\n')}`
    ].filter(x => x !== '').join('\n');
    const answer = await backend.generateText(ctx, {use: 'picture', prompt, plainText: true, trimNames: false, responseLength: 600});
    const text = String(answer || '');
    const pick = key => (text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*[:：]\\s*(.*)`)) || [])[1]?.trim().replace(/^["「]|["」]$/g, '').replace(/[,，]\s*$/, '') || '';
    const appearance = pick('外貌'), appearanceNl = pick('自然语言'), outfit = pick('服装');
    if (!appearance && !appearanceNl && !outfit) throw Error('模型没有读出内容，再试一次');
    return {appearance, appearanceNl, outfit};
  }
  /**
   * 补全另一栏: writes the look a role lacks from the one it has (the tags as a Chinese sentence, or the sentence as English
   * tags). Nothing is saved here; the role page shows the answer.
   */
  async function completeLook({name = '', appearance = '', appearanceNl = '', to = 'nl'} = {}) {
    const toNl = to === 'nl', source = String(toNl ? appearance : appearanceNl).trim();
    if (!source) throw Error('先写好另一栏');
    const prompt = (toNl ? [
      '你是出图提示词助手。把下面这个角色的外貌 tag 写成一两句中文自然语言外貌，只输出这一段，不要解释、不要引号、不要代码块。',
      '只写 tag 里有的固定特征：年龄和性别、发型发色、瞳色、体型、肤色、显眼的特征；不要编造，不写衣服、表情、动作。'
    ] : [
      '你是出图提示词助手。把下面这个角色的中文外貌描述写成英文 tag，逗号分隔，只输出这一行，不要解释、不要引号、不要代码块。',
      '第一个 tag 是 1girl 或 1boy（按描述判断），然后是发型发色、眼睛、体型、肤色、显眼的特征；不要编造，不写衣服、表情、动作。'
    ]).concat(name ? [`角色：${name}`] : [], [`【${toNl ? '外貌 tag' : '中文外貌'}】`, source]).join('\n');
    const answer = await backend.generateText(context(), {use: 'picture', prompt, plainText: true, trimNames: false, responseLength: 500});
    const text = String(answer || '').trim().replace(/^(?:外貌 tag|外貌|自然语言)\s*[:：]\s*/, '').replace(/^["「]|["」]$/g, '').replace(/\s*\n+\s*/g, toNl ? '' : ', ');
    if (!text) throw Error('模型没有回内容，再试一次');
    return text;
  }
  async function tagText(text, mode, wish = '') {
    if (!String(text).trim()) throw Error('框里是空的');
    const answer = tagTextAnswer(await backend.generateText(context(), {use: 'picture', prompt: tagTextRequest(settings(), text, mode, wish), plainText: true, trimNames: false, responseLength: Math.min(6000, 1500 + String(text).length * 3)}));
    if (!answer) throw Error('模型没有回内容，再试一次');
    return answer;
  }
  /**
   * 改提示词再画: the tag's prompt (a whole block, or the tags) is changed in the message itself, so it stays changed,
   * and drawn again. The versions drawn before stay with it, to compare.
   */
  async function rewrite(id, tag) {
    const message = context().chat[id];
    if (!message || !parsePictures(message.mes).some(t => t.hash === tag.hash)) throw Error('这条消息已经变了，找不到这张图');
    const before = tag.spec ? tag.body : tag.prompt;
    const after = await editTags({doc: document, text: before, ask: tagText,
      about: tag.spec ? '整个出图块都能改：场景、角色、站位。改的会写回正文里，以后重画也用它；之前画的几版还在，可以左右滑着比。' : '画这张图用的英文 tag。改的会写回正文里；之前画的几版还在，可以左右滑着比。'});
    const value = after?.trim();
    if (!value) return false;
    const now = context().chat[id];
    if (now !== message || !parsePictures(message.mes).some(t => t.hash === tag.hash)) throw Error('这条消息已经变了，找不到这张图');
    let fresh = tag;
    if (value !== before.trim()) {
      const segment = message.mes.slice(tag.start, tag.end), at = segment.indexOf(before);
      if (!before || at < 0) throw Error('没在正文里找到这张图的提示词');
      // In prompt="…" a double quote would end it; tags never need angle brackets.
      const delimiter = /\bprompt\s*=\s*(["'“])/i.exec(segment.slice(0, at))?.[1];
      const safe = tag.spec ? value.replace(/<\/?(?:i-img|img)(?=[\s/>])/gi, '') : value.replace(/[<>]/g, '').replace(delimiter === "'" ? /'/g : delimiter === '“' ? /”/g : /"/g, delimiter === "'" ? '’' : "'");
      const proposed = message.mes.slice(0, tag.start) + segment.slice(0, at) + safe + segment.slice(at + before.length) + message.mes.slice(tag.end);
      fresh = parsePictures(proposed).find(t => t.index === tag.index);
      if (!fresh) throw Error('改完认不出这张图了，检查一下格式');
      message.mes = proposed;
      if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipes[message.swipe_id] != null) message.swipes[message.swipe_id] = proposed;
      const record = stored(message, tag.hash);
      if (record && fresh.hash !== tag.hash) { message.extra.sttts_pics[fresh.hash] = record; delete message.extra.sttts_pics[tag.hash]; }
      await context().saveChat();
      redrawMessage(id, message);
      scheduleRender();
    }
    generate(id, fresh, {interactive: true});
    return true;
  }
  async function remove(id, tag) {
    const message = context().chat[id], pic = shown(message, tag.hash);
    const others = pic ? pic.count - 1 : 0;
    if (!pic || !globalThis.confirm(`删除这张图？图片文件也会从酒馆删除。${others ? `这个标签还有 ${others} 个别的版本。` : '之后可以点“重新生成”再画。'}`)) return false;
    await removeFile(pic.url);
    const list = versionsOf(stored(message, tag.hash)).filter((_, i) => i !== pic.index);
    keep(message, tag.hash, list, pic.index - 1);
    await context().saveChat();
    scheduleRender();
    return true;
  }
  /** Pictures stored in the open chat, counting every version. */
  function pictureStats() {
    let count = 0;
    for (const m of context()?.chat || []) for (const record of Object.values(m?.extra?.sttts_pics || {})) count += versionsOf(record).length;
    return {count};
  }
  /** Deletes every picture (all versions) of the open chat from the tavern; their tags show "点击生成" again. */
  async function clearPictures() {
    const ctx = context();
    let count = 0, failed = 0;
    for (const m of ctx.chat || []) {
      const pics = m?.extra?.sttts_pics;
      if (!pics) continue;
      for (const record of Object.values(pics)) for (const version of versionsOf(record)) {
        try { await removeFile(version.url); count++; } catch { failed++; }
      }
      delete m.extra.sttts_pics;
    }
    await ctx.saveChat();
    scheduleRender();
    return {count, failed};
  }

  // ---------- Bridge helpers for the phone ----------
  function recentMessages(limit = 8) {
    const chat = context().chat, rows = [];
    for (let id = chat.length - 1; id >= 0 && rows.length < limit; id--) {
      const m = chat[id];
      if (!m || m.is_system) continue;
      rows.push({id, name: m.name || (m.is_user ? '我' : '角色'), user: !!m.is_user, preview: String(m.mes || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 60)});
    }
    return rows;
  }
  async function insertImage(id, photoId) {
    const ctx = context(), message = ctx.chat[id];
    if (!message) throw Error('这条消息已经不存在');
    const photo = await backend.library.getPhoto(photoId);
    if (!photo) throw Error('图片已不在相册中');
    const url = await upload(photo.blob, 'st-iphonie-' + Date.now());
    message.extra ??= {};
    if (!Array.isArray(message.extra.media)) message.extra.media = [];
    message.extra.inline_image = !(message.extra.media.length && !message.extra.inline_image);
    message.extra.media.push({url, type: 'image', title: photo.name, source: 'generated'});
    message.extra.media_index = message.extra.media.length - 1;
    const element = globalThis.$?.(`#chat .mes[mesid="${id}"]`);
    if (element?.length && ctx.appendMediaToMessage) ctx.appendMediaToMessage(message, element);
    await ctx.saveChat();
    return {id, url};
  }
  /** One selected scene, inserted only after its original paragraph and only in its original reply version. */
  async function drawSelection({snap, text, end, context: nearby = ''}) {
    const ctx=context(), message=ctx.chat[snap.id], chat=ctx.getCurrentChatId?.()??ctx.chatId;
    const guard=backend.spaceGuard?.() || (()=>true);
    const valid=()=>guard() && chat===snap.chat && (context().getCurrentChatId?.()??context().chatId)===chat && context().chat[snap.id]===message && message===snap.message && message?.mes===snap.raw && message?.swipe_id===snap.swipe;
    if(!valid() || !text?.trim() || !Number.isInteger(end) || end<0 || end>snap.raw.length)throw Error('正文已经变化，请重新选择文字');
    if(selectionJobs.has(message))throw Error('正在为这条回复的选段生图');
    const old=parsePictures(snap.raw);
    if(afterReplies.get(message)?.running || planning.has(snap.id) || old.some(t=>jobs.get(jobKey(snap.id,t))?.state==='generating'))throw Error('这条回复正在处理，请稍后再试');
    selectionJobs.add(message);
    try {
      const permission=await allowed(true);if(!permission)return;
      if(!valid())throw Error('正文已经变化，请重新选择文字');
      notice('正在为选中文字构思画面……');
      const state=settings(), prompt=selectionRequest(state,{text,nearby,only:castNow()});
      const reply=await backend.generateText(ctx,{use:'picture',prompt,plainText:true,trimNames:false,responseLength:promptLength(state)});
      if(!valid())throw Error('正文已经变化，旧的选段任务已停止');
      const block=selectionBlock(state,reply);
      const addition='\n\n'+block+'\n', raw=snap.raw.slice(0,end)+addition+snap.raw.slice(end), tags=parsePictures(raw), tag=tags.find(t=>t.start===end+2);
      if(!tag)throw Error('这次提示词无法作为正文图片保存');
      const inputs=pictureInputs(settings(),tag,raw);
      const result=await backend.generateImage({...inputs,allowPaid:permission==='paid',name:'chat',key:'selection:'+snap.id+':'+end,label:'选段生图 · '+text.slice(0,24)});
      if(!valid()){notice('正文已变化，生成的图片已保留在相册，没有插入旧位置');return;}
      const url=await upload(result.blob,'st-iphonie-'+Date.now());
      if(!valid()){notice('正文已变化，生成的图片已保留在相册，没有插入旧位置');return;}
      const previous=structuredClone(message.extra?.sttts_pics||{}),pics={...previous};
      for(const t of old)delete pics[t.hash];
      for(const t of old){const next=tags.find(n=>n.start===t.start+(t.start>=end?addition.length:0));if(next && previous[t.hash])pics[next.hash]=previous[t.hash];}
      pics[tag.hash]={versions:[{url,photoId:result.photoId,seed:result.seed,width:result.params.width,height:result.params.height,model:result.params.model,style:result.style,prompt:tag.prompt,characters:inputs.names,at:Date.now()}],index:0};
      message.mes=raw;message.extra??={};message.extra.sttts_pics=pics;
      if(Array.isArray(message.swipes))message.swipes[message.swipe_id??0]=raw;
      try{await context().saveChat();}catch(error){
        if(context().chat[snap.id]===message && message.mes===raw){message.mes=snap.raw;message.extra.sttts_pics=previous;if(Array.isArray(message.swipes))message.swipes[snap.swipe??0]=snap.raw;}
        throw Error('图片已保留在相册，但正文保存失败：'+error.message);
      }
      if(context().chat[snap.id]===message)redrawMessage(snap.id,message);
      scheduleRender();
    } finally {selectionJobs.delete(message);}
  }
  async function suggestPrompt() {
    // The same text model as everything else in the phone (引擎 → 文字模型): the tavern's model without its story
    // preset, or the custom API. The tavern's quiet generation would carry the whole story preset, and with it a
    // chain of thought or XML template the model then writes out.
    const ctx = context(), chat = ctx.chat || [];
    const prompt = suggestRequest(settings(), {before: before(chat.length, 6), only: castNow()});
    const reply = await backend.generateText(ctx, {use: 'picture', prompt, plainText: true, trimNames: false, responseLength: promptLength(settings())});
    const result = readSuggestion(settings(), reply);
    if (!result.prompt) throw Error('模型没有写出提示词，再试一次');
    return withCount(result);
  }
  /**
   * A line written up to the NovelAI budget. Models cannot count tokens and often stop at half: the line is counted
   * with NovelAI's own tokenizer and, while it holds less than three quarters of the room, the model is asked (twice at
   * most) to add detail. A longer answer that would go over the limit is not taken. {prompt, people, tokens, budget}.
   */
  /** The line with how many NovelAI tokens it holds, and the room it had ({tokens, budget}; none without NovelAI). */
  async function withCount(result, cast = []) { return fillUp(null, result, cast); }
  async function fillUp(prompt, first, cast = []) {
    const s = settings(), b = s.draw?.engine === 'nai' ? tokenBudget(s.draw.params?.model) : null;
    if (!b) return first;
    let count = estimateTokens;
    try { count = await loadCounter(b.kind); } catch { /* no tokenizer: estimated */ }
    const n = budgetNumbers(s);
    if (!n) return first;
    // The looks of the people already in 角色 come out of the same room.
    const looks = s.routes.filter(r => lookOf(s, r) && cast.some(c => sameName(c, r.name))).reduce((sum, r) => sum + countField(count, lookOf(s, r)), 0);
    const left = Math.max(0, n.left - looks);
    let result = first, used = countField(count, first.prompt), messages = prompt;
    for (let round = 0; prompt && round < 2 && used < left * 0.75; round++) {
      messages = fillUpRequest(messages, {prompts: s.promptRules, line: result.prompt, people: result.people, used, left, tags: Math.floor((left - used) / tagCost(count)), sentences: sentenceCount(s)});
      let more;
      try { more = readSuggestion(s, await backend.generateText(context(), {use: 'picture', prompt: messages, plainText: true, trimNames: false, responseLength: promptLength(s)})); } catch { break; }
      const now = countField(count, more.prompt);
      if (!more.prompt || now <= used || now > left) break;
      result = {prompt: more.prompt, people: [...new Set([...result.people, ...more.people])]};
      used = now;
    }
    return {...result, tokens: used, budget: left};
  }
  /** 帮我写: a prompt line for what the user describes (a few words, Chinese is fine). */
  async function writePrompt(idea, cast = [], {explicitCast = false, describedLook = ''} = {}) {
    if (!String(idea || '').trim()) throw Error('先说说想画什么');
    const names = (Array.isArray(cast) ? cast : []).map(String).slice(0, 8), prompt = writeRequest(settings(), {idea, cast: names, only: explicitCast ? [] : castNow(), explicitCast, describedLook: String(describedLook || '').trim().slice(0, 1500)});
    const reply = await backend.generateText(context(), {use: 'picture', prompt, plainText: true, trimNames: false, responseLength: promptLength(settings())});
    const result = readSuggestion(settings(), reply);
    if (!result.prompt) throw Error('模型没有写出提示词，再试一次');
    // Filled up to the limit only when the idea asks for it; otherwise a precise line of whatever length it takes.
    return /写满|填满|上限|尽量(多|长|详细)|越(多|长)越好|\d{3,4}\s*token/i.test(String(idea)) ? fillUp(prompt, result, names) : withCount(result, names);
  }
  const subscriptionLabel = sub => sub ? `${TIER_NAMES[sub.tier] || '未知档位'} · Anlas ${sub.anlas}` : '';

  /** The newest reply from a character: plan its pictures again ('separate') and queue them. */
  async function planLatest() {
    const chat = context().chat;
    for (let id = chat.length - 1; id >= 0; id--) {
      const m = chat[id];
      if (!m || m.is_user || m.is_system) continue;
      const done = await planPictures(id, {force: true});
      if (done) { registerAppearances(context().chat[id]); if (settings().draw.auto) await autoPictures(id); }
      return done;
    }
    throw Error('聊天里还没有角色的回复');
  }
  /** A reply from a character (给这层楼配音): voice its lines again with 回复后单独配音's request, replacing the ones there. */
  async function voiceMessage(id) {
    const current = context().chat[id], task = current && afterReplies.get(current);
    if (task?.running) {
      const selected = replyRevision(context, id, settings().narration, () => backend.closed ? null : backend.space);
      const done = await task.promise.catch(() => null);
      const now = selected?.current();
      if (!now || (!selected.target() && !(done?.written && task.revision.current() === now && task.raw === now.mes))) throw Error('楼层内容已变化，请重新选择');
      if (done?.voiced) return done.voiced;
    }
    const m = context().chat[id];
    if (!m || m.is_user || m.is_system) throw Error('这层楼不是角色的回复');
    if (!voice) throw Error('配音没有开');
    // Strip only the working text; the live reply stays intact until a valid answer is committed.
    const {voiced, skipped} = await planReply(id, {voiced: true, pictured: false, revoice: !!voice.has(m.mes)});
    if (skipped) throw Error('楼层内容已变化，请重新选择');
    return voiced;
  }
  /** The newest reply from a character: voice its lines again (设置 → 正文 → 正文语音 → 给最新回复配音). */
  async function voiceLatest() {
    const chat = context().chat;
    for (let id = chat.length - 1; id >= 0; id--) {
      const m = chat[id];
      if (!m || m.is_user || m.is_system) continue;
      return voiceMessage(id);
    }
    throw Error('聊天里还没有角色的回复');
  }

  async function drawMessage(id) {
    const message = context().chat[id];
    if (!storyReply(message)) throw Error('找不到这层楼的回复');
    if (!backend.drawReady()) throw Error('请先在小手机的绘图 App 配好绘图接口');
    if (!parsePictures(message.mes).length && !await planPictures(id)) return;
    if (context().chat[id] !== message) return;
    const tags = parsePictures(message.mes).filter(tag => !shown(message, tag.hash));
    if (!tags.length) { notice('这层楼的图片已经生成'); return; }
    const permission = await allowed(true); if (!permission) return;
    for (const tag of tags) { if (context().chat[id] !== message) break; await generate(id, tag, {permission}); }
  }
  /** 重新配图: every picture of the reply drawn once more from the blocks it has (people's looks are read again now); each lands as a new version. */
  async function redrawAll(id) {
    const message = context().chat[id];
    if (!storyReply(message)) throw Error('找不到这层楼的回复');
    if (!backend.drawReady()) throw Error('请先在小手机的绘图 App 配好绘图接口');
    const tags = parsePictures(message.mes);
    if (!tags.length) return drawMessage(id);
    const permission = await allowed(true); if (!permission) return;
    for (const tag of tags) { if (context().chat[id] !== message) break; await generate(id, tag, {permission, interactive: true}); }
  }
  /** 重新生成提示词: the model picks the moments and writes the blocks again (old blocks dropped), then the pictures are drawn. */
  async function replanAndDraw(id) {
    const message = context().chat[id];
    if (!storyReply(message)) throw Error('找不到这层楼的回复');
    if (!backend.drawReady()) throw Error('请先在小手机的绘图 App 配好绘图接口');
    if (!await planPictures(id, {force: true})) return;
    registerAppearances(context().chat[id]);
    await drawMessage(id);
  }
  return {outfitNatural: outfitNl, redrawAll, replanAndDraw, drawFor, tagText, readLook, completeLook, drawSelection, drawMessage, prepareReply, outfitsList, outfitSave, outfitAt, outfitDelete, outfitsClear, decorate, click, autoPictures, planPictures, planLatest, voiceLatest, voiceMessage, registerAppearances, recentMessages, insertImage, suggestPrompt, writePrompt, subscriptionLabel, pictureStats, clearPictures};
}
