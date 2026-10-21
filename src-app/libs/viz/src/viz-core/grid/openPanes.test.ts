// openPanes.test.ts — TEST-10 (ITEM-7/8): the per-pane OPEN-SET algebra.
//
// Asserts the annotate/segment open sets follow the SAME semantics as the pre-existing `editCellIds`
// / `dataTableCellIds` surfaces (the precedent the shipped single-`activeAnnotateCellId` binding
// claimed to follow and inverted), and that a pane removed from the grid is EVICTED so no stale id
// survives (DEC-8 — the prior feature's blind audit found exactly this class of leak).

import { describe, it, expect } from 'vitest'
import { togglePane, closePane, openPane, evictIneligible } from './openPanes'

const S = (...ids: string[]) => new Set(ids) as ReadonlySet<string>

describe('openPanes — TEST-10: the editCellIds toggle/close idiom', () => {
  it('togglePane adds when absent and removes when present', () => {
    expect([...togglePane(S(), 'a')]).toEqual(['a'])
    expect([...togglePane(S('a'), 'a')]).toEqual([])
    expect([...togglePane(S('a'), 'b')].sort()).toEqual(['a', 'b'])
  })

  it('MULTIPLE panes are open at once — the whole point of a Set (INV-12)', () => {
    let open: ReadonlySet<string> = S()
    open = togglePane(open, 'pane-a')
    open = togglePane(open, 'pane-b')
    open = togglePane(open, 'pane-c')
    expect(open.size).toBe(3)
    // closing one leaves the others open — they are different datasets
    open = closePane(open, 'pane-b')
    expect([...open].sort()).toEqual(['pane-a', 'pane-c'])
  })

  it('closePane returns the SAME set identity when the pane is not open (no needless re-render)', () => {
    const prev = S('a')
    expect(closePane(prev, 'zzz')).toBe(prev)
    expect(closePane(prev, 'a')).not.toBe(prev)
  })

  it('openPane returns the SAME set identity when already open', () => {
    const prev = S('a')
    expect(openPane(prev, 'a')).toBe(prev)
    expect([...openPane(prev, 'b')].sort()).toEqual(['a', 'b'])
  })
})

describe('openPanes — TEST-10: eviction (DEC-8)', () => {
  // Finding #14 deleted open-all-on-engage: a dock opens because the user pressed THAT pane's
  // toolbar button, so the open set is the user's intent and needs no closed-pane bookkeeping. Only
  // the eviction half survives.
  it('EVICTS a pane that is no longer eligible — no stale id survives a pane removal', () => {
    const prev = S('a', 'b', 'c')
    // pane 'b' was removed from the grid (or its `annotate` flag cleared)
    const next = evictIneligible(prev, ['a', 'c'])
    expect([...next].sort()).toEqual(['a', 'c'])
    expect(next.has('b')).toBe(false)
  })

  it('does NOT open a newly eligible pane — opening is the user pressing that pane\'s button', () => {
    // The exact inversion of the old reconcile: a pane becoming eligible must not auto-open a dock,
    // which is what made a single pane un-annotatable on its own.
    expect([...evictIneligible(S('a'), ['a', 'b'])]).toEqual(['a'])
    expect([...evictIneligible(S(), ['a', 'b'])]).toEqual([])
  })

  it('returns the SAME set identity when nothing is evicted (stable across re-renders)', () => {
    const prev = S('a', 'b')
    expect(evictIneligible(prev, ['a', 'b'])).toBe(prev)
    expect(evictIneligible(prev, ['b', 'a'])).toBe(prev)
    expect(evictIneligible(prev, ['a', 'b', 'c'])).toBe(prev)
  })

  it('evicts everything when nothing is eligible', () => {
    expect([...evictIneligible(S('a', 'b'), [])]).toEqual([])
  })
})
