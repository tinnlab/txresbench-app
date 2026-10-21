// adaptiveSample.test.ts — unit tests for the stable / density-adaptive / budget-capped sampler.
// Pure typed-array math (no deck.gl / DOM), so it runs in node under vitest.

import { describe, it, expect } from 'vitest'
import type { DensityBounds } from '../density/densityBin'
import {
  adaptiveSample,
  gatherByIndices,
  planAdaptiveCap,
  pointPriority,
  stableSampleOrder,
  takeBudget,
} from './adaptiveSample'

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const asSet = (a: Uint32Array) => new Set(Array.from(a))
const isSubset = (a: Uint32Array, b: Uint32Array) => {
  const bs = asSet(b)
  return Array.from(a).every(x => bs.has(x))
}

// ── #3: stable order + prefix budget = superset ──────────────────────────────────

describe('stableSampleOrder / takeBudget (stable superset)', () => {
  it('is a genuine permutation of [0, n)', () => {
    const order = stableSampleOrder(1000)
    expect(order.length).toBe(1000)
    expect(asSet(order).size).toBe(1000)
    expect(Math.min(...order)).toBe(0)
    expect(Math.max(...order)).toBe(999)
  })

  it('is deterministic for a given seed and varies with the seed', () => {
    expect(Array.from(stableSampleOrder(500, 1))).toEqual(Array.from(stableSampleOrder(500, 1)))
    expect(Array.from(stableSampleOrder(500, 1))).not.toEqual(Array.from(stableSampleOrder(500, 2)))
  })

  it('THE superset property: sample(k) ⊂ sample(k+1) for every k', () => {
    const order = stableSampleOrder(200, 7)
    for (let k = 0; k < 200; k++) {
      const small = takeBudget(order, k)
      const bigger = takeBudget(order, k + 1)
      expect(small.length).toBe(k)
      expect(isSubset(small, bigger)).toBe(true)
    }
  })

  it('takeBudget clamps k to [0, n]', () => {
    const order = stableSampleOrder(10)
    expect(takeBudget(order, -5).length).toBe(0)
    expect(takeBudget(order, 999).length).toBe(10)
  })

  it('pointPriority is stable and in [0, 1)', () => {
    for (let i = 0; i < 50; i++) {
      const p = pointPriority(i, 3)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
      expect(pointPriority(i, 3)).toBe(p)
    }
  })
})

// ── #4a: density-adaptive per-cell cap ────────────────────────────────────────────

