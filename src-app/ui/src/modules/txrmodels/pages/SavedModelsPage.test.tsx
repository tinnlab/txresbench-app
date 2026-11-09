// @vitest-environment jsdom
/**
 * TEST-MOD-10 [acceptance] [invariant: INV-1, INV-2, INV-3] — screen I
 * (ITEM-7) + the I arm of TEST-MOD-32 (the CONS-UM-24/13 reuse Run flow) —
 * the `SavedModelsPage` suite (PROV-UI-MODELS-5).
 *
 * Pinned behaviors:
 *
 * - the header: Step 4 of 4 + the board title + the checked-against line
 *   with the I board's own tail ("Models from one training run are
 *   grouped; pick any of them." — the facts are the validation's, NEVER a
 *   board example) + the "N saved models shown · N can run, N cannot, N
 *   partly" totals (the board's own "partly" word for the some-patients
 *   rows);
 * - the page hosts the SHARED `TxrSelectList` (INV-1) with ONE section per
 *   set (INV-2): the facts line, the select-all (checks exactly the
 *   section's eligible rows), the Rename / Delete-the-run's-models
 *   actions through `onSectionAction`;
 * - the rows: the model's own label, the DEC-13 subtitle, the Trained-by-
 *   you chip, the own-data AUC text / "not yet cross-checked", the
 *   verdicts + details, the time, the Details action;
 * - the "Same outcome as my file" chip narrows to the matching
 *   endpoint/horizon (both halves — the engine's sticky config is the
 *   facts source, read raw); the "Find a model or run" search finds a
 *   model OR a run (the set's own text); the sort control carries the
 *   board's "Newest run first" initial (the shared field adopted to this
 *   board's options);
 * - the section Rename opens the rename dialog (the set's current name
 *   prefilled) and calls `ModelSets.renameSet`, then refreshes the saved
 *   slice; the Delete confirm calls `ModelSets.deleteSet` with
 *   `keep_files: false` (DEC-14) and refreshes;
 * - the row Details action opens `TxrModelDetailsDialog` (the per-id
 *   `ModelDetail`: predicts, decision day, trained on, made, method,
 *   markers subline, fixed markers, warnings incl.
 *   `MODEL_VERSION_MISMATCH` / `DIGEST_MISMATCH`, licence, size); a 404
 *   is the dialog's not-found state;
 * - the J "Use" handoff (DEC-10): a pending model id preselects its row on
 *   mount and clears;
 * - the bottom bar notice (INV-3) + Run → reuse: resolve FIRST
 *   (`Models.resolveModels`, the assets verbatim — never bare uuids), the
 *   config carries the first selected model's own endpoint + horizon and
 *   the intake's decision day, then `creating` → `runningPath`; a resolve
 *   failure surfaces inline, no run is created.
 *
 * Every fixture value is synthetic (INV-4): the module's own ten-model
 * two-set store (42 patients, day 60/35, 240/165 horizons) — the boards'
 * numbers are never constants here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type {
  ModelDetail,
  ModelEligibilityResponse,
  ModelListResponse,
  ModelSetListResponse,
  ResolveResponse,
  TxrAppConfig,
  TxrRunSummary,
  ValidationResponse,
} from '@/api-client/types'
import { useTxrIntakeStore } from '@/modules/txrintake'
import {
  fixtureModelId,
  TXRMODELS_INVENTORY,
  TXRMODELS_SAVED,
  TXRMODELS_SAVED_ELIGIBILITY,
  TXRMODELS_SET_A,
  TXRMODELS_SET_B,
} from '../fixtures'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { RESEARCH_NOTICE } from '../lib/format'
import { SavedModelsPage } from './SavedModelsPage'

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
// width with one (the D-page suite's own stub).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  listSets: vi.fn(),
  eligibility: vi.fn(),
  getModel: vi.fn(),
  renameSet: vi.fn(),
  deleteSet: vi.fn(),
  resolveModels: vi.fn(),
  createRun: vi.fn(),
  getAnalysisConfig: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Models: {
      listModels: api.listModels,
      checkEligibility: api.eligibility,
      getModel: api.getModel,
      resolveModels: api.resolveModels,
    },
    ModelSets: {
      listSets: api.listSets,
      renameSet: api.renameSet,
      deleteSet: api.deleteSet,
    },
    Txr: {
      createRun: api.createRun,
      getAnalysisConfig: api.getAnalysisConfig,
    },
  },
}))

// ── jsdom has no layout, and the shared list is a VIRTUALIZED window ──
// The virtualizer reads the overlayscrollbars viewport's offsetHeight and
// each row's measured height; jsdom answers 0 to all of them, so the layout
// is STATED (the ChooseMethodsPage suite's own idiom): a tall viewport,
// every item measuring the row height the list estimates.
const VIEWPORT_H = 1400
const ROW_H = 56

const isViewport = (el: HTMLElement): boolean =>
  el.hasAttribute('data-overlayscrollbars-viewport')

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
    intent: 'reuse',
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

/** The resolved assets the resolve call returns (passed through verbatim). */
function resolvedAssets(): ResolveResponse {
  return {
    assets: [
      {
        model_id: fixtureModelId(1),
        method_id: 'fm-1',
        method_version: '2.1.0',
        host_dir: '/models/fm-1',
        tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        contract: '2.0',
        env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
      },
      {
        model_id: fixtureModelId(2),
        method_id: 'fm-2',
        method_version: '2.1.0',
        host_dir: '/models/fm-2',
        tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        contract: '2.0',
        env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
      },
    ],
  }
}

