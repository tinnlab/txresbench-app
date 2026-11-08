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
import { MemoryRouter, useLocation } from 'react-router-dom'
import type {
  EligibilityResponse,
  FileInspection,
  MethodSummary,
  TxrAppConfig,
  TxrRunListResponse,
  TxrRunSummary,
  ValidationResponse,
} from '@/api-client/types'
import type { TxrIntakeState } from '@/modules/txrintake'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { RESEARCH_NOTICE } from '../lib/format'
import { RUN_METHODS_GONE_LINE } from '../lib/runErrors'
import { ChooseMethodsPage } from './ChooseMethodsPage'
import { RUN_CONFIG_DEBOUNCE_MS } from '../data/useRunConfig'

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
  createRun: vi.fn(),
  listRuns: vi.fn(),
  getPrefs: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getAnalysisConfig: api.getConfig,
      updateAnalysisConfig: api.putConfig,
      createRun: api.createRun,
      listRuns: api.listRuns,
    },
    MethodCatalogue: {
      list: api.listMethods,
      eligibility: api.eligibility,
      estimate: api.estimate,
    },
    History: {
      getPreferences: api.getPrefs,
    },
  },
}))

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
      journal: 'Example Journal',
      runnable: true,
      spec_status: 'final',
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
      journal: 'Example Journal',
      runnable: true,
      spec_status: 'final',
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
      journal: 'Example Journal',
      runnable: true,
      spec_status: 'final',
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

/** Select the row by its checkbox (the shared list's own toggle). */
async function selectRow(key: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`txr-list-checkbox-${key}`))
    await Promise.resolve()
  })
  await settle(0)
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
  api.getConfig.mockResolvedValue({ config: null })
  api.putConfig.mockResolvedValue(undefined)
  api.listMethods.mockResolvedValue({ methods: catalogue(), total: 3 })
  api.eligibility.mockResolvedValue(eligibility())
  api.estimate.mockResolvedValue({ total_seconds: 50, schedule_seconds: 50 })
  api.createRun.mockResolvedValue({ id: 'run-1' } as unknown as TxrRunSummary)
  api.listRuns.mockResolvedValue({
    runs: [],
    total: 0,
    limit: 50,
    offset: 0,
  } as TxrRunListResponse)
  api.getPrefs.mockResolvedValue({ keep_file_copies: true })
  window.localStorage.clear()
  store().reset()
  statedLayout()
})

afterEach(() => {
  cleanup()
  restoreLayout?.()
  restoreLayout = null
  vi.useRealTimers()
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
    // other fields carry (endpoint os, horizon 365, at-a-time 4...).
    const dayChip = screen.getByTestId('txr-run-settings-decision-day-opt-84')
    expect(dayChip.getAttribute('data-state')).toBe('on')
    expect(
      screen.getByTestId('txr-run-settings-look-ahead-opt-365').getAttribute('data-state'),
    ).toBe('on')
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
        look_ahead_day: 238,
        covariates: false,
        at_a_time: 3,
        cpus: null,
        save_models: false,
        label_day: null,
      },
    })
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
    expect(
      screen.getByTestId('txr-run-settings-look-ahead-opt-238').getAttribute('data-state'),
    ).toBe('on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-settings-retry'))
      await Promise.resolve()
    })
    await settle()
    await settle()
    expect(screen.queryByTestId('txr-run-settings-error')).toBeNull()
    expect(
      screen.getByTestId('txr-run-settings-look-ahead-opt-365').getAttribute('data-state'),
    ).toBe('on')
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
    // for the untouched rows (horizon 365), and the write-through body
    // never falls back to defaults for fields the user did not touch.
    expect(
      screen.getByTestId('txr-run-settings-endpoint-opt-os').getAttribute('data-state'),
    ).toBe('on')
    expect(
      screen.getByTestId('txr-run-settings-look-ahead-opt-365').getAttribute('data-state'),
    ).toBe('on')
    await settle(RUN_CONFIG_DEBOUNCE_MS)
    await settle()
    expect(api.putConfig).toHaveBeenCalledTimes(1)
    expect(api.putConfig).toHaveBeenCalledWith({
      config: {
        endpoint: 'os',
        decision_day: 84,
        look_ahead_day: 365,
        covariates: true,
        at_a_time: 3,
        cpus: 2,
        save_models: true,
        label_day: null,
      },
    })
  })
})

