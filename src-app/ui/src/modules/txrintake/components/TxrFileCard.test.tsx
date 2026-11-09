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
  FileProblem,
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

    columnOffers: [],
    ...overrides,
  }
}

function patientsValidation(overrides: Partial<ValidationResponse> = {}): ValidationResponse {
  return {
    patients: { rows: 151, with_primary_outcome: 62,
    primary_outcome_events: 62, median_followup_days: 231 },
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
    onAcceptColumn: vi.fn(),
    onRejectColumn: vi.fn(),
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
    // ITEM-6 F11: the kit's pale dashed border is cleared so the board's red
    // dashed zone is the ONE drop border (no double-border box).
    const zone = screen
      .getByTestId('txr-intake-file-drop-patients')
      .querySelector('[role="button"]') as HTMLElement
    expect(zone.className).toContain('border-none')
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
        patients: { rows: 151, with_primary_outcome: 62,
    primary_outcome_events: 62, median_followup_days: 231 },
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
        patients: { rows: 151, with_primary_outcome: 62,
    primary_outcome_events: 62, median_followup_days: 231 },
      }),
    )
    const callbacks = renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    // ITEM-6 F5d: the red box counts ERROR problems only; a warning moves to
    // the "notes" group (same row-numbered lines, its own severity color).
    // Both groups share one problems testid, so scope by role within the
    // status box: red-box items first, then the notes.
    expect(within(status).getByText('1 problem in 151 rows')).toBeTruthy()
    expect(within(status).getByText('1 note')).toBeTruthy()
    const items = within(status).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // ITEM-4: each problem line carries its code as a link to the matching
    // Help entry (`row` + provider message bytes unchanged, the code
    // appended).
    expect(items[0].textContent).toBe(
      'Row 14: week 4 is not a number in the day columnR03',
    )
    expect(within(items[0] as HTMLElement).getByRole('link', { name: 'Help for problem code R03' }).getAttribute('href')).toBe(
      '/help#problem-r03',
    )
    // The error tone is the board's red as the shared danger token (the
    // component renders the theme variable; the LIGHT byte is #b3261e in
    // `assets/txr-theme.css`, DEC-14).
    expect(items[0].style.color).toBe('var(--txr-danger)')
    // The warning is a card note (its color is the notes group's amber).
    const note = items[1]
    expect(note.textContent).toBe('Row 88: P0187 is not in the patients tableR08')
    expect(within(note as HTMLElement).getByRole('link', { name: 'Help for problem code R08' }).getAttribute('href')).toBe(
      '/help#problem-r08',
    )
    expect(note.style.color).toBe('var(--txr-warning)')
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
    // The warning-only group is the NOTES list (ITEM-6 F5d's own testid).
    const items = within(screen.getByTestId('txr-intake-file-notes-patients')).getAllByRole(
      'listitem',
    )
    expect(items).toHaveLength(1)
    expect(items[0].style.color).toBe('var(--txr-warning)')
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

