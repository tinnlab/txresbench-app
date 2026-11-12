// VizTooltip.tsx — the reusable positioned DOM tooltip for the GPU hover surfaces.
// It is CHROME (a small absolutely-positioned <div> label:value list), NOT a data mark —
// no SVG, no deck.gl layer. Mirrors the `AxisPointerOverlay` badge styling and is
// theme-aware via the framework-agnostic viz-core `VizTheme` (no @txresbench/* import).
//
// It renders only the already-resolved `rows` (built O(1) by `tooltipModel`), offsets the
// badge from the cursor, and clamps it inside its positioned parent so it never spills
// off-screen. The EXPENSIVE part (rAF-throttling the hover→setState) lives in the canvas
// that owns this — VizTooltip just paints what it's given.

import { useLayoutEffect, useRef, useState } from 'react'
import { LIGHT_THEME, type VizTheme } from '../theme'
import type { TooltipRow } from './tooltipModel'

export interface VizTooltipProps {
  /** The resolved label:value rows (from `resolveTooltip` / `resolveMatrixTooltip`). */
  readonly rows: readonly TooltipRow[]
  /** Cursor position (canvas-local CSS px) the badge offsets from. */
  readonly x: number
  readonly y: number
  /** Theme-aware chrome colors; defaults to the light theme. */
  readonly theme?: VizTheme
  readonly testId?: string
}

/** Gap between the cursor and the badge (px). */
const OFFSET = 14

export function VizTooltip({
  rows,
  x,
  y,
  theme = LIGHT_THEME,
  testId = 'viz-tooltip',
}: VizTooltipProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Clamp AFTER layout: measure the badge + its positioned parent, then flip the offset
  // to the opposite side of the cursor when the default placement would overflow.
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: x + OFFSET,
    top: y + OFFSET,
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const parent = el.offsetParent as HTMLElement | null
    const pw = parent?.clientWidth ?? el.ownerDocument.documentElement.clientWidth
    const ph = parent?.clientHeight ?? el.ownerDocument.documentElement.clientHeight
    const w = el.offsetWidth
    const h = el.offsetHeight

    let left = x + OFFSET
    let top = y + OFFSET
    if (left + w > pw) left = Math.max(4, x - OFFSET - w) // flip left
    if (top + h > ph) top = Math.max(4, y - OFFSET - h) // flip up
    left = Math.max(4, Math.min(left, pw - w - 4))
    top = Math.max(4, Math.min(top, ph - h - 4))
    setPos(prev => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [x, y, rows])

  if (rows.length === 0) return null

  return (
    <div
      ref={ref}
      data-testid={testId}
      style={{
        position: 'absolute',
        left: pos.left,
        top: pos.top,
        pointerEvents: 'none',
        transform: 'translateZ(0)',
        zIndex: 20,
        padding: '4px 8px',
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        color: theme.fg,
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
        display: 'grid',
        gridTemplateColumns: 'auto auto',
        columnGap: 8,
        rowGap: 1,
      }}
    >
      {rows.map(r => (
        <div key={r.label} style={{ display: 'contents' }}>
          <span style={{ color: theme.muted }}>{r.label}</span>
          <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}
