import { describe, it, expect } from 'vitest'
import {
  boxStatsGpu,
  groupMeanSdGpu,
  mannWhitneyUGpu,
  histogramQuantile,
  boxStatFromCounts,
  boxStatsFromReducedCounts,
  boxStatsFromColumnBinnedPerGroup,
  maxPerGroupIqrQuartileError,
  heavyTailHeterogeneousFixture,
  meanSdFromReduced,
  binApproxMannWhitney,
  verifyBoxStatsParity,
  verifySignificanceParity,
} from './groupStatsGpu'
import { boxStatsFromColumn } from './BoxView'
import { quartiles, mannWhitneyU, tTest } from '../data/statsKernels'
import { meanStd } from '../data/missing'
import { binDomain } from './aggregateGpu'
import { cpuGroupMinMax } from '../gpu/groupReduce'
import { getComputeDevice } from '../gpu/computeDevice'
import type { CategoricalColumn, SparseColumn } from '../data/wire'

// The GPU path only runs in a real browser WebGL2 context (the orchestrator's headless
// harness calls `verifyBoxStatsParity` / `verifySignificanceParity` there). In node/vitest
// there is NO compute device (`getComputeDevice()` resolves null), so every `*Gpu` variant
// takes its CPU-FALLBACK branch — which calls the ORIGINAL exact oracle. These tests assert
// (a) that fallback is BYTE-IDENTICAL to the oracle, and (b) that the pure histogram-derived
// math (quartile CDF, U-from-histogram, mean/SD-from-reduce) agrees with the exact oracles
// to within the documented tolerance on a known fixture.

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A dense-backed sparse column: every point present, value = dense[i]. */
function sparseFromDense(values: number[]): SparseColumn {
  const value = Float32Array.from(values)
  const row = new Uint32Array(values.length)
  for (let i = 0; i < values.length; i++) row[i] = i
  return { row, value, length: values.length }
}

function bucket(values: number[], codes: number[], g: number): number[] {
  const out: number[] = []
  for (let i = 0; i < codes.length; i++) if (codes[i] === g) out.push(values[i])
  return out
}

/** Deterministic pseudo-uniform CONTINUOUS spread of `n` values over [0,`hi`). */
function continuousSpread(n: number, hi: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((((i * 7919) % 10007) / 10007) * hi)
  return out
}

