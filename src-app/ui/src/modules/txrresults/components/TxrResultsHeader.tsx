/**
 * TxrResultsHeader — the G/H header of one analysis run's results
 * (`BusyResults.dc.html` / `Results.dc.html`): the "Predictions for N
 * patients" title, the board subtitle (counts · learned from · decision day ·
 * took) and the three actions (Download all predictions (CSV) — disabled
 * exactly while PREDICTIONS_UNAVAILABLE — Save the models (N), New analysis).
 *
 * The header is PRESENTATIONAL: the page feeds the run detail + the
 * predictions response + the predictions error state; the header derives the
 * subtitle's facts and the save-models payload, and reports the two actions it
 * does not own (the download click — ITEM-10's `downloadPredictionsCsv` is the
 * page's wiring — and New analysis via the router).
 *
 * Copy facts (board-verbatim, PROV-UR-5):
 * - the title counts `predictions.patients.length` ("Predictions for 38
 *   patients" — the board's plural; a one-patient run reads the singular);
 * - the subtitle is `formatSubtitle`'s board sentence, each segment omitted
 *   when its datum is null (a run with no elapsed time yet shows no "took …");
 *   "took" derives from `elapsed_secs` first, else the started→finished wall
 *   time (the detail's snapshot — never a ticking clock, ITEM-5 note (t));
 * - the actions row's keyboard order is the board's left-to-right: download →
 *   save-models → new analysis;
 * - the Save-the-models button renders ONLY when the run produced models
 *   (`run.models.length > 0` — a `save_models: false` run has none, DEC-8)
 *   and emits `txr:save-models-requested` with the run id + the FINISHED
 *   method ids (the payload ui-models' dialogs bind).
 */
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@ziee/kit'
import type { TxrPredictionsResponse, TxrRunDetail } from '@/api-client/types'
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

const SUBTITLE: CSSProperties = { color: '#3a3a3a', fontSize: 14 }

const ACTIONS: CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' }

const PRIMARY_BUTTON: CSSProperties = { padding: '9px 16px', fontWeight: 700 }

/** The title: board-plural, with the 1-patient singular (formatCounts' rule). */
function formatPredictionsTitle(patientCount: number): string {
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

/** The subtitle facts the header formats (every datum nullable at the wire). */
export function subtitleFactsOf(run: TxrRunDetail | null): TxrSubtitleFacts {
  if (run === null) return { finished: null, total: null, trainedOn: null, decisionDay: null, tookSeconds: null }
  return {
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
  /** The download click — the page wires `downloadPredictionsCsv` (ITEM-10). */
  onDownload?: () => void
  /** The H board's label differs by one word ("Download predictions (CSV)"). */
  downloadLabel?: string
  /**
   * The subtitle facts, when the page overrides them (qa-fixes RES-02):
   * a terminal failed/stopped run with no predictions omits the
   * "learned from" and "took" segments — nothing was learned and the
   * elapsed reads like a completed-run fact next to a failed one;
   * the counts ("0 of 6 methods finished") and the decision day stay,
   * they are the run's own recorded facts.
   */
  subtitleFacts?: TxrSubtitleFacts
  /**
   * The H one-method view (`SaveOne.dc.html`): the method id whose
   * "Save this model" button REPLACES the run's "Save the models (N)" one
   * (the L2 dialog's entry point is this button). The page passes it only
   * when the method finished with a produced model — TEST-UR-10's gate; a
   * click emits `txr:save-one-model-requested` the same way the run-level
   * button emits the models event (DEC-8).
   */
  saveOne?: string | null
}

export function TxrResultsHeader({
  run,
  predictions,
  predictionsError,
  onDownload,
  downloadLabel = 'Download all predictions (CSV)',
  subtitleFacts,
  saveOne,
}: TxrResultsHeaderProps) {
  const navigate = useNavigate()
  const patientCount = predictions?.patients.length ?? 0
  const subtitle = run ? formatSubtitle(subtitleFacts ?? subtitleFactsOf(run)) : ''
  const modelCount = run?.models.length ?? 0
  const onSaveModels = () => {
    if (run) void emitSaveModels(run.id, finishedMethodIdsOf(run))
  }
  const onSaveOne = () => {
    if (run && saveOne) void emitSaveOneModel(run.id, saveOne)
  }
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
      <div style={ACTIONS}>
        <TxrDownloadButton
          label={downloadLabel}
          disabled={predictionsError === 'unavailable'}
          onClick={() => onDownload?.()}
        />
        {saveOne ? (
          <TxrSaveOneModelButton onClick={onSaveOne} />
        ) : modelCount > 0 ? (
          <TxrSaveModelsButton count={modelCount} onClick={onSaveModels} />
        ) : null}
        <Button
          data-testid="txr-results-new-analysis"
          variant="outline"
          onClick={() => navigate('/')}
          className="rounded-lg font-semibold"
          style={PRIMARY_BUTTON}
        >
          New analysis
        </Button>
      </div>
    </header>
  )
}
