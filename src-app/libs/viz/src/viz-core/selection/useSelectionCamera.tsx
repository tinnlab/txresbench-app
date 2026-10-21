// useSelectionCamera.tsx — the ONE shared "pan/zoom stays live during a selection gesture" helper.
//
// A selection surface draws its gesture through a DOM overlay that sits ON TOP of the deck canvas, so
// it swallows deck's own controller — you couldn't pan/zoom without leaving the selection tool. This
// hook drives the host's CONTROLLED `viewState` from the overlay instead, so pan/zoom stay live while
// a selection tool is active:
//   • WHEEL              → zoom-to-cursor (the world point under the cursor stays fixed)
//   • MIDDLE-drag / SPACE+left-drag → pan (the grabbed world point stays under the cursor)
//   • LEFT-drag (no space) → the host's draw handlers (unchanged)
// Because a committed selection outline is a WORLD-SPACE layer in this same `viewState`, it moves and
// scales WITH the camera automatically — the selection stays anchored to the data.
//
// Generic over any OrthographicView host (scatter / spatial ROI / a grid cell / a chart camera): the
// caller supplies `unprojectAt(vs, x, y)` built from its own view + container, and the controlled
// `viewState` + `setViewState`. Every 2D-area surface consumes THIS — no per-host copy of the math.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrthographicViewState } from '@deck.gl/core'

/** A world/screen point — readonly so any host's Vec2 (mutable or readonly) satisfies it. */
type XY = readonly [number, number]

// ── pure camera math (shared by the hook AND the grid's per-cell link-zoom path) ─────────────────

/** New zoom after a wheel tick. Handles a scalar zoom OR a per-axis `[zx,zy]` (charts); clamped. */
export function bumpZoom(
  zoom: number | readonly number[] | undefined,
  deltaY: number,
  wheelSpeed: number,
  minZoom: number,
  maxZoom: number,
): number | number[] {
  const dz = deltaY * wheelSpeed
  const clamp = (v: number) => Math.max(minZoom, Math.min(maxZoom, v - dz))
  return Array.isArray(zoom) ? zoom.map(clamp) : clamp(typeof zoom === 'number' ? zoom : 0)
}

/** Target that keeps the world point under the cursor FIXED across a zoom (zoom-to-cursor): `w0` is the
 *  world under the cursor at the old zoom, `w1` the world under the cursor at the new zoom (same target). */
export function zoomToCursorTarget(target: XY, w0: XY, w1: XY): [number, number] {
  return [target[0] + (w0[0] - w1[0]), target[1] + (w0[1] - w1[1])]
}

/** Target after a drag-pan that keeps the grabbed world point under the cursor: `w0` = world at grab,
 *  `wN` = world now, BOTH unprojected against the GRAB-time camera; `startTarget` = target at grab. */
export function panTarget(startTarget: XY, w0: XY, wN: XY): [number, number] {
  return [startTarget[0] + (w0[0] - wN[0]), startTarget[1] + (w0[1] - wN[1])]
}

/** The three overlay pointer handlers a host wires to its draw overlay. */
export interface PointerHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
}

export interface UseSelectionCameraOpts {
  /** the host's CONTROLLED orthographic view state. */
  viewState: OrthographicViewState
  /** commit a new view state (value or updater). */
  setViewState: (next: OrthographicViewState | ((vs: OrthographicViewState) => OrthographicViewState)) => void
  /** screen→world against an EXPLICIT view state (so zoom/pan can reproject under a hypothetical camera). */
  unprojectAt: (vs: OrthographicViewState, clientX: number, clientY: number) => XY | null
  /** zoom clamp (deck ortho zoom, log2 px/world). */
  minZoom?: number
  maxZoom?: number
  /** wheel sensitivity (zoom units per deltaY px). */
  wheelSpeed?: number
}

export interface SelectionCameraApi {
  /** wire to the overlay's `onWheel`. NOTE: React binds `wheel` PASSIVE at the root, so this
   *  handler's `preventDefault()` is a no-op (warns + can't stop ancestor scroll). Prefer
   *  {@link SelectionCameraApi.overlayWheelRef} which attaches a NON-passive native listener. */
  onWheel: (e: React.WheelEvent<HTMLElement>) => void
  /** Callback ref for the draw overlay: attaches a NON-passive native `wheel` listener (so
   *  `preventDefault()` actually suppresses ancestor scroll + no console warning). Spread it on the
   *  overlay div INSTEAD of `onWheel={cam.onWheel}`. Detaches automatically on unmount. */
  overlayWheelRef: (el: HTMLElement | null) => void
  /** wrap the host's draw handlers so MIDDLE / SPACE+drag pans and everything else draws. */
  wrapPointerHandlers: (draw: PointerHandlers) => PointerHandlers
  /** true while Space is held (the host shows a grab cursor + a left-drag pans). */
  spaceHeld: boolean
  /** the cursor the overlay should show: a grab affordance while Space is held, else the base cursor. */
  cursorFor: (base: string) => string
}

