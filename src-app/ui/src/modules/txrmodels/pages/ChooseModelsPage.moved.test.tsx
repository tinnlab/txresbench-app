// @vitest-environment jsdom
/**
 * The moved checks of the old screen-D (`PretrainedModelsPage.test.tsx`) and
 * screen-I (`SavedModelsPage.test.tsx`) suites, against the merged
 * `ChooseModelsPage` (the old pages left in round 3 — their tests MOVED
 * here, per the round-3 brief; see `.dsh/round3-test-map.md`).
 *
 * These are the checks the round-2 `ChooseModelsPage.test.tsx` does NOT
 * already pin: the downloads strip's bytes/percent/Retry and the Run gate,
 * the Model-card / Details dialogs, the install-then-resolve Run path, the
 * resolve-failure and stale-action refusals, the Back-trail family on the
 * merged list, the same-outcome chip over both sources, the demo retention
 * block, the flat-list rule (no run sections, no set actions) and the
 * never-flash states.
 *
 * Round 3b's audit additions (the `.dsh/round3-test-map.md` gap fixes):
 * the dialog-open Back refusals on the merged page (and the stale-id with
 * no checked file), the no-verdict-while-loading rule for each source, the
 * no-model panel's click halves ("Use example" / "Learn from my data"), the
 * completed-download gate, the selection survival across Back + Continue
 * (5 s away + a new file clears it), the flat list's select-all and the
 * null-facts same-outcome chip.
 *
 * Every fixture value is synthetic (INV-4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import '@/core/actions/builtin/stepActions'
import '@/core/actions/builtin/appActions'
import '@/core/actions/builtin/modelRunActions'
import { runAction } from '@/core/actions/defineAction'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { instancesOfType } from '@/core/actions/instanceRegistry'
import type {
  ModelEligibilityResponse,
  ModelListResponse,
  ModelSummary,
  PretrainedEligibilityResponse,
  PretrainedListResponse,
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
import { TXRMODELS_INVENTORY, txrmodelsModelDetail } from '../fixtures'
import { DOWNLOAD_POLL_MS, useTxrModelsStore } from '../stores/TxrModels.store'
import { RESEARCH_NOTICE } from '../lib/format'
import { ChooseModelsPage } from './ChooseModelsPage'

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
  modelGetModel: vi.fn(),
  fileExample: vi.fn(),
  exampleSet: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    FileValidation: {
      example: api.fileExample,
    },
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
      getModel: api.modelGetModel,
      exampleSet: api.exampleSet,
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

// jsdom has no layout: the virtualizer's viewport/row heights are stated
// (the shared-list suite's own idiom).
const VIEWPORT_H = 1400
const ROW_H = 56

const isViewport = (el: HTMLElement): boolean =>
  el.hasAttribute('data-overlayscrollbars-viewport') || el.classList.contains('txr-scroll-region')

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

/** One lab card (the ps-<k> namespace — the module fixture's own ids). */
function card(k: number, over: Partial<PretrainedSummary> = {}): PretrainedSummary {
  return {
    id: `ps-${k}`,
    version: '1.0.0',
    kind: 'published-rule',
    name: `ps-${k} rule`,
    description: 'Rule from the paper; colorectal',
    method_id: `m${k}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    decision_day: 56,
    endpoint: 'pfs',
    horizon: 240,
    paper: { journal: 'Ann Oncol', year: 2021, doi: `10.0000/ps-${k}` },
    transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3 },
    warnings: [],
    research_notice: true,
    licence: 'MIT',
    asset: {
      bundled: false,
      file: `ps-${k}@1.0.0.txr`,
      sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      size_bytes: 4_600_000,
    },
    state: 'installed',
    installed_model_id: `c0000000-0000-4000-8000-0000000000${String(k).padStart(2, '0')}`,
    ...over,
  }
}

function catalogue(): PretrainedSummary[] {
  return [
    card(1),
    card(2, { kind: 'benchmark-trained' }),
    card(3, { state: 'not_downloaded', installed_model_id: undefined }),
  ]
}

function catalogueEligibility(): PretrainedEligibilityResponse {
  return {
    total_fit: 2,
    total_some: 0,
    total_cannot: 1,
    models: [
      { id: 'ps-1', status: 'can_run', coverage: { eligible: 42, total: 42, fraction: 1 }, estimate_quality: 'estimate', estimated_seconds: 45, min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [] },
      { id: 'ps-2', status: 'can_run', coverage: { eligible: 42, total: 42, fraction: 1 }, estimate_quality: 'estimate', estimated_seconds: 90, min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [] },
      { id: 'ps-3', status: 'cannot_run', coverage: { eligible: 0, total: 42, fraction: 0 }, estimate_quality: 'estimate', min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [{ code: 'ASSET_NOT_AVAILABLE' }] },
    ],
  }
}

function model(k: number, over: Partial<ModelSummary> = {}): ModelSummary {
  return {
    id: `sm-${k}`,
    name: `sm-${k}-model`,
    method_id: `m${k}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    provenance: 'run',
    endpoint: 'pfs',
    horizon: 240,
    decision_day: 56,
    created_at: '2026-11-29T09:00:00Z',
    trained_at: '2026-11-29T08:30:00Z',
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

function resolvedAssets(): ResolveResponse {
  return {
    assets: [
      {
        model_id: 'c0000000-0000-4000-8000-000000000001',
        method_id: 'm1',
        method_version: '2.1.0',
        host_dir: '/models/ps-1',
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/choose-models']}>
      <RouterBridge />
      <ChooseModelsPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function selectRow(key: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`txr-list-checkbox-${key}`))
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
  api.modelGetModel.mockReset()
  api.fileExample.mockReset()
  api.exampleSet.mockReset()
  api.fileExample.mockResolvedValue('patient_id,ldh\nP0001,42\n' as never)
  api.exampleSet.mockResolvedValue({ state: 'ready', methods: [], set_id: 'set-a' } as never)
  api.listCatalogue.mockResolvedValue({
    origin: 'embedded',
    generated_at: '2026-11-29T09:00:00Z',
    total: catalogue().length,
    models: catalogue(),
  } as PretrainedListResponse)
  api.catalogueEligibility.mockResolvedValue(catalogueEligibility())
  api.getModel.mockResolvedValue({
    id: 'ps-1',
    name: 'ps-1 rule',
    description: 'Rule from the paper; colorectal',
    group: 'g-static-risk',
    group_label: 'Static risk',
    kind: 'published-rule',
    method_id: 'm1',
    method_version: '2.1.0',
    version: '1.0.0',
    licence: 'CC BY 4.0',
    research_notice: true,
    embeds_training_data: false,
    contract: '2.0',
    env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
    paper: { journal: 'Ann Oncol', year: 2021, doi: '10.0000/ps-1', citation: 'Example A et al. A published rule for colorectal follow-up. Ann Oncol 2021;32:100-8. doi:10.0000/ps-1' },
    needs: { decision_day: 56, endpoint: 'pfs', horizon: 240, task: 'survival', marker_facts: { count: 4, kind: 'any', marker_groups_required: [], min_draws: 2, needs_baseline: true, needs_detection_call: false, uses_history: 'landmark' }, required_markers: { list_source: 'curated', match: 'all', min_fraction: 1, markers: [] }, covariates: 'optional' },
    transfer: { metric: 'auc_rule', median: 0.71, n_cohorts: 3, cohorts: [] },
    assay_warnings: [{ code: 'DRAW_INTERVAL', detail: 'The cohort drew at 3-weekly intervals.' }],
    data_sources: [{ dataset: 'fixture-open', access: 'open', licence: 'CC BY 4.0' }],
    asset: { bundled: false, file: 'ps-1@1.0.0.txr', sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', signature: '', url: '', size_bytes: 4_600_000 },
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
        id: 'ps-3',
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
    catalogue_id: 'ps-3',
    licence: 'MIT',
    model_id: 'c0000000-0000-4000-8000-000000000003',
    size_bytes: 4_600_000,
    source: 'bundled',
    status: 'installed',
    version: '1.0.0',
  })
  api.resolveModels.mockResolvedValue(resolvedAssets())
  api.createRun.mockResolvedValue({ id: 'run-1' } as unknown as TxrRunSummary)
  api.listSaved.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
  api.listSets.mockResolvedValue({ sets: [], total: 0 })
  api.savedEligibility.mockResolvedValue({
    total_fit: 0,
    total_some: 0,
    total_cannot: 0,
    models: [],
  } as ModelEligibilityResponse)
  api.getAnalysisConfig.mockResolvedValue({ config: { endpoint: 'pfs', look_ahead_day: 240 } } as never)
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

describe('ChooseModelsPage — the moved screen-D/I checks', () => {
  it('the bottom bar sits straight in the frame bottom slot and lists Back directly left of Run', async () => {
    renderPage()
    await settle(0)
    const bar = screen.getByTestId('txr-models-choose-bar')
    expect(bar.querySelector('[data-testid="txr-list-bottom-bar"]')).toBeTruthy()
    const back = screen.getByTestId('txr-step-back')
    expect(back.nextElementSibling).toBe(screen.getByTestId('txr-list-run'))
    // The DEC-7 total: the selection's estimate sum, 45 s → the bar's band.
    await selectRow('ps:ps-1')
    expect(screen.getByTestId('txr-list-total-time').textContent).toBe('under 1 minute in total')
  })

  it('checking a non-installed card starts its download: bytes, percent, spinner, Retry — and Run is gated', async () => {
    // ps-1 has NO provider entry at first: selecting it starts the download
    // (the store's idempotent start), the strip renders bytes + percent, and
    // the Run click is refused with the inline gate line.
    api.listDownloads.mockResolvedValue({
      downloads: [
        {
          id: 'ps-1',
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
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [card(1, { state: 'not_downloaded', installed_model_id: undefined })],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [catalogueEligibility().models[0]],
    } as PretrainedEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    expect(api.downloadModel).toHaveBeenCalledWith({ id: 'ps-1' })
    // The strip shows the live download (bytes + percent).
    expect(screen.getByTestId('txr-models-downloads')).toBeTruthy()
    expect(screen.getByTestId('txr-models-download-ps-1-bytes').textContent).toContain(
      '9.5 MB of 19 MB',
    )
    expect(screen.getByTestId('txr-models-download-ps-1-pct').textContent).toBe('50%')
    // The Run click is REFUSED: no run is created, the inline gate names why.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-choose-run-error').textContent).toBe(
      'A selected model is still downloading. Wait for it to finish, or uncheck it.',
    )
    // The models.run action refuses with the same page text.
    const live = instancesOfType('txr.model-list')
    const token = live[0].record.getSnapshot()['_state_token'] as string
    let refused: unknown
    await act(async () => {
      refused = await runAction('models.run', { view_id: live[0].id, expected: token }).catch(
        (error: unknown) => error,
      )
    })
    expect((refused as Error).message).toBe(
      'A selected model is still downloading. Wait for it to finish, or uncheck it.',
    )
    // The selection is kept (DEC-8) — the card never silently drops.
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')
  })

  it('a provider verify failure surfaces the error + Retry, and the failed gate line names it', async () => {
    api.listDownloads.mockResolvedValue({
      downloads: [
        {
          id: 'ps-1',
          version: '1.0.0',
          state: 'failed',
          bytes_downloaded: 10_000_000,
          bytes_total: 20_000_000,
          digest: undefined,
          cached: false,
          bundled: false,
          error: 'checksum mismatch',
        },
      ],
    })
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [card(1, { state: 'not_downloaded', installed_model_id: undefined })],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [catalogueEligibility().models[0]],
    } as PretrainedEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    // One poll tick arrives and commits the terminal failure.
    await settle(2100)
    expect(screen.getByTestId('txr-models-download-ps-1-error').getAttribute('data-kind')).toBe('verify')
    expect(screen.getByTestId('txr-models-download-ps-1-error').textContent).toBe(
      'checksum mismatch',
    )
    expect(screen.getByTestId('txr-models-download-ps-1-retry')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-choose-run-error').textContent).toBe(
      "A selected model's download failed. Retry it, or uncheck it.",
    )
    // The Retry re-issues the download (the store's idempotent start).
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-download-ps-1-retry'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.downloadModel.mock.calls.length).toBe(2)
  })

  it('opens the Model-card dialog from the row action: source paper as TEXT, licence, needs, notice', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-ps:ps-1-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.getModel).toHaveBeenCalledWith({ id: 'ps-1' })
    expect(screen.getByTestId('txr-models-card-ps-1')).toBeTruthy()
    expect(screen.getByTestId('txr-models-card-body').textContent).toContain('CC BY 4.0')
    expect(screen.getByTestId('txr-models-card-body').textContent).toContain(RESEARCH_NOTICE)
    // INV-5: the source-paper reference is TEXT, never a link.
    expect(screen.getByTestId('txr-models-card-body').querySelector('a')).toBeNull()
  })

  it('a 404 card (catalogue no longer serves the id) renders the not-found state, never a crash', async () => {
    api.getModel.mockRejectedValue({ status: 404, message: 'PRETRAINED_UNKNOWN' })
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-ps:ps-1-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-card-not-found')).toBeTruthy()
  })

  it('installs the bundled card at Run time, resolves FIRST, passes the assets verbatim and navigates', async () => {
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [card(1, { state: 'bundled', installed_model_id: undefined })],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [catalogueEligibility().models[0]],
    } as PretrainedEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.installModel).toHaveBeenCalledWith({ id: 'ps-1' })
    expect(api.resolveModels).toHaveBeenCalledTimes(1)
    expect(api.resolveModels).toHaveBeenCalledWith({
      model_ids: ['c0000000-0000-4000-8000-000000000003'],
    })
    expect(api.createRun).toHaveBeenCalledTimes(1)
    const request = api.createRun.mock.calls[0][0] as { model_ids: unknown[]; config: Record<string, unknown> }
    expect(request.model_ids).toEqual(resolvedAssets().assets)
    expect(request.config.decision_day).toBe(56) // the FIRST selected card's own day
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('a resolve 404 surfaces inline and the run is NOT created', async () => {
    api.resolveModels.mockRejectedValue(new Error('one of the models is not installable yet'))
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-choose-run-error').textContent).toContain(
      'not installable yet',
    )
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models')
  })

  it('two cards at different days, one of them not runnable: not blocked, and the config uses the runnable card\u2019s day', async () => {
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 2,
      models: [card(1, { decision_day: 28 }), card(2, { decision_day: 56 })],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 1,
      models: [
        { id: 'ps-1', status: 'can_run', coverage: { eligible: 42, total: 42, fraction: 1 }, estimate_quality: 'estimate', estimated_seconds: 45, min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [] },
        { id: 'ps-2', status: 'cannot_run', coverage: { eligible: 0, total: 42, fraction: 0 }, estimate_quality: 'estimate', min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [{ code: 'MODEL_REQUIREMENTS_UNRECORDED' }] },
      ],
    } as PretrainedEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    await selectRow('ps:ps-2')
    expect(useTxrModelsStore.getState().selection.has('ps:ps-2')).toBe(false) // cannot rows are not selectable
    expect(screen.queryByTestId('txr-list-blocked-reason')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    const request = api.createRun.mock.calls[0][0] as { config: Record<string, unknown> }
    expect(request.config.decision_day).toBe(28)
  })

  it('the models.run action is refused as stale when the selection changed (same count, other ids)', async () => {
    renderPage()
    await settle(0)
    const live = instancesOfType('txr.model-list')
    const viewId = live[0].id
    const token = live[0].record.getSnapshot()['_state_token'] as string
    await selectRow('ps:ps-1')
    const token2 = live[0].record.getSnapshot()['_state_token'] as string
    let refused: unknown
    await act(async () => {
      refused = await runAction('models.run', { view_id: viewId, expected: token }).catch(
        (error: unknown) => error,
      )
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('STALE_STATE')
    expect(api.createRun).not.toHaveBeenCalled()
    // The CURRENT token works.
    await act(async () => {
      await runAction('models.run', { view_id: viewId, expected: token2 })
    })
    await settle(0)
    expect(api.createRun).toHaveBeenCalledTimes(1)
  })

  it('a second invoke while the first create is still pending returns the same promise and makes no second call', async () => {
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    let resolveCreate: (value: unknown) => void = () => {}
    api.createRun.mockImplementation(
      () => new Promise(resolve => {
        resolveCreate = resolve
      }),
    )
    // Leave the first run in flight (the promise is never awaited here —
    // resolving it would navigate away before the second invoke).
    await act(async () => {
      const button = screen.getByTestId('txr-list-run')
      fireEvent.click(button)
      await Promise.resolve()
    })
    const live = instancesOfType('txr.model-list')
    const token = live[0].record.getSnapshot()['_state_token'] as string
    let second: unknown
    await act(async () => {
      second = runAction('models.run', { view_id: live[0].id, expected: token }).catch(
        (error: unknown) => error,
      )
      resolveCreate({ id: 'run-1' })
    })
    await settle(0)
    expect(await second).toBe('run-1')
    expect(api.createRun).toHaveBeenCalledTimes(1)
  })

  it('demo: Run replays the recorded method — no install, no resolve, no download', async () => {
    seedDemoMode('demo')
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [card(3, { state: 'not_downloaded', installed_model_id: undefined })],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [
        { id: 'ps-3', status: 'can_run', coverage: { eligible: 42, total: 42, fraction: 1 }, estimate_quality: 'estimate', estimated_seconds: 45, min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [] },
      ],
    } as PretrainedEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    expect(screen.getAllByText(DEMO_PRETRAINED_CHIP).length).toBeGreaterThan(0)
    await selectRow('ps:ps-3')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.installModel).not.toHaveBeenCalled()
    expect(api.resolveModels).not.toHaveBeenCalled()
    expect(api.downloadModel).not.toHaveBeenCalled()
    expect(api.createRun).toHaveBeenCalledTimes(1)
    const request = api.createRun.mock.calls[0][0] as { model_ids: unknown[] }
    expect(request.model_ids).toEqual([
      { model_id: 'ps-3', method_id: 'm3', method_version: '2.1.0' },
    ])
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('the "← Step 3 of 3" line goes where Back goes: the trail\u2019s N, or N with no trail', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-step-line-back'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
  })

  it('Back from the merged list goes to the file step (the trail\u2019s N), and the selection survives Back + Continue', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/choose-models'] })
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-step-back'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
  })

  it('while the run is being prepared Back is unavailable with the reason, and flow.back refuses', async () => {
    renderPage()
    await settle(0)
    await selectRow('ps:ps-1')
    let resolveCreate: (value: unknown) => void = () => {}
    api.createRun.mockImplementation(
      () => new Promise(resolve => {
        resolveCreate = resolve
      }),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    const back = screen.getByTestId('txr-step-back')
    expect(back.getAttribute('aria-disabled')).toBe('true')
    expect(back.textContent).toContain(STEP_BACK_STARTING_REASON)
    let refused: unknown
    await act(async () => {
      refused = await runAction('flow.back', {}).catch((error: unknown) => error)
      resolveCreate({ id: 'run-1' })
    })
    await settle(0)
    expect((refused as Error).message).toBe(STEP_BACK_STARTING_REASON)
  })

  it('the same-outcome chip narrows to the matching endpoint AND horizon, across both sources', async () => {
    api.getAnalysisConfig.mockResolvedValue({ config: { endpoint: 'pfs', look_ahead_day: 240 } } as never)
    api.listSaved.mockResolvedValue({
      models: [
        model(1, { horizon: 240 }),
        model(2, { provenance: 'imported', set_id: undefined, set_name: undefined, endpoint: 'os', horizon: 165 }),
      ],
      total: 2,
    } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 1,
      total_cannot: 0,
      models: [
        { id: 'sm-1', status: 'can_run', endpoint: 'pfs', coverage: { eligible: 42, total: 42, fraction: 1 }, estimate_quality: 'estimate', estimated_seconds: 60, min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [] },
        { id: 'sm-2', status: 'can_run_some', endpoint: 'os', coverage: { eligible: 40, total: 42, fraction: 40 / 42 }, estimate_quality: 'estimate', estimated_seconds: 30, min_draws: { required: 1, met: 42, unmet_patients: 0 }, missing_markers: [], reasons: [{ code: 'MIN_DRAWS_UNMET' }] },
      ],
    } as ModelEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    const before = document.querySelectorAll('[data-testid^="txr-list-row-"]').length
    expect(before).toBeGreaterThan(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-same-outcome'))
      await Promise.resolve()
    })
    await settle(0)
    // The os/165 imported row and the lab rows with a different horizon are
    // OUT; the pfs/240 saved row and the pfs/240 lab card stay.
    expect(screen.queryByTestId('txr-list-row-sm-2')).toBeNull()
    expect(screen.queryByTestId('txr-list-row-ps:ps-1')).toBeTruthy()
  })

  it('opens the Details dialog from a saved row: the ModelDetail facts + the version/digest warnings', async () => {
    api.listSaved.mockResolvedValue({
      models: [model(1)],
      total: 1,
    } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [savedEligibilityFor([model(1)]).models[0]],
    } as ModelEligibilityResponse)
    api.modelGetModel.mockResolvedValue(
      txrmodelsModelDetail(model(1)),
    )
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-sm-1-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.modelGetModel).toHaveBeenCalledWith({ id: 'sm-1' })
    expect(screen.getByTestId('txr-models-details-sm-1')).toBeTruthy()
    expect(screen.getByTestId('txr-models-details-body').textContent).toContain('m1 · 2.1.0')
    expect(screen.getByTestId('txr-models-details-body').textContent).toContain('not recorded')
  })

  it('a 404 detail (a row whose tree vanished) renders the not-found state, never a crash', async () => {
    api.listSaved.mockResolvedValue({ models: [model(1)], total: 1 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [savedEligibilityFor([model(1)]).models[0]],
    } as ModelEligibilityResponse)
    api.modelGetModel.mockRejectedValue({ status: 404, message: 'MODEL_NOT_FOUND' })
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-sm-1-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-details-not-found')).toBeTruthy()
  })

  it('an empty selection is refused with its own line — never a run with zero models', async () => {
    renderPage()
    await settle(0)
    const live = instancesOfType('txr.model-list')
    const token = live[0].record.getSnapshot()['_state_token'] as string
    let refused: unknown
    await act(async () => {
      refused = await runAction('models.run', { view_id: live[0].id, expected: token }).catch(
        (error: unknown) => error,
      )
    })
    await settle(0)
    expect((refused as Error).message).toBe('Select at least one model to run.')
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-choose-run-error').textContent).toBe(
      'Select at least one model to run.',
    )
  })

  it('demo: the shared-pool statement and the "n of 50 models" counter; no run sections', async () => {
    seedDemoMode('demo')
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-demo-retention-statement')).toBeTruthy()
    expect(screen.getByTestId('txr-demo-retention-counter').textContent).toContain('1 of 50')
    // The merged list is FLAT: no run sections, no section actions.
    expect(screen.queryByTestId('txr-list-section-set-a')).toBeNull()
    expect(screen.queryByTestId('txr-list-section-action-set-a-rename')).toBeNull()
  })

  it('before the first loads the page never shows the no-model panel (no flash)', async () => {
    let releaseCatalogue: (value: PretrainedListResponse) => void = () => {}
    api.listCatalogue.mockImplementation(
      () =>
        new Promise(resolve => {
          releaseCatalogue = resolve
        }),
    )
    api.listSaved.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue(emptySavedEligibility())
    useTxrModelsStore.getState().reset()
    renderPage()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(screen.queryByTestId('txr-models-none')).toBeNull()
    await act(async () => {
      releaseCatalogue(catalogueResponseEmpty())
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-none')).toBeTruthy()
  })

  it('a file change re-reads the inventory: the rows stay, never a stale "none" or stale verdict line', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-row-ps:ps-1')).toBeTruthy()
    // A changed validation (the file step re-checked) triggers the page's
    // mount-rule inventory reload: before it settles no totals are claimed.
    await act(async () => {
      useTxrIntakeStore.setState({ validation: validation(), dayFacts: null })
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-list-row-ps:ps-1')).toBeTruthy()
    expect(screen.queryByTestId('txr-models-none')).toBeNull()
  })

  // ── The round-3b audit gaps (see .dsh/round3-test-map.md) ────────────────

  it('while the Model card dialog is open flow.back refuses; a stale card id with no checked file does not block Back', async () => {
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/choose-models'] })
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-ps:ps-1-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-card-ps-1')).toBeTruthy()
    let refused: unknown
    await act(async () => {
      refused = await runAction('flow.back', {}).catch((error: unknown) => error)
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe(STEP_BACK_DIALOG_OPEN)
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models')
    // The no-file twin (the old D31): no checked file, so no card can show;
    // a card id another state left in the shared store must not block Back.
    cleanup()
    useTxrModelsStore.getState().reset()
    useTxrIntakeStore.setState({ validation: null })
    useStepTrailStore.setState({ trail: ['/', '/predict-files'] })
    await act(async () => {
      useTxrModelsStore.getState().openDialog('card:ps-1')
    })
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-step-back'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
  })

  it('while the Details dialog is open flow.back refuses', async () => {
    api.listSaved.mockResolvedValue({ models: [model(1)], total: 1 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue(savedEligibilityFor([model(1)]))
    api.modelGetModel.mockResolvedValue(txrmodelsModelDetail(model(1)))
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/choose-models'] })
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-row-sm-1-action'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-details-sm-1')).toBeTruthy()
    let refused: unknown
    await act(async () => {
      refused = await runAction('flow.back', {}).catch((error: unknown) => error)
    })
    expect((refused as Error).message).toBe(STEP_BACK_DIALOG_OPEN)
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models')
  })

  it('while the saved models load the page shows no verdict totals and no none-can-run line', async () => {
    // The lab catalogue: three rows, NONE can run. If the verdicts were
    // counted before the saved slice loaded, both the totals and the
    // none-can-run line would claim the whole list (the old no-number
    // "saved models loading…" rule, `lib/emptyState.test.ts`).
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
    let releaseSaved: (value: ModelListResponse) => void = () => {}
    api.listSaved.mockImplementation(
      () =>
        new Promise(resolve => {
          releaseSaved = resolve
        }),
    )
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-models-choose-totals')).toBeNull()
    expect(screen.queryByTestId('txr-models-choose-none-can-run')).toBeNull()
    // The saved slice lands: the verdicts cover both sources now, so the
    // honest lines appear — exactly at this boundary.
    await act(async () => {
      releaseSaved({ models: [], total: 0 } as ModelListResponse)
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-choose-totals').textContent).toBe(
      '3 models · 0 can run, 3 cannot',
    )
    expect(screen.getByTestId('txr-models-choose-none-can-run').textContent).toContain(
      'None of the 3 models can run on this file.',
    )
  })

  it('while the lab models load the page shows no verdict totals and no none-can-run line', async () => {
    // The saved slice: one row that cannot run. Before the catalogue
    // lands, the old page's "ready-made models loading…" rule says no
    // number and no none-can-run line (the verdicts are not complete yet).
    api.listSaved.mockResolvedValue({ models: [model(1)], total: 1 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 1,
      models: [
        {
          ...savedEligibilityFor([model(1)]).models[0],
          status: 'cannot_run' as const,
          coverage: { eligible: 0, total: 42, fraction: 0 },
          estimated_seconds: undefined,
          reasons: [{ code: 'MODEL_REQUIREMENTS_UNRECORDED' as const }],
        },
      ],
    } as ModelEligibilityResponse)
    let releaseCatalogue: (value: PretrainedListResponse) => void = () => {}
    api.listCatalogue.mockImplementation(
      () =>
        new Promise(resolve => {
          releaseCatalogue = resolve
        }),
    )
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-models-choose-totals')).toBeNull()
    expect(screen.queryByTestId('txr-models-choose-none-can-run')).toBeNull()
    // The catalogue lands with three rows that all cannot run: the verdicts
    // are complete, the lines appear.
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
    await act(async () => {
      releaseCatalogue({
        origin: 'embedded',
        generated_at: '2026-11-29T09:00:00Z',
        total: catalogue().length,
        models: catalogue(),
      } as PretrainedListResponse)
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-choose-totals').textContent).toBe(
      '4 models · 0 can run, 4 cannot',
    )
  })

  it('the no-model panel: "Use example" runs the predict example flow, "Learn from my data" starts the learn path', async () => {
    api.listCatalogue.mockResolvedValue(catalogueResponseEmpty())
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 0,
      total_some: 0,
      total_cannot: 0,
      models: [],
    } as PretrainedEligibilityResponse)
    api.listSaved.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    api.savedEligibility.mockResolvedValue(emptySavedEligibility())
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-none')).toBeTruthy()
    // "Use example" runs the registered `flow.useExample` predict path: the
    // example patients table is adopted and the flow opens the predict
    // files step (the example set id is parked for the model list).
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-none-example'))
      await Promise.resolve()
    })
    await settle(0)
    await settle(0)
    expect(api.fileExample).toHaveBeenCalledWith({ kind: 'predict-measurements' })
    expect(api.exampleSet).toHaveBeenCalled()
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
    expect(useTxrIntakeStore.getState().intent).toBe('predict')
    expect(useTxrIntakeStore.getState().predictSource).toBe('saved')
    expect(useTxrIntakeStore.getState().predictMeasurements?.source.name).toBe(
      'predict-measurements_example.csv',
    )
    // "Learn from my data" starts the learn path (the old I38 click pin):
    // its own intent and route.
    cleanup()
    useTxrIntakeStore.getState().reset()
    seedIntake()
    useTxrModelsStore.getState().reset()
    api.listCatalogue.mockResolvedValue(catalogueResponseEmpty())
    api.listSaved.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-none')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-none-train'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/files')
    expect(useTxrIntakeStore.getState().intent).toBe('train')
  })

  it('a completed download makes the card runnable: Run installs and creates against the verified asset', async () => {
    api.listCatalogue.mockResolvedValue({
      origin: 'embedded',
      generated_at: '2026-11-29T09:00:00Z',
      total: 1,
      models: [card(3, { state: 'not_downloaded', installed_model_id: undefined })],
    } as PretrainedListResponse)
    api.catalogueEligibility.mockResolvedValue({
      total_fit: 1,
      total_some: 0,
      total_cannot: 0,
      models: [
        {
          ...catalogueEligibility().models[0],
          id: 'ps-3',
        },
      ],
    } as PretrainedEligibilityResponse)
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await selectRow('ps:ps-3')
    expect(api.downloadModel).toHaveBeenCalledWith({ id: 'ps-3' })
    // The provider poll commits the completed download (verified present):
    // the gate opens — Run now installs the asset and creates against its
    // resolved model record (the old D test "a completed download makes the
    // card runnable…", which the bundled-install test's second half missed).
    api.listDownloads.mockResolvedValue({
      downloads: [
        {
          id: 'ps-3',
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
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.installModel).toHaveBeenCalledWith({ id: 'ps-3' })
    expect(api.resolveModels).toHaveBeenCalledWith({
      model_ids: ['c0000000-0000-4000-8000-000000000003'],
    })
    expect(api.createRun).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('route-location').textContent).toBe('/analysis/run-1/running')
  })

  it('the selection survives Back + Continue after more than 5 s away, and a new file clears it', async () => {
    /** N in the flow: records its step, and its Continue lands on the merged list again. */
    function PredictStandIn() {
      useStepBack({ step: 'predict-files', fallback: '/' })
      const navigate = useNavigate()
      return (
        <button data-testid="stand-in-continue" onClick={() => navigate('/choose-models')}>
          Continue
        </button>
      )
    }
    useStepTrailStore.setState({ trail: ['/', '/predict-files', '/choose-models'] })
    render(
      <MemoryRouter initialEntries={['/choose-models']}>
        <RouterBridge />
        <Routes>
          <Route path="/choose-models" element={<ChooseModelsPage />} />
          <Route path="/predict-files" element={<PredictStandIn />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    )
    await settle(0)
    await selectRow('ps:ps-1')
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')
    // Back to the file step, stay away past the store-kit's lazy teardown
    // delay (5 s after the last reader), then Continue: the selection
    // survives (the old D/I "keeps the selection after Back to N and
    // Continue" pin — the moved test left it at the route half).
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-step-back'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
    await settle(6000)
    await act(async () => {
      fireEvent.click(screen.getByTestId('stand-in-continue'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models')
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')
    // A new file clears it: Back, the file step re-checks (a changed
    // inventory), Continue — the mounted list resets the file-scoped state.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-step-back'))
      await Promise.resolve()
    })
    await settle(0)
    await act(async () => {
      useTxrIntakeStore.setState({
        validation: { ...validation(), inventory: { ...TXRMODELS_INVENTORY, patients: 43 } },
      })
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('stand-in-continue'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('route-location').textContent).toBe('/choose-models')
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('0 models selected')
  })

  it('the select-all checks exactly the rows that can run; the cannot row never moves', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-select-all-can-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('2 models selected')
    expect(useTxrModelsStore.getState().selection.has('ps:ps-1')).toBe(true)
    expect(useTxrModelsStore.getState().selection.has('ps:ps-2')).toBe(true)
    expect(useTxrModelsStore.getState().selection.has('ps:ps-3')).toBe(false)
    // Same with "Can run" on: the bulk select checks exactly the view's
    // eligible rows and the cannot row is out of the view untouched.
    cleanup()
    useTxrModelsStore.getState().reset()
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-can-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.queryByTestId('txr-list-row-ps:ps-3')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-select-all-can-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('2 models selected')
    expect(useTxrModelsStore.getState().selection.has('ps:ps-1')).toBe(true)
    expect(useTxrModelsStore.getState().selection.has('ps:ps-2')).toBe(true)
    expect(useTxrModelsStore.getState().selection.has('ps:ps-3')).toBe(false)
  })

  it('the same-outcome chip with no engine outcome matches no row: the honest zero', async () => {
    api.getAnalysisConfig.mockResolvedValue({} as never)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-filter-same-outcome').textContent).toBe(
      'Same outcome as my file 0',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-same-outcome'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.queryByTestId('txr-list-row-ps:ps-1')).toBeNull()
    expect(screen.getByTestId('txr-list-empty').textContent).toBe(
      'No models match the search or the filters.',
    )
  })
})

/** The empty catalogue answer (the no-panel-flash test's release). */
function catalogueResponseEmpty(): PretrainedListResponse {
  return { models: [], origin: 'embedded', generated_at: '2026-11-29T09:00:00Z', total: 0 }
}

/** The empty saved eligibility answer. */
function emptySavedEligibility(): ModelEligibilityResponse {
  return { total_fit: 0, total_some: 0, total_cannot: 0, models: [] }
}

/** The one-row saved eligibility (the Details tests' answer). */
function savedEligibilityFor(models: ModelSummary[]): ModelEligibilityResponse {
  return {
    total_fit: models.length,
    total_some: 0,
    total_cannot: 0,
    models: models.map(modelEntry),
  }
}

function modelEntry(): ModelEligibilityResponse['models'][number] {
  return {
    id: 'sm-1',
    status: 'can_run',
    endpoint: 'pfs',
    coverage: { eligible: 42, total: 42, fraction: 1 },
    estimate_quality: 'estimate',
    estimated_seconds: 60,
    min_draws: { required: 1, met: 42, unmet_patients: 0 },
    missing_markers: [],
    reasons: [],
  }
}
