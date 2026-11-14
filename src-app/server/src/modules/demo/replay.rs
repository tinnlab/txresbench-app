//! The demo runner (demo-mode ITEM-3): the bundle-backed replay of recorded
//! runs.
//!
//! ## What this module owns
//!
//! In demo mode `POST /api/txr/runs` does NOT start the engine: it creates a
//! NORMAL run record (the same `txr_runs` / `txr_run_methods` /
//! `txr_run_logs` rows the engine writes) and fills it from the recorded
//! bundle — the per-method chance columns, the measured seconds, the log
//! lines, the saved-model facts — then REPLAYS the states over time
//! (`waiting -> running -> finished` per method, durations = recorded seconds
//! / `demo.replay_speed`, minimum 1.5 s each, the recorded log lines
//! streamed with plausible timestamps). Stop, skip, at-a-time and rerun act
//! on the replay; a stopped method stays stopped; a replay interrupted by a
//! server restart is finished at the next boot (no run stays "running"
//! forever). Predictions JSON + CSV, compare and method pages read the cloned
//! rows — no sandbox, no environment download, no method code is ever
//! started.
//!
//! ## The replay marker
//!
//! Each demo run dir carries [`REPLAY_FILE`] (`demo-replay.json`, format
//! [`REPLAY_FORMAT_TAG`] v1: run id + the recorded configuration id + the run
//! mode). It is the ONE marker a demo run leaves behind:
//!
//! * the execution engine's boot reconcile skips a run that carries it (the
//!   demo's own boot sweep owns those runs — the ITEM-3 restart rule);
//! * the demo's boot sweep finishes every non-terminal demo run immediately
//!   (the recorded seconds are already known, so "resumes" is a fast-
//!   forward: the remaining methods get their recorded facts and the run
//!   turns `finished` in one pass — the plan's "resumes or finishes");
//! * `models/save` recognises a demo run (a save of a demo run reads the
//!   bundle's model metadata — [`super::models`]).
//!
//! ## The replay cadence
//!
//! One run at a time (the app's `RUN_ALREADY_ACTIVE` rule: a second create
//! while a replay is live is a 409, exactly like the engine's). The replay
//! runs the methods in request order, one after the other: each waits a short
//! lead, runs for `max(recorded_seconds / replay_speed, 1.5)` seconds
//! (streaming its recorded log lines across the window), then finishes with
//! the bundle's column facts. `at_a_time` is stored and replaces the run's
//! estimate — the lane control acts on the replay's *estimate*, the only
//! compute fact a recorded run has (DRIFT-1 ITEM-3).
//!
//! ## The created run's facts
//!
//! The run row is the engine's own: status transitions preparing -> running
//! -> finished, counts JSON kept consistent, predictions-ready flag set at
//! finish, `dir` under the normal run tree. Method rows carry the recorded
//! column facts (`task` / `prob_source` / coverage) at finish, and the
//! produced-model facts (digest, dir, size, trained-on, auc) when the
//! recorded run saved a model — so the run detail, the heatmap, the CSV
//! download and the save-models dialog read the same rows the engine writes.
//!
//! ## The outside-the-bundle 400
//!
//! A requested method (train) or model (reuse) with no recorded results for
//! the requested configuration answers a plain 400 (the message names the
//! method/model and setup); an unrecorded configuration is 400 the same way.
//! A non-example table is 403 DEMO_MODE (the same class as the
//! inspect/validate guard — the demo accepts the recorded example tables
//! only).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::watch;
use uuid::Uuid;

use txresbench_core::AppError;

use super::bundle::{BundleConfiguration, BundleModel, DemoBundle};
use crate::modules::execution_engine::envmanifest;
use crate::modules::execution_engine::orchestrator;
use crate::modules::execution_engine::repository::{
    MethodPatch, NewMethod, NewRun, TxrRepository,
};
use crate::modules::execution_engine::runtime::RunRuntime;
use crate::modules::execution_engine::types::{
    CreateRunRequest, EngineReasonCode, RunConfig, TxrEndpoint, TxrLogStream, TxrMethodState,
    TxrPhase, TxrProbSource, TxrRunCounts, TxrRunEstimate, TxrRunEvent, TxrRunInputSummary,
    TxrRunMethodFrame, TxrRunMode, TxrRunPredictionFrame, TxrRunReason, TxrRunStatus,
    TxrRunStatusFrame, TxrRunSummary, TxrTask, TxrLimits,
};

/// The replay marker file name (also the reconcile-skip + boot-sweep key).
pub const REPLAY_FILE: &str = "demo-replay.json";

/// The marker's format tag.
pub const REPLAY_FORMAT_TAG: &str = "txresbench-demo-replay";

/// The marker format version.
pub const REPLAY_VERSION: u32 = 1;

/// The shortest one-method replay window (the plan's minimum 1.5 s).
pub const MIN_METHOD_SECONDS: f64 = 1.5;

/// The lead-in before the run turns `running` (the "preparing" beat).
pub const RUN_PREP_SECONDS: f64 = 0.4;

/// The lead each method stays `waiting` before it turns `running`.
pub const METHOD_LEAD_SECONDS: f64 = 0.3;

/// The count shape (the struct has no Default — the engine always writes an
/// explicit aggregate).
fn empty_counts() -> TxrRunCounts {
    TxrRunCounts {
        finished: 0,
        failed: 0,
        stopped: 0,
        skipped: 0,
        cannot_run: 0,
        running: 0,
        downloading: 0,
        waiting: 0,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The replay marker (persisted)
// ─────────────────────────────────────────────────────────────────────────────

/// The persisted replay marker (`demo-replay.json`): the minimal fact set
/// that identifies a demo run after a restart. The per-method schedule lives
/// in process memory; the boot sweep re-derives it from the bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayMarker {
    /// Exactly [`REPLAY_FORMAT_TAG`].
    pub format: String,
    /// Exactly [`REPLAY_VERSION`].
    pub version: u32,
    pub run_id: Uuid,
    /// The recorded configuration the run replays.
    pub configuration_id: String,
    pub mode: TxrRunMode,
}

/// Is the run dir a demo replay run (the marker exists)?
pub fn is_demo_run(dir: &Path) -> bool {
    dir.join(REPLAY_FILE).exists()
}

/// The run row is a demo replay (the marker in its dir).
pub(crate) fn is_demo_run_row(row: &crate::modules::execution_engine::repository::RunRow) -> bool {
    is_demo_run(Path::new(&row.dir))
}

fn read_marker(dir: &Path) -> Option<ReplayMarker> {
    let text = std::fs::read_to_string(dir.join(REPLAY_FILE)).ok()?;
    let marker: ReplayMarker = serde_json::from_str(&text).ok()?;
    if marker.format != REPLAY_FORMAT_TAG || marker.version != REPLAY_VERSION {
        return None;
    }
    Some(marker)
}

fn write_marker(dir: &Path, marker: &ReplayMarker) -> Result<(), AppError> {
    let mut text = serde_json::to_string_pretty(marker)
        .map_err(|e| AppError::internal_error(format!("demo replay marker: {e}")))?;
    text.push('\n');
    std::fs::write(dir.join(REPLAY_FILE), text)
        .map_err(|e| AppError::internal_error(format!("write {REPLAY_FILE}: {e}")))
}

// ─────────────────────────────────────────────────────────────────────────────
// The replay registry + per-method control
// ─────────────────────────────────────────────────────────────────────────────

/// Per-run replay state (the live half): the per-method phase the skip/stop
/// arms flip at request time, read by the driving task at its next tick. The
/// run-level stop travels through the runtime's cancel registry (the same
/// channel the engine's stop route signals).
struct ReplayCtl {
    run_id: Uuid,
    /// phase per ROW method id: waiting | running | finished | skipped |
    /// stopped.
    phases: Mutex<HashMap<String, u8>>,
}

const PHASE_WAITING: u8 = 0;
const PHASE_RUNNING: u8 = 1;
const PHASE_FINISHED: u8 = 2;
const PHASE_SKIPPED: u8 = 3;
const PHASE_STOPPED: u8 = 4;

impl ReplayCtl {
    fn new(run_id: Uuid, method_ids: &[String]) -> Arc<Self> {
        let mut phases = HashMap::new();
        for id in method_ids {
            phases.insert(id.clone(), PHASE_WAITING);
        }
        Arc::new(Self {
            run_id,
            phases: Mutex::new(phases),
        })
    }

    fn phase(&self, method_id: &str) -> u8 {
        self.phases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(method_id)
            .copied()
            .unwrap_or(PHASE_WAITING)
    }

    fn set_phase(&self, method_id: &str, phase: u8) {
        self.phases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(method_id.to_string(), phase);
    }
}

/// The live replays (per process). One run at a time, like the engine.
static REPLAYS: OnceLock<Mutex<HashMap<Uuid, Arc<ReplayCtl>>>> = OnceLock::new();

fn replays() -> &'static Mutex<HashMap<Uuid, Arc<ReplayCtl>>> {
    REPLAYS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_replay(ctl: Arc<ReplayCtl>) {
    replays()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(ctl.run_id, ctl);
}

fn unregister_replay(run_id: Uuid) {
    replays()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
}

fn replay_for(run_id: Uuid) -> Option<Arc<ReplayCtl>> {
    replays()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&run_id)
        .cloned()
}

// ─────────────────────────────────────────────────────────────────────────────
// The recorded-facts helpers
// ─────────────────────────────────────────────────────────────────────────────

