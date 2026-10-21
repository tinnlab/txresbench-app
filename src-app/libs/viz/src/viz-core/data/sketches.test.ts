// sketches.test.ts — accuracy + mergeability coverage for the streaming sketches
// (STREAMING_PROGRESSIVE_PLAN.md item 12). KLL quantiles are checked for rank error
// on uniform + skewed distributions and for merge associativity; HLL is checked for
// distinct-count accuracy + register-wise merge; hash32 for distribution. The RNG is
// seeded (mulberry32) so every "randomized" assertion is deterministic.

import { describe, it, expect } from 'vitest'
import { KllSketch, HyperLogLog, hash32 } from './sketches'

/** Deterministic seedable PRNG so KLL's coin flips are reproducible in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Exact quantile of a sorted copy (linear rank, matches KLL's weight semantics). */
function trueQuantile(sortedAsc: number[], q: number): number {
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

/** Max observed |estimated-rank − true-rank| / N across a grid of quantiles. */
function maxRankError(sketch: KllSketch, sortedAsc: number[], qs: number[]): number {
  const n = sortedAsc.length
  let worst = 0
  for (const q of qs) {
    const v = sketch.quantile(q)
    // rank(v) = count of items <= v (binary search on the sorted array)
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sortedAsc[mid] <= v) lo = mid + 1
      else hi = mid
    }
    const estRank = lo // number of items <= v
    const trueRank = Math.ceil(q * n)
    worst = Math.max(worst, Math.abs(estRank - trueRank) / n)
  }
  return worst
}

const QGRID = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]
const N = 100_000

describe('KllSketch — quantile accuracy', () => {
  it('is within ~2% rank error on a uniform distribution (N=100k)', () => {
    const rng = mulberry32(12345)
    const draw = mulberry32(999)
    const sketch = new KllSketch(200, rng)
    const data: number[] = []
    for (let i = 0; i < N; i++) {
      const x = draw() * 1000
      data.push(x)
      sketch.update(x)
    }
    expect(sketch.count).toBe(N)
    const sorted = [...data].sort((a, b) => a - b)
    expect(maxRankError(sketch, sorted, QGRID)).toBeLessThan(0.02)
    // spot-check a couple of values live near the true quantiles too
    expect(sketch.quantile(0.5)).toBeCloseTo(trueQuantile(sorted, 0.5), -1)
    expect(sketch.quantile(0.99)).toBeCloseTo(trueQuantile(sorted, 0.99), -1)
  })

  it('is within ~2% rank error on a skewed (exponential) distribution (N=100k)', () => {
    const rng = mulberry32(54321)
    const draw = mulberry32(7)
    const sketch = new KllSketch(200, rng)
    const data: number[] = []
    for (let i = 0; i < N; i++) {
      // inverse-CDF exponential: skewed, long right tail (color-scale p99 case)
      const x = -Math.log(1 - draw()) * 100
      data.push(x)
      sketch.update(x)
    }
    const sorted = [...data].sort((a, b) => a - b)
    expect(maxRankError(sketch, sorted, QGRID)).toBeLessThan(0.02)
  })

  it('ignores NaN / ±Infinity on update', () => {
    const sketch = new KllSketch(200, mulberry32(1))
    sketch.update(Number.NaN)
    sketch.update(Number.POSITIVE_INFINITY)
    sketch.update(Number.NEGATIVE_INFINITY)
    expect(sketch.count).toBe(0)
    expect(sketch.quantile(0.5)).toBeNaN()
    sketch.update(5)
    expect(sketch.count).toBe(1)
    expect(sketch.quantile(0.5)).toBe(5)
  })
})

