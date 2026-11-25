// @vitest-environment jsdom
/**
 * The E page's unit suite — TEST-RUN-15's settings rows (ITEM-7) and
 * TEST-RUN-17's list + create-path rows (ITEM-8) + TEST-RUN-36's
 * keep-copies row, one file per the TESTS map.
 *
 * ITEM-7's pins: the DEC-6 mount merge (the intake's current decision day
 * first, the engine's sticky config for every other field — the page binds
 * the hook's RAW `engine`, DRIFT-1 ITEM-4 #1), the write-through of every
 * row change to `useRunConfig().update` (the 400 ms debounced
 * `Txr.updateAnalysisConfig`, CONS-UI-RUN-6), and the Extra-inputs names
 * line from the patients file's inspection `covariate_columns`.
 *
 * ITEM-8's pins: the page hosts the SHARED `TxrSelectList` (INV-3) fed by
 * `useMethodRows(inventory)` (the intake validation's inventory — never
 * re-derived) with the `buildGroupChips` filter chips and the
 * estimate-driven bottom bar (`bottomBar.notice = RESEARCH_NOTICE`); the
 * Run button wires `onRun(keys, {atATime, saveModels})` →
 * `buildRunRequest` → `ApiClient.Txr.createRun`, and on `202` the location
 * becomes the new run's `runningPath`; a `409 RUN_ALREADY_ACTIVE` resolves
 * through `Txr.listRuns` to the active run's `runningPath` (DEC-18); a
 * `404 METHOD_NOT_FOUND` drops the named row from the selection with the
 * visible notice; the transient null-validation state (a mutation the
 * change-files dialog made) renders the pending line, never a fabricated
 * inventory (DEC-16's never-half-broken rule); the E-board lead paragraph
 * is data-filled from the inventory (the board's "151 patients" is a design
 * example — the fixture's own count is asserted, INV-6).
 *
 * TEST-RUN-36's pins: the keep-copies preference is read ONCE at mount
 * (`History.getPreferences`), a successful read overrides the request's
 * `input.keep_copies`, a failed read falls back to the builder default
 * `true`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Button, message } from '@txresbench/kit'
import '@/core/actions/builtin/stepActions'
import { RouterBridge } from '@/core/actions/navigateBridge'
import type {
  EligibilityResponse,
  FileInspection,
  InventoryMarker,
  MethodSummary,
  TxrAppConfig,
  TxrRunListResponse,
  TxrRunSummary,
  ValidationResponse,
} from '@/api-client/types'
import type { TxrIntakeState } from '@/modules/txrintake'
import type { FileTimeline } from '@/api-client/types'
import {
  STEP_BACK_DIALOG_OPEN,
  STEP_BACK_STARTING_REASON,
  useStepBack,
  useStepTrailStore,
  useTxrIntakeStore,
} from '@/modules/txrintake'
import { __resetFetchCacheForTests } from '@/modules/txrintake/data/fetchCache'
import { RESEARCH_NOTICE } from '../lib/format'
import { METHOD_LIST_CHANGED_NOTICE, RUN_METHODS_GONE_LINE } from '../lib/runErrors'
import { __resetMethodListRevisionForTests } from '@/lib/txr-method-list/revision'
import { ChooseMethodsPage } from './ChooseMethodsPage'
import { RUN_CONFIG_DEBOUNCE_MS } from '../data/useRunConfig'
import { resetDemoMode, seedDemoMode } from '@/modules/demo/test-utils/demoSeed'
import { DEMO_DISABLED_REASON, DEMO_SETTINGS_NOTE } from '@/modules/demo/copy'
import { runAction } from '@/core/actions/defineAction'
import { instancesOfType } from '@/core/actions/instanceRegistry'
import { RUN_SETTINGS_SET_COVARIATES } from '../lib/settings'
import '@/core/actions/builtin/methodActions'
import '@/core/actions/builtin/dayActions'
import '@/core/actions/builtin/worldModel'

// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Switch/Segmented/Select) construct one on pointer interaction, which
// would throw and swallow the click. A MouseEvent subclass is the standard
// jsdom stand-in (the StudyPage test's shim, copied).
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
  getConfig: vi.fn(),
  putConfig: vi.fn(),
  listMethods: vi.fn(),
  eligibility: vi.fn(),
  estimate: vi.fn(),
  detail: vi.fn(),
  createRun: vi.fn(),
  listRuns: vi.fn(),
  getPrefs: vi.fn(),
  listUpdates: vi.fn(),
  filterOptions: vi.fn(),
  markerRanking: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getAnalysisConfig: api.getConfig,
      updateAnalysisConfig: api.putConfig,
      createRun: api.createRun,
      listRuns: api.listRuns,
      markerRanking: api.markerRanking,
    },
    MethodCatalogue: {
      list: api.listMethods,
      eligibility: api.eligibility,
      estimate: api.estimate,
      detail: api.detail,
      filterOptions: api.filterOptions,
    },
    History: {
      getPreferences: api.getPrefs,
    },
    MethodList: {
      updates: api.listUpdates,
    },
  },
}))

// The day-choice tests drive a refusal through the page's own `chooseDay`
// catch (`runSettings.setDay`): the registered action is otherwise refused
// only where the number box already refuses, so the wrapper lets ONE test
// make it reject and asserts the surfaced message.
const actionMock = vi.hoisted(() => ({ rejectSetDay: false }))
vi.mock('@/core/actions/defineAction', async importOriginal => {
  const actual = await importOriginal<typeof import('@/core/actions/defineAction')>()
  return {
    ...actual,
    runAction: (id: string, params: unknown, ctx?: unknown): Promise<unknown> => {
      if (id === 'runSettings.setDay' && actionMock.rejectSetDay) {
        return Promise.reject(new Error('Choose a day after the decision day (day 56).'))
      }
      return actual.runAction(id, params, ctx as never)
    },
  }
})

// ── jsdom has no layout, and the shared list is a VIRTUALIZED window ──
// The virtualizer reads the overlayscrollbars viewport's offsetHeight and
// each row's measured height; jsdom answers 0 to all of them, so the layout
// is STATED (the TxrSelectList suite's own idiom): a tall viewport, every
// item measuring the row height the list estimates.
const VIEWPORT_H = 1200
const ROW_H = 56

const isViewport = (el: HTMLElement): boolean =>
  el.hasAttribute('data-overlayscrollbars-viewport')

let restoreLayout: (() => void) | null = null

function statedLayout(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const saved = ['offsetHeight', 'clientHeight', 'scrollHeight'].map(
    k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  )
  const define = (key: string, get: (el: HTMLElement) => number): void => {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement): number {
        return get(this)
      },
    })
  }
  define('offsetHeight', el =>
    isViewport(el) ? VIEWPORT_H : el.hasAttribute('data-index') ? ROW_H : 0,
  )
  define('clientHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  define('scrollHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  restoreLayout = () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d)
      else delete proto[k]
    }
  }
}

/** The fixture's patients inspection with the resolved covariate facts. */
const patientsInspection: FileInspection = {
  kind: 'patients',
  source_name: 'patients.csv',
  columns: {
    resolved: {},
    unresolved: [],
    covariate_columns: [
      { name: 'age', is_numeric: true },
      { name: 'sex', is_numeric: false },
      { name: 'stage', is_numeric: true },
    ],
  },
  problems: [],
  summary: { rows: 18, draw_days: [0], markers: [] },
}

/** A fully-populated sticky config (every field distinct from the default). */
const stickyConfig: TxrAppConfig = {
  config: {
    endpoint: 'os',
    decision_day: 56,
    look_ahead_day: 365,
    covariates: true,
    at_a_time: 4,
    cpus: 2,
    save_models: true,
  },
}

/** The synthetic catalogue (INV-6: made-up method ids, small counts). */
function catalogue(): MethodSummary[] {
  return [
    {
      id: 'direct-on',
      year: 2021,
      language: 'R',
      group: 'response-probability',
      group_label: 'Response probability',
      title: 'Direct on-treatment response rule',
      summary: 'A direct on-treatment response rule from the fixture paper.',
      paper_title: 'The fixture response paper',
      journal: 'Example Journal',
      runnable: true,
      spec_status: 'final',
      disease: { scope: 'any-solid-tumour', groups: [] },
      treatment: { classes: ['chemotherapy'], confidence: 'stated' },
      container: true,
      covariates: 'optional',
      embeds_training_data: false,
      frozen_model: false,
      marker_groups_required: [],
      markers: { count: 1, kind: 'any' },
      min_draws: 1,
      needs_baseline: false,
      needs_detection_call: false,
      paper_doi: '10.0000/example',
      performance: { c_index_median: 0.64, n_datasets: 2, n_units: 3 },
      tasks: ['pfs'],
      timing: { base_seconds_per_fold: 120, benchmarked_units: 3, quality: 'measured' },
      uses_history: 'landmark',
    },
    {
      id: 'dynforest',
      year: 2022,
      language: 'R',
      group: 'dynamic-risk',
      group_label: 'Dynamic risk',
      title: 'Dynamic random forest',
      summary: 'A dynamic random forest fixture method.',
      journal: 'Example Journal',
      runnable: true,
      spec_status: 'final',
      disease: { scope: 'any-solid-tumour', groups: [] },
      treatment: { classes: ['chemotherapy'], confidence: 'stated' },
      container: true,
      covariates: 'optional',
      embeds_training_data: false,
      frozen_model: false,
      marker_groups_required: [],
      markers: { count: 1, kind: 'any' },
      min_draws: 3,
      needs_baseline: false,
      needs_detection_call: false,
      paper_doi: '10.0000/example',
      tasks: ['pfs'],
      timing: { base_seconds_per_fold: 300, benchmarked_units: 3, quality: 'measured' },
      uses_history: 'full',
    },
    {
      id: 'ki67-two-week-four-group',
      year: 2017,
      language: 'R',
      group: 'response-call',
      group_label: 'Response call',
      title: 'Two-week Ki-67 four-group rule',
      summary: 'A rule that groups patients by the Ki-67 change after two weeks.',
      journal: 'Example Journal',
      runnable: true,
      spec_status: 'final',
      disease: { scope: 'any-solid-tumour', groups: [] },
      treatment: { classes: ['chemotherapy'], confidence: 'stated' },
      container: true,
      covariates: 'none',
      embeds_training_data: false,
      frozen_model: false,
      marker_groups_required: [],
      markers: { count: 1, kind: 'any' },
      min_draws: 1,
      needs_baseline: false,
      needs_detection_call: false,
      paper_doi: '10.0000/example',
      tasks: ['response'],
      timing: { base_seconds_per_fold: 12, benchmarked_units: 3, quality: 'measured' },
      uses_history: 'landmark',
    },
  ]
}

/** The verdicts over the catalogue (two runnable, one not — INV-6 counts). */
function eligibility(): EligibilityResponse {
  return {
    methods: [
      {
        id: 'direct-on',
        status: 'can_run',
        estimated_seconds: 120,
        estimate_quality: 'measured',
        coverage: { eligible: 18, total: 18, fraction: 1 },
        min_draws: { required: 2, met: 18, unmet_patients: 0 },
        missing_markers: [],
        missing_groups: [],
        reasons: [],
      },
      {
        id: 'dynforest',
        status: 'can_run_some',
        estimated_seconds: 300,
        estimate_quality: 'measured',
        coverage: { eligible: 12, total: 18, fraction: 12 / 18 },
        min_draws: { required: 3, met: 12, unmet_patients: 6 },
        missing_markers: [],
        missing_groups: [],
        reasons: [{ code: 'MIN_DRAWS_UNMET' }],
      },
      {
        id: 'ki67-two-week-four-group',
        status: 'cannot_run',
        estimated_seconds: 12,
        estimate_quality: 'measured',
        coverage: { eligible: 0, total: 18, fraction: 0 },
        min_draws: { required: 1, met: 0, unmet_patients: 18 },
        missing_markers: [{ id: 'ki-67', id_system: 'loinc', display_name: 'Ki-67' }],
        missing_groups: [],
        reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
      },
    ],
    total_fit: 1,
    total_some: 1,
    total_cannot: 1,
    total_no_env: 0,
  }
}

