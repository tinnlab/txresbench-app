// @vitest-environment jsdom
/**
 * The Back button on the intake step views (B Your study, C Your files, N
 * Patients to predict), walked through the real pages in one router:
 *
 * - placement: in every state of B, C and N the Back button is the element
 *   directly before the step's proceed button, in the same row;
 * - targets: Back lands on the step the path showed before (the Start
 *   cards' paths: rows 1, 3 and 4 of the plan's flow map; the learn path is
 *   Start, C, B, E) and Start begins the trail;
 * - state: Back from B to C and Continue again keeps C's files and validation.
 *
 * The model and method steps after N and C are stand-ins here (their own
 * suites cover their Back); the trail and the `flow.back` action are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { FileInspection, MarkerGroup, ValidationResponse } from '@/api-client/types'
import '@/core/actions/builtin/stepActions'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { resetDemoMode, seedDemoMode } from '@/modules/demo/test-utils/demoSeed'
import { StartPage } from './StartPage'
import { StudyPage } from './StudyPage'
import { FilesPage } from './FilesPage'
import { PredictFilesPage } from './PredictFilesPage'
import { TxrStepBack, useStepBack } from '../components/TxrStepBack'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { useStepTrailStore, type TxrStepId } from '../lib/stepTrail'
import { __resetFetchCacheForTests } from '../data/fetchCache'
import { TXR_INTAKE_FILTER_OPTIONS } from '../fixtures'
import type { LoadedFile } from '../types'

// jsdom has no working PointerEvent constructor (the kit controls build one).
{
  const w = window as unknown as {
    PointerEvent?: new (type: string, init?: MouseEventInit) => MouseEvent
  }
  try {
    void new (w.PointerEvent as new (type: string, init?: MouseEventInit) => MouseEvent)('probe')
  } catch {
    w.PointerEvent = class extends MouseEvent {}
  }
}

const api = vi.hoisted(() => ({
  list: vi.fn(),
  eligibility: vi.fn(),
  markers: vi.fn(),
  filterOptions: vi.fn(),
  inspect: vi.fn(),
  validate: vi.fn(),
  template: vi.fn(),
  example: vi.fn(),
  exampleSet: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      list: api.list,
      eligibility: api.eligibility,
      markers: api.markers,
      filterOptions: api.filterOptions,
    },
    FileValidation: {
      inspect: api.inspect,
      validate: api.validate,
      template: api.template,
      example: api.example,
    },
    Models: {
      exampleSet: api.exampleSet,
    },
  },
}))

const GROUPS: MarkerGroup[] = [{ id: 'ldh', display_name: 'LDH' }]

const PATIENTS_CSV = 'patient_id,pfs_days,pfs_event\nP0001,214,1\nP0002,380,0\n'
const MEASUREMENTS_CSV = 'patient_id,day,marker,value,unit\nP0001,0,ldh,210,U/L\n'

const errorProblem = {
  code: 'R03' as const,
  severity: 'error' as const,
  row: 4,
  column: 'day',
  message: '`week 4` is not a number in the day column',
}

function file(name: string): LoadedFile {
  return {
    source: { name, format: 'csv' },
    table: {
      source: { name, format: 'csv' },
      header_row: 1,
      columns: ['patient_id', 'day'],
      rows: [['P0001', '0']],
    },
    inspection: null,
    problems: [],
    prepared: true,
    joinOffers: [],
    vocabOffers: [],
    columnOffers: [],
  }
}

function inspection(kind: 'patients' | 'measurements'): FileInspection {
  return {
    kind,
    source_name: `${kind}.csv`,
    columns: { resolved: {}, unresolved: [], covariate_columns: [] },
    problems: [],
    summary: { rows: 2, markers: [], draw_days: [0] },
  } as unknown as FileInspection
}

function validation(problems: ValidationResponse['problems'] = []): ValidationResponse {
  return {
    problems,
    markers: [],
    measurements: { rows: 2, patients: 2, distinct_draw_days: [0, 14] },
    patients: {
      rows: 2,
      with_primary_outcome: 1,
      primary_outcome_events: 1,
      median_followup_days: 214,
    },
    inventory: { baseline_max_day: 0, decision_day: 56, patients: 2, covariates: [], markers: [] },
  }
}

const store = () => useTxrIntakeStore.getState()

function seedTrain(problems: ValidationResponse['problems'] = []): void {
  useTxrIntakeStore.setState({
    intent: 'train',
    mode: 'study',
    patients: file('patients.csv'),
    measurements: file('measurements.csv'),
    validation: validation(problems),
  })
}

function seedPredict(problems: ValidationResponse['problems'] = []): void {
  useTxrIntakeStore.setState({
    intent: 'pretrained',
    mode: 'predict',
    predictMeasurements: file('predict.csv'),
    validation: validation(problems),
  })
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{`${location.pathname}${location.search}`}</div>
}

/** A stand-in for a step after N or C (its own suite covers its page). */
function StandIn({ step, fallback }: { step: TxrStepId; fallback: string }) {
  useStepBack({ step, fallback })
  return (
    <div data-testid={`stand-in-${step}`}>
      <TxrStepBack />
    </div>
  )
}

