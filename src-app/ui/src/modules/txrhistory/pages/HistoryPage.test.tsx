// @vitest-environment jsdom
/**
 * TEST-HIST-8 — the K HistoryPage (ITEM-5; PROV-HIST-1/3/5, DEC-6/8/11/13,
 * INV-1/2/3/6).
 *
 * Pinned behaviors:
 *
 * - mount runs the fresh trio: `reload()` (the first page + the usage
 *   figure) AND `refreshPreferences()` (the footer's two links' state —
 *   its own fetch per ITEM-2, owned by the page since the ITEM-4
 *   components are presentational; recorded in the item's drift ledger);
 * - a `window` `focus` event re-fires the same trio, and the listener is
 *   removed on unmount (DEC-11 — no leak);
 * - the list area's boundary states: `total === 0` → the empty state;
 *   a failed first page → the error state + Retry re-fires the load;
 *   "Load more" exactly while `items.length < total` (the store's
 *   `offset = items.length` continuation, INV-1);
 * - every row action binds the PROVIDERS' seams — the page navigates
 *   through `resultsPath` / `runningPath` / `chooseMethodsPath` /
 *   `modelsPath` and downloads/reveals through the reused helpers; the
 *   page's own source never spells a route literal (INV-3);
 * - the copy-cleared row's "Use these settings again" PUTs the DEC-6 body
 *   and navigates to `/choose-methods` WITHOUT ever calling `rerunRun`;
 * - the retention confirmations: "Clear all history" fires `clearRuns`
 *   only after a choice (Cancel → zero calls); "Do not keep copies of my
 *   files" PUTs the preference then POSTs `clearAllCopies`, in order
 *   (INV-2);
 * - the log dialog: opens with the store's backfilled lines, and the
 *   method-filter change re-opens it — the backfill restarts at the
 *   FIRST page (no stale `after_seq`, the ITEM-5 cursor fix);
 * - desktop mode offers "Open the folder" and reveals the run dir through
 *   the reused PROV-UR-7 helper; web mode hides the button.
 *
 * The only mocked boundary is `@/api-client`; the store runs real (its
 * internals are TEST-HIST-2/3/4 — this file pins the PAGE's wiring
 * through it). All fixtures are synthetic (ids `run-1`/`method-a`,
 * non-board counts — the boards' facts are design examples, never data,
 * INV-6).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type {
  TxrHistoryDetail,
  TxrHistoryItem,
  TxrHistoryPage,
  TxrHistoryUsage,
  TxrRunLogLine,
} from '@/api-client/types'
import { HistoryPage } from './HistoryPage'

const api = vi.hoisted(() => ({
  listHistory: vi.fn(async (_q: unknown): Promise<TxrHistoryPage> => ({ items: [], total: 0, limit: 20, offset: 0 })),
  getHistory: vi.fn(async (_id: unknown): Promise<TxrHistoryDetail | null> => null),
  getUsage: vi.fn(async (): Promise<TxrHistoryUsage | null> => null),
  getPreferences: vi.fn(async (): Promise<{ keep_file_copies: boolean }> => ({ keep_file_copies: true })),
  updatePreferences: vi.fn(async (_body: unknown): Promise<void> => undefined),
  clearAllCopies: vi.fn(async (): Promise<void> => undefined),
  rerunRun: vi.fn(async (_id: unknown): Promise<{ id: string }> => ({ id: 'run-new' })),
  listRunLogs: vi.fn(
    async (_q: unknown): Promise<{ lines: TxrRunLogLine[]; next_seq: number; total: number }> => ({
      lines: [],
      next_seq: 0,
      total: 0,
    }),
  ),
  clearRuns: vi.fn(async (_q: unknown): Promise<void> => undefined),
  updateAnalysisConfig: vi.fn(async (_body: unknown): Promise<void> => undefined),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    History: {
      listHistory: api.listHistory,
      getHistory: api.getHistory,
      getUsage: api.getUsage,
      getPreferences: api.getPreferences,
      updatePreferences: api.updatePreferences,
      clearAllCopies: api.clearAllCopies,
    },
    Txr: {
      rerunRun: api.rerunRun,
      listRunLogs: api.listRunLogs,
      clearRuns: api.clearRuns,
      updateAnalysisConfig: api.updateAnalysisConfig,
    },
  },
}))

const { useTxrHistory } = await import('../index')
const state = () => useTxrHistory.getState()

// jsdom gaps the kit's base-ui controls probe at mount (the components
// suite's beforeAll — Select arms need PointerEvent + ResizeObserver).
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
  vi.useRealTimers()
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
})

// ── Synthetic fixtures (INV-6: non-board ids, counts and names) ─────────────

function item(id: string, over: Partial<TxrHistoryItem> = {}): TxrHistoryItem {
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
        group: 'dynamic-risk',
        group_label: 'Dynamic risk',
        version: '1.0.0',
        state: 'finished',
        bytes_downloaded: 0,
        elapsed_secs: 95,
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
    log_line_count: 3,
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

function page(total: number, items: TxrHistoryItem[] = []): TxrHistoryPage {
  return { items, total, limit: 20, offset: 0 }
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

function LocationProbe() {
  const location = useLocation()
  return (
    <div data-testid="route-location">
      {location.pathname}
      {location.search}
    </div>
  )
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/history']}>
      <HistoryPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** Drain the store's async chains under act (the mount fetch, an expand,
 *  an action). */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Expand one row and wait for its detail (the row's action block). */
async function expand(id: string): Promise<void> {
  const toggle = screen.getByTestId(`txr-history-toggle-${id}`)
  await act(async () => {
    fireEvent.click(toggle)
  })
  await settle()
  expect(screen.getByTestId(`txr-history-detail-${id}`)).toBeTruthy()
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(api)) fn.mockReset()
  api.listHistory.mockResolvedValue(page(2, [item('run-2'), item('run-1')]))
  api.getHistory.mockImplementation(async (_id: unknown) =>
    detail((_id as { id: string }).id),
  )
  api.getUsage.mockResolvedValue(usage())
  api.getPreferences.mockResolvedValue({ keep_file_copies: true })
  api.listRunLogs.mockResolvedValue({
    lines: [logLine(1, 'first line'), logLine(2, 'second line')],
    next_seq: 2,
    total: 3,
  })
  state().reset()
})

