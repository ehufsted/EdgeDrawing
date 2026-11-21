# Architecture

These are the invariants that no single file is the right home for. A module's own
header explains its reasoning; this page is what holds across modules.

## Layers

```
shim/      image resize and blur, mulberry32 (copied from PaintByNumbers)
core/      units (settings, MEDIA), color, raster (the work grid), style (the
           filter chain), edges (Canny + thinning), graph (pixels -> junctions
           and chains, clean-up, gap linking), route (one line: Eulerian or
           TSP), arcs (straights and arcs, measurements), bends (keeping to
           the bend: Dubins joins, merge / remove / optimize, the stray),
           dubins (shortest paths under a turning radius), svg, printout,
           project; and, copied, kuwahara, steer, features, geom
pipeline.js  the whole chain, with its stage cache; imports core/ only
worker.js  wraps pipeline.js and keeps the image and the cache between runs
app.js     UI; the only DOM user (plus svg.downloadFile)
```

Dependencies run downward only. There is no methods/ registry yet: the two ways
of joining (Eulerian and TSP) are options of one route stage, as both start from
the same edge graph and end in the same polyline.

## One grid, then millimeters

Everything up to the one-pixel edge map happens on ONE work raster laid over the
drawing (`core/raster.js`, its long side set by Precision). `core/graph.js` turns
the edge map into chains in mm, and from then on nothing reads pixels. The PLAN
holds no pixels: the cleaned graph and the path in mm. Every view, the SVG and
the printout draw that same plan. Lengths in settings are mm on the drawing, so
a design behaves the same at any precision (Canny's blur is set in mm and
converted per grid).

## One line, by construction

The route (`core/route.js`) is a list of runs, each starting where the last
ended, and the arc fitter (`core/arcs.js`) turns their concatenation into
straights and arcs, each starting where the last ended and TANGENT to it (G1).
Nothing later splits the line: the SVG is one `<path>`, the printout shows that
path through `<use>`. The harness checks continuity and tangency of every plan,
and that the Eulerian route draws each edge of the image exactly once as 'edge'.

Every segment carries a KIND: 'edge' (the image's edge, first time), 'retrace'
(drawn again over one) or 'join' (not in the image: bridges, new straights,
jumps). The figures, the Route and Problems views and the notes all read it.

## Bends

An arc is never tighter than the smallest bend radius, except at a corner the
fitter reports as TIGHT (`plan.tight`, red in Problems). A corner's radius is
the one whose arc passes within `simplify` of it (so gentle corners left on a
curve come back smooth, and sharp ones stay corners), at least the smallest
bend, at most what the two straights beside it have room for (each corner
first gets what the smallest bend needs, the rest shared in
proportion to what each wants). With corner loops
on, a tight corner of up to 135° becomes a loop round a circle of the smallest
radius instead (sharper ones would be teardrops many radii long). With a bend
radius set, stage B smooths at two radii, since no line can follow a detail
smaller than its bend.

## Determinism

No randomness and no clocks: the 2-opt works to a fixed budget of evaluations,
the matching repair to a fixed number of passes, and every sort breaks ties by
index. So the same image and settings give the same plan, byte for byte (the
harness checks it), which is why projects store settings, not the plan.

## Stage cache

`pipeline.js` stages A (raster + Style), B (edges + graph), C (route), D (arcs +
measurements) each remember their settings key; the worker keeps the cache
between runs. The start point and the join options re-run C and D; corner loops
only D; the line's colours re-run nothing. The bend radius re-runs B (it sets
the smoothing scale) and the line width D (it sets how close two crossings
count as one).

## Findings (measured on the Mona Lisa sample, 300 mm wide, Medium)

- Canny leaves a gap wherever lines meet (each side's non-maximum suppression
  eats the junction): without edge linking, 343 chains were 326 separate
  pieces, and the line was mostly bridges. Linking loose ends to a line within
  the smallest feature, ahead of them, halved the pieces and kept 18% more of
  the image for the same length of joins.
- Bridging from mid-chain points makes new odd nodes; preferring loose ends
  (up to 5 mm longer per end) cut the odd nodes from 588 to 224.
- Retracing along the graph to pair odd nodes is often far longer than a
  straight: "over a line again" retraced 42% of the line; "whichever is
  shorter" 1% (so it is the default for a pen).
- In wire mode most tight corners are where a stroke ends and the line turns
  back (a hairpin) or a join leaves it at a sharp angle. Corner loops fix them
  but add about 20 mm of wire each; see docs/TODO.md for the planned fix.

