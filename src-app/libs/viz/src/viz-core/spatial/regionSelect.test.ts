// regionSelect.test.ts — correctness proof for the region-on-layout selection + composition
// helpers. A polygon over a KNOWN cluster must return exactly that cluster's point indices
// (both with and without the KD-tree fast path — byte-identical) and its group composition;
// an empty region returns nothing; out-of-range codes/indices are tolerated.

import { describe, it, expect } from 'vitest'
import { selectRegion, regionComposition, type Vec2 } from './regionSelect'
import { buildPointIndex } from './pointIndex'

// A tiny two-cluster layout with a known partition:
//   indices 0..3 → cluster A around (1..2, 1..2), group code 0
//   indices 4..6 → cluster B around (11..12, 11..12), group code 1
const POSITIONS = new Float32Array([
  1, 1, 2, 1, 1, 2, 2, 2, // cluster A (group 0)
  11, 11, 12, 11, 11, 12, // cluster B (group 1)
])
const N = POSITIONS.length / 2 // 7
const GROUP_CODES = new Uint16Array([0, 0, 0, 0, 1, 1, 1])
const CATEGORIES = ['A', 'B']

const CLUSTER_A_POLY: Vec2[] = [
  [0, 0],
  [5, 0],
  [5, 5],
  [0, 5],
]
const CLUSTER_B_POLY: Vec2[] = [
  [10, 10],
  [13, 10],
  [13, 13],
  [10, 13],
]
const BOTH_POLY: Vec2[] = [
  [0, 0],
  [13, 0],
  [13, 13],
  [0, 13],
]
const EMPTY_POLY: Vec2[] = [
  [100, 100],
  [101, 100],
  [101, 101],
]

const asArray = (u: Uint32Array): number[] => Array.from(u).sort((a, b) => a - b)

describe('selectRegion', () => {
  it('selects exactly the points of the polygon-covered cluster (KD-tree path)', () => {
    const index = buildPointIndex(POSITIONS)
    expect(asArray(selectRegion(CLUSTER_A_POLY, POSITIONS, N, index))).toEqual([0, 1, 2, 3])
    expect(asArray(selectRegion(CLUSTER_B_POLY, POSITIONS, N, index))).toEqual([4, 5, 6])
    expect(asArray(selectRegion(BOTH_POLY, POSITIONS, N, index))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('is byte-identical with and without the KD-tree index (index only changes cost)', () => {
    const index = buildPointIndex(POSITIONS)
    for (const poly of [CLUSTER_A_POLY, CLUSTER_B_POLY, BOTH_POLY, EMPTY_POLY]) {
      const withIndex = asArray(selectRegion(poly, POSITIONS, N, index))
      const scan = asArray(selectRegion(poly, POSITIONS, N))
      expect(withIndex).toEqual(scan)
    }
  })

  it('returns an empty selection for a region with no points', () => {
    const index = buildPointIndex(POSITIONS)
    expect(selectRegion(EMPTY_POLY, POSITIONS, N, index).length).toBe(0)
  })

  it('selects nothing for a degenerate (<3 vertex) ring', () => {
    const index = buildPointIndex(POSITIONS)
    expect(selectRegion([[0, 0], [5, 5]], POSITIONS, N, index).length).toBe(0)
  })
})

describe('regionComposition', () => {
  it('reports counts + fractions per category for a single-cluster region', () => {
    const index = buildPointIndex(POSITIONS)
    const sel = selectRegion(CLUSTER_A_POLY, POSITIONS, N, index)
    const comp = regionComposition(sel, GROUP_CODES, CATEGORIES)
    expect(comp.total).toBe(4)
    expect(comp.entries).toEqual([{ code: 0, category: 'A', count: 4, fraction: 1 }])
  })

  it('reports a multi-type region, largest category first, fractions summing to 1', () => {
    const index = buildPointIndex(POSITIONS)
    const sel = selectRegion(BOTH_POLY, POSITIONS, N, index)
    const comp = regionComposition(sel, GROUP_CODES, CATEGORIES)
    expect(comp.total).toBe(7)
    expect(comp.entries.map(e => e.category)).toEqual(['A', 'B']) // 4 > 3 → A first
    expect(comp.entries.map(e => e.count)).toEqual([4, 3])
    const fracSum = comp.entries.reduce((s, e) => s + e.fraction, 0)
    expect(fracSum).toBeCloseTo(1, 10)
  })

  it('is empty for an empty selection (no division by zero)', () => {
    const comp = regionComposition(new Uint32Array(0), GROUP_CODES, CATEGORIES)
    expect(comp.total).toBe(0)
    expect(comp.entries).toEqual([])
  })

  it('accepts a plain iterable of indices, not just a Uint32Array', () => {
    const comp = regionComposition([4, 5, 6], GROUP_CODES, CATEGORIES)
    expect(comp.total).toBe(3)
    expect(comp.entries).toEqual([{ code: 1, category: 'B', count: 3, fraction: 1 }])
  })

  it('skips out-of-range indices and out-of-range codes', () => {
    // index 99 is out of range; code 5 (index 0's code below) is within range here, so craft a
    // codes column with an out-of-range code to prove it is dropped from the tally.
    const codes = new Uint16Array([9, 0, 1, 1]) // point 0 has code 9 (>= categories.length)
    const comp = regionComposition([0, 1, 2, 3, 99], codes, CATEGORIES)
    // point 0 (code 9) dropped, point 99 out of range dropped → A:1 (idx1), B:2 (idx2,3)
    expect(comp.total).toBe(3)
    expect(comp.entries.map(e => [e.category, e.count])).toEqual([
      ['B', 2],
      ['A', 1],
    ])
  })
})
