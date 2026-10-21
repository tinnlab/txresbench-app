// aggregateGpu.ts — GPU-backed variants of the per-point chart aggregations (DEC-26/29).
// The sync functions in `aggregate.ts` / `statsKernels.ts` / the view helpers each loop
// over ALL N points on the CPU; these variants push that O(N) reduction onto the GPU via
// the VERIFIED `gpu/groupReduce.ts` primitive (byte-exact vs its CPU oracle under
// swiftshader), and fall back to the ORIGINAL CPU function when no compute device exists.
//
// THE FALLBACK IS THE ORACLE ITSELF (not a re-derivation): when there is no device, each
// `*Gpu` function calls the exact same sync function the view used before, so the result
// is BYTE-IDENTICAL in node/vitest (where `getComputeDevice()` returns null). The GPU
// branch reconstructs the identical output shape from the group-reduce channels; that
// branch's numeric parity is proven separately in the browser via `verifyAggregateParity`
// (DEC-27: GPU behavior is proven by running it, with a float32-accumulation tolerance).
//
// Shape mapping (all reuse the same segmented reduction { sum, nonzero, count } per group):
//   • dotplot / heatmap → one reduction per value column; mean = sum/count,
//     fraction = nonzero/count.
//   • proportions / bar counts → the `count` channel (points per group) / total.
//   • histogram → bin each value to a code, then the `count` channel per bin.

import type { Device } from '@luma.gl/core'
import {
  runGroupReduceOnDevice,
  runGroupReduceMultiOnDevice,
  deviceSupportsGroupReduce,
  type GroupReduceResult,
} from '../gpu/groupReduce'
import { getComputeDevice } from '../gpu/computeDevice'
import { max as d3max } from 'd3-array'
import {
  dotplotMatrix,
  heatmapMatrix,
  violinByGroup,
  epanechnikov,
  linspace,
  resolveKdeBandwidth,
  type DotCell,
  type HeatCell,
  type ViolinGroup,
  type DensityPoint,
} from './aggregate'
import { proportions, smoothedDensity } from '../data/statsKernels'
import { histogramFromColumn, type Histogram } from './HistogramView'
import { barSeriesFromCategorical } from './BarView'
import type { BarSeries } from './chartLayers'
import type { CategoricalColumn } from '../data/wire'

// ── Device resolution ────────────────────────────────────────────────────────

/**
 * Resolve the compute device to use: an explicitly-passed device (which MAY be `null` to
 * force the CPU path) wins; otherwise the shared lazy singleton. Returns a device only
 * when it is present AND can actually run the group-reduce (float32 render + blend);
 * anything else → `null` → the caller runs the CPU oracle.
 */
async function usableDevice(device?: Device | null): Promise<Device | null> {
  const dev = device === undefined ? await getComputeDevice() : device
  if (dev && deviceSupportsGroupReduce(dev)) return dev
  return null
}

// ── Dotplot (columns × groups: mean expression + fraction expressing) ─────────

/**
 * GPU variant of `dotplotMatrix`. One group-reduction per value column (shared codes),
 * then mean = sum/count and fraction = nonzero/count per (column, group). Falls back to
 * the exact `dotplotMatrix` oracle when no device is available.
 */
export async function dotplotMatrixGpu(
  columns: ReadonlyMap<string, Float32Array>,
  codes: Uint16Array,
  categories: readonly string[],
  device?: Device | null,
): Promise<DotCell[]> {
  const dev = await usableDevice(device)
  if (!dev) return dotplotMatrix(columns, codes, categories)

  const names = [...columns.keys()]
  const valueColumns = [...columns.values()]
  const results = await runGroupReduceMultiOnDevice(dev, valueColumns, codes, categories.length)
  return dotCellsFromReductions(names, categories, results)
}

/** Build the `DotCell[]` (same order/shape as `dotplotMatrix`) from per-column reductions. */
function dotCellsFromReductions(
  names: readonly string[],
  categories: readonly string[],
  results: readonly GroupReduceResult[],
): DotCell[] {
  const out: DotCell[] = []
  for (let ci = 0; ci < names.length; ci++) {
    const r = results[ci]
    for (let g = 0; g < categories.length; g++) {
      const cnt = r.count[g]
      out.push({
        column: names[ci],
        group: categories[g],
        meanExpr: cnt > 0 ? r.sum[g] / cnt : 0,
        fractionExpressing: cnt > 0 ? r.nonzero[g] / cnt : 0,
      })
    }
  }
  return out
}

