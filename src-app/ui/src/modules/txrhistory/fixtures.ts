/**
 * txrhistory dev-gallery + unit fixtures (ITEM-6; PROV-HIST-6, INV-6) —
 * screen K's synthetic run family. Every value is fixture data:
 *
 * - run ids are namespaced synthetic uuids (`fixtureRunId(k)` — the stable
 *   generator, never a real run id, never a random one);
 * - the board's example facts never enter code or data: the counts and
 *   sizes come from the fixed spreads below (46/13/48/21 patients, the
 *   289 MiB usage figure, the 25-run paging family) — the boards' own
 *   example counts, sizes and durations are design examples and are
 *   never spelled here;
 * - file names are the board's example names AS STRINGS (`patients.csv`,
 *   `measurements.csv`, `new_measurements.csv`, `march_new.csv`,
 *   `lung_pilot.csv`, `breast_panel.csv` — the plan's fixture provision)
 *   — never a name derived from a dir stem, never a count;
 * - method ids are the method catalogue's own ids as ids
 *   (`landmark-cox-current`, `cox-cutpoint-risk`, `relchange-threshold` —
 *   the ids the K rows and the F rows share, no third vocabulary);
 * - the one patient-id-bearing shape is the terminal log capture: a
 *   method line names a fixture patient (`fxPatientId(k)` — `S0001…`, the
 *   fixture name space, never a board patient id);
 * - times come from a fixed spread (`fxTimestamp(k)`: hour steps from one
 *   anchor — deterministic, monotonic newest-first), durations and sizes
 *   from named spreads — never a board duration or byte figure.
 *
 * The family is ONE inventory: six runs (the four board-shaped rows of
 * the board's populated screen + the running state + the copy-cleared
 * state the two other stories pin), plus the 25-run generator the
 * paging ergonomics (INV-1) exercise. The detail/usage/log records are
 * the same family's, so any story is a view over one consistent set.
 */
import type {
  RunConfig,
  TxrHistoryDetail,
  TxrHistoryItem,
  TxrHistoryModelsMade,
  TxrHistoryPage,
  TxrHistoryUsage,
  TxrRunCounts,
  TxrRunLogLine,
  TxrRunMethod,
  TxrRunSummary,
} from '@/api-client/types'

/** One mebibyte (the fixture byte figures' unit). */
const MIB = 1024 * 1024

/** One gibibyte (the fixture settings' memory figure's unit — the K
 *  Settings line reads the board's "16 GB" from this). */
const GIB = 1024 * 1024 * 1024

/**
 * The fixture run-id name space: `e0000000-…-<k>` — a fixed synthetic
 * uuid per story run (stable: the same `k` gives the same id forever).
 */
export function fixtureRunId(k: number): string {
  return `e0000000-0000-4000-8000-${k.toString(16).padStart(12, '0')}`
}

/** The fixture patient-id name space (`S0001`… — never a board patient id). */
export function fxPatientId(k: number): string {
  return `S${String(k).padStart(4, '0')}`
}

/** The run dir of fixture run `k` (the synthetic data root's own shape). */
export function fixtureRunDir(k: number): string {
  return `/data/txresbench/analysis-2026-06-18-${String(k).padStart(8, '0')}`
}

/**
 * The fixed timestamp spread: the anchor hour steps back one hour per
 * `k` (k=1 newest). Monotonic newest-first for any consecutive family.
 */
export function fxTimestamp(k: number): string {
  return new Date(Date.UTC(2026, 5, 18, 10, 2, 5) - (k - 1) * 3_600_000).toISOString()
}

/** The fixture run's synthetic terminal log capture. */
export function fixtureLogLine(
  seq: number,
  content: string,
  methodId?: string,
): TxrRunLogLine {
  return {
    seq,
    content,
    ...(methodId !== undefined ? { method_id: methodId } : {}),
    stream: seq % 3 === 0 ? 'stderr' : 'stdout',
    created_at: new Date(Date.UTC(2026, 5, 18, 10, 3, 0) + seq * 12_000).toISOString(),
  }
}

/** The three catalogue method ids the family runs (the catalogue's own ids). */
export const TXHISTORY_METHOD_IDS = [
  'landmark-cox-current',
  'cox-cutpoint-risk',
  'relchange-threshold',
] as const

/** A method row of the K list (id + version + the recorded seconds). */
export interface TxrHistoryMethodFixture {
  id: string
  version: string
  elapsed_secs?: number
}

