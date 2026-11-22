// @vitest-environment jsdom
/**
 * TEST-INT-10 [covers ITEM-6] — the C screen (`pages/FilesPage.tsx`): the
 * two file cards render; a dropped file goes parse (real PROV-FV-7 decode
 * of an inline fixture) → inspect → (validate only when BOTH files are
 * present, auto); the cards show the per-file problem list, the join and
 * vocabulary offers; Continue is disabled while any error problem remains
 * (DEC-10) and navigates to the study questions (`/study`) only when clear; the
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
import type { LoadedFile } from '../types'
import { FilesPage } from './FilesPage'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { resetDemoMode, seedDemoMode } from '@/modules/demo/test-utils/demoSeed'

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
  resetDemoMode()
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

    expect(screen.getByText('We check the files once both are here.')).toBeTruthy()
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
    // (no patient-side problem); the measurements card's suggestions are the
    // pending action — R2-4: the offer rows come FIRST and the problem list
    // is hidden until they are resolved (the red box's heading stays).
    await waitFor(() => {
      expect(screen.getByText('✓ 2 patients read')).toBeTruthy()
    })
    const measurementsStatus = screen.getByTestId('txr-intake-file-status-measurements')
    expect(
      within(measurementsStatus).queryByTestId('txr-intake-file-problems-measurements'),
    ).toBeNull()
    expect(screen.getByTestId('txr-intake-join-offer-ldh')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-vocab-offer-cea')).toBeTruthy()
    // The offers render ABOVE the status box (the pending question first).
    const offerBox = screen.getByTestId('txr-intake-join-offer-ldh').closest('div') as HTMLElement
    expect(
      offerBox.compareDocumentPosition(measurementsStatus) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the offer rows must precede the status box',
    ).toBeTruthy()
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
    // R2-4: the vocab suggestion is still pending, so the problem list stays
    // hidden; declining it brings the list back (the A03 line is gone — the
    // join offer represented it, and the re-validated problems carry its
    // resolution).
    expect(screen.getByTestId('txr-intake-vocab-offer-cea')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-file-problems-measurements')).toBeNull()
    fireEvent.click(screen.getByTestId('txr-intake-vocab-decline-cea'))
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-file-problems-measurements')).toBeTruthy()
    })
    expect(
      within(screen.getByTestId('txr-intake-file-problems-measurements')).queryByText(
        /look the same/,
      ),
    ).toBeNull()
  })

  it('warning-only problems let Continue through to the study questions', async () => {
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
    // The learn path: the files, then the study questions, then the methods.
    expect(routeAt()).toBe('/study')
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
      const columns = useTxrIntakeStore.getState().measurements?.table.columns ?? []
      const renamed = columns.includes('patient_id')
      return Promise.resolve(
        validationFixture({
          problems: renamed ? [a03Problem] : [row14Problem, row88Problem, a03Problem],
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
      expect((calls[1][0] as FileInspectionRequest).table.columns).toContain('patient_id')
      expect((calls[1][0] as FileInspectionRequest).table.columns).not.toContain('pid')
    })
    expect(screen.queryByTestId('txr-intake-column-offer-pid')).toBeNull()
    // The renamed file reads clean: the card's problems no longer include
    // the missing-column error and Continue is enabled.
    await waitFor(() => {
      expect(screen.queryByText(/missing from the measurements table/)).toBeNull()
      expect(continueButton().disabled).toBe(false)
    })
  })

  it('the example banner shows with the Clear example action while the example files are loaded (F6 / ITEM-4)', () => {
    renderFiles()
    expect(screen.queryByTestId('txr-intake-example-loaded')).toBeNull()
    const own: LoadedFile = {
      source: { name: 'mine.csv', format: 'csv' },
      table: {
        source: { name: 'mine.csv', format: 'csv' },
        header_row: 1,
        columns: ['patient_id', 'pfs_days', 'pfs_event'],
        rows: [['P0001', '214', '1']],
      },
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
      columnOffers: [],
    }
    act(() => store().adoptExampleFile('patients', own))
    act(() => store().adoptExampleFile('measurements', own))
    expect(screen.getByTestId('txr-intake-example-loaded').textContent).toContain(
      'This is example data',
    )
    expect(screen.getByTestId('txr-intake-clear-example').textContent).toBe('Clear example')
  })

  it('Clear example removes only the example-flagged cards and returns to the empty state', () => {
    renderFiles()
    const own: LoadedFile = {
      source: { name: 'mine.csv', format: 'csv' },
      table: {
        source: { name: 'mine.csv', format: 'csv' },
        header_row: 1,
        columns: ['patient_id', 'pfs_days', 'pfs_event'],
        rows: [['P0001', '214', '1']],
      },
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
      columnOffers: [],
    }
    act(() => store().adoptFile('patients', own))
    act(() => store().adoptExampleFile('measurements', own))
    fireEvent.click(screen.getByTestId('txr-intake-clear-example'))
    expect(store().exampleLoaded).toBe(false)
    // The user's own patients card is untouched; the example measurements
    // card returns to its empty state.
    expect(store().patients?.source.name).toBe('mine.csv')
    expect(store().measurements).toBeNull()
    expect(screen.queryByTestId('txr-intake-clear-example')).toBeNull()
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

describe("step3-file-cards — each card holds its own file's messages, files can always be changed", () => {
  /** Clean inspections + a validation with one exact-matched marker and the
   *  given problems: no join / vocab / column offer, so the problem list
   *  shows (R2-4 hides it while an offer is pending). */
  function cleanFlow(problems: ValidationResponse['problems'] = []) {
    const inspections = inspectionFixtures()
    inspections.patients.problems = []
    inspections.measurements.problems = []
    api.inspect.mockImplementation((request: FileInspectionRequest) =>
      Promise.resolve(inspections[request.kind]),
    )
    api.validate.mockResolvedValue(
      validationFixture({ problems, markers: [markerColumn({ spellings: ['ldh'] })] }),
    )
  }

  async function pickBoth() {
    pickFile('txr-intake-file-drop-patients', 'my_patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))
    pickFile('txr-intake-file-drop-measurements', 'my_draws.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
  }

  it("each card holds its own file's messages INSIDE it — no messages element outside the two cards", async () => {
    renderFiles()
    // No file: no messages anywhere — and no element carries the OLD shared
    // row's id (`txr-intake-file-messages`), which nothing renders any more,
    // so a leftover under the cards cannot hide behind a stale query.
    expect(document.querySelectorAll('[data-testid="txr-intake-file-messages"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-testid^="txr-intake-file-messages-"]')).toHaveLength(0)
    await pickBoth()
    await waitFor(() => expect(screen.getByText('✓ 2 patients read')).toBeTruthy())

    const patientsCard = screen.getByTestId('txr-intake-file-card-patients')
    const measurementsCard = screen.getByTestId('txr-intake-file-card-measurements')
    // The count check of 2: exactly ONE messages row per chosen file, and
    // nowhere else (no old shared row, no duplicate).
    expect(
      document.querySelectorAll(
        '[data-testid="txr-intake-file-messages-patients"], [data-testid="txr-intake-file-messages-measurements"]',
      ),
    ).toHaveLength(2)
    // Every `txr-intake-file-messages-*` element (the row + its title for
    // each chosen file) has a card ancestor of the same kind; there is no
    // separate row under the cards anymore. Exact: the document's count is
    // the sum of the two cards' counts, and each card holds only ids of its
    // own kind (the old `cardOf` fell back to patients for the measurements
    // titles, so a stray measurements element passed).
    const messagesEls = [...document.querySelectorAll('[data-testid^="txr-intake-file-messages-"]')]
    expect(messagesEls).toHaveLength(4)
    const kindOf = (el: Element): 'patients' | 'measurements' => {
      const id = el.getAttribute('data-testid') as string
      return id === 'txr-intake-file-messages-measurements' ||
        id === 'txr-intake-file-messages-title-measurements'
        ? 'measurements'
        : 'patients'
    }
    const inPatients = messagesEls.filter(el => patientsCard.contains(el))
    const inMeasurements = messagesEls.filter(el => measurementsCard.contains(el))
    expect(inPatients).toHaveLength(2)
    expect(inMeasurements).toHaveLength(2)
    expect(inPatients.length + inMeasurements.length).toBe(messagesEls.length)
    for (const el of messagesEls) {
      const card = kindOf(el) === 'patients' ? patientsCard : measurementsCard
      expect(card.contains(el)).toBe(true)
    }
    // Patients first (the cards' order), each card's row titled with the
    // file kind and its own file name.
    expect(
      patientsCard.compareDocumentPosition(measurementsCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // The patients messages row comes before the measurements messages row
    // too (the rows follow their cards' order).
    expect(
      screen.getByTestId('txr-intake-file-messages-patients').compareDocumentPosition(
        screen.getByTestId('txr-intake-file-messages-measurements'),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      within(patientsCard).getByTestId('txr-intake-file-messages-title-patients').textContent,
    ).toBe('Patients file: my_patients.csv')
    expect(
      within(measurementsCard).getByTestId('txr-intake-file-messages-title-measurements').textContent,
    ).toBe('Measurements file: my_draws.csv')
    // Each card's row holds its own file's status box; the preview stays on
    // the card's halves.
    expect(
      within(patientsCard).getByTestId('txr-intake-file-status-patients'),
    ).toBeTruthy()
    expect(
      within(measurementsCard).getByTestId('txr-intake-file-status-measurements'),
    ).toBeTruthy()
    expect(within(patientsCard).getByText('Example (first rows)')).toBeTruthy()
  })

  it('the offers sit in their own card and still accept / reject through the store', async () => {
    renderFiles()
    pickFile('txr-intake-file-drop-patients', 'patients.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1))
    pickFile('txr-intake-file-drop-measurements', 'measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    const measurementsCard = screen.getByTestId('txr-intake-file-card-measurements')
    await waitFor(() =>
      expect(within(measurementsCard).getByTestId('txr-intake-join-offer-ldh')).toBeTruthy(),
    )
    expect(within(measurementsCard).getByTestId('txr-intake-vocab-offer-cea')).toBeTruthy()
    // The offers live in the measurements card's messages row — NOT in the
    // patients card.
    const patientsCard = screen.getByTestId('txr-intake-file-card-patients')
    expect(within(patientsCard).queryByTestId('txr-intake-join-offer-ldh')).toBeNull()
    expect(within(patientsCard).queryByTestId('txr-intake-vocab-offer-cea')).toBeNull()
    expect(
      within(measurementsCard)
        .getByTestId('txr-intake-file-messages-measurements')
        .contains(within(measurementsCard).getByTestId('txr-intake-join-offer-ldh')),
    ).toBe(true)
    api.validate.mockResolvedValue(validationFixture({ problems: [row14Problem, row88Problem] }))
    fireEvent.click(within(measurementsCard).getByTestId('txr-intake-join-accept-ldh'))
    await waitFor(() => {
      expect(store().joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])
    })
    fireEvent.click(within(measurementsCard).getByTestId('txr-intake-vocab-decline-cea'))
    await waitFor(() => {
      expect(screen.queryByTestId('txr-intake-vocab-offer-cea')).toBeNull()
    })
    expect(store().mapping.some(entry => entry.key === 'cea')).toBe(false)
  })

  it('a problem about both files (a patient missing from the patients file) shows ONCE', async () => {
    cleanFlow([row88Problem])
    renderFiles()
    await pickBoth()
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-file-problems-measurements')).toBeTruthy()
    })
    const lines = [
      ...document.querySelectorAll(
        '[data-testid="txr-intake-file-problems-patients"] > li, [data-testid="txr-intake-file-problems-measurements"] > li, [data-testid="txr-intake-file-notes-patients"] > li, [data-testid="txr-intake-file-notes-measurements"] > li',
      ),
    ]
      // The problem LINES (the last item of each list is the codes disclosure,
      // which names the message again next to its code).
      .filter(line => line.querySelector('details') === null)
      .filter(line => (line.textContent ?? '').includes('P0187 is not in the patients table'))
    expect(lines).toHaveLength(1)
    // The one line shows in the measurements card's messages row (the shared
    // problem was assigned to that side).
    expect(
      screen.getByTestId('txr-intake-file-card-measurements').contains(
        screen.getByTestId('txr-intake-file-messages-measurements'),
      ),
    ).toBe(true)
    expect(
      screen.getByTestId('txr-intake-file-messages-measurements').contains(lines[0]),
    ).toBe(true)
    expect(
      within(screen.getByTestId('txr-intake-file-messages-patients')).queryByText(/P0187/),
    ).toBeNull()
  })

  it('changing the patients file after the pair validated re-runs the check', async () => {
    cleanFlow()
    renderFiles()
    await pickBoth()
    await waitFor(() => expect(continueButton().disabled).toBe(false))

    fireEvent.click(screen.getByTestId('txr-intake-file-choose-again-patients'))
    expect(store().patients).toBeNull()
    expect(store().validation).toBeNull()
    expect(continueButton().disabled).toBe(true)
    expect(screen.queryByTestId('txr-intake-file-messages-patients')).toBeNull()
    // The measurements block stays, now waiting for the other file.
    expect(
      within(screen.getByTestId('txr-intake-file-messages-measurements')).getByText(
        'We check the files once both are here.',
      ),
    ).toBeTruthy()

    pickFile('txr-intake-file-drop-patients', 'patients_v2.csv', PATIENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(continueButton().disabled).toBe(false))
    expect(screen.getByTestId('txr-intake-file-messages-title-patients').textContent).toBe(
      'Patients file: patients_v2.csv',
    )
  })

  it('changing the measurements file after the pair validated re-runs the check', async () => {
    cleanFlow()
    renderFiles()
    await pickBoth()
    await waitFor(() => expect(continueButton().disabled).toBe(false))

    fireEvent.click(screen.getByTestId('txr-intake-file-choose-again-measurements'))
    expect(store().measurements).toBeNull()
    expect(store().validation).toBeNull()
    expect(continueButton().disabled).toBe(true)
    expect(screen.queryByTestId('txr-intake-file-messages-measurements')).toBeNull()

    pickFile('txr-intake-file-drop-measurements', 'draws_v2.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(continueButton().disabled).toBe(false))
    expect(screen.getByTestId('txr-intake-file-messages-title-measurements').textContent).toBe(
      'Measurements file: draws_v2.csv',
    )
  })

  it('both cards keep "Choose a different file" once the pair checks out (good and with notes)', async () => {
    cleanFlow([{ ...row88Problem, severity: 'warning' as const }])
    renderFiles()
    await pickBoth()
    await waitFor(() => expect(screen.getByText('Ready, with 1 note')).toBeTruthy())
    // Patients: the plain ready box; measurements: ready with notes.
    expect(
      within(screen.getByTestId('txr-intake-file-card-patients')).getByTestId(
        'txr-intake-file-choose-again-patients',
      ),
    ).toBeTruthy()
    expect(
      within(screen.getByTestId('txr-intake-file-card-measurements')).getByTestId(
        'txr-intake-file-choose-again-measurements',
      ),
    ).toBeTruthy()
  })
})

describe('demo mode (ITEM-6) — the example cards replace the upload surface', () => {
  it('auto-adopts the example pair; no drop zone, no file input, no Clear example; downloads stay', async () => {
    seedDemoMode('demo')
    api.example.mockImplementation(({ kind }: { kind: string }) =>
      Promise.resolve(kind === 'patients' ? PATIENTS_CSV : MEASUREMENTS_CSV),
    )
    api.validate.mockResolvedValue(validationFixture({ problems: [] }))
    renderFiles()

    await screen.findByTestId('txr-example-card-patients')
    const patientsCard = screen.getByTestId('txr-example-card-patients')
    expect(within(patientsCard).getByText('2 rows')).toBeTruthy()
    expect(within(patientsCard).getByText('Example')).toBeTruthy()
    expect(within(patientsCard).getByText('Download the template (CSV)')).toBeTruthy()
    expect(within(patientsCard).getByText('Download the full example (CSV)')).toBeTruthy()
    const measurementsCard = screen.getByTestId('txr-example-card-measurements')
    expect(within(measurementsCard).getByText('2 rows · 2 markers: ldh, cea')).toBeTruthy()

    // The upload surface is gone, not merely hidden behind a control.
    expect(screen.queryByTestId('txr-intake-file-card-patients')).toBeNull()
    expect(screen.queryByTestId('txr-intake-file-card-measurements')).toBeNull()
    expect(screen.queryByTestId('txr-intake-file-drop-patients')).toBeNull()
    expect(screen.queryByTestId('txr-intake-file-drop-measurements')).toBeNull()
    expect(document.querySelector('input[type=file]')).toBeNull()
    // No way to empty the only content demo offers.
    expect(screen.queryByTestId('txr-intake-clear-example')).toBeNull()
    expect(screen.queryByTestId('txr-use-example-train')).toBeNull()

    // The adopted example runs the page's own inspect/validate round and
    // the Continue gate opens.
    await waitFor(() => {
      expect(api.inspect).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(api.validate).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(continueButton().disabled).toBe(false)
    })
  })

  it('a failed example adoption shows the error + retry, and retry recovers', async () => {
    seedDemoMode('demo')
    api.example
      .mockRejectedValueOnce(new Error('no example'))
      .mockImplementation(({ kind }: { kind: string }) =>
        Promise.resolve(kind === 'patients' ? PATIENTS_CSV : MEASUREMENTS_CSV),
      )
    api.validate.mockResolvedValue(validationFixture({ problems: [] }))
    renderFiles()

    expect(await screen.findByTestId('txr-demo-example-error')).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-demo-example-retry'))
    await screen.findByTestId('txr-example-card-patients')
    expect(screen.queryByTestId('txr-demo-example-error')).toBeNull()
  })
})
