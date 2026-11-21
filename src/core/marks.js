// Marks for making the line by hand: numbered bends and distance ticks.
//
// BENDS. Every arc that turns at least MIN_BEND degrees is a bend, numbered in
// drawing order, with where it starts along the line (from the start), how long
// it is, which way it turns and how far, and its radius. Arcs gentler than that
// are a slight curve in a straight, not something to bend, and are left out (a
// steady hand follows them). The way it turns is as seen on the page, facing the
// way the line goes: R clockwise, L anticlockwise (an angle increasing on the
// page's y-down axes turns clockwise).
//
// TICKS. Every `every` mm of line, from the start: the point, the way the line
// runs there, and the length so far. Labelled with the TOTAL length, never the
// length since the last tick, so a slip at one bend does not move the numbers
// after it: the wire can be checked against the template anywhere.

export const MIN_BEND = 3;   // degrees

const segLen = (s, x, y) => (s.k === 'L' ? Math.hypot(s.x - x, s.y - y) : s.r * Math.abs(s.sweep));

/**
 * @returns [{n, at, len, dir:'L'|'R', angle, r, sx, sy, ux, uy, mx, my, ox, oy, kind}]
 *   at: mm along the line where the bend starts; (sx, sy) its start, (ux, uy) the way
 *   the line runs there; (mx, my)
 *   the middle of the arc; (ox, oy) the unit direction from its centre through
 *   that middle (outside the bend)
 */
export function bendList(path, minBend = MIN_BEND) {
  const out = [];
  let x = path.x0, y = path.y0, at = 0;
  for (const s of path.segs) {
    const L = segLen(s, x, y);
    if (s.k === 'A' && (Math.abs(s.sweep) * 180) / Math.PI >= minBend) {
      const am = s.a0 + s.sweep / 2, sg = Math.sign(s.sweep);
      out.push({
        n: out.length + 1, at, len: L, dir: s.sweep > 0 ? 'R' : 'L', angle: (Math.abs(s.sweep) * 180) / Math.PI, r: s.r,
        sx: x, sy: y, ux: -sg * Math.sin(s.a0), uy: sg * Math.cos(s.a0), mx: s.cx + s.r * Math.cos(am), my: s.cy + s.r * Math.sin(am), ox: Math.cos(am), oy: Math.sin(am), kind: s.kind,
      });
    }
    at += L;
    x = s.x; y = s.y;
  }
  return out;
}

/**
 * Points every `every` mm along the path (not at 0).
 * @returns [{at, x, y, ux, uy}]  (ux, uy): the unit direction of the line there
 */
export function tickMarks(path, every) {
  const out = [];
  if (!(every > 0)) return out;
  let x = path.x0, y = path.y0, at = 0, next = every;
  for (const s of path.segs) {
    const L = segLen(s, x, y);
    while (L > 0 && next <= at + L + 1e-9) {
      const f = (next - at) / L;
      if (s.k === 'L') out.push({ at: next, x: x + f * (s.x - x), y: y + f * (s.y - y), ux: (s.x - x) / L, uy: (s.y - y) / L });
      else {
        const a = s.a0 + f * s.sweep, sg = Math.sign(s.sweep);
        out.push({ at: next, x: s.cx + s.r * Math.cos(a), y: s.cy + s.r * Math.sin(a), ux: -sg * Math.sin(a), uy: sg * Math.cos(a) });
      }
      next += every;
    }
    at += L;
    x = s.x; y = s.y;
  }
  return out;
}

/** A length along the line for a label: '120 cm' / '47.2 in' (to the tick's own precision). */
export function alongText(mm, units) {
  if (units === 'in') { const v = mm / 25.4; return `${Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : (Math.round(v * 10) / 10).toFixed(1)} in`; }
  const cm = mm / 10;
  return `${Math.abs(cm - Math.round(cm)) < 1e-6 ? Math.round(cm) : cm.toFixed(1)} cm`;
}

