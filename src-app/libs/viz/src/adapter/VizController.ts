// VizController.ts — the DECLARATIVE controller (EXTENSIBILITY_STUDY Part 4 / Part 6 STEP 6),
// consolidated to the ECharts-style `getOption()` / `setOption(option, { replace? })` pair
// (viz-api-consolidation Part A, ITEM-2/3/12).
//
// `setOption(option)` is a thin TRANSLATION LAYER on top of the registry + the existing stores:
// it resolves the option (via the PURE `parseOption`) then DRIVES the current
// `GridWorkspace`/`Coordination`/`PlotInteraction`/`colorOverride` stores — it does NOT reimplement
// rendering. `getOption()` is the INVERSE: it COMPOSES a strict-JSON `VizOption` back out of those
// stores' `serialize()` slices (layout + docking from the grid, selection ids/spaces + colorScale
// domains + colorBySelection from coordination, dataZoom windows + filters from PlotInteraction, per-
// column overrides from colorOverride) so `getOption()` → app store → `setOption(saved, { replace })`
// restores the LIVE state, end-to-end.
//
// `setOption` DEFAULTS to MERGE (DEC-6): `series`/`grid`/`dataZoom`/`datasets` match by `id` (unmatched
// kept), singleton/map fields deep-merge by key. `{ replace: true }` is the clean rebuild (today's
// behavior). `dispatch(action)` stays as an ADDITIONAL post-init mutation path; `removePane` (DEC-4)
// removes a pane by id.
//
// This lives in `adapter/` (NOT viz-core) — like `coordinationHandle.ts` — because it depends on the
// concrete zustand stores; the pure `parseOption` + `VizOption` types live in viz-core. The registry
// must be populated first (`installBuiltins()` / `use([...])`); the controller does NOT import the
// charts module, so `@ziee/viz/core` stays chart-free (tree-shakeable) — an unregistered `series[].type`
// throws from `parseOption` (the ECharts "used but not imported" contract).

import {
  DEFAULT_SELECTION_SPACE,
  gridScopeId,
  type CoordinationSlice,
  type SelectionSlice,
  type VizViewState,
} from './Coordination.store'
import type { DataZoomWindow } from './PlotInteraction.store'
import { type VizStores, defaultVizStores } from './vizStores'
import { parseOption, normalizeDatasets, VIZ_OPTION_VERSION } from '../viz-core/option/parse'
import type { DatasetCatalog } from '../viz-core/data/wire'
import {
  VizEmitter,
  windowAxis,
  type VizEvent,
  type VizEventBus,
  type VizEventHandler,
  type VizEventType,
} from '../viz-core/events/emitter'
import { cellSpaceKey, type CellKind, type GridCell } from '../viz-core/grid/gridModel'
import { leafIds, type SplitDir } from '@ziee/dock'
import { getChartType } from '../viz-core/registry/registry'
import type { ColorBy } from '../viz-core/data/engine'
import type { DataSource } from '../viz-core/data/wire'
import type { StreamingResolver } from '../viz-core/data/streamingSource'
import type {
  ResolvedOption,
  VizColorBy,
  VizControls,
  VizDataset,
  VizDataZoom,
  VizEncode,
  VizGridEntry,
  VizOption,
  VizSelection,
  VizSelectionContext,
  VizSelectionOp,
  VizSeries,
  VizWindow,
} from '../viz-core/option/types'
import { diffControls } from '../viz-core/option/types'
import {
  selectionStaleness,
  type ResolvePane,
  type SelectionStaleness,
} from '../viz-core/selection/provenance'
import { revalidateSelectionIn } from './selectionRevalidate'

/** `getOption()` emission options (DEC-21 / ITEM-10).
 *
 *  `selection: 'ops-only'` drops the `ids`/`spaces` CACHE from the emitted selection and keeps the
 *  provenance (`ops`/`context`/`provenance`) — the executable form of "a selection is a predicate
 *  with a cache, not a materialized list" (INV-7). Opt-in by design: the default stays `'full'` so
 *  every existing consumer, and the merge base inside `setOption`, keep their ids (INV-4). */
export interface GetOptionOptions {
  readonly selection?: 'full' | 'ops-only'
}

/** Reused empty id array for a cleared selection (so `select` always carries a `Uint32Array`). */
const EMPTY_IDS = new Uint32Array(0)

/** Resolve a `dataset.id` to a `DataSource` (the app owns the concrete source impl). */
export type DatasetResolver = (id: string) => DataSource | Promise<DataSource>

/**
 * The post-init mutation actions (EXTENSIBILITY_STUDY Part 4). Each maps to an existing store
 * call, so behavior is byte-identical to the imperative path:
 *   - `select`        → `Coordination.setSelection(originId, ids)` (fans out to linked series).
 *   - `gridViewState` → `Coordination.setGridViewState(spaceKey, viewState)` (world2d camera link).
 *   - `dataZoom`      → the PlotInteraction store's window (the authoritative home; the controller's
 *     own Map mirrors it) PLUS a typed `dataZoom` event.
 *   - `removePane`    → `GridWorkspace.removeCell(id)` (DEC-4: explicit removal, never by omission).
 */
export type VizAction =
  | { readonly type: 'select'; readonly originId: string | null; readonly ids: Uint32Array | null }
  | { readonly type: 'dataZoom'; readonly id: string; readonly window: VizWindow }
  | { readonly type: 'gridViewState'; readonly spaceKey: string; readonly viewState: VizViewState }
  | { readonly type: 'removePane'; readonly id: string }

export interface VizControllerOptions {
  /**
   * LEGACY id→`DataSource` resolver (the pull-model data seam). Kept working for back-compat; a new
   * caller prefers `resolveSource` (the ONE streaming data-input seam, DEC-2). Exactly one of
   * `resolveDataset` / `resolveSource` must be supplied.
   */
  readonly resolveDataset?: DatasetResolver
  /**
   * The ONE data-input seam (DEC-1/DEC-2): id→`StreamingSource`. Installed via
   * `DatasetStore.setStreamingResolver`, which wraps each resolved source with `asDataSource` at the
   * boundary so all downstream store logic is byte-identical to the legacy `DataSource` path.
   */
  readonly resolveSource?: StreamingResolver
  /**
   * The `VizStores` set this controller drives (VIZ_ISOLATION W2/W3). A per-instance `<Viz>` hands
   * its own `createVizStores()` set so `setOption` / `dispatch` / the mutators / capture+restore all
   * target THIS instance's stores. Defaults to `defaultVizStores` (the module singletons) — the
   * byte-identical single-instance path.
   */
  readonly stores?: VizStores
}

/**
 * The declarative controller. Construct with a `resolveDataset`/`resolveSource`, call
 * `setOption(option)` to mount (populates the grid store's layout + cells and configures the
 * coordination components), then `dispatch(action)` to mutate. `getOption()` reads the live state
 * back out as a `VizOption` for save/restore.
 */
