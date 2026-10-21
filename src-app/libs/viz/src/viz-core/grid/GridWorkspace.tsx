// GridWorkspace.tsx — the free-form resizable grid canvas (DEC-19/20/21). The DOM
// layout is a nested `react-resizable-panels` tree (draggable dividers); ONE
// `<DeckGL>` spans the whole workspace with N `OrthographicView`s (one per pane),
// and a `layerFilter` routes each cell's scatter layer into its own view — so there
// is a SINGLE WebGL context regardless of pane count (DEC-20).
//
// The DOM panels sit ABOVE the (transparent-background) Deck canvas but are
// pointer-transparent except their separators, so drags resize panes while pan /
// hover fall through to Deck. A ResizeObserver on the container + the panels'
// `onLayoutChanged` re-measure each pane's pixel rect → the deck views follow.
//
// viz-core rule: depends only on @deck.gl/* + react + react-resizable-panels
// (no @ziee/*), so it extracts with the package. The store lives in adapter/.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { type PaneRect } from '../layers/multiView'
import type { GraphData } from '../data/wire'
import { type ScreenPoint } from './gridSelection'
import { containmentPassCount } from '../selection/SelectionController'
import { type ResolvePane } from '../selection/provenance'
import type { VizSelectionContext, VizSelectionOp } from '../option/types'
import { type TooltipCatalogLabels, type TooltipContext } from '../tooltip/tooltipModel'
// SPLIT N (ITEM-30): `contrastMaxForDtype` / `seedChannelsForLoader` / `sourceForCell` / `ImageEntry`
// / `PyramidEntry` are imported by `useGridRaster.ts` now — the raster plane was their only consumer
// here (DRIFT-47's class: imports made dead BY the move, removed in the same commit).
import { orderedCells, paneTestId as resolvePaneTestId, type GridCell } from './gridModel'
import { PropagateConfirmDialog } from './PropagateConfirmDialog'
import type { GeoFeature } from '../annotate/processorPort'
// SPLIT G (ITEM-23): `emptyMaskReview` / `MaskCellReview` / `MaskReviewControls` / `MaskCategory` /
// `createMaskCorrectController` / `composeSharedLabelMask` / `SharedMaskTooLargeError` / `WorldRect` /
// `nextLabelId` / `DirtyRect` are imported by `useGridMasks.ts` now — the mask plane was their only
// consumer here. The two SHARED-mask TYPES stay: the shell re-passes the sessions ref to the dev
// window seam, which is the one mask consumer the plane could not take with it.
import { keepRectsIfUnchanged } from './rectEquality'
import { cellRendersOnSharedDeck, regionSpaceKey, isMigratedChart } from './multiView'
import { createChartLayerSink } from './chartLayerSink'
import type { ContainerId } from '@ziee/dock'
import { EMPTY_GRID_LAYOUT } from '../../adapter/GridWorkspace.store'
import { PANE_TOOLBAR_H } from './CellView'
import { cellPlotId } from '../charts/plotCellId'
// SPLIT M (ITEM-29): `startGripPlacement` / `isPlacementActive` / `abortGripPlacement` / `DragRect` /
// `DropTarget` / the four popup-window registry fns / `buildPopupFeatures` / `centeredGeometry` are
// imported by `useGridWindows.ts` now — the windows plane was their only consumer here.
import { ContainerWindows, PRIMARY_CONTAINER, useGripDragState } from '@ziee/dock'
import { RestoreChoiceDialog } from './RestoreChoiceDialog'
import { installBuiltins } from '../charts/installBuiltins'
import { messageOf } from '../charts/useAsyncChartData'
import { installCoordSystems } from '../coordSystem/installCoordSystems'
import type { DataSource, DatasetCatalog } from '../data/wire'
// SPLIT F (ITEM-22): `densify` / `streamColumnDomain` / `categoricalColors` / `continuousColors` /
// `legendDescriptor` / `getChartType` / `makeChartModel` / `bindingValue` / `datasetLinkKey` /
// `resolveLinkedCellDomains` are imported by `useGridColoring.ts` now — the coloring plane was their
// only consumer here. SPLIT P (ITEM-32): `computeColoring` / `DEFAULT_COLOR_BY` went too — the
// OWNED-data pull that default-colored with them is now in `useGridData.ts`. So are
// `buildPointIndex` / `makePointIndexCache` / the four `selectionSync` imports / `CellRenderData` /
// `DEFAULT_SELECTION_SPACE` (DRIFT-47's class: imports made dead BY the move).
import { colorbarDescriptor, type ContinuousColormap } from '../data/color'
import { type ColorBy } from '../data/engine'
// In-cell legend / visual-map (WYSIWYG): the same descriptors + GPU filter that drive the export,
// rendered ON the cell so what you see is what you export.
import { resolveLegendCorner, DEFAULT_LEGEND_CORNER } from '../controls/legendRender'
import { defaultVizTheme } from '../theme'
import { useVizControls } from '../controls/ControlsContext'
import { VizToolRail } from '../controls/VizToolRail'
import { useCanvasRecovery, webglAvailable } from '../core/contextLoss'
import { ContextLostOverlay } from '../core/ContextLostOverlay'
// SPLIT O (ITEM-31): `useCanvasKeyboard` / `A11yLiveRegionHandle` / `announceViewChange` /
// `announceEmpty` are imported by `useGridA11y.ts` now — the a11y plane was their only consumer
// here. `A11yLiveRegion` itself stays: its element renders in this shell's `gridRoot`.
import { A11yLiveRegion } from '../a11y/A11yLiveRegion'
import { useStore } from 'zustand'
import { gridScopeId } from '../../adapter/Coordination.store'
import { useVizStores } from '../../adapter/vizStores'
import { createCoordinationHandle } from '../../adapter/coordinationHandle'
// SPLIT 0a (ITEM-14): the stable-identity seam every extracted layer will read. Pure addition —
// nothing moves in this commit; the provider below hands out refs + store handles only (DEC-20).
import { GridWorkspaceSeamProvider, type GridWorkspaceSeam } from './GridWorkspaceContext'
import { GridDeckLayer } from './GridDeckLayer'
import { INITIAL_VIEW_STATE } from './gridModel'
import { GridOverlayLayer, type GridOverlayApi } from './GridOverlayLayer'
// SPLIT C (ITEM-17): the per-pane DOCK surface + the export dialog.
import { GridDockLayer } from './GridDockLayer'
// SPLIT 0b (ITEM-21): the per-cell DISPLAY slice. The two record value TYPES moved out of this
// component's body with the state they describe, so the store is the single declaration site.
import {
  createPaneDocksStore,
  selectAnyDataTableOpen,
} from '../../adapter/PaneDocks.store'
import { GridPaneLayer } from './GridPaneLayer'
// SPLIT F (ITEM-22): the coloring / legend DATA plane (effects only — every output is a store write).
import { useGridColoring } from './useGridColoring'
// SPLIT G (ITEM-23): the mask / segmentation AUTHORING plane (fetch + sessions + shared masks).
import { useGridMasks } from './useGridMasks'
// SPLIT H (ITEM-24): the DECK LAYER INPUTS plane (views / layerFilter / layers / cellsForView).
import { useGridDeckInputs } from './useGridDeckInputs'
// SPLIT I (ITEM-25): the SELECTION publish / provenance / commit plane.
import { useGridSelection } from './useGridSelection'
import { useGridAnnotate } from './useGridAnnotate'
import { useGridLinking } from './useGridLinking'
import { useGridWindows } from './useGridWindows'
import { useGridRaster } from './useGridRaster'
import { useGridA11y } from './useGridA11y'
import { useGridData } from './useGridData'
import { useGridTools } from './useGridTools'
import { useGridDevSeams } from './useGridDevSeams'
import { useGridHover } from './useGridHover'
import { PaneTree } from './PaneTree'
import { createCellDisplayStore, type CellLegend } from '../../adapter/CellDisplay.store'
import { type GridViewState } from './linkZoom'

// SPLIT T (ITEM-36): `EMPTY_CONTAINER_LAYOUT` is DELETED, not moved. `GridWorkspace.store.ts` already
// declared a byte-identical module const (`EMPTY_GRID_LAYOUT`) for the same purpose; it is now exported
// and used below. Two consts for one value was a duplicate, not two concepts.

// SPLIT S (ITEM-35): `sameHighlight` moved to `useGridHover.ts` with `onHoverPublish`, its one reader.
// MOVED, not copied — one equality semantics, which is what `hoverHighlightLayers` and the deck
// layer's `crossTooltips` memo depend on (DRIFT-47's class: helpers made dead BY the move).

/** The pane-attached surfaces a host can both PORTAL (`editFormContainer` / `dataTableContainer`)
 *  and CLOSE (`registerHostedSurfaceClose`). A narrowing, not a second vocabulary. */
export type HostedSurfaceKind = 'edit-plot' | 'data-table' | 'export'

/** Close ONE hosted surface for ONE pane — exactly what that surface's own close control does.
 *  Closing an already-closed surface is a no-op (the open-set algebra is identity-stable). */
export type HostedSurfaceClose = (kind: HostedSurfaceKind, paneId: string) => void

