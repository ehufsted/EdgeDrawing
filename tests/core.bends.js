// The bend experiments: Dubins paths, the paired walk, tight-only smoothing,
// and the three ways of fixing tight corners.

import { section, check, num, mkRand } from './runner.js';
import { dubins } from '../src/core/dubins.js';
import { fitLine, measureStray, fft, fourierLine, steerLine } from '../src/core/bends.js';
import { pairedWalk, hierholzer } from '../src/core/route.js';
import { smoothTight, smoothLine, circumradius } from '../src/core/graph.js';
import { continuity } from './core.arcs.js';

/** The tightest circle through points R/2 of arc apart, along a dense polyline. */
function tightest(p, R) {
  let worst = Infinity;
  const m = p.length / 2;
  const s = [0];
  for (let i = 1; i < m; i++) s.push(s[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]));
  for (let i = 1; i < m - 1; i++) {
    let j = i, k = i;
    while (j > 0 && s[i] - s[j] < R / 2) j--;
    while (k < m - 1 && s[k] - s[i] < R / 2) k++;
    worst = Math.min(worst, circumradius(p[2 * j], p[2 * j + 1], p[2 * i], p[2 * i + 1], p[2 * k], p[2 * k + 1]));
  }
  return worst;
}

export function run() {
  section('core.bends', 'Prediction: every Dubins path lands on its goal point and heading, is tangent throughout, turns only at the radius, and is never shorter than the straight distance (a goal straight ahead is exactly that); the paired walk draws every edge once, continuously; tight-only smoothing leaves points more than 2R from a tight corner exactly where they were; each fix clears a 2 mm notch in a straight at R = 3 within a 3 mm stray, and none can within 1 mm; Dubins joins leave no corner where a join meets a stroke; Fourier smoothing removes wiggles shorter than its length scale and keeps longer ones and the ends; the PID steering never turns tighter than the radius, follows a straight exactly, and loops round at a dead end.');

  // Dubins
  const rand = mkRand(7);
  let worstMiss = 0, worstKink = 0, shorter = 0, offRadius = 0;
  for (let n = 0; n < 300; n++) {
    const x0 = 40 * rand(), y0 = 40 * rand(), h0 = 6.3 * rand(), x1 = 40 * rand(), y1 = 40 * rand(), h1 = 6.3 * rand(), rho = 0.5 + 5 * rand();
    const d = dubins(x0, y0, h0, x1, y1, h1, rho);
    const path = { x0, y0, segs: d.segs };
    // a straight seg first: its heading must be h0 (continuity cannot see the first heading)
    const c = continuity({ x0: x0 - Math.cos(h0), y0: y0 - Math.sin(h0), segs: [{ k: 'L', x: x0, y: y0 }, ...d.segs, { k: 'L', x: x1 + 1e-3 * Math.cos(h1), y: y1 + 1e-3 * Math.sin(h1) }] });
    const last = d.segs[d.segs.length - 1];
    worstMiss = Math.max(worstMiss, last ? Math.hypot(last.x - x1, last.y - y1) : Math.hypot(x0 - x1, y0 - y1));
    worstKink = Math.max(worstKink, c.kink);
    if (d.length < Math.hypot(x1 - x0, y1 - y0) - 1e-9) shorter++;
    offRadius += d.segs.filter((s) => s.k === 'A' && Math.abs(s.r - rho) > 1e-12).length;
    void path;
  }
  check('300 random Dubins paths land on the goal', worstMiss < 1e-6, `worst miss ${worstMiss.toExponential(1)}`);
  check('...leave and arrive at the given headings and are tangent throughout', worstKink < 1e-4, `worst kink ${worstKink.toExponential(1)} rad`);
  check('...turn only at the radius, never shorter than the straight distance', offRadius === 0 && shorter === 0, `${offRadius} off radius, ${shorter} too short`);
  const ahead = dubins(0, 0, 0, 30, 0, 0, 5);
  check('a goal straight ahead: the straight itself', Math.abs(ahead.length - 30) < 1e-9 && ahead.segs.every((s) => s.k === 'L'), `${ahead.word}, ${num(ahead.length, 4)}`);
  const back = dubins(0, 0, 0, 0, 0, Math.PI, 2);
  check('turning round on the spot needs a loop of about the radius (length > 2πρ·0.75)', back.length > 1.5 * Math.PI * 2, `${back.word}, ${num(back.length, 2)}`);

  // the paired walk, on a figure 8 drawn as two squares sharing a corner, plus a tail
  const sq = (x, y) => [[x, y, x + 10, y], [x + 10, y, x + 10, y + 10], [x + 10, y + 10, x, y + 10], [x, y + 10, x, y]];
  const lines = [...sq(0, 0), ...sq(10, 10).map((l) => l), [20, 20, 30, 30]];
  const nodes = [], edges = [];
  const node = (x, y) => { let i = nodes.findIndex((p) => p.x === x && p.y === y); if (i < 0) { i = nodes.length; nodes.push({ x, y }); } return i; };
  for (const l of lines) edges.push({ a: node(l[0], l[1]), b: node(l[2], l[3]), pts: l });
  const start = node(0, 0) === -1 ? 0 : nodes.findIndex((p) => p.x === 30 && p.y === 30);
  const deg = nodes.map((_, v) => edges.filter((e) => e.a === v).length + edges.filter((e) => e.b === v).length);
  const odd = deg.map((d, v) => (d % 2 ? v : -1)).filter((v) => v >= 0);
  const w = pairedWalk(nodes.length, edges, odd.includes(start) ? start : odd[0]);
  let cont = true;
  for (let k = 1; k < w.length; k++) {
    const prev = edges[w[k - 1].e], cur = edges[w[k].e];
    if ((w[k - 1].rev ? prev.a : prev.b) !== (w[k].rev ? cur.b : cur.a)) cont = false;
  }
  check('paired walk: every edge once, continuous', w.length === edges.length && new Set(w.map((x) => x.e)).size === edges.length && cont, `${w.length} of ${edges.length}, continuous ${cont}`);
  const turning = (walk) => {
    let t = 0;
    for (let k = 1; k < walk.length; k++) {
      const p = edges[walk[k - 1].e].pts, q = edges[walk[k].e].pts;
      const a = walk[k - 1].rev ? [p[0] - p[2], p[1] - p[3]] : [p[2] - p[0], p[3] - p[1]];
      const b = walk[k].rev ? [q[0] - q[2], q[1] - q[3]] : [q[2] - q[0], q[3] - q[1]];
      t += Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / Math.hypot(...a) / Math.hypot(...b))));
    }
    return t;
  };
  const h = hierholzer(nodes.length, edges, odd.includes(start) ? start : odd[0]);
  check('...turning no more than the step-by-step walk', turning(w) <= turning(h) + 1e-9, `paired ${num(turning(w), 2)} rad, step by step ${num(turning(h), 2)} rad`);

  // tight-only smoothing: a dense L
  const L = [];
  for (let x = 0; x <= 40; x += 0.2) L.push(x, 0);
  for (let y = 0.2; y <= 40; y += 0.2) L.push(40, y);
  const st = smoothTight(L, 3);
  let moved = 0;
  for (let i = 0; i < L.length; i += 2) {
    const far = Math.hypot(L[i] - 40, L[i + 1]) > 2 * 3;
    if (far && Math.hypot(st[i] - L[i], st[i + 1] - L[i + 1]) > 0) moved++;
  }
  check('tight-only smoothing: nothing more than 2R from the corner moves', moved === 0, `${moved} far points moved`);
  check('...the corner is rounded to about the radius (tightest circle ≥ 0.7 R)', tightest(st, 3) >= 0.7 * 3, `tightest ${num(tightest(st, 3), 2)} (was ${num(tightest(L, 3), 2)}); uniform smoothing at σ = 1.2 gives ${num(tightest(smoothLine(L, 1.2), 3), 2)}`);

  // the fixes: a straight with a 2 mm notch, R = 3
  const notch = { pts: [0, 0, 24, 0, 25, 2, 26, 0, 50, 0], kind: 'edge' };
  const base = fitLine([notch], { minRadius: 3, tol: 0.3, fix: 'none' });
  check('the notch is tight unfixed', base.tight.length > 0, `${base.tight.length} tight`);
  for (const fix of ['merge', 'remove', 'optimize']) {
    const how = fix === 'optimize' ? { smoothing: 'optimize' } : { fix };
    const f = fitLine([notch], { minRadius: 3, tol: 0.3, ...how, maxStray: 3 });
    const c = continuity(f.path);
    check(`${fix}: no tight corner within a 3 mm stray (plus the 0.3 tolerance), still one tangent line`, f.tight.length === 0 && f.stray.max <= 3 + 0.3 + 0.05 && c.gap < 1e-6 && c.kink < 1e-6,
      `${f.tight.length} tight, stray ${num(f.stray.max, 2)} mm, kink ${c.kink.toExponential(1)}`);
    const g = fitLine([notch], { minRadius: 3, tol: 0.3, ...how, maxStray: 1 });
    check(`${fix}: within 1 mm it cannot, and says so`, g.tight.length > 0 && g.stray.max <= 1 + 0.3 + 0.05, `${g.tight.length} tight, stray ${num(g.stray.max, 2)} mm`);
  }

  // the FFT, and Fourier smoothing
  const N = 64, re = new Float64Array(N), im = new Float64Array(N);
  const r0 = mkRand(3), orig = Array.from({ length: N }, () => r0());
  re.set(orig);
  fft(re, im); fft(re, im, true);
  check('FFT then inverse gives the signal back', orig.every((v, i) => Math.abs(re[i] - v) < 1e-12 && Math.abs(im[i]) < 1e-12), '');
  const cre = Float64Array.from({ length: N }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / N)), cim = new Float64Array(N);
  fft(cre, cim);
  check('...a cosine of 5 cycles is all in bins 5 and 59', Math.abs(cre[5] - N / 2) < 1e-9 && Math.abs(cre[59] - N / 2) < 1e-9 && Math.abs(cre[6]) < 1e-9, '');
  // a 200 mm line with a 2 mm wiggle (amplitude 0.5) and a 200 mm bow (amplitude 5)
  const wav = [];
  for (let s = 0; s <= 200; s += 0.1) wav.push(s, 0.5 * Math.sin((2 * Math.PI * s) / 2) + 5 * Math.sin((Math.PI * s) / 200));
  const fw = fourierLine(wav, Array(wav.length / 2 - 1).fill('edge'), 10, 0);
  const n2 = fw.pts.length / 2;
  let wig = 0, bow = 0;
  for (let j = 0; j < n2; j++) {
    const x = fw.pts[2 * j], y = fw.pts[2 * j + 1];
    wig = Math.max(wig, Math.abs(y - 5 * Math.sin((Math.PI * x) / 200)));
    bow = Math.max(bow, y);
  }
  check('Fourier, λ = 10 mm: the 2 mm wiggle is gone, the 200 mm bow kept', wig < 0.05 && bow > 4.9 && bow < 5.1, `wiggle left ${num(wig, 3)} mm, bow ${num(bow, 3)} mm`);
  check('...and the ends do not move', fw.pts[0] === wav[0] && fw.pts[1] === wav[1] && fw.pts[2 * n2 - 2] === wav[wav.length - 2] && fw.pts[2 * n2 - 1] === wav[wav.length - 1], '');
  const fn = fitLine([notch], { minRadius: 3, tol: 0.3, smoothing: 'fourier', fourierScale: 15 });
  const fnc = continuity(fn.path, 1e-3);   // near-straight arcs of huge radius carry ~1e-5 rad of rounding
  check('Fourier, λ = 15 mm: the notch is no longer tight, one tangent line', fn.tight.length === 0 && fnc.gap < 1e-6 && fnc.kinks === 0, `${fn.tight.length} tight, stray ${num(fn.stray.max, 2)} mm, ${fnc.kinks} kinks, worst ${fnc.kink.toExponential(1)}`);

  // PID steering
  const radii = (path) => path.segs.filter((s) => s.k === 'A').map((s) => s.r);
  const sp = steerLine([0, 0, 60, 0], ['edge'], 3, {});
  const spEnd = sp.path.segs[sp.path.segs.length - 1];
  check('PID on a straight: a straight, ending at its end', sp.path.segs.every((s) => s.k === 'L') && Math.abs(spEnd.x - 60) < 0.5 && Math.abs(spEnd.y) < 1e-9, `${sp.path.segs.length} segs, ends at ${num(spEnd.x, 2)}, ${num(spEnd.y, 3)}`);
