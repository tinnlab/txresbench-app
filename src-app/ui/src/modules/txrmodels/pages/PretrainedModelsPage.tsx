/**
 * Screen D — Choose the models to run (board `Pretrained.dc.html`; ITEM-6,
 * PROV-UI-MODELS-5): the model catalogue from `pretrained-catalogue`
 * (PROV-PC-3), checked against the uploaded predict file
 * (PROV-PC-8's verdicts over the ONE intake inventory), hosted in the
 * SHARED `TxrSelectList` (INV-1 — this page is a host, never a fork), with
 * the D download/install guarantee and the reuse-mode Run.
 *
 * THE PAGE (the ITEM-1 chrome is the frame this item fills in):
 *
 * - the header: Step 4 of 4 + the board title + the checked-against line
 *   from the CONS-UM-11 validation ("Checked against your file: 42
 *   patients, 4 markers, draws at day 0, 14, 28 and 56." — the facts are
 *   the validation record's, never a design-example number) and the
 *   verdicts' totals ("N can run, M cannot" = the eligibility response's
 *   fit+some / cannot — the board's own grouping: the rows that run for
 *   some patients count as runnable);
 * - the shared list (rows via ITEM-4's `buildPretrainedRows`, the four D
 *   chips via `pretrainedChipPredicate` + `filterRows`, the sort
 *   comparators, the bottom bar: selected count, DEC-7 total, no
 *   at-a-time/save controls, the research notice, Run); a selected card
 *   whose asset is not installable yet blocks Run with the inline gate
 *   line (DEC-8: the selection is kept, never silently dropped — the
 *   unbundled assets are DOWNLOADED ON SELECTION per models.md, "larger
 *   ones are downloaded when selected");
 * - the downloads strip: one `TxrDownloadState` per live/failed download
 *   (bytes + percent + spinner + error + Retry — the environment-download
 *   idiom, never a silent boolean), composed here because the shared row
 *   is the board row (no per-row slot; the D page owns the host chrome);
 * - the Model card dialog (the row action; `TxrModelCardDialog`);
 * - the Run flow: install-then-run — for each selected card, install if
 *   needed (PROV-PC-7: a bundled/cached asset is installed on the spot, an
 *   `installing` status polls PROV-PC-6 until `ready` and re-installs), the
 *   installed store uuids are RESOLVED first (CONS-UM-24:
 *   `Models.resolveModels` — never bare uuids into the create call), the
 *   response's assets are passed through VERBATIM as `CreateRunRequest.model_ids`,
 *   and `createRun` (CONS-UM-13) → `runningPath(runId)`. The config's
 *   endpoint + look-ahead day are the FIRST SELECTED card's own facts (the
 *   D screen has no settings controls; a model is run at the horizon it
 *   was trained for — DEC-5's endpoint rule extended to the horizon, the
 *   engine's per-method incompatibility governs a mixed selection).
 *
 * STATES: no validated predict file → the not-ready empty state (never a
 * half-built list; the inventory is the validation's — DEC-6); a catalogue
 * or verdict failure → the list's error + Retry; a verdict still loading →
 * the ITEM-4 NOT_RUNNABLE fallback rows (a row never vanishes); the
 * bottom bar total is the DEC-7 sum (a selection with unknown estimates
 * renders the bar's "…").
 *
 * Copy rule (INV-4): the summary line's counts are the validation's own;
 * the boards' numbers are never constants here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import type {
  PretrainedEligibilityEntry,
  PretrainedSummary,
  RunConfig,
} from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import { buildTxrRunInput, useTxrIntakeStore } from '@/modules/txrintake'
import {
  countSelected,
  formatTotalTime,
  TxrSelectList,
} from '@/modules/txrlist'
import { predictFilesPath, runningPath } from '@/modules/txrrun'
import { modelsPath } from '../routes'
import { Alert, Button } from '@ziee/kit'
import { usePretrained } from '../data/usePretrained'
import { usePretrainedEligibility } from '../data/usePretrainedEligibility'
import { useDownloadState } from '../data/useDownloadState'
import { buildPretrainedRows } from '../lib/rows'
import { filterRows, pretrainedChipPredicate, type TxrModelSortable } from '../lib/filters'
import { totalSecondsForSelection } from '../lib/total'
import { formatCheckedAgainstLine, RESEARCH_NOTICE } from '../lib/format'
import { DOWNLOAD_POLL_MS, useTxrModelsStore } from '../stores/TxrModels.store'
import type { TxrModelDialogId, TxrModelFilterId, TxrModelSortId } from '../types'
import { TxrDownloadState } from '../components/TxrDownloadState'
import { TxrModelCardDialog } from '../components/TxrModelCardDialog'

/** The board's page chrome (from the ITEM-1 shell). */
const PAGE_OUTER: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '26px 36px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
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

