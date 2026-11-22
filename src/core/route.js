// One line through the whole edge graph (core/graph.js), EULERIAN: a pen can
// draw a graph in one stroke without lifting exactly when it is connected and at
// most two nodes have an odd number of chains (Euler, 1736). So:
//
//   1. BRIDGES join the separate pieces: Borůvka's minimum spanning tree over
//      the pieces, each bridge the shortest straight line between two of them
//      (between points sampled every BRIDGE_STEP mm along their chains, so a
//      bridge can leave from the middle of a chain, which is split there).
//      A bridge prefers ODD ends (a loose end of a stroke): landing on one makes
//      it even, so the bridge chains two strokes end to end; landing anywhere
//      else makes a new odd node, which step 2 must pair. So a bridge may be
//      ODD_BONUS mm longer per end to land on an odd node.
//   2. ODD NODES are paired up, every pair but one (the line's two ends), and
//      each pair joined. By default by WHICHEVER IS SHORTER of a new straight
//      line and the way along the chains already there, pair by pair: a straight
//      is never longer, so this retraces only where that way is itself straight
//      (a tie the retrace takes, as it keeps to the image). With `retrace` on
//      (the person's choice, for a pen), always by RETRACING the shortest way
//      along chains already there: drawn twice, which on paper hides, where in
//      wire it is two wires side by side; a far longer line, but much less of it
//      outside the image. The pairing is greedy, nearest pairs first, over each
//      odd node's K_PAIR nearest candidates (the Chinese postman problem wants a
//      minimum-weight perfect matching; greedy is within a small factor on
//      drawings and far cheaper).
//   3. HIERHOLZER'S algorithm walks every chain once from the start. At each
//      node it takes the chain that continues STRAIGHTEST from the way it came
//      in, so the line flows through junctions instead of zig-zagging (any
//      choice gives a valid walk; this one reads as drawn).
//
// (A travelling-salesman order of the chains, jumping between them, was an
// option until 2026-11-21: measured on the samples it drew nearly the same line,
// with up to 18% more of it outside the image on the photographs.)
//
// THE ROUTE is the line as runs, end to end: [{pts, kind}], pts a flat [x, y,
// ...] in mm, each run starting where the last ended. kind is 'edge' (an edge
// of the image, drawn for the first time), 'retrace' (drawn again) or 'join' (a
// line the image does not have: bridges and new joins).

import { components, degrees, polyLength, reverse } from './graph.js';

export const BRIDGE_STEP = 2;     // mm between the points a bridge may leave from
export const K_PAIR = 8;          // candidate partners per odd node
export const ODD_BONUS = 5;       // mm: a bridge may be this much longer per end to land on an odd node

/**
 * @param {{nodes, edges}} graph
 * @param {{retrace?:boolean, start:{x,y}|null, closed:boolean, walk?:'step'|'pairs'}} o
 *   retrace: odd nodes always joined along the lines; otherwise by the shorter way
 * @returns {{runs, start, end, stats}}
 */
export function routeGraph(graph, o) {
  if (!graph.edges.length) return { runs: [], start: null, end: null, stats: { components: 0, bridges: 0, odd: 0, pairs: 0 } };
  return routeEuler(graph, o);
}

