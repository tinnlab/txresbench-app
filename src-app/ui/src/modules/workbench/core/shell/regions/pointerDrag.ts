// pointerDrag — the shell's ONE reorder-drag primitive, extracted from `RegionShell`'s
// `startTabDrag` so a second draggable surface reuses it rather than growing a second stack.
//
// ── Why pointer events and not HTML5 DnD ────────────────────────────────────────────────
//
// The tab drag was written this way deliberately and has been in production since the
// RegionShell redesign: a 4px click-vs-drag threshold (so a plain click still activates the
// tab), `userSelect: none` for the duration (dragging across panes would otherwise highlight
// their text), a floating ghost that follows the cursor, and `document.elementFromPoint` to
// resolve what is under the pointer at release. Native HTML5 DnD gives none of the first
// three for free, needs a `dataTransfer` payload nobody wants, and behaves differently on
// touch. The kit ships no sortable-list primitive and the repo has no dnd-kit dependency, so
// "reuse the mechanism that already works" is both the cheapest and the only in-repo answer.
//
// It is AXIS-AGNOSTIC — the threshold is a box, not a direction — which is why the same code
// already serves the horizontal top tab strip AND the vertical side strip, and why a vertical
// section reorder (visualize-pane ITEM-9) needs no new drag at all. What varies between
// callers is only: what the ghost says, and what "the thing under the cursor" means. Both are
// parameters.
//
// This module owns NO application state. A caller is handed the drop target it asked for and
// decides what to do with it — so the tab drag keeps talking to the regions store about
// regions, and the section drag talks to it about sections, with no shared vocabulary between
// them beyond "a pointer moved".

/** The floating label that follows the cursor. One at a time, process-wide — two concurrent
 *  pointer drags are not a state the shell can be in. */
let ghostEl: HTMLDivElement | null = null

function moveGhost(x: number, y: number): void {
  if (ghostEl) ghostEl.style.transform = `translate(${x + 12}px, ${y + 12}px)`
}

function showGhost(label: string, x: number, y: number): void {
  hideGhost()
  ghostEl = document.createElement('div')
  ghostEl.style.cssText =
    'position:fixed;top:0;left:0;z-index:1000;pointer-events:none;padding:2px 8px;font:12px system-ui,sans-serif;color:#fff;background:rgba(59,130,246,0.92);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.3);white-space:nowrap;'
  ghostEl.textContent = label
  document.body.appendChild(ghostEl)
  moveGhost(x, y)
}

function hideGhost(): void {
  ghostEl?.remove()
  ghostEl = null
}

/** The distance the pointer must travel before a press becomes a DRAG rather than a click. */
export const DRAG_THRESHOLD_PX = 4

export interface PointerDragOptions {
  /** the text the ghost carries — what the user is dragging, in their words. */
  label: string
  /** the press that may become a drag. A non-primary button is ignored. */
  event: { button: number; clientX: number; clientY: number }
  /** fires once, when the press crosses the threshold and becomes a real drag. */
  onStart?: () => void
  /** fires on every move once the drag is live, with the current pointer position. */
  onMove?: (x: number, y: number) => void
  /** fires on release. `moved` is false when the press never crossed the threshold — a
   *  CLICK — in which case the caller must not treat it as a drop. */
  onDrop: (x: number, y: number, moved: boolean) => void
  /** fires when the gesture is ABANDONED rather than released: the OS took the pointer away
   *  (`pointercancel`), or the user pressed Escape. It is deliberately NOT `onDrop`, because a
   *  drag the user did not finish must not move anything — the caller's job here is to put back
   *  whatever `onStart`/`onMove` put up (drag state, a drop indicator), and nothing else. */
  onCancel?: () => void
}

/**
 * Begin a potential pointer drag. Installs window-level move/up/cancel listeners and removes
 * them through ONE teardown on every exit path, so the drag survives the pointer leaving the
 * source element (which it always does) and never survives the gesture ending (which it used
 * to, on touch).
 *
 * ── Why `pointercancel` and Escape are not optional here ──────────────────────────────────
 *
 * This started life as a MOUSE gesture on a tab strip, where `pointerup` is the only way a
 * press ends. It is now also a 44px TOUCH target (the section grip, visualize-pane ITEM-9),
 * and a touch pointer is routinely taken away mid-gesture: the scroller claims it, a second
 * finger lands, a call arrives, the browser fires `pointercancel` and NO `pointerup` ever
 * comes. With only move/up listeners the consequences all outlive the gesture — the window
 * listeners leak, the floating ghost is stranded on screen, `document.body.style.userSelect`
 * stays `'none'` for the life of the document, and the next tap ANYWHERE is delivered as the
 * drop. So cancellation is a first-class exit path, sharing the teardown with release.
 *
 * `lostpointercapture` is deliberately NOT listened for: implicit touch capture releases at
 * the normal end of every gesture, so it fires AFTER `pointerup` on the ordinary path and
 * would report a cancel on drags that completed perfectly well.
 *
 * Returns nothing: the caller reacts through the callbacks. A press that never crosses the
 * threshold calls `onDrop(..., false)` and nothing else — no ghost was shown, no selection was
 * suppressed, and no state was touched.
 */
