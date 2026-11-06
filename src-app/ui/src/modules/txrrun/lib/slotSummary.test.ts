/**
 * ITEM-6 — the ONE slot-summary builder (`lib/slotSummary.ts`, DEC-13 /
 * CONS-UI-RUN-13): the three slot facts come from the intake snapshot (the
 * file names + the ONE validation response), a slot without a file is
 * omitted, the predict count only describes the predict-mode validate, and
 * `runSetupMissing` reports the mode's first missing input for the empty
 * state (DEC-16). All counts are the fixture's own small synthetic numbers
 * (INV-6).
 */
import { describe, expect, it } from 'vitest'
import type { ValidationResponse } from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import { buildSlotSummaries, runSetupMissing } from './slotSummary'

/** The fixture snapshot (train mode, both files, no predict file). */
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
        rows: [['P0001', '214', '1']],
      },
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
    },
    measurements: {
      source: { name: 'measurements.csv', format: 'csv' },
      table: {
        source: { name: 'measurements.csv', format: 'csv' },
        header_row: 1,
        columns: ['patient_id', 'day', 'marker', 'value'],
        rows: [['P0001', '0', 'ldh', '180']],
      },
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
    },
    predictMeasurements: null,
    joins: [],
    mapping: [],
    parameters: { decision_day: 56, baseline_max_day: 0 },
    validation: null,
    ...overrides,
  }
}

/** The ONE validation response (the fixture's small synthetic facts). */
function validation(overrides: Partial<ValidationResponse> = {}): ValidationResponse {
  return {
    patients: { rows: 18, with_primary_outcome: 7, median_followup_days: 84 },
    measurements: { rows: 36, patients: 4, distinct_draw_days: [0, 14, 28] },
    markers: [
      { key: 'ldh', spellings: ['ldh'], n_rows: 20, unit_status: 'matches', coverage: { patients_with_value: 4, patients_with_baseline: 4, patients_with_ontreatment: 4 }, vocabulary: [] },
      { key: 'cea', spellings: ['cea'], n_rows: 16, unit_status: 'matches', coverage: { patients_with_value: 4, patients_with_baseline: 4, patients_with_ontreatment: 4 }, vocabulary: [] },
    ],
    problems: [],
    inventory: {
      baseline_max_day: 0,
      decision_day: 56,
      patients: 18,
      covariates: [],
      markers: [],
    },
    ...overrides,
  }
}

describe('buildSlotSummaries (the E slot lines, ITEM-6)', () => {
  it('renders the three kinds from the file name + the validated facts, in board order', () => {
    const slots = buildSlotSummaries(snapshot({ validation: validation() }))
    expect(slots.map(s => s.kind)).toEqual(['patients', 'measurements'])
    expect(slots[0]).toEqual({
      kind: 'patients',
      sourceName: 'patients.csv',
      summaryText: '18 patients · 7 events',
    })
    expect(slots[1]).toEqual({
      kind: 'measurements',
      sourceName: 'measurements.csv',
      summaryText: '2 markers · draws at day 0, 14, 28',
    })
  })

  it('omits a slot without an adopted file', () => {
    const s = snapshot({ validation: validation() })
    const trainMeasurements = s.measurements
    if (trainMeasurements !== null) {
      s.predictMeasurements = {
        ...trainMeasurements,
        source: { name: 'new_measurements.csv', format: 'csv' },
      }
    }
    const withAll = buildSlotSummaries(s)
    expect(withAll.map(x => x.kind)).toEqual(['patients', 'measurements', 'predict'])
    expect(withAll[2].summaryText).toBeNull() // train-mode validation is NOT the predict cohort
    const withoutMeasurements = buildSlotSummaries({ ...s, measurements: null })
    expect(withoutMeasurements.map(x => x.kind)).toEqual(['patients', 'predict'])
  })

  it('the predict line is the predict-mode cohort count — only for the predict-mode validate', () => {
    const predict = snapshot({
      mode: 'predict',
      intent: 'reuse',
      patients: null,
      measurements: null,
      predictMeasurements: snapshot().measurements,
      validation: validation(),
    })
    const slots = buildSlotSummaries(predict)
    expect(slots.map(x => x.kind)).toEqual(['predict'])
    expect(slots[0].summaryText).toBe('4 patients')
  })

  it('no validation means the name alone (a stale summary is never rendered)', () => {
    const slots = buildSlotSummaries(snapshot())
    expect(slots[0].summaryText).toBeNull()
    expect(slots[0].sourceName).toBe('patients.csv')
  })
})

describe("runSetupMissing (the empty state's named piece, ITEM-6)", () => {
  it('reports the mode inputs in order: patients, then measurements, then predict', () => {
    expect(runSetupMissing(snapshot())).toBeNull()
    expect(runSetupMissing(snapshot({ patients: null }))).toBe('patients')
    expect(runSetupMissing(snapshot({ measurements: null }))).toBe('measurements')
    expect(
      runSetupMissing(
        snapshot({ predictMeasurements: snapshot().measurements }),
      ),
    ).toBeNull()
    expect(
      runSetupMissing(
        snapshot({
          mode: 'predict',
          intent: 'reuse',
          patients: null,
          measurements: null,
          predictMeasurements: null,
        }),
      ),
    ).toBe('predict')
  })
})