## Keeping to the bend: measured (2026-11-19)

Wire 1.2 mm, bend radius 3 mm, stray at most 3 mm, 300 mm wide. Tight corners
(of all bends), line length, and the largest stray from the traced edges:

| variant | rhino coarse | rhino medium | Mona Lisa coarse |
| --- | --- | --- | --- |
| plain | 114 of 225, 1.78 m, 2.1 mm | 299 of 550, 3.04 m | 365 of 697, 5.20 m |
| Dubins joins | 75, 2.08 m | 161, 3.86 m | 186, 6.37 m |
| paired walk | 112 | 294 | 362 |
| smoothing only where tight | 83 | 238 | 307 |
| merge | 67 | 178 | 265 |
| cut points out (remove) | 41 | 71 | 116 |
| relax the whole line (optimize) | 79 (963 bends) | 160 | 250 |
| Dubins + pairs + remove | 15, 2.04 m | 17, 3.69 m | 27, 6.16 m |
| Dubins + pairs + tight-only + remove | **5**, 1.84 m, 2.8 mm | **16**, 3.65 m | **22**, 6.02 m |
| Dubins + pairs + optimize | 33 | 57 | 73 |

- The tight corners are mostly at joins (Dubins halves them) and at small
  wiggles the fixes can remove within the stray; what is left are sharp tips
  and hairpins no 3 mm bend can follow within 3 mm.
- Dubins joins cost line: a join whose two strokes face badly becomes a loop
  (the share not in the image goes from 27% to 39% on the rhino). Choosing
  joins by their Dubins length, not their straight one, should cut that.
- The paired walk alone changes little: most junctions here have three chains.
- Optimize converges poorly against the pull back to the traced line, and its
  line is many short arcs (it cannot be simplified without undoing it).
- Fixes found on the way, for every option: the arc fitter now gives each corner
  what the smallest bend needs before sharing the rest of a straight (sharing
  in proportion, a nearly straight corner starved a sharp neighbour); a tight
  corner keeps within the tolerance of its point (it used to cut a dead end's
  tip back by a whole straight); and the stray budget bounds the arcs too.

### Fourier smoothing and PID steering (added the same day)

Tight PLACES now (tight corners within one bend radius of a tighter one count
once, so a densely sampled line is not counted per vertex). Same settings.

| variant | rhino coarse | rhino medium | Mona Lisa coarse | largest / mean stray |
| --- | --- | --- | --- | --- |
| plain | 67 | 137 | 199 | 0.6–2.8 / 0.1 mm |
| Fourier, length scale 8 / 15 / 30 mm | 54 / 36 / 20 | 101 / 71 / 47 | 170 / 114 / 77 | 1.3 / 2.3 / 4.5, mean 0.2 / 0.5 / 1.2 mm |
| PID, look ahead 4 / 8 / 15 mm | 0 | 0 | 0 | 5–8 / 9–10 / 11–12, mean 0.6 / 1.5 / 2.7 mm |
| Dubins + pairs + tight-only + remove | 5 | 15 | 21 | 2.8–3.3 / 0.2–0.3 mm |
| Dubins + pairs + tight-only + PID 8 | 0 | 0 | 0 | 4.7–8.5 / 0.6–0.75 mm |

- PID is the only method that can never leave a tight corner: the curvature is
  capped, so the bend holds by construction and the cost moves entirely into
  stray (largest where the traced line turns sharper than the car can: tips,
  hairpins). A short look ahead follows closest. I and D change little here.
- Fourier trades tight places for stray smoothly with its length scale, but
  guarantees neither.
- Both give dense lines (thousands of short arcs): for a bend table they need
  merging into fewer arcs of nearly equal curvature (a TODO).
- Where a steered stroke stops just short of its end, the Dubins join to the
  next stroke makes a small S-bend at the radius.

### Smoothing settled (user's choice)

The user found the PID steering best (about P 1, I 0, D 1, varying the look
ahead) and Fourier stylistically interesting. So `smoothing` is now its own
setting for the whole line, 'pid' by default (look ahead 4 mm), with 'fourier',
'optimize' (relax) and 'none'; Dubins joins, the paired walk, merge / remove and
tight-only edge smoothing moved to the Experimental smoothing tab.

- A pen (no bend) still caps the steering at a quarter of the look ahead:
  uncapped, the controller swung at the scale of one step (the Mona Lisa came
  out as hundreds of thousands of tiny arcs and overflowed the crossing count).
  Pen Mona Lisa, Medium: 9.3 m, stray 6.3 / 1.3 mm, about 18,500 arcs.
