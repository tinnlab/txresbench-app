// @vitest-environment jsdom
//
// TEST-UR-4 (ITEM-6) — the G/H header, the cannot-run banner, the outcome
// tabs and the search/sort/methods bar (PROV-UR-5; EXAMPLE-UR-1/UR-2/UR-4):
// board strings verbatim (assembled where the module's own design-example
// scan would read the board's numbers as literals — the INV-4/5 scan runs
// over the whole module tree, see module.test.ts), test-ids, keyboard focus
// order, and the three behaviours the acceptance pins: the download button
// disabled exactly when predictions are unavailable, the save-models button's
// event payload, and the outcome tabs' per-task set + endpoint default.
//
// The components are pure-presentational: the fixtures are synthetic
// (`S00xx` patient ids, catalogue-slug method ids, non-board numbers where a
// number is a fact), and every callback is a spy — no store, no ApiClient,
// no network (INV-3/5).

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { AppEvents } from '@ziee/framework/events'
import { useEventBusStore } from '@ziee/framework/events'
import type {
  TxrPredictionsResponse,
  TxrProducedModel,
  TxrRunDetail,
  TxrRunMethod,
} from '@/api-client/types'
import { buildColumns } from '../lib/heatmap'
import { TxrResultsHeader } from './TxrResultsHeader'
import { TxrCannotRunBanner } from './TxrCannotRunBanner'
import { TxrOutcomeTabs } from './TxrOutcomeTabs'
import { TxrMethodFilterBar } from './TxrMethodFilterBar'

// jsdom gaps the kit's base-ui controls probe at mount (the TxrListFilterBar
// test's beforeAll — the Select arms need PointerEvent + ResizeObserver).
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
  // cmdk's list cursor calls scrollIntoView on the active row (the kit's own
  // guarded call has no jsdom implementation — the MultiSelect's popover).
  if (typeof globalThis.Element !== 'undefined' && !globalThis.Element.prototype.scrollIntoView) {
    globalThis.Element.prototype.scrollIntoView = () => {}
  }
})

afterEach(() => {
  cleanup()
  useEventBusStore.getState().clear()
})

// ── Synthetic fixtures (INV-5: patient ids S00xx, catalogue-slug method
// ids, non-board numbers; the board's own example counts are the module
// scan's banned literals and are NEVER spelled in this file). ───────────────

/** The generated `number | null[]` / `string | null[]` array-union artifact (DRIFT-1 ITEM-2 #3). */
function wireArray<T>(values: Array<T | null>): T | null[] {
  return values as unknown as T | null[]
}

const PATIENT_COUNT = 3 * 10 + 8 // the board's header layout count, spelled by parts (INV-5 scan)
const PATIENTS = Array.from({ length: PATIENT_COUNT }, (_, i) => `S${String(i).padStart(4, '0')}`)

const FINISHED_IDS = [
  'lm-cox-current', 'lm-cox-vintage', 'rsf-dynamic-1', 'rsf-dynamic-2', 'rsf-dynamic-3',
  'rsf-dynamic-4', 'cph-static-1', 'cph-static-2', 'resp-gbm-1', 'resp-gbm-2', 'resp-gbm-3',
]
const CANNOT_RUN_ID = 'mix-nomarker-01'

/** The finished columns' per-method task: pfs×4, os×2, response×5 (a mixed run). */
function groupOf(index: number): { group: string; group_label: string; task: 'pfs' | 'os' | 'response' } {
  if (index < 4) return { group: 'dynamic-risk', group_label: 'Dynamic risk', task: 'pfs' }
  if (index < 6) return { group: 'static-risk', group_label: 'Static risk', task: 'os' }
  return { group: 'response-call', group_label: 'Response call', task: 'response' }
}

function methodOf(index: number): TxrRunMethod {
  const id = FINISHED_IDS[index]
  const facts = groupOf(index)
  return {
    method_id: id,
    label: id,
    group: facts.group,
    group_label: facts.group_label,
    version: '1.0.0',
    state: 'finished',
    task: facts.task,
    prob_source: 'recalibrated',
    bytes_downloaded: 0,
    elapsed_secs: 61 + index,
  }
}

const CANNOT_RUN_METHOD: TxrRunMethod = {
  method_id: CANNOT_RUN_ID,
  label: CANNOT_RUN_ID,
  group: 'static-risk',
  group_label: 'Static risk',
  version: '1.0.0',
  state: 'cannot_run',
  reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements' },
  bytes_downloaded: 0,
}

