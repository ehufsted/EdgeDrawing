// The line as STRAIGHTS AND ARCS, tangent where they meet (G1), every arc at
// least the smallest bend radius: what a pen draws and wire can be bent to.
//
// THE ROUTE (core/route.js) is a polyline. Each corner of it is rounded by a
// FILLET, an arc tangent to both of its straights:
//
//   θ = how far the line turns at the corner (0 straight on, π a full reversal)
//   t = r · tan(θ/2)        how far back along each straight the arc starts
//   r(1/cos(θ/2) − 1)       how far the arc passes from the corner itself
//
// The radius each corner WANTS keeps that last distance within `tol` (the
// simplify tolerance): a gentle corner, which simplification left on a curve,
// gets a big arc and the curve comes back smooth; a sharp one, a real corner of
// the image, gets a small arc and stays a corner. Never less than the smallest
// bend radius. Two corners share each straight, so when their t's do not both
// fit, each first gets what the smallest radius needs, the rest of the straight
// is shared in proportion to what each wants beyond that, and a corner's radius
// shrinks to what it got. (Shared simply in proportion, a nearly straight corner,
// which wants a huge arc, took the room its sharp neighbour needed to bend at all.)
//
// A corner that cannot get the smallest radius is TIGHT. With corner loops on
// (and the turn no sharper than LOOP_MAX: nearer a full reversal the loop would
// be a teardrop many radii long), it becomes a LOOP instead: the line
// runs on past the corner, turns the other way round a circle of the smallest
// radius (through 2π − θ), and comes back across itself onto the next straight.
// The loop's tangent points are the same distance t from the corner, but OUTSIDE
// it, so a loop takes nothing from the straights. Otherwise the corner keeps the
// largest arc that fits, and is reported (the Problems view shows where).
//
// THE PATH: { x0, y0, segs: [...] } in mm, each seg ending where the next
// begins: {k:'L', x, y, kind} a straight to (x, y); {k:'A', x, y, cx, cy, r, a0,
// sweep, kind} an arc round (cx, cy) from angle a0 through `sweep` radians
// (positive = increasing angle, which on a y-down canvas is clockwise), ending
// at (x, y). kind is the route's: 'edge', 'retrace' or 'join'.

export const LOOP_MAX = (135 * Math.PI) / 180;   // tan(67.5°) = 2.4: a loop overshoots its corner by at most 2.4 radii
const EPS = 1e-7;

/**
 * The route's runs as one polyline: flat points and the kind of each segment
 * (the segment from point i to i+1), repeated points dropped.
 */
export function routePolyline(runs) {
  const pts = [], kinds = [];
  for (const run of runs) {
    const p = run.pts;
    for (let i = 0; i < p.length; i += 2) {
      const n = pts.length;
      if (n && Math.hypot(p[i] - pts[n - 2], p[i + 1] - pts[n - 1]) < 1e-6) continue;
      if (n) kinds.push(run.kind);
      pts.push(p[i], p[i + 1]);
    }
  }
  return { pts, kinds };
}

/**
 * @param {number[]} pts     flat polyline, mm
 * @param {string[]} kinds   per segment
 * @param {{minRadius:number, tol:number, loops:boolean, maxDev?:number}} o
 *   maxDev: a corner whose arc would pass farther than this from it is tight (none by default)
 * @returns {{path, tight:[{x, y, r, i}], loops:number}}   i: the vertex of pts
 */
