// axisPointer.ts — the PURE geometry of the ECharts-style AXIS-POINTER crosshair for the
// GPU chart family (violin / box / volcano / dotplot / heatmap / bar / histogram). Given
// the plot rect (data bounds) + a pointer position — either WORLD coords (deck's
// `info.coordinate`) or a PIXEL + an ortho viewport to unproject — it computes:
//   (a) the crosshair GUIDE-LINE segments (a vertical x-line + a horizontal y-line spanning
//       the plot rect), in DATA space so they co-register with ChartCanvas's OrthographicView;
//   (b) the SNAPPED axis value(s) — nearest tick / category label, or the raw interpolated
//       value formatted, per axis;
//   (c) the tooltip PIXEL anchor.
// NO deck.gl, NO GL, NO DOM — so it unit-tests in node. Domain-agnostic (DEC-28). The thin
// deck.gl LineLayer wrapper + the DOM tooltip badge live in `AxisPointerOverlay.tsx` (mirrors
// the pure-geometry → thin-layer split in `chartFrameGeometry.ts` / `ChartFrame.tsx`).

import { formatTickValue, type CategoryTick } from './axisTicks'
import type { FrameBounds, FrameSegment } from './chartFrameGeometry'

/** Which guide lines to draw: vertical only / horizontal only / both. */
export type AxisPointerMode = 'x' | 'y' | 'cross'

/**
 * The ortho projection state needed to convert pixel ⇄ world. Matches ChartCanvas's
 * `OrthographicView`: `zoom` is deck's absolute log2 scale (2^zoom px per world unit),
 * a scalar for equal-aspect or a `[zoomX, zoomY]` pair for the independent-axis fit; the
 * `target` is the world point at the viewport CENTER; `flipY` mirrors the view's flag
 * (false = value-up charts, true = row-0-at-top matrices).
 */
export interface OrthoViewport {
  readonly width: number
  readonly height: number
  readonly target: readonly [number, number]
  readonly zoom: number | readonly [number, number]
  readonly flipY?: boolean
}

/** A resolved axis readout: the guide-line data-space position + its display label. */
export interface AxisValue {
  /** Data-space position the guide line is drawn at (snapped to a tick, or the raw value). */
  readonly pos: number
  /** Display label (a category/tick label when snapped, else the formatted value). */
  readonly label: string
  /** True when `pos` was snapped to a supplied tick/category. */
  readonly snapped: boolean
}

export interface AxisPointerInput {
  /** Plot rect in data space `[xMin, yMin, xMax, yMax]`. */
  readonly bounds: FrameBounds
  /** Guide lines to draw (default `'cross'`). */
  readonly mode?: AxisPointerMode
  /** Pointer in WORLD coords (e.g. deck.gl `info.coordinate`). Preferred when available. */
  readonly world?: readonly [number, number] | null
  /** Pointer in PIXEL coords (canvas-relative). Used with `viewport` when `world` is absent. */
  readonly pixel?: readonly [number, number] | null
  /** Ortho viewport — required to unproject `pixel`, and to project the tooltip anchor. */
  readonly viewport?: OrthoViewport
  /** X-axis ticks/categories to snap to; omit for a free value axis. */
  readonly xTicks?: readonly CategoryTick[]
  /** Y-axis ticks/categories to snap to; omit for a free value axis. */
  readonly yTicks?: readonly CategoryTick[]
  /** Snap the x guide to the nearest x tick (default: true when `xTicks` is non-empty). */
  readonly snapX?: boolean
  /** Snap the y guide to the nearest y tick (default: true when `yTicks` is non-empty). */
  readonly snapY?: boolean
}

export interface AxisPointerResult {
  /** True when the pointer resolves inside the plot rect (else there is no crosshair). */
  readonly inPlot: boolean
  /** The pointer position in data space (`[NaN, NaN]` when unresolvable). */
  readonly world: [number, number]
  /** Crosshair guide-line segments in DATA space (empty when out of plot). */
  readonly segments: FrameSegment[]
  /** Snapped x readout (present for `'x'` / `'cross'` when in plot). */
  readonly x?: AxisValue
  /** Snapped y readout (present for `'y'` / `'cross'` when in plot). */
  readonly y?: AxisValue
  /** Tooltip anchor in PIXEL coords (present when derivable from `pixel` or `viewport`). */
  readonly anchorPixel?: [number, number]
}

function zoomPair(zoom: number | readonly [number, number]): [number, number] {
  return Array.isArray(zoom) ? [zoom[0], zoom[1]] : [zoom as number, zoom as number]
}

