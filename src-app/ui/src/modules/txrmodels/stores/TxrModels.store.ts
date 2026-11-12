/**
 * txrmodels store (PROV-UI-MODELS-3) — the host-level state of the model
 * screens: the D/I list state (selection, filters, sort, search), the
 * at-a-time choice, the save dialogs' draft name, the J "Use" handoff id,
 * the open dialog, the per-card download views, and the four data slices
 * the pages render through (the inventory from the intake GAP, the
 * pretrained catalogue list, the saved models + sets, the saved-model
 * eligibility verdicts). The row/filter/sort BUILDERS stay pure in `lib/*`
 * (ITEM-4); the screens compose.
 *
 * Whole-store-lazy: `registerLazyStore` in this file, the `txrresults` /
 * `txrrun` precedent — the module declares `stores: []` and a consumer
 * import is the only thing that loads this chunk.
 *
 * Persistence posture (INV-7, the plan's pin): NO zustand `persist`
 * middleware, ever — the d/i/j state touches the current analysis' file
 * summary, and the intake store (PROV-UI-INTAKE-2's DEC-4) is the one
 * store that persists its SMALL fields. A reload gives a fresh host state:
 * nothing patient-adjacent is written to browser storage, and the engine
 * (model-store, pretrained-catalogue) is the durability point for the
 * model rows themselves.
 *
 * Fetch semantics (the `useMethodRows` precedent, PROV-UI-LIST-3):
 *
 * - `loadEligibility` is keyed by a STABLE INVENTORY HASH (`txrlist`'s
 *   `stableInventoryKey` — the ONE canonicalization, never a second
 *   implementation): two content-identical inventory objects hash to the
 *   same key, so the verdicts are fetched once per inventory and refetched
 *   only when the inventory CONTENT changes (`{force}` is the retry/refresh
 *   path). The request body carries the store's inventory object verbatim
 *   (the ui-list DEC-15 ONE-inventory pin).
 * - Every async continuation is epoch-guarded: `reset()` bumps every
 *   slice epoch, a newer load of the same slice supersedes an older one,
 *   and a stale response (an older eligibility resolve landing after a
 *   newer one, or any resolve after `reset()`) never writes — the
 *   newer totals stay.
 * - `requestDownload` starts the provider's download and POLLS the
 *   download manager at a fixed interval (`DOWNLOAD_POLL_MS`) until a
 *   TERMINAL state (`ready` / `failed`) — the terminal value is committed
 *   ONCE, then the poll stops; `reset()` (the store teardown path) aborts
 *   every running poll. Each poll's writes touch ONLY its own
 *   `downloadState[id]` entry (the D card subtree is the only reader; a
 *   consumer selecting a different id keeps its reference).
 *
 * The store keeps the provider's wire vocabulary verbatim
 * (`PretrainedDownloadStatus.state`, `PretrainedSummary`, `ModelEligibility`,
 * …) — never a restated enum, so a provider regen that reshapes a payload
 * breaks the typecheck here (the txrlist DEC-11 move).
 */
import { ApiClient } from '@/api-client'
import type {
  InventoryEligibilityRequest,
  ModelEligibility,
  PretrainedDownloadStatus,
} from '@/api-client/types'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'
import { useTxrIntakeStore } from '@/modules/txrintake'
import {
  stableInventoryKey,
  toggle as listToggle,
  toggleAllCanRun as listToggleAllCanRun,
  type TxrSelectableRow,
} from '@/modules/txrlist'
import type {
  TxrModelDialogId,
  TxrModelFilterId,
  TxrModelSortId,
  TxrModelsState,
} from '../types'

/** The download manager's poll interval (the D column's progress cadence). */
export const DOWNLOAD_POLL_MS = 2000

/** The bottom bar's "N run at a time" birth value — the engine's own
 *  default verbatim (PROV-EE-2: three at a time). */
export const DEFAULT_AT_A_TIME = 3