function renderApp(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <RouterBridge />
      <LocationProbe />
      <Routes>
        <Route path="/" element={<StartPage />} />
        <Route path="/study" element={<StudyPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/predict-files" element={<PredictFilesPage />} />
        <Route
          path="/choose-methods"
          element={<StandIn step="choose-methods" fallback="/files" />}
        />
        <Route
          path="/pretrained-models"
          element={<StandIn step="pretrained-models" fallback="/predict-files" />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

const routeAt = () => screen.getByTestId('route-location').textContent

async function click(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
    await Promise.resolve()
  })
}

/** Back is the element directly before the proceed button, in its row. */
function expectBackBefore(proceedTestId: string): void {
  const back = screen.getByTestId('txr-step-back')
  expect(back.textContent).toContain('Back')
  expect(back.nextElementSibling).toBe(screen.getByTestId(proceedTestId))
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.list.mockResolvedValue({ methods: [], total: 3 })
  api.markers.mockResolvedValue({ groups: GROUPS, markers: [] })
  // The study page reads the method filter-options vocabulary (step2-filters):
  // the shared module fixture supplies it, so the page's disease/treatment
  // selects and the answers-action vocabulary gate behave as before.
  api.filterOptions.mockResolvedValue(TXR_INTAKE_FILTER_OPTIONS)
  api.eligibility.mockResolvedValue({
    methods: [],
    total_fit: 0,
    total_some: 0,
    total_cannot: 0,
    total_no_env: 0,
  })
  api.inspect.mockImplementation(({ kind }: { kind: 'patients' | 'measurements' }) =>
    Promise.resolve(inspection(kind === 'patients' ? 'patients' : 'measurements')),
  )
  api.validate.mockResolvedValue(validation())
  api.example.mockImplementation(({ kind }: { kind: string }) =>
    Promise.resolve(kind === 'patients' ? PATIENTS_CSV : MEASUREMENTS_CSV),
  )
  window.localStorage.clear()
  store().reset()
  useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  __resetFetchCacheForTests()
})

afterEach(() => {
  cleanup()
  resetDemoMode()
  vi.restoreAllMocks()
})