// ------------------------------------------------------------------ spatial grid
function gridOf(items, cell) {
  const map = new Map();
  const key = (gx, gy) => gx * 1000003 + gy;
  let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
  items.forEach((p, i) => {
    const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell);
    gx0 = Math.min(gx0, gx); gx1 = Math.max(gx1, gx); gy0 = Math.min(gy0, gy); gy1 = Math.max(gy1, gy);
    const k = key(gx, gy);
    let a = map.get(k);
    if (!a) map.set(k, (a = []));
    a.push(i);
  });
  /** Nearest item to (x, y) that `ok` accepts, by distance plus `extra(i)` (>= 0), or -1. Rings of cells outward, each ring's perimeter only. */
  const nearest = (x, y, ok, extra = null) => {
    if (!items.length) return -1;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    const last = Math.max(Math.abs(gx - gx0), Math.abs(gx1 - gx), Math.abs(gy - gy0), Math.abs(gy1 - gy));
    let best = -1, bd = Infinity;
    const visit = (cx, cy) => {
      const a = map.get(key(cx, cy));
      if (!a) return;
      for (const i of a) {
        const d = Math.hypot(items[i].x - x, items[i].y - y) + (extra ? extra(i) : 0);
        if ((d < bd || (d === bd && i < best)) && ok(i)) { bd = d; best = i; }
      }
    };
    for (let r = 0; r <= last; r++) {
      if (best >= 0 && (r - 1) * cell > bd) break;
      if (r === 0) { visit(gx, gy); continue; }
      for (let d = -r; d <= r; d++) { visit(gx + d, gy - r); visit(gx + d, gy + r); }
      for (let d = -r + 1; d <= r - 1; d++) { visit(gx - r, gy + d); visit(gx + r, gy + d); }
    }
    return best;
  };
  /** Up to k nearest accepted items within maxR, nearest first. */
  const kNearest = (x, y, k, ok, maxR) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    const R = Math.ceil(maxR / cell);
    const found = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        const a = map.get(key(gx + dx, gy + dy));
        if (!a) continue;
        for (const i of a) {
          if (!ok(i)) continue;
          const d = Math.hypot(items[i].x - x, items[i].y - y);
          if (d <= maxR) found.push([d, i]);
        }
      }
    }
    found.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    return found.slice(0, k);
  };
  return { nearest, kNearest };
}

// ------------------------------------------------------------------ euler
function routeEuler(graph, o) {
  const nodes = graph.nodes.map((p) => ({ x: p.x, y: p.y }));
  let edges = graph.edges.map((e) => ({ a: e.a, b: e.b, pts: e.pts.slice(), kind: 'edge' }));
  const stats = { components: components(nodes.length, edges).count, bridges: 0, odd: 0, pairs: 0 };

  // 1. bridges
  if (stats.components > 1) {
    const br = bridge(nodes, edges);
    edges = br.edges;
    stats.bridges = br.count;
  }

  // 2. the ends, and pairing the other odd nodes
  const deg = degrees(nodes.length, edges);
  const odd = [];
  for (let v = 0; v < nodes.length; v++) if (deg[v] % 2) odd.push(v);
  stats.odd = odd.length;
  const target = o.start || { x: 0, y: 0 };
  const nearestOf = (list) => {
    let best = list[0], bd = Infinity;
    for (const v of list) { const d = Math.hypot(nodes[v].x - target.x, nodes[v].y - target.y); if (d < bd) { bd = d; best = v; } }
    return best;
  };
  let start;
  let pairUp = odd;
  if (o.closed || !odd.length) {
    start = nearestOf([...new Set(edges.flatMap((e) => [e.a, e.b]))]);
  } else {
    start = nearestOf(odd);
    pairUp = odd.filter((v) => v !== start);
  }
  const adj = adjacency(nodes.length, edges);
  const pairs = pairOdd(nodes, edges, adj, pairUp, o.closed || !odd.length ? 0 : 1, o.retrace ? 'retrace' : 'shorter');
  stats.pairs = pairs.length;
  for (const p of pairs) {
    if (p.how === 'new') edges.push({ a: p.u, b: p.v, pts: [nodes[p.u].x, nodes[p.u].y, nodes[p.v].x, nodes[p.v].y], kind: 'join' });
    else for (const { e } of p.path) {
      const src = edges[e];
      edges.push({ a: src.a, b: src.b, pts: src.pts, kind: src.kind === 'join' ? 'join' : 'retrace' });
    }
  }

  // 3. the walk
  const walk = o.walk === 'pairs' ? pairedWalk(nodes.length, edges, start) : hierholzer(nodes.length, edges, start);
  const runs = walk.map(({ e, rev }) => ({ pts: rev ? reverse(edges[e].pts) : edges[e].pts, kind: edges[e].kind }));
  const first = runs[0].pts, last = runs[runs.length - 1].pts;
  return {
    runs,
    start: { x: first[0], y: first[1] },
    end: { x: last[last.length - 2], y: last[last.length - 1] },
    stats,
  };
}

/** Per node, the edges at it as [edge, other end, leaves from the b end?]; a loop appears twice. */
function adjacency(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => {
    adj[e.a].push({ e: i, to: e.b, rev: false });
    adj[e.b].push({ e: i, to: e.a, rev: true });
  });
  return adj;
}

