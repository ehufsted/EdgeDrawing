// SVG writers, at true size.
//
// MILLIMETERS WITH A MATCHING viewBox, so a file prints, plots and imports at
// its true size. The drawing is ONE <path>: straights as L, arcs as A (an arc
// of more than half a turn is written as two, since an SVG arc whose ends meet
// draws nothing). A plotter, a laser in line mode or a wire bender's software
// reads it as the single stroke it is.

const NS = 'http://www.w3.org/2000/svg';

export const fmt = (v, dp = 3) => {
  if (!isFinite(v)) return '0';
  const s = v.toFixed(dp);
  const t = s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
  return t === '-0' ? '0' : t;
};

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Path data for a path (core/arcs.js), or for only its segs `filter` accepts (then each run starts with M). */
export function pathD(path, filter = null) {
  let d = filter ? '' : `M${fmt(path.x0)} ${fmt(path.y0)}`;
  let x = path.x0, y = path.y0, pen = !filter;
  for (const s of path.segs) {
    const on = !filter || filter(s);
    if (on && !pen) d += `M${fmt(x)} ${fmt(y)}`;
    pen = on;
    if (on) {
      if (s.k === 'L') d += `L${fmt(s.x)} ${fmt(s.y)}`;
      else {
        // halves, so no single arc is more than π
        const n = Math.abs(s.sweep) > Math.PI - 1e-6 ? 2 : 1;
        for (let j = 1; j <= n; j++) {
          const a = s.a0 + (s.sweep * j) / n;
          const ex = j === n ? s.x : s.cx + s.r * Math.cos(a), ey = j === n ? s.y : s.cy + s.r * Math.sin(a);
          d += `A${fmt(s.r)} ${fmt(s.r)} 0 0 ${s.sweep > 0 ? 1 : 0} ${fmt(ex)} ${fmt(ey)}`;
        }
      }
    }
    x = s.x; y = s.y;
  }
  return d;
}

/**
 * The drawing: the line alone, at its width, round ends and joins.
 * @param {{lineWidth:number, ink?:string, paper?:string|null, title?:string}} o
 */
export function drawingSVG(plan, o) {
  const { W, H } = plan.piece;
  const bg = o.paper ? `<rect width="${fmt(W)}" height="${fmt(H)}" fill="${o.paper}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${NS}" width="${fmt(W)}mm" height="${fmt(H)}mm" viewBox="0 0 ${fmt(W)} ${fmt(H)}">` +
    `<title>${escapeXml(o.title || 'EdgeDrawing')}</title>${bg}` +
    `<path d="${pathD(plan.path)}" fill="none" stroke="${o.ink || '#000000'}" stroke-width="${fmt(o.lineWidth)}" stroke-linecap="round" stroke-linejoin="round"/>` +
    '</svg>\n';
}

/** Start (a ring) and end (a square) markers and the first few mm as an arrow, for a template. */
export function markersSVG(plan, size = 3) {
  if (!plan.start) return '';
  const s = plan.start, e = plan.end;
  const a = arrowAt(plan.path, Math.min(4 * size, 0.25 * plan.stats.length));
  return `<g fill="none" stroke="#1a9e3a" stroke-width="${fmt(size / 6)}"><circle cx="${fmt(s.x)}" cy="${fmt(s.y)}" r="${fmt(size / 2)}"/>` +
    (a ? `<path d="M${fmt(a.x - size * (a.ux - 0.5 * a.uy))} ${fmt(a.y - size * (a.uy + 0.5 * a.ux))}L${fmt(a.x)} ${fmt(a.y)}L${fmt(a.x - size * (a.ux + 0.5 * a.uy))} ${fmt(a.y - size * (a.uy - 0.5 * a.ux))}"/>` : '') +
    `</g><rect x="${fmt(e.x - size / 2)}" y="${fmt(e.y - size / 2)}" width="${fmt(size)}" height="${fmt(size)}" fill="none" stroke="#c0392b" stroke-width="${fmt(size / 6)}"/>`;
}

/** The point at length `at` along the path, and the direction there. */
export function arrowAt(path, at) {
  let x = path.x0, y = path.y0, acc = 0;
  for (const s of path.segs) {
    const L = s.k === 'L' ? Math.hypot(s.x - x, s.y - y) : s.r * Math.abs(s.sweep);
    if (acc + L >= at && L > 0) {
      const f = (at - acc) / L;
      if (s.k === 'L') return { x: x + f * (s.x - x), y: y + f * (s.y - y), ux: (s.x - x) / L, uy: (s.y - y) / L };
      const ang = s.a0 + f * s.sweep, sg = Math.sign(s.sweep);
      return { x: s.cx + s.r * Math.cos(ang), y: s.cy + s.r * Math.sin(ang), ux: -sg * Math.sin(ang), uy: sg * Math.cos(ang) };
    }
    acc += L; x = s.x; y = s.y;
  }
  return null;
}

/** Save text as a file (the one DOM-aware helper here). */
export function downloadFile(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
