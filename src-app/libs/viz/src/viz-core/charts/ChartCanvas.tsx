// ChartCanvas.tsx — a thin GENERIC deck.gl wrapper for the companion statistical
// charts (violin / box / dotplot / heatmap / volcano / bar / histogram). It takes an
// array of already-built deck.gl `Layer` instances + auto-FITS an OrthographicView to
// their data bounds, then renders `<DeckGL>`. STRICT all-GPU / no-SVG (DEC-18/23).
// Auto-fit is the ONE central place chart framing lives (each View no longer guesses a
// zoom) — the render harness proved ad-hoc per-view zooms left charts off-screen.

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { VizEventBusContext } from '../events/EventBusContext'
import { useRafCommit } from '../core/useRafCommit'
import { useReleaseGLOnUnmount } from '../core/contextLoss'
import { OrthographicView, type Layer, type OrthographicViewState } from '@deck.gl/core'
import { VizTooltip } from '../tooltip/VizTooltip'
import type { TooltipRow } from '../tooltip/tooltipModel'
import { useSelectionCamera } from '../selection/useSelectionCamera'
import { PlotCellIdContext } from './plotCellId'
import { ChartLayerSinkContext } from '../grid/chartLayerSink'
import { cellLayerId, localLayerName, type CellViewState, type ViewZoom } from '../layers/multiView'
import { defaultChartTheme, type ChartTheme } from './ChartFrame'
import type { CategoryTick } from './axisTicks'
import { computeAxisPointer, type AxisPointerMode } from './axisPointer'
import { AxisPointerOverlay, buildAxisPointerLayers } from './AxisPointerOverlay'

export interface ChartCanvasProps {
  /** Already-instantiated deck.gl layers (SolidPolygon / Line / Scatterplot / Bitmap …). */
  layers: Layer[]
  /** Flip the y-axis (row 0 at top — heatmap/dotplot grids); default false (value-up charts). */
  flipY?: boolean
  /** Explicit data bounds [xMin,yMin,xMax,yMax]; else auto-derived from the layers. */
  bounds?: [number, number, number, number]
  /** Deprecated/ignored — auto-fit supersedes per-view zoom hints. Accepted for compat. */
  initialViewState?: Partial<OrthographicViewState>
  /**
   * Enable deck.gl's free pan/zoom controller (default true). Matrix charts
   * (heatmap / dotplot) pass `false` — free camera zoom is meaningless on a texel
   * matrix (DEC-38); they frame a RANGE window via the `bounds` prop only (driven by
   * `MatrixDataZoom`), so navigation is fully view-state driven.
   */
  controller?: boolean
  /**
   * Opt-in ECharts-style AXIS-POINTER crosshair (ITEM-33). `true` → a full `'cross'`
   * crosshair; an object selects the guide `mode` (`'x'` | `'y'` | `'cross'`). Default OFF
   * so existing charts/stories are byte-unchanged unless they opt in. Composes with the
   * `controller` pan/zoom and the matrix (`controller:false`) framing — the crosshair marks
   * are GPU `LineLayer`s appended to the SAME DeckGL view, so they track the live projection.
   */
  axisPointer?: boolean | { mode?: AxisPointerMode }
  /**
   * Optional per-axis ticks/categories the crosshair snaps to (a categorical x-axis snaps to
   * its nearest category; a free value axis follows the cursor). Views that build a
   * `ChartFrame` can forward the same tick spec here; when omitted the crosshair shows the
   * raw value at the cursor.
   */
  axisPointerTicks?: { x?: readonly CategoryTick[]; y?: readonly CategoryTick[] }
  /** Theme-aware chrome colors for the crosshair + tooltip badge (DEC-39); default light. */
  theme?: ChartTheme
  /**
   * Optional passthrough of deck's top-level `onHover` info (world `coordinate`, canvas
   * pixel `x`/`y`, and — for a `BitmapLayer` — `bitmap.pixel` = `[col,row]`). Lets an
   * OWNING view (e.g. the heatmap) build a RICH per-item tooltip from the picked texel
   * WITHOUT ChartCanvas knowing the data model. Composes with the axis-pointer: both can
   * be on — the item tooltip shows the mark's data, the axis-pointer shows the axis value.
   * When neither this nor `axisPointer` is set, ChartCanvas wires NO onHover (byte-unchanged).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onHover?: (info: any) => void
  /**
   * Opt-in DRAWING interaction (default undefined → byte-unchanged). When
   * `interaction.drawing` is true the pan/zoom controller is SUPPRESSED and a full-canvas
   * crosshair overlay is mounted whose pointer events are unprojected to WORLD coordinates
   * (via the live view state) and forwarded to the callbacks — the seam a producing view
   * (e.g. the violin's value-band brush / free lasso) uses to draw a selection gesture over
   * the same OrthographicView the marks live in. The view still RENDERS the gesture's draft
   * shape as GPU layers it passes in `layers` (no SVG). Absent ⇒ no overlay, controller as-is.
   */
  interaction?: ChartInteraction
  /** An opt-in per-point TOOLTIP: a world-space position + its resolved rows. ChartCanvas projects the
   *  world point through its OWN live viewport (accurate at any zoom/frame) and renders a `<VizTooltip>`
   *  at that screen position. Used for the cross-plot hover tooltip on a raw-dot chart (violin/box) —
   *  the caller already gated it by the tooltip toggle. `null` ⇒ nothing. */
  pointTooltip?: { world: readonly [number, number]; rows: readonly TooltipRow[] } | null
  testId?: string
}

