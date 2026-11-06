/**
 * TEST-MOD-07 — the txrmodels filter/sort layer + the totals
 * (`lib/filters.ts`, `lib/total.ts`, ITEM-4; PROC-UI-MODELS-4, DEC-9).
 *
 * Pinned behaviors:
 *
 * - the D chip predicates: "Published rules" keeps exactly
 *   `kind === 'published-rule'`, "Learned by the benchmark" exactly
 *   `kind === 'benchmark-trained'`, "Checked on 2 or more other cohorts"
 *   exactly `transfer.n_cohorts >= 2` (null-checked: a card with no
 *   transfer facts is excluded); the chips are an AND when several are
 *   active; no active chip keeps everything; the built-in count ids
 *   ('all' / 'can-run') are not host predicates and are ignored;
 * - the I "Same outcome as my file" chip: the model's `endpoint` EQUALS
 *   the analysis endpoint AND its `horizon` EQUALS the analysis
 *   look-ahead day — both halves asserted (a chip matching on one half
 *   only is a bug); null analysis facts match nothing;
 * - the four sort comparators per DEC-9 (nulls last, stable order on a
 *   tie): transfer = cohorts desc then median desc; coverage/patients =
 *   coverage fraction desc; time = estimate seconds asc; newest-run =
 *   the trained-at/created-at instant desc; name = id asc;
 * - `filterRows` composes keep + search + sort, the search matches the
 *   row's name/tag/chip and the optional group text (the I board's "Find a
 *   model or run" — the RUN text is the group), case-insensitive, and a
 *   whitespace-only query is no search;
 * - `totalSecondsFor([60, 120, null]) === 180`, `([]) === null`, an
 *   all-unknown selection is null (the bar's "…"), and the selection-map
 *   convenience reads the store's verdict map.
 */
import { describe, expect, it } from 'vitest'
import type { ModelSummary } from '@/api-client/types'
import {
  TXRMODELS_OUTCOME,
  TXRMODELS_PRETRAINED,
  TXRMODELS_SAVED,
} from '../fixtures'
import {
  compareSortable,
  filterRows,
  pretrainedChipPredicate,
  savedChipPredicate,
  type TxrModelSortable,
} from './filters'
import { totalSecondsFor, totalSecondsForSelection } from './total'
import type { TxrListRow } from '@/modules/txrlist'

/** One row-shaped key→fact pair the sort layer reads (the D/I pages build
 *  these from the same fixtures the row builders use). */
function factsOf(id: string, over: Partial<TxrModelSortable> = {}): TxrModelSortable {
  return {
    transferCohorts: null,
    transferMedian: null,
    coverage: null,
    estimateSeconds: null,
    madeAt: null,
    id,
    ...over,
  }
}

function row(key: string, name = key, tag = '', chipLabel = ''): TxrListRow {
  return {
    key,
    name,
    tag,
    chip: chipLabel === '' ? null : { label: chipLabel, tone: 'neutral' },
    performanceText: null,
    run: { status: 'can', headline: 'Can run', detail: 'all 42 patients', disabled: false },
    timeText: null,
    action: null,
  }
}

describe('the D chip predicates (TEST-MOD-07)', () => {
  it('Published rules keeps only the published-rule cards', () => {
    const keep = pretrainedChipPredicate(['published'])
    const kept = TXRMODELS_PRETRAINED.filter(keep)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.every(card => card.kind === 'published-rule')).toBe(true)
  })

  it('Learned by the benchmark keeps only the benchmark-trained cards', () => {
    const keep = pretrainedChipPredicate(['learned'])
    const kept = TXRMODELS_PRETRAINED.filter(keep)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.every(card => card.kind === 'benchmark-trained')).toBe(true)
  })

  it('Checked on 2 or more other cohorts keeps n_cohorts >= 2 and excludes the null-transfer cards', () => {
    const keep = pretrainedChipPredicate(['checked-2-plus'])
    const kept = TXRMODELS_PRETRAINED.filter(keep)
    expect(kept.length).toBeGreaterThan(0)
    for (const card of kept) {
      if (card.transfer) expect(card.transfer.n_cohorts).toBeGreaterThanOrEqual(2)
      else expect.fail('a kept card must carry transfer facts')
    }
    // The null-transfer cards (ps-5, ps-7) are excluded, never matched.
    expect(kept.map(card => card.id)).not.toContain('ps-5')
    expect(kept.map(card => card.id)).not.toContain('ps-7')
  })

  it('is an AND when several chips are active, and constant-true when none is', () => {
    const keepBoth = pretrainedChipPredicate(['published', 'checked-2-plus'])
    const kept = TXRMODELS_PRETRAINED.filter(keepBoth)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.every(card => card.kind === 'published-rule' && (card.transfer?.n_cohorts ?? 0) >= 2)).toBe(true)
    expect(pretrainedChipPredicate([])(TXRMODELS_PRETRAINED[0])).toBe(true)
  })

  it('treats the built-in count ids as non-predicates (a defensive host never breaks a chip)', () => {
    const keep = pretrainedChipPredicate(['all', 'can-run'])
    expect(keep(TXRMODELS_PRETRAINED[0])).toBe(true)
    expect(keep(TXRMODELS_PRETRAINED[6])).toBe(true)
  })
})