/**
 * Join the separate pieces with straight bridges (Borůvka over the pieces).
 * Mutates `nodes` (new nodes where a chain is split); returns the new edge list.
 */
function bridge(nodes, edges) {
  // candidate points: every node, and points along every chain
  const cand = [];
  nodes.forEach((p, v) => cand.push({ x: p.x, y: p.y, v, e: -1, seg: 0, t: 0 }));
  edges.forEach((e, ei) => {
    const p = e.pts, m = p.length / 2;
    for (let s = 0; s < m - 1; s++) {
      const L = Math.hypot(p[2 * s + 2] - p[2 * s], p[2 * s + 3] - p[2 * s + 1]);
      const k = Math.max(1, Math.ceil(L / BRIDGE_STEP));
      for (let j = s === 0 ? 1 : 0; j < k; j++) {
        const t = j / k;
        cand.push({ x: p[2 * s] + t * (p[2 * s + 2] - p[2 * s]), y: p[2 * s + 1] + t * (p[2 * s + 3] - p[2 * s + 1]), v: -1, e: ei, seg: s, t });
      }
    }
  });
  const comp = components(nodes.length, edges);
  // landing on an odd node evens it (and the bridge chains strokes end to end);
  // anywhere else makes a new odd node, which costs a retrace or a join later
  const deg = degrees(nodes.length, edges);
  const pen = cand.map((c) => (c.v >= 0 && deg[c.v] % 2 ? 0 : ODD_BONUS));
  const compOf = cand.map((c) => comp.of[c.v >= 0 ? c.v : edges[c.e].a]);
  // nodes no edge uses (none after cleanGraph, but be safe): never bridge to them
  const live = new Uint8Array(nodes.length);
  for (const e of edges) { live[e.a] = 1; live[e.b] = 1; }
  const parent = Array.from({ length: comp.count }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  let groups = new Set(edges.map((e) => comp.of[e.a])).size;
  const cell = 4 * BRIDGE_STEP;
  const grid = gridOf(cand, cell);
  const bridges = [];
  while (groups > 1) {
    const best = new Map();   // root -> [d, i, j]
    for (let i = 0; i < cand.length; i++) {
      if (cand[i].v >= 0 && !live[cand[i].v]) continue;
      const r = find(compOf[i]);
      const j = grid.nearest(cand[i].x, cand[i].y, (q) => find(compOf[q]) !== r && !(cand[q].v >= 0 && !live[cand[q].v]), (q) => pen[q]);
      if (j < 0) continue;
      const d = Math.hypot(cand[i].x - cand[j].x, cand[i].y - cand[j].y) + pen[i] + pen[j];
      const b = best.get(r);
      if (!b || d < b[0] || (d === b[0] && i < b[1])) best.set(r, [d, i, j]);
    }
    let joined = 0;
    for (const [, [, i, j]] of [...best.entries()].sort((p, q) => p[1][0] - q[1][0])) {
      const ra = find(compOf[i]), rb = find(compOf[j]);
      if (ra === rb) continue;
      parent[rb] = ra;
      bridges.push([i, j]);
      for (const q of [i, j]) if (cand[q].v >= 0) { deg[cand[q].v]++; pen[q] = deg[cand[q].v] % 2 ? 0 : ODD_BONUS; }
      groups--; joined++;
    }
    if (!joined) break;
  }
  // split chains where bridges leave them
  const splitAt = new Map();   // edge -> [{seg, t, key}]
  const nodeFor = new Map();   // candidate key -> node id
  const keyOf = (c) => (c.v >= 0 ? `v${c.v}` : `e${c.e}:${c.seg}:${c.t}`);
  for (const ij of bridges) {
    for (const i of ij) {
      const c = cand[i], k = keyOf(c);
      if (nodeFor.has(k)) continue;
      if (c.v >= 0) { nodeFor.set(k, c.v); continue; }
      const id = nodes.length;
      nodes.push({ x: c.x, y: c.y });
      nodeFor.set(k, id);
      if (!splitAt.has(c.e)) splitAt.set(c.e, []);
      splitAt.get(c.e).push({ seg: c.seg, t: c.t, x: c.x, y: c.y, id });
    }
  }
  const out = [];
  edges.forEach((e, ei) => {
    const cuts = splitAt.get(ei);
    if (!cuts) { out.push(e); return; }
    cuts.sort((p, q) => p.seg - q.seg || p.t - q.t);
    const p = e.pts;
    let from = e.a, cur = [p[0], p[1]], s = 0;
    for (const c of cuts) {
      for (; s < c.seg; s++) cur.push(p[2 * s + 2], p[2 * s + 3]);
      if (c.t > 0) cur.push(c.x, c.y); else { cur[cur.length - 2] = c.x; cur[cur.length - 1] = c.y; }
      out.push({ a: from, b: c.id, pts: cur, kind: e.kind });
      from = c.id;
      cur = [c.x, c.y];
    }
    for (; s < p.length / 2 - 1; s++) cur.push(p[2 * s + 2], p[2 * s + 3]);
    out.push({ a: from, b: e.b, pts: cur, kind: e.kind });
  });
  for (const [i, j] of bridges) {
    const a = nodeFor.get(keyOf(cand[i])), b = nodeFor.get(keyOf(cand[j]));
    out.push({ a, b, pts: [nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y], kind: 'join' });
  }
  return { edges: out.filter((e) => polyLength(e.pts) > 0 || e.kind === 'join'), count: bridges.length };
}

/**
 * Pair the odd nodes, leaving `leave` of them unpaired (the line's far end).
 * @param {'shorter'|'retrace'} mode  each pair by the shorter of a straight and a retrace, or always retraced
 * @returns {[{u, v, how:'retrace'|'new', path:[{e, rev}]}]}
 */
function pairOdd(nodes, edges, adj, odd, leave, mode) {
  if (odd.length <= leave) return [];
  const shorter = mode !== 'retrace';
  const isOdd = new Uint8Array(nodes.length);
  for (const v of odd) isOdd[v] = 1;
  const elen = edges.map((e) => polyLength(e.pts));
  const cands = [];
  const straight = (u, v) => Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y);
  for (const u of odd) {
    for (const [v, d] of dijkstraTo(adj, elen, u, (x) => isOdd[x] && x !== u, K_PAIR)) {
      if (u > v) continue;
      cands.push({ u, v, d, how: 'retrace' });
      // 'shorter': the same pair by a straight too. The straights below are only
      // looked for nearby, so without this a far pair could only retrace, however
      // much longer that was. A straight is never longer than a way along lines;
      // where they are the same (a way along a straight edge) the retrace stays,
      // as it keeps to the image
      if (shorter) { const s = straight(u, v); if (s < d - 1e-6) cands.push({ u, v, d: s, how: 'new' }); }
    }
  }
  if (shorter) {
    const pts = odd.map((v) => nodes[v]);
    const g = gridOf(pts, 10);
    odd.forEach((u, iu) => {
      for (const [d, iv] of g.kNearest(nodes[u].x, nodes[u].y, K_PAIR + 1, (i) => i !== iu, 60)) {
        const v = odd[iv];
        if (u < v) cands.push({ u, v, d, how: 'new' });
      }
    });
  }
  cands.sort((p, q) => p.d - q.d || p.u - q.u || p.v - q.v || (p.how < q.how ? -1 : 1));
  // a pair's retrace, by its ends: a straight no shorter than it gives way to it
  const retraceOf = new Map();
  for (const c of cands) if (c.how === 'retrace') retraceOf.set(`${c.u},${c.v}`, c);
  const matched = new Uint8Array(nodes.length);
  const pairs = [];
  let left = odd.length;
  for (let c of cands) {
    if (left <= leave) break;
    if (matched[c.u] || matched[c.v]) continue;
    const r = c.how === 'new' && retraceOf.get(`${c.u},${c.v}`);
    if (r && r.d <= c.d + 1e-6) c = r;
    matched[c.u] = 1; matched[c.v] = 1; left -= 2;
    pairs.push(c);
  }
  // any left over (no candidate in reach): nearest remaining, until only `leave` are
  let rest = odd.filter((v) => !matched[v]);
  while (rest.length > leave) {
    const u = rest.pop();
    const want = new Set(rest);
    let v = -1, d = Infinity, how = 'new';
    const r = dijkstraTo(adj, elen, u, (x) => want.has(x), 1);
    if (r.length) { [v, d] = r[0]; how = 'retrace'; }
    if (shorter || v < 0) {
      // a straight only where it is shorter than the retrace (the same length: the retrace, on the image)
      for (const x of rest) {
        const dd = straight(u, x);
        if (dd < (how === 'retrace' ? d - 1e-6 : d)) { d = dd; v = x; how = 'new'; }
      }
    }
    rest = rest.filter((x) => x !== v);
    pairs.push({ u, v, d, how });
  }
  if (shorter) improveJoins(nodes, pairs, rest);
  for (const p of pairs) if (p.how === 'retrace') p.path = shortestPath(adj, elen, p.u, p.v);
  return pairs;
}