export function startPointerDrag({ label, event, onStart, onMove, onDrop, onCancel }: PointerDragOptions): void {
  if (event.button !== 0) return
  const startX = event.clientX
  const startY = event.clientY
  let started = false
  let done = false

  /** The ONE exit. Every path — release, cancel, Escape — goes through it, which is what makes
   *  "the listeners are gone and the body is back to normal" true by construction rather than
   *  by three copies of the same four lines agreeing with each other. Idempotent, because a
   *  `pointercancel` and a late `pointerup` can both arrive for one gesture. */
  const teardown = (): boolean => {
    if (done) return false
    done = true
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleUp)
    window.removeEventListener('pointercancel', handleCancel)
    window.removeEventListener('keydown', handleKey, true)
    if (started) {
      document.body.style.userSelect = ''
      hideGhost()
    }
    return true
  }

  function handleMove(ev: PointerEvent) {
    if (!started) {
      if (
        Math.abs(ev.clientX - startX) <= DRAG_THRESHOLD_PX &&
        Math.abs(ev.clientY - startY) <= DRAG_THRESHOLD_PX
      ) {
        return
      }
      started = true
      // Suppress text selection for the duration — dragging across a pane would otherwise
      // highlight everything it passed over. Restored on release, on every exit path.
      document.body.style.userSelect = 'none'
      showGhost(label, ev.clientX, ev.clientY)
      onStart?.()
    }
    ev.preventDefault()
    moveGhost(ev.clientX, ev.clientY)
    onMove?.(ev.clientX, ev.clientY)
  }

  function handleUp(ev: PointerEvent) {
    if (!teardown()) return
    onDrop(ev.clientX, ev.clientY, started)
  }

  function handleCancel() {
    if (!teardown()) return
    onCancel?.()
  }

  /** Escape aborts a LIVE drag — the gesture every direct-manipulation surface owes the user,
   *  and the only way out for someone who has already pressed and changed their mind. Capture
   *  phase, so a focused control that swallows Escape (a popover, a combobox) cannot leave the
   *  drag running underneath it.
   *
   *  `started` is the whole condition, and the guard is not a micro-optimisation: before the
   *  threshold this press is a CLICK, and a click has nothing to abort. Handling Escape then
   *  would (a) swallow — via `preventDefault` and the capture phase — an Escape the open
   *  popover or dialog underneath was entitled to consume, for as long as a button is held
   *  down on a drag handle, and (b) latch the gesture closed, so the release that follows
   *  reports neither a drop nor a click and the press simply evaporates. */
  function handleKey(ev: KeyboardEvent) {
    if (ev.key !== 'Escape' || !started) return
    ev.preventDefault()
    handleCancel()
  }

  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp)
  window.addEventListener('pointercancel', handleCancel)
  window.addEventListener('keydown', handleKey, true)
}

/**
 * The value of `attribute` on the nearest ancestor of whatever sits at `(x, y)` that carries
 * it — the "what am I over?" question every reorder drag asks, spelled once.
 *
 * `elementFromPoint` rather than the event target, because the pointer is captured by the
 * window for the duration of the drag and the event target is therefore the SOURCE element
 * throughout, never the thing under the cursor.
 */
export function attributeAtPoint(x: number, y: number, attribute: string): string | null {
  const el = document.elementFromPoint(x, y)?.closest(`[${attribute}]`)
  return el?.getAttribute(attribute) ?? null
}