- Crossings are now found per segment (a set of candidates each) and merged in
  bins, so a dense line cannot exhaust memory.
- Seen at 4× in pen mode: a faint ripple on some steered strokes; P, D or the
  step length could calm it.
- The integral term was removed at the user's request (2026-11-19): the steering
  is a PD controller, P 1 and D 1 by default (the setting is still called 'pid').
- The pen / wire choice was removed at the user's request: the defaults are the
  wire's (1.2 mm, 3 mm bend), and D is capped at 2 (PID_D_MAX). Stray against D
  with a 3 mm bend (draft precision): Mona Lisa mean 1.12 / 1.15 / 1.25 / 2.03 /
  2.81 mm at D 0 / 0.5 / 1 / 1.5 / 2; rhino 0.92 / 1.07 / 1.22 / 2.28 / 4.34 mm.

## Making it by hand (2026-11-20)

Asked for: fewer bends, distance ticks, numbered bends; tool-agnostic.

- core/refit.js refits the finished line (stage D, after the smoothing) as the
  fewest arcs within `bendTol` (0.5 mm), greedy from the start, each tangent to
  the last, none tighter than the bend. Measured at the defaults: rhino (Coarse)
  3,293 segments / 2,896 bends to 322 / 313, stray mean 1.34 to 1.17 mm; Mona
  Lisa 17,280 / 14,725 to 2,011 / 1,914. The line grows 5–7%, mostly where the
  refit rejoins a steered line at full lock by a Dubins path.
- Steps to get there: a tangent arc through the next point is impossible where
  the line runs AT the bend and the carried heading is slightly off, so an arc
  at the bend may end near the point (within tol); then the tolerance is
  loosened (×2, ×4) for one arc; then a Dubins rejoin; only then a sharp corner
  (one straight across it, reported). Without these, the steered rings sample
  had 7 sharp corners; with them none.
- An arc never spans two kinds (edge / retrace / join), so the lengths by kind
  stay true, unless a run is too short to turn in.
- core/marks.js: bends are arcs of 3° or more (gentler ones are a slight curve
  in a straight); R / L as seen on the page (y down: an increasing angle is
  clockwise). Ticks carry the TOTAL length. Labels: the tick labels first, on
  the clear side; each bend label tries 16 spots, the first covering neither
  the wire nor another label wins, else the one covering least. Dense drawings
  still crowd (about 300 bends on a 30 cm rhino at 2.5 mm labels): the bend
  table carries everything regardless.
- 2026-11-21, the user's choices: distance ticks and bend numbers are separate
  toggles (preview and Print / PDF); Fewer bends is off by default and lives in
  the Experimental tab, as on a steered line it gave high-frequency waves (it
  follows the steering's ripple) rather than broad curves. With it off, a
  steered line is thousands of tiny arcs, so bend numbers there are dense.
- 2026-11-21, UI: the sidebar is three tabs, Picture (image, tone, style,
  canvas, edges & detail), Line (one line, line, smoothing) and Make (figures,
  marks, output); the Experimental smoothing section shows only with the
  header's Show experiments switch, and while hidden, any experiment away from
  its default is named in a note on the Line tab (they still act). Corner loops
  shows only when the line is not steered (steering is never tight).
- 2026-11-21, the user's choices: Precision defaults to Rough draft and Fine
  (2400 px) is gone (a project asking for it gets the default); every Style
  filter is off by default (Painterly was on); a Tone or Style change shows the
  Source view and an Edges & detail change the Edges view (app.js showFor); the
  figures are their own section on the Make tab, collapsed.

## Save files

The app is not released: project files carry no backward compatibility. A
field the app does not know is ignored and one it cannot use falls back to its
default with a note, but nothing from an earlier shape of the file is read
across into a newer one.

## Editing (2026-11-21)

The user chose to edit the EDGES (my recommendation, option 1 of three: edges,
how pieces are joined, the finished line). core/edits.js applies the strokes
in settings.edits to the cleaned graph in a stage E between B (edges) and C
(route), so everything after it follows and the stage cache re-runs only E on.
Erase: edges near the stroke are resampled finely, the points within r dropped,
the runs left become edges (cut ends are new loose ends). Draw: the stroke is
smoothed lightly and simplified like an edge; each end within SNAP (2 mm, or
the smallest feature) of an edge joins it, at a node within half that, else by
splitting the edge at the nearest point. Ends are resolved one after the other
(the second sees the first's split), and never against the new line itself.
Edits belong to one image (cleared with a new one, kept in projects, not in
the browser's stored settings).
