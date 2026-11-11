import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { ScrollRegionContext } from './ScrollRegionContext'
import {
  getScrollPosition,
  saveScrollPosition,
  scrollCacheKey,
} from '../lib/scrollCache'

/**
 * txrshell — ScrollRegion (app-shell ITEM-1, DEC-3).
 *
 * The one scroll container a page may use (a page never invents its own):
 * focusable (`tabIndex={0}`), labelled (`role="region"` + `aria-label`),
 * `overflow: auto` with `scrollbar-gutter: stable` so content never jumps
 * sideways when the bar appears, subtle top/bottom shadow cues when there
 * is more content in that direction, and the scroll position restored on
 * Back / kept per route in memory.
 *
 * Keyboard: the region answers PageDown/Space (next page), PageUp /
 * Shift+Space (previous page) and Home/End (edges) while any of its
 * content has focus — the audit's "Tab reaches each region, PageDown/Space
 * scrolls it". A native control inside the region keeps its own key
 * behaviour (Space on a button activates the button).
 *
 * The shadow cue is a state-driven overlay (the scroll event + a resize
 * observer), never a CSS `background-attachment` trick: the region's
 * background must stay the app token so the dark theme cannot half-apply.
 */

/** The scroll metrics a shadow/keyboard decision reads (structural, testable). */
export interface ScrollMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/** Where the region is, relative to its content (the shadow cues' truth). */
export interface RegionEdges {
  /** Content overflows the region at all. */
  overflow: boolean
  /** The top edge is in view (no "more above" cue). */
  atStart: boolean
  /** The bottom edge is in view (no "more below" cue). */
  atEnd: boolean
}

/** The pure edge computation — the one place the cue truth lives. */
export function regionEdges(m: ScrollMetrics): RegionEdges {
  const overflow = m.scrollHeight > m.clientHeight + 1
  return {
    overflow,
    atStart: m.scrollTop <= 1,
    atEnd: !overflow || m.scrollTop + m.clientHeight >= m.scrollHeight - 1,
  }
}

/** The page step: a client page is roughly the region's own height — the
 *  same step a browser scrolls for PageDown. */
export function pageStep(m: ScrollMetrics): number {
  return Math.max(1, Math.round(m.clientHeight * 0.9))
}

/** Scroll by one page (dir +1 down / -1 up), clamped to the content. */
export function scrollByPage(m: ScrollMetrics, dir: 1 | -1): void {
  const next = m.scrollTop + dir * pageStep(m)
  m.scrollTop = Math.max(0, Math.min(next, m.scrollHeight - m.clientHeight))
}

/** Jump to an edge ('start' | 'end'), clamped to the content. */
export function scrollToEdge(m: ScrollMetrics, edge: 'start' | 'end'): void {
  m.scrollTop = edge === 'start' ? 0 : Math.max(0, m.scrollHeight - m.clientHeight)
}

export interface ScrollRegionProps {
  /** The region's accessible name (labelled `role="region"`). */
  label: string
  children: ReactNode
  /** By default the route pathname + label key the scroll cache. */
  restoreKey?: string
  className?: string
  style?: CSSProperties
  testId?: string
}

/** A focused native control keeps its own Space/Enter behaviour. */
function isNativeControl(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'button, input, textarea, select, a[href], [contenteditable="true"], [role="button"]',
      ),
    )
  )
}

