// @vitest-environment jsdom
//
// TEST-UL-6 ([acceptance], INV-3 — the bottom bar) + TEST-UL-10 (ITEM-7 —
// the windowed list: virtualization, loading/error/empty, focus order) over
// the composed TxrSelectList: the boards' bottom bar (count, total time,
// at-a-time, save-models, notice, Run), the selection wiring (the one
// lib/selection rule set applied by the list), the run keys (selection = run,
// DEC-9; a visible disabled stale key is never handed to the engine), the
// screen-I section composition (EXAMPLE-UL-4), and the test-ids the plan
// pins.

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import {
  TXRLIST_ROW_HEIGHT,
  TxrSelectList,
  type TxrSelectListProps,
} from './TxrSelectList'
import { countSelected } from '../lib/selection'
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

// ── jsdom HAS NO LAYOUT, and this windowed list is made of layout ──────────────────────
//
// The virtualizer reads the overlayscrollbars viewport's offsetHeight (the
// window), every row's offsetHeight (the measured size), and `scrollTop` on
// scroll events; jsdom answers 0 to all of them, so against stock jsdom the
// window would stay empty. The layout is therefore STATED, exactly like the
// pre-existing entryList suite: a tall viewport (every SHORT fixture mounts
// whole; the 400-row fixture is windowed against the same height), and every
// item measuring what the list estimates it (a mismatch between what the
// table says and what the browser would say is then the test's concern, not
// the fixture's).
const VIEWPORT_H = 1200

const isViewport = (el: HTMLElement): boolean =>
  el.hasAttribute('data-overlayscrollbars-viewport')

/** The virtualizer's own declared total size — what the browser would call
 *  the scrollHeight of the content box. */
function declaredContentHeight(el: HTMLElement): number {
  const content = el.querySelector<HTMLElement>('[data-testid="txr-list-content"]')
  return content === null ? 0 : Math.round(parseFloat(content.style.height) || 0)
}

let restoreLayout: (() => void) | null = null

function statedLayout(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const saved = ['offsetHeight', 'clientHeight', 'scrollHeight'].map(
    k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  )
  const scrollTo = proto.scrollTo
  const define = (key: string, get: (el: HTMLElement) => number): void => {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement): number {
        return get(this)
      },
    })
  }
  // Items measure by their data-index: the pre-existing suite's rows-by-offset
  // pattern, with one row height for every windowed item here (the section
  // fixtures mount whole inside the stated window, so estimates never gate
  // what they assert).
  define('offsetHeight', el =>
    isViewport(el) ? VIEWPORT_H : el.hasAttribute('data-index') ? TXRLIST_ROW_HEIGHT : 0,
  )
  define('clientHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  define('scrollHeight', el => (isViewport(el) ? declaredContentHeight(el) : 0))
  proto.scrollTo = function (this: HTMLElement, arg: unknown): void {
    const top =
      typeof arg === 'object' && arg !== null
        ? Number((arg as { top?: unknown }).top ?? 0)
        : 0
    this.scrollTop = Number.isFinite(top) ? top : 0
    this.dispatchEvent(new Event('scroll'))
  }
  restoreLayout = () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d)
      else delete proto[k]
    }
    proto.scrollTo = scrollTo
  }
}

beforeEach(statedLayout)
afterEach(() => {
  restoreLayout?.()
  restoreLayout = null
})

/** The element that ACTUALLY scrolls — overlayscrollbars' own viewport. */
const viewport = (): HTMLElement =>
  document.querySelector('[data-overlayscrollbars-viewport]') as HTMLElement

function scrollTo(top: number): void {
  const vp = viewport()
  vp.scrollTop = top
  fireEvent.scroll(vp)
}

/** One E-board row (EXAMPLE-UL-1's shape), keyed. */
function row(key: string, disabled = false): TxrListRow {
  return {
    key,
    name: key,
    tag: 'Paper 2021, R',
    chip: { label: 'Response probability', tone: 'neutral' },
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
    subtitle: 'trained 3 Oct on lung_pilot.csv · 64 patients · 2 models · progression by day 224',
    rowKeys: ['lung-0', 'lung-1'],
    actions: [{ id: 'rename', label: 'Rename', tone: 'default' }],
  }
}

