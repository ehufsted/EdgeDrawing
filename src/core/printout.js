// The printable drawing: one self-contained HTML page, opened in its own window
// and saved as PDF through the browser's print dialog (so no PDF library).
// Its layout is PaintByNumbers' (from Photo2Mosaic):
//
//   summary   the preview, the line's figures (length, bends, retraced, not in
//             the image, crossings, the tightest bend), notes
//   fit       the whole drawing scaled to one page, with where it starts (a
//             green ring and arrow) and ends (a red square)
//   template  the drawing at 1:1, split into a grid of pages that overlap by
//             OVERLAP mm, each captioned with its place in the grid: to trace,
//             or to lay wire on (wire bending instructions are on the TODO)
//
// The line is written ONCE, as a hidden <svg> symbol, and every page shows its
// own window of it through <use>. A scaled view keeps the line at least
// MIN_LINE thick as printed. PAGES ARE SIZED IN mm, and the 1:1 pages only stay
// 1:1 when printed at 100% ("actual size", not "fit to page"); every one carries
// a 50 mm bar to check that with a ruler. DOM-free: the app adds only the
// preview image's data URL.

import { pathD, markersSVG, fmt, escapeXml } from './svg.js';
import { fromMm } from './units.js';

export const PAPERS = {
  letter: { w: 215.9, h: 279.4, label: 'Letter' },
  a4: { w: 210, h: 297, label: 'A4' },
  tabloid: { w: 279.4, h: 431.8, label: 'Tabloid / Ledger' },
  a3: { w: 297, h: 420, label: 'A3' },
};
const MARGIN = 10;      // mm, all round
const CAPTION = 9;      // mm reserved at the top of a page for its caption
export const OVERLAP = 10;
export const MIN_LINE = 0.15;   // mm on paper, the thinnest line on a scaled view
const PREVIEW_H = 150;          // mm, the tallest the summary's preview may be

/** The printable area of a page, mm. */
export const printable = (paper) => ({ w: paper.w - 2 * MARGIN, h: paper.h - 2 * MARGIN - CAPTION - 8 });

/**
 * How a w × h drawing splits onto pages of printable pw × ph: {cols, rows, windows}.
 * Windows overlap by OVERLAP mm and together cover the drawing exactly.
 * (Copied from PaintByNumbers.)
 */
export function pageWindows(w, h, pw, ph) {
  const split = (len, room) => {
    if (len <= room + 1e-6) return [[0, len]];
    const n = Math.ceil((len - OVERLAP) / (room - OVERLAP));
    const step = (len - room) / (n - 1);
    return [...Array(n).keys()].map((i) => [i * step, i * step + room]);
  };
  const xs = split(w, pw), ys = split(h, ph);
  const windows = [];
  ys.forEach((y, r) => xs.forEach((x, c) => windows.push({ r, c, x0: x[0], x1: x[1], y0: y[0], y1: y[1] })));
  return { cols: xs.length, rows: ys.length, windows };
}

/** '12.5' in the units, for text. */
export const fmtLen = (mm, units, dp) => {
  const v = fromMm(mm, units);
  const d = dp ?? (units === 'in' ? 2 : 0);
  return String(Math.round(v * 10 ** d) / 10 ** d);
};