function loaded(name: string) {
  const format = 'csv' as const
  return {
    source: { name, format },
    table: {
      source: { name, format },
      header_row: 1,
      columns: ['patient_id', 'age'],
      rows: [['P0001', '64']] as (string | null)[][],
    },
    inspection: name === 'patients.csv' ? patientsInspection : null,
    problems: [] as never[],
    prepared: true,
    joinOffers: [] as never[],
    vocabOffers: [] as never[],

    columnOffers: [],
  }
}

/** The fixture's one validation (small synthetic counts — INV-6). */
function validation(): ValidationResponse {
  return {
    patients: { rows: 18, with_primary_outcome: 7,
    primary_outcome_events: 7, median_followup_days: 84 },
    measurements: { rows: 36, patients: 4, distinct_draw_days: [0, 14, 28] },
    markers: [
      {
        key: 'ldh',
        spellings: ['ldh'],
        n_rows: 20,
        unit_status: 'matches',
        coverage: {
          patients_with_value: 4,
          patients_with_baseline: 4,
          patients_with_ontreatment: 4,
        },
        vocabulary: [],
      },
    ],
    problems: [],
    inventory: {
      baseline_max_day: 0,
      decision_day: 84,
      patients: 18,
      covariates: [{ key: 'age', display_name: 'age', standard_ids: [], unit_family: 'none' }],
      markers: [],
    },
  }
}

function seedStore(overrides: Partial<TxrIntakeState> = {}) {
  useTxrIntakeStore.setState({
    mode: 'study',
    patients: loaded('patients.csv'),
    measurements: loaded('measurements.csv'),
    predictMeasurements: null,
    validation: validation(),
    parameters: { decision_day: 84, baseline_max_day: 0 },
    ...overrides,
  })
}

/** The filter-options vocabulary the page's study answers are valid
 *  against (step2-filters / 5a3): the catalogue's ids. */
const FILTER_OPTIONS = {
  disease_categories: [
    {
      id: 'Solid tumours',
      diseases: [
        { id: 'colorectal cancer', children: [] },
        { id: 'breast cancer', children: [] },
      ],
    },
  ],
  treatment_classes: [
    { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
    { id: 'chemotherapy', label: 'Chemotherapy' },
  ],
}

const store = () => useTxrIntakeStore.getState()

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/choose-methods']}>
      <ChooseMethodsPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** Flush the pending microtasks + timers (the mount GET and the debounce). */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Open a day field's number box first — study-step-ui-tweaks: with
 *  suggestions the box is view state and shows only while the "Other
 *  values" chip is pressed. A field without suggestions (or locked) shows
 *  its box directly and has no chip. */
function openDayField(testId: string): void {
  const other = screen.queryByTestId(`${testId}-other`)
  if (other !== null) fireEvent.click(other)
}

/** The value in a day field's number box. */
function dayValue(testId: string): string {
  openDayField(testId)
  return (screen.getByTestId(`${testId}-input`) as HTMLInputElement).value
}

/** Type a day into a day field's box and press Enter (inside an act). */
function typeDayNow(testId: string, day: number): void {
  openDayField(testId)
  const input = screen.getByTestId(`${testId}-input`)
  fireEvent.change(input, { target: { value: String(day) } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

/** Type a day into a day field and let the action and the page settle. */
async function typeDay(testId: string, day: number): Promise<void> {
  // Open the box in its own act, so it is rendered before typing.
  act(() => {
    openDayField(testId)
  })
  await act(async () => {
    typeDayNow(testId, day)
    await Promise.resolve()
  })
  await settle()
}

/** Select the method by its card checkbox (the picker's own toggle). */
async function selectRow(key: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`txr-method-checkbox-${key}`))
    await Promise.resolve()
  })
  await settle(0)
}

/** The page arrives with the recommended set ticked; a per-row test first
 *  clears it, then ticks the row it means (a click on an already-ticked
 *  row would unselect — the toggle is a toggle). */
async function chooseOnly(key: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('txr-method-clear-selection'))
    await Promise.resolve()
  })
  await settle(0)
  await selectRow(key)
}

beforeEach(() => {
  vi.useFakeTimers()
  api.getConfig.mockReset()
  api.putConfig.mockReset()
  api.listMethods.mockReset()
  api.eligibility.mockReset()
  api.estimate.mockReset()
  api.createRun.mockReset()
  api.listRuns.mockReset()
  api.getPrefs.mockReset()
  api.markerRanking.mockReset()
  api.markerRanking.mockRejectedValue(new Error('not ranked in this suite'))
  api.getConfig.mockResolvedValue({ config: null })
  api.putConfig.mockResolvedValue(undefined)
  api.listMethods.mockResolvedValue({ methods: catalogue(), total: 3 })
  api.eligibility.mockResolvedValue(eligibility())
  api.estimate.mockResolvedValue({ total_seconds: 50, schedule_seconds: 50 })
  api.detail.mockReset()
  api.detail.mockResolvedValue({
    id: 'direct-on',
    description: 'A long fixture description of the direct on-treatment rule.',
    journal: 'Example Journal',
    year: 2021,
    paper_doi: '10.0000/example',
  })
  api.createRun.mockResolvedValue({ id: 'run-1' } as unknown as TxrRunSummary)
  api.listRuns.mockResolvedValue({
    runs: [],
    total: 0,
    limit: 50,
    offset: 0,
  } as TxrRunListResponse)
  api.getPrefs.mockResolvedValue({ keep_file_copies: true })
  api.listUpdates.mockReset()
  api.listUpdates.mockRejectedValue(new Error('no status in this suite'))
  api.filterOptions.mockReset()
  api.filterOptions.mockResolvedValue(FILTER_OPTIONS)
  actionMock.rejectSetDay = false
  __resetMethodListRevisionForTests()
  __resetFetchCacheForTests()
  window.localStorage.clear()
  store().reset()
  statedLayout()
})

afterEach(() => {
  cleanup()
  restoreLayout?.()
  restoreLayout = null
  vi.useRealTimers()
  resetDemoMode()
  vi.restoreAllMocks()
})

describe('ChooseMethodsPage settings wiring (ITEM-7)', () => {
  it('mounts with the DEC-6 merge: the fresh intake decision day wins, the sticky config carries the rest — and never PUTs on mount', async () => {
    api.getConfig.mockResolvedValue(stickyConfig)
    seedStore()
    renderPage()
    // The first load is in flight: the card is the skin, not a defaults
    // flash (the sticky values arrive next).
    expect(screen.getByTestId('txr-run-settings-loading')).toBeTruthy()
    await settle()

    // The intake's decision day (84) beats the sticky 56; the sticky's
    // other fields carry (endpoint os, at-a-time 4...). The look-ahead is this
    // analysis' own: decision day + 182 (the sticky 365 belongs to a past one).
    expect(dayValue('txr-run-settings-decision-day')).toBe('84')
    expect(dayValue('txr-run-settings-look-ahead')).toBe('266')
    expect(
      screen.getByTestId('txr-run-settings-endpoint-opt-os').getAttribute('data-state'),
    ).toBe('on')
    expect(screen.queryByTestId('txr-run-settings-loading')).toBeNull()
    // Exactly ONE request on mount — the GET, never a PUT.
    expect(api.getConfig).toHaveBeenCalledTimes(1)
    expect(api.putConfig).not.toHaveBeenCalled()
  })

  it('writes a row change through as ONE debounced settings-only PUT', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-endpoint-opt-os'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-endpoint-opt-os'))
      await Promise.resolve()
    })
    // The change renders immediately (the optimistic screen value), and
    // the write is still pending inside the debounce.
    expect(
      screen.getByTestId('txr-run-settings-endpoint-opt-os').getAttribute('data-state'),
    ).toBe('on')
    expect(api.putConfig).not.toHaveBeenCalled()

    await settle(RUN_CONFIG_DEBOUNCE_MS)
    await settle()
    expect(api.putConfig).toHaveBeenCalledTimes(1)
    // The settings-only write: the config the screen shows (intake day 84
    // + the defaults for the untouched fields, the engine-true null cpus
    // and the derive label_day), the carried-through engine fields (none
    // here — the never-configured store) preserved.
    expect(api.putConfig).toHaveBeenCalledWith({
      config: {
        endpoint: 'os',
        decision_day: 84,
        look_ahead_day: 266,
        covariates: false,
        at_a_time: 3,
        cpus: null,
        save_models: false,
        label_day: null,
      },
    })

    // The save is the last write: the hook's own PUT never triggers another
    // one (the step-4 fix: an `engine`-keyed effect re-wrote after every
    // save, one PUT per debounce window for as long as the page was open).
    for (let window = 0; window < 5; window += 1) {
      await settle(RUN_CONFIG_DEBOUNCE_MS)
      await settle()
    }
    expect(api.putConfig).toHaveBeenCalledTimes(1)
  })

  it('fills the Extra-inputs names line from the patients inspection covariate_columns', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-run-settings-covariate-names').textContent).toBe(
      'age, sex, stage',
    )
  })

  it('renders the skeleton while the first load is in flight (no defaults flash)', async () => {
    let resolveGet!: (value: TxrAppConfig) => void
    api.getConfig.mockImplementation(
      () =>
        new Promise<TxrAppConfig>(resolve => {
          resolveGet = resolve
        }),
    )
    seedStore()
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-run-settings-loading')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-settings')).toBeNull()

    await act(async () => {
      // The honest never-configured wire answer (`config: null`); the
      // generated type only knows the optimistic `RunConfig | undefined`.
      resolveGet({ config: null } as unknown as TxrAppConfig)
      await Promise.resolve()
    })
    expect(screen.queryByTestId('txr-run-settings-loading')).toBeNull()
    expect(screen.getByTestId('txr-run-settings')).toBeTruthy()
  })

  it('a failed load keeps the four rows usable: error + retry, re-load restores the sticky', async () => {
    api.getConfig.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(stickyConfig)
    seedStore()
    renderPage()
    await settle()

    // The sticky store is behind the screen: the defaults are usable, the
    // error line names the failure, the retry re-loads.
    expect(screen.getByTestId('txr-run-settings-error')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings')).toBeTruthy()
    expect(dayValue('txr-run-settings-look-ahead')).toBe('266')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-settings-retry'))
      await Promise.resolve()
    })
    await settle()
    await settle()
    expect(screen.queryByTestId('txr-run-settings-error')).toBeNull()
    expect(dayValue('txr-run-settings-look-ahead')).toBe('266')
  })

  it('an edit made against the not-yet-loaded defaults is never reverted by the retry load', async () => {
    api.getConfig.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(stickyConfig)
    seedStore()
    renderPage()
    await settle()

    // The user changes the endpoint while the store is unreachable.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-endpoint-opt-os'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-endpoint-opt-os'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-settings-retry'))
      await Promise.resolve()
    })
    await settle()

    // The user's choice survives; the retry-loaded sticky fields carry
    // for the untouched rows, the look-ahead stays this analysis' own, and the write-through body
    // never falls back to defaults for fields the user did not touch.
    expect(
      screen.getByTestId('txr-run-settings-endpoint-opt-os').getAttribute('data-state'),
    ).toBe('on')
    expect(dayValue('txr-run-settings-look-ahead')).toBe('266')
    await settle(RUN_CONFIG_DEBOUNCE_MS)
    await settle()
    expect(api.putConfig).toHaveBeenCalledTimes(1)
    expect(api.putConfig).toHaveBeenCalledWith({
      config: {
        endpoint: 'os',
        decision_day: 84,
        look_ahead_day: 266,
        covariates: true,
        at_a_time: 3,
        cpus: 2,
        save_models: true,
        label_day: null,
      },
    })
  })
})

