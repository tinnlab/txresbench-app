import type { CSSProperties } from 'react'
import { monthsText } from '@/modules/txrintake/lib/dayChoices'

/**
 * The look-ahead day and the decision day of a run with ready-made or saved
 * models: shown, never set. A model predicts for the day it was trained for
 * — the run uses the look-ahead AND the decision day of the first chosen
 * model (the order the run takes them in), never the intake's day
 * (data-pickup-bugs bug 3).
 */
export interface TxrModelHorizonLineProps {
  /** The look-ahead days of the chosen models, in the run's order. */
  horizons: readonly number[]
  /** The decision days of the chosen models, in the run's order (the model
   *  summary row's own; a model runs at the day it was trained at). */
  decisionDays: readonly number[]
  testId: string
}

const LINE: CSSProperties = { margin: '4px 0 0', fontSize: 13, color: 'var(--txr-text-2)' }

/** The look-ahead line's words (unit-tested). */
export function modelHorizonText(horizons: readonly number[]): string {
  const first = horizons[0]
  if (first === undefined) {
    return 'Look ahead to: the day the model you choose was trained for.'
  }
  const own = `Look ahead to: day ${first} (${monthsText(first)}), the model's own. It cannot be changed.`
  return horizons.every(day => day === first)
    ? own
    : `${own} The models you chose look ahead to different days; the run uses the first one's.`
}

/** The decision-day line's words (unit-tested). */
export function modelDecisionDayText(days: readonly number[]): string {
  const first = days[0]
  if (first === undefined) {
    return 'Decision day: the day the model you choose was trained at.'
  }
  return `Decision day: day ${first}, the model's own. It cannot be changed.`
}

export function TxrModelHorizonLine({ horizons, decisionDays, testId }: TxrModelHorizonLineProps) {
  return (
    <div data-testid={testId}>
      <p style={LINE}>{modelHorizonText(horizons)}</p>
      <p style={LINE}>{modelDecisionDayText(decisionDays)}</p>
    </div>
  )
}
