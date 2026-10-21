// HistogramView.tsx — the histogram VIEW (DEC-18: SolidPolygonLayer binned rects).
// Data-shaping (a continuous column → uniform bin edges + counts) is the pure exported
// `histogramFromColumn` helper; the component wires load → helper →
// `buildHistogramProps` → layer → `ChartCanvas`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAsyncChartData, ChartError, ChartLoading } from './useAsyncChartData'
import { SolidPolygonLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { ChartCanvas } from './ChartCanvas'
import { useTooltipsEnabled } from './plotCellId'
import { formatNumber } from '../tooltip/tooltipModel'
import { buildHistogramProps } from './chartLayers'
import { chartFrameFont, type Typography } from '../controls/typography'
import { deckTransitions, type TransitionProp } from './transitions'
import { buildChartFrameLayers, defaultChartTheme, type ChartTheme } from './ChartFrame'
import { clipToBounds } from './clip'
import { formatTickValue } from './axisTicks'
import { getComputeDevice } from '../gpu/computeDevice'
import { histogramGpu } from './aggregateGpu'
import type { DataSource } from '../data/wire'

export interface Histogram {
  /** Bin boundaries, length `bins + 1`. */
  readonly binEdges: number[]
  /** Count per bin, length `bins`. */
  readonly counts: number[]
}

/**
 * Bin a value column into `bins` uniform-width buckets over [min, max]. Degenerate:
 * empty → no bins; a flat column (min == max) → a single unit-width bin holding every
 * value. Non-finite values are skipped. Pure — no GL, no I/O.
 */
export function histogramFromColumn(values: ArrayLike<number>, bins = 30): Histogram {
  const nBins = Math.max(1, Math.floor(bins))
  let lo = Infinity
  let hi = -Infinity
  let count = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
    count++
  }
  if (count === 0) return { binEdges: [], counts: [] }
  if (lo === hi) return { binEdges: [lo, lo + 1], counts: [count] }

  const width = (hi - lo) / nBins
  const binEdges = Array.from({ length: nBins + 1 }, (_, i) => lo + i * width)
  const counts = new Array<number>(nBins).fill(0)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    // clamp the max into the last bin (right edge is inclusive).
    const b = Math.min(nBins - 1, Math.floor((v - lo) / width))
    counts[b]++
  }
  return { binEdges, counts }
}

export interface HistogramViewProps {
  source: DataSource
  /** continuous column id */
  valueKey: string
  bins?: number
  /** Draw the axes / ticks / labels / gridlines frame (default true). */
  showFrame?: boolean
  /** Draw gridlines within the frame (default true). */
  showGrid?: boolean
  /** Theme-aware chrome colors (DEC-39); defaults to the light theme. */
  theme?: ChartTheme
  /** Opt-in axis-pointer crosshair (ITEM-33); default off. x snaps to the bin edges, y is a free count axis. */
  axisPointer?: boolean
  /**
   * OPT-IN per-plot animated transitions (default OFF). `false`/omitted ⇒ instant (byte-identical
   * to today); `{ duration?, easing? }` ⇒ the bin rects' fill GPU-interpolates (`getFillColor`).
   * Bin GEOMETRY (a re-bin) is a polygon rebuild, not an attribute tween. Mirrors `dataZoom`'s shape.
   */
  transitions?: TransitionProp
  /** Plot-editing (ITEM-4): per-cell x/y AXIS title overrides (declarative). Absent ⇒ default. */
  axisTitles?: { x?: string; y?: string }
  /** Typography (font family + tick/axis-title sizes) for the chart frame. */
  typography?: Typography
}

