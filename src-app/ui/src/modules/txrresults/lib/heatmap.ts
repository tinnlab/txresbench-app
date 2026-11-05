/**
 * txrresults heatmap view model (ITEM-4; PROV-UR-4) — the PURE derivation
 * from the engine's predictions response to the G/H screens' tables. Nothing
 * here renders, fetches or holds state: `lib/heatmap.ts` maps the provider's
 * `TxrPredictionsResponse` into this node's view model (ITEM-2's types) and
 * computes exactly the numbers the boards show — the per-patient Average and
 * spread, the three sorts, the "Showing N of M" window, and the compare
 * card's report (top-5 intersection, biggest divergences, divergent count).
 *
 * Scale convention (the one rule every renderer needs): the provider's
 * `probabilities`/`average` values are 0–1 fractions (PROV-EE-7, "0–1, null =
 * abstain") and this module stores them VERBATIM in
 * `TxrHeatmapColumn.values` / the row's aligned value array. The 0–100
 * percentage-point display scale appears only in the derived fields:
 * `TxrHeatmapRow.average` and `.spread`, `TxrCompareReport`'s
 * `a`/`b`/`diffPercent` and `sharedTop` `value` — all percentage points,
 * rounded to whole points where a number is DISPLAYED (`buildAvg`,
 * `compareReport`), kept exact where a number is only COMPARED (`spreadOf`).
 * A renderer shows a chance as `formatPct(value * 100)` (the color formula's
 * `v` is the 0–100 value too).
 *
 * DEC-6: the three sorts (average desc — nulls excluded, ties patient id
 * asc; disagree = spread desc; patient = id asc). DEC-5: the response-level
 * `average` is trusted (`averageBy: 'provider'`) only for the unfiltered
 * default view — whenever groups/methodIds/outcome exclude a column the
 * Average recomputes over the visible cells (`averageBy: 'recomputed'`);
 * search and the row window never change it. DEC-7: the compare report caps
 * (3 shared names, 3 divergences) are the named constants below; the
 * divergent window is the named `DIVERGENCE_PP` from `lib/format.ts`.
 *
 * The board's example numbers are never data (INV-5): every fixture and doc
 * here is synthetic.
 */
import type { TxrPredictionsResponse } from '@/api-client/types'
import type {
  TxrCompareReport,
  TxrHeatmapColumn,
  TxrHeatmapRow,
  TxrHeatmapView,
  TxrOutcomeKey,
  TxrSortKey,
} from '../types'
import { DIVERGENCE_PP } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// The report's named caps (DEC-7; the board names 2 on its two-method run —
// a design example, not a max; the capped constants are the copy spec,
// confirmed D43: 3 names / 3 names / 10 points)
// ─────────────────────────────────────────────────────────────────────────────

/** How many patients are "among their five highest chances" (the card's first sentence). */
export const COMPARE_TOP_N = 5

/** The card names at most this many shared top-5 patients. */
export const COMPARE_SHARED_CAP = 3

/** The card names at most this many biggest divergences. */
export const COMPARE_DIFFER_CAP = 3

