// MatrixDataZoom.tsx — the MATRIX (2-axis, index-unit) dataZoom control, now a THIN wrapper
// over the generic `AxisDataZoom`: it maps cols→x, rows→y (rows inverted so row 0 sits at the
// top), snaps each slider edge to a whole cell, and merges the two per-axis callbacks back into
// one `MatrixWindow`. The window math is the pure `./axisWindow` (via `./matrixWindow`); this
// file is only the adapter. Per-instance CONFIGURABLE via `dataZoom` (which axes, slider vs
// inside vs off, wheel on/off) — nothing is hardcoded; the default preserves the prior behavior
// (cols + rows sliders, wheel on). Emitted testids are UNCHANGED: `${testId}` (container),
// `${testId}-canvas`, `${testId}-cols`, `${testId}-rows` (+ the DragRail handle/band suffixes).

import { useRef, type ReactNode } from 'react'
import { AxisDataZoom, type AxisZoomMode, type DataZoomConfig } from './AxisDataZoom'
import type { AxisWindow } from './axisWindow'
import { handleToIndex, MIN_WINDOW, type MatrixWindow } from './matrixWindow'

export type { AxisZoomMode, DataZoomConfig }

/** Default: both sliders + wheel (the prior `MatrixDataZoom` behavior). */
const DEFAULT_CONFIG: DataZoomConfig = { x: 'both', y: 'both', wheel: true }

export interface MatrixDataZoomProps {
  readonly nRows: number
  readonly nCols: number
  readonly value: MatrixWindow
  readonly onChange: (win: MatrixWindow) => void
  /** The chart canvas (a `ChartCanvas` with `controller={false}` + windowed `bounds`). */
  readonly children: ReactNode
  /**
   * Per-instance dataZoom config. `false` → no zoom UI at all. `{ x, y, wheel }` picks each
   * axis' control kind (`'slider'|'inside'|'both'|'off'`) + the master wheel gate. Omitted →
   * the default (both sliders + wheel). A legacy `wheel` prop still overrides the master gate.
   */
  readonly dataZoom?: false | DataZoomConfig
  /** @deprecated legacy master wheel gate; prefer `dataZoom.wheel`. Overrides it when set. */
  readonly wheel?: boolean
  readonly testId?: string
}

/**
 * Matrix-chart dataZoom over `AxisDataZoom`: cols under the matrix, rows beside it, wheel-zoom
 * + drag-pan (grab-content) over the canvas, all per-instance configurable via `dataZoom`.
 */
export function MatrixDataZoom({
  nRows,
  nCols,
  value,
  onChange,
  children,
  dataZoom,
  wheel,
  testId = 'viz-matrix-datazoom',
}: MatrixDataZoomProps) {
  // Bridge two same-tick per-axis emits (a wheel/drag touches both axes) onto the freshest
  // window so the second call doesn't clobber the first's axis before React re-renders.
  const valueRef = useRef(value)
  valueRef.current = value

  if (dataZoom === false) {
    return <>{children}</>
  }
  const cfg = dataZoom ?? DEFAULT_CONFIG
  const xMode = (cfg.x ?? 'both') as AxisZoomMode | 'off'
  const yMode = (cfg.y ?? 'both') as AxisZoomMode | 'off'
  const wheelOn = wheel ?? cfg.wheel ?? true

  const emit = (axis: 'x' | 'y', win: AxisWindow) => {
    const cur = valueRef.current
    const next: MatrixWindow =
      axis === 'x'
        ? { ...cur, col0: win.lo, col1: win.hi }
        : { ...cur, row0: win.lo, row1: win.hi }
    valueRef.current = next
    onChange(next)
  }

  return (
    <AxisDataZoom
      testId={testId}
      wheel={wheelOn}
      dragPan
      panMode="content"
      onWindowChange={emit}
      x={
        xMode === 'off'
          ? undefined
          : {
              domain: [0, nCols],
              window: { lo: value.col0, hi: value.col1 },
              mode: xMode,
              snap: v => handleToIndex(v, nCols),
              minSpan: MIN_WINDOW,
              testId: `${testId}-cols`,
            }
      }
      y={
        yMode === 'off'
          ? undefined
          : {
              domain: [0, nRows],
              window: { lo: value.row0, hi: value.row1 },
              mode: yMode,
              invert: true,
              snap: v => handleToIndex(v, nRows),
              minSpan: MIN_WINDOW,
              testId: `${testId}-rows`,
            }
      }
    >
      {children}
    </AxisDataZoom>
  )
}
