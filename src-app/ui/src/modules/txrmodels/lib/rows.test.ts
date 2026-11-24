/**
 * TEST-MOD-06 — the txrmodels row builders (`lib/rows.ts`, ITEM-4;
 * PROV-UI-MODELS-4, INV-1/2).
 *
 * Pinned behaviors:
 *
 * - `buildPretrainedRows` over the fixture seven-card catalogue + the
 *   fixture verdicts yields the D rows: keys `ps:<catalogue_id>`, the
 *   "slug · day N" mono name, the description tag, the Published /
 *   Learned here chip with the neutral/accent tones, the transfer
 *   performance entry ("other cohorts: AUC <2dp>", the c-index word for a
 *   c_index metric, "not yet checked elsewhere" for a card with no
 *   transfer facts), the three statuses with the board detail lines (via
 *   `txrlist`'s formatters — this file asserts the consumer rows, never a
 *   re-implemented line), the estimated time or none, and the "Model
 *   card" action;
 * - a card the eligibility response does not know is a defensive
 *   `cannot` + NOT_RUNNABLE row (no time) — never silently dropped;
 * - `buildSavedRows` over the fixture ten-model store yields the I rows:
 *   uuid keys, the model's own name, the DEC-13 subtitle, the provenance
 *   chip (Trained by you / Imported / Pretrained with the board tones),
 *   the own-AUC entry with the "not yet cross-checked" fallback, the
 *   statuses, times and the "Details" action;
 * - `buildSavedSections` yields one section per set with the run-facts
 *   subtitle, the row keys, and the Rename / "Delete the run's models"
 *   actions (danger tone on delete) — INV-2's grouping;
 * - the baseline rule: a model whose facts say `needs_baseline` renders
 *   "before treatment only" (DEC-13; the summary does not carry the
 *   facts block today, so the read is the defensive optional read — a
 *   grown response flips the row, an ungrown one keeps the day rule).
 *
 * Every expected string is board copy; every VALUE is the fixture's
 * synthetic one (INV-4). The dates below are TZ-proof by construction:
 * the instant passed to the section builder is a local-noon `new Date`,
 * so the en-GB day-month rendering is the same calendar day in every zone.
 */
import { describe, expect, it } from 'vitest'
import {
  TXRMODELS_J_RESPONSE,
  TXRMODELS_PRETRAINED,
  TXRMODELS_PRETRAINED_ELIGIBILITY,
  TXRMODELS_SAVED,
  TXRMODELS_SAVED_ELIGIBILITY,
  TXRMODELS_SET_A,
  TXRMODELS_SET_B,
} from '../fixtures'
import {
  buildModelTableRows,
  buildPretrainedRows,
  buildSavedRows,
  buildSavedSections,
} from './rows'
import type { ModelSummary, PretrainedListResponse } from '@/api-client/types'

/** A local-noon instant, so the en-GB date rendering is zone-independent. */
function localNoonIso(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString()
}

/** A ready catalogue payload in the list-response shape (the store owns
 *  the fetch; the builder takes the rows slice). */
function catalogue(): PretrainedListResponse {
  return {
    models: TXRMODELS_PRETRAINED,
    origin: 'embedded',
    total: TXRMODELS_PRETRAINED.length,
  }
}