const DEFAULT_MIN_ZOOM = -10
const DEFAULT_MAX_ZOOM = 24
const DEFAULT_WHEEL_SPEED = 0.01

export function useSelectionCamera({
  viewState,
  setViewState,
  unprojectAt,
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM,
  wheelSpeed = DEFAULT_WHEEL_SPEED,
}: UseSelectionCameraOpts): SelectionCameraApi {
  const [spaceHeld, setSpaceHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const panRef = useRef<{ startClient: XY; startTarget: XY; vs0: OrthographicViewState } | null>(null)

  // The zoom-to-cursor math, shared by the (passive) React `onWheel` and the (non-passive) native
  // listener below. Reads only `clientX/clientY/deltaY/preventDefault`, so a native or synthetic
  // WheelEvent both satisfy it.
  const applyWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; preventDefault(): void }) => {
      e.preventDefault()
      const w0 = unprojectAt(viewState, e.clientX, e.clientY)
      if (!w0) return
      const nz = bumpZoom(viewState.zoom as number | readonly number[], e.deltaY, wheelSpeed, minZoom, maxZoom)
      const w1 = unprojectAt({ ...viewState, zoom: nz as never }, e.clientX, e.clientY)
      if (!w1) return
      const t = viewState.target as [number, number, number]
      const nt = zoomToCursorTarget([t[0], t[1]], w0, w1)
      setViewState({ ...viewState, zoom: nz as never, target: [nt[0], nt[1], 0] as never })
    },
    [viewState, setViewState, unprojectAt, minZoom, maxZoom, wheelSpeed],
  )
  const onWheel = useCallback((e: React.WheelEvent<HTMLElement>) => applyWheel(e), [applyWheel])

  // Non-passive native `wheel` attach (React's JSX `onWheel` is passive → its preventDefault warns +
  // can't stop page scroll). A latest-ref keeps the handler current without re-binding per camera tick.
  const wheelLatest = useRef(applyWheel)
  wheelLatest.current = applyWheel
  const wheelDetach = useRef<(() => void) | null>(null)
  const overlayWheelRef = useCallback((el: HTMLElement | null) => {
    if (wheelDetach.current) {
      wheelDetach.current()
      wheelDetach.current = null
    }
    if (!el) return
    const h = (e: WheelEvent) => wheelLatest.current(e)
    el.addEventListener('wheel', h, { passive: false })
    wheelDetach.current = () => el.removeEventListener('wheel', h)
  }, [])

  const wrapPointerHandlers = useCallback(
    (draw: PointerHandlers): PointerHandlers => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        // MIDDLE button, or SPACE + left → pan; otherwise the host's draw gesture.
        if (e.button === 1 || (e.button === 0 && spaceHeld)) {
          e.currentTarget.setPointerCapture?.(e.pointerId)
          const t = viewState.target as [number, number, number]
          panRef.current = { startClient: [e.clientX, e.clientY], startTarget: [t[0], t[1]], vs0: viewState }
          return
        }
        draw.onPointerDown(e)
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        const pan = panRef.current
        if (pan) {
          // Drag-pan: keep the grabbed world point under the cursor (unproject both ends against the
          // GRAB-time camera, shift target by the difference — no manual scale/flip math).
          const w0 = unprojectAt(pan.vs0, pan.startClient[0], pan.startClient[1])
          const wN = unprojectAt(pan.vs0, e.clientX, e.clientY)
          if (w0 && wN) {
            const nt = panTarget(pan.startTarget, w0, wN)
            setViewState(vs => ({ ...vs, target: [nt[0], nt[1], 0] as never }))
          }
          return
        }
        draw.onPointerMove(e)
      },
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
        if (panRef.current) {
          e.currentTarget.releasePointerCapture?.(e.pointerId)
          panRef.current = null
          return
        }
        draw.onPointerUp(e)
      },
    }),
    [viewState, setViewState, unprojectAt, spaceHeld],
  )

  const cursorFor = useCallback((base: string) => (spaceHeld ? 'grab' : base), [spaceHeld])

  return { onWheel, overlayWheelRef, wrapPointerHandlers, spaceHeld, cursorFor }
}