/// The configuration whose (endpoint, decision day, look ahead, covariates)
/// equal the request's — the recorded configurations are the ONLY ones the
/// demo replays (the plan's "settings offer only recorded configurations").
pub fn match_configuration<'a>(
    bundle: &'a DemoBundle,
    config: &RunConfig,
) -> Result<&'a BundleConfiguration, AppError> {
    for cfg in &bundle.configurations {
        if (cfg.endpoint == config.endpoint)
            && (cfg.decision_day - config.decision_day).abs() < 1e-9
            && (cfg.look_ahead_day - config.look_ahead_day).abs() < 1e-9
            && cfg.covariates == config.covariates
        {
            return Ok(cfg);
        }
    }
    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        "DEMO_CONFIG_UNRECORDED",
        format!(
            "this configuration ({} at day {} / look ahead {}, covariates {}) was not \
             recorded in the demo — the demo replays the recorded example setup only",
            endpoint_wire(config.endpoint),
            config.decision_day,
            config.look_ahead_day,
            config.covariates
        ),
    ))
}

/// The bundle's record for (method, configuration) — None when the method has
/// no recorded results for that configuration.
pub fn method_record<'b>(
    bundle: &'b DemoBundle,
    config_id: &str,
    method_id: &str,
) -> Option<&'b super::bundle::BundleMethodRecord> {
    bundle
        .methods
        .iter()
        .find(|m| m.method_id == method_id)
        .and_then(|m| m.records.iter().find(|r| r.configuration_id == config_id))
}

/// The replayed duration of one recorded method: recorded seconds divided by
/// the replay speed, minimum [`MIN_METHOD_SECONDS`].
pub fn replay_seconds(recorded: f64, replay_speed: f64) -> f64 {
    // A non-finite or non-positive speed is a config error — replay at the
    // recorded speed (1x), never a divide-by-zero that would hang the demo.
    let speed = if replay_speed.is_finite() && replay_speed > 0.0 {
        replay_speed
    } else {
        1.0
    };
    (recorded / speed).max(MIN_METHOD_SECONDS)
}

/// The LPT schedule total over `lanes` lanes (the estimate endpoint's
/// "run N at a time" bar): greedy longest-processing-time, the makespan.
pub fn lpt_schedule_seconds(seconds: &[f64], lanes: usize) -> f64 {
    if seconds.is_empty() {
        return 0.0;
    }
    let lanes = lanes.max(1);
    let mut sorted: Vec<f64> = seconds.to_vec();
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let mut loads = vec![0.0f64; lanes];
    for s in sorted {
        let mut min = 0;
        for (i, load) in loads.iter().enumerate() {
            if *load < loads[min] {
                min = i;
            }
        }
        loads[min] += s;
    }
    loads.into_iter().fold(0.0f64, f64::max)
}

/// The recorded env provenance of a catalogue method (the manifest's digest
/// pins — the same facts a real run records; the demo run never downloaded
/// them, so the row carries the RECORDED digests, never a fabricated
/// download).
fn recorded_env_digests(method_id: &str) -> (String, String) {
    match envmanifest::env_for(method_id) {
        Some(entry) => (entry.base_digest.clone(), entry.layer_sha256.clone()),
        None => ("recorded".to_string(), "recorded".to_string()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The prepared replay (one run's schedule, in memory only)
// ─────────────────────────────────────────────────────────────────────────────

/// One method's replay step.
#[derive(Debug)]
struct ReplayStep {
    /// The method row's id (catalogue id in train mode, the saved-model id in
    /// reuse mode — the engine's own row identity).
    pub method_id: String,
    /// The bundle's catalogue method id (the recorded column + model lookup).
    pub outcome_method_id: String,
    pub label: String,
    pub version: String,
    pub group: String,
    pub task: TxrTask,
    pub prob_source: TxrProbSource,
    pub scored: u32,
    pub eligible: u32,
    /// The replayed window (recorded seconds / replay speed, min 1.5 s).
    pub replay_seconds: f64,
    /// The recorded model facts (`None` for a method without a model — the
    /// model-backed seams then do not offer it, or for a reuse row).
    pub model: Option<BundleModel>,
    /// The stub model tree (written at create when `model` is Some).
    pub model_tree: Option<PathBuf>,
    pub model_digest: Option<String>,
}

/// The run-level facts. `run_id`/`dir`/`mode`/`replay_speed` are the plan's
/// identity (kept for the drive's own diagnostics and the retained run tree
/// facts — the plan is the ONE object a demo run's life is derived from).
#[allow(dead_code)]
struct ReplayPlan {
    pub run_id: Uuid,
    pub dir: PathBuf,
    pub config_id: String,
    pub config: RunConfig,
    pub mode: TxrRunMode,
    pub steps: Vec<ReplayStep>,
    pub replay_speed: f64,
}

// ─────────────────────────────────────────────────────────────────────────────
// The 400/404/409 vocabulary (the engine's own)
// ─────────────────────────────────────────────────────────────────────────────

/// The endpoint's wire spelling (the serde rename; `TxrEndpoint` has no
/// `as_str` — this is the app's own helper, the wire string is the engine's).
pub fn endpoint_wire(endpoint: TxrEndpoint) -> &'static str {
    match endpoint {
        TxrEndpoint::Pfs => "pfs",
        TxrEndpoint::Os => "os",
    }
}

fn run_not_found(run_id: Uuid) -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "RUN_NOT_FOUND",
        format!("no run {run_id}"),
    )
}

fn method_not_found(run_id: Uuid, method_id: &str) -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "METHOD_NOT_FOUND",
        format!("method {method_id:?} is not part of run {run_id}"),
    )
}

fn method_not_active(run_id: Uuid, method_id: &str, state: &str) -> AppError {
    AppError::new(
        StatusCode::CONFLICT,
        "METHOD_NOT_ACTIVE",
        format!("method {method_id:?} of run {run_id} is already {state}"),
    )
}

fn method_not_skippable(run_id: Uuid, method_id: &str, state: &str) -> AppError {
    AppError::new(
        StatusCode::CONFLICT,
        "METHOD_NOT_SKIPPABLE",
        format!("method {method_id:?} of run {run_id} is {state}"),
    )
}

fn run_not_active(run_id: Uuid, state: &str) -> AppError {
    AppError::new(
        StatusCode::CONFLICT,
        "RUN_NOT_ACTIVE",
        format!("run {run_id} is already {state}"),
    )
}

fn demo_400(message: impl Into<String>) -> AppError {
    AppError::new(StatusCode::BAD_REQUEST, "DEMO_UNRECORDED", message)
}

// ─────────────────────────────────────────────────────────────────────────────
// create_replay / rerun_replay
// ─────────────────────────────────────────────────────────────────────────────

pub fn replay_speed() -> f64 {
    super::state()
        .map(|s| s.replay_speed)
        .unwrap_or(10.0)
        .max(0.01)
}

/// `POST /api/txr/runs` in demo mode: validate against the bundle, create the
/// normal run record, stage the cloned rows/files and start the replay.
pub async fn create_replay(
    pool: SqlitePool,
    runtime: Arc<RunRuntime>,
    req: CreateRunRequest,
) -> Result<TxrRunSummary, AppError> {
    req.validate()
        .map_err(orchestrator::request_error_to_app)?;
    let bundle = super::bundle().ok_or_else(|| {
        AppError::internal_error("a demo run was requested outside demo mode")
    })?;
    let config = match_configuration(bundle, &req.config)?;
    table_guard_ok(bundle, &req)?;
    if let Some(active) = TxrRepository::new(pool.clone()).active_run().await? {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "RUN_ALREADY_ACTIVE",
            format!("a run is already active: {active}"),
        ));
    }
    let now = Utc::now();
    let run_id = Uuid::new_v4();
    let plan = stage_replay_run(pool.clone(), run_id, &req, bundle, config, now).await?;
    let repo = TxrRepository::new(pool.clone());
    let ctl = ReplayCtl::new(
        run_id,
        &plan.steps.iter().map(|s| s.method_id.clone()).collect::<Vec<_>>(),
    );
    register_replay(ctl.clone());
    let run_stop = runtime.register_cancel(run_id);
    tokio::spawn(drive_replay(
        pool,
        runtime,
        run_id,
        Arc::new(plan),
        ctl,
        run_stop,
    ));
    repo.get_run_summary(run_id)
        .await?
        .ok_or_else(|| AppError::internal_error("run row vanished after insert"))
}

