// A project file: everything needed to make the same drawing again.
//
//   { app: 'EdgeDrawing', version, savedAt,
//     image: { kind: 'sample', name } | { kind: 'file', name, dataURL },
//     units, settings: {...units.DEFAULTS, style (core/style.js)},
//     display: {ink, paper, ticks, bendNums, tickMm, markSize} }
//
// THE PLAN IS NOT SAVED. It is deterministic (no randomness, and the 2-opt
// works to a fixed budget, not a clock), so the same image and settings
// rebuild it exactly. The IMAGE is the original file's bytes (a data URL), not
// re-encoded pixels, so a lossy re-encode cannot move an edge. A sample is saved
// by name. (As PaintByNumbers'.)
//
// Loading is untrusted input: every field is checked, anything unusable is
// replaced by its default with a reason, and only a file that is not a project
// at all, or is from a newer version, is refused.

import { normalizeHex } from './color.js';
import { DEFAULTS, PRECISION, PID_D_MAX } from './units.js';
import { normalizeStyle } from './style.js';

export const PROJECT_VERSION = 1;
export const APP = 'EdgeDrawing';

/** The numeric settings and their valid ranges. */
const NUMS = {
  widthMm: (x) => x > 0, heightMm: (x) => x >= 0, gamma: (x) => x > 0, brightness: (x) => x > 0,
  saturation: (x) => x >= 0, edgeScale: (x) => x > 0, edgeAmount: (x) => x > 0 && x <= 1,
  minFeature: (x) => x >= 0, minLength: (x) => x >= 0, simplify: (x) => x >= 0,
  lineWidth: (x) => x >= 0, minRadius: (x) => x >= 0, maxStray: (x) => x >= 0,
  fourierScale: (x) => x > 0, pidLook: (x) => x > 0, bendTol: (x) => x >= 0, pidP: (x) => x >= 0, pidD: (x) => x >= 0 && x <= PID_D_MAX,
};
/** The settings that are one of a few words. */
const ENUMS = {
  join: ['euler', 'tsp'], oddJoin: ['retrace', 'new', 'shorter'],
  joinShape: ['straight', 'dubins'], walk: ['step', 'pairs'], smoothing: ['pid', 'fourier', 'optimize', 'none'], bendFix: ['none', 'merge', 'remove'], bendSmooth: ['uniform', 'tight'],
};
const BOOLS = ['closed', 'loops'];

// ticks, bendNums: show the distance ticks, the numbered bends (core/marks.js) on the preview; tickMm: tick spacing; markSize: label size, mm
export const DISPLAY = { ink: '#1a1a1a', paper: '#ffffff', ticks: false, bendNums: false, tickMm: 100, markSize: 2.5 };

/** The project as JSON text. `p` is the shape above (savedAt is filled in). */
export function projectJSON(p) {
  return JSON.stringify({ app: APP, version: PROJECT_VERSION, savedAt: new Date().toISOString(), ...p }, null, 1);
}

/**
 * @param {string|object} json
 * @returns {{project: {image, units, settings, display}, problems: string[]}}
 */
export function parseProject(json) {
  let o = json;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch (e) { throw new Error(`not JSON: ${e.message}`); }
  }
  if (!o || typeof o !== 'object' || o.app !== APP) throw new Error('not an EdgeDrawing project');
  if (!(o.version >= 1)) throw new Error('not an EdgeDrawing project (no version)');
  if (o.version > PROJECT_VERSION) throw new Error(`made by a newer version of the app (project version ${o.version}, this app reads up to ${PROJECT_VERSION})`);
  const problems = [];

  let image = null;
  const im = o.image || {};
  if (im.kind === 'sample' && typeof im.name === 'string') image = { kind: 'sample', name: im.name };
  else if (im.kind === 'file' && typeof im.dataURL === 'string' && /^data:image\//.test(im.dataURL)) image = { kind: 'file', name: String(im.name || 'image'), dataURL: im.dataURL };
  else problems.push('no usable image in the project');

  const src = o.settings && typeof o.settings === 'object' ? { ...o.settings } : {};
  // saved while the line smoothings were tight-corner fixes: they are the smoothing now
  if (['pid', 'fourier', 'optimize'].includes(src.bendFix) && src.smoothing === undefined) { src.smoothing = src.bendFix; src.bendFix = 'none'; }
  const settings = { ...DEFAULTS };
  for (const [k, ok] of Object.entries(NUMS)) {
    if (src[k] === undefined) continue;
    const x = Number(src[k]);
    if (src[k] !== null && isFinite(x) && ok(x)) settings[k] = x;
    else problems.push(`${k}: unusable, using ${DEFAULTS[k]}`);
  }
  for (const [k, list] of Object.entries(ENUMS)) {
    if (src[k] === undefined) continue;
    if (list.includes(src[k])) settings[k] = src[k];
    else problems.push(`${k}: unusable, using ${DEFAULTS[k]}`);
  }
  for (const k of BOOLS) if (typeof src[k] === 'boolean') settings[k] = src[k];
  const st = src.start;
  settings.start = st && isFinite(Number(st.x)) && isFinite(Number(st.y)) ? { x: Number(st.x), y: Number(st.y) } : null;
  const ns = normalizeStyle(src.style);
  settings.style = ns.style;
  problems.push(...ns.problems);
  settings.precision = PRECISION[src.precision] ? src.precision : DEFAULTS.precision;

  const d = o.display && typeof o.display === 'object' ? o.display : {};
  const pos = (v, def) => (isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
  const display = {
    ink: normalizeHex(d.ink) || DISPLAY.ink, paper: normalizeHex(d.paper) || DISPLAY.paper,
    // one 'marks' switch, from before the two were separate, sets both
    ticks: typeof d.ticks === 'boolean' ? d.ticks : typeof d.marks === 'boolean' ? d.marks : DISPLAY.ticks,
    bendNums: typeof d.bendNums === 'boolean' ? d.bendNums : typeof d.marks === 'boolean' ? d.marks : DISPLAY.bendNums,
    tickMm: pos(d.tickMm, DISPLAY.tickMm), markSize: pos(d.markSize, DISPLAY.markSize),
  };
  return { project: { image, units: o.units === 'in' ? 'in' : 'mm', settings, display }, problems };
}
