// DataZoomRailCanvas.tsx — the ON-SCREEN dataZoom rail visual, drawn to a 2D canvas by the SHARED
// `dataZoomRender` geometry (so it's pixel-identical to the export). Rendered as the `children` of a
// `chromeless` `DragRail`: it fills the rail (absolute inset 0, BEHIND the rail's transparent
// handles) and is `pointer-events:none`, so the DragRail still owns hit-testing/keyboard while this
// canvas owns the entire look (the ECharts single-surface model). Sizes to its parent via a
// ResizeObserver and redraws on window/size/orientation change.

import { useEffect, useRef } from 'react'
import { LIGHT_THEME, type VizTheme } from '../theme'
import {
  computeDataZoomLayout,
  drawDataZoomCanvas,
  type Box,
  type DataZoomOrientation,
} from './dataZoomRender'

export interface DataZoomRailCanvasProps {
  /** current [loFrac, hiFrac] window in 0..1 rail space (from `windowToFraction`). */
  readonly window: readonly [number, number]
  readonly orientation: DataZoomOrientation
  readonly theme?: VizTheme
}

export function DataZoomRailCanvas({ window: win, orientation, theme = LIGHT_THEME }: DataZoomRailCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // latest props so the ResizeObserver callback redraws with fresh values without re-subscribing.
  const latest = useRef({ win, orientation, theme })
  latest.current = { win, orientation, theme }

  useEffect(() => {
    const c = canvasRef.current
    const parent = c?.parentElement
    if (!c || !parent) return
    const draw = () => {
      const w = parent.clientWidth
      const h = parent.clientHeight
      if (w <= 0 || h <= 0) return
      const dpr = typeof globalThis !== 'undefined' && globalThis.devicePixelRatio ? globalThis.devicePixelRatio : 1
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      c.style.width = `${w}px`
      c.style.height = `${h}px`
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const box: Box = { x: 0, y: 0, w, h }
      const { win: cw, orientation: co, theme: ct } = latest.current
      drawDataZoomCanvas(ctx, computeDataZoomLayout(box, cw, co), ct)
    }
    draw()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null
    ro?.observe(parent)
    return () => ro?.disconnect()
  }, [win[0], win[1], orientation, theme]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}
