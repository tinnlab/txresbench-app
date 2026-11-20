// @vitest-environment jsdom
/**
 * Help's "Back to step N": Help opened from a step view (a problem code link
 * on step 3, or any step page's link through `HelpLink`) shows a button back
 * to THAT step; the step comes back with what was entered there. Help opened
 * any other way (the menu, a page that is not a step, a reload) shows none,
 * and so does a stale or unknown origin. The button runs the registered
 * `help.backToStep`; the step trail, the router and the file step are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, type InitialEntry } from 'react-router-dom'
import type { FileInspection, ValidationResponse } from '@/api-client/types'
import '@/core/actions/builtin/stepActions'
import { isContextActive } from '@/core/actions/activeContext'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { FilesPage } from '@/modules/txrintake/pages/FilesPage'
import { TxrStepBack, useStepBack } from '@/modules/txrintake/components/TxrStepBack'
import { useTxrIntakeStore } from '@/modules/txrintake/stores/TxrIntake.store'
import {
  beginPath,
  recordStep,
  TXR_HELP_FROM_STEP_CONTEXT,
  useStepTrailStore,
  type TxrStepId,
} from '@/modules/txrintake/lib/stepTrail'
import { __resetFetchCacheForTests } from '@/modules/txrintake/data/fetchCache'
import type { LoadedFile } from '@/modules/txrintake/types'
import { HelpLink } from '../components/HelpLink'
import { helpLinkState, helpPath } from '../routes'
import { HelpPage } from './HelpPage'

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

function validation(problems: ValidationResponse['problems']): ValidationResponse {
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

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{`${location.pathname}${location.search}`}</div>
}

/** A stand-in for a step view with a link into Help (its own suites cover its page). */
function StandInStep({ step, fallback }: { step: TxrStepId; fallback: string }) {
  useStepBack({ step, fallback })
  return (
    <div data-testid={`stand-in-${step}`}>
      <HelpLink anchor="run-states" data-testid="stand-in-help-link">
        How the run works
      </HelpLink>
      <TxrStepBack />
    </div>
  )
}

/** A page that is not a step (the menu's place): its Help links carry no step. */
function NotAStep() {
  return (
    <div>
      <Link to={helpPath()} data-testid="menu-help-link">
        Help
      </Link>
      <HelpLink data-testid="page-help-link">Help</HelpLink>
    </div>
  )
}

