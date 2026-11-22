// Shared harness machinery: output accumulation, pass/fail lines, fixtures.
//
// NOTHING HERE TOUCHES THE DOM. tests/report.js paints the accumulated HTML in a
// browser; run-tests.mjs strips it to text under node/deno. Same test modules both
// ways. (Copied from PaintByNumbers'.)

import { mulberry32 } from '../src/shim/random.js';

const html = [];
export const say = (s) => html.push(s);
export const getHtml = () => html.join('\n');
export const reset = () => { html.length = 0; };

export const num = (v, dp = 3) => (isFinite(v) ? v.toFixed(dp) : String(v));

const tally = { pass: 0, fail: 0 };
export const getTally = () => ({ ...tally });

/** One checked claim. `detail` is the measurement, so a failure says by how much. */
export function check(label, ok, detail = '') {
  if (ok) tally.pass++; else tally.fail++;
  say(`<p><span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ${label}` +
      (detail ? ` <span class="note">— ${detail}</span>` : '') + '</p>');
  return ok;
}

export const section = (title, blurb = '') => {
  say(`<h2>${title}</h2>`);
  if (blurb) say(`<p class="note">${blurb}</p>`);
};

export const mkRand = mulberry32;
