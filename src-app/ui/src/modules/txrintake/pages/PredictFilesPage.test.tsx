// @vitest-environment jsdom
/**
 * TEST-INT-12 [covers ITEM-7] — the N screen
 * (`pages/PredictFilesPage.tsx`): ONE measurements card (no patients card),
 * the "What the models look for" aside with the "No outcomes are needed,
 * and no patients file." line, the validate round in `mode: 'predict'` with
 * the patients key OMITTED (TEST-INT-3 / DRIFT-1 ITEM-6 #2), the board-N
 * status box (EXAMPLE-INT-3), and the Continue gate into `/choose-models`
 * (round 2 — the ONE merged model list; the round-1 bridge that chose
 * `/pretrained-models` for source `lab` and `/saved-models` for `saved` is
 * gone, the source preset is kept for the list's mount read).
 *
 * Harness identity with FilesPage.test.tsx (ITEM-6): the ApiClient is
 * mocked, the store is the real TxrIntake store (reset per test), and the
 * parse runs the REAL `parseCsvFile` against a genuine jsdom `File` —
 * jsdom 25's File lacks `text()`, so the test adds the standard polyfill
 * (the impl buffer is reachable through jsdom's Symbol(impl), the same
 * stand-in class as StudyPage's PointerEvent shim).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type {
  FileInspection,
  FileInspectionRequest,
  MarkerColumn,
  MarkerMatch,
  ValidationRequest,
  ValidationResponse,
} from '@/api-client/types'
import { PredictFilesPage } from './PredictFilesPage'
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
  exampleSet: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    FileValidation: {
      inspect: api.inspect,
      validate: api.validate,
      template: api.template,
      example: api.example,
    },
    Models: { exampleSet: api.exampleSet },
  },
}))

/** The board-N fixture in miniature (no patients side at all). */
const MEASUREMENTS_CSV =
  'patient_id,day,marker,value,unit\nN001,0,ldh,210,U/L\nN001,14,ldh,160,U/L\n'

const dayProblem = {
  code: 'R03' as const,
  severity: 'error' as const,
  row: 4,
  column: 'day',
  message: '`week 4` is not a number in the day column',
}

