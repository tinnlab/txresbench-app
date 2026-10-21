// blendReduce.ts — PURE Phase-2 blend REDUCE math (BLEND_MODE_PLAN Phase 2). Collapses
// MANY columns of a kind into the ONE (composite-category, aggregated-value) pair the
// Phase-1 blend ENCODE (`computeBlendEncoding`) already consumes — the "reduce" stage that
// is SHARED across plot types (the "encode" stage stays per-plot).
//
//   N categorical columns → CONCATENATE into one COMPOSITE category (the observed
//     cross-product of per-column values, e.g. `(A, X)` → `"A|X"`), stable-ordered by
//     first occurrence, only combinations that actually occur. Its own composite code +
//     name domain → drives the base HUE (or the group-by key of an aggregated chart).
//   M continuous columns → AGGREGATE into one scalar via a selectable operator
//     (mean | sum | min | max | median; default mean). Per the plan's load-bearing rule,
//     each column is NORMALIZED to [0,1] BEFORE aggregating when M ≥ 2 (otherwise a
//     sum/max is dominated by the widest-range column). An optional per-column weight is
//     honored for sum/mean.
//
// This file is PURE (no React/deck/GPU) so the reduce is unit-testable in the node vitest
// pass. `data/engine.ts::computeColoring` calls `reduceBlendColumns` for a MULTI-column
// blend, then feeds the result into the EXISTING `computeBlendEncoding`. A SINGLE
// categorical + SINGLE continuous reduces byte-identically to the Phase-1 inputs (the
// single-column passthrough below), so the Phase-1 render is unchanged.
//
// DOMAIN-NEUTRAL: "categorical columns / continuous columns / aggregate operator /
// composite category" — no gene/cell/cluster/sample vocabulary ("port to finance" litmus).

import { applyScale, type DomainScale } from './color'
import { normalizeMod } from './blend'

/** The operator that collapses M continuous columns to one scalar per point. */
export type BlendAggregateOp = 'mean' | 'sum' | 'min' | 'max' | 'median'

/** Default aggregate operator — `mean` is the sane, range-robust default (plan §Stage 1). */
export const DEFAULT_BLEND_AGGREGATE: BlendAggregateOp = 'mean'

/** The separator joining per-column category values into a composite key (`A|X`). */
export const COMPOSITE_SEPARATOR = '|'

/** The single composite category name when ZERO categorical columns are given. */
export const ALL_CATEGORY_LABEL = '(all)'

/** A categorical column input to the reduce: per-point codes + the code→name table. */
export interface BlendCategoricalInput {
  readonly codes: Uint16Array | Uint32Array | readonly number[]
  readonly categories: readonly string[]
}

/** The composite-category output of `concatCategoricalColumns`. */
export interface ConcatCategoricalResult {
  /** Per-point composite codes indexing `compositeCategories`. */
  readonly compositeCodes: Uint16Array
  /** The observed composite category domain (cross-product, first-occurrence order). */
  readonly compositeCategories: string[]
}

/**
 * Concatenate N categorical columns into ONE composite category per point: the tuple of
 * per-column category values joined by `separator` (`(A, X)` → `"A|X"`). The composite
 * domain is the observed cross-product — ONLY combinations that actually occur, in
 * FIRST-OCCURRENCE (stable, deterministic) order.
 *
 * A SINGLE column is a PASS-THROUGH (original codes copied + the FULL original category
 * list, no occurrence remap) so `reduceBlendColumns` of one categorical + one continuous
 * matches the Phase-1 blend inputs byte-for-byte.
 */
