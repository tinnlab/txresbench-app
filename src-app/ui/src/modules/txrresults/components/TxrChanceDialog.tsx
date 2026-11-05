/**
 * TxrChanceDialog — the H screen's "How the chance is calculated" explainer
 * (`Results.dc.html`'s aside link opens it; the dialog itself is not on any
 * board — the copy is this node's, derived from the run's endpoint/horizon
 * and the finished methods' `prob_source` mix, and recorded as a design-gap
 * copy: one-line changeable in `chanceExplanationOf`).
 *
 * The component is presentational: the page passes the open state (the
 * store's `chanceDialogOpen`), the close handler, the run's outcome day
 * facts and the prob-source counts (`buildColumns` already mapped
 * `prob_source: 'none'` → null, so the nulls are simply not counted).
 */
import type { CSSProperties } from 'react'
import { Dialog } from '@ziee/kit'
import type { TxrOutcomeKey } from '../types'

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
 * - the calibration sentence counts `recalibrated` vs the rest: none → the
 *   "as trained" sentence; some → the honest "N of M were recalibrated on
 *   your patients" (a `'none'` prob_source — mapped to null by
 *   `buildColumns` — is a column with no provenance and is not counted as
 *   recalibrated, so its count is simply absent from the sentence's M).
 */
export function chanceExplanationOf(
  endpoint: TxrOutcomeKey,
  horizon: number,
  sources: ReadonlyArray<'native' | 'recalibrated' | null>,
): TxrChanceSummary {
  const recalibrated = sources.filter(s => s === 'recalibrated').length
  const lead = `Each method's chance of ${CHANCE_OUTCOME_PHRASE[endpoint]} by day ${horizon} is its own estimate for that patient, made from the markers in their measurements.`
  const calibration =
    recalibrated === 0
      ? `None of these chances were recalibrated on your data: they are the methods' estimates as trained.`
      : `${recalibrated} of the ${sources.length} methods were recalibrated on your patients before making these chances.`
  return { lead, calibration }
}

const PARAGRAPHS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 14,
  color: '#3a3a3a',
}

export interface TxrChanceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The run's primary outcome (the explainer's phrase). */
  endpoint: TxrOutcomeKey
  /** The day the run reports (`look_ahead_day` / `label_day` resolved by the page). */
  horizon: number
  /** The finished columns' prob-source mix (`'recalibrated'` count is the fact). */
  probSources: ReadonlyArray<'native' | 'recalibrated' | null>
}

export function TxrChanceDialog({
  open,
  onOpenChange,
  endpoint,
  horizon,
  probSources,
}: TxrChanceDialogProps) {
  const summary = chanceExplanationOf(endpoint, horizon, probSources)
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
