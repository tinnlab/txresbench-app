/**
 * txrrun dev-gallery fixtures (PROV-UI-RUN-6, ITEM-12) — the SYNTHETIC data
 * the module's gallery stories (`gallery.tsx`) run on.
 *
 * Everything here is synthetic: the run ids are the story slugs themselves
 * (`run-f`, `run-f-finished`, … — never a real run id), the method ids are
 * catalogue-slug spellings already on the boards, the patients count and
 * the durations are the fixture's own numbers (INV-6: the boards' example
 * facts are never code). The wire-shape fixtures are typed against the
 * GENERATED api-client types (never vendored): a provider regen that
 * reshapes `TxrRunDetail` / `TxrRunEvent` breaks this file's typecheck
 * loudly.
 *
 * The E story's intake state is seeded through the SAME builders the intake
 * provider's own gallery story uses (`txrintake`'s fixture bundle +
 * `txrInspectResponse` / `txrValidateResponse` / `resolveJoins` — the ONE
 * validate/inspect builders, DEC-13's one-inventory rule); this file owns
 * only the orchestration of the adopt → inspect → validate round the E
 * screen's story needs. No patient data, no restricted/ content, no
 * real-world path.
 *
 * The F stories' frame scripts type their payloads against the generated
 * `TxrRunEvent` members (the store-test's frame-script discipline): a
 * provider regen that reshapes a frame breaks this file's typecheck loudly.
 */
import type {
  EligibilityResponse,
  Method,
  MethodListResponse,
  MethodSummary,
  RunConfig,
  TxrAppConfig,
  TxrLogStream,
  TxrRunCounts,
  TxrRunDetail,
  TxrRunLogLine,
  TxrRunLogsResponse,
  TxrRunMethod,
  TxrRunStatus,
  TxrRunSummary,
} from '@/api-client/types'
import { parseCsvText } from '@/lib/txr-files/csv'
import { TxrIntake, type LoadedFile } from '@/modules/txrintake'
import {
  TXR_INTAKE_FIXTURE_BUNDLE,
  txrInspectResponse,
  txrValidateResponse,
} from '@/modules/txrintake/fixtures'
import { resolveJoins } from '@/modules/txrintake/lib/flow'

// ── the story-wire shapes (frames + the recorded-request seam) ──────────────

/** One fixture frame (the gallery mock's `SseFrame` shape, spelled locally so
 *  the module's data file needs no runtime gallery import). */
export interface TxrRunFixtureFrame {
  event: string
  data: unknown
}

/** One recorded run-control request (the story host's observer seam). */
export interface TxrRunRequestRecord {
  op: 'Txr.skipMethod' | 'Txr.stopMethod' | 'Txr.stopRun' | 'Txr.setAtATime'
  params: Record<string, string>
  body: unknown
}

/** The recorded run-control requests of the session (the story seam's data). */
export const TXRRUN_REQUEST_LOG: TxrRunRequestRecord[] = []

/** The seam's subscribers (the request-log line re-paints on a record). */
const REQUEST_LOG_LISTENERS = new Set<() => void>()

/** Subscribe to the request log (the story seam's re-paint hook). */
export function txrrunOnRequest(callback: () => void): () => void {
  REQUEST_LOG_LISTENERS.add(callback)
  return () => {
    REQUEST_LOG_LISTENERS.delete(callback)
  }
}

/** Append one recorded control request (the cassette responders' one write). */
export function txrrunRecordRequest(record: TxrRunRequestRecord): void {
  TXRRUN_REQUEST_LOG.push(record)
  for (const listener of REQUEST_LOG_LISTENERS) listener()
}

/** The last recorded request (the seam's displayed line). */
export function txrrunLastRequest(): TxrRunRequestRecord | null {
  return TXRRUN_REQUEST_LOG.length > 0
    ? TXRRUN_REQUEST_LOG[TXRRUN_REQUEST_LOG.length - 1]
    : null
}

/** The whole recorded log as JSON (the seam's bytes). */
export function txrrunRequestLogLine(): string {
  return JSON.stringify(TXRRUN_REQUEST_LOG)
}

// ── the E story's intake seed (the validated file pair, one source) ─────────

