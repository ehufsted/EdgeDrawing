// core/svg.js, core/printout.js, core/project.js: what leaves the app.

import { section, check } from './runner.js';
import { pathD, drawingSVG, arrowAt } from '../src/core/svg.js';
import { fitArcs } from '../src/core/arcs.js';
import { planHTML, pageWindows, printable, PAPERS } from '../src/core/printout.js';
import { projectJSON, parseProject } from '../src/core/project.js';
import { DEFAULTS } from '../src/core/units.js';
import { defaultStyle } from '../src/core/style.js';

export function run() {
  section('core.output', 'Prediction: the drawing is one &lt;path&gt; with one M, sized in mm with a matching viewBox; an arc of more than half a turn is written as two A commands; filtering by kind starts a new M at each break; the printout has a page each for figures and fit plus the 1:1 template pages; a project round-trips, and bad values fall back with reasons.');
  // a right-angle corner on 4.2 mm straights cannot take a 6 mm radius: it becomes a loop
  const loop = fitArcs([0, 0, 3, 3, 6, 0], ['edge', 'join'], { minRadius: 6, tol: 0.3, loops: true });
  const d = pathD(loop.path);
  check('one M', (d.match(/M/g) || []).length === 1, d.slice(0, 60));
  const big = loop.path.segs.filter((s) => s.k === 'A' && Math.abs(s.sweep) > Math.PI).length;
  check('a 270° loop is written as two arcs', big === 1 && (d.match(/A/g) || []).length === 2, `${(d.match(/A/g) || []).length} A commands`);
  const plan = { piece: { W: 30, H: 20 }, path: loop.path };
  const svg = drawingSVG(plan, { lineWidth: 0.5, title: 'test' });
  check('true size: 30mm × 20mm, viewBox 0 0 30 20', /width="30mm"/.test(svg) && /height="20mm"/.test(svg) && /viewBox="0 0 30 20"/.test(svg), '');
  check('one &lt;path&gt;, stroked at the line width', (svg.match(/<path /g) || []).length === 1 && /stroke-width="0.5"/.test(svg), '');
  const joins = pathD(loop.path, (s) => s.kind === 'join');
  check('only the joins: one M and the one straight after the loop', (joins.match(/M/g) || []).length === 1 && (joins.match(/L/g) || []).length === 1 && !joins.includes('A'), joins);
  const a = arrowAt(loop.path, 1);
  check('arrowAt: 1 mm along the first straight, heading along it', a && Math.abs(a.x - Math.SQRT1_2) < 1e-9 && Math.abs(a.ux - Math.SQRT1_2) < 1e-9, a ? `${a.x}, ${a.ux}` : 'none');

  // the printout: one page each for figures and fit, and the template split onto pages
  const bigPlan = { ...plan, piece: { W: 400, H: 300 }, start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, notes: ['a note'],
    stats: { length: 20, edge: 15, retrace: 0, join: 5, bends: 1, minR: 6, tight: 0, crossings: 0 } };
  const pw = pageWindows(400, 300, printable(PAPERS.letter).w, printable(PAPERS.letter).h);
  const html = planHTML(bigPlan, { paper: 'letter', fit: true });
  const pages = (html.match(/<section class="page">/g) || []).length;
  check('printout: figures + fit + the 1:1 template pages', pages === 2 + pw.windows.length, `${pages} pages, template ${pw.rows} × ${pw.cols}`);
  check('...the line written once, shown through &lt;use&gt;', (html.match(/id="edl-line"/g) || []).length === 1 && (html.match(/href="#edl-line"/g) || []).length === pages - 1, '');

  // the making marks on the 1:1 pages, and the bend table: 50 bends at 40ish a page
  const zig = [0, 0];
  for (let i = 1; i <= 51; i++) zig.push(10 * i, i % 2 ? 6 : 0);
  const zplan = { ...bigPlan, path: fitArcs(zig, Array(51).fill('edge'), { minRadius: 2, tol: 0.3 }).path, stats: { ...bigPlan.stats, length: 400 } };
  const zhtml = planHTML(zplan, { paper: 'letter', summary: false, fit: false, ticks: true, bendNums: true, bendTable: true, tickMm: 50 });
  const zpages = (zhtml.match(/<section class="page">/g) || []).length;
  const tpages = pageWindows(400, 300, printable(PAPERS.letter).w, printable(PAPERS.letter).h).windows.length;
  check('printout with marks: the marks drawn once, on every 1:1 page', (zhtml.match(/id="edl-made"/g) || []).length === 1 && (zhtml.match(/href="#edl-made"/g) || []).length === tpages, '');
  check('...and a bend table of 50 rows over its pages', (zhtml.match(/<td class="r n">/g) || []).length === 50 && zpages === tpages + Math.ceil(50 / Math.max(10, Math.floor((printable(PAPERS.letter).h - 14) / 5.2))),
    `${zpages} pages (${tpages} template)`);
  check('...without marks asked for, none', !planHTML(zplan, { paper: 'letter' }).includes('edl-made'), '');
  const onlyTicks = planHTML(zplan, { paper: 'letter', summary: false, fit: false, ticks: true, tickMm: 50 });
  const onlyBends = planHTML(zplan, { paper: 'letter', summary: false, fit: false, bendNums: true, tickMm: 50 });
  check('...ticks alone: the tick labels, no bend numbers; bend numbers alone: no tick labels', /\d+ cm<\/text>/.test(onlyTicks) && !/font-weight="bold">\d+</.test(onlyTicks) &&
    /font-weight="bold">\d+</.test(onlyBends) && !/\d+ cm<\/text>/.test(onlyBends), '');
  const oldMarks = parseProject({ app: 'EdgeDrawing', version: 1, display: { marks: true } }).project.display;
  check('project: an old single marks switch turns on both', oldMarks.ticks === true && oldMarks.bendNums === true, JSON.stringify(oldMarks));
  const tiny = parseProject({ app: 'EdgeDrawing', version: 1, display: { tickMm: 0.05, markSize: 500 } }).project.display;
  check('project: a tick spacing under 5 mm and a label over 20 mm fall back to the defaults', tiny.tickMm === 100 && tiny.markSize === 2.5, JSON.stringify(tiny));
  const fine = parseProject({ app: 'EdgeDrawing', version: 1, settings: { precision: 'fine' } });
  check('project: Fine precision (gone) opens at Normal, with a note', fine.project.settings.precision === 'normal' && fine.problems.some((p) => /Fine/.test(p)), fine.problems.join('; '));

  // a project round trip, and bad input mended with reasons
  const s = { ...DEFAULTS, widthMm: 250, join: 'tsp', oddJoin: 'new', start: { x: 10, y: 20 }, closed: true, pidD: 1.5, loops: true, style: defaultStyle() };
  const back = parseProject(projectJSON({ image: { kind: 'sample', name: 'rings' }, units: 'in', settings: s, display: { ink: '#123456', paper: '#ffffff' } }));
  const same = ['widthMm', 'join', 'oddJoin', 'closed', 'pidD', 'loops'].every((k) => back.project.settings[k] === s[k]) &&
    back.project.settings.start.x === 10 && back.project.units === 'in' && back.project.display.ink === '#123456';
  check('project: settings, start, units and colours survive a round trip', same && back.problems.length === 0, back.problems.join('; '));
  const bad = parseProject({ app: 'EdgeDrawing', version: 1, settings: { widthMm: -3, join: 'zigzag', minRadius: 'x', pidD: 3 } });
  check('project: unusable values fall back to defaults, each with a reason', bad.project.settings.widthMm === DEFAULTS.widthMm && bad.project.settings.join === DEFAULTS.join && bad.project.settings.pidD === DEFAULTS.pidD && bad.problems.length >= 4,
    bad.problems.join('; '));
  const old = parseProject({ app: 'EdgeDrawing', version: 1, settings: { bendFix: 'fourier', fourierScale: 20 } });
  check('project: a smoothing saved as a tight-corner fix comes back as the smoothing', old.project.settings.smoothing === 'fourier' && old.project.settings.bendFix === 'none' && old.project.settings.fourierScale === 20,
    `${old.project.settings.smoothing}, ${old.project.settings.bendFix}`);
  let refused = false;
  try { parseProject({ app: 'PaintByNumbers', version: 1 }); } catch { refused = true; }
  check('project: another app\'s file is refused', refused, '');
}
