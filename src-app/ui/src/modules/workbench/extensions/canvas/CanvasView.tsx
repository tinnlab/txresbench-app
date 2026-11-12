// CanvasView (ITEM-56) — the permanent center HERO. This round replaces the
// Observable-Plot `hasVizFramework=false` fallback with the REAL viz engine:
// `<GridWorkspace source={workbenchDataSource} />` (the in-repo `@txresbench/viz` deck.gl
// grid), bound to the project `DataSource` (ITEM-66, api-injected so the fake-host
// gallery drives the catalog with no backend). The canvas is NEVER a tab and NEVER
// reflows on recolor — a recolor updates the floating legend chip while the grid node
// stays mounted (canvas-hero discipline, IA §4.5.3).
//
// HONEST LIMIT: `GridWorkspace` renders on deck.gl/WebGL2 and self-guards a headless
// context (`webglAvailable()` → its own fallback). In a headless gallery/CI box the
// GPU grid can't paint; the STRUCTURE (host + chip + empty-state) is what the gallery +
// e2e assert. A real GPU render is a manual/CI concern (see the module report).
//
// COLOR-BY: the selected field is surfaced via a viz-flavored legend chip; the full viz
// `ColorBy`/`computeColoring`/`Legend` categorical wiring needs the categorical
// control-plane (`DataSource.categorical()`, deferred — DR-2/DR-? in workbenchDataSource),
// so per-field GPU recolor is a follow-on data-resolution concern, not fabricated here.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { Empty, Tag } from '@txresbench/kit'
import {
  GridWorkspace,
  VizController,
  VizEventBusContext,
  closeEventBus,
  type DataSource,
  type DatasetResolver,
  type VizOption,
} from '@txresbench/viz'
import {
  workbenchPlotSurfaceContainers,
  installHostedSurfaceCloser,
  declaresPositions,
  type DatatypeLattice,
} from '@/modules/workbench/core'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { buildCanvasSources } from './canvasDataSource'
import { useDeclarativeCanvasFeed, type CellCloseRouter } from './declarativeCanvasFeed.store'
import { teardownCanvas } from './canvasBinding'
import { CanvasCoverage } from './CanvasCoverage'

/** Surface a canvas `setOption` failure instead of silently painting a blank grid (a malformed or
 *  unresolvable option must leave a trace). Console-only — a failed live merge during a threshold
 *  drag must not spam a user toast; the operator/CI reads the console. */
function logCanvasError(err: unknown): void {
  console.error('[CanvasView] VizController.setOption failed', err)
}

/** Does the project's produced catalog contain a plottable-XY artifact to plot? Resolved
 *  GENERICALLY off the declared `plottable-xy` capability via the lattice (no hardcoded
 *  `id === 'embedding'`, DEC-7).
 *
 *  The capability and the defensive `matches` call are `core/datatypes/plottable.ts`'s, by
 *  IMPORT rather than by a local literal agreeing with one: the anchor's candidacy rule now
 *  asks the identical question, and a rule spelled twice is one edit away from two rules. */
function hasPlottableType(ids: string[], lattice: DatatypeLattice): boolean {
  return ids.some(id => declaresPositions(id, lattice))
}

/** The viz grid, memoized so a parent recolor re-render does NOT remount the deck grid
 *  (canvas-hero discipline — no reflow on every color-by click).
 *
 *  THE CONTAINER RESOLVERS ARE WHAT KEEP THE CANVAS AT FULL WIDTH. Without them the grid
 *  falls back to its OWN internal right panel for a plot's edit form / plotting-data table /
 *  export dialog — a column INSIDE the workspace, so opening a plot's editor shrank the plot
 *  being edited, and opening the whole-grid export shrank the whole grid being exported.
 *  With them, each open surface is portaled into a container the shell mints for it and
 *  renders as its own workbench pane in the RIGHT region, beside the canvas rather than
 *  inside it. They are resolved PER OPEN SURFACE (the grid's INV-8), so editing two plots at
 *  once gives two panes, not one pane that retargets.
 *
 *  `exportDialogContainer` is the same seam with a wider SUBJECT: viz calls it with the plot
 *  pane id for a per-plot export and with its reserved whole-grid sentinel for the rail's
 *  "Export whole grid" — one container per subject, and (because viz allows a single open
 *  export) one export pane at a time. */
const CanvasGrid = memo(function CanvasGrid({ source }: { source: DataSource }) {
  return (
    <GridWorkspace
      source={source}
      editFormContainer={workbenchPlotSurfaceContainers.editForm}
      dataTableContainer={workbenchPlotSurfaceContainers.dataTable}
      registerHostedSurfaceClose={installHostedSurfaceCloser}
      exportDialogContainer={workbenchPlotSurfaceContainers.exportDialog}
    />
  )
})

