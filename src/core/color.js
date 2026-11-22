// Color conversions: copied from Photo2Mosaic's core/color.js (itself from
// HalftoneCuttable's), only the ones used here.
//
// Images store gamma-encoded sRGB; averaging (the work raster's resampling) and
// the Tone controls work in linear light, where mixing is physical.

/** sRGB-encoded [0,1] -> linear [0,1]. */
export function toLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** linear [0,1] -> sRGB-encoded [0,1]. Clamps: a mix can overshoot by rounding. */
export function toEncoded(v) {
  v = Math.max(0, Math.min(1, v));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Rec. 709 luminance of a linear RGB triple. */
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A '#rrggbb' string, or null: accepts 'abc', '#abc', 'aabbcc', any case. */
export function normalizeHex(s) {
  let t = String(s || '').trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) t = t.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : null;
}

/** A 256-entry lookup for toLinear on 8-bit values, for bulk pixel conversion. */
export const LINEAR_LUT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = toLinear(i / 255);
  return t;
})();
