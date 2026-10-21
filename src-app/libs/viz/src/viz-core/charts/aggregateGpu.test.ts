import { describe, it, expect } from 'vitest'
import {
  dotplotMatrixGpu,
  heatmapMatrixGpu,
  proportionsGpu,
  barSeriesFromCategoricalGpu,
  histogramGpu,
  verifyAggregateParity,
} from './aggregateGpu'
import { dotplotMatrix, heatmapMatrix } from './aggregate'
import { proportions } from '../data/statsKernels'
import { histogramFromColumn } from './HistogramView'
import { barSeriesFromCategorical } from './BarView'
import { getComputeDevice, computeAvailable } from '../gpu/computeDevice'
import type { CategoricalColumn } from '../data/wire'

// The GPU path only runs in a real browser WebGL2 context (the orchestrator's headless
// harness calls `verifyAggregateParity` there). In node/vitest there is NO compute device
// (`getComputeDevice()` resolves null), so every `*Gpu` variant takes its CPU-FALLBACK
// branch — which calls the ORIGINAL sync oracle. These tests assert that fallback output
// is BYTE-IDENTICAL (deep-equal, exact numbers) to the oracle for each variant. The
// fixtures deliberately use non-f32-representable sums (0.1/0.2/0.3…) so a future refactor
// that routed the fallback through a lossy narrowing would fail here.

// ── Shared fixtures ──────────────────────────────────────────────────────────

function makeColumns(): Map<string, Float32Array> {
  return new Map<string, Float32Array>([
    // sums here are NOT exactly representable in float32 — proves exact-oracle routing.
    ['geneA', new Float32Array([0.1, 0.2, 0.3, 0, 0.7, 0])],
    ['geneB', new Float32Array([0, 0, 5.5, 7.25, -1.5, 4])],
    ['geneC', new Float32Array([-1, -2, -3, 0, 2, 9])],
  ])
}
const CODES = new Uint16Array([0, 1, 0, 2, 1, 0])
const CATEGORIES = ['A', 'B', 'C'] as const

// ── dotplotMatrixGpu ─────────────────────────────────────────────────────────

describe('dotplotMatrixGpu — CPU fallback === dotplotMatrix oracle', () => {
  it('no device → identical DotCell[]', async () => {
    const cols = makeColumns()
    const gpu = await dotplotMatrixGpu(cols, CODES, CATEGORIES)
    const cpu = dotplotMatrix(cols, CODES, CATEGORIES)
    expect(gpu).toEqual(cpu)
  })

  it('explicit device=null forces the CPU oracle', async () => {
    const cols = makeColumns()
    const gpu = await dotplotMatrixGpu(cols, CODES, CATEGORIES, null)
    expect(gpu).toEqual(dotplotMatrix(cols, CODES, CATEGORIES))
  })

  it('preserves column × group order and empty-group zeros', async () => {
    const cols = new Map([['g', new Float32Array([1, 2])]])
    const codes = new Uint16Array([0, 0]) // category B (index 1) is empty
    const gpu = await dotplotMatrixGpu(cols, codes, CATEGORIES)
    expect(gpu).toEqual(dotplotMatrix(cols, codes, CATEGORIES))
    expect(gpu[1]).toEqual({ column: 'g', group: 'B', meanExpr: 0, fractionExpressing: 0 })
  })
})

// ── heatmapMatrixGpu ─────────────────────────────────────────────────────────

describe('heatmapMatrixGpu — CPU fallback === heatmapMatrix oracle', () => {
  it('no device → identical HeatCell[]', async () => {
    const cols = makeColumns()
    const gpu = await heatmapMatrixGpu(cols, CODES, CATEGORIES)
    expect(gpu).toEqual(heatmapMatrix(cols, CODES, CATEGORIES))
  })

  it('explicit device=null forces the CPU oracle', async () => {
    const cols = makeColumns()
    const gpu = await heatmapMatrixGpu(cols, CODES, CATEGORIES, null)
    expect(gpu).toEqual(heatmapMatrix(cols, CODES, CATEGORIES))
  })
})