/** The fixture method rows of a double/three-method train run. */
const FX_METHOD_REF_ROW: TxrHistoryMethodFixture[] = [
  { id: 'landmark-cox-current', version: '1.0', elapsed_secs: 130 },
  { id: 'cox-cutpoint-risk', version: '1.0', elapsed_secs: 65 },
  { id: 'relchange-threshold', version: '0.9', elapsed_secs: 45 },
]

/** One method row by catalogue id (the spread's version + duration). */
function fxMethodRow(id: string): TxrHistoryItem['methods'][number] {
  const row = FX_METHOD_REF_ROW.find(entry => entry.id === id)!
  return {
    id: row.id,
    version: row.version,
    ...(row.elapsed_secs !== undefined ? { elapsed_secs: row.elapsed_secs } : {}),
  }
}

/** The compact list-row method refs of the family (a fixed spread of the
 *  catalogue ids + the row duration spread). */
function fxRowMethods(count: number): TxrHistoryItem['methods'] {
  return FX_METHOD_REF_ROW.slice(0, count).map(row => ({
    id: row.id,
    version: row.version,
    ...(row.elapsed_secs !== undefined ? { elapsed_secs: row.elapsed_secs } : {}),
  }))
}

/** The full method row of the detail (the engine's `TxrRunMethod` shape). */
function fxFullMethod(row: TxrHistoryMethodFixture): TxrRunMethod {
  return {
    method_id: row.id,
    label: row.id,
    group: row.id === 'relchange-threshold' ? 'response-call' : 'static-risk',
    group_label: row.id === 'relchange-threshold' ? 'Response call' : 'Static risk',
    version: row.version,
    state: 'finished',
    bytes_downloaded: 0,
    ...(row.elapsed_secs !== undefined ? { elapsed_secs: row.elapsed_secs } : {}),
  }
}

/** The "Made 2 models (Cohort A, day 60 and one more)" block of the board
 *  row-1 shape (one named set + one unrecorded-set remainder — the
 *  board's own sentence shape, synthetic names). */
const FX_MADE_TWO: TxrHistoryModelsMade = {
  produced: 2,
  saved_sets: [
    { set_id: 'set-k-1', set_name: 'Cohort A, day 60', model_count: 1 },
  ],
}

/** The run-config facts of the family's settings + the rerun summary. */
const FX_CONFIG: RunConfig = {
  endpoint: 'pfs',
  decision_day: 60,
  look_ahead_day: 210,
  covariates: true,
  at_a_time: 2,
  cpus: 4,
  save_models: true,
  label_day: 60,
}

/** The engine-counts shape of a finished fixture run. */
const FX_COUNTS: TxrRunCounts = {
  finished: 3,
  failed: 0,
  stopped: 0,
  skipped: 0,
  cannot_run: 0,
  running: 0,
  downloading: 0,
  waiting: 0,
}

/**
 * One fixture run (the family builder). The defaults are the board's
 * first row's shape with SYNTHETIC facts (three methods — the board's
 * own example method count is a design example; the patients/counts/
 * outcome numbers are the fixed spread); every named run below is an
 * override.
 */
export function fixtureRun(k: number, over: Partial<TxrHistoryItem> = {}): TxrHistoryItem {
  return {
    id: fixtureRunId(k),
    bucket: 'finished',
    mode: 'train',
    created_at: fxTimestamp(k),
    method_count: 3,
    file_names: ['patients.csv', 'new_measurements.csv'],
    learned_from: 46,
    predicted: 13,
    endpoint: 'pfs',
    decision_day: 60,
    look_ahead_day: 210,
    methods: fxRowMethods(3),
    models_made: { produced: 0, saved_sets: [] },
    models_used: [],
    markers: 5,
    markers_saved: true,
    copies_kept: true,
    can_rerun: true,
    can_reopen: true,
    can_download: true,
    dir: fixtureRunDir(k),
    elapsed_secs: 175,
    estimate_total_seconds: 245,
    ...over,
  }
}

/**
 * The board's first row (the train run whose expanded block the stories
 * show): two saved sets' worth of produced models, one of them named.
 */
export const TXHISTORY_RUN_BOARD_TRAIN = fixtureRun(1, {
  file_names: ['patients.csv', 'measurements.csv', 'new_measurements.csv'],
  models_made: FX_MADE_TWO,
  method_count: 3,
})

/** The running row (the "Open the running run" action's run). */
export const TXHISTORY_RUN_RUNNING = fixtureRun(2, {
  bucket: 'running',
  created_at: '2026-06-18T09:45:00Z',
  method_count: 2,
  methods: fxRowMethods(2),
  models_made: { produced: 0, saved_sets: [] },
  markers_saved: false,
  can_rerun: false,
  can_reopen: false,
  can_download: false,
  elapsed_secs: undefined,
  estimate_total_seconds: undefined,
})