/** The adopted-file shell from a parsed table (the intake story birth shape). */
function loadedFrom(table: ReturnType<typeof parseCsvText>): LoadedFile {
  return {
    source: table.source,
    table,
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],

    columnOffers: [],
  }
}

/**
 * Seed the `TxrIntake` store with the fixture file pair, validated — the E
 * screen's story state: the two train-mode files adopted, inspected,
 * prepared, the ONE validation applied (the store's `validation.inventory`
 * is the E list's eligibility object; the summary lines are the slot
 * facts). The builders are the intake provider's own (the fixture bundle,
 * the inspect/validate responders, the join resolution) — the orchestration
 * below is the same round the provider's screen-C gallery story performs.
 */
export function txrrunSeedValidatedIntake(): void {
  TxrIntake.reset()
  const patientsTable = parseCsvText(
    TXR_INTAKE_FIXTURE_BUNDLE.patients,
    { kind: 'patients' },
    'fixture-patients.csv',
  )
  const measurementsTable = parseCsvText(
    TXR_INTAKE_FIXTURE_BUNDLE.measurementsFixed,
    { kind: 'measurements' },
    'fixture-measurements.csv',
  )
  TxrIntake.adoptFile('patients', loadedFrom(patientsTable))
  TxrIntake.adoptFile('measurements', loadedFrom(measurementsTable))
  const patientsInspection = txrInspectResponse({ kind: 'patients', table: patientsTable })
  const measurementsInspection = txrInspectResponse({
    kind: 'measurements',
    table: measurementsTable,
  })
  TxrIntake.patchFile('patients', {
    inspection: patientsInspection,
    problems: patientsInspection.problems,
    prepared: true,
  })
  TxrIntake.patchFile('measurements', {
    inspection: measurementsInspection,
    problems: measurementsInspection.problems,
    prepared: true,
  })
  const response = txrValidateResponse({
    mode: 'files',
    measurements: measurementsTable,
    patients: patientsTable,
  })
  TxrIntake.patchFile('measurements', {
    joinOffers: resolveJoins(response.markers, []),
  })
  TxrIntake.applyValidation(response, TxrIntake.currentValidationKey())
}

/** The E screen's sticky-config answer (the honest never-configured value:
 *  no `config` — the engine's defaults carry the screen's first render). */
export const TXRRUN_APP_CONFIG: TxrAppConfig = {}

/** The history-store keep-copies preference (PROV-HS-4, the E default true). */
export const TXRRUN_KEEP_COPIES = { keep_file_copies: true }

/** The catalogue detail the E About story opens (one fixture method card;
 *  the numbers are the fixture's own — never a board performance fact). */
export function txrrunMethodDetail(): Method {
  return {
    id: 'direct-on',
    group: 'response-probability',
    group_label: 'Response probability',
    year: 2021,
    language: 'R',
    journal: 'Fictional Journal of Fixtures',
    paper_doi: '10.0000/txr.demo',
    version: '0.1.0',
    description:
      'A direct on-treatment response rule fixed in the paper that introduced it; the fixture card carries no method with real data.',
    citations: 0,
    container: true,
    covariates: 'optional',
    embeds_training_data: false,
    env: { contract: '2.0', digest: 'fx'.padEnd(64, 'a'), image: 'ghcr.io/tinnlab/txresbench-fx:0.1.0' },
    fitted: true,
    frozen_model: false,
    gate: { pass: true, report_name: 'fixture-report.json' },
    licence: 'MIT',
    marker_groups_required: [],
    markers: { kind: 'multi', count: 3 },
    min_draws: 1,
    needs_baseline: true,
    needs_detection_call: false,
    own_outputs: ['call'],
    params: { threshold: 0.5 },
    references: ['Fictional Journal of Fixtures 2021; 12:34-56'],
    runnable: true,
    saves_model: false,
    software: { language: 'R', packages: { fixturepkg: '0.1.0' } },
    spec_status: 'wrapped',
    tasks: ['response'],
    timing: {
      base_seconds_per_fold: 120,
      benchmarked_units: 1,
      quality: 'measured',
    },
    uses_history: 'landmark',
  } as unknown as Method
}