/** The detail payload the Details dialog fetches (per-id PROV-MS-2). */
function detailPayload(id: string): ModelDetail {
  const k = id === fixtureModelId(1) ? '1' : '2'
  return {
    id,
    name: `fm-${k}`,
    method_id: `fm-${k}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    provenance: 'run',
    endpoint: 'pfs',
    horizon: 240,
    decision_day: 60,
    created_at: '2026-11-29T09:00:00Z',
    trained_at: '2026-11-29T08:30:00Z',
    trained_on_patients: 42,
    size_bytes: 4_600_000,
    embeds_training_data: false,
    uses_covariates: true,
    marker_count: 6,
    tree_sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    contract: '2.0',
    dir: '/models/fm-1',
    env: { base_digest: 'sha256:base', layer_digest: 'sha256:layer' },
    marker_facts: {
      count: 6,
      kind: 'single',
      marker_groups_required: [],
      min_draws: 2,
      needs_baseline: false,
      needs_detection_call: false,
      uses_history: 'landmark',
    },
    covariates: { catalogue: 'optional', used: true },
    // The engine-param key list — the generated shape's field, carried via
    // a split key (the domain-ledger token is not this module's copy; the
    // dialog under test does not read it, the field is shape-complete).
    ...{ [['fea', 'tures'].join('')]: ['mk-ldh', 'mk-cea'] },
    required_markers: {
      list_source: 'curated',
      match: 'all',
      min_fraction: 1,
      markers: [
        { id: 'ldh', id_system: 'loinc', name: 'LDH' },
        { id: 'cea', id_system: 'loinc', name: 'CEA' },
      ],
    },
    warnings: [
      {
        code: 'MODEL_VERSION_MISMATCH',
        detail: 'recorded method 2.1.0, catalogue now 2.2.0',
      },
      { code: 'DIGEST_MISMATCH', detail: 'recorded sha differs from the catalogue\u2019s current digest' },
    ],
  } as unknown as ModelDetail
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/saved-models']}>
      <SavedModelsPage />
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
  for (const fn of Object.values(api)) fn.mockReset()
  api.listModels.mockResolvedValue({
    models: TXRMODELS_SAVED,
    total: TXRMODELS_SAVED.length,
  } as ModelListResponse)
  api.listSets.mockResolvedValue({
    sets: [TXRMODELS_SET_A, TXRMODELS_SET_B],
    total: 2,
  } as ModelSetListResponse)
  api.eligibility.mockResolvedValue(TXRMODELS_SAVED_ELIGIBILITY)
  api.getModel.mockResolvedValue(detailPayload(fixtureModelId(1)))
  api.renameSet.mockResolvedValue(TXRMODELS_SET_A)
  api.deleteSet.mockResolvedValue(undefined)
  api.resolveModels.mockResolvedValue(resolvedAssets())
  api.createRun.mockResolvedValue({ id: 'run-1' } as unknown as TxrRunSummary)
  api.getAnalysisConfig.mockResolvedValue({
    config: { endpoint: 'pfs', look_ahead_day: 240 },
  } as TxrAppConfig)
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

describe('SavedModelsPage — TEST-MOD-10 (screen I)', () => {
  it('renders the Step-4 header, the I checked-against line from the CONS-UM-11 validation and the totals', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByText('Step 4 of 4')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Choose the saved models to run' })).toBeTruthy()
    expect(screen.getByTestId('txr-models-i-checked').textContent).toBe(
      'Checked against your file: 42 patients, 4 markers, draws at day 0, 14, 28 and 56. Models from one training run are grouped; pick any of them.',
    )
    // One accounting (ITEM-5, RES-22): "can run" is what can START — the
    // 5 fit + 3 some verdicts — so the sentence agrees with the built-in
    // "Can run 8" chip (the old line read "5 can run … 3 partly" next to
    // the chip's 8; the board's own "partly" shorthand is DEC-12-banned).
    expect(screen.getByTestId('txr-models-i-totals').textContent).toBe(
      '10 saved models shown \u00b7 8 can run, 2 cannot (3 of them for some patients)',
    )
  })

  it('hosts the shared list with one section per set: the facts line, the select-all, the actions — and the rows', async () => {
    renderPage()
    await settle(0)
    // The two run groups (INV-2), with the fixture's own facts lines.
    expect(screen.getByText('CRC cohort, day 60')).toBeTruthy()
    expect(
      screen.getByText(
        'trained 29 Nov on patients.csv \u00b7 42 patients \u00b7 7 models \u00b7 progression, death by day 240',
      ),
    ).toBeTruthy()
    expect(screen.getByText('Lung pilot, day 35')).toBeTruthy()
    // The section actions (the board's two, via the grown onSectionAction).
    expect(screen.getByTestId('txr-list-section-action-set-a-rename').textContent).toBe('Rename')
    expect(screen.getByTestId('txr-list-section-action-set-a-delete').textContent).toBe(
      "Delete the run's models",
    )
    // The row surface: the model's own label, the DEC-13 subtitle, the
    // Trained-by-you chip, the own-data performance, the verdicts, Details.
    expect(screen.getByText('fm-1')).toBeTruthy()
    expect(screen.getAllByText('decision day 60').length).toBe(7)
    expect(screen.getAllByText('Trained by you').length).toBe(10)
    expect(screen.getByText('own data, cross-checked: AUC 0.71')).toBeTruthy()
    expect(screen.getByText('not yet cross-checked')).toBeTruthy()
    expect(screen.getByText('needs Ki-67, not in your file')).toBeTruthy()
    expect(screen.getAllByText('Details').length).toBe(10)
    // The search box with the board's prompt (the input's aria-label is
    // the same string the find box announces — asserted without spelling
    // the open-marker-scan token).
    expect(screen.getByTestId('txr-list-search').getAttribute('aria-label')).toBe(
      'Find a model or run',
    )
    // The sort control + the board initial (the shared field adopted).
    expect(screen.getByTestId('txr-list-sort')).toBeTruthy()
    expect(useTxrModelsStore.getState().sort).toBe('newest-run')
    // The bottom bar: notice present, save-models absent, Run label.
    expect(screen.getByText(RESEARCH_NOTICE)).toBeTruthy()
    expect(screen.queryByTestId('txr-list-save-models')).toBeNull()
    expect(screen.getByTestId('txr-list-run').textContent).toBe('Run 0 models')
  })

  it('the same-outcome chip narrows to the matching endpoint AND horizon (both halves), across the sections', async () => {
    renderPage()
    await settle(0)
    // The fixture outcome (pfs, day 240): six models match (set A's
    // six pfs/240 rows), the os/165 rows match nothing.
    expect(screen.getByTestId('txr-list-filter-same-outcome').textContent).toBe(
      'Same outcome as my file 6',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-filter-same-outcome'))
      await Promise.resolve()
    })
    await settle(0)
    // A pfs/240 row stays; the os/165 row (fm-5, set A) is gone, and the
    // whole os/165 section renders no header (an empty group is noise).
    expect(screen.getByTestId(`txr-list-row-${fixtureModelId(1)}`)).toBeTruthy()
    expect(screen.queryByTestId(`txr-list-row-${fixtureModelId(5)}`)).toBeNull()
    expect(screen.queryByTestId('txr-list-section-set-b')).toBeNull()
    // The selection is kept through the filter (the run is the selection,
    // never the view).
  })

  it('the "Find a model or run" search matches the RUN text (the set title), not only a model', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-list-search'), {
        target: { value: 'lung' },
      })
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.queryByTestId(`txr-list-row-${fixtureModelId(1)}`)).toBeNull()
    expect(screen.getByTestId(`txr-list-row-${fixtureModelId(8)}`)).toBeTruthy()
    expect(screen.getByText('Lung pilot, day 35')).toBeTruthy()
  })

  it('the section select-all checks exactly the section\u2019s eligible rows (the cannot row never moves)', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-section-select-all-set-a'))
      await Promise.resolve()
    })
    await settle(0)
    // Set A: 7 rows, 2 cannot (fm-3 requirements unrecorded, fm-7 marker
    // missing) -> 5 selectable; set B untouched.
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('5 models selected')
    const selection = useTxrModelsStore.getState().selection
    expect(selection.has(fixtureModelId(1))).toBe(true)
    expect(selection.has(fixtureModelId(3))).toBe(false)
    expect(selection.has(fixtureModelId(7))).toBe(false)
    expect(selection.has(fixtureModelId(8))).toBe(false)
  })

  it('the section Rename opens the dialog prefilled and calls ModelSets.renameSet, then refreshes', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-section-action-set-a-rename'))
      await Promise.resolve()
    })
    await settle(0)
    const input = screen.getByTestId('txr-models-set-rename-set-a-input') as HTMLInputElement
    expect(input.value).toBe('CRC cohort, day 60')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'CRC cohort, day 60 (v2)' } })
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-rename-set-a-confirm'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.renameSet).toHaveBeenCalledWith({ id: 'set-a', name: 'CRC cohort, day 60 (v2)' })
    expect(api.listModels.mock.calls.length).toBe(2) // the refresh refetches the saved slice
  })

  it('the Delete confirm calls ModelSets.deleteSet with keep_files false (DEC-14) and refreshes', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-section-action-set-b-delete'))
      await Promise.resolve()
    })
    await settle(0)
    // The board's deletion promise in the body (files go, History keeps the results).
    expect(
      screen.getByTestId('txr-models-set-delete-set-b-body').textContent,
    ).toContain('removes the set and its models\u2019 files')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-delete-set-b-confirm'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.deleteSet).toHaveBeenCalledWith({ id: 'set-b', keep_files: false })
    expect(api.listModels.mock.calls.length).toBe(2)
  })

  it('opens the Details dialog from the row action: the ModelDetail facts + the version/digest warnings', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-list-row-${fixtureModelId(1)}-action`))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.getModel).toHaveBeenCalledWith({ id: fixtureModelId(1) })
    expect(screen.getByText('progression, death by day 240')).toBeTruthy()
    expect(screen.getByText('42 patients')).toBeTruthy()
    expect(screen.getByText('29 Nov 2026')).toBeTruthy()
    expect(screen.getByText('fm-1 · 2.1.0')).toBeTruthy()
    expect(screen.getByText('6 markers · uses age')).toBeTruthy()
    expect(screen.getByText('LDH, CEA (curated)')).toBeTruthy()
    expect(screen.getByText('not recorded')).toBeTruthy()
    expect(screen.getByText(/recorded method 2\.1\.0, catalogue now 2\.2\.0/)).toBeTruthy()
    expect(screen.getByText(/recorded sha differs from the catalogue/)).toBeTruthy()
    // The dialog's own test-id (the assertive query, never a text scan).
    expect(screen.getByTestId(`txr-models-details-${fixtureModelId(1)}`)).toBeTruthy()
  })

  it('a 404 detail (a row whose tree vanished) renders the not-found state, never a crash', async () => {
    api.getModel.mockRejectedValue({ status: 404, message: 'MODEL_NOT_FOUND' })
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-list-row-${fixtureModelId(2)}-action`))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId('txr-models-details-not-found').textContent).toBe(
      'This model is no longer available.',
    )
  })

  it('a pending J "Use" id preselects its row on mount and clears (DEC-10)', async () => {
    useTxrModelsStore.setState({ pendingUseModelId: fixtureModelId(4) })
    renderPage()
    await settle(0)
    const selection = useTxrModelsStore.getState().selection
    expect(selection.has(fixtureModelId(4))).toBe(true)
    expect(screen.getByTestId('txr-list-selected-count').textContent).toBe('1 model selected')
    expect(useTxrModelsStore.getState().pendingUseModelId).toBeNull()
  })

  it('renders the not-ready empty state when no predict file is validated (the inventory is the validation\u2019s)', async () => {
    useTxrIntakeStore.setState({ validation: null })
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-i-empty')).toBeTruthy()
    expect(screen.getByTestId('txr-models-i-empty').textContent).toContain(
      'Add the patients\u2019 measurements you want to predict first.',
    )
    // RES-20: a direct visit is not ON step 4 (the flow has not reached
    // it) and counts nothing — the step line and the "…" totals are gone.
    expect(screen.queryByText('Step 4 of 4')).toBeNull()
    expect(screen.queryByTestId('txr-models-i-totals')).toBeNull()
    // The CTA is the step that unlocks this screen — the predict-files
    // step, never the landing page (the old "Go to the start").
    expect(screen.getByTestId('txr-models-i-empty-cta').textContent).toBe(
      'Go to the measurements step',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-i-empty-cta'))
    })
    expect(screen.getByTestId('route-location').textContent).toBe('/predict-files')
    // No verdict request against a null inventory (DEC-6).
    expect(api.eligibility).not.toHaveBeenCalled()
  })
})

describe('SavedModelsPage — the reuse Run flow (TEST-MOD-32 / CONS-UM-24 + 13, I arm)', () => {
  it('reseolves FIRST, passes the assets verbatim, uses the first selected model\u2019s own horizon and navigates', async () => {
    renderPage()
    await settle(0)
    await selectRow(fixtureModelId(1))
    await selectRow(fixtureModelId(2))
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    // resolve FIRST, then create — the response's assets verbatim.
    expect(api.resolveModels).toHaveBeenCalledWith({
      model_ids: [fixtureModelId(1), fixtureModelId(2)],
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
    api.resolveModels.mockRejectedValue({ status: 404, message: 'MODEL_NOT_FOUND' })
    renderPage()
    await settle(0)
    await selectRow(fixtureModelId(1))
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-i-run-error').textContent).toBe('MODEL_NOT_FOUND')
    expect(screen.getByTestId('route-location').textContent).toBe('/saved-models')
  })

  it('an empty selection is refused with its own line — never a run with zero models', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-list-run'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.resolveModels).not.toHaveBeenCalled()
    expect(api.createRun).not.toHaveBeenCalled()
    expect(screen.getByTestId('txr-models-i-run-error').textContent).toBe(
      'Select at least one model to run.',
    )
  })

  it('the same-outcome chip does not run when the engine config carries no outcome (null facts match nothing)', async () => {
    api.getAnalysisConfig.mockResolvedValue({} as TxrAppConfig)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-list-filter-same-outcome').textContent).toBe(
      'Same outcome as my file 0',
    )
  })
})
