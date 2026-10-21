// groupStatsGpu.ts — GPU-backed variants of the HOT per-cell group statistics that today
// read ALL N per-cell values on the CPU (DEC-26/29). Three CPU paths dominate the box +
// violin views and scale O(N) / O(N log N) in the point count:
//   • `BoxView.boxStatsFromColumn` → `bucketByGroup` (loops all N codes) → `quartiles`
//     (SORTS each group's values) — the box-plot quartiles/fences/outliers;
//   • `ViolinView` significance → `mannWhitneyU` (RANKS the two groups' pooled values);
//   • the arithmetic mean/SD per group (a full pass over each group's values).
// This module pushes the O(N) reduction onto the VERIFIED `gpu/groupReduce.ts` primitive
// (now extended with a Σvalue² Alpha channel) and the group×bin 2-D histogram approach
// already used by `charts/aggregateGpu.ts::violinByGroupGpu`, and falls back to the EXACT
// CPU oracle when no compute device exists (node/vitest → byte-identical to the oracle).
//
// EXACT vs APPROXIMATE (documented tolerances live on the `verify*Parity` reports):
//   • `groupMeanSdGpu` is EXACT: it derives mean + population SD from the two-pass `meanStd`
//     oracle per group. (The one-pass `sumSq/count − mean²` form is catastrophic-cancellation-
//     unstable on float32 for large-offset/small-spread groups — ~1e6 ± 1 — so the live path
//     stays on the exact two-pass reference; `meanSdFromReduced` is kept only for the
//     well-conditioned pure-math test. See L1 in the parity notes.)
//   • `boxStatsGpu` is APPROXIMATE: quartiles come from CDF interpolation over a histogram
//     built PER GROUP over that group's OWN [min,max] extent (a GPU min/max reduction), NOT
//     the whole column's global extent — so a heavy-tail outlier in one group can no longer
//     collapse every OTHER group's box to a single bin. A quartile lands within ~one
//     (per-group) bin-width of the exact R-7 quantile; outliers are bin-center-quantized and
//     DE-DUPLICATED (at most one representative marker per outlier bin, never `count` copies).
//     Any group whose extent is degenerate (empty / flat), tiny (< a few points), or so
//     heavy-tailed that its own histogram would still collapse (too few populated bins) is
//     routed to the EXACT `boxStatsFromColumn` oracle instead. Error is reported relative to
//     each group's OWN IQR (fraction of that group's IQR), not the global range.
//   • `mannWhitneyUGpu` is APPROXIMATE: the U statistic is accumulated from the two
//     groups' histograms (U ≈ Σ_bin countB·(cumA_below + ½·countA)); it stays the SAME
//     Mann-Whitney test (NOT silently a t-test) — binning only turns near-equal values
//     into bin-resolution ties, which slightly perturbs U + the p-value.
//
// As always (DEC-27): the GPU numeric path is proven in the orchestrator's browser harness
// (`verifyBoxStatsParity` / `verifySignificanceParity` exposed on `window`); node/vitest
// exercises the CPU-fallback (byte-exact vs the oracle) + the pure histogram-math helpers.

import type { Device } from '@luma.gl/core'
import {
  runGroupReduceOnDevice,
  runGroupMinMaxOnDevice,
  cpuGroupMinMax,
  deviceSupportsGroupReduce,
} from '../gpu/groupReduce'
import { getComputeDevice } from '../gpu/computeDevice'
import { binDomain, violinCompositeCodes, type BinDomain } from './aggregateGpu'
import { boxStatsFromColumn } from './BoxView'
import type { BoxStat } from './chartLayers'
import { mannWhitneyU, normalCdf, quartiles, type MannWhitneyResult } from '../data/statsKernels'
import { meanStd } from '../data/missing'
import { densify } from '../data/wire'
import type { CategoricalColumn, SparseColumn } from '../data/wire'

// ── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Value-histogram resolution for the box quartiles + the Mann-Whitney U approximation. At
 * 256 bins each quartile resolves to ≈ range/256 (< 0.4 % of the value range) — comfortably
 * inside the reported quartile tolerance while keeping the composite `nGroups*binCount`
 * bucket count small (256 × up to 255 groups ≤ Uint16). A caller can override via `opts`.
 */