/** An opt-in world-space drawing seam over the chart canvas (see `ChartCanvasProps.interaction`). */
export interface ChartInteraction {
  /** when true, suppress the pan/zoom controller + mount the crosshair draw overlay. */
  readonly drawing: boolean
  readonly onPointerDown?: (world: [number, number], e: React.PointerEvent<HTMLDivElement>) => void
  readonly onPointerMove?: (world: [number, number], e: React.PointerEvent<HTMLDivElement>) => void
  readonly onPointerUp?: (world: [number, number], e: React.PointerEvent<HTMLDivElement>) => void
  /** test id for the draw overlay div (default `viz-chart-draw-overlay`). */
  readonly overlayTestId?: string
  /** overlay cursor (default `crosshair`); a host sets `move` while hovering a grabbable area. */
  readonly cursor?: string
}

/** Pointer state tracked from deck's `onHover`: world coord + canvas-pixel position. */
interface PointerState {
  world: [number, number]
  pixel: [number, number]
}

// Nominal fit viewport (px). The controller lets the user pan/zoom; this just frames it.
const FIT_W = 820
const FIT_H = 620
const FIT_PAD = 0.14

/** Extract [xMin,yMin,xMax,yMax] from heterogeneous chart layer prop shapes. */
export function boundsOfLayers(layers: Layer[]): [number, number, number, number] | null {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity, found = false
  const upd = (x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      found = true
      if (x < xMin) xMin = x
      if (x > xMax) xMax = x
      if (y < yMin) yMin = y
      if (y > yMax) yMax = y
    }
  }
  for (const l of layers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = l.props as any
    if (p.bounds && p.bounds.length === 4) {
      upd(p.bounds[0], p.bounds[1])
      upd(p.bounds[2], p.bounds[3])
      continue
    }
    const data = p.data
    if (p.getPolygon && Array.isArray(data)) {
      for (const d of data) for (const pt of p.getPolygon(d)) upd(pt[0], pt[1])
      continue
    }
    if (p.getSourcePosition && Array.isArray(data)) {
      for (const d of data) {
        const s = p.getSourcePosition(d)
        const t = p.getTargetPosition(d)
        upd(s[0], s[1])
        upd(t[0], t[1])
      }
      continue
    }
    const attr = data?.attributes?.getPosition
    if (attr?.value) {
      const v = attr.value as Float32Array
      const size = attr.size || 2
      for (let i = 0; i + 1 < v.length; i += size) upd(v[i], v[i + 1])
      continue
    }
    if (typeof p.getPosition === 'function' && Array.isArray(data)) {
      for (const d of data) {
        const pt = p.getPosition(d)
        if (pt) upd(pt[0], pt[1])
      }
    }
  }
  return found ? [xMin, yMin, xMax, yMax] : null
}