function inspectionFixture(): FileInspection {
  return {
    kind: 'measurements',
    source_name: 'predict_measurements.csv',
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
    problems: [],
    summary: { rows: 2, markers: [{ name: 'ldh', rows: 2 }], draw_days: [0, 14] },
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
  marker_id: 'loinc:27856-1',
  system: 'LOINC',
  display_name: 'Carcinoembryonic antigen',
  unit_family: 'concentration_mass',
  canonical_unit: 'ng/mL',
  n_methods: 9,
  match_kind: 'fuzzy',
}

function markerColumn(overrides: Partial<MarkerColumn> = {}): MarkerColumn {
  return {
    key: 'ldh',
    spellings: ['ldh'],
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

function validationFixture(overrides: Partial<ValidationResponse> = {}): ValidationResponse {
  return {
    problems: [],
    markers: [
      markerColumn(),
      markerColumn({ key: 'cea', spellings: ['cea'], vocabulary: [fuzzyMatch] }),
    ],
    measurements: { rows: 2, patients: 2, distinct_draw_days: [0, 14] },
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

function renderPredict(entry = '/predict-files') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <PredictFilesPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const routeAt = () => screen.getByTestId('route-location').textContent
const continueButton = () => screen.getByTestId<HTMLButtonElement>('txr-intake-continue')
const store = () => useTxrIntakeStore.getState()

/** Pick the file into the card's kit Upload (the hidden input's change). */
function pickMeasurements(name: string, content: string) {
  const file = new File([content], name, { type: 'text/csv' })
  const card = screen.getByTestId('txr-intake-file-card-measurements')
  const input = card.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

/** Pick an arbitrary file into an arbitrary card, by kit testid. */
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
  api.exampleSet.mockReset()
  api.inspect.mockResolvedValue(inspectionFixture())
  api.validate.mockResolvedValue(validationFixture())
  api.template.mockResolvedValue('patient_id,day,marker,value,unit\n')
  // The demo path's example-set ensure (the demo's recorded example models).
  api.exampleSet.mockResolvedValue({
    state: 'ready',
    set_id: 'set-demo',
    methods: ['kelim'],
    run_id: undefined,
    run_status: undefined,
    error: undefined,
  })
  window.localStorage.clear()
  store().reset()
})

afterEach(() => {
  cleanup()
  resetDemoMode()
  vi.restoreAllMocks()
})

describe('PredictFilesPage (screen N, ITEM-7)', () => {
  it('renders ONE measurements card with the board N copy, the aside and no patients card', () => {
    // The ONE predict path: the path sentence and the aside lead name every
    // model kind the merged list shows (round 3 — the old D/I split is gone;
    // the source preset still exists but nothing on this page reads it).
    store().setIntent('predict', 'lab')
    renderPredict()
    expect(screen.getByText('Add the patients to predict')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-file-card-measurements')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-file-card-patients')).toBeNull()
    expect(
      screen.getByText(
        'One row per marker per blood draw. Day 0 is the start of treatment; draws before it are negative.',
      ),
    ).toBeTruthy()
    // The N column table is its own copy: no patients side, so no "the same
    // in both files" — the board's wording.
    expect(screen.getByText('your own code')).toBeTruthy()
    expect(screen.getByText('for example LDH, ctDNA')).toBeTruthy()
    expect(screen.getByText('lets us check the scale against the model')).toBeTruthy()
    expect(screen.queryByText('your own code, the same in both files')).toBeNull()
    // The ONE path sentence (round 3): "You will pick from the models that
    // can run on this file: ready-made models from the lab, models you
    // saved, and models opened from a file."
    expect(screen.getByTestId('txr-intake-predict-path').textContent).toBe(
      'You will pick from the models that can run on this file: ready-made models from the lab, models you saved, and models opened from a file.',
    )
    // The aside + the board's bottom line.
    expect(screen.getByTestId('txr-intake-aside')).toBeTruthy()
    expect(screen.getByText('What the models look for')).toBeTruthy()
    expect(
      screen.getByText(
        'After you add the file we check which models can run on it. These are the draws most models use:',
      ),
    ).toBeTruthy()
    expect(screen.getByText('No outcomes are needed, and no patients file.')).toBeTruthy()
    expect(continueButton().disabled).toBe(true)
    expect(continueButton().textContent).toBe('Continue: choose models')
  })

  it('names the model the J "Use" handoff chose (RES-21) — and stays silent without one', () => {
    renderPredict()
    expect(screen.queryByTestId('txr-intake-pending-use')).toBeNull()
    cleanup()
    renderPredict(
      '/predict-files?use=a0000000-0000-4000-8000-000000000004&name=landmark-cox-current',
    )
    expect(screen.getByTestId('txr-intake-pending-use').textContent).toBe(
      'You chose the model \u201clandmark-cox-current\u201d. Add its patients\u2019 measurements to predict.',
    )
  })

  it('a dropped file validates in predict mode with the patients key OMITTED', async () => {
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)

    await waitFor(() => {
      expect(api.inspect).toHaveBeenCalledTimes(1)
    })
    const inspectCall = api.inspect.mock.calls[0][0] as FileInspectionRequest
    expect(inspectCall.kind).toBe('measurements')
    expect(inspectCall.table.columns).toEqual([
      'patient_id',
      'day',
      'marker',
      'value',
      'unit',
    ])

    // NO second file to wait for — the ONE predict file validates on its own.
    await waitFor(() => {
      expect(api.validate).toHaveBeenCalledTimes(1)
    })
    const validateCall = api.validate.mock.calls[0][0] as ValidationRequest
    expect(validateCall.mode).toBe('predict')
    expect('patients' in validateCall).toBe(false)
    expect(validateCall.measurements.rows).toHaveLength(2)
    expect(validateCall.joins).toEqual([])
    expect(validateCall.mapping).toEqual([])
    expect(validateCall.parameters).toEqual({ decision_day: 56, baseline_max_day: 0 })

    // The board-N status box (EXAMPLE-INT-3's data-filled line).
    await waitFor(() => {
      expect(screen.getByText('✓ 2 patients read')).toBeTruthy()
    })
    const status = screen.getByTestId('txr-intake-file-status-measurements')
    expect(
      within(status).getByText(
        'Found 2 rows: markers ldh and cea; draws at day 0 and 14. Next you choose the models that can run on it.',
      ),
    ).toBeTruthy()
    expect(continueButton().disabled).toBe(false)
  })

  it('Continue always goes to the merged model list (round 2 — the old bridge is gone)', async () => {
    store().setIntent('predict', 'lab')
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(continueButton().disabled).toBe(false))

    fireEvent.click(continueButton())
    expect(routeAt()).toBe('/choose-models')
    expect(store().mode).toBe('predict')
    // The round-1 source preset is kept for the merged list's mount read.
    expect(store().predictSource).toBe('lab')
  })

  it('Continue goes to the merged model list for source saved too (round-1 bridge)', async () => {
    store().setIntent('predict', 'saved')
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(continueButton().disabled).toBe(false))

    fireEvent.click(continueButton())
    expect(routeAt()).toBe('/choose-models')
    expect(store().mode).toBe('predict')
    expect(store().predictSource).toBe('saved')
  })

  it('an error problem keeps Continue disabled and the fix affordance removes the file', async () => {
    api.validate.mockResolvedValue(
      validationFixture({ problems: [dayProblem] }),
    )
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))

    const status = screen.getByTestId('txr-intake-file-status-measurements')
    expect(within(status).getByText('1 problem in 2 rows')).toBeTruthy()
    // R2-4: while the vocabulary suggestion is pending the problem list is
    // hidden (the question is the action); declining it brings the plain
    // line back (R2-3: the message byte, no appended code).
    expect(within(status).queryByTestId('txr-intake-file-problems-measurements')).toBeNull()
    fireEvent.click(screen.getByTestId('txr-intake-vocab-decline-cea'))
    await waitFor(() => {
      expect(within(status).getByTestId('txr-intake-file-problems-measurements')).toBeTruthy()
    })
    expect(
      screen
        .getByTestId('txr-intake-file-problems-measurements')
        .querySelector(':scope > li')?.textContent,
    ).toContain('Row 4: week 4 is not a number in the day column')
    expect(continueButton().disabled).toBe(true)

    fireEvent.click(within(status).getByText('Fix and choose the file again'))
    expect(store().predictMeasurements).toBeNull()
    // The decline above re-validated once (rejectVocab nulls the validation);
    // removeFile does not re-validate a bare slot.
    expect(api.validate).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Drop the measurements file here')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-file-status-measurements')).toBeNull()
  })

  it('an accepted join re-validates and the offer disappears', async () => {
    api.validate.mockResolvedValue(
      validationFixture({
        markers: [
          markerColumn({ spellings: ['ldh', 'LDH'] }),
          markerColumn({ key: 'cea', spellings: ['cea'], vocabulary: [fuzzyMatch] }),
        ],
        problems: [
          {
            code: 'A03' as const,
            severity: 'warning' as const,
            row: undefined,
            column: undefined,
            message: "marker spellings 'ldh' and 'LDH' look the same — join them?",
          },
        ],
      }),
    )
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('txr-intake-join-offer-ldh')).toBeTruthy()

    api.validate.mockResolvedValue(validationFixture())
    fireEvent.click(within(screen.getByTestId('txr-intake-join-offer-ldh')).getByText('Join them'))

    await waitFor(() => {
      expect(store().joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])
    })
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(2))
    const revalidated = api.validate.mock.calls[1][0] as ValidationRequest
    expect(revalidated.joins).toEqual([{ variants: ['ldh', 'LDH'], key: 'ldh' }])
    expect(revalidated.mode).toBe('predict')
    expect(screen.queryByTestId('txr-intake-join-offer-ldh')).toBeNull()
  })

  it('the aside study clause links to the study screen', () => {
    renderPredict()
    fireEvent.click(screen.getByTestId('txr-intake-aside-study'))
    expect(routeAt()).toBe('/study')
  })
})

