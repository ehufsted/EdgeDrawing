// The edge graph: the one-pixel edge map (core/edges.js) as junctions and the
// chains between them, in mm, cleaned up to the level of detail.
//
// TRACING. A line pixel with exactly two line neighbours (8-connected) is part
// of a chain; any other is a NODE pixel (an end: one neighbour; a junction:
// three or more). Touching node pixels are one node, at their centroid. Every
// chain is walked from a node until it reaches a node, so each chain is traced
// once; a closed curve with no node at all gets one where its walk starts.
//
// CLEAN-UP, all lengths in mm on the canvas, in this order:
//   merge      chains shorter than the smallest feature between two junctions
//              collapse, their nodes merging (only while the merged nodes stay
//              within a feature of each other, so a long run of short chains
//              cannot drag a node across the drawing)
//   gaps       Canny breaks lines where they meet (each side's suppression eats
//              the junction), so a loose end within the smallest feature of
//              another line, roughly ahead of it, is joined to it: edge linking.
//              Without it nearly every chain is a piece of its own, and the
//              line is mostly bridges
//   spurs      a dead-end chain off a junction shorter than the shortest line
//              is a branch the edge detector made, not a line: it goes
//   join       a node that is left with two chains joins them into one
//   pieces     a connected piece shorter in total than the shortest line goes
//   smooth     each chain is smoothed along its length (a Gaussian, about 0.4 of
//              the smallest feature), its two ends held where they are, so the
//              pixel staircase becomes a curve without the chains coming apart
//   simplify   Douglas-Peucker: each chain keeps only the points it needs to
//              stay within `simplify` mm of itself
//
// THE GRAPH: { nodes: [{x, y}], edges: [{a, b, pts}] }, pts a flat [x, y, ...]
// array from node a to node b (a === b for a closed loop).

/**
 * @param {Uint8Array} edge  1 on a line, one pixel wide
 * @param {number} sx, sy    mm per pixel
 */
export function traceGraph(edge, w, h, sx, sy) {
  const n = w * h;
  const NB = [-w, 1, w, -1, -w + 1, w + 1, w - 1, -w - 1];   // 4-neighbours first
  const count = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!edge[i]) continue;
    let c = 0;
    for (const o of NB) if (edge[i + o]) c++;
    count[i] = c;
  }
  const isNode = (i) => edge[i] && count[i] !== 2;
  const nodeOf = new Int32Array(n).fill(-1);
  const nodes = [];
  const cx = (i) => ((i % w) + 0.5) * sx, cy = (i) => (Math.floor(i / w) + 0.5) * sy;
  // node pixels, clustered
  for (let i = 0; i < n; i++) {
    if (!isNode(i) || nodeOf[i] >= 0) continue;
    const id = nodes.length;
    let X = 0, Y = 0, k = 0;
    const stack = [i];
    nodeOf[i] = id;
    while (stack.length) {
      const j = stack.pop();
      X += cx(j); Y += cy(j); k++;
      for (const o of NB) { const t = j + o; if (isNode(t) && nodeOf[t] < 0) { nodeOf[t] = id; stack.push(t); } }
    }
    nodes.push({ x: X / k, y: Y / k });
  }
  const visited = new Uint8Array(n);
  const edges = [];
  const walk = (a, from, first) => {
    const pts = [nodes[a].x, nodes[a].y, cx(first), cy(first)];
    visited[first] = 1;
    let prev = from, cur = first;
    for (;;) {
      let next = -1, end = -1;
      for (const o of NB) {
        const t = cur + o;
        if (t === prev || !edge[t]) continue;
        if (nodeOf[t] >= 0) { if (end < 0) end = t; } else if (!visited[t] && next < 0) next = t;
      }
      if (next >= 0) {
        visited[next] = 1;
        pts.push(cx(next), cy(next));
        prev = cur; cur = next;
        continue;
      }
      if (end >= 0) {
        const b = nodeOf[end];
        pts.push(nodes[b].x, nodes[b].y);
        edges.push({ a, b, pts });
        return;
      }
      // a dead end that was not a node pixel (cannot happen on a clean map): end it here
      const b = nodes.length;
      nodes.push({ x: cx(cur), y: cy(cur) });
      nodeOf[cur] = b;
      edges.push({ a, b, pts });
      return;
    }
  };
  for (let i = 0; i < n; i++) {
    if (nodeOf[i] < 0 || !edge[i]) continue;
    for (const o of NB) {
      const t = i + o;
      if (edge[t] && nodeOf[t] < 0 && !visited[t]) walk(nodeOf[i], i, t);
    }
  }
  // closed curves with no node: one where the walk starts
  for (let i = 0; i < n; i++) {
    if (!edge[i] || nodeOf[i] >= 0 || visited[i]) continue;
    const id = nodes.length;
    nodes.push({ x: cx(i), y: cy(i) });
    nodeOf[i] = id;
    visited[i] = 1;
    let first = -1;
    for (const o of NB) if (edge[i + o] && !visited[i + o]) { first = i + o; break; }
    if (first >= 0) walk(id, i, first);
  }
  return { nodes, edges };
}