const STAT_BIN_COUNT = 256
/** groupReduce codes are Uint16; the composite `group*binCount + bin` must stay in range. */
const MAX_COMPOSITE = 0xffff
/**
 * A group with fewer than this many finite points is routed to the EXACT `quartiles` oracle
 * rather than the histogram (the sort is trivially cheap and the histogram-CDF is meaningless
 * for a handful of points).
 */
const MIN_HISTOGRAM_POINTS = 4
/**
 * A group whose per-group histogram populates FEWER than this many bins can't resolve its
 * quartiles (the classic heavy-tail-WITHIN-a-group case: the far outlier stretches the group's
 * own [min,max] so the bulk still collapses into a couple of bins). Route it to the EXACT
 * oracle. A well-spread group populates ~binCount·(coverage) bins and stays on the GPU path.
 */
const MIN_POPULATED_BINS = 8

// ── Device resolution (mirrors aggregateGpu.usableDevice) ─────────────────────

/**
 * Resolve the compute device: an explicitly-passed device (MAY be `null` to force the CPU
 * path) wins; otherwise the shared lazy singleton. Returns a device only when it can
 * actually run the group-reduce (float32 render + blend); else `null` → the CPU oracle.
 */
async function usableDevice(device?: Device | null): Promise<Device | null> {
  const dev = device === undefined ? await getComputeDevice() : device
  if (dev && deviceSupportsGroupReduce(dev)) return dev
  return null
}

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 1
  return p < 0 ? 0 : p > 1 ? 1 : p
}

/** Finite [min,max] extent restricted to points in group `a` OR group `b`. */
function finiteExtentOfGroups(
  values: ArrayLike<number>,
  codes: ArrayLike<number>,
  a: number,
  b: number,
): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  const n = Math.min(values.length, codes.length)
  for (let i = 0; i < n; i++) {
    const g = codes[i]
    if (g !== a && g !== b) continue
    const v = values[i]
    if (Number.isFinite(v)) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  return [lo, hi]
}

/** Collect the finite values of one group code (the CPU-fallback bucketing for M-W). */
function bucketOf(values: ArrayLike<number>, codes: ArrayLike<number>, g: number): number[] {
  const out: number[] = []
  const n = Math.min(values.length, codes.length)
  for (let i = 0; i < n; i++) if (codes[i] === g) out.push(values[i])
  return out
}

// ── Pure histogram → statistics helpers (device-free, unit-testable) ──────────

/**
 * Inverse-CDF quantile of a 1-D histogram at probability `p` ∈ [0,1], assuming each bin's
 * mass is uniformly spread across `[lo+b·w, lo+(b+1)·w]`. Finds the bin where the cumulative
 * count crosses `target = p·n` and interpolates within it: `lo + (b + f)·w`. This APPROXIMATES
 * the R-7 (`quantileSorted`) quantile the CPU oracle uses; the two converge as `binCount`
 * grows (error ≤ ~one bin-width). Empty histogram → `lo`. Pure.
 */
export function histogramQuantile(
  binCounts: ArrayLike<number>,
  dom: BinDomain,
  p: number,
): number {
  let n = 0
  for (let b = 0; b < dom.binCount; b++) n += binCounts[b] ?? 0
  if (n <= 0) return dom.lo
  const target = p * n
  let cum = 0
  for (let b = 0; b < dom.binCount; b++) {
    const c = binCounts[b] ?? 0
    if (c <= 0) continue
    if (target <= cum + c) {
      const f = (target - cum) / c
      return dom.lo + (b + f) * dom.binWidth
    }
    cum += c
  }
  // p at (or past) the upper edge → the top of the last populated bin.
  return dom.lo + dom.binCount * dom.binWidth
}

/**
 * Approximate Tukey box statistics of ONE group's bin-count row: Q1/median/Q3 via
 * {@link histogramQuantile}, IQR + 1.5·IQR fences, and APPROXIMATE outliers. The exact
 * per-value outlier list is unrecoverable from a histogram (positions are bin-quantized), so
 * each populated bin whose CENTER falls beyond a fence contributes AT MOST ONE representative
 * marker at that center — de-duplicated, NEVER `count` copies (H1b: emitting `count` duplicate
 * marks at the identical position both mis-renders the swarm and blows up the outlier array).
 * An empty row → all-zero stat (matches `quartiles`' `empty` verdict). Pure.
 */
