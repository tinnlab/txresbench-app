// @vitest-environment jsdom
/**
 * TEST-RUN-22 — screen F's log panel (`components/TxrLogPanel.tsx`, ITEM-11;
 * PROV-UI-RUN-5's panel surface): the method filter — the BOARD's select
 * ("All methods" + one option per run method, qa-fixes ITEM-3 RP-4: the
 * one-chip-per-method pills stacked 209 chips for a 209-method run, so the
 * lines area started 3,600 px down the page), a chosen option filtering the
 * line list (the engine-level line with no method id belongs to the
 * whole-run view only, the sibling log dialog's rule), the per-row Show-log
 * handoff (open + filter = the method selected — the page's click wiring is
 * the page test's row), "Follow the newest line" pinning the scroll
 * (measured on the pre's scroll container ref — the JobDetail idiom the
 * sibling log dialog uses), "Copy the log" writing the panel's own display
 * text to the clipboard (`HH:MM:SS [method] content` per line — one
 * formatter for display and copy), the 200-line render cap with the
 * "Showing N of M lines" count, the empty-state line (never a blank box,
 * RP-4b), the backfill report on open / method switch (the host's
 * `loadLogs`, CONS-UI-RUN-10) and the Hide control reporting
 * `onOpenChange(false)`.
 *
 * The unread chip badge of the earlier pill idiom is deliberately gone:
 * the board's select carries no badge surface (the plate's logUnread note
 * dates the pill filter), DRIFT-1 ITEM-3 records the trade.
 *
 * Clipboard + scroll are mocked the sibling test's way (the G screen's log
 * dialog test): `navigator.clipboard` defined for the write, the pre's
 * `scrollHeight` defined for the pin. Timestamps pin `formatLogTime`'s
 * clock under a fixed UTC TZ (the board's "10:02:12" is the engine's
 * `created_at` as the machine clock reads it).
 */
process.env.TZ = 'UTC'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TxrRunLogLine } from '@/api-client/types'
import { TxrLogPanel, type TxrLogPanelProps } from './TxrLogPanel'

// jsdom has no working PointerEvent constructor; base-ui's controls (the
// kit Select / Switch) construct one on pointer interaction (the
// settings-block test's shim, copied).
{
  const w = window as unknown as {
    PointerEvent?: new (type: string, init?: MouseEventInit) => MouseEvent
  }
  try {
    void new (w.PointerEvent as new (type: string, init?: MouseEventInit) => MouseEvent)('probe')
  } catch {
    w.PointerEvent = class extends MouseEvent {}
  }
}

/** Click a kit control (base-ui commits on the pointer/click sequence). */
async function clickKit(target: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(target, { button: 0, pointerType: 'mouse' })
    fireEvent.click(target)
    await Promise.resolve()
  })
}

/** Open the filter's option list (the kit Select's trigger sequence). */
async function openFilter(): Promise<void> {
  await clickKit(screen.getByTestId('txr-run-log-filter'))
}

/** Pick one option of the filter (the option's pointer/click sequence). */
async function pickFilter(optionId: string): Promise<void> {
  const option = await screen.findByTestId(optionId)
  await act(async () => {
    fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(option, { button: 0 })
    fireEvent.click(option)
    await Promise.resolve()
  })
}

/** The panel's run rows — one per option, INCLUDING a method with no line. */
const METHODS = [
  { method_id: 'dynforest', label: 'dynforest' },
  { method_id: 'flirti', label: 'flirti' },
  { method_id: 'baseline-cox', label: 'baseline-cox' },
]

function line(
  seq: number,
  method_id: string | undefined,
  content: string,
  createdAt = '2026-11-06T10:02:00Z',
): TxrRunLogLine {
  return { seq, method_id, stream: method_id === undefined ? 'engine' : 'stdout', content, created_at: createdAt }
}

