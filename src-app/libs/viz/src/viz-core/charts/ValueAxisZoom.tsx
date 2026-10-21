// ValueAxisZoom.tsx — the VALUE-AXIS (violin y) dataZoom control, now a THIN wrapper over the
// generic `AxisDataZoom`: it drives a single y axis (the value window) with a vertical slider +
// wheel-zoom + optional drag-pan (grab-the-axis). The category (x / group) axis is NEVER
// touched. Window math is the pure `./valueWindow` (→ `./axisWindow`); this file is only the
// adapter. Per-instance CONFIGURABLE via `dataZoom` (slider vs inside vs off, wheel on/off) —
// nothing hardcoded; the default preserves the prior behavior (slider + wheel). NO SVG: the
// slider is HTML, the marks stay deck.gl. Emitted testids are UNCHANGED: `${testId}`
// (container), `${testId}-canvas`, `${testId}-slider` (+ the DragRail handle/band suffixes).

import { type ReactNode } from 'react'
import { AxisDataZoom, type AxisZoomMode, type DataZoomConfig } from './AxisDataZoom'
import { minSpanFor, type ValueWindow } from './valueWindow'

export interface ValueAxisZoomProps {
  /** Full value domain (the slider min/max + the un-zoomed window). `domainLo ≤ domainHi`. */
  readonly domainLo: number
  readonly domainHi: number
  readonly value: ValueWindow
  readonly onChange: (win: ValueWindow) => void
  /**
   * When true, a drag over the plot pans the value window (VERTICAL grab-the-axis). Off when a
   * producing gesture (value-band brush / lasso) owns the pointer, so the two don't fight.
   * Default true.
   */
  readonly enablePan?: boolean
  /**
   * Per-instance dataZoom config. `false` → no zoom UI at all. `{ y, wheel }` picks the value
   * axis' control kind (`'slider'|'inside'|'both'|'off'`) + the wheel gate. Omitted → the default
   * (slider + wheel). The x/category axis is never zoomed (`x` is ignored).
   */
  readonly dataZoom?: false | DataZoomConfig
  /** The chart canvas (a `ChartCanvas` with `controller={false}` + windowed `bounds`). */
  readonly children: ReactNode
  readonly testId?: string
}

/** Default: slider + wheel on the value axis (the prior `ValueAxisZoom` behavior). */
const DEFAULT_Y_MODE: AxisZoomMode = 'both'

/**
 * Violin value-axis dataZoom over `AxisDataZoom`: a vertical slider beside the plot + wheel-zoom
 * + optional drag-pan (grab-the-axis), all per-instance configurable via `dataZoom`. The
 * category / x axis is untouched.
 */
export function ValueAxisZoom({
  domainLo,
  domainHi,
  value,
  onChange,
  enablePan = true,
  dataZoom,
  children,
  testId = 'viz-value-axis-zoom',
}: ValueAxisZoomProps) {
  if (dataZoom === false) {
    return <>{children}</>
  }
  const yMode = (dataZoom?.y ?? DEFAULT_Y_MODE) as AxisZoomMode | 'off'
  const wheelOn = dataZoom?.wheel ?? true

  if (yMode === 'off') {
    return <>{children}</>
  }

  return (
    <AxisDataZoom
      testId={testId}
      wheel={wheelOn}
      dragPan={enablePan}
      panMode="axis"
      onWindowChange={(_axis, win) => onChange(win)}
      y={{
        domain: [domainLo, domainHi],
        window: value,
        mode: yMode,
        minSpan: minSpanFor(domainLo, domainHi),
        testId: `${testId}-slider`,
      }}
    >
      {children}
    </AxisDataZoom>
  )
}
