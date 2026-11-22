# EdgeDrawing

Turn an image into a single-line drawing that follows the image's edges: one
continuous line, made of straights and arcs, that a pen can draw without lifting
or a length of wire can be bent to.

- **Style:** filters applied to the image, in an order you choose, before its
  edges are found: *Median*, *Blur*, *Local contrast* (CLAHE), *Sharpen* and
  *Painterly* (an edge-preserving Kuwahara filter: it calms texture, so the
  edges left are the forms'). All off by default.
- **Edges & detail:** *Edge scale* is the size edges are looked for at (Canny's
  blur, in mm); *Edge amount* how many of the candidate edges start a line.
  *Smallest feature*: junctions closer than this merge, gaps narrower than this
  are bridged where the edge detector broke a line, and the lines are smoothed
  at about half of it. *Shortest line*: shorter lines, side branches and loose
  pieces are left out. *Simplify*: how far the simplified line may stray from
  the traced edge. Fine / Medium / Coarse set all five.
- **Edit edges** (Picture tab): *Erase* cuts away every edge within the eraser's
  radius of a stroke dragged on the preview; *Draw* adds a new edge along the
  stroke, an end that starts or stops on an edge joining it. Edits apply to the
  edges before they are joined, so the one line, its smoothing, bends and marks
  all follow; they are kept as strokes on the image and applied again whenever
  the settings change (a new canvas size or crop moves them with the picture), with Undo / Redo (Ctrl+Z / Ctrl+Y) and Clear, and saved in
  projects. A new image starts without them. The Edges view shows drawn edges in
  green.
- **One line** draws every edge without lifting (an Eulerian trail). Separate
  pieces are joined by the shortest bridges (preferring loose ends, which chains
  strokes end to end). Where edges branch, the line has to get back to a branch
  it has not drawn, by the shorter way: nearly always a new straight, as going
  back along the lines is longer unless they run straight there.
  - *Retrace lines instead of adding new ones* gets back over lines already
    drawn instead. With a pen a retraced line does not show, so far less of the
    line is outside the image, but it is much longer (half again on the
    photographs); in wire it is two wires side by side.
  - *Start*: automatic (the loose end nearest the top-left corner) or picked on
    the preview. *End where it starts* closes the line.
- **Line:** *Line width* (1.2 mm wire by default) and the *Smallest bend*
  radius (3 mm by default; 0 lets a pen turn on the spot). Every corner is rounded by an arc that
  passes within *Simplify* of it, and never tighter than the smallest bend; a
  corner that cannot get it is reported (the Problems view shows where), or with
  *Corner loops* on becomes a small loop round a circle of that radius. With a
  bend radius set, the edges are smoothed at two radii, since a line cannot bend
  round a smaller detail.
- **Smoothing** of the whole line:
  - *Steer it (PD)*, the default: the line is driven along the traced edges at
    constant speed, aiming a *Look ahead* distance ahead, its steering a PID
    controller (*P · D*, default 1 · 1, D at most 2; no integral term) on the heading error, its turning
    never tighter than the smallest bend (for a pen, a quarter of the look
    ahead). No corner can be tight; the line strays instead. A shorter look ahead
    follows closer, a longer one is calmer and loopier.
  - *Fourier smoothing*: wiggles shorter than a *Length scale* are taken out, the
    same everywhere; the ends of each stroke stay put. It does not hold to the
    bend: a longer scale leaves fewer tight places.
  - *Relax the whole line*: every point bending tighter than the smallest bend
    moves toward its neighbours, within *Stray at most* (needs a bend above 0).
  - *None*: straights and arcs fitted to the traced line as it is.
- **Experimental smoothing** (closed by default; with a bend above 0):
  - *Joins: curves at the bend (Dubins)*: every join becomes the shortest path
    that leaves a stroke the way it was going and meets the next stroke the way
    that one goes, never tighter than the bend.
  - *Through junctions: straightest pairing overall*: at every junction the
    ways in and out are paired straightest first, and the pieces spliced into one
    line, instead of choosing the straightest next step as it goes.
  - *Tight corners* left after the fit (not with steering, which leaves none):
    report them; *merge* a tight corner and its neighbours into one corner that
    has room; or *cut their points out* one by one, within *Stray at most* (the
    arcs too: a bend that would cut a sharp tip off by more is reported as tight
    instead).
  - *Edge smoothing: only where tighter than the bend*, instead of everywhere at
    two radii.
  - *Fewer bends, within* (off by default): the finished line is refitted as the
    fewest arcs that stay within this of it, none tighter than the smallest
    bend: about a tenth of the bends, but a steered line comes out wavy (it
    follows the steering's ripple) rather than in broad curves.
- **Making it by hand** (tool-agnostic): *Show distance ticks* marks the line
  every *Ticks every* (10 cm by default) with the TOTAL length so far, never the
  length since the last tick, so a slip at one bend does not shift the numbers
  after it. *Show bend numbers* numbers each bend in drawing order with its turn (R clockwise or L anticlockwise as the line runs, seen on
  the page, and its angle), a bar across the line where it starts. Labels are
  placed clear of the line and of each other where there is room. Bend numbers
  and the bend table are offered only with *Fewer bends* above 0: without it
  the line is thousands of short arcs.
- **Statistics:** length (how much draws the image's edges, goes over a
  line again, or is not in the image), bends, the tightest bend, places tighter
  than the smallest bend, loops, how far the line strays from the edges (at
  most and on average), crossings.

## Run it

No install. From this folder:

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

then open <http://localhost:8080/>. (Any static server works; the page only has to
be served over HTTP, not opened as a file.)

## Layout

The sidebar has three tabs: **Picture** (image, tone, style, canvas, edges &
detail), **Line** (joining, line width and bend, smoothing) and **Make** (marks
for making it, printout and files, and the line's statistics, collapsed). The
experimental settings show only with **Show experiments** in the header; while hidden, any
in use is named in a note on the Line tab.

Changing Tone or Style switches the preview to the Source view, and changing
Edges & detail to the Edges view, so the effect is in sight.

## Views

**Drawing** (the line at its true width, in your colours), **Route** (black: the
image's edges; orange: over a line again; blue: not in the image; a green ring
and arrow at the start, a red square at the end), **Overlay** (the line over the
image), **Edges** (what was found, before joining: loose ends orange, junctions
blue), **Source** (the image after Tone and Style) and **Problems** (red rings:
corners tighter than the smallest bend; orange dots: crossings). **▶ Draw** plays
the line from its start; the slider scrubs along it.

## Canvas

Width and height in mm or inches, or a paper or frame size (A5 to 16 × 20 in),
which turns to the image's orientation. Height 0 follows the image; a fixed
height crops the image to cover the drawing (it is never stretched). *Precision*
is the resolution the edges are found at: Rough draft (700 px on the long side, the
default), Draft (1000) or Normal (1600).

## Outputs

| Button | What |
| --- | --- |
| Print / PDF… | The statistics with a preview and how to draw it; the whole drawing on one page; the drawing at 1:1 split across pages that overlap by 10 mm, with the start and end marked, a 50 mm bar to check the scale, and (each ticked by default) the distance ticks and, with Fewer bends, the numbered bends and the bend table (each bend: where it starts along the line, its turn, radius and arc length). Print at 100%. |
| Bend table CSV | With Fewer bends: the same table, one row per bend. |
| Drawing SVG | The line at true size, as ONE path of straights (L) and arcs (A), stroked at the line width: for a plotter, or to import. |
| PNG | The current view. |

**Projects**: *Save project* writes the image (its original file) and every
setting, the start point included, to a `.edl.json` file; *Open project*
restores them and rebuilds the same drawing (it is deterministic).

Wire bending instructions (nail or peg layout, a bend table) are planned:
see `docs/TODO.md`.

## Verify

```
powershell -ExecutionPolicy Bypass -File run-tests.ps1
```

runs the harness (`verify.html`) in headless Chrome or Edge and prints every check;
`-Only core.route,pipeline` runs a subset. Or open
<http://localhost:8080/verify.html>. With node or deno available, `node run-tests.mjs`
does the same.

The structure (layers, the Style chain, the DOM-free harness) follows
PaintByNumbers, Photo2Mosaic and HalftoneCuttable; `docs/architecture.md` has the
invariants.
