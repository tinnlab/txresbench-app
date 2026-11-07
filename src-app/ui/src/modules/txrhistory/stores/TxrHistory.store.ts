/**
 * txrhistory history store (PROV-HIST-3) — screen K's one list + detail +
 * usage + preferences + retention/action surface, over the providers'
 * frozen contracts ONLY: `ApiClient.History.*` (history-store PROV-HS-2..6)
 * and `ApiClient.Txr.*` (execution-engine PROV-EE-5..8). The store is the
 * module's single data owner — no other file of this module calls the
 * client — and renders no display word itself (the components' lib maps
 * provider values to board words, DEC-9).
 *
 * K is a TERMINAL-RUN snapshot reader, never a live surface (PROV-HIST-8 /
 * provider DEC-11 / PROV-EE-11's no-events rule): no SSE, no sync
 * subscription, no poll loop. Freshness is reload-on-mount/focus (the page
 * calls `reload()`, DEC-11) plus one `reload()` after every completing
 * action (rerun, settings-save, copies-off/on, clear-all). A run finishing
 * while K is open appears at the next focus — honest, not live.
 *
 * Boundedness and truth (INV-1, INV-2, INV-3):
 * - the list is SERVER-paged: `limit: PAGE_SIZE / offset` on every call,
 *   `loadMore` continues at `items.length` and appends — never a
 *   fetch-all / render-all, never a client-side sieve (search + filter are
 *   query parameters);
 * - the "Stopped or failed" option is ONE call with the grown multi-value
 *   `status: 'stopped,failed'` (GAP-HIST-3 RESOLVED at reconcile —
 *   history-store PROV-HS-2 validates it; OR semantics; the plan's
 *   two-call merge fallback was deleted with the growth, CONS-HIST-6);
 * - the expanded block's detail is fetched ONCE per expand (bounded, not
 *   an N+1 on list load); a 404 / failed detail leaves the row's collapsed
 *   data alone (`detail = null`, never a page crash);
 * - every destructive transition (copies-off, copies-on, clear-all) is a
 *   NO-OP unless its confirmation is open (`confirm` is the gate, INV-2);
 * - `rerun` is only ever called by the row's capability resolution
 *   (`actionsFor`, ITEM-3, TEST-HIST-6) — this store never guesses a
 *   capability; `useSettingsAgain` never calls `rerunRun` (DEC-6).
 *
 * Whole-store-lazy: `registerLazyStore` in this file, the `DatasetDetail` /
 * `TxrRun` / `TxrResults` precedent — the module declares `stores: []` and
 * a consumer import is the only thing that loads this chunk.
 *
 * Every async continuation is seq-guarded (module-scope `requestSeq` /
 * `detailSeq` / `logSeq` / `usageSeq`): a stale response from an older
 * request, an older filter or search, or a teardown never writes the
 * current state.
 */
import { ApiClient } from '@/api-client'
import type {
  RunConfig,
  TxrAppConfig,
  TxrHistoryDetail,
  TxrHistoryItem,
  TxrHistoryKind,
  TxrHistoryPreferences,
  TxrHistoryUsage,
  TxrRunLogLine,
  TxrRunSummary,
} from '@/api-client/types'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'
import { PAGE_SIZE, type TxrHistoryFilter } from '../types'

/** The search debounce (the ui-intake precedent: a typed query in flight is
 *  a slow query; the 200 ms window coalesces fast typing). */
export const SEARCH_DEBOUNCE_MS = 200

/** The log endpoint page size (one dialog page) and the retained cap —
 *  the same bounded-backfill numbers the sibling run/results stores use
 *  (the engine's own run log is page-capped server-side). */
export const LOGS_PAGE_SIZE = 200
export const LOGS_CAP = 200

