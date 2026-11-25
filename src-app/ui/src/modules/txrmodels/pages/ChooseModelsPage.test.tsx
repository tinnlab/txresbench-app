// @vitest-environment jsdom
/**
 * TEST-MOD-33 [acceptance] [invariant: INV-1, INV-3, INV-4, INV-5] — the
 * merged model step's `ChooseModelsPage` (predict-card merge round 2) — the
 * ONE list of the predict path's model choice.
 *
 * Pinned behaviors (PLAN.md section 3 + section 8's test bullets):
 *
 * - the merged list: rows from all three sources in one flat list, each
 *   with its small-caps source label ("From the lab" / "Saved" / "Imported"),
 *   no double row for a downloaded lab model (a store row with provenance
 *   `pretrained` is the lab row's downloaded state);
 * - the header: "Step 2 of 2", the board title, the round-2 checked-against
 *   line and the "N models · X can run, Y cannot" totals;
 * - the toolbar: the built-in All / Can run wired for real, the three source
 *   chips (counts, 0-chip disabled, several on = any), the KEPT chips, the
 *   three lab-only chips ONLY when the list has at least one lab row (both
 *   cases), the search over the run name and the four sorts with the
 *   round-2 default rule (Transfer unless the Saved preset, a Use handoff
 *   or the example set — then Newest run first);
 * - the run path: one selection over all sources, the mixed-day #57 refusal
 *   with the look-ahead/decision-day lines, the install gate, ONE
 *   `resolveModels` and ONE reuse `createRun` with the first selected
 *   model's config;
 * - the states: no checked file (round-2 line + note + CTA), none can run
 *   (1 and N lines), "No models match the search or the filters.", one
 *   source failed ("Some models could not be loaded." + Retry), and the
 *   no-model panel (`txr-models-none`) with its three options + the Run's
 *   blocked reason;
 * - the handoffs: the example set (`pendingExampleSetId`) ticks every model
 *   of the set; the Models-page Use (`pendingUseModelId`) ticks the row;
 * - the actions: `models.setListFilters` / `models.setSelection` (token
 *   refusals), `models.switchList`'s alias mapping, `models.run` with a mix;
 * - demo mode (section 6): lab rows chip "Included in the demo", no
 *   downloads, "Open a model file" hidden;
 * - the redirects: `/pretrained-models` → From the lab on,
 *   `/saved-models` → Saved + Imported on, other query kept.
 *
 * Every fixture value is synthetic (INV-4): a test-local catalogue (`lc-<k>`)
 * and saved list (`sm-<k>`), never the boards' example numbers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import '@/core/actions/builtin/stepActions'
import '@/core/actions/builtin/appActions'
import '@/core/actions/builtin/modelRunActions'
import '@/core/actions/builtin/modelFileActions'
import { runAction } from '@/core/actions/defineAction'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { instancesOfType } from '@/core/actions/instanceRegistry'
import type {
  ModelEligibilityResponse,
  ModelListResponse,
  ModelSetListResponse,
  ModelSummary,
  PretrainedEligibilityResponse,
  PretrainedListResponse,
  PretrainedSummary,
  ResolveResponse,
  TxrAppConfig,
  TxrRunSummary,
  ValidationResponse,
} from '@/api-client/types'
import { useStepTrailStore, useTxrIntakeStore } from '@/modules/txrintake'
import { DEMO_PRETRAINED_CHIP } from '@/modules/demo/copy'
import { resetDemoMode, seedDemoMode } from '@/modules/demo/test-utils/demoSeed'
import { TXRMODELS_INVENTORY, TXRMODELS_SET_A } from '../fixtures'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { RESEARCH_NOTICE } from '../lib/format'
import { ChooseModelsPage } from './ChooseModelsPage'
import { PretrainedModelsRedirectRoute, SavedModelsRedirectRoute } from './RedirectRoutes'

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
  listCatalogue: vi.fn(),
  catalogueEligibility: vi.fn(),
  getModel: vi.fn(),
  downloadModel: vi.fn(),
  listDownloads: vi.fn(),
  installModel: vi.fn(),
  resolveModels: vi.fn(),
  createRun: vi.fn(),
  listSaved: vi.fn(),
  listSets: vi.fn(),
  savedEligibility: vi.fn(),
  getAnalysisConfig: vi.fn(),
  getUsage: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Pretrained: {
      listModels: api.listCatalogue,
      checkEligibility: api.catalogueEligibility,
      getModel: api.getModel,
      downloadModel: api.downloadModel,
      listDownloads: api.listDownloads,
      installModel: api.installModel,
    },
    Models: {
      listModels: api.listSaved,
      checkEligibility: api.savedEligibility,
      resolveModels: api.resolveModels,
    },
    ModelSets: {
      listSets: api.listSets,
    },
    Txr: {
      createRun: api.createRun,
      getAnalysisConfig: api.getAnalysisConfig,
    },
    History: {
      getUsage: api.getUsage,
    },
  },
}))

// ── jsdom has no layout, and the shared list is a VIRTUALIZED window ──
// The virtualizer reads the scrollport's offsetHeight and each row's
// measured height; jsdom answers 0 to all of them, so the layout is STATED
// (the PretrainedModelsPage suite's own idiom).
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
    intent: 'predict',
    predictSource: null,
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
    parameters: { decision_day: 56, baseline_max_day: 0 },
    validation: validation(),
  })
}

/** One test-local lab card (the `lc-<k>` namespace). */
function card(k: number, over: Partial<PretrainedSummary> = {}): PretrainedSummary {
  const id = `lc-${k}`
  return {
    id,
    version: '1.0.0',
    kind: 'published-rule',
    name: `${id} rule`,
    description: 'Rule from the paper; colorectal',
    method_id: `m${k}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    decision_day: 56,
    endpoint: 'pfs',
    horizon: 240,
    paper: { journal: 'Ann Oncol', year: 2021, doi: `10.0000/${id}` },
    transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3 },
    warnings: [],
    research_notice: true,
    licence: 'MIT',
    asset: {
      bundled: false,
      file: `${id}@1.0.0.txr`,
      sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      size_bytes: 4_600_000,
    },
    state: 'installed',
    installed_model_id: `c0000000-0000-4000-8000-0000000000${String(k).padStart(2, '0')}`,
    ...over,
  }
}

/** The default three-card catalogue (2 can run, 1 cannot; the lab-only
 *  chips: published 2, learned 1, checked 1). */
function catalogue(): PretrainedSummary[] {
  return [
    card(1),
    card(2, { kind: 'benchmark-trained', transfer: { metric: 'auc_rule', median: 0.74, n_cohorts: 1 } }),
    card(3, {
      state: 'not_downloaded',
      transfer: undefined,
      installed_model_id: undefined,
    }),
  ]
}

function catalogueEligibility(): PretrainedEligibilityResponse {
  return {
    total_fit: 2,
    total_some: 0,
    total_cannot: 1,
    models: [
      {
        id: 'lc-1',
        status: 'can_run',
        coverage: { eligible: 42, total: 42, fraction: 1 },
        estimate_quality: 'estimate',
        estimated_seconds: 45,
        min_draws: { required: 1, met: 42, unmet_patients: 0 },
        missing_markers: [],
        reasons: [],
      },
      {
        id: 'lc-2',
        status: 'can_run',
        coverage: { eligible: 42, total: 42, fraction: 1 },
        estimate_quality: 'estimate',
        estimated_seconds: 90,
        min_draws: { required: 1, met: 42, unmet_patients: 0 },
        missing_markers: [],
        reasons: [],
      },
      {
        id: 'lc-3',
        status: 'cannot_run',
        coverage: { eligible: 0, total: 42, fraction: 0 },
        estimate_quality: 'estimate',
        min_draws: { required: 1, met: 42, unmet_patients: 0 },
        missing_markers: [],
        reasons: [{ code: 'ASSET_NOT_AVAILABLE' }],
      },
    ],
  }
}

/** One test-local saved model (the `sm-<k>` namespace). */
function model(k: number, over: Partial<ModelSummary> = {}): ModelSummary {
  const id = `sm-${k}`
  return {
    id,
    name: `${id}-model`,
    method_id: `m${k}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    provenance: 'run',
    endpoint: 'pfs',
    horizon: 240,
    decision_day: 56,
    created_at: k === 2 ? '2026-10-09T10:00:00Z' : '2026-11-29T09:00:00Z',
    trained_at: k === 2 ? '2026-10-09T10:00:00Z' : '2026-11-29T08:30:00Z',
    trained_on_patients: 42,
    size_bytes: 4_600_000,
    embeds_training_data: false,
    uses_covariates: false,
    marker_kind: 'single',
    set_id: 'set-a',
    set_name: 'My first run',
    ...over,
  }
}