export function boxStatFromCounts(
  binCounts: ArrayLike<number>,
  dom: BinDomain,
  group: string,
): BoxStat {
  let n = 0
  for (let b = 0; b < dom.binCount; b++) n += binCounts[b] ?? 0
  if (n <= 0) {
    return { group, q1: 0, median: 0, q3: 0, lowerFence: 0, upperFence: 0, outliers: [] }
  }
  const q1 = histogramQuantile(binCounts, dom, 0.25)
  const median = histogramQuantile(binCounts, dom, 0.5)
  const q3 = histogramQuantile(binCounts, dom, 0.75)
  const iqr = q3 - q1
  const lowerFence = q1 - 1.5 * iqr
  const upperFence = q3 + 1.5 * iqr
  const outliers: number[] = []
  for (let b = 0; b < dom.binCount; b++) {
    const c = binCounts[b] ?? 0
    if (c <= 0) continue
    const center = dom.lo + (b + 0.5) * dom.binWidth
    // One representative marker per outlier BIN (de-duplicated) — not `count` copies.
    if (center < lowerFence || center > upperFence) outliers.push(center)
  }
  return { group, q1, median, q3, lowerFence, upperFence, outliers }
}

/**
 * Reshape a flat `nGroups*binCount` count buffer (a `groupReduce` `count` channel over the
 * composite codes) into per-group approximate `BoxStat[]`, one per category (category order).
 * The parity-testable core of the box GPU branch. Pure + device-free.
 */
export function boxStatsFromReducedCounts(
  counts: ArrayLike<number>,
  categories: readonly string[],
  dom: BinDomain,
): BoxStat[] {
  return categories.map((group, g) => {
    const start = g * dom.binCount
    const row: number[] = new Array(dom.binCount)
    for (let b = 0; b < dom.binCount; b++) row[b] = counts[start + b] ?? 0
    return boxStatFromCounts(row, dom, group)
  })
}

// ── Per-group-domain binning (H1: bin each group over its OWN [min,max]) ──────

/** Exact `BoxStat` for one group via the sort-based `quartiles` oracle (the degenerate path). */
function exactBox(
  values: ArrayLike<number>,
  codes: ArrayLike<number>,
  g: number,
  group: string,
): BoxStat {
  const q = quartiles(bucketOf(values, codes, g))
  return {
    group,
    q1: q.q1,
    median: q.median,
    q3: q.q3,
    lowerFence: q.lowerFence,
    upperFence: q.upperFence,
    outliers: q.outliers,
  }
}

/** Number of populated (non-zero) bins in one group's count row. */
function populatedBins(row: ArrayLike<number>, binCount: number): number {
  let p = 0
  for (let b = 0; b < binCount; b++) if ((row[b] ?? 0) > 0) p++
  return p
}

/**
 * Per-group DOMAINS from per-group [min,max]: `binDomain(min[g],max[g],binCount)`, or `null`
 * when the group is empty (`min > max`) or flat (`min == max` → zero-width). A `null` domain
 * signals "route this group to the exact oracle". Pure.
 */
function domainsFromMinMax(
  min: ArrayLike<number>,
  max: ArrayLike<number>,
  nGroups: number,
  binCount: number,
): (BinDomain | null)[] {
  const out: (BinDomain | null)[] = []
  for (let g = 0; g < nGroups; g++) {
    const lo = min[g]
    const hi = max[g]
    out.push(lo <= hi ? binDomain(lo, hi, binCount) : null)
  }
  return out
}

/**
 * Composite per-point codes `group*binCount + bin` where `bin` is taken over the group's OWN
 * domain (`domains[g]`), NOT a shared global domain. Out-of-range group codes, non-finite
 * values, and points in a null-domain (degenerate/routed) group are mapped to the cull
 * sentinel `nGroups*binCount` so `groupReduce` drops them. Pure + device-free.
 */
