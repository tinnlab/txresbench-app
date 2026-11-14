/**
 * txrlist dev-gallery fixtures — the SYNTHETIC data the module's gallery
 * stories (`gallery.tsx`, PROV-UI-LIST-5) are built on.
 *
 * EVERYTHING here is synthetic: 38 fictional method ids, fictional
 * patients/cohort counts, fictional benchmark facts. The numbers that are
 * NOT arbitrary are the BOARD bytes (`/data/pbya/txresbench-app-work/
 * ui-boards/*.dc.html`): the method ids, group names, "Paper …" lines,
 * status headlines/details and row times of the first screen-E rows, the
 * seven screen-D models, and the two screen-I run groups are the boards'
 * own example rows, verbatim (FLOW.md: facts shown in the boards are design
 * examples — here they are the fixture's data). The EXPLANATORY lines the
 * boards carry under the list (the "what is missing" note on D, the
 * "other path" navigation note on I) are host chrome in the stories, not
 * module copy.
 *
 * The wire-shape fixtures are typed against the GENERATED api-client types
 * (never vendored): a provider regen that reshapes `MethodSummary` /
 * `EligibilityResponse` / `EstimateResponse` breaks this file's typecheck
 * loudly (DEC-11).
 *
 * Deliberate composition pins (the estimates the ITEM-9 gallery-e2e asserts
 * are FORCED by the fixture, not wandered into):
 *
 * - The first five ENABLED screen-E rows (direct-on, cox-timevarying-slope,
 *   baseline-ctdna-detectability, dynforest, flirti — the board's first five
 *   runnable rows, in catalogue order) carry the seconds
 *   [120, 120, 12, 840, 240]: the server's greedy LPT makespan over those
 *   five at 3 lanes is EXACTLY 840 (the [840] | [240, 12] | [120, 120]
 *   packing = the plan's EXAMPLE-UL-3 "about 14 minutes in total on this
 *   computer"). To reach it, dynforest's synthetic shot number is 840
 *   ("about 14 min" on the row — the board's own "about 5 min" number is a
 *   design example, and the plan's EXAMPLE-UL-1/EXAMPLE-UL-3 pins both
 *   live; DRIFT-1 ITEM-8).
 * - `TXRLIST_ESTIMATE_SECONDS` is the SAME table the eligibility verdicts'
 *   `estimated_seconds` are built from (DEC-6's one source): the estimate
 *   path and the row times can never disagree in a story.
 *
 * Intentionally absent: any `performance` fact on the screen-E summaries —
 * the E board's rows show no performance column (OWNER-UL-1/D36 render
 * "when the summary carries it"; the screen-D story carries it instead).
 */
import type {
  Coverage,
  EligibilityResponse,
  EstimateResponse,
  InventoryEligibilityRequest,
  MethodEligibility,
  MethodGroup,
  MethodSummary,
  MinDraws,
  ReasonCode,
  Timing,
  TimingQuality,
} from '@/api-client/types'
import type { TxrListRow, TxrListSection, TxrMethodCard } from './types'
import { buildMethodCards } from './data/methodRows'
import { formatDurationShort, formatRunHeadline } from './lib/format'

// ── the screen-E inventory (the host supplies this; the module never builds it) ──

/**
 * The story host's current-analysis inventory: the board's screen-E header
 * ("151 patients · 62 events", "5 markers · draws at day 0, 14, 28, 56",
 * decision day 56, extra inputs age/sex/stage). Synthetic; `per_patient`
 * draw lists omitted deliberately (coverage then falls back to the
 * patient-level counts — the validator's own fallback, per the wire doc).
 */
