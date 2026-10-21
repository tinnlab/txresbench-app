// GridPaneLayer.tsx — SPLIT D (ITEM-15, DEC-18 / DEC-20 / DEC-21).
//
// THE PANE CHROME LIVES HERE: one `<CellView>` per measured leaf rect, the in-cell WYSIWYG legend
// overlay, the plot-title overlay, and the link-picking / link-manage affordances that sit on a pane.
//
// ── Why this split is taken LAST of the four ─────────────────────────────────────────────────────
// `CellView` is the widest prop boundary in the file (25 props), and every earlier split shrank the
// surface this one has to carry: Split A took the camera out of the shell (so the chrome is no
// longer rebuilt per frame at all), Split B took the drafts and the hover, Split C took the docks,
// and Split 0b (ITEM-21) moved the per-cell DISPLAY cluster into `CellDisplay.store.ts`. What is
// left to move here is therefore a render, not a state cluster — plus the five dock states DRIFT-20
// recorded as this split's inherited cargo (see `PaneDocks.store.ts`).
//
// ── The per-cell boundary, which is the actual point ─────────────────────────────────────────────
// `GridPaneCell` is the FIRST PER-CELL COMPONENT in this decomposition, and it is what finally makes
// the two per-cell stores pay off. Before it, `perCellColors[id]` / `editCellIds.has(id)` were read
// inside a `rects.map` in a 5,000-line closure — a hook cannot be called per map iteration, so every
// per-cell value had to be a whole-record read, and a change to ONE cell re-rendered the chrome of
// EVERY cell. Here each cell is its own component, so it subscribes to:
//   * `useStore(cellDisplay, selectCell(id))` — that cell's colors/legend/hidden codes (ITEM-21), and
//   * four BOOLEAN selectors on `paneDocks` — is THIS pane's edit form / data table / annotate dock /
//     mask dock open (Split D).
// Opening pane A's edit form now re-renders pane A's chrome and nothing else.
//
// ── What crosses the boundary, and in which direction ────────────────────────────────────────────
// DOWN, as explicit props: the workspace-level values the loops read — the pane rects, the enriched
// cells, the geometry callbacks (`insetPane` / `plotInset` / `legendGutterFor` / `measureLegend`),
// the legend records the legend loop iterates, and the stable action callbacks the toolbars invoke.
// THROUGH THE SEAM: `stores` / `coordination` / `cellDisplay` / `paneDocks` — store handles, so no
// per-frame value enters the context (DEC-20).
// UP: nothing. This layer publishes no handle; it is a pure consumer, which is why it is the last
// split and the least risky one to land once the other four are in.
//
// ── What did NOT move, and why (re-derived at this split, DRIFT-9's criterion) ────────────────────
// ITEM-15's written cargo also names seven "chrome measurement bindings" — `registerPane`, `measure`,
// `legendWidths` + `legendWidthsRef`, `legendGutterFor`, `plotInset`, `measureLegend`, `insetPane`.
// Not one of them is read only by this layer, so by DRIFT-9's criterion ("read ONLY by this layer",
// not "named in the move list") every one stays in the shell and crosses DOWN as a stable callback:
//   registerPane / measure   → `<PaneTree>`, which ITEM-18 assigns to the residual shell
//   insetPane                → the shell's image-framing effect, `plotInset`, the dock layer
//   plotInset                → the deck's `views` memo, `denseRectsInset`, the deck + overlay layers
//   legendGutterFor          → `plotInset`, the dock layer, this layer's gutter parts
//   legendWidths(+Ref)       → `legendGutterFor`'s only input
//   measureLegend            → writes `legendWidths`, which the deck's viewport geometry consumes
// They are the LAYOUT tree's geometry, and the layout tree is the shell's. Moving them would have
// inverted the flow — the deck's viewport would depend on a value owned by the chrome layer, pushed
// upward on every legend measurement — which is the "same component with more files" shape DEC-21
// rejects. Recorded as drift rather than silently dropped.