function perGroupCompositeCodes(
  values: ArrayLike<number>,
  codes: ArrayLike<number>,
  nGroups: number,
  domains: readonly (BinDomain | null)[],
  binCount: number,
): Uint16Array {
  const n = Math.min(values.length, codes.length)
  const cull = nGroups * binCount
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const g = codes[i]
    const v = values[i]
    if (g < 0 || g >= nGroups || !Number.isFinite(v)) {
      out[i] = cull
      continue
    }
    const dom = domains[g]
    if (!dom) {
      out[i] = cull
      continue
    }
    let b = Math.floor((v - dom.lo) / dom.binWidth)
    if (b < 0) b = 0
    else if (b >= binCount) b = binCount - 1
    out[i] = g * binCount + b
  }
  return out
}

/**
 * Assemble per-group `BoxStat[]` from a flat `nGroups*binCount` composite count buffer (each
 * group's row binned over its OWN `domains[g]`). A group is routed to the EXACT
 * `quartiles` oracle when its domain is degenerate (`null`), it has too few points, or its
 * histogram is too coarse to resolve the box (`< MIN_POPULATED_BINS` populated bins — the
 * heavy-tail-within-a-group case). Otherwise the histogram CDF box is used. Pure + device-free
 * — shared by the GPU branch (counts from the reduce) and the CPU core (counts from a CPU
 * histogram), so the CPU core faithfully simulates the GPU numeric path.
 */
function assembleBoxesFromCounts(
  values: ArrayLike<number>,
  codes: ArrayLike<number>,
  categories: readonly string[],
  binCount: number,
  domains: readonly (BinDomain | null)[],
  counts: ArrayLike<number>,
): BoxStat[] {
  return categories.map((group, g) => {
    const dom = domains[g]
    if (!dom) return exactBox(values, codes, g, group)
    const start = g * binCount
    const row: number[] = new Array(binCount)
    let total = 0
    for (let b = 0; b < binCount; b++) {
      const c = counts[start + b] ?? 0
      row[b] = c
      total += c
    }
    if (total < MIN_HISTOGRAM_POINTS || populatedBins(row, binCount) < MIN_POPULATED_BINS) {
      return exactBox(values, codes, g, group)
    }
    return boxStatFromCounts(row, dom, group)
  })
}

/**
 * DEVICE-FREE simulation of the `boxStatsGpu` per-group-binning path (H1). Computes per-group
 * [min,max] with {@link cpuGroupMinMax}, bins each group over its OWN domain, and assembles
 * boxes with {@link assembleBoxesFromCounts} — the EXACT same domain-building, binning, and
 * routing the GPU branch runs, only with the min/max + count histogram done on the CPU. So
 * this is the parity-testable core of the box GPU branch: its numeric output equals the GPU
 * branch's up to float32 slack. Pure.
 */
export function boxStatsFromColumnBinnedPerGroup(
  dense: Float32Array,
  codes: Uint16Array,
  categories: readonly string[],
  binCount: number = STAT_BIN_COUNT,
): BoxStat[] {
  const bc = Math.max(1, Math.floor(binCount))
  const nGroups = categories.length
  const mm = cpuGroupMinMax(dense, codes, nGroups)
  const domains = domainsFromMinMax(mm.min, mm.max, nGroups, bc)
  const composite = perGroupCompositeCodes(dense, codes, nGroups, domains, bc)
  const counts = new Float32Array(nGroups * bc)
  const cull = nGroups * bc
  for (let i = 0; i < composite.length; i++) {
    const c = composite[i]
    if (c < cull) counts[c]++
  }
  return assembleBoxesFromCounts(dense, codes, categories, bc, domains, counts)
}

/** Per-group mean + population SD + n. Empty group → {NaN,NaN,0} (matches `meanStd`). */
export interface GroupMeanSd {
  readonly mean: number
  readonly std: number
  readonly n: number
}

/**
 * One-pass mean + population SD from a group's reduce channels: `mean = sum/count`,
 * `variance = max(0, sumSq/count − mean²)` (the max() guards catastrophic-cancellation
 * negatives on a flat group). ⚠️ L1: this one-pass form is catastrophic-cancellation-UNSTABLE
 * on float32 for large-offset/small-spread groups (`sumSq` and `count·mean²` are both huge and
 * nearly equal — e.g. values ~1e6 ± 1), so `groupMeanSdGpu` does NOT use it on the live path;
 * it is kept only as the well-conditioned pure-math reference the unit test exercises. Pure.
 */
