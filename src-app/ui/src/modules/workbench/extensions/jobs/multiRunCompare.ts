// Multi-run compare builder (ITEM-65) — align N runs' params→outcomes into a shared
// metric×run table (the multi-resolution / clustree-style compare: e.g. resolution
// 0.4 / 0.6 / 0.8 side-by-side against their produced cell/cluster observables). Each
// run is a COLUMN; each param + observable is a ROW. A `varies` flag marks a metric
// that isn't constant across the runs (the interesting rows), and `deltas` measure each
// numeric run against the FIRST (baseline) column.
//
// Pure — `MultiRunCompareView` renders from this; the unit test drives it directly.
// Reuses the `RunObservablesEntry` shape from the before/after diff (ITEM-63).

import type { Observables, RunObservablesEntry } from './runDiff'

export type { RunObservablesEntry, Observables } from './runDiff'

/** A cell value in the aligned table — a param/observable value for one run, or null
 *  when that run has no value for the metric. */
export type CompareCell = number | string | null

export interface CompareRow {
  /** The param / observable label (also the row key). */
  key: string
  kind: 'param' | 'observable'
  /** One value per run column (index-aligned to `runs`). */
  values: CompareCell[]
  /** True when the values are not all equal across runs (the tweaked metric). */
  varies: boolean
  /** True when every PRESENT value is numeric (so deltas + a numeric render apply). */
  numeric: boolean
  /** `value − baseline` (baseline = the first run's value) per column; null when either
   *  side is non-numeric / absent. `deltas[0]` is always 0 for a numeric baseline. */
  deltas: (number | null)[]
}

export interface MultiRunCompare {
  runs: { runId: string; label: string }[]
  rows: CompareRow[]
}

/** Coerce an opaque param value into a comparable cell: numbers + strings verbatim,
 *  booleans → their string, null/undefined → null, and any object (a widget recipe) →
 *  a stable JSON string so two identical recipes still compare equal. */
export function coerceCell(v: unknown): CompareCell {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

/** The union of keys across N records, in first-seen order (params/observables keep the
 *  order the first run that has them declared). */
function unionKeys(records: Record<string, unknown>[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k)
        order.push(k)
      }
    }
  }
  return order
}

function buildRow(key: string, kind: 'param' | 'observable', values: CompareCell[]): CompareRow {
  const present = values.filter((v): v is number | string => v !== null)
  // `varies` treats a missing value as its own distinct token so present-vs-absent counts.
  const varies = new Set(values.map(v => (v === null ? '\u0000\u2205' : String(v)))).size > 1
  const numeric = present.length > 0 && present.every(v => typeof v === 'number')
  const baseline = values[0]
  const deltas = values.map(v =>
    typeof v === 'number' && typeof baseline === 'number' ? v - baseline : null,
  )
  return { key, kind, values, varies, numeric, deltas }
}

/** Align N runs' params + observables into a metric×run table. Param rows come first
 *  (the knobs the scientist swept), then observable rows (the outcomes). */
export function buildMultiRunCompare(entries: RunObservablesEntry[]): MultiRunCompare {
  const runs = entries.map(e => ({ runId: e.runId, label: e.label }))
  const paramKeys = unionKeys(entries.map(e => e.params))
  const obsKeys = unionKeys(entries.map(e => e.observables as Observables))
  const rows: CompareRow[] = [
    ...paramKeys.map(k => buildRow(k, 'param', entries.map(e => coerceCell(e.params[k])))),
    ...obsKeys.map(k =>
      buildRow(
        k,
        'observable',
        entries.map(e => (k in e.observables ? e.observables[k] : null)),
      ),
    ),
  ]
  return { runs, rows }
}