// ── proportionsGpu ───────────────────────────────────────────────────────────

describe('proportionsGpu — CPU fallback === statsKernels.proportions oracle', () => {
  it('no device → identical proportions', async () => {
    const gpu = await proportionsGpu(CODES, CATEGORIES.length)
    expect(Array.from(gpu)).toEqual(Array.from(proportions(CODES, CATEGORIES.length)))
  })

  it('ignores out-of-range codes exactly like the oracle', async () => {
    const codes = new Uint16Array([0, 9, 1, 0, 5]) // 9,5 dropped
    const gpu = await proportionsGpu(codes, 3, null)
    expect(Array.from(gpu)).toEqual(Array.from(proportions(codes, 3)))
  })

  it('all-empty → all zeros (matches oracle)', async () => {
    const gpu = await proportionsGpu(new Uint16Array([]), 3)
    expect(Array.from(gpu)).toEqual(Array.from(proportions(new Uint16Array([]), 3)))
    expect(Array.from(gpu)).toEqual([0, 0, 0])
  })
})

// ── barSeriesFromCategoricalGpu ──────────────────────────────────────────────

describe('barSeriesFromCategoricalGpu — CPU fallback === barSeriesFromCategorical oracle', () => {
  const cat: CategoricalColumn = { codes: CODES, categories: [...CATEGORIES], length: CODES.length }

  it('no device → identical BarSeries[] (counts, not proportions)', async () => {
    const gpu = await barSeriesFromCategoricalGpu(cat)
    expect(gpu).toEqual(barSeriesFromCategorical(cat))
  })

  it('explicit device=null forces the CPU oracle', async () => {
    const gpu = await barSeriesFromCategoricalGpu(cat, null)
    expect(gpu).toEqual(barSeriesFromCategorical(cat))
  })
})

// ── histogramGpu ─────────────────────────────────────────────────────────────

describe('histogramGpu — CPU fallback === histogramFromColumn oracle', () => {
  it('no device → identical bins/counts', async () => {
    const values = new Float32Array([0.1, 0.2, 0.35, 0.9, 1.0, 0.5, 0.5, 0.75])
    const gpu = await histogramGpu(values, 5)
    expect(gpu).toEqual(histogramFromColumn(values, 5))
  })

  it('default bin count matches the oracle default', async () => {
    const values = new Float32Array([1, 2, 3, 4, 5, 6, 7])
    const gpu = await histogramGpu(values)
    expect(gpu).toEqual(histogramFromColumn(values, undefined))
  })

  it('empty column → empty bins (matches oracle)', async () => {
    const gpu = await histogramGpu(new Float32Array([]), 10, null)
    expect(gpu).toEqual(histogramFromColumn(new Float32Array([]), 10))
    expect(gpu).toEqual({ binEdges: [], counts: [] })
  })

  it('flat column (min===max) → single bin (matches oracle)', async () => {
    const values = new Float32Array([3, 3, 3, 3])
    const gpu = await histogramGpu(values, 8)
    expect(gpu).toEqual(histogramFromColumn(values, 8))
    expect(gpu).toEqual({ binEdges: [3, 4], counts: [4] })
  })
})

// ── computeDevice (node has no browser device) ───────────────────────────────

describe('computeDevice — node environment has no compute device', () => {
  it('getComputeDevice() resolves null outside a browser', async () => {
    expect(await getComputeDevice()).toBeNull()
  })

  it('computeAvailable() is false outside a browser', () => {
    expect(computeAvailable()).toBe(false)
  })
})

// ── parity hook export shape (the browser harness runs it for real) ──────────

describe('verifyAggregateParity — exported async harness hook', () => {
  it('is an async function', () => {
    expect(typeof verifyAggregateParity).toBe('function')
    expect(verifyAggregateParity.constructor.name).toBe('AsyncFunction')
  })
})