describe('ChooseMethodsPage method picker + create path (qa-fixes3 ITEM-1 / TEST-RUN-17)', () => {
  it('hosts the picker fed by the inventory hooks: ready-to-run default, nothing red, the estimate bar', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    expect(screen.getByTestId('txr-method-picker')).toBeTruthy()
    expect(screen.getByTestId('txr-run-bar')).toBeTruthy()
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')

    // The board lead paragraph is data-filled from the inventory (INV-6:
    // the fixture's own 18, never the board's 151).
    expect(screen.getByTestId('txr-run-intro').textContent).toContain('your 18 patients')

    // The default view: ready-to-run sections only; the cannot card lives in
    // the collapsed can\'t-run section — "Cannot run" is never printed.
    expect(screen.getByTestId('txr-method-ready-heading').textContent).toBe('Ready to run (2)')
    const probability = screen.getByTestId('txr-method-section-response-probability')
    expect(probability).toBeTruthy()
    expect(probability.textContent).toContain('Direct on-treatment response rule')
    expect(document.body.textContent).not.toContain('Cannot run')
    expect(screen.getByTestId('txr-method-cannot-heading').textContent).toBe(
      "1 method can't run on this data",
    )

    // The research notice is the module's ONE constant, on the bar.
    expect(screen.getByText(RESEARCH_NOTICE)).toBeTruthy()
  })

  it('on arrival the deterministic recommended set is ticked; the bar total is the estimate response (INV-4)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    // The auto-seed fired BEFORE any user interaction: the recommendation
    // (both runnable methods — the fixture has two, one per family) is
    // ticked and the one debounced estimate call carries them.
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')
    await settle(250)
    expect(api.estimate).toHaveBeenCalledWith({
      method_ids: ['direct-on', 'dynforest'],
      patients: 18,
      cpus: undefined,
      at_a_time: 3,
    })
    expect(screen.getByTestId('txr-run-bar-time').textContent).toContain(
      'under 1 min (3 at a time)',
    )
  })

  it('the preset control changes the selection and the count; a manual tick is Custom', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    expect(screen.getByTestId('txr-method-preset-recommended').getAttribute('aria-pressed')).toBe(
      'true',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-clear-selection'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('0 methods selected')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-preset-all'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')

    // The auto-recommendation is OFF once the user has touched the selection:
    // a settings change (an eligibility refetch) never re-treads the user's
    // own choice — the All preset stays the active segment.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-clear-selection'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-endpoint-opt-os'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-endpoint-opt-os'))
      await Promise.resolve()
    })
    await settle(RUN_CONFIG_DEBOUNCE_MS + 50)
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('0 methods selected')
  })

  it('the clicked preset stays pressed when two presets give the same set (Recommended = All here); clearing lights no preset, never Fast', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    // The fixture's two runnable methods are one per family, so the
    // recommendation takes both: Recommended = All; neither is under a
    // minute, so Fast is empty.
    const pressed = (value: string): string | null =>
      screen.getByTestId(`txr-method-preset-${value}`).getAttribute('aria-pressed')
    expect(pressed('recommended')).toBe('true')
    expect(pressed('all')).toBe('false')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-preset-all'))
      await Promise.resolve()
    })
    expect(pressed('all')).toBe('true')
    expect(pressed('recommended')).toBe('false')
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-clear-selection'))
      await Promise.resolve()
    })
    expect(pressed('recommended')).toBe('false')
    expect(pressed('all')).toBe('false')
    expect(pressed('fast')).toBe('false')
    expect(screen.getByTestId('txr-method-preset-fast').textContent).toBe(
      'Fast only (estimated under 1 min each) (0)',
    )
  })

  it('search and the family multi-filter restrict the sections and restore', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-method-search'), { target: { value: 'dynamic' } })
      await Promise.resolve()
    })
    expect(screen.queryByTestId('txr-method-section-response-probability')).toBeNull()
    expect(screen.getByTestId('txr-method-section-dynamic-risk')).toBeTruthy()

    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-method-search'), { target: { value: '' } })
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-method-section-dynamic-risk')).toBeTruthy()

    const chip = screen.getByTestId('txr-method-family-dynamic-risk')
    await act(async () => {
      fireEvent.click(chip)
      await Promise.resolve()
    })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('txr-method-section-dynamic-risk')).toBeTruthy()
    expect(screen.queryByTestId('txr-method-section-response-probability')).toBeNull()
    await act(async () => {
      fireEvent.click(chip)
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-method-section-response-probability')).toBeTruthy()
  })

  it('a reason chip expands its can\'t-run list with the one-line fix naming the marker', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-reason-marker'))
      await Promise.resolve()
    })
    const row = screen.getByTestId('txr-method-cannot-row-ki67-two-week-four-group')
    expect(row.textContent).toContain('needs Ki-67, not in your file')
    expect(row.textContent).toContain('Add a column named Ki-67')
  })

  it('the row About disclosure opens in place with the method facts', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-about-toggle-direct-on'))
      await Promise.resolve()
    })
    await settle()
    const about = screen.getByTestId('txr-method-about-direct-on')
    expect(about).toBeTruthy()
    expect(about.textContent).toContain('Example Journal, 2021')
  })


  it('Run posts the frozen request and navigates to the new run runningPath on 202', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    // The create chain is all microtasks (the engine answer + the
    // navigation); the settles drain them under the fake timers.
    await settle(0)
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    const request = api.createRun.mock.calls[0][0]
    expect(request.mode).toBe('train')
    expect(request.method_ids).toEqual(['direct-on'])
    // The exact PROV-EE-2 config bytes: the screen's value (intake day 84 +
    // the defaults), the engine-true nulls (cpus: null, label_day: null) and
    // the step-3 marker choice (single-marker-choice round 2: the default
    // ranked mode is sent explicitly so the run's record names the rule).
    expect(request.config).toEqual({
      endpoint: 'pfs',
      decision_day: 84,
      look_ahead_day: 266,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
      label_day: null,
      single_marker: { mode: 'ranked' },
    })
    // The input is the intake's own builder result, verbatim.
    expect(request.input.patients.source.name).toBe('patients.csv')
    expect(request.input.measurements.source.name).toBe('measurements.csv')
    expect(request.input.joins).toEqual([])
    expect(request.input.mapping).toEqual([])
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('a 404 METHOD_NOT_FOUND drops the named row from the selection with the visible notice', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.createRun.mockRejectedValue({
      status: 404,
      message: 'no method "direct-on" in the shipped catalogue',
    })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')
    await selectRow('dynforest')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-notice')).toBeTruthy()
    expect(screen.getByTestId('txr-run-create-notice').textContent).toBe(
      'direct-on is no longer in the method catalogue — it was removed from the selection.',
    )
    // The named row left the selection; the other stays.
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('1 method selected')
    expect(api.listRuns).not.toHaveBeenCalled()
  })

  it('a 404 that attributes no row surfaces the error line and keeps the selection (never a silent drop)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.createRun.mockRejectedValue({ status: 404, message: 'METHOD_NOT_FOUND' })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')

    // The local catalogue DOES know the row — neither attribution source
    // names a stale method, so the run was not created and the choice is
    // kept for the retry.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-error').textContent).toBe(
      RUN_METHODS_GONE_LINE,
    )
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('1 method selected')
  })

  it('a 409 RUN_ALREADY_ACTIVE resolves through listRuns to the active run runningPath (DEC-18)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.createRun.mockRejectedValue({ status: 409, message: 'a run is already active' })
    api.listRuns.mockResolvedValue({
      runs: [
        { id: 'active-1', status: 'running' },
        { id: 'finished-1', status: 'finished' },
      ] as unknown as TxrRunSummary[],
      total: 2,
      limit: 50,
      offset: 0,
    } as TxrRunListResponse)
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe(
      '/analysis/active-1/running',
    )
    expect(api.listRuns).toHaveBeenCalledTimes(1)
    expect(api.createRun).toHaveBeenCalledTimes(1)
  })

  it('Run sends the method list the cards came from (PR 5)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({ methods: catalogue(), total: 3, method_list_sequence: 3 })
    api.eligibility.mockResolvedValue({ ...eligibility(), method_list_sequence: 3 })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(api.createRun.mock.calls[0][0].method_list_sequence).toBe(3)
  })

  it('Run names the list of the cards on screen, not a newer status read (PR 5)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({ methods: catalogue(), total: 3, method_list_sequence: 3 })
    api.eligibility.mockResolvedValue({ ...eligibility(), method_list_sequence: 3 })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')
    // The app moved to list #4: a status read (window focus) says so, and the cards'
    // reload has not landed yet.
    api.listUpdates.mockReset()
    api.listUpdates.mockResolvedValue({
      sequence: 4,
      origin: 'live',
      assembled_at: '2026-11-20T10:00:00Z',
      updates_enabled: true,
      last_check: 'updated',
    })
    api.listMethods.mockReturnValue(new Promise(() => {}))
    api.eligibility.mockReturnValue(new Promise(() => {}))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.listUpdates).toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    // The selection was made on #3: the request says #3, so the server refuses it.
    expect(api.createRun.mock.calls[0][0].method_list_sequence).toBe(3)
  })

  it('a 409 METHOD_LIST_CHANGED reloads the methods with the notice and starts nothing (PR 5)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({ methods: catalogue(), total: 3, method_list_sequence: 3 })
    api.eligibility.mockResolvedValue({ ...eligibility(), method_list_sequence: 3 })
    api.createRun.mockRejectedValue({
      status: 409,
      error_code: 'METHOD_LIST_CHANGED',
      message: 'The method list was updated (#3 to #4); check your selection',
    })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')
    const before = api.eligibility.mock.calls.length
    // The app moved to list #4 meanwhile: the status read after the 409 says so.
    api.listUpdates.mockReset()
    api.listUpdates.mockResolvedValue({
      sequence: 4,
      origin: 'live',
      assembled_at: '2026-11-20T10:00:00Z',
      updates_enabled: true,
      last_check: 'updated',
    })
    api.listMethods.mockResolvedValue({ methods: catalogue(), total: 3, method_list_sequence: 4 })
    api.eligibility.mockResolvedValue({ ...eligibility(), method_list_sequence: 4 })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-notice').textContent).toBe(
      METHOD_LIST_CHANGED_NOTICE,
    )
    expect(api.listRuns).not.toHaveBeenCalled()
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-methods')
    // The cards and verdicts were fetched again for the new list.
    expect(api.eligibility.mock.calls.length).toBeGreaterThan(before)
    // The reload keeps the user's choice (the store-backed ticks): the selection is not
    // re-seeded, it is still the one method the user chose.
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('1 method selected')
  })

  it('a 409 with no active run answer surfaces the error line (the racy state is never hidden)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.createRun.mockRejectedValue({ status: 409, message: 'a run is already active' })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-error')).toBeTruthy()
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-methods')
  })

  it('a 400 surfaces the engine message and the settings keep their values', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.createRun.mockRejectedValue({
      status: 400,
      message: 'EMPTY_METHODS: choose at least one method',
    })
    seedStore()
    renderPage()
    await settle()
    // The ITEM-2 bar disables Run when nothing is selected (that state is
    // its own pin); the engine-400 surface is reached through a selection
    // the engine then rejects — a stale selection between render and click.
    await chooseOnly('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-error').textContent).toBe(
      'EMPTY_METHODS: choose at least one method',
    )
    // The rejected run never navigates; the rows keep their values.
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-methods')
    expect(screen.getByTestId('txr-method-card-direct-on')).toBeTruthy()
  })

  it('the transient null-validation state renders the pending line, never a fabricated inventory', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ validation: null })
    renderPage()
    await settle()

    expect(screen.getByTestId('txr-run-list-pending')).toBeTruthy()
    expect(screen.queryByTestId('txr-list')).toBeNull()
    // The page is NOT flipped to the empty state (the inputs are there).
    expect(screen.queryByTestId('txr-run-empty')).toBeNull()
    expect(screen.getByTestId('txr-run-summary')).toBeTruthy()
  })
})