describe('buildPretrainedRows — the D list rows (TEST-MOD-06)', () => {
  it('joins the catalogue cards with the verdicts into the board rows', () => {
    const rows = buildPretrainedRows(catalogue().models, TXRMODELS_PRETRAINED_ELIGIBILITY)
    expect(rows).toHaveLength(7)
    expect(rows.map(row => row.key)).toEqual([
      'ps:ps-1',
      'ps:ps-2',
      'ps:ps-3',
      'ps:ps-4',
      'ps:ps-5',
      'ps:ps-6',
      'ps:ps-7',
    ])
    // The mono name is the catalogue slug + the board's day suffix.
    expect(rows[0].name).toBe('ps-1 · day 60')
    // The tag is the card's one-line description; the chip the kind pill.
    expect(rows[0].tag).toBe('Rule from the paper; colorectal')
    expect(rows[0].chip).toEqual({ label: 'Published rule', tone: 'neutral' })
    expect(rows[1].chip).toEqual({ label: 'Learned here', tone: 'accent' })
  })

  it('renders the transfer performance entry from the metric vocabulary', () => {
    const rows = buildPretrainedRows(catalogue().models, TXRMODELS_PRETRAINED_ELIGIBILITY)
    expect(rows[0].performanceText).toBe('other cohorts: AUC 0.71')
    expect(rows[3].performanceText).toBe('other cohorts: c-index 0.65')
    // A card with no transfer facts (ps-5, ps-7) reads the board constant.
    expect(rows[4].performanceText).toBe('not yet checked elsewhere')
    expect(rows[6].performanceText).toBe('not yet checked elsewhere')
  })

  it('builds the three statuses with the board detail lines and the time entry', () => {
    const rows = buildPretrainedRows(catalogue().models, TXRMODELS_PRETRAINED_ELIGIBILITY)
    // can: clean verdict → the coverage line.
    expect(rows[0].run).toMatchObject({
      status: 'can',
      headline: 'Can run',
      detail: 'all 42 patients',
      disabled: false,
    })
    // 45 s is inside the formatter's "under 1 min" band (the 30 s cutoff).
    expect(rows[0].timeText).toBe('under 1 min')
    // some: DECISION_DAY_UNMET → the coverage shortfall over the missing marker.
    expect(rows[1].run).toMatchObject({
      status: 'some',
      headline: 'Can run for some patients',
      detail: '40 of 42 patients (2 lack LDH)',
    })
    expect(rows[1].timeText).toBe('about 1 min')
    // can with a unit warning → the board's "check the scales" composition.
    expect(rows[2].run.detail).toBe('all 42 patients, check the scales')
    // some: MIN_DRAWS_UNMET → the board's draws line.
    expect(rows[4].run.detail).toBe('needs 3 or more draws; 39 of 42 have them')
    // cannot: the missing-marker line + disabled.
    expect(rows[5].run).toMatchObject({
      status: 'cannot',
      headline: 'Cannot run',
      detail: 'needs Ki-67, not in your file',
      disabled: true,
    })
    expect(rows[5].timeText).toBeNull()
    // cannot: the catalogue's own ASSET_NOT_AVAILABLE reason.
    expect(rows[6].run.detail).toBe("the model file isn't available")
    expect(rows[6].timeText).toBeNull()
    // The row action is the board's link.
    expect(rows[0].action).toEqual({ label: 'Model card' })
  })

  it('defends a card the verdict payload does not know (never silently dropped)', () => {
    const partial = {
      total_fit: 4,
      total_some: 2,
      total_cannot: 0,
      models: TXRMODELS_PRETRAINED_ELIGIBILITY.models.slice(0, 6),
    }
    const rows = buildPretrainedRows(catalogue().models, partial)
    expect(rows).toHaveLength(7)
    expect(rows[6].key).toBe('ps:ps-7')
    expect(rows[6].run).toMatchObject({
      status: 'cannot',
      headline: 'Cannot run',
      detail: 'not available with this build',
      disabled: true,
    })
    expect(rows[6].timeText).toBeNull()
  })

  it('renders no row for a verdict with no catalogue card (the card list is the source)', () => {
    const extra = {
      ...TXRMODELS_PRETRAINED_ELIGIBILITY,
      models: [
        ...TXRMODELS_PRETRAINED_ELIGIBILITY.models,
        { ...TXRMODELS_PRETRAINED_ELIGIBILITY.models[0], id: 'ps-99' },
      ],
    }
    const rows = buildPretrainedRows(catalogue().models, extra)
    expect(rows.map(row => row.key)).not.toContain('ps:ps-99')
    expect(rows).toHaveLength(7)
  })

  it('renders every row as an unavailable fallback when no verdict payload was returned yet', () => {
    const rows = buildPretrainedRows(catalogue().models, null)
    expect(rows).toHaveLength(7)
    expect(rows.every(row => row.run.disabled)).toBe(true)
    expect(rows[0].run.detail).toBe('not available with this build')
  })
})