import React, { memo, useMemo } from 'react'
import { useStore } from 'zustand'
import type { DataSource, DatasetCatalog } from '../data/wire'
import type { ContainerId } from '@ziee/dock'
import type { DatasetEntry } from '../../adapter/DatasetStore'
import { AnnotateProvider } from '../annotate/AnnotateContext'
import type { AnnotateStore } from '../annotate/Annotate.store'
import { CellView, PANE_TOOLBAR_H } from './CellView'
import { ChartLayerSinkContext, type ChartLayerSink } from './chartLayerSink'
import { ChartSelectModeContext, ChartSelectMultiContext, type ChartSelectMode } from '../charts/chartSelectionMode'
import {
  PlotDataSinkContext,
  HoverHighlightContext,
  HoverPublishContext,
  TooltipsEnabledContext,
  ValueLegendSinkContext,
  type PlotDataSink,
  type ValueLegendSink,
} from '../charts/plotCellId'
import { gutterToParts, type PlotGutter } from './plotGutter'
import { EMPTY_HIDDEN, cellTestId, filterLegendEntries, hiddenGroupSet, paneTestId, type GridCell } from './gridModel'
import type { PaneRect } from '../layers/multiView'
import type { CoordinationHandle } from '../registry/types'
import type { VizTheme } from '../theme'
import { InCellLegend } from '../controls/InCellLegend'
import { InCellVisualMap } from '../controls/InCellVisualMap'
import { BlendLegend } from '../controls/BlendLegend'
import { resolveLegendCorner, DEFAULT_LEGEND_CORNER } from '../controls/legendRender'
import { resolveTextStyle } from '../controls/typography'
import { LINK_GROUP_COLORS } from '../../adapter/GridWorkspace.store'
import { selectCell, type CellLegend } from '../../adapter/CellDisplay.store'
import {
  selectAnnotateOpen,
  selectDataOpen,
  selectEditOpen,
  selectSegmentOpen,
} from '../../adapter/PaneDocks.store'
import { useGridWorkspaceSeam } from './GridWorkspaceContext'

export interface GridPaneLayerProps {
  // ── the seven context providers wrapping the content overlay ───────────────────────────────────
  readonly chartSelectMode: ChartSelectMode
  readonly selMulti: boolean
  readonly onCellPlotData: PlotDataSink
  readonly tooltipsEnabled: boolean
  readonly publishValueLegend: ValueLegendSink
  readonly publishChartHover: (cellId: string, index: number | null) => void
  readonly effectiveHighlight: Record<string, number | null>

  // ── geometry (owned by the shell; see the header for why) ──────────────────────────────────────
  readonly rects: readonly PaneRect[]
  readonly insetPane: (r: PaneRect) => PaneRect
  readonly plotInset: (r: PaneRect) => PaneRect
  readonly legendGutterFor: (cell: GridCell | undefined) => PlotGutter | null
  readonly measureLegend: (id: string, el: HTMLDivElement | null, beside: boolean) => void

  // ── cell inputs ────────────────────────────────────────────────────────────────────────────────
  readonly effectiveCatalog: DatasetCatalog | null
  readonly cellMap: Record<string, GridCell>
  readonly cellsForView: Record<string, GridCell>
  readonly cellCount: number
  readonly denseIds: ReadonlySet<string>
  readonly chartDeckIds: ReadonlySet<string>
  readonly chartSink: ChartLayerSink
  readonly datasetEntries: Record<string, DatasetEntry | undefined>
  readonly source: DataSource
  readonly positions: Float32Array
  readonly colors: Uint8Array
  readonly colorEpoch: number
  readonly ensureAnnotateStore: (cellId: string) => AnnotateStore

  // ── pane-toolbar actions (every one `[]`-stable, so `memo(GridPaneCell)` is not defeated) ───────
  readonly onExportCell: (cellId: string) => void
  readonly onEditCell: (cellId: string) => void
  readonly onShowData: (cellId: string) => void
  readonly annotateCellIds: readonly string[]
  readonly onAnnotateCell: (cellId: string) => void
  readonly segmentCellIds: readonly string[]
  readonly maskReady: ReadonlySet<string>
  readonly onSegmentCell: (cellId: string) => void
  readonly onToggleLink: (cellId: string) => void
  readonly cellToolbarsOn: boolean
  readonly containerId?: ContainerId

  // ── link filtering (the pick overlay + the manage popover) ─────────────────────────────────────
  readonly linkColorFor: (cellId: string) => string | undefined
  readonly linkPicking: { groupId: string } | null
  readonly linkAnchorDataset: { active: boolean; dataset: string | undefined }
  readonly linkGroups: Record<string, string[]>
  readonly linkColorIdx: Record<string, number>
  readonly cellLinkGroup: Record<string, string>
  readonly linkPopoverCell: string | null
  readonly setLinkPopoverCell: (id: string | null) => void

  // ── the in-cell legend loop ────────────────────────────────────────────────────────────────────
  readonly legendForCell: (id: string) => CellLegend | undefined
  readonly perCellLegend: Record<string, CellLegend>
  readonly valueLegends: Record<string, CellLegend>
  readonly perCellHiddenCodes: Record<string, ReadonlySet<number>>
  readonly perCellRange: Record<string, readonly [number, number]>
  readonly setCellRange: (cellId: string, range: readonly [number, number]) => void

  readonly vizTheme: VizTheme
}