/**
 * Greedy pairing strands a few odd nodes, which then pair across the drawing.
 * Local repair, on the straight joins only: for two pairs (a, b) and (c, d)
 * whose ends are near, swap partners, (a, c)(b, d) or (a, d)(b, c), when the
 * two joins get shorter. The free end f (the line's far end, unpaired) takes
 * part as the pair (f, φ) with a PHANTOM φ at no distance from anything, so the
 * same swap can make a node free in its place. Repeated until nothing improves,
 * a fixed number of passes at most (so the result does not depend on speed).
 * In place.
 */
function improveJoins(nodes, pairs, free) {
  const PH = -1;
  const D = (u, v) => (u === PH || v === PH ? 0 : Math.hypot(nodes[u].x - nodes[v].x, nodes[u].y - nodes[v].y));
  const work = pairs.map((p, i) => ({ ...p, i })).filter((p) => p.how === 'new');
  if (free.length === 1) work.push({ u: free[0], v: PH, how: 'new', i: -1 });
  if (work.length < 2) return;
  const ends = [];
  work.forEach((p, w) => { for (const v of [p.u, p.v]) if (v !== PH) ends.push({ v, w }); });
  const grid = gridOf(ends.map((e) => nodes[e.v]), 10);
  const at = new Map(ends.map((e) => [e.v, e.w]));   // node -> its pair in `work`
  const other = (p, v) => (p.u === v ? p.v : p.u);
  for (let pass = 0; pass < 20; pass++) {
    let better = false;
    for (const { v: a } of ends) {
      const i = at.get(a), b = other(work[i], a);
      const reach = Math.max(20, 2 * D(a, b));
      for (const [, k] of grid.kNearest(nodes[a].x, nodes[a].y, 6, (q) => at.get(ends[q].v) !== i, reach)) {
        const c = ends[k].v, j = at.get(c), d = other(work[j], c);
        const now = D(a, b) + D(c, d);
        let x, y;   // a's new partner, and b's (either may be the phantom)
        if (D(a, c) + D(b, d) < now - 1e-9) { x = c; y = d; } else if (D(a, d) + D(b, c) < now - 1e-9) { x = d; y = c; } else continue;
        work[i] = { ...work[i], u: a, v: x };
        work[j] = { ...work[j], u: b, v: y };
        for (const v of [a, x]) if (v !== PH) at.set(v, i);
        for (const v of [b, y]) if (v !== PH) at.set(v, j);
        better = true;
        break;
      }
    }
    if (!better) break;
  }
  // back into `pairs`: the pair holding the phantom is no join (its node is the free end)
  const real = work.filter((p) => p.u !== PH && p.v !== PH).map((p) => ({ u: p.u, v: p.v, d: D(p.u, p.v), how: 'new' }));
  const keep = pairs.filter((p) => p.how !== 'new');
  pairs.length = 0;
  pairs.push(...keep, ...real);
}


