// BoxView.tsx — the box-plot VIEW (DEC-18: SolidPolygonLayer IQR rects + LineLayer
// whiskers/fence-caps/median + ScatterplotLayer outliers, all from `buildBoxProps`) plus
// a per-group MEAN MARKER (a distinct hollow `ScatterplotLayer` point at the group's
// arithmetic mean — the box shows the median, the marker shows the mean). Data-shaping
// (value column + categorical → per-group Tukey `BoxStat[]` + per-group means) is the
// pure exported `boxStatsFromColumn` / `groupMeansFromColumn` helpers; the component
// wires load → helpers → `buildBoxProps` → layers → `ChartCanvas`.
//
// STEP 3-4 (EXTENSIBILITY_STUDY): the cross-plot selection EMPHASIS is read through the
// injected `coordination` handle (the Selection component), and the value-axis dataZoom
// WINDOW is owned by the core `ValueDataZoom` component (not this View). `BoxView` is a thin
// OUTER that loads data + computes the value domain + reads the emphasis; `BoxBody` is the
// passive consumer that REACTS to the injected `window` by re-framing the y bounds.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PlotCellIdContext } from './plotCellId'
import { useAsyncChartData, ChartError, ChartLoading } from './useAsyncChartData'
import { usePublishPlotData, useHoverHighlightIndex, usePublishHover, useTooltipsEnabled } from './plotCellId'
import { formatNumber } from '../tooltip/tooltipModel'
import { SolidPolygonLayer, LineLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas, robustValueRange } from './ChartCanvas'
import { type DataZoomConfig } from './AxisDataZoom'
import { ValueDataZoom } from '../datazoom/DataZoom'
import { boundsWithValueWindow } from './plotWindow'
import { type ValueWindow } from './valueWindow'
import { buildBoxProps, type BoxStat } from './chartLayers'
import { chartFrameFont, type Typography } from '../controls/typography'
import { deckTransitions, type TransitionProp } from './transitions'
import { buildChartFrameLayers, defaultChartTheme, type ChartTheme } from './ChartFrame'
import { clipToBounds } from './clip'
import { categoryTicks } from './axisTicks'
import { resolveEffectivePalette, displayCategory, visibleByCode, categoryColor, type CategoricalOverrides } from '../data/color'
import { quartiles } from '../data/statsKernels'
import { boxStatsGpu } from './groupStatsGpu'
import { getComputeDevice } from '../gpu/computeDevice'
import { densify } from '../data/wire'
import { finiteValues } from '../data/missing'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import type { CoordinationHandle } from '../registry/types'
import { applyMarkOpacity, markOpacity, type GroupEmphasis } from '../coordination/selectionSync'
import { gateGroupEmphasis, gateValueDataZoom } from './capabilityGates'
import type { CategoricalColumn, DataSource, SparseColumn } from '../data/wire'

/** Reused empty codes column so the emphasis memo has a stable input before load. */
const EMPTY_CODES = new Uint16Array(0)

/** Bucket a densified value column by category code, in category order. Pure. */
function bucketByGroup(col: SparseColumn, cat: CategoricalColumn): number[][] {
  const dense = densify(col)
  const buckets: number[][] = cat.categories.map(() => [])
  for (let i = 0; i < cat.codes.length; i++) {
    const g = cat.codes[i]
    if (g < buckets.length) buckets[g].push(dense[i])
  }
  return buckets
}

/**
 * Turn a sparse value column + a categorical column into per-group Tukey box
 * statistics (`BoxStat[]`): densify, bucket values by group code, then run the shared
 * `quartiles` kernel per group. Pure — no GL, no I/O. Groups appear in category order.
 */
export function boxStatsFromColumn(col: SparseColumn, cat: CategoricalColumn): BoxStat[] {
  const buckets = bucketByGroup(col, cat)
  return cat.categories.map((group, g) => {
    const q = quartiles(buckets[g])
    return {
      group,
      q1: q.q1,
      median: q.median,
      q3: q.q3,
      lowerFence: q.lowerFence,
      upperFence: q.upperFence,
      outliers: q.outliers,
    }
  })
}

