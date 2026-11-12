/**
 * txrresults results store (ITEM-5; PROV-UR-2) — the one per-run view store
 * the G/H screens read: the run detail, the predictions snapshot, the live
 * SSE frames, the backfilled log lines and the view-state controls (outcome
 * tab, method picker, search, sort, row window, compare mode, dialogs).
 *
 * Singleton + whole-store-lazy (`registerLazyStore`, the `DatasetDetail`
 * precedent, DEC-3): the results view is single-instance per URL, and every
 * navigation to a run id goes through `load(runId)`, which resets the state
 * first (no cross-run bleed). Load order (PROV-UR-2 / TEST-UR-6's pin):
 * `GET run detail` → `GET predictions` → connect the run SSE. The SSE
 * replay-on-connect contract (PROV-EE-4) makes the late subscribe complete:
 * the server replays the status + method rows + prediction frames on connect,
 * so frames that happened before the stream connected are never lost.
 *
 * Frame handling (PROV-EE-4's vocabulary, typed via the generated
 * `TxrRunEvent` handlers):
 *
 * - `status` → patch `run.status` (the frame's only field; `elapsed_secs`
 *   and `counts` are not on the frame — counts are derived from the patched
 *   method rows, elapsed stays the detail's snapshot). A terminal status
 *   (`finished`/`failed`/`stopped`) latches: later frames are ignored ("stop
 *   live frames" — a replayed terminal snapshot's prediction frames must not
 *   start a refetch storm) and ONE final `refreshPredictions()` runs, so the
 *   last streamed snapshot is the response built after the terminal state.
 * - `method` → patch the method row (state/phase/bytes/elapsed; `reason_code`
 *   keeps the detail it already carries for the same code, an empty detail
 *   for a NEW code — the reason text is the consumer's, DEC-15) and
 *   recompute the per-state counts from the rows (never a detail refetch).
 * - `prediction` → mark the row's state `finished` (the frame IS the
 *   finished-column announcement — INV-1's "N of M methods finished" stays
 *   truthful even when the method frame races) and `refreshPredictions()`
 *   (the new column's full values; one request per frame + the stale guard).
 * - `log` → append to `liveLogs` (seq-de-duped, last 200 kept), the dialog's
 *   live tail beside `loadLogs`' after_seq backfill.
 * - `progress` → patch the method row's `phase` only: PROV-UR-2's state has
 *   no run-progress slot, the frame's `pct` is the download/fit-predict
 *   reading F's own screen renders, and this node's panels show the
 *   engine-authored lines; `message`/`pct` are therefore not retained here.
 *
 * The store is the ONLY consumer of the live surfaces from this module; the
 * G/H pages derive their tables from `run`/`predictions` through
 * `lib/heatmap.ts` at render time. No sync subscription, no polling
 * (CONS-UR-6): liveness is exactly the SSE + the one-shot loads.
 */
import { ApiClient } from '@/api-client'
import type {
  TxrPredictionsResponse,
  TxrRunCounts,
  TxrRunDetail,
  TxrRunLogLine,
  TxrRunMethod,
  TxrRunMethodFrame,
  TxrRunStatus,
  TxrRunStatusFrame,
} from '@/api-client/types'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'
import type { TxrOutcomeKey, TxrSortKey } from '../types'

/** The board's bounded row window (DEC-12 / OWNER-UR-5: 100 rows + "Show all M"). */
export const DEFAULT_PATIENT_LIMIT = 100

/** `liveLogs` keeps the last 200 lines by `seq` (the run log is 20k-capped server-side). */
export const LIVE_LOGS_CAP = 200

/** The log endpoint page size this node asks for (one dialog page). */
export const LOGS_FETCH_LIMIT = 200

/**
 * The results view state (PROV-UR-2). All fields reactive except the stream
 * refs, which live at module scope below (`streamAbort`/`streamGen`/
 * `generation`/`predictionsSeq` — the DatasetDetail / jobsHost idiom).
 *
 * GROWN: `logDialogFor` is `string | null | undefined` — the plan pins
 * `string | null // method_id`, which leaves the whole-run dialog
 * unrepresentable (`openLog(null)` is the plan's own action for it). The
 * three states are: `undefined` = closed, `null` = the whole-run log dialog,
 * a method id = that method's dialog (see PLAN ITEM-5 note).
 */
