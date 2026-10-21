// parallelCoordinates.tsx — a PARALLEL-COORDINATES chart as a PURE self-registering
// extension (a capability proof for the ECharts-style chart-type registry). It adds a
// structurally-novel advanced chart — N parallel value axes, one polyline per data point,
// axis-brush → cross-plot selection — with ZERO edits to the engine core: it composes only
// the PUBLIC extension surface (the `ChartTypeDescriptor` contract, `ChartCanvas`'s drawing
// seam, the `CoordinationHandle`, the `mapRowsToIds`/`buildIdToRow` id-selection seam, the
// `use()` installer, `categoryColor`, `densify`) exactly as a third-party chart would.
//
// COORD SYSTEM: this composes into the existing `chart2d` host (own `ChartCanvas`,
// independent-axis auto-fit). A parallel-coordinates plot is a plain orthographic value
// chart — its only novelty is placing N axes at integer x and normalizing each independently
// — so it needs NO new coordinate system. (The public `registerCoordinateSystem` API was
// available had it needed one; it did not.)
//
// COORDINATION (the key registry test):
//  • CONSUME — the shared canonical-id point selection dims every polyline whose row is not
//    selected (read through `coordination.usePointSelection()` + the pure
//    `buildIdToRow`/`highlightMaskForIds` seam), so a selection made ELSEWHERE emphasises the
//    matching lines here.
//  • PRODUCE — dragging a value range on a SINGLE axis (the `ChartCanvas` drawing overlay,
//    unprojected to world coords) selects the points whose value on that dimension falls in
//    the range (`idsInAxisBrush`) and publishes them via `coordination.setSelection(originId,
//    ids)`, fanning out to every linked view.

import { useCallback, useMemo, useState } from 'react'
import { LineLayer, PathLayer, PolygonLayer, TextLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { use, type Extension } from '../../viz-core/extension'
import { ChartCanvas } from '../../viz-core/charts/ChartCanvas'
import {
  useAsyncChartData,
  ChartError,
  ChartLoading,
  ChartEmpty,
} from '../../viz-core/charts/useAsyncChartData'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import {
  buildIdToRow,
  identityPointIds,
  highlightMaskForIds,
  hasAnySelection,
} from '../../viz-core/coordination/selectionSync'
import { makeChartModel, bindingList, bindingValue } from '../../viz-core/registry/model'
import { densify } from '../../viz-core/data/wire'
import { categoryColor } from '../../viz-core/data/color'
import type { DataSource } from '../../viz-core/data/wire'
import type {
  BindingChannel,
  ChartTypeDescriptor,
  ChartViewProps,
  CoordinationHandle,
} from '../../viz-core/registry/types'
import {
  axisXPositions,
  buildAllVertices,
  clampAxisY,
  columnExtent,
  idsInAxisBrush,
  nearestAxis,
  type DimensionExtent,
} from './parallelCoordinatesModel'

/** The origin id this chart stamps on selections it produces (self-echo attribution). */
export const PARALLEL_COORDINATES_ORIGIN = 'parallel-coordinates'

/** RGBA alpha a polyline draws at: normal (no selection), emphasised, and dimmed. */
const ALPHA_NORMAL = 90
const ALPHA_EMPHASIS = 235
const ALPHA_DIM = 16

/** The half-width (data units) of the brush rectangle drawn over the brushed axis. */
const BRUSH_HALF_WIDTH = 0.14
/** A drag shorter than this (normalized y) is treated as a click → clears the selection. */
const MIN_BRUSH_HEIGHT = 0.01

/** The resolved, rendered dataset for the plot. */
interface PcData {
  /** One dense value column per dimension (full length; only the first `count` rows drawn). */
  readonly columns: Float32Array[]
  /** Per-dimension min→max normalization domain. */
  readonly extents: DimensionExtent[]
  /** Per-row group code (drives line color). */
  readonly codes: Uint16Array
  /** The dimension (axis) labels = the bound value-column keys. */
  readonly dims: readonly string[]
  /** Rows actually rendered (capped at `pointLimit`). */
  readonly count: number
}

/** A live axis brush: which axis + the two normalized y-endpoints of the drag. */
interface BrushState {
  readonly axis: number
  readonly y0: number
  readonly y1: number
}

export interface ParallelCoordinatesViewProps {
  source: DataSource
  /** The value-column keys → the parallel value axes (≥2 for a meaningful plot). */
  dimensions: readonly string[]
  /** The categorical column that colors each polyline. */
  groupKey: string
  /** Cap on rendered polylines (GPU budget); the first `pointLimit` rows. Default 6000. */
  pointLimit?: number
  /** The Selection coordination handle; defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
}

/** Short numeric label for an axis end (compact, 3 sig-figs). */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1)
  return Number(v.toPrecision(3)).toString()
}