/** The K history list + its view state (PROV-HIST-3). */
export interface TxrHistoryState {
  /** The pages appended so far, server order preserved (newest first, INV-1). */
  items: TxrHistoryItem[]
  /** The provider's engine-truth count under the active q/kind/status. */
  total: number
  /** The FIRST page is loading (the list area's skeleton/empty state). */
  loading: boolean
  /** A Load-more continuation is in flight (the footer button's busy state). */
  loadingMore: boolean
  /** Any failed list call (a server-4xx and a network failure land the same
   *  honest retryable state — the Retry affordance refires the fetch). */
  error: 'network' | null
  /** The four board options (the toolbar select's value). */
  filter: TxrHistoryFilter
  /** The DEBOUNCED query the server list call carries (the wire truth). */
  q: string
  /** The search input's immediate controlled value (the debounce's half). */
  searchInput: string
  /** One expanded row at a time (DEC-8): a second expand replaces, never stacks. */
  expandedId: string | null
  /** The expanded row's detail (of `expandedId`; null on 404/failure — the
   *  row keeps its collapsed data). */
  detail: TxrHistoryDetail | null
  detailLoading: boolean
  /** The footer's usage figure (null until the first `refreshUsage`). */
  usage: TxrHistoryUsage | null
  usageLoading: boolean
  /** The keep-copies preference (null until the first `refreshPreferences`;
   *  the footer's links render from it — consumed on PUT success locally). */
  preferences: TxrHistoryPreferences | null
  /** The open log dialog's run + method filter; null = closed. */
  logDialog: { runId: string; methodId: string | null } | null
  /** The backfilled terminal lines (seq-de-duped, last `LOGS_CAP` kept). */
  logLines: TxrRunLogLine[]
  /** The provider's total line count for the dialog's method filter. */
  logTotal: number
  logLoading: boolean
  /** The open confirmation, one at a time (INV-2: the destructive gate). */
  confirm: 'copies-off' | 'copies-on' | 'clear-all' | null
  /** The in-flight action: the run id (`rerun`), `'preferences'` or
   *  `'clear-all'` — the buttons' busy state, never a double fire. */
  working: string | null
}

const DEFAULT_STATE: TxrHistoryState = {
  items: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: null,
  filter: 'all',
  q: '',
  searchInput: '',
  expandedId: null,
  detail: null,
  detailLoading: false,
  usage: null,
  usageLoading: false,
  preferences: null,
  logDialog: null,
  logLines: [],
  logTotal: 0,
  logLoading: false,
  confirm: null,
  working: null,
}

// ── Non-reactive module scope: the request epochs (the results-store idiom) ──
//
// `requestSeq` guards the LIST (a filter/search change mid-flight supersedes
// the older response); `detailSeq` guards the expand fetch; `logSeq` guards
// the dialog backfill; `usageSeq` guards the footer figure. `debounce` is
// the search timer — cleared on `reset`/teardown so a late timer never
// refires a load after the store was disposed. `logCursor` is the log
// backfill's resume point (the last response's `next_seq`).

let requestSeq = 0
let detailSeq = 0
let logSeq = 0
let usageSeq = 0
let debounce: ReturnType<typeof setTimeout> | null = null
let logCursor: number | null = null

/**
 * The four board filter options → the provider query's `kind` / `status`
 * parameters ('all' sends neither — the unconstrained list). The
 * multi-value `stopped,failed` is the grown contract (GAP-HIST-3,
 * RESOLVED): one call, OR semantics.
 */
function filterQuery(filter: TxrHistoryFilter): { kind?: TxrHistoryKind; status?: string } {
  switch (filter) {
    case 'learned':
      return { kind: 'learned' }
    case 'saved-model':
      return { kind: 'saved-model' }
    case 'stopped-failed':
      return { status: 'stopped,failed' }
    case 'all':
      return {}
  }
}

/** The last `LOGS_CAP` lines by seq; a duplicate seq keeps its first line. */
function mergeLogLines(
  current: TxrRunLogLine[],
  incoming: TxrRunLogLine[],
): TxrRunLogLine[] {
  if (incoming.length === 0) return current
  const bySeq = new Map<number, TxrRunLogLine>()
  for (const line of [...current, ...incoming]) {
    if (!bySeq.has(line.seq)) bySeq.set(line.seq, line)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-LOGS_CAP)
}

