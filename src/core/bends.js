// Smoothing the line, and keeping it to the smallest bend.
//
// The line comes from core/route.js as runs of 'edge', 'retrace' and 'join'.
// core/arcs.js fits straights and arcs to it, and reports the corners it cannot
// round at the smallest radius (TIGHT).
//
// LINE SMOOTHING (smoothing), the whole line:
//   'pid'       (the default) STEERED at constant speed, the curvature capped at
//               1/R, aiming ahead on the traced line through a PD controller
//               (steerLine): never tight by construction, only stray
//   'fourier'   low-passed in the frequency domain: wiggles shorter than a length
//               scale L are taken out (fourierLine). Not held to the stray, nor
//               to the bend: L is the control
//   'optimize'  ("relax the whole line") split every R/3, then relaxed: each
//               point turning tighter than an arc of the radius could moves
//               toward its neighbours' midpoint, each point is pulled back toward
//               where it was traced, never past the stray, and this repeated (a
//               projected smoothing, as in position-based dynamics). Its line is
//               many short arcs: simplified, the uneven spacing undid it
//   'none'      straights and arcs fitted to the traced line as it is
//
// EXPERIMENTAL (the app's Experimental smoothing tab):
//
// JOINS AS DUBINS PATHS (joins: 'dubins'). A join is not in the image, so it
// may take any shape: each run of joins becomes the shortest path that leaves
// the end of one stroke in the direction the stroke was going and arrives at
// the next stroke's start in its direction, never tighter than the smallest
// radius (core/dubins.js). The strokes are smoothed and fitted on their own, so
// the corner where a join met a stroke is gone: the join is tangent to both.
//
// TIGHT CORNERS FIXED after the fit (fix; not with 'pid', which has none), each
// held to MAX STRAY mm from the traced edges:
//   'merge'     a tight corner and its neighbours, as few as it takes, become
//               ONE corner where the straights either side of them meet, which
//               then has room for the smallest radius (stray: how far the
//               merged corners were from that new one); where those straights
//               run the same way (a notch in a straight), the run is straightened
//   'remove'    the tightest corner's point is dropped, the line going straight
//               from the point before to the point after, and the line refitted;
//               repeated while any corner is tight and dropping keeps within the
//               stray
//
// THE STRAY BUDGET HOLDS FOR THE ARCS TOO (fitArcs' maxDev): the smallest bend in
// a sharp V sits far back from the tip (3 mm in a 15° V cuts 20 mm off it), so
// such a corner is reported tight rather than silently losing its tip.
//
// THE STRAY is measured after, the same way for every option: how far each
// point of the traced edges ('edge' and 'retrace' runs) is from the final line.

import { routePolyline, fitArcs, samplePath } from './arcs.js';
import { dubins } from './dubins.js';
import { PID_D_MAX } from './units.js';

const MAX_ROUNDS = 200;
const OPT_ITER = 400;

/**
 * @param {[{pts, kind}]} runs  core/route.js
 * @param {{minRadius, tol, loops, smoothing?:'pid'|'fourier'|'optimize'|'none', joins?:'straight'|'dubins', fix?:'none'|'merge'|'remove', maxStray?:number,
 *          fourierScale?:number, pid?:{look:number, p:number, i:number, d:number}}} o
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
  const fit = { tight: [], loops: 0, steps: 0 };
  const fitted = pieces.map((p) => {
    let { pts: pp, kinds: kk } = p;
    if (pp.length < 4) return { path: { x0: pp[0], y0: pp[1], segs: [] }, h0: null, h1: null };
    const sm = o.smoothing || 'none';
    if (sm === 'pid') {
      const sim = steerLine(pp, kk, minR, o.pid || {});
      fit.steps += sim.steps;
      return sim;
    }
    if (sm === 'fourier') ({ pts: pp, kinds: kk } = fourierLine(pp, kk, o.fourierScale || 10, minR));
    if (minR > 0 && sm === 'optimize') ({ pts: pp, kinds: kk } = optimizeLine(pp, kk, minR, maxStray, o.tol));
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
      for (const s of dj.segs) path.segs.push(s);
    }
    for (const s of f.path.segs) path.segs.push(s);   // (not spread: a steered line can be too many for one call)
  });
  return { path, tight: tightPlaces(fit.tight, minR), loops: fit.loops, stray: measureStray(pts, kinds, path) };
}

/**
 * Tight corners counted by PLACE: those within one bend radius of a tighter one
 * are the same place (a densely sampled line, from Fourier or optimize, has a
 * run of tight vertices where a sparse one has one corner). The tightest is kept.
 */
