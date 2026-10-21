// violinBody.test.ts — the violin must actually LOOK LIKE A VIOLIN.
//
// REPORTED DEFECT: a violin over a metrics-only frame (four numeric per-cell QC metrics,
// ~2700 rows, no categorical column ⇒ ONE ungrouped distribution) rendered as a box plot.
// The inner Tukey box (`viz-violin-box`) and the jitter dots (`viz-violin-dots`) drew
// normally; the KDE BODY did not.
//
// CAUSE: `kde`'s smoothing width was the fixed constant 0.5 in ABSOLUTE DATA UNITS. For
// log-normalized expression (~[0,6]) that is a sane width; for a raw `total_counts` column
// in the thousands the Epanechnikov kernel's ±0.5 support spans ~0.003% of the value
// range, so essentially no sample falls within a kernel width of any of the 40 grid ticks
// and the density came back 0 at nearly every one. `buildViolinProps` maps density →
// polygon half-width, so an all-zero density collapses the ring onto the group center: an
// invisible body with a fully-drawn box + dots inside it.
//
// The group COUNT was never the variable — the log1p-scale single group below is the
// negative control that renders correctly at BOTH scales.
//
// These tests assert on the rendered GEOMETRY (the `SolidPolygonLayer` ring
// `buildViolinProps` emits), not on an intermediate density, so they also fail for a
// future change that empties the body by some other route.

import { describe, it, expect } from 'vitest'
import {
  linspace,
  resolveKdeBandwidth,
  silvermanBandwidth,
  violinByGroup,
  LEGACY_KDE_BANDWIDTH,
  type ViolinGroup,
} from './aggregate'
import { violinByGroupGpu } from './aggregateGpu'
import { buildViolinProps } from './chartLayers'
import { quartiles } from '../data/statsKernels'
import { violinGroupsFromColumn } from './ViolinView'
import type { CategoricalColumn, SparseColumn } from '../data/wire'

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Deterministic uniform stream (no Math.random — the assertions must be reproducible). */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/**
 * A log-normal per-cell QC metric — the real shape of `total_counts` / `n_genes_by_counts`:
 * unimodal with a heavy right tail (a handful of genuine high-count outliers).
 */
function qcMetric(n: number, median: number, sigma: number, seed = 7): Float32Array {
  const rnd = lcg(seed)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-9, rnd())
    const u2 = rnd()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    out[i] = median * Math.exp(sigma * z)
  }
  return out
}

/** The ONE-group categorical a metrics-only frame yields (`categories: ['All']`). */
function oneGroup(n: number): CategoricalColumn {
  return { codes: new Uint16Array(n), categories: ['All'], length: n }
}

/** Wrap a dense column as the sparse CSC slice the wire decodes into (0 ⇒ absent). */
function sparse(dense: Float32Array): SparseColumn {
  const row: number[] = []
  const value: number[] = []
  for (let i = 0; i < dense.length; i++) {
    if (dense[i] !== 0) {
      row.push(i)
      value.push(dense[i])
    }
  }
  return { row: Uint32Array.from(row), value: Float32Array.from(value), length: dense.length }
}

// ── geometry probes (what the SolidPolygonLayer actually receives) ─────────────

/**
 * The polygon half-width at each KDE tick of group `gi`, as a FRACTION of the widest point
 * of the whole violin layer. `buildViolinProps` emits the ring as [left edge tick 0..N-1,
 * right edge tick N-1..0], so vertex `i` of the left edge is tick `i`.
 */
function bodyProfile(groups: readonly ViolinGroup[], gi = 0): { y: number; width: number }[] {
  const { violin, centers } = buildViolinProps(groups)
  const ring = violin.data[gi].polygon
  const cx = centers[gi]
  const ticks = groups[gi].density.length
  let widest = 0
  violin.data.forEach((r, i) => {
    for (const [x] of r.polygon) widest = Math.max(widest, Math.abs(x - centers[i]))
  })
  const out: { y: number; width: number }[] = []
  for (let i = 0; i < ticks; i++) {
    const [x, y] = ring[i]
    out.push({ y, width: widest > 0 ? Math.abs(x - cx) / widest : 0 })
  }
  return out
}

/** Peak-normalized density curve — the SILHOUETTE, independent of the value scale. */
function silhouette(g: ViolinGroup): number[] {
  const peak = g.density.reduce((m, d) => Math.max(m, d.density), 0) || 1
  return g.density.map(d => d.density / peak)
}

// ── THE DEFECT: a violin over a raw QC metric has no body ─────────────────────