const BIRTH_STATE: TxrModelsState = {
  inventory: null,
  pretrained: { cards: [], loading: false, error: null },
  saved: { summaries: [], sets: [], loading: false, error: null },
  eligibility: { byKey: new Map(), totals: null, loading: false, error: null },
  selection: new Set<string>(),
  filters: [],
  sort: 'transfer',
  search: '',
  atATime: DEFAULT_AT_A_TIME,
  draftName: '',
  pendingUseModelId: null,
  dialog: 'none',
  downloadState: {},
}

/** The one failure line every load action surfaces (the Datasets idiom:
 *  the thrown message, else the operation's constant). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.'
}

// ── Non-reactive module scope (the results-store idiom) ────────────────────
//
// `epoch` is the store-wide generation: `reset()` bumps it and every
// async continuation captures it, so a pending response from before a
// reset never writes the new state (the no-setState-after-dispose pin).
// The per-slice epochs add the "a NEWER load of the same slice supersedes"
// part: each load bumps its own slice counter and drops work whose epoch
// is no longer current — an old eligibility resolve is discarded when a
// newer one (same slice) landed, while an unrelated slice's load can
// never invalidate it.

let epoch = 0
let pretrainedEpoch = 0
let savedEpoch = 0
let eligEpoch = 0
let lastEligKey: string | null = null

/**
 * The verdicts' memo key: the stable inventory hash (the PRIMARY
 * discriminator — the plan's "inventory-hash keyed") joined with the
 * SORTED model id list. The id list is part of the key because the
 * verdicts answer a specific model set: a model saved since the last
 * fetch would silently keep the older verdicts (an I screen that refetches
 * the models after a save and then scores them would be skipped by an
 * inventory-only key and show the new row missing from its verdicts).
 */
function eligibilityKey(inventory: InventoryEligibilityRequest, modelIds: string[]): string {
  return `${stableInventoryKey(inventory)}|id:${[...modelIds].sort().join(',')}`
}

/** One running download poll: the interval handle, its abort token and
 *  the terminal latch ("committed once": a stopped poll never writes the
 *  entry again, however late its in-flight tick returns). */
const downloadPolls = new Map<
  string,
  { timer: ReturnType<typeof setInterval> | null; controller: AbortController; done: boolean }
>()

