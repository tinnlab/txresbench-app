/**
 * TEST-UR-1 — the results store (ITEM-5; PROV-UR-2, DEC-3/18, INV-1):
 * `load(runId)` (reset-on-load; detail → predictions → stream order), the
 * frame→state mapping over the generated `TxrRunEvent` vocabulary (status /
 * method / log / progress / prediction), the `refreshPredictions` stale guard
 * (a delayed older response never overwrites a newer one), 409 →
 * `unavailable`, `loadLogs` after_seq backfill, the terminal-status final
 * refresh + stop-live-frames latch, cross-run reset and the no-write-after-
 * reset rule.
 *
 * The only boundaries mocked are `ApiClient.Txr.*` — the store's own logic
 * (generation epoch, seq guard, row patching, counts derivation, log
 * merging) runs for real, on the real store-kit. The mock streams expose the
 * captured SSE handlers so each test plays a FRAME SCRIPT (the fixture's
 * `emit`/<frame> pairs); `streamRun` keeps its promise pending until a test
 * resolves it, so `streaming` stays observable mid-stream.
 *
 * Every fixture value is synthetic (patient ids `S00xx`, method ids
 * `method-1..`, non-board numbers) — the boards' facts are never data
 * (INV-5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TxrPredictionsResponse,
  TxrRunDetail,
  TxrRunLogLine,
  TxrRunMethod,
  TxrRunMethodFrame,
  TxrRunStatusFrame,
} from '@/api-client/types'

const getRun = vi.fn()
const getPredictions = vi.fn()
const streamRun = vi.fn()
const listRunLogs = vi.fn()
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getRun: (...a: unknown[]) => getRun(...a),
      getPredictions: (...a: unknown[]) => getPredictions(...a),
      streamRun: (...a: unknown[]) => streamRun(...a),
      listRunLogs: (...a: unknown[]) => listRunLogs(...a),
      downloadPredictions: (...a: unknown[]) => vi.fn()(...a),
    },
  },
}))

const { useTxrResultsStore, LIVE_LOGS_CAP } = await import('./Results.store')
const state = () => useTxrResultsStore.getState()

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (all synthetic — INV-5)
// ─────────────────────────────────────────────────────────────────────────────

const FINISHED_METHODS = 11

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

/** One run with eleven finished methods and one running (the F/G header's live count). */
function runDetail(runId = 'run-1'): TxrRunDetail {
  const runningId = 'method-12'
  const ids = Array.from({ length: FINISHED_METHODS }, (_, i) => `method-${i + 1}`)
  return {
    id: runId,
    status: 'running',
    mode: 'train',
    created_at: '2026-11-05T00:00:00Z',
    started_at: '2026-11-05T00:01:00Z',
    finished_at: undefined,
    elapsed_secs: 680,
    config: { endpoint: 'pfs', decision_day: 56, look_ahead_day: 238 },
    counts: { finished: FINISHED_METHODS, failed: 0, stopped: 0, skipped: 0, cannot_run: 0, running: 1, downloading: 0, waiting: 0 },
    predictions_ready: true,
    dir: '/data/txresbench/analysis-2026-11-05-0000-run-1',
    input_summary: { patients: 38, predict_patients: 38, markers: 3, events: 2, file_names: { patients: 'patients.csv', measurements: 'measurements.csv' } },
    method_ids: [...ids, runningId],
    model_ids: [],
    log_lines: 40,
    cpus: 4,
    outcome: { endpoint: 'pfs', horizon: 238, task_is_mixed: false },
    methods: [
      ...ids.map(id => methodRow(id, 'finished', { elapsed_secs: 90 })),
      methodRow(runningId, 'running', { phase: 'predict', elapsed_secs: 12 }),
    ],
    models: [],
  }
}

/** The engine's `number | null[]` array-union artifact (DRIFT-1 ITEM-2 #3). */
function wireArray<T>(values: Array<T | null>): T | null[] {
  return values as unknown as T | null[]
}

function column(
  methodId: string,
  index: number,
  probabilities: Array<number | null>,
  notes: Array<string | null>,
): TxrPredictionsResponse['methods'][number] {
  return {
    method_id: methodId,
    label: methodId,
    group: 'dynamic_risk',
    group_label: 'Dynamic risk',
    task: 'pfs',
    prob_source: 'native',
    coverage: { scored: 38, eligible: 38, fraction: 1 },
    probabilities: wireArray<number>(probabilities),
    notes: wireArray<string>(notes),
  }
}

