// BarView.tsx — the bar-chart VIEW (DEC-18: SolidPolygonLayer rects, grouped /
// stacked / percent). Data-shaping (a categorical column → per-category counts as
// `BarSeries[]`) is the pure exported `barSeriesFromCategorical` helper; the component
// wires load → helper → `buildBarProps` → layer → `ChartCanvas`.
//
// STEP 3-4 (EXTENSIBILITY_STUDY): the cross-plot selection EMPHASIS is read through the
// injected `coordination` handle, and the value-axis dataZoom WINDOW is owned by the core
// `ValueDataZoom` component (not this View). `BarView` is a thin OUTER that loads +
// computes the count domain + reads the emphasis; `BarBody` re-frames to the injected window.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PlotCellIdContext, usePublishPlotData, useTooltipsEnabled } from './plotCellId'
import { useAsyncChartData, ChartError, ChartLoading } from './useAsyncChartData'
import { formatNumber } from '../tooltip/tooltipModel'
import { SolidPolygonLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas } from './ChartCanvas'
import { type DataZoomConfig } from './AxisDataZoom'
import { ValueDataZoom } from '../datazoom/DataZoom'
import { boundsWithValueWindow } from './plotWindow'
import { type ValueWindow } from './valueWindow'
import { buildBarProps, type BarMode, type BarSeries } from './chartLayers'
import { deckTransitions, type TransitionProp } from './transitions'
import { barSeriesFromCategoricalGpu } from './aggregateGpu'
import { getComputeDevice } from '../gpu/computeDevice'
import { buildChartFrameLayers, defaultChartTheme, type ChartTheme } from './ChartFrame'
import { clipToBounds } from './clip'
import { categoryTicks } from './axisTicks'
import { displayCategory, resolveEffectivePalette, visibleByCode, categoryColor, type CategoricalOverrides } from '../data/color'
import { chartFrameFont, type Typography } from '../controls/typography'
import { defaultCoordinationHandle } from '../../adapter/coordinationHandle'
import type { CoordinationHandle } from '../registry/types'
import { applyMarkOpacity, markOpacity, type GroupEmphasis } from '../coordination/selectionSync'
import { gateGroupEmphasis, gateValueDataZoom } from './capabilityGates'
import type { CategoricalColumn, DataSource } from '../data/wire'

/** Reused empty codes column so the emphasis memo has a stable input before load. */
const EMPTY_CODES = new Uint16Array(0)

/**
 * Turn a categorical column into per-category count bars (`BarSeries[]`, one single-
 * value series per category): tally each point into its category bucket. Codes outside
 * the category range are ignored. Pure — no GL, no I/O.
 */
/** ITEM-13: the bar VALUE (y) axis domain — ALWAYS anchored at 0 (a count/magnitude bar truncated above 0
 *  is the classic misleading figure). `yMax` is the tallest visible bar; a little headroom is added, and an
 *  all-zero series still yields a unit range. The baseline is NOT a free parameter — it is fixed at 0. */
export function barValueDomain(yMax: number): [number, number] {
  return [0, yMax * 1.05 || 1]
}

export function barSeriesFromCategorical(cat: CategoricalColumn): BarSeries[] {
  const counts = new Array<number>(cat.categories.length).fill(0)
  for (let i = 0; i < cat.codes.length; i++) {
    const c = cat.codes[i]
    if (c < counts.length) counts[c]++
  }
  return cat.categories.map((category, i) => ({ category, values: [counts[i]] }))
}

