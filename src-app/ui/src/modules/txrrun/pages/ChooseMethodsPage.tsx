import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import type {
  InventoryEligibilityRequest,
  MarkerRankingRequest,
  TxrRunStatus,
} from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import {
  buildMethodFilters,
  buildTxrRunInput,
  hasMethodFilters,
  STEP_BACK_STARTING_REASON,
  TxrIntake,
  TxrStepBack,
  TxrStepBackBar,
  TxrStepLine,
  useFilterOptions,
  useIntakeAnswers,
  useStepBack,
  useTxrIntakeStore,
} from '@/modules/txrintake'
import {
  countSelected,
  METHODS_SET_TICKED,
  recheckFailedLine,
  recheckLine,
  recommendedSelection,
  runnableCards,
  stableInventoryKey,
  TxrMethodPicker,
  useListEstimate,
  useMethodRows,
} from '@/modules/txrlist'
import { Alert, Button, message, Skeleton } from '@txresbench/kit'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { useAppMode } from '@/modules/demo'
import {
  DEMO_DISABLED_REASON,
  DEMO_RUN_BUTTON_SUFFIX,
  DEMO_SETTINGS_NOTE,
} from '@/modules/demo/copy'
import { formatDurationShort } from '@/modules/txrlist'
import { useShortShell } from '../lib/useNarrow'
import {
  PageFrame,
} from '@/modules/txrshell/components/PageFrame'
import {
  ScrollRegion,
} from '@/modules/txrshell/components/ScrollRegion'
import {
  droppedNotice,
  isMethodListChanged,
  METHOD_LIST_CHANGED_NOTICE,
  RUN_ALREADY_ACTIVE_LINE,
  RUN_METHODS_GONE_LINE,
  staleMethodIds,
} from '../lib/runErrors'
import { refreshMethodListStatus } from '@/lib/txr-method-list/revision'
import { runSetupMissing } from '../lib/slotSummary'
import { buildFilesSummary } from '../lib/filesSummary'
import { formatRunBarTime } from '../lib/runBar'
import {
  mergeRunSettings,
  RUN_SETTINGS_SET_COVARIATES,
  RUN_SETTINGS_SET_DAY,
  SETTING_ENDPOINT_WORD,
  TXR_RUN_SETTINGS_CONTEXT,
  type RunSettings,
} from '../lib/settings'
import { buildRunRequest } from '../lib/runRequest'
import { eligibilityMarkerPlan, MARKER_CHANGE_IT, markerLineText } from '../lib/markerPlan'
import { useMarkerRanking } from '../data/useMarkerRanking'
import {
  buildCovariates,
  covariatesAutoOnLine,
  covariatesAutoOnText,
  covariatesUntickText,
  covariatesUseLine,
  requiredTickedCards,
} from '../lib/covariates'
import { useKeepCopies } from '../data/useKeepCopies'
import { useRunConfig } from '../data/useRunConfig'
import { predictFilesPath, runningPath } from '../routes'
import { previousLearnRoute } from '@/modules/txrshell/lib/flowSteps'
import {
  checkLookAhead,
  crosscheckSizeWarning,
  drawDayError,
  lookAheadSuggestions,
  plainLookAheadDefault,
} from '@/modules/txrintake/lib/dayChoices'
import { runAction } from '@/core/actions/defineAction'
import { useAction } from '@/core/actions/useAction'
import { useActiveContext } from '@/core/actions/activeContext'
import { createVersioned } from '@/core/actions/versioned'

/** What step 4's day settings report to the AI (`runSettings.setDay`). */
interface RunDaySnapshot extends Record<string, unknown> {
  decision_day: number
  look_ahead_day: number
}
import { TxrChangeFilesDialog } from '../components/TxrChangeFilesDialog'
import { TxrRunEmptyState } from '../components/TxrRunEmptyState'
import { TxrSettingsBlock } from '../components/TxrSettingsBlock'
import { TxrFilesSummary } from '../components/TxrFilesSummary'
import { TxrRunBar } from '../components/TxrRunBar'
import type { TxrMethodCard, TxrMethodPreset } from '@/modules/txrlist'

/**
 * Screen E — Choose the methods and settings (qa-fixes3 ITEM-1 redesign,
 * part 1: structure, defaults, rows; ITEM-2: the settings card's title and
 * live sentence, the compact files summary, the new run bar and the phone
 * layout):
 *
 * - the list is the picker `TxrMethodPicker` (txrlist), fed by the
 *   catalogue × eligibility adapter (`useMethodRows` — the intake
 *   validation's ONE inventory, DEC-13: this page never re-validates) with
 *   the new human-name fields (title/summary/paper_title) from the API;
 * - on arrival a deterministic recommended set is already ticked (up to 8,
 *   at most 3 per family — `recommendedSelection`); the user's own tick or
 *   a preset stops the auto-selection for the rest of the screen's life
 *   (a settings change then keeps the user's selection — ITEM-2's
 *   eligibility-preserving rule: the selection keeps the still-eligible,
 *   the newly-ineligible are unticked with the toast);
 * - the eligibility request reflects the SETTINGS the screen shows (the
 *   decision day + the extra-inputs switch are the verdicts' own inputs),
 *   so a change re-checks with the picker's visible re-check line;
 * - the run bar is ITEM-2's own `TxrRunBar` (the boards' shared
 *   `TxrListBottomBar` stays for the D/I model screens);
 * - the create path is unchanged: `buildRunRequest` → `Txr.createRun`, the
 *   202 → `runningPath`, the 404/409 resolutions, the one-create-in-flight
 *   guard (see the ITEM-8 notes carried in the git history).
 *
 * The frame (app-shell ITEM-2, changed by the step-4 fix): the fixed top
 * holds ONLY the step line and the title. The intro, the files summary, the
 * settings card, the alerts and the whole picker (presets, re-check line,
 * toolbar, sections, can't-run section) are in ONE ScrollRegion, in that
 * order; the sections' sticky headers stick to the region's top, and the
 * run bar is pinned in the frame's bottom slot. The routed area itself
 * never scrolls: the region is the page's one scroll container. Before the
 * fix the summary, the settings and the picker toolbar sat in the fixed
 * top, and at the desktop's default 1200x800 window the list region was
 * 7 px tall (0 px with More settings open).
 */

