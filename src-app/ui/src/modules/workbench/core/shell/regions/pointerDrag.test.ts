// @vitest-environment jsdom
//
// The shared reorder-drag primitive (visualize-pane ITEM-9).
//
// Two halves are asserted here, for two different reasons.
//
// The ORDERING RULE is what both callers depend on being identical, so it lives in pure
// functions and is pinned directly — the tab strip and the section stack cannot drift into two
// notions of "insert before the thing under the cursor".
//
// The LIFECYCLE is the half that used to be waved at as "a DOM choreography whose real proof
// is the e2e". It is not: the e2e drives a mouse, and every defect the lifecycle has is on the
// TOUCH path — a gesture that ends in `pointercancel` instead of `pointerup`, which no mouse
// ever produces and no e2e in this repo drives. So the abandonment paths are asserted here,
// against the REAL `startPointerDrag`, in jsdom: what the module must guarantee is that the
// window listeners, the ghost and `document.body.style.userSelect` do not outlive the gesture.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyReorderAt,
  reorderBefore,
  resolveVerticalDrop,
  startPointerDrag,
  DRAG_THRESHOLD_PX,
} from './pointerDrag'

describe('reorderBefore (ITEM-9)', () => {
  it('inserts the dragged id immediately BEFORE the id under the cursor', () => {
    expect(reorderBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(reorderBefore(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c'])
  })

  it('appends when released past the last item (no id under the cursor)', () => {
    expect(reorderBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
  })

  it('keeps every id exactly once when handed its own id (the degenerate input)', () => {
    // `reorderBefore` is the low-level rule and has no way to know what "over itself" MEANT —
    // that judgement is `resolveReorderDrop`'s, below, and this is only the guarantee that the
    // degenerate input does not corrupt the list.
    const out = reorderBefore(['a', 'b', 'c'], 'b', 'b')
    expect(out.filter(x => x === 'b')).toHaveLength(1)
    expect(new Set(out)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('appends when the target id is not in the list at all (a stale hit-test result)', () => {
    expect(reorderBefore(['a', 'b'], 'a', 'gone')).toEqual(['b', 'a'])
  })

  it('never duplicates or drops an id, wherever it lands', () => {
    const ids = ['a', 'b', 'c', 'd']
    for (const id of ids) {
      for (const before of [...ids, null]) {
        const out = reorderBefore(ids, id, before)
        expect(out).toHaveLength(ids.length)
        expect([...out].sort()).toEqual([...ids].sort())
      }
    }
  })

  it('does not mutate its input', () => {
    const ids = ['a', 'b', 'c']
    reorderBefore(ids, 'c', 'a')
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('keeps the click-vs-drag threshold a shared constant, not two literals', () => {
    // It was spelled inline in `RegionShell`; a second caller copying the number is how the
    // two surfaces come to disagree about what counts as a click.
    expect(DRAG_THRESHOLD_PX).toBe(4)
  })
})

// ── WHERE A RELEASE LANDS ──────────────────────────────────────────────────────────────────
//
// Three items, 12px apart, in a 400px-tall track — the pane's real shape. Midpoints are 50,
// 160 and 270, so every assertion below can be read off the geometry rather than taken on
// trust.
const A = { id: 'a', top: 0, bottom: 100 }
const B = { id: 'b', top: 110, bottom: 210 }
const C = { id: 'c', top: 220, bottom: 320 }
const ITEMS = [A, B, C]
const TRACK = { top: 0, bottom: 400, left: 0, right: 100 }
const IDS = ['a', 'b', 'c']

/** the slot a release at `y` resolves to for a drag of `id`, or null for "no move". */
const slot = (id: string, y: number) => {
  const d = resolveVerticalDrop(ITEMS, id, 50, y, TRACK)
  return d.kind === 'at' ? d.index : null
}
/** …and where the list ends up. */
const landed = (id: string, y: number) => applyReorderAt(IDS, id, resolveVerticalDrop(ITEMS, id, 50, y, TRACK))

describe('resolveVerticalDrop — every pixel of the list resolves to a boundary', () => {
  it('a release in the GAP between two items lands BETWEEN them — never at the bottom', () => {
    // The defect: the gaps are over no item, and "over no item" used to mean append. So the
    // gesture that most plainly means *put it HERE* moved the section to the end of the stack
    // and persisted that. There is no "nowhere" in a list — only boundaries.
    expect(slot('c', 105)).toBe(1)
    expect(landed('c', 105)).toEqual(['a', 'c', 'b'])
    expect(slot('a', 215)).toBe(2)
    expect(landed('a', 215)).toEqual(['b', 'a', 'c'])
  })

  it('a release BELOW the last item appends — the gesture that was previously unperformable', () => {
    // The container is the TRACK, so the empty space under the last section is still inside the
    // list. Scoped to the items\' own column it is not, and the one release that unambiguously
    // means "put it at the end" resolved to nothing at all.
    expect(slot('a', 380)).toBe(3)
    expect(landed('a', 380)).toEqual(['b', 'c', 'a'])
  })

  it('a release OUTSIDE the container moves nothing, on either axis', () => {
    expect(slot('a', 500)).toBeNull()
    expect(resolveVerticalDrop(ITEMS, 'a', 50, -20, TRACK)).toEqual({ kind: 'none' })
    expect(resolveVerticalDrop(ITEMS, 'a', 400, 150, TRACK)).toEqual({ kind: 'none' })
    expect(resolveVerticalDrop(ITEMS, 'a', 50, 150, null)).toEqual({ kind: 'none' })
  })

  it('a release on EITHER half of the dragged item itself moves nothing', () => {
    // Both boundaries either side of an item are "where it already is". A section box wraps its
    // whole expanded body, so this is the commonest short drag in the pane.
    expect(slot('b', 120)).toBeNull()
    expect(slot('b', 200)).toBeNull()
    expect(landed('b', 200)).toEqual(IDS)
  })

  it('the LOWER half of the item below you moves you down exactly one place', () => {
    // Insert-before-only semantics made a downward drag off by one: released over the item
    // directly below, the move was a no-op, and the user had to target the item AFTER the one
    // they wanted to end up under. Halves are what give a downward gesture a slot of its own.
    expect(slot('a', 200)).toBe(2)
    expect(landed('a', 200)).toEqual(['b', 'a', 'c'])
    // …and its upper half is still the no-op it should be (that IS where `a` already sits).
    expect(slot('a', 120)).toBeNull()
  })

  it('the UPPER half of the first item moves you to the top', () => {
    expect(slot('c', 40)).toBe(0)
    expect(landed('c', 40)).toEqual(['c', 'a', 'b'])
  })

  it('WHAT THE INDICATOR PROMISES IS WHAT LANDS, at every slot, for every item', () => {
    // The property the whole redesign exists for: the drawn boundary and the resulting position
    // are ONE number. Asserted exhaustively rather than at a few points, because an off-by-one
    // that only appears when dragging downward is exactly what the previous rule had.
    for (const id of IDS) {
      for (let y = TRACK.top; y <= TRACK.bottom; y += 5) {
        const d = resolveVerticalDrop(ITEMS, id, 50, y, TRACK)
        if (d.kind === 'none') {
          expect(applyReorderAt(IDS, id, d)).toBe(IDS)
          continue
        }
        const out = applyReorderAt(IDS, id, d)
        // The boundary is an index into the list AS DRAWN: everything above it stays above.
        const above = ITEMS.slice(0, d.index).map(i => i.id).filter(x => x !== id)
        expect(out.slice(0, above.length)).toEqual(above)
        expect([...out].sort()).toEqual([...IDS].sort())
      }
    }
  })

  it('returns the SAME array for a no-op, so a caller can decline to write at all', () => {
    expect(applyReorderAt(IDS, 'a', { kind: 'none' })).toBe(IDS)
  })

  it('an empty list still resolves — the only slot is the first one', () => {
    expect(resolveVerticalDrop([], 'a', 50, 100, TRACK)).toEqual({ kind: 'at', index: 0 })
  })
})

// ── the gesture ENDING, on every path it can end ───────────────────────────────────────────

/** A press/move/release, dispatched as plain events on `window`: jsdom ships no `PointerEvent`
 *  constructor, and the listeners only ever read `clientX`/`clientY`. */
function fire(type: string, x = 0, y = 0): void {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, { clientX: x, clientY: y })
  window.dispatchEvent(ev)
}

/** The floating ghost, if one is on screen. It is an unmarked `div` appended to the body, so it
 *  is identified the way the user sees it: fixed-position, carrying the drag's label. */
function ghosts(label: string): Element[] {
  return [...document.body.children].filter(
    el => el instanceof HTMLElement && el.style.position === 'fixed' && el.textContent === label,
  )
}

const press = { button: 0, clientX: 0, clientY: 0 }

afterEach(() => {
  document.body.innerHTML = ''
  document.body.style.userSelect = ''
})

describe('startPointerDrag — an abandoned gesture leaves nothing behind', () => {
  it('a live drag suppresses selection and shows a ghost (the state that must be undone)', () => {
    startPointerDrag({ label: 'Coordinates', event: press, onDrop: vi.fn() })
    fire('pointermove', 0, 40)
    expect(document.body.style.userSelect).toBe('none')
    expect(ghosts('Coordinates')).toHaveLength(1)
    fire('pointerup', 0, 40)
  })

  it('POINTERCANCEL ends it: no drop, no ghost, no stuck selection, and no live listeners', () => {
    // The touch reality this is about: the scroller claims the pointer, a second finger lands,
    // a call arrives — the browser fires `pointercancel` and NEVER fires `pointerup`.
    const onDrop = vi.fn()
    const onCancel = vi.fn()
    startPointerDrag({ label: 'Coordinates', event: press, onDrop, onCancel })
    fire('pointermove', 0, 40)

    fire('pointercancel', 0, 40)

    expect(onCancel).toHaveBeenCalledTimes(1)
    // A gesture the user did not finish must not MOVE anything.
    expect(onDrop).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('')
    expect(ghosts('Coordinates')).toHaveLength(0)

    // THE LEAK, asserted directly: with the listeners still attached, the next tap anywhere in
    // the document was delivered as this drag's drop.
    fire('pointermove', 0, 200)
    fire('pointerup', 300, 400)
    expect(onDrop).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(ghosts('Coordinates')).toHaveLength(0)
  })

  it('ESCAPE cancels a live drag, through the same single exit', () => {
    const onDrop = vi.fn()
    const onCancel = vi.fn()
    startPointerDrag({ label: 'Coordinates', event: press, onDrop, onCancel })
    fire('pointermove', 0, 40)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onDrop).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('')
    expect(ghosts('Coordinates')).toHaveLength(0)
    // …and the release that follows the user's own hand coming off the button is inert.
    fire('pointerup', 0, 40)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('an ordinary RELEASE still drops — and is equally gone afterwards', () => {
    // The positive control. Without it, "onDrop was not called" above would be satisfied by a
    // primitive that never drops at all.
    const onDrop = vi.fn()
    const onCancel = vi.fn()
    startPointerDrag({ label: 'Coordinates', event: press, onDrop, onCancel })
    fire('pointermove', 0, 40)
    fire('pointerup', 7, 40)

    expect(onDrop).toHaveBeenCalledWith(7, 40, true)
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('')
    expect(ghosts('Coordinates')).toHaveLength(0)

    // One gesture, one outcome: a late `pointercancel` (which implicit touch capture can still
    // deliver) must not re-report the finished drag as abandoned.
    fire('pointercancel', 7, 40)
    expect(onCancel).not.toHaveBeenCalled()
    fire('pointerup', 9, 40)
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('does NOT intercept Escape before the threshold — a held press is a CLICK, not a drag', () => {
    // `handleKey` is installed for the whole gesture, capture-phase, and calls `preventDefault`.
    // Applied to a press that has not yet moved, it eats an Escape the popover or dialog
    // underneath was entitled to consume — for as long as a button is held on a drag handle —
    // and latches the gesture closed, so the release reports neither a drop nor a click.
    const onDrop = vi.fn()
    const onCancel = vi.fn()
    startPointerDrag({ label: 'Coordinates', event: press, onDrop, onCancel })
    fire('pointermove', 2, 2)

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(false)
    expect(onCancel).not.toHaveBeenCalled()

    // …and the press still completes as the CLICK it is.
    fire('pointerup', 2, 2)
    expect(onDrop).toHaveBeenCalledWith(2, 2, false)
  })

  it('a press below the threshold is a CLICK — reported as such, and nothing is put up to undo', () => {
    const onDrop = vi.fn()
    startPointerDrag({ label: 'Coordinates', event: press, onDrop })
    fire('pointermove', 2, 2)
    expect(ghosts('Coordinates')).toHaveLength(0)
    fire('pointerup', 2, 2)
    expect(onDrop).toHaveBeenCalledWith(2, 2, false)
    expect(document.body.style.userSelect).toBe('')
  })
})