/** The default saved slice: one run row, one imported row (os/165 — the
 *  "Same outcome" chip's non-match) and one downloaded-lab row (provenance
 *  `pretrained` + `pretrained_catalogue_id` = the catalogue card's). */
function savedList(): ModelSummary[] {
  return [
    model(1),
    model(2, { provenance: 'imported', set_id: undefined, set_name: undefined, endpoint: 'os', horizon: 165 }),
    model(3, { provenance: 'pretrained', pretrained_catalogue_id: 'lc-1', set_id: undefined, set_name: undefined }),
  ]
}

function savedEligibility(): ModelEligibilityResponse {
  return {
    total_fit: 1,
    total_some: 1,
    total_cannot: 0,
    models: [
      {
        id: 'sm-1',
        status: 'can_run',
        endpoint: 'pfs',
        coverage: { eligible: 42, total: 42, fraction: 1 },
        estimate_quality: 'estimate',
        estimated_seconds: 60,
        min_draws: { required: 1, met: 42, unmet_patients: 0 },
        missing_markers: [],
        reasons: [],
      },
      {
        id: 'sm-2',
        status: 'can_run_some',
        endpoint: 'os',
        coverage: { eligible: 40, total: 42, fraction: 40 / 42 },
        estimate_quality: 'estimate',
        estimated_seconds: 30,
        min_draws: { required: 1, met: 42, unmet_patients: 0 },
        missing_markers: [],
        reasons: [{ code: 'MIN_DRAWS_UNMET' }],
      },
    ],
  }
}