export function meanSdFromReduced(sum: number, sumSq: number, count: number): GroupMeanSd {
  if (count <= 0) return { mean: NaN, std: NaN, n: 0 }
  const mean = sum / count
  const variance = Math.max(0, sumSq / count - mean * mean)
  return { mean, std: Math.sqrt(variance), n: count }
}

/**
 * Mann-Whitney U + two-sided p from the two groups' bin histograms (SAME bins). Accumulates
 * `U_B = Σ_bin countB·(cumA_below + ½·countA)` (values sharing a bin are treated as tied →
 * the ½ term), takes `U = min(U_B, n1·n2 − U_B)` to match `mannWhitneyU`, and computes p by
 * the same normal approximation (continuity correction + a bin-resolution tie correction).
 * Binning turns near-equal values into ties, so U + p are APPROXIMATE (see
 * `verifySignificanceParity`). Pure + device-free.
 */
export function binApproxMannWhitney(
  cA: ArrayLike<number>,
  cB: ArrayLike<number>,
): MannWhitneyResult {
  const nBins = Math.min(cA.length, cB.length)
  let cumA = 0
  let uB = 0
  let n1 = 0
  let n2 = 0
  let tieCorrection = 0
  for (let j = 0; j < nBins; j++) {
    const a = Math.round(cA[j] ?? 0)
    const b = Math.round(cB[j] ?? 0)
    uB += b * (cumA + 0.5 * a)
    cumA += a
    n1 += a
    n2 += b
    const t = a + b
    if (t > 1) tieCorrection += t * t * t - t
  }
  if (n1 === 0 || n2 === 0) return { u: 0, p: 1 }
  const U = Math.min(uB, n1 * n2 - uB)
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

// ── GPU variants (device → histogram/reduce; no device → the exact CPU oracle) ─

/**
 * GPU variant of `BoxView.boxStatsFromColumn` — SAME `BoxStat[]` shape (category order).
 * Densifies the sparse column, gets per-group [min,max] via a GPU min/max reduction, bins each
 * group over its OWN extent into a group×value-bin composite histogram on the GPU (one
 * `groupReduce` over `nGroups*binCount` buckets), then derives per-group quartiles by CDF
 * interpolation (H1). Per-group binning is what stops a heavy-tail outlier in one group from
 * collapsing every OTHER group's box; any group that is still degenerate/tiny/too-heavy-tailed
 * for its own histogram is routed to the EXACT `quartiles` oracle (`assembleBoxesFromCounts`).
 * APPROXIMATE (bin-resolution-limited — see `verifyBoxStatsParity`, per-group-IQR-relative).
 * Falls back entirely to the EXACT `boxStatsFromColumn` oracle when there is no device or the
 * composite range would overflow the Uint16 codes. The device-free numeric equivalent is
 * `boxStatsFromColumnBinnedPerGroup` (the unit-tested core).
 */
export async function boxStatsGpu(
  col: SparseColumn,
  cat: CategoricalColumn,
  opts: { binCount?: number } = {},
  device?: Device | null,
): Promise<BoxStat[]> {
  const dev = await usableDevice(device)
  if (!dev) return boxStatsFromColumn(col, cat)

  const nGroups = cat.categories.length
  const binCount = Math.max(1, Math.floor(opts.binCount ?? STAT_BIN_COUNT))
  if (nGroups * binCount > MAX_COMPOSITE) return boxStatsFromColumn(col, cat)
  const dense = densify(col)

  // Per-group [min,max] on the GPU → per-group binning domains (H1). Empty/flat groups get a
  // null domain and are routed to the exact oracle in `assembleBoxesFromCounts`.
  const mm = await runGroupMinMaxOnDevice(dev, { values: dense, codes: cat.codes, nGroups })
  const domains = domainsFromMinMax(mm.min, mm.max, nGroups, binCount)

  const composite = perGroupCompositeCodes(dense, cat.codes, nGroups, domains, binCount)
  const zeros = new Float32Array(composite.length) // only the count channel is used
  const r = await runGroupReduceOnDevice(dev, {
    values: zeros,
    codes: composite,
    nGroups: nGroups * binCount,
  })
  return assembleBoxesFromCounts(dense, cat.codes, cat.categories, binCount, domains, r.count)
}

/**
 * EXACT per-group mean + population SD (a building block for a t-test significance option;
 * DEC-26/29). L1: derived from the two-pass `meanStd` oracle per group in BOTH the device and
 * no-device paths. The GPU one-pass `sumSq/count − mean²` form (`meanSdFromReduced`) is
 * catastrophic-cancellation-unstable on float32 for large-offset/small-spread groups, and this
 * function is NOT on the live BoxView path (means there come from `groupMeansFromColumn`), so
 * until a shifted two-pass GPU reduction lands we ship the exact two-pass value rather than a
 * silently-wrong SD. `device` is accepted for signature stability but the result is exact
 * regardless (so `verifyBoxStatsParity`'s mean/SD arm is exact-by-construction).
 */
export async function groupMeanSdGpu(
  col: SparseColumn,
  cat: CategoricalColumn,
  device?: Device | null,
): Promise<GroupMeanSd[]> {
  void device
  const dense = densify(col)
  return cat.categories.map((_, g) => {
    const r = meanStd(bucketOf(dense, cat.codes, g))
    return { mean: r.mean, std: r.std, n: r.n }
  })
}

/**
 * GPU variant of `ViolinView`'s pairwise significance `mannWhitneyU(bucket a, bucket b)` —
 * SAME `MannWhitneyResult` shape and SAME test. Remaps the two group codes to {0,1}, builds
 * a 2×value-bin composite histogram on the GPU, and accumulates the U statistic +
 * normal-approx p from the two count rows (`binApproxMannWhitney`). APPROXIMATE (bin ties;
 * see `verifySignificanceParity`). Falls back to the EXACT `mannWhitneyU` oracle when there
 * is no device, the pooled span is degenerate, or the composite range overflows Uint16.
 */
export async function mannWhitneyUGpu(
  codes: Uint16Array,
  values: Float32Array,
  a: number,
  b: number,
  device?: Device | null,
  opts: { binCount?: number } = {},
): Promise<MannWhitneyResult> {
  const dev = await usableDevice(device)
  if (!dev) return mannWhitneyU(bucketOf(values, codes, a), bucketOf(values, codes, b))

  const binCount = Math.max(1, Math.floor(opts.binCount ?? STAT_BIN_COUNT))
  const [lo, hi] = finiteExtentOfGroups(values, codes, a, b)
  const dom = binDomain(lo, hi, binCount)
  if (!dom || 2 * binCount > MAX_COMPOSITE) {
    return mannWhitneyU(bucketOf(values, codes, a), bucketOf(values, codes, b))
  }

  // Remap a→group 0, b→group 1, everything else → sentinel (≥2) so groupReduce culls it.
  const mapped = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    mapped[i] = codes[i] === a ? 0 : codes[i] === b ? 1 : 2
  }
  const composite = violinCompositeCodes(values, mapped, 2, dom)
  const zeros = new Float32Array(composite.length)
  const r = await runGroupReduceOnDevice(dev, {
    values: zeros,
    codes: composite,
    nGroups: 2 * binCount,
  })
  const cA = r.count.slice(0, binCount)
  const cB = r.count.slice(binCount, 2 * binCount)
  return binApproxMannWhitney(cA, cB)
}