/// `POST /api/txr/runs/{id}/rerun` in demo mode: clone a run from its
/// persisted input record — the SAME record the engine's rerun reads, so a
/// demo run re-runs the recorded setup.
pub async fn rerun_replay(
    pool: SqlitePool,
    runtime: Arc<RunRuntime>,
    run_id: Uuid,
) -> Result<TxrRunSummary, AppError> {
    let repo = TxrRepository::new(pool.clone());
    let source = repo
        .get_run(run_id)
        .await?
        .ok_or_else(|| run_not_found(run_id))?;
    let record_path = Path::new(&source.dir).join("input").join("run-input.json");
    let bytes = std::fs::read(&record_path).map_err(|e| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            "RUN_INPUT_RECORD_MISSING",
            format!("run {run_id} input record missing: {e}"),
        )
    })?;
    let record: crate::modules::execution_engine::types::RunInputRecord =
        serde_json::from_slice(&bytes).map_err(|e| {
            AppError::new(
                StatusCode::BAD_REQUEST,
                "RUN_INPUT_RECORD_MISSING",
                format!("run {run_id} input record unreadable: {e}"),
            )
        })?;

    let bundle = super::bundle().ok_or_else(|| {
        AppError::internal_error("a demo run was requested outside demo mode")
    })?;
    let config = match_configuration(bundle, &record.config)?;
    let req = CreateRunRequest {
        mode: record.mode,
        input: record.input,
        config: record.config,
        method_ids: record.method_ids,
        model_ids: record.model_ids,
    };
    table_guard_ok(bundle, &req)?;
    if let Some(active) = TxrRepository::new(pool.clone()).active_run().await? {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "RUN_ALREADY_ACTIVE",
            format!("a run is already active: {active}"),
        ));
    }
    let now = Utc::now();
    let new_id = Uuid::new_v4();
    let plan = stage_replay_run(pool.clone(), new_id, &req, bundle, config, now).await?;
    let repo = TxrRepository::new(pool.clone());
    let ctl = ReplayCtl::new(
        new_id,
        &plan.steps.iter().map(|s| s.method_id.clone()).collect::<Vec<_>>(),
    );
    register_replay(ctl.clone());
    let run_stop = runtime.register_cancel(new_id);
    tokio::spawn(drive_replay(
        pool,
        runtime,
        new_id,
        Arc::new(plan),
        ctl,
        run_stop,
    ));
    repo.get_run_summary(new_id)
        .await?
        .ok_or_else(|| AppError::internal_error("run row vanished after insert"))
}

/// The example-table guard of a run request (the same class as the
/// inspect/validate guard: only the recorded example tables are accepted —
/// anything else is 403 DEMO_MODE).
fn table_guard_ok(bundle: &DemoBundle, req: &CreateRunRequest) -> Result<(), AppError> {
    use crate::modules::demo::bundle::parsed_table_hash;
    let hash = |t: &crate::modules::file_validator::types::ParsedTable| parsed_table_hash(t);
    match req.mode {
        TxrRunMode::Train => {
            let Some(patients) = req.input.patients.as_ref() else {
                return Err(demo_400("the demo train run needs the example patients table"));
            };
            if hash(patients) != bundle.tables.patients.content_hash
                || hash(&req.input.measurements) != bundle.tables.measurements.content_hash
            {
                return Err(super::blocked_error());
            }
        }
        TxrRunMode::Reuse => {
            let predict = req
                .input
                .predict_measurements
                .as_ref()
                .unwrap_or(&req.input.measurements);
            if hash(predict) != bundle.tables.predict_measurements.content_hash {
                return Err(super::blocked_error());
            }
        }
    }
    Ok(())
}

/// The input summary of a demo run: the validator's OWN facts over the
/// example tables (the same one-path validation the engine runs) + the
/// captured source names.
fn demo_input_summary(req: &CreateRunRequest, config: &RunConfig) -> Result<TxrRunInputSummary, AppError> {
    let validated = orchestrator::validate_run(&req.input, config, req.mode)?;
    Ok(TxrRunInputSummary {
        patients: validated.patients.as_ref().map(|p| p.rows),
        predict_patients: match req.mode {
            TxrRunMode::Reuse => Some(validated.measurements.patients),
            TxrRunMode::Train => None,
        },
        markers: validated.markers.len() as u32,
        events: validated.patients.as_ref().map(|p| p.primary_outcome_events),
        file_names: crate::modules::execution_engine::types::TxrRunFileNames {
            patients: req.input.patients.as_ref().map(|p| p.source.name.clone()),
            measurements: req.input.measurements.source.name.clone(),
            predict_measurements: req
                .input
                .predict_measurements
                .as_ref()
                .map(|p| p.source.name.clone()),
        },
    })
}

/// Stage one replay run: the run row + the run dir + the input/replay records
/// + the recorded chance columns + the method rows + the stub model trees.
/// Everything is the engine's own row/record shape.
async fn stage_replay_run(
    pool: SqlitePool,
    run_id: Uuid,
    req: &CreateRunRequest,
    bundle: &DemoBundle,
    config: &BundleConfiguration,
    now: DateTime<Utc>,
) -> Result<ReplayPlan, AppError> {
    let repo = TxrRepository::new(pool.clone());
    let run_config = RunConfig {
        endpoint: config.endpoint,
        decision_day: config.decision_day,
        look_ahead_day: config.look_ahead_day,
        covariates: config.covariates,
        at_a_time: req
            .config
            .at_a_time
            .clamp(TxrLimits::AT_A_TIME_MIN, TxrLimits::AT_A_TIME_MAX),
        cpus: None,
        save_models: false,
        label_day: None,
    };
    let input_summary = demo_input_summary(req, &run_config)?;
    let dir = orchestrator::run_dir_root().join(orchestrator::run_dir_name(now, run_id));
    let steps = prepare_steps(bundle, req, config)?;
    let mut plan = ReplayPlan {
        run_id,
        dir: dir.clone(),
        config_id: config.id.clone(),
        config: run_config,
        mode: req.mode,
        replay_speed: replay_speed(),
        steps,
    };

    repo.insert_run(&NewRun {
        id: run_id,
        created_at: Some(now),
        status: TxrRunStatus::Preparing,
        mode: req.mode,
        config: plan.config.clone(),
        input_summary,
        model_ids: req
            .model_ids
            .iter()
            .map(|a| a.model_id.clone())
            .collect(),
        method_count: plan.steps.len() as u32,
        counts: TxrRunCounts {
            waiting: plan.steps.len() as u32,
            ..empty_counts()
        },
        dir: dir.display().to_string(),
        memory_total_bytes: None,
        cpus: Some(orchestrator::detect_cpus()),
        seed: TxrLimits::SEED,
        estimate: demo_estimate(&plan),
    })
    .await?;

    let staged: Result<(), AppError> = async {
        for sub in ["input", "bundles", "output", "logs", "models"] {
            std::fs::create_dir_all(dir.join(sub))
                .map_err(|e| AppError::internal_error(format!("create run subdir: {e}")))?;
        }
        write_run_input_record(&dir, req, &plan.config)?;
        write_marker(
            &dir,
            &ReplayMarker {
                format: REPLAY_FORMAT_TAG.to_string(),
                version: REPLAY_VERSION,
                run_id,
                configuration_id: config.id.clone(),
                mode: req.mode,
            },
        )?;
        // The recorded chance column becomes the engine's own artifact
        // (`output/<row-method-id>/chance.csv`), so the predictions JSON +
        // CSV + compare + method pages read the SAME file path the engine
        // reads (their routes are unchanged).
        for idx in 0..plan.steps.len() {
            let outcome = plan.steps[idx].outcome_method_id.clone();
            let model = plan.steps[idx].model.clone();
            let sid = plan.steps[idx].method_id.clone();
            let record = method_record(bundle, &config.id, &outcome)
                .expect("steps were checked at prepare");
            let column = match req.mode {
                TxrRunMode::Train => &record.train,
                TxrRunMode::Reuse => record.reuse.as_ref().expect("reuse steps checked"),
            };
            let table_bytes = std::fs::read(bundle.bundle_dir.join(&column.table))
                .map_err(|e| {
                    AppError::internal_error(format!(
                        "read recorded table {}: {e}",
                        column.table
                    ))
                })?;
            let out_dir = dir.join("output").join(&sid);
            std::fs::create_dir_all(&out_dir)
                .map_err(|e| AppError::internal_error(format!("create output dir: {e}")))?;
            std::fs::write(out_dir.join("chance.csv"), &table_bytes)
                .map_err(|e| AppError::internal_error(format!("write chance.csv: {e}")))?;

            if req.mode == TxrRunMode::Train {
                if let Some(model) = &model {
                    let tree = dir.join("models").join(&sid);
                    std::fs::create_dir_all(&tree)
                        .map_err(|e| AppError::internal_error(format!("create model tree: {e}")))?;
                    write_stub_model_tree(&tree, model)?;
                    let digest = crate::modules::sandbox::stack::tree_sha256(&tree)
                        .map_err(|e| {
                            AppError::internal_error(format!("model tree digest: {e}"))
                        })?;
                    let staged_step = &mut plan.steps[idx];
                    staged_step.model_tree = Some(tree.clone());
                    staged_step.model_digest = Some(digest);
                }
            }
            // The row is inserted in `waiting` now, exactly like the engine's
            // classification; the recorded facts land at FINISH (the
            // per-method transition writes them).
            let step = &plan.steps[idx];
            repo.insert_method(&NewMethod {
                id: Uuid::new_v4(),
                run_id,
                method_id: step.method_id.clone(),
                label: step.label.clone(),
                version: step.version.clone(),
                group: step.group.clone(),
                state: TxrMethodState::Waiting,
                bytes_total: None,
            })
            .await?;
        }
        let counts = repo.method_counts(run_id).await?;
        repo.update_run_counts(run_id, &counts).await?;
        Ok(())
    }
    .await;
    if let Err(e) = staged {
        let _ = repo
            .finish_run(
                run_id,
                TxrRunStatus::Failed,
                0,
                &empty_counts(),
                false,
                Some(e.to_string()),
            )
            .await;
        return Err(e);
    }
    Ok(plan)
}

