// @vitest-environment jsdom
//
// TEST-UR-6 (ITEM-8) — the G ResultsPage (PROV-UR-1/2/5, DEC-3/18, INV-1):
// the page loads the run through the results store (detail → predictions →
// stream, in order), renders the loading skeleton, the 409 empty-heatmap
// state (banner + counts + disabled download, no spinner loop), the 404
// not-found state (message + New analysis CTA, no crash), the error state
// with a retry that re-runs `load`, the live column growth on a
// `prediction` SSE frame, the cannot-run banner rows, and the three header
// actions (download → the CSV save, save-models → the framework event,
// New analysis → `/`) — EXAMPLE-UR-1/UR-4, plus the page's PROV-UR-5
// test-id surface.
//
// The only boundaries mocked are `ApiClient.Txr.*`; the store runs real
// (the ITEM-5 test already pins its internals — this file pins the PAGE's
// wiring through it: store callbacks → view → DOM). The stream mock keeps
// its promise pending and exposes the captured SSE handlers so a frame
// script can be played. All fixtures are synthetic (patient ids `S00xx`,
// catalogue-slug method ids, computed counts — the board's facts are never
// data, INV-5).

import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { AppEvents } from '@txresbench/framework/events'
import { useEventBusStore } from '@txresbench/framework/events'
import type { TxrPredictionsResponse, TxrRunDetail, TxrRunMethod } from '@/api-client/types'
import { ResultsPage } from './ResultsPage'

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  getPredictions: vi.fn(),
  streamRun: vi.fn(),
  listRunLogs: vi.fn(),
  downloadPredictions: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getRun: (...a: unknown[]) => api.getRun(...a),
      getPredictions: (...a: unknown[]) => api.getPredictions(...a),
      streamRun: (...a: unknown[]) => api.streamRun(...a),
      listRunLogs: (...a: unknown[]) => api.listRunLogs(...a),
      downloadPredictions: (...a: unknown[]) => api.downloadPredictions(...a),
    },
  },
}))

const { useTxrResultsStore } = await import('../stores/Results.store')
const state = () => useTxrResultsStore.getState()

// jsdom gaps the kit's base-ui controls (the TxrListFilterBar polyfill set —
// the bar and tabs render through the page, so the page test needs them).
beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
  if (typeof globalThis.Element !== 'undefined' && !globalThis.Element.prototype.scrollIntoView) {
    globalThis.Element.prototype.scrollIntoView = () => {}
  }
})

afterEach(() => {
  cleanup()
  useEventBusStore.getState().clear()
})

// ── Synthetic fixtures (INV-5) ───────────────────────────────────────────────

/** 120 patients — beyond the 100-row default so the Show-all affordance lives. */
const PATIENT_COUNT = 12 * 10
const PATIENTS = Array.from({ length: PATIENT_COUNT }, (_, i) => `S${String(i).padStart(4, '0')}`)

const FINISHED_IDS = ['lm-cox-a', 'rsf-b']
const CANNOT_RUN_ID = 'cox-nomarker'
const RUNNING_ID = 'rsf-pending'

