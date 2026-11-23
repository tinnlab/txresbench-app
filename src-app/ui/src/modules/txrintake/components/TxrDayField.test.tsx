// @vitest-environment jsdom
/**
 * study-step-ui-tweaks — `components/TxrDayField.tsx`: the day box is VIEW
 * state. After the suggestion chips one "Other values" chip shows and hides
 * it; selecting the chip never calls `onChoose` and stores nothing; a
 * suggestion click still calls `onChoose` (and hides the box); a stored day
 * outside the suggestions arrives with the box open and "Other values"
 * pressed. With no suggestions the box shows directly (no chip), and locked
 * is unchanged (no chips, read-only).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TxrDayField } from './TxrDayField'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SUGGESTIONS = [21, 33, 42, 56]
const noProblem = (): string | null => null

function renderField(props: Partial<React.ComponentProps<typeof TxrDayField>> = {}) {
  const onChoose = props.onChoose ?? vi.fn()
  const result = render(
    <TxrDayField
      testId="day"
      label="Last draw you will use"
      value={null}
      suggestions={SUGGESTIONS}
      onChoose={onChoose}
      check={noProblem}
      {...props}
    />,
  )
  return { onChoose, ...result }
}

describe('TxrDayField (study-step-ui-tweaks — the "Other values" box)', () => {
  it('no box until "Other values" is clicked; clicking it opens the box and moves focus into it', () => {
    const { onChoose } = renderField()
    const field = screen.getByTestId('day')
    // The chip is there, the box is not.
    const other = screen.getByTestId('day-other')
    expect(other.textContent).toBe('Other values')
    expect(other.getAttribute('aria-pressed')).toBe('false')
    expect(within(field).queryByTestId('day-input')).toBeNull()
    expect(within(field).queryByTestId('day-beside')).toBeNull()

    fireEvent.click(other)
    // One chip is pressed (the "Other values" one, not a suggestion).
    expect(screen.getByTestId('day-other').getAttribute('aria-pressed')).toBe('true')
    const input = screen.getByTestId('day-input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(within(field).queryByTestId('day-suggestion-21')?.getAttribute('aria-pressed')).toBe(
      'false',
    )
    // Opening the box takes focus for typing at once.
    expect(document.activeElement).toBe(input)
    // Opening is view state only: it chooses nothing.
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('typing a day commits it on Enter and on blur, through onChoose', () => {
    const { onChoose } = renderField()
    fireEvent.click(screen.getByTestId('day-other'))
    const input = screen.getByTestId('day-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '33' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(onChoose).toHaveBeenCalledWith(33)
    expect(screen.queryByTestId('day-error')).toBeNull()

    fireEvent.change(input, { target: { value: '44' } })
    fireEvent.blur(input)
    expect(onChoose).toHaveBeenCalledTimes(2)
    expect(onChoose).toHaveBeenLastCalledWith(44)
  })

  it('clicking a suggestion calls onChoose and hides the box', () => {
    const { onChoose, rerender } = renderField()
    fireEvent.click(screen.getByTestId('day-other'))
    expect(screen.getByTestId('day-input')).toBeTruthy()
    // Click the suggestion while the box is still open — the click itself
    // must hide it, with no rerender in between.
    fireEvent.click(screen.getByTestId('day-suggestion-42'))
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(onChoose).toHaveBeenCalledWith(42)
    expect(screen.queryByTestId('day-input')).toBeNull()

    // The parent stores the day (as the page's action does); with the box
    // closed, exactly one chip (the chosen suggestion) reads pressed.
    rerender(
      <TxrDayField
        testId="day"
        label="Last draw you will use"
        value={42}
        suggestions={SUGGESTIONS}
        onChoose={onChoose}
        check={noProblem}
      />,
    )
    expect(screen.getByTestId('day-suggestion-42').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('day-other').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('day-suggestion-33').getAttribute('aria-pressed')).toBe('false')
  })

  it('a fresh but equal suggestions array does not close a box the user just opened', () => {
    const { rerender } = renderField({ value: 33 })
    fireEvent.click(screen.getByTestId('day-other'))
    expect(screen.getByTestId('day-input')).toBeTruthy()

    // Step 4 maps its choices to a new array on every render; with an
    // effect on `suggestions` that rerender closed the user's box again.
    rerender(
      <TxrDayField
        testId="day"
        label="Last draw you will use"
        value={33}
        suggestions={[...SUGGESTIONS]}
        onChoose={vi.fn()}
        check={noProblem}
      />,
    )
    expect(screen.getByTestId('day-input')).toBeTruthy()
    expect(screen.getByTestId('day-other').getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking the suggestion equal to the value clears a stale typed error and resets the draft', () => {
    const { onChoose } = renderField({
      value: 33,
      check: day => (day === 999 ? 'Day 999 is not one of the files.' : null),
    })
    fireEvent.click(screen.getByTestId('day-other'))
    const input = screen.getByTestId('day-input') as HTMLInputElement
    expect(input.value).toBe('33')

    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.blur(input)
    expect(screen.getByTestId('day-error').textContent).toBe('Day 999 is not one of the files.')

    // Clicking the suggestion that equals the stored day skips onChoose, but
    // the click still closes the box and must not leave the typed-error line
    // stuck under the hidden box.
    fireEvent.click(screen.getByTestId('day-suggestion-33'))
    expect(onChoose).not.toHaveBeenCalled()
    expect(screen.queryByTestId('day-input')).toBeNull()
    expect(screen.queryByTestId('day-error')).toBeNull()

    // Reopening the box shows the draft reset to the stored day.
    fireEvent.click(screen.getByTestId('day-other'))
    expect((screen.getByTestId('day-input') as HTMLInputElement).value).toBe('33')
  })

  it('a value outside the suggestions arrives with "Other values" pressed and the box holding that day; changing into a suggestion closes it', () => {
    const { rerender } = renderField({ value: 100 })
    expect(screen.getByTestId('day-other').getAttribute('aria-pressed')).toBe('true')
    const input = screen.getByTestId('day-input') as HTMLInputElement
    expect(input.value).toBe('100')

    rerender(
      <TxrDayField
        testId="day"
        label="Last draw you will use"
        value={33}
        suggestions={SUGGESTIONS}
        onChoose={vi.fn()}
        check={noProblem}
      />,
    )
    expect(screen.queryByTestId('day-input')).toBeNull()
    expect(screen.getByTestId('day-other').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('day-suggestion-33').getAttribute('aria-pressed')).toBe('true')
  })

  it('with no suggestions the box shows directly and there is no "Other values" chip', () => {
    renderField({ suggestions: [] })
    expect(screen.getByTestId('day-input')).toBeTruthy()
    expect(screen.queryByTestId('day-other')).toBeNull()
    expect(screen.queryByTestId('day-suggestions')).toBeNull()
  })

  it('locked is unchanged: no chips, the box is read-only', () => {
    renderField({ value: 21, suggestions: [21], locked: true })
    expect(screen.queryByTestId('day-suggestions')).toBeNull()
    expect(screen.queryByTestId('day-other')).toBeNull()
    expect((screen.getByTestId('day-input') as HTMLInputElement).readOnly).toBe(true)
  })

  it('the typed-error line still shows (also with the box hidden the other lines show as now)', () => {
    const { rerender } = renderField({
      coverage: 'Day 21: 1 of 2 patients have a draw by this day',
      beside: '2 days ≈ 0.1 months',
      check: day => (day === 999 ? 'Day 999 is not one of the files.' : null),
    })
    // With the box hidden the coverage line still renders; the beside text
    // and the box are hidden with it.
    expect(screen.getByTestId('day-coverage').textContent).toBe(
      'Day 21: 1 of 2 patients have a draw by this day',
    )
    expect(screen.queryByTestId('day-beside')).toBeNull()

    rerender(
      <TxrDayField
        testId="day"
        label="Last draw you will use"
        value={null}
        suggestions={SUGGESTIONS}
        onChoose={vi.fn()}
        check={day => (day === 999 ? 'Day 999 is not one of the files.' : null)}
        beside="2 days ≈ 0.1 months"
        noFacts="Add your files to see the days they suggest."
        blocked="Nope"
        warning="Careful"
      />,
    )
    // The box's own lines are still there while it is hidden.
    expect(screen.getByTestId('day-no-facts').textContent).toBe(
      'Add your files to see the days they suggest.',
    )
    expect(screen.getByTestId('day-blocked').textContent).toBe('Nope')
    expect(screen.getByTestId('day-warning').textContent).toBe('Careful')

    fireEvent.click(screen.getByTestId('day-other'))
    const input = screen.getByTestId('day-input')
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.blur(input)
    expect(screen.getByTestId('day-error').textContent).toBe('Day 999 is not one of the files.')
    // The beside text appears with the box.
    expect(screen.getByTestId('day-beside').textContent).toBe('2 days ≈ 0.1 months')
  })
})
