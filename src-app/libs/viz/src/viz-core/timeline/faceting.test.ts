// faceting.test.ts — unit tests for the pure facet-partition math.

import { describe, it, expect } from 'vitest'
import { partitionByCategorical, facetGridLayout, sharedDomain, type Facet } from './faceting'

describe('partitionByCategorical', () => {
  const cats = ['A', 'B', 'C']

  it('one facet per category, correct per-facet indices', () => {
    const codes = new Uint16Array([0, 1, 2, 0, 1, 0])
    const facets = partitionByCategorical(codes, cats)
    expect(facets.map(f => f.label)).toEqual(['A', 'B', 'C'])
    expect(Array.from(facets[0].indices)).toEqual([0, 3, 5])
    expect(Array.from(facets[1].indices)).toEqual([1, 4])
    expect(Array.from(facets[2].indices)).toEqual([2])
  })

  it('the partition covers every point exactly once', () => {
    const codes = new Uint16Array([0, 1, 2, 0, 1, 0, 2, 2])
    const facets = partitionByCategorical(codes, cats)
    const all = facets.flatMap(f => Array.from(f.indices)).sort((a, b) => a - b)
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(facets.reduce((s, f) => s + f.indices.length, 0)).toBe(codes.length)
  })

  it('an empty category yields a length-0 facet (never dropped)', () => {
    const codes = new Uint16Array([0, 0, 2, 2]) // no B
    const facets = partitionByCategorical(codes, cats)
    expect(facets).toHaveLength(3)
    expect(facets[1].label).toBe('B')
    expect(facets[1].indices.length).toBe(0)
  })

  it('ignores out-of-range codes defensively', () => {
    const codes = new Uint16Array([0, 5, 1]) // 5 >= 3 categories
    const facets = partitionByCategorical(codes, cats)
    expect(facets.reduce((s, f) => s + f.indices.length, 0)).toBe(2)
    expect(Array.from(facets[0].indices)).toEqual([0])
    expect(Array.from(facets[1].indices)).toEqual([2])
  })

  it('accepts a plain number[] too', () => {
    const facets = partitionByCategorical([2, 2, 0], cats)
    expect(Array.from(facets[2].indices)).toEqual([0, 1])
    expect(Array.from(facets[0].indices)).toEqual([2])
  })
})

describe('facetGridLayout', () => {
  it('caps columns at maxCols and fills rows', () => {
    expect(facetGridLayout(8, { maxCols: 4 })).toEqual({ rows: 2, cols: 4 })
    expect(facetGridLayout(3, { maxCols: 4 })).toEqual({ rows: 1, cols: 3 })
    expect(facetGridLayout(5, { maxCols: 3 })).toEqual({ rows: 2, cols: 3 })
    expect(facetGridLayout(7, { maxCols: 3 })).toEqual({ rows: 3, cols: 3 })
  })

  it('defaults maxCols to 4', () => {
    expect(facetGridLayout(10)).toEqual({ rows: 3, cols: 4 })
  })

  it('zero facets → empty grid', () => {
    expect(facetGridLayout(0)).toEqual({ rows: 0, cols: 0 })
  })

  it('single facet → 1x1', () => {
    expect(facetGridLayout(1, { maxCols: 4 })).toEqual({ rows: 1, cols: 1 })
  })
})

describe('sharedDomain', () => {
  it('unions min/max across ALL facets so they share a scale', () => {
    const values = [3, 1, 9, 4, 7]
    const facets: Facet[] = [
      { code: 0, label: 'A', indices: new Uint32Array([0, 1]) }, // 3, 1
      { code: 1, label: 'B', indices: new Uint32Array([2, 3, 4]) }, // 9, 4, 7
    ]
    expect(sharedDomain(facets, i => values[i])).toEqual([1, 9])
  })

  it('skips non-finite values', () => {
    const values = [NaN, 2, Infinity, 5]
    const facets: Facet[] = [{ code: 0, label: 'A', indices: new Uint32Array([0, 1, 2, 3]) }]
    expect(sharedDomain(facets, i => values[i])).toEqual([2, 5])
  })

  it('no finite values → [0,0]', () => {
    const facets: Facet[] = [{ code: 0, label: 'A', indices: new Uint32Array([]) }]
    expect(sharedDomain(facets, () => 1)).toEqual([0, 0])
  })
})
