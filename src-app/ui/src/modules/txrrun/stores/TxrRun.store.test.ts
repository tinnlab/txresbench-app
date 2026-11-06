/**
 * TEST-RUN-10/11/12 — the run store (ITEM-5; PROV-UI-RUN-3, INV-1,
 * CONS-UI-RUN-9/11/16, DEC-1/2/3): `load(runId)` (detail first, then the
 * stream), the frame→state mapping over the generated `TxrRunEvent`
 * vocabulary (status / method / log / progress / prediction), the
 * terminal-snapshot rule + stop-live-frames latch, the `__init` dispose
 * latch (jobsHost idiom), the no-write-after-dispose epoch guard, cross-run
 * reset, `loadLogs` backfill/continuation, the stop/skip/stop-all controls
 * (409s become row-level errors, never a crash), and the setAtATime GAP
 * call site (typed error + restore of the run's value).
 *
 * The only boundaries mocked are `ApiClient.Txr.*` — the store's own logic
 * (generation epoch, row patching, counts derivation, log merging, the
 * reason record) runs for real on the real store-kit. The mock stream
 * exposes the captured SSE handlers so each test plays a FRAME SCRIPT (the
 * fixture's `emit`/`<frame>` pairs) and keeps its promise pending until a
 * test resolves it, so `streaming` stays observable mid-stream.
 *
 * Every fixture value is synthetic (method ids `method-1..`, patient keys
 * `P0001..`, non-board counts) — the boards' facts are design examples,
 * never data (INV-6).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TxrRunDetail,
  TxrRunLogLine,
  TxrRunMethod,
  TxrRunMethodFrame,
  TxrRunStatusFrame,
  TxrRunSummary,
} from '@/api-client/types'

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

const { useTxrRun, AT_A_TIME_ERROR_LINE, LIVE_LOGS_CAP, LOGS_FETCH_LIMIT } = await import(
  './TxrRun.store'
)
const state = () => useTxrRun.getState()

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (all synthetic — INV-6)
// ─────────────────────────────────────────────────────────────────────────────

const RUNNING = 'method-1'
const WAITING = 'method-2'
const DOWNLOADING = 'method-3'
const FINISHED = 'method-4'
const FAILED = 'method-5'
const CANNOT = 'method-6'
const STOPPED = 'method-7'
const SKIPPED = 'method-8'

function methodRow(
  id: string,
  state: TxrRunMethod['state'],
  over?: Partial<TxrRunMethod>,
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

/** One run with one row per state (the F screen's eight-state set, synthetic). */
function runDetail(runId = 'run-1'): TxrRunDetail {
  const methods = [
    methodRow(RUNNING, 'running', { phase: 'fit', elapsed_secs: 12 }),
    methodRow(WAITING, 'waiting'),
    methodRow(DOWNLOADING, 'downloading', { phase: 'env', bytes_total: 1048576 }),
    methodRow(FINISHED, 'finished', { elapsed_secs: 90 }),
    methodRow(FAILED, 'failed', { reason: { code: 'JOB_TIMEOUT', detail: 'the method hit the run limit' } }),
    methodRow(CANNOT, 'cannot_run', { reason: { code: 'NEEDS_MARKER', detail: 'needs LDH, not in your file' } }),
    methodRow(STOPPED, 'stopped'),
    methodRow(SKIPPED, 'skipped'),
  ]
  return {
    id: runId,
    status: 'running',
    mode: 'train',
    created_at: '2026-11-05T00:00:00Z',
    started_at: '2026-11-05T00:01:00Z',
    finished_at: undefined,
    elapsed_secs: 680,
    config: { endpoint: 'pfs', decision_day: 56, look_ahead_day: 238, at_a_time: 3, cpus: 4 },
    counts: {
      finished: 1,
      failed: 1,
      stopped: 1,
      skipped: 1,
      cannot_run: 1,
      running: 1,
      downloading: 1,
      waiting: 1,
    },
    predictions_ready: false,
    dir: '/data/txresbench/analysis-2026-11-05-0000-run-1',
    input_summary: {
      patients: 38,
      predict_patients: 38,
      markers: 3,
      events: 2,
      file_names: { patients: 'patients.csv', measurements: 'measurements.csv' },
    },
    method_ids: methods.map(m => m.method_id),
    model_ids: [],
    log_lines: 40,
    cpus: 4,
    outcome: { endpoint: 'pfs', horizon: 238, task_is_mixed: false },
    methods,
    models: [],
  }
}