export const TXRLIST_INVENTORY: InventoryEligibilityRequest = {
  patients: 151,
  decision_day: 56,
  baseline_max_day: 0,
  covariates: [
    { key: 'age', display_name: 'Age', standard_ids: [], unit_family: 'count' },
    { key: 'sex', display_name: 'Sex', standard_ids: [], unit_family: 'none' },
    { key: 'stage', display_name: 'Stage', standard_ids: [], unit_family: 'none' },
  ],
  markers: [
    {
      key: 'cea',
      display_name: 'CEA',
      standard_ids: [{ id: '21000-5', system: 'LOINC' }],
      unit_family: 'concentration_mass',
      is_detection_call: false,
      has_detection_companion: false,
      n_patients_with_value: 151,
      n_patients_with_baseline: 151,
      n_patients_with_ontreatment: 120,
    },
    {
      key: 'ca19_9',
      display_name: 'CA19-9',
      standard_ids: [{ id: '2160-0', system: 'LOINC' }],
      unit_family: 'concentration_mass',
      is_detection_call: false,
      has_detection_companion: false,
      n_patients_with_value: 151,
      n_patients_with_baseline: 151,
      n_patients_with_ontreatment: 120,
    },
    {
      key: 'ctdna_fraction',
      display_name: 'ctDNA fraction',
      standard_ids: [{ id: '80523-0', system: 'LOINC' }],
      unit_family: 'percent',
      is_detection_call: false,
      has_detection_companion: false,
      n_patients_with_value: 151,
      n_patients_with_baseline: 151,
      n_patients_with_ontreatment: 120,
    },
    {
      key: 'albumin',
      display_name: 'Albumin',
      standard_ids: [{ id: '1751-7', system: 'LOINC' }],
      unit_family: 'concentration_mass',
      is_detection_call: false,
      has_detection_companion: false,
      n_patients_with_value: 151,
      n_patients_with_baseline: 151,
      n_patients_with_ontreatment: 120,
    },
    {
      key: 'afp',
      display_name: 'AFP',
      standard_ids: [{ id: '10333-9', system: 'LOINC' }],
      unit_family: 'concentration_mass',
      is_detection_call: false,
      has_detection_companion: false,
      n_patients_with_value: 151,
      n_patients_with_baseline: 151,
      n_patients_with_ontreatment: 120,
    },
  ],
  outcomes: {
    has_event: true,
    has_responder: true,
    has_response_day: true,
    has_survival_day: true,
  },
}

// ── the screen-E catalogue × verdicts (ONE spec table → both wire shapes) ──

/** The verdict facts a spec row needs beyond the plain status. */
interface FxVerdictFacts {
  /** The first reason's code (can rows carry none — the coverage line). */
  reason?: ReasonCode
  /** The FULL wire reason set (qa-fixes4 ITEM-7): a row a server verdict
   *  carries BOTH the env absence and a file reason on (R2-6 — the env
   *  fact first, the data fact beside it; a bare `reason` is the
   *  single-reason courtesy shape). */
  reasons?: ReasonCode[]
  coverage?: Coverage
  minDraws?: MinDraws
  missingMarkers?: Array<{ display_name: string }>
  missingGroups?: Array<{ display_name: string }>
}

/** One synthetic catalogue row: the board's copy where the board has a row. */
interface FxMethodSpec extends FxVerdictFacts {
  id: string
  year: number
  language: string
  group: MethodGroup
  groupLabel: string
  status: 'can_run' | 'can_run_some' | 'cannot_run'
  seconds: number
  /** The human-name fields (qa-fixes3 ITEM-1); defaults are synthetic. */
  title?: string
  summary?: string
  paperTitle?: string
  /** The benchmark rank the summary carries (D36: rendered only when present). */
  performance?: { c_index_median: number; auc_rule_median?: number; n_datasets: number }
}

/** The all-151 coverage of a clean run (the board's "all 151 patients"). */
const C151: Coverage = { eligible: 151, total: 151, fraction: 1 }
/** The 120-of-151 coverage of the board's partial rows. */
const C120: Coverage = { eligible: 120, total: 151, fraction: 120 / 151 }
/** The 36-of-151 coverage of the board's decision-day rows. */
const C36: Coverage = { eligible: 36, total: 151, fraction: 36 / 151 }

/** The board's MIN_DRAWS facts (3 required, 120 met of 151). */
const DRAWS_3_OF_151: MinDraws = { required: 3, met: 120, unmet_patients: 31 }

const LDH = [{ display_name: 'LDH' }]
const KI67 = [{ display_name: 'Ki-67' }]

/**
 * The 38 catalogue rows, in catalogue order (the board's first eight then
 * synthetic siblings). The statuses total 21 runnable + 5 partial + 12
 * unwritable — the board's "All 38" / "Can run 26" chips.
 */