// ── the small-method E story (qa-fixes3 ITEM-1: six runnable methods) ──────

/** The 6-method catalogue list the `txr-run-e-small` story overrides
 *  (ITEM-1's measured test needs a small runnable set: all six run, so the
 *  page stays under 1,500 px at 1440 and every row is visible). */
export function txrrunSmallMethods(): MethodListResponse['methods'] {
  const make = (
    id: string,
    group: MethodSummary['group'],
    groupLabel: string,
    seconds: number,
  ): MethodSummary => ({
    id,
    group,
    group_label: groupLabel,
    title: 'Fixture ' + id.split('-').join(' '),
    summary: 'A small synthetic fixture method for ' + groupLabel + '.',
    year: 2021,
    language: 'R',
    journal: 'Fictional Journal of Fixtures',
    paper_doi: '10.0000/fx.small',
    runnable: true,
    frozen_model: false,
    container: true,
    embeds_training_data: false,
    spec_status: 'wrapped',
    markers: { kind: 'multi', count: 3 },
    covariates: 'optional',
    min_draws: 1,
    needs_baseline: true,
    needs_detection_call: false,
    marker_groups_required: [],
    tasks: ['response'],
    uses_history: 'landmark',
    timing: { base_seconds_per_fold: seconds, benchmarked_units: 1, quality: 'measured' },
    performance: undefined,
  })
  return [
    make('fx-call-one', 'response-call', 'Response call', 45),
    make('fx-prob-one', 'response-probability', 'Response probability', 90),
    make('fx-prob-two', 'response-probability', 'Response probability', 30),
    make('fx-static-one', 'static-risk', 'Static risk', 60),
    make('fx-static-two', 'static-risk', 'Static risk', 20),
    make('fx-dynamic-one', 'dynamic-risk', 'Dynamic risk', 120),
  ]
}