/**
 * Per-group arithmetic mean (finite values only), in category order — the mean-marker
 * source. An empty group yields 0. Pure — no GL, no I/O.
 */
export function groupMeansFromColumn(col: SparseColumn, cat: CategoricalColumn): number[] {
  return bucketByGroup(col, cat).map(bucket => {
    const v = finiteValues(bucket)
    if (v.length === 0) return 0
    let sum = 0
    for (const x of v) sum += x
    return sum / v.length
  })
}

export interface BoxViewProps {
  source: DataSource
  valueKey: string
  groupKey: string
  /** Draw the per-group mean marker (default true). */
  showMean?: boolean
  /** Draw the axes / ticks / labels / gridlines frame (default true). */
  showFrame?: boolean
  /** Draw gridlines within the frame (default true). */
  showGrid?: boolean
  /** Theme-aware chrome colors (DEC-39); defaults to the light theme. */
  theme?: ChartTheme
  /** Opt-in axis-pointer crosshair (ITEM-33); default off. x snaps to the group categories, y is a free value axis. */
  axisPointer?: boolean
  /**
   * Per-instance VALUE-axis (y) dataZoom config: `false` disables the zoom UI entirely (plain
   * free-camera chart, byte-unchanged); `{ y, wheel }` picks the value axis' control kind
   * (`'slider'|'inside'|'both'|'off'`) + the wheel gate. The category (x) axis is never zoomed.
   * Default (omitted) = the wrapper's own default (a value slider + wheel — `ValueAxisZoom`'s
   * `DEFAULT_Y_MODE` = `{ y: 'both' }`), which reframes the y-bounds to the window WITHOUT
   * re-densifying (a box has no density — unlike the violin).
   */
  dataZoom?: false | DataZoomConfig
  /**
   * OPT-IN per-plot animated transitions (default OFF). `false`/omitted ⇒ instant (byte-identical
   * to today); `{ duration?, easing? }` ⇒ the IQR box fill (`getFillColor`) + the mean marker
   * (`getPosition`/`getFillColor`) GPU-interpolate a recolor / data change. Box GEOMETRY (the
   * q1..q3 rect) is a polygon rebuild, not an attribute tween. Mirrors `dataZoom`'s shape.
   */
  transitions?: TransitionProp
  /** The Selection coordination handle (STEP 3); defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
  /** ENFORCED capability (Area B, ITEM-5). `false` ⇒ this View does NOT consume the shared
   *  selection (no group-box emphasis / dim). Unset/true ⇒ consume (byte-identical). */
  consumesSelection?: boolean
  /** ENFORCED capability (Area B, ITEM-6). Boxes zoom only the value (y) axis, so a declared
   *  `dataZoomAxes` lacking `'y'` disables the value zoom. Unset ⇒ default. */
  dataZoomAxes?: readonly ('x' | 'y')[]
  /**
   * OPTIONAL categorical overrides — a custom/by-name palette recolors the IQR boxes and
   * `categoryLabels` renames the group AXIS ticks. Absent ⇒ built-in palette + raw names
   * (byte-identical). Export picks them up (they live on the rendered marks/axis).
   */
  overrides?: CategoricalOverrides
  /** Plot-editing (ITEM-4): per-cell x/y AXIS title overrides (declarative). Absent ⇒ default. */
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}

/**
 * Default box value-axis dataZoom: a vertical value slider + wheel-zoom. Retained as a PUBLIC
 * preset for callers that want to name it explicitly (e.g. a toggle story); the View itself no
 * longer uses it as its own default — passing `undefined` (like the violin) lets the wrapper's
 * own `DEFAULT_Y_MODE` be the single source of the default. Runtime-identical to `undefined`.
 */
