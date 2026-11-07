/**
 * txrmodels fixtures — the synthetic provider payloads the module's pure
 * layer, the gallery stories and the e2e/gallery specs share (ITEM-4
 * creates the lib-level set; ITEM-10's gallery grows them into full
 * stories + cassette frames).
 *
 * INV-4 (owner rule, FLOW.md: "Facts shown in boards are design examples,
 * never data"): every value here is synthetic and DISTINCT from the
 * boards' example numbers — the catalogue ids are `ps-<k>`, the saved
 * model ids stable synthetic uuids, the patient count 42 (not 38), the
 * decision day 60 (not 56), the horizon 240 (not 238), the counts and
 * sizes from a fixed synthetic spread. Board STRINGS are the copy source
 * for the FORMAT the tests pin; board numbers are never fixtures.
 *
 * The shapes are the GENERATED api-client types verbatim
 * (`PretrainedSummary`, `ModelSummary`, `SetSummary`, the two eligibility
 * responses, `InventoryEligibilityRequest`) — the provider regen drives
 * the typecheck; a reshaped field breaks this file's compile and the
 * fixtures move mechanically with it (the `txrlist` DEC-11 move). No
 * provider response is ever restated here in a softer local type.
 *
 * `TXRMODELS_INVENTORY` is the ONE inventory object the D and I flows
 * post VERBATIM (the ui-list DEC-15 one-builder pin — the eligibility
 * requests read the same object; never a second, driftable inventory).
 */
import type {
  InventoryEligibilityRequest,
  InventoryMarker,
  MethodListResponse,
  MethodSummary,
  ModelEligibilityResponse,
  ModelListResponse,
  ModelSaveResponse,
  ModelSetListResponse,
  ModelSummary,
  PretrainedEligibilityResponse,
  PretrainedSummary,
  SetSummary,
  TxrPredictionsResponse,
  TxrProducedModel,
  TxrRunDetail,
  TxrRunMethod,
} from '@/api-client/types'
import type { TxrOutcomeMatch } from './lib/filters'

/** The fixed synthetic asset hash (64 hex — a fixture value, never computed). */
const FIXTURE_SHA256 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

/** One synthetic saved-model uuid (stable, v4-shaped: `a0000000-…-<k>`). */
export function fixtureModelId(k: number): string {
  const tail = String(k).padStart(2, '0')
  return `a0000000-0000-4000-8000-0000000000${tail}`
}

/** One synthetic installed pretrained row's uuid (`b` prefix — the same
 *  shape, a distinct namespace from the saved rows). */
export function fixtureInstalledId(k: number): string {
  const tail = String(k).padStart(2, '0')
  return `b0000000-0000-4000-8000-0000000000${tail}`
}

// ─────────────────────────────────────────────────────────────────────────────
// The file inventory (the ONE builder pin)
// ─────────────────────────────────────────────────────────────────────────────

/** A synthetic marker column of the inventory (the file-validator key +
 *  display name; the fixture's marker group is the synthetic M-1). */
function fixtureMarker(key: string, name: string): InventoryMarker {
  return {
    key,
    display_name: name,
    has_detection_companion: false,
    is_detection_call: false,
    n_patients_with_baseline: 42,
    n_patients_with_ontreatment: 40,
    n_patients_with_value: 42,
    standard_ids: [{ id: key, system: 'fixture' }],
    unit_family: 'concentration_mass',
  }
}

/**
 * The analysis inventory the D and I verdicts are computed against (42
 * patients, four marker columns, decision day 60, no extra inputs). One
 * object; the D/I eligibility requests carry it verbatim.
 */
export const TXRMODELS_INVENTORY: InventoryEligibilityRequest = {
  patients: 42,
  decision_day: 60,
  baseline_max_day: 0,
  markers: [
    fixtureMarker('mk-ldh', 'LDH'),
    fixtureMarker('mk-cea', 'CEA'),
    fixtureMarker('mk-ct', 'CT value'),
    fixtureMarker('mk-proc', 'Procalcitonin'),
  ],
  covariates: [],
}

/** The analysis outcome facts the I "Same outcome" chip matches against
 *  (the fixture's own choice: pfs, day 240); the D and I stories and the
 *  filter tests read this one pair. */
export const TXRMODELS_OUTCOME: TxrOutcomeMatch = { endpoint: 'pfs', lookAheadDay: 240 }

