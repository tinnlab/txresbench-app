// aggregate.ts — pure data-prep for the companion statistical charts
// (ITEM-18/19/20/21). All low-cardinality (columns × groups), computed client-side
// from expression columns + a categorical grouping. Rendered by Observable Plot
// in the chart components; this module is the testable math.

import { max as d3max } from 'd3-array'

// ── Violin: per-group kernel density estimate (ITEM-18) ──────────────────────

/** Epanechnikov kernel (legacy sc-website used the same for its violins). */
export function epanechnikov(bandwidth: number): (v: number) => number {
  return (v: number) => {
    const u = v / bandwidth
    return Math.abs(u) <= 1 ? (0.75 * (1 - u * u)) / bandwidth : 0
  }
}

export interface DensityPoint {
  readonly x: number
  readonly density: number
}

/**
 * Kernel density estimate of `values` sampled at `ticks` grid points. Returns the
 * density curve (used as a `Plot.areaX` violin half).
 */
export function kde(
  values: ArrayLike<number>,
  ticks: readonly number[],
  bandwidth = 0.5,
): DensityPoint[] {
  const k = epanechnikov(bandwidth)
  const n = values.length
  return ticks.map(x => {
    let sum = 0
    for (let i = 0; i < n; i++) sum += k(x - values[i])
    return { x, density: n > 0 ? sum / n : 0 }
  })
}

/** Evenly spaced grid over [min,max] with `count` ticks. */
export function linspace(min: number, max: number, count: number): number[] {
  if (count <= 1) return [min]
  const step = (max - min) / (count - 1)
  return Array.from({ length: count }, (_, i) => min + i * step)
}

/**
 * `kde`'s historical fixed default, kept ONLY as the degenerate-input fallback (empty /
 * single-valued / zero-spread column, where no data-driven rule is defined).
 */
export const LEGACY_KDE_BANDWIDTH = 0.5

/** √5 — the Epanechnikov σ → half-support conversion factor (kernel variance = h²/5). */
const SQRT5 = Math.sqrt(5)

/** Linear-interpolated quantile of an ASCENDING-sorted, non-empty array. */
function quantileSorted(sorted: readonly number[], p: number): number {
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * Data-scaled KDE bandwidth (Silverman's rule of thumb) for `values`, expressed in the
 * HALF-SUPPORT units `epanechnikov` takes — its kernel is exactly zero beyond ±bandwidth,
 * so the number is NOT a kernel σ.
 *
 * WHY THIS EXISTS: `kde`'s default bandwidth is the absolute constant 0.5. That is a
 * sane smoothing width for log-normalized expression (values in ~[0,6]) and NONSENSE for
 * a raw per-cell QC metric (`total_counts` in the thousands): a ±0.5 kernel then covers
 * ~0.003% of the value range, so essentially NO sample falls within a kernel width of any
 * of the 40 grid ticks and the density comes back 0 almost everywhere. Since
 * `buildViolinProps` maps density → half-width, an all-zero density collapses the violin
 * polygon onto the group center — the body disappears and only the inner Tukey box + the
 * jitter dots render, i.e. the violin "looks like a box plot". Measured on a 2700-row
 * log-normal `total_counts` column: 2 of 40 ticks non-zero, and ZERO in-frame ticks above
 * 10% of the peak.
 *
 * The rule is `0.9 · min(sd, IQR/1.349) · n^(-1/5)` (the robust variant — the IQR term
 * keeps a heavy right tail or a stray outlier from inflating the bandwidth and flattening
 * the body), converted from kernel-σ to Epanechnikov half-support by ×√5 (the Epanechnikov
 * kernel on [-h,h] has variance h²/5).
 *
 * Pure; O(n log n) (one sort for the IQR) and run once per data load, not per frame.
 */
export function silvermanBandwidth(values: ArrayLike<number>): number {
  const finite: number[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v)) finite.push(v)
  }
  const n = finite.length
  if (n < 2) return LEGACY_KDE_BANDWIDTH
  let mean = 0
  for (const v of finite) mean += v
  mean /= n
  let ss = 0
  for (const v of finite) ss += (v - mean) * (v - mean)
  const sd = Math.sqrt(ss / (n - 1))
  finite.sort((a, b) => a - b)
  const iqr = quantileSorted(finite, 0.75) - quantileSorted(finite, 0.25)
  const spread = iqr > 0 ? Math.min(sd, iqr / 1.349) : sd
  if (!(spread > 0) || !Number.isFinite(spread)) return LEGACY_KDE_BANDWIDTH // flat column
  return 0.9 * spread * Math.pow(n, -1 / 5) * SQRT5
}

