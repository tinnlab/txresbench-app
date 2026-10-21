# Viz Session State — Save / Restore Exactly (data-independent snapshot)

## Goal

The app holds the **data**; the viz holds the **visualization state** (zoom, pan, filter,
selection, grid layout, per-cell config, color overrides). We want to **save that state exactly**
and later **restore it exactly**: user picks a saved state → the app re-fetches the data by id →
hands the viz `{ data, snapshot }` → the viz comes back byte-for-byte (same zoom, same selection,
same filters, same overrides, same grid).

The snapshot is **data-independent**: it references data only by **stable identifiers**
(dataset id, column keys, coordinate-space keys, and selection as **canonical point-IDs** — never
the row bytes, never array indices). So the same snapshot restores against a re-fetch even if row
order differs, and can be shared across sessions/users.

## Current state (what already serializes, what's a gap)

**Already in serializable stores (the foundation):**
- **`adapter/GridWorkspace.store.ts`** → `layout` (tree) + `cells` (each cell's full config:
  `kind`, `bindings`, `colorBy`, `switchTo`, `transitions`, `blend`, `graphOverlay`, …). This is
  the config half — richer than `export/spec.ts`'s thin `CellSpec {id,kind,colorBy}`.
- **`adapter/Coordination.store.ts`** → `viewStates` (per-space zoom/pan), `pointSelection`
  (+ `selectionOrigin`), `gridLinked` (link-zoom), `colorScales` (shared color domains),
  `colorBySelection`, `highlight`.
- **`adapter/colorOverride.store.ts`** → per-column `categoryColors` / `categoryLabels` (the
  interactive-legend override layer).

**Already partially persisted:** `export/spec.ts` `WorkspaceSpec {version, layout, cells:[{id,
kind,colorBy}]}` + `adapter/autosave.ts` (localStorage). But it captures **only** layout + kind +
colorBy — not selection/zoom/filters/overrides/dataZoom-window/blend/bindings.

**GAPS blocking EXACT restore:**
1. **dataZoom windows** are component-local `useState` in `viz-core/datazoom/DataZoom.tsx` — the
   zoomed range is in no store, so it can't be captured. **Must be lifted** into a serializable
   store slice keyed by plot id.
2. **visualMap / filter ranges** are component-local (`viz-core/controls/VisualMap.tsx` / gate) —
   same problem. **Must be lifted.**
3. **No single, versioned snapshot** that unions every store's slice + a version for migration.
4. `pointSelection` is a `Uint32Array` — serialize as a plain number[] (canonical ids), rehydrate
   back to a typed array.

## Design

### 1. `VizSessionState` — one versioned, JSON-serializable object

```ts
interface VizSessionState {
  version: number                       // migration
  dataset: { id: string; columns?: string[] }   // WHAT to re-fetch (ids only, no bytes)
  grid: {
    layout: LayoutNode                  // GridWorkspace.store layout tree
    cells: CellConfig[]                 // full per-cell config (kind, bindings, colorBy,
  }                                     //   switchTo, blend, transitions, graphOverlay)
  interaction: {
    viewStates: Record<string, VizViewState>     // per-space zoom/pan  (Coordination)
    selection: { ids: number[]; origin: string | null }  // canonical point-IDs
    gridLinked: boolean                            // link-zoom          (Coordination)
    colorScales: Record<string, ColorScaleScope>   // shared domains     (Coordination)
    colorBySelection: string | null
    dataZoomWindows: Record<string, DataZoomWindow>  // ← lifted from component-local
    filters: Record<string, FilterRange>             // ← lifted from component-local
    colorOverrides: Record<string, CategoryOverride> // colorOverride.store
  }
}
```

Note this is **VizOption-config + runtime interaction**. The `grid` block is essentially the
declarative `VizOption` (layout + per-cell kind/bindings/colorBy/blend/switchTo). The `interaction`
block is the live state that `setOption` alone does not carry.

### 2. Per-store `serialize()` / `hydrate()` + a top-level capture/restore

Each store contributes its own slice (single source of truth per store), and a thin orchestrator
unions them:

- `adapter/sessionState.ts` (NEW):
  - `captureVizState(): VizSessionState` — read GridWorkspace + Coordination + colorOverride +
    the (newly-lifted) dataZoom/filter store → one JSON object. Typed arrays → number[].
  - `restoreVizState(state, { source }): void` — the app passes the **fetched `DataSource`**; the
    orchestrator hydrates the stores **in dependency order**:
    1. install `source` (data),
    2. GridWorkspace `hydrate(grid)` (layout + cells → so the plots exist),
    3. Coordination `hydrate(interaction)` (viewStates/selection/link/colorScales),
    4. colorOverride `hydrate(colorOverrides)`,
    5. dataZoom/filter `hydrate(dataZoomWindows, filters)`.
  - Migration: `migrateVizState(raw): VizSessionState` (version-bump guards; unknown-future →
    reject with a clear error, never silently drop).

