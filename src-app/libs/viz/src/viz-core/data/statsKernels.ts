// statsKernels.ts — the CPU statistics kernels (ITEM-45 / DEC-29). Every function here
// is a PURE function of plain inputs → plain outputs: no GL, no DOM, no store, no I/O. It
// is the **parity oracle** for the GPU-compute pre-passes — a GPU kernel is correct iff it
// reproduces the value THIS file produces. Names are domain-agnostic (DEC-28): `point`,
// `valueColumn`, `group`, `category` — never cell/gene/cluster.
//
// Degenerate / NaN contract (DEC-29 + ITEM-58): every kernel handles empty / single / flat
// (zero-variance) inputs with a sensible default and NEVER throws, NEVER emits NaN geometry.
// Non-finite inputs are filtered via `finiteValues` before any math.

import { finiteValues, meanStd, statVerdict, zscore } from './missing'
import type { DataTable } from './wire'
import { kde, linspace, type DensityPoint } from '../charts/aggregate'

// ─────────────────────────────────────────────────────────────────────────────
// Special-function primitives (pure JS; no stats library). These back every
// p-value: normal CDF (erf), the regularized incomplete beta (Student-t / F) and
// the regularized incomplete gamma (chi-squared). Ported from Numerical Recipes.
// ─────────────────────────────────────────────────────────────────────────────

/** Error function (Abramowitz & Stegun 7.1.26; |error| < 1.5e-7). */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x)
  return x >= 0 ? y : -y
}

/** Standard-normal CDF Φ(z). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** log Γ(x) (Lanczos approximation). */
function gammln(xx: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ]
  let x = xx
  let y = xx
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) {
    y++
    ser += cof[j] / y
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}

/** Continued-fraction expansion for the incomplete beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200
  const EPS = 3e-12
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/** Regularized incomplete beta I_x(a,b) ∈ [0,1]. */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(
    gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x),
  )
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a
  return 1 - (bt * betacf(b, a, 1 - x)) / b
}

/** Two-sided p-value for a Student-t statistic with `df` degrees of freedom. */
function tDistTwoSidedP(t: number, df: number): number {
  if (df <= 0 || !Number.isFinite(t)) return 1
  const x = df / (df + t * t)
  return clamp01(betai(df / 2, 0.5, x))
}

/** Series expansion for the lower regularized incomplete gamma P(a,x). */
function gser(a: number, x: number): number {
  const ITMAX = 300
  const EPS = 3e-12
  const gln = gammln(a)
  if (x <= 0) return 0
  let ap = a
  let sum = 1 / a
  let del = sum
  for (let n = 0; n < ITMAX; n++) {
    ap++
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * EPS) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln)
}

/** Continued-fraction expansion for the upper regularized incomplete gamma Q(a,x). */
function gcf(a: number, x: number): number {
  const ITMAX = 300
  const EPS = 3e-12
  const FPMIN = 1e-300
  const gln = gammln(a)
  let b = x + 1 - a
  let c = 1 / FPMIN
  let d = 1 / b
  let h = d
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = b + an / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h
}

/** Upper tail Q(a,x) = 1 − P(a,x) of the regularized incomplete gamma. */
function gammq(a: number, x: number): number {
  if (x <= 0) return 1
  if (x < a + 1) return 1 - gser(a, x)
  return gcf(a, x)
}

/** Upper-tail p-value of a chi-squared statistic with `df` degrees of freedom. */
function chiSquaredUpperP(chi2: number, df: number): number {
  if (df <= 0 || chi2 <= 0) return 1
  return clamp01(gammq(df / 2, chi2 / 2))
}

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 1
  return p < 0 ? 0 : p > 1 ? 1 : p
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Quartiles / Tukey box-plot statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface Quartiles {
  readonly q1: number
  readonly median: number
  readonly q3: number
  readonly min: number
  readonly max: number
  readonly iqr: number
  readonly lowerFence: number
  readonly upperFence: number
  /** Points beyond the 1.5·IQR Tukey fences. */
  readonly outliers: number[]
}

