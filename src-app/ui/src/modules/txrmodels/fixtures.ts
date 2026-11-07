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
  ModelEligibilityResponse,
  ModelListResponse,
  ModelSummary,
  PretrainedEligibilityResponse,
  PretrainedSummary,
  SetSummary,
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
