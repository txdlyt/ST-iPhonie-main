// 漫画: the words laid on a drawn page — a balloon for speech, a dashed one for thoughts, a box for narration — in each
// panel's place (core/comic.js panelRects). The picture is never redrawn: this only writes on a copy of it.
import {panelRects} from './comic.js';
import {TEXT_DIVISOR} from './comic-settings.js';

/** Words broken into lines no wider than `width` (a character at a time: it suits Chinese, and works for anything). */
export function wrapText(ctx, words, width) {
  const lines = []; let line = '';
  for (const ch of String(words)) {
    if (line && ctx.measureText(line + ch).width > width) { lines.push(line); line = ch; } else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}
/** A balloon (speech: white; thought: dashed) or a caption (narration: dark, light words). Soft, thin-edged, so it covers little. */
function box(ctx, x, y, w, h, kind, shape = 'round') {
  const line = Math.max(1.5, ctx.canvas.width / 560);
  ctx.save();
  ctx.beginPath();
  if (shape === 'oval' && kind !== 'narr') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.roundRect(x, y, w, h, kind === 'narr' || shape === 'box' ? (shape === 'box' ? 0 : 5) : Math.min(h / 2, w / 4, ctx.canvas.width / 40));
  ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = line * 4; ctx.shadowOffsetY = line;
  ctx.fillStyle = kind === 'narr' ? 'rgba(24,24,28,.78)' : 'rgba(255,255,255,.93)'; ctx.fill();
  ctx.shadowColor = 'transparent';
  if (kind !== 'narr') { ctx.lineWidth = line; ctx.strokeStyle = 'rgba(30,30,34,.85)'; ctx.setLineDash(kind === 'think' ? [line * 3, line * 2] : []); ctx.stroke(); }
  ctx.restore();
}
/** `blob` (the page as drawn) with `page`'s words on it → a PNG blob. doc: the document to make the canvas in. */
export async function composePage(blob, page, {doc = globalThis.document, size = 0, textSize = 'auto', hide = false, bubble = 'round', rtl = false} = {}) {
  const bitmap = await globalThis.createImageBitmap(blob), w = bitmap.width, h = bitmap.height;
  const canvas = doc.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close?.();
  const font = size || Math.max(12, Math.round(w / (TEXT_DIVISOR[textSize] || 34))), pad = Math.round(font * .45), step = font * 1.3, cells = panelRects(page.panels.length, w, h, 0.02, rtl);
  ctx.font = `600 ${font}px "PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`; ctx.textBaseline = 'top';
  if (!hide) page.panels.forEach((panel, i) => {
    const cell = cells[i] || cells[cells.length - 1], limit = cell.h * .55, said = (panel.lines || []).filter(l => l.kind !== 'narr'), notes = (panel.lines || []).filter(l => l.kind === 'narr');
    let y = cell.y + pad, used = 0;
    const measure = (line, share) => {
      const maxW = cell.w * share - pad * 2, rows = wrapText(ctx, line.text, maxW);
      const oval = bubble === 'oval' && line.kind !== 'narr', grow = oval ? pad * .9 : 0, textW = Math.max(...rows.map(r => ctx.measureText(r).width));
      return {rows, grow, bw: textW + pad * 2 + grow * 2, bh: rows.length * step + pad * 1.2 + grow * 2};
    };
    const write = (m, x, top, line) => { box(ctx, x, top, m.bw, m.bh, line.kind, bubble); ctx.fillStyle = line.kind === 'narr' ? '#f4f1ea' : '#16161a'; m.rows.forEach((r, k) => ctx.fillText(r, x + pad + m.grow, top + pad * .6 + m.grow + k * step)); };
    said.forEach((line, k) => {   // speech and thoughts: the corner where the panel is first read, then the other side, going down
      const m = measure(line, .46);
      if (used + m.bh > limit) return;   // no more room for words in this panel: the rest is not drawn over the picture
      const first = k % 2 === 0, right = rtl ? first : !first;
      write(m, right ? cell.x + cell.w - m.bw - pad : cell.x + pad, y, line);
      y += m.bh + pad * .5; used += m.bh + pad * .5;
    });
    if (notes.length) {   // narration: a caption along the bottom edge of the panel
      const text = notes.map(l => l.text).join(' '), line = {kind: 'narr', text}, m = measure(line, .9);
      if (m.bh < cell.h * .4) write(m, cell.x + pad, cell.y + cell.h - m.bh - pad, line);
    }
  });
  return await new Promise((ok, no) => canvas.toBlob(b => b ? ok(b) : no(Error('这一页没能合成')), 'image/png'));
}
