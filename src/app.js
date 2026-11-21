// UI wiring. Compute happens in worker.js; this module gathers settings, paints
// the plan and exports it. The only file that knows what a DOM is (plus
// svg.js's download helper).
//
// LENGTHS ARE HELD IN mm. Every length field (class "len") shows its value in
// the chosen units, and `state.s` keeps the millimeters; switching units only
// rewrites what the fields display.
//
// THE PREVIEW IS DRAWN FROM THE PLAN, not from pixels the worker made: the plan
// is geometry in mm, so every view is crisp at any zoom, and what is on screen
// is what the SVG and the printout carry. The line's colours are display only
// and never re-run the worker; its width is drawn true to size.

import { DEFAULTS, PRESETS, PID_D_MAX, toMm, pieceGeometry, applyTone } from './core/units.js';
import { normalizeHex } from './core/color.js';
import { drawingSVG, downloadFile, arrowAt } from './core/svg.js';
import { planHTML, PAPERS, pageWindows, printable, fmtLen, longText } from './core/printout.js';
import { projectJSON, parseProject, DISPLAY } from './core/project.js';
import { filterById, defaultStyle } from './core/style.js';
import { trimPath } from './core/arcs.js';
import { layoutMarks, bendList, bendText, bendCSV, alongText, MIN_BEND } from './core/marks.js';
import { generateSample } from './app/samples.js';

const $ = (id) => document.getElementById(id);
const STORE = 'edgedrawing.v1';

const LEN_IDS = ['widthMm', 'heightMm', 'edgeScale', 'minFeature', 'minLength', 'simplify', 'lineWidth', 'minRadius', 'maxStray', 'fourierScale', 'pidLook', 'bendTol'];
const DISP_LEN_IDS = ['tickMm', 'markSize'];   // display lengths (state.disp): the making marks
const GAIN_IDS = ['pidP', 'pidD'];   // the steering's gains: plain numbers
const BEND_IDS = ['smoothing', 'joinShape', 'walk', 'bendFix', 'bendSmooth'];   // the smoothing selects

/** The Edges & detail presets, mm (edgeAmount a share). */
const DETAIL = {
  fine: { edgeScale: 0.7, edgeAmount: 0.35, minFeature: 1.2, minLength: 5, simplify: 0.2 },
  medium: { edgeScale: 1, edgeAmount: 0.25, minFeature: 2, minLength: 8, simplify: 0.3 },
  coarse: { edgeScale: 1.6, edgeAmount: 0.18, minFeature: 3.5, minLength: 14, simplify: 0.5 },
};

/** What the line is doing, as the Route view colours it. */
const KIND = { edge: '#1a1a1a', retrace: '#e08a00', join: '#2a6fdb' };

const freshSettings = () => ({ ...DEFAULTS, start: null, style: defaultStyle() });

const state = {
  rgba: null,           // {width, height, data} as loaded
  imageName: 'drawing',
  imageSrc: null,       // for projects: {kind:'sample', name} | {kind:'file', name, dataURL}
  imageKey: 0,          // a new number per image, so the worker's cache never mixes two
  workerHas: null,      // the imageKey the worker holds
  toned: null,          // canvas of the toned image (until a run sends `styled`)
  styled: null,         // canvas of the work raster after Tone and Style; it covers the drawing exactly
  units: 'mm',
  preset: 'custom',
  s: freshSettings(),   // the pipeline's settings, mm
  disp: { ...DISPLAY },
  view: 'drawing',
  plan: null,
  picking: false,       // the next click on the preview sets the start
  anim: { t: 1, playing: false, raf: 0, last: 0 },
  jobId: 0,
  pending: false,
};
window.edgeDrawing = state;   // for driving the app from DevTools / the CDP harness

// ------------------------------------------------------------------ persistence
// Only conveniences live in localStorage: a private window or blocked storage
// just starts from the defaults.
function save() {
  try {
    // the start point belongs to one image, so it is not kept here (a project keeps it)
    localStorage.setItem(STORE, JSON.stringify({ units: state.units, preset: state.preset, s: { ...state.s, start: null }, disp: state.disp }));
  } catch { /* storage unavailable */ }
}

function restore() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { o = null; }
  if (!o) return;
  try {
    const { project } = parseProject({ app: 'EdgeDrawing', version: 1, image: null, units: o.units, settings: o.s, display: o.disp });
    state.units = project.units;
    state.s = project.settings;
    state.disp = project.display;
    if (o.preset === 'custom' || PRESETS.some((p) => p.id === o.preset)) state.preset = o.preset;
  } catch { /* keep defaults */ }
}

// ------------------------------------------------------------------ worker
let worker = null;

function spawnWorker() {
  state.workerHas = null;
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => setStatus(`worker error: ${e.message}`, 'bad');
    return w;
  } catch (err) {
    setStatus('module workers unavailable — see console', 'bad');
    console.error(err);
    return null;
  }
}
worker = spawnWorker();

/** A busy worker cannot see a stop message; terminating it is the only cancel. */
function cancelInFlight() {
  if (!worker || !state.pending) return;
  worker.terminate();
  worker = spawnWorker();
  state.pending = false;
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (msg.jobId !== state.jobId) return;
  if (msg.type === 'progress') { setStatus(msg.stage + '…'); return; }
  if (msg.type === 'error') {
    state.pending = false;
    if (msg.code === 'NO_IMAGE') { state.workerHas = null; run(); return; }
    setStatus(`error: ${msg.message}`, 'bad');
    console.error(msg.stack || msg.message);
    return;
  }
  if (msg.type === 'done') {
    state.pending = false;
    state.plan = msg.plan;
    if (msg.styled) {
      const c = document.createElement('canvas');
      c.width = msg.styled.width; c.height = msg.styled.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.styled.data), c.width, c.height), 0, 0);
      state.styled = c;
    }
    setStatus(`ready · ${(msg.ms / 1000).toFixed(1)} s`);
    paint();
    updateStats();
    renderFigures();
    renderStartNote();
  }
}

