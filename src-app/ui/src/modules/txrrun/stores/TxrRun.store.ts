/**
 * txrrun run store (PROV-UI-RUN-3) — screen F's one per-run live view
 * (`BusyRunning.dc.html`) and the single owner of its liveness: `load` takes
 * one run id, `GET /api/txr/runs/{id}` fills the snapshot, and the run SSE
 * (`Txr.streamRun`) keeps it live. The later screen items (ITEM-9/10/11) read
 * this store only — F never polls, never refetches a frame's fact, and never
 * subscribes to a sync bus or a global notification (CONS-UI-RUN-16: the run
 * SSE is the ONLY live channel; PROV-EE-11's no-sync rule).
 *
 * Whole-store-lazy: `registerLazyStore` in this file, the `DatasetDetail` /
 * `TxrResults` precedent — the module declares `stores: []` and a consumer
 * import is the only thing that loads this chunk (single-instance per URL).
 *
 * Load order (TEST-RUN-10's pin): `Txr.getRun` FIRST, then
 * `Txr.streamRun`. The engine's replay-on-connect contract (PROV-EE-4) is
 * what makes the late subscribe complete: the server subscribes to its own
 * runtime bus first, then replays the status, the last 200 log lines, every
 * method row and each finished method's prediction frame — the frames that
 * happened before the stream connected are replayed on connect, never lost.
 * A terminal run serves that replay snapshot only and closes; the F page
 * renders the snapshot + the final state, never a blank (CONS-UI-RUN-9).
 *
 * Frame handling (the generated `TxrRunEvent` vocabulary, PROV-EE-4):
 *
 * - `status` → patch `run.status` (the frame's only field; a terminal value
 *   latches: the stream is flagged stopped, later frames of this stream
 *   lifetime are ignored, and the last snapshot stays — the detail's
 *   `elapsed_secs` and counts are never fabricated from a status frame, see
 *   DRIFT-1 ITEM-5 #2);
 * - `method` → patch the method row (state/phase/bytes/elapsed; `reason_code`
 *   keeps the row's known detail for the same code and an empty shell for a
 *   NEW code — the reason sentence is the consumer's) and recompute the
 *   per-state counts from the rows, never from the frame;
 * - `log` → append to `liveLogs` (seq-de-duped, last 200 kept);
 * - `progress` → fill `perMethod[method_id].progress` (the row's running
 *   detail line; the frame also carries `pct`/`phase` for the F progress bar);
 * - `prediction` → mark the row finished, recompute the counts and set
 *   `predictions_ready` — the "See the results" affordance (INV-1:
 *   results readable while the others still run).
 *
 * Every async continuation is epoch-guarded (module-scope `generation`):
 * `reset`/`load`/`onCleanup` bump it, and a stale `getRun`/`loadLogs`/action
 * response from a previous run id or after a teardown never writes the new
 * state (no `setState` after dispose; the `__init` AbortController latch
 * aborts a stream whose dispose landed before the controller arrived — the
 * `jobsHost.ts` idiom).
 *
 * The stop/skip surface is the engine's PROV-EE-6 controls: a 409
 * (`METHOD_NOT_ACTIVE` / `METHOD_NOT_SKIPPABLE`) lands as that row's error
 * (the row keeps its state, its action disables), never a crash and never a
 * silent no-op. The at-a-time control is the CONS-UI-RUN-11 GAP call site:
 * `ApiClient.Txr.setAtATime` (the engine's growth route
 * `POST /api/txr/runs/{id}/at-a-time`, the generated id per ITEM-1 note (d));
 * a failure sets `atATimeError` and restores the run's value — the consumer
 * never re-implements the lane manager.
 */
import { ApiClient } from '@/api-client'
import type {
  TxrRunCounts,
  TxrRunDetail,
  TxrRunLogLine,
  TxrRunMethod,
  TxrRunMethodFrame,
  TxrRunPredictionFrame,
  TxrRunProgressFrame,
  TxrRunStatus,
  TxrRunStatusFrame,
} from '@/api-client/types'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'
import type { TxrRunBucket } from '../types'

