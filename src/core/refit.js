// Fewer bends: the finished line refitted as the fewest arcs a person can bend.
//
// Steering and Fourier smoothing leave a line of thousands of short arcs, and
// any line has gentle stretches split into several. For making it by hand, it is
// refitted greedily, from its start: from the current point and heading, the
// LONGEST arc (or straight) that starts tangent to the line so far and stays
// within TOL mm of it is taken, and the next starts where and as it ends. So the
// result is tangent throughout (G1) by construction and no arc is tighter than
// the smallest bend. An arc ends on the line, or (at the bend, where a tangent
// arc through the point would be tighter) within TOL of it. An arc never spans
// two kinds (edge, retrace, join), unless a run is too short to turn in.
//
// WHEN NO ARC FITS, in order: the tolerance is loosened for that one arc (two,
// then four times); the line is rejoined a little on, exactly on it and in its
// direction, by a Dubins path (no more than twice the distance); only then is a
// corner kept, as one straight across it, and reported. (A line with a real
// corner sharper than the bend, one the fitting reported tight, keeps it.)
//
// A tangent arc from point P heading h through a point T is fixed by them: with
// d = T − P, its curvature is κ = 2 (h × d) / |d|², and it turns through twice
// the angle between h and d. The longest arc that fits is found by galloping
// along the line (1, 2, 4, ... samples ahead) and then bisecting, checking each
// candidate against every sample it spans. Arcs of more than half a turn are not
// taken in one piece.

import { dubins } from './dubins.js';

const EPS = 1e-9;

/** The path as samples at most `step` apart: {x, y, k (kind of the seg arriving), n}. */
function densify(path, step) {
  const X = [path.x0], Y = [path.y0], K = [null];
  let x = path.x0, y = path.y0;
  for (const s of path.segs) {
    if (s.k === 'L') {
      const L = Math.hypot(s.x - x, s.y - y);
      const n = Math.max(1, Math.ceil(L / step));
      for (let j = 1; j <= n; j++) { X.push(x + ((s.x - x) * j) / n); Y.push(y + ((s.y - y) * j) / n); K.push(s.kind); }
    } else {
      const n = Math.max(1, Math.ceil((s.r * Math.abs(s.sweep)) / step));
      for (let j = 1; j <= n; j++) {
        const a = s.a0 + (s.sweep * j) / n;
        X.push(j === n ? s.x : s.cx + s.r * Math.cos(a)); Y.push(j === n ? s.y : s.cy + s.r * Math.sin(a)); K.push(s.kind);
      }
    }
    x = s.x; y = s.y;
  }
  // repeated points carry nothing
  const x2 = [X[0]], y2 = [Y[0]], k2 = [K[1] || 'edge'];
  for (let i = 1; i < X.length; i++) {
    if (Math.hypot(X[i] - x2[x2.length - 1], Y[i] - y2[y2.length - 1]) < 1e-9) continue;
    x2.push(X[i]); y2.push(Y[i]); k2.push(K[i]);
  }
  return { x: x2, y: y2, k: k2, n: x2.length };
}

/** The heading the path starts with. */
function startHeading(path) {
  const s = path.segs[0];
  if (!s) return 0;
  if (s.k === 'L') return Math.atan2(s.y - path.y0, s.x - path.x0);
  return s.a0 + Math.sign(s.sweep) * (Math.PI / 2);
}

/**
 * @param {{x0, y0, segs}} path   core/arcs.js
 * @param {{tol:number, minRadius:number}} o  mm
 * @returns {{path, forced:[{x, y}]}}  forced: corners it could not round (left sharp)
 */
