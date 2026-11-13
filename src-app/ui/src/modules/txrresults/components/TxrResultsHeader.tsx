/**
 * TxrResultsHeader — the G/H header of one analysis run's results
 * (`BusyResults.dc.html` / `Results.dc.html`): the "Predictions for N
 * patients" title and the board subtitle (counts · learned from · decision day ·
 * took), plus the New analysis button. The header keeps the SUMMARY role
 * (app-shell ITEM-3, the audit route table's fixed top: "summary, tabs,
 * search"); the data actions — Download and Save the models — moved to the
 * page's FIXED BOTTOM BAR (`TxrResultsBar`, where the audit's route table
 * pins "Showing n of N" + download + save models; the buttons keep their
 * test-ids and behaviour, the events still fire from the click).
 *
 * The header is PRESENTATIONAL: the page feeds the run detail + the
 * predictions response + the predictions error state; the header derives the
 * subtitle's facts (the save-models payload is the bar's, both over the same
 * `finishedMethodIdsOf`).
 *
 * Copy facts (board-verbatim, PROV-UR-5):
 * - the title counts `predictions.patients.length` ("Predictions for 38
 *   patients" — the board's plural; a one-patient run reads the singular);
 * - the subtitle is `formatSubtitle`'s board sentence, each segment omitted
 *   when its datum is null (a run with no elapsed time yet shows no "took …");
 *   "took" derives from `elapsed_secs` first, else the started→finished wall
 *   time (the detail's snapshot — never a ticking clock, ITEM-5 note (t)).
 */
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@txresbench/kit'
import type { TxrPredictionsResponse, TxrRunDetail } from '@/api-client/types'
import { runStatusWord, truthBucketOf } from '@/modules/txrshell/lib/runStatus'
import { emitSaveModels, emitSaveOneModel } from '../events'
import { formatSubtitle } from '../lib/format'
import type { TxrSubtitleFacts } from '../lib/format'

const HEADER: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 12,
  flexWrap: 'wrap',
}

const TITLE: CSSProperties = {
  margin: '0 0 2px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 26,
  lineHeight: 1.2,
}

const SUBTITLE: CSSProperties = { color: 'var(--txr-text-2)', fontSize: 14 }

const ACTIONS: CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' }

const PRIMARY_BUTTON: CSSProperties = { padding: '9px 16px', fontWeight: 700 }

/** The title: board-plural, with the 1-patient singular (formatCounts' rule). */
export function formatPredictionsTitle(patientCount: number): string {
  return `Predictions for ${patientCount} ${patientCount === 1 ? 'patient' : 'patients'}`
}

/**
 * The subtitle's "took" seconds (TEST-UR-4: from `elapsed_secs`/`started_at`):
 * the detail's `elapsed_secs` snapshot when present, else the
 * started_at → finished_at wall time (a finished run that never wrote an
 * elapsed count); null while the run has neither (the segment is omitted).
 * Never `Date.now()` — the elapsed reading is the detail's, not a ticker.
 */
export function tookSecondsOf(run: TxrRunDetail): number | null {
  if (run.elapsed_secs != null && Number.isFinite(run.elapsed_secs)) return run.elapsed_secs
  const start = run.started_at ? Date.parse(run.started_at) : Number.NaN
  const end = run.finished_at ? Date.parse(run.finished_at) : Number.NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return Math.round((end - start) / 1000)
  }
  return null
}

/** The subtitle facts the header formats (every datum nullable at the wire).
 *  A terminal run's `status` is the SAME vocabulary as the K status chip
 *  (ITEM-2 (a) — the plan's "same vocabulary on the results page header"),
 *  computed here from the engine's own counts through the shared builder. */
export function subtitleFactsOf(run: TxrRunDetail | null): TxrSubtitleFacts {
  if (run === null) return { finished: null, total: null, trainedOn: null, decisionDay: null, tookSeconds: null }
  const bucket = truthBucketOf(run.status, run.counts)
  return {
    status: bucket === null ? null : runStatusWord(bucket, run.counts, run.methods.length),
    finished: run.counts?.finished ?? null,
    total: run.methods.length,
    trainedOn: run.input_summary?.patients ?? null,
    decisionDay: run.config?.decision_day ?? null,
    tookSeconds: tookSecondsOf(run),
  }
}

/** The finished method ids — the save-models payload (DEC-8: finished only). */
export function finishedMethodIdsOf(run: TxrRunDetail): string[] {
  return run.methods.filter(m => m.state === 'finished').map(m => m.method_id)
}

export interface TxrDownloadButtonProps {
  /** The board's primary action label ("Download all predictions (CSV)"). */
  label: string
  /** Exactly `predictionsError === 'unavailable'` (the empty-heatmap state). */
  disabled: boolean
  /** The page's download wiring (ITEM-10's `downloadPredictionsCsv`). */
  onClick: () => void
}

export function TxrDownloadButton({ label, disabled, onClick }: TxrDownloadButtonProps) {
  return (
    <Button
      data-testid="txr-results-download"
      variant="default"
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg"
      style={PRIMARY_BUTTON}
    >
      {label}
    </Button>
  )
}

export interface TxrSaveModelsButtonProps {
  /** `run.models.length` — the board's "(N)". */
  count: number
  onClick: () => void
}

