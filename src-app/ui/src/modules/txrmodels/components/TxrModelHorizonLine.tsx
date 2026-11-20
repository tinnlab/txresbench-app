import type { CSSProperties } from 'react'
import { monthsText } from '@/modules/txrintake/lib/dayChoices'

/**
 * The look-ahead day of a run with ready-made or saved models: shown, never
 * set. A model predicts for the day it was trained for, and the run uses the
 * look-ahead of the first chosen model (the order the run takes them in).
 */
export interface TxrModelHorizonLineProps {
  /** The look-ahead days of the chosen models, in the run's order. */
  horizons: readonly number[]
  testId: string
}

const LINE: CSSProperties = { margin: '4px 0 0', fontSize: 13, color: 'var(--txr-text-2)' }

/** The line's words (unit-tested). */
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

export function TxrModelHorizonLine({ horizons, testId }: TxrModelHorizonLineProps) {
  return (
    <p data-testid={testId} style={LINE}>
      {modelHorizonText(horizons)}
    </p>
  )
}
