// paneScroll — restoring a scroll offset is a RACE, not an assignment.
//
// A region renders only its active tab, so returning to a pane re-creates its scroll container from
// nothing: height 0, content empty, whatever the panel inside is about to fetch still in flight.
// Writing the saved offset at that moment writes it into a container with nothing to scroll — the
// browser clamps it to 0 and the pane "restores" to the top, which is precisely the state this
// exists to avoid, now with a test asserting it happened.
//
// So the controller below is a small state machine over the container's own measurements, and every
// case here is one of the ways the naive assignment loses:
//   · the container is measured before its content exists   → do NOT write, and do NOT give up;
//   · the content arrives in stages (a list paginating in)   → close the gap on each measurement;
//   · the content is SHORTER than it was (rows removed)      → clamp, never overshoot;
//   · the user scrolls while we are still catching up        → the user wins, immediately and for good.
//
// The container is a plain object here on purpose: the real one is an overlayscrollbars viewport,
// and the only thing the policy may know about it is the three numbers every scroll container has.

import { describe, it, expect, beforeEach } from 'vitest'
import { __resetPaneState, getPaneState, setPaneState } from './paneState'
import { createPaneScrollController, type ScrollTarget } from './paneScroll'

const PANE = 'pane-scroll-1'

/** A scroll container whose content height the test drives. `scrollTop` clamps, as a real one does.
 *  Its own type is writable (the TEST grows the content); the controller only ever sees
 *  `ScrollTarget`, where the two measurements are readonly. */
interface FakeContainer {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  grow(to: number): void
}

function container(clientHeight = 300, scrollHeight = 0): FakeContainer {
  let top = 0
  let content = scrollHeight
  return {
    clientHeight,
    get scrollHeight() {
      return content
    },
    set scrollHeight(v: number) {
      content = v
    },
    get scrollTop() {
      return top
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, Math.max(0, content - clientHeight)))
    },
    grow(to: number) {
      content = to
    },
  }
}

/** The container as the controller sees it (nothing but the three numbers). */
const target = (el: FakeContainer): ScrollTarget => el as ScrollTarget

beforeEach(() => __resetPaneState())

describe('createPaneScrollController', () => {
  it('does not write into a container with nothing to scroll — that is a reset dressed as a restore', () => {
    setPaneState(PANE, { scrollTop: 640 })
    const c = createPaneScrollController(PANE)
    const el = container()

    c.measured(target(el)) // mounted; the panel's own fetch has not landed
    expect(el.scrollTop, 'writing 640 here clamps to 0 and the offset is gone for good').toBe(0)
    expect(getPaneState(PANE), 'and nothing may overwrite the saved offset in the meantime').toEqual({
      scrollTop: 640,
    })
  })

  it('restores once the content can actually reach the offset', () => {
    setPaneState(PANE, { scrollTop: 640 })
    const c = createPaneScrollController(PANE)
    const el = container()

    c.measured(target(el))
    el.grow(2000)
    c.measured(target(el))
    expect(el.scrollTop).toBe(640)
  })

  it('closes the gap as content arrives in stages, and stops once it is there', () => {
    setPaneState(PANE, { scrollTop: 640 })
    const c = createPaneScrollController(PANE)
    const el = container()

    el.grow(600) // one page in: max scroll 300
    c.measured(target(el))
    expect(el.scrollTop, 'as far down as the content allows so far').toBe(300)

    el.grow(1200)
    c.measured(target(el))
    expect(el.scrollTop).toBe(640)

    // Restoration is DONE — a later re-measure must not drag the user back.
    el.grow(5000)
    el.scrollTop = 1500
    c.scrolled(target(el))
    c.measured(target(el))
    expect(el.scrollTop).toBe(1500)
  })

  it('clamps to a SHORTER container instead of overshooting', () => {
    setPaneState(PANE, { scrollTop: 5000 })
    const c = createPaneScrollController(PANE)
    const el = container(300, 800)

    c.measured(target(el))
    expect(el.scrollTop).toBe(500)
  })

  it('a user scroll wins immediately, and becomes the new saved offset', () => {
    setPaneState(PANE, { scrollTop: 640 })
    const c = createPaneScrollController(PANE)
    const el = container(300, 600)

    c.measured(target(el)) // partial restore to 300 (all the content allows)
    expect(el.scrollTop).toBe(300)

    el.scrollTop = 120 // the user scrolls back up while content is still loading
    c.scrolled(target(el))
    expect(getPaneState(PANE)).toEqual({ scrollTop: 120 })

    el.grow(4000)
    c.measured(target(el))
    expect(el.scrollTop, 'the restore must not yank the user away from where they scrolled to').toBe(120)
  })

  it('does not mistake its OWN write for a user scroll', () => {
    setPaneState(PANE, { scrollTop: 640 })
    const c = createPaneScrollController(PANE)
    const el = container(300, 600)

    c.measured(target(el)) // writes 300 → the container fires a scroll event for OUR write
    c.scrolled(target(el))
    expect(getPaneState(PANE), 'saving 300 here would destroy the offset we are mid-way through restoring').toEqual({
      scrollTop: 640,
    })

    el.grow(4000)
    c.measured(target(el))
    expect(el.scrollTop).toBe(640)
  })

  it('with nothing saved it stays out of the way and just records where the user goes', () => {
    const c = createPaneScrollController(PANE)
    const el = container(300, 4000)

    c.measured(target(el))
    expect(el.scrollTop).toBe(0)
    el.scrollTop = 220
    c.scrolled(target(el))
    expect(getPaneState(PANE)).toEqual({ scrollTop: 220 })
  })

  it('keys the offset by PANE, so two panes never inherit each other’s position', () => {
    const a = createPaneScrollController('pane-a')
    const b = createPaneScrollController('pane-b')
    const ea = container(300, 4000)
    const eb = container(300, 4000)

    ea.scrollTop = 900
    a.scrolled(target(ea))
    b.measured(target(eb))
    expect(eb.scrollTop).toBe(0)
    expect(getPaneState('pane-a')).toEqual({ scrollTop: 900 })
    expect(getPaneState('pane-b')).toBeUndefined()
  })
})
