// @vitest-environment jsdom
/**
 * TEST-HIST-7 — the K components (ITEM-4; PROV-HIST-5, INV-1/2/3/5/6/7):
 * one spec, six suites — `TxrHistoryToolbar` / `TxrHistoryList` (+ the
 * empty/error/loading states) / `TxrHistoryCard` / `TxrHistoryDetailBlock`
 * / `TxrHistoryFooter` / `TxrHistoryActions` + `TxrHistoryLogDialog` +
 * `TxrConfirmDialog`.
 *
 * The components are pure-presentational: the page (ITEM-5) owns the
 * store calls and the builders' navigations, so every callback here is a
 * spy and the detail is a prop (the plan's "store seeded" reading is the
 * store's data flowing INTO these props — the store's own assertions are
 * TEST-HIST-2/3/4). Fixtures are synthetic (ids `run-1`/`method-a`,
 * non-board counts — the boards' facts are design examples, never data,
 * INV-6), and every expected string is BUILT from the fixture numbers,
 * never from the boards.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  TxrHistoryDetail,
  TxrHistoryItem,
  TxrHistoryPreferences,
  TxrHistoryUsage,
  TxrRunCounts,
  TxrRunLogLine,
} from '@/api-client/types'
import { formatDate } from '../lib/format'
import { TxrHistoryToolbar } from './TxrHistoryToolbar'
import { TxrHistoryList } from './TxrHistoryList'
import { TxrHistoryCard } from './TxrHistoryCard'
import {
  TxrHistoryDetailBlock,
  formatMethodDuration,
  madeFactsOf,
  methodRow,
  settingsLine,
  TxrMadeFacts,
} from './TxrHistoryDetailBlock'
import { subtitleFor } from './TxrHistoryCard'
import { TxrHistoryFooter } from './TxrHistoryFooter'
import { TxrHistoryActions } from './TxrHistoryActions'
import { TxrHistoryLogDialog, logTextOf } from './TxrHistoryLogDialog'
import { TxrConfirmDialog } from './TxrConfirmDialog'

// jsdom gaps the kit's base-ui controls probe at mount (the
// TxrListFilterBar test's beforeAll — Select arms need PointerEvent +
// ResizeObserver).
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
  if (typeof globalThis.Element !== 'undefined' && !globalThis.Element.prototype.scrollIntoView) {
    globalThis.Element.prototype.scrollIntoView = () => {}
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ── Synthetic fixtures (INV-6: non-board ids, counts and names) ─────────────

function item(id: string, over: Partial<TxrHistoryItem> = {}): TxrHistoryItem {
  return {
    id,
    bucket: 'finished',
    counts: { finished: 3, failed: 0, stopped: 0, skipped: 0, cannot_run: 0, running: 0, downloading: 0, waiting: 0 },
    mode: 'train',
    created_at: '2026-11-01T05:00:00Z',
    method_count: 3,
    file_names: ['patients.csv', 'new_measurements.csv'],
    learned_from: 41,
    predicted: 12,
    endpoint: 'pfs',
    decision_day: 42,
    look_ahead_day: 180,
    methods: [
      { id: 'method-a', version: '1.0.0', elapsed_secs: 95 },
      { id: 'method-b', version: '2.1.0', elapsed_secs: 120 },
      { id: 'method-c', version: '0.9.0', elapsed_secs: 45 },
    ],
    models_made: { produced: 2, saved_sets: [] },
    models_used: [],
    markers: 5,
    markers_saved: false,
    copies_kept: true,
    can_rerun: true,
    can_reopen: true,
    can_download: true,
    dir: '/data/txresbench/analysis-2026-11-01-run-1',
    ...over,
  }
}

function detail(id: string, over: Partial<TxrHistoryDetail> = {}): TxrHistoryDetail {
  return {
    id,
    bucket: 'finished',
    mode: 'train',
    created_at: '2026-11-01T05:00:00Z',
    method_count: 3,
    file_names: ['patients.csv', 'new_measurements.csv'],
    learned_from: 41,
    predicted: 12,
    endpoint: 'pfs',
    decision_day: 42,
    look_ahead_day: 180,
    methods: [
      {
        method_id: 'method-a',
        label: 'method-a',
        group: 'dynamic_risk',
        group_label: 'Dynamic risk',
        version: '1.0.0',
        state: 'finished',
        bytes_downloaded: 0,
        elapsed_secs: 95,
      },
      {
        method_id: 'method-b',
        label: 'method-b',
        group: 'static_risk',
        group_label: 'Static risk',
        version: '2.1.0',
        state: 'finished',
        bytes_downloaded: 0,
        elapsed_secs: 120,
      },
      {
        method_id: 'method-c',
        label: 'method-c',
        group: 'response_call',
        group_label: 'Response call',
        version: '0.9.0',
        state: 'finished',
        bytes_downloaded: 0,
        elapsed_secs: 45,
      },
    ],
    models_made: { produced: 2, saved_sets: [] },
    models_saved: [],
    models_used: [],
    markers: 5,
    markers_saved: false,
    copies_kept: true,
    copies: { kept: true },
    file_sizes: [],
    log_line_count: 7,
    can_rerun: true,
    can_reopen: true,
    can_download: true,
    dir: '/data/txresbench/analysis-2026-11-01-run-1',
    settings: {
      endpoint: 'pfs',
      decision_day: 42,
      look_ahead_day: 180,
      covariates: true,
      at_a_time: 2,
      cpus: 4,
      save_models: false,
      mode: 'train',
      seed: 7,
      memory_total_bytes: 16 * 1024 * 1024 * 1024,
    },
    ...over,
  }
}

function usage(over: Partial<TxrHistoryUsage> = {}): TxrHistoryUsage {
  return {
    run_count: 3,
    total_bytes: 327 * 1024 * 1024,
    runs_bytes: 200 * 1024 * 1024,
    models_bytes: 100 * 1024 * 1024,
    other_bytes: 27 * 1024 * 1024,
    computed_at: '2026-11-01T05:00:00Z',
    data_dir: '/data/txresbench',
    ...over,
  }
}

function logLine(seq: number, content = `line ${seq}`): TxrRunLogLine {
  return { seq, content, stream: 'stdout', created_at: '2026-11-01T05:00:00Z' }
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

function listProps(over: Partial<Parameters<typeof TxrHistoryList>[0]> = {}) {
  const items = [item('run-2'), item('run-1')]
  return {
    items,
    total: 2,
    loading: false,
    loadingMore: false,
    error: null as 'network' | null,
    search: '',
    filter: 'all' as 'all' | 'learned' | 'saved-model' | 'stopped-failed',
    expandedId: null as string | null,
    detail: null as TxrHistoryDetail | null,
    detailLoading: false,
    isDesktop: true,
    onToggle: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    onOpenResults: vi.fn(),
    onOpenRunning: vi.fn(),
    onRerun: vi.fn(),
    onSettingsAgain: vi.fn(),
    onDownload: vi.fn(),
    onReveal: vi.fn(),
    onLog: vi.fn(),
    onOpenSet: vi.fn(),
    ...over,
  }
}

describe('TxrHistoryToolbar (TEST-HIST-7 — title, subtitle, search, filter)', () => {
  it('renders the board title + the permanent subtitle (the lib copy constant)', () => {
    const view = render(
      <TxrHistoryToolbar search="" filter="all" onSearch={vi.fn()} onFilter={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-title').textContent).toBe('History')
    expect(view.getByTestId('txr-history-subtitle').textContent).toBe(
      'Everything you ran, newest first. Open a result again, or run it again with the same settings.',
    )
  })

  it('renders the search box with the board hint + accessible name and reports keystrokes', () => {
    const onSearch = vi.fn()
    const view = render(
      <TxrHistoryToolbar search="" filter="all" onSearch={onSearch} onFilter={vi.fn()} />,
    )
    const input = view.getByTestId('txr-history-search') as HTMLInputElement
    expect(input.getAttribute('placeholder')).toBe('Search by file, method or model')
    expect(input.getAttribute('aria-label')).toBe('Search the history')
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: 'cox-cutpoint' } })
    expect(onSearch).toHaveBeenCalledWith('cox-cutpoint')
  })

  it('renders the four board filter options and reports the picked one', async () => {
    const onFilter = vi.fn()
    render(<TxrHistoryToolbar search="" filter="all" onSearch={vi.fn()} onFilter={onFilter} />)
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-history-filter"]')!
    expect(trigger.textContent).toContain('All runs')
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const stopped = document.querySelector<HTMLElement>(
      '[role="option"][data-testid="txr-history-filter-opt-stopped-failed"]',
    )!
    expect(stopped.textContent).toBe('Stopped or failed')
    // base-ui commits a select on the pointer/click sequence (the
    // TxrListFilterBar sort test's measured sequence).
    await act(async () => {
      fireEvent.pointerDown(stopped, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(stopped, { button: 0 })
      fireEvent.click(stopped)
      await Promise.resolve()
    })
    expect(onFilter).toHaveBeenCalledWith('stopped-failed')
  })
})

describe('TxrHistoryList (TEST-HIST-7 — cards, empty, error, load more)', () => {
  it('renders the cards in the given (server) order, newest first', () => {
    const props = listProps()
    const view = render(<TxrHistoryList {...props} />)
    expect(view.getByTestId('txr-history-list')).toBeTruthy()
    const rows = view.getAllByTestId(/^txr-history-row-/).map(el => el.getAttribute('data-testid'))
    expect(rows).toEqual(['txr-history-row-run-2', 'txr-history-row-run-1'])
  })

  it('renders the empty state when the loaded page set is empty', () => {
    const view = render(<TxrHistoryList {...listProps({ items: [], total: 0 })} />)
    expect(view.getByTestId('txr-history-empty').textContent).toContain('Nothing here yet')
    expect(view.getByTestId('txr-history-empty').textContent).toContain(
      'Runs you start appear here, newest first.',
    )
  })

  // R3-results-5: a search (or filter) with no match names the restriction —
  // the fresh-history promise is not the story next to a query the user typed.
  it('names the query when a search matches nothing (R3-results-5)', () => {
    const view = render(
      <TxrHistoryList {...listProps({ items: [], total: 0, search: 'zzzz' })} />,
    )
    expect(view.getByTestId('txr-history-empty').textContent).toContain("No run matches 'zzzz'")
    expect(view.getByTestId('txr-history-empty').textContent).not.toContain('Nothing here yet')
  })

  it('names the filter when a filter matches nothing (R3-results-5)', () => {
    const view = render(
      <TxrHistoryList {...listProps({ items: [], total: 0, filter: 'stopped-failed' })} />,
    )
    expect(view.getByTestId('txr-history-empty').textContent).toContain(
      "No runs match 'Stopped or failed'",
    )
    expect(view.getByTestId('txr-history-empty').textContent).not.toContain('Nothing here yet')
  })

  it('renders the failure state with a Retry that refires, never a blank page', () => {
    const onRetry = vi.fn()
    const view = render(<TxrHistoryList {...listProps({ error: 'network', onRetry })} />)
    expect(view.getByTestId('txr-history-error').textContent).toContain(
      'Could not load the history.',
    )
    fireEvent.click(view.getByTestId('txr-history-error-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('paints the loading skeleton on the first page (no empty flash)', () => {
    const view = render(
      <TxrHistoryList {...listProps({ items: [], total: 0, loading: true })} />,
    )
    expect(view.getByTestId('txr-history-loading')).toBeTruthy()
    expect(view.queryByTestId('txr-history-empty')).toBeNull()
  })

  it('Load more is shown exactly while items.length < total and reports the continuation', () => {
    const props = listProps({ items: [item('run-1')], total: 25 })
    const view = render(<TxrHistoryList {...props} />)
    const loadMore = view.getByTestId('txr-history-load-more')
    expect(loadMore.textContent).toBe('Load more')
    fireEvent.click(loadMore)
    expect(props.onLoadMore).toHaveBeenCalledTimes(1)
    cleanup()
    const full = render(<TxrHistoryList {...listProps({ items: [item('run-1')], total: 1 })} />)
    expect(full.queryByTestId('txr-history-load-more')).toBeNull()
  })

  it('passes the seeded detail to the expanded card only (one expanded row at a time)', () => {
    const seeded = detail('run-2', {
      models_made: {
        produced: 2,
        saved_sets: [
          { set_id: 'set-a', set_name: 'Set one', model_count: 1 },
          { set_id: 'set-b', set_name: 'Set two', model_count: 0 },
        ],
      },
    })
    const props = listProps({
      items: [item('run-2'), item('run-1')],
      expandedId: 'run-2',
      detail: seeded,
    })
    const view = render(<TxrHistoryList {...props} />)
    expect(view.getByTestId('txr-history-detail-run-2')).toBeTruthy()
    expect(view.queryByTestId('txr-history-detail-run-1')).toBeNull()
  })
})

describe('TxrHistoryCard (TEST-HIST-7 — the collapsed row and the expanded block host)', () => {
  it('renders title, subtitle, chip, status, date and the toggle with its test-id', () => {
    const view = render(
      <TxrHistoryCard item={item('run-1')} expanded={false} detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    const row = view.getByTestId('txr-history-row-run-1')
    expect(within(row).getByTestId('txr-history-subtitle-run-1').textContent).toBe(
      'method-a, method-b, method-c · learned from 41 patients, predicted 12 · decision day 42 · progression, death by day 180',
    )
    const chip = within(row).getByTestId('txr-history-chip-run-1')
    expect(chip.textContent).toBe('Learned and predicted')
    expect(colorHex(chip.style.background)).toBe('var(--txr-accent-soft)')
    expect(colorHex(chip.style.color)).toBe('var(--txr-brand-ink)')
    expect(within(row).getByTestId('txr-history-status-run-1').textContent).toBe('Done')
    expect(within(row).getByTestId('txr-history-status-run-1').style.color).not.toBe('')
    const toggle = within(row).getByTestId('txr-history-toggle-run-1')
    expect(toggle.textContent).toBe('Show details')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders the board date line through the lib formatter (created_at)', () => {
    const created = '2026-11-01T05:00:00Z'
    const view = render(
      <TxrHistoryCard item={item('run-1', { created_at: created })} expanded={false} detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-row-run-1').textContent).toContain(formatDate(created))
  })

  it('reports the toggle and flips the words + the expanded border', () => {
    const onToggle = vi.fn()
    const view = render(
      <TxrHistoryCard item={item('run-1')} expanded detail={detail('run-1')} detailLoading={false} isDesktop onToggle={onToggle} />,
    )
    const toggle = view.getByTestId('txr-history-toggle-run-1')
    expect(toggle.textContent).toBe('Hide details')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith('run-1')
  })

  it('a stopped row reads the red reason line instead of the facts line (verbatim detail)', () => {
    const stopped = item('run-1', {
      bucket: 'stopped',
      counts: { ...(item('x').counts as unknown as TxrRunCounts), stopped: 1 },
      reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'marker LDH is missing from the measurements' },
    })
    const view = render(
      <TxrHistoryCard item={stopped} expanded={false} detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    const line = view.getByTestId('txr-history-subtitle-run-1')
    expect(line.textContent).toBe('Stopped: marker LDH is missing from the measurements')
    expect(colorHex(line.style.color)).toBe('var(--txr-danger)')
    // qa-fixes4 ITEM-2 (a): a stopped run reads the truthful stop word.
    expect(view.getByTestId('txr-history-status-run-1').textContent).toBe('Stopped by you')
    expect(view.getByTestId('txr-history-status-run-1').style.color).toBe('var(--txr-muted)')
  })

  it('ITEM-2 (R3-results-3): a partial run (3 of 5 failed) reads the truthful status and the one-line reason', () => {
    const partial = item('run-1', {
      counts: { ...(item('x').counts as unknown as TxrRunCounts), finished: 2, failed: 3 },
      method_count: 5,
      can_reopen: true,
      reason: {
        code: 'BUNDLE_MARKER_COUNT_UNMET',
        detail: 'the method needs a different number of markers than the file has',
      },
    })
    const view = render(
      <TxrHistoryCard item={partial} expanded={false} detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-status-run-1').textContent).toBe(
      'Done, 3 of 5 methods failed',
    )
    expect(view.getByTestId('txr-history-status-run-1').style.color).toBe('var(--txr-warning)')
    expect(view.getByTestId('txr-history-subtitle-run-1').textContent).toBe(
      'Failed: the method needs a different number of markers than the file has',
    )
    expect(colorHex(view.getByTestId('txr-history-subtitle-run-1').style.color)).toBe('var(--txr-danger)')
  })

  it('ITEM-2: the 203-of-209 cannot-run run and the Stop-all run name their counts', () => {
    const many = item('run-1', {
      counts: { ...(item('x').counts as unknown as TxrRunCounts), finished: 6, cannot_run: 203 },
      method_count: 209,
    })
    const viewMany = render(
      <TxrHistoryCard item={many} expanded={false} detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    expect(viewMany.getByTestId('txr-history-status-run-1').textContent).toBe(
      'Done, 203 of 209 methods could not run',
    )
    cleanup()

    const stopAll = item('run-1', {
      bucket: 'stopped',
      counts: { ...(item('x').counts as unknown as TxrRunCounts), stopped: 4, skipped: 2 },
      method_count: 6,
      reason: { code: 'ABORTED', detail: 'stopped by the user' },
    })
    const viewStop = render(
      <TxrHistoryCard item={stopAll} expanded={false} detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    expect(viewStop.getByTestId('txr-history-status-run-1').textContent).toBe('Stopped by you (2 skipped)')
  })

  it('a reuse run reads the neutral chip + the Predicted line', () => {
    const reuse = item('run-1', {
      mode: 'reuse',
      models_made: { produced: 0, saved_sets: [] },
      models_used: [
        { set_id: 'set-a', set_name: 'Set one', model_id: 'model-1', model_name: 'Model one' },
      ],
      method_count: 1,
      methods: [{ id: 'method-a', version: '1.0.0', elapsed_secs: 60 }],
    })
    const view = render(
      <TxrHistoryCard item={reuse} expanded={false} detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-row-run-1').textContent).toContain(
      'Model Set one on patients.csv + new_measurements.csv',
    )
    const chip = view.getByTestId('txr-history-chip-run-1')
    expect(chip.textContent).toBe('Saved model')
    expect(colorHex(chip.style.background)).toBe('var(--txr-success-soft)')
    expect(colorHex(chip.style.color)).toBe('var(--txr-success-ink)')
    // The reuse subtitle: the consumed models' NAMES (R2-04 — the raw
    // method ids were the model uuids), the capital-P Predicted line +
    // the endpoint line.
    expect(view.getByTestId('txr-history-subtitle-run-1').textContent).toBe(
      'Model one · Predicted 12 patients · progression, death by day 180',
    )
  })

  it('shows the loading skeleton while the detail is on its way, then the block', () => {
    const view = render(
      <TxrHistoryCard item={item('run-1')} expanded detail={null} detailLoading isDesktop onToggle={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-detail-loading-run-1')).toBeTruthy()
    expect(view.queryByTestId('txr-history-detail-run-1')).toBeNull()
  })

  it('a failed detail leaves the card with its collapsed data (never a crash, never a fake block)', () => {
    const view = render(
      <TxrHistoryCard item={item('run-1')} expanded detail={null} detailLoading={false} isDesktop onToggle={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-row-run-1')).toBeTruthy()
    expect(view.queryByTestId('txr-history-detail-run-1')).toBeNull()
    expect(view.getByTestId('txr-history-toggle-run-1').textContent).toBe('Hide details')
  })
})

describe('TxrHistoryDetailBlock + the composition helpers (TEST-HIST-7 — the five dl rows)', () => {
  const blockProps = (d: TxrHistoryDetail) => ({
    detail: d,
    isDesktop: true,
    onOpenResults: vi.fn(),
    onOpenRunning: vi.fn(),
    onRerun: vi.fn(),
    onSettingsAgain: vi.fn(),
    onDownload: vi.fn(),
    onReveal: vi.fn(),
    onLog: vi.fn(),
    onOpenSet: vi.fn(),
  })

  it('renders the five dl rows with the board shapes (files + note, settings, methods, took, made)', () => {
    const d = detail('run-1', {
      elapsed_secs: 190,
      use_estimate: { estimate_quality: 'measured', total_seconds: 240 },
      models_made: {
        produced: 2,
        saved_sets: [{ set_id: 'set-a', set_name: 'Set one', model_count: 1 }],
      },
    })
    const view = render(<TxrHistoryDetailBlock {...blockProps(d)} />)
    const block = view.getByTestId('txr-history-detail-run-1')
    // Your files + the copies note (copies kept).
    expect(block.textContent).toContain('patients.csv, new_measurements.csv')
    expect(block.textContent).toContain('Copies are kept with this run so it can be repeated.')
    // Settings: the board's comma sentence from the fixture facts. The
    // host-memory segment is gone (qa-fixes2 R2-09: the run record carries
    // no memory setting — the old "16 GB" was the machine's RAM).
    expect(block.textContent).toContain(
      'landmark 42, horizon 180, covariates on, seed 7, 4 CPUs',
    )
    expect(block.textContent).not.toContain('GB')
    // Methods: "<label> <version> (<duration>)" — the compact row words.
    expect(block.textContent).toContain('method-a 1.0.0 (2 min)')
    expect(block.textContent).toContain('method-b 2.1.0 (2 min)')
    expect(block.textContent).toContain('method-c 0.9.0 (under a minute)')
    // Took: the word form + the estimate parenthetical.
    expect(block.textContent).toContain('3 minutes 10 seconds (estimated 4 minutes)')
    // Made: the board's "N models (set and one more) and the predictions of both".
    expect(block.textContent).toContain('2 models')
    const setLink = view.getByTestId('txr-history-model-set-set-a')
    expect(setLink.textContent).toBe('Set one')
    expect(block.textContent).toContain('Set one and one more) and the predictions of both')
  })

  it('the made row uses the board words only at the two-model shape; other counts stay honest', () => {
    const facts = madeFactsOf(
      detail('run-9', {
        predicted: 7,
        models_made: {
          produced: 1,
          saved_sets: [{ set_id: 'set-a', set_name: 'Set one', model_count: 1 }],
        },
      }),
    )!
    expect(facts.count).toBe(1)
    // Single produced model: no "both" tail (a false word).
    const singleBlock = detail('run-9', {
      predicted: 7,
      models_made: {
        produced: 1,
        saved_sets: [{ set_id: 'set-a', set_name: 'Set one', model_count: 1 }],
      },
    })
    const single = render(<TxrHistoryDetailBlock {...blockProps(singleBlock)} />)
    expect(single.getByTestId('txr-history-detail-run-9').textContent).toContain('1 model')
    expect(single.getByTestId('txr-history-detail-run-9').textContent).not.toContain(
      'and the predictions of both',
    )
  })

  it('a copy-cleared run reads the honest negation (the copies state is stated both ways)', () => {
    const cleared = detail('run-1', { copies: { kept: false }, copies_kept: false })
    const view = render(<TxrHistoryDetailBlock {...blockProps(cleared)} />)
    expect(view.getByTestId('txr-history-detail-run-1').textContent).toContain(
      'Copies are not kept with this run.',
    )
    expect(view.getByTestId('txr-history-detail-run-1').textContent).not.toContain(
      'Copies are kept with this run so it can be repeated.',
    )
  })

  it('the made row omits when the run made no models; a set link reports its setId', () => {
    const d = detail('run-1', { models_made: { produced: 0, saved_sets: [] } })
    const view = render(<TxrHistoryDetailBlock {...blockProps(d)} />)
    expect(view.getByTestId('txr-history-detail-run-1').textContent).not.toContain('models')
    cleanup()
    const onOpenSet = vi.fn()
    const withSet = detail('run-1', {
      models_made: {
        produced: 3,
        saved_sets: [
          { set_id: 'set-a', set_name: 'Set one', model_count: 1 },
          { set_id: 'set-b', set_name: 'Set two', model_count: 1 },
        ],
      },
    })
    const view2 = render(
      <TxrHistoryDetailBlock {...blockProps(withSet)} onOpenSet={onOpenSet} />,
    )
    expect(view2.getByTestId('txr-history-detail-run-1').textContent).toContain(
      '3 models (Set one, Set two and one more)',
    )
    fireEvent.click(view2.getByTestId('txr-history-model-set-set-b'))
    expect(onOpenSet).toHaveBeenCalledWith('set-b')
  })

  it('the settings line omits each absent segment (optional facts never fabricated)', () => {
    const sparse = detail('run-1', {
      settings: {
        ...detail('run-1').settings,
        cpus: undefined,
        seed: undefined,
        memory_total_bytes: undefined,
        covariates: false,
      },
    })
    const view = render(<TxrHistoryDetailBlock {...blockProps(sparse)} />)
    expect(view.getByTestId('txr-history-detail-run-1').textContent).toContain(
      'landmark 42, horizon 180, covariates off',
    )
    expect(view.getByTestId('txr-history-detail-run-1').textContent).not.toContain('CPUs')
    expect(view.getByTestId('txr-history-detail-run-1').textContent).not.toContain('seed')
    expect(view.getByTestId('txr-history-detail-run-1').textContent).not.toContain('GB')
  })

  it('the composition helpers: durations, settings, method rows, made facts', () => {
    expect(formatMethodDuration(120)).toBe('2 min')
    expect(formatMethodDuration(95)).toBe('2 min')
    expect(formatMethodDuration(45)).toBe('under a minute')
    expect(formatMethodDuration(42)).toBe('under a minute')
    expect(formatMethodDuration(undefined)).toBeNull()
    expect(
      settingsLine(detail('run-1').settings),
    ).toBe('landmark 42, horizon 180, covariates on, seed 7, 4 CPUs')
    expect(methodRow(detail('run-1').methods[0])).toBe('method-a 1.0.0 (2 min)')
    expect(
      methodRow({ ...detail('run-1').methods[0], elapsed_secs: undefined }),
    ).toBe('method-a 1.0.0')
    const facts: TxrMadeFacts = madeFactsOf(
      detail('run-1', {
        predicted: 12,
        models_made: { produced: 2, saved_sets: [{ set_id: 's', set_name: 'Set one', model_count: 1 }] },
      }),
    )!
    expect(facts.count).toBe(2)
    expect(facts.remainder).toBe(1)
    expect(facts.hasPredictions).toBe(true)
    expect(madeFactsOf(detail('run-1', { models_made: { produced: 0, saved_sets: [] } }))).toBeNull()
  })

  it('the card subtitle helper: one-method train runs omit the method segment (the board shape)', () => {
    const one = item('run-1', {
      methods: [{ id: 'method-a', version: '1.0.0', elapsed_secs: 60 }],
      method_count: 1,
    })
    expect(subtitleFor(one)).toBe(
      'learned from 41 patients, predicted 12 · decision day 42 · progression, death by day 180',
    )
    // A row with no recorded learned/predicted facts keeps decision + endpoint.
    const sparse = item('run-1', {
      learned_from: undefined,
      predicted: undefined,
      methods: [{ id: 'method-a', version: '1.0.0', elapsed_secs: 60 }],
    })
    expect(subtitleFor(sparse)).toBe('decision day 42 · progression, death by day 180')
    // The wire's `null` IS the generator's "no property" (RES-01): a null
    // learned/predicted fact omits its segment — never "learned from null
    // patients" / "predicted null".
    const nullFacts = item('run-1', {
      learned_from: null as unknown as number,
      predicted: null as unknown as number,
      methods: [{ id: 'method-a', version: '1.0.0', elapsed_secs: 60 }],
    })
    expect(subtitleFor(nullFacts)).toBe('decision day 42 · progression, death by day 180')
    const nullReuse = item('run-1', {
      mode: 'reuse',
      predicted: null as unknown as number,
      methods: [{ id: 'method-a', version: '1.0.0', elapsed_secs: 60 }],
    })
    expect(subtitleFor(nullReuse)).toBe('progression, death by day 180')
  })

  it('the settings line: a null optional fact omits its segment — never "seed null" or "null CPUs" (RES-01)', () => {
    const settings = detail('run-1', {
      settings: {
        endpoint: 'pfs',
        decision_day: 42,
        look_ahead_day: 180,
        covariates: true,
        at_a_time: 2,
        cpus: 4,
        save_models: false,
        mode: 'train',
        seed: 7,
        memory_total_bytes: 16 * 1024 * 1024 * 1024,
      },
    }).settings
    expect(settingsLine(settings)).toBe(
      'landmark 42, horizon 180, covariates on, seed 7, 4 CPUs',
    )
    const nullOptionals: TxrHistoryDetail['settings'] = {
      ...settings,
      seed: null as unknown as number,
      cpus: null as unknown as number,
      memory_total_bytes: null as unknown as number,
    }
    expect(settingsLine(nullOptionals)).toBe('landmark 42, horizon 180, covariates on')
  })
})

describe('TxrHistoryFooter (TEST-HIST-7 — usage line + the two retention links)', () => {
  it('renders the usage line from the usage record: count · bytes · the promise trail, no data dir (qa-fixes4 ITEM-1)', () => {
    const view = render(
      <TxrHistoryFooter
        usage={usage()}
        total={9}
        preferences={null}
        working={false}
        onCopiesOff={vi.fn()}
        onCopiesOn={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    const line = view.getByTestId('txr-history-usage')
    // results-r3 R3-results-2: the `/data/txresbench` segment is gone —
    // the data root is an internal host fact; what remains is the board's
    // storage line without the path.
    expect(line.textContent).toBe('3 runs · uses 327 MB of stored files. Delete a run to free the space.')
    expect(line.textContent).not.toContain('/data/txresbench')
  })

  it('falls back to the list total for the count and omits the bytes/path segments when usage is unavailable', () => {
    const view = render(
      <TxrHistoryFooter
        usage={null}
        total={9}
        preferences={null}
        working={false}
        onCopiesOff={vi.fn()}
        onCopiesOn={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(view.getByTestId('txr-history-usage').textContent).toBe(
      '9 runs of stored files. Delete a run to free the space.',
    )
  })

  it('renders the two board links from the preference state', () => {
    const view = render(
      <TxrHistoryFooter
        usage={usage()}
        total={9}
        preferences={{ keep_file_copies: true } as TxrHistoryPreferences}
        working={false}
        onCopiesOff={vi.fn()}
        onCopiesOn={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(view.getByTestId('txr-history-copies-off').textContent).toBe(
      'Do not keep copies of my files',
    )
    expect(view.queryByTestId('txr-history-copies-on')).toBeNull()
    expect(colorHex(view.getByTestId('txr-history-clear-all').style.color)).toBe('var(--txr-danger)')
    cleanup()
    const view2 = render(
      <TxrHistoryFooter
        usage={usage()}
        total={9}
        preferences={{ keep_file_copies: false } as TxrHistoryPreferences}
        working={false}
        onCopiesOff={vi.fn()}
        onCopiesOn={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(view2.getByTestId('txr-history-copies-on').textContent).toBe('Keep copies of my files')
    expect(view2.queryByTestId('txr-history-copies-off')).toBeNull()
  })

  it('renders the links conservatively while the preference is unloaded (the provider default true)', () => {
    const view = render(
      <TxrHistoryFooter
        usage={usage()}
        total={9}
        preferences={null}
        working={false}
        onCopiesOff={vi.fn()}
        onCopiesOn={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(view.getByTestId('txr-history-copies-off')).toBeTruthy()
  })

  it('reports the three link clicks and disables them while a transition is in flight', () => {
    const onCopiesOff = vi.fn()
    const onClearAll = vi.fn()
    const view = render(
      <TxrHistoryFooter
        usage={usage()}
        total={9}
        preferences={{ keep_file_copies: true } as TxrHistoryPreferences}
        working
        onCopiesOff={onCopiesOff}
        onCopiesOn={vi.fn()}
        onClearAll={onClearAll}
      />,
    )
    fireEvent.click(view.getByTestId('txr-history-copies-off'))
    expect(onCopiesOff).not.toHaveBeenCalled() // a disabled link never fires
    expect(view.getByTestId('txr-history-copies-off').hasAttribute('disabled')).toBe(true)
    cleanup()
    const idle = render(
      <TxrHistoryFooter
        usage={usage()}
        total={9}
        preferences={{ keep_file_copies: true } as TxrHistoryPreferences}
        working={false}
        onCopiesOff={onCopiesOff}
        onCopiesOn={vi.fn()}
        onClearAll={onClearAll}
      />,
    )
    fireEvent.click(idle.getByTestId('txr-history-copies-off'))
    expect(onCopiesOff).toHaveBeenCalledTimes(1)
    fireEvent.click(idle.getByTestId('txr-history-clear-all'))
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('the one-run count reads the singular', () => {
    const view = render(
      <TxrHistoryFooter
        usage={usage({ run_count: 1 })}
        total={9}
        preferences={null}
        working={false}
        onCopiesOff={vi.fn()}
        onCopiesOn={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )
    expect(view.getByTestId('txr-history-usage').textContent).toContain('1 run ·')
  })
})

describe('TxrHistoryActions (TEST-HIST-7 — the per-capability action variants)', () => {
  it('a finished copy-kept row: open results + rerun + download + reveal + log, never settings-again', () => {
    const view = render(
      <TxrHistoryActions item={item('run-1')} runId="run-1" isDesktop onRerun={vi.fn()} onOpenResults={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-open-results-run-1').textContent).toBe('Open the results')
    expect(view.getByTestId('txr-history-rerun-run-1').textContent).toBe(
      'Run again with the same settings',
    )
    expect(view.queryByTestId('txr-history-settings-again-run-1')).toBeNull()
    expect(view.getByTestId('txr-history-download-run-1').textContent).toBe('Download predictions')
    expect(view.getByTestId('txr-history-open-folder-run-1').textContent).toBe('Open the folder')
    expect(view.getByTestId('txr-history-log-run-1').textContent).toBe('Show the log')
  })

  it('a copy-cleared row: settings-again instead of rerun (exclusive both ways)', () => {
    const view = render(
      <TxrHistoryActions
        item={item('run-1', { can_rerun: false })}
        runId="run-1"
        isDesktop
        onSettingsAgain={vi.fn()}
      />,
    )
    expect(view.getByTestId('txr-history-settings-again-run-1').textContent).toBe(
      'Use these settings again',
    )
    expect(view.queryByTestId('txr-history-rerun-run-1')).toBeNull()
  })

  it('a running row: open-running instead of open-results, no rerun/settings-again', () => {
    const view = render(
      <TxrHistoryActions item={item('run-1', { bucket: 'running', can_rerun: false, can_reopen: false, can_download: false })} runId="run-1" isDesktop onOpenRunning={vi.fn()} />,
    )
    expect(view.getByTestId('txr-history-open-running-run-1').textContent).toBe(
      'Open the running run',
    )
    expect(view.queryByTestId('txr-history-open-results-run-1')).toBeNull()
    expect(view.queryByTestId('txr-history-rerun-run-1')).toBeNull()
    expect(view.queryByTestId('txr-history-settings-again-run-1')).toBeNull()
  })

  it('web mode hides the folder affordance (the PROV-UR-7 gate fact)', () => {
    const view = render(
      <TxrHistoryActions item={item('run-1')} runId="run-1" isDesktop={false} />,
    )
    expect(view.queryByTestId('txr-history-open-folder-run-1')).toBeNull()
    expect(view.getByTestId('txr-history-log-run-1')).toBeTruthy() // the log is every row's
  })

  it('ITEM-2 (f): desktop offers "Delete this run" (the footer\'s promise is true); web mode hides it', () => {
    const onDelete = vi.fn()
    const view = render(
      <TxrHistoryActions item={item('run-1')} runId="run-1" isDesktop onDelete={onDelete} />,
    )
    const del = view.getByTestId('txr-history-delete-run-1')
    expect(del.textContent).toBe('Delete this run')
    fireEvent.click(del)
    expect(onDelete).toHaveBeenCalledWith('run-1')
    cleanup()

    const web = render(
      <TxrHistoryActions item={item('run-1')} runId="run-1" isDesktop={false} onDelete={onDelete} />,
    )
    expect(web.queryByTestId('txr-history-delete-run-1')).toBeNull()
  })

  it('no download affordance when the run cannot download (can_download false)', () => {
    const view = render(
      <TxrHistoryActions item={item('run-1', { can_download: false })} runId="run-1" isDesktop />,
    )
    expect(view.queryByTestId('txr-history-download-run-1')).toBeNull()
  })

  it('every control reports its run id', () => {
    const onRerun = vi.fn()
    const onLog = vi.fn()
    const view = render(
      <TxrHistoryActions item={item('run-1')} runId="run-1" isDesktop onRerun={onRerun} onLog={onLog} />,
    )
    fireEvent.click(view.getByTestId('txr-history-rerun-run-1'))
    expect(onRerun).toHaveBeenCalledWith('run-1')
    fireEvent.click(view.getByTestId('txr-history-log-run-1'))
    expect(onLog).toHaveBeenCalledWith('run-1')
  })
})

describe('TxrHistoryLogDialog (TEST-HIST-7 — the terminal snapshot)', () => {
  const logProps = (over: Partial<Parameters<typeof TxrHistoryLogDialog>[0]> = {}) => ({
    open: true,
    runId: 'run-1',
    methodId: null as string | null,
    methods: [
      { id: 'method-a', version: '1.0.0' },
      { id: 'method-b', version: '2.1.0' },
    ],
    lines: [logLine(1, 'first line'), logLine(2, 'second line')],
    total: 3,
    loading: false,
    onClose: vi.fn(),
    onMethodChange: vi.fn(),
    ...over,
  })

  it('renders the whole-run dialog with the lines, the count and the copy action', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const view = render(<TxrHistoryLogDialog {...logProps()} />)
    expect(view.getByTestId('txr-history-log-dialog').textContent).toContain('Run log')
    expect(view.getByTestId('txr-history-log-lines').textContent).toBe(
      'first line\nsecond line',
    )
    expect(view.getByTestId('txr-history-log-count').textContent).toBe('Showing 2 of 3 lines')
    fireEvent.click(view.getByTestId('txr-history-log-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('first line\nsecond line'))
  })

  it('the method filter reports the picked method (the store re-backfills); a method view retitles', async () => {
    const onMethodChange = vi.fn()
    const view = render(
      <TxrHistoryLogDialog {...logProps({ onMethodChange })} methodId="method-a" />,
    )
    expect(view.getByTestId('txr-history-log-dialog').textContent).toContain('Log: method-a')
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-history-log-filter"]')!
    expect(trigger.textContent).toContain('method-a')
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const all = document.querySelector<HTMLElement>(
      '[role="option"][data-testid="txr-history-log-filter-opt-"]',
    )!
    expect(all.textContent).toBe('All methods')
    await act(async () => {
      fireEvent.pointerDown(all, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(all, { button: 0 })
      fireEvent.click(all)
      await Promise.resolve()
    })
    expect(onMethodChange).toHaveBeenCalledWith(null)
  })

  it('closing reports the close request; copy is disabled with no lines; no count without a server total', () => {
    const onClose = vi.fn()
    render(<TxrHistoryLogDialog {...logProps({ lines: [], total: 0, onClose })} />)
    expect(screen.queryByTestId('txr-history-log-count')).toBeNull()
    expect(
      screen.getByTestId('txr-history-log-copy').hasAttribute('disabled'),
    ).toBe(true)
    fireEvent.click(document.querySelector('[data-slot="dialog-close"]') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('logTextOf joins the line contents the way a log file reads', () => {
    expect(logTextOf([logLine(1, 'a'), logLine(2, 'b')])).toBe('a\nb')
    expect(logTextOf([])).toBe('')
  })

  it('hides the start-up noise by default and reveals it behind Show technical output (R2-10)', async () => {
    const view = render(
      <TxrHistoryLogDialog
        {...logProps({
          lines: [
            logLine(1, 'run line'),
            { seq: 2, content: 'setlocale: LC_ALL is not a valid locale', stream: 'stderr', created_at: '2026-11-01T05:00:00Z' },
          ],
          total: 2,
        })}
      />,
    )
    // The noisy line is hidden; the count states the bound honestly.
    expect(view.getByTestId('txr-history-log-lines').textContent).toBe('run line')
    expect(view.getByTestId('txr-history-log-count').textContent).toContain('Showing 1 of 2 lines')
    expect(view.getByTestId('txr-history-log-count').textContent).toContain(
      '1 technical lines hidden',
    )
    // The switch reveals it (and the copy follows the visible view).
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const toggle = view.getByTestId('txr-history-log-technical')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(view.getByTestId('txr-history-log-lines').textContent).toContain('setlocale')
    fireEvent.click(view.getByTestId('txr-history-log-copy'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'run line\nsetlocale: LC_ALL is not a valid locale',
      ),
    )
  })

  it('keeping the selected method id in the options: a select never renders empty (R2-10)', async () => {
    // The dialog can open on a method id the presentational list does not
    // carry — the empty option set was the report's blank dropdown.
    const view = render(
      <TxrHistoryLogDialog
        {...logProps({ methods: [{ id: 'method-b', version: '2.1.0' }] })}
        methodId="method-a"
      />,
    )
    expect(view.getByTestId('txr-history-log-dialog').textContent).toContain('Log: method-a')
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-history-log-filter"]')!
    expect(trigger.textContent).toContain('method-a')
  })
})

describe('TxrConfirmDialog (TEST-HIST-7 — the three confirmations, INV-2)', () => {
  const confirmProps = (over: Partial<Parameters<typeof TxrConfirmDialog>[0]> = {}) => ({
    confirm: 'copies-off' as 'copies-off' | 'copies-on' | 'clear-all' | 'delete-run' | null,
    working: false,
    onCancel: vi.fn(),
    onCopiesOff: vi.fn(),
    onCopiesOn: vi.fn(),
    onClearAll: vi.fn(),
    onDeleteRun: vi.fn(),
    ...over,
  })

  it('copies-off: the plan body + Cancel, and the confirm reports the transition', () => {
    const onCopiesOff = vi.fn()
    const onCancel = vi.fn()
    const props = confirmProps({ onCopiesOff, onCancel })
    const view = render(<TxrConfirmDialog {...props} />)
    expect(view.getByTestId('txr-history-confirm-body-copies-off').textContent).toBe(
      'New runs will not keep copies. Copies already stored are removed, so those runs can no longer be repeated with the same files; their settings can still be used again.',
    )
    fireEvent.click(view.getByTestId('txr-history-confirm-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByTestId('txr-history-confirm-copies-off'))
    expect(onCopiesOff).toHaveBeenCalledTimes(1)
    expect(props.onClearAll).not.toHaveBeenCalled()
  })

  it('copies-on states that removed copies are not restored and reports the flip', () => {
    const onCopiesOn = vi.fn()
    const view = render(<TxrConfirmDialog {...confirmProps({ confirm: 'copies-on', onCopiesOn })} />)
    expect(view.getByTestId('txr-history-confirm-body-copies-on').textContent).toBe(
      'New runs will keep copies. Copies already removed are not restored.',
    )
    fireEvent.click(view.getByTestId('txr-history-confirm-copies-on'))
    expect(onCopiesOn).toHaveBeenCalledTimes(1)
  })

  it('clear-all: the two choices, each reporting its delete_files value; cancel reports', () => {
    const onClearAll = vi.fn()
    const onCancel = vi.fn()
    const view = render(<TxrConfirmDialog {...confirmProps({ confirm: 'clear-all', onClearAll, onCancel })} />)
    expect(view.getByTestId('txr-history-confirm-body-clear-all').textContent).toBe(
      'Every run is removed from the history. This cannot be undone. Saved models are kept. Choose whether the stored files are removed too.',
    )
    fireEvent.click(view.getByTestId('txr-history-confirm-clear-files'))
    expect(onClearAll).toHaveBeenCalledWith(true)
    fireEvent.click(view.getByTestId('txr-history-confirm-keep-files'))
    expect(onClearAll).toHaveBeenCalledWith(false)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('the CTAs disable while a transition is in flight (no double fire)', () => {
    const onCopiesOff = vi.fn()
    const view = render(<TxrConfirmDialog {...confirmProps({ confirm: 'copies-off', working: true, onCopiesOff })} />)
    fireEvent.click(view.getByTestId('txr-history-confirm-copies-off'))
    expect(onCopiesOff).not.toHaveBeenCalled()
    expect(view.getByTestId('txr-history-confirm-copies-off').hasAttribute('disabled')).toBe(true)
  })

  it('a closed dialog renders nothing interactive', () => {
    const view = render(<TxrConfirmDialog {...confirmProps({ confirm: null })} />)
    expect(view.queryByTestId('txr-history-confirm-cancel')).toBeNull()
  })
})