export function HistogramView({
  source,
  valueKey,
  bins,
  showFrame = true,
  showGrid = true,
  theme = defaultChartTheme(),
  axisPointer = false,
  transitions,
  axisTitles,
  typography,
}: HistogramViewProps) {
  const { data: hist, error } = useAsyncChartData<Histogram>(async isAlive => {
    const col = await source.continuous(valueKey)
    // Prefer the GPU binning (auto-falls back to the CPU `histogramFromColumn` oracle
    // when no compute device); bins/counts stay identical.
    const device = await getComputeDevice()
    const next = await histogramGpu(col.value, bins, device)
    if (!isAlive()) return undefined
    return next
  }, [source, valueKey, bins])

  const bounds = useMemo<[number, number, number, number] | null>(() => {
    if (!hist || hist.binEdges.length < 2) return null
    const xMin = hist.binEdges[0]
    const xMax = hist.binEdges[hist.binEdges.length - 1]
    let yMax = 0
    for (const c of hist.counts) if (c > yMax) yMax = c
    return [xMin, 0, xMax, yMax * 1.05 || 1]
  }, [hist])

  const layers = useMemo<Layer[]>(() => {
    if (!hist) return []
    // OPT-IN GPU tween on the fill recolor (default off ⇒ no `transitions` key ⇒ instant).
    const tx = deckTransitions(transitions, ['getFillColor'])
    const data: Layer[] = [
      new SolidPolygonLayer({
        ...buildHistogramProps(hist.binEdges, hist.counts),
        ...(tx ? { transitions: tx } : {}),
      }),
    ]
    if (showFrame && bounds) {
      const frame = buildChartFrameLayers({
        id: 'viz-histogram-frame',
        bounds,
        xTitle: axisTitles?.x ?? 'Value',
        yTitle: axisTitles?.y ?? 'Count',
        showGrid,
        theme,
        font: chartFrameFont(typography),
      })
      return [...frame, ...clipToBounds(data, bounds)]
    }
    return data
  }, [hist, bounds, showFrame, showGrid, theme, transitions, typography])

  // x = value bins (snap the vertical guide to the nearest bin edge); y = count (free).
  const axisPointerTicks = useMemo(
    () =>
      hist && hist.binEdges.length >= 2
        ? { x: hist.binEdges.map(e => ({ pos: e, label: formatTickValue(e) })) }
        : undefined,
    [hist],
  )

  // Per-BIN hover TOOLTIP (AGGREGATE chart — a bin is a range, not a point, so NO cross-plot
  // publish/ring, only a tooltip). `binMeta` mirrors the layer's rect order (one rect per bin) so a
  // picked rect index resolves to its [x0,x1] range + count + a top-center anchor.
  const binMeta = useMemo(() => {
    if (!hist || hist.binEdges.length < 2) return null
    const n = Math.min(hist.counts.length, hist.binEdges.length - 1)
    const meta: { x0: number; x1: number; count: number; world: [number, number] }[] = []
    for (let i = 0; i < n; i++) {
      const x0 = hist.binEdges[i]
      const x1 = hist.binEdges[i + 1]
      const count = hist.counts[i]
      meta.push({ x0, x1, count, world: [(x0 + x1) / 2, count] })
    }
    return meta
  }, [hist])

  // Direct hover on a bin (rAF-throttled — one setState/frame; gated to the histogram layer id).
  const [binPick, setBinPick] = useState<number | null>(null)
  const pickPending = useRef<number | null>(null)
  const pickRaf = useRef<number | null>(null)
  const flushPick = useCallback(() => {
    pickRaf.current = null
    setBinPick(pickPending.current)
  }, [])
  const handleBinHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      const id = typeof info?.layer?.id === 'string' ? info.layer.id : ''
      pickPending.current = info && info.index >= 0 && id.endsWith('viz-histogram') ? info.index : null
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
    if (!tooltipsOn || binPick == null || !binMeta) return null
    const m = binMeta[binPick]
    if (!m) return null
    return {
      world: m.world,
      rows: [
        { label: axisTitles?.x ?? 'Value', value: `${formatNumber(m.x0)} – ${formatNumber(m.x1)}` },
        { label: axisTitles?.y ?? 'Count', value: formatNumber(m.count) },
      ],
    }
  }, [tooltipsOn, binPick, binMeta, axisTitles])

  if (error) return <ChartError message={error} />
  if (!hist) return <ChartLoading />
  return (
    <ChartCanvas
      layers={layers}
      bounds={bounds ?? undefined}
      axisPointer={axisPointer}
      axisPointerTicks={axisPointerTicks}
      theme={theme}
      onHover={handleBinHover}
      pointTooltip={pointTooltip}
      testId="viz-histogram-view"
    />
  )
}