export const DEFAULT_BOX_DATAZOOM: DataZoomConfig = { y: 'both' }

interface BoxData {
  stats: BoxStat[]
  means: number[]
  /** RAW per-point values + group codes — the plot draws individual outlier dots, so the "Plot data"
   *  table publishes the raw points (not the summary stats). Category order in `categories`. */
  values: Float32Array
  codes: Uint16Array
  categories: readonly string[]
}

export function BoxView({
  source,
  valueKey,
  groupKey,
  showMean = true,
  showFrame = true,
  showGrid = true,
  theme = defaultChartTheme(),
  axisPointer = false,
  dataZoom,
  transitions,
  coordination = defaultCoordinationHandle,
  consumesSelection,
  dataZoomAxes,
  overrides,
  axisTitles,
  typography,
}: BoxViewProps) {
  // The cell's STABLE dataZoom id (ITEM-20): store-backed window when inside a grid cell (restore
  // applies), `undefined` (local `useState`, byte-identical) in a story with no provider.
  const plotCellId = useContext(PlotCellIdContext)
  // Per-point group codes — needed to map a shared point-selection to the GROUP marks it
  // covers (cross-plot emphasis; mirrors HeatmapView). Groups are the categories in code
  // order, so a group's mark INDEX equals its group code. Set from inside the loader.
  const [catCodes, setCatCodes] = useState<Uint16Array | null>(null)

  const { data, error } = useAsyncChartData<BoxData>(async isAlive => {
    const [col, cat, device] = await Promise.all([
      source.valueColumn(valueKey),
      source.categorical(groupKey),
      getComputeDevice(),
    ])
    if (!isAlive()) return undefined
    setCatCodes(cat.codes)
    // Prefer the GPU histogram quartiles (DEC-26/29); no device → the exact CPU oracle.
    // Means stay on the CPU (a plain per-group sum — not the hot sort/rank path).
    const stats = await boxStatsGpu(col, cat, {}, device)
    if (!isAlive()) return undefined
    return { stats, means: groupMeansFromColumn(col, cat), values: densify(col), codes: cat.codes, categories: cat.categories }
  }, [source, valueKey, groupKey])

  // Publish the RAW per-point data (group + value) to the "Plot data" table — a box draws individual
  // outlier dots, so the reproducible data is the raw points, not the summary stats. VISIBLE groups only
  // (a hidden/collapsed group's points are excluded, matching the plot); the source is already
  // value-window-filtered upstream when linked.
  usePublishPlotData(() => {
    if (!data) return null
    const hidden = overrides?.hiddenCodes
    const rows: (string | number)[][] = []
    // Each row's ORIGINAL index into values/codes so hovering a table row highlights the exact point
    // (rung at its group-center x + value y — an outlier lands on its own dot).
    const pointIndices: number[] = []
    const n = Math.min(data.values.length, data.codes.length)
    for (let i = 0; i < n; i++) {
      const code = data.codes[i]
      if (hidden?.has(code)) continue
      rows.push([displayCategory(data.categories[code] ?? String(code), overrides?.categoryLabels), data.values[i]])
      pointIndices.push(i)
    }
    return { columns: ['group', valueKey], rows, pointIndices }
  }, [data, overrides, valueKey])

  // Cross-plot selection emphasis (DEC-25 / ITEM-25) — now READ THROUGH the coordination handle
  // (STEP 3): the box plot emphasises the GROUP boxes a shared point-selection covers and dims
  // the rest. O(groups) per-mark opacity, never a per-point loop.
  // ENFORCED consume gate (ITEM-5): `consumesSelection:false` ⇒ discard the shared emphasis.
  const emphasis = gateGroupEmphasis(coordination.useGroupEmphasis(catCodes ?? EMPTY_CODES), consumesSelection)

  // The FULL, robust value range (the domain the value slider spans + the un-zoomed y-frame).
  const valueRange = useMemo<[number, number] | null>(() => {
    if (!data || data.stats.length === 0) return null
    // ROBUST y-frame: the box bodies (q1..q3), medians, means, and whisker fences are the
    // CORE that must fill the frame; the OUTLIER markers get clamped headroom so a lone far
    // point can't stretch yMax and squish every box into a sliver (see robustValueRange).
    const core: number[] = []
    const soft: number[] = []
    data.stats.forEach((s, g) => {
      core.push(s.lowerFence, s.upperFence, s.q1, s.q3, s.median, data.means[g])
      for (const o of s.outliers) soft.push(o)
    })
    return robustValueRange(core, soft)
  }, [data])

  if (error) return <ChartError message={error} />
  if (!data) return <ChartLoading />

  // ENFORCED dataZoom-axes gate (ITEM-6): boxes self-host only a VALUE (y) zoom, so a declared
  // `dataZoomAxes` that omits `'y'` disables it. Unset / includes `'y'` ⇒ unchanged.
  const effDataZoom = gateValueDataZoom(dataZoom, dataZoomAxes)
  const zoomEnabled = effDataZoom !== false

  // The value-axis dataZoom WINDOW is owned by the core `ValueDataZoom` component (STEP 4); the
  // View becomes a passive consumer that RE-FRAMES the y bounds to the injected window. `dataZoom`
  // threads straight through (per-instance enable/disable preserved). `viz-box-value-zoom` is the
  // control testId — unchanged.
  return (
    <ValueDataZoom domain={valueRange} dataZoom={effDataZoom} testId="viz-box-value-zoom" dataZoomId={plotCellId}>
      {window => (
        <BoxBody
          axisTitles={axisTitles}
          typography={typography}
          data={data}
          valueRange={valueRange}
          window={window}
          zoomEnabled={zoomEnabled}
          emphasis={emphasis}
          showMean={showMean}
          showFrame={showFrame}
          showGrid={showGrid}
          theme={theme}
          axisPointer={axisPointer}
          transitions={transitions}
          overrides={overrides}
        />
      )}
    </ValueDataZoom>
  )
}