/** Linear-interpolation quantile (method R-7 / d3 default) over a SORTED ascending array. */
function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0]
  const h = (n - 1) * p
  const lo = Math.floor(h)
  const hi = Math.min(lo + 1, n - 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/**
 * Tukey box-plot statistics with the linear-interpolation quantile method and 1.5·IQR
 * fences. Degenerate: empty → all zeros; single → the value everywhere, no outliers; flat
 * → value everywhere with iqr 0 (no outliers). Non-finite inputs are dropped.
 */
export function quartiles(values: ArrayLike<number>): Quartiles {
  const v = finiteValues(values).sort((a, b) => a - b)
  const verdict = statVerdict(v)
  if (verdict === 'empty') {
    return { q1: 0, median: 0, q3: 0, min: 0, max: 0, iqr: 0, lowerFence: 0, upperFence: 0, outliers: [] }
  }
  const min = v[0]
  const max = v[v.length - 1]
  if (verdict === 'single') {
    const x = v[0]
    return { q1: x, median: x, q3: x, min: x, max: x, iqr: 0, lowerFence: x, upperFence: x, outliers: [] }
  }
  const q1 = quantileSorted(v, 0.25)
  const median = quantileSorted(v, 0.5)
  const q3 = quantileSorted(v, 0.75)
  const iqr = q3 - q1
  const lowerFence = q1 - 1.5 * iqr
  const upperFence = q3 + 1.5 * iqr
  const outliers = v.filter(x => x < lowerFence || x > upperFence)
  return { q1, median, q3, min, max, iqr, lowerFence, upperFence, outliers }
}

/** Convenience: box statistics for one named column of a {@link DataTable}. */
export function quartilesOfColumn(table: DataTable, column: string): Quartiles {
  const col = table.columns[column]
  return quartiles(col ? finiteValues(col) : [])
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Hierarchical (agglomerative) clustering + 3. cut-tree
// ─────────────────────────────────────────────────────────────────────────────

export interface Merge {
  /** Cluster id of the first merged node (scipy Z convention: leaves 0..n-1, internal n+step). */
  readonly a: number
  readonly b: number
  /** Linkage distance at which a and b merged. */
  readonly height: number
}

export interface HierResult {
  /** Leaf permutation for the dendrogram (a dense ordering of row indices). */
  readonly order: number[]
  /** Merge sequence; leaves are 0..n-1, the k-th merge creates internal id n+k. */
  readonly merges: Merge[]
  /** True when nRows exceeded the cap and clustering was skipped (identity order). */
  readonly capped: boolean
}

export type Linkage = 'average' | 'complete' | 'ward'
export type DistanceMetric = 'euclidean' | 'correlation'

/** Naive agglomerative clustering caps rows to bound the O(n²) distance matrix. */
export const HIER_ROW_CAP = 2000

function euclidean(x: Float32Array, y: Float32Array, n: number): number {
  let s = 0
  for (let k = 0; k < n; k++) {
    const d = x[k] - y[k]
    s += d * d
  }
  return Math.sqrt(s)
}

/** 1 − Pearson correlation; a flat (zero-variance) row → max dissimilarity 1 (÷0 guard). */
function correlationDist(x: Float32Array, y: Float32Array, n: number): number {
  let mx = 0
  let my = 0
  for (let k = 0; k < n; k++) {
    mx += x[k]
    my += y[k]
  }
  mx /= n
  my /= n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let k = 0; k < n; k++) {
    const dx = x[k] - mx
    const dy = y[k] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return 1
  const r = sxy / Math.sqrt(sxx * syy)
  return 1 - r
}

/** Lance-Williams distance update for the merged cluster (Ward uses the Ward.D2 form). */
function lanceWilliams(
  linkage: Linkage,
  dik: number,
  djk: number,
  dij: number,
  ni: number,
  nj: number,
  nk: number,
): number {
  switch (linkage) {
    case 'complete':
      return Math.max(dik, djk)
    case 'ward': {
      const t = ni + nj + nk
      const val = ((ni + nk) * dik * dik + (nj + nk) * djk * djk - nk * dij * dij) / t
      return Math.sqrt(Math.max(0, val))
    }
    default: // 'average' (UPGMA)
      return (ni * dik + nj * djk) / (ni + nj)
  }
}

/**
 * Standard agglomerative clustering of the `nRows`×`nCols` row-major `matrix`. Emits a leaf
 * order + the merge sequence. Above {@link HIER_ROW_CAP} rows, returns the identity order
 * with `capped:true` and no merges (naive O(n²) memory would blow up).
 */
export function hierarchicalClustering(
  matrix: Float32Array,
  nRows: number,
  nCols: number,
  opts: { linkage: Linkage; distance: DistanceMetric },
): HierResult {
  if (nRows <= 0) return { order: [], merges: [], capped: false }
  if (nRows === 1) return { order: [0], merges: [], capped: false }
  if (nRows > HIER_ROW_CAP) {
    return { order: Array.from({ length: nRows }, (_, i) => i), merges: [], capped: true }
  }

  const row = (r: number): Float32Array => matrix.subarray(r * nCols, (r + 1) * nCols)
  const dist =
    opts.distance === 'correlation'
      ? (a: number, b: number) => correlationDist(row(a), row(b), nCols)
      : (a: number, b: number) => euclidean(row(a), row(b), nCols)

  // Symmetric distance matrix between current cluster slots (slot i starts as leaf i).
  const D: Float64Array[] = Array.from({ length: nRows }, () => new Float64Array(nRows))
  for (let i = 0; i < nRows; i++) {
    for (let j = i + 1; j < nRows; j++) {
      const d = dist(i, j)
      D[i][j] = d
      D[j][i] = d
    }
  }

  const active: number[] = Array.from({ length: nRows }, (_, i) => i)
  const clusterId = Array.from({ length: nRows }, (_, i) => i)
  const size = new Array<number>(nRows).fill(1)
  const leaves: number[][] = Array.from({ length: nRows }, (_, i) => [i])
  const merges: Merge[] = []

  for (let step = 0; step < nRows - 1; step++) {
    // Nearest active pair.
    let bestA = -1
    let bestB = -1
    let bestD = Infinity
    for (let ai = 0; ai < active.length; ai++) {
      const a = active[ai]
      for (let bi = ai + 1; bi < active.length; bi++) {
        const b = active[bi]
        const d = D[a][b]
        if (d < bestD) {
          bestD = d
          bestA = a
          bestB = b
        }
      }
    }
    const a = bestA
    const b = bestB
    const height = bestD
    merges.push({ a: clusterId[a], b: clusterId[b], height })

    const ni = size[a]
    const nj = size[b]
    for (const k of active) {
      if (k === a || k === b) continue
      const nd = lanceWilliams(opts.linkage, D[a][k], D[b][k], height, ni, nj, size[k])
      D[a][k] = nd
      D[k][a] = nd
    }
    // Merge b into slot a; slot a becomes the new (internal) cluster n+step.
    leaves[a] = leaves[a].concat(leaves[b])
    size[a] = ni + nj
    clusterId[a] = nRows + step
    active.splice(active.indexOf(b), 1)
  }

  return { order: leaves[active[0]], merges, capped: false }
}

/**
 * Cut a dendrogram (as produced by {@link hierarchicalClustering}) into `k` clusters,
 * returning the cluster label of each leaf. Labels are dense 0..k-1, assigned in order of
 * first leaf appearance. `k` is clamped to [1, n].
 */
export function cutTree(merges: readonly Merge[], k: number): number[] {
  const n = merges.length + 1
  if (n <= 0) return []
  const kk = Math.max(1, Math.min(k, n))
  const numMerges = n - kk // apply this many merges, leave the last (k-1) uncut

  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r]
    // path compression
    let c = i
    while (parent[c] !== r) {
      const next = parent[c]
      parent[c] = r
      c = next
    }
    return r
  }
  const union = (i: number, j: number) => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[rj] = ri
  }

  // repLeaf maps a cluster id (leaf or internal) → one representative leaf index.
  const repLeaf = new Map<number, number>()
  for (let i = 0; i < n; i++) repLeaf.set(i, i)
  for (let step = 0; step < numMerges; step++) {
    const { a, b } = merges[step]
    const la = repLeaf.get(a) ?? 0
    const lb = repLeaf.get(b) ?? 0
    union(la, lb)
    repLeaf.set(n + step, find(la))
  }

  const rootLabel = new Map<number, number>()
  const out = new Array<number>(n)
  let next = 0
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!rootLabel.has(r)) rootLabel.set(r, next++)
    out[i] = rootLabel.get(r)!
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Significance tests (Mann-Whitney U, Welch t, Kruskal-Wallis)
// ─────────────────────────────────────────────────────────────────────────────