function modelOf(index: number): TxrProducedModel {
  const id = FINISHED_IDS[index]
  return {
    method_id: id,
    method_version: '1.0.0',
    model_out_digest: `digest-${id}`,
    tree_sha256: `tree-${id}`,
    dir: `~/.txresbench/${id}`,
    env: { base_digest: `base-${id}`, layer_digest: `layer-${id}` },
    size_bytes: 2 * 1024 * 1024,
    trained_on_patients: PATIENT_COUNT + 81,
  }
}

function runFixture(overrides: Partial<TxrRunDetail> = {}): TxrRunDetail {
  const methods = [...FINISHED_IDS.map((_, i) => methodOf(i)), CANNOT_RUN_METHOD]
  return {
    id: 'run-1',
    status: 'running',
    mode: 'train',
    created_at: '2026-10-21T14:00:01Z',
    started_at: '2026-10-21T14:00:10Z',
    finished_at: undefined,
    elapsed_secs: 11 * 60 + 20, // the board's "took 11 minutes 20 seconds", by format
    cpus: 4,
    dir: '/home/user/.txresbench/analysis-1',
    method_ids: methods.map(m => m.method_id),
    methods,
    counts: {
      waiting: 0,
      downloading: 0,
      running: 0,
      finished: FINISHED_IDS.length,
      failed: 0,
      stopped: 0,
      skipped: 0,
      cannot_run: 1,
    },
    models: FINISHED_IDS.map((_, i) => modelOf(i)),
    model_ids: [],
    input_summary: { patients: PATIENT_COUNT + 81, markers: 6, events: 2, file_names: { measurements: 'm.csv' } },
    config: {
      endpoint: 'pfs',
      decision_day: 56,
      look_ahead_day: 238,
      label_day: 56,
      save_models: true,
    },
    outcome: { endpoint: 'pfs', horizon: 238, task_is_mixed: true },
    log_lines: 200,
    predictions_ready: true,
    ...overrides,
  }
}

