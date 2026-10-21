// DotplotView.tsx — the dotplot VIEW (DEC-18: a ScatterplotLayer on a categorical
// grid, radius = fraction, color = value). Data-shaping (a set of value columns +
// categorical → grid `DotCellInput[]`) is the pure exported `dotCellsFromColumns`
// helper (wraps the shared `dotplotMatrix`); the component wires load → helper →
// `buildDotplotProps` → layer → `ChartCanvas`.
//
// STEP 3-4 (EXTENSIBILITY_STUDY): the cross-plot selection EMPHASIS is read through the
// injected `coordination` handle, and the matrix dataZoom WINDOW is owned by the core
// `DataZoomMatrix` component (not this View). `DotplotView` is a thin OUTER that loads +
// computes emphasis + the window-independent layers; `DotplotBody` re-frames to the window.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PlotCellIdContext, usePublishPlotData, usePublishValueLegend } from './plotCellId'
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas } from './ChartCanvas'
import { useAsyncChartData, ChartError, ChartLoading, ChartEmpty } from './useAsyncChartData'
import { VizTooltip } from '../tooltip/VizTooltip'
import { formatNumber, type TooltipRow } from '../tooltip/tooltipModel'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { chartFrameFont, type Typography } from '../controls/typography'
import { defaultChartTheme, parseColor } from './ChartFrame'
import { type DataZoomConfig } from './AxisDataZoom'
import { DataZoomMatrix } from '../datazoom/DataZoom'
import { windowToBounds, type MatrixWindow } from './matrixWindow'
import { buildDotplotProps, uniqueInOrder, type DotCellInput } from './chartLayers'
import { deckTransitions, type TransitionProp } from './transitions'
import { categoryTicks } from './axisTicks'
import { displayCategory, DEFAULT_CONTINUOUS_COLORMAP, type CategoricalOverrides, type ContinuousColormap } from '../data/color'
import { dotplotMatrix } from './aggregate'
import { dotplotMatrixGpu } from './aggregateGpu'
import { getComputeDevice } from '../gpu/computeDevice'
import { densify } from '../data/wire'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import type { CoordinationHandle } from '../registry/types'
import { markOpacity } from '../coordination/selectionSync'
import { gateGroupEmphasis, gateMatrixDataZoom } from './capabilityGates'
import type { CategoricalColumn, DataSource, SparseColumn } from '../data/wire'

/** Reused empty codes column so the emphasis memo has a stable input before load. */
const EMPTY_CODES = new Uint16Array(0)

/**
 * Turn a set of (densified) value columns + a categorical column into dotplot grid
 * cells (`DotCellInput[]`): run the shared `dotplotMatrix` (per column × group mean +
 * fraction-expressing), mapping each cell to `{ row: group, col: column, value:
 * meanExpr, fraction: fractionExpressing }`. Pure — no GL, no I/O.
 */
export function dotCellsFromColumns(
  columns: ReadonlyMap<string, Float32Array>,
  cat: CategoricalColumn,
): DotCellInput[] {
  const cells = dotplotMatrix(columns, cat.codes, cat.categories)
  return cells.map(c => ({
    row: c.group,
    col: c.column,
    value: c.meanExpr,
    fraction: c.fractionExpressing,
  }))
}

/** Densify each sparse value column into a dense `Float32Array` map (shared load tail). */
export function densifyColumns(entries: readonly (readonly [string, SparseColumn])[]): Map<string, Float32Array> {
  return new Map(entries.map(([key, col]) => [key, densify(col)] as const))
}

/**
 * Minimal flipY-correct axis-title layer shared by the matrix charts (dotplot + heatmap, which imports
 * this). The sibling `buildChartFrameLayers` places its titles for a NON-flipped value/category chart
 * (x-axis at yMin), which mis-orients under the matrix's `flipY`; so the matrix draws just its axis
 * titles here, using the SAME `chartFrameFont(typography)` sizing + chart-fg color as the sibling
 * frames. Billboard `TextLayer` text stays upright under flipY. `bounds` is the VISIBLE matrix rect
 * `[x0,y0,x1,y1]` in data space (y grows downward on screen): the x-title sits below (`y1`), the
 * y-title left (`x0`, rotated). Returns `[]` when neither title is set (byte-identical no-title path).
 */
