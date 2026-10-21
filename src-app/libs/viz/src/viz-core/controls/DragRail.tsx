// DragRail.tsx — THE reusable control primitive (DEC-30). A rail with one or two
// draggable handles (+ an optional draggable band spanning them) that maps a pointer
// position to a data value in [min,max] (clamped, lo≤hi) and calls `onChange([lo,hi])`.
// Pure pointer-drag DOM (no library) — the shared body of visualMap handles, dataZoom
// slider, draggable threshold, and timeline. Framework-agnostic (no @ziee/*).
//
// The pointer→value math lives in the exported pure function `railValueAt` so it is
// unit-testable in node with no DOM.

import { useCallback, useRef, type CSSProperties, type ReactNode } from 'react'
import { LIGHT_THEME, type VizTheme } from '../theme'

/** A 1-D rail extent: `start` is the client coordinate of the value=`min` end, `size`
 *  is the signed pixel span to the value=`max` end (negative for a bottom-up axis). */
export interface RailRect {
  readonly start: number
  readonly size: number
}

/** Clamp a fraction into [0,1]. */
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Map a pointer client position onto the rail to a data value in [min,max].
 * Pure: `rect.start`/`rect.size` describe the rail extent (size may be negative for a
 * bottom-up axis). The fraction is clamped to [0,1] so out-of-rail drags saturate at
 * the endpoints. Endpoints map exactly to `min`/`max`.
 */
export function railValueAt(
  clientPos: number,
  rect: RailRect,
  min: number,
  max: number,
): number {
  if (rect.size === 0) return min
  const frac = clamp01((clientPos - rect.start) / rect.size)
  return min + frac * (max - min)
}

export interface DragRailProps {
  readonly min: number
  readonly max: number
  /** Current [lo, hi] selection (lo ≤ hi). With `handles===1`, only `hi` is draggable. */
  readonly value: readonly [number, number]
  readonly onChange: (range: [number, number]) => void
  /** 1 = single (threshold) handle; 2 = range handles + optional band. Default 2. */
  readonly handles?: 1 | 2
  /** Vertical (bottom=min, top=max) or horizontal (left=min, right=max). Default vertical. */
  readonly orientation?: 'vertical' | 'horizontal'
  /** Allow dragging the band between the two handles to shift the whole range. Default true. */
  readonly draggableBand?: boolean
  readonly length?: number
  readonly thickness?: number
  /** Rendered behind the handles (e.g. a gradient strip). */
  readonly children?: ReactNode
  /**
   * When true, the band + handle chrome render TRANSPARENT (opacity 0) but stay fully sized,
   * interactive, keyboard-operable, and keep their `-handle-hi`/`-handle-lo`/`-band` testids —
   * so a `children` canvas can own the entire visual (the ECharts single-surface model) while this
   * rail still owns hit-testing. Default false = the built-in visible chrome (unchanged).
   */
  readonly chromeless?: boolean
  readonly style?: CSSProperties
  /** Theme-aware chrome colors (handle fill/stroke). Default LIGHT_THEME. */
  readonly theme?: VizTheme
  /** Accessible label for the LOW (range-start) handle. Default "Range start". */
  readonly loLabel?: string
  /** Accessible label for the HIGH handle. Default "Range end" (or "Threshold" when `handles===1`). */
  readonly hiLabel?: string
  readonly 'data-testid'?: string
}

type DragTarget = 'lo' | 'hi' | 'band'

/** Fraction (0..1) of a value across [min,max]. */
function valueFrac(v: number, min: number, max: number): number {
  return max === min ? 0 : clamp01((v - min) / (max - min))
}