// ─────────────────────────────────────────────────────────────────────────────
// `normalizeTask` — the per-method task → outcome key (DEC-4, CONS-UR-8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The catalogue/endpoint task spellings this node knows, each mapped to the
 * view's outcome key. The GENERATED `TxrTask` is exactly the three keys
 * (`types.test.ts`'s type-equality pin), so in the shipped wire this map's
 * aliases are defensive: a regen that loosens `task` back to a string keeps
 * the screens correct instead of leaking a raw catalogue word into a tab.
 */
const TASK_TO_OUTCOME: Record<string, TxrOutcomeKey> = {
  // progression-family (the engine's outcome word for pfs is `progression`)
  pfs: 'pfs',
  progression: 'pfs',
  progression_or_death: 'pfs',
  // death-family
  os: 'os',
  death: 'os',
  death_only: 'os',
  // response-family (the engine's response label is `no_response`; the
  // catalogue's `p_fail` is the v1.2 chance-column name for it)
  response: 'response',
  no_response: 'response',
  responder: 'response',
  p_fail: 'response',
}

/**
 * The one outcome key a method column belongs to. `task` is the engine's
 * per-method value (`TxrTask`); `endpoint` is the run's primary outcome and
 * the fallback for a null/unknown task (a mixed run's response methods
 * still land on their own `response` key — DEC-4 — while a method with no
 * declared task follows the run).
 *
 * (The plan's one-argument signature is grown by the fallback: "null/unknown
 * → the run endpoint" needs the endpoint — see DRIFT-1 ITEM-4.)
 */
export function normalizeTask(
  task: string | null | undefined,
  endpoint: TxrOutcomeKey,
): TxrOutcomeKey {
  const key = task?.trim().toLowerCase() ?? ''
  if (key.length === 0) return endpoint
  return TASK_TO_OUTCOME[key] ?? endpoint
}

// ─────────────────────────────────────────────────────────────────────────────
// `buildColumns` — the provider rows → view columns (the ONE wire bridge)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The generated array-union bridge. The wire type of
 * `TxrPredictionMethod.probabilities/notes` is the openapi-generator
 * `Vec<Option<T>>` artifact (`number | null[]` — parses as
 * `number | (null[])`); the WIRE BYTES are always the array, and this is the
 * single place the artifact becomes the view model's `(T | null)[]` (the
 * txrintake `toEngineTable` precedent — DRIFT-1 ITEM-2 #3; the provider regen
 * fix stays the recorded owner's). A non-array (never on the wire) degrades
 * to an empty array rather than a runtime crash.
 */
function asArrayOf<T>(value: T | null[]): (T | null)[] {
  return Array.isArray(value) ? value : []
}

/**
 * One view column per provider method row; nothing is filtered and nothing is
 * dropped (`'finished'` = every row the response carries; the engine serves
 * finished methods only — PROV-EE-7). Values, notes and coverage bind
 * verbatim (0–1 scale, see the file doc); `prob_source: 'none'` maps to null
 * (the column has no probability provenance — INV-3's "never mixed silently"
 * is a per-column discrimination, and the type pin in `types.test.ts`
 * asserts exactly this mapping); `label` is the method's catalogue id (the
 * mono column header, PROV-UR-3); `task` normalizes with the run endpoint as
 * the fallback.
 */
export function buildColumns(
  p: TxrPredictionsResponse,
  endpoint: TxrOutcomeKey,
): TxrHeatmapColumn[] {
  return p.methods.map(m => ({
    methodId: m.method_id,
    label: m.method_id,
    group: m.group,
    groupLabel: m.group_label,
    task: normalizeTask(m.task, endpoint),
    probSource: m.prob_source === 'none' ? null : m.prob_source,
    coverage: m.coverage,
    values: asArrayOf(m.probabilities),
    notes: asArrayOf(m.notes),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// `buildAvg` / `spreadOf` — the per-patient derived numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The patient's Average over the view's visible values, in percentage
 * points: the mean of the non-null values × 100, rounded to a whole point
 * (the board's numeric column; DEC-5 — a null value is an abstain and does
 * not drag the average down). Null when the row has no non-null value
 * (nothing visible to average — the row still renders its empty slots).
 *
 * `cols` is the alignment authority: a row's values are aligned to the
 * view's columns, and the slice keeps values from outside the view out of
 * the mean (a defensive guard, not a recompute boundary — rows are always
 * built for the same columns they are averaged against).
 */
export function buildAvg(row: TxrHeatmapRow, cols: TxrHeatmapColumn[]): number | null {
  const visible = row.cells.slice(0, cols.length)
  let sum = 0
  let count = 0
  for (const value of visible) {
    if (value !== null) {
      sum += value
      count += 1
    }
  }
  if (count === 0) return null
  return Math.round((sum / count) * 100)
}

/**
 * The patient's disagreement spread in percentage points: (max − min) of the
 * non-null values × 100 — the "Methods disagree most" sort key (DEC-6). A
 * row with one non-null value has no spread (0 — a single chance cannot
 * disagree); no non-null value at all → null. Kept exact (not rounded): the
 * value is only COMPARED, never displayed.
 */
export function spreadOf(row: TxrHeatmapRow): number | null {
  let min: number | null = null
  let max: number | null = null
  for (const value of row.cells) {
    if (value === null) continue
    min = min === null ? value : Math.min(min, value)
    max = max === null ? value : Math.max(max, value)
  }
  if (min === null || max === null) return null
  return (max - min) * 100
}

// ─────────────────────────────────────────────────────────────────────────────
// `viewOf` — the sorted/filtered/windowed projection of one outcome tab
// ─────────────────────────────────────────────────────────────────────────────

/** The one view's filters and window (the G screen's controls, PROV-UR-5). */
export interface TxrHeatmapViewOptions {
  /** The active outcome tab; rows/columns restrict to this task's methods. */
  outcome: TxrOutcomeKey
  /** `null` (or an empty selection) = all groups. */
  groups: string[] | null
  /** `null` (or an empty selection) = all methods. */
  methodIds: string[] | null
  /** Case-insensitive patient-id substring; empty/whitespace = no search. */
  search: string
  /** The board's three sort options (DEC-6). */
  sort: TxrSortKey
  /** Row window: the first N after sorting; ≤ 0 = show all (the store's -1 sentinel). */
  limit: number
}

/** A filter set that is null or empty means "no restriction" (the picker's All state). */
function activeSet(ids: string[] | null): Set<string> | null {
  if (ids === null || ids.length === 0) return null
  return new Set(ids)
}

/** The provider's per-patient value as the view's whole-point average. */
function providerAverage(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.round(value * 100)
}

/** Patient-id ascending — the deterministic tie-break of every sort (DEC-6). */
function comparePatientIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Average desc, nulls LAST (a row with nothing visible sorts after every numbered row). */
function compareAverageDesc(a: TxrHeatmapRow, b: TxrHeatmapRow): number {
  if (a.average === null && b.average === null) return comparePatientIds(a.patientId, b.patientId)
  if (a.average === null) return 1
  if (b.average === null) return -1
  if (a.average !== b.average) return b.average - a.average
  return comparePatientIds(a.patientId, b.patientId)
}

/** Spread desc, nulls last (same null/number and tie rules as the average sort). */
function compareSpreadDesc(a: TxrHeatmapRow, b: TxrHeatmapRow): number {
  if (a.spread === null && b.spread === null) return comparePatientIds(a.patientId, b.patientId)
  if (a.spread === null) return 1
  if (b.spread === null) return -1
  if (a.spread !== b.spread) return b.spread - a.spread
  return comparePatientIds(a.patientId, b.patientId)
}

function sortRows(rows: TxrHeatmapRow[], sort: TxrSortKey): TxrHeatmapRow[] {
  switch (sort) {
    case 'average-desc':
      return [...rows].sort(compareAverageDesc)
    case 'disagree':
      return [...rows].sort(compareSpreadDesc)
    case 'patient':
      return [...rows].sort((a, b) => comparePatientIds(a.patientId, b.patientId))
  }
  const _exhaustive: never = sort
  return _exhaustive
}

/**
 * The projection of one outcome tab. Column filters are membership tests,
 * never re-orderings: the columns keep the response's method order (the
 * heatmap's column order is the run's, whatever the picker selected), and the
 * row window applies AFTER the sort so "Show all M" never reorders.
 *
 * `averageBy` (DEC-5): `'provider'` exactly when the view IS the unfiltered
 * default — no group/method filter AND no column was excluded by the outcome
 * tab (then the engine's response-level `average` covers exactly the visible
 * cells, so trusting it is byte-identical to a recompute). Any filter that
 * narrows the columns flips to `'recomputed'`; the search box and the row
 * window leave it untouched.
 */
export function viewOf(
  cols: TxrHeatmapColumn[],
  p: TxrPredictionsResponse,
  opts: TxrHeatmapViewOptions,
): TxrHeatmapView {
  const groups = activeSet(opts.groups)
  const methodIds = activeSet(opts.methodIds)
  const columns = cols.filter(
    c =>
      c.task === opts.outcome &&
      (groups === null || groups.has(c.group)) &&
      (methodIds === null || methodIds.has(c.methodId)),
  )
  const outcomeFilteredAny = cols.some(c => c.task !== opts.outcome)
  const averageBy: TxrHeatmapView['averageBy'] =
    groups === null && methodIds === null && !outcomeFilteredAny ? 'provider' : 'recomputed'

  const allRows = p.patients.map((patientId, i) => {
    const row: TxrHeatmapRow = {
      patientId,
      cells: columns.map(c => c.values[i] ?? null),
      // The row's aligned abstain notes: the cells travel with their notes
      // because the SORTED rows cannot recover the patient's response index
      // from `patientId` (DRIFT-1 ITEM-7) — a row's note array is exactly
      // the aligned pair of its cells array.
      notes: columns.map(c => c.notes[i] ?? null),
      average: null,
      spread: null,
    }
    row.spread = spreadOf(row)
    row.average =
      averageBy === 'provider' ? providerAverage(asArrayOf(p.average)[i]) : buildAvg(row, columns)
    return row
  })

  const needle = opts.search.trim().toLowerCase()
  const searched =
    needle.length === 0 ? allRows : allRows.filter(r => r.patientId.toLowerCase().includes(needle))
  const ordered = sortRows(searched, opts.sort)
  const capped = opts.limit > 0 ? ordered.slice(0, opts.limit) : ordered
  return {
    columns,
    rows: capped,
    shownCount: capped.length,
    totalCount: ordered.length,
    averageBy,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The H compare card's numbers (DEC-7)
// ─────────────────────────────────────────────────────────────────────────────

/** The method's value at a column index; null for an abstain (or a short row). */
function valueAt(row: TxrHeatmapRow, idx: number): number | null {
  return row.cells[idx] ?? null
}

/**
 * The top-5 patients of one method (non-null chances, value desc, ties
 * patient id asc) — the "among their five highest chances" sets.
 */
function topPatients(rows: TxrHeatmapRow[], idx: number): TxrHeatmapRow[] {
  return rows
    .filter(r => valueAt(r, idx) !== null)
    .sort((x, y) => {
      const xv = valueAt(x, idx)
      const yv = valueAt(y, idx)
      if (xv === null || yv === null) return comparePatientIds(x.patientId, y.patientId)
      if (xv !== yv) return yv - xv
      return comparePatientIds(x.patientId, y.patientId)
    })
    .slice(0, COMPARE_TOP_N)
}

/**
 * The compare card's numbers for the VIEW's first two columns (the two
 * compared methods: `cols[0]` = "a", `cols[1]` = "b"; a view with fewer than
 * two columns has nothing to compare — the H screen shows no compare segment
 * on a single-method run):
 *
 * - `sharedTop` — the intersection of the two top-5 sets, at most
 *   `COMPARE_SHARED_CAP` names, ordered by the patient's average desc then
 *   id asc; `value` is that average (whole percentage points).
 * - `mostDiffering` — at most `COMPARE_DIFFER_CAP` patients by |a − b| desc
 *   (ties id asc), `a`/`b` as whole percentage points and `diffPercent` as
 *   the rounded difference. A patient with an abstain in EITHER method has
 *   no numeric %-point difference and is not named.
 * - `divergentCount` — the rows with |a − b| ≥ DIVERGENCE_PP computed on the
 *   EXACT values (the "Show only the patients where they differ" count), so
 *   the report's displayed rounding never flips the threshold.
 */
export function compareReport(
  cols: TxrHeatmapColumn[],
  rows: TxrHeatmapRow[],
): TxrCompareReport {
  if (cols.length < 2) return { sharedTop: [], mostDiffering: [], divergentCount: 0 }

  const inTopB = new Set(topPatients(rows, 1).map(r => r.patientId))
  const shared = topPatients(rows, 0).filter(r => inTopB.has(r.patientId))
  shared.sort((x, y) => {
    if (x.average === null && y.average === null) return comparePatientIds(x.patientId, y.patientId)
    if (x.average === null) return 1
    if (y.average === null) return -1
    if (x.average !== y.average) return y.average - x.average
    return comparePatientIds(x.patientId, y.patientId)
  })
  const sharedTop = shared.slice(0, COMPARE_SHARED_CAP).map(r => ({
    patientId: r.patientId,
    value: r.average ?? 0,
  }))

  const differing = rows
    .map(r => ({ patientId: r.patientId, a: valueAt(r, 0), b: valueAt(r, 1) }))
    .filter((d): d is { patientId: string; a: number; b: number } => d.a !== null && d.b !== null)
    .map(d => ({
      patientId: d.patientId,
      a: Math.round(d.a * 100),
      b: Math.round(d.b * 100),
      diffPercent: Math.abs(Math.round(d.a * 100) - Math.round(d.b * 100)),
    }))
    .sort((x, y) => {
      if (x.diffPercent !== y.diffPercent) return y.diffPercent - x.diffPercent
      return comparePatientIds(x.patientId, y.patientId)
    })
    .slice(0, COMPARE_DIFFER_CAP)

  let divergentCount = 0
  for (const row of rows) {
    const a = valueAt(row, 0)
    const b = valueAt(row, 1)
    if (a !== null && b !== null && Math.abs(a - b) * 100 >= DIVERGENCE_PP) {
      divergentCount += 1
    }
  }

  return { sharedTop, mostDiffering: differing, divergentCount }
}

/**
 * The patient ids where the two methods differ by at least `pp` percentage
 * points (default `DIVERGENCE_PP = 10`) — the "Show only the patients where
 * they differ" row filter. Exact values (never rounded); an abstain in either
 * method is not a %-point difference and never matches; an unknown method id
 * (or an invalid `pp`) matches nothing. Deterministic: the ids come back in
 * the row order given (the page passes the view's already-sorted rows).
 *
 * (Grown from the plan's `(rows, a, b, pp)` signature: the row cells are
 * aligned to the VIEW's columns, so the method-id → column-index mapping
 * needs `cols` — see DRIFT-1 ITEM-4.)
 */
export function divergentPatients(
  cols: TxrHeatmapColumn[],
  rows: TxrHeatmapRow[],
  a: string,
  b: string,
  pp: number = DIVERGENCE_PP,
): string[] {
  if (!Number.isFinite(pp) || pp < 0) return []
  const ia = cols.findIndex(c => c.methodId === a)
  const ib = cols.findIndex(c => c.methodId === b)
  if (ia < 0 || ib < 0) return []
  return rows
    .filter(r => {
      const av = valueAt(r, ia)
      const bv = valueAt(r, ib)
      return av !== null && bv !== null && Math.abs(av - bv) * 100 >= pp
    })
    .map(r => r.patientId)
}

/**
 * The H tables' row order: by the given method's chance desc (nulls last,
 * ties patient id asc) — the board's "sorted by the first method". The input
 * is never mutated; an unknown method id falls back to patient id asc (a
 * deterministic order for a column that is not on screen).
 *
 * (Grown from the plan's `(rows, firstMethodId)` signature for the same
 * column-mapping reason as `divergentPatients` — see DRIFT-1 ITEM-4.)
 */
export function sortByFirstMethod(
  cols: TxrHeatmapColumn[],
  rows: TxrHeatmapRow[],
  firstMethodId: string,
): TxrHeatmapRow[] {
  const idx = cols.findIndex(c => c.methodId === firstMethodId)
  if (idx < 0) return [...rows].sort((a, b) => comparePatientIds(a.patientId, b.patientId))
  return [...rows].sort((a, b) => {
    const av = valueAt(a, idx)
    const bv = valueAt(b, idx)
    if (av === null && bv === null) return comparePatientIds(a.patientId, b.patientId)
    if (av === null) return 1
    if (bv === null) return -1
    if (av !== bv) return bv - av
    return comparePatientIds(a.patientId, b.patientId)
  })
}