// ----------------------------------------------------------------- settings
const num = (id) => parseFloat($(id).value);

/** Catch settings the pipeline would reject, and say why here rather than as an error. */
function validate(s) {
  if (!(s.widthMm > 0)) return 'enter a width';
  if (!(s.heightMm >= 0)) return 'height must be 0 (from the image) or more';
  if (!(s.edgeScale > 0)) return 'the edge scale must be more than 0';
  if ([s.minFeature, s.minLength, s.simplify, s.lineWidth, s.minRadius, s.maxStray, s.bendTol].some((v) => !(v >= 0))) return 'lengths cannot be negative';
  if (!(s.fourierScale > 0) || !(s.pidLook > 0)) return 'the length scale and the look ahead must be more than 0';
  if (!(s.pidP >= 0) || !(s.pidD >= 0)) return 'the gains cannot be negative';
  return '';
}

function run() {
  if (!state.rgba || !worker) return;
  const s = { ...state.s, gamma: num('gamma'), brightness: num('brightness'), saturation: num('saturation') };
  state.s.gamma = s.gamma; state.s.brightness = s.brightness; state.s.saturation = s.saturation;
  updatePieceNote();
  const problem = validate(s);
  if (problem) { setStatus(problem, 'bad'); return; }
  save();
  cancelInFlight();
  if (!worker) return;
  state.jobId++;
  state.pending = true;
  setStatus('working…');
  const send = state.workerHas !== state.imageKey;
  worker.postMessage({ type: 'run', jobId: state.jobId, imageKey: state.imageKey, rgba: send ? state.rgba : undefined, settings: s });
  state.workerHas = state.imageKey;
}

let runTimer = null;
function scheduleRun(delay = 300) {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, delay);
}

// ------------------------------------------------------------------- units
const L = (mm, dp) => fmtLen(mm, state.units, dp ?? (state.units === 'in' ? 4 : 2));
const unitLabel = () => (state.units === 'in' ? 'in' : 'mm');

function showLengths() {
  for (const id of LEN_IDS) $(id).value = L(state.s[id]);
  for (const id of DISP_LEN_IDS) $(id).value = L(state.disp[id]);
  for (const el of document.querySelectorAll('.u')) el.textContent = unitLabel();
  for (const b of document.querySelectorAll('#unitSeg button')) b.setAttribute('aria-pressed', String(b.dataset.units === state.units));
  $('edgeAmount').value = state.s.edgeAmount;
  $('edgeAmountVal').textContent = `${Math.round(100 * state.s.edgeAmount)}%`;
  showDetailPreset();
}

/** Which Edges & detail preset the values match, if any. */
function showDetailPreset() {
  const at = Object.keys(DETAIL).find((k) => Object.entries(DETAIL[k]).every(([key, v]) => Math.abs(state.s[key] - v) < 1e-6));
  for (const b of document.querySelectorAll('#detailSeg button')) b.setAttribute('aria-pressed', String(b.dataset.detail === at));
}

function bindLengths() {
  for (const id of LEN_IDS) {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value);
      if (!isFinite(v)) return;
      state.s[id] = toMm(v, state.units);
      if (id === 'widthMm' || id === 'heightMm') { state.preset = 'custom'; $('preset').value = 'custom'; }
      showDetailPreset();
      if (id === 'lineWidth') paint();
      scheduleRun();   // the line width too: it sets how close two crossings count as one
    });
  }
  $('edgeAmount').addEventListener('input', () => {
    state.s.edgeAmount = parseFloat($('edgeAmount').value);
    $('edgeAmountVal').textContent = `${Math.round(100 * state.s.edgeAmount)}%`;
    showDetailPreset();
    scheduleRun();
  });
  for (const b of document.querySelectorAll('#unitSeg button')) {
    b.addEventListener('click', () => {
      state.units = b.dataset.units;
      showLengths();
      buildStyleUI();
      updatePieceNote();
      updateStats();
      renderFigures();
      renderStartNote();
      save();
    });
  }
  for (const b of document.querySelectorAll('#detailSeg button')) {
    b.addEventListener('click', () => {
      Object.assign(state.s, DETAIL[b.dataset.detail]);
      showLengths();
      scheduleRun(0);
    });
  }
  $('precision').addEventListener('change', () => { state.s.precision = $('precision').value; scheduleRun(0); });
}

// ------------------------------------------------------------------ canvas size
function buildPresets() {
  $('preset').innerHTML = '<option value="custom">Custom</option>' + PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  $('preset').value = state.preset;
  $('preset').addEventListener('change', () => {
    state.preset = $('preset').value;
    applyPreset();
    showLengths();
    scheduleRun(0);
  });
}

/** Set the size to the preset, turned to the image's orientation. */
function applyPreset() {
  const p = PRESETS.find((q) => q.id === state.preset);
  if (!p) return;
  const landscape = state.rgba ? state.rgba.width >= state.rgba.height : false;
  state.s.widthMm = landscape ? p.long : p.short;
  state.s.heightMm = landscape ? p.short : p.long;
}