export function concatCategoricalColumns(
  columns: readonly BlendCategoricalInput[],
  opts: { separator?: string } = {},
): ConcatCategoricalResult {
  if (columns.length === 0) {
    return { compositeCodes: new Uint16Array(0), compositeCategories: [] }
  }
  if (columns.length === 1) {
    // Phase-1 parity: keep the ORIGINAL codes + FULL category list (no remap).
    const col = columns[0]
    const n = col.codes.length
    const codes = new Uint16Array(n)
    for (let i = 0; i < n; i++) codes[i] = col.codes[i]
    return { compositeCodes: codes, compositeCategories: [...col.categories] }
  }
  const sep = opts.separator ?? COMPOSITE_SEPARATOR
  const n = columns[0].codes.length
  const keyToCode = new Map<string, number>()
  const compositeCategories: string[] = []
  const codes = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    let key = ''
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c]
      const raw = col.codes[i]
      const name = col.categories[raw] ?? String(raw)
      key = c === 0 ? name : key + sep + name
    }
    let code = keyToCode.get(key)
    if (code === undefined) {
      code = compositeCategories.length
      keyToCode.set(key, code)
      compositeCategories.push(key)
    }
    codes[i] = code
  }
  return { compositeCodes: codes, compositeCategories }
}

/** The aggregated-value output of `aggregateContinuousColumns`. */
export interface AggregateContinuousResult {
  /** The one aggregated scalar per point. */
  readonly value: Float32Array
  /** The finite `[min,max]` of `value` (a degenerate/empty set → `[0,1]`). */
  readonly domain: [number, number]
}

function finiteDomain(lo: number, hi: number): [number, number] {
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : [0, 1]
}

/** Reduce the per-point M-vector of (pre-normalized) column values to one scalar. `weights`
 *  is honored ONLY for `sum`/`mean` (a weighted sum / weighted average); min/max/median
 *  operate on the unweighted values. */
function reduceVector(
  v: Float64Array,
  m: number,
  op: BlendAggregateOp,
  weights: readonly number[] | undefined,
  wSum: number,
): number {
  switch (op) {
    case 'sum': {
      let s = 0
      for (let c = 0; c < m; c++) s += v[c] * (weights ? weights[c] ?? 1 : 1)
      return s
    }
    case 'min': {
      let s = Infinity
      for (let c = 0; c < m; c++) if (v[c] < s) s = v[c]
      return s
    }
    case 'max': {
      let s = -Infinity
      for (let c = 0; c < m; c++) if (v[c] > s) s = v[c]
      return s
    }
    case 'median': {
      const arr = Array.from(v.subarray(0, m)).sort((a, b) => a - b)
      const mid = m >> 1
      return m % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
    }
    default: {
      // mean (weighted average when weights are supplied).
      let s = 0
      for (let c = 0; c < m; c++) s += v[c] * (weights ? weights[c] ?? 1 : 1)
      return wSum > 0 ? s / wSum : 0
    }
  }
}

/**
 * Aggregate M continuous columns into ONE scalar per point via `operator` (default `mean`).
 *
 * - `scale` (log/sqrt) is applied to each raw value FIRST (mirrors the single-channel path).
 * - When M ≥ 2 and `normalizePerColumn` (default true), each column is normalized to `[0,1]`
 *   over its own finite domain BEFORE aggregating (the plan's load-bearing rule — otherwise
 *   a sum/max is dominated by the widest-range column). `weights` scales sum/mean.
 * - When M === 1, the (optionally scaled) column passes straight through RAW (no normalize)
 *   so a lone continuous column keeps its natural domain and the downstream
 *   `computeBlendEncoding` normalizes it exactly as Phase 1 did.
 */