// ── Heatmap (columns × groups mean-expression matrix) ─────────────────────────

/**
 * GPU variant of `heatmapMatrix` (the dotplot means, projected to `{column, group,
 * value}`). Reuses the dotplot reduction; falls back to the exact `heatmapMatrix` oracle.
 */
export async function heatmapMatrixGpu(
  columns: ReadonlyMap<string, Float32Array>,
  codes: Uint16Array,
  categories: readonly string[],
  device?: Device | null,
): Promise<HeatCell[]> {
  const dev = await usableDevice(device)
  if (!dev) return heatmapMatrix(columns, codes, categories)

  const cells = await dotplotMatrixGpu(columns, codes, categories, dev)
  return cells.map(d => ({ column: d.column, group: d.group, value: d.meanExpr }))
}

// ── Proportions (fraction of points per category) ─────────────────────────────

/**
 * GPU variant of `statsKernels.proportions`: per-category count / total. Uses the
 * `count` channel of a single group-reduction (the value column is irrelevant to
 * counting). Falls back to the exact `proportions` oracle when no device.
 */
export async function proportionsGpu(
  codes: Uint16Array,
  nCategories: number,
  device?: Device | null,
): Promise<Float32Array> {
  const dev = await usableDevice(device)
  if (!dev) return proportions(codes, nCategories)

  const counts = await categoryCountsOnDevice(dev, codes, nCategories)
  const out = new Float32Array(Math.max(0, nCategories))
  let total = 0
  for (let c = 0; c < out.length; c++) total += counts[c]
  if (total > 0) {
    for (let c = 0; c < out.length; c++) out[c] = counts[c] / total
  }
  return out
}

// ── Bar counts (per-category point counts — BarView's aggregation) ────────────

/**
 * GPU variant of `barSeriesFromCategorical` (per-category COUNT bars). BarView renders
 * raw counts, so this returns counts (the reduction's `count` channel), not proportions —
 * keeping bar heights identical to the CPU path. Falls back to the exact
 * `barSeriesFromCategorical` oracle when no device.
 */
export async function barSeriesFromCategoricalGpu(
  cat: CategoricalColumn,
  device?: Device | null,
): Promise<BarSeries[]> {
  const dev = await usableDevice(device)
  if (!dev) return barSeriesFromCategorical(cat)

  const counts = await categoryCountsOnDevice(dev, cat.codes, cat.categories.length)
  return cat.categories.map((category, i) => ({ category, values: [counts[i]] }))
}

/** Per-group point counts via the reduction's `count` channel (value column unused). */
async function categoryCountsOnDevice(
  dev: Device,
  codes: Uint16Array,
  nGroups: number,
): Promise<Float32Array> {
  const values = new Float32Array(codes.length) // counting ignores values
  const r = await runGroupReduceOnDevice(dev, { values, codes, nGroups })
  return r.count
}

// ── Histogram (uniform-width bin counts of a continuous column) ────────────────

/**
 * GPU variant of `HistogramView.histogramFromColumn`. Computes min/max on the CPU (a
 * trivial O(N) scan the same oracle already does), maps each value to a bin code, then
 * uses the group-reduce `count` channel per bin. Falls back to the exact
 * `histogramFromColumn` oracle when no device. Degenerate cases (empty / flat column)
 * match the oracle exactly.
 */
export async function histogramGpu(
  values: Float32Array,
  binCount?: number,
  device?: Device | null,
): Promise<Histogram> {
  const dev = await usableDevice(device)
  if (!dev) return histogramFromColumn(values, binCount)

  const nBins = Math.max(1, Math.floor(binCount ?? 30))
  let lo = Infinity
  let hi = -Infinity
  let count = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
    count++
  }
  if (count === 0) return { binEdges: [], counts: [] }
  if (lo === hi) return { binEdges: [lo, lo + 1], counts: [count] }

  const width = (hi - lo) / nBins
  const binEdges = Array.from({ length: nBins + 1 }, (_, i) => lo + i * width)

  // Map each value to its bin code; non-finite → out-of-range code (clip-culled).
  const codes = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) {
      codes[i] = nBins // out of [0,nBins) → dropped, mirrors the oracle's skip
      continue
    }
    codes[i] = Math.min(nBins - 1, Math.floor((v - lo) / width))
  }
  const counts = await categoryCountsOnDevice(dev, codes, nBins)
  return { binEdges, counts: Array.from(counts) }
}

