// The whole chain, DOM-free: pixels + settings -> a single-line drawing.
// worker.js wraps it; the harness calls it directly.
//
//   A  tone -> canvas geometry -> the work raster -> the Style chain
//   B  the edges (core/edges.js) -> the edge graph, cleaned to the level of
//      detail (core/graph.js)
//   C  one line through it: Eulerian or travelling salesman (core/route.js)
//   D  straights and arcs at the smallest bend radius (with the bend options of
//      core/bends.js), and the measurements
//      (core/arcs.js)
//
// STAGES ARE CACHED (when a cache object is passed, as the worker does): each
// remembers the settings it was made from, and only a stage whose settings, or
// an earlier stage's, changed runs again. Moving the start point re-runs C and
// D; the bend radius B to D (the edges are smoothed at two radii, as a line
// cannot bend round a smaller detail). The line's colour is display only.
//
// THE PLAN is what everything downstream reads (preview, SVG, printout):
// geometry in mm, no pixels, so it draws the same at any scale.
//
//   { piece: {W, H}, imageRect, grid: {w, h, sx, sy},
//     graph: {nodes: [{x, y, deg}], edges: [pts]}    the cleaned edges, before joining
//     path: {x0, y0, segs}                             core/arcs.js: the one line
//     start, end: {x, y}, tight: [{x, y, r}], crossings: [{x, y}],
//     stats, notes }

import { DEFAULTS, PRECISION, applyTone, pieceGeometry } from './core/units.js';
import { workRaster } from './core/raster.js';
import { applyStyle, chainOf, defaultStyle } from './core/style.js';
import { luminance } from './core/color.js';
import { cannyEdges } from './core/edges.js';
import { traceGraph, cleanGraph, degrees } from './core/graph.js';
import { routeGraph } from './core/route.js';
import { pathStats, samplePath, crossings } from './core/arcs.js';
import { fitLine } from './core/bends.js';

/**
 * @param {{width,height,data}} rgba
 * @param {object} settings  units.DEFAULTS
 * @param {{onProgress?:(stage:string)=>void, cache?:object, imageKey?:any}} opts
 *   cache: an object the caller keeps between runs (stages are reused from it);
 *   imageKey: identifies the image, so a cache never serves another image's stage
 */