/** The list area's frame (the bounded column the shared list fills). */
const LIST_FRAME: CSSProperties = {
  flexGrow: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface)',
  overflow: 'hidden',
}

/** The downloads strip's card (the host chrome between list and footnote). */
const DOWNLOAD_STRIP: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 18px',
  alignItems: 'center',
  padding: '10px 14px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
}

/** The strip's "Downloads" caption (the board's muted small line). */
const STRIP_CAPTION: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)', fontWeight: 700 }

/** The board's footnote under the list. */
const FOOTNOTE: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

/** The not-ready state's line (no validated file — never a half list). */
const EMPTY_LINE = 'Add the patients\u2019 measurements you want to predict first.'

/** The not-ready state's CTA — the step that unlocks this one (RES-20: the
 *  old "Go to the start" landed on the landing page, not the predict-files
 *  step the flow needs next). */
const EMPTY_CTA = 'Go to the measurements step'

/** The gate line for a still-downloading selected card. */
const GATE_DOWNLOADING_LINE =
  'A selected model is still downloading. Wait for it to finish, or uncheck it.'

/** The gate line for a failed selected card's download. */
const GATE_FAILED_LINE = "A selected model's download failed. Retry it, or uncheck it."

/** The failure line a start/install error folds back to (never blank). */
const RUN_FAILED_LINE = 'The models could not be prepared.'

/** D's three host chips, fixed order + labels (the boards' words). */
interface Dchip {
  id: TxrModelFilterId
  label: string
}

const D_CHIPS: readonly Dchip[] = [
  { id: 'published', label: 'Published rules' },
  { id: 'learned', label: 'Learned by the benchmark' },
  { id: 'checked-2-plus', label: 'Checked on 2 or more other cohorts' },
]

/** D's sort options (the board's "Sort by" entries, in the board's order). */
const D_SORT_OPTIONS: ReadonlyArray<{ value: TxrModelSortId; label: string }> = [
  { value: 'transfer', label: 'Transfer to other cohorts' },
  { value: 'patients', label: 'Patients covered' },
  { value: 'time', label: 'Time to run' },
]
/** The `ps:` row-key prefix (DEC-8 — the row keys are 'ps:<catalogue_id>'). */
const ROW_KEY_PREFIX = 'ps:'

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
 *  the D board's own tail ("Pick as many as you like."; the formatter
 *  lives in lib/format.ts — the I page renders the same line with its own
 *  tail, one implementation). */
function checkedLine(raw: {
  inventory: { patients: number; markers: ReadonlyArray<unknown> }
  measurements?: { distinct_draw_days?: ReadonlyArray<number> } | null
}): string {
  return formatCheckedAgainstLine(raw, 'Pick as many as you like.')
}

/** Can the card be run WITHOUT a live download? An entry commits a
 *  provider state once (ready = verified on this computer); without an
 *  entry the card's own list state decides (installed / bundled / ready —
 *  a bundled or downloaded+verified asset is installed at Run time). */
function cardRunnable(
  card: PretrainedSummary,
  entry: { status: { state: string } | null; error: string | null } | undefined,
): boolean {
  const state = entry?.status?.state ?? null
  if (state !== null) return state === 'ready'
  return (
    card.state === 'installed' || card.state === 'bundled' || card.state === 'ready'
  )
}

/** The reuse-mode config: the FIRST selected card's own endpoint/horizon
 *  (the D screen has no settings controls — a model is run at the horizon
 *  it was trained for; DEC-5's endpoint rule, extended), the intake's
 *  decision day, and the engine-defaults the boards' D/I bars carry
 *  (covariates off, detect CPUs, nothing saved, label day derived). The
 *  `unknown` bridge is the generated client's plain-optional `cpus` /
 *  `label_day` (the toRunConfig class — the wire bytes are the engine's). */
