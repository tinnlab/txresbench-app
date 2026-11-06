// @vitest-environment jsdom
/**
 * The F at-a-time control (`components/TxrAtATimeControl.tsx`, ITEM-10;
 * PROV-UI-RUN-5's frozen `TxrAtATimeControlProps`, DEC-5, CONS-UI-RUN-11):
 * the board's "Run at the same time" row — the run's current value plus
 * the presets (1/2/4), an out-of-preset value (the engine default 3)
 * rendering as its own chip (so the current pick is never a dead
 * control), a click reporting the picked number (the host calls the run
 * store's `setAtATime` — the engine's mid-run lane route), `busy`
 * disabling the row and the grown error line rendering the store's typed
 * failure (never a silent stale value).
 *
 * The presets' labels and the current value are the test's own synthetic
 * numbers (INV-6 — the board's example counts are design examples, never
 * data).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TxrAtATimeControl, type TxrAtATimeControlProps } from './TxrAtATimeControl'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function propsOf(overrides: Partial<TxrAtATimeControlProps> = {}): TxrAtATimeControlProps {
  return {
    value: 3,
    onChange: () => undefined,
    busy: false,
    error: null,
    ...overrides,
  }
}

function renderControl(overrides: Partial<TxrAtATimeControlProps> = {}) {
  const onChange = vi.fn()
  const utils = render(<TxrAtATimeControl {...propsOf({ onChange, ...overrides })} />)
  return { ...utils, onChange }
}

describe('TxrAtATimeControl (F at-a-time row)', () => {
  it("renders the board row: the value's preset active + the 1/2/4 presets", () => {
    renderControl({ value: 2 })
    const control = screen.getByTestId('txr-run-at-a-time')
    expect(control.textContent).toContain('Run at the same time')
    const segmented = screen.getByTestId('txr-run-at-a-time-control')
    // The value sits in the presets: no extra chip, 2 is the active pick.
    expect(within(segmented).getAllByRole('tab').map(b => b.textContent)).toEqual([
      '1',
      '2',
      '4',
    ])
    expect(within(segmented).getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true')
  })

  it('renders an out-of-preset value (the engine default 3) as its own chip', () => {
    renderControl({ value: 3 })
    const segmented = screen.getByTestId('txr-run-at-a-time-control')
    expect(within(segmented).getAllByRole('tab').map(b => b.textContent)).toEqual([
      '1',
      '2',
      '4',
      '3',
    ])
    expect(within(segmented).getAllByRole('tab')[3].getAttribute('aria-selected')).toBe('true')
  })

  it('reports a picked preset as the number the host must call setAtATime with', () => {
    const { onChange } = renderControl({ value: 3 })
    const buttons = within(screen.getByTestId('txr-run-at-a-time-control')).getAllByRole('tab')
    fireEvent.click(buttons[0])
    expect(onChange).toHaveBeenCalledWith(1)
    fireEvent.click(buttons[2])
    expect(onChange).toHaveBeenCalledWith(4)
  })

  it('disables the row while busy (a run-level action in flight)', () => {
    renderControl({ busy: true })
    for (const option of within(
      screen.getByTestId('txr-run-at-a-time-control'),
    ).getAllByRole('tab')) {
      expect(option.getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('renders the store\'s typed failure line under the row, never a silent stale value', () => {
    const { onChange } = renderControl({ value: 3, error: 'Could not change the number running at a time.' })
    expect(screen.getByTestId('txr-run-at-a-time-error').textContent).toBe(
      'Could not change the number running at a time.',
    )
    // The row stays live (the store restored the run's value; a retry is possible).
    fireEvent.click(
      within(screen.getByTestId('txr-run-at-a-time-control')).getAllByRole('tab')[0],
    )
    expect(onChange).toHaveBeenCalledWith(1)
  })

  it('renders the presets only for a run that carries no value (nothing selected)', () => {
    renderControl({ value: null })
    const segmented = screen.getByTestId('txr-run-at-a-time-control')
    expect(within(segmented).getAllByRole('tab').map(b => b.textContent)).toEqual(['1', '2', '4'])
    for (const option of within(segmented).getAllByRole('tab')) {
      expect(option.getAttribute('aria-selected')).not.toBe('true')
    }
  })
})
