// @vitest-environment jsdom
/**
 * TEST-RUN-23 (ITEM-9 rows) — the F page base (`pages/RunningPage.tsx`):
 * the page reads the run id from the URL param and calls the run store's
 * `load` once per id (a changed id re-loads — the store resets first, no
 * cross-run bleed), renders the header facts composed from the run's own
 * rows (INV-4 — the title count, the time-left/elapsed line, the
 * concurrency line, DEC-12's See-results readiness), the per-state counter
 * strip
 * from `TxrRunDetail.counts`, the tab chips (the page-owned filter state
 * through the run store, counts from the module's bucket partition, DEC-2)
 * and the not-found / network states (kit `Result` + the History link,
 * retry on network). The ITEM-10 rows (the per-method table's tab-filtered
 * row set, the row-action wiring, Stop all's confirmation, the at-a-time
 * lane pick) and the ITEM-11 page rows (log panel wiring, the
 * leave-and-continue note) grow this same file.
 *
 * The only mocked boundary is `ApiClient.Txr` (the store's own logic runs
 * for real); the stream mock stays pending like the store suite's — the
 * page never needs a frame to render the snapshot. Every fixture value is
 * synthetic (non-board counts, small figures) — INV-6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { TxrRunDetail, TxrRunMethod } from '@/api-client/types'
import { methodResultsPath, resultsPath } from '@/modules/txrresults/routes'
import { historyPath } from '../routes'

const getRun = vi.fn()
const streamRun = vi.fn()
const listRunLogs = vi.fn()
const stopRun = vi.fn()
const stopMethod = vi.fn()
const skipMethod = vi.fn()
const setAtATime = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getRun: (...a: unknown[]) => getRun(...a),
      streamRun: (...a: unknown[]) => streamRun(...a),
      listRunLogs: (...a: unknown[]) => listRunLogs(...a),
      stopRun: (...a: unknown[]) => stopRun(...a),
      stopMethod: (...a: unknown[]) => stopMethod(...a),
      skipMethod: (...a: unknown[]) => skipMethod(...a),
      setAtATime: (...a: unknown[]) => setAtATime(...a),
    },
  },
}))

const { useTxrRun } = await import('../stores/TxrRun.store')
const { RunningPage } = await import('./RunningPage')
const state = () => useTxrRun.getState()

// jsdom has no working PointerEvent constructor; base-ui controls (the kit
// Select that the log panel's filter uses) construct one on pointer
// interaction (the settings-block test's shim, copied).
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

/** The stream call's SSE handlers, captured by the mock for frame emission
 *  (the store's own contract — the page test drives the frames the real
 *  stream would replay). */
let sseHandlers: Record<string, (data: unknown) => void> | undefined

