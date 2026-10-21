# Selection provenance — design

**Status:** design, approved in principle by the owner 2026-07-27.
**Scope:** `@ziee/viz` (`viz-core/selection`, `viz-core/option`, `adapter`) +
`@cyto/workbench-api` (`dsl/`, `interaction/vizBridge.ts`). **No server change.**
**Evidence base:** [`selection-visibility-findings.md`](./selection-visibility-findings.md)
(measured 2026-07-27 on `#plot-editing`, `seed:7, pointCount:20000`).

---

## 1. The problem

An area selection today returns an undifferentiated bag of integers.
`VizSelection` (`src/viz-core/option/types.ts:98-109`) carries exactly:

```ts
export interface VizSelection {
  readonly mode: VizSelectionMode                        // 'lasso' | 'rect'
  readonly link: readonly string[]
  readonly ids?: readonly number[]
  readonly spaces?: Record<string, readonly number[]>
}
```

Meanwhile `SelectionController` (`src/viz-core/selection/SelectionController.ts`)
**already holds everything you would want**:

- `entries: AreaEntry[]` — "The ordered list of drawn areas" (`:164`), each an
  `Area` = `{kind:'rect', box:[x0,y0,x1,y1], mode}` or
  `{kind:'polygon', polygon:[[x,y],…], mode}` in **world coordinates**, with
  `mode: CombineMode = 'add' | 'subtract' | 'intersect'` (`:79-95`).
- `recompute()` (`:221-240`) folds every area **in draw order** into a fresh mask
  through the packed-bitmask set-ops — i.e. **the re-derivation engine already
  exists**; it is simply per-controller and never crosses the API boundary.
- `undo()` / `updateArea()` (translate + re-hit-test) / committed outlines that
  persist in world coords and track pan/zoom (`:24-27`).

The grid keeps the same structure per pane in
`committedByCell: Record<string, Area[]>` (`GridWorkspace.tsx:2471`), commits
through `commitRect`/`commitPolygon` (`:2657`/`:2681`), and publishes through
`publishCellAreas` → `publishCellSelection` (`:2641`/`:2623`), which maps local
rows to canonical ids (`mapRowsToIds`) and writes one identity space
(`setSelection` for `DEFAULT_SELECTION_SPACE`, else `setSelectionInSpace`).

**None of it crosses the API boundary.** `getOption()`
(`adapter/VizController.ts:421-441`) emits `mode`/`link`/`ids`/`spaces` and
nothing else. The geometry, the combine ops, the pane, and the view state that
explains the numbers are all discarded at the boundary.

### Measured consequences

1. Selection includes legend-hidden and `filters`-excluded points. This is
   **intentional** — see §2, INV-1. Not a defect, not to be "fixed".
2. **It rots silently.** Selecting, then hiding a category or narrowing a
   `visualMap` range, leaves the id list **byte-identical**
   (17 789 → 17 789, index-for-index) with no re-evaluation, no invalidation,
   no re-emit. The on-screen picture and the selection set diverge with zero
   signal. (findings §5)
3. **A saved figure cannot answer "how did I get this set?"** — the polygon is
   never persisted. `getOption()` returns 16 958 opaque integers.
4. **The downstream provenance chain is starved.** The app's provenance
   subsystem already accepts a *reproducible recipe* over a rich predicate DSL
   (§3) with `inPolygon` / `inBox` / `idList` / `union` / `intersect` /
   `difference` nodes — and the viz API physically cannot produce one, so a
   captured viz selection can only ever degrade to
   `selection.freehand` = `mask = adata.obs_names.isin([…200 000 ids])`.

---

## 2. The owner's ruling — two decisions, both binding

**(a) Reports-everything (2026-07-27, after the measured investigation).**

> *"in the api, the selection should report everything."*

An area selection returns EVERY point geometrically inside the region —
including legend-hidden points and points clamped out by `visualMap` /
`option.filters`. The consumer partitions; the library does not impose a policy.
**This design does not change that contract.**

**(b) Full provenance + re-evaluable.** A selection becomes a **predicate with a
cache, not a materialized list**:

```
selection: {
  ops:     [{ tool:'rect',    region:[…], op:'add',      space:'s0' },
            { tool:'polygon', region:[…], op:'subtract', space:'s0' }],  // ordered
  context: { filters: {qcA:[4000,5000]}, hidden: {cat:[4]} },            // AT selection time
  ids:     [ … ]                                                        // CACHE, re-derivable
}
```

Requirements, verbatim from the owner:

