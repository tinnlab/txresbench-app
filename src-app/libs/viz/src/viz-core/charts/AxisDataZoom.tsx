// AxisDataZoom.tsx — the ONE generic per-axis dataZoom shell (ECharts model): wrap a plot
// canvas and add, per configured axis, a range slider (an HTML `DragRail`) + optional
// wheel-zoom + optional drag-pan, mapping [handle fractions] ↔ [axis DOMAIN window] and
// calling back with the new window; the PLOT decides what the window does. This is the union
// of what the former `ValueAxisZoom` (1 value axis) and `MatrixDataZoom` (2 index axes) did —
// they are now thin wrappers over this. All window math is the pure `./axisWindow` module;
// this file is only the DOM shell. NO SVG: the sliders are HTML `DragRail`s, the plot marks
// stay deck.gl/luma. Domain-agnostic (x/y, value/index — no view or biology terms).
//
// Per axis (`AxisSpec`): `mode` picks the ECharts control kind —
//   'slider'  → the DragRail only (no wheel).
//   'inside'  → wheel/drag-pan only (no rail).
//   'both'    → rail + wheel.
// A rail renders iff mode ∈ {slider, both}; an axis wheel-zooms iff mode ∈ {inside, both} AND
// the master `wheel` prop is not false. Omit an axis (or the plot passes no spec) → that axis
// has no dataZoom at all. `invert` puts the window's LOW edge at a vertical rail's TOP.

import { useEffect, useRef, type ReactNode } from 'react'
import { DragRail } from '../controls/DragRail'
import { DataZoomRailCanvas } from '../controls/DataZoomRailCanvas'
import {
  fractionToWindow,
  panWindow,
  windowToFraction,
  zoomWindow,
  type AxisWindow,
} from './axisWindow'

/** ECharts-style control kind for one axis. */
export type AxisZoomMode = 'slider' | 'inside' | 'both'

/** Per-plot dataZoom configuration (Wave-2 plots take the same shape). `false` = fully off. */
export interface DataZoomConfig {
  readonly x?: AxisZoomMode | 'off'
  readonly y?: AxisZoomMode | 'off'
  /** Master wheel gate (default true). `false` disables wheel-zoom on every axis. */
  readonly wheel?: boolean
}
export type DataZoomProp = false | DataZoomConfig

/** Multiplicative window shrink per wheel notch (<1 = zoom in toward the cursor). */
const ZOOM_IN = 0.85
/** Slider gutter thickness (px). */
const RAIL = 16

/** One axis' full spec: its domain, current window, control mode, and rail testid. */
export interface AxisSpec {
  readonly domain: readonly [number, number]
  readonly window: AxisWindow
  /** Default 'both'. */
  readonly mode?: AxisZoomMode
  /** Reflect the axis so the window's LOW edge is at the rail's HIGH (top) end. Default false. */
  readonly invert?: boolean
  /** Snap each slider edge to a whole cell before clamping (categorical / index axis). */
  readonly snap?: (v: number) => number
  /** Smallest window span (domain units). Defaults to 2% of the domain. */
  readonly minSpan?: number
  /** Rail `data-testid` (DragRail appends `-handle-hi` / `-handle-lo` / `-band`). */
  readonly testId?: string
}

export interface AxisDataZoomProps {
  readonly x?: AxisSpec
  readonly y?: AxisSpec
  readonly onWindowChange: (axis: 'x' | 'y', win: AxisWindow) => void
  /** Master wheel gate (default true). An axis still needs mode ∈ {inside, both} to wheel. */
  readonly wheel?: boolean
  /** Attach a drag-over-canvas pan (default false). Pans every configured axis. */
  readonly dragPan?: boolean
  /** Pan convention: 'content' (grab the marks; content follows the cursor) or 'axis' (grab
   *  the ruler; the numbers follow). Default 'content'. */
  readonly panMode?: 'content' | 'axis'
  readonly children: ReactNode
  readonly testId?: string
}

/** True when an axis' mode shows a slider rail. */
function hasRail(spec?: AxisSpec): boolean {
  const m = spec?.mode ?? 'both'
  return !!spec && (m === 'slider' || m === 'both')
}
/** True when an axis' mode participates in wheel-zoom. */
function hasInside(spec?: AxisSpec): boolean {
  const m = spec?.mode ?? 'both'
  return !!spec && (m === 'inside' || m === 'both')
}