/** Length of a flat [x, y, ...] polyline. */
export function polyLength(p) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

/**
 * The graph cleaned to the level of detail (see the header).
 * @param {{nodes, edges}} g     traceGraph's
 * @param {{minFeature:number, minLength:number, simplify:number, smooth?:number}} d  mm;
 *   smooth: the smoothing scale, when it should be more than the smallest feature
 * @returns {{nodes, edges, stats}}
 */
export function cleanGraph(g, d) {
  const nodes = g.nodes.map((p) => ({ x: p.x, y: p.y }));
  let edges = g.edges.map((e) => ({ a: e.a, b: e.b, pts: e.pts }));
  const stats = { traced: g.edges.length, merged: 0, gaps: 0, spurs: 0, pieces: 0 };

  // merge: short chains between different nodes collapse
  const parent = nodes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const weight = nodes.map(() => 1);
  const order = edges.map((e, i) => [polyLength(e.pts), i]).sort((p, q) => p[0] - q[0]);
  const dead = new Uint8Array(edges.length);
  const deg0 = degrees(nodes.length, edges);
  for (const [len, i] of order) {
    if (len >= d.minFeature) break;
    // a dead end is a spur's or a short line's, left to those rules: merging it would drag its junction
    if (deg0[edges[i].a] === 1 || deg0[edges[i].b] === 1) continue;
    const ra = find(edges[i].a), rb = find(edges[i].b);
    if (ra === rb) continue;
    const A = nodes[ra], B = nodes[rb];
    if (Math.hypot(A.x - B.x, A.y - B.y) >= d.minFeature) continue;
    const wa = weight[ra], wb = weight[rb];
    A.x = (A.x * wa + B.x * wb) / (wa + wb); A.y = (A.y * wa + B.y * wb) / (wa + wb);
    weight[ra] = wa + wb;
    parent[rb] = ra;
    dead[i] = 1;
    stats.merged++;
  }
  edges = edges.filter((_, i) => !dead[i]).map((e) => {
    const a = find(e.a), b = find(e.b);
    const pts = e.pts.slice();
    pts[0] = nodes[a].x; pts[1] = nodes[a].y;
    pts[pts.length - 2] = nodes[b].x; pts[pts.length - 1] = nodes[b].y;
    return { a, b, pts };
  });
  // tiny loops left by the merge
  edges = edges.filter((e) => e.a !== e.b || polyLength(e.pts) >= Math.PI * d.minFeature);

  const gaps = closeGaps(nodes, edges, d.minFeature);
  edges = gaps.edges;
  stats.gaps = gaps.count;

  // spurs, twice: removing one can leave another
  for (let round = 0; round < 2; round++) {
    const deg = degrees(nodes.length, edges);
    const before = edges.length;
    edges = edges.filter((e) => {
      if (e.a === e.b) return true;
      const da = deg[e.a], db = deg[e.b];
      const spur = (da === 1 && db >= 3) || (db === 1 && da >= 3);
      return !(spur && polyLength(e.pts) < d.minLength);
    });
    stats.spurs += before - edges.length;
  }

  edges = joinThrough(nodes, edges);

  // pieces too short to keep
  const comp = components(nodes.length, edges);
  const total = new Float64Array(comp.count);
  for (const e of edges) total[comp.of[e.a]] += polyLength(e.pts);
  const keepComp = Array.from(total, (t) => t >= d.minLength);
  stats.pieces = keepComp.filter((k, i) => !k && total[i] > 0).length;
  edges = edges.filter((e) => keepComp[comp.of[e.a]]);

  // smoothed only now, so a chain joined through an old junction is smoothed across it
  edges = edges.map((e) => ({ a: e.a, b: e.b, pts: rdp(smoothLine(e.pts, 0.4 * Math.max(d.minFeature, d.smooth || 0)), d.simplify) }));
  return { ...compact(nodes, edges), stats };
}

export function degrees(nNodes, edges) {
  const deg = new Int32Array(nNodes);
  for (const e of edges) { deg[e.a]++; deg[e.b]++; }
  return deg;
}

