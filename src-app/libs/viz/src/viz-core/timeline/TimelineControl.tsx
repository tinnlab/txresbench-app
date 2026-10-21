// TimelineControl.tsx — a DragRail-based SCRUBBER (ITEM-46) that drives a `TimelineModel`.
// A horizontal rail whose single handle scrubs the frame, plus play/pause + prev/next
// step buttons and an rAF play loop. Controlled: `model` in, `onChange(model)` out —
// the parent maps `model.frame` → a GPU `filterRange` (frameToRange) to filter points.
// Framework-agnostic viz-core (no @ziee/*): reuses the shared DragRail primitive (does
// NOT reimplement pointer-drag).

import { useCallback, useEffect, useRef } from 'react'
import { DragRail } from '../controls/DragRail'
import { LIGHT_THEME, type VizTheme } from '../theme'
import {
  advance,
  seek,
  setPlaying,
  step,
  frameLabel,
  type TimelineModel,
} from './timeline'

export interface TimelineControlProps {
  readonly model: TimelineModel
  readonly onChange: (model: TimelineModel) => void
  /** window fraction (0..1) used only for the frame LABEL (matches the scatter's window). */
  readonly window?: number
  readonly length?: number
  readonly theme?: VizTheme
  readonly 'data-testid'?: string
}

/** A themed square control button (play / pause / step). */
function ControlButton({
  onClick,
  label,
  theme,
  testId,
  children,
}: {
  onClick: () => void
  label: string
  theme: VizTheme
  testId?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        background: theme.surface,
        color: theme.fg,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  )
}

/**
 * The scrubber. The rail domain is FRAME space `[0, frameCount-1]`; its single handle
 * (`handles={1}`) reports the scrubbed `hi`, rounded to a frame via `seek`. The play loop
 * (rAF, active only while `model.playing`) advances by real `dt` and is torn down on
 * pause / unmount — reading the LATEST model from a ref so it never advances a stale one.
 */
export function TimelineControl({
  model,
  onChange,
  window: windowFrac = 0.15,
  length = 320,
  theme = LIGHT_THEME,
  'data-testid': testId,
}: TimelineControlProps) {
  const modelRef = useRef(model)
  modelRef.current = model
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // rAF play loop — restarts when `playing` flips; cleans up on pause/unmount.
  useEffect(() => {
    if (!model.playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      onChangeRef.current(advance(modelRef.current, dt))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [model.playing])

  const railMax = Math.max(1, model.frameCount - 1)

  const onScrub = useCallback(
    (range: [number, number]) => {
      // handles=1 → range[1] is the live scrub position. Pause while scrubbing so the
      // play loop doesn't fight the drag; land on the nearest integer frame.
      onChangeRef.current(seek(setPlaying(modelRef.current, false), Math.round(range[1])))
    },
    [],
  )

  const togglePlay = useCallback(() => {
    onChangeRef.current(setPlaying(modelRef.current, !modelRef.current.playing))
  }, [])
  const stepBy = useCallback((d: number) => {
    onChangeRef.current(step(setPlaying(modelRef.current, false), d))
  }, [])

  const rangeOpts = {
    min: model.min,
    max: model.max,
    frameCount: model.frameCount,
    window: windowFrac,
  }

  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        color: theme.fg,
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        <ControlButton onClick={() => stepBy(-1)} label="Previous frame" theme={theme} testId={testId ? `${testId}-prev` : undefined}>
          ⏮
        </ControlButton>
        <ControlButton onClick={togglePlay} label={model.playing ? 'Pause' : 'Play'} theme={theme} testId={testId ? `${testId}-play` : undefined}>
          {model.playing ? '⏸' : '▶'}
        </ControlButton>
        <ControlButton onClick={() => stepBy(1)} label="Next frame" theme={theme} testId={testId ? `${testId}-next` : undefined}>
          ⏭
        </ControlButton>
      </div>

      <DragRail
        min={0}
        max={railMax}
        value={[0, Math.min(model.frame, railMax)]}
        handles={1}
        orientation="horizontal"
        onChange={onScrub}
        length={length}
        theme={theme}
        data-testid={testId ? `${testId}-rail` : undefined}
      >
        {/* rail track */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            height: 4,
            transform: 'translateY(-50%)',
            background: theme.grid,
            borderRadius: 2,
          }}
        />
      </DragRail>

      <span
        data-testid={testId ? `${testId}-label` : undefined}
        style={{ fontSize: 12, color: theme.muted, minWidth: 96, fontVariantNumeric: 'tabular-nums' }}
      >
        {frameLabel(model.frame, rangeOpts)}
      </span>
    </div>
  )
}