/**
 * Generic per-axis dataZoom: renders `children` (the canvas) in a relative container, a
 * horizontal rail UNDER it when `x` has a slider, a vertical rail BESIDE it when `y` has one,
 * plus optional wheel-zoom + drag-pan over the canvas. Each gesture maps back to the axis
 * DOMAIN window and calls `onWindowChange(axis, win)`.
 */
export function AxisDataZoom({
  x,
  y,
  onWindowChange,
  wheel = true,
  dragPan = false,
  panMode = 'content',
  children,
  testId = 'viz-axis-datazoom',
}: AxisDataZoomProps) {
  const areaRef = useRef<HTMLDivElement | null>(null)
  // Latest props read by imperative wheel/drag listeners without re-subscribing. A gesture that
  // touches both axes (e.g. a wheel) emits `onWindowChange` once PER axis; a multi-axis consumer
  // (e.g. `MatrixDataZoom`) merges those same-tick calls onto the freshest window via its own ref.
  const stateRef = useRef({ x, y, onWindowChange, wheel, dragPan, panMode })
  stateRef.current = { x, y, onWindowChange, wheel, dragPan, panMode }

  // rAF-coalesced emission for the drag-pan (H2): a `pointermove` fires ~60×/s, and emitting
  // `onWindowChange` on every one re-renders the render-prop View subtree each frame, re-running
  // its window-dependent CPU work (e.g. violin KDE re-densify) ~60×/s. Instead each move stashes
  // its LATEST target window per axis and we flush AT MOST once per frame (dropping intermediate
  // frames); the window still moves visibly + continuously, and `flushEmit()` on `pointerup`
  // commits the FINAL position so the last move is never lost. The batcher emits 'x' then 'y' in
  // ONE tick, so a multi-axis consumer (`MatrixDataZoom`) still merges them onto one window.
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<{ x?: AxisWindow; y?: AxisWindow }>({})
  const dragHandlersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null)
  const flushEmit = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    const p = pendingRef.current
    pendingRef.current = {}
    const emit = stateRef.current.onWindowChange
    if (p.x) emit('x', p.x)
    if (p.y) emit('y', p.y)
  }
  const scheduleEmit = (axis: 'x' | 'y', win: AxisWindow) => {
    pendingRef.current[axis] = win
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushEmit)
  }

  // Unmount safety: remove any window pointer listeners still attached by an in-flight drag-pan
  // (they were previously torn down ONLY in `up`, leaking if the component unmounted mid-drag) and
  // cancel any pending coalesced frame.
  useEffect(() => {
    return () => {
      const h = dragHandlersRef.current
      if (h) {
        window.removeEventListener('pointermove', h.move)
        window.removeEventListener('pointerup', h.up)
        dragHandlersRef.current = null
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  // Wheel → zoom every inside-axis toward the cursor. Native, non-passive so preventDefault
  // works (a wheel over the plot must NOT scroll the page). Not attached when `wheel===false`
  // or when neither axis is inside — the wheel keeps its default behavior.
  useEffect(() => {
    if (!wheel) return
    if (!hasInside(x) && !hasInside(y)) return
    const el = areaRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = stateRef.current
      const rect = el.getBoundingClientRect()
      const fx = rect.width ? (e.clientX - rect.left) / rect.width : 0.5
      const fy = rect.height ? (e.clientY - rect.top) / rect.height : 0.5
      const factor = e.deltaY < 0 ? ZOOM_IN : 1 / ZOOM_IN
      if (hasInside(s.x)) {
        const ax = s.x!
        // Horizontal: left→right. `invert` flips which window edge is at the left.
        const winFrac = ax.invert ? 1 - fx : fx
        const anchor = ax.window.lo + winFrac * (ax.window.hi - ax.window.lo)
        s.onWindowChange('x', zoomWindow(ax.window, ax.domain[0], ax.domain[1], factor, anchor, ax.minSpan))
      }
      if (hasInside(s.y)) {
        const ay = s.y!
        // Vertical: fy=0 at the TOP. `invert` (top=low edge) uses fy; else top=high edge → 1-fy.
        const winFrac = ay.invert ? fy : 1 - fy
        const anchor = ay.window.lo + winFrac * (ay.window.hi - ay.window.lo)
        s.onWindowChange('y', zoomWindow(ay.window, ay.domain[0], ay.domain[1], factor, anchor, ay.minSpan))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wheel, hasInside(x), hasInside(y)])

  // Drag over the canvas → pan every configured axis by the TOTAL delta from the grab point
  // (absolute, so it stays stable across moves). Sign: 'content' = -delta (marks follow the
  // cursor); 'axis' = +delta (the ruler follows). Only when `dragPan`.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !stateRef.current.dragPan) return
    const el = areaRef.current
    if (!el) return
    const startX = e.clientX
    const startY = e.clientY
    const startX0 = stateRef.current.x?.window
    const startY0 = stateRef.current.y?.window
    const move = (ev: PointerEvent) => {
      const s = stateRef.current
      const rect = el.getBoundingClientRect()
      const sign = s.panMode === 'axis' ? 1 : -1
      // Coalesce to ≤1 emit/frame — stash the latest target window; `flushEmit` (rAF or pointerup)
      // does the actual `onWindowChange`.
      if (s.x && startX0) {
        const span = startX0.hi - startX0.lo
        const delta = rect.width ? sign * ((ev.clientX - startX) / rect.width) * span : 0
        scheduleEmit('x', panWindow(startX0, s.x.domain[0], s.x.domain[1], delta))
      }
      if (s.y && startY0) {
        const span = startY0.hi - startY0.lo
        const delta = rect.height ? sign * ((ev.clientY - startY) / rect.height) * span : 0
        scheduleEmit('y', panWindow(startY0, s.y.domain[0], s.y.domain[1], delta))
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragHandlersRef.current = null
      flushEmit() // commit the FINAL window position (don't drop the last coalesced move)
    }
    dragHandlersRef.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const showX = hasRail(x)
  const showY = hasRail(y)

  // Window as a [loFrac,hiFrac] rail fraction — drives BOTH the DragRail handle positions (hit-test)
  // and the shared canvas visual, so on-screen == export by construction.
  const xFrac = x ? windowToFraction(x.window, x.domain[0], x.domain[1], x.invert) : ([0, 1] as [number, number])
  const yFrac = y ? windowToFraction(y.window, y.domain[0], y.domain[1], y.invert) : ([0, 1] as [number, number])

  const onXRail = (range: [number, number]) => {
    if (!x) return
    onWindowChange(
      'x',
      fractionToWindow(range[0], range[1], x.domain[0], x.domain[1], x.invert, x.minSpan, x.snap),
    )
  }
  const onYRail = (range: [number, number]) => {
    if (!y) return
    onWindowChange(
      'y',
      fractionToWindow(range[0], range[1], y.domain[0], y.domain[1], y.invert, y.minSpan, y.snap),
    )
  }

  const cursor = stateRef.current.dragPan ? (x && y ? 'grab' : y ? 'ns-resize' : 'ew-resize') : 'default'

  return (
    <div
      data-testid={testId}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 4 }}
    >
      <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, gap: 4 }}>
        <div
          ref={areaRef}
          onPointerDown={onPointerDown}
          style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', cursor, touchAction: 'none' }}
          data-testid={`${testId}-canvas`}
        >
          {children}
        </div>
        {showY && (
          <DragRail
            min={0}
            max={1}
            value={yFrac}
            onChange={onYRail}
            orientation="vertical"
            thickness={RAIL}
            chromeless
            style={{ height: '100%' }}
            data-testid={y!.testId}
          >
            <DataZoomRailCanvas window={yFrac} orientation="vertical" />
          </DragRail>
        )}
      </div>
      {showX && (
        <div style={{ display: 'flex', gap: 4 }}>
          <DragRail
            min={0}
            max={1}
            value={xFrac}
            onChange={onXRail}
            orientation="horizontal"
            thickness={RAIL}
            chromeless
            style={{ flex: 1, width: 'auto' }}
            data-testid={x!.testId}
          >
            <DataZoomRailCanvas window={xFrac} orientation="horizontal" />
          </DragRail>
          {/* Spacer matching the y-rail gutter so the x-rail aligns under the canvas. */}
          {showY && <div style={{ width: RAIL, flexShrink: 0 }} />}
        </div>
      )}
    </div>
  )
}