export class VizController implements VizEventBus {
  private readonly resolveDataset?: DatasetResolver
  private readonly resolveSource?: StreamingResolver
  /** The isolated store set this controller drives (default = the module singletons). */
  private readonly stores: VizStores
  private resolved: ResolvedOption | null = null
  private source: DataSource | null = null
  /** MULTI-DATASOURCE: the datasets this controller currently holds a DatasetStore ref on (from the
   *  last applied setOption) — id AND the `rev` (DEC-4) it was acquired under, so `getOption()`
   *  re-emits the content token it applied instead of silently downgrading it to a bare id.
   *  Released on the next clean-replace setOption, or on `dispose()`. */
  private acquiredDatasets: readonly VizDataset[] = []
  /** Monotonic generation stamped at the start of each `setOption`/`restore`. A `setOption` whose
   *  async resolve finishes AFTER a newer `setOption`/`restore` began must NOT clobber the stores with
   *  its stale plan (rapid A→B→A option/source churn, or a slow resolver). */
  private optionSeq = 0
  /** ITEM-11/ITEM-14: how the controller reaches a pane's live position buffers in order to RE-DERIVE
   *  a selection from its ops. Installed by the mounted `GridWorkspace` (`registerSelectionPanes`),
   *  because the controller has no access to the React-computed per-cell data itself.
   *
   *  Its ABSENCE is the DEC-9 window INV-7 is at risk in: an ops-only option can be hydrated before
   *  any pane exists, and deriving then would return EMPTY and look like a successful restore. So a
   *  hydrate with no resolver records the ops and defers; the first render that registers a resolver
   *  kicks `revalidate()`. TEST-13 asserts a NON-EMPTY result specifically to make that failure red. */
  private resolvePanes: ResolvePane | null = null
  /** Companion to `resolvePanes`: reads the LIVE display context (filters / hidden / positions
   *  hashes) for the panes an op list touches. Installed by the same `registerSelectionPanes` call,
   *  because — like the buffers — only the mounted `GridWorkspace` can see per-cell state. Without
   *  it `classifyChange` would have nothing to compare the recorded context against. */
  private liveContextProbe:
    | ((prov: { ops: readonly VizSelectionOp[]; context?: VizSelectionContext }) => VizSelectionContext)
    | null = null
  /** Back-compat mirror of the PlotInteraction store's dataZoom windows in the imperative `VizWindow`
   *  ({x?,y?}) shape — for `dispatch`/`getDataZoomWindow` callers. The PlotInteraction store is the
   *  AUTHORITATIVE home (ITEM-3/DEC-13): `dispatch` mirrors INTO it and `getDataZoomWindow` reads OUT
   *  of it first, so there is exactly one serialize source for `getOption`. */
  private readonly dataZoomWindows = new Map<string, VizWindow>()
  private readonly listeners = new Set<() => void>()
  /** The typed PLOT-EVENT emitter (EVENT_API_PLAN): `select` + `dataZoom` (Phase 1). Distinct from
   *  the coarse, payload-less `subscribe`/`notify` above (which fires on any setOption/dispatch). */
  private readonly emitter = new VizEmitter()
  /** The lazy coordination-store subscription backing `select` events — attached on the first
   *  `on('select', …)` and torn down when the last select listener leaves (no bridge, no cost when
   *  nobody listens). */
  private selectUnsub: (() => void) | null = null

  constructor(opts: VizControllerOptions) {
    // Exactly one data-input seam (DEC-2). Supplying BOTH is a misconfiguration (resolveSource would
    // silently win); fail LOUD at construction instead of a confusing later behavior. Supplying NEITHER
    // is allowed here — an inline `provideSource`/`provideStreamingSource` before the first acquire is a
    // valid path — and surfaces as a clear "no resolver installed" at acquire time.
    if (opts.resolveSource && opts.resolveDataset) {
      throw new Error('[viz] VizController: supply exactly one of resolveSource / resolveDataset, not both')
    }
    this.resolveDataset = opts.resolveDataset
    this.resolveSource = opts.resolveSource
    this.stores = opts.stores ?? defaultVizStores
  }

  /**
   * Subscribe to a typed plot event (`select` / `dataZoom`). Returns an unsubscribe fn. Attaching
   * the first `select` listener lazily bridges the coordination store → the emitter; removing the
   * last one tears that bridge down.
   */
  on<T extends VizEventType>(type: T, handler: VizEventHandler<T>): () => void {
    const off = this.emitter.on(type, handler)
    if (type === 'select') this.ensureSelectBridge()
    return () => {
      off()
      if (type === 'select' && this.emitter.listenerCount('select') === 0) this.teardownSelectBridge()
    }
  }

  /** Emit a typed plot event (fans to `on(...)` listeners). Public so the DataZoom React bus can
   *  route a per-plot window commit through the same emitter as the imperative `dispatch`. */
  emit(event: VizEvent): void {
    this.emitter.emit(event)
  }

  /** Bridge the coordination store's `pointSelection` (+ `selectionOrigin`) → `select` events. A
   *  cleared selection emits an EMPTY id array with `origin: null` (the store already nulls the
   *  origin when the selection is empty). Idempotent.
   *
   *  CHANGE bridge, not a GESTURE bridge: it subscribes to `pointSelection`, so it fans on a
   *  TRANSITION of the selection, never on a write that leaves it unchanged. Since the store
   *  normalizes an empty selection to `null`, an empty write onto an already-empty selection is a
   *  no-op and deliberately emits NOTHING — a consumer cannot hold a stale non-empty mirror without
   *  having received a non-empty event, and every non-empty→empty transition still fans. (Before the
   *  store's empty⇒null normalization this depended on the CALLER's reference: `setSelection(o, [])`
   *  fanned a phantom event while the equivalent `setSelection(o, null)` did not — an asymmetry, not
   *  a contract.) Widening the selector to a revision/epoch would fan phantom `select`s on session
   *  hydrate + redundant clears, so it is deliberately NOT done. Pinned by
   *  `VizController.events.test.ts` ("does NOT emit when an empty setSelection leaves an
   *  already-empty selection unchanged"). */
  private ensureSelectBridge(): void {
    if (this.selectUnsub) return
    this.selectUnsub = this.stores.coordination.subscribe(
      s => s.pointSelection,
      pointSelection => {
        const origin = this.stores.coordination.getState().selectionOrigin
        this.emitter.emit({ type: 'select', ids: pointSelection ?? EMPTY_IDS, origin })
      },
    )
  }

  private teardownSelectBridge(): void {
    this.selectUnsub?.()
    this.selectUnsub = null
  }

  /** Install the resolver seam onto the DatasetStore (streaming preferred, legacy DataSource fallback). */
  private installResolver(): void {
    const ds = this.stores.datasetStore.getState()
    if (this.resolveSource) ds.setStreamingResolver(this.resolveSource)
    else if (this.resolveDataset) ds.setResolver(this.resolveDataset)
  }

  /**
   * Apply a `VizOption` (DEC-6): DEFAULT = MERGE against the current `getOption()` (match
   * `series`/`grid`/`dataZoom`/`datasets` by id, deep-merge the singleton/map fields), `{ replace:true }`
   * = clean rebuild. Either path resolves the merged/replacement option once and drives every store —
   * grid layout+cells, THEN the interaction stores (selection ids+spaces, dataZoom windows, filters,
   * colorOverrides, viewStates, colorScale domains, colorBySelection) FROM the option — so a
   * `getOption` → `setOption(replace)` round-trip restores the live state. Returns the resolved plan.
   */
  async setOption(option: VizOption, opts?: { replace?: boolean }): Promise<ResolvedOption> {
    // MERGE (default) folds the incoming option into the CURRENT one (getOption); the merged result
    // is then applied as a full build. The very first setOption (no prior plan) has nothing to merge
    // into, so it applies directly. `{ replace:true }` always applies directly (clean rebuild).
    const effective =
      opts?.replace === true || this.resolved == null ? option : mergeOptions(this.getOption(), option)
    return this.applyOption(effective)
  }

