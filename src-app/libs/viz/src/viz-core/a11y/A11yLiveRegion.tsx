// A11yLiveRegion.tsx — the visually-hidden ARIA live region DOM element (ITEM-60).
//
// A GPU canvas emits no DOM mutations on pan/zoom/selection, so screen readers hear
// nothing. This renders an off-screen `role="status" aria-live="polite"` node and exposes
// an imperative `announce(msg)` handle a parent calls on each state change; the screen
// reader speaks the updated text. Styled with the sr-only clip pattern (NOT
// `display:none` / `visibility:hidden`, which would remove it from the accessibility tree)
// so it stays reachable by assistive tech while invisible on screen.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from 'react'
import { LiveRegion, type Politeness } from './liveRegion'

/** The imperative handle a parent uses to speak an announcement. */
export interface A11yLiveRegionHandle {
  announce: (msg: string) => void
}

export interface A11yLiveRegionProps {
  /** `polite` (default) waits for a pause; `assertive` interrupts the screen reader. */
  politeness?: Politeness
  /** Debounce window (ms) before the text is written; forwarded to {@link LiveRegion}. */
  debounceMs?: number
  /** Optional test hook: fired with every message actually written to the region. */
  onAnnounce?: (msg: string) => void
}

// The canonical "screen-reader only" style: a 1px clipped box that stays in the a11y tree.
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

export const A11yLiveRegion = forwardRef<A11yLiveRegionHandle, A11yLiveRegionProps>(
  function A11yLiveRegion({ politeness = 'polite', debounceMs, onAnnounce }, ref) {
    const elRef = useRef<HTMLDivElement | null>(null)
    const region = useMemo(
      () => new LiveRegion({ politeness, debounceMs }),
      [politeness, debounceMs],
    )

    useEffect(() => {
      region.attach(elRef.current)
      return () => region.dispose()
    }, [region])

    useImperativeHandle(
      ref,
      () => ({
        announce: (msg: string) => {
          region.announce(msg)
          onAnnounce?.(msg)
        },
      }),
      [region, onAnnounce],
    )

    return (
      <div
        ref={elRef}
        role="status"
        aria-live={politeness}
        aria-atomic="true"
        data-testid="viz-a11y-live-region"
        style={SR_ONLY}
      />
    )
  },
)
