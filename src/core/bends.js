// Enforcing the smallest bend: experiments, each a setting, to compare.
//
// The line comes from core/route.js as runs of 'edge', 'retrace' and 'join'.
// core/arcs.js fits straights and arcs to it, and reports the corners it cannot
// round at the smallest radius (TIGHT). These options try to leave fewer:
//
// JOINS AS DUBINS PATHS (joins: 'dubins'). A join is not in the image, so it
// may take any shape: each run of joins becomes the shortest path that leaves
// the end of one stroke in the direction the stroke was going and arrives at
// the next stroke's start in its direction, never tighter than the smallest
// radius (core/dubins.js). The strokes are fitted on their own, so the corner
// where a join met a stroke is gone: the join is tangent to both.
//
// TIGHT CORNERS FIXED (fix), each held to MAX STRAY mm from the traced edges:
//   'merge'     a tight corner and its neighbours, as few as it takes, become
//               ONE corner where the straights either side of them meet, which
//               then has room for the smallest radius (stray: how far the
//               merged corners were from that new one); where those straights
//               run the same way (a notch in a straight), the run is straightened
//   'remove'    the tightest corner's point is dropped, the line going straight
//               from the point before to the point after, and the line refitted;
//               repeated while any corner is tight and dropping keeps within the
//               stray
//   'optimize'  the whole line at once: split every R/3, then relaxed: each
//               point turning tighter than an arc of the radius could moves
//               toward its neighbours' midpoint, each point is pulled back toward
//               where it was traced, never past the stray, and this repeated (a
//               projected smoothing, as in position-based dynamics). Its line is
//               many short arcs: simplified, the uneven spacing undid it
//
// THE STRAY BUDGET HOLDS FOR THE ARCS TOO (fitArcs' maxDev): the smallest bend in
// a sharp V sits far back from the tip (3 mm in a 15° V cuts 20 mm off it), so
// such a corner is reported tight rather than silently losing its tip.
//
// THE STRAY is measured after, the same way for every option: how far each
// point of the traced edges ('edge' and 'retrace' runs) is from the final line.

import { routePolyline, fitArcs, samplePath } from './arcs.js';
import { dubins } from './dubins.js';

const MAX_ROUNDS = 200;
const OPT_ITER = 400;

/**
 * @param {[{pts, kind}]} runs  core/route.js
 * @param {{minRadius, tol, loops, joins?:'straight'|'dubins', fix?:'none'|'merge'|'remove'|'optimize', maxStray?:number}} o
 * @returns {{path, tight, loops, stray:{max, mean}}}
 */
export function fitLine(runs, o) {
  const { pts, kinds } = routePolyline(runs);
  const minR = Math.max(0, o.minRadius || 0);
  const maxStray = o.maxStray ?? 3;
  const m = pts.length / 2;
  if (m < 2) return { path: { x0: pts[0] || 0, y0: pts[1] || 0, segs: [] }, tight: [], loops: 0, stray: { max: 0, mean: 0 } };
  const dub = o.joins === 'dubins' && minR > 0;
  const pieces = dub ? splitAtJoins(pts, kinds) : [{ pts, kinds }];
  const fit = { tight: [], loops: 0 };
  const fitted = pieces.map((p) => {
    let { pts: pp, kinds: kk } = p;
    if (pp.length < 4) return { path: { x0: pp[0], y0: pp[1], segs: [] }, h0: null, h1: null };
    if (minR > 0 && o.fix === 'optimize') ({ pts: pp, kinds: kk } = optimizeLine(pp, kk, minR, maxStray, o.tol));
    // the stray budget holds for the arcs too: a bend that would cut a sharp V's tip
    // off by more than it is a tight corner, not a silent loss of the tip
    const arcOpts = { minRadius: minR, tol: o.tol, loops: o.loops, maxDev: minR > 0 ? maxStray : 0 };
    let f = fitArcs(pp, kk, arcOpts);
    if (minR > 0 && (o.fix === 'merge' || o.fix === 'remove') && f.tight.length) {
      const fixer = o.fix === 'merge' ? mergeRound : removeRound;
      const idx = Array.from({ length: pp.length / 2 }, (_, i) => i);
      const orig = pp;
      for (let round = 0; round < MAX_ROUNDS && f.tight.length; round++) {
        const next = fixer(pp, kk, idx, orig, f.tight, minR, maxStray);
        if (!next) break;
        ({ pts: pp, kinds: kk } = next);
        f = fitArcs(pp, kk, arcOpts);
      }
    }
    fit.tight.push(...f.tight);
    fit.loops += f.loops;
    const n = pp.length / 2;
    const dir = (i, j) => Math.atan2(pp[2 * j + 1] - pp[2 * i + 1], pp[2 * j] - pp[2 * i]);
    return { path: f.path, h0: dir(0, 1), h1: dir(n - 2, n - 1) };
  });
  // put the pieces together, a Dubins path between each two
  const path = { x0: fitted[0].path.x0, y0: fitted[0].path.y0, segs: [] };
  fitted.forEach((f, k) => {
    if (k > 0) {
      const a = fitted[k - 1];
      const end = endOf(a.path);
      const sx = f.path.x0, sy = f.path.y0;
      const chord = Math.atan2(sy - end.y, sx - end.x);
      const dj = dubins(end.x, end.y, a.h1 ?? chord, sx, sy, f.h0 ?? chord, minR, 'join');
      path.segs.push(...dj.segs);
    }
    path.segs.push(...f.path.segs);
  });
  return { path, tight: fit.tight, loops: fit.loops, stray: measureStray(pts, kinds, path) };
}