/** A small binary heap of [key, value]. */
function heap() {
  const a = [];
  const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < a.length && a[l][0] < a[m][0]) m = l;
      if (r < a.length && a[r][0] < a[m][0]) m = r;
      if (m === i) return;
      [a[m], a[i]] = [a[i], a[m]]; i = m;
    }
  };
  return {
    push(k, v) { a.push([k, v]); up(a.length - 1); },
    pop() { const t = a[0], l = a.pop(); if (a.length) { a[0] = l; down(0); } return t; },
    get size() { return a.length; },
  };
}

/** Dijkstra from u until k nodes that `want` accepts are settled: [[node, distance]]. */
function dijkstraTo(adj, elen, u, want, k) {
  const dist = new Map([[u, 0]]);
  const done = new Set();
  const h = heap();
  h.push(0, u);
  const out = [];
  while (h.size && out.length < k) {
    const [d, x] = h.pop();
    if (done.has(x)) continue;
    done.add(x);
    if (want(x)) out.push([x, d]);
    for (const { e, to } of adj[x]) {
      const nd = d + elen[e];
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); h.push(nd, to); }
    }
  }
  return out;
}

/** The shortest walk from u to v along the edges: [{e, rev}]. */
function shortestPath(adj, elen, u, v) {
  const dist = new Map([[u, 0]]), prev = new Map();
  const h = heap();
  h.push(0, u);
  while (h.size) {
    const [d, x] = h.pop();
    if (d > (dist.get(x) ?? Infinity)) continue;
    if (x === v) break;
    for (const { e, to, rev } of adj[x]) {
      const nd = d + elen[e];
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, { e, rev, from: x }); h.push(nd, to); }
    }
  }
  const path = [];
  for (let x = v; x !== u;) { const p = prev.get(x); if (!p) break; path.push({ e: p.e, rev: p.rev }); x = p.from; }
  return path.reverse();
}

