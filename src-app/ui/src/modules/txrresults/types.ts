/**
 * txrresults view-model types (PROV-UR-3) — the consumer-side shapes the
 * results screens derive and render from.
 *
 * The engine's generated `Txr*` wire types are provider-owned and regenerated
 * by `execution-engine`; this file is this node's OWN projection of the
 * contract — the pure input of `lib/heatmap.ts` (ITEM-4) and the state types
 * of `stores/Results.store.ts` (ITEM-5). The `buildColumns` mapping is the ONE
 * place provider rows become these columns (values/notes/coverage bound
 * verbatim, `prob_source: 'none'` → `probSource: null`, `task` normalized to
 * `TxrOutcomeKey`); nothing in the module reads the wire types directly.
 */

/**
 * The outcome keys a finished method's `task` normalizes to (DEC-4): a run
 * has one `endpoint` (`pfs` | `os`), but its methods may run MIXED tasks,
 * so the G/H outcome tabs model one key per distinct finished-method task
 * (CONS-UR-8 — the engine's `TxrTask` enum is exactly these three values;
 * pinned by `types.test.ts` type-equality so a regen drift fails here).
 */
export type TxrOutcomeKey = 'pfs' | 'os' | 'response'

/**
 * The G screen's three board sort options ("Sort by", `BusyResults.dc.html`):
 * by the visible-cell Average (desc, nulls excluded), by disagreement
 * (max−min spread of the visible cells, desc), or by patient id (asc).
 * Ties are patient id asc, then method order (DEC-6).
 */
export type TxrSortKey = 'average-desc' | 'disagree' | 'patient'

/**
 * One finished method's heatmap column. `label` is the column's display name
 * (the provider's per-method `label` — the catalogue id for a train run, the
 * SAVED MODEL's name for a reuse run, qa-fixes RES-05); `group`/`groupLabel`
 * feed the filter bar's group options and the header sublabel. `coverage` is
 * the engine's per-patient coverage record, `null` when the method carried
 * none. `constantValue` is the 0–1 value the column gives EVERY patient
 * (null when the column varies or has no value at all — a "gave one chance
 * for everyone" flag, qa-fixes RES-03). `probSource` is the engine's
 * provenance (`converted` = a saved model's training conversion; null = no
 * chances); `flatConversion` is the engine's "the conversion is the flat
 * event-rate map" fact (the score did not track the outcome in the data it
 * was fitted on).
 */
export interface TxrHeatmapColumn {
  methodId: string
  label: string
  group: string
  groupLabel: string
  task: TxrOutcomeKey
  probSource: 'native' | 'recalibrated' | 'converted' | null
  flatConversion: boolean
  coverage: { scored: number; eligible: number; fraction: number } | null
  /** Aligned to `values`: a null value is an abstain, its note is the aligned entry. */
  values: (number | null)[]
  notes: (string | null)[]
  constantValue: number | null
}

/**
 * One patient's heatmap row. `cells` are aligned to the view's columns; a
 * null cell is an abstain and `notes` is the same alignment's per-cell note
 * (the column's response-order note projected to this row — the sortable
 * rows cannot recover the patient's response index from `patientId`, so the
 * note travels WITH the cell, see DRIFT-1 ITEM-7). `average`/`spread` are
 * the visible-cell mean and max−min spread in percentage points (0–100
 * scale), `null` when the row has no non-null cell (nothing visible to
 * average — the row still renders with empty cells).
 */
export interface TxrHeatmapRow {
  patientId: string
  cells: (number | null)[]
  /** Aligned to `cells`: the abstain note for a null cell, null otherwise. */
  notes: (string | null)[]
  average: number | null
  spread: number | null
}

/**
 * The sorted/filtered projection of one outcome tab: `rows` (sorted by the
 * active `TxrSortKey`), `shownCount`/`totalCount` for the "Showing N of M …
 * Show all M" footer, and `averageBy` — `'provider'` exactly when the view is
 * the unfiltered default (the engine's response-level `average` is trusted),
 * `'recomputed'` whenever groups/methodIds/outcome filter the columns (DEC-5).
 */
export interface TxrHeatmapView {
  columns: TxrHeatmapColumn[]
  rows: TxrHeatmapRow[]
  shownCount: number
  totalCount: number
  averageBy: 'provider' | 'recomputed'
  /**
   * qa-fixes4 ITEM-6 (R2-03): the finished columns the view DROPPED — every
   * value null (a predict-only reuse's no-chance column, or a method that
   * abstained for every patient). They are never rendered as dash walls;
   * the page names them (with each column's own reason) in the one line
   * under the table.
   */
  emptyColumns: TxrHeatmapColumn[]
}

/**
 * The H compare card's numbers (DEC-7, the board's two sentences): the names
 * the card shows are capped constants — at most three shared top-5 patients
 * and at most three biggest divergences — plus the divergent row count for
 * the "Show only the patients where they differ" toggle
 * (|a − b| ≥ `DIVERGENCE_PP` in `lib/format.ts`, ITEM-3).
 */
export interface TxrCompareReport {
  /** Intersection of each method's top-5 sets, ≤ 3, deterministic order (average desc, then id asc). */
  sharedTop: { patientId: string; value: number }[]
  /** Top 3 by |a − b|, each with both methods' chances and the difference in percentage points. */
  mostDiffering: {
    patientId: string
    a: number | null
    b: number | null
    diffPercent: number
  }[]
  /** Rows with |a − b| ≥ DIVERGENCE_PP among the two compared methods. */
  divergentCount: number
}
