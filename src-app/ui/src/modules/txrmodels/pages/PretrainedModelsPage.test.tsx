// @vitest-environment jsdom
/**
 * TEST-MOD-09 [acceptance] [invariant: INV-1, INV-3, INV-8] — screen D
 * (ITEM-6) + the D arm of TEST-MOD-32 (the CONS-UM-24/13 Run flow) — the
 * `PretrainedModelsPage` suite (PROV-UI-MODELS-5).
 *
 * Pinned behaviors:
 *
 * - the header: Step 3 of 3 + the board title + the "Checked against your
 *   file: …" line from the CONS-UM-11 validation (the FIXTURE's own
 *   counts — the boards' numbers are design examples, never constants)
 *   + the "N can run, M cannot" totals from the eligibility response
 *   (the board's grouping: the some rows count as runnable);
 * - the page hosts the SHARED `TxrSelectList` (INV-1): the fixture rows
 *   (mono id · day, the Published / Learned here chips, the performance
 *   text, the verdicts + details, the time, Model card), the four D
 *   chips filter the rows (the source-level predicates), the sort
 *   control, the bottom bar with the research notice (INV-3) and WITHOUT
 *   a save-models checkbox;
 * - the download column: checking a card whose asset is not on this
 *   computer STARTS its download (models.md: downloaded when selected),
 *   the host's `TxrDownloadState` shows bytes + percent + spinner, and
 *   the Run click is REFUSED while the card is downloading/failed (the
 *   selection is kept — DEC-8 — and the inline gate line names the
 *   reason); a provider verify failure surfaces error + Retry;
 * - the Model-card dialog: the row action opens `TxrModelCardDialog`
 *   with the per-id payload (source paper TEXT — no anchor, the INV-5
 *   posture; licence; data sources; research-use notice);
 * - the Run flow (TEST-MOD-32): install-if-needed (a bundled card is
 *   installed at Run time — PROV-PC-7), the installed uuids are RESOLVED
 *   FIRST (`Models.resolveModels`) and the response's assets pass
 *   through VERBATIM into `CreateRunRequest.model_ids` (never bare
 *   uuids), the config carries the first selected card's endpoint +
 *   horizon (the D screen has no settings controls) and the intake's
 *   decision day, then `createRun` → `runningPath`; a resolve failure
 *   (404 / 409) surfaces inline and the run is NOT created.
 *
 * Every fixture value is synthetic (INV-4): the module's own fixture
 * catalogue (ps-<k>, 42 patients, day 60) and a test-local run catalogue
 * (rc-<k>) for the run-flow rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Button } from '@txresbench/kit'
import '@/core/actions/builtin/stepActions'
import '@/core/actions/builtin/appActions'
import '@/core/actions/builtin/modelRunActions'
import { runAction } from '@/core/actions/defineAction'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { instancesOfType } from '@/core/actions/instanceRegistry'
import type {
  PretrainedEligibilityResponse,
  PretrainedListResponse,
  PretrainedModel,
  PretrainedSummary,
  ResolveResponse,
  TxrRunSummary,
  ValidationResponse,
} from '@/api-client/types'
import {
  STEP_BACK_DIALOG_OPEN,
  STEP_BACK_STARTING_REASON,
  useStepBack,
  useStepTrailStore,
  useTxrIntakeStore,
} from '@/modules/txrintake'
import { DEMO_PRETRAINED_CHIP } from '@/modules/demo/copy'
import { resetDemoMode, seedDemoMode } from '@/modules/demo/test-utils/demoSeed'
import {
  TXRMODELS_INVENTORY,
  TXRMODELS_SAVED,
  TXRMODELS_PRETRAINED,
  TXRMODELS_PRETRAINED_ELIGIBILITY,
} from '../fixtures'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { RESEARCH_NOTICE } from '../lib/format'
import { PretrainedModelsPage } from './PretrainedModelsPage'

// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Checkbox/Select) construct one on pointer interaction, which would
// throw and swallow the click. A MouseEvent subclass is the standard
// jsdom stand-in (the shared-list suite's shim, copied).
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

// jsdom has no ResizeObserver either; the kit's Descriptions measures its
// width with one (the TxrAboutDialog suite's own stub).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  eligibility: vi.fn(),
  getModel: vi.fn(),
  downloadModel: vi.fn(),
  listDownloads: vi.fn(),
  installModel: vi.fn(),
  resolveModels: vi.fn(),
  createRun: vi.fn(),
  listSaved: vi.fn(),
  listSets: vi.fn(),
  savedEligibility: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Pretrained: {
      listModels: api.listModels,
      checkEligibility: api.eligibility,
      getModel: api.getModel,
      downloadModel: api.downloadModel,
      listDownloads: api.listDownloads,
      installModel: api.installModel,
    },
    Models: {
      resolveModels: api.resolveModels,
      listModels: api.listSaved,
      checkEligibility: api.savedEligibility,
    },
    ModelSets: {
      listSets: api.listSets,
    },
    Txr: {
      createRun: api.createRun,
    },
  },
}))

// ── jsdom has no layout, and the shared list is a VIRTUALIZED window ──
// The virtualizer reads the scrollport's offsetHeight and each row's
// measured height; jsdom answers 0 to all of them, so the layout is STATED
// (the ChooseMethodsPage suite's own idiom): a tall viewport, every item
// measuring the row height the list estimates. ITEM-3 moves the scrollport
// from the kit ScrollArea's overlayscrollbars viewport (the standalone
// path) to the frame's region (the layout split), so both are stated.
const VIEWPORT_H = 1400
const ROW_H = 56

const isViewport = (el: HTMLElement): boolean =>
  el.hasAttribute('data-overlayscrollbars-viewport') ||
  el.classList.contains('txr-scroll-region')

let restoreLayout: (() => void) | null = null

function statedLayout(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const saved = ['offsetHeight', 'clientHeight', 'scrollHeight'].map(
    k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  )
  const define = (key: string, get: (el: HTMLElement) => number): void => {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement): number {
        return get(this)
      },
    })
  }
  define('offsetHeight', el =>
    isViewport(el) ? VIEWPORT_H : el.hasAttribute('data-index') ? ROW_H : 0,
  )
  define('clientHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  define('scrollHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  restoreLayout = () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d)
      else delete proto[k]
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (all synthetic — INV-4)
// ─────────────────────────────────────────────────────────────────────────────

/** The seeded validation: the module fixture inventory (42 patients, 4
 *  markers, day 60) + the draw-days the header line spells. */