/** The board's second row (the reuse run — the saved-model chip + the
 *  consumed-model title line). */
export const TXHISTORY_RUN_BOARD_REUSE = fixtureRun(3, {
  bucket: 'finished',
  mode: 'reuse',
  created_at: '2026-06-17T14:36:00Z',
  method_count: 1,
  methods: [fxMethodRow('relchange-threshold')],
  file_names: ['march_new.csv'],
  learned_from: undefined,
  predicted: 9,
  models_used: [
    {
      model_id: 'fx-model-1',
      model_name: 'cohort-a-day-60',
      set_id: 'set-k-1',
      set_name: 'Cohort A, day 60',
    },
  ],
  models_made: { produced: 0, saved_sets: [] },
  decision_day: 60,
  elapsed_secs: 45,
  estimate_total_seconds: undefined,
})

/** The board's third row (the one-method learned run). */
export const TXHISTORY_RUN_BOARD_TRAIN_ONE = fixtureRun(4, {
  bucket: 'finished',
  created_at: '2026-06-15T09:12:00Z',
  method_count: 1,
  methods: [fxMethodRow('cox-cutpoint-risk')],
  file_names: ['lung_pilot.csv'],
  learned_from: 48,
  predicted: undefined,
  decision_day: 42,
  look_ahead_day: 224,
  models_made: { produced: 0, saved_sets: [] },
  elapsed_secs: 65,
  estimate_total_seconds: undefined,
})

/** The board's fourth row (the failed run — the reason line verbatim). */
export const TXHISTORY_RUN_BOARD_FAILED = fixtureRun(5, {
  bucket: 'failed',
  created_at: '2026-06-14T16:48:00Z',
  method_count: 1,
  methods: [fxMethodRow('relchange-threshold')],
  file_names: ['breast_panel.csv'],
  learned_from: undefined,
  predicted: undefined,
  reason: {
    code: 'REQUIRED_MARKER_MISSING',
    detail: 'marker LDH is missing from the measurements',
  },
  markers_saved: false,
  can_reopen: false,
  can_download: false,
  models_made: { produced: 0, saved_sets: [] },
  elapsed_secs: undefined,
  estimate_total_seconds: undefined,
})

/** The copy-cleared row (the "Use these settings again" action's run —
 *  `can_rerun: false`, the honest retention state flipped). */
export const TXHISTORY_RUN_COPIES_CLEARED = fixtureRun(6, {
  bucket: 'finished',
  mode: 'reuse',
  created_at: '2026-06-13T11:30:00Z',
  method_count: 1,
  methods: [fxMethodRow('cox-cutpoint-risk')],
  file_names: ['march_new.csv'],
  predicted: 9,
  models_used: [
    {
      model_id: 'fx-model-1',
      model_name: 'cohort-a-day-60',
      set_id: 'set-k-1',
      set_name: 'Cohort A, day 60',
    },
  ],
  models_made: { produced: 0, saved_sets: [] },
  copies_kept: false,
  can_rerun: false,
  elapsed_secs: 45,
  estimate_total_seconds: undefined,
})

/**
 * qa-fixes4 ITEM-1 (results-r3 R3-results-2, the help-r3 location row): the
 * leak story's failed row — the reason is the report's own leaked wording
 * (tool name + absolute path). The card's reason line passes `safeText`,
 * and the browser spec `txr-internal-text.spec.ts` asserts no text node
 * leaks the tool name or the path on `/history`. Deliberate fixture seed:
 * the copy-guard's allow-list carries this line with its reason (fixture
 * data, never user-visible copy).
 */
export const TXHISTORY_RUN_LEAK = fixtureRun(9, {
  bucket: 'failed',
  created_at: '2026-06-19T08:02:00Z',
  method_count: 1,
  methods: [fxMethodRow('baseline-ctdna-detectability')],
  file_names: ['breast_panel.csv'],
  learned_from: undefined,
  predicted: undefined,
  reason: {
    code: 'ENV_IMAGE_TOOL_MISSING',
    detail: 'oras is not installed (looked in /data/txr-live/bin and PATH)',
  },
  markers_saved: false,
  copies_kept: true,
  can_rerun: true,
  can_reopen: false,
  can_download: false,
  models_made: { produced: 0, saved_sets: [] },
  elapsed_secs: undefined,
  estimate_total_seconds: undefined,
})

/**
 * The family inventory, newest first (server order): the four board rows
 * + the running row + the copy-cleared row — one consistent inventory
 * for every story's list view.
 */