export function ScrollRegion({
  label,
  children,
  restoreKey,
  className,
  style,
  testId,
}: ScrollRegionProps) {
  const location = useLocation()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  // A STABLE ref callback (React detaches+reattaches an inline callback on
  // every render, and setState there would re-render forever): the node
  // lands in state exactly once per mount, and the shared context value
  // gains the element the region will publish.
  const setRegionNode = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    setNode(el)
  }, [])
  const [edges, setEdges] = useState<RegionEdges>({
    overflow: false,
    atStart: true,
    atEnd: true,
  })
  const key = restoreKey ?? scrollCacheKey(location.pathname, label)

  const updateEdges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setEdges(
      regionEdges({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }),
    )
  }, [])

  // Restore the remembered position on mount (Back included), then keep the
  // edges truth current and the position saved as the user scrolls.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const remembered = getScrollPosition(key)
    if (remembered !== undefined) el.scrollTop = remembered
    updateEdges()
    const onScroll = (): void => {
      updateEdges()
      saveScrollPosition(key, el.scrollTop)
    }
    el.addEventListener('scroll', onScroll)
    let ro: ResizeObserver | undefined
    // Content can grow/shrink without a scroll event (a table finishing
    // loading, a disclosure opening) — re-measure then too. jsdom has no
    // ResizeObserver; the guarded fallback re-measures on window resize.
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        updateEdges()
        saveScrollPosition(key, el.scrollTop)
      })
      ro.observe(el)
    }
    window.addEventListener('resize', onScroll)
    return () => {
      // NO save here. The same ScrollRegion instance is often reconciled
      // between two views of a route (the same component position in the
      // tree): the effect cleanup runs with the element already showing the
      // OTHER view's content, whose scroll position may be CLAMPED (shorter
      // content) — saving that would overwrite this view's remembered
      // position. The scroll listener is the honest writer (the browser
      // fires it before the navigation click; the position the user last
      // saw is exactly the one it saved).
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      ro?.disconnect()
    }
  }, [key, updateEdges])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isNativeControl(event.target)) return
    const el = scrollRef.current
    if (!el) return
    // The metric snapshot is the input; the scroll-step helpers MUTATE it
    // (their contract — see TEST-AS-1's pins), so the result is written to
    // the element only after the switch (a fresh object per keypress: a
    // mutate-then-move pair that the e2e keyboard leg measures).
    const m: ScrollMetrics = {
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }
    let handled = true
    switch (event.key) {
      case 'PageDown':
        scrollByPage(m, 1)
        break
      case ' ':
        scrollByPage(m, event.shiftKey ? -1 : 1)
        break
      case 'PageUp':
        scrollByPage(m, -1)
        break
      case 'Home':
        scrollToEdge(m, 'start')
        break
      case 'End':
        scrollToEdge(m, 'end')
        break
      default:
        handled = false
    }
    if (handled) {
      el.scrollTop = m.scrollTop
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // The shadows: two gradients overlaid on the region's edges, rendered only
  // when the corresponding edge has more content (opacity 0 otherwise), and
  // pointer-transparent so they never block a row's click. The gradients use
  // the app tokens (a hard-coded white would stay white in dark mode).
  const showTop = edges.overflow && !edges.atStart
  const showBottom = edges.overflow && !edges.atEnd
  const fade = 'color-mix(in srgb, var(--txr-surface-dim) 88%, transparent)'
  const shadowStyle = (from: 'top' | 'bottom', visible: boolean): CSSProperties => ({
    position: 'absolute',
    left: 0,
    right: 0,
    height: 28,
    top: from === 'top' ? 0 : undefined,
    bottom: from === 'bottom' ? 0 : undefined,
    pointerEvents: 'none',
    opacity: visible ? 1 : 0,
    transition: 'opacity 120ms ease',
    background:
      from === 'top'
        ? `linear-gradient(to bottom, ${fade}, transparent)`
        : `linear-gradient(to top, ${fade}, transparent)`,
  })

  // The region element, published for a DataTable's virtualizer. The ref
  // callback keeps the published node in state so a consumer that mounts
  // alongside re-renders once the node exists.
  const publicCtx = useMemo(() => ({ current: node }), [node])

  return (
    <ScrollRegionContext.Provider value={publicCtx}>
      <div
        className={`txr-scroll-region-frame ${className ?? ''}`}
        style={{ position: 'relative', minHeight: 0, height: '100%' }}
      >
        <div
          ref={setRegionNode}
          role="region"
          aria-label={label}
          tabIndex={0}
          data-testid={testId ?? 'txr-scroll-region'}
          className="txr-scroll-region"
          style={{
            overflowY: 'auto',
            overflowX: 'auto',
            scrollbarGutter: 'stable',
            height: '100%',
            outline: 'none',
            position: 'relative',
            ...style,
          }}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
        <div
          aria-hidden
          data-testid="txr-scroll-region-shadow-top"
          style={shadowStyle('top', showTop)}
        />
        <div
          aria-hidden
          data-testid="txr-scroll-region-shadow-bottom"
          style={shadowStyle('bottom', showBottom)}
        />
      </div>
    </ScrollRegionContext.Provider>
  )
}