// ── Browser parity verification (orchestrator harness hooks — DEC-27) ─────────

export interface BoxStatsParityReport {
  /**
   * max |GPU − CPU| over q1/median/q3/lowerFence/upperFence, as a FRACTION OF THAT GROUP'S OWN
   * IQR (guarded for IQR==0) — NOT the global value range (H1: a global-range metric hides a
   * per-group box collapsing to a sliver, since one group's tail inflates the global range).
   */
  readonly maxQuartileError: number
  /** max relative error of `groupMeanSdGpu` mean+SD vs the two-pass `meanStd` reference. */
  readonly maxMeanSdError: number
  /** true when BOTH the quartile error and the mean/SD error are within tolerance. */
  readonly ok: boolean
  /** quartile tolerance (fraction of each group's OWN IQR). */
  readonly quartileTolerance: number
  /** mean/SD relative tolerance. */
  readonly meanSdTolerance: number
}

/**
 * Per-group-IQR-relative quartile error between a GPU box set and its CPU oracle: for every
 * group, every box statistic's absolute error is divided by that group's OWN CPU IQR (guarded
 * against a zero IQR), and the max over all groups × stats is returned. This is the H1 metric —
 * a box that collapses to a sliver shows up as a LARGE per-group-IQR error even though its
 * absolute error is tiny relative to a tail-inflated global range. Pure + device-free (shared
 * by `verifyBoxStatsParity` and the unit test).
 */
