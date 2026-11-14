// @vitest-environment jsdom
//
// TEST-UR-7 (ITEM-9) — the H MethodResultsPage (PROV-UR-1/5, DEC-6/7/18:
// EXAMPLE-UR-3/UR-4): the URL segment selects the active method tab (the
// `compare` segment → Compare methods; a method id → that method's tab; an
// unknown id → the Compare fallback, no crash), the bar table renders
// per-method bars + percents sorted by the first visible method with
// "Showing N of M" + Show all, the compare card renders the two board
// sentences and the divergent toggle filters the rows, the aside's care
// copy + chance dialog (the text derives from the run's endpoint/horizon +
// the prob-source mix) + the saved-in line with the desktop-gated
// open-folder action (mocked both ways), the log dialog backfills through
// `listRunLogs(method_id|null, after_seq)`, appends live log frames,
// auto-scrolls and copies the text — plus the shared DEC-18 state machine
// (404 / 409 / error) on the H routes and the H-header growth (the board's
// "Download predictions (CSV)" label, the SaveOne "Save this model" button
// emitting `txr:save-one-model-requested` only for a finished method with a
// produced model — the growth-block TEST-UR-10's second sentence).
//
// Boundaries: `ApiClient.Txr.*` mocked (the store runs real, the ITEM-5/6/8
// test shape), `@/core/platform` mocked both ways for the desktop gate.
// Fixtures synthetic (S00xx, catalogue-slug ids, computed counts — the
// board's facts are never data, INV-5).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { AppEvents } from '@txresbench/framework/events'
import { useEventBusStore } from '@txresbench/framework/events'
import type { TxrPredictionsResponse, TxrRunDetail, TxrRunLogLine, TxrRunMethod } from '@/api-client/types'
import { MethodResultsPage } from './MethodResultsPage'

const api = vi.hoisted(() => ({
  getRun: vi.fn(),
  getPredictions: vi.fn(),
  streamRun: vi.fn(),
  listRunLogs: vi.fn(),
  downloadPredictions: vi.fn(),
  catalogueDetail: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Txr: {
      getRun: (...a: unknown[]) => api.getRun(...a),
      getPredictions: (...a: unknown[]) => api.getPredictions(...a),
      streamRun: (...a: unknown[]) => api.streamRun(...a),
      listRunLogs: (...a: unknown[]) => api.listRunLogs(...a),
      downloadPredictions: (...a: unknown[]) => api.downloadPredictions(...a),
    },
    // qa-fixes4 ITEM-5 (R3-help-8): the document title's catalogue lookup.
    MethodCatalogue: {
      detail: (...a: unknown[]) => api.catalogueDetail(...a),
    },
  },
}))

const platform = vi.hoisted(() => ({ desktop: false }))
vi.mock('@/core/platform', () => ({
  isDesktop: () => platform.desktop,
  isWeb: () => !platform.desktop,
}))

const { TxrResults, useTxrResultsStore } = await import('../stores/Results.store')
const state = () => useTxrResultsStore.getState()

// jsdom gaps the kit's base-ui controls (the TxrListFilterBar polyfill set).
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
  useEventBusStore.getState().clear()
})

// ── Synthetic fixtures (INV-5) ───────────────────────────────────────────────

