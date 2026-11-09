// @vitest-environment jsdom
/**
 * TEST-RUN-14 — the change-files dialog (`components/TxrChangeFilesDialog.tsx`,
 * ITEM-6; DEC-9, PROV-UI-RUN-4, CONS-UI-RUN-12/14): the dialog mounts the
 * intake's `TxrFileCard` per mode (the two train cards, or the one predict
 * card) with the `TxrIntake` store callbacks bound (remove + the four offer
 * answers), the card's own validation surface is untouched (its facts flow
 * back through the ONE store validation slot — no local parsing), and every
 * "new file" affordance hands off to the mode's change-files target
 * (`/files` in the train flow, `/predict-files` in the predict flow —
 * CONS-UI-RUN-12's declared constants, never URL literals).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type {
  FileInspection,
  MarkerMatch,
  ValidationResponse,
} from '@/api-client/types'
import type { LoadedFile } from '@/modules/txrintake'
import { TxrIntake, useTxrIntakeStore } from '@/modules/txrintake'
import type { JoinOffer } from '@/modules/txrintake'
import { TxrChangeFilesDialog } from './TxrChangeFilesDialog'

/** The ONE joined column (a spelling group, the card's join offer). */
const joinOffer: JoinOffer = { variants: ['ldh', 'LDH'], key: 'ldh' }

/** The fuzzy vocabulary candidate (the card's vocab offer). */
const fuzzyMatch: MarkerMatch = {
  marker_id: 'loinc:27856-1',
  system: 'LOINC',
  display_name: 'Carcinoembryonic antigen',
  unit_family: 'concentration_mass',
  canonical_unit: 'ng/mL',
  n_methods: 9,
  match_kind: 'fuzzy',
}

/** The adopted-file fixture (the card's file facts; small synthetic counts). */
function loaded(name: string, overrides: Partial<LoadedFile> = {}): LoadedFile {
  const inspection: FileInspection = {
    kind: 'measurements',
    source_name: name,
    columns: {
      resolved: { patient_id: 'patient_id', day: 'day', marker: 'marker', value: 'value' },
      unresolved: [],
      covariate_columns: [],
    },
    problems: [],
    summary: { rows: 36, markers: [{ name: 'ldh', rows: 20 }], draw_days: [0, 14, 28] },
  }
  return {
    source: { name, format: 'csv' },
    table: {
      source: { name, format: 'csv' },
      header_row: 1,
      columns: ['patient_id', 'day', 'marker', 'value'],
      rows: [['P0001', '0', 'ldh', '180']],
    },
    inspection,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],

    columnOffers: [],
    ...overrides,
  }
}

