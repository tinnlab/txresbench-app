/**
 * txrmodels filter/sort layer — PROV-UI-MODELS-4 (ITEM-4).
 *
 * The list component (`TxrSelectList`) NEVER filters (`txrlist` DEC-9: the
 * host passes pre-filtered rows and computes the counts the bar displays);
 * these pure functions are the host-side filtering and sorting of the D and
 * I screens. The source-level chip predicates operate on the PROVIDER
 * records (a row's display text cannot answer "is this a published rule"
 * or "does this outcome match"), and `filterRows` applies the resolved
 * predicate by row key, the search, and the sort over the joined facts
 * (`TxrModelSortable` — the structured fact view the comparators read).
 *
 * Chip vocabulary (types.ts's `TxrModelFilterId`):
 *
 * - `'published'` — D: `kind === 'published-rule'` (the board's "Published
 *   rules" chip);
 * - `'learned'` — D: `kind === 'benchmark-trained'` ("Learned by the
 *   benchmark");
 * - `'checked-2-plus'` — D: `transfer.n_cohorts >= 2` (null-checked: a
 *   card with no transfer facts is excluded — "Checked on 2 or more other
 *   cohorts");
 * - `'same-outcome'` — I: the model's `endpoint` EQUALS the analysis
 *   outcome endpoint AND its `horizon` EQUALS the analysis `look_ahead_day`
 *   (both halves — a chip matching on one half only is a bug; the analysis
 *   facts are the caller's, passed as `TxrOutcomeMatch`: the inventory
 *   carries no endpoint/horizon, so the host resolves them from the
 *   analysis config and passes null when unknown, in which case the chip
 *   matches nothing — a count that is honest about an unset outcome);
 * - `'all'` and `'can-run'` are the list bar's BUILT-IN count chips, not
 *   host predicates — the filter set never carries them (a defensive host
 *   passing one gets the constant-true behavior: the chip predicates are
 *   additive ANDs over the host ids and ignore the rest).
 *
 * The sort comparators (DEC-9, one per board option, named constants
 * behind the `TxrModelSortId` ids): 'transfer' (transfer.n_cohorts desc,
 * then median desc), 'coverage'/'patients' ("Patients covered" —
 * `coverage.fraction` desc; the two ids are one comparator — D and I both
 * draw the option and the txrlist gallery's D story uses 'patients'), 'time'
 * (`estimated_seconds` asc), 'newest-run' (`trained_at ?? created_at`
 * desc), 'name' (id asc — reserved; the boards do not draw it). Every
 * null fact sorts LAST regardless of direction (a row whose verdict is
 * still loading never jumps ahead of a measured one), and a tie keeps the
 * incoming order (Array.prototype.sort stability — the catalogue/list
 * order, DEC-9).
 */
import type { ModelSummary, PretrainedSummary, TxrEndpoint } from '@/api-client/types'
import type { TxrListRow } from '@/modules/txrlist'
import type { TxrModelFilterId, TxrModelSortId } from '../types'

/** The analysis outcome facts the I "Same outcome as my file" chip reads
 *  (the inventory carries no endpoint/horizon — the host resolves them
 *  from the analysis config; null = unknown, the chip matches nothing). */
export interface TxrOutcomeMatch {
  endpoint: TxrEndpoint | null
  lookAheadDay: number | null
}

/**
 * The structured sort facts of one row — the view the comparators read
 * (the row carries display text only). `null` = the fact is absent (a
 * card with no transfer block, a row with no verdict yet, a model with no
 * recorded timestamp): nulls sort last.
 */
export interface TxrModelSortable {
  /** D: `transfer.n_cohorts` (null when the card carries no transfer facts). */
  transferCohorts: number | null
  /** D: `transfer.median` (null when the card carries no transfer facts). */
  transferMedian: number | null
  /** D/I: the verdict's `coverage.fraction` (null when no verdict). */
  coverage: number | null
  /** D/I: the verdict's `estimated_seconds` (null when no verdict or no estimate). */
  estimateSeconds: number | null
  /** I: the model's `trained_at ?? created_at` instant (ms; null unknown). */
  madeAt: number | null
  /** The row's stable id (the 'name' order's key). */
  id: string
}

/** The host chip ids a predicate answers (the count chips are the bar's). */
const HOST_FILTER_IDS: readonly TxrModelFilterId[] = [
  'published',
  'learned',
  'checked-2-plus',
  'same-outcome',
]

/**
 * The D chip predicate over one catalogue card: an AND over the active
 * host chips (multi-active, the store's `filters` set), constant-true when
 * none is active. A foreign id in the active set is ignored (defensive —
 * a predicate never guesses the semantics of a chip it does not own).
 */
export function pretrainedChipPredicate(
  active: ReadonlyArray<TxrModelFilterId>,
): (card: PretrainedSummary) => boolean {
  const wants = active.filter(id => HOST_FILTER_IDS.includes(id))
  if (wants.length === 0) return () => true
  return card => {
    if (wants.includes('published') && card.kind !== 'published-rule') return false
    if (wants.includes('learned') && card.kind !== 'benchmark-trained') return false
    if (
      wants.includes('checked-2-plus') &&
      (card.transfer === null || card.transfer === undefined || card.transfer.n_cohorts < 2)
    ) {
      return false
    }
    return true
  }
}

