// plotCellId.ts — the STABLE per-cell plot-interaction identity threaded from the grid to each
// chart cell's DataZoom (ITEM-20 / DEC-16 — "fix the inherited no-op").
//
// THE NO-OP THIS FIXES: `PlotInteraction.store` (dataZoom windows + continuous filters) is keyed by
// a stable per-plot id, and its `serialize()`/`hydrate()` are the ONE round-trip source for a
// restored `VizOption.dataZoom[].window` / `filters`. But the PRODUCTION grid's chart cells hosted
// their DataZoom with only a STATIC `testId` (`"viz-bar-value-zoom"`, shared by every bar cell) and
// NO `dataZoomId`, so `useDataZoomWindowState` fell into its pure-local-`useState` branch: the cell
// was never connected to the store, and a restored window/filter applied to NOTHING (a true no-op —
// see the scope caveat in `adapter/sessionState.ts`).
//
// THE FIX (WITHOUT touching the store, the adapter, or the DataZoom component): `CellView.ChartBody`
// publishes each chart cell's stable id (its `GridCell.id` = the region/coord id) through THIS React
// context; every dataZoom-hosting View (`Bar`/`Box`/`Violin`/`Heatmap`/`Dotplot`) READS it and hands
// it to its `ValueDataZoom` / `DataZoomMatrix` as `dataZoomId`. The context flows THROUGH the
// registry adapter (which renders the View as a child of the provider) with no adapter change, so the
// per-cell id reaches the View even though the adapter strips `model.cell`. When a View is rendered
// OUTSIDE a grid cell (a showcase story with no provider) the context default is `undefined` ⇒ the
// View passes no `dataZoomId` ⇒ the byte-identical local-`useState` branch (default unchanged).
//
// WHY the id == the coord id: `VizController.getOption`/`setOption` round-trip dataZoom windows keyed
// by the dataZoom instance's `id`, whose `coordId` references the cell (`= GridCell.id`). Keying the
// cell's DataZoom by its own id is therefore what lets a restored option's window reach exactly the
// cell it was captured from. The two store maps (`dataZoomWindows` / `filters`) are independent, so
// one id safely serves both a cell's zoom window and its filter.
//
// viz-core rule: react only (no @txresbench/*, no deck) — so a chart View importing this stays a leaf.

import { createContext, useCallback, useContext, useEffect } from 'react'
import type { ContinuousColormap } from '../data/color'

/**
 * The STABLE plot-interaction id for the cell currently rendering, or `undefined` when a View
 * renders outside a grid cell (no provider → the byte-identical local-state default). Provided
 * ONCE by `CellView.ChartBody`; consumed by each dataZoom-hosting View via `useContext`.
 */
export const PlotCellIdContext = createContext<string | undefined>(undefined)

/**
 * Derive a cell's stable plot-interaction id from its `GridCell.id`. Identity by design (the id MUST
 * equal the coord id so a restored `VizOption` window/filter round-trips to the right cell — see the
 * file header), with an empty/absent guard that collapses to `undefined` so a cell with no id keeps
 * the local-`useState` DataZoom branch (byte-identical). Pure — node-testable without React.
 */
export function cellPlotId(cellId: string | undefined): string | undefined {
  return cellId != null && cellId !== '' ? cellId : undefined
}

/** Plot-data table sink (per-cell): a grouped/matrix chart View publishes the ROWS it plots so the
 *  pane's "Plot data" table can render them for every plot type. Flows through the registry adapter
 *  WITHOUT an adapter change (like `PlotCellIdContext`); `null` outside a grid (showcase story) ⇒ no
 *  publish. The View pairs it with its `PlotCellIdContext` id. `pointIndices` (optional) is the per-row
 *  ORIGINAL local point index — a raw-dot chart (box/violin) passes it so the table's hover→highlight
 *  channel can point back at the exact plotted dot. */
export type PlotDataSink = (
  cellId: string,
  columns: string[],
  rows: (string | number)[][],
  pointIndices?: number[],
) => void
export const PlotDataSinkContext = createContext<PlotDataSink | null>(null)