function resolvedAssets(): ResolveResponse {
  return {
    assets: [
      {
        model_id: 'c0000000-0000-4000-8000-000000000001',
        method_id: 'm1',
        method_version: '2.1.0',
        host_dir: '/models/lc-1',
        tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        contract: '2.0',
        env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
      },
      {
        model_id: 'sm-1',
        method_id: 'm1',
        method_version: '2.1.0',
        host_dir: '/models/sm-1',
        tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        contract: '2.0',
        env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
      },
    ],
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{`${location.pathname}${location.search}`}</div>
}

function renderPage(initialEntry = '/choose-models') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      {/* The page's buttons run registered actions; their navigation goes
          through the router bridge, as in the app. */}
      <RouterBridge />
      <ChooseModelsPage />
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

/** The kit Checkbox's checked state (aria-checked / data-checked, as the kit serialises it). */
function isChecked(el: HTMLElement): boolean {
  return el.getAttribute('aria-checked') === 'true' || el.hasAttribute('data-checked')
}

/** Check the row's checkbox (the shared list's own toggle). */
async function selectRow(key: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`txr-list-checkbox-${key}`))
    await Promise.resolve()
  })
  await settle(0)
}

/** The row keys the list renders, in DOM order (suffixes excluded). */
function rowKeys(): string[] {
  const out: string[] = []
  for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="txr-list-row-"]')) {
    const id = el.getAttribute('data-testid') ?? ''
    if (id.endsWith('-source') || id.endsWith('-action')) continue
    out.push(id.slice('txr-list-row-'.length))
  }
  return out
}

