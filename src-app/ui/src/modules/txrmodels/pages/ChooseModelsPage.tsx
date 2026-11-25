/**
 * The merged model step — Choose the models to run (predict-card merge
 * round 2): the ONE list of the predict path's model choice, the three
 * sources in one flat list (the lab catalogue rows, the store's `run` and
 * `imported` rows; a `pretrained` store row is the lab row's downloaded
 * state, never listed twice), hosted in the SHARED `TxrSelectList` (INV-1
 * — another host, never a fork), with one selection over all sources, the
 * mixed-day rule and one reuse-mode Run.
 *
 * THE PAGE:
 *
 * - the header: Step 3 of 3 + "Choose the models to run" + the
 *   checked-against line (the round-2 tail: "Ready-made, saved and imported
 *   models are all here; pick as many as you like.") + the verdicts'
 *   totals ("N models · X can run, Y cannot");
 * - the shared list: the merged rows (lib/rows' `buildChooseRows` — the
 *   small-caps source label first, then today's row), the source chips
 *   (counts, 0-chip disabled, several on = any), the KEPT chips
 *   ("Same outcome as my file" over all rows; the three lab-only chips
 *   ONLY when the list has at least one lab row), the search over the run
 *   name, the sorts with the round-2 default rule, the bottom bar
 *   (all KEPT: the count, the DEC-7 total, the research notice, Run);
 * - the downloads strip (KEPT — one `TxrDownloadState` per live/failed
 *   download, the D idiom);
 * - the row actions: "Model card" for a lab row, "Details" for a
 *   saved/imported row;
 * - the Run flow: lab rows go through today's install gate and the
 *   installed uuids join the saved ids in ONE `Models.resolveModels`, then
 *   `createRun` (mode reuse, config = the FIRST SELECTED model's own facts);
 *   the demo arm passes the lab cards' recorded identity straight through
 *   (no install/download — the server blocks both) and replays the
 *   recorded results;
 * - the states: no checked file (KEPT line, round-2 note, "Go to the
 *   measurements step"), none can run (round-2 lines), filters hide all
 *   ("No models match the search or the filters."), one source failed
 *   ("Some models could not be loaded." + Retry), both failed (the list's
 *   error + Retry), and no model anywhere — the `txr-models-none` panel
 *   with its three options and the disabled Run's reason "There is no
 *   model to run yet.".
 *
 * The round-1 source preset (`lab` / `saved` — the old intents, or the
 * redirects' `?source=`) is read ONCE on mount into the store's filters
 * (it then lives there like every other chip), and the sort opens with the
 * round-2 default rule ("Newest run first" for the Saved preset, a Use
 * handoff or the example set; "Transfer to other cohorts" otherwise).
 */
import { TxrModelHorizonLine } from '../components/TxrModelHorizonLine'
import { type ModelRunFacts, MODELS_SET_LIST_FILTERS, MODELS_SET_SELECTION, useModelListRun } from '../lib/modelRun'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import type {
  ModelEligibilityResponse,
  ModelSummary,
  PretrainedEligibilityEntry,
  PretrainedEligibilityResponse,
  PretrainedSummary,
  TxrModelAsset,
} from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import {
  buildTxrRunInput,
  STEP_BACK_STARTING_REASON,
  TxrIntake,
  TxrStepBack,
  TxrStepBackBar,
  TxrStepLine,
  useStepBack,
  useTxrIntakeStore,
} from '@/modules/txrintake'
import { DemoRetentionBlock, useAppMode, useDemoUsage } from '@/modules/demo'
import {
  countSelected,
  formatTotalTime,
  TxrListBottomBar,
  TxrSelectList,
  type TxrFilterChip,
} from '@/modules/txrlist'
import { predictFilesPath, runningPath } from '@/modules/txrrun'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { Alert, Button } from '@txresbench/kit'
import { runAction } from '@/core/actions/defineAction'
import { usePretrained } from '../data/usePretrained'
import { usePretrainedEligibility } from '../data/usePretrainedEligibility'
import { useAnalysisOutcome } from '../data/useAnalysisOutcome'
import { useModelFileImport } from '../data/useModelFileImport'
import {
  cardRunnable,
  DOWNLOAD_STRIP,
  GATE_DOWNLOADING_LINE,
  GATE_FAILED_LINE,
  getLiveSelection,
  installedModelId,
  reuseConfig,
  StripEntry,
} from '../lib/pretrainedRun'
import { buildChooseRows } from '../lib/rows'
import { chooseChipPredicate, filterRows, type TxrModelSortable } from '../lib/filters'
import { totalSecondsForSelection, type TxrTimedVerdict } from '../lib/total'
import { formatCheckedAgainstLine, formatChooseTotals, RESEARCH_NOTICE } from '../lib/format'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import type {
  TxrModelDialogId,
  TxrModelFilterId,
  TxrModelSortId,
  TxrModelSourceId,
} from '../types'
import { TxrModelCardDialog } from '../components/TxrModelCardDialog'
import { TxrModelDetailsDialog } from '../components/TxrModelDetailsDialog'

/** The page's flex spine (the frame fills the routed area). */
const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The fixed top's own padding (step + title + checked line + toolbar). */
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

/** The strip's "Downloads" caption (the board's muted small line). */
const STRIP_CAPTION: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)', fontWeight: 700 }

/** The board's footnote under the list. */
const FOOTNOTE: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

/** The not-ready state's line (no validated file — never a half list). */
const EMPTY_LINE = 'Add the patients\u2019 measurements you want to predict first.'

/** The not-ready state's note (round 2 — the merged list's own words). */
const EMPTY_NOTE =
  'The models are listed here once your file checks out: ready-made models from the lab, models you saved, and models opened from a file.'

/** The not-ready state's CTA — the step that unlocks this one (RES-20). */
const EMPTY_CTA = 'Go to the measurements step'

/** The none-can-run lines (round 2 — one list, the cross-list buttons go). */
const NONE_CAN_RUN_ONE = 'The 1 model cannot run on this file. Its row says what is missing.'
const NONE_CAN_RUN_MANY = (n: number): string =>
  `None of the ${n} models can run on this file. Each row says what is missing.`

/** The filters-hide-all line (round 2 — the list is no longer only saved). */
const FILTERED_EMPTY = 'No models match the search or the filters.'

/** The one-source-failed alert (round 2 — never the transport's own words). */
const SOURCE_FAILED_LINE = 'Some models could not be loaded.'

