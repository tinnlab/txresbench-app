// InCellVisualMap.tsx — the ON-SCREEN continuous visual-map, drawn to a 2D canvas by the SHARED
// `visualMapRender` geometry (so it's pixel-identical to the export). Replaces the DOM `DragRail`
// slider inside a grid cell: the bar + two handles + selected band are canvas shapes, and a
// pointer-drag on a handle (or the band) maps back to a data value via `yToValue` and emits the
// [lo,hi] range in DOMAIN units (which the GPU value-range filter consumes directly).

import { useCallback, useEffect, useRef, useState } from 'react'
import { colorbarDescriptor, type ContinuousColormap } from '../data/color'
import { LIGHT_THEME, type VizTheme } from '../theme'
import {
  computeVisualMapLayout,
  drawVisualMapCanvas,
  yToValue,
  VISUALMAP_MIN_W,
  type Box,
  type VisualMapSide,
} from './visualMapRender'

export interface InCellVisualMapProps {
  readonly min: number
  readonly max: number
  readonly colormap: ContinuousColormap
  /** current [lo,hi] range (domain units). */
  readonly value: readonly [number, number]
  readonly onChange: (range: [number, number]) => void
  /** control height in px (width is fixed by the renderer). */
  readonly height: number
  readonly theme?: VizTheme
  /** figure font family for the value labels (typography). */
  readonly family?: string
  /** which side the bar hugs (labels face the other way). Absent ⇒ 'right'. */
  readonly side?: VisualMapSide
  readonly 'data-testid'?: string
}

const GRAB_PX = 12

export function InCellVisualMap({
  min,
  max,
  colormap,
  value,
  onChange,
  height,
  theme = LIGHT_THEME,
  family,
  side = 'right',
  'data-testid': testId = 'viz-incell-visualmap',
}: InCellVisualMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const domain: readonly [number, number] = [min, max]
  const stops = colorbarDescriptor(colormap, [min, max]).stops
  const box: Box = { x: 0, y: 0, w: VISUALMAP_MIN_W, h: height }
  // PERF (link filtering): a live drag only re-renders THIS canvas via a local `draft` range and commits
  // the real range to `onChange` ONCE on pointer-up. Firing `onChange` per pointer-move rebuilt every
  // linked chart's filtered source + re-masked every dense scatter per frame (painfully slow). `shown` is
  // the draft during a drag, else the committed prop `value`.
  const [draft, setDraft] = useState<readonly [number, number] | null>(null)
  const draftRef = useRef<readonly [number, number] | null>(null)
  const shown: readonly [number, number] = draft ?? value
  // latest props for the pointer handlers (avoid stale closures without re-binding native listeners).
  const latest = useRef({ domain, value, onChange, box, stops, theme, side })
  latest.current = { domain, value, onChange, box, stops, theme, side }

  // (re)draw on every value/domain/size change.
  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    c.width = Math.round(box.w * dpr)
    c.height = Math.round(box.h * dpr)
    c.style.width = `${box.w}px`
    c.style.height = `${box.h}px`
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, box.w, box.h)
    ctx.font = `11px ${family ?? 'system-ui, sans-serif'}`
    const layout = computeVisualMapLayout(box, domain, shown, stops, side)
    drawVisualMapCanvas(ctx, layout, theme, family)
  }, [box.w, box.h, min, max, shown[0], shown[1], colormap, theme, family, side]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(draw, [draw])

  const drag = useRef<{ mode: 'hi' | 'lo' | 'band'; grabValue: number; base: [number, number] } | null>(null)

  const localY = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY - r.top
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { domain: d, value: v, box: b, stops: s, side: sd } = latest.current
    const layout = computeVisualMapLayout(b, d, v, s, sd)
    const py = localY(e)
    const dHi = Math.abs(py - layout.handles.yHi)
    const dLo = Math.abs(py - layout.handles.yLo)
    let mode: 'hi' | 'lo' | 'band' | null = null
    if (Math.min(dHi, dLo) <= GRAB_PX) mode = dHi <= dLo ? 'hi' : 'lo'
    else if (py > layout.handles.yHi && py < layout.handles.yLo) mode = 'band'
    if (!mode) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { mode, grabValue: yToValue(py, d, layout.bar.y, layout.bar.h), base: [v[0], v[1]] }
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = drag.current
    if (!g) return
    const { domain: d, box: b, stops: s, onChange: oc, side: sd } = latest.current
    const layout = computeVisualMapLayout(b, d, latest.current.value, s, sd)
    const v = yToValue(localY(e), d, layout.bar.y, layout.bar.h)
    const [dLo, dHi] = d
    let lo = g.base[0]
    let hi = g.base[1]
    if (g.mode === 'hi') hi = Math.max(lo, Math.min(v, dHi))
    else if (g.mode === 'lo') lo = Math.min(hi, Math.max(v, dLo))
    else {
      // band: shift both by the drag delta, clamped so the whole span stays in [dLo,dHi].
      const width = g.base[1] - g.base[0]
      let nLo = g.base[0] + (v - g.grabValue)
      nLo = Math.min(Math.max(nLo, dLo), dHi - width)
      lo = nLo
      hi = nLo + width
    }
    void oc // committed on pointer-up, not per-frame (PERF).
    draftRef.current = [lo, hi]
    setDraft([lo, hi]) // live preview: re-renders ONLY this canvas.
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current) {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
      drag.current = null
      // Commit the final range ONCE — this is what rebuilds linked charts / re-masks scatters.
      const d = draftRef.current
      draftRef.current = null
      if (d) latest.current.onChange([d[0], d[1]])
      setDraft(null)
    }
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ width: box.w, height: box.h, cursor: 'ns-resize', touchAction: 'none' }}
    />
  )
}