/**
 * Fit an orthographic view to bounds within a nominal viewport.
 *
 * By default returns an INDEPENDENT per-axis zoom `[zoomX, zoomY]` so the data
 * FILLS the canvas on BOTH axes — the correct behavior for the statistical +
 * matrix charts, whose x and y are unrelated units (a category index vs a value,
 * or a texel column vs row). An equal-aspect single zoom would collapse one axis
 * to a sliver whenever the data ranges differ (the squished-bars bug).
 *
 * Pass `equal = true` for an equal-aspect fit (a single `Math.min(zx, zy)` zoom),
 * which preserves geometric aspect ratio — only wanted by a scatter-style plot,
 * which does NOT use ChartCanvas. Default is independent-axis fill.
 *
 * deck.gl's `OrthographicView` accepts the 2-tuple `zoom: [zoomX, zoomY]` form.
 */
export function fitViewState(
  b: [number, number, number, number],
  w = FIT_W,
  h = FIT_H,
  pad = FIT_PAD,
  equal = false,
): OrthographicViewState {
  const [xMin, yMin, xMax, yMax] = b
  const cx = (xMin + xMax) / 2
  const cy = (yMin + yMax) / 2
  const dw = Math.max(xMax - xMin, 1e-6)
  const dh = Math.max(yMax - yMin, 1e-6)
  const zx = Math.log2((w * (1 - pad)) / dw)
  const zy = Math.log2((h * (1 - pad)) / dh)
  return {
    target: [cx, cy, 0],
    zoom: equal ? Math.min(zx, zy) : [zx, zy],
  } as OrthographicViewState
}

/**
 * A stable VALUE signature of a fitted view state (`target` + `zoom`), used to decide
 * when to RE-FRAME a controlled chart canvas. We gate the re-frame on this signature —
 * NOT on the memo's object identity — so that a parent re-render producing an
 * equal-but-new fit object does NOT clobber the user's live pan/zoom; only a genuine
 * framing change (a resized pane or changed data bounds) re-frames. `zoom` may be a
 * scalar or a `[zoomX, zoomY]` 2-tuple, so both are serialized.
 */
export function fitSignature(vs: OrthographicViewState): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyVs = vs as any
  const t = anyVs.target ?? [0, 0, 0]
  const z = anyVs.zoom ?? 0
  const ts = Array.isArray(t) ? t.join(',') : String(t)
  const zs = Array.isArray(z) ? z.join(',') : String(z)
  return `${ts}|${zs}`
}

export interface RobustRangeOpts {
  /** Breathing pad added on each side, as a fraction of the core span. Default 0.05. */
  pad?: number
  /**
   * How far `soft` values may push the frame BEYOND the core, as a fraction of the core
   * span (each side). Default 0.5 — a far outlier can widen the frame by at most half the
   * core span, so a single extreme point can't collapse the boxes/violins into a sliver.
   */
  softCap?: number
}

/**
 * A ROBUST 1-D value range for the box / violin frame.
 *
 * `core` = values that MUST be fully framed (the box bodies q1..q3, the medians, and the
 * whisker fences — the marks that carry the distribution's shape). `soft` = values whose
 * influence is CLAMPED (outlier markers, KDE tails, means): they may extend the frame, but
 * only up to `softCap`× the core span beyond the core. This is the fix for the
 * outlier-stretched-bounds bug — a lone far outlier (or an inflated fence) no longer
 * dominates yMax/yMin and squishes the Q1–Q3 boxes into a thin band.
 *
 * Returns `[lo, hi]` (padded), or `null` when nothing finite is supplied.
 */