export interface GridWorkspaceProps {
  /**
   * Which CONTAINER this workspace renders (PORTAL_DOCKING P3): `'grid'` (the main window, default)
   * or a `popup:<n>` container. Scopes the rendered `layout` + cells to that container — everything
   * downstream (dense deck, coordination, rects) derives from the layout, so scoping the layout
   * scopes the whole workspace. Default `'grid'` is byte-identical to the pre-docking single grid.
   */
  containerId?: ContainerId
  /**
   * Interleaved xy positions (Float32Array, length N*2) rendered in every DENSE cell.
   *
   * DATA-OWNERSHIP INVERSION: OPTIONAL. When OMITTED, the workspace pulls positions from `source`
   * ONCE (`source.positions(<first layout>)`) and OWNS them in local state — so the app hands off
   * only the small `source`/`option` and holds nothing big, and every subsequent add/remove/
   * manipulate is an imperative store command operating on the viz-owned buffer (no re-pass). When
   * PROVIDED (the eager-prop path), behavior is byte-identical to before — the passed buffer wins.
   */
  /** @internal ITEM-15 — eager-buffer path for the gallery + tests ONLY; app authors use `source` + `option`. */
  positions?: Float32Array
  /**
   * RGBA colors (Uint8Array, length N*4). OPTIONAL (see `positions`): when omitted alongside
   * `positions`, the workspace computes the default coloring from `source` ONCE
   * (`computeColoring(source, DEFAULT_COLOR_BY)`) and owns it (with a self-managed color epoch).
   */
  /** @internal ITEM-15 — eager-buffer path for the gallery + tests ONLY; app authors use `source` + `option`. */
  colors?: Uint8Array
  /** Bump when `colors` CONTENTS change so the layers re-upload (eager path only). */
  /** @internal ITEM-15 — eager-buffer path for the gallery + tests ONLY; app authors use `source` + `option`. */
  colorEpoch?: number
  /** The viz data plane the CHART cells load from — and, in the ownership-inversion path, the
   *  source the DENSE buffers + catalog are pulled from (Phase C1). */
  source: DataSource
  /**
   * The dataset catalog the chart cells derive default bindings from (Phase C1). OPTIONAL: when
   * omitted, pulled from `source.catalog()` ONCE (part of the same ownership-inversion handoff), so
   * a caller can mount with just `source` + `option`.
   */
  /** @internal ITEM-15 — eager-buffer path for the gallery + tests ONLY; app authors use `source` + `option`. */
  catalog?: DatasetCatalog
  radius?: number
  /**
   * Per-point group codes (Uint16Array, length N) — the grouping the graph overlay's
   * centroids/nodes reduce over (Phase C3c). Required (with `graph`) for a dense cell's
   * graph-overlay toggle to draw anything.
   */
  codes?: Uint16Array
  /** The node-link graph (ordered category-code paths) drawn as the overlay (Phase C3c). */
  graph?: GraphData
  /** Category labels indexed by code, for the overlay node labels (Phase C3c). */
  categories?: readonly string[]
  /**
   * Pseudotime (continuous ORDER) coloring for a cell's graph overlay (ITEM-16). When true
   * (the default), each toggled cell's graph nodes + edge segments are colored by their
   * normalized order value (root 0 → tip 1, derived from `graph.paths`) through
   * `graphColormap`, exactly like the showcase `GraphScatterView`. Set false for the flat
   * default color.
   */
  graphColorByOrder?: boolean
  /** Continuous colormap the graph-overlay order value is mapped through (default `viridis`). */
  graphColormap?: ContinuousColormap
  /**
   * RICH HOVER TOOLTIP (ITEM-5) — the resident columns a tooltip reads by O(1) array
   * indexing at the picked point (positions / group codes+categories / active color-by
   * value). When present, hovering a dense cell's scatter point shows a `<VizTooltip>`
   * built from `buildScatterTooltipFields`; the hover→setState is rAF-throttled and NO
   * column is fetched on hover. Absent ⇒ no tooltip (back-compat).
   */
  tooltipContext?: TooltipContext
  /** Display labels for the tooltip's default fields (group / color / x / y). */
  tooltipLabels?: TooltipCatalogLabels
  /**
   * MD-8 — PER-DATASET rich tooltips (multi-datasource): a `datasetId → TooltipContext` map
   * supplying the resident columns for a NON-default dataset's cells, so hovering a dataset-B point
   * shows B's OWN columns (never the default dataset's, and never suppressed). When a hovered
   * dataset has no entry here, the tooltip falls back to that dataset's resident positions (x/y),
   * labeled from its catalog layout. Same O(1) resident-column contract as `tooltipContext`.
   */
  datasetTooltips?: Readonly<Record<string, TooltipContext>>
  /** Per-dataset display labels (mirrors `tooltipLabels`), keyed by `datasetId`. */
  datasetTooltipLabels?: Readonly<Record<string, TooltipCatalogLabels>>
  /**
   * OPTIONAL row→canonical-point-id map (multi-source selection seam): `pointIds[row]` is
   * the STABLE canonical id of the grid's local `row`. When present, a selection PRODUCED
   * here is published in canonical ids and the shared selection is CONSUMED by mapping ids
   * → local rows — so cross-plot emphasis stays correct against views over a different
   * point set/order. ABSENT ⇒ identity (`pointIds[i]=i`): byte-identical to the index-based
   * path (the grid's panes share ONE point array — the single-source case).
   */
  pointIds?: Uint32Array
  /**
   * Per-cell export affordance (ITEM-47 follow-up). When supplied, every cell's chrome
   * shows a ⤓ export button; clicking cell X's button sets X as the export target (via
   * `activeCellRef`, so the host's `paneRect()` resolution can point at it) and calls this
   * with X's id (+ X's `colorBy`, so the host can resolve the cell's legend for export — DEC-1)
   * so the host opens its ExportDialog scoped to that pane. OMITTED ⇒ no per-cell export button
   * and byte-identical behavior to before.
   */
  onRequestExportCell?: (
    cellId: string,
    colorBy?: ColorBy,
    /** the cell's LIVE in-cell visual-map state, so the export snapshots what's on screen (WYSIWYG):
     *  `range` = the VisualMap [lo,hi] window (only when a strict sub-range); `hidden` = toggled-off
     *  categorical codes. */
    visualMap?: { range?: [number, number]; hidden?: number[] },
  ) => void
  /** Shell redesign: the global tool rail's ⤓ asks the host to export the WHOLE GRID (vs the per-pane
   *  `onRequestExportCell`). Omitted ⇒ the rail's grid-export button is hidden. */
  onRequestExportGrid?: () => void
  /** ITEM-11/ITEM-14 (H1) — hand the host this grid's provenance pane resolver + live-context probe.
   *
   *  The grid is the ONLY thing that holds per-cell buffers, so it owns both; the CONTROLLER owns the
   *  public `revalidateSelection()` / `getSelectionStaleness()` surface but has no buffers of its own.
   *  This is the seam between them: `<Viz>` passes a handler that calls
   *  `controller.registerSelectionPanes(...)`, whose returned unregister fn this prop must return so
   *  the grid can release it on unmount.
   *
   *  Without it the controller's DEC-23 API is permanently inert (`getSelectionStaleness()` →
   *  `'unknown'` forever) and the DEC-9 restore window never closes from the controller's side.
   *  A bare `<GridWorkspace>` with no host simply omits it — the grid's own effect still re-evaluates. */
  onSelectionPanes?: (
    resolve: ResolvePane,
    liveContext: (prov: { ops: readonly VizSelectionOp[]; context?: VizSelectionContext }) => VizSelectionContext,
  ) => (() => void) | void
  /** PARENT-INJECTED tool-rail slots: `afterLinkZoom` renders below the link-zoom toggle; `aboveExport`
   *  renders above the whole-grid export. Lets the host add its own rail buttons (e.g. save-to-server). */
  toolRailSlots?: { afterLinkZoom?: React.ReactNode; aboveExport?: React.ReactNode }
  /**
   * Shell redesign: a RESOLVER the per-pane EDIT FORM portals into. Called with the pane id EACH time an
   * edit form opens for that pane; return the DOM container to render THAT pane's form into (e.g. a fresh
   * right-inspector slot the host mints per pane), or `null`/`undefined` to fall back to the grid's
   * internal right panel. Because it's per-pane, the host can host MULTIPLE edit forms at once (one per
   * pane) in distinct containers. Absent ⇒ every open form stacks in the internal right panel.
   */
  editFormContainer?: (paneId: string) => HTMLElement | null | undefined
  /**
   * Shell redesign: the EXPORT-dialog twin of `editFormContainer`. GridWorkspace now OWNS the export
   * dialog (it self-resolves the deck canvas / pane rect / legend / grid dividers) — the pane ⤓ and the
   * rail ⤓ open it. This resolver is called with the pane id (or `'__grid__'` for a whole-grid export)
   * and returns the DOM container to PORTAL that dialog into, or `null`/`undefined` to stack it in the
   * grid's internal right panel. Absent ⇒ internal panel. (When the legacy `onRequestExportCell`/
   * `onRequestExportGrid` callbacks are supplied, the host still owns export and this is unused.)
   */
  exportDialogContainer?: (paneId: string) => HTMLElement | null | undefined
  /**
   * The plot-data TABLE twin of `editFormContainer`. Called with the pane id each time a data table
   * opens; return the DOM container to PORTAL that pane's table into, or `null`/`undefined` to stack it
   * in the grid's internal right panel. Absent ⇒ every open table stacks in the internal panel (several
   * at once). The data table is always docked — never overlaid on the pane.
   */
  dataTableContainer?: (paneId: string) => HTMLElement | null | undefined
  /**
   * The CLOSE half of `editFormContainer` / `dataTableContainer` (hosted-surface parity).
   *
   * A host that portals these surfaces into its own panes owns a container, a tab and a title for
   * each — but it did NOT own a way to close one. Its own close could only remove its projection,
   * which leaves the surface OPEN in a container attached to nothing: invisible, with the plot's
   * Edit / Show-data toggle still lit, and no way back except toggling that plot twice. So a host
   * either shipped no close at all (what the workbench did) or shipped one that stranded state.
   *
   * This is called on mount with a closer bound to THIS workspace's stores, and with `null` on
   * unmount. Calling it does exactly what the surface's own X does — it closes the SURFACE, and
   * the host's projection follows because the container empties.
   *
   * Additive and independent of the resolvers: a host may take a container without taking this.
   */
  registerHostedSurfaceClose?: (close: HostedSurfaceClose | null) => void
  /**
   * The ANNOTATION class-panel twin of `editFormContainer` — and it means exactly what that twin
   * means: called ONCE PER PANE WHOSE ANNOTATE DOCK IS OPEN, with that pane's id. Return the DOM
   * container to PORTAL that pane's `AnnotateControls` (tool rail + class/label panel) into, or
   * `null`/`undefined` to fall back to the grid's internal right panel. Absent ⇒ internal panel.
   *
   * N docks can be open simultaneously, so a host MUST mint (or look up) a DISTINCT container per
   * `paneId`. Returning one shared node for every id portals every pane's controls into the same
   * element — they render on top of each other and the user cannot tell which pane they are
   * editing. (This doc-comment previously said "the FOCUSED annotate cell … while the workspace is
   * in `annotate` mode": both the single-focus contract and the workspace-wide annotate MODE are
   * gone, and a host implementing to that text reproduced the exact defect this seam now prevents.)
   */
  annotateControlsContainer?: (paneId: string) => HTMLElement | null | undefined
  /**
   * ITEM-16 — a pane's counted POINT annotations, handed out as `ProcessorPort` `GeoFeature`
   * seeds when the user hits "Use N points as seeds". Per-pane (`paneId` names the pane whose
   * controls were used). Omitted ⇒ the seed button is not rendered at all, so a viewer-only
   * host shows no dead affordance. The editor runs no model either way (INV-3).
   */
  onAnnotateExportSeeds?: (paneId: string, features: GeoFeature[]) => void
  /**
   * The MASK-REVIEW panel twin of `annotateControlsContainer` (segmentation-scale ITEM-2), with the
   * same contract: called ONCE PER PANE WHOSE SEGMENT DOCK IS OPEN, with that pane's id. Return the
   * DOM container to PORTAL that pane's `MaskReviewControls` (hide/solo + relabel/split/merge/brush)
   * into, or `null`/`undefined` to fall back to the grid's internal right panel.
   *
   * As above, N docks can be open at once — a host MUST return a DISTINCT container per `paneId`.
   * (Previously documented as "the FOCUSED segment cell … in `segment` mode"; that single-focus
   * contract and that workspace-wide mode no longer exist.)
   */
  maskControlsContainer?: (paneId: string) => HTMLElement | null | undefined
  /**
   * A11Y (opt-in): when set, the workspace becomes a labeled, focusable `role="application"` region
   * (this string as its `aria-label`) with KEYBOARD camera control over a single FOCUSED dense cell —
   * `[`/`]` (or `,`/`.`) cycle which dense cell is focused, arrows pan it (Shift = larger step), `+`/`-`
   * zoom it, Enter/Space announce it, Esc clear the selection — each spoken through an off-screen ARIA
   * live region (the shared GPU deck is opaque to screen readers). Pan/zoom flow through the SAME
   * `onViewStateChange` the mouse uses, so link-zoom fan-out + clamping are inherited. Absent ⇒ no a11y
   * chrome (byte-identical). Passed down to popup containers so their grids are navigable too.
   */
  accessibleLabel?: string
  /** Observe each a11y live-region announcement (mirrors the message; for a host status line / test). */
  onA11yAnnounce?: (message: string) => void
}

// Populate the chart-type registry (EXTENSIBILITY_STUDY Part 6 STEP 1) AND the
// coordinate-system registry (STEP 5) at module load, before any cell renders. Both are
// idempotent — safe to also call from the popout entry / tests. The grid's render path
// (`CellView.ChartBody`) resolves cells against the chart registry, and the dense-vs-chart
// partition (`cellRendersOnSharedDeck`) resolves a cell's kind → chart descriptor → coord
// system → host, so BOTH registries MUST be populated first.
installBuiltins()
installCoordSystems()

// (SPLIT A declared `INITIAL_VIEW_STATE` in `GridDeckLayer.tsx`, beside the camera it seeds; SPLIT O
// moved it to `gridModel.ts` because `useGridA11y` reads it and a hook may not import a layer. It is
//  imported above. The shell still needs it at two sites — `toggleLinked`'s space seed and the a11y
//  pan step's zoom fallback — neither of which is a camera SUBSCRIPTION.)

// SPLIT F (ITEM-22): `withColorOverrides` moved to `useGridColoring.ts` with the recolor + legend
// effects that were its only two readers.

// SPLIT T (ITEM-36): `webglAvailable` moved to `core/contextLoss.ts`, beside `freeCanvasContext` — its
// only dependency, and the release half of the same context-lifecycle invariant. Imported above.
//
// `installBuiltins()` / `installCoordSystems()` above deliberately do NOT move. They are MODULE-LOAD
// side effects that must run before any cell renders, so relocating the CALLS only works if the new
// home is itself imported by this file — i.e. it buys two lines and hides an import-order-sensitive
// side effect inside a data module, which is strictly worse than leaving them visible here (DEC-37).

/** The whole-workspace owned-data error cover's text — the sentence PLUS the source's own reason.
 *  Module-level because the shell's BODY is line-ratcheted (INV-10 (b)). It states WHY because the
 *  sentence alone named the LAYER and nothing else: a permission error, a malformed layout, and —
 *  before `pullOwnedData` stopped inventing a layout id when the catalog declared none — a source
 *  that simply had no point cloud to offer, all rendered the identical cover. A cover with no reason
 *  on it is indistinguishable from a cover that should not be there, which is how that defect stayed
 *  invisible. The surface is now reserved for GENUINE failure (an EMPTY source lands zero points). */
function OwnedDataErrorText({ error }: { error: unknown }) {
  return (
    <div>
      Failed to load visualization data from the source.
      <div data-testid="viz-grid-data-error-reason" style={{ marginTop: 6, opacity: 0.75 }}>
        {messageOf(error, 'The source reported no reason.')}
      </div>
    </div>
  )
}