export function runPipeline(rgba, settings, opts = {}) {
  const s = { ...DEFAULTS, ...settings };
  const progress = opts.onProgress || (() => {});
  const cache = opts.cache && opts.imageKey !== undefined ? opts.cache : {};
  validate(s);
  const stage = (name, keyObj, fn) => {
    const key = JSON.stringify(keyObj);
    const c = cache[name];
    if (c && c.key === key) return c.val;
    const val = fn();
    cache[name] = { key, val };
    return val;
  };

  // A: the work raster
  const style = s.style || defaultStyle();
  const keyA = [opts.imageKey ?? null, s.gamma, s.brightness, s.saturation, s.widthMm, s.heightMm, s.precision, chainOf(style)];
  const A = stage('A', keyA, () => {
    progress('reading the image');
    const toned = applyTone(rgba, s.gamma, s.brightness, s.saturation);
    const geo = pieceGeometry(toned, s);
    const r = workRaster(toned, geo, PRECISION[s.precision] || PRECISION.normal);
    const filtered = applyStyle(r.rgba, style, geo.W, (label) => progress(`style: ${label}`));
    const n = r.w * r.h, d = filtered.data, lum = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) lum[i] = luminance(d[q], d[q + 1], d[q + 2]) / 255;
    return { geo, w: r.w, h: r.h, sx: r.sx, sy: r.sy, filtered, lum };
  });
  const { geo, w, h, sx, sy } = A;
  const px = Math.sqrt(sx * sy);

  // B: the edge graph
  // a line cannot bend round a detail much smaller than its bend: smoothed at two radii
  // at least, or (bendSmooth 'tight') only where it turns tighter than the bend
  const tightOnly = s.bendSmooth === 'tight' && s.minRadius > 0;
  const smooth = tightOnly ? 0 : 2 * s.minRadius, tight = tightOnly ? s.minRadius : 0;
  const keyB = [keyA, s.edgeScale, s.edgeAmount, s.minFeature, s.minLength, s.simplify, smooth, tight];
  const B = stage('B', keyB, () => {
    progress('finding edges');
    const E = cannyEdges(A.lum, w, h, s.edgeScale / px, s.edgeAmount);
    progress('tracing edges');
    const raw = traceGraph(E.edge, w, h, sx, sy);
    const g = cleanGraph(raw, { minFeature: s.minFeature, minLength: s.minLength, simplify: s.simplify, smooth, tight });
    return { graph: g, high: E.high };
  });

  // C: one line
  const start = s.start && isFinite(s.start.x) && isFinite(s.start.y) ? { x: s.start.x, y: s.start.y } : null;
  const keyC = [keyB, s.join, s.oddJoin, start, s.closed, s.join === 'euler' ? s.walk : null];
  const C = stage('C', keyC, () => {
    progress(s.join === 'tsp' ? 'ordering the strokes' : 'joining into one line');
    return routeGraph(B.graph, { join: s.join, oddJoin: s.oddJoin, start, closed: s.closed, walk: s.walk });
  });

  // D: straights and arcs
  const keyD = [keyC, s.minRadius, s.simplify, s.loops, s.lineWidth, s.smoothing, s.joinShape, s.bendFix, s.maxStray,
    s.smoothing === 'fourier' ? s.fourierScale : null, s.smoothing === 'pid' ? [s.pidLook, s.pidP, s.pidD] : null];
  const D = stage('D', keyD, () => {
    progress('fitting arcs');
    const fit = fitLine(C.runs, { minRadius: s.minRadius, tol: s.simplify, loops: s.loops, smoothing: s.smoothing, joins: s.joinShape, fix: s.bendFix, maxStray: s.maxStray,
      fourierScale: s.fourierScale, pid: { look: s.pidLook, p: s.pidP, d: s.pidD } });
    progress('measuring');
    const st = pathStats(fit.path);
    const X = fit.path.segs.length ? crossings(samplePath(fit.path), Math.max(1, 2 * s.lineWidth)) : [];
    return { ...fit, st, crossings: X };
  });

  progress('assembling');
  const g = B.graph;
  const deg = degrees(g.nodes.length, g.edges);
  const st = D.st;
  const stats = {
    length: st.length, edge: st.edge, retrace: st.retrace, join: st.join,
    bends: st.bends, minR: isFinite(st.minR) ? st.minR : 0,
    tight: D.tight.length, loops: D.loops, crossings: D.crossings.length, strayMax: D.stray.max, strayMean: D.stray.mean,
    chains: g.edges.length, merged: g.stats.merged, spurs: g.stats.spurs, pieces: g.stats.pieces,
    ...C.stats,
  };
  const notes = [];
  const L = (mm) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`);
  if (!g.edges.length) notes.push('no edges found: lower the edge scale or raise the edge amount (or the image has no edges stronger than 4% contrast)');
  if (stats.components > 1 && s.join === 'euler') notes.push(`${stats.components} separate pieces, joined by ${stats.bridges} ${stats.bridges === 1 ? 'bridge' : 'bridges'}`);
  if (st.retrace > 0) notes.push(`${L(st.retrace)} of the line goes over itself again (${Math.round((100 * st.retrace) / st.length)}%): two wires side by side there`);
  if (st.join > 0) notes.push(`${L(st.join)} of the line is not in the image (${s.join === 'tsp' ? 'jumps between strokes' : 'bridges and joins'})`);
  if (D.tight.length) notes.push(`${D.tight.length} ${D.tight.length === 1 ? 'corner is' : 'corners are'} tighter than the ${s.minRadius} mm bend radius (the Problems view shows where): raise Smallest feature, or turn on corner loops`);
  if (D.loops) notes.push(`${D.loops} corner ${D.loops === 1 ? 'loop' : 'loops'}`);
  if (D.crossings.length) notes.push(`the wire crosses itself ${D.crossings.length} ${D.crossings.length === 1 ? 'time' : 'times'}: it lifts by its thickness at each`);
  if (B.graph.stats.pieces) notes.push(`${B.graph.stats.pieces} small ${B.graph.stats.pieces === 1 ? 'piece' : 'pieces'} under the shortest line left out`);

  return {
    piece: { W: geo.W, H: geo.H },
    imageRect: geo.imageRect,
    grid: { w, h, sx, sy },
    graph: {
      nodes: g.nodes.map((p, i) => ({ x: r4(p.x), y: r4(p.y), deg: deg[i] })),
      edges: g.edges.map((e) => e.pts.map(r4)),
    },
    path: { x0: r4(D.path.x0), y0: r4(D.path.y0), segs: D.path.segs.map(roundSeg) },
    start: C.start, end: C.end,
    tight: D.tight.map((t) => ({ x: r4(t.x), y: r4(t.y), r: r4(t.r) })),
    strayAt: D.stray.at ? { x: r4(D.stray.at.x), y: r4(D.stray.at.y), d: r4(D.stray.max) } : null,
    crossings: D.crossings.map((c) => ({ x: r4(c.x), y: r4(c.y) })),
    stats,
    notes,
  };
}

const r4 = (v) => Math.round(v * 10000) / 10000;
const roundSeg = (s) => (s.k === 'L'
  ? { k: 'L', x: r4(s.x), y: r4(s.y), kind: s.kind }
  : { k: 'A', x: r4(s.x), y: r4(s.y), cx: r4(s.cx), cy: r4(s.cy), r: r4(s.r), a0: s.a0, sweep: s.sweep, kind: s.kind });

function validate(s) {
  if (!(s.widthMm > 0)) throw new Error('the canvas needs a width');
  if (!(s.heightMm >= 0)) throw new Error('height must be 0 (from the image) or more');
  if (!(s.edgeScale > 0)) throw new Error('the edge scale must be more than 0');
  if (!(s.edgeAmount > 0 && s.edgeAmount <= 1)) throw new Error('the edge amount must be between 0 and 100%');
  if ([s.minFeature, s.minLength, s.simplify, s.minRadius, s.lineWidth, s.maxStray].some((v) => !(v >= 0))) throw new Error('lengths cannot be negative');
  if (!(s.fourierScale > 0) || !(s.pidLook > 0)) throw new Error('the length scale and the look ahead must be more than 0');
  if (!(s.pidP >= 0) || !(s.pidD >= 0)) throw new Error('the gains cannot be negative');
}