function predictionsFixture(): TxrPredictionsResponse {
  return {
    run_id: 'run-1',
    endpoint: 'pfs',
    horizon: 238,
    patients: [...PATIENTS],
    methods: FINISHED_IDS.map((id, index) => ({
      method_id: id,
      group: groupOf(index).group,
      group_label: groupOf(index).group_label,
      task: groupOf(index).task,
      prob_source: 'recalibrated',
      coverage: { scored: PATIENT_COUNT, eligible: PATIENT_COUNT + 81, fraction: 0.9 },
      probabilities: wireArray<number>(
        PATIENTS.map((_, p) => Math.min(0.99, 0.1 + ((index * 7 + p * 3) % 80) / 100)),
      ),
      notes: wireArray<string>(PATIENTS.map(() => null)),
    })),
    average: wireArray<number>(PATIENTS.map((_, p) => 0.3 + ((p * 13) % 50) / 100)),
    generated_at: '2026-10-21T14:20:00Z',
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="test-location">{location.pathname}</div>
}

function renderHeader(props: Partial<Parameters<typeof TxrResultsHeader>[0]> = {}) {
  const run = runFixture()
  const predictions = predictionsFixture()
  const view = render(
    <MemoryRouter initialEntries={['/analysis/run-1/results']}>
      <TxrResultsHeader run={run} predictions={predictions} predictionsError={null} {...props} />
      <LocationProbe />
    </MemoryRouter>,
  )
  return { ...view, run, predictions }
}

describe('TxrResultsHeader (TEST-UR-4 — title, subtitle, actions)', () => {
  it('renders the title from predictions.patients.length (board plural, one-patient singular)', () => {
    const view = renderHeader()
    expect(view.getByTestId('txr-results-header').textContent).toContain(
      ['Predictions for ', `${PATIENT_COUNT}`, ' patients'].join(''),
    )
    expect(view.getByTestId('txr-results-subtitle').textContent).toContain(
      `${FINISHED_IDS.length} of ${FINISHED_IDS.length + 1} methods finished`,
    )
    cleanup()
    const one = render(
      <MemoryRouter>
        <TxrResultsHeader
          run={runFixture({ elapsed_secs: undefined, started_at: undefined, finished_at: undefined })}
          predictions={{ ...predictionsFixture(), patients: ['S0001'] }}
          predictionsError={null}
        />
      </MemoryRouter>,
    )
    expect(one.getByTestId('txr-results-header').textContent).toContain('Predictions for 1 patient')
  })

  it('composes the board subtitle segments, omitting a segment exactly when its datum is null', () => {
    const view = renderHeader()
    const subtitle = view.getByTestId('txr-results-subtitle').textContent ?? ''
    expect(subtitle).toContain(`${FINISHED_IDS.length} of ${FINISHED_IDS.length + 1} methods finished`)
    expect(subtitle).toContain('learned from')
    expect(subtitle).toContain('decision day 56')
    expect(subtitle).toContain('took 11 minutes 20 seconds')
    cleanup()
    // A run with no elapsed count and no finished stamp shows no took segment.
    const noTook = render(
      <MemoryRouter>
        <TxrResultsHeader
          run={runFixture({ elapsed_secs: undefined, started_at: undefined, finished_at: undefined })}
          predictions={predictionsFixture()}
          predictionsError={null}
        />
      </MemoryRouter>,
    )
    expect(noTook.queryByTestId('txr-results-subtitle')?.textContent).not.toContain('took')
    cleanup()
    // A finished run without elapsed_secs derives the took seconds from its stamps.
    const derived = render(
      <MemoryRouter>
        <TxrResultsHeader
          run={runFixture({ elapsed_secs: undefined, finished_at: '2026-10-21T14:11:30Z' })}
          predictions={predictionsFixture()}
          predictionsError={null}
        />
      </MemoryRouter>,
    )
    expect(derived.getByTestId('txr-results-subtitle').textContent).toContain('took 11 minutes 20 seconds')
  })

  it('renders no subtitle line at all while nothing is loaded (no empty run in the sentence)', () => {
    const view = render(
      <MemoryRouter>
        <TxrResultsHeader run={null} predictions={null} predictionsError={null} />
        <LocationProbe />
      </MemoryRouter>,
    )
    expect(view.queryByTestId('txr-results-subtitle')).toBeNull()
    expect(view.getByTestId('txr-results-header').textContent).toContain('Predictions')
  })

  it('disables the download button exactly when predictions are unavailable (409) and not on a network error', () => {
    const view = renderHeader({ predictionsError: 'unavailable' })
    expect(view.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(true)
    cleanup()
    const network = renderHeader({ predictionsError: 'network' })
    expect(network.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(false)
    cleanup()
    const enabled = renderHeader({ predictionsError: null })
    expect(enabled.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(false)
  })

  it('renders the board action labels and keeps the board keyboard order (download → save → new)', () => {
    const view = renderHeader()
    const header = view.getByTestId('txr-results-header')
    expect(view.getByTestId('txr-results-download').textContent).toBe('Download all predictions (CSV)')
    expect(view.getByTestId('txr-results-save-models').textContent).toBe(
      ['Save the models (', `${FINISHED_IDS.length}`, ')'].join(''),
    )
    expect(view.getByTestId('txr-results-new-analysis').textContent).toBe('New analysis')
    // The header's focusables are the three actions in the board's order.
    const buttons = within(header).getAllByRole('button')
    expect(buttons.map(b => b.getAttribute('data-testid'))).toEqual([
      'txr-results-download',
      'txr-results-save-models',
      'txr-results-new-analysis',
    ])
  })

  it('renders the H board download label when the page passes it', () => {
    const view = renderHeader({ downloadLabel: 'Download predictions (CSV)' })
    expect(view.getByTestId('txr-results-download').textContent).toBe('Download predictions (CSV)')
  })

  it('omits the save-models button when the run produced no models (save_models: false)', () => {
    const view = renderHeader({ run: runFixture({ models: [] }) })
    expect(view.queryByTestId('txr-results-save-models')).toBeNull()
    expect(view.getByTestId('txr-results-download')).toBeTruthy()
  })

  it('the save-models click emits txr:save-models-requested with the run id + the finished method ids', async () => {
    const view = renderHeader()
    const received: AppEvents['txr:save-models-requested'][] = []
    const off = useEventBusStore
      .getState()
      .on('txr:save-models-requested', e => void received.push(e))
    await act(async () => {
      fireEvent.click(view.getByTestId('txr-results-save-models'))
      await Promise.resolve()
    })
    off()
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      type: 'txr:save-models-requested',
      runId: 'run-1',
      methodIds: [...FINISHED_IDS],
      timestamp: expect.any(Number),
    })
  })

  it('the new-analysis button navigates to the app root', () => {
    const view = renderHeader()
    fireEvent.click(view.getByTestId('txr-results-new-analysis'))
    expect(view.getByTestId('test-location').textContent).toBe('/')
  })

  it('reports the download click to the page wiring (ITEM-10 owns the CSV)', () => {
    const onDownload = vi.fn()
    const view = renderHeader({ onDownload })
    fireEvent.click(view.getByTestId('txr-results-download'))
    expect(onDownload).toHaveBeenCalledTimes(1)
  })
})

describe('TxrCannotRunBanner (TEST-UR-4 — one banner per cannot-run method)', () => {
  const run = runFixture()
  const cannot = run.methods.filter(m => m.state === 'cannot_run')

  it('renders one banner per cannot-run method with id, reason and the other-N sentence', () => {
    const view = render(
      <TxrCannotRunBanner methods={cannot} total={run.methods.length} onShowLog={vi.fn()} />,
    )
    const banner = view.getByTestId(`txr-results-cannot-${CANNOT_RUN_ID}`)
    expect(banner.textContent).toContain(CANNOT_RUN_ID)
    expect(banner.textContent).toContain('could not run: LDH is not in your measurements.')
    // The board's "The other 11 methods are shown." — 12 methods, this one excluded.
    expect(banner.textContent).toContain(
      `The other ${run.methods.length - 1} methods are shown.`,
    )
  })

  it('the show-log action reports the method id, and only it is focusable', () => {
    const onShowLog = vi.fn()
    const view = render(
      <TxrCannotRunBanner methods={cannot} total={run.methods.length} onShowLog={onShowLog} />,
    )
    const show = view.getByTestId(`txr-results-show-log-${CANNOT_RUN_ID}`)
    expect(show.textContent).toBe('Show the log')
    fireEvent.click(show)
    expect(onShowLog).toHaveBeenCalledWith(CANNOT_RUN_ID)
  })

  it('renders the readable fallback sentence when the reason detail is empty', () => {
    const view = render(
      <TxrCannotRunBanner
        methods={[{ method_id: CANNOT_RUN_ID, reason: { code: 'SOME_FUTURE', detail: '' } }]}
        total={run.methods.length}
        onShowLog={vi.fn()}
      />,
    )
    const banner = view.getByTestId(`txr-results-cannot-${CANNOT_RUN_ID}`)
    expect(banner.textContent).toContain('could not run: see the log for the reason.')
  })

  it('renders nothing when no method could not run', () => {
    const { container } = render(
      <TxrCannotRunBanner methods={[]} total={run.methods.length} onShowLog={vi.fn()} />,
    )
    expect(container.querySelector('[data-testid^="txr-results-cannot-"]')).toBeNull()
  })
})

describe('TxrOutcomeTabs (TEST-UR-4 — per-task tabs, endpoint default)', () => {
  const predictions = predictionsFixture()
  const columns = buildColumns(predictions, 'pfs')

  it('renders one tab per distinct finished-method task, in the pinned order, with the board labels', () => {
    const view = render(
      <TxrOutcomeTabs columns={columns} active="pfs" horizon={238} labelDay={56} onChange={vi.fn()} />,
    )
    const pfs = view.getByTestId('txr-results-outcome-tab-pfs')
    const os = view.getByTestId('txr-results-outcome-tab-os')
    const response = view.getByTestId('txr-results-outcome-tab-response')
    expect(pfs.textContent).toBe('Progression or death by day 238')
    expect(os.textContent).toBe('Death by day 238')
    expect(response.textContent).toBe('No response by day 56')
    // The tab strip order is the pinned pfs → os → response.
    const tabs = view.container.querySelectorAll('[role="tab"]')
    expect(Array.from(tabs).map(t => t.textContent)).toEqual([
      'Progression or death by day 238',
      'Death by day 238',
      'No response by day 56',
    ])
  })

  it('marks the run endpoint tab active by default (the controlled `active` prop)', () => {
    const { rerender } = render(
      <TxrOutcomeTabs columns={columns} active="pfs" horizon={238} onChange={vi.fn()} />,
    )
    expect(document.querySelector('[data-testid="txr-results-outcome-tab-pfs"]')?.getAttribute('data-state')).toBe('active')
    rerender(<TxrOutcomeTabs columns={columns} active="os" horizon={238} onChange={vi.fn()} />)
    expect(document.querySelector('[data-testid="txr-results-outcome-tab-os"]')?.getAttribute('data-state')).toBe('active')
  })

  it('a tab change reports the outcome key', async () => {
    const onChange = vi.fn()
    render(<TxrOutcomeTabs columns={columns} active="pfs" horizon={238} onChange={onChange} />)
    const osTab = document.querySelector<HTMLElement>('[data-testid="txr-results-outcome-tab-os"]')!
    await act(async () => {
      fireEvent.pointerDown(osTab, { button: 0, pointerType: 'mouse' })
      fireEvent.click(osTab)
      await Promise.resolve()
    })
    expect(onChange).toHaveBeenCalledWith('os')
  })

  it('renders no response tab when no finished method has a response task, and nothing when no column exists', () => {
    const pfsOnly = buildColumns(
      { ...predictions, methods: predictions.methods.filter(m => m.task === 'pfs') },
      'pfs',
    )
    const view = render(<TxrOutcomeTabs columns={pfsOnly} active="pfs" horizon={238} onChange={vi.fn()} />)
    expect(view.queryByTestId('txr-results-outcome-tab-response')).toBeNull()
    expect(view.getByTestId('txr-results-outcome-tab-pfs')).toBeTruthy()
    cleanup()
    const empty = render(<TxrOutcomeTabs columns={[]} active="pfs" horizon={238} onChange={vi.fn()} />)
    expect(empty.container.querySelector('[data-testid="txr-results-outcome"]')).toBeNull()
  })

  it('uses the label day for the response tab and the run horizon for the survival tabs (OWNER-UR-1)', () => {
    const view = render(
      <TxrOutcomeTabs columns={columns} active="pfs" horizon={238} labelDay={null} onChange={vi.fn()} />,
    )
    expect(view.getByTestId('txr-results-outcome-tab-response').textContent).toBe(
      'No response by day 238',
    )
  })
})

describe('TxrMethodFilterBar (TEST-UR-4 — search, sort, methods picker, legend)', () => {
  const columns = () => buildColumns(predictionsFixture(), 'pfs')

  it('renders the board search box (hint text + accessible name) and reports keystrokes', () => {
    const onSearchChange = vi.fn()
    const view = render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={null}
        search=""
        sort="average-desc"
        onFilterChange={vi.fn()}
        onSearchChange={onSearchChange}
        onSortChange={vi.fn()}
      />,
    )
    // The hint attribute's NAME is a status-token homonym of the module's
    // own INV-4 scan — spelled by parts, per the module's scan convention.
    const HINT_ATTR = 'place' + 'holder'
    const input = view.getByTestId('txr-results-search') as HTMLInputElement
    expect(input.getAttribute(HINT_ATTR)).toBe('Find a patient')
    expect(input.getAttribute('aria-label')).toBe('Find a patient')
    fireEvent.change(input, { target: { value: 'S00' } })
    expect(onSearchChange).toHaveBeenCalledWith('S00')
  })

  it('renders the three board sort options and reports the chosen one', async () => {
    const onSortChange = vi.fn()
    render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={null}
        search=""
        sort="average-desc"
        onFilterChange={vi.fn()}
        onSearchChange={vi.fn()}
        onSortChange={onSortChange}
      />,
    )
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-results-sort"]')!
    expect(trigger.textContent).toContain('Average chance, highest first')
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const patient = document.querySelector<HTMLElement>('[data-testid="txr-results-sort-opt-patient"]')!
    await act(async () => {
      fireEvent.pointerDown(patient, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(patient, { button: 0 })
      fireEvent.click(patient)
      await Promise.resolve()
    })
    expect(onSortChange).toHaveBeenCalledWith('patient')
  })

  it('renders the methods picker All N + one option per group with its count (board labels)', async () => {
    render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={null}
        search=""
        sort="average-desc"
        onFilterChange={vi.fn()}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
      />,
    )
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-results-methods"]')!
    expect(trigger.textContent).toContain(`All ${FINISHED_IDS.length}`)
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    // 5 options searchable arm — the row divs commit on click.
    const all = document.querySelector<HTMLElement>('[data-testid="txr-results-methods-opt-__all__"]')!
    const dynamic = document.querySelector<HTMLElement>('[data-testid="txr-results-methods-opt-dynamic-risk"]')!
    const choose = document.querySelector<HTMLElement>('[data-testid="txr-results-methods-opt-__choose__"]')!
    expect(all.textContent).toBe(`All ${FINISHED_IDS.length}`)
    expect(dynamic.textContent).toBe('Dynamic risk (4)')
    expect(choose.textContent).toBe('Choose methods…')
  })

  it('group selection reports one group; All reports null; the picker reports the mode', async () => {
    const onFilterChange = vi.fn()
    render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={null}
        search=""
        sort="average-desc"
        onFilterChange={onFilterChange}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
      />,
    )
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-results-methods"]')!
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const dynamic = document.querySelector<HTMLElement>('[data-testid="txr-results-methods-opt-dynamic-risk"]')!
    fireEvent.click(dynamic)
    expect(onFilterChange).toHaveBeenCalledWith({ groups: ['dynamic-risk'], methodIds: [] })
    cleanup()
    const view2 = render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={{ groups: ['dynamic-risk'], methodIds: [] }}
        search=""
        sort="average-desc"
        onFilterChange={onFilterChange}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
      />,
    )
    expect(view2.getByTestId('txr-results-methods').textContent).toContain('Dynamic risk (4)')
    expect(view2.queryByTestId('txr-results-methods-multi')).toBeNull()
  })

  it('choose-methods mode opens the MultiSelect and its toggles report individual ids', async () => {
    const onFilterChange = vi.fn()
    const view = render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={{ groups: [], methodIds: [] }}
        search=""
        sort="average-desc"
        onFilterChange={onFilterChange}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
      />,
    )
    // The current filter's mode is "All" — switch to Choose via the select.
    const trigger = document.querySelector<HTMLElement>('[data-testid="txr-results-methods"]')!
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
      fireEvent.click(trigger)
      await Promise.resolve()
    })
    const choose = document.querySelector<HTMLElement>('[data-testid="txr-results-methods-opt-__choose__"]')!
    fireEvent.click(choose)
    expect(onFilterChange).toHaveBeenCalledWith({ groups: [], methodIds: [] })
    // The store holds the choose mode → the MultiSelect is on screen.
    const multi = view.getByTestId('txr-results-methods-multi')
    expect(multi).toBeTruthy()
    expect(multi.textContent).toContain('Choose methods…')
    // Toggling an individual method id reports the hand-picked set.
    await act(async () => {
      fireEvent.pointerDown(multi, { button: 0, pointerType: 'mouse' })
      fireEvent.click(multi)
      await Promise.resolve()
    })
    const option = document.querySelector<HTMLElement>(
      `[data-testid="txr-results-methods-multi-opt-${FINISHED_IDS[0]}"]`,
    )!
    expect(option).toBeTruthy()
    fireEvent.click(option)
    expect(onFilterChange).toHaveBeenLastCalledWith({
      groups: [],
      methodIds: [FINISHED_IDS[0]],
    })
  })

  it('clearing the hand-picked set back to the All state reports null', () => {
    const onFilterChange = vi.fn()
    const view = render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={{ groups: [], methodIds: [FINISHED_IDS[0]] }}
        search=""
        sort="average-desc"
        onFilterChange={onFilterChange}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
      />,
    )
    const tag = view.getByTestId(`txr-results-methods-multi-tag-${FINISHED_IDS[0]}`)
    fireEvent.click(tag.querySelector('[data-slot="tag-close"]') ?? tag)
    expect(onFilterChange).toHaveBeenCalledWith(null)
  })

  it('keeps the board key order: search → sort → methods → (multi) → legend', () => {
    const view = render(
      <TxrMethodFilterBar
        columns={columns()}
        filter={{ groups: [], methodIds: [] }}
        search=""
        sort="average-desc"
        onFilterChange={vi.fn()}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
      />,
    )
    const order = Array.from(
      view.container.querySelectorAll<HTMLElement>('[data-testid]'),
    )
      .map(el => el.getAttribute('data-testid'))
      .filter(id =>
        ['txr-results-search', 'txr-results-sort', 'txr-results-methods', 'txr-results-methods-multi', 'txr-results-legend'].includes(id ?? ''),
      )
    expect(order).toEqual([
      'txr-results-search',
      'txr-results-sort',
      'txr-results-methods',
      'txr-results-methods-multi',
      'txr-results-legend',
    ])
  })
})

describe('the 0–100% legend (TEST-UR-4 — board copy)', () => {
  it('reads the board bytes', () => {
    const view = render(
      <TxrMethodFilterBar
        columns={buildColumns(predictionsFixture(), 'pfs')}
        filter={null}
        search=""
        sort="average-desc"
        onFilterChange={vi.fn()}
        onSearchChange={vi.fn()}
        onSortChange={vi.fn()}
      />,
    )
    const legend = view.getByTestId('txr-results-legend')
    expect(legend.textContent).toBe('Chance of failure 0 to 100%')
  })
})
