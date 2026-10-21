// paneScroll — where a pane was scrolled to, kept across a tab switch.
//
// A region renders only its ACTIVE tab, so returning to a pane re-creates its scroll container from
// nothing: zero height, no content, whatever its panel is about to fetch still in flight. Writing
// the saved offset at that moment writes it into a container with nothing to scroll; the browser
// clamps it to 0, and the pane "restores" to the top — the exact state this exists to avoid.
//
// So restoring is a small state machine over the container's own measurements rather than a single
// assignment. It re-attempts on every re-measure, getting as close to the saved offset as the
// content so far allows, and stops the instant either the offset is reached or the USER scrolls —
// dragging someone back to a remembered position after they have moved is worse than forgetting it.
//
// The controller is framework-free and takes only the three numbers every scroll container has, so
// the policy is directly testable and knows nothing about overlayscrollbars (which is what the kit's
// `ScrollArea` actually is; `usePaneScroll` adapts its events onto this).

import { useMemo, useRef } from 'react'
import { getPaneState, setPaneState } from './paneState'

/** The only thing this policy may know about a scroll container. */
export interface ScrollTarget {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

export interface PaneScrollController {
  /** The container was (re)measured — mount, resize, or content arriving. */
  measured: (el: ScrollTarget) => void
  /** The container scrolled. A USER scroll ends the restore and becomes the new saved offset. */
  scrolled: (el: ScrollTarget) => void
}

/** Track + restore one pane's scroll offset. `key` names the field inside that pane's state, so a
 *  pane with two scroll containers can keep both. */
export function createPaneScrollController(paneId: string, key = 'scrollTop'): PaneScrollController {
  // `restoring` is the whole state: true until the saved offset is reached or the user takes over.
  let restoring = true
  // The last offset WE wrote, so the scroll event our own write provokes is not mistaken for the
  // user scrolling — saving it would overwrite the offset we are still working towards.
  let applied: number | null = null

  const saved = (): number => {
    const v = getPaneState(paneId)?.[key]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  }

  return {
    measured(el) {
      if (!restoring) return
      const want = saved()
      if (want <= 0) {
        restoring = false
        return
      }
      // Clamped to what the content ALLOWS, which is the whole defence against the naive restore:
      // measured before the panel's fetch lands there is nothing to scroll, so this is 0 — the
      // position the container is already in — and the write below is skipped rather than
      // "restoring" the pane to the top. The offset stays saved for the next measurement.
      const next = Math.min(want, Math.max(0, el.scrollHeight - el.clientHeight))
      if (next !== el.scrollTop) {
        el.scrollTop = next
        applied = next
      }
      // Reached it — done. Short of it, the content is still growing; a later measure gets closer.
      if (next >= want) restoring = false
    },

    scrolled(el) {
      // Our own write, echoed back as a scroll event: saving it would overwrite the offset we are
      // still working towards with the partial position we have reached so far.
      if (restoring && applied !== null && el.scrollTop === applied) return
      // Recording where the USER went is also what ends the restore: the offset it chases is read
      // back out of pane state on the next measure, and it is now their own position.
      setPaneState(paneId, { [key]: el.scrollTop })
    },
  }
}

/** The overlayscrollbars instance, structurally — the kit's `ScrollArea` hands its event listeners
 *  one of these, and `scrollOffsetElement` is the element that actually scrolls. */
interface ScrollInstance {
  elements: () => { scrollOffsetElement: ScrollTarget }
}

/**
 * Bind a pane's scroll offset to its pane state. Spread the result onto the kit `ScrollArea`'s
 * `events` prop:
 *
 * ```tsx
 * <ScrollArea axis="y" events={usePaneScroll(pane.id)}>…</ScrollArea>
 * ```
 *
 * `updated` is overlayscrollbars' own "the content or the box changed size" signal, which is why no
 * `setTimeout`-until-it-looks-ready hack is needed to find the moment the content is tall enough.
 */
export function usePaneScroll(
  paneId: string,
  key = 'scrollTop',
): { initialized: (i: ScrollInstance) => void; updated: (i: ScrollInstance) => void; scroll: (i: ScrollInstance) => void } {
  const ref = useRef<{ paneId: string; key: string; controller: PaneScrollController } | null>(null)
  if (!ref.current || ref.current.paneId !== paneId || ref.current.key !== key) {
    ref.current = { paneId, key, controller: createPaneScrollController(paneId, key) }
  }
  const controller = ref.current.controller
  return useMemo(
    () => ({
      initialized: (i: ScrollInstance) => controller.measured(i.elements().scrollOffsetElement),
      updated: (i: ScrollInstance) => controller.measured(i.elements().scrollOffsetElement),
      scroll: (i: ScrollInstance) => controller.scrolled(i.elements().scrollOffsetElement),
    }),
    [controller],
  )
}