/** Optional `source` override (the gallery/tests pass a `FixtureSource` so the grid has
 *  data to paint without a backend); default = the api-injected project DataSource. */
export interface CanvasViewProps {
  source?: DataSource
  /**
   * declarative-canvas-plots ITEM-4 — a RESOLVED canvas `VizOption` (from the declarative engine's
   * `resolveCanvasOption`). When present, the center canvas is DRIVEN by a `VizController.setOption`
   * (the ONE canvas grid — never a second `<Viz>`), instead of the default embedding scatter. The
   * `datasetResolver` maps the option's LOGICAL dataset ids (`obs` / `obs.kept` / `<ds>.obs` /
   * `<ds>.kept`) to sources (`createDatasetResolver`). This is the injection seam (mirrors
   * `source?`): the LIVE feed (the active analysis -> its resolved option + resolver) is wired in
   * slice 4 alongside the run-pane form; slice 3 lands the seam + the drive.
   */
  canvasOption?: VizOption
  datasetResolver?: DatasetResolver
}

export function CanvasView({ source: sourceOverride, canvasOption, datasetResolver }: CanvasViewProps = {}) {
  const { api, projectId, producedTypeIds, lattice } = useWorkbench()
  const hasPlottable = useMemo(() => hasPlottableType(producedTypeIds, lattice), [producedTypeIds, lattice])

  // One data plane per (project, api). Rebuilt only when the project changes.
  //
  // ITEM-8: `sources.streaming` is the ONE data-input seam (DEC-2) and it is MEMOIZED by
  // `buildCanvasSources`, which is what makes the clean-replace below safe. A colour change is an
  // option change, and an option change rebuilds the `VizController` (`canvasOption` is in its
  // dep list) → a fresh `DatasetStore` resolver install → a re-`acquire` → a re-resolve. If that
  // re-resolve reached a NEW source it would re-read positions on every recolour. It reaches the
  // same instance, so the re-read is served from that source's replay buffer and costs ZERO
  // additional decodes — which is INV-2, and it is asserted in `canvasDataSource.test.ts` rather
  // than argued here.
  const sources = useMemo(() => buildCanvasSources(api, projectId), [api, projectId])
  const source = useMemo(
    () => sourceOverride ?? sources.pull,
    [sourceOverride, sources],
  )

  // ITEM-4: when an analysis declares a canvas option, drive the SINGLE canvas grid via ONE
  // `VizController.setOption` over the SAME (default) viz stores `GridWorkspace` reads. The
  // controller uses the injected `DatasetResolver` (falling back to the single project source) so
  // the option's logical dataset ids resolve. A clean-replace on each option change.
  const controller = useMemo(
    () =>
      canvasOption
        ? // The STREAMING seam when nothing overrides the resolver (ITEM-8). An injected
          // `datasetResolver` — the declarative path — still wins and stays on the pull seam:
          // it resolves LOGICAL ids to SYNTHESIZED per-pane sources (built by
          // `createDatasetResolver`), which are not `StreamingSource`s and cannot become ones
          // before ITEM-42 unifies the byte route.
          // Exactly one of the two may be supplied, so this is a branch, not a merge.
          datasetResolver || sourceOverride
          ? new VizController({ resolveDataset: datasetResolver ?? (() => source) })
          : new VizController({ resolveSource: () => sources.streaming })
        : null,
    [canvasOption, datasetResolver, sourceOverride, source, sources],
  )
  useEffect(() => {
    if (!controller || !canvasOption) return
    void controller.setOption(canvasOption, { replace: true }).catch(logCanvasError)
  }, [controller, canvasOption])
  // Dispose the explicit-prop controller when it is replaced (canvasOption/datasetResolver/source
  // change → a fresh VizController) or on unmount — mirror the live path's teardownCanvas so the
  // prior instance's panes/resources are released instead of leaked.
  useEffect(() => {
    if (!controller) return
    return () => teardownCanvas(controller)
  }, [controller])

  // ── the GENERAL declarative-canvas path (declarative-processor-ui Slice 3/4 / ITEM-10/17) ──────
  // ANY declarative processor that declares a `canvas:` block drives the ONE canvas grid via this
  // feed (published by `DeclarativeRegion` — `declarativeCanvasFeed.store`). The option + resolver
  // are already resolved (the app knows nothing about "cell-filter" — its dynamic before/after,
  // criteria, group-by all live in the DATA package's `canvas`/`for_each`), so we clean-replace on
  // each option change. Slice 4 additionally wires the CONTROLLED cell-close seam (ITEM-17): a
  // controlled cell's `cell-close(coordId)` routes through the feed's `onCellClose` to the declared
  // close action (the reopen-loop guard, DEC-7) instead of viz self-removing the cell.
  const { active: declActive, option: declOption, resolver: declResolver, onCellClose } = useDeclarativeCanvasFeed()
  const declOn = !canvasOption && declActive && declOption != null
  const declControllerRef = useRef<VizController | null>(null)
  const declResolverRef = useRef<DatasetResolver | null>(null)
  // The LATEST close router, refreshed every publish, so the controller's `cell-close` handler
  // (subscribed once) routes against the CURRENT `closeActions` map (a re-resolve keeps the
  // controller but rebuilds the coordId→action mapping as criteria are added/removed).
  const onCellCloseRef = useRef<CellCloseRouter | null>(null)
  // The bus the grid raises plot events on. Built by viz (so the event's name and payload stay its
  // business) and wired to the SAME router the controller subscription uses — one routing rule,
  // two ways in. Stable across renders (it reads the ref), so providing it never re-renders.
  const routeClose = useCallback((id: string) => onCellCloseRef.current?.(id), [])
  const plotEventBus = useMemo(() => closeEventBus(routeClose), [routeClose])
  useEffect(() => {
    onCellCloseRef.current = onCellClose
    if (canvasOption || !declActive || !declOption) {
      if (declControllerRef.current) {
        teardownCanvas(declControllerRef.current)
        declControllerRef.current = null
      }
      return
    }
    // Refresh the resolver ref every run so a persistent controller re-resolves against the
    // LATEST published resolver (a new obs slice / keep-mask).
    declResolverRef.current = declResolver
    if (!declControllerRef.current) {
      const c = new VizController({
        resolveDataset: (id: string) => (declResolverRef.current ?? (() => source))(id),
      })
      // Controlled cell-close (ITEM-17 / DEC-8): route the user's close X through the declared
      // action via the feed's router — viz emits `cell-close` (does NOT self-remove) for a cell
      // stamped `controlled: true`, so the app owns the removal (a state mutation → the `for_each`
      // render drops the cell without a reopen loop).
      c.on('cell-close', (e: { cellId: string }) => routeClose(e.cellId))
      declControllerRef.current = c
    }
    void declControllerRef.current.setOption(declOption, { replace: true }).catch(logCanvasError)
  }, [canvasOption, declActive, declOption, declResolver, source, onCellClose])

  // Tear the declarative controller down on unmount.
  useEffect(
    () => () => {
      if (declControllerRef.current) {
        teardownCanvas(declControllerRef.current)
        declControllerRef.current = null
      }
    },
    [],
  )

  // A declared canvas option OR a declarative-canvas feed ALWAYS has something to plot — bypass
  // the embedding empty-state.
  if (!hasPlottable && !canvasOption && !declOn) {
    return (
      <div
        data-testid="workbench-canvas-host"
        data-workbench-canvas
        className="relative flex min-h-0 flex-1 items-center justify-center"
      >
        <Empty
          data-testid="workbench-canvas-empty"
          title="Nothing to plot yet"
          description="Run an analysis that produces a plottable artifact to visualize it on the canvas."
        />
      </div>
    )
  }

  return (
    <div
      data-testid="workbench-canvas-host"
      data-workbench-canvas
      data-viz-framework="true"
      className="relative flex min-h-0 flex-1 overflow-hidden"
    >
      {/* THE PLOT-EVENT BUS (visualize-pane ITEM-32).
         *
         * A `controlled` plot does not remove itself — it raises a close EVENT and lets the app own
         * the removal, which is the reopen-loop guard. It raises it on THIS bus, a React context
         * `<Viz>` provides around its own grid; this host composes `<GridWorkspace>` itself, so
         * there was no provider and the emit reached nothing. The close X on every declared plot
         * was live, styled, focusable — and silently did nothing, which is the exact defect
         * `removeBlockedReason` exists to prevent one case further along.
         *
         * Wired to the same router the controller subscription uses, so there is ONE routing rule
         * and two ways in rather than two rules. */}
      {/* ITEM-19: the load-coverage indicator, fed by the APP's own stream (see CanvasCoverage's
          header for why not viz's `onProgress`, and for why it is ABSENT below ~8k rows rather
          than flashing a full bar). Rendered in the app-owned host div, so it costs viz nothing.
          `sourceOverride` means an injected fixture/pull source — nothing to observe. */}
      <CanvasCoverage source={sourceOverride ? null : sources.streaming} />
      <VizEventBusContext.Provider value={plotEventBus}>
        <CanvasGrid source={source} />
      </VizEventBusContext.Provider>
    </div>
  )
}