export function tightPlaces(tight, R) {
  const out = [];
  for (const t of [...tight].sort((a, b) => a.r - b.r || a.x - b.x || a.y - b.y)) {
    if (!out.some((q) => Math.hypot(q.x - t.x, q.y - t.y) < Math.max(R, 1e-6))) out.push(t);
  }
  return out;
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
  for (const v of I) idx.push(v);
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

/**
 * A polyline resampled at n points evenly spaced along it: {x, y, kinds, L}
 * (kinds per new segment: the original segment under its middle).
 */
function resample(pts, kinds, n) {
  const m = pts.length / 2;
  const cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]));
  const L = cum[m - 1];
  const x = new Float64Array(n), y = new Float64Array(n), K = [];
  for (let j = 0, seg = 0; j < n; j++) {
    const s = (L * j) / (n - 1);
    while (seg < m - 2 && cum[seg + 1] < s) seg++;
    const f = cum[seg + 1] > cum[seg] ? Math.min(1, (s - cum[seg]) / (cum[seg + 1] - cum[seg])) : 0;
    x[j] = pts[2 * seg] + f * (pts[2 * seg + 2] - pts[2 * seg]);
    y[j] = pts[2 * seg + 1] + f * (pts[2 * seg + 3] - pts[2 * seg + 1]);
  }
  for (let j = 1, seg = 0; j < n; j++) {
    const s = (L * (j - 0.5)) / (n - 1);
    while (seg < m - 2 && cum[seg + 1] < s) seg++;
    K.push(kinds[seg]);
  }
  return { x, y, kinds: K, L };
}

/** In-place iterative radix-2 FFT of (re, im), length a power of 2; inverse when inv. */
export function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * 'fourier': the line low-passed in the frequency domain, wiggles shorter than
 * the LENGTH SCALE λ taken out. The line is resampled evenly, its straight
 * end-to-end trend subtracted (so both ends sit at 0), and the rest reflected
 * oddly about its ends into one period of a sine series, so the transform sees
 * no jump at the seam and the ends do not move. Each frequency f (cycles per
 * mm) is kept by exp(−ln2·(fλ)²): half of a wiggle λ long survives, a shorter
 * one much less (a smooth roll-off, so no ringing next to sharp corners). The
 * x and y signals go through one complex transform, x + iy. Not held to the
 * stray: λ is the control. Not simplified after, for the reason optimize is not.
 */
export function fourierLine(pts, kinds, lambda, R) {
  const m = pts.length / 2;
  let L = 0;
  for (let i = 1; i < m; i++) L += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  const want = Math.max(0.2, Math.min(lambda / 8, R > 0 ? R / 3 : 1));
  // n points, an odd reflection of period M = 2(n − 1), a power of 2
  let M = 4;
  while (M / 2 + 1 < L / want + 1 && M < 1 << 20) M <<= 1;
  const n = M / 2 + 1;
  if (L < 1e-6) return { pts, kinds };
  const r = resample(pts, kinds, n);
  const re = new Float64Array(M), im = new Float64Array(M);
  const tx = (j) => r.x[0] + ((r.x[n - 1] - r.x[0]) * j) / (n - 1), ty = (j) => r.y[0] + ((r.y[n - 1] - r.y[0]) * j) / (n - 1);
  for (let j = 0; j < n; j++) { re[j] = r.x[j] - tx(j); im[j] = r.y[j] - ty(j); }
  for (let j = 1; j < n - 1; j++) { re[M - j] = -re[j]; im[M - j] = -im[j]; }
  fft(re, im);
  const ds = L / (n - 1);
  for (let k = 0; k < M; k++) {
    const f = Math.min(k, M - k) / (M * ds);
    const h = Math.exp(-Math.LN2 * (f * lambda) ** 2);
    re[k] *= h; im[k] *= h;
  }
  fft(re, im, true);
  const out = [];
  for (let j = 0; j < n; j++) out.push(re[j] + tx(j), im[j] + ty(j));
  out[0] = pts[0]; out[1] = pts[1]; out[2 * n - 2] = pts[2 * m - 2]; out[2 * n - 1] = pts[2 * m - 1];
  return { pts: out, kinds: r.kinds };
}