const endOf = (path) => (path.segs.length ? path.segs[path.segs.length - 1] : { x: path.x0, y: path.y0 });

/**
 * The polyline cut at its joins: the strokes between them, each {pts, kinds}.
 * A run of several joins is one gap (a point only joins touch is dropped); a
 * line that starts or ends with a join keeps a one-point piece there.
 */
export function splitAtJoins(pts, kinds) {
  const pieces = [{ pts: [pts[0], pts[1]], kinds: [] }];
  for (let i = 0; i < kinds.length; i++) {
    const x = pts[2 * i + 2], y = pts[2 * i + 3];
    const last = pieces[pieces.length - 1];
    if (kinds[i] === 'join') {
      if (!last.kinds.length && pieces.length > 1) last.pts = [x, y];
      else pieces.push({ pts: [x, y], kinds: [] });
    } else {
      last.pts.push(x, y);
      last.kinds.push(kinds[i]);
    }
  }
  return pieces;
}

/** Largest distance from the original points idx[a]..idx[b] to the polyline q (flat). */
function strayOver(orig, a, b, q) {
  let worst = 0;
  for (let k = a; k <= b; k++) {
    const x = orig[2 * k], y = orig[2 * k + 1];
    let best = Infinity;
    for (let j = 0; j + 3 < q.length; j += 2) best = Math.min(best, segDist(x, y, q[j], q[j + 1], q[j + 2], q[j + 3]));
    worst = Math.max(worst, best);
  }
  return worst;
}

function segDist(x, y, ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) { ax = bx; ay = by; } else if (t > 0) { ax += dx * t; ay += dy * t; }
  }
  return Math.hypot(x - ax, y - ay);
}

/** Rebuild pts/kinds/idx with the vertices in `drop` removed and `put` (index -> {x, y}) replacing others. */
function rebuild(pts, kinds, idx, drop, put) {
  const P = [], K = [], I = [];
  const m = pts.length / 2;
  for (let i = 0; i < m; i++) {
    if (drop.has(i)) continue;
    const q = put.get(i);
    const x = q ? q.x : pts[2 * i], y = q ? q.y : pts[2 * i + 1];
    // a dropped hairpin tip leaves its neighbours on one point: keep it once
    if (P.length && Math.hypot(x - P[P.length - 2], y - P[P.length - 1]) < 1e-9) continue;
    if (P.length) K.push(kinds[i - 1] ?? kinds[kinds.length - 1]);
    P.push(x, y);
    I.push(idx[i]);
  }
  idx.length = 0;
  idx.push(...I);
  return { pts: P, kinds: K };
}