export interface TxrResultsState {
  runId: string | null
  run: TxrRunDetail | null
  /** 404 RUN_NOT_FOUND vs any other failure (DEC-18: not-found page vs error+retry). */
  runError: 'not-found' | 'network' | null
  predictions: TxrPredictionsResponse | null
  /** 409 PREDICTIONS_UNAVAILABLE (the empty-heatmap state) vs a failed refresh. */
  predictionsError: 'unavailable' | 'network' | null
  predictionsLoading: boolean
  /** The last 200 lines by seq — SSE frames merged with `loadLogs` backfill. */
  liveLogs: TxrRunLogLine[]
  /** Whether the run SSE is connected (a terminal run's replay closes quickly). */
  streaming: boolean
  /** The active outcome tab; `load` sets the run endpoint's key (DEC-4). */
  outcomeTab: TxrOutcomeKey
  /** The group/method picker state; `null` = all methods (the board's All). */
  methodFilter: { groups: string[]; methodIds: string[] } | null
  /** "Find a patient" (case-insensitive substring; the view model applies it). */
  search: string
  /** The board's "Sort by" select. */
  sort: TxrSortKey
  /** Rows shown: `DEFAULT_PATIENT_LIMIT`, `-1` = show all (the "Show all M" footer). */
  patientLimit: number
  /** H compare mode: "Show only the patients where they differ". */
  divergentOnly: boolean
  /** The log dialog: undefined = closed, null = whole-run, else the method id. */
  logDialogFor: string | null | undefined
  /** The "How the chance is calculated" dialog. */
  chanceDialogOpen: boolean
}

const DEFAULT_STATE: TxrResultsState = {
  runId: null,
  run: null,
  runError: null,
  predictions: null,
  predictionsError: null,
  predictionsLoading: false,
  liveLogs: [],
  streaming: false,
  outcomeTab: 'pfs',
  methodFilter: null,
  search: '',
  sort: 'average-desc',
  patientLimit: DEFAULT_PATIENT_LIMIT,
  divergentOnly: false,
  logDialogFor: undefined,
  chanceDialogOpen: false,
}

// ── Non-reactive module scope: the stream/request refs (PROV-UR-2) ───────────
//
// `generation` is the store's run epoch: `reset`/`load` bump it, every async
// continuation and every SSE handler captures it and drops work from an older
// epoch — a pending `getRun` from a previous navigation never writes the new
// run's state (the no-cross-run-bleed + no-`setState`-after-reset pins).