describe('step3-file-cards — the predict screen carries its messages in its card', () => {
  it('the status box and the offers render inside the card, titled with the file name', async () => {
    renderPredict()
    // No file: no element carries the OLD shared row's id
    // (`txr-intake-file-messages`), which nothing renders any more, so a
    // leftover row outside the card cannot hide behind a stale query.
    expect(document.querySelectorAll('[data-testid="txr-intake-file-messages"]')).toHaveLength(0)
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))

    const card = screen.getByTestId('txr-intake-file-card-measurements')
    const row = screen.getByTestId('txr-intake-file-messages-measurements')
    // The messages row is INSIDE the one card and is its last child.
    expect(card.contains(row)).toBe(true)
    expect(card.lastElementChild).toBe(row)
    // The count check of 2: the one chosen file owns exactly its row + its
    // title — no old shared row, no duplicate render.
    expect(document.querySelectorAll('[data-testid^="txr-intake-file-messages-"]')).toHaveLength(2)
    expect(screen.getByTestId('txr-intake-file-messages-title-measurements').textContent).toBe(
      'Measurements file: predict_measurements.csv',
    )
    expect(within(row).getByTestId('txr-intake-file-status-measurements')).toBeTruthy()
    // The offer arrives with the validate round: wait for it IN the row, so
    // the half-absence checks below run after it exists.
    expect(await within(row).findByTestId('txr-intake-vocab-offer-cea')).toBeTruthy()
    // The card holds exactly ONE status box and ONE vocab offer — both in
    // its messages row; the halves keep only the preview.
    expect(card.querySelectorAll('[data-testid^="txr-intake-file-status-"]')).toHaveLength(1)
    expect(card.querySelectorAll('[data-testid^="txr-intake-vocab-offer-"]')).toHaveLength(1)
  })

  it('"Choose a different file" stays on the card once the file checks out, and a new pick re-checks', async () => {
    api.validate.mockResolvedValue(validationFixture({ markers: [markerColumn({ spellings: ['ldh'] })] }))
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(continueButton().disabled).toBe(false))

    const card = screen.getByTestId('txr-intake-file-card-measurements')
    fireEvent.click(within(card).getByTestId('txr-intake-file-choose-again-measurements'))
    expect(store().predictMeasurements).toBeNull()
    expect(continueButton().disabled).toBe(true)
    expect(screen.queryByTestId('txr-intake-file-messages-measurements')).toBeNull()

    pickMeasurements('predict_v2.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(continueButton().disabled).toBe(false))
    expect(screen.getByTestId('txr-intake-file-messages-title-measurements').textContent).toBe(
      'Measurements file: predict_v2.csv',
    )
  })
})

