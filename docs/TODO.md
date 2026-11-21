# TODO

## Wire manufacturing instructions (planned; the user's request)

- **Peg / nail layout.** A peg at the centre of every arc, its diameter twice
  the arc's radius less the wire's (the wire wraps the peg's outside), on the
  inside of the bend. Arcs at the smallest radius share one peg size. Printed on
  the 1:1 template pages as circles with numbers, and as a drill list.
- **Pegboard mode.** Peg centres snapped to a fixed grid (1 in or 25 mm
  pegboard); arcs refitted so each is centred on a hole. A much stronger
  constraint than free nails: likely a separate, coarser fit.
- **Bend table.** In drawing order: feed length, bend angle, left or right,
  radius, peg number; also as CSV in the feed / rotate / bend form CNC wire
  benders read (2-D, so rotate is 0).
- **Wire bill of materials.** Total length plus tails at both ends, the gauge,
  pegs by size.
- **Hanging loop** at one end (or the start), and tail lengths.
- **Crossings** marked over/under on the template (the wire lifts by its
  thickness at each).

## Better lines for wire

Tried on branch `curvature` (2026-11-19): Dubins joins, the paired walk, tight-only
smoothing, merge / remove / optimize; see docs/architecture.md for the numbers.

- **Direction-aware joins.** With Dubins joins, choose bridges, odd-node pairs
  and the TSP order by Dubins length (the turn they force), not the straight
  distance: the loops Dubins joins make where strokes face badly are the cost
  of the best variant now.
- **U-turns round a peg.** A reversal (a dead end that is retraced, or a hairpin
  join) as a half circle of the smallest radius, the way back offset by two
  radii, instead of a tight corner or a long teardrop loop.
- **Fewer arcs from Fourier, optimize and PID.** Their lines are thousands of short
  arcs; merge runs of nearly equal curvature (within a tolerance) into one arc,
  for a bend table a person can follow.
- **Steering that loses the line.** D is capped at 2 and the default bend is
  3 mm, where D 2 holds the line (mean stray 3 to 4 mm). With the bend set to 0
  (capped at look/4), D 2 lost the line on the Mona Lisa (78 mm mean stray): the
  progress window cannot find it again. Detect that (far from the line for long)
  and re-acquire.
- **PID ripple.** A faint ripple on some steered strokes at 4×: tune the step
  (now R/4, at most look/8 and 0.5 mm) against D, or low-pass the curvature.
- **PID end of stroke.** Steer onto the exact end point and heading of each stroke
  (or hand over to the Dubins join earlier), so no small S-bend is left there.
- **Side-by-side retraces.** A retraced run offset by the wire's thickness from
  the run it repeats, so the template shows both wires.

## Other ideas offered

- Multiple lines, each with its own colour, material and gauge (`plan.paths[]`):
  separate pieces could become lines of their own instead of bridges.
- Bridges routed through the image's dark or weak-edge areas (a cost map), so
  they read as strokes; today they are straight.
- "Aim for N m of line" / N bends: scale the detail limits together to a target,
  as PaintByNumbers' "Aim for N regions".
- A finer-detail subject area (faces).
- Hand edits: erase and draw edges are DONE (core/edits.js). Still open: reject a
  join (the router picks the next best), pin the end, and a "lock the line"
  mode to reshape the finished line directly.
- Tone methods for the registry: TSP stipple art, squiggle / spiral (amplitude
  modulated), Hilbert curve.
- G-code export for pen plotters.

## Making it by hand: next (offered 2026-11-20, not chosen yet)

Done: fewer bends (core/refit.js), distance ticks, numbered bends and a bend
table. Offered and still open: a wire ruler strip (the line straightened, every
bend start marked, to mark straight wire before bending); checkpoints to pin;
sectioned pages; radii matched to a tool set; springback over-bend; a
difficulty map; bending from the middle out; a step-by-step bending mode; the
screen as a 1:1 template; a photo check for drift. Also: label crowding on dense
drawings (a leader-line layout, or labels only on bends above an angle).