describe('ChooseMethodsPage keep-copies (TEST-RUN-36)', () => {
  it('reads the preference once at mount and it wins over the builder default', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.getPrefs.mockResolvedValue({ keep_file_copies: false })
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(api.getPrefs).toHaveBeenCalledTimes(1)
    expect(api.createRun.mock.calls[0][0].input.keep_copies).toBe(false)
  })

  it('a failed read falls back to the builder default true', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.getPrefs.mockRejectedValue(new Error('down'))
    seedStore()
    renderPage()
    await settle()
    await chooseOnly('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(api.createRun.mock.calls[0][0].input.keep_copies).toBe(true)
  })
})

describe('ChooseMethodsPage ITEM-2 — the summary line, the settings sentence and the eligibility recompute', () => {
  it('renders the compact files summary with the marker names and the Details full list', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    // The plan's one line over the fixture's own facts (18 patients · 7
    // events · 1 marker — the fixture ldh column — draws 0..28).
    expect(screen.getByTestId('txr-run-summary-line').textContent).toBe(
      '18 patients · 7 events · 1 marker · draws from day 0 to 28 (3 different days)',
    )
    expect(screen.getByTestId('txr-run-summary-markers').textContent).toBe('Markers: ldh')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-summary-details'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-summary-details-measurements').textContent).toContain(
      'draws at day 0, 14, 28',
    )
    expect(screen.getByTestId('txr-run-summary-details-patients').textContent).toContain(
      '18 patients · 7 events',
    )
  })

  it('the settings card title and the live sentence match the selected values', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    expect(screen.getByTestId('txr-run-settings-title').textContent).toBe(
      'What do you want to predict?',
    )
    expect(screen.getByTestId('txr-run-settings-sentence').textContent).toBe(
      'Progression or death by day 266 of treatment, from the blood draws up to day 84.',
    )

    // Change the outcome and the horizon: the sentence is the selection's.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-endpoint-opt-os'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-endpoint-opt-os'))
      await Promise.resolve()
    })
    await act(async () => {
      typeDayNow('txr-run-settings-look-ahead', 365)
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-settings-sentence').textContent).toBe(
      'Death by day 365 of treatment, from the blood draws up to day 84.',
    )
  })

  it('the eligibility request carries the settings (decision day + the file\'s extra-input columns with the switch off, because the file has them), and a change refetches', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    // The screen's inventory: the validation facts with the settings'
    // decision day (84 — the intake's fresh answer). The EXTRA-INPUT COLUMN
    // NAMES ride even with the switch off (AOC part 2, the file has them —
    // availability `present`): a required method is tickable, and the
    // switch then only decides whether the run uses them.
    expect(
      screen
        .getByTestId('txr-run-settings-covariates')
        .getAttribute('data-state') ??
        screen.getByTestId('txr-run-settings-covariates').getAttribute('aria-checked'),
    ).not.toBe('true')
    const firstCall = api.eligibility.mock.calls[0][0]
    expect(firstCall.inventory.decision_day).toBe(84)
    expect(firstCall.inventory.covariates).toEqual([
      { key: 'age', display_name: 'age', standard_ids: [], unit_family: 'none' },
    ])

    // A decision-day change recomputes: the inventory key changed, so the
    // adapter refetches and the re-check line is visible while in flight.
    let resolveSecond!: (value: unknown) => void
    api.eligibility.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveSecond = resolve
        }),
    )
    await act(async () => {
      typeDayNow('txr-run-settings-decision-day', 28)
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-method-refreshing')).toBeTruthy()
    await act(async () => {
      resolveSecond(eligibility())
      await Promise.resolve()
    })
    await settle()
    expect(screen.queryByTestId('txr-method-refreshing')).toBeNull()
    const lastCall = api.eligibility.mock.calls[api.eligibility.mock.calls.length - 1][0]
    expect(lastCall.inventory.decision_day).toBe(28)
    expect(lastCall.inventory.covariates.length).toBe(1)
  })

  it('a persisted unknown disease is never sent on E — the filters block is sanitized by the vocabulary (5a3)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({
      study: {
        ...useTxrIntakeStore.getState().study,
        disease: 'dead-cancer',
        treatments: ['chemotherapy', 'obsolete-drug'],
        outcome: 'progression-by-day',
      },
    })
    renderPage()
    await settle()
    // The vocabulary lands after the mount's first inventory answer: the
    // eligibility is re-issued with the sanitized filters block.
    for (let i = 0; i < 20 && api.eligibility.mock.calls.length < 2; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
    }
    expect(api.eligibility.mock.calls.length).toBeGreaterThanOrEqual(2)
    const lastCall = api.eligibility.mock.calls[api.eligibility.mock.calls.length - 1][0]
    // The stale disease is never sent; the known treatment class rides, the
    // unknown one is dropped; the outcome is independent of the vocabulary.
    expect(lastCall.inventory.filters).toEqual({
      treatment_classes: ['chemotherapy'],
      method_group: 'static-risk',
    })
    // The reconcile reaches the store too: the unknown disease is cleared
    // once the vocabulary is known.
    expect(store().study.disease).toBeNull()
    expect(store().study.treatments).toEqual(['chemotherapy'])
    expect(store().study.outcome).toBe('progression-by-day')
  })

  it('a re-check that changes nothing still answers: "Checked again: the same 2 methods can run." (step-4 fix)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-method-recheck-result').textContent).toBe('')

    await act(async () => {
      typeDayNow('txr-run-settings-decision-day', 28)
      await Promise.resolve()
    })
    await settle()
    // The eligibility answer is the same verdicts: the list looks the same,
    // and the status line says so.
    expect(api.eligibility.mock.calls.length).toBeGreaterThanOrEqual(2)
    const status = screen.getByTestId('txr-method-recheck-result')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe('Checked again: the same 2 methods can run.')
  })

  it('the Extra-inputs help line says how many of the methods that can run use them (AOC part 2: when the file has the columns, the switch no longer changes the request)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()
    // The request carried the file's extra-input columns from the start
    // (whatever the switch said), and both runnable fixture methods take
    // extra inputs (optional).
    expect(api.eligibility.mock.calls[0][0].inventory.covariates.length).toBe(1)
    expect(screen.getByTestId('txr-run-settings-covariates-help').textContent).toBe(
      'Used by 2 of the 2 methods that can run.',
    )

    // Turning the switch on changes NOTHING in the request when the file has
    // the columns (availability `present`): the switch only decides whether
    // the run uses them, so no verdict changes, no refetch and no re-check
    // line. (With an UNKNOWN inspection the switch does still change the
    // request — that case has its own test.)
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-covariates'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-covariates'))
      await Promise.resolve()
    })
    await settle()
    expect(api.eligibility.mock.calls.length).toBe(1)
    expect(screen.getByTestId('txr-run-settings-covariates-help').textContent).toBe(
      'Used by 2 of the 2 methods that can run.',
    )
    expect(screen.getByTestId('txr-method-recheck-result').textContent).toBe('')
  })

  it('a method that stops being eligible is unticked with the toast; the still-eligible stay', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    // The recommendation ticks both runnable methods; the SECOND answer (a
    // decision-day change) marks direct-on as cannot-run — the eligibility
    // churn the plan's untick message names.
    api.eligibility
      .mockResolvedValueOnce(eligibility())
      .mockResolvedValueOnce({
        ...eligibility(),
        methods: eligibility().methods.map(method =>
          method.id === 'direct-on'
            ? { ...method, status: 'cannot_run', coverage: { eligible: 0, total: 18, fraction: 0 }, reasons: [{ code: 'DECISION_DAY_UNMET' }] }
            : method,
        ),
      })
    const { Toaster } = await import('@txresbench/kit')
    seedStore()
    render(
      <MemoryRouter initialEntries={['/choose-methods']}>
        <Toaster />
        <ChooseMethodsPage />
        <LocationProbe />
      </MemoryRouter>,
    )
    await settle()
    await settle(250)
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')

    await act(async () => {
      typeDayNow('txr-run-settings-decision-day', 28)
      await Promise.resolve()
    })
    await settle()
    await settle(250)
    // direct-on left the selection; dynforest stayed.
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('1 method selected')
    expect(screen.getByText('1 method no longer fits these settings')).toBeTruthy()
    // The step-4 status line names the change.
    expect(screen.getByTestId('txr-method-recheck-result').textContent).toBe(
      'Checked again: 1 method can run (was 2).',
    )
  })

  it('the run bar is disabled with the reason when nothing is selected', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-clear-selection'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-bar-run').getAttribute('disabled')).not.toBeNull()
    expect(screen.getByTestId('txr-run-bar-empty-reason').textContent).toBe(
      'Select at least one method',
    )
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('0 methods selected')
  })

  it('More settings opens in place: CPUs, the lanes, the estimate fact and the fixed-seed fact', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-settings-more'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-settings-cpus')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings-at-a-time')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings-estimate-explained').textContent).toContain(
      'scaled to your file',
    )
    expect(screen.getByTestId('txr-run-settings-seed-fact').textContent).toContain('fixed seed')
  })
})

