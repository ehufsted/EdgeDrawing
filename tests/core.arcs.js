// core/arcs.js: straights and arcs, tangent where they meet, no arc under the smallest radius.

import { section, check, num } from './runner.js';
import { fitArcs, routePolyline, pathStats, samplePath, crossings, trimPath, segLength } from '../src/core/arcs.js';

/**
 * The largest gap between a seg's start and the previous end, the largest
 * tangent mismatch (radians), and how many mismatches exceed `tol`.
 */
export function continuity(path, tol = 1e-6) {
  let gap = 0, kink = 0, kinks = 0, x = path.x0, y = path.y0, dir = null;
  const note = (k) => { kink = Math.max(kink, k); if (k > tol) kinks++; };
  for (const s of path.segs) {
    if (s.k === 'A') {
      const sx = s.cx + s.r * Math.cos(s.a0), sy = s.cy + s.r * Math.sin(s.a0);
      gap = Math.max(gap, Math.hypot(sx - x, sy - y));
      const ex = s.cx + s.r * Math.cos(s.a0 + s.sweep), ey = s.cy + s.r * Math.sin(s.a0 + s.sweep);
      gap = Math.max(gap, Math.hypot(ex - s.x, ey - s.y));
      const sg = Math.sign(s.sweep);
      const d0 = [-sg * Math.sin(s.a0), sg * Math.cos(s.a0)];
      if (dir) note(Math.acos(Math.max(-1, Math.min(1, d0[0] * dir[0] + d0[1] * dir[1]))));
      const a1 = s.a0 + s.sweep;
      dir = [-sg * Math.sin(a1), sg * Math.cos(a1)];
    } else {
      const L = Math.hypot(s.x - x, s.y - y);
      // a straight under 0.01 mm has no heading worth reading once the plan is rounded to 1e-4 mm
      if (L > 0.01) {
        const d = [(s.x - x) / L, (s.y - y) / L];
        if (dir) note(Math.acos(Math.max(-1, Math.min(1, d[0] * dir[0] + d[1] * dir[1]))));
        dir = d;
      }
    }
    x = s.x; y = s.y;
  }
  return { gap, kink, kinks };
}

