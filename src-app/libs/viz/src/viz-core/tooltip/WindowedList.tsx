// WindowedList.tsx — a tiny, self-contained fixed-row VIRTUAL list (no dependency, no SVG). Renders
// ONLY the rows in view (+ overscan) out of a possibly-huge item count, so the overlap dialog can
// list tens of thousands of points cheaply — each visible row is built lazily by `renderRow(index)`.
//
// The visible-range math is the pure exported `windowRange` (unit-tested without a DOM); the
// component is a thin scroll container around it.

import { useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react'

export interface WindowRange {
  /** first row index to render (inclusive). */
  readonly start: number
  /** one past the last row index to render (exclusive). */
  readonly end: number
  /** px spacer above `start` (== start * rowHeight). */
  readonly padTop: number
  /** total scrollable height (== itemCount * rowHeight). */
  readonly totalHeight: number
}

/**
 * Pure visible-range calc for a fixed-row-height list. Given the scroll offset, viewport height,
 * row height, item count and overscan, returns the [start,end) rows to render plus the top spacer
 * and total height. Clamped to `[0, itemCount]`; tolerates zero/negative inputs.
 */
export function windowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  itemCount: number,
  overscan = 4,
): WindowRange {
  const rh = Math.max(1, rowHeight)
  const count = Math.max(0, Math.floor(itemCount))
  const totalHeight = count * rh
  const top = Math.max(0, scrollTop)
  const first = Math.floor(top / rh) - overscan
  const visible = Math.ceil(Math.max(0, viewportHeight) / rh) + overscan * 2
  // Clamp `start` to `[0, count]` so an out-of-content scrollTop can never yield start>end or a
  // padTop past totalHeight (the DOM caps scrollTop, but keep the pure contract `start<=end`).
  const start = Math.min(count, Math.max(0, first))
  const end = Math.min(count, Math.max(start, first + visible))
  return { start, end, padTop: start * rh, totalHeight }
}

export interface WindowedListProps {
  readonly itemCount: number
  readonly rowHeight: number
  /** viewport height in px (the scroll container). */
  readonly height: number
  /** lazy per-row renderer — called ONLY for rows currently in view. */
  readonly renderRow: (index: number) => ReactNode
  readonly overscan?: number
  readonly testId?: string
}

export function WindowedList({
  itemCount,
  rowHeight,
  height,
  renderRow,
  overscan = 4,
  testId = 'viz-windowed-list',
}: WindowedListProps) {
  const [scrollTop, setScrollTop] = useState(0)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef(0)

  // Cancel a scheduled scroll flush on unmount (e.g. closing the dialog mid-scroll) so it can't
  // setState after unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafRef.current)
      }
    },
    [],
  )

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    pendingRef.current = e.currentTarget.scrollTop
    if (typeof requestAnimationFrame === 'undefined') {
      setScrollTop(pendingRef.current)
    } else if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setScrollTop(pendingRef.current)
      })
    }
  }

  const { start, end, padTop, totalHeight } = windowRange(
    scrollTop,
    height,
    rowHeight,
    itemCount,
    overscan,
  )
  const rows: ReactNode[] = []
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} style={{ height: rowHeight, boxSizing: 'border-box' }}>
        {renderRow(i)}
      </div>,
    )
  }

  return (
    <div
      data-testid={testId}
      onScroll={onScroll}
      style={{ height, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: padTop, left: 0, right: 0 }}>{rows}</div>
      </div>
    </div>
  )
}
