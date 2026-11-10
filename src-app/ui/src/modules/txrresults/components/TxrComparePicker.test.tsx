// @vitest-environment jsdom
/**
 * TxrComparePicker — qa-fixes2 ITEM-7 (R2-07): the H page's compare tab used
 * to be ALWAYS the first two method columns, with no control and no clue why
 * those two. The picker exposes the tab's method columns as two kit Selects
 * ("Compare <A> with <B>") and can never produce an A == B pair — picking
 * the other select's column swaps them (one visible rule, no hidden state).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TxrComparePicker } from './TxrComparePicker'
import type { TxrHeatmapColumn } from '../types'

function column(index: number): TxrHeatmapColumn {
  const id = `method-${index + 1}`
  return {
    methodId: id,
    label: id,
    group: `group-${index + 1}`,
    groupLabel: `Group ${index + 1}`,
    task: 'pfs',
    probSource: 'recalibrated',
    coverage: null,
    values: [],
    notes: [],
    constantValue: null,
  }
}

const columns = () => [column(0), column(1), column(2)]

async function pick(trigger: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)
    await Promise.resolve()
  })
  const option = document.querySelector<HTMLElement>(
    `[role="option"][data-testid$="-opt-${value}"]`,
  )!
  expect(option).not.toBeNull()
  await act(async () => {
    fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(option, { button: 0 })
    fireEvent.click(option)
    await Promise.resolve()
  })
}

afterEach(cleanup)

describe('TxrComparePicker (qa-fixes2 R2-07 — two-method compare choice)', () => {
  it('shows the pair as two labelled selects (the column names, not silent first-two)', () => {
    render(<TxrComparePicker columns={columns()} pair={{ a: 'method-1', b: 'method-2' }} onChange={vi.fn()} />)
    expect(screen.getByTestId('txr-compare-picker').textContent).toContain('Compare')
    expect(screen.getByTestId('txr-compare-picker').textContent).toContain('with')
    const a = screen.getByTestId('txr-compare-picker-a')
    const b = screen.getByTestId('txr-compare-picker-b')
    expect(a.textContent).toContain('method-1')
    expect(b.textContent).toContain('method-2')
  })

  it('reports a fresh B for the b-select', async () => {
    const onChange = vi.fn()
    render(
      <TxrComparePicker columns={columns()} pair={{ a: 'method-1', b: 'method-2' }} onChange={onChange} />,
    )
    await pick(screen.getByTestId('txr-compare-picker-b'), 'method-3')
    expect(onChange).toHaveBeenCalledWith({ a: 'method-1', b: 'method-3' })
  })

  it('reports a fresh A for the a-select', async () => {
    const onChange = vi.fn()
    render(
      <TxrComparePicker columns={columns()} pair={{ a: 'method-1', b: 'method-2' }} onChange={onChange} />,
    )
    await pick(screen.getByTestId('txr-compare-picker-a'), 'method-3')
    expect(onChange).toHaveBeenCalledWith({ a: 'method-3', b: 'method-2' })
  })

  it('picking the other select\'s column swaps (the pair never becomes A == B)', async () => {
    const onChange = vi.fn()
    render(
      <TxrComparePicker columns={columns()} pair={{ a: 'method-1', b: 'method-2' }} onChange={onChange} />,
    )
    await pick(screen.getByTestId('txr-compare-picker-a'), 'method-2')
    expect(onChange).toHaveBeenCalledWith({ a: 'method-2', b: 'method-1' })
    onChange.mockClear()
    await pick(screen.getByTestId('txr-compare-picker-b'), 'method-1')
    expect(onChange).toHaveBeenCalledWith({ a: 'method-2', b: 'method-1' })
  })

  it('does not report a change for a re-pick of the same column', async () => {
    const onChange = vi.fn()
    render(
      <TxrComparePicker columns={columns()} pair={{ a: 'method-1', b: 'method-2' }} onChange={onChange} />,
    )
    await pick(screen.getByTestId('txr-compare-picker-a'), 'method-1')
    expect(onChange).not.toHaveBeenCalled()
  })
})