function GridPaneLayerImpl({
  chartSelectMode,
  selMulti,
  onCellPlotData,
  tooltipsEnabled,
  publishValueLegend,
  publishChartHover,
  effectiveHighlight,
  rects,
  insetPane,
  plotInset,
  legendGutterFor,
  measureLegend,
  effectiveCatalog,
  cellMap,
  cellsForView,
  cellCount,
  denseIds,
  chartDeckIds,
  chartSink,
  datasetEntries,
  source,
  positions,
  colors,
  colorEpoch,
  ensureAnnotateStore,
  onExportCell,
  onEditCell,
  onShowData,
  annotateCellIds,
  onAnnotateCell,
  segmentCellIds,
  maskReady,
  onSegmentCell,
  onToggleLink,
  cellToolbarsOn,
  containerId,
  linkColorFor,
  linkPicking,
  linkAnchorDataset,
  linkGroups,
  linkColorIdx,
  cellLinkGroup,
  linkPopoverCell,
  setLinkPopoverCell,
  legendForCell,
  perCellLegend,
  valueLegends,
  perCellHiddenCodes,
  perCellRange,
  setCellRange,
  vizTheme,
}: GridPaneLayerProps) {
  const { stores, coordination, cellDisplay } = useGridWorkspaceSeam()

  return (
    <>
      {/* Content overlay (Phase C1): one <CellView> per measured leaf rect. Dense
          cells render a pointer-transparent placeholder (deck shows through); chart
          cells host their own ChartCanvas. Pointer-transparent container — each cell
          sets its own pointerEvents. Sits ABOVE the select overlay (z3) so the pane TOOLBARS (which
          re-arm pointerEvents:auto) stay clickable in SELECT mode, while a dense cell's transparent
          plot body (pointerEvents:none) lets the marquee/lasso press fall THROUGH to the overlay. */}
      <ChartSelectModeContext.Provider value={chartSelectMode}>
      <ChartSelectMultiContext.Provider value={selMulti}>
      <PlotDataSinkContext.Provider value={onCellPlotData}>
      <TooltipsEnabledContext.Provider value={tooltipsEnabled}>
      <ValueLegendSinkContext.Provider value={publishValueLegend}>
      <HoverPublishContext.Provider value={publishChartHover}>
      <HoverHighlightContext.Provider value={effectiveHighlight}>
      <div style={{ position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none' }}>
        {effectiveCatalog &&
          rects.map(r => {
          // Use the memoized enriched cell (dense cells pass through unchanged; grouped cells carry a
          // STABLE `groupOverrides` from the colorOverride store, so the adapter recolors/renames live
          // without a per-render ref churn).
          const cell = cellsForView[r.id]
          if (!cell) return null
          // A migrated chart cell renders as a VIEW in the shared deck: provide the sink so its
          // ChartCanvas publishes (no own deck) + tell CellView to pass pointer events THROUGH to the
          // deck (like a dense cell) so the shared per-view controller drives its pan/zoom.
          const onSharedDeck = chartDeckIds.has(cell.id)
          // MULTI-DATASOURCE (ITEM-12): a cell reads ITS dataset's source/catalog/buffers — a chart
          // cell (own canvas) fetches its tables from THAT source, and a dense cell's chrome (color-by
          // picker) + popped-out standalone render use its buffers. A default/sole-dataset cell uses the
          // workspace values (byte-identical).
          const cellEntry = cell.datasetId ? datasetEntries[cell.datasetId] : undefined
          // MULTI-DATASOURCE (ITEM-24): a cell whose dataset is still resolving / failed shows a
          // per-cell overlay at its rect (not a blank/crash).
          const dsStatus = cell.datasetId ? datasetEntries[cell.datasetId]?.status : 'ready'
          return (
            <div key={r.id}>
              {/* SPLIT D: the per-cell component. Everything a pane's chrome needs that is
                  PER-CELL is subscribed inside it, not read out of a whole-workspace record here —
                  which is what makes `memo(GridPaneCell)` a real boundary. */}
              <GridPaneCell
                cell={cell}
                rect={r}
                source={cellEntry?.source ?? source}
                catalog={cellEntry?.catalog ?? effectiveCatalog}
                positions={cellEntry?.positionsByLayout[cell.layoutId] ?? positions}
                colors={cellEntry?.colors ?? colors}
                colorEpoch={cellEntry ? cellEntry.epoch : colorEpoch}
                sharedDeckChart={onSharedDeck}
                // FLATTENED to two primitives (ITEM-1 / DEC-7): `legendGutterFor` returns a fresh
                // object literal per call, so an object-valued prop here changed identity on every
                // render and was the ONE thing making `memo(CellView)` inert.
                {...gutterToParts(legendGutterFor(cell))}
                coordination={coordination}
                chartSink={onSharedDeck ? chartSink : null}
                // ITEM-3: an `annotate` cell's subtree is scoped to its OWN per-cell `AnnotateStore`
                // (the SAME instance the shared-deck overlay reads) so a future tool rail / class
                // panel drive that cell's edit state; non-annotated cells render exactly as before
                // (no provider, no store).
                annotateStore={cell.annotate && denseIds.has(cell.id) ? ensureAnnotateStore(cell.id) : null}
                onExportCell={onExportCell}
                onEditCell={onEditCell}
                onShowData={onShowData}
                // Per-pane Annotate / Segment (finding #14) — the SAME capability predicates the
                // dock resolvers use, so a pane offers the button exactly when it can hold the dock.
                onAnnotateCell={annotateCellIds.includes(cell.id) ? onAnnotateCell : undefined}
                // BLIND-AUDIT M10 — the button used to appear on the `segment` FLAG alone, but the
                // dock body renders only once the mask has RESOLVED (`session && data`), so a
                // flagged-but-unresolved pane opened an empty panel. Offer it only when the dock
                // would actually have content.
                onSegmentCell={
                  segmentCellIds.includes(cell.id) && maskReady.has(cell.id) ? onSegmentCell : undefined
                }
                // Link FILTERING only makes sense across panes — hide the button when the grid has a
                // single cell (nothing to link to).
                onToggleLink={cellCount > 1 ? onToggleLink : undefined}
                linkColor={linkColorFor(cell.id)}
                linkActive={linkPicking != null}
                showToolbar={cellToolbarsOn}
                containerId={containerId}
              />
              {/* The plot-data table is DOCKED in the right panel (portaled/stacked, several at once),
                  not overlaid on the pane — see the dock layer. */}
              {cell.datasetId && dsStatus !== 'ready' && (
                <div
                  data-testid={`viz-cell-dataset-${dsStatus === 'error' ? 'error' : 'loading'}-${cellTestId(cell)}`}
                  // A load failure is announced assertively (alert); a still-loading state is polite (status).
                  role={dsStatus === 'error' ? 'alert' : 'status'}
                  style={{
                    position: 'absolute',
                    left: r.x,
                    top: r.y,
                    width: r.width,
                    height: r.height,
                    display: 'grid',
                    placeItems: 'center',
                    pointerEvents: 'none',
                    background: 'rgba(0,0,0,0.03)',
                    font: '12px system-ui, sans-serif',
                    color: dsStatus === 'error' ? 'rgba(180,40,40,0.9)' : 'rgba(0,0,0,0.55)',
                  }}
                >
                  {dsStatus === 'error' ? `Failed to load dataset ${cell.datasetId}` : 'Loading dataset…'}
                </div>
              )}
              {/* LINK FILTERING — the group color lives on the toolbar link button's bottom accent (see
                  PaneToolbar); no pane border. */}
              {/* LINK FILTERING — the "Link / Link and Finish" picking overlay on every ELIGIBLE pane
                  (same dataset) that isn't already in the forming group. */}
              {linkAnchorDataset.active &&
                (cell.datasetId ?? '') === (linkAnchorDataset.dataset ?? '') &&
                !(linkGroups[linkPicking!.groupId] ?? []).includes(cell.id) && (
                  <div
                    data-testid={`viz-cell-link-pick-${cellTestId(cell)}`}
                    style={{
                      position: 'absolute',
                      left: r.x,
                      top: r.y,
                      width: r.width,
                      height: r.height,
                      pointerEvents: 'auto',
                      zIndex: 6,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      background: `${LINK_GROUP_COLORS[linkColorIdx[linkPicking!.groupId] ?? 0]}22`,
                    }}
                  >
                    <button
                      type="button"
                      data-testid={`viz-cell-link-add-${cellTestId(cell)}`}
                      onClick={() => stores.gridWorkspace.getState().addCellToLinkGroup(cell.id)}
                      style={linkPickBtnStyle(vizTheme, LINK_GROUP_COLORS[linkColorIdx[linkPicking!.groupId] ?? 0])}
                    >
                      Link
                    </button>
                    <button
                      type="button"
                      data-testid={`viz-cell-link-finish-${cellTestId(cell)}`}
                      onClick={() => {
                        stores.gridWorkspace.getState().addCellToLinkGroup(cell.id)
                        stores.gridWorkspace.getState().finishLinkPicking()
                      }}
                      style={linkPickBtnStyle(vizTheme, LINK_GROUP_COLORS[linkColorIdx[linkPicking!.groupId] ?? 0])}
                    >
                      Link and Finish
                    </button>
                  </div>
                )}
              {/* LINK FILTERING — the manage POPOVER for a linked pane (members + remove + unlink). */}
              {linkPopoverCell === cell.id && cellLinkGroup[cell.id] !== undefined && (
                <div
                  data-testid={`viz-cell-link-popover-${cellTestId(cell)}`}
                  style={{
                    position: 'absolute',
                    left: r.x + Math.max(0, r.width - 220),
                    top: r.y + PANE_TOOLBAR_H,
                    width: 210,
                    pointerEvents: 'auto',
                    zIndex: 7,
                    background: vizTheme.surface,
                    color: vizTheme.fg,
                    border: `1px solid ${vizTheme.border}`,
                    borderRadius: 6,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
                    padding: 6,
                    fontSize: 12,
                  }}
                >
                  <div style={{ padding: '2px 4px 6px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: linkColorFor(cell.id) }} />
                    Filter-linked plots
                  </div>
                  {(linkGroups[cellLinkGroup[cell.id]] ?? []).map(memberId => {
                    // One string serves as BOTH the accessible name and the hover text.
                    const removeLabel = `Remove ${paneTestId(cellMap, memberId)} from filter link`
                    return (
                      <div key={memberId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 4px' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cellMap[memberId]?.title || cellMap[memberId]?.kind || memberId}
                        </span>
                        <button
                          type="button"
                          aria-label={removeLabel}
                          title={removeLabel}
                          data-testid={`viz-cell-link-remove-${paneTestId(cellMap, memberId)}`}
                          onClick={() => {
                            stores.gridWorkspace.getState().removeCellFromLinkGroup(memberId)
                            if (memberId === cell.id) setLinkPopoverCell(null)
                          }}
                          style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: vizTheme.fg, opacity: 0.7, padding: '0 4px' }}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                  <button
                    type="button"
                    data-testid={`viz-cell-link-unlink-${cellTestId(cell)}`}
                    onClick={() => {
                      stores.gridWorkspace.getState().unlinkGroup(cellLinkGroup[cell.id])
                      setLinkPopoverCell(null)
                    }}
                    style={{ marginTop: 4, width: '100%', cursor: 'pointer', border: `1px solid ${vizTheme.border}`, borderRadius: 4, background: 'transparent', color: vizTheme.fg, padding: '4px 0' }}
                  >
                    Unlink group
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      </HoverHighlightContext.Provider>
      </HoverPublishContext.Provider>
      </ValueLegendSinkContext.Provider>
      </TooltipsEnabledContext.Provider>
      </PlotDataSinkContext.Provider>
      </ChartSelectMultiContext.Provider>
      </ChartSelectModeContext.Provider>

      {/* WYSIWYG legend (shell redesign): the legend per dense colorBy cell, in the plot area's TOP-LEFT
          (below the toolbar). NO box — "what you see is what you export". EDITING (recolor / rename /
          colormap / titles) lives ONLY in the per-pane EDIT FORM; but the legend stays LIVE-INTERACTIVE
          for the two non-edit INTERACTIONS: categorical ⇒ click a swatch to show/hide that category;
          continuous ⇒ drag the visual-map to filter the value range. Both write the SAME shared state
          (`hiddenCodes` in the per-cell display store / `perCellRange`) the edit form reads+writes, so
          plot↔form sync is automatic in both directions. Blend ⇒ the 2D legend (display-only). */}
      {rects.map(r => {
        // ALL cell types with a legend: dense cells carry `perCellLegend` (interactive); grouped charts
        // (box/violin/bar/dotplot/heatmap) carry `perCellGroupLegend` (display-only). Shown by default;
        // hidden when the cell's `showLegend` toggle is off.
        const legend = legendForCell(r.id)
        if (!legend) return null
        if (!(cellMap[r.id]?.showLegend ?? true)) return null
        // BOTH dense and grouped CATEGORICAL legends are interactive — a swatch click hides/shows the
        // category (scatter, via colorBy.hidden) or group (grouped, via cell.hiddenGroups → collapse).
        const isDense = !!perCellLegend[r.id]
        // A matrix chart's VALUE colorbar (published, no per-point `values`) is DISPLAY-ONLY — there's no
        // value-range filter to drag, unlike a dense scatter's visual-map.
        const isValueColorbar = !isDense && !!valueLegends[r.id]
        const d = legend.descriptor
        const interactive = d.kind === 'categorical' // continuous visual-map handles its own drag; blend is display-only
        const ir = insetPane(r) // position below the pane toolbar
        // Show/hide live on the plot (interaction, NOT editing). Dense: the shared hidden-set + colorBy.hidden.
        // Grouped: cell.hiddenGroups (shared with the edit form) → the chart collapses that group.
        const onHiddenChange = (codes: ReadonlySet<number>) => {
          const next = new Set(codes)
          if (isDense) {
            cellDisplay.getState().setHiddenCodes(r.id, next)
            const cb = cellMap[r.id]?.colorBy
            if (cb) stores.gridWorkspace.getState().setCellColorBy(r.id, { ...cb, hidden: next })
          } else {
            stores.gridWorkspace.getState().setCellHiddenGroups(r.id, [...next])
          }
        }
        // Live legend title: the cell's edited legendTitle wins over the built (column-name) default, so a
        // title edit updates on-screen immediately without waiting for the async legend rebuild.
        const legendTitle = cellMap[r.id]?.legendTitle || legend.title
        // Typography-driven legend font (family + size); title runs one px larger than the labels.
        const legStyle = resolveTextStyle(cellMap[r.id]?.typography, 'legend')
        const legendFont = { titleSize: legStyle.size + 1, labelSize: legStyle.size, family: legStyle.family }
        // Grouped charts (box/violin/bar/…) render a vertical value-zoom SLIDER in a ~20px gutter on the
        // RIGHT edge; inset a right-aligned overlay legend past it so the two never overlap. Dense scatter
        // cells pan/zoom via the deck controller (no rail) ⇒ no gutter.
        const legendRightGutter = isDense ? 0 : 22
        // LEGEND PLACEMENT (edit-form control): which CORNER, and OVERLAY vs BESIDE. `swatchSide` mirrors
        // the legend so its labels face INTO the plot. `beside` ⇒ the deck view already shrank (plotInset),
        // so the legend sits in the freed gutter; else it floats at the corner over the plot.
        const corner = cellMap[r.id]?.legendCorner ?? DEFAULT_LEGEND_CORNER
        const { hSide, vSide, swatchSide } = resolveLegendCorner(corner)
        const beside = !!legendGutterFor(cellMap[r.id])
        const plot = plotInset(r)
        const PAD = 8
        // The wrapper region: the gutter strip (beside) or the plot area (overlay).
        const region = beside
          ? hSide === 'left'
            ? { x: ir.x + PAD, y: ir.y + PAD, w: Math.max(0, plot.x - ir.x - PAD), h: Math.max(20, ir.height - PAD * 2) }
            : { x: plot.x + plot.width, y: ir.y + PAD, w: Math.max(0, ir.x + ir.width - (plot.x + plot.width) - PAD), h: Math.max(20, ir.height - PAD * 2) }
          : { x: plot.x + PAD, y: plot.y + PAD, w: Math.max(0, plot.width - PAD * 2 - (hSide === 'right' ? legendRightGutter : 0)), h: Math.max(20, plot.height - PAD * 2) }
        return (
          <div
            key={`cell-legend-${r.id}`}
            data-testid={`viz-cell-legend-${paneTestId(cellMap, r.id)}`}
            ref={el => measureLegend(r.id, el, beside)}
            // Positioned by the cell's legend corner + mode: the wrapper pins its content to the corner's
            // horizontal (justify) + vertical (align) edges, inside the gutter (beside) or plot (overlay).
            style={{ position: 'absolute', left: region.x, top: region.y, width: region.w, height: region.h, zIndex: 2, pointerEvents: 'none', display: 'flex', justifyContent: hSide === 'left' ? 'flex-start' : 'flex-end', alignItems: vSide === 'top' ? 'flex-start' : 'flex-end', overflow: 'hidden' }}
          >
            {d.kind === 'blend' ? (
              <BlendLegend legend={d} title={legendTitle} family={legendFont.family} theme={vizTheme} />
            ) : d.kind === 'continuous' ? (
              // pointerEvents:auto so the visual-map handles capture drags; the rest of the pane still pans.
              // `legendUseRange` ⇒ render the visual-map with the CUSTOM range AS the full domain (gradient
              // spans the range, handles at the ends, no in-band outline) so a custom range looks native.
              (() => {
                const vmRange = perCellRange[r.id]
                const useRange = (cellMap[r.id]?.legendUseRange ?? false) && !!vmRange
                const vmDomain = useRange ? (vmRange as [number, number]) : (legend.domain ?? d.domain)
                return (
              <span style={{ display: 'inline-block', pointerEvents: isValueColorbar ? 'none' : 'auto' }}>
                <InCellVisualMap
                  min={vmDomain[0]}
                  max={vmDomain[1]}
                  colormap={legend.colormap ?? d.colormap}
                  value={useRange ? vmDomain : (perCellRange[r.id] ?? (legend.domain ?? d.domain))}
                  onChange={isValueColorbar ? () => {} : range => setCellRange(r.id, range)}
                  height={Math.min(160, Math.max(80, ir.height - 40))}
                  family={legendFont.family}
                  side={swatchSide}
                  theme={vizTheme}
                  data-testid={`viz-cell-visualmap-${paneTestId(cellMap, r.id)}`}
                />
              </span>
                )
              })()
            ) : (
              // Categorical legend (dense OR grouped): pointerEvents:auto so a swatch click toggles the
              // category/group visibility. `hidden` = the dense colorBy set or the grouped hiddenGroups.
              <span style={{ display: 'inline-block', pointerEvents: interactive ? 'auto' : 'none' }}>
                <InCellLegend
                  // Drop LEGEND-hidden codes from the LIST (their points still render) — an eye toggle in
                  // the edit form controls this, distinct from the enable/disable (hiddenGroups) toggle.
                  entries={filterLegendEntries(d.entries, cellMap[r.id]?.legendHiddenCodes)}
                  hidden={(isDense ? perCellHiddenCodes[r.id] : hiddenGroupSet(cellMap[r.id]?.hiddenGroups)) ?? EMPTY_HIDDEN}
                  onChange={interactive ? onHiddenChange : () => {}}
                  title={legendTitle}
                  font={legendFont}
                  swatchSide={swatchSide}
                  theme={vizTheme}
                  // The LEGEND leg of a per-cell provenance marker. It is the load-bearing one:
                  // a screenshot crops the chrome badge and keeps the legend.
                  note={cellMap[r.id]?.provenanceNote}
                />
              </span>
            )}
          </div>
        )
      })}

      {/* WYSIWYG plot title (shell redesign): a DISPLAY-ONLY header centered at the TOP of each cell's
          plot area (below the toolbar). Not editable inline — the title is edited in the per-pane form.
          Only rendered when a title is set ("what you see is what you export").

          Directly under it, the cell's PROVENANCE NOTE — the plot-CHROME leg of a per-cell marker.
          It is drawn here rather than as a toolbar action deliberately: the toolbar folds its
          low-rank items into an overflow popover at narrow widths, and a marker that can be folded
          out of sight is a marker seen only at the moment of choosing. This one is always beside the
          picture for as long as the picture is open. The block renders for a note even when the cell
          has no title, so a marked cell is never silently unmarked by the absence of one. */}
      {rects.map(r => {
        const cell = cellMap[r.id]
        const title = cell?.title
        const note = cell?.provenanceNote
        if (!title && !note) return null
        const ir = insetPane(r)
        const ts = resolveTextStyle(cell?.typography, 'title')
        return (
          <div
            key={`cell-title-${r.id}`}
            style={{ position: 'absolute', left: ir.x, top: ir.y + 4, width: ir.width, zIndex: 2, pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            {title ? (
              <span
                data-testid={`viz-cell-title-${paneTestId(cellMap, r.id)}`}
                className="max-w-full truncate text-foreground"
                style={{ fontFamily: ts.family, fontSize: ts.size, fontWeight: ts.weight === 'bold' ? 700 : 400 }}
              >
                {title}
              </span>
            ) : null}
            {note ? (
              <span
                data-testid={`viz-cell-note-${paneTestId(cellMap, r.id)}`}
                // The same marker attribute the LEGEND leg carries. A host that stamps a
                // provenance note needs both of its surfaces addressable by ONE name — the
                // invariant is that the mark is on the chrome AND the legend at the same time,
                // and a reader that has to know two different spellings to check that is one
                // rename away from checking neither.
                data-provenance-note={note}
                title={note}
                className="max-w-full truncate text-muted-foreground"
                style={{ fontFamily: ts.family, fontSize: Math.max(9, ts.size - 3) }}
              >
                {note}
              </span>
            ) : null}
          </div>
        )
      })}
    </>
  )
}

/** SPLIT D: the pane-chrome layer. `memo`'d like its three siblings — a shell render that changes
 *  none of the chrome inputs (the overwhelmingly common case now that the camera, the drafts, the
 *  hover and the docks all live elsewhere) must not rebuild 4–8 `<CellView>` subtrees. */
export const GridPaneLayer = memo(GridPaneLayerImpl)
GridPaneLayer.displayName = 'GridPaneLayer'

// ── the per-cell component ───────────────────────────────────────────────────────────────────────

interface GridPaneCellProps {
  readonly cell: GridCell
  readonly rect: PaneRect
  readonly source: DataSource
  readonly catalog: DatasetCatalog
  readonly positions: Float32Array
  readonly colors: Uint8Array
  readonly colorEpoch: number
  readonly sharedDeckChart: boolean
  readonly plotGutterW?: number
  readonly plotGutterSide?: 'left' | 'right'
  readonly coordination: CoordinationHandle
  readonly chartSink: ChartLayerSink | null
  readonly annotateStore: AnnotateStore | null
  readonly onExportCell: (cellId: string) => void
  readonly onEditCell: (cellId: string) => void
  readonly onShowData: (cellId: string) => void
  readonly onAnnotateCell?: (cellId: string) => void
  readonly onSegmentCell?: (cellId: string) => void
  readonly onToggleLink?: (cellId: string) => void
  readonly linkColor?: string
  readonly linkActive: boolean
  readonly showToolbar: boolean
  readonly containerId?: ContainerId
}

/**
 * ONE pane's chrome. The unit of per-cell subscription in this decomposition.
 *
 * Everything per-cell is read HERE, through a selector scoped to this cell id, rather than out of a
 * whole-workspace record in the parent's `rects.map`:
 *   * `selectCell(id)` on the ITEM-21 display store — this cell's colorBy buffer + epoch.
 *   * four BOOLEAN selectors on the Split-D dock store — is THIS pane's edit form / data table /
 *     annotate dock / mask dock open.
 * Both stores are reached through the seam, so nothing per-frame crosses a context (DEC-20).
 *
 * `memo` matters here in a way it did not in the parent: the parent re-renders whenever any legend
 * record, link map or geometry callback changes, and without this boundary each of those would
 * rebuild every `<CellView>` in the grid.
 */
function GridPaneCellImpl({
  cell,
  rect,
  source,
  catalog,
  positions,
  colors,
  colorEpoch,
  sharedDeckChart,
  plotGutterW,
  plotGutterSide,
  coordination,
  chartSink,
  annotateStore,
  onExportCell,
  onEditCell,
  onShowData,
  onAnnotateCell,
  onSegmentCell,
  onToggleLink,
  linkColor,
  linkActive,
  showToolbar,
  containerId,
}: GridPaneCellProps) {
  const { cellDisplay, paneDocks } = useGridWorkspaceSeam()
  const id = cell.id

  // The ITEM-21 per-cell display slice. `selectCell` memoizes its own result against the seven
  // source records, so this subscription is woken by a write to THIS cell and by nothing else — the
  // selector instance must therefore be stable for the subscription's life (its caller contract).
  const displaySel = useMemo(() => selectCell(id), [id])
  const display = useStore(cellDisplay, displaySel)

  // The four dock flags, each a BOOLEAN scoped to this pane. Opening pane B's edit form leaves this
  // subscription's value unchanged, so pane A's chrome is not re-rendered — which is the whole
  // reason the open sets became a store at this split (`PaneDocks.store.ts`).
  const editOpen = useStore(paneDocks, useMemo(() => selectEditOpen(id), [id]))
  const dataOpen = useStore(paneDocks, useMemo(() => selectDataOpen(id), [id]))
  const annotateOpen = useStore(paneDocks, useMemo(() => selectAnnotateOpen(id), [id]))
  const segmentOpen = useStore(paneDocks, useMemo(() => selectSegmentOpen(id), [id]))

  const body = (
    <ChartLayerSinkContext.Provider value={chartSink}>
      <CellView
        cell={cell}
        rect={rect}
        source={source}
        catalog={catalog}
        positions={positions}
        colors={colors}
        colorEpoch={colorEpoch}
        sharedDeckChart={sharedDeckChart}
        plotGutterW={plotGutterW}
        plotGutterSide={plotGutterSide}
        // The cell's own per-cell colorBy buffer (when it declares a colorBy), so a popped-out
        // dense cell recolors in the popup exactly like the in-grid shared deck. MD-9: a
        // multi-dataset cell's colorBy (computed from ITS dataset source) is consumed here too.
        cellColors={display.colors?.colors}
        cellColorEpoch={display.colors?.epoch}
        coordination={coordination}
        onExportCell={onExportCell}
        onEditCell={onEditCell}
        onShowData={onShowData}
        dataOpen={dataOpen}
        editOpen={editOpen}
        onAnnotateCell={onAnnotateCell}
        annotateOpen={annotateOpen}
        onSegmentCell={onSegmentCell}
        segmentOpen={segmentOpen}
        onToggleLink={onToggleLink}
        linkColor={linkColor}
        linkActive={linkActive}
        showToolbar={showToolbar}
        containerId={containerId}
      />
    </ChartLayerSinkContext.Provider>
  )
  return annotateStore ? <AnnotateProvider store={annotateStore}>{body}</AnnotateProvider> : body
}

const GridPaneCell = memo(GridPaneCellImpl)
GridPaneCell.displayName = 'GridPaneCell'

/** Style for the "Link" / "Link and Finish" buttons on the link-picking overlay (group-color filled). */
function linkPickBtnStyle(theme: { surface: string }, color: string): React.CSSProperties {
  return {
    cursor: 'pointer',
    border: 'none',
    borderRadius: 6,
    background: color,
    color: theme.surface,
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    minWidth: 130,
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  }
}
