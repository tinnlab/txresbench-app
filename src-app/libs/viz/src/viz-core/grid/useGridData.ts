// useGridData.ts — SPLIT P (ITEM-32): the grid's DATA-RESOLUTION plane.
//
// DEC-26's TWO data rows — "owned-data pull" (56) and "data resolve (`cellData`, `idToRow`, point
// index, dataset acquire)" (126) — moved verbatim out of `GridWorkspace`. They are one plane, and
// the reason is `positions` / `colors` / `catalog`: the OWNED pull produces them and `cellData`'s
// no-dataset branch consumes them, so a cut between the two rows puts three derivations on one side
// of a module boundary and their fallback reader on the other.
//
// What it owns: the DATA-OWNERSHIP-INVERSION pull (`needsBuffers` / `needsCatalog` / `owned` /
// `ownedError` and the one-time async effect), the effective buffers + `dataReady` / `selfPending`
// derivations, the two per-array memo caches (`idToRowFor`, `pointIndexFor`), the dataset-store
// subscription and `effectiveCatalog`, the selection-by-space read and `anySelectionActive`, the
// acquire/release ref-counting effects and the lazy `ensureBuffers` pull, and the two per-cell
// RESOLVERS (`cellData`, `cellSelectionSpace`) with their render-time mirror refs.
//
// SHAPE — a value bundle (DEC-27/DEC-28, an eighth time), and here the argument is at its strongest:
// `positions` and `colors` are the BULK BUFFERS. Routing them through a store would put a
// subscription on the one path that carries megabytes, and `cellData` is called once per cell inside
// the `layers` memo — i.e. on the render path TEST-P1 counts.
//
// Writer-set completeness (HAZARD 1), per moved state — the method, and its limit:
//   `owned` / `ownedError`  one writer set each, all inside the pull effect, which moves. Lexical
//                           `useState`; `tsc` complete.
//   `acquiredDatasetsRef`   mutated by the acquire effect and its unmount release, both of which
//                           move. Lexical; `tsc` complete.
//   `idToRowCacheRef` / `pointIndexCacheRef`
//                           per-array memo caches, written only by their own accessors. `tsc`
//                           complete.
//   `cellDataRef` / `cellSelectionSpaceRef`
//                           ITEM-14 SEAM members (DEC-20). Declared here and RETURNED unchanged, so
//                           the shell's `seam` memo is byte-identical and `GridOverlayLayer` /
//                           `useGridSelection` keep reading the SAME ref objects. This is DEC-28's
//                           rule applied for the fourth time: a seam ref is re-passed, never
//                           re-declared behind a subscription.
//   `positionsProp` / `colorsProp` / `catalogProp` / `colorEpochProp` / `source` / `pointIds`
//                           PROPS of the shell. Passed in; the shell still owns its own public API.
//   `cellMapRef` / `perCell*Ref`
//                           NOT moved — shell-owned, other writers.
//
// NO DEV WINDOW SEAM is installed from this module. Checked, not assumed.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { computeColoring, DEFAULT_COLOR_BY } from '../data/engine'
import { buildIdToRow, hasAnySelection, type IdToRow } from '../coordination/selectionSync'
import { makePointIndexCache } from '../spatial/pointIndex'
import type { DataSource, DatasetCatalog } from '../data/wire'
import type { VizStores } from '../../adapter/vizStores'
import { DEFAULT_SELECTION_SPACE } from '../../adapter/Coordination.store'
import { catalogForCell, layoutDrawnBy, type CellRenderData, type GridCell } from './gridModel'
import { resolvePaneFrame, type PaneFrame } from '../spatial/coordinateBinding'

/** MULTI-DATASOURCE: the identity-space id every cell whose dataset advertises canonical `pointIds`
 *  publishes/consumes selection in — so datasets sharing barcodes auto-link (DEC-M4). Namespace-less
 *  datasets isolate under their own `datasetId` space; the default/sole dataset stays the DEFAULT. */
const SELECTION_CANONICAL_SPACE = 'canonical'

/** The viz-owned data pulled from `source` once, when the caller omits the buffers/catalog
 *  (data-ownership inversion). `positions`/`colors` are null when the caller DID pass buffers but
 *  omitted only the catalog. */