  /** Parse `effective` and DRIVE the existing stores from the plan (the clean-build path). */
  private async applyOption(option: VizOption): Promise<ResolvedOption> {
    const seq = ++this.optionSeq
    // MULTI-DATASOURCE: install the resolver, then ACQUIRE every referenced dataset (reuse-by-id via
    // the DatasetStore ref-count), collect a catalog PER dataset, and parse each series against ITS
    // dataset's catalog.
    this.installResolver()
    // Each declared dataset is acquired WITH its `rev` (DEC-4) — the option's content-invalidation
    // token. Reducing the datasets to bare ids here (the old line) dropped it before it could reach
    // the store, which is why a host whose content changed under a stable id kept the source viz
    // built first. Same/absent rev still takes the store's cheap identity reuse.
    const datasets = normalizeDatasets(option)
    const datasetIds = datasets.map(d => d.id)
    await Promise.all(
      datasets.map(d => this.stores.datasetStore.getState().acquire(d.id, undefined, d.rev)),
    )
    const catalogs: Record<string, DatasetCatalog> = {}
    for (const id of datasetIds) {
      const entry = this.stores.datasetStore.getState().getEntry(id)
      if (entry?.catalog) {
        catalogs[id] = entry.catalog
      } else if (entry?.status === 'error') {
        // A DECLARED dataset that fails to resolve is a hard declaration error — fail LOUD, preserving
        // the ORIGINAL resolver/catalog error. Release the datasets this call acquired on the throw.
        for (const id2 of datasetIds) this.stores.datasetStore.getState().release(id2)
        throw entry.error instanceof Error
          ? entry.error
          : new Error(`[viz] dataset "${id}" failed to resolve: ${String(entry.error)}`)
      }
    }
    // `parseOption` can throw (validation) AFTER we acquired the datasets — release them on the throw
    // so a validation-failing setOption never leaks a DatasetStore ref.
    let resolved: ResolvedOption
    try {
      // With a pop-out DOCKING snapshot the option's `grid`/`series` carry the docked-out cells too,
      // but `option.layout` is the MAIN-grid tree only (docked panes live in `docking`, not the main
      // tree). `parseOption`/`validateLayoutLeaves` enforce a strict 1:1 main-tree ↔ grid check, so we
      // strip `layout` here and let it re-derive a throwaway tree — the docked cells are re-placed via
      // the store's `hydrate(docking)` below, and `option.layout` is fed to `hydrate` as the main tree.
      resolved = parseOption(option.docking ? { ...option, layout: undefined } : option, catalogs)
    } catch (err) {
      for (const id of datasetIds) this.stores.datasetStore.getState().release(id)
      throw err
    }
    // A newer setOption/restore started while we awaited the resolvers → do NOT overwrite the stores
    // with this now-stale plan; RELEASE the datasets this stale call acquired (no leak) and return the
    // parsed result for the caller, leaving state alone.
    if (seq !== this.optionSeq) {
      for (const id of datasetIds) this.stores.datasetStore.getState().release(id)
      return resolved
    }

    // Populate the GridWorkspace store (clean replace): layout + cells + seq. Thread each resolved
    // series' encode BINDINGS onto its cell (keyed by region/coordId) so `CellView` renders the
    // DECLARED encode instead of the catalog defaults. Only attach when the series actually resolved
    // bindings (charts with no schema resolve to `{}`, which stays absent — byte-identical default).
    const cells: Record<string, GridCell> = {}
    for (const [id, cell] of Object.entries(resolved.cells)) cells[id] = { ...cell }
    for (const s of resolved.series) {
      const cell = cells[s.coordId]
      if (cell && Object.keys(s.model.bindings).length > 0) cell.bindings = s.model.bindings
      // Plot-editing (ITEM-5): thread the resolved per-series mark style (radius/opacity) onto the cell
      // so the dense layer + in-cell marks control read it. Absent ⇒ no cell.style (byte-identical).
      if (cell && s.style && (s.style.radius !== undefined || s.style.opacity !== undefined)) {
        cell.style = { ...s.style }
      }
      // Plot-editing (ITEM-4): thread the resolved plot title + axis titles onto the cell.
      if (cell && s.title !== undefined) cell.title = s.title
      if (cell && s.axisTitles && (s.axisTitles.x !== undefined || s.axisTitles.y !== undefined)) {
        cell.axisTitles = { ...s.axisTitles }
      }
    }
    // With a DOCKING snapshot (ITEM-18/19), route through the grid store's `hydrate` so it
    // RECONSTRUCTS the pop-out containers + per-pane container binding + return anchors from
    // `option.docking`; the MAIN grid tree stays `option.layout` (the docked cells live in `docking`,
    // NOT the main tree — that's why `parseOption` above ran with `layout` stripped). Otherwise keep
    // the byte-identical single-window `setState` (layout + cells + seq only).
    //
    // REOPEN POLICY (ITEM-19, deferred): `hydrate` restores the docked LAYOUT only. It CANNOT re-open
    // the pop-out WINDOW (a headless/programmatic restore has no user gesture and this package must not
    // call `window.open`), so it lists the restored containers in the store's `pendingRestore`; the
    // window/UI layer reopens them (or merges them back to the main grid) as a follow-up. No window is
    // opened here.
    if (option.docking) {
      this.stores.gridWorkspace.getState().hydrate({
        layout: option.layout ?? resolved.layout,
        cells,
        seq: resolved.seq,
        docking: option.docking,
      })
    } else {
      this.stores.gridWorkspace.setState({
        layout: resolved.layout,
        cells,
        seq: resolved.seq,
      })
    }

    // Restore the INTERACTION stores FROM the option (DEC-13/DEC-16) — this is what makes a
    // `getOption` → `setOption(replace)` round-trip restore the LIVE state, not just the layout.
    this.hydrateInteraction(resolved)

    // Clean-replace: release the PREVIOUS option's dataset refs, keep the new acquisition. `source`
    // stays the DEFAULT (first) dataset's source for `getSource()` back-compat.
    const prev = this.acquiredDatasets
    // Keep a normalized COPY (id + rev only), never the caller's option objects — the same
    // "an emitted option never aliases the live tree" rule `cloneLayout`/`cloneColorOverrides` follow.
    this.acquiredDatasets = datasets.map(d => (d.rev === undefined ? { id: d.id } : { id: d.id, rev: d.rev }))
    for (const d of prev) this.stores.datasetStore.getState().release(d.id)
    this.source = this.stores.datasetStore.getState().getEntry(datasetIds[0])?.source ?? null
    this.resolved = resolved
    this.notify()
    return resolved
  }

  /** Drive the coordination / plot-interaction / colorOverride stores from a resolved plan (the
   *  interaction half `setOption` restores). Rebuilds each store's slice from the option so a stale
   *  field from a prior option can't linger. */
  private hydrateInteraction(resolved: ResolvedOption): void {
    // Coordination: selection ids (default space) + per-space ids + camera view states + grid-link +
    // shared color-by. colorScales (the continuous-domain registration map) is not carried losslessly
    // on the option, so a replace clears it (rebuilt by the panels on mount).
    const spaces: Record<string, SelectionSlice> = {}
    if (resolved.selection?.spaces) {
      for (const [spaceId, ids] of Object.entries(resolved.selection.spaces)) {
        if (spaceId === DEFAULT_SELECTION_SPACE) continue
        spaces[spaceId] = { ids: [...ids], origin: null }
      }
    }
    const viewStates: Record<string, VizViewState> = {}
    for (const s of resolved.series) {
      if (!s.viewState) continue
      const cell = resolved.cells[s.coordId]
      if (cell) {
        viewStates[gridScopeId(cellSpaceKey(cell))] = {
          target: [s.viewState.target[0], s.viewState.target[1]],
          zoom: s.viewState.zoom,
        }
      }
    }
    const coordSlice: CoordinationSlice = {
      viewStates,
      selection: { ids: resolved.selection?.ids ? [...resolved.selection.ids] : [], origin: null },
      ...(Object.keys(spaces).length > 0 ? { spaces } : {}),
      // PROVENANCE (ITEM-11): restore the ops + context alongside the ids. When the option carries
      // ops but NO ids (the DEC-21 `'ops-only'` emission), the ids below are empty and the live
      // selection is RE-DERIVED — by `revalidate()`, at the first render that registers a pane
      // resolver. Deriving inline here would run before any pane exists and return EMPTY, which
      // would look exactly like a successful restore; that is the DEC-9 hazard TEST-13's non-empty
      // assertion is written to catch.
      ...(resolved.selection?.ops && resolved.selection.ops.length > 0
        ? {
            provenance: {
              ops: [...resolved.selection.ops],
              ...(resolved.selection.context ? { context: resolved.selection.context } : {}),
            },
          }
        : {}),
      gridLinked: resolved.gridLinked,
      colorScales: {},
      colorBySelection: resolved.colorBySelection ?? null,
    }
    this.stores.coordination.getState().hydrate(coordSlice)

    // colorOverride: per-column display overrides.
    this.stores.colorOverride.getState().hydrate(resolved.colorOverrides ?? {})

    // PlotInteraction (the AUTHORITATIVE dataZoom-window + filter home): dataZoom windows keyed by the
    // dataZoom instance id (value band → {lo,hi}) + per-plot filters. The controller's Map mirrors it.
    const dataZoomWindows: Record<string, DataZoomWindow> = {}
    this.dataZoomWindows.clear()
    for (const dz of resolved.dataZoom) {
      if (!dz.window) continue
      dataZoomWindows[dz.id] = { lo: dz.window[0], hi: dz.window[1] }
      // Mirror into the imperative Map in the axis form the dispatched shape uses.
      this.dataZoomWindows.set(dz.id, dz.axes.includes('y') && !dz.axes.includes('x')
        ? { y: [dz.window[0], dz.window[1]] }
        : { x: [dz.window[0], dz.window[1]] })
    }
    this.stores.plotInteraction.getState().hydrate({
      dataZoomWindows,
      filters: resolved.filters ?? {},
    })
  }

