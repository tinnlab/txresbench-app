/**
 * Screen I — Choose the saved models to run (board `Saved.dc.html`; ITEM-7,
 * PROV-UI-MODELS-5): the kept models, grouped by the
 * training run that made them (INV-2), checked against the uploaded
 * predict file (PROV-MS-9's verdicts over the ONE intake inventory,
 * DEC-6), hosted in the SHARED `TxrSelectList` (INV-1 — another host,
 * never a fork), with the set actions and the reuse-mode Run.
 *
 * THE PAGE (the ITEM-1 chrome is the frame this item fills in):
 *
 * - the header: Step 4 of 4 + the board title + the checked-against line
 *   from the CONS-UM-11 validation ("Checked against your file: 42
 *   patients, 4 markers, draws at day 0, 14, 28 and 56. Models from one
 *   training run are grouped; pick any of them." — the facts are the
 *   validation record's, never a design example) and the board's totals
 *   line (the shown count is the store's, the verdicts the eligibility
 *   response's `fit / cannot / some` — the board's own "partly" word for
 *   the some-patients rows);
 * - the shared list: ONE `TxrListSection` per saved set (ITEM-4's
 *   `buildSavedSections` — the facts line from `SetSummary` + the first
 *   model's trained instant, the select-all, the Rename and the
 *   "Delete the run's models" actions via the provider's
 *   `onSectionAction` — GAP-UM-1's grown prop) and the model rows
 *   (`buildSavedRows`: the model's own label, the DEC-13 decision-day
 *   subtitle, the Trained-by-you/Imported/Pretrained chip, the own-data
 *   AUC text, the verdict + detail, the time, Details);
 * - the I chips + search + sorts: the "Same outcome as my file" chip
 *   (ITEM-4's both-halves predicate over the engine's OWN analysis
 *   outcome facts — `useAnalysisOutcome`'s raw sticky-config read; null
 *   facts match nothing), the "Find a model or run" search (the run's
 *   own text — the set title + facts line — is searched too), the
 *   board's "Newest run first / Patients covered / Time to run" sort
 *   (the shared `sort` field is ONE value; this page adopts its initial
 *   when the value is foreign to its options, and so does D — ITEM-3's
 *   drift #6, documented);
 * - the section actions: Rename opens `TxrRenameSetDialog` (PATCH set
 *   name), Delete the confirm before
 *   `DELETE /api/txr/model-sets/{id}?keep_files=false` (DEC-14 — files
 *   go with the rows, the board's deletion promise in the body), both
 *   then refresh the store's saved slice (the engine is the truth, the
 *   verdicts refetch on the grown/shrunk id set by the store's key);
 * - the row Details action opens `TxrModelDetailsDialog` (the per-id
 *   PROV-MS-2 record);
 * - the J "Use" handoff (DEC-10): a pending id preselects its row on
 *   mount and clears — this page IS the preselect half of the flow;
 * - the bottom bar (selected count, DEC-7 total, no at-a-time/save
 *   controls, the research notice, Run) and the reuse Run: resolve FIRST
 *   (CONS-UM-24 — the selected model uuids → assets verbatim), then
 *   `createRun` (CONS-UM-13: mode reuse, input through the intake
 *   builder, config = the FIRST SELECTED model's own endpoint + horizon
 *   — the I screen has no settings controls, ITEM-6's rule — + the
 *   intake's decision day) → `runningPath(runId)`.
 *
 * STATES: no validated predict file → the not-ready empty state (never a
 * half-built list; the inventory is the validation's — DEC-6); a saved
 * slice or verdict failure → the list's error + Retry; the verdicts still
 * loading → the ITEM-4 NOT_RUNNABLE fallback rows (a row never vanishes);
 * the bottom-bar total is the DEC-7 sum (a selection with unknown
 * estimates renders the bar's "…").
 *
 * Copy rule (INV-4): the totals line's count is the store's own; the
 * boards' numbers are never constants here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import type {
  ModelEligibility,
  ModelEligibilityResponse,
  ModelSummary,
  RunConfig,
} from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import { buildTxrRunInput, TxrIntake, useTxrIntakeStore } from '@/modules/txrintake'
import { countSelected, formatTotalTime, TxrSelectList } from '@/modules/txrlist'
import { predictFilesPath, runningPath } from '@/modules/txrrun'
import { Alert, Button } from '@txresbench/kit'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { TxrUseExampleButton } from '@/modules/txrintake'
import { useAnalysisOutcome } from '../data/useAnalysisOutcome'
import { buildSavedRows, buildSavedSections } from '../lib/rows'
import {
  filterRows,
  savedChipPredicate,
  type TxrModelSortable,
} from '../lib/filters'
import { totalSecondsForSelection } from '../lib/total'
import { RESEARCH_NOTICE, formatCheckedAgainstLine, formatSavedTotals } from '../lib/format'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import type { TxrModelDialogId, TxrModelSortId } from '../types'
import { TxrModelDetailsDialog } from '../components/TxrModelDetailsDialog'
import { TxrRenameSetDialog } from '../components/TxrRenameSetDialog'
import { TxrDeleteSetDialog } from '../components/TxrDeleteSetDialog'

/** The page's flex spine (the frame fills the routed area). */
const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The fixed top's own padding (step + title + checked line + use-example + toolbar). */
const PAGE_TOP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '20px 24px 12px',
  minWidth: 0,
}