/** Connected components over the edges: {of: node -> component, count}. */
export function components(nNodes, edges) {
  const parent = Array.from({ length: nNodes }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const e of edges) { const a = find(e.a), b = find(e.b); if (a !== b) parent[b] = a; }
  const of = new Int32Array(nNodes), ids = new Map();
  for (let i = 0; i < nNodes; i++) {
    const r = find(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    of[i] = ids.get(r);
  }
  return { of, count: ids.size };
}

/**
 * Edge linking: each loose end (a node of one chain) joins the nearest point of
 * another chain within `gap` mm that lies ahead of it (no more than 60° off the
 * way the chain was going), by a straight. Ends are linked nearest first; a
 * chain is split where a link lands on it. `nodes` gains the split points.
 * @returns {{edges, count}}
 */
export function closeGaps(nodes, edges, gap) {
  if (!(gap > 0) || !edges.length) return { edges, count: 0 };
  const deg = degrees(nodes.length, edges);
  // every point of every chain, binned
  const cell = gap;
  const bins = new Map();
  const key = (gx, gy) => gx * 1000003 + gy;
  edges.forEach((e, ei) => {
    for (let k = 0; k < e.pts.length; k += 2) {
      const kk = key(Math.floor(e.pts[k] / cell), Math.floor(e.pts[k + 1] / cell));
      let a = bins.get(kk);
      if (!a) bins.set(kk, (a = []));
      a.push(ei, k / 2);
    }
  });
  const links = [];
  edges.forEach((e, ei) => {
    for (const atEnd of [false, true]) {
      const v = atEnd ? e.b : e.a;
      if (deg[v] !== 1 || e.a === e.b) continue;
      const p = e.pts, m = p.length / 2;
      // the way the chain runs out of this end, over about a feature
      const i0 = atEnd ? m - 1 : 0;
      let j = i0, run = 0;
      while (run < gap && (atEnd ? j > 0 : j < m - 1)) {
        const nj = atEnd ? j - 1 : j + 1;
        run += Math.hypot(p[2 * nj] - p[2 * j], p[2 * nj + 1] - p[2 * j + 1]);
        j = nj;
      }
      const ox = p[2 * i0] - p[2 * j], oy = p[2 * i0 + 1] - p[2 * j + 1], oL = Math.hypot(ox, oy);
      const x = nodes[v].x, y = nodes[v].y;
      let best = null, bd = gap;
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const a = bins.get(key(gx + dx, gy + dy));
        if (!a) continue;
        for (let q = 0; q < a.length; q += 2) {
          const tei = a[q], tk = a[q + 1];
          if (tei === ei) continue;
          const tx = edges[tei].pts[2 * tk], ty = edges[tei].pts[2 * tk + 1];
          const dd = Math.hypot(tx - x, ty - y);
          if (dd >= bd || dd < 1e-9) continue;
          if ((tx - x) * ox + (ty - y) * oy < 0.5 * dd * oL) continue;   // more than 60° off ahead
          bd = dd; best = { e: tei, k: tk, x: tx, y: ty };
        }
      }
      if (best) links.push({ v, d: bd, ...best });
    }
  });
  links.sort((p, q) => p.d - q.d || p.v - q.v);
  // nearest first; an end links once, and two ends do not link to each other twice
  const used = new Set();
  const chosen = [];
  for (const l of links) {
    if (used.has(l.v)) continue;
    const tm = edges[l.e].pts.length / 2;
    const tv = l.k === 0 ? edges[l.e].a : l.k === tm - 1 ? edges[l.e].b : -1;
    if (tv >= 0 && used.has(tv) && chosen.some((c) => c.v === tv && c.tv === l.v)) continue;
    used.add(l.v);
    chosen.push({ ...l, tv });
  }
  // split chains where links land mid-chain
  const cuts = new Map();   // edge -> sorted point indices
  for (const c of chosen) if (c.tv < 0) { if (!cuts.has(c.e)) cuts.set(c.e, new Set()); cuts.get(c.e).add(c.k); }
  const nodeAt = new Map();  // `${edge}:${k}` -> node
  const out = [];
  edges.forEach((e, ei) => {
    const ks = cuts.get(ei);
    if (!ks) { out.push(e); return; }
    const sorted = [...ks].sort((p, q) => p - q);
    let from = e.a, start = 0;
    for (const k of sorted) {
      const id = nodes.length;
      nodes.push({ x: e.pts[2 * k], y: e.pts[2 * k + 1] });
      nodeAt.set(`${ei}:${k}`, id);
      out.push({ a: from, b: id, pts: e.pts.slice(2 * start, 2 * k + 2) });
      from = id; start = k;
    }
    out.push({ a: from, b: e.b, pts: e.pts.slice(2 * start) });
  });
  for (const c of chosen) {
    const to = c.tv >= 0 ? c.tv : nodeAt.get(`${c.e}:${c.k}`);
    out.push({ a: c.v, b: to, pts: [nodes[c.v].x, nodes[c.v].y, nodes[to].x, nodes[to].y] });
  }
  return { edges: out, count: chosen.length };
}