describe('demo mode (ITEM-6) — the recorded methods only, the locked setup, the (demo) run label', () => {
  it('the picker lists only the runnable cards; the settings are locked with the note; Change files is disabled; Run carries (demo)', async () => {
    seedDemoMode('demo')
    seedStore()
    renderPage()
    await settle()

    // The Ki-67 cannot-run card is not in the list, and neither is the
    // cannot-run section nor its toggle (the demo list is the bundle's
    // methods).
    expect(screen.queryByTestId('txr-method-checkbox-ki67-two-week-four-group')).toBeNull()
    expect(screen.queryByTestId('txr-method-cannot')).toBeNull()
    expect(screen.queryByTestId('txr-method-cannot-toggle')).toBeNull()
    expect(screen.getByTestId('txr-method-checkbox-direct-on')).toBeTruthy()
    expect(screen.getByTestId('txr-method-checkbox-dynforest')).toBeTruthy()

    // The settings rows are locked (the recorded setup) + the note; More
    // settings is hidden (no real compute: no CPU / at-a-time controls).
    expect(screen.getByTestId('txr-run-settings-demo-note').textContent).toBe(DEMO_SETTINGS_NOTE)
    const endpointOption = screen.getByTestId('txr-run-settings-endpoint-opt-pfs')
    const disabled =
      endpointOption.getAttribute('aria-disabled') === 'true' ||
      (endpointOption as HTMLButtonElement).disabled === true
    expect(disabled).toBe(true)
    expect(screen.queryByTestId('txr-run-settings-more')).toBeNull()

    // Change files is disabled with the reason (cannot be re-enabled from
    // the UI), and the run button carries the audit's "(demo)" suffix.
    expect((screen.getByTestId('txr-run-change-files') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('txr-run-change-files-reason').textContent).toBe(DEMO_DISABLED_REASON)
    expect(screen.getByTestId('txr-run-bar-run').textContent).toContain('(demo)')
  })
})

describe('step-4 fix: only the step line and the title are fixed; everything else scrolls in the one region', () => {
  /** The page's one region (the ScrollRegion's labelled scroll container). */
  const region = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[role="region"][aria-label="Methods to choose"]')
    if (el === null) throw new Error('no "Methods to choose" region')
    return el
  }

  /** True when `a` comes before `b` in document order. */
  const before = (a: HTMLElement, b: HTMLElement): boolean =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  it('the fixed top holds the step line and the h1 only', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    const tops = document.querySelectorAll<HTMLElement>('.txr-page-frame-top')
    expect(tops.length).toBe(1)
    const chrome = tops[0].firstElementChild as HTMLElement
    const children = Array.from(chrome.children) as HTMLElement[]
    expect(children.length).toBe(2)
    expect(children[0].textContent).toBe('Step 4 of 4')
    expect(children[1].tagName).toBe('H1')
    expect(children[1].textContent).toBe('Choose the methods and settings')
    for (const id of [
      'txr-run-intro',
      'txr-run-summary',
      'txr-run-settings',
      'txr-method-presets',
      'txr-method-toolbar',
    ]) {
      expect(tops[0].querySelector(`[data-testid="${id}"]`), `${id} must not be in the fixed top`).toBeNull()
    }
  })

  it('the intro, summary, settings, presets and toolbar are inside the region, in that order, before the list', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    const scroller = region()
    const ids = [
      'txr-run-intro',
      'txr-run-summary',
      'txr-run-settings',
      'txr-method-presets',
      'txr-method-toolbar',
      'txr-method-sections',
    ]
    const nodes = ids.map(id => screen.getByTestId(id))
    for (const [index, node] of nodes.entries()) {
      expect(scroller.contains(node), `${ids[index]} is inside the region`).toBe(true)
    }
    for (let index = 1; index < nodes.length; index += 1) {
      expect(before(nodes[index - 1], nodes[index]), `${ids[index - 1]} before ${ids[index]}`).toBe(true)
    }
    // The run bar stays in the frame's fixed bottom slot, outside the region.
    const bar = screen.getByTestId('txr-run-bar')
    expect(scroller.contains(bar)).toBe(false)
    expect(bar.closest('.txr-page-frame-bottom')).not.toBeNull()
    // One region: the page has no other scroll container of its own.
    expect(document.querySelectorAll('[role="region"]').length).toBe(1)
  })

  it('the pending (null validation) state has the same structure', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ validation: null })
    renderPage()
    await settle()

    const scroller = region()
    const top = document.querySelector<HTMLElement>('.txr-page-frame-top')!
    expect(top.querySelector('h1')!.textContent).toBe('Choose the methods and settings')
    for (const id of ['txr-run-intro', 'txr-run-summary', 'txr-run-settings', 'txr-run-list-pending']) {
      const node = screen.getByTestId(id)
      expect(scroller.contains(node), `${id} is inside the region`).toBe(true)
      expect(top.contains(node), `${id} is not in the fixed top`).toBe(false)
    }
    expect(
      before(screen.getByTestId('txr-run-settings'), screen.getByTestId('txr-run-list-pending')),
    ).toBe(true)
  })

  it('"Change settings" in the zero state scrolls the region to the settings card', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    // Every verdict cannot-run: the picker's zero state.
    api.eligibility.mockResolvedValue({
      ...eligibility(),
      methods: eligibility().methods.map(method => ({
        ...method,
        status: 'cannot_run',
        coverage: { eligible: 0, total: 18, fraction: 0 },
        reasons: [{ code: 'DECISION_DAY_UNMET' }],
      })),
    })
    const scrollIntoView = vi.fn()
    const proto = Element.prototype as unknown as { scrollIntoView?: unknown }
    const saved = proto.scrollIntoView
    proto.scrollIntoView = scrollIntoView
    try {
      seedStore()
      renderPage()
      await settle()
      expect(screen.getByTestId('txr-method-zero')).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('txr-method-zero-change-settings'))
        await Promise.resolve()
      })
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      const target = scrollIntoView.mock.contexts[0] as HTMLElement
      expect(region().contains(target), 'the scrolled element is inside the region').toBe(true)
      expect(target.contains(screen.getByTestId('txr-run-settings'))).toBe(true)
    } finally {
      proto.scrollIntoView = saved
    }
  })
})

describe('step-4 review fixes: the preset action and the re-check line', () => {
  it('methods.applyPreset is refused while the list is still loading, and the recommended seed still happens', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    let release: (value: unknown) => void = () => {}
    api.eligibility.mockReturnValueOnce(
      new Promise(resolve => {
        release = resolve
      }),
    )
    seedStore()
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-method-loading')).toBeTruthy()
    const live = instancesOfType('txr.method-picker')
    expect(live.length).toBe(1)

    // The usual AI sequence: navigate, views.list, invoke at once.
    let failure: unknown = null
    await act(async () => {
      try {
        await runAction('methods.applyPreset', { view_id: live[0].id, preset: 'all' })
      } catch (err) {
        failure = err
      }
    })
    expect(String(failure)).toContain('UNAVAILABLE: the method list has not loaded yet')

    await act(async () => {
      release(eligibility())
      await Promise.resolve()
    })
    await settle()
    // The arrival seed was not stopped: the recommendation is ticked.
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')
    expect(
      screen.getByTestId('txr-method-preset-recommended').getAttribute('aria-pressed'),
    ).toBe('true')
  })

  /** Pick a Segmented option (the kit commits on pointer down + click). */
  async function pick(testId: string): Promise<void> {
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId(testId), { button: 0, pointerType: 'mouse' })
      fireEvent.click(screen.getByTestId(testId))
      await Promise.resolve()
    })
    await settle()
  }

  it('a failed re-check says so; the previous "Checked again" line never comes back', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()
    await typeDay('txr-run-settings-decision-day', 28)
    const status = () => screen.getByTestId('txr-method-recheck-result').textContent
    expect(status()).toBe('Checked again: the same 2 methods can run.')

    api.eligibility.mockRejectedValueOnce(new Error('eligibility down'))
    const callsBefore = api.eligibility.mock.calls.length
    await typeDay('txr-run-settings-decision-day', 84)
    expect(api.eligibility.mock.calls.length).toBe(callsBefore + 1)
    expect(status()).toBe('Could not check again: eligibility down. The list shows the last answer.')
    // The list is still the last answer's.
    expect(screen.getByTestId('txr-method-card-direct-on')).toBeTruthy()

    // The next re-check that works replaces the failure line.
    await typeDay('txr-run-settings-decision-day', 42)
    expect(status()).toBe('Checked again: the same 2 methods can run.')
  })

  it('while Change files clears the validation, the Extra-inputs help does not count the old files\' methods', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()
    const help = () => screen.getByTestId('txr-run-settings-covariates-help').textContent
    expect(help()).toBe('Used by 2 of the 2 methods that can run.')

    // A file change in the dialog nulls the validation: the list is pending.
    await act(async () => {
      useTxrIntakeStore.setState({ validation: null })
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-list-pending')).toBeTruthy()
    expect(help()).toBe('Other columns of your file the methods may use.')

    // The new files' validation lands: a FIRST answer again (no re-check
    // line), and the help counts the new answer.
    api.eligibility.mockResolvedValueOnce({
      ...eligibility(),
      methods: eligibility().methods.map(method =>
        method.id === 'dynforest' ? { ...method, status: 'cannot_run', reasons: [{ code: 'MIN_DRAWS_UNMET' }] } : method,
      ),
    })
    await act(async () => {
      useTxrIntakeStore.setState({ validation: validation() })
      await Promise.resolve()
    })
    await settle()
    expect(help()).toBe('Used by the one method that can run.')
    expect(screen.getByTestId('txr-method-recheck-result').textContent).toBe('')
  })

  it('in demo mode the picker\'s state token stays put across re-renders (it moves only on a change)', async () => {
    seedDemoMode('demo')
    seedStore()
    const view = renderPage()
    await settle()
    await settle(250)
    const live = instancesOfType('txr.method-picker')
    expect(live.length).toBe(1)
    const token = async (): Promise<unknown> =>
      ((await runAction('view.describe', { view_id: live[0].id })) as Record<string, unknown>)
        ._state_token
    const before = await token()

    // Re-render the page with nothing changed.
    for (let i = 0; i < 3; i += 1) {
      view.rerender(
        <MemoryRouter initialEntries={['/choose-methods']}>
          <ChooseMethodsPage />
          <LocationProbe />
        </MemoryRouter>,
      )
      await settle()
    }
    expect(await token()).toBe(before)

    // A real change still moves it.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-clear-selection'))
      await Promise.resolve()
    })
    expect(await token()).not.toBe(before)
  })

  it('no "Checked again" line on arrival when the sticky settings land after the first answer', async () => {
    let releaseConfig: (value: unknown) => void = () => {}
    api.getConfig.mockReturnValueOnce(
      new Promise(resolve => {
        releaseConfig = resolve
      }),
    )
    seedStore()
    renderPage()
    await settle()
    // The first answer is for the defaults (the sticky GET is in flight).
    expect(api.eligibility.mock.calls.length).toBe(1)
    expect(screen.getByTestId('txr-method-recheck-result').textContent).toBe('')

    // The sticky config lands (endpoint os, covariates on): none of the
    // fields the ELIGIBILITY REQUEST reads changed — the intake's decision
    // day (84) wins over the sticky 56, and the extra-inputs switch is not
    // part of the request any more (the columns ride either way, AOC part
    // 2). No second request nobody asked for, still no re-check line.
    await act(async () => {
      releaseConfig(stickyConfig)
      await Promise.resolve()
    })
    await settle()
    await settle()
    expect(api.eligibility.mock.calls.length).toBe(1)
    expect(api.eligibility.mock.calls[0][0].inventory.covariates.length).toBe(1)
    expect(screen.getByTestId('txr-method-recheck-result').textContent).toBe('')

    // A change the user makes still gets its line.
    await typeDay('txr-run-settings-decision-day', 28)
    expect(screen.getByTestId('txr-method-recheck-result').textContent).toBe(
      'Checked again: the same 2 methods can run.',
    )
  })
})

