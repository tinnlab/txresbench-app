// THE SECTION HEADER BADGE (visualize-pane ITEM-64 / R6 / INV-7) — TEST-79's badge half.
//
// R6: *"a COLLAPSED section states that it holds state. Collapse is display, not reset."* The
// frame that draws the badge is the HOST's, and what a section HOLDS is known only inside that
// section's own store — which the host deliberately does not read. So the section declares what
// its badge counts and the host learns a number.
//
// The assertions are mostly about the ZERO case, because that is where a badge stops being
// honest: a wired-looking mark that means nothing is the failure R6 exists to prevent, and a
// count of "dirty fields" (which the host COULD infer) would be exactly that.

import { beforeEach, describe, expect, it } from 'vitest'

import { sectionBadgeOf, sectionBadgeStore } from './sectionBadge.store'

beforeEach(() => sectionBadgeStore.getState().reset())

describe('sectionBadgeStore', () => {
  it('publishes a positive count and reads it back by view', () => {
    sectionBadgeStore.getState().publish('v1', 2)
    expect(sectionBadgeStore.getState().byView).toEqual({ v1: 2 })
  })

  it('ZERO is NO badge, not a badge reading zero', () => {
    // "Holds nothing" has exactly one spelling — absence — so the frame has one thing to test.
    sectionBadgeStore.getState().publish('v1', 0)
    expect(sectionBadgeStore.getState().byView).toEqual({})
  })

  it('retracts when a section stops holding anything', () => {
    sectionBadgeStore.getState().publish('v1', 3)
    sectionBadgeStore.getState().publish('v1', 0)
    expect('v1' in sectionBadgeStore.getState().byView).toBe(false)
  })

  it('ignores a value that is not a usable count, rather than rendering NaN', () => {
    for (const v of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      sectionBadgeStore.getState().publish('v1', v as number | undefined)
      expect(sectionBadgeStore.getState().byView).toEqual({})
    }
  })

  it('is idempotent — publishing the same count twice does not replace the state', () => {
    // It runs from a render effect on every revision, so a needless replacement would re-render
    // every section on every keystroke anywhere on the pane.
    sectionBadgeStore.getState().publish('v1', 2)
    const before = sectionBadgeStore.getState().byView
    sectionBadgeStore.getState().publish('v1', 2)
    expect(sectionBadgeStore.getState().byView).toBe(before)
  })

  it('clear forgets a view — an unmounted pane leaves no stale mark', () => {
    sectionBadgeStore.getState().publish('v1', 2)
    sectionBadgeStore.getState().clear('v1')
    expect(sectionBadgeStore.getState().byView).toEqual({})
  })
})

describe('sectionBadgeOf — a SECTION’s badge is the sum over the views it contributes', () => {
  it('sums a section’s several `ui:` files into ONE mark', () => {
    // A section's file split is an implementation detail of the package; two badges on one
    // header would be it leaking into the reader's view.
    expect(sectionBadgeOf({ a: 1, b: 2 }, ['a', 'b'])).toBe(3)
  })

  it('is undefined when the section holds nothing between them', () => {
    expect(sectionBadgeOf({}, ['a', 'b'])).toBeUndefined()
    expect(sectionBadgeOf({ other: 5 }, ['a'])).toBeUndefined()
  })

  it('counts only the views the SECTION contributes', () => {
    // Two sections are on the pane at once; one must never state the other's held state.
    expect(sectionBadgeOf({ a: 1, b: 2 }, ['a'])).toBe(1)
  })
})