  /**
   * COMPOSE a strict-JSON `VizOption` out of the live store slices (ITEM-2) — the inverse of
   * `setOption`. Layout + docking come from the grid slice; `series`/`grid` are derived from the grid
   * cells; selection ids/spaces + colorScale domains + colorBySelection from coordination; dataZoom
   * windows + filters from the PlotInteraction STORE (not the controller Map, DEC-13); per-column
   * overrides from colorOverride. Every field is JSON-serializable so `getOption()` → app store →
   * `setOption(saved, { replace })` round-trips.
   *
   * `opts.selection` (DEC-21 / ITEM-10) is a PURE EMISSION FILTER — it changes no live state, so
   * `getOption()` stays a cheap pure snapshot under either value:
   * - `'full'` (DEFAULT, and the no-arg call) — byte-identical to pre-provenance: `ids` + `spaces`
   *   are emitted exactly as before (INV-4).
   * - `'ops-only'` — omits `ids`/`spaces`, keeping `ops`/`context`/`provenance`. The measured
   *   asymmetry is ~10 vertices against 16 958 integers on a 20 000-point fixture; INV-7 guarantees
   *   such an option still restores the correct live selection.
   *
   * The DEFAULT IS LOAD-BEARING and must stay `'full'`: `setOption`'s merge path calls
   * `this.getOption()` with no argument as the merge base, so an `'ops-only'` default would silently
   * drop `ids` from every merge patch.
   */
  /** The CURRENT default-space ids, as a plain array (the `before`/`after` of a revalidate). */
  private currentIds(): readonly number[] {
    const sel = this.stores.coordination.getState().pointSelection
    return sel ? Array.from(sel) : []
  }

  /** Re-evaluate the live selection from its ops. DELEGATES to the single shared implementation
   *  (`selectionRevalidate.revalidateSelectionIn`) so the controller and the mounted `GridWorkspace`
   *  cannot drift into two different split rules — DEC-23 forbids a second IMPLEMENTATION, and the
   *  two callers are unavoidable (only the grid can observe a change; only the controller is public). */
  private revalidate(): void {
    if (!this.resolvePanes || !this.liveContextProbe) return // DEC-9: no buffers yet.
    revalidateSelectionIn(
      this.stores.coordination.getState(),
      this.resolvePanes,
      this.liveContextProbe,
    )
  }

  /** ITEM-11/ITEM-14 — install the pane resolver the re-derivation engine needs.
   *
   *  Called by a mounting `GridWorkspace` and again whenever its per-cell buffers change identity.
   *  Registration IMMEDIATELY kicks `revalidate()`, which is what closes the DEC-9 window: an
   *  ops-only option hydrated before any pane existed becomes a live selection at the first render
   *  that has the data. Returns an unregister fn for unmount. */
  registerSelectionPanes(
    resolve: ResolvePane,
    liveContext: (prov: { ops: readonly VizSelectionOp[]; context?: VizSelectionContext }) => VizSelectionContext,
  ): () => void {
    this.resolvePanes = resolve
    this.liveContextProbe = liveContext
    this.revalidate()
    return () => {
      if (this.resolvePanes === resolve) {
        this.resolvePanes = null
        this.liveContextProbe = null
      }
    }
  }

  /** ITEM-13 — the recorded provenance of the CURRENT selection, or `null` when it has none. */
  getSelectionProvenance(): { ops: readonly VizSelectionOp[]; context?: VizSelectionContext } | null {
    const prov = this.stores.coordination.getState().selectionProvenance
    return prov && prov.ops.length > 0 ? { ops: prov.ops, ...(prov.context ? { context: prov.context } : {}) } : null
  }

  /** ITEM-13 / DEC-23 — the observability surface for the ONE genuinely non-`fresh` window.
   *
   *  Under DEC-19 (automatic re-evaluation) the steady state is always `'fresh'`, so this is NOT a
   *  polling API and a "check-then-revalidate" caller loop would be dead code. It exists for the
   *  INV-7 / DEC-9 restore window — ops hydrated, pane buffers not yet mounted — where the honest
   *  answer is `'unknown'`, and as the assertion handle TEST-14 needs. */
  getSelectionStaleness(): SelectionStaleness | 'unknown' {
    const prov = this.stores.coordination.getState().selectionProvenance
    if (!prov || prov.ops.length === 0) return 'fresh'
    if (!this.resolvePanes || !this.liveContextProbe) return 'unknown'
    return selectionStaleness(prov.context, this.liveContextProbe(prov))
  }

  /** ITEM-13 / DEC-23 — force a re-evaluation and report whether it changed anything.
   *
   *  A THIN WRAPPER over the SAME internal `revalidate()` the automatic trigger calls — deliberately
   *  never a second implementation, because a parallel path is exactly the unreachable-API failure
   *  this method's re-scoping exists to avoid. Reachable jobs: the DEC-9 ops-only restore kick, and
   *  a host that swapped pane buffers through a route that does not tick the publish path. */
  revalidateSelection(): {
    changed: boolean
    before: readonly number[]
    after: readonly number[]
    staleness: SelectionStaleness | 'unknown'
  } {
    const before = this.currentIds()
    const staleness = this.getSelectionStaleness()
    this.revalidate()
    const after = this.currentIds()
    const changed = before.length !== after.length || before.some((v, i) => v !== after[i])
    return { changed, before, after, staleness }
  }

