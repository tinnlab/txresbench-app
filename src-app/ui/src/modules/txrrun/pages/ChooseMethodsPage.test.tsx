// @vitest-environment jsdom
/**
 * The E page's settings wiring (ITEM-7; PROV-UI-RUN-4's page composition
 * + TEST-RUN-15's data side): `ChooseMethodsPage` composes the DEC-6
 * mount merge (the intake's current decision day first, the engine's
 * sticky config for every other field — the page binds the hook's RAW
 * `engine`, DRIFT-1 ITEM-4 #1), writes every row change through to
 * `useRunConfig().update` (the 400 ms debounced `Txr.updateAnalysisConfig`,
 * CONS-UI-RUN-6), and fills the Extra-inputs names line from the patients
 * file's inspection `covariate_columns`.
 *
 * TEST-RUN-17 (ITEM-8) extends this same file with the shared-list and
 * create-path pins; this file's rows are the settings wiring the ITEM-7
 * line owns.
 *
 * Pinned behaviors:
 * - mount issues exactly the GET (never a PUT) and renders the merged
 *   view after it lands: the intake's decision day wins, the sticky
 *   config's other fields carry;
 * - a row change writes through: ONE PUT with the settings-only
 *   `TxrAppConfig` body after the debounce;
 * - the names line is the inspection's covariate_columns names (the
 *   board's "age, sex, stage" is a design example — the fixture's own
 *   names are asserted instead, INV-6);
 * - while the first GET is in flight the card is the skeleton (a
 *   defaults flash would be a wrong screen); a failed GET renders the
 *   usable defaults with the error + retry, and retry re-loads the
 *   sticky store.
 *
 * The intake store is real (seeded per test, the TxrSlotSummary test
 * idiom); the engine call is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { FileInspection, TxrAppConfig, ValidationResponse } from '@/api-client/types'
import type { TxrIntakeState } from '@/modules/txrintake'
import { useTxrIntakeStore } from '@/modules/txrintake'
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
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getAnalysisConfig: api.getConfig,
      updateAnalysisConfig: api.putConfig,
    },
  },
}))

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
  }
}

/** The fixture's one validation (small synthetic counts — INV-6). */
function validation(): ValidationResponse {
  return {
    patients: { rows: 18, with_primary_outcome: 7, median_followup_days: 84 },
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/choose-methods']}>
      <ChooseMethodsPage />
    </MemoryRouter>,
  )
}

/** Flush the pending microtasks + timers (the mount GET and the debounce). */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  api.getConfig.mockReset()
  api.putConfig.mockReset()
  api.getConfig.mockResolvedValue({ config: null })
  api.putConfig.mockResolvedValue(undefined)
  window.localStorage.clear()
  store().reset()
})

afterEach(() => {
  cleanup()
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
        at_a_time: 4,
        cpus: 2,
        save_models: true,
        label_day: null,
      },
    })
  })
})