/** A dense CDF-count histogram of `values` over `binDomain(lo,hi,nBins)` (for math tests). */
function histogramOf(values: number[], lo: number, hi: number, nBins: number): number[] {
  const dom = binDomain(lo, hi, nBins)!
  const counts = new Array<number>(nBins).fill(0)
  for (const v of values) {
    let b = Math.floor((v - dom.lo) / dom.binWidth)
    if (b < 0) b = 0
    else if (b >= nBins) b = nBins - 1
    counts[b]++
  }
  return counts
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALUES = [2, 4, 4, 5, 5, 7, 9, 3, 8, 6, 1, 10, 4, 6, 7, 5, 9, 2, 8, 3]
const CODES = [0, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1]
const CATEGORIES = ['A', 'B', 'C'] as const
const COL = sparseFromDense(VALUES)
const CAT: CategoricalColumn = { codes: Uint16Array.from(CODES), categories: [...CATEGORIES], length: VALUES.length }

// ── boxStatsGpu — CPU fallback byte-exact vs boxStatsFromColumn ───────────────

describe('boxStatsGpu — CPU fallback === boxStatsFromColumn oracle', () => {
  it('no device → identical BoxStat[] (byte-exact)', async () => {
    const gpu = await boxStatsGpu(COL, CAT)
    expect(gpu).toEqual(boxStatsFromColumn(COL, CAT))
  })

  it('explicit device=null forces the exact CPU oracle', async () => {
    const gpu = await boxStatsGpu(COL, CAT, {}, null)
    expect(gpu).toEqual(boxStatsFromColumn(COL, CAT))
  })

  it('preserves category order + empty-group all-zero stat', async () => {
    const codes = [0, 0, 0] // category B, C empty
    const col = sparseFromDense([1, 2, 3])
    const cat: CategoricalColumn = { codes: Uint16Array.from(codes), categories: [...CATEGORIES], length: 3 }
    const gpu = await boxStatsGpu(col, cat, {}, null)
    expect(gpu).toEqual(boxStatsFromColumn(col, cat))
    expect(gpu[1]).toEqual({ group: 'B', q1: 0, median: 0, q3: 0, lowerFence: 0, upperFence: 0, outliers: [] })
  })
})

// ── groupMeanSdGpu — CPU fallback byte-exact vs meanStd oracle ────────────────

describe('groupMeanSdGpu — CPU fallback === per-group meanStd oracle', () => {
  it('no device → mean/std/n identical to meanStd per group', async () => {
    const gpu = await groupMeanSdGpu(COL, CAT)
    for (let g = 0; g < CATEGORIES.length; g++) {
      const ref = meanStd(bucket(VALUES, CODES, g))
      expect(gpu[g]).toEqual({ mean: ref.mean, std: ref.std, n: ref.n })
    }
  })

  it('empty group → {NaN, NaN, 0} (matches meanStd)', async () => {
    const col = sparseFromDense([1, 2])
    const cat: CategoricalColumn = { codes: Uint16Array.from([0, 0]), categories: [...CATEGORIES], length: 2 }
    const gpu = await groupMeanSdGpu(col, cat, null)
    expect(gpu[1].n).toBe(0)
    expect(Number.isNaN(gpu[1].mean)).toBe(true)
    expect(Number.isNaN(gpu[1].std)).toBe(true)
  })
})

// ── mannWhitneyUGpu — CPU fallback byte-exact vs mannWhitneyU oracle ──────────

describe('mannWhitneyUGpu — CPU fallback === mannWhitneyU oracle', () => {
  it('no device → identical {u,p} to mannWhitneyU on the two buckets', async () => {
    const codes = Uint16Array.from(CODES)
    const values = Float32Array.from(VALUES)
    const gpu = await mannWhitneyUGpu(codes, values, 0, 1)
    const cpu = mannWhitneyU(bucket(VALUES, CODES, 0), bucket(VALUES, CODES, 1))
    expect(gpu).toEqual(cpu)
  })

  it('explicit device=null forces the exact oracle for every adjacent pair', async () => {
    const codes = Uint16Array.from(CODES)
    const values = Float32Array.from(VALUES)
    for (const [a, b] of [[0, 1], [1, 2]] as const) {
      const gpu = await mannWhitneyUGpu(codes, values, a, b, null)
      expect(gpu).toEqual(mannWhitneyU(bucket(VALUES, CODES, a), bucket(VALUES, CODES, b)))
    }
  })

  it('empty group → {u:0, p:1}', async () => {
    const codes = Uint16Array.from([0, 0, 0])
    const values = Float32Array.from([1, 2, 3])
    const gpu = await mannWhitneyUGpu(codes, values, 0, 1, null) // group 1 empty
    expect(gpu).toEqual(mannWhitneyU([1, 2, 3], []))
    expect(gpu).toEqual({ u: 0, p: 1 })
  })
})

// ── Pure histogram-CDF quantile math (device-free) ───────────────────────────

describe('histogramQuantile — inverse-CDF quantile approximates R-7 quantile', () => {
  it('min at p=0, max-ish at p=1, monotone across p', () => {
    const dom = binDomain(0, 10, 256)!
    const values = Array.from({ length: 500 }, (_, i) => (i % 100) / 10) // 0..9.9
    const counts = histogramOf(values, 0, 10, 256)
    const q0 = histogramQuantile(counts, dom, 0)
    const q50 = histogramQuantile(counts, dom, 0.5)
    const q100 = histogramQuantile(counts, dom, 1)
    expect(q0).toBeLessThanOrEqual(q50)
    expect(q50).toBeLessThanOrEqual(q100)
    expect(q0).toBeCloseTo(0, 1)
  })

  it('empty histogram → dom.lo', () => {
    const dom = binDomain(2, 8, 64)!
    expect(histogramQuantile(new Array(64).fill(0), dom, 0.5)).toBe(2)
  })

  it('agrees with the R-7 quartiles within tolerance on a CONTINUOUS spread', () => {
    // Continuous pseudo-uniform values in [0,20) (NOT integer-tied — the histogram-CDF
    // approximation is bin-resolution-limited only for continuous data; a heavily-tied
    // discrete column differs by up to the tie's value gap, which is expected).
    const dom = binDomain(0, 20, 256)!
    const values = continuousSpread(2000, 20)
    const counts = histogramOf(values, 0, 20, 256)
    const exact = quartiles(values)
    const tol = 20 * 0.04 // the documented quartile tolerance (fraction of the value range)
    expect(Math.abs(histogramQuantile(counts, dom, 0.25) - exact.q1)).toBeLessThan(tol)
    expect(Math.abs(histogramQuantile(counts, dom, 0.5) - exact.median)).toBeLessThan(tol)
    expect(Math.abs(histogramQuantile(counts, dom, 0.75) - exact.q3)).toBeLessThan(tol)
  })
})

describe('boxStatFromCounts / boxStatsFromReducedCounts — approximate box vs exact quartiles', () => {
  it('single-group histogram box ≈ exact quartiles (continuous spread)', () => {
    const dom = binDomain(0, 20, 256)!
    const values = continuousSpread(2000, 20)
    const counts = histogramOf(values, 0, 20, 256)
    const box = boxStatFromCounts(counts, dom, 'g')
    const exact = quartiles(values)
    const tol = 20 * 0.04 // documented quartile tolerance (fraction of the value range)
    expect(Math.abs(box.q1 - exact.q1)).toBeLessThan(tol)
    expect(Math.abs(box.median - exact.median)).toBeLessThan(tol)
    expect(Math.abs(box.q3 - exact.q3)).toBeLessThan(tol)
    expect(Math.abs(box.lowerFence - exact.lowerFence)).toBeLessThan(tol)
    expect(Math.abs(box.upperFence - exact.upperFence)).toBeLessThan(tol)
  })

  it('empty row → all-zero stat', () => {
    const dom = binDomain(0, 10, 32)!
    expect(boxStatFromCounts(new Array(32).fill(0), dom, 'z')).toEqual({
      group: 'z', q1: 0, median: 0, q3: 0, lowerFence: 0, upperFence: 0, outliers: [],
    })
  })

  it('reshapes a flat nGroups*binCount buffer into per-group boxes (category order)', () => {
    const dom = binDomain(0, 4, 4)!
    // 2 groups × 4 bins. group0 mass in bins 0-1, group1 mass in bins 2-3.
    const counts = [3, 3, 0, 0, /* g1 */ 0, 0, 2, 2]
    const boxes = boxStatsFromReducedCounts(counts, ['lo', 'hi'], dom)
    expect(boxes.map(b => b.group)).toEqual(['lo', 'hi'])
    expect(boxes[0].median).toBeLessThan(boxes[1].median)
  })

  it('marks bin centers beyond the fences as (bin-quantized) outliers', () => {
    const dom = binDomain(0, 100, 100)! // binWidth 1
    const counts = new Array(100).fill(0)
    for (let b = 40; b < 60; b++) counts[b] = 10 // tight cluster 40..59
    counts[95] = 1 // a far outlier bin
    const box = boxStatFromCounts(counts, dom, 'g')
    expect(box.outliers.length).toBeGreaterThan(0)
    expect(box.outliers.every(o => o < box.lowerFence || o > box.upperFence)).toBe(true)
  })

  // ── H1b: outliers are DE-DUPLICATED — one marker per bin, never `count` copies ──
  it('emits AT MOST ONE representative marker per outlier bin (H1b — no count duplication)', () => {
    const dom = binDomain(0, 100, 100)! // binWidth 1
    const counts = new Array(100).fill(0)
    for (let b = 40; b < 60; b++) counts[b] = 10 // bulk cluster
    counts[97] = 37 // a DENSE far-outlier bin: 37 points share one bin/position
    const box = boxStatFromCounts(counts, dom, 'g')
    // Exactly one outlier marker for the single populated outlier bin (NOT 37).
    expect(box.outliers).toEqual([97.5])
    expect(box.outliers.length).toBe(1)
  })

  it('two separate outlier bins → two markers (one each), still de-duplicated per bin', () => {
    const dom = binDomain(0, 100, 100)!
    const counts = new Array(100).fill(0)
    for (let b = 45; b < 55; b++) counts[b] = 8
    counts[3] = 12 // low outlier bin (12 points)
    counts[96] = 5 // high outlier bin (5 points)
    const box = boxStatFromCounts(counts, dom, 'g')
    expect(box.outliers.length).toBe(2) // one per bin, not 12+5
    expect(box.outliers.every(o => o < box.lowerFence || o > box.upperFence)).toBe(true)
  })
})

// ── H1: per-group binning (each group over its OWN [min,max]) ─────────────────

/** OLD (buggy) GLOBAL-domain box path: bin EVERY group into one column-wide [lo,hi]. */
function globalDomainBoxes(values: Float32Array, codes: Uint16Array, categories: string[]) {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v }
  const nBins = 256
  const dom = binDomain(lo, hi, nBins)!
  const nGroups = categories.length
  const counts = new Float32Array(nGroups * nBins)
  for (let i = 0; i < values.length; i++) {
    const g = codes[i]
    const v = values[i]
    if (g >= nGroups || !Number.isFinite(v)) continue
    let b = Math.floor((v - dom.lo) / dom.binWidth)
    if (b < 0) b = 0
    else if (b >= nBins) b = nBins - 1
    counts[g * nBins + b]++
  }
  return boxStatsFromReducedCounts(counts, categories, dom)
}