export interface BarViewProps {
  source: DataSource
  groupKey: string
  mode?: BarMode
  /** Draw the axes / ticks / labels / gridlines frame (default true). */
  showFrame?: boolean
  /** Draw gridlines within the frame (default true). */
  showGrid?: boolean
  /** Theme-aware chrome colors (DEC-39); defaults to the light theme. */
  theme?: ChartTheme
  /** Opt-in axis-pointer crosshair (ITEM-33); default off. x snaps to the bar categories, y is a free count axis. */
  axisPointer?: boolean
  /**
   * Per-instance VALUE-axis (y / count) dataZoom config: `false` disables the zoom UI entirely
   * (plain free-camera chart, byte-unchanged); `{ y, wheel }` picks the value axis' control kind
   * (`'slider'|'inside'|'both'|'off'`) + the wheel gate. The category (x) axis is never zoomed.
   * Default (omitted) = the wrapper's own default (a count slider + wheel — `ValueAxisZoom`'s
   * `DEFAULT_Y_MODE` = `{ y: 'both' }`), which reframes the y-bounds to the window (bars are
   * re-framed, never re-aggregated).
   */
  dataZoom?: false | DataZoomConfig
  /**
   * OPT-IN per-plot animated transitions (default OFF). `false`/omitted ⇒ a recolor / data change
   * SNAPS (byte-identical to today, so pixel-immediate e2e stays green); `{ duration?, easing? }`
   * ⇒ the bar rects' fill GPU-interpolates (`getFillColor`). Bar GEOMETRY (heights) is a polygon
   * rebuild, not an attribute tween, so a count change re-lays-out instantly while the recolor
   * tweens. Mirrors the per-plot `dataZoom` config shape.
   */
  transitions?: TransitionProp
  /** The Selection coordination handle (STEP 3); defaults to the store-backed singleton. */
  coordination?: CoordinationHandle
  /** ENFORCED capability (Area B, ITEM-5). `false` ⇒ this View does NOT consume the shared
   *  selection (no group-bar emphasis / dim). Unset/true ⇒ consume (byte-identical). */
  consumesSelection?: boolean
  /** ENFORCED capability (Area B, ITEM-6). The axes this View's self-hosted value zoom honors.
   *  Bars zoom only the value (y) axis, so a set lacking `'y'` disables the zoom. Unset ⇒ default. */
  dataZoomAxes?: readonly ('x' | 'y')[]
  /**
   * OPTIONAL categorical overrides — `categoryColors`/`palette` recolor the per-category count bars
   * (via `resolveEffectivePalette`), and `categoryLabels` renames the category AXIS ticks. Absent ⇒
   * the built-in per-category palette + raw names. Export picks both up (bar fills + rendered frame).
   */
  overrides?: CategoricalOverrides
  /** Plot-editing (ITEM-4): per-cell x/y AXIS title overrides (declarative). Absent field ⇒ the
   *  View's default title (byte-identical). */
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}

interface BarFrame {
  xLo: number
  xHi: number
  yLo: number
  yHi: number
}