/**
 * The I chip predicate over one saved model: the "Same outcome as my file"
 * chip's both-halves rule (endpoint match AND horizon match) plus the
 * D-only chip ids accepted as no-ops (a predicate never answers a chip a
 * screen does not draw, and the width of the union keeps the store's
 * shared `filters` state type-safe for both screens). With null analysis
 * facts the chip matches nothing — honest, never a guessed outcome.
 */
export function savedChipPredicate(
  active: ReadonlyArray<TxrModelFilterId>,
  outcome: TxrOutcomeMatch,
): (model: ModelSummary) => boolean {
  const wants = active.filter(id => HOST_FILTER_IDS.includes(id))
  if (wants.length === 0) return () => true
  return model => {
    if (wants.includes('same-outcome')) {
      if (outcome.endpoint === null || outcome.lookAheadDay === null) return false
      if (model.endpoint !== outcome.endpoint) return false
      if (model.horizon !== outcome.lookAheadDay) return false
    }
    return true
  }
}

/** `null`-aware numeric compare: nulls last, direction applies to values. */
function compareNumber(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * direction
}

/**
 * One comparator per sort id, pure over the sort facts. `'coverage'` and
 * `'patients'` are the same comparator — the two ids are the D/I spellings
 * of the board's "Patients covered" (the txrlist gallery's D story already
 * uses `'patients'`; the union keeps both for the option tables). `'name'`
 * is the reserved id-asc ordering. The comparator is TOTAL (every fact
 * pair resolves): a stable sort keeps ties in the incoming order.
 */
export function compareSortable(
  sort: TxrModelSortId,
  a: TxrModelSortable,
  b: TxrModelSortable,
): number {
  switch (sort) {
    case 'transfer': {
      const cohorts = compareNumber(a.transferCohorts, b.transferCohorts, -1)
      if (cohorts !== 0) return cohorts
      return compareNumber(a.transferMedian, b.transferMedian, -1)
    }
    case 'coverage':
    case 'patients':
      return compareNumber(a.coverage, b.coverage, -1)
    case 'time':
      return compareNumber(a.estimateSeconds, b.estimateSeconds, 1)
    case 'newest-run':
      return compareNumber(a.madeAt, b.madeAt, -1)
    case 'name':
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

/** The options a host passes to `filterRows` (see the file header). */
export interface TxrRowFilterOptions {
  /**
   * The resolved source predicate, by row key: a `pretrainedChipPredicate`
   * / `savedChipPredicate` composed with the row keys the builders
   * produced (D rows key `ps:<id>`, I rows the model id), or the constant
   * `() => true` when no chip is active.
   */
  keep: (key: string) => boolean
  /** The find-a-model box text (screen I; '' = no search — the D board
   *  has no search box). A whitespace-only query is no search. */
  search?: string
  /** The active sort id, or null/undefined to keep the incoming order. */
  sort?: TxrModelSortId | null
  /** The per-key sort facts (a key absent from the map sorts as all-null —
   *  last on every direction, preserving the incoming order among peers). */
  sortable?: ReadonlyMap<string, TxrModelSortable | null>
  /** Per-key extra searchable text — the I host passes the set's title +
   *  subtitle so "Find a model or run" matches the RUN (INV-1's search box
   *  reads "Find a model or run", not just a model). */
  searchGroup?: ReadonlyMap<string, string>
}

/**
 * `filterRows`: the host-side filter+search+sort over the built rows. The
 * built rows come in catalogue/list order; the chip predicate is applied
 * by `keep(key)` (the host composes it over its own source records — this
 * function never sees the provider shapes), then the search narrows to the
 * rows whose name/tag/chip (and group text, when passed) contain the query
 * (case-insensitive), then the sort reorders per `sort` — the incoming
 * order produced before any host chip is applied.
 */
export function filterRows(
  rows: ReadonlyArray<TxrListRow>,
  opts: TxrRowFilterOptions,
): TxrListRow[] {
  const query = (opts.search ?? '').trim().toLowerCase()
  const kept = rows.filter(row => opts.keep(row.key))
  const searched =
    query.length === 0
      ? [...kept]
      : kept.filter(row => {
          const group = opts.searchGroup?.get(row.key) ?? ''
          const haystack = `${row.name} ${row.tag} ${row.chip?.label ?? ''} ${group}`.toLowerCase()
          return haystack.includes(query)
        })
  const sort = opts.sort
  if (sort === null || sort === undefined) return searched
  const facts = opts.sortable ?? new Map<string, TxrModelSortable | null>()
  return searched.sort((a, b) =>
    compareSortable(sort, facts.get(a.key) ?? EMPTY_SORTABLE, facts.get(b.key) ?? EMPTY_SORTABLE),
  )
}

/** The all-null fact view for a row with no recorded facts: last on every
 *  direction, equal to every other all-null peer (stable order kept). */
const EMPTY_SORTABLE: TxrModelSortable = {
  transferCohorts: null,
  transferMedian: null,
  coverage: null,
  estimateSeconds: null,
  madeAt: null,
  id: '',
}