/** Select one sort option (the kit Select's pointer/click sequence). */
async function chooseSort(value: string): Promise<void> {
  const trigger = document.querySelector<HTMLElement>('[data-testid="txr-list-sort"]')!
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)
    await Promise.resolve()
  })
  const option = document.querySelector<HTMLElement>(
    `[role="option"][data-testid="txr-list-sort-opt-${value}"]`,
  )!
  await act(async () => {
    fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(option, { button: 0 })
    fireEvent.click(option)
    await Promise.resolve()
  })
  await settle(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  api.listCatalogue.mockReset()
  api.catalogueEligibility.mockReset()
  api.getModel.mockReset()
  api.downloadModel.mockReset()
  api.listDownloads.mockReset()
  api.installModel.mockReset()
  api.resolveModels.mockReset()
  api.createRun.mockReset()
  api.listSaved.mockReset()
  api.listSets.mockReset()
  api.savedEligibility.mockReset()
  api.getAnalysisConfig.mockReset()
  api.getUsage.mockReset()
  api.listCatalogue.mockResolvedValue({
    origin: 'embedded',
    generated_at: '2026-11-29T09:00:00Z',
    total: catalogue().length,
    models: catalogue(),
  } as PretrainedListResponse)
  api.catalogueEligibility.mockResolvedValue(catalogueEligibility())
  api.getModel.mockResolvedValue({
    id: 'lc-1',
    name: 'lc-1 rule',
    description: 'Rule from the paper; colorectal',
    group: 'g-static-risk',
    group_label: 'Static risk',
    kind: 'published-rule',
    method_id: 'm1',
    method_version: '2.1.0',
    version: '1.0.0',
    licence: 'MIT',
    research_notice: true,
    embeds_training_data: false,
    contract: '2.0',
    env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
    paper: { journal: 'Ann Oncol', year: 2021, doi: '10.0000/lc-1' },
    needs: {
      decision_day: 56,
      endpoint: 'pfs',
      horizon: 240,
      task: 'survival',
      marker_facts: { count: 4, kind: 'any', marker_groups_required: [], min_draws: 2, needs_baseline: true, needs_detection_call: false, uses_history: 'landmark' },
      required_markers: { list_source: 'curated', match: 'all', min_fraction: 1, markers: [] },
      covariates: 'optional',
    },
    transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3, cohorts: [] },
    assay_warnings: [],
    data_sources: [],
    asset: { bundled: false, file: 'lc-1@1.0.0.txr', sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', signature: '', url: '', size_bytes: 4_600_000 },
  } as never)
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
        id: 'lc-3',
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
    catalogue_id: 'lc-3',
    licence: 'MIT',
    model_id: 'c0000000-0000-4000-8000-000000000003',
    size_bytes: 4_600_000,
    source: 'bundled',
    status: 'installed',
    version: '1.0.0',
  })
  api.resolveModels.mockResolvedValue(resolvedAssets())
  api.createRun.mockResolvedValue({ id: 'run-1' } as unknown as TxrRunSummary)
  api.listSaved.mockResolvedValue({ models: savedList(), total: savedList().length } as ModelListResponse)
  api.listSets.mockResolvedValue({ sets: [TXRMODELS_SET_A], total: 1 } as ModelSetListResponse)
  api.savedEligibility.mockResolvedValue(savedEligibility())
  api.getAnalysisConfig.mockResolvedValue({
    config: { endpoint: 'pfs', look_ahead_day: 240 },
  } as TxrAppConfig)
  api.getUsage.mockResolvedValue({
    shared: true,
    runs: 1,
    run_limit: 50,
    models: 1,
    model_limit: 50,
    pinned_runs: 0,
    pinned_models: 0,
  })
  useTxrIntakeStore.getState().reset()
  useTxrModelsStore.getState().reset()
  useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  resetDemoMode()
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