/** The list toolbar's slot (the toolbar row the shared list splits out). */
const TOOLBAR_SLOT: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }

/** The ONE scroll region's content padding (the region scrolls, the padding rides). */
const REGION_CONTENT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 24px 20px',
  minWidth: 0,
}

const STEP_LINE: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--txr-brand)',
}

const TITLE: CSSProperties = {
  margin: '2px 0 6px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

/** The header row's right-hand totals line (the board's muted span). */
const TOTALS: CSSProperties = { fontSize: 14, color: 'var(--txr-text-2)' }

/** The header block's lead paragraph (the board's own). */
const CHECK_LINE: CSSProperties = { margin: 0, color: 'var(--txr-text-2)', maxWidth: '62ch' }

/** The board's footnote under the list (verbatim — the I board's own). */
const FOOTNOTE: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

/** The not-ready state's line (no validated file — never a half list). */
const EMPTY_LINE = 'Add the patients\u2019 measurements you want to predict first.'

/** The not-ready state's note: which models this screen lists (G4 — the
 *  direct visit used to be one bare line + a button; the saved-models list's
 *  own story is the sets you saved, and the file gate is the step that
 *  unlocks it; the D screen's sibling note is its published-catalogue twin). */
const EMPTY_NOTE =
  'The models you saved from your runs are listed here once the file checks out: each shows its training run and which patients it can score.'

/** The not-ready state's CTA — the step that unlocks this one (RES-20: the
 *  old "Go to the start" landed on the landing page, not the predict-files
 *  step the flow needs next). */
const EMPTY_CTA = 'Go to the measurements step'

/** The empty-selection refusal line (the D page's own rule, stated here). */
const RUN_EMPTY_LINE = 'Select at least one model to run.'

/** The failure line a create failure folds back to (never blank). */
const RUN_FAILED_LINE = 'The models could not be prepared.'

/** I's one host chip (the board's words; the other two chips are the
 *  shared bar's built-in counts). */
interface Ichip {
  id: 'same-outcome'
  label: string
}

const I_CHIPS: readonly Ichip[] = [{ id: 'same-outcome', label: 'Same outcome as my file' }]

/** I's sort options (the board's "Sort by" entries, in the board's order). */
const I_SORT_OPTIONS: ReadonlyArray<{ value: TxrModelSortId; label: string }> = [
  { value: 'newest-run', label: 'Newest run first' },
  { value: 'patients', label: 'Patients covered' },
  { value: 'time', label: 'Time to run' },
]

/** The run's failure text (the framework transport's message, else the constant). */
function errorText(error: unknown): string {
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

/** The "Checked against your file" line from the validation (CONS-UM-11) —
 *  the I board's own tail ("Models from one training run are grouped;
 *  pick any of them."; the formatter lives in lib/format.ts — the D page
 *  renders the same line with its own tail, one implementation). */
function checkedLine(raw: {
  inventory: { patients: number; markers: ReadonlyArray<unknown> }
  measurements?: { distinct_draw_days?: ReadonlyArray<number> } | null
}): string {
  return formatCheckedAgainstLine(
    raw,
    'Models from one training run are grouped; pick any of them.',
  )
}

/** The reuse-mode config: the FIRST SELECTED model's own endpoint/horizon
 *  (the I screen has no settings controls — a model is run at the horizon
 *  it was trained for; ITEM-6's DEC-5 amendment), the intake's decision
 *  day, and the engine-defaults the boards' bars carry (covariates off,
 *  detect CPUs, nothing saved, label day derived). The `unknown` bridge is
 *  the generated client's plain-optional `cpus` / `label_day` (the
 *  toRunConfig class — the wire bytes are the engine's). */
function reuseConfig(first: ModelSummary, decisionDay: number, atATime: number): RunConfig {
  return {
    endpoint: first.endpoint,
    decision_day: decisionDay,
    look_ahead_day: first.horizon,
    covariates: false,
    at_a_time: atATime,
    cpus: null,
    save_models: false,
    label_day: null,
  } as unknown as RunConfig
}

/** The section action dialogs' pending state (which set's action is open). */
interface SectionActionState {
  kind: 'rename' | 'delete'
  set: { id: string; name: string } | null
}

const NO_SECTION_ACTION: SectionActionState = { kind: 'rename', set: null }

export function SavedModelsPage() {
  const navigate = useNavigate()
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const pendingExampleSetId = useStore(useTxrIntakeStore, s => s.pendingExampleSetId)

  const inventory = useStore(useTxrModelsStore, s => s.inventory)
  const saved = useStore(useTxrModelsStore, s => s.saved)
  const eligibility = useStore(useTxrModelsStore, s => s.eligibility)
  const selection = useStore(useTxrModelsStore, s => s.selection)
  const filters = useStore(useTxrModelsStore, s => s.filters)
  const sort = useStore(useTxrModelsStore, s => s.sort)
  const searchText = useStore(useTxrModelsStore, s => s.search)
  const atATime = useStore(useTxrModelsStore, s => s.atATime)
  const dialog = useStore(useTxrModelsStore, s => s.dialog)
  // R2-G1: the tab/title byte is the page's own h1.
  useDocumentTitle('Choose the saved models to run')

  // The store's inventory mirror (ONE object — the intake's, DEC-6): the
  // mount call reads the intake store's validation, and a validation
  // change applies the inventory-scoped reset.
  useEffect(() => {
    useTxrModelsStore.getState().loadInventory()
  }, [validation])

  // The I screen's data slice: saved models + sets in one store join.
  useEffect(() => {
    void useTxrModelsStore.getState().loadSaved()
  }, [])

  // The one shared sort field (ITEM-3's drift #6): this page adopts its
  // board initial when the current value is foreign to its options (the
  // D page does the same — the value only survives a screen change when
  // it is a real option of both).
  useEffect(() => {
    const store = useTxrModelsStore.getState()
    if (!I_SORT_OPTIONS.some(option => option.value === store.sort)) {
      store.setSort('newest-run')
    }
  }, [])

  // The J "Use" handoff (DEC-10): the pending id preselects its row once
  // the saved list has it, then clears. The list is the only place the id
  // can exist, so with no rows yet (the fetch still in flight) the
  // handoff id is KEPT — a slow load must not drop the preselect (the
  // birth state shows `loading: false` before the fetch starts, so the
  // loading flag is not a safe gate); a finished non-empty list that does
  // not contain the id (the model was deleted meanwhile) clears it — a
  // dead handoff, not a stuck selection.
  useEffect(() => {
    const store = useTxrModelsStore.getState()
    const pending = store.pendingUseModelId
    if (pending === null) return
    if (saved.summaries.length === 0) return
    const found = saved.summaries.some(model => model.id === pending)
    if (found && !store.selection.has(pending)) {
      store.setSelection(new Set([...store.selection, pending]))
    }
    store.setPendingUse(null)
  }, [saved.summaries])

  // The ITEM-3 example-set handoff (qa-fixes3 ITEM-4): the reuse-path
  // "Use example" ensured the "Example models" set and parked its id
  // here; once the saved list holds the set, tick EVERY row of it (the
  // plan's "the example set ticked") and clear the handoff. A loaded list
  // with no row of the set (deleted meanwhile) is a dead handoff — clear
  // it too, never a stuck tick.
  useEffect(() => {
    if (pendingExampleSetId === null) return
    if (saved.summaries.length === 0) return
    const keys = saved.summaries
      .filter(model => model.set_id === pendingExampleSetId)
      .map(model => model.id)
    const store = useTxrModelsStore.getState()
    if (keys.length > 0) {
      store.setSelection(new Set([...store.selection, ...keys]))
    }
    TxrIntake.setPendingExampleSet(null)
  }, [saved.summaries, pendingExampleSetId])

  // ── The verdict layer (the ITEM-3 store's PROV-MS-9 slice) ───────────────
  const ids = useMemo(() => saved.summaries.map(model => model.id), [saved.summaries])

  useEffect(() => {
    // The store's key covers (inventory hash + sorted id set): a save or a
    // delete since the last verdict fetch refetches for the new id set.
    void useTxrModelsStore.getState().loadEligibility(ids)
  }, [inventory, ids])

  /** The store's byKey + totals back into the builder's response shape
   *  (the provider's own vocabulary, never restated); an id the response
   *  omitted stays absent — the builders' NOT_RUNNABLE fallback row. */
  const eligResponse = useMemo<ModelEligibilityResponse | null>(() => {
    if (eligibility.totals === null) return null
    const models = saved.summaries
      .map(model => eligibility.byKey.get(model.id) ?? null)
      .filter((verdict): verdict is ModelEligibility => verdict !== null)
    return {
      models,
      total_fit: eligibility.totals.fit,
      total_some: eligibility.totals.some,
      total_cannot: eligibility.totals.cannot,
    }
  }, [saved.summaries, eligibility.byKey, eligibility.totals])

  // ── The row/composition layer (the ITEM-4 pure builders) ─────────────────
  const rows = useMemo(
    () => buildSavedRows(saved.summaries, eligResponse),
    [saved.summaries, eligResponse],
  )
  const sections = useMemo(
    () => buildSavedSections(saved.sets, saved.summaries, eligResponse),
    [saved.sets, saved.summaries, eligResponse],
  )

  /** The sort facts (the comparators' input — the same structured facts
   *  the builders read; I has no transfer facts, a null fact sorts last,
   *  DEC-9). */
  const sortable = useMemo(() => {
    const m = new Map<string, TxrModelSortable>()
    for (const model of saved.summaries) {
      const verdict = eligibility.byKey.get(model.id) ?? null
      const instant = model.trained_at ?? model.created_at
      const madeAt = instant === undefined ? Number.NaN : Date.parse(instant)
      m.set(model.id, {
        transferCohorts: null,
        transferMedian: null,
        coverage: verdict?.coverage?.fraction ?? null,
        estimateSeconds: verdict?.estimated_seconds ?? null,
        madeAt: Number.isNaN(madeAt) ? null : madeAt,
        id: model.id,
      })
    }
    return m
  }, [saved.summaries, eligibility.byKey])

  /** The chip predicate's source facts: the engine's OWN analysis outcome
   *  (the sticky config read — null facts match nothing, the plan's rule). */
  const outcome = useAnalysisOutcome()
  const modelById = useMemo(
    () => new Map(saved.summaries.map(model => [model.id, model])),
    [saved.summaries],
  )

  /** The active chip predicate over the SOURCE models, applied by row key. */
  const keep = useMemo(() => {
    const predicate = savedChipPredicate(filters, outcome)
    return (key: string): boolean => {
      const model = modelById.get(key)
      return model !== undefined && predicate(model)
    }
  }, [filters, outcome, modelById])

  /** The sort view — the shared field adopted to this board's options (the
   *  store's value converges by the mount effect; the derived read keeps
   *  the first paint sorted by the board initial, never a foreign id). */
  const shownSort: TxrModelSortId = I_SORT_OPTIONS.some(option => option.value === sort)
    ? sort
    : 'newest-run'

  /** The run's searchable text: the row's own facts plus the run it came
   *  from (the set title + facts line — the board's "Find a model or
   *  run"). */
  const searchGroup = useMemo(() => {
    const m = new Map<string, string>()
    for (const section of sections) {
      const text = `${section.title} ${section.subtitle}`
      for (const key of section.rowKeys) m.set(key, text)
    }
    return m
  }, [sections])

  const shown = useMemo(
    () =>
      filterRows(rows, {
        keep,
        search: searchText,
        sort: shownSort,
        sortable,
        searchGroup,
      }),
    [rows, keep, searchText, shownSort, sortable, searchGroup],
  )

  /** The one host chip: the "Same outcome as my file" count over the whole
   *  saved set (its own question, never the current view). */
  const chips = useMemo(
    () =>
      I_CHIPS.map(chip => ({
        id: chip.id,
        label: chip.label,
        count: saved.summaries.filter(savedChipPredicate([chip.id], outcome)).length,
        active: filters.includes(chip.id),
        onToggle: () => useTxrModelsStore.getState().setFilter(chip.id),
      })),
    [saved.summaries, outcome, filters],
  )

  // ── The section actions (rename + delete, both then refresh) ─────────────
  const [sectionAction, setSectionAction] = useState<SectionActionState>(NO_SECTION_ACTION)

  const onSectionAction = useCallback(
    (sectionKey: string, actionId: string): void => {
      const set = saved.sets.find(candidate => candidate.id === sectionKey)
      if (set === undefined) return
      if (actionId === 'rename' || actionId === 'delete') {
        setSectionAction({ kind: actionId, set: { id: set.id, name: set.name } })
      }
    },
    [saved.sets],
  )

  /** The engine is the truth after a rename/delete: refetch the saved
   *  slice; the verdicts follow on the changed id set (the store's key). */
  const refreshSaved = useCallback((): void => {
    void useTxrModelsStore.getState().loadSaved({ force: true })
  }, [])

  // ── The Run path (CONS-UM-24/13 — the I arm of TEST-MOD-32) ──────────────
  const [runError, setRunError] = useState<string | null>(null)
  const creating = useRef(false)

  /**
   * The reuse Run: gate → resolve FIRST (the selected uuids, assets
   * verbatim — never bare uuids in the create call) → create → navigate.
   * ONE create is ever in flight; a gated attempt (empty selection) writes
   * the inline line and NEVER creates the run; a resolve failure (404 /
   * 409) surfaces the response's line inline with no run created.
   */
  const createRun = useCallback(
    async (keys: string[]): Promise<void> => {
      if (keys.length === 0) {
        setRunError(RUN_EMPTY_LINE)
        return
      }
      if (creating.current) return
      creating.current = true
      setRunError(null)
      try {
        const runModels = saved.summaries.filter(model => keys.includes(model.id))
        const { assets } = await ApiClient.Models.resolveModels({
          model_ids: runModels.map(model => model.id),
        })
        const input = buildTxrRunInput({
          patients,
          measurements,
          predictMeasurements,
          joins,
          mapping,
        } as unknown as IntakeSnapshot)
        const run = await ApiClient.Txr.createRun({
          mode: 'reuse',
          input,
          config: reuseConfig(
            runModels[0] ?? firstModel(saved.summaries),
            parameters.decision_day,
            atATime,
          ),
          model_ids: assets,
        })
        navigate(runningPath(run.id))
      } catch (error) {
        setRunError(errorText(error))
      } finally {
        creating.current = false
      }
    },
    [
      saved.summaries,
      patients,
      measurements,
      predictMeasurements,
      joins,
      mapping,
      parameters,
      atATime,
      navigate,
    ],
  )

  // ── The composition edge the header reads (the D page's `totals` alias:
  // the store slice's property is mutable, so the null-narrowing needs the
  // local view — Template literal narrowing on a property access does not
  // apply). ────────────────────────────────────────────────────────────────
  const totals = eligibility.totals

  // ── The ITEM-3 frame composition ─────────────────────────────────────────
  // The audit route table's row for the I route: fixed top = step + title +
  // the checked-against line + the totals + the use-example action + the
  // shared list's TOOLBAR (the list's layout split — the filter chips/
  // search/sort), ONE ScrollRegion = the virtualized grouped model rows
  // (with the footnote), fixed bottom = the shared list's counters + Run
  // bar. The split's stream consumes the region as its scrollport (its own
  // kit ScrollArea is dropped); the not-ready branch renders the same frame
  // without the list chrome.

  /** The page's fixed top (the list's toolbar joins it in the list branch). */
  const pageTop = (toolbar: ReactNode | null): ReactNode => (
    <div className="txr-models-i-top" style={PAGE_TOP}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          {/* The step is the flow's fourth; a page reached directly (no
              validated predict file yet) is not ON step 4 — the step line
              would claim a position the flow has not reached (RES-20); the
              totals line stays hidden too (nothing has been checked). */}
          {validation !== null ? <div style={STEP_LINE}>Step 4 of 4</div> : null}
          <h1 style={TITLE}>Choose the saved models to run</h1>
          {validation !== null ? (
            <p data-testid="txr-models-i-checked" style={CHECK_LINE}>
              {checkedLine(validation)}
            </p>
          ) : null}
        </div>
        {validation !== null ? (
          <span data-testid="txr-models-i-totals" style={TOTALS}>
            {totals === null
              ? '\u2026'
              : formatSavedTotals(
                  saved.summaries.length,
                  totals.fit,
                  totals.some,
                  totals.cannot,
                )}
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <TxrUseExampleButton path="reuse" onDone={() => navigate(predictFilesPath())} />
      </div>
      {toolbar !== null ? (
        <div className="txr-models-i-toolbar" data-testid="txr-models-i-toolbar" style={TOOLBAR_SLOT}>
          {toolbar}
        </div>
      ) : null}
      {runError !== null ? (
        <Alert tone="error" data-testid="txr-models-i-run-error" title={runError} />
      ) : null}
    </div>
  )

  /** The ONE body region (the row stream or the empty state). */
  const bodyRegion = (content: ReactNode): ReactNode => (
    <ScrollRegion label="Saved models" className="txr-models-i-region">
      <div style={REGION_CONTENT}>{content}</div>
    </ScrollRegion>
  )

  const footnote = (
    <p style={FOOTNOTE}>
      A model that cannot run says what is missing from your file. The same list shows
      pretrained models in the other path; only the models differ.
    </p>
  )

  /** The row dialogs (the list's actions — closed in the empty state). */
  const dialogs = (
    <>
      <TxrModelDetailsDialog
        modelId={dialog.startsWith('details:') ? dialog.slice('details:'.length) : null}
        onClose={() => useTxrModelsStore.getState().closeDialog()}
      />
      {sectionAction.kind === 'rename' ? (
        <TxrRenameSetDialog
          set={sectionAction.set}
          onClose={() => setSectionAction(NO_SECTION_ACTION)}
          onSaved={refreshSaved}
        />
      ) : null}
      {sectionAction.kind === 'delete' ? (
        <TxrDeleteSetDialog
          set={sectionAction.set}
          onClose={() => setSectionAction(NO_SECTION_ACTION)}
          onDeleted={refreshSaved}
        />
      ) : null}
    </>
  )

  // The not-ready branch (no validated predict file): the frame, the empty
  // state's own lines in the region (never a half-built list, DEC-6).
  if (validation === null) {
    return (
      <main data-testid="txr-models-i" style={PAGE_OUTER}>
        <PageFrame
          testId="txr-models-i-frame"
          top={pageTop(null)}
          body={bodyRegion(
            <div
              data-testid="txr-models-i-empty"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                alignItems: 'flex-start',
                padding: '24px 0',
              }}
            >
              <p style={CHECK_LINE}>{EMPTY_LINE}</p>
              <p data-testid="txr-models-i-empty-note" style={CHECK_LINE}>
                {EMPTY_NOTE}
              </p>
              <Button
                data-testid="txr-models-i-empty-cta"
                variant="outline"
                onClick={() => navigate(predictFilesPath())}
              >
                {EMPTY_CTA}
              </Button>
            </div>,
          )}
        />
        {dialogs}
      </main>
    )
  }

  return (
    <main data-testid="txr-models-i" style={PAGE_OUTER}>
      <TxrSelectList
        rows={shown}
        sections={sections}
        itemLabel="model"
        selected={selection}
        onSelectionChange={next => useTxrModelsStore.getState().setSelection(next)}
        filterChips={chips}
        search={{
          value: searchText,
          onChange: value => useTxrModelsStore.getState().setSearch(value),
        }}
        sort={{
          value: shownSort,
          options: I_SORT_OPTIONS as { value: string; label: string }[],
          onChange: value => useTxrModelsStore.getState().setSort(value as TxrModelSortId),
        }}
        loading={saved.loading || eligibility.loading}
        error={saved.error ?? eligibility.error}
        onRetry={() => {
          void useTxrModelsStore.getState().loadSaved({ force: true })
          void useTxrModelsStore.getState().loadEligibility(ids, { force: true })
        }}
        bottomBar={{
          selectedCount: countSelected(selection, rows),
          totalTimeText: formatTotalTime(
            totalSecondsForSelection(selection, eligibility.byKey),
          ),
          notice: RESEARCH_NOTICE,
          onRun: keys => {
            void createRun(keys)
          },
        }}
        onRowAction={row => {
          useTxrModelsStore.getState().openDialog(`details:${row.key}` as TxrModelDialogId)
        }}
        onSectionAction={onSectionAction}
        layout={parts => (
          <>
            <PageFrame
              testId="txr-models-i-frame"
              top={pageTop(parts.toolbar)}
              body={bodyRegion(
                <>
                  {parts.rows}
                  {footnote}
                </>,
              )}
              // The shared bar carries its own bar look and goes straight into
              // the bottom slot, as the choose-methods page's run bar does: not
              // inside PageFooterBar, a flex row that would shrink it to its
              // content's width at the left of a wide window.
              bottom={<div data-testid="txr-models-i-bar">{parts.bottomBar}</div>}
            />
            {dialogs}
          </>
        )}
      />
    </main>
  )
}

/**
 * The create path's config source can never be a fabricated record: the
 * empty-selection guard above refuses the run before this call, so the
 * first selected model exists — this fallback is the type-defensive arm
 * (the first model of the saved list, when the compile-time narrowing
 * cannot see the guard's effect). A machine with no saved models at all
 * is the no-models state, never a created run.
 */
function firstModel(summaries: ModelSummary[]): ModelSummary {
  const first = summaries[0]
  if (first !== undefined) return first
  throw new Error('No saved models are available to run.')
}