describe('violin body over a single ungrouped QC-metric column', () => {
  const N = 2700
  const values = qcMetric(N, 4000, 0.6) // `total_counts`: hundreds → tens of thousands
  const cat = oneGroup(N)

  it('renders a body across the interquartile range, not a spike comb', () => {
    const groups = violinGroupsFromColumn(sparse(values), cat)
    const q = quartiles(values)
    const profile = bodyProfile(groups)
    const inIqr = profile.filter(p => p.y >= q.q1 && p.y <= q.q3)

    // The IQR is where half the cells live — the widest part of any violin. Sampling it at
    // 40 ticks over the column's range must land several ticks inside it.
    expect(inIqr.length).toBeGreaterThanOrEqual(4)
    // EVERY one of them must carry real width. Pre-fix this was 0 of them (the density was
    // 0 at every in-frame tick), so the ring collapsed onto the group center.
    for (const p of inIqr) {
      expect(p.width).toBeGreaterThan(0.1)
    }
  })

  it('is a CONNECTED outline between the whiskers, with a single clear mode', () => {
    // Continuity is asserted over the non-outlier region the box's whiskers span. Past the
    // upper fence a genuine density GAP is correct (a handful of far outliers really do sit
    // in otherwise-empty value space), so a global no-zero-tick claim would be false.
    const groups = violinGroupsFromColumn(sparse(values), cat)
    const q = quartiles(values)
    const inFence = bodyProfile(groups).filter(p => p.y >= q.lowerFence && p.y <= q.upperFence)
    expect(inFence.length).toBeGreaterThanOrEqual(8)
    // A comb is "wide, zero, wide, zero…"; a body is an unbroken run of width.
    for (const p of inFence) expect(p.width).toBeGreaterThan(0)
    // …and it swells to a mode rather than being a uniformly thin ribbon.
    expect(Math.max(...inFence.map(p => p.width))).toBeGreaterThan(0.5)
  })

  it('the body is wider than the inner Tukey box it contains', () => {
    // The box is drawn at width 0.06 (half-width 0.03) by ViolinView; the violin's own
    // half-width is 0.4. The reported symptom was exactly this inequality inverting —
    // the box visible, the body not.
    const groups = violinGroupsFromColumn(sparse(values), cat)
    const { violin, centers } = buildViolinProps(groups)
    const maxHalf = Math.max(...violin.data[0].polygon.map(([x]) => Math.abs(x - centers[0])))
    expect(maxHalf).toBeGreaterThan(0.03)
  })
})

// ── the invariant behind the fix: the silhouette is SCALE-FREE ────────────────

describe('violin silhouette is invariant to the value scale', () => {
  // The same distribution measured in different units (expression-scale vs count-scale) is
  // the SAME distribution and must draw the SAME violin. A smoothing width fixed in
  // absolute data units cannot satisfy this — that is precisely the defect.
  // ×1024 is exact in float32, so the comparison is not fighting rounding.
  const N = 2700
  const base = qcMetric(N, 3, 0.5)
  const scaled = Float32Array.from(base, v => v * 1024)
  const codes = new Uint16Array(N)
  const cats = ['All']

  it('a ×1024 rescale reproduces the same peak-normalized outline', () => {
    const a = silhouette(violinByGroup(base, codes, cats)[0])
    const b = silhouette(violinByGroup(scaled, codes, cats)[0])
    expect(b).toHaveLength(a.length)
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBeCloseTo(a[i], 6)
    }
  })

  it('and the grid it is sampled on rescales with it', () => {
    const a = violinByGroup(base, codes, cats)[0].density.map(d => d.x)
    const b = violinByGroup(scaled, codes, cats)[0].density.map(d => d.x)
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBeCloseTo(a[i] * 1024, 3)
    }
  })
})

// ── negative controls: the fix must not flatten what already worked ───────────

describe('violin still separates groups (no over-smoothing)', () => {
  it('two count-scale groups keep DISTINCT peak locations', () => {
    const N = 2000
    const values = new Float32Array(N)
    const codes = new Uint16Array(N)
    const lowGroup = qcMetric(N / 2, 1200, 0.25, 11)
    const highGroup = qcMetric(N / 2, 9000, 0.25, 13)
    for (let i = 0; i < N / 2; i++) {
      values[i] = lowGroup[i]
      codes[i] = 0
      values[i + N / 2] = highGroup[i]
      codes[i + N / 2] = 1
    }
    const groups = violinByGroup(values, codes, ['low', 'high'])
    const peakX = (g: ViolinGroup) => g.density.reduce((b, d) => (d.density > b.density ? d : b)).x
    expect(peakX(groups[0])).toBeLessThan(peakX(groups[1]))
    // …and BOTH bodies are drawn (the earlier bug would have emptied both).
    const [gLow, gHigh] = [bodyProfile(groups, 0), bodyProfile(groups, 1)]
    expect(Math.max(...gLow.map(p => p.width))).toBeGreaterThan(0.2)
    expect(Math.max(...gHigh.map(p => p.width))).toBeGreaterThan(0.2)
  })

  it('an expression-scale single group (which always worked) still renders a body', () => {
    const N = 2700
    const values = qcMetric(N, 1.5, 0.5, 3) // log1p-scale — the pre-existing happy path
    const groups = violinByGroup(values, new Uint16Array(N), ['All'])
    const q = quartiles(values)
    for (const p of bodyProfile(groups).filter(p => p.y >= q.q1 && p.y <= q.q3)) {
      expect(p.width).toBeGreaterThan(0.1)
    }
  })
})

