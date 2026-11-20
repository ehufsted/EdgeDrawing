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
  for (const join of ['euler', 'tsp']) {
    const p = runPipeline(rings, { ...base, join, minRadius: 0.5 }, {});
    const c = continuity(p.path, 0.01);
    check(`rings, ${join}: one continuous line, kinks only at reported tight corners`, p.path.segs.length > 10 && c.gap < 1e-3 && c.kinks <= p.tight.length,
      `${p.stats.chains} chains, ${num(p.stats.length, 0)} mm, gap ${c.gap.toExponential(1)}, ${c.kinks} kinks, ${p.tight.length} tight`);
    if (join === 'tsp') check('rings, tsp: nothing retraced', p.stats.retrace === 0, `${num(p.stats.retrace, 1)} mm`);
  }
  // the start: an odd node of the joined graph, which can be a bridge's end, so at least as near as the graph's
  const startAt = { x: 150, y: 150 };
  const ps = runPipeline(rings, { ...base, start: startAt }, {});
  const near = Math.hypot(ps.start.x - startAt.x, ps.start.y - startAt.y);
  const any = Math.min(...ps.graph.nodes.filter((n) => n.deg % 2).map((n) => Math.hypot(n.x - startAt.x, n.y - startAt.y)));
  check('a start point: the line starts at least as near it as the nearest odd node', near <= any + 1e-3, `${num(near, 2)} mm away (nearest odd node of the edges ${num(any, 2)})`);
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
      p.path.segs.length > 10 && c.gap < 1e-3 && c.kinks <= p.tight.length,
      `${p.tight.length} tight (plain ${plainW.tight.length}), ${num(p.stats.length, 0)} mm (plain ${num(plainW.stats.length, 0)}), stray ${num(p.stats.strayMax, 2)} mm`);
  }
  // the defaults: steered, P 1, D 1, looking 4 mm ahead
  const pd = runPipeline(rings, { widthMm: 200, precision: 'rough', minRadius: 3 }, {});
  const pdc = continuity(pd.path, 0.01);
  const pdr = pd.path.segs.filter((s) => s.k === 'A').map((s) => s.r);
  check('defaults: the line is steered, one continuous tangent line, no arc under the 3 mm bend, nothing tight',
    pd.path.segs.length > 10 && pdc.gap < 1e-3 && pdc.kinks === 0 && pdr.every((r) => r >= 3 - 1e-6) && pd.tight.length === 0,
    `${num(pd.stats.length, 0)} mm, tightest ${num(Math.min(...pdr), 2)} mm, stray ${num(pd.stats.strayMax, 2)} / ${num(pd.stats.strayMean, 2)} mm`);
  const pc = runPipeline(rings, { ...base, closed: true }, {});
let refusedNeg = '';  try { runPipeline(rings, { ...base, maxStray: -1 }, {}); } catch (e) { refusedNeg = e.message; }  check('a negative stray is refused, not used', refusedNeg === 'lengths cannot be negative', refusedNeg);
  check('closed: ends where it starts', Math.hypot(pc.start.x - pc.end.x, pc.start.y - pc.end.y) < 1e-6, '');
}