export function GridWorkspace({
  containerId = PRIMARY_CONTAINER,
  positions: positionsProp,
  colors: colorsProp,
  colorEpoch: colorEpochProp = 0,
  source,
  catalog: catalogProp,
  radius = 2,
  codes,
  graph,
  categories,
  graphColorByOrder = true,
  graphColormap = 'viridis',
  tooltipContext,
  tooltipLabels,
  datasetTooltips,
  datasetTooltipLabels,
  pointIds,
  onRequestExportCell,
  onRequestExportGrid,
  onSelectionPanes,
  toolRailSlots,
  editFormContainer,
  exportDialogContainer,
  dataTableContainer,
  registerHostedSurfaceClose,
  annotateControlsContainer,
  onAnnotateExportSeeds,
  maskControlsContainer,
  accessibleLabel,
  onA11yAnnounce,
}: GridWorkspaceProps) {
  // Resolve the active store set from context (the module singletons when unprovided), so a
  // per-instance `<Viz>` drives + reads ITS OWN grid + coordination stores (VIZ_ISOLATION W2/W3).
  // Imperative handlers read the set through a ref (stable identity, no dep churn); the per-instance
  // Selection handle (built over this set's coordination store) is threaded into every CellView.
  const stores = useVizStores()
  const storesRef = useRef(stores)
  storesRef.current = stores
  // SPLIT 0b (ITEM-21 / DEC-21): the per-cell DISPLAY slice, minted PER WORKSPACE INSTANCE.
  //
  // Deliberately NOT a member of the `VizStores` family, and that is a correction to DEC-21 rather
  // than a shortcut. These seven records were per-instance React state, and this component renders
  // RECURSIVELY: a popped-out container mounts a second `<GridWorkspace containerId=…>` inside the
  // SAME `<Viz>`, hence the same `VizStores` set. Both instances run the recolor/legend effects and
  // both end them with a whole-record replace computed from THEIR OWN cells — so a family-level
  // slice would have the popup wipe the main grid's colors and legends on every recolor. That is
  // INV-7 (multi-instance isolation) leakage introduced by the hoist itself, which is exactly what
  // the invariant is carried forward to prevent. One store per workspace reproduces the previous
  // React-state scoping exactly, and the children reach it through the ITEM-14 seam.
  const [cellDisplay] = useState(createCellDisplayStore)
  // SPLIT D (ITEM-15): the per-pane DOCK state — the four open sets + the mask-review record — for
  // the same reason and with the same per-WORKSPACE scoping as `cellDisplay` above. DRIFT-20
  // recorded these five as Split D/E's inherited cargo; `PaneDocks.store.ts`'s header carries the
  // per-state reader enumeration that shows why none of them could simply move into a layer.
  const [paneDocks] = useState(createPaneDocksStore)
  const coordination = useMemo(() => createCoordinationHandle(stores), [stores])
  const coordinationRef = useRef(coordination)
  coordinationRef.current = coordination

  // Container-scoped layout (P3): the main grid reads `s.layout` (byte-identical); a popup container
  // reads its own tree. Everything downstream (cells, dense deck, coordination, rects) derives from
  // this `layout`, so scoping it here scopes the entire workspace to `containerId`'s panes.
  const layout = useStore(stores.gridWorkspace, s =>
    containerId === PRIMARY_CONTAINER ? s.layout : (s.containerLayouts[containerId] ?? EMPTY_GRID_LAYOUT),
  )
  const cellMap = useStore(stores.gridWorkspace, s => s.cells)

  // Plot-editing: the RESOLVED per-control edit capabilities (legend/colormap/titles/pointSize) from
  // the `<Viz>` context (defaults when bare). Gates whether the in-cell legend renders (show) and
  // whether it's an editable color/label picker vs a read-only legend (editable).
  const controls = useVizControls()
  // Plot-editing (ITEM-2/7/8): the reactive per-column DISPLAY overrides (by-name color + label). An
  // in-cell legend edit writes here; the coloring effects below MERGE it onto each cell's `colorBy`
  // before `computeColoring`, so the edit recolors the plot AND the legend (WYSIWYG) and rides into
  // `getOption()` (Viz already subscribes `colorOverride` for `onChange`). Empty ⇒ byte-identical.
  const colorOverrides = useStore(stores.colorOverride, s => s.overrides)




  const containerRef = useRef<HTMLDivElement | null>(null)
  // The <DeckGL> imperative handle (exposes the underlying @deck.gl/core `Deck`). Only READ in the
  // popup-realm resize effect below — the main grid never touches it, so grabbing it here is inert.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deckRef = useRef<any>(null)
  // ── SPLIT A / ITEM-6 — THE CAMERA HANDLES ───────────────────────────────────────────────────────
  // Four ref OBJECTS created HERE (so their identity is fixed for the workspace's life and the seam
  // value stays stable) but FILLED BY `GridDeckLayer`, which owns the camera after Split A. They are
  // declared beside the other workspace-lifetime handles because consumers appear throughout the
  // body, well above where the camera used to be derived.
  //   * `viewStateRef`         — READ by 12 pointer/keyboard/export call sites.
  //   * `onViewStateChangeRef` — the 5 pan/zoom WRITE sites (3 pointer + 2 a11y-keyboard).
  //   * `localStatesRef`       — the unlinked per-cell camera, read by `toggleLinked` + image framing.
  //   * `seedViewStateRef`     — the 6th, idempotent write: frame an image cell that has no camera.
  // Because every one of them is read at GESTURE/EFFECT time and never during this component's
  // render, the shell holds no camera subscription at all (INV-1 structurally) while still reading
  // the camera of the commit deck was just handed (INV-9, no one-frame-stale read).
  const viewStateRef = useRef<Record<string, GridViewState>>({})
  const onViewStateChangeRef = useRef<(e: { viewId: string; viewState: GridViewState }) => void>(() => {})
  const localStatesRef = useRef<Record<string, GridViewState>>({})
  const seedViewStateRef = useRef<(cellId: string, viewState: GridViewState) => void>(() => {})

  const paneEls = useRef<Map<string, HTMLElement>>(new Map())
  const [rects, setRects] = useState<PaneRect[]>([])
  const [glOk] = useState(webglAvailable)

  // WebGL context-loss recovery (ITEM-57). One Deck / N views (DEC-20) means a single
  // `webglcontextlost` blanks the WHOLE grid, so recovery is critical here: on restore,
  // `restoreKey` bumps → the one <DeckGL> remounts, re-creating all N views' layers and
  // RE-UPLOADING their buffers from props (data survives in JS memory — no reload). A
  // non-blocking badge covers the recovering window; the workspace spec is untouched.
  const { lost, restoreKey } = useCanvasRecovery(containerRef)

  const cells = useMemo(() => orderedCells(layout, cellMap), [layout, cellMap])

  // ── Dense vs. chart partition (Phase C1) ──────────────────────────────────
  // DENSE cells (scatter / image) render into the shared single-<DeckGL> / N-views
  // deck; every other kind is a companion CHART that renders its OWN ChartCanvas in
  // the flat content overlay. The shared deck (views, layerFilter, link-zoom view
  // state) is scoped to DENSE cells ONLY — a chart cell owns no deck view and no
  // scatter layer, so `layerFilter` never sees a chart-cell id. We still MEASURE
  // every leaf rect below (charts are positioned from their rect too).
  // A cell is DENSE iff its descriptor's coordinate system renders on the SHARED deck
  // (STEP 5 re-seam): `cell.kind` → chart descriptor → coord system → host.shared. This is
  // the registry-routed replacement for `isDenseKind` (behavior-identical) — the grid now
  // expresses the shared-deck-vs-own-canvas split as "which coord system / host the cell
  // selects" rather than the ad-hoc predicate.
  const denseCells = useMemo(() => cells.filter(cellRendersOnSharedDeck), [cells])
  const denseIds = useMemo(() => new Set(denseCells.map(c => c.id)), [denseCells])

  // ── SHARED-DECK CHARTS (shared-deck-charts refactor) ───────────────────────────────────────────
  // Chart cells whose kind is migrated render as VIEWS in this ONE deck. Each such cell's ChartCanvas
  // publishes its {cellId-prefixed layers, view params, fitted viewState} to `chartSink` (via the
  // ChartLayerSinkContext provided around the cell in the content overlay); we merge them into the
  // deck's views / layers / controlledViewState below, keyed by the cell id (same `<cellId>::` routing).
  const chartSink = useMemo(() => createChartLayerSink(), [])
  const chartContribs = useSyncExternalStore(chartSink.subscribe, chartSink.snapshot, chartSink.snapshot)
  const chartDeckIds = useMemo(() => new Set(cells.filter(isMigratedChart).map(c => c.id)), [cells])

  // Register / unregister a leaf pane's DOM element (via Panel.elementRef).
  const registerPane = useCallback((id: string, el: HTMLElement | null) => {
    if (el) paneEls.current.set(id, el)
    else paneEls.current.delete(id)
  }, [])

  // Measure every leaf pane's pixel rect relative to the container → deck view rects.
  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const base = container.getBoundingClientRect()
    const next: PaneRect[] = []
    for (const cell of cells) {
      const el = paneEls.current.get(cell.id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      next.push({
        id: cell.id,
        x: r.left - base.left,
        y: r.top - base.top,
        width: r.width,
        height: r.height,
      })
    }
    // ITEM-4: a measure pass that found nothing moved must not churn identities. Every `PaneRect`
    // above is a fresh object, so an unguarded `setRects` invalidates `memo(CellView)` for EVERY
    // pane on any resize tick — re-entering, through the resize path, exactly the per-pane chrome
    // rebuild ITEM-1 just removed. Returning `prev` makes React bail out of the update entirely.
    // Mirrors `measureLegend`'s existing guard a few lines below, tolerance included: sub-pixel
    // jitter from fractional layout is not movement.
    setRects(keepRectsIfUnchanged(next))
  }, [cells])

  // Re-measure on container resize + whenever the tree changes.
  useLayoutEffect(() => {
    measure()
  }, [measure, layout])

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(container)
    return () => ro.disconnect()
  }, [measure])

  // Dense-only rects: the deck builds a view per DENSE cell; charts are positioned
  // from the full `rects` set in the content overlay below.
  const denseRects = useMemo(() => rects.filter(r => denseIds.has(r.id)), [rects, denseIds])
  // Migrated chart cells get a deck view too — with the per-pane flipY/controller the chart published.
  const chartDeckRects = useMemo(() => rects.filter(r => chartDeckIds.has(r.id)), [rects, chartDeckIds])

  // Shell redesign: whether the per-pane top toolbars are shown (toggled from the global tool rail).
  const [cellToolbarsOn, setCellToolbarsOn] = useState(true)
  // Whether the rich hover TOOLTIP is shown on a scatter point (toggled from the global tool rail).
  // Default ON. Gates the `<VizTooltip>` render regardless of whether a `tooltipContext` is present.
  const [tooltipsEnabled, setTooltipsEnabled] = useState(true)
  // Shell redesign: when the per-pane toolbars are shown they OCCUPY a 32px top strip, so each deck view
  // is inset by that height (the plot renders BELOW the toolbar, not behind it). Off ⇒ the full rect.
  const insetPane = useCallback(
    (r: PaneRect): PaneRect =>
      cellToolbarsOn
        ? { ...r, y: r.y + PANE_TOOLBAR_H, height: Math.max(1, r.height - PANE_TOOLBAR_H) }
        : r,
    [cellToolbarsOn],
  )
  // Measured intrinsic width (CSS px) of each cell's on-screen legend block — drives the EXACT "beside"
  // gutter so the plot shrinks by precisely the legend's width (+ a small pad), never a fixed guess. The
  // legend render loop measures the rendered block into this map (stable — the legend width is intrinsic).
  const [legendWidths, setLegendWidths] = useState<Record<string, number>>({})
  const legendWidthsRef = useRef(legendWidths)
  legendWidthsRef.current = legendWidths
  const LEGEND_GUTTER_PAD = 10 // small padding between the legend and the shrunk plot
  // LEGEND "BESIDE" MODE: a cell whose legend sits BESIDE the plot (not overlaid) reserves a vertical
  // side gutter — the deck view (the plot) shrinks horizontally by the MEASURED legend width (+ pad), and
  // the legend renders in the freed gutter. The gutter is on the corner's horizontal side (TL/BL → left,
  // TR/BR → right). Returns null when the cell isn't in beside mode / has no legend shown (then
  // `plotInset` === `insetPane`, byte-identical). Before the first measure, a small fallback is used (the
  // plot converges to the exact width one frame later).
  const legendGutterFor = useCallback(
    (cell: GridCell | undefined): { w: number; side: 'left' | 'right' } | null => {
      if (!cell?.legendBeside || !(cell.showLegend ?? true)) return null
      // Applies to DENSE and CHART cells alike: `plotInset` shrinks the shared-deck view AND `CellView`
      // insets the chart's own container by the same gutter (`plotGutter`), so a chart's <ChartCanvas>
      // fit + projection stay aligned with the shrunk plot. The legend renders in the freed gutter.
      const w = (legendWidths[cell.id] ?? 72) + LEGEND_GUTTER_PAD
      return { w, side: resolveLegendCorner(cell.legendCorner ?? DEFAULT_LEGEND_CORNER).hSide }
    },
    [legendWidths],
  )
  // A cell's PLOT rect: the toolbar-inset rect further shrunk by the legend gutter when beside mode is on.
  // The single source of truth for the deck view, world↔screen projection, and vector export, so the plot
  // and its legend never overlap and stay WYSIWYG across on-screen + export.
  const plotInset = useCallback(
    (r: PaneRect): PaneRect => {
      const base = insetPane(r)
      const g = legendGutterFor(cellMap[r.id])
      if (!g) return base
      const w = Math.min(g.w, Math.max(1, base.width - 48)) // never shrink the plot below ~48px
      return g.side === 'left'
        ? { ...base, x: base.x + w, width: Math.max(1, base.width - w) }
        : { ...base, width: Math.max(1, base.width - w) }
    },
    [insetPane, legendGutterFor, cellMap],
  )
  // Measure a cell's rendered legend block width (its inner element's intrinsic width) into `legendWidths`
  // so the beside gutter matches it exactly. Guarded (only updates on a real change) so it converges in a
  // frame and never loops — the legend width is intrinsic (independent of the plot size).
  const measureLegend = useCallback((id: string, el: HTMLDivElement | null, beside: boolean) => {
    // Only BESIDE cells consume `legendWidths`; skip the `getBoundingClientRect` (a forced reflow that
    // would otherwise run on EVERY render — incl. every hover frame — for every legend cell) otherwise.
    if (!el || !beside) return
    const inner = el.firstElementChild as HTMLElement | null
    const w = inner ? inner.getBoundingClientRect().width : 0
    if (w > 0 && Math.abs((legendWidthsRef.current[id] ?? 0) - w) > 1) {
      setLegendWidths(prev => ({ ...prev, [id]: w }))
    }
  }, [])

  // ── Link-zoom coordination (DEC-37), SCOPED BY COORDINATE SPACE ────────────
  // OFF (default): each cell zooms/pans independently — its own `localStates`
  // entry. ON: cells share a view state ONLY WITHIN their coordinate space (the
  // embedding-blind-zoom fix). Each dense cell declares a `spaceKey` (`cellSpaceKey`):
  // two scatters over the same embedding sync; a scatter and an image/spatial cell live
  // in DIFFERENT spaces and never sync. The shared state is sharded per space in the
  // Coordination store under `gridScopeId(spaceKey)`.
  //
  // SPLIT A (ITEM-5): `allViewStates` / `localStates` / `sharedBySpace` / `controlledViewState` /
  // `deckViewState` / `onViewStateChange` NOW LIVE IN `GridDeckLayer`. Only `linked` stays here —
  // it is a MODE, not a camera: it changes when the user presses the link-zoom toggle, never per
  // frame, and the tool rail renders from it. `cellSpaces` likewise stays: it is derived from the
  // grid's STRUCTURE (which cells exist, in which coordinate space), so a wheel never changes it,
  // and `toggleLinked` below needs it. Both are handed DOWN to the deck layer as props.
  const linked = useStore(stores.coordination, s => s.gridLinked)

  // Link-zoom is scoped to DENSE cells only — chart cells navigate independently
  // (their own ChartCanvas). `cellIds` are the dense cells with a measured rect.
  const cellIds = useMemo(() => denseRects.map(r => r.id), [denseRects])

  // Per-cell coordinate-space key (cellId → spaceKey) = the `world2d` REGION IDENTITY each
  // dense cell provides on the shared deck (STEP 5): the `cellSpaceKey` link-zoom scope,
  // folded into the coord-system region model via `regionSpaceKey`. Cells sharing a key
  // zoom-sync when linked; cells in different keys never do.
  const cellSpaces = useMemo(() => {
    const m: Record<string, string> = {}
    for (const id of cellIds) {
      const cell = cellMap[id]
      if (cell) m[id] = regionSpaceKey(cell)
    }
    return m
  }, [cellIds, cellMap])

  const toggleLinked = useCallback(() => {
    const store = storesRef.current.coordination.getState()
    const next = !store.gridLinked
    // Entering linked mode: seed EACH space's shared scope (if unset) from the first
    // cell in that space, so its cells jump to a real view (not the origin default) —
    // per space, so the scatter space and the image space seed independently.
    if (next) {
      const seeded = new Set<string>()
      for (const id of cellIds) {
        const space = cellSpaces[id]
        if (!space || seeded.has(space)) continue
        seeded.add(space)
        if (!store.viewStates[gridScopeId(space)]) {
          // SPLIT A: the per-cell unlinked camera now lives in `GridDeckLayer`, read here through
          // the seam ref AT CLICK TIME. That is strictly better than the old reactive dep — the seed
          // must reflect the camera as it is when the toggle is pressed, and this callback no longer
          // re-binds on every pan.
          const seed = localStatesRef.current[id] ?? INITIAL_VIEW_STATE
          store.setGridViewState(space, { target: [seed.target[0], seed.target[1]], zoom: seed.zoom })
        }
      }
    }
    store.setGridLinked(next)
  }, [cellIds, cellSpaces])

  // ── Cross-plot selection sync (DEC-25 / ITEM-25) ──────────────────────────
  // A selection made in ANY cell lands in the Coordination store; EVERY cell
  // emphasises it. The GPU path: dim each cell's base scatter (layer opacity) and
  // draw a second `DataFilterExtension` overlay that redraws ONLY the selected
  // points (filterRange [1,1]) at full opacity — both layers share the SAME
  // positions/colors buffers, so a selection change swaps only the tiny per-point
  // `getFilterValue` Uint8 attribute (built ONCE via `highlightMaskForPoints`),
  // NEVER re-uploading position/color data and NEVER a per-point CPU recolor.
  // Selection consume/produce goes through the coordination handle (STEP 3): the SAME store,
  // now behind the Selection-component seam. Link-zoom (`gridLinked`/`viewStates`) stays a
  // direct store read — that's the scatter-camera coordination, not the selection.
  // DEFAULT-space selection (the single/sole-dataset path); per-cell multi-dataset spaces are read
  // from `selectionBySpace` in the `layers` memo. `nPoints` is the default dataset's point count.
  const pointSelection = coordination.usePointSelection()
  // Dark-aware theme for the DOM-canvas legend / visual-map overlays (their text + veils must read on
  // light AND dark — a LIGHT default rendered dark text on a dark plot).
  const vizTheme = defaultVizTheme()
  // ── SPLIT P (ITEM-32) — THE DATA-RESOLUTION PLANE, in `useGridData.ts`. ─────────────────────
  // DEC-26's TWO data rows — the owned-data PULL and the per-cell RESOLVE — left this body as ONE
  // module: the pull produces `positions`/`colors`/`catalog` and `cellData`'s no-dataset branch is
  // their fallback reader, so a cut between the rows strands three derivations from that reader. The
  // four module-level helpers they were the only users of (`OwnedData`, `EMPTY_POSITIONS`,
  // `EMPTY_COLORS`, `OWNED_DEFAULT_LAYOUT`) and `SELECTION_CANONICAL_SPACE` went with them.
  // `cellDataRef` / `cellSelectionSpaceRef` are ITEM-14 SEAM refs, returned unchanged (DEC-28).
  const {
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
  } = useGridData({
    stores,
    source,
    cells,
    denseCells,
    positionsProp,
    colorsProp,
    colorEpochProp,
    catalogProp,
    pointIds,
  })
  const cellMapRef = useRef(cellMap)
  cellMapRef.current = cellMap
  // Assigned below once `perCellGroupLegend` + `perCellRange` are declared (they live later).
  const perCellGroupLegendRef = useRef<Record<string, CellLegend>>({})
  const perCellRangeRef = useRef<Record<string, readonly [number, number]>>({})
  // ── SPLIT K (ITEM-27) — THE LINK-GROUP PLANE, in `useGridLinking.ts`. ────────────────────────
  // The three link subscriptions, the `cellLinkGroup` inverse, the filter-propagation derivations,
  // the link-button UX and the Track-C display fan-out left this body wholesale. The rationale, the
  // writer-set table and the "why one plane" argument live in that module's header, beside the code
  // they describe. `perCellGroupLegendRef` / `perCellRangeRef` deliberately did NOT move: the shell
  // writes both (and passes the second to `useGridSelection`), so they are borrowed, not taken.
  const {
    linkGroups,
    linkColorIdx,
    linkPicking,
    cellLinkGroup,
    linkColorFor,
    linkAnchorDataset,
    linkedHiddenFor,
    linkPopoverCell,
    setLinkPopoverCell,
    onToggleLink,
    linkColumnFilterFor,
    propagateConfirm,
    setPropagateConfirm,
    applyDisplayToGroup,
  } = useGridLinking({ stores, cellMap, cells, cellMapRef, perCellGroupLegendRef, perCellRangeRef })

  // ── Per-cell color-by + linked color scale (Phase C3b / ITEM-64) ──────────
  // A dense cell with its OWN `colorBy` colors by its own column (via the engine's
  // color builders) instead of the shared `colors` prop; cells WITHOUT a `colorBy`
  // keep the shared buffer (byte-identical to pre-C3b). When ≥2 linked cells color
  // by the SAME key, their domains union (`resolveLinkedCellDomains`) and each is
  // recolored against that union — so identical values map to identical colors.
  //
  // This runs in an EFFECT once per color-INTENT change (keyed by `colorSig`),
  // NEVER per frame: it fetches + builds each cell's `Uint8Array` ONCE, exactly like
  // the app-level color pipeline. The GPU path is untouched — the layers below just
  // swap the per-cell buffer + bump its updateTrigger.
  const perCellColors = useStore(cellDisplay, s => s.colors)
  // WYSIWYG in-cell legend/visual-map (ITEM-10/11): per dense colorBy cell, the legend DESCRIPTOR
  // (categorical/continuous/blend) + the continuous VALUES (for the GPU value-range filter). Computed
  // by a small ADDITIVE effect via `computeColoring` — it does NOT touch the coloring pipeline above.
  // `CellLegend` now lives beside the state it describes, in `CellDisplay.store.ts` (imported above).
  const perCellLegend = useStore(cellDisplay, s => s.legend)
  // GROUPED-chart legends (box/violin/bar/dotplot/heatmap): a categorical legend built from the cell's
  // GROUP column categories + the colorOverride store, so the edit form's per-group recolor/rename
  // renders for grouped charts (the WYSIWYG overlay stays dense-only, so this never double-draws). Kept
  // SEPARATE from `perCellLegend` to avoid clobbering it / the overlay loop.
  const perCellGroupLegend = useStore(cellDisplay, s => s.groupLegend)
  perCellGroupLegendRef.current = perCellGroupLegend
  // MATRIX-chart VALUE legends (heatmap/dotplot): the continuous value scale each publishes via
  // `usePublishValueLegend` → an on-plot colorbar + the edit-form colormap picker + export, reusing the
  // continuous-legend machinery. Kept SEPARATE (a matrix cell is never in `perCellLegend`, which is
  // dense-only) and merged at the read sites via `legendForCell`.
  const perCellValueLegend = useStore(cellDisplay, s => s.valueLegend)
  const publishValueLegend = useCallback(
    (cellId: string, legend: { colormap: ContinuousColormap; domain: readonly [number, number] } | null) => {
      // Same no-op guard as the previous functional `setState`: an unchanged publish must not write,
      // or every View's publish-on-render would invalidate this cell's selector every frame.
      const st = cellDisplay.getState()
      const cur = st.valueLegend[cellId]
      if (!legend) {
        if (cur) st.setValueLegend(cellId, undefined)
        return
      }
      if (cur && cur.colormap === legend.colormap && cur.domain[0] === legend.domain[0] && cur.domain[1] === legend.domain[1]) return
      st.setValueLegend(cellId, legend)
    },
    [cellDisplay],
  )
  const valueLegends = useMemo<Record<string, CellLegend>>(() => {
    const out: Record<string, CellLegend> = {}
    for (const [id, v] of Object.entries(perCellValueLegend)) {
      out[id] = {
        descriptor: colorbarDescriptor(v.colormap, [v.domain[0], v.domain[1]]),
        domain: [v.domain[0], v.domain[1]],
        colormap: v.colormap,
        title: cellMap[id]?.legendTitle ?? 'Value',
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perCellValueLegend, cellMap])
  /** The legend a cell shows: its dense continuous/categorical legend, else its matrix VALUE colorbar,
   *  else its grouped categorical legend. */
  const legendForCell = useCallback(
    (id: string): CellLegend | undefined => perCellLegend[id] ?? valueLegends[id] ?? perCellGroupLegend[id],
    [perCellLegend, valueLegends, perCellGroupLegend],
  )
  // Per-cell visual-map [lo,hi] range; absent ⇒ full domain (no filter). Edited via the in-cell bar or
  // the form. Declared here and threaded into `useGridDeckInputs` so the link value-range filter can enrich
  //
  // ITS HOME IS `PlotInteraction.store.filters` — NOT component-local `useState`. That store is the ONE
  // serialize source `VizController.getOption()` reads for `VizOption.filters` and `setOption` hydrates
  // (DEC-13), and it is the SAME lift the standalone `VisualMap.tsx` already opts into via its
  // `filterId`; the grid's `InCellVisualMap` had no such seam, so a range set here used to live and die
  // in React state — `option.filters` stayed absent (a saved figure kept its selection and lost the
  // filter that explained it) and no `onChange` ever fired. Keying by `cellPlotId(cell.id)` is the same
  // stable per-plot identity the cell's dataZoom uses, so a restored option lands on the right cell.
  const perCellRange = useStore(
    stores.plotInteraction,
    s => s.filters,
  ) as Record<string, readonly [number, number]>
  perCellRangeRef.current = perCellRange
  const setCellRange = useCallback(
    (id: string, range: readonly [number, number]) => {
      const plotId = cellPlotId(id)
      if (plotId) stores.plotInteraction.getState().setFilter(plotId, [range[0], range[1]])
    },
    [stores.plotInteraction],
  )
  // Which cells have their plotting-data TABLE open (MULTIPLE at once — like the edit form). Each table is
  // DOCKED (portaled/stacked in the right panel), not overlaid on its pane. Toggled from the pane toolbar.
  // SPLIT D (ITEM-15): the SET lives in `paneDocks` (the pane chrome reads `dataOpen` per cell, the
  // dock layer renders the tables, and the shell needs only "is ANY table open" for DRIFT-11's
  // camera gate). These two wrappers stay `[]`-stable because both are `<CellView>` props and
  // `memo(CellView)` is what keeps the chrome off the camera path (INV-1/INV-2).
  const toggleDataTable = useCallback((id: string) => paneDocks.getState().toggleDataTable(id), [paneDocks])
  const closeDataTable = useCallback((id: string) => paneDocks.getState().closeDataTable(id), [paneDocks])
  // The host's CLOSE for a portaled surface (`registerHostedSurfaceClose`). It is the SAME store
  // action the surface's own X calls — a host that closed only its projection would leave the
  // surface open in a detached container with the plot's toggle still lit. Handed over on mount and
  // withdrawn (`null`) on unmount, so a host can never hold a closer bound to a dead workspace.
  useEffect(() => {
    if (!registerHostedSurfaceClose) return
    registerHostedSurfaceClose((kind, paneId) => {
      const docks = paneDocks.getState()
      // EXHAUSTIVE on purpose. This was `if edit-plot … else closeDataTable`, which silently
      // routed any THIRD kind into the data table — and a third kind arrived (`export`) one
      // change later. The `never` arm makes the next one a compile error instead of a wrong close.
      switch (kind) {
        case 'edit-plot':
          docks.closeEdit(paneId)
          return
        case 'data-table':
          docks.closeDataTable(paneId)
          return
        case 'export':
          // Export lives in `exportTarget` (GridDockLayer owns it), not in `paneDocks`; the
          // dock api is the same handle the tool rail's own close uses.
          dockApiRef.current?.closeExport()
          return
        default: {
          const never: never = kind
          throw new Error(`[viz] no close for hosted surface kind ${String(never)}`)
        }
      }
    })
    return () => registerHostedSurfaceClose(null)
  }, [registerHostedSurfaceClose, paneDocks])
  // ── SPLIT S (ITEM-35) — THE HOVER / TOOLTIP-FIELD PLANE, in `useGridHover.ts`. ──────────────
  // DEC-26's "hover sink / tooltip fields" row, plus the CROSS-PLOT HIGHLIGHT state the sink writes.
  // The census row did not name that state, but it could not stay: `onHoverPublish` is the sole writer
  // of both `hoveredCellId` and `crossHighlight`, so a cut between the sink and the state would leave
  // a setter on one side of the boundary and its only caller on the other. The module-level
  // `sameHighlight` helper went too — that setter was its one reader.
  //
  // The PER-FRAME half (`hovered`, its rAF throttle, `onDeckHover`, `hoveredFields`, the main
  // `<VizTooltip>`) is NOT in the plane and never was: SPLIT B put it in `GridOverlayLayer`, which is
  // the whole reason a cursor moving within one point re-renders nothing up here. `deckHoverRef` is a
  // cross-LAYER ref, re-passed unchanged (DEC-28) — the overlay fills it, the deck calls it.
  //
  // MOUNTED HERE, where the highlight state used to be declared, and not where the hover SINK was:
  // `effectiveHighlight` is threaded into the mask plane's argument block ~30 lines below, so a mount
  // at the sink's old position is a use-before-declaration (caught by `tsc` on the first attempt).
  const {
    effectiveHighlight,
    chartHover,
    publishChartHover,
    deckHoverRef,
    deckHoverSink,
    hoveredCellId,
    onHoverPublish,
    tooltipFields,
  } = useGridHover({ tooltipContext, tooltipLabels })
  // Plot-data table: per-cell colorBy data (category names / continuous values) resident for the DENSE
  // scatter's data table, so the table shows the plotted VALUE column (not just x/y) — captured in the
  // recolor effect that already fetches it. And the per-cell PLOTTED ROWS a grouped/matrix chart View
  // publishes via `onPlotData` (box/violin/bar/dotplot/heatmap), so the table works for every plot type.
  // `PlotColorData` now lives beside the state it describes, in `CellDisplay.store.ts`.
  const perCellColorData = useStore(cellDisplay, s => s.colorData)
  const perCellPlotRows = useStore(cellDisplay, s => s.plotRows)
  // A chart View publishes its plotted rows; `pointIndices` (optional) is the per-row ORIGINAL local
  // point index (raw-dot charts like box/violin publish it → the table's hover-highlight works there too).
  const onCellPlotData = useCallback(
    (cellId: string, columns: string[], rows: (string | number)[][], pointIndices?: number[]) =>
      cellDisplay.getState().setPlotRows(cellId, { columns, rows, pointIndices }),
    [cellDisplay],
  )
  // Per-cell categorical HIDDEN codes (ephemeral); edited via the form's Legend section.
  const perCellHiddenCodes = useStore(cellDisplay, s => s.hiddenCodes)
  // Ref so the provenance context snapshot (ITEM-6) reads the LIVE hidden set from inside the
  // pointer-driven publish path without re-binding the callback on every legend toggle.
  const perCellHiddenCodesRef = useRef(perCellHiddenCodes)
  perCellHiddenCodesRef.current = perCellHiddenCodes
  // Test hook: read/set the in-cell visual-map ranges (drives the WYSIWYG e2e without a flaky
  // headless drag). DEV-ONLY — never attached in a production build (F1: it exposes per-cell state +
  // mutators, so it must not ship). `import.meta.env.DEV` is compiled to `false` in the app's prod
  // build, so this whole effect body is dead-code-eliminated there.
  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return
    const domains: Record<string, readonly [number, number] | undefined> = {}
    for (const [id, lg] of Object.entries(perCellLegend)) {
      domains[id] = lg.domain ?? (lg.descriptor.kind === 'continuous' ? lg.descriptor.domain : undefined)
    }
    ;(window as unknown as { __VIZ_INCELL__?: unknown }).__VIZ_INCELL__ = {
      ranges: perCellRange,
      domains,
      hidden: Object.fromEntries(Object.entries(perCellHiddenCodes).map(([id, s]) => [id, [...s]])),
      kinds: Object.fromEntries(Object.entries(perCellLegend).map(([id, lg]) => [id, lg.descriptor.kind])),
      setRange: (id: string, range: [number, number]) => setCellRange(id, range),
      // Toggle a category's visibility (mirrors the in-cell Legend click) — hides it on screen (via
      // the cell's colorBy.hidden → perCellColors recolor) AND in the export (perCellHiddenCodes).
      toggleCategory: (id: string, code: number) => {
        const cur = perCellHiddenCodes[id] ?? new Set<number>()
        const next = new Set(cur)
        next.has(code) ? next.delete(code) : next.add(code)
        cellDisplay.getState().setHiddenCodes(id, next)
        const cb = stores.gridWorkspace.getState().cells[id]?.colorBy
        if (cb) stores.gridWorkspace.getState().setCellColorBy(id, { ...cb, hidden: next })
      },
    }
  }, [perCellRange, perCellLegend, perCellHiddenCodes, stores.gridWorkspace, cellDisplay, setCellRange])
  // ITEM-22 — the DEV-only instrumentation seam INV-8 is measured through. Same guard + install
  // posture as `__VIZ_INCELL__` above, so it is dead-code-eliminated from a production build.
  //
  // It exists because INV-8 is otherwise UNFALSIFIABLE from outside: the defect it guards (a full
  // re-derive on every filter tick) returns byte-identical CORRECT ids, so no value assertion can
  // see it. `containmentCalls` counts the work, `idsRef()` exposes the ids ARRAY BY REFERENCE (an
  // identity probe that must be compared in-page — reference identity cannot cross an e2e
  // serialization boundary), and `lastClassification` reports what the gatekeeper decided.
  const lastClassificationRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return
    ;(window as unknown as { __VIZ_PROV__?: unknown }).__VIZ_PROV__ = {
      get containmentCalls() {
        return containmentPassCount()
      },
      idsRef: () => storesRef.current.coordination.getState().pointSelection,
      get lastClassification() {
        return lastClassificationRef.current
      },
      ops: () => storesRef.current.coordination.getState().selectionProvenance?.ops ?? null,
      context: () => storesRef.current.coordination.getState().selectionProvenance?.context ?? null,
    }
    // L18 — drop the seam on unmount. Without this the closure retains `storesRef` /
    // `lastClassificationRef` (and through them the whole store graph) on `window` for the life of
    // the page, so an unmounted workspace leaks and a REMOUNTED one leaves a stale reader that
    // answers for the dead instance. Round 1 added this cleanup to the new `__VIZ_CONTROLLER__`
    // seam in Viz.tsx while citing L18, but left L18's own site untouched.
    return () => {
      delete (window as unknown as { __VIZ_PROV__?: unknown }).__VIZ_PROV__
    }
  }, [])

  // (SPLIT A: the dev-only `__VIZ_GRID_VIEW__` per-cell zoom reader moved to `GridDeckLayer` with
  // the camera it reads. Its window contract is unchanged.)
  // F2: prune per-cell range/hidden state for cells that no longer exist (a removed id must not
  // resurrect its stale filter/hide on a reused id). `perCellLegend` is rebuilt as a fresh Record of
  // only the current colorBy cells, so its key set is the live set to prune against.
  useEffect(() => {
    const prune = <T,>(m: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {}
      let changed = false
      for (const id of Object.keys(m)) {
        if (id in perCellLegend) next[id] = m[id]
        else changed = true
      }
      return changed ? next : m
    }
    cellDisplay.getState().updateHiddenCodes(prune)
  }, [perCellLegend, cellDisplay])
  // F2 (range half): the visual-map ranges now live in `PlotInteraction.store.filters`, so prune THERE.
  // Keyed against the live CELL map, not `perCellLegend`: a legend is rebuilt ASYNCHRONOUSLY (the colorBy
  // column is fetched), so right after a `setOption` restore the legend map is still empty/partial while
  // the hydrated filters are already present — pruning against it would delete the very ranges the
  // restore just brought back. `cellMap` is synchronous store state, so "the cell is gone" is decidable
  // immediately. The no-cells early-return keeps a pre-hydration render from clearing a hydrated filter.
  useEffect(() => {
    const ids = Object.keys(cellMap)
    if (ids.length === 0) return
    const live = new Set(ids)
    const { filters, clearFilter } = stores.plotInteraction.getState()
    for (const id of Object.keys(filters)) if (!live.has(id)) clearFilter(id)
  }, [cellMap, stores.plotInteraction])
  // Read the live dense-cell list inside the async effect without making the effect
  // re-run on unrelated cell changes (e.g. a graph-overlay toggle): `colorSig` is the
  // sole data-trigger, and it is a pure function of the same `denseCells`.
  const denseCellsRef = useRef(denseCells)
  denseCellsRef.current = denseCells
  // MD-9: the perCellColors effect reads a datasetId cell's colorBy column from ITS dataset's source,
  // so it needs live entries (read via ref, not a dep, to avoid recoloring on unrelated refCount/epoch
  // bumps) plus a re-run signal that fires only when a colorBy+datasetId cell's dataset (re-)becomes
  // ready (`status`+`gen`, ignoring buffer-content `epoch`).
  const datasetEntriesRef = useRef(datasetEntries)
  datasetEntriesRef.current = datasetEntries
  // ── SPLIT N (ITEM-30) — THE IMAGE / RASTER PLANE, in `useGridRaster.ts`. ─────────────────────
  // Both raster caches and their fetch effects, the component-lifetime mounted flag, the three
  // per-channel display controls and the camera-framing effect left this body wholesale. Rationale
  // and writer-set table are in that module's header. `insetPane` is NOT moved — it is one of
  // DRIFT-25's seven measurement bindings, pinned here by INV-10 and borrowed by the framing effect.
  const {
    imageUnderlays,
    imageUnderlaysRef,
    imagePyramids,
    imagePyramidsRef,
    imgFetchMountedRef,
    setImageChannel,
    setImageColormap,
    autoContrastChannel,
  } = useGridRaster({
    cells,
    source,
    datasetEntriesRef,
    rects,
    insetPane,
    localStatesRef,
    seedViewStateRef,
    cellFrame,
  })
  // SPLIT F (ITEM-22) — THE COLORING / LEGEND DATA PLANE, in `useGridColoring.ts`.
  //
  // The recolor effect, the two legend effects and the two signatures (`colorSig` /
  // `colorDatasetSig`) that trigger them left this body wholesale. Nothing comes back: every
  // output is a write to the per-workspace `cellDisplay` store the pane + deck layers already
  // read, so this shell no longer brokers a single coloring value. `withColorOverrides` and
  // `epochRef` moved with the effects that were their only readers.
  useGridColoring({
    stores,
    cellDisplay,
    source,
    catalog,
    cells,
    denseCells,
    denseIds,
    datasetEntries,
    denseCellsRef,
    datasetEntriesRef,
    cellMapRef,
    colorOverrides,
    linkedHiddenFor,
    linkColumnFilterFor,
    perCellRange,
    linkGroups,
  })

  // Shell redesign: which cell's EDIT FORM is open (null = closed). The ✎ Edit button on a pane toolbar
  // opens it; the form renders in the internal right panel or the host-provided `editFormContainer`.
  // A SET so multiple panes can be edited at once (the host resolves a distinct container per pane).
  //
  // SPLIT D (ITEM-15): the SET itself lives in `paneDocks`. It is the ONE of the five inherited
  // states with NO shell reader at all — the pane chrome reads `editOpen` per cell and the dock
  // layer renders the forms — so after this split the shell holds only these two stable wrappers.
  const toggleEditCell = useCallback((id: string) => paneDocks.getState().toggleEdit(id), [paneDocks])
  const closeEditCell = useCallback((id: string) => paneDocks.getState().closeEdit(id), [paneDocks])
  // SPLIT B (ITEM-16): `rectDraft` / `polyDraft` / `selHoverMove` moved into `GridOverlayLayer`.
  // They were written on every pointermove of a marquee drag and on every hover transition, so each
  // one re-rendered this whole closure for chrome only the overlay reads. What stays here is the
  // NARROW surface a sibling genuinely needs: the imperative handle the four reset sites call, and
  // the polygon VERTEX COUNT the tool rail renders "Finish" from (published per click, not per frame).
  const overlayApiRef = useRef<GridOverlayApi | null>(null)
  const activeCellRef = useRef<string | null>(null)
  // ── SPLIT Q (ITEM-33) — THE TOOL-STATE PLANE, in `useGridTools.ts`. ─────────────────────────
  // DEC-26's "tool state" row: the exclusive active tool, the selection SHAPE sub-tool, and the
  // `selectMode` / `chartSelectMode` / `toggleSelectMode` derivations. `activeToolRef` did NOT come
  // back — it has three sites, all inside the plane, so it is internal there. `overlayApiRef` and
  // `activeCellRef` are passed IN (declared just above): four other modules share them, so a plane
  // that declared either would fork a ref this decomposition already threads (DEC-28).
  const { activeTool, setActiveTool, selectMode, selTool, setSelTool, chartSelectMode, toggleSelectMode } =
    useGridTools({ overlayApiRef, activeCellRef })

  // (SPLIT B: `selPanRef` — the draw sheet's middle/SPACE pan bookkeeping — moved into
  //  `GridOverlayLayer` with the three pointer handlers that are its only readers.)

  // ── SPLIT M (ITEM-29) — THE DOCK / POPOUT-WINDOW PLANE, in `useGridWindows.ts`. ──────────────
  // The popup-container set and its close handshake, the session-restore choice, the aim-to-place
  // session, the popup-realm canvas sizing effect, the dock-handle wrappers and the per-cell export
  // request left this body wholesale. Rationale, writer-set table and the effect-order note are in
  // that module's header. `renderPopupContainer` deliberately did NOT go: it renders `<GridWorkspace>`
  // itself, so a hook that owned it would import the shell that imports it.
  const {
    popupContainers,
    handleWindowClosed,
    handleAckClose,
    pendingClose,
    pendingRestore,
    handleMergeRestored,
    handleReopenRestored,
    dockApiRef,
    openExportCell,
    openExportGrid,
    requestExportCell,
  } = useGridWindows({
    stores,
    containerId,
    containerRef,
    deckRef,
    restoreKey,
    denseRects,
    activeCellRef,
    denseCellsRef,
    perCellLegend,
    perCellRange,
    perCellHiddenCodes,
    onRequestExportCell,
  })

  // Latest dense rects + per-cell controlled view state, read inside pointer handlers
  // without re-binding them every render (the draw commit needs the cell's live viewport).
  // IMPORTANT: use the INSET rects (the actual DECK viewport = cell minus the pane toolbar strip), NOT
  // the full cell rect — every consumer here (cellAtPoint + unprojectInCell for rect/lasso/pan/zoom) is
  // deck-coordinate math, so screen→world must match the deck's inset viewport. Using the full rect made
  // the lasso/rect selection off by the toolbar height whenever the toolbar was shown. As a bonus,
  // cellAtPoint now excludes the toolbar strip, so a press there starts no selection.
  const denseRectsInset = useMemo(() => denseRects.map(plotInset), [denseRects, plotInset])
  const denseRectsRef = useRef(denseRectsInset)
  denseRectsRef.current = denseRectsInset

  // SPLIT A — THE ONE PLACE THE SHELL DELIBERATELY RE-SUBSCRIBES TO THE CAMERA, AND ONLY WHILE IT
  // MUST. `buildPlotDataTable` below lists the points VISIBLE IN THE PANE'S CURRENT VIEW WINDOW, so
  // before this split the shell's per-frame re-render was what kept an open plot-data table in sync
  // with a pan/zoom. Moving the camera out would have silently frozen that table — a behaviour
  // regression with no perf signal, which is exactly how a split "wins". So the deck layer calls
  // `onCameraCommit` on every committed camera change and the shell converts it to a re-render
  // ONLY when at least one data table is open. With none open (the perf drive, and the overwhelming
  // majority of use) this is a ref read and a `return`: the camera still never re-renders the shell.
  const [cameraEpoch, setCameraEpoch] = useState(0)
  const wantsCameraEpochRef = useRef(false)
  wantsCameraEpochRef.current = useStore(paneDocks, selectAnyDataTableOpen)
  const onCameraCommit = useCallback(() => {
    if (wantsCameraEpochRef.current) setCameraEpoch(e => e + 1)
  }, [])

  // SPLIT C (ITEM-17): `buildPlotDataTable` moved to `GridDockLayer.tsx` with the dock that renders
  // it. `cameraEpoch` stays here — it is the shell state DRIFT-11 bumps on a committed camera change
  // while ≥1 table is open, and it crosses DOWN as the prop that re-derives the visible-window rows.

  const toLocal = useCallback((e: { clientX: number; clientY: number }): ScreenPoint => {
    const c = containerRef.current?.getBoundingClientRect()
    if (!c) return [0, 0]
    return [e.clientX - c.left, e.clientY - c.top]
  }, [])

  // SPLIT I (ITEM-25) — THE SELECTION PUBLISH / PROVENANCE / COMMIT PLANE, in `useGridSelection.ts`.
  //
  // The KD-tree index, both commit paths, the multi-region fold + publish, the whole provenance half
  // (resolvers, `snapshotContext`, the revalidation gatekeeper and the host registrar), the draft /
  // mode state the rail and the overlay drive, `clearGridSelection` and the exclusive-selection
  // reconcile effect all left this body. Four of the returns are the SEAM refs (DEC-20) and are
  // re-passed below unchanged, so `GridOverlayLayer` keeps reading the SAME ref objects; the fifth
  // is the `setCommittedByCell` the overlay writes as a prop. `activeCellRef` did NOT move —
  // `requestExportCell` writes it too, and a ref with two owners is passed, not taken.
  const {
    committedByCell,
    setCommittedByCell,
    committedByCellRef,
    selMulti,
    setSelMulti,
    selMultiRef,
    polySlotRef,
    dragRef,
    anyCommittedArea,
    selSpaceHeld,
    polyDraftCount,
    setPolyDraftCount,
    finishPolygon,
    commitRect,
    commitPolygon,
    publishCellAreas,
    clearGridSelection,
  } = useGridSelection({
    coordination,
    coordinationRef,
    storesRef,
    positions,
    cells,
    cellData,
    cellDataRef,
    cellMapRef,
    cellSelectionSpaceRef,
    perCellRange,
    perCellRangeRef,
    perCellHiddenCodes,
    perCellHiddenCodesRef,
    pointIndexFor,
    denseRectsRef,
    viewStateRef,
    onSelectionPanes,
    lastClassificationRef,
    overlayApiRef,
  })
  // (SPLIT B — ITEM-16: `grabCommittedAt`, the three draw pointer handlers (`onDrawPointerDown` /
  //  `Move` / `Up`), `onDrawWheel` and the whole per-overlay non-passive wheel-binding machinery
  //  (`wheelRefFor` + its keyed detachers, CONVERGENCE H2) moved into `GridOverlayLayer`. Every one
  //  of them exists only to serve an overlay element, and every one of them wrote `rectDraft` /
  //  `polyDraft` / `selHoverMove` — i.e. they are the WRITERS the split had to take with the state.
  //  The camera they drive still crosses through the seam's `onViewStateChangeRef` (ITEM-6), so a
  //  SPACE-drag on the draw sheet pans exactly as before.)


  // ── Mask review + correction (segmentation-scale ITEM-1/2) — LIVE in the grid ────────
  // The in-grid label-mask render surface (`buildLabelMaskLayers`, composed into the shared deck by the
  // `labelMaskLayers` memo, in `useGridDeckInputs.ts`) makes a `segment` cell's mask visible; this wires the LIVE
  // review/correct panel to it (closing the FB-17 "NOT mounted" gap the prior comment described).
  // Additive + guarded: everything is behind the `segment` tool + a cell's `segment` flag + a resolved
  // `labelMask`, so a non-segment workspace is byte-identical. The per-cell mask SESSION owns a
  // `createMaskCorrectController` bound to the cell's ONE raster (mutated in place, dirty-rect
  // sub-upload); the review STATE (hide/solo/select/tool/target) drives the layer props.
  // Same per-pane entry point as annotate (finding #14): `segmentMode` is DERIVED from the open set,
  // not from a global rail mode.
  // Tool availability keys off the `segment` FLAG (not a resolved mask) so the Segment tool appears
  // while the mask is still loading; the layer/session/panel gate on `resolvedLabelMask` below.
  // SPLIT G (ITEM-23) — THE MASK / SEGMENTATION AUTHORING PLANE, in `useGridMasks.ts`.
  //
  // The `imageLabelMask()` fetch, the segment-dock bindings, the per-cell `MaskCorrectController`
  // sessions, the cross-cell `SharedLabelMask` controllers and the review state left this body
  // wholesale. What comes back is exactly what four consumers OUTSIDE the plane still need: the
  // deck's `layersAfter` builder (`resolvedLabelMask` / `sharedSessionForCell` / `maskReview` /
  // `maskEpoch` / `applyMaskPick`), the dock layer, the pane toolbar (`segmentCellIds` /
  // `maskReady`), and the dev window-seam effect below — which stays here because it ALSO publishes
  // the link + display seams, so the three symbols it escapes onto `window` are returned and
  // re-passed rather than moved, leaving that effect byte-identical.
  const {
    segmentCellIds,
    segmentMode,
    toggleSegmentCell,
    closeSegmentCell,
    resolvedLabelMask,
    maskReady,
    maskReview,
    maskEpoch,
    bumpMask,
    patchMaskReview,
    maskShareNotice,
    ensureMaskSession,
    sharedSessionForCell,
    applyMaskPick,
    shareMaskAcrossGroup,
    detachSharedMask,
    sharedMaskSessionsRef,
  } = useGridMasks({
    stores,
    paneDocks,
    cells,
    denseIds,
    source,
    datasetEntriesRef,
    imgFetchMountedRef,
    linkGroups,
    cellLinkGroup,
  })
  // ── SPLIT R (ITEM-34) — THE DEV-INSTRUMENTATION PLANE, in `useGridDevSeams.ts`. ─────────────
  // DEC-26's "DEV instrumentation seams" row: the six `window.__viz*` hooks the gallery stories and
  // the e2e suite drive the grid through, their primary-instance gate and the unmount teardown.
  // Returns nothing — every output is a `window` write, so there is nothing to broker (the
  // `useGridColoring` shape, DEC-27).
  //
  // `isPrimaryWorkspace` WENT WITH IT. The comment that used to sit here said it could not move
  // because "the mask plane's window-hook effect reads it too" — but that effect IS this module, and
  // with the effect gone the const had zero code readers left. Carrying it would have been dead code
  // behind a comment explaining why it was alive (DEC-18 rule 4). `useGridAnnotate.ts`'s writer-set
  // table made the same claim and is corrected in the same commit.
  useGridDevSeams({
    containerId,
    stores,
    maskEpoch,
    sharedMaskSessionsRef,
    shareMaskAcrossGroup,
    detachSharedMask,
    applyDisplayToGroup,
  })


  // (SPLIT B — ITEM-16: the annotate overlay's pointer routing (`annotatePanRef` +
  //  `onAnnotatePointerDown` / `Move` / `Up`) moved into `GridOverlayLayer` with the per-pane overlay
  //  elements it is bound to. The INV-13 "first press draws on the pressed pane" contract is
  //  unchanged: the bind is still synchronous into `gestureAnnotateCellRef` before the editor's own
  //  handler is delegated to, and that ref is passed down rather than re-created.)

  // ── SPLIT J (ITEM-26) — THE ANNOTATE PLANE, in `useGridAnnotate.ts`. ─────────────────────────
  //
  // The per-cell `AnnotateStore` map + its subscribe/teardown reconcile, the per-pane dock bindings,
  // the gesture binding and the `useAnnotateEditor` mount, and the FB-17 P2 processor-port seam left
  // this body wholesale, together with the two dev window hooks that publish the maps they own
  // (`__vizAnnotateStores`, `__vizProcessorPorts`) — a seam publishes a ref, it is not a writer, and
  // that was CHECKED rather than assumed (Split G's `__vizSharedMasks` finding is why).
  //
  // What comes back is exactly what consumers OUTSIDE the plane still need: `annotateStoresRef` for
  // the ITEM-14 seam (returned, not re-declared, so `GridDeckLayer` keeps reading the SAME map —
  // DEC-28), `annotateEpoch` + `annotateMode` + `boundAnnotateCellId` + `annotateEditor` for the deck
  // layer, `gestureAnnotateCellRef` + `setBoundAnnotateCellId` + `annotateActive` for the overlay
  // layer's INV-13 synchronous bind, `ensureAnnotateStore` + `toggleAnnotateCell` for the pane layer,
  // and `annotateCellIds` + `annotateStoreFor` + `closeAnnotateCell` for the dock.
  //
  // (`isPrimaryWorkspace` used to be named here as a value with two owners. SPLIT R corrected that:
  //  the second owner was the window-hook effect, which is now `useGridDevSeams.ts`, and the const
  //  went with it. This plane never read it.)
  const {
    annotateStoresRef,
    annotateEpoch,
    ensureAnnotateStore,
    annotateCellIds,
    annotateMode,
    annotateActive,
    closeAnnotateCell,
    toggleAnnotateCell,
    gestureAnnotateCellRef,
    boundAnnotateCellId,
    setBoundAnnotateCellId,
    annotateStoreFor,
    annotateEditor,
  } = useGridAnnotate({
    cells,
    denseIds,
    paneDocks,
    glOk,
    denseRectsRef,
    viewStateRef,
    toLocal,
    imagePyramidsRef,
    imageUnderlaysRef,
  })


  // SPLIT H (ITEM-24) — THE DECK LAYER INPUTS, in `useGridDeckInputs.ts`.
  //
  // `views` / `layerFilter` / `cellsForView`, the per-cell scatter `layers` memo, the graph-overlay
  // geometry it splices in, and the outline / hover-highlight / chart / label-mask builders left this
  // body wholesale. Every one of them is a `useMemo` — a pure derivation with no writer — which is why
  // this plane RETURNS a bundle instead of writing a store like Split F did: writing `layers` from an
  // effect would cost one extra render pass per hover, which is exactly what TEST-P1/P5 measure.
  const { views, layerFilter, cellsForView, deckLayersBefore, labelMaskLayers } = useGridDeckInputs({
    denseRects,
    chartDeckRects,
    plotInset,
    cells,
    denseCells,
    denseIds,
    cellMap,
    cellData,
    cellSelectionSpace,
    radius,
    positions,
    codes,
    graph,
    categories,
    graphColorByOrder,
    graphColormap,
    perCellColors,
    perCellLegend,
    perCellGroupLegend,
    perCellRange,
    colorOverrides,
    linkedHiddenFor,
    linkColumnFilterFor,
    pointSelection,
    selectionBySpace,
    idToRowFor,
    committedByCell,
    effectiveHighlight,
    imageUnderlays,
    imagePyramids,
    cellFrame,
    chartContribs,
    maskReview,
    maskEpoch,
    resolvedLabelMask,
    sharedSessionForCell,
    applyMaskPick,
  })
  const drawActive = selectMode && glOk && denseRects.length > 0

  // Cross-window docking (P4): while a grip drag hovers THIS container's empty body (a MOVE with no
  // pane under the cursor), outline the whole workspace as the "append here" drop target. A move-BESIDE
  // a specific pane is highlighted by that CellView; this covers the append/empty-body case.
  const gripDrag = useGripDragState()
  const isBodyDropTarget =
    gripDrag.active &&
    gripDrag.target.kind === 'move' &&
    gripDrag.target.container === containerId &&
    gripDrag.target.overPaneId === null
  // Aim-to-place is live (P5): show the reminder banner in every window; the drop-target highlights
  // (reused from P4) already show WHERE the new plot lands.
  const isPlacing = gripDrag.active && gripDrag.mode === 'placement'

  // ── SPLIT O (ITEM-31) — THE ACCESSIBILITY PLANE, in `useGridA11y.ts`. ───────────────────────
  // The `a11yEnabled` gate, the focus-visible bookkeeping, the live-region announcer, the focused-
  // cell state and its mirrors, the cell-CYCLING keydown listener, the `useCanvasKeyboard` camera
  // bindings and the focus-outline rect left this body wholesale. Rationale and writer-set table are
  // in that module's header. `clearGridSelection` is passed IN so Escape clears the same selection
  // the rail does, and the four shell/seam refs the listeners read are borrowed, not taken.
  const { a11yEnabled, kbdFocusVisible, clearKeyboardFocusVisible, liveRef, effFocusedId, focusedRect } =
    useGridA11y({
      accessibleLabel,
      glOk,
      onA11yAnnounce,
      denseIds,
      denseCells,
      cellMap,
      denseRects,
      nPoints,
      containerRef,
      viewStateRef,
      onViewStateChangeRef,
      cellDataRef,
      clearGridSelection,
    })

  // Render a popup container's workspace. STABLE identity (only the pane-content inputs are deps, NOT
  // the drag state) so a drag-state re-render of THIS main workspace does not churn — and thus never
  // re-mounts — the portaled popup subtree mid-drag (which would abort the drag's source cell). P4.
  const renderPopupContainer = useCallback(
    (id: ContainerId) => (
      <GridWorkspace
        containerId={id}
        source={source}
        catalog={catalog ?? undefined}
        positions={positions}
        colors={colors}
        colorEpoch={colorEpoch}
        radius={radius}
        codes={codes}
        graph={graph}
        categories={categories}
        graphColorByOrder={graphColorByOrder}
        graphColormap={graphColormap}
        tooltipContext={tooltipContext}
        tooltipLabels={tooltipLabels}
        pointIds={pointIds}
        onRequestExportCell={onRequestExportCell}
        // Keep a popped-out grid keyboard-navigable too (its own live region lives in its window, so
        // the host `onA11yAnnounce` observer is NOT forwarded — that would cross-wire windows).
        accessibleLabel={accessibleLabel}
      />
    ),
    [
      source,
      catalog,
      positions,
      colors,
      colorEpoch,
      radius,
      codes,
      graph,
      categories,
      graphColorByOrder,
      graphColormap,
      tooltipContext,
      tooltipLabels,
      pointIds,
      onRequestExportCell,
      accessibleLabel,
    ],
  )

  // SPLIT C (ITEM-17): `buildEditForm`, `buildExportDialog`, `buildPlotDataTable`, the portal/internal
  // partition and the annotate/mask dock loops MOVED to `GridDockLayer.tsx`, together with
  // `exportTarget`. What stays here is the state five of those surfaces are gated by, because each
  // has a reader this shell still owns — see the header of `GridDockLayer.tsx`.

  // ── SPLIT 0a: the SEAM (ITEM-14 / DEC-20) ───────────────────────────────────────────────────────
  // The stable-identity bundle Splits A–E read instead of prop-drilling. EVERY member is a store
  // handle or a `useRef` object, so this `useMemo`'s value identity changes ONLY when the `<Viz>`
  // instance's store set does — never per frame, never per interaction. That is the whole contract:
  // a consumer of this context is never re-rendered by anything the workspace does. Reactive values
  // cross the boundary as explicit PROPS, and the camera crosses UPWARD through `viewStateRef` /
  // `onViewStateChangeRef`, which the deck layer fills (ITEM-6) — never as a member here.
  // `useRef` objects are deliberately absent from the dep list: their identity is fixed for the
  // component's lifetime, so listing them would be noise, not safety.
  const seam = useMemo<GridWorkspaceSeam>(
    () => ({
      stores,
      coordination,
      cellDisplay,
      paneDocks,
      storesRef,
      coordinationRef,
      cellMapRef,
      cellDataRef,
      cellSelectionSpaceRef,
      annotateStoresRef,
      activeCellRef,
      selMultiRef,
      committedByCellRef,
      denseRectsRef,
      polySlotRef,
      dragRef,
      viewStateRef,
      onViewStateChangeRef,
      localStatesRef,
      seedViewStateRef,
    }),
    [stores, coordination, cellDisplay, paneDocks],
  )

  const gridRoot = (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%', minHeight: 0, position: 'relative' }}>
      {/* Track C (ITEM-14): confirm-before-overwrite for "apply display to link group" (ESC-1). */}
      {propagateConfirm && (
        <PropagateConfirmDialog
          overwriteLabels={propagateConfirm.overwriteLabels}
          scopeLabel={propagateConfirm.scopeLabel}
          onConfirm={() => {
            stores.gridWorkspace.getState().applyDisplayPatches(propagateConfirm.patches)
            setPropagateConfirm(null)
          }}
          onCancel={() => setPropagateConfirm(null)}
        />
      )}
      {/* Shell redesign: the GLOBAL left tool rail — one per grid, OCCUPIES the left edge (not overlaid),
          only on the primary container (popups get none). Holds the exclusive active tool + global
          toggles + whole-grid export. Replaces the old floating Select + Link-zoom pills. */}
      {containerId === PRIMARY_CONTAINER && glOk && (
        <VizToolRail
          activeTool={activeTool}
          onToolChange={setActiveTool}
          cellToolbars={cellToolbarsOn}
          onToggleCellToolbars={() => setCellToolbarsOn(v => !v)}
          tooltipsEnabled={tooltipsEnabled}
          onToggleTooltips={() => setTooltipsEnabled(v => !v)}
          linkZoom={linked}
          onToggleLinkZoom={toggleLinked}
          onExportGrid={onRequestExportGrid ?? openExportGrid}
          afterLinkZoom={toolRailSlots?.afterLinkZoom}
          aboveExport={toolRailSlots?.aboveExport}
          // Selection SHAPE sub-tools live in the rail (under Select) when Select is active + there is a
          // selectable dense surface. Changing shape resets any in-progress draft (mirrors the old strip).
          selectExpanded={selectMode && denseRects.length > 0}
          selShape={selTool}
          onSelShapeChange={t => {
            setSelTool(t)
            overlayApiRef.current?.clearDrafts()
          }}
          polyDraftCount={polyDraftCount}
          onFinishPolygon={finishPolygon}
          onClearSelection={clearGridSelection}
          selMulti={selMulti}
          onToggleSelMulti={() => setSelMulti(v => !v)}
          // NO annotate/segment props (finding #14): those surfaces are opened from each PANE's own
          // toolbar, so the global rail exposes view-level modes only.
          // DRIFT-1.5 (carried from ROOT 1): `select.move` is an ACTION on an existing selection, so
          // it is disabled until one exists. ROOT 1 added the prop but could not wire it — the
          // selection plumbing lives in this region, which ROOT 2 rewrites.
          hasSelection={anyCommittedArea}
        />
      )}
      <div
        ref={containerRef}
        data-testid="viz-grid-workspace"
        // A11Y (opt-in): a labeled, focusable application region with keyboard camera control over the
        // focused dense cell (see the a11y block above). `outline:none` so our own focused-cell outline
        // (below) is the visible indicator, not the browser's whole-workspace ring.
        {...(a11yEnabled ? { tabIndex: 0, role: 'application', 'aria-label': accessibleLabel } : {})}
        // Any pointer press disarms the keyboard focus ring (`:focus-visible` semantics). CAPTURE
        // phase so an overlay/child that stops propagation still disarms it. No-op when disarmed.
        onPointerDownCapture={clearKeyboardFocusVisible}
        style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden', outline: 'none' }}
      >
      {/* SPLIT A (ITEM-5) — THE DECK + CAMERA LAYER. Mounted UNCONDITIONALLY (the `visible` prop
          gates the <DeckGL> element, not the component) because it owns `localStates`: unmounting
          it on 'no dense panes' would silently reset every pane's camera and leave the three seam
          camera refs stale. It is FIRST in DOM so `useCanvasRecovery`'s `querySelector('canvas')`
          still grabs the SHARED deck canvas rather than a chart's. */}
      <GridDeckLayer
        visible={glOk && denseRects.length + chartDeckRects.length > 0}
        restoreKey={restoreKey}
        deckRef={deckRef}
        views={views}
        layerFilter={layerFilter}
        onDeckHover={deckHoverSink}
        layersBefore={deckLayersBefore}
        layersAfter={labelMaskLayers}
        cellSpaces={cellSpaces}
        linked={linked}
        chartContribs={chartContribs}
        cells={cells}
        denseIds={denseIds}
        annotateEpoch={annotateEpoch}
        annotateMode={annotateMode}
        boundAnnotateCellId={boundAnnotateCellId}
        annotateEditDraft={annotateEditor.editDraft}
        tooltipsEnabled={tooltipsEnabled}
        tooltipFields={tooltipFields}
        effectiveHighlight={effectiveHighlight}
        hoveredCellId={hoveredCellId}
        denseCells={denseCells}
        cellData={cellData}
        rects={rects}
        plotInset={plotInset}
        drawActive={drawActive}
        onCameraCommit={onCameraCommit}
      />

      {/* SPLIT D (ITEM-15) — THE PANE-CHROME LAYER: one `<CellView>` per measured leaf rect (with
          the seven per-cell context providers around them), the per-cell link-pick / link-manage
          affordances, the in-cell WYSIWYG legend overlay and the plot-title overlay. A FRAGMENT, so
          no wrapper node is introduced: the content overlay div keeps its exact z4 position and the
          legend/title divs their z2, with every z-index and every `data-testid` unchanged.
          ONE ordering delta, deliberate and inert: the legend + title loops used to render AFTER the
          `ContainerWindows` / `RestoreChoiceDialog` block and now render before it. `ContainerWindows`
          portals into SEPARATE browser windows (no in-flow DOM here at all) and `RestoreChoiceDialog`
          is `position:absolute; zIndex:40/41` against these z2 overlays — so z-index, not document
          order, decides paint, exactly as at Splits A and B.
          The seven measurement bindings ITEM-15 also named do NOT move; see the layer's header for
          the per-binding reader enumeration that keeps each of them here. */}
      <GridPaneLayer
        chartSelectMode={chartSelectMode}
        selMulti={selMulti}
        onCellPlotData={onCellPlotData}
        tooltipsEnabled={tooltipsEnabled}
        publishValueLegend={publishValueLegend}
        publishChartHover={publishChartHover}
        effectiveHighlight={effectiveHighlight}
        rects={rects}
        insetPane={insetPane}
        plotInset={plotInset}
        legendGutterFor={legendGutterFor}
        measureLegend={measureLegend}
        effectiveCatalog={effectiveCatalog}
        cellMap={cellMap}
        cellsForView={cellsForView}
        cellCount={cells.length}
        denseIds={denseIds}
        chartDeckIds={chartDeckIds}
        chartSink={chartSink}
        datasetEntries={datasetEntries}
        source={source}
        positions={positions}
        colors={colors}
        colorEpoch={colorEpoch}
        ensureAnnotateStore={ensureAnnotateStore}
        onExportCell={onRequestExportCell ? requestExportCell : openExportCell}
        onEditCell={toggleEditCell}
        onShowData={toggleDataTable}
        annotateCellIds={annotateCellIds}
        onAnnotateCell={toggleAnnotateCell}
        segmentCellIds={segmentCellIds}
        maskReady={maskReady}
        onSegmentCell={toggleSegmentCell}
        onToggleLink={onToggleLink}
        cellToolbarsOn={cellToolbarsOn}
        containerId={containerId}
        linkColorFor={linkColorFor}
        linkPicking={linkPicking}
        linkAnchorDataset={linkAnchorDataset}
        linkGroups={linkGroups}
        linkColorIdx={linkColorIdx}
        cellLinkGroup={cellLinkGroup}
        linkPopoverCell={linkPopoverCell}
        setLinkPopoverCell={setLinkPopoverCell}
        legendForCell={legendForCell}
        perCellLegend={perCellLegend}
        valueLegends={valueLegends}
        perCellHiddenCodes={perCellHiddenCodes}
        perCellRange={perCellRange}
        setCellRange={setCellRange}
        vizTheme={vizTheme}
      />

      {/* PORTAL_DOCKING: the MAIN grid mounts ContainerWindows ONCE — each popup container renders as
          its own <GridWorkspace containerId> portaled into the window opened for it in the gesture. A
          nested (popup) workspace never mounts this, so no recursion. */}
      {containerId === PRIMARY_CONTAINER && (
        <ContainerWindows
          containers={popupContainers}
          pendingClose={pendingClose}
          onWindowClosed={handleWindowClosed}
          onAcknowledgeClose={handleAckClose}
          renderContainer={renderPopupContainer}
        />
      )}

      {/* Session-restore choice (P5): a reload restored a docked layout with popups whose windows can't
          reopen without a gesture — offer merge-to-main or reopen-windows. Main grid only. */}
      {containerId === PRIMARY_CONTAINER && pendingRestore.length > 0 && (
        <RestoreChoiceDialog
          windowCount={pendingRestore.length}
          onMerge={handleMergeRestored}
          onReopen={handleReopenRestored}
        />
      )}


      {/* SPLIT B (ITEM-16) — THE OVERLAY LAYER: the selection draw sheet, the per-open-pane
          annotation draw overlays, the cross-window drop outline, the aim-to-place banner, the
          keyboard-focus outline and the main hover tooltip, with the draft + hover state that drives
          them. A FRAGMENT, so no wrapper node is introduced and the five overlay divs keep their exact
          previous position in this container's child order, with every z-index unchanged.
          ONE ordering delta, deliberate and inert: the MAIN hover tooltip used to render LAST (after
          the panels overlay); it now renders here with the rest of the overlay surface. It is
          `position:absolute; zIndex:20` against a z2 panels overlay and z3–z6 chrome, so z-index —
          not document order — decides paint, and it still follows `GridDeckLayer`'s cross-plot
          tooltips (also z20), preserving DRIFT-10's recorded main-over-cross paint order exactly. */}
      <GridOverlayLayer
        drawActive={drawActive}
        selTool={selTool}
        selSpaceHeld={selSpaceHeld}
        toLocal={toLocal}
        commitRect={commitRect}
        commitPolygon={commitPolygon}
        publishCellAreas={publishCellAreas}
        setCommittedByCell={setCommittedByCell}
        onPolyDraftCountChange={setPolyDraftCount}
        annotateActive={annotateActive}
        gestureAnnotateCellRef={gestureAnnotateCellRef}
        setBoundAnnotateCellId={setBoundAnnotateCellId}
        annotateEditor={annotateEditor}
        denseRects={denseRects}
        plotInset={plotInset}
        containerId={containerId}
        isBodyDropTarget={isBodyDropTarget}
        isPlacing={isPlacing}
        focusedRect={focusedRect}
        effFocusedId={effFocusedId}
        tooltipsEnabled={tooltipsEnabled}
        tooltipFields={tooltipFields}
        cells={cells}
        cellMap={cellMap}
        cellData={cellData}
        datasetTooltips={datasetTooltips}
        datasetTooltipLabels={datasetTooltipLabels}
        datasetEntries={datasetEntries}
        chartHover={chartHover}
        chartDeckIds={chartDeckIds}
        chartDeckRects={chartDeckRects}
        chartContribs={chartContribs}
        onHoverPublish={onHoverPublish}
        deckHoverRef={deckHoverRef}
        apiRef={overlayApiRef}
      />

      {/* Off-screen ARIA live region for the keyboard-a11y announcements (opt-in). */}
      {a11yEnabled && <A11yLiveRegion ref={liveRef} />}

      {/* Context-loss recovery badge (ITEM-57): non-blocking, over the whole grid. */}
      {glOk && lost && <ContextLostOverlay />}

      {/* (Selection shape sub-tools + finish/clear moved into the global tool rail, beneath Select.) */}

      {/* (Link-zoom toggle moved to the global tool rail.) */}
      {!glOk && (
        <div
          data-testid="viz-grid-nogl"
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
        >
          WebGL unavailable
        </div>
      )}

      {/* Loading affordance (data-ownership inversion): shown while the workspace pulls the owned
          buffers/catalog from `source`. Covers the whole workspace (z5, above every overlay) until
          the one-time handoff resolves; never rendered on the eager-prop path. */}
      {selfPending && (
        <div
          data-testid="viz-grid-loading"
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 5,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.02)',
            font: '12px system-ui, sans-serif',
          }}
        >
          Loading…
        </div>
      )}

      {/* Owned-data pull FAILED (data-ownership inversion): a visible error, never a permanent
          spinner. A DISTINCT affordance from a chart cell's `<ChartError>` on purpose — this is a
          whole-workspace COVER over the one-time `source.catalog()`/`source.positions()` handoff, not
          a single chart's load error, so it's worded + positioned for the workspace. `role="alert"`
          announces the failure to assistive tech. Its text is `<OwnedDataErrorText>`. */}
      {ownedError != null && (
        <div
          data-testid="viz-grid-data-error"
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 5,
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            textAlign: 'center',
            background: 'rgba(0,0,0,0.02)',
            font: '12px system-ui, sans-serif',
          }}
        >
          <OwnedDataErrorText error={ownedError} />
        </div>
      )}

      {/* Panels overlay: draggable dividers. Pointer-transparent except separators,
          so pan / hover fall through to the Deck canvas underneath. Sits ABOVE the
          content overlay (z2 > z1) so a divider drag wins over a chart cell. */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}>
        <PaneTree node={layout} keyPrefix="root" onLayout={measure} registerPane={registerPane} paneTestId={id => resolvePaneTestId(cellMap, id)} />
      </div>

      {/* (SPLIT A / SPLIT B: BOTH tooltip families now render from a child — the CROSS-PLOT ones from
          `GridDeckLayer` beside the deck div, the MAIN hover one from `GridOverlayLayer` above. Both
          are still direct children of THIS positioned container — `VizTooltip`'s viewport clamp
          measures its `offsetParent`, so the clamp is unchanged — and both still paint at
          `zIndex: 20`.) */}
      </div>
      {/* SPLIT C (ITEM-17) — THE DOCK LAYER. Every per-pane editing surface (edit form, plot-data
          table, annotate controls, mask review) plus the export dialog, each portaled into the host
          container ITS OWN resolver returns for that pane or stacked in the internal right panel.
          Mounted UNCONDITIONALLY (the `isPrimaryContainer` PROP gates what it renders) because it owns
          `exportTarget`: a conditional mount would drop an open export dialog and leave `dockApiRef`
          stale. A SIBLING of the container div, exactly where the portals + panel used to sit, so the
          outer flex row's layout is unchanged. */}
      <GridDockLayer
        isPrimaryContainer={containerId === PRIMARY_CONTAINER}
        apiRef={dockApiRef}
        containerRef={containerRef}
        editFormContainer={editFormContainer}
        exportDialogContainer={exportDialogContainer}
        dataTableContainer={dataTableContainer}
        annotateControlsContainer={annotateControlsContainer}
        maskControlsContainer={maskControlsContainer}
        cells={cells}
        cellMap={cellMap}
        denseCells={denseCells}
        denseIds={denseIds}
        rects={rects}
        insetPane={insetPane}
        legendGutterFor={legendGutterFor}
        cellToolbarsOn={cellToolbarsOn}
        radius={radius}
        cellData={cellData}
        chartContribs={chartContribs}
        closeEditCell={closeEditCell}
        legendForCell={legendForCell}
        perCellLegend={perCellLegend}
        valueLegends={valueLegends}
        perCellHiddenCodes={perCellHiddenCodes}
        perCellRange={perCellRange}
        perCellColors={perCellColors}
        setCellRange={setCellRange}
        imagePyramids={imagePyramids}
        setImageChannel={setImageChannel}
        setImageColormap={setImageColormap}
        autoContrastChannel={autoContrastChannel}
        closeDataTable={closeDataTable}
        publishChartHover={publishChartHover}
        perCellColorData={perCellColorData}
        perCellPlotRows={perCellPlotRows}
        colorOverrides={colorOverrides}
        cameraEpoch={cameraEpoch}
        annotateMode={annotateMode}
        annotateCellIds={annotateCellIds}
        annotateStoreFor={annotateStoreFor}
        boundAnnotateCellId={boundAnnotateCellId}
        closeAnnotateCell={closeAnnotateCell}
        annotateEditor={annotateEditor}
        onAnnotateExportSeeds={onAnnotateExportSeeds}
        segmentMode={segmentMode}
        segmentCellIds={segmentCellIds}
        patchMaskReview={patchMaskReview}
        closeSegmentCell={closeSegmentCell}
        ensureMaskSession={ensureMaskSession}
        resolvedLabelMask={resolvedLabelMask}
        sharedSessionForCell={sharedSessionForCell}
        cellLinkGroup={cellLinkGroup}
        linkGroups={linkGroups}
        maskShareNotice={maskShareNotice}
        shareMaskAcrossGroup={shareMaskAcrossGroup}
        detachSharedMask={detachSharedMask}
        applyDisplayToGroup={applyDisplayToGroup}
        bumpMask={bumpMask}
      />
    </div>
  )
  // ITEM-13: the primary instance owns + provides the workspace authoring store to the whole subtree
  // (recursive `<GridWorkspace containerId>` children inherit it via context); a child renders bare.
  // SPLIT 0a: the seam wraps the whole subtree so every future layer (and a nested popup-container
  // `GridWorkspace`, which re-provides its OWN seam) resolves the stable identities of the workspace
  // it actually belongs to. The provider is a pure addition: the value identity is `[stores,
  // coordination]`-stable, so it schedules no consumer re-render.
  return <GridWorkspaceSeamProvider value={seam}>{gridRoot}</GridWorkspaceSeamProvider>
}

// SPLIT C (ITEM-17): `EMPTY_HIDDEN` / `hiddenGroupSet` / `filterLegendEntries` moved to `gridModel.ts`
// — the dock layer's edit-form + export builders and the in-cell legend loop both read them, and
// neither layer may import the other's private module (INV-10 (d)). SPLIT D (ITEM-15) then took the
// legend loop itself into `GridPaneLayer.tsx`, so both readers are now layers and the shared home in
// `gridModel.ts` is what keeps the layer graph acyclic. `linkPickBtnStyle` moved with the
// link-picking overlay it styles, which is this shell's only remaining mention of either.