// ─────────────────────────────────────────────────────────────────────────────
// The pretrained catalogue (screen D)
// ─────────────────────────────────────────────────────────────────────────────

/** One D-list card, synthetic (the summary row; the card detail is the
 *  per-id PROV-PC-4 payload later items fetch for the dialog). */
function fixtureCard(
  k: number,
  kind: PretrainedSummary['kind'],
  state: PretrainedSummary['state'],
  transfer: PretrainedSummary['transfer'],
): PretrainedSummary {
  const id = `ps-${k}`
  return {
    id,
    version: '1.0.0',
    kind,
    name: `${id} rule`,
    description: kind === 'published-rule' ? 'Rule from the paper; colorectal' : 'Colorectal cohort, 84 patients',
    method_id: `m${k}`,
    method_version: '2.1.0',
    group: 'g-static-risk',
    group_label: 'Static risk',
    decision_day: 60,
    endpoint: 'pfs',
    horizon: 240,
    paper: kind === 'published-rule' ? { journal: 'Ann Oncol', year: 2021, doi: `10.0000/${id}` } : undefined,
    transfer,
    warnings: [],
    research_notice: true,
    licence: ['MIT', 'Apache-2.0', 'CC BY 4.0'][k % 3],
    asset: {
      bundled: k === 7,
      file: `${id}@1.0.0.txr`,
      sha256: FIXTURE_SHA256,
      size_bytes: 4_600_000 + k * 100_000,
    },
    state,
    installed_model_id: state === 'installed' ? fixtureInstalledId(k) : undefined,
  }
}

/**
 * The seven-card catalogue (four can run, two some, one cannot — a
 * different distribution from the board's example 5/1/1). Cards ps-1..4
 * are installed, ps-5 not downloaded, ps-6 bundled, ps-7 unavailable.
 */
export const TXRMODELS_PRETRAINED: PretrainedSummary[] = [
  fixtureCard(1, 'published-rule', 'installed', { metric: 'auc_rule', median: 0.71, n_cohorts: 3 }),
  fixtureCard(2, 'benchmark-trained', 'installed', { metric: 'auc_rule', median: 0.74, n_cohorts: 1 }),
  fixtureCard(3, 'published-rule', 'installed', { metric: 'auc_rule', median: 0.69, n_cohorts: 2 }),
  fixtureCard(4, 'benchmark-trained', 'installed', { metric: 'c_index', median: 0.65, n_cohorts: 4 }),
  fixtureCard(5, 'published-rule', 'not_downloaded', undefined),
  fixtureCard(6, 'published-rule', 'bundled', { metric: 'auc_rule', median: 0.53, n_cohorts: 1 }),
  fixtureCard(7, 'benchmark-trained', 'unavailable', undefined),
]

