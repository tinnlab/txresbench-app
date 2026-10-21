// statsKernels.test.ts — known-answer coverage for the CPU stats parity oracle (ITEM-45).
// Every kernel is checked against a hand-computed expected output plus its degenerate
// (empty / single / flat / NaN) contract.

import { describe, it, expect } from 'vitest'
import {
  quartiles,
  quartilesOfColumn,
  hierarchicalClustering,
  cutTree,
  mannWhitneyU,
  tTest,
  kruskalWallis,
  packBrackets,
  significanceLabel,
  proportions,
  stackedCumulative,
  zscoreColumn,
  smoothedDensity,
  normalCdf,
  HIER_ROW_CAP,
} from './statsKernels'

describe('quartiles', () => {
  it('computes linear-interpolation quartiles of [1..9]', () => {
    const q = quartiles([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(q.q1).toBeCloseTo(3, 10)
    expect(q.median).toBeCloseTo(5, 10)
    expect(q.q3).toBeCloseTo(7, 10)
    expect(q.iqr).toBeCloseTo(4, 10)
    expect(q.min).toBe(1)
    expect(q.max).toBe(9)
    expect(q.lowerFence).toBeCloseTo(-3, 10)
    expect(q.upperFence).toBeCloseTo(13, 10)
    expect(q.outliers).toEqual([])
  })

  it('flags Tukey outliers beyond 1.5·IQR', () => {
    const q = quartiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])
    expect(q.outliers).toContain(100)
    expect(q.max).toBe(100)
  })

  it('is order-independent (sorts internally)', () => {
    const a = quartiles([9, 1, 5, 3, 7, 2, 8, 4, 6])
    expect(a.median).toBeCloseTo(5, 10)
    expect(a.q1).toBeCloseTo(3, 10)
    expect(a.q3).toBeCloseTo(7, 10)
  })

  it('drops NaN / Infinity before computing', () => {
    const q = quartiles([1, 2, NaN, 3, 4, Infinity, 5, 6, 7, 8, 9])
    expect(q.median).toBeCloseTo(5, 10)
    expect(q.outliers).toEqual([])
  })

  it('honors the degenerate contract (empty / single / flat)', () => {
    const empty = quartiles([])
    expect(empty).toMatchObject({ q1: 0, median: 0, q3: 0, iqr: 0, outliers: [] })

    const single = quartiles([42])
    expect(single).toMatchObject({ q1: 42, median: 42, q3: 42, min: 42, max: 42, iqr: 0, outliers: [] })

    const flat = quartiles([7, 7, 7, 7])
    expect(flat.iqr).toBe(0)
    expect(flat.median).toBe(7)
    expect(flat.outliers).toEqual([])
  })

  it('quartilesOfColumn reads a DataTable column', () => {
    const table = {
      rowLabels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      columns: { x: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
    }
    const q = quartilesOfColumn(table, 'x')
    expect(q.median).toBeCloseTo(5, 5)
    // missing column → empty contract
    expect(quartilesOfColumn(table, 'nope').median).toBe(0)
  })
})

describe('hierarchicalClustering', () => {
  // Two well-separated 2-D clusters: {0,1} near origin, {2,3} near (10,10).
  const matrix = new Float32Array([0, 0, 0, 1, 10, 10, 10, 11])

  it('merges the two natural clusters first (euclidean/average)', () => {
    const res = hierarchicalClustering(matrix, 4, 2, {
      linkage: 'average',
      distance: 'euclidean',
    })
    expect(res.capped).toBe(false)
    expect(res.merges).toHaveLength(3)
    // First two merges are the two tight pairs (height 1), the last is the big join.
    expect(res.merges[0].height).toBeCloseTo(1, 6)
    expect(res.merges[1].height).toBeCloseTo(1, 6)
    expect(res.merges[2].height).toBeGreaterThan(5)
    // Leaf order keeps each pair adjacent.
    const pos = new Map(res.order.map((leaf, idx) => [leaf, idx]))
    expect(Math.abs(pos.get(0)! - pos.get(1)!)).toBe(1)
    expect(Math.abs(pos.get(2)! - pos.get(3)!)).toBe(1)
    expect(new Set(res.order)).toEqual(new Set([0, 1, 2, 3]))
  })

  it('cutTree(_, 2) recovers the two clusters', () => {
    const res = hierarchicalClustering(matrix, 4, 2, {
      linkage: 'complete',
      distance: 'euclidean',
    })
    const labels = cutTree(res.merges, 2)
    expect(labels).toHaveLength(4)
    expect(labels[0]).toBe(labels[1])
    expect(labels[2]).toBe(labels[3])
    expect(labels[0]).not.toBe(labels[2])
  })

  it('cutTree k=1 → all one cluster; k=n → all distinct', () => {
    const res = hierarchicalClustering(matrix, 4, 2, {
      linkage: 'average',
      distance: 'euclidean',
    })
    expect(new Set(cutTree(res.merges, 1)).size).toBe(1)
    expect(new Set(cutTree(res.merges, 4)).size).toBe(4)
    // over-cut clamps to n
    expect(new Set(cutTree(res.merges, 99)).size).toBe(4)
  })

  it('ward and correlation linkage/metric run and still separate the clusters', () => {
    const res = hierarchicalClustering(matrix, 4, 2, {
      linkage: 'ward',
      distance: 'euclidean',
    })
    const labels = cutTree(res.merges, 2)
    expect(labels[0]).toBe(labels[1])
    expect(labels[2]).toBe(labels[3])

    // correlation distance on rows with distinct shapes
    const shapeM = new Float32Array([1, 2, 3, 2, 4, 6, 3, 1, 2, 6, 2, 4])
    const cres = hierarchicalClustering(shapeM, 4, 3, {
      linkage: 'average',
      distance: 'correlation',
    })
    expect(cres.merges).toHaveLength(3)
    expect(cres.order).toHaveLength(4)
    expect(cres.merges.every(m => Number.isFinite(m.height))).toBe(true)
  })

  it('caps above HIER_ROW_CAP with identity order + capped flag', () => {
    const n = HIER_ROW_CAP + 1
    const big = new Float32Array(n) // 1 col, all zeros — content irrelevant
    const res = hierarchicalClustering(big, n, 1, {
      linkage: 'average',
      distance: 'euclidean',
    })
    expect(res.capped).toBe(true)
    expect(res.merges).toEqual([])
    expect(res.order).toHaveLength(n)
    expect(res.order[0]).toBe(0)
    expect(res.order[n - 1]).toBe(n - 1)
  })

  it('degenerate row counts (0 and 1)', () => {
    expect(hierarchicalClustering(new Float32Array([]), 0, 0, {
      linkage: 'average',
      distance: 'euclidean',
    })).toEqual({ order: [], merges: [], capped: false })
    expect(hierarchicalClustering(new Float32Array([5, 6]), 1, 2, {
      linkage: 'average',
      distance: 'euclidean',
    })).toEqual({ order: [0], merges: [], capped: false })
  })

  it('handles a flat (identical) row under correlation without NaN', () => {
    const m = new Float32Array([0, 0, 0, 1, 2, 3])
    const res = hierarchicalClustering(m, 2, 3, {
      linkage: 'average',
      distance: 'correlation',
    })
    expect(res.merges).toHaveLength(1)
    expect(Number.isFinite(res.merges[0].height)).toBe(true)
  })
})

describe('significance tests', () => {
  it('mannWhitneyU: clearly separated groups → small p', () => {
    const { u, p } = mannWhitneyU([1, 2, 3, 4, 5], [11, 12, 13, 14, 15])
    expect(u).toBe(0)
    expect(p).toBeLessThan(0.05)
  })

  it('mannWhitneyU: overlapping/identical groups → large p', () => {
    const { p } = mannWhitneyU([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
    expect(p).toBeGreaterThan(0.5)
  })

  it('mannWhitneyU: empty group → p = 1, u = 0', () => {
    expect(mannWhitneyU([], [1, 2, 3])).toEqual({ u: 0, p: 1 })
  })

  it('tTest (Welch): separated means → tiny p, big |t|', () => {
    const { t, p } = tTest([1, 2, 3, 4, 5], [21, 22, 23, 24, 25])
    expect(Math.abs(t)).toBeGreaterThan(10)
    expect(p).toBeLessThan(0.001)
  })

  it('tTest: identical groups → t≈0, p≈1', () => {
    const { t, p } = tTest([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
    expect(t).toBeCloseTo(0, 10)
    expect(p).toBeCloseTo(1, 6)
  })

  it('tTest: n<2 in either group → degenerate (t=0,p=1)', () => {
    expect(tTest([1], [1, 2, 3])).toEqual({ t: 0, p: 1 })
    expect(tTest([], [])).toEqual({ t: 0, p: 1 })
  })

  it('kruskalWallis: three separated groups → small p', () => {
    const { h, p } = kruskalWallis([[1, 2, 3], [11, 12, 13], [21, 22, 23]])
    expect(h).toBeCloseTo(7.2, 6)
    expect(p).toBeLessThan(0.05)
  })

  it('kruskalWallis: <2 groups → degenerate', () => {
    expect(kruskalWallis([[1, 2, 3]])).toEqual({ h: 0, p: 1 })
    expect(kruskalWallis([])).toEqual({ h: 0, p: 1 })
  })

  it('normalCdf sanity', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3)
  })
})

describe('packBrackets', () => {
  it('assigns disjoint brackets the same level, overlapping ones higher', () => {
    const out = packBrackets(
      [
        { i: 0, j: 1, p: 0.0005 },
        { i: 2, j: 3, p: 0.2 },
        { i: 0, j: 3, p: 0.03 },
      ],
      100,
      10,
    )
    expect(out[0]).toMatchObject({ i: 0, j: 1, y: 100, label: '***' })
    expect(out[1]).toMatchObject({ i: 2, j: 3, y: 100, label: 'ns' })
    expect(out[2]).toMatchObject({ i: 0, j: 3, y: 110, label: '*' })
  })

  it('nested brackets stack to distinct levels', () => {
    const out = packBrackets(
      [
        { i: 0, j: 5, p: 0.01 },
        { i: 1, j: 4, p: 0.01 },
        { i: 2, j: 3, p: 0.01 },
      ],
      0,
      1,
    )
    const ys = out.map(b => b.y).sort((a, b) => a - b)
    expect(new Set(ys).size).toBe(3) // all different levels
  })

  it('empty input → empty output', () => {
    expect(packBrackets([], 0, 5)).toEqual([])
  })

  it('significanceLabel thresholds', () => {
    expect(significanceLabel(0.0009)).toBe('***')
    expect(significanceLabel(0.005)).toBe('**')
    expect(significanceLabel(0.04)).toBe('*')
    expect(significanceLabel(0.5)).toBe('ns')
    expect(significanceLabel(NaN)).toBe('ns')
  })
})

describe('proportions & stackedCumulative', () => {
  it('proportions sum to 1 with the right fractions', () => {
    const p = proportions(Uint16Array.from([0, 0, 1, 2, 2, 2]), 3)
    expect(p[0]).toBeCloseTo(2 / 6, 6)
    expect(p[1]).toBeCloseTo(1 / 6, 6)
    expect(p[2]).toBeCloseTo(3 / 6, 6)
    expect(Array.from(p).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6)
  })

  it('proportions ignores out-of-range codes and handles empty', () => {
    const p = proportions(Uint16Array.from([0, 9, 1]), 2) // code 9 ignored
    expect(Array.from(p)).toEqual([0.5, 0.5])
    expect(Array.from(proportions(new Uint16Array(0), 3))).toEqual([0, 0, 0])
    expect(proportions(Uint16Array.from([0, 1]), 0)).toHaveLength(0)
  })

  it('stackedCumulative accumulates series baselines per category', () => {
    expect(stackedCumulative([[1, 2], [3, 4], [5, 6]])).toEqual([
      [1, 2],
      [4, 6],
      [9, 12],
    ])
  })

  it('stackedCumulative tolerates empty / jagged input', () => {
    expect(stackedCumulative([])).toEqual([])
    // col 0 accumulates across rows (1 → 1+2=3); col 1 only appears in row 1.
    expect(stackedCumulative([[1], [2, 3]])).toEqual([[1], [3, 3]])
  })
})

describe('reused reductions', () => {
  it('zscoreColumn standardizes to mean 0 / sd 1', () => {
    const z = zscoreColumn([1, 2, 3, 4, 5])
    const arr = Array.from(z)
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length
    expect(mean).toBeCloseTo(0, 6)
    // population sd of a z-scored series ≈ 1
    const sd = Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length)
    expect(sd).toBeCloseTo(1, 6)
  })

  it('zscoreColumn on a flat column → all zeros (÷0 guard)', () => {
    expect(Array.from(zscoreColumn([5, 5, 5]))).toEqual([0, 0, 0])
  })

  it('smoothedDensity returns a curve; empty input → empty', () => {
    const curve = smoothedDensity([1, 2, 3, 4, 5], 16, 1)
    expect(curve).toHaveLength(16)
    expect(curve.every(pt => Number.isFinite(pt.density) && pt.density >= 0)).toBe(true)
    expect(smoothedDensity([])).toEqual([])
  })
})