describe("ITEM-6 P1/F4 — the aside's bullets and items, the pick guard", () => {
  it('the aside list keeps the board dots and the lead-in runs INLINE with its fact (P1)', () => {
    renderPredict()
    const list = screen.getByText('Before treatment').closest('ul') as HTMLElement
    expect(list.style.listStyle).toBe('disc')
    // P1 (qa-fixes2): the old <br/> made the bold lead-in a block, so
    // "Markers" ended its line and ": ctDNA, LDH, …" started the next — the
    // report's broken colon. The board's own bytes are one line per item:
    // the <b> is followed by the fact IN THE SAME line.
    const item = screen.getByText('(day 0): needed by almost all models')
    expect(item.firstElementChild?.tagName).toBe('B')
    expect(item.firstElementChild?.textContent).toBe('Before treatment')
    expect(item.firstElementChild?.nextElementSibling).toBeNull()
    expect(item.textContent).toContain('(day 0): needed by almost all models')
    const markers = screen.getByText((_, element) =>
      element?.textContent?.startsWith('Markers: ctDNA, LDH, blood counts') === true,
    ) as HTMLElement
    expect(markers.textContent).toContain(': ctDNA, LDH, blood counts and tumour markers')
    const units = screen.getByText((_, element) =>
      element?.textContent?.startsWith('Units: add the unit column') === true,
    ) as HTMLElement
    expect(units.textContent).toContain(': add the unit column so we can check')
  })

  // R2-12 (qa-fixes2) → round 3: the aside's lead used to name the list the
  // Continue took (the ready-made list's byte vs the saved list's); the ONE
  // merged list made it ONE line for both source presets.
  it('the aside lead is the ONE merged line for both source presets (round 3)', () => {
    store().setIntent('predict', 'lab')
    renderPredict()
    expect(
      screen.getByText(
        'After you add the file we check which models can run on it. These are the draws most models use:',
      ),
    ).toBeTruthy()
    cleanup()
    store().setIntent('predict', 'saved')
    renderPredict()
    expect(
      screen.getByText(
        'After you add the file we check which models can run on it. These are the draws most models use:',
      ),
    ).toBeTruthy()
    expect(
      screen.queryByText(
        'After you add the file we check which ready-made models can run on it. These are the draws most models use:',
      ),
    ).toBeNull()
    expect(
      screen.queryByText(
        'After you add the file we check which of your saved models can run on it. These are the draws most models use:',
      ),
    ).toBeNull()
    // The path sentence is the ONE line too (never the old two-list spell).
    expect(screen.getByTestId('txr-intake-predict-path').textContent).toBe(
      'You will pick from the models that can run on this file: ready-made models from the lab, models you saved, and models opened from a file.',
    )
    expect(screen.queryByText(/(This is the ready-made model path|This is the saved-model path)/)).toBeNull()
    expect(store().predictSource).toBe('saved') // the preset itself is untouched
  })

  it('a wrong file type is refused with the plain sentence on the N card too (F4)', async () => {
    renderPredict()
    pickFile('txr-intake-file-drop-measurements', 'notes.txt', 'not a table')
    await waitFor(() => {
      expect(
        screen.getByText('This is not a CSV or Excel file — choose a .csv or .xlsx file.'),
      ).toBeTruthy()
    })
    expect(api.inspect).not.toHaveBeenCalled()
    expect(store().predictMeasurements).toBeNull()
  })
})