// ── Violin / 1-D density (per-group KDE as a GPU 2-D histogram → CPU smooth) ───
//
// The CPU oracle (`aggregate.violinByGroup` / `statsKernels.smoothedDensity`) is an
// O(ticks×N) direct KDE: for every grid tick it sums the Epanechnikov kernel over ALL N
// values in the group. This variant moves the O(N) part onto the VERIFIED `groupReduce`
// primitive as a 2-D histogram: each point is bucketed by a COMPOSITE code
// `group*binCount + valueBin` (valueBin = floor((v−lo)/binWidth), clamped), so ONE
// group-reduction over `nGroups*binCount` buckets yields per-(group,bin) COUNTS via the
// `count` channel. The Epanechnikov smoothing then runs over the tiny nGroups×binCount
// count grid (hundreds of cells — CPU-fine per DEC-29): the classic BINNED-KDE
// approximation `density(x) ≈ (1/n) Σ_bin count·K(x − center_bin)`, which converges to
// the direct KDE as `binCount` grows. Because it BINS-then-smooths (vs the oracle's
// direct KDE), the two are close but NOT byte-exact — see `verifyViolinParity` for the
// documented shape tolerance. As always: no device → the exact CPU oracle (byte-exact).

/**
 * Default number of value bins for the GPU histogram. The binned-KDE converges to the
 * direct KDE as bins grow (measured peak-normalized shape error vs the CPU oracle on a
 * sharply-peaked fixture: 64→0.16, 128→0.07, 256→0.03); 128 sits well inside the 0.15
 * `verifyViolinParity` tolerance while staying tiny (128×nGroups buckets — hundreds).
 */
const VIOLIN_BIN_COUNT = 128
/** groupReduce codes are Uint16; the composite `group*binCount+bin` must stay in range. */
const MAX_COMPOSITE = 0xffff

/** The uniform-width value binning domain shared by the composite-code + smoothing steps. */
export interface BinDomain {
  readonly lo: number
  readonly hi: number
  readonly binWidth: number
  readonly binCount: number
}

/**
 * Build a `BinDomain` over `[lo,hi]` with `binCount` uniform bins, or `null` when the
 * span is degenerate (empty / flat / non-finite) — the caller then runs the CPU oracle.
 */
export function binDomain(lo: number, hi: number, binCount: number): BinDomain | null {
  const n = Math.max(1, Math.floor(binCount))
  const binWidth = (hi - lo) / n
  if (!(binWidth > 0) || !Number.isFinite(binWidth)) return null
  return { lo, hi, binWidth, binCount: n }
}

/** Finite minimum of a value column (mirrors `d3max`'s NaN-skipping for the max). */
function finiteMin(values: ArrayLike<number>): number {
  let lo = Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v < lo) lo = v
  }
  return lo
}

/**
 * Composite per-point codes `group*binCount + valueBin` for the 2-D histogram, where
 * `valueBin = clamp(floor((v−lo)/binWidth), 0, binCount−1)`. Out-of-range group codes and
 * non-finite values are mapped to the sentinel `nGroups*binCount` so `groupReduce` culls
 * them (matching the CPU oracle's skip). Pure + device-free → directly unit-testable.
 */
export function violinCompositeCodes(
  values: ArrayLike<number>,
  codes: ArrayLike<number>,
  nGroups: number,
  dom: BinDomain,
): Uint16Array {
  const n = Math.min(values.length, codes.length)
  const total = nGroups * dom.binCount // the cull sentinel (== nGroups → culled)
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const g = codes[i]
    const v = values[i]
    if (g < 0 || g >= nGroups || !Number.isFinite(v)) {
      out[i] = total
      continue
    }
    let b = Math.floor((v - dom.lo) / dom.binWidth)
    if (b < 0) b = 0
    else if (b >= dom.binCount) b = dom.binCount - 1
    out[i] = g * dom.binCount + b
  }
  return out
}

/**
 * Epanechnikov-smooth ONE group's bin-count row onto the `grid`: the binned-KDE
 * `density(x) = (1/n) Σ_bin count·K(x − center_bin)` with `center_bin = lo+(b+0.5)·width`.
 * `n` = the group's total count; an empty group yields an all-zero density (matches
 * `kde`'s `n>0` guard). Pure + device-free.
 */