export interface OwnedData {
  positions: Float32Array | null
  colors: Uint8Array | null
  catalog: DatasetCatalog
  epoch: number
  /**
   * The layout id the pull ACTUALLY READ its positions from (#228), or `null` when it read none.
   *
   * Returned rather than re-derived because the one consumer that needs it — the coordinate
   * binding, which must decide a pane's frame from the layout the pane PAINTS — would otherwise
   * have to reproduce the first-of-N choice below, and two copies of a documented guess are how
   * they come to disagree. `lint-positional-declaration` says the same thing structurally: a
   * literal index into a declared collection is a last resort that gets recorded ONCE, where it
   * is made.
   */
  layoutId: string | null
}

/** Stable empty typed-array fallbacks (module identity) so the hooks that key on `positions`/
 *  `colors` don't churn while the owned pull is in flight. 0 points render nothing. */
const EMPTY_POSITIONS = new Float32Array(0)
const EMPTY_COLORS = new Uint8Array(0)

/** What the one-time owned pull needs. Separated from the hook so the pull is a PURE async
 *  function a node test can drive against a fake `DataSource` (`ownedData.test.ts`) — the hook
 *  contributes only the `alive` guard and the two setStates. */
export interface OwnedPullInputs {
  readonly source: DataSource
  readonly catalogProp: DatasetCatalog | null | undefined
  readonly needsBuffers: boolean
}

/** The NEUTRAL full-length color buffer a failed default-coloring falls back to. NOT an empty
 *  one: a 0-length `colors` against N positions is a deck.gl binary-attribute length mismatch. */
function neutralColors(pointCount: number): Uint8Array {
  const gray = new Uint8Array(pointCount * 4)
  for (let i = 0; i < pointCount; i++) {
    gray[i * 4] = 160
    gray[i * 4 + 1] = 160
    gray[i * 4 + 2] = 160
    gray[i * 4 + 3] = 255
  }
  return gray
}

/**
 * The one-time data-ownership-inversion pull: resolve the catalog, then — when the caller omitted
 * the bulk buffers — this source's primary point layout and its default coloring.
 *
 * ── A SOURCE THAT DECLARES NO LAYOUT HAS NO POSITIONS TO READ ────────────────────────────────
 *
 * The primary layout is the catalog's FIRST DECLARED layout. When the catalog declares NONE, the
 * pull lands ZERO points and reads nothing — it does not invent a layout id.
 *
 * It used to fall back to the literal `'primary'`, which is not a fallback so much as a guess at
 * another module's vocabulary: `'primary'` is what the fixtures and the grid store happen to call
 * their default layout, and a real host source addresses layouts by artifact id. So on any project
 * with no embedding artifact — a freshly imported dataset, i.e. the common case — the workspace
 * asked its source for an artifact literally named `primary`, the source rejected (`GET
 * /api/artifacts/primary` → 400, not a UUID), and the whole workspace covered itself in "Failed to
 * load visualization data from the source" — on a canvas of chart cells that need no positions at
 * all and were otherwise ready to paint.
 *
 * The distinction this restores is EMPTY vs FAILED. No declared layout is not a failure; it is a
 * source with no dense substrate, and the honest render is zero points. A layout that IS declared
 * and then fails to read still REJECTS, and the workspace still shows its error — that half is
 * load-bearing and `ownedData.test.ts` holds it.
 */
