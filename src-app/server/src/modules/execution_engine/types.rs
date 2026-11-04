//! The `execution_engine` type contract — the serde + JsonSchema surface of
//! every request and response the module owns (PROV-EE-2..EE-9), the shared
//! enums of the run state machine (INV-2) and the `TxrRunEvent` SSE vocabulary
//! (PROV-EE-4, via `sse_event_enum!` — the enum is the stream's OpenAPI
//! 200-response schema, emitted into `types.ts` by the regen).
//!
//! The contract is typed wherever a domain fact exists: run status, method
//! state, phase, probability source, task and endpoint are closed enums, so a
//! state nobody modelled cannot be emitted or met. Open strings remain only
//! where the data is open (method ids, group labels, reason details, log
//! content) — the closed/open split mirrors `method_catalogue::types`, the
//! sibling contract of this node's providers.
//!
//! Two provider types are imported rather than re-declared (the same rule as
//! `file_validator::types`):
//! - `file_validator::types::ParsedTable` — the browser-decoded table the
//!   engine's input snapshot carries (CONS-EE-11: one wire shape from the
//!   screens to the run);
//! - `method_catalogue::types::{ReasonCode, TimingQuality}` — the ONE
//!   eligibility reason vocabulary the screens and the engine share
//!   (CONS-EE-10: the catalogue-availability codes + the app's own outcome
//!   codes are one list after the reconcile growth) and the estimate-quality
//!   fact of PROV-MC-6.
//!
//! The engine-owned failure codes (PROV-EE-3's `ENV_UNREADY` … `INTERRUPTED`)
//! are [`EngineReasonCode`]; the wire `reason` field carries `{code, detail}`
//! strings so a consumer switches on one string from one list.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use ziee_core::sse_event_enum;

use crate::modules::file_validator::types::ParsedTable;
use crate::modules::method_catalogue::types::{ReasonCode, TimingQuality};

// ─────────────────────────────────────────────────────────────────────────────
// Named facts (DEC-9's precedent: the node's tunables are named constants in
// one place — a later promotion to user settings is a rename, not a rewrite).
// ─────────────────────────────────────────────────────────────────────────────

/// The engine's named limits + defaults.
pub struct TxrLimits;

impl TxrLimits {
    /// The board's "run N at a time" lane count floor (PROV-EE-2's 1..=8 —
    /// the F board's own select shows 1..4; the engine accepts the wider
    /// bound, DEC-12's per-method CPU share still holds).
    pub const AT_A_TIME_MIN: u32 = 1;
    /// The lane count ceiling (PROV-EE-2's 1..=8; more lanes would starve the
    /// per-method CPU share — DEC-12's `n_cpu = clamp(floor(cpus /
    /// at_a_time), 1, 4)`).
    pub const AT_A_TIME_MAX: u32 = 8;
    /// Run log rows capped per run (DEC-13: the log panel + "Copy the log" are
    /// bounded by this; the engine trims oldest rows).
    pub const MAX_LOG_LINES_PER_RUN: usize = 20_000;
    /// The log endpoint's page size ceiling (DEC-21 paging).
    pub const LOG_PAGE_LIMIT_MAX: u32 = 2_000;
    /// The run-list page default (PROV-EE-3, DEC-21 paging).
    pub const RUN_LIST_LIMIT_DEFAULT: u32 = 50;
    /// The run-list page ceiling (DEC-21).
    pub const RUN_LIST_LIMIT_MAX: u32 = 200;
    /// The run SSE client cap — the mirror of `jobs::runtime::MAX_SSE_CLIENTS`
    /// (PROV-EE-4: 256).
    pub const SSE_CLIENTS_MAX: usize = 256;
    /// The contract's fixed seed (DEC-12: `params.seed = 1`).
    pub const SEED: u32 = 1;
    /// The look-ahead ceiling (board E's max 365; the wider bound is the
    /// contract's horizon sanity line).
    pub const LOOK_AHEAD_DAY_MAX: f64 = 730.0;
}

/// The default decision day (screen B's middle option; the E screen always
/// sends the user's choice — the default is the documented fallback).
pub const DEFAULT_DECISION_DAY: f64 = 56.0;

/// The default prediction horizon (board E's "238 days ahead").
pub const DEFAULT_LOOK_AHEAD_DAY: f64 = 238.0;

/// The default lane count (board E's "run 3 at a time").
pub const DEFAULT_AT_A_TIME: u32 = 3;

/// The 15 route doc ids (PROV-EE-2..EE-8, the routes' `.id(...)` seam). Exactly
/// this list is pinned by TEST-EE-02 so the generated client surface
/// (`Txr.*` operation ids in `apiEndpoints.ts`) is one stable vocabulary.
pub const ROUTE_DOC_IDS: [&str; 15] = [
    "Txr.createRun",
    "Txr.listRuns",
    "Txr.getRun",
    "Txr.streamRun",
    "Txr.listRunLogs",
    "Txr.stopRun",
    "Txr.stopMethod",
    "Txr.skipMethod",
    "Txr.rerunRun",
    "Txr.deleteRun",
    "Txr.clearRuns",
    "Txr.getPredictions",
    "Txr.downloadPredictions",
    "Txr.getAnalysisConfig",
    "Txr.updateAnalysisConfig",
];

// ─────────────────────────────────────────────────────────────────────────────
// Closed enums — the run state machine and its vocabularies
// ─────────────────────────────────────────────────────────────────────────────

/// The run-level state machine (INV-2): the F/G/K screens switch on these
/// exactly. `creating` is the instant before the run row is committed;
/// `preparing` covers input copy + validation + eligibility classification;
/// `running` spans the lane dispatch; `finishing` is the aggregate finalize;
/// terminal states are `finished` / `failed` (incl. `INTERRUPTED` at boot) /
/// `stopped`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrRunStatus {
    Creating,
    Preparing,
    Running,
    Finishing,
    Finished,
    Failed,
    Stopped,
}