// ── the bandwidth rule itself ─────────────────────────────────────────────────

describe('resolveKdeBandwidth', () => {
  const grid = linspace(0, 40, 41) // step 1

  it('honors an EXPLICIT bandwidth verbatim, however small', () => {
    // The GPU parity harness and the windowed-KDE callers pass explicit widths; they must
    // reach `kde` untouched (no floor, no rescale).
    expect(resolveKdeBandwidth(new Float32Array([1000, 2000, 3000]), grid, 0.6)).toBe(0.6)
    expect(resolveKdeBandwidth(new Float32Array([1, 2, 3]), grid, 0)).toBe(0)
  })

  it('scales the default with the data spread', () => {
    const small = silvermanBandwidth(qcMetric(1000, 3, 0.5, 5))
    const large = silvermanBandwidth(Float32Array.from(qcMetric(1000, 3, 0.5, 5), v => v * 1024))
    expect(large / small).toBeCloseTo(1024, 3)
  })

  it('floors the default at one grid step (a KDE cannot resolve below its sampling)', () => {
    // A tight core plus one far outlier stretches the grid until the ticks out-run a
    // Silverman width — the milder form of the same aliasing failure.
    const tight = new Float32Array(500)
    for (let i = 0; i < tight.length; i++) tight[i] = 1 + (i % 7) * 0.01
    tight[0] = 400 // the outlier that stretches the grid
    const wide = linspace(0, 400, 41) // step 10
    expect(silvermanBandwidth(tight)).toBeLessThan(10)
    expect(resolveKdeBandwidth(tight, wide)).toBeCloseTo(10, 9)
  })

  it('falls back to the legacy constant for a degenerate column (empty / single / flat)', () => {
    expect(silvermanBandwidth(new Float32Array([]))).toBe(LEGACY_KDE_BANDWIDTH)
    expect(silvermanBandwidth(new Float32Array([7]))).toBe(LEGACY_KDE_BANDWIDTH)
    expect(silvermanBandwidth(new Float32Array([7, 7, 7, 7]))).toBe(LEGACY_KDE_BANDWIDTH)
    expect(silvermanBandwidth(new Float32Array([Number.NaN, Infinity]))).toBe(LEGACY_KDE_BANDWIDTH)
  })
})

// ── the degenerate contracts the views rely on are unchanged ──────────────────

describe('violinByGroup degenerate contracts (unchanged by the bandwidth rule)', () => {
  it('an empty group still yields an all-zero density of the right length', () => {
    const values = qcMetric(200, 5000, 0.4, 17)
    const codes = new Uint16Array(200) // every point in group 0; group 1 is empty
    const groups = violinByGroup(values, codes, ['full', 'empty'], { ticks: 12 })
    expect(groups[1].density).toHaveLength(12)
    expect(groups[1].density.every(d => d.density === 0)).toBe(true)
  })

  it('a flat column produces finite, non-negative densities (no NaN geometry)', () => {
    const flat = new Float32Array(50).fill(3000)
    const groups = violinByGroup(flat, new Uint16Array(50), ['All'])
    for (const d of groups[0].density) {
      expect(Number.isFinite(d.density)).toBe(true)
      expect(d.density).toBeGreaterThanOrEqual(0)
    }
  })

  it('NaNs do not leak into the bandwidth or the densities', () => {
    const withNan = Float32Array.from(qcMetric(300, 4000, 0.5, 23))
    withNan[5] = Number.NaN
    withNan[9] = Number.NaN
    expect(Number.isFinite(silvermanBandwidth(withNan))).toBe(true)
    const groups = violinByGroup(withNan, new Uint16Array(300), ['All'])
    for (const d of groups[0].density) expect(Number.isFinite(d.density)).toBe(true)
  })
})

// ── the GPU variant's node fallback keeps agreeing with the oracle ────────────

describe('violinByGroupGpu CPU-fallback with the DEFAULT bandwidth', () => {
  // In node there is no compute device, so this exercises the fallback branch only — it
  // proves the default-bandwidth oracle call is intact, NOT the GPU binned-KDE branch
  // (that one is proven in the browser by `verifyViolinParity`). Both branches read the
  // same `resolveKdeBandwidth`, which is what keeps them from drifting.
  it('equals violinByGroup for a count-scale column with no bandwidth given', async () => {
    const values = qcMetric(800, 6000, 0.5, 29)
    const codes = new Uint16Array(800)
    const gpu = await violinByGroupGpu(values, codes, ['All'], {}, null)
    expect(gpu).toEqual(violinByGroup(values, codes, ['All'], {}))
    // and it is a real body, not the empty ring the defect produced
    expect(Math.max(...gpu[0].density.map(d => d.density))).toBeGreaterThan(0)
    expect(gpu[0].density.filter(d => d.density > 0).length).toBeGreaterThan(20)
  })
})