const FX_METHODS: FxMethodSpec[] = [
  // ── the board's screen-E rows, verbatim ──
  { id: 'direct-on', year: 2021, language: 'R', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 120, title: 'Direct on-treatment response rule', summary: 'A direct on-treatment response rule fixed in the paper that introduced it; the fixture card carries no method with real data.', performance: { c_index_median: 0.74, n_datasets: 38 } },
  { id: 'cox-timevarying-slope', year: 2019, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run', seconds: 120, title: 'Time-varying Cox model' },
  { id: 'baseline-ctdna-detectability', year: 2020, language: 'Python', group: 'static-risk', groupLabel: 'Static risk', status: 'can_run', seconds: 12 },
  { id: 'dynforest', year: 2022, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run_some', seconds: 840, reason: 'MIN_DRAWS_UNMET', coverage: C120, minDraws: DRAWS_3_OF_151, title: 'Dynamic random forest', performance: { c_index_median: 0.58, n_datasets: 4 } },
  { id: 'flirti', year: 2023, language: 'Python', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 240 },
  { id: 'ctdna-clearance', year: 2018, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'can_run', seconds: 45 },
  { id: 'cox-ctdna-status-rfs', year: 2020, language: 'R', group: 'static-risk', groupLabel: 'Static risk', status: 'cannot_run', seconds: 45, reason: 'REQUIRED_MARKER_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 }, missingMarkers: LDH },
  { id: 'ki67-two-week-four-group', year: 2017, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'cannot_run', seconds: 45, reason: 'REQUIRED_MARKER_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 }, missingMarkers: KI67 },
  // ── synthetic siblings — response probability ──
  { id: 'glm-chem-probability', year: 2019, language: 'R', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 60 },
  { id: 'lasso-logistic-ctdna', year: 2022, language: 'Python', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 90 },
  { id: 'gradient-boosting-ctdna', year: 2021, language: 'Python', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 150 },
  { id: 'random-forest-response', year: 2020, language: 'R', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 180 },
  { id: 'elasticnet-response-prob', year: 2018, language: 'R', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 75 },
  { id: 'naive-bayes-ctdna', year: 2019, language: 'Python', group: 'response-probability', groupLabel: 'Response probability', status: 'can_run', seconds: 30 },
  // ── synthetic siblings — static risk ──
  { id: 'landmark-cox-current', year: 2016, language: 'R', group: 'static-risk', groupLabel: 'Static risk', status: 'can_run', seconds: 120 },
  { id: 'cox-ph-baseline-ctdna', year: 2017, language: 'R', group: 'static-risk', groupLabel: 'Static risk', status: 'can_run', seconds: 60 },
  { id: 'weibull-aft-baseline', year: 2018, language: 'R', group: 'static-risk', groupLabel: 'Static risk', status: 'can_run', seconds: 90 },
  { id: 'cph-cumulative-hazard', year: 2019, language: 'R', group: 'static-risk', groupLabel: 'Static risk', status: 'can_run', seconds: 120 },
  { id: 'psa-nadir-ttn-four-group', year: 2020, language: 'R', group: 'static-risk', groupLabel: 'Static risk', status: 'cannot_run', seconds: 45, reason: 'MIN_DRAWS_UNMET', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 3, met: 0, unmet_patients: 151 } },
  // ── synthetic siblings — dynamic risk ──
  { id: 'gru-ctdna', year: 2024, language: 'Python', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run', seconds: 1500 },
  { id: 'sherloc', year: 2024, language: 'Python', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run', seconds: 1700 },
  { id: 'rnn-ctdna', year: 2024, language: 'Python', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run', seconds: 2100 },
  { id: 'mlp-deepsurv', year: 2024, language: 'Python', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run', seconds: 1800 },
  { id: 'ctdna-kinetic-slope', year: 2021, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run', seconds: 300 },
  { id: 'coxs-slope-with-piecewise-constant-treatment-effect-and-ctdna-landmark', year: 2023, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run', seconds: 600 },
  { id: 'landmark-dynforest', year: 2023, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run_some', seconds: 1200, reason: 'COVARIATE_MISSING', coverage: C120, minDraws: DRAWS_3_OF_151 },
  { id: 'joint-ctdna-evolution', year: 2022, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'can_run_some', seconds: 2400, reason: 'DECISION_DAY_UNMET', coverage: C36, minDraws: DRAWS_3_OF_151, missingMarkers: LDH },
  { id: 'piecewise-exponential-ctdna', year: 2021, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'cannot_run', seconds: 45, reason: 'TASK_INCOMPATIBLE', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 } },
  { id: 'penalized-joint-model', year: 2017, language: 'R', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'cannot_run', seconds: 45, reason: 'COVARIATE_REQUIRED_UNMET', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 } },
  { id: 'ipcw-roc-simple', year: 2020, language: 'Python', group: 'dynamic-risk', groupLabel: 'Dynamic risk', status: 'cannot_run', seconds: 45, reason: 'COVARIATE_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 } },
  // ── synthetic siblings — response call ──
  { id: 'relchange-threshold', year: 2019, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'can_run_some', seconds: 45, reason: 'DECISION_DAY_UNMET', coverage: C120, minDraws: DRAWS_3_OF_151, missingMarkers: [{ display_name: 'CEA' }] },
  { id: 'psa-response-velocity-two-group', year: 2020, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'can_run_some', seconds: 45, reason: 'MIN_DRAWS_UNMET', coverage: C120, minDraws: DRAWS_3_OF_151 },
  { id: 'cea-ldh-ratio-call', year: 2019, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'cannot_run', seconds: 45, reason: 'REQUIRED_MARKER_MISSING', reasons: ['ENV_IMAGE_MISSING', 'REQUIRED_MARKER_MISSING'], coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 }, missingMarkers: LDH },
  { id: 'afp-lr1-response', year: 2018, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'cannot_run', seconds: 45, reason: 'REQUIRED_MARKER_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 }, missingMarkers: [{ display_name: 'AFP' }] },
  { id: 'rdw-chem', year: 2021, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'cannot_run', seconds: 45, reason: 'DETECTION_CALL_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 } },
  { id: 'ctdna-nondetect-rule', year: 2016, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'cannot_run', seconds: 45, reason: 'DETECTION_CALL_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 } },
  { id: 'methylation-five-marker-rule', year: 2018, language: 'Python', group: 'response-call', groupLabel: 'Response call', status: 'cannot_run', seconds: 45, reason: 'MARKER_GROUP_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 }, missingGroups: [{ display_name: 'Methylation markers' }] },
  { id: 'ctdna-clearance-with-lod-imputation-extension', year: 2021, language: 'R', group: 'response-call', groupLabel: 'Response call', status: 'cannot_run', seconds: 45, reason: 'REQUIRED_MARKER_MISSING', coverage: { eligible: 0, total: 151, fraction: 0 }, minDraws: { required: 0, met: 0, unmet_patients: 151 }, missingMarkers: [{ display_name: 'the circulating tumour DNA fraction measured at the pre-treatment baseline draw' }] },
]

/** The synthetic timing facts (one measured unit at the fixture seconds). */
function timing(seconds: number, quality: TimingQuality): Timing {
  return { base_seconds_per_fold: seconds, benchmarked_units: 1, quality }
}

/**
 * The catalogue wire rows: one `MethodSummary` per spec row. The human-name
 * fields (qa-fixes3 ITEM-1) default to synthetic values; `performance` is
 * present only where a spec carries it (D36: the row renders the benchmark
 * fact only then).
 */
const prettify = (id: string): string =>
  id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')

export const TXRLIST_METHODS: MethodSummary[] = FX_METHODS.map(spec => ({
  id: spec.id,
  group: spec.group,
  group_label: spec.groupLabel,
  title: spec.title ?? prettify(spec.id),
  summary: spec.summary ?? `A synthetic fixture method from the ${spec.groupLabel} family.`,
  // The generated type models Option as ABSENT (the wire may also carry
  // null — the row adapter guards both); an unknown paper leaves the
  // property out.
  paper_title: spec.paperTitle,
  year: spec.year,
  language: spec.language,
  journal: 'Fictional Journal of Fixtures',
  paper_doi: '10.0000/txr.demo',
  runnable: true,
  frozen_model: false,
  container: true,
  embeds_training_data: false,
  spec_status: 'wrapped',
  markers: { kind: 'multi', count: 3 },
  covariates: 'optional',
  min_draws: spec.reason === 'MIN_DRAWS_UNMET' ? 3 : 1,
  needs_baseline: true,
  needs_detection_call: false,
  marker_groups_required: spec.reason === 'MARKER_GROUP_MISSING' ? ['methylation'] : [],
  tasks: ['response'],
  uses_history: 'landmark',
  timing: timing(spec.seconds, spec.seconds >= 600 ? 'estimate' : 'measured'),
  performance: spec.performance
    ? {
        c_index_median: spec.performance.c_index_median,
        auc_rule_median: spec.performance.auc_rule_median,
        n_units: spec.performance.n_datasets,
        n_datasets: spec.performance.n_datasets,
      }
    : undefined,
}))

/** One per-method verdict wire row (the board's structured facts). */
function verdict(spec: FxMethodSpec): MethodEligibility {
  return {
    id: spec.id,
    status: spec.status,
    reasons: (spec.reasons ?? (spec.reason ? [spec.reason] : [])).map(code => ({
      code,
      group_id: spec.missingGroups?.length ? spec.missingGroups[0].display_name : undefined,
    })),
    missing_markers: (spec.missingMarkers ?? []).map((m, i) => ({
      id: `${spec.id}-missing-${i}`,
      id_system: 'fixture',
      display_name: m.display_name,
    })),
    missing_groups: (spec.missingGroups ?? []).map((g, i) => ({
      group_id: `fx-group-${i}`,
      display_name: g.display_name,
    })),
    coverage: spec.coverage ?? C151,
    min_draws: spec.minDraws ?? { required: 0, met: 151, unmet_patients: 0 },
    estimated_seconds: spec.seconds,
    estimate_quality: 'measured',
  }
}

/**
 * The eligibility response: one verdict per catalogue row, in catalogue
 * order (the join is catalogue-driven — count parity is a fixture fact).
 */
export const TXRLIST_ELIGIBILITY: EligibilityResponse = {
  methods: FX_METHODS.map(verdict),
  total_fit: FX_METHODS.filter(m => m.status === 'can_run').length,
  total_some: FX_METHODS.filter(m => m.status === 'can_run_some').length,
  total_cannot: FX_METHODS.filter(m => m.status === 'cannot_run').length,
  total_no_env: 0,
}

/**
 * The estimate endpoint's seconds table: the SAME numbers the verdicts
 * carry (DEC-6's one source), keyed by method id.
 */
export const TXRLIST_ESTIMATE_SECONDS: Record<string, number> = Object.fromEntries(
  FX_METHODS.map(m => [m.id, m.seconds]),
)

/**
 * The greedy LPT makespan over a seconds table — the server's own DEC-7
 * rule (`method_catalogue/estimate.rs`: jobs sorted descending, each placed
 * on the least-loaded lane, schedule = the maximum lane load; 1 lane is the
 * plain sum). The story hosts need a total line without a backend; this is
 * the same computation the real endpoint performs, so a story's "about N
 * minutes in total" is an honest reading of the fixture.
 */
export function estimateScheduleSeconds(
  entries: Array<{ id: string; seconds: number }>,
  ids: string[],
  lanes: number,
): number {
  const seconds = [...new Set(ids)]
    .map(id => entries.find(e => e.id === id)?.seconds)
    .filter((s): s is number => s !== undefined)
  if (seconds.length === 0) return 0
  const loads = Array.from({ length: Math.max(1, lanes) }, () => 0)
  for (const s of [...seconds].sort((a, b) => b - a)) {
    let least = 0
    for (let i = 1; i < loads.length; i += 1) {
      if (loads[i] < loads[least]) least = i
    }
    loads[least] += s
  }
  return Math.max(...loads)
}

/**
 * What a `MethodCatalogue.estimate` request answers: per-method seconds
 * (in the REQUEST order — the server mirrors it), the plain sum, and the
 * LPT schedule over the requested `at_a_time` lanes.
 */
export function txrlistEstimate(body: { method_ids?: string[]; at_a_time?: number }): EstimateResponse {
  const ids = body.method_ids ?? []
  const atATime = body.at_a_time ?? 3
  return {
    at_a_time: atATime,
    // The mirror of the request (absent cpus resolves the run's own count;
    // the fixture returns the posted value by convention).
    cpus: 4,
    methods: ids.map(id => ({
      id,
      estimated_seconds: TXRLIST_ESTIMATE_SECONDS[id] ?? 0,
      estimate_quality: 'estimate',
    })),
    total_seconds: ids.reduce((sum, id) => sum + (TXRLIST_ESTIMATE_SECONDS[id] ?? 0), 0),
    schedule_seconds: estimateScheduleSeconds(
      Object.entries(TXRLIST_ESTIMATE_SECONDS).map(([id, seconds]) => ({ id, seconds })),
      ids,
      atATime,
    ),
  }
}

// ── the screen-D rows (host-built model rows; the module only renders) ──

/** A screen-D row's host-side facts: the chips' and sort's material. */
export interface TxrListModelFacts {
  /** "Published" rules vs "Learned by the benchmark" (the D chip split). */
  kind: 'published' | 'learned'
  /** The "Checked on 2 or more other cohorts" count (the summary's n_datasets). */
  otherCohorts: number
  /** The row's own "how many patients this model runs on" material. */
  covered: number
  /** The row's own seconds (the total line's material). */
  seconds: number
}

/** One screen-D record: the board's row + the host facts behind it. */
export interface TxrListDModel {
  row: TxrListRow
  facts: TxrListModelFacts
}

/**
 * The board's seven screen-D models, verbatim (Pretrained.dc.html). The
 * rows are the BOARD's copy; the host facts are the fixture's own.
 */
export const TXRLIST_D_MODELS: TxrListDModel[] = [
  {
    facts: { kind: 'published', otherCohorts: 3, covered: 38, seconds: 45 },
    row: {
      key: 'ctdna-clearance',
      name: 'ctdna-clearance',
      tag: 'Rule from the paper; colorectal, immunotherapy',
      chip: { label: 'Published', tone: 'accent' },
      performanceText: 'other cohorts: AUC 0.64',
      run: { status: 'can', headline: 'Can run', detail: 'all 38 patients', disabled: false },
      timeText: 'under 1 min',
      action: { label: 'Model card' },
    },
  },
  {
    facts: { kind: 'learned', otherCohorts: 2, covered: 36, seconds: 60 },
    row: {
      key: 'cox-cutpoint-risk',
      name: 'cox-cutpoint-risk · day 56',
      tag: 'Colorectal cohort, 151 patients',
      chip: { label: 'Learned here', tone: 'accent' },
      performanceText: 'other cohorts: AUC 0.61',
      run: {
        status: 'some',
        headline: 'Can run for some patients',
        detail: '36 of 38 patients (2 lack LDH at day 56)',
        disabled: false,
      },
      timeText: 'about 1 min',
      action: { label: 'Model card' },
    },
  },
  {
    facts: { kind: 'learned', otherCohorts: 2, covered: 38, seconds: 60 },
    row: {
      key: 'landmark-cox-current',
      name: 'landmark-cox-current · day 56',
      tag: 'Colorectal cohort, 151 patients',
      chip: { label: 'Learned here', tone: 'accent' },
      performanceText: 'other cohorts: AUC 0.58',
      run: {
        status: 'can',
        headline: 'Can run',
        detail: 'all 38 patients, check the scales',
        disabled: false,
      },
      timeText: 'about 1 min',
      action: { label: 'Model card' },
    },
  },
  {
    facts: { kind: 'published', otherCohorts: 2, covered: 38, seconds: 45 },
    row: {
      key: 'baseline-ctdna-detectability',
      name: 'baseline-ctdna-detectability',
      tag: 'Rule from the paper; several cancers',
      chip: { label: 'Published', tone: 'accent' },
      performanceText: 'other cohorts: AUC 0.60',
      run: { status: 'can', headline: 'Can run', detail: 'all 38 patients', disabled: false },
      timeText: 'under 1 min',
      action: { label: 'Model card' },
    },
  },
  {
    facts: { kind: 'published', otherCohorts: 0, covered: 30, seconds: 45 },
    row: {
      key: 'relchange-threshold',
      name: 'relchange-threshold',
      tag: 'Rule from the paper; colorectal',
      chip: { label: 'Published', tone: 'accent' },
      performanceText: 'not yet checked elsewhere',
      run: {
        status: 'some',
        headline: 'Can run for some patients',
        detail: 'CEA only before treatment',
        disabled: false,
      },
      timeText: 'under 1 min',
      action: { label: 'Model card' },
    },
  },
  {
    facts: { kind: 'published', otherCohorts: 2, covered: 0, seconds: 45 },
    row: {
      key: 'ki67-two-week-four-group',
      name: 'ki67-two-week-four-group',
      tag: 'Rule from the paper; breast',
      chip: { label: 'Published', tone: 'accent' },
      performanceText: 'other cohorts: AUC 0.66',
      run: {
        status: 'cannot',
        headline: 'Cannot run',
        detail: 'needs Ki-67, not in your file',
        disabled: true,
      },
      timeText: 'under 1 min',
      action: { label: 'Model card' },
    },
  },
  {
    facts: { kind: 'published', otherCohorts: 0, covered: 0, seconds: 45 },
    row: {
      key: 'methylation-five-marker-rule',
      name: 'methylation-five-marker-rule',
      tag: 'Rule from the paper; colorectal',
      chip: { label: 'Published', tone: 'accent' },
      performanceText: 'not yet checked elsewhere',
      run: {
        status: 'cannot',
        headline: 'Cannot run',
        detail: 'needs 5 methylation markers',
        disabled: true,
      },
      timeText: 'under 1 min',
      action: { label: 'Model card' },
    },
  },
]

/** The D board's explanatory note (host chrome, not module copy). */
export const TXRLIST_D_NOTE =
  'Models that cannot run say what is missing from your file. Add the missing markers and they become available.'

// ── the screen-I rows (host-built; the module renders the run groups) ──

/** One screen-I record: the run group + the row + its host facts. */
export interface TxrListIModel {
  sectionKey: string
  row: TxrListRow
  facts: TxrListModelFacts
}

/**
 * The board's two screen-I run groups, verbatim (Saved.dc.html): 11 CRC
 * models (2 cannot — the section's select-all is 9 of 11, EXAMPLE-UL-4)
 * + 2 Lung models (1 cannot).
 */
export const TXRLIST_I_SECTIONS: TxrListSection[] = [
  {
    key: 'crc-cohort-day-56',
    title: 'CRC cohort, day 56',
    subtitle:
      'trained 19 Oct on patients.csv · 151 patients · 11 models · progression or death by day 238',
    rowKeys: [
      'cox-cutpoint-risk',
      'landmark-cox-current',
      'dynforest',
      'flirti',
      'cox-ctdna-status-rfs',
      'ctdna-clearance',
      'relchange-threshold',
      'baseline-ctdna-detectability',
      'landmark-dynforest',
      'gru-ctdna',
      'psa-nadir-ttn-four-group',
    ],
    actions: [
      { id: 'rename', label: 'Rename', tone: 'default' },
      { id: 'delete', label: "Delete the run's models", tone: 'danger' },
    ],
  },
  {
    key: 'lung-pilot-day-42',
    title: 'Lung pilot, day 42',
    subtitle:
      'trained 3 Oct on lung_pilot.csv · 64 patients · 2 models · progression by day 224',
    rowKeys: ['cox-cutpoint-risk · day 42', 'baseline-cox-cumulative-hazard'],
    actions: [
      { id: 'rename', label: 'Rename', tone: 'default' },
      { id: 'delete', label: "Delete the run's models", tone: 'danger' },
    ],
  },
]

/** One screen-I row helper (the "Trained by you" chip + facts). */
function savedModel(
  sectionKey: string,
  id: string,
  tag: string,
  performance: string,
  status: TxrListRow['run']['status'],
  detail: string,
  timeText: string,
  facts: TxrListModelFacts,
): TxrListIModel {
  const headline = status === 'can' ? 'Can run' : status === 'some' ? 'Can run for some patients' : 'Cannot run'
  return {
    sectionKey,
    facts,
    row: {
      key: id,
      name: id,
      tag,
      chip: { label: 'Trained by you', tone: 'accent' },
      performanceText: performance,
      run: { status, headline, detail, disabled: status === 'cannot' },
      timeText,
      action: { label: 'Details' },
    },
  }
}

/** The board's 13 saved models (11 CRC + 2 Lung), verbatim. */
export const TXRLIST_I_MODELS: TxrListIModel[] = [
  savedModel('crc-cohort-day-56', 'cox-cutpoint-risk', 'decision day 56', 'own data, cross-checked: AUC 0.66', 'some', '36 of 38 patients (2 lack LDH at day 56)', 'about 1 min', { kind: 'learned', otherCohorts: 0, covered: 36, seconds: 60 }),
  savedModel('crc-cohort-day-56', 'landmark-cox-current', 'decision day 56', 'own data, cross-checked: AUC 0.63', 'can', 'all 38 patients', 'about 1 min', { kind: 'learned', otherCohorts: 0, covered: 38, seconds: 60 }),
  savedModel('crc-cohort-day-56', 'dynforest', 'decision day 56', 'own data, cross-checked: AUC 0.68', 'can', 'all 38 patients', 'about 2 min', { kind: 'learned', otherCohorts: 0, covered: 38, seconds: 120 }),
  savedModel('crc-cohort-day-56', 'flirti', 'decision day 56', 'own data, cross-checked: AUC 0.60', 'some', 'needs 3 or more draws; 30 of 38 have them', 'about 1 min', { kind: 'learned', otherCohorts: 0, covered: 30, seconds: 60 }),
  savedModel('crc-cohort-day-56', 'cox-ctdna-status-rfs', 'decision day 56', 'own data, cross-checked: AUC 0.62', 'cannot', 'needs LDH, not in this file', 'under 1 min', { kind: 'learned', otherCohorts: 0, covered: 0, seconds: 45 }),
  savedModel('crc-cohort-day-56', 'ctdna-clearance', 'decision day 56', 'own data, cross-checked: AUC 0.59', 'can', 'all 38 patients', 'under 1 min', { kind: 'learned', otherCohorts: 0, covered: 38, seconds: 45 }),
  savedModel('crc-cohort-day-56', 'relchange-threshold', 'decision day 56', 'own data, cross-checked: AUC 0.57', 'can', 'all 38 patients', 'under 1 min', { kind: 'learned', otherCohorts: 0, covered: 38, seconds: 45 }),
  savedModel('crc-cohort-day-56', 'baseline-ctdna-detectability', 'decision day 56', 'own data, cross-checked: AUC 0.61', 'can', 'all 38 patients', '12 s', { kind: 'learned', otherCohorts: 0, covered: 38, seconds: 12 }),
  savedModel('crc-cohort-day-56', 'landmark-dynforest', 'decision day 56', 'own data, cross-checked: AUC 0.64', 'can', 'all 38 patients', 'about 20 min', { kind: 'learned', otherCohorts: 0, covered: 38, seconds: 1200 }),
  savedModel('crc-cohort-day-56', 'gru-ctdna', 'decision day 56', 'own data, cross-checked: AUC 0.71', 'some', 'needs 3 or more draws; 30 of 38 have them', 'about 25 min', { kind: 'learned', otherCohorts: 0, covered: 30, seconds: 1500 }),
  savedModel('crc-cohort-day-56', 'psa-nadir-ttn-four-group', 'decision day 56', 'own data, cross-checked: AUC 0.55', 'cannot', 'needs 3 or more draws; 0 of 38 have them', 'under 1 min', { kind: 'learned', otherCohorts: 0, covered: 0, seconds: 45 }),
  savedModel('lung-pilot-day-42', 'cox-cutpoint-risk · day 42', 'decision day 42', 'own data, cross-checked: AUC 0.59', 'cannot', 'draws are at day 56, not day 42', 'under 1 min', { kind: 'learned', otherCohorts: 0, covered: 0, seconds: 45 }),
  savedModel('lung-pilot-day-42', 'baseline-cox-cumulative-hazard', 'before treatment only', 'own data, cross-checked: AUC 0.57', 'can', 'all 38 patients', 'under 1 min', { kind: 'learned', otherCohorts: 0, covered: 38, seconds: 45 }),
]

/** The I board's explanatory note (host chrome, not module copy). */
export const TXRLIST_I_NOTE =
  'A model that cannot run says what is missing from your file. The same list shows pretrained models in the other path; only the models differ.'

// ── the narrow-width rows (the long-name / long-detail overflow cases) ──

/**
 * The narrow-390 story's rows: E-style rows, built by the module's OWN
 * adapter over the fixture wire shapes (no hand-copied row copy here),
 * including the two overflow cases the fixture catalogue carries — a long
 * method id and a `cannot` row whose missing-marker line is long — so the
 * wrap path (EXAMPLE-UL-6) is exercised at 390 px. The story renders the
 * SHARED `TxrSelectList` (the D/I boards still use it; the E screen is the
 * picker's), so the cards are adapted back to the board row shape.
 */
export function txrlistNarrowRows(): TxrListRow[] {
  function rowOf(card: TxrMethodCard): TxrListRow {
    return {
      key: card.key,
      name: card.id,
      tag: `Paper ${card.year}, ${card.language}`,
      chip: { label: card.groupLabel, tone: 'neutral' },
      performanceText:
        card.rank === null ? null : `other cohorts: AUC ${card.rank.median.toFixed(2)}`,
      run: {
        status: card.run.status,
        headline: formatRunHeadline(card.run.status),
        detail: card.run.reasonLine,
        disabled: card.run.disabled,
      },
      timeText:
        card.run.disabled || card.estimate === null
          ? null
          : formatDurationShort(card.estimate.seconds),
      action: { label: 'About' },
    }
  }
  const cards = buildMethodCards(TXRLIST_METHODS, TXRLIST_ELIGIBILITY)
  const wanted = [
    'direct-on',
    'cox-timevarying-slope',
    'baseline-ctdna-detectability',
    'dynforest',
    'coxs-slope-with-piecewise-constant-treatment-effect-and-ctdna-landmark',
    'ctdna-clearance-with-lod-imputation-extension',
  ]
  return wanted.map(id => {
    const card = cards.find(c => c.id === id)
    if (card === undefined) throw new Error(`fixture row missing: ${id}`)
    return rowOf(card)
  })
}
