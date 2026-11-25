/**
 * The D/I Run as an AI-controllable instance action (`models.run`) and the
 * decision-day rule that gates it (data-pickup-bugs bug 3, UI half).
 *
 * The Run button of the ready-made and saved model steps and the registered
 * `models.run` action share ONE guarded handler: the page registers it
 * through `useAction` (`useModelListRun` below), and the button calls the
 * SAME `startRun` the handler calls, so the guard that refuses a selection
 * of models trained at DIFFERENT decision days is the same for the human
 * and for the assistant path. The engine itself refuses a reuse run whose
 * config day differs from a model's (`MODEL_DECISION_DAY_MISMATCH`, server
 * half) — this is the frontend half of the same rule: the run button is
 * unavailable with the reason instead of letting the user start a run the
 * engine would refuse.
 *
 * `TXR_MODEL_LIST_CONTEXT` doubles as the instance `type` (the
 * `methods.applyPreset` precedent): the agent engine offers `models.run`
 * against the live model-list instance of the step on screen, and the Run
 * button of that step is the human surface for the same registered action.
 * The ⌘K palette does not offer it (`surfaces.palette: false`): a stateful
 * invoke requires the instance's state token, which only the world-model
 * read supplies — the palette can auto-fill `view_id` but not that token.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAction } from '@/core/actions/useAction'
import { useActiveContext } from '@/core/actions/activeContext'
import { checkExpectedToken, createVersioned } from '@/core/actions/versioned'
import { newViewId } from '@/core/actions/instanceRegistry'

/** The one registered Run action of the model step (D, I and the merged list). */
export const MODELS_RUN = 'models.run'

/** The merged list's filter/search/sort action (predict-card merge round 2). */
export const MODELS_SET_LIST_FILTERS = 'models.setListFilters'

/** The merged list's selection action (the row checkboxes + select-all). */
export const MODELS_SET_SELECTION = 'models.setSelection'

/** The instance type of the live model list (D, I or the merged list page)
 *  — the context name. */
export const TXR_MODEL_LIST_CONTEXT = 'txr.model-list'

/** The merged list's source vocabulary (the actions' params). */
export type TxrListSourceId = 'lab' | 'saved' | 'imported'

/** The host chip ids the merged list's actions accept (the non-source chips). */
export const CHOOSE_HOST_CHIP_IDS = [
  'published',
  'learned',
  'checked-2-plus',
  'same-outcome',
] as const

/** The instance snapshot (`views.list` / `view.describe` read it). */
export interface TxrModelListSnapshot extends Record<string, unknown> {
  /** The count of the checked models (the bar's own number, host-computed:
   *  the runnable selection's size, not the raw selection set's). */
  selected_count: number
  /** The keys the run would take, in the selection's order (the runnable
   *  selection — selection minus the rows whose run is disabled). The
   *  snapshot must carry the IDS, not only the count: a changed selection
   *  of the same size must move the `_state_token` (the stale-state
   *  guard's ground truth), and the AI needs to see exactly what the run
   *  would start from before it writes. */
  selected_ids: string[]
  /** Why the run cannot start (different decision days), or null. */
  blocked_reason: string | null
  /** The merged list's active filter state (the same facts the
   *  `setListFilters` run reads — a filter change moves the token too). */
  filters: {
    sources: TxrListSourceId[]
    chips: string[]
    can_run_only: boolean
    search: string
    sort: string
  }
}

/** The runnable-selection row shape (a full `TxrListRow` is assignable). */
export interface ModelRunRow {
  key: string
  run: { disabled: boolean }
}

/** One selected model's own facts (the config + lines' source). */
export interface ModelRunFacts {
  decision_day: number
  horizon: number
}

/** The run's failure line a create failure folds back to (never blank). */
export const RUN_FAILED_LINE = 'The models could not be prepared.'

/** The empty-selection refusal line (the D page's own rule, stated here). */
export const RUN_EMPTY_LINE = 'Select at least one model to run.'

/** The run's failure text (the framework transport's message, else the constant). */
export function runErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return RUN_FAILED_LINE
}

/**
 * The keys the run takes: the given selection keys minus the rows this
 * step can SEE are disabled (the host's full-row view is the final guard —
 * the stale key of a row that became `cannot` is never handed to the
 * engine, while a key of a row currently filtered OUT is kept: the run is
 * the selection, never the view; DEC-9). The SAME set feeds the
 * mixed-days check, the reason, the decision-day and look-ahead lines and
 * the create call — the run can never disagree with what it displays.
 */