/** 'remove': drop the tight corners' points, tightest first, none next to another dropped this round. */
function removeRound(pts, kinds, idx, orig, tight, minR, maxStray) {
  const drop = new Set();
  for (const t of [...tight].sort((a, b) => a.r - b.r)) {
    const i = t.i;
    if (drop.has(i - 1) || drop.has(i + 1) || i <= 0 || i >= pts.length / 2 - 1) continue;
    const q = [pts[2 * i - 2], pts[2 * i - 1], pts[2 * i + 2], pts[2 * i + 3]];
    if (strayOver(orig, idx[i - 1], idx[i + 1], q) > maxStray) continue;
    drop.add(i);
  }
  if (!drop.size) return null;
  return rebuild(pts, kinds, idx, drop, new Map());
}

/**
 * 'merge': each tight corner, with as few neighbours as it takes (up to 8),
 * becomes one corner where the straights either side of them meet, if that
 * corner has room for the smallest radius and keeps within the stray.
 */
function mergeRound(pts, kinds, idx, orig, tight, minR, maxStray) {
  const m = pts.length / 2;
  const P = (i) => [pts[2 * i], pts[2 * i + 1]];
  const busy = new Uint8Array(m);
  const drop = new Set(), put = new Map();
  for (const t of [...tight].sort((a, b) => a.r - b.r)) {
    let i0 = t.i, i1 = t.i;
    if (busy[i0]) continue;
    for (let grow = 0; grow < 8; grow++) {
      if (i0 < 1 || i1 > m - 2) break;
      const A = P(i0 - 1), A1 = P(i0), B0 = P(i1), B = P(i1 + 1);
      let ok = false, V = null;
      const ux = A1[0] - A[0], uy = A1[1] - A[1], uL = Math.hypot(ux, uy);
      const vx = B[0] - B0[0], vy = B[1] - B0[1], vL = Math.hypot(vx, vy);
      if (uL > 1e-9 && vL > 1e-9) {
        const u = [ux / uL, uy / uL], v = [vx / vL, vy / vL];
        const cr = u[0] * v[1] - u[1] * v[0];
        const th = Math.atan2(Math.abs(cr), u[0] * v[0] + u[1] * v[1]);
        if (Math.abs(cr) > 1e-9 && th < Math.PI - 0.05) {
          const bx = B[0] - A[0], by = B[1] - A[1];
          const lam = (bx * v[1] - by * v[0]) / cr, mu = (u[0] * by - u[1] * bx) / cr;
          const tt = minR * Math.tan(th / 2);
          if (lam >= tt && mu >= tt) { V = [A[0] + lam * u[0], A[1] + lam * u[1]]; ok = true; }
        } else if (u[0] * v[0] + u[1] * v[1] > 0) {
          // the straights either side run the same way (a notch in a straight): no corner at all
          ok = true;
        }
      }
      const q = V ? [A[0], A[1], V[0], V[1], B[0], B[1]] : [A[0], A[1], B[0], B[1]];
      if (ok && strayOver(orig, idx[i0 - 1], idx[i1 + 1], q) <= maxStray) {
        let free = true;
        for (let k = i0 - 1; k <= i1 + 1; k++) if (busy[k]) free = false;
        if (free) {
          for (let k = i0 - 1; k <= i1 + 1; k++) busy[k] = 1;
          if (V) {
            for (let k = i0 + 1; k <= i1; k++) drop.add(k);
            put.set(i0, { x: V[0], y: V[1] });
          } else for (let k = i0; k <= i1; k++) drop.add(k);
        }
        break;
      }
      // grow toward the shorter neighbouring straight
      const before = i0 >= 2 ? Math.hypot(pts[2 * i0 - 2] - pts[2 * i0 - 4], pts[2 * i0 - 1] - pts[2 * i0 - 3]) : Infinity;
      const after = i1 <= m - 3 ? Math.hypot(pts[2 * i1 + 4] - pts[2 * i1 + 2], pts[2 * i1 + 5] - pts[2 * i1 + 3]) : Infinity;
      if (before === Infinity && after === Infinity) break;
      if (before <= after) i0--; else i1++;
    }
  }
  if (!drop.size && !put.size) return null;
  return rebuild(pts, kinds, idx, drop, put);
}

/**
 * 'optimize': each segment split into pieces of at most R/3 (at least 0.2 mm),
 * the traced points kept, then relaxed: a point turning tighter than an arc
 * of radius R fitted there could (with 15% to spare) moves
 * halfway to its neighbours' midpoint; every point is pulled 5% back toward
 * where it was, and never left farther than the stray. The last FINAL passes
 * only enforce the bend (within the stray), so the pull back cannot leave it
 * just over.
 */
