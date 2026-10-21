import { describe, it, expect } from 'vitest'
import { max as d3max } from 'd3-array'
import {
  violinByGroupGpu,
  smoothedDensityGpu,
  binDomain,
  violinCompositeCodes,
  densityRowFromCounts,
  violinFromReducedCounts,
  verifyViolinParity,
  type BinDomain,
} from './aggregateGpu'
import { violinByGroup, epanechnikov, linspace } from './aggregate'
import { smoothedDensity } from '../data/statsKernels'
import { cpuGroupReduce } from '../gpu/groupReduce'

// The GPU 2-D-histogram violin path only runs in a real browser WebGL2 context (the
// orchestrator's headless harness calls `verifyViolinParity` there). In node/vitest there
// is NO compute device, so `violinByGroupGpu` / `smoothedDensityGpu` take their CPU-FALLBACK
// branch — which calls the ORIGINAL sync oracle (`violinByGroup` / `smoothedDensity`), so
// the result is BYTE-IDENTICAL to the oracle. Separately, the PURE composite-code +
// smoothing helpers are unit-tested directly, and a device-free "GPU math" reconstruction
// (compose codes → cpuGroupReduce → reshape+smooth) is compared to the direct-KDE oracle
// within the documented SHAPE tolerance (the binned-KDE approximation is close, not exact).

// ── Shared fixtures ──────────────────────────────────────────────────────────

// sums/values here are NOT exactly representable in float32 — proves exact-oracle routing.
const VALUES = new Float32Array([0.1, 2.2, 0.3, 5.7, 1.4, 6.9, 3.3, 0.8, 4.1, 2.5])
const CODES = new Uint16Array([0, 1, 0, 2, 1, 2, 0, 1, 2, 0])
const CATEGORIES = ['A', 'B', 'C'] as const

// ── CPU fallback === oracle (byte-exact) ─────────────────────────────────────

describe('violinByGroupGpu — CPU fallback === violinByGroup oracle', () => {
  it('no device → identical ViolinGroup[]', async () => {
    const gpu = await violinByGroupGpu(VALUES, CODES, CATEGORIES, { ticks: 24, bandwidth: 0.6 })
    const cpu = violinByGroup(VALUES, CODES, CATEGORIES, { ticks: 24, bandwidth: 0.6 })
    expect(gpu).toEqual(cpu)
  })

  it('explicit device=null forces the CPU oracle', async () => {
    const gpu = await violinByGroupGpu(VALUES, CODES, CATEGORIES, { ticks: 40 }, null)
    expect(gpu).toEqual(violinByGroup(VALUES, CODES, CATEGORIES, { ticks: 40 }))
  })

  it('default ticks/bandwidth match the oracle defaults', async () => {
    const gpu = await violinByGroupGpu(VALUES, CODES, CATEGORIES, {}, null)
    expect(gpu).toEqual(violinByGroup(VALUES, CODES, CATEGORIES, {}))
  })

  it('binCount is irrelevant on the CPU fallback (still the exact oracle)', async () => {
    const gpu = await violinByGroupGpu(VALUES, CODES, CATEGORIES, { binCount: 999999 }, null)
    expect(gpu).toEqual(violinByGroup(VALUES, CODES, CATEGORIES, {}))
  })

  it('empty column → per-group all-zero densities (matches oracle)', async () => {
    const gpu = await violinByGroupGpu(new Float32Array([]), new Uint16Array([]), CATEGORIES, {}, null)
    expect(gpu).toEqual(violinByGroup(new Float32Array([]), new Uint16Array([]), CATEGORIES, {}))
  })
})

describe('smoothedDensityGpu — CPU fallback === smoothedDensity oracle', () => {
  it('no device → identical DensityPoint[]', async () => {
    const gpu = await smoothedDensityGpu(VALUES, { ticks: 30, bandwidth: 0.7 })
    expect(gpu).toEqual(smoothedDensity(VALUES, 30, 0.7))
  })

  it('default ticks/bandwidth match the oracle defaults', async () => {
    const gpu = await smoothedDensityGpu(VALUES, {}, null)
    expect(gpu).toEqual(smoothedDensity(VALUES, 40, 0.5))
  })

  it('empty column → empty curve (matches oracle)', async () => {
    const gpu = await smoothedDensityGpu(new Float32Array([]), {}, null)
    expect(gpu).toEqual(smoothedDensity(new Float32Array([]), 40, 0.5))
    expect(gpu).toEqual([])
  })
})

// ── binDomain ────────────────────────────────────────────────────────────────