const PAGE_OUTER: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The fixed top's own padding (the frame's page chrome: step + title). */
const PAGE_TOP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '24px 36px 0',
  minWidth: 0,
}

/** The region's content: the intro, the files summary, the settings, the
 *  alerts and the picker, in one column (the region scrolls, the padding
 *  rides). The 12 px gap is the old fixed top's rhythm. */
const REGION_CONTENT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 36px 24px',
  minWidth: 0,
}

/** "Change settings" scrolls the region to the settings card; the margin
 *  keeps the card off the region's top edge. */
const SETTINGS_ANCHOR: CSSProperties = { scrollMarginTop: 12 }

const TITLE: CSSProperties = {
  margin: '2px 0 6px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

/** The board's lead paragraph under the title (the data-filled meter). */
const INTRO: CSSProperties = { margin: 0, color: 'var(--txr-text-2)', maxWidth: '62ch' }

/** The settings card's skeleton while the first sticky-config GET is in
 *  flight (a defaults flash would mislead). */
const SETTINGS_SKELETON: CSSProperties = {
  height: 72,
  borderRadius: 10,
}

/** The pending line's card (the inputs are there, the summary is not). */
const PENDING_BLOCK: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '18px 20px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
}

const PENDING_LINE: CSSProperties = { margin: 0, fontSize: 13.5, color: 'var(--txr-muted)' }

/** The page's cards while there is no inventory to check against. */
const NO_CARDS: TxrMethodCard[] = []

/** The pending line (the list's place while the summary is transiently null). */
const PENDING_REFRESH_LINE = 'Re-check your files to see what can run.'

/** The run statuses DEC-18 calls "active" (the one-active-run 409's target). */
const ACTIVE_RUN_STATUSES: ReadonlySet<TxrRunStatus> = new Set([
  'creating',
  'preparing',
  'running',
])

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

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return 'The run could not be created.'
}

/** The diff-patch: the fields the user changed from the value the screen
 *  showed (a change never writes defaults over a sticky field). */
function diffPatch(next: RunSettings, current: RunSettings): Partial<RunSettings> {
  const out: Partial<RunSettings> = {}
  for (const key of Object.keys(next) as (keyof RunSettings)[]) {
    if (next[key] !== current[key]) {
      ;(out as Record<keyof RunSettings, unknown>)[key] = next[key]
    }
  }
  return out
}

/** The picker's frame: the inventory-dependent hooks (the one adapter fed by
 *  the validation's inventory — a null inventory never fabricates a request
 *  object) plus the ONE-TIME recommended seeding and the ITEM-2
 *  eligibility-preserving rule. The joined cards are reported up so the page
 *  can count the bar's selection against the real runnable set (a stale key
 *  is never counted).
 *
 *  The ticks live in the intake store per set of checked files (`seeded` is
 *  true once ticks exist for them): coming back to the screen with the same
 *  files keeps the ticks instead of seeding the recommendation again. */
