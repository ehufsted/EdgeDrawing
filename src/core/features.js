// Copied from HalftoneCuttable's core/features.js: only the blur (used by the
// edges, the Style filters and the direction field) and the gradient core/steer.js
// needs. The rest of that file (edge points, region labels for the Voronoi web)
// is not used here.

import { blurGaussian } from '../shim/image.js';

export function blur(im, sigma) {
  if (!(sigma > 0.3)) return im;
  return blurGaussian(im, 2 * Math.ceil(2.5 * sigma) + 1, sigma);
}

/** Central-difference gradient of a w×h field, clamped (Neumann) edges. */
export function centralGradient(u, w, h) {
  const ux = new Float64Array(w * h), uy = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : 0, yd = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      ux[y * w + x] = (u[y * w + xr] - u[y * w + xl]) / 2;
      uy[y * w + x] = (u[yd * w + x] - u[yu * w + x]) / 2;
    }
  }
  return { ux, uy };
}