/** `liveLogs` keeps the last 200 lines by `seq` (the server's replay tail is the same bound). */
export const LIVE_LOGS_CAP = 200

/** The log-endpoint page size for one backfill / continuation call. */
export const LOGS_FETCH_LIMIT = 200

/** The at-a-time control's failure line (the control restores the run's value). */
export const AT_A_TIME_ERROR_LINE = 'Could not change the number running at a time.'

/**
 * The row-level live facts screen F renders per method: the latest progress
 * frame (the running detail line + the download/fit bar) and the latest
 * reason the engine announced for the row (a failure or cannot-run line is
 * never blank — `lib/format.ts`'s fallback covers an unannounced one).
 */
export interface TxrRunPerMethod {
  progress: TxrRunProgressFrame | null
  lastReason: { code: string; detail: string } | null
}

/**
 * The F screen state (PROV-UI-RUN-3). All fields reactive; the stream refs
 * (below) live at module scope on purpose — per-frame arrivals must not
 * thrash subscribers on unrelated stores (the `DatasetDetail` idiom).
 *
 * GROWN (DRIFT-1 ITEM-5 #1): `rowErrors` (per-method action error — the
 * 409 surface of stop/skip; a row whose last action failed keeps its state
 * and disables its action) and `actionError` (the run-level action error —
 * Stop all's failure line) were not in the frozen state list; the frozen
 * `stopping` flag covers the in-flight state of Stop all only.
 */
export interface TxrRunState {
  runId: string | null
  run: TxrRunDetail | null
  /** 404 RUN_NOT_FOUND vs any other load failure (not-found page vs error+retry). */
  runError: 'not-found' | 'network' | null
  loading: boolean
  /** The last 200 lines by seq — SSE frames merged with `loadLogs` backfill. */
  liveLogs: TxrRunLogLine[]
  /** The run's log-line count (the detail's `log_lines`, refreshed by `total` on a backfill). */
  logTotal: number
  /** The row-level live facts, keyed by method id. */
  perMethod: Record<string, TxrRunPerMethod>
  /** Whether the run SSE is connected (a terminal run's replay closes quickly). */
  streaming: boolean
  /** The F tab (the bucket is `lib/format.ts`'s partition; the table filters with it). */
  tab: TxrRunBucket
  /** The log panel's method filter; `null` = all methods. */
  logFilter: string | null
  logFollow: boolean
  logOpen: boolean
  /** The run's current at-a-time value (the detail's at mount; the GAP call's result after). */
  atATime: number | null
  atATimeError: string | null
  /** Stop all in flight. */
  stopping: boolean
  /** Per-method action errors (a 409 of stop/skip — the row keeps its state). */
  rowErrors: Record<string, string>
  /** The run-level action error (Stop all failed). */
  actionError: string | null
}

const DEFAULT_STATE: TxrRunState = {
  runId: null,
  run: null,
  runError: null,
  loading: false,
  liveLogs: [],
  logTotal: 0,
  perMethod: {},
  streaming: false,
  tab: 'all',
  logFilter: null,
  logFollow: true,
  logOpen: false,
  atATime: null,
  atATimeError: null,
  stopping: false,
  rowErrors: {},
  actionError: null,
}

// ── Non-reactive module scope: the stream/request refs (the results-store idiom) ──
//
// `generation` is the run epoch: `reset`/`load` bump it, every async
// continuation and every SSE handler captures it and drops work from an
// older epoch — a pending `getRun` from a previous navigation never writes
// the new run's state (the no-setState-after-unmount + no-cross-run-bleed
// pins). `logCursor` is the `next_seq` of the last log backfill — the
// resume point of the poll-resume after a re-connect.

let generation = 0
let streamAbort: AbortController | null = null
let streamGen: number | null = null
let disposed = false
let logCursor: number | null = null

