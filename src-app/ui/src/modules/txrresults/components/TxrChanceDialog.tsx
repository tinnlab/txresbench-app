/**
 * TxrChanceDialog — the H screen's "How the chance is calculated" explainer
 * (`Results.dc.html`'s aside link opens it; the dialog itself is not on any
 * board — the copy is this node's, derived from the run's endpoint/horizon
 * and the finished methods' `prob_source` mix, and recorded as a design-gap
 * copy: one-line changeable in `chanceExplanationOf`).
 *
 * The component is presentational: the page passes the open state (the
 * store's `chanceDialogOpen`), the close handler, the run's outcome day
 * facts and the columns' prob-source facts (`buildColumns` already mapped
 * `prob_source: 'none'` → null, so the nulls are simply not counted).
 */
import type { CSSProperties } from 'react'
import { Dialog } from '@txresbench/kit'
import type { TxrHeatmapColumn, TxrOutcomeKey } from '../types'

/** The dialog's title (`Results.dc.html`'s aside link text). */
export const CHANCE_DIALOG_TITLE = 'How the chance is calculated'

/** The outcome phrase of the explainer's lead sentence (the boards' tab vocabulary). */
export const CHANCE_OUTCOME_PHRASE: Record<TxrOutcomeKey, string> = {
  pfs: 'progression or death',
  os: 'death',
  response: 'no response',
}

export interface TxrChanceSummary {
  /** The lead sentence: what the shown chance is, in the run's outcome words. */
  lead: string
  /** The calibration sentence: the finishing methods' prob-source mix. */
  calibration: string
}

/**
 * The dialog's two sentences, derived from the run's facts:
 *
 * - the lead spells the outcome phrase + the day (a closed mapping over
 *   `TxrOutcomeKey`; the response day is the caller's label-day resolution,
 *   the same rule the outcome tabs use);
 * - the calibration sentence counts the provenance mix: no `recalibrated`
 *   and no `converted` column → the "as trained" sentence; otherwise the
 *   honest "N of M were recalibrated on your patients" and/or "N of M turn
 *   their score into a chance with the conversion learned when the model was
 *   trained" (a saved model's training conversion), plus the flat-result
 *   sentence for the columns whose conversion is the event-rate map (a
 *   `'none'` prob_source — mapped to null by `buildColumns` — is a column
 *   with no provenance and is counted in neither).
 */
export function chanceExplanationOf(
  endpoint: TxrOutcomeKey,
  horizon: number,
  columns: ReadonlyArray<Pick<TxrHeatmapColumn, 'probSource' | 'flatConversion'>>,
): TxrChanceSummary {
  const total = columns.length
  const recalibrated = columns.filter(c => c.probSource === 'recalibrated').length
  const converted = columns.filter(c => c.probSource === 'converted').length
  const flat = columns.filter(
    c => c.flatConversion && (c.probSource === 'recalibrated' || c.probSource === 'converted'),
  ).length
  const lead = `Each method's chance of ${CHANCE_OUTCOME_PHRASE[endpoint]} by day ${horizon} is its own estimate for that patient, made from the markers in their measurements.`
  if (recalibrated === 0 && converted === 0) {
    return {
      lead,
      calibration: `None of these chances were recalibrated on your data: they are the methods' estimates as trained.`,
    }
  }
  const parts: string[] = []
  if (recalibrated > 0) {
    parts.push(
      `${recalibrated} of the ${total} methods were recalibrated on your patients before making these chances.`,
    )
  }
  if (converted > 0) {
    parts.push(
      `${converted} of the ${total} methods turn their score into a chance with the conversion learned when the model was trained.`,
    )
  }
  if (flat > 0) {
    parts.push(
      `For ${flat} of the ${total} methods the score did not track the outcome in the training data, so every patient gets the same chance: the event rate.`,
    )
  }
  return { lead, calibration: parts.join(' ') }
}

const PARAGRAPHS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 14,
  color: 'var(--txr-text-2)',
}

export interface TxrChanceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The run's primary outcome (the explainer's phrase). */
  endpoint: TxrOutcomeKey
  /** The day the run reports (`look_ahead_day` / `label_day` resolved by the page). */
  horizon: number
  /** The explained columns' prob-source facts (provenance + the flat-result flag). */
  columns: ReadonlyArray<Pick<TxrHeatmapColumn, 'probSource' | 'flatConversion'>>
}

export function TxrChanceDialog({
  open,
  onOpenChange,
  endpoint,
  horizon,
  columns,
}: TxrChanceDialogProps) {
  const summary = chanceExplanationOf(endpoint, horizon, columns)
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={CHANCE_DIALOG_TITLE}
      data-testid="txr-chance-dialog"
      size="sm"
    >
      <div style={PARAGRAPHS}>
        <p style={{ margin: 0 }}>{summary.lead}</p>
        <p style={{ margin: 0 }}>{summary.calibration}</p>
      </div>
    </Dialog>
  )
}