describe('boxStatsFromColumnBinnedPerGroup — H1: per-group [min,max] binning', () => {
  it('per-group binning matches the exact oracle within per-group-IQR tolerance', () => {
    const { col, cat, values, codes, categories } = heavyTailHeterogeneousFixture()
    const core = boxStatsFromColumnBinnedPerGroup(values, codes, categories)
    const exact = boxStatsFromColumn(col, cat)
    const err = maxPerGroupIqrQuartileError(core, exact)
    // The corrected per-group path: quartiles/fences within a small fraction of EACH group's
    // own IQR (state the achieved value in the report).
    // eslint-disable-next-line no-console
    console.log('[H1] per-group-IQR max quartile error =', err)
    // Achieved on this fixture: ≈ 0.014 (1.4 % of each group's OWN IQR). Bound at 0.05.
    expect(err).toBeLessThan(0.05)
  })

  it('the OLD global-domain path is badly wrong on narrow groups; the NEW path is not', () => {
    const { col, cat, values, codes, categories } = heavyTailHeterogeneousFixture()
    const exact = boxStatsFromColumn(col, cat)
    const oldBoxes = globalDomainBoxes(values, codes, categories)
    const newBoxes = boxStatsFromColumnBinnedPerGroup(values, codes, categories)
    const oldErr = maxPerGroupIqrQuartileError(oldBoxes, exact)
    const newErr = maxPerGroupIqrQuartileError(newBoxes, exact)
    // eslint-disable-next-line no-console
    console.log('[H1] old(global) per-group-IQR err =', oldErr, ' new(per-group) err =', newErr)
    // The global-domain path crushes the narrow groups' bulk into ~one bin → their box is a
    // fixed sliver independent of the true spread → a LARGE per-group-IQR error.
    expect(oldErr).toBeGreaterThan(0.5)
    expect(oldErr).toBeGreaterThan(newErr * 3)
    // The NEW per-group path resolves a real, non-degenerate, strictly-ordered box per group.
    for (const g of [1, 2, 3]) {
      expect(newBoxes[g].q1).toBeLessThan(newBoxes[g].median)
      expect(newBoxes[g].median).toBeLessThan(newBoxes[g].q3)
    }
  })

  it('routes the heavy-tail-WITHIN-a-group case (group 0) to the EXACT oracle', () => {
    const { col, cat, values, codes, categories } = heavyTailHeterogeneousFixture()
    const core = boxStatsFromColumnBinnedPerGroup(values, codes, categories)
    const exact = boxStatsFromColumn(col, cat)
    // Group 0's own [0,10000] histogram would still collapse the bulk → it must fall back to
    // the exact quartiles oracle (byte-identical, incl. the real per-value outlier list).
    expect(core[0]).toEqual(exact[0])
    expect(core[0].outliers).toContain(10000) // the far tail point is a real outlier
  })

  it('degenerate groups (empty / flat / tiny) route to the exact oracle', () => {
    const categories = ['flat', 'tiny', 'empty']
    // flat: 40 identical values; tiny: 2 points; empty: none.
    const vals: number[] = []
    const cds: number[] = []
    for (let i = 0; i < 40; i++) { vals.push(7); cds.push(0) }
    vals.push(1, 100); cds.push(1, 1)
    const values = Float32Array.from(vals)
    const codes = Uint16Array.from(cds)
    const col = sparseFromDense(vals)
    const cat: CategoricalColumn = { codes, categories, length: vals.length }
    const core = boxStatsFromColumnBinnedPerGroup(values, codes, categories)
    const exact = boxStatsFromColumn(col, cat)
    expect(core).toEqual(exact) // every group took the exact path
    expect(core[2]).toEqual({ group: 'empty', q1: 0, median: 0, q3: 0, lowerFence: 0, upperFence: 0, outliers: [] })
  })
})

