// @vitest-environment jsdom
//
// TEST-UL-5 (ITEM-6, [acceptance], INV-2) — the screen-I run group header:
// the run-facts line, the host actions (default + board-danger tones), and
// the select-all that toggles EXACTLY the section's non-disabled rows —
// composed with lib/selection.ts's `toggleSection`, so the disabled rows of
// the section and every other section never move (EXAMPLE-UL-4).

import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TxrListSectionHeader } from './TxrListSectionHeader'
import { toggleSection } from '../lib/selection'
import type { TxrListRow, TxrListSection } from '../types'

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

/** EXAMPLE-UL-4's CRC group: 11 rows, 2 disabled (9 eligible). */
function crcSection(): TxrListSection {
  return {
    key: 'crc-day-56',
    title: 'CRC cohort, day 56',
    subtitle: 'trained 19 Oct on patients.csv · 151 patients · 11 models · progression or death by day 238',
    rowKeys: Array.from({ length: 11 }, (_, i) => `crc-${i}`),
    actions: [
      { id: 'rename', label: 'Rename', tone: 'default' },
      { id: 'delete', label: "Delete the run's models", tone: 'danger' },
    ],
  }
}

/** EXAMPLE-UL-4's second group: 2 rows, 1 disabled (1 eligible). */
function lungSection(): TxrListSection {
  return {
    key: 'lung-day-42',
    title: 'Lung pilot, day 42',
    subtitle: 'trained 18 Oct on patients.csv · 38 patients · 2 models · death by day 180',
    rowKeys: ['lung-0', 'lung-1'],
    actions: [{ id: 'rename', label: 'Rename', tone: 'default' }],
  }
}

function crcRows(): TxrListRow[] {
  return Array.from({ length: 11 }, (_, i) => {
    const disabled = i >= 9
    return {
      key: `crc-${i}`,
      name: `crc-${i}`,
      tag: 'decision day 56',
      chip: { label: 'Trained by you', tone: 'accent' },
      performanceText: 'own data, cross-checked: AUC 0.66',
      run: {
        status: disabled ? ('cannot' as const) : ('some' as const),
        headline: disabled ? 'Cannot run' : 'Can run for some patients',
        detail: disabled ? 'needs LDH, not in your file' : 'all 151 patients',
        disabled,
      },
      timeText: 'about 1 min',
      action: { label: 'Details' },
    }
  })
}

function lungRows(): TxrListRow[] {
  const disabled = (i: number) => i >= 1
  return Array.from({ length: 2 }, (_, i) => ({
    key: `lung-${i}`,
    name: `lung-${i}`,
    tag: 'decision day 42',
    chip: null,
    performanceText: null,
    run: {
      status: disabled(i) ? ('cannot' as const) : ('can' as const),
      headline: disabled(i) ? 'Cannot run' : 'Can run',
      detail: disabled(i) ? 'needs Ki-67, not in your file' : 'all 38 patients',
      disabled: disabled(i),
    },
    timeText: 'under 1 min',
    action: { label: 'Details' },
  }))
}

/** The controlled host: selection is host state, the header reports toggles. */
function Harness({
  section,
  rows,
  selected,
  onToggleSection,
  onSectionAction,
}: {
  section: TxrListSection
  rows: TxrListRow[]
  selected: ReadonlySet<string>
  onToggleSection?: (section: TxrListSection) => void
  onSectionAction?: (sectionKey: string, actionId: string) => void
}) {
  return (
    <TxrListSectionHeader
      section={section}
      rows={rows}
      selected={selected}
      onToggleSection={onToggleSection}
      onSectionAction={onSectionAction}
    />
  )
}

/** cssstyle serializes hex colours as rgb(); normalize back to the board bytes. */
function colorHex(value: string): string {
  const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!match) return value
  return `#${match
    .slice(1)
    .map(n => Number(n).toString(16).padStart(2, '0'))
    .join('')}`
}