  getOption(opts?: GetOptionOptions): VizOption {
    const gridSlice = this.stores.gridWorkspace.getState().serialize()
    const coordSlice = this.stores.coordination.getState().serialize()
    const plotSlice = this.stores.plotInteraction.getState().serialize()
    const overrides = this.stores.colorOverride.getState().serialize()

    // grid + series = EVERY cell (ITEM-18), NOT just the main-grid leaves: a DOCKED-OUT pane (in a
    // pop-out container) keeps its config wherever it lives, so its series+config must round-trip too.
    // Order = the main-grid leaves (tree order) FIRST, then the docked-out cells across every
    // container — so a single-window (no-docking) workspace is BYTE-IDENTICAL to before (dockedIds is
    // empty ⇒ orderedIds === leaves). The main `layout` below still carries ONLY the main-grid leaves;
    // `docking` (emitted verbatim) carries WHERE each docked cell lives (container + return anchor),
    // and `setOption(replace)` feeds that snapshot back through the grid store's `hydrate`.
    const leaves = leafIds(gridSlice.layout)
    const leafSet = new Set(leaves)
    const dockedIds = Object.keys(gridSlice.cells).filter(id => !leafSet.has(id))
    const orderedIds = [...leaves, ...dockedIds]
    const grid: VizGridEntry[] = orderedIds.map(id => ({ id }))
    const series: VizSeries[] = orderedIds.map(id => seriesFromCell(gridSlice.cells[id]))

    // dataZoom config (id/type/coordId/axes) is preserved from the last resolved plan; the LIVE window
    // is read from the PlotInteraction store (the single serialize source, DEC-13).
    const dataZoom: VizDataZoom[] = (this.resolved?.dataZoom ?? []).map(dz => {
      const win = plotSlice.dataZoomWindows[dz.id]
      const band = valueBand(win)
      return {
        id: dz.id,
        type: dz.type,
        coordId: dz.coordId,
        axes: [...dz.axes],
        ...(band ? { window: band } : {}),
      }
    })

    // selection: config (mode/link) from the resolved plan; live ids/spaces from coordination.
    const liveSpaces = coordSlice.spaces
    const hasLiveSelection = coordSlice.selection.ids.length > 0 || (liveSpaces && Object.keys(liveSpaces).length > 0)
    let selection: VizSelection | undefined
    if (this.resolved?.selection || hasLiveSelection) {
      const spacesOut: Record<string, number[]> = {}
      if (liveSpaces) {
        for (const [spaceId, sel] of Object.entries(liveSpaces)) {
          spacesOut[spaceId] = [...sel.ids].sort((a, b) => a - b)
        }
      }
      // DEC-21: `'ops-only'` omits the CACHE (ids/spaces) and keeps the provenance. Absence is by
      // key-omission, not an empty array — TEST-26 asserts `'ids' in selection === false`, so
      // emitting `ids: []` would (correctly) fail rather than pass as "omitted".
      const opsOnly = opts?.selection === 'ops-only'
      const prov = coordSlice.provenance
      selection = {
        mode: this.resolved?.selection?.mode ?? 'lasso',
        link: this.resolved?.selection?.link ? [...this.resolved.selection.link] : [],
        ...(!opsOnly && coordSlice.selection.ids.length > 0
          ? { ids: [...coordSlice.selection.ids].sort((a, b) => a - b) }
          : {}),
        ...(!opsOnly && Object.keys(spacesOut).length > 0 ? { spaces: spacesOut } : {}),
        // PROVENANCE (ITEM-10): emitted only when the live selection actually has some, so an
        // option produced by a pre-provenance producer carries no `ops`/`context`/`provenance`
        // keys at all and stays byte-identical to before (INV-5, mirroring the `controls` idiom).
        ...(prov && prov.ops.length > 0
          ? {
              ops: prov.ops,
              ...(prov.context ? { context: prov.context } : {}),
              provenance: 'ziee-viz-selection/1' as const,
            }
          : {}),
      }
    }

    // colorScale: link from the resolved plan; RESOLVED domains projected from coordination's scopes.
    const domains: Record<string, readonly [number, number]> = {}
    for (const scope of Object.values(coordSlice.colorScales)) {
      if (scope && Array.isArray(scope.domain) && scope.domain.length === 2) {
        domains[scope.key] = [scope.domain[0], scope.domain[1]]
      }
    }
    const colorScale =
      this.resolved?.colorScale || Object.keys(domains).length > 0
        ? {
            link: this.resolved?.colorScale?.link ? [...this.resolved.colorScale.link] : [],
            ...(Object.keys(domains).length > 0 ? { domains } : {}),
          }
        : undefined

    const filters = Object.keys(plotSlice.filters).length > 0 ? { ...plotSlice.filters } : undefined
    const colorOverrides = Object.keys(overrides).length > 0 ? cloneColorOverrides(overrides) : undefined
    // Plot-editing: the per-control capabilities are authoring config (not live store state), carried on
    // the resolved plan; emit only the non-default subset.
    const controls: VizControls | undefined = this.resolved ? diffControls(this.resolved.controls) : undefined

    const option: VizOption = {
      version: VIZ_OPTION_VERSION,
      // Re-emit the `rev` (DEC-4) each dataset was acquired under, by KEY-OMISSION when there is
      // none — so an option that declared no rev round-trips byte-identically, and one that did
      // keeps its content token through `getOption()` → persist → `setOption(saved)`.
      datasets: this.acquiredDatasets.map(d => (d.rev === undefined ? { id: d.id } : { id: d.id, rev: d.rev })),
      grid,
      layout: cloneLayout(gridSlice.layout),
      ...(dataZoom.length > 0 ? { dataZoom } : {}),
      ...(selection ? { selection } : {}),
      ...(colorScale ? { colorScale } : {}),
      ...(filters ? { filters } : {}),
      ...(coordSlice.colorBySelection != null ? { colorBySelection: coordSlice.colorBySelection } : {}),
      ...(colorOverrides ? { colorOverrides } : {}),
      // Plot-editing: re-emit only the non-default per-control edit capabilities (byte-identical when unset).
      ...(controls ? { controls } : {}),
      // DEC-15: pass the pop-out docking snapshot straight through when a pane is docked out.
      ...(gridSlice.docking ? { docking: gridSlice.docking } : {}),
      series,
    }
    return option
  }

  /** The sole post-init mutation path — maps each action to the existing store call. */
  dispatch(action: VizAction): void {
    switch (action.type) {
      case 'select':
        this.stores.coordination.getState().setSelection(action.originId, action.ids)
        break
      case 'gridViewState':
        this.stores.coordination.getState().setGridViewState(action.spaceKey, action.viewState)
        break
      case 'dataZoom': {
        // Keep the imperative Map (back-compat) AND mirror into the AUTHORITATIVE PlotInteraction store
        // (DEC-13) so `getOption` has one serialize source. A single-axis band → a value window.
        this.dataZoomWindows.set(action.id, action.window)
        const band = action.window.x ?? action.window.y
        if (band) {
          this.stores.plotInteraction.getState().setDataZoomWindow(action.id, { lo: band[0], hi: band[1] })
        }
        // Make the stashed window a REAL signal: fan a typed `dataZoom` event (EVENT_API_PLAN).
        this.emitter.emit({
          type: 'dataZoom',
          id: action.id,
          axis: windowAxis(action.window),
          window: action.window,
        })
        break
      }
      case 'removePane': {
        // DEC-4: explicit pane removal (never by option omission). Resolve the pane's ACTUAL container
        // (a docked-out pane is NOT in the main layout; removeCell defaulting to PRIMARY_CONTAINER would
        // silently no-op), then PRUNE the stale `this.resolved.dataZoom` for the removed coordId —
        // otherwise `getOption` still emits a dataZoom for the gone pane and the next default (merge)
        // setOption feeds it into parseOption, which THROWS "dataZoom references unknown coordId".
        const container = this.stores.gridWorkspace.getState().paneContainer[action.id]
        this.stores.gridWorkspace.getState().removeCell(action.id, container)
        this.pruneResolvedForCell(action.id)
        break
      }
    }
    this.notify()
  }

  // ── Imperative post-init mutators (DATA_OWNERSHIP_INVERSION) ───────────────────────────────
  // Once the viz OWNS its data, every add/remove/manipulate is a COMMAND on the viz-owned stores.