function reuseConfig(
  first: PretrainedSummary,
  decisionDay: number,
  atATime: number,
): RunConfig {
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

/**
 * The one install path for a selected card (PROV-PC-7): an already
 * installed card yields its store uuid; a bundled/cached/downloaded asset
 * is installed now (`status: "installed"` → the response's `model_id`);
 * a `"installing"` response polls the download manager (PROV-PC-6) until
 * the asset is `ready`, then re-installs; a `failed` verify throws with
 * the provider's line. The download itself is never started HERE (the
 * gate lets Run through only when every selected asset is installable).
 */
async function installedModelId(card: PretrainedSummary): Promise<string> {
  if (card.state === 'installed') {
    if (card.installed_model_id === undefined) {
      throw new Error(`The model ${card.id} has no installed model record.`)
    }
    return card.installed_model_id
  }
  let install = await ApiClient.Pretrained.installModel({ id: card.id })
  while (install.status === 'installing') {
    await new Promise(resolve => setTimeout(resolve, DOWNLOAD_POLL_MS))
    const downloads = await ApiClient.Pretrained.listDownloads()
    const entry = downloads.downloads.find(d => d.id === card.id)
    if (entry?.state === 'failed') {
      throw new Error(entry.error ?? `The model ${card.id} could not be downloaded.`)
    }
    if (entry?.state !== 'ready') continue
    install = await ApiClient.Pretrained.installModel({ id: card.id })
  }
  if (install.model_id === undefined) {
    throw new Error(`The model ${card.id} could not be installed.`)
  }
  return install.model_id
}

/** One downloads-strip entry: the card's `TxrDownloadState` with its
 *  ITEM-5 controller (a hook per card — the strip's list is bounded by
 *  the live/failed downloads, never the whole catalogue). */
function StripEntry({ id }: { id: string }) {
  const { entry, retrying, retry } = useDownloadState(id)
  return <TxrDownloadState id={id} label={id} entry={entry} retrying={retrying} onRetry={retry} />
}

export function PretrainedModelsPage() {
  const navigate = useNavigate()
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)

  const selection = useStore(useTxrModelsStore, s => s.selection)
  const filters = useStore(useTxrModelsStore, s => s.filters)
  const sort = useStore(useTxrModelsStore, s => s.sort)
  const atATime = useStore(useTxrModelsStore, s => s.atATime)
  const downloadState = useStore(useTxrModelsStore, s => s.downloadState)
  const dialog = useStore(useTxrModelsStore, s => s.dialog)

  const { cards, loading: cardsLoading, error: cardsError, refetch } = usePretrained()
  const {
    response,
    loading: eligLoading,
    error: eligError,
    refetch: refetchElig,
  } = usePretrainedEligibility(validation?.inventory ?? null, useMemo(
    () => cards.map(card => card.id),
    [cards],
  ))

  // The store's inventory mirror (ONE object — the intake's, DEC-6): the
  // mount call reads the intake store's validation, and a validation
  // change applies the inventory-scoped reset.
  useEffect(() => {
    useTxrModelsStore.getState().loadInventory()
  }, [validation])

  // The one shared sort field (ITEM-3's drift #6): D adopts its board
  // initial when the current value is foreign to its options — the I page
  // does the same for its own board (the shared value survives a screen
  // change only when it is a real option of both).
  useEffect(() => {
    const store = useTxrModelsStore.getState()
    if (!D_SORT_OPTIONS.some(option => option.value === store.sort)) {
      store.setSort('transfer')
    }
  }, [])

  // ── The row/composition layer (the ITEM-4 pure builders) ────────────────
  const cardById = useMemo(() => new Map(cards.map(card => [card.id, card])), [cards])

  /** The D verdicts by ROW key (the 'ps:' key surface DEC-8 declared). */
  const verdictByKey = useMemo(() => {
    const m = new Map<string, PretrainedEligibilityEntry | null>()
    for (const card of cards) {
      const verdict = response?.models.find(entry => entry.id === card.id) ?? null
      m.set(`${ROW_KEY_PREFIX}${card.id}`, verdict)
    }
    return m
  }, [cards, response])

  const rows = useMemo(() => buildPretrainedRows(cards, response), [cards, response])

  /** The sort facts (the comparators' input — the same structured facts
   *  the builders read; a null fact sorts last, DEC-9). */
  const sortable = useMemo(() => {
    const m = new Map<string, TxrModelSortable>()
    for (const card of cards) {
      const key = `${ROW_KEY_PREFIX}${card.id}`
      const verdict = verdictByKey.get(key) ?? null
      m.set(key, {
        transferCohorts: card.transfer?.n_cohorts ?? null,
        transferMedian: card.transfer?.median ?? null,
        coverage: verdict?.coverage?.fraction ?? null,
        estimateSeconds: verdict?.estimated_seconds ?? null,
        madeAt: null,
        id: card.id,
      })
    }
    return m
  }, [cards, verdictByKey])

  /** The active chip predicate over the SOURCE cards, applied by row key. */
  const keep = useMemo(() => {
    const predicate = pretrainedChipPredicate(filters)
    return (key: string): boolean => {
      const card = cardById.get(key.slice(ROW_KEY_PREFIX.length))
      return card !== undefined && predicate(card)
    }
  }, [filters, cardById])

  const shown = useMemo(
    () => filterRows(rows, { keep, sort, sortable }),
    [rows, keep, sort, sortable],
  )

  /** The four chips: the counts over the whole catalogue (a chip's
   *  count answers its own question, never the current view). */
  const chips = useMemo(
    () =>
      D_CHIPS.map(chip => ({
        id: chip.id,
        label: chip.label,
        count:
          chip.id === 'published'
            ? cards.filter(card => card.kind === 'published-rule').length
            : chip.id === 'learned'
              ? cards.filter(card => card.kind === 'benchmark-trained').length
              : cards.filter(
                  card =>
                    card.transfer !== null &&
                    card.transfer !== undefined &&
                    card.transfer.n_cohorts >= 2,
                ).length,
        active: filters.includes(chip.id),
        onToggle: () => useTxrModelsStore.getState().setFilter(chip.id),
      })),
    [cards, filters],
  )

  const totals = response

  /** The downloads strip's entries: each card with a live/failed download
   *  (a `ready` entry leaves the strip — the asset is verified, the Run is
   *  the next step). */
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

  /** The selection write: the shared list's controlled next-set, plus the
   *  D auto-download — a card whose asset is not on this computer starts
   *  its download when CHECKED (models.md: "larger ones are downloaded
   *  when selected"); a live/failed/verified download is never restarted
   *  (the store's idempotent start + the entry states are the guards). */
  const onSelectionChange = useCallback(
    (next: ReadonlySet<string>): void => {
      const store = useTxrModelsStore.getState()
      for (const key of next) {
        if (selection.has(key)) continue
        const card = cardById.get(key.slice(ROW_KEY_PREFIX.length))
        if (card === undefined) continue
        if (cardRunnable(card, store.downloadState[card.id])) continue
        const entry = store.downloadState[card.id]
        if (entry?.status?.state === 'failed') continue // the human's Retry owns it
        void store.requestDownload(card.id)
      }
      store.setSelection(next)
    },
    [selection, cardById],
  )

  const [runError, setRunError] = useState<string | null>(null)
  const creating = useRef(false)

  /**
   * The D Run path (CONS-UM-21/24/13): gate → install-if-needed →
   * resolve → create → navigate. One create is ever in flight; a gated
   * attempt (a downloading/failed selected card) writes the inline line
   * and NEVER creates the run; a resolve failure (404 / 409) surfaces the
   * response's line inline with no run created.
   */
  const createRun = useCallback(
    async (keys: string[]): Promise<void> => {
      if (keys.length === 0) {
        // The empty selection is a user error before the wire: never a run
        // with no models (the engine's 400 is the same rule, stated here).
        setRunError('Select at least one model to run.')
        return
      }
      const blocked = keys
        .map(key => cardById.get(key.slice(ROW_KEY_PREFIX.length)))
        .filter((card): card is PretrainedSummary => card !== undefined)
        .filter(card => !cardRunnable(card, useTxrModelsStore.getState().downloadState[card.id]))
      if (blocked.length > 0) {
        setRunError(
          blocked.some(card => {
            const state = useTxrModelsStore.getState().downloadState[card.id]?.status?.state
            return state === 'failed'
          })
            ? GATE_FAILED_LINE
            : GATE_DOWNLOADING_LINE,
        )
        return
      }
      if (creating.current) return
      creating.current = true
      setRunError(null)
      try {
        // install-if-needed: the installed ids for every selected card
        // (the run keys are the selection minus the disabled rows — the
        // same set the engine will see, never a stale key)
        const runCards = cards.filter(card => keys.includes(`${ROW_KEY_PREFIX}${card.id}`))
        const installed: string[] = []
        for (const card of runCards) {
          installed.push(await installedModelId(card))
        }
        // resolve FIRST (CONS-UM-24 — never bare uuids in the create
        // call; the response's assets pass through VERBATIM)
        const { assets } = await ApiClient.Models.resolveModels({ model_ids: installed })
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
            runCards[0] ?? cardsWithId0(cards),
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
    [cards, patients, measurements, predictMeasurements, joins, mapping, parameters, atATime, navigate],
  )

  return (
    <main data-testid="txr-models-d" style={PAGE_OUTER}>
      <div style={PAGE_MAIN}>
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
                counters stay hidden too (nothing has been checked). */}
            {validation !== null ? <div style={STEP_LINE}>Step 4 of 4</div> : null}
            <h1 style={TITLE}>Choose the models to run</h1>
            {validation !== null ? (
              <p data-testid="txr-models-d-checked" style={CHECK_LINE}>
                {checkedLine(validation)}
              </p>
            ) : null}
          </div>
          {validation !== null && cards.length > 0 ? (
            <span data-testid="txr-models-d-totals" style={TOTALS}>
              {totals === null || (cardsLoading && cards.length === 0)
                ? '\u2026'
                : `${totals.total_fit + totals.total_some} can run, ${totals.total_cannot} cannot`}
            </span>
          ) : null}
        </div>
        {validation !== null ? (
          cards.length === 0 && !cardsLoading && cardsError === null ? (
            <div
              data-testid="txr-models-d-no-catalogue"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                alignItems: 'flex-start',
                padding: '24px 0',
              }}
            >
              <p style={{ margin: 0, fontSize: 15.5, color: 'var(--txr-text-2)', fontWeight: 600 }}>
                No published models are available yet.
              </p>
              <p style={CHECK_LINE}>
                The benchmark&rsquo;s published models arrive with its releases and appear here.
                Until then, models you trained yourself are in Your models &mdash; from your own
                analyses, or opened from another computer.
              </p>
              <Button
                data-testid="txr-models-d-no-catalogue-cta"
                variant="outline"
                onClick={() => navigate(modelsPath())}
              >
                Go to Your models
              </Button>
            </div>
          ) : (
            <div style={LIST_FRAME}>
              <TxrSelectList
                rows={shown}
                itemLabel="model"
                selected={selection}
                onSelectionChange={onSelectionChange}
                filterChips={chips}
                sort={{
                  value: sort,
                  options: D_SORT_OPTIONS as { value: string; label: string }[],
                  onChange: value => useTxrModelsStore.getState().setSort(value as TxrModelSortId),
                }}
                loading={cardsLoading || eligLoading}
                error={cardsError ?? eligError}
                onRetry={() => {
                  refetch()
                  refetchElig()
                }}
                bottomBar={{
                  selectedCount: countSelected(selection, rows),
                  totalTimeText: formatTotalTime(
                    totalSecondsForSelection(selection, verdictByKey),
                  ),
                  notice: RESEARCH_NOTICE,
                  onRun: keys => {
                    void createRun(keys)
                  },
                }}
                onRowAction={row => {
                  useTxrModelsStore.getState().openDialog(`card:${row.key.slice(ROW_KEY_PREFIX.length)}` as TxrModelDialogId)
                }}
              />
            </div>
          )
        ) : (
          <div
            data-testid="txr-models-d-empty"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              alignItems: 'flex-start',
              padding: '24px 0',
            }}
          >
            <p style={CHECK_LINE}>{EMPTY_LINE}</p>
            <Button
              data-testid="txr-models-d-empty-cta"
              variant="outline"
              onClick={() => navigate(predictFilesPath())}
            >
              {EMPTY_CTA}
            </Button>
          </div>
        )}
        {stripIds.length > 0 ? (
          <div data-testid="txr-models-downloads" style={DOWNLOAD_STRIP}>
            <span style={STRIP_CAPTION}>Downloads</span>
            {stripIds.map(id => (
              <StripEntry key={id} id={id} />
            ))}
          </div>
        ) : null}
        {runError !== null ? (
          <Alert tone="error" data-testid="txr-models-d-run-error" title={runError} />
        ) : null}
        <p style={FOOTNOTE}>
          Models that cannot run say what is missing from your file. Add the missing
          markers and they become available.
        </p>
      </div>
      <TxrModelCardDialog
        cardId={dialog.startsWith('card:') ? dialog.slice(5) : null}
        onClose={() => useTxrModelsStore.getState().closeDialog()}
      />
    </main>
  )
}

/**
 * The create path's config source can never be a fabricated record: the
 * empty-selection guard above refuses the run before this call, so the
 * first selected card exists — this fallback is the type-defensive arm
 * (the first card of the catalogue, when the compile-time narrowing cannot
 * see the guard's effect). A catalogue with no cards at all is the
 * no-models state, never a created run.
 */
function cardsWithId0(cards: PretrainedSummary[]): PretrainedSummary {
  const first = cards[0]
  if (first !== undefined) return first
  throw new Error('No pretrained models are available to run.')
}