export function robustValueRange(
  core: readonly number[],
  soft: readonly number[] = [],
  opts: RobustRangeOpts = {},
): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const v of core) {
    if (Number.isFinite(v)) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  // No core → fall back to soft alone (still bounded, just nothing to clamp against).
  if (!Number.isFinite(lo)) {
    for (const v of soft) {
      if (Number.isFinite(v)) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!Number.isFinite(lo)) return null
    const span0 = hi - lo || Math.abs(hi) || 1
    const pad0 = (opts.pad ?? 0.05) * span0
    return [lo - pad0, hi + pad0]
  }

  const span = hi - lo || Math.abs(hi) || 1
  const cap = (opts.softCap ?? 0.5) * span
  let softLo = lo
  let softHi = hi
  for (const v of soft) {
    if (!Number.isFinite(v)) continue
    if (v < softLo) softLo = v
    if (v > softHi) softHi = v
  }
  // Clamp the soft-driven extension so no single far point can dominate the frame.
  const finalLo = Math.min(lo, Math.max(softLo, lo - cap))
  const finalHi = Math.max(hi, Math.min(softHi, hi + cap))
  const pad = (opts.pad ?? 0.05) * span
  return [finalLo - pad, finalHi + pad]
}

/** Fixed screen-pixel length for axis tick MARKS (see `fixedPixelTicks`). Labels sit 8px off the
 *  axis (`chartFrameGeometry`), so a 6px tick leaves a ~2px gap at every canvas size. */
const TICK_PX = 6

/**
 * Rewrite the axis-frame tick MARKS to a FIXED screen-pixel length (BUG-1: tick↔label overlap).
 * `chartFrameGeometry` builds tick marks in DATA space (a fraction of the data span), so their
 * projected pixel length grows with the pane — on a tall/wide canvas the mark overruns the
 * fixed-pixel tick LABEL and they collide. Here, in the ONE component that knows the live projection,
 * re-derive each `-ticks` segment's far endpoint so it is exactly `TICK_PX` pixels from the axis
 * (using the same `[zoomX, zoomY]` deck renders with: data-units-per-pixel = 1 / 2^zoom). Direction is
 * preserved from the original segment; only the frame `-ticks` layer is touched (marks/labels/titles
 * are untouched). `updateTriggers` re-evaluates the endpoints when the zoom changes.
 */
/** Data-units per screen pixel for each axis from a deck zoom (`z` scalar or `[zx,zy]`). */
export function dataPerPixel(zoom: number | [number, number]): [number, number] {
  const zx = Array.isArray(zoom) ? zoom[0] : zoom
  const zy = Array.isArray(zoom) ? zoom[1] : zoom
  return [1 / 2 ** zx, 1 / 2 ** zy]
}

/**
 * The far endpoint of a tick segment, re-derived so the mark is exactly `tickPx` SCREEN pixels long
 * (BUG-1). A vertical segment (`source.x === target.x`) is an X-axis tick running in Y; a horizontal
 * one is a Y-axis tick running in X. The original direction (sign) is preserved. PURE + exported for
 * test; the guarantee is `|newTarget - source|_screen === tickPx` at the given zoom.
 */
export function pixelTickTarget(
  source: readonly [number, number],
  target: readonly [number, number],
  dataPerPxX: number,
  dataPerPxY: number,
  tickPx = TICK_PX,
): [number, number] {
  if (source[0] === target[0]) {
    const dir = Math.sign(target[1] - source[1]) || -1
    return [target[0], source[1] + dir * tickPx * dataPerPxY]
  }
  const dir = Math.sign(target[0] - source[0]) || -1
  return [source[0] + dir * tickPx * dataPerPxX, target[1]]
}

function fixedPixelTicks(layers: Layer[], vs: OrthographicViewState): Layer[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [dataPerPxX, dataPerPxY] = dataPerPixel((vs as any).zoom ?? 0)
  return layers.map(l => {
    if (!l.id.endsWith('-ticks')) return l
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (l as any).clone({
      getTargetPosition: (d: { source: [number, number]; target: [number, number] }) =>
        pixelTickTarget(d.source, d.target, dataPerPxX, dataPerPxY),
      updateTriggers: { getTargetPosition: [dataPerPxX, dataPerPxY] },
    })
  })
}