export function fitArcs(pts, kinds, o) {
  ({ pts, kinds } = dedupe(pts, kinds));
  const m = pts.length / 2;
  const minR = Math.max(0, o.minRadius || 0), tol = Math.max(1e-3, o.tol || 0.3);
  const maxDev = o.maxDev > 0 ? o.maxDev : Infinity;
  if (m < 2) return { path: { x0: pts[0] || 0, y0: pts[1] || 0, segs: [] }, tight: [], loops: 0 };
  // per segment: unit direction and length
  const ux = new Float64Array(m - 1), uy = new Float64Array(m - 1), len = new Float64Array(m - 1);
  for (let i = 0; i < m - 1; i++) {
    const dx = pts[2 * i + 2] - pts[2 * i], dy = pts[2 * i + 3] - pts[2 * i + 1];
    len[i] = Math.hypot(dx, dy);
    ux[i] = dx / len[i]; uy[i] = dy / len[i];
  }
  // per corner (vertex 1..m-2): turn θ, its side, the radius it wants, its tan(θ/2)
  const th = new Float64Array(m), side = new Int8Array(m), want = new Float64Array(m), tn = new Float64Array(m), near = new Float64Array(m);
  for (let i = 1; i < m - 1; i++) {
    const c = ux[i - 1] * ux[i] + uy[i - 1] * uy[i], s = ux[i - 1] * uy[i] - uy[i - 1] * ux[i];
    th[i] = Math.atan2(Math.abs(s), c);
    side[i] = s >= 0 ? 1 : -1;
    if (th[i] < 1e-4) continue;
    const half = th[i] / 2;
    tn[i] = Math.tan(Math.min(half, Math.PI / 2 - 1e-6));
    const dev = 1 / Math.cos(Math.min(half, Math.PI / 2 - 1e-6)) - 1;
    near[i] = tol / dev;
    want[i] = Math.max(minR, near[i]);
  }
  // corners that will be loops take nothing from the straights; decided in two passes
  const isLoop = new Uint8Array(m);
  let r = new Float64Array(m);
  for (let pass = 0; pass < 2; pass++) {
    const demand = new Float64Array(m);
    for (let i = 1; i < m - 1; i++) if (!isLoop[i] && th[i] >= 1e-4) demand[i] = want[i] * tn[i];
    const avail = new Float64Array(m).fill(Infinity);
    for (let s = 0; s < m - 1; s++) {
      const a = demand[s], b = demand[s + 1], L = len[s];
      // what each needs for the smallest radius first, then the rest in proportion to
      // what each wants beyond it (a gentle corner wants a huge arc, and must not
      // take the room a sharp neighbour needs to bend at all)
      const ra = Math.min(a, minR * tn[s]), rb = Math.min(b, minR * tn[s + 1]);
      let fa = a, fb = b;
      if (a + b > L) {
        if (ra + rb <= L) {
          const ea = a - ra, eb = b - rb, rest = L - ra - rb;
          fa = ra + (ea + eb > 0 ? (rest * ea) / (ea + eb) : 0); fb = rb + (ea + eb > 0 ? (rest * eb) / (ea + eb) : 0);
        } else { fa = (L * ra) / (ra + rb); fb = (L * rb) / (ra + rb); }
      }
      avail[s] = Math.min(avail[s], fa);
      avail[s + 1] = Math.min(avail[s + 1], fb);
    }
    r = new Float64Array(m);
    let changed = false;
    for (let i = 1; i < m - 1; i++) {
      if (th[i] < 1e-4 || isLoop[i]) continue;
      r[i] = Math.min(want[i], avail[i] / tn[i]);
      if (r[i] < minR - EPS && o.loops && minR > 0 && th[i] <= LOOP_MAX) { isLoop[i] = 1; changed = true; }
      // a tight corner (no loop) keeps within the tolerance of its point, like any
      // other: rounded with all the room it has, a near reversal would cut the
      // stroke back by a whole straight for an arc of almost no radius
      else if (r[i] < minR - EPS) r[i] = Math.min(r[i], near[i]);
      else {
        // an arc may pass no farther than maxDev from its corner: the radius is held
        // to the one that passes exactly there, and only if that is under the
        // smallest bend (the smallest bend in a sharp V cuts its tip off) is the
        // corner tight, kept to its point like any other tight corner
        const dev = 1 / Math.cos(Math.min(th[i] / 2, Math.PI / 2 - 1e-6)) - 1;
        if (r[i] * dev > maxDev) {
          r[i] = Math.min(r[i], maxDev / dev);
          if (r[i] < minR - EPS) r[i] = Math.min(r[i], near[i]);
        }
      }
    }
    if (!changed) break;
  }

  const segs = [];
  const tight = [];
  let loops = 0;
  let x = pts[0], y = pts[1];
  const lineTo = (nx, ny, kind) => {
    if (Math.hypot(nx - x, ny - y) > EPS) segs.push({ k: 'L', x: nx, y: ny, kind });
    x = nx; y = ny;
  };
  const arc = (cx, cy, rad, a0, sweep, kind) => {
    const ex = cx + rad * Math.cos(a0 + sweep), ey = cy + rad * Math.sin(a0 + sweep);
    segs.push({ k: 'A', x: ex, y: ey, cx, cy, r: rad, a0, sweep, kind });
    x = ex; y = ey;
  };
  for (let i = 1; i < m - 1; i++) {
    const vx = pts[2 * i], vy = pts[2 * i + 1];
    const kin = kinds[i - 1];
    if (th[i] < 1e-4) { lineTo(vx, vy, kin); continue; }
    // the left normal of a direction (u, v) is (−v, u); with y down it is on the right on screen, which does not matter here
    if (isLoop[i]) {
      const t = minR * tn[i];
      const t1x = vx + ux[i - 1] * t, t1y = vy + uy[i - 1] * t;   // past the corner on the way in
      lineTo(t1x, t1y, kin);
      // the loop turns the other way from the corner: its centre is on the far side
      const nx = side[i] * uy[i - 1], ny = -side[i] * ux[i - 1];
      const cx = t1x + nx * minR, cy = t1y + ny * minR;
      const a0 = Math.atan2(t1y - cy, t1x - cx);
      arc(cx, cy, minR, a0, -side[i] * (2 * Math.PI - th[i]), kin);
      loops++;
      continue;
    }
    const rad = r[i];
    if (rad < minR - EPS) tight.push({ x: vx, y: vy, r: rad, i });
    if (rad < 1e-6) { lineTo(vx, vy, kin); continue; }
    const t = rad * tn[i];
    const t1x = vx - ux[i - 1] * t, t1y = vy - uy[i - 1] * t;
    lineTo(t1x, t1y, kin);
    const nx = -side[i] * uy[i - 1], ny = side[i] * ux[i - 1];
    const cx = t1x + nx * rad, cy = t1y + ny * rad;
    const a0 = Math.atan2(t1y - cy, t1x - cx);
    arc(cx, cy, rad, a0, side[i] * th[i], kin);
  }
  lineTo(pts[2 * m - 2], pts[2 * m - 1], kinds[m - 2]);
  return { path: { x0: pts[0], y0: pts[1], segs }, tight, loops };
}