/** The D verdicts (PROV-PC-8) for the seven cards — same ids, 4/2/1. */
export const TXRMODELS_PRETRAINED_ELIGIBILITY: PretrainedEligibilityResponse = {
  total_fit: 4,
  total_some: 2,
  total_cannot: 1,
  models: [
    {
      id: 'ps-1',
      status: 'can_run',
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'estimate',
      estimated_seconds: 45,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [],
    },
    {
      id: 'ps-2',
      status: 'can_run_some',
      coverage: { eligible: 40, total: 42, fraction: 40 / 42 },
      estimate_quality: 'estimate',
      estimated_seconds: 75,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [{ display_name: 'LDH', id: 'mk-ldh', id_system: 'fixture' }],
      reasons: [{ code: 'DECISION_DAY_UNMET' }],
    },
    {
      id: 'ps-3',
      status: 'can_run',
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'estimate',
      estimated_seconds: 90,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [{ code: 'UNIT_MISMATCH' }],
    },
    {
      id: 'ps-4',
      status: 'can_run',
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'measured',
      estimated_seconds: 120,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [],
    },
    {
      id: 'ps-5',
      status: 'can_run_some',
      coverage: { eligible: 39, total: 42, fraction: 39 / 42 },
      estimate_quality: 'estimate',
      estimated_seconds: 40,
      min_draws: { required: 3, met: 39, unmet_patients: 3 },
      missing_markers: [],
      reasons: [{ code: 'MIN_DRAWS_UNMET' }],
    },
    {
      id: 'ps-6',
      status: 'cannot_run',
      coverage: { eligible: 0, total: 42, fraction: 0 },
      estimate_quality: 'estimate',
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [{ display_name: 'Ki-67', id: 'mk-ki67', id_system: 'fixture' }],
      reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
    },
    {
      id: 'ps-7',
      status: 'cannot_run',
      coverage: { eligible: 0, total: 42, fraction: 0 },
      estimate_quality: 'estimate',
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [{ code: 'ASSET_NOT_AVAILABLE' }],
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// The saved models + sets (screen I)
// ─────────────────────────────────────────────────────────────────────────────

/** One saved-model summary (the J/I list row). */
function fixtureModel(k: number, over: Partial<ModelSummary> = {}): ModelSummary {
  return {
    id: fixtureModelId(k),
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
    uses_covariates: false,
    set_id: 'set-a',
    set_name: 'CRC cohort, day 60',
    ...over,
  }
}

/** The CRC-like set (seven models — the run "CRC cohort, day 60"). */
export const TXRMODELS_SET_A: SetSummary = {
  id: 'set-a',
  name: 'CRC cohort, day 60',
  created_at: '2026-11-29T09:05:00Z',
  source_run_id: 'run-a',
  source_label: 'patients.csv',
  model_count: 7,
  keep_training_files: false,
  total_size_bytes: 31_600_000,
}

/** The lung-like set (three models — the run "Lung pilot, day 35"). */
export const TXRMODELS_SET_B: SetSummary = {
  id: 'set-b',
  name: 'Lung pilot, day 35',
  created_at: '2026-10-09T12:00:00Z',
  source_run_id: 'run-b',
  source_label: 'lung-pilot.csv',
  model_count: 3,
  keep_training_files: false,
  total_size_bytes: 6_700_000,
}

/** The ten saved models grouped by the two sets (7 + 3). */
export const TXRMODELS_SAVED: ModelSummary[] = [
  fixtureModel(1, { own_auc: 0.71, trained_on_patients: 42 }),
  fixtureModel(2, { trained_on_patients: 42 }),
  fixtureModel(3, { own_auc: 0.52, trained_on_patients: 42, embeds_training_data: true }),
  fixtureModel(4, { own_auc: 0.74, trained_on_patients: 42 }),
  fixtureModel(5, { own_auc: 0.65, trained_on_patients: 42, endpoint: 'os', horizon: 165 }),
  fixtureModel(6, { own_auc: 0.46, trained_on_patients: 42 }),
  fixtureModel(7, { own_auc: 0.73, trained_on_patients: 42 }),
  fixtureModel(8, {
    set_id: 'set-b',
    set_name: 'Lung pilot, day 35',
    own_auc: 0.67,
    endpoint: 'os',
    decision_day: 35,
    horizon: 165,
    trained_at: '2026-10-09T10:00:00Z',
    created_at: '2026-10-09T10:00:00Z',
  }),
  fixtureModel(9, {
    set_id: 'set-b',
    set_name: 'Lung pilot, day 35',
    own_auc: 0.49,
    endpoint: 'os',
    decision_day: 35,
    horizon: 165,
    trained_at: '2026-10-09T10:00:00Z',
    created_at: '2026-10-09T10:00:00Z',
  }),
  fixtureModel(10, {
    set_id: 'set-b',
    set_name: 'Lung pilot, day 35',
    own_auc: 0.44,
    endpoint: 'os',
    decision_day: 35,
    horizon: 165,
    trained_at: '2026-10-09T10:00:00Z',
    created_at: '2026-10-09T10:00:00Z',
  }),
]

/** The saved-model verdicts (PROV-MS-9) — the ten entries: five can run,
 *  three some, two cannot (a different distribution from the board's
 *  example split; the counts are the fixtures'). */
export const TXRMODELS_SAVED_ELIGIBILITY: ModelEligibilityResponse = {
  total_fit: 5,
  total_some: 3,
  total_cannot: 2,
  models: [
    {
      id: fixtureModelId(1),
      status: 'can_run',
      endpoint: 'pfs',
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'estimate',
      estimated_seconds: 45,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [],
    },
    {
      id: fixtureModelId(2),
      status: 'can_run_some',
      endpoint: 'pfs',
      coverage: { eligible: 40, total: 42, fraction: 40 / 42 },
      estimate_quality: 'estimate',
      estimated_seconds: 90,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [{ display_name: 'LDH', id: 'mk-ldh', id_system: 'fixture' }],
      reasons: [{ code: 'DECISION_DAY_UNMET' }],
    },
    {
      id: fixtureModelId(3),
      status: 'cannot_run',
      endpoint: 'pfs',
      coverage: { eligible: 0, total: 42, fraction: 0 },
      estimate_quality: 'estimate',
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [{ code: 'MODEL_REQUIREMENTS_UNRECORDED' }],
    },
    {
      id: fixtureModelId(4),
      status: 'can_run',
      endpoint: 'pfs',
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'measured',
      estimated_seconds: 120,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [],
    },
    {
      id: fixtureModelId(5),
      status: 'can_run_some',
      endpoint: 'os',
      coverage: { eligible: 39, total: 42, fraction: 39 / 42 },
      estimate_quality: 'estimate',
      estimated_seconds: 40,
      min_draws: { required: 3, met: 39, unmet_patients: 3 },
      missing_markers: [],
      reasons: [{ code: 'MIN_DRAWS_UNMET' }],
    },
    {
      id: fixtureModelId(6),
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
      id: fixtureModelId(7),
      status: 'cannot_run',
      endpoint: 'pfs',
      coverage: { eligible: 0, total: 42, fraction: 0 },
      estimate_quality: 'estimate',
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [{ display_name: 'Ki-67', id: 'mk-ki67', id_system: 'fixture' }],
      reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
    },
    {
      id: fixtureModelId(8),
      status: 'can_run',
      endpoint: 'os',
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'estimate',
      estimated_seconds: 45,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [],
    },
    {
      id: fixtureModelId(9),
      status: 'can_run',
      endpoint: 'os',
      coverage: { eligible: 42, total: 42, fraction: 1 },
      estimate_quality: 'estimate',
      estimated_seconds: 75,
      min_draws: { required: 1, met: 42, unmet_patients: 0 },
      missing_markers: [],
      reasons: [],
    },
    {
      id: fixtureModelId(10),
      status: 'can_run_some',
      endpoint: 'os',
      coverage: { eligible: 38, total: 42, fraction: 38 / 42 },
      estimate_quality: 'estimate',
      min_draws: { required: 2, met: 38, unmet_patients: 4 },
      missing_markers: [],
      reasons: [{ code: 'MIN_DRAWS_UNMET' }],
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// The inventory-table rows (screen J)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The J inventory (PROV-MS-2 `GET /api/txr/models`): four rows covering the
 * board's three fact families — a run-trained row with the full subline
 * ("6 markers · uses age" — the grown `marker_count` + `uses_covariates`
 * fields), an imported row ("opened from colleague-panel.txr · 5 markers" +
 * the `UNRECORDED` trained-on + the "opened <date>" Made entry), and a row
 * with NO marker/covariate/import fact (the name-alone subline case). The
 * `models_dir` is the provider's one-shot path (CONS-UM-4 — "Open the
 * folder"); the values are the module's own synthetic ones (42 patients in
 * the fixture family, days 60/35, horizons 240/165), never the boards'
 * example numbers (INV-4).
 */
export const TXRMODELS_J_RESPONSE: ModelListResponse = {
  total: 4,
  models_dir: '/home/txr-fixture/models',
  models: [
    fixtureModel(11, {
      name: 'CRC cohort, day 60',
      method_id: 'landmark-cox-current',
      marker_count: 6,
      uses_covariates: true,
      own_auc: 0.71,
    }),
    fixtureModel(12, {
      name: 'Lung pilot, day 35',
      method_id: 'cox-cutpoint-risk',
      set_id: 'set-b',
      set_name: 'Lung pilot, day 35',
      endpoint: 'os',
      horizon: 165,
      decision_day: 35,
      marker_count: 4,
      uses_covariates: false,
      trained_at: '2026-10-09T10:00:00Z',
      created_at: '2026-10-09T10:00:00Z',
    }),
    fixtureModel(13, {
      name: 'From a colleague: colon panel',
      provenance: 'imported',
      imported_from: 'colleague-panel.txr',
      marker_count: 5,
      uses_covariates: false,
      trained_on_patients: undefined,
      created_at: '2026-12-04T09:00:00Z',
      trained_at: undefined,
    }),
    fixtureModel(14, {
      name: 'fm-14',
      method_id: 'relchange-threshold',
      marker_count: undefined,
      uses_covariates: false,
      trained_on_patients: undefined,
      created_at: '2026-12-04T10:00:00Z',
      trained_at: undefined,
    }),
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// The save-dialog payloads (dialogs L / L2 / L3 — ITEM-9)
// ─────────────────────────────────────────────────────────────────────────────

/** The fixture run's finished method ids (the L dialog's saveable set). */
export function fixtureRunMethodId(k: number): string {
  return `rm-${k}`
}

/** One produced model of the fixture run (`GET /api/txr/runs/{id}` —
 *  `TxrProducedModel`, PROV-EE-9; `size_bytes` is the grown GAP-B record).
 *  Sizes from the fixture spread (never the board's examples — INV-4). */
function fixtureProducedModel(k: number, over: Partial<TxrProducedModel> = {}): TxrProducedModel {
  return {
    method_id: fixtureRunMethodId(k),
    method_version: '1.0.0',
    dir: `/data/txr-fixture/runs/run-c/model/rm-${k}`,
    env: { base_digest: FIXTURE_SHA256, layer_digest: `sha256:layer-rm-${k}` },
    model_out_digest: FIXTURE_SHA256,
    tree_sha256: FIXTURE_SHA256,
    trained_on_patients: 42,
    size_bytes: 800_000,
    ...over,
  }
}

/** One run-method row (the group labels are the board's GROUP STRUCTURE
 *  vocabulary — the ids and labels are the fixture's own). */
function fixtureRunMethod(
  k: number,
  over: Partial<TxrRunMethod> = {},
): TxrRunMethod {
  return {
    method_id: fixtureRunMethodId(k),
    label: `rm-${k}`,
    version: '1.0.0',
    group: 'g-response-prob',
    group_label: 'Response probability',
    state: 'finished',
    bytes_downloaded: 0,
    bytes_total: 0,
    started_at: '2026-11-30T08:00:00Z',
    finished_at: '2026-11-30T08:02:00Z',
    duration_ms: 120_000,
    elapsed_secs: 120,
    ...over,
  }
}

/**
 * The L/L2 dialog's run (`GET /api/txr/runs/{id}`): eight methods (seven
 *  finished with a produced model, one `cannot_run` — D15's "report
 *  nothing to save" row), 42 patients, decision day 60, pfs by day 240 —
 *  the fixture facts, never the boards' example counts (INV-4). Two
 *  methods carry the training-data fact (`embeds_training_data`).
 */
export const TXRMODELS_RUN: TxrRunDetail = {
  id: 'run-c',
  status: 'finished',
  mode: 'train',
  created_at: '2026-11-30T07:55:00Z',
  started_at: '2026-11-30T07:56:00Z',
  finished_at: '2026-11-30T08:10:00Z',
  elapsed_secs: 840,
  dir: '/data/txr-fixture/runs/run-c',
  cpus: 2,
  method_ids: ['rm-1', 'rm-2', 'rm-3', 'rm-4', 'rm-5', 'rm-6', 'rm-7', 'rm-8'],
  methods: [
    fixtureRunMethod(1),
    fixtureRunMethod(2, { group: 'g-response-prob' }),
    fixtureRunMethod(3),
    fixtureRunMethod(4, {
      group: 'g-dynamic-risk',
      group_label: 'Dynamic risk',
      task: 'pfs',
    }),
    fixtureRunMethod(5, { group: 'g-dynamic-risk', group_label: 'Dynamic risk' }),
    fixtureRunMethod(6, { group: 'g-static-risk', group_label: 'Static risk' }),
    fixtureRunMethod(7, { group: 'g-static-risk', group_label: 'Static risk' }),
    fixtureRunMethod(8, {
      group: 'g-static-risk',
      group_label: 'Static risk',
      state: 'cannot_run',
      reason: { code: 'NOT_RUNNABLE', detail: 'the fixture never runs' },
    }),
  ],
  models: [
    fixtureProducedModel(1, { size_bytes: 800_000 }),
    fixtureProducedModel(2, { size_bytes: 2_400_000 }),
    fixtureProducedModel(3, { size_bytes: 900_000 }),
    fixtureProducedModel(4, { size_bytes: 12_800_000, trained_on_patients: 42 }),
    fixtureProducedModel(5, { size_bytes: 5_300_000 }),
    fixtureProducedModel(6, { size_bytes: 4_600_000 }),
    fixtureProducedModel(7, { size_bytes: 1_100_000 }),
  ],
  counts: {
    finished: 7,
    waiting: 0,
    running: 0,
    downloading: 0,
    failed: 0,
    skipped: 0,
    stopped: 0,
    cannot_run: 1,
  },
  log_lines: 0,
  predictions_ready: true,
  input_summary: {
    patients: 42,
    markers: 5,
    file_names: { patients: 'patients.csv', measurements: 'measurements.csv' },
  },
  config: {
    decision_day: 60,
    look_ahead_day: 240,
    endpoint: 'pfs',
    covariates: false,
    at_a_time: 3,
    cpus: 2,
    save_models: false,
  },
  outcome: { endpoint: 'pfs', horizon: 240, task_is_mixed: false },
  model_ids: [],
}

/** The L dialog's predictions read (`GET /api/txr/runs/{id}/predictions`) —
 *  the finished columns of the fixture run. */
export const TXRMODELS_PREDICTIONS: TxrPredictionsResponse = {
  run_id: 'run-c',
  endpoint: 'pfs',
  horizon: 240,
  generated_at: '2026-11-30T08:10:00Z',
  patients: Array.from({ length: 42 }, (_, i) => `fp-${i + 1}`),
  average: Array.from({ length: 42 }, () => null),
  methods: [
    { method_id: 'rm-1', group: 'g-response-prob', group_label: 'Response probability', coverage: { eligible: 42, scored: 42, fraction: 1 }, prob_source: 'native', task: 'pfs', probabilities: Array.from({ length: 42 }, () => null), notes: Array.from({ length: 42 }, () => null) },
    { method_id: 'rm-2', group: 'g-response-prob', group_label: 'Response probability', coverage: { eligible: 42, scored: 42, fraction: 1 }, prob_source: 'native', task: 'pfs', probabilities: Array.from({ length: 42 }, () => null), notes: Array.from({ length: 42 }, () => null) },
    { method_id: 'rm-3', group: 'g-response-prob', group_label: 'Response probability', coverage: { eligible: 42, scored: 42, fraction: 1 }, prob_source: 'native', task: 'pfs', probabilities: Array.from({ length: 42 }, () => null), notes: Array.from({ length: 42 }, () => null) },
    { method_id: 'rm-4', group: 'g-dynamic-risk', group_label: 'Dynamic risk', coverage: { eligible: 42, scored: 42, fraction: 1 }, prob_source: 'native', task: 'pfs', probabilities: Array.from({ length: 42 }, () => null), notes: Array.from({ length: 42 }, () => null) },
    { method_id: 'rm-5', group: 'g-dynamic-risk', group_label: 'Dynamic risk', coverage: { eligible: 42, scored: 42, fraction: 1 }, prob_source: 'native', task: 'pfs', probabilities: Array.from({ length: 42 }, () => null), notes: Array.from({ length: 42 }, () => null) },
    { method_id: 'rm-6', group: 'g-static-risk', group_label: 'Static risk', coverage: { eligible: 42, scored: 42, fraction: 1 }, prob_source: 'native', task: 'pfs', probabilities: Array.from({ length: 42 }, () => null), notes: Array.from({ length: 42 }, () => null) },
    { method_id: 'rm-7', group: 'g-static-risk', group_label: 'Static risk', coverage: { eligible: 42, scored: 42, fraction: 1 }, prob_source: 'native', task: 'pfs', probabilities: Array.from({ length: 42 }, () => null), notes: Array.from({ length: 42 }, () => null) },
  ],
}

/**
 * The methods catalogue slice the L dialog joins for the training-data
 * fact (`GET /api/methods` — PROV-MC-2): twelve catalogue rows, of which
 * the fixture run's eight are present (the other four are unrelated
 * methods the run never used). `rm-4` and `rm-5` carry
 * `embeds_training_data` — the warning's fact, never app-invented.
 */
export const TXRMODELS_METHODS: MethodListResponse = {
  total: 12,
  methods: [
    fixtureMethodSummary('rm-1', 'Response probability'),
    fixtureMethodSummary('rm-2', 'Response probability'),
    fixtureMethodSummary('rm-3', 'Response probability'),
    fixtureMethodSummary('rm-4', 'Dynamic risk', { embeds_training_data: true }),
    fixtureMethodSummary('rm-5', 'Dynamic risk', { embeds_training_data: true }),
    fixtureMethodSummary('rm-6', 'Static risk'),
    fixtureMethodSummary('rm-7', 'Static risk'),
    fixtureMethodSummary('rm-8', 'Static risk'),
    fixtureMethodSummary('other-1', 'Response probability'),
    fixtureMethodSummary('other-2', 'Dynamic risk'),
    fixtureMethodSummary('other-3', 'Static risk'),
    fixtureMethodSummary('other-4', 'Response probability'),
  ],
}

/** One catalogue method row (the minimal fact set the L dialog reads:
 *  id + the training-data residency; the other fields are the generated
 *  type's required surface, filled from the fixture family). */
function fixtureMethodSummary(
  id: string,
  groupLabel: string,
  over: Partial<MethodSummary> = {},
): MethodSummary {
  return {
    id,
    group_label: groupLabel,
    group: 'static-risk',
    runnable: true,
    container: true,
    frozen_model: false,
    embeds_training_data: false,
    needs_baseline: false,
    needs_detection_call: false,
    min_draws: 1,
    covariates: 'none',
    language: 'python',
    journal: 'Fixture Journal',
    year: 2024,
    paper_doi: '10.0000/fixture',
    markers: { kind: 'single', count: 1 },
    marker_groups_required: [],
    tasks: ['pfs'],
    timing: { base_seconds_per_fold: 60, benchmarked_units: 1, quality: 'estimate' },
    uses_history: 'landmark',
    spec_status: 'stable',
    ...over,
  }
}

/** The `ModelSetListResponse` the L2 "Save it in" select reads: the two
 *  fixture sets with their model counts (the I screen's sets, same
 *  objects — one fixture family). */
export const TXRMODELS_MODEL_SET_LIST: ModelSetListResponse = {
  total: 2,
  sets: [TXRMODELS_SET_A, TXRMODELS_SET_B],
}

/**
 * The save response the dialogs hand to L3 (`POST /api/txr/models/save`,
 *  PROV-MS-3): the set + the seven saved rows (the fixture model-category
 *  ids; the totals are the fixture's own, never the boards').
 */
export const TXRMODELS_SAVE_RESPONSE: ModelSaveResponse = {
  set: {
    id: 'set-save-1',
    name: 'My fixtures, day 60',
    created_at: '2026-11-30T08:11:00Z',
    source_run_id: 'run-c',
    source_label: 'patients.csv',
    model_count: 7,
    keep_training_files: false,
    total_size_bytes: 27_900_000,
  },
  models: [
    fixtureModel(21, { method_id: 'rm-1', name: 'rm-1', group_label: 'Response probability', size_bytes: 800_000, set_id: 'set-save-1', set_name: 'My fixtures, day 60' }),
    fixtureModel(22, { method_id: 'rm-2', name: 'rm-2', group_label: 'Response probability', size_bytes: 2_400_000, set_id: 'set-save-1', set_name: 'My fixtures, day 60' }),
    fixtureModel(23, { method_id: 'rm-3', name: 'rm-3', group_label: 'Response probability', size_bytes: 900_000, set_id: 'set-save-1', set_name: 'My fixtures, day 60' }),
    fixtureModel(24, { method_id: 'rm-4', name: 'rm-4', group_label: 'Dynamic risk', size_bytes: 12_800_000, embeds_training_data: true, set_id: 'set-save-1', set_name: 'My fixtures, day 60' }),
    fixtureModel(25, { method_id: 'rm-5', name: 'rm-5', group_label: 'Dynamic risk', size_bytes: 5_300_000, embeds_training_data: true, set_id: 'set-save-1', set_name: 'My fixtures, day 60' }),
    fixtureModel(26, { method_id: 'rm-6', name: 'rm-6', group_label: 'Static risk', size_bytes: 4_600_000, set_id: 'set-save-1', set_name: 'My fixtures, day 60' }),
    fixtureModel(27, { method_id: 'rm-7', name: 'rm-7', group_label: 'Static risk', size_bytes: 1_100_000, set_id: 'set-save-1', set_name: 'My fixtures, day 60' }),
  ],
}