describe('the step Back on Choose methods (E)', () => {
  /** C in the flow: records its step, and its Continue lands on E again. */
  function FilesStandIn() {
    useStepBack({ step: 'files', fallback: '/' })
    const navigate = useNavigate()
    return (
      <Button data-testid="stand-in-continue" onClick={() => navigate('/study')}>
        Continue
      </Button>
    )
  }

  /** The study step (B) stand-in: the step before the methods on the learn path. */
  function StudyStandIn() {
    useStepBack({ step: 'study', fallback: '/files' })
    const navigate = useNavigate()
    return (
      <Button data-testid="stand-in-continue" onClick={() => navigate('/choose-methods')}>
        Continue
      </Button>
    )
  }

  function renderFlow() {
    return render(
      <MemoryRouter initialEntries={['/choose-methods']}>
        <RouterBridge />
        <Routes>
          <Route path="/choose-methods" element={<ChooseMethodsPage />} />
          <Route path="/files" element={<FilesStandIn />} />
          <Route path="/study" element={<StudyStandIn />} />
          <Route path="/predict-files" element={<div data-testid="stand-in-predict" />} />
          <Route path="/history" element={<div data-testid="stand-in-history" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    )
  }

  const routeAt = () => screen.getByTestId('route-location').textContent

  async function click(testId: string): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId(testId))
      await Promise.resolve()
    })
    await settle()
  }

  function expectBackBeforeRun(): void {
    const back = screen.getByTestId('txr-step-back')
    expect(back.nextElementSibling).toBe(screen.getByTestId('txr-run-bar-run'))
  }

  function expectBackLastInBar(): void {
    const bar = screen.getByTestId('txr-step-back-bar')
    expect(bar.lastElementChild).toBe(screen.getByTestId('txr-step-back'))
  }

  beforeEach(() => {
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  })

  it('sits directly left of Run in the run bar once the list is there', async () => {
    seedStore()
    renderPage()
    await settle()
    expectBackBeforeRun()
  })

  it('stays left of Run while the methods load, after the list fails, and while the settings load', async () => {
    api.listMethods.mockReturnValue(new Promise(() => undefined))
    seedStore()
    renderPage()
    await settle()
    expectBackBeforeRun()
    cleanup()

    api.listMethods.mockRejectedValue(new Error('catalogue down'))
    renderPage()
    await settle()
    expectBackBeforeRun()
    cleanup()

    api.listMethods.mockResolvedValue({ methods: catalogue(), total: 3 })
    api.getConfig.mockReturnValue(new Promise(() => undefined))
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-run-settings-loading')).toBeTruthy()
    expectBackBeforeRun()
  })

  it('stays left of Run after a run error', async () => {
    api.createRun.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }))
    seedStore()
    renderPage()
    await settle()
    await click('txr-run-bar-run')
    expect(screen.getByTestId('txr-run-create-error')).toBeTruthy()
    expectBackBeforeRun()
  })

  it('with no files: a bottom bar with Back at its right end', async () => {
    seedStore({ patients: null, measurements: null, validation: null })
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-run-empty')).toBeTruthy()
    expectBackLastInBar()
  })

  it('while the files are re-checked (no run bar): a bottom bar with Back at its right end', async () => {
    seedStore({ validation: null })
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-run-list-pending')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-bar')).toBeNull()
    expectBackLastInBar()
  })

  it('with no trail goes to the step before: the study step on the learn path, N on a predict path', async () => {
    seedStore()
    renderFlow()
    await settle()
    await click('txr-step-back')
    expect(routeAt()).toBe('/study')
    cleanup()

    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    seedStore({ mode: 'predict' })
    renderFlow()
    await settle()
    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
  })

  it('the "← Step 4 of 4" line goes where Back goes: the trail\u2019s step, or the study step with no trail', async () => {
    useStepTrailStore.setState({ trail: ['/history'] })
    seedStore()
    renderFlow()
    await settle()
    expect(screen.getByTestId('txr-step-line-back').textContent).toBe('Step 4 of 4')
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/history')
    cleanup()

    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    seedStore()
    renderFlow()
    await settle()
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/study')
  })

  it('row 10 — reached from History: Back goes to History', async () => {
    useStepTrailStore.setState({ trail: ['/history'] })
    seedStore()
    renderFlow()
    await settle()
    await click('txr-step-back')
    expect(routeAt()).toBe('/history')
  })

  it('keeps the ticks after Back to B and Continue with the same files; ticks the recommendation again after a file change', async () => {
    useStepTrailStore.setState({ trail: ['/', '/files', '/study'] })
    seedStore()
    renderFlow()
    await settle()
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')
    await chooseOnly('direct-on')
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('1 method selected')

    await click('txr-step-back')
    expect(routeAt()).toBe('/study')
    await click('stand-in-continue')
    expect(routeAt()).toBe('/choose-methods')
    await settle()
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('1 method selected')
    expect(store().methodPicks?.touched).toBe(true)

    // A new file: a new validation with another inventory.
    await click('txr-step-back')
    act(() => {
      useTxrIntakeStore.setState({
        validation: { ...validation(), inventory: { ...validation().inventory, patients: 19 } },
      })
    })
    await click('stand-in-continue')
    await settle()
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')
  })

  it('keeps the pressed preset too after Back to B and Continue (All stays pressed where Recommended is the same set)', async () => {
    useStepTrailStore.setState({ trail: ['/', '/files', '/study'], current: null, leaving: false })
    seedStore()
    renderFlow()
    await settle()
    await click('txr-method-preset-all')
    const pressed = (value: string): string | null =>
      screen.getByTestId(`txr-method-preset-${value}`).getAttribute('aria-pressed')
    expect(pressed('all')).toBe('true')
    expect(pressed('recommended')).toBe('false')

    await click('txr-step-back')
    expect(routeAt()).toBe('/study')
    await click('stand-in-continue')
    await settle()
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('2 methods selected')
    expect(pressed('all')).toBe('true')
    expect(pressed('recommended')).toBe('false')
  })

  it('while a run is being created Back is unavailable with the reason, and flow.back refuses', async () => {
    api.createRun.mockReturnValue(new Promise(() => undefined))
    useStepTrailStore.setState({ trail: ['/', '/study', '/files'] })
    seedStore()
    renderFlow()
    await settle()
    await click('txr-run-bar-run')
    const back = screen.getByTestId('txr-step-back')
    expect(back.getAttribute('aria-disabled')).toBe('true')
    expect(back.textContent).toContain(STEP_BACK_STARTING_REASON)
    await expect(runAction('flow.back', {})).rejects.toThrow(STEP_BACK_STARTING_REASON)
    await click('txr-step-back')
    expect(routeAt()).toBe('/choose-methods')
  })

  it('after a run is created the page stays on "Starting the run…" until it leaves: Back stays unavailable', async () => {
    seedStore()
    renderPage()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle()
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
    expect(screen.getByTestId('txr-step-back').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('txr-step-back').textContent).toContain(STEP_BACK_STARTING_REASON)
  })

  it('while the Change files dialog is open, flow.back refuses', async () => {
    useStepTrailStore.setState({ trail: ['/', '/study', '/files'] })
    seedStore()
    renderFlow()
    await settle()
    await click('txr-run-change-files')
    await expect(runAction('flow.back', {})).rejects.toThrow(STEP_BACK_DIALOG_OPEN)
    expect(routeAt()).toBe('/choose-methods')
  })
})

describe('ChooseMethodsPage day settings (the files\u2019 suggestions, the look-ahead limits)', () => {
  /** 12 patients: draws on 28 and 56; 6 events at day 300, 6 followed to day 500. */
  const FACTS: FileTimeline = {
    draw_days: Array.from({ length: 12 }, () => [28, 56]),
    // A patients file carries both pairs (the validator needs both); the
    // same days for progression or death and for death alone.
    outcomes: [
      ...Array.from({ length: 6 }, () => ({
        pfs: { days: 300, event: 1 },
        os: { days: 300, event: 1 },
      })),
      ...Array.from({ length: 6 }, () => ({
        pfs: { days: 500, event: 0 },
        os: { days: 500, event: 0 },
      })),
    ],
    limits: { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10 },
  }

  it('starts the look-ahead at the files\u2019 default and suggests the decision days of the files', async () => {
    api.getConfig.mockResolvedValue(stickyConfig)
    seedStore({ dayFacts: FACTS, parameters: { decision_day: 56, baseline_max_day: 0 } })
    renderPage()
    await settle()
    expect(dayValue('txr-run-settings-decision-day')).toBe('56')
    expect(dayValue('txr-run-settings-look-ahead')).toBe('238')
    expect(screen.getByTestId('txr-run-settings-decision-day-suggestion-28')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings-look-ahead-coverage').textContent).toBe(
      'Day 238: 12 of 12 patients have a known outcome',
    )
  })

  it('a chosen look-ahead is this analysis\u2019 own: kept in the intake store and sent with the run', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ dayFacts: FACTS, parameters: { decision_day: 56, baseline_max_day: 0 } })
    renderPage()
    await settle()
    await typeDay('txr-run-settings-look-ahead', 400)
    expect(store().lookAheadDay).toBe(400)
    expect(dayValue('txr-run-settings-look-ahead')).toBe('400')
    expect(screen.getByTestId('txr-run-settings-sentence').textContent).toBe(
      'Progression or death by day 400 of treatment, from the blood draws up to day 56.',
    )
  })

  it('History\u2019s look-ahead (set in the intake store) is the one step 4 starts at', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ dayFacts: FACTS, lookAheadDay: 365, parameters: { decision_day: 56, baseline_max_day: 0 } })
    renderPage()
    await settle()
    expect(dayValue('txr-run-settings-look-ahead')).toBe('365')
  })

  it('a look-ahead where no patient has a known outcome blocks Run with the reason', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    const censored: FileTimeline = {
      ...FACTS,
      outcomes: Array.from({ length: 12 }, () => ({
        pfs: { days: 100, event: 0 },
        os: { days: 100, event: 0 },
      })),
    }
    seedStore({
      dayFacts: censored,
      lookAheadDay: 400,
      parameters: { decision_day: 56, baseline_max_day: 0 },
    })
    renderPage()
    await settle()
    await settle(250)
    const reason =
      'No patient has a known outcome by day 400, so the chance cannot be worked out. Choose an earlier day.'
    expect(screen.getByTestId('txr-run-settings-look-ahead-blocked').textContent).toBe(reason)
    expect(screen.getByTestId('txr-run-bar-blocked-reason').textContent).toBe(reason)
    expect(screen.getByTestId('txr-run-bar-run').hasAttribute('disabled')).toBe(true)
  })

  it('runSettings.setDay sets the days through the same handler, and refuses a day outside the limits', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ dayFacts: FACTS, parameters: { decision_day: 56, baseline_max_day: 0 } })
    renderPage()
    await settle()
    const live = instancesOfType('txr.run-settings')
    expect(live.length).toBe(1)
    await act(async () => {
      await runAction('runSettings.setDay', { view_id: live[0].id, field: 'look_ahead_day', day: 450 })
    })
    expect(dayValue('txr-run-settings-look-ahead')).toBe('450')
    expect(store().lookAheadDay).toBe(450)
    await act(async () => {
      await runAction('runSettings.setDay', { view_id: live[0].id, field: 'decision_day', day: 28 })
    })
    expect(dayValue('txr-run-settings-decision-day')).toBe('28')
    let failure: unknown = null
    await act(async () => {
      try {
        await runAction('runSettings.setDay', { view_id: live[0].id, field: 'look_ahead_day', day: 20 })
      } catch (err) {
        failure = err
      }
    })
    expect(String(failure)).toContain('Choose a day after the decision day (day 28).')
    expect(dayValue('txr-run-settings-look-ahead')).toBe('450')
  })

  it('a day the action refuses shows the message and the field keeps its value', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ dayFacts: FACTS, parameters: { decision_day: 56, baseline_max_day: 0 } })
    renderPage()
    await settle()
    const errorSpy = vi.spyOn(message, 'error')
    actionMock.rejectSetDay = true
    // A suggested decision day: the refusal comes from the action itself
    // (the field accepts it), so the page's catch shows the message and the
    // day keeps its old value.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-settings-decision-day-suggestion-28'))
      await Promise.resolve()
    })
    expect(errorSpy).toHaveBeenCalledWith('Choose a day after the decision day (day 56).')
    expect(dayValue('txr-run-settings-decision-day')).toBe('56')
    expect(dayValue('txr-run-settings-look-ahead')).toBe('238')
  })

  it('runSettings.setDay back-to-back keeps both days (the look-ahead never writes the old decision day back)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ dayFacts: FACTS, parameters: { decision_day: 56, baseline_max_day: 0 } })
    renderPage()
    await settle()
    const live = instancesOfType('txr.run-settings')
    expect(live.length).toBe(1)
    // Two calls in ONE tick (no re-render in between): decision day first,
    // then the look-ahead.
    await act(async () => {
      const first = runAction('runSettings.setDay', {
        view_id: live[0].id,
        field: 'decision_day',
        day: 42,
      })
      const second = runAction('runSettings.setDay', {
        view_id: live[0].id,
        field: 'look_ahead_day',
        day: 300,
      })
      await Promise.all([first, second])
    })
    expect(dayValue('txr-run-settings-decision-day')).toBe('42')
    expect(dayValue('txr-run-settings-look-ahead')).toBe('300')
    expect(store().lookAheadDay).toBe(300)
    // The write-through carries both: the engine never sees the day 56 come back.
    await settle(RUN_CONFIG_DEBOUNCE_MS)
    await settle()
    expect(api.putConfig).toHaveBeenCalled()
    const last = api.putConfig.mock.calls[api.putConfig.mock.calls.length - 1][0] as {
      config: { decision_day: number; look_ahead_day: number }
    }
    expect(last.config.decision_day).toBe(42)
    expect(last.config.look_ahead_day).toBe(300)
  })

  it('two day changes in one tick that return the decision day to its start end there (the diff never uses the stale render settings)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({ dayFacts: FACTS, parameters: { decision_day: 56, baseline_max_day: 0 } })
    renderPage()
    await settle()
    const live = instancesOfType('txr.run-settings')
    expect(live.length).toBe(1)
    // Two calls in ONE tick: decision day 42, then back to the starting 56.
    // The second call must diff against the first call's result (the ref),
    // not against the render-time settings: against the stale value the diff
    // omits decision_day, so the merged patch would keep the 42 although the
    // action succeeded and the field would show the old 42.
    await act(async () => {
      const first = runAction('runSettings.setDay', {
        view_id: live[0].id,
        field: 'decision_day',
        day: 42,
      })
      const second = runAction('runSettings.setDay', {
        view_id: live[0].id,
        field: 'decision_day',
        day: 56,
      })
      await Promise.all([first, second])
    })
    expect(dayValue('txr-run-settings-decision-day')).toBe('56')
    // The write-through carries the starting day: the engine never sees 42.
    await settle(RUN_CONFIG_DEBOUNCE_MS)
    await settle()
    expect(api.putConfig).toHaveBeenCalled()
    const last = api.putConfig.mock.calls[api.putConfig.mock.calls.length - 1][0] as {
      config: { decision_day: number; look_ahead_day: number }
    }
    expect(last.config.decision_day).toBe(56)
  })
})

