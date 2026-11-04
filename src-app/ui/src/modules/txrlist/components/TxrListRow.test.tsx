// @vitest-environment jsdom
//
// TEST-UL-8 (ITEM-6) — the row per the boards' layout: the three status
// colours + headlines, the disabled `cannot` row, the two chip palettes,
// the NULL-hides-column rules (performance/time), the action slot, and the
// checked (selected) board look.

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TxrListRowView } from './TxrListRow'
import type { TxrListRow, TxrRunStatus } from '../types'

// jsdom gaps the kit's base-ui controls probe at mount (the kit's own
// checkbox suite: base-ui CheckboxRoot constructs a PointerEvent inside its
// click handler, so without this every fireEvent.click on a Checkbox throws).
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

/** One E-board row (EXAMPLE-UL-1's `direct-on` shape). */
function row(over: Partial<TxrListRow> = {}): TxrListRow {
  return {
    key: 'direct-on',
    name: 'direct-on',
    tag: 'Paper 2021, R',
    chip: { label: 'Response probability', tone: 'neutral' },
    performanceText: null,
    run: { status: 'can', headline: 'Can run', detail: 'all 151 patients', disabled: false },
    timeText: 'about 2 min',
    action: { label: 'About' },
    ...over,
  }
}

const checkboxEl = (rendered: HTMLElement) =>
  rendered.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-direct-on"]')!
const statusEl = (rendered: HTMLElement) => rendered.querySelector<HTMLElement>('b')!

/** cssstyle serializes hex colours as rgb(); normalize back to the board bytes. */
function colorHex(value: string): string {
  const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!match) return value
  return `#${match
    .slice(1)
    .map(n => Number(n).toString(16).padStart(2, '0'))
    .join('')}`
}