export function matrixAxisTitleLayers(opts: {
  bounds: [number, number, number, number]
  axisTitles: { x?: string; y?: string } | undefined
  typography: Typography | undefined
  idPrefix: string
}): Layer[] {
  const { bounds, axisTitles, typography, idPrefix } = opts
  if (!axisTitles?.x && !axisTitles?.y) return []
  const [x0, y0, x1, y1] = bounds
  const font = chartFrameFont(typography)
  const color = parseColor(defaultChartTheme().fg)
  type TitleDatum = {
    position: [number, number]
    text: string
    anchor: 'start' | 'middle' | 'end'
    baseline: 'top' | 'center' | 'bottom'
    pixelOffset: [number, number]
    angle: number
  }
  const data: TitleDatum[] = []
  if (axisTitles.x) {
    data.push({ position: [(x0 + x1) / 2, y1], text: axisTitles.x, anchor: 'middle', baseline: 'top', pixelOffset: [0, 34], angle: 0 })
  }
  if (axisTitles.y) {
    data.push({ position: [x0, (y0 + y1) / 2], text: axisTitles.y, anchor: 'middle', baseline: 'bottom', pixelOffset: [-44, 0], angle: 90 })
  }
  return [
    new TextLayer<TitleDatum>({
      id: `${idPrefix}-axis-titles`,
      data,
      getPosition: d => d.position,
      getText: d => d.text,
      getSize: font.titleSize,
      sizeUnits: 'pixels',
      ...(font.family ? { fontFamily: font.family } : {}),
      getColor: color,
      getAngle: d => d.angle,
      getTextAnchor: d => d.anchor,
      getAlignmentBaseline: d => d.baseline,
      getPixelOffset: d => d.pixelOffset,
      pickable: false,
    }),
  ]
}

export interface DotplotViewProps {
  source: DataSource
  valueKeys: readonly string[]
  groupKey: string
  /** Opt-in axis-pointer crosshair (ITEM-33); default off. Both axes are categorical (x = columns, y = group rows) → both snap. */
  axisPointer?: boolean
  /**
   * Per-instance dataZoom config: `false` disables the zoom UI entirely; `{ x, y, wheel }` picks
   * each axis' control kind + wheel gate. Default (omitted) = both sliders + wheel.
   */
  dataZoom?: false | DataZoomConfig
  /** Theme-aware chrome colors for the hover tooltip; default light (mirrors HeatmapView). */
  theme?: VizTheme
  /**
   * OPT-IN per-plot animated transitions (default OFF). `false`/omitted ⇒ instant (byte-identical
   * to today); `{ duration?, easing? }` ⇒ the grid dots' position + color + radius GPU-interpolate
   * (`getPosition`/`getFillColor`/`getRadius`) — the fullest tween of the aggregated Views, since a
   * dotplot recolor (value→color) AND resize (fraction→radius) AND reflow are all attribute changes.
   * Mirrors the per-plot `dataZoom` config shape.
   */
  transitions?: TransitionProp
  /** The Selection coordination handle (STEP 3); defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
  /** ENFORCED capability (Area B, ITEM-5). `false` ⇒ this View does NOT consume the shared
   *  selection (no per-row dot dim). Unset/true ⇒ consume (byte-identical). */
  consumesSelection?: boolean
  /** ENFORCED capability (Area B, ITEM-6). The axes the matrix zoom honors; an empty set disables
   *  it. Unset / `['x','y']` ⇒ unchanged. */
  dataZoomAxes?: readonly ('x' | 'y')[]
  /**
   * OPTIONAL categorical overrides. `categoryLabels` renames the group ROW axis ticks + the tooltip
   * "Group" field, and `hiddenCodes` collapses hidden group rows — BOTH apply here (see `visibleCells`
   * + the tooltip/publish paths). The per-group PALETTE / by-name colors, however, DO NOT and CANNOT
   * drive the dot marks: a dotplot's dot fill is a CONTINUOUS VALUE encoding (color = mean expression
   * via `buildDotplotProps`'s colormap, radius = fraction) — the defining dotplot channel — with no
   * per-CATEGORY color channel to recolor. This is the precise divergence from ViolinView/BoxView
   * (whose marks ARE per-group, so `resolveEffectivePalette` recolors them): forcing the group palette
   * onto dot fill would overwrite the value→color scale and destroy the plot's meaning, so it's left
   * value-keyed by design (the group recolor is intentionally cosmetic-only for this chart type).
   */
  overrides?: CategoricalOverrides
  /** Plot-editing (ITEM-4): per-cell x/y AXIS title overrides (declarative). Absent ⇒ no titles.
   *  Rendered via the shared flipY-correct `matrixAxisTitleLayers` (mirrors the sibling frame titles). */
  axisTitles?: { x?: string; y?: string }
  /** Typography (font family + axis-title size) for the axis titles. Absent ⇒ built-in defaults. */
  typography?: Typography
  /** Continuous VALUE colormap override (edit-form Color section) for the dot FILL (mean-expression)
   *  scale. Absent ⇒ viridis default. Published up as the on-plot value colorbar. */
  colormap?: ContinuousColormap
}