/** Points along the path at most `step` apart, as a flat [x, y, ...]. */
export function pathPoints(path, step) {
  const out = [path.x0, path.y0];
  let x = path.x0, y = path.y0;
  for (const s of path.segs) {
    const n = Math.max(1, Math.ceil(segLen(s, x, y) / step));
    for (let j = 1; j <= n; j++) {
      if (s.k === 'L') out.push(x + ((s.x - x) * j) / n, y + ((s.y - y) * j) / n);
      else { const a = s.a0 + (s.sweep * j) / n; out.push(s.cx + s.r * Math.cos(a), s.cy + s.r * Math.sin(a)); }
    }
    x = s.x; y = s.y;
  }
  return out;
}

/** A spatial hash of boxes (centre x, y, half sizes hw, hh) and points, for "is this box free". */
function occupancy(cell) {
  const boxes = new Map(), pts = new Map();
  const key = (gx, gy) => gx * 1000003 + gy;
  const cells = (x0, y0, x1, y1, fn) => {
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) fn(key(gx, gy));
  };
  return {
    addBox(b) { cells(b.x - b.hw, b.y - b.hh, b.x + b.hw, b.y + b.hh, (k) => { if (!boxes.has(k)) boxes.set(k, []); boxes.get(k).push(b); }); },
    addPoints(p) { for (let i = 0; i < p.length; i += 2) { const k = key(Math.floor(p[i] / cell), Math.floor(p[i + 1] / cell)); if (!pts.has(k)) pts.set(k, []); pts.get(k).push(p[i], p[i + 1]); } },
    /** How much a box collides: other boxes overlapped, plus wire points covered. */
    cost(b) {
      let c = 0;
      const seenB = new Set();
      cells(b.x - b.hw, b.y - b.hh, b.x + b.hw, b.y + b.hh, (k) => {
        for (const o of boxes.get(k) || []) {
          if (seenB.has(o)) continue;
          seenB.add(o);
          if (Math.abs(o.x - b.x) < o.hw + b.hw && Math.abs(o.y - b.y) < o.hh + b.hh) c += 10;
        }
        const p = pts.get(k) || [];
        for (let i = 0; i < p.length; i += 2) if (Math.abs(p[i] - b.x) < b.hw && Math.abs(p[i + 1] - b.y) < b.hh) c++;
      });
      return c;
    },
  };
}

/**
 * Where to put each label so it covers neither the line nor another label: the
 * distance labels go beside their ticks, on whichever side is clear; each bend's
 * label tries sixteen spots round the middle of its arc, outside the bend first
 * and near before far, and takes the first that is clear, or else the one that
 * covers least. A thin leader joins it to the arc.
 * @returns {{tickSpots:[{x, y}], spots:[{x, y}]}}
 */
export function placeLabels(path, ticks, bends, fs, lw, units) {
  const occ = occupancy(3 * fs);
  occ.addPoints(pathPoints(path, Math.max(0.2, fs / 3)));
  const bar = Math.max(1.2, 1.5 * lw + fs * 0.4);
  const tickSpots = ticks.map((t) => {
    const hw = 0.25 * fs * Math.max(3, alongText(t.at, units).length) + 0.2 * fs, hh = 0.5 * fs;
    let best = null;
    for (const side of [1, -1]) {
      const d = side * (bar + hw * 0.6 + 0.4 * fs);
      const b = { x: t.x - t.uy * d, y: t.y + t.ux * d, hw, hh };
      const c = occ.cost(b);
      if (!best || c < best.c) best = { b, c };
      if (c === 0) break;
    }
    occ.addBox(best.b);
    return { x: best.b.x, y: best.b.y };
  });
  const hw = 1.3 * fs, hh = 1.0 * fs;
  const spots = bends.map((b) => {
    let best = null;
    for (const dist of [0.9 * fs + hh, 2 * fs + 2 * hh]) {
      for (const a of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, Math.PI]) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const dx = b.ox * ca - b.oy * sa, dy = b.ox * sa + b.oy * ca;
        const box = { x: b.mx + dx * dist, y: b.my + dy * dist, hw, hh };
        const c = occ.cost(box);
        if (!best || c < best.c) best = { box, c };
        if (c === 0) break;
      }
      if (best.c === 0) break;
    }
    occ.addBox(best.box);
    return { x: best.box.x, y: best.box.y };
  });
  return { tickSpots, spots };
}

