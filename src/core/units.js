// Settings, units, canvas presets, and where the image lies on the canvas.
//
// EVERYTHING INSIDE IS MILLIMETERS. Inches exist only at the app's edges: the
// fields a person types into and the numbers shown back. `toMm` / `fromMm` are
// the only conversions, so a design made in inches is the same design as one made
// in the equivalent millimeters (the harness checks it).
//
// THE IMAGE ON THE CANVAS. The canvas is widthMm wide. Its height is the image's
// aspect at that width, unless heightMm is given, in which case the image is
// scaled to COVER the canvas and centred (the parts outside are cropped, never
// stretched). `imageRect` says where the whole image lies, in mm, and may reach
// past the canvas on two sides. (Copied from Photo2Mosaic's pieceGeometry.)

import { toLinear, toEncoded, luminance } from './color.js';

export const MM_PER_IN = 25.4;
export const toMm = (v, units) => (units === 'in' ? v * MM_PER_IN : v);
export const fromMm = (v, units) => (units === 'in' ? v / MM_PER_IN : v);

/** A length for a note: '20 mm' or '0.787 in'. */
export const lenText = (mm, units) => (units === 'in'
  ? `${Math.round((mm / MM_PER_IN) * 1000) / 1000} in`
  : `${Math.round(mm * 100) / 100} mm`);

/** A length as a bare number in the units, for a field. */
export const fmtLen = (mm, units, dp = 2) => {
  const v = fromMm(mm, units);
  return String(Math.round(v * 10 ** dp) / 10 ** dp);
};

/**
 * Common sizes for a framed line drawing, long side by short side, mm. The app
 * turns a preset to the image's orientation.
 */
export const PRESETS = [
  { id: 'a5', label: 'A5', long: 210, short: 148 },
  { id: 'a4', label: 'A4', long: 297, short: 210 },
  { id: '8x10', label: '8 × 10 in', long: 254, short: 203.2 },
  { id: 'a3', label: 'A3', long: 420, short: 297 },
  { id: '11x14', label: '11 × 14 in', long: 355.6, short: 279.4 },
  { id: '16x20', label: '16 × 20 in', long: 508, short: 406.4 },
];

/** Working resolution: the long side of the work raster, px. */
export const PRECISION = { rough: 700, draft: 1000, normal: 1600, fine: 2400 };

/**
 * The steering's D gain is held to this (the user's cap). The stray grows with
 * D: measured with a 3 mm bend, mean 0.9 to 1.25 mm at D 0 to 1, 2.8 to 4.3 mm
 * at D 2; with the 1 mm cap a pen had, D 2 lost the line altogether.
 */
export const PID_D_MAX = 2;

export const DEFAULTS = {
  widthMm: 300,
  heightMm: 0,           // 0 = from the image's aspect
  units: 'mm',           // only for the lengths in notes; every number here is mm
  precision: 'normal',
  gamma: 1,
  brightness: 1,
  saturation: 1,
  // the Style chain (core/style.js); null = its default (Painterly on)
  style: null,
  // finding the edges (core/edges.js)
  edgeScale: 1,          // mm, the Gaussian the gradient is taken at: larger finds broader, calmer edges
  edgeAmount: 0.25,      // the share of edge candidates kept as strong edges (more = more lines)
  // the level of detail (core/graph.js)
  minFeature: 2,         // mm: junctions closer than this merge, lines are smoothed at about half of it
  minLength: 8,          // mm: shorter lines, spurs and loose pieces are dropped
  simplify: 0.3,         // mm: how far the simplified line may stray from the traced one
  // joining it into one line (core/route.js)
  join: 'euler',         // 'euler': trace every edge, retracing or adding lines where needed | 'tsp': order the strokes, jump between them
  oddJoin: 'shorter',    // euler: odd ends joined by 'retrace' (along existing lines) | 'new' (straight new lines) | 'shorter' (whichever is)
  start: null,           // {x, y} mm, where the line should start; null = automatic
  closed: false,         // end where it started
  // the line itself (core/arcs.js)
  lineWidth: 1.2,        // mm, the wire's thickness (or the pen's line)
  minRadius: 3,          // mm, the tightest bend allowed (wire cannot bend tighter than a few times its thickness)
  loops: false,          // a corner too sharp to bend becomes a small loop
  // smoothing the line (core/bends.js)
  smoothing: 'pid',      // the whole line: 'pid' (steered, never tighter than the bend) | 'fourier' | 'optimize' (relax) | 'none'
  pidLook: 4,            // mm, pid: how far ahead on the traced line the steering aims
  pidP: 1, pidD: 1,      // pid: the steering's gains, proportional and derivative (P = 2 would be pure pursuit); D at most PID_D_MAX
  fourierScale: 12,      // mm, fourier: wiggles shorter than this are smoothed out (half of one this long kept)
  maxStray: 3,           // mm, how far relax (and merge or remove) may move the line off the traced edges
  bendTol: 0.5,          // mm: the finished line refitted as the fewest arcs within this of it (core/refit.js); 0 = as fitted
  // experimental (the Experimental smoothing tab)
  joinShape: 'straight', // 'straight' | 'dubins': joins as the shortest paths no tighter than the bend
  walk: 'step',          // euler: 'step' (straightest way on, step by step) | 'pairs' (straightest pairing at every node)
  bendFix: 'none',       // tight corners after the fit: 'none' (reported) | 'merge' | 'remove' (not with pid)
  bendSmooth: 'uniform', // with a bend: 'uniform' (smoothed at two radii) | 'tight' (only where tighter than the bend)
};

/**
 * The canvas size and the image's place on it.
 * @param {{width:number, height:number}} img
 * @returns {{W:number, H:number, imageRect:{x,y,w,h}}}
 */
export function pieceGeometry(img, s) {
  const W = s.widthMm;
  const auto = !(s.heightMm > 0);
  const H = auto ? (W * img.height) / img.width : s.heightMm;
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale, h = img.height * scale;
  return { W, H, imageRect: { x: (W - w) / 2, y: (H - h) / 2, w, h } };
}

/**
 * Gamma, brightness and saturation, applied to the RAW pixels before anything
 * else, so the edges and the Source view both see the result.
 * Copied from Photo2Mosaic (from HalftoneCuttable): gamma is a darkness curve on
 * the encoded value, brightness a multiplier in linear light, saturation a move
 * toward or away from the pixel's own luminance. Returns `rgba` itself at the
 * defaults.
 */
export function applyTone(rgba, gamma = 1, brightness = 1, saturation = 1) {
  if (gamma === 1 && brightness === 1 && saturation === 1) return rgba;
  const { width: w, height: h, data } = rgba;
  const n = w * h;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = toLinear(1 - Math.pow(1 - i / 255, gamma));
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    let r = lut[data[q]], g = lut[data[q + 1]], b = lut[data[q + 2]];
    if (saturation !== 1) {
      const y = luminance(r, g, b);
      r = y + saturation * (r - y); g = y + saturation * (g - y); b = y + saturation * (b - y);
    }
    out[q] = 255 * toEncoded(clamp(r * brightness));
    out[q + 1] = 255 * toEncoded(clamp(g * brightness));
    out[q + 2] = 255 * toEncoded(clamp(b * brightness));
    out[q + 3] = data[q + 3];
  }
  return { width: w, height: h, data: out };
}
