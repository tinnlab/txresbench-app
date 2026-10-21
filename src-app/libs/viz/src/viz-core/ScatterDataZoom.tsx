// ScatterDataZoom.tsx — optional x+y dataZoom SLIDERS for the GPU scatter, bidirectionally bound
// to its FREE OrthographicView camera (Wave-2). It wraps `DeckScatterCanvas` in the generic
// `AxisDataZoom` shell and threads a CONTROLLED `viewState` through it, so:
//
//   • camera → sliders: every live pan/zoom (reported by `DeckScatterCanvas.onViewStateChange`)
//     updates the held view state; each rail's window is DERIVED from it (`axisVisibleWindow`),
//     so the bars always REFLECT the visible world x/y window.
//   • sliders → camera: dragging a rail computes the (center, zoom) that FRAMES that window
//     (`axisViewFromWindow`) and SETS the camera, so the plot jumps to that window.
//
// The scatter keeps its FREE camera (pan/zoom/lasso) untouched — the sliders are additive. The
// DEFAULT is `false` (no sliders): the scatter already zooms via the camera, so the capability is
// opt-in PER INSTANCE (`dataZoom={{ x:'slider', y:'slider' }}`). Only `'slider'`/`'both'` render a
// rail; wheel-binding stays OFF (the camera already wheels), so a rail mode of `'both'` behaves as
// `'slider'` here.
//
// LIMITATION (documented, by design): the scatter holds a SINGLE SCALAR zoom (aspect-preserving —
// it's a real spatial plot). Framing one axis' window is therefore a genuine camera ZOOM that also
// rescales the other axis; the two sliders are COUPLED through that shared zoom. This is correct,
// honest behaviour for a spatial scatter (a stretch would distort geometry) — not a bug. No
// feedback loop guard is needed: deriving windows is pure and a programmatic `viewState` set does
// NOT re-emit `onViewStateChange` (deck fires that on user INTERACTION only).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OrthographicViewState } from '@deck.gl/core'
import { DeckScatterCanvas, type DeckScatterCanvasProps } from './DeckScatterCanvas'
import { AxisDataZoom, type AxisSpec, type AxisZoomMode, type DataZoomProp } from './charts/AxisDataZoom'
import { fullAxisWindow, type AxisWindow } from './charts/axisWindow'
import { axisViewFromWindow, axisVisibleWindow } from './charts/plotWindow'
import { boundsForPositions } from './density/densityBin'
import { fitViewState } from './charts/ChartCanvas'

/** Default scatter dataZoom: OFF (the free camera already zooms; sliders are opt-in per instance). */
export const DEFAULT_SCATTER_DATAZOOM: DataZoomProp = false

export interface ScatterDataZoomProps extends DeckScatterCanvasProps {
  /**
   * Per-instance x+y dataZoom config. `false` (default) → no sliders, the plain free-camera
   * scatter (byte-unchanged). `{ x, y }` turns on a rail per axis (`'slider'`/`'both'` → a rail;
   * `'inside'`/`'off'`/omitted → none). The rails REFLECT + DRIVE the free camera; wheel stays
   * with the camera.
   */
  readonly dataZoom?: DataZoomProp
  /** Rail container test id (rails get `${testId}-x-slider` / `${testId}-y-slider`). */
  readonly testId?: string
  /**
   * Notified with the CURRENT visible world windows (x, y) whenever the camera (hence the rails)
   * moves — the observable-window seam (a live pan/zoom or a rail drag both fire it). Optional;
   * only meaningful when a rail is active.
   */
  readonly onWindowsChange?: (x: AxisWindow, y: AxisWindow) => void
}

/** Read the per-axis scalar zoom out of a view state (`zoom` may be a scalar or `[zx, zy]`). */
function axisZoom(vs: OrthographicViewState, axis: 0 | 1): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const z = (vs as any).zoom
  const raw = Array.isArray(z) ? z[axis] : z
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/** Whether an axis' configured mode should render a rail (`'slider'`/`'both'`; wheel is moot here). */
function railMode(mode: AxisZoomMode | 'off' | undefined): AxisZoomMode | null {
  if (mode === 'slider' || mode === 'both') return 'slider'
  return null
}

