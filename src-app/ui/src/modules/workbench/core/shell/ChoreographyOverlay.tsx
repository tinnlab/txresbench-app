// ChoreographyOverlay (richer-actions ITEM-7) — the VISIBLE half of a choreographed
// action: a spotlight ring that tracks the affordance element the runner
// (`core/actions/choreography.ts`) is acting on, plus a bottom-center caption pill
// (present only on a fully-narrated / AI run — DEC-6). It subscribes to the
// choreography bus and reads the live element from the affordance registry. It is
// `pointer-events-none` (never blocks input) and respects `prefers-reduced-motion`
// (no ring transition / no per-frame tracking — measured once). The ring is
// positioned IMPERATIVELY in a rAF loop (never per-frame React state — that would
// re-render the overlay every frame), so only active/inactive + caption text are
// React state. Mounted once in `WorkbenchShell` (DEC-9); `fixed` → viewport-cover
// regardless of subtree placement.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getAffordance } from '@/core/actions/affordances'
import { subscribeChoreography } from '@/core/actions/choreographyBus'
import { prefersReducedMotion } from '@/core/actions/choreography'

interface ActiveSpotlight {
  name: string
  caption?: string
}

/** Padding (px) between the spotlit element's box and the ring, on every side.
 *  Kept in sync with the `ring-offset-2` styling below (2px offset inside 6px pad). */
const SPOTLIGHT_PAD_PX = 6

export function ChoreographyOverlay() {
  const [active, setActive] = useState<ActiveSpotlight | null>(null)
  const ringRef = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      subscribeChoreography(event => {
        setActive(event.type === 'clear' ? null : { name: event.name, caption: event.caption })
      }),
    [],
  )

  // Track the spotlit element imperatively (no per-frame React state). Reduced
  // motion measures once and stops (no rAF loop, no transition).
  useEffect(() => {
    if (!active) return
    const reduced = prefersReducedMotion()
    let raf = 0
    const place = () => {
      const ring = ringRef.current
      const el = getAffordance(active.name)?.el
      if (ring && el) {
        const r = el.getBoundingClientRect()
        ring.style.transform = `translate(${r.left - SPOTLIGHT_PAD_PX}px, ${r.top - SPOTLIGHT_PAD_PX}px)`
        ring.style.width = `${r.width + SPOTLIGHT_PAD_PX * 2}px`
        ring.style.height = `${r.height + SPOTLIGHT_PAD_PX * 2}px`
        ring.style.opacity = '1'
      }
      if (!reduced) raf = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(raf)
  }, [active])

  if (!active) return null

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-50" data-testid="choreography-overlay">
      <div
        ref={ringRef}
        data-testid="choreography-spotlight"
        aria-hidden="true"
        className="absolute left-0 top-0 rounded-md ring-2 ring-primary ring-offset-2 ring-offset-background motion-safe:transition-all motion-safe:duration-200"
        style={{ opacity: 0 }}
      />
      {active.caption ? (
        <div className="absolute inset-x-0 bottom-6 flex justify-center">
          {/* role=status + aria-live so a screen-reader user hears each AI step. Not
              aria-hidden (unlike the decorative ring) — it IS the narration. */}
          <div
            role="status"
            aria-live="polite"
            data-testid="choreography-caption"
            className="rounded-full border border-border bg-popover px-4 py-1.5 text-xs font-medium text-popover-foreground shadow-md"
          >
            {active.caption}
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