/** The run-level status vocabulary (PROV-EE-3's enum; a status outside it is dropped). */
const RUN_STATUSES: ReadonlySet<string> = new Set([
  'creating',
  'preparing',
  'running',
  'finishing',
  'finished',
  'failed',
  'stopped',
])

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'stopped'])

const METHOD_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'downloading',
  'running',
  'finished',
  'failed',
  'stopped',
  'skipped',
  'cannot_run',
])

const PHASES: ReadonlySet<string> = new Set(['idle', 'env', 'fit', 'predict', 'done'])

const isRunStatus = (v: string): v is TxrRunStatus => RUN_STATUSES.has(v)

const isMethodState = (v: string | undefined): v is TxrRunMethod['state'] =>
  v !== undefined && METHOD_STATES.has(v)

/**
 * The run's counts derived from its method rows — the only local counts
 * source: a `method`/`prediction` frame's transition is already reflected in
 * the rows, so the per-state counts strip never waits for a refetch (INV-1). The
 * generated `TxrRunCounts` keys are exactly the method states.
 */
function countsFromMethods(methods: TxrRunMethod[]): TxrRunCounts {
  const counts: TxrRunCounts = {
    waiting: 0,
    downloading: 0,
    running: 0,
    finished: 0,
    failed: 0,
    stopped: 0,
    skipped: 0,
    cannot_run: 0,
  }
  for (const method of methods) counts[method.state] += 1
  return counts
}

/**
 * Patch one method row from a `method` frame. Only the fields the frame
 * carries are touched: `state`/`phase`/`bytes_downloaded`/`bytes_total`/
 * `elapsed_secs`/`reason_code`. `reason` keeps the row's detail for the same
 * code (a replay frame re-announces a known reason) and an empty shell for a
 * NEW code (the provider's per-code sentence is the consumer's —
 * `formatProgress`'s "no reason recorded" fallback covers it, DEC-15; never
 * invented here).
 */