export function maxPerGroupIqrQuartileError(gpu: readonly BoxStat[], cpu: readonly BoxStat[]): number {
  let worst = 0
  for (let g = 0; g < cpu.length; g++) {
    const gb = gpu[g]
    const cb = cpu[g]
    if (!gb || !cb) continue
    const iqr = cb.q3 - cb.q1
    const denom = Math.max(Math.abs(iqr), 1e-9) // guard IQR==0 (flat/degenerate group)
    for (const [x, y] of [
      [gb.q1, cb.q1],
      [gb.median, cb.median],
      [gb.q3, cb.q3],
      [gb.lowerFence, cb.lowerFence],
      [gb.upperFence, cb.upperFence],
    ] as const) {
      const e = Math.abs(x - y) / denom
      if (e > worst) worst = e
    }
  }
  return worst
}

/**
 * Deterministic HETEROGENEOUS + HEAVY-TAIL fixture shared by `verifyBoxStatsParity` and the
 * unit test (so the browser harness and node exercise the SAME H1 regression case):
 *   • group 0 — bulk pseudo-uniform in [0,10] with ONE far outlier at 10000 (heavy tail WITHIN
 *     the group → its own [min,max] histogram would still collapse → routed to the exact oracle);
 *   • groups 1/2/3 — pseudo-uniform over DISTINCT ranges [0,100] / [0,1000] / [0,10]
 *     (heterogeneous per-group extents — global binning would crush the narrow ones into a few
 *     bins; per-group binning resolves each).
 */
export function heavyTailHeterogeneousFixture(): {
  col: SparseColumn
  cat: CategoricalColumn
  values: Float32Array
  codes: Uint16Array
  categories: string[]
} {
  const categories = ['a', 'b', 'c', 'd']
  const nGroups = categories.length
  const perGroup = 300
  const n = nGroups * perGroup
  const ranges = [10, 100, 1000, 10] // per-group upper extents (heterogeneous)
  const codes = new Uint16Array(n)
  const values = new Float32Array(n)
  let k = 0
  for (let g = 0; g < nGroups; g++) {
    for (let j = 0; j < perGroup; j++) {
      codes[k] = g
      // deterministic pseudo-uniform in [0, ranges[g]).
      values[k] = (((k * 7919) % 10007) / 10007) * ranges[g]
      k++
    }
  }
  // Inject ONE heavy-tail outlier into group 0 (index 0's slot is group 0).
  values[0] = 10000
  const col = sparseFromDense(values)
  const cat: CategoricalColumn = { codes, categories, length: n }
  return { col, cat, values, codes, categories }
}

/** Build a dense-backed `SparseColumn` (row = every index) from a value array. */
function sparseFromDense(values: Float32Array): SparseColumn {
  const row = new Uint32Array(values.length)
  for (let i = 0; i < values.length; i++) row[i] = i
  return { row, value: values, length: values.length }
}

/**
 * Run `boxStatsGpu` + `groupMeanSdGpu` (GPU) AND their CPU oracles on a deterministic
 * multi-group fixture on the passed device, and report agreement. Quartiles are APPROXIMATE
 * (histogram CDF), so the tolerance is a small FRACTION OF THE VALUE RANGE (≈ a few bins),
 * NOT byte-exact; mean/SD are exact-up-to-float. The orchestrator's browser harness exposes
 * this (e.g. `window.__VIZ_TEST__.verifyBoxStatsParity`) so a headless WebGL run proves it.
 */