/** The small eligibility answer: every method can run (six verdicts). */
export function txrrunSmallEligibility(): EligibilityResponse {
  const seconds: Record<string, number> = {
    'fx-call-one': 45,
    'fx-prob-one': 90,
    'fx-prob-two': 30,
    'fx-static-one': 60,
    'fx-static-two': 20,
    'fx-dynamic-one': 120,
  }
  return {
    methods: Object.entries(seconds).map(([id, estimated_seconds]) => ({
      id,
      status: 'can_run',
      estimated_seconds: estimated_seconds,
      estimate_quality: 'measured',
      coverage: { eligible: 18, total: 18, fraction: 1 },
      min_draws: { required: 0, met: 18, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      reasons: [],
    })),
    total_fit: 6,
    total_some: 0,
    total_cannot: 0,
    total_no_env: 0,
  }
}

/**
 * The ITEM-2 re-check story's eligibility: the decision-day-aware responder —
 * the small set is fully runnable at the fixture's decision day (56), and
 * the probability method becomes cannot-run when the screen asks for a
 * decision day of 28 (the cassette equivalent of "the eligibility changed
 * because the settings changed" — the ITEM-2 browser test drives the
 * untick toast through it).
 */
export function txrrunRecheckEligibility(ctx: { body?: unknown }): EligibilityResponse {
  const body = (ctx.body ?? {}) as { inventory?: { decision_day?: number } }
  const decisionDay = body.inventory?.decision_day ?? 56
  const base = txrrunSmallEligibility()
  if (decisionDay === 56) return base
  return {
    ...base,
    total_fit: 5,
    total_cannot: 1,
    methods: base.methods.map(method =>
      method.id === 'fx-prob-one'
        ? {
            ...method,
            status: 'cannot_run',
            coverage: { eligible: 0, total: 18, fraction: 0 },
            min_draws: { required: 2, met: 0, unmet_patients: 18 },
            reasons: [{ code: 'DECISION_DAY_UNMET' }],
          }
        : method,
    ),
  }
}

// ── the F run fixtures (one synthetic run per story) ───────────────────────

/** The fixture run's sticky facts — none of them a board example value. */
export const TXRRUN_PATIENTS = 38
/** The fixture run's decision day. */
export const TXRRUN_DECISION_DAY = 56
/** The fixture run's horizon. */
export const TXRRUN_HORIZON = 238
/** The fixture run's packed schedule (the header's time-left source). */
export const TXRRUN_SCHEDULE_SECONDS = 840

/** The F run's config (the run's own sticky facts at creation). */
export const TXRRUN_FX_CONFIG: RunConfig = {
  endpoint: 'pfs',
  decision_day: TXRRUN_DECISION_DAY,
  look_ahead_day: TXRRUN_HORIZON,
  at_a_time: 3,
  cpus: 4,
  save_models: false,
}

/** The zeroed counts map (the derived source is the method rows). */
function zeroCounts(): TxrRunCounts {
  return { waiting: 0, downloading: 0, running: 0, finished: 0, failed: 0, stopped: 0, skipped: 0, cannot_run: 0 }
}

/** The counts derived from the rows (the same rule the store computes). */
function countsOf(methods: TxrRunMethod[]): TxrRunCounts {
  const counts = zeroCounts()
  for (const method of methods) counts[method.state] += 1
  return counts
}

/** One method row of a fixture run (the wire rows the stories render). */
export function txrrunMethodRow(
  methodId: string,
  state: TxrRunMethod['state'],
  over: Partial<TxrRunMethod> = {},
): TxrRunMethod {
  return {
    method_id: methodId,
    label: methodId,
    group: 'response-probability',
    group_label: 'Response probability',
    version: '0.1.0',
    state,
    bytes_downloaded: state === 'downloading' ? 160 : 0,
    bytes_total: state === 'downloading' ? 250 : undefined,
    elapsed_secs: state === 'waiting' ? 0 : state === 'finished' ? 52 : 20,
    phase: state === 'waiting' ? 'idle' : state === 'downloading' ? 'env' : state === 'running' ? 'fit' : state === 'finished' ? 'done' : 'idle',
    prob_source: state === 'finished' ? 'native' : undefined,
    task: 'pfs',
    ...over,
  }
}

/** One fixture run detail (the story's getRun payload). */
function runDetail(
  over: Partial<TxrRunDetail> & { id: string; status: TxrRunStatus; methods: TxrRunMethod[] },
): TxrRunDetail {
  const { id, status, methods, dir, ...rest } = over
  return {
    id,
    dir: dir ?? 'Documents/TxResBench/analysis-fx-2000',
    status,
    methods,
    models: [],
    config: { ...TXRRUN_FX_CONFIG, ...rest.config },
    counts: rest.counts ?? countsOf(methods),
    cpus: rest.cpus ?? 4,
    created_at: '2026-09-03T08:49:00Z',
    elapsed_secs: rest.elapsed_secs,
    estimate: rest.estimate,
    input_summary: {
      markers: 3,
      patients: TXRRUN_PATIENTS,
      file_names: { measurements: 'measurements.csv', patients: 'patients.csv' },
    },
    log_lines: rest.log_lines ?? 0,
    method_ids: methods.map(method => method.method_id),
    mode: 'train',
    model_ids: [],
    outcome: { endpoint: 'pfs', horizon: TXRRUN_HORIZON, task_is_mixed: false },
    predictions_ready: rest.predictions_ready ?? false,
    started_at: '2026-09-03T08:50:00Z',
    finished_at: status === 'finished' ? (rest.finished_at ?? '2026-09-03T08:58:00Z') : undefined,
    ...rest,
  }
}

/** The live story's run: one row per working state + the failure pair. */
export const TXRRUN_RUN_F: TxrRunDetail = runDetail({
  id: 'run-f',
  dir: 'Documents/TxResBench/analysis-fx-2001',
  status: 'running',
  elapsed_secs: 60,
  estimate: {
    schedule_seconds: TXRRUN_SCHEDULE_SECONDS,
    total_seconds: TXRRUN_SCHEDULE_SECONDS,
    estimate_quality: 'measured',
  },
  log_lines: 5,
  methods: [
    txrrunMethodRow('direct-on', 'waiting'),
    txrrunMethodRow('cox-timevarying-slope', 'downloading', { group: 'dynamic-risk', group_label: 'Dynamic risk' }),
    txrrunMethodRow('dynforest', 'running', { group: 'dynamic-risk', group_label: 'Dynamic risk', phase: 'predict', elapsed_secs: 41 }),
    txrrunMethodRow('flirti', 'waiting'),
    txrrunMethodRow('baseline-ctdna-detectability', 'failed', {
      group: 'static-risk',
      group_label: 'Static risk',
      phase: 'fit',
      elapsed_secs: 45,
      reason: { code: 'JOB_TIMEOUT', detail: 'timed out at 45 s' },
    }),
    txrrunMethodRow('cox-ctdna-status-rfs', 'cannot_run', {
      group: 'static-risk',
      group_label: 'Static risk',
      reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements.' },
    }),
  ],
})

/** The working story's run: one row per engine state (every action visible). */
export const TXRRUN_RUN_F_WORKING: TxrRunDetail = runDetail({
  id: 'run-f-working',
  dir: 'Documents/TxResBench/analysis-fx-2002',
  status: 'running',
  elapsed_secs: 75,
  estimate: {
    schedule_seconds: TXRRUN_SCHEDULE_SECONDS,
    total_seconds: TXRRUN_SCHEDULE_SECONDS,
    estimate_quality: 'measured',
  },
  log_lines: 1,
  methods: [
    txrrunMethodRow('direct-on', 'waiting'),
    txrrunMethodRow('cox-timevarying-slope', 'downloading', { group: 'dynamic-risk', group_label: 'Dynamic risk' }),
    txrrunMethodRow('dynforest', 'running', { group: 'dynamic-risk', group_label: 'Dynamic risk', phase: 'predict', elapsed_secs: 41 }),
    txrrunMethodRow('flirti', 'finished', {
      prob_source: 'native',
      phase: 'done',
      elapsed_secs: 30,
      duration_ms: 30000,
      coverage: { scored: TXRRUN_PATIENTS, eligible: TXRRUN_PATIENTS, fraction: 1 },
    }),
    txrrunMethodRow('baseline-ctdna-detectability', 'failed', {
      group: 'static-risk',
      group_label: 'Static risk',
      phase: 'fit',
      elapsed_secs: 45,
      reason: { code: 'JOB_TIMEOUT', detail: 'timed out at 45 s' },
    }),
    txrrunMethodRow('cox-ctdna-status-rfs', 'cannot_run', {
      group: 'static-risk',
      group_label: 'Static risk',
      reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements.' },
    }),
  ],
})

/** The finished story's run (the terminal snapshot). */
export const TXRRUN_RUN_F_FINISHED: TxrRunDetail = runDetail({
  id: 'run-f-finished',
  dir: 'Documents/TxResBench/analysis-fx-2003',
  status: 'finished',
  elapsed_secs: 6 * 60 + 12,
  estimate: {
    schedule_seconds: TXRRUN_SCHEDULE_SECONDS,
    total_seconds: TXRRUN_SCHEDULE_SECONDS,
    estimate_quality: 'measured',
  },
  log_lines: 5,
  predictions_ready: true,
  methods: [
    txrrunMethodRow('direct-on', 'finished', { prob_source: 'native', phase: 'done', duration_ms: 72000, elapsed_secs: 72 }),
    txrrunMethodRow('cox-timevarying-slope', 'finished', { group: 'dynamic-risk', group_label: 'Dynamic risk', prob_source: 'recalibrated', phase: 'done', duration_ms: 50000 }),
    txrrunMethodRow('dynforest', 'finished', { group: 'dynamic-risk', group_label: 'Dynamic risk', prob_source: 'recalibrated', phase: 'done', duration_ms: 64000 }),
    txrrunMethodRow('flirti', 'finished', { prob_source: 'native', phase: 'done', duration_ms: 41000 }),
    txrrunMethodRow('baseline-ctdna-detectability', 'finished', { group: 'static-risk', group_label: 'Static risk', prob_source: 'native', phase: 'done', duration_ms: 18000 }),
    txrrunMethodRow('cox-ctdna-status-rfs', 'finished', { group: 'static-risk', group_label: 'Static risk', prob_source: 'native', phase: 'done', duration_ms: 22000 }),
  ],
})

/** The failed story's run: the failure pair survives; the run keeps going. */
export const TXRRUN_RUN_F_FAILED: TxrRunDetail = runDetail({
  id: 'run-f-failed',
  dir: 'Documents/TxResBench/analysis-fx-2004',
  status: 'running',
  elapsed_secs: 200,
  estimate: {
    schedule_seconds: TXRRUN_SCHEDULE_SECONDS,
    total_seconds: TXRRUN_SCHEDULE_SECONDS,
    estimate_quality: 'measured',
  },
  log_lines: 4,
  predictions_ready: true,
  methods: [
    txrrunMethodRow('direct-on', 'finished', { prob_source: 'native', phase: 'done', duration_ms: 72000 }),
    txrrunMethodRow('cox-timevarying-slope', 'failed', {
      group: 'dynamic-risk',
      group_label: 'Dynamic risk',
      phase: 'predict',
      elapsed_secs: 130,
      reason: { code: 'EXECUTION_ERROR', detail: 'the fitting step returned no model' },
    }),
    txrrunMethodRow('dynforest', 'running', { group: 'dynamic-risk', group_label: 'Dynamic risk', phase: 'predict', elapsed_secs: 55 }),
    txrrunMethodRow('flirti', 'waiting'),
    txrrunMethodRow('baseline-ctdna-detectability', 'failed', {
      group: 'static-risk',
      group_label: 'Static risk',
      phase: 'env',
      elapsed_secs: 90,
      reason: { code: 'ENV_VERIFY_FAILED', detail: 'the environment did not verify' },
    }),
    txrrunMethodRow('cox-ctdna-status-rfs', 'cannot_run', {
      group: 'static-risk',
      group_label: 'Static risk',
      reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements.' },
    }),
    // qa-fixes4 ITEM-3 (methods-r3 R3-methods-9): the env-missing row — the
    // engine stores the OLD pre-vocabulary detail ("no published
    // environment for method <id>") under the shared ENV_IMAGE_MISSING
    // code (the orchestrator's own words); the row's detail line must read
    // the LIST's sentence for the same code.
    txrrunMethodRow('jm-mem-lq', 'cannot_run', {
      group: 'response-call',
      group_label: 'Response call',
      reason: {
        code: 'ENV_IMAGE_MISSING',
        detail: 'no published environment for method "jm-mem-lq"',
      },
    }),
  ],
})

/**
 * qa-fixes4 ITEM-1 (results-r3 R3-results-2): the F leak story's run — a
 * TERMINAL failed snapshot (a direct URL at a terminal run renders the
 * snapshot) whose reason is the report's own leaked wording (tool name +
 * absolute path). The page's detail line passes `safeText`, and the
 * browser spec `txr-internal-text.spec.ts` asserts no text node leaks the
 * tool name or the path. Deliberate fixture seed: the copy-guard's
 * allow-list carries this line with its reason (fixture data, never
 * user-visible copy).
 */
export const TXRRUN_RUN_LEAK: TxrRunDetail = runDetail({
  id: 'run-f-leak',
  dir: 'Documents/TxResBench/analysis-fx-2005',
  status: 'failed',
  elapsed_secs: 95,
  estimate: {
    schedule_seconds: TXRRUN_SCHEDULE_SECONDS,
    total_seconds: TXRRUN_SCHEDULE_SECONDS,
    estimate_quality: 'measured',
  },
  log_lines: 2,
  methods: [
    txrrunMethodRow('baseline-ctdna-detectability', 'failed', {
      group: 'static-risk',
      group_label: 'Static risk',
      phase: 'env',
      elapsed_secs: 95,
      reason: { code: 'ENV_IMAGE_TOOL_MISSING', detail: 'oras is not installed (looked in /data/txr-live/bin and PATH)' },
    }),
    txrrunMethodRow('cox-ctdna-status-rfs', 'cannot_run', {
      group: 'static-risk',
      group_label: 'Static risk',
      reason: { code: 'REQUIRED_MARKER_MISSING', detail: 'LDH is not in your measurements.' },
    }),
  ],
})

/** Every cassette-served run detail, keyed by run id (the mock's getRun table). */
export const TXRRUN_RUN_DETAILS: Record<string, TxrRunDetail> = {
  [TXRRUN_RUN_F.id]: TXRRUN_RUN_F,
  [TXRRUN_RUN_F_WORKING.id]: TXRRUN_RUN_F_WORKING,
  [TXRRUN_RUN_F_FINISHED.id]: TXRRUN_RUN_F_FINISHED,
  [TXRRUN_RUN_F_FAILED.id]: TXRRUN_RUN_F_FAILED,
  [TXRRUN_RUN_LEAK.id]: TXRRUN_RUN_LEAK,
}

/** The rows the stream route owns (the id-scoped mock route's claim). */
export const TXRRUN_STREAM_RUN_IDS: ReadonlySet<string> = new Set(
  Object.values(TXRRUN_RUN_DETAILS).map(run => run.id),
)

// ── the log fixtures (the panel's backfill + the stream's live tail) ────────

/** One fixture line of a run (the panel's chip-filter material). */
function fxLogLine(
  seq: number,
  methodId: string | null,
  content: string,
  stream: TxrLogStream = 'stdout',
): TxrRunLogLine {
  return {
    seq,
    ...(methodId !== null ? { method_id: methodId } : {}),
    stream,
    content,
    created_at: '2026-09-03T08:50:10Z',
  }
}

/** The live story's log lines (the panel's backfill content; the stream's
 *  `log` frames are the SAME lines, seqs 2..4 — the store's merge de-dups). */
export const TXRRUN_LOGS_F: TxrRunLogLine[] = [
  fxLogLine(0, null, 'run admitted; 6 methods queued', 'engine'),
  fxLogLine(1, 'dynforest', 'environment ready; fitting'),
  fxLogLine(2, 'direct-on', 'environment ready; drawing'),
  fxLogLine(3, 'direct-on', 'fitting on 132 patient rows'),
  fxLogLine(4, null, '0 of 6 failed; predictions ready', 'engine'),
]

/** The finished story's log lines. */
export const TXRRUN_LOGS_F_FINISHED: TxrRunLogLine[] = [
  fxLogLine(0, 'direct-on', 'fit + predict done'),
  fxLogLine(1, null, 'predictions ready — 6 columns', 'engine'),
]

/** The failed story's log lines (the failure reasons' own trace). */
export const TXRRUN_LOGS_F_FAILED: TxrRunLogLine[] = [
  fxLogLine(0, 'cox-timevarying-slope', 'no model returned; aborting', 'stderr'),
  fxLogLine(1, 'cox-ctdna-status-rfs', 'no eligibility — LDH is not in your measurements.', 'engine'),
]

/** The fixture log table, keyed by run id (`Txr.listRunLogs` backfill). */
export const TXRRUN_LOGS: Record<string, TxrRunLogsResponse> = {
  [TXRRUN_RUN_F.id]: { lines: TXRRUN_LOGS_F, next_seq: 5, total: 5 },
  [TXRRUN_RUN_F_WORKING.id]: { lines: TXRRUN_LOGS_F.slice(0, 2), next_seq: 2, total: 2 },
  [TXRRUN_RUN_F_FINISHED.id]: { lines: TXRRUN_LOGS_F_FINISHED, next_seq: 2, total: 2 },
  [TXRRUN_RUN_F_FAILED.id]: { lines: TXRRUN_LOGS_F_FAILED, next_seq: 2, total: 2 },
}

// ── the SSE frame scripts (the mock stream's replay per run id) ─────────────

/** One typed `status` frame. */
function statusFrame(status: TxrRunStatus): TxrRunFixtureFrame {
  return { event: 'status', data: { status } }
}

/** One typed `method` frame (a row transition). */
function methodFrame(
  methodId: string,
  state: string,
  phase: string,
  bytes: { done: number; total: number },
  elapsedSecs: number,
): TxrRunFixtureFrame {
  return {
    event: 'method',
    data: {
      method_id: methodId,
      state,
      phase,
      bytes_downloaded: bytes.done,
      bytes_total: bytes.total,
      elapsed_secs: elapsedSecs,
    },
  }
}

/** One typed `progress` frame. */
function progressFrame(methodId: string, phase: string, pct: number, message: string): TxrRunFixtureFrame {
  return { event: 'progress', data: { method_id: methodId, phase, pct, message } }
}

/** One typed `log` frame. */
function logFrame(line: TxrRunLogLine): TxrRunFixtureFrame {
  return { event: 'log', data: line }
}

/** One typed `prediction` frame (the finished-column announcement). */
function predictionFrame(methodId: string): TxrRunFixtureFrame {
  return {
    event: 'prediction',
    data: {
      method_id: methodId,
      prob_source: 'native',
      coverage_fraction: 1,
      eligible: TXRRUN_PATIENTS,
      scored: TXRRUN_PATIENTS,
    },
  }
}

/**
 * The live story's replay: `direct-on` walks waiting → downloading (the
 * env bytes) → running (the fit message) → finished; the `prediction`
 * frame lights the results affordance; the engine's finished line appends.
 * The stream is left OPEN (the gallery mock's contract) — the F page stays
 * live; the terminal frame is the finished story's own script.
 */
export const TXRRUN_FRAMES_F: TxrRunFixtureFrame[] = [
  statusFrame('running'),
  methodFrame('direct-on', 'downloading', 'env', { done: 160, total: 250 }, 20),
  logFrame(TXRRUN_LOGS_F[2]),
  methodFrame('direct-on', 'running', 'fit', { done: 250, total: 250 }, 38),
  progressFrame('direct-on', 'fit', 40, 'fitting on 132 patient rows'),
  logFrame(TXRRUN_LOGS_F[3]),
  progressFrame('direct-on', 'fit', 95, 'fitting on 132 patient rows'),
  methodFrame('direct-on', 'finished', 'done', { done: 250, total: 250 }, 52),
  predictionFrame('direct-on'),
  logFrame(TXRRUN_LOGS_F[4]),
]

/** The working story's replay: the run's status + one engine line. */
export const TXRRUN_FRAMES_F_WORKING: TxrRunFixtureFrame[] = [
  statusFrame('running'),
  logFrame(TXRRUN_LOGS_F[1]),
]

/** The finished story's replay: the terminal status latches the snapshot. */
export const TXRRUN_FRAMES_F_FINISHED: TxrRunFixtureFrame[] = [
  statusFrame('finished'),
  logFrame(TXRRUN_LOGS_F_FINISHED[1]),
]

/** The failed story's replay: the run's status + the failure trace. */
export const TXRRUN_FRAMES_F_FAILED: TxrRunFixtureFrame[] = [
  statusFrame('running'),
  logFrame(TXRRUN_LOGS_F_FAILED[0]),
]

/**
 * The frame script of one fixture run (the gallery mock's stream replay for
 * `GET /api/txr/runs/<runId>/stream`); an unknown id gets the empty script
 * — an idle open stream, the path-family owner's own contract.
 */
export function txrrunStreamFrames(runId: string): TxrRunFixtureFrame[] {
  switch (runId) {
    case TXRRUN_RUN_F.id:
      return TXRRUN_FRAMES_F
    case TXRRUN_RUN_F_WORKING.id:
      return TXRRUN_FRAMES_F_WORKING
    case TXRRUN_RUN_F_FINISHED.id:
      return TXRRUN_FRAMES_F_FINISHED
    case TXRRUN_RUN_F_FAILED.id:
      return TXRRUN_FRAMES_F_FAILED
    default:
      return []
  }
}

/** One fixture run summary (the at-a-time control's confirmed answer). */
export function txrrunRunSummary(data: { id: string; at_a_time: number }): TxrRunSummary {
  const run = TXRRUN_RUN_DETAILS[data.id] ?? TXRRUN_RUN_F
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    dir: run.dir,
    created_at: run.created_at,
    elapsed_secs: run.elapsed_secs,
    config: { ...run.config, at_a_time: data.at_a_time },
    counts: run.counts,
    input_summary: run.input_summary,
    method_ids: run.method_ids,
    model_ids: [],
    predictions_ready: run.predictions_ready,
    started_at: run.started_at,
    finished_at: run.finished_at,
  }
}