/// Build the replay steps (the per-method facts) for the request.
fn prepare_steps(
    bundle: &DemoBundle,
    req: &CreateRunRequest,
    config: &BundleConfiguration,
) -> Result<Vec<ReplayStep>, AppError> {
    let speed = replay_speed();
    match req.mode {
        TxrRunMode::Train => {
            let mut steps = Vec::with_capacity(req.method_ids.len());
            for method_id in &req.method_ids {
                let record = method_record(bundle, &config.id, method_id).ok_or_else(|| {
                    demo_400(format!(
                        "the demo has no recorded results for method {method_id:?} in this \
                         setup — it replays the recorded methods only"
                    ))
                })?;
                let column = &record.train;
                let facts = envmanifest::facts_for(method_id);
                steps.push(ReplayStep {
                    method_id: method_id.clone(),
                    outcome_method_id: method_id.clone(),
                    label: column.label.clone(),
                    version: facts.map(|f| f.version.clone()).unwrap_or_default(),
                    group: facts.map(|f| f.group.as_str().to_string()).unwrap_or_default(),
                    task: column.task,
                    prob_source: column.prob_source,
                    scored: column.coverage.scored,
                    eligible: column.coverage.eligible,
                    replay_seconds: replay_seconds(record.seconds, speed),
                    model: record.model.clone(),
                    model_tree: None,
                    model_digest: None,
                });
            }
            Ok(steps)
        }
        TxrRunMode::Reuse => {
            let mut steps = Vec::with_capacity(req.model_ids.len());
            for asset in &req.model_ids {
                let record = method_record(bundle, &config.id, &asset.method_id).ok_or_else(|| {
                    demo_400(format!(
                        "the demo has no recorded reuse results for model {:?} (method \
                         {:?}) in this setup — it replays the recorded models only",
                        asset.model_id, asset.method_id
                    ))
                })?;
                let reuse = record.reuse.as_ref().ok_or_else(|| {
                    demo_400(format!(
                        "the demo has no recorded reuse results for method {:?}",
                        asset.method_id
                    ))
                })?;
                steps.push(ReplayStep {
                    method_id: asset.model_id.clone(),
                    outcome_method_id: asset.method_id.clone(),
                    label: asset.method_id.clone(),
                    version: asset.method_version.clone(),
                    group: envmanifest::facts_for(&asset.method_id)
                        .map(|f| f.group.as_str().to_string())
                        .unwrap_or_default(),
                    task: reuse.task,
                    prob_source: reuse.prob_source,
                    scored: reuse.coverage.scored,
                    eligible: reuse.coverage.eligible,
                    replay_seconds: replay_seconds(record.seconds, speed),
                    model: None,
                    model_tree: None,
                    model_digest: None,
                });
            }
            Ok(steps)
        }
    }
}

/// The create-time estimate of a demo run (the sum + the lane schedule of the
/// recorded replay durations — the plan's "estimate = recorded seconds /
/// replay speed").
fn demo_estimate(plan: &ReplayPlan) -> Option<TxrRunEstimate> {
    let seconds: Vec<f64> = plan.steps.iter().map(|s| s.replay_seconds).collect();
    if seconds.is_empty() {
        return None;
    }
    Some(TxrRunEstimate {
        total_seconds: seconds.iter().sum(),
        schedule_seconds: lpt_schedule_seconds(&seconds, plan.config.at_a_time.max(1) as usize),
        estimate_quality: crate::modules::method_catalogue::types::TimingQuality::Measured,
    })
}

/// The run-input record (the rerun source — the engine's one record shape).
fn write_run_input_record(
    dir: &Path,
    req: &CreateRunRequest,
    config: &RunConfig,
) -> Result<(), AppError> {
    use crate::modules::execution_engine::types::RunInputRecord;
    let record = RunInputRecord {
        mode: req.mode,
        input: req.input.clone(),
        config: config.clone(),
        method_ids: req.method_ids.clone(),
        model_ids: req.model_ids.clone(),
        rerun_of: None,
    };
    let mut text = serde_json::to_string_pretty(&record)
        .map_err(|e| AppError::internal_error(format!("run input record: {e}")))?;
    text.push('\n');
    let path = dir.join("input").join("run-input.json");
    std::fs::write(&path, text)
        .map_err(|e| AppError::internal_error(format!("write {}: {e}", path.display())))
}

/// The stub model tree for a recorded model: ONE json file carrying the
/// recorded metadata. The tree's digest is the row's `tree_sha256`; the
/// resolve seam verifies the files against it, so the demo's saved models
/// resolve and reuse like any other. The recorded size/AUC are the manifest
/// facts, never recomputed from this stub.
fn write_stub_model_tree(tree: &Path, model: &BundleModel) -> Result<(), AppError> {
    let mut text = serde_json::to_string_pretty(&serde_json::json!({
        "format": "txresbench-demo-recorded-model",
        "recorded_name": model.name,
        "recorded_method_version": model.method_version,
    }))
    .map_err(|e| AppError::internal_error(format!("stub model tree: {e}")))?;
    text.push('\n');
    std::fs::write(tree.join("demo-model.json"), text)
        .map_err(|e| AppError::internal_error(format!("write stub model tree: {e}")))
}

// ─────────────────────────────────────────────────────────────────────────────
// The driving task
// ─────────────────────────────────────────────────────────────────────────────

/// One beat of the stop-aware sleep: returns (stopped?, elapsed_seconds).
/// `deadline` is the beat length.
async fn beat(run_stop: &mut watch::Receiver<bool>, beats: usize, step: f64) -> (bool, f64) {
    let started = std::time::Instant::now();
    for _ in 0..beats {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs_f64(step.max(0.02)));
        ticker.tick().await; // first tick fires immediately (consume it)
        tokio::select! {
            _ = ticker.tick() => {}
            _ = run_stop.changed() => {}
        }
        if *run_stop.borrow() {
            return (true, started.elapsed().as_secs_f64());
        }
    }
    (false, started.elapsed().as_secs_f64())
}