export function densityRowFromCounts(
  binCounts: ArrayLike<number>,
  dom: BinDomain,
  grid: readonly number[],
  bandwidth: number,
): DensityPoint[] {
  const k = epanechnikov(bandwidth)
  let n = 0
  for (let b = 0; b < dom.binCount; b++) n += binCounts[b] ?? 0
  return grid.map(x => {
    if (n <= 0) return { x, density: 0 }
    let sum = 0
    for (let b = 0; b < dom.binCount; b++) {
      const c = binCounts[b] ?? 0
      if (c === 0) continue
      const center = dom.lo + (b + 0.5) * dom.binWidth
      sum += c * k(x - center)
    }
    return { x, density: sum / n }
  })
}

/**
 * Reshape a flat `nGroups*binCount` count buffer (a `groupReduce` `count` channel over the
 * composite codes) into per-group `ViolinGroup[]` by smoothing each group's `binCount`-long
 * row onto `grid`. Pure + device-free — the parity-testable core of the GPU branch.
 */
export function violinFromReducedCounts(
  counts: ArrayLike<number>,
  categories: readonly string[],
  dom: BinDomain,
  grid: readonly number[],
  bandwidth: number,
): ViolinGroup[] {
  return categories.map((group, g) => {
    const start = g * dom.binCount
    const row: number[] = new Array(dom.binCount)
    for (let b = 0; b < dom.binCount; b++) row[b] = counts[start + b] ?? 0
    return { group, density: densityRowFromCounts(row, dom, grid, bandwidth) }
  })
}

/**
 * GPU variant of `aggregate.violinByGroup` — SAME `ViolinGroup[]` shape. Bins each point by
 * a composite `group*binCount+valueBin` code, group-reduces to per-(group,bin) counts on
 * the GPU, then Epanechnikov-smooths each group's small count row onto the KDE grid.
 * Falls back to the exact `violinByGroup` oracle when there is no device, when the value
 * span is degenerate, or when the composite domain would overflow the Uint16 code range.
 */
export async function violinByGroupGpu(
  values: Float32Array,
  codes: Uint16Array,
  categories: readonly string[],
  opts: { ticks?: number; bandwidth?: number; binCount?: number; domain?: readonly [number, number] } = {},
  device?: Device | null,
): Promise<ViolinGroup[]> {
  const dev = await usableDevice(device)
  if (!dev) return violinByGroup(values, codes, categories, opts)

  const ticksN = opts.ticks ?? 40
  const binCount = Math.max(1, Math.floor(opts.binCount ?? VIOLIN_BIN_COUNT))
  const nGroups = categories.length

  // The KDE grid matches the CPU oracle's (`violinByGroup`): linspace(0, max, ticks) by
  // default, or the explicit `domain` (the visible VALUE WINDOW) when the value-axis zoom
  // re-densifies over a focused band.
  const hi = d3max(values) ?? 1
  const grid = opts.domain ? linspace(opts.domain[0], opts.domain[1], ticksN) : linspace(0, hi, ticksN)
  // …and so does the bandwidth: the SHARED `resolveKdeBandwidth` (explicit wins, else the
  // data-scaled Silverman width floored at one grid step) — never a re-derived constant, so
  // the GPU branch cannot drift from the oracle it is asserted equal to.
  const bandwidth = resolveKdeBandwidth(values, grid, opts.bandwidth)

  // The histogram domain spans the actual finite value extent [min, hi]. Degenerate span
  // or a composite range past Uint16 → the exact CPU oracle.
  const dom = binDomain(finiteMin(values), hi, binCount)
  if (!dom || nGroups * binCount > MAX_COMPOSITE) {
    return violinByGroup(values, codes, categories, opts)
  }

  const composite = violinCompositeCodes(values, codes, nGroups, dom)
  // Only the `count` channel is needed; the value column is irrelevant to counting.
  const zeros = new Float32Array(composite.length)
  const r = await runGroupReduceOnDevice(dev, {
    values: zeros,
    codes: composite,
    nGroups: nGroups * binCount,
  })
  return violinFromReducedCounts(r.count, categories, dom, grid, bandwidth)
}

/**
 * GPU variant of `statsKernels.smoothedDensity` (the 1-D single-column KDE curve over the
 * value's own `[min,max]` extent). Same binned-KDE approximation as `violinByGroupGpu` with
 * one group. Falls back to the exact `smoothedDensity` oracle when there is no device (or a
 * degenerate/overflowing domain).
 */
