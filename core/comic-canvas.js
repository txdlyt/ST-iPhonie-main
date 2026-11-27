// 漫画: the words laid on a drawn page — a balloon for speech, a dashed one for thoughts, a box for narration — in each
// panel's place (core/comic.js panelRects). The picture is never redrawn: this only writes on a copy of it.
import {panelRects} from './comic.js';

/** Words broken into lines no wider than `width` (a character at a time: it suits Chinese, and works for anything). */
export function wrapText(ctx, words, width) {
  const lines = []; let line = '';
  for (const ch of String(words)) {
    if (line && ctx.measureText(line + ch).width > width) { lines.push(line); line = ch; } else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}
function box(ctx, x, y, w, h, kind) {
  const r = kind === 'narr' ? 4 : Math.min(h / 2, w / 4);
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = kind === 'narr' ? 'rgba(255,248,220,.94)' : 'rgba(255,255,255,.95)'; ctx.fill();
  ctx.lineWidth = Math.max(2, ctx.canvas.width / 400); ctx.strokeStyle = '#1b1b1b';
  ctx.setLineDash(kind === 'think' ? [ctx.lineWidth * 3, ctx.lineWidth * 2] : []); ctx.stroke(); ctx.setLineDash([]);
}
/** `blob` (the page as drawn) with `page`'s words on it → a PNG blob. doc: the document to make the canvas in. */
export async function composePage(blob, page, {doc = globalThis.document, size = 0} = {}) {
  const bitmap = await globalThis.createImageBitmap(blob), w = bitmap.width, h = bitmap.height;
  const canvas = doc.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close?.();
  const font = size || Math.max(16, Math.round(w / 30)), pad = Math.round(font * .6), cells = panelRects(page.panels.length, w, h);
  ctx.font = `700 ${font}px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`; ctx.textBaseline = 'top';
  page.panels.forEach((panel, i) => {
    const cell = cells[i] || cells[cells.length - 1]; let y = cell.y + pad;
    for (const line of panel.lines || []) {
      const maxW = cell.w * .78 - pad * 2, rows = wrapText(ctx, (line.kind === 'narr' || !line.who ? '' : line.who + '：') + line.text, maxW);
      const textW = Math.max(...rows.map(r => ctx.measureText(r).width)), bw = textW + pad * 2, bh = rows.length * font * 1.25 + pad * 1.4;
      if (y + bh > cell.y + cell.h) break; // no room left in this panel: the rest is not drawn over the next one
      const x = line.kind === 'narr' ? cell.x + pad : cell.x + (i % 2 ? cell.w - bw - pad : pad);
      box(ctx, x, y, bw, bh, line.kind);
      ctx.fillStyle = '#111'; rows.forEach((r, k) => ctx.fillText(r, x + pad, y + pad * .7 + k * font * 1.25));
      y += bh + pad * .6;
    }
  });
  return await new Promise((ok, no) => canvas.toBlob(b => b ? ok(b) : no(Error('这一页没能合成')), 'image/png'));
}
