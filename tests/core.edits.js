// core/edits.js: erasing and drawing edges, applied before the line is joined.

import { section, check, num } from './runner.js';
import { applyEdits, parseEdits } from '../src/core/edits.js';
import { components, polyLength } from '../src/core/graph.js';
import { runPipeline } from '../src/pipeline.js';
import { generateSample } from '../src/app/samples.js';
import { continuity } from './core.arcs.js';

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

const d = { minFeature: 2, simplify: 0.3 };
const total = (g) => g.edges.reduce((s, e) => s + polyLength(e.pts), 0);

export function run() {
  section('core.edits', 'Prediction: an eraser stroke across the middle of a straight cuts it in two, leaving a gap of twice its radius; one along a whole edge removes it; a pencil line from the end of one edge to the middle of another joins them into one piece (splitting the second there); a pencil line far from everything is a piece of its own; edits apply in order (a drawn line erased is gone); the pipeline draws one continuous line through the edited edges; bad edits are left out.');
  const straight = graphOf([[0, 0, 100, 0]]);
  const cut = applyEdits(straight, [{ op: 'erase', r: 5, pts: [50, -20, 50, 20] }], d);
  const xs = cut.edges.map((e) => [Math.min(e.pts[0], e.pts[e.pts.length - 2]), Math.max(e.pts[0], e.pts[e.pts.length - 2])]).sort((a, b) => a[0] - b[0]);
  check('erasing across a straight: two pieces, a 10 mm gap round the stroke', cut.edges.length === 2 && Math.abs(xs[0][1] - 45) < 0.6 && Math.abs(xs[1][0] - 55) < 0.6 && cut.applied === 1,
    xs.map((x) => `${num(x[0], 1)}..${num(x[1], 1)}`).join(', '));
  const gone = applyEdits(straight, [{ op: 'erase', r: 3, pts: [-5, 0, 105, 0] }], d);
  check('erasing along a whole edge removes it', gone.edges.length === 0, `${gone.edges.length} edges`);
  const miss = applyEdits(straight, [{ op: 'erase', r: 3, pts: [0, 50, 100, 50] }], d);
  check('erasing where there is no edge changes nothing (and says so)', miss.edges.length === 1 && miss.applied === 0, '');

  // a T made by hand: a vertical stroke from (50, 30) down to the straight
  const two = graphOf([[0, 0, 100, 0], [50, 31, 50, 60]]);
  const joined = applyEdits(two, [{ op: 'draw', pts: [50, 31.5, 50, 20, 50, 1] }], d);
  check('drawing from one edge\'s end to the middle of another: one piece', components(joined.nodes.length, joined.edges).count === 1 && joined.drawn.size === 1,
    `${components(joined.nodes.length, joined.edges).count} pieces, ${joined.edges.length} edges`);
  const tee = joined.nodes.filter((_, v) => joined.edges.filter((e) => e.a === v || e.b === v).length === 3);
  check('...the straight split at the meeting point, which is on it', tee.length === 1 && Math.abs(tee[0].y) < 1e-9 && Math.abs(tee[0].x - 50) < 0.5, tee.map((p) => `${num(p.x, 2)}, ${num(p.y, 2)}`).join(''));
  const apart = applyEdits(straight, [{ op: 'draw', pts: [0, 50, 40, 60, 80, 50] }], d);
  check('drawing far from everything: a piece of its own', components(apart.nodes.length, apart.edges).count === 2, '');
  const undone = applyEdits(straight, [{ op: 'draw', pts: [0, 50, 80, 50] }, { op: 'erase', r: 4, pts: [-5, 50, 85, 50] }], d);
  check('edits apply in order: a drawn line then erased is gone', undone.edges.length === 1 && Math.abs(total(undone) - 100) < 1e-6, `${undone.edges.length} edges`);

  const pe = parseEdits([{ op: 'erase', r: 2, pts: [1, 2, 3, 4] }, { op: 'draw', pts: [1, 2] }, { op: 'paint', pts: [1, 2, 3, 4] }, { op: 'erase', r: -1, pts: [1, 2] }, { op: 'draw', pts: [1, 'x', 3, 4] }, { op: 'draw', pts: [0, 0, 5, 5] }]);
  check('parseEdits keeps the two usable edits, drops four', pe.edits.length === 2 && pe.dropped === 4, `${pe.edits.length} kept, ${pe.dropped} dropped`);

  // through the pipeline: a box erased in the middle of the rings, a line drawn across it
  const rings = generateSample('rings').color;
  const base = { widthMm: 200, precision: 'rough', minRadius: 3 };
  const p0 = runPipeline(rings, base, {});
  const edits = [{ op: 'erase', r: 15, pts: [100, 100] }, { op: 'draw', pts: [60, 100, 140, 100] }];
  const p1 = runPipeline(rings, { ...base, edits }, {});
  const c = continuity(p1.path, 0.01);
  const near = (g) => g.edges.filter((e) => { for (let i = 0; i < e.length; i += 2) if (Math.hypot(e[i] - 100, e[i + 1] - 100) < 14 && Math.abs(e[i + 1] - 100) > 1) return true; return false; }).length;
  check('pipeline: the erased disc has no edges left but the drawn line, which is marked drawn', near(p0.graph) > 0 && near(p1.graph) === 0 && p1.graph.drawn.length >= 1 && p1.stats.edits === 2,
    `${near(p0.graph)} → ${near(p1.graph)} edges in the disc, ${p1.graph.drawn.length} drawn`);
  check('...and the line through it all is one, continuous and tangent', p1.path.segs.length > 10 && c.gap < 1e-3 && c.kinks <= p1.stats.sharp, `${num(p1.stats.length, 0)} mm`);
}