function updatePieceNote() {
  if (!state.rgba) return;
  const geo = pieceGeometry(state.rgba, state.s);
  const other = state.units === 'in' ? 'mm' : 'in';
  $('pieceNote').innerHTML = `drawing <b>${fmtLen(geo.W, state.units, 1)} × ${fmtLen(geo.H, state.units, 1)} ${unitLabel()}</b> ` +
    `(${fmtLen(geo.W, other, 1)} × ${fmtLen(geo.H, other, 1)} ${other})` +
    (state.s.heightMm > 0 ? ' · image cropped to cover' : '');
}

// ------------------------------------------------------------------ the line
function showJoin() {
  for (const b of document.querySelectorAll('#joinSeg button')) b.setAttribute('aria-pressed', String(b.dataset.join === state.s.join));
  $('oddRow').hidden = state.s.join !== 'euler';
  $('walkRow').hidden = state.s.join !== 'euler';
  for (const id of BEND_IDS) $(id).value = state.s[id];
  for (const id of GAIN_IDS) $(id).value = state.s[id];
  showBendRows();
  $('oddJoin').value = state.s.oddJoin;
  $('closed').checked = state.s.closed;
}

function showLine() {
  $('loops').checked = state.s.loops;
}

function renderStartNote() {
  const st = state.s.start, plan = state.plan;
  let t = st ? `Starts near ${L(st.x, 1)}, ${L(st.y, 1)} ${unitLabel()} (from the top left).` : 'Starts at the loose end nearest the top-left corner.';
  if (plan && plan.end) t += ` Ends at ${L(plan.end.x, 1)}, ${L(plan.end.y, 1)}.`;
  if (state.picking) t = 'Click on the preview where the line should start (Esc to cancel).';
  $('startNote').textContent = t;
  $('startPick').classList.toggle('picking', state.picking);
}

function setPicking(on) {
  state.picking = on;
  $('view').style.cursor = on ? 'copy' : 'crosshair';
  renderStartNote();
}

function bindLine() {
  for (const b of document.querySelectorAll('#joinSeg button')) {
    b.addEventListener('click', () => { state.s.join = b.dataset.join; showJoin(); scheduleRun(0); });
  }
  $('oddJoin').addEventListener('change', () => { state.s.oddJoin = $('oddJoin').value; scheduleRun(0); });
  $('closed').addEventListener('change', () => { state.s.closed = $('closed').checked; scheduleRun(0); });
  $('startAuto').addEventListener('click', () => { setPicking(false); if (state.s.start) { state.s.start = null; scheduleRun(0); } renderStartNote(); });
  $('startPick').addEventListener('click', () => setPicking(!state.picking));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.picking) setPicking(false); });
  $('loops').addEventListener('change', () => { state.s.loops = $('loops').checked; scheduleRun(0); });
  for (const id of BEND_IDS) $(id).addEventListener('change', () => { state.s[id] = $(id).value; showBendRows(); scheduleRun(0); });
  for (const id of GAIN_IDS) {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value);
      if (!(v >= 0)) return;
      state.s[id] = id === 'pidD' ? Math.min(PID_D_MAX, v) : v;
      scheduleRun();
    });
    // a D typed above the cap shows as the cap once the field is left
    $(id).addEventListener('change', () => { $(id).value = state.s[id]; });
  }
}

/** Each smoothing's own controls, shown only with it; the stray where something uses it. */
function showBendRows() {
  const sm = state.s.smoothing;
  $('pidGroup').hidden = sm !== 'pid';
  $('fourierGroup').hidden = sm !== 'fourier';
  $('relaxNote').hidden = sm !== 'optimize';
  $('fixRow').hidden = sm === 'pid';   // steering leaves no tight corner to fix
  // the stray bounds every fitted arc too (fitArcs' maxDev), so it shows whenever the line is fitted
  $('strayRow').hidden = sm === 'pid';
}

// ------------------------------------------------------------------- paint
const MAX_BACKING = 8192;

/** Canvas sized for the view; returns the px-per-mm transform. */
function sizeCanvas(plan) {
  const canvas = $('view');
  const stage = $('stage');
  const { W, H } = plan.piece;
  const fit = Math.min((stage.clientWidth - 28) / W, (stage.clientHeight - 28) / H);
  const zoom = parseFloat($('zoom').value) || 1;
  let cssPerMm = Math.max(0.05, fit * zoom);
  const dpr = window.devicePixelRatio || 1;
  let k = cssPerMm * dpr;
  if (Math.max(W, H) * k > MAX_BACKING) { k = MAX_BACKING / Math.max(W, H); cssPerMm = k / dpr; }
  canvas.width = Math.max(1, Math.round(W * k));
  canvas.height = Math.max(1, Math.round(H * k));
  canvas.style.width = `${Math.round(W * cssPerMm)}px`;
  canvas.style.height = `${Math.round(H * cssPerMm)}px`;
  return { k, cssPerMm };
}

/** A path's segs as a Path2D; `filter` picks segs (each run of them a subpath). */
function toPath2D(path, filter = null) {
  const p = new Path2D();
  let x = path.x0, y = path.y0, pen = false;
  for (const s of path.segs) {
    const on = !filter || filter(s);
    if (on) {
      if (!pen) p.moveTo(x, y);
      if (s.k === 'L') p.lineTo(s.x, s.y);
      else p.arc(s.cx, s.cy, s.r, s.a0, s.a0 + s.sweep, s.sweep < 0);
    }
    pen = on;
    x = s.x; y = s.y;
  }
  return p;
}

/** The plan's path cut to the animation's point (cached Path2Ds when whole). */
function shownPath(plan) {
  if (state.anim.t >= 1) return plan.path;
  return trimPath(plan.path, state.anim.t * plan.stats.length);
}