/** Length of each seg. */
export const segLength = (s, x, y) => (s.k === 'L' ? Math.hypot(s.x - x, s.y - y) : s.r * Math.abs(s.sweep));

/**
 * Length overall and by kind, bends (arcs), the tightest arc.
 * @returns {{length, edge, retrace, join, bends, minR}}
 */
export function pathStats(path) {
  const out = { length: 0, edge: 0, retrace: 0, join: 0, bends: 0, minR: Infinity };
  let x = path.x0, y = path.y0;
  for (const s of path.segs) {
    const L = segLength(s, x, y);
    out.length += L;
    out[s.kind] = (out[s.kind] || 0) + L;
    if (s.k === 'A') { out.bends++; if (s.r < out.minR) out.minR = s.r; }
    x = s.x; y = s.y;
  }
  return out;
}

/**
 * The path as a dense polyline, arcs in steps of at most `step` radians:
 * {pts, kinds, cum} with cum the length to each point.
 */
export function samplePath(path, step = Math.PI / 18) {
  const pts = [path.x0, path.y0], kinds = [], cum = [0];
  let x = path.x0, y = path.y0, acc = 0;
  for (const s of path.segs) {
    if (s.k === 'L') {
      acc += Math.hypot(s.x - x, s.y - y);
      pts.push(s.x, s.y); kinds.push(s.kind); cum.push(acc);
    } else {
      const n = Math.max(1, Math.ceil(Math.abs(s.sweep) / step));
      for (let j = 1; j <= n; j++) {
        const a = s.a0 + (s.sweep * j) / n;
        const px = j === n ? s.x : s.cx + s.r * Math.cos(a), py = j === n ? s.y : s.cy + s.r * Math.sin(a);
        acc += Math.hypot(px - pts[pts.length - 2], py - pts[pts.length - 1]);
        pts.push(px, py); kinds.push(s.kind); cum.push(acc);
      }
    }
    x = s.x; y = s.y;
  }
  return { pts, kinds, cum };
}

/**
 * Where the line crosses itself: proper crossings between segments of the
 * sampled path that are not neighbours, with crossings closer than `merge` mm
 * counted as one (a retraced run lies on its original and touches it all along,
 * which is not a crossing: collinear touching is not counted).
 * @returns {[{x, y}]}
 */
