// core/refit.js and core/marks.js: fewer bends, numbered bends, distance ticks.

import { section, check, num } from './runner.js';
import { refitPath } from '../src/core/refit.js';
import { bendList, tickMarks, alongText, placeLabels } from '../src/core/marks.js';
import { fitArcs, pathStats, samplePath } from '../src/core/arcs.js';
import { continuity } from './core.arcs.js';

/** Farthest any point of `a` (densely sampled) is from path `b`. */
function farthest(a, b) {
  const pa = samplePath(a, Math.PI / 90).pts, pb = samplePath(b, Math.PI / 90).pts;
  let worst = 0;
  for (let i = 0; i < pa.length; i += 2) {
    let best = Infinity;
    for (let j = 0; j + 3 < pb.length; j += 2) {
      const ax = pb[j], ay = pb[j + 1], dx = pb[j + 2] - ax, dy = pb[j + 3] - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((pa[i] - ax) * dx + (pa[i + 1] - ay) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(pa[i] - ax - t * dx, pa[i + 1] - ay - t * dy));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

export function run() {
  section('core.marks', 'Prediction: a circle drawn as a 72-gon refits to a handful of arcs at its own radius, within the tolerance, tangent throughout; a straight in many pieces refits to one straight; nothing is refitted tighter than the bend; a rounded square has three bends of 90°, clockwise on the page (R), at the lengths they start at; ticks fall every 10 mm with the total length; labels avoid each other.');
  const kinds = (n) => Array(n).fill('edge');
  // a 72-gon of radius 20, fitted with a small tolerance: 70 small arcs
  const poly = [];
  for (let i = 0; i <= 72; i++) poly.push(50 + 20 * Math.cos((2 * Math.PI * i) / 72), 50 + 20 * Math.sin((2 * Math.PI * i) / 72));
  const fine = fitArcs(poly, kinds(72), { minRadius: 3, tol: 0.01 }).path;
  const rf = refitPath(fine, { tol: 0.3, minRadius: 3 });
  const c = continuity(rf.path);
  const arcs = rf.path.segs.filter((s) => s.k === 'A');
  check('72-gon: refitted to a handful of arcs', rf.path.segs.length <= 6 && fine.segs.length > 60, `${fine.segs.length} → ${rf.path.segs.length} segments`);
  check('...near its own radius (18..22), none under the bend', arcs.every((s) => s.r > 18 && s.r < 22), `radii ${arcs.map((s) => num(s.r, 1)).join(', ')}`);
  // the tolerance holds at samples 0.3 mm apart; between them two arcs part by under 0.01 mm more
  check('...tangent throughout, within the 0.3 mm tolerance (0.01 between samples)', c.gap < 1e-9 && c.kink < 1e-6 && farthest(fine, rf.path) <= 0.3 + 0.01, `kink ${c.kink.toExponential(1)}, farthest ${num(farthest(fine, rf.path), 3)} mm`);
  // a straight in 40 pieces
  const st = { x0: 0, y0: 0, segs: Array.from({ length: 40 }, (_, i) => ({ k: 'L', x: i + 1, y: 0, kind: 'edge' })) };
  const rs = refitPath(st, { tol: 0.2, minRadius: 3 });
  check('a straight in 40 pieces: one straight', rs.path.segs.length === 1 && rs.path.segs[0].k === 'L' && rs.path.segs[0].x === 40, `${rs.path.segs.length} segments`);
  // a circle of radius 2 under a 3 mm bend: refitted no tighter than 3 (it strays)
  const small = [];
  for (let i = 0; i <= 36; i++) small.push(2 * Math.cos((2 * Math.PI * i) / 36), 2 * Math.sin((2 * Math.PI * i) / 36));
  const rsm = refitPath(fitArcs(small, kinds(36), { minRadius: 0, tol: 0.01 }).path, { tol: 0.5, minRadius: 3 });
  check('a 2 mm circle under a 3 mm bend: no arc tighter than 3', rsm.path.segs.every((s) => s.k !== 'A' || s.r >= 3 - 1e-9), `${rsm.forced.length} corners kept`);
  // kinds: an edge then a join: no arc spans both
  const kj = { x0: 0, y0: 0, segs: [...Array.from({ length: 10 }, (_, i) => ({ k: 'L', x: i + 1, y: 0, kind: 'edge' })), ...Array.from({ length: 10 }, (_, i) => ({ k: 'L', x: 11 + i, y: 0, kind: 'join' }))] };
  const rk = refitPath(kj, { tol: 0.2, minRadius: 3 });
  check('an edge then a join: two straights, one of each kind', rk.path.segs.length === 2 && rk.path.segs[0].kind === 'edge' && rk.path.segs[1].kind === 'join', rk.path.segs.map((s) => `${s.kind} to ${s.x}`).join(', '));

  // bends: a rounded square, travelling east first (y down: east, then south is clockwise)
  const sq = fitArcs([0, 0, 40, 0, 40, 40, 0, 40, 0, 0.001], kinds(4), { minRadius: 3, tol: 0.3 }).path;
  const bl = bendList(sq);
  check('square: three bends, 90° each, all R', bl.length === 3 && bl.every((b) => Math.abs(b.angle - 90) < 1e-6 && b.dir === 'R' && Math.abs(b.r - 3) < 1e-9), bl.map((b) => `${b.n} ${b.dir}${num(b.angle, 1)}° r${b.r}`).join(' · '));
  check('...starting 37, 37 + 4.71 + 34 ... mm along', Math.abs(bl[0].at - 37) < 1e-6 && Math.abs(bl[1].at - (37 + 1.5 * Math.PI + 34)) < 1e-6, bl.map((b) => num(b.at, 2)).join(', '));
  const back = bendList({ x0: 0, y0: 0, segs: [{ k: 'A', x: 0, y: 0, cx: 0, cy: -10, r: 10, a0: Math.PI / 2, sweep: 0.5, kind: 'edge' }] });
  check('a turn of increasing angle on the page is R; under 3° is no bend', back[0].dir === 'R' && bendList({ x0: 0, y0: 0, segs: [{ k: 'A', x: 0, y: 0, cx: 0, cy: -10, r: 10, a0: 0, sweep: 0.04, kind: 'edge' }] }).length === 0, '');

  // ticks
  const tk = tickMarks({ x0: 0, y0: 0, segs: [{ k: 'L', x: 35, y: 0, kind: 'edge' }] }, 10);
  check('ticks every 10 mm on 35 mm: at 10, 20, 30, on the line', tk.length === 3 && tk.every((t, i) => t.at === 10 * (i + 1) && Math.abs(t.x - t.at) < 1e-9 && t.ux === 1), tk.map((t) => t.at).join(', '));
  const tks = tickMarks(sq, 50);
  check('ticks on the square: every 50 mm of its length', tks.length === Math.floor(pathStats(sq).length / 50), `${tks.length} ticks, ${num(pathStats(sq).length, 1)} mm`);
  check('labels: cm in mm units, inches in inches', alongText(1200, 'mm') === '120 cm' && alongText(1250, 'mm') === '125 cm' && alongText(254, 'in') === '10 in' && alongText(266.7, 'in') === '10.5 in',
    `${alongText(1200, 'mm')}, ${alongText(254, 'in')}, ${alongText(266.7, 'in')}`);
  // labels: two bends at one place get two places, and neither covers the line
  const wire = { x0: -20, y0: 0, segs: [{ k: 'L', x: 20, y: 0, kind: 'edge' }] };
  const two = [{ mx: 0, my: 0, ox: 0, oy: -1 }, { mx: 0, my: 0, ox: 0, oy: -1 }];
  const pl = placeLabels(wire, [], two, 2, 1, 'mm').spots;
  const apart = Math.abs(pl[0].x - pl[1].x) >= 2 * 1.3 * 2 || Math.abs(pl[0].y - pl[1].y) >= 2 * 1.0 * 2;
  const offLine = pl.every((p) => Math.abs(p.y) >= 1.0 * 2);
  check('labels: two bends at one place are placed apart, neither over the line', apart && offLine, JSON.stringify(pl.map((p) => [num(p.x, 1), num(p.y, 1)])));
  const tsp = placeLabels(wire, tickMarks(wire, 10), [], 2, 1, 'mm').tickSpots;
  check('...and tick labels (10, 20, 30, 40 mm on 40) sit beside the line, not on it', tsp.length === 4 && tsp.every((p) => Math.abs(p.y) > 1), JSON.stringify(tsp.map((p) => [num(p.x, 1), num(p.y, 1)])));
}
