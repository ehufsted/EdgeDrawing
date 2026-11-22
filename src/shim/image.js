// MATLAB image-toolbox shims (copied from HalftoneCuttable): only the ones the
// Style filters use. Images are {w, h, data} with data a Float32Array,
// row-major.

export function makeImage(w, h, fill = 0) {
  const data = new Float32Array(w * h);
  if (fill !== 0) data.fill(fill);
  return { w, h, data };
}

function cloneImage(im) {
  return { w: im.w, h: im.h, data: Float32Array.from(im.data) };
}

/**
 * imresize. Area-average on an axis that SHRINKS (which is what keeps tone
 * correct -- MATLAB's default bicubic+antialiasing does the same job), bilinear
 * on one that grows. Deliberate deviation from bicubic: area averaging is the
 * right filter for the verification render's downsample.
 *
 * A mixed resize is split into a pure shrink followed by a pure grow. The
 * area-averaging branch only fires when both axes shrink, so without the split
 * an axis that shrinks alongside one that grows would be point-sampled, throwing
 * away exactly the tone the area average exists to preserve. Both
 * single-direction cases stay byte-identical: the pass along the unchanged axis
 * has a box weight of exactly 1 in the first and an interpolation weight of
 * exactly 0 in the second.
 */
export function resize(im, newW, newH) {
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));
  if (newW === im.w && newH === im.h) return cloneImage(im);
  const sx = im.w / newW;
  const sy = im.h / newH;

  // Strict on both sides. An axis with a scale of exactly 1 is unchanged and
  // must not trigger the split, or `sx === 1, sy < 1` recurses into a first pass
  // that changes nothing, hits the identity short-circuit, and arrives back here
  // forever. It falls through to the bilinear branch instead, where an unchanged
  // axis interpolates with a weight of exactly 0.
  if ((sx > 1 && sy < 1) || (sx < 1 && sy > 1)) {
    // the shrinking axis goes first, so the average is taken over the original
    // samples rather than over interpolated ones
    return sx > 1
      ? resize(resize(im, newW, im.h), newW, newH)
      : resize(resize(im, im.w, newH), newW, newH);
  }

  const out = makeImage(newW, newH);

  if (sx >= 1 && sy >= 1) {
    // shrink: box average over the source footprint of each destination pixel
    for (let y = 0; y < newH; y++) {
      const y0 = y * sy, y1 = (y + 1) * sy;
      const iy0 = Math.floor(y0), iy1 = Math.min(im.h, Math.ceil(y1));
      for (let x = 0; x < newW; x++) {
        const x0 = x * sx, x1 = (x + 1) * sx;
        const ix0 = Math.floor(x0), ix1 = Math.min(im.w, Math.ceil(x1));
        let sum = 0, wsum = 0;
        for (let iy = iy0; iy < iy1; iy++) {
          const wy = Math.min(iy + 1, y1) - Math.max(iy, y0);
          if (wy <= 0) continue;
          for (let ix = ix0; ix < ix1; ix++) {
            const wx = Math.min(ix + 1, x1) - Math.max(ix, x0);
            if (wx <= 0) continue;
            const wgt = wx * wy;
            sum += im.data[iy * im.w + ix] * wgt;
            wsum += wgt;
          }
        }
        out.data[y * newW + x] = wsum > 0 ? sum / wsum : 0;
      }
    }
  } else {
    // grow: bilinear
    for (let y = 0; y < newH; y++) {
      const fy = Math.min(im.h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const iy = Math.floor(fy), ty = fy - iy;
      const iy2 = Math.min(im.h - 1, iy + 1);
      for (let x = 0; x < newW; x++) {
        const fx = Math.min(im.w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const ix = Math.floor(fx), tx = fx - ix;
        const ix2 = Math.min(im.w - 1, ix + 1);
        const a = im.data[iy * im.w + ix], b = im.data[iy * im.w + ix2];
        const c = im.data[iy2 * im.w + ix], d = im.data[iy2 * im.w + ix2];
        out.data[y * newW + x] =
          a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
      }
    }
  }
  return out;
}

/** fspecial('gaussian', hsize, sigma), separable 1-D half. Forced odd length. */
export function gaussianKernel(hsize, sigma) {
  let n = Math.max(1, Math.round(hsize));
  if (n % 2 === 0) n += 1;
  const r = (n - 1) / 2;
  const k = new Float64Array(n);
  let sum = 0;
  const s2 = 2 * Math.max(1e-6, sigma) * Math.max(1e-6, sigma);
  for (let i = 0; i < n; i++) {
    const d = i - r;
    k[i] = Math.exp(-(d * d) / s2);
    sum += k[i];
  }
  for (let i = 0; i < n; i++) k[i] /= sum;
  return k;
}

/**
 * imfilter(im, f, 'replicate') for a separable kernel.
 *
 * Each pass is split into edges and interior: only the first and last `r` samples
 * along an axis can fall outside it, so the interior run drops the clamp rather
 * than paying two comparisons per multiply over the whole raster. Accumulation
 * order is unchanged (-r..+r into one running sum) and the result is
 * bit-identical, which matters because `prepare`'s pre-smooth feeds every
 * measured constant in the project.
 */
export function imfilterSeparable(im, kernel) {
  const r = (kernel.length - 1) / 2;
  const { w, h, data } = im;
  const tmp = makeImage(w, h);
  const out = makeImage(w, h);

  const xEdge = Math.min(r, w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x < xEdge || x >= w - r) {
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          s += data[row + xx] * kernel[i + r];
        }
      } else {
        for (let i = -r; i <= r; i++) s += data[row + x + i] * kernel[i + r];
      }
      tmp.data[row + x] = s;
    }
  }

  const yEdge = Math.min(r, h);
  for (let y = 0; y < h; y++) {
    const edgeRow = y < yEdge || y >= h - r;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (edgeRow) {
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          s += tmp.data[yy * w + x] * kernel[i + r];
        }
      } else {
        for (let i = -r; i <= r; i++) s += tmp.data[(y + i) * w + x] * kernel[i + r];
      }
      out.data[y * w + x] = s;
    }
  }
  return out;
}

export function blurGaussian(im, hsize, sigma) {
  return imfilterSeparable(im, gaussianKernel(hsize, sigma));
}