export function refitPath(path, o) {
  const tol = Math.max(0.01, o.tol);
  const kMax = o.minRadius > 0 ? 1 / o.minRadius : Infinity;
  if (path.segs.length < 2) return { path, forced: [] };
  const step = Math.max(0.05, Math.min(tol, 1));
  const S = densify(path, step);
  const n = S.n;
  const reach = Math.max(4, Math.ceil((3 * (o.minRadius || 1)) / step));
  let px = S.x[0], py = S.y[0], h = startHeading(path);
  const segs = [];
  const forced = [];   // the corners it could not round
  // where each run of one kind ends: an arc never spans two kinds, so the Route
  // view and the lengths by kind stay true
  const runEnd = new Int32Array(n);
  runEnd[n - 1] = n - 1;
  for (let q = n - 2; q >= 0; q--) runEnd[q] = S.k[q + 1] === S.k[Math.min(n - 1, q + 2)] && q + 2 < n ? runEnd[q + 1] : q + 1;
  // A candidate from the current pose toward sample j: the tangent arc through it,
  // or, when that would turn tighter than the bend, the arc AT the bend that ends
  // nearest it (within tol), so a heading carried over a little off can still
  // follow a line that runs at the bend. Every sample spanned must stay within
  // tol. Returns {k, sweep, ex, ey} or null.
  let tl = tol;   // the tolerance in force (loosened locally before a corner is kept)
  const arcTo = (i, j) => {
    const dx = S.x[j] - px, dy = S.y[j] - py, L2 = dx * dx + dy * dy;
    if (L2 < EPS) return null;
    const c = Math.cos(h), s = Math.sin(h);
    const cr = c * dy - s * dx, dt = c * dx + s * dy;
    if (dt <= 0) return null;   // more than half a turn
    let k = (2 * cr) / L2, sweep = 2 * Math.atan2(cr, dt), ex = S.x[j], ey = S.y[j];
    if (Math.abs(k) > kMax) {
      k = Math.sign(k) * kMax;
      const cx = px - s / k, cy = py + c / k, r = 1 / kMax;
      const a0 = Math.atan2(py - cy, px - cx), aT = Math.atan2(ey - cy, ex - cx);
      sweep = aT - a0;
      if (k > 0) { while (sweep < 0) sweep += 2 * Math.PI; } else { while (sweep > 0) sweep -= 2 * Math.PI; }
      if (Math.abs(sweep) >= Math.PI) return null;
      ex = cx + r * Math.cos(a0 + sweep); ey = cy + r * Math.sin(a0 + sweep);
      if (Math.hypot(ex - S.x[j], ey - S.y[j]) > tl) return null;
    }
    if (Math.abs(k) < 1e-12) {
      for (let q = i + 1; q < j; q++) if (Math.abs(c * (S.y[q] - py) - s * (S.x[q] - px)) > tl) return null;
    } else {
      const cx = px - s / k, cy = py + c / k, r = 1 / Math.abs(k);
      for (let q = i + 1; q < j; q++) if (Math.abs(Math.hypot(S.x[q] - cx, S.y[q] - cy) - r) > tl) return null;
    }
    return { k, sweep, ex, ey };
  };
  const emit = (j, a) => {
    const kind = S.k[j];
    if (Math.abs(a.k) < 1e-12) segs.push({ k: 'L', x: a.ex, y: a.ey, kind });
    else {
      const c = Math.cos(h), s = Math.sin(h);
      const cx = px - s / a.k, cy = py + c / a.k;
      segs.push({ k: 'A', x: a.ex, y: a.ey, cx, cy, r: 1 / Math.abs(a.k), a0: Math.atan2(py - cy, px - cx), sweep: a.sweep, kind });
    }
    px = a.ex; py = a.ey; h += a.sweep;
  };
  // a straight from the current point to sample j, the samples between within tol of it
  const chordTo = (i, j) => {
    const dx = S.x[j] - px, dy = S.y[j] - py, L = Math.hypot(dx, dy);
    if (L < 1e-9) return false;
    for (let q = i + 1; q < j; q++) if (Math.abs((dx * (S.y[q] - py) - dy * (S.x[q] - px)) / L) > tol) return false;
    return true;
  };
  let i = 0;
  while (i < n - 1) {
    tl = tol;
    let end = runEnd[i];
    // the nearest sample an arc can reach: the next, or (when the heading carried
    // over is a little off) one a few radii on, which needs less turn to reach
    let first = -1, a = null;
    for (let j = i + 1; j <= Math.min(end, i + reach); j++) { a = arcTo(i, j); if (a) { first = j; break; } }
    if (!a && end < n - 1) {
      // a run of one kind too short to turn in: this one arc may cross into the next
      end = n - 1;
      for (let j = i + 1; j <= Math.min(end, i + reach); j++) { a = arcTo(i, j); if (a) { first = j; break; } }
    }
    // still none: where the line runs at the bend, an arc that came in a little off
    // cannot rejoin it within tol. A sharp corner is far worse to bend than a little
    // more stray, so this one arc may stray two, then four times as far
    for (const f of [2, 4]) {
      if (a) break;
      tl = f * tol;
      for (let j = i + 1; j <= Math.min(end, i + reach); j++) { a = arcTo(i, j); if (a) { first = j; break; } }
    }
    if (!a && kMax < Infinity) {
      // rejoin the line a little on, ON it and in its direction, by the shortest path
      // no tighter than the bend (core/dubins.js), when that is no more than twice
      // the distance (a loop at most): a steered line at full lock, rippling, can
      // leave the refit just off it with no single arc back
      let done = false;
      for (let j = Math.min(n - 2, i + Math.ceil(reach / 3)); j <= Math.min(n - 2, i + 2 * reach) && !done; j++) {
        const hj = Math.atan2(S.y[j + 1] - S.y[j], S.x[j + 1] - S.x[j]);
        const d = dubins(px, py, h, S.x[j], S.y[j], hj, 1 / kMax, S.k[j]);
        if (d.length <= 2 * Math.hypot(S.x[j] - px, S.y[j] - py) + 1e-9) {
          for (const sg of d.segs) segs.push(sg);
          px = S.x[j]; py = S.y[j]; h = hj;
          i = j;
          done = true;
        }
      }
      if (done) continue;
    }
    if (!a) {
      // none within reach: a corner sharper than the bend, which the fitting
      // already reported tight. It stays ONE corner: a straight across it, as far
      // as a straight stays within tol, and the line goes on tangent to that
      let j = i + 1;
      while (j < end && chordTo(i, j + 1)) j++;
      forced.push({ x: px, y: py });
      segs.push({ k: 'L', x: S.x[j], y: S.y[j], kind: S.k[j] });
      h = Math.atan2(S.y[j] - py, S.x[j] - px);
      px = S.x[j]; py = S.y[j];
      i = j;
      continue;
    }
    let lo = first, loA = a, hi = -1, step = 1;
    while (lo < end) {
      const j = Math.min(end, lo + step);
      const t = arcTo(i, j);
      if (t) { lo = j; loA = t; step *= 2; } else { hi = j; break; }
    }
    if (hi > 0) {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const t = arcTo(i, mid);
        if (t) { lo = mid; loA = t; } else hi = mid;
      }
    }
    emit(lo, loA);
    i = lo;
  }
  return { path: { x0: path.x0, y0: path.y0, segs }, forced };
}
