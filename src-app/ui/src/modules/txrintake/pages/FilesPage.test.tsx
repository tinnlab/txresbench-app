// @vitest-environment jsdom
/**
 * TEST-INT-10 [covers ITEM-6] — the C screen (`pages/FilesPage.tsx`): the
 * two file cards render; a dropped file goes parse (real PROV-FV-7 decode
 * of an inline fixture) → inspect → (validate only when BOTH files are
 * present, auto); the cards show the per-file problem list, the join and
 * vocabulary offers; Continue is disabled while any error problem remains
 * (DEC-10) and navigates to `/choose-methods` only when clear; the
 * "Fix and choose the file again" affordance removes the file.
 *
 * The ApiClient is mocked; the store is the real TxrIntake store (reset per
 * test) and the parse runs the real `parseCsvFile` against a genuine
 * jsdom `File` — jsdom 25's File lacks `text()`, so the test adds the
 * standard polyfill (the impl buffer is reachable through jsdom's
 * Symbol(impl), the same stand-in class as StudyPage's PointerEvent shim —
 * browser bytes, jsdom fixture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type {
  FileInspection,
  FileInspectionRequest,
  MarkerColumn,
  MarkerMatch,
  ValidationRequest,
  ValidationResponse,
} from '@/api-client/types'
import { FilesPage } from './FilesPage'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'

// jsdom 25 ships no File.text(); the browser does. The polyfill reads the
// jsdom impl buffer (Symbol(impl) -> `_buffer`) so the REAL browser decode
// runs against the fixture bytes in the test too.
{
  const probe = new (window.File as unknown as new (...args: unknown[]) => File)([''], 'probe')
  const implSymbol = Object.getOwnPropertySymbols(probe)[0]
  const FileProto = window.File.prototype as unknown as { text?: () => Promise<string> }
  if (typeof FileProto.text !== 'function') {
    Object.defineProperty(window.File.prototype, 'text', {
      configurable: true,
      value: function text(this: File): Promise<string> {
        const impl = (this as unknown as Record<symbol, { _buffer: Buffer }>)[implSymbol]
        return Promise.resolve(impl._buffer.toString('utf8'))
      },
    })
  }
}

const api = vi.hoisted(() => ({
  inspect: vi.fn(),
  validate: vi.fn(),
  template: vi.fn(),
  example: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    FileValidation: {
      inspect: api.inspect,
      validate: api.validate,
      template: api.template,
      example: api.example,
    },
  },
}))

/** The board C fixture in miniature: header row 1, data rows 2-3. */
const PATIENTS_CSV = 'patient_id,pfs_days,pfs_event\nP0001,214,1\nP0002,380,0\n'
const MEASUREMENTS_CSV =
  'patient_id,day,marker,value,unit\nP0001,0,ldh,210,U/L\nP0001,14,LDH,160,U/L\n'

const row14Problem = {
  code: 'R03' as const,
  severity: 'error' as const,
  row: 4,
  column: 'day',
  message: '`week 4` is not a number in the day column',
}
const row88Problem = {
  code: 'R08' as const,
  severity: 'error' as const,
  row: 5,
  column: 'patient_id',
  message: '`P0187` is not in the patients table',
}
const a03Problem = {
  code: 'A03' as const,
  severity: 'warning' as const,
  row: undefined,
  column: undefined,
  message: "marker spellings 'ldh' and 'LDH' look the same — join them?",
}

