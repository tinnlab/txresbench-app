/**
 * TEST-HIST-2 / TEST-HIST-3 / TEST-HIST-4 — the `TxrHistory` store
 * (ITEM-2; PROV-HIST-3, INV-1, INV-2, INV-3).
 *
 * Pinned behaviors:
 *
 * - the list is SERVER-paged: `loadFirstPage` is ONE `History.listHistory`
 *   call with `limit: PAGE_SIZE / offset: 0` + the active `q` / `kind` /
 *   `status`; `loadMore` continues at `offset = items.length` and APPENDS,
 *   never re-orders, never fetch-all (INV-1);
 * - the "Stopped or failed" filter is the grown ONE-CALL multi-value
 *   `status: 'stopped,failed'` (GAP-HIST-3 RESOLVED — the plan's two-call
 *   merge fallback was deleted at reconcile, CONS-HIST-6); a second merge
 *   call is a test failure;
 * - `setSearch` updates `searchInput` IMMEDIATELY and `q` after the 200 ms
 *   debounce, one call, and a stale (out-of-order) response is discarded
 *   (the `requestSeq` guard);
 * - `expand` toggles the ONE expanded row and fetches `getHistory` only for
 *   the expanded row (a second expand issues one more; a collapse issues
 *   none); a failed detail leaves `detail = null` and the row's collapsed
 *   data — never a crash, never a stale write across rows;
 * - `refreshUsage`/`refreshPreferences` fill their slices; a failed list
 *   call sets `error: 'network'` and `retryLoad()` refires (a blank page
 *   with no retry is a failure);
 * - the retention actions (INV-2): `setKeepCopies` and `clearAllHistory`
 *   are NO-OPS (zero network calls) unless the matching confirmation is
 *   open — `openConfirm` arms, `closeConfirm` cancels; OFF = PUT then POST
 *   `clearAllCopies` (order pinned) then reload; ON = PUT only;
 *   `clearAllHistory(deleteFiles)` = `Txr.clearRuns({delete_files})` then
 *   reload;
 * - `rerun` POSTs `rerunRun` and resolves the new summary id; `working`
 *   marks the in-flight action; `useSettingsAgain` PUTs the DEC-6 exact
 *   body and NEVER calls `rerunRun`;
 * - `openLog`/`loadLogs` backfill `Txr.listRunLogs` pages at the server's
 *   `next_seq`, merge seq-de-duped, keep `LOGS_CAP` and never stream.
 *
 * Every fixture value is synthetic (ids `run-1`/`method-a`, non-board
 * counts — the boards' facts are design examples, never data, INV-6). The
 * only mocked boundary is `@/api-client`; the store-kit lifecycle runs for
 * real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  TxrHistoryDetail,
  TxrHistoryItem,
  TxrHistoryPage,
  TxrHistoryUsage,
  TxrRunLogLine,
  TxrRunSummary,
} from '@/api-client/types'
import { PAGE_SIZE } from '../types'

const api = vi.hoisted(() => {
  // The provider default page size (PAGE_SIZE's value, spelled here because
  // a hoisted factory cannot reference an import binding).
  const emptyPage: TxrHistoryPage = { items: [], total: 0, limit: 20, offset: 0 }
  return {
    listHistory: vi.fn(async (_q: unknown): Promise<TxrHistoryPage> => emptyPage),
    getHistory: vi.fn(async (_id: unknown): Promise<TxrHistoryDetail | null> => null),
    getUsage: vi.fn(async (): Promise<TxrHistoryUsage | null> => null),
    getPreferences: vi.fn(
      async (): Promise<{ keep_file_copies: boolean }> => ({ keep_file_copies: true }),
    ),
    updatePreferences: vi.fn(async (_body: unknown): Promise<void> => undefined),
    clearAllCopies: vi.fn(async (): Promise<void> => undefined),
    rerunRun: vi.fn(
      async (_id: unknown): Promise<TxrRunSummary> => ({ id: 'run-new' }) as TxrRunSummary,
    ),
    listRunLogs: vi.fn(
      async (_q: unknown): Promise<{ lines: TxrRunLogLine[]; next_seq: number; total: number }> => ({
        lines: [],
        next_seq: 0,
        total: 0,
      }),
    ),
    clearRuns: vi.fn(async (_q: unknown): Promise<void> => undefined),
    updateAnalysisConfig: vi.fn(async (_body: unknown): Promise<void> => undefined),
  }
})
vi.mock('@/api-client', () => ({
  ApiClient: {
    History: {
      listHistory: api.listHistory,
      getHistory: api.getHistory,
      getUsage: api.getUsage,
      getPreferences: api.getPreferences,
      updatePreferences: api.updatePreferences,
      clearAllCopies: api.clearAllCopies,
    },
    Txr: {
      rerunRun: api.rerunRun,
      listRunLogs: api.listRunLogs,
      clearRuns: api.clearRuns,
      updateAnalysisConfig: api.updateAnalysisConfig,
    },
  },
}))

const { useTxrHistory, LOGS_PAGE_SIZE, LOGS_CAP } = await import('./TxrHistory.store')
const state = () => useTxrHistory.getState()

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (all synthetic — INV-6: the boards' facts are never data)
// ─────────────────────────────────────────────────────────────────────────────

function item(id: string, over: Partial<TxrHistoryItem> = {}): TxrHistoryItem {
  return {
    id,
    bucket: 'finished',
    mode: 'train',
    created_at: '2026-11-05T10:02:00Z',
    method_count: 3,
    file_names: ['patients.csv', 'new_measurements.csv'],
    learned_from: 41,
    predicted: 12,
    endpoint: 'pfs',
    decision_day: 42,
    look_ahead_day: 180,
    methods: [{ id: 'method-a', version: '1.0.0', elapsed_secs: 95 }],
    models_made: { produced: 2, saved_sets: [] },
    models_used: [],
    markers: 5,
    markers_saved: false,
    copies_kept: true,
    can_rerun: true,
    can_reopen: true,
    can_download: true,
    dir: '/data/txresbench/analysis-2026-11-05-run-1',
    ...over,
  }
}

function detail(id: string, over: Partial<TxrHistoryDetail> = {}): TxrHistoryDetail {
  return {
    id,
    bucket: 'finished',
    mode: 'train',
    created_at: '2026-11-05T10:02:00Z',
    method_count: 3,
    file_names: ['patients.csv', 'new_measurements.csv'],
    learned_from: 41,
    predicted: 12,
    endpoint: 'pfs',
    decision_day: 42,
    look_ahead_day: 180,
    methods: [
      {
        method_id: 'method-a',
        label: 'method-a',
        group: 'dynamic_risk',
        group_label: 'Dynamic risk',
        version: '1.0.0',
        state: 'finished',
        bytes_downloaded: 0,
        elapsed_secs: 95,
      },
    ],
    models_made: { produced: 2, saved_sets: [] },
    models_saved: [],
    models_used: [],
    markers: 5,
    markers_saved: false,
    copies_kept: true,
    copies: { kept: true },
    file_sizes: [],
    log_line_count: 7,
    can_rerun: true,
    can_reopen: true,
    can_download: true,
    dir: '/data/txresbench/analysis-2026-11-05-run-1',
    settings: {
      endpoint: 'pfs',
      decision_day: 42,
      look_ahead_day: 180,
      covariates: true,
      at_a_time: 2,
      cpus: 4,
      save_models: false,
      mode: 'train',
      seed: 7,
      memory_total_bytes: 17179869184,
    },
    ...over,
  }
}

function page(total: number, items: TxrHistoryItem[] = []): TxrHistoryPage {
  return { items, total, limit: PAGE_SIZE, offset: 0 }
}

function logLine(seq: number, content = `line ${seq}`): TxrRunLogLine {
  return { seq, content, stream: 'stdout', created_at: '2026-11-05T10:02:00Z' }
}

function logLines(from: number, count: number): TxrRunLogLine[] {
  return Array.from({ length: count }, (_, i) => logLine(from + i))
}

function usage(over: Partial<TxrHistoryUsage> = {}): TxrHistoryUsage {
  return {
    run_count: 3,
    total_bytes: 327000000,
    runs_bytes: 200000000,
    models_bytes: 100000000,
    other_bytes: 27000000,
    computed_at: '2026-11-05T10:02:00Z',
    data_dir: '/data/txresbench',
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain the microtask chain of a settled async action (each `await` hop). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

beforeEach(() => {
  state().reset()
  for (const fn of Object.values(api)) (fn as ReturnType<typeof vi.fn>).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TxrHistory store (TEST-HIST-2/3/4)', () => {
  // ── the barrel façade (the plan's barrel note — the store line joins the
  //    barrel with its item, DRIFT-1 #2) ───────────────────────────────────

  it('the barrel re-exports the store (the façade line joins at this item)', () => {
    const barrel = readFileSync(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'utf8',
    )
    expect(barrel).toContain("export * from './stores/TxrHistory.store'")
    expect(barrel).toContain("export * from './routes'")
    expect(barrel).toContain("export * from './types'")
  })

  // ── TEST-HIST-2: the paged list ──────────────────────────────────────────

  it('loadFirstPage issues ONE listHistory with the page size, offset 0 and the active query, and fills items/total', async () => {
    api.listHistory.mockResolvedValueOnce(page(9, [item('run-2'), item('run-1')]))
    await state().setFilter('learned')
    await flush()
    expect(api.listHistory).toHaveBeenCalledTimes(1)
    expect(api.listHistory).toHaveBeenCalledWith({ limit: PAGE_SIZE, offset: 0, kind: 'learned' })
    expect(state().items.map(i => i.id)).toEqual(['run-2', 'run-1'])
    expect(state().total).toBe(9)
    expect(state().loading).toBe(false)
    expect(state().error).toBeNull()
  })

  it('loadMore continues at offset = items.length and APPENDS, server order preserved', async () => {
    const first = Array.from({ length: PAGE_SIZE }, (_, i) => item(`run-${String(i + 1).padStart(2, '0')}`))
    api.listHistory.mockResolvedValue({
      items: first,
      total: 25,
      limit: PAGE_SIZE,
      offset: 0,
    })
    await state().loadFirstPage()
    expect(state().items).toHaveLength(PAGE_SIZE)
    api.listHistory.mockResolvedValueOnce({
      items: [item('run-21'), item('run-22')],
      total: 25,
      limit: PAGE_SIZE,
      offset: PAGE_SIZE,
    })
    await state().loadMore()
    expect(api.listHistory).toHaveBeenLastCalledWith({ limit: PAGE_SIZE, offset: PAGE_SIZE })
    expect(state().items).toHaveLength(PAGE_SIZE + 2)
    expect(state().items[PAGE_SIZE].id).toBe('run-21')
    expect(state().items.map(i => i.id)).toEqual([
      ...first.map(i => i.id),
      'run-21',
      'run-22',
    ])
    expect(state().total).toBe(25)
  })

  it('setSearch updates searchInput immediately, q after the debounce, in one call', async () => {
    vi.useFakeTimers()
    state().loadFirstPage()
    api.listHistory.mockResolvedValueOnce(page(1, [item('run-hit')]))
    state().setSearch('cox-cutpoint')
    expect(state().searchInput).toBe('cox-cutpoint')
    expect(state().q).toBe('')
    expect(api.listHistory).toHaveBeenCalledTimes(1) // the pre-search load only
    await vi.advanceTimersByTimeAsync(200)
    expect(state().q).toBe('cox-cutpoint')
    expect(api.listHistory).toHaveBeenCalledTimes(2)
    expect(api.listHistory).toHaveBeenLastCalledWith({
      limit: PAGE_SIZE,
      offset: 0,
      q: 'cox-cutpoint',
    })
    await flush()
    expect(state().items.map(i => i.id)).toEqual(['run-hit'])
  })

  it('discards a stale out-of-order response (the requestSeq guard)', async () => {
    vi.useFakeTimers()
    const slow = deferred<TxrHistoryPage>()
    const fast = deferred<TxrHistoryPage>()
    api.listHistory.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    state().setSearch('a')
    await vi.advanceTimersByTimeAsync(200)
    state().setSearch('ab')
    await vi.advanceTimersByTimeAsync(200)
    expect(api.listHistory).toHaveBeenCalledTimes(2)
    fast.resolve(page(1, [item('run-fast')]))
    await flush()
    expect(state().items.map(i => i.id)).toEqual(['run-fast'])
    slow.resolve(page(1, [item('run-slow')]))
    await flush()
    // The earlier, now-stale response must not overwrite the newer one.
    expect(state().items.map(i => i.id)).toEqual(['run-fast'])
    expect(state().total).toBe(1)
  })

  it('setFilter restarts the list (offset 0) with the provider kind parameter', async () => {
    await state().loadFirstPage()
    api.listHistory.mockResolvedValueOnce(page(2, [item('run-reuse', { mode: 'reuse' })]))
    state().setFilter('saved-model')
    expect(api.listHistory).toHaveBeenCalledTimes(2)
    expect(api.listHistory).toHaveBeenLastCalledWith({
      limit: PAGE_SIZE,
      offset: 0,
      kind: 'saved-model',
    })
    await flush()
    expect(state().items).toHaveLength(1)
    // 'all' sends neither kind nor status.
    await state().setFilter('all')
    expect(api.listHistory).toHaveBeenLastCalledWith({ limit: PAGE_SIZE, offset: 0 })
  })

  it('expand toggles one row and fetches the detail only for the expanded row', async () => {
    api.getHistory.mockResolvedValue(detail('run-1'))
    await state().expand('run-1')
    expect(state().expandedId).toBe('run-1')
    expect(state().detail?.id).toBe('run-1')
    expect(api.getHistory).toHaveBeenCalledTimes(1)
    expect(api.getHistory).toHaveBeenCalledWith({ id: 'run-1' })
    // A second expand replaces (DEC-8 — never stacks) and issues one more.
    api.getHistory.mockResolvedValue(detail('run-2', { bucket: 'stopped' }))
    await state().expand('run-2')
    expect(state().expandedId).toBe('run-2')
    expect(state().detail?.id).toBe('run-2')
    expect(api.getHistory).toHaveBeenCalledTimes(2)
    // Collapsing issues none.
    await state().expand('run-2')
    expect(state().expandedId).toBeNull()
    expect(state().detail).toBeNull()
    expect(api.getHistory).toHaveBeenCalledTimes(2)
  })

  it('a failed detail leaves the row data alone (404 renders as the data-only fallback, never a crash)', async () => {
    api.getHistory.mockRejectedValueOnce(
      Object.assign(new Error('RUN_NOT_FOUND'), { status: 404 }),
    )
    await state().expand('run-gone')
    expect(state().expandedId).toBe('run-gone')
    expect(state().detail).toBeNull()
    expect(state().detailLoading).toBe(false)
  })

  it('a stale expand response never writes a newer row', async () => {
    const slow = deferred<TxrHistoryDetail>()
    const fast = deferred<TxrHistoryDetail>()
    api.getHistory.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    void state().expand('run-1')
    void state().expand('run-2')
    fast.resolve(detail('run-2'))
    await flush()
    expect(state().detail?.id).toBe('run-2')
    slow.resolve(detail('run-1'))
    await flush()
    expect(state().detail?.id).toBe('run-2')
  })

  it('refreshUsage and refreshPreferences fill their slices', async () => {
    api.getUsage.mockResolvedValueOnce(usage({ run_count: 3 }))
    api.getPreferences.mockResolvedValueOnce({ keep_file_copies: false })
    await state().refreshUsage()
    await state().refreshPreferences()
    expect(api.getUsage).toHaveBeenCalledTimes(1)
    expect(state().usage?.run_count).toBe(3)
    expect(api.getPreferences).toHaveBeenCalledTimes(1)
    expect(state().preferences?.keep_file_copies).toBe(false)
  })

  it('a failed first-page call sets error network and retryLoad refires', async () => {
    api.listHistory.mockRejectedValueOnce(new Error('HTTP error! status: 500'))
    await state().loadFirstPage()
    expect(state().error).toBe('network')
    expect(state().items).toEqual([])
    api.listHistory.mockResolvedValueOnce(page(1, [item('run-ok')]))
    await state().retryLoad()
    expect(state().error).toBeNull()
    expect(state().items.map(i => i.id)).toEqual(['run-ok'])
  })

  // ── TEST-HIST-3: the grown single-call multi-value filter ────────────────

  it('the Stopped-or-failed filter is the ONE multi-value call (GAP-HIST-3 grown; no merge fallback)', async () => {
    api.listHistory.mockResolvedValueOnce(
      page(11, [item('run-stop', { bucket: 'stopped' }), item('run-fail', { bucket: 'failed' })]),
    )
    state().setFilter('stopped-failed')
    expect(api.listHistory).toHaveBeenCalledTimes(1)
    expect(api.listHistory).toHaveBeenCalledWith({
      limit: PAGE_SIZE,
      offset: 0,
      status: 'stopped,failed',
    })
    await flush()
    expect(state().items.map(i => i.bucket)).toEqual(['stopped', 'failed'])
    expect(state().total).toBe(11)
    // loadMore stays page-correct under the SAME filter: one call, same status.
    api.listHistory.mockResolvedValueOnce({ items: [], total: 11, limit: PAGE_SIZE, offset: 2 })
    await state().loadMore()
    expect(api.listHistory).toHaveBeenLastCalledWith({
      limit: PAGE_SIZE,
      offset: 2,
      status: 'stopped,failed',
    })
  })

  // ── TEST-HIST-4: retention, rerun, settings-again, the log backfill ──────

  it('the destructive actions are no-ops without the open confirmation (INV-2)', async () => {
    await state().setKeepCopies(false)
    await state().setKeepCopies(true)
    await state().clearAllHistory(true)
    expect(api.updatePreferences).not.toHaveBeenCalled()
    expect(api.clearAllCopies).not.toHaveBeenCalled()
    expect(api.clearRuns).not.toHaveBeenCalled()
    expect(api.listHistory).not.toHaveBeenCalled()
  })

  it('copies-off: PUT then POST clearAllCopies, in order, then reload; the new state echoes', async () => {
    api.listHistory.mockResolvedValueOnce(page(0))
    state().openConfirm('copies-off')
    await state().setKeepCopies(false)
    expect(api.updatePreferences).toHaveBeenCalledTimes(1)
    expect(api.updatePreferences).toHaveBeenCalledWith({ keep_file_copies: false })
    expect(api.clearAllCopies).toHaveBeenCalledTimes(1)
    expect(
      api.updatePreferences.mock.invocationCallOrder[0],
    ).toBeLessThan(api.clearAllCopies.mock.invocationCallOrder[0])
    expect(
      api.clearAllCopies.mock.invocationCallOrder[0],
    ).toBeLessThan(api.listHistory.mock.invocationCallOrder[0])
    expect(state().preferences?.keep_file_copies).toBe(false)
    expect(state().working).toBeNull()
  })

  it('copies-on: PUT only, never a clear (removed copies are not restored)', async () => {
    state().openConfirm('copies-on')
    await state().setKeepCopies(true)
    expect(api.updatePreferences).toHaveBeenCalledWith({ keep_file_copies: true })
    expect(api.clearAllCopies).not.toHaveBeenCalled()
  })

  it('the wrong confirmation never arms the wrong action', async () => {
    state().openConfirm('copies-off')
    await state().setKeepCopies(true)
    expect(api.updatePreferences).not.toHaveBeenCalled()
    await state().clearAllHistory(false)
    expect(api.clearRuns).not.toHaveBeenCalled()
  })

  it('closeConfirm cancels (zero calls after a cancel)', async () => {
    state().openConfirm('clear-all')
    state().closeConfirm()
    await state().clearAllHistory(false)
    expect(api.clearRuns).not.toHaveBeenCalled()
  })

  it('clearAllHistory follows the delete_files choice and reloads', async () => {
    api.listHistory.mockResolvedValueOnce(page(0))
    state().openConfirm('clear-all')
    await state().clearAllHistory(true)
    expect(api.clearRuns).toHaveBeenCalledTimes(1)
    expect(api.clearRuns).toHaveBeenCalledWith({ delete_files: true })
    expect(
      api.clearRuns.mock.invocationCallOrder[0],
    ).toBeLessThan(api.listHistory.mock.invocationCallOrder[0])
    expect(state().working).toBeNull()
  })

  it('rerun POSTs rerunRun, resolves the new run id and marks working in flight', async () => {
    const d = deferred<TxrRunSummary>()
    api.rerunRun.mockReturnValueOnce(d.promise)
    const pending = state().rerun('run-1')
    expect(api.rerunRun).toHaveBeenCalledWith({ id: 'run-1' })
    expect(state().working).toBe('run-1')
    d.resolve({ id: 'run-new' } as TxrRunSummary)
    const summary = await pending
    expect(summary.id).toBe('run-new')
    expect(state().working).toBeNull()
  })

  it('useSettingsAgain PUTs the DEC-6 exact body from the run settings and NEVER reruns', async () => {
    await state().useSettingsAgain(detail('run-1'))
    expect(api.updateAnalysisConfig).toHaveBeenCalledTimes(1)
    expect(api.updateAnalysisConfig).toHaveBeenCalledWith({
      config: {
        endpoint: 'pfs',
        decision_day: 42,
        look_ahead_day: 180,
        covariates: true,
        at_a_time: 2,
        cpus: 4,
        save_models: false,
        label_day: null,
      },
      last_input_summary: null,
    })
    expect(api.rerunRun).not.toHaveBeenCalled()
    // The completing action reloads (DEC-11).
    expect(api.listHistory).toHaveBeenCalledTimes(1)
  })

  it('useSettingsAgain omits cpus when the run did not record one', async () => {
    await state().useSettingsAgain(
      detail('run-1', { settings: { ...detail('run-1').settings, cpus: undefined } }),
    )
    const body = api.updateAnalysisConfig.mock.calls[0][0] as {
      config: Record<string, unknown>
    }
    expect(body.config.cpus).toBeUndefined()
    expect(body.config.label_day).toBeNull()
  })

  it('openLog backfills at the server next_seq cursor; loadLogs appends seq-de-duped, capped', async () => {
    api.listRunLogs.mockResolvedValueOnce({ lines: logLines(1, 3), next_seq: 3, total: 25 })
    await state().openLog('run-1', 'method-a')
    expect(api.listRunLogs).toHaveBeenCalledWith({
      id: 'run-1',
      limit: LOGS_PAGE_SIZE,
      method_id: 'method-a',
    })
    expect(state().logLines.map(l => l.seq)).toEqual([1, 2, 3])
    expect(state().logTotal).toBe(25)
    expect(state().logLoading).toBe(false)
    // The continuation rides the server's resume point; a dup seq is dropped.
    api.listRunLogs.mockResolvedValueOnce({ lines: [logLine(3, 'dup'), logLine(4)], next_seq: 4, total: 25 })
    await state().loadLogs()
    expect(api.listRunLogs).toHaveBeenLastCalledWith({
      id: 'run-1',
      limit: LOGS_PAGE_SIZE,
      method_id: 'method-a',
      after_seq: 3,
    })
    expect(state().logLines.map(l => l.seq)).toEqual([1, 2, 3, 4])
    // The cap holds: a 200-page then a second page keeps the LAST LOGS_CAP.
    state().closeLog()
    api.listRunLogs.mockResolvedValueOnce({ lines: logLines(1, LOGS_PAGE_SIZE), next_seq: 200, total: 300 })
    await state().openLog('run-1', null)
    expect(api.listRunLogs).toHaveBeenLastCalledWith({
      id: 'run-1',
      limit: LOGS_PAGE_SIZE,
    })
    api.listRunLogs.mockResolvedValueOnce({ lines: logLines(201, 100), next_seq: 300, total: 300 })
    await state().loadLogs()
    expect(state().logLines).toHaveLength(LOGS_CAP)
    expect(state().logLines[0].seq).toBe(101)
    expect(state().logLines[LOGS_CAP - 1].seq).toBe(300)
  })

  it('closeLog resets the buffer and the cursor; a failed backfill keeps the shown lines', async () => {
    api.listRunLogs.mockResolvedValueOnce({ lines: logLines(1, 2), next_seq: 2, total: 2 })
    await state().openLog('run-1', null)
    state().closeLog()
    expect(state().logDialog).toBeNull()
    expect(state().logLines).toEqual([])
    // A retry after a failure resumes at the cursor the server last declared.
    api.listRunLogs.mockRejectedValueOnce(new Error('HTTP error! status: 500'))
    await state().openLog('run-1', null)
    expect(state().logLoading).toBe(false)
    expect(state().logLines).toEqual([])
  })
})