export function run() {
  section('core.arcs', 'Prediction: a square\'s corners become arcs no smaller than the smallest radius, every straight and arc tangent to the next (no kink over 1e-6 rad) and touching it; a zig-zag too tight for the radius reports tight corners, and with corner loops on has none; a figure 8 crosses itself once, a line drawn there and back none.');
  const kinds = (n) => Array(n).fill('edge');
  const square = [0, 0, 40, 0, 40, 40, 0, 40, 0, 0.001];
  const f = fitArcs(square, kinds(4), { minRadius: 3, tol: 0.3, loops: false });
  const arcs = f.path.segs.filter((s) => s.k === 'A');
  const c = continuity(f.path);
  check('square: three corner arcs', arcs.length === 3, `${arcs.length} arcs`);
  check('...each at least the smallest radius (3)', arcs.every((a) => a.r >= 3 - 1e-9), `radii ${arcs.map((a) => num(a.r, 2)).join(', ')}`);
  check('...a right-angle corner kept sharp: radius = tol/(√2 − 1) ≈ 0.72, held up to 3', arcs.every((a) => Math.abs(a.r - 3) < 1e-9), '');
  check('...G1: touching and tangent throughout', c.gap < 1e-9 && c.kink < 1e-6, `gap ${c.gap.toExponential(1)}, kink ${c.kink.toExponential(1)} rad`);
  const st = pathStats(f.path);
  const expect = 160 - 3 * (2 * 3) + 3 * (Math.PI / 2) * 3;
  check('...length = the square less the corners cut, plus the arcs', Math.abs(st.length - expect) < 0.01, `${num(st.length, 3)} vs ${num(expect, 3)}`);
  check('...no tight corners', f.tight.length === 0, `${f.tight.length}`);

  // a gentle polygon (a 24-gon of radius 30) comes back as a near-circle: big arcs
  const ngon = [];
  for (let i = 0; i <= 24; i++) ngon.push(30 * Math.cos((2 * Math.PI * i) / 24), 30 * Math.sin((2 * Math.PI * i) / 24));
  const g = fitArcs(ngon, kinds(24), { minRadius: 0, tol: 0.3, loops: false });
  const gr = g.path.segs.filter((s) => s.k === 'A').map((s) => s.r);
  check('24-gon: its corners become arcs near the circle\'s radius (25..35)', gr.length === 23 && gr.every((r) => r > 25 && r < 35), `radii ${num(Math.min(...gr), 1)}..${num(Math.max(...gr), 1)}`);

  // a stray budget under the tolerance holds a gentle corner's arc to it, not making it tight
  const dodec = [];
  for (let i = 0; i <= 12; i++) dodec.push(100 * Math.cos((2 * Math.PI * i) / 12), 100 * Math.sin((2 * Math.PI * i) / 12));
  const dd = fitArcs(dodec, kinds(12), { minRadius: 3, tol: 0.5, maxDev: 0.3 });
  const ddDev = Math.max(...dd.path.segs.filter((s) => s.k === 'A').map((s) => s.r * (1 / Math.cos(Math.abs(s.sweep) / 2) - 1)));
  check('12-gon, tolerance 0.5, stray budget 0.3: no tight corner, every arc within 0.3 of its corner', dd.tight.length === 0 && ddDev <= 0.3 + 1e-9, `${dd.tight.length} tight, farthest ${num(ddDev, 3)} mm`);
  // a zig-zag of 2 mm steps with a 5 mm radius cannot fit
  const zig = [];
  for (let i = 0; i <= 10; i++) zig.push(2 * i, i % 2 ? 2 : 0);
  const z = fitArcs(zig, kinds(10), { minRadius: 5, tol: 0.3, loops: false });
  check('zig-zag, radius 5 on 2 mm steps: tight corners reported', z.tight.length === 9, `${z.tight.length} tight`);
  const zl = fitArcs(zig, kinds(10), { minRadius: 5, tol: 0.3, loops: true });   // 90° turns: within LOOP_MAX
  const zc = continuity(zl.path);
  check('...with corner loops: no tight corners, nine loops, G1', zl.tight.length === 0 && zl.loops === 9 && zc.gap < 1e-9 && zc.kink < 1e-6,
    `${zl.tight.length} tight, ${zl.loops} loops, gap ${zc.gap.toExponential(1)}, kink ${zc.kink.toExponential(1)}`);
  check('...every loop at the smallest radius', zl.path.segs.filter((s) => s.k === 'A').every((s) => Math.abs(s.r - 5) < 1e-9), '');

  // kinds carry through; repeated points vanish
  const rp = routePolyline([{ pts: [0, 0, 10, 0], kind: 'edge' }, { pts: [10, 0, 10, 10], kind: 'join' }, { pts: [10, 10, 10, 10, 0, 10], kind: 'retrace' }]);
  check('routePolyline: one point per corner, kinds per segment', rp.pts.length === 8 && rp.kinds.join() === 'edge,join,retrace', `${rp.pts.length / 2} points, ${rp.kinds.join()}`);

  // crossings
  const eight = [0, 0, 20, 20, 20, 0, 0, 20, 0, 0.5];
  check('a figure 8 crosses itself once', crossings(samplePath(fitArcs(eight, kinds(4), { minRadius: 0, tol: 0.01 }).path)).length === 1, '');
  const back = [0, 0, 30, 0, 30.0001, 0, 0, 0.0001];
  check('there and back along one line: no crossing', crossings(samplePath(fitArcs(back, kinds(3), { minRadius: 0, tol: 0.01 }).path)).length === 0, '');

  // trimming for the animation
  const half = trimPath(f.path, st.length / 2);
  let hl = 0, x = half.x0, y = half.y0;
  for (const s of half.segs) { hl += segLength(s, x, y); x = s.x; y = s.y; }
  check('trimPath at half the length is half as long', Math.abs(hl - st.length / 2) < 1e-6, `${num(hl, 4)} of ${num(st.length, 4)}`);
  const sp = samplePath(f.path, Math.PI / 180);
  check('samplePath: its length matches (to 0.01%)', Math.abs(sp.cum[sp.cum.length - 1] - st.length) / st.length < 1e-4, `${num(sp.cum[sp.cum.length - 1], 3)}`);
}