export function DotplotView({
  source,
  valueKeys,
  groupKey,
  axisPointer = false,
  dataZoom,
  theme = LIGHT_THEME,
  transitions,
  coordination = defaultCoordinationHandle,
  consumesSelection,
  dataZoomAxes,
  overrides,
  axisTitles,
  typography,
  colormap: valueColormap,
}: DotplotViewProps) {
  // The cell's STABLE dataZoom id (ITEM-20): store-backed matrix window when inside a grid cell
  // (restore applies), `undefined` (local `useState`, byte-identical) in a story with no provider.
  const plotCellId = useContext(PlotCellIdContext)
  // Per-point group codes — map a shared point-selection to the dotplot GROUP ROWS it
  // covers (cross-plot emphasis). A dot's row is a group; the row's index in the grid
  // (its category order) equals the group code. Set from inside the loader.
  const [catCodes, setCatCodes] = useState<Uint16Array | null>(null)

  const { data: cells, error } = useAsyncChartData<DotCellInput[]>(async isAlive => {
    const cols = await Promise.all(valueKeys.map(async k => [k, await source.valueColumn(k)] as const))
    const cat = await source.categorical(groupKey)
    // Prefer the GPU aggregation (auto-falls back to the CPU `dotplotMatrix` oracle when
    // no compute device); the result is identical in shape to `dotCellsFromColumns`.
    const device = await getComputeDevice()
    const matrix = await dotplotMatrixGpu(densifyColumns(cols), cat.codes, cat.categories, device)
    if (!isAlive()) return undefined
    setCatCodes(cat.codes)
    return matrix.map(c => ({
      row: c.group,
      col: c.column,
      value: c.meanExpr,
      fraction: c.fractionExpressing,
    }))
    // PERF: key on a STABLE joined string, not the `valueKeys` array reference — the registry passes a
    // fresh `valueKeys` array every render, so an array-identity dep re-fired the GPU reduce + synchronous
    // readPixels readback on EVERY re-render (the CPU spike / hang on scatter->dotplot). Mirrors HeatmapView.
  }, [source, valueKeys.join('\n'), groupKey])

  // Build once → layer + the grid dimensions (rows × cols) that the dataZoom window
  // navigates. A dot sits at integer (colIndex, rowIndex); the window is in index units.
  // HIDDEN group rows (interactive legend / form): drop them so the matrix ROWS collapse + re-space.
  // `fullRowCode` maps a row name → its ORIGINAL group code (from the unfiltered order) so cross-plot
  // emphasis still maps by the true code after the collapse; `visibleCells` is the filtered set the
  // grid + emphasis both iterate (kept in lockstep with `grid.dots`).
  const { grid, visibleCells, fullRowCode } = useMemo(() => {
    if (!cells) return { grid: null, visibleCells: [] as DotCellInput[], fullRowCode: new Map<string, number>() }
    const fullRows = uniqueInOrder(cells.map(c => c.row))
    const fullRowCode = new Map(fullRows.map((r, i) => [r, i] as const))
    const hidden = overrides?.hiddenCodes
    const visibleCells =
      hidden && hidden.size > 0 ? cells.filter(c => !hidden.has(fullRowCode.get(c.row) ?? -1)) : cells
    return { grid: buildDotplotProps(visibleCells, { colormap: valueColormap }), visibleCells, fullRowCode }
  }, [cells, overrides?.hiddenCodes, valueColormap])
  const nRows = grid?.rows.length ?? 0
  const nCols = grid?.cols.length ?? 0
  // Publish the dot-fill value scale (colormap + domain) up → GridWorkspace renders the on-plot colorbar
  // + feeds the edit-form colormap picker.
  const effColormap: ContinuousColormap = valueColormap ?? DEFAULT_CONTINUOUS_COLORMAP
  // Publish the value scale ONLY when there's actually a matrix to plot — an EMPTY matrix (all groups
  // hidden / filtered out) renders <ChartEmpty> below, so a colorbar + editable colormap must not float
  // over "No data to plot" (mirrors HeatmapView, which nulls its value legend in the same empty case).
  usePublishValueLegend(
    () => (grid && nRows > 0 && nCols > 0 ? { colormap: effColormap, domain: grid.domain } : null),
    [effColormap, grid?.domain?.[0], grid?.domain?.[1], nRows, nCols],
  )

  // Publish the plotted matrix cells (VISIBLE group rows) to the pane's "Plot data" table.
  usePublishPlotData(() => {
    if (visibleCells.length === 0) return null
    const r = (v: number) => Math.round(v * 1000) / 1000
    return {
      columns: ['group', 'feature', 'meanExpr', 'fractionExpressing'],
      rows: visibleCells.map(c => [displayCategory(c.row, overrides?.categoryLabels), c.col, r(c.value), r(c.fraction)]),
    }
  }, [visibleCells, overrides])

  // Cross-plot selection emphasis (DEC-25 / ITEM-25) — READ THROUGH the coordination handle
  // (STEP 3): the dotplot emphasises the dots whose GROUP ROW a shared point-selection covers.
  // ENFORCED consume gate (ITEM-5): `consumesSelection:false` ⇒ discard the shared emphasis.
  const { selectedCodes, active } = gateGroupEmphasis(coordination.useGroupEmphasis(catCodes ?? EMPTY_CODES), consumesSelection)

  // Layers are window-INDEPENDENT (the dots + their per-group dim), so they live in the OUTER;
  // only the framing re-frames to the window (in the passive body below).
  const layers = useMemo<Layer[]>(() => {
    if (!grid || !cells) return []
    // OPT-IN GPU tween (default off ⇒ no `transitions` key ⇒ instant): a dotplot's dots reposition,
    // recolor, and resize — all binary-attribute changes deck can interpolate.
    const tx = deckTransitions(transitions, ['getPosition', 'getFillColor', 'getRadius'])
    const txProp = tx ? { transitions: tx } : {}
    if (!active) return [new ScatterplotLayer({ ...grid.dots, ...txProp })]
    // Dotplot's only mark is the per-cell dot (color = value, radius = fraction) — a binary
    // color buffer, so there's no per-datum accessor to wrap. Instead clone the buffer and
    // scale each dot's ALPHA by its group's mark-opacity. This runs ONLY on a selection /
    // grid change (memoised), never per frame, and is O(cells) = O(groups × features) —
    // the small grid, not the source point cloud. Row (group) code == the dot's row index.
    const base = grid.dots.data.attributes.getFillColor.value
    const dimmed = new Uint8Array(base)
    // Iterate the VISIBLE cells (matches grid.dots order); map each to its ORIGINAL group code so the
    // emphasis dims by the true selection even after the row collapse.
    for (let i = 0; i < visibleCells.length; i++) {
      const code = fullRowCode.get(visibleCells[i].row) ?? -1
      const op = markOpacity(code, selectedCodes, true)
      if (op !== 1) dimmed[i * 4 + 3] = Math.round(dimmed[i * 4 + 3] * op)
    }
    const dots = {
      ...grid.dots,
      ...txProp,
      data: {
        length: grid.dots.data.length,
        attributes: {
          ...grid.dots.data.attributes,
          getFillColor: { ...grid.dots.data.attributes.getFillColor, value: dimmed },
        },
      },
    }
    return [new ScatterplotLayer(dots)]
  }, [grid, visibleCells, fullRowCode, selectedCodes, active, transitions])

  // M4: distinguish LOADING (cells not yet resolved) from a legitimately EMPTY matrix (loaded but
  // zero rows/cols) — the latter shows an empty-state message, never a permanent spinner.
  if (error) return <ChartError message={error} />
  if (!cells) return <ChartLoading />
  if (nRows === 0 || nCols === 0) return <ChartEmpty message="No data to plot" />

  // ENFORCED dataZoom-axes gate (ITEM-6): an EMPTY declared `dataZoomAxes` disables the matrix
  // zoom entirely. Unset / any axis declared ⇒ unchanged (`['x','y']` is the descriptor default).
  const effDataZoom = gateMatrixDataZoom(dataZoom, dataZoomAxes)
  // The matrix dataZoom WINDOW is owned by the core `DataZoomMatrix` (STEP 4); the passive body
  // re-frames to it. `viz-dotplot-datazoom` control testId + per-instance enable/disable preserved.
  return (
    <DataZoomMatrix nRows={nRows} nCols={nCols} dataZoom={effDataZoom} testId="viz-dotplot-datazoom" dataZoomId={plotCellId}>
      {window => (
        <DotplotBody
          grid={grid!}
          cells={cells}
          layers={layers}
          window={window}
          axisPointer={axisPointer}
          theme={theme}
          overrides={overrides}
          axisTitles={axisTitles}
          typography={typography}
        />
      )}
    </DataZoomMatrix>
  )
}