describe('demo mode (ITEM-6) — the example predict card replaces the upload', () => {
  it('auto-adopts the example predict table; no drop zone, no file input, no Clear example', async () => {
    seedDemoMode('demo')
    api.example.mockImplementation(({ kind }: { kind: string }) =>
      Promise.resolve(kind === 'predict-measurements' ? MEASUREMENTS_CSV : ''),
    )
    api.validate.mockResolvedValue(validationFixture())
    renderPredict()

    await screen.findByTestId('txr-example-card-predict')
    const card = screen.getByTestId('txr-example-card-predict')
    expect(within(card).getByText('Example patients to predict')).toBeTruthy()
    expect(within(card).getByText('Example')).toBeTruthy()
    expect(within(card).getByText(/^2 rows/)).toBeTruthy()
    expect(within(card).getByText('Download the template (CSV)')).toBeTruthy()
    expect(within(card).getByText('Download the full example (CSV)')).toBeTruthy()
    // The demo path's example card shows no file-messages row (the card
    // messages belong to the upload path's TxrFileCard only).
    expect(document.querySelectorAll('[data-testid^="txr-intake-file-messages"]')).toHaveLength(0)

    expect(screen.queryByTestId('txr-intake-file-card-measurements')).toBeNull()
    expect(screen.queryByTestId('txr-intake-file-drop-measurements')).toBeNull()
    expect(document.querySelector('input[type=file]')).toBeNull()
    expect(screen.queryByTestId('txr-intake-clear-example')).toBeNull()
    expect(screen.queryByTestId('txr-use-example-predict')).toBeNull()

    await waitFor(() => {
      expect(api.validate).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(continueButton().disabled).toBe(false)
    })
  })
})