export async function pullOwnedData({
  source,
  catalogProp,
  needsBuffers,
}: OwnedPullInputs): Promise<OwnedData> {
  const catalog = catalogProp ?? (await source.catalog())
  // The caller supplied the buffers, so NO layout was read and none can be named: those
  // positions are the caller's and no catalog entry describes them.
  if (!needsBuffers) return { positions: null, colors: null, catalog, epoch: 1, layoutId: null }

  // ── REPORTED, NOT REFUSED (the second call this file got wrong) ─────────────────────────
  //
  // `layouts[0]` IS the family: with a UMAP and a t-SNE declared, "the producer's first" is not
  // an answer to which embedding the user is looking at, and the two look nothing alike.
  //
  // The first fix here refused (`layouts.length === 1 ? ... : undefined`) and TWO independent
  // blind reviews called it a regression, correctly. A catalog with several embeddings is the
  // ORDINARY case, not the exotic one — and there is no UI anywhere in the tree to choose a
  // cell's `layoutId`, so a refusal here is a permanently blank canvas with no recovery path
  // and, since this is not the chart-binding seam, no message either.
  //
  // That is the DECLARE-AND-MIGRATE shape a prior lifecycle already ruled on for the canvas's
  // own `cat.layouts[0]` (DEC-15 there; DEC-13 here): the guess ends when there is a way to
  // declare the answer, and building that way is a UI change, not a resolver change. Ending it
  // first leaves the user worse off than the guess did.
  //
  // So it stays, REPORTED — enumerated as F10 in the branch's FAMILY_ENUMERATION.md, and named
  // here so the next reader finds the argument instead of re-deriving it. What this branch DID
  // remove from this file is the `?? 'primary'` literal (see above): a guess constrained to the
  // catalog's own declarations is strictly better than one that invents a name, even while it
  // is still a guess.
  const layoutId = catalog.layouts[0]?.id
  if (layoutId == null) {
    return { positions: EMPTY_POSITIONS, colors: EMPTY_COLORS, catalog, epoch: 1, layoutId: null }
  }

  const positions = (await source.positions(layoutId)).positions
  // ── THE DEFAULT COLORING ASKS THE CATALOG, IT DOES NOT GUESS A COLUMN NAME ──────────────────
  //
  // `DEFAULT_COLOR_BY` names the literal column `'group'`, which is the same class of guess as the
  // `?? 'primary'` layout fallback removed above: `'group'` is what the in-package fixtures call
  // their grouping, while a real host source addresses columns by artifact id. The two sources
  // answer a key they don't have in two different ways, and both were wrong:
  //
  //   • THROW (a host source rejecting an unaddressable key) → caught below → neutral. Fine.
  //   • return ONE UNGROUPED COLUMN — the frame-backed canvas source does this deliberately,
  //     because "group these rows by nothing" is a real answer. That synthetic single category
  //     then took palette slot 0, and slot 0 of Okabe-Ito is [0,0,0]: the WHOLE CANVAS painted
  //     BLACK, under a legend claiming a category called "All". Silent, confident, and wrong —
  //     and invisible against a dark theme.
  //
  // So the key is checked against the CATALOG first. A source that genuinely publishes the default
  // column is coloured by it exactly as before (fixtures + stories byte-identical); a source that
  // does not is never asked, and gets the neutral buffer this module already defines. Neutral is
  // the honest answer for "nobody has chosen a colour-by and the data cannot serve the default
  // one": it is legible on either theme, it is not a palette slot so it cannot collide with a real
  // category 0, and it claims no category that does not exist. A cell with its own `colorBy`
  // recolors over this regardless.
  const neutral = () => neutralColors(positions.length / 2)
  const catalogServesDefault = catalog.categoricalColumns.some(c => c.id === DEFAULT_COLOR_BY.key)
  let colors: Uint8Array
  if (!catalogServesDefault) {
    colors = neutral()
  } else {
    // Still best-effort: a column the catalog advertises can still fail to read, and that must not
    // block a canvas whose cells may need no colors at all.
    try {
      colors = (await computeColoring(source, DEFAULT_COLOR_BY)).colors
    } catch {
      colors = neutral()
    }
  }
  return { positions, colors, catalog, epoch: 1, layoutId }
}

export interface GridDataInputs {
  readonly stores: VizStores
  readonly source: DataSource
  readonly cells: readonly GridCell[]
  readonly denseCells: readonly GridCell[]
  readonly positionsProp: Float32Array | undefined
  readonly colorsProp: Uint8Array | undefined
  readonly colorEpochProp: number
  readonly catalogProp: DatasetCatalog | null | undefined
  readonly pointIds: Uint32Array | undefined
}

