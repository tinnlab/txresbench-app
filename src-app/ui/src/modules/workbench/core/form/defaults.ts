// Data-driven param defaults + the MAD helper (W6, ITEM-64). Generalizes input economy
// (ITEM-21) beyond "auto-pick the sole artifact" to "compute a smart default FROM the
// data": a number field may declare a `defaultResolver` that derives its default from a
// robust `DataSummary` of the selected input (e.g. a MAD-based QC rule contributed as
// DATA — N MADs on a log-scaled count column, plus a ceiling on a ratio column). Pure
// + framework-free: the
// stats compute over a `DataCtx` (resident client columns in the app; the fixture ctx in
// tests), the resolver is a plain function of the summary. The resolver is FE-runtime-only
// and non-serializable, exactly like ITEM-37's `optionsResolver`.
//
// This used to add "and `projectParamsForMcp` already drops function-valued props, so the MCP
// tool schema keeps the static `default`". That is no longer true of anything: the form
// projection was deleted with the stepped/code-form shapes it existed to normalise, so NO form
// schema reaches the MCP surface at all — the contribution catalog projects `appliesTo` (input
// slots + type constraints), which carries no defaults and no functions to strip. Nothing about
// the resolver's own contract changed; only the claim about what happens downstream of it.

import type { ValueRef } from '../columns/ref.ts'
import type { DataCtx } from '../columns/resolve.ts'
import { resolveColumn } from '../columns/resolve.ts'

/** Robust per-column stats over the COVERED (non-NA, finite) cells of one column. */
export interface ColumnStats {
  /** covered (non-NA, finite) cell count. */
  n: number
  /** the median of the covered values (NaN when none). */
  median: number
  /** the median absolute deviation (raw, unscaled; NaN when none). */
  mad: number
}

/** The data summary a resolver reads — robust stats keyed by a caller-chosen key. */
export interface DataSummary {
  /** total rows in the summarized input (the ctx's position-universe size `ctx.n`). */
  n: number
  /** robust stats per column, keyed by a stable name the resolver looks up. */
  columns: Record<string, ColumnStats>
}

/**
 * A data-driven default RESOLVER (ITEM-64): derive a number field's default from the
 * selected input's `DataSummary`. Returns `undefined` to decline (→ fall back to the
 * field's static `default`). Additive: a field WITHOUT a resolver is unchanged.
 */
export type DataDrivenDefaultResolver = (summary: DataSummary) => number | undefined

/** The median of a NON-EMPTY ascending-sorted array. */
function medianSorted(sorted: number[]): number {
  const m = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

/** Median + MAD of a raw value list (empty → NaN stats). */
export function statsOf(values: number[]): ColumnStats {
  const clean = values.filter(v => Number.isFinite(v))
  if (clean.length === 0) return { n: 0, median: Number.NaN, mad: Number.NaN }
  const sorted = [...clean].sort((a, b) => a - b)
  const median = medianSorted(sorted)
  const devs = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b)
  return { n: clean.length, median, mad: medianSorted(devs) }
}

/** Robust stats for a value ref over a ctx (covered, finite cells). An unresolvable ref
 *  (an unresolvable feature ref / missing column) → empty stats (NaN) — never throws. */
export function columnStats(ctx: DataCtx, ref: ValueRef): ColumnStats {
  let values: number[] = []
  try {
    const col = resolveColumn(ref, ctx)
    values = []
    for (let i = 0; i < col.values.length; i++) {
      if (!col.na[i] && Number.isFinite(col.values[i])) values.push(col.values[i])
    }
  } catch {
    return { n: 0, median: Number.NaN, mad: Number.NaN }
  }
  return statsOf(values)
}

/** Build a `DataSummary` for a set of named refs over a ctx (best-effort; an
 *  unresolvable ref contributes NaN stats but is still keyed, so a resolver can decline). */
export function buildDataSummary(ctx: DataCtx, refs: Array<{ key: string; ref: ValueRef }>): DataSummary {
  const columns: Record<string, ColumnStats> = {}
  for (const { key, ref } of refs) columns[key] = columnStats(ctx, ref)
  return { n: ctx.n, columns }
}

/** The MAD threshold `median ± nMads·MAD` (the sc-best-practices QC outlier rule).
 *  `side:'lower'` = a floor (`median − nMads·MAD`), `'upper'` = a ceiling. NaN stats
 *  (no covered data) → NaN (the caller declines by returning `undefined`). */
export function madThreshold(stats: ColumnStats, nMads: number, side: 'lower' | 'upper'): number {
  if (!Number.isFinite(stats.median) || !Number.isFinite(stats.mad)) return Number.NaN
  return side === 'lower' ? stats.median - nMads * stats.mad : stats.median + nMads * stats.mad
}

/** A ready-made MAD default resolver over a summary column (ITEM-64). Declines (→
 *  undefined) when the column is absent or has no covered data. `round` snaps to an
 *  integer (count columns) — off by default (continuous ratio metrics). */
export function madResolver(
  columnKey: string,
  nMads: number,
  side: 'lower' | 'upper',
  opts: { round?: boolean; clampMin?: number } = {},
): DataDrivenDefaultResolver {
  return summary => {
    const stats = summary.columns[columnKey]
    if (!stats) return undefined
    const raw = madThreshold(stats, nMads, side)
    if (!Number.isFinite(raw)) return undefined
    let v = raw
    if (opts.clampMin !== undefined) v = Math.max(opts.clampMin, v)
    return opts.round ? Math.round(v) : v
  }
}

/** Resolve a field's data-driven default, or `undefined` when it has none / declines. */
export function resolveDataDrivenDefault(
  resolver: DataDrivenDefaultResolver | undefined,
  summary: DataSummary,
): number | undefined {
  if (!resolver) return undefined
  const v = resolver(summary)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