export function optimizeLine(pts, kinds, R, maxStray, tol) {
  const m = pts.length / 2;
  const step = Math.max(0.2, R / 3);
  const O = [pts[0], pts[1]], K = [];
  for (let i = 0; i < m - 1; i++) {
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * i + 2], by = pts[2 * i + 3];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 1; j <= k; j++) { O.push(ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k); K.push(kinds[i]); }
  }
  const n = O.length / 2;
  if (n < 4) return { pts, kinds };
  const o = Float64Array.from(O), p = Float64Array.from(O);
  const Rm = 1.15 * R;
  const FINAL = 300;
  const clampTo = (i) => {
    const dx = p[2 * i] - o[2 * i], dy = p[2 * i + 1] - o[2 * i + 1], d = Math.hypot(dx, dy);
    if (d > maxStray) { p[2 * i] = o[2 * i] + (dx * maxStray) / d; p[2 * i + 1] = o[2 * i + 1] + (dy * maxStray) / d; }
  };
  for (let it = 0; it < OPT_ITER + FINAL; it++) {
    for (let i = 1; i < n - 1; i++) {
      const ax = p[2 * i - 2], ay = p[2 * i - 1], bx = p[2 * i], by = p[2 * i + 1], cx = p[2 * i + 2], cy = p[2 * i + 3];
      const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by;
      const phi = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
      // the fitter rounds this corner within half the shorter straight beside it, so the
      // turn that gives radius Rm there is 2·atan(half / Rm)
      const lim = 2 * Math.atan(Math.min(Math.hypot(ux, uy), Math.hypot(vx, vy)) / (2 * Rm));
      if (phi > lim) {
        p[2 * i] += 0.5 * ((ax + cx) / 2 - bx);
        p[2 * i + 1] += 0.5 * ((ay + cy) / 2 - by);
        clampTo(i);
      }
    }
    if (it >= OPT_ITER) continue;
    for (let i = 1; i < n - 1; i++) {
      p[2 * i] = o[2 * i] + 0.99 * (p[2 * i] - o[2 * i]);
      p[2 * i + 1] = o[2 * i + 1] + 0.99 * (p[2 * i + 1] - o[2 * i + 1]);
    }
  }
  // not simplified: uneven spacing would undo it (a corner is rounded within half its
  // shorter straight), so every point is kept and the fit has many small arcs
  return { pts: Array.from(p), kinds: K };
}

/**
 * How far the traced edges stray from the line: every point of the 'edge' and
 * 'retrace' segments of the original polyline (and each segment's middle), to
 * the nearest point of the final path. {max, mean} in mm.
 */
export function measureStray(pts, kinds, path) {
  const sp = samplePath(path, Math.PI / 36).pts;
  const ns = sp.length / 2;
  if (ns < 2) return { max: 0, mean: 0 };
  const cell = 5;
  const grid = new Map();
  const key = (gx, gy) => gx * 1000003 + gy;
  for (let i = 0; i < ns - 1; i++) {
    const x0 = Math.min(sp[2 * i], sp[2 * i + 2]), x1 = Math.max(sp[2 * i], sp[2 * i + 2]);
    const y0 = Math.min(sp[2 * i + 1], sp[2 * i + 3]), y1 = Math.max(sp[2 * i + 1], sp[2 * i + 3]);
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) {
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        const k = key(gx, gy);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(i);
      }
    }
  }
  const near = (x, y) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    let best = Infinity;
    // anything in ring r is at least r - 1 cells away
    for (let r = 0; r < 64 && best > (r - 1) * cell; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const i of grid.get(key(gx + dx, gy + dy)) || []) best = Math.min(best, segDist(x, y, sp[2 * i], sp[2 * i + 1], sp[2 * i + 2], sp[2 * i + 3]));
      }
    }
    return isFinite(best) ? best : 0;
  };
  let max = 0, sum = 0, count = 0, at = null;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === 'join') continue;
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * i + 2], by = pts[2 * i + 3];
    for (const [x, y] of [[ax, ay], [(ax + bx) / 2, (ay + by) / 2]]) {
      const d = near(x, y);
      if (d > max) { max = d; at = { x, y }; }
      sum += d; count++;
    }
  }
  return { max, mean: count ? sum / count : 0, at };
}