export async function smoothedDensityGpu(
  values: Float32Array,
  opts: { ticks?: number; bandwidth?: number; binCount?: number } = {},
  device?: Device | null,
): Promise<DensityPoint[]> {
  const dev = await usableDevice(device)
  const ticksN = opts.ticks ?? 40
  const bandwidth = opts.bandwidth ?? 0.5
  if (!dev) return smoothedDensity(values, ticksN, bandwidth)

  const binCount = Math.max(1, Math.floor(opts.binCount ?? VIOLIN_BIN_COUNT))
  const lo = finiteMin(values)
  const hi = d3max(values) ?? 1
  const dom = binDomain(lo, hi, binCount)
  if (!dom || binCount > MAX_COMPOSITE) return smoothedDensity(values, ticksN, bandwidth)

  // 1-D density grid spans the value's own [lo, hi] (NOT [0, hi]) — matches smoothedDensity.
  const grid = linspace(lo, hi, ticksN)
  const codes = new Uint16Array(values.length) // one group
  const composite = violinCompositeCodes(values, codes, 1, dom)
  const zeros = new Float32Array(composite.length)
  const r = await runGroupReduceOnDevice(dev, { values: zeros, codes: composite, nGroups: binCount })
  return densityRowFromCounts(Array.from(r.count), dom, grid, bandwidth)
}

// ── Browser parity verification (orchestrator harness hook — DEC-27) ──────────

export interface AggregateParityReport {
  /** max |GPU − CPU| across every GPU variant over a small deterministic fixture. */
  readonly maxAbsError: number
  /** true when within the float32-accumulation tolerance. */
  readonly ok: boolean
  /** the tolerance used. */
  readonly tolerance: number
}

/**
 * Run every GPU variant AND its CPU oracle on a small fixture on the passed device and
 * report the max absolute error. The orchestrator's browser harness exposes this (e.g.
 * `window.__VIZ_TEST__.verifyAggregateParity`) so a headless WebGL run proves GPU == CPU.
 */
export async function verifyAggregateParity(device: Device): Promise<AggregateParityReport> {
  const tolerance = 1e-3
  let maxAbsError = 0
  const bump = (a: number, b: number) => {
    const e = Math.abs(a - b)
    if (e > maxAbsError) maxAbsError = e
  }

  // Deterministic fixture: 600 points, 4 groups, 3 value columns, mixed zeros.
  const n = 600
  const nGroups = 4
  const categories = ['A', 'B', 'C', 'D']
  const codes = new Uint16Array(n)
  const colX = new Float32Array(n)
  const colY = new Float32Array(n)
  const colZ = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    codes[i] = i % nGroups
    colX[i] = i % 3 === 0 ? 0 : ((i * 7) % 11) + 0.25
    colY[i] = i % 5 === 0 ? 0 : ((i * 3) % 13) + 0.5
    colZ[i] = ((i * 2) % 9) - 4 // includes negatives (exercises the value>0 predicate)
  }
  const columns = new Map<string, Float32Array>([
    ['axisX', colX],
    ['axisY', colY],
    ['axisZ', colZ],
  ])

  // dotplot: mean + fraction per cell.
  const dpGpu = await dotplotMatrixGpu(columns, codes, categories, device)
  const dpCpu = dotplotMatrix(columns, codes, categories)
  for (let i = 0; i < dpCpu.length; i++) {
    bump(dpGpu[i].meanExpr, dpCpu[i].meanExpr)
    bump(dpGpu[i].fractionExpressing, dpCpu[i].fractionExpressing)
  }

  // heatmap: mean per cell.
  const hmGpu = await heatmapMatrixGpu(columns, codes, categories, device)
  const hmCpu = heatmapMatrix(columns, codes, categories)
  for (let i = 0; i < hmCpu.length; i++) bump(hmGpu[i].value, hmCpu[i].value)

  // proportions.
  const prGpu = await proportionsGpu(codes, nGroups, device)
  const prCpu = proportions(codes, nGroups)
  for (let c = 0; c < prCpu.length; c++) bump(prGpu[c], prCpu[c])

  // bar counts.
  const barGpu = await barSeriesFromCategoricalGpu({ codes, categories, length: n }, device)
  const barCpu = barSeriesFromCategorical({ codes, categories, length: n })
  for (let i = 0; i < barCpu.length; i++) bump(barGpu[i].values[0], barCpu[i].values[0])

  // histogram counts.
  const histGpu = await histogramGpu(colX, 12, device)
  const histCpu = histogramFromColumn(colX, 12)
  for (let i = 0; i < histCpu.counts.length; i++) bump(histGpu.counts[i], histCpu.counts[i])
  for (let i = 0; i < histCpu.binEdges.length; i++) bump(histGpu.binEdges[i], histCpu.binEdges[i])

  return { maxAbsError, ok: maxAbsError <= tolerance, tolerance }
}