describe('KllSketch — merge associativity', () => {
  it('merge(sketch(A), sketch(B)) ≈ sketch(A∪B) within tolerance', () => {
    const drawA = mulberry32(101)
    const drawB = mulberry32(202)
    const all: number[] = []

    const sketchAll = new KllSketch(200, mulberry32(1))
    const sketchA = new KllSketch(200, mulberry32(2))
    const sketchB = new KllSketch(200, mulberry32(3))

    for (let i = 0; i < N; i++) {
      const a = drawA() * 500
      const b = 500 + drawB() * 500 // different range → merge must span both
      all.push(a, b)
      sketchAll.update(a)
      sketchAll.update(b)
      sketchA.update(a)
      sketchB.update(b)
    }

    sketchA.merge(sketchB)
    expect(sketchA.count).toBe(2 * N)
    expect(sketchAll.count).toBe(2 * N)

    const sorted = [...all].sort((x, y) => x - y)
    // The merged sketch must itself be an accurate quantile summary of A∪B.
    expect(maxRankError(sketchA, sorted, QGRID)).toBeLessThan(0.03)
    // And it should track the single-pass sketch closely at each quantile.
    for (const q of QGRID) {
      const span = sorted[sorted.length - 1] - sorted[0]
      expect(Math.abs(sketchA.quantile(q) - sketchAll.quantile(q))).toBeLessThan(0.05 * span)
    }
  })

  it('merge is commutative in accuracy (B∪A ≈ A∪B)', () => {
    const drawA = mulberry32(11)
    const drawB = mulberry32(22)
    const a: number[] = []
    const b: number[] = []
    const sA = new KllSketch(200, mulberry32(2))
    const sB = new KllSketch(200, mulberry32(3))
    for (let i = 0; i < 50_000; i++) {
      const va = drawA() * 300
      const vb = drawB() * 700
      a.push(va)
      b.push(vb)
      sA.update(va)
      sB.update(vb)
    }
    const sA2 = new KllSketch(200, mulberry32(2))
    const sB2 = new KllSketch(200, mulberry32(3))
    for (const v of a) sA2.update(v)
    for (const v of b) sB2.update(v)

    sA.merge(sB) // A then B
    sB2.merge(sA2) // B then A
    const all = [...a, ...b].sort((x, y) => x - y)
    for (const q of QGRID) {
      const span = all[all.length - 1] - all[0]
      expect(Math.abs(sA.quantile(q) - sB2.quantile(q))).toBeLessThan(0.05 * span)
    }
  })

  it('merging an empty sketch is a no-op', () => {
    const s = new KllSketch(200, mulberry32(5))
    for (let i = 0; i < 1000; i++) s.update(i)
    const before = s.quantile(0.5)
    s.merge(new KllSketch(200, mulberry32(6)))
    expect(s.count).toBe(1000)
    expect(s.quantile(0.5)).toBe(before)
  })
})

describe('HyperLogLog — distinct count', () => {
  it('estimates 1k distinct within ~3%', () => {
    const hll = new HyperLogLog(12)
    const D = 1000
    for (let i = 0; i < D; i++) hll.add(hash32(i))
    // add duplicates — estimate must not move
    for (let rep = 0; rep < 5; rep++) for (let i = 0; i < D; i++) hll.add(hash32(i))
    const est = hll.estimate()
    expect(Math.abs(est - D) / D).toBeLessThan(0.03)
  })

  it('estimates 100k distinct within ~3%', () => {
    const hll = new HyperLogLog(12)
    const D = 100_000
    for (let i = 0; i < D; i++) hll.add(hash32(i))
    const est = hll.estimate()
    expect(Math.abs(est - D) / D).toBeLessThan(0.03)
  })

  it('estimates ~0 for an empty sketch', () => {
    expect(new HyperLogLog(12).estimate()).toBeLessThan(1)
  })

  it('merges register-wise (union cardinality) within ~3%', () => {
    const a = new HyperLogLog(12)
    const b = new HyperLogLog(12)
    // disjoint halves 0..49999 and 50000..99999
    for (let i = 0; i < 50_000; i++) a.add(hash32(i))
    for (let i = 50_000; i < 100_000; i++) b.add(hash32(i))
    a.merge(b)
    const est = a.estimate()
    expect(Math.abs(est - 100_000) / 100_000).toBeLessThan(0.03)
  })

  it('merge with overlapping sets estimates the union, not the sum', () => {
    const a = new HyperLogLog(12)
    const b = new HyperLogLog(12)
    for (let i = 0; i < 60_000; i++) a.add(hash32(i))
    for (let i = 40_000; i < 100_000; i++) b.add(hash32(i)) // 20k overlap
    a.merge(b)
    const est = a.estimate()
    expect(Math.abs(est - 100_000) / 100_000).toBeLessThan(0.03)
  })

  it('throws on precision mismatch', () => {
    const a = new HyperLogLog(12)
    const b = new HyperLogLog(10)
    expect(() => a.merge(b)).toThrow(/precision/)
  })
})

describe('hash32', () => {
  it('is deterministic', () => {
    expect(hash32(42)).toBe(hash32(42))
    expect(hash32(0)).toBe(hash32(0))
  })

  it('returns a uint32', () => {
    for (const x of [0, 1, -1, 10000, 123456789]) {
      const h = hash32(x)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
      expect(Number.isInteger(h)).toBe(true)
    }
  })

  it('has no obvious collisions over 0..10000', () => {
    const seen = new Set<number>()
    for (let i = 0; i <= 10_000; i++) seen.add(hash32(i))
    // a good 32-bit mixer over 10k distinct inputs should be collision-free
    expect(seen.size).toBe(10_001)
  })

  it('spreads the top bits evenly (chi-square-ish bucket balance)', () => {
    const buckets = new Uint32Array(16)
    const total = 100_000
    for (let i = 0; i < total; i++) buckets[hash32(i) >>> 28] += 1
    const expected = total / 16
    for (const c of buckets) {
      // each 1/16 bucket should be within ±20% of the mean
      expect(Math.abs(c - expected) / expected).toBeLessThan(0.2)
    }
  })
})