describe('TxrListSectionHeader (TEST-UL-5 — run group header, INV-2)', () => {
  it('renders the title, the run-facts subtitle and the host actions', () => {
    const { getByTestId } = render(
      <Harness section={crcSection()} rows={crcRows()} selected={new Set()} />,
    )
    const header = getByTestId('txr-list-section-crc-day-56')
    expect(header.textContent).toContain('CRC cohort, day 56')
    expect(header.textContent).toContain('trained 19 Oct on patients.csv')
    expect(header.textContent).toContain('151 patients · 11 models · progression or death by day 238')
    expect(header.textContent).toContain('Rename')
    expect(header.textContent).toContain("Delete the run's models")
  })

  it('the delete action carries the board\'s danger red; Rename the board\'s link blue', () => {
    const { getByTestId } = render(
      <Harness section={crcSection()} rows={crcRows()} selected={new Set()} />,
    )
    const rename = getByTestId('txr-list-section-action-crc-day-56-rename')
    const danger = getByTestId('txr-list-section-action-crc-day-56-delete')
    expect(colorHex(rename.style.color)).toBe('var(--txr-brand)')
    expect(colorHex(danger.style.color)).toBe('var(--txr-danger)')
  })

  it('the select-all toggles exactly the section\'s eligible rows (9 of 11, the 2 disabled stay)', () => {
    function Controlled({ initial }: { initial: ReadonlySet<string> }) {
      const [selected, setSelected] = useState<ReadonlySet<string>>(initial)
      const rows = crcRows()
      return (
        <>
          <TxrListSectionHeader
            section={crcSection()}
            rows={rows}
            selected={selected}
            onToggleSection={section => setSelected(toggleSection(selected, section, rows))}
          />
          <span data-testid="selected">{[...selected].sort().join(',')}</span>
        </>
      )
    }
    const { getByTestId } = render(<Controlled initial={new Set()} />)
    const checkbox = getByTestId('txr-list-section-select-all-crc-day-56')
    // Empty selection: the box is unchecked, and clicking selects the 9 eligible.
    expect(checkbox.getAttribute('aria-checked')).not.toBe('true')
    fireEvent.click(checkbox)
    const selected = getByTestId('selected').textContent!
    const events = new Set(selected.split(','))
    expect(events.size).toBe(9)
    expect(events.has('crc-0')).toBe(true)
    expect(events.has('crc-9')).toBe(false) // the two disabled rows never move
    expect(events.has('crc-10')).toBe(false)
    // And the box now reads checked, so the next toggle unchecks all.
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(checkbox)
    expect(getByTestId('selected').textContent).toBe('')
  })

  it('one section\'s toggle never touches another section\'s rows', () => {
    function Controlled() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
      const rows = [...crcRows(), ...lungRows()]
      return (
        <>
          <TxrListSectionHeader
            section={crcSection()}
            rows={rows}
            selected={selected}
            onToggleSection={section => setSelected(toggleSection(selected, section, rows))}
          />
          <TxrListSectionHeader
            section={lungSection()}
            rows={rows}
            selected={selected}
            onToggleSection={section => setSelected(toggleSection(selected, section, rows))}
          />
          <span data-testid="selected">{[...selected].sort().join(',')}</span>
        </>
      )
    }
    const { getByTestId } = render(<Controlled />)
    fireEvent.click(getByTestId('txr-list-section-select-all-crc-day-56'))
    const selected = getByTestId('selected').textContent!
    expect(selected).not.toContain('lung-0')
    expect(selected).not.toContain('lung-1')
    // The disabled lung row is never selected even when the lung group toggles.
    fireEvent.click(getByTestId('txr-list-section-select-all-lung-day-42'))
    const after = getByTestId('selected').textContent!
    expect(after).toContain('lung-0')
    expect(after).not.toContain('lung-1')
  })

  it('action clicks call the host with the section key and the action id', () => {
    const onSectionAction = vi.fn()
    const { getByTestId } = render(
      <Harness
        section={crcSection()}
        rows={crcRows()}
        selected={new Set()}
        onSectionAction={onSectionAction}
      />,
    )
    fireEvent.click(getByTestId('txr-list-section-action-crc-day-56-delete'))
    expect(onSectionAction).toHaveBeenCalledTimes(1)
    expect(onSectionAction.mock.calls[0]).toEqual(['crc-day-56', 'delete'])
    fireEvent.click(getByTestId('txr-list-section-action-crc-day-56-rename'))
    expect(onSectionAction.mock.calls[1]).toEqual(['crc-day-56', 'rename'])
  })
})
