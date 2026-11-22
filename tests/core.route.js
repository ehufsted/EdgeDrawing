// core/route.js: one continuous line through every edge, both ways.

import { section, check, num } from './runner.js';
import { routeGraph, hierholzer } from '../src/core/route.js';
import { polyLength } from '../src/core/graph.js';

/** A graph from polylines; ends closer than 1e-6 share a node. */
function graphOf(lines) {
  const nodes = [], edges = [];
  const node = (x, y) => {
    let i = nodes.findIndex((p) => Math.hypot(p.x - x, p.y - y) < 1e-6);
    if (i < 0) { i = nodes.length; nodes.push({ x, y }); }
    return i;
  };
  for (const p of lines) edges.push({ a: node(p[0], p[1]), b: node(p[p.length - 2], p[p.length - 1]), pts: p });
  return { nodes, edges };
}

/** Continuity, and the total length by kind. */
function measure(route) {
  let gap = 0;
  const by = { edge: 0, retrace: 0, join: 0 };
  for (let i = 0; i < route.runs.length; i++) {
    const p = route.runs[i].pts;
    if (i) { const q = route.runs[i - 1].pts; gap = Math.max(gap, Math.hypot(p[0] - q[q.length - 2], p[1] - q[q.length - 1])); }
    by[route.runs[i].kind] += polyLength(p);
  }
  return { gap, ...by };
}

/** Every segment of every input line is drawn by some 'edge' run (as a set of segment keys). */
function covers(route, lines) {
  const key = (ax, ay, bx, by) => (ax < bx || (ax === bx && ay < by) ? `${ax},${ay},${bx},${by}` : `${bx},${by},${ax},${ay}`);
  const drawn = new Map();
  for (const r of route.runs) {
    if (r.kind !== 'edge') continue;
    for (let i = 2; i < r.pts.length; i += 2) { const k = key(r.pts[i - 2], r.pts[i - 1], r.pts[i], r.pts[i + 1]); drawn.set(k, (drawn.get(k) || 0) + 1); }
  }
  let missing = 0, twice = 0;
  for (const p of lines) for (let i = 2; i < p.length; i += 2) {
    const c = drawn.get(key(p[i - 2], p[i - 1], p[i], p[i + 1])) || 0;
    if (!c) missing++; else if (c > 1) twice++;
  }
  return { missing, twice };
}