/// The per-method state machine (INV-2 — one sandboxed environment per method,
/// a method never runs twice in the same stack). `cannot_run` is the
/// classification verdict from run start (eligibility reason kept on the row);
/// `skipped` is a user skip of a waiting/downloading method; `failed` carries
/// its `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrMethodState {
    Waiting,
    Downloading,
    Running,
    Finished,
    Failed,
    Stopped,
    Skipped,
    CannotRun,
}

/// The method's execution phase (the F screen's phase column): `env` =
/// environment ensure (base + layer), `fit`/`predict` = the two contract
/// steps of one `run_method_in_stack` call (X1), `done` = terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrPhase {
    Idle,
    Env,
    Fit,
    Predict,
    Done,
}

/// Where a method column's probabilities come from (INV-3: never mixed
/// silently in one column; U2 recalibration is recorded per method).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrProbSource {
    Native,
    Recalibrated,
    None,
}

/// The outcome task a method ran as (the enumerated vocabulary ui-results
/// normalizes — CONS-UR-8; a run can mix tasks, `task_is_mixed` says so).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrTask {
    Pfs,
    Os,
    Response,
}

/// The run's endpoint verb (board E's outcome choice).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrEndpoint {
    Pfs,
    Os,
}

impl Default for TxrEndpoint {
    fn default() -> Self {
        // The worked-example path of the boards (path 1/2 are survival pfs).
        Self::Pfs
    }
}

/// The run's mode: `train` fits on the uploaded training inputs; `reuse`
/// applies resolved saved models (path 3 of the FLOW) — the request then
/// carries `model_ids` instead of a training method list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrRunMode {
    Train,
    Reuse,
}

/// A log line's stream (engine-authored state lines vs the method's captured
/// stdout/stderr).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrLogStream {
    Stdout,
    Stderr,
    Engine,
}

/// The engine-owned failure / terminal codes (PROV-EE-3). The delivery-time
/// codes (`ENV_UNREADY` … `INTERRUPTED`) are the ones the engine's own
/// machinery can raise; the eligibility codes come from the provider's
/// [`ReasonCode`] (one vocabulary, CONS-EE-10). `ENV_UNKNOWN` covers the
/// runnable-method-without-manifest-entry case (TEST-EE-06) and `ABORTED` is a
/// user stop (not a failure).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EngineReasonCode {
    EnvUnready,
    EnvUnknown,
    EnvVerifyFailed,
    SandboxUnavailable,
    JobTimeout,
    ModelVerifyFailed,
    Aborted,
    Interrupted,
    PredictionInvalid,
    RecalibrationFailed,
}

impl EngineReasonCode {
    /// The closed engine code list, in documentation order (the compile-time
    /// constant the vocabulary test pins).
    pub const ALL: [EngineReasonCode; 10] = [
        EngineReasonCode::EnvUnready,
        EngineReasonCode::EnvUnknown,
        EngineReasonCode::EnvVerifyFailed,
        EngineReasonCode::SandboxUnavailable,
        EngineReasonCode::JobTimeout,
        EngineReasonCode::ModelVerifyFailed,
        EngineReasonCode::Aborted,
        EngineReasonCode::Interrupted,
        EngineReasonCode::PredictionInvalid,
        EngineReasonCode::RecalibrationFailed,
    ];

