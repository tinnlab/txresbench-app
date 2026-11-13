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

  it('the first-rows box keeps cell words whole and hints the sideways scroll (F9)', () => {
    const file = loadedPatients()
    renderCard({ file })
    const box = document.querySelector('.txr-intake-first-rows') as HTMLElement | null
    expect(box).toBeTruthy()
    // Every cell (and the header) is nowrap — the patient id never breaks
    // into three lines and a wide unit column never squeezes a neighbor.
    const cells = [...box!.querySelectorAll('th, td')] as HTMLElement[]
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.every(cell => cell.style.whiteSpace === 'nowrap')).toBe(true)
    // No overflow in jsdom's 0-width box → no hint; when the box really
    // overflows, the hint appears (the report's "cut with no scroll hint").
    expect(screen.queryByTestId('txr-intake-first-rows-scroll-hint')).toBeNull()
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: 120 })
    Object.defineProperty(box, 'scrollWidth', { configurable: true, value: 300 })
    fireEvent.scroll(box!)
    expect(screen.getByTestId('txr-intake-first-rows-scroll-hint')).toBeTruthy()
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
    // ITEM-6 F11: the kit's pale dashed border is cleared so the board's
    // dashed zone is the ONE drop border (no double-border box).
    const zone = screen
      .getByTestId('txr-intake-file-drop-patients')
      .querySelector('[role="button"]') as HTMLElement
    expect(zone.className).toContain('border-none')
    // F11 (qa-fixes2): the dashed border is the NEUTRAL token, not the
    // danger red — the zone exists only before any file is chosen, so a red
    // "something is wrong" border never had anything to signal.
    const framed = zone.querySelector(':scope > div') as HTMLElement
    expect(framed.style.border).toBe('2px dashed var(--txr-border)')
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

  it('problems render the red box, one grouped line each (R2-5), codes in the details form (R2-3)', () => {
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
    // the "notes" group (same grouped lines, its own severity color).
    // Both groups share one problems testid, so scope by role within the
    // status box: red-box items first, then the notes.
    expect(within(status).getByText('1 problem in 151 rows')).toBeTruthy()
    expect(within(status).getByText('1 note')).toBeTruthy()
    const items = within(status).getAllByRole('listitem')
    expect(items).toHaveLength(6)
    // R2-3: the code is OUT of the sentence (the old renderer glued a bold
    // underlined "R03" to the message); the plain message is the line. The
    // severity colors are unchanged (DEC-14).
    const problemLines = screen
      .getByTestId('txr-intake-file-problems-patients')
      .querySelectorAll(':scope > li')
    expect(problemLines).toHaveLength(2) // the line + the codes disclosure
    expect(problemLines[0].textContent).toBe('Row 14: week 4 is not a number in the day column')
    expect((problemLines[0] as HTMLElement).style.color).toBe('var(--txr-danger)')
    const noteLines = screen
      .getByTestId('txr-intake-file-notes-patients')
      .querySelectorAll(':scope > li')
    expect(noteLines).toHaveLength(2)
    expect(noteLines[0].textContent).toBe('Row 88: P0187 is not in the patients table')
    expect((noteLines[0] as HTMLElement).style.color).toBe('var(--txr-warning)')
    // R2-3: the codes live in the "details" disclosure, still one click from
    // their Help entry — each list has its own disclosure with ITS codes.
    const codes = screen.getByTestId('txr-intake-file-problems-codes-patients')
    expect(codes.querySelector('summary')?.textContent).toBe('Show the problem codes')
    expect(
      within(codes as HTMLElement).getByRole('link', { name: 'Help for problem code R03' }).getAttribute('href'),
    ).toBe('/help#problem-r03')
    expect(
      within(codes as HTMLElement).queryByRole('link', { name: 'Help for problem code R08' }),
    ).toBeNull()
    const noteCodes = screen.getByTestId('txr-intake-file-notes-codes-patients')
    expect(
      within(noteCodes as HTMLElement).getByRole('link', { name: 'Help for problem code R08' }).getAttribute('href'),
    ).toBe('/help#problem-r08')
    fireEvent.click(within(status).getByText('Fix and choose the file again'))
    expect(callbacks.onRemove).toHaveBeenCalledTimes(1)
  })

  it('warning-only problems keep the ready box — as the distinct "Ready, with notes" state (R2-6)', () => {
    const warnings = [{ ...row88Problem, severity: 'warning' as const }]
    const file = loadedPatients({ problems: warnings, inspection: inspectionFixture() })
    seedValidation(patientsValidation())
    renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('✓ 151 patients read')).toBeTruthy()
    // The green all-clear becomes the warning-toned "Ready, with notes"
    // state — the notes title names the state instead of hiding under a
    // green "Ready." card.
    expect(within(status).getByText('Ready, with 1 note')).toBeTruthy()
    expect(status.style.border).toBe('1px solid var(--txr-warning)')
    const notes = screen.getByTestId('txr-intake-file-notes-patients')
    const items = notes.querySelectorAll(':scope > li')
    expect(items).toHaveLength(2) // the line + the codes disclosure
    expect((items[0] as HTMLElement).style.color).toBe('var(--txr-warning)')
  })

  it('an inspected-but-unvalidated file shows the explicit checking state (R2-7)', () => {
    // The C screen needs BOTH files before the check can run; with only the
    // patients card adopted the box says the wait, not a false "checking".
    renderCard({ file: loadedPatients() })
    expect(screen.getByText('151 rows read')).toBeTruthy()
    expect(screen.getByText('We check the files once both are here.')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Checking the file' })).toBeNull()

    // With the sibling present and the validation in flight, the spinner +
    // "Checking the file…" is the honest state (the old line repeated the
    // page's intro and looked finished during the seconds of checking).
    useTxrIntakeStore.setState({ measurements: loadedPatients() })
    cleanup()
    const callbacks = renderCard({ file: loadedPatients() })
    expect(screen.getByText('151 rows read')).toBeTruthy()
    expect(screen.getByText('Checking the file…')).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Checking the file' })).toBeTruthy()
    expect(screen.queryByText('We check each file as soon as you choose it.')).toBeNull()
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
    expect(items[0].textContent).toBe('required column os_days is missing from the patients table')
    expect(items[1].textContent).toBe('Row 14: week 4 is not a number in the day column')
  })

  it('the red box names the missing columns in the canonical order (R3-intake-6)', () => {
    const missingDay: FileProblem = {
      code: 'R02',
      severity: 'error',
      row: 1,
      column: 'day',
      message: 'required column `day` is missing from the measurements table',
    }
    const missingPatient: FileProblem = {
      code: 'R02',
      severity: 'error',
      row: 1,
      column: 'patient_id',
      message: 'required column `patient_id` is missing from the measurements table',
    }
    const file = loadedPatients({
      problems: [missingDay, missingPatient, row14Problem],
      inspection: inspectionFixture({ problems: [missingDay, missingPatient] }),
    })
    seedValidation(
      patientsValidation({
        problems: [missingDay, missingPatient, row14Problem],
        measurements: { rows: 630, patients: 94, distinct_draw_days: [0, 43] },
      }),
    )
    renderCard({ kind: 'measurements', file })
    // The one line names the canonical columns the check wants, in the
    // required-role order — beside the suggestions and after they are gone.
    expect(screen.getByTestId('txr-intake-file-missing-columns-measurements').textContent).toBe(
      'Missing columns: patient_id, day',
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
    const errorLine = screen
      .getByTestId('txr-intake-file-problems-patients')
      .querySelector(':scope > li') as HTMLElement
    expect(errorLine.style.color).toBe('var(--txr-danger)')
    const noteLine = screen
      .getByTestId('txr-intake-file-notes-patients')
      .querySelector(':scope > li') as HTMLElement
    expect(noteLine.style.color).toBe('var(--txr-warning)')
  })

  it('the problem list clips at 20 GROUPS with the "Show all N" disclosure (F2, R2-5)', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...row14Problem,
      row: i + 2,
      message: `row ${i + 2} is a problem`,
    }))
    const file = loadedPatients({ problems: many, inspection: inspectionFixture() })
    seedValidation(patientsValidation({ problems: many }))
    renderCard({ file })
    const list = screen.getByTestId('txr-intake-file-problems-patients')
    expect(list.querySelectorAll(':scope > li')).toHaveLength(22) // 20 groups + Show all + codes disclosure
    expect(screen.getByTestId('txr-intake-file-problems-show-all-patients').textContent).toBe(
      'Show all 25 problems',
    )
    fireEvent.click(screen.getByTestId('txr-intake-file-problems-show-all-patients'))
    expect(list.querySelectorAll(':scope > li')).toHaveLength(27) // 25 groups + Show fewer + codes disclosure
    expect(screen.getByTestId('txr-intake-file-problems-show-all-patients').textContent).toBe(
      'Show fewer',
    )
  })

  it('identical messages collapse into ONE grouped line with the row count (R2-5)', () => {
    const emptyCell = (row: number): FileProblem => ({
      code: 'R04',
      severity: 'error',
      row,
      column: 'ovarian',
      message: 'empty cell in a required (not-null) column',
    })
    const file = loadedPatients({
      problems: [emptyCell(2), emptyCell(3), emptyCell(6)],
      inspection: inspectionFixture(),
    })
    seedValidation(patientsValidation({ problems: [emptyCell(2), emptyCell(3), emptyCell(6)] }))
    renderCard({ file })
    const list = screen.getByTestId('txr-intake-file-problems-patients')
    const lines = list.querySelectorAll(':scope > li')
    // One line + the codes disclosure — the wall of identical rows is gone.
    expect(lines).toHaveLength(2)
    expect(lines[0].textContent).toBe('empty cell in a required (not-null) column — 3 rows')
    // The codes disclosure still carries the code ↔ message pairing.
    const codes = screen.getByTestId('txr-intake-file-problems-codes-patients')
    expect((codes as HTMLElement).textContent).toContain('R04')
    expect((codes as HTMLElement).textContent).toContain('empty cell in a required (not-null) column')
  })

  it('a contiguous row run reads with the board "Rows 88 to 91: …" bytes (R2-5)', () => {
    const missing = (row: number): FileProblem => ({
      code: 'R08',
      severity: 'warning',
      row,
      column: 'patient_id',
      message: '`P0187` is not in the patients table',
    })
    const file = loadedPatients({
      problems: [missing(88), missing(89), missing(90), missing(91)],
      inspection: inspectionFixture(),
    })
    seedValidation(
      patientsValidation({ problems: [missing(88), missing(89), missing(90), missing(91)] }),
    )
    renderCard({ file })
    const list = screen.getByTestId('txr-intake-file-notes-patients')
    expect(list.querySelector('li')?.textContent).toBe(
      'Rows 88 to 91: P0187 is not in the patients table',
    )
  })

  it('a header-only file is a red "This file has no data rows" box, not a green box (F3)', () => {
    const file = loadedPatients({
      table: { ...loadedPatients().table, rows: [] },
      inspection: inspectionFixture({ summary: { rows: 0, markers: [], draw_days: [] } }),
      problems: [],
    })
    seedValidation(patientsValidation())
    renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('This file has no data rows')).toBeTruthy()
    expect(within(status).queryByText(/Ready\./)).toBeNull()
    expect(within(status).getByText('Fix and choose the file again')).toBeTruthy()
    // R2-8: no empty "Example (first rows)" table — the honest line.
    expect(screen.getByText('No data rows to show.')).toBeTruthy()
    expect(screen.queryByText('Example (first rows)')).toBeNull()
  })

  it('a header-only file hides the row-notes that describe rows it does not have (R2-8)', () => {
    const r14 = {
      code: 'R14' as const,
      severity: 'warning' as const,
      message:
        'fewer than 10 patients (the most is 0: pfs_days 0, os_days 0, responder 0) have a non-null outcome',
    }
    const file = loadedPatients({
      table: { ...loadedPatients().table, rows: [] },
      inspection: inspectionFixture({
        summary: { rows: 0, markers: [], draw_days: [] },
        problems: [],
      }),
      problems: [r14],
    })
    seedValidation(patientsValidation({ problems: [r14] }))
    renderCard({ file })
    const status = screen.getByTestId('txr-intake-file-status-patients')
    expect(within(status).getByText('This file has no data rows')).toBeTruthy()
    // The R14 note was the report's confusing second sentence under the one
    // true fact ("no data rows") — a header-only file has no patients to
    // have outcomes.
    expect(within(status).queryByText(/fewer than 10 patients/)).toBeNull()
  })

  it('the suggestions render FIRST and the problem list stays hidden until they are declined (R2-4)', () => {
    const offer = { from: 'pid', to: 'patient_id' }
    const file = loadedPatients({
      problems: [row14Problem, { ...row14Problem, row: 3 }],
      inspection: inspectionFixture({ problems: [row14Problem] }),
      columnOffers: [offer],
    })
    seedValidation(patientsValidation({ problems: [row14Problem, { ...row14Problem, row: 3 }] }))
    const callbacks = renderCard({ kind: 'measurements', file })
    // The offer is ABOVE the status box (the pending question first).
    const card = screen.getByTestId('txr-intake-file-card-measurements')
    const offerBox = screen.getByTestId('txr-intake-column-offer-pid').closest('div') as HTMLElement
    const statusBox = screen.getByTestId('txr-intake-file-status-measurements')
    expect(
      offerBox.compareDocumentPosition(statusBox) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the offer row must precede the status box',
    ).toBeTruthy()
    // The problem list is hidden while the question is pending.
    expect(within(statusBox).queryByTestId('txr-intake-file-problems-measurements')).toBeNull()
    expect(within(statusBox).getByText('2 problems in 151 rows')).toBeTruthy()
    // The decline reports the offer (the page removes it + re-validates);
    // the CARD's own contract is the callback — the re-render with the
    // resolved offer is the page's side, shown here as the list's return.
    fireEvent.click(screen.getByTestId('txr-intake-column-decline-pid'))
    expect(callbacks.onRejectColumn).toHaveBeenCalledWith(offer)
    cleanup()
    renderCard({
      kind: 'measurements',
      file: loadedPatients({
        problems: [row14Problem],
        inspection: inspectionFixture({ problems: [row14Problem] }),
      }),
    })
    const statusBox2 = screen.getByTestId('txr-intake-file-status-measurements')
    expect(within(statusBox2).getByTestId('txr-intake-file-problems-measurements')).toBeTruthy()
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