/** A grouped/matrix chart View calls this to PUBLISH its plotted rows to the pane's data table. Reads
 *  the cell id (`PlotCellIdContext`) + sink (`PlotDataSinkContext`) and pushes on `deps` change. Outside
 *  a grid (no provider) it's a no-op. `build` returns the columns + rows the chart actually plots (plus
 *  optional per-row `pointIndices`). */
export function usePublishPlotData(
  build: () => { columns: string[]; rows: (string | number)[][]; pointIndices?: number[] } | null,
  deps: readonly unknown[],
): void {
  const cellId = useContext(PlotCellIdContext)
  const sink = useContext(PlotDataSinkContext)
  useEffect(() => {
    if (!cellId || !sink) return
    const d = build()
    if (d) sink(cellId, d.columns, d.rows, d.pointIndices)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId, sink, ...deps])
}

/** VALUE-LEGEND channel (matrix charts): a heatmap/dotplot publishes its continuous VALUE scale (the
 *  effective colormap + data domain) so GridWorkspace can render an on-plot colorbar for it + feed the
 *  edit-form colormap picker — the matrix analog of a scatter's `perCellLegend` continuous descriptor.
 *  `null` clears it. Outside a grid (no provider) ⇒ no-op. */
export type ValueLegendSink = (cellId: string, legend: { colormap: ContinuousColormap; domain: readonly [number, number] } | null) => void
export const ValueLegendSinkContext = createContext<ValueLegendSink | null>(null)
export function usePublishValueLegend(
  build: () => { colormap: ContinuousColormap; domain: readonly [number, number] } | null,
  deps: readonly unknown[],
): void {
  const cellId = useContext(PlotCellIdContext)
  const sink = useContext(ValueLegendSinkContext)
  useEffect(() => {
    if (!cellId || !sink) return
    sink(cellId, build())
    return () => sink(cellId, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId, sink, ...deps])
}

/** Data-table HOVER→HIGHLIGHT channel (per-cell): the ORIGINAL local point index the pane's data table
 *  is hovering, or `null`. Provided by GridWorkspace; a raw-dot chart View (box/violin) reads its own
 *  cell's value via `useHoverHighlightIndex()` and draws an emphasis ring on that dot. `null` outside a
 *  grid (no provider) ⇒ no highlight (byte-identical to before). */
export const HoverHighlightContext = createContext<Record<string, number | null>>({})

/** The hovered point index for the CURRENT chart cell (via `PlotCellIdContext`), or `null`. */
export function useHoverHighlightIndex(): number | null {
  const cellId = useContext(PlotCellIdContext)
  const map = useContext(HoverHighlightContext)
  return cellId ? (map[cellId] ?? null) : null
}

/** Whether hover TOOLTIPS are enabled (the global tool-rail toggle). Provided by GridWorkspace; charts
 *  read it to gate their per-dot / cross-highlight tooltip (the highlight RING always shows). Default
 *  `true` outside a grid. */
export const TooltipsEnabledContext = createContext<boolean>(true)
export function useTooltipsEnabled(): boolean {
  return useContext(TooltipsEnabledContext)
}

/** HOVER-PUBLISH channel (per-cell): a chart View calls this to publish the ORIGINAL local point index
 *  its user is hovering (a raw dot), or `null` on leave — so GridWorkspace can CROSS-highlight the same
 *  row in every other same-dataset cell (bidirectional with the scatter hover). Provided by GridWorkspace;
 *  `null` outside a grid (no provider) ⇒ no-op. */
export type HoverPublish = (cellId: string, index: number | null) => void
export const HoverPublishContext = createContext<HoverPublish | null>(null)

/** A chart View calls the returned fn with its hovered ORIGINAL point index (or `null`) to cross-highlight
 *  it across the grid. Binds the current cell id (`PlotCellIdContext`); a no-op outside a grid. */
export function usePublishHover(): (index: number | null) => void {
  const cellId = useContext(PlotCellIdContext)
  const publish = useContext(HoverPublishContext)
  return useCallback(
    (index: number | null) => {
      if (cellId && publish) publish(cellId, index)
    },
    [cellId, publish],
  )
}
