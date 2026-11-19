// core/graph.js: pixels to junctions and chains, and the clean-up.

import { section, check, num } from './runner.js';
import { traceGraph, cleanGraph, polyLength, rdp, smoothLine, degrees, components } from '../src/core/graph.js';

function mask(w, h, fn) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fn(x, y)) m[y * w + x] = 1;
  return m;
}

export function run() {
  section('core.graph', 'Prediction: a plus sign traces to one junction of degree 4 and four ends; a ring to one closed loop; a T with a short stub loses the stub and becomes one chain; a ring and a far line are two pieces; pieces under the shortest line go; gaps narrower than the smallest feature are linked, only ahead of a loose end.');
  const w = 60, h = 60;
  const plus = traceGraph(mask(w, h, (x, y) => (y === 30 && x >= 10 && x <= 50) || (x === 30 && y >= 10 && y <= 50)), w, h, 1, 1);
  const deg = degrees(plus.nodes.length, plus.edges);
  check('plus: 4 chains', plus.edges.length === 4, `${plus.edges.length} chains`);
  check('plus: one junction of degree 4, four ends', [...deg].filter((d) => d === 4).length === 1 && [...deg].filter((d) => d === 1).length === 4, `degrees ${[...deg].join(',')}`);
  const total = plus.edges.reduce((s, e) => s + polyLength(e.pts), 0);
  check('plus: total length about 80 px', Math.abs(total - 80) < 4, `${num(total, 1)} px`);

  const ring = traceGraph(mask(w, h, (x, y) => Math.abs(Math.hypot(x - 30, y - 30) - 20) < 0.6), w, h, 1, 1);
  const ringClean = cleanGraph(ring, { minFeature: 2, minLength: 5, simplify: 0.2 });
  check('ring: one closed loop after clean-up', ringClean.edges.length === 1 && ringClean.edges[0].a === ringClean.edges[0].b, `${ringClean.edges.length} chains, ${ringClean.nodes.length} nodes`);
  const rl = ringClean.edges.length ? polyLength(ringClean.edges[0].pts) : 0;
  check('ring: length about 2π·20', Math.abs(rl - 2 * Math.PI * 20) < 8, `${num(rl, 1)} px`);

  const T = traceGraph(mask(w, h, (x, y) => (y === 30 && x >= 5 && x <= 55) || (x === 30 && y > 30 && y <= 33)), w, h, 1, 1);
  const Tc = cleanGraph(T, { minFeature: 4, minLength: 6, simplify: 0.2 });
  check('T with a 3 px stub: the stub goes, one chain is left', Tc.edges.length === 1 && Tc.stats.spurs >= 1, `${Tc.edges.length} chains, ${Tc.stats.spurs} spurs`);
  check('...and it is simplified to its two ends', Tc.edges.length === 1 && Tc.edges[0].pts.length === 4, `${Tc.edges.length ? Tc.edges[0].pts.map((v) => num(v, 2)).join(' ') : 0}`);

  const two = traceGraph(mask(w, h, (x, y) => Math.abs(Math.hypot(x - 18, y - 18) - 10) < 0.6 || (y === 50 && x >= 10 && x <= 50)), w, h, 1, 1);
  const twoC = cleanGraph(two, { minFeature: 2, minLength: 5, simplify: 0.2 });
  check('a ring and a line: two pieces', components(twoC.nodes.length, twoC.edges).count === 2, `${components(twoC.nodes.length, twoC.edges).count} pieces`);
  const short = cleanGraph(two, { minFeature: 2, minLength: 50, simplify: 0.2 });
  check('a shortest line of 50 keeps only the ring (63 long), not the 41 px line', short.edges.length === 1 && short.edges[0].a === short.edges[0].b && short.stats.pieces === 1, `${short.edges.length} chains, ${short.stats.pieces} dropped`);

  // edge linking: a T whose stem stops 2 px short of the bar, and a line broken by a 2 px gap
  const gapT = traceGraph(mask(w, h, (x, y) => (y === 20 && x >= 5 && x <= 55) || (x === 30 && y >= 23 && y <= 50)), w, h, 1, 1);
  const gt = cleanGraph(gapT, { minFeature: 4, minLength: 6, simplify: 0.2 });
  check('a T with a 2 px gap: linked into one piece with a junction', components(gt.nodes.length, gt.edges).count === 1 && [...degrees(gt.nodes.length, gt.edges)].includes(3) && gt.stats.gaps === 1,
    `${components(gt.nodes.length, gt.edges).count} pieces, ${gt.stats.gaps} links`);
  const broken = traceGraph(mask(w, h, (x, y) => y === 40 && ((x >= 5 && x <= 28) || (x >= 31 && x <= 55))), w, h, 1, 1);
  const gb = cleanGraph(broken, { minFeature: 4, minLength: 6, simplify: 0.2 });
  check('a line broken by a 2 px gap: one chain again', gb.edges.length === 1 && gb.stats.gaps === 1, `${gb.edges.length} chains, ${gb.stats.gaps} links`);
  const apart = cleanGraph(broken, { minFeature: 1.5, minLength: 6, simplify: 0.2 });
  check('...but not when the gap is wider than the smallest feature', apart.edges.length === 2 && apart.stats.gaps === 0, `${apart.edges.length} chains`);
  const side = traceGraph(mask(w, h, (x, y) => (y === 10 && x >= 5 && x <= 25) || (y === 12 && x >= 5 && x <= 25)), w, h, 1, 1);
  const gs = cleanGraph(side, { minFeature: 4, minLength: 6, simplify: 0.2 });
  check('two parallel lines 2 px apart are not linked end to side (the other is not ahead)', gs.stats.gaps === 0, `${gs.stats.gaps} links`);

  // helpers
  const zig = [];
  for (let i = 0; i <= 20; i++) zig.push(i, i % 2 ? 0.1 : 0);
  check('rdp: a 0.1 zig-zag within 0.2 is a straight', rdp(zig, 0.2).length === 4, `${rdp(zig, 0.2).length / 2} points`);
  check('rdp: within 0.05 it keeps the zig-zag', rdp(zig, 0.05).length === zig.length, `${rdp(zig, 0.05).length / 2} points`);
  const sm = smoothLine(zig, 1);
  check('smoothing keeps the ends and flattens the middle', sm[0] === 0 && sm[1] === 0 && sm[40] === 20 && Math.abs(sm[21] - 0.05) < 0.02, `middle y ${num(sm[21], 3)}`);
}