/** Unit direction leaving a polyline's start (or arriving at its end, `atEnd`). */
function dirOf(p, atEnd) {
  const m = p.length / 2;
  if (atEnd) {
    for (let i = m - 2; i >= 0; i--) {
      const dx = p[2 * m - 2] - p[2 * i], dy = p[2 * m - 1] - p[2 * i + 1], L = Math.hypot(dx, dy);
      if (L > 1e-9) return [dx / L, dy / L];
    }
  } else {
    for (let i = 1; i < m; i++) {
      const dx = p[2 * i] - p[0], dy = p[2 * i + 1] - p[1], L = Math.hypot(dx, dy);
      if (L > 1e-9) return [dx / L, dy / L];
    }
  }
  return [0, 0];
}

/**
 * Hierholzer's walk over every edge once, from `start`, taking the straightest
 * way on at each node. The graph must be connected with at most two odd nodes,
 * `start` one of them if there are two. Returns [{e, rev}] in drawing order.
 */
export function hierholzer(n, edges, start) {
  const adj = adjacency(n, edges);
  const used = new Uint8Array(edges.length);
  // the direction each traversal leaves and arrives in (backwards: the other end's, turned round)
  const d0 = edges.map((e) => dirOf(e.pts, false)), d1 = edges.map((e) => dirOf(e.pts, true));
  const leave = (e, rev) => (rev ? [-d1[e][0], -d1[e][1]] : d0[e]);
  const arrive = (e, rev) => (rev ? [-d0[e][0], -d0[e][1]] : d1[e]);
  const stack = [{ v: start, e: -1, rev: false, dir: null }];
  const out = [];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const list = adj[top.v] = adj[top.v].filter((a) => !used[a.e]);
    let best = -1, bs = -Infinity;
    for (let k = 0; k < list.length; k++) {
      const a = list[k];
      // a loop seen from its b end is the same traversal backwards: either works
      let s = 0;
      if (top.dir) { const d = leave(a.e, a.rev); s = d[0] * top.dir[0] + d[1] * top.dir[1]; }
      // edges first, then retraces and joins (so a retrace follows the edge it repeats)
      s += edges[a.e].kind === 'edge' ? 0 : -0.001;
      if (s > bs || (s === bs && a.e < list[best].e)) { bs = s; best = k; }
    }
    if (best < 0) { out.push(stack.pop()); continue; }
    const a = list[best];
    used[a.e] = 1;
    list.splice(best, 1);
    stack.push({ v: a.to, e: a.e, rev: a.rev, dir: arrive(a.e, a.rev) });
  }
  out.reverse();
  return out.slice(1).map(({ e, rev }) => ({ e, rev }));
}