/// The driving task: prepares the beat, then per method — waiting lead,
/// running window (with the recorded log lines), finish patch — and finally
/// the run finalize. Every transition writes the engine's rows and broadcasts
/// the SSE frames; every stop/skip check happens at a beat boundary.
async fn drive_replay(
    pool: SqlitePool,
    runtime: Arc<RunRuntime>,
    run_id: Uuid,
    plan: Arc<ReplayPlan>,
    ctl: Arc<ReplayCtl>,
    mut run_stop: watch::Receiver<bool>,
) {
    let repo = TxrRepository::new(pool.clone());

    async fn fail(repo: &TxrRepository, run_id: Uuid, e: String) {
        let _ = repo
            .finish_run(
                run_id,
                TxrRunStatus::Failed,
                0,
                &empty_counts(),
                false,
                Some(e),
            )
            .await;
        let _ = repo
            .append_log(run_id, None, TxrLogStream::Engine, "demo replay failed")
            .await;
    }

    // The run-level lead (the "preparing" beat).
    if beat(&mut run_stop, 1, RUN_PREP_SECONDS).await.0 {
        apply_stop_transitions(&repo, run_id, &ctl).await;
        runtime.close_run(run_id);
        unregister_replay(run_id);
        return;
    }
    if let Err(e) = repo
        .set_run_status(run_id, TxrRunStatus::Running, Some(Utc::now()))
        .await
    {
        fail(&repo, run_id, e.to_string()).await;
        runtime.close_run(run_id);
        unregister_replay(run_id);
        return;
    }
    runtime.broadcast(
        run_id,
        TxrRunEvent::Status(TxrRunStatusFrame {
            status: TxrRunStatus::Running.as_str().to_string(),
        })
        .into(),
    );
    let _ = repo
        .append_log(
            run_id,
            None,
            TxrLogStream::Engine,
            "demo replay: run started (recorded results of the example data)",
        )
        .await;

    let start = std::time::Instant::now();
    let lines = plan_log_lines(&plan);
    let mut i = 0usize;
    'steps: while i < plan.steps.len() {
        let step = &plan.steps[i];
        // Waiting lead, then the skip/stop checks.
        if beat(&mut run_stop, 1, METHOD_LEAD_SECONDS).await.0 {
            apply_stop_transitions(&repo, run_id, &ctl).await;
            runtime.close_run(run_id);
            unregister_replay(run_id);
            return;
        }
        match ctl.phase(&step.method_id) {
            PHASE_STOPPED => {
                // A per-method stop (the engine's typing: the run keeps the
                // other methods; a RUN stop travels the watch channel).
                patch_step_stopped(&repo, run_id, &step.method_id).await;
                i += 1;
                continue 'steps;
            }
            PHASE_SKIPPED => {
                patch_step_skipped(&repo, run_id, &step.method_id).await;
                i += 1;
                continue 'steps;
            }
            _ => {}
        }
        ctl.set_phase(&step.method_id, PHASE_RUNNING);
        // A skip/stop can land between the check above and this flip; the
        // flip must not swallow it — the row was already written by the
        // requesting arm, so the phase map is the authority.
        match ctl.phase(&step.method_id) {
            PHASE_SKIPPED => {
                patch_step_skipped(&repo, run_id, &step.method_id).await;
                i += 1;
                continue 'steps;
            }
            PHASE_STOPPED => {
                patch_step_stopped(&repo, run_id, &step.method_id).await;
                i += 1;
                continue 'steps;
            }
            _ => {}
        }
        let started_at = Utc::now();
        if let Err(e) = patch_step_running(&repo, run_id, step, started_at).await {
            fail(&repo, run_id, e.to_string()).await;
            runtime.close_run(run_id);
            unregister_replay(run_id);
            return;
        }
        runtime.broadcast(
            run_id,
            TxrRunEvent::Method(method_frame_of(step, TxrMethodState::Running)).into(),
        );
        let _ = repo
            .append_log(
                run_id,
                Some(&step.method_id),
                TxrLogStream::Engine,
                "demo replay: method starting (recorded results)",
            )
            .await;

        // The window: 6 beats; the engine lines stream before the first
        // method, the method-tagged lines across the window (chunked at the
        // beat boundaries, so the timestamps are plausible).
        let beats: usize = 6;
        let beat_len = step.replay_seconds / beats as f64;
        // This method's recorded lines (the config's method-tagged lines) —
        // split across the window's beats so the timestamps are plausible.
        let tagged: Vec<(Option<String>, TxrLogStream, String)> = lines
            .iter()
            .filter(|(m, _, _)| m.as_deref() == Some(step.outcome_method_id.as_str()))
            .cloned()
            .collect();
        let per_beat = (tagged.len() / beats).max(1);
        for b in 0..beats {
            let (stopped, _) = beat(&mut run_stop, 1, beat_len).await;
            if stopped {
                apply_stop_transitions(&repo, run_id, &ctl).await;
                runtime.close_run(run_id);
                unregister_replay(run_id);
                return;
            }
            if ctl.phase(&step.method_id) == PHASE_STOPPED {
                // A per-method stop: leave the window, the finish fence
                // below writes the stopped row and the run keeps going.
                break;
            }
            if ctl.phase(&step.method_id) == PHASE_SKIPPED {
                patch_step_skipped(&repo, run_id, &step.method_id).await;
                i += 1;
                continue 'steps;
            }
            // The phase beats (the F screen's phase column: env/fit/predict).
            let phase = match b {
                0 | 1 => TxrPhase::Env,
                2 | 3 => TxrPhase::Fit,
                _ => TxrPhase::Predict,
            };
            if let Err(e) = repo
                .patch_method(
                    run_id,
                    &step.method_id,
                    &MethodPatch {
                        phase: Some(phase),
                        ..Default::default()
                    },
                )
                .await
            {
                fail(&repo, run_id, e.to_string()).await;
                runtime.close_run(run_id);
                unregister_replay(run_id);
                return;
            }
            // The recorded lines of this beat's chunk (the first beat of the
            // FIRST method also plays the engine lines, in record order).
            let mut chunk: Vec<(Option<String>, TxrLogStream, String)> = Vec::new();
            if i == 0 && b == 0 {
                chunk.extend(
                    lines
                        .iter()
                        .filter(|(m, _, _)| m.is_none())
                        .cloned(),
                );
            }
            let start = b * per_beat;
            if start < tagged.len() {
                chunk.extend(tagged[start..(start + per_beat).min(tagged.len())].iter().cloned());
            }
            if !chunk.is_empty() {
                let _ = repo.append_logs(run_id, &chunk).await;
            }
        }

        // The finish: if a per-method stop reached the method, it stays
        // stopped (the plan's "a stopped method stays stopped"); the run
        // keeps going with its other methods.
        if ctl.phase(&step.method_id) == PHASE_STOPPED {
            patch_step_stopped(&repo, run_id, &step.method_id).await;
            ctl.set_phase(&step.method_id, PHASE_STOPPED);
            i += 1;
            continue 'steps;
        }

        let finished_at = Utc::now();
        let elapsed_ms = (finished_at - started_at).num_milliseconds().max(1) as u64;
        if let Err(e) = patch_step_finished(&repo, run_id, step, finished_at, elapsed_ms).await {
            fail(&repo, run_id, e.to_string()).await;
            runtime.close_run(run_id);
            unregister_replay(run_id);
            return;
        }
        runtime.broadcast(
            run_id,
            TxrRunEvent::Prediction(TxrRunPredictionFrame {
                method_id: step.method_id.clone(),
                prob_source: step.prob_source.as_str().to_string(),
                coverage_fraction: if step.eligible > 0 {
                    step.scored as f64 / step.eligible as f64
                } else {
                    0.0
                },
                scored: step.scored as u64,
                eligible: step.eligible as u64,
            })
            .into(),
        );
        runtime.broadcast(
            run_id,
            TxrRunEvent::Method(method_frame_of(step, TxrMethodState::Finished)).into(),
        );
        let _ = repo
            .append_log(
                run_id,
                Some(&step.method_id),
                TxrLogStream::Engine,
                "demo replay: method finished (recorded results)",
            )
            .await;
        ctl.set_phase(&step.method_id, PHASE_FINISHED);
        i += 1;
    }

    let counts = match repo.method_counts(run_id).await {
        Ok(c) => c,
        Err(e) => {
            fail(&repo, run_id, e.to_string()).await;
            runtime.close_run(run_id);
            unregister_replay(run_id);
            return;
        }
    };
    let elapsed = start.elapsed().as_secs().max(1);
    if let Err(e) = repo
        .finish_run(
            run_id,
            TxrRunStatus::Finished,
            elapsed,
            &counts,
            counts.finished > 0,
            None,
        )
        .await
    {
        fail(&repo, run_id, e.to_string()).await;
    } else {
        let _ = repo
            .append_log(
                run_id,
                None,
                TxrLogStream::Engine,
                "demo replay: run finished (recorded results of the example data)",
            )
            .await;
    }
    runtime.broadcast(
        run_id,
        TxrRunEvent::Status(TxrRunStatusFrame {
            status: TxrRunStatus::Finished.as_str().to_string(),
        })
        .into(),
    );
    runtime.close_run(run_id);
    unregister_replay(run_id);
}

/// The recorded lines of the plan's configuration as append tuples
/// (`append_logs`' tuple shape), in record order.
fn plan_log_lines(plan: &ReplayPlan) -> Vec<(Option<String>, TxrLogStream, String)> {
    let Some(bundle) = super::bundle() else {
        return Vec::new();
    };
    let Some(cfg) = bundle
        .configurations
        .iter()
        .find(|c| c.id == plan.config_id)
    else {
        return Vec::new();
    };
    cfg.logs
        .iter()
        .map(|l| {
            let stream = match l.stream.as_str() {
                "stderr" => TxrLogStream::Stderr,
                "engine" => TxrLogStream::Engine,
                _ => TxrLogStream::Stdout,
            };
            (l.method_id.clone(), stream, l.content.clone())
        })
        .collect()
}

/// The "method running" patch (state + phase + started).
async fn patch_step_running(
    repo: &TxrRepository,
    run_id: Uuid,
    step: &ReplayStep,
    started_at: DateTime<Utc>,
) -> Result<(), AppError> {
    repo.patch_method(
        run_id,
        &step.method_id,
        &MethodPatch {
            state: Some(TxrMethodState::Running),
            phase: Some(TxrPhase::Env),
            started_at: Some(started_at),
            ..Default::default()
        },
    )
    .await?;
    let counts = repo.method_counts(run_id).await?;
    repo.update_run_counts(run_id, &counts).await
}

/// The "method finished" patch (state + phase + column facts + the produced
/// model facts when the recorded run saved one).
async fn patch_step_finished(
    repo: &TxrRepository,
    run_id: Uuid,
    step: &ReplayStep,
    finished_at: DateTime<Utc>,
    elapsed_ms: u64,
) -> Result<(), AppError> {
    let (base, layer) = recorded_env_digests(&step.outcome_method_id);
    repo.patch_method(
        run_id,
        &step.method_id,
        &MethodPatch {
            state: Some(TxrMethodState::Finished),
            phase: Some(TxrPhase::Done),
            task: Some(step.task),
            prob_source: Some(step.prob_source),
            coverage_scored: Some(step.scored),
            coverage_eligible: Some(step.eligible),
            exit_code: Some(0),
            duration_ms: Some(elapsed_ms),
            elapsed_secs: Some((elapsed_ms / 1000).max(1)),
            finished_at: Some(finished_at),
            model_out_digest: step.model_digest.clone(),
            model_dir: step.model_tree.as_ref().map(|p| p.display().to_string()),
            env_base_digest: Some(base),
            env_layer_digest: Some(layer),
            trained_on_patients: step.model.as_ref().and_then(|m| m.trained_on_patients),
            size_bytes: step.model.as_ref().map(|m| m.size_bytes),
            own_auc: step.model.as_ref().and_then(|m| m.own_auc),
            ..Default::default()
        },
    )
    .await?;
    let counts = repo.method_counts(run_id).await?;
    repo.update_run_counts(run_id, &counts).await
}

/// The "method skipped" patch (row + counts). Idempotent: the skip arm
/// writes it at request time (so the UI sees it at once) and the driving
/// task re-writes it at the next beat boundary (so a skip that landed in
/// the in-memory phase window still lands in the DB).
async fn patch_step_skipped(repo: &TxrRepository, run_id: Uuid, method_id: &str) {
    let _ = repo
        .patch_method(
            run_id,
            method_id,
            &MethodPatch {
                state: Some(TxrMethodState::Skipped),
                finished_at: Some(Utc::now()),
                ..Default::default()
            },
        )
        .await;
    let counts = repo.method_counts(run_id).await.unwrap_or_else(|_| empty_counts());
    let _ = repo.update_run_counts(run_id, &counts).await;
}

