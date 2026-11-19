# EdgeDrawing

Turn an image into a single-line drawing that follows the image's edges: one
continuous line, made of straights and arcs, that a pen can draw without lifting
or a length of wire can be bent to.

- **Style:** filters applied to the image, in an order you choose, before its
  edges are found: *Median*, *Blur*, *Local contrast* (CLAHE), *Sharpen* and
  *Painterly* (an edge-preserving Kuwahara filter, on by default: it calms
  texture, so the edges left are the forms').
- **Edges & detail:** *Edge scale* is the size edges are looked for at (Canny's
  blur, in mm); *Edge amount* how many of the candidate edges start a line.
  *Smallest feature*: junctions closer than this merge, gaps narrower than this
  are bridged where the edge detector broke a line, and the lines are smoothed
  at about half of it. *Shortest line*: shorter lines, side branches and loose
  pieces are left out. *Simplify*: how far the simplified line may stray from
  the traced edge. Fine / Medium / Coarse set all five.
- **One line**, two ways:
  - *Trace through (Eulerian)* draws every edge without lifting. Separate pieces
    are joined by the shortest bridges (preferring loose ends, which chains
    strokes end to end). Where edges branch, the line has to get back to a
    branch it has not drawn: *over a line again* (retracing: hidden on paper,
    two wires side by side in wire), *by a new straight*, or *whichever is
    shorter* (the default).
  - *Jump between (TSP)* draws each edge once, in the shortest order it can
    find, jumping straight from the end of one to the start of the next.
  - *Start*: automatic (the loose end nearest the top-left corner) or picked on
    the preview. *End where it starts* closes the line.
- **Line:** *Pen* or *Wire* sets the line width and the smallest bend radius
  (0.5 mm and none; 1.2 mm and 3 mm). Every corner is rounded by an arc that
  passes within *Simplify* of it, and never tighter than the smallest bend; a
  corner that cannot get it is reported (the Problems view shows where), or with
  *Corner loops* on becomes a small loop round a circle of that radius. With a
  bend radius set, the edges are smoothed at two radii, since a line cannot bend
  round a smaller detail.
- **Keeping to the bend (experiments, with a bend radius above 0):**
  - *Joins: curves at the bend (Dubins)*: every join becomes the shortest path
    that leaves a stroke the way it was going and meets the next stroke the way
    that one goes, never tighter than the bend.
  - *Through junctions: straightest pairing overall*: at every junction the
    ways in and out are paired straightest first, and the pieces spliced into one
    line, instead of choosing the straightest next step as it goes.
  - *Tight corners*: report them; *merge* a tight corner and its neighbours into
    one corner that has room; *cut their points out* one by one; or *relax the
    whole line* toward the bend. Each keeps within *Stray at most* of the traced
    edges (the arcs too: a bend that would cut a sharp tip off by more is
    reported as tight instead). Two more, controlled by their own settings
    instead of the stray: *Fourier smoothing* takes out wiggles shorter than a
    *Length scale*; *Steer it (PID)* drives the line along at constant speed,
    turning no tighter than the bend, aiming a *Look ahead* distance along the
    traced line with P, I and D gains: never tight, only stray.
  - *Smoothing: only where tighter than the bend*, instead of everywhere at two
    radii.
- **The line's figures:** length (how much draws the image's edges, goes over a
  line again, or is not in the image), bends, the tightest bend, corners tighter
  than the smallest bend, loops, how far the line strays from the edges (at
  most and on average), crossings.

## Run it

No install. From this folder:

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

then open <http://localhost:8080/>. (Any static server works; the page only has to
be served over HTTP, not opened as a file.)

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
is the resolution the edges are found at: 700 to 2400 px on the long side.

## Outputs

| Button | What |
| --- | --- |
| Print / PDF… | The figures with a preview and how to draw it; the whole drawing on one page; the drawing at 1:1 split across pages that overlap by 10 mm, with the start and end marked and a 50 mm bar to check the scale. Print at 100%. |
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
