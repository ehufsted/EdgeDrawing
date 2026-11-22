// Copied from HalftoneCuttable's core/steer.js (the Kuwahara pre-filter): only
// orientationField, the direction field the Kuwahara filter is stretched along.
//
// orientationField: which way the image runs at each point, and how sure we are.
//   The structure tensor (gradient outer product, smoothed), as in the pen-plotter
//   app's spine/field.js structureTensorField. Directions are handled as DOUBLED
//   angles throughout: a line has no front or back, so averaging raw directions
//   would cancel opposite ones (that app found this bug six times in its sources).
//   Coherence alone is scale-free -- a nearly flat patch with a faint bias reads
//   as fully coherent -- so strength is also gated on the tensor's energy, relative
//   to the image's own 90th percentile: nothing below 2% of it, full strength from
//   a fifth of it up. (Gated on the median, a smooth ramp -- every pixel AT the
//   median -- got half strength everywhere, and the worms barely leaned.)

import { makeImage } from '../shim/image.js';
import { blur, centralGradient } from './features.js';

/**
 * @param {{w,h,data}} im   encoded luminance
 * @param {number} sigmaT    smoothing of the tensor, px: the scale directions are judged at
 * @param {'edges'|'gradient'} along  run along the edges (across the gradient) or along it
 * @returns {{ux:Float32Array, uy:Float32Array, strength:Float32Array}} unit direction and [0,1] strength
 */
export function orientationField(im, sigmaT, along = 'edges') {
  const { w, h } = im;
  const { ux: gx, uy: gy } = centralGradient(blur(im, 1).data, w, h);
  const j11 = makeImage(w, h), j12 = makeImage(w, h), j22 = makeImage(w, h);
  for (let i = 0; i < w * h; i++) {
    j11.data[i] = gx[i] * gx[i]; j12.data[i] = gx[i] * gy[i]; j22.data[i] = gy[i] * gy[i];
  }
  const a = blur(j11, sigmaT).data, b = blur(j12, sigmaT).data, c = blur(j22, sigmaT).data;
  const n = w * h;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = a[i] + c[i];
  // exact, by sorting, not features.quantile: the energy is heavy-tailed, and
  // that histogram's bins span [0, max], so at the 90th percentile one bin can
  // be as wide as the value itself
  const sorted = Float32Array.from(energy).sort();
  const ref = sorted[Math.floor(0.9 * (n - 1))] || 1e-12;
  const ux = new Float32Array(n), uy = new Float32Array(n), strength = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // doubled-angle vector (t11 - t22, 2 t12) points along the gradient
    const dx = a[i] - c[i], dy = 2 * b[i];
    const mag = Math.hypot(dx, dy);
    let th = 0.5 * Math.atan2(dy, dx);                  // gradient direction
    if (along === 'edges') th += Math.PI / 2;           // along the edge instead
    ux[i] = Math.cos(th); uy[i] = Math.sin(th);
    const coherence = energy[i] > 0 ? mag / energy[i] : 0;
    const gate = Math.max(0, Math.min(1, (energy[i] / ref - 0.02) / 0.18));
    strength[i] = coherence * gate;
  }
  return { ux, uy, strength };
}