/** A long length: '2.41 m' or '94.9 ft'; short ones in mm or in. */
export const longText = (mm, units) => (units === 'in'
  ? (mm >= 304.8 ? `${(mm / 304.8).toFixed(1)} ft` : `${(mm / 25.4).toFixed(1)} in`)
  : (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`));

/**
 * @param {object} plan
 * @param {{paper?:string, units?:'mm'|'in', summary?:boolean, fit?:boolean, template?:boolean,
 *          previewURL?:string, title?:string, lineWidth?:number, medium?:string}} opts
 */
export function planHTML(plan, opts = {}) {
  const paper = PAPERS[opts.paper] || PAPERS.letter;
  const units = opts.units === 'in' ? 'in' : 'mm';
  const L = (mm, dp) => fmtLen(mm, units, dp);
  const room = printable(paper);
  const title = opts.title || 'Single-line drawing';
  const { W, H } = plan.piece;
  const lw = opts.lineWidth ?? 0.5;
  const st = plan.stats;
  const pages = [];
  const page = (caption, body) => pages.push(
    `<section class="page"><div class="cap">${escapeXml(caption)}</div><div class="body">${body}</div></section>`);
  const view = (x0, y0, w, h, k, css) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)}" style="--edl-lw:${fmt(Math.max(lw, MIN_LINE / k))};${css}">` +
    '<use href="#edl-line"/><use href="#edl-marks"/></svg>';
  const bar = '<svg class="bar" width="70mm" height="6mm" viewBox="0 0 70 6"><path d="M0 3h50M0 1v4M50 1v4" stroke="#000" stroke-width="0.3" fill="none"/>' +
    '<text x="52" y="4.2" font-size="3" font-family="Arial, Helvetica, sans-serif">50 mm</text></svg>';

  if (opts.summary !== false) {
    const prev = opts.previewURL ? `<img class="preview" src="${opts.previewURL}" alt="preview">` : '';
    const row = (k, v) => `<tr><td>${k}</td><td class="r">${v}</td></tr>`;
    const pct = (v) => (st.length > 0 ? ` (${Math.round((100 * v) / st.length)}%)` : '');
    const figures = '<table class="key"><tbody>' +
      row('Line length', longText(st.length, units)) +
      row('…drawing the image\'s edges', longText(st.edge, units) + pct(st.edge)) +
      row('…over a line again', longText(st.retrace, units) + pct(st.retrace)) +
      row('…not in the image (bridges, joins, jumps)', longText(st.join, units) + pct(st.join)) +
      row('Bends (arcs)', String(st.bends)) +
      row('Tightest bend radius', `${L(st.minR, units === 'in' ? 3 : 1)} ${units}`) +
      row('Corners tighter than the smallest radius', String(st.tight)) +
      row('Crossings', String(st.crossings)) +
      '</tbody></table>';
    const notes = plan.notes.length ? `<ul class="notes">${plan.notes.map((n) => `<li>${escapeXml(n)}</li>`).join('')}</ul>` : '';
    const how = opts.medium === 'wire'
      ? 'Lay the wire on the 1:1 template from the green ring, following the arrow, to the red square. Bend each arc round a peg or nail of its radius; where the line crosses itself the wire goes over.'
      : 'Start at the green ring, follow the arrow, and do not lift the pen until the red square.';
    page(title, `<h1>${escapeXml(title)}</h1>` +
      `<p>Drawing <b>${L(W)} × ${L(H)} ${units}</b> · line ${fmt(lw, 2)} mm · ${opts.medium === 'wire' ? 'wire' : 'pen'}</p>` +
      `<div class="two">${prev}<div class="fig">${figures}<p class="small">${how}</p></div></div>${notes}`);
  }
  if (opts.fit) {
    const k = Math.min(room.w / W, (room.h + 8) / H);
    page(`${title} · whole drawing (scaled to fit)`, view(0, 0, W, H, k, `width:${fmt(W * k)}mm;height:${fmt(H * k)}mm`));
  }
  if (opts.template !== false) {
    const pw = pageWindows(W, H, room.w, room.h);
    for (const wd of pw.windows) {
      const w = wd.x1 - wd.x0, h = wd.y1 - wd.y0;
      const where = pw.windows.length > 1 ? ` · page ${wd.r + 1}-${wd.c + 1} of ${pw.rows} × ${pw.cols} (overlap ${OVERLAP} mm)` : '';
      page(`${title} · template at 1:1${where} · top ↑`, view(wd.x0, wd.y0, w, h, 1, `width:${fmt(w)}mm;height:${fmt(h)}mm;outline:0.2mm dashed #bbb`) + bar);
    }
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>
@page { size: ${paper.w}mm ${paper.h}mm; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font: 10pt/1.35 Arial, Helvetica, sans-serif; color: #000; background: #888; }
.page { width: ${paper.w}mm; height: ${paper.h}mm; padding: ${MARGIN}mm; background: #fff; margin: 0 auto 6mm; overflow: hidden; page-break-after: always; }
.cap { height: ${CAPTION}mm; font-size: 8pt; color: #444; }
h1 { font-size: 15pt; margin: 0 0 2mm; }
.two { display: flex; gap: 4%; align-items: flex-start; margin: 3mm 0; }
.preview { width: 55%; max-height: ${PREVIEW_H}mm; object-fit: contain; object-position: left top; border: 0.2mm solid #999; }
.fig { flex: 1 1 auto; }
table.key { border-collapse: collapse; width: 100%; font-size: 9pt; }
table.key td { padding: 0.8mm 1mm; border-bottom: 0.1mm solid #ccc; }
.r { text-align: right; }
.small { font-size: 8pt; color: #333; } .notes { font-size: 8pt; color: #333; padding-left: 5mm; }
.bar { display: block; margin-top: 2mm; }
@media print { body { background: #fff; } .page { margin: 0; } }
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute"><defs>` +
`<g id="edl-line"><path d="${pathD(plan.path)}" fill="none" stroke="#000" style="stroke-width:var(--edl-lw)" stroke-linecap="round" stroke-linejoin="round"/></g>` +
`<g id="edl-marks">${markersSVG(plan, Math.max(3, Math.min(W, H) / 60))}</g></defs></svg>
${pages.join('\n')}
</body></html>`;
}
