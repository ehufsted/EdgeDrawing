// Dubins paths: the shortest way from one point and heading to another that
// never turns tighter than a radius ρ (Dubins 1957). It is always three
// pieces, each a left arc (L), a right arc (R) or a straight (S), of one of six
// words: LSL, RSR, LSR, RSL, RLR, LRL. The lengths come in closed form (Shkel &
// Lumelsky 2001, as in Walker's dubins.c), in units of ρ, after rotating so the
// goal lies along the x axis.
//
// Every candidate is BUILT and its end checked against the goal before it is
// accepted, so a word whose closed form does not apply (or a slip in one) can
// never produce a path that misses: the shortest of those that land wins.
//
// Angles are atan2 angles in the drawing's own coordinates; "left" is the way
// the angle increases. The result is segs in core/arcs.js's form.

const TAU = 2 * Math.PI;
const mod2pi = (a) => a - TAU * Math.floor(a / TAU);

const WORDS = {
  LSL(a, b, d) {
    const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b);
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (sa - sb);
    if (p2 < 0) return null;
    const t1 = Math.atan2(cb - ca, d + sa - sb);
    return [mod2pi(-a + t1), Math.sqrt(p2), mod2pi(b - t1)];
  },
  RSR(a, b, d) {
    const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b);
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (sb - sa);
    if (p2 < 0) return null;
    const t1 = Math.atan2(ca - cb, d - sa + sb);
    return [mod2pi(a - t1), Math.sqrt(p2), mod2pi(-b + t1)];
  },
  LSR(a, b, d) {
    const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b);
    const p2 = -2 + d * d + 2 * Math.cos(a - b) + 2 * d * (sa + sb);
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const t1 = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
    return [mod2pi(-a + t1), p, mod2pi(-mod2pi(b) + t1)];
  },
  RSL(a, b, d) {
    const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b);
    const p2 = d * d - 2 + 2 * Math.cos(a - b) - 2 * d * (sa + sb);
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const t1 = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
    return [mod2pi(a - t1), p, mod2pi(b - t1)];
  },
  RLR(a, b, d) {
    const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b);
    const c = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (sa - sb)) / 8;
    if (Math.abs(c) > 1) return null;
    const p = mod2pi(TAU - Math.acos(c));
    const t = mod2pi(a - Math.atan2(ca - cb, d - sa + sb) + p / 2);
    return [t, p, mod2pi(a - b - t + p)];
  },
  LRL(a, b, d) {
    const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b);
    const c = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (sb - sa)) / 8;
    if (Math.abs(c) > 1) return null;
    const p = mod2pi(TAU - Math.acos(c));
    const t = mod2pi(-a + Math.atan2(-ca + cb, d + sa - sb) + p / 2);
    return [t, p, mod2pi(mod2pi(b) - a - t + p)];
  },
};

/**
 * Build a word's segs from (x, y, h), each piece's length in units of ρ.
 * @returns {{segs, x, y, h, length}}
 */
function build(word, lens, x, y, h, rho, kind) {
  const segs = [];
  let length = 0;
  for (let k = 0; k < 3; k++) {
    const c = word[k], L = lens[k];
    if (L < 1e-9) continue;
    if (c === 'S') {
      x += rho * L * Math.cos(h); y += rho * L * Math.sin(h);
      segs.push({ k: 'L', x, y, kind });
    } else {
      const s = c === 'L' ? 1 : -1;
      // the centre is on the turning side
      const cx = x - s * rho * Math.sin(h), cy = y + s * rho * Math.cos(h);
      const a0 = Math.atan2(y - cy, x - cx), sweep = s * L;
      x = cx + rho * Math.cos(a0 + sweep); y = cy + rho * Math.sin(a0 + sweep);
      h += sweep;
      segs.push({ k: 'A', x, y, cx, cy, r: rho, a0, sweep, kind });
    }
    length += rho * L;
  }
  return { segs, x, y, h, length };
}

/**
 * The shortest path from (x0, y0) heading h0 to (x1, y1) heading h1, no turn
 * tighter than rho.
 * @returns {{segs, length, word}}
 */
export function dubins(x0, y0, h0, x1, y1, h1, rho, kind = 'join') {
  const dx = x1 - x0, dy = y1 - y0, D = Math.hypot(dx, dy);
  const th = D > 0 ? Math.atan2(dy, dx) : 0;
  const a = mod2pi(h0 - th), b = mod2pi(h1 - th), d = D / rho;
  let best = null;
  for (const [word, f] of Object.entries(WORDS)) {
    const lens = f(a, b, d);
    if (!lens) continue;
    const r = build(word, lens, x0, y0, h0, rho, kind);
    const miss = Math.hypot(r.x - x1, r.y - y1) + Math.abs(Math.sin((r.h - h1) / 2)) * rho;
    if (miss > 1e-6 * Math.max(1, rho, D)) continue;
    if (!best || r.length < best.length - 1e-12) best = { ...r, word };
  }
  if (!best) return { segs: [{ k: 'L', x: x1, y: y1, kind }], length: D, word: 'S' };   // cannot happen; a straight rather than nothing
  // land exactly on the goal (the last seg's end carries the rounding)
  const last = best.segs[best.segs.length - 1];
  if (last) { last.x = x1; last.y = y1; }
  return { segs: best.segs, length: best.length, word: best.word };
}