- **Store additions:** each store gets `serialize()` (pure read) + `hydrate(slice)` (replace state,
  no side-effect fetches). GridWorkspace + Coordination + colorOverride already hold the data; only
  the two component-local pieces need lifting first.

### 3. Close the two gaps (prerequisite for EXACT)

- **Lift dataZoom windows** → a `dataZoomWindows: Record<plotId, window>` slice (either a new
  `adapter/PlotInteraction.store.ts` or a field on Coordination). `DataZoom.tsx` reads/writes the
  store instead of local `useState`; it already emits `onDataZoom` (event API Phase 1) — route that
  same window into the store. Keyed by cell/plot id (stable).
- **Lift filter ranges** → a `filters: Record<plotId, range>` slice in the same store.
  `VisualMap`/gate reads/writes it; it already surfaces `onFilter` (event API Phase 2).
- Both are **additive**: default (no snapshot) behaves exactly as today; the store just becomes the
  home of a value that was previously local.

### 4. The app's persistence + re-fetch flow (the user's scenario)

- App persists **named snapshots**: `{ name, datasetId, vizState }` (localStorage now; a backend
  `saved_views` table later — owner-scoped, sync-emitting, per the app conventions).
- On refresh / "Load saved view":
  1. app reads the snapshot,
  2. **fetches the data** for `vizState.dataset.id` (+ referenced columns) → builds the `DataSource`,
  3. calls `restoreVizState(vizState, { source })`.
- The viz restores exactly — selection re-maps via the canonical-id seam even if the re-fetched row
  order differs.

`autosave.ts` is upgraded from `WorkspaceSpec` to `VizSessionState` (superset; keep a
`migrateVizState` path for any old `WorkspaceSpec` in localStorage → wrap as `grid` + empty
`interaction`).

## Files

- `adapter/sessionState.ts` (NEW) — `VizSessionState` type, `captureVizState`, `restoreVizState`,
  `migrateVizState`. Exported from `/core` + barrel.
- `adapter/GridWorkspace.store.ts` — `serialize()` / `hydrate(grid)` (layout + cells).
- `adapter/Coordination.store.ts` — `serialize()` / `hydrate(interaction)` (viewStates, selection
  ↔ ids, gridLinked, colorScales, colorBySelection).
- `adapter/colorOverride.store.ts` — `serialize()` / `hydrate(overrides)`.
- **NEW** `adapter/PlotInteraction.store.ts` (or Coordination fields) — `dataZoomWindows` +
  `filters`, keyed by plot id; the lift target for the two component-local pieces.
- `viz-core/datazoom/DataZoom.tsx` — read/write the store window instead of local `useState`.
- `viz-core/controls/VisualMap.tsx` (+ gate) — read/write the store filter instead of local state.
- `adapter/VizController.ts` — `controller.capture()` / `controller.restore(state, {source})`
  imperative surface (thin wrappers over `sessionState.ts`).
- `react/Viz.tsx` — optional `initialState?: VizSessionState` prop (restore on mount) +
  `onStateChange?(state)` (so the app can autosave). Byte-identical when omitted.
- `adapter/autosave.ts` — upgrade `WorkspaceSpec` → `VizSessionState` (+ back-compat migration).
- Tests + a story/e2e: mutate (select points + zoom a plot + set a filter + override a group
  color) → `captureVizState()` → tear the stores down → `restoreVizState()` → assert every piece
  (selection ids, viewState, dataZoom window, filter range, override) round-trips, AND a pixel
  signature matches pre/post (the real "restored exactly" proof).

## Key rules

- **Data-independent**: ids only, never bytes; selection as **canonical point-IDs**, never indices.
- **Versioned + migratable**: every snapshot carries `version`; `migrateVizState` guards forward.
- **Per-store single source**: each store owns its `serialize`/`hydrate`; the orchestrator only
  unions + orders. No store reaches into another's shape.
- **Additive / byte-identical default**: no snapshot ⇒ today's behavior exactly. Lifting dataZoom/
  filter into a store must not change their live behavior.
- **Domain-neutral**: "session state / viewState / selection / filter / override" — no
  gene/cell/cluster vocabulary. Ports to finance unchanged.

## Phasing

- **Phase 1 — capture/restore the already-in-store state.** `sessionState.ts` +
  serialize/hydrate on GridWorkspace + Coordination + colorOverride + `VizController.capture/restore`
  + `<Viz initialState onStateChange>`. Covers grid, selection, zoom/pan, link, colorScales,
  overrides. (dataZoom windows + filters NOT yet exact — documented gap.)
- **Phase 2 — close the two gaps.** Lift dataZoom windows + visualMap filters into
  `PlotInteraction.store.ts`; include them in capture/restore. NOW exact.
- **Phase 3 — app integration.** Upgrade `autosave.ts` to `VizSessionState`; named-snapshot
  persistence in the app (localStorage → backend saved-views later); the load-saved-view →
  re-fetch → restore flow end-to-end + e2e.

Build directly in the tree — NOT `isolation:worktree` (can't nest in this worktree). Sequence
**after blend Phase 2** (it's the capstone; it serializes the blend cell config the blend work adds).