describe('binDomain — uniform value binning domain', () => {
  it('computes a correct uniform binWidth', () => {
    expect(binDomain(0, 4, 4)).toEqual({ lo: 0, hi: 4, binWidth: 1, binCount: 4 })
    expect(binDomain(-2, 2, 8)).toEqual({ lo: -2, hi: 2, binWidth: 0.5, binCount: 8 })
  })

  it('floors a fractional binCount', () => {
    expect(binDomain(0, 10, 4.9)).toEqual({ lo: 0, hi: 10, binWidth: 2.5, binCount: 4 })
  })

  it('returns null for a degenerate span (flat / inverted / non-finite)', () => {
    expect(binDomain(3, 3, 4)).toBeNull()
    expect(binDomain(5, 1, 4)).toBeNull()
    expect(binDomain(0, Number.NaN, 4)).toBeNull()
    expect(binDomain(0, Infinity, 4)).toBeNull()
  })
})

// ── violinCompositeCodes — the composite-code bucketing math ──────────────────

describe('violinCompositeCodes — group*binCount + valueBin, clamped + culled', () => {
  const dom: BinDomain = binDomain(0, 4, 4)!

  it('buckets each point into the right composite code, clamps out-of-range values', () => {
    const values = new Float32Array([0.5, 2.5, -1, 100, Number.NaN, 5])
    const codes = new Uint16Array([0, 1, 0, 2, 0, 9])
    // b0=0, b1=floor(2.5)=2→6, b2=floor(-1)→clamp0, b3=floor(100)→clamp3→11,
    // b4=NaN→sentinel(3*4=12), b5=group9(≥3)→sentinel(12)
    expect([...violinCompositeCodes(values, codes, 3, dom)]).toEqual([0, 6, 0, 11, 12, 12])
  })

  it('clamps a value exactly at hi into the last bin (not an extra bin)', () => {
    // v == hi → floor((hi-lo)/w) == binCount → clamped to binCount-1
    const codes = new Uint16Array([0])
    expect([...violinCompositeCodes(new Float32Array([4]), codes, 1, dom)]).toEqual([3])
  })

  it('the cull sentinel equals nGroups*binCount (so groupReduce drops it)', () => {
    const nGroups = 3
    const sentinel = nGroups * dom.binCount
    const codes = new Uint16Array([nGroups]) // out-of-range group
    expect([...violinCompositeCodes(new Float32Array([1]), codes, nGroups, dom)]).toEqual([sentinel])
    // cpuGroupReduce over nGroups*binCount buckets must ignore the sentinel entirely.
    const counts = cpuGroupReduce(new Float32Array([0]), new Uint16Array([sentinel]), sentinel).count
    expect([...counts].reduce((a, b) => a + b, 0)).toBe(0)
  })
})

// ── densityRowFromCounts — Epanechnikov smoothing of one bin row ──────────────

describe('densityRowFromCounts — binned-KDE smoothing', () => {
  const dom: BinDomain = binDomain(0, 4, 4)! // centers at 0.5, 1.5, 2.5, 3.5

  it('empty group (n=0) → all-zero density', () => {
    const out = densityRowFromCounts([0, 0, 0, 0], dom, linspace(0, 4, 5), 1)
    expect(out.map(d => d.density)).toEqual([0, 0, 0, 0, 0])
  })

  it('a single populated bin gives the normalized kernel value at its center', () => {
    // one bin (center 1.5) with count 2, n=2, bandwidth 1 → density(1.5) = K(0) = 0.75.
    const out = densityRowFromCounts([0, 2, 0, 0], dom, [1.5], 1)
    expect(out).toHaveLength(1)
    expect(out[0].x).toBe(1.5)
    expect(out[0].density).toBeCloseTo(epanechnikov(1)(0), 12) // 0.75
  })

  it('normalizes by the TOTAL group count (a doubled row is identical after normalizing)', () => {
    const grid = linspace(0, 4, 9)
    const a = densityRowFromCounts([1, 3, 0, 2], dom, grid, 0.9)
    const b = densityRowFromCounts([2, 6, 0, 4], dom, grid, 0.9)
    for (let i = 0; i < grid.length; i++) expect(b[i].density).toBeCloseTo(a[i].density, 12)
  })
})

// ── violinFromReducedCounts — reshape flat counts → per-group violins ─────────