describe('Back placement on B, C and N (every state)', () => {
  it('B: first in the footer row, left of Continue, while the questions load', () => {
    api.markers.mockReturnValue(new Promise(() => undefined))
    renderApp('/study')
    expectBackBefore('txr-intake-study-continue')
  })

  it('B: left of Continue when the questions failed to load, and once they are there', async () => {
    api.markers.mockRejectedValue(new Error('no markers'))
    renderApp('/study')
    await screen.findByRole('alert')
    expectBackBefore('txr-intake-study-continue')
    cleanup()
    __resetFetchCacheForTests()
    api.markers.mockResolvedValue({ groups: GROUPS, markers: [] })
    renderApp('/study')
    await screen.findByRole('checkbox', { name: 'LDH' })
    expectBackBefore('txr-intake-study-continue')
  })

  it('C: left of Continue with no file, while the check runs, with problems, and ready', async () => {
    renderApp('/files')
    expectBackBefore('txr-intake-continue')
    cleanup()

    api.validate.mockReturnValue(new Promise(() => undefined))
    useTxrIntakeStore.setState({ patients: file('patients.csv'), measurements: file('measurements.csv') })
    renderApp('/files')
    await waitFor(() => expect(api.validate).toHaveBeenCalled())
    expectBackBefore('txr-intake-continue')
    cleanup()

    seedTrain([errorProblem])
    renderApp('/files')
    expect(screen.getByText('Fix the problems to continue.')).toBeTruthy()
    expectBackBefore('txr-intake-continue')
    cleanup()

    seedTrain()
    renderApp('/files')
    expect(screen.getByTestId<HTMLButtonElement>('txr-intake-continue').disabled).toBe(false)
    expectBackBefore('txr-intake-continue')
  })

  it('C: left of Continue while the demo example loads', () => {
    seedDemoMode('demo')
    api.example.mockReturnValue(new Promise(() => undefined))
    renderApp('/files')
    expect(screen.getByTestId('txr-demo-example-loading')).toBeTruthy()
    expectBackBefore('txr-intake-continue')
  })

  it('N: left of Continue with no file, while the check runs, with problems, and ready', async () => {
    renderApp('/predict-files')
    expectBackBefore('txr-intake-continue')
    cleanup()

    api.validate.mockReturnValue(new Promise(() => undefined))
    useTxrIntakeStore.setState({ intent: 'pretrained', mode: 'predict', predictMeasurements: file('predict.csv') })
    renderApp('/predict-files')
    await waitFor(() => expect(api.validate).toHaveBeenCalled())
    expectBackBefore('txr-intake-continue')
    cleanup()

    seedPredict([errorProblem])
    renderApp('/predict-files')
    expect(screen.getByText('Fix the problems to continue.')).toBeTruthy()
    expectBackBefore('txr-intake-continue')
    cleanup()

    seedPredict()
    renderApp('/predict-files')
    expect(screen.getByTestId<HTMLButtonElement>('txr-intake-continue').disabled).toBe(false)
    expectBackBefore('txr-intake-continue')
  })

  it('N: left of Continue while the demo example loads', () => {
    seedDemoMode('demo')
    api.example.mockReturnValue(new Promise(() => undefined))
    renderApp('/predict-files')
    expect(screen.getByTestId('txr-demo-example-loading')).toBeTruthy()
    expectBackBefore('txr-intake-continue')
  })

  it('Start has no Back', () => {
    renderApp('/')
    expect(screen.queryByTestId('txr-step-back')).toBeNull()
  })
})

describe('Back targets along the Start paths', () => {
  it('Start begins the trail', () => {
    useStepTrailStore.setState({ trail: ['/history', '/choose-methods'] })
    renderApp('/')
    expect(useStepTrailStore.getState().trail).toEqual(['/'])
  })

  it('row 1 — the pretrained card: A → N → D; Back from D is N, Back from N is Start', async () => {
    seedPredict()
    renderApp('/')
    await click('txr-intake-start-card-pretrained-cta')
    expect(routeAt()).toBe('/predict-files')
    await click('txr-intake-continue')
    expect(routeAt()).toBe('/pretrained-models')
    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
    await click('txr-step-back')
    expect(routeAt()).toBe('/')
  })

  it('row 3 — the train card: A → C → B → E; Back walks E → B → C → Start', async () => {
    seedTrain()
    renderApp('/')
    await click('txr-intake-start-card-train-cta')
    expect(routeAt()).toBe('/files')
    await click('txr-intake-continue')
    expect(routeAt()).toBe('/study')
    await click('txr-intake-study-continue')
    expect(routeAt()).toBe('/choose-methods')
    await click('txr-step-back')
    expect(routeAt()).toBe('/study')
    await click('txr-step-back')
    expect(routeAt()).toBe('/files')
    await click('txr-step-back')
    expect(routeAt()).toBe('/')
  })

  it('row 4 — the train "Use example" lands on C: Back from C is Start', async () => {
    renderApp('/')
    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => expect(routeAt()).toBe('/files'))
    await click('txr-step-back')
    expect(routeAt()).toBe('/')
  })

  it('row 7 — N study link, then Continue: Back from B is N; then Back from N is Start', async () => {
    seedPredict()
    renderApp('/')
    await click('txr-intake-start-card-pretrained-cta')
    await click('txr-intake-aside-study')
    expect(routeAt()).toBe('/study')
    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
    await click('txr-intake-aside-study')
    await click('txr-intake-study-continue')
    expect(routeAt()).toBe('/predict-files')
    await click('txr-step-back')
    expect(routeAt()).toBe('/')
  })

  it('a deep link (no trail): B goes back to C, C to Start, N to Start, and N with a "Use" search to Your models', async () => {
    renderApp('/study')
    await click('txr-step-back')
    expect(routeAt()).toBe('/files')
    cleanup()
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    renderApp('/files')
    await click('txr-step-back')
    expect(routeAt()).toBe('/')
    cleanup()
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    renderApp('/predict-files')
    await click('txr-step-back')
    expect(routeAt()).toBe('/')
    cleanup()
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    renderApp('/predict-files?use=m1&name=Model')
    await click('txr-step-back')
    expect(routeAt()).toBe('/models')
  })
})