export function ScatterDataZoom({
  dataZoom = DEFAULT_SCATTER_DATAZOOM,
  testId = 'viz-scatter-datazoom',
  positions,
  initialViewState,
  onViewStateChange,
  onWindowsChange,
  ...rest
}: ScatterDataZoomProps) {
  // Full data extent = the slider DOMAIN (rail min/max) for each axis.
  const domain = useMemo(() => boundsForPositions(positions), [positions])

  // The un-zoomed fit (equal-aspect, like the scatter stories) — the initial controlled camera.
  const fitVs = useMemo<OrthographicViewState>(
    () =>
      ({
        ...fitViewState([domain.minX, domain.minY, domain.maxX, domain.maxY], 600, 600, 0.12, true),
        ...initialViewState,
      }) as OrthographicViewState,
    [domain, initialViewState],
  )

  const [vs, setVs] = useState<OrthographicViewState>(fitVs)
  const vsRef = useRef(vs)
  vsRef.current = vs

  // Re-fit when the data extent changes (a new dataset). Keyed on the fit VALUE so a re-render
  // producing an equal fit doesn't clobber the user's live pan/zoom.
  const fitSig = `${domain.minX},${domain.minY},${domain.maxX},${domain.maxY}`
  const lastFitSig = useRef(fitSig)
  useEffect(() => {
    if (lastFitSig.current !== fitSig) {
      lastFitSig.current = fitSig
      setVs(fitVs)
    }
  }, [fitSig, fitVs])

  // Measured canvas area (px) — the axisVisibleWindow / axisViewFromWindow input. Measured on the
  // div DIRECTLY wrapping the scatter (== the AxisDataZoom canvas area, minus the rail gutters).
  const measRef = useRef<HTMLDivElement | null>(null)
  const [px, setPx] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = measRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setPx({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const enabled = dataZoom !== false
  const xMode = enabled ? railMode(dataZoom.x) : null
  const yMode = enabled ? railMode(dataZoom.y) : null
  // Only take control of the camera when at least one rail is actually shown.
  const active = !!(xMode || yMode)

  // Camera → window: the rail windows DERIVED from the live camera + measured px. Before the
  // canvas is measured (px 0) the rails span the full domain.
  const cx = vs.target?.[0] ?? 0
  const cy = vs.target?.[1] ?? 0
  const xWindow: AxisWindow =
    px.w > 0 ? axisVisibleWindow(cx, axisZoom(vs, 0), px.w) : fullAxisWindow(domain.minX, domain.maxX)
  const yWindow: AxisWindow =
    px.h > 0 ? axisVisibleWindow(cy, axisZoom(vs, 1), px.h) : fullAxisWindow(domain.minY, domain.maxY)

  // Surface the live visible windows (a pan/zoom or a rail drag both move them).
  useEffect(() => {
    if (active) onWindowsChange?.(xWindow, yWindow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, xWindow.lo, xWindow.hi, yWindow.lo, yWindow.hi])

  // Slider → camera: frame the dragged axis' window (aspect-preserving SCALAR zoom → also
  // rescales the other axis; see the file header). Keep the other axis' center.
  const onWindowChange = useCallback(
    (axis: 'x' | 'y', win: AxisWindow) => {
      const viewportPx = axis === 'x' ? measRef.current?.clientWidth ?? 0 : measRef.current?.clientHeight ?? 0
      const { center, zoom } = axisViewFromWindow(win, viewportPx)
      const cur = vsRef.current
      const curCx = cur.target?.[0] ?? 0
      const curCy = cur.target?.[1] ?? 0
      const next = {
        ...cur,
        target: axis === 'x' ? [center, curCy, 0] : [curCx, center, 0],
        zoom,
      } as OrthographicViewState
      vsRef.current = next
      setVs(next)
    },
    [],
  )

  // User pan/zoom → hold the reported state (rails re-derive) AND forward to any parent listener.
  const handleViewStateChange = useCallback(
    (nextVs: OrthographicViewState) => {
      setVs(nextVs)
      onViewStateChange?.(nextVs)
    },
    [onViewStateChange],
  )

  // No active rail ⇒ the plain UNCONTROLLED scatter (byte-unchanged: no controlled viewState, no
  // per-frame React re-render on pan).
  if (!active) {
    return (
      <DeckScatterCanvas
        {...rest}
        positions={positions}
        initialViewState={initialViewState}
        onViewStateChange={onViewStateChange}
      />
    )
  }

  const canvas = (
    <div ref={measRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <DeckScatterCanvas
        {...rest}
        positions={positions}
        viewState={vs}
        onViewStateChange={handleViewStateChange}
      />
    </div>
  )

  const xSpec: AxisSpec | undefined = xMode
    ? { domain: [domain.minX, domain.maxX], window: xWindow, mode: 'slider', testId: `${testId}-x-slider` }
    : undefined
  const ySpec: AxisSpec | undefined = yMode
    ? { domain: [domain.minY, domain.maxY], window: yWindow, mode: 'slider', testId: `${testId}-y-slider` }
    : undefined

  return (
    <AxisDataZoom testId={testId} wheel={false} x={xSpec} y={ySpec} onWindowChange={onWindowChange}>
      {canvas}
    </AxisDataZoom>
  )
}