function patchMethodRow(
  row: TxrRunMethod,
  frame: TxrRunMethodFrame,
): TxrRunMethod {
  const state = isMethodState(frame.state) ? frame.state : row.state
  const phase =
    frame.phase === undefined
      ? row.phase
      : frame.phase === null || !PHASES.has(frame.phase)
        ? undefined
        : (frame.phase as NonNullable<TxrRunMethod['phase']>)
  const reason =
    frame.reason_code === undefined || frame.reason_code === null
      ? row.reason
      : row.reason?.code === frame.reason_code
        ? row.reason
        : { code: frame.reason_code, detail: '' }
  return {
    ...row,
    state,
    ...(phase !== undefined ? { phase } : {}),
    ...(frame.bytes_downloaded !== undefined
      ? { bytes_downloaded: frame.bytes_downloaded }
      : {}),
    ...(frame.bytes_total !== undefined ? { bytes_total: frame.bytes_total } : {}),
    ...(frame.elapsed_secs !== undefined ? { elapsed_secs: frame.elapsed_secs } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

/** The last `LIVE_LOGS_CAP` lines by seq; a duplicate seq keeps its first line. */
function mergeLogs(
  current: TxrRunLogLine[],
  incoming: TxrRunLogLine[],
): TxrRunLogLine[] {
  if (incoming.length === 0) return current
  const bySeq = new Map<number, TxrRunLogLine>()
  for (const line of [...current, ...incoming]) {
    if (!bySeq.has(line.seq)) bySeq.set(line.seq, line)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-LIVE_LOGS_CAP)
}

const errorStatus = (error: unknown): number | null => {
  if (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status
  }
  return null
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'The request failed.'

/** The per-request facts from the run detail (the audit-age facts are theirs). */
function initialPerMethod(methods: TxrRunMethod[]): Record<string, TxrRunPerMethod> {
  const out: Record<string, TxrRunPerMethod> = {}
  for (const method of methods) {
    out[method.method_id] = { progress: null, lastReason: method.reason ?? null }
  }
  return out
}

const TxrRunDef = defineStore('TxrRun', {
  state: DEFAULT_STATE,
  actions: (set, get) => {
    /** Abort the live stream (if any) and mark it gone. */
    const disconnectStream = (): void => {
      streamGen = null
      disposed = true
      const abort = streamAbort
      streamAbort = null
      abort?.abort()
      set({ streaming: false })
    }

    /** Backfill log lines (the pre-SSE history + the resume after a re-connect).
     *  Lines merge into `liveLogs` de-duped by seq; a failure leaves the
     *  current lines (the panel is a live tail, never a blocking load). */
    const loadLogs = async (
      methodId: string | null,
      afterSeq?: number,
    ): Promise<TxrRunLogLine[]> => {
      const runId = get().runId
      if (!runId) return []
      const gen = generation
      const query: Parameters<typeof ApiClient.Txr.listRunLogs>[0] = {
        id: runId,
        limit: LOGS_FETCH_LIMIT,
        ...(methodId ? { method_id: methodId } : {}),
        ...(afterSeq !== undefined ? { after_seq: afterSeq } : {}),
      }
      try {
        const response = await ApiClient.Txr.listRunLogs(query)
        if (gen !== generation) return []
        logCursor = response.next_seq
        set(s => ({
          liveLogs: mergeLogs(s.liveLogs, response.lines),
          logTotal: response.total,
        }))
        return response.lines
      } catch {
        return []
      }
    }

    const connectStream = (): void => {
      const runId = get().runId
      if (!runId || streamGen === generation) return
      const gen = generation
      streamGen = gen
      disposed = false
      set({ streaming: true })
      // The stream latch (the jobsHost idiom): a dispose that lands before
      // `__init` aborts as soon as the controller arrives; a late dispose
      // aborts immediately.
      let terminalSeen = false
      void ApiClient.Txr.streamRun(
        { id: runId },
        {
          SSE: {
            __init: data => {
              streamAbort = data.abortController
              if (disposed || streamGen !== gen) streamAbort.abort()
            },
            status: (data: TxrRunStatusFrame) => {
              if (gen !== generation || terminalSeen) return
              const status = data.status
              if (!isRunStatus(status)) return
              set(s => (s.run ? { run: { ...s.run, status } } : s))
              if (TERMINAL_RUN_STATUSES.has(status)) {
                // INV-1's terminal-snapshot rule: latch, stop live frames and
                // keep the final snapshot (the server closes the channel after
                // the replay; the settle guard below clears the flag).
                terminalSeen = true
                set({ streaming: false })
              }
            },
            method: (data: TxrRunMethodFrame) => {
              if (gen !== generation || terminalSeen) return
              set(s => {
                if (!s.run) return s
                const methods = s.run.methods.map(m =>
                  m.method_id === data.method_id ? patchMethodRow(m, data) : m,
                )
                const patched = methods.find(m => m.method_id === data.method_id)
                const prev = s.perMethod[data.method_id]
                const lastReason =
                  data.reason_code !== undefined && data.reason_code !== null
                    ? (patched?.reason ?? { code: data.reason_code, detail: '' })
                    : (prev?.lastReason ?? null)
                return {
                  run: { ...s.run, methods, counts: countsFromMethods(methods) },
                  perMethod: {
                    ...s.perMethod,
                    [data.method_id]: {
                      progress: prev?.progress ?? null,
                      lastReason,
                    },
                  },
                }
              })
            },
            log: (data: TxrRunLogLine) => {
              if (gen !== generation || terminalSeen) return
              set(s =>
                s.liveLogs.some(l => l.seq === data.seq)
                  ? s
                  : { liveLogs: mergeLogs(s.liveLogs, [data]) },
              )
            },
            progress: (data: TxrRunProgressFrame) => {
              if (gen !== generation || terminalSeen) return
              set(s => ({
                perMethod: {
                  ...s.perMethod,
                  [data.method_id]: {
                    progress: data,
                    lastReason: s.perMethod[data.method_id]?.lastReason ?? null,
                  },
                },
              }))
            },
            prediction: (data: { method_id: string }) => {
              if (gen !== generation || terminalSeen) return
              set(s => {
                if (!s.run) return s
                const methods = s.run.methods.map(m =>
                  m.method_id === data.method_id && m.state !== 'finished'
                    ? { ...m, state: 'finished' as const }
                    : m,
                )
                return {
                  run: {
                    ...s.run,
                    methods,
                    counts: countsFromMethods(methods),
                    predictions_ready: true,
                  },
                }
              })
            },
          },
        },
      )
        .catch(() => {
          /* stream ended / aborted (a terminal run closes the channel) */
        })
        .finally(() => {
          if (streamGen === gen) {
            streamGen = null
            streamAbort = null
            set({ streaming: false })
          }
        })
      // Poll-resume after a re-connect: bridge the gap between the last log
      // backfill cursor and the live stream. A fresh load's cursor is null —
      // the server's replay tail covers it, so no call is added there.
      if (logCursor !== null) void loadLogs(null, logCursor)
    }

    /** Full reset + abort: the onCleanup teardown AND the start of a fresh
     *  `load` (resetting first stops cross-run bleed — a pending request from
     *  the previous run id is dropped by its generation guard). */
    const reset = (): void => {
      generation += 1
      disconnectStream()
      logCursor = null
      set({ ...DEFAULT_STATE })
    }

    /** Load one run: reset, then detail, then the stream, exactly once per
     *  `runId` (single-instance per URL, DEC-1). The stream connects only
     *  when the detail loaded — a not-found run must not open a second 404. */
    const load = async (runId: string): Promise<void> => {
      reset()
      set({ runId, loading: true })
      const gen = generation
      try {
        const run = await ApiClient.Txr.getRun({ id: runId })
        if (gen !== generation) return
        set({
          run,
          loading: false,
          runError: null,
          atATime: run.config?.at_a_time ?? null,
          logTotal: run.log_lines ?? 0,
          perMethod: initialPerMethod(run.methods),
        })
      } catch (error) {
        if (gen !== generation) return
        set({
          loading: false,
          // qa-fixes4 ITEM-2 (e): the server answers 400 for a NON-UUID
          // path segment ("/analysis/does-not-exist/running") and 404 for
          // an unknown valid id — BOTH are the not-found truth (R3-methods-7:
          // the old network branch told a user with a stale link that the
          // app was down).
          runError: errorStatus(error) === 404 || errorStatus(error) === 400 ? 'not-found' : 'network',
        })
        return
      }
      connectStream()
    }

    /** Re-run the load of the current run id — the failed load's retry (the
     *  network error state's action; the not-found state's link goes to
     *  History instead). */
    const retryLoad = (): void => {
      const runId = get().runId
      if (!runId || get().loading) return
      void load(runId)
    }

    return {
      load,
      retryLoad,
      connectStream,
      disconnectStream,
      loadLogs,
      reset,
      setTab: (tab: TxrRunBucket) => set({ tab }),
      setLogFilter: (methodId: string | null) => set({ logFilter: methodId }),
      setLogFollow: (follow: boolean) => set({ logFollow: follow }),
      setLogOpen: (open: boolean) => set({ logOpen: open }),

      /** Stop one method (`POST /api/txr/runs/{id}/methods/{method_id}/stop`).
       *  The engine's frames flip the row; a 409 (METHOD_NOT_ACTIVE) becomes
       *  the row's error — the row keeps its state, its action disables,
       *  never a crash. Only a 409 is a row error; a network failure surfaces
       *  the row error too so the row's action visibly did not take. */
      stopMethod: async (methodId: string): Promise<void> => {
        const runId = get().runId
        if (!runId) return
        set(s => {
          const rowErrors = { ...s.rowErrors }
          delete rowErrors[methodId]
          return { rowErrors }
        })
        try {
          await ApiClient.Txr.stopMethod({ id: runId, method_id: methodId })
        } catch (error) {
          set(s => ({ rowErrors: { ...s.rowErrors, [methodId]: errorText(error) } }))
        }
      },

      /** Skip one method (`POST /api/txr/runs/{id}/methods/{method_id}/skip`);
       *  the same 409-as-row-error rule as `stopMethod`. */
      skipMethod: async (methodId: string): Promise<void> => {
        const runId = get().runId
        if (!runId) return
        set(s => {
          const rowErrors = { ...s.rowErrors }
          delete rowErrors[methodId]
          return { rowErrors }
        })
        try {
          await ApiClient.Txr.skipMethod({ id: runId, method_id: methodId })
        } catch (error) {
          set(s => ({ rowErrors: { ...s.rowErrors, [methodId]: errorText(error) } }))
        }
      },

      /** Stop the whole run (`POST /api/txr/runs/{id}/stop`); the engine's
       *  frames flip every non-terminal row. A failure is the run-level
       *  action error, never a silent no-op. */
      stopAll: async (): Promise<void> => {
        const runId = get().runId
        if (!runId || get().stopping) return
        set({ stopping: true, actionError: null })
        try {
          await ApiClient.Txr.stopRun({ id: runId })
        } catch (error) {
          set({ actionError: errorText(error) })
        } finally {
          set({ stopping: false })
        }
      },

      /** The mid-run lane change (CONS-UI-RUN-11's GAP call site,
       *  `POST /api/txr/runs/{id}/at-a-time`, generated `Txr.setAtATime`).
       *  Optimistic; a failure restores the run's value and sets
       *  `atATimeError` — the consumer never re-implements the lane manager
       *  (a missing generated method or a provider error is typed here, never
       *  a silent no-op). */
      setAtATime: async (n: number): Promise<void> => {
        const runId = get().runId
        if (!runId) return
        const gen = generation
        const previous = get().atATime
        set({ atATime: n, atATimeError: null })
        try {
          const summary = await ApiClient.Txr.setAtATime({ id: runId, at_a_time: n })
          set({ atATime: summary.config?.at_a_time ?? n, atATimeError: null })
          // qa-fixes2 R2-2: the lane change REPLACES the run's stored
          // estimate — the engine recomputes the schedule at the new lane
          // count, so the header's time-left follows the change instead of
          // keeping the create-time schedule. One detail refetch patches
          // only the estimate (the snapshot's rows may lag the SSE; the
          // stream keeps patching on top of it, and the row facts here
          // would only regress the live view otherwise).
          try {
            const detail = await ApiClient.Txr.getRun({ id: runId })
            if (gen === generation) {
              set(s => (s.run && detail.estimate !== undefined ? { run: { ...s.run, estimate: detail.estimate } } : s))
            }
          } catch {
            /* the old estimate stays — a display fact, never a run error */
          }
        } catch {
          set({
            atATime: get().run?.config?.at_a_time ?? previous,
            atATimeError: AT_A_TIME_ERROR_LINE,
          })
        }
      },
    }
  },
  init: ({ onCleanup, actions }) => {
    // The run view has no `sync:*` subscription (CONS-UI-RUN-16): liveness is
    // the run SSE only. Cleanup aborts the stream and drops the whole state.
    onCleanup(() => actions.reset())
  },
})

export const useTxrRun = TxrRunDef.store

/**
 * The reactive store PROXY consumers import (whole-store-lazy:
 * `registerLazyStore` self-registers under `'TxrRun'` — the module's
 * `stores: []` is deliberate, PROV-UI-RUN-3, so a consumer import is the
 * only thing that loads this chunk).
 */
export const TxrRun = registerLazyStore(TxrRunDef)