/** A rail with 1–2 draggable handles + optional band. The reusable control body. */
export function DragRail({
  min,
  max,
  value,
  onChange,
  handles = 2,
  orientation = 'vertical',
  draggableBand = true,
  length = 180,
  thickness = 18,
  children,
  chromeless = false,
  style,
  theme = LIGHT_THEME,
  loLabel,
  hiLabel,
  'data-testid': testId,
}: DragRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ target: DragTarget; grabValue: number; lo: number; hi: number } | null>(null)
  const vertical = orientation === 'vertical'

  const railRect = useCallback((): RailRect => {
    const el = railRef.current
    if (!el) return { start: 0, size: vertical ? -length : length }
    const r = el.getBoundingClientRect()
    // vertical: bottom is min, top is max → start at bottom, negative size upward.
    return vertical
      ? { start: r.bottom, size: -r.height }
      : { start: r.left, size: r.width }
  }, [vertical, length])

  const posAt = useCallback(
    (e: { clientX: number; clientY: number }): number =>
      railValueAt(vertical ? e.clientY : e.clientX, railRect(), min, max),
    [vertical, railRect, min, max],
  )

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const v = posAt(e)
      let [lo, hi] = [d.lo, d.hi]
      if (d.target === 'lo') {
        lo = Math.min(Math.max(v, min), hi)
      } else if (d.target === 'hi') {
        hi = Math.max(Math.min(v, max), lo)
      } else {
        // band: shift both by the drag delta, clamped so the whole span stays in range.
        const width = d.hi - d.lo
        let newLo = v - d.grabValue
        newLo = Math.min(Math.max(newLo, min), max - width)
        lo = newLo
        hi = newLo + width
      }
      onChange([lo, hi])
    },
    [posAt, min, max, onChange],
  )

  const endDrag = useCallback(() => {
    drag.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
  }, [onPointerMove])

  const startDrag = useCallback(
    (target: DragTarget) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const [lo, hi] = value
      drag.current = { target, grabValue: posAt(e.nativeEvent) - (target === 'band' ? lo : 0), lo, hi }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', endDrag)
    },
    [value, posAt, onPointerMove, endDrag],
  )

  // Keyboard operability (a11y). Move one handle by a clamped delta and commit through the SAME
  // `onChange` path the pointer drag uses — so lo≤hi is enforced identically and keyboard nudges
  // are semantically indistinguishable from a pointer drag to every consumer/window-update path.
  const setHandle = useCallback(
    (target: 'lo' | 'hi', nextRaw: number) => {
      let [lo, hi] = value
      if (target === 'lo') {
        lo = Math.min(Math.max(nextRaw, min), hi)
      } else {
        hi = Math.max(Math.min(nextRaw, max), lo)
      }
      onChange([lo, hi])
    },
    [value, min, max, onChange],
  )

  // ArrowRight/ArrowUp increase, ArrowLeft/ArrowDown decrease by a small step (2% of range;
  // Shift = a coarse 10% step); PageUp/PageDown = coarse; Home/End jump to min/max. Up/Down and
  // Left/Right are both accepted regardless of orientation (standard slider behavior); the sign
  // is consistent (toward `max` = ArrowUp/ArrowRight), which matches this rail's min→max mapping
  // (vertical: bottom=min/top=max; horizontal: left=min/right=max).
  const onHandleKeyDown = useCallback(
    (target: 'lo' | 'hi') => (e: React.KeyboardEvent) => {
      const range = max - min
      if (range === 0) return
      const step = (e.shiftKey ? 0.1 : 0.02) * range
      const cur = target === 'lo' ? value[0] : value[1]
      let next: number
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = cur + step
          break
        case 'ArrowLeft':
        case 'ArrowDown':
          next = cur - step
          break
        case 'PageUp':
          next = cur + range * 0.1
          break
        case 'PageDown':
          next = cur - range * 0.1
          break
        case 'Home':
          next = min
          break
        case 'End':
          next = max
          break
        default:
          return
      }
      e.preventDefault()
      setHandle(target, next)
    },
    [value, min, max, setHandle],
  )

  const loFrac = valueFrac(value[0], min, max)
  const hiFrac = valueFrac(value[1], min, max)

  // position helpers: fraction → CSS offset (vertical measured from bottom).
  const at = (frac: number): CSSProperties =>
    vertical ? { bottom: `${frac * 100}%` } : { left: `${frac * 100}%` }
  const bandStyle: CSSProperties = vertical
    ? { bottom: `${loFrac * 100}%`, height: `${(hiFrac - loFrac) * 100}%`, left: 0, right: 0 }
    : { left: `${loFrac * 100}%`, width: `${(hiFrac - loFrac) * 100}%`, top: 0, bottom: 0 }

  const handleStyle = (frac: number, target: DragTarget): CSSProperties => ({
    position: 'absolute',
    ...at(frac),
    ...(vertical
      ? { left: -3, right: -3, height: 8, transform: 'translateY(50%)' }
      : { top: -3, bottom: -3, width: 8, transform: 'translateX(-50%)' }),
    // chromeless: transparent + no border/shadow, but still sized + interactive (a `children` canvas
    // draws the visible handle). opacity is NOT changed — Playwright still sees it as `visible`.
    background: chromeless ? 'transparent' : theme.surface,
    border: chromeless ? 'none' : `1px solid ${theme.fg}`,
    borderRadius: 3,
    boxShadow: chromeless ? 'none' : '0 1px 2px rgba(0,0,0,0.3)',
    cursor: vertical ? 'ns-resize' : 'ew-resize',
    touchAction: 'none',
    zIndex: 2,
  })

  return (
    <div
      ref={railRef}
      data-testid={testId}
      style={{
        position: 'relative',
        ...(vertical ? { width: thickness, height: length } : { width: length, height: thickness }),
        touchAction: 'none',
        // A rail is always interactive: re-arm pointer events so it works even when an ancestor is
        // pointerEvents:none — e.g. a chart migrated to the shared grid deck, whose cell passes
        // pan/zoom THROUGH to the deck. No-op in the normal (pointerEvents:auto) case.
        pointerEvents: 'auto',
        ...style,
      }}
    >
      {children}
      {handles === 2 && draggableBand && (
        <div
          data-testid={testId ? `${testId}-band` : undefined}
          onPointerDown={startDrag('band')}
          style={{
            position: 'absolute',
            ...bandStyle,
            background: chromeless ? 'transparent' : 'rgba(120,150,255,0.18)',
            cursor: vertical ? 'ns-resize' : 'ew-resize',
            touchAction: 'none',
            zIndex: 1,
          }}
        />
      )}
      {handles === 2 && (
        <div
          data-testid={testId ? `${testId}-handle-lo` : undefined}
          onPointerDown={startDrag('lo')}
          onKeyDown={onHandleKeyDown('lo')}
          role="slider"
          tabIndex={0}
          aria-label={loLabel ?? 'Range start'}
          aria-orientation={vertical ? 'vertical' : 'horizontal'}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value[0]}
          style={handleStyle(loFrac, 'lo')}
        />
      )}
      <div
        data-testid={testId ? `${testId}-handle-hi` : undefined}
        onPointerDown={startDrag('hi')}
        onKeyDown={onHandleKeyDown('hi')}
        role="slider"
        tabIndex={0}
        aria-label={hiLabel ?? (handles === 1 ? 'Threshold' : 'Range end')}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value[1]}
        style={handleStyle(hiFrac, 'hi')}
      />
    </div>
  )
}