describe('the I same-outcome chip (TEST-MOD-07)', () => {
  const pfs240 = TXRMODELS_SAVED[0]
  const os165 = { ...TXRMODELS_SAVED[4], endpoint: 'os' as const, horizon: 165 }
  const pfs165 = { ...TXRMODELS_SAVED[4], endpoint: 'pfs' as const, horizon: 165 }

  it('keeps exactly the models whose endpoint AND horizon match the analysis', () => {
    const keep = savedChipPredicate(['same-outcome'], TXRMODELS_OUTCOME)
    expect(keep(pfs240)).toBe(true)
    // One half matching is a bug: the endpoint matches, the horizon does not.
    expect(keep(pfs165)).toBe(false)
    // The horizon matches, the endpoint does not.
    expect(keep(os165)).toBe(false)
    // The other set's rows (same endpoint, other horizon) are out too.
    expect(keep({ ...TXRMODELS_SAVED[7], endpoint: 'os' as const, horizon: 165 })).toBe(false)
  })

  it('matches nothing when the analysis outcome facts are unknown', () => {
    const keep = savedChipPredicate(['same-outcome'], { endpoint: null, lookAheadDay: null })
    expect(keep(pfs240)).toBe(false)
  })

  it('is constant-true with no active chip (and ignores the D-only ids)', () => {
    expect(savedChipPredicate([], TXRMODELS_OUTCOME)(pfs240)).toBe(true)
    expect(savedChipPredicate(['published'], TXRMODELS_OUTCOME)(pfs240)).toBe(true)
  })
})

describe('compareSortable — the board comparators (DEC-9, TEST-MOD-07)', () => {
  it('Transfer to other cohorts: cohorts desc, then median desc, nulls last', () => {
    const a = factsOf('a', { transferCohorts: 3, transferMedian: 0.71 })
    const b = factsOf('b', { transferCohorts: 3, transferMedian: 0.74 })
    const c = factsOf('c', { transferCohorts: 1, transferMedian: 0.69 })
    const d = factsOf('d') // both null
    // Same cohort count: the higher median sorts first (descending).
    expect(compareSortable('transfer', b, a)).toBeLessThan(0)
    // Fewer cohorts sorts after (descending cohorts).
    expect(compareSortable('transfer', b, c)).toBeLessThan(0)
    // Nulls last regardless of direction.
    expect(compareSortable('transfer', d, a)).toBeGreaterThan(0)
    expect(compareSortable('transfer', a, d)).toBeLessThan(0)
  })

  it('Patients covered (coverage/patients): fraction desc, nulls last', () => {
    const full = factsOf('full', { coverage: 1 })
    const half = factsOf('half', { coverage: 0.5 })
    const no = factsOf('no')
    expect(compareSortable('patients', full, half)).toBeLessThan(0)
    expect(compareSortable('coverage', half, no)).toBeLessThan(0)
    expect(compareSortable('coverage', no, full)).toBeGreaterThan(0)
  })

  it('Time to run: estimate seconds ascending, nulls last', () => {
    const slow = factsOf('slow', { estimateSeconds: 120 })
    const fast = factsOf('fast', { estimateSeconds: 45 })
    const no = factsOf('no')
    expect(compareSortable('time', fast, slow)).toBeLessThan(0)
    expect(compareSortable('time', no, slow)).toBeGreaterThan(0)
  })

  it('Newest run first: the made instant desc, nulls last; Name: id asc', () => {
    const older = factsOf('older', { madeAt: 1_000 })
    const newer = factsOf('newer', { madeAt: 2_000 })
    const no = factsOf('no')
    expect(compareSortable('newest-run', newer, older)).toBeLessThan(0)
    expect(compareSortable('newest-run', no, older)).toBeGreaterThan(0)
    expect(compareSortable('name', factsOf('aa'), factsOf('bb'))).toBeLessThan(0)
    expect(compareSortable('name', factsOf('bb'), factsOf('aa'))).toBeGreaterThan(0)
  })
})