/** A node with exactly two different chains joins them into one (repeatedly). */
function joinThrough(nodes, edges) {
  const list = edges.map((e) => ({ ...e }));
  const dead = [];
  // at[v]: the chains at v, a loop listed twice (it uses v at both ends)
  const at = nodes.map(() => []);
  list.forEach((e, i) => { at[e.a].push(i); at[e.b].push(i); });
  for (let v = 0; v < nodes.length; v++) {
    const inc = at[v];
    if (inc.length !== 2 || inc[0] === inc[1]) continue;
    const [i, j] = inc;
    const e = list[i], f = list[j];
    // orient e to end at v and f to start at v
    const ep = e.b === v ? e.pts : reverse(e.pts), ea = e.b === v ? e.a : e.b;
    const fp = f.a === v ? f.pts : reverse(f.pts), fb = f.a === v ? f.b : f.a;
    const k = list.length;
    list.push({ a: ea, b: fb, pts: ep.concat(fp.slice(2)) });
    dead[i] = true; dead[j] = true;
    at[v] = [];
    // the far ends now see the joined chain (a chain from v back to v leaves a loop on ea === fb)
    for (const u of new Set([ea, fb])) at[u] = at[u].map((x) => (x === i || x === j ? k : x));
  }
  return list.filter((_, i) => !dead[i]);
}

export const reverse = (p) => {
  const o = new Array(p.length);
  for (let i = 0, j = p.length - 2; j >= 0; i += 2, j -= 2) { o[i] = p[j]; o[i + 1] = p[j + 1]; }
  return o;
};

/** Gaussian smoothing along a polyline (by arc length), the two ends fixed. */
export function smoothLine(p, sigma) {
  const m = p.length / 2;
  if (m < 3 || !(sigma > 0)) return p.slice();
  const s = new Float64Array(m);
  for (let i = 1; i < m; i++) s[i] = s[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
  const out = p.slice();
  const R = 3 * sigma;
  let lo = 0, hi = 0;
  for (let i = 1; i < m - 1; i++) {
    while (s[i] - s[lo] > R) lo++;
    while (hi < m - 1 && s[hi + 1] - s[i] <= R) hi++;
    // the window is held symmetric, so the ends do not pull the line toward them
    const half = Math.min(s[i] - s[lo], s[hi] - s[i], s[i], s[m - 1] - s[i]);
    let X = 0, Y = 0, W = 0;
    for (let j = lo; j <= hi; j++) {
      const t = s[j] - s[i];
      if (Math.abs(t) > half + 1e-9) continue;
      const wt = Math.exp(-(t * t) / (2 * sigma * sigma));
      X += wt * p[2 * j]; Y += wt * p[2 * j + 1]; W += wt;
    }
    out[2 * i] = X / W; out[2 * i + 1] = Y / W;
  }
  return out;
}

/** Douglas-Peucker on a flat polyline, the ends kept. */
export function rdp(p, eps) {
  const m = p.length / 2;
  if (m <= 2 || !(eps > 0)) return p.slice();
  const keep = new Uint8Array(m);
  keep[0] = 1; keep[m - 1] = 1;
  const stack = [[0, m - 1]];
  // a closed chain (ends together) is split at its farthest point first
  if (Math.hypot(p[0] - p[2 * m - 2], p[1] - p[2 * m - 1]) < 1e-9) {
    let far = 0, fd = -1;
    for (let i = 1; i < m - 1; i++) { const dd = Math.hypot(p[2 * i] - p[0], p[2 * i + 1] - p[1]); if (dd > fd) { fd = dd; far = i; } }
    keep[far] = 1;
    stack.length = 0;
    stack.push([0, far], [far, m - 1]);
  }
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const ax = p[2 * i0], ay = p[2 * i0 + 1], bx = p[2 * i1], by = p[2 * i1 + 1];
    let best = -1, bd = eps;
    for (let i = i0 + 1; i < i1; i++) {
      const dd = Math.sqrt(segDist2(p[2 * i], p[2 * i + 1], ax, ay, bx, by));
      if (dd > bd) { bd = dd; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
  }
  const out = [];
  for (let i = 0; i < m; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

function segDist2(x, y, ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) { ax = bx; ay = by; } else if (t > 0) { ax += dx * t; ay += dy * t; }
  }
  dx = x - ax; dy = y - ay;
  return dx * dx + dy * dy;
}

/** Only the nodes some edge uses, renumbered. */
function compact(nodes, edges) {
  const map = new Int32Array(nodes.length).fill(-1);
  const out = [];
  const id = (i) => { if (map[i] < 0) { map[i] = out.length; out.push({ x: nodes[i].x, y: nodes[i].y }); } return map[i]; };
  return { nodes: out, edges: edges.map((e) => ({ a: id(e.a), b: id(e.b), pts: e.pts })) };
}
