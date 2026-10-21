// InCellLegend.tsx — the ON-SCREEN categorical legend, drawn to a 2D canvas by the SHARED
// `legendRender` geometry (so it's pixel-identical to the export). Replaces the DOM `<Legend>`
// inside a grid cell: swatches + labels are canvas shapes, and clicking a swatch/row toggles that
// category's visibility (hit-tested via `legendHitTest`) → `onChange(nextHidden)`.

import { useCallback, useEffect, useRef } from 'react'
import { LIGHT_THEME, type VizTheme } from '../theme'
import {
  computeLegendLayout,
  drawLegendCanvas,
  legendHitTest,
  type LegendEntry,
  type LegendFont,
  type SwatchSide,
} from './legendRender'
import type { Box } from './visualMapRender'

export interface InCellLegendProps {
  readonly entries: readonly LegendEntry[]
  readonly hidden: ReadonlySet<number>
  readonly onChange: (hidden: Set<number>) => void
  readonly title?: string
  readonly theme?: VizTheme
  /** typography-derived legend font (family + sizes); absent ⇒ built-in defaults. */
  readonly font?: LegendFont
  /** Which side the swatch hugs (label faces the other way). Absent ⇒ 'right'. */
  readonly swatchSide?: SwatchSide
  /** A per-cell provenance marker, rendered as one muted line under the entries. Absent ⇒ no
   *  line and byte-identical geometry. See {@link LegendLayout.note}. */
  readonly note?: string
  readonly 'data-testid'?: string
}

export function InCellLegend({
  entries,
  hidden,
  onChange,
  title,
  theme = LIGHT_THEME,
  font,
  swatchSide = 'right',
  note,
  'data-testid': testId = 'viz-incell-legend',
}: InCellLegendProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const box: Box = { x: 0, y: 0, w: 0, h: 0 }
  const layout = computeLegendLayout(box, entries, hidden, title, swatchSide, note)
  // latest for the click handler (avoid stale closure).
  const latest = useRef({ entries, hidden, onChange, title, swatchSide, note })
  latest.current = { entries, hidden, onChange, title, swatchSide, note }

  const draw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    c.width = Math.round(layout.width * dpr)
    c.height = Math.round(layout.height * dpr)
    c.style.width = `${layout.width}px`
    c.style.height = `${layout.height}px`
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, layout.width, layout.height)
    drawLegendCanvas(ctx, layout, theme, font)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.width, layout.height, entries, hidden, title, theme, font?.titleSize, font?.labelSize, font?.family, swatchSide, note])
  useEffect(draw, [draw])

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { entries: en, hidden: hid, onChange: oc, title: t, swatchSide: ss, note: n } = latest.current
    const r = e.currentTarget.getBoundingClientRect()
    const lay = computeLegendLayout({ x: 0, y: 0, w: 0, h: 0 }, en, hid, t, ss, n)
    const code = legendHitTest(lay, e.clientX - r.left, e.clientY - r.top)
    if (code == null) return
    const next = new Set(hid)
    next.has(code) ? next.delete(code) : next.add(code)
    oc(next)
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      // THE DOM WITNESS of a string this component draws in 2D canvas pixels.
      //
      // The legend is the load-bearing surface for a provenance marker — a screenshot crops the
      // plot chrome and keeps the legend — but it is DRAWN, so nothing outside this component can
      // observe that the mark reached it. The geometry half is asserted directly
      // (`legendRender.test.ts`: the note gets a line, and the same line reaches the vector
      // export); this attribute is what lets a test driving the REAL app assert the third leg of
      // INV-9 — that the mark is on the picker, the chrome AND the legend at the same time —
      // instead of asserting two legs and inferring the third.
      //
      // It mirrors `note` and nothing else, so it cannot drift from what is drawn: the same value
      // feeds `computeLegendLayout` above.
      {...(note !== undefined && note !== '' ? { 'data-provenance-note': note } : {})}
      onClick={onClick}
      style={{ width: layout.width, height: layout.height, cursor: 'pointer' }}
    />
  )
}