export function run() {
  section('core.route', 'Prediction: every route is one continuous line (no gap) that draws each edge of the image exactly once as "edge"; it adds one bridge per extra piece; set to retrace, it retraces only the shortest pairings; otherwise it joins a pair by a new straight, unless the way along the lines is just as short (straight), which it retraces; closed ends where it started.');

  // a star: three spokes of 10, 20 and 30 from the centre -> 4 odd nodes; one pair is joined
  const star = [[0, 0, 10, 0], [0, 0, 0, 20], [0, 0, -30, 0]];
  const s1 = routeGraph(graphOf(star), { retrace: true, start: { x: 0, y: 25 }, closed: false });
  const m1 = measure(s1), c1 = covers(s1, star);
  check('star: one continuous line', m1.gap < 1e-9, `largest gap ${m1.gap}`);
  check('star: every edge drawn once', c1.missing === 0 && c1.twice === 0, `${c1.missing} missing, ${c1.twice} twice`);
  check('star: starts at the end nearest the start point', Math.hypot(s1.start.x, s1.start.y - 20) < 1e-9, `starts at ${s1.start.x}, ${s1.start.y}`);
  check('star: retraces only the shortest spoke (10)', Math.abs(m1.retrace - 10) < 1e-9 && m1.join === 0, `retrace ${m1.retrace}, join ${m1.join}`);
  // not set to retrace: the 10 spoke is straight, as short as a new straight, so it is still retraced (it keeps to the image)
  const s2 = routeGraph(graphOf(star), { retrace: false, start: { x: 0, y: 25 }, closed: false });
  const m2 = measure(s2);
  check('star, shorter way: a straight spoke is as short as a new line, so retraced', Math.abs(m2.retrace - 10) < 1e-9 && m2.join === 0 && m2.gap < 1e-9, `retrace ${num(m2.retrace, 2)}, join ${num(m2.join, 2)}`);
  // ...but with the short spoke bent (14.1 along it, 10 straight back) a new straight is shorter
  const bentStar = [[0, 0, 5, 5, 10, 0], [0, 0, 0, 20], [0, 0, -30, 0]];
  const s3 = routeGraph(graphOf(bentStar), { retrace: false, start: { x: 0, y: 25 }, closed: false });
  const m3b = measure(s3), c3b = covers(s3, bentStar);
  check('...with that spoke bent, a new straight of 10 instead, every edge once', m3b.retrace === 0 && Math.abs(m3b.join - 10) < 1e-9 && m3b.gap < 1e-9 && c3b.missing === 0 && c3b.twice === 0,
    `retrace ${num(m3b.retrace, 2)}, join ${num(m3b.join, 2)}`);

  // three separate pieces: two squares (loops) and a line
  const sq = (x, y, a) => [x, y, x + a, y, x + a, y + a, x, y + a, x, y];
  const pieces = [sq(0, 0, 10), sq(40, 0, 10), [0, 40, 50, 40]];
  const e3 = routeGraph(graphOf(pieces), { retrace: true, start: null, closed: false });
  const m3 = measure(e3), c3 = covers(e3, pieces);
  check('three pieces, Eulerian: two bridges, continuous, all edges once', e3.stats.bridges === 2 && m3.gap < 1e-9 && c3.missing === 0 && c3.twice === 0,
    `${e3.stats.bridges} bridges, gap ${m3.gap}, ${c3.missing} missing, ${c3.twice} twice`);
  const k30 = m3.join / 30;
  check('...the bridges are the shortest ways between the pieces (two of 30; a bridge may be retraced)', k30 > 2 - 1e-6 && Math.abs(k30 - Math.round(k30)) < 1e-6, `join length ${num(m3.join, 2)}`);
  const closed = routeGraph(graphOf(star), { retrace: true, start: { x: 0, y: 25 }, closed: true });
  check('closed: ends where it starts', Math.hypot(closed.start.x - closed.end.x, closed.start.y - closed.end.y) < 1e-9, `start ${closed.start.x},${closed.start.y} end ${closed.end.x},${closed.end.y}`);
  const nclosed = routeGraph(graphOf(pieces), { retrace: false, start: null, closed: true });
  const mn = measure(nclosed), cn = covers(nclosed, pieces);
  check('closed, three pieces, shorter way: ends where it starts, continuous, all edges once', Math.hypot(nclosed.start.x - nclosed.end.x, nclosed.start.y - nclosed.end.y) < 1e-9 && mn.gap < 1e-9 && cn.missing === 0 && cn.twice === 0, '');

  // Hierholzer prefers straight on: a cross at the centre, entered from the left, continues right
  const cross = graphOf([[-10, 0, 0, 0], [0, 0, 10, 0], [0, 0, 0, 10], [0, 0, 0, -10], [-10, 0, -10, 10, 0, 10]]);
  // nodes: (-10,0) deg 2, centre deg 4, (10,0) deg 1, (0,10) deg 2, (0,-10) deg 1 -> walk from (10,0)
  const startNode = cross.nodes.findIndex((p) => p.x === 10 && p.y === 0);
  const walk = hierholzer(cross.nodes.length, cross.edges, startNode);
  check('Hierholzer walks every edge once', walk.length === cross.edges.length && new Set(walk.map((w) => w.e)).size === walk.length, `${walk.length} of ${cross.edges.length}`);
  check('...and at the junction goes straight on (from the right, on to the left)', walk.length > 1 && walk[1].e === 0, `second edge ${walk.length > 1 ? walk[1].e : '—'}`);

  const empty = routeGraph({ nodes: [], edges: [] }, {});
  check('no edges: an empty route', empty.runs.length === 0 && empty.start === null, '');
}