describe('ChooseMethodsPage list + create path (ITEM-8, TEST-RUN-17)', () => {
  it('hosts the shared selection list fed by the inventory hooks — the one list, the research notice, the estimate bar', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    // INV-3: the shared list component is THE list (the txr-list surface,
    // never a bespoke row build in this module).
    expect(screen.getByTestId('txr-run-list')).toBeTruthy()
    expect(screen.getByTestId('txr-list')).toBeTruthy()
    expect(screen.getByTestId('txr-list-bottom-bar')).toBeTruthy()
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('0 methods selected')

    // The board lead paragraph is data-filled from the inventory (INV-6:
    // the fixture's own 18, never the board's 151).
    expect(screen.getByTestId('txr-run-intro').textContent).toContain('your 18 patients')

    // The rows: the catalogue's runnable + cannot rows with their verdicts.
    expect(screen.getByTestId('txr-list-row-direct-on').textContent).toContain('Can run')
    expect(screen.getByTestId('txr-list-row-direct-on').textContent).toContain('all 18 patients')
    expect(screen.getByTestId('txr-list-row-ki67-two-week-four-group').textContent).toContain(
      'needs Ki-67, not in your file',
    )

    // The research notice is the module's ONE constant, on the bar.
    expect(screen.getByText(RESEARCH_NOTICE)).toBeTruthy()
  })

  it('the bar total is the estimate response, never a client-time computation (INV-4)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    await selectRow('direct-on')
    // One debounced estimate call with the screen's patients/at-a-time/CPUs.
    await settle(250)
    // Auto CPU: the field is omitted so the SERVER resolves the run's own
    // count (CM-7's one source of truth — the old 4-CPU client default was
    // what made the bar disagree with the running header).
    expect(api.estimate).toHaveBeenCalledWith({
      method_ids: ['direct-on'],
      patients: 18,
      cpus: undefined,
      at_a_time: 3,
    })
    // The bar's total line is the estimate response through the provider's
    // own long formatter (the segment also carries the at-a-time label —
    // the board's own bar line).
    expect(screen.getByTestId('txr-list-total-time').textContent).toContain(
      'under 1 minute in total on this computer',
    )
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 method selected')
  })

  it('the group chips wire the builder to the host filter: toggle active, filter the row set', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    const probability = screen.getByTestId('txr-list-filter-response-probability')
    const dynamic = screen.getByTestId('txr-list-filter-dynamic-risk')
    expect(probability.textContent).toContain('Response probability')
    expect(probability.textContent).toContain('1')
    expect(dynamic.textContent).toContain('1')
    expect(probability.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      fireEvent.click(probability)
      await Promise.resolve()
    })
    expect(probability.getAttribute('aria-pressed')).toBe('true')
    // The filter is the host's: the probability row stays, the dynamic-risk
    // row is gone.
    expect(screen.getByTestId('txr-list-row-direct-on')).toBeTruthy()
    expect(screen.queryByTestId('txr-list-row-dynforest')).toBeNull()
    expect(screen.queryByTestId('txr-list-row-ki67-two-week-four-group')).toBeNull()

    // A second click toggles the filter off — one chip active at a time.
    await act(async () => {
      fireEvent.click(probability)
      await Promise.resolve()
    })
    expect(probability.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('txr-list-row-dynforest')).toBeTruthy()
  })

  it('the All and Can run pills are real filters: All clears both, Can run shows only runnable rows (CM-3)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()

    const all = screen.getByTestId('txr-list-filter-all')
    const canRun = screen.getByTestId('txr-list-filter-can-run')
    expect(all.textContent).toBe('All 3')
    expect(canRun.textContent).toBe('Can run 2')
    expect(all.getAttribute('aria-pressed')).toBe('true')

    // Can run on: the cannot row (ki67) is filtered out of the view.
    await act(async () => {
      fireEvent.click(canRun)
      await Promise.resolve()
    })
    expect(canRun.getAttribute('aria-pressed')).toBe('true')
    expect(all.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('txr-list-row-direct-on')).toBeTruthy()
    expect(screen.queryByTestId('txr-list-row-ki67-two-week-four-group')).toBeNull()
    expect(screen.getByTestId('txr-list-filter-can-run').textContent).toBe('Can run 2')

    // The group filter composes with Can run; All clears BOTH.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-dynamic-risk'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-list-row-dynforest')).toBeTruthy()
    expect(screen.queryByTestId('txr-list-row-direct-on')).toBeNull()
    await act(async () => {
      fireEvent.click(all)
      await Promise.resolve()
    })
    expect(all.getAttribute('aria-pressed')).toBe('true')
    expect(canRun.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('txr-list-row-direct-on')).toBeTruthy()
    expect(screen.getByTestId('txr-list-row-ki67-two-week-four-group')).toBeTruthy()
  })

  it('states the no-published-environment count above the list (CM-1)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    const eligibilityWithNoEnv = eligibility()
    eligibilityWithNoEnv.total_no_env = 2
    api.eligibility.mockResolvedValue(eligibilityWithNoEnv)
    seedStore()
    renderPage()
    await settle()

    expect(screen.getByTestId('txr-run-no-env-line').textContent).toBe(
      "2 of 3 methods have no published environment on this computer and can't start.",
    )
    expect(screen.getByTestId('txr-list-filter-can-run').textContent).toBe('Can run 2')
  })

  it('Run posts the frozen request and navigates to the new run runningPath on 202', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    seedStore()
    renderPage()
    await settle()
    await selectRow('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
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
    // the defaults), the engine-true nulls (cpus: null, label_day: null).
    expect(request.config).toEqual({
      endpoint: 'pfs',
      decision_day: 84,
      look_ahead_day: 238,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
      label_day: null,
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
    await selectRow('direct-on')
    await selectRow('dynforest')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-notice')).toBeTruthy()
    expect(screen.getByTestId('txr-run-create-notice').textContent).toBe(
      'direct-on is no longer in the method catalogue — it was removed from the selection.',
    )
    // The named row left the selection; the other stays.
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 method selected')
    expect(api.listRuns).not.toHaveBeenCalled()
  })

  it('a 404 that attributes no row surfaces the error line and keeps the selection (never a silent drop)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.createRun.mockRejectedValue({ status: 404, message: 'METHOD_NOT_FOUND' })
    seedStore()
    renderPage()
    await settle()
    await selectRow('direct-on')

    // The local catalogue DOES know the row — neither attribution source
    // names a stale method, so the run was not created and the choice is
    // kept for the retry.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-error').textContent).toBe(
      RUN_METHODS_GONE_LINE,
    )
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 method selected')
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
    await selectRow('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
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

  it('a 409 with no active run answer surfaces the error line (the racy state is never hidden)', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.createRun.mockRejectedValue({ status: 409, message: 'a run is already active' })
    seedStore()
    renderPage()
    await settle()
    await selectRow('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
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

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(screen.getByTestId('txr-run-create-error').textContent).toBe(
      'EMPTY_METHODS: choose at least one method',
    )
    // The empty run attempt never navigates; the rows keep their values.
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-methods')
    expect(screen.getByTestId('txr-list-row-direct-on')).toBeTruthy()
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
    expect(screen.getByTestId('txr-run-slots')).toBeTruthy()
  })
})

describe('ChooseMethodsPage keep-copies (TEST-RUN-36)', () => {
  it('reads the preference once at mount and it wins over the builder default', async () => {
    api.getConfig.mockResolvedValue({ config: null })
    api.getPrefs.mockResolvedValue({ keep_file_copies: false })
    seedStore()
    renderPage()
    await settle()
    await selectRow('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
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
    await selectRow('direct-on')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(api.createRun.mock.calls[0][0].input.keep_copies).toBe(true)
  })
})