export function TxrSaveModelsButton({ count, onClick }: TxrSaveModelsButtonProps) {
  return (
    <Button
      data-testid="txr-results-save-models"
      variant="outline"
      onClick={onClick}
      className="rounded-lg font-bold"
      style={PRIMARY_BUTTON}
    >
      {`Save the models (${count})`}
    </Button>
  )
}

export interface TxrSaveOneModelButtonProps {
  /** The click — the header emits `txr:save-one-model-requested` (L2's entry point). */
  onClick: () => void
}

export function TxrSaveOneModelButton({ onClick }: TxrSaveOneModelButtonProps) {
  return (
    <Button
      data-testid="txr-results-save-one-model"
      variant="outline"
      onClick={onClick}
      className="rounded-lg font-bold"
      style={PRIMARY_BUTTON}
    >
      Save this model
    </Button>
  )
}

export interface TxrResultsHeaderProps {
  run: TxrRunDetail | null
  predictions: TxrPredictionsResponse | null
  /** `'unavailable'` (409) alone disables the download (TEST-UR-4). */
  predictionsError: 'unavailable' | 'network' | null
  /**
   * The subtitle facts, when the page overrides them (qa-fixes RES-02):
   * a terminal failed/stopped run with no predictions omits the
   * "learned from" and "took" segments — nothing was learned and the
   * elapsed reads like a completed-run fact next to a failed one;
   * the counts ("0 of 6 methods finished") and the decision day stay,
   * they are the run's own recorded facts.
   */
  subtitleFacts?: TxrSubtitleFacts
}

export function TxrResultsHeader({
  run,
  predictions,
  predictionsError,
  subtitleFacts,
}: TxrResultsHeaderProps) {
  const navigate = useNavigate()
  const patientCount = predictions?.patients.length ?? 0
  const subtitle = run ? formatSubtitle(subtitleFacts ?? subtitleFactsOf(run)) : ''
  return (
    <header data-testid="txr-results-header" style={HEADER}>
      <div>
        <h1 style={TITLE}>
          {predictions ? formatPredictionsTitle(patientCount) : 'Predictions'}
        </h1>
        {subtitle.length > 0 ? (
          <div data-testid="txr-results-subtitle" style={SUBTITLE}>
            {subtitle}
          </div>
        ) : null}
      </div>
      <Button
        data-testid="txr-results-new-analysis"
        variant="outline"
        onClick={() => navigate('/')}
        className="rounded-lg font-semibold"
        style={PRIMARY_BUTTON}
      >
        New analysis
      </Button>
    </header>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixed bottom bar (app-shell ITEM-3, the audit route table's
// `/analysis/:id/results` row): "Showing n of N" + the row-window "Show all
// M" on the left, the data actions (Download, Save the models / Save this
// model) on the right. The count and the window control live on the PAGE's
// view (the same facts the table's footer used to carry — the sentence
// stayed board-verbatim, now pinned next to the actions so it never scrolls
// away); the actions are the exported buttons with the SAME test-ids and
// event emissions the header used to wire.
// ─────────────────────────────────────────────────────────────────────────────

const BAR_LEFT: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
  color: 'var(--txr-muted)',
}

const BAR_RIGHT: CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' }

export interface TxrResultsBarProps {
  /** The view's windowed row count ("Showing N of…"). */
  shownCount: number
  /** The view's full row count (…of M patients"; 0 = the no-match state). */
  totalCount: number
  /** "Show all M" (null while all rows are shown). */
  onShowAll: (() => void) | null
  /** The download wiring (the page's `downloadPredictionsCsv` + failure line). */
  download: { label: string; disabled: boolean; onClick: () => void }
  /** The run-level models count, or the H one-method id (Save this model). */
  save: { mode: 'run'; count: number } | { mode: 'one'; methodId: string } | null
  /** The run detail — the events' payload source (null → no save button). */
  run: TxrRunDetail | null
}

export function TxrResultsBar({
  shownCount,
  totalCount,
  onShowAll,
  download,
  save,
  run,
}: TxrResultsBarProps) {
  const onSaveModels = () => {
    if (run) void emitSaveModels(run.id, finishedMethodIdsOf(run))
  }
  const onSaveOne = () => {
    if (run && save !== null && save.mode === 'one') {
      void emitSaveOneModel(run.id, save.methodId)
    }
  }
  return (
    <div
      className="txr-results-bar"
      data-testid="txr-results-bar"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}
    >
      <span style={BAR_LEFT}>
        <span data-testid="txr-heatmap-count">
          {totalCount > 0 ? `Showing ${shownCount} of ${totalCount} patients.` : ''}
        </span>
        {onShowAll !== null ? (
          <Button
            data-testid="txr-heatmap-show-more"
            variant="link"
            className="p-0"
            onClick={onShowAll}
          >
            {`Show all ${totalCount}`}
          </Button>
        ) : null}
      </span>
      <span style={BAR_RIGHT}>
        <TxrDownloadButton label={download.label} disabled={download.disabled} onClick={download.onClick} />
        {save === null ? null : save.mode === 'one' ? (
          <TxrSaveOneModelButton onClick={onSaveOne} />
        ) : save.count > 0 ? (
          <TxrSaveModelsButton count={save.count} onClick={onSaveModels} />
        ) : null}
      </span>
    </div>
  )
}