    /// The code's wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            EngineReasonCode::EnvUnready => "ENV_UNREADY",
            EngineReasonCode::EnvUnknown => "ENV_UNKNOWN",
            EngineReasonCode::EnvVerifyFailed => "ENV_VERIFY_FAILED",
            EngineReasonCode::SandboxUnavailable => "SANDBOX_UNAVAILABLE",
            EngineReasonCode::JobTimeout => "JOB_TIMEOUT",
            EngineReasonCode::ModelVerifyFailed => "MODEL_VERIFY_FAILED",
            EngineReasonCode::Aborted => "ABORTED",
            EngineReasonCode::Interrupted => "INTERRUPTED",
            EngineReasonCode::PredictionInvalid => "PREDICTION_INVALID",
            EngineReasonCode::RecalibrationFailed => "RECALIBRATION_FAILED",
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run creation (PROV-EE-2)
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/runs` — the run the engine persists and drives. One
/// analysis = one run row holding the analysis config + the input snapshot +
/// the selected methods (train) or the resolved model assets (reuse).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateRunRequest {
    pub mode: TxrRunMode,
    pub input: TxrRunInput,
    pub config: RunConfig,
    /// Train mode: the selected catalogue method ids (≥ 1 — validate()).
    #[serde(default)]
    pub method_ids: Vec<String>,
    /// Reuse mode: the resolved model assets (`model-store`'s join shape,
    /// DEC-10 — assets are DATA to the engine, never an import).
    #[serde(default)]
    pub model_ids: Vec<TxrModelAsset>,
}

/// The input snapshot the engine validates + bundles (CONS-EE-11: it replays
/// the SAME parsed tables the screens POSTed — one code path, DEC-15).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunInput {
    /// Training patients (nullable in reuse mode, where the predict table is
    /// the run's only input).
    pub patients: Option<ParsedTable>,
    /// The uploaded measurements table (train and predict in one file, or the
    /// train table when a separate predict file is given).
    pub measurements: ParsedTable,
    /// The separate predict-patients file (path 3: reuse on NEW patients).
    pub predict_measurements: Option<ParsedTable>,
    /// The confirmed joins (one per measurement column group; the validator's
    /// join semantics — CONS-EE-11). Column ids or index keys. Empty = the
    /// simple one-table case.
    #[serde(default)]
    pub joins: Vec<TxrJoin>,
    /// The confirmed marker mapping (column key → catalogue marker id).
    #[serde(default)]
    pub mapping: Vec<TxrMapping>,
    /// K board's "Copies are kept with this run so it can be repeated" —
    /// default true (DEC-16); the history UI's "Do not keep copies" sends
    /// false.
    #[serde(default = "default_keep_copies")]
    pub keep_copies: bool,
}

fn default_keep_copies() -> bool {
    true
}

/// One confirmed join of a measurements column to the patients table.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrJoin {
    /// The marker variants the column matched (spellings / ids).
    pub variants: Vec<String>,
    /// The join key (the column key the validator resolved).
    pub key: String,
}

/// One confirmed marker mapping (column key → catalogue marker id).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrMapping {
    pub key: String,
    pub marker_id: String,
}

/// The run's analysis configuration (board E). Defaults are the documented
/// wire defaults (PROV-EE-2); `cpus: null` means "detect at run start"
/// (DEC-12) and `label_day: null` means "derive from the file's response_day
/// column" (DEC-9's D3 guard).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RunConfig {
    #[serde(default)]
    pub endpoint: TxrEndpoint,
    #[serde(default = "default_decision_day")]
    pub decision_day: f64,
    #[serde(default = "default_look_ahead_day")]
    pub look_ahead_day: f64,
    #[serde(default)]
    pub covariates: bool,
    #[serde(default = "default_at_a_time")]
    pub at_a_time: u32,
    #[serde(default)]
    pub cpus: Option<u32>,
    #[serde(default)]
    pub save_models: bool,
    #[serde(default)]
    pub label_day: Option<f64>,
}

fn default_decision_day() -> f64 {
    DEFAULT_DECISION_DAY
}

fn default_look_ahead_day() -> f64 {
    DEFAULT_LOOK_AHEAD_DAY
}

fn default_at_a_time() -> u32 {
    DEFAULT_AT_A_TIME
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            endpoint: TxrEndpoint::Pfs,
            decision_day: DEFAULT_DECISION_DAY,
            look_ahead_day: DEFAULT_LOOK_AHEAD_DAY,
            covariates: false,
            at_a_time: DEFAULT_AT_A_TIME,
            cpus: None,
            save_models: false,
            label_day: None,
        }
    }
}

/// A resolved model asset (DEC-10: data, not an import). The engine verifies
/// `host_dir` with `tree_sha256` (CONS-EE-6) and binds it read-only; the
/// digested env record is provenance against the manifest (EXAMPLE-EE-7).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrModelAsset {
    pub model_id: String,
    pub host_dir: String,
    /// 64-hex sha256 of the model tree — the verify-before-bind digest.
    pub tree_sha256: String,
    pub method_id: String,
    pub method_version: String,
    pub env: TxrMethodEnv,
    pub contract: String,
}

/// The env digest pair recorded on a method row / produced model (base + the
/// method's layer — provenance against the manifest, CONS-EE-8).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrMethodEnv {
    pub base_digest: String,
    pub layer_digest: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Run list / detail (PROV-EE-3)
// ─────────────────────────────────────────────────────────────────────────────

/// The run row the History list (K) and the F screen header render.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunSummary {
    pub id: Uuid,
    pub status: TxrRunStatus,
    pub mode: TxrRunMode,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub elapsed_secs: Option<u64>,
    pub config: RunConfig,
    pub method_ids: Vec<String>,
    /// The RESOLVED asset ids the reuse run consumed ([] in train mode).
    pub model_ids: Vec<String>,
    pub counts: TxrRunCounts,
    pub predictions_ready: bool,
    /// The run dir (absolute), `<data_root>/analysis-<UTC ts>-<id8>`.
    pub dir: String,
    pub input_summary: TxrRunInputSummary,
}

/// Per-run method-state counts (the F header's done/running/downloading/…
/// line, the G header's "11 of 12 methods finished").
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunCounts {
    pub finished: u32,
    pub failed: u32,
    pub stopped: u32,
    pub skipped: u32,
    pub cannot_run: u32,
    pub running: u32,
    pub downloading: u32,
    pub waiting: u32,
}

/// The input snapshot summary (K's files/settings facts; `markers` = distinct
/// resolved marker facts count after joins/mapping).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunInputSummary {
    pub patients: Option<u32>,
    pub predict_patients: Option<u32>,
    pub markers: u32,
    pub events: Option<u32>,
    pub file_names: TxrRunFileNames,
}

/// The uploaded source names, captured at create from the parsed tables
/// (reconcile GAP-HS-1: never derived from the run dir stem).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunFileNames {
    pub patients: Option<String>,
    pub measurements: String,
    pub predict_measurements: Option<String>,
}

/// One paged History page (PROV-EE-3).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunListResponse {
    pub runs: Vec<TxrRunSummary>,
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
}

/// The run detail = the summary + the per-method rows + the produced models +
/// the derivation facts (PROV-EE-3; the admission + estimate + outcome lines
/// of the F/G headers). The summary is FLATTENED so the wire is one object
/// (the `sse`/`jobs` precedent of a flat detail payload).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunDetail {
    #[serde(flatten)]
    pub summary: TxrRunSummary,
    pub methods: Vec<TxrRunMethod>,
    pub models: Vec<TxrProducedModel>,
    pub log_lines: u64,
    pub estimate: TxrRunEstimate,
    /// Detected at run start (DEC-12) — the F header's "on <n> CPUs".
    pub cpus: u32,
    /// Read once at run start (Linux /proc/meminfo), display-only (DEC-12).
    pub memory_total_bytes: Option<u64>,
    pub outcome: TxrRunOutcome,
}

/// One method's row of the run (the F screen's per-method line).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunMethod {
    pub method_id: String,
    /// The catalogue id (the board's monospace method name).
    pub label: String,
    pub group: String,
    pub group_label: String,
    pub version: String,
    pub state: TxrMethodState,
    /// The outcome task this method ran as (null until classified).
    pub task: Option<TxrTask>,
    /// The failure / cannot-run reason when the row did not reach `finished` —
    /// INV-2's "failure kept with its reason".
    pub reason: Option<TxrRunReason>,
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    /// Download progress only (the manifest size_bytes ratio; null outside
    /// the env phase).
    pub progress_pct: Option<f64>,
    pub phase: Option<TxrPhase>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub elapsed_secs: Option<u64>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub prob_source: Option<TxrProbSource>,
    pub coverage: Option<TxrCoverage>,
    pub env: Option<TxrMethodEnv>,
}

/// One structured reason (code from the ONE vocabulary — the provider's
/// [`ReasonCode`] for eligibility, [`EngineReasonCode`] for the machinery);
/// `detail` is the human line the F/H/K screens show.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunReason {
    pub code: String,
    pub detail: String,
}

impl TxrRunReason {
    /// From the provider's eligibility vocabulary (CONS-EE-10 — verbatim).
    pub fn from_catalogue(code: ReasonCode, detail: impl Into<String>) -> Self {
        Self {
            code: code.as_str().to_string(),
            detail: detail.into(),
        }
    }

    /// From the engine's own machinery codes.
    pub fn from_engine(code: EngineReasonCode, detail: impl Into<String>) -> Self {
        Self {
            code: code.as_str().to_string(),
            detail: detail.into(),
        }
    }
}

/// A produced model (X1's `/model` tree + the digests `model-store` binds to —
/// PROV-EE-9). `size_bytes` and `own_auc` are known at finalize (the grown
/// record, reconcile GAP-B/GAP-C).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrProducedModel {
    pub method_id: String,
    pub method_version: String,
    pub model_out_digest: String,
    /// Same value as `model_out_digest` — the model-store bind key.
    pub tree_sha256: String,
    pub dir: String,
    pub env: TxrMethodEnv,
    pub trained_on_patients: u32,
    pub size_bytes: u64,
    pub own_auc: Option<f64>,
}

/// The run's estimate facts (PROV-MC-6's response shape, stored on the run at
/// create — the F header's "about 7 minutes left" source).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunEstimate {
    pub total_seconds: f64,
    /// The lane-packed makespan at the run's at_a_time (estimate-quality per
    /// method carried by the same provider response).
    pub schedule_seconds: f64,
    pub estimate_quality: TimingQuality,
}

/// The outcome facts of the run (the detail's `task_is_mixed` = the heatmap
/// mixes tasks — INV-3's record beside every probability).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunOutcome {
    pub endpoint: TxrEndpoint,
    pub horizon: f64,
    pub task_is_mixed: bool,
}

/// The per-patient coverage record (the board's "needs 3 or more draws; 120 of
/// 151 have them" is renderable from this).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrCoverage {
    pub scored: u32,
    pub eligible: u32,
    pub fraction: f64,
}

/// `GET /api/txr/runs` query (paged — DEC-21; `limit` has the named default +
/// ceiling).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunListQuery {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs (PROV-EE-5)
// ─────────────────────────────────────────────────────────────────────────────

/// One run-scoped log line (the F screen's log panel + "Copy the log").
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunLogLine {
    pub seq: u64,
    pub method_id: Option<String>,
    pub stream: TxrLogStream,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

/// `GET /api/txr/runs/{id}/logs` (paged after `after_seq` — DEC-21).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunLogsResponse {
    pub lines: Vec<TxrRunLogLine>,
    pub next_seq: u64,
    pub total: u64,
}

/// The logs endpoint query.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunLogsQuery {
    #[serde(default)]
    pub method_id: Option<String>,
    #[serde(default)]
    pub after_seq: Option<u64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Control (PROV-EE-6)
// ─────────────────────────────────────────────────────────────────────────────

/// The mid-run lane change body (the F board's lane select; GROWN at
/// reconcile, CONS-UI-RUN-11).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrAtATimeRequest {
    pub at_a_time: u32,
}

/// `DELETE /api/txr/runs/{id}` (+ `DELETE /api/txr/runs`): delete_files=false
/// keeps the run dir under the app data root (K's "Do not keep copies" sends
/// true — DEC-16's mechanics are this flag; history-store owns the policy).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct TxrDeleteQuery {
    pub delete_files: bool,
}

impl Default for TxrDeleteQuery {
    fn default() -> Self {
        Self { delete_files: false }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Predictions (PROV-EE-7)
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/runs/{id}/predictions` — one aligned array per patient, one
/// entry per finished method (partial while the run continues — the G screen's
/// "11 of 12 methods finished" live). A null probability is an abstain; its
/// note is carried in the aligned `notes` array.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrPredictionsResponse {
    pub run_id: Uuid,
    pub endpoint: TxrEndpoint,
    pub horizon: f64,
    /// The predict patient ids, in `test/patients.csv` order.
    pub patients: Vec<String>,
    pub methods: Vec<TxrPredictionMethod>,
    /// Per-patient mean over non-null method values (DEC-11).
    pub average: Vec<Option<f64>>,
    pub generated_at: DateTime<Utc>,
}