/** Fractional (average-tie) ranks + the Σ(t³−t) tie-correction term. */
function rankData(values: number[]): { ranks: number[]; tieCorrection: number } {
  const idx = values.map((_, i) => i).sort((x, y) => values[x] - values[y])
  const ranks = new Array<number>(values.length)
  let tieSum = 0
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++
    const avgRank = (i + j) / 2 + 1 // 1-based average rank of the tie block
    for (let m = i; m <= j; m++) ranks[idx[m]] = avgRank
    const t = j - i + 1
    if (t > 1) tieSum += t * t * t - t
    i = j + 1
  }
  return { ranks, tieCorrection: tieSum }
}

export interface MannWhitneyResult {
  /** The U statistic (min of U₁,U₂). */
  readonly u: number
  /** Two-sided p-value (normal approximation with tie + continuity correction). */
  readonly p: number
}

export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult {
  const A = finiteValues(a)
  const B = finiteValues(b)
  const n1 = A.length
  const n2 = B.length
  if (n1 === 0 || n2 === 0) return { u: 0, p: 1 }
  const all = A.concat(B)
  const { ranks, tieCorrection } = rankData(all)
  let R1 = 0
  for (let i = 0; i < n1; i++) R1 += ranks[i]
  const U1 = R1 - (n1 * (n1 + 1)) / 2
  const U2 = n1 * n2 - U1
  const U = Math.min(U1, U2)
  const meanU = (n1 * n2) / 2
  const N = n1 + n2
  const varU = ((n1 * n2) / 12) * (N + 1 - tieCorrection / (N * (N - 1)))
  if (varU <= 0) return { u: U, p: 1 }
  const std = Math.sqrt(varU)
  const z = (Math.abs(U - meanU) - 0.5) / std // continuity correction
  const zc = z < 0 ? 0 : z
  const p = 2 * (1 - normalCdf(zc))
  return { u: U, p: clamp01(p) }
}