export async function verifyBoxStatsParity(device: Device): Promise<BoxStatsParityReport> {
  // Per-group-IQR-relative tolerance (H1): each box stat's error is scaled by that group's OWN
  // IQR. At binCount=256 the per-group histogram CDF resolves a quartile to ≈ 1 bin-width; the
  // fences (Q3 + 1.5·IQR, two-quartile-error compounded) are the loosest term. The device-free
  // core measures ≈ 0.014 of each group's IQR on this fixture (the unit test asserts < 0.05); we
  // bound at 0.12 here to allow headroom for the GPU's float32 min/max + count slack.
  const quartileTolerance = 0.12
  const meanSdTolerance = 1e-3

  const { col, cat, values, codes, categories } = heavyTailHeterogeneousFixture()

  const gpuBox = await boxStatsGpu(col, cat, {}, device)
  const cpuBox = boxStatsFromColumn(col, cat)
  const maxQuartileError = maxPerGroupIqrQuartileError(gpuBox, cpuBox)

  const gpuMs = await groupMeanSdGpu(col, cat, device)
  let maxMeanSdError = 0
  for (let g = 0; g < categories.length; g++) {
    const ref = meanStd(bucketOf(values, codes, g))
    const rel = (x: number, y: number) => Math.abs(x - y) / (Math.abs(y) || 1)
    maxMeanSdError = Math.max(maxMeanSdError, rel(gpuMs[g].mean, ref.mean), rel(gpuMs[g].std, ref.std))
  }

  return {
    maxQuartileError,
    maxMeanSdError,
    ok: maxQuartileError <= quartileTolerance && maxMeanSdError <= meanSdTolerance,
    quartileTolerance,
    meanSdTolerance,
  }
}

export interface SignificanceParityReport {
  /** max relative error of the GPU U statistic vs the exact `mannWhitneyU` U. */
  readonly maxURelError: number
  /** max |GPU p − CPU p| over the fixture comparisons. */
  readonly maxPError: number
  /** true when BOTH the U error and the p error are within their bands. */
  readonly ok: boolean
  /** U relative tolerance. */
  readonly uTolerance: number
  /** p-value absolute tolerance band. */
  readonly pTolerance: number
}

/**
 * Run `mannWhitneyUGpu` (GPU histogram U) AND the exact `mannWhitneyU` oracle on a
 * deterministic 3-group fixture (adjacent-group comparisons, like `ViolinView`) on the
 * passed device, and report U + p agreement. The GPU U is APPROXIMATE (bin ties), so the
 * tolerance is a documented BAND — the U relative error and the p-value absolute error. The
 * fixture keeps the SAME Mann-Whitney test on both sides (this proves the GPU path did not
 * silently switch tests). Exposed for the browser harness (e.g.
 * `window.__VIZ_TEST__.verifySignificanceParity`).
 */
export async function verifySignificanceParity(
  device: Device,
): Promise<SignificanceParityReport> {
  const uTolerance = 0.05 // ≤ 5 % of the exact U
  const pTolerance = 0.05 // ≤ 0.05 absolute on the two-sided p-value

  // Deterministic fixture: 900 points, 3 groups with overlapping-but-shifted spreads so the
  // adjacent-group tests are neither trivially identical nor trivially disjoint.
  const n = 900
  const nGroups = 3
  const codes = new Uint16Array(n)
  const values = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const g = i % nGroups
    codes[i] = g
    values[i] = g * 2.5 + ((i * 29) % 17) * 0.5
  }

  let maxURelError = 0
  let maxPError = 0
  for (let i = 0; i + 1 < nGroups; i++) {
    const gpu = await mannWhitneyUGpu(codes, values, i, i + 1, device)
    const cpu = mannWhitneyU(bucketOf(values, codes, i), bucketOf(values, codes, i + 1))
    maxURelError = Math.max(maxURelError, Math.abs(gpu.u - cpu.u) / (Math.abs(cpu.u) || 1))
    maxPError = Math.max(maxPError, Math.abs(gpu.p - cpu.p))
  }

  return {
    maxURelError,
    maxPError,
    ok: maxURelError <= uTolerance && maxPError <= pTolerance,
    uTolerance,
    pTolerance,
  }
}