describe('AOC part 2 — the Extra-inputs switch turns on / unticks with required methods (option A)', () => {
  /** A catalogue row with the given covariate mode (the AOC fixture half). */
  function methodSummary(
    id: string,
    title: string,
    covariates: 'required' | 'optional' | 'none',
  ): MethodSummary {
    return {
      id,
      year: 2021,
      language: 'R',
      group: 'response-probability',
      group_label: 'Response probability',
      title,
      summary: `Summary of ${title}.`,
      journal: 'Example Journal',
      runnable: true,
      spec_status: 'final',
      disease: { scope: 'any-solid-tumour', groups: [] },
      treatment: { classes: ['chemotherapy'], confidence: 'stated' },
      container: true,
      covariates,
      embeds_training_data: false,
      frozen_model: false,
      marker_groups_required: [],
      markers: { count: 1, kind: 'any' },
      min_draws: 1,
      needs_baseline: false,
      needs_detection_call: false,
      paper_doi: '10.0000/example',
      tasks: ['pfs'],
      timing: { base_seconds_per_fold: 60, benchmarked_units: 3, quality: 'measured' },
      uses_history: 'landmark',
    }
  }

  /** The verdict over one method (can_run unless `cannot`). */
  function verdictFor(id: string, cannot = false, reasonCode = 'COVARIATE_REQUIRED_UNMET') {
    return {
      id,
      status: cannot ? ('cannot_run' as const) : ('can_run' as const),
      estimated_seconds: 120,
      estimate_quality: 'measured' as const,
      coverage: { eligible: 18, total: 18, fraction: 1 },
      min_draws: { required: 2, met: 18, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      reasons: cannot ? [{ code: reasonCode }] : [],
    }
  }

  /** The picker's checkbox state (the kit Switch/Checkbox data-state). */
  function checkboxState(testId: string): string | null {
    const node = screen.getByTestId(testId)
    return (
      node.getAttribute('data-state') ??
      node.getAttribute('aria-checked') ??
      node.getAttribute('data-checked')
    )
  }

  /** The Extra-inputs switch's rendered state ('checked' | 'unchecked'). */
  const switchState = (): string | null => {
    const node = screen.getByTestId('txr-run-settings-covariates')
    return node.getAttribute('data-state') ?? node.getAttribute('aria-checked')
  }

  const autoLine = (): HTMLElement | null =>
    screen.queryByTestId('txr-run-settings-covariates-auto')

  it('a required method ticked with the switch off (file has the columns) turns the switch on, with ONE line; the request never changes', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({
      methods: [methodSummary('req-one', 'Precise rule', 'required')],
      total: 1,
    })
    api.eligibility.mockResolvedValue({
      methods: [verdictFor('req-one')],
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      total_no_env: 0,
    })
    seedStore()
    renderPage()
    await settle()
    await settle(250)

    // The seed ticked the one method; the auto-on turned the switch on with
    // the exact line under the switch.
    expect(checkboxState('txr-method-checkbox-req-one')).toBe('true')
    expect(switchState()).not.toBe('false')
    expect(autoLine()?.textContent).toBe('Turned on because Precise rule needs them.')
    // The switch change is NOT a re-check (the request carries the columns
    // either way): one eligibility answer, no "Checked again" noise.
    expect(api.eligibility.mock.calls.length).toBe(1)

    // The line stays while the switch is on and the required method stays
    // ticked ("stays until the switch or the set of required ticked methods
    // changes").
    await settle(250)
    expect(autoLine()?.textContent).toBe('Turned on because Precise rule needs them.')
  })

  it('several required methods: "Turned on because {n} of the chosen methods need them."', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({
      methods: [
        methodSummary('req-one', 'Precise rule', 'required'),
        methodSummary('req-two', 'Reliable rule', 'required'),
      ],
      total: 2,
    })
    api.eligibility.mockResolvedValue({
      methods: [verdictFor('req-one'), verdictFor('req-two')],
      total_fit: 2,
      total_some: 0,
      total_cannot: 0,
      total_no_env: 0,
    })
    seedStore()
    renderPage()
    await settle()
    await settle(250)

    expect(autoLine()?.textContent).toBe('Turned on because 2 of the chosen methods need them.')
    expect(switchState()).not.toBe('false')
  })

  it('no auto-on when the file has no extra-input columns: the required method cannot run, as today', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({
      methods: [methodSummary('req-one', 'Precise rule', 'required')],
      total: 1,
    })
    api.eligibility.mockResolvedValue({
      methods: [verdictFor('req-one', true)],
      total_fit: 0,
      total_some: 0,
      total_cannot: 1,
      total_no_env: 0,
    })
    seedStore({
      // The patients file inspected with NO covariate columns.
      patients: {
        ...loaded('patients.csv'),
        inspection: {
          ...patientsInspection,
          columns: { ...patientsInspection.columns, covariate_columns: [] },
        },
      },
    })
    renderPage()
    await settle()
    await settle(250)

    // The required method is a cannot-run card (COVARIATE_REQUIRED_UNMET) and
    // is never tickable; the switch stays off and no auto line appears.
    expect(screen.getByTestId('txr-method-zero')).toBeTruthy()
    expect(screen.getByTestId('txr-method-zero-reason-covariates')).toBeTruthy()
    expect(screen.queryByTestId('txr-method-checkbox-req-one')).toBeNull()
    expect(switchState()).not.toBe('true')
    expect(autoLine()).toBeNull()
  })

  it('a manual switch-off unticks the required methods with its line; the switch stays off (no loop)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({
      methods: [
        methodSummary('req-one', 'Precise rule', 'required'),
        methodSummary('opt-one', 'Optional rule', 'optional'),
      ],
      total: 2,
    })
    api.eligibility.mockResolvedValue({
      methods: [verdictFor('req-one'), verdictFor('opt-one')],
      total_fit: 2,
      total_some: 0,
      total_cannot: 0,
      total_no_env: 0,
    })
    seedStore()
    renderPage()
    await settle()
    await settle(250)
    // The mount auto-on turned the switch on (the required method is ticked).
    expect(switchState()).not.toBe('false')

    // Switching off by hand: the required method is unticked through the
    // registered action, the line says so, the switch stays off.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-covariates'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-covariates'))
      await Promise.resolve()
    })
    await settle()
    await settle(250)
    expect(checkboxState('txr-method-checkbox-req-one')).toBe('false')
    expect(checkboxState('txr-method-checkbox-opt-one')).toBe('true')
    expect(autoLine()?.textContent).toBe('Precise rule was unticked: it needs extra inputs.')
    expect(switchState()).not.toBe('true')
    // No auto-on loop: one eligibility answer, no second switch change.
    expect(api.eligibility.mock.calls.length).toBe(1)

    // Ticking the required method again (switch off, columns present): the
    // auto-on fires again — that is the rule's one trigger.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-method-checkbox-req-one'))
      await Promise.resolve()
    })
    await settle()
    await settle(250)
    expect(autoLine()?.textContent).toBe('Turned on because Precise rule needs them.')
    expect(switchState()).not.toBe('false')
  })

  it('an optional or none method never triggers either step', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({
      methods: [
        methodSummary('opt-one', 'Optional rule', 'optional'),
        methodSummary('none-one', 'No-input rule', 'none'),
      ],
      total: 2,
    })
    api.eligibility.mockResolvedValue({
      methods: [verdictFor('opt-one'), verdictFor('none-one')],
      total_fit: 2,
      total_some: 0,
      total_cannot: 0,
      total_no_env: 0,
    })
    seedStore()
    renderPage()
    await settle()
    await settle(250)

    // The seed ticked them; the switch stays OFF and no auto line appears.
    expect(checkboxState('txr-method-checkbox-opt-one')).toBe('true')
    expect(switchState()).not.toBe('true')
    expect(autoLine()).toBeNull()

    // Switching on and off again: nothing is unticked (no required method
    // was ticked), no line, no switch flips.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-covariates'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-covariates'))
      await Promise.resolve()
    })
    await settle()
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-covariates'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-covariates'))
      await Promise.resolve()
    })
    await settle()
    await settle(250)
    expect(checkboxState('txr-method-checkbox-opt-one')).toBe('true')
    expect(checkboxState('txr-method-checkbox-none-one')).toBe('true')
    expect(autoLine()).toBeNull()
    expect(switchState()).not.toBe('true')
  })

  it('with the file\'s inspection UNKNOWN, the eligibility request follows the switch again (the pre-option-A rule): [] off, the names on', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    // The patients file has NO resolved inspection: the screen cannot say
    // what the extra-input columns are, so today's rule is restored for this
    // case — the request carries [] with the switch off and the names with
    // the switch on. (`present` keeps the new always-send rule; `absent`
    // keeps [].)
    seedStore({
      patients: { ...loaded('patients.csv'), inspection: null },
    })
    renderPage()
    await settle()
    expect(api.eligibility.mock.calls.length).toBe(1)
    expect(api.eligibility.mock.calls[0][0].inventory.covariates).toEqual([])

    // The switch is ENABLED for unknown (only `absent` disables it); turning
    // it on sends the columns again — a real re-check now, and the request
    // content changed.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-covariates'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-covariates'))
      await Promise.resolve()
    })
    await settle()
    expect(api.eligibility.mock.calls.length).toBe(2)
    expect(api.eligibility.mock.calls[1][0].inventory.covariates).toEqual([
      { key: 'age', display_name: 'age', standard_ids: [], unit_family: 'none' },
    ])

    // Off again: [] again, and the request changes a third time.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-covariates'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-covariates'))
      await Promise.resolve()
    })
    await settle()
    expect(api.eligibility.mock.calls.length).toBe(3)
    expect(api.eligibility.mock.calls[2][0].inventory.covariates).toEqual([])
  })

  it('a required method ticked while the columns are unknown turns the switch on when the inspection lands (the auto-on is never lost)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.listMethods.mockResolvedValue({
      methods: [methodSummary('req-one', 'Precise rule', 'required')],
      total: 1,
    })
    api.eligibility.mockResolvedValue({
      methods: [verdictFor('req-one')],
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      total_no_env: 0,
    })
    // The patients file has NO resolved inspection yet.
    seedStore({
      patients: { ...loaded('patients.csv'), inspection: null },
    })
    renderPage()
    await settle()
    await settle(250)
    // The seed ticked the required method with the switch off, but the
    // screen cannot say the columns are there yet: no auto-on (and the
    // transition must NOT be recorded as done).
    expect(checkboxState('txr-method-checkbox-req-one')).toBe('true')
    expect(switchState()).not.toBe('true')
    expect(autoLine()).toBeNull()

    // The inspection lands (the columns are there): the SAME ticked required
    // method now turns the switch on — the auto-on was not lost for good.
    await act(async () => {
      useTxrIntakeStore.setState({
        patients: loaded('patients.csv'),
      })
      await Promise.resolve()
    })
    await settle()
    await settle(250)
    expect(autoLine()?.textContent).toBe('Turned on because Precise rule needs them.')
    expect(switchState()).not.toBe('false')
  })

  it('runSettings.setCovariates ON is refused with a plain reason when the file has no extra-input columns (the disabled switch\'s assistant path)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({
      // The patients file inspected with NO covariate columns: the switch is
      // disabled in the UI, and the ACTION refuses the assistant the same
      // way with a plain reason.
      patients: {
        ...loaded('patients.csv'),
        inspection: {
          ...patientsInspection,
          columns: { ...patientsInspection.columns, covariate_columns: [] },
        },
      },
    })
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-run-settings-covariates-disabled-reason')).toBeTruthy()
    const live = instancesOfType('txr.run-settings')
    expect(live.length).toBe(1)
    let failure: unknown = null
    await act(async () => {
      try {
        await runAction(RUN_SETTINGS_SET_COVARIATES, { view_id: live[0].id, on: true })
      } catch (err) {
        failure = err
      }
    })
    expect((failure as Error | null)?.message).toBe(
      'The file has no extra-input columns, so Extra inputs cannot be turned on.',
    )
    // A refusal changes nothing: the switch stays off and no new eligibility
    // request (the absent request is [] either way).
    expect(switchState()).not.toBe('true')
    expect(api.eligibility.mock.calls.length).toBe(1)
  })

  it('runSettings.setCovariates ON is refused when there is no patients file (the predict-mode render)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore({
      mode: 'predict',
      patients: null,
      predictMeasurements: loaded('measurements.csv'),
    })
    renderPage()
    await settle()
    const live = instancesOfType('txr.run-settings')
    expect(live.length).toBe(1)
    let failure: unknown = null
    await act(async () => {
      try {
        await runAction(RUN_SETTINGS_SET_COVARIATES, { view_id: live[0].id, on: true })
      } catch (err) {
        failure = err
      }
    })
    expect((failure as Error | null)?.message).toBe(
      'There is no patients file, so Extra inputs cannot be turned on.',
    )
    expect(switchState()).not.toBe('true')
    expect(api.eligibility.mock.calls.length).toBe(1)
  })
})