let generation = 0
let streamAbort: AbortController | null = null
let streamGen: number | null = null
let predictionsSeq = 0

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
 * source: a `method` frame's state transition is already reflected in the
 * rows, so the header's "N of M methods finished" never waits for a refetch
 * (INV-1). The generated `TxrRunCounts` keys are exactly the method states.
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
 * code (a replay frame re-announces a known reason) and an empty detail for a
 * NEW code (the provider's per-code sentence is the consumer's —
 * `formatReasonText`'s fallback covers it, DEC-15; never invented here).
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

/** The run endpoint's key is the default outcome tab (DEC-4); the generated
 *  endpoint enum is exactly `pfs | os`, so this is one closed mapping. */
const endpointTabOf = (endpoint: string | null | undefined): TxrOutcomeKey =>
  endpoint === 'os' ? 'os' : 'pfs'

const TxrResultsDef = defineStore('TxrResults', {
  state: DEFAULT_STATE,
  actions: (set, get) => {
    /** Abort the live stream (if any) and mark it gone. */
    const disconnectStream = (): void => {
      streamGen = null
      const abort = streamAbort
      streamAbort = null
      abort?.abort()
      set({ streaming: false })
    }

    /** Load the predictions snapshot with the stale-response guard: only the
     *  LATEST request may write state (a delayed older response can never
     *  overwrite a newer one), and only in the run epoch that started it. */
    const refreshPredictions = async (): Promise<void> => {
      const runId = get().runId
      if (!runId) return
      const gen = generation
      const seq = ++predictionsSeq
      set({ predictionsLoading: true })
      try {
        const predictions = await ApiClient.Txr.getPredictions({ id: runId })
        if (gen !== generation || seq !== predictionsSeq) return
        set({ predictions, predictionsError: null })
      } catch (error) {
        if (gen !== generation || seq !== predictionsSeq) return
        const status = errorStatus(error)
        if (status === 404) {
          // The run vanished between the detail load and now — the not-found
          // page (DEC-18), with the snapshot kept until the next load resets.
          set({ runError: 'not-found' })
        } else if (status === 409) {
          // No method finished yet: the board's empty-heatmap state (never a
          // spinner loop — the SSE keeps delivering until the columns come).
          set({ predictions: null, predictionsError: 'unavailable' })
        } else {
          // The old snapshot stays rendered; the error state carries the retry.
          set({ predictionsError: 'network' })
        }
      } finally {
        if (gen === generation && seq === predictionsSeq) set({ predictionsLoading: false })
      }
    }

    /** Connect the run SSE (typed handlers per the generated `TxrRunEvent`).
     *  Idempotent per generation; the `__init` AbortController is latched so
     *  an early disconnect still aborts when the controller arrives. */
    const connectStream = (): void => {
      const runId = get().runId
      if (!runId || streamGen === generation) return
      const gen = generation
      streamGen = gen
      set({ streaming: true })
      let terminalSeen = false
      void ApiClient.Txr.streamRun(
        { id: runId },
        {
          SSE: {
            __init: data => {
              streamAbort = data.abortController
              if (streamGen !== gen) streamAbort.abort()
            },
            status: (data: TxrRunStatusFrame) => {
              if (gen !== generation || terminalSeen) return
              const status = data.status
              if (!isRunStatus(status)) return
              set(s => (s.run ? { run: { ...s.run, status } } : s))
              if (TERMINAL_RUN_STATUSES.has(status)) {
                // One final snapshot fetch, exactly once per stream lifetime.
                terminalSeen = true
                set({ streaming: false })
                void refreshPredictions()
              }
            },
            method: (data: TxrRunMethodFrame) => {
              if (gen !== generation || terminalSeen) return
              set(s => {
                if (!s.run) return s
                const methods = s.run.methods.map(m =>
                  m.method_id === data.method_id ? patchMethodRow(m, data) : m,
                )
                return { run: { ...s.run, methods, counts: countsFromMethods(methods) } }
              })
            },
            log: (data: TxrRunLogLine) => {
              if (gen !== generation || terminalSeen) return
              set(s => (s.liveLogs.some(l => l.seq === data.seq) ? s : { liveLogs: mergeLogs(s.liveLogs, [data]) }))
            },
            progress: (data: { method_id: string; phase?: string | null }) => {
              if (gen !== generation || terminalSeen) return
              const phase =
                data.phase === undefined
                  ? undefined
                  : data.phase === null || !PHASES.has(data.phase)
                    ? undefined
                    : (data.phase as NonNullable<TxrRunMethod['phase']>)
              if (phase === undefined) return
              set(s => {
                if (!s.run) return s
                const methods = s.run.methods.map(m =>
                  m.method_id === data.method_id ? { ...m, phase } : m,
                )
                return { run: { ...s.run, methods } }
              })
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
                return { run: { ...s.run, methods, counts: countsFromMethods(methods) } }
              })
              void refreshPredictions()
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
    }

    /** Full reset + abort: the onCleanup teardown AND the start of a fresh
     *  `load` (resetting first is what stops cross-run bleed — a pending
     *  request from the previous run id is dropped by its generation guard). */
    const reset = (): void => {
      generation += 1
      disconnectStream()
      set({ ...DEFAULT_STATE })
    }

    /** Load one run: reset, then detail → predictions → stream, exactly once
     *  per `runId` (single-instance per URL, DEC-3). The stream connects only
     *  when the detail loaded — a not-found run must not open a second 404. */
    const load = async (runId: string): Promise<void> => {
      reset()
      set({ runId })
      const gen = generation
      try {
        const run = await ApiClient.Txr.getRun({ id: runId })
        if (gen !== generation) return
        set({
          run,
          runError: null,
          outcomeTab: endpointTabOf(run.outcome?.endpoint ?? run.config?.endpoint),
        })
      } catch (error) {
        if (gen !== generation) return
        set({ runError: errorStatus(error) === 404 ? 'not-found' : 'network' })
        return
      }
      await refreshPredictions()
      if (gen === generation && get().runError === null) connectStream()
    }

    /** Backfill log lines (the pre-SSE history + the dialog's after_seq
     *  continuation). Lines merge into `liveLogs` de-duped by seq; a failure
     *  leaves the current lines (the run-level error state governs — the
     *  dialog is a live tail, never a blocking load). */
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
        set(s => ({ liveLogs: mergeLogs(s.liveLogs, response.lines) }))
        return response.lines
      } catch {
        return []
      }
    }

    return {
      load,
      refreshPredictions,
      connectStream,
      disconnectStream,
      loadLogs,
      reset,
      setOutcomeTab: (tab: TxrOutcomeKey) => set({ outcomeTab: tab }),
      setMethodFilter: (filter: TxrResultsState['methodFilter']) =>
        set({ methodFilter: filter }),
      setSearch: (search: string) => set({ search }),
      setSort: (sort: TxrSortKey) => set({ sort }),
      setPatientLimit: (patientLimit: number) => set({ patientLimit }),
      setDivergentOnly: (divergentOnly: boolean) => set({ divergentOnly }),
      openLog: (methodId?: string | null) =>
        set({ logDialogFor: methodId === undefined ? undefined : methodId }),
      openChanceDialog: (chanceDialogOpen: boolean) => set({ chanceDialogOpen }),
    }
  },
  init: ({ onCleanup, actions }) => {
    // The results view has no `sync:*` subscription (CONS-UR-6): liveness is
    // the run SSE only. Cleanup aborts the stream and drops the whole state.
    onCleanup(() => actions.reset())
  },
})

export const useTxrResultsStore = TxrResultsDef.store

/**
 * The reactive store PROXY consumers import (whole-store-lazy:
 * `registerLazyStore` self-registers under `'TxrResults'` — the module's
 * `stores: []` is deliberate, PROV-UR-1, so a consumer import is the only
 * thing that loads this chunk).
 */
export const TxrResults = registerLazyStore(TxrResultsDef)