/** The fixture tail, seq-ascending as the store's tail is (each run method + one engine-level line). */
const LINES: TxrRunLogLine[] = [
  line(1, 'dynforest', 'fitting on 151 patients', '2026-11-06T10:02:12Z'),
  line(2, 'flirti', 'downloading 160 of 250 MB', '2026-11-06T10:02:13Z'),
  line(3, 'baseline-cox', 'not selected', '2026-11-06T10:02:14Z'),
  line(4, undefined, 'run started', '2026-11-06T10:02:15Z'),
]

function makeProps(over: Partial<TxrLogPanelProps> = {}): TxrLogPanelProps {
  return {
    lines: LINES,
    total: 4,
    methods: METHODS,
    filter: null,
    onFilter: vi.fn(),
    follow: true,
    onFollow: vi.fn(),
    open: true,
    onOpenChange: vi.fn(),
    onBackfill: vi.fn(),
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrLogPanel (TEST-RUN-22)', () => {
  it('renders "All methods" plus one option per run METHOD (not per line occurrence)', async () => {
    render(<TxrLogPanel {...makeProps()} />)
    // The trigger reads the selected option's label — the All view first.
    expect(screen.getByTestId('txr-run-log-filter').textContent).toContain('All methods')
    await openFilter()
    expect(screen.getByTestId('txr-run-log-filter-opt-all')).toBeTruthy()
    expect(screen.getByTestId('txr-run-log-filter-opt-dynforest')).toBeTruthy()
    expect(screen.getByTestId('txr-run-log-filter-opt-flirti')).toBeTruthy()
    expect(screen.getByTestId('txr-run-log-filter-opt-baseline-cox')).toBeTruthy()
  })

  it('an option filters the line list; the engine-level line belongs to All only', async () => {
    const props = makeProps()
    const view = render(<TxrLogPanel {...props} />)
    const pre = screen.getByTestId('txr-run-log-lines')
    // All: every line, engine-level line included ("[engine] run started").
    expect(pre.textContent).toContain('[engine] run started')
    expect(props.onFilter).not.toHaveBeenCalled()

    await openFilter()
    await pickFilter('txr-run-log-filter-opt-flirti')
    expect(props.onFilter).toHaveBeenCalledWith('flirti')

    // The store's filter took effect (the host set it — direct re-render):
    await act(async () => {
      view.rerender(<TxrLogPanel {...props} filter="flirti" />)
      await Promise.resolve()
    })
    expect(pre.textContent).toContain('[flirti] downloading 160 of 250 MB')
    expect(pre.textContent).not.toContain('[dynforest]')
    expect(pre.textContent).not.toContain('run started')
    expect(screen.getByTestId('txr-run-log-filter').textContent).toContain('flirti')
  })

  it('the per-row Show-log state opens the panel at that method (the option selected, that method\'s lines)', () => {
    // The page's click wiring is the page test's row; the panel's own half:
    // given open + filter, the method's option is selected and its lines show.
    render(<TxrLogPanel {...makeProps({ filter: 'dynforest' })} />)
    expect(screen.getByTestId('txr-run-log-filter').textContent).toContain('dynforest')
    expect(screen.getByTestId('txr-run-log-lines').textContent).toContain(
      '[dynforest] fitting on 151 patients',
    )
  })

  it('reports the backfill on open and on a method switch (the CONS-UI-RUN-10 consume)', async () => {
    const props = makeProps()
    const view = render(<TxrLogPanel {...props} />)
    expect(props.onBackfill).toHaveBeenCalledTimes(1)
    expect(props.onBackfill).toHaveBeenCalledWith(null)

    await act(async () => {
      view.rerender(<TxrLogPanel {...props} filter="dynforest" />)
      await Promise.resolve()
    })
    expect(props.onBackfill).toHaveBeenCalledTimes(2)
    expect(props.onBackfill).toHaveBeenLastCalledWith('dynforest')
  })

  it('"Follow the newest line" pins the scroll container at the newest line', async () => {
    const props = makeProps()
    const view = render(<TxrLogPanel {...props} />)
    const pre = screen.getByTestId('txr-run-log-lines') as HTMLPreElement
    Object.defineProperty(pre, 'scrollHeight', { value: 700, configurable: true })

    await act(async () => {
      view.rerender(
        <TxrLogPanel {...props} lines={[...LINES, line(5, 'dynforest', 'tree 140 of 500')]} />,
      )
      await Promise.resolve()
    })
    await waitFor(() => expect(pre.scrollTop).toBe(700))
  })

  it('does not pin the scroll while following is off', async () => {
    const props = makeProps({ follow: false })
    const view = render(<TxrLogPanel {...props} />)
    const pre = screen.getByTestId('txr-run-log-lines') as HTMLPreElement
    Object.defineProperty(pre, 'scrollHeight', { value: 700, configurable: true })
    pre.scrollTop = 42

    await act(async () => {
      view.rerender(
        <TxrLogPanel {...props} lines={[...LINES, line(5, 'dynforest', 'tree 140 of 500')]} />,
      )
      await Promise.resolve()
    })
    expect(pre.scrollTop).toBe(42)
  })

  it('reports the follow switch (kit Switch, controlled by the store value)', async () => {
    const props = makeProps({ follow: true })
    render(<TxrLogPanel {...props} />)
    await clickKit(screen.getByTestId('txr-run-log-follow'))
    expect(props.onFollow).toHaveBeenCalledTimes(1)
    expect(props.onFollow).toHaveBeenCalledWith(false)
  })

  it('"Copy the log" writes the panel\'s display text (HH:MM:SS [method] content rows) to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<TxrLogPanel {...makeProps()} />)
    fireEvent.click(screen.getByTestId('txr-run-log-copy'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        [
          '10:02:12 [dynforest] fitting on 151 patients',
          '10:02:13 [flirti] downloading 160 of 250 MB',
          '10:02:14 [baseline-cox] not selected',
          '10:02:15 [engine] run started',
        ].join('\n'),
      ),
    )
  })

  it('copies the FILTERED lines when a method is showing', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<TxrLogPanel {...makeProps({ filter: 'flirti' })} />)
    fireEvent.click(screen.getByTestId('txr-run-log-copy'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('10:02:13 [flirti] downloading 160 of 250 MB'),
    )
  })

  it('caps the rendered lines at 200 and shows the count', () => {
    const many: TxrRunLogLine[] = []
    for (let i = 1; i <= 250; i += 1) {
      many.push(line(i, 'dynforest', `entry-${String(i).padStart(3, '0')}`))
    }
    render(<TxrLogPanel {...makeProps({ lines: many, total: 250 })} />)
    const pre = screen.getByTestId('txr-run-log-lines')
    // The oldest 50 lines are outside the render cap; the newest showed.
    expect(pre.textContent).not.toContain('entry-050')
    expect(pre.textContent).toContain('entry-051')
    expect(pre.textContent).toContain('entry-250')
    expect(pre.textContent!.split('\n')).toHaveLength(200)
    expect(screen.getByTestId('txr-run-log-count').textContent).toBe('Showing 200 of 250 lines')
  })

  it('shows the count line from the engine total (a small tail reads "Showing N of M lines")', () => {
    render(<TxrLogPanel {...makeProps()} />)
    expect(screen.getByTestId('txr-run-log-count').textContent).toBe('Showing 4 of 4 lines')
  })

  it('an empty lines area reads its state line — never a blank box (RP-4b)', () => {
    cleanup()
    render(<TxrLogPanel {...makeProps({ lines: [], total: 0 })} />)
    expect(screen.getByTestId('txr-run-log-lines').textContent).toBe('No log lines yet.')
    expect(screen.queryByTestId('txr-run-log-count')).toBeNull()

    cleanup()
    render(<TxrLogPanel {...makeProps({ lines: [], total: 0, filter: 'flirti' })} />)
    expect(screen.getByTestId('txr-run-log-lines').textContent).toBe(
      'No log lines for this method.',
    )
  })

  it('the Hide control reports onOpenChange(false) once', async () => {
    const props = makeProps()
    render(<TxrLogPanel {...props} />)
    fireEvent.click(screen.getByTestId('txr-run-log-close'))
    expect(props.onOpenChange).toHaveBeenCalledTimes(1)
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