const TxrModelsDef = defineStore('TxrModels', {
  state: BIRTH_STATE,
  actions: (set, get) => {
    /**
     * Full birth reset + abort of every live poll: the `onCleanup`
     * teardown AND the start-over path. Every pending load or poll
     * response is dropped by the epoch bumps + the aborts; the
     * `downloadState` map clears.
     */
    const reset = (): void => {
      epoch += 1
      pretrainedEpoch += 1
      savedEpoch += 1
      eligEpoch += 1
      lastEligKey = null
      for (const poll of downloadPolls.values()) {
        poll.done = true
        if (poll.timer !== null) clearInterval(poll.timer)
        poll.controller.abort()
      }
      downloadPolls.clear()
      set({ ...BIRTH_STATE })
    }

    /**
     * The inventory-change reset (TEST-MOD-04's pin): ONLY the
     * inventory-scoped host state clears — selection, the chip filters,
     * the download views and the saved-model verdicts (they answer
     * "with THIS file"). The J "Use" handoff id, the draft set name, the
     * dialog, the sort/search and the at-a-time choice are NOT
     * inventory-scoped and stay; the catalogue and saved lists do not
     * depend on the file and are kept (no refetch flash). Deliberately
     * NOT `reset()`: that would drop `pendingUseModelId` mid-handoff
     * (DEC-10 — a model the user just marked Use, then adds the predict
     * file, then reaches I with its preselect gone).
     */
    const resetForInventory = (): void => {
      eligEpoch += 1
      lastEligKey = null
      set(s => ({
        selection: new Set<string>(),
        filters: [],
        downloadState: {},
        eligibility: { byKey: new Map(), totals: null, loading: false, error: null },
        pretrained: s.pretrained,
        saved: s.saved,
      }))
    }

    /**
     * The inventory GAP read (CONS-UM-11): the ONE
     * `InventoryEligibilityRequest` is the intake store's
     * `validation.inventory` — never re-derived, never rebuilt. A null
     * validation (no validated file yet) sets the inventory null and the
     * pages render their not-ready states. A content change (stable
     * hash) applies the inventory-scoped reset first; a
     * content-identical refresh just swaps the object reference.
     */
    const loadInventory = (): void => {
      const next = useTxrIntakeStore.getState().validation?.inventory ?? null
      const current = get().inventory
      if (current === next) return
      if (
        current === null ||
        next === null ||
        stableInventoryKey(next) !== stableInventoryKey(current)
      ) {
        resetForInventory()
      }
      set({ inventory: next })
    }

    /**
     * The D screen's data slice: `GET /api/txr/pretrained` (PROV-PC-3),
     * once per screen mount; `{force}` is the retry. A newer load
     * supersedes an older one by epoch; `reset()` drops in-flight work.
     */
    const loadPretrained = async (opts: { force?: boolean } = {}): Promise<void> => {
      if (opts.force !== true && get().pretrained.loading) return
      const myEpoch = ++pretrainedEpoch
      const runEpoch = epoch
      set(s => ({ pretrained: { ...s.pretrained, loading: true, error: null } }))
      try {
        const res = await ApiClient.Pretrained.listModels()
        if (myEpoch !== pretrainedEpoch || runEpoch !== epoch) return
        set(s => ({ pretrained: { cards: res.models, loading: false, error: null } }))
      } catch (error) {
        if (myEpoch !== pretrainedEpoch || runEpoch !== epoch) return
        set(s => ({
          pretrained: { ...s.pretrained, loading: false, error: errorText(error) },
        }))
      }
    }

    /**
     * The I screen's data slice: the saved models (`GET /api/txr/models`)
     * and the sets (`GET /api/txr/model-sets`) in one join — the rows and
     * the section headers are built from the pair (PROV-MS-2/4).
     */
    const loadSaved = async (opts: { force?: boolean } = {}): Promise<void> => {
      if (opts.force !== true && get().saved.loading) return
      const myEpoch = ++savedEpoch
      const runEpoch = epoch
      set(s => ({ saved: { ...s.saved, loading: true, error: null } }))
      try {
        const [modelsRes, setsRes] = await Promise.all([
          ApiClient.Models.listModels({}),
          ApiClient.ModelSets.listSets(),
        ])
        if (myEpoch !== savedEpoch || runEpoch !== epoch) return
        set(s => ({
          saved: { summaries: modelsRes.models, sets: setsRes.sets, loading: false, error: null },
        }))
      } catch (error) {
        if (myEpoch !== savedEpoch || runEpoch !== epoch) return
        set(s => ({ saved: { ...s.saved, loading: false, error: errorText(error) } }))
      }
    }

    /**
     * The saved-model verdicts (PROV-MS-9) for the CURRENT inventory —
     * one per key (`eligibilityKey`): a second call with a
     * content-identical inventory AND the same model id set refetches
     * nothing (the "same key → no refetch" memo), a changed inventory or
     * a changed id set refetches, `{force}` is the retry. The body
     * carries the ONE inventory object verbatim and the model ids the
     * caller passes (the I screen's saved rows).
     */
    const loadEligibility = async (
      modelIds: string[],
      opts: { force?: boolean } = {},
    ): Promise<void> => {
      const inventory = get().inventory
      if (!inventory) {
        set(s => ({
          eligibility: { ...s.eligibility, loading: false, error: null },
        }))
        return
      }
      const key = eligibilityKey(inventory, modelIds)
      if (opts.force !== true && key === lastEligKey) return
      const myEpoch = ++eligEpoch
      const runEpoch = epoch
      lastEligKey = key
      set(s => ({ eligibility: { ...s.eligibility, loading: true, error: null } }))
      try {
        if (modelIds.length === 0) {
          if (myEpoch !== eligEpoch || runEpoch !== epoch) return
          set(s => ({
            eligibility: {
              byKey: new Map<string, ModelEligibility | null>(),
              totals: { fit: 0, some: 0, cannot: 0 },
              loading: false,
              error: null,
            },
          }))
          return
        }
        const res = await ApiClient.Models.checkEligibility({ model_ids: modelIds, inventory })
        if (myEpoch !== eligEpoch || runEpoch !== epoch) return
        const byKey = new Map<string, ModelEligibility | null>()
        for (const id of modelIds) byKey.set(id, null)
        for (const entry of res.models) byKey.set(entry.id, entry)
        set(s => ({
          eligibility: {
            byKey,
            totals: { fit: res.total_fit, some: res.total_some, cannot: res.total_cannot },
            loading: false,
            error: null,
          },
        }))
      } catch (error) {
        if (myEpoch !== eligEpoch || runEpoch !== epoch) return
        set(s => ({
          eligibility: { ...s.eligibility, loading: false, error: errorText(error) },
        }))
      }
    }

    /**
     * Start one catalogue asset's download and poll the download manager
     * until a terminal state (PROV-PC-6/7 — the environment-download
     * idiom, one order of magnitude simpler than the method-env SSE).
     *
     * - a `downloading` entry (or a live poll) is a no-op — the D card's
     *   button never double-starts;
     * - `POST /api/txr/pretrained/{id}/download` returns the first status
     *   verbatim; a status already terminal (`ready` — bundled/cached —
     *   or `failed`) is committed once and no poll starts;
     * - otherwise the manager is polled every `DOWNLOAD_POLL_MS`; each
     *   tick writes ONLY this id's entry (scoped), commits the terminal
     *   status ONCE and stops; a transient poll failure surfaces the
     *   error line on the entry and keeps polling (the retry/backoff
     *   polish is ITEM-5's hook);
     * - `reset()` aborts every live poll (AbortController + the terminal
     *   latch — a late in-flight tick never writes an aborted run);
     * - the D Run gate reads `downloadState[id]` + the row's own
     *   `PretrainedSummary.state`: a failed entry keeps its selection
     *   but Run stays disabled (DEC-8) until it installs or the user
     *   unselects it.
     */
    const requestDownload = async (id: string): Promise<void> => {
      const existing = get().downloadState[id]
      if (existing?.status?.state === 'downloading' || downloadPolls.has(id)) return
      const runEpoch = epoch
      const controller = new AbortController()
      const entry: {
        timer: ReturnType<typeof setInterval> | null
        controller: AbortController
        done: boolean
      } = { timer: null, controller, done: false }
      const stale = (): boolean => entry.done || runEpoch !== epoch || controller.signal.aborted
      /** Scoped write: ONLY the entry for this id is rebuilt; every other
       *  entry keeps its reference (the D card subtree is the only reader
       *  of its own id — the write-scope pin). */
      const commit = (status: PretrainedDownloadStatus | null, error: string | null): void => {
        if (stale()) return
        set(s => ({
          downloadState: { ...s.downloadState, [id]: { status, error } },
        }))
      }
      const stop = (): void => {
        if (entry.done) return
        entry.done = true
        if (entry.timer !== null) clearInterval(entry.timer)
        downloadPolls.delete(id)
      }
      try {
        const started = await ApiClient.Pretrained.downloadModel({ id })
        if (stale()) return
        commit(started, null)
        if (started.state === 'ready' || started.state === 'failed') return
        const timer = setInterval(async () => {
          if (entry.done) return
          try {
            const res = await ApiClient.Pretrained.listDownloads()
            if (entry.done || stale()) return
            const status = res.downloads.find(d => d.id === id) ?? null
            if (!status) return
            commit(status, null)
            if (status.state === 'ready' || status.state === 'failed') stop()
          } catch (error) {
            if (entry.done) return
            // Keep the last reported status (the bytes stay visible) and
            // surface the failure line; the next good tick clears it.
            set(s => {
              if (stale()) return {}
              const last = s.downloadState[id]?.status ?? null
              return {
                downloadState: {
                  ...s.downloadState,
                  [id]: { status: last, error: errorText(error) },
                },
              }
            })
          }
        }, DOWNLOAD_POLL_MS)
        entry.timer = timer
        downloadPolls.set(id, entry)
      } catch (error) {
        if (stale()) return
        commit(null, errorText(error))
      }
    }

    return {
      loadInventory,
      loadPretrained,
      loadSaved,
      loadEligibility,
      requestDownload,
      reset,

      /** Toggle ONE row's checkbox — delegates the disabled-row rule to
       *  txrlist's pure helper (the module never re-implements selection
       *  semantics; the helper returns the SAME set on a no-op and the
       *  store skips the write). */
      toggle: (row: TxrSelectableRow): void => {
        set(s => {
          const next = listToggle(s.selection, row)
          return next === s.selection ? {} : { selection: next }
        })
      },

      /** "Select all that can run" — the boards' toggle-to-all rule, via
       *  txrlist's helper over the passed rows (never a re-implementation). */
      toggleAllCanRun: (rows: ReadonlyArray<TxrSelectableRow>): void => {
        set(s => {
          const next = listToggleAllCanRun(s.selection, rows)
          return next === s.selection ? {} : { selection: next }
        })
      },

      /** The shared list's CONTROLLED write (PROV-UI-MODELS-5's host
       *  wiring): `TxrSelectList` reports the complete next selection set
       *  and the store is its owner — the inventory-change reset clears
       *  selection (a page-local set would survive it, DEC-8's
       *  file-scoped rule). The semantic transitions stay `toggle` /
       *  `toggleAllCanRun` (the txrlist pure helpers); this is the one
       *  raw write the controlled component needs, added at ITEM-6 so
       *  screen D can host the shared list. */
      setSelection: (next: ReadonlySet<string>): void => {
        set(s => (s.selection === next ? {} : { selection: next }))
      },

      /** Toggle one chip id in the active-filter set (the chips are
       *  multi-active host predicates). */
      setFilter: (id: TxrModelFilterId): void => {
        set(s => {
          const active = s.filters.includes(id)
          return {
            filters: active ? s.filters.filter(f => f !== id) : [...s.filters, id],
          }
        })
      },

      setSort: (id: TxrModelSortId): void => set({ sort: id }),
      setSearch: (search: string): void => set({ search }),
      setAtATime: (n: number): void => set({ atATime: n }),
      setDraftName: (name: string): void => set({ draftName: name }),

      /** The J "Use" handoff (DEC-10): one in-memory id the I screen
       *  preselects on mount, then clears. Never persisted. */
      setPendingUse: (modelId: string | null): void => set({ pendingUseModelId: modelId }),

      openDialog: (dialog: TxrModelDialogId): void => set({ dialog }),
      closeDialog: (): void => set({ dialog: 'none' }),
    }
  },
  init: ({ onCleanup, actions }) => {
    // The module store has no `sync:*` subscription (its data is request
    // driven; the run SSE belongs to txrresults). The teardown stops the
    // download polls and drops the whole host state.
    onCleanup(() => actions.reset())
  },
})

export const useTxrModelsStore = TxrModelsDef.store

/**
 * The reactive store PROXY consumers import (whole-store-lazy:
 * `registerLazyStore` self-registers under `'TxrModels'` — the module's
 * `stores: []` is deliberate, PROV-UI-MODELS-3, so a consumer import is
 * the only thing that loads this chunk).
 */
export const TxrModels = registerLazyStore(TxrModelsDef)