describe('filterRows (TEST-MOD-07)', () => {
  const rows = [
    row('ps:ps-1', 'ps-1 · day 60', 'Rule from the paper; colorectal', 'Published'),
    row('ps:ps-2', 'ps-2 · day 60', 'Colorectal cohort, 84 patients', 'Learned here'),
    row('ps:ps-3', 'ps-3 · day 60', 'Rule from the paper; colorectal', 'Published'),
  ]

  it('applies the key predicate, the search and the sort, in that order', () => {
    const factMap = new Map([
      ['ps:ps-1', factsOf('ps:ps-1', { estimateSeconds: 120 })],
      ['ps:ps-3', factsOf('ps:ps-3', { estimateSeconds: 45 })],
    ])
    const out = filterRows(rows, {
      keep: key => key !== 'ps:ps-2',
      search: 'colorectal',
      sort: 'time',
      sortable: factMap,
    })
    expect(out.map(r => r.key)).toEqual(['ps:ps-3', 'ps:ps-1'])
  })

  it('matches the search case-insensitively against name, tag, chip and the group text', () => {
    const groupText = new Map([['ps:ps-1', 'CRC cohort, day 60']])
    const byTag = filterRows(rows, { keep: () => true, search: 'COLORECTAL' })
    expect(byTag.map(r => r.key)).toEqual(['ps:ps-1', 'ps:ps-2', 'ps:ps-3'])
    const byChip = filterRows(rows, { keep: () => true, search: 'learned here' })
    expect(byChip.map(r => r.key)).toEqual(['ps:ps-2'])
    // The RUN text: "Find a model or run" — the group (section title/subtitle).
    const byGroup = filterRows(rows, {
      keep: () => true,
      search: 'CRC cohort',
      searchGroup: groupText,
    })
    expect(byGroup.map(r => r.key)).toEqual(['ps:ps-1'])
    // A whitespace-only query is no search.
    const noop = filterRows(rows, { keep: () => true, search: '   ' })
    expect(noop).toHaveLength(3)
  })

  it('keeps the incoming order when no sort is requested and stays stable on ties', () => {
    const out = filterRows(rows, { keep: () => true })
    expect(out.map(r => r.key)).toEqual(['ps:ps-1', 'ps:ps-2', 'ps:ps-3'])
    const tied = filterRows(rows, {
      keep: () => true,
      sort: 'time',
      sortable: new Map([
        ['ps:ps-1', factsOf('ps:ps-1', { estimateSeconds: 60 })],
        ['ps:ps-2', factsOf('ps:ps-2', { estimateSeconds: 60 })],
        ['ps:ps-3', factsOf('ps:ps-3', { estimateSeconds: 60 })],
      ]),
    })
    expect(tied.map(r => r.key)).toEqual(['ps:ps-1', 'ps:ps-2', 'ps:ps-3'])
  })

  it('sorts a row with no recorded facts as all-null (last on every direction)', () => {
    const out = filterRows(rows, {
      keep: () => true,
      sort: 'time',
      sortable: new Map([
        ['ps:ps-2', factsOf('ps:ps-2', { estimateSeconds: 30 })],
        ['ps:ps-3', factsOf('ps:ps-3', { estimateSeconds: 45 })],
      ]),
    })
    expect(out.map(r => r.key)).toEqual(['ps:ps-2', 'ps:ps-3', 'ps:ps-1'])
  })
})

describe('totalSecondsFor (DEC-7, TEST-MOD-07)', () => {
  it('sums the known estimates, skips nulls, and returns null for the unknowns', () => {
    expect(totalSecondsFor([60, 120, null])).toBe(180)
    expect(totalSecondsFor([])).toBeNull()
    expect(totalSecondsFor([null, undefined])).toBeNull()
    expect(totalSecondsFor([45])).toBe(45)
    expect(totalSecondsFor([Number.NaN, 30])).toBe(30)
  })

  it('reads the store verdict map through the selection convenience', () => {
    const byKey = new Map([
      ['m-1', { estimated_seconds: 60 }],
      ['m-2', null],
      ['m-3', { estimated_seconds: undefined }],
    ])
    expect(totalSecondsForSelection(new Set(['m-1', 'm-2', 'm-3']), byKey)).toBe(60)
    expect(totalSecondsForSelection(new Set(['m-2', 'm-3']), byKey)).toBeNull()
    expect(totalSecondsForSelection(new Set(), byKey)).toBeNull()
    expect(totalSecondsForSelection(new Set(['m-9']), null)).toBeNull()
  })
})