  /** Add a cell by splitting the LAST leaf in `dir` (default a side-by-side column). Returns the
   *  new cell's id. Forwards to the grid store — no buffer re-pass. */
  addCell(dir?: SplitDir, kind?: CellKind, opts?: { datasetId?: string; source?: DataSource }): string {
    if (opts?.datasetId) {
      const ds = this.stores.datasetStore.getState()
      this.installResolver()
      if (opts.source) ds.provideSource(opts.datasetId, opts.source)
    }
    return this.stores.gridWorkspace.getState().addCell(dir, kind, undefined, opts?.datasetId)
  }

  /** Request a NEW plot (docking P5). With no pop-out window open this adds it directly to the main
   *  grid (returns the id). With ≥1 window open it enters AIM-TO-PLACE. */
  requestAddCell(dir?: SplitDir, kind?: CellKind): string {
    return this.stores.gridWorkspace.getState().requestAddCell(dir, kind)
  }

  /** Split the leaf `cellId` in `dir`, inserting a fresh cell beside it. Returns the new cell's id
   *  (`''` when `cellId` is not a leaf). */
  splitCell(cellId: string, dir: SplitDir, kind?: CellKind): string {
    return this.stores.gridWorkspace.getState().splitCell(cellId, dir, kind)
  }

  /** Remove the leaf `cellId` (collapses its parent split; a workspace always keeps ≥1 cell). Resolves
   *  the cell's actual container (so a docked-out pane is removable) + prunes its stale resolved
   *  dataZoom (parity with the `removePane` dispatch action). */
  removeCell(cellId: string): void {
    const container = this.stores.gridWorkspace.getState().paneContainer[cellId]
    this.stores.gridWorkspace.getState().removeCell(cellId, container)
    this.pruneResolvedForCell(cellId)
  }

  /** Change a cell's view-kind (the store carries compatible bindings across the switch). */
  setCellKind(cellId: string, kind: CellKind): void {
    this.stores.gridWorkspace.getState().setCellKind(cellId, kind)
  }

  /** Set a cell's per-cell COLOR-BY intent — a dense cell then recolors by pulling that column from
   *  the OWNED `source` (the GridWorkspace per-cell color effect), NO color buffer re-pass. */
  setCellColorBy(cellId: string, colorBy: ColorBy): void {
    this.stores.gridWorkspace.getState().setCellColorBy(cellId, colorBy)
  }

  /** Publish the shared point selection (canonical point ids) originating from `originId` (or null). */
  select(ids: Uint32Array | readonly number[] | null, originId?: string | null): void {
    const arr = ids == null ? null : ids instanceof Uint32Array ? ids : Uint32Array.from(ids)
    this.stores.coordination.getState().setSelection(originId ?? null, arr)
  }

  /** The last resolved plan (or `null` before the first `setOption`). */
  getResolved(): ResolvedOption | null {
    return this.resolved
  }

  /** The resolved `DataSource` of the last `setOption`. */
  getSource(): DataSource | null {
    return this.source
  }

  /** The isolated `VizStores` set this controller drives (VIZ_ISOLATION). */
  getStores(): VizStores {
    return this.stores
  }

  /** The current window model of a dataZoom instance — read from the AUTHORITATIVE PlotInteraction
   *  store first (DEC-13), falling back to the imperative Map for a shape the store can't hold. */
  getDataZoomWindow(id: string): VizWindow | null {
    const stored = this.stores.plotInteraction.getState().dataZoomWindows[id]
    const band = valueBand(stored)
    if (band) {
      // The store holds the window axis-agnostically ({lo,hi}); recover the axis from the resolved
      // dataZoom config (fallback: the axis-preserving imperative Map). Without this a y-axis window
      // reads back as {x:…} — an axis flip vs the main-branch Map fallback.
      const dz = this.resolved?.dataZoom?.find(z => z.id === id)
      const isY = dz
        ? dz.axes.includes('y') && !dz.axes.includes('x')
        : this.dataZoomWindows.get(id)?.y !== undefined
      return isY ? { y: [band[0], band[1]] } : { x: [band[0], band[1]] }
    }
    return this.dataZoomWindows.get(id) ?? null
  }

  /** Drop any resolved `dataZoom` entries targeting a removed cell so a subsequent `getOption` does not
   *  re-emit a dataZoom for a coordId that no longer resolves (which `parseOption` rejects LOUD). Also
   *  clears the imperative window Map + the PlotInteraction store entry for those ids. */
  private pruneResolvedForCell(cellId: string): void {
    this.pruneSelectionOpsForCell(cellId)
    if (!this.resolved) return
    const remove = this.resolved.dataZoom.filter(dz => dz.coordId === cellId)
    if (remove.length === 0) return
    const plot = this.stores.plotInteraction.getState()
    for (const dz of remove) {
      this.dataZoomWindows.delete(dz.id)
      plot.clearDataZoomWindow?.(dz.id)
    }
    this.resolved = { ...this.resolved, dataZoom: this.resolved.dataZoom.filter(dz => dz.coordId !== cellId) }
  }

  /** H4 — drop a removed pane's `selection.ops` for the same reason the dataZoom above is pruned:
   *  `getOption()` would otherwise emit an op naming a pane that no longer resolves, and
   *  `parseOption`'s unknown-pane guard rejects it LOUD — so a saved workspace becomes UNLOADABLE,
   *  and any later merge `setOption` throws too.
   *
   *  Only the REMOVED pane's ops are dropped, not the whole selection: ops on other panes are still
   *  valid, and discarding a user's entire selection because one pane closed would be a bigger
   *  surprise than losing the part that pane contributed. When nothing is left the provenance is
   *  cleared outright rather than left as an empty op list (an empty list would claim "this
   *  selection was derived from no ops", which is a different and false statement).
   *
   *  The ids CACHE is deliberately left alone here — this is a structural prune, and the automatic
   *  re-evaluation (DEC-19) publishes the corrected set on the next tick. */
  private pruneSelectionOpsForCell(cellId: string): void {
    const coord = this.stores.coordination.getState()
    const prov = coord.selectionProvenance
    if (!prov || prov.ops.length === 0) return
    const kept = prov.ops.filter(op => op.pane !== cellId)
    if (kept.length === prov.ops.length) return
    coord.setSelectionProvenance(
      kept.length > 0 ? { ops: kept, ...(prov.context ? { context: prov.context } : {}) } : null,
    )
  }

  /**
   * TEAR THIS CONTROLLER DOWN: release every DatasetStore ref it holds, drop its store subscription
   * and its listeners. The counterpart of `applyOption`'s acquire.
   *
   * Without it an abandoned controller (a closed analysis, an unmounted view) pinned its LAST
   * option's entries — resolved source, catalog, per-layout positions, colour buffer — for the life
   * of the store, because the only other release site is `applyOption`'s previous-ids sweep, which
   * runs on the NEXT `setOption` and for a torn-down controller never comes. The DatasetStore
   * routinely outlives its controllers (the default set is a module singleton shared by every
   * controller a page constructs), so "bounded per teardown" still never returned to zero.
   *
   * RELEASE, never EVICT. Two live controllers may hold the SAME dataset (two views over one
   * workspace); evicting here would yank the resolved source out from under a pane that is still
   * rendering it. Each holder's teardown decrements; only the last one drops the entry.
   *
   * IDEMPOTENT — it forgets what it released, so a double teardown cannot steal another holder's
   * ref. It also bumps the option generation, so a `setOption` still in flight bails at the existing
   * staleness guard (releasing what IT acquired) instead of re-pinning the store after teardown.
   * A `setOption` AFTER dispose is legal and simply re-acquires: the controller holds nothing.
   */
  dispose(): void {
    // Invalidate any in-flight applyOption (it releases its own acquisition at the staleness guard).
    this.optionSeq++
    const ds = this.stores.datasetStore.getState()
    for (const d of this.acquiredDatasets) ds.release(d.id)
    this.acquiredDatasets = []
    this.teardownSelectBridge()
    this.listeners.clear()
    this.resolvePanes = null
    this.liveContextProbe = null
  }

