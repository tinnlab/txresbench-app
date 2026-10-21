# Area selection vs. invisible points in `@ziee/viz` — empirical findings

Investigated 2026-07-27 against the running dev server on **:1478** serving
`/data/pbya/ziee/tmp/annotate-tooling-ux-wt/src-app/libs/viz` (module content verified to match
that worktree). **No product source was modified.** Instrumentation was done entirely by Playwright
route-interception of the *transformed* story modules plus the existing dev seams
`window.__VIZ_INCELL__` (per-cell `setRange` / `toggleCategory` / `hidden` / `domains`) and
`window.__VIZ_TEST__`.

Probe scripts: `/data/pbya/ziee/tmp/selvis/probe{1,2,3,4,5,6,7}.mjs`.

## Bench

Story `#plot-editing` (`src/showcase/stories/00c-plot-editing.story.tsx`) — one `<Viz>` grid, four
cells: `cat` (categorical scatter, `group`), `cont` (continuous scatter, `qcA`), `box`, `violin`.
Source = `FixtureSource({ seed: 7, pointCount: 20_000 })`.

Ground truth read straight from the same fixture in-page:

```
n = 20000
categories = ["Group 1".."Group 8"]
per-category totals = {0:2475, 1:2464, 2:2530, 3:2488, 4:2507, 5:2501, 6:2490, 7:2545}
qcA domain = [2001.224, 9999.934]
```

Story `#multi-datasource` (two datasets A/B on one deck, half-overlapping barcodes, identity space
`canonical`) for the identity-space question. Its stock cells carry no categorical `colorBy`, so a
legend hide is not drivable there — I route-injected
`colorBy: {mode:"categorical", key:"group", colormap:"viridis", scale:"linear", hidden:new Set()}`
onto both cells to make the mechanism reachable.

---

# 1. Does the invisibility mechanism actually work? (control)

Both mechanisms had to be proven to really make points invisible, otherwise the selection numbers
below would be measuring a no-op.

**Legend-hidden category** — hide is implemented as **alpha = 0 in the color buffer**, never as a row
filter. Measured directly by re-running the same colouring the grid runs:

```
computeColoring(hidden = ∅)     → {alpha0_total: 0,    cat4_total: 2507, cat4_alpha0: 0}
computeColoring(hidden = {4})   → {alpha0_total: 2507, cat4_total: 2507, cat4_alpha0: 2507}
```

⇒ every one of category 4's 2 507 points gets alpha 0. Pixel A/B of the `cat` pane
(649×419 = 271 931 px), 3 trials, deterministic once a forced rAF redraw precedes the capture:

```
hide cat 4  → changed px = [12453 (4.58%), 12453 (4.58%), 12453 (4.58%)]
```

**visualMap / `filters` range** — `GridWorkspace.tsx:2306-2322` stamps `masked[i*4+3] = 0` on a copy
of the colour buffer for every out-of-range point. With the range set to the middle 10 % of the
domain (`[5600.6, 6400.5]`) the `cont` pane's non-white pixels drop **81 248 → 29 859** (63 % of the
drawn ink removed).

Both mechanisms are genuinely visual, and both are alpha-only. No code path anywhere removes a row.

---

# 2. A. Are invisible points included in the selection?

## Mechanism 1 — legend-hidden category

Rect drawn over 10 %–90 % of the `cat` pane, then the *identical* rect with category 4 hidden:

| | selected | by category code |
|---|---|---|
| all shown | **17 789** | `{0:2475, 1:2462, 2:2143, 3:2488, 4:2507, 5:2389, 6:890, 7:2435}` |
| cat 4 ("Group 5") HIDDEN | **17 789** | `{0:2475, 1:2462, 2:2143, 3:2488, 4:2507, 5:2389, 6:890, 7:2435}` |

Byte-identical. **All 2 507 invisible points are in the selection.**