export interface TTestResult {
  readonly t: number
  /** Two-sided p-value from the Student-t distribution (Welch df). */
  readonly p: number
}

/** Welch's (unequal-variance) two-sample t-test. */
export function tTest(a: number[], b: number[]): TTestResult {
  const A = finiteValues(a)
  const B = finiteValues(b)
  const na = A.length
  const nb = B.length
  if (na < 2 || nb < 2) return { t: 0, p: 1 }
  const ma = A.reduce((s, v) => s + v, 0) / na
  const mb = B.reduce((s, v) => s + v, 0) / nb
  const va = A.reduce((s, v) => s + (v - ma) * (v - ma), 0) / (na - 1)
  const vb = B.reduce((s, v) => s + (v - mb) * (v - mb), 0) / (nb - 1)
  const se2 = va / na + vb / nb
  if (se2 <= 0) return { t: 0, p: 1 }
  const t = (ma - mb) / Math.sqrt(se2)
  const df =
    (se2 * se2) /
    ((va / na) * (va / na) / (na - 1) + (vb / nb) * (vb / nb) / (nb - 1))
  return { t, p: tDistTwoSidedP(t, df) }
}

export interface KruskalWallisResult {
  readonly h: number
  /** Upper-tail p-value from the chi-squared distribution (df = groups − 1). */
  readonly p: number
}