function methodRow(
  id: string,
  methodState: TxrRunMethod['state'],
  over?: Partial<TxrRunMethod>,
): TxrRunMethod {
  return {
    method_id: id,
    label: id,
    group: 'dynamic-risk',
    group_label: 'Dynamic risk',
    version: '1.0.0',
    state: methodState,
    bytes_downloaded: 0,
    ...(methodState === 'finished' ? { phase: 'done' as const } : {}),
    ...over,
  }
}
/** Two finished, one cannot-run, one running — the live "2 of 4" header state. */
function runFixture(): TxrRunDetail {
  const methods = [
    methodRow(FINISHED_IDS[0], 'finished', { elapsed_secs: 94 }),
    methodRow(FINISHED_IDS[1], 'finished', { elapsed_secs: 71 }),
    methodRow(RUNNING_ID, 'running', { phase: 'predict', elapsed_secs: 12 }),
    methodRow(CANNOT_RUN_ID, 'cannot_run', {
      reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements' },
    }),
  ]
  return {
    id: 'run-1',
    status: 'running',
    mode: 'train',
    created_at: '2026-11-06T00:00:00Z',
    started_at: '2026-11-06T00:00:50Z',
    finished_at: undefined,
    elapsed_secs: 7 * 60 + 30,
    cpus: 4,
    dir: '/home/u/.txresbench/analysis-2026-11-06-0000',
    method_ids: methods.map(m => m.method_id),
    methods,
    counts: {
      waiting: 0,
      downloading: 0,
      running: 1,
      finished: FINISHED_IDS.length,
      failed: 0,
      stopped: 0,
      skipped: 0,
      cannot_run: 1,
    },
    models: [],
    model_ids: [],
    input_summary: { patients: PATIENT_COUNT + 160, markers: 5, events: 2, file_names: { patients: 'patients.csv', measurements: 'm.csv' } },
    config: {
      endpoint: 'pfs',
      decision_day: 56,
      look_ahead_day: 238,
      label_day: 56,
      save_models: false,
    },
    outcome: { endpoint: 'pfs', horizon: 238, task_is_mixed: false },
    log_lines: 12,
    predictions_ready: true,
  }
}

/** The generated `number | null[]` / `string | null[]` array-union artifact (DRIFT-1 ITEM-2 #3). */
function wireArray<T>(values: Array<T | null>): T | null[] {
  return values as unknown as T | null[]
}

function methodColumn(
  methodId: string,
  index: number,
): TxrPredictionsResponse['methods'][number] {
  const dynamic = index !== 1
  return {
    method_id: methodId,
    label: methodId,
    group: dynamic ? 'dynamic-risk' : 'static-risk',
    group_label: dynamic ? 'Dynamic risk' : 'Static risk',
    task: 'pfs',
    prob_source: 'native',
    coverage: { scored: PATIENT_COUNT, eligible: PATIENT_COUNT + 160, fraction: 0.9 },
    probabilities: wireArray<number>(
      PATIENTS.map((_, p) => Math.min(0.99, 0.1 + ((index * 7 + p * 3) % 80) / 100)),
    ),
    notes: wireArray<string>(PATIENTS.map(() => null)),
  }
}

function predictionsOf(runId: string, ids: string[]): TxrPredictionsResponse {
  return {
    run_id: runId,
    endpoint: 'pfs',
    horizon: 238,
    patients: [...PATIENTS],
    methods: ids.map((id, index) => methodColumn(id, index)),
    average: wireArray<number>(PATIENTS.map((_, p) => 0.3 + ((p * 13) % 50) / 100)),
    generated_at: '2026-11-06T00:08:00Z',
  }
}

const twoColumns = () => predictionsOf('run-1', FINISHED_IDS)
// The grown twin: the running method finished (the `prediction` frame is its
// announcement) — the engine's predictions response then carries its column.
const threeColumns = () => predictionsOf('run-1', [...FINISHED_IDS, RUNNING_ID])

/** The stream mock: captures the typed SSE handlers, stays pending until resolved. */
let sseHandlers: Record<string, (data: unknown) => void> | null = null

function emit(event: string, data: unknown): void {
  sseHandlers?.[event]?.(data)
}