/**
 * 'pid': the line STEERED, as a vehicle driving at constant speed. Its state
 * is a position and a heading; each step of ds it turns at a curvature κ
 * (angular speed per unit length) and moves on, so each step is an arc of
 * radius 1/|κ| and the path is tangent everywhere by construction. κ is
 * capped at 1/R (at least look/4, for a pen), so no bend is tighter than R: there are no tight corners, only
 * stray. The controller aims at a point LOOK mm ahead on the traced line (from
 * its progress along it, which only moves forward, inside a window, so a
 * retraced run is not mistaken for the run beside it):
 *
 *   e  = the heading error to that point (radians)
 *   κ  = (P·e + D·look·de/ds) / look,   capped at ±1/R
 *
 * a PD controller (its setting is still called 'pid'). P = 2 is pure pursuit's geometry
 * (the arc through the target point); D damps the swing out of a turn. There is
 * no integral term: tried (I 0.3, with D raised to 1 in the same run), the
 * stray moved by under 10%; it was taken out at the user's request. At a dead
 * end the car cannot turn round on the spot, so it loops at the radius and picks
 * the line up again. It stops at the end of the line (or once past it, getting
 * no nearer).
 * @returns {{path, h0, h1, steps}}
 */
export function steerLine(pts, kinds, R, g) {
  const look = Math.max(0.5, g.look ?? 4), P = g.p ?? 1, D = Math.min(PID_D_MAX, g.d ?? 1);
  // no bend (a pen) still turns no tighter than a quarter of the look ahead: uncapped,
  // the controller swings at the scale of one step and chatters
  const kMax = 1 / Math.max(R, look / 4);
  const ds = Math.max(0.1, Math.min(R > 0 ? R / 4 : 0.5, look / 8, 0.5));
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  const n = Math.max(2, Math.ceil(L / (ds / 2)) + 1);   // the reference, twice as fine as the steps
  const ref = resample(pts, kinds, n);
  const dr = L / (n - 1);
  const ahead = Math.max(1, Math.round(look / dr));
  const win = Math.max(ahead * 2, Math.round((look + 4 * (R || 1) + 5) / dr));
  let x = ref.x[0], y = ref.y[0];
  let h = Math.atan2(ref.y[1] - ref.y[0], ref.x[1] - ref.x[0]);
  const h0 = h;
  const segs = [];
  let prog = 0, ePrev = null, lastD = Infinity, steps = 0, kPrev = NaN;
  const maxSteps = Math.ceil((3 * L) / ds) + 4000;
  const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  for (; steps < maxSteps; steps++) {
    // progress: the nearest reference point within the window ahead
    let best = prog, bd = Infinity;
    for (let j = prog; j <= Math.min(n - 1, prog + win); j++) {
      const d = (ref.x[j] - x) ** 2 + (ref.y[j] - y) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    prog = best;
    const dEnd = Math.hypot(ref.x[n - 1] - x, ref.y[n - 1] - y);
    if (prog >= n - 1 - ahead && (dEnd < ds || dEnd > lastD)) break;
    lastD = prog >= n - 1 - ahead ? dEnd : Infinity;
    const t = Math.min(n - 1, prog + ahead);
    const e = wrap(Math.atan2(ref.y[t] - y, ref.x[t] - x) - h);
    const de = ePrev === null ? 0 : wrap(e - ePrev) / ds;
    ePrev = e;
    let k = (P * e + D * look * de) / look;
    k = Math.max(-kMax, Math.min(kMax, k));
    const kind = ref.kinds[Math.min(ref.kinds.length - 1, prog)] || 'edge';
    // one step: a straight, or an arc of radius 1/|k| (merged into the last when the same)
    const last = segs[segs.length - 1];
    if (Math.abs(k) < 1e-9) {
      x += ds * Math.cos(h); y += ds * Math.sin(h);
      if (last && last.k === 'L' && kPrev === 0 && last.kind === kind) { last.x = x; last.y = y; } else segs.push({ k: 'L', x, y, kind });
      kPrev = 0;
    } else {
      const cx = x - Math.sin(h) / k, cy = y + Math.cos(h) / k, r = 1 / Math.abs(k);
      const a0 = Math.atan2(y - cy, x - cx), sweep = k * ds;
      x = cx + r * Math.cos(a0 + sweep); y = cy + r * Math.sin(a0 + sweep);
      h += sweep;
      if (last && last.k === 'A' && k === kPrev && last.kind === kind) { last.sweep += sweep; last.x = x; last.y = y; } else segs.push({ k: 'A', x, y, cx, cy, r, a0, sweep, kind });
      kPrev = k;
    }
  }
  return { path: { x0: ref.x[0], y0: ref.y[0], segs }, h0, h1: h, steps };
}