describe('a path that changes the mode', () => {
  it('after a predict path, the learn path\u2019s Your files does not continue on the predict file\u2019s check', async () => {
    seedPredict()
    renderApp('/')
    await click('txr-intake-start-card-train-cta')
    expect(routeAt()).toBe('/files')
    expect(screen.getByTestId<HTMLButtonElement>('txr-intake-continue').disabled).toBe(true)
    expect(screen.getByText('Both files are needed before the check runs.')).toBeTruthy()
  })
})

describe('state kept across Back', () => {
  it('C keeps its files and validation after Back from B and Continue again (no new check)', async () => {
    seedTrain()
    const before = store()
    useStepTrailStore.setState({ trail: ['/', '/files'] })
    renderApp('/study')
    await click('txr-step-back')
    expect(routeAt()).toBe('/files')
    await click('txr-intake-continue')
    expect(routeAt()).toBe('/study')
    const after = store()
    expect(after.patients).toBe(before.patients)
    expect(after.measurements).toBe(before.measurements)
    expect(after.validation).toBe(before.validation)
    expect(api.validate).not.toHaveBeenCalled()
    expect(api.inspect).not.toHaveBeenCalled()
  })
})

describe('the "← Step x of y" line (the step line goes back, like the Back button)', () => {
  it('B, C and N carry the arrow line with their own step; Start keeps a plain step line', async () => {
    renderApp('/files')
    expect(screen.getByTestId('txr-step-line-back').textContent).toBe('Step 2 of 4')
    cleanup()
    renderApp('/study')
    expect(screen.getByTestId('txr-step-line-back').textContent).toBe('Step 3 of 4')
    cleanup()
    // The predict paths have three steps.
    renderApp('/predict-files')
    expect(screen.getByTestId('txr-step-line-back').textContent).toBe('Step 2 of 3')
    cleanup()
    // The study questions opened from N are a side trip: the line has no number.
    useTxrIntakeStore.setState({ intent: 'pretrained', mode: 'predict' })
    renderApp('/study')
    expect(screen.getByTestId('txr-step-line-back').textContent).toBe('Back')
    cleanup()
    renderApp('/')
    expect(screen.queryByTestId('txr-step-line-back')).toBeNull()
    expect(screen.getByText('Step 1 of 4')).toBeTruthy()
  })

  it('row 3 — the train card: the line walks back B → C → Start, as Back does', async () => {
    seedTrain()
    renderApp('/')
    await click('txr-intake-start-card-train-cta')
    await click('txr-intake-continue')
    expect(routeAt()).toBe('/study')
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/files')
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/')
  })

  it('row 4 — the train "Use example" lands on C: the line on C goes to Start', async () => {
    renderApp('/')
    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => expect(routeAt()).toBe('/files'))
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/')
  })

  it('row 1 — the pretrained card: the line on N goes to Start (B is skipped)', async () => {
    seedPredict()
    renderApp('/')
    await click('txr-intake-start-card-pretrained-cta')
    expect(routeAt()).toBe('/predict-files')
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/')
  })

  it('a deep link (no trail): the line goes where Back goes (B → C, C → Start, N → Start, N "Use" → Your models)', async () => {
    for (const [entry, target] of [
      ['/study', '/files'],
      ['/files', '/'],
      ['/predict-files', '/'],
      ['/predict-files?use=m1&name=Model', '/models'],
    ] as const) {
      useStepTrailStore.setState({ trail: [], current: null, leaving: false })
      renderApp(entry)
      await click('txr-step-line-back')
      expect(routeAt(), entry).toBe(target)
      cleanup()
    }
  })

  it('in every state of C and N (no file, problems), the line is there', async () => {
    renderApp('/files')
    expect(screen.getByTestId('txr-step-line-back')).toBeTruthy()
    cleanup()
    seedPredict([errorProblem])
    renderApp('/predict-files')
    expect(screen.getByText('Fix the problems to continue.')).toBeTruthy()
    expect(screen.getByTestId('txr-step-line-back')).toBeTruthy()
  })
})
