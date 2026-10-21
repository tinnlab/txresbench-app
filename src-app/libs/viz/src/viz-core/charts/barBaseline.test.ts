import { describe, it, expect } from 'vitest'
import { barValueDomain, barSeriesFromCategorical } from './BarView'

describe('bar zero-baseline guard (ITEM-13)', () => {
  it('always anchors the value domain at 0', () => {
    expect(barValueDomain(10)[0]).toBe(0)
    expect(barValueDomain(0)[0]).toBe(0)
    expect(barValueDomain(1000)[0]).toBe(0)
  })
  it('adds headroom above the tallest bar', () => {
    const [lo, hi] = barValueDomain(100)
    expect(lo).toBe(0)
    expect(hi).toBeGreaterThan(100)
  })
  it('an all-zero series still yields a unit range (no degenerate 0..0)', () => {
    expect(barValueDomain(0)).toEqual([0, 1])
  })
  it('barSeriesFromCategorical counts per category (the values the domain bounds)', () => {
    const series = barSeriesFromCategorical({ codes: Uint16Array.from([0, 0, 1]), categories: ['A', 'B'], length: 3 })
    expect(series).toEqual([{ category: 'A', values: [2] }, { category: 'B', values: [1] }])
  })
})