export function kruskalWallis(groups: number[][]): KruskalWallisResult {
  const clean = groups.map(g => finiteValues(g)).filter(g => g.length > 0)
  const g = clean.length
  if (g < 2) return { h: 0, p: 1 }
  const all: number[] = []
  const sizes: number[] = []
  for (const grp of clean) {
    sizes.push(grp.length)
    for (const v of grp) all.push(v)
  }
  const N = all.length
  if (N < 2) return { h: 0, p: 1 }
  const { ranks, tieCorrection } = rankData(all)
  let offset = 0
  let sumTerm = 0
  for (let gi = 0; gi < clean.length; gi++) {
    let R = 0
    for (let k = 0; k < sizes[gi]; k++) R += ranks[offset + k]
    sumTerm += (R * R) / sizes[gi]
    offset += sizes[gi]
  }
  let H = (12 / (N * (N + 1))) * sumTerm - 3 * (N + 1)
  const C = 1 - tieCorrection / (N * N * N - N)
  if (C > 0) H = H / C
  return { h: H, p: chiSquaredUpperP(H, g - 1) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Significance-bracket height packing
// ─────────────────────────────────────────────────────────────────────────────

export interface Bracket {
  readonly i: number
  readonly j: number
  /** Vertical position of the bracket (baseY + level·step). */
  readonly y: number
  /** Significance stars from the p-value: ***, **, *, or ns. */
  readonly label: string
}

/** Significance label from a p-value (Tukey/GraphPad convention). */
export function significanceLabel(p: number): string {
  if (!Number.isFinite(p)) return 'ns'
  if (p < 0.001) return '***'
  if (p < 0.01) return '**'
  if (p < 0.05) return '*'
  return 'ns'
}

/**
 * Pack significance brackets into stacked levels so overlapping spans don't collide. Two
 * brackets overlap if their [min(i,j), max(i,j)] spans intersect (nested counts). Narrower
 * spans are placed low; each bracket gets the lowest free level. Output preserves input
 * order.
 */
export function packBrackets(
  comparisons: { i: number; j: number; p: number }[],
  baseY: number,
  step: number,
): Bracket[] {
  const spans = comparisons.map((c, idx) => ({
    idx,
    lo: Math.min(c.i, c.j),
    hi: Math.max(c.i, c.j),
    width: Math.abs(c.i - c.j),
  }))
  // Process narrow-first (then left-first) for tight packing.
  const order = [...spans].sort((a, b) => a.width - b.width || a.lo - b.lo)
  const levels = new Array<number>(comparisons.length)
  const placed: { lo: number; hi: number; level: number }[] = []
  for (const s of order) {
    const used = new Set<number>()
    for (const q of placed) {
      if (s.lo <= q.hi && q.lo <= s.hi) used.add(q.level)
    }
    let level = 0
    while (used.has(level)) level++
    levels[s.idx] = level
    placed.push({ lo: s.lo, hi: s.hi, level })
  }
  return comparisons.map((c, idx) => ({
    i: c.i,
    j: c.j,
    y: baseY + levels[idx] * step,
    label: significanceLabel(c.p),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Proportions + stacked-bar cumulative
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fraction of points in each category (sums to 1 when any point is present). Codes ≥
 * nCategories are ignored. All-empty → all zeros.
 */
export function proportions(codes: Uint16Array, nCategories: number): Float32Array {
  const out = new Float32Array(Math.max(0, nCategories))
  if (nCategories <= 0) return out
  let total = 0
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c < nCategories) {
      out[c]++
      total++
    }
  }
  if (total > 0) {
    for (let c = 0; c < nCategories; c++) out[c] /= total
  }
  return out
}

/**
 * Cumulative sums for stacked bars. `values[s][c]` is series `s`'s value at category `c`;
 * the returned `out[s][c]` is the TOP edge of series s's segment = Σ_{k≤s} values[k][c]
 * (the running total of all series at or below s). Jagged rows are tolerated.
 */
export function stackedCumulative(values: number[][]): number[][] {
  const cols = values.reduce((m, r) => Math.max(m, r.length), 0)
  const running = new Array<number>(cols).fill(0)
  const out: number[][] = []
  for (const rowVals of values) {
    const acc = new Array<number>(rowVals.length)
    for (let c = 0; c < rowVals.length; c++) {
      running[c] += rowVals[c]
      acc[c] = running[c]
    }
    out.push(acc)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Small reused reductions (z-score column, smoothed density) — thin wrappers over
// the shared foundation so the pre-pass has one canonical implementation.
// ─────────────────────────────────────────────────────────────────────────────

/** z-score standardize a value column (mean 0, sd 1); a flat column maps to all zeros. */
export function zscoreColumn(values: ArrayLike<number>): Float32Array {
  const { mean, std } = meanStd(values)
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = zscore(values[i], mean, std)
  return out
}

/**
 * Kernel-density curve of a value column over an auto-ranged grid (reuses the shared KDE).
 * Empty input → empty curve.
 */
export function smoothedDensity(
  values: ArrayLike<number>,
  ticks = 40,
  bandwidth = 0.5,
): DensityPoint[] {
  const finite = finiteValues(values)
  if (finite.length === 0) return []
  let lo = finite[0]
  let hi = finite[0]
  for (const v of finite) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return kde(finite, linspace(lo, hi, ticks), bandwidth)
}