- the ordered op list — tool, geometry, combine op, identity space, **and which
  pane/series it was drawn on**;
- the filter + hidden-category context at selection time;
- `ids` retained as a cache so existing consumers keep working;
- the selection **re-derivable against changed data/filters instead of going
  stale**.

---

## 3. The downstream contract this must feed (do not invent a parallel scheme)

The app already owns a complete selection-provenance chain. This design's job is
to make viz able to **produce** for it, not to reinvent it.

| Layer | Symbol | Path |
|---|---|---|
| Predicate AST (the vocabulary) | `CellSetPredicate` | `src-app/libs/workbench-api/src/dsl/predicate.ts` (`dslVersion = '1.1.0'`) |
| Versioned recipe envelope | `SelectionRecipe {predicate, inputs, axisVersion, evaluatorVersion, dslVersion, kind}` | `libs/workbench-api/src/interaction/recipe.ts` ⇄ `server/src/modules/predicate/recipe.rs` |
| Recipe minting route | `POST /api/selection/by-predicate` → `ByPredicateResponse.recipe` | `server/src/modules/predicate/handlers.rs` |
| Capture route | `POST /api/provenance/selections` (`RecordSelectionRequest{project_id, input_artifact_id, recipe, label}`) | `server/src/modules/provenance/{routes,models,interaction}.rs` |
| Action registry | `selection.polygon` / `selection.setop` / `selection.freehand`, all `Declarative` + `dispatchable` | `server/src/modules/provenance/action_registry.rs:29-42` |
| **The dead viz seam this design revives** | `applyVizLasso(runtime, coords, polygon)` — "Route B (durable)" | `libs/workbench-api/src/interaction/vizBridge.ts:58-65` |

`CellSetPredicate` already carries **every node an op list needs**:

```ts
| { inPolygon: { coords: string; polygon: Array<[number, number]> } }
| { inBox: { coords: string; dims?: [number, number]; bounds: [[number,number],[number,number]] } }
| { idList: { ids: number[] } }
| { union: CellSetPredicate[] } | { intersect: CellSetPredicate[] }
| { difference: [CellSetPredicate, CellSetPredicate] }
```

So the mapping is **exact and requires no server edit**:

| viz op | `CellSetPredicate` node | `deriveKind` ⇒ | registry |
|---|---|---|---|
| `tool:'rect'` | `inBox` | `polygon` | `selection.polygon` ✅ |
| `tool:'polygon'` | `inPolygon` | `polygon` | `selection.polygon` ✅ |
| `tool:'ids'` | `idList` | `freehand` | `selection.freehand` ✅ |
| `op:'add'` fold | `union` | `setop` | `selection.setop` ✅ |
| `op:'subtract'` fold | `difference` | `setop` | `selection.setop` ✅ |
| `op:'intersect'` fold | `intersect` | `setop` | `selection.setop` ✅ |

**Guard:** the lifter must NEVER emit `{op, args}` — `deriveKind` maps it to
`'op'`, and `selection.op` is absent from `action_registry::catalog()`, so
`capture_selection` rejects it with `PROVENANCE_ACTION_NOT_DISPATCHABLE` (400).

**Two known gaps in the downstream envelope** (identity **space** and the
filter/hidden **context** have no slot in `SelectionRecipe`). This design holds
both in the **viz option** — which satisfies the owner's requirement — and
DESCOPES extending the server envelope to a named follow-on (§7). Nothing here
depends on that follow-on.

---

## 4. The schema

```ts
/** How one op folds into the running selection — 1:1 with `SelectionController.CombineMode`. */
export type VizSelectionCombine = 'add' | 'subtract' | 'intersect'

/** ONE recorded selection op. `pane` is the grid cell it was drawn on — that pane's WORLD
 *  coordinates are the region's frame. `space` is the identity space the resulting ids land in. */
export type VizSelectionOp =
  | { tool: 'rect';    op: VizSelectionCombine; pane: string;        space: string
      region: readonly [number, number, number, number] }              // [x0,y0,x1,y1], world
  | { tool: 'polygon'; op: VizSelectionCombine; pane: string;        space: string
      region: readonly (readonly [number, number])[] }                 // world ring
  | { tool: 'ids';     op: VizSelectionCombine; pane: string | null;  space: string
      region: readonly number[] }                                      // canonical ids

/** The display + data state AT SELECTION TIME. Vocabulary is byte-identical to the option's own
 *  `filters` / `encode.colorBy.hidden` and to `FigureManifest.filters` (`export/manifest.ts:48`). */
export interface VizSelectionContext {
  readonly filters?: Record<string, readonly [number, number]>  // plot id -> [lo,hi]
  readonly hidden?: Record<string, readonly number[]>           // plot id -> sorted category indices
  /** Per-pane content hash of the plotted world positions. It is BOTH the staleness detector
   *  AND the `coords` a downstream recipe pins as its embedding identity. */
  readonly panes?: Record<string, string>
}

export interface VizSelection {
  readonly mode: VizSelectionMode
  readonly link: readonly string[]
  readonly ids?: readonly number[]                             // UNCHANGED — now documented as a CACHE
  readonly spaces?: Record<string, readonly number[]>          // UNCHANGED — now documented as a CACHE
  readonly ops?: readonly VizSelectionOp[]                     // NEW — ordered provenance
  readonly context?: VizSelectionContext                       // NEW — state at selection time
  readonly provenance?: 'ziee-viz-selection/1'                 // NEW — schema tag
}
```