/**
 * WHERE A RELEASE MEANS TO PUT THE THING — resolved from GEOMETRY, not from a hit test.
 *
 * The first attempt asked `elementFromPoint` "which item am I over?" and mapped the answers to
 * before-it / append / nothing. Every defect that survived was a consequence of that shape,
 * because the question has no answer for most of the pixels in a list:
 *
 *   · the GAPS between items are over no item, and read as "nowhere" — so releasing between two
 *     items, the gesture that most obviously means *put it HERE*, appended to the bottom.
 *   · BELOW the last item there is usually no list element either (a content-height column
 *     stops at its last child), so the one release that genuinely means append could not be
 *     performed at all.
 *   · and "over item X" cannot say which HALF of X, so a downward drag was silently off by one:
 *     inserting BEFORE the hovered item is a no-op when the hovered item is your own successor,
 *     and the user had to target the item after the one they wanted to end up under.
 *
 * A list is a set of BOUNDARIES — n+1 slots for n items — and a release picks the nearest one.
 * Every pixel in the container resolves, including the gaps and the empty space past the end;
 * the slot is what the drop indicator paints; and "what it paints" and "where it lands" are the
 * same number rather than two calculations that agree by inspection.
 *
 * This resolver is VERTICAL, and it is the one part of this module that is. `startPointerDrag`
 * above stays axis-agnostic (its threshold is a box) and the horizontal tab strip keeps using
 * `reorderBefore` with its own hit test — the drop VOCABULARY is per-caller, which is the
 * arrangement this file has documented from the start.
 */
export interface DropSlotItem {
  id: string
  /** the item's box in CLIENT coordinates, the same frame the pointer reports in. */
  top: number
  bottom: number
}

/** The box a release must land in to mean anything — for a scrolling list, the TRACK rather
 *  than the items' own column, so the empty space below the last item is still "in the list". */
export interface DropBounds {
  top: number
  bottom: number
  left: number
  right: number
}

/** A resolved release: the boundary index to insert at (0…n), or nothing at all. */
export type ReorderDrop = { kind: 'at'; index: number } | { kind: 'none' }

/**
 * The slot a release at `(x, y)` resolves to.
 *
 * `none` is returned for exactly two situations, and they are the two where the user has NOT
 * asked for a move: the release is outside the container, or the resolved slot is the one the
 * dragged item already occupies (its own two boundaries). Neither may be confused with append —
 * that conflation is what sent a section to the bottom of the stack on the commonest short drag.
 */
export function resolveVerticalDrop(
  items: readonly DropSlotItem[],
  dragId: string,
  x: number,
  y: number,
  bounds: DropBounds | null,
): ReorderDrop {
  if (!bounds) return { kind: 'none' }
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return { kind: 'none' }

  // The first item whose MIDPOINT the pointer is above owns the slot before it; past every
  // midpoint, the slot is the end. Midpoints (rather than edges) are what make the gaps and the
  // two halves of an item resolve without a special case for either.
  let index = items.length
  for (let i = 0; i < items.length; i++) {
    if (y < (items[i].top + items[i].bottom) / 2) {
      index = i
      break
    }
  }

  const from = items.findIndex(i => i.id === dragId)
  // The slots either side of the dragged item are both "where it already is". Reporting them as
  // a move would make the indicator promise a change that `applyReorderAt` correctly declines.
  if (from !== -1 && (index === from || index === from + 1)) return { kind: 'none' }
  return { kind: 'at', index }
}

/**
 * Move `id` to a resolved slot. `none` returns the SAME array (by identity), so a caller can
 * cheaply decline to write.
 *
 * The index is a boundary in the list AS IT STANDS, so removing the dragged item first shifts
 * every boundary after it down by one — which is the adjustment that makes "the line was drawn
 * below C" and "it ended up below C" the same statement.
 */
export function applyReorderAt(ids: readonly string[], id: string, drop: ReorderDrop): readonly string[] {
  if (drop.kind === 'none') return ids
  const from = ids.indexOf(id)
  const without = ids.filter(x => x !== id)
  const at = from !== -1 && drop.index > from ? drop.index - 1 : drop.index
  const next = [...without]
  next.splice(Math.max(0, Math.min(at, without.length)), 0, id)
  return next
}

/**
 * Move `id` so that it sits immediately BEFORE `beforeId` in `ids`, or at the END when
 * `beforeId` is null (released past the last item). PURE — the ordering rule every reorder
 * drop shares, testable without a DOM.
 */
export function reorderBefore(ids: readonly string[], id: string, beforeId: string | null): string[] {
  const without = ids.filter(x => x !== id)
  if (beforeId === null || beforeId === id) return [...without, id]
  const at = without.indexOf(beforeId)
  if (at === -1) return [...without, id]
  return [...without.slice(0, at), id, ...without.slice(at)]
}