/// One finished method's column (prob_source + coverage beside every value —
/// INV-3).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrPredictionMethod {
    pub method_id: String,
    pub group: String,
    pub group_label: String,
    pub task: TxrTask,
    pub prob_source: TxrProbSource,
    pub coverage: TxrCoverage,
    pub probabilities: Vec<Option<f64>>,
    pub notes: Vec<Option<String>>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis-config store (PROV-EE-8)
// ─────────────────────────────────────────────────────────────────────────────

/// The sticky E-screen settings (`txr_app_config` singleton; `config: null` is
/// an honest never-configured value when the copies were cleared).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrAppConfig {
    pub config: Option<RunConfig>,
    pub last_input_summary: Option<TxrLastInputSummary>,
}

/// The last input's count facts (what E restores without re-parsing files).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrLastInputSummary {
    pub patients: Option<u32>,
    pub predict_patients: Option<u32>,
    pub markers: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE event vocabulary (PROV-EE-4)
// ─────────────────────────────────────────────────────────────────────────────

/// A status-transition frame (also the stream's terminal signal).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TxrRunStatusFrame {
    pub status: String,
}

/// A method-row transition frame (state / reason / phase + the env download
/// counters).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TxrRunMethodFrame {
    pub method_id: String,
    pub state: String,
    pub reason_code: Option<String>,
    pub phase: Option<String>,
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    pub elapsed_secs: Option<u64>,
}