export function crossings(sampled, merge = 1) {
  const p = sampled.pts, m = p.length / 2;
  if (m < 4) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, total = 0;
  for (let i = 0; i < m; i++) { x0 = Math.min(x0, p[2 * i]); x1 = Math.max(x1, p[2 * i]); y0 = Math.min(y0, p[2 * i + 1]); y1 = Math.max(y1, p[2 * i + 1]); }
  for (let i = 0; i < m - 1; i++) total += Math.hypot(p[2 * i + 2] - p[2 * i], p[2 * i + 3] - p[2 * i + 1]);
  const cell = Math.max(1, Math.min(20, (2 * total) / (m - 1)));
  const grid = new Map();
  const key = (gx, gy) => gx * 1000003 + gy;
  const cellsOf = [];
  for (let i = 0; i < m - 1; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
    const mine = [];
    for (let gx = Math.floor(Math.min(ax, bx) / cell); gx <= Math.floor(Math.max(ax, bx) / cell); gx++) {
      for (let gy = Math.floor(Math.min(ay, by) / cell); gy <= Math.floor(Math.max(ay, by) / cell); gy++) {
        const k = key(gx, gy);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(i);
        mine.push(k);
      }
    }
    cellsOf.push(mine);
  }
  // each segment against the later ones sharing a cell with it (a set per segment,
  // not one of every pair: a dense line has more pairs than a Set can hold)
  const found = [];
  for (let i = 0; i < m - 1; i++) {
    const cand = new Set();
    for (const k of cellsOf[i]) for (const j of grid.get(k)) if (j > i + 1) cand.add(j);
    for (const j of cand) {
      const hit = properCross(p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3], p[2 * j], p[2 * j + 1], p[2 * j + 2], p[2 * j + 3]);
      if (hit) found.push(hit);
    }
  }
  found.sort((a, b) => a.x - b.x || a.y - b.y);
  // crossings closer than `merge` are one: binned, so many crossings stay quick
  const out = [], bins = new Map();
  const mk = (x, y) => key(Math.floor(x / merge), Math.floor(y / merge));
  for (const f of found) {
    const bx = Math.floor(f.x / merge), by = Math.floor(f.y / merge);
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++) {
      for (const q of bins.get(key(bx + dx, by + dy)) || []) if (Math.hypot(q.x - f.x, q.y - f.y) < merge) { near = true; break; }
    }
    if (near) continue;
    out.push(f);
    const k = mk(f.x, f.y);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(f);
  }
  return out;
}

function properCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay), d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy), d4 = o(ax, ay, bx, by, dx, dy);
  const e = 1e-9;
  if (((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e))) {
    const t = d1 / (d1 - d2);
    return { x: ax + t * (bx - ax), y: ay + t * (by - ay) };
  }
  return null;
}

/** The path cut at length `upTo` (for the drawing animation): a new path. */
export function trimPath(path, upTo) {
  const segs = [];
  let x = path.x0, y = path.y0, acc = 0;
  for (const s of path.segs) {
    const L = segLength(s, x, y);
    if (acc + L <= upTo) { segs.push(s); acc += L; x = s.x; y = s.y; continue; }
    const f = L > 0 ? (upTo - acc) / L : 0;
    if (f > 0) {
      if (s.k === 'L') segs.push({ ...s, x: x + f * (s.x - x), y: y + f * (s.y - y) });
      else {
        const sw = s.sweep * f;
        segs.push({ ...s, sweep: sw, x: s.cx + s.r * Math.cos(s.a0 + sw), y: s.cy + s.r * Math.sin(s.a0 + sw) });
      }
    }
    break;
  }
  return { x0: path.x0, y0: path.y0, segs };
}

/** A polyline without repeated points (a zero-length straight has no direction): each kept segment keeps its kind. */
function dedupe(pts, kinds) {
  const P = [pts[0], pts[1]], K = [];
  for (let i = 2; i < pts.length; i += 2) {
    if (Math.hypot(pts[i] - P[P.length - 2], pts[i + 1] - P[P.length - 1]) < 1e-9) continue;
    P.push(pts[i], pts[i + 1]);
    K.push(kinds[i / 2 - 1]);
  }
  return { pts: P, kinds: K };
}