function cachedPath2D(plan, key, filter) {
  if (!plan._p2d) Object.defineProperty(plan, '_p2d', { value: {}, enumerable: false });
  if (!plan._p2d[key]) plan._p2d[key] = toPath2D(plan.path, filter);
  return plan._p2d[key];
}

function lineStyle(ctx, k, width) {
  ctx.lineWidth = Math.max(width, 0.9 / k);   // true width, but never under a device pixel
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
}

function drawPaper(ctx, plan, color = state.disp.paper) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, plan.piece.W, plan.piece.H);
}

/** The line in one colour, cut to the animation. */
function drawLine(ctx, plan, k, color) {
  ctx.strokeStyle = color;
  lineStyle(ctx, k, state.s.lineWidth);
  ctx.stroke(state.anim.t >= 1 ? cachedPath2D(plan, 'all', null) : toPath2D(shownPath(plan)));
}

/** The line coloured by kind. */
function drawRoute(ctx, plan, k) {
  const path = shownPath(plan);
  const whole = state.anim.t >= 1;
  lineStyle(ctx, k, Math.max(state.s.lineWidth, 1.6 / k));
  for (const kind of ['edge', 'retrace', 'join']) {
    ctx.strokeStyle = KIND[kind];
    ctx.stroke(whole ? cachedPath2D(plan, kind, (s) => s.kind === kind) : toPath2D(path, (s) => s.kind === kind));
  }
}

/** Start (green ring and arrow), end (red square), and while animating the pen. */
function drawMarkers(ctx, plan, k) {
  if (!plan.start) return;
  const r = Math.max(1.2, 6 / k);
  ctx.lineWidth = Math.max(0.3, 2 / k);
  ctx.strokeStyle = '#1a9e3a';
  ctx.beginPath(); ctx.arc(plan.start.x, plan.start.y, r, 0, 2 * Math.PI); ctx.stroke();
  const a = arrowAt(plan.path, Math.min(3 * r, 0.25 * plan.stats.length));
  if (a) {
    ctx.beginPath();
    ctx.moveTo(a.x - 1.6 * r * (a.ux - 0.5 * a.uy), a.y - 1.6 * r * (a.uy + 0.5 * a.ux));
    ctx.lineTo(a.x, a.y);
    ctx.lineTo(a.x - 1.6 * r * (a.ux + 0.5 * a.uy), a.y - 1.6 * r * (a.uy - 0.5 * a.ux));
    ctx.stroke();
  }
  ctx.strokeStyle = '#c0392b';
  ctx.strokeRect(plan.end.x - r, plan.end.y - r, 2 * r, 2 * r);
  if (state.anim.t < 1) {
    const p = arrowAt(plan.path, state.anim.t * plan.stats.length);
    if (p) { ctx.fillStyle = '#e0303f'; ctx.beginPath(); ctx.arc(p.x, p.y, 0.8 * r, 0, 2 * Math.PI); ctx.fill(); }
  }
}

/** The image under the drawing: after Tone and the Style chain, as its edges are found. */
function drawSource(ctx, plan) {
  const R = plan.imageRect;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.piece.W, plan.piece.H);
  if (state.styled) ctx.drawImage(state.styled, 0, 0, plan.piece.W, plan.piece.H);
  else if (state.toned) ctx.drawImage(state.toned, R.x, R.y, R.w, R.h);
}

/** The edge graph: chains, ends (orange) and junctions (blue). */
function drawEdges(ctx, plan, k) {
  drawPaper(ctx, plan, '#ffffff');
  ctx.strokeStyle = '#333333';
  lineStyle(ctx, k, 1.2 / k);
  const p = new Path2D();
  for (const e of plan.graph.edges) { p.moveTo(e[0], e[1]); for (let i = 2; i < e.length; i += 2) p.lineTo(e[i], e[i + 1]); }
  ctx.stroke(p);
  const r = Math.max(0.4, 2.2 / k);
  for (const n of plan.graph.nodes) {
    if (n.deg === 2) continue;
    ctx.fillStyle = n.deg === 1 ? '#e08a00' : '#2a6fdb';
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fill();
  }
}