// ── Violin parity (GPU binned-KDE vs CPU direct-KDE — SHAPE tolerance) ─────────

export interface ViolinParityReport {
  /**
   * max |GPU − CPU| of the PER-GROUP PEAK-NORMALIZED density curves (each curve scaled so
   * its own peak = 1). GPU bins-then-smooths while CPU KDEs directly, so the raw densities
   * differ by a small binning bias; normalizing compares SHAPE, which is what the violin
   * silhouette renders.
   */
  readonly maxShapeError: number
  /** max |argmax_tick_GPU − argmax_tick_CPU| across groups (peak-location agreement). */
  readonly maxPeakTickOffset: number
  /** true when BOTH the shape error and the peak offset are within tolerance. */
  readonly ok: boolean
  /** the peak-normalized shape tolerance used. */
  readonly shapeTolerance: number
  /** the max peak-tick offset allowed. */
  readonly peakTickTolerance: number
}

/** argmax tick index of a density curve (−1 for an all-zero / empty curve). */
function peakTick(curve: readonly DensityPoint[]): number {
  let best = -1
  let bestV = 0
  for (let i = 0; i < curve.length; i++) {
    if (curve[i].density > bestV) {
      bestV = curve[i].density
      best = i
    }
  }
  return best
}

/**
 * Run `violinByGroupGpu` (GPU binned-KDE) AND `violinByGroup` (CPU direct-KDE) on a small
 * deterministic multi-group fixture on the passed device and report SHAPE agreement. Unlike
 * the byte-exact `verifyGroupReduceParity`, the violin GPU path approximates the KDE via a
 * histogram, so the tolerance is a REASONABLE shape tolerance (peak-normalized curve
 * distance + peak-location offset), NOT byte-exact. At the default `binCount = 128` the
 * fixture agrees to within ~0.07 peak-normalized and 0 ticks — the silhouette is identical.
 * The orchestrator's browser harness exposes this (e.g.
 * `window.__VIZ_TEST__.verifyViolinParity`) so a headless WebGL run proves it on a real GPU.
 */
/** Deterministic PEAKED offset (mode at 0) from a 0..99 bucket — 50% at the mode. */
function peakedOffset(r: number): number {
  if (r < 50) return 0
  if (r < 72) return 0.5
  if (r < 90) return -0.5
  if (r < 97) return 1
  return -1
}

export async function verifyViolinParity(device: Device): Promise<ViolinParityReport> {
  const shapeTolerance = 0.15
  const peakTickTolerance = 2

  // Deterministic fixture: 900 points, 3 groups with DISTINCT value distributions so the
  // per-group silhouettes (and their peaks) genuinely differ.
  const n = 900
  const categories = ['low', 'mid', 'high']
  const nGroups = categories.length
  const codes = new Uint16Array(n)
  const values = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const g = i % nGroups
    codes[i] = g
    // group-shifted, deterministically PEAKED values (sharp modes at 2 / 6 / 10 so the
    // per-group peak location is unambiguous — a flat-topped spread makes argmax noisy).
    values[i] = g * 4 + 2 + peakedOffset((i * 13) % 100)
  }
  const opts = { ticks: 40, bandwidth: 0.8, binCount: VIOLIN_BIN_COUNT }

  const gpu = await violinByGroupGpu(values, codes, categories, opts, device)
  const cpu = violinByGroup(values, codes, categories, opts)

  let maxShapeError = 0
  let maxPeakTickOffset = 0
  for (let g = 0; g < cpu.length; g++) {
    const gc = gpu[g].density
    const cc = cpu[g].density
    const gPeak = gc.reduce((m, d) => Math.max(m, d.density), 0) || 1
    const cPeak = cc.reduce((m, d) => Math.max(m, d.density), 0) || 1
    for (let i = 0; i < cc.length; i++) {
      const e = Math.abs(gc[i].density / gPeak - cc[i].density / cPeak)
      if (e > maxShapeError) maxShapeError = e
    }
    const off = Math.abs(peakTick(gc) - peakTick(cc))
    if (off > maxPeakTickOffset) maxPeakTickOffset = off
  }

  return {
    maxShapeError,
    maxPeakTickOffset,
    ok: maxShapeError <= shapeTolerance && maxPeakTickOffset <= peakTickTolerance,
    shapeTolerance,
    peakTickTolerance,
  }
}