describe('buildSavedRows — the I list rows (TEST-MOD-06)', () => {
  it('joins the saved models with the verdicts into the board rows', () => {
    const rows = buildSavedRows(TXRMODELS_SAVED, TXRMODELS_SAVED_ELIGIBILITY)
    expect(rows).toHaveLength(10)
    expect(rows[0].key).toBe('a0000000-0000-4000-8000-000000000001')
    // The row name is the model's own display label (the board's mono id
    // is the default at save; a renamed model shows the rename).
    expect(rows[0].name).toBe('fm-1')
    expect(rows[0].tag).toBe('decision day 60')
    expect(rows[0].chip).toEqual({ label: 'Trained by you', tone: 'accent' })
    expect(rows[0].performanceText).toBe('own data, cross-checked: AUC 0.71')
    expect(rows[0].run).toMatchObject({
      status: 'can',
      headline: 'Can run',
      detail: 'all 42 patients',
      disabled: false,
    })
    expect(rows[0].timeText).toBe('under 1 min')
    expect(rows[0].action).toEqual({ label: 'Details' })
  })

  it('renders the not-yet-cross-checked fallback and the unrecorded-requirements line', () => {
    const rows = buildSavedRows(TXRMODELS_SAVED, TXRMODELS_SAVED_ELIGIBILITY)
    expect(rows[1].performanceText).toBe('not yet cross-checked')
    expect(rows[2].run).toMatchObject({
      status: 'cannot',
      detail: "its requirements weren't recorded",
      disabled: true,
    })
    expect(rows[2].timeText).toBeNull()
  })

  it('renders the provenance chips for imported and pretrained rows', () => {
    const imported = { ...TXRMODELS_SAVED[0], provenance: 'imported' as const }
    const pretrained = { ...TXRMODELS_SAVED[0], provenance: 'pretrained' as const }
    const rows = buildSavedRows([imported, pretrained, TXRMODELS_SAVED[0]], null)
    expect(rows[0].chip).toEqual({ label: 'Imported', tone: 'neutral' })
    expect(rows[1].chip).toEqual({ label: 'Ready-made', tone: 'accent' })
    expect(rows[2].chip).toEqual({ label: 'Trained by you', tone: 'accent' })
  })

  it('renders the before-treatment-only subtitle when the model facts say so (DEC-13)', () => {
    // The summary row carries no `marker_facts` block today (it is a
    // detail fact; the store's growth surface) — the builder's defensive
    // read flips the row when the grown payload carries it.
    const baseline = {
      ...TXRMODELS_SAVED[0],
      marker_facts: { needs_baseline: true },
    } as ModelSummary & { marker_facts?: { needs_baseline?: boolean } | null }
    const rows = buildSavedRows([baseline], null)
    expect(rows[0].tag).toBe('before treatment only')
    // The ungrown payload keeps the day rule.
    const plain = buildSavedRows([TXRMODELS_SAVED[1]], null)
    expect(plain[0].tag).toBe('decision day 60')
  })

  it('defends a model the verdict payload does not know', () => {
    const partial = { ...TXRMODELS_SAVED_ELIGIBILITY, models: TXRMODELS_SAVED_ELIGIBILITY.models.slice(0, 3) }
    const rows = buildSavedRows(TXRMODELS_SAVED, partial)
    const missing = rows.find(row => row.key === fixtureId(10))
    expect(missing?.run).toMatchObject({
      status: 'cannot',
      detail: 'not available with this build',
      disabled: true,
    })
    expect(missing?.timeText).toBeNull()
  })
})

function fixtureId(k: number): string {
  return `a0000000-0000-4000-8000-0000000000${String(k).padStart(2, '0')}`
}

describe('buildSavedSections — the I run groups (TEST-MOD-06, INV-2)', () => {
  it('groups one section per set with the run-facts subtitle and the board actions', () => {
    // TZ-proof: the run timestamps are local-noon instants.
    const a = TXRMODELS_SAVED.slice(0, 7).map(model => ({
      ...model,
      trained_at: localNoonIso(2026, 11, 29),
    }))
    const b = TXRMODELS_SAVED.slice(7).map(model => ({
      ...model,
      trained_at: localNoonIso(2026, 10, 9),
    }))
    const built = buildSavedSections(
      [TXRMODELS_SET_A, TXRMODELS_SET_B],
      [...a, ...b],
      TXRMODELS_SAVED_ELIGIBILITY,
    )
    expect(built).toHaveLength(2)
    expect(built[0].key).toBe('set-a')
    expect(built[0].title).toBe('CRC cohort, day 60')
    expect(built[0].subtitle).toBe(
      'trained 29 Nov on patients.csv · 42 patients · 7 models · progression, death by day 240',
    )
    expect(built[0].rowKeys).toHaveLength(7)
    expect(built[1].subtitle).toBe(
      'trained 9 Oct on lung-pilot.csv · 42 patients · 3 models · death by day 165',
    )
    expect(built[1].rowKeys).toHaveLength(3)
    expect(built[1].actions).toEqual([
      { id: 'rename', label: 'Rename', tone: 'default' },
      { id: 'delete', label: "Delete the run's models", tone: 'danger' },
    ])
  })

  it('omits the run-facts segments that have no record (never a blank or a kept "not recorded" word)', () => {
    const models = TXRMODELS_SAVED.slice(0, 7).map(model => ({
      ...model,
      trained_at: undefined,
      trained_on_patients: undefined,
    }))
    const set = { ...TXRMODELS_SET_A, source_label: undefined, model_count: 7 }
    const built = buildSavedSections([set], models, null)
    expect(built[0].subtitle).toBe('7 models · progression, death by day 240')
  })

  it('keeps a set-less summary out of the sections (the J inventory owns it)', () => {
    const orphan = {
      ...TXRMODELS_SAVED[0],
      id: 'a0000000-0000-4000-8000-000000000099',
      set_id: undefined,
      set_name: undefined,
    }
    const built = buildSavedSections(
      [TXRMODELS_SET_A],
      [orphan, ...TXRMODELS_SAVED.slice(0, 7)],
      null,
    )
    expect(built[0].rowKeys).toHaveLength(7)
    expect(built[0].rowKeys).not.toContain(orphan.id)
  })
})

