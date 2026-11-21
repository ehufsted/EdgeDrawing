// Hand edits to the edges: an eraser and a pencil, applied to the cleaned edge
// graph (core/graph.js) before the line is joined, so the route, the smoothing,
// the bends and the marks all follow them.
//
// EDITS ARE STROKES IN mm, kept in settings.edits and applied in order on every
// run, so they survive any change that leaves the drawing's size alone (a new
// edge scale or detail level: an erased area stays erased, a drawn line stays):
//
//   {op: 'erase', r, pts}   every edge within r mm of the stroke is cut away
//   {op: 'draw', pts}       a new edge along the stroke
//
// ERASING. An edge near the stroke is resampled finely (so a long straight is
// cut where the stroke crosses it, not at its far ends), the points within r of
// the stroke are dropped, and each run of points left is an edge of its own; a
// run's ends that were not the edge's ends become new loose ends.
//
// DRAWING. The stroke is smoothed lightly and simplified like a traced edge.
// Each end that lands within SNAP mm (at least the smallest feature) of an edge
// is joined to it: to its node when one is that near, otherwise to the nearest
// point on it, which splits that edge. So a line drawn from one edge to another
// connects them, and the line through them can run straight on.

import { smoothLine, rdp, polyLength } from './graph.js';

export const SNAP = 2;   // mm, at least: how near an end must be to an edge to join it

/**
 * @param {{nodes:[{x, y}], edges:[{a, b, pts}]}} graph   cleanGraph's (not changed)
 * @param {[object]} edits
 * @param {{minFeature:number, simplify:number}} d  mm
 * @returns {{nodes, edges, drawn:Set, applied:number}}  drawn: the edges that came from the pencil
 */
export function applyEdits(graph, edits, d) {
  let nodes = graph.nodes.map((p) => ({ x: p.x, y: p.y }));
  let edges = graph.edges.map((e) => ({ a: e.a, b: e.b, pts: e.pts.slice(), drawn: false }));
  let applied = 0;
  for (const ed of edits || []) {
    if (ed.op === 'erase') {
      const r = erase(nodes, edges, ed, d);
      if (r.changed) applied++;
      edges = r.edges;
    } else if (ed.op === 'draw') {
      const added = draw(nodes, edges, ed, d);
      if (added) applied++;
    }
  }
  // only the nodes some edge still uses, renumbered
  const map = new Int32Array(nodes.length).fill(-1);
  const out = [];
  const id = (i) => { if (map[i] < 0) { map[i] = out.length; out.push(nodes[i]); } return map[i]; };
  const kept = edges.filter((e) => e.pts.length >= 4).map((e) => ({ a: id(e.a), b: id(e.b), pts: e.pts, drawn: e.drawn }));
  nodes = out;
  const drawn = new Set();
  kept.forEach((e, i) => { if (e.drawn) drawn.add(i); });
  return { nodes, edges: kept.map(({ a, b, pts }) => ({ a, b, pts })), drawn, applied };
}

function segDist(x, y, ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) { ax = bx; ay = by; } else if (t > 0) { ax += dx * t; ay += dy * t; }
  }
  return Math.hypot(x - ax, y - ay);
}

/** Distance from (x, y) to a flat polyline (a single point counts as a dot). */
function toStroke(x, y, p) {
  if (p.length === 2) return Math.hypot(x - p[0], y - p[1]);
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) best = Math.min(best, segDist(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]));
  return best;
}

const boxOf = (p, pad = 0) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
};
const meets = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** A polyline with points at most `step` apart (the given ones kept). */
function densify(p, step) {
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], ay = p[i - 1], bx = p[i], by = p[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 1; j <= n; j++) out.push(ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n);
  }
  return out;
}

function erase(nodes, edges, ed, d) {
  const r = ed.r, stroke = ed.pts;
  const zone = boxOf(stroke, r);
  const out = [];
  let changed = false;
  for (const e of edges) {
    if (!meets(boxOf(e.pts), zone)) { out.push(e); continue; }
    const p = densify(e.pts, Math.max(0.05, Math.min(r / 3, 0.5)));
    const m = p.length / 2;
    const inside = new Uint8Array(m);
    let any = false;
    for (let i = 0; i < m; i++) if (toStroke(p[2 * i], p[2 * i + 1], stroke) <= r) { inside[i] = 1; any = true; }
    if (!any) { out.push(e); continue; }
    changed = true;
    // each run of points outside the stroke is an edge of its own
    let i = 0;
    while (i < m) {
      if (inside[i]) { i++; continue; }
      let j = i;
      while (j + 1 < m && !inside[j + 1]) j++;
      if (j > i) {
        const run = p.slice(2 * i, 2 * j + 2);
        const a = i === 0 ? e.a : newNode(nodes, run[0], run[1]);
        const b = j === m - 1 ? e.b : newNode(nodes, run[run.length - 2], run[run.length - 1]);
        out.push({ a, b, pts: rdp(run, d.simplify), drawn: e.drawn });
      }
      i = j + 1;
    }
  }
  return { edges: out, changed };
}