function TxrMethodPickerFrame({
  inventory,
  selected,
  seeded,
  onSelectionChange,
  onUserSelectionChange,
  onCards,
  onChangeFiles,
  onChangeSettings,
  recheckAsks,
  initialPreset,
  onPresetChosen,
  treatmentClassLabels,
  onInstanceId,
  demo = false,
}: {
  inventory: InventoryEligibilityRequest
  selected: ReadonlySet<string>
  /** Ticks already exist for these files (seeded before, or the user's own). */
  seeded: boolean
  /** A change the screen makes (the seed, the eligibility prune). */
  onSelectionChange(next: ReadonlySet<string>): void
  /** The user's own change (a tick or a preset): the seed never overrides it. */
  onUserSelectionChange(next: ReadonlySet<string>): void
  /** The joined cards and the method list they come from (`null` before the first). */
  onCards(cards: TxrMethodCard[], methodListSequence: number | null): void
  onChangeFiles(): void
  onChangeSettings(): void
  /** How many times the user changed a setting the eligibility request
   *  reads (the page counts them): an answer is a re-check worth a line only
   *  when this moved since the previous answer. */
  recheckAsks: { readonly current: number }
  /** The preset kept for these files (the picker shows it pressed again). */
  initialPreset: TxrMethodPreset | null
  /** A preset was applied: the page keeps it with the ticks. */
  onPresetChosen(preset: TxrMethodPreset): void
  /** The mounted picker's `view_id` (the page addresses the automatic
   *  `methods.setTicked` step at it). */
  onInstanceId(viewId: string): void
  /** The vocabulary's treatment-class labels (step2-filters): the reason
   *  lines render the names the vocabulary carries, never the raw ids. */
  treatmentClassLabels: ReadonlyArray<{ id: string; label: string }>
  /** demo-mode ITEM-6: the picker's list is the recorded methods only. */
  demo?: boolean
}) {
  const { cards, loading, error, refetch, methodListSequence } = useMethodRows(inventory, {
    treatmentClasses: treatmentClassLabels,
  })
  // Ticks that exist for these files (seeded, or the user's own tick or
  // preset) turn the auto-recommendation off — a settings change recomputes
  // eligibility but never overrides them, and neither does a return to the
  // screen with the same files.
  // The effect below is keyed on `cards` only (the adapter's one event); the
  // CURRENT selection and seed state are read through refs so the prune is
  // never stale.
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const seededRef = useRef(seeded)
  seededRef.current = seeded
  // The step-4 re-check line. An answer is a new `cards` array from the
  // adapter (its state is set once per answer; its initial empty array is
  // not one). An answer after the first, to a request the USER caused (a
  // decision-day or extra-inputs change, `recheckAsks`), gets a line saying
  // what changed in the runnable set, or that nothing did. An answer nobody
  // asked for (the sticky settings landing after the first answer on
  // arrival) just becomes the new baseline. A files change is not a
  // re-check here: it nulls the validation, which unmounts this frame, so
  // the next answer is a first answer again.
  const initialCards = useRef(cards)
  const answeredKeys = useRef<string[] | null>(null)
  const answeredAsks = useRef(recheckAsks.current)
  const [recheckResult, setRecheckResult] = useState<string | null>(null)

  // A new request clears the last line (it described the previous one).
  useEffect(() => {
    if (loading && answeredKeys.current !== null) setRecheckResult(null)
  }, [loading])

  // A re-check that fails while a list is on screen says so: the list keeps
  // the last answer, which may no longer match the settings.
  useEffect(() => {
    if (error !== null && answeredKeys.current !== null) setRecheckResult(recheckFailedLine(error))
  }, [error])

  useEffect(() => {
    onCards(cards, methodListSequence)
    if (cards !== initialCards.current) {
      const keys = runnableCards(cards).map(card => card.key)
      const asked = recheckAsks.current !== answeredAsks.current
      setRecheckResult(
        answeredKeys.current !== null && asked ? recheckLine(answeredKeys.current, keys) : null,
      )
      answeredKeys.current = keys
      answeredAsks.current = recheckAsks.current
    }
    // ITEM-2: a settings change re-checks eligibility; the selection keeps
    // the methods that still fit, and the ones that stopped being eligible
    // are UNTICKED with the toast (the plan's words). This runs before the
    // seed, so the first-load recommendation never fires it.
    const disabled = new Set(cards.filter(card => card.run.disabled).map(card => card.key))
    const current = selectedRef.current
    const dropped = [...current].filter(key => disabled.has(key))
    if (dropped.length > 0 && cards.length > 0) {
      const next = new Set([...current].filter(key => !disabled.has(key)))
      onSelectionChange(next)
      message.warning(
        dropped.length === 1
          ? '1 method no longer fits these settings'
          : `${dropped.length} methods no longer fit these settings`,
      )
    }
    if (seededRef.current || cards.length === 0) return
    seededRef.current = true
    onSelectionChange(new Set(recommendedSelection(cards)))
    // `cards` is the only trigger: the seed is one-shot per card set; a
    // content-identical rebuild (same inventory) does not re-seed because
    // the adapter keeps the last good cards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards])

  // demo-mode ITEM-6: the recorded methods only. Memoized: a new array on
  // every render would read as new cards to the picker (its state token
  // would move on every re-render, not only on a change).
  const pickerCards = useMemo(
    () => (demo ? cards.filter(card => !card.run.disabled) : cards),
    [demo, cards],
  )

  return (
    <TxrMethodPicker
      cards={pickerCards}
      loading={loading}
      refreshing={loading}
      error={error}
      onRetry={refetch}
      selected={selected}
      onSelectionChange={onUserSelectionChange}
      onChangeFiles={onChangeFiles}
      onChangeSettings={onChangeSettings}
      recheckResult={recheckResult}
      initialPreset={initialPreset}
      onPresetChosen={onPresetChosen}
      onInstanceId={onInstanceId}
    />
  )
}

export function ChooseMethodsPage() {
  const navigate = useNavigate()
  const [changeOpen, setChangeOpen] = useState(false)
  const [settingsPatch, setSettingsPatch] = useState<Partial<RunSettings> | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [runNotice, setRunNotice] = useState<string | null>(null)
  const creating = useRef(false)
  /** The user's changes to what the eligibility request reads (the decision
   *  day, the extra-inputs switch): the picker frame shows a re-check line
   *  only for answers the user asked for. */
  const recheckAsks = useRef(0)
  /** A create is in flight: Back is unavailable until it settles (the
   *  success path leaves for the Running screen). */
  const [starting, setStarting] = useState(false)
  const settingsAnchor = useRef<HTMLDivElement | null>(null)
  useDocumentTitle('Choose the methods and settings')
  /** A short shell window collapses the summary + settings cards by
   *  default. Both now scroll with the list (step-4 fix), so the collapse
   *  only saves scrolling on a 720/768 px window. */
  const short = useShortShell()
  const mode = useStore(useTxrIntakeStore, s => s.mode)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const methodPicks = useStore(useTxrIntakeStore, s => s.methodPicks)
  const dayFacts = useStore(useTxrIntakeStore, s => s.dayFacts)
  const lookAheadDay = useStore(useTxrIntakeStore, s => s.lookAheadDay)
  // The intake answers' filter facts the eligibility request carries
  // (step2-filters): the same builder the preview body uses — answered
  // fields only, the whole block omitted when nothing is answered. The
  // vocabulary (5a3) is the answers' validity gate: only the ids it knows
  // are sent, and before it loads the disease/treatment fields are omitted
  // (a stale persisted id must never 422 this screen; the outcome rides).
  const intakeAnswers = useIntakeAnswers()
  const { vocabulary, treatmentClasses } = useFilterOptions()
  const methodFilters = useMemo(
    () => buildMethodFilters(intakeAnswers, vocabulary),
    [intakeAnswers, vocabulary],
  )
  const runConfig = useRunConfig()
  const { keepCopies } = useKeepCopies()
  const { isDemo } = useAppMode()
  // The step's Back (the step trail): with no trail, Back goes to the file
  // step of this flow.
  useStepBack({
    step: 'choose-methods',
    fallback: mode === 'predict' ? predictFilesPath() : previousLearnRoute('choose-methods'),
    blockedReason: starting ? STEP_BACK_STARTING_REASON : null,
    dialogOpen: changeOpen,
  })

  // demo-mode ITEM-6: the recorded setup IS the screen's settings (the
  // estimate + eligibility arms answer from the bundle regardless, and the
  // configs are the recorded ones — the sticky analysis-config of a shared
  // pool is never a visitor's opinion, so the demo merge ignores it).
  const base = useMemo(
    () =>
      isDemo
        ? mergeRunSettings(null, parameters)
        : mergeRunSettings(runConfig.engine, parameters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isDemo, runConfig.engine, parameters],
  )
  // The look-ahead day of THIS analysis: the day chosen for it (a
  // suggestion, a typed day, History "Use these settings again"), else the
  // default its files suggest for the decision day and outcome on screen
  // (decision day + 182 when at least half the patients have a known
  // outcome there). The demo keeps its recorded setup.
  const shownDecisionDay = settingsPatch?.decision_day ?? base.decision_day
  const shownEndpoint = settingsPatch?.endpoint ?? base.endpoint
  const defaultLookAhead =
    dayFacts !== null && dayFacts.outcomes.length > 0
      ? lookAheadSuggestions(dayFacts, shownDecisionDay, shownEndpoint).default
      : plainLookAheadDefault(
          shownDecisionDay,
          dayFacts?.limits.look_ahead_day_max ?? Number.POSITIVE_INFINITY,
        )
  const merged = isDemo ? base : { ...base, look_ahead_day: lookAheadDay ?? defaultLookAhead }
  const settings = settingsPatch === null ? merged : { ...merged, ...settingsPatch }
  // The latest settings as a ref, updated on every render AND every change:
  // `setDay` reads/writes through it, so two calls in one tick (decision day,
  // then look-ahead) never let the second read the first call's stale
  // decision day back (the render closure only turns over on a re-render).
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // ── single-marker-choice round 2: the ranking call ──────────────────────────
  // The SAME parsed tables the run request carries (the intake store's ONE
  // builder) + the current endpoint, decision day and the person's step-3
  // choice. The hook debounces and re-calls when any of them change; while it
  // settles the eligibility request carries no plan (the method list does not
  // wait) and the line above reads "Ranking your markers…". The demo keeps
  // its recorded setup — no live ranking there.
  const singleMarkerChoice = useStore(useTxrIntakeStore, s => s.singleMarkerChoice)
  const markerRankingRequest = useMemo<MarkerRankingRequest | null>(() => {
    if (isDemo || validation === null) return null
    try {
      const input = buildTxrRunInput(
        {
          patients,
          measurements,
          predictMeasurements,
          joins,
          mapping,
        } as unknown as IntakeSnapshot,
        'learn',
      )
      return {
        ...input,
        endpoint: settings.endpoint,
        decision_day: settings.decision_day,
        ...(singleMarkerChoice.mode === 'ranked' ? {} : { single_marker: singleMarkerChoice }),
      } as MarkerRankingRequest
    } catch {
      // No measurements file (the page's empty state already says so).
      return null
    }
  }, [
    isDemo,
    validation,
    patients,
    measurements,
    predictMeasurements,
    joins,
    mapping,
    settings.endpoint,
    settings.decision_day,
    singleMarkerChoice,
  ])
  const ranking = useMarkerRanking(markerRankingRequest)
  const markerPlan = eligibilityMarkerPlan(singleMarkerChoice, ranking.response, ranking.loading)
  // The patients file's Extra-inputs facts (memoized: the settings card and
  // the eligibility request both read them; the object is rebuilt only when
  // the file object changes).
  const covariates = useMemo(
    () => (patients === null ? null : buildCovariates(patients.inspection)),
    [patients],
  )

  const change = (next: RunSettings): void => {
    // The ref is the newest settings even when two change calls land in one
    // tick (a second call must diff against the first call's result, never
    // against the render-time `settings` — the diff against the stale value
    // omits a day the second call changed back to it).
    const prev = settingsRef.current
    if (next.decision_day !== prev.decision_day || next.covariates !== prev.covariates) {
      recheckAsks.current += 1
    }
    settingsRef.current = next
    setSettingsPatch(current => ({ ...(current ?? {}), ...diffPatch(next, prev) }))
    // demo-mode ITEM-6: the demo never writes the shared-pool sticky row
    // (the recorded setup is the one setup; the run carries its own).
    if (isDemo) return
    void runConfig.update(next)
  }

  // Step 4's day settings as an AI-controllable instance (`runSettings.setDay`,
  // `core/actions/builtin/dayActions.ts`): a suggested day button, a typed day
  // and the action all run `setDay`, which refuses a day outside its limits
  // and a look-ahead day where no patient has a known outcome.
  const lookAheadMax = dayFacts?.limits.look_ahead_day_max ?? Number.POSITIVE_INFINITY
  const setDay = (field: 'decision_day' | 'look_ahead_day', day: number): RunDaySnapshot => {
    if (isDemo) throw new Error(DEMO_SETTINGS_NOTE)
    // The ref is the newest settings, even when two calls land in one tick.
    const latest = settingsRef.current
    if (field === 'decision_day') {
      const problem =
        dayFacts === null
          ? Number.isInteger(day) && day >= 1
            ? null
            : 'Choose a whole day from 1.'
          : drawDayError(day, dayFacts.limits.look_ahead_day_max)
      if (problem !== null) throw new Error(problem)
      change({ ...latest, decision_day: day })
      return { decision_day: day, look_ahead_day: latest.look_ahead_day }
    }
    const problem = checkLookAhead(dayFacts, latest.decision_day, day, latest.endpoint, lookAheadMax).error
    if (problem !== null) throw new Error(problem)
    TxrIntake.setLookAheadDay(day)
    change({ ...latest, look_ahead_day: day })
    return { decision_day: latest.decision_day, look_ahead_day: day }
  }
  const [settingsViewId] = useState(() => crypto.randomUUID())
  const daySnapshot: RunDaySnapshot = {
    decision_day: settings.decision_day,
    look_ahead_day: settings.look_ahead_day,
  }
  const [dayVersioned] = useState(() => createVersioned(settingsViewId, daySnapshot))
  useEffect(() => {
    const last = dayVersioned.value
    if (last.decision_day !== daySnapshot.decision_day || last.look_ahead_day !== daySnapshot.look_ahead_day) {
      dayVersioned.set(daySnapshot)
    }
  })

  // ── AOC part 2: the Extra-inputs switch's two automatic steps ──────────────
  // Auto-on: a ticked runnable method with requirement `required`, the file's
  // extra-input columns present, and the switch off → the switch turns itself
  // on through `runSettings.setCovariates` and ONE plain line says why. The
  // line stays until the switch changes or the set of required ticked methods
  // changes. A manual (or agent) switch-off with required methods ticked
  // unticks them through `methods.setTicked` and shows its own line; the
  // switch stays off (the auto-on fires only when a required method BECOMES
  // ticked while the switch is off — the untick runs in the same handler, so
  // the auto-on effect never sees switch-off + required-ticked: no loop).
  // Optional or none methods never trigger either step.
  const [pickerViewId, setPickerViewId] = useState<string | null>(null)
  const pickerViewIdRef = useRef<string | null>(null)
  pickerViewIdRef.current = pickerViewId
  /** The latched one-plain-line result (the switch's automatic steps). */
  const [covariatesLine, setCovariatesLine] = useState<{
    kind: 'auto' | 'untick'
    keys: string[]
    text: string
  } | null>(null)
  /** The auto-on's own switch change: `setCovariates` consumes the mark on
   *  an on-transition so the line it just set survives that transition. */
  const autoOnPending = useRef(false)
  /** The latest cards/selection/picker id the action handlers read (the
   *  handler closures are fresh per render, but a second call in one tick
   *  must never read the previous tick's values). */
  const cardsRef = useRef<ReadonlyArray<TxrMethodCard>>(NO_CARDS)
  const selectedRef = useRef<ReadonlySet<string>>(new Set())
  /** The required ticked keys of the previous render: the auto-on fires on a
   *  required method BECOMING ticked, not merely being ticked. */
  const prevRequiredKeys = useRef<string[]>([])

  /** The Extra-inputs switch's handler (`runSettings.setCovariates`): the
   *  switch's click, the AI invoke and the automatic steps all run it. */
  const setCovariates = (on: boolean): void => {
    if (isDemo) throw new Error(DEMO_SETTINGS_NOTE)
    const latest = settingsRef.current
    if (on) {
      // Turning the switch on needs a file with extra-input columns. The UI
      // switch is already disabled there; this refusal is the ASSISTANT path
      // (the automatic auto-on never gets here: it only fires when the
      // columns are present). A refused call changes nothing.
      const problem =
        covariates === null
          ? 'There is no patients file, so Extra inputs cannot be turned on.'
          : covariates.availability === 'absent'
            ? 'The file has no extra-input columns, so Extra inputs cannot be turned on.'
            : null
      if (problem !== null) throw new Error(problem)
      // An on-transition: the auto-on's own change keeps the line it set;
      // any other change (the person or the agent) ends the latched line's
      // lifetime ("stays until the switch changes").
      if (autoOnPending.current) autoOnPending.current = false
      else setCovariatesLine(null)
    } else {
      // A manual (or agent) switch-off: the ticked required methods are
      // unticked and the one line says so — never leave the switch off with
      // required methods ticked. The untick runs through the SAME registered
      // `methods.setTicked` the card click uses; while the picker's view id
      // is not known yet (no mounted list to address), the page's own
      // selection path (`updateSelection`) gives the same result. The untick
      // is synchronous inside the action call, so the auto-on step below
      // never observes switch-off + required-ticked — no loop.
      const required = requiredTickedCards(cardsRef.current, selectedRef.current)
      const keys = required.map(card => card.key)
      if (required.length > 0) {
        const text = covariatesUntickText(required)
        if (text !== null) setCovariatesLine({ kind: 'untick', keys, text })
        if (pickerViewIdRef.current !== null) {
          void runAction(METHODS_SET_TICKED, {
            view_id: pickerViewIdRef.current,
            keys,
            ticked: false,
          }).catch((error: unknown) => {
            message.error(error instanceof Error ? error.message : 'Could not untick the methods.')
          })
        } else {
          const unticked = new Set(keys)
          updateSelection(current => new Set([...current].filter(key => !unticked.has(key))), false)
        }
      } else {
        setCovariatesLine(null)
      }
    }
    change({ ...latest, covariates: on })
  }

  useAction(settingsViewId, {
    type: TXR_RUN_SETTINGS_CONTEXT,
    handlers: {
      [RUN_SETTINGS_SET_DAY]: params => {
        const { field, day } = params as { field: 'decision_day' | 'look_ahead_day'; day: number }
        return setDay(field, day)
      },
      [RUN_SETTINGS_SET_COVARIATES]: params => {
        const { on } = params as { on: boolean }
        return setCovariates(on)
      },
    },
    getSnapshot: () => dayVersioned.snapshot(),
  })
  useActiveContext(TXR_RUN_SETTINGS_CONTEXT, { entityId: settingsViewId })
  const chooseDay = useCallback(
    (field: 'decision_day' | 'look_ahead_day', day: number): void => {
      void runAction(RUN_SETTINGS_SET_DAY, { view_id: settingsViewId, field, day }).catch(
        (error: unknown) => {
          // A refusal is shown, never silent: the day stays what it was.
          message.error(error instanceof Error ? error.message : 'Could not set the day.')
        },
      )
    },
    [settingsViewId],
  )
  /** The switch's click: the registered action (the AI drives the same one);
   *  a refusal (the demo's locked step) is shown, never silent. */
  const chooseCovariates = useCallback(
    (on: boolean): void => {
      void runAction(RUN_SETTINGS_SET_COVARIATES, { view_id: settingsViewId, on }).catch(
        (error: unknown) => {
          message.error(error instanceof Error ? error.message : 'Could not set the extra inputs.')
        },
      )
    },
    [settingsViewId],
  )
  /** The mounted method picker reports its `view_id`: the page's automatic
   *  `methods.setTicked` step (the switch-off untick) addresses it. */
  const onPickerInstanceId = useCallback((viewId: string): void => {
    setPickerViewId(viewId)
  }, [])
  const lookAheadBlocked = isDemo
    ? null
    : checkLookAhead(dayFacts, settings.decision_day, settings.look_ahead_day, settings.endpoint, lookAheadMax)
        .error

  // The ONE cross-check notice above the method list: the file is too small
  // for the engine's K=3 stratified cross-check at the shown look-ahead day
  // (the same known-label counts the day line shows, compared with the
  // engine's own limits from the validate facts — no constant here). It is
  // a notice only: it changes no tick and no eligibility verdict; the run
  // still refuses per method with BUNDLE_CROSSCHECK_TOO_SMALL and its own
  // per-method failure text.
  const crosscheckNotice = useMemo(
    () =>
      dayFacts === null
        ? null
        : crosscheckSizeWarning(
            dayFacts,
            settings.decision_day,
            settings.look_ahead_day,
            settings.endpoint,
          ),
    [dayFacts, settings.decision_day, settings.look_ahead_day, settings.endpoint],
  )

  // The load transition (the engine's sticky fields land after an edit): the
  // write-through body is once more the screen's truth. Keyed on the hook's
  // LOAD count, never on `engine`: each save replaces `engine` too, so an
  // `engine` key re-wrote after every save, forever.
  const loadsBefore = useRef(runConfig.loadCount)
  useEffect(() => {
    const previous = loadsBefore.current
    loadsBefore.current = runConfig.loadCount
    if (settingsPatch === null) return
    if (previous !== runConfig.loadCount) {
      void runConfig.update({ ...merged, ...settingsPatch })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runConfig.loadCount])

  const inventory = validation?.inventory ?? null
  // The ticks kept for THESE files (the intake store's `methodPicks`, keyed
  // by the inventory's content): other files' ticks are not this screen's.
  const picksKey = useMemo(
    () => (inventory === null ? null : stableInventoryKey(inventory)),
    [inventory],
  )
  const ownPicks = methodPicks !== null && methodPicks.key === picksKey ? methodPicks : null
  const selected = useMemo<ReadonlySet<string>>(
    () => new Set(ownPicks?.selected ?? []),
    [ownPicks],
  )
  selectedRef.current = selected
  const updateSelection = useCallback(
    (next: (current: ReadonlySet<string>) => ReadonlySet<string>, byUser: boolean): void => {
      if (picksKey === null) return
      const picks = useTxrIntakeStore.getState().methodPicks
      const own = picks !== null && picks.key === picksKey ? picks : null
      TxrIntake.setMethodPicks({
        key: picksKey,
        selected: [...next(new Set(own?.selected ?? []))],
        touched: byUser || (own?.touched ?? false),
        preset: own?.preset ?? null,
      })
    },
    [picksKey],
  )
  /** A preset was applied: kept with the ticks, so a return shows it pressed. */
  const rememberPreset = useCallback(
    (preset: TxrMethodPreset): void => {
      if (picksKey === null) return
      const picks = useTxrIntakeStore.getState().methodPicks
      const own = picks !== null && picks.key === picksKey ? picks : null
      TxrIntake.setMethodPicks({
        key: picksKey,
        selected: own?.selected ?? [],
        touched: own?.touched ?? false,
        preset,
      })
    },
    [picksKey],
  )
  // ITEM-2 (a): the ONE compact summary (the line + marker names + the
  // Details list) — the builder's facts are the store's own (DEC-13).
  const filesSummary = useMemo(
    () =>
      buildFilesSummary({
        mode,
        patients,
        measurements,
        predictMeasurements,
        validation,
      }),
    [mode, patients, measurements, predictMeasurements, validation],
  )
  // ITEM-2 (b): the eligibility request reflects the SETTINGS the screen
  // shows — the decision day and the extra-inputs switch are the two
  // settings the verdicts read (the wire's own fields), so a change here
  // changes the inventory's content key and the adapter refetches (the
  // visible re-check state) while the picker keeps the last cards. The
  // intake answers' filter facts ride the same request as the `filters`
  // block (step2-filters) — answered fields only; the block itself is
  // omitted for an unanswered question group (the request without it is
  // exactly the "any" verdicts).
  //
  // AOC part 2 (option A): the EXTRA-INPUT COLUMN NAMES ride the request
  // whenever the file's inspection says they are there (availability
  // `present`), whatever the switch says — a `required` method is tickable
  // with the switch off, and the switch then only decides whether the run
  // uses the columns. A file with no extra-input columns (`absent`) keeps
  // `[]`: the required methods are cannot-run with COVARIATE_REQUIRED_UNMET
  // exactly as before. When the screen CANNOT say yet (availability
  // `unknown` — no resolved inspection), today's rule is kept: the names
  // ride when the switch is on, `[]` when it is off (the request's verdict
  // then follows the switch exactly as before the option-A change).
  const settingsInventory = useMemo(
    () =>
      inventory === null
        ? null
        : {
            ...inventory,
            decision_day: settings.decision_day,
            covariates:
              covariates !== null && covariates.availability === 'present'
                ? inventory.covariates
                : covariates !== null &&
                    covariates.availability === 'unknown' &&
                    settings.covariates
                  ? inventory.covariates
                  : [],
            ...(hasMethodFilters(methodFilters) ? { filters: methodFilters } : {}),
            // The step-4 marker plan (round 2): the ranking route's result
            // copied onto the eligibility request so the no-list verdicts
            // match the run; omitted while the ranking is still loading (a
            // stale plan for the OLD endpoint/day is never used).
            ...(markerPlan !== undefined ? { marker_plan: markerPlan } : {}),
            // The rows' times and the "Fast only" preset are for the LEARNING
            // run this screen builds (the create path posts mode 'train') —
            // the server applies the cross-check factor once, here.
            mode: 'train' as const,
          },
    [inventory, settings.decision_day, covariates, settings.covariates, methodFilters, markerPlan],
  )
  const [cardsState, setCards] = useState<TxrMethodCard[]>([])
  // While the validation is null (Change files has just changed a file),
  // the picker frame is unmounted and its last cards are the OLD files'
  // cards: the page counts nothing then (the Extra-inputs help falls back to
  // its general line), until the new files' first answer arrives.
  const cards = settingsInventory === null ? NO_CARDS : cardsState
  cardsRef.current = cards
  // The step-4 marker line (single-marker-choice round 2): the ranking's
  // sentence for the choice, the route's no-ranking message, or the waiting
  // line — only when a SHOWN method has no fixed list (the list itself does
  // not wait for the ranking). The demo keeps its recorded setup: no line.
  const markerLine = isDemo
    ? null
    : markerLineText(
        singleMarkerChoice,
        ranking.response,
        ranking.loading,
        cards,
        SETTING_ENDPOINT_WORD[settings.endpoint].toLowerCase(),
      )
  // "Change it in step 3" runs the SAME registered step-navigation action as
  // the step's Back (`flow.back`; no new route).
  const changeMarkerInStep3 = useCallback((): void => {
    void runAction('flow.back', {}).catch((error: unknown) => {
      message.error(error instanceof Error ? error.message : 'Could not go back.')
    })
  }, [])
  // The method list the cards on screen come from: a run request sends it back, so a
  // selection made on one list never starts a run on another (409 METHOD_LIST_CHANGED).
  // Never the latest status read: that moves ahead of the cards until they reload.
  const cardsListSequence = useRef<number | null>(null)
  const onCards = useCallback((next: TxrMethodCard[], sequence: number | null): void => {
    cardsListSequence.current = sequence
    setCards(next)
  }, [])

  // The mount-time seed and the eligibility prune can both make a required
  // method ticked while the switch is off; the auto-on and the latched
  // line's lifetime (the switch or the required ticked set changing) are
  // this effect's one place.
  useEffect(() => {
    if (isDemo) return
    const requiredNow = requiredTickedCards(cards, selected).map(card => card.key)
    const previous = prevRequiredKeys.current
    const became = requiredNow.filter(key => !previous.includes(key))
    const lost = previous.filter(key => !requiredNow.includes(key))
    const availability = covariates?.availability ?? 'unknown'
    const autoOn = covariatesAutoOnLine(cards, selected, availability, settings.covariates)

    // Auto-on: a required method BECAME ticked while the switch is off and
    // the file has the extra-input columns (the decision function already
    // gates the switch + availability + a required ticked method). The step
    // needs ONLY the settings action (`runSettings.setCovariates` on
    // `settingsViewId`) — never the method picker's view id.
    //
    // The previous set records ONLY transitions the step actually consumed:
    // the auto-on itself, or a required method that was unticked. A BECAME
    // the conditions still block (the switch is on, or the columns are not
    // known to be present) is NOT recorded — the auto-on fires when the
    // conditions turn, never recorded as done and lost for good.
    if (became.length > 0 && autoOn !== null) {
      prevRequiredKeys.current = requiredNow
      autoOnPending.current = true
      setCovariatesLine({ kind: 'auto', keys: requiredNow, text: autoOn })
      void runAction(RUN_SETTINGS_SET_COVARIATES, { view_id: settingsViewId, on: true }).catch(
        (error: unknown) => {
          autoOnPending.current = false
          message.error(error instanceof Error ? error.message : 'Could not turn the extra inputs on.')
        },
      )
      return
    }
    // A latched AUTO line follows the required ticked set (a tick, an
    // untick, a re-check that made a card cannot-run): it recomputes or
    // clears. The UNTICK line stays (its methods were already unticked; a
    // new required tick takes the auto-on path above).
    if (became.length > 0 || lost.length > 0) {
      if (became.length === 0 && lost.length > 0) prevRequiredKeys.current = requiredNow
      setCovariatesLine(current => {
        if (current === null || current.kind !== 'auto') return current
        if (requiredNow.length === 0) return null
        const text = covariatesAutoOnText(requiredTickedCards(cards, selected))
        return text === null ? null : { kind: 'auto', keys: requiredNow, text }
      })
    }
  }, [cards, selected, settings.covariates, covariates, settingsViewId, isDemo])
  const estimate = useListEstimate([...selected], {
    patients: inventory?.patients ?? 0,
    cpus: settings.cpus ?? undefined,
    atATime: settings.at_a_time,
    // This screen only builds LEARNING runs (the create path below posts
    // mode 'train'): the estimate carries the cross-check time factor for
    // methods that learn, so the bar, the row times and the "Fast only"
    // preset agree with what the run will actually spend.
    mode: 'train',
  })

  const createRun = useCallback(
    async (
      keys: string[],
      opts: { atATime: number; saveModels: boolean },
    ): Promise<void> => {
      if (creating.current) return
      creating.current = true
      setStarting(true)
      setRunError(null)
      setRunNotice(null)
      // A navigation to the Running screen leaves this step: Back stays
      // unavailable until the route changes (the Running chunk may still load).
      let leaving = false
      try {
        const input = buildTxrRunInput(
          {
            patients,
            measurements,
            predictMeasurements,
            joins,
            mapping,
          } as unknown as IntakeSnapshot,
          'learn',
        )
        const request = buildRunRequest(
          'train',
          { ...input, keep_copies: keepCopies },
          { ...settings, at_a_time: opts.atATime, save_models: opts.saveModels },
          keys,
          singleMarkerChoice,
        )
        // The method list the cards came from: a run is never started from a
        // selection made on another list (409 METHOD_LIST_CHANGED).
        const shown = cardsListSequence.current
        if (shown !== null) request.method_list_sequence = shown
        const run = await ApiClient.Txr.createRun(request)
        leaving = true
        navigate(runningPath(run.id))
      } catch (err) {
        const status = errorStatus(err)
        if (status === 409 && isMethodListChanged(err)) {
          // Note the newer list: the cards and verdicts reload, the user checks.
          await refreshMethodListStatus()
          setRunNotice(METHOD_LIST_CHANGED_NOTICE)
        } else if (status === 409) {
          try {
            const page = await ApiClient.Txr.listRuns({ limit: 50 })
            const active = page.runs.find(run => ACTIVE_RUN_STATUSES.has(run.status))
            if (active !== undefined) {
              leaving = true
              navigate(runningPath(active.id), { state: { resumed: true } })
              return
            }
          } catch {
            // The lookup failed — the error line below is the honest state.
          }
          setRunError(RUN_ALREADY_ACTIVE_LINE)
        } else if (status === 404) {
          const message = errorText(err)
          const known = new Set(cards.map(card => card.id))
          const dropped = staleMethodIds(message, keys, [...known])
          if (dropped.length > 0) {
            const droppedSet = new Set(dropped)
            updateSelection(
              current => new Set([...current].filter(key => !droppedSet.has(key))),
              false,
            )
            setRunNotice(droppedNotice(dropped))
          } else {
            setRunError(RUN_METHODS_GONE_LINE)
          }
        } else {
          setRunError(errorText(err))
        }
      } finally {
        creating.current = false
        if (!leaving) setStarting(false)
      }
    },
    [
      patients,
      measurements,
      predictMeasurements,
      joins,
      mapping,
      keepCopies,
      settings,
      cards,
      navigate,
      updateSelection,
      singleMarkerChoice,
    ],
  )

  const onChangeSettings = useCallback((): void => {
    settingsAnchor.current?.scrollIntoView({ block: 'start' })
  }, [])

  /** The fixed top: the step line and the title, nothing else. Every other
   *  part of the page scrolls in the one region below (step-4 fix: with the
   *  files summary, the settings card and the picker toolbar pinned here,
   *  the default 1200x800 window left the method list 7 px). */
  const top = (
    <div className="txr-run-top" style={PAGE_TOP}>
      <TxrStepLine step="choose-methods" />
      <h1 style={TITLE}>Choose the methods and settings</h1>
    </div>
  )

  const missing = runSetupMissing({ mode, patients, measurements, predictMeasurements })
  if (missing !== null) {
    return (
      <main data-testid="txr-run" className="txr-run-page" style={PAGE_OUTER}>
        <PageFrame
          top={top}
          body={
            <ScrollRegion label="Methods to choose">
              <div style={REGION_CONTENT}>
                <TxrRunEmptyState missing={missing} onStartNew={() => navigate('/')} />
              </div>
            </ScrollRegion>
          }
          bottom={<TxrStepBackBar />}
        />
      </main>
    )
  }

  const runBar =
    inventory !== null ? (
      <TxrRunBar
        selectedCount={countSelected(selected, cards)}
        timeText={
          isDemo
            ? estimate.scheduleSeconds === null
              ? '…'
              : formatDurationShort(estimate.scheduleSeconds)
            : formatRunBarTime(estimate.scheduleSeconds, settings.at_a_time, settings.cpus)
        }
        atATime={settings.at_a_time}
        saveModels={{
          checked: settings.save_models,
          onChange: value => change({ ...settings, save_models: value }),
        }}
        onRun={opts => {
          // The bar reports the OPTIONS; the keys are the selection minus
          // the cards this page can see are disabled (the rule set the
          // shared selection helpers compute on the D/I screens).
          const disabled = new Set(cards.filter(card => card.run.disabled).map(card => card.key))
          const keys = [...selected].filter(key => !disabled.has(key))
          void createRun(keys, opts)
        }}
        runLabelSuffix={isDemo ? DEMO_RUN_BUTTON_SUFFIX : undefined}
        back={<TxrStepBack look="run-bar" />}
        blockedReason={lookAheadBlocked}
      />
    ) : null

  return (
    <main data-testid="txr-run" className="txr-run-page" style={PAGE_OUTER}>
      <PageFrame
        top={top}
        body={
          <ScrollRegion label="Methods to choose" className="txr-run-methods-region">
            <div className="txr-run-methods-content" style={REGION_CONTENT}>
              <p data-testid="txr-run-intro" style={INTRO}>
                Run these methods on your patients. Checked against your files;
                each learns from your {inventory !== null ? inventory.patients : 0}{' '}
                patients, then predicts.
              </p>
              <TxrFilesSummary
                line={filesSummary.line}
                markerNames={filesSummary.markerNames}
                details={filesSummary.details}
                onChangeFiles={() => setChangeOpen(true)}
                collapsed={short}
                changeFilesReason={isDemo ? DEMO_DISABLED_REASON : null}
              />
              <div ref={settingsAnchor} style={SETTINGS_ANCHOR}>
                {runConfig.loading ? (
                  <Skeleton data-testid="txr-run-settings-loading" style={SETTINGS_SKELETON} />
                ) : (
                  <>
                    {runConfig.error !== null ? (
                      <Alert
                        tone="warning"
                        data-testid="txr-run-settings-error"
                        title={runConfig.error}
                      >
                        <Button
                          variant="outline"
                          data-testid="txr-run-settings-retry"
                          onClick={runConfig.retry}
                        >
                          Retry
                        </Button>
                      </Alert>
                    ) : null}
                    <TxrSettingsBlock
                      value={settings}
                      covariates={covariates}
                      onChange={change}
                      onCovariatesChange={chooseCovariates}
                      covariatesAutoLine={covariatesLine?.text ?? null}
                      onMoreSettings={next => change({ ...settings, ...next })}
                      collapsed={short}
                      locked={isDemo}
                      covariatesHelp={covariatesUseLine(cards)}
                      dayFacts={dayFacts}
                      onChooseDay={chooseDay}
                    />
                    {isDemo ? (
                      <p data-testid="txr-run-settings-demo-note" style={{ margin: 0, fontSize: 12.5, color: 'var(--txr-muted)' }}>
                        {DEMO_SETTINGS_NOTE}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
              {runError !== null ? (
                <Alert tone="error" data-testid="txr-run-create-error" title={runError} />
              ) : null}
              {runNotice !== null ? (
                <Alert tone="warning" data-testid="txr-run-create-notice" title={runNotice} />
              ) : null}
              {markerLine !== null ? (
                <p data-testid="txr-run-single-marker-line" style={{ margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }}>
                  {markerLine.text}
                  {markerLine.changeable ? (
                    <>
                      {' '}
                      <Button
                        data-testid="txr-run-single-marker-change"
                        variant="link"
                        className="p-0"
                        style={{ fontSize: 13.5, color: 'var(--txr-brand)' }}
                        onClick={changeMarkerInStep3}
                      >
                        {MARKER_CHANGE_IT}
                      </Button>{' '}
                    </>
                  ) : null}
                </p>
              ) : null}
              {crosscheckNotice !== null ? (
                <Alert
                  tone="warning"
                  data-testid="txr-run-crosscheck-notice"
                  title={crosscheckNotice}
                />
              ) : null}
              {settingsInventory === null ? (
                <div data-testid="txr-run-list-pending" style={PENDING_BLOCK}>
                  <p style={PENDING_LINE}>{PENDING_REFRESH_LINE}</p>
                </div>
              ) : (
                <TxrMethodPickerFrame
                  inventory={settingsInventory}
                  selected={selected}
                  seeded={ownPicks !== null}
                  onSelectionChange={next => updateSelection(() => next, false)}
                  onUserSelectionChange={next => updateSelection(() => next, true)}
                  onCards={onCards}
                  onChangeFiles={() => setChangeOpen(true)}
                  onChangeSettings={onChangeSettings}
                  recheckAsks={recheckAsks}
                  initialPreset={ownPicks?.preset ?? null}
                  onPresetChosen={rememberPreset}
                  treatmentClassLabels={treatmentClasses}
                  onInstanceId={onPickerInstanceId}
                  demo={isDemo}
                />
              )}
            </div>
          </ScrollRegion>
        }
        // No inventory (files being re-checked), no run bar: Back still sits
        // at the bottom right.
        bottom={runBar ?? <TxrStepBackBar />}
      />
      <TxrChangeFilesDialog
        mode={mode}
        open={changeOpen}
        onOpenChange={setChangeOpen}
      />
    </main>
  )
}