export function runnableKeys(
  keys: ReadonlyArray<string>,
  rows: ReadonlyArray<ModelRunRow>,
): string[] {
  const disabled = new Set(rows.filter(row => row.run.disabled).map(row => row.key))
  return [...keys].filter(key => !disabled.has(key))
}

/** The page's facts for the runnable keys, in the run's order. */
function factsFor(
  keys: ReadonlyArray<string>,
  factsOf: (key: string) => ModelRunFacts | undefined,
): ModelRunFacts[] {
  return keys
    .map(factsOf)
    .filter((facts): facts is ModelRunFacts => facts !== undefined)
}

/** The distinct decision days, first occurrence kept (selection order). */
export function distinctDecisionDays(days: readonly number[]): number[] {
  const seen = new Set<number>()
  const distinct: number[] = []
  for (const day of days) {
    if (!seen.has(day)) {
      seen.add(day)
      distinct.push(day)
    }
  }
  return distinct
}

/** The one day-sentence of a distinct-day list: "day 28 and day 56",
 *  "day 28, day 56 and day 90". The days are whole numbers (no trailing
 *  zeros — `String(28)` never spells "28.0"). */
function dayList(days: readonly number[]): string {
  const parts = days.map(day => `day ${day}`)
  if (parts.length === 2) return parts.join(' and ')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * The reason the run is unavailable: the chosen models were trained at
 * different decision days (listed in the order of the selection), or null.
 */
export function mixedDecisionDaysReason(days: readonly number[]): string | null {
  const distinct = distinctDecisionDays(days)
  if (distinct.length <= 1) return null
  return `The models you chose were trained at different decision days (${dayList(distinct)}). Choose models with the same decision day.`
}

/**
 * The read-before-write refusal for a `models.run` invoke whose `expected`
 * state token does not match the live instance's — the SAME words the
 * engine's stale-state guard posts (`core/actions/engine.ts`), so a direct
 * `runAction` caller (the e2e seam, a test, any non-engine surface)
 * observes exactly what the agent engine would have posted: the AI must
 * re-read `view.describe` before writing. The engine enforces the guard
 * BEFORE dispatching (the one uniform place per the skill); this check is
 * the same rule at the handler, so bypassing the engine can never bypass
 * the stale-state guard.
 */
function staleStateError(viewId: string, expected: string | undefined, current: string): Error {
  if (expected === undefined) {
    return new Error(
      `READ_REQUIRED: call view.describe('${viewId}') for its current state token before writing`,
    )
  }
  return new Error(
    `STALE_STATE: view "${viewId}" changed (expected ${expected}, now ${current}); re-read view.describe('${viewId}') and retry`,
  )
}

/** The shared Run path's inputs (`useModelListRun`). */
export interface ModelListRunOptions {
  /** The step's FULL (unfiltered) rows — the host's final run key guard. */
  rows: readonly ModelRunRow[]
  /** The host's live selection (the render you are on). */
  selection: ReadonlySet<string>
  /** Read the selection FRESH at invoke time (the AI path must never trust
   *  a render-time snapshot; the stale-state token is the real check). */
  getSelection(): ReadonlySet<string>
  /** The page's key → own-facts read (decision day + horizon). */
  factsOf(key: string): ModelRunFacts | undefined
  /** The page's RAW create: the runnable keys → the created run's id.
   *  Refusals and failures THROW (with the page's plain text); it must
   *  never report a run that did not start. */
  createRun(keys: readonly string[]): Promise<string>
  /** The merged list's write for `models.setSelection` (the row checkboxes
   *  and the select-all call the action — the human controls and the AI
   *  take one path). Absent on D/I: those pages have no registered
   *  per-row action this round. */
  setSelection?(ids: string[]): void
  /** The merged list's write for `models.setListFilters` (every chip, the
   *  search and the sort call the action). Absent on D/I. */
  setListFilters?(input: {
    sources?: TxrListSourceId[] | null
    canRunOnly?: boolean
    chips?: string[] | null
    search?: string
    sort?: string
  }): void
  /** The merged list's live filter state (the snapshot + the token's
   *  truth — a filter change must move the token like a selection does). */
  listState?(): {
    sources: TxrListSourceId[]
    chips: string[]
    canRunOnly: boolean
    search: string
    sort: string
  }
}

/** The shared Run path's face to a page. */
export interface ModelListRun {
  /** The live instance's `view_id` (the action's target). */
  viewId: string
  /** The live instance's CURRENT state token, read fresh at call time (the
   *  same token `view.describe` returns) — a human control passes it as
   *  the stateful action's `expected`, exactly as the agent path does. */
  stateToken(): string
  /** The keys the run takes (selection order, runnable only). */
  runnable: readonly string[]
  /** The runnable selection's decision days, in the run's order. */
  decisionDays: readonly number[]
  /** The runnable selection's look-ahead days, in the run's order. */
  horizons: readonly number[]
  /** Why the run cannot start (different decision days), or null. */
  blockedReason: string | null
  /** A create is in flight (Back is unavailable until it settles). */
  starting: boolean
  /** The run's inline error line (the page's Alert), or null. */
  runError: string | null
  /**
   * THE one guarded Run: runnable filter → the mixed-days and empty
   * guards → `createRun`. Resolves ONLY with the created run's id;
   * rejects with the exact plain text the page shows (the failure is
   * already written to `runError`). The button and the `models.run`
   * handler both call this.
   */
  startRun(keys: readonly string[]): Promise<string>
}

/**
 * The ONE model-step Run path, shared by the D (ready-made) and I (saved)
 * pages: the live model-list instance (view id, versioned snapshot with
 * the selected model ids, `useAction` registration, active context) and
 * the guarded `startRun` the Run button and the `models.run` action both
 * call. The snapshot carries the RUNNABLE selection's ids (in selection
 * order) so a changed selection of the same size still bumps the version
 * and moves the `_state_token` — the stale-state guard's ground truth.
 */
export function useModelListRun(options: ModelListRunOptions): ModelListRun {
  const { rows, selection, getSelection, factsOf, createRun } = options
  const [viewId] = useState(newViewId)

  // ── The derived facts: exactly the keys the run takes ──────────────────
  // The run passes its keys through `runnableKeys` (the host's full-row
  // final guard) — the mixed-days check, the reason, the decision-day and
  // look-ahead lines and the snapshot MUST read the same set, so a row
  // whose run is disabled but still selected is never counted where the
  // run would not take it.
  const runnable = useMemo(() => runnableKeys([...selection], rows), [selection, rows])
  const chosenFacts = useMemo(() => factsFor(runnable, factsOf), [runnable, factsOf])
  const decisionDays = useMemo(() => chosenFacts.map(facts => facts.decision_day), [chosenFacts])
  const horizons = useMemo(() => chosenFacts.map(facts => facts.horizon), [chosenFacts])
  const blockedReason = useMemo(() => mixedDecisionDaysReason(decisionDays), [decisionDays])

  /** The merged list's live filter state (fresh at snapshot time). */
  const listStateNow = (): { [key: string]: unknown } => {
    const state = options.listState?.() ?? {
      sources: [] as TxrListSourceId[],
      chips: [] as string[],
      canRunOnly: false,
      search: '',
      sort: 'transfer',
    }
    return {
      sources: state.sources,
      chips: state.chips,
      can_run_only: state.canRunOnly,
      search: state.search,
      sort: state.sort,
    }
  }

  // ── The versioned snapshot (`views.list` / `view.describe` read it) ────
  const snapshot = (): TxrModelListSnapshot => ({
    selected_count: runnable.length,
    selected_ids: [...runnable],
    blocked_reason: blockedReason,
    filters: listStateNow() as TxrModelListSnapshot['filters'],
  })
  const [modelListVersioned] = useState(() =>
    createVersioned<TxrModelListSnapshot>(viewId, {
      selected_count: 0,
      selected_ids: [],
      blocked_reason: null,
      filters: { sources: [], chips: [], can_run_only: false, search: '', sort: 'transfer' },
    }),
  )
  const modelListStamped = useRef(snapshot())
  useEffect(() => {
    const last = modelListStamped.current
    const next = snapshot()
    if (
      last.selected_count === next.selected_count &&
      last.blocked_reason === next.blocked_reason &&
      sameIds(last.selected_ids, next.selected_ids) &&
      sameFilters(last.filters, next.filters)
    ) {
      return
    }
    modelListStamped.current = next
    modelListVersioned.set(next)
  })

  // ── The run's own state (one per page, shared here) ────────────────────
  const [starting, setStarting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const inflight = useRef<Promise<string> | null>(null)

  /** THE one guarded Run (see `ModelListRun.startRun`). */
  const startRun = useCallback(
    (keys: readonly string[]): Promise<string> => {
      const taken = runnableKeys(keys, rows)
      if (taken.length === 0) {
        setRunError(RUN_EMPTY_LINE)
        return Promise.reject(new Error(RUN_EMPTY_LINE))
      }
      const reason = mixedDecisionDaysReason(
        factsFor(taken, factsOf).map(facts => facts.decision_day),
      )
      if (reason !== null) {
        setRunError(reason)
        return Promise.reject(new Error(reason))
      }
      // A create already in flight: the same outcome for both callers (the
      // button's double click and a queued same-instance invoke).
      if (inflight.current !== null) return inflight.current
      setRunError(null)
      setStarting(true)
      const run = createRun(taken)
        .then(id => {
          // Success: the page navigates to the Running screen; Back stays
          // unavailable until the route changes (the Running chunk may
          // still load) — the same rule the pages' old create kept.
          return id
        })
        .catch((error: unknown) => {
          const text = runErrorText(error)
          setRunError(text)
          setStarting(false)
          throw new Error(text)
        })
        .finally(() => {
          inflight.current = null
        })
      inflight.current = run
      return run
    },
    [rows, factsOf, createRun],
  )

  // ── The live instance the action targets ───────────────────────────────
  // The Run button's handler and the action's `run` call the SAME guarded
  // `startRun`; the handler additionally re-checks `expected` (the engine
  // already enforced the stale-state guard before dispatching — this is
  // the same rule for a caller that reaches the handler directly), then
  // reads the CURRENT selection fresh: a stale read must never start a run
  // the engine would refuse (the exact reason a model runs at its own day),
  // and the token guard already told a stale caller to re-read.
  useAction(viewId, {
    type: TXR_MODEL_LIST_CONTEXT,
    handlers: (() => {
      const handlers: Record<string, (params: unknown) => unknown> = {
        [MODELS_RUN]: (params: unknown) => {
          const expectedParam = (params as { expected?: unknown }).expected
          const expected = typeof expectedParam === 'string' ? expectedParam : undefined
          const current = modelListVersioned.snapshot()._state_token
          if (checkExpectedToken(current, expected) !== 'ok') {
            throw staleStateError(viewId, expected, current)
          }
          return startRun(runnableKeys([...getSelection()], rows))
        },
      }
      const writeSelection = options.setSelection
      if (writeSelection !== undefined) {
        handlers[MODELS_SET_SELECTION] = (params: unknown) => {
          const expectedParam = (params as { expected?: unknown }).expected
          const expected = typeof expectedParam === 'string' ? expectedParam : undefined
          const current = modelListVersioned.snapshot()._state_token
          if (checkExpectedToken(current, expected) !== 'ok') {
            throw staleStateError(viewId, expected, current)
          }
          const ids = (params as { ids?: unknown }).ids
          writeSelection(
            Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
          )
          return { status: 'applied', selected_ids: getSelection() }
        }
      }
      const writeFilters = options.setListFilters
      if (writeFilters !== undefined) {
        handlers[MODELS_SET_LIST_FILTERS] = (params: unknown) => {
          const expectedParam = (params as { expected?: unknown }).expected
          const expected = typeof expectedParam === 'string' ? expectedParam : undefined
          const current = modelListVersioned.snapshot()._state_token
          if (checkExpectedToken(current, expected) !== 'ok') {
            throw staleStateError(viewId, expected, current)
          }
          const p = (params ?? {}) as {
            sources?: unknown
            canRunOnly?: unknown
            chips?: unknown
            search?: unknown
            sort?: unknown
          }
          writeFilters({
            sources: Array.isArray(p.sources)
              ? (p.sources.filter(
                  (s): s is TxrListSourceId => s === 'lab' || s === 'saved' || s === 'imported',
                ) as TxrListSourceId[])
              : undefined,
            canRunOnly: typeof p.canRunOnly === 'boolean' ? p.canRunOnly : undefined,
            chips: Array.isArray(p.chips) ? (p.chips as string[]) : undefined,
            search: typeof p.search === 'string' ? p.search : undefined,
            sort: typeof p.sort === 'string' ? p.sort : undefined,
          })
          return { status: 'applied', filters: listStateNow() }
        }
      }
      return handlers
    })(),
    getSnapshot: () => modelListVersioned.snapshot(),
  })
  useActiveContext(TXR_MODEL_LIST_CONTEXT, { entityId: viewId })

  return {
    viewId,
    stateToken: () => modelListVersioned.snapshot()._state_token,
    runnable,
    decisionDays,
    horizons,
    blockedReason,
    starting,
    runError,
    startRun,
  }
}

/** Reference-equal or value-equal id lists (the snapshot stamp's compare). */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** The snapshot's filter state compare (a filter change moves the token). */
function sameFilters(
  a: TxrModelListSnapshot['filters'],
  b: TxrModelListSnapshot['filters'],
): boolean {
  return (
    a.can_run_only === b.can_run_only &&
    a.search === b.search &&
    a.sort === b.sort &&
    sameIds(a.sources, b.sources) &&
    sameIds(a.chips, b.chips)
  )
}
