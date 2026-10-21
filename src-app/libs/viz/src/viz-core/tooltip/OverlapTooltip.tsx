// OverlapTooltip.tsx — the positioned hover badge for OVERLAPPING points: up to the top-3 nearest
// points stacked, then a clickable "+N more" affordance that opens the full list dialog. Shared by
// point mode + raster mode (both feed it an `OverlapResolution`). Styling mirrors `VizTooltip`
// (theme-aware, no SVG). Unlike VizTooltip (pointer-events:none), the "+N more" BUTTON is clickable,
// so the badge itself accepts pointer events but only the button is interactive.

import { useLayoutEffect, useRef, useState } from 'react'
import { LIGHT_THEME, type VizTheme } from '../theme'
import type { OverlapResolution } from './overlapModel'

export interface OverlapTooltipProps {
  readonly resolution: OverlapResolution
  /** cursor position (canvas-local CSS px). */
  readonly x: number
  readonly y: number
  /** invoked when the user clicks "+N more". */
  readonly onMore: () => void
  readonly theme?: VizTheme
  readonly testId?: string
}

const OFFSET = 14

export function OverlapTooltip({
  resolution,
  x,
  y,
  onMore,
  theme = LIGHT_THEME,
  testId = 'viz-overlap-tooltip',
}: OverlapTooltipProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x + OFFSET, top: y + OFFSET })

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
    if (left + w > pw) left = Math.max(4, x - OFFSET - w)
    if (top + h > ph) top = Math.max(4, y - OFFSET - h)
    left = Math.max(4, Math.min(left, pw - w - 4))
    top = Math.max(4, Math.min(top, ph - h - 4))
    setPos(prev => (prev.left === left && prev.top === top ? prev : { left, top }))
  }, [x, y, resolution])

  if (resolution.top.length === 0) return null

  return (
    <div
      ref={ref}
      data-testid={testId}
      style={{
        position: 'absolute',
        left: pos.left,
        top: pos.top,
        // The badge itself is inert; only the button below re-enables pointer events. This keeps
        // hover-through behavior for the stacked point rows while making "+N more" clickable.
        pointerEvents: 'none',
        transform: 'translateZ(0)',
        zIndex: 20,
        padding: '4px 8px',
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1.5,
        color: theme.fg,
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
        minWidth: 80,
        maxWidth: 260,
      }}
    >
      {resolution.top.map((result, i) => (
        <div
          key={i}
          data-testid={`${testId}-point-${i}`}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto auto',
            columnGap: 8,
            rowGap: 1,
            paddingBottom: i < resolution.top.length - 1 ? 4 : 0,
            marginBottom: i < resolution.top.length - 1 ? 4 : 0,
            borderBottom: i < resolution.top.length - 1 ? `1px solid ${theme.border}` : 'none',
          }}
        >
          {result.rows.map(r => (
            <div key={r.label} style={{ display: 'contents' }}>
              <span style={{ color: theme.muted, whiteSpace: 'nowrap' }}>{r.label}</span>
              <span
                style={{
                  textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>
      ))}
      {resolution.moreCount > 0 && (
        <button
          type="button"
          data-testid={`${testId}-more`}
          onClick={onMore}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            marginTop: 4,
            width: '100%',
            padding: '2px 6px',
            fontSize: 11,
            color: theme.fg,
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            borderRadius: 3,
          }}
        >
          +{resolution.moreCount.toLocaleString()} more
        </button>
      )}
    </div>
  )
}