function predictions(
  runId: string,
  methods: TxrPredictionsResponse['methods'],
  patients: string[],
  average: Array<number | null>,
): TxrPredictionsResponse {
  return {
    run_id: runId,
    endpoint: 'pfs',
    horizon: 238,
    generated_at: '2026-11-05T00:10:00Z',
    patients,
    methods,
    average: wireArray<number>(average),
  }
}

const PATIENTS = ['S0001', 'S0002', 'S0003', 'S0004']

/** The eleven-finished-methods snapshot; `twelveColumns` is its 12-column grown twin. */
function elevenColumns(runId: string): TxrPredictionsResponse {
  return predictions(
    runId,
    Array.from({ length: FINISHED_METHODS }, (_, i) => column(`method-${i + 1}`, i, [0.9, 0.7, 0.55, 0.4], [null, null, null, null])),
    PATIENTS,
    [0.9, 0.7, 0.55, 0.4],
  )
}

/** The snapshot after the 12th method's `prediction` frame. */
function twelveColumns(runId: string): TxrPredictionsResponse {
  const base = elevenColumns(runId)
  return {
    ...base,
    methods: [...base.methods, column('method-12', 11, [0.8, 0.6, 0.5, 0.3], [null, null, null, null])],
    average: wireArray<number>([0.85, 0.65, 0.525, 0.35]),
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

function emitInit(): void {
  emit('__init', { abortController: new AbortController() })
}

beforeEach(() => {
  getRun.mockReset()
  getPredictions.mockReset()
  streamRun.mockReset()
  listRunLogs.mockReset()
  sseHandlers = null
  resolveStream = null
  getRun.mockResolvedValue(runDetail())
  getPredictions.mockResolvedValue(elevenColumns('run-1'))
  streamRun.mockImplementation((_params: unknown, callbacks?: { SSE?: Record<string, (data: unknown) => void> }) => {
    sseHandlers = callbacks?.SSE ?? null
    return new Promise<void>(resolve => {
      resolveStream = resolve
    })
  })
  state().reset()
})

/** A fully loaded run-1 (detail + predictions + a connected stream). */
async function loadedRun(id = 'run-1', detail = runDetail(id), cols = elevenColumns(id)) {
  getRun.mockResolvedValue(detail)
  getPredictions.mockResolvedValue(cols)
  await state().load(id)
  emitInit()
  return state()
}

// ─────────────────────────────────────────────────────────────────────────────
// `load(runId)` — order, reset-on-load, error classification
// ─────────────────────────────────────────────────────────────────────────────

describe('load(runId) (PROV-UR-2; DEC-3/18)', () => {
  it('loads detail, then predictions, then connects the stream (the pinned order)', async () => {
    await state().load('run-1')
    expect(getRun).toHaveBeenCalledWith({ id: 'run-1' })
    expect(getPredictions).toHaveBeenCalledWith({ id: 'run-1' })
    expect(streamRun).toHaveBeenCalledWith(
      { id: 'run-1' },
      expect.objectContaining({ SSE: expect.any(Object) }),
    )
    expect(state().run?.id).toBe('run-1')
    expect(state().predictions?.run_id).toBe('run-1')
    expect(state().runError).toBeNull()
    expect(state().predictionsError).toBeNull()
    expect(state().streaming).toBe(true)
  })

  it('sets the run endpoint key as the default outcome tab (DEC-4)', async () => {
    await state().load('run-1')
    expect(state().outcomeTab).toBe('pfs')
    getRun.mockResolvedValue({ ...runDetail('run-os'), outcome: { endpoint: 'os', horizon: 238, task_is_mixed: false } })
    await state().load('run-os')
    expect(state().outcomeTab).toBe('os')
  })

  it('classifies a 404 as not-found and never opens the stream (DEC-18)', async () => {
    getRun.mockRejectedValue(Object.assign(new Error('HTTP error! status: 404'), { status: 404 }))
    await state().load('missing')
    expect(state().runError).toBe('not-found')
    expect(state().streaming).toBe(false)
    expect(streamRun).not.toHaveBeenCalled()
    expect(getPredictions).not.toHaveBeenCalled()
  })

  it('classifies a non-404 failure as network (error + retry state), still no stream', async () => {
    getRun.mockRejectedValue(new Error('connection refused'))
    await state().load('run-1')
    expect(state().runError).toBe('network')
    expect(streamRun).not.toHaveBeenCalled()
  })

  it('maps a 409 predictions response to unavailable (the empty-heatmap state) and still streams', async () => {
    getPredictions.mockRejectedValue(Object.assign(new Error('HTTP error! status: 409'), { status: 409 }))
    await state().load('run-1')
    expect(state().predictionsError).toBe('unavailable')
    expect(state().predictions).toBeNull()
    expect(state().runError).toBeNull()
    expect(streamRun).toHaveBeenCalled()
  })

  it('resets the whole state when a different run id loads (no cross-run bleed)', async () => {
    await loadedRun('run-1')
    state().setSearch('S0001')
    state().setOutcomeTab('os')
    emit('log', logLine(1))
    expect(state().liveLogs).toHaveLength(1)

    // The second load's reset is synchronous at load entry: while the new
    // detail is in flight, no run-1 fact survives (not awaited — the detail
    // stays pending so the mid-load state is observable).
    getRun.mockReturnValue(new Promise<TxrRunDetail>(() => {}))
    void state().load('run-2')
    expect(state().runId).toBe('run-2')
    expect(state().run).toBeNull()
    expect(state().predictions).toBeNull()
    expect(state().liveLogs).toEqual([])
    expect(state().search).toBe('')
    expect(state().outcomeTab).toBe('pfs')
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
// Frame handling — the generated `TxrRunEvent` vocabulary (PROV-EE-4)
// ─────────────────────────────────────────────────────────────────────────────

describe('frame → state mapping (TEST-UR-1; INV-1)', () => {
  it('a prediction frame triggers one refreshPredictions and the new column lands', async () => {
    await loadedRun()
    getPredictions.mockResolvedValue(twelveColumns('run-1'))
    emit('prediction', { method_id: 'method-12', prob_source: 'native', coverage_fraction: 1, scored: 38, eligible: 38 })
    await vi.waitFor(() => {
      expect(state().predictions?.methods).toHaveLength(FINISHED_METHODS + 1)
    })
    expect(getPredictions).toHaveBeenCalledTimes(2)
    expect(state().predictions?.methods[FINISHED_METHODS].method_id).toBe('method-12')
    // INV-1: the frame also marks the row finished so the counts stay truthful
    // even when the method frame races the finished announcement.
    expect(state().run?.methods.find(m => m.method_id === 'method-12')?.state).toBe('finished')
    expect(state().run?.counts.finished).toBe(FINISHED_METHODS + 1)
    expect(state().run?.counts.running).toBe(0)
  })

  it('a stale predictions response never overwrites a newer one', async () => {
    await loadedRun()
    let resolveOld!: (p: TxrPredictionsResponse) => void
    let resolveNew!: (p: TxrPredictionsResponse) => void
    // The FIRST refresh (older) resolves AFTER the second (newer) — the seq guard.
    getPredictions
      .mockReturnValueOnce(new Promise<TxrPredictionsResponse>(resolve => { resolveOld = resolve }))
      .mockReturnValueOnce(new Promise<TxrPredictionsResponse>(resolve => { resolveNew = resolve }))
    const older = state().refreshPredictions()
    const newer = state().refreshPredictions()
    resolveNew(twelveColumns('run-1'))
    await newer
    resolveOld(elevenColumns('run-1'))
    await older
    expect(state().predictions?.methods).toHaveLength(FINISHED_METHODS + 1)
  })

  it('a status frame patches run.status without a detail refetch (and without counts from thin air)', async () => {
    await loadedRun()
    const detailCalls = getRun.mock.calls.length
    emit('status', { status: 'finishing' } satisfies TxrRunStatusFrame)
    expect(state().run?.status).toBe('finishing')
    expect(getRun).toHaveBeenCalledTimes(detailCalls)
    // The frame's ONLY field is status — counts stay the rows' derivation.
    expect(state().run?.counts.finished).toBe(FINISHED_METHODS)
  })

  it('a terminal status frame stops live frames and issues ONE final refreshPredictions', async () => {
    const s = await loadedRun()
    emit('prediction', { method_id: 'method-12', prob_source: 'native', coverage_fraction: 1, scored: 38, eligible: 38 })
    await vi.waitFor(() => expect(getPredictions.mock.calls.length).toBeGreaterThanOrEqual(2))
    const before = getPredictions.mock.calls.length
    emit('status', { status: 'finished' } satisfies TxrRunStatusFrame)
    await vi.waitFor(() => expect(state().streaming).toBe(false))
    expect(getPredictions.mock.calls.length).toBe(before + 1)
    // Live frames are latched: a replayed prediction frame starts no fetch.
    emit('prediction', { method_id: 'method-12', prob_source: 'native', coverage_fraction: 1, scored: 38, eligible: 38 })
    emit('log', logLine(999))
    await new Promise(r => setTimeout(r, 0))
    expect(getPredictions.mock.calls.length).toBe(before + 1)
    expect(state().liveLogs).toHaveLength(0)
  })

  it('a method frame patches the row (state/phase/bytes/elapsed) and recomputes the counts', async () => {
    const s = await loadedRun()
    const row = s.run?.methods.find(m => m.method_id === 'method-12')
    expect(row?.state).toBe('running')
    const frame: TxrRunMethodFrame = {
      method_id: 'method-12',
      state: 'downloading',
      phase: 'env',
      bytes_downloaded: 1234,
      bytes_total: 998877,
      elapsed_secs: 5,
      reason_code: undefined,
    }
    emit('method', frame)
    const patched = state().run?.methods.find(m => m.method_id === 'method-12')
    expect(patched?.state).toBe('downloading')
    expect(patched?.phase).toBe('env')
    expect(patched?.bytes_downloaded).toBe(1234)
    expect(patched?.bytes_total).toBe(998877)
    expect(patched?.elapsed_secs).toBe(5)
    expect(getRun).toHaveBeenCalledTimes(1)
  })

  it('a method frame with a reason code keeps the known detail and never invents one for a new code', async () => {
    const detail = runDetail()
    detail.methods = [
      ...detail.methods,
      methodRow('method-13', 'failed', { reason: { code: 'JOB_TIMEOUT', detail: 'the method hit the run limit' } }),
    ]
    detail.counts = { ...detail.counts, failed: 1 }
    const s = await loadedRun('run-1', detail)
    emit('method', { method_id: 'method-13', state: 'failed', reason_code: 'JOB_TIMEOUT' })
    expect(state().run?.methods.find(m => m.method_id === 'method-13')?.reason).toEqual({
      code: 'JOB_TIMEOUT',
      detail: 'the method hit the run limit',
    })
    emit('method', { method_id: 'method-13', state: 'failed', reason_code: 'ENV_VERIFY_FAILED' })
    // The detail for the new code is unknown — an empty shell, never invented
    // (the consumer's `formatReasonText` renders the readable fallback, DEC-15).
    expect(state().run?.methods.find(m => m.method_id === 'method-13')?.reason).toEqual({
      code: 'ENV_VERIFY_FAILED',
      detail: '',
    })
  })

  it('ignores a frame whose state/phase are not in the run vocabulary (defensive, regen-proof)', async () => {
    const s = await loadedRun()
    emit('method', { method_id: 'method-12', state: 'teleporting', phase: 'warp' })
    expect(state().run?.methods.find(m => m.method_id === 'method-12')?.state).toBe('running')
    expect(state().run?.methods.find(m => m.method_id === 'method-12')?.phase).toBe('predict')
  })

  it('a progress frame patches the method phase only (pct/message have no slot in PROV-UR-2)', async () => {
    const s = await loadedRun()
    emit('progress', { method_id: 'method-12', phase: 'fit', pct: 42, message: 'fitting model' })
    expect(state().run?.methods.find(m => m.method_id === 'method-12')?.phase).toBe('fit')
  })

  it('log frames append de-duped by seq and capped at the last 200', async () => {
    await loadedRun()
    for (let seq = 1; seq <= LIVE_LOGS_CAP + 5; seq++) emit('log', logLine(seq))
    expect(state().liveLogs).toHaveLength(LIVE_LOGS_CAP)
    expect(state().liveLogs[0].seq).toBe(6)
    expect(state().liveLogs[LIVE_LOGS_CAP - 1].seq).toBe(LIVE_LOGS_CAP + 5)
    emit('log', logLine(100))
    expect(state().liveLogs).toHaveLength(LIVE_LOGS_CAP)
    expect(state().liveLogs.filter(l => l.seq === 100)).toHaveLength(1)
  })

  it('disconnect aborts the stream and drops the streaming flag', async () => {
    await loadedRun()
    emitInit()
    state().disconnectStream()
    expect(state().streaming).toBe(false)
  })

  it('the stream close (server-side) clears streaming via the settle guard', async () => {
    await loadedRun()
    expect(state().streaming).toBe(true)
    resolveStream?.()
    await vi.waitFor(() => expect(state().streaming).toBe(false))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `loadLogs` — the after_seq backfill (CONS-UR-3; the dialog's pre-SSE history)
// ─────────────────────────────────────────────────────────────────────────────

describe('loadLogs (PROV-UR-2; CONS-UR-3)', () => {
  it('fetches with method_id + after_seq + a named page limit and merges the lines', async () => {
    await loadedRun()
    listRunLogs.mockResolvedValue({ lines: [logLine(3), logLine(4)], next_seq: 5, total: 4 })
    const fetched = await state().loadLogs('method-5', 2)
    expect(listRunLogs).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1', method_id: 'method-5', after_seq: 2, limit: 200 }))
    expect(fetched).toHaveLength(2)
    expect(state().liveLogs.map(l => l.seq)).toEqual([3, 4])
  })

  it('omits method_id for the whole-run dialog (null) and merges with SSE lines de-duped', async () => {
    await loadedRun()
    emit('log', logLine(2))
    listRunLogs.mockResolvedValue({ lines: [logLine(1), logLine(2)], next_seq: 3, total: 2 })
    await state().loadLogs(null)
    const params = listRunLogs.mock.calls[0][0] as Parameters<typeof listRunLogs>[0]
    expect(params.method_id).toBeUndefined()
    expect(state().liveLogs.map(l => l.seq)).toEqual([1, 2])
  })

  it('a log fetch failure leaves the current lines (the run-level error state governs)', async () => {
    await loadedRun()
    listRunLogs.mockRejectedValue(new Error('boom'))
    await expect(state().loadLogs(null)).resolves.toEqual([])
    expect(state().liveLogs).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The view-state controls (PROV-UR-2's setters — ITEM-6/7/9 consume them)
// ─────────────────────────────────────────────────────────────────────────────

describe('view-state setters (PROV-UR-2)', () => {
  it('setOutcomeTab / setMethodFilter / setSearch / setSort / setPatientLimit / setDivergentOnly store the values', async () => {
    await loadedRun()
    state().setOutcomeTab('response')
    state().setMethodFilter({ groups: ['dynamic_risk'], methodIds: ['method-1'] })
    state().setSearch('S0002')
    state().setSort('disagree')
    state().setPatientLimit(-1)
    state().setDivergentOnly(true)
    const s = state()
    expect(s.outcomeTab).toBe('response')
    expect(s.methodFilter).toEqual({ groups: ['dynamic_risk'], methodIds: ['method-1'] })
    expect(s.search).toBe('S0002')
    expect(s.sort).toBe('disagree')
    expect(s.patientLimit).toBe(-1)
    expect(s.divergentOnly).toBe(true)
    expect(s.methodFilter).not.toBeNull()
  })

  it('openLog holds the three dialog states: closed / whole-run / one method', () => {
    expect(state().logDialogFor).toBeUndefined()
    state().openLog(null)
    expect(state().logDialogFor).toBeNull()
    state().openLog('method-5')
    expect(state().logDialogFor).toBe('method-5')
    state().openLog()
    expect(state().logDialogFor).toBeUndefined()
  })

  it('openChanceDialog toggles the explainer dialog', () => {
    state().openChanceDialog(true)
    expect(state().chanceDialogOpen).toBe(true)
    state().openChanceDialog(false)
    expect(state().chanceDialogOpen).toBe(false)
  })
})