export function BarView({
  source,
  groupKey,
  mode,
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
}: BarViewProps) {
  // The cell's STABLE dataZoom id (ITEM-20): when this View renders inside a grid cell, `CellView`
  // publishes the cell id here so the window lives in the PlotInteraction store (restore applies).
  // Outside a grid cell (a story) it's `undefined` ⇒ the byte-identical local-`useState` DataZoom.
  const plotCellId = useContext(PlotCellIdContext)
  // Per-point group codes — map a shared point-selection to the category bars it covers
  // (cross-plot emphasis). Bars are one-per-category in code order, so a bar's INDEX
  // equals its group code. Set from inside the loader (under its try/catch).
  const [catCodes, setCatCodes] = useState<Uint16Array | null>(null)

  const { data: series, error } = useAsyncChartData<BarSeries[]>(async isAlive => {
    const cat = await source.categorical(groupKey)
    // Prefer the GPU count aggregation (auto-falls back to the CPU
    // `barSeriesFromCategorical` oracle when no compute device); counts stay identical.
    const device = await getComputeDevice()
    const next = await barSeriesFromCategoricalGpu(cat, device)
    if (!isAlive()) return undefined
    setCatCodes(cat.codes)
    return next
  }, [source, groupKey])

  // Publish the plotted per-category counts to the pane's "Plot data" table (VISIBLE categories only).
  usePublishPlotData(() => {
    if (!series) return null
    const { items: vSeries } = visibleByCode(series, overrides?.hiddenCodes)
    return {
      columns: ['category', 'count'],
      rows: vSeries.map(s => [displayCategory(s.category, overrides?.categoryLabels), s.values[0] ?? 0]),
    }
  }, [series, overrides])

  // Cross-plot selection emphasis (DEC-25 / ITEM-25) — READ THROUGH the coordination handle
  // (STEP 3): the bar chart emphasises the category bars a shared point-selection covers and dims
  // the rest. O(categories) per-mark opacity, no per-point loop.
  // ENFORCED consume gate (ITEM-5): `consumesSelection:false` ⇒ discard the shared emphasis (the
  // INACTIVE result never dims). Unset/true ⇒ the real emphasis (byte-identical).
  const emphasis = gateGroupEmphasis(coordination.useGroupEmphasis(catCodes ?? EMPTY_CODES), consumesSelection)

  // The x extent + full value (count) range: x labels get padding, y runs from 0 with a little
  // headroom (the domain the count slider spans + the un-zoomed y-frame).
  const frame = useMemo<BarFrame | null>(() => {
    if (!series || series.length === 0) return null
    // Frame only the VISIBLE categories so hidden bars collapse + the rest re-space, and y fits the
    // remaining counts (hiding the tallest bar rescales the axis).
    const { items: vSeries } = visibleByCode(series, overrides?.hiddenCodes)
    if (vSeries.length === 0) return null
    const props = buildBarProps(vSeries, { mode })
    let xMin = Infinity
    let xMax = -Infinity
    let yMax = 0
    for (const r of props.data) {
      if (r.x0 < xMin) xMin = r.x0
      if (r.x1 > xMax) xMax = r.x1
      if (r.y1 > yMax) yMax = r.y1
    }
    if (!Number.isFinite(xMin)) return null
    const [yLo, yHi] = barValueDomain(yMax) // ITEM-13: baseline fixed at 0
    return { xLo: xMin - 0.2, xHi: xMax + 0.2, yLo, yHi }
  }, [series, mode, overrides?.hiddenCodes])

  // The value (count) domain the core `ValueDataZoom` owns — a STABLE reference (memoized off
  // `frame`) so the window resets only when the frame changes, matching the legacy `[frame]` dep.
  const valueDomain = useMemo<[number, number] | null>(
    () => (frame ? [frame.yLo, frame.yHi] : null),
    [frame],
  )

  if (error) return <ChartError message={error} />
  if (!series) return <ChartLoading />

  // ENFORCED dataZoom-axes gate (ITEM-6): bars self-host only a VALUE (y) zoom, so a declared
  // `dataZoomAxes` that omits `'y'` (e.g. `[]`) disables it. Unset / includes `'y'` ⇒ unchanged.
  const effDataZoom = gateValueDataZoom(dataZoom, dataZoomAxes)
  const zoomEnabled = effDataZoom !== false

  // Value-axis (y / count) dataZoom WINDOW owned by the core `ValueDataZoom` (STEP 4); the View
  // RE-FRAMES to it. `viz-bar-value-zoom` control testId unchanged; per-instance enable/disable
  // preserved (`dataZoom` threads through).
  return (
    <ValueDataZoom domain={valueDomain} dataZoom={effDataZoom} testId="viz-bar-value-zoom" dataZoomId={plotCellId}>
      {window => (
        <BarBody
          axisTitles={axisTitles}
          typography={typography}
          series={series}
          frame={frame}
          mode={mode}
          window={window}
          zoomEnabled={zoomEnabled}
          emphasis={emphasis}
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

/** The passive bar body: REACTS to the injected `window` by re-framing the count (y) bounds. */
function BarBody({
  series,
  frame,
  mode,
  window,
  zoomEnabled,
  emphasis,
  showFrame,
  showGrid,
  theme,
  axisPointer,
  transitions,
  overrides,
  axisTitles,
  typography,
}: {
  series: BarSeries[]
  frame: BarFrame | null
  mode?: BarMode
  window: ValueWindow | null
  zoomEnabled: boolean
  emphasis: GroupEmphasis
  showFrame: boolean
  showGrid: boolean
  theme: ChartTheme
  axisPointer: boolean
  transitions?: TransitionProp
  overrides?: CategoricalOverrides
  axisTitles?: { x?: string; y?: string }
  typography?: Typography
}) {
  const { selectedCodes, active } = emphasis

  // Per-BAR hover TOOLTIP (AGGREGATE chart — a bar is a CATEGORY, not a point, so NO cross-plot
  // publish/ring, only a tooltip). `barMeta` mirrors the layer's rect order (visible categories via
  // buildBarProps) so a picked rect index resolves to its category + value + a top-center anchor.
  const barMeta = useMemo(() => {
    if (!series) return null
    const { items: vSeries } = visibleByCode(series, overrides?.hiddenCodes)
    const props = buildBarProps(vSeries, { mode })
    return props.data.map(r => ({
      category: displayCategory(r.category, overrides?.categoryLabels),
      value: r.y1 - r.y0,
      world: [(r.x0 + r.x1) / 2, r.y1] as [number, number],
    }))
  }, [series, mode, overrides])

  // Direct hover on a bar (rAF-throttled — one setState/frame; gated to the bar layer id).
  const [barPick, setBarPick] = useState<number | null>(null)
  const pickPending = useRef<number | null>(null)
  const pickRaf = useRef<number | null>(null)
  const flushPick = useCallback(() => {
    pickRaf.current = null
    setBarPick(pickPending.current)
  }, [])
  const handleBarHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      const id = typeof info?.layer?.id === 'string' ? info.layer.id : ''
      pickPending.current = info && info.index >= 0 && id.endsWith('viz-bar') ? info.index : null
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
  const tooltipsOn = useTooltipsEnabled()
  const pointTooltip = useMemo(() => {
    if (!tooltipsOn || barPick == null || !barMeta) return null
    const m = barMeta[barPick]
    if (!m) return null
    return {
      world: m.world,
      rows: [
        { label: axisTitles?.x ?? 'Category', value: m.category },
        { label: axisTitles?.y ?? 'Count', value: formatNumber(m.value) },
      ],
    }
  }, [tooltipsOn, barPick, barMeta, axisTitles])

  const bounds = useMemo<[number, number, number, number] | null>(() => {
    if (!frame) return null
    if (zoomEnabled) {
      if (!window) return null
      return boundsWithValueWindow(frame.xLo, frame.xHi, window)
    }
    return [frame.xLo, frame.yLo, frame.xHi, frame.yHi]
  }, [frame, window, zoomEnabled])

  const layers = useMemo<Layer[]>(() => {
    if (!series) return []
    // Per-group bar colors: the effective palette (built-in + per-group overrides) indexed by category
    // code, so a form recolor reaches the bars (mirrors box/violin). Category order = code order.
    // HIDDEN categories (legend / form): collapse them so the bars re-space (reflow). `vCodes[i]` is
    // the ORIGINAL code of visible bar i (palette + emphasis map by the true code after the reflow).
    const { items: vSeries, codes: vCodes } = visibleByCode(series, overrides?.hiddenCodes)
    // Color by ORIGINAL code (index the full palette by vCodes) so a bar keeps its color + matches its
    // legend swatch after a hide collapses the array.
    const fullBarColors = resolveEffectivePalette(series.map(s => s.category), overrides)
    const barColors = vCodes.map(c => fullBarColors[c] ?? categoryColor(c))
    const barProps = buildBarProps(vSeries, { mode, colors: barColors })
    // Cross-plot emphasis: dim every category bar NOT covered by the selection. The mark index is the
    // VISIBLE position; `vCodes[i]` recovers its category code for markOpacity.
    const barData = active
      ? barProps.data.map((d, i) => ({
          ...d,
          fillColor: applyMarkOpacity(d.fillColor, markOpacity(vCodes[i], selectedCodes, true)),
        }))
      : barProps.data
    // OPT-IN GPU tween on the fill recolor (default off ⇒ no `transitions` key ⇒ instant).
    const tx = deckTransitions(transitions, ['getFillColor'])
    const data: Layer[] = [
      new SolidPolygonLayer({ ...barProps, data: barData, ...(tx ? { transitions: tx } : {}) }),
    ]
    if (showFrame && bounds) {
      const frameLayers = buildChartFrameLayers({
        id: 'viz-bar-frame',
        bounds,
        xTitle: axisTitles?.x ?? 'Category',
        yTitle: axisTitles?.y ?? 'Count',
        xTicks: categoryTicks(vSeries.map(s => displayCategory(s.category, overrides?.categoryLabels))),
        showGrid,
        theme,
        font: chartFrameFont(typography),
      })
      return [...frameLayers, ...clipToBounds(data, bounds)]
    }
    return data
  }, [series, mode, bounds, showFrame, showGrid, theme, selectedCodes, active, transitions, overrides, typography])

  // x = bar categories (nearest-category snap); y = count (free, follows the cursor).
  const axisPointerTicks = useMemo(
    () =>
      series
        ? {
            x: categoryTicks(
              visibleByCode(series, overrides?.hiddenCodes).items.map(s => displayCategory(s.category, overrides?.categoryLabels)),
            ),
          }
        : undefined,
    [series, overrides],
  )

  // Value-axis (y / count) zoom, NOT a free 2-D camera (when enabled): `controller={false}` kills
  // deck's pan/zoom and the core `ValueDataZoom` drives the count window; `dataZoom={false}` ⇒
  // `controller` re-enabled for the plain free-camera chart.
  return (
    <ChartCanvas
      layers={layers}
      bounds={bounds ?? undefined}
      controller={!zoomEnabled}
      axisPointer={axisPointer}
      axisPointerTicks={axisPointerTicks}
      theme={theme}
      onHover={handleBarHover}
      pointTooltip={pointTooltip}
      testId="viz-bar-view"
    />
  )
}