/// The "method stopped" patch (row + counts + the user line) — the ENGINE's
/// per-method stop typing: waiting/running → stopped + ABORTED, the run
/// keeps its other methods' results (a run-level stop is the watch channel,
/// `apply_stop_transitions`).
async fn patch_step_stopped(repo: &TxrRepository, run_id: Uuid, method_id: &str) {
    let _ = repo
        .patch_method(
            run_id,
            method_id,
            &MethodPatch {
                state: Some(TxrMethodState::Stopped),
                reason: Some(TxrRunReason::from_engine(
                    EngineReasonCode::Aborted,
                    "stopped by the user",
                )),
                finished_at: Some(Utc::now()),
                ..Default::default()
            },
        )
        .await;
    let counts = repo.method_counts(run_id).await.unwrap_or_else(|_| empty_counts());
    let _ = repo.update_run_counts(run_id, &counts).await;
    let _ = repo
        .append_log(run_id, Some(method_id), TxrLogStream::Engine, "stopped by the user")
        .await;
}

fn method_frame_of(step: &ReplayStep, state: TxrMethodState) -> TxrRunMethodFrame {
    TxrRunMethodFrame {
        method_id: step.method_id.clone(),
        state: state.as_str().to_string(),
        reason_code: None,
        phase: None,
        bytes_downloaded: 0,
        bytes_total: None,
        elapsed_secs: None,
    }
}

/// The DB stop transitions (running → stopped/ABORTED, waiting → skipped),
/// the run finalize + the log line — the engine's `stop_run_from_db` typing,
/// applied by the replay task at a stop and by the fallback arms when no
/// replay is live (a restart case).
async fn apply_stop_transitions(repo: &TxrRepository, run_id: Uuid, ctl: &ReplayCtl) {
    let Ok(Some(row)) = repo.get_run(run_id).await else {
        return;
    };
    if matches!(
        row.status(),
        Ok(TxrRunStatus::Finished | TxrRunStatus::Failed | TxrRunStatus::Stopped)
    ) {
        return;
    }
    let now = Utc::now();
    let Ok(methods) = repo.methods_for_run(run_id).await else {
        return;
    };
    for m in methods {
        match m.state() {
            Ok(TxrMethodState::Waiting) => {
                ctl.set_phase(&m.method_id, PHASE_SKIPPED);
                let _ = repo
                    .patch_method(
                        run_id,
                        &m.method_id,
                        &MethodPatch {
                            state: Some(TxrMethodState::Skipped),
                            finished_at: Some(now),
                            ..Default::default()
                        },
                    )
                    .await;
            }
            Ok(TxrMethodState::Running) => {
                ctl.set_phase(&m.method_id, PHASE_STOPPED);
                let _ = repo
                    .patch_method(
                        run_id,
                        &m.method_id,
                        &MethodPatch {
                            state: Some(TxrMethodState::Stopped),
                            reason: Some(TxrRunReason::from_engine(
                                EngineReasonCode::Aborted,
                                "stopped by the user",
                            )),
                            finished_at: Some(now),
                            ..Default::default()
                        },
                    )
                    .await;
            }
            _ => {}
        }
    }
    let counts = repo.method_counts(run_id).await.unwrap_or_else(|_| empty_counts());
    let elapsed = row
        .started_at
        .map(|s| (Utc::now() - s).num_seconds().max(0) as u64)
        .unwrap_or(0);
    let _ = repo
        .finish_run(
            run_id,
            TxrRunStatus::Stopped,
            elapsed,
            &counts,
            counts.finished > 0,
            None,
        )
        .await;
    let _ = repo
        .append_log(run_id, None, TxrLogStream::Engine, "stopped by the user")
        .await;
}

// ─────────────────────────────────────────────────────────────────────────────
// The control arms (the route dispatch; the engine's error vocabulary)
// ─────────────────────────────────────────────────────────────────────────────

/// Stop the whole replay.
pub async fn stop_replay(
    pool: SqlitePool,
    runtime: Arc<RunRuntime>,
    run_id: Uuid,
) -> Result<(), AppError> {
    let repo = TxrRepository::new(pool.clone());
    let Some(row) = repo.get_run(run_id).await? else {
        return Err(run_not_found(run_id));
    };
    match row.status()? {
        TxrRunStatus::Stopped => return Ok(()),
        TxrRunStatus::Finished | TxrRunStatus::Failed => {
            return Err(run_not_active(run_id, row.status()?.as_str()));
        }
        _ => {}
    }
    if replay_for(run_id).is_some() {
        // The live replay signals through the runtime's cancel channel (the
        // engine's own stop registry), then applies the transitions itself.
        if runtime.signal_cancel(run_id) {
            return Ok(());
        }
    }
    // No live replay (a restart case): the DB transition fallback.
    let ctl = ReplayCtl::new(
        run_id,
        &repo
            .methods_for_run(run_id)
            .await?
            .iter()
            .map(|m| m.method_id.clone())
            .collect::<Vec<_>>(),
    );
    apply_stop_transitions(&repo, run_id, &ctl).await;
    Ok(())
}

/// Stop ONE method of a replay (waiting/running → stopped; a terminal row is
/// `409 METHOD_NOT_ACTIVE` — the engine's typing). A stopped method stays
/// stopped; the run keeps its other methods.
pub async fn stop_replay_method(
    pool: SqlitePool,
    run_id: Uuid,
    method_id: &str,
) -> Result<(), AppError> {
    let repo = TxrRepository::new(pool.clone());
    let Some(_row) = repo.get_run(run_id).await? else {
        return Err(run_not_found(run_id));
    };
    let Some(m) = repo.get_method(run_id, method_id).await? else {
        return Err(method_not_found(run_id, method_id));
    };
    match m.state()? {
        TxrMethodState::Finished
        | TxrMethodState::Failed
        | TxrMethodState::Skipped
        | TxrMethodState::Stopped
        | TxrMethodState::CannotRun => {
            return Err(method_not_active(run_id, method_id, m.state()?.as_str()));
        }
        _ => {}
    }
    if let Some(ctl) = replay_for(run_id) {
        ctl.set_phase(method_id, PHASE_STOPPED);
        return Ok(());
    }
    repo.patch_method(
        run_id,
        method_id,
        &MethodPatch {
            state: Some(TxrMethodState::Stopped),
            reason: Some(TxrRunReason::from_engine(
                EngineReasonCode::Aborted,
                "stopped by the user",
            )),
            finished_at: Some(Utc::now()),
            ..Default::default()
        },
    )
    .await?;
    let counts = repo.method_counts(run_id).await?;
    repo.update_run_counts(run_id, &counts).await?;
    let _ = repo
        .append_log(run_id, Some(method_id), TxrLogStream::Engine, "stopped by the user")
        .await;
    Ok(())
}

/// Skip ONE waiting method of a replay (a running method is never skippable —
/// `409 METHOD_NOT_SKIPPABLE`).
pub async fn skip_replay_method(
    pool: SqlitePool,
    run_id: Uuid,
    method_id: &str,
) -> Result<(), AppError> {
    let repo = TxrRepository::new(pool.clone());
    let Some(_row) = repo.get_run(run_id).await? else {
        return Err(run_not_found(run_id));
    };
    let Some(m) = repo.get_method(run_id, method_id).await? else {
        return Err(method_not_found(run_id, method_id));
    };
    match m.state()? {
        TxrMethodState::Running => {
            return Err(method_not_skippable(run_id, method_id, "running"));
        }
        TxrMethodState::Finished
        | TxrMethodState::Failed
        | TxrMethodState::Skipped
        | TxrMethodState::Stopped
        | TxrMethodState::CannotRun => {
            return Err(method_not_skippable(run_id, method_id, m.state()?.as_str()));
        }
        _ => {}
    }
    if let Some(ctl) = replay_for(run_id) {
        ctl.set_phase(method_id, PHASE_SKIPPED);
        patch_step_skipped(&repo, run_id, method_id).await;
        return Ok(());
    }
    repo.patch_method(
        run_id,
        method_id,
        &MethodPatch {
            state: Some(TxrMethodState::Skipped),
            finished_at: Some(Utc::now()),
            ..Default::default()
        },
    )
    .await?;
    let counts = repo.method_counts(run_id).await?;
    repo.update_run_counts(run_id, &counts).await?;
    Ok(())
}

/// The mid-run lane change: stored on the run (the summary serves it) and the
/// run's recorded estimate replaced with the schedule at the new lane count —
/// the only compute fact a recorded run has. Outside 1..=8 is 400
/// INVALID_AT_A_TIME (the engine's rule).
pub async fn set_at_a_time_replay(
    pool: SqlitePool,
    run_id: Uuid,
    at_a_time: u32,
) -> Result<TxrRunSummary, AppError> {
    if !(TxrLimits::AT_A_TIME_MIN..=TxrLimits::AT_A_TIME_MAX).contains(&at_a_time) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_AT_A_TIME",
            format!(
                "at_a_time must be within {}..={}, got {}",
                TxrLimits::AT_A_TIME_MIN,
                TxrLimits::AT_A_TIME_MAX,
                at_a_time
            ),
        ));
    }
    let repo = TxrRepository::new(pool.clone());
    let Some(row) = repo.get_run(run_id).await? else {
        return Err(run_not_found(run_id));
    };
    match row.status()? {
        TxrRunStatus::Finished | TxrRunStatus::Failed | TxrRunStatus::Stopped => {
            return Err(run_not_active(run_id, row.status()?.as_str()));
        }
        _ => {}
    }
    repo.update_run_at_a_time(run_id, at_a_time).await?;
    // Replace the stored estimate with the lane schedule of the recorded
    // replay durations (the engine's lane-change recompute precedent; a
    // failure leaves the old estimate — a display fact).
    if let Some(seconds) = replay_seconds_of_run(Path::new(&row.dir)).await {
        let estimate = TxrRunEstimate {
            total_seconds: seconds.iter().sum(),
            schedule_seconds: lpt_schedule_seconds(&seconds, at_a_time.max(1) as usize),
            estimate_quality: crate::modules::method_catalogue::types::TimingQuality::Measured,
        };
        let _ = repo.update_run_estimate(run_id, &estimate).await;
    }
    repo.get_run_summary(run_id)
        .await?
        .ok_or_else(|| AppError::internal_error("run row vanished after lane change"))
}