describe('ChooseMethodsPage single-marker-choice round 2', () => {
  /** The file's two main markers (the ranking's candidates). */
  const MAIN_MARKERS: InventoryMarker[] = [
    {
      key: 'ctdna_mm',
      display_name: 'ctDNA',
      n_patients_with_value: 12,
      n_patients_with_baseline: 12,
      n_patients_with_ontreatment: 12,
      is_detection_call: false,
      has_detection_companion: false,
      standard_ids: [],
      unit_family: 'ratio',
    },
    {
      key: 'ldh',
      display_name: 'LDH',
      n_patients_with_value: 15,
      n_patients_with_baseline: 15,
      n_patients_with_ontreatment: 15,
      is_detection_call: false,
      has_detection_companion: false,
      standard_ids: [],
      unit_family: 'percent',
    },
  ]

  function rankingValidation(): ValidationResponse {
    return {
      ...validation(),
      inventory: { ...validation().inventory, markers: [...MAIN_MARKERS] },
    }
  }

  function rankingAnswer(
    over: Partial<import('@/api-client/types').MarkerRankingResponse> = {},
  ): import('@/api-client/types').MarkerRankingResponse {
    return {
      markers_by_kind: { any: [], multi: {}, single: [] },
      offered: ['ldh', 'ctdna_mm'],
      ranking: [],
      ranking_patients: 12,
      top: ['ldh', 'ctdna_mm'],
      ...over,
    }
  }

  beforeEach(() => {
    api.markerRanking.mockResolvedValue(rankingAnswer())
  })

  /** The study step (B) stand-in: `flow.back` from the methods step goes here. */
  function StudyStandIn() {
    const navigate = useNavigate()
    return (
      <Button data-testid="stand-in-continue" onClick={() => navigate('/choose-methods')}>
        Continue
      </Button>
    )
  }

  function renderRankingFlow() {
    return render(
      <MemoryRouter initialEntries={['/choose-methods']}>
        <RouterBridge />
        <Routes>
          <Route path="/choose-methods" element={<ChooseMethodsPage />} />
          <Route path="/study" element={<StudyStandIn />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    )
  }

  const routeAt = () => screen.getByTestId('route-location').textContent

  it('calls the ranking route with the parsed tables + endpoint/day, and its result rides the eligibility marker_plan', async () => {
    seedStore({ validation: rankingValidation() })
    renderPage()
    await settle()
    // The eligibility request BEFORE the ranking settles carries no plan.
    expect(api.eligibility.mock.calls[0][0].inventory.marker_plan).toBeUndefined()

    await settle(300)
    await settle(0)
    // The ranking request carries the SAME parsed input the run carries +
    // the endpoint and decision day; `ranking` mode sends no single_marker.
    expect(api.markerRanking).toHaveBeenCalledTimes(1)
    expect(api.markerRanking).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'pfs',
        decision_day: 84,
      }),
    )
    expect(api.markerRanking.mock.calls[0][0].single_marker).toBeUndefined()
    // The eligibility request now copies the answer as its marker_plan.
    const plan = api.eligibility.mock.calls.at(-1)![0].inventory.marker_plan
    expect(plan).toEqual({ mode: 'ranked', top: ['ldh', 'ctdna_mm'], offered: ['ldh', 'ctdna_mm'] })
  })

  it('re-calls when the endpoint, decision day or the choice changes (debounced)', async () => {
    seedStore({ validation: rankingValidation() })
    renderPage()
    await settle(300)
    await settle(0)
    expect(api.markerRanking).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('txr-run-settings-endpoint-opt-os'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(screen.getByTestId('txr-run-settings-endpoint-opt-os'))
      await Promise.resolve()
    })
    await settle(300)
    expect(api.markerRanking).toHaveBeenCalledTimes(2)
    expect(api.markerRanking.mock.calls[1][0]).toEqual(
      expect.objectContaining({ endpoint: 'os', decision_day: 84 }),
    )

    await typeDay('txr-run-settings-decision-day', 28)
    await settle(300)
    expect(api.markerRanking).toHaveBeenCalledTimes(3)
    expect(api.markerRanking.mock.calls[2][0]).toEqual(
      expect.objectContaining({ decision_day: 28 }),
    )

    await act(async () => {
      useTxrIntakeStore.getState().setSingleMarkerChoice({
        mode: 'chosen',
        marker: 'ctdna_mm',
      })
      await Promise.resolve()
    })
    await settle(300)
    expect(api.markerRanking).toHaveBeenCalledTimes(4)
    expect(api.markerRanking.mock.calls[3][0]).toEqual(
      expect.objectContaining({ single_marker: { mode: 'chosen', marker: 'ctdna_mm' } }),
    )
  })

  it('renders the ranked line above the list with the change link, and "Change it in step 3" runs flow.back', async () => {
    useStepTrailStore.setState({ trail: ['/', '/files', '/study'], current: null, leaving: false })
    seedStore({ validation: rankingValidation() })
    renderRankingFlow()
    await settle(300)
    await settle(0)
    const line = screen.getByTestId('txr-run-single-marker-line')
    expect(line.textContent).toContain(
      'Methods that pick markers from your file use the top 5: ldh and ctdna_mm, ranked by how well each separates progression or death in your patients.',
    )
    expect(line.textContent).toContain('Change it in step 3')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-single-marker-change'))
      await Promise.resolve()
    })
    await settle(0)
    expect(routeAt()).toBe('/study')
  })

  it('while the ranking is loading the line reads "Ranking your markers…" and the eligibility request carries no plan', async () => {
    api.markerRanking.mockReturnValue(new Promise(() => undefined))
    seedStore({ validation: rankingValidation() })
    renderPage()
    await settle()
    await settle(250)
    expect(screen.getByTestId('txr-run-single-marker-line').textContent).toBe('Ranking your markers…')
    expect(screen.queryByTestId('txr-run-single-marker-change')).toBeNull()
    expect(api.markerRanking).toHaveBeenCalledTimes(1)
    // The plan never lands: every eligibility request kept today's rule.
    for (const call of api.eligibility.mock.calls) {
      expect(call[0].inventory.marker_plan).toBeUndefined()
    }
  })

  it('a ranking error shows the route message (never a fabricated sentence) and the plan carries the error', async () => {
    api.markerRanking.mockResolvedValue(
      rankingAnswer({
        top: [],
        offered: [],
        error: {
          code: 'MARKER_RANKING_TOO_FEW',
          message:
            'Fewer than 10 patients have a draw before and during treatment and a known outcome by day 84, so the markers cannot be ranked.',
        },
      }),
    )
    seedStore({ validation: rankingValidation() })
    renderPage()
    await settle(300)
    await settle(0)
    const line = screen.getByTestId('txr-run-single-marker-line')
    expect(line.textContent).toBe(
      'Fewer than 10 patients have a draw before and during treatment and a known outcome by day 84, so the markers cannot be ranked.',
    )
    expect(screen.queryByTestId('txr-run-single-marker-change')).toBeNull()
    const plan = api.eligibility.mock.calls.at(-1)![0].inventory.marker_plan
    expect(plan).toEqual({
      mode: 'ranked',
      error: {
        code: 'MARKER_RANKING_TOO_FEW',
        message:
          'Fewer than 10 patients have a draw before and during treatment and a known outcome by day 84, so the markers cannot be ranked.',
      },
    })
  })

  it('the line is absent when no shown method has no fixed list (the plan does not touch them)', async () => {
    const fixed = catalogue().map(m => ({
      ...m,
      required_markers: {
        list_source: 'fixture',
        match: 'all' as const,
        min_fraction: 1,
        markers: [{ id: 'ldh', id_system: 'LOINC', name: 'LDH' }],
      },
    }))
    api.listMethods.mockResolvedValue({ methods: fixed, total: fixed.length })
    seedStore({ validation: rankingValidation() })
    renderPage()
    await settle(300)
    await settle(0)
    expect(screen.queryByTestId('txr-run-single-marker-line')).toBeNull()
    // The plan still rides the request (the server applies it to the
    // no-list methods of the whole list) — only the LINE is about the shown
    // cards, and with none no-list it stays away.
    const plan = api.eligibility.mock.calls.at(-1)![0].inventory.marker_plan
    expect(plan).toEqual({ mode: 'ranked', top: ['ldh', 'ctdna_mm'], offered: ['ldh', 'ctdna_mm'] })
  })

  it('the run request carries the step-3 choice (chosen) as the config single_marker', async () => {
    seedStore({ validation: rankingValidation() })
    act(() => {
      useTxrIntakeStore.getState().setSingleMarkerChoice({ mode: 'chosen', marker: 'ctdna_mm' })
    })
    renderPage()
    await settle(300)
    await chooseOnly('direct-on')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(api.createRun.mock.calls[0][0].config.single_marker).toEqual({
      mode: 'chosen',
      marker: 'ctdna_mm',
    })
  })
})
