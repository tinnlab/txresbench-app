// chartFrameGeometry.ts — the PURE data-space geometry of the GPU chart frame (ITEM-17 /
// DEC-23). It turns a chart's data bounds + tick spec into plain segment/label records
// (axis lines, gridlines, tick marks, tick labels, axis titles) — NO deck.gl, NO GL, NO
// DOM — so it unit-tests in node. `ChartFrame.tsx` is the thin wrapper that spreads these
// records into real `LineLayer` / `TextLayer` instances (mirrors the pure-builder →
// thin-layer split in `chartLayers.ts`). All positions are DATA-SPACE so the frame aligns
// exactly with the auto-fit OrthographicView; screen-pixel nudges ride `pixelOffset`
// (screen px, +y downward). Label text is kept ASCII (TextLayer's default character set).

import { niceTicks, formatTickValue, type CategoryTick } from './axisTicks'

/** [xMin, yMin, xMax, yMax] in data space. */
export type FrameBounds = [number, number, number, number]

/** Tick request per axis: `'nice'` = auto value ticks; else explicit category/positions. */
export type TickSpec = 'nice' | readonly CategoryTick[]

export type FrameRGBA = [number, number, number, number]

/** A data-space line segment (axis / gridline / tick mark). */
export interface FrameSegment {
  readonly source: [number, number]
  readonly target: [number, number]
}

/** A data-space text label with screen-pixel placement hints. */
export interface FrameLabel {
  readonly position: [number, number]
  readonly text: string
  readonly anchor: 'start' | 'middle' | 'end'
  readonly baseline: 'top' | 'center' | 'bottom'
  readonly pixelOffset: [number, number]
  /** Rotation in degrees (y-axis title is drawn vertical). */
  readonly angle: number
}

export interface ChartFrameGeometry {
  readonly axis: FrameSegment[]
  readonly grid: FrameSegment[]
  readonly ticks: FrameSegment[]
  readonly tickLabels: FrameLabel[]
  readonly titles: FrameLabel[]
}

export interface FrameGeometryOpts {
  readonly bounds: FrameBounds
  readonly xTitle?: string
  readonly yTitle?: string
  /** default `'nice'` (auto value ticks over the x span). */
  readonly xTicks?: TickSpec
  /** default `'nice'` (auto value ticks over the y span). */
  readonly yTicks?: TickSpec
  /** draw gridlines (default true). */
  readonly showGrid?: boolean
  /** value-tick target count when a `'nice'` axis is used (default 6). */
  readonly tickCount?: number
}

/** Fraction of the perpendicular span a tick mark extends past the axis. */
const TICK_LEN_FRAC = 0.02
/** Dashes per gridline + duty cycle (dash / dash+gap), for the dashed-grid look. */
const GRID_DASHES = 26
const GRID_DUTY = 0.55

function resolveTicks(spec: TickSpec | undefined, lo: number, hi: number, count: number): CategoryTick[] {
  if (spec && spec !== 'nice') return [...spec]
  return niceTicks(lo, hi, count).map(v => ({ pos: v, label: formatTickValue(v) }))
}

/** Segment a line into `dashes` on/off dashes (data-space) for a dashed gridline. */
function dashLine(
  source: [number, number],
  target: [number, number],
  dashes = GRID_DASHES,
  duty = GRID_DUTY,
): FrameSegment[] {
  const out: FrameSegment[] = []
  const dx = target[0] - source[0]
  const dy = target[1] - source[1]
  for (let i = 0; i < dashes; i++) {
    const t0 = i / dashes
    const t1 = (i + duty) / dashes
    out.push({
      source: [source[0] + dx * t0, source[1] + dy * t0],
      target: [source[0] + dx * t1, source[1] + dy * t1],
    })
  }
  return out
}

/**
 * Build the pure frame geometry for a value/value or category/value chart. The x-axis
 * sits along y = yMin, the y-axis along x = xMin; gridlines + tick marks + tick labels are
 * placed at each resolved tick; axis titles are centered on their axis (the y-title drawn
 * vertical via `angle`). Ticks at the axis origin are skipped for gridlines to avoid
 * double-drawing the axis line. Pure.
 */
export function buildChartFrameGeometry(opts: FrameGeometryOpts): ChartFrameGeometry {
  const [xMin, yMin, xMax, yMax] = opts.bounds
  const count = opts.tickCount ?? 6
  const showGrid = opts.showGrid ?? true
  const xSpan = xMax - xMin || 1
  const ySpan = yMax - yMin || 1

  const xTicks = resolveTicks(opts.xTicks, xMin, xMax, count)
  const yTicks = resolveTicks(opts.yTicks, yMin, yMax, count)

  // Axis lines: bottom (x) + left (y).
  const axis: FrameSegment[] = [
    { source: [xMin, yMin], target: [xMax, yMin] },
    { source: [xMin, yMin], target: [xMin, yMax] },
  ]

  const grid: FrameSegment[] = []
  const ticks: FrameSegment[] = []
  const tickLabels: FrameLabel[] = []

  const xTickLen = ySpan * TICK_LEN_FRAC
  const yTickLen = xSpan * TICK_LEN_FRAC

  // `niceTicks` returns ASCENDING positions even for a reversed [max,min] bound, so filter against
  // the NORMALIZED range — else a reversed axis would drop every tick/label/gridline.
  const [xLo, xHi] = [Math.min(xMin, xMax), Math.max(xMin, xMax)]
  const [yLo, yHi] = [Math.min(yMin, yMax), Math.max(yMin, yMax)]
  for (const t of xTicks) {
    if (t.pos < xLo || t.pos > xHi) continue
    // gridline (vertical), skipping the one coincident with the left axis
    if (showGrid && Math.abs(t.pos - xMin) > xSpan * 1e-6) {
      grid.push(...dashLine([t.pos, yMin], [t.pos, yMax]))
    }
    // tick mark below the axis
    ticks.push({ source: [t.pos, yMin], target: [t.pos, yMin - xTickLen] })
    tickLabels.push({
      position: [t.pos, yMin],
      text: t.label,
      anchor: 'middle',
      baseline: 'top',
      pixelOffset: [0, 8],
      angle: 0,
    })
  }

  for (const t of yTicks) {
    if (t.pos < yLo || t.pos > yHi) continue
    if (showGrid && Math.abs(t.pos - yMin) > ySpan * 1e-6) {
      grid.push(...dashLine([xMin, t.pos], [xMax, t.pos]))
    }
    ticks.push({ source: [xMin, t.pos], target: [xMin - yTickLen, t.pos] })
    tickLabels.push({
      position: [xMin, t.pos],
      text: t.label,
      anchor: 'end',
      baseline: 'center',
      pixelOffset: [-8, 0],
      angle: 0,
    })
  }

  const titles: FrameLabel[] = []
  if (opts.xTitle) {
    titles.push({
      position: [(xMin + xMax) / 2, yMin],
      text: opts.xTitle,
      anchor: 'middle',
      baseline: 'top',
      pixelOffset: [0, 30],
      angle: 0,
    })
  }
  if (opts.yTitle) {
    titles.push({
      position: [xMin, (yMin + yMax) / 2],
      text: opts.yTitle,
      anchor: 'middle',
      baseline: 'bottom',
      pixelOffset: [-42, 0],
      angle: 90,
    })
  }

  return { axis, grid, ticks, tickLabels, titles }
}
