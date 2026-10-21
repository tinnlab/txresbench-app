// AxisPointerOverlay.tsx — the thin render layer for the axis-pointer crosshair (ITEM-33).
// Two halves, both driven by the pure `axisPointer.ts` result:
//   • `buildAxisPointerLayers` turns the crosshair guide segments into deck.gl `LineLayer`s
//     (data-space, so they co-register with ChartCanvas's OrthographicView) — the MARKS are
//     100% GPU, NO SVG (DEC-18/23). ChartCanvas appends these to its single DeckGL layer set.
//   • `<AxisPointerOverlay>` renders the value READOUT as a positioned DOM badge (chrome, not
//     a mark — mirrors the scatter hover badge in `DeckScatterCanvas.tsx`). Theme-aware via
//     the shared `ChartTheme`.

import { LineLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { parseColor, defaultChartTheme, type ChartTheme } from './ChartFrame'
import type { FrameSegment } from './chartFrameGeometry'
import type { AxisPointerResult } from './axisPointer'

/**
 * Build the deck.gl crosshair layer(s) from a computed axis-pointer result. Returns a single
 * pickable-off `LineLayer` (or `[]` when the pointer is out of plot). Data-space positions
 * co-register with ChartCanvas's auto-fit view; the guide reads slightly emphasised over the
 * frame's gridlines via the theme `fg` color. NO SVG — GPU lines only.
 */
export function buildAxisPointerLayers(
  result: AxisPointerResult,
  theme: ChartTheme = defaultChartTheme(),
  id = 'viz-axis-pointer',
): Layer[] {
  if (!result.inPlot || result.segments.length === 0) return []
  const color = parseColor(theme.fg)
  return [
    new LineLayer<FrameSegment>({
      id: `${id}-crosshair`,
      data: result.segments,
      getSourcePosition: (d: FrameSegment) => d.source,
      getTargetPosition: (d: FrameSegment) => d.target,
      getColor: color,
      getWidth: 1,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: false,
      // re-upload when the crosshair moves (segment endpoints are the trigger key).
      updateTriggers: { getSourcePosition: result.segments, getTargetPosition: result.segments },
    }),
  ]
}

export interface AxisPointerOverlayProps {
  /** The computed crosshair result (from `computeAxisPointer`). */
  readonly result: AxisPointerResult
  /** Theme-aware chrome colors (DEC-39); defaults to the light theme. */
  readonly theme?: ChartTheme
  testId?: string
}

/**
 * The DOM tooltip badge for the axis pointer — a small positioned readout of the snapped
 * x / y value(s) under the cursor. Renders nothing when there is no crosshair. It's chrome
 * (DOM text), not a data mark; the crosshair lines themselves are GPU (`buildAxisPointerLayers`).
 */
export function AxisPointerOverlay({
  result,
  theme = defaultChartTheme(),
  testId = 'viz-axis-pointer-badge',
}: AxisPointerOverlayProps) {
  if (!result.inPlot) return null
  const anchor = result.anchorPixel
  const parts: string[] = []
  if (result.x) parts.push(result.x.label)
  if (result.y) parts.push(result.y.label)
  if (parts.length === 0) return null

  // Offset the badge up-and-right of the cursor so it doesn't sit under the pointer; clamp
  // to the top-left when we have no pixel anchor (e.g. a controlled matrix with world-only).
  const left = anchor ? anchor[0] + 12 : 8
  const top = anchor ? anchor[1] + 12 : 8

  // Derive a legible badge surface from the theme foreground: a LIGHT fg means a dark theme
  // (⇒ dark badge), a dark fg means a light theme (⇒ light badge). ChartTheme has no explicit
  // surface color, so we infer one — keeping the badge readable on either theme.
  const [fr, fg_, fb] = parseColor(theme.fg)
  const fgLight = 0.2126 * fr + 0.7152 * fg_ + 0.0722 * fb > 140
  const surface = fgLight ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.92)'

  return (
    <div
      data-testid={testId}
      style={{
        position: 'absolute',
        left,
        top,
        pointerEvents: 'none',
        transform: 'translateZ(0)',
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 11,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        color: theme.fg,
        background: surface,
        border: `1px solid ${theme.grid}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
      }}
    >
      {result.x && result.y ? (
        <>
          <span style={{ color: theme.muted }}>x </span>
          {result.x.label}
          <span style={{ color: theme.muted }}>{'  y '}</span>
          {result.y.label}
        </>
      ) : (
        parts.join('')
      )}
    </div>
  )
}