describe('TxrListRow (TEST-UL-8 — board-exact row)', () => {
  it('renders the E-board row: monospace id, paper line, chip, status, time, action', () => {
    const { getByTestId } = render(<TxrListRowView row={row()} checked={false} />)
    const el = getByTestId('txr-list-row-direct-on')
    expect(el.textContent).toContain('direct-on')
    expect(el.textContent).toContain('Paper 2021, R')
    expect(el.textContent).toContain('Response probability')
    expect(el.textContent).toContain('Can run')
    expect(el.textContent).toContain('all 151 patients')
    expect(el.textContent).toContain('about 2 min')
    expect(el.textContent).toContain('About')
    const chip = el.querySelector<HTMLElement>('[data-tone="neutral"]')!
    expect(chip.textContent).toBe('Response probability')
  })

  it('renders the three statuses with the boards\' colours and verbatim headlines', () => {
    const cases: Array<[TxrRunStatus, string, string]> = [
      ['can', '#1f6b3a', 'Can run'],
      ['some', '#8a5a00', 'Can run for some patients'],
      ['cannot', '#b3261e', 'Cannot run'],
    ]
    for (const [status, color, headline] of cases) {
      const { container } = render(
        <TxrListRowView
          row={row({
            run: { status, headline, detail: 'all 151 patients', disabled: status === 'cannot' },
          })}
          checked={false}
        />,
      )
      const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
      expect(statusEl(rendered).textContent).toBe(headline)
      expect(colorHex(statusEl(rendered).style.color)).toBe(color)
    }
  })

  it('a cannot row\'s checkbox is disabled and the row renders the board\'s muted look', () => {
    const { container } = render(
      <TxrListRowView
        row={row({
          run: {
            status: 'cannot',
            headline: 'Cannot run',
            detail: 'needs LDH, not in your file',
            disabled: true,
          },
        })}
        checked={false}
      />,
    )
    const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    const checkbox = checkboxEl(rendered)
    const disabledMarked =
      checkbox.getAttribute('aria-disabled') === 'true' ||
      checkbox.hasAttribute('disabled') ||
      checkbox.hasAttribute('data-disabled')
    expect(disabledMarked).toBe(true)
    expect(rendered.style.opacity).toBe('0.8')
    expect(colorHex(rendered.style.background)).toBe('#fbfaf8')
  })

  it('a stale host selection never shows a disabled row checked (the board never ticks one)', () => {
    const { container } = render(
      <TxrListRowView
        row={row({
          run: { status: 'cannot', headline: 'Cannot run', detail: 'needs LDH', disabled: true },
        })}
        checked={true}
      />,
    )
    const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    const checkbox = checkboxEl(rendered)
    const checkedMarked =
      checkbox.getAttribute('aria-checked') === 'true' || checkbox.hasAttribute('data-checked')
    expect(checkedMarked).toBe(false)
  })

  it('maps the two chip tones to the boards\' palettes', () => {
    const { container: neutral } = render(
      <TxrListRowView row={row({ chip: { label: 'Response call', tone: 'neutral' } })} checked={false} />,
    )
    const neutralChip = neutral.querySelector<HTMLElement>('[data-tone="neutral"]')!
    expect(colorHex(neutralChip.style.background)).toBe('#eef0e6')
    expect(colorHex(neutralChip.style.color)).toBe('#3d4a14')

    const { container: accent } = render(
      <TxrListRowView
        row={row({ chip: { label: 'Learned here', tone: 'accent' } as TxrListRow['chip'] })}
        checked={false}
      />,
    )
    const accentChip = accent.querySelector<HTMLElement>('[data-tone="accent"]')!
    expect(colorHex(accentChip.style.background)).toBe('#e8eef6')
    expect(colorHex(accentChip.style.color)).toBe('#143a68')
  })

  it('performanceText null renders no performance column; a value renders it', () => {
    const { container: absent } = render(
      <TxrListRowView
        row={row({ performanceText: null, chip: null })}
        checked={false}
      />,
    )
    expect(absent.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!.textContent)
      .not.toContain('other cohorts')

    const { container: present } = render(
      <TxrListRowView
        row={row({ performanceText: 'other cohorts: AUC 0.64', chip: null })}
        checked={false}
      />,
    )
    const presentEl = present.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    expect(presentEl.textContent).toContain('other cohorts: AUC 0.64')
  })

  it('timeText null renders no time entry', () => {
    const { container } = render(
      <TxrListRowView row={row({ timeText: null, chip: null })} checked={false} />,
    )
    const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    expect(rendered.textContent).not.toContain('about 2 min')
  })

  it('the action slot renders its label and fires onAction with the row', () => {
    const onAction = vi.fn()
    const subject = row()
    const { container } = render(
      <TxrListRowView row={subject} checked={false} onAction={onAction} />,
    )
    const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    fireEvent.click(rendered.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on-action"]')!)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls[0][0]).toBe(subject)
  })

  it('action null renders no action control', () => {
    const { container } = render(
      <TxrListRowView row={row({ action: null, chip: null })} checked={false} />,
    )
    expect(
      container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on-action"]'),
    ).toBeNull()
  })

  it('a checked row carries the board\'s selected look (2px #1d4e89 on #f4f8fc)', () => {
    const { container } = render(<TxrListRowView row={row()} checked={true} />)
    const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    expect(rendered.style.borderWidth).toBe('2px')
    expect(colorHex(rendered.style.borderColor)).toBe('#1d4e89')
    expect(colorHex(rendered.style.background)).toBe('#f4f8fc')
  })

  it('an unchecked row carries the board\'s neutral look (1px #cfcdc7 on white)', () => {
    const { container } = render(<TxrListRowView row={row()} checked={false} />)
    const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    expect(rendered.style.borderWidth).toBe('1px')
    expect(colorHex(rendered.style.borderColor)).toBe('#cfcdc7')
    expect(colorHex(rendered.style.background)).toBe('#ffffff')
  })

  it('a cannot row\'s checkbox never fires the toggle', () => {
    const onToggle = vi.fn()
    const { container } = render(
      <TxrListRowView
        row={row({
          run: { status: 'cannot', headline: 'Cannot run', detail: 'needs LDH', disabled: true },
        })}
        checked={false}
        onToggle={onToggle}
      />,
    )
    const rendered = container.querySelector<HTMLElement>('[data-testid="txr-list-row-direct-on"]')!
    fireEvent.click(checkboxEl(rendered))
    expect(onToggle).not.toHaveBeenCalled()
  })
})