/** The passive box body: REACTS to the injected `window` by re-framing the y bounds. */
function BoxBody({
  data,
  valueRange,
  window,
  zoomEnabled,
  emphasis,
  showMean,
  showFrame,
  showGrid,
  theme,
  axisPointer,
  transitions,
  overrides,
  axisTitles,
  typography,
}: {
  data: BoxData
  valueRange: [number, number] | null
  window: ValueWindow | null
  zoomEnabled: boolean
  emphasis: GroupEmphasis
  showMean: boolean
  showFrame: boolean
  showGrid: boolean
  theme: ChartTheme
  axisPointer: boolean
  transitions?: TransitionProp
  overrides?: CategoricalOverrides
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}) {
  // Data-table row-hover / cross-plot hover → highlight the matching OUTLIER (a box only draws dots
  // for outliers, so the point surface IS the outlier cloud). `hoverHighlightIdx` is the ORIGINAL index.
  const hoverHighlightIdx = useHoverHighlightIndex()

  // OUTLIER GEOMETRY (per-POINT parity, mirroring ViolinView's jitter): map the outlier ScatterplotLayer's
  // picked index → the ORIGINAL point index (`layerToOriginal`, aligned to buildBoxProps' emission order:
  // visible-box order, then each box's sorted outliers) and, inversely, an ORIGINAL index → its outlier
  // world position (`originalToWorld`) for the highlight ring + tooltip. One O(N) pass records the first
  // original index per (code,value) that is a rendered outlier; unmatched outliers map to -1.
  const outlierGeom = useMemo(() => {
    if (!data) return null
    const { items: vStats, codes: vCodes } = visibleByCode(data.stats, overrides?.hiddenCodes)
    const wanted = new Map<number, Set<number>>()
    vStats.forEach((s, i) => {
      if (s.outliers.length === 0) return
      let set = wanted.get(vCodes[i])
      if (!set) { set = new Set<number>(); wanted.set(vCodes[i], set) }
      for (const o of s.outliers) set.add(o)
    })
    const idxByKey = new Map<string, number>()
    const n = Math.min(data.values.length, data.codes.length)
    for (let i = 0; i < n; i++) {
      const code = data.codes[i]
      const set = wanted.get(code)
      if (!set) continue
      const v = data.values[i]
      if (!set.has(v)) continue
      const key = `${code}:${v}`
      if (!idxByKey.has(key)) idxByKey.set(key, i)
    }
    const layerToOriginal: number[] = []
    const originalToWorld = new Map<number, [number, number]>()
    vStats.forEach((s, i) => {
      const cx = i // buildBoxProps spacing = 1 ⇒ centers[i] = i
      const code = vCodes[i]
      for (const o of s.outliers) {
        const orig = idxByKey.get(`${code}:${o}`) ?? -1
        layerToOriginal.push(orig)
        if (orig >= 0) originalToWorld.set(orig, [cx, o])
      }
    })
    return { layerToOriginal, originalToWorld }
  }, [data, overrides?.hiddenCodes])

  // Direct hover on an outlier dot (rAF-throttled — one setState/frame; gated to the outlier layer id).
  const [outlierPick, setOutlierPick] = useState<number | null>(null)
  const pickPending = useRef<number | null>(null)
  const pickRaf = useRef<number | null>(null)
  const flushPick = useCallback(() => {
    pickRaf.current = null
    setOutlierPick(pickPending.current)
  }, [])
  const handleOutlierHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      const id = typeof info?.layer?.id === 'string' ? info.layer.id : ''
      pickPending.current = info && info.index >= 0 && id.endsWith('viz-box-outliers') ? info.index : null
      if (typeof requestAnimationFrame === 'undefined') flushPick()
      else if (pickRaf.current == null) pickRaf.current = requestAnimationFrame(flushPick)
    },
    [flushPick],
  )
  useEffect(
    () => () => {
      if (pickRaf.current != null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(pickRaf.current)
    },
    [],
  )
  // Publish the hovered outlier's ORIGINAL index up so OTHER plots cross-highlight (null on leave).
  const publishHover = usePublishHover()
  useEffect(() => {
    if (outlierPick == null || !outlierGeom) {
      publishHover(null)
      return
    }
    const orig = outlierGeom.layerToOriginal[outlierPick]
    publishHover(orig != null && orig >= 0 ? orig : null)
  }, [outlierPick, outlierGeom, publishHover])
  // Release the cross-plot hover latch when this cell UNMOUNTS (removed / type-swapped mid-hover).
  useEffect(() => () => publishHover(null), [publishHover])

  const bounds = useMemo<[number, number, number, number] | null>(() => {
    if (!data || data.stats.length === 0 || !valueRange) return null
    // Frame only the VISIBLE group count so hidden groups collapse + the rest re-space edge-to-edge.
    const visibleCount = data.stats.length - (overrides?.hiddenCodes?.size ?? 0)
    if (visibleCount <= 0) return null
    const xLo = -0.6
    const xHi = visibleCount - 1 + 0.6
    // Frame the VALUE WINDOW on y when zoom is enabled; else the full robust range (byte-
    // unchanged free-camera framing).
    if (zoomEnabled) {
      if (!window) return null
      return boundsWithValueWindow(xLo, xHi, window)
    }
    return [xLo, valueRange[0], xHi, valueRange[1]]
  }, [data, valueRange, window, zoomEnabled, overrides?.hiddenCodes])

  const { selectedCodes, active } = emphasis
  const layers = useMemo<Layer[]>(() => {
    if (!data) return []
    // EFFECTIVE per-group palette (custom / by-name / auto-extended); no overrides ⇒ built-in
    // (byte-identical box fills).
    // HIDDEN groups (interactive legend / form): collapse them out — build only the VISIBLE groups so
    // their columns re-space (reflow). `vCodes[i]` is the ORIGINAL category code of visible box i, so
    // the palette + cross-plot emphasis still map by the true code even after the reflow.
    const { items: vStats, codes: vCodes } = visibleByCode(data.stats, overrides?.hiddenCodes)
    // Color by ORIGINAL code (index the full palette by vCodes) so a group keeps its color + matches its
    // legend swatch after a hide collapses the array (resolving by collapsed position would shift colors).
    const fullEffColors = resolveEffectivePalette(data.stats.map(s => s.group), overrides)
    const effColors = vCodes.map(c => fullEffColors[c] ?? categoryColor(c))
    const { boxes, lines, outliers, centers } = buildBoxProps(vStats, { colors: effColors })
    // Cross-plot emphasis: dim the IQR box body of every group NOT covered by the shared selection.
    // The mark index is the VISIBLE position; `vCodes[i]` recovers its category code for markOpacity.
    const boxData = active
      ? boxes.data.map((d, i) => ({
          ...d,
          fillColor: applyMarkOpacity(d.fillColor, markOpacity(vCodes[i], selectedCodes, true)),
        }))
      : boxes.data
    // OPT-IN GPU tweens (default off ⇒ no `transitions` key ⇒ instant): box fill recolor, and
    // the mean marker's position + fill (a data change moves it, a recolor tints it).
    const boxTx = deckTransitions(transitions, ['getFillColor'])
    const meanTx = deckTransitions(transitions, ['getPosition', 'getFillColor'])
    const out: Layer[] = [
      new SolidPolygonLayer({ ...boxes, data: boxData, ...(boxTx ? { transitions: boxTx } : {}) }),
      new LineLayer(lines),
    ]
    if (outliers) {
      // BUG FIX: the outlier ScatterplotLayer was pushed UNTOUCHED, ignoring the cross-plot selection
      // emphasis the IQR body honors — so selected/unselected outliers looked identical. Dim each
      // unselected outlier's ALPHA by its GROUP's markOpacity (the same per-group dim the box body uses).
      // The outlier order matches buildBoxProps (visible-box order, then each box's outliers).
      let outlierLayer = outliers
      if (active) {
        const dimmed = new Uint8Array(outliers.data.attributes.getFillColor.value)
        let k = 0
        vStats.forEach((s, i) => {
          const op = markOpacity(vCodes[i], selectedCodes, true)
          for (let j = 0; j < s.outliers.length; j++) {
            if (op !== 1) dimmed[k * 4 + 3] = Math.round(dimmed[k * 4 + 3] * op)
            k++
          }
        })
        outlierLayer = {
          ...outliers,
          data: {
            ...outliers.data,
            attributes: {
              ...outliers.data.attributes,
              getFillColor: { ...outliers.data.attributes.getFillColor, value: dimmed },
            },
          },
        }
      }
      out.push(new ScatterplotLayer(outlierLayer))
    }
    if (showMean) {
      // Hollow marker (white fill + dark ring) at each group's mean — visually distinct
      // from the median line and the (filled) outlier dots. Its fill/ring alpha dims in
      // lockstep with the group's box under a cross-plot selection.
      const marks = centers.map((cx, i) => {
        const op = markOpacity(vCodes[i], selectedCodes, active)
        return {
          position: [cx, data.means[vCodes[i]]] as [number, number],
          fill: applyMarkOpacity([255, 255, 255, 255], op),
          line: applyMarkOpacity([20, 20, 20, 255], op),
        }
      })
      out.push(
        new ScatterplotLayer<{
          position: [number, number]
          fill: [number, number, number, number]
          line: [number, number, number, number]
        }>({
          id: 'viz-box-mean',
          data: marks,
          getPosition: d => d.position,
          getRadius: 4,
          radiusUnits: 'pixels',
          radiusMinPixels: 3,
          getFillColor: d => d.fill,
          stroked: true,
          getLineColor: d => d.line,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          lineWidthMinPixels: 1.5,
          pickable: false,
          ...(meanTx ? { transitions: meanTx } : {}),
        }),
      )
    }
    // HOVER→HIGHLIGHT ring (data-table row hover OR a direct/cross-plot hover) — ONLY when the
    // highlighted point is a RENDERED OUTLIER (a box draws dots only for outliers, so a non-outlier has
    // no dot to ring). `outlierGeom.originalToWorld` gives the outlier's (group-center x, value y) or nothing.
    if (hoverHighlightIdx != null && outlierGeom) {
      const world = outlierGeom.originalToWorld.get(hoverHighlightIdx)
      if (world) {
        out.push(
          new ScatterplotLayer<{ position: [number, number] }>({
            id: 'viz-box-hover-highlight',
            data: [{ position: world }],
            getPosition: d => d.position,
            radiusUnits: 'pixels',
            getRadius: 5,
            radiusMinPixels: 4,
            filled: false,
            stroked: true,
            getLineColor: [255, 138, 0, 255],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            pickable: false,
          }),
        )
      }
    }
    if (showFrame && bounds) {
      const frame = buildChartFrameLayers({
        id: 'viz-box-frame',
        bounds,
        xTitle: axisTitles?.x ?? 'Group',
        yTitle: axisTitles?.y ?? 'Value',
        xTicks: categoryTicks(vStats.map(s => displayCategory(s.group, overrides?.categoryLabels))),
        showGrid,
        theme,
        font: chartFrameFont(typography),
      })
      return [...frame, ...clipToBounds(out, bounds)]
    }
    return out
  }, [data, showMean, bounds, showFrame, showGrid, theme, selectedCodes, active, transitions, overrides, typography, hoverHighlightIdx, outlierGeom])

  // Per-OUTLIER tooltip (group + value): follows the cross-plot highlighted point (`hoverHighlightIdx`
  // — a direct outlier hover via the publish round-trip OR a hover in another linked plot), and only
  // when that point is a rendered outlier. Gated by the global tooltip toggle (the ring shows regardless).
  const tooltipsOn = useTooltipsEnabled()
  const pointTooltip = useMemo(() => {
    if (!tooltipsOn || hoverHighlightIdx == null || !outlierGeom || !data) return null
    const world = outlierGeom.originalToWorld.get(hoverHighlightIdx)
    if (!world) return null
    const code = data.codes[hoverHighlightIdx]
    const group = displayCategory(data.categories[code] ?? String(code), overrides?.categoryLabels)
    return {
      world,
      rows: [
        { label: 'Group', value: group },
        { label: axisTitles?.y ?? 'Value', value: formatNumber(data.values[hoverHighlightIdx]) },
      ],
    }
  }, [tooltipsOn, hoverHighlightIdx, outlierGeom, data, overrides, axisTitles])

  // x = group categories (nearest-category snap); y = value (free, follows the cursor).
  const axisPointerTicks = useMemo(
    () =>
      data
        ? {
            x: categoryTicks(
              visibleByCode(data.stats, overrides?.hiddenCodes).items.map(s => displayCategory(s.group, overrides?.categoryLabels)),
            ),
          }
        : undefined,
    [data, overrides],
  )

  // Value-axis (y) zoom, NOT a free 2-D camera (when enabled): `controller={false}` kills deck's
  // pan/zoom and the core `ValueDataZoom` drives the value window (a vertical slider + wheel-zoom
  // about the cursor value; the group/x axis stays fixed). `dataZoom={false}` ⇒ `controller`
  // re-enabled for the plain free-camera chart.
  return (
    <ChartCanvas
      layers={layers}
      bounds={bounds ?? undefined}
      controller={!zoomEnabled}
      axisPointer={axisPointer}
      axisPointerTicks={axisPointerTicks}
      theme={theme}
      onHover={handleOutlierHover}
      pointTooltip={pointTooltip}
      testId="viz-box-view"
    />
  )
}