  /** Subscribe to coarse controller changes (setOption / dispatch — no payload). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

// ── pure helpers (getOption composition + merge) ───────────────────────────────────────────────

/** A value-axis band `[lo, hi]` from a stored dataZoom window, or `undefined` for a matrix window
 *  (which the option's `[lo,hi]` `dataZoom[].window` can't express — a heatmap keeps its own home). */
function valueBand(win: DataZoomWindow | undefined): readonly [number, number] | undefined {
  if (win && typeof (win as { lo?: number }).lo === 'number' && typeof (win as { hi?: number }).hi === 'number') {
    return [(win as { lo: number }).lo, (win as { hi: number }).hi]
  }
  return undefined
}

/** Deep-clone a `LayoutNode` (pure JSON data) so an emitted option never aliases the live tree. */
function cloneLayout(n: import('@ziee/dock').LayoutNode): import('@ziee/dock').LayoutNode {
  return n.kind === 'leaf'
    ? { kind: 'leaf', id: n.id }
    : { kind: 'split', dir: n.dir, sizes: [...n.sizes], children: n.children.map(cloneLayout) }
}

/** Convert an engine `ColorBy` (or its already-JSON-safe serialized form) into a strict-JSON
 *  `VizColorBy`: `hidden` (a `Set` or array) → a SORTED `number[]` (DEC-12). */
function colorByToVizJson(cb: ColorBy): VizColorBy {
  const raw = cb as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...raw }
  const h = raw.hidden as Iterable<number> | undefined
  if (h && typeof (h as Iterable<number>)[Symbol.iterator] === 'function') {
    const arr = [...h]
    if (arr.length > 0) out.hidden = [...arr].sort((a, b) => a - b)
    else delete out.hidden
  } else {
    delete out.hidden
  }
  return out as unknown as VizColorBy
}

/** Reverse `overlayEncode`: map a cell's resolved `bindings` (keyed by chart-schema channel id) back
 *  to the `VizEncode` well-known keys, using the chart type's own binding schema (the INVERSE, ITEM-1b).
 *  Unknown / no-schema charts contribute nothing (scatter/image/grid → `{}`). */
function bindingsToEncode(kind: CellKind, bindings: GridCell['bindings']): Partial<VizEncode> {
  if (!bindings) return {}
  const schema = getChartType(kind)?.bindingSchema
  if (!schema || schema.length === 0) return {}
  const enc: Record<string, unknown> = {}
  for (const channel of schema) {
    const v = bindings[channel.id]
    if (v == null) continue
    switch (channel.source) {
      case 'categorical':
        if (typeof v === 'string') enc.groupKey = v
        break
      case 'value':
        if (typeof v === 'string') enc.valueKey = v
        break
      case 'continuous':
        if (typeof v === 'string') enc.continuousKey = v
        break
      case 'valueList':
        if (Array.isArray(v)) enc.valueKeys = [...v]
        break
      case 'table':
        if (typeof v === 'string') enc.table = v
        break
    }
  }
  return enc as Partial<VizEncode>
}

/** Compose one `VizSeries` from a grid cell (the getOption per-cell projection). */
function seriesFromCell(cell: GridCell): VizSeries {
  const encode: VizEncode = {
    layout: cell.layoutId,
    ...bindingsToEncode(cell.kind, cell.bindings),
    ...(cell.colorBy ? { colorBy: colorByToVizJson(cell.colorBy) } : {}),
  }
  // Plot-editing (ITEM-5): re-emit the per-cell mark style onto series.style (only the set fields).
  const style =
    cell.style && (cell.style.radius !== undefined || cell.style.opacity !== undefined)
      ? {
          ...(cell.style.radius !== undefined ? { radius: cell.style.radius } : {}),
          ...(cell.style.opacity !== undefined ? { opacity: cell.style.opacity } : {}),
        }
      : undefined
  // Plot-editing (ITEM-4): re-emit the plot title + axis titles (only the set fields).
  const axisTitles =
    cell.axisTitles && (cell.axisTitles.x !== undefined || cell.axisTitles.y !== undefined)
      ? {
          ...(cell.axisTitles.x !== undefined ? { x: cell.axisTitles.x } : {}),
          ...(cell.axisTitles.y !== undefined ? { y: cell.axisTitles.y } : {}),
        }
      : undefined
  return {
    id: cell.id,
    type: cell.kind,
    coordId: cell.id,
    ...(cell.datasetId ? { datasetId: cell.datasetId } : {}),
    encode,
    ...(cell.graphOverlay === true ? { graphOverlay: true } : {}),
    ...(style ? { style } : {}),
    ...(cell.title !== undefined ? { title: cell.title } : {}),
    ...(axisTitles ? { axisTitles } : {}),
    // MATRIX value colormap (heatmap/dotplot) round-trip — mirrors the scatter's colorBy.colormap.
    ...(cell.valueColormap ? { valueColormap: cell.valueColormap } : {}),
    // Phase 3: round-trip the controlled-close flag (mirrors `graphOverlay`) so a getOption→setOption
    // restore keeps a controlled cell controlled (else its close would revert to the built-in remove).
    ...(cell.controlled === true ? { controlled: true } : {}),
    // …and the reason its close is unavailable, for the same reason: a restore that dropped it would
    // hand the user back the live-but-dead X this field exists to remove.
    ...(cell.removeBlockedReason !== undefined ? { removeBlockedReason: cell.removeBlockedReason } : {}),
    // …and the provenance marker, for the same reason again: a save/restore that dropped it would
    // hand back an UNMARKED picture of data whose provenance is still unverified.
    ...(cell.provenanceNote !== undefined ? { provenanceNote: cell.provenanceNote } : {}),
    // COMPOSED CANVAS: the authored id + its contributing view. Dropping these on the round-trip
    // would restore a grid whose panes are addressed by the host's internal composition key again —
    // the exact leak they exist to close, reintroduced by a save/restore.
    ...(cell.localId !== undefined ? { localId: cell.localId } : {}),
    ...(cell.ownerId !== undefined ? { ownerId: cell.ownerId } : {}),
  }
}

/** Deep-clone the strict-JSON per-column display-override map (mirrors `parse.ts::cloneColorOverrides`). */
function cloneColorOverrides(
  m: Record<string, import('../viz-core/option/types').VizColorOverride>,
): Record<string, import('../viz-core/option/types').VizColorOverride> {
  const out: Record<string, import('../viz-core/option/types').VizColorOverride> = {}
  for (const [k, v] of Object.entries(m)) {
    out[k] = {
      ...(v.categoryColors ? { categoryColors: { ...v.categoryColors } } : {}),
      ...(v.categoryLabels ? { categoryLabels: { ...v.categoryLabels } } : {}),
    }
  }
  return out
}

/** Merge two `VizControls` at control + flag granularity: incoming wins per flag, base fills the rest.
 *  Returns `undefined` when neither side carried controls (byte-identical passthrough). */