const capped = JSON.stringify(steerLine(notch.pts, Array(4).fill('edge'), 3, { d: 5 }).path), atCap = JSON.stringify(steerLine(notch.pts, Array(4).fill('edge'), 3, { d: 2 }).path);  check('PID: a D above 2 steers as D 2 (the cap)', capped === atCap, '');
  const pn = fitLine([notch], { minRadius: 3, tol: 0.3, smoothing: 'pid', pid: { look: 6 } });
  const pnc = continuity(pn.path, 1e-6);
  check('PID over the notch: no arc tighter than 3 mm, tangent throughout, nothing tight', radii(pn.path).every((r) => r >= 3 - 1e-9) && pnc.kinks === 0 && pn.tight.length === 0,
    `tightest ${num(Math.min(...radii(pn.path)), 2)} mm, stray ${num(pn.stray.max, 2)} mm`);
  // a dead end: 40 mm out and straight back
  const hp = steerLine([0, 0, 40, 0, 0, 0.001], ['edge', 'retrace'], 3, { look: 6 });
  const hpEnd = hp.path.segs[hp.path.segs.length - 1];
  check('PID at a dead end: loops round at the radius and comes back to the end', radii(hp.path).every((r) => r >= 3 - 1e-9) && Math.hypot(hpEnd.x, hpEnd.y) < 1, `ends ${num(Math.hypot(hpEnd.x, hpEnd.y), 2)} mm from the end, ${hp.steps} steps`);

  // Dubins joins: a stroke, a 2 mm sideways join (two 3 mm fillets need 6), a stroke back
  const runs = [{ pts: [0, 0, 20, 0], kind: 'edge' }, { pts: [20, 0, 20, 2], kind: 'join' }, { pts: [20, 2, 0, 2], kind: 'edge' }];
  const plain = fitLine(runs, { minRadius: 3, tol: 0.3, joins: 'straight' });
  const dj = fitLine(runs, { minRadius: 3, tol: 0.3, joins: 'dubins' });
  const cd = continuity(dj.path);
  check('a hairpin join: tight as a straight, none as a Dubins path', plain.tight.length > 0 && dj.tight.length === 0 && cd.kink < 1e-6 && cd.gap < 1e-6,
    `${plain.tight.length} → ${dj.tight.length} tight, kink ${cd.kink.toExponential(1)}`);
  check('...the join\'s arcs are at the radius', dj.path.segs.filter((s) => s.kind === 'join' && s.k === 'A').every((s) => Math.abs(s.r - 3) < 1e-9), '');
  const ms = measureStray([0, 0, 10, 0], ['edge'], { x0: 0, y0: 1, segs: [{ k: 'L', x: 10, y: 1 }] });
  check('stray: a line 1 mm off reads 1 mm', Math.abs(ms.max - 1) < 1e-9 && Math.abs(ms.mean - 1) < 1e-9, `${ms.max}`);
}