export const TXHISTORY_RUNS: TxrHistoryItem[] = [
  TXHISTORY_RUN_BOARD_TRAIN,
  TXHISTORY_RUN_RUNNING,
  TXHISTORY_RUN_BOARD_REUSE,
  TXHISTORY_RUN_BOARD_TRAIN_ONE,
  TXHISTORY_RUN_BOARD_FAILED,
  TXHISTORY_RUN_COPIES_CLEARED,
]

/**
 * The 25-run family (the INV-1 scale state: a 20-row server page needs a
 * second page). Every run cycles the fixed spread build; ids and stamps
 * are the same stable generators.
 */
export const TXHISTORY_RUNS_MANY: TxrHistoryItem[] = Array.from(
  { length: 25 },
  (_unused, index) => fixtureRun(index + 1),
)

/**
 * The detail of fixture run `k` — the row's facts + the expanded block's
 * own records (the engine's rows, the settings view, the copies block,
 * the usage facts the block's composition reads).
 */
export function fixtureDetail(run: TxrHistoryItem): TxrHistoryDetail {
  return {
    id: run.id,
    bucket: run.bucket,
    mode: run.mode,
    created_at: run.created_at,
    method_count: run.method_count,
    file_names: run.file_names,
    learned_from: run.learned_from,
    predicted: run.predicted,
    endpoint: run.endpoint,
    decision_day: run.decision_day,
    look_ahead_day: run.look_ahead_day,
    methods: run.methods.map(row => {
      const full = fxFullMethod({ id: row.id, version: row.version, elapsed_secs: row.elapsed_secs })
      if (run.bucket === 'running') return { ...full, state: 'running' as const }
      if (run.bucket === 'failed') {
        return { ...full, state: 'failed' as const, reason: run.reason }
      }
      return full
    }),
    models_made: run.models_made,
    models_saved: run.models_made.saved_sets.map((set, index) => ({
      model_id: `fx-model-${index + 1}`,
      model_name: 'cohort-a-day-60',
      set_id: set.set_id,
      set_name: set.set_name,
      size_bytes: 812_345,
    })),
    models_used: run.models_used,
    markers: run.markers,
    markers_saved: run.markers_saved,
    copies_kept: run.copies_kept,
    copies: { kept: run.copies_kept },
    file_sizes: run.file_names.map(name => ({
      name,
      size_bytes: name.startsWith('patients') ? 48_213 : 96_417,
    })),
    log_line_count: run.bucket === 'finished' ? 6 : 0,
    can_rerun: run.can_rerun,
    can_reopen: run.can_reopen,
    can_download: run.can_download,
    dir: run.dir,
    dir_bytes: 3 * MIB,
    elapsed_secs: run.elapsed_secs,
    use_estimate: run.estimate_total_seconds !== undefined
      ? { total_seconds: run.estimate_total_seconds, estimate_quality: 'estimate' }
      : undefined,
    reason: run.reason,
    settings: {
      endpoint: run.endpoint,
      decision_day: run.decision_day,
      look_ahead_day: run.look_ahead_day,
      covariates: run.mode === 'train',
      at_a_time: run.mode === 'train' ? 2 : 1,
      cpus: 4,
      save_models: run.mode === 'train',
      mode: run.mode,
      seed: 7,
      memory_total_bytes: 16 * GIB,
    },
  }
}

/** The expanded-block details of the family (one per run id). */
export const TXHISTORY_DETAILS: Record<string, TxrHistoryDetail> = Object.fromEntries(
  TXHISTORY_RUNS.map(run => [run.id, fixtureDetail(run)]),
)

/** The copy-cleared detail's honest retention facts. */
TXHISTORY_DETAILS[TXHISTORY_RUN_COPIES_CLEARED.id] = {
  ...fixtureDetail(TXHISTORY_RUN_COPIES_CLEARED),
  copies: { kept: false },
  file_sizes: [],
  dir_bytes: undefined,
}

/**
 * A usage figure (the footer's "N runs · … uses N MB of stored files.
 * Delete a run to free the space."): the family's 6 runs with the 289 MiB
 * total is `fixtureUsage(6, …)`; a scoped story (the empty state's 0
 * runs, the paging family's 25) seeds its own consistent figure. The
 * segment split follows the fixed ratios (runs 70% / models 25% /
 * rest), so the three segments always sum to the total — the fixture
 * figures are the fixed spread, never the board's own example figures.
 */
