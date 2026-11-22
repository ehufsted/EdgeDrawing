// The whole pipeline on the procedural samples: one continuous line, G1, the
// edges drawn once, the stages cached, the same result every time.

import { section, check, num } from './runner.js';
import { runPipeline } from '../src/pipeline.js';
import { generateSample } from '../src/app/samples.js';
import { continuity } from './core.arcs.js';
import { pathStats } from '../src/core/arcs.js';
import { polyLength } from '../src/core/graph.js';

export function run() {
  section('pipeline', 'Prediction: on the sphere and rings samples the plan is one line, touching and tangent from end to end (G1), its arcs no tighter than the smallest radius except the corners it reports; the Eulerian line draws the edges once (its "edge" length within 3% of the graph\'s, arcs only cut corners); the same settings give the same plan; turning on corner loops re-uses the cached edges and route.');
  // the checks of the fit itself, unsmoothed; the default steering has its own below
  const base = { widthMm: 200, precision: 'rough', minRadius: 2, smoothing: 'none' };
  const sphere = generateSample('sphere').color;
  const cache = {};
  const p1 = runPipeline(sphere, base, { cache, imageKey: 1 });
  const c1 = continuity(p1.path);
  check('sphere: a line was drawn', p1.path.segs.length > 10 && p1.stats.length > 100, `${p1.path.segs.length} segments, ${num(p1.stats.length, 0)} mm`);
  check('sphere: one continuous line, G1', c1.gap < 1e-3 && c1.kink < 1e-3, `gap ${c1.gap.toExponential(1)} mm, kink ${c1.kink.toExponential(1)} rad`);
  // odd ends joined by the shorter way, pair by pair: a straight is never longer than a
  // way along lines, so on the 300 mm sphere, whose odd ends are far apart (past where
  // straights were looked for, so once only retraced), nearly all are straights; set to
  // retrace, the line is longer but less of it is outside the image
  const sh = runPipeline(sphere, { ...base, widthMm: 300 }, {}), rt = runPipeline(sphere, { ...base, widthMm: 300, retrace: true }, {});
  check('sphere: the shorter way retraces almost nothing, and is shorter than retracing', sh.stats.retrace < 0.01 * sh.stats.length && sh.stats.length < rt.stats.length,
    `${num(sh.stats.length, 0)} mm, ${num(sh.stats.retrace, 0)} retraced; retracing ${num(rt.stats.length, 0)} mm`);
  check('...and retracing leaves less of the line outside the image', rt.stats.join < sh.stats.join,
    `${num(rt.stats.join, 0)} mm outside, against ${num(sh.stats.join, 0)}`);
  const arcs = p1.path.segs.filter((s) => s.k === 'A');
  const under = arcs.filter((a) => a.r < 2 - 1e-3).length;
  check('sphere: arcs under the 2 mm radius only at reported tight corners', under <= p1.tight.length, `${under} arcs under, ${p1.tight.length} reported`);
  const graphLen = p1.graph.edges.reduce((s, e) => s + polyLength(e), 0);
  check('sphere: the edges drawn once (edge length within 3% of the graph\'s)', Math.abs(p1.stats.edge - graphLen) / graphLen < 0.03, `${num(p1.stats.edge, 1)} of ${num(graphLen, 1)} mm`);
  check('sphere: stats match the path', Math.abs(pathStats(p1.path).length - p1.stats.length) < 0.05, '');
  const keyB = cache.B.val;
  const keyC = cache.C.val;
  const p2 = runPipeline(sphere, { ...base, loops: true }, { cache, imageKey: 1 });
  check('corner loops re-use the cached edge graph and route', cache.B.val === keyB && cache.C.val === keyC && p2.stats.length > 0, '');
  const p3 = runPipeline(sphere, base, {});
  check('the same settings, no cache: the same plan', JSON.stringify(p3) === JSON.stringify(p1), `${JSON.stringify(p3).length} vs ${JSON.stringify(p1).length} chars`);

  // a pen may turn on the spot: with no smallest radius, a kink is allowed only at a corner it could not round
  const rings = generateSample('rings').color;
  for (const retrace of [false, true]) {
    const p = runPipeline(rings, { ...base, retrace, minRadius: 0.5 }, {});
    const c = continuity(p.path, 0.01);
    check(`rings, ${retrace ? 'retracing' : 'the shorter way'}: one continuous line, kinks only at reported tight corners`, p.path.segs.length > 10 && c.gap < 1e-3 && c.kinks <= p.stats.sharp,
      `${p.stats.chains} chains, ${num(p.stats.length, 0)} mm, gap ${c.gap.toExponential(1)}, ${c.kinks} kinks, ${p.tight.length} tight`);
  }
  // the start: an odd node of the joined graph, which can be a bridge's end, so at least as near as the graph's
  // (the setting is a fraction of the canvas: 0.75 of this 200 mm square is 150 mm)
  const startAt = { x: 150, y: 150 };
  const ps = runPipeline(rings, { ...base, start: { x: 0.75, y: 0.75 } }, {});
  const near = Math.hypot(ps.start.x - startAt.x, ps.start.y - startAt.y);
  const any = Math.min(...ps.graph.nodes.filter((n) => n.deg % 2).map((n) => Math.hypot(n.x - startAt.x, n.y - startAt.y)));
  check('a start point: the line starts at least as near it as the nearest odd node', near <= any + 1e-3, `${num(near, 2)} mm away (nearest odd node of the edges ${num(any, 2)})`);
  // on a canvas twice the size the same setting aims at the same place on the picture,
  // 300, 300 mm. A closed line may start at any node (the edges' own, or a bridge's), so
  // at least as near it as the nearest node of the edges
  const ps2 = runPipeline(rings, { ...base, widthMm: 400, closed: true, start: { x: 0.75, y: 0.75 } }, {});
  const near2 = Math.hypot(ps2.start.x - 300, ps2.start.y - 300);
  const any2 = Math.min(...ps2.graph.nodes.map((n) => Math.hypot(n.x - 300, n.y - 300)));
  check('...and on a canvas twice the size it aims at the same place on the picture (300, 300 mm)', near2 <= any2 + 1e-3,
    `${num(near2, 2)} mm away (nearest node of the edges ${num(any2, 2)})`);
  // every bend option: still one continuous line, tangent except at the tight corners it reports
  const wire = { ...base, minRadius: 3, lineWidth: 1.2 };
  const variants = [
    { joinShape: 'dubins' }, { walk: 'pairs' }, { bendSmooth: 'tight' },
    { bendFix: 'merge' }, { bendFix: 'remove' }, { smoothing: 'optimize' }, { smoothing: 'fourier' }, { smoothing: 'pid' }, { smoothing: 'pid', joinShape: 'dubins', walk: 'pairs' },
    { joinShape: 'dubins', walk: 'pairs', bendSmooth: 'tight', bendFix: 'merge' },
  ];
  const plainW = runPipeline(rings, wire, {});
  for (const v of variants) {
    const p = runPipeline(rings, { ...wire, ...v }, {});
    const c = continuity(p.path, 0.01);
    check(`rings, wire, ${JSON.stringify(v).replace(/[{}"]/g, '')}: one continuous line, kinks only at reported tight corners`,
      p.path.segs.length > 10 && c.gap < 1e-3 && c.kinks <= p.stats.sharp,
      `${p.tight.length} tight (plain ${plainW.tight.length}), ${num(p.stats.length, 0)} mm (plain ${num(plainW.stats.length, 0)}), stray ${num(p.stats.strayMax, 2)} mm`);
  }
  // the defaults: steered, P 1, D 1, looking 4 mm ahead
  const pd = runPipeline(rings, { widthMm: 200, precision: 'rough', minRadius: 3 }, {});
  const pdc = continuity(pd.path, 0.01);
  const pdr = pd.path.segs.filter((s) => s.k === 'A').map((s) => s.r);
  check('defaults: the line is steered, one continuous tangent line, no arc under the 3 mm bend, nothing tight',
    pd.path.segs.length > 10 && pdc.gap < 1e-3 && pdc.kinks === 0 && pdr.every((r) => r >= 3 - 1e-6) && pd.tight.length === 0,
    `${num(pd.stats.length, 0)} mm, tightest ${num(Math.min(...pdr), 2)} mm, stray ${num(pd.stats.strayMax, 2)} / ${num(pd.stats.strayMean, 2)} mm, ${pdc.kinks} kinks, ${pd.tight.length} tight, ${pd.stats.bends} bends`);
  // Fewer bends keeps each kind's length: no arc spans more than a short run into the next
  const r0 = runPipeline(rings, { widthMm: 200, precision: 'rough', minRadius: 3 }, {});
  const r1 = runPipeline(rings, { widthMm: 200, precision: 'rough', minRadius: 3, bendTol: 0.5 }, {});
  const rc = continuity(r1.path, 0.01);
  check('Fewer bends on the steered rings: far fewer segments, tangent, the joins\' length within 10%', r1.path.segs.length < r0.path.segs.length / 3 && rc.kinks <= r1.stats.sharp && Math.abs(r1.stats.join - r0.stats.join) <= 0.1 * r0.stats.join,
    `${r0.path.segs.length} → ${r1.path.segs.length} segments, join ${num(r0.stats.join, 0)} → ${num(r1.stats.join, 0)} mm`);
  const pc = runPipeline(rings, { ...base, closed: true }, {});
let refusedNeg = '';  try { runPipeline(rings, { ...base, maxStray: -1 }, {}); } catch (e) { refusedNeg = e.message; }  check('a negative stray is refused, not used', refusedNeg === 'lengths cannot be negative', refusedNeg);
  check('closed: ends where it starts', Math.hypot(pc.start.x - pc.end.x, pc.start.y - pc.end.y) < 1e-6, '');
}