/** The ONE validated summary (the card's green box facts). */
function validation(rows = 36): ValidationResponse {
  return {
    patients: { rows: 18, with_primary_outcome: 7,
    primary_outcome_events: 7, median_followup_days: 84 },
    measurements: { rows, patients: 4, distinct_draw_days: [0, 14, 28] },
    markers: [
      { key: 'ldh', spellings: ['ldh'], n_rows: 20, unit_status: 'matches', coverage: { patients_with_value: 4, patients_with_baseline: 4, patients_with_ontreatment: 4 }, vocabulary: [] },
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

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderDialog(mode: 'study' | 'predict') {
  const onOpenChange = vi.fn()
  render(
    <MemoryRouter initialEntries={['/choose-methods']}>
      <TxrChangeFilesDialog mode={mode} open onOpenChange={onOpenChange} />
      <LocationProbe />
    </MemoryRouter>,
  )
  return onOpenChange
}

const routeAt = () => screen.getByTestId('route-location').textContent
const store = () => useTxrIntakeStore.getState()

/** Pick a file into the card's kit Upload (the hidden input's change). */
function pickFile(testId: string, name: string) {
  const file = new File(['patient_id\nP0001\n'], name, { type: 'text/csv' })
  const card = screen.getByTestId(testId)
  const input = card.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  window.localStorage.clear()
  useTxrIntakeStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrChangeFilesDialog (E change-files, TEST-RUN-14)', () => {
  it('mounts the two train cards in the train-mode flow', () => {
    useTxrIntakeStore.setState({
      mode: 'study',
      patients: loaded('patients.csv'),
      measurements: loaded('measurements.csv'),
    })
    renderDialog('study')
    expect(screen.getByTestId('txr-intake-file-card-patients')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-file-card-measurements')).toBeTruthy()
    expect(screen.getByText('Change files')).toBeTruthy()
  })

  it('mounts ONLY the predict-measurements card in the predict flow (the N-screen spec)', () => {
    useTxrIntakeStore.setState({
      mode: 'predict',
      predictMeasurements: loaded('new_measurements.csv'),
    })
    renderDialog('predict')
    expect(screen.getByTestId('txr-intake-file-card-measurements')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-file-card-patients')).toBeNull()
    expect(screen.getByText('Measurements of the patients to predict')).toBeTruthy()
  })

  it('the remove affordance is the store action: the slot file is gone, validation invalidated', () => {
    // No validation yet — the card's neutral state carries the
    // "Choose a different file" affordance (the store remove action).
    useTxrIntakeStore.setState({
      mode: 'study',
      patients: loaded('patients.csv'),
      measurements: loaded('measurements.csv'),
    })
    renderDialog('study')
    fireEvent.click(screen.getByTestId('txr-intake-file-choose-again-measurements'))
    expect(store().measurements).toBeNull()
    expect(store().validation).toBeNull()
  })

  it('the join and vocab answers are the store actions (offer objects passed through)', () => {
    useTxrIntakeStore.setState({
      mode: 'study',
      patients: loaded('patients.csv'),
      measurements: loaded('measurements.csv', {
        joinOffers: [joinOffer],
        vocabOffers: [{ key: 'cea', match: fuzzyMatch, accepted: null }],
      }),
    })
    renderDialog('study')
    fireEvent.click(screen.getByTestId('txr-intake-join-accept-ldh'))
    expect(store().joins).toEqual([joinOffer])
    fireEvent.click(screen.getByTestId('txr-intake-vocab-accept-cea'))
    expect(store().mapping).toEqual([{ key: 'cea', marker_id: fuzzyMatch.marker_id }])
  })

  it('a pick from disk hands off to the mode change-files target (study → /files)', () => {
    useTxrIntakeStore.setState({
      mode: 'study',
      patients: null,
      measurements: loaded('measurements.csv'),
    })
    renderDialog('study')
    pickFile('txr-intake-file-drop-patients', 'patients.csv')
    expect(routeAt()).toBe('/files')
  })

  it('a pick from disk hands off to the mode change-files target (predict → /predict-files)', () => {
    useTxrIntakeStore.setState({ mode: 'predict', predictMeasurements: null })
    renderDialog('predict')
    pickFile('txr-intake-file-drop-measurements', 'new_measurements.csv')
    expect(routeAt()).toBe('/predict-files')
  })

  it('a re-validated file summary flows back through the store — the dialog does no validation', async () => {
    useTxrIntakeStore.setState({
      mode: 'study',
      patients: loaded('patients.csv'),
      measurements: loaded('measurements.csv'),
      validation: null,
    })
    renderDialog('study')
    // Before the re-validation: the two cards' explicit checking state
    // (R2-7 — the spinner + "Checking the file…", one per card; both files
    // are in the store, so no "once both are here" wait).
    expect(screen.getAllByText('Checking the file…')).toHaveLength(2)
    expect(screen.getAllByRole('status', { name: 'Checking the file' })).toHaveLength(2)
    // The provider's re-validation lands in the ONE store slot; the card
    // re-renders its green box from it (no second fetch, no local parse).
    TxrIntake.applyValidation(validation(36), TxrIntake.currentValidationKey())
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-file-status-measurements').textContent).toContain(
        '✓ 4 patients read',
      )
    })
  })

  it('the module never imports the decode library and never calls the validation surface', () => {
    // TEST-RUN-14's "no local file parsing" pin, made executable: the
    // dialog + its data builder + the page use only the intake barrel's
    // surfaces (the card + the store); the decode (txr-files) and the
    // file-validation operations stay the provider's flow.
    const root = path.resolve(process.cwd(), 'src/modules/txrrun')
    const files = [
      'components/TxrChangeFilesDialog.tsx',
      'components/TxrSlotSummary.tsx',
      'lib/slotSummary.ts',
      'pages/ChooseMethodsPage.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(path.join(root, file), 'utf8')
      expect(source).not.toContain('txr-files')
      expect(source).not.toContain('ApiClient.FileValidation')
      expect(source).not.toContain('FileValidation')
    }
  })
})