function newNode(nodes, x, y) {
  nodes.push({ x, y });
  return nodes.length - 1;
}

/**
 * The nearest point on any edge to (x, y), within `reach`: a node (an edge's end)
 * when one is within reach / 2, so ends meet at nodes rather than beside them.
 * @returns {{node:number}|{e:number, seg:number, x, y}|null}
 */
function nearestOn(nodes, edges, x, y, reach) {
  // a node within half the reach first
  let node = -1, nd = reach / 2;
  for (const e of edges) {
    for (const v of [e.a, e.b]) {
      const dd = Math.hypot(nodes[v].x - x, nodes[v].y - y);
      if (dd <= nd) { nd = dd; node = v; }
    }
  }
  if (node >= 0) return { node };
  let best = null, bd = reach;
  edges.forEach((e, ei) => {
    const p = e.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const qx = ax + t * dx, qy = ay + t * dy, dd = Math.hypot(qx - x, qy - y);
      if (dd < bd) { bd = dd; best = { e: ei, seg: i / 2, x: qx, y: qy }; }
    }
  });
  return best;
}

/** Split edge ei at a point on its segment `seg`; returns the new node. */
function splitAt(nodes, edges, ei, seg, x, y) {
  const e = edges[ei], p = e.pts;
  const id = newNode(nodes, x, y);
  const first = p.slice(0, 2 * seg + 2).concat([x, y]);
  const second = [x, y].concat(p.slice(2 * seg + 2));
  edges[ei] = { a: e.a, b: id, pts: first, drawn: e.drawn };
  edges.push({ a: id, b: e.b, pts: second, drawn: e.drawn });
  return id;
}

function draw(nodes, edges, ed, d) {
  let p = ed.pts;
  if (p.length < 4 || polyLength(p) < 0.5) return false;
  p = rdp(smoothLine(densify(p, 0.25), 0.5), d.simplify);
  const reach = Math.max(SNAP, d.minFeature);
  // each end near an edge joins it: to a node, or by splitting the edge there.
  // One after the other, so the second sees the first's split (the new edge
  // itself is not in the graph yet, so an end never snaps to its own line)
  const endAt = (x, y) => {
    const hit = nearestOn(nodes, edges, x, y, reach);
    if (!hit) return { node: newNode(nodes, x, y), x, y };
    if (hit.node !== undefined) return { node: hit.node, x: nodes[hit.node].x, y: nodes[hit.node].y };
    return { node: splitAt(nodes, edges, hit.e, hit.seg, hit.x, hit.y), x: hit.x, y: hit.y };
  };
  const ends = [endAt(p[0], p[1]), endAt(p[p.length - 2], p[p.length - 1])];
  const pts = p.slice();
  pts[0] = ends[0].x; pts[1] = ends[0].y;
  pts[pts.length - 2] = ends[1].x; pts[pts.length - 1] = ends[1].y;
  edges.push({ a: ends[0].node, b: ends[1].node, pts, drawn: true });
  return true;
}

/**
 * Edits from a project or settings, made safe: known ops, finite points, a
 * positive eraser size. @returns {{edits, dropped:number}}
 */
export function parseEdits(list) {
  const edits = [];
  let dropped = 0;
  for (const e of Array.isArray(list) ? list : []) {
    const pts = e && Array.isArray(e.pts) ? e.pts.map(Number) : null;
    const ok = pts && pts.length >= 2 && pts.length % 2 === 0 && pts.every(isFinite);
    if (ok && e.op === 'erase' && Number(e.r) > 0) edits.push({ op: 'erase', r: Number(e.r), pts });
    else if (ok && e.op === 'draw' && pts.length >= 4) edits.push({ op: 'draw', pts });
    else dropped++;
  }
  return { edits, dropped };
}