/**
 * The bandwidth a violin KDE actually uses: an EXPLICIT `bandwidth` always wins verbatim
 * (callers that pass one — the parity harness, the tests — get byte-exact behavior);
 * otherwise the data-scaled {@link silvermanBandwidth}, floored at ONE GRID STEP.
 *
 * The floor is the anti-aliasing invariant: the density is only ever SAMPLED at the grid
 * ticks, so a bandwidth narrower than the tick spacing cannot be rendered — it can only
 * alias into a comb of isolated spikes (the failure mode above, in its milder form: a
 * narrow core with one far outlier stretches the grid until the ticks out-run the
 * bandwidth). Smoothing to at least the sampling resolution costs no real structure.
 *
 * Shared by BOTH the CPU (`violinByGroup`) and GPU (`violinByGroupGpu`) paths so the two
 * cannot drift apart — their equality is an asserted contract.
 */
export function resolveKdeBandwidth(
  values: ArrayLike<number>,
  grid: readonly number[],
  explicit?: number,
): number {
  if (explicit != null) return explicit
  const bw = silvermanBandwidth(values)
  const step = grid.length > 1 ? Math.abs(grid[1] - grid[0]) : 0
  return step > 0 ? Math.max(bw, step) : bw
}

export interface ViolinGroup {
  readonly group: string
  readonly density: DensityPoint[]
}

/**
 * Per-group violin densities for one column/obs column. `subset` optionally restricts
 * to a selected point set (linked-view recompute); else all points.
 *
 * `opts.bandwidth` is honored verbatim; omitted, the smoothing width is DERIVED from the
 * data ({@link resolveKdeBandwidth}) rather than the fixed 0.5 that made a violin over a
 * large-magnitude column (a raw QC metric) render as an empty body. One bandwidth is
 * shared by every group (computed over the whole column) so the violins stay mutually
 * comparable and the CPU/GPU paths agree — note that means `subset` narrows the DENSITIES
 * but not the smoothing width (deliberate: a selection's shape stays comparable to the
 * unselected one, and the GPU variant has no `subset` to mirror).
 */
export function violinByGroup(
  values: Float32Array,
  codes: Uint16Array,
  categories: readonly string[],
  opts: {
    ticks?: number
    bandwidth?: number
    subset?: (i: number) => boolean
    /**
     * KDE sample grid domain `[lo, hi]`. Default `[0, max(values)]` (the full-column
     * framing). The value-axis zoom passes the visible VALUE WINDOW so the KDE re-densifies
     * over the focused band (the legacy `d3.scaleLinear().domain([min,max]).ticks(40)` step).
     */
    domain?: readonly [number, number]
  } = {},
): ViolinGroup[] {
  const ticksN = opts.ticks ?? 40
  const hi = d3max(values) ?? 1
  const grid = opts.domain ? linspace(opts.domain[0], opts.domain[1], ticksN) : linspace(0, hi, ticksN)
  const bandwidth = resolveKdeBandwidth(values, grid, opts.bandwidth)
  const byGroup = new Map<number, number[]>()
  for (let i = 0; i < codes.length; i++) {
    if (opts.subset && !opts.subset(i)) continue
    const arr = byGroup.get(codes[i]) ?? []
    arr.push(values[i])
    byGroup.set(codes[i], arr)
  }
  return categories.map((group, code) => ({
    group,
    density: kde(byGroup.get(code) ?? [], grid, bandwidth),
  }))
}