/** A single GPU chart canvas: OrthographicView auto-fitted to the layers' data bounds. */
export function ChartCanvas({
  layers,
  flipY = false,
  bounds,
  controller = true,
  axisPointer = false,
  axisPointerTicks,
  theme = defaultChartTheme(),
  onHover,
  interaction,
  pointTooltip,
  testId = 'viz-chart-canvas',
}: ChartCanvasProps) {
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY }), [flipY])

  // Measure the ACTUAL container so the fit fills whatever pane the chart is in — the
  // fixed 820×620 nominal fit mis-scaled every off-nominal pane (a narrow grid cell
  // over-zoomed one axis and pushed the boxes/violins into a sliver at the frame edge).
  // We refit on every size change by RE-FRAMING the single controlled deck instance (see
  // the re-frame effect below) — NOT by remounting deck, which briefly overlapped two
  // decks that shared layer ids (`viz-bar`, `viz-box-frame-*`) and tripped deck's
  // "a layer id must be unique" init assertion during a pane resize/split.
  const containerRef = useRef<HTMLDivElement>(null)
  // Free this chart deck's WebGL context on unmount (luma's destroy() doesn't) so many chart cells
  // + StrictMode double-mounts don't leak past the browser's ~16-context cap.
  useReleaseGLOnUnmount(containerRef)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (w: number, h: number) => {
      const nw = Math.max(1, Math.round(w))
      const nh = Math.max(1, Math.round(h))
      setSize(prev => (prev && prev.w === nw && prev.h === nh ? prev : { w: nw, h: nh }))
    }
    const ro = new ResizeObserver(entries => {
      for (const e of entries) measure(e.contentRect.width, e.contentRect.height)
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) measure(r.width, r.height)
    return () => ro.disconnect()
  }, [])

  const fitW = size?.w ?? FIT_W
  const fitH = size?.h ?? FIT_H

  // The COMPUTED fit for the current data bounds + measured canvas size. This is the
  // framing we want whenever the pane resizes or the data changes.
  const fitVs = useMemo(() => {
    const b = bounds ?? boundsOfLayers(layers)
    return b ? fitViewState(b, fitW, fitH) : ({ target: [0, 0, 0], zoom: 0 } as OrthographicViewState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, bounds, fitW, fitH])

  // Controller charts are CONTROLLED: we hold the live view state so free pan/zoom is
  // written back (below), which keeps ONE deck instance alive for the whole cell — the
  // fix for the resize/split layer-init assertion (no remount ⇒ no overlapping decks
  // with colliding layer ids). Matrix charts (controller:false) ignore `vs` and stay
  // driven directly by `fitVs` (their `bounds`-window framing) — byte-unchanged.
  const [vs, setVs] = useState<OrthographicViewState>(fitVs)
  const fitSig = useMemo(() => fitSignature(fitVs), [fitVs])
  const lastFitSig = useRef(fitSig)
  // RE-FRAME (not remount) when the fit VALUE changes — a resized pane or changed data
  // bounds. Gating on the signature (a primitive) rather than `fitVs` identity means a
  // parent re-render that produces an equal fit does NOT clobber the user's live pan/zoom.
  useEffect(() => {
    if (lastFitSig.current !== fitSig) {
      lastFitSig.current = fitSig
      setVs(fitVs)
    }
  }, [fitSig, fitVs])

  // Write the user's pan/zoom back so a controlled deck still interacts freely.
  const handleViewStateChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (e?.viewState) setVs(e.viewState as OrthographicViewState)
    },
    [],
  )

  const apEnabled = axisPointer !== false && axisPointer != null
  const apMode: AxisPointerMode = (typeof axisPointer === 'object' && axisPointer.mode) || 'cross'

  const apBounds = useMemo<[number, number, number, number] | null>(
    () => bounds ?? boundsOfLayers(layers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layers, bounds],
  )

  const [pointer, setPointer] = useState<PointerState | null>(null)

  // EVENT_API_PLAN Phase 2 `hover`: when a `<Viz>` event bus is present (else `null` — a bare
  // ChartCanvas / story emits nothing), fan a typed `hover` event carrying the picked mark index
  // (`null` on empty space / leave), rAF-coalesced through the shared `useRafCommit` (the same
  // throttle the dataZoom rails use — not a bespoke second one) so a pointermove storm becomes at
  // most one event per frame. The `emitHover` closure reads through stable internal refs, so a ref
  // keeps `handleHover`'s deps unchanged (no churn from the per-render closure identity).
  const bus = useContext(VizEventBusContext)
  const emitHover = useRafCommit((id: number | null) => {
    bus?.emit({ type: 'hover', id })
  })
  const emitHoverRef = useRef(emitHover)
  emitHoverRef.current = emitHover

  // deck's top-level onHover fires for ANY pointer position over the view (layer or empty
  // space), carrying the unprojected world `coordinate` + canvas-pixel `x`/`y`. We only track
  // when the crosshair is enabled — otherwise ChartCanvas stays byte-for-byte its old self.
  const handleHover = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (info: any) => {
      // Axis-pointer tracking (only meaningful when the crosshair is enabled).
      if (apEnabled) {
        const c = info?.coordinate
        if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
          setPointer({ world: [c[0], c[1]], pixel: [info.x, info.y] })
        } else {
          setPointer(null)
        }
      }
      // Passthrough for an owning view's rich item tooltip (e.g. heatmap texel picking).
      onHover?.(info)
      // ADDITIVE typed `hover` event: the picked mark's index, or null over empty space.
      const idx = info && typeof info.index === 'number' && info.index >= 0 ? info.index : null
      emitHoverRef.current(idx)
    },
    [apEnabled, onHover],
  )

  // Wire deck's onHover when EITHER the axis-pointer or an owning-view tooltip needs it;
  // otherwise ChartCanvas stays byte-for-byte its old self (no onHover prop passed).
  const hoverEnabled = apEnabled || !!onHover

  const ap = useMemo(() => {
    if (!apEnabled || !pointer || !apBounds) return null
    return computeAxisPointer({
      bounds: apBounds,
      mode: apMode,
      world: pointer.world,
      pixel: pointer.pixel,
      xTicks: axisPointerTicks?.x,
      yTicks: axisPointerTicks?.y,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apEnabled, pointer, apBounds, apMode, axisPointerTicks])

  // Crosshair marks ride in the SAME DeckGL layer set → same OrthographicView projection. The axis
  // tick marks are also rewritten to a fixed pixel length (BUG-1) using the live projection deck
  // renders with (`vs` for controller charts, `fitVs` for matrix/value-window charts).
  const allLayers = useMemo(
    () => {
      const base = ap ? [...layers, ...buildAxisPointerLayers(ap, theme)] : layers
      return fixedPixelTicks(base, controller ? vs : fitVs)
    },
    [ap, layers, theme, controller, vs, fitVs],
  )

  // Drawing interaction (opt-in). While drawing, the controller is suppressed and a crosshair
  // overlay unprojects pointer events to WORLD coords via the LIVE view state (the same
  // `vs`/`fitVs` deck renders with), so a producing view can draw a selection gesture in the
  // marks' coordinate space. Absent ⇒ this is inert and the render is byte-unchanged.
  const drawing = interaction?.drawing === true
  const unprojectAt = useCallback(
    (atVs: OrthographicViewState, clientX: number, clientY: number): [number, number] | null => {
      const el = containerRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const vp = view.makeViewport({ width: rect.width, height: rect.height, viewState: atVs as never })
      if (!vp) return null
      const world = vp.unproject([clientX - rect.left, clientY - rect.top])
      return [world[0], world[1]]
    },
    [view],
  )
  const unproject = useCallback(
    (clientX: number, clientY: number): [number, number] | null =>
      unprojectAt(controller ? vs : fitVs, clientX, clientY),
    [unprojectAt, controller, vs, fitVs],
  )
  // Pan/zoom stay LIVE while drawing a selection on a controller chart (violin lasso/band, candlestick
  // & PC brush, …): the overlay would otherwise swallow the controller. WHEEL zooms, MIDDLE/SPACE-drag
  // pans; the gesture draws otherwise. The marks + draft are world-space layers in this same `vs`, so a
  // selection/brush stays anchored to the data as the camera moves. Matrix charts (controller off) keep
  // their fixed fit — no camera to move.
  const cam = useSelectionCamera({ viewState: vs, setViewState: setVs, unprojectAt })
  const drawHandlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        const w = unproject(e.clientX, e.clientY)
        if (w) interaction?.onPointerDown?.(w, e as React.PointerEvent<HTMLDivElement>)
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        const w = unproject(e.clientX, e.clientY)
        if (w) interaction?.onPointerMove?.(w, e as React.PointerEvent<HTMLDivElement>)
      },
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
        const w = unproject(e.clientX, e.clientY)
        if (w) interaction?.onPointerUp?.(w, e as React.PointerEvent<HTMLDivElement>)
      },
    }),
    [unproject, interaction],
  )
  const overlayHandlers = useMemo(
    () => (controller ? cam.wrapPointerHandlers(drawHandlers) : drawHandlers),
    [controller, cam, drawHandlers],
  )

  // ── SHARED-DECK mode (DEC-6b) ────────────────────────────────────────────────────────────────
  // When the grid provides a sink AND this chart cell has an id, render as a VIEW in the ONE shared
  // grid deck instead of our own <DeckGL>: publish our (cell-id-prefixed) layers + view params +
  // fitted viewState up to the sink; the grid draws them. No sink (a pop-out window / bare story) ⇒
  // own deck, byte-unchanged. The live viewState is exactly what our own deck would render.
  const sink = useContext(ChartLayerSinkContext)
  const cellId = useContext(PlotCellIdContext)
  const shared = !!(sink && cellId)
  const liveVs = controller ? vs : fitVs
  const sharedLayers = useMemo(
    () =>
      shared && cellId
        ? allLayers.map(l => l.clone({ id: cellLayerId(cellId, (l as unknown as { id: string }).id) }))
        : allLayers,
    [shared, cellId, allLayers],
  )
  // Grid → chart camera feedback (free-camera charts): keep the handler in a ref so the published
  // contribution's identity doesn't churn every render (the sink ignores it in its equality gate).
  const onGridViewStateRef = useRef<(cvs: CellViewState) => void>(() => {})
  onGridViewStateRef.current = (cvs: CellViewState) => {
    setVs({ target: [cvs.target[0], cvs.target[1], 0], zoom: cvs.zoom } as OrthographicViewState)
  }
  // Grid → chart hover feedback (crosshair / texel tooltip): the shared deck fires ONE onHover; the
  // grid routes it here with cell-relative pixels. `null` ⇒ pointer left this cell → clear the pointer.
  const onGridHoverRef = useRef<(info: unknown | null) => void>(() => {})
  onGridHoverRef.current = (info: unknown | null) => {
    if (info == null) {
      // Pointer LEFT this cell: route null through `handleHover` so the `onHover` PASSTHROUGH fires too
      // (not just the crosshair). A raw-dot chart (violin) relies on this to reset its hover + release the
      // cross-plot `chartHover` latch — without it the highlight/tooltips stayed stuck grid-wide.
      handleHover(null)
      return
    }
    // Un-prefix the picked layer id back to what the chart built (`<cellId>::name` → `name`), so a
    // chart handler that matches on its own layer id (e.g. HeatmapView's `info.layer.id === heatmapId`)
    // still recognises it now that ChartCanvas prefixes every published layer.
    //
    // Through `localLayerName`, NOT a local `startsWith(cellId + '::')`, which is what stood here.
    // It is the same ownership question `makeLayerFilter` and `routeGridHover` ask, and this file
    // answering it in its own words is precisely the shape that let the parse defect survive two
    // fixes: three sites, three independent decisions. One definition, one place to be right about
    // `…-violin-1` vs `…-violin-10`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const i = info as any
    const rawId = i?.layer?.id
    const local = typeof rawId === 'string' && cellId ? localLayerName(rawId, cellId) : rawId
    handleHover(i?.layer && local !== rawId ? { ...i, layer: { ...i.layer, id: local } } : i)
  }
  useEffect(() => {
    if (!shared || !sink || !cellId) return
    sink.publish({
      cellId,
      layers: sharedLayers,
      view: { flipY, controller },
      viewState: {
        target: [(liveVs.target?.[0] as number) ?? 0, (liveVs.target?.[1] as number) ?? 0],
        zoom: liveVs.zoom as ViewZoom,
      },
      onViewStateChange: controller ? (cvs: CellViewState) => onGridViewStateRef.current(cvs) : undefined,
      onHover: hoverEnabled ? (info: unknown | null) => onGridHoverRef.current(info) : undefined,
    })
  }, [shared, sink, cellId, sharedLayers, flipY, controller, liveVs, hoverEnabled])
  useEffect(
    () => () => {
      if (sink && cellId) sink.remove(cellId)
    },
    [sink, cellId],
  )

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid={testId}
    >
      {/* Own deck ONLY when NOT sharing the grid deck (pop-out window / bare story). In shared mode
          the grid draws our published layers; we render just the DOM overlays below. */}
      {!shared && (
        <DeckGL
          // ONE deck instance for the life of the cell (NO keyed remount — that briefly
          // overlapped two decks sharing layer ids and tripped deck's layer-init assertion
          // on resize/split). Controller charts are CONTROLLED: `viewState={vs}` + writing
          // back `onViewStateChange` keeps free pan/zoom, while the re-frame effect above
          // refits `vs` to the new canvas on a genuine resize. Matrix charts (controller
          // off) stay view-state driven directly by their `bounds`-window fit — unchanged.
          views={view}
          controller={controller && !drawing}
          {...(controller
            ? { viewState: vs, onViewStateChange: handleViewStateChange as never }
            : { viewState: fitVs })}
          layers={allLayers}
          {...(hoverEnabled ? { onHover: handleHover as never } : {})}
        />
      )}
      {ap && <AxisPointerOverlay result={ap} theme={theme} />}
      {/* Cross-plot per-point tooltip: project the world point through this chart's live viewport and
          render it at the dot's screen position (the caller gated it by the tooltip toggle). */}
      {(() => {
        if (!pointTooltip || fitW <= 0 || fitH <= 0) return null
        let sx: number, sy: number
        try {
          const vp = view.makeViewport({ width: fitW, height: fitH, viewState: controller ? vs : fitVs })
          if (!vp) return null
          const s = vp.project([pointTooltip.world[0], pointTooltip.world[1]])
          sx = s[0]
          sy = s[1]
        } catch {
          return null
        }
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null
        return <VizTooltip rows={pointTooltip.rows} x={sx} y={sy} />
      })()}
      {drawing && interaction && (
        <div
          data-testid={interaction.overlayTestId ?? 'viz-chart-draw-overlay'}
          ref={controller ? cam.overlayWheelRef : undefined}
          onPointerDown={overlayHandlers.onPointerDown}
          onPointerMove={overlayHandlers.onPointerMove}
          onPointerUp={overlayHandlers.onPointerUp}
          style={{
            position: 'absolute',
            inset: 0,
            cursor: cam.cursorFor(interaction.cursor ?? 'crosshair'),
            touchAction: 'none',
            // Capture the draw gesture even in SHARED-DECK mode, where the migrated chart's CellView is
            // pointerEvents:none (so pan/zoom falls through to the deck when NOT drawing). The overlay
            // only exists while `drawing`, so this never blocks pan/zoom otherwise. (own-canvas: auto
            // either way — no change.)
            pointerEvents: 'auto',
          }}
        />
      )}
    </div>
  )
}