/** The no-model panel's blocked reason (round 2 — the Run stays disabled). */
const NO_MODEL_BLOCKED_REASON = 'There is no model to run yet.'

/** The no-model panel's copy (round 2 — the brief's strings). */
const NONE_TITLE = 'No models to choose from yet'
const NONE_TEXT =
  'No ready-made models have been released yet, and you have no saved or opened models. Pick one of these to get a model first:'
const NONE_OPTION_EXAMPLE_TITLE = 'Try the example models'
const NONE_OPTION_EXAMPLE_TEXT =
  'The app trains a few example models first (usually under a minute), then predicts with them.'
const NONE_OPTION_EXAMPLE_CTA = 'Use example'
const NONE_OPTION_TRAIN_TITLE = 'Train models on your own patients'
const NONE_OPTION_TRAIN_TEXT =
  'Needs patients with known outcomes. Save the models, then predict new patients here.'
const NONE_OPTION_TRAIN_CTA = 'Learn from my data'
const NONE_OPTION_FILE_TITLE = 'Open a model file'
const NONE_OPTION_FILE_TEXT = 'A .txr file someone gave you, or one you saved earlier.'
const NONE_OPTION_FILE_CTA = 'Open a model file'

/** The "Checked against your file" line from the validation (CONS-UM-11) —
 *  the merged board's own tail (the D/I old tails go). */
function checkedLine(raw: {
  inventory: { patients: number; markers: ReadonlyArray<unknown> }
  measurements?: { distinct_draw_days?: ReadonlyArray<number> } | null
}): string {
  return formatCheckedAgainstLine(
    raw,
    'Ready-made, saved and imported models are all here; pick as many as you like.',
  )
}

/** The sort options (the merged board's "Sort by", in the board's order). */
const CHOOSE_SORT_OPTIONS: ReadonlyArray<{ value: TxrModelSortId; label: string }> = [
  { value: 'transfer', label: 'Transfer to other cohorts' },
  { value: 'newest-run', label: 'Newest run first' },
  { value: 'patients', label: 'Patients covered' },
  { value: 'time', label: 'Time to run' },
]

/** The `ps:` row-key prefix (DEC-8 — the row keys are 'ps:<catalogue_id>'). */
const ROW_KEY_PREFIX = 'ps:'

/** The source chip ids' fixed order + labels (the boards' words). */
const SOURCE_CHIPS: ReadonlyArray<{ id: TxrModelFilterId; source: TxrModelSourceId; label: string }> = [
  { id: 'source-lab', source: 'lab', label: 'From the lab' },
  { id: 'source-saved', source: 'saved', label: 'Saved' },
  { id: 'source-imported', source: 'imported', label: 'Imported' },
]

/** The three lab-only chips (the plans' review decision: shown ONLY when
 *  the list has at least one lab row). */
const LAB_CHIPS: ReadonlyArray<{ id: TxrModelFilterId; label: string }> = [
  { id: 'published', label: 'Published rules' },
  { id: 'learned', label: 'Learned by the benchmark' },
  { id: 'checked-2-plus', label: 'Checked on 2 or more other cohorts' },
]

/** The one shared host chip (over all rows now). */
const SAME_OUTCOME_CHIP: Readonly<{ id: TxrModelFilterId; label: string }> = {
  id: 'same-outcome',
  label: 'Same outcome as my file',
}

/** The no-model panel's one option row. */
function NoneOption({
  title,
  text,
  cta,
  testId,
  onAction,
}: {
  title: string
  text: string
  cta: string
  testId: string
  onAction(): void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--txr-text)' }}>{title}</span>
      <span style={{ fontSize: 13.5, color: 'var(--txr-text-2)' }}>{text}</span>
      <div style={{ marginTop: 4 }}>
        <Button data-testid={testId} variant="outline" onClick={onAction}>
          {cta}
        </Button>
      </div>
    </div>
  )
}

