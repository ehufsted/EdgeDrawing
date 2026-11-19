// The ordered section list. Order is part of the contract: the transcript is
// diffed between runs, so a reordering reads as a change.

import { reset, say, getTally } from './runner.js';
import * as edges from './core.edges.js';
import * as graph from './core.graph.js';
import * as route from './core.route.js';
import * as arcs from './core.arcs.js';
import * as output from './core.output.js';
import * as pipeline from './pipeline.js';

export const SECTIONS = [
  ['core.edges', edges],
  ['core.graph', graph],
  ['core.route', route],
  ['core.arcs', arcs],
  ['core.output', output],
  ['pipeline', pipeline],
];

/** Headless: run every section (or those named) synchronously. */
export function runAll(only = null) {
  reset();
  for (const [name, mod] of SECTIONS) {
    if (only && !only.includes(name)) continue;
    mod.run();
  }
  summary();
}

export function summary() {
  const t = getTally();
  say(`<h2>Summary</h2><p class="${t.fail ? 'fail' : 'pass'}">${t.pass} passed, ${t.fail} failed</p>`);
}
