/**
 * TEST-HIST-6 — txrhistory title + model-link builders (PROV-HIST-4,
 * INV-3; ITEM-3).
 *
 * The title matrix pins DEC-9's exact bytes: the train title ("N methods
 * on files…" / "N methods"), the reuse title with the grown `models_used`
 * (GAP-HIST-2 — "Model CRC cohort, day 56 on march_new.csv": ONE distinct
 * set name) and the un-grown honest fallbacks ("Saved models on <file>" /
 * "Saved models"). A name or count the record does not carry is NEVER
 * fabricated — a blank set name, an empty `models_used` list or several
 * distinct sets fall back to the honest "Saved models" form, never an
 * invented title (INV-3, GAP-HIST-2's honesty rule).
 *
 * The board's example facts are DESIGN examples, never data (INV-6): the
 * two board-verbatim rows below pin the formatter output (the boards'
 * words produced from the record's own values), while every other row
 * uses synthetic names and non-board counts.
 *
 * The K copy constants (the board's long strings the components render)
 * are pinned here too, verbatim: the screen subtitle, the footer's
 * trailing sentence and the four filter labels (TESTS.md's named pin —
 * one source in `lib/format.ts` + `types.ts`).
 */
import { describe, expect, it } from 'vitest'
import type { TxrHistoryItem, TxrHistoryModelsMade } from '@/api-client/types'
import { FILTER_OPTIONS } from '../types'
import { HISTORY_SUBTITLE, HISTORY_USAGE_TRAIL } from './format'
import { modelLinks, titleFor } from './title'

/** A synthetic list row (INV-6: synthetic names, non-board counts). */
function item(over: Partial<TxrHistoryItem> = {}): TxrHistoryItem {
  return {
    id: 'run-1',
    bucket: 'finished',
    counts: { finished: 3, failed: 0, stopped: 0, skipped: 0, cannot_run: 0, running: 0, downloading: 0, waiting: 0 },
    mode: 'train',
    created_at: '2026-11-05T10:02:00Z',
    method_count: 3,
    file_names: ['synth-a.csv', 'synth-b.csv'],
    learned_from: 41,
    predicted: 12,
    endpoint: 'pfs',
    decision_day: 42,
    look_ahead_day: 180,
    methods: [{ id: 'method-a', version: '1.0.0', elapsed_secs: 95 }],
    models_made: { produced: 2, saved_sets: [] },
    models_used: [],
    markers: 5,
    markers_saved: false,
    copies_kept: true,
    can_rerun: true,
    can_reopen: true,
    can_download: true,
    dir: '/data/txresbench/analysis-2026-11-05-run-1',
    ...over,
  }
}

describe('titleFor (TEST-HIST-6 — the DEC-9 matrix)', () => {
  it('reads the board train title verbatim: "N methods on files…" (the acceptance row)', () => {
    expect(
      titleFor(item({ method_count: 2, file_names: ['patients.csv', 'new_measurements.csv'] })),
    ).toBe('2 methods on patients.csv + new_measurements.csv')
  })

  it('reads "N methods" when the record names no files (GAP-HS-1 un-grown)', () => {
    expect(titleFor(item({ file_names: [] }))).toBe('3 methods')
    expect(titleFor(item({ method_count: 1, file_names: ['synth-a.csv'] }))).toBe('1 method on synth-a.csv')
    expect(titleFor(item({ method_count: 1, file_names: [] }))).toBe('1 method')
  })

  it('reads the board reuse title verbatim — one distinct set, grown models_used (GAP-HIST-2)', () => {
    expect(
      titleFor(
        item({
          mode: 'reuse',
          method_count: 0,
          file_names: ['march_new.csv'],
          models_used: [{ set_id: 'set-1', set_name: 'CRC cohort, day 56', model_id: 'model-1', model_name: 'm1' }],
        }),
      ),
    ).toBe('Model CRC cohort, day 56 on march_new.csv')
  })

  it('keeps the one-set form when the set was consumed as several models (same set, many model ids)', () => {
    expect(
      titleFor(
        item({
          mode: 'reuse',
          method_count: 0,
          file_names: ['synth-a.csv'],
          models_used: [
            { set_id: 'set-1', set_name: 'cohort A', model_id: 'model-1', model_name: 'm1' },
            { set_id: 'set-1', set_name: 'cohort A', model_id: 'model-2', model_name: 'm2' },
          ],
        }),
      ),
    ).toBe('Model cohort A on synth-a.csv')
  })

  it('falls back to "Saved models on <file>" when the record names no set or more than one (never a fabricated title)', () => {
    expect(titleFor(item({ mode: 'reuse', file_names: ['synth-a.csv'], models_used: [] }))).toBe(
      'Saved models on synth-a.csv',
    )
    expect(
      titleFor(
        item({
          mode: 'reuse',
          file_names: ['synth-a.csv'],
          models_used: [
            { set_id: 'set-1', set_name: 'cohort A', model_id: 'model-1', model_name: 'm1' },
            { set_id: 'set-2', set_name: 'cohort B', model_id: 'model-2', model_name: 'm2' },
          ],
        }),
      ),
    ).toBe('Saved models on synth-a.csv')
    expect(
      titleFor(item({ mode: 'reuse', file_names: [], models_used: [{ set_id: 'set-1', set_name: '', model_id: 'model-1', model_name: 'm1' }] })),
    ).toBe('Saved models')
  })
})

describe('modelLinks (TEST-HIST-6 — named sets only, never a fabricated name)', () => {
  it('returns every named set in the provider order', () => {
    const made: TxrHistoryModelsMade = {
      produced: 2,
      saved_sets: [
        { set_id: 'set-1', set_name: 'cohort A', model_count: 2 },
        { set_id: 'set-2', set_name: 'cohort B', model_count: 1 },
      ],
    }
    expect(modelLinks(made.saved_sets)).toEqual([
      { setId: 'set-1', setName: 'cohort A' },
      { setId: 'set-2', setName: 'cohort B' },
    ])
  })

  it('drops a set with an unrecorded/blank name — never a fabricated link label', () => {
    const made: TxrHistoryModelsMade = {
      produced: 1,
      saved_sets: [
        { set_id: 'set-1', set_name: '', model_count: 1 },
        { set_id: 'set-2', set_name: 'cohort A', model_count: 2 },
        { set_id: 'set-3', set_name: '   ', model_count: 1 },
      ],
    }
    expect(modelLinks(made.saved_sets)).toEqual([{ setId: 'set-2', setName: 'cohort A' }])
  })

  it('returns an empty list for no saved sets', () => {
    expect(modelLinks({ produced: 0, saved_sets: [] }.saved_sets)).toEqual([])
  })
})

describe('K copy constants (TEST-HIST-6 — board verbatim)', () => {
  it('pins the screen subtitle to the board bytes exactly', () => {
    expect(HISTORY_SUBTITLE).toBe(
      'Everything you ran, newest first. Open a result again, or run it again with the same settings.',
    )
  })

  it('pins the footer trailing sentence to the board bytes exactly', () => {
    expect(HISTORY_USAGE_TRAIL).toBe('of stored files. Delete a run to free the space.')
  })

  it('pins the four filter labels to the board bytes exactly', () => {
    expect(FILTER_OPTIONS.map(o => o.label)).toEqual([
      'All runs',
      'Learned and predicted',
      'Predicted with a saved model',
      'Stopped or failed',
    ])
  })
})