/// A progress frame (download pct + fit/predict phase; message is the phase
/// line).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TxrRunProgressFrame {
    pub method_id: String,
    pub phase: Option<String>,
    pub pct: Option<f64>,
    pub message: Option<String>,
}

/// A finished-column announcement (the G screen appends the column live).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TxrRunPredictionFrame {
    pub method_id: String,
    pub prob_source: String,
    pub coverage_fraction: f64,
    pub scored: u64,
    pub eligible: u64,
}

sse_event_enum! {
    /// Frames pushed on `GET /api/txr/runs/{id}/stream`: a run `status`
    /// change, a per-method `method` transition, a captured `log` line, a
    /// `progress` sample, or a finished `prediction` column. camelCase event
    /// names (PROV-EE-4's vocabulary).
    #[derive(Debug, Clone, Serialize, JsonSchema)]
    pub enum TxrRunEvent {
        Status(TxrRunStatusFrame),
        Method(TxrRunMethodFrame),
        Log(TxrRunLogLine),
        Progress(TxrRunProgressFrame),
        Prediction(TxrRunPredictionFrame),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Request validation (PROV-EE-2's 400s; TEST-EE-03)
// ─────────────────────────────────────────────────────────────────────────────

/// The create-request validation failure codes (the routes map them onto the
/// plan's 400 `error_code`s: EMPTY_METHODS, EMPTY_MODELS, INVALID_AT_A_TIME,
/// INVALID_DECISION_DAY, INVALID_LOOK_AHEAD, INVALID_MODEL_ASSET).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxrRequestErrorCode {
    EmptyMethods,
    EmptyModels,
    InvalidAtATime,
    InvalidDecisionDay,
    InvalidLookAhead,
    InvalidModelAsset,
}

impl TxrRequestErrorCode {
    /// The stable machine code.
    pub fn code(self) -> &'static str {
        match self {
            TxrRequestErrorCode::EmptyMethods => "EMPTY_METHODS",
            TxrRequestErrorCode::EmptyModels => "EMPTY_MODELS",
            TxrRequestErrorCode::InvalidAtATime => "INVALID_AT_A_TIME",
            TxrRequestErrorCode::InvalidDecisionDay => "INVALID_DECISION_DAY",
            TxrRequestErrorCode::InvalidLookAhead => "INVALID_LOOK_AHEAD",
            TxrRequestErrorCode::InvalidModelAsset => "INVALID_MODEL_ASSET",
        }
    }
}

/// One create-request validation failure (named field — the routes' 400 body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxrRequestError {
    pub code: TxrRequestErrorCode,
    /// The offending field path, e.g. `model_ids[0].host_dir`.
    pub field: String,
    pub message: String,
}

impl std::fmt::Display for TxrRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: {} ({})",
            self.code.code(),
            self.message,
            self.field
        )
    }
}

impl std::error::Error for TxrRequestError {}

/// A 64-hex sha256 digest (the verify-before-bind tree digest — CONS-EE-6).
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