function validation(): ValidationResponse {
  return {
    inventory: TXRMODELS_INVENTORY,
    markers: [],
    measurements: { rows: 168, patients: 42, distinct_draw_days: [0, 14, 28, 56] },
    patients: { rows: 42, with_primary_outcome: 40, primary_outcome_events: 40 },
    problems: [],
  }
}

function seedIntake(): void {
  useTxrIntakeStore.setState({
    intent: 'pretrained',
    mode: 'predict',
    patients: null,
    measurements: null,
    predictMeasurements: {
      source: { name: 'predict.csv', format: 'csv' },
      table: {
        source: { name: 'predict.csv', format: 'csv' },
        header_row: 1,
        columns: ['patient_id', 'ldh'],
        rows: [['P0001', '42']] as (string | null)[][],
      },
      inspection: null,
      problems: [],
      prepared: true,
      joinOffers: [],
      vocabOffers: [],

      columnOffers: [],
    },
    joins: [],
    mapping: [],
    parameters: { decision_day: 60, baseline_max_day: 0 },
    validation: validation(),
  })
}

/** One test-local run-flow card (the rc-<k> namespace). */
function runCard(k: number, state: PretrainedSummary['state']): PretrainedSummary {
  return {
    id: `rc-${k}`,
    version: '1.0.0',
    kind: 'published-rule',
    name: `rc-${k} rule`,
    description: 'Rule from the paper; colorectal',
    method_id: `m${k}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    decision_day: 60,
    endpoint: 'pfs',
    horizon: 240,
    paper: { journal: 'Ann Oncol', year: 2021, doi: `10.0000/rc-${k}` },
    transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3 },
    warnings: [],
    research_notice: true,
    licence: 'MIT',
    asset: {
      bundled: state === 'bundled',
      file: `rc-${k}@1.0.0.txr`,
      sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      size_bytes: 4_600_000,
    },
    state,
    installed_model_id:
      state === 'installed' ? `c0000000-0000-4000-8000-0000000000${String(k).padStart(2, '0')}` : undefined,
  }
}

/** The run catalogue's verdicts: rc-1/rc-2 can run, rc-3 some. */
function runEligibility(): PretrainedEligibilityResponse {
  return {
    total_fit: 2,
    total_some: 1,
    total_cannot: 0,
    models: [
      {
        id: 'rc-1',
        status: 'can_run',
        coverage: { eligible: 42, total: 42, fraction: 1 },
        estimate_quality: 'estimate',
        estimated_seconds: 45,
        min_draws: { required: 1, met: 42, unmet_patients: 0 },
        missing_markers: [],
        reasons: [],
      },
      {
        id: 'rc-2',
        status: 'can_run',
        coverage: { eligible: 42, total: 42, fraction: 1 },
        estimate_quality: 'estimate',
        estimated_seconds: 60,
        min_draws: { required: 1, met: 42, unmet_patients: 0 },
        missing_markers: [],
        reasons: [],
      },
      {
        id: 'rc-3',
        status: 'can_run_some',
        coverage: { eligible: 39, total: 42, fraction: 39 / 42 },
        estimate_quality: 'estimate',
        estimated_seconds: 40,
        min_draws: { required: 3, met: 39, unmet_patients: 3 },
        missing_markers: [],
        reasons: [{ code: 'MIN_DRAWS_UNMET' }],
      },
    ],
  }
}

/** The resolved assets the resolve call returns (passed through verbatim). */
function resolvedAssets(): ResolveResponse {
  return {
    assets: [
      {
        model_id: 'c0000000-0000-4000-8000-000000000001',
        method_id: 'm1',
        method_version: '2.1.0',
        host_dir: '/models/rc-1',
        tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        contract: '2.0',
        env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
      },
      {
        model_id: 'c0000000-0000-4000-8000-000000000002',
        method_id: 'm2',
        method_version: '2.1.0',
        host_dir: '/models/rc-2',
        tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        contract: '2.0',
        env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
      },
    ],
  }
}

/** The card payload the Model-card dialog fetches (per-id PROV-PC-4). */
function cardPayload(id: string): PretrainedModel {
  return {
    id,
    name: `${id} rule`,
    description: 'Rule from the paper; colorectal',
    group: 'g-static-risk',
    group_label: 'Static risk',
    kind: 'published-rule',
    method_id: 'm2',
    method_version: '2.1.0',
    version: '1.0.0',
    licence: 'CC BY 4.0',
    research_notice: true,
    embeds_training_data: false,
    contract: '2.0',
    env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
    paper: {
      journal: 'Ann Oncol',
      year: 2021,
      doi: '10.0000/example',
      citation: 'Example A et al. A published rule for colorectal follow-up. Ann Oncol 2021;32:100-8. doi:10.0000/example',
    },
    needs: {
      decision_day: 60,
      endpoint: 'pfs',
      horizon: 240,
      task: 'survival',
      marker_facts: {
        count: 4,
        kind: 'any',
        marker_groups_required: [],
        min_draws: 2,
        needs_baseline: true,
        needs_detection_call: false,
        uses_history: 'landmark',
      },
      required_markers: {
        list_source: 'curated',
        match: 'all',
        min_fraction: 1,
        markers: [
          { id: 'ldh', id_system: 'loinc', name: 'LDH' },
          { id: 'cea', id_system: 'loinc', name: 'CEA' },
        ],
      },
      covariates: 'optional',
    },
    transfer: {
      metric: 'auc_rule',
      median: 0.71,
      n_cohorts: 3,
      cohorts: [
        { dataset: 'fixture-a', value: 0.68 },
        { dataset: 'fixture-b', value: 0.72 },
      ],
    },
    assay_warnings: [{ code: 'DRAW_INTERVAL', detail: 'The cohort drew at 3-weekly intervals.' }],
    data_sources: [{ dataset: 'fixture-open', access: 'open', licence: 'CC BY 4.0' }],
    asset: {
      bundled: false,
      file: `${id}@1.0.0.txr`,
      sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      signature: '',
      url: '',
      size_bytes: 4_600_000,
    },
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/pretrained-models']}>
      {/* The page's buttons run registered actions; their navigation goes
          through the router bridge, as in the app. */}
      <RouterBridge />
      <PretrainedModelsPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** Flush the pending microtasks (the mount fetches) + advance timers. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Check the row's checkbox (the shared list's own toggle). */
async function selectRow(key: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`txr-list-checkbox-${key}`))
    await Promise.resolve()
  })
  await settle(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  api.listModels.mockReset()
  api.eligibility.mockReset()
  api.getModel.mockReset()
  api.downloadModel.mockReset()
  api.listDownloads.mockReset()
  api.installModel.mockReset()
  api.resolveModels.mockReset()
  api.createRun.mockReset()
  api.listModels.mockResolvedValue({
    origin: 'embedded',
    generated_at: '2026-11-29T09:00:00Z',
    total: TXRMODELS_PRETRAINED.length,
    models: TXRMODELS_PRETRAINED,
  } as PretrainedListResponse)
  api.eligibility.mockResolvedValue(TXRMODELS_PRETRAINED_ELIGIBILITY)
  api.getModel.mockResolvedValue(cardPayload('ps-2'))
  api.downloadModel.mockImplementation(async ({ id }: { id: string }) => ({
    id,
    version: '1.0.0',
    state: 'downloading',
    bytes_downloaded: 10_000_000,
    bytes_total: 20_000_000,
    digest: undefined,
    cached: false,
    bundled: false,
  }))
  api.listDownloads.mockResolvedValue({
    downloads: [
      {
        id: 'ps-5',
        version: '1.0.0',
        state: 'downloading',
        bytes_downloaded: 10_000_000,
        bytes_total: 20_000_000,
        digest: undefined,
        cached: false,
        bundled: false,
      },
    ],
  })
  api.installModel.mockResolvedValue({
    catalogue_id: 'rc-2',
    licence: 'MIT',
    model_id: 'c0000000-0000-4000-8000-000000000002',
    size_bytes: 4_600_000,
    source: 'bundled',
    status: 'installed',
    version: '1.0.0',
  })
  api.resolveModels.mockResolvedValue(resolvedAssets())
  api.createRun.mockResolvedValue({ id: 'run-1' } as unknown as TxrRunSummary)
  // The other list (the saved models), read only by the no-models messages.
  api.listSaved.mockReset()
  api.listSets.mockReset()
  api.savedEligibility.mockReset()
  api.listSaved.mockResolvedValue({ models: [], total: 0 })
  api.listSets.mockResolvedValue({ sets: [], total: 0 })
  api.savedEligibility.mockResolvedValue({ models: [], total_fit: 0, total_some: 0, total_cannot: 0 })
  useTxrIntakeStore.getState().reset()
  useTxrModelsStore.getState().reset()
  seedIntake()
  statedLayout()
})

afterEach(() => {
  cleanup()
  restoreLayout?.()
  restoreLayout = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PretrainedModelsPage — TEST-MOD-09 (screen D)', () => {
  it('renders the Step-4 header, the checked-against line from the CONS-UM-11 validation and the verdict totals', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByText('Step 3 of 3')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Choose the models to run' })).toBeTruthy()
    // The look-ahead is shown, locked to the model's own (no field to type in).
    const horizon = screen.getByTestId('txr-models-d-horizon')
    expect(horizon.textContent).toMatch(/^Look ahead to: /)
    expect(horizon.querySelector('input')).toBeNull()
    expect(screen.getByTestId('txr-models-d-checked').textContent).toBe(
      'Checked against your file: 42 patients, 4 markers, draws at day 0, 14, 28 and 56. Pick as many as you like.',
    )
    // The board's grouping: fit + some = "can run", cannot stays.
    expect(screen.getByTestId('txr-models-d-totals').textContent).toBe(
      '6 can run, 1 cannot',
    )
  })

  it('hosts the shared list with fixture rows, the four chips, the sort and the notice — and no save-models checkbox', async () => {
    renderPage()
    await settle(0)
    // The row surface: mono id · day, the chip, the performance text, the
    // verdict, the time, the Model card action (INV-1's normalized rows).
    expect(screen.getByText('ps-1 \u00b7 day 60')).toBeTruthy()
    expect(screen.getAllByText('Published rule').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Learned here').length).toBeGreaterThan(0)
    expect(screen.getByText('other cohorts: AUC 0.74')).toBeTruthy()
    expect(screen.getByText('other cohorts: c-index 0.65')).toBeTruthy()
    expect(screen.getAllByText('not yet checked elsewhere').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Can run for some patients').length).toBeGreaterThan(0)
    expect(screen.getByText('needs Ki-67, not in your file')).toBeTruthy()
    expect(screen.getAllByText('under 1 min').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Model card').length).toBeGreaterThan(0)
    // The four host chips with the count over the whole catalogue.
    expect(screen.getByTestId('txr-list-filter-published').textContent).toBe('Published rules 4')
    expect(screen.getByTestId('txr-list-filter-learned').textContent).toBe(
      'Learned by the benchmark 3',
    )
    expect(screen.getByTestId('txr-list-filter-checked-2-plus').textContent).toBe(
      'Checked on 2 or more other cohorts 3',
    )
    // The sort control's options (the board's order).
    const sort = screen.getByTestId('txr-list-sort')
    expect(sort).toBeTruthy()
    // The bottom bar: notice present, save-models absent, Run label.
    expect(screen.getByText(RESEARCH_NOTICE)).toBeTruthy()
    expect(screen.queryByTestId('txr-list-save-models')).toBeNull()
    expect(screen.getByTestId('txr-list-run').textContent).toBe('Run 0 models')
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('0 models selected')
  })

  it('the bottom bar sits straight in the frame\u2019s bottom slot, never in a flex row that shrinks it', async () => {
    renderPage()
    await settle(0)
    const bar = screen.getByTestId('txr-list-bottom-bar')
    const slot = bar.closest<HTMLElement>('.txr-page-frame-bottom')
    expect(slot).not.toBeNull()
    expect(screen.getByTestId('txr-models-d-frame').contains(slot)).toBe(true)
    expect(bar.closest('.txr-page-footer-bar')).toBeNull()
    // Every box from the slot down to the bar is a block box: inside a flex
    // row the bar is only as wide as its content (it stayed 672 px wide at
    // the left of any wider window).
    const between: HTMLElement[] = []
    for (let el = bar.parentElement; el !== null && el !== slot; el = el.parentElement) between.push(el)
    expect(between.map(el => el.getAttribute('data-testid'))).toEqual(['txr-models-d-bar'])
    for (const el of [slot!, ...between]) expect(el.style.display).not.toBe('flex')
  })

  it('the chips filter the rows (the source-level predicates), and the bottom-bar total is the DEC-7 sum', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-checkbox-ps:ps-1'))
      fireEvent.click(screen.getByTestId('txr-list-checkbox-ps:ps-2'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('2 models selected')
    expect(screen.getByTestId('txr-list-total-time').textContent).toBe(
      'about 2 minutes in total',
    )
    expect(screen.getByTestId('txr-list-run').textContent).toBe('Run 2 models')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-published'))
      await Promise.resolve()
    })
    await settle(0)
    // The published-only view: ps-2 (Learned here) is gone, ps-1 stays.
    expect(screen.queryByTestId('txr-list-row-ps:ps-2')).toBeNull()
    expect(screen.getByTestId('txr-list-row-ps:ps-1')).toBeTruthy()
    // The selection is kept through the filter (the run is the selection,
    // never the view) — the count still reads both.
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('2 models selected')
  })

  it('checking a non-installed card starts its download, shows bytes + percent + spinner, and gates Run', async () => {
    renderPage()
    await settle(0)
    await selectRow('ps:ps-5')
    expect(api.downloadModel).toHaveBeenCalledWith({ id: 'ps-5' })
    // The strip shows the live download (bytes + percent + the widget).
    const strip = screen.getByTestId('txr-models-download-ps-5')
    expect(strip).toBeTruthy()
    expect(screen.getByTestId('txr-models-download-ps-5-bytes').textContent).toBe(
      'downloading · 9.5 MB of 19 MB',
    )
    expect(screen.getByTestId('txr-models-download-ps-5-pct').textContent).toBe('50%')
    // The Run click is REFUSED: no run is created, the inline gate names why.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-d-run-error').textContent).toBe(
      'A selected model is still downloading. Wait for it to finish, or uncheck it.',
    )
    // The selection is kept (DEC-8) — the card never silently drops.
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')
  })

  it('a provider verify failure surfaces the error + Retry and keeps Run gated until the human retries', async () => {
    api.listDownloads.mockResolvedValue({
      downloads: [
        {
          id: 'ps-5',
          version: '1.0.0',
          state: 'failed',
          bytes_downloaded: 20_000_000,
          bytes_total: 20_000_000,
          digest: undefined,
          cached: false,
          bundled: false,
          error: 'sha256 mismatch',
        },
      ],
    })
    renderPage()
    await settle(0)
    await selectRow('ps:ps-5')
    // One poll tick arrives and commits the terminal failure.
    await settle(2100)
    expect(screen.getByTestId('txr-models-download-ps-5-error').getAttribute('data-kind')).toBe('verify')
    expect(screen.getByTestId('txr-models-download-ps-5-error').textContent).toBe('sha256 mismatch')
    expect(screen.getByTestId('txr-models-download-ps-5-retry')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-d-run-error').textContent).toBe(
      "A selected model's download failed. Retry it, or uncheck it.",
    )
    // The Retry re-issues the download (the store's idempotent start).
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-download-ps-5-retry'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.downloadModel.mock.calls.length).toBe(2)
  })

  it('opens the Model-card dialog from the row action: source paper as TEXT (no link), licence, needs, notice', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-ps:ps-2-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.getModel).toHaveBeenCalledWith({ id: 'ps-2' })
    expect(screen.getByText('Example A et al. A published rule for colorectal follow-up. Ann Oncol 2021;32:100-8. doi:10.0000/example')).toBeTruthy()
    expect(screen.getByText('progression, death by day 240')).toBeTruthy()
    expect(screen.getByText('4 markers · a before-treatment draw · 2 or more draws')).toBeTruthy()
    expect(screen.getByText('LDH, CEA (curated)')).toBeTruthy()
    expect(screen.getByText('CC BY 4.0')).toBeTruthy()
    expect(screen.getByText('fixture-open · open data · CC BY 4.0')).toBeTruthy()
    // The dialog's own notice (the bottom bar renders the same board line
    // — the assertive query is the dialog's test-id, never a text scan).
    expect(screen.getByTestId('txr-models-card-notice').textContent).toBe(RESEARCH_NOTICE)
    // INV-5: the paper is TEXT — the dialog carries no anchor.
    const dialog = screen.getByTestId('txr-models-card-ps-2')
    expect(dialog.querySelector('a[href]')).toBeNull()
  })

  it('a 404 card (catalogue no longer serves the id) renders the not-found state, never a crash', async () => {
    api.getModel.mockRejectedValue({ status: 404, message: 'PRETRAINED_UNKNOWN' })
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-ps:ps-2-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-card-not-found').textContent).toBe(
      'This model is no longer in the catalogue.',
    )
  })

  it('renders the not-ready empty state when no predict file is validated (the inventory is the validation\u2019s)', async () => {
    useTxrIntakeStore.setState({ validation: null })
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-d-empty')).toBeTruthy()
    expect(screen.getByTestId('txr-models-d-empty').textContent).toContain(
      'Add the patients\u2019 measurements you want to predict first.',
    )
    // R2-08: the pretrained empty state names WHICH models this screen
    // lists — the saved-models screen and this one used to render the
    // identical empty block, so a pretrained direct visit had no clue it
    // was not the saved-models screen.
    expect(screen.getByTestId('txr-models-d-empty-note').textContent).toContain(
      'The ready-made models are listed here once the file checks out',
    )
    // RES-20: a direct visit is not ON step 4 (the flow has not reached
    // it) and counts nothing — the step line and the "…" totals are gone.
    expect(screen.queryByText('Step 3 of 3')).toBeNull()
    expect(screen.queryByTestId('txr-models-d-totals')).toBeNull()
    // The CTA is the step that unlocks this screen — the predict-files
    // step, never the landing page (the old "Go to the start").
    expect(screen.getByTestId('txr-models-d-empty-cta').textContent).toBe(
      'Go to the measurements step',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-d-empty-cta'))
    })
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
    // No verdict request against a null inventory (DEC-6: the eligibility
    // call is never built without the intake's object).
    expect(api.eligibility).not.toHaveBeenCalled()
  })

  it('renders the honest no-catalogue state when the published catalogue is empty (ITEM-5, the pretrained arm)', async () => {
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 0,
      models: [],
    })
    renderPage()
    await settle(0)
    // The catalogue is loaded and empty — never "No models to show" in a
    // bare list; the state says what the user's saved models hold for this
    // file (here: none) and hands the user on.
    expect(screen.getByTestId('txr-models-d-no-catalogue')).toBeTruthy()
    expect(screen.getByTestId('txr-models-d-no-catalogue').textContent).toContain(
      'No ready-made models yet',
    )
    expect(screen.getByTestId('txr-models-d-no-catalogue-intro').textContent).toBe(
      'Ready-made models are already trained by the TxResBench team, so they predict without learning from your data. None have been released yet.',
    )
    expect(screen.queryByTestId('txr-list')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-d-no-catalogue-action-your-models'))
    })
    expect(screen.getByTestId('route-location').textContent).toBe('/models')
  })
})

describe('PretrainedModelsPage — the D Run flow (TEST-MOD-32 / CONS-UM-24 + 13)', () => {
  function runCatalogue(): PretrainedSummary[] {
    return [runCard(1, 'installed'), runCard(2, 'bundled'), runCard(3, 'not_downloaded')]
  }

  function setRunCatalogue(): void {
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 3,
      models: runCatalogue(),
    } as PretrainedListResponse)
    api.eligibility.mockResolvedValue(runEligibility())
  }

  it('installs the bundled card, resolves FIRST, passes the assets verbatim and navigates to runningPath', async () => {
    setRunCatalogue()
    renderPage()
    await settle(0)
    await selectRow('ps:rc-1')
    await selectRow('ps:rc-2')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    // install-if-needed: only the BUNDLED card is installed (rc-1 installed).
    expect(api.installModel).toHaveBeenCalledTimes(1)
    expect(api.installModel).toHaveBeenCalledWith({ id: 'rc-2' })
    // resolve FIRST, then create — the response's assets verbatim.
    expect(api.resolveModels).toHaveBeenCalledWith({
      model_ids: [
        'c0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-000000000002',
      ],
    })
    expect(api.resolveModels.mock.invocationCallOrder[0]).toBeLessThan(
      api.createRun.mock.invocationCallOrder[0],
    )
    const request = api.createRun.mock.calls[0][0] as {
      mode: string
      config: Record<string, unknown>
      model_ids: unknown[]
      input: unknown
    }
    expect(request.mode).toBe('reuse')
    expect(request.config).toEqual({
      endpoint: 'pfs',
      decision_day: 60,
      look_ahead_day: 240,
      covariates: false,
      at_a_time: 3,
      cpus: null,
      save_models: false,
      label_day: null,
    })
    expect(request.model_ids).toEqual(resolvedAssets().assets)
    expect(request.input).toBeTruthy()
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('a resolve 404 surfaces inline and the run is NOT created', async () => {
    setRunCatalogue()
    api.resolveModels.mockRejectedValue({ status: 404, message: 'MODEL_NOT_FOUND' })
    renderPage()
    await settle(0)
    await selectRow('ps:rc-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-d-run-error').textContent).toBe('MODEL_NOT_FOUND')
    expect(screen.getByTestId('route-location').textContent).toBe('/pretrained-models')
  })

  it('a completed download makes the card runnable: the run installs and creates against the verified asset', async () => {
    setRunCatalogue()
    renderPage()
    await settle(0)
    await selectRow('ps:rc-3') // the not-downloaded card — auto-start
    expect(api.downloadModel).toHaveBeenCalledWith({ id: 'rc-3' })
    await settle(2100)
    // The download completes: the poll commits `ready` and the gate opens.
    api.listDownloads.mockResolvedValue({
      downloads: [
        {
          id: 'rc-3',
          version: '1.0.0',
          state: 'ready',
          bytes_downloaded: 4_600_000,
          bytes_total: 4_600_000,
          digest: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          cached: true,
          bundled: false,
        },
      ],
    })
    await settle(2100)
    api.installModel.mockResolvedValue({
      catalogue_id: 'rc-3',
      licence: 'MIT',
      model_id: 'c0000000-0000-4000-8000-000000000003',
      size_bytes: 4_600_000,
      source: 'cache',
      status: 'installed',
      version: '1.0.0',
    })
    api.resolveModels.mockResolvedValue({
      assets: [
        {
          model_id: 'c0000000-0000-4000-8000-000000000003',
          method_id: 'm3',
          method_version: '2.1.0',
          host_dir: '/models/rc-3',
          tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          contract: '2.0',
          env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
        },
      ],
    } as ResolveResponse)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('the reuse config carries the first selected card\u2019s own decision day, never the intake\u2019s', async () => {
    // The study step says day 56; the selected card was trained at 28.
    useTxrIntakeStore.setState({ parameters: { decision_day: 56, baseline_max_day: 0 } })
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 3,
      models: runCatalogue().map(card =>
        card.id === 'rc-1' ? { ...card, decision_day: 28 } : card,
      ),
    } as PretrainedListResponse)
    api.eligibility.mockResolvedValue(runEligibility())
    renderPage()
    await settle(0)
    await selectRow('ps:rc-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    const request = api.createRun.mock.calls[0][0] as { config: Record<string, unknown> }
    expect(request.config.decision_day).toBe(28)
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('cards trained at different decision days: the Run button is unavailable with the reason, no run starts, and the action refuses too', async () => {
    useTxrIntakeStore.setState({ parameters: { decision_day: 56, baseline_max_day: 0 } })
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 3,
      models: runCatalogue().map(card =>
        card.id === 'rc-1'
          ? { ...card, decision_day: 28 }
          : card.id === 'rc-2'
            ? { ...card, decision_day: 56 }
            : card,
      ),
    } as PretrainedListResponse)
    api.eligibility.mockResolvedValue(runEligibility())
    renderPage()
    await settle(0)
    await selectRow('ps:rc-1')
    await selectRow('ps:rc-2')
    const reason =
      'The models you chose were trained at different decision days (day 28 and day 56). Choose models with the same decision day.'
    expect(screen.getByTestId('txr-list-run').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('txr-list-blocked-reason').textContent).toBe(reason)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.resolveModels).not.toHaveBeenCalled()
    expect(api.createRun).not.toHaveBeenCalled()
    // The assistant path takes the same guard: the registered action refuses.
    const live = instancesOfType('txr.model-list')
    expect(live.length).toBe(1)
    const token = live[0].record.getSnapshot()['_state_token'] as string
    let refused: unknown
    await act(async () => {
      refused = await runAction('models.run', {
        view_id: live[0].id,
        expected: token,
      }).catch((error: unknown) => error)
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe(reason)
  })

  it('two cards at different days, one of them not runnable: not blocked, and the line and the config use the runnable card\u2019s day', async () => {
    useTxrIntakeStore.setState({ parameters: { decision_day: 56, baseline_max_day: 0 } })
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 3,
      models: runCatalogue().map(card =>
        card.id === 'rc-1'
          ? { ...card, decision_day: 28 }
          : card.id === 'rc-2'
            ? { ...card, decision_day: 56 }
            : card,
      ),
    } as PretrainedListResponse)
    // rc-2 cannot run (its verdict changed after it was selected): the
    // selection keeps the stale key, the run does not take it, and the
    // mixed-days block goes away — the remaining card's day is the run's.
    api.eligibility.mockResolvedValue({
      ...runEligibility(),
      models: runEligibility().models.map(entry =>
        entry.id === 'rc-2' ? { ...entry, status: 'cannot_run' as const } : entry,
      ),
    } as PretrainedEligibilityResponse)
    // The stale key in the selection: rc-2 was selected while runnable, then
    // its verdict changed before this render (the same state a live change
    // leaves behind — the I-page counterpart drives the live transition).
    // The store's inventory mirror is already the validation's (the mount's
    // `loadInventory` sees no change and does not reset the selection).
    useTxrModelsStore.setState({ inventory: TXRMODELS_INVENTORY })
    useTxrModelsStore.setState({ selection: new Set(['ps:rc-1', 'ps:rc-2']) })
    renderPage()
    await settle(0)
    expect(useTxrModelsStore.getState().selection.size).toBe(2) // the stale key stays
    expect(screen.queryByTestId('txr-list-blocked-reason')).toBeNull()
    expect(screen.getByTestId('txr-list-run').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('txr-models-d-horizon').textContent).toContain(
      'Look ahead to: day 240',
    )
    expect(screen.getByTestId('txr-models-d-horizon').textContent).toContain(
      'Decision day: day 28',
    )
    // The run uses the runnable card's own day, never the intake's 56.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.resolveModels).toHaveBeenCalledWith({
      model_ids: ['c0000000-0000-4000-8000-000000000001'],
    })
    expect(api.createRun).toHaveBeenCalledTimes(1)
    const request = api.createRun.mock.calls[0][0] as { config: Record<string, unknown> }
    expect(request.config.decision_day).toBe(28)
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('the action rejects with the page\u2019s text when a selected card is still downloading, and no run is started', async () => {
    setRunCatalogue()
    renderPage()
    await settle(0)
    await selectRow('ps:rc-3') // the not-downloaded card — auto-start (downloading)
    expect(api.downloadModel).toHaveBeenCalledWith({ id: 'rc-3' })
    const live = instancesOfType('txr.model-list')
    expect(live.length).toBe(1)
    const token = live[0].record.getSnapshot()['_state_token'] as string
    let refused: unknown
    await act(async () => {
      refused = await runAction('models.run', {
        view_id: live[0].id,
        expected: token,
      }).catch((error: unknown) => error)
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe(
      'A selected model is still downloading. Wait for it to finish, or uncheck it.',
    )
    expect(api.installModel).not.toHaveBeenCalled()
    expect(api.resolveModels).not.toHaveBeenCalled()
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('route-location').textContent).toBe('/pretrained-models')
    // The page shows the same line (the button path is the same function).
    expect(screen.getByTestId('txr-models-d-run-error').textContent).toBe(
      'A selected model is still downloading. Wait for it to finish, or uncheck it.',
    )
  })

  it('the action is refused as stale when the selection changed after the snapshot (same count, other ids)', async () => {
    setRunCatalogue()
    renderPage()
    await settle(0)
    await selectRow('ps:rc-1')
    await selectRow('ps:rc-2')
    const live = instancesOfType('txr.model-list')
    expect(live.length).toBe(1)
    const first = live[0].record.getSnapshot()['_state_token'] as string
    // The same-size, different-ids selection must move the token (the
    // snapshot carries the selected model ids, not only the count).
    await act(async () => {
      useTxrModelsStore.getState().setSelection(new Set(['ps:rc-1', 'ps:rc-3']))
      await Promise.resolve()
    })
    await settle(0)
    const second = live[0].record.getSnapshot()['_state_token'] as string
    expect(second).not.toBe(first)
    expect(useTxrModelsStore.getState().selection.size).toBe(2)
    let refused: unknown
    await act(async () => {
      refused = await runAction('models.run', {
        view_id: live[0].id,
        expected: first,
      }).catch((error: unknown) => error)
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('STALE_STATE')
    expect(api.resolveModels).not.toHaveBeenCalled()
    expect(api.createRun).not.toHaveBeenCalled()
  })
})

describe('PretrainedModelsPage demo arm (TEST-DM-7, ITEM-7)', () => {
  /** The demo catalogue arm: one recorded method's card, not installed. */
  function demoCard(): PretrainedSummary {
    return {
      id: 'pc-1',
      version: '1.0.0',
      kind: 'published-rule',
      name: 'pc-1 rule',
      description: 'Rule from the paper; colorectal',
      method_id: 'kelim',
      method_version: '2.1.0',
      group: 'g-static-risk',
      group_label: 'Static risk',
      decision_day: 60,
      endpoint: 'pfs',
      horizon: 240,
      paper: { journal: 'Ann Oncol', year: 2021, doi: '10.0000/pc-1' },
      transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3 },
      warnings: [],
      research_notice: true,
      licence: 'MIT',
      asset: {
        bundled: false,
        file: 'pc-1@1.0.0.txr',
        sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        size_bytes: 4_600_000,
      },
      state: 'not_downloaded',
      installed_model_id: undefined,
    }
  }

  beforeEach(() => {
    seedDemoMode('demo')
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [demoCard()],
    } as PretrainedListResponse)
    api.eligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [
        {
          id: 'pc-1',
          status: 'can_run',
          coverage: { eligible: 42, total: 42, fraction: 1 },
          estimate_quality: 'estimate',
          estimated_seconds: 45,
          min_draws: { required: 1, met: 42, unmet_patients: 0 },
          missing_markers: [],
          reasons: [],
        },
      ],
    } as PretrainedEligibilityResponse)
  })
  afterEach(() => resetDemoMode())

  it('card rows read "Included in the demo", and Run replays the recorded method: no install, no resolve, no download', async () => {
    renderPage()
    await settle(0)
    // The audit's chip byte replaces the Published/Learned pill.
    expect(screen.getAllByText(DEMO_PRETRAINED_CHIP).length).toBeGreaterThan(0)
    // Run with the demo arm: the recorded method's facts go straight into
    // the create call (the card is INCLUDED, nothing is installed).
    await selectRow('ps:pc-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.installModel).not.toHaveBeenCalled()
    expect(api.resolveModels).not.toHaveBeenCalled()
    expect(api.createRun).toHaveBeenCalledTimes(1)
    const request = api.createRun.mock.calls[0][0] as {
      mode: string
      model_ids: Array<{ model_id: string; method_id: string; method_version: string }>
    }
    expect(request.mode).toBe('reuse')
    expect(request.model_ids).toEqual([
      { model_id: 'pc-1', method_id: 'kelim', method_version: '2.1.0' },
    ])
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('selecting a not-installed card starts NO download in demo (the auto-download is the desktop byte)', async () => {
    renderPage()
    await settle(0)
    await selectRow('ps:pc-1')
    expect(api.downloadModel).not.toHaveBeenCalled()
  })

  it('desktop mode keeps the Published/Learned chip and the auto-download on selection', async () => {
    seedDemoMode('desktop')
    renderPage()
    await settle(0)
    expect(screen.queryByText(DEMO_PRETRAINED_CHIP)).toBeNull()
    await selectRow('ps:pc-1')
    await settle(0)
    expect(api.downloadModel).toHaveBeenCalled()
  })
})

describe('the step Back on Pretrained models (D)', () => {
  /** N in the flow: records its step, and its Continue lands on D again. */
  function PredictStandIn() {
    useStepBack({ step: 'predict-files', fallback: '/' })
    const navigate = useNavigate()
    return (
      <Button data-testid="stand-in-continue" onClick={() => navigate('/pretrained-models')}>
        Continue
      </Button>
    )
  }

  function renderFlow() {
    return render(
      <MemoryRouter initialEntries={['/pretrained-models']}>
        <RouterBridge />
        <Routes>
          <Route path="/pretrained-models" element={<PretrainedModelsPage />} />
          <Route path="/predict-files" element={<PredictStandIn />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    )
  }

  const routeAt = () => screen.getByTestId('route-location').textContent

  async function click(testId: string): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId(testId))
      await Promise.resolve()
    })
    await settle(0)
  }

  function expectBackBeforeRun(): void {
    expect(screen.getByTestId('txr-step-back').nextElementSibling).toBe(
      screen.getByTestId('txr-list-run'),
    )
  }

  function expectBackLastInBar(): void {
    expect(screen.getByTestId('txr-step-back-bar').lastElementChild).toBe(
      screen.getByTestId('txr-step-back'),
    )
  }

  beforeEach(() => {
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  })

  it('sits directly left of Run in the list bar: rows, loading, error and a filtered-empty list', async () => {
    renderPage()
    await settle(0)
    expectBackBeforeRun()
    cleanup()

    useTxrModelsStore.getState().reset()
    api.listModels.mockReturnValue(new Promise(() => undefined))
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-loading')).toBeTruthy()
    expectBackBeforeRun()
    cleanup()

    useTxrModelsStore.getState().reset()
    api.listModels.mockRejectedValue(new Error('catalogue down'))
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-error')).toBeTruthy()
    expectBackBeforeRun()
    cleanup()

    useTxrModelsStore.getState().reset()
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: TXRMODELS_PRETRAINED.filter(card => card.kind === 'published-rule').slice(0, 1),
    } as PretrainedListResponse)
    renderPage()
    await settle(0)
    await click('txr-list-filter-learned')
    expect(screen.getByTestId('txr-list-empty')).toBeTruthy()
    expectBackBeforeRun()
  })

  it('no published catalogue, and no checked file: a bottom bar with Back at its right end', async () => {
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 0,
      models: [],
    })
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-d-no-catalogue')).toBeTruthy()
    expectBackLastInBar()
    cleanup()

    useTxrIntakeStore.setState({ validation: null })
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-d-empty')).toBeTruthy()
    expectBackLastInBar()
  })

  it('the "← Step 3 of 3" line goes where Back goes: the trail\u2019s N, or N with no trail', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    renderFlow()
    await settle(0)
    expect(screen.getByTestId('txr-step-line-back').textContent).toBe('Step 3 of 3')
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/predict-files')
    cleanup()

    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    renderFlow()
    await settle(0)
    await click('txr-step-line-back')
    expect(routeAt()).toBe('/predict-files')
  })

  it('goes back to the file step: the trail\u2019s N, or N with no trail', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    renderFlow()
    await settle(0)
    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
    cleanup()

    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
    renderFlow()
    await settle(0)
    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
  })

  it('keeps the selection after Back to N and Continue (also after more than 5 s away); a new file clears it', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    renderFlow()
    await settle(0)
    await selectRow('ps:ps-1')
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')

    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
    // Past the store-kit's lazy teardown delay (5 s after the last reader).
    await settle(6000)
    await click('stand-in-continue')
    expect(routeAt()).toBe('/pretrained-models')
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')

    await click('txr-step-back')
    act(() => {
      useTxrIntakeStore.setState({
        validation: { ...validation(), inventory: { ...TXRMODELS_INVENTORY, patients: 43 } },
      })
    })
    await click('stand-in-continue')
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('0 models selected')
  })

  it('while the run is being prepared Back is unavailable with the reason, and flow.back refuses', async () => {
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [runCard(1, 'installed')],
    } as PretrainedListResponse)
    api.eligibility.mockResolvedValue(runEligibility())
    api.resolveModels.mockReturnValue(new Promise(() => undefined))
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    renderFlow()
    await settle(0)
    await selectRow('ps:rc-1')
    await click('txr-list-run')
    const back = screen.getByTestId('txr-step-back')
    expect(back.getAttribute('aria-disabled')).toBe('true')
    expect(back.textContent).toContain(STEP_BACK_STARTING_REASON)
    await expect(runAction('flow.back', {})).rejects.toThrow(STEP_BACK_STARTING_REASON)
    expect(routeAt()).toBe('/pretrained-models')
  })

  it('a dialog id another page left in the shared store (I\u2019s Details) does not block Back here', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    act(() => {
      useTxrModelsStore.getState().openDialog('details:m-1')
    })
    renderFlow()
    await settle(0)
    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
  })

  it('a model card id left open does not block Back where no card can show (no checked file)', async () => {
    useTxrIntakeStore.setState({ validation: null })
    act(() => {
      useTxrModelsStore.getState().openDialog('card:ps-2')
    })
    renderFlow()
    await settle(0)
    await click('txr-step-back')
    expect(routeAt()).toBe('/predict-files')
  })

  it('after a run is created the page stays on "Starting the run…" until it leaves: Back stays unavailable', async () => {
    api.listModels.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [runCard(1, 'installed')],
    } as PretrainedListResponse)
    api.eligibility.mockResolvedValue(runEligibility())
    renderPage()
    await settle(0)
    await selectRow('ps:rc-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('txr-step-back').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('txr-step-back').textContent).toContain(STEP_BACK_STARTING_REASON)
  })

  it('while the Model card dialog is open, flow.back refuses', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    renderFlow()
    await settle(0)
    act(() => {
      useTxrModelsStore.getState().openDialog('card:ps-2')
    })
    await settle(0)
    await expect(runAction('flow.back', {})).rejects.toThrow(STEP_BACK_DIALOG_OPEN)
    expect(routeAt()).toBe('/pretrained-models')
  })
})

describe('the dynamic no-models messages on Pretrained models (D)', () => {
  const emptyCatalogue = (): PretrainedListResponse =>
    ({ origin: 'embedded', generated_at: '2026-11-29T09:00:00Z', total: 0, models: [] }) as PretrainedListResponse

  function savedList(n: number): void {
    api.listSaved.mockResolvedValue({ models: TXRMODELS_SAVED.slice(0, n), total: n })
  }

  function savedVerdicts(fit: number, some: number, cannot: number): void {
    api.savedEligibility.mockResolvedValue({ models: [], total_fit: fit, total_some: some, total_cannot: cannot })
  }

  async function click(testId: string): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId(testId))
      await Promise.resolve()
    })
    await settle(0)
  }

  beforeEach(() => {
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  })

  it('no published model, 3 saved and 2 can run: says so, and "Use my saved models" opens the saved list for the same file', async () => {
    api.listModels.mockResolvedValue(emptyCatalogue())
    savedList(3)
    savedVerdicts(1, 1, 1)
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    const checked = useTxrIntakeStore.getState().validation
    renderPage()
    await settle(0)
    const box = screen.getByTestId('txr-models-d-no-catalogue')
    expect(screen.getByTestId('txr-models-d-no-catalogue-title').textContent).toBe('No ready-made models yet')
    expect(box.textContent).toContain('None have been released yet.')
    expect(screen.getByTestId('txr-models-d-no-catalogue-body').textContent).toBe(
      'You can predict with your own saved models instead: 2 of your 3 saved models can run on this file.',
    )
    expect(screen.getByTestId('txr-models-d-no-catalogue-action-your-models')).toBeTruthy()
    await click('txr-models-d-no-catalogue-action-use-saved')
    expect(screen.getByTestId('route-location').textContent).toBe('/saved-models')
    expect(useTxrIntakeStore.getState().intent).toBe('reuse')
    expect(useTxrIntakeStore.getState().validation).toBe(checked)
    // The saved list took the step's place: its Back goes to the file step.
    expect(useStepTrailStore.getState().trail).toEqual(['/', '/predict-files', '/saved-models'])
  })

  it('no published model and none of the saved can run: "See my saved models"', async () => {
    api.listModels.mockResolvedValue(emptyCatalogue())
    savedList(2)
    savedVerdicts(0, 0, 2)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-d-no-catalogue').textContent).toContain(
      'You have 2 saved models, but none can run on this file',
    )
    expect(screen.getByTestId('txr-models-d-no-catalogue-action-see-saved')).toBeTruthy()
  })

  it('no published model and no saved model: "Learn from my data" starts the learn path', async () => {
    api.listModels.mockResolvedValue(emptyCatalogue())
    savedList(0)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-d-no-catalogue').textContent).toContain(
      "You don't have any saved models yet. To make some, learn from patients whose outcomes you know.",
    )
    await click('txr-models-d-no-catalogue-action-learn')
    expect(screen.getByTestId('route-location').textContent).toBe('/files')
    expect(useTxrIntakeStore.getState().intent).toBe('train')
  })

  it('names no number while the saved models load, and offers Retry when they fail', async () => {
    api.listModels.mockResolvedValue(emptyCatalogue())
    api.listSaved.mockReturnValue(new Promise(() => undefined))
    renderPage()
    await settle(0)
    const box = screen.getByTestId('txr-models-d-no-catalogue')
    expect(box.textContent).toContain('Checking your saved models\u2026')
    expect(box.textContent).not.toMatch(/\d/)
    cleanup()

    useTxrModelsStore.getState().reset()
    api.listSaved.mockRejectedValueOnce(new Error('models down'))
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-d-no-catalogue').textContent).toContain(
      'Your saved models could not be loaded.',
    )
    savedList(1)
    savedVerdicts(1, 0, 0)
    await click('txr-models-d-no-catalogue-action-retry')
    expect(screen.getByTestId('txr-models-d-no-catalogue').textContent).toContain(
      'You can predict with your own saved model instead: it can run on this file.',
    )
  })

  it('before the first catalogue load the page never shows the no-models state (no flash)', async () => {
    // The birth state says loading: false before any fetch; hold the fetch off.
    const original = useTxrModelsStore.getState().loadPretrained
    useTxrModelsStore.setState({ loadPretrained: async () => undefined })
    try {
      renderPage()
      await settle(0)
      expect(screen.queryByTestId('txr-models-d-no-catalogue')).toBeNull()
      expect(screen.queryByTestId('txr-list-empty')).toBeNull()
      expect(screen.getByTestId('txr-list-loading')).toBeTruthy()
      expect(api.listSaved).not.toHaveBeenCalled()
    } finally {
      useTxrModelsStore.setState({ loadPretrained: original })
    }
  })

  it('a catalogue none of whose models can run: the line above the list, with the saved models that can', async () => {
    api.eligibility.mockResolvedValue({
      models: [],
      total_fit: 0,
      total_some: 0,
      total_cannot: TXRMODELS_PRETRAINED.length,
    } as PretrainedEligibilityResponse)
    savedList(4)
    savedVerdicts(2, 0, 2)
    renderPage()
    await settle(0)
    const line = screen.getByTestId('txr-models-d-none-can-run')
    expect(line.textContent).toContain(
      `None of the ${TXRMODELS_PRETRAINED.length} ready-made models can run on this file. Each row says what is missing. 2 of your saved models can run on it.`,
    )
    await click('txr-models-d-none-can-run-action-use-saved')
    expect(screen.getByTestId('route-location').textContent).toBe('/saved-models')
  })

  it('a file change never shows the previous file\u2019s saved count (no stale "can run" before the new check)', async () => {
    api.listModels.mockResolvedValue(emptyCatalogue())
    savedList(3)
    savedVerdicts(1, 1, 1)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-d-no-catalogue').textContent).toContain(
      '2 of your 3 saved models can run on this file',
    )
    // Hold the store's inventory on the previous file (as before its effect
    // runs): the verdicts it holds answer that file, not this one.
    const original = useTxrModelsStore.getState().loadInventory
    useTxrModelsStore.setState({ loadInventory: () => undefined })
    try {
      act(() => {
        useTxrIntakeStore.setState({
          validation: { ...validation(), inventory: { ...TXRMODELS_INVENTORY, patients: 43 } },
        })
      })
      await settle(0)
      const box = screen.getByTestId('txr-models-d-no-catalogue')
      expect(box.textContent).not.toContain('can run on this file')
      expect(box.textContent).toContain('Checking your saved models\u2026')
    } finally {
      useTxrModelsStore.setState({ loadInventory: original })
    }
  })

  it('a catalogue that can run loads no saved models and shows no line', async () => {
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-models-d-none-can-run')).toBeNull()
    expect(api.listSaved).not.toHaveBeenCalled()
  })

  it('the not-ready "Go to the measurements step" is the registered navigation', async () => {
    useTxrIntakeStore.setState({ validation: null })
    renderPage()
    await settle(0)
    await click('txr-models-d-empty-cta')
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
  })
})
