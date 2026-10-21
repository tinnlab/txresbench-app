// react/Viz.tsx — the `<Viz option={...} />` React binding (EXTENSIBILITY_STUDY Part 6 STEP 7).
// A THIN wrapper around the STEP-6 `VizController` + the existing `GridWorkspace`: on mount /
// option change it runs `controller.setOption(option)` (which populates the shared grid +
// coordination stores from the declarative plan) and then renders the EXISTING `GridWorkspace`,
// which reads that store state. It does NOT reimplement rendering — it is the declarative façade
// over the imperative component.
//
// DATA-OWNERSHIP INVERSION: the deck visual buffers (`positions`/`colors`) + the `catalog` are now
// OPTIONAL (inherited from `GridWorkspaceProps`). When omitted, `GridWorkspace` pulls them from
// `source` ONCE and OWNS them — so the end-state handoff is just `<Viz source={source}
// option={initialLayout} onController={...} />`, after which the app holds nothing big and every
// add/remove/manipulate is an imperative `controller.addCell(...)` / `setCellColorBy(...)` command
// (no buffer re-pass). When the buffers ARE passed (existing callers), they flow through unchanged.
// The `option` drives the LAYOUT + cell kinds/bindings/coordination on top. `resolveDataset`
// defaults to the passed `source`, so the common single-source case needs no extra wiring, and the
// controller (exposed via `onController`, its `getSource()` returning the owned source) is the
// post-mount `dispatch(action)` + mutator surface.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GridWorkspace, type GridWorkspaceProps } from '../viz-core/grid/GridWorkspace'
import type { OrthographicViewState } from '@deck.gl/core'
import { ChartError } from '../viz-core/charts/useAsyncChartData'
import {
  CpuRasterView,
  type VizProgress,
  type ColorBy,
  type ColorByResolver,
} from '../viz-core/density/CpuRasterView'
import type { VizData } from '../adapter/vizData'
import { densify, type DataSource } from '../viz-core/data/wire'
import type { StreamingSource, StreamingResolver } from '../viz-core/data/streamingSource'
import { asDataSource } from '../viz-core/data/streamingAdapter'
import { VizController } from '../adapter/VizController'
import { VizEventBusContext } from '../viz-core/events/EventBusContext'
import { VizControlsContext } from '../viz-core/controls/ControlsContext'
import { createVizStores, VizStoresProvider } from '../adapter/vizStores'
import { resolveControls } from '../viz-core/option/types'
import type { ResolvedOption, VizControls, VizOption, VizWindow, VizColorBy } from '../viz-core/option/types'
import type { TooltipContext } from '../viz-core/tooltip/tooltipModel'
import {
  shouldRestoreOnReload,
  persistWindowOption,
  readWindowOption,
  focusToUrl,
  isFocusUrlReconciled,
  type NavigationTypeEntry,
} from '../adapter/windowRestore'
import type { StorageLike } from '../viz-core/persist/autosaveCore'

/** Trailing-debounce default for `onChange` (DEC-13; configurable via `onChangeDebounceMs`). */
const DEFAULT_ON_CHANGE_DEBOUNCE_MS = 150

/** The SOLE element of `xs`, or `undefined` when there are none or several.
 *
 *  The difference between a binding that asserts nothing and one that asserts something nobody
 *  said: `length === 1` is not a choice at all, while `xs[0]` on a longer list claims position 0
 *  means something, and no catalog contract says it does. Same helper, same reason, as
 *  `viz-core/registry/model.ts`'s (kept local rather than shared — that one is not exported, and
 *  reaching into the registry from the React façade for three lines is worse coupling than a
 *  three-line duplicate). */
function sole<T>(xs: readonly T[]): T | undefined {
  return xs.length === 1 ? xs[0] : undefined
}

/**
 * Structural test for the ONE streaming data-input seam (DEC-2): a `StreamingSource` exposes
 * `catalog()` + `stream()`. A legacy pull `DataSource` (8 `Promise<TypedArray>` methods) has neither,
 * so this cleanly discriminates the union on `source`/`resolveDataset` — the streaming path routes to
 * the controller's `resolveSource`; a `DataSource` keeps the byte-identical legacy `resolveDataset`
 * path (until ITEM-17 migrates every adopter/story off `DataSource`). EXPORTED for unit testing.
 */
export function isStreamingSource(s: unknown): s is StreamingSource {
  return (
    s != null &&
    typeof (s as { stream?: unknown }).stream === 'function' &&
    typeof (s as { catalog?: unknown }).catalog === 'function'
  )
}

/**
 * Does an `option` carry LIVE interaction state (not just a declarative layout)? A restored snapshot
 * (`getOption()` → app store → `<Viz option={saved}>`) carries selection / dataZoom / filters /
 * overrides / camera / docking; applying it must REPLACE (`{ replace: true }`) so the live state is
 * restored verbatim rather than merged into the current one. A layout-only option (the common
 * declarative mount) carries none of these → the default merge/build path (byte-identical to today).
 * EXPORTED for unit testing.
 */
export function optionCarriesLiveState(o: VizOption): boolean {
  return (
    o.selection != null ||
    o.dataZoom != null ||
    o.filters != null ||
    o.colorOverrides != null ||
    o.colorScale != null ||
    o.colorBySelection != null ||
    o.docking != null
  )
}

// Distinct sentinels for the two "no value" cases so they never collide (see `stableOptionKey`).
// `null` already stringifies to the literal `'null'`; `undefined` (and a non-serializable value
// like a function/symbol, whose `JSON.stringify` is `undefined`) needs its OWN key or the two
// would both map to `'null'` and a genuine null↔undefined change would be missed.
const UNDEFINED_KEY = '__undefined__'

