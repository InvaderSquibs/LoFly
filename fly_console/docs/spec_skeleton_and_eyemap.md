# Fly Console — real skeleton edges + optic-lobe hex map

Two additions to `fly_console/`, written for Cursor to implement directly on
this machine (it has normal network access to the public GCS bucket below;
the Claude sandbox that produced everything else in this repo does not —
confirmed by testing, not assumed).

Both are **console-level** (shared), not activity-specific: they belong next
to `js/console.js` / `js/experience.js`, not inside `activities/ttt/` or
`activities/perception/`.

---

## Part A — Real traced neuron skeletons (replace synthetic edges)

### What's real vs. what we're replacing
MaleCNS v1.0's own tables (`body-annotations-*.feather`,
`connectome-weights-*.feather`) give one soma point and an aggregate
pre→post synapse weight per neuron pair — no traced path. Every 3D edge
built so far (in `ttt_visualizer.html` / `ttt_visualizer_template.html`,
outside this repo) is a synthetic curve between two soma points. Janelia
separately publishes the **actual traced skeleton** for every segmented
body as an SWC file. This spec swaps the synthetic curves for that real
geometry.

### Data source
- Bucket: `gs://flyem-male-cns/v1.0/segmentation/skeletons-malecns/skeletons-swc/`
- Public HTTP path per neuron:
  `https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/skeletons-malecns/skeletons-swc/<bodyId>.swc`
- License: CC-BY. No auth required.
- **Before bulk-fetching**: `curl -I` one known file first to confirm this
  machine's network reaches it directly (e.g. bodyId `10975`, ~347KB,
  already spot-checked from a browser). If a plain `curl`/`requests` GET
  works here, do the bulk pull with a normal script — no browser
  automation needed. If it 403s here too, stop and report back rather than
  finding a workaround.
- SWC format: `#`-prefixed comment/header lines, then rows
  `node_id type x y z radius parent_id` (parent_id = -1 for the root/soma
  node). Coordinates are in the same MaleCNS voxel space as `somaLocation`
  in the annotations feather — sanity-check by confirming a neuron's SWC
  root node coordinate is close to its `somaLocation` before trusting
  alignment with the existing `ttt_3d_data.json` point cloud.

### Scope
Body IDs to fetch = the bodyIds already touched by the current edge set —
recover them from `ttt_brain.py`'s `node_ids` array / `ttt_edges_data.json`
(~2,578 neurons) if we're only replacing existing edges, or all `bodyId`
values in `body-annotations-male-cns-v1.0-minconf-0.5.feather` (5,185 rows)
if this is meant to become a complete skeleton atlas. Default to the
~2,578 that are actually used today unless told otherwise — no reason to
pull 2x the data for neurons nothing currently renders.

### Decimation (required — do not skip)
A full skeleton can have hundreds to thousands of nodes; thousands of
neurons at full resolution will blow the same GPU draw-call budget that
already forced edge-count cuts in the current renderer (measured: ~7 FPS
at 9,600 straight-line segments in headless Chromium, ~22 FPS after
cutting to 6,250 + disabling antialiasing). Real skeletons must be
decimated per neuron before going anywhere near Three.js:
1. Parse the SWC tree (respect `parent_id` branching — do not just take
   every Nth row, that breaks branch topology).
2. Keep every branch point (a node with >1 child) and every leaf.
3. Between branch/leaf points, collapse straight-ish runs with a tolerance-
   based simplification (Ramer–Douglas–Peucker, tolerance ~1-2 voxels is a
   reasonable start) so gentle curves survive but redundant collinear
   points don't.
4. Target: each neuron reduced to on the order of 15-40 points total. Log
   the before/after point count per neuron so we can see the real
   compression ratio before committing to a final budget.

### Output
A new JSON, e.g. `fly_console/data/neuron_skeletons.json`:
```json
{
  "<bodyId>": { "points": [[x,y,z], [x,y,z], ...] },
  ...
}
```
One polyline per neuron for a first pass (branches flattened into one
ordered path via a depth-first walk) is fine — do not build a full
multi-branch renderer unless the flattened version looks visibly wrong.