/** A configuration for the E screen's settings-again path (DEC-6): the run's
 *  own recorded settings fields + `label_day: null`. `label_day` was derived
 *  from the run's files; the user re-picks the same files, so re-derivation
 *  is the honest default. `last_input_summary: null` — a copy-cleared run has
 *  no input summary and none is fabricated.
 *
 * The `unknown` bridge: the generated client's `RunConfig` types `label_day`
 * as a plain optional (`label_day?: number`) — the provider regen collapses
 * a nullable-and-optional OpenAPI field — while the engine contract carries
 * `label_day: null` explicitly and this node's pins require the exact bytes
 * (TEST-HIST-4's exact-shape row). The bytes emitted are exactly the
 * engine's, and the bridge is type-level only — the same class the
 * `txrrun` `toRunConfig` bridge documents (ui-run ITEM-4). */
function settingsConfig(settings: TxrHistoryDetail['settings']): RunConfig {
  return {
    endpoint: settings.endpoint,
    decision_day: settings.decision_day,
    look_ahead_day: settings.look_ahead_day,
    covariates: settings.covariates,
    at_a_time: settings.at_a_time,
    ...(settings.cpus !== undefined ? { cpus: settings.cpus } : {}),
    save_models: settings.save_models,
    label_day: null,
  } as unknown as RunConfig
}