describe('violinFromReducedCounts — reshape + smooth', () => {
  const dom: BinDomain = binDomain(0, 4, 2)! // 2 bins, centers 1, 3

  it('preserves category order and slices the right bin row per group', () => {
    // group A → bins [5,0] (mass at center 1); group B → bins [0,3] (mass at center 3).
    const counts = new Float32Array([5, 0, 0, 3])
    const grid = linspace(0, 4, 40)
    const out = violinFromReducedCounts(counts, ['A', 'B'], dom, grid, 0.8)
    expect(out.map(g => g.group)).toEqual(['A', 'B'])
    expect(out[0].density).toHaveLength(grid.length)
    // A peaks near x=1, B peaks near x=3 → distinct silhouettes from distinct bin rows.
    const peakX = (curve: { x: number; density: number }[]) =>
      curve.reduce((best, d) => (d.density > best.density ? d : best)).x
    expect(peakX(out[0].density)).toBeLessThan(peakX(out[1].density))
  })
})

// ── device-free GPU-math parity: binned-KDE ≈ direct-KDE within tolerance ─────

describe('GPU-branch math (compose → reduce → smooth) ≈ direct-KDE oracle', () => {
  // Reconstruct EXACTLY what violinByGroupGpu's GPU branch computes, but drive the
  // reduction through the CPU oracle `cpuGroupReduce` (the byte-exact stand-in for the GPU
  // groupReduce). Then compare the resulting violin to the direct-KDE oracle within the
  // documented SHAPE tolerance. This proves the composite-code bucketing + smoothing math
  // is correct without needing a WebGL device.
  const SHAPE_TOL = 0.15 // peak-normalized max abs error (matches verifyViolinParity)
  const PEAK_TICK_TOL = 2

  // Deterministic PEAKED offset (mode at 0) so per-group argmax is unambiguous.
  const peakedOffset = (r: number) => (r < 50 ? 0 : r < 72 ? 0.5 : r < 90 ? -0.5 : r < 97 ? 1 : -1)

  function buildFixture() {
    const n = 900
    const categories = ['low', 'mid', 'high']
    const nGroups = categories.length
    const codes = new Uint16Array(n)
    const values = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const g = i % nGroups
      codes[i] = g
      values[i] = g * 4 + 2 + peakedOffset((i * 13) % 100) // sharp modes at 2 / 6 / 10
    }
    return { categories, nGroups, codes, values }
  }

  it('per-group peak-normalized curves + peak locations agree within tolerance', () => {
    const { categories, nGroups, codes, values } = buildFixture()
    const ticks = 40
    const bandwidth = 0.8
    const binCount = 128 // the violinByGroupGpu default; binned-KDE ≈ direct-KDE at this width

    // ---- GPU-branch math (device-free) ----
    const hi = d3max(values) ?? 1
    let lo = Infinity
    for (const v of values) if (Number.isFinite(v) && v < lo) lo = v
    const dom = binDomain(lo, hi, binCount)!
    const grid = linspace(0, hi, ticks)
    const composite = violinCompositeCodes(values, codes, nGroups, dom)
    const counts = cpuGroupReduce(new Float32Array(composite.length), composite, nGroups * binCount).count
    const gpuish = violinFromReducedCounts(counts, categories, dom, grid, bandwidth)

    // ---- direct-KDE oracle ----
    const cpu = violinByGroup(values, codes, categories, { ticks, bandwidth })

    const peakTick = (curve: { density: number }[]) => {
      let best = -1
      let bestV = 0
      curve.forEach((d, i) => {
        if (d.density > bestV) {
          bestV = d.density
          best = i
        }
      })
      return best
    }

    let maxShapeError = 0
    let maxPeakOffset = 0
    for (let g = 0; g < cpu.length; g++) {
      const gc = gpuish[g].density
      const cc = cpu[g].density
      const gPeak = gc.reduce((m, d) => Math.max(m, d.density), 0) || 1
      const cPeak = cc.reduce((m, d) => Math.max(m, d.density), 0) || 1
      for (let i = 0; i < cc.length; i++) {
        maxShapeError = Math.max(maxShapeError, Math.abs(gc[i].density / gPeak - cc[i].density / cPeak))
      }
      maxPeakOffset = Math.max(maxPeakOffset, Math.abs(peakTick(gc) - peakTick(cc)))
    }

    expect(maxShapeError).toBeLessThanOrEqual(SHAPE_TOL)
    expect(maxPeakOffset).toBeLessThanOrEqual(PEAK_TICK_TOL)
  })
})

// ── parity hook export shape (the browser harness runs it for real) ──────────

describe('verifyViolinParity — exported async harness hook', () => {
  it('is an async function', () => {
    expect(typeof verifyViolinParity).toBe('function')
    expect(verifyViolinParity.constructor.name).toBe('AsyncFunction')
  })
})