/**
 * The walk as STRAIGHTEST PAIRINGS (an alternative to Hierholzer's step-by-step
 * choice, which takes the straightest way on from where it is, and can leave
 * itself only sharp turns later). Each chain end at a node is a SLOT. At every
 * node the slots are paired, straightest pairs first (the turn from arriving by
 * one to leaving by the other), so every pass through a node is as straight as
 * the node allows; at the two odd nodes one slot is left over, the line's start
 * and end. Following the pairs splits the graph into an open trail and some
 * closed circuits. They are SPLICED at nodes they share: two pairs (a, b) and
 * (c, d) from different trails become (a, c)(b, d) or (a, d)(b, c), whichever
 * adds less turning (either makes the two one trail). The graph is connected, so
 * one pass over the nodes leaves one trail, walked from the start. (A spare
 * slot, the start or end, splices too, so an open trail of one chain can.)
 * @returns [{e, rev}] in drawing order
 */
export function pairedWalk(n, edges, start) {
  const d0 = edges.map((e) => dirOf(e.pts, false)), d1 = edges.map((e) => dirOf(e.pts, true));
  // slot 2e: the chain's a end, 2e+1 its b end; out: the way the chain leaves the node there
  const nodeOf = (s) => ((s & 1) ? edges[s >> 1].b : edges[s >> 1].a);
  const out = (s) => ((s & 1) ? [-d1[s >> 1][0], -d1[s >> 1][1]] : d0[s >> 1]);
  const turn = (s, t) => { const a = out(s), b = out(t); return Math.acos(Math.max(-1, Math.min(1, -(a[0] * b[0] + a[1] * b[1])))); };
  const at = Array.from({ length: n }, () => []);
  for (let s = 0; s < 2 * edges.length; s++) at[nodeOf(s)].push(s);
  const mate = new Int32Array(2 * edges.length).fill(-1);
  for (let v = 0; v < n; v++) {
    const S = at[v];
    const cand = [];
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) cand.push([turn(S[i], S[j]), S[i], S[j]]);
    cand.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    for (const [, s, t] of cand) if (mate[s] < 0 && mate[t] < 0) { mate[s] = t; mate[t] = s; }
  }
  const parent = Int32Array.from({ length: 2 * edges.length }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let e = 0; e < edges.length; e++) unite(2 * e, 2 * e + 1);
  for (let s = 0; s < mate.length; s++) if (mate[s] >= 0) unite(s, mate[s]);
  for (let v = 0; v < n; v++) {
    for (;;) {
      const pairs = at[v].filter((s) => mate[s] > s).map((s) => [s, mate[s]]);
      let best = null;
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          const [a, b] = pairs[i], [c, d] = pairs[j];
          if (find(a) === find(c)) continue;
          const was = turn(a, b) + turn(c, d);
          const x = turn(a, c) + turn(b, d) - was, y = turn(a, d) + turn(b, c) - was;
          const cost = Math.min(x, y);
          if (!best || cost < best.cost) best = { cost, a, b, c: x <= y ? c : d, d: x <= y ? d : c };
        }
      }
      // a spare slot (the line's start or end) splices too: it takes one slot of
      // another trail's pair as its mate, and the other becomes the spare
      // (without this an open trail with no pairs, a single chain, could not take
      // any circuit in)
      for (const x of at[v].filter((s) => mate[s] < 0)) {
        for (const [c, d] of pairs) {
          if (find(x) === find(c)) continue;
          const was = turn(c, d);
          const xc = turn(x, c) - was, xd = turn(x, d) - was;
          const cost = Math.min(xc, xd);
          if (!best || cost < best.cost) best = { cost, spare: x, c: xc <= xd ? c : d, d: xc <= xd ? d : c };
        }
      }
      if (!best) break;
      if (best.spare !== undefined) {
        const { spare, c, d } = best;
        mate[spare] = c; mate[c] = spare; mate[d] = -1;
        unite(spare, c);
        continue;
      }
      const { a, b, c, d } = best;
      mate[a] = c; mate[c] = a; mate[b] = d; mate[d] = b;
      unite(a, c);
    }
  }
  // walk: from the start's spare slot, or (all paired: a closed line) by opening one pair there
  let s0 = at[start].find((s) => mate[s] < 0);
  let stop = -1;
  if (s0 === undefined) { s0 = at[start][0]; stop = mate[s0]; }
  const walk = [];
  for (let s = s0, guard = 0; guard <= edges.length; guard++) {
    walk.push({ e: s >> 1, rev: (s & 1) === 1 });
    const o = s ^ 1;
    if (o === stop || mate[o] < 0) break;
    s = mate[o];
  }
  return walk;
}
