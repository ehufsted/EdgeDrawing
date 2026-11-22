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
  section('core.edits', 'Prediction: an eraser stroke across the middle of a straight cuts it in two, leaving a gap of twice its radius; one along a whole edge removes it; a pencil line from the end of one edge to the middle of another joins them into one piece (splitting the second there); a pencil line far from everything is a piece of its own; edits apply in order (a drawn line erased is gone); an end just past a line\'s end joins its node, and one on a chain\'s corner splits it there, never leaving a piece or a step of no length; bad edits are left out; the pipeline draws one continuous line through the edited edges, and the edits, kept on the image, stay on the same part of it on a canvas twice the size.');
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
  // an end just past a line's end, beyond half the snap reach from its node: the
  // nearest point on the line is that end, so it joins the node (not a split there)
  const past = applyEdits(straight, [{ op: 'draw', pts: [101.5, 0, 101.5, 30] }], d);
  const shortest = Math.min(...past.edges.map((e) => polyLength(e.pts)));
  check('drawing from just past a line\'s end joins its node: no edge of no length', past.edges.length === 2 && shortest > 1 && components(past.nodes.length, past.edges).count === 1,
    `${past.edges.length} edges, shortest ${num(shortest, 2)} mm`);
  // an end nearest a point in the middle of a chain splits it there without repeating the point
  const bent = applyEdits(graphOf([[0, 0, 50, 0, 50, 50]]), [{ op: 'draw', pts: [51.2, -1.2, 51.2, -30] }], d);
  const repeats = bent.edges.filter((e) => { for (let i = 2; i < e.pts.length; i += 2) if (Math.hypot(e.pts[i] - e.pts[i - 2], e.pts[i + 1] - e.pts[i - 1]) < 1e-9) return true; return false; }).length;
  check('...and one landing on a chain\'s corner splits it there, no point repeated', bent.edges.length === 3 && repeats === 0, `${bent.edges.length} edges, ${repeats} with a repeated point`);

  const pe = parseEdits([{ op: 'erase', r: 2, pts: [1, 2, 3, 4] }, { op: 'draw', pts: [1, 2] }, { op: 'paint', pts: [1, 2, 3, 4] }, { op: 'erase', r: -1, pts: [1, 2] }, { op: 'draw', pts: [1, 'x', 3, 4] }, { op: 'draw', pts: [0, 0, 5, 5] }]);
  check('parseEdits keeps the two usable edits, drops four', pe.edits.length === 2 && pe.dropped === 4, `${pe.edits.length} kept, ${pe.dropped} dropped`);

  // through the pipeline: a box erased in the middle of the rings, a line drawn across it
  const rings = generateSample('rings').color;
  const base = { widthMm: 200, precision: 'rough', minRadius: 3 };
  const p0 = runPipeline(rings, base, {});
  // edits are on the image, in fractions of it: on this 200 mm square, a 15 mm disc at the centre
  const edits = [{ op: 'erase', r: 0.075, pts: [0.5, 0.5] }, { op: 'draw', pts: [0.3, 0.5, 0.7, 0.5] }];
  const p1 = runPipeline(rings, { ...base, edits }, {});
  const c = continuity(p1.path, 0.01);
  // edges in the disc of radius R round (C, C), other than the drawn line along y = C
  const near = (g, C, R) => g.edges.filter((e) => { for (let i = 0; i < e.length; i += 2) if (Math.hypot(e[i] - C, e[i + 1] - C) < R && Math.abs(e[i + 1] - C) > 1) return true; return false; }).length;
  check('pipeline: the erased disc has no edges left but the drawn line, which is marked drawn', near(p0.graph, 100, 14) > 0 && near(p1.graph, 100, 14) === 0 && p1.graph.drawn.length >= 1 && p1.stats.edits === 2,
    `${near(p0.graph, 100, 14)} → ${near(p1.graph, 100, 14)} edges in the disc, ${p1.graph.drawn.length} drawn`);
  check('...and the line through it all is one, continuous and tangent', p1.path.segs.length > 10 && c.gap < 1e-3 && c.kinks <= p1.stats.sharp, `${num(p1.stats.length, 0)} mm`);
  // the same edits on a canvas twice the size: they move and grow with the picture
  const big = { ...base, widthMm: 400 };
  const q0 = runPipeline(rings, big, {}), q1 = runPipeline(rings, { ...big, edits }, {});
  check('a canvas twice the size: the edits stay on the same part of the image (a 30 mm disc at the centre, erased)', near(q0.graph, 200, 28) > 0 && near(q1.graph, 200, 28) === 0 && q1.stats.edits === 2,
    `${near(q0.graph, 200, 28)} → ${near(q1.graph, 200, 28)} edges in the disc`);
}