/// The recorded replay durations of a demo run (the marker's configuration
/// re-derived from the bundle) — the lane-change estimate source.
async fn replay_seconds_of_run(dir: &Path) -> Option<Vec<f64>> {
    let marker = read_marker(dir)?;
    let bundle = super::bundle()?;
    let cfg = bundle
        .configurations
        .iter()
        .find(|c| c.id == marker.configuration_id)?;
    let speed = replay_speed();
    let mut out = Vec::new();
    for method in &bundle.methods {
        if let Some(record) = method.records.iter().find(|r| r.configuration_id == cfg.id) {
            out.push(replay_seconds(record.seconds, speed));
        }
    }
    Some(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// The boot sweep (interrupted replay → finished)
// ─────────────────────────────────────────────────────────────────────────────

/// The boot sweep of interrupted demo replays: every non-terminal run that
/// carries the replay marker is FINISHED in one pass — the remaining methods
/// get their recorded facts and the run turns `finished` with its other rows
/// untouched (a finished method keeps its result, like the engine's own boot
/// reconcile). Spawned by the demo module's init (detached, idempotent).
pub fn spawn_boot_sweep(pool: SqlitePool, runtime: Arc<RunRuntime>) {
    if !super::enabled() {
        return;
    }
    tokio::spawn(async move {
        let bundle = super::bundle();
        let speed = replay_speed();
        match finish_interrupted_replays(&pool, &runtime, bundle, speed).await {
            Ok(n) if n > 0 => {
                tracing::info!(
                    runs = n,
                    "demo replay: boot sweep finished the interrupted replays"
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = ?e, "demo replay: boot sweep failed");
            }
        }
    });
}

/// Finish every non-terminal demo replay run (the reconcile sibling: the
/// engine's boot reconcile SKIPS demo runs — see `reconcile.rs`).
pub async fn finish_interrupted_replays(
    pool: &SqlitePool,
    runtime: &Arc<RunRuntime>,
    bundle: Option<&DemoBundle>,
    speed: f64,
) -> Result<u64, AppError> {
    let repo = TxrRepository::new(pool.clone());
    let rows = repo.list_live_runs().await?;
    let mut finished = 0u64;
    for row in rows {
        if !is_demo_run_row(&row) {
            continue;
        }
        let run_id = row.id;
        let config = crate::modules::execution_engine::repository::parse_config(&row.config)
            .map_err(|e| AppError::database_error(format!("demo run config: {e}")))?;
        let Some(bundle) = bundle else { continue };
        let Some(cfg) = bundle
            .configurations
            .iter()
            .find(|c| {
                (c.endpoint == config.endpoint)
                    && (c.decision_day - config.decision_day).abs() < 1e-9
                    && (c.look_ahead_day - config.look_ahead_day).abs() < 1e-9
                    && c.covariates == config.covariates
            })
        else {
            continue;
        };
        let mode = row.mode()?;
        let methods = repo.methods_for_run(run_id).await?;
        let mut remaining = 0usize;
        for m in &methods {
            let state = m.state()?;
            if state == TxrMethodState::Finished || state == TxrMethodState::Skipped {
                continue;
            }
            // The bundle record: train rows carry the catalogue id in
            // `method_id`; reuse rows carry the saved-model id with the
            // catalogue id as the `label`.
            let record = method_record(bundle, &cfg.id, &m.method_id)
                .or_else(|| method_record(bundle, &cfg.id, &m.label));
            let Some(record) = record else { continue };
            let column = if mode == TxrRunMode::Train {
                &record.train
            } else {
                match &record.reuse {
                    Some(r) => r,
                    None => continue,
                }
            };
            let model = if mode == TxrRunMode::Train {
                record.model.clone()
            } else {
                None
            };
            let tree = Path::new(&row.dir).join("models").join(&m.method_id);
            let digest = crate::modules::sandbox::stack::tree_sha256(&tree).ok();
            let (base, layer) = recorded_env_digests(&m.label);
            repo.patch_method(
                run_id,
                &m.method_id,
                &MethodPatch {
                    state: Some(TxrMethodState::Finished),
                    phase: Some(TxrPhase::Done),
                    task: Some(column.task),
                    prob_source: Some(column.prob_source),
                    coverage_scored: Some(column.coverage.scored),
                    coverage_eligible: Some(column.coverage.eligible),
                    exit_code: Some(0),
                    elapsed_secs: Some(replay_seconds(record.seconds, speed) as u64),
                    finished_at: Some(Utc::now()),
                    model_out_digest: digest.clone(),
                    model_dir: tree.exists().then(|| tree.display().to_string()),
                    env_base_digest: Some(base),
                    env_layer_digest: Some(layer),
                    trained_on_patients: model.as_ref().and_then(|m| m.trained_on_patients),
                    size_bytes: model.as_ref().map(|m| m.size_bytes),
                    own_auc: model.as_ref().and_then(|m| m.own_auc),
                    ..Default::default()
                },
            )
            .await?;
            remaining += 1;
        }
        let counts = repo.method_counts(run_id).await?;
        let elapsed = row
            .started_at
            .map(|s| (Utc::now() - s).num_seconds().max(0) as u64)
            .unwrap_or(0);
        repo.finish_run(run_id, TxrRunStatus::Finished, elapsed, &counts, true, None)
            .await?;
        if remaining > 0 {
            let _ = repo
                .append_log(
                    run_id,
                    None,
                    TxrLogStream::Engine,
                    "demo replay: finished on restart (the recorded results)",
                )
                .await;
        }
        runtime.close_run(run_id);
        finished += 1;
    }
    Ok(finished)
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests (the pure half; the full replay lives in the integration tier)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::types::{TxrEndpoint, TxrRunInput};

    /// A minimal demo bundle (the manifest-shaped JSON the harness fixture
    /// writes — no validation pass here, the struct is the loader's shape).
    fn test_bundle() -> DemoBundle {
        let json = serde_json::json!({
            "format": "txresbench-demo-bundle",
            "version": 1,
            "generated_at": "2026-11-14T00:00:00Z",
            "dataset_id": "example",
            "tables": {
                "patients": {"content_hash": format!("sha256:{}", "a".repeat(64)), "rows": 94, "columns": []},
                "measurements": {"content_hash": format!("sha256:{}", "b".repeat(64)), "rows": 630, "columns": []},
                "predict_measurements": {"content_hash": format!("sha256:{}", "c".repeat(64)), "rows": 15, "columns": []},
            },
            "configurations": [
                {"id": "pfs_d56_h238", "endpoint": "pfs", "decision_day": 56.0,
                 "look_ahead_day": 238.0, "covariates": false,
                 "logs": [{"method_id": null, "stream": "engine", "content": "run started"}]},
                {"id": "os_d56_h238", "endpoint": "os", "decision_day": 56.0,
                 "look_ahead_day": 238.0, "covariates": false, "logs": []},
            ],
            "methods": [{
                "method_id": "kelim",
                "records": [{
                    "configuration_id": "pfs_d56_h238",
                    "seconds": 12.5,
                    "train": {"table": "train/pfs_d56_h238/kelim.csv", "label": "kelim",
                              "group": "kinetics", "group_label": "Kinetics", "task": "pfs",
                              "prob_source": "native", "flat_conversion": false,
                              "coverage": {"scored": 94, "eligible": 94, "fraction": 1.0},
                              "rows": 94},
                    "model": {"name": "kelim", "method_version": "1.0.0", "group": "kinetics",
                              "group_label": "Kinetics", "task": "pfs",
                              "trained_on_patients": 94, "trained_at": "2026-11-14T00:00:00Z",
                              "decision_day": 56.0, "endpoint": "pfs", "horizon": 238.0,
                              "size_bytes": 1024, "embeds_training_data": false,
                              "own_auc": 0.71, "marker_count": 3, "marker_kind": "all",
                              "uses_covariates": false},
                    "reuse": {"table": "reuse/pfs_d56_h238/kelim.csv", "label": "kelim",
                              "group": "kinetics", "group_label": "Kinetics", "task": "pfs",
                              "prob_source": "native", "flat_conversion": false,
                              "coverage": {"scored": 15, "eligible": 15, "fraction": 1.0},
                              "rows": 15},
                }],
            }],
        });
        let mut bundle: DemoBundle =
            serde_json::from_value(json).expect("the test manifest parses");
        bundle.bundle_dir = PathBuf::from("/nonexistent");
        bundle
    }

    #[test]
    fn match_configuration_accepts_the_recorded_setup_only() {
        let bundle = test_bundle();
        let ok = RunConfig {
            endpoint: TxrEndpoint::Pfs,
            decision_day: 56.0,
            look_ahead_day: 238.0,
            covariates: false,
            ..RunConfig::default()
        };
        let cfg = match_configuration(&bundle, &ok).expect("recorded pfs setup matches");
        assert_eq!(cfg.id, "pfs_d56_h238");

        let os = RunConfig {
            endpoint: TxrEndpoint::Os,
            ..ok.clone()
        };
        assert_eq!(match_configuration(&bundle, &os).expect("os recorded").id, "os_d56_h238");

        // A configuration outside the bundle is the plain 400.
        for bad in [
            RunConfig { decision_day: 90.0, ..ok.clone() },
            RunConfig { look_ahead_day: 400.0, ..ok.clone() },
            RunConfig { covariates: true, ..ok.clone() },
        ] {
            let err = match_configuration(&bundle, &bad).expect_err("unrecorded setup refused");
            assert_eq!(err.status_code(), 400);
            assert!(err.to_string().contains("was not recorded in the demo"), "{}", err);
        }
    }

    #[test]
    fn replay_seconds_divide_and_floor_at_1_5() {
        assert_eq!(replay_seconds(12.5, 10.0), 1.5); // 1.25 -> the 1.5 s floor
        assert_eq!(replay_seconds(25.0, 10.0), 2.5);
        assert_eq!(replay_seconds(3.0, 100.0), 1.5);
        assert_eq!(replay_seconds(3.0, 0.0), 3.0); // a bad speed replays at 1x
        assert_eq!(replay_seconds(3.0, -1.0), 3.0);
    }

    #[test]
    fn lpt_schedule_is_the_makespan() {
        assert_eq!(lpt_schedule_seconds(&[], 4), 0.0);
        assert_eq!(lpt_schedule_seconds(&[3.0, 3.0], 2), 3.0);
        // 10 + 6 + 4 + 3 over 2 lanes: the LPT packing is 10, then 6+3 and
        // then 4+6 -> makespan 13 (the greedy packing is not the optimum
        // 10+4 / 6+3 = 11 — the estimate bar uses the engine's own greedy
        // schedule).
        assert_eq!(lpt_schedule_seconds(&[10.0, 6.0, 4.0, 3.0], 2), 13.0);
        // One lane is the plain sum.
        assert_eq!(lpt_schedule_seconds(&[1.5, 1.5, 1.5], 1), 4.5);
        // More lanes than work is the longest job.
        assert_eq!(lpt_schedule_seconds(&[3.0, 1.5], 4), 3.0);
    }

    #[test]
    fn marker_round_trip_identifies_a_demo_run() {
        let dir = std::env::temp_dir().join(format!("demo-replay-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_demo_run(&dir), "no marker => not a demo run");
        let marker = ReplayMarker {
            format: REPLAY_FORMAT_TAG.to_string(),
            version: REPLAY_VERSION,
            run_id: Uuid::new_v4(),
            configuration_id: "pfs_d56_h238".to_string(),
            mode: TxrRunMode::Train,
        };
        write_marker(&dir, &marker).unwrap();
        assert!(is_demo_run(&dir));
        let back = read_marker(&dir).expect("marker reads back");
        assert_eq!(back.run_id, marker.run_id);
        assert_eq!(back.configuration_id, "pfs_d56_h238");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prepare_steps_refuse_unrecorded_methods_and_models() {
        let bundle = test_bundle();
        let config = match_configuration(&bundle, &RunConfig::default()).unwrap();
        let req = CreateRunRequest {
            mode: TxrRunMode::Train,
            input: TxrRunInput {
                patients: None,
                measurements: crate::modules::file_validator::types::ParsedTable {
                    source: crate::modules::file_validator::types::ParsedTableSource {
                        name: "m.csv".into(),
                        format: crate::modules::file_validator::types::TableFormat::Csv,
                    },
                    header_row: 1,
                    columns: vec!["patient_id".into()],
                    rows: vec![],
                },
                predict_measurements: None,
                joins: vec![],
                mapping: vec![],
                keep_copies: true,
            },
            config: RunConfig::default(),
            method_ids: vec!["kelim".to_string()],
            model_ids: vec![],
        };
        let steps = prepare_steps(&bundle, &req, config).expect("recorded method stages");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].outcome_method_id, "kelim");

        let mut outside = req.clone();
        outside.method_ids = vec!["not-recorded".to_string()];
        let err = prepare_steps(&bundle, &outside, config).expect_err("unrecorded method refused");
        assert_eq!(err.status_code(), 400);
        assert!(err.to_string().contains("no recorded results"), "{}", err);
    }

    /// The restart rule: an interrupted demo run (a live row + marker) is
    /// FINISHED by the boot sweep in one pass from the recorded facts — a
    /// waiting method gets the bundle's column + model facts and the run
    /// turns `finished` (the recorded seconds are known, so "resumes" is a
    /// fast-forward). A live non-demo run is left to the engine's reconcile.
    #[tokio::test]
    async fn boot_sweep_finishes_an_interrupted_replay() {
        use crate::modules::execution_engine::types::TxrRunFileNames;

        let root = std::env::temp_dir().join(format!("demo-replay-boot-sweep-{}", Uuid::new_v4()));
        let demo_dir = root.join("demo-run");
        let plain_dir = root.join("plain-run");
        std::fs::create_dir_all(&demo_dir).unwrap();
        std::fs::create_dir_all(&plain_dir).unwrap();
        let db_path = root.join("txr.sqlite");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite connects");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR
            .run(&pool)
            .await
            .expect("merged migrations apply");

        let bundle = test_bundle();
        let repo = TxrRepository::new(pool.clone());
        let summary = || TxrRunInputSummary {
            patients: Some(94),
            predict_patients: Some(15),
            markers: 3,
            events: Some(630),
            file_names: TxrRunFileNames {
                patients: Some("patients.csv".into()),
                measurements: "measurements.csv".into(),
                predict_measurements: Some("predict.csv".into()),
            },
        };

        // The interrupted demo run: one method still waiting.
        let run_id = Uuid::new_v4();
        repo.insert_run(&NewRun {
            id: run_id,
            created_at: None,
            status: TxrRunStatus::Running,
            mode: TxrRunMode::Train,
            config: RunConfig::default(),
            input_summary: summary(),
            model_ids: vec![],
            method_count: 1,
            counts: empty_counts(),
            dir: demo_dir.display().to_string(),
            memory_total_bytes: None,
            cpus: None,
            seed: 1,
            estimate: None,
        })
        .await
        .unwrap();
        repo.insert_method(&NewMethod {
            id: Uuid::new_v4(),
            run_id,
            method_id: "kelim".into(),
            label: "kelim".into(),
            version: "1.0.0".into(),
            group: "kinetics".into(),
            state: TxrMethodState::Waiting,
            bytes_total: Some(1024),
        })
        .await
        .unwrap();
        write_marker(
            &demo_dir,
            &ReplayMarker {
                format: REPLAY_FORMAT_TAG.to_string(),
                version: REPLAY_VERSION,
                run_id,
                configuration_id: "pfs_d56_h238".to_string(),
                mode: TxrRunMode::Train,
            },
        )
        .unwrap();

        // A live NON-demo run (no marker): the engine's reconcile owns it.
        let plain_id = Uuid::new_v4();
        repo.insert_run(&NewRun {
            id: plain_id,
            created_at: None,
            status: TxrRunStatus::Preparing,
            mode: TxrRunMode::Train,
            config: RunConfig::default(),
            input_summary: summary(),
            model_ids: vec![],
            method_count: 1,
            counts: empty_counts(),
            dir: plain_dir.display().to_string(),
            memory_total_bytes: None,
            cpus: None,
            seed: 1,
            estimate: None,
        })
        .await
        .unwrap();

        let runtime = Arc::new(RunRuntime::new());
        let n = finish_interrupted_replays(&pool, &runtime, Some(&bundle), 2.0)
            .await
            .expect("the sweep runs");
        assert_eq!(n, 1, "only the demo run is swept");

        let run = repo.get_run(run_id).await.unwrap().expect("demo run still there");
        assert_eq!(run.status().unwrap(), TxrRunStatus::Finished);
        assert!(run.predictions_ready, "the finished fast-forward has predictions");
        let method = repo.get_method(run_id, "kelim").await.unwrap().unwrap();
        assert_eq!(method.state().unwrap(), TxrMethodState::Finished);
        assert_eq!(method.task.as_deref(), Some("pfs"));
        assert_eq!(method.prob_source.as_deref(), Some("native"));
        assert_eq!(method.coverage_scored, Some(94));
        assert_eq!(method.coverage_eligible, Some(94));
        assert_eq!(method.trained_on_patients, Some(94));
        assert_eq!(method.model_dir, None, "no model tree in the fixture run dir");
        let counts = repo.method_counts(run_id).await.unwrap();
        assert_eq!(counts.finished, 1);
        assert_eq!(counts.waiting, 0);
        let logs = repo.logs_tail(run_id, 5).await.unwrap();
        assert!(
            logs.iter().any(|l| l.content.contains("finished on restart")),
            "the fast-forward leaves its log line"
        );

        let plain = repo.get_run(plain_id).await.unwrap().unwrap();
        assert_eq!(
            plain.status().unwrap(),
            TxrRunStatus::Preparing,
            "a non-demo live run is never touched by the demo sweep"
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