describe('adaptiveSample — per-cell cap flattens density', () => {
  it('caps a DENSE cell at capPerCell while keeping a SPARSE cell fully', () => {
    // 1×2 grid: left cell (x<0.5) packed with 100 points, right cell has just 3.
    const n = 103
    const positions = new Float32Array(n * 2)
    for (let i = 0; i < 100; i++) {
      positions[2 * i] = 0.25
      positions[2 * i + 1] = 0.5
    }
    for (let i = 100; i < 103; i++) {
      positions[2 * i] = 0.75
      positions[2 * i + 1] = 0.5
    }
    const cap = 10
    const res = adaptiveSample({ positions, bounds: UNIT, gridW: 2, gridH: 1, capPerCell: cap, budget: 1000 })
    const kept = res.indices
    const leftKept = Array.from(kept).filter(i => i < 100).length
    const rightKept = Array.from(kept).filter(i => i >= 100).length
    expect(leftKept).toBe(cap) // dense cell capped
    expect(rightKept).toBe(3) // sparse cell fully kept
    expect(res.maxKeptPerCell).toBe(cap)
  })

  it('never exceeds the total budget', () => {
    const n = 500
    const positions = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      positions[2 * i] = (i % 10) / 10 + 0.01
      positions[2 * i + 1] = 0.5
    }
    const res = adaptiveSample({ positions, bounds: UNIT, gridW: 10, gridH: 1, capPerCell: 1000, budget: 42 })
    expect(res.indices.length).toBeLessThanOrEqual(42)
  })

  it('drops points OUTSIDE the bounds (not on screen)', () => {
    const positions = new Float32Array([0.5, 0.5, 5, 5, -3, 0.2])
    const res = adaptiveSample({ positions, bounds: UNIT, gridW: 4, gridH: 4, capPerCell: 100, budget: 100 })
    // only the in-bounds point (index 0) survives.
    expect(Array.from(res.indices)).toEqual([0])
  })

  it('is superset-stable in the per-cell CAP (raising cap only ADDS points)', () => {
    const n = 400
    const positions = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      positions[2 * i] = (i % 4) / 4 + 0.05 // clustered into 4 columns
      positions[2 * i + 1] = 0.5
    }
    const base = { positions, bounds: UNIT, gridW: 4, gridH: 1, budget: 10000 }
    for (let cap = 1; cap < 30; cap++) {
      const small = adaptiveSample({ ...base, capPerCell: cap }).indices
      const bigger = adaptiveSample({ ...base, capPerCell: cap + 1 }).indices
      expect(isSubset(small, bigger)).toBe(true)
    }
  })

  it('is superset-stable in the BUDGET (raising budget only ADDS points)', () => {
    const n = 300
    const positions = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      positions[2 * i] = (i % 30) / 30 + 0.001
      positions[2 * i + 1] = 0.5
    }
    const base = { positions, bounds: UNIT, gridW: 30, gridH: 1, capPerCell: 5 }
    for (let b = 0; b < 120; b += 7) {
      const small = adaptiveSample({ ...base, budget: b }).indices
      const bigger = adaptiveSample({ ...base, budget: b + 7 }).indices
      expect(small.length).toBeLessThanOrEqual(b)
      expect(isSubset(small, bigger)).toBe(true)
    }
  })

  it('honours an explicit stable order (walks it, still superset-stable in cap)', () => {
    const n = 120
    const positions = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      positions[2 * i] = (i % 3) / 3 + 0.05
      positions[2 * i + 1] = 0.5
    }
    const order = stableSampleOrder(n, 9)
    const a = adaptiveSample({ positions, bounds: UNIT, gridW: 3, gridH: 1, capPerCell: 4, budget: 999, order }).indices
    const b = adaptiveSample({ positions, bounds: UNIT, gridW: 3, gridH: 1, capPerCell: 5, budget: 999, order }).indices
    expect(isSubset(a, b)).toBe(true)
  })
})

describe('planAdaptiveCap', () => {
  it('spreads the budget over the cells (ceil), guarded ≥ 1', () => {
    expect(planAdaptiveCap(1_000_000, 16384)).toBe(Math.ceil(1_000_000 / 16384))
    expect(planAdaptiveCap(10, 1000)).toBe(1) // fewer points than cells → cap floored to 1
    expect(planAdaptiveCap(0, 0)).toBe(1)
  })
})

// ── gather ────────────────────────────────────────────────────────────────────────

describe('gatherByIndices', () => {
  it('packs the selected points (positions, epp=2) in index order, same subtype', () => {
    const src = new Float32Array([0, 0, 10, 11, 20, 21, 30, 31])
    const out = gatherByIndices(src, Uint32Array.from([2, 0]), 2)!
    expect(out).toBeInstanceOf(Float32Array)
    expect(Array.from(out)).toEqual([20, 21, 0, 0])
  })

  it('gathers a scalar column (epp=1)', () => {
    const src = new Float32Array([5, 6, 7, 8])
    const out = gatherByIndices(src, Uint32Array.from([3, 1]), 1)!
    expect(Array.from(out)).toEqual([8, 6])
  })

  it('passes a nullish source through unchanged (no allocation)', () => {
    expect(gatherByIndices(null, Uint32Array.from([0]), 2)).toBeNull()
    expect(gatherByIndices(undefined, Uint32Array.from([0]), 1)).toBeUndefined()
  })
})