Polygon/lasso over the same region (4 vertices, committed via the rail's Finish):

| | selected | hidden-category members |
|---|---|---|
| cat 4 HIDDEN | **14 487** | **2 498** |
| all shown | **14 487** | 2 498 |

Byte-identical by-category breakdown in both directions (verified `hidden-vs-shown byte-identical: true`).

## Mechanism 2 — visualMap / `filters` value range

`cont` cell, range = middle 10 % of `qcA`'s domain (`[5600.6, 6400.5]`), so ~90 % of the points in
the pane are invisible:

| tool | selected | in-range (VISIBLE) | out-of-range (**INVISIBLE**) |
|---|---|---|---|
| rect 10–90 % | **17 789** (identical to the unfiltered sweep) | 1 805 | **15 984** |
| polygon | **14 487** | 1 433 | **13 054** |

**~90 % of every selection made on a filtered plot consists of points the user filtered away.**

### Verdict A
Invisible points are selected, in exactly the numbers they would contribute if visible, for **both**
mechanisms and **both** tools. The code read in the brief is confirmed: `areaGestures.ts` /
`SelectionController.ts` see only `cd.positions` + `cd.nPoints` (`GridWorkspace.tsx:2669`
`areaMask(area, cd.positions, cd.nPoints, commitCandidatesFor(area, index))`), and `cellData()`
returns the full, unfiltered buffers.

---

# 3. B. What does the USER see?

**There is no selection readout in the grid at all.** After a 16 958-point selection,
`document.body.innerText` contains no count; there is no badge, no status element. The rail exposes
only: `tool-pan, tool-select, sel-multi, sel-rect, sel-polygon, sel-move, sel-clear,
toggle-tooltips, toggle-link-zoom, toggle-cell-toolbars, export-grid`. Nothing communicates the size
of the selection, let alone how much of it is invisible.

**The highlight does not reveal the hidden members either — the hide wins.** Pixel A/B of hiding
category 4 *with a 16 958-point selection active* (which includes all 2 507 of that category):

```
no selection      : changed px = [12453, 12453, 12453]   (4.58 %)
selection ACTIVE  : changed px = [12435, 12435, 12435]   (4.57 %)
```

Identical. A selected-but-hidden point is **not drawn**. That matches the shader
(`ColormapScatterLayer.ts:214-218`): it only multiplies `vFillColor.a` by `dimOpacity` for
*unselected* points and never restores alpha, so `getSelected = 1` on an alpha-0 fill renders
nothing.

**Net user-visible consequence:** the only on-screen evidence that 15 984 invisible points joined the
selection is that the *visible* unselected points got dimmed. The selection's invisible majority is
completely silent.

**Where counts DO exist elsewhere, they are raw** (code-traced, not driven):

- `viz-core/selection/SelectableScatter.tsx:234` — `{selCount} selected`, from
  `useAreaSelection.tsx:153/166` `setSelCount(mask.count())` = raw geometric popcount.
- `viz-core/spatial/RasterUnderlayScatterView.tsx:537` — `{selCount} points in region`.
- `viz-core/spatial/regionSelect.ts:80-100` — `regionComposition()` tallies **every** selected
  index's group code, hidden ones included. A "what cell types are in this region" readout will
  therefore report categories the user has hidden.
- `src-app/ui/src/modules/workbench/panels/SelectionInspector.tsx:60` — `{sel.size} selected`, fed
  from the raw `pointSelection` via `workbench/selection/vizBrushBridge.ts:60`.
- a11y `viz-core/a11y/liveRegion.ts:38 announceSelection(count, total)` — raw count.

---

# 4. C. Downstream consumption — does anything re-filter?

**No. Nothing in `src/` intersects a selection with a visibility set.** (Greps for
`visibleMask|visibilityMask|isVisible|visibleIds|filterSelection|selectionVisible`, and for `hidden`
within ±3 lines of `pointSelection|selectionBySpace|highlightMaskFor`, come back empty;
`coordination/selectionSync.ts` and `data/selection.ts` contain no occurrence of "hidden".)

| consumer | verdict | evidence |
|---|---|---|
| **Linked pane / linked cell** | does NOT re-filter; point is counted but invisible | `GridWorkspace.tsx:2333-2346` → `highlightMaskForIds` (`selectionSync.ts:212-223`) maps id→row only. Alpha-0 wins in the shader (§3). |
| **Data table** (`buildPlotDataTable`, `GridWorkspace.tsx:2564-2620` → `PlotDataTable.tsx`) | filters by **viewport bounds only** — ignores selection, `perCellHiddenCodes` AND `perCellRange` | `:2610 if (x >= minX && x <= maxX && y >= minY && y <= maxY)`. A hidden or out-of-range point is still a row. (`PlotDataTable.tsx:28`'s "already visible-filtered rows" comment is true only w.r.t. the camera.) |
| **Export — manifest** | records filters as **provenance metadata only** | `export/manifest.ts:48-52` `filters: {valueRange, hiddenGroups, link}`, assembled at `GridWorkspace.tsx:4401-4412`. Filters nothing; never sees the selection. |
| **Export — selection CSV** | raw ids | `export/data.ts:31-36 selectionToCSV(mask)` dumps `mask.toIndices()`. Note: the grid mounts `<ExportDialog>` **without** a `mask`/`table` prop (`GridWorkspace.tsx:4519-4537`), so the grid's CSV path currently emits nothing from the selection at all. |
| **Export — image / vector** | IS WYSIWYG | `GridWorkspace.tsx:4489` re-applies the same alpha-0 range mask before `scatterToVectorScene`. Pixels only, not the selection. |
| **`getOption()` / persist** | raw ids | measured below |
| **`colorBySelection`** | N/A — misnomer | `Coordination.store.ts:88-93` is the shared **color-by COLUMN** dropdown, unrelated to `pointSelection`. There is no "color by the current selection" feature in this package. |
| **Grouped charts** (Box/Bar/Violin) | do NOT re-filter | `ViolinView.tsx:441` gates only on the declarative `consumesSelection` capability; `:445-451` highlights over the raw selection. Hidden groups are dropped at *layout* time (`visibleByCode`, `BoxView.tsx:323/417`) — so a selected point in a hidden group emphasises a group with no mark, and nothing is subtracted from any statistic. `ViolinView.tsx:407` alpha-0s hidden dots and the highlight layer reuses that buffer ⇒ alpha-0 wins there too. |

### Measured `getOption()` payload

After a rect selection on `cat`, then hiding category 4, then setting the `cont` visualMap range:

```
getOption().selection.ids            = 16958 ids
   … of which 2507 belong to the HIDDEN category 4
   … and     15239 are outside the active visualMap range
getOption().series[*].encode.colorBy.hidden = [["cat",[4]], ["cont",null], ["box",null], ["violin",null]]
getOption().filters                  = null          ← the visualMap range does NOT round-trip
onChange fire count: 1 → 3 after the category hide → still 3 after setRange
```

Two things fall out. The persisted selection is the raw id set including the invisible members. And
the in-cell scatter visualMap range **never reaches `option.filters`** — it does not even fire
`onChange` — so a saved/restored figure carries a selection whose composition cannot be explained
from the saved state.

---

# 5. D. The inverse — select first, THEN hide / narrow

| step | selection | by category |
|---|---|---|
| rect on `cat`, nothing hidden | **17 789** | `{0:2475,1:2462,2:2143,3:2488,4:2507,5:2389,6:890,7:2435}` |
| hide category 4 (no new gesture) | **17 789** | identical, index-by-index (`identical to pre-hide: true`) |
| narrow the `cont` visualMap range (no new gesture) | **17 789** | unchanged |

The selection **keeps** the points and goes silently stale. It does not shrink, is not invalidated,
does not re-emit, and the count does not change — there is no count to change. Meanwhile the hidden
members disappear from the plot (§3), so the on-screen picture and the selection set diverge with
zero signal.

---

# 6. E. Identity spaces

`#multi-datasource` (shared barcodes: A = ids 0..7999, B = half overlapping), sub-region sweeps
chosen so the counts are *not* saturated:

```
sweep B (cell-2), nothing hidden          : canonicalLen=2062  aLit=1008  bLit=2062
sweep A (cell-1), nothing hidden          : canonicalLen=2096  aLit=2096  bLit=1037
hide category 0 in cell-1  (space A only) : __VIZ_INCELL__.hidden = {"cell-1":[0]}
sweep B (cell-2), cat 0 hidden in A       : canonicalLen=2062  aLit=1008  bLit=2062
sweep A (cell-1), cat 0 hidden in A       : canonicalLen=2096  aLit=2096  bLit=1037
```

**Hiding a category in space A has no effect on a selection made in space B — and none on a selection
made in space A either.** Cross-space isolation is intact (a sweep in A lights 2096 in A and only
1037 in B, exactly the barcode overlap). Consistent with §2: a hide never touches a selection
anywhere.

Caveat: this required injecting a categorical `colorBy` into the story's two cells, because the stock
`#multi-datasource` cells have no legend. The *selection* path was untouched.

---

# 7. ASSESSMENT — defensible vs. surprising

*(Separate from the measurements above. This section is opinion, argued.)*

## DEFENSIBLE

1. **E — hiding in space A not affecting a selection in space B.** Unambiguously correct. Spaces are
   an identity boundary; visibility is a per-pane display state. Nothing to fix.
2. **The geometric core being visibility-blind.** `areaGestures.ts` / `SelectionController.ts` should
   be pure geometry over `positions`; keeping visibility out of them is good layering. The problem is
   that *no layer above them* applies visibility either — the purity of the bottom layer is not the
   defect, the absence of a policy layer is.
3. **Image / vector export being WYSIWYG** while the selection is not. Different products: the
   picture is what you see, the selection is a set of records. Both defensible, but only if the UI
   says so.
4. **Alpha-0 winning over the selection highlight in the renderer.** Given the current design, a
   selected hidden point *should* stay hidden — the alternative (a selection resurrecting a category
   the user hid) would be worse. This is locally right and globally symptomatic: it is exactly the
   mechanism that makes the invisible members of the selection unobservable.
5. **Arguably** — "a lasso selects the region, not the pixels" is a coherent semantics, and matching
   e.g. ECharts' "legend hide is a display toggle" convention is defensible **if it is communicated**.
   Today it is communicated nowhere, which forfeits the defence.

## SURPRISING — and #1 I'd call a genuine defect

1. **The `filters` / visualMap case is a defect, not a design choice.** Measured: a range narrowed to
   10 % of the domain leaves ~10 % of the points visible, and a lasso over the remainder returns
   **17 789 points of which 15 984 (90 %) are ones the user filtered out**. The distinction that
   makes this different from the legend case: the option field is literally named `filters`, its type
   doc calls it a "continuous FILTER clamp", and the affordance is a range **filter** in the edit
   form. A control called *filter* that does not filter the thing the user then acts on is a broken
   promise, not a convention. If a scientist gates on a QC metric and lassos a cluster, they will
   ship a gate that is 90 % ungated cells.

2. **Zero feedback anywhere in the grid.** No count, no badge, no "N of M selected are hidden". Add
   the alpha-0-wins rendering and the invisible members are *unobservable by any means the UI
   offers*. Even the standalone surfaces that do show a count show the raw one, and
   `regionComposition()` (`regionSelect.ts:80-100`) reports a region's category composition
   *including hidden categories* — that is precisely the readout a user would trust to tell them what
   they just selected.

3. **The staleness in D.** Selecting, then hiding, silently decouples the set from the picture, with
   no invalidation and no re-emit. Whatever the selection-time policy is, an *already-committed*
   selection quietly meaning something different from what is drawn is hard to defend.

4. **The data table showing hidden / out-of-range rows.** It filters by camera bounds only, while its
   own comment claims "already visible-filtered rows" (`PlotDataTable.tsx:28`). The user reads it as
   "the data behind this plot".

5. **`option.filters` never populated by the in-cell scatter visualMap** (measured: `null`, no
   `onChange`). Adjacent bug, but it compounds #1: the saved figure keeps the selection and drops the
   filter that explains it, so a restored session cannot even reconstruct why the numbers look the
   way they do.

### Shape of a fix (not implemented, not requested)
The cheapest honest fix is not to change the mask — it is to **report** it: publish the selection
alongside a visible/hidden split and surface it (`N selected (M hidden)`), and let the user choose the
policy per mechanism (legend hide → keep, value filter → exclude, is my prior). Making
`option.filters` actually round-trip is a prerequisite for the second half.

---

# 8. Not determined / inferred (flagged, not asserted)

- **The ziee workbench app surfaces** (`SelectionInspector`, `vizBrushBridge`) were code-traced only;
  I did not boot the app and drive them. The trace says raw ids, but that is a read, not a
  measurement.
- **`filteredSource` identity mismatch** — `data/filteredSource.ts:55` re-indexes surviving points
  into a collapsed `0..K-1` space but passes `pointIds` through unchanged, and
  `installBuiltins.tsx:110` never hands `pointIds` to `ViolinView`. Under an active
  `linkValueFilters` a violin would consume canonical ids as if they were collapsed local rows
  (`ViolinView.tsx:449`). This is an **identity** bug, not a visibility one, and it is **inferred
  from reading** — I did not build a repro and found no test covering it. Treat as suspicious, not
  confirmed.
- **Why probe4 briefly disagreed** with probe5/6 on the pixel A/B (313 px vs 12 453 px for the same
  hide): stale WebGL backbuffer capture. Forcing two rAFs plus a 250 ms settle before
  `page.screenshot` made it deterministic across 3 trials in both conditions. All pixel numbers
  quoted here come from the forced-redraw path (`probe6.mjs`); probe4's reading is discarded.