export function ChooseModelsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const validation = useStore(useTxrIntakeStore, s => s.validation)
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
  const canRunOnly = useStore(useTxrModelsStore, s => s.canRunOnly)
  const sort = useStore(useTxrModelsStore, s => s.sort)
  const searchText = useStore(useTxrModelsStore, s => s.search)
  const atATime = useStore(useTxrModelsStore, s => s.atATime)
  const dialog = useStore(useTxrModelsStore, s => s.dialog)
  const downloadState = useStore(useTxrModelsStore, s => s.downloadState)
  useDocumentTitle('Choose the models to run')
  const { isDemo } = useAppMode()
  const demoUsage = useDemoUsage(isDemo)

  // The page is the merged list's picker host (the no-model panel's "Open a
  // model file"): the action decides the demo refusal, the human click opens
  // the picker, and a successful import refreshes the saved slice (the panel
  // then gives way to the rows).
  const importFile = useModelFileImport({
    onImported: () => void useTxrModelsStore.getState().loadSaved({ force: true }),
  })

  // The store's inventory mirror (ONE object — the intake's, DEC-6).
  // Declared BEFORE the preset effect: on the first mount the null→
  // inventory transition applies the inventory-scoped reset (filters and
  // selection empty), and the preset applied before it would be wiped.
  useEffect(() => {
    useTxrModelsStore.getState().loadInventory()
  }, [validation])

  // ── The round-1 source preset, read ONCE on mount ───────────────────────
  // The redirects carry `?source=lab|saved`; the flow's own intents set the
  // store's `predictSource`. Either way it lives in the store's filters from
  // here on (like every other chip). A Use handoff or the example set shows
  // the source chips OFF and the "Newest run first" sort (the plan's
  // handoff rule — the row/set is ticked once the list has it).
  const presetApplied = useRef(false)
  useEffect(() => {
    if (presetApplied.current) return
    presetApplied.current = true
    const urlSource = searchParams.get('source')
    const source =
      urlSource === 'lab' || urlSource === 'saved'
        ? urlSource
        : useTxrIntakeStore.getState().predictSource
    const store = useTxrModelsStore.getState()
    const handoff = store.pendingUseModelId !== null || pendingExampleSetId !== null
    if (handoff) {
      store.setListFilters({ sources: [] })
    } else {
      if (source === 'lab') store.setListFilters({ sources: ['lab'] })
      else if (source === 'saved') store.setListFilters({ sources: ['saved', 'imported'] })
    }
    // The mount sort is the rule's own (audit item 7): "Newest run first"
    // with the Saved preset, a Use handoff or the example set, otherwise
    // "Transfer to other cohorts" — a stale value from an earlier visit
    // never survives.
    const wishSort: TxrModelSortId =
      handoff || source === 'saved' ? 'newest-run' : 'transfer'
    if (store.sort !== wishSort) store.setSort(wishSort)
  }, [searchParams, pendingExampleSetId])

  // The store's saved slice + the verdicts (the merged list's owned rows).
  // The mount's OWN fresh load is tracked (`savedFreshLoad`): the two
  // handoffs below clear their pending markers only after THIS load has
  // settled (audit item 4 — the cached list of an earlier visit may not have
  // the new set/model yet; clearing on it would lose the handoff).
  const savedFreshLoad = useRef<Promise<void> | null>(null)
  useEffect(() => {
    savedFreshLoad.current = useTxrModelsStore.getState().loadSaved()
  }, [])
  const ids = useMemo(() => saved.summaries.map(model => model.id), [saved.summaries])
  useEffect(() => {
    void useTxrModelsStore.getState().loadEligibility(ids)
  }, [inventory, ids])

  const {
    cards,
    loading: cardsLoading,
    error: cardsError,
    loaded: cardsLoaded,
    refetch,
  } = usePretrained()
  const {
    response: labElig,
    loading: eligLoading,
    error: eligError,
    refetch: refetchElig,
  } = usePretrainedEligibility(
    validation?.inventory ?? null,
    useMemo(() => cards.map(card => card.id), [cards]),
  )

  // ── The verdict layer (the store's slice back into the response shape) ──
  const savedElig = useMemo<ModelEligibilityResponse | null>(() => {
    if (eligibility.totals === null) return null
    const models = saved.summaries
      .filter(model => model.provenance !== 'pretrained')
      .map(model => eligibility.byKey.get(model.id) ?? null)
      .filter((verdict): verdict is NonNullable<typeof verdict> => verdict !== null)
    return {
      models,
      total_fit: eligibility.totals.fit,
      total_some: eligibility.totals.some,
      total_cannot: eligibility.totals.cannot,
    }
  }, [saved.summaries, eligibility.byKey, eligibility.totals])

  // The lab slice's own failure (the LIST request — audit item 8: a
  // downloaded lab model (a `pretrained` store row) is then listed from the
  // store's facts instead of vanishing; the verdict failure `eligError` is
  // the OTHER half — audit item 5 — counted into `labFailed` below).
  const labCatalogueFailed = cardsError !== null

  // ── The row/composition layer ───────────────────────────────────────────
  const rows = useMemo(
    () => buildChooseRows(cards, saved.summaries, labElig, savedElig, isDemo, labCatalogueFailed),
    [cards, saved.summaries, labElig, savedElig, isDemo, labCatalogueFailed],
  )

  const cardById = useMemo(() => new Map(cards.map(card => [card.id, card])), [cards])
  const modelById = useMemo(
    () => new Map(saved.summaries.map(model => [model.id, model])),
    [saved.summaries],
  )

  /** The `ps:<catalogue_id>` key → its `pretrained` store row (the
   *  catalogue-down fallback: the same key the loaded catalogue uses, so
   *  the run/verdict layers resolve the row's store facts in place). */
  const pretrainedRows = useMemo(() => {
    const m = new Map<string, ModelSummary>()
    for (const model of saved.summaries) {
      if (model.provenance !== 'pretrained') continue
      m.set(`${ROW_KEY_PREFIX}${model.pretrained_catalogue_id ?? model.id}`, model)
    }
    return m
  }, [saved.summaries])

  /** The row key → source facts (the chip predicate's input). */
  const factsByKey = useMemo(() => {
    const m = new Map<
      string,
      { source: TxrModelSourceId; card: PretrainedSummary | null; model: ModelSummary | null }
    >()
    for (const card of cards) m.set(`${ROW_KEY_PREFIX}${card.id}`, { source: 'lab', card, model: null })
    for (const model of saved.summaries) {
      if (model.provenance === 'pretrained') {
        if (!labCatalogueFailed) continue
        m.set(`${ROW_KEY_PREFIX}${model.pretrained_catalogue_id ?? model.id}`, {
          source: 'lab',
          card: null,
          model,
        })
        continue
      }
      m.set(model.id, {
        source: model.provenance === 'run' ? 'saved' : 'imported',
        card: null,
        model,
      })
    }
    return m
  }, [cards, saved.summaries, labCatalogueFailed])

  /** The row key → run facts (the mixed-day rule's input). */
  const factsOf = useCallback(
    (key: string): ModelRunFacts | undefined => {
      const facts = factsByKey.get(key)
      if (facts === undefined) return undefined
      if (facts.card !== null) {
        return { decision_day: facts.card.decision_day, horizon: facts.card.horizon }
      }
      if (facts.model !== null) {
        return { decision_day: facts.model.decision_day, horizon: facts.model.horizon }
      }
      return undefined
    },
    [factsByKey],
  )

  /** The sort facts (the comparators' input — the D/I facts joined). */
  const sortable = useMemo(() => {
    const m = new Map<string, TxrModelSortable>()
    for (const card of cards) {
      const verdict =
        (labElig?.models ?? []).find(entry => entry.id === card.id) ?? null
      m.set(`${ROW_KEY_PREFIX}${card.id}`, {
        transferCohorts: card.transfer?.n_cohorts ?? null,
        transferMedian: card.transfer?.median ?? null,
        coverage: verdict?.coverage?.fraction ?? null,
        estimateSeconds: verdict?.estimated_seconds ?? null,
        madeAt: null,
        id: card.id,
      })
    }
    for (const model of saved.summaries) {
      if (model.provenance === 'pretrained') {
        if (!labCatalogueFailed) continue
        const key = `${ROW_KEY_PREFIX}${model.pretrained_catalogue_id ?? model.id}`
        const verdict = eligibility.byKey.get(model.id) ?? null
        const instant = model.trained_at ?? model.created_at
        const madeAt = instant === undefined ? Number.NaN : Date.parse(instant)
        m.set(key, {
          transferCohorts: null,
          transferMedian: null,
          coverage: verdict?.coverage?.fraction ?? null,
          estimateSeconds: verdict?.estimated_seconds ?? null,
          madeAt: Number.isNaN(madeAt) ? null : madeAt,
          id: model.id,
        })
        continue
      }
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
  }, [cards, labElig, saved.summaries, eligibility.byKey, labCatalogueFailed])

  /** The per-key verdict map (the bottom-bar total's input — both the
   *  pretrained and the saved verdict shapes carry `estimated_seconds`). */
  const verdictByKey = useMemo(() => {
    const m = new Map<string, TxrTimedVerdict | null>()
    for (const card of cards) {
      m.set(
        `${ROW_KEY_PREFIX}${card.id}`,
        (labElig?.models ?? []).find(entry => entry.id === card.id) ?? null,
      )
    }
    if (eligibility.totals !== null) {
      for (const model of saved.summaries) {
        if (model.provenance === 'pretrained') {
          if (!labCatalogueFailed) continue
          m.set(
            `${ROW_KEY_PREFIX}${model.pretrained_catalogue_id ?? model.id}`,
            eligibility.byKey.get(model.id) ?? null,
          )
          continue
        }
        m.set(model.id, eligibility.byKey.get(model.id) ?? null)
      }
    }
    return m
  }, [cards, labElig, saved.summaries, eligibility.byKey, eligibility.totals, labCatalogueFailed])

  const outcome = useAnalysisOutcome()

  /** The active chip predicate over the row facts (sources + the kept chips). */
  const chipPredicate = useMemo(() => chooseChipPredicate(filters, outcome), [filters, outcome])

  /** The keep: the chip predicate AND the "Can run N" built-in. */
  const keep = useMemo(() => {
    const disabled = new Set(rows.filter(row => row.run.disabled).map(row => row.key))
    return (key: string): boolean => {
      const facts = factsByKey.get(key)
      if (facts === undefined) return false
      if (!chipPredicate(facts)) return false
      return !(canRunOnly && disabled.has(key))
    }
  }, [factsByKey, chipPredicate, canRunOnly, rows])

  /** The sort view — the shared field adopted to this board's options (the
   *  store's value converges by the mount effect; the derived read keeps the
   *  first paint sorted by the board initial). */
  const shownSort: TxrModelSortId = CHOOSE_SORT_OPTIONS.some(option => option.value === sort)
    ? sort
    : 'transfer'

  /** The rows this list shows (chip + search + sort — the host filters). */
  const shown = useMemo(
    () => filterRows(rows, { keep, search: searchText, sort: shownSort, sortable }),
    [rows, keep, searchText, shownSort, sortable],
  )

  /** The source counts over the WHOLE source set (a chip's count answers
   *  its own question, never the current view). When the catalogue is down
   *  its downloaded rows are still listed (as the store's lab rows), so
   *  they count into "From the lab" (audit item 8). */
  const sourceCounts = useMemo(
    () => ({
      lab:
        cards.length +
        (labCatalogueFailed
          ? saved.summaries.filter(model => model.provenance === 'pretrained').length
          : 0),
      saved: saved.summaries.filter(model => model.provenance === 'run').length,
      imported: saved.summaries.filter(model => model.provenance === 'imported').length,
    }),
    [cards, saved.summaries, labCatalogueFailed],
  )

  /** The "Same outcome as my file" count over ALL rows. */
  const sameOutcomeCount = useMemo(() => {
    const predicate = chooseChipPredicate(['same-outcome'], outcome)
    let n = 0
    for (const key of factsByKey.keys()) {
      const facts = factsByKey.get(key)
      if (facts !== undefined && predicate(facts)) n += 1
    }
    return n
  }, [factsByKey, outcome])

  /** The verdict-accounting facts of the whole list: with every verdict
   *  ready, the fit/some/cannot totals; null while loading/failed. The
   *  ready flag takes the source's own load state: while the lab list or
   *  the saved slice is still loading, no verdict is claimed for the other
   *  half either (the old "names no number while the models load" rule —
   *  a lab-only or saved-only count would answer a partial list). */
  const labVerdictsReady =
    cardsLoaded &&
    !cardsLoading &&
    labElig !== null &&
    !eligLoading &&
    eligError === null &&
    labElig.total_fit + labElig.total_some + labElig.total_cannot === cards.length
  const ownedCount = saved.summaries.filter(model => model.provenance !== 'pretrained').length
  const savedVerdictsReady =
    inventory !== null &&
    inventory === validation?.inventory &&
    saved.loaded &&
    !saved.loading &&
    saved.error === null &&
    eligibility.totals !== null &&
    !eligibility.loading &&
    eligibility.error === null &&
    eligibility.totals.fit + eligibility.totals.some + eligibility.totals.cannot === ownedCount
  const verdictsReady = labVerdictsReady && savedVerdictsReady
  const totals = useMemo(() => {
    if (!verdictsReady) return null
    return {
      fit: (labElig?.total_fit ?? 0) + (eligibility.totals?.fit ?? 0),
      some: (labElig?.total_some ?? 0) + (eligibility.totals?.some ?? 0),
      cannot: (labElig?.total_cannot ?? 0) + (eligibility.totals?.cannot ?? 0),
    }
  }, [verdictsReady, labElig, eligibility.totals])

  // ── The states ──────────────────────────────────────────────────────────
  // `labFailed` is the lab slice's verdict failure too (audit item 5): a
  // failed eligibility call otherwise leaves the lab rows "cannot" with no
  // alert; "Some models could not be loaded." + Retry must show for either
  // leg.
  const labFailed = cardsError !== null || eligError !== null
  const savedFailed = saved.error !== null || eligibility.error !== null
  const ownedLoaded =
    saved.loaded &&
    !saved.loading &&
    saved.error === null &&
    eligibility.error === null
  const noModelAnywhere =
    validation !== null &&
    cardsLoaded &&
    !cardsLoading &&
    cardsError === null &&
    ownedLoaded &&
    cards.length === 0 &&
    ownedCount === 0
  const noneCanRun =
    validation !== null &&
    rows.length > 0 &&
    verdictsReady &&
    totals !== null &&
    totals.fit + totals.some === 0

  // The J "Use" handoff (DEC-10, moved): a pending id preselects its row
  // once the list has it, then clears. A downloaded lab model (a
  // `pretrained` store row) preselects the `ps:<catalogue_id>` row.
  // The clear happens only AFTER THIS MOUNT's own fresh saved load has
  // settled (audit item 4): the cached list of an earlier visit may not
  // have the model yet, and clearing on it would lose the handoff.
  useEffect(() => {
    const pending = useTxrModelsStore.getState().pendingUseModelId
    if (pending === null) return
    const fresh = savedFreshLoad.current
    if (fresh === null) return
    let cancelled = false
    void fresh.then(() => {
      if (cancelled) return
      const store = useTxrModelsStore.getState()
      const still = store.pendingUseModelId
      if (still === null) return
      // A newer load still in flight: leave the marker; the state change
      // re-runs this effect and it settles then.
      if (store.saved.loading || !store.saved.loaded) return
      const model = store.saved.summaries.find(summary => summary.id === still)
      const key =
        model === undefined
          ? null
          : model.provenance === 'pretrained' && model.pretrained_catalogue_id
            ? `${ROW_KEY_PREFIX}${model.pretrained_catalogue_id}`
            : model.id
      if (key !== null && !store.selection.has(key)) {
        store.setSelection(new Set([...store.selection, key]))
      }
      store.setPendingUse(null)
    })
    return () => {
      cancelled = true
    }
  }, [saved.summaries, saved.loading, saved.loaded])

  // The example-set handoff (ITEM-3, moved): the "Use example" parked the
  // set id; once the list holds it, tick EVERY row of it and clear.
  // Same audit-item-4 rule: only after this mount's fresh saved load.
  useEffect(() => {
    if (pendingExampleSetId === null) return
    const fresh = savedFreshLoad.current
    if (fresh === null) return
    let cancelled = false
    void fresh.then(() => {
      if (cancelled) return
      const store = useTxrModelsStore.getState()
      if (useTxrIntakeStore.getState().pendingExampleSetId === null) return
      if (store.saved.loading || !store.saved.loaded) return
      const keys = store.saved.summaries
        .filter(model => model.set_id === pendingExampleSetId)
        .map(model => model.id)
      if (keys.length > 0) {
        store.setSelection(new Set([...store.selection, ...keys]))
      }
      TxrIntake.setPendingExampleSet(null)
    })
    return () => {
      cancelled = true
    }
  }, [pendingExampleSetId, saved.summaries, saved.loading, saved.loaded])

  // ── The selection write (the controlled list's next-set + the D
  // auto-download for a newly checked lab card) ─────────────────────────────
  // The ONE sanitizing write behind `models.setSelection` (audit item 3):
  // only ids of LISTED rows that can be selected are ever applied (unknown
  // and cannot-run ids never land in the selection), and a request whose
  // ids are all not selectable is refused with a plain line. The human
  // checkboxes/select-all reach it through the same registered action.
  const writeSelection = useCallback(
    (ids: readonly string[]): void => {
      const store = useTxrModelsStore.getState()
      const selectable = new Set(rows.filter(row => !row.run.disabled).map(row => row.key))
      const kept = ids.filter(key => selectable.has(key))
      if (ids.length > 0 && kept.length === 0) {
        throw new Error('None of those models can be chosen.')
      }
      const next = new Set(kept)
      for (const key of next) {
        if (selection.has(key)) continue
        const card = cardById.get(key.slice(ROW_KEY_PREFIX.length))
        if (card === undefined) continue
        if (cardRunnable(card, store.downloadState[card.id])) continue
        const entry = store.downloadState[card.id]
        if (entry?.status?.state === 'failed') continue // the human's Retry owns it
        // ITEM-7: in the demo the cards are INCLUDED — no downloads.
        if (isDemo) continue
        void store.requestDownload(card.id)
      }
      store.setSelection(next)
    },
    [selection, rows, cardById, isDemo],
  )
  const actionSetSelection = useCallback(
    (ids: string[]): void => writeSelection(ids),
    [writeSelection],
  )
  const actionSetListFilters = useCallback(
    (input: {
      sources?: TxrModelSourceId[] | null
      canRunOnly?: boolean
      chips?: string[] | null
      search?: string
      sort?: string
    }): void => {
      const store = useTxrModelsStore.getState()
      store.setListFilters({
        sources: input.sources ?? undefined,
        canRunOnly: input.canRunOnly,
        chips: (input.chips ?? undefined) as TxrModelFilterId[] | undefined,
        search: input.search,
        sort: (input.sort ?? undefined) as TxrModelSortId | undefined,
      })
    },
    [],
  )
  const listState = useCallback(
    () => ({
      sources: (['lab', 'saved', 'imported'] as TxrModelSourceId[]).filter(source =>
        filters.includes(`source-${source}` as TxrModelFilterId),
      ),
      chips: filters.filter(
        f =>
          f !== 'source-lab' &&
          f !== 'source-saved' &&
          f !== 'source-imported' &&
          f !== 'all' &&
          f !== 'can-run',
      ),
      canRunOnly,
      search: searchText,
      sort,
    }),
    [filters, canRunOnly, searchText, sort],
  )

  // ── The downloads strip ──────────────────────────────────────────────────
  const stripIds = useMemo(
    () =>
      cards
        .filter(card => {
          const entry = downloadState[card.id]
          if (entry === undefined) return false
          const state = entry.status?.state ?? null
          return state === 'downloading' || state === 'failed' || entry.error !== null
        })
        .map(card => card.id),
    [cards, downloadState],
  )

  // ── The Run path (the D/I arms merged) ───────────────────────────────────
  const createRun = useCallback(
    async (keys: readonly string[]): Promise<string> => {
      const runCards = keys
        .map(key => cardById.get(key.slice(ROW_KEY_PREFIX.length)))
        .filter((card): card is PretrainedSummary => card !== undefined)
      const runModels = keys
        .map(key => modelById.get(key) ?? pretrainedRows.get(key))
        .filter((model): model is ModelSummary => model !== undefined)
      const first = ((): { endpoint: string; decision_day: number; horizon: number } | null => {
        for (const key of keys) {
          const facts = factsOf(key)
          if (facts !== undefined) {
            const card = cardById.get(key.slice(ROW_KEY_PREFIX.length))
            if (card !== undefined) {
              return { endpoint: card.endpoint, decision_day: card.decision_day, horizon: card.horizon }
            }
            const model = modelById.get(key) ?? pretrainedRows.get(key)
            if (model !== undefined) {
              return { endpoint: model.endpoint, decision_day: model.decision_day, horizon: model.horizon }
            }
          }
        }
        return null
      })()
      const input = buildTxrRunInput(
        {
          patients,
          measurements,
          predictMeasurements,
          joins,
          mapping,
        } as unknown as IntakeSnapshot,
        'predict',
      )
      // The ONE create call's assets, built by the arm that applies:
      // the demo arm includes the lab cards' recorded identity (no install,
      // no download — the server blocks both, and the recorded replay reads
      // only the method facts), while the OWNED rows DO resolve through
      // `Models.resolveModels` (the server does not block that; it is how
      // a saved/imported model becomes runnable) like any saved model.
      // The replay replays each selected method's recorded column, whatever
      // the mix is (lab + example-set mix included).
      let assets: TxrModelAsset[]
      if (isDemo) {
        const ownedAssets = new Map<string, TxrModelAsset>()
        if (runModels.length > 0) {
          const { assets: owned } = await ApiClient.Models.resolveModels({
            model_ids: runModels.map(model => model.id),
          })
          for (const asset of owned) ownedAssets.set(asset.model_id, asset)
        }
        const demoAssets: TxrModelAsset[] = []
        for (const key of keys) {
          const card = cardById.get(key.slice(ROW_KEY_PREFIX.length))
          if (card !== undefined) {
            demoAssets.push({
              model_id: card.id,
              method_id: card.method_id,
              method_version: card.method_version,
            } as unknown as TxrModelAsset)
          } else {
            const model = modelById.get(key) ?? pretrainedRows.get(key)
            const asset = model !== undefined ? ownedAssets.get(model.id) : undefined
            if (asset !== undefined) demoAssets.push(asset)
          }
        }
        assets = demoAssets
      } else {
        const blocked = runCards.filter(
          card => !cardRunnable(card, useTxrModelsStore.getState().downloadState[card.id]),
        )
        if (blocked.length > 0) {
          throw new Error(
            blocked.some(card => {
              const state = useTxrModelsStore.getState().downloadState[card.id]?.status?.state
              return state === 'failed'
            })
              ? GATE_FAILED_LINE
              : GATE_DOWNLOADING_LINE,
          )
        }
        // install-if-needed, in the SELECTION's own order (audit item 2: the
        // lab ids never jump ahead of saved ids — each key maps to its id in
        // place, a lab key to its installed uuid), then ONE resolve over the
        // whole ordered list.
        const modelIds: string[] = []
        for (const key of keys) {
          const card = cardById.get(key.slice(ROW_KEY_PREFIX.length))
          if (card !== undefined) {
            modelIds.push(await installedModelId(card))
            continue
          }
          const model = modelById.get(key) ?? pretrainedRows.get(key)
          if (model !== undefined) modelIds.push(model.id)
        }
        assets = (await ApiClient.Models.resolveModels({ model_ids: modelIds })).assets
      }
      const created = await ApiClient.Txr.createRun({
        mode: 'reuse',
        input,
        config: reuseConfig(
          first ?? { endpoint: 'pfs', decision_day: 56, horizon: 238 },
          atATime,
        ),
        model_ids: assets,
      })
      navigate(runningPath(created.id))
      return created.id
    },
    [
      cards,
      cardById,
      modelById,
      pretrainedRows,
      factsOf,
      patients,
      measurements,
      predictMeasurements,
      joins,
      mapping,
      atATime,
      navigate,
      isDemo,
    ],
  )

  const run = useModelListRun({
    rows,
    selection,
    getSelection: getLiveSelection,
    factsOf,
    createRun,
    setSelection: actionSetSelection,
    setListFilters: actionSetListFilters,
    listState,
  })

  /** The human checkbox / select-all click — the SAME registered
   *  `models.setSelection` the AI invokes (audit item 1: a human control
   *  never bypasses the action registry), with this list's view id and the
   *  CURRENT state token. The list's own disabled-row rule means a human
   *  click always brings selectable ids; a refusal (a stale token race)
   *  leaves the click unapplied rather than crashing the surface. */
  const onSelectionChange = useCallback(
    (next: ReadonlySet<string>): void => {
      void runAction(MODELS_SET_SELECTION, {
        view_id: run.viewId,
        expected: run.stateToken(),
        ids: [...next],
      }).catch(() => undefined)
    },
    [run],
  )

  /** The host chips: the three source chips (0-count disabled), the lab-only
   *  chips ONLY when the list has a lab row, then the outcome chip. Every
   *  toggle is the registered `models.setListFilters` (audit item 1) with
   *  this list's view id and the CURRENT state token; `sources` / `chips`
   *  REPLACE their group, so a toggle sends only the changed group. */
  const chips = useMemo(() => {
    const onToggle = (id: TxrModelFilterId): void => {
      const current = useTxrModelsStore.getState().filters
      const isSource =
        id === 'source-lab' || id === 'source-saved' || id === 'source-imported'
      let sources: TxrModelSourceId[] | undefined
      let nextChips: TxrModelFilterId[] | undefined
      if (isSource) {
        const source = id.slice('source-'.length) as TxrModelSourceId
        const active = (['lab', 'saved', 'imported'] as TxrModelSourceId[]).filter(src =>
          current.includes(`source-${src}` as TxrModelFilterId),
        )
        sources = active.includes(source)
          ? active.filter(src => src !== source)
          : [...active, source]
      } else {
        const host = current.filter(
          f =>
            f !== 'source-lab' &&
            f !== 'source-saved' &&
            f !== 'source-imported' &&
            f !== 'all' &&
            f !== 'can-run',
        )
        nextChips = current.includes(id) ? host.filter(f => f !== id) : [...host, id]
      }
      void runAction(MODELS_SET_LIST_FILTERS, {
        view_id: run.viewId,
        expected: run.stateToken(),
        ...(isSource ? { sources } : { chips: nextChips }),
      }).catch(() => undefined)
    }
    const list: TxrFilterChip[] = SOURCE_CHIPS.map(({ id, source, label }) => ({
      id,
      label,
      count: sourceCounts[source],
      active: filters.includes(id),
      disabled: sourceCounts[source] === 0,
      onToggle: () => onToggle(id),
    }))
    if (cards.length > 0) {
      for (const chip of LAB_CHIPS) {
        const count =
          chip.id === 'published'
            ? cards.filter(card => card.kind === 'published-rule').length
            : chip.id === 'learned'
              ? cards.filter(card => card.kind === 'benchmark-trained').length
              : cards.filter(
                  card =>
                    card.transfer !== null &&
                    card.transfer !== undefined &&
                    card.transfer.n_cohorts >= 2,
                ).length
        list.push({
          id: chip.id,
          label: chip.label,
          count,
          active: filters.includes(chip.id),
          onToggle: () => onToggle(chip.id),
        })
      }
    }
    list.push({
      id: SAME_OUTCOME_CHIP.id,
      label: SAME_OUTCOME_CHIP.label,
      count: sameOutcomeCount,
      active: filters.includes(SAME_OUTCOME_CHIP.id),
      onToggle: () => onToggle(SAME_OUTCOME_CHIP.id),
    })
    return list
  }, [sourceCounts, cards, filters, sameOutcomeCount, run])

  useStepBack({
    step: 'choose-models',
    fallback: predictFilesPath(),
    blockedReason: run.starting ? STEP_BACK_STARTING_REASON : null,
    // A dialog can block Back only where it can show: with no checked file
    // (the not-ready state) a card/details id left in the shared store has
    // nothing to display, so it must not block leaving (the old D31 rule —
    // round 3b audit item 1).
    dialogOpen:
      validation !== null && (dialog.startsWith('card:') || dialog.startsWith('details:')),
  })

  // The source-failed state: what loaded stays visible plus the alert; both
  // failed → the list's own error state + Retry (KEPT).
  const retryAll = useCallback((): void => {
    refetch()
    refetchElig()
    void useTxrModelsStore.getState().loadSaved({ force: true })
    void useTxrModelsStore.getState().loadEligibility(ids, { force: true })
  }, [refetch, refetchElig, ids])

  // ── The frame composition ────────────────────────────────────────────────
  const pageTop = (toolbar: ReactNode | null): ReactNode => (
    <div className="txr-models-choose-top" style={PAGE_TOP}>
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
          {validation !== null ? <TxrStepLine step="choose-models" /> : null}
          <h1 style={TITLE}>Choose the models to run</h1>
          {validation !== null ? (
            <p data-testid="txr-models-choose-checked" style={CHECK_LINE}>
              {checkedLine(validation)}
            </p>
          ) : null}
          {validation !== null ? (
            <TxrModelHorizonLine
              testId="txr-models-choose-horizon"
              horizons={run.horizons}
              decisionDays={run.decisionDays}
            />
          ) : null}
        </div>
        {validation !== null && totals !== null ? (
          <span data-testid="txr-models-choose-totals" style={TOTALS}>
            {formatChooseTotals(rows.length, totals.fit, totals.some, totals.cannot)}
          </span>
        ) : null}
      </div>
      {isDemo ? (
        <DemoRetentionBlock
          kind="models"
          count={demoUsage.usage?.models ?? null}
          limit={demoUsage.usage?.model_limit ?? 50}
        />
      ) : null}
      {validation !== null && noneCanRun ? (
        <Alert
          tone="info"
          data-testid="txr-models-choose-none-can-run"
          title={rows.length === 1 ? NONE_CAN_RUN_ONE : NONE_CAN_RUN_MANY(rows.length)}
        />
      ) : null}
      {validation !== null &&
      !noModelAnywhere &&
      !(labFailed && savedFailed) &&
      (labFailed || savedFailed) ? (
        <Alert
          tone="error"
          data-testid="txr-models-choose-source-failed"
          title={SOURCE_FAILED_LINE}
        >
          <Button data-testid="txr-models-choose-source-retry" variant="outline" onClick={retryAll}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {toolbar !== null ? (
        <div
          className="txr-models-choose-toolbar"
          data-testid="txr-models-choose-toolbar"
          style={TOOLBAR_SLOT}
        >
          {toolbar}
        </div>
      ) : null}
      {stripIds.length > 0 ? (
        <div data-testid="txr-models-downloads" style={DOWNLOAD_STRIP}>
          <span style={STRIP_CAPTION}>Downloads</span>
          {stripIds.map(id => (
            <StripEntry key={id} id={id} />
          ))}
        </div>
      ) : null}
      {run.runError !== null ? (
        <Alert tone="error" data-testid="txr-models-choose-run-error" title={run.runError} />
      ) : null}
    </div>
  )

  /** The ONE body region (the row stream or a branch's own content). */
  const bodyRegion = (content: ReactNode): ReactNode => (
    <ScrollRegion label="Models to choose" className="txr-models-choose-region">
      <div style={REGION_CONTENT}>{content}</div>
    </ScrollRegion>
  )

  const footnote = (
    <p style={FOOTNOTE}>
      Models that cannot run say what is missing from your file. Add the missing
      markers and they become available.
    </p>
  )

  /** The row dialogs (closed in the empty/panel states). */
  const rowDialogs = (
    <>
      <TxrModelCardDialog
        cardId={dialog.startsWith('card:') ? dialog.slice(5) : null}
        onClose={() => useTxrModelsStore.getState().closeDialog()}
      />
      <TxrModelDetailsDialog
        modelId={dialog.startsWith('details:') ? dialog.slice('details:'.length) : null}
        onClose={() => useTxrModelsStore.getState().closeDialog()}
      />
    </>
  )

  // The no-model-anywhere branch: the panel + the disabled Run's reason.
  if (noModelAnywhere) {
    return (
      <main data-testid="txr-models-choose" style={PAGE_OUTER}>
        <PageFrame
          testId="txr-models-choose-frame"
          top={pageTop(null)}
          body={bodyRegion(
            <div data-testid="txr-models-none" style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '24px 0' }}>
              <p style={{ margin: 0, fontSize: 15.5, color: 'var(--txr-text-2)', fontWeight: 600 }}>
                {NONE_TITLE}
              </p>
              <p data-testid="txr-models-none-text" style={{ margin: 0, color: 'var(--txr-text-2)', maxWidth: '62ch' }}>
                {NONE_TEXT}
              </p>
              <div data-testid="txr-models-none-options" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <NoneOption
                  title={NONE_OPTION_EXAMPLE_TITLE}
                  text={NONE_OPTION_EXAMPLE_TEXT}
                  cta={NONE_OPTION_EXAMPLE_CTA}
                  testId="txr-models-none-example"
                  onAction={() => void runAction('flow.useExample', { intent: 'predict' })}
                />
                <NoneOption
                  title={NONE_OPTION_TRAIN_TITLE}
                  text={NONE_OPTION_TRAIN_TEXT}
                  cta={NONE_OPTION_TRAIN_CTA}
                  testId="txr-models-none-train"
                  onAction={() => void runAction('flow.startPath', { intent: 'train' })}
                />
                {!isDemo ? (
                  <NoneOption
                    title={NONE_OPTION_FILE_TITLE}
                    text={NONE_OPTION_FILE_TEXT}
                    cta={NONE_OPTION_FILE_CTA}
                    testId="txr-models-none-file"
                    onAction={() => void runAction('models.openModelFile', {})}
                  />
                ) : null}
              </div>
              {/* native-control-ok: the file input is invisible; the visible affordance is <Button> */}
              <input
                {...importFile.inputProps}
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
                data-testid="txr-models-choose-open-model-file-input"
              />
              {importFile.error !== null ? (
                <Alert
                  data-testid="txr-models-choose-open-model-file-error"
                  tone="error"
                  title={importFile.error}
                />
              ) : null}
            </div>,
          )}
          bottom={
            <div data-testid="txr-models-choose-bar">
              <TxrListBottomBar
                itemLabel="model"
                selectedCount={0}
                totalTimeText={null}
                notice={RESEARCH_NOTICE}
                blockedReason={NO_MODEL_BLOCKED_REASON}
                onRun={() => undefined}
                back={<TxrStepBack look="list-bar" />}
              />
            </div>
          }
        />
        {rowDialogs}
      </main>
    )
  }

  // The not-ready branch (no validated predict file): the frame, the empty
  // state's own lines in the region (never a half-built list, DEC-6).
  if (validation === null) {
    return (
      <main data-testid="txr-models-choose" style={PAGE_OUTER}>
        <PageFrame
          testId="txr-models-choose-frame"
          top={pageTop(null)}
          body={bodyRegion(
            <div
              data-testid="txr-models-choose-empty"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                alignItems: 'flex-start',
                padding: '24px 0',
              }}
            >
              <p style={CHECK_LINE}>{EMPTY_LINE}</p>
              <p data-testid="txr-models-choose-empty-note" style={CHECK_LINE}>
                {EMPTY_NOTE}
              </p>
              <Button
                data-testid="txr-models-choose-empty-cta"
                variant="outline"
                onClick={() => void runAction('app.navigate', { path: predictFilesPath() })}
              >
                {EMPTY_CTA}
              </Button>
            </div>,
          )}
          bottom={<TxrStepBackBar />}
        />
        {rowDialogs}
      </main>
    )
  }

  return (
    <main data-testid="txr-models-choose" style={PAGE_OUTER}>
      <TxrSelectList
        rows={shown}
        itemLabel="model"
        selected={selection}
        onSelectionChange={onSelectionChange}
        filterChips={chips}
        allFilter={{
          active: !canRunOnly && filters.every(f => !f.startsWith('source-') && !LAB_CHIPS.some(c => c.id === f) && f !== 'same-outcome'),
          onClick: () =>
            void runAction(MODELS_SET_LIST_FILTERS, {
              view_id: run.viewId,
              expected: run.stateToken(),
              sources: [],
              chips: [],
              canRunOnly: false,
            }).catch(() => undefined),
        }}
        canRunFilter={{
          active: canRunOnly,
          onClick: () =>
            void runAction(MODELS_SET_LIST_FILTERS, {
              view_id: run.viewId,
              expected: run.stateToken(),
              canRunOnly: !canRunOnly,
            }).catch(() => undefined),
        }}
        search={{
          value: searchText,
          onChange: value =>
            void runAction(MODELS_SET_LIST_FILTERS, {
              view_id: run.viewId,
              expected: run.stateToken(),
              search: value,
            }).catch(() => undefined),
        }}
        sort={{
          value: shownSort,
          options: CHOOSE_SORT_OPTIONS as { value: string; label: string }[],
          onChange: value =>
            void runAction(MODELS_SET_LIST_FILTERS, {
              view_id: run.viewId,
              expected: run.stateToken(),
              sort: value as TxrModelSortId,
            }).catch(() => undefined),
        }}
        // Not loaded yet (the birth state, before the first fetch) counts as
        // loading: the list never flashes its empty line before the data.
        loading={
          (!cardsLoaded && cardsError === null) ||
          cardsLoading ||
          eligLoading ||
          (!saved.loaded && saved.error === null) ||
          saved.loading ||
          eligibility.loading
        }
        emptyText={FILTERED_EMPTY}
        error={labFailed && savedFailed ? (cardsError ?? saved.error ?? eligibility.error) : null}
        onRetry={retryAll}
        bottomBar={{
          selectedCount: countSelected(selection, rows),
          totalTimeText: formatTotalTime(
            totalSecondsForSelection(selection, verdictByKey as ReadonlyMap<string, { estimated_seconds?: number | null } | null>),
          ),
          notice: RESEARCH_NOTICE,
          blockedReason: run.blockedReason,
          onRun: keys => {
            // THE one guarded Run (the same function the `models.run`
            // action calls): the shared path writes the inline line itself;
            // only the rejection is swallowed here (never an unhandled one).
            void run.startRun(keys).catch(() => undefined)
          },
          back: <TxrStepBack look="list-bar" />,
        }}
        onRowAction={row => {
          if (row.key.startsWith(ROW_KEY_PREFIX)) {
            const card = cardById.get(row.key.slice(ROW_KEY_PREFIX.length))
            const fallback = card === undefined ? pretrainedRows.get(row.key) : undefined
            if (card !== undefined) {
              useTxrModelsStore
                .getState()
                .openDialog(`card:${row.key.slice(ROW_KEY_PREFIX.length)}` as TxrModelDialogId)
            } else if (fallback !== undefined) {
              // The catalogue-down lab row: its store facts' "Details".
              useTxrModelsStore.getState().openDialog(`details:${fallback.id}` as TxrModelDialogId)
            } else {
              useTxrModelsStore
                .getState()
                .openDialog(`card:${row.key.slice(ROW_KEY_PREFIX.length)}` as TxrModelDialogId)
            }
          } else {
            useTxrModelsStore.getState().openDialog(`details:${row.key}` as TxrModelDialogId)
          }
        }}
        layout={parts => (
          <>
            <PageFrame
              testId="txr-models-choose-frame"
              top={pageTop(parts.toolbar)}
              body={bodyRegion(
                <>
                  {parts.rows}
                  {footnote}
                </>,
              )}
              bottom={<div data-testid="txr-models-choose-bar">{parts.bottomBar}</div>}
            />
            {rowDialogs}
          </>
        )}
      />
    </main>
  )
}
