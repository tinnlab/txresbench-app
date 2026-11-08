// @vitest-environment jsdom
/**
 * TEST-INT-6 [covers ITEM-9, acceptance INV-2] — the shared file card
 * (`components/TxrFileCard.tsx`, PROV-UI-INTAKE-5): the board column table
 * with the per-role copy per mode (C patients / C measurements / N
 * measurements), the example first-rows table, the template + full-example
 * download links, the kit drop zone (one file input, the .csv/.xlsx/.xls
 * glove), the status boxes (green board line, red "N problems in N rows"
 * with row-numbered lines and severity colors, the neutral inspected
 * state), the join and vocabulary offer rows, and the prop callbacks
 * (onPick / onRemove / onDownloadTemplate / onDownloadExample / the four
 * offer answers, which receive the OFFER OBJECT).
 *
 * The card is CONTROLLED with one store read: its status box renders the
 * module's shared `validation` slot (the E/D/I seam — DRIFT-1 ITEM-7 #4),
 * so the tests seed the real TxrIntake store (reset per test) and pass the
 * store's file as `file`; the drop never parses here (the parse is the
 * pages' flow, picked+adopted in FilesPage/PredictFilesPage tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type {
  FileInspection,
  MarkerMatch,
  ValidationResponse,
} from '@/api-client/types'
import { TxrFileCard, type TxrFileCardProps } from './TxrFileCard'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { JoinOffer, LoadedFile } from '../types'

const joinOffer: JoinOffer = { variants: ['ldh', 'LDH'], key: 'ldh' }

const fuzzyMatch: MarkerMatch = {
  marker_id: 'loinc:27856-1',
  system: 'LOINC',
  display_name: 'Carcinoembryonic antigen',
  unit_family: 'concentration_mass',
  canonical_unit: 'ng/mL',
  n_methods: 9,
  match_kind: 'fuzzy',
}

const exactMatch: MarkerMatch = {
  marker_id: 'loinc:2857-1',
  system: 'LOINC',
  display_name: 'Lactate dehydrogenase',
  unit_family: 'concentration_mass',
  canonical_unit: 'U/L',
  n_methods: 12,
  match_kind: 'exact',
}

const row14Problem = {
  code: 'R03' as const,
  severity: 'error' as const,
  row: 14,
  column: 'day',
  message: '`week 4` is not a number in the day column',
}
const row88Problem = {
  code: 'R08' as const,
  severity: 'warning' as const,
  row: 88,
  column: 'patient_id',
  message: '`P0187` is not in the patients table',
}

function inspectionFixture(overrides: Partial<FileInspection> = {}): FileInspection {
  return {
    kind: 'patients',
    source_name: 'patients.csv',
    columns: {
      resolved: { patient_id: 'patient_id', pfs_days: 'pfs_days', pfs_event: 'pfs_event' },
      unresolved: [],
      covariate_columns: [],
    },
    problems: [],
    summary: { rows: 151, markers: [], draw_days: [] },
    ...overrides,
  }
}

function loadedPatients(overrides: Partial<LoadedFile> = {}): LoadedFile {
  return {
    source: { name: 'patients.csv', format: 'csv' },
    table: {
      source: { name: 'patients.csv', format: 'csv' },
      header_row: 1,
      columns: ['patient_id', 'pfs_days', 'pfs_event', 'age'],
      rows: [
        ['P0001', '214', '1', '62'],
        ['P0002', '380', '0', '54'],
      ],
    },
    inspection: inspectionFixture(),
    problems: [],
    prepared: true,
    joinOffers: [],
    vocabOffers: [],
    ...overrides,
  }
}

function patientsValidation(overrides: Partial<ValidationResponse> = {}): ValidationResponse {
  return {
    patients: { rows: 151, with_primary_outcome: 62, median_followup_days: 231 },
    measurements: { rows: 1102, patients: 38, distinct_draw_days: [0, 14, 28, 56] },
    markers: [],
    problems: [],
    inventory: {
      baseline_max_day: 0,
      decision_day: 56,
      patients: 151,
      covariates: [],
      markers: [],
    },
    ...overrides,
  }
}

/** Seed the ONE validation slot the card reads (birth params = the key). */
function seedValidation(validation: ValidationResponse) {
  useTxrIntakeStore.getState().applyValidation(validation, {
    joins: [],
    mapping: [],
    parameters: { decision_day: 56, baseline_max_day: 0 },
  })
}

