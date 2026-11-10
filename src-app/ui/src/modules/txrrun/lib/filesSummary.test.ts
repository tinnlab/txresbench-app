/**
 * ITEM-2 (a) — the ONE compact files-summary builder (`lib/filesSummary.ts`):
 * the plan's one-line summary ("94 patients · 82 events · 2 markers · draws
 * from day 0 to 799 (93 different days)") is built from the intake
 * snapshot's data (the file names + the ONE validation response — the
 * slot-summary rule), the marker count/names are the validated file's
 * resolved columns, the draw segment is the ascending day list (min · max ·
 * distinct count; the single-day honest form), and the Details list is the
 * old slot content verbatim. A null validation falls back to the adopted
 * file names (a just-changed file state never reads stale numbers). All
 * counts are the fixture's own small synthetic numbers (INV-6).
 */
import { describe, expect, it } from 'vitest'
import type { ValidationResponse } from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import { buildFilesSummary } from './filesSummary'

function snapshot(overrides: Partial<IntakeSnapshot> = {}): IntakeSnapshot {
  return {
    intent: 'train',
    mode: 'study',
    study: {
      disease: null,
      treatment: null,
      outcome: null,
      markerGroups: null,
      beforeTreatment: null,
      drawsDuringTreatment: null,
      lastDrawDay: null,
    },
    patients: {
      source: { name: 'patients.csv', format: 'csv' },
      table: {
        source: { name: 'patients.csv', format: 'csv' },
        header_row: 1,
        columns: ['patient_id', 'pfs_days', 'pfs_event'],
        rows: [],
      },
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
      columnOffers: [],
    },
    measurements: {
      source: { name: 'measurements.csv', format: 'csv' },
      table: {
        source: { name: 'measurements.csv', format: 'csv' },
        header_row: 1,
        columns: ['patient_id', 'day', 'marker', 'value'],
        rows: [],
      },
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
      columnOffers: [],
    },
    predictMeasurements: null,
    joins: [],
    mapping: [],
    parameters: { decision_day: 56, baseline_max_day: 0 },
    validation: validation(),
    ...overrides,
  }
}

/** The fixture validation (small synthetic counts, draw days 0..84). */
function validation(): ValidationResponse {
  return {
    patients: {
      rows: 94,
      with_primary_outcome: 82,
      primary_outcome_events: 82,
      median_followup_days: 238,
    },
    measurements: { rows: 1200, patients: 80, distinct_draw_days: [0, 14, 28, 56] },
    markers: [
      {
        key: 'ldh',
        spellings: ['ldh'],
        n_rows: 20,
        unit_status: 'matches',
        coverage: {
          patients_with_value: 4,
          patients_with_baseline: 4,
          patients_with_ontreatment: 4,
        },
        vocabulary: [],
      },
      {
        key: 'cea',
        spellings: ['cea'],
        n_rows: 20,
        unit_status: 'matches',
        coverage: {
          patients_with_value: 4,
          patients_with_baseline: 4,
          patients_with_ontreatment: 4,
        },
        vocabulary: [],
      },
    ],
    problems: [],
    inventory: {
      baseline_max_day: 0,
      decision_day: 56,
      patients: 94,
      covariates: [],
      markers: [],
    },
  }
}

describe('buildFilesSummary (ITEM-2 a)', () => {
  it('builds the one-line summary from the validator facts', () => {
    const facts = buildFilesSummary(snapshot())
    expect(facts.line).toBe(
      '94 patients · 82 events · 2 markers · draws from day 0 to 56 (4 different days)',
    )
    expect(facts.markerNames).toEqual(['ldh', 'cea'])
  })

  it('uses the validator\u2019s events count, never with_primary_outcome', () => {
    const facts = buildFilesSummary(
      snapshot({
        validation: {
          ...validation(),
          patients: {
            rows: 94,
            with_primary_outcome: 90,
            primary_outcome_events: 82,
            median_followup_days: 238,
          },
        },
      }),
    )
    expect(facts.line).toContain('82 events')
  })

  it('the single-draw-day form reads honestly', () => {
    const facts = buildFilesSummary(
      snapshot({
        validation: {
          ...validation(),
          measurements: { rows: 10, patients: 4, distinct_draw_days: [56] },
        },
      }),
    )
    expect(facts.line).toContain('draws at day 56')
  })

  it('a null validation falls back to the adopted file names — never stale numbers', () => {
    const facts = buildFilesSummary(snapshot({ validation: null }))
    expect(facts.line).toBe('patients.csv · measurements.csv')
    expect(facts.markerNames).toEqual([])
    expect(facts.details.map(slot => slot.sourceName)).toEqual([
      'patients.csv',
      'measurements.csv',
    ])
  })

  it('the predict-mode line names the predict cohort and the Details carry the predict slot', () => {
    const facts = buildFilesSummary(
      snapshot({ mode: 'predict', predictMeasurements: snapshot().measurements }),
    )
    expect(facts.line).toContain('to predict')
    expect(facts.details.map(slot => slot.kind)).toEqual([
      'patients',
      'measurements',
      'predict',
    ])
  })

  it('the Details list is the old slot content (the full draw day list)', () => {
    const facts = buildFilesSummary(snapshot())
    expect(facts.details).toHaveLength(2)
    expect(facts.details[1].summaryText).toContain('draws at day 0, 14, 28, 56')
  })
})