const TxrHistoryDef = defineStore('TxrHistory', {
  state: DEFAULT_STATE,
  actions: (set, get) => {
    /**
     * The FIRST page under the active filter/query (`offset: 0` always —
     * a filter/search change restarts the list, never continues it).
     * Seq-guarded: a response from an older request is discarded.
     */
    const loadFirstPage = async (): Promise<void> => {
      const seq = ++requestSeq
      set({ loading: true, error: null })
      try {
        const { filter, q } = get()
        const page = await ApiClient.History.listHistory({
          limit: PAGE_SIZE,
          offset: 0,
          ...(q ? { q } : {}),
          ...filterQuery(filter),
        })
        if (seq !== requestSeq) return
        set({ items: page.items, total: page.total, loading: false })
      } catch {
        if (seq !== requestSeq) return
        set({ loading: false, error: 'network' })
      }
    }

    /**
     * The next page at `offset = items.length` (the provider's continuation
     * point — the server orders and pages, the store only appends).
     * Seq-guarded the same way; a failed continuation leaves the shown
     * pages + the Load-more affordance (the button is the retry).
     */
    const loadMore = async (): Promise<void> => {
      if (get().loadingMore || get().loading) return
      const seq = ++requestSeq
      const offset = get().items.length
      set({ loadingMore: true })
      try {
        const { filter, q } = get()
        const page = await ApiClient.History.listHistory({
          limit: PAGE_SIZE,
          offset,
          ...(q ? { q } : {}),
          ...filterQuery(filter),
        })
        if (seq !== requestSeq) return
        set(s => ({
          items: [...s.items, ...page.items],
          total: page.total,
          loadingMore: false,
        }))
      } catch {
        if (seq !== requestSeq) return
        set({ loadingMore: false })
      }
    }

    /** Fresh first page + usage — the mount/focus/after-action refresh (DEC-11). */
    const reload = async (): Promise<void> => {
      await loadFirstPage()
      void refreshUsage()
    }

    /** The error state's Retry affordance: refires the first-page load. */
    const retryLoad = async (): Promise<void> => {
      await loadFirstPage()
    }

    /** The footer's usage figure (run count + the data-root size walk). */
    const refreshUsage = async (): Promise<void> => {
      const seq = ++usageSeq
      set({ usageLoading: true })
      try {
        const usage = await ApiClient.History.getUsage()
        if (seq !== usageSeq) return
        set({ usage, usageLoading: false })
      } catch {
        if (seq !== usageSeq) return
        set({ usageLoading: false })
      }
    }

    /** The keep-copies preference (the footer's two links' state). */
    const refreshPreferences = async (): Promise<void> => {
      try {
        const preferences = await ApiClient.History.getPreferences()
        set({ preferences })
      } catch {
        /* keep the current (null) state — the link renders conservatively */
      }
    }

    /** The controlled search input (immediate) + the debounced wire query. */
    const setSearch = (value: string): void => {
      set({ searchInput: value })
      if (debounce !== null) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = null
        set({ q: get().searchInput })
        void loadFirstPage()
      }, SEARCH_DEBOUNCE_MS)
    }

    /** One of the four board filter options — starts the list over. */
    const setFilter = (filter: TxrHistoryFilter): void => {
      if (get().filter === filter) return
      set({ filter })
      void loadFirstPage()
    }

    /**
     * Toggle the one expanded row (DEC-8). On expand: ONE `getHistory`
     * (bounded, never an N+1 on list load); a 404 or network failure leaves
     * the row's collapsed data (`detail = null`) — the block is the row's
     * own data, never a page crash.
     */
    const expand = async (runId: string): Promise<void> => {
      if (get().expandedId === runId) {
        set({ expandedId: null, detail: null, detailLoading: false })
        return
      }
      set({ expandedId: runId, detail: null, detailLoading: true })
      const seq = ++detailSeq
      try {
        const detail = await ApiClient.History.getHistory({ id: runId })
        if (seq !== detailSeq || get().expandedId !== runId) return
        set({ detail, detailLoading: false })
      } catch {
        if (seq !== detailSeq || get().expandedId !== runId) return
        set({ detail: null, detailLoading: false })
      }
    }

    /**
     * The terminal-snapshot log dialog (DEC-10 — the SHAPE of the results
     * module's dialog, not its store-bound live stream): open for a run
     * with an optional method filter, clear the buffer, backfill the first
     * page.
     */
    const openLog = async (runId: string, methodId: string | null): Promise<void> => {
      // A FRESH open starts the backfill at the first page: the resume
      // cursor is the previous session's, and a re-opened dialog (a
      // different run or a different method filter — the page re-opens on
      // the dialog's method change) must not continue a stale cursor
      // (ITEM-5, DRIFT-1).
      logCursor = null
      set({ logDialog: { runId, methodId }, logLines: [], logTotal: 0, logLoading: true })
      await loadLogs()
    }

    /**
     * Backfill the next log page at the server-declared resume point
     * (`next_seq` of the previous response); lines merge seq-de-duped and
     * `LOGS_CAP`-capped. A failure keeps the current lines (the dialog
     * shows what it has; a retry continues the backfill).
     */
    const loadLogs = async (): Promise<void> => {
      const dialog = get().logDialog
      if (!dialog) return
      const seq = ++logSeq
      try {
        const response = await ApiClient.Txr.listRunLogs({
          id: dialog.runId,
          limit: LOGS_PAGE_SIZE,
          ...(dialog.methodId ? { method_id: dialog.methodId } : {}),
          ...(logCursor !== null ? { after_seq: logCursor } : {}),
        })
        if (seq !== logSeq || get().logDialog?.runId !== dialog.runId) return
        logCursor = response.next_seq
        set(s => ({
          logLines: mergeLogLines(s.logLines, response.lines),
          logTotal: response.total,
          logLoading: false,
        }))
      } catch {
        if (seq !== logSeq || get().logDialog?.runId !== dialog.runId) return
        set({ logLoading: false })
      }
    }

    const closeLog = (): void => {
      logCursor = null
      set({ logDialog: null, logLines: [], logTotal: 0, logLoading: false })
    }

    const openConfirm = (kind: NonNullable<TxrHistoryState['confirm']>): void => {
      set({ confirm: kind })
    }

    const closeConfirm = (): void => set({ confirm: null })

    /**
     * The retention-preference transition (DEC-13). The confirmation state
     * is the gate — with none open this is a NO-OP (zero network calls,
     * INV-2). OFF: PUT the preference, then POST the all-runs copy clear
     * (the provider's future-default + immediate-clear semantics, OWNER-
     * HIST-2's built default), then reload. ON: PUT only — the transition
     * never restores removed copies (the dialog states it). The known new
     * state is echoed locally (`updatePreferences` answers 204 with no
     * body — the PUT body IS the state, the row's own echo, never a
     * refetch).
     */
    const setKeepCopies = async (keep: boolean): Promise<void> => {
      if (get().confirm !== (keep ? 'copies-on' : 'copies-off')) return
      set({ confirm: null, working: 'preferences' })
      try {
        await ApiClient.History.updatePreferences({ keep_file_copies: keep })
        if (!keep) await ApiClient.History.clearAllCopies()
        set({ preferences: { keep_file_copies: keep } })
        await reload()
      } catch {
        /* the transition failed: the preference state stays as it was,
           the confirmation was consumed (a retry re-opens the dialog) */
      } finally {
        set({ working: null })
      }
    }

    /**
     * "Clear all history" (OWNER-HIST-3's two-choice dialog): the
     * confirmation state is the gate; `delete_files` follows the choice.
     * Model trees under the data root are untouched (model-store's — the
     * engine's DELETE is run-records + run dirs, non-scope here).
     */
    const clearAllHistory = async (deleteFiles: boolean): Promise<void> => {
      if (get().confirm !== 'clear-all') return
      set({ confirm: null, working: 'clear-all' })
      try {
        await ApiClient.Txr.clearRuns({ delete_files: deleteFiles })
        await reload()
      } catch {
        /* the confirmation was consumed; a retry re-opens the dialog */
      } finally {
        set({ working: null })
      }
    }

    /**
     * "Run again with the same settings" (CONS-HIST-8): the engine replays
     * the stored copies and returns the NEW run summary (the page navigates
     * to `runningPath(newId)` — the store's job ends at the id, the route
     * builders are the page's). Only reachable when the row's capability
     * resolution says `rerun` — this action itself never re-checks
     * `can_rerun` (the row's flags are the truth; the plan's TEST-HIST-6
     * asserts the exclusivity at the actions layer).
     */
    const rerun = async (runId: string): Promise<TxrRunSummary> => {
      set({ working: runId })
      try {
        const summary = await ApiClient.Txr.rerunRun({ id: runId })
        void reload()
        return summary
      } finally {
        set({ working: null })
      }
    }

    /**
     * "Use these settings again" (DEC-6 — the copy-cleared run's path):
     * PUT the run's own settings into the engine's sticky config
     * (`label_day: null`, `last_input_summary: null` — see `settingsConfig`)
     * and navigate (the page's `chooseMethodsPath`). This path NEVER calls
     * `rerunRun` — the stored copies are gone; a rerun would 400.
     */
    const useSettingsAgain = async (run: TxrHistoryDetail): Promise<void> => {
      // Same nullable-and-optional collapse as `label_day`: the generated
      // `TxrAppConfig.last_input_summary` types the field optional-only while
      // the engine contract carries `null` explicitly — the bridge is
      // type-level, the bytes are the engine's (the `txrrun` toRunConfig
      // class, DEC-6's `never a fabricated input summary`).
      const body = {
        config: settingsConfig(run.settings),
        last_input_summary: null,
      } as unknown as TxrAppConfig
      await ApiClient.Txr.updateAnalysisConfig(body)
      void reload()
    }

    const reset = (): void => {
      requestSeq += 1
      detailSeq += 1
      logSeq += 1
      usageSeq += 1
      logCursor = null
      if (debounce !== null) {
        clearTimeout(debounce)
        debounce = null
      }
      set({ ...DEFAULT_STATE })
    }

    return {
      loadFirstPage,
      loadMore,
      reload,
      retryLoad,
      refreshUsage,
      refreshPreferences,
      setSearch,
      setFilter,
      expand,
      openLog,
      loadLogs,
      closeLog,
      openConfirm,
      closeConfirm,
      setKeepCopies,
      clearAllHistory,
      rerun,
      useSettingsAgain,
      reset,
    }
  },
  init: ({ onCleanup, actions }) => {
    // K owns no live channel and subscribes to no sync bus (PROV-HIST-8,
    // provider DEC-11): freshness is reload-on-mount/focus + after each
    // action. Teardown drops the whole state and the pending search timer.
    onCleanup(() => actions.reset())
  },
})

/** The reactive store PROXY consumers import (whole-store-lazy:
 *  `registerLazyStore` self-registers under `'TxrHistory'` — the module's
 *  `stores: []` is deliberate, so a consumer import is the only thing that
 *  loads this chunk). */
export const TxrHistory = registerLazyStore(TxrHistoryDef)

/** The vanilla store handle (the tests + the ITEM-4/5 use of `getState`). */
export const useTxrHistory = TxrHistoryDef.store
