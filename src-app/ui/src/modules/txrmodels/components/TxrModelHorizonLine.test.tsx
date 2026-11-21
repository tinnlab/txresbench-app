// @vitest-environment jsdom
/**
 * The look-ahead line of the ready-made and saved model steps: the look-ahead
 * is shown, locked to the first chosen model's own day.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  modelDecisionDayText,
  modelHorizonText,
  TxrModelHorizonLine,
} from './TxrModelHorizonLine'

describe('TxrModelHorizonLine', () => {
  it('shows the first chosen model\'s look-ahead, with its months, and says it cannot be changed', () => {
    expect(modelHorizonText([240])).toBe(
      "Look ahead to: day 240 (240 days ≈ 7.9 months), the model's own. It cannot be changed.",
    )
  })

  it('says so when the chosen models look ahead to different days', () => {
    expect(modelHorizonText([240, 165])).toBe(
      "Look ahead to: day 240 (240 days ≈ 7.9 months), the model's own. It cannot be changed. The models you chose look ahead to different days; the run uses the first one's.",
    )
  })

  it('names the rule before a model is chosen', () => {
    expect(modelHorizonText([])).toBe('Look ahead to: the day the model you choose was trained for.')
  })

  it('shows the chosen model\'s own decision day on a second line', () => {
    expect(modelDecisionDayText([28])).toBe(
      "Decision day: day 28, the model's own. It cannot be changed.",
    )
  })

  it('names the decision-day rule before a model is chosen', () => {
    expect(modelDecisionDayText([])).toBe(
      'Decision day: the day the model you choose was trained at.',
    )
  })

  it('renders the two lines, with no field to type in', () => {
    render(<TxrModelHorizonLine testId="horizon" horizons={[240]} decisionDays={[60]} />)
    const line = screen.getByTestId('horizon')
    expect(line.textContent).toContain('day 240')
    expect(line.textContent).toContain('Decision day: day 60')
    expect(line.querySelector('input')).toBeNull()
  })
})