export function ParallelCoordinatesView({
  source,
  dimensions,
  groupKey,
  pointLimit = 6000,
  coordination = defaultCoordinationHandle,
}: ParallelCoordinatesViewProps) {
  const [brush, setBrush] = useState<BrushState | null>(null)

  const { data, error } = useAsyncChartData<PcData>(
    async isAlive => {
      const sparse = await Promise.all(dimensions.map(async k => await source.valueColumn(k)))
      const cat = await source.categorical(groupKey)
      if (!isAlive()) return undefined
      const columns = sparse.map(densify)
      const count = Math.min(pointLimit, cat.codes.length, ...columns.map(c => c.length))
      const extents = columns.map(c => columnExtent(c, count))
      return { columns, extents, codes: cat.codes, dims: dimensions, count }
    },
    [source, dimensions, groupKey, pointLimit],
  )

  const count = data?.count ?? 0
  const nDims = data?.dims.length ?? 0

  // CONSUME: read the shared selection through the handle, map canonical ids → local rows via
  // the id seam (identity pointIds here — single-source fixture), and build a per-row 0/1
  // highlight mask. `active` gates whether ANY dimming happens (no selection ⇒ full-strength).
  const selection = coordination.usePointSelection()
  const idToRow = useMemo(() => buildIdToRow(identityPointIds(count)), [count])
  const highlightMask = useMemo(
    () => (selection && count > 0 ? highlightMaskForIds(selection, idToRow, count) : null),
    [selection, idToRow, count],
  )
  const selectionActive = hasAnySelection(selection)

  // The polyline vertices — the ONE per-point CPU pass, memoized on the resolved data. The
  // GPU draws every subsequent frame (emphasis is a color-attribute swap, not a rebuild).
  const paths = useMemo(
    () => (data ? buildAllVertices(data.columns, data.extents, count) : []),
    [data, count],
  )
  // Plain row-index array so a deck accessor's object IS its row (index === row).
  const rows = useMemo(() => Array.from({ length: count }, (_, r) => r), [count])

  const layers = useMemo<Layer[]>(() => {
    if (!data || nDims === 0 || count === 0) return []
    const axisX = axisXPositions(nDims)
    const out: Layer[] = []

    // 1. axis lines (vertical, one per dimension), GPU LineLayer.
    out.push(
      new LineLayer<number>({
        id: 'viz-pc-axes',
        data: axisX,
        getSourcePosition: (x: number) => [x, 0],
        getTargetPosition: (x: number) => [x, 1],
        getColor: [120, 120, 130, 200],
        getWidth: 1.5,
        widthUnits: 'pixels',
        widthMinPixels: 1,
      }),
    )

    // 2. the polylines — one PathLayer path per data row, colored by group, alpha driven by
    //    the shared-selection emphasis mask (GPU attribute; no per-frame CPU recolor).
    out.push(
      new PathLayer<number>({
        id: 'viz-pc-lines',
        data: rows,
        getPath: (r: number) => paths[r],
        getColor: (r: number) => {
          const [red, g, b] = categoryColor(data.codes[r] ?? 0)
          let alpha = ALPHA_NORMAL
          if (selectionActive) alpha = highlightMask && highlightMask[r] ? ALPHA_EMPHASIS : ALPHA_DIM
          return [red, g, b, alpha]
        },
        getWidth: 1,
        widthUnits: 'pixels',
        widthMinPixels: 1,
        jointRounded: true,
        capRounded: true,
        pickable: false,
        updateTriggers: {
          getColor: [selectionActive, highlightMask],
          getPath: paths,
        },
      }),
    )

    // 3. axis labels (dimension name at the bottom + min/max at the ends) — deck text marks.
    const labelData: { position: [number, number]; text: string; size: number }[] = []
    for (let d = 0; d < nDims; d++) {
      labelData.push({ position: [d, -0.07], text: data.dims[d], size: 13 })
      labelData.push({ position: [d, 1.04], text: fmt(data.extents[d].max), size: 10 })
      labelData.push({ position: [d, -0.035], text: fmt(data.extents[d].min), size: 10 })
    }
    out.push(
      new TextLayer<(typeof labelData)[number]>({
        id: 'viz-pc-labels',
        data: labelData,
        getPosition: d => d.position,
        getText: d => d.text,
        getSize: d => d.size,
        getColor: [90, 90, 100, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        billboard: false,
        sizeUnits: 'pixels',
      }),
    )

    // 4. the active brush rectangle over the brushed axis (GPU polygon; no SVG).
    if (brush) {
      const lo = Math.min(brush.y0, brush.y1)
      const hi = Math.max(brush.y0, brush.y1)
      const x = brush.axis
      out.push(
        new PolygonLayer<{ poly: [number, number][] }>({
          id: 'viz-pc-brush',
          data: [
            {
              poly: [
                [x - BRUSH_HALF_WIDTH, lo],
                [x + BRUSH_HALF_WIDTH, lo],
                [x + BRUSH_HALF_WIDTH, hi],
                [x - BRUSH_HALF_WIDTH, hi],
              ],
            },
          ],
          getPolygon: d => d.poly,
          stroked: true,
          filled: true,
          getFillColor: [56, 132, 255, 45],
          getLineColor: [56, 132, 255, 230],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          pickable: false,
          updateTriggers: { getPolygon: [brush] },
        }),
      )
    }

    return out
  }, [data, nDims, count, rows, paths, selectionActive, highlightMask, brush])

  // PRODUCE: the drawing overlay hands us WORLD coords. A pointer-down near an axis starts a
  // brush on THAT axis; drag sets its far edge; release resolves the value range → selected
  // ids → `setSelection`, fanning out to every linked view. A near-zero drag is a click → clear.
  const onDown = useCallback(
    (world: [number, number]) => {
      if (nDims === 0) return
      const axis = nearestAxis(world[0], nDims)
      if (axis == null) {
        setBrush(null)
        return
      }
      const y = clampAxisY(world[1])
      setBrush({ axis, y0: y, y1: y })
    },
    [nDims],
  )
  const onMove = useCallback((world: [number, number]) => {
    setBrush(prev => (prev ? { ...prev, y1: clampAxisY(world[1]) } : prev))
  }, [])
  const onUp = useCallback(() => {
    setBrush(prev => {
      if (!prev || !data) return prev
      const lo = Math.min(prev.y0, prev.y1)
      const hi = Math.max(prev.y0, prev.y1)
      if (hi - lo < MIN_BRUSH_HEIGHT) {
        coordination.setSelection(PARALLEL_COORDINATES_ORIGIN, null)
        return null
      }
      const ids = idsInAxisBrush(data.columns[prev.axis], data.extents[prev.axis], lo, hi, data.count)
      coordination.setSelection(PARALLEL_COORDINATES_ORIGIN, ids)
      return prev
    })
  }, [data, coordination])

  if (error) return <ChartError message={error} />
  if (!data) return <ChartLoading />
  if (nDims < 2 || count === 0) return <ChartEmpty message="Parallel coordinates needs ≥2 value dimensions" />

  // Explicit bounds so the axes + end labels frame stably (ChartCanvas would auto-fit, but the
  // fixed frame keeps the label margins from jittering as the brush rect appears/disappears).
  const bounds: [number, number, number, number] = [-0.5, -0.12, nDims - 1 + 0.5, 1.12]

  return (
    <ChartCanvas
      layers={layers}
      bounds={bounds}
      controller={false}
      testId="viz-parallel-coordinates-view"
      interaction={{
        drawing: true,
        onPointerDown: onDown,
        onPointerMove: onMove,
        onPointerUp: onUp,
        overlayTestId: 'viz-parallel-coordinates-brush',
      }}
    />
  )
}

// ── the self-registering descriptor (identical shape to any built-in) ────────────────────
// `dimensions` is a `valueList` channel (several value columns — the same channel SOURCE the
// heatmap's `valueKeys` uses, so the chrome renders its control generically); `group` is the
// categorical color channel. `model()` resolves both against the catalog via `makeChartModel`
// — no per-chart binding logic in the core.
const DIMENSIONS_CHANNEL: BindingChannel = { id: 'dimensions', source: 'valueList', label: 'Dimensions' }
const GROUP_CHANNEL: BindingChannel = { id: 'group', source: 'categorical', label: 'Group' }
const PARALLEL_SCHEMA: readonly BindingChannel[] = [DIMENSIONS_CHANNEL, GROUP_CHANNEL]

/** The uniform-props adapter → the View (spreads the resolved bindings, forwards the handle). */
function ParallelCoordinatesAdapter({ model, source, coordination }: ChartViewProps) {
  const b = model.bindings
  return (
    <ParallelCoordinatesView
      source={source}
      dimensions={bindingList(b, 'dimensions')}
      groupKey={bindingValue(b, 'group')}
      coordination={coordination}
    />
  )
}

export const parallelCoordinatesDescriptor: ChartTypeDescriptor = {
  type: 'parallel-coordinates',
  coordinateSystem: 'chart2d',
  view: ParallelCoordinatesAdapter,
  capabilities: { consumesSelection: true, producesSelection: true, dataZoomAxes: [] },
  bindingSchema: PARALLEL_SCHEMA,
  model: (cell, ctx) => makeChartModel(cell, PARALLEL_SCHEMA, ctx.catalog),
}

/**
 * The self-registering installer — `use(ParallelCoordinatesChart)` registers ONLY this chart
 * type (tree-shakeable, idempotent by identity), never touching the built-in set. Registering
 * it does NOT change the built-in count until an app opts in via `use`.
 */
export const ParallelCoordinatesChart: Extension = {
  install: r => r.registerChartType(parallelCoordinatesDescriptor),
}

/** Convenience: register the chart type (wraps `use(ParallelCoordinatesChart)`). */
export function installParallelCoordinates(): void {
  use(ParallelCoordinatesChart)
}