function logLine(seq: number, content = `line ${seq}`): TxrRunLogLine {
  return { seq, stream: 'engine', content, created_at: '2026-11-05T00:05:00Z' }
}

/** The stream mock: captures the typed SSE handlers, stays pending until resolved. */
let sseHandlers: Record<string, (data: unknown) => void> | null = null
let resolveStream: (() => void) | null = null

function emit(event: string, data: unknown): void {
  sseHandlers?.[event]?.(data)
}

function emitInit(): AbortController {
  const controller = new AbortController()
  emit('__init', { abortController: controller })
  return controller
}

beforeEach(() => {
  getRun.mockReset()
  streamRun.mockReset()
  listRunLogs.mockReset()
  stopRun.mockReset()
  stopMethod.mockReset()
  skipMethod.mockReset()
  setAtATime.mockReset()
  sseHandlers = null
  resolveStream = null
  getRun.mockResolvedValue(runDetail())
  streamRun.mockImplementation(
    (_params: unknown, callbacks?: { SSE?: Record<string, (data: unknown) => void> }) => {
      sseHandlers = callbacks?.SSE ?? null
      return new Promise<void>(resolve => {
        resolveStream = resolve
      })
    },
  )
  state().reset()
})

/** A fully loaded run-1 (detail + a connected stream, generated facts synthetic). */
async function loadedRun(id = 'run-1', detail = runDetail(id)) {
  getRun.mockResolvedValue(detail)
  await state().load(id)
  emitInit()
  return state()
}

// ─────────────────────────────────────────────────────────────────────────────
// `load(runId)` — order, error classification, reset-on-load
// ─────────────────────────────────────────────────────────────────────────────