function inspectionFixtures(): Record<'patients' | 'measurements', FileInspection> {
  return {
    patients: {
      kind: 'patients',
      source_name: 'patients.csv',
      columns: {
        resolved: { patient_id: 'patient_id', pfs_days: 'pfs_days', pfs_event: 'pfs_event' },
        unresolved: [],
        covariate_columns: [],
      },
      problems: [],
      summary: { rows: 2, markers: [], draw_days: [] },
    },
    measurements: {
      kind: 'measurements',
      source_name: 'measurements.csv',
      columns: {
        resolved: {
          patient_id: 'patient_id',
          day: 'day',
          marker: 'marker',
          value: 'value',
          unit: 'unit',
        },
        unresolved: [],
        covariate_columns: [],
      },
      problems: [row14Problem],
      summary: { rows: 2, markers: [{ name: 'ldh', rows: 1 }], draw_days: [0, 14] },
    },
  }
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

const fuzzyMatch: MarkerMatch = {
  marker_id: 'loinc:2857-1',
  system: 'LOINC',
  display_name: 'Lactate dehydrogenase',
  unit_family: 'concentration_mass',
  canonical_unit: 'U/L',
  n_methods: 12,
  match_kind: 'fuzzy',
}

function markerColumn(overrides: Partial<MarkerColumn> = {}): MarkerColumn {
  return {
    key: 'ldh',
    spellings: ['ldh', 'LDH'],
    n_rows: 2,
    unit: 'U/L',
    unit_status: 'matches',
    coverage: {
      patients_with_value: 2,
      patients_with_baseline: 2,
      patients_with_ontreatment: 1,
    },
    vocabulary: [exactMatch],
    ...overrides,
  }
}

function validationFixture(
  overrides: Partial<ValidationResponse> = {},
): ValidationResponse {
  return {
    problems: [row14Problem, row88Problem, a03Problem],
    markers: [
      markerColumn(),
      markerColumn({ key: 'cea', spellings: ['cea'], vocabulary: [fuzzyMatch] }),
    ],
    measurements: { rows: 2, patients: 2, distinct_draw_days: [0, 14] },
    patients: { rows: 2, with_primary_outcome: 1,
    primary_outcome_events: 1, median_followup_days: 214 },
    inventory: {
      baseline_max_day: 0,
      decision_day: 56,
      patients: 2,
      covariates: [],
      markers: [],
    },
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderFiles() {
  return render(
    <MemoryRouter initialEntries={['/files']}>
      <FilesPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const routeAt = () => screen.getByTestId('route-location').textContent
const continueButton = () =>
  screen.getByTestId<HTMLButtonElement>('txr-intake-continue')
const store = () => useTxrIntakeStore.getState()

/** Pick the file into the card's kit Upload (the hidden input's change). */
function pickFile(testId: string, name: string, content: string) {
  const file = new File([content], name, { type: 'text/csv' })
  const card = screen.getByTestId(testId)
  const input = card.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  api.inspect.mockReset()
  api.validate.mockReset()
  api.template.mockReset()
  api.example.mockReset()
  const inspections = inspectionFixtures()
  api.inspect.mockImplementation((request: FileInspectionRequest) =>
    Promise.resolve(inspections[request.kind]),
  )
  api.validate.mockResolvedValue(validationFixture())
  api.template.mockResolvedValue('patient_id,pfs_days\n')
  window.localStorage.clear()
  store().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FilesPage (screen C, ITEM-6)', () => {
  it('renders the two cards with the board copy and no file yet', () => {
    renderFiles()
    expect(screen.getByText('Add your files')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-file-card-patients')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-file-card-measurements')).toBeTruthy()
    expect(screen.getByText('One row per patient. Time is counted in days from the start of treatment.')).toBeTruthy()
    expect(
      screen.getByText('One row per marker per blood draw. Day 0 is the start of treatment; draws before it are negative.'),
    ).toBeTruthy()
    expect(screen.getByText('your own code, the same in both files')).toBeTruthy()
    expect(screen.getByText('days from the start of treatment')).toBeTruthy()
    expect(screen.getAllByText('Download the template (CSV)')).toHaveLength(2)
    expect(screen.getAllByText('Download the full example')).toHaveLength(2)
    expect(continueButton().disabled).toBe(true)
  })

  it('a dropped file parses and inspects; no validate while only one file is present', async () => {
    renderFiles()

    // A CLEAN single file: the card keeps the "check as soon as you choose
    // it" state — no validate until the second file is here.
    const cleanInspections = inspectionFixtures()
    cleanInspections.measurements.problems = []
    api.inspect.mockImplementation((request: FileInspectionRequest) =>
      Promise.resolve(cleanInspections[request.kind]),
    )

    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', MEASUREMENTS_CSV)

    await waitFor(() => {
      expect(api.inspect).toHaveBeenCalledTimes(1)
    })
    expect(api.validate).not.toHaveBeenCalled()
    const inspectCall = api.inspect.mock.calls[0][0] as FileInspectionRequest
    expect(inspectCall.kind).toBe('measurements')
    expect(inspectCall.table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(inspectCall.table.rows).toHaveLength(2)

    expect(screen.getByText('We check each file as soon as you choose it.')).toBeTruthy()
    const status = screen.getByTestId('txr-intake-file-status-measurements')
    expect(within(status).getByText('2 rows read')).toBeTruthy()
    expect(continueButton().disabled).toBe(true)
  })

  it('the second file completes the flow: inspect then the exact validate body', async () => {
    renderFiles()
    pickFile('txr-intake-file-drop-patients', 'patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))

    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', MEASUREMENTS_CSV)

    await waitFor(() => {
      expect(api.inspect).toHaveBeenCalledTimes(2)
      expect(api.validate).toHaveBeenCalledTimes(1)
    })
    const validateCall = api.validate.mock.calls[0][0] as ValidationRequest
    expect(validateCall.mode).toBe('files')
    expect(validateCall.patients?.rows).toHaveLength(2)
    expect(validateCall.measurements.rows).toHaveLength(2)
    expect(validateCall.joins).toEqual([])
    expect(validateCall.mapping).toEqual([])
    expect(validateCall.parameters).toEqual({ decision_day: 56, baseline_max_day: 0 })

    // Both cards land their facts: the patients box is on the ready line
    // (no patient-side problem) while the measurements box lists the shared
    // R03 row once plus the cross-table R08 (the A03 row is represented by
    // the join offer, not by a problem line).
    await waitFor(() => {
      expect(screen.getByText('✓ 2 patients read')).toBeTruthy()
    })
    const measurementsProblems = within(screen.getByTestId('txr-intake-file-problems-measurements'))
    expect(measurementsProblems.getAllByRole('listitem')).toHaveLength(2)
    // The ITEM-4 code link is appended to the provider's line (the row
    // message bytes are the provider's; the link carries the code).
    expect(
      within(screen.getByTestId('txr-intake-file-problems-measurements'))
        .getAllByRole('listitem')[0]
        .textContent,
    ).toContain('Row 4: week 4 is not a number in the day column')
    expect(screen.getByTestId('txr-intake-join-offer-ldh')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-vocab-offer-cea')).toBeTruthy()
  })

  it('Continue stays disabled with error problems; the fix affordance removes the file', async () => {
    renderFiles()
    pickFile('txr-intake-file-drop-patients', 'patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))
    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => {
      expect(api.validate).toHaveBeenCalledTimes(1)
    })

    expect(continueButton().disabled).toBe(true)

    fireEvent.click(screen.getByText('Fix and choose the file again'))
    expect(store().measurements).toBeNull()
    expect(api.validate).toHaveBeenCalledTimes(1) // removeFile does not re-validate a bare slot
    expect(screen.getByText('Drop the measurements file here')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-file-status-measurements')).toBeNull()
  })

  it('accepting a join re-validates: the A03 line and the offer disappear', async () => {
    renderFiles()
    pickFile('txr-intake-file-drop-patients', 'patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))
    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))

    const afterJoin = validationFixture({
      problems: [row14Problem, row88Problem],
    })
    api.validate.mockResolvedValue(afterJoin)
    fireEvent.click(within(screen.getByTestId('txr-intake-join-offer-ldh')).getByText('Join them'))

    await waitFor(() => {
      expect(store().joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])
    })
    await waitFor(() => {
      expect(api.validate).toHaveBeenCalledTimes(2)
    })
    const revalidated = api.validate.mock.calls[1][0] as ValidationRequest
    expect(revalidated.joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])
    expect(screen.queryByTestId('txr-intake-join-offer-ldh')).toBeNull()
    expect(
      within(screen.getByTestId('txr-intake-file-problems-measurements')).queryByText(
        /look the same/,
      ),
    ).toBeNull()
  })

  it('warning-only problems let Continue through to the methods screen', async () => {
    renderFiles()

    // A clean file set whose remaining fact is the unanswered A03 join:
    // a warning (never blocks; the offer row represents it).
    const tests = inspectionFixtures()
    tests.patients.problems = []
    tests.measurements.problems = []
    api.inspect.mockImplementation((request: FileInspectionRequest) =>
      Promise.resolve(tests[request.kind]),
    )
    api.validate.mockResolvedValue(
      validationFixture({
        problems: [a03Problem],
        measurements: { rows: 2, patients: 2, distinct_draw_days: [0, 14] },
      }),
    )

    pickFile('txr-intake-file-drop-patients', 'patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))
    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))

    await waitFor(() => {
      expect(continueButton().disabled).toBe(false)
    })
    expect(screen.getByTestId('txr-intake-join-offer-ldh')).toBeTruthy()
    fireEvent.click(continueButton())
    expect(routeAt()).toBe('/choose-methods')
  })

  it('the download links fetch through the generated client', async () => {
    renderFiles()
    fireEvent.click(screen.getByTestId('txr-intake-download-template-patients'))
    await waitFor(() => expect(api.template).toHaveBeenCalledWith({ kind: 'patients' }))
    fireEvent.click(screen.getByTestId('txr-intake-download-example-measurements'))
    await waitFor(() => expect(api.example).toHaveBeenCalledWith({ kind: 'measurements' }))
  })
})

describe('ITEM-6 F2/F3/F4/F12 — the mapping step, the no-data-rows gate, the pick guard, drag-and-drop', () => {
  const RENAMED_CSV =
    'pid,study_day,analyte,result,units\nP0001,0,ldh,210,U/L\nP0001,14,LDH,160,U/L\n'

  it('a wrong file type is refused with the plain sentence (F4)', async () => {
    renderFiles()
    pickFile('txr-intake-file-drop-measurements', 'report.pdf', 'not a table')
    await waitFor(() => {
      expect(
        screen.getByText('This is not a CSV or Excel file — choose a .csv or .xlsx file.'),
      ).toBeTruthy()
    })
    expect(api.inspect).not.toHaveBeenCalled()
    expect(store().measurements).toBeNull()
    expect(continueButton().disabled).toBe(true)
  })

  it('an empty file is refused with the plain sentence (F4)', async () => {
    renderFiles()
    pickFile('txr-intake-file-drop-measurements', 'empty.csv', '')
    await waitFor(() => {
      expect(screen.getByText('This file is empty — choose the file with its data.')).toBeTruthy()
    })
  })

  it('a header-only file blocks Continue with the red "no data rows" box (F3)', async () => {
    const inspections = inspectionFixtures()
    inspections.measurements.summary = { rows: 0, markers: [], draw_days: [] }
    inspections.measurements.problems = []
    api.inspect.mockImplementation((request: FileInspectionRequest) =>
      Promise.resolve(inspections[request.kind]),
    )
    api.validate.mockResolvedValue(validationFixture({ problems: [] }))
    renderFiles()
    pickFile('txr-intake-file-drop-patients', 'patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))
    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', 'patient_id,day,marker,value,unit\n')
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    expect(screen.getByText('This file has no data rows')).toBeTruthy()
    expect(continueButton().disabled).toBe(true)
  })

  it('the mapping step accepts "pid looks like patient_id" and re-inspects the canonical table (F2)', async () => {
    const inspections = inspectionFixtures()
    api.inspect.mockImplementation((request: FileInspectionRequest) => {
      const kind = request.kind
      const resolved =
        kind === 'patients'
          ? inspections.patients
          : request.table.columns.includes('pid')
            ? { ...inspections.measurements, problems: [{ ...row14Problem, row: 2 }] }
            : inspections.measurements
      return Promise.resolve(resolved)
    })
    api.validate.mockImplementation(() => {
      const key = useTxrIntakeStore.getState().measurements?.table.columns[0]
      return Promise.resolve(
        validationFixture({
          problems: key === 'patient_id' ? [a03Problem] : [row14Problem, row88Problem, a03Problem],
        }),
      )
    })
    renderFiles()
    pickFile('txr-intake-file-drop-patients', 'patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))
    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', RENAMED_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(2))

    // The suggestion is the mapping step: the offer row names both sides.
    const offer = screen.getByTestId('txr-intake-column-offer-pid')
    expect(within(offer).getByText(/pid/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-intake-column-accept-pid'))

    await waitFor(() => {
      const calls = api.inspect.mock.calls.filter(
        c => (c[0] as FileInspectionRequest).kind === 'measurements',
      )
      expect(calls).toHaveLength(2)
      expect((calls[1][0] as FileInspectionRequest).table.columns[0]).toBe('patient_id')
    })
    expect(screen.queryByTestId('txr-intake-column-offer-pid')).toBeNull()
    // The renamed file reads clean: the card's problems no longer include
    // the missing-column error and Continue is enabled.
    await waitFor(() => {
      expect(screen.queryByText(/missing from the measurements table/)).toBeNull()
      expect(continueButton().disabled).toBe(false)
    })
  })

  it('the example-loaded banner shows while the example files are loaded (F6)', () => {
    renderFiles()
    expect(screen.queryByTestId('txr-intake-example-loaded')).toBeNull()
    act(() => store().setExampleLoaded(true))
    expect(screen.getByTestId('txr-intake-example-loaded').textContent).toContain(
      'Example data loaded',
    )
  })

  it('the drop path hands the File to the flow (F12)', async () => {
    renderFiles()
    const file = new File([MEASUREMENTS_CSV], 'measurements.csv', { type: 'text/csv' })
    // The kit Upload's drop handler lives on its inner role="button"
    // dropzone (the testid wrapper is the sibling input's root) — the event
    // must target that element.
    const dropzone = screen
      .getByTestId('txr-intake-file-drop-measurements')
      .querySelector('[role="button"]') as HTMLElement
    const event = new Event('drop', { bubbles: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
    fireEvent(dropzone, event)
    await waitFor(() => {
      expect(api.inspect).toHaveBeenCalledTimes(1)
    })
    const call = api.inspect.mock.calls[0][0] as FileInspectionRequest
    expect(call.table.columns).toEqual(['patient_id', 'day', 'marker', 'value', 'unit'])
    expect(call.table.rows).toHaveLength(2)
  })
})