**Vocabulary note.** `tool` uses `'polygon'`, not `'lasso'` — it is 1:1 with
`SelectionController.Area.kind`, which is the substrate re-derivation runs on.
`VizSelection.mode` (`'lasso' | 'rect'`) is a separate, pre-existing axis (the
default gesture) and is untouched.

**Identity spaces — one list, per-op tag (not per-space lists).** A region lives
in exactly ONE pane's world coordinates, and a pane determines its space
(`cellSelectionSpace(cell, hasPointIds)`; `GridWorkspace.tsx:2639`). So a
per-op `space` tag is *complete*, and per-space grouping is a **derivation**, not
a parallel structure. This also matches the existing storage
(`committedByCell` is already per-pane) and keeps cross-space isolation
structural: re-derivation folds ops per pane, maps rows→canonical ids, and
unions only *within* a space.

---

## 5. Re-derivation

`deriveSelection(ops, resolvePane)` reproduces `{ids, spaces}` from `ops` alone:

1. group ops by `pane`, preserving order;
2. per pane, fold each op's `areaMask` into a running `IndexMask` honoring
   `add`→union / `subtract`→difference / `intersect`→intersect (the *same*
   semantics as `SelectionController.recompute()`);
3. map local rows → canonical ids via the pane's `pointIds`;
4. union per **space** across panes.

This is a pure function of `(ops, positions, pointIds)` — no React, no deck.gl —
so it is directly unit-testable, exactly like `SelectionController`.

**Staleness** is detected by comparing `context.panes[pane]` (the recorded
positions hash) against the live hash. A pane whose data changed makes the
selection `stale-data`; a changed `filters`/`hidden` makes it `stale-context`.

---

## 6. Non-negotiables (lifted as the plan's invariants)

- **N1.** *"in the api, the selection should report everything"* — an area
  selection returns EVERY point geometrically inside the region, including
  legend-hidden and `filters`-excluded ones. This feature does not change that.
- **N2.** `ops` + `context` re-derive the cached `ids` EXACTLY — the cache is
  never a source of truth that disagrees with its provenance.
- **N3.** *"A selection in space A never bleeds into space B."*
  (`option/types.ts:107`, verbatim) — cross-space isolation is verified working
  today (hide in A leaves B at 2062→2062) and must not regress.
- **N4.** `selection.ids` is read by existing consumers; it must keep working
  unchanged.
- **N5.** An option without `ops` still parses. Every provenance field is
  OPTIONAL and ADDITIVE; `VIZ_OPTION_VERSION` does not move.
- **N6.** `setOption(getOption())` restores ops + context AND reproduces the
  same ids.
- **N7.** The selection is a **predicate with a cache, not a materialized
  list** — an option carrying `ops` but NO `ids` still yields the correct live
  selection.

---

## 7. Explicitly out of scope this round

- Extending the server-side `SelectionRecipe` envelope with `space` /
  `context` slots (`predicate/recipe.rs` + its TS mirror + the
  `stamp_versioned_recipe` re-stamp). The gap is real (§3) and named; the viz
  option holds both today and the lifter degrades gracefully without them.
- A selection READOUT surface (a count / "N selected, M hidden" badge). The
  findings call this out (§3 of the findings) and `partitionSelection` is
  designed for it, but the UI is a separate round.
- Making the in-cell scatter `visualMap` range populate `option.filters` — a
  genuinely separate round-trip defect owned by `fix/visualmap-filters-roundtrip`.
  This design deliberately reads the **live** `perCellRange` state, so it is
  correct with or without that fix.
- Any change to the "reports everything" contract (N1).