export function aggregateContinuousColumns(
  columns: readonly Float32Array[],
  opts: {
    operator?: BlendAggregateOp
    weights?: readonly number[]
    scale?: DomainScale
    normalizePerColumn?: boolean
  } = {},
): AggregateContinuousResult {
  const m = columns.length
  if (m === 0) return { value: new Float32Array(0), domain: [0, 1] }
  const scale = opts.scale ?? 'linear'
  const n = columns[0].length

  if (m === 1) {
    const out = new Float32Array(n)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < n; i++) {
      const s = applyScale(columns[0][i], scale)
      out[i] = s
      if (Number.isFinite(s)) {
        if (s < lo) lo = s
        if (s > hi) hi = s
      }
    }
    return { value: out, domain: finiteDomain(lo, hi) }
  }

  const operator = opts.operator ?? DEFAULT_BLEND_AGGREGATE
  const normalize = opts.normalizePerColumn ?? true
  // Per-column scaled finite [min,max] for the pre-aggregate [0,1] normalization.
  const colDomains: [number, number][] = columns.map(col => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < col.length; i++) {
      const s = applyScale(col[i], scale)
      if (Number.isFinite(s)) {
        if (s < lo) lo = s
        if (s > hi) hi = s
      }
    }
    return [lo, hi]
  })

  const weights = opts.weights
  let wSum = 0
  if (weights) for (let c = 0; c < m; c++) wSum += weights[c] ?? 1
  else wSum = m

  const out = new Float32Array(n)
  const scratch = new Float64Array(m)
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < m; c++) {
      const raw = applyScale(columns[c][i], scale)
      scratch[c] = normalize
        ? normalizeMod(raw, colDomains[c][0], colDomains[c][1])
        : Number.isFinite(raw)
          ? raw
          : 0
    }
    const a = reduceVector(scratch, m, operator, weights, wSum)
    out[i] = a
    if (Number.isFinite(a)) {
      if (a < lo) lo = a
      if (a > hi) hi = a
    }
  }
  return { value: out, domain: finiteDomain(lo, hi) }
}

/** The input to `reduceBlendColumns`: the categorical + continuous columns + operator. */
export interface BlendReduceInput {
  readonly categoricalColumns: readonly BlendCategoricalInput[]
  readonly continuousColumns: readonly Float32Array[]
  /** Aggregate operator for the continuous columns (default `mean`). */
  readonly operator?: BlendAggregateOp
  /** Optional per-continuous-column weights (sum/mean only). */
  readonly weights?: readonly number[]
  /** Domain transform applied to each continuous value before aggregating (default linear). */
  readonly scale?: DomainScale
  /** Normalize each continuous column to [0,1] before aggregating (default true; M ≥ 2). */
  readonly normalizePerColumn?: boolean
  /** Composite-key separator (default `|`). */
  readonly separator?: string
  /** Point count fallback when there are ZERO categorical columns (else the continuous len). */
  readonly length?: number
}

/** The reduced pair the Phase-1 blend ENCODE consumes: composite codes + names + one value. */
export interface BlendReduceResult {
  readonly compositeCodes: Uint16Array
  readonly compositeCategories: string[]
  readonly aggregatedValue: Float32Array
  readonly valueDomain: [number, number]
}

/**
 * The Phase-2 REDUCE: concat N categorical columns into one composite category AND aggregate
 * M continuous columns into one value, producing the exact (codes, categories, value) shape
 * the Phase-1 `computeBlendEncoding` (hue × lightness) already consumes — and the composite
 * category is directly reusable as an aggregated chart's group-by key.
 *
 * Degenerate inputs are valid: ZERO categorical columns → one `(all)` composite category;
 * ZERO continuous columns → an empty `aggregatedValue` (the caller renders a plain composite
 * hue). One categorical + one continuous → the Phase-1 inputs byte-for-byte.
 */
export function reduceBlendColumns(input: BlendReduceInput): BlendReduceResult {
  const agg = aggregateContinuousColumns(input.continuousColumns, {
    operator: input.operator,
    weights: input.weights,
    scale: input.scale,
    normalizePerColumn: input.normalizePerColumn,
  })

  let compositeCodes: Uint16Array
  let compositeCategories: string[]
  if (input.categoricalColumns.length === 0) {
    const n = input.length ?? input.continuousColumns[0]?.length ?? 0
    compositeCodes = new Uint16Array(n) // all 0 → one category
    compositeCategories = n > 0 ? [ALL_CATEGORY_LABEL] : []
  } else {
    const cc = concatCategoricalColumns(input.categoricalColumns, { separator: input.separator })
    compositeCodes = cc.compositeCodes
    compositeCategories = cc.compositeCategories
  }

  return {
    compositeCodes,
    compositeCategories,
    aggregatedValue: agg.value,
    valueDomain: agg.domain,
  }
}