/**
 * A stable STRUCTURAL key for the small declarative `VizOption` — recursively key-sorted so two
 * value-equal options (commonly rebuilt inline each parent render, differing only in identity)
 * stringify to the SAME key. Used to gate `setOption` (H6) so it re-runs only on a genuine value
 * change, not on every parent render. Pure (no deps); operates on the tiny declarative plan only.
 *
 * EXPORTED for unit testing. `undefined` maps to a distinct sentinel (NOT `'null'`) so it never
 * collides with `null` — the previous `JSON.stringify(undefined) ?? 'null'` keyed both to `'null'`.
 */
export function stableOptionKey(value: unknown): string {
  if (value === undefined) return UNDEFINED_KEY
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? UNDEFINED_KEY
  if (Array.isArray(value)) return `[${value.map(stableOptionKey).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stableOptionKey(obj[k])}`)
    .join(',')}}`
}

/**
 * PURE decision for ITEM-22 (1) restore-only-on-reload: given the ambient Performance-Navigation
 * type entry and the per-window snapshot read from `sessionStorage`, return the `VizOption` to
 * re-apply (`{ replace: true }`) — or `null` to leave the declarative mount untouched. A genuine
 * reload with a saved snapshot restores; a `window.open` child tab (nav type `'navigate'`) does NOT
 * (it inherited a COPY of the opener's sessionStorage). Thin, testable wrapper over the already-tested
 * `shouldRestoreOnReload`. EXPORTED for unit testing (the React mount effect can't run in the node pass).
 */
export function planReloadRestore(
  navEntry: NavigationTypeEntry,
  saved: VizOption | null,
): VizOption | null {
  return shouldRestoreOnReload(navEntry, saved != null) ? saved : null
}

/**
 * PURE decision for ITEM-22 (2) URL-as-view-into-focus: given the current `href` and the focused
 * pane id, return the NEXT href to push via `history.replaceState` — or `null` when the URL already
 * reflects the focus (no history write needed). `''` normalizes to `null` (no pane focused). Thin,
 * testable wrapper over the already-tested `isFocusUrlReconciled` / `focusToUrl`. EXPORTED for testing.
 */
export function nextFocusUrl(href: string, focusedPaneId: string | null): string | null {
  const norm = focusedPaneId === '' ? null : focusedPaneId
  if (isFocusUrlReconciled(href, norm)) return null
  return focusToUrl(href, norm)
}

/** Guarded `sessionStorage` accessor — `null` under SSR or a sandboxed context where the property
 *  access itself throws. The window-restore helpers accept `null` and no-op, so every persistence
 *  path is SSR-/sandbox-safe. */
function safeSessionStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage as unknown as StorageLike
  } catch {
    return null
  }
}

/** Coerce an unknown thrown value into a human-readable message for `<ChartError>`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Failed to apply the visualization option'
}

export interface VizProps extends Omit<GridWorkspaceProps, 'source'> {
  /**
   * The ONE data-input seam (DEC-2): a `StreamingSource` (`catalog()` + keyed `stream(channel)`).
   * Bulk data always streams, so the progressive path can't be bypassed. It is wired to the
   * controller's STREAMING resolver (`resolveSource` → `DatasetStore.setStreamingResolver`), and a
   * `StreamingSource` view is also handed to `GridWorkspace` (via `asDataSource`) for the
   * ownership-inversion default-cell pull. A resident array enters the `StreamingSource` via
   * `fromArray()` at the source's own boundary — there is no non-streaming entry.
   *
   * SCOPE-DOWN: a legacy pull `DataSource` is STILL accepted here and routes to the byte-identical
   * legacy `resolveDataset` path — the showcase stories + the CytoAnalyst adopter pass a
   * `FixtureSource`/`DataSource` and are migrated to `StreamingSource` under a SEPARATE item
   * (ITEM-17). This union is the transitional surface, not the end state.
   *
   * OPTIONAL when {@link VizProps.data} is provided (the progressive raster path owns the surface)
   * or in a pure multi-dataset workspace fed only through {@link VizProps.resolveDataset}. */
  readonly source?: StreamingSource | DataSource
  /** The declarative option — drives the grid layout, cell kinds/bindings, and coordination. A
   *  restored snapshot (an option carrying live selection/zoom/filter/override/docking state) is
   *  applied with `{ replace: true }` so it restores verbatim; a layout-only option takes the
   *  default merge/build path. OPTIONAL when {@link VizProps.data} is provided. */
  readonly option?: VizOption
  /**
   * PROGRESSIVE data source (STREAMING_PROGRESSIVE_PLAN Wave 2a — the no-boilerplate API). Hand a
   * `Float32Array`, a URL string, a `ReadableStream`/`AsyncIterable<Uint8Array>`, or the object form
   * (`{ positions, stride?, packed?, total? }`) STRAIGHT to `<Viz>` and it owns EVERYTHING: fetch,
   * reframe (whole-row reassembly), bin, progressive blurry→sharp emit, progress, and cancellation
   * on change/unmount. A plain array and a stream behave IDENTICALLY (both render, both cancel),
   * differing only in WHEN bytes arrive — the app writes just `<Viz data={url | stream | array} />`.
   * When present, `<Viz>` renders the density raster instead of the `option`/grid surface. ABSENT ⇒
   * the existing `option`/`source` grid path, byte-identical to today.
   *
   * SCOPE-DOWN (ITEM-13 / DEC-2): this `data` raster union + {@link VizProps.colorBy} /
   * {@link VizProps.resolveChannel} / {@link VizProps.categorySlots} are the CpuRasterView surface,
   * kept here because `data-progressive.story.tsx` (uneditable in this item) still drives it. The
   * end state folds this surface into the ONE streaming `source`; that removal lands with the story
   * migration (ITEM-17), not in this file.
   */
  readonly data?: VizData
  /**
   * PROGRESSIVE coloring channel for the `data` raster (STREAMING_PROGRESSIVE_PLAN Wave 2b). Friendly
   * default `'density'` (count → colormap, byte-identical to Wave 2a). `{ label: key }` colors by a
   * streamed category (per-cell argmax hue); `{ value: key }` colors by a streamed continuous mean,
   * its scale driven by the channel's KLL p1/p99. The `key` is resolved to a source via
   * {@link VizProps.resolveChannel} or the `data` object form's own `labels`/`value`. Switching a
   * `{ value }` key re-binds ONE column over the resident positions — never the whole matrix.
   */
  readonly colorBy?: ColorBy
  /** Resolve a {@link VizProps.colorBy} `key` → its channel column source (the matrix bind-a-column
   *  seam). Omit when the `data` object form already carries `labels`/`value`. */
  readonly resolveChannel?: ColorByResolver
  /** number of category slots (top-K label codes) tracked when coloring by label (default 16). */
  readonly categorySlots?: number
  /** Fired as a `data` stream arrives: `{ rowsSeen, coveragePct }` (coverage known when a total is).
   *  A surviving typed event (DEC-13) — today it is the raster-stream progress; a future grid
   *  streaming-progress source emits here too. */
  readonly onProgress?: (progress: VizProgress) => void
  /** OPTIONAL fully-controlled camera for the `data` raster surface (CpuRasterView). When provided the
   *  HOST owns the camera — so an external selection overlay can share the SAME view and stay anchored
   *  over the raster. Absent ⇒ the internal data-extent fit (unchanged). */
  readonly viewState?: OrthographicViewState
  /** Fired on every camera change of the `data` raster (pairs with {@link VizProps.viewState}). */
  readonly onViewStateChange?: (viewState: OrthographicViewState) => void
  /** Resolve a `datasets[].id` → its {@link StreamingSource} (id-based multi-dataset seam, DEC-1).
   *  Wired to the controller's `resolveSource`; defaults to the passed {@link VizProps.source}. */
  readonly resolveDataset?: StreamingResolver
  /** Called with the resolved plan after each successful `setOption`. */
  readonly onMounted?: (resolved: ResolvedOption) => void
  /** Called when applying the option (`setOption`) rejects — e.g. a bad binding that
   *  `parseOption` throws on, or a dataset resolve/catalog failure. The error is ALSO surfaced
   *  visually (a `<ChartError>` replaces the grid) so a rejected option is never a silent blank. */
  readonly onError?: (err: unknown) => void
  /** Receives the controller once (for post-mount `dispatch(action)`). */
  readonly onController?: (controller: VizController) => void
  /** Fired when the shared point selection changes (EVENT_API_PLAN `select`): the CANONICAL point
   *  ids (empty array when cleared) + the origin view id that produced it (`null` when unknown). */
  readonly onSelect?: (ids: Uint32Array, origin: string | null) => void
  /** Fired when the user closes a cell marked `controlled` (EVENT_API_PLAN `cell-close`): the cell's id.
   *  A controlled cell is NOT removed by viz — the app owns removal (route it to the declared close
   *  action). A non-controlled cell removes itself and fires nothing. */
  readonly onCellClose?: (cellId: string) => void
  /** Fired when a per-plot dataZoom window changes (EVENT_API_PLAN `dataZoom`) — from an
   *  interactive slider/wheel/pan commit OR an imperative `dispatch({ type: 'dataZoom' })`. */
  readonly onDataZoom?: (id: string, window: VizWindow) => void
  /** Fired on pointer hover over a picked mark (EVENT_API_PLAN `hover`): the mark's id (`null` on
   *  leave / empty space) + its scalar value when known. rAF-throttled (≤ one per frame). */
  readonly onHover?: (id: number | null, value?: number) => void
  /** Fired when a categorical legend toggles category visibility (EVENT_API_PLAN `legend`): the
   *  color-by `column` id + the full set of hidden category codes (ascending). */
  readonly onLegendChange?: (column: string, hidden: readonly number[]) => void
  /** Fired when a continuous filter (visualMap / value-gate) range changes (EVENT_API_PLAN
   *  `filter`): the control `id` + the new `[lo, hi]` range (`null` when cleared). */
  readonly onFilter?: (id: string, range: [number, number] | null) => void
  /**
   * The consolidated CHANGE callback (ITEM-5, DEC-13): fired after any store mutation (selection /
   * zoom / filter / override / layout / docking) with the current `getOption()` — exactly the
   * `VizOption` the app persists and re-feeds via `<Viz option={saved}>`. TRAILING-DEBOUNCED
   * ({@link VizProps.onChangeDebounceMs}, default 150ms) so a per-frame gesture (a linked pan)
   * collapses to ONE emit instead of an allocation/GC storm. SURVIVES alongside the typed event
   * callbacks (`onSelect`/`onHover`/… — DEC-13); it does NOT replace them. Omitted — AND no
   * {@link VizProps.restoreWindowKey} — ⇒ no store subscriptions are wired (byte-identical). */
  readonly onChange?: (option: VizOption) => void
  /** Trailing-debounce window (ms) for {@link VizProps.onChange} (DEC-13; default 150). */
  readonly onChangeDebounceMs?: number
  /**
   * OPT-IN (default `false`): reflect the focused pane into the URL as `?pane=<id>` on every focus
   * change (ITEM-22 (2) URL-as-view-into-focus). There is no first-class "focused pane" store today,
   * so this wires the WRITE direction onto the nearest EXISTING focus signal — the `select` event's
   * `origin` (the view/pane id that produced the current selection) — via `history.replaceState`. The
   * READ direction (an inbound `?pane=` driving initial focus) has no consumer to drive until a focus
   * store exists, so it is intentionally deferred (a future item / e2e). OFF ⇒ no subscription, the
   * URL is never touched (byte-identical). Guarded: SSR / no-`history` is a no-op. */
  readonly syncFocusToUrl?: boolean
  /**
   * OPT-IN built-in reload-restore (ITEM-22 (1)). When set, this instance persists its `getOption()`
   * into `sessionStorage` under THIS key and, on a genuine page reload (not a `window.open` copy),
   * re-applies it. Default `undefined` ⇒ OFF: no built-in persistence and NO extra store subscriptions
   * (the app OWNS persistence via {@link VizProps.onChange} — the primary contract; DEC-3). The key
   * MUST be unique PER `<Viz>` instance on a page — two instances sharing one key would restore each
   * other's snapshot (the reason this is an app-supplied key, not a fixed internal constant). */
  readonly restoreWindowKey?: string
  /**
   * Plot-editing (ITEM-1/8): the per-control edit capabilities (legend / colormap / titles / pointSize
   * `{show?, editable?}`). Takes PRECEDENCE over `option.controls` — the escape hatch for the
   * EAGER-buffer app path (`VisualizationPage` mounts `<Viz positions colors>` with no `option`, so it
   * can't carry `option.controls`). Absent ⇒ `option.controls` ⇒ the per-control defaults (DEC-4:
   * legend editable, the rest shown read-only). */
  readonly controls?: VizControls
}

/**
 * Declaratively mount a coordinated grid from a `VizOption`, rendering the shared-store-backed
 * `GridWorkspace`. Re-runs `setOption` whenever `option` changes (a clean replace, per the
 * controller's v1 contract).
 */
export function Viz({
  source,
  option,
  data,
  colorBy,
  resolveChannel,
  categorySlots,
  onProgress,
  viewState,
  onViewStateChange,
  resolveDataset,
  onMounted,
  onError,
  onController,
  onSelect,
  onCellClose,
  onDataZoom,
  onHover,
  onLegendChange,
  onFilter,
  onChange,
  onChangeDebounceMs,
  syncFocusToUrl,
  restoreWindowKey,
  controls,
  ...grid
}: VizProps) {
  // ONE fresh, fully-independent store set per `<Viz>` instance (VIZ_ISOLATION W3). Every store
  // access under this `<Viz>` resolves to this set via `<VizStoresProvider>` below, so multiple
  // `<Viz>` on one page never clobber each other's selection / grid / overrides / dataZoom. The
  // controller + session-state capture/restore (through the controller) target THIS set too.
  const stores = useMemo(() => createVizStores(), [])
  // The controller is created ONCE (a ref), so its dataset resolver must read the LATEST `source` /
  // `resolveDataset` through refs — otherwise it captures the first-render `source` and a later
  // `<Viz source={sourceB}>` splits the controller (still resolving sourceA) from the grid (rendering
  // sourceB). Refs updated every render; the resolver closure is stable.
  const sourceRef = useRef(source)
  sourceRef.current = source
  const resolveDatasetRef = useRef(resolveDataset)
  resolveDatasetRef.current = resolveDataset
  const controllerRef = useRef<VizController | null>(null)
  if (controllerRef.current === null) {
    // ONE data-input seam (DEC-2): route to the controller's STREAMING resolver when the caller feeds
    // a `StreamingSource` (or a streaming `resolveDataset`); a legacy pull `DataSource` keeps the
    // byte-identical `resolveDataset` path. The KIND is stable per `<Viz>` instance (a single mount
    // never swaps data-plane kinds), so this decision is made once; the concrete source may still
    // change (sourceA→sourceB) — the resolver reads the LATEST through `sourceRef`/`resolveDatasetRef`.
    // In `data` (progressive) mode the controller is unused; `source` may be absent there.
    const streaming = resolveDataset != null || isStreamingSource(source)
    controllerRef.current = new VizController(
      streaming
        ? {
            resolveSource: (id: string) => {
              const custom = resolveDatasetRef.current
              return custom ? custom(id) : (sourceRef.current as StreamingSource)
            },
            stores,
          }
        : {
            resolveDataset: (_id: string) => sourceRef.current as DataSource,
            stores,
          },
    )
  }
  // The `DataSource` view `GridWorkspace` consumes for the ownership-inversion default-cell pull
  // (buffers/catalog/color for a cell with NO `datasetId`). A `StreamingSource` is adapted once via
  // `asDataSource` (the same boundary the DatasetStore uses, ITEM-12) so the grid render stays
  // byte-identical; a legacy `DataSource` passes straight through; `undefined` (pure multi-dataset /
  // `data` mode) stays undefined (every cell then resolves ITS dataset's source from the store).
  const gridSource = useMemo<DataSource | undefined>(
    () => (source == null ? undefined : isStreamingSource(source) ? asDataSource(source) : source),
    [source],
  )

  // AUTO HOVER TOOLTIP (declarative path): the low-level `GridWorkspace` shows a rich scatter tooltip only
  // when handed a `tooltipContext`, which the declarative `<Viz option>` path never built — so its plots
  // had no tooltip. Build one from the source's RESIDENT columns (positions + the scatter series' color-by
  // group/value columns) so every declarative scatter gets a WYSIWYG tooltip. A caller-supplied
  // `tooltipContext` always wins (this is a fallback). O(1) at hover — columns are indexed, never fetched.
  // Structural key of the option (STABLE across identity-only churn) — the gate for both `setOption` (below)
  // and the auto-tooltip fetch. Defined here so the tooltip block (above `setOption`) can also key on it.
  const optionKey = useMemo(() => stableOptionKey(option), [option])
  const tooltipCtxProp = (grid as { tooltipContext?: TooltipContext }).tooltipContext
  const [autoTooltip, setAutoTooltip] = useState<TooltipContext | null>(null)
  // The color-by columns to surface, classified by ACCESSOR (categorical/continuous/value each read
  // differently by the engine). Keyed on the option's structural KEY (not its identity — callers build
  // `option` inline, so identity churns every render; `stableOptionKey` is the same gate `setOption` uses),
  // so the fetch effect below does NOT re-run on unrelated parent re-renders.
  const tooltipKeys = useMemo(() => {
    const colorBys = (option?.series ?? [])
      .filter(s => s.type === 'scatter')
      .map(s => s.encode?.colorBy ?? (s as { colorBy?: VizColorBy }).colorBy)
      .filter((c): c is VizColorBy => !!c)
    const catKeys: string[] = []
    const contKeys: string[] = []
    const valueKeys: string[] = []
    for (const c of colorBys) {
      if ('key' in c) {
        if (c.mode === 'categorical') catKeys.push(c.key)
        else if (c.mode === 'value') valueKeys.push(c.key)
        else contKeys.push(c.key) // 'continuous'
      } else {
        catKeys.push(c.categoryKey)
        contKeys.push(c.valueKey)
      }
    }
    return { catKeys, contKeys: [...new Set(contKeys)], valueKeys: [...new Set(valueKeys)] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey])
  useEffect(() => {
    if (tooltipCtxProp || !gridSource) {
      setAutoTooltip(null)
      return
    }
    const src = gridSource
    let alive = true
    void (async () => {
      try {
        // ── NEITHER THE LAYOUT NOR THE GROUP COLUMN IS GUESSED ────────────────────────────────
        //
        // This used to read `src.positions('primary')` and `tooltipKeys.catKeys[0] ??
        // cat.categoricalColumns[0]?.id` — two guesses of the exact family
        // `docs/design/binding-resolution-refusal.md` names:
        //
        //   • `'primary'` is a bare hardcoded LAYOUT literal — what the in-package fixtures and the
        //     grid store happen to call their default layout, while a real host source addresses
        //     layouts by artifact id. The identical literal was removed from
        //     `useGridData.pullOwnedData` for this reason: on any project with no embedding
        //     artifact the source was asked for an artifact literally named `primary` and rejected.
        //   • `categoricalColumns[0]` picks a grouping column by CATALOG ORDER, which is real,
        //     stable and meaningless — so it produces a plausible, confident, wrong tooltip row
        //     (this is how an ENSEMBL-index column ends up presented as the grouping).
        //
        // So both bind on EVIDENCE only. The layout is the catalog's SOLE declared layout; zero or
        // several and there is no auto-tooltip at all, which is a handled state — this whole block
        // is additive chrome (a caller-supplied `tooltipContext` always wins, and `if (catKey)`
        // below already shows contributing nothing is normal). Refusing here costs a tooltip;
        // guessing costs a wrong one, which is worse because it looks right.
        const cat = await src.catalog()
        const layout = sole(cat.layouts)
        if (!layout) {
          if (alive) setAutoTooltip(null)
          return
        }
        const pos = await src.positions(layout.id)
        // The group row binds a DECLARED color-by key only when the option declares exactly one
        // (several and nothing chooses between them); failing that, the catalog's SOLE categorical
        // column. Never the 0th of a longer list.
        // DISTINCT-set, not raw length: `catKeys` is COLLECTED across every series, so two
        // scatter series coloured by the SAME column push that key twice. A `length === 1`
        // test then refuses a case where every candidate names one column — provably
        // consistent, and it used to work. Matches `anchorId`'s rule in the app tier, which
        // makes the same distinction for the same reason.
        const distinctCatKeys = [...new Set(tooltipKeys.catKeys)]
        const catKey =
          distinctCatKeys.length === 1 ? distinctCatKeys[0] : sole(cat.categoricalColumns)?.id
        let codes: Uint16Array | undefined
        let categories: readonly string[] | undefined
        if (catKey) {
          try {
            const g = await src.categorical(catKey)
            codes = g.codes
            categories = g.categories
          } catch { /* column unavailable → no group row */ }
        }
        const columns: Record<string, Float32Array> = {}
        // continuous columns via `continuous()`; VALUE columns via `valueColumn()` + densify (the engine
        // reads `mode:'value'` — e.g. gene expression — through a DIFFERENT accessor than `continuous`).
        for (const k of tooltipKeys.contKeys) {
          try { columns[k] = (await src.continuous(k)).value } catch { /* skip */ }
        }
        for (const k of tooltipKeys.valueKeys) {
          if (k in columns) continue
          try { columns[k] = densify(await src.valueColumn(k)) } catch { /* skip */ }
        }
        if (!alive) return
        setAutoTooltip({
          positions: pos.positions,
          codes,
          categories,
          columns: Object.keys(columns).length ? columns : undefined,
        })
      } catch {
        if (alive) setAutoTooltip(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [gridSource, tooltipKeys, tooltipCtxProp])

  // Notify the caller of the controller ONCE on mount — NEVER during render. Calling `onController`
  // in the render body (e.g. a parent's `setController` useState setter) throws "Cannot update a
  // component while rendering a different component" and aborts React's commit, leaving the grid's
  // shared deck canvas unmounted. Read through a ref so a changing `onController` identity doesn't
  // re-fire.
  const onControllerRef = useRef(onController)
  onControllerRef.current = onController
  useEffect(() => {
    onControllerRef.current?.(controllerRef.current!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // H1 — the grid→controller registration handler. `useCallback([])` keeps its identity stable so the
  // grid's registration effect runs once per mount rather than on every render. The controller is a
  // ref (created once), so reading it here is safe.
  const registerSelectionPanes = useCallback(
    (
      resolve: Parameters<VizController['registerSelectionPanes']>[0],
      liveContext: Parameters<VizController['registerSelectionPanes']>[1],
    ) => controllerRef.current!.registerSelectionPanes(resolve, liveContext),
    [],
  )

  // H1 — DEV-only controller seam, so the PRODUCT wiring above is falsifiable from an e2e.
  //
  // `__VIZ_PROV__` is installed by the GRID and therefore cannot prove the CONTROLLER received the
  // resolvers. `getSelectionStaleness()` answers `'unknown'` iff no resolver was ever registered, so
  // asserting it is not `'unknown'` fails exactly when `onSelectionPanes` is unwired — which is the
  // defect H1 found. Same guard + install posture as `__VIZ_PROV__` / `__VIZ_INCELL__`, but WITH the
  // cleanup those two omit (audit L18), so a remounting dev session doesn't retain stale controllers.
  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return
    const w = window as unknown as { __VIZ_CONTROLLER__?: VizController | null }
    w.__VIZ_CONTROLLER__ = controllerRef.current
    return () => {
      if (w.__VIZ_CONTROLLER__ === controllerRef.current) w.__VIZ_CONTROLLER__ = null
    }
  }, [])

  // Wire the declarative event callbacks to the controller's typed emitter (EVENT_API_PLAN). Read
  // the latest callback through a ref so re-subscription is keyed only on a callback's PRESENCE
  // toggling (not its identity — a parent passing an inline fn each render mustn't churn the
  // store-backed `select` bridge). Each `on(...)` returns an unsubscribe run on unmount.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onCellCloseRef = useRef(onCellClose)
  onCellCloseRef.current = onCellClose
  const onDataZoomRef = useRef(onDataZoom)
  onDataZoomRef.current = onDataZoom
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  const onLegendChangeRef = useRef(onLegendChange)
  onLegendChangeRef.current = onLegendChange
  const onFilterRef = useRef(onFilter)
  onFilterRef.current = onFilter
  const hasSelect = onSelect != null
  const hasCellClose = onCellClose != null
  const hasDataZoom = onDataZoom != null
  const hasHover = onHover != null
  const hasLegend = onLegendChange != null
  const hasFilter = onFilter != null
  useEffect(() => {
    const controller = controllerRef.current!
    const offs: Array<() => void> = []
    if (hasSelect) offs.push(controller.on('select', e => onSelectRef.current?.(e.ids, e.origin)))
    if (hasCellClose) offs.push(controller.on('cell-close', e => onCellCloseRef.current?.(e.cellId)))
    if (hasDataZoom) offs.push(controller.on('dataZoom', e => onDataZoomRef.current?.(e.id, e.window)))
    if (hasHover) offs.push(controller.on('hover', e => onHoverRef.current?.(e.id, e.value)))
    if (hasLegend)
      offs.push(controller.on('legend', e => onLegendChangeRef.current?.(e.column, e.hidden)))
    if (hasFilter) offs.push(controller.on('filter', e => onFilterRef.current?.(e.id, e.range)))
    return () => {
      for (const off of offs) off()
    }
  }, [hasSelect, hasCellClose, hasDataZoom, hasHover, hasLegend, hasFilter])

  // Gate `setOption` on the option's VALUE, not its identity (H6). `setOption` clears selection,
  // resets the dataZoom windows, refetches the catalog, and wholesale-`setState`s the grid — so
  // re-running it on every parent render (a caller building `option` inline gets a fresh identity
  // each render) silently wiped the user's live selection + zoom. Keying the effect on a stable
  // structural key skips redundant same-value re-applies while still running on first mount and on
  // any genuine option change. `appliedKeyRef` is the belt-and-suspenders guard.
  const appliedKeyRef = useRef<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  // Plot-editing: the RESOLVED per-control edit capabilities, provided to the in-cell overlays via
  // context. The direct `controls` prop WINS over `option.controls` (the eager-buffer app path has no
  // option); either derives synchronously (static authoring config, no controller wait).
  const resolvedControls = useMemo(
    () => resolveControls(controls ?? option?.controls),
    [controls, option?.controls],
  )

  useEffect(() => {
    // Clear any stale error whenever the applied-option key changes. This covers BOTH:
    //  • REVERT to the last-successful option — its key is already applied, so the guard below
    //    returns early; without this clear, an intervening failed option's `<ChartError>` would
    //    stay rendered permanently over the (valid, already-applied) chart.
    //  • FAILED → try a NEW valid option — don't flash the old error while the new one loads.
    // A failed attempt re-sets `error` in the reject handler below. `setError(null)` when already
    // null is a no-op (React Object.is-bails), so this adds no render on the common path.
    setError(null)
    // Progressive `data` mode owns the surface — skip the grid/`setOption` machinery entirely.
    if (data != null || option == null) return
    if (appliedKeyRef.current === optionKey) return
    let alive = true
    // `setOption` is fire-and-forget from React's view, so a rejection (a bad binding that
    // `parseOption` throws on, a dataset/catalog failure) would otherwise be an UNHANDLED rejection
    // + a silent blank grid. Catch it → visible `<ChartError>` + `onError`. Crucially, mark this
    // key "applied" ONLY on SUCCESS: latching it before the await (the old bug) would permanently
    // block a retry after a transient failure — an unchanged option would never be re-applied.
    // The DECLARATIVE `option` prop is always the COMPLETE intended state, so a prop change is a
    // REPLACE (the component's v1 "clean replace" contract) — NOT a merge. Merge-to-add-a-pane is the
    // IMPERATIVE `controller.setOption(partialOption)` path (DEC-6), never the prop. Replacing also
    // restores a live-state `getOption()` snapshot VERBATIM (ITEM-5). (Merging here was the bug that
    // let a new option accumulate the PRIOR option's series — e.g. good→bad left both series bound to
    // one region, throwing "region bound by more than one series" instead of the bad option's own
    // validation error; caught by the viz-error-surface e2e.)
    void controllerRef
      .current!.setOption(option, { replace: true })
      .then(
      resolved => {
        if (!alive) return
        appliedKeyRef.current = optionKey
        setError(null)
        onMounted?.(resolved)
      },
      err => {
        if (!alive) return
        // Do NOT set `appliedKeyRef` — leave the key un-applied so a later re-render carrying this
        // same option (or a re-mount) can retry rather than staying permanently blank.
        setError(err)
        onError?.(err)
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey])

  // TEARDOWN: release what the controller holds when this instance goes away. `setOption` takes a
  // DatasetStore ref per declared dataset and releases the PREVIOUS set on the NEXT apply — so an
  // unmount with no final apply would leave the last option's entries pinned. `dispose()` RELEASES
  // (never evicts), so a dataset another live controller shares is untouched.
  //
  // The applied-key latch is cleared with it, and the two belong together: having released the refs,
  // the last applied option is no longer in effect, so a re-mount of this same component instance
  // (React StrictMode's double-invoke keeps refs) must RE-APPLY it instead of early-returning on a
  // stale latch and rendering against datasets nobody holds.
  useEffect(() => {
    const controller = controllerRef.current!
    return () => {
      controller.dispose()
      appliedKeyRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ITEM-22 (1) restore-only-on-reload: on mount, re-apply the per-window `VizOption` snapshot from
  // `sessionStorage` — but ONLY when the Performance-Navigation type is a genuine `reload`. A
  // `window.open` / target=_blank child tab reports `navigate` even though it inherited a COPY of the
  // opener's sessionStorage, so `planReloadRestore` (via `shouldRestoreOnReload`) returns `null` and
  // the child correctly mounts from its declarative `option` instead of resurrecting the opener's
  // layout. Declared AFTER the declarative `setOption` effect so, on a reload, this restore's
  // `setOption` STARTS LAST and the controller's monotonic generation stamp makes it win. Guarded:
  // SSR / no-`performance` / progressive `data` mode all no-op. Mount-only ([] deps).
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  useEffect(() => {
    if (data != null || restoreWindowKey == null) return
    if (typeof window === 'undefined' || typeof performance === 'undefined') return
    let navEntry: NavigationTypeEntry
    try {
      navEntry = performance.getEntriesByType?.('navigation')?.[0] as unknown as NavigationTypeEntry
    } catch {
      return
    }
    const saved = readWindowOption(safeSessionStorage(), restoreWindowKey)
    const toRestore = planReloadRestore(navEntry, saved)
    if (toRestore == null) return
    // Fire-and-forget with a catch so a rejected restore surfaces via `onError` instead of an
    // unhandled rejection (mirrors the declarative `setOption` effect above). No `onMounted` here —
    // the declarative apply already fires it; a restore is a silent overlay of the saved live state.
    void controllerRef.current!.setOption(toRestore, { replace: true }).catch(err => {
      onErrorRef.current?.(err)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The consolidated `onChange` seam (ITEM-5, DEC-13): a debounced store subscription emitting the
  // strict-JSON `VizOption` via `controller.getOption()` — the
  // single object the app persists and re-feeds as `<Viz option={saved}>`. Survives ALONGSIDE the
  // typed event callbacks (they carry per-event payloads `getOption()` can't). Gated on the
  // callback's PRESENCE (latest read via a ref); omitted ⇒ NO subscriptions (byte-identical). The
  // debounce mirrors the autosave rationale: a per-frame `getOption()` deep-reads the whole slice set.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const hasChange = onChange != null
  const changeDebounceMs = onChangeDebounceMs ?? DEFAULT_ON_CHANGE_DEBOUNCE_MS
  // ITEM-22 (1) persist side: OPT-IN via `restoreWindowKey` (default off ⇒ the app OWNS persistence
  // through `onChange`, DEC-3). When a key is supplied, mirror each debounced `getOption()` into THAT
  // per-instance `sessionStorage` snapshot so a genuine reload can restore it. The app-supplied key
  // isolates instances (two `<Viz>` on a page must pass DISTINCT keys), so this no longer clobbers
  // across instances. No-op under SSR / progressive `data` mode / no key.
  const persistWindow = restoreWindowKey != null && data == null && typeof window !== 'undefined'
  useEffect(() => {
    if (!hasChange && !persistWindow) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const fire = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const opt = controllerRef.current!.getOption()
        onChangeRef.current?.(opt)
        if (persistWindow) persistWindowOption(safeSessionStorage(), restoreWindowKey!, opt)
      }, changeDebounceMs)
    }
    const offs = [
      stores.gridWorkspace.subscribe(fire),
      stores.coordination.subscribe(fire),
      stores.colorOverride.subscribe(fire),
      stores.plotInteraction.subscribe(fire),
    ]
    return () => {
      if (timer) clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [hasChange, persistWindow, changeDebounceMs])

  // ITEM-22 (2) URL-as-view-into-focus (OPT-IN via `syncFocusToUrl`, default off ⇒ byte-identical
  // no-op — no subscription, the URL is never touched). No first-class focus store exists (do-not-
  // invent rule), so the WRITE direction reflects the nearest EXISTING focus signal — the `select`
  // event's `origin` (the view/pane id that produced the current selection) — into `?pane=<id>` via
  // `history.replaceState`. `nextFocusUrl` returns `null` when the URL already reflects the focus
  // (no redundant history write). Guarded: SSR / no-`history` / no-`replaceState` all no-op.
  const syncFocus = syncFocusToUrl === true
  useEffect(() => {
    if (!syncFocus) return
    if (typeof window === 'undefined' || typeof history === 'undefined' || typeof history.replaceState !== 'function')
      return
    const controller = controllerRef.current!
    const reconcile = (origin: string | null) => {
      const href = window.location?.href
      if (typeof href !== 'string') return
      const next = nextFocusUrl(href, origin)
      if (next == null) return
      try {
        history.replaceState(history.state, '', next)
      } catch {
        /* replaceState can throw (cross-origin / too-many-calls) — a URL reflection must never break the app */
      }
    }
    // Only reconcile on an ACTUAL focus change (a `select` with its `origin`); we deliberately do NOT
    // wipe an inbound `?pane=` on mount, since the READ direction has no consumer yet to honor it.
    const off = controller.on('select', e => reconcile(e.origin))
    return () => off()
  }, [syncFocus])

  // Progressive `data` mode: the viz owns fetch→reframe→bin→emit→cancel; render the density raster
  // full-bleed instead of the grid. The app plumbs nothing — just `<Viz data={url|stream|array} />`.
  // EVERY branch is wrapped in `<VizStoresProvider value={stores}>` so the WHOLE subtree under this
  // `<Viz>` resolves the per-instance set (VIZ_ISOLATION W3). Data mode (CpuRasterView) touches no
  // coordination stores, but is wrapped uniformly so the contract holds regardless of mode.
  if (data != null) {
    return (
      <VizStoresProvider value={stores}>
        <div style={{ width: '100%', height: '100%' }} data-testid="viz-data-progressive">
          <CpuRasterView
            data={data}
            colorBy={colorBy}
            resolveChannel={resolveChannel}
            categorySlots={categorySlots}
            onProgress={onProgress}
            onError={onError}
            viewState={viewState}
            onViewStateChange={onViewStateChange}
          />
        </div>
      </VizStoresProvider>
    )
  }

  // Always surface the failure (never a silent blank grid) — the same "show the error" rule the
  // chart Views honor, now at the declarative top level.
  if (error !== null) {
    return (
      <VizStoresProvider value={stores}>
        <ChartError message={errorMessage(error)} />
      </VizStoresProvider>
    )
  }

  // Provide the controller's event bus so per-plot DataZoom components (deep inside the grid's
  // chart Views) can emit `dataZoom` on commit without prop-drilling. Context passes transparently
  // through `GridWorkspace` — no change to it needed. A bare `<GridWorkspace>` (no provider) emits
  // nothing (byte-identical).
  return (
    <VizStoresProvider value={stores}>
      <VizEventBusContext.Provider value={controllerRef.current}>
        <VizControlsContext.Provider value={resolvedControls}>
          <GridWorkspace
            {...(grid as Omit<GridWorkspaceProps, 'source'>)}
            // H1 — closes the loop between the grid (which owns the per-cell buffers) and the
            // controller (which owns the public `revalidateSelection()` / `getSelectionStaleness()`
            // surface but has no buffers). Registering IMMEDIATELY kicks `revalidate()`, which is what
            // closes the DEC-9 window for an ops-only option hydrated before any pane existed.
            onSelectionPanes={registerSelectionPanes}
            // Declarative auto-tooltip (caller-supplied `tooltipContext` still wins via `tooltipCtxProp`).
            tooltipContext={tooltipCtxProp ?? autoTooltip ?? undefined}
            // `gridSource` is undefined in RESOLVER-ONLY mode (`resolveDataset` with no `source` prop):
            // there the cells pull data from the DatasetStore's resolver, not this prop, so the required
            // `GridWorkspaceProps.source` is legitimately absent. The cast reflects that reality (NOT a
            // gratuitous type lie — `source` is a REQUIRED prop, so `gridSource` cannot be passed raw).
            source={gridSource as DataSource}
          />
        </VizControlsContext.Provider>
      </VizEventBusContext.Provider>
    </VizStoresProvider>
  )
}