impl CreateRunRequest {
    /// The create-request validation rules (in check order — the first
    /// failure is the named 400):
    /// - train mode needs ≥ 1 method id (`EMPTY_METHODS`);
    /// - reuse mode needs ≥ 1 resolved asset (`EMPTY_MODELS`);
    /// - `at_a_time` must be within [`TxrLimits::AT_A_TIME_MIN`]..=
    ///   [`TxrLimits::AT_A_TIME_MAX`] (`INVALID_AT_A_TIME` — the F board's
    ///   lane count is a typed gate, never silently clamped);
    /// - `decision_day` > 0 (`INVALID_DECISION_DAY`);
    /// - `look_ahead_day` ≤ [`TxrLimits::LOOK_AHEAD_DAY_MAX`] and strictly
    ///   greater than `decision_day` (`INVALID_LOOK_AHEAD`);
    /// - every model asset carries a non-empty `host_dir`, a 64-hex
    ///   `tree_sha256` and a non-empty `method_id` (`INVALID_MODEL_ASSET` with
    ///   the named field path).
    pub fn validate(&self) -> Result<(), TxrRequestError> {
        match self.mode {
            TxrRunMode::Train if self.method_ids.is_empty() => {
                return Err(TxrRequestError {
                    code: TxrRequestErrorCode::EmptyMethods,
                    field: "method_ids".to_string(),
                    message: "train mode needs at least one method id".to_string(),
                });
            }
            TxrRunMode::Reuse if self.model_ids.is_empty() => {
                return Err(TxrRequestError {
                    code: TxrRequestErrorCode::EmptyModels,
                    field: "model_ids".to_string(),
                    message: "reuse mode needs at least one resolved model asset".to_string(),
                });
            }
            _ => {}
        }

        if self.config.at_a_time < TxrLimits::AT_A_TIME_MIN
            || self.config.at_a_time > TxrLimits::AT_A_TIME_MAX
        {
            return Err(TxrRequestError {
                code: TxrRequestErrorCode::InvalidAtATime,
                field: "at_a_time".to_string(),
                message: format!(
                    "at_a_time must be within {}..={}, got {}",
                    TxrLimits::AT_A_TIME_MIN,
                    TxrLimits::AT_A_TIME_MAX,
                    self.config.at_a_time
                ),
            });
        }

        if !(self.config.decision_day > 0.0) {
            return Err(TxrRequestError {
                code: TxrRequestErrorCode::InvalidDecisionDay,
                field: "decision_day".to_string(),
                message: format!("decision_day must be > 0, got {}", self.config.decision_day),
            });
        }

        if self.config.look_ahead_day > TxrLimits::LOOK_AHEAD_DAY_MAX
            || self.config.look_ahead_day <= self.config.decision_day
        {
            return Err(TxrRequestError {
                code: TxrRequestErrorCode::InvalidLookAhead,
                field: "look_ahead_day".to_string(),
                message: format!(
                    "look_ahead_day must be in ({decision_day}, {max}], got {}",
                    self.config.look_ahead_day,
                    decision_day = self.config.decision_day,
                    max = TxrLimits::LOOK_AHEAD_DAY_MAX
                ),
            });
        }

        for (i, asset) in self.model_ids.iter().enumerate() {
            if asset.host_dir.trim().is_empty() {
                return Err(TxrRequestError {
                    code: TxrRequestErrorCode::InvalidModelAsset,
                    field: format!("model_ids[{i}].host_dir"),
                    message: "host_dir must not be empty".to_string(),
                });
            }
            if !is_sha256_hex(&asset.tree_sha256) {
                return Err(TxrRequestError {
                    code: TxrRequestErrorCode::InvalidModelAsset,
                    field: format!("model_ids[{i}].tree_sha256"),
                    message: "tree_sha256 must be a 64-hex sha256 digest".to_string(),
                });
            }
            if asset.method_id.trim().is_empty() {
                return Err(TxrRequestError {
                    code: TxrRequestErrorCode::InvalidModelAsset,
                    field: format!("model_ids[{i}].method_id"),
                    message: "method_id must not be empty".to_string(),
                });
            }
        }

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the contract pins (the wire spelling of every closed vocabulary,
// the SSE names, the serde defaults and the validation rules; TEST-EE-02 /
// TEST-EE-03)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sample_table() -> ParsedTable {
        ParsedTable {
            source: crate::modules::file_validator::types::ParsedTableSource {
                name: "measurements.csv".to_string(),
                format: crate::modules::file_validator::types::TableFormat::Csv,
            },
            header_row: 1,
            columns: vec!["patient_id".to_string(), "day".to_string()],
            rows: Vec::new(),
        }
    }

    fn sample_input() -> TxrRunInput {
        TxrRunInput {
            patients: None,
            measurements: sample_table(),
            predict_measurements: None,
            joins: Vec::new(),
            mapping: Vec::new(),
            keep_copies: true,
        }
    }

    fn valid_asset() -> TxrModelAsset {
        TxrModelAsset {
            model_id: "m-1".to_string(),
            host_dir: "/data/models/m-1".to_string(),
            tree_sha256: "a".repeat(64),
            method_id: "landmark-cox-current".to_string(),
            method_version: "2.0.1".to_string(),
            env: TxrMethodEnv {
                base_digest: "b".repeat(64),
                layer_digest: "c".repeat(64),
            },
            contract: "2.0".to_string(),
        }
    }

    fn sample_request(mode: TxrRunMode) -> CreateRunRequest {
        CreateRunRequest {
            mode,
            input: sample_input(),
            config: RunConfig::default(),
            method_ids: vec!["landmark-cox-current".to_string()],
            model_ids: Vec::new(),
        }
    }

    /// TEST-EE-02: the closed vocabularies serialize to the plan's snake_case
    /// wire spellings (INV-2: states are data the screens switch on).
    #[test]
    fn wire_spellings_are_the_plan_vocabulary() {
        assert_eq!(
            serde_json::to_value(TxrMethodState::Downloading).unwrap(),
            json!("downloading")
        );
        assert_eq!(
            serde_json::to_value(TxrMethodState::CannotRun).unwrap(),
            json!("cannot_run")
        );
        assert_eq!(
            serde_json::to_value(TxrMethodState::Skipped).unwrap(),
            json!("skipped")
        );
        assert_eq!(
            serde_json::to_value(TxrProbSource::Recalibrated).unwrap(),
            json!("recalibrated")
        );
        assert_eq!(serde_json::to_value(TxrTask::Response).unwrap(), json!("response"));
        assert_eq!(
            serde_json::to_value(TxrRunStatus::Finishing).unwrap(),
            json!("finishing")
        );
        assert_eq!(serde_json::to_value(TxrPhase::Predict).unwrap(), json!("predict"));
        assert_eq!(serde_json::to_value(TxrLogStream::Engine).unwrap(), json!("engine"));
        assert_eq!(serde_json::to_value(TxrRunMode::Reuse).unwrap(), json!("reuse"));
        assert_eq!(serde_json::to_value(TxrEndpoint::Os).unwrap(), json!("os"));
        // The engine reason codes are the plan's SCREAMING_SNAKE_CASE strings.
        assert_eq!(
            serde_json::to_value(EngineReasonCode::JobTimeout).unwrap(),
            json!("JOB_TIMEOUT")
        );
        assert_eq!(
            serde_json::to_value(EngineReasonCode::RecalibrationFailed).unwrap(),
            json!("RECALIBRATION_FAILED")
        );
        assert_eq!(EngineReasonCode::ALL.len(), 10);
        assert_eq!(
            EngineReasonCode::ALL.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
            vec![
                "ENV_UNREADY",
                "ENV_UNKNOWN",
                "ENV_VERIFY_FAILED",
                "SANDBOX_UNAVAILABLE",
                "JOB_TIMEOUT",
                "MODEL_VERIFY_FAILED",
                "ABORTED",
                "INTERRUPTED",
                "PREDICTION_INVALID",
                "RECALIBRATION_FAILED",
            ]
        );
    }

    /// TEST-EE-02: the SSE enum emits the plan's camelCase event names (the
    /// stream's event: field — `sse_event_enum!` shape).
    #[test]
    fn sse_event_names_are_camel_case() {
        let status = TxrRunEvent::Status(TxrRunStatusFrame {
            status: "running".to_string(),
        });
        assert_eq!(status.event_name(), "status");
        assert!(status.data().unwrap().contains("\"status\":\"running\""));

        let method = TxrRunEvent::Method(TxrRunMethodFrame {
            method_id: "dynforest".to_string(),
            state: "downloading".to_string(),
            reason_code: None,
            phase: Some("env".to_string()),
            bytes_downloaded: 160,
            bytes_total: Some(250),
            elapsed_secs: None,
        });
        assert_eq!(method.event_name(), "method");
        // The event NAME is camelCase (`method`); the frame PAYLOAD's fields
        // are the plan's snake_case spellings (`method_id`,
        // `bytes_downloaded`), exactly the jobs/sse.rs frame convention.
        let data = method.data().unwrap();
        assert!(data.contains("\"method_id\":\"dynforest\""));
        assert!(data.contains("\"bytes_downloaded\":160"));

        let log = TxrRunEvent::Log(TxrRunLogLine {
            seq: 1,
            method_id: None,
            stream: TxrLogStream::Engine,
            content: "starting".to_string(),
            created_at: Utc::now(),
        });
        assert_eq!(log.event_name(), "log");

        let progress = TxrRunEvent::Progress(TxrRunProgressFrame {
            method_id: "dynforest".to_string(),
            phase: Some("fit".to_string()),
            pct: Some(40.0),
            message: Some("fit started".to_string()),
        });
        assert_eq!(progress.event_name(), "progress");

        let prediction = TxrRunEvent::Prediction(TxrRunPredictionFrame {
            method_id: "dynforest".to_string(),
            prob_source: "native".to_string(),
            coverage_fraction: 0.795,
            scored: 120,
            eligible: 151,
        });
        assert_eq!(prediction.event_name(), "prediction");
        assert!(prediction
            .data()
            .unwrap()
            .contains("\"coverage_fraction\":0.795"));
    }

    /// TEST-EE-02: the route doc ids are exactly the plan's 15
    /// `Txr.*` operation ids (the generated client surface's identity).
    #[test]
    fn route_doc_ids_are_the_plan_set() {
        assert_eq!(ROUTE_DOC_IDS.len(), 15);
        assert_eq!(ROUTE_DOC_IDS[0], "Txr.createRun");
        assert_eq!(ROUTE_DOC_IDS[3], "Txr.streamRun");
        assert_eq!(ROUTE_DOC_IDS[14], "Txr.updateAnalysisConfig");
    }

    /// TEST-EE-02: the wire defaults — a partial `RunConfig` and a partial
    /// `TxrRunInput` deserialize to the documented defaults (PROV-EE-2).
    #[test]
    fn serde_defaults_are_the_plan_values() {
        let cfg: RunConfig = serde_json::from_value(json!({})).unwrap();
        assert_eq!(cfg.endpoint, TxrEndpoint::Pfs);
        assert_eq!(cfg.decision_day, DEFAULT_DECISION_DAY);
        assert_eq!(cfg.look_ahead_day, DEFAULT_LOOK_AHEAD_DAY);
        assert!(!cfg.covariates);
        assert_eq!(cfg.at_a_time, DEFAULT_AT_A_TIME);
        assert_eq!(cfg.cpus, None);
        assert!(!cfg.save_models);
        assert_eq!(cfg.label_day, None);

        let input: TxrRunInput = serde_json::from_value(json!({
            "measurements": {
                "source": {"name": "measurements.csv", "format": "csv"},
                "header_row": 1,
                "columns": ["patient_id"],
                "rows": []
            }
        }))
        .unwrap();
        assert!(input.keep_copies, "the K-board copy-kept default is true");
        assert!(input.joins.is_empty());
        assert!(input.predict_measurements.is_none());
    }

    /// TEST-EE-02: a complete summary serializes to the plan's field names
    /// (the K surface's record) and the detail flattens the summary.
    #[test]
    fn summary_and_detail_wire_shapes() {
        let summary = TxrRunSummary {
            id: Uuid::nil(),
            status: TxrRunStatus::Running,
            mode: TxrRunMode::Train,
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            elapsed_secs: Some(12),
            config: RunConfig::default(),
            method_ids: vec!["dynforest".to_string()],
            model_ids: Vec::new(),
            counts: TxrRunCounts {
                finished: 1,
                failed: 0,
                stopped: 0,
                skipped: 0,
                cannot_run: 1,
                running: 1,
                downloading: 0,
                waiting: 0,
            },
            predictions_ready: false,
            dir: "/data/analysis-2026-10-26-1002-abc12345".to_string(),
            input_summary: TxrRunInputSummary {
                patients: Some(151),
                predict_patients: None,
                markers: 5,
                events: Some(62),
                file_names: TxrRunFileNames {
                    patients: Some("patients.csv".to_string()),
                    measurements: "measurements.csv".to_string(),
                    predict_measurements: None,
                },
            },
        };
        let v = serde_json::to_value(&summary).unwrap();
        assert_eq!(v["counts"]["waiting"], json!(0));
        assert_eq!(v["input_summary"]["file_names"]["measurements"], json!("measurements.csv"));

        let detail = TxrRunDetail {
            summary,
            methods: Vec::new(),
            models: Vec::new(),
            log_lines: 3,
            estimate: TxrRunEstimate {
                total_seconds: 840.0,
                schedule_seconds: 300.0,
                estimate_quality: TimingQuality::Estimate,
            },
            cpus: 4,
            memory_total_bytes: None,
            outcome: TxrRunOutcome {
                endpoint: TxrEndpoint::Pfs,
                horizon: 238.0,
                task_is_mixed: false,
            },
        };
        let dv = serde_json::to_value(&detail).unwrap();
        // Flattened: the summary's fields sit on the detail object.
        assert_eq!(dv["status"], json!("running"));
        assert_eq!(dv["methods"], json!([]));
        assert_eq!(dv["estimate"]["schedule_seconds"], json!(300.0));
        assert_eq!(dv["outcome"]["horizon"], json!(238.0));
        // The reason seam carries {code, detail} strings.
        let reason = TxrRunReason::from_engine(EngineReasonCode::Aborted, "stopped by the user");
        let rv = serde_json::to_value(&reason).unwrap();
        assert_eq!(rv, json!({"code": "ABORTED", "detail": "stopped by the user"}));
        let catalogue_reason = TxrRunReason::from_catalogue(
            ReasonCode::MinDrawsUnmet,
            "fewer than 3 draws by day 56",
        );
        assert_eq!(
            serde_json::to_value(catalogue_reason).unwrap()["code"],
            json!("MIN_DRAWS_UNMET")
        );
    }

    // ── TEST-EE-03: the create-request validation rules ───────────────────

    #[test]
    fn rejects_unknown_mode() {
        // A mode outside {train, reuse} cannot construct the request — the
        // 400 INVALID_MODE condition is the typed-enum parse refusal (the
        // file_validator precedent).
        let mut v = serde_json::to_value(sample_request(TxrRunMode::Train)).unwrap();
        v["mode"] = json!("rename-my-mode");
        let err = serde_json::from_value::<CreateRunRequest>(v).unwrap_err();
        assert!(err.to_string().contains("unknown variant"));
    }

    #[test]
    fn rejects_empty_methods_in_train_mode() {
        let mut req = sample_request(TxrRunMode::Train);
        req.method_ids.clear();
        let err = req.validate().unwrap_err();
        assert_eq!(err.code, TxrRequestErrorCode::EmptyMethods);
        assert_eq!(err.field, "method_ids");
        assert_eq!(err.code.code(), "EMPTY_METHODS");
    }

    #[test]
    fn rejects_empty_models_in_reuse_mode() {
        let req = sample_request(TxrRunMode::Reuse);
        let err = req.validate().unwrap_err();
        assert_eq!(err.code, TxrRequestErrorCode::EmptyModels);
        assert_eq!(err.field, "model_ids");
    }

    #[test]
    fn at_a_time_is_gated_never_silently_clamped() {
        for bad in [0, 9, 100] {
            let mut req = sample_request(TxrRunMode::Train);
            req.config.at_a_time = bad;
            let err = req.validate().unwrap_err();
            assert_eq!(err.code, TxrRequestErrorCode::InvalidAtATime, "at_a_time {bad}");
            assert_eq!(err.field, "at_a_time");
        }
        for good in [TxrLimits::AT_A_TIME_MIN, 3, TxrLimits::AT_A_TIME_MAX] {
            let mut req = sample_request(TxrRunMode::Train);
            req.config.at_a_time = good;
            assert!(req.validate().is_ok(), "at_a_time {good} must be accepted");
        }
    }

    #[test]
    fn decision_day_must_be_positive() {
        for bad in [0.0, -5.0] {
            let mut req = sample_request(TxrRunMode::Train);
            req.config.decision_day = bad;
            let err = req.validate().unwrap_err();
            assert_eq!(err.code, TxrRequestErrorCode::InvalidDecisionDay);
            assert_eq!(err.field, "decision_day");
        }
        let mut req = sample_request(TxrRunMode::Train);
        req.config.decision_day = 56.0;
        assert!(req.validate().is_ok());
    }

    #[test]
    fn look_ahead_is_bounded_and_after_decision_day() {
        for (decision, horizon) in [(56.0, 731.0), (56.0, 56.0), (56.0, 1.0)] {
            let mut req = sample_request(TxrRunMode::Train);
            req.config.decision_day = decision;
            req.config.look_ahead_day = horizon;
            let err = req.validate().unwrap_err();
            assert_eq!(err.code, TxrRequestErrorCode::InvalidLookAhead);
            assert_eq!(err.field, "look_ahead_day");
        }
        let mut req = sample_request(TxrRunMode::Train);
        req.config.decision_day = 56.0;
        req.config.look_ahead_day = 238.0;
        assert!(req.validate().is_ok());
        req.config.look_ahead_day = 730.0;
        assert!(req.validate().is_ok(), "the ceiling itself is allowed");
    }

    #[test]
    fn model_assets_are_refused_with_a_named_field() {
        let mut req = sample_request(TxrRunMode::Reuse);
        req.model_ids = vec![valid_asset()];
        assert!(req.validate().is_ok());

        let mut missing_dir = valid_asset();
        missing_dir.host_dir = "   ".to_string();
        req.model_ids = vec![missing_dir];
        let err = req.validate().unwrap_err();
        assert_eq!(err.code, TxrRequestErrorCode::InvalidModelAsset);
        assert_eq!(err.field, "model_ids[0].host_dir");

        let mut bad_sha = valid_asset();
        bad_sha.tree_sha256 = "not-a-digest".to_string();
        req.model_ids = vec![bad_sha];
        let err = req.validate().unwrap_err();
        assert_eq!(err.field, "model_ids[0].tree_sha256");

        let mut bad_method = valid_asset();
        bad_method.method_id.clear();
        req.model_ids = vec![bad_method];
        let err = req.validate().unwrap_err();
        assert_eq!(err.field, "model_ids[0].method_id");

        // The second asset's failure names ITS index.
        req.model_ids = vec![valid_asset(), valid_asset()];
        req.model_ids[1].tree_sha256 = "zz".to_string();
        let err = req.validate().unwrap_err();
        assert_eq!(err.field, "model_ids[1].tree_sha256");
    }

    #[test]
    fn sha256_hex_gate() {
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(is_sha256_hex(&"0123456789abcdef".repeat(4)));
        assert!(!is_sha256_hex(&"a".repeat(63)));
        assert!(!is_sha256_hex(&"g".repeat(64)));
        assert!(!is_sha256_hex("A"));
        // Uppercase hex is a digest too (the gate is not case-bound): 64 hex
        // chars in either case.
        let mixed: String = "AbCdEf".repeat(9) + "0123456789";
        assert_eq!(mixed.len(), 64);
        assert!(is_sha256_hex(&mixed));
    }
}