/**
 * Project a DATA-space point to canvas PIXELS under an ortho viewport. Mirror of deck.gl's
 * `OrthographicView`: `scale = 2^zoom` px per world unit; `target` maps to the viewport
 * center; y flips per the view's `flipY` (false = up, true = down). Pure.
 */
export function worldToPixel(vp: OrthoViewport, world: readonly [number, number]): [number, number] {
  const [zx, zy] = zoomPair(vp.zoom)
  const sx = 2 ** zx
  const sy = 2 ** zy
  const px = vp.width / 2 + (world[0] - vp.target[0]) * sx
  const dy = (world[1] - vp.target[1]) * sy
  const py = vp.flipY ? vp.height / 2 + dy : vp.height / 2 - dy
  return [px, py]
}

/** Inverse of {@link worldToPixel}: canvas PIXELS → DATA-space point. Pure. */
export function pixelToWorld(vp: OrthoViewport, pixel: readonly [number, number]): [number, number] {
  const [zx, zy] = zoomPair(vp.zoom)
  const sx = 2 ** zx
  const sy = 2 ** zy
  const x = vp.target[0] + (pixel[0] - vp.width / 2) / sx
  const dy = pixel[1] - vp.height / 2
  const y = vp.flipY ? vp.target[1] + dy / sy : vp.target[1] - dy / sy
  return [x, y]
}

/** Resolve a raw world coordinate to a snapped-or-free axis readout. Pure. */
function resolveAxis(
  world: number,
  ticks: readonly CategoryTick[] | undefined,
  snap: boolean | undefined,
): AxisValue {
  const doSnap = snap ?? (!!ticks && ticks.length > 0)
  if (doSnap && ticks && ticks.length > 0) {
    let best = ticks[0]
    let bestD = Math.abs(ticks[0].pos - world)
    for (const t of ticks) {
      const d = Math.abs(t.pos - world)
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
    return { pos: best.pos, label: best.label, snapped: true }
  }
  return { pos: world, label: formatTickValue(world), snapped: false }
}

const NO_POINTER = (world: [number, number], anchorPixel?: [number, number]): AxisPointerResult => ({
  inPlot: false,
  world,
  segments: [],
  ...(anchorPixel ? { anchorPixel } : {}),
})

/**
 * Compute the axis-pointer crosshair for a pointer over a chart. Returns `inPlot:false`
 * with no segments when the pointer is absent or falls outside the plot rect (out-of-plot
 * ⇒ NO crosshair, matching ECharts). When in plot it returns the guide-line segments (data
 * space), the snapped per-axis readouts, and a pixel tooltip anchor. Pure.
 */
export function computeAxisPointer(input: AxisPointerInput): AxisPointerResult {
  const mode: AxisPointerMode = input.mode ?? 'cross'
  const [xMin, yMin, xMax, yMax] = input.bounds

  // Resolve the pointer's world position (prefer explicit world; else unproject the pixel).
  let world: [number, number] | null = null
  if (input.world && Number.isFinite(input.world[0]) && Number.isFinite(input.world[1])) {
    world = [input.world[0], input.world[1]]
  } else if (input.pixel && input.viewport) {
    world = pixelToWorld(input.viewport, input.pixel)
  }

  // A pixel anchor, whenever we can derive one, so the tooltip can sit even mid-transition.
  const anchorFromPixel: [number, number] | undefined = input.pixel
    ? [input.pixel[0], input.pixel[1]]
    : undefined

  if (!world) return NO_POINTER([NaN, NaN], anchorFromPixel)

  const inPlot = world[0] >= xMin && world[0] <= xMax && world[1] >= yMin && world[1] <= yMax
  if (!inPlot) return NO_POINTER(world, anchorFromPixel)

  const x = resolveAxis(world[0], input.xTicks, input.snapX)
  const y = resolveAxis(world[1], input.yTicks, input.snapY)

  const vertical: FrameSegment = { source: [x.pos, yMin], target: [x.pos, yMax] }
  const horizontal: FrameSegment = { source: [xMin, y.pos], target: [xMax, y.pos] }

  const segments: FrameSegment[] = []
  if (mode === 'x' || mode === 'cross') segments.push(vertical)
  if (mode === 'y' || mode === 'cross') segments.push(horizontal)

  // Anchor: prefer the raw cursor pixel; else project the snapped intersection.
  const anchorPixel =
    anchorFromPixel ?? (input.viewport ? worldToPixel(input.viewport, [x.pos, y.pos]) : undefined)

  return {
    inPlot: true,
    world,
    segments,
    ...(mode === 'x' || mode === 'cross' ? { x } : {}),
    ...(mode === 'y' || mode === 'cross' ? { y } : {}),
    ...(anchorPixel ? { anchorPixel } : {}),
  }
}
