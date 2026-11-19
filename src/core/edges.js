// The edges: where the line should go, as a one-pixel-wide map on the work grid.
//
// CANNY (1986), in four steps on the image's encoded luminance:
//   1. a Gaussian blur at the edge scale (set in mm, so an edge is found at the
//      same size on the canvas at any precision), then the Sobel gradient;
//   2. non-maximum suppression: a pixel stays only where the gradient is a peak
//      across the edge (compared with its two neighbours along the gradient,
//      the direction rounded to 45°), so a soft edge becomes a thin ridge;
//   3. hysteresis: the strongest `amount` of those peaks start lines, and a line
//      continues through any 8-connected peak at least LOW_RATIO as strong, so
//      an edge that fades a little is not broken into dashes;
//   4. thinning (Zhang & Suen 1984), so every line is one pixel wide and the
//      edge graph (core/graph.js) sees each pixel as a chain or a junction.
//
// STRENGTHS ARE CONTRASTS. A step of contrast c, blurred by σ, has a gradient
// peak of c / (√(2π) σ); multiplied back by √(2π) σ, the peak reads as the step's
// own contrast (0..1 of luminance) whatever the scale. So the floor MIN_CONTRAST
// means the same at every edge scale: an image with no edges stronger than 4%
// gets no lines, rather than its noise promoted to the top `amount`.

import { makeImage } from '../shim/image.js';
import { blur } from './features.js';

export const LOW_RATIO = 0.5;
export const MIN_CONTRAST = 0.04;

/**
 * @param {Float32Array} lum   encoded luminance in [0, 1], w×h
 * @param {number} sigmaPx     the edge scale, px
 * @param {number} amount      the share (0..1) of suppressed peaks that start lines
 * @returns {{edge:Uint8Array, strength:Float32Array, high:number}}
 *   edge: 1 on a line; strength: each line pixel's contrast; high: the start threshold
 */
export function cannyEdges(lum, w, h, sigmaPx, amount) {
  const im = makeImage(w, h);
  im.data.set(lum);
  const g = blur(im, sigmaPx).data;
  const n = w * h;
  const mag = new Float32Array(n), dir = new Uint8Array(n);
  const k = Math.sqrt(2 * Math.PI) * Math.max(0.5, sigmaPx) / 8;   // Sobel weighs the slope by 8
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      const gx = c + 2 * f + r - a - 2 * d - p;
      const gy = p + 2 * q + r - a - 2 * b - c;
      mag[i] = Math.hypot(gx, gy) * k;
      // the gradient's direction, to the nearest 45° (0: across x, 1: diagonal \, 2: across y, 3: diagonal /)
      let t = Math.atan2(gy, gx);
      if (t < 0) t += Math.PI;
      dir[i] = Math.round(t / (Math.PI / 4)) % 4;
    }
  }
  // 2. non-maximum suppression
  const OFF = [1, w + 1, w, w - 1];
  const peak = new Float32Array(n);
  const cand = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x, m = mag[i];
      if (m < MIN_CONTRAST * LOW_RATIO) continue;
      const o = OFF[dir[i]];
      // ties broken one way only, so a flat-topped ridge keeps one pixel, not two
      if (m > mag[i - o] && m >= mag[i + o]) { peak[i] = m; cand.push(m); }
    }
  }
  if (!cand.length) return { edge: new Uint8Array(n), strength: new Float32Array(n), high: Infinity };
  // 3. hysteresis
  const sorted = Float32Array.from(cand).sort();
  const qi = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - amount) * sorted.length)));
  const high = Math.max(MIN_CONTRAST, sorted[qi]);
  const low = LOW_RATIO * high;
  const edge = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (peak[i] >= high && !edge[i]) {
      edge[i] = 1; stack.push(i);
      while (stack.length) {
        const j = stack.pop();
        for (const o of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) {
          const t = j + o;
          if (!edge[t] && peak[t] >= low) { edge[t] = 1; stack.push(t); }
        }
      }
    }
  }
  // 4. one pixel wide
  thin(edge, w, h);
  const strength = new Float32Array(n);
  for (let i = 0; i < n; i++) if (edge[i]) strength[i] = mag[i];
  return { edge, strength, high };
}

/**
 * Zhang-Suen thinning, in place: a binary map down to 8-connected lines one
 * pixel wide, keeping its topology. Pixels on the frame are cleared first (the
 * neighbourhood test reads one pixel out).
 */
export function thin(m, w, h) {
  for (let x = 0; x < w; x++) { m[x] = 0; m[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { m[y * w] = 0; m[y * w + w - 1] = 0; }
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          // P2..P9 clockwise from north
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1];
          const p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  // staircase corners: a pixel whose two 4-neighbours make an L already
  // connect its 8-neighbours through it is redundant (Zhang-Suen leaves them)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!m[i]) continue;
      const N = m[i - w], E = m[i + 1], S = m[i + w], W = m[i - 1];
      const corner = (N && E && !S && !W && !m[i + w - 1] && !m[i + w + 1] && !m[i - w - 1]) ||
        (E && S && !N && !W && !m[i - w - 1] && !m[i - w + 1] && !m[i + w - 1]) ||
        (S && W && !N && !E && !m[i - w - 1] && !m[i - w + 1] && !m[i + w + 1]) ||
        (W && N && !S && !E && !m[i + w + 1] && !m[i + w - 1] && !m[i - w + 1]);
      if (corner) m[i] = 0;
    }
  }
  return m;
}