describe('ChooseModelsPage — the merged list (TEST-MOD-33)', () => {
  it('renders the step line, the round-2 header and the verdict totals', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByText('Step 3 of 3')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Choose the models to run' })).toBeTruthy()
    expect(screen.getByTestId('txr-models-choose-checked').textContent).toBe(
      'Checked against your file: 42 patients, 4 markers, draws at day 0, 14, 28 and 56. Ready-made, saved and imported models are all here; pick as many as you like.',
    )
    // The look-ahead + decision-day lines (nothing selected: the "model you
    // choose" wording).
    const horizon = screen.getByTestId('txr-models-choose-horizon')
    expect(horizon.textContent).toContain('Look ahead to: the day the model you choose was trained for.')
    expect(horizon.textContent).toContain('Decision day: the day the model you choose was trained at.')
    expect(screen.getByTestId('txr-models-choose-totals').textContent).toBe(
      '5 models · 4 can run, 1 cannot',
    )
    expect(screen.getByText(RESEARCH_NOTICE)).toBeTruthy()
    expect(screen.queryByTestId('txr-list-save-models')).toBeNull()
  })

  it('lists the three sources with their small-caps labels and no double row for a downloaded lab model', async () => {
    renderPage()
    await settle(0)
    // The merged rows: the three lab rows + the saved + the imported row.
    // sm-3 (provenance `pretrained`, catalogue lc-1) is NOT a row and ps:lc-1
    // appears exactly once.
    expect(rowKeys()).toEqual(['ps:lc-1', 'ps:lc-2', 'ps:lc-3', 'sm-1', 'sm-2'])
    expect(screen.queryByTestId('txr-list-row-sm-3')).toBeNull()
    expect(document.querySelectorAll('[data-testid="txr-list-row-ps:lc-1"]').length).toBe(1)
    // The small-caps source labels, in the row's own order.
    expect(screen.getByTestId('txr-list-row-ps:lc-1-source').textContent).toBe('From the lab')
    expect(screen.getByTestId('txr-list-row-ps:lc-2-source').textContent).toBe('From the lab')
    expect(screen.getByTestId('txr-list-row-ps:lc-3-source').textContent).toBe('From the lab')
    expect(screen.getByTestId('txr-list-row-sm-1-source').textContent).toBe('Saved')
    expect(screen.getByTestId('txr-list-row-sm-2-source').textContent).toBe('Imported')
    // The saved row's round-2 subtitle: the run name first.
    expect(screen.getByTestId('txr-list-row-sm-1').textContent).toContain(
      'My first run \u00b7 decision day 56',
    )
    expect(screen.getByTestId('txr-list-row-sm-2').textContent).toContain('decision day 56')
  })

  it('the source chips carry the counts, the 0-chip is disabled, and a source chip narrows the rows', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-filter-source-lab').textContent).toBe('From the lab 3')
    expect(screen.getByTestId('txr-list-filter-source-saved').textContent).toBe('Saved 1')
    expect(screen.getByTestId('txr-list-filter-source-imported').textContent).toBe('Imported 1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-source-saved'))
      await Promise.resolve()
    })
    await settle(0)
    expect(rowKeys()).toEqual(['sm-1'])
    // An imported-only view: another chip on means "any of them".
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-source-imported'))
      await Promise.resolve()
    })
    await settle(0)
    expect(rowKeys()).toEqual(['sm-1', 'sm-2'])
    // The 0-chip is disabled: an imported-free saved list.
    cleanup()
    useTxrModelsStore.getState().reset()
    api.listSaved.mockResolvedValue({
      models: [savedList()[0]],
      total: 1,
    } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [savedEligibility().models[0]],
    } as ModelEligibilityResponse)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-filter-source-imported').hasAttribute('disabled')).toBe(true)
  })

  it('a source chip combines with Can run and All clears everything', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-source-saved'))
      fireEvent.click(screen.getByTestId('txr-list-filter-source-imported'))
      await Promise.resolve()
    })
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-can-run'))
      await Promise.resolve()
    })
    await settle(0)
    // Saved + imported AND can run: the some row stays, nothing else.
    expect(rowKeys()).toEqual(['sm-1', 'sm-2'])
    // All clears the source chips and Can run: every row is back.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-all'))
      await Promise.resolve()
    })
    await settle(0)
    expect(rowKeys()).toEqual(['ps:lc-1', 'ps:lc-2', 'ps:lc-3', 'sm-1', 'sm-2'])
  })

  it('the lab-only chips render only when the list has at least one lab row', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-filter-published').textContent).toBe('Published rules 2')
    expect(screen.getByTestId('txr-list-filter-learned').textContent).toBe(
      'Learned by the benchmark 1',
    )
    expect(screen.getByTestId('txr-list-filter-checked-2-plus').textContent).toBe(
      'Checked on 2 or more other cohorts 1',
    )
    expect(screen.getByTestId('txr-list-filter-same-outcome').textContent).toBe(
      'Same outcome as my file 4',
    )
    // No lab row: the lab-only chips go, the shared chips stay.
    cleanup()
    useTxrModelsStore.getState().reset()
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 0,
      models: [],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 0,
      models: [],
    } as PretrainedEligibilityResponse)
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-list-filter-published')).toBeNull()
    expect(screen.queryByTestId('txr-list-filter-learned')).toBeNull()
    expect(screen.queryByTestId('txr-list-filter-checked-2-plus')).toBeNull()
    expect(screen.getByTestId('txr-list-filter-same-outcome').textContent).toBe(
      'Same outcome as my file 1',
    )
  })

  it('the search finds a model by its run name', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-list-search'), { target: { value: 'my first' } })
      await Promise.resolve()
    })
    await settle(0)
    expect(rowKeys()).toEqual(['sm-1'])
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-list-search'), { target: { value: 'lc-2' } })
      await Promise.resolve()
    })
    await settle(0)
    expect(rowKeys()).toEqual(['ps:lc-2'])
  })

  it('sorts by transfer (the default), newest run, patients covered and time', async () => {
    renderPage()
    await settle(0)
    // Default rule: no saved preset, no handoff → transfer (lab first by
    // cohorts, saved/imported last).
    expect(useTxrModelsStore.getState().sort).toBe('transfer')
    expect(rowKeys()).toEqual(['ps:lc-1', 'ps:lc-2', 'ps:lc-3', 'sm-1', 'sm-2'])

    await chooseSort('newest-run')
    expect(rowKeys()).toEqual(['sm-1', 'sm-2', 'ps:lc-1', 'ps:lc-2', 'ps:lc-3'])

    await chooseSort('patients')
    // coverage desc: 1.0 rows (lc-1, lc-2, sm-1 stable), then sm-2 (40/42), lc-3 (0).
    expect(rowKeys()).toEqual(['ps:lc-1', 'ps:lc-2', 'sm-1', 'sm-2', 'ps:lc-3'])

    await chooseSort('time')
    // estimated seconds asc: sm-2 30, lc-1 45, sm-1 60, lc-2 90, lc-3 none (last).
    expect(rowKeys()).toEqual(['sm-2', 'ps:lc-1', 'sm-1', 'ps:lc-2', 'ps:lc-3'])
  })

  it('the Saved preset opens with Saved + Imported on and the Newest-run-first default', async () => {
    renderPage('/choose-models?source=saved')
    await settle(0)
    expect(useTxrModelsStore.getState().filters).toEqual(['source-saved', 'source-imported'])
    expect(useTxrModelsStore.getState().sort).toBe('newest-run')
    expect(rowKeys()).toEqual(['sm-1', 'sm-2'])
    expect(screen.getByTestId('txr-list-filter-source-saved').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('txr-list-filter-source-lab').getAttribute('aria-pressed')).toBe('false')
  })

  it('the no-file state shows the round-2 line, the note and the CTA', async () => {
    useTxrIntakeStore.setState({ validation: null })
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-choose-empty').textContent).toContain(
      'Add the patients\u2019 measurements you want to predict first.',
    )
    expect(screen.getByTestId('txr-models-choose-empty-note').textContent).toBe(
      'The models are listed here once your file checks out: ready-made models from the lab, models you saved, and models opened from a file.',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-choose-empty-cta'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
  })

  it('none can run: the 1-row and the N-row lines', async () => {
    // One row, cannot.
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 0,
      models: [],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 0,
      models: [],
    } as PretrainedEligibilityResponse)
    api.listSaved.mockResolvedValue({ models: [savedList()[0]], total: 1 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 1,
      models: [
        {
          ...savedEligibility().models[0],
          status: 'cannot_run' as const,
          coverage: { eligible: 0, total: 42, fraction: 0 },
          estimated_seconds: undefined,
          reasons: [{ code: 'MODEL_REQUIREMENTS_UNRECORDED' as const }],
        },
      ],
    } as ModelEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-choose-none-can-run').textContent).toContain(
      'The 1 model cannot run on this file. Its row says what is missing.',
    )
    // N rows, none runnable.
    cleanup()
    useTxrModelsStore.getState().reset()
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 3,
      models: catalogue().map(c => (c.id === 'lc-1' ? { ...c, state: 'unavailable', installed_model_id: undefined } : c)),
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 3,
      models: catalogueEligibility().models.map(entry => ({
        ...entry,
        status: 'cannot_run' as const,
        coverage: { eligible: 0, total: 42, fraction: 0 },
        estimated_seconds: undefined,
        reasons: [{ code: 'ASSET_NOT_AVAILABLE' as const }],
      })),
    } as PretrainedEligibilityResponse)
    api.listSaved.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 0,
      models: [],
    } as ModelEligibilityResponse)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-choose-none-can-run').textContent).toContain(
      'None of the 3 models can run on this file. Each row says what is missing.',
    )
  })

  it('"No models match the search or the filters." when the view is empty', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-list-search'), { target: { value: 'zzz-no-match' } })
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-list-empty').textContent).toBe(
      'No models match the search or the filters.',
    )
  })

  it('one source failed: the alert, the rows that loaded stay, and Retry recovers', async () => {
    api.listCatalogue.mockRejectedValueOnce(new Error('catalogue down'))
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-choose-source-failed').textContent).toContain(
      'Some models could not be loaded.',
    )
    // The saved/imported rows are still there; the lab rows are not.
    expect(rowKeys()).toEqual(['sm-1', 'sm-2'])
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-choose-source-retry'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.queryByTestId('txr-models-choose-source-failed')).toBeNull()
    expect(rowKeys()).toEqual(['ps:lc-1', 'ps:lc-2', 'ps:lc-3', 'sm-1', 'sm-2'])
  })

  it('both sources failed: the list error + Retry', async () => {
    api.listCatalogue.mockRejectedValue(new Error('catalogue down'))
    api.listSaved.mockRejectedValue(new Error('models down'))
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-error')).toBeTruthy()
    expect(screen.getByTestId('txr-list-retry')).toBeTruthy()
  })

  it('the no-model panel: the three options and the Run blocked reason; demo hides "Open a model file"', async () => {
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 0,
      models: [],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 0,
      models: [],
    } as PretrainedEligibilityResponse)
    api.listSaved.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 0,
      models: [],
    } as ModelEligibilityResponse)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-none').textContent).toContain(
      'No models to choose from yet',
    )
    expect(screen.getByTestId('txr-models-none-text').textContent).toContain(
      'No ready-made models have been released yet, and you have no saved or opened models.',
    )
    expect(screen.getByTestId('txr-models-none-example').textContent).toBe('Use example')
    expect(screen.getByTestId('txr-models-none-train').textContent).toBe('Learn from my data')
    expect(screen.getByTestId('txr-models-none-file').textContent).toBe('Open a model file')
    expect(screen.getByTestId('txr-list-blocked-reason').textContent).toBe(
      'There is no model to run yet.',
    )
    expect(screen.getByTestId('txr-list-run').hasAttribute('disabled')).toBe(true)
    // The demo panel hides the file option.
    cleanup()
    useTxrModelsStore.getState().reset()
    seedDemoMode('demo')
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-none-example')).toBeTruthy()
    expect(screen.getByTestId('txr-models-none-train')).toBeTruthy()
    expect(screen.queryByTestId('txr-models-none-file')).toBeNull()
  })

  it('demo: lab rows chip "Included in the demo" and checking a not-downloaded card never downloads', async () => {
    seedDemoMode('demo')
    // A not-downloaded card whose demo verdict says it can run: in desktop
    // mode checking it would start its download; in demo it must not.
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [card(3)],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [
        {
          id: 'lc-3',
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
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    expect(screen.getAllByText(DEMO_PRETRAINED_CHIP).length).toBeGreaterThan(0)
    await selectRow('ps:lc-3')
    expect(api.downloadModel).not.toHaveBeenCalled()
    expect(useTxrModelsStore.getState().selection.has('ps:lc-3')).toBe(true)
    expect(screen.queryByTestId('txr-models-downloads')).toBeNull()
  })

  it('the example set handoff ticks every model of the set', async () => {
    useTxrIntakeStore.getState().setPendingExampleSet?.('set-a')
    renderPage()
    await settle(0)
    // The handoff also opens with the Newest-run-first sort.
    expect(useTxrModelsStore.getState().sort).toBe('newest-run')
    const selection = useTxrModelsStore.getState().selection
    expect(selection.has('sm-1')).toBe(true)
    expect(selection.has('sm-2')).toBe(false)
    expect(useTxrIntakeStore.getState().pendingExampleSetId).toBeNull()
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')
  })

  it('the Models-page Use handoff ticks the row', async () => {
    useTxrModelsStore.getState().setPendingUse('sm-1')
    renderPage()
    await settle(0)
    expect(useTxrModelsStore.getState().selection.has('sm-1')).toBe(true)
    expect(useTxrModelsStore.getState().pendingUseModelId).toBeNull()
    expect(isChecked(screen.getByTestId('txr-list-checkbox-sm-1'))).toBe(true)
  })

  it('a lab day-28 + saved day-56 mix: Run disabled with the #57 text, the action refuses too', async () => {
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [card(1, { decision_day: 28 })],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [
        {
          id: 'lc-1',
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
    api.listSaved.mockResolvedValue({
      // The saved model's look-ahead differs from the lab card's (the mixed
      // note's own fixture — the plan's mix test pins BOTH the #57
      // decision-day refusal and the look-ahead note).
      models: [model(1, { horizon: 238 })],
      total: 1,
    } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [savedEligibility().models[0]],
    } as ModelEligibilityResponse)
    renderPage()
    await settle(0)
    await selectRow('ps:lc-1')
    await selectRow('sm-1')
    const reason =
      'The models you chose were trained at different decision days (day 28 and day 56). Choose models with the same decision day.'
    expect(screen.getByTestId('txr-list-blocked-reason').textContent).toBe(reason)
    expect(screen.getByTestId('txr-list-run').hasAttribute('disabled')).toBe(true)
    // The horizon line names the first model's facts + the mixed look-ahead
    // (the KEPT bytes: TxrModelHorizonLine's plain apostrophe, U+0027).
    expect(screen.getByTestId('txr-models-choose-horizon').textContent).toContain(
      'Look ahead to: day 240 (240 days \u2248 7.9 months), the model\u0027s own. It cannot be changed.',
    )
    expect(screen.getByTestId('txr-models-choose-horizon').textContent).toContain(
      'The models you chose look ahead to different days; the run uses the first one\u0027s.',
    )
    // The assistant path refuses with the same words.
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
    expect(api.resolveModels).not.toHaveBeenCalled()
    expect(api.createRun).not.toHaveBeenCalled()
  })

  it('a lab + saved same-day selection: ONE resolve, ONE reuse run, config from the first', async () => {
    renderPage()
    await settle(0)
    await selectRow('ps:lc-1')
    await selectRow('sm-1')
    expect(screen.queryByTestId('txr-list-blocked-reason')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.installModel).not.toHaveBeenCalled() // lc-1 is installed
    expect(api.resolveModels).toHaveBeenCalledTimes(1)
    expect(api.resolveModels).toHaveBeenCalledWith({
      model_ids: ['c0000000-0000-4000-8000-000000000001', 'sm-1'],
    })
    expect(api.createRun).toHaveBeenCalledTimes(1)
    const request = api.createRun.mock.calls[0][0] as {
      mode: string
      config: Record<string, unknown>
      model_ids: unknown[]
    }
    expect(request.mode).toBe('reuse')
    expect(request.config.endpoint).toBe('pfs')
    expect(request.config.decision_day).toBe(56)
    expect(request.config.look_ahead_day).toBe(240)
    expect(request.model_ids).toHaveLength(2)
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('models.setSelection and models.setListFilters: applied with the token, refused as stale without', async () => {
    renderPage()
    await settle(0)
    const live = instancesOfType('txr.model-list')
    expect(live.length).toBe(1)
    const viewId = live[0].id
    const token = live[0].record.getSnapshot()['_state_token'] as string

    // Wrong token → STALE_STATE, nothing written.
    let refused: unknown
    await act(async () => {
      refused = await runAction('models.setSelection', {
        view_id: viewId,
        expected: 'stale-token',
        ids: ['sm-2'],
      }).catch((error: unknown) => error)
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('STALE_STATE')
    expect(useTxrModelsStore.getState().selection.has('sm-2')).toBe(false)

    // Right token → applied.
    await act(async () => {
      await runAction('models.setSelection', { view_id: viewId, expected: token, ids: ['sm-2'] })
    })
    await settle(0)
    expect(useTxrModelsStore.getState().selection.has('sm-2')).toBe(true)

    const token2 = live[0].record.getSnapshot()['_state_token'] as string
    expect(token2).not.toBe(token)

    // setListFilters: stale then applied.
    await act(async () => {
      refused = await runAction('models.setListFilters', {
        view_id: viewId,
        expected: token,
        sources: ['lab'],
        canRunOnly: true,
        chips: ['same-outcome'],
        search: 'lc',
        sort: 'time',
      }).catch((error: unknown) => error)
    })
    expect(refused).toBeInstanceOf(Error)
    await act(async () => {
      await runAction('models.setListFilters', {
        view_id: viewId,
        expected: token2,
        sources: ['lab'],
        canRunOnly: true,
        chips: ['same-outcome'],
        search: 'lc',
        sort: 'time',
      })
    })
    await settle(0)
    const state = useTxrModelsStore.getState()
    expect(state.filters).toEqual(['source-lab', 'same-outcome'])
    expect(state.canRunOnly).toBe(true)
    expect(state.search).toBe('lc')
    expect(state.sort).toBe('time')
    expect(rowKeys()).toEqual(['ps:lc-1', 'ps:lc-2'])
  })

  it('models.switchList maps saved → Saved + Imported and published → From the lab on the one list', async () => {
    renderPage()
    await settle(0)
    // The merged list declares the model-step context; the alias lands on
    // /choose-models with the Saved + Imported chips on.
    await act(async () => {
      await runAction('models.switchList', { list: 'saved' })
    })
    await settle(0)
    expect(useTxrModelsStore.getState().filters).toEqual(['source-saved', 'source-imported'])
    expect(useTxrIntakeStore.getState().intent).toBe('predict')
    expect(useTxrIntakeStore.getState().predictSource).toBe('saved')
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models')
    expect(rowKeys()).toEqual(['sm-1', 'sm-2'])
  })

  it('models.run with a same-day mix starts ONE run through the shared guarded path', async () => {
    renderPage()
    await settle(0)
    await selectRow('ps:lc-2')
    await selectRow('sm-1')
    const live = instancesOfType('txr.model-list')
    const token = live[0].record.getSnapshot()['_state_token'] as string
    await act(async () => {
      await runAction('models.run', { view_id: live[0].id, expected: token })
    })
    await settle(0)
    expect(api.resolveModels).toHaveBeenCalledTimes(1)
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })
})

describe('the old D/I routes redirect to the merged list (TEST-MOD-34)', () => {
  function renderRedirect(initial: string, element: ReactNode) {
    return render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/pretrained-models" element={element} />
          <Route path="/saved-models" element={element} />
          <Route path="/choose-models" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('/pretrained-models → /choose-models?source=lab, other query kept', async () => {
    renderRedirect('/pretrained-models?x=1', <PretrainedModelsRedirectRoute />)
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models?x=1&source=lab')
  })

  it('/saved-models → /choose-models?source=saved', async () => {
    renderRedirect('/saved-models', <SavedModelsRedirectRoute />)
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models?source=saved')
  })
})