### Rendering
New shared module `fly_console/js/skeleton3d.js` (Three.js via the
existing cdnjs pattern already used elsewhere in this project — check
`ttt_visualizer_template.html` for the exact version pinned there and
reuse it, don't pick a new one):
- Loaded by `console.js` once, mounted into a new panel (not
  `#activitySlot`, which is activity chrome — add a sibling panel section
  in `index.html`, same pattern as the existing `<section class="panel">`
  blocks).
- Build one `THREE.Line`/`LineSegments` per neuron from its decimated
  `points` array.
- Reuse the existing per-vertex alpha-fade + firing-state brightness logic
  from `ttt_visualizer_template.html` (`updateEdgeAlpha`, the jittered
  fade-along-curve approach) rather than re-deriving it — the geometry
  source is changing, the lighting behavior on top of it does not need to.
- Drive "which neuron is lit" the same way the shell already drives
  cascade/raster: off `stateData` from the loaded `experience.json`, via
  whatever per-neuron/per-stage rate data is already in `rate_curves` /
  `raster`.

---

## Part B — Optic-lobe hex map ("population spatial coverage")

This is the panel at
https://reiserlab.github.io/celltype-explorer-drosophila-male-cns/types/T4a.html
under "Population spatial coverage" — one hexagon per optic-lobe column,
shaded orange→dark red by a per-column value.

### Data — already local, no fetch needed
`body-annotations-male-cns-v1.0-minconf-0.5.feather` already has the exact
columns this needs:
- `assignedOlHex1`, `assignedOlHex2` — integer axial hex-column coordinates
  (confirmed: 23,720 of the 211,577 rows have both set, range 1-36 and
  1-39, all with `superclass == "ol_intrinsic"` — i.e. only optic-lobe
  intrinsic neurons carry a column assignment; everything else is
  legitimately outside this map, not missing data).
- `bodyId`, `type` — for filtering/grouping by cell type the way the
  reference site does per-type.

### Honest scope note
None of our current activities (tic-tac-toe, odor perception) drive
optic-lobe neurons — the board/odor encoding maps to ORN glomeruli and
descending neurons, not `ol_intrinsic` cells. So this panel is **not**
live-firing data tied to the replay like cascade/raster are. Build it as a
static anatomical reference panel — "where in the optic lobe does cell
type X sit" — colored by neuron count or synapse count per column for a
selected type. Do not present it as reacting to the current experience
state; it doesn't, and pretending otherwise is exactly the kind of thing
that got called out before.

### Geometry
Standard axial-hex-to-pixel conversion using `assignedOlHex1`/`2` as axial
(q, r) coordinates:
```
x = size * (3/2 * q)
y = size * (sqrt(3)/2 * q + sqrt(3) * r)
```
(flat-top hexagons, matching the reference site's look). Render as plain
SVG `<polygon>` hexagons — consistent with the rest of `experience.js`,
which is SVG-only; no need to pull WebGL into this panel.

### Output + module
- Small prep step (Python, one-off or folded into `activities/export_all.py`
  as an optional extra): group by `assignedOlHex1`/`2` (optionally filtered
  to one `type`), count neurons/synapses per column, emit
  `fly_console/data/optic_lobe_hexmap.json`:
  ```json
  { "type": "T4a", "columns": [{"q":12,"r":19,"value":314}, ...] }
  ```
- New shared module `fly_console/js/eyemap.js`: axial→pixel layout above,
  SVG hex rendering, orange/red sequential color scale keyed off `value`
  (reuse whatever color-scale helper already exists in `experience.js`, or
  a simple linear interpolation between two CSS custom properties if none
  exists).
- Mount point: another new sibling `<section class="panel">` in
  `index.html`, own `<h2>`, own small type-picker if more than one type is
  worth showing initially (T4a is a fine default given it's already
  spot-checked).

---

## Integration checklist
- [ ] One `curl`/`requests` test against a known SWC URL before any bulk
      pull — confirm this machine's network path is actually unblocked.
- [ ] SWC bulk fetch + decimation script, logs point-count compression
      per neuron.
- [ ] `neuron_skeletons.json` written under `fly_console/data/`.
- [ ] `skeleton3d.js` mounted as its own panel in `index.html`, reusing the
      existing fade/brightness shader logic.
- [ ] Hex-column aggregation script reading the existing feather file
      (no network).
- [ ] `optic_lobe_hexmap.json` written under `fly_console/data/`.
- [ ] `eyemap.js` mounted as its own panel in `index.html`.
- [ ] Both panels load correctly under `python3 -m http.server` from
      `fly_console/` (same serving requirement `console.js` already
      documents for `fetch()` to work).