function mergeControls(base?: VizControls, inc?: VizControls): VizControls | undefined {
  if (!base && !inc) return undefined
  const ids = ['legend', 'colormap', 'titles', 'pointSize'] as const
  const out: { [K in (typeof ids)[number]]?: { show?: boolean; editable?: boolean } } = {}
  for (const id of ids) {
    const b = base?.[id]
    const i = inc?.[id]
    if (!b && !i) continue
    const cap: { show?: boolean; editable?: boolean } = {}
    const show = i?.show !== undefined ? i.show : b?.show
    const editable = i?.editable !== undefined ? i.editable : b?.editable
    if (show !== undefined) cap.show = show
    if (editable !== undefined) cap.editable = editable
    if (cap.show !== undefined || cap.editable !== undefined) out[id] = cap
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Merge two id-keyed arrays: base entries first (updated in place by a matching incoming entry), new
 *  incoming entries appended — so existing panes/series keep their order and unmatched ones are kept. */
function mergeById<T extends { id: string }>(base: readonly T[] | undefined, inc: readonly T[] | undefined): T[] {
  const map = new Map<string, T>()
  for (const e of base ?? []) map.set(e.id, e)
  for (const e of inc ?? []) map.set(e.id, e) // incoming overrides an existing id, or is appended
  return [...map.values()]
}

/** Shallow-merge two record maps (incoming wins per key); `undefined` when both absent. */
function mergeMap<V>(
  base: Record<string, V> | undefined,
  inc: Record<string, V> | undefined,
): Record<string, V> | undefined {
  if (!base && !inc) return undefined
  return { ...(base ?? {}), ...(inc ?? {}) }
}

/**
 * MERGE (DEC-6/DEC-13): fold `inc` into `base` (the current `getOption()`). Arrays
 * (`series`/`grid`/`dataZoom`/`datasets`) match by id (unmatched kept); singleton/map fields
 * (`selection`/`colorScale`/`filters`/`colorOverrides`) deep-merge by their own key. The base layout
 * is kept when `inc` adds NO new grid id (preserving nested splits/sizes); when `inc` introduces a new
 * pane the layout is dropped so `parseOption` re-derives the tree (incorporating the new leaf).
 */
export function mergeOptions(base: VizOption, inc: VizOption): VizOption {
  const baseGridIds = new Set((base.grid ?? []).map(g => g.id))
  const incAddsGrid = (inc.grid ?? []).some(g => !baseGridIds.has(g.id))
  const grid = mergeById(base.grid, inc.grid)

  // selection: deep-merge (mode/link/ids override by presence; spaces merge by key).
  let selection: VizSelection | undefined
  if (base.selection || inc.selection) {
    const b = base.selection
    const i = inc.selection
    const mergedSpaces = mergeMap(b?.spaces as Record<string, readonly number[]> | undefined, i?.spaces as Record<string, readonly number[]> | undefined)
    // PROVENANCE MERGE (ITEM-12 / DEC-5). `ops` + `context` are ONE ATOMIC UNIT and are never
    // key-merged:
    //  (a) an incoming `selection` carrying `ops` REPLACES the base ops wholesale. Concatenating two
    //      op lists would silently change what the selection MEANS — the list is an ordered recipe
    //      (`[add A, subtract B]` is not `[subtract B, add A]`), not a set to union.
    //  (b) an incoming `selection` carrying `ids`/`spaces` but NO `ops` DROPS the base's ops +
    //      context. Keeping them would leave provenance describing a set that is no longer there —
    //      a lie, and the same failure the store guards by clearing provenance on a clear.
    //  (c) an incoming partial with NO `selection` at all preserves the base's provenance untouched.
    const incomingTouchesSelection = i != null
    const incomingHasOps = i?.ops != null
    const keepBaseProvenance = !incomingTouchesSelection || (!incomingHasOps && i?.ids == null && i?.spaces == null)
    const provSrc = incomingHasOps ? i : keepBaseProvenance ? b : undefined

    //  (d) H5 — `ops` and the `ids`/`spaces` CACHE are ONE atomic unit. When rule (a) replaces the
    //      base ops, the base's ids describe the OLD recipe, so inheriting them would emit a
    //      selection whose recipe and cache denote different sets — and with a matching context the
    //      gatekeeper classifies `'none'` and never repairs it (DEC-19/INV-2 violated on the merge
    //      path). An ops-carrying patch with no ids therefore emits NO ids: automatic
    //      re-evaluation republishes the correct cache, and INV-7 guarantees an ops-only option
    //      restores the right live selection.
    //      CONV-9 — the predicate is `incomingHasOps` ALONE. It used to carry `&& i?.ids == null`,
    //      which applied the rule only to ops-WITHOUT-ids patches: an incoming `{ops, ids}` left it
    //      FALSE, `spacesSrc` fell through to `mergedSpaces`, and the BASE's stale per-space cache
    //      survived under the REPLACED recipe (with `mergeMap` even resurrecting base-only space
    //      keys the incoming omitted). What invalidates the base cache is the RECIPE being
    //      replaced; whether the patch also carries `ids` is irrelevant to that. `idsSrc` is
    //      unchanged by the widening: when `incomingHasOps` and `i.ids` exists, the old and new
    //      predicates both yield `i.ids`.
    const dropStaleCache = incomingHasOps
    const idsSrc = dropStaleCache ? i?.ids : (i?.ids ?? b?.ids)
    // CONV-2 — `spaces` is the OTHER half of the same atomic cache and must drop SYMMETRICALLY with
    // `ids`: discard the BASE's stale per-space cache under a replaced recipe, but keep the
    // INCOMING patch's own spaces (they belong to the incoming recipe). The original wrote
    // `!dropStaleCache && mergedSpaces`, which threw away the incoming's spaces too — and since
    // `getOption()` emits `{ops, spaces}` with NO `ids` for every multi-dataset selection whose
    // DEFAULT space is empty (serialize() excludes the default space), the canonical
    // `setOption(getOption())` round-trip silently lost the whole per-space cache.
    const spacesSrc = dropStaleCache ? i?.spaces : mergedSpaces
    selection = {
      mode: i?.mode ?? b?.mode ?? 'lasso',
      link: i?.link ?? b?.link ?? [],
      ...(idsSrc ? { ids: [...idsSrc] } : {}),
      ...(spacesSrc && Object.keys(spacesSrc).length > 0 ? { spaces: spacesSrc } : {}),
      ...(provSrc?.ops
        ? {
            ops: provSrc.ops,
            ...(provSrc.context ? { context: provSrc.context } : {}),
            ...(provSrc.provenance ? { provenance: provSrc.provenance } : {}),
          }
        : {}),
    }
  }

  // colorScale: link overrides by presence; domains merge by key.
  let colorScale: VizOption['colorScale']
  if (base.colorScale || inc.colorScale) {
    const domains = mergeMap(base.colorScale?.domains, inc.colorScale?.domains)
    colorScale = {
      link: inc.colorScale?.link ?? base.colorScale?.link ?? [],
      ...(domains && Object.keys(domains).length > 0 ? { domains } : {}),
    }
  }

  const filters = mergeMap(base.filters, inc.filters)
  const colorOverrides = mergeMap(base.colorOverrides, inc.colorOverrides)
  const colorBySelection =
    inc.colorBySelection !== undefined ? inc.colorBySelection : base.colorBySelection
  // Plot-editing: merge `controls` per-control, per-flag (incoming wins), preserving unset flags.
  const controls = mergeControls(base.controls, inc.controls)

  return {
    version: inc.version ?? base.version,
    datasets: mergeById(base.datasets, inc.datasets),
    grid,
    // Preserve the exact split tree when no NEW pane is introduced; else let parseOption rebuild it.
    ...(!incAddsGrid && (inc.layout ?? base.layout) ? { layout: inc.layout ?? base.layout } : {}),
    ...(mergeById(base.dataZoom, inc.dataZoom).length > 0
      ? { dataZoom: mergeById(base.dataZoom, inc.dataZoom) }
      : {}),
    ...(selection ? { selection } : {}),
    ...(colorScale ? { colorScale } : {}),
    ...(filters ? { filters } : {}),
    ...(colorBySelection !== undefined ? { colorBySelection } : {}),
    ...(colorOverrides ? { colorOverrides } : {}),
    ...(controls ? { controls } : {}),
    ...(inc.docking ?? base.docking ? { docking: inc.docking ?? base.docking } : {}),
    series: mergeById(base.series, inc.series),
  }
}
