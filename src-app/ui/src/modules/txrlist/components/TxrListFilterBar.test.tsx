// @vitest-environment jsdom
//
// TEST-UL-9 (ITEM-6) — the boards' filter row: the built-in "All N" /
// "Can run N" count chips over the rows the bar received, the host chips
// (counts + toggle callbacks, pressed/unpressed looks), the built-in
// "Select all that can run" toggle, and the optional search/sort controls
// (EXAMPLE-UL-5, EXAMPLE-UL-8).

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TxrListFilterBar } from './TxrListFilterBar'
import type { TxrListRow, TxrSearchControl, TxrSortControl } from '../types'

// jsdom gaps the kit's base-ui controls probe at mount (see TxrListRow.test).
beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
})

afterEach(cleanup)

/** One can-run row, keyed; 5 of the 38 are `cannot` (EXAMPLE-UL-8). */
function row(key: string, disabled = false): TxrListRow {
  return {
    key,
    name: key,
    tag: 'Paper 2021, R',
    chip: null,
    performanceText: null,
    run: {
      status: disabled ? 'cannot' : 'can',
      headline: disabled ? 'Cannot run' : 'Can run',
      detail: disabled ? 'needs LDH, not in your file' : 'all 151 patients',
      disabled,
    },
    timeText: 'about 2 min',
    action: { label: 'About' },
  }
}

const rows = (total: number, cannot: number): TxrListRow[] =>
  Array.from({ length: total }, (_, i) => row(`m${i}`, i >= total - cannot))

/** cssstyle serializes hex colours as rgb(); normalize back to the board bytes. */
function colorHex(value: string): string {
  const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!match) return value
  return `#${match
    .slice(1)
    .map(n => Number(n).toString(16).padStart(2, '0'))
    .join('')}`
}