function drawProblems(ctx, plan, k) {
  drawPaper(ctx, plan, '#ffffff');
  drawLine(ctx, plan, k, '#c8c8c8');
  ctx.strokeStyle = KIND.join;
  lineStyle(ctx, k, Math.max(state.s.lineWidth, 1.2 / k));
  ctx.stroke(cachedPath2D(plan, 'join', (s) => s.kind === 'join'));
  const r = Math.max(1, 5 / k);
  ctx.lineWidth = Math.max(0.3, 2 / k);
  ctx.strokeStyle = '#e0303f';
  for (const t of plan.tight) { ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.fillStyle = '#e08a00';
  for (const c of plan.crossings) { ctx.beginPath(); ctx.arc(c.x, c.y, 0.6 * r, 0, 2 * Math.PI); ctx.fill(); }
}

/** Draw a view onto a context already scaled to mm. */
function drawView(ctx, plan, view, k) {
  if (view === 'drawing') { drawPaper(ctx, plan); drawLine(ctx, plan, k, state.disp.ink); if (state.anim.t < 1) drawMarkers(ctx, plan, k); }
  else if (view === 'route') { drawPaper(ctx, plan, '#ffffff'); drawRoute(ctx, plan, k); drawMarkers(ctx, plan, k); }
  else if (view === 'overlay') {
    drawSource(ctx, plan);
    ctx.fillStyle = '#ffffff99';
    ctx.fillRect(0, 0, plan.piece.W, plan.piece.H);
    drawLine(ctx, plan, k, '#000000');
    drawMarkers(ctx, plan, k);
  } else if (view === 'edges') drawEdges(ctx, plan, k);
  else if (view === 'source') drawSource(ctx, plan);
  else if (view === 'problems') { drawProblems(ctx, plan, k); drawMarkers(ctx, plan, k); }
  if ((state.disp.ticks || state.disp.bendNums) && view !== 'edges' && view !== 'source') drawMade(ctx, plan, k);
}

/** How many bends there are to make (cached on the plan). */
function bendCount(plan) {
  if (plan._bends === undefined) Object.defineProperty(plan, '_bends', { value: bendList(plan.path).length, enumerable: false });
  return plan._bends;
}

/** The making marks (core/marks.js), laid out once per plan and settings. */
function madeLayout(plan, k) {
  const fs = Math.max(state.disp.markSize, 9 / k);   // readable on screen at any zoom
  const show = { ticks: state.disp.ticks, bends: state.disp.bendNums };
  const key = `${state.disp.tickMm}|${fs.toFixed(3)}|${state.units}|${state.s.lineWidth}|${show.ticks}|${show.bends}`;
  if (!plan._made || plan._made.key !== key) {
    Object.defineProperty(plan, '_made', { value: { key, layout: layoutMarks(plan.path, state.disp.tickMm, fs, state.s.lineWidth, state.units, show) }, enumerable: false, configurable: true, writable: true });
  }
  return plan._made.layout;
}

/** Ticks with the total length beside them, and each bend's number and turn (as the template prints them). */
function drawMade(ctx, plan, k) {
  if (state.anim.t < 1) return;
  const { ticks, bends, spots, tickSpots, fs } = madeLayout(plan, k);
  const bar = Math.max(1.2, 1.5 * state.s.lineWidth + fs * 0.4);
  ctx.save();
  ctx.strokeStyle = '#c0392b'; ctx.fillStyle = '#c0392b';
  ctx.lineWidth = Math.max(0.15, 1.5 / k);
  ctx.beginPath();
  for (const t of ticks) { ctx.moveTo(t.x + t.uy * bar, t.y - t.ux * bar); ctx.lineTo(t.x - t.uy * bar, t.y + t.ux * bar); }
  ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${0.8 * fs}px Arial, Helvetica, sans-serif`;
  ticks.forEach((t, i) => ctx.fillText(alongText(t.at, state.units), tickSpots[i].x, tickSpots[i].y));
  ctx.strokeStyle = '#1f5fbf'; ctx.fillStyle = '#1f5fbf';
  ctx.beginPath();
  bends.forEach((b, i) => {
    ctx.moveTo(b.sx + b.uy * bar, b.sy - b.ux * bar); ctx.lineTo(b.sx - b.uy * bar, b.sy + b.ux * bar);
    ctx.moveTo(spots[i].x, spots[i].y); ctx.lineTo(b.mx, b.my);
  });
  ctx.lineWidth = Math.max(0.1, 1 / k);
  ctx.stroke();
  bends.forEach((b, i) => {
    ctx.font = `bold ${fs}px Arial, Helvetica, sans-serif`;
    ctx.fillText(String(b.n), spots[i].x, spots[i].y - 0.35 * fs);
    ctx.font = `${0.7 * fs}px Arial, Helvetica, sans-serif`;
    ctx.fillText(bendText(b), spots[i].x, spots[i].y + 0.5 * fs);
  });
  ctx.restore();
}

const HINTS = {
  drawing: 'the drawing: one line, at its true width',
  route: 'black: the image\'s edges · orange: over a line again · blue: not in the image (bridges, joins, jumps) · green ring: start · red square: end',
  overlay: 'the line over the image',
  edges: 'the edges found, before joining · orange: loose ends · blue: junctions',
  source: 'the image after Tone and Style, as its edges are found',
  problems: 'red rings: corners tighter than the smallest bend · orange dots: crossings · blue: not in the image',
};

function paint() {
  const plan = state.plan;
  if (!plan) return;
  const { k } = sizeCanvas(plan);
  const ctx = $('view').getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawView(ctx, plan, state.view, k);
  $('hint').textContent = HINTS[state.view] || '';
}

function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('#viewSeg button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  paint();
}

// --------------------------------------------------------------- animation
const ANIM_MS = 8000;   // the whole line, start to end

function setProgress(t) {
  state.anim.t = Math.max(0, Math.min(1, t));
  $('progress').value = String(Math.round(1000 * state.anim.t));
  paint();
}

function stopAnim() {
  state.anim.playing = false;
  cancelAnimationFrame(state.anim.raf);
  $('play').textContent = '▶ Draw';
}

function bindAnim() {
  $('play').addEventListener('click', () => {
    if (state.anim.playing) { stopAnim(); return; }
    if (!state.plan) return;
    if (state.anim.t >= 1) state.anim.t = 0;
    state.anim.playing = true;
    state.anim.last = performance.now();
    $('play').textContent = '❚❚ Pause';
    const step = (now) => {
      if (!state.anim.playing) return;
      const t = state.anim.t + (now - state.anim.last) / ANIM_MS;
      state.anim.last = now;
      setProgress(t);
      if (t >= 1) { stopAnim(); return; }
      state.anim.raf = requestAnimationFrame(step);
    };
    state.anim.raf = requestAnimationFrame(step);
  });
  $('progress').addEventListener('input', () => { stopAnim(); setProgress(parseInt($('progress').value, 10) / 1000); });
}

// --------------------------------------------------------------- the canvas
function bindCanvas() {
  const canvas = $('view');
  const at = (e) => {
    const r = canvas.getBoundingClientRect(), plan = state.plan;
    return [((e.clientX - r.left) / r.width) * plan.piece.W, ((e.clientY - r.top) / r.height) * plan.piece.H];
  };
  canvas.addEventListener('mousemove', (e) => {
    if (!state.plan) return;
    const [x, y] = at(e);
    $('hint').textContent = `${L(x, 1)}, ${L(y, 1)} ${unitLabel()}${state.picking ? ' · click to start here' : ''}`;
  });
  canvas.addEventListener('mouseleave', () => { $('hint').textContent = HINTS[state.view] || ''; });
  canvas.addEventListener('click', (e) => {
    if (!state.plan || !state.picking) return;
    const [x, y] = at(e);
    state.s.start = { x: r3(x), y: r3(y) };
    setPicking(false);
    scheduleRun(0);
  });
}

const r3 = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------- stats
function setStat(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

const pct = (v, of) => (of > 0 ? `${Math.round((100 * v) / of)}%` : '—');

function updateStats() {
  const plan = state.plan;
  if (!plan) return;
  const st = plan.stats;
  setStat('statLength', longText(st.length, state.units));
  setStat('statBends', String(st.bends));
  setStat('statRetrace', pct(st.retrace, st.length), st.retrace / Math.max(1, st.length) > 0.25 ? 'warn' : '');
  setStat('statJoin', pct(st.join, st.length), st.join / Math.max(1, st.length) > 0.25 ? 'warn' : '');
  setStat('statCross', String(st.crossings), st.crossings ? 'warn' : '');
  setStat('statTight', String(st.tight), st.tight ? 'bad' : '');
  setStat('statPiece', `${fmtLen(plan.piece.W, state.units, 1)} × ${fmtLen(plan.piece.H, state.units, 1)} ${unitLabel()}`);
}

function renderFigures() {
  const plan = state.plan;
  if (!plan) return;
  const st = plan.stats, U = state.units;
  const row = (k, v, sw = '') => `<tr><td>${sw ? `<span class="legend"><i style="background:${sw};margin-left:0"></i></span>` : ''}${k}</td><td>${v}</td></tr>`;
  const rows = [
    row('Line length', longText(st.length, U)),
    row('the image\'s edges', `${longText(st.edge, U)} · ${pct(st.edge, st.length)}`, KIND.edge),
    row('over a line again', `${longText(st.retrace, U)} · ${pct(st.retrace, st.length)}`, KIND.retrace),
    row('not in the image', `${longText(st.join, U)} · ${pct(st.join, st.length)}`, KIND.join),
    row('Bends (arcs)', String(st.bends)),
    row(`Bends to make (${MIN_BEND}° or more)`, String(bendCount(plan))),
    row('Tightest bend', st.bends ? `${L(st.minR, U === 'in' ? 3 : 1)} ${unitLabel()} radius` : '—'),
    row('Places tighter than the smallest bend', String(st.tight)),
    row('Corner loops', String(st.loops)),
    row('Strays from the edges', `at most ${L(st.strayMax ?? 0, U === 'in' ? 3 : 1)}, on average ${L(st.strayMean ?? 0, U === 'in' ? 3 : 2)} ${unitLabel()}`),
    row('Crossings', String(st.crossings)),
    row('Edges found', `${st.chains} chains in ${st.components} ${st.components === 1 ? 'piece' : 'pieces'}`),
  ];
  if (state.s.join === 'tsp') rows.push(row('Jumps', String(st.jumps ?? 0)));
  $('figs').innerHTML = `<tbody>${rows.join('')}</tbody>`;
  $('notes').textContent = plan.notes.map((n) => n.charAt(0).toUpperCase() + n.slice(1) + '.').join(' ');
}

// ------------------------------------------------------------------ export
const fileBase = () => state.imageName;

function bindExports() {
  $('exportSvg').addEventListener('click', () => {
    if (state.plan) downloadFile(drawingSVG(state.plan, { lineWidth: state.s.lineWidth, ink: state.disp.ink, title: state.imageName }), `${fileBase()}-line.svg`, 'image/svg+xml');
  });
  $('exportPng').addEventListener('click', () => {
    if (!state.plan) return;
    const a = document.createElement('a');
    a.href = renderPNG(state.plan, state.view, 2400);
    a.download = `${fileBase()}-${state.view}.png`;
    a.click();
  });
  $('printPlan').addEventListener('click', () => {
    if (!state.plan) return;
    updatePrintNote();
    $('printDlg').showModal();
  });
  $('exportBends').addEventListener('click', () => {
    if (state.plan) downloadFile(bendCSV(bendList(state.plan.path)), `${fileBase()}-bends.csv`, 'text/csv');
  });
  for (const id of ['paperSize', 'pSummary', 'pFit', 'pTemplate', 'pBends']) $(id).addEventListener('change', updatePrintNote);
  $('pTemplate').addEventListener('change', () => { $('pTicks').disabled = $('pBendNums').disabled = !$('pTemplate').checked; });
  $('printClose').addEventListener('click', () => $('printDlg').close());
  $('printGo').addEventListener('click', () => {
    const plan = state.plan;
    if (!plan) return;
    const html = planHTML(plan, {
      paper: $('paperSize').value, units: state.units, title: `${state.imageName} — single-line drawing`,
      summary: $('pSummary').checked, fit: $('pFit').checked, template: $('pTemplate').checked,
      previewURL: renderPNG(plan, 'drawing', 1400), lineWidth: state.s.lineWidth, minRadius: state.s.minRadius,
      ticks: $('pTicks').checked, bendNums: $('pBendNums').checked, bendTable: $('pBends').checked, tickMm: state.disp.tickMm, markSize: state.disp.markSize,
    });
    const w = window.open('', '_blank');
    if (!w) { setStatus('the browser blocked the new window: allow pop-ups for this page', 'bad'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    $('printDlg').close();
  });
}

function updatePrintNote() {
  const plan = state.plan;
  if (!plan) return;
  const room = printable(PAPERS[$('paperSize').value]);
  const pw = pageWindows(plan.piece.W, plan.piece.H, room.w, room.h);
  const pages = ($('pSummary').checked ? 1 : 0) + ($('pFit').checked ? 1 : 0) + ($('pTemplate').checked ? pw.windows.length : 0);
  $('printNote').textContent = `${pages} pages${$('pTemplate').checked ? ` (the 1:1 template on ${pw.rows} × ${pw.cols})` : ''}. ` +
    'Print at 100% (actual size): each 1:1 page has a 50 mm bar to check.';
}

function renderPNG(plan, view, maxPx) {
  const k = maxPx / Math.max(plan.piece.W, plan.piece.H);
  const c = document.createElement('canvas');
  c.width = Math.round(plan.piece.W * k);
  c.height = Math.round(plan.piece.H * k);
  const ctx = c.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const t = state.anim.t;
  state.anim.t = 1;   // an export is always the whole line
  drawView(ctx, plan, view, k);
  state.anim.t = t;
  return c.toDataURL('image/png');
}

// ------------------------------------------------------------------- image
/** Pixels from a URL, the longest side capped at maxDim. */
function loadImage(url, maxDim = 4000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h);
      resolve({ width: w, height: h, data: d.data });
    };
    img.onerror = () => reject(new Error('could not read that image'));
    img.src = url;
  });
}

function setImage(rgba, name, src, keepStart = false) {
  if (!keepStart) state.s.start = null;
  stopAnim();
  state.anim.t = 1;
  $('progress').value = '1000';
  state.rgba = rgba;
  state.imageName = name;
  state.imageSrc = src;
  state.imageKey++;
  state.styled = null;
  if (state.preset !== 'custom') { applyPreset(); showLengths(); }
  updateToned();
  renderStartNote();
  run();
}

/** The toned image as a canvas, for the Source and Overlay views until a run sends `styled`. */
function updateToned() {
  if (!state.rgba) return;
  const t = applyTone(state.rgba, num('gamma'), num('brightness'), num('saturation'));
  const c = document.createElement('canvas');
  c.width = t.width; c.height = t.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
  state.toned = c;
}

async function loadSample(kind, keepStart = false) {
  if (kind === 'monalisa' || kind === 'rhino') {
    try { setImage(await loadImage(`assets/${kind}.jpg`), kind, { kind: 'sample', name: kind }, keepStart); return; } catch { kind = 'sphere'; }
  }
  setImage(generateSample(kind).color, kind, { kind: 'sample', name: kind }, keepStart);
}

function bindImage() {
  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  $('file').addEventListener('change', () => { const f = $('file').files[0]; if (f) openFile(f); $('file').value = ''; });
  for (const b of document.querySelectorAll('[data-sample]')) b.addEventListener('click', () => loadSample(b.dataset.sample));
}

async function openFile(f) {
  try {
    // the original bytes, kept for projects: a re-encode could move edges
    const dataURL = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('could not read that file'));
      r.readAsDataURL(f);
    });
    setImage(await loadImage(dataURL), f.name.replace(/\.[^.]+$/, '') || 'drawing', { kind: 'file', name: f.name, dataURL });
  } catch (err) {
    setStatus(err.message, 'bad');
  }
}

// ----------------------------------------------------------------- projects
function collectProject() {
  return { image: state.imageSrc, units: state.units, settings: state.s, display: state.disp };
}

/** Every control from settings (no image): opening a project, Reset, start-up. */
function applySettings(units, s, disp) {
  state.units = units;
  state.s = s;
  state.disp = disp;
  showLengths();
  for (const k of ['gamma', 'brightness', 'saturation']) {
    $(k).value = s[k];
    $(`${k}Val`).textContent = Number(s[k]).toFixed(2);
  }
  $('precision').value = s.precision;
  buildStyleUI();
  showJoin();
  showLine();
  $('ink').value = disp.ink;
  $('paper').value = disp.paper;
  $('ticks').checked = disp.ticks;
  $('bendNums').checked = disp.bendNums;
  $('preset').value = state.preset;
  renderStartNote();
  save();
}

async function applyProject(p, problems) {
  state.preset = 'custom';
  applySettings(p.units, p.settings, p.display);
  const note = () => (problems.length ? ` (with problems: ${problems.join('; ')})` : '');
  if (!p.image) { run(); setStatus(`project opened without an image${note()}`, 'warn'); return; }
  if (p.image.kind === 'sample') await loadSample(p.image.name, true);
  else setImage(await loadImage(p.image.dataURL), p.image.name.replace(/\.[^.]+$/, '') || 'drawing', p.image, true);
  if (problems.length) setStatus(`project opened${note()}`, 'warn');
}

function resetControls() {
  if (!window.confirm('Reset every control to its default?\n\nThe image stays; the start point is cleared.')) return;
  state.preset = 'custom';
  applySettings('mm', freshSettings(), { ...DISPLAY });
  $('zoom').value = '1';
  setView('drawing');
  updateToned();
  run();
  setStatus('every control reset to its default');
}

function bindProjects() {
  $('resetAll').addEventListener('click', resetControls);
  $('saveProject').addEventListener('click', () => {
    if (!state.imageSrc) return;
    downloadFile(projectJSON(collectProject()), `${state.imageName}.edl.json`, 'application/json');
  });
  $('openProject').addEventListener('click', () => $('projectFile').click());
  $('projectFile').addEventListener('change', async () => {
    const f = $('projectFile').files[0];
    $('projectFile').value = '';
    if (!f) return;
    try {
      const { project, problems } = parseProject(await f.text());
      await applyProject(project, problems);
    } catch (err) {
      setStatus(`could not open the project: ${err.message}`, 'bad');
    }
  });
}

// ------------------------------------------------------------------- style
/**
 * The Style section: one card per filter, in chain order -- a tick to use it,
 * up/down to move it, and its own controls while it is on (PaintByNumbers').
 * Built from the filter registry (core/style.js).
 */
function buildStyleUI() {
  const host = $('styleChain');
  host.innerHTML = '';
  const { order, on, params } = state.s.style;
  order.forEach((fid, i) => {
    const f = filterById(fid);
    const card = document.createElement('div');
    card.className = `fcard${on[fid] ? ' on' : ''}`;
    card.innerHTML = `<div class="fhead"><label class="check"><input type="checkbox" id="style-${fid}"> ${f.label}</label>` +
      `<button class="mini" data-dir="-1" title="run earlier"${i === 0 ? ' disabled' : ''}>↑</button>` +
      `<button class="mini" data-dir="1" title="run later"${i === order.length - 1 ? ' disabled' : ''}>↓</button></div>` +
      '<div class="fbody"><div class="fparams"></div><p class="note"></p></div>';
    const tick = card.querySelector('input');
    tick.checked = !!on[fid];
    tick.addEventListener('change', () => { on[fid] = tick.checked; buildStyleUI(); scheduleRun(0); });
    for (const b of card.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        const j = i + parseInt(b.dataset.dir, 10);
        [order[i], order[j]] = [order[j], order[i]];
        buildStyleUI();
        if (on[order[i]] && on[order[j]]) scheduleRun(0);
      });
    }
    const fbody = card.querySelector('.fbody');
    fbody.hidden = !on[fid];
    if (on[fid]) {
      renderParams(card.querySelector('.fparams'), f.params, params[fid], `style-${fid}`);
      card.querySelector('.note').textContent = f.blurb;
    }
    host.appendChild(card);
  });
}

/** Range, select or checkbox controls for a filter's params; mm values show in the units. */
function renderParams(host, defs, values, prefix) {
  host.innerHTML = '';
  for (const p of defs) {
    const id = `${prefix}-${p.key}`;
    let el;
    if (p.type === 'checkbox') {
      el = document.createElement('label');
      el.className = 'check';
      el.innerHTML = `<input type="checkbox" id="${id}"> ${p.label}`;
      const input = el.querySelector('input');
      input.checked = !!values[p.key];
      input.addEventListener('change', () => { values[p.key] = input.checked; scheduleRun(); });
    } else if (p.type === 'select') {
      el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = `<label for="${id}">${p.label}</label><select id="${id}">` +
        p.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('') + '</select>';
      const input = el.querySelector('select');
      input.value = values[p.key];
      input.addEventListener('change', () => { values[p.key] = input.value; scheduleRun(); });
    } else {
      el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = `<label for="${id}">${p.label}</label>` +
        `<input type="range" id="${id}" min="${p.min}" max="${p.max}" step="${p.step}"><span class="val"></span>`;
      const input = el.querySelector('input'), val = el.querySelector('.val');
      const dp = p.dp ?? (p.step >= 1 ? 0 : 2);
      const show = () => {
        const v = Number(input.value);
        val.textContent = p.unit === 'mm' && state.units === 'in' ? `${(v / 25.4).toFixed(3)} in` : v.toFixed(dp) + (p.unit ? ` ${p.unit}` : '');
      };
      input.value = values[p.key];
      show();
      input.addEventListener('input', () => { values[p.key] = parseFloat(input.value); show(); scheduleRun(); });
    }
    if (p.hint) el.title = p.hint;
    host.appendChild(el);
  }
}

// ------------------------------------------------------------------- misc
function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function bindTone() {
  for (const id of ['gamma', 'brightness', 'saturation']) {
    const input = $(id), val = $(`${id}Val`);
    input.addEventListener('input', () => { val.textContent = parseFloat(input.value).toFixed(2); updateToned(); scheduleRun(); });
  }
}

function bindDisplay() {
  for (const id of ['ink', 'paper']) {
    $(id).addEventListener('input', () => {
      const h = normalizeHex($(id).value);
      if (!h) return;
      state.disp[id] = h;
      save();
      paint();
    });
  }
  for (const id of ['ticks', 'bendNums']) $(id).addEventListener('change', () => { state.disp[id] = $(id).checked; save(); paint(); });
  for (const id of DISP_LEN_IDS) {
    $(id).addEventListener('input', () => {
      const v = toMm(parseFloat($(id).value), state.units);
      if (!(v > 0)) return;
      state.disp[id] = v;
      save();
      paint();
    });
  }
}

function bindViews() {
  for (const b of document.querySelectorAll('#viewSeg button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('zoom').addEventListener('change', paint);
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(paint, 120); });
}

function init() {
  restore();
  buildPresets();
  applySettings(state.units, state.s, state.disp);
  bindLengths();
  bindLine();
  bindTone();
  bindDisplay();
  bindViews();
  bindAnim();
  bindCanvas();
  bindExports();
  bindImage();
  bindProjects();
  loadSample('monalisa');
}

init();
