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
 * One finished method's heatmap column. `label` is the method's catalogue id
 * (the mono column header); `group`/`groupLabel` feed the filter bar's group
 * options and the header sublabel. `coverage` is the engine's per-patient
 * coverage record, `null` when the method carried none.
 */
export interface TxrHeatmapColumn {
  methodId: string
  label: string
  group: string
  groupLabel: string
  task: TxrOutcomeKey
  probSource: 'native' | 'recalibrated' | null
  coverage: { scored: number; eligible: number; fraction: number } | null
  /** Aligned to `values`: a null value is an abstain, its note is the aligned entry. */
  values: (number | null)[]
  notes: (string | null)[]
}

/**
 * One patient's heatmap row. `cells` are aligned to the view's columns; a
 * null cell is an abstain (note carried on the column). `average`/`spread`
 * are the visible-cell mean and max−min spread in percentage points
 * (0–100 scale), `null` when the row has no non-null cell (nothing visible
 * to average — the row still renders with empty cells).
 */
export interface TxrHeatmapRow {
  patientId: string
  cells: (number | null)[]
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