/**
 * Everything to lay out the marks once: the ticks, the bends and where each
 * label goes. Lengths in mm; fs is the label size, lw the line's width; show:
 * which of the two kinds of mark to lay out.
 */
export function layoutMarks(path, every, fs, lw = 1, units = 'mm', show = { ticks: true, bends: true }) {
  // only what is shown is laid out, so a hidden kind takes no room from the other
  const ticks = show.ticks ? tickMarks(path, every) : [];
  const bends = show.bends ? bendList(path) : [];
  const { tickSpots, spots } = placeLabels(path, ticks, bends, fs, lw, units);
  return { ticks, bends, spots, tickSpots, fs };
}

/** A bend's label: its number, then which way and how far ('R 90°'). */
export const bendText = (b) => `${b.dir} ${Math.round(b.angle)}°`;

const f3 = (v) => (Math.round(v * 1000) / 1000).toString();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * The marks as SVG: each tick a bar across the line with the total length
 * beside it, each bend a bar across the line where it starts and its number and
 * turn nearby, on a thin leader to the middle of the arc. Black, to print.
 */
export function marksSVG(layout, units, lw) {
  const { ticks, bends, spots, tickSpots, fs } = layout;
  const bar = Math.max(1.2, 1.5 * lw + fs * 0.4), sw = Math.max(0.12, fs * 0.06);
  let s = `<g font-family="Arial, Helvetica, sans-serif" fill="#000" stroke="none" text-anchor="middle">`;
  let lines = '';
  ticks.forEach((t, i) => {
    const nx = -t.uy, ny = t.ux;
    lines += `M${f3(t.x - nx * bar)} ${f3(t.y - ny * bar)}L${f3(t.x + nx * bar)} ${f3(t.y + ny * bar)}`;
    const lx = tickSpots[i].x, ly = tickSpots[i].y;
    s += `<text x="${f3(lx)}" y="${f3(ly + 0.36 * fs)}" font-size="${f3(0.8 * fs)}">${esc(alongText(t.at, units))}</text>`;
  });
  let leaders = '';
  bends.forEach((b, i) => {
    const nx = -b.uy, ny = b.ux, p = spots[i];
    lines += `M${f3(b.sx - nx * bar)} ${f3(b.sy - ny * bar)}L${f3(b.sx + nx * bar)} ${f3(b.sy + ny * bar)}`;
    leaders += `M${f3(p.x)} ${f3(p.y)}L${f3(b.mx)} ${f3(b.my)}`;
    s += `<text x="${f3(p.x)}" y="${f3(p.y - 0.05 * fs)}" font-size="${f3(fs)}" font-weight="bold">${b.n}</text>` +
      `<text x="${f3(p.x)}" y="${f3(p.y + 0.8 * fs)}" font-size="${f3(0.7 * fs)}">${esc(bendText(b))}</text>`;
  });
  return `<path d="${lines}" stroke="#000" stroke-width="${f3(2 * sw)}" fill="none"/>` +
    `<path d="${leaders}" stroke="#666" stroke-width="${f3(sw)}" fill="none"/>${s}</g>`;
}

/** The bend table as CSV: one row per bend. */
export function bendCSV(bends) {
  const rows = ['bend,starts_at_mm,arc_length_mm,direction,angle_deg,radius_mm,kind'];
  for (const b of bends) rows.push([b.n, b.at.toFixed(1), b.len.toFixed(1), b.dir, b.angle.toFixed(1), b.r.toFixed(2), b.kind].join(','));
  return rows.join('\n') + '\n';
}