describe('load(runId) (PROV-UI-RUN-3; TEST-RUN-10)', () => {
  it('GETs the run detail, THEN opens the stream (the pinned order), and starts streaming', async () => {
    const callOrder: string[] = []
    getRun.mockImplementation(() => {
      callOrder.push('getRun')
      return Promise.resolve(runDetail())
    })
    streamRun.mockImplementation(() => {
      callOrder.push('streamRun')
      return new Promise<void>(() => {})
    })
    await state().load('run-1')
    expect(getRun).toHaveBeenCalledWith({ id: 'run-1' })
    expect(callOrder).toEqual(['getRun', 'streamRun'])
    expect(streamRun).toHaveBeenCalledWith(
      { id: 'run-1' },
      expect.objectContaining({ SSE: expect.any(Object) }),
    )
    expect(state().run?.id).toBe('run-1')
    expect(state().runError).toBeNull()
    expect(state().loading).toBe(false)
    expect(state().atATime).toBe(3)
    expect(state().logTotal).toBe(40)
    expect(state().streaming).toBe(true)
  })

  it('seeds perMethod from the detail (a cannot_run row keeps its reason, never blank)', async () => {
    await loadedRun()
    expect(state().perMethod[CANNOT]?.lastReason).toEqual({
      code: 'NEEDS_MARKER',
      detail: 'needs LDH, not in your file',
    })
    expect(state().perMethod[CANNOT]?.progress).toBeNull()
    expect(state().perMethod[FINISHED]?.lastReason).toBeNull()
  })

  it('classifies a 404 as not-found and never opens the stream', async () => {
    getRun.mockRejectedValue(Object.assign(new Error('HTTP error! status: 404'), { status: 404 }))
    await state().load('missing')
    expect(state().runError).toBe('not-found')
    expect(state().streaming).toBe(false)
    expect(streamRun).not.toHaveBeenCalled()
  })

  it('classifies a non-404 failure as network, still no stream, and retryLoad re-runs it', async () => {
    getRun.mockRejectedValue(new Error('connection refused'))
    await state().load('run-1')
    expect(state().runError).toBe('network')
    expect(state().loading).toBe(false)
    expect(streamRun).not.toHaveBeenCalled()
    getRun.mockResolvedValue(runDetail())
    state().retryLoad()
    await vi.waitFor(() => expect(state().runError).toBeNull())
    expect(getRun).toHaveBeenCalledTimes(2)
    expect(streamRun).toHaveBeenCalled()
  })

  it('resets the whole state when a different run id loads (no cross-run bleed)', async () => {
    await loadedRun()
    state().setTab('failed')
    state().setLogOpen(true)
    emit('log', logLine(1))
    expect(state().liveLogs).toHaveLength(1)

    // The second load's reset is synchronous at load entry: while the new
    // detail is in flight, no run-1 fact survives.
    getRun.mockReturnValue(new Promise<TxrRunDetail>(() => {}))
    void state().load('run-2')
    expect(state().runId).toBe('run-2')
    expect(state().run).toBeNull()
    expect(state().liveLogs).toEqual([])
    expect(state().tab).toBe('all')
    expect(state().logOpen).toBe(false)
    expect(state().atATime).toBeNull()
    expect(state().streaming).toBe(false)
  })

  it('never writes state after a reset (the onCleanup teardown mid-flight)', async () => {
    let resolveRun!: (run: TxrRunDetail) => void
    getRun.mockReturnValue(new Promise<TxrRunDetail>(resolve => { resolveRun = resolve }))
    const loading = state().load('run-1')
    state().reset()
    resolveRun(runDetail())
    await loading
    expect(state().run).toBeNull()
    expect(state().runId).toBeNull()
    expect(state().runError).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Frame → state mapping — the generated `TxrRunEvent` vocabulary (PROV-EE-4)
// ─────────────────────────────────────────────────────────────────────────────

describe('frame → state mapping (TEST-RUN-10; INV-1)', () => {
  it('a method frame patches the row (state/phase/bytes/elapsed) and recomputes the counts', async () => {
    const s = await loadedRun()
    const frame: TxrRunMethodFrame = {
      method_id: WAITING,
      state: 'downloading',
      phase: 'env',
      bytes_downloaded: 1234,
      bytes_total: 998877,
      elapsed_secs: 5,
      reason_code: undefined,
    }
    emit('method', frame)
    const patched = state().run?.methods.find(m => m.method_id === WAITING)
    expect(patched?.state).toBe('downloading')
    expect(patched?.phase).toBe('env')
    expect(patched?.bytes_downloaded).toBe(1234)
    expect(patched?.bytes_total).toBe(998877)
    expect(getRun).toHaveBeenCalledTimes(1)
    // Counts come from the rows, never from a frame fact.
    expect(state().run?.counts.downloading).toBe(2)
    expect(state().run?.counts.waiting).toBe(0)
  })

  it('keeps the known reason detail for the same code and never invents one for a new code', async () => {
    await loadedRun()
    emit('method', { method_id: FAILED, state: 'failed', reason_code: 'JOB_TIMEOUT' })
    expect(state().perMethod[FAILED]?.lastReason).toEqual({
      code: 'JOB_TIMEOUT',
      detail: 'the method hit the run limit',
    })
    emit('method', { method_id: FAILED, state: 'failed', reason_code: 'ENV_VERIFY_FAILED' })
    expect(state().perMethod[FAILED]?.lastReason).toEqual({
      code: 'ENV_VERIFY_FAILED',
      detail: '',
    })
  })

  it('ignores a frame whose state/phase are not in the run vocabulary (defensive, regen-proof)', async () => {
    await loadedRun()
    emit('method', { method_id: WAITING, state: 'teleporting', phase: 'warp', bytes_downloaded: 0 })
    expect(state().run?.methods.find(m => m.method_id === WAITING)?.state).toBe('waiting')
  })

  it('a progress frame fills perMethod[method_id] (the running detail line + the bar facts)', async () => {
    await loadedRun()
    emit('progress', { method_id: RUNNING, phase: 'fit', pct: 42, message: 'fitting on 38 patients' })
    expect(state().perMethod[RUNNING]?.progress).toEqual({
      method_id: RUNNING,
      phase: 'fit',
      pct: 42,
      message: 'fitting on 38 patients',
    })
    expect(RUNNING in state().perMethod).toBe(true)
  })

  it('log frames append de-duped by seq and capped at the last 200', async () => {
    await loadedRun()
    for (let seq = 1; seq <= LIVE_LOGS_CAP + 5; seq++) emit('log', logLine(seq))
    expect(state().liveLogs).toHaveLength(LIVE_LOGS_CAP)
    expect(state().liveLogs[0].seq).toBe(6)
    emit('log', logLine(100))
    expect(state().liveLogs.filter(l => l.seq === 100)).toHaveLength(1)
  })

  it('a prediction frame sets predictions_ready, marks the row finished and recomputes counts', async () => {
    const s = await loadedRun()
    expect(state().run?.predictions_ready).toBe(false)
    emit('prediction', { method_id: RUNNING, prob_source: 'native', coverage_fraction: 1, scored: 38, eligible: 38 })
    const states = state().run
    expect(states?.predictions_ready).toBe(true)
    expect(states?.methods.find(m => m.method_id === RUNNING)?.state).toBe('finished')
    expect(states?.counts.finished).toBe(2)
    expect(states?.counts.running).toBe(0)
  })

  it('a status frame patches run.status (the frame carries only the status) without a refetch', async () => {
    const s = await loadedRun()
    const detailCalls = getRun.mock.calls.length
    emit('status', { status: 'finishing' } satisfies TxrRunStatusFrame)
    expect(state().run?.status).toBe('finishing')
    expect(getRun).toHaveBeenCalledTimes(detailCalls)
  })

  it('a terminal status frame keeps the last snapshot, stops live frames and flags streaming off', async () => {
    const s = await loadedRun()
    emit('status', { status: 'finished' } satisfies TxrRunStatusFrame)
    expect(state().streaming).toBe(false)
    expect(state().run?.status).toBe('finished')
    expect(state().run?.methods).toHaveLength(8)
    // Live frames are latched after the terminal frame.
    emit('method', { method_id: WAITING, state: 'running', bytes_downloaded: 0 })
    emit('log', logLine(999))
    await new Promise(r => setTimeout(r, 0))
    expect(state().run?.methods.find(m => m.method_id === WAITING)?.state).toBe('waiting')
    expect(state().liveLogs).toHaveLength(0)
  })

  it('disconnect aborts the stream and drops the streaming flag', async () => {
    await loadedRun()
    state().disconnectStream()
    expect(state().streaming).toBe(false)
  })

  it('the stream close (server-side) clears streaming via the settle guard', async () => {
    await loadedRun()
    expect(state().streaming).toBe(true)
    resolveStream?.()
    await vi.waitFor(() => expect(state().streaming).toBe(false))
  })

  it('the __init latch aborts a stream whose dispose landed before the controller (jobsHost idiom)', async () => {
    // The framework emits `__init` only after its internal fetch resolves; a
    // dispose before that must latch and abort on arrival.
    await state().load('run-1')
    expect(state().streaming).toBe(true)
    state().disconnectStream()
    const controller = emitInit()
    expect(controller.signal.aborted).toBe(true)
    expect(state().streaming).toBe(false)
  })

  it('a late dispose aborts the latched controller immediately', async () => {
    await state().load('run-1')
    const controller = emitInit()
    state().disconnectStream()
    expect(controller.signal.aborted).toBe(true)
  })

  it('connecting again after a disconnect re-opens the stream (the leave-and-return path)', async () => {
    await loadedRun()
    state().disconnectStream()
    state().connectStream()
    expect(streamRun).toHaveBeenCalledTimes(2)
    expect(state().streaming).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `loadLogs` — the after_seq backfill/continuation (CONS-UI-RUN-10)
// ─────────────────────────────────────────────────────────────────────────────

describe('loadLogs (PROV-UI-RUN-3; TEST-RUN-11)', () => {
  it('fetches with method_id + after_seq + a named page limit, merges the lines and records the total', async () => {
    await loadedRun()
    listRunLogs.mockResolvedValue({ lines: [logLine(3), logLine(4)], next_seq: 5, total: 90 })
    const fetched = await state().loadLogs('method-5', 2)
    expect(listRunLogs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1', method_id: 'method-5', after_seq: 2, limit: LOGS_FETCH_LIMIT }),
    )
    expect(fetched).toHaveLength(2)
    expect(state().liveLogs.map(l => l.seq)).toEqual([3, 4])
    expect(state().logTotal).toBe(90)
  })

  it('omits method_id for the whole-run backfill (null) and merges with SSE lines de-duped', async () => {
    await loadedRun()
    emit('log', logLine(2))
    listRunLogs.mockResolvedValue({ lines: [logLine(1), logLine(2)], next_seq: 3, total: 2 })
    await state().loadLogs(null)
    const params = listRunLogs.mock.calls[0][0] as Parameters<typeof listRunLogs>[0]
    expect(params.method_id).toBeUndefined()
    expect(state().liveLogs.map(l => l.seq)).toEqual([1, 2])
  })

  it('a log fetch failure leaves the current lines (the panel is a live tail, never a blocking load)', async () => {
    await loadedRun()
    listRunLogs.mockRejectedValue(new Error('boom'))
    await expect(state().loadLogs(null)).resolves.toEqual([])
    expect(state().liveLogs).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The controls — stop / skip / stop-all (PROV-EE-6) and the at-a-time GAP
// ─────────────────────────────────────────────────────────────────────────────

describe('stop / skip / stop-all (TEST-RUN-11)', () => {
  it('stopMethod and skipMethod post their endpoints exactly once per invocation', async () => {
    await loadedRun()
    stopMethod.mockResolvedValue(undefined)
    skipMethod.mockResolvedValue(undefined)
    await state().stopMethod(RUNNING)
    await state().skipMethod(WAITING)
    expect(stopMethod).toHaveBeenCalledTimes(1)
    expect(stopMethod).toHaveBeenCalledWith({ id: 'run-1', method_id: RUNNING })
    expect(skipMethod).toHaveBeenCalledTimes(1)
    expect(skipMethod).toHaveBeenCalledWith({ id: 'run-1', method_id: WAITING })
  })

  it('a 409 METHOD_NOT_ACTIVE is a row-level error: the row keeps its state, never a crash', async () => {
    await loadedRun()
    stopMethod.mockRejectedValue(Object.assign(new Error('HTTP error! status: 409'), { status: 409 }))
    await state().stopMethod(RUNNING)
    expect(state().rowErrors[RUNNING]).toContain('409')
    expect(state().run?.methods.find(m => m.method_id === RUNNING)?.state).toBe('running')
    expect(state().runError).toBeNull()
  })

  it('a 409 METHOD_NOT_SKIPPABLE is a row-level error and the error clears on the next attempt', async () => {
    await loadedRun()
    skipMethod.mockRejectedValue(Object.assign(new Error('HTTP error! status: 409'), { status: 409 }))
    await state().skipMethod(WAITING)
    expect(state().rowErrors[WAITING]).toContain('409')
    skipMethod.mockResolvedValue(undefined)
    await state().skipMethod(WAITING)
    expect(state().rowErrors[WAITING]).toBeUndefined()
  })

  it('stopAll posts Txr.stopRun exactly once per invocation and clears the action error', async () => {
    await loadedRun()
    stopRun.mockResolvedValue(undefined)
    await state().stopAll()
    await state().stopAll()
    expect(stopRun).toHaveBeenCalledTimes(2)
    expect(stopRun).toHaveBeenCalledWith({ id: 'run-1' })
    expect(state().actionError).toBeNull()
  })

  it('stopAll surfaces a failure as the run-level action error, never a silent no-op', async () => {
    await loadedRun()
    stopRun.mockRejectedValue(new Error('boom'))
    await state().stopAll()
    expect(state().actionError).toBe('boom')
    expect(state().stopping).toBe(false)
  })

  it('stopping is true while the stop-all call is in flight', async () => {
    await loadedRun()
    let resolveStop!: () => void
    stopRun.mockReturnValue(new Promise<void>(resolve => { resolveStop = resolve }))
    const stopping = state().stopAll()
    expect(state().stopping).toBe(true)
    resolveStop()
    await stopping
    expect(state().stopping).toBe(false)
  })
})

describe('setAtATime — the CONS-UI-RUN-11 GAP call site (TEST-RUN-12)', () => {
  it('posts the generated Txr.setAtATime with {at_a_time} and takes the response value', async () => {
    await loadedRun()
    const summary = { ...runDetail('run-1'), config: { ...runDetail('run-1').config, at_a_time: 2 } }
    setAtATime.mockResolvedValue(summary as TxrRunSummary)
    await state().setAtATime(2)
    expect(setAtATime).toHaveBeenCalledWith({ id: 'run-1', at_a_time: 2 })
    expect(state().atATime).toBe(2)
    expect(state().atATimeError).toBeNull()
  })

  it('a provider error sets atATimeError and restores the run\'s original value (never silent)', async () => {
    await loadedRun()
    setAtATime.mockRejectedValue(new Error('HTTP error! status: 400'))
    await state().setAtATime(2)
    expect(state().atATimeError).toBe(AT_A_TIME_ERROR_LINE)
    expect(state().atATime).toBe(3)
    expect(state().run?.config.at_a_time).toBe(3)
  })
})
