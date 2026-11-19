// core/edges.js: Canny finds a disc's rim, one pixel wide, and nothing on a flat image.

import { section, check, num } from './runner.js';
import { cannyEdges, thin } from '../src/core/edges.js';

function disc(w, h, cx, cy, R, inside = 0.2, outside = 0.9) {
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < R ? inside : outside;
  return lum;
}

export function run() {
  section('core.edges', 'Prediction: a dark disc of radius 50 px gives a rim of edge pixels within 1.5 px of r = 50, about 2πr of them (± 25%), never a 2×2 block (one pixel wide); a flat image and a 2% step give none (below the 4% floor).');
  const w = 160, h = 160;
  const E = cannyEdges(disc(w, h, 80, 80, 50), w, h, 1.5, 0.5);
  let n = 0, worst = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!E.edge[y * w + x]) continue;
    n++;
    worst = Math.max(worst, Math.abs(Math.hypot(x + 0.5 - 80, y + 0.5 - 80) - 50));
  }
  check('every edge pixel lies on the rim', worst <= 1.5, `farthest ${num(worst, 2)} px from r = 50`);
  const expect = 2 * Math.PI * 50;
  check('about 2πr edge pixels', n > 0.75 * expect && n < 1.25 * expect, `${n} pixels, 2πr = ${num(expect, 0)}`);
  let blocks = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    if (E.edge[i] && E.edge[i + 1] && E.edge[i + w] && E.edge[i + w + 1]) blocks++;
  }
  check('one pixel wide: no 2×2 block', blocks === 0, `${blocks} blocks`);
  check('the rim strength reads as the step\'s contrast (0.7)', E.high > 0.5 && E.high < 0.9, `start threshold ${num(E.high, 3)}`);

  const flat = cannyEdges(new Float32Array(w * h).fill(0.5), w, h, 1.5, 0.5);
  check('a flat image has no edges', flat.edge.every((v) => !v), `${flat.edge.reduce((a, b) => a + b, 0)} pixels`);
  const faint = cannyEdges(disc(w, h, 80, 80, 50, 0.5, 0.52), w, h, 1.5, 0.5);
  check('a 2% step is below the floor', faint.edge.every((v) => !v), `${faint.edge.reduce((a, b) => a + b, 0)} pixels`);

  // thinning a thick bar leaves a one-pixel line along its middle
  const m = new Uint8Array(40 * 20);
  for (let y = 7; y < 13; y++) for (let x = 5; x < 35; x++) m[y * 40 + x] = 1;
  thin(m, 40, 20);
  let rows = new Set(), count = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) if (m[y * 40 + x]) { rows.add(y); count++; }
  check('thinning a 6 px bar leaves one line near its middle', count > 20 && [...rows].every((y) => y >= 8 && y <= 11), `${count} pixels on rows ${[...rows].join(', ')}`);
}