describe('HistoryPage (TEST-HIST-8)', () => {
  it('mounts the fresh trio: the first page, the usage figure and the footer preference', async () => {
    renderPage()
    await settle()
    expect(api.listHistory).toHaveBeenCalledTimes(1)
    expect(api.listHistory).toHaveBeenCalledWith({ limit: 20, offset: 0 })
    expect(api.getUsage).toHaveBeenCalledTimes(1)
    expect(api.getPreferences).toHaveBeenCalledTimes(1)
    // The board chrome (the toolbar's title + subtitle), the rows and the
    // footer's state-dependent link ("keep copies" OFF → the flip-back link).
    expect(screen.getByTestId('txr-history-title').textContent).toBe('History')
    expect(screen.getByTestId(`txr-history-row-run-1`)).toBeTruthy()
    expect(screen.queryByTestId('txr-history-copies-on')).toBeNull()
    expect(screen.getByTestId('txr-history-copies-off').textContent).toBe(
      'Do not keep copies of my files',
    )
  })

  it('the footer renders the persisted preference: keep_file_copies false flips the link', async () => {
    api.getPreferences.mockResolvedValue({ keep_file_copies: false })
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-history-copies-on').textContent).toBe('Keep copies of my files')
    expect(screen.queryByTestId('txr-history-copies-off')).toBeNull()
  })

  it('a window focus re-fires the fresh trio; the listener is removed on unmount (no leak)', async () => {
    const view = renderPage()
    await settle()
    for (const fn of [api.listHistory, api.getUsage, api.getPreferences]) fn.mockClear()
    await act(async () => {
      fireEvent.focus(window)
    })
    await settle()
    expect(api.listHistory).toHaveBeenCalledTimes(1)
    expect(api.getUsage).toHaveBeenCalledTimes(1)
    expect(api.getPreferences).toHaveBeenCalledTimes(1)
    view.unmount()
    for (const fn of [api.listHistory, api.getUsage, api.getPreferences]) fn.mockClear()
    await act(async () => {
      fireEvent.focus(window)
    })
    await settle()
    expect(api.listHistory).not.toHaveBeenCalled()
    expect(api.getUsage).not.toHaveBeenCalled()
    expect(api.getPreferences).not.toHaveBeenCalled()
  })

  it('the search input debounces: one listHistory with the q after 200 ms', async () => {
    renderPage()
    await settle()
    const input = screen.getByTestId('txr-history-search') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'cox-cutpoint' } })
    })
    expect(input.value).toBe('cox-cutpoint')
    await settle(150)
    expect(api.listHistory).toHaveBeenCalledTimes(1) // the mount load only
    await settle(100)
    expect(api.listHistory).toHaveBeenCalledTimes(2)
    expect(api.listHistory).toHaveBeenLastCalledWith({ limit: 20, offset: 0, q: 'cox-cutpoint' })
  })

  it('renders the empty state when nothing matched', async () => {
    api.listHistory.mockResolvedValue(page(0, []))
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-history-empty').textContent).toContain('Nothing here yet')
  })

  it('renders the failure state and the Retry re-fires the first-page load', async () => {
    api.listHistory.mockRejectedValueOnce(new Error('HTTP error! status: 500'))
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-history-error')).toBeTruthy()
    expect(screen.queryByTestId('txr-history-list')).toBeNull()
    api.listHistory.mockResolvedValue(page(1, [item('run-1')]))
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-error-retry'))
    })
    await settle()
    expect(api.listHistory).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId(`txr-history-row-run-1`)).toBeTruthy()
    expect(screen.queryByTestId('txr-history-error')).toBeNull()
  })

  it('loads more at offset = items.length, exactly while items.length < total', async () => {
    api.listHistory
      .mockResolvedValueOnce(page(2, [item('run-2')]))
      .mockResolvedValueOnce(page(2, [item('run-1')]))
    renderPage()
    await settle()
    expect(screen.getByTestId('txr-history-load-more')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-load-more'))
    })
    await settle()
    expect(api.listHistory).toHaveBeenLastCalledWith({ limit: 20, offset: 1 })
    expect(screen.getByTestId(`txr-history-row-run-1`)).toBeTruthy()
    expect(screen.getByTestId(`txr-history-row-run-2`)).toBeTruthy()
    expect(screen.queryByTestId('txr-history-load-more')).toBeNull()
  })

  it('binds the providers’ builders — the page imports them and never spells a route literal', () => {
    // The jsdom environment serves modules over http, so `import.meta.url`
    // is not a file URL here; the vitest root (process.cwd()) is the ui
    // project dir, the same base the sibling git-based pins use.
    const source = readFileSync(
      path.join(process.cwd(), 'src/modules/txrhistory/pages/HistoryPage.tsx'),
      'utf8',
    )
    expect(source).toContain("from '@/modules/txrresults'")
    expect(source).toContain("from '@/modules/txrrun'")
    expect(source).toContain("from '@/modules/txrmodels'")
    expect(source).toContain('resultsPath')
    expect(source).toContain('runningPath')
    expect(source).toContain('chooseMethodsPath')
    expect(source).toContain('modelsPath')
    expect(source).toContain('downloadPredictionsCsv')
    expect(source).toContain('revealRunDir')
    expect(source).not.toContain("'/analysis/")
    expect(source).not.toContain("'/choose-methods'")
    expect(source).not.toContain("'/models'")
    expect(source).not.toContain("'/models?set=")
  })

  it('"Open the results" navigates through the builder; a running row opens the running run', async () => {
    renderPage()
    await settle()
    await expand('run-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-open-results-run-1'))
    })
    await settle()
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/results')
    // A running row offers the single running-run action, never a results one.
    api.getHistory.mockImplementation(async (_id: unknown) =>
      detail((_id as { id: string }).id, { bucket: 'running', can_rerun: false }),
    )
    await expand('run-2')
    expect(screen.queryByTestId('txr-history-open-results-run-2')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-open-running-run-2'))
    })
    await settle()
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-2/running')
  })

  it('"Run again" reruns and lands on the new run’s running path', async () => {
    renderPage()
    await settle()
    await expand('run-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-rerun-run-1'))
    })
    await settle()
    expect(api.rerunRun).toHaveBeenCalledWith({ id: 'run-1' })
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-new/running')
  })

  it('the copy-cleared row offers settings-again: the DEC-6 body, then choose-methods, never rerunRun', async () => {
    api.getHistory.mockImplementation(async (_id: unknown) =>
      detail((_id as { id: string }).id, { can_rerun: false }),
    )
    renderPage()
    await settle()
    await expand('run-1')
    expect(screen.queryByTestId('txr-history-rerun-run-1')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-settings-again-run-1'))
    })
    await settle()
    expect(api.rerunRun).not.toHaveBeenCalled()
    const body = api.updateAnalysisConfig.mock.calls[0][0] as {
      config: Record<string, unknown>
      last_input_summary: unknown
    } 
    expect(body.config.decision_day).toBe(42)
    expect(body.config.covariates).toBe(true)
    expect(body.config.label_day).toBeNull()
    expect(body.last_input_summary).toBeNull()
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-methods')
  })

  it('"Clear all history" is the confirmation gate: Cancel does nothing, the choice fires clearRuns', async () => {
    renderPage()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-clear-all'))
    })
    await settle()
    expect(screen.getByTestId('txr-history-confirm')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-confirm-cancel'))
    })
    await settle()
    expect(api.clearRuns).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-clear-all'))
    })
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-confirm-clear-files'))
    })
    await settle()
    expect(api.clearRuns).toHaveBeenCalledWith({ delete_files: true })
  })

  it('copies-off: PUT the preference then POST clearAllCopies, in order (the INV-2 gate)', async () => {
    renderPage()
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-copies-off'))
    })
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-confirm-copies-off'))
    })
    await settle()
    expect(api.updatePreferences).toHaveBeenCalledWith({ keep_file_copies: false })
    expect(api.clearAllCopies).toHaveBeenCalledTimes(1)
    expect(api.updatePreferences.mock.invocationCallOrder[0]).toBeLessThan(
      api.clearAllCopies.mock.invocationCallOrder[0],
    )
  })

  it('the log dialog opens with the backfilled lines, and the method filter restarts the backfill at the first page', async () => {
    renderPage()
    await settle()
    await expand('run-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-log-run-1'))
    })
    await settle()
    expect(api.listRunLogs).toHaveBeenCalledWith({ id: 'run-1', limit: 200 })
    expect(screen.getByTestId('txr-history-log-lines').textContent).toBe(
      'first line\nsecond line',
    )
    expect(screen.getByTestId('txr-history-log-count').textContent).toBe('Showing 2 of 3 lines')
    // The method filter re-opens the dialog: the cursor was reset, so the
    // continuation NEVER rides the previous session's after_seq.
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-history-log-filter"]')!
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const option = document.querySelector<HTMLElement>(
      '[role="option"][data-testid="txr-history-log-filter-opt-method-a"]',
    )!
    await act(async () => {
      fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(option, { button: 0 })
      fireEvent.click(option)
      await Promise.resolve()
    })
    await settle()
    const second = api.listRunLogs.mock.calls[1]?.[0] as Record<string, unknown>
    expect(second.method_id).toBe('method-a')
    expect(second).not.toHaveProperty('after_seq')
    expect(screen.getByTestId('txr-history-log-dialog').textContent).toContain('Log: method-a')
  })

  it('desktop mode reveals the run folder through the reused helper; web mode hides the button', async () => {
    const webView = renderPage()
    await settle()
    await expand('run-1')
    expect(screen.queryByTestId('txr-history-open-folder-run-1')).toBeNull()
    webView.unmount()
    // The store is a singleton: the second render must start from a clean
    // list (a fresh mount loads the first page again).
    state().reset()
    const invokeSpy = vi.fn((_cmd: string, _args: unknown) => Promise.resolve())
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: invokeSpy },
    }
    const desktopView = renderPage()
    await settle()
    await expand('run-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-history-open-folder-run-1'))
    })
    await settle()
    expect(invokeSpy).toHaveBeenCalledWith('reveal_in_file_manager', {
      path: '/data/txresbench/analysis-2026-11-01-run-1',
    })
    desktopView.unmount()
  })
})