function httpError(status: number, message = 'error'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

beforeEach(() => {
  api.getRun.mockReset()
  api.getPredictions.mockReset()
  api.streamRun.mockReset()
  api.listRunLogs.mockReset()
  api.downloadPredictions.mockReset()
  sseHandlers = null
  api.getRun.mockResolvedValue(runFixture())
  api.getPredictions.mockResolvedValue(twoColumns())
  api.downloadPredictions.mockResolvedValue('patient_id,lm-cox-a,rsf-b\nS0001,0.30,0.49\n')
  api.streamRun.mockImplementation(
    (_params: unknown, callbacks?: { SSE?: Record<string, (data: unknown) => void> }) => {
      sseHandlers = callbacks?.SSE ?? null
      return new Promise<void>(() => {})
    },
  )
  api.listRunLogs.mockResolvedValue({ lines: [], next_seq: 0, total: 0 })
  state().reset()
})

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="test-location">{location.pathname}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/analysis/run-1/results']}>
      <Routes>
        <Route path="/analysis/:runId/results" element={<ResultsPage />} />
        <Route path="/" element={<div data-testid="test-home" />} />
        <Route path="/history" element={<div data-testid="test-history" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** The loaded G screen: header + banner + controls + heatmap + footer. */
async function renderLoaded() {
  const view = renderPage()
  await waitFor(() => {
    expect(view.getByTestId('txr-results-header')).toBeTruthy()
  })
  return view
}

describe('ResultsPage (TEST-UR-6 — store wiring, states, actions)', () => {
  it('loads the run through the store: detail, then predictions, then the stream', async () => {
    renderPage()
    await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.getPredictions).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.streamRun).toHaveBeenCalledTimes(1))
    expect(api.getRun.mock.invocationCallOrder[0]).toBeLessThan(
      api.getPredictions.mock.invocationCallOrder[0],
    )
    expect(api.getPredictions.mock.invocationCallOrder[0]).toBeLessThan(
      api.streamRun.mock.invocationCallOrder[0],
    )
    expect(api.getRun).toHaveBeenCalledWith({ id: 'run-1' })
    expect(api.getPredictions).toHaveBeenCalledWith({ id: 'run-1' })
    expect(api.streamRun).toHaveBeenCalledWith({ id: 'run-1' }, expect.objectContaining({ SSE: expect.any(Object) }))
  })

  it('renders the loading skeleton until the detail resolves (no header, no table)', async () => {
    let resolveRun: (value: TxrRunDetail) => void = () => {}
    api.getRun.mockImplementation(
      () => new Promise<TxrRunDetail>(resolve => { resolveRun = resolve }),
    )
    const view = renderPage()
    expect(view.getByTestId('txr-results-loading')).toBeTruthy()
    expect(view.queryByTestId('txr-results-header')).toBeNull()
    expect(view.queryByTestId('txr-heatmap')).toBeNull()
    await act(async () => {
      resolveRun(runFixture())
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(view.getByTestId('txr-results-header')).toBeTruthy())
  })

  it('renders the loaded G screen: title, subtitle counts, tabs, bar, heatmap, footer', async () => {
    const view = await renderLoaded()
    const header = view.getByTestId('txr-results-header')
    expect(header.textContent).toContain(`Predictions for ${PATIENT_COUNT} patients`)
    expect(header.textContent).toContain(`${FINISHED_IDS.length} of ${FINISHED_IDS.length + 2} methods finished`)
    expect(header.textContent).toContain('decision day 56')
    expect(view.getByTestId('txr-results-outcome').textContent).toContain(
      'Progression or death by day 238',
    )
    expect(view.getByTestId('txr-results-search')).toBeTruthy()
    expect(view.getByTestId('txr-results-sort')).toBeTruthy()
    expect(view.getByTestId('txr-results-methods')).toBeTruthy()
    expect(view.getByTestId('txr-results-legend').textContent).toContain('0 to 100%')
    for (const id of FINISHED_IDS) {
      expect(view.getByTestId(`txr-heatmap-header-${id}`)).toBeTruthy()
    }
    // The 100-row default window: "Showing 100 of 120 patients" + Show all 120.
    // (The footer is the table PACKAGE's sibling, not the scroll box — the
    // sentence is asserted on the render container.)
    expect(view.getByTestId('txr-heatmap').textContent).toBeTruthy()
    expect(view.container.textContent).toContain(`Showing 100 of ${PATIENT_COUNT} patients`)
    expect(view.getByTestId('txr-heatmap-show-more').textContent).toBe(
      `Show all ${PATIENT_COUNT}`,
    )
  })

  it('renders the 409 empty-heatmap state: banner + counts + disabled download, no spinner loop', async () => {
    api.getPredictions.mockRejectedValueOnce(httpError(409))
    const view = await renderLoaded()
    await waitFor(() => {
      expect(view.getByTestId('txr-results-cannot-cox-nomarker')).toBeTruthy()
      expect(view.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(true)
    })
    expect(view.getByTestId('txr-results-subtitle').textContent).toContain(
      `${FINISHED_IDS.length} of ${FINISHED_IDS.length + 2} methods finished`,
    )
    expect(view.queryByTestId('txr-heatmap')).toBeNull()
    expect(view.queryByTestId('txr-results-loading')).toBeNull()
    expect(view.queryByTestId('txr-results-error')).toBeNull()
    expect(view.queryByTestId('txr-results-outcome')).toBeNull()
    expect(view.queryByTestId('txr-results-search')).toBeNull()
  })

  it('renders the honest failure state for a terminal failed run (TEST-QF-1, RES-02): engine reasons, no silent blank', async () => {
    const run = runFixture()
    run.status = 'failed'
    run.methods = run.methods.map(m => ({
      ...m,
      state: 'failed' as const,
      reason: {
        code: 'ENV_UNREADY',
        detail: 'the method environment is not installed on this computer',
      },
    }))
    run.counts = { ...run.counts, finished: 0, failed: run.methods.length, running: 0, cannot_run: 0 }
    api.getRun.mockResolvedValue(run)
    api.getPredictions.mockRejectedValueOnce(httpError(409))
    const view = await renderLoaded()
    await waitFor(() => expect(view.getByTestId('txr-results-run-failed')).toBeTruthy())
    const block = view.getByTestId('txr-results-run-failed')
    expect(block.textContent).toContain('This run failed')
    // The reason is the engine's own detail verbatim (INV-2), per row.
    expect(block.textContent).toContain(
      'the method environment is not installed on this computer',
    )
    expect(view.getByTestId('txr-results-run-failed-lm-cox-a')).toBeTruthy()
    // The failed row's log action opens that method's dialog.
    fireEvent.click(view.getByTestId('txr-results-failed-show-log-lm-cox-a'))
    expect(state().logDialogFor).toBe('lm-cox-a')
    // The header's STATUS is now the K vocabulary (ITEM-2 (a)): the counts
    // segment ("0 of 4 methods finished") is replaced by the honest
    // "Failed"; the decision day stays, the completed-run segments are
    // dropped (nothing was learned, the elapsed reads like a finished
    // run's fact next to a failure).
    const subtitle = view.getByTestId('txr-results-subtitle').textContent ?? ''
    expect(subtitle).toContain('Failed')
    expect(subtitle).not.toContain('methods finished')
    expect(subtitle).toContain('decision day 56')
    expect(subtitle).not.toContain('learned from')
    expect(subtitle).not.toContain('took')
    // The download stays disabled and no spinner loop starts.
    expect(view.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(true)
    expect(view.queryByTestId('txr-results-loading')).toBeNull()
    expect(view.queryByTestId('txr-results-error')).toBeNull()
  })

  it('renders the stopped-run state with the same honesty (RES-02, the stopped half) and lists the SKIPPED methods too (ITEM-2 (d) — never "4 of 6")', async () => {
    const run = runFixture()
    run.status = 'stopped'
    run.methods = [
      ...run.methods.map(m => ({
        ...m,
        state: 'stopped' as const,
      })),
      methodRow('skip-a', 'skipped'),
      methodRow('skip-b', 'skipped'),
    ]
    run.counts = { ...run.counts, finished: 0, stopped: 4, skipped: 2, running: 0, cannot_run: 0 }
    api.getRun.mockResolvedValue(run)
    api.getPredictions.mockRejectedValueOnce(httpError(409))
    const view = await renderLoaded()
    await waitFor(() => expect(view.getByTestId('txr-results-run-failed')).toBeTruthy())
    const block = view.getByTestId('txr-results-run-failed')
    expect(block.textContent).toContain('This run was stopped')
    expect(block.textContent).toContain('see the log for the reason')
    // The 2 skipped methods are listed next to the 4 stopped ones (the
    // round-3 "4 of 6" defect: they were missing).
    expect(view.getByTestId('txr-results-run-failed-skip-a')).toBeTruthy()
    expect(view.getByTestId('txr-results-run-failed-skip-b')).toBeTruthy()
    expect(view.getByTestId('txr-results-run-failed-lm-cox-a')).toBeTruthy()
    // The header leads with the K vocabulary's stop word (ITEM-2 (a)).
    const subtitle = view.getByTestId('txr-results-subtitle').textContent ?? ''
    expect(subtitle).toContain('Stopped by you')
  })

  it('a run with NO finished method never requests predictions (ITEM-2 (d): the two 409 console errors of R3-methods-10 are gone)', async () => {
    const run = runFixture()
    run.status = 'stopped'
    run.methods = run.methods.map(m => ({ ...m, state: 'stopped' as const }))
    run.counts = { ...run.counts, finished: 0, stopped: run.methods.length, running: 0, cannot_run: 0 }
    api.getRun.mockResolvedValue(run)
    api.getPredictions.mockReset()
    api.getPredictions.mockRejectedValue(new Error('must not be called'))
    const view = await renderLoaded()
    await waitFor(() => expect(view.getByTestId('txr-results-run-failed')).toBeTruthy())
    expect(api.getPredictions).not.toHaveBeenCalled()
    // The CSV button is disabled exactly when nothing is downloadable.
    expect(view.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(true)
  })


  it('presents a FINISHED run with nothing finished as the failure state (qa-fixes2 R2-02 — the engine status is "finished", the methods all failed)', async () => {
    const run = runFixture()
    run.status = 'finished'
    run.methods = run.methods.map(m => ({
      ...m,
      state: 'failed' as const,
      reason: { code: 'ENV_UNREADY', detail: 'oras is not installed' },
    }))
    run.counts = { ...run.counts, finished: 0, failed: run.methods.length, running: 0, cannot_run: 0 }
    api.getRun.mockResolvedValue(run)
    api.getPredictions.mockRejectedValueOnce(httpError(409))
    const view = await renderLoaded()
    await waitFor(() => expect(view.getByTestId('txr-results-run-failed')).toBeTruthy())
    const block = view.getByTestId('txr-results-run-failed')
    expect(block.textContent).toContain('This run failed')
    expect(block.textContent).toContain('oras is not installed')
    // The failure state's way out (RES-02's "no link to History").
    fireEvent.click(view.getByTestId('txr-results-failed-show-history'))
    await waitFor(() => expect(view.getByTestId('test-history')).toBeTruthy())
  })
  it('renders the not-found state on 404 and its New analysis CTA navigates home', async () => {
    api.getRun.mockRejectedValueOnce(httpError(404))
    const view = renderPage()
    await waitFor(() => expect(view.getByTestId('txr-results-not-found')).toBeTruthy())
    expect(view.queryByTestId('txr-results-error')).toBeNull()
    expect(view.queryByTestId('txr-results-loading')).toBeNull()
    fireEvent.click(view.getByTestId('txr-results-new-analysis'))
    await waitFor(() => {
      expect(view.getByTestId('test-home')).toBeTruthy()
    })
    expect(view.getByTestId('test-location').textContent).toBe('/')
  })

  // ITEM-6 (R3-results-8): a MALFORMED run id answers 400 — the page shows
  // the run-not-found state (and its title), never the server advice.
  it('renders the not-found state and title for a malformed id (400)', async () => {
    api.getRun.mockRejectedValueOnce(httpError(400))
    const view = renderPage()
    await waitFor(() => expect(view.getByTestId('txr-results-not-found')).toBeTruthy())
    expect(view.queryByTestId('txr-results-error')).toBeNull()
    expect(view.getByTestId('txr-results-not-found').textContent).toContain(
      'This analysis run could not be found',
    )
    expect(document.title).toBe('Run not found — TxResBench')
  })

  it('renders the error state on a detail network failure and retry re-runs load', async () => {
    api.getRun.mockRejectedValueOnce(new Error('server unreachable'))
    const view = renderPage()
    await waitFor(() => expect(view.getByTestId('txr-results-error')).toBeTruthy())
    expect(view.getByTestId('txr-results-error').textContent).toContain("Couldn't load the run")
    expect(view.queryByTestId('txr-heatmap')).toBeNull()
    // The mock now succeeds — the retry must produce the real screen.
    fireEvent.click(view.getByTestId('txr-results-error-retry'))
    await waitFor(() => expect(view.getByTestId('txr-results-header')).toBeTruthy())
    expect(api.getRun).toHaveBeenCalledTimes(2)
  })

  it('renders the error state when the predictions fetch fails without a snapshot, retry recovers', async () => {
    api.getPredictions.mockRejectedValueOnce(new Error('server unreachable'))
    const view = renderPage()
    await waitFor(() => expect(view.getByTestId('txr-results-error')).toBeTruthy())
    fireEvent.click(view.getByTestId('txr-results-error-retry'))
    await waitFor(() => expect(view.getByTestId('txr-heatmap')).toBeTruthy())
    expect(api.getRun).toHaveBeenCalledTimes(2)
  })

  it('keeps the last snapshot rendered when a refresh fails mid-stream (INV-1)', async () => {
    const view = await renderLoaded()
    expect(view.queryByTestId('txr-results-error')).toBeNull()
    // A `prediction` frame triggers a refresh that fails: the old columns stay.
    api.getPredictions.mockRejectedValueOnce(new Error('server unreachable'))
    await act(async () => {
      emit('prediction', { method_id: RUNNING_ID })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(view.getByTestId('txr-heatmap-header-lm-cox-a')).toBeTruthy())
    expect(view.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(false)
    expect(view.queryByTestId(`txr-heatmap-header-${RUNNING_ID}`)).toBeNull()
  })

  it('grows the column set live on a `prediction` frame (INV-1: no reload)', async () => {
    const view = await renderLoaded()
    expect(view.queryByTestId(`txr-heatmap-header-${RUNNING_ID}`)).toBeNull()
    api.getPredictions.mockResolvedValue(threeColumns())
    await act(async () => {
      emit('prediction', { method_id: RUNNING_ID })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(view.getByTestId(`txr-heatmap-header-${RUNNING_ID}`)).toBeTruthy())
    // The header's finished count follows the frame (the store derives the
    // counts from the patched rows — never a detail refetch).
    expect(view.getByTestId('txr-results-subtitle').textContent).toContain(
      `3 of 4 methods finished`,
    )
    expect(api.streamRun).toHaveBeenCalledTimes(1)
  })

  it('turns the prediction frame into columns without a terminal run (download stays enabled)', async () => {
    const view = await renderLoaded()
    expect(view.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(false)
    api.getPredictions.mockResolvedValueOnce(threeColumns())
    await act(async () => {
      emit('prediction', { method_id: RUNNING_ID })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(view.getByTestId(`txr-heatmap-header-${RUNNING_ID}`)).toBeTruthy())
  })

  it('renders one banner per cannot-run method with the engine reason and wire its log action', async () => {
    const view = await renderLoaded()
    const banner = view.getByTestId('txr-results-cannot-cox-nomarker')
    expect(banner.textContent).toContain('cox-nomarker')
    expect(banner.textContent).toContain('LDH is not in your measurements')
    // ITEM-2 (b): the tail's "other N" is the TRUE finished count (2 of the
    // 4 methods here), never the false "total minus one".
    expect(banner.textContent).toContain('The other 2 methods are shown.')
    fireEvent.click(view.getByTestId('txr-results-show-log-cox-nomarker'))
    expect(state().logDialogFor).toBe('cox-nomarker')
  })

  it('a finished run with 3 of 5 failed: ONE summary card with the true tail, the K-vocabulary header, predictions still shown (R3-results-3)', async () => {
    const run = runFixture()
    run.status = 'finished'
    run.methods = [
      methodRow('fin-a', 'finished'),
      methodRow('fin-b', 'finished'),
      ...Array.from({ length: 3 }, (_, i) =>
        methodRow(`bundled-${i}`, 'failed', {
          reason: {
            code: 'BUNDLE_MARKER_COUNT_UNMET',
            detail: 'the method needs a different number of markers than the file has',
          },
        }),
      ),
    ]
    run.counts = { ...run.counts, finished: 2, failed: 3, running: 0, cannot_run: 0 }
    api.getRun.mockResolvedValue(run)
    api.getPredictions.mockResolvedValue(predictionsOf('run-1', ['fin-a', 'fin-b']))
    const view = await renderLoaded()
    await waitFor(() => expect(view.getByTestId('txr-results-trouble-summary-failed-BUNDLE_MARKER_COUNT_UNMET')).toBeTruthy())
    const card = view.getByTestId('txr-results-trouble-summary-failed-BUNDLE_MARKER_COUNT_UNMET')
    expect(card.textContent).toContain('3 methods failed: the method needs a different number of markers than the file has.')
    expect(card.textContent).toContain('The other 2 methods are shown.')
    // The header speaks the K vocabulary (ITEM-2 (a)).
    expect(view.getByTestId('txr-results-subtitle').textContent).toContain(
      'Done, 3 of 5 methods failed',
    )
    // The finished methods' columns are still shown.
    expect(view.getByTestId('txr-heatmap-header-fin-a')).toBeTruthy()
    expect(view.queryByTestId('txr-results-error')).toBeNull()
  })

  it('wires the search to the store and narrows the patient rows', async () => {
    const view = await renderLoaded()
    fireEvent.change(view.getByTestId('txr-results-search'), { target: { value: 'S01' } })
    expect(state().search).toBe('S01')
    await waitFor(() => {
      expect(view.getByTestId('txr-heatmap-row-S0100')).toBeTruthy()
      expect(view.queryByTestId('txr-heatmap-row-S0001')).toBeNull()
    })
  })

  it('wires the sort select to the store (patient order = id asc)', async () => {
    const view = await renderLoaded()
    await act(async () => {
      fireEvent.change(view.getByTestId('txr-results-search'), { target: { value: 'S' } })
      await Promise.resolve()
    })
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-results-sort"]')!
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const patient = document.querySelector<HTMLElement>('[data-testid="txr-results-sort-opt-patient"]')!
    await act(async () => {
      fireEvent.pointerDown(patient, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(patient, { button: 0 })
      fireEvent.click(patient)
      await Promise.resolve()
    })
    expect(state().sort).toBe('patient')
  })

  it('wires the methods picker to the store and narrows the columns', async () => {
    const view = await renderLoaded()
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-results-methods"]')!
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const option = document.querySelector<HTMLElement>(
      '[data-testid="txr-results-methods-opt-dynamic-risk"]',
    )
    expect(option).toBeTruthy()
    await act(async () => {
      fireEvent.pointerDown(option!, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(option!, { button: 0 })
      fireEvent.click(option!)
      await Promise.resolve()
    })
    expect(state().methodFilter).toEqual({ groups: ['dynamic-risk'], methodIds: [] })
    await waitFor(() => {
      expect(view.getByTestId('txr-heatmap-header-lm-cox-a')).toBeTruthy()
      expect(view.queryByTestId('txr-heatmap-header-rsf-b')).toBeNull()
    })
  })

  it('raises the row cap on "Show all M" and keeps the windowing bounded', async () => {
    const view = await renderLoaded()
    fireEvent.click(view.getByTestId('txr-heatmap-show-more'))
    expect(state().patientLimit).toBe(-1)
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        `Showing ${PATIENT_COUNT} of ${PATIENT_COUNT} patients`,
      )
    })
    expect(view.queryByTestId('txr-heatmap-show-more')).toBeNull()
  })

  it('downloads the predictions CSV through the generated client and saves the file locally', async () => {
    const view = await renderLoaded()
    const createObjectURL = vi.fn(() => 'blob:txr-test')
    const revokeObjectURL = vi.fn()
    const clickSpy = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      value: clickSpy,
      writable: true,
      configurable: true,
    })
    const createElement = vi.spyOn(document, 'createElement')
    fireEvent.click(view.getByTestId('txr-results-download'))
    await waitFor(() => expect(api.downloadPredictions).toHaveBeenCalledWith({ id: 'run-1' }))
    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    // The saved anchor carries the module's filename convention (the Blob is
    // the CSV text; the object URL is revoked after the click). The anchor is
    // created, clicked and removed synchronously — captured via the
    // createElement spy, as the txrintake download test does.
    const anchor = createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement
    expect(anchor.download).toBe('predictions-run-1.csv')
    expect(anchor.href).toBe('blob:txr-test')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:txr-test')
    createElement.mockRestore()
  })

  it('surfaces a download failure inline — never a silent no-op', async () => {
    const view = await renderLoaded()
    api.downloadPredictions.mockRejectedValueOnce(httpError(404))
    fireEvent.click(view.getByTestId('txr-results-download'))
    await waitFor(() => expect(view.getByTestId('txr-results-download-error')).toBeTruthy())
    expect(view.queryByTestId('txr-results-error')).toBeNull()
  })

  it('hides the save-models button for a run with no produced models (save_models: false)', async () => {
    const view = await renderLoaded()
    expect(view.queryByTestId('txr-results-save-models')).toBeNull()
  })

  it('shows the save-models button for a run with produced models and emits the event on click', async () => {
    const run = runFixture()
    const finished = run.methods.filter(m => m.state === 'finished')
    run.models = finished.map((m, i) => ({
      method_id: m.method_id,
      method_version: '1.0.0',
      model_out_digest: `digest-${i}`,
      tree_sha256: `tree-${i}`,
      dir: `~/.txresbench/${m.method_id}`,
      env: { base_digest: 'b', layer_digest: 'l' },
      size_bytes: 1024,
      trained_on_patients: 42,
    }))
    api.getRun.mockResolvedValue(run)
    const payloads: AppEvents['txr:save-models-requested'][] = []
    const off = useEventBusStore
      .getState()
      .on('txr:save-models-requested', e => void payloads.push(e))
    try {
      const view = await renderLoaded()
      expect(view.getByTestId('txr-results-save-models').textContent).toBe(
        `Save the models (${finished.length})`,
      )
      fireEvent.click(view.getByTestId('txr-results-save-models'))
      await waitFor(() => expect(payloads).toHaveLength(1))
      expect(payloads[0]).toEqual({
        type: 'txr:save-models-requested',
        runId: 'run-1',
        methodIds: finished.map(m => m.method_id),
        timestamp: expect.any(Number),
      })
    } finally {
      off()
    }
  })

  it('navigates home on the header New analysis action', async () => {
    const view = await renderLoaded()
    fireEvent.click(view.getByTestId('txr-results-new-analysis'))
    await waitFor(() => expect(view.getByTestId('test-home')).toBeTruthy())
    expect(view.getByTestId('test-location').textContent).toBe('/')
  })

  it('exposes the PROV-UR-5 test-id surface of the G screen', async () => {
    const view = await renderLoaded()
    const ids = [
      'txr-results',
      'txr-results-header',
      'txr-results-subtitle',
      'txr-results-download',
      'txr-results-new-analysis',
      'txr-results-cannot-cox-nomarker',
      'txr-results-show-log-cox-nomarker',
      'txr-results-outcome',
      'txr-results-search',
      'txr-results-sort',
      'txr-results-methods',
      'txr-results-legend',
      'txr-heatmap',
      'txr-heatmap-show-more',
    ]
    for (const id of ids) {
      expect(view.getByTestId(id)).toBeTruthy()
    }
  })
})