// ── Dotplot: per-(column,group) mean expression + fraction expressing (ITEM-19) ─

export interface DotCell {
  readonly column: string
  readonly group: string
  readonly meanExpr: number
  readonly fractionExpressing: number
}

/**
 * For each column × group: mean expression (dot color) and fraction of points with
 * non-zero expression (dot radius). `columns` maps a column name → its dense column.
 */
export function dotplotMatrix(
  columns: ReadonlyMap<string, Float32Array>,
  codes: Uint16Array,
  categories: readonly string[],
): DotCell[] {
  const out: DotCell[] = []
  for (const [column, values] of columns) {
    const sum = new Float64Array(categories.length)
    const nz = new Float64Array(categories.length)
    const cnt = new Float64Array(categories.length)
    for (let i = 0; i < codes.length; i++) {
      const g = codes[i]
      sum[g] += values[i]
      if (values[i] > 0) nz[g]++
      cnt[g]++
    }
    for (let g = 0; g < categories.length; g++) {
      out.push({
        column,
        group: categories[g],
        meanExpr: cnt[g] > 0 ? sum[g] / cnt[g] : 0,
        fractionExpressing: cnt[g] > 0 ? nz[g] / cnt[g] : 0,
      })
    }
  }
  return out
}

// ── Heatmap: columns × groups aggregated mean-expression matrix (ITEM-20) ───────

export interface HeatCell {
  readonly column: string
  readonly group: string
  readonly value: number
}

export function heatmapMatrix(
  columns: ReadonlyMap<string, Float32Array>,
  codes: Uint16Array,
  categories: readonly string[],
): HeatCell[] {
  return dotplotMatrix(columns, codes, categories).map(d => ({
    column: d.column,
    group: d.group,
    value: d.meanExpr,
  }))
}

/**
 * Order columns by the group in which they peak (a simple, deterministic grouping
 * order so the heatmap reads as blocks). Returns the column order.
 */
export function orderColumnsByPeakGroup(
  points: readonly HeatCell[],
  columns: readonly string[],
  categories: readonly string[],
): string[] {
  const peak = new Map<string, number>()
  for (const column of columns) {
    const row = points.filter(c => c.column === column)
    let best = 0
    let bestV = -Infinity
    for (const c of row) {
      if (c.value > bestV) {
        bestV = c.value
        best = categories.indexOf(c.group)
      }
    }
    peak.set(column, best)
  }
  return [...columns].sort((a, b) => (peak.get(a)! - peak.get(b)!))
}

// ── Volcano: DE mapping + significance flags (ITEM-21) ────────────────────────

export interface VolcanoPoint {
  readonly column: string
  readonly log2fc: number
  readonly negLog10P: number
  readonly significant: boolean
  readonly direction: 'up' | 'down' | 'ns'
}

export function volcanoPoints(
  columns: readonly string[],
  log2fc: Float32Array,
  negLog10P: Float32Array,
  opts: { fcThreshold?: number; pThreshold?: number } = {},
): VolcanoPoint[] {
  const fcT = opts.fcThreshold ?? 1
  const pT = opts.pThreshold ?? 1.30103 // −log10(0.05)
  return columns.map((column, i) => {
    const fc = log2fc[i]
    const p = negLog10P[i]
    const sig = Math.abs(fc) >= fcT && p >= pT
    return {
      column,
      log2fc: fc,
      negLog10P: p,
      significant: sig,
      direction: !sig ? 'ns' : fc > 0 ? 'up' : 'down',
    }
  })
}

/** Small helper exposed for tests: mean of a numeric column. */
export function columnMean(values: ArrayLike<number>): number {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}