export function useGridData({
  stores,
  source,
  cells,
  denseCells,
  positionsProp,
  colorsProp,
  colorEpochProp,
  catalogProp,
  pointIds,
}: GridDataInputs) {
  // ── Data-ownership inversion (DATA_OWNERSHIP_INVERSION) ────────────────────
  // When the caller OMITS the bulk buffers (`positions`/`colors`) and/or the small `catalog`, the
  // workspace pulls them from `source` ONCE and OWNS them here — so the app holds nothing big after
  // the initial `source`/`option` handoff, and every add/remove/manipulate is an imperative store
  // command on this viz-owned data (no buffer re-pass). When the caller PROVIDES them (the eager-
  // prop path), the passed values win and this pull never runs — byte-identical to before.
  const needsBuffers = positionsProp == null || colorsProp == null
  const needsCatalog = catalogProp == null
  const [owned, setOwned] = useState<OwnedData | null>(null)
  // A failure of the one-time owned-data pull. Surfaced as an error affordance (NOT a permanent
  // spinner) and stops `selfPending` — otherwise a rejected pull would spin forever + throw an
  // unhandled rejection.
  const [ownedError, setOwnedError] = useState<unknown>(null)

  useEffect(() => {
    if (!needsBuffers && !needsCatalog) return
    let alive = true
    // Drop any stale owned data / latched error from a PREVIOUS source before the new pull (a
    // changed `source` must not keep showing the old buffers or a stale error overlay).
    setOwned(null)
    setOwnedError(null)
    void (async () => {
      try {
        const next = await pullOwnedData({ source, catalogProp, needsBuffers })
        if (!alive) return
        setOwned(next)
      } catch (err) {
        if (!alive) return
        setOwnedError(err)
      }
    })()
    return () => {
      alive = false
    }
    // `source` + which slots are missing are the only real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBuffers, needsCatalog, source])

  // Effective buffers/catalog: the passed prop wins; otherwise the viz-owned pull (empty typed-array
  // fallbacks — stable module identities — keep every hook below unconditional while the pull runs;
  // 0 points render nothing and the loading overlay covers the brief gap).
  const positions = positionsProp ?? owned?.positions ?? EMPTY_POSITIONS
  const colors = colorsProp ?? owned?.colors ?? EMPTY_COLORS
  const colorEpoch = positionsProp != null ? colorEpochProp : (owned?.epoch ?? 0)
  const catalog = catalogProp ?? owned?.catalog ?? null
  const dataReady =
    (!needsBuffers || owned?.positions != null) && (!needsCatalog || owned?.catalog != null)
  const selfPending = (needsBuffers || needsCatalog) && !dataReady && ownedError == null

  /** The DEFAULT dataset's point count — `cellData`'s no-dataset branch reports it, and the a11y
   *  activate announcement reads it. Derived from the owned/passed buffers, so it lives here. */
  const nPoints = positions.length / 2

  // PERF: memoize `buildIdToRow` PER canonical-id array (keyed by the Uint32Array identity, which is
  // stable per dataset), so the per-cell highlight masks in the `layers` memo don't rebuild an O(N)
  // id→row map for every cell on every selection change — a dataset's map is built at most once.
  const idToRowCacheRef = useRef(new WeakMap<Uint32Array, IdToRow>())
  const idToRowFor = useCallback((ids: Uint32Array): IdToRow => {
    const cache = idToRowCacheRef.current
    let m = cache.get(ids)
    if (!m) {
      m = buildIdToRow(ids)
      cache.set(ids, m)
    }
    return m
  }, [])
  // MD-11: cache the KD-tree selection index PER positions buffer (identity-keyed, stable per dataset),
  // so a lasso/rect commit on a multi-dataset cell reuses its index instead of rebuilding an O(N log N)
  // tree on every commit. The default cell keeps the memoized `selectionIndex`.
  const pointIndexCacheRef = useRef(makePointIndexCache())
  const pointIndexFor = useCallback((pos: Float32Array) => pointIndexCacheRef.current.get(pos), [])

  // ── MULTI-DATASOURCE: per-cell dataset data + selection scope (ITEM-9/11/16/24) ─────────────
  // A dense cell WITHOUT a `datasetId` renders the workspace props (the default/sole dataset —
  // byte-identical single-dataset path); a cell WITH a `datasetId` reads that dataset's lazily-pulled
  // buffers + canonical `pointIds` from the DatasetStore. The store is read reactively so a cell
  // re-renders when its dataset's buffers land.
  const datasetEntries = useStore(stores.datasetStore, s => s.datasets)
  // MD-10: a PURE `<Viz datasets>` mount supplies no prop `catalog` (all cells bind a datasetId), so
  // fall back to the first ready dataset's catalog from the store — the content overlay + chart cells
  // then render. Single-dataset (prop catalog present) is unchanged.
  // ── REPORTED, NOT REFUSED — and this is the line where that call was got wrong once ──────
  //
  // `.find(e => e.status === 'ready')` over `Object.values` is insertion-ordered, so with
  // several ready datasets WHICH catalog resolves the content overlay depends on which one
  // finished loading first. That is the first-of-N shape, and the first fix here made it
  // refuse: `ready.length === 1 ? ... : null`.
  //
  // That was WRONG, and a blind review caught it. This fallback exists FOR the multi-dataset
  // mount — `MD-10`, a pure `<Viz datasets>` with no prop catalog, which is by definition more
  // than one dataset (`showcase/stories/multi-datasource.story.tsx` mounts exactly that, and
  // `ui/tests/viz-e2e/multi-datasource.spec.ts` pins it). Refusing here returns `null` for the
  // only case the code path has, so the content overlay silently stops rendering: a refusal
  // that breaks a working surface for no data-correctness gain, which is the trade the design
  // doc's own "Deliberately NOT changed" section spares two other sites for.
  //
  // It is left as it was because the guess here is CHEAP and RECOVERABLE in a way the binding
  // guesses are not: every chart cell resolves its bindings against ITS OWN `datasetId`'s
  // catalog, so this value never decides which column a chart draws — it backs chrome that
  // renders for any of them. Enumerated as F16; the honest fix is for the overlay to stop
  // needing a single "the" catalog, which is a wider change than this one.
  const effectiveCatalog = useMemo(
    () => catalog ?? Object.values(datasetEntries).find(e => e.status === 'ready' && e.catalog)?.catalog ?? null,
    [catalog, datasetEntries],
  )
  const selectionBySpace = useStore(stores.coordination, s => s.selectionBySpace)
  // DRIFT-1.5 / DEC-4: does ANY identity space currently hold a selection? Drives the tool rail's
  // `move` ACTION enablement (moving "the selection" is meaningless without one).
  const anySelectionActive = useMemo(
    () => Object.values(selectionBySpace).some(sel => hasAnySelection(sel?.ids)),
    [selectionBySpace],
  )
  // RENDER-REF reconcile (ITEM-7/21 · fixes the addCell→remove leak): GridWorkspace OWNS a dataset ref
  // for each currently-referenced datasetId — acquire when a cell first references it, RELEASE when the
  // last referencing cell is gone (so a progressively-added-then-removed dataset evicts), release ALL on
  // unmount. This is the authoritative render-ref owner; the controller no longer holds per-cell refs.
  const acquiredDatasetsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    // ALL cells (dense scatter AND own-canvas charts) may bind a datasetId — acquire every referenced
    // dataset so a chart cell bound to dataset B resolves B's source + catalog, not just dense cells.
    const referenced = new Set<string>()
    for (const cell of cells) if (cell.datasetId) referenced.add(cell.datasetId)
    const ds = stores.datasetStore.getState()
    const acquired = acquiredDatasetsRef.current
    for (const id of referenced) if (!acquired.has(id)) { acquired.add(id); void ds.acquire(id) }
    for (const id of [...acquired]) if (!referenced.has(id)) { acquired.delete(id); ds.release(id) }
  }, [cells, stores])
  useEffect(
    () => () => {
      const ds = stores.datasetStore.getState()
      for (const id of acquiredDatasetsRef.current) ds.release(id)
      acquiredDatasetsRef.current.clear()
    },
    [stores],
  )
  // Lazily pull each referenced dataset's buffers ONCE its entry is ready (retries as entries change);
  // `ensureBuffers` dedupes concurrent per-cell pulls internally.
  useEffect(() => {
    const seen = new Set<string>()
    for (const cell of denseCells) {
      // Delimited key (a datasetId/layoutId may share characters at the boundary) so two distinct
      // (dataset, layout) pairs never collide into one skipped pull.
      const key = cell.datasetId ? `${cell.datasetId}::${cell.layoutId}` : null
      if (key && !seen.has(key)) {
        seen.add(key)
        void stores.datasetStore.getState().ensureBuffers(cell.datasetId!, cell.layoutId)
      }
    }
  }, [denseCells, datasetEntries, stores])
  const cellData = useCallback(
    (cell: GridCell): CellRenderData => {
      if (!cell.datasetId) {
        return { positions, colors, colorEpoch, pointIds: pointIds ?? null, nPoints, status: 'ready' }
      }
      const e = datasetEntries[cell.datasetId]
      const pos = e?.positionsByLayout[cell.layoutId] ?? EMPTY_POSITIONS
      return {
        positions: pos,
        colors: e?.colors ?? EMPTY_COLORS,
        colorEpoch: e?.epoch ?? 0,
        pointIds: e?.pointIds ?? null,
        nPoints: pos.length / 2,
        status: e?.status ?? 'loading',
      }
    },
    [positions, colors, colorEpoch, pointIds, nPoints, datasetEntries],
  )
  // The selection identity-space a cell publishes/consumes in. A DEFAULT cell (no `datasetId` — the
  // single/sole-dataset path) ALWAYS uses the DEFAULT space, EVEN with the workspace `pointIds` prop, so
  // the legacy top-level `pointSelection` (read by ViolinView/RasterUnderlay/the controller select
  // bridge + captured by session serialize) stays byte-identical. Only a MULTI-dataset cell (with a
  // `datasetId`) routes to canonical (auto-link, when its dataset advertises `pointIds`) or its own
  // isolated `datasetId` space.
  const cellSelectionSpace = useCallback(
    (cell: GridCell, hasPointIds: boolean): string =>
      cell.datasetId
        ? hasPointIds
          ? SELECTION_CANONICAL_SPACE
          : cell.datasetId
        : DEFAULT_SELECTION_SPACE,
    [],
  )
  /**
   * #228 — the cell's declared FRAME: what its raster says it is in, what its layout says it is
   * in, and whether those are the same thing.
   *
   * It resolves from the cell's OWN dataset catalog (`catalogForCell`), never from
   * `effectiveCatalog`. That distinction is load-bearing rather than tidy: `effectiveCatalog` is
   * the documented first-of-N GUESS a few lines above, and a guess is exactly what may not decide
   * a placement. A cell reading the default dataset's `coordinate_space` while rendering its own
   * dataset's raster would bind two artifacts that were never in one frame, and the overlay would
   * be plausible and wrong — the failure mode this whole item exists to close. An unresolved
   * catalog therefore yields a REFUSAL (nothing drawn), not a fallback.
   */
  const cellFrame = useCallback((cell: GridCell): PaneFrame => {
    const cat = catalogForCell(cell.datasetId, catalog, id => datasetEntries[id]?.catalog ?? null)
    // The DRAWN layout, not the declared one. A store-minted cell carries the sentinel
    // `layoutId: 'primary'` while a host source keys its layouts by artifact id, so resolving by
    // the declared id refuses on every real project; and a default cell paints whatever the owned
    // pull read, whatever it declares, so binding on anything else would decide the frame from one
    // artifact and draw the points of another. `layoutDrawnBy` carries the full argument, and it
    // is handed the id the pull ACTUALLY read rather than re-deriving it.
    // A FAILED owned pull is a TERMINAL answer, not "not yet". `catalog` stays null forever after
    // a rejection, and the camera seed is idempotent-once, so treating that as unresolved would
    // leave an image cell with a caller-supplied `loader` with no camera at all, permanently.
    // An empty resolved frame is the honest state: nothing will ever be declared here.
    //
    // SCOPED TO A DEFAULT CELL, and that is not incidental. `ownedError` is the WORKSPACE pull's
    // failure; a cell with a `datasetId` gets its catalog from the dataset store, and for one
    // that is still loading `cat` is ALSO null. Without this scoping a single failed workspace
    // pull would mark every such pane resolved-and-empty and seed its camera in pixel units —
    // which is the exact race the `catalogResolved` flag exists to prevent, reached by a second
    // door.
    if (!cat && ownedError != null && !cell.datasetId) {
      return resolvePaneFrame({ layouts: [] }, cell.layoutId)
    }
    return resolvePaneFrame(cat, layoutDrawnBy(cell, cat, owned?.layoutId ?? null))
  }, [catalog, datasetEntries, owned, ownedError])
  // Refs so the pointer-driven selection commit reads the live resolver without re-binding.
  const cellDataRef = useRef(cellData)
  cellDataRef.current = cellData
  const cellSelectionSpaceRef = useRef(cellSelectionSpace)
  cellSelectionSpaceRef.current = cellSelectionSpace

  return {
    owned,
    nPoints,
    ownedError,
    positions,
    colors,
    colorEpoch,
    catalog,
    dataReady,
    selfPending,
    idToRowFor,
    pointIndexFor,
    datasetEntries,
    effectiveCatalog,
    selectionBySpace,
    anySelectionActive,
    cellData,
    cellSelectionSpace,
    cellFrame,
    cellDataRef,
    cellSelectionSpaceRef,
  }
}