describe('maxPerGroupIqrQuartileError — per-group-IQR metric (H1)', () => {
  it('identical box sets → 0 error', () => {
    const { col, cat } = heavyTailHeterogeneousFixture()
    const boxes = boxStatsFromColumn(col, cat)
    expect(maxPerGroupIqrQuartileError(boxes, boxes)).toBe(0)
  })

  it('guards IQR==0 (flat group) — no NaN / Infinity', () => {
    const flat = [{ group: 'z', q1: 5, median: 5, q3: 5, lowerFence: 5, upperFence: 5, outliers: [] }]
    // A tiny absolute difference against a zero-IQR group stays finite (guarded denominator).
    const off = [{ group: 'z', q1: 5, median: 5, q3: 5.0000001, lowerFence: 5, upperFence: 5, outliers: [] }]
    const e = maxPerGroupIqrQuartileError(off, flat)
    expect(Number.isFinite(e)).toBe(true)
  })
})

describe('cpuGroupMinMax — per-group extent oracle (H1 domain source)', () => {
  it('per-group finite [min,max]; empty groups keep +Inf / −Inf sentinels', () => {
    const values = Float32Array.from([3, 1, 100, NaN, 50])
    const codes = Uint16Array.from([0, 0, 1, 1, 0])
    const mm = cpuGroupMinMax(values, codes, 3)
    expect(mm.min[0]).toBe(1)
    expect(mm.max[0]).toBe(50)
    expect(mm.min[1]).toBe(100) // NaN skipped
    expect(mm.max[1]).toBe(100)
    expect(mm.min[2]).toBe(Infinity) // empty group → sentinel (min > max)
    expect(mm.max[2]).toBe(-Infinity)
  })
})

