// plotGutter.test.ts — TEST-4 (covers ITEM-1): the flattened gutter is referentially stable.
//
// This is the pure half of ITEM-1. The render half (does `memo(CellView)` actually hold?) is proven
// where it renders, by counting elements over a real wheel drive (TEST-P1 / render-perf.spec.ts) —
// this package's vitest has no DOM, so a render assertion here would be a fiction.
//
// The property under test is the one the whole item turns on and the one an object-valued prop
// cannot have: the values crossing the memo boundary must compare EQUAL BY IDENTITY across two
// renders that produced the same gutter. `toBe`, never `toEqual` — `toEqual` would pass on exactly
// the fresh-object-literal defect this replaces, which is the failure mode that makes a perf test
// certify the regression it was written to catch.

import { describe, expect, it } from 'vitest'
import { gutterFromParts, gutterPadding, gutterToParts, type PlotGutter } from './plotGutter'

describe('plotGutter flattening (TEST-4 / ITEM-1)', () => {
  it('two calls with the same gutter yield IDENTICAL primitives (toBe, not toEqual)', () => {
    // Simulate what the call site does: `legendGutterFor` builds a FRESH object each render.
    const render1 = gutterToParts({ w: 84, side: 'right' })
    const render2 = gutterToParts({ w: 84, side: 'right' })
    expect(render1.plotGutterW).toBe(render2.plotGutterW)
    expect(render1.plotGutterSide).toBe(render2.plotGutterSide)
    // …and the defect this replaces, stated explicitly so the contrast is on the record: the two
    // OBJECTS are equal in value but never identical, which is precisely what defeated `memo`.
    const objA: PlotGutter = { w: 84, side: 'right' }
    const objB: PlotGutter = { w: 84, side: 'right' }
    expect(objA).toEqual(objB)
    expect(objA).not.toBe(objB)
  })

  it('a changed legend width changes the primitive', () => {
    // The other half of stability: it must still CHANGE when the measurement changes, or the memo
    // would hold a stale gutter and the legend would overlap the plot.
    expect(gutterToParts({ w: 84, side: 'right' }).plotGutterW).not.toBe(
      gutterToParts({ w: 96, side: 'right' }).plotGutterW,
    )
    expect(gutterToParts({ w: 84, side: 'left' }).plotGutterSide).not.toBe(
      gutterToParts({ w: 84, side: 'right' }).plotGutterSide,
    )
  })

  it('absence flattens to absence, in both directions', () => {
    expect(gutterToParts(null)).toEqual({})
    expect(gutterToParts(undefined)).toEqual({})
    expect(gutterFromParts({})).toBeUndefined()
    // A half-specified pair is not a gutter — the producer cannot express it, and treating it as
    // one would pad by an undefined amount.
    expect(gutterFromParts({ plotGutterW: 84 })).toBeUndefined()
    expect(gutterFromParts({ plotGutterSide: 'left' })).toBeUndefined()
    // Zero and non-finite widths normalize to absent rather than to a gutter that pads by nothing.
    expect(gutterFromParts({ plotGutterW: 0, plotGutterSide: 'left' })).toBeUndefined()
    expect(gutterFromParts({ plotGutterW: Number.NaN, plotGutterSide: 'left' })).toBeUndefined()
  })

  it('round-trips a real gutter', () => {
    for (const g of [
      { w: 84, side: 'right' },
      { w: 120, side: 'left' },
    ] as const) {
      expect(gutterFromParts(gutterToParts(g))).toEqual(g)
    }
  })

  it('maps side to the physical padding property in ONE place', () => {
    expect(gutterPadding({ w: 84, side: 'right' })).toEqual({ paddingRight: 84 })
    expect(gutterPadding({ w: 84, side: 'left' })).toEqual({ paddingLeft: 84 })
    expect(gutterPadding(undefined)).toEqual({})
  })
})
