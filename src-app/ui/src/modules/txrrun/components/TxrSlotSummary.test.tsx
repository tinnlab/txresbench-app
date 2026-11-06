// @vitest-environment jsdom
/**
 * TEST-RUN-13 — the E screen's slot lines (`components/TxrSlotSummary.tsx`,
 * ITEM-6; PROV-UI-RUN-4): the three board chips render the store data (the
 * adopted file's name + the validation-provided summary) and omit a slot
 * without a file; the board labels are verbatim; "Change files" fires the
 * callback once.
 *
 * The DATA is the point of the pin: the component is presentational and the
 * slots come from `buildSlotSummaries` over the seeded intake store (the ONE
 * builder, DEC-13) — the board's example counts never appear as expected
 * values; every count asserted here is the fixture's own small synthetic
 * number (INV-6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { LoadedFile, TxrIntakeState } from '@/modules/txrintake'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { TxrSlotSummary } from './TxrSlotSummary'
import { buildSlotSummaries } from '../lib/slotSummary'

/** The fixture's small synthetic file (the board's 151 patients never here). */
function loaded(name: string): LoadedFile {
  return {
    source: { name, format: 'csv' },
    table: {
      source: { name, format: 'csv' },
      header_row: 1,
      columns: ['patient_id', 'day', 'marker', 'value'],
      rows: [['P0001', '0', 'ldh', '180']],
    },
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],
  }
}

/** The fixture's one validated summary (small synthetic counts). */
function validation() {
  return {
    patients: { rows: 18, with_primary_outcome: 7, median_followup_days: 84 },
    measurements: { rows: 36, patients: 4, distinct_draw_days: [0, 14, 28] },
    markers: [
      { key: 'ldh', spellings: ['ldh'], n_rows: 20, unit_status: 'matches' as const, coverage: { patients_with_value: 4, patients_with_baseline: 4, patients_with_ontreatment: 4 }, vocabulary: [] },
    ],
    problems: [],
    inventory: {
      baseline_max_day: 0,
      decision_day: 56,
      patients: 18,
      covariates: [],
      markers: [],
    },
  }
}

/** Seed the store with the mode's files + the ONE validated summary. */
function seedStore(overrides: Partial<TxrIntakeState> = {}) {
  useTxrIntakeStore.setState({
    mode: 'study',
    patients: loaded('patients.csv'),
    measurements: loaded('measurements.csv'),
    predictMeasurements: null,
    validation: validation(),
    ...overrides,
  })
}

const store = () => useTxrIntakeStore.getState()

beforeEach(() => {
  window.localStorage.clear()
  store().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrSlotSummary (E slot lines, TEST-RUN-13)', () => {
  it('renders the board labels and the store data verbatim per slot', () => {
    seedStore({ predictMeasurements: loaded('new_measurements.csv') })
    const slots = buildSlotSummaries(store())
    render(<TxrSlotSummary slots={slots} onChangeFiles={() => undefined} />)

    expect(screen.getByText('Patients')).toBeTruthy()
    expect(screen.getByText('Measurements')).toBeTruthy()
    expect(screen.getByText('Predict')).toBeTruthy()
    const patients = screen.getByTestId('txr-run-slots-patients')
    expect(patients.textContent).toBe('Patients patients.csv · 18 patients · 7 events')
    const measurements = screen.getByTestId('txr-run-slots-measurements')
    expect(measurements.textContent).toBe(
      'Measurements measurements.csv · 1 marker · draws at day 0, 14, 28',
    )
    // The train-mode validation describes the TRAIN tables — the predict
    // chip renders the name alone (a wrong count is never shown).
    expect(screen.getByTestId('txr-run-slots-predict').textContent).toBe(
      'Predict new_measurements.csv',
    )
  })

  it('the predict chip carries the predict-mode cohort count (the predict-mode validate)', () => {
    seedStore({
      mode: 'predict',
      patients: null,
      measurements: null,
      predictMeasurements: loaded('new_measurements.csv'),
    })
    const slots = buildSlotSummaries(store())
    render(<TxrSlotSummary slots={slots} onChangeFiles={() => undefined} />)
    const predict = screen.getByTestId('txr-run-slots-predict')
    expect(predict.textContent).toBe('Predict new_measurements.csv · 4 patients')
  })

  it('omits a slot without data (no file = no chip, nothing half-drawn)', () => {
    seedStore({ measurements: null })
    const slots = buildSlotSummaries(store())
    render(<TxrSlotSummary slots={slots} onChangeFiles={() => undefined} />)
    expect(screen.getByTestId('txr-run-slots-patients')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-slots-measurements')).toBeNull()
    expect(screen.queryByTestId('txr-run-slots-predict')).toBeNull()
  })

  it('renders the name alone when the store carries no validation for the current state', () => {
    seedStore({ validation: null })
    const slots = buildSlotSummaries(store())
    render(<TxrSlotSummary slots={slots} onChangeFiles={() => undefined} />)
    expect(screen.getByTestId('txr-run-slots-patients').textContent).toBe('Patients patients.csv')
    expect(screen.getByTestId('txr-run-slots-measurements').textContent).toBe(
      'Measurements measurements.csv',
    )
  })

  it('fires onChangeFiles exactly once from the Change files affordance', () => {
    seedStore()
    const onChangeFiles = vi.fn()
    render(
      <TxrSlotSummary
        slots={buildSlotSummaries(store())}
        onChangeFiles={onChangeFiles}
      />,
    )
    const button = screen.getByTestId('txr-run-change-files')
    fireEvent.click(button)
    expect(onChangeFiles).toHaveBeenCalledTimes(1)
  })
})