// ── Pure mean/SD-from-reduce math (device-free) ──────────────────────────────

describe('meanSdFromReduced — one-pass mean/SD agrees with two-pass meanStd', () => {
  it('matches meanStd within float tolerance on a fixture', () => {
    const g = bucket(VALUES, CODES, 0)
    let sum = 0
    let sumSq = 0
    for (const v of g) {
      sum += v
      sumSq += v * v
    }
    const ms = meanSdFromReduced(sum, sumSq, g.length)
    const ref = meanStd(g)
    expect(ms.mean).toBeCloseTo(ref.mean, 6)
    expect(ms.std).toBeCloseTo(ref.std, 6)
    expect(ms.n).toBe(ref.n)
  })

  it('count 0 → {NaN, NaN, 0}; flat group → std 0 (no NaN from cancellation)', () => {
    expect(meanSdFromReduced(0, 0, 0)).toEqual({ mean: NaN, std: NaN, n: 0 })
    const flat = meanSdFromReduced(5 * 4, 5 * 5 * 4, 4) // four 5s
    expect(flat.mean).toBeCloseTo(5, 6)
    expect(flat.std).toBeCloseTo(0, 6)
  })
})

// ── Pure U-from-histogram math (device-free) ─────────────────────────────────

describe('binApproxMannWhitney — histogram U approximates the exact Mann-Whitney U', () => {
  it('U + p within tolerance of the exact test on a separated fixture', () => {
    const A: number[] = []
    const B: number[] = []
    for (let i = 0; i < 400; i++) {
      A.push((i % 20) * 0.5) // 0..9.5
      B.push(5 + (i % 20) * 0.5) // 5..14.5 (shifted up)
    }
    const lo = 0
    const hi = 15
    const cA = histogramOf(A, lo, hi, 256)
    const cB = histogramOf(B, lo, hi, 256)
    const approx = binApproxMannWhitney(cA, cB)
    const exact = mannWhitneyU(A, B)
    // same test → same order of magnitude U + a matching significant verdict
    expect(Math.abs(approx.u - exact.u) / (exact.u || 1)).toBeLessThan(0.05)
    expect(Math.abs(approx.p - exact.p)).toBeLessThan(0.05)
    // sanity: the shifted groups differ, NOT a t-test (rank-based) — but both agree p is small
    expect(approx.p).toBeLessThan(0.05)
    // guard we did NOT silently become a t-test: a t-test on the same data gives a distinct p
    expect(tTest(A, B).p).not.toBe(approx.p)
  })

  it('empty side → {u:0, p:1}', () => {
    const cA = histogramOf([1, 2, 3], 0, 5, 32)
    const cB = new Array(32).fill(0)
    expect(binApproxMannWhitney(cA, cB)).toEqual({ u: 0, p: 1 })
  })
})

// ── computeDevice (node has no browser device → the fallback branch runs) ─────

describe('computeDevice — node has no compute device (fallback branch is exercised)', () => {
  it('getComputeDevice() resolves null outside a browser', async () => {
    expect(await getComputeDevice()).toBeNull()
  })
})

// ── Parity hook export shapes (the browser harness runs them for real) ────────

describe('verify*Parity — exported async harness hooks', () => {
  it('verifyBoxStatsParity + verifySignificanceParity are async functions', () => {
    expect(typeof verifyBoxStatsParity).toBe('function')
    expect(typeof verifySignificanceParity).toBe('function')
    expect(verifyBoxStatsParity.constructor.name).toBe('AsyncFunction')
    expect(verifySignificanceParity.constructor.name).toBe('AsyncFunction')
  })
})