/** Build the hover-cell tooltip rows for one dotplot cell (O(1) — one index into `cells`). The
 *  group row is shown through `displayCategory` so a `categoryLabels` rename appears in the tooltip
 *  too (matching the axis). */
function dotTooltipRows(cell: DotCellInput, overrides?: CategoricalOverrides): TooltipRow[] {
  return [
    { label: 'Group', value: displayCategory(cell.row, overrides?.categoryLabels) },
    { label: 'Feature', value: cell.col },
    { label: 'Mean', value: formatNumber(cell.value) },
    { label: 'Fraction', value: formatNumber(cell.fraction) },
  ]
}

/**
 * The passive dotplot body: REACTS to the injected `window` by re-framing the matrix rect, and
 * (PAT-2, matching HeatmapView) owns the O(1) hover tooltip over the dots. The `ScatterplotLayer`
 * is pickable, so deck's hover hands us `info.index` = the hovered dot's index into `cells` — a
 * direct O(1) readout of (group, feature, mean, fraction), rAF-throttled to one setState/frame.
 */
function DotplotBody({
  grid,
  cells,
  layers,
  window,
  axisPointer,
  theme,
  overrides,
  axisTitles,
  typography,
}: {
  grid: NonNullable<ReturnType<typeof buildDotplotProps>>
  cells: readonly DotCellInput[]
  layers: Layer[]
  window: MatrixWindow | null
  axisPointer: boolean
  theme: VizTheme
  overrides?: CategoricalOverrides
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}) {
  // Frame the window's rect. Pad half a cell so the boundary dots (at 0 and n−1) aren't
  // clipped at the canvas edge (dots are pixel-radius point marks, not unit cells).
  const bounds = useMemo<[number, number, number, number] | undefined>(() => {
    if (!window) return undefined
    const [c0, r0, c1, r1] = windowToBounds(window)
    return [c0 - 0.5, r0 - 0.5, c1 - 0.5, r1 - 0.5]
  }, [window])

  // Axis titles (plot-editing): a flipY-correct billboard TextLayer framed to the VISIBLE dot-grid rect
  // (mirrors the sibling charts framing their titles to the window). Appended on top of the dot layers.
  const titledLayers = useMemo<Layer[]>(() => {
    const rect: [number, number, number, number] =
      bounds ?? [-0.5, -0.5, grid.cols.length - 0.5, grid.rows.length - 0.5]
    const titles = matrixAxisTitleLayers({ bounds: rect, axisTitles, typography, idPrefix: 'viz-dotplot' })
    return titles.length > 0 ? [...layers, ...titles] : layers
  }, [layers, bounds, grid, axisTitles, typography])

  // Both axes categorical: x = columns, y = group rows; dots sit at integer (col, row)
  // centers, so nearest-category snap ticks are the label arrays at pos = index.
  const axisPointerTicks = useMemo(
    () => ({
      x: categoryTicks(grid.cols),
      y: categoryTicks(grid.rows.map(r => displayCategory(r, overrides?.categoryLabels))),
    }),
    [grid, overrides],
  )

  // rAF-throttled dot hover (mirrors HeatmapBody): deck's picking hands us `info.index` for the
  // pickable dots layer; coalesce to one setState/frame. The readout (`dotTooltipRows`) is O(1).
  const [tip, setTip] = useState<{ index: number; x: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<{ index: number; x: number; y: number } | null>(null)
  const flushTip = useCallback(() => {
    rafRef.current = null
    setTip(pendingRef.current)
  }, [])
  const handleHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      const idx = info?.index
      if (typeof idx === 'number' && idx >= 0 && idx < cells.length && info?.picked) {
        pendingRef.current = { index: idx, x: info.x, y: info.y }
      } else {
        pendingRef.current = null
      }
      if (typeof requestAnimationFrame === 'undefined') flushTip()
      else if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushTip)
    },
    [cells.length, flushTip],
  )
  useEffect(
    () => () => {
      if (rafRef.current != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ChartCanvas
        layers={titledLayers}
        bounds={bounds}
        controller={false}
        flipY
        axisPointer={axisPointer}
        axisPointerTicks={axisPointerTicks}
        testId="viz-dotplot-view"
        onHover={handleHover}
      />
      {tip && tip.index < cells.length && (
        <VizTooltip rows={dotTooltipRows(cells[tip.index], overrides)} x={tip.x} y={tip.y} theme={theme} />
      )}
    </div>
  )
}