export function fixtureUsage(runCount: number, totalBytes: number): TxrHistoryUsage {
  const runsBytes = Math.round((totalBytes * 70) / 100)
  const modelsBytes = Math.round((totalBytes * 25) / 100)
  return {
    run_count: runCount,
    total_bytes: totalBytes,
    runs_bytes: runsBytes,
    models_bytes: modelsBytes,
    other_bytes: Math.max(0, totalBytes - runsBytes - modelsBytes),
    computed_at: '2026-06-18T10:03:00Z',
    data_dir: '/data/txresbench',
  }
}

/** The usage figure of the six-run family (the board-row counts are the
 *  fixed spread; the totals' segments are internally consistent). */
export const TXHISTORY_USAGE: TxrHistoryUsage = fixtureUsage(6, 289 * MIB)

/**
 * The K list's server-side page over a fixture family — the provider's
 * own semantics (CONS-HIST-1/6): `q` substring over file names, method
 * ids and set names; `kind` maps learned/saved-model to the run modes;
 * the multi-value `status` reads the stopped/failed OR; `limit`/`offset`
 * page the result (never a client-side sieve — the same answers the
 * provider would give the fixture family).
 */
export function fixtureHistoryPage(
  runs: readonly TxrHistoryItem[],
  query: Record<string, string>,
): TxrHistoryPage {
  const { q, kind, status } = query
  let filtered = [...runs]
  if (kind === 'learned') filtered = filtered.filter(run => run.mode === 'train')
  if (kind === 'saved-model') filtered = filtered.filter(run => run.mode === 'reuse')
  if (status === 'stopped,failed') {
    filtered = filtered.filter(run => run.bucket === 'stopped' || run.bucket === 'failed')
  }
  const needle = (q ?? '').trim().toLowerCase()
  if (needle.length > 0) {
    filtered = filtered.filter(run =>
      [
        ...run.file_names,
        ...run.methods.map(method => method.id),
        ...run.models_used.map(model => model.set_name),
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }
  const limit = query.limit !== undefined ? Number(query.limit) : 20
  const offset = query.offset !== undefined ? Number(query.offset) : 0
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  }
}

/** The terminal-log capture of the board row-1 run (its 6 fixture lines). */
export const TXHISTORY_LOGS: Record<string, TxrRunLogLine[]> = {
  [TXHISTORY_RUN_BOARD_TRAIN.id]: [
    fixtureLogLine(1, '[landmark-cox-current] environment ready'),
    fixtureLogLine(2, '[landmark-cox-current] 46 eligible patients, 13 predicted', 'landmark-cox-current'),
    fixtureLogLine(3, '[landmark-cox-current] first patient: S0001', 'landmark-cox-current'),
    fixtureLogLine(4, '[cox-cutpoint-risk] fitted on 46 patients', 'cox-cutpoint-risk'),
    fixtureLogLine(5, '[cox-cutpoint-risk] wrote predictions.csv', 'cox-cutpoint-risk'),
    fixtureLogLine(6, '[relchange-threshold] 3 patients marked cannot-decide', 'relchange-threshold'),
  ],
}

/**
 * The log answer of a fixture run id (the story's method-filtered view):
 * the lines of the requested method, the run's line count, the next
 * resume seq — the endpoint's own semantics over the fixture capture.
 */
export function fixtureLogsFor(
  runId: string,
  methodId: string | null,
): { lines: TxrRunLogLine[]; next_seq: number; total: number } {
  const lines = TXHISTORY_LOGS[runId] ?? []
  const filtered = methodId === null ? lines : lines.filter(line => line.method_id === methodId)
  return {
    lines: filtered,
    next_seq: lines[lines.length - 1]?.seq ?? 0,
    total: filtered.length,
  }
}

/**
 * The rerun's summary (the engine's 202 [`TxrRunSummary`] — the NEW run's
 * record the page's `runningPath(newId)` lands on): the board row-1
 * run's settings replayed as the new fixture run 7.
 */
export const TXHISTORY_RERUN_SUMMARY: TxrRunSummary = {
  id: fixtureRunId(7),
  status: 'creating',
  mode: 'train',
  counts: FX_COUNTS,
  created_at: '2026-06-18T10:05:00Z',
  dir: fixtureRunDir(7),
  config: FX_CONFIG,
  input_summary: {
    file_names: {
      patients: 'patients.csv',
      measurements: 'measurements.csv',
      predict_measurements: 'new_measurements.csv',
    },
    markers: 5,
    patients: 46,
    predict_patients: 13,
  },
  method_ids: [...TXHISTORY_METHOD_IDS],
  model_ids: [],
  predictions_ready: false,
}
