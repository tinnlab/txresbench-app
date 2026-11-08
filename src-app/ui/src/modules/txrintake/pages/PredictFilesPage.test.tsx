// @vitest-environment jsdom
/**
 * TEST-INT-12 [covers ITEM-7] — the N screen
 * (`pages/PredictFilesPage.tsx`): ONE measurements card (no patients card),
 * the "What the models look for" aside with the "No outcomes are needed,
 * and no patients file." line, the validate round in `mode: 'predict'` with
 * the patients key OMITTED (TEST-INT-3 / DRIFT-1 ITEM-6 #2), the board-N
 * status box (EXAMPLE-INT-3), the Continue gate into `/pretrained-models`
 * for intent `pretrained` and `/saved-models` for `reuse` (DEC-3).
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

function renderPredict() {
  return render(
    <MemoryRouter initialEntries={['/predict-files']}>
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

beforeEach(() => {
  api.inspect.mockReset()
  api.validate.mockReset()
  api.template.mockReset()
  api.example.mockReset()
  api.inspect.mockResolvedValue(inspectionFixture())
  api.validate.mockResolvedValue(validationFixture())
  api.template.mockResolvedValue('patient_id,day,marker,value,unit\n')
  window.localStorage.clear()
  store().reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PredictFilesPage (screen N, ITEM-7)', () => {
  it('renders ONE measurements card with the board N copy, the aside and no patients card', () => {
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
    // The aside + the board's bottom line.
    expect(screen.getByTestId('txr-intake-aside')).toBeTruthy()
    expect(screen.getByText('What the models look for')).toBeTruthy()
    expect(
      screen.getByText(
        'After you add the file we check which pretrained models can run on it. These are the draws most models use:',
      ),
    ).toBeTruthy()
    expect(screen.getByText('No outcomes are needed, and no patients file.')).toBeTruthy()
    expect(continueButton().disabled).toBe(true)
    expect(continueButton().textContent).toBe('Continue: choose models')
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

  it('Continue goes to the pretrained models screen for intent pretrained', async () => {
    store().setIntent('pretrained')
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(continueButton().disabled).toBe(false))

    fireEvent.click(continueButton())
    expect(routeAt()).toBe('/pretrained-models')
    expect(store().mode).toBe('predict')
  })

  it('Continue goes to the saved models screen for intent reuse', async () => {
    store().setIntent('reuse')
    renderPredict()
    pickMeasurements('predict_measurements.csv', MEASUREMENTS_CSV)
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(continueButton().disabled).toBe(false))

    fireEvent.click(continueButton())
    expect(routeAt()).toBe('/saved-models')
    expect(store().mode).toBe('predict')
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
    // The ITEM-4 code link is appended to the provider's line.
    expect(
      within(status).getAllByRole('listitem')[0].textContent,
    ).toContain('Row 4: `week 4` is not a number in the day column')
    expect(continueButton().disabled).toBe(true)

    fireEvent.click(within(status).getByText('Fix and choose the file again'))
    expect(store().predictMeasurements).toBeNull()
    expect(api.validate).toHaveBeenCalledTimes(1)
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