/** 12 patients — the "Showing N of M" window is driven via the store's limit. */
const PATIENTS = Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(4, '0')}`)

/** A's (lm-cox-a, pfs, native) — descending: S0002, S0006, S0004, S0009, S0012, … */
const A_VALUES = [0.3, 0.91, 0.24, 0.71, 0.35, 0.88, 0.42, 0.51, 0.6, 0.47, 0.19, 0.56]
/** B's (rsf-b, pfs, recalibrated) — divergence spread: S0005 22 pp, S0004 19 pp, S0002 6 pp (the card names the top three by |diff|, DEC-7); only the first two cross the 10 pp window (divergentCount 2). */
const B_VALUES = [0.29, 0.85, 0.25, 0.52, 0.57, 0.84, 0.4, 0.53, 0.62, 0.44, 0.21, 0.58]
/** C's (resp-c, response, native) — the mixed task driving the third outcome tab. */
const C_VALUES = [0.55, 0.4, 0.22, 0.71, 0.33, 0.48, 0.61, 0.28, 0.37, 0.44, 0.5, 0.19]

const FINISHED_IDS = ['lm-cox-a', 'rsf-b', 'resp-c']
const CANNOT_RUN_ID = 'cox-nomarker'

function methodRow(
  id: string,
  methodState: TxrRunMethod['state'],
  over?: Partial<TxrRunMethod>,
): TxrRunMethod {
  return {
    method_id: id,
    label: id,
    group: id === 'resp-c' ? 'response-risk' : 'survival',
    group_label: id === 'resp-c' ? 'Response risk' : 'Survival',
    version: '1.0.0',
    state: methodState,
    bytes_downloaded: 0,
    ...(methodState === 'finished' ? { phase: 'done' as const } : {}),
    ...over,
  }
}

function runFixture(): TxrRunDetail {
  const methods = [
    methodRow(FINISHED_IDS[0], 'finished', { elapsed_secs: 94 }),
    methodRow(FINISHED_IDS[1], 'finished', { elapsed_secs: 71 }),
    methodRow(FINISHED_IDS[2], 'finished', { elapsed_secs: 66 }),
    methodRow(CANNOT_RUN_ID, 'cannot_run', {
      reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements' },
    }),
  ]
  return {
    id: 'run-1',
    status: 'running',
    mode: 'train',
    created_at: '2026-11-06T00:00:00Z',
    started_at: '2026-11-06T00:00:50Z',
    finished_at: undefined,
    elapsed_secs: 3 * 60 + 10,
    cpus: 4,
    dir: '/home/u/.txresbench/analysis-2026-11-06-0000',
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
    models: [],
    model_ids: [],
    input_summary: {
      patients: PATIENTS.length + 160,
      markers: 5,
      events: 2,
      file_names: { patients: 'patients.csv', measurements: 'm.csv' },
    },
    config: {
      endpoint: 'pfs',
      decision_day: 56,
      look_ahead_day: 238,
      label_day: 56,
      save_models: true,
    },
    outcome: { endpoint: 'pfs', horizon: 238, task_is_mixed: true },
    log_lines: 12,
    predictions_ready: true,
  }
}

/** The generated `number | null[]` / `string | null[]` array-union artifact (DRIFT-1 ITEM-2 #3). */
function wireArray<T>(values: Array<T | null>): T | null[] {
  return values as unknown as T | null[]
}

function methodColumn(
  methodId: string,
  task: 'pfs' | 'response',
  probSource: 'native' | 'recalibrated',
  values: number[],
  group: string,
): TxrPredictionsResponse['methods'][number] {
  return {
    method_id: methodId,
    label: methodId,
    group,
    group_label: group === 'response-risk' ? 'Response risk' : 'Survival',
    task,
    prob_source: probSource,
    coverage: { scored: PATIENTS.length, eligible: PATIENTS.length + 20, fraction: 1 },
    probabilities: wireArray<number>(values),
    notes: wireArray<string>(PATIENTS.map(() => null)),
  }
}

function predictionsOf(): TxrPredictionsResponse {
  return {
    run_id: 'run-1',
    endpoint: 'pfs',
    horizon: 238,
    patients: [...PATIENTS],
    methods: [
      methodColumn(FINISHED_IDS[0], 'pfs', 'native', A_VALUES, 'survival'),
      methodColumn(FINISHED_IDS[1], 'pfs', 'recalibrated', B_VALUES, 'survival'),
      methodColumn(FINISHED_IDS[2], 'response', 'native', C_VALUES, 'response-risk'),
    ],
    average: wireArray<number>(PATIENTS.map((_, p) => (A_VALUES[p] + B_VALUES[p]) / 2)),
    generated_at: '2026-11-06T00:08:00Z',
  }
}

/** A produced model for lm-cox-a (the SaveOne "Save this model" gate). */
function modelsFor(id: string) {
  return [
    {
      method_id: id,
      method_version: '1.0.0',
      model_out_digest: `digest-${id}`,
      tree_sha256: `tree-${id}`,
      dir: `~/.txresbench/${id}`,
      env: { base_digest: 'b', layer_digest: 'l' },
      size_bytes: 1024,
      trained_on_patients: PATIENTS.length + 160,
    },
  ]
}

/** The stream mock: captures the typed SSE handlers, stays pending until resolved. */
let sseHandlers: Record<string, (data: unknown) => void> | null = null

function emit(event: string, data: unknown): void {
  sseHandlers?.[event]?.(data)
}

function httpError(status: number, message = 'error'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

beforeEach(() => {
  api.getRun.mockReset()
  api.getPredictions.mockReset()
  api.streamRun.mockReset()
  api.listRunLogs.mockReset()
  api.downloadPredictions.mockReset()
  // qa-fixes4 ITEM-5 (R3-help-8): the catalogue's short human name is the
  // method tab's document title.
  api.catalogueDetail.mockReset()
  api.catalogueDetail.mockResolvedValue({ title: 'Landmark Cox model' })
  sseHandlers = null
  platform.desktop = false
  api.getRun.mockResolvedValue(runFixture())
  api.getPredictions.mockResolvedValue(predictionsOf())
  api.downloadPredictions.mockResolvedValue('patient_id,lm-cox-a,rsf-b\nS0001,0.3,0.29\n')
  api.streamRun.mockImplementation(
    (_params: unknown, callbacks?: { SSE?: Record<string, (data: unknown) => void> }) => {
      sseHandlers = callbacks?.SSE ?? null
      return new Promise<void>(() => {})
    },
  )
  api.listRunLogs.mockResolvedValue({ lines: [], next_seq: 0, total: 0 })
  state().reset()
})

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="test-location">{location.pathname}</div>
}

function renderPage(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/analysis/:runId/results" element={<div data-testid="test-g" />} />
        <Route path="/analysis/:runId/results/compare" element={<MethodResultsPage />} />
        <Route path="/analysis/:runId/results/methods/:methodId" element={<MethodResultsPage />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** The loaded H screen (compare route by default): header + tabs + table + aside. */
async function renderLoaded(entry = '/analysis/run-1/results/compare') {
  const view = renderPage(entry)
  await waitFor(() => {
    expect(view.getByTestId('txr-results-method')).toBeTruthy()
  })
  return view
}

/** The kit Tabs' active-state marker (`data-state="active"` on the trigger). */
function activeOf(testid: string): string | null {
  return document.querySelector(`[data-testid="${testid}"]`)?.getAttribute('data-state') ?? null
}

describe('MethodResultsPage (TEST-UR-7 — the H screen)', () => {
  it('renders the H board: header (H label), method + outcome tabs, bars table, aside, saved-in line', async () => {
    const view = await renderLoaded()
    expect(view.getByTestId('txr-results-download').textContent).toBe(
      'Download predictions (CSV)',
    )
    expect(view.getByTestId('txr-results-subtitle').textContent).toContain(
      `${FINISHED_IDS.length} of ${FINISHED_IDS.length + 1} methods finished`,
    )
    expect(activeOf('txr-results-method-tab-compare')).toBe('active')
    for (const id of FINISHED_IDS) {
      expect(view.getByTestId(`txr-results-method-tab-${id}`)).toBeTruthy()
    }
    expect(view.getByTestId('txr-results-outcome-tab-pfs').textContent).toBe(
      'Progression or death by day 238',
    )
    expect(view.getByTestId('txr-results-outcome-tab-response').textContent).toBe(
      'No response by day 56',
    )
    expect(view.getByTestId('txr-bars')).toBeTruthy()
    // ITEM-6 (results-r3 R3-results-11): the bars card is the phone scroll
    // box (the class the index.css phone rules target).
    expect(view.getByTestId('txr-bars').parentElement?.className).toContain(
      'txr-results-table-box',
    )
    expect(view.getByTestId('txr-results-care').textContent).toContain(
      `learned on your ${PATIENTS.length + 160} patients`,
    )
    // qa-fixes4 ITEM-1 (results-r3 R3-results-2): the aside's saved-in line
    // and its open-folder action are GONE — the run dir is an internal host
    // fact and appears nowhere on the compare/method pages, in web and
    // desktop mode alike.
    expect(view.queryByTestId('txr-results-saved-in')).toBeNull()
    expect(view.queryByTestId('txr-results-open-folder')).toBeNull()
    expect(view.container.textContent).not.toContain('/home/u/.txresbench/analysis-2026-11-06-0000/')
  })

  it('resolves a reuse-run method link typed with the visible model NAME (R3-results-7)', async () => {
    // A reuse run's method id is the saved model's uuid while the page shows
    // the model name — a typed/bookmarked link carrying the name resolves.
    const predictions = predictionsOf()
    predictions.methods[0] = {
      ...predictions.methods[0],
      method_id: 'c151fec5-d8a0-4de1-95ee-4d9ad99c6b86',
      label: 'My saved model',
    }
    // The array-arm read through the wire union artifact (the bare-number
    // arm is the openapi-generator artifact — see the types.test.ts note).
    const methodProb = predictions.methods[0].probabilities as unknown as Array<number | null>
    predictions.average = wireArray<number>(PATIENTS.map((_, p) => methodProb[p] ?? 0))
    api.getPredictions.mockResolvedValue(predictions)
    const view = renderPage('/analysis/run-1/results/methods/My%20saved%20model')
    await waitFor(() => expect(view.getByTestId('txr-results-method-heading')).toBeTruthy())
    expect(view.queryByTestId('txr-results-method-not-found')).toBeNull()
    expect(view.getByTestId('txr-results-method-heading').textContent).toContain('My saved model')
  })

  it('the document title of a method tab is the catalogue\'s short human name, not the wire id (R3-help-8)', async () => {
    await act(async () => {
      renderPage('/analysis/run-1/results/methods/lm-cox-a')
    })
    // The lookup is made for the method id.
    expect(api.catalogueDetail).toHaveBeenCalledWith({ method_id: 'lm-cox-a' })
    await waitFor(() => expect(document.title).toBe('Landmark Cox model — TxResBench'))

    // A non-catalogue method (a saved model's id): the catalogue rejects,
    // the title falls back to the column label — never a blank "Method".
    api.catalogueDetail.mockRejectedValue(httpError(404))
    const { unmount } = renderPage('/analysis/run-1/results/methods/lm-cox-a')
    await waitFor(() => expect(document.title).toBe('lm-cox-a — TxResBench'))
    unmount()
  })

  it('selects the active method tab from the URL segment (compare / method / unknown method, no crash)', async () => {    const view = await renderLoaded()
    expect(activeOf('txr-results-method-tab-compare')).toBe('active')

    cleanup()
    const one = await renderLoaded('/analysis/run-1/results/methods/lm-cox-a')
    expect(activeOf('txr-results-method-tab-lm-cox-a')).toBe('active')
    expect(activeOf('txr-results-method-tab-compare')).toBe('inactive')
    expect(one.queryByTestId('txr-compare-card')).toBeNull()
    // a one-method tab is its own view: ONE column, no outcome tabs, the
    // method's own heading + facts card (RES-11). The per-row value boxes
    // repeat the column id (one per patient), so the count asserts the
    // column's presence/absence.
    expect(one.queryAllByTestId('txr-bars-lm-cox-a').length).toBeGreaterThan(0)
    expect(one.queryAllByTestId('txr-bars-lm-cox-b')).toHaveLength(0)
    expect(one.queryByTestId('txr-results-outcome')).toBeNull()
    expect(one.getByTestId('txr-results-method-heading').textContent).toContain('lm-cox-a')
    expect(one.getByTestId('txr-results-method-facts')).toBeTruthy()

    cleanup()
    // The not-found state carries no tablist (the method tabs belong to a
    // finished method of this run) — `renderLoaded` waits on the tablist, so
    // its poller would time out here; the missing route waits on its own
    // state block instead.
    const missing = renderPage('/analysis/run-1/results/methods/no-such-method')
    await waitFor(() => {
      expect(missing.getByTestId('txr-results-method-not-found')).toBeTruthy()
    })
    expect(missing.queryByTestId('txr-results-method')).toBeNull()
    expect(missing.getByTestId('txr-results-method-not-found').textContent).toContain(
      'This method could not be found in this run',
    )
  })

  it('navigates through the path builders on a tab click (compare ↔ method)', async () => {
    const view = await renderLoaded()
    await act(async () => {
      fireEvent.pointerDown(view.getByTestId('txr-results-method-tab-lm-cox-a'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(view.getByTestId('txr-results-method-tab-lm-cox-a'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(view.getByTestId('test-location').textContent).toBe(
        '/analysis/run-1/results/methods/lm-cox-a',
      )
    })
    await act(async () => {
      fireEvent.pointerDown(view.getByTestId('txr-results-method-tab-compare'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(view.getByTestId('txr-results-method-tab-compare'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(view.getByTestId('test-location').textContent).toBe(
        '/analysis/run-1/results/compare',
      )
    })
  })

  it('renders the bar table sorted by the first method with per-method bars + percents', async () => {
    const view = await renderLoaded()
    await act(async () => {
      TxrResults.setPatientLimit(5)
      await Promise.resolve()
    })
    // A's (lm-cox-a) descending top window: S0002, S0006, S0004, S0009, S0012.
    const rows = Array.from(
      view.container.querySelectorAll('[data-testid^="txr-bars-row-"]'),
    ).map(el => el.getAttribute('data-testid'))
    expect(rows).toEqual([
      'txr-bars-row-S0002',
      'txr-bars-row-S0006',
      'txr-bars-row-S0004',
      'txr-bars-row-S0009',
      'txr-bars-row-S0012',
    ])
    // The first row's values: 91% for A, 85% for B, and A is the sort column.
    const row = view.getByTestId('txr-bars-row-S0002')
    const aBox = within(row).getByTestId('txr-bars-lm-cox-a')
    expect(aBox.textContent).toContain('91%')
    expect(within(row).getByTestId('txr-bars-rsf-b').textContent).toContain('85%')
    expect(within(row).getAllByRole('progressbar').length).toBe(2)
    expect(view.getByTestId('txr-bars-footer').textContent).toContain(
      'Chance of treatment failure by day 238, sorted by the first method. Showing 5 of 12.',
    )
  })

  it('raises the row cap on "Show all M" (the store patient limit, re-windowed)', async () => {
    const view = await renderLoaded()
    await act(async () => {
      TxrResults.setPatientLimit(5)
      await Promise.resolve()
    })
    fireEvent.click(view.getByTestId('txr-bars-show-more'))
    expect(state().patientLimit).toBe(-1)
    await waitFor(() => {
      expect(view.getByTestId('txr-bars-footer').textContent).toContain('Showing 12 of 12.')
    })
    expect(view.queryByTestId('txr-bars-show-more')).toBeNull()
  })

  it('renders the compare card sentences and the divergent toggle filters the table rows', async () => {
    const view = await renderLoaded()
    const card = view.getByTestId('txr-compare-card')
    expect(card.textContent).toContain(
      'Both methods put S0002, S0006 and S0009 among their five highest chances.',
    )
    expect(card.textContent).toContain(
      'They differ most for S0005 (35% and 57%), S0004 (71% and 52%) and S0002 (91% and 85%).',
    )
    fireEvent.click(view.getByTestId('txr-compare-divergent-toggle'))
    expect(state().divergentOnly).toBe(true)
    await waitFor(() => {
      // Only the two diverging patients; the report's rows are the A-sorted order.
      const rows = Array.from(
        view.container.querySelectorAll('[data-testid^="txr-bars-row-"]'),
      ).map(el => el.getAttribute('data-testid'))
      expect(rows).toEqual(['txr-bars-row-S0004', 'txr-bars-row-S0005'])
      expect(view.getByTestId('txr-bars-footer').textContent).toContain('Showing 2 of 2.')
    })
    const toggle = view.getByTestId('txr-compare-divergent-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(state().divergentOnly).toBe(false)
    })
  })

  it('the one-method tab shows no compare card and no divergent toggle', async () => {
    const view = await renderLoaded('/analysis/run-1/results/methods/rsf-b')
    expect(view.queryByTestId('txr-compare-card')).toBeNull()
    expect(view.queryByTestId('txr-compare-divergent-toggle')).toBeNull()
    expect(view.getByTestId('txr-bars-footer').textContent).toContain(
      'sorted by the first method. Showing 12 of 12.',
    )
  })

  it('the compare picker drives the card and the divergent filter (R2-07 — the card was always the first two)', async () => {
    const view = await renderLoaded()
    // The default pair is the first two columns, named in the two selects.
    expect(view.getByTestId('txr-compare-picker-a').textContent).toContain('lm-cox-a')
    expect(view.getByTestId('txr-compare-picker-b').textContent).toContain('rsf-b')
    // Picking the other select's column swaps (the pair is never A == B):
    // the card, the report and the divergent table all follow the pair.
    await act(async () => {
      fireEvent.pointerDown(view.getByTestId('txr-compare-picker-a'), {
        button: 0,
        pointerType: 'mouse',
      })
      fireEvent.click(view.getByTestId('txr-compare-picker-a'))
      await Promise.resolve()
    })
    const option = document.querySelector<HTMLElement>(
      '[role="option"][data-testid="txr-compare-picker-a-opt-rsf-b"]',
    )!
    expect(option).not.toBeNull()
    await act(async () => {
      fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
      fireEvent.mouseDown(option, { button: 0 })
      fireEvent.click(option)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(view.getByTestId('txr-compare-card').textContent).toContain(
        'How rsf-b and lm-cox-a compare',
      )
      // The swapped pair reverses the two percents the card names.
      expect(view.getByTestId('txr-compare-card').textContent).toContain(
        'They differ most for S0005 (57% and 35%)',
      )
    })
    fireEvent.click(view.getByTestId('txr-compare-divergent-toggle'))
    await waitFor(() => {
      // The divergent rows are now sorted by the FIRST of the pair (rsf-b):
      // S0005 (0.84) before S0004 (0.52) — the old first-two order was the
      // other way around.
      const rows = Array.from(
        view.container.querySelectorAll('[data-testid^="txr-bars-row-"]'),
      ).map(el => el.getAttribute('data-testid'))
      expect(rows).toEqual(['txr-bars-row-S0005', 'txr-bars-row-S0004'])
    })
  })

  it('the outcome tabs switch the column set through the page (pfs → response single column)', async () => {
    const view = await renderLoaded()
    const responseTab = view.getByTestId('txr-results-outcome-tab-response')
    await act(async () => {
      fireEvent.pointerDown(responseTab, { button: 0, pointerType: 'mouse' })
      fireEvent.click(responseTab)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(state().outcomeTab).toBe('response')
    })
    expect(view.getByTestId('txr-bars-footer').textContent).toContain(
      'Chance of no response by day 56, sorted by the first method.',
    )
    expect(view.container.querySelector('[data-testid="txr-bars-rsf-b"]')).toBeNull()
    expect(view.container.querySelector('[data-testid="txr-bars-resp-c"]')).toBeTruthy()
  })

  it('the chance link opens the dialog whose text derives from the endpoint/horizon + prob-source mix', async () => {
    const view = await renderLoaded()
    fireEvent.click(view.getByTestId('txr-results-chance-link'))
    await waitFor(() => {
      expect(screen.getByTestId('txr-chance-dialog')).toBeTruthy()
    })
    const dialog = screen.getByTestId('txr-chance-dialog')
    expect(dialog.textContent).toContain('How the chance is calculated')
    expect(dialog.textContent).toContain(
      "Each method's chance of progression or death by day 238",
    )
    expect(dialog.textContent).toContain(
      '1 of the 3 methods were recalibrated on your patients before making these chances.',
    )
    expect(state().chanceDialogOpen).toBe(true)
  })

  it('the saved-in line is gone in web AND desktop mode (qa-fixes4 ITEM-1)', async () => {
    const view = await renderLoaded()
    expect(view.queryByTestId('txr-results-saved-in')).toBeNull()
    expect(view.queryByTestId('txr-results-open-folder')).toBeNull()
    expect(view.container.textContent).not.toContain('/home/u/.txresbench/analysis-2026-11-06-0000/')
    cleanup()
    platform.desktop = true
    const desktop = await renderLoaded()
    expect(desktop.queryByTestId('txr-results-saved-in')).toBeNull()
    expect(desktop.queryByTestId('txr-results-open-folder')).toBeNull()
    expect(desktop.container.textContent).not.toContain('/home/u/.txresbench/analysis-2026-11-06-0000/')
  })

  it('the one-method header saves THIS model (finished + produced) and emits txr:save-one-model-requested', async () => {
    const run = runFixture()
    run.models = modelsFor('lm-cox-a')
    api.getRun.mockResolvedValue(run)
    const payloads: AppEvents['txr:save-one-model-requested'][] = []
    const off = useEventBusStore
      .getState()
      .on('txr:save-one-model-requested', e => void payloads.push(e))
    try {
      const view = await renderLoaded('/analysis/run-1/results/methods/lm-cox-a')
      expect(view.getByTestId('txr-results-save-one-model').textContent).toBe('Save this model')
      expect(view.queryByTestId('txr-results-save-models')).toBeNull()
      fireEvent.click(view.getByTestId('txr-results-save-one-model'))
      await waitFor(() => expect(payloads).toHaveLength(1))
      expect(payloads[0]).toEqual({
        type: 'txr:save-one-model-requested',
        runId: 'run-1',
        methodId: 'lm-cox-a',
        timestamp: expect.any(Number),
      })
    } finally {
      off()
    }
  })

  it('hides the save helpers until a model exists: one-method tab without a produced model', async () => {
    const view = await renderLoaded('/analysis/run-1/results/methods/lm-cox-a')
    expect(view.queryByTestId('txr-results-save-one-model')).toBeNull()
    expect(view.queryByTestId('txr-results-save-models')).toBeNull()
  })

  it('the compare tab shows the run-level Save the models (N) when models exist', async () => {
    const run = runFixture()
    run.models = modelsFor('lm-cox-a')
    api.getRun.mockResolvedValue(run)
    const view = await renderLoaded()
    expect(view.getByTestId('txr-results-save-models').textContent).toBe(
      `Save the models (${run.models.length})`,
    )
    expect(view.queryByTestId('txr-results-save-one-model')).toBeNull()
  })

  it('the banner log action opens the method log dialog: backfill with method_id, live append, copy, auto-scroll', async () => {
    const lines: TxrRunLogLine[] = [
      { seq: 1, method_id: CANNOT_RUN_ID, stream: 'engine', content: 'LDH is not in your measurements', created_at: '2026-11-06T00:01:00Z' },
      { seq: 2, method_id: CANNOT_RUN_ID, stream: 'stderr', content: 'marker column not found', created_at: '2026-11-06T00:01:01Z' },
    ]
    api.listRunLogs.mockResolvedValue({ lines, next_seq: 3, total: 3 })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const view = await renderLoaded()
    fireEvent.click(view.getByTestId('txr-results-show-log-cox-nomarker'))
    await waitFor(() => {
      expect(screen.getByTestId('txr-log-dialog')).toBeTruthy()
    })
    expect(api.listRunLogs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1', method_id: CANNOT_RUN_ID }),
    )
    await waitFor(() => {
      const pre = screen.getByTestId('txr-log-dialog-pre') as HTMLPreElement
      expect(pre.textContent).toContain('LDH is not in your measurements')
      expect(pre.textContent).toContain('marker column not found')
    })
    // Live frame: the SSE's log handler appends to the store while open.
    await act(async () => {
      emit('log', { seq: 3, method_id: CANNOT_RUN_ID, stream: 'engine', content: 'live line from the run', created_at: '2026-11-06T00:02:00Z' })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('txr-log-dialog-pre').textContent).toContain('live line from the run')
    })
    // Auto-scroll follows the newest line (the JobDetail idiom: scrollTop = scrollHeight).
    const pre = screen.getByTestId('txr-log-dialog-pre') as HTMLPreElement
    Object.defineProperty(pre, 'scrollHeight', { value: 700, configurable: true })
    await act(async () => {
      emit('log', { seq: 4, method_id: CANNOT_RUN_ID, stream: 'engine', content: 'another line', created_at: '2026-11-06T00:02:01Z' })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(pre.scrollTop).toBe(700)
    })
    fireEvent.click(screen.getByTestId('txr-log-dialog-copy'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        ['LDH is not in your measurements', 'marker column not found', 'live line from the run', 'another line'].join('\n'),
      )
    })
  })

  it('the whole-run dialog backfills without a method filter (openLog(null) — ITEM-5 note (s))', async () => {
    const view = await renderLoaded()
    await act(async () => {
      TxrResults.openLog(null)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('txr-log-dialog')).toBeTruthy()
    })
    expect(api.listRunLogs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1', limit: 200 }),
    )
    expect(api.listRunLogs.mock.calls[0][0]).not.toHaveProperty('method_id')
  })

  it('hides the start-up noise by default and reveals it behind Show technical output (R2-10 rest)', async () => {
    const lines: TxrRunLogLine[] = [
      { seq: 1, method_id: CANNOT_RUN_ID, stream: 'stderr', content: '/bin/bash: warning: setlocale: LC_ALL: cannot change locale (C.UTF-8)', created_at: '2026-11-06T00:01:00Z' },
      { seq: 2, method_id: CANNOT_RUN_ID, stream: 'engine', content: 'LDH is not in your measurements', created_at: '2026-11-06T00:01:01Z' },
    ]
    api.listRunLogs.mockResolvedValue({ lines, next_seq: 3, total: 2 })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const view = await renderLoaded()
    fireEvent.click(view.getByTestId('txr-results-show-log-cox-nomarker'))
    await waitFor(() => {
      expect(screen.getByTestId('txr-log-dialog')).toBeTruthy()
    })
    // The setlocale line is hidden; the run's own line stays; the count
    // states the bound honestly (the K dialog's bytes).
    await waitFor(() => {
      const pre = screen.getByTestId('txr-log-dialog-pre')
      expect(pre.textContent).not.toContain('setlocale')
      expect(pre.textContent).toContain('LDH is not in your measurements')
    })
    expect(screen.getByTestId('txr-log-dialog-technical-count').textContent).toBe(
      '1 technical lines hidden',
    )
    // The switch reveals it (and the copy follows the visible view).
    const toggle = view.getByTestId('txr-log-dialog-technical')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByTestId('txr-log-dialog-pre').textContent).toContain('setlocale')
    fireEvent.click(screen.getByTestId('txr-log-dialog-copy'))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        '/bin/bash: warning: setlocale: LC_ALL: cannot change locale (C.UTF-8)\nLDH is not in your measurements',
      ),
    )
  })

  it('renders the 409 empty-heatmap state on the H route (banner + counts + disabled download)', async () => {
    api.getPredictions.mockRejectedValueOnce(httpError(409))
    const view = renderPage('/analysis/run-1/results/compare')
    await waitFor(() => {
      expect(view.getByTestId('txr-results-download').hasAttribute('disabled')).toBe(true)
    })
    expect(view.queryByTestId('txr-bars')).toBeNull()
    expect(view.queryByTestId('txr-results-loading')).toBeNull()
    expect(view.queryByTestId('txr-results-error')).toBeNull()
    expect(view.queryByTestId('txr-results-run-failed')).toBeNull()
  })

  it('renders the honest failure state on the H route for a terminal failed run (TEST-QF-1, RES-02)', async () => {
    const run = runFixture()
    run.status = 'failed'
    run.methods = run.methods.map(m => ({
      ...m,
      state: 'failed' as const,
      reason: {
        code: 'ENV_UNREADY',
        detail: 'the method environment is not installed on this computer',
      },
    }))
    run.counts = { ...run.counts, finished: 0, failed: run.methods.length, running: 0, cannot_run: 0 }
    api.getRun.mockResolvedValue(run)
    api.getPredictions.mockRejectedValueOnce(httpError(409))
    const view = renderPage('/analysis/run-1/results/compare')
    await waitFor(() => expect(view.getByTestId('txr-results-run-failed')).toBeTruthy())
    const block = view.getByTestId('txr-results-run-failed')
    expect(block.textContent).toContain('This run failed')
    expect(block.textContent).toContain(
      'the method environment is not installed on this computer',
    )
    const subtitle = view.getByTestId('txr-results-subtitle').textContent ?? ''
    expect(subtitle).not.toContain('learned from')
    expect(subtitle).not.toContain('took')
  })

  it('renders the not-found state on 404 (no crash, New-analysis CTA)', async () => {
    api.getRun.mockRejectedValueOnce(httpError(404))
    const view = renderPage('/analysis/run-1/results/compare')
    await waitFor(() => expect(view.getByTestId('txr-results-not-found')).toBeTruthy())
    expect(view.queryByTestId('txr-results-error')).toBeNull()
    expect(view.queryByTestId('txr-bars')).toBeNull()
  })

  it('renders the loading skeleton before the detail resolves', async () => {
    let resolveRun: (value: TxrRunDetail) => void = () => {}
    api.getRun.mockImplementation(
      () => new Promise<TxrRunDetail>(resolve => { resolveRun = resolve }),
    )
    const view = renderPage('/analysis/run-1/results/compare')
    expect(view.getByTestId('txr-results-loading')).toBeTruthy()
    await act(async () => {
      resolveRun(runFixture())
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => expect(view.getByTestId('txr-results-method')).toBeTruthy())
  })
})