describe('buildModelTableRows — the J one-table rows (TEST-MOD-06)', () => {
  it('renders one set row per known set, newest first, and the no-set model as a plain top-level row (collapsed sets show only their set row)', () => {
    const built = buildModelTableRows(
      [TXRMODELS_SET_A, TXRMODELS_SET_B],
      TXRMODELS_J_RESPONSE.models,
      { expanded: new Set(), focusSetId: null },
    )
    expect(built.map(row => (row.kind === 'set' ? `set:${row.key}` : `model:${row.model.id}`))).toEqual([
      'set:set-a',
      'set:set-b',
      `model:${TXRMODELS_J_RESPONSE.models[2].id}`,
    ])
    // The set-a row holds the set's TWO listed rows (the server's subset)
    // and spells the count the old facts line used — the set's own
    // model_count (7), never the two listed; matchCount is the listed count.
    const setA = built[0]
    expect(setA.kind).toBe('set')
    if (setA.kind === 'set') {
      expect(setA.name).toBe('CRC cohort, day 60')
      expect(setA.set).toEqual(TXRMODELS_SET_A)
      expect(setA.models.map(model => model.method_id)).toEqual([
        'landmark-cox-current',
        'relchange-threshold',
      ])
      expect(setA.modelCount).toBe(7)
      expect(setA.matchCount).toBe(2)
    }
    expect(built[1].kind).toBe('set')
    if (built[1].kind === 'set') expect(built[1].modelCount).toBe(3)
    // COLLAPSED by default: no model row follows any set row.
    expect(built.filter(row => row.kind === 'model')).toHaveLength(1)
    // The no-set model is a top-level plain row (empty Set entry — the page's
    // convention), NOT a group: the builder has no "Not in a set" section.
    const loose = built[2]
    expect(loose.kind).toBe('model')
    if (loose.kind === 'model') {
      expect(loose.model.id).toBe(TXRMODELS_J_RESPONSE.models[2].id)
      expect(loose.inSet).toBe(false)
    }
    const setKeys = built.map(row => (row.kind === 'set' ? row.key : ''))
    expect(setKeys.includes('__none__')).toBe(false)
    expect(setKeys.filter(Boolean)).toEqual(['set-a', 'set-b'])
  })

  it('expands a set row into its model rows (inSet) in the list order; other sets stay collapsed', () => {
    const built = buildModelTableRows(
      [TXRMODELS_SET_A, TXRMODELS_SET_B],
      TXRMODELS_J_RESPONSE.models,
      { expanded: new Set(['set-a']), focusSetId: null },
    )
    expect(built.map(row => (row.kind === 'set' ? `set:${row.key}` : `model:${row.model.id}`))).toEqual([
      'set:set-a',
      `model:${TXRMODELS_J_RESPONSE.models[0].id}`,
      `model:${TXRMODELS_J_RESPONSE.models[3].id}`,
      'set:set-b',
      `model:${TXRMODELS_J_RESPONSE.models[2].id}`,
    ])
    // The set-a rows are flagged inSet (the page indents the Model column).
    for (const row of built) {
      if (row.kind === 'model' && row.model.set_id === 'set-a') expect(row.inSet).toBe(true)
    }
  })

  it('a ?set= focus shows ONLY that set row, always expanded, never the no-set rows', () => {
    const built = buildModelTableRows(
      [TXRMODELS_SET_A, TXRMODELS_SET_B],
      TXRMODELS_J_RESPONSE.models,
      { expanded: new Set(), focusSetId: 'set-a' },
    )
    expect(built.map(row => (row.kind === 'set' ? `set:${row.key}` : `model:${row.model.id}`))).toEqual([
      'set:set-a',
      `model:${TXRMODELS_J_RESPONSE.models[0].id}`,
      `model:${TXRMODELS_J_RESPONSE.models[3].id}`,
    ])
    // The focus set rows are inSet even though the store says collapsed.
    for (const row of built) {
      if (row.kind === 'model') expect(row.inSet).toBe(true)
    }
  })

  it('sends a set_id the sets list does not know to the top level (never a fallback group when the sets read has answered)', () => {
    const ghost = {
      ...TXRMODELS_J_RESPONSE.models[0],
      id: 'a0000000-0000-4000-8000-000000000099',
      set_id: 'set-ghost',
      set_name: 'Ghost set',
    }
    const built = buildModelTableRows([TXRMODELS_SET_A], [ghost, TXRMODELS_J_RESPONSE.models[0]], {
      expanded: new Set(),
      focusSetId: null,
    })
    expect(built.map(row => (row.kind === 'set' ? `set:${row.key}` : `model:${row.model.id}`))).toEqual([
      'set:set-a',
      `model:${ghost.id}`,
    ])
    expect(built[1].kind).toBe('model')
    if (built[1].kind === 'model') expect(built[1].inSet).toBe(false)
  })

  it('omits set rows with no listed model (the server-side q/set filters)', () => {
    const built = buildModelTableRows(
      [TXRMODELS_SET_A, TXRMODELS_SET_B],
      TXRMODELS_J_RESPONSE.models.filter(model => model.set_id === 'set-b'),
      { expanded: new Set(), focusSetId: null },
    )
    expect(built.map(row => (row.kind === 'set' ? `set:${row.key}` : `model:${row.model.id}`))).toEqual([
      'set:set-b',
    ])
  })

  it('degrades to the rows\' own facts while the sets read has not answered (null), newest row first', () => {
    const built = buildModelTableRows(null, TXRMODELS_J_RESPONSE.models, {
      expanded: new Set(['set-a', 'set-b']),
      focusSetId: null,
    })
    // The rows' own set_name names the set rows (never a fabricated title),
    // the set record is null (the facts-line fallback), and the no-set
    // model is the plain top-level row at the end.
    expect(built.map(row => (row.kind === 'set' ? `set:${row.key}` : `model:${row.model.id}`))).toEqual([
      'set:set-a',
      `model:${TXRMODELS_J_RESPONSE.models[0].id}`,
      `model:${TXRMODELS_J_RESPONSE.models[3].id}`,
      'set:set-b',
      `model:${TXRMODELS_J_RESPONSE.models[1].id}`,
      `model:${TXRMODELS_J_RESPONSE.models[4].id}`,
      `model:${TXRMODELS_J_RESPONSE.models[5].id}`,
      `model:${TXRMODELS_J_RESPONSE.models[2].id}`,
    ])
    expect(built[0].kind).toBe('set')
    if (built[0].kind === 'set') {
      expect(built[0].name).toBe('CRC cohort, day 60')
      expect(built[0].set).toBeNull()
      // The record is unknown: the count is the LISTED one.
      expect(built[0].modelCount).toBe(2)
      expect(built[0].matchCount).toBe(2)
    }
    const setB = built[3]
    expect(setB.kind).toBe('set')
    if (setB.kind === 'set') expect(setB.modelCount).toBe(3)
  })

  it('sorts an unparseable created_at last in both comparators (never a NaN placement)', () => {
    const undatedModel = {
      ...TXRMODELS_J_RESPONSE.models[0],
      id: 'a0000000-0000-4000-8000-0000000000e1',
      set_id: 'set-undated',
      set_name: 'Undated set',
      created_at: 'not-a-date',
    }
    // The known-sets comparator: a set whose date does not parse sorts
    // after every dated set (a NaN comparison would leave the position
    // arbitrary).
    const undatedSet = {
      ...TXRMODELS_SET_B,
      id: 'set-undated',
      name: 'Undated set',
      created_at: 'not-a-date',
    }
    const built = buildModelTableRows(
      [undatedSet, TXRMODELS_SET_A, TXRMODELS_SET_B],
      [undatedModel, ...TXRMODELS_J_RESPONSE.models],
      { expanded: new Set(), focusSetId: null },
    )
    expect(
      built
        .filter(row => row.kind === 'set')
        .map(row => (row.kind === 'set' ? row.key : '')),
    ).toEqual(['set-a', 'set-b', 'set-undated'])
    // The fallback comparator (the sets read not answered): the undated
    // group sorts after every dated group, still before the no-set rows.
    const fallback = buildModelTableRows(null, [undatedModel, ...TXRMODELS_J_RESPONSE.models], {
      expanded: new Set(),
      focusSetId: null,
    })
    expect(
      fallback
        .filter(row => row.kind === 'set')
        .map(row => (row.kind === 'set' ? row.key : '')),
    ).toEqual(['set-a', 'set-b', 'set-undated'])
  })
})
