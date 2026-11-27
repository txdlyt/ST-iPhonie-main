// 漫画 on the tavern page: a story message → a storyboard written by the text model → every page drawn by the 绘图 App →
// the words laid on → the pages kept as a comic on the 书架 (core/comic.js, core/comic-canvas.js).
import {plainStory} from './core/chat.js';
import {writeZip} from './core/model-files.js';
import {openBook} from './core/bookshelf.js';
import {comicRequest, parseComic, pageTags, pageCharacters, COMIC_NEGATIVE, clampPages} from './core/comic.js';
import {composePage} from './core/comic-canvas.js';
import {normalizeComic, comicTags, canvasOptions} from './core/comic-settings.js';

/** drawFor: host-pictures.js drawFor (a picture drawn like one in the story). notice(text): a line shown to the person. */
export function createComicHost({context, settings, backend, drawFor, notice, doc = globalThis.document}) {
  const running = new Set();
  /** The pages as one comic file on the shelf. */
  async function shelve(title, blobs) {
    const files = [];
    for (let i = 0; i < blobs.length; i++) files.push({path: String(i + 1).padStart(3, '0') + '.png', bytes: new Uint8Array(await blobs[i].arrayBuffer())});
    const zip = writeZip(files), name = title.replace(/[\\/:*?"<>|]/g, '').trim() + '.cbz';
    const book = await openBook(zip, name, doc.defaultView.DOMParser);
    return backend.bookshelf.add({name, title, author: '小手机', type: book.type, estimatedPages: book.estimatedPages,
      chapters: book.chapters.map(c => c.image ? {title: c.title, source: c.source, image: c.image} : {title: c.title})}, zip, book.cover ? await book.image(book.cover) : null);
  }
  /** Draws message `id` as a comic; resolves to the book on the shelf (or null when it was already being drawn). */
  async function drawMessage(id, {pages} = {}) {
    const ctx = context(), message = ctx?.chat?.[id];
    if (!message) throw Error('这层楼已经不在了');
    if (running.has(message)) { notice('这一楼的漫画正在画'); return null; }
    const story = plainStory(message.mes || '', [], settings().narration || {});
    if (!story.trim()) throw Error('这一楼没有可以画的文字');
    if (!backend.drawReady()) throw Error(backend.drawMissing() || '绘图引擎还没设好');
    running.add(message);
    try {
      const set = normalizeComic(settings().comic), names = [...new Set([...(settings().routes || []).map(r => r?.name), ctx.name1, ctx.name2].filter(Boolean))], count = Number(pages) > 0 ? clampPages(pages) : 0; // 0: the model decides
      notice('漫画：正在写分镜…');
      const reply = await backend.generateText(ctx, {use: 'picture', prompt: comicRequest({story, names, pages: count, comic: set}), plainText: true, trimNames: false, responseLength: 3500});
      const comic = parseComic(reply, {maxPages: count || undefined, comic: set}), made = [];
      let failure = null;
      for (let i = 0; i < comic.pages.length; i++) {
        try {
          if (context()?.chat?.[id] !== message) throw Error('聊天已切换');
          notice(`漫画：正在画第 ${i + 1}/${comic.pages.length} 页…`);
          const page = comic.pages[i];
          const drawn = await drawFor({prompt: pageTags(page, set), negative: [COMIC_NEGATIVE, comicTags(set).negative].filter(Boolean).join(', '), characters: pageCharacters(page), size: '竖', from: '漫画'});
          made.push(await composePage(drawn.blob, page, {doc, ...canvasOptions(set)}));
        } catch (error) { failure = {page: i + 1, error}; break; }
      }
      if (!made.length) throw failure.error;
      const book = await shelve(comic.title || `${message.name || '故事'}的漫画`, made);
      notice(failure ? `漫画：画了 ${made.length}/${comic.pages.length} 页，第 ${failure.page} 页没画成（${failure.error.message}），已放进书架` : `漫画画好了，共 ${made.length} 页，已放进书架`);
      return book;
    } finally { running.delete(message); }
  }
  return {drawMessage};
}