function renderApp(entry: InitialEntry) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <RouterBridge />
      <LocationProbe />
      <Routes>
        <Route path="/" element={<div data-testid="start" />} />
        <Route path="/study" element={<StandInStep step="study" fallback="/" />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/choose-methods" element={<StandInStep step="choose-methods" fallback="/files" />} />
        <Route path="/history" element={<NotAStep />} />
        <Route path="/help" element={<HelpPage />} />
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

const backToStep = () => screen.queryByTestId('txr-help-back-to-step')

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  for (const fn of Object.values(api)) fn.mockReset()
  api.inspect.mockImplementation(({ kind }: { kind: 'patients' | 'measurements' }) =>
    Promise.resolve({
      kind,
      source_name: `${kind}.csv`,
      columns: { resolved: {}, unresolved: [], covariate_columns: [] },
      problems: [],
      summary: { rows: 2, markers: [], draw_days: [0] },
    } as unknown as FileInspection),
  )
  window.localStorage.clear()
  useTxrIntakeStore.getState().reset()
  useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  __resetFetchCacheForTests()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Help opened from a step', () => {
  it('step 2: a problem code link opens Help with "Back to step 2", which returns with the files kept', async () => {
    const patients = file('patients.csv')
    // The card's problem list reads the file's own problems (the check's rows for this card).
    const measurements = { ...file('measurements.csv'), problems: [errorProblem], prepared: false }
    const checked = validation([errorProblem])
    useTxrIntakeStore.setState({ intent: 'train', mode: 'study', patients, measurements, validation: checked })
    beginPath('/')
    recordStep('/study')
    renderApp('/files')

    await click('txr-intake-problem-help-R03')
    expect(routeAt()).toBe('/help')
    const button = screen.getByRole('button', { name: 'Back to step 2: Add your files' })
    expect(button).toBe(backToStep())
    expect(isContextActive(TXR_HELP_FROM_STEP_CONTEXT)).toBe(true)

    await click('txr-help-back-to-step')
    expect(routeAt()).toBe('/files')
    expect(isContextActive(TXR_HELP_FROM_STEP_CONTEXT)).toBe(false)
    // The step comes back as it was left: the same files, the same check, the same problem.
    const state = useTxrIntakeStore.getState()
    expect(state.patients).toBe(patients)
    expect(state.measurements).toBe(measurements)
    expect(state.validation).toBe(checked)
    expect(screen.getByTestId('txr-intake-problem-help-R03')).toBeTruthy()
    expect(api.validate).not.toHaveBeenCalled()
    // The path is kept too: Back from the files step still goes to the study step.
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/study', '/files'])
    await click('txr-step-back')
    expect(routeAt()).toBe('/study')
  })

  it('another step page: its Help link opens Help with "Back to step 4", which returns there', async () => {
    beginPath('/history')
    renderApp('/choose-methods')
    await click('stand-in-help-link')
    expect(routeAt()).toBe('/help')
    expect(backToStep()?.textContent).toBe('Back to step 4: Choose the methods and settings')
    await click('txr-help-back-to-step')
    expect(routeAt()).toBe('/choose-methods')
    expect(useStepTrailStore.getState().trail).toEqual(['/history', '/choose-methods'])
  })

  it('the button stays while the user moves within Help by its contents links', async () => {
    beginPath('/')
    renderApp('/study')
    await click('stand-in-help-link')
    expect(backToStep()?.textContent).toBe('Back to step 3: Tell us about your study')
    await click('txr-help-toc-troubleshooting')
    expect(routeAt()).toBe('/help')
    expect(backToStep()?.textContent).toBe('Back to step 3: Tell us about your study')
    await click('txr-help-back-to-step')
    expect(routeAt()).toBe('/study')
  })

  it('the button goes away once a new path starts from Help (the step is no longer open)', async () => {
    beginPath('/')
    renderApp('/study')
    await click('stand-in-help-link')
    expect(backToStep()?.textContent).toBe('Back to step 3: Tell us about your study')
    await act(async () => {
      beginPath('/help')
    })
    expect(backToStep()).toBeNull()
    expect(isContextActive(TXR_HELP_FROM_STEP_CONTEXT)).toBe(false)
  })
})

describe('Help opened any other way shows no button', () => {
  it('from the menu or a page that is not a step', async () => {
    beginPath('/')
    recordStep('/files')
    renderApp('/history')
    await click('menu-help-link')
    expect(routeAt()).toBe('/help')
    expect(backToStep()).toBeNull()
    cleanup()
    renderApp('/history')
    await click('page-help-link')
    expect(routeAt()).toBe('/help')
    expect(backToStep()).toBeNull()
    expect(isContextActive(TXR_HELP_FROM_STEP_CONTEXT)).toBe(false)
  })

  it('opened directly (a typed address): no router state', () => {
    beginPath('/')
    recordStep('/files')
    renderApp('/help')
    expect(backToStep()).toBeNull()
  })

  it('after a reload: the router state is still there but the step trail is empty, so no button', () => {
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    renderApp({ pathname: '/help', state: helpLinkState('/files') })
    expect(backToStep()).toBeNull()
    expect(isContextActive(TXR_HELP_FROM_STEP_CONTEXT)).toBe(false)
    // The same state with a trail ending at that step DOES show the button;
    // only the empty trail keeps it away.
    cleanup()
    beginPath('/')
    recordStep('/files')
    renderApp({ pathname: '/help', state: helpLinkState('/files') })
    expect(backToStep()).not.toBeNull()
  })

  it('an unknown origin: not a step URL, or not a string', () => {
    beginPath('/')
    recordStep('/files')
    renderApp({ pathname: '/help', state: helpLinkState('/history') })
    expect(backToStep()).toBeNull()
    cleanup()
    renderApp({ pathname: '/help', state: { helpFrom: 42 } })
    expect(backToStep()).toBeNull()
    expect(isContextActive(TXR_HELP_FROM_STEP_CONTEXT)).toBe(false)
  })

  it('a stale origin: the step is not the last step of the trail any more', () => {
    beginPath('/')
    recordStep('/study')
    recordStep('/files')
    renderApp({ pathname: '/help', state: helpLinkState('/study') })
    expect(backToStep()).toBeNull()
    cleanup()
    beginPath('/help')
    renderApp({ pathname: '/help', state: helpLinkState('/files') })
    expect(backToStep()).toBeNull()
    expect(isContextActive(TXR_HELP_FROM_STEP_CONTEXT)).toBe(false)
  })
})