/** Emit one stream frame into the store (the store test's emit idiom). */
function emit(event: string, data: unknown): void {
  const handler = sseHandlers?.[event]
  if (handler === undefined) throw new Error(`no stream handler for ${event}`)
  handler(data)
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (synthetic — INV-6)
// ─────────────────────────────────────────────────────────────────────────────

const RUNNING = 'method-1'
const WAITING = 'method-2'
const DOWNLOADING = 'method-3'
const FINISHED = 'method-4'
const FAILED = 'method-5'
const CANNOT = 'method-6'

function methodRow(
  id: string,
  state: TxrRunMethod['state'],
  over: Partial<TxrRunMethod> = {},
): TxrRunMethod {
  return {
    method_id: id,
    label: id,
    group: 'dynamic_risk',
    group_label: 'Dynamic risk',
    version: '1.0.0',
    state,
    bytes_downloaded: 0,
    ...(state === 'finished' ? { phase: 'done' as const } : {}),
    ...over,
  }
}

/** One run with six rows across the non-empty engine states (synthetic). */
function runDetail(runId = 'run-1'): TxrRunDetail {
  const methods = [
    methodRow(RUNNING, 'running', { phase: 'fit', elapsed_secs: 20 }),
    methodRow(WAITING, 'waiting'),
    methodRow(DOWNLOADING, 'downloading', {
      phase: 'env',
      bytes_total: 1048576,
      bytes_downloaded: 655360,
    }),
    methodRow(FINISHED, 'finished', { elapsed_secs: 90, duration_ms: 112000 }),
    methodRow(FAILED, 'failed', {
      reason: { code: 'JOB_TIMEOUT', detail: 'the method hit the run limit' },
    }),
    methodRow(CANNOT, 'cannot_run', {
      reason: { code: 'NEEDS_MARKER', detail: 'needs LDH, not in your file' },
    }),
  ]
  return {
    id: runId,
    status: 'running',
    mode: 'train',
    created_at: '2026-11-06T00:00:00Z',
    started_at: '2026-11-06T00:00:40Z',
    finished_at: undefined,
    elapsed_secs: 100,
    config: { endpoint: 'pfs', decision_day: 56, look_ahead_day: 238, at_a_time: 3, cpus: 4 },
    counts: {
      finished: 1,
      failed: 1,
      stopped: 0,
      skipped: 0,
      cannot_run: 1,
      running: 1,
      downloading: 1,
      waiting: 1,
    },
    predictions_ready: false,
    dir: '/data/txresbench/analysis-2026-11-06-0000-run-1',
    input_summary: {
      patients: 20,
      predict_patients: 20,
      markers: 3,
      events: 2,
      file_names: { patients: 'patients.csv', measurements: 'measurements.csv' },
    },
    method_ids: methods.map(m => m.method_id),
    model_ids: [],
    log_lines: 4,
    cpus: 4,
    estimate: { schedule_seconds: 240, estimate_quality: 'estimate', total_seconds: 200 },
    outcome: { endpoint: 'pfs', horizon: 238, task_is_mixed: false },
    methods,
    models: [],
  }
}

let router: ReturnType<typeof createMemoryRouter>

function renderAt(runId: string) {
  router = createMemoryRouter(
    [{ path: '/analysis/:runId/running', element: <RunningPage /> }],
    { initialEntries: [`/analysis/${runId}/running`] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  getRun.mockReset()
  streamRun.mockReset()
  listRunLogs.mockReset()
  stopRun.mockReset()
  stopMethod.mockReset()
  skipMethod.mockReset()
  setAtATime.mockReset()
  sseHandlers = undefined
  // The F page's one-second elapsed tick (RP-2): fake timers make the clock
  // deterministic; `shouldAdvanceTime` keeps the real-async helpers
  // (`findByTestId`, waitFor) progressing. qa-fixes4 ITEM-3
  // (R3-methods-3): the LIVE elapsed reads the run's `started_at` against
  // this clock, so `now` is pinned 100 s after the fixture's run start
  // (00:00:40Z) — the header reads "1 min 40 s elapsed" at load, exactly
  // the engine's snapshot figure the fixture carries.
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-11-06T00:02:20Z') })
  listRunLogs.mockResolvedValue({ lines: [], next_seq: 0, total: 0 })
  stopRun.mockResolvedValue(undefined)
  stopMethod.mockResolvedValue(undefined)
  skipMethod.mockResolvedValue(undefined)
  setAtATime.mockResolvedValue({ id: 'run-1', status: 'running' })
  getRun.mockResolvedValue(runDetail())
  streamRun.mockImplementation((_request: unknown, cfg: { SSE?: Record<string, (data: unknown) => void> }) => {
    sseHandlers = cfg.SSE
    return new Promise<void>(() => {})
  })
  state().reset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// Load + composition
// ─────────────────────────────────────────────────────────────────────────────

describe('RunningPage — the run id and the header facts (TEST-RUN-23)', () => {
  it('loads the URL\'s run id once and renders the header from the run\'s rows', async () => {
    renderAt('run-1')
    const title = await screen.findByTestId('txr-run-title')
    expect(getRun).toHaveBeenCalledTimes(1)
    expect(getRun).toHaveBeenCalledWith({ id: 'run-1' })
    // The title count is the run's own row count (six fixture rows).
    expect(title.textContent).toBe('Running 6 methods')
    expect(state().runError).toBeNull()
    expect(state().run?.id).toBe('run-1')
  })

  it('re-loads when the run id changes (the store resets; no cross-run bleed)', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-title')
    expect(getRun).toHaveBeenCalledTimes(1)

    // A mid-view filter state must not survive into the next run's view.
    fireEvent.click(screen.getByTestId('txr-run-tab-working'))
    expect(state().tab).toBe('working')

    await router.navigate('/analysis/run-2/running')
    // The store's load fires from the page's effect (the run-id change); the
    // navigate settles before the effect's commit, so wait for the load.
    await vi.waitFor(() => expect(state().runId).toBe('run-2'))
    expect(getRun).toHaveBeenCalledTimes(2)
    expect(getRun).toHaveBeenLastCalledWith({ id: 'run-2' })
    // The new run's view starts at the default tab (store reset on load).
    expect(state().tab).toBe('all')
  })

  it('renders the time-left/elapsed line, the concurrency line and the See-results link from the run\'s facts', async () => {
    renderAt('run-1')
    // schedule 240 s − elapsed 100 s → 140 s → about 2 minutes left. The
    // live clock ticks every real second, so the elapsed can drift by a
    // second or two on a slow host — the assertion reads the run's own
    // snapshot figures within the live tick's tolerance.
    const line = (await screen.findByTestId('txr-run-time-line')).textContent ?? ''
    expect(line).toMatch(/^about 2 minutes left · 1 min 4\d s elapsed · rough estimate$/)
    expect(screen.getByTestId('txr-run-concurrency').textContent).toBe(
      '3 run at a time on 4 CPUs',
    )
    // One finished row → results readable while the others still run (INV-1).
    const see = screen.getByTestId('txr-run-see-results')
    expect(see.getAttribute('href')).toBe(resultsPath('run-1'))
    expect(screen.getByTestId('txr-run-notice').textContent).toContain('For research.')
  })

  it('ticks the elapsed from the run\'s own snapshot and counts the time-left down (RP-2)', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-time-line')
    // Live: 100 s at the pinned clock + 5 s of page time → ≥ 1 min 45 s
    // elapsed, and the time-left is the estimate minus that live elapsed
    // (it moved off the frozen "1 min 40 s").
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    await vi.waitFor(() => {
      const text = screen.getByTestId('txr-run-time-line').textContent ?? ''
      const match = text.match(/^about 2 minutes left · (\d+) min (\d+) s elapsed · rough estimate$/)
      expect(match).not.toBeNull()
      expect(Number(match![1]) * 60 + Number(match![2])).toBeGreaterThanOrEqual(105)
    })
  })

  it('reads the header elapsed from started_at, not the load-time snapshot (qa-fixes4 ITEM-3, methods-r3 R3-methods-3)', async () => {
    // The round-3 defect: the header lagged the real clock — the snapshot's
    // elapsed at load drove a one-second counter that drifts when timers are
    // delayed ("21 s elapsed" at t=28.7 of a 30 s run). A STALE snapshot on
    // the wire must not freeze the header either: the clock is pinned 100 s
    // after the run's started_at, so the header reads 1 min 40 s even
    // though the snapshot (a frame that arrived 50 s ago) says 50.
    const detail = runDetail('run-1')
    detail.elapsed_secs = 50
    getRun.mockResolvedValue(detail)
    renderAt('run-1')
    const line = await screen.findByTestId('txr-run-time-line')
    expect(line.textContent).toBe('about 2 minutes left · 1 min 40 s elapsed · rough estimate')
    // The rows read the same wall clock: the run started 100 s ago, so the
    // header and the row's time read the same seconds (both wall-clock).
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('txr-run-time-line').textContent).toBe(
        'about 2 minutes left · 1 min 50 s elapsed · rough estimate',
      )
    })
  })

  it('renders the per-state counter strip — every engine state counted (RP-3)', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-counts')
    expect(screen.getByTestId('txr-run-counts').textContent).toBe(
      '1 finished1 running1 downloading1 waiting1 failed0 stopped0 skipped1 cannot run',
    )
    expect(screen.getByTestId('txr-run-counts-stopped').textContent).toBe('0 stopped')
    expect(screen.getByTestId('txr-run-counts-cannot_run').textContent).toBe('1 cannot run')
  })

  it('hides the See-results link when no method finished and no predictions are ready', async () => {
    const detail = runDetail('run-1')
    detail.methods = detail.methods.filter(
      m => m.state !== 'finished' && m.state !== 'failed' && m.state !== 'cannot_run',
    )
    detail.predictions_ready = false
    getRun.mockResolvedValue(detail)
    renderAt('run-1')
    await screen.findByTestId('txr-run-title')
    expect(screen.queryByTestId('txr-run-see-results')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Tab state (the page-owned filter state — DEC-2)
// ─────────────────────────────────────────────────────────────────────────────

describe('RunningPage — the F tabs (ITEM-9, RP-3)', () => {
  it('renders one chip per bucket with the bucket counts over the run\'s rows', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-tabs')
    expect(screen.getByTestId('txr-run-tab-all').textContent).toBe('All 6')
    expect(screen.getByTestId('txr-run-tab-working').textContent).toBe('Working 3')
    expect(screen.getByTestId('txr-run-tab-finished').textContent).toBe('Finished 1')
    expect(screen.getByTestId('txr-run-tab-failed').textContent).toBe('Failed 1')
    expect(screen.getByTestId('txr-run-tab-stopped').textContent).toBe('Stopped 0')
    expect(screen.getByTestId('txr-run-tab-skipped').textContent).toBe('Skipped 0')
    expect(screen.getByTestId('txr-run-tab-cannot_run').textContent).toBe('Cannot run 1')
  })

  it("a state is never counted under another state's tab: failed and cannot run are separate chips", async () => {
    const detail = runDetail('run-1')
    detail.methods = [
      methodRow('method-f', 'failed', { reason: { code: 'JOB_TIMEOUT', detail: 'x' } }),
      methodRow('method-c', 'cannot_run', { reason: { code: 'ENV_UNKNOWN', detail: 'y' } }),
      methodRow('method-s', 'skipped'),
      methodRow('method-t', 'stopped'),
    ]
    detail.counts = {
      finished: 0,
      failed: 1,
      stopped: 1,
      skipped: 1,
      cannot_run: 1,
      running: 0,
      downloading: 0,
      waiting: 0,
    }
    getRun.mockResolvedValue(detail)
    renderAt('run-1')
    await screen.findByTestId('txr-run-tabs')
    expect(screen.getByTestId('txr-run-tab-finished').textContent).toBe('Finished 0')
    expect(screen.getByTestId('txr-run-tab-failed').textContent).toBe('Failed 1')
    expect(screen.getByTestId('txr-run-tab-cannot_run').textContent).toBe('Cannot run 1')
    expect(screen.getByTestId('txr-run-tab-skipped').textContent).toBe('Skipped 1')
    expect(screen.getByTestId('txr-run-tab-stopped').textContent).toBe('Stopped 1')
    expect(screen.getByTestId('txr-run-tab-all').textContent).toBe('All 4')
    // The rows land on their own buckets' tabs.
    fireEvent.click(screen.getByTestId('txr-run-tab-failed'))
    expect(screen.getByTestId('txr-run-row-method-f')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-row-method-c')).toBeNull()
    fireEvent.click(screen.getByTestId('txr-run-tab-cannot_run'))
    expect(screen.getByTestId('txr-run-row-method-c')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-row-method-f')).toBeNull()
    fireEvent.click(screen.getByTestId('txr-run-tab-skipped'))
    expect(screen.getByTestId('txr-run-row-method-s')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-row-method-t')).toBeNull()
  })

  it('starts at All and moves the active chip with the store\'s tab (one toggle per click)', async () => {
    renderAt('run-1')
    const all = await screen.findByTestId('txr-run-tab-all')
    expect(all.getAttribute('aria-pressed')).toBe('true')
    expect(state().tab).toBe('all')

    fireEvent.click(screen.getByTestId('txr-run-tab-working'))
    expect(state().tab).toBe('working')
    expect(screen.getByTestId('txr-run-tab-working').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('txr-run-tab-all').getAttribute('aria-pressed')).toBe('false')
  })

  it('the Working chip\'s definition is on screen even before the tab is active (qa-fixes4 ITEM-3, methods-r3 RP-10)', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-tabs')
    // The report's chip read "Working 6 / 0" with no hint; the definition
    // now sits beside the chip always (the old render was active-tab-only).
    expect(screen.getByTestId('txr-run-tab-working-definition').textContent).toBe(
      'Waiting, downloading or running',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The not-found / network states
// ─────────────────────────────────────────────────────────────────────────────

describe('RunningPage — the run states (TEST-RUN-23)', () => {
  it('renders the not-found state with a History link and never crashes the store', async () => {
    getRun.mockRejectedValue(Object.assign(new Error('HTTP error! status: 404'), { status: 404 }))
    renderAt('missing')
    await screen.findByTestId('txr-run-not-found')
    expect(state().runError).toBe('not-found')
    expect(state().streaming).toBe(false)
    expect(streamRun).not.toHaveBeenCalled()
    // qa-fixes4 ITEM-2 (e): the proper not-found page — the plan's words,
    // the History way out, and the plan's document title.
    expect(screen.getByTestId('txr-run-not-found').textContent).toContain(
      'We could not find this run',
    )
    expect(document.title).toBe('Run not found — TxResBench')
    const history = screen.getByTestId('txr-run-history').getAttribute('href')
    expect(history).toBe(historyPath())
  })

  it('ITEM-2 (e): a malformed run id (the server\'s 400) is the not-found page, never the network error', async () => {
    getRun.mockRejectedValue(Object.assign(new Error('HTTP error! status: 400'), { status: 400 }))
    renderAt('does-not-exist')
    await screen.findByTestId('txr-run-not-found')
    expect(state().runError).toBe('not-found')
    expect(screen.queryByTestId('txr-run-load-error')).toBeNull()
    expect(screen.queryByTestId('txr-run-retry')).toBeNull()
    expect(document.title).toBe('Run not found — TxResBench')
  })

  it('renders the network error state with a retry that re-loads the run', async () => {
    getRun.mockRejectedValue(new Error('connection refused'))
    renderAt('run-1')
    await screen.findByTestId('txr-run-load-error')
    expect(state().runError).toBe('network')

    getRun.mockResolvedValue(runDetail())
    fireEvent.click(screen.getByTestId('txr-run-retry'))
    await screen.findByTestId('txr-run-title')
    expect(getRun).toHaveBeenCalledTimes(2)
    expect(state().runError).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RP-1 — the terminal run: land on results (live transition), terminal title
// ─────────────────────────────────────────────────────────────────────────────

describe('RunningPage — the terminal run (qa-fixes ITEM-3 RP-1)', () => {
  it('lands on the results screen when the run turns terminal while the page watches it', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-title')
    expect(router.state.location.pathname).toBe('/analysis/run-1/running')

    // The engine's terminal status frame arrives on the stream.
    act(() => emit('status', { status: 'finished' }))
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(resultsPath('run-1')),
    )
  })

  it('a page opened directly at a terminal run renders the terminal snapshot — no redirect, the run\'s own title (RP-1)', async () => {
    const detail = runDetail('run-1')
    detail.status = 'finished'
    detail.predictions_ready = true
    getRun.mockResolvedValue(detail)
    renderAt('run-1')
    const title = await screen.findByTestId('txr-run-title')
    // qa-fixes2 R2-1: the terminal title counts what finished (1 of the 6
    // fixture rows) — never "Finished 6 methods" with 5 rows still working.
    expect(title.textContent).toBe('Finished 1 of 6 methods')
    expect(state().run?.status).toBe('finished')
    // The page did NOT navigate away (a direct load of a terminal run is
    // the terminal snapshot's own surface; the leave-and-continue note is a
    // live-run statement and is dropped).
    expect(router.state.location.pathname).toBe('/analysis/run-1/running')
    expect(screen.queryByTestId('txr-run-leave-note')).toBeNull()
    // qa-fixes4 ITEM-2 (d, R3-methods-4): a finished run's screen shows
    // NO run controls — the disabled Stop all and the lane pick are gone
    // (they were re-exposed by the app-shell move of Stop all to the
    // bottom bar).
    expect(screen.queryByTestId('txr-run-stop-all')).toBeNull()
    expect(screen.queryByTestId('txr-run-at-a-time-control')).toBeNull()
    // R2-1/R2-2: a terminal run's time line reads the elapsed it TOOK — no
    // stale "about N minutes left", and the estimate's honesty word rides
    // the end (the fixture's estimate is the rough kind).
    expect(screen.getByTestId('txr-run-time-line').textContent).toBe(
      'took 1 min 40 s · rough estimate',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-10 — the per-method table, the row actions, Stop all, the lane pick
// ─────────────────────────────────────────────────────────────────────────────

describe('RunningPage — the method table and its actions (ITEM-10)', () => {
  it("feeds the table the active tab's rows (the page's bucket filter, DEC-2)", async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')
    expect(screen.getByTestId('txr-run-row-method-1')).toBeTruthy()
    expect(screen.getByTestId('txr-run-row-method-6')).toBeTruthy()

    fireEvent.click(screen.getByTestId('txr-run-tab-working'))
    expect(screen.getByTestId('txr-run-row-method-1')).toBeTruthy()
    expect(screen.getByTestId('txr-run-row-method-3')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-row-method-4')).toBeNull()
    expect(screen.queryByTestId('txr-run-row-method-6')).toBeNull()

    // The partition keeps each state's own tab (RP-3): Failed holds the
    // failed row only, the cannot-run row is the Cannot run tab's.
    fireEvent.click(screen.getByTestId('txr-run-tab-failed'))
    expect(screen.getByTestId('txr-run-row-method-5')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-row-method-6')).toBeNull()

    fireEvent.click(screen.getByTestId('txr-run-tab-cannot_run'))
    expect(screen.getByTestId('txr-run-row-method-6')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-row-method-5')).toBeNull()
  })

  it('wires the row actions: Stop and Skip post the engine controls, Show log opens the panel at the method', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')

    fireEvent.click(screen.getByTestId('txr-run-action-method-1'))
    expect(stopMethod).toHaveBeenCalledWith({ id: 'run-1', method_id: 'method-1' })

    fireEvent.click(screen.getByTestId('txr-run-action-method-2'))
    expect(skipMethod).toHaveBeenCalledWith({ id: 'run-1', method_id: 'method-2' })

    fireEvent.click(screen.getByTestId('txr-run-action-method-5'))
    expect(state().logOpen).toBe(true)
    expect(state().logFilter).toBe('method-5')
  })

  it('navigates a finished row\'s View result to the method results builder', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')
    fireEvent.click(screen.getByTestId('txr-run-action-method-4'))
    expect(router.state.location.pathname).toBe(methodResultsPath('run-1', 'method-4'))
  })

  it('posts Stop all only after the confirmation (DEC-10), and nothing on cancel', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')

    fireEvent.click(screen.getByTestId('txr-run-stop-all'))
    const confirm = screen.getByTestId('txr-run-stop-all-confirm')
    expect(stopRun).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByText('Cancel'))
    expect(stopRun).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('txr-run-stop-all'))
    fireEvent.click(within(screen.getByTestId('txr-run-stop-all-confirm')).getByText('Stop all'))
    await vi.waitFor(() => expect(stopRun).toHaveBeenCalledTimes(1))
    expect(stopRun).toHaveBeenCalledWith({ id: 'run-1' })
  })

  it('wires the at-a-time row to the engine\'s lane route (the GAP call site)', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')
    const control = screen.getByTestId('txr-run-at-a-time-control')
    // The run's value 3 sits inside the 1–4 presets (RP-6) — the engine
    // default is always re-selectable.
    expect(within(control).getAllByRole('tab').map(b => b.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
    fireEvent.click(within(control).getAllByRole('tab')[1])
    await vi.waitFor(() =>
      expect(setAtATime).toHaveBeenCalledWith({ id: 'run-1', at_a_time: 2 }),
    )
    expect(state().atATime).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-11 — the log panel wiring + the leave-and-continue note
// ─────────────────────────────────────────────────────────────────────────────

describe('RunningPage — the log panel and leave-and-continue (ITEM-11)', () => {
  it('always renders the leave-and-continue note under the method table (a live run)', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')
    expect(screen.getByTestId('txr-run-leave-note').textContent).toBe(
      'Finished methods keep their results. You can leave this screen: the run continues, and it stays in History.',
    )
  })

  it('"Show the log" on the page opens the panel at All methods (RP-4d — a running row had no log affordance)', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')
    expect(screen.queryByTestId('txr-run-log')).toBeNull()

    fireEvent.click(screen.getByTestId('txr-run-log-open'))
    await screen.findByTestId('txr-run-log')
    expect(state().logOpen).toBe(true)
    expect(state().logFilter).toBeNull()
    expect(screen.getByTestId('txr-run-log-filter').textContent).toContain('All methods')
    // The button yields to the panel's Hide control while the panel is open.
    expect(screen.queryByTestId('txr-run-log-open')).toBeNull()
  })

  it('"Show log" opens the panel at that method and backfills its history', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')
    expect(screen.queryByTestId('txr-run-log')).toBeNull()

    fireEvent.click(screen.getByTestId('txr-run-action-method-5'))
    await screen.findByTestId('txr-run-log')
    expect(state().logOpen).toBe(true)
    expect(state().logFilter).toBe('method-5')
    // The board's select reads the method (its option is the selection).
    expect(screen.getByTestId('txr-run-log-filter').textContent).toContain('method-5')
    await vi.waitFor(() =>
      expect(listRunLogs).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-1', method_id: 'method-5' }),
      ),
    )
  })

  it('the panel\'s filter pick and Hide report through the store', async () => {
    renderAt('run-1')
    await screen.findByTestId('txr-run-table')
    fireEvent.click(screen.getByTestId('txr-run-action-method-5'))
    await screen.findByTestId('txr-run-log')

    // Pick "All methods" through the select (the board's filter control;
    // the kit select's pointer/click sequence, the panel test's idiom).
    const trigger = screen.getByTestId('txr-run-log-filter')
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const optionAll = await screen.findByTestId('txr-run-log-filter-opt-all')
    await act(async () => {
      fireEvent.pointerDown(optionAll, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(optionAll, { button: 0 })
      fireEvent.click(optionAll)
      await Promise.resolve()
    })
    expect(state().logFilter).toBeNull()

    fireEvent.click(screen.getByTestId('txr-run-log-close'))
    expect(state().logOpen).toBe(false)
    expect(screen.queryByTestId('txr-run-log')).toBeNull()
  })
})