describe('ITEM-6 F2/F5/F11 - the mapping offer, the honest problem box, the aligned role table', () => {
  const columnProblem: FileProblem = {
    code: 'R02',
    severity: 'error',
    row: 1,
    column: 'os_days',
    message: 'required column `os_days` is missing from the patients table',
  }

  it('the column-rename offer row reports the OFFER OBJECT on accept and reject (F2)', () => {
    const offer = { from: 'pid', to: 'patient_id' }
    const file = loadedPatients({ columnOffers: [offer] })
    const callbacks = renderCard({ kind: 'measurements', file })
    expect(
      screen.getByText('The column “pid” looks like patient_id — rename it?'),
    ).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-intake-column-accept-pid'))
    expect(callbacks.onAcceptColumn).toHaveBeenCalledWith(offer)
    fireEvent.click(screen.getByTestId('txr-intake-column-decline-pid'))
    expect(callbacks.onRejectColumn).toHaveBeenCalledWith(offer)
  })

  it('column-level problems render WITHOUT a "Row 1:" prefix (F5b)', () => {
    const file = loadedPatients({
      problems: [columnProblem, row14Problem],
      inspection: inspectionFixture({ problems: [columnProblem, row14Problem] }),
    })
    seedValidation(patientsValidation({ problems: [columnProblem, row14Problem] }))
    renderCard({ file })
    const items = within(screen.getByTestId('txr-intake-file-problems-patients')).getAllByRole(
      'listitem',
    )
    expect(items[0].textContent).toBe(
      'required column os_days is missing from the patients tableR02',
    )
    expect(items[1].textContent).toBe(
      'Row 14: week 4 is not a number in the day columnR03',
    )
  })

  it('the red box counts ERROR problems only and moves warnings to the notes group (F5d)', () => {
    const file = loadedPatients({
      problems: [row14Problem, row88Problem],
      inspection: inspectionFixture({ problems: [row14Problem] }),
    })
    seedValidation(patientsValidation({ problems: [row14Problem, row88Problem] }))
    renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('1 problem in 151 rows')).toBeTruthy()
    expect(within(status).getByText('1 note')).toBeTruthy()
    const inStatus = within(status).getAllByRole('listitem')
    expect(inStatus).toHaveLength(2)
    expect(inStatus[0].style.color).toBe('var(--txr-danger)')
    expect(inStatus[1].style.color).toBe('var(--txr-warning)')
  })

  it('the problem list clips at 20 lines with the "Show all N" disclosure (F2)', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...row14Problem,
      row: i + 2,
      message: `row ${i + 2} is a problem`,
    }))
    const file = loadedPatients({ problems: many, inspection: inspectionFixture() })
    seedValidation(patientsValidation({ problems: many }))
    renderCard({ file })
    const list = screen.getByTestId('txr-intake-file-problems-patients')
    expect(list.querySelectorAll('li')).toHaveLength(21) // 20 lines + the disclosure
    expect(screen.getByTestId('txr-intake-file-problems-show-all-patients').textContent).toBe(
      'Show all 25 problems',
    )
    fireEvent.click(screen.getByTestId('txr-intake-file-problems-show-all-patients'))
    expect(list.querySelectorAll('li')).toHaveLength(26) // 25 lines + the "Show fewer" row
    expect(screen.getByTestId('txr-intake-file-problems-show-all-patients').textContent).toBe(
      'Show fewer',
    )
  })

  it('a header-only file is a red "This file has no data rows" box, not a green box (F3)', () => {
    const file = loadedPatients({
      inspection: inspectionFixture({ summary: { rows: 0, markers: [], draw_days: [] } }),
      problems: [],
    })
    seedValidation(patientsValidation())
    renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('This file has no data rows')).toBeTruthy()
    expect(within(status).queryByText(/Ready\./)).toBeNull()
    expect(within(status).getByText('Fix and choose the file again')).toBeTruthy()
  })

  it('the role table declares os_days/os_event REQUIRED (D48, F5a) and aligns the tag column (F11)', () => {
    renderCard()
    const table = screen.getByText('the same for death alone').closest('table') as HTMLElement
    const rows = Array.from(table.querySelectorAll('tr'))
    const osRow = rows.find(row => row.textContent?.includes('os_days, os_event')) as HTMLElement
    expect(osRow.textContent).toContain('required')
    const nameCell = rows[0].cells[0] as HTMLElement
    expect(nameCell.style.minWidth).toBe('168px')
    // The measurements card's tag column starts at the SAME x (the fixed
    // first-column width - the two cards' tables align).
    renderCard({ kind: 'measurements' })
    const mTable = screen.getByText('a number').closest('table') as HTMLElement
    expect((mTable.querySelector('tr')?.cells[0] as HTMLElement).style.minWidth).toBe('168px')
  })
})