function renderCard(
  props: Partial<Pick<TxrFileCardProps, 'kind' | 'mode' | 'file' | 'busy' | 'error'>> = {},
) {
  const callbacks = {
    onPick: vi.fn(),
    onRemove: vi.fn(),
    onAcceptJoin: vi.fn(),
    onRejectJoin: vi.fn(),
    onAcceptVocab: vi.fn(),
    onRejectVocab: vi.fn(),
    onDownloadTemplate: vi.fn(),
    onDownloadExample: vi.fn(),
  }
  render(
    <MemoryRouter initialEntries={['/files']}>
      <TxrFileCard
        kind={props.kind ?? 'patients'}
        mode={props.mode ?? 'study'}
        file={props.file ?? null}
        busy={props.busy ?? false}
        error={props.error ?? null}
        {...callbacks}
      />
    </MemoryRouter>,
  )
  return callbacks
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

describe('TxrFileCard (shared file card, ITEM-9)', () => {
  it('renders the board column table and copy for the C patients card', () => {
    renderCard()
    expect(screen.getByText('Patients')).toBeTruthy()
    expect(screen.getByText('One row per patient. Time is counted in days from the start of treatment.')).toBeTruthy()
    expect(screen.getByText('your own code, the same in both files')).toBeTruthy()
    expect(screen.getByText('1 = progressed or died, 0 = still well at last follow-up')).toBeTruthy()
    expect(screen.getByText('The columns we look for are on the left.')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-file-card-patients')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-file-status-patients')).toBeNull()
  })

  it('renders the N measurements spec — its own role copy, no patients wording', () => {
    renderCard({ kind: 'measurements', mode: 'predict' })
    expect(screen.getByText('Measurements of the patients to predict')).toBeTruthy()
    expect(screen.getByText('your own code')).toBeTruthy()
    expect(screen.getByText('for example LDH, ctDNA')).toBeTruthy()
    expect(screen.getByText('lets us check the scale against the model')).toBeTruthy()
    expect(screen.queryByText('your own code, the same in both files')).toBeNull()
    expect(screen.getByText('Drop the measurements file here')).toBeTruthy()
  })

  it('renders the adopted file first rows', () => {
    const file = loadedPatients()
    renderCard({ file })
    expect(screen.getByText('Example (first rows)')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'pfs_days' })).toBeTruthy()
    expect(screen.getByText('P0001')).toBeTruthy()
    expect(screen.getByText('214')).toBeTruthy()
    expect(screen.queryByText('The columns we look for are on the left.')).toBeNull()
  })

  it('fires the download callbacks from the two links', () => {
    const callbacks = renderCard()
    fireEvent.click(screen.getByTestId('txr-intake-download-template-patients'))
    expect(callbacks.onDownloadTemplate).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('txr-intake-download-example-patients'))
    expect(callbacks.onDownloadExample).toHaveBeenCalledTimes(1)
  })

  it('the drop zone is the kit Upload: ONE file input, the .csv/.xlsx/.xls glove, onPick gets the File', () => {
    const callbacks = renderCard()
    const card = screen.getByTestId('txr-intake-file-card-patients')
    const inputs = card.querySelectorAll('input')
    expect(inputs).toHaveLength(1)
    const input = inputs[0] as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.accept).toBe('.csv,.xlsx,.xls')
    const file = new File(['patient_id\nP0001\n'], 'patients.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(callbacks.onPick).toHaveBeenCalledTimes(1)
    expect(callbacks.onPick.mock.calls[0][0]).toBe(file)
  })

  it('the card error renders as the kit Alert', () => {
    renderCard({ error: 'The file could not be read.' })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('The file could not be read.')
  })

  it('the ready patients box is the board string from the validation facts', () => {
    const file = loadedPatients()
    seedValidation(patientsValidation())
    renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('✓ 151 patients read')).toBeTruthy()
    expect(
      within(status).getByText(
        'Found 151 rows, 62 progressions or deaths, median follow-up 231 days. Ready.',
      ),
    ).toBeTruthy()
    expect(within(status).queryByText(/problem/)).toBeNull()
  })

  it('the ready measurements box carries the board-N line with the C Ready terminator', () => {
    const measurements: LoadedFile = {
      ...loadedPatients(),
      source: { name: 'measurements.csv', format: 'csv' },
    }
    measurements.inspection = inspectionFixture({
      kind: 'measurements',
      source_name: 'measurements.csv',
    })
    seedValidation(
      patientsValidation({
        patients: { rows: 151, with_primary_outcome: 62, median_followup_days: 231 },
        markers: [
          { key: 'ctDNA', spellings: ['ctDNA'], n_rows: 400, unit_status: 'matches', coverage: { patients_with_value: 38, patients_with_baseline: 38, patients_with_ontreatment: 38 }, vocabulary: [], unit: undefined },
          { key: 'LDH', spellings: ['LDH'], n_rows: 400, unit_status: 'matches', coverage: { patients_with_value: 38, patients_with_baseline: 38, patients_with_ontreatment: 38 }, vocabulary: [], unit: undefined },
          { key: 'CEA', spellings: ['CEA'], n_rows: 302, unit_status: 'matches', coverage: { patients_with_value: 38, patients_with_baseline: 38, patients_with_ontreatment: 38 }, vocabulary: [], unit: undefined },
        ],
      }),
    )
    renderCard({ kind: 'measurements', mode: 'study', file: measurements })
    const status = screen.getByTestId('txr-intake-file-status-measurements')
    expect(within(status).getByText('✓ 38 patients read')).toBeTruthy()
    expect(
      within(status).getByText(
        'Found 1,102 rows: markers ctDNA, LDH and CEA; draws at day 0, 14, 28 and 56. Ready.',
      ),
    ).toBeTruthy()
  })

  it('the predict box ends with the board continuation', () => {
    const measurements: LoadedFile = { ...loadedPatients() }
    measurements.inspection = inspectionFixture({ kind: 'measurements' })
    seedValidation(
      patientsValidation({
        markers: [
          { key: 'ctDNA', spellings: ['ctDNA'], n_rows: 400, unit_status: 'matches', coverage: { patients_with_value: 38, patients_with_baseline: 38, patients_with_ontreatment: 38 }, vocabulary: [], unit: undefined },
        ],
      }),
    )
    renderCard({ kind: 'measurements', mode: 'predict', file: measurements })
    const status = screen.getByTestId('txr-intake-file-status-measurements')
    expect(
      within(status).getByText(
        'Found 1,102 rows: markers ctDNA; draws at day 0, 14, 28 and 56. Next you choose the models that can run on it.',
      ),
    ).toBeTruthy()
  })

  it('problems render the red box, one row-numbered line each, with severity colors', () => {
    const file = loadedPatients({
      problems: [row14Problem, row88Problem],
      inspection: inspectionFixture({ problems: [row14Problem] }),
    })
    seedValidation(
      patientsValidation({
        problems: [row14Problem, row88Problem],
        patients: { rows: 151, with_primary_outcome: 62, median_followup_days: 231 },
      }),
    )
    const callbacks = renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('2 problems in 151 rows')).toBeTruthy()
    const list = within(screen.getByTestId('txr-intake-file-problems-patients'))
    const items = list.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // ITEM-4: each problem line carries its code as a link to the matching
    // Help entry (`row` + provider message bytes unchanged, the code
    // appended).
    expect(items[0].textContent).toBe(
      'Row 14: `week 4` is not a number in the day columnR03',
    )
    expect(within(items[0] as HTMLElement).getByRole('link', { name: 'Help for problem code R03' }).getAttribute('href')).toBe(
      '/help#problem-r03',
    )
    // jsdom serializes the inline hex to its rgb form (the bytes are the
    // component's, `#b3261e` per DEC-14 — RGB is the same color).
    expect(items[0].style.color).toBe('rgb(179, 38, 30)')
    expect(items[1].textContent).toBe('Row 88: `P0187` is not in the patients tableR08')
    expect(within(items[1] as HTMLElement).getByRole('link', { name: 'Help for problem code R08' }).getAttribute('href')).toBe(
      '/help#problem-r08',
    )
    expect(items[1].style.color).toBe('rgb(138, 90, 0)')
    fireEvent.click(within(status).getByText('Fix and choose the file again'))
    expect(callbacks.onRemove).toHaveBeenCalledTimes(1)
  })

  it('warning-only problems keep the ready box and show the notes group', () => {
    const warnings = [{ ...row88Problem, severity: 'warning' as const }]
    const file = loadedPatients({ problems: warnings, inspection: inspectionFixture() })
    seedValidation(patientsValidation())
    renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('✓ 151 patients read')).toBeTruthy()
    expect(within(status).getByText('1 note')).toBeTruthy()
    const items = within(screen.getByTestId('txr-intake-file-problems-patients')).getAllByRole(
      'listitem',
    )
    expect(items).toHaveLength(1)
    expect(items[0].style.color).toBe('rgb(138, 90, 0)')
  })

  it('an inspected-but-unvalidated file shows the neutral state', () => {
    const callbacks = renderCard({ file: loadedPatients() })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('151 rows read')).toBeTruthy()
    expect(within(status).getByText('We check each file as soon as you choose it.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-intake-file-choose-again-patients'))
    expect(callbacks.onRemove).toHaveBeenCalledTimes(1)
  })

  it('the join offer row reports the OFFER OBJECT on accept and reject', () => {
    const file = loadedPatients({ joinOffers: [joinOffer] })
    const callbacks = renderCard({ file })
    fireEvent.click(screen.getByTestId('txr-intake-join-accept-ldh'))
    expect(callbacks.onAcceptJoin).toHaveBeenCalledWith(joinOffer)
    fireEvent.click(screen.getByTestId('txr-intake-join-decline-ldh'))
    expect(callbacks.onRejectJoin).toHaveBeenCalledWith(joinOffer)
  })

  it('the fuzzy vocab offer row reports the OFFER OBJECT on accept and reject', () => {
    const vocabOffer = {
      key: 'cea',
      match: fuzzyMatch,
      accepted: null,
    }
    const file = loadedPatients({ vocabOffers: [vocabOffer] })
    const callbacks = renderCard({ file })
    expect(
      screen.getByText(
        'Your column "cea" looks like Carcinoembryonic antigen (LOINC: loinc:27856-1, ng/mL). Use it as this marker?',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-intake-vocab-accept-cea'))
    expect(callbacks.onAcceptVocab).toHaveBeenCalledWith(vocabOffer)
    fireEvent.click(screen.getByTestId('txr-intake-vocab-decline-cea'))
    expect(callbacks.onRejectVocab).toHaveBeenCalledWith(vocabOffer)
  })

  it('an exact-vocabulary offer renders nothing (auto-accepted upstream)', () => {
    const file = loadedPatients({
      vocabOffers: [{ key: 'ldh', match: exactMatch, accepted: true }],
    })
    renderCard({ file })
    expect(screen.queryByTestId('txr-intake-vocab-offer-ldh')).toBeNull()
  })
})
