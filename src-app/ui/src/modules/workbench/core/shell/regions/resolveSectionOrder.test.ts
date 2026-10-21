// TEST-14 (visualize-pane ITEM-8) — the section stack's order rule.
//
// The assertion that matters is the LAST one: a section installed after the user last
// dragged lands where its AUTHOR said, which is precisely what the region tab strip's
// `MAX_SAFE_INTEGER`-plus-insertion-order rule gets wrong. Everything above it is the
// scaffolding that makes that assertion mean something.

import { describe, expect, it } from 'vitest'
import { resolveSectionOrder, type OrderableSection } from './resolveSectionOrder'

const s = (id: string, order?: number): OrderableSection => (order === undefined ? { id } : { id, order })
const ids = (list: OrderableSection[]) => list.map(x => x.id)

describe('resolveSectionOrder (ITEM-8)', () => {
  it('with NO saved order, sorts by the declared `order` ascending', () => {
    // Registration order is deliberately the reverse of the declared order, so a rule that
    // fell through to insertion order would produce the input back.
    expect(ids(resolveSectionOrder(undefined, [s('beta', 30), s('gamma', 20), s('alpha', 10)]))).toEqual([
      'alpha',
      'gamma',
      'beta',
    ])
  })

  it('breaks a declared-order TIE on id, so the result never depends on registration order', () => {
    expect(ids(resolveSectionOrder([], [s('b', 10), s('a', 10)]))).toEqual(['a', 'b'])
    expect(ids(resolveSectionOrder([], [s('a', 10), s('b', 10)]))).toEqual(['a', 'b'])
  })

  it('orders a section that declared NO `order` after every section that declared one', () => {
    // An omission must not outrank a declaration — which it would if absence sorted as 0.
    expect(ids(resolveSectionOrder(undefined, [s('undeclared'), s('late', 900)]))).toEqual(['late', 'undeclared'])
  })

  it("the user's saved order wins, in the USER's order, for every id it names", () => {
    const all = [s('alpha', 10), s('gamma', 20), s('beta', 30)]
    expect(ids(resolveSectionOrder(['beta', 'alpha', 'gamma'], all))).toEqual([
      'beta',
      'alpha',
      'gamma',
    ])
  })

  it('is SPARSE: a list naming ONE section pins that one and leaves the rest to their authors', () => {
    const all = [s('alpha', 10), s('gamma', 20), s('beta', 30)]
    expect(ids(resolveSectionOrder(['beta'], all))).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('ignores a STALE id naming a section that is no longer installed', () => {
    // Correctness here must not depend on ITEM-7's pruning having run.
    const all = [s('alpha', 10), s('gamma', 20)]
    expect(ids(resolveSectionOrder(['uninstalled', 'gamma'], all))).toEqual(['gamma', 'alpha'])
  })

  it('a section installed AFTER the user last dragged lands where its AUTHOR said', () => {
    // THE item. The user dragged Beta to the top, at which point `sc.newcomer` did not
    // exist. Its author declared `order: 15` — between Alpha (10) and Gamma (20) —
    // so that is where it belongs. The tab-strip rule would rank it MAX_SAFE_INTEGER and drop
    // it at the BOTTOM, discarding the declaration entirely.
    const saved = ['beta']
    const installed = [s('alpha', 10), s('gamma', 20), s('beta', 30), s('newcomer', 15)]
    expect(ids(resolveSectionOrder(saved, installed))).toEqual(['beta', 'alpha', 'newcomer', 'gamma'])
  })

  it('returns every section exactly once and does not mutate its input', () => {
    const all = [s('alpha', 10), s('gamma', 20), s('beta', 30)]
    const snapshot = ids(all)
    const out = resolveSectionOrder(['gamma'], all)
    expect(out).toHaveLength(all.length)
    expect(new Set(ids(out)).size).toBe(all.length)
    expect(ids(all)).toEqual(snapshot)
  })

  it('a duplicated id in the saved list uses its FIRST position (a list is not a multiset)', () => {
    const all = [s('a', 10), s('b', 20)]
    expect(ids(resolveSectionOrder(['b', 'a', 'b'], all))).toEqual(['b', 'a'])
  })
})
