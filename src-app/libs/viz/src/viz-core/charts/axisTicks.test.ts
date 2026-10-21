// axisTicks.test.ts — unit tests for the pure d3-style tick generators (ITEM-17). No GL,
// no DOM — plain number/label math.

import { describe, it, expect } from 'vitest'
import { niceTicks, categoryTicks, tickStep, formatTickValue } from './axisTicks'

describe('niceTicks', () => {
  it('produces round multiples of a nice step over [0,10]', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10])
  })

  it('all ticks lie within [min,max] and are multiples of the step', () => {
    const ticks = niceTicks(0, 100, 6)
    expect(ticks.length).toBeGreaterThan(2)
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(100)
    }
    // uniform spacing
    const step = ticks[1] - ticks[0]
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step)
    }
  })

  it('handles a fractional range without floating-point noise', () => {
    const ticks = niceTicks(0, 1, 5)
    // step should be 0.2 → 0,0.2,0.4,0.6,0.8,1
    expect(ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  })

  it('handles negative-to-positive ranges (volcano log2FC)', () => {
    const ticks = niceTicks(-3, 3, 6)
    expect(ticks).toContain(0)
    expect(ticks[0]).toBeGreaterThanOrEqual(-3)
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(3)
  })

  it('normalizes a reversed range', () => {
    expect(niceTicks(10, 0, 5)).toEqual(niceTicks(0, 10, 5))
  })

  it('min === max → a single tick at that value', () => {
    expect(niceTicks(5, 5)).toEqual([5])
  })

  it('non-finite bounds → empty', () => {
    expect(niceTicks(NaN, 10)).toEqual([])
    expect(niceTicks(0, Infinity)).toEqual([])
  })
})

describe('tickStep', () => {
  it('picks a 1/2/5 × 10ⁿ step', () => {
    expect(tickStep(0, 10, 5)).toBe(2)
    expect(tickStep(0, 100, 6)).toBe(20)
    expect(tickStep(0, 1, 5)).toBeCloseTo(0.2)
  })
})

describe('categoryTicks', () => {
  it('places one tick per label at its integer center', () => {
    expect(categoryTicks(['A', 'B', 'C'])).toEqual([
      { pos: 0, label: 'A' },
      { pos: 1, label: 'B' },
      { pos: 2, label: 'C' },
    ])
  })

  it('empty → empty', () => {
    expect(categoryTicks([])).toEqual([])
  })
})

describe('formatTickValue', () => {
  it('keeps integers integral', () => {
    expect(formatTickValue(5)).toBe('5')
    expect(formatTickValue(-12)).toBe('-12')
  })
  it('trims fractional noise', () => {
    expect(formatTickValue(0.2)).toBe('0.2')
    expect(formatTickValue(1.5)).toBe('1.5')
  })
  it('uses exponential for tiny/huge magnitudes', () => {
    expect(formatTickValue(1e7)).toContain('e')
    expect(formatTickValue(0.0001)).toContain('e')
  })
})