describe('TxrListFilterBar (TEST-UL-9 — filter/search/sort bar)', () => {
  it('the built-in chips count all rows and the non-disabled rows over the rows received', () => {
    const { getByTestId } = render(
      <TxrListFilterBar rows={rows(38, 5)} selected={new Set()} />,
    )
    expect(getByTestId('txr-list-filter-all').textContent).toBe('All 38')
    expect(getByTestId('txr-list-filter-can-run').textContent).toBe('Can run 33')
  })

  it('the wired built-in chips are real filters: All clears, Can run toggles (CM-3)', () => {
    const onAll = vi.fn()
    const onCanRun = vi.fn()
    const { rerender, getByTestId } = render(
      <TxrListFilterBar
        rows={rows(38, 5)}
        selected={new Set()}
        allFilter={{ active: false, onClick: onAll }}
        canRunFilter={{ active: false, onClick: onCanRun }}
      />,
    )
    const all = getByTestId('txr-list-filter-all')
    const canRun = getByTestId('txr-list-filter-can-run')
    expect(all.getAttribute('aria-pressed')).toBe('false')
    expect(canRun.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(all)
    expect(onAll).toHaveBeenCalledTimes(1)
    fireEvent.click(canRun)
    expect(onCanRun).toHaveBeenCalledTimes(1)
    // The host's active state drives the pressed look (the host's "All = no
    // filter" rule: pressed exactly when no filter is on).
    rerender(
      <TxrListFilterBar
        rows={rows(38, 5)}
        selected={new Set()}
        allFilter={{ active: true, onClick: onAll }}
        canRunFilter={{ active: false, onClick: onCanRun }}
      />,
    )
    expect(getByTestId('txr-list-filter-all').getAttribute('aria-pressed')).toBe('true')
    expect(getByTestId('txr-list-filter-all').style.background).toBe('rgb(232, 238, 246)')
    rerender(
      <TxrListFilterBar
        rows={rows(38, 5)}
        selected={new Set()}
        allFilter={{ active: false, onClick: onAll }}
        canRunFilter={{ active: true, onClick: onCanRun }}
      />,
    )
    expect(getByTestId('txr-list-filter-can-run').getAttribute('aria-pressed')).toBe('true')
    expect(getByTestId('txr-list-filter-all').getAttribute('aria-pressed')).toBe('false')
  })

  it('host chips render with their counts, fire onToggle, and carry pressed/unpressed looks', () => {
    const onToggleA = vi.fn()
    const onToggleB = vi.fn()
    const { getByTestId } = render(
      <TxrListFilterBar
        rows={rows(38, 5)}
        selected={new Set()}
        filterChips={[
          { id: 'response-call', label: 'Response call', count: 4, active: true, onToggle: onToggleA },
          { id: 'response-probability', label: 'Response probability', count: 9, active: false, onToggle: onToggleB },
        ]}
      />,
    )
    const active = getByTestId('txr-list-filter-response-call')
    const inactive = getByTestId('txr-list-filter-response-probability')
    expect(active.textContent).toBe('Response call 4')
    expect(inactive.textContent).toBe('Response probability 9')
    expect(active.getAttribute('aria-pressed')).toBe('true')
    expect(inactive.getAttribute('aria-pressed')).toBe('false')
    // The active chip is the board's pressed pill (blue border on #e8eef6);
    // the inactive one the neutral pill.
    expect(colorHex(active.style.borderColor)).toBe('#1d4e89')
    expect(colorHex(active.style.background)).toBe('#e8eef6')
    expect(colorHex(inactive.style.borderColor)).toBe('#cfcdc7')
    expect(colorHex(inactive.style.background)).toBe('#ffffff')
    fireEvent.click(active)
    expect(onToggleA).toHaveBeenCalledTimes(1)
    fireEvent.click(inactive)
    expect(onToggleB).toHaveBeenCalledTimes(1)
  })

  it('the select-all-that-can-run box is checked only when every non-disabled row is selected', () => {
    const { rerender } = render(<TxrListFilterBar rows={rows(38, 5)} selected={new Set(['m0'])} />)
    const checkbox = () => document.querySelector<HTMLElement>('[data-testid="txr-list-select-all-can-run"]')!
    const isChecked = () =>
      checkbox().getAttribute('aria-checked') === 'true' || checkbox().hasAttribute('data-checked')
    expect(isChecked()).toBe(false)
    // All 33 eligible keys selected -> the box reads checked.
    rerender(
      <TxrListFilterBar
        rows={rows(38, 5)}
        selected={new Set(Array.from({ length: 33 }, (_, i) => `m${i}`))}
      />,
    )
    expect(isChecked()).toBe(true)
  })

  it('the select-all-that-can-run toggle reports to the host', () => {
    const onToggleAllCanRun = vi.fn()
    render(
      <TxrListFilterBar
        rows={rows(38, 5)}
        selected={new Set()}
        onToggleAllCanRun={onToggleAllCanRun}
      />,
    )
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-select-all-can-run"]')!)
    expect(onToggleAllCanRun).toHaveBeenCalledTimes(1)
  })

  it('the search control renders and reports what the user typed', () => {
    const onChange = vi.fn()
    const search: TxrSearchControl = { value: '', onChange }
    render(<TxrListFilterBar rows={rows(38, 5)} selected={new Set()} search={search} />)
    const input = document.querySelector<HTMLInputElement>('[data-testid="txr-list-search"]')!
    expect(input.getAttribute('placeholder')).toBe('Find a model or run')
    fireEvent.change(input, { target: { value: 'cox' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe('cox')
  })

  it('the sort control renders its options and reports the chosen value', async () => {
    const onChange = vi.fn()
    const sort: TxrSortControl = {
      value: 'newest',
      options: [
        { value: 'newest', label: 'Newest run first' },
        { value: 'patients', label: 'Patients covered' },
        { value: 'time', label: 'Time to run' },
      ],
      onChange,
    }
    render(<TxrListFilterBar rows={rows(38, 5)} selected={new Set()} sort={sort} />)
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-list-sort"]')!
    expect(trigger.textContent).toContain('Newest run first')
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const option = document.querySelector<HTMLElement>('[role="option"][data-testid="txr-list-sort-opt-time"]')!
    // base-ui commits a select on the pointer/click sequence — a bare synthetic
    // `click` never reaches the item's handler (measured, not assumed).
    await act(async () => {
      fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(option, { button: 0 })
      fireEvent.click(option)
      await Promise.resolve()
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe('time')
  })

  it('no search/sort props render neither control', () => {
    const { container } = render(<TxrListFilterBar rows={rows(38, 5)} selected={new Set()} />)
    expect(container.querySelector('[data-testid="txr-list-search"]')).toBeNull()
    expect(container.querySelector('[data-testid="txr-list-sort"]')).toBeNull()
  })
})