function crcRows(): TxrListRow[] {
  return Array.from({ length: 11 }, (_, i) => {
    const disabled = i >= 9
    return row(`crc-${i}`, disabled)
  })
}

function lungRows(): TxrListRow[] {
  return [row('lung-0', true), row('lung-1')]
}

/** A host: selection state + the list, so the controlled wiring is exercised. */
function Harness({
  props,
  initial = new Set<string>(),
}: {
  props: Omit<TxrSelectListProps, 'selected' | 'onSelectionChange'>
  initial?: ReadonlySet<string>
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(initial)
  return <TxrSelectList {...props} selected={selected} onSelectionChange={setSelected} />
}

/** A minimal E bottom-bar fixture (EXAMPLE-UL-3's shape). */
function eBar(
  onRun: ReturnType<typeof vi.fn>,
  over: Partial<TxrSelectListProps['bottomBar']> = {},
): TxrSelectListProps['bottomBar'] {
  return {
    selectedCount: 5,
    totalTimeText: 'about 14 minutes in total',
    atATime: { value: 3, onChange: vi.fn() },
    saveModels: { checked: true, onChange: vi.fn() },
    notice: "For research. Not for deciding a patient's treatment.",
    onRun,
    ...over,
  } as TxrSelectListProps['bottomBar']
}

/** Full props for a direct render (required member defaults filled in). */
function listProps(over: Partial<TxrSelectListProps> = {}): TxrSelectListProps {
  // The `as` is the fixture-helper shape: the overrides replace whole members
  // (for example a different bottomBar), never merge into them.
  return {
    rows: rows(38, 5),
    itemLabel: 'method',
    selected: new Set<string>(),
    onSelectionChange: () => {},
    bottomBar: eBar(vi.fn()),
    ...over,
  } as TxrSelectListProps
}

/** The kit Checkbox's checked state (aria-checked / data-checked, as the kit serialises it). */
function isChecked(el: HTMLElement): boolean {
  return el.getAttribute('aria-checked') === 'true' || el.hasAttribute('data-checked')
}

describe('TxrSelectList bottom bar (TEST-UL-6 — INV-3, the boards\' bar)', () => {
  it('renders the count, the total, the notice and the Run label with the board bytes', () => {
    const onRun = vi.fn()
    render(<TxrSelectList {...listProps({ bottomBar: eBar(onRun) })} />)
    expect(document.querySelector('[data-testid="txr-list-bottom-bar"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-list-selected-count"]')!.textContent).toBe(
      '5 methods selected',
    )
    expect(document.querySelector('[data-testid="txr-list-total-time"]')!.textContent).toContain(
      'about 14 minutes in total',
    )
    expect(document.querySelector('[data-testid="txr-list-total-time"]')!.textContent).toContain(
      'run',
    )
    expect(document.querySelector('[data-testid="txr-list-total-time"]')!.textContent).toContain(
      'at a time',
    )
    expect(document.querySelector('[data-testid="txr-list-save-models"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-list-bottom-bar"]')!.textContent).toContain(
      "For research. Not for deciding a patient's treatment.",
    )
    expect(document.querySelector('[data-testid="txr-list-run"]')!.textContent).toBe(
      'Run 5 methods',
    )
  })

  it('omits the notice, the at-a-time select and the save toggle when the host passes none', () => {
    render(
      <TxrSelectList
        {...listProps({
          rows: rows(5, 0),
          itemLabel: 'model',
          bottomBar: {
            selectedCount: 3,
            totalTimeText: 'about 2 minutes in total',
            onRun: vi.fn(),
          },
        })}
      />,
    )
    const bar = document.querySelector('[data-testid="txr-list-bottom-bar"]')!
    // The D/I bar: count + total + Run; notice/at-a-time/save absent (EXAMPLE-UL-3).
    expect(bar.textContent).not.toContain('For research')
    expect(bar.textContent).not.toContain('at a time')
    expect(bar.textContent).not.toContain('Save the trained models')
    expect(document.querySelector('[data-testid="txr-list-at-a-time"]')).toBeNull()
    expect(document.querySelector('[data-testid="txr-list-save-models"]')).toBeNull()
    expect(document.querySelector('[data-testid="txr-list-run"]')!.textContent).toBe('Run 3 models')
    expect(document.querySelector('[data-testid="txr-list-selected-count"]')!.textContent).toBe(
      '3 models selected',
    )
  })

  it('the at-a-time select reports its numeric value and the Run options use it', async () => {
    const onRun = vi.fn()
    const onChange = vi.fn()
    // A HOST-style control: the select reports, the host's state moves the
    // value, and the Run option carries the CURRENT value.
    function AtATimeHost() {
      const [value, setValue] = useState(3)
      return (
        <TxrSelectList
          {...listProps({
            bottomBar: eBar(onRun, {
              atATime: {
                value,
                onChange: v => {
                  onChange(v)
                  setValue(v)
                },
              },
            }),
          })}
        />
      )
    }
    render(<AtATimeHost />)
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-list-at-a-time"]')!
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const option = document.querySelector<HTMLElement>(
      '[data-testid="txr-list-at-a-time-opt-2"]',
    )!
    // base-ui commits a select on the pointer/click sequence (measured, ITEM-6).
    await act(async () => {
      fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(option, { button: 0 })
      fireEvent.click(option)
      await Promise.resolve()
    })
    expect(onChange).toHaveBeenCalledWith(2)
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-run"]')!)
    expect(onRun.mock.calls[0][1]).toEqual({ atATime: 2, saveModels: true })
  })

  it('the save toggle reports and the Run options carry it', () => {
    const onRun = vi.fn()
    const onChange = vi.fn()
    function SaveHost() {
      const [checked, setChecked] = useState(true)
      return (
        <TxrSelectList
          {...listProps({
            bottomBar: eBar(onRun, {
              saveModels: {
                checked,
                onChange: v => {
                  onChange(v)
                  setChecked(v)
                },
              },
            }),
          })}
        />
      )
    }
    render(<SaveHost />)
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-save-models"]')!)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toBe(false)
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-run"]')!)
    expect(onRun.mock.calls[0][1]).toEqual({ atATime: 3, saveModels: false })
  })

  it('Run fires with exactly the selected keys and the options (EXAMPLE-UL-3)', () => {
    const onRun = vi.fn()
    const selected = new Set(['m0', 'm1', 'm2', 'm3', 'm4'])
    render(
      <Harness
        initial={selected}
        props={{
          rows: rows(38, 5),
          itemLabel: 'method',
          bottomBar: eBar(onRun),
        }}
      />,
    )
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-run"]')!)
    expect(onRun).toHaveBeenCalledTimes(1)
    expect([...onRun.mock.calls[0][0]].sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(onRun.mock.calls[0][1]).toEqual({ atATime: 3, saveModels: true })
  })

  it('Run keeps the selection of a FILTERED-OUT row — the run is the selection, never the view', () => {
    const onRun = vi.fn()
    // The host's chips filtered the view to 3 rows; the selection is 5 (2 rows
    // hidden). DEC-9: a filter change must never silently shrink the run.
    const selected = new Set(['m0', 'm1', 'm2', 'm3', 'm4'])
    render(
      <Harness
        initial={selected}
        props={{
          rows: rows(38, 5).slice(0, 3),
          itemLabel: 'method',
          bottomBar: eBar(onRun),
        }}
      />,
    )
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-run"]')!)
    expect([...onRun.mock.calls[0][0]].sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  it('Run never hands the engine a key whose row the list shows as disabled', () => {
    const onRun = vi.fn()
    // A stale host selection: m33 became `cannot` after it was picked
    // (ITEM-3's never-prune pin). The count ignores it — the run must too.
    const all = rows(38, 5)
    const selected = new Set(['m0', 'm1', 'm2', 'm3', 'm4', 'm33'])
    render(
      <Harness
        initial={selected}
        props={{
          rows: all,
          itemLabel: 'method',
          bottomBar: eBar(onRun, { selectedCount: countSelected(selected, all) }),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-selected-count"]')!.textContent).toBe(
      '5 methods selected',
    )
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-run"]')!)
    expect([...onRun.mock.calls[0][0]].sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })
})

describe('TxrSelectList selection wiring (the ONE lib/selection rule set)', () => {
  it('a row checkbox toggles exactly that row into the selection', () => {
    render(
      <Harness
        initial={new Set()}
        props={{
          rows: rows(38, 5),
          itemLabel: 'method',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    fireEvent.click(
      document.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-m0"]')!,
    )
    expect(
      isChecked(document.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-m0"]')!),
    ).toBe(true)
  })

  it('select-all-that-can-run checks exactly the non-disabled rows (EXAMPLE-UL-8)', () => {
    render(
      <Harness
        initial={new Set()}
        props={{
          rows: rows(20, 5),
          itemLabel: 'method',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    fireEvent.click(
      document.querySelector<HTMLElement>('[data-testid="txr-list-select-all-can-run"]')!,
    )
    expect(
      isChecked(document.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-m0"]')!),
    ).toBe(true)
    // The 5 cannot rows stay unchecked (m15..m19 in the 20-row fixture).
    expect(
      isChecked(document.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-m19"]')!),
    ).toBe(false)
  })
})

describe('TxrSelectList sections (INV-2 — EXAMPLE-UL-4)', () => {
  it('renders the runs as grouped headers with their rows, in host row order', () => {
    render(
      <Harness
        props={{
          rows: [...crcRows(), ...lungRows()],
          sections: [crcSection(), lungSection()],
          itemLabel: 'model',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-section-crc-day-56"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-list-section-crc-day-56"]')!.textContent).toContain(
      'trained 19 Oct on patients.csv',
    )
    expect(document.querySelector('[data-testid="txr-list-section-lung-day-42"]')).not.toBeNull()
    const order = [
      ...[
        '[data-testid="txr-list-section-crc-day-56"]',
        '[data-testid="txr-list-row-crc-0"]',
        '[data-testid="txr-list-section-lung-day-42"]',
        '[data-testid="txr-list-row-lung-1"]',
      ].map(id => document.querySelector<HTMLElement>(id)!),
    ]
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }
  })

  it('the section select-all toggles exactly the section\'s eligible rows, never the disabled', () => {
    render(
      <Harness
        initial={new Set()}
        props={{
          rows: [...crcRows(), ...lungRows()],
          sections: [crcSection(), lungSection()],
          itemLabel: 'model',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-testid="txr-list-section-select-all-crc-day-56"]',
      )!,
    )
    // The 9 eligible CRC rows are checked; the 2 disabled (crc-9, crc-10) and
    // the other group's rows never move (EXAMPLE-UL-4).
    expect(
      isChecked(document.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-crc-0"]')!),
    ).toBe(true)
    expect(
      isChecked(document.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-crc-9"]')!),
    ).toBe(false)
    expect(
      isChecked(document.querySelector<HTMLElement>('[data-testid="txr-list-checkbox-lung-1"]')!),
    ).toBe(false)
  })

  it('a section action fires onSectionAction(sectionKey, actionId)', () => {
    const onSectionAction = vi.fn()
    render(
      <Harness
        props={{
          rows: [...crcRows(), ...lungRows()],
          sections: [crcSection(), lungSection()],
          itemLabel: 'model',
          bottomBar: eBar(vi.fn()),
          onSectionAction,
        }}
      />,
    )
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-testid="txr-list-section-action-crc-day-56-delete"]',
      )!,
    )
    expect(onSectionAction).toHaveBeenCalledWith('crc-day-56', 'delete')
  })

  it('a section the host\'s filter emptied renders no header', () => {
    render(
      <Harness
        props={{
          // The host's search shows only the Lung group's rows.
          rows: lungRows(),
          sections: [crcSection(), lungSection()],
          itemLabel: 'model',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-section-crc-day-56"]')).toBeNull()
    expect(document.querySelector('[data-testid="txr-list-section-lung-day-42"]')).not.toBeNull()
  })

  it('the keyboard focus order is checkbox, then the action, then the next row', () => {
    const { getByTestId } = render(
      <Harness
        props={{
          rows: [row('m0'), row('m1')],
          itemLabel: 'method',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    const rowEl = getByTestId('txr-list-row-m0')
    const tabbables = [
      ...rowEl.querySelectorAll<HTMLElement>(
        '[data-testid="txr-list-checkbox-m0"], [data-testid="txr-list-row-m0-action"]',
      ),
    ]
    expect(tabbables).toHaveLength(2)
    expect(tabbables[0].getAttribute('data-testid')).toBe('txr-list-checkbox-m0')
    expect(tabbables[1].getAttribute('data-testid')).toBe('txr-list-row-m0-action')
    // The next row's checkbox follows this row in the DOM order.
    expect(
      rowEl.compareDocumentPosition(getByTestId('txr-list-checkbox-m1')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})

describe('TxrSelectList virtualization + states (TEST-UL-10)', () => {
  it('a 400-row fixture mounts only the windowed subset, not the whole set', () => {
    render(
      <Harness
        props={{
          rows: rows(400, 0),
          itemLabel: 'method',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    // A 1200px window of 56px rows is ~21 rows, plus the overscan on each side.
    // (Rows only — the action links carry the `txr-list-row-…` prefix too.)
    const mounted = document.querySelectorAll(
      '[data-testid^="txr-list-row-"]:not([data-testid$="-action"])',
    ).length
    expect(mounted).toBeGreaterThan(5)
    expect(mounted).toBeLessThanOrEqual(VIEWPORT_H / TXRLIST_ROW_HEIGHT + 6 * 2 + 2)
    // The far end of the set is NOT mounted yet.
    expect(document.querySelector('[data-testid="txr-list-row-m399"]')).toBeNull()
  })

  it('scrolling to the bottom mounts the far end of the set', () => {
    render(
      <Harness
        props={{
          rows: rows(400, 0),
          itemLabel: 'method',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    scrollTo(400 * TXRLIST_ROW_HEIGHT)
    expect(document.querySelector('[data-testid="txr-list-row-m399"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-list-row-m0"]')).toBeNull()
  })

  it('loading with no rows renders the skeleton stream and no rows', () => {
    render(
      <Harness
        props={{
          rows: [],
          itemLabel: 'method',
          loading: true,
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-loading"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-list-row-m0"]')).toBeNull()
  })

  it('error with no rows renders the error + a Retry that calls onRetry', () => {
    const onRetry = vi.fn()
    render(
      <Harness
        props={{
          rows: [],
          itemLabel: 'method',
          error: 'Failed to load methods',
          onRetry,
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-error"]')!.textContent).toContain(
      'Failed to load methods',
    )
    fireEvent.click(document.querySelector<HTMLElement>('[data-testid="txr-list-retry"]')!)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('error without an onRetry renders the message and no Retry button', () => {
    render(
      <Harness
        props={{
          rows: [],
          itemLabel: 'method',
          error: 'Failed to load methods',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-error"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-list-retry"]')).toBeNull()
    expect(document.querySelector('[data-testid="txr-list-loading"]')).toBeNull()
  })

  it('zero rows renders the empty state with emptyText (fallback: No <itemLabel>s to show)', () => {
    const { rerender } = render(
      <Harness
        props={{
          rows: [],
          itemLabel: 'method',
          emptyText: 'No methods match the filter',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-empty"]')!.textContent).toBe(
      'No methods match the filter',
    )
    rerender(
      <Harness
        props={{
          rows: [],
          itemLabel: 'method',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-empty"]')!.textContent).toBe(
      'No methods to show',
    )
  })

  it('a refetch (loading/error with rows kept) leaves the rows visible', () => {
    render(
      <Harness
        props={{
          rows: rows(3, 0),
          itemLabel: 'method',
          loading: true,
          error: 'Failed to load methods',
          bottomBar: eBar(vi.fn()),
        }}
      />,
    )
    expect(document.querySelector('[data-testid="txr-list-row-m0"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="txr-list-loading"]')).toBeNull()
    expect(document.querySelector('[data-testid="txr-list-error"]')).toBeNull()
  })
})
