//! The run drive loop + lane dispatcher + env orchestration + admission
//! wrapper (PLAN ITEM-8, DEC-3/6/7/12/15/16/17): ONE detached task per run,
//! its own lane gate at `at_a_time`, per-method env ensure with a 500 ms
//! status poll, admission through `jobs::admission` (one global cap),
//! stop/skip on the queue, and the `provenance::verify` finally-close
//! discipline for every admitted `jobs` row.
//!
//! ### The shapes
//!
//! - [`RunRuntime`] (the module-installed per-run SSE + run-stop registry) is
//!   `runtime.rs`; the drive loop broadcasts `TxrRunEvent`s through it.
//! - [`start_run`] is the create half (PROV-EE-2's order): validate the
//!   request (400/404) → validate/canonicalize the in-memory parsed tables →
//!   persist the run row (`preparing`) → write the run dir + input snapshot →
//!   classify every selected method (`cannot_run` rows keep their reason;
//!   queued rows start `waiting`) → spawn the detached drive task → the 202
//!   summary (it already reflects the classification). ITEM-10's route seam.
//! - The drive body: `running` → one task per queued method through the lane
//!   gate (`waiting` → lane) → env ensure (the `downloading` state, row
//!   counters + SSE frames on a 500 ms poll) → admission (`admit_within`,
//!   job_type `"sandbox"`, cancel registered BEFORE the admit so a stop
//!   racing the spawn is not lost) → the per-method [`MethodExecutor`]
//!   (ITEM-9's execution/ingest seam) → terminal patch + frames →
//!   `close_slot` in the finally-shaped tail. When every method is terminal
//!   the run finalizes (`finishing → finished`, counts + `predictions_ready`).
//! - Stop/skip/at-a-time control reaches the live drive through the
//!   [`drive_for`] registry — ITEM-9/10's route seams: `signal_stop_all` /
//!   `signal_stop_method` / `signal_skip_method` / `set_at_a_time`.
//!
//! ### Deliberate readings (recorded in DRIFT-1 ITEM-8)
//!
//! - The method row's download counter tracks the method's own LAYER (the
//!   manifest `size_bytes`); the shared base image's download is an engine
//!   log line, never a row counter (one row would double-count a byte stream
//!   common to every method of the language family).
//! - Env failures pass the provider's typed codes through verbatim when they
//!   are in the typed env set; everything else is the engine's `ENV_UNREADY`;
//!   executor errors keep their own typed codes (one reason vocabulary, the
//!   verbatim rule CONS-EE-10).
//! - Stop-all semantics: waiting/downloading methods turn `skipped`, running
//!   methods turn `stopped` with `ABORTED` (EXAMPLE-EE-3's exact shape); a
//!   per-method stop of a waiting/downloading method turns `stopped`.
//! - The global cap bump/restore of DEC-6 is the [`GlobalCapGuard`]: bump at
//!   create, restore at drive finalize only when no other live drive remains.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use tokio::sync::{watch, Notify};
use uuid::Uuid;

use ziee_core::AppError;

use super::repository::{MethodPatch, NewMethod, NewRun, TxrRepository};
use super::runtime::RunRuntime;
use super::types::{
    CreateRunRequest, EngineReasonCode, RunConfig, TxrCoverage, TxrLimits, TxrLogStream,
    TxrMethodState, TxrPhase, TxrProbSource, TxrRequestError, TxrRunCounts, TxrRunInputSummary,
    TxrRunReason, TxrRunStatus, TxrRunSummary, TxrTask,
};
use crate::modules::file_validator::types::{
    CanonicalBundle, CanonicalPatient, JoinOffer, MarkerMapping, ParsedTable, ValidationMode,
    ValidationRequest, DEFAULT_BASELINE_MAX_DAY,
};
use crate::modules::method_catalogue::eligibility;
use crate::modules::method_catalogue::types::{EligibilityRequest, EligibilityStatus, Method};
use crate::modules::rootfs;
use crate::modules::sandbox::method_env::{
    EnvKind, MethodEnvManager, MethodEnvStatus, ProvidedMount,
};
use crate::modules::sandbox::stack::{EnvRef, TXR_BASE_REGISTRY_PREFIX};

use super::envmanifest;

/// How often the drive loop polls an in-flight env download (PLAN ITEM-8:
/// 500 ms status poll → `bytes_downloaded`/`progress_pct` → row update +
/// `method` SSE frames).
pub const ENV_POLL_INTERVAL: Duration = Duration::from_millis(500);

// ─────────────────────────────────────────────────────────────────────────────
// The env-provider seam (PROV-SS-4, the `jobs::seams` idiom): the drive loop
// binds three operations through a trait; production is the sandbox module's
// process-wide `MethodEnvManager`, the unit fixture is scripted.
// ─────────────────────────────────────────────────────────────────────────────

/// The env-fetch seam the drive loop holds (CONS-EE-7).
pub trait EnvProvider: Send + Sync {
    /// Blocking fetch/verify/mount of one artifact (call on `spawn_blocking`).
    fn ensure(
        &self,
        r: &EnvRef,
        kind: EnvKind,
        deadline: Duration,
    ) -> Result<ProvidedMount, AppError>;
    /// The env's live state (the 500 ms poll's read side).
    fn status(&self, env_id: &str) -> MethodEnvStatus;
    /// Cancel the env's in-flight download (a user stop of the method).
    fn cancel(&self, env_id: &str);
}

/// The production provider — a thin wrapper over the sandbox module's
/// process-wide manager (the wrapper owns the `&'static` reference — the seam
/// object the module hands to `start_run`).
pub struct RealEnvProvider(&'static MethodEnvManager);

impl EnvProvider for RealEnvProvider {
    fn ensure(
        &self,
        r: &EnvRef,
        kind: EnvKind,
        deadline: Duration,
    ) -> Result<ProvidedMount, AppError> {
        self.0.ensure(r, kind, deadline)
    }

    fn status(&self, env_id: &str) -> MethodEnvStatus {
        self.0.status(env_id)
    }

    fn cancel(&self, env_id: &str) {
        self.0.cancel(env_id);
    }
}

/// The production provider.
pub fn real_env_provider() -> Arc<dyn EnvProvider> {
    Arc::new(RealEnvProvider(
        crate::modules::sandbox::method_env::manager(),
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// EnvRef construction (CONS-EE-8 + ITEM-2 note (i))
// ─────────────────────────────────────────────────────────────────────────────

/// The method LAYER ref: the manifest's own `oci_ref` + the byte-verify pin
/// (`layer_sha256` — the squashfs digest PROV-SS-1's `EnvRef.digest` is) + the
/// immutable publish tag.
pub fn layer_env_ref(entry: &envmanifest::ManifestEntry) -> EnvRef {
    EnvRef {
        oci_ref: entry.oci_ref.clone(),
        digest: entry.layer_sha256.clone(),
        tag: Some(entry.tag.clone()),
    }
}

/// The BASE ref: the entry `language` mapped onto the sandbox's own base repo
/// (`ghcr.io/tinnlab/txresbench-env/base-<family>` — the only spelling the
/// provider's `validate_oci_ref` accepts; the manifest's `base_ref` is the
/// BENCHMARK namespace, provenance only), paired by the manifest's
/// `base_digest` (the design §7 anchor: the trimmed base carries
/// `com.txr.trimmed-from-digest` = this value). Digest-addressed so the pull
/// never falls back to a moving tag (DEC-3).
pub fn base_env_ref(entry: &envmanifest::ManifestEntry) -> EnvRef {
    let digest = entry
        .base_digest
        .strip_prefix("sha256:")
        .unwrap_or(&entry.base_digest);
    EnvRef {
        oci_ref: format!(
            "{TXR_BASE_REGISTRY_PREFIX}/base-{}@{digest}",
            entry.language.base_family()
        ),
        digest: digest.to_string(),
        tag: None,
    }
}

/// The base env id the manager keys the base artifact under (the ref's repo
/// component).
pub fn base_env_id(entry: &envmanifest::ManifestEntry) -> String {
    format!("base-{}", entry.language.base_family())
}

/// The typed env-failure reason (INV-2: a download that cannot complete is a
/// method failure with the typed reason — never a silent retry). The
/// provider's own codes pass through verbatim (the reason vocabulary is one
/// list after the reconcile growth — a consumer renderer switches on the
/// code); everything else is the engine's `ENV_UNREADY` with the message.
pub fn env_failure_reason(err: &AppError) -> TxrRunReason {
    const PASSTHROUGH: &[&str] = &[
        "ENV_VERIFY_FAILED",
        "ENV_STAGING_TIMEOUT",
        "ENV_REF_HOST_UNALLOWED",
        "ENV_REPOSITORY_UNKNOWN",
        "ENV_KIND_INVALID",
        "ENV_DOWNLOAD_CANCELLED",
        "ENV_LAYER_MANIFEST_INVALID",
        "ENV_LAYER_ENTRY_INVALID",
        "METHOD_ENTRYPOINT_MISSING",
        "SANDBOX_UNAVAILABLE",
        "ENV_TOOL_MISSING",
    ];
    let code = err.error_code();
    if PASSTHROUGH.contains(&code) {
        TxrRunReason {
            code: code.to_string(),
            detail: err.to_string(),
        }
    } else {
        TxrRunReason::from_engine(EngineReasonCode::EnvUnready, err.to_string())
    }
}

/// The typed failure reason of an executor error: the error's own code
/// verbatim (the executor's providers emit the closed `BUNDLE_*` /
/// `PREDICTION_INVALID` / `RECALIBRATION_FAILED` / `MODEL_VERIFY_FAILED` /
/// `JOB_TIMEOUT` / `SANDBOX_UNAVAILABLE` set — one vocabulary, CONS-EE-10's
/// verbatim rule).
pub fn execution_failure_reason(err: &AppError) -> TxrRunReason {
    TxrRunReason {
        code: err.error_code().to_string(),
        detail: err.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The lane gate (the board's "run N at a time", DEC-6 + CONS-UI-RUN-11)
// ─────────────────────────────────────────────────────────────────────────────

/// One acquired lane slot; releasing on Drop is what makes "never a third
/// method running" a property of the gate, not of the run loop's arithmetic.
pub struct LanePermit {
    gate: Arc<LaneGate>,
}

impl Drop for LanePermit {
    fn drop(&mut self) {
        self.gate.release();
    }
}

/// The per-run lane gate: a tokio [`Notify`] over a short Mutex critical
/// section (the acquire path never awaits while holding the lock, so the gate
/// cannot serialize the run loop).
pub struct LaneGate {
    lanes: Mutex<usize>,
    active: Mutex<usize>,
    free: Notify,
}

impl LaneGate {
    pub fn new(lanes: usize) -> Arc<Self> {
        Arc::new(Self {
            lanes: Mutex::new(lanes.max(1)),
            active: Mutex::new(0),
            free: Notify::new(),
        })
    }

    /// Try to acquire without waiting (the loop's first attempt — an idle box
    /// pays nothing, the `admit_within` discipline).
    pub fn try_acquire(self: &Arc<Self>) -> Option<LanePermit> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let lanes = *self.lanes.lock().unwrap_or_else(|e| e.into_inner());
        if *active >= lanes {
            return None;
        }
        *active += 1;
        Some(LanePermit { gate: self.clone() })
    }

    /// The wake signal (the lane-waiting loop's select arm; a stale wake —
    /// another waiter consumed the permit — just loops back to the re-check).
    pub async fn when_free(&self) {
        self.free.notified().await;
    }

    /// The current lane count (the F header's "N run at a time").
    pub fn lanes(&self) -> usize {
        *self.lanes.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Held permits (the F header's live "running" count).
    pub fn active(&self) -> usize {
        *self.active.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Mid-run lane change (the F board's lane select): the new count applies
    /// from the next admission; a held permit is never revoked (a running
    /// method is never interrupted — CONS-UI-RUN-11).
    pub fn set_lanes(&self, n: usize) {
        *self.lanes.lock().unwrap_or_else(|e| e.into_inner()) = n.max(1);
        self.free.notify_waiters();
    }

    fn release(&self) {
        *self.active.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        self.free.notify_one();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-method execution seam (ITEM-9's half: bundle write +
// run_method_in_stack + predictions ingest + model collection)
// ─────────────────────────────────────────────────────────────────────────────

/// The verified env facts a method runs under (the refs ITEM-9's
/// [`MethodRunRequest`] consumes + the byte digests the method row records —
/// the pins `ensure` verified, so the record is the verification's, not a
/// re-derivation).
#[derive(Debug, Clone)]
pub struct EnvFacts {
    pub base: EnvRef,
    pub layer: EnvRef,
    /// Verified base content digest (64-hex; the row's `env_base_digest`).
    pub base_digest: String,
    /// Verified layer content digest (64-hex; the row's `env_layer_digest`).
    pub layer_digest: String,
}

/// Everything the per-method executor needs — ITEM-9's context. Owned (the
/// executor runs on its own task; nothing borrows the drive).
pub struct MethodRunContext {
    pub run_id: Uuid,
    pub method_id: String,
    pub label: String,
    pub version: String,
    pub group: String,
    /// The method's `min_draws` (the bundle's per-method draw rule).
    pub min_draws: u32,
    pub env: EnvFacts,
    /// The admitted `jobs` row id (the cancel registration's key).
    pub job_id: Uuid,
    /// The jobs cancel signal (a stop of this method while it executes).
    pub cancel: watch::Receiver<bool>,
    /// The run's config (the bundle settings' source fields).
    pub config: RunConfig,
    /// Detected at run start (DEC-12 — the F header's "on N CPUs").
    pub cpus: u32,
    /// The train-side canonical bundle (train mode).
    pub train: Option<Arc<CanonicalBundle>>,
    /// The predict-side canonical bundle (path 2/3).
    pub predict: Option<Arc<CanonicalBundle>>,
    /// The predict-side patients rows (covariates; reuse mode).
    pub predict_patients: Option<Arc<[CanonicalPatient]>>,
    /// The run dir (`analysis-…`; DEC-5) — bundles/output/models live under it.
    pub run_dir: PathBuf,
    /// Whether `/model` outputs are saved (board E's checkbox).
    pub save_models: bool,
}

/// The terminal facts the executor learned (the drive loop applies them to
/// the method row in ONE patch + emits the frames — side effects stay in one
/// place).
pub struct MethodOutcome {
    pub state: TxrMethodState,
    /// Present exactly when the state is `failed` (INV-2).
    pub reason: Option<TxrRunReason>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub prob_source: Option<TxrProbSource>,
    pub coverage: Option<TxrCoverage>,
    pub task: Option<TxrTask>,
    /// The produced `/model` facts when the run saves models (X1).
    pub model: Option<ProducedModelFacts>,
}

/// The produced-model record the drive loop persists on the method row
/// (PROV-EE-9's fields).
#[derive(Debug, Clone)]
pub struct ProducedModelFacts {
    pub model_out_digest: String,
    pub dir: String,
    pub trained_on_patients: u32,
    pub size_bytes: u64,
    pub own_auc: Option<f64>,
}

/// ITEM-9's seam: one method's execution, from the written bundle to the
/// ingested predictions. `Err` is a machinery failure (the method row fails
/// with the error's typing and the admitted slot closes `failed`); an `Ok`
/// carries the method's verdict (a method that ran and produced bad output is
/// `Ok(state: failed, reason: …)`, never an `Err`).
#[async_trait]
pub trait MethodExecutor: Send + Sync {
    async fn execute(&self, ctx: MethodRunContext) -> Result<MethodOutcome, AppError>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The run drive + live-drive registry
// ─────────────────────────────────────────────────────────────────────────────

/// A classified selected method (or reuse asset) of the run.
pub struct MethodPlan {
    pub method_id: String,
    pub label: String,
    pub version: String,
    pub group: String,
    pub min_draws: u32,
    pub entry: Option<&'static envmanifest::ManifestEntry>,
    pub target: RunTarget,
    /// Whether the row was inserted as `cannot_run` (no task is spawned).
    pub cannot_run: bool,
    /// The cannot-run reason (INV-2 — carried onto the row at persist).
    pub reason: Option<TxrRunReason>,
}

/// What the drive runs (ITEM-9's executor dispatches on this).
pub enum RunTarget {
    /// Train mode: a catalogue method.
    TrainMethod,
    /// Reuse mode: a resolved model asset (DEC-10 — data, not an import).
    ReuseModel { asset: super::types::TxrModelAsset },
}

/// One queued method's stop/skip channels.
#[derive(Clone)]
struct MethodControl {
    stop: Arc<watch::Sender<bool>>,
    skip: Arc<watch::Sender<bool>>,
}

impl MethodControl {
    fn new() -> Self {
        Self {
            stop: Arc::new(watch::channel(false).0),
            skip: Arc::new(watch::channel(false).0),
        }
    }
}

/// The run's drive state — the detached loop's handle AND the stop/skip/
/// at-a-time control (ITEM-9/10's routes reach it through [`drive_for`]).
pub struct RunDrive {
    pool: sqlx::SqlitePool,
    runtime: Arc<RunRuntime>,
    repo: TxrRepository,
    env: Arc<dyn EnvProvider>,
    executor: Arc<dyn MethodExecutor>,
    owner: Uuid,
    run_id: Uuid,
    config: RunConfig,
    cpus: u32,
    memory_total_bytes: Option<u64>,
    dir: PathBuf,
    lanes: Arc<LaneGate>,
    /// The run-level stop (the runtime's registered channel — the stop route
    /// signals the SAME sender via `RunRuntime::signal_cancel`).
    run_stop: watch::Receiver<bool>,
    /// Per-method control channels (created at plan time, so a stop racing
    /// the spawn is never lost — the run-stop registration precedent).
    methods: Mutex<std::collections::HashMap<String, MethodControl>>,
    /// The admitted `jobs` row ids (the executing methods' cancel targets).
    job_ids: Mutex<std::collections::HashMap<String, Uuid>>,
    /// The global-cap bump guard (DEC-6).
    cap_guard: Mutex<Option<GlobalCapGuard>>,
}

impl RunDrive {
    fn method_control(&self, method_id: &str) -> MethodControl {
        let mut map = self.methods.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(method_id.to_string())
            .or_insert_with(MethodControl::new)
            .clone()
    }

    /// Stop the whole run (PROV-EE-6's stop-all): the run-level signal + every
    /// queued method's flag. An executing method is also signalled through its
    /// admitted `jobs` row's cancel channel.
    pub fn signal_stop_all(&self) {
        self.runtime.signal_cancel(self.run_id);
        let map = self.methods.lock().unwrap_or_else(|e| e.into_inner());
        for ctl in map.values() {
            let _ = ctl.stop.send(true);
        }
        let ids: Vec<Uuid> = self
            .job_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .copied()
            .collect();
        for job in ids {
            crate::modules::jobs::runtime::runtime().signal_cancel(job);
        }
    }

    /// Stop one method: waiting/downloading → its stop flag; executing → the
    /// admitted job's cancel. Returns whether the method is known to this
    /// drive (the route's 404/409 answer comes from the row state).
    pub fn signal_stop_method(&self, method_id: &str) -> bool {
        let known = {
            let map = self.methods.lock().unwrap_or_else(|e| e.into_inner());
            map.get(method_id)
                .map(|c| c.stop.send(true).is_ok())
                .unwrap_or(false)
        };
        if let Some(job_id) = self.job_for(method_id) {
            crate::modules::jobs::runtime::runtime().signal_cancel(job_id);
        }
        known
    }

    /// Skip one method (waiting/downloading only — a method that is already
    /// executing is never skippable, 409 at the route).
    pub fn signal_skip_method(&self, method_id: &str) -> bool {
        let map = self.methods.lock().unwrap_or_else(|e| e.into_inner());
        map.get(method_id)
            .map(|c| c.skip.send(true).is_ok())
            .unwrap_or(false)
    }

    /// Mid-run lane change (CONS-UI-RUN-11): the new admission count applies
    /// from the next method; a running method is never interrupted.
    pub fn set_at_a_time(&self, n: u32) {
        self.lanes
            .set_lanes(n.max(TxrLimits::AT_A_TIME_MIN) as usize);
    }

    /// The run's current lane count.
    pub fn at_a_time(&self) -> usize {
        self.lanes.lanes()
    }

    pub fn run_id(&self) -> Uuid {
        self.run_id
    }

    pub fn cpus(&self) -> u32 {
        self.cpus
    }

    pub fn memory_total_bytes(&self) -> Option<u64> {
        self.memory_total_bytes
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The `jobs` row this drive admitted for `method_id` (the stop route's
    /// signal target; `None` before admission / after close).
    pub fn job_for(&self, method_id: &str) -> Option<Uuid> {
        self.job_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(method_id)
            .copied()
    }

    fn record_job(&self, method_id: &str, job_id: Uuid) {
        self.job_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(method_id.to_string(), job_id);
    }

    /// One state-machine step: patch the row, broadcast its `method` frame and
    /// refresh the run's counts JSON (the F header reads the stored JSON — one
    /// aggregate query per transition, the SAME statement the read path uses).
    async fn patch(
        &self,
        method_id: &str,
        patch: MethodPatch,
    ) -> Result<super::repository::MethodRow, AppError> {
        let row = self
            .repo
            .patch_method(self.run_id, method_id, &patch)
            .await?;
        self.runtime.broadcast(
            self.run_id,
            super::types::TxrRunEvent::Method(method_frame(&row)).into(),
        );
        self.refresh_counts().await;
        Ok(row)
    }

    async fn refresh_counts(&self) {
        match self.repo.method_counts(self.run_id).await {
            Ok(counts) => {
                if let Err(e) = self.repo.update_run_counts(self.run_id, &counts).await {
                    tracing::warn!(run_id = %self.run_id, error = %e, "execution engine: counts refresh failed");
                }
            }
            Err(e) => {
                tracing::warn!(run_id = %self.run_id, error = %e, "execution engine: counts query failed")
            }
        }
    }

    async fn append_log(&self, method_id: Option<&str>, content: &str) {
        if let Err(e) = self
            .repo
            .append_log(self.run_id, method_id, TxrLogStream::Engine, content)
            .await
        {
            tracing::warn!(run_id = %self.run_id, error = %e, "execution engine: log append failed");
            return;
        }
        let line = super::types::TxrRunLogLine {
            seq: 0,
            method_id: method_id.map(|s| s.to_string()),
            stream: TxrLogStream::Engine,
            content: content.to_string(),
            created_at: Utc::now(),
        };
        self.runtime
            .broadcast(self.run_id, super::types::TxrRunEvent::Log(line).into());
    }

    async fn broadcast_status(&self, status: TxrRunStatus) {
        let event = super::types::TxrRunEvent::Status(super::types::TxrRunStatusFrame {
            status: status.as_str().to_string(),
        });
        self.runtime.broadcast(self.run_id, event.into());
    }

    async fn broadcast_progress(
        &self,
        method_id: &str,
        phase: Option<TxrPhase>,
        pct: Option<f64>,
        message: Option<String>,
    ) {
        let frame = super::types::TxrRunProgressFrame {
            method_id: method_id.to_string(),
            phase: phase.map(|p| p.as_str().to_string()),
            pct,
            message,
        };
        self.runtime.broadcast(
            self.run_id,
            super::types::TxrRunEvent::Progress(frame).into(),
        );
    }
}

fn method_frame(row: &super::repository::MethodRow) -> super::types::TxrRunMethodFrame {
    super::types::TxrRunMethodFrame {
        method_id: row.method_id.clone(),
        state: row.state.clone(),
        reason_code: row.reason_code.clone(),
        phase: row.phase.clone(),
        bytes_downloaded: row.bytes_downloaded.max(0) as u64,
        bytes_total: row.bytes_total.map(|v| v.max(0) as u64),
        elapsed_secs: row.elapsed_secs.map(|v| v.max(0) as u64),
    }
}

static DRIVES: LazyLock<Mutex<std::collections::HashMap<Uuid, Weak<RunDrive>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// The live drive for `run_id`, if its loop is still running (a finished run
/// is deregistered — the routes then answer from the DB).
pub fn drive_for(run_id: Uuid) -> Option<Arc<RunDrive>> {
    let map = DRIVES.lock().unwrap_or_else(|e| e.into_inner());
    map.get(&run_id).and_then(Weak::upgrade)
}

fn register_drive(drive: &Arc<RunDrive>) {
    let mut map = DRIVES.lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, w| w.strong_count() > 0);
    map.insert(drive.run_id, Arc::downgrade(drive));
}

fn unregister_drive(run_id: Uuid) {
    DRIVES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
}

/// The other live drives' lane counts (the DEC-6 restore's guard: the last
/// drive restores `max(previous, these)` so a sibling analysis's bump is
/// never torn down).
fn other_live_lane_counts(run_id: Uuid) -> Vec<usize> {
    let map = DRIVES.lock().unwrap_or_else(|e| e.into_inner());
    map.iter()
        .filter(|(id, w)| **id != run_id && w.strong_count() > 0)
        .filter_map(|(_, w)| w.upgrade())
        .map(|d| d.at_a_time())
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// DEC-6's global-cap bump/restore
// ─────────────────────────────────────────────────────────────────────────────

/// One run's claim on the GLOBAL concurrency cap: a default
/// `max_concurrent_jobs` of 2 would silently cap the board's default 3 lanes,
/// so a run bumps the global cap to at least its own `at_a_time` at create and
/// restores the previous value when the LAST live drive of the process
/// terminates (a second analysis never oversubscribes; failures log but never
/// fail the run — a settings write is not a method).
struct GlobalCapGuard {
    previous: i32,
    bumped: i32,
}

impl GlobalCapGuard {
    async fn bump(
        pool: &sqlx::SqlitePool,
        owner: Uuid,
        at_a_time: u32,
    ) -> Result<Option<Self>, AppError> {
        let repo = crate::modules::jobs::settings::JobSettingsRepository::new(pool.clone());
        let row = repo.get().await?;
        let previous = row.max_concurrent_jobs;
        let wanted = (at_a_time as i32).max(previous);
        if wanted == previous {
            return Ok(None);
        }
        repo.update(
            &crate::modules::jobs::models::UpdateJobSettingsRequest {
                max_concurrent_jobs: Some(wanted),
                ..Default::default()
            },
            owner,
        )
        .await?;
        Ok(Some(Self {
            previous,
            bumped: wanted,
        }))
    }

    async fn restore(&self, pool: &sqlx::SqlitePool, owner: Uuid, run_id: Uuid) {
        // The restore never under-provisions a LIVE run: the target is
        // `max(previous, other live drives' lane counts)` — the last drive
        // of THIS process restores, a sibling analysis's bump is preserved.
        let others = other_live_lane_counts(run_id);
        let target = self
            .previous
            .max(others.iter().copied().max().unwrap_or(0) as i32);
        let repo = crate::modules::jobs::settings::JobSettingsRepository::new(pool.clone());
        match repo.get().await {
            Ok(row) if row.max_concurrent_jobs == self.bumped && target != self.bumped => {
                if let Err(e) = repo
                    .update(
                        &crate::modules::jobs::models::UpdateJobSettingsRequest {
                            max_concurrent_jobs: Some(target),
                            ..Default::default()
                        },
                        owner,
                    )
                    .await
                {
                    tracing::warn!(%run_id, error = %e, "execution engine: global cap restore failed");
                }
            }
            Ok(_) => {
                // Someone else moved the cap, or a sibling's bump is the
                // ceiling; leave it.
            }
            Err(e) => {
                tracing::warn!(%run_id, error = %e, "execution engine: global cap read for restore failed")
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run dir + input snapshot (DEC-5/16)
// ─────────────────────────────────────────────────────────────────────────────

/// `<data_root>/analysis-<UTC yyyy-mm-dd-hhmm>-<id8>` — the board H folder
/// name (the id prefix is the run's uuid's first 8 hex chars).
pub fn run_dir_name(at: chrono::DateTime<Utc>, run_id: Uuid) -> String {
    format!(
        "analysis-{}-{}",
        at.format("%Y-%m-%d-%H%M"),
        &run_id.simple().to_string()[..8]
    )
}

/// The run tree root (`rootfs::data_root()` — the K screen reopens a run after
/// an app restart, so the path is fully deterministic).
pub fn run_dir_root() -> PathBuf {
    rootfs::data_root()
}

/// Copy an uploaded `ParsedTable` back to CSV bytes (the raw-file copy of
/// DEC-16's `input/` — the cells are the parse's own, so the copy is the
/// uploaded file modulo line endings; the module's ONE codec is `bundle.rs`'s
/// cell writer).
pub(crate) fn table_csv(table: &ParsedTable) -> String {
    let mut out = String::new();
    for (i, col) in table.columns.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&crate::modules::execution_engine::bundle::csv_cell(col));
    }
    out.push('\n');
    for row in &table.rows {
        for (i, cell) in row.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            if let Some(s) = cell {
                out.push_str(&crate::modules::execution_engine::bundle::csv_cell(s));
            }
        }
        out.push('\n');
    }
    out
}

/// Write the run's `input/` snapshot: the raw uploaded copies (when
/// `keep_copies`, board K's promise) + the canonical CSVs (the validated rows
/// the engine ran on — always written: the per-method bundle inputs derive
/// from them and the run dir is the only durable record; DEC-16's mechanics,
/// history-store owns the deletion policy).
fn write_input_snapshot(
    dir: &Path,
    req: &super::types::TxrRunInput,
    canonical: &CanonicalBundle,
) -> Result<(), AppError> {
    let input = dir.join("input");
    std::fs::create_dir_all(&input).map_err(io_app("create input dir", input.clone()))?;
    if req.keep_copies {
        let mut copies: Vec<(String, &ParsedTable)> = Vec::new();
        if let Some(p) = req.patients.as_ref() {
            copies.push((file_stem(&p.source.name, "patients"), p));
        }
        copies.push(("measurements".to_string(), &req.measurements));
        if let Some(p) = req.predict_measurements.as_ref() {
            copies.push(("predict-measurements".to_string(), p));
        }
        for (stem, table) in copies {
            let path = input.join(format!("{stem}.csv"));
            std::fs::write(&path, table_csv(table))
                .map_err(io_app("write uploaded copy", path.clone()))?;
        }
    }
    write_canonical_csv(&input, canonical)?;
    Ok(())
}

fn file_stem(name: &str, fallback: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// The canonical CSVs: `patients.csv`, `values.csv`, `features.csv` (the
/// validated snapshot — the engine's own record of what the run rows mean).
fn write_canonical_csv(input: &Path, bundle: &CanonicalBundle) -> Result<(), AppError> {
    let cell = crate::modules::execution_engine::bundle::csv_cell;
    let mut patients =
        String::from("patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day\n");
    for p in &bundle.patients {
        let row = vec![
            cell(&p.patient_id),
            num(p.pfs_days),
            i64(p.pfs_event),
            num(p.os_days),
            i64(p.os_event),
            i64(p.responder),
            num(p.response_day),
        ];
        patients.push_str(&row.join(","));
        patients.push('\n');
    }
    let path = input.join("patients.csv");
    std::fs::write(&path, patients)
        .map_err(io_app("write canonical patients.csv", path.clone()))?;

    let mut values = String::from("patient_id,day,feature,value,unit\n");
    for v in &bundle.values {
        let row = vec![
            cell(&v.patient_id),
            num(Some(v.day)),
            cell(&v.feature),
            num(v.value),
            v.unit.as_deref().map(cell).unwrap_or_default(),
        ];
        values.push_str(&row.join(","));
        values.push('\n');
    }
    let path = input.join("values.csv");
    std::fs::write(&path, values).map_err(io_app("write canonical values.csv", path.clone()))?;

    let mut features = String::from("feature,unit,marker_id,is_detection_companion\n");
    for f in &bundle.features {
        let row = vec![
            cell(&f.feature),
            f.unit.as_deref().map(cell).unwrap_or_default(),
            f.marker_id.as_deref().map(cell).unwrap_or_default(),
            if f.is_detection_companion {
                "1".to_string()
            } else {
                "0".to_string()
            },
        ];
        features.push_str(&row.join(","));
        features.push('\n');
    }
    let path = input.join("features.csv");
    std::fs::write(&path, features)
        .map_err(io_app("write canonical features.csv", path.clone()))?;
    Ok(())
}

fn num(v: Option<f64>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

fn i64(v: Option<i64>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

fn io_app(what: &'static str, path: PathBuf) -> impl FnOnce(std::io::Error) -> AppError {
    move |e| AppError::internal_error(format!("{what} {}: {e}", path.display()))
}

// ─────────────────────────────────────────────────────────────────────────────
// start_run — validate → canonicalize → persist → snapshot → classify → spawn
// ─────────────────────────────────────────────────────────────────────────────

/// The 400 mapping of the create-request validation (ITEM-10's route surfaces
/// the same refusal).
pub fn request_error_to_app(err: TxrRequestError) -> AppError {
    AppError::new(
        axum::http::StatusCode::BAD_REQUEST,
        err.code.code(),
        err.to_string(),
    )
}

/// Create + drive a run (PROV-EE-2). ITEM-10's route seam.
pub async fn start_run(
    pool: sqlx::SqlitePool,
    runtime: Arc<RunRuntime>,
    env: Arc<dyn EnvProvider>,
    executor: Arc<dyn MethodExecutor>,
    owner: Uuid,
    req: CreateRunRequest,
) -> Result<TxrRunSummary, AppError> {
    req.validate().map_err(request_error_to_app)?;
    check_methods_known(&req)?;

    // Validate + canonicalize first (the in-memory tables; the CPU work is off
    // the executor) — the run row's `input_summary` then carries the
    // validator's own facts (the resolved marker count etc.).
    let prepared = tokio::task::spawn_blocking({
        let req_tables = req.input.clone();
        let config = req.config.clone();
        let mode = req.mode;
        let method_ids = req.method_ids.clone();
        let assets = req.model_ids.clone();
        move || prepare_run(&req_tables, &config, mode, &method_ids, &assets)
    })
    .await
    .map_err(|e| AppError::internal_error(format!("run prepare task join: {e}")))??;

    let repo = TxrRepository::new(pool.clone());
    let now = Utc::now();
    let run_id = Uuid::new_v4();
    let dir = run_dir_root().join(run_dir_name(now, run_id));
    let cpus = detect_cpus();
    let config = req.config.clone();

    // The row is persisted in `preparing` (the first visible state — a 202
    // reader never sees a run that is not there; `creating` is the instant
    // before the row is committed).
    repo.insert_run(&NewRun {
        id: run_id,
        created_at: Some(now),
        status: TxrRunStatus::Preparing,
        mode: req.mode,
        config: config.clone(),
        input_summary: input_summary(&req, &prepared),
        model_ids: req.model_ids.iter().map(|a| a.model_id.clone()).collect(),
        method_count: selected_count(&req) as u32,
        counts: TxrRunCounts {
            finished: 0,
            failed: 0,
            stopped: 0,
            skipped: 0,
            cannot_run: 0,
            running: 0,
            downloading: 0,
            waiting: 0,
        },
        dir: dir.display().to_string(),
        memory_total_bytes: read_memory_total_bytes(),
        cpus: Some(cpus),
        seed: TxrLimits::SEED,
    })
    .await?;

    let canonical_side = prepared
        .train
        .as_ref()
        .or(prepared.predict.as_ref())
        .expect("a run has at least one canonical side");

    // The post-insert preparation (run dir + input snapshot + classified
    // rows + counts): ONE failure path terminalizes the run row as `failed`
    // with the error in the record — a `preparing` row with no drive would be
    // unreachable until the boot reconcile (and then only after a restart).
    let staged: Result<(), AppError> = async {
        std::fs::create_dir_all(&dir).map_err(io_app("create run dir", dir.clone()))?;
        for sub in ["input", "bundles", "output", "logs", "models"] {
            std::fs::create_dir_all(dir.join(sub))
                .map_err(io_app("create run subdir", dir.clone()))?;
        }
        write_input_snapshot(&dir, &req.input, canonical_side)?;
        persist_plans(&repo, run_id, &prepared.plans).await?;
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
                &TxrRunCounts {
                    finished: 0,
                    failed: 0,
                    stopped: 0,
                    skipped: 0,
                    cannot_run: 0,
                    running: 0,
                    downloading: 0,
                    waiting: 0,
                },
                false,
                Some(e.to_string()),
            )
            .await;
        return Err(e);
    }

    // The global-cap bump — BEFORE the drive spawns so the first admission
    // sees the bumped cap (a settings-write failure is logged, never a method
    // failure: the lane gate still bounds concurrency).
    let cap_guard = match GlobalCapGuard::bump(&pool, owner, config.at_a_time).await {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!(%run_id, error = %e, "execution engine: global cap bump failed");
            None
        }
    };

    let run_stop = runtime.register_cancel(run_id);
    let drive = Arc::new(RunDrive {
        pool: pool.clone(),
        runtime,
        repo: repo.clone(),
        env,
        executor,
        owner,
        run_id,
        config,
        cpus,
        memory_total_bytes: read_memory_total_bytes(),
        dir,
        lanes: LaneGate::new(req.config.at_a_time.max(1) as usize),
        run_stop,
        methods: Mutex::new(std::collections::HashMap::new()),
        job_ids: Mutex::new(std::collections::HashMap::new()),
        cap_guard: Mutex::new(cap_guard),
    });
    // Pre-create the per-method control channels (a stop racing the spawn of a
    // method task is not lost).
    for plan in prepared.plans.iter().filter(|p| !p.cannot_run) {
        drive.method_control(&plan.method_id);
    }
    register_drive(&drive);
    tokio::spawn(drive_run(drive.clone(), Arc::new(prepared)));

    repo.get_run_summary(run_id)
        .await?
        .ok_or_else(|| AppError::internal_error("run row vanished after insert"))
}

fn check_methods_known(req: &CreateRunRequest) -> Result<(), AppError> {
    if req.mode == super::types::TxrRunMode::Train {
        for id in &req.method_ids {
            if envmanifest::facts_for(id).is_none() {
                return Err(AppError::new(
                    axum::http::StatusCode::NOT_FOUND,
                    "METHOD_NOT_FOUND",
                    format!("no method {id:?} in the shipped catalogue"),
                ));
            }
        }
    }
    for asset in &req.model_ids {
        if envmanifest::facts_for(&asset.method_id).is_none() {
            return Err(AppError::new(
                axum::http::StatusCode::NOT_FOUND,
                "METHOD_NOT_FOUND",
                format!(
                    "the reuse asset {:?} names unknown method {:?}",
                    asset.model_id, asset.method_id
                ),
            ));
        }
    }
    Ok(())
}

fn selected_count(req: &CreateRunRequest) -> usize {
    match req.mode {
        super::types::TxrRunMode::Train => req.method_ids.len(),
        super::types::TxrRunMode::Reuse => req.model_ids.len(),
    }
}

fn input_summary(req: &CreateRunRequest, prepared: &PreparedRun) -> TxrRunInputSummary {
    // `markers` = the validator's resolved marker columns (the ONE source —
    // never re-derived by re-parsing); `events` = the train cohort's eventful
    // patients (the K row's "62 events").
    let markers = prepared.markers as u32;
    let events = prepared.train.as_ref().map(|b| {
        b.patients
            .iter()
            .filter(|p| p.pfs_event == Some(1) || p.os_event == Some(1))
            .count() as u32
    });
    TxrRunInputSummary {
        patients: req.input.patients.as_ref().map(|p| p.rows.len() as u32),
        predict_patients: req
            .input
            .predict_measurements
            .as_ref()
            .map(|p| p.rows.len() as u32),
        markers,
        events,
        file_names: super::types::TxrRunFileNames {
            patients: req.input.patients.as_ref().map(|p| p.source.name.clone()),
            measurements: req.input.measurements.source.name.clone(),
            predict_measurements: req
                .input
                .predict_measurements
                .as_ref()
                .map(|p| p.source.name.clone()),
        },
    }
}

/// Detected CPU count (DEC-12: `available_parallelism`, fallback 4).
pub fn detect_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
}

/// The per-method lane CPU count (DEC-12: `clamp(floor(cpus / at_a_time), 1, 4)`
/// — ITEM-9's `params.threads` + the sandbox's thread overrides).
pub fn per_method_cpus(cpus: u32, at_a_time: u32) -> u32 {
    (cpus / at_a_time.max(1)).clamp(1, 4)
}

/// `memory_total_bytes` read once at run start (Linux `/proc/meminfo`; null
/// elsewhere — DEC-12's display-only fact).
pub fn read_memory_total_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb = text
            .lines()
            .find(|l| l.starts_with("MemTotal:"))?
            .split_whitespace()
            .nth(1)?
            .parse::<u64>()
            .ok()?;
        Some(kb * 1024)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// prepare_run — one validate/canonicalize per run + the per-method
// classification (CONS-EE-11/11b — one code path with the screens, DEC-15)
// ─────────────────────────────────────────────────────────────────────────────

/// The prepared facts of a run: the canonical sides + the classified plans +
/// the validator's marker count.
pub struct PreparedRun {
    pub train: Option<Arc<CanonicalBundle>>,
    pub predict: Option<Arc<CanonicalBundle>>,
    pub predict_patients: Option<Arc<[CanonicalPatient]>>,
    pub plans: Vec<MethodPlan>,
    pub markers: usize,
}

/// Build the validation request of the run's tables (the same joins/mapping
/// the screens confirmed; `baseline_max_day` is the validator's default 0 —
/// the 2026-10-19 contract's baseline definition).
fn validation_request(
    mode: ValidationMode,
    patients: Option<&ParsedTable>,
    measurements: &ParsedTable,
    joins: &[super::types::TxrJoin],
    mapping: &[super::types::TxrMapping],
    decision_day: f64,
) -> ValidationRequest {
    ValidationRequest {
        mode,
        patients: patients.cloned(),
        measurements: measurements.clone(),
        joins: joins
            .iter()
            .map(|j| JoinOffer {
                variants: j.variants.clone(),
                key: j.key.clone(),
            })
            .collect(),
        mapping: mapping
            .iter()
            .map(|m| MarkerMapping {
                key: m.key.clone(),
                marker_id: m.marker_id.clone(),
            })
            .collect(),
        parameters: crate::modules::file_validator::types::AnalysisParameters {
            decision_day,
            baseline_max_day: DEFAULT_BASELINE_MAX_DAY,
        },
    }
}

fn prepare_run(
    input: &super::types::TxrRunInput,
    config: &RunConfig,
    run_mode: super::types::TxrRunMode,
    method_ids: &[String],
    assets: &[super::types::TxrModelAsset],
) -> Result<PreparedRun, AppError> {
    use crate::modules::file_validator::{bundle, validate};

    // One validate per run over the RUN's table set. The mode disambiguates
    // the pair (train: patients + measurements; reuse: predict patients +
    // predict measurements — the run's only side). The inventory the
    // eligibility engine sees is the SAME object the screens rendered — one
    // code path (DEC-15).
    let (mode, patients, measurements) = match run_mode {
        super::types::TxrRunMode::Train => (
            ValidationMode::Files,
            input.patients.as_ref(),
            &input.measurements,
        ),
        super::types::TxrRunMode::Reuse => {
            let meas = input
                .predict_measurements
                .as_ref()
                .unwrap_or(&input.measurements);
            match input.patients.as_ref() {
                Some(p) => (ValidationMode::Files, Some(p), meas),
                None => (ValidationMode::Predict, None, meas),
            }
        }
    };
    let vreq = validation_request(
        mode,
        patients,
        measurements,
        &input.joins,
        &input.mapping,
        config.decision_day,
    );
    let validated = validate::validate(&vreq).map_err(validation_error_to_app)?;
    let marker_count = validated.markers.len();

    // The canonical sides. In FILES mode (train, or reuse with a predict
    // patients table) the run-side bundle is the TRAIN one and the predict
    // side (path 2/3) is a SEPARATE bundle over the predict table (ITEM-3
    // note (p): two independent bundles — the package writes train and test
    // from their own inputs). In a predict-only run (reuse) the run's one
    // table set IS the predict side — the canonical bundle sits in `predict`.
    let files_canonical = if mode == ValidationMode::Files {
        Some(Arc::new(
            bundle::canonical_bundle(&vreq).map_err(validation_error_to_app)?,
        ))
    } else {
        None
    };
    let predict_extra = match &input.predict_measurements {
        Some(predict) if mode == ValidationMode::Files => {
            let pvreq = validation_request(
                ValidationMode::Predict,
                None,
                predict,
                &input.joins,
                &input.mapping,
                config.decision_day,
            );
            Some(Arc::new(
                bundle::canonical_bundle(&pvreq).map_err(validation_error_to_app)?,
            ))
        }
        _ => None,
    };
    let (train_canonical, predict_canonical) = if mode == ValidationMode::Files {
        (files_canonical, predict_extra)
    } else {
        (
            None,
            Some(Arc::new(
                bundle::canonical_bundle(&vreq).map_err(validation_error_to_app)?,
            )),
        )
    };

    // The predict PATIENTS rows (the test side's covariate rows): the run's
    // own patients table in reuse mode (the Files-mode canonical bundle's
    // patients carry the covariate cells the package's test side reads; in
    // train mode the run-side patients are the TRAIN cohort — never the
    // predict ones).
    let predict_patients: Option<Arc<[CanonicalPatient]>> = match (&train_canonical, run_mode) {
        (Some(b), super::types::TxrRunMode::Reuse) => {
            Some(Arc::from(b.patients.clone().into_boxed_slice()))
        }
        _ => None,
    };

    let plans = classify(run_mode, method_ids, assets, &validated.inventory, config)?;
    Ok(PreparedRun {
        train: train_canonical,
        predict: predict_canonical,
        predict_patients,
        plans,
        markers: marker_count,
    })
}

fn validation_error_to_app(e: crate::modules::file_validator::types::ValidationError) -> AppError {
    AppError::new(axum::http::StatusCode::BAD_REQUEST, e.code(), e.to_string())
}

/// The reason's human line: the code + its params (the row carries the typed
/// code AND a renderable detail — the F screen's "needs LDH, not in your
/// file" line; the UI renders from the code vocabulary, the detail is the
/// fallback text).
fn reason_line(reason: &crate::modules::method_catalogue::types::Reason) -> String {
    if reason.params.is_empty() {
        reason.code.as_str().to_string()
    } else {
        format!(
            "{} ({})",
            reason.code.as_str(),
            serde_json::json!(reason.params)
        )
    }
}

/// Classify every selected method (train: the provider's eligibility verdict
/// + the env entry; reuse: asset verification + the env entry) into the plan
/// list — DEC-15's replay of the screens' one judgement, plus the env-manifest
/// classification of TEST-EE-06: a runnable method with no published
/// environment is `cannot_run` + `ENV_UNKNOWN`, never a silent skip.
fn classify(
    mode: super::types::TxrRunMode,
    method_ids: &[String],
    assets: &[super::types::TxrModelAsset],
    inventory: &crate::modules::method_catalogue::types::InventoryEligibilityRequest,
    config: &RunConfig,
) -> Result<Vec<MethodPlan>, AppError> {
    let _ = config;
    let mut plans = Vec::new();
    match mode {
        super::types::TxrRunMode::Train => {
            let verdicts = eligibility::eligibility(&EligibilityRequest::Inventory {
                inventory: inventory.clone(),
            });
            let by_id: std::collections::HashMap<
                &str,
                &crate::modules::method_catalogue::types::MethodEligibility,
            > = verdicts
                .methods
                .iter()
                .map(|m| (m.id.as_str(), m))
                .collect();
            for id in method_ids {
                let verdict = by_id
                    .get(id.as_str())
                    .expect("the eligibility engine answers every catalogue method");
                let facts = envmanifest::facts_for(id).expect("checked at start");
                let plan = match verdict.status {
                    EligibilityStatus::CannotRun => {
                        let reason = verdict
                            .reasons
                            .first()
                            .map(|r| TxrRunReason::from_catalogue(r.code, reason_line(r)))
                            .unwrap_or_else(|| {
                                TxrRunReason::from_catalogue(
                                    crate::modules::method_catalogue::types::ReasonCode::NotRunnable,
                                    "not runnable",
                                )
                            });
                        MethodPlan {
                            method_id: id.clone(),
                            label: facts.id.clone(),
                            version: facts.version.clone(),
                            group: facts.group.as_str().to_string(),
                            min_draws: facts.min_draws,
                            entry: None,
                            target: RunTarget::TrainMethod,
                            cannot_run: true,
                            reason: Some(reason),
                        }
                    }
                    EligibilityStatus::CanRun | EligibilityStatus::CanRunSome => {
                        match envmanifest::env_for(id) {
                            Some(entry) => MethodPlan {
                                method_id: id.clone(),
                                label: facts.id.clone(),
                                version: facts.version.clone(),
                                group: facts.group.as_str().to_string(),
                                min_draws: facts.min_draws,
                                entry: Some(entry),
                                target: RunTarget::TrainMethod,
                                cannot_run: false,
                                reason: None,
                            },
                            None => MethodPlan {
                                method_id: id.clone(),
                                label: facts.id.clone(),
                                version: facts.version.clone(),
                                group: facts.group.as_str().to_string(),
                                min_draws: facts.min_draws,
                                entry: None,
                                target: RunTarget::TrainMethod,
                                cannot_run: true,
                                reason: Some(TxrRunReason::from_engine(
                                    EngineReasonCode::EnvUnknown,
                                    format!("no published environment for method {id:?}"),
                                )),
                            },
                        }
                    }
                };
                plans.push(plan);
            }
        }
        super::types::TxrRunMode::Reuse => {
            for asset in assets {
                let facts = envmanifest::facts_for(&asset.method_id).expect("checked at start");
                let plan = match envmanifest::env_for(&asset.method_id) {
                    None => MethodPlan {
                        method_id: asset.model_id.clone(),
                        label: asset.method_id.clone(),
                        version: fact_version(&facts, asset),
                        group: facts.group.as_str().to_string(),
                        min_draws: facts.min_draws,
                        entry: None,
                        target: RunTarget::ReuseModel {
                            asset: asset.clone(),
                        },
                        cannot_run: true,
                        reason: Some(TxrRunReason::from_engine(
                            EngineReasonCode::EnvUnknown,
                            format!("no published environment for method {:?}", asset.method_id),
                        )),
                    },
                    Some(entry) => {
                        // The verify-before-bind gate (CONS-EE-6): a tampered
                        // asset dir is refused BEFORE any spawn.
                        match crate::modules::sandbox::stack::verify_model_tree(
                            Path::new(&asset.host_dir),
                            &asset.tree_sha256,
                        ) {
                            Ok(()) => MethodPlan {
                                method_id: asset.model_id.clone(),
                                label: asset.method_id.clone(),
                                version: fact_version(&facts, asset),
                                group: facts.group.as_str().to_string(),
                                min_draws: facts.min_draws,
                                entry: Some(entry),
                                target: RunTarget::ReuseModel {
                                    asset: asset.clone(),
                                },
                                cannot_run: false,
                                reason: None,
                            },
                            Err(e) => MethodPlan {
                                method_id: asset.model_id.clone(),
                                label: asset.method_id.clone(),
                                version: fact_version(&facts, asset),
                                group: facts.group.as_str().to_string(),
                                min_draws: facts.min_draws,
                                entry: Some(entry),
                                target: RunTarget::ReuseModel {
                                    asset: asset.clone(),
                                },
                                cannot_run: true,
                                reason: Some(TxrRunReason {
                                    code: e.error_code().to_string(),
                                    detail: e.to_string(),
                                }),
                            },
                        }
                    }
                };
                plans.push(plan);
            }
        }
    }
    Ok(plans)
}

fn fact_version(facts: &Method, asset: &super::types::TxrModelAsset) -> String {
    if asset.method_version.is_empty() {
        facts.version.clone()
    } else {
        asset.method_version.clone()
    }
}

/// Insert the classified rows: queued → `waiting` (with the manifest's
/// `bytes_total` — the F counter's denominator), cannot-run → the row with its
/// reason (INV-2 — the verdict is IN the record from the first read).
async fn persist_plans(
    repo: &TxrRepository,
    run_id: Uuid,
    plans: &[MethodPlan],
) -> Result<(), AppError> {
    for plan in plans {
        let new = NewMethod {
            id: Uuid::new_v4(),
            run_id,
            method_id: plan.method_id.clone(),
            label: plan.label.clone(),
            version: plan.version.clone(),
            group: plan.group.clone(),
            state: if plan.cannot_run {
                TxrMethodState::CannotRun
            } else {
                TxrMethodState::Waiting
            },
            bytes_total: plan.entry.map(|e| e.size_bytes),
        };
        let _ = repo.insert_method(&new).await?;
        if let Some(reason) = plan.reason.clone() {
            let patch = MethodPatch {
                reason: Some(reason),
                ..Default::default()
            };
            // The reason patch writes only the reason columns; the state is
            // already `cannot_run` from the insert.
            let _ = repo.patch_method(run_id, &plan.method_id, &patch).await?;
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// drive_run — the detached task + finalize
// ─────────────────────────────────────────────────────────────────────────────

/// The drive task: set the run `running`, drive every queued method through
/// the lanes, then finalize. The finally-arms: deregister the drive + restore
/// the global cap (the run row's terminal state is written by the body — a
/// never-terminal drive is the boot reconcile's `INTERRUPTED`).
async fn drive_run(drive: Arc<RunDrive>, prepared: Arc<PreparedRun>) {
    let run_id = drive.run_id;
    if let Err(e) = run_drive_body(&drive, &prepared).await {
        tracing::error!(%run_id, error = %e, "execution engine run drive failed");
        // The body's finally-arm: a body error (a failed DB write, a finalize
        // failure) must not leave a live-state row behind for the boot
        // reconcile to find at the NEXT restart — terminalize here, with the
        // error in the record (INV-2). `finish_run`'s guarded UPDATE makes
        // this a no-op on a run that already turned terminal mid-body.
        let counts = drive
            .repo
            .method_counts(run_id)
            .await
            .unwrap_or(TxrRunCounts {
                finished: 0,
                failed: 0,
                stopped: 0,
                skipped: 0,
                cannot_run: 0,
                running: 0,
                downloading: 0,
                waiting: 0,
            });
        let elapsed = drive
            .repo
            .get_run(run_id)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.started_at)
            .map(|s| (Utc::now() - s).num_seconds().max(0) as u64)
            .unwrap_or(0);
        let _ = drive
            .repo
            .finish_run(
                run_id,
                TxrRunStatus::Failed,
                elapsed,
                &counts,
                false,
                Some(e.to_string()),
            )
            .await;
    }
    unregister_drive(run_id);
    let guard = {
        let mut g = drive.cap_guard.lock().unwrap_or_else(|e| e.into_inner());
        g.take()
    };
    if let Some(guard) = guard {
        guard.restore(&drive.pool, drive.owner, run_id).await;
    }
}

async fn run_drive_body(
    drive: &Arc<RunDrive>,
    prepared: &Arc<PreparedRun>,
) -> Result<(), AppError> {
    let repo = &drive.repo;
    repo.set_run_status(drive.run_id, TxrRunStatus::Running, Some(Utc::now()))
        .await?;
    drive.broadcast_status(TxrRunStatus::Running).await;
    drive
        .append_log(
            None,
            &format!("run {} started", &drive.dir.to_string_lossy()),
        )
        .await;

    let queued: Vec<&MethodPlan> = prepared.plans.iter().filter(|p| !p.cannot_run).collect();
    if queued.is_empty() {
        return finalize_run(drive).await;
    }

    let mut handles = Vec::with_capacity(queued.len());
    for plan in queued {
        let drive = drive.clone();
        let prepared = prepared.clone();
        let plan = clone_plan(plan);
        handles.push(tokio::spawn(run_method_via_lanes(drive, prepared, plan)));
    }
    for h in handles {
        let _ = h.await;
    }
    finalize_run(drive).await
}

fn clone_plan(plan: &MethodPlan) -> MethodPlan {
    // `&'static ManifestEntry` is Copy; the rest is cloned — the per-method
    // task owns its plan.
    MethodPlan {
        method_id: plan.method_id.clone(),
        label: plan.label.clone(),
        version: plan.version.clone(),
        group: plan.group.clone(),
        min_draws: plan.min_draws,
        entry: plan.entry,
        target: match &plan.target {
            RunTarget::TrainMethod => RunTarget::TrainMethod,
            RunTarget::ReuseModel { asset } => RunTarget::ReuseModel {
                asset: asset.clone(),
            },
        },
        cannot_run: plan.cannot_run,
        reason: plan.reason.clone(),
    }
}

/// The run finalize (ITEM-9 grows it with the estimate + the ingest-derived
/// `predictions_ready` refinement; the ITEM-8 skeleton finalizes on the rows'
/// terminal states):
/// - stopped by the user → `stopped` (EXAMPLE-EE-3);
/// - otherwise → `finished`, `predictions_ready = finished > 0`.
async fn finalize_run(drive: &RunDrive) -> Result<(), AppError> {
    let counts = drive.repo.method_counts(drive.run_id).await?;
    let predictions_ready = counts.finished > 0;
    let run_stopped = *drive.run_stop.borrow();
    let status = if run_stopped {
        TxrRunStatus::Stopped
    } else {
        TxrRunStatus::Finished
    };
    let elapsed = drive
        .repo
        .get_run(drive.run_id)
        .await?
        .and_then(|r| r.started_at)
        .map(|s| (Utc::now() - s).num_seconds().max(0) as u64)
        .unwrap_or(0);
    drive
        .repo
        .finish_run(
            drive.run_id,
            status,
            elapsed,
            &counts,
            predictions_ready,
            None,
        )
        .await?;
    drive.broadcast_status(status).await;
    drive
        .append_log(None, &finalize_line(status, &counts))
        .await;
    drive.runtime.close_run(drive.run_id);
    Ok(())
}

fn finalize_line(status: TxrRunStatus, counts: &TxrRunCounts) -> String {
    match status {
        TxrRunStatus::Finished => format!(
            "run finished: {} done, {} failed, {} skipped, {} stopped, {} waiting, {} cannot run",
            counts.finished,
            counts.failed,
            counts.skipped,
            counts.stopped,
            counts.waiting,
            counts.cannot_run
        ),
        TxrRunStatus::Stopped => "stopped by the user".to_string(),
        _ => format!("run ended ({})", status.as_str()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-method drive: lanes → env → admission → execute → terminal
// ─────────────────────────────────────────────────────────────────────────────

/// The env phase's outcome (the caller patches the row terminal).
enum EnvPhase {
    Ready(EnvFacts),
    Failed(TxrRunReason),
    /// A user stop/skip; `skipped` selects the row's state (`skipped` vs
    /// `stopped` — stop-all + skip of a download turn `skipped`).
    UserStopped {
        skipped: bool,
    },
}

async fn run_method_via_lanes(drive: Arc<RunDrive>, prepared: Arc<PreparedRun>, plan: MethodPlan) {
    let method_id = plan.method_id.clone();
    let ctl = drive.method_control(&method_id);
    let mut stop_rx = ctl.stop.subscribe();
    let mut skip_rx = ctl.skip.subscribe();
    let mut run_stop_rx = drive.run_stop.clone();

    // Lane wait: the queue's first gate. A stop/skip observed here never runs
    // the method. PROV-EE-6's stop-all shape: a WAITING method turns `skipped`;
    // a per-method stop of a waiting method turns `stopped` + ABORTED; a skip
    // turns `skipped`.
    let _permit = loop {
        if *run_stop_rx.borrow() || *skip_rx.borrow() {
            drive.patch_terminal_skip(&method_id).await;
            return;
        }
        if *stop_rx.borrow() {
            drive
                .patch_terminal(
                    &method_id,
                    TxrMethodState::Stopped,
                    Some(TxrRunReason::from_engine(
                        EngineReasonCode::Aborted,
                        "stopped by the user",
                    )),
                )
                .await;
            return;
        }
        if let Some(p) = drive.lanes.try_acquire() {
            break p;
        }
        tokio::select! {
            _ = drive.lanes.when_free() => {}
            _ = stop_rx.changed() => {}
            _ = skip_rx.changed() => {}
            _ = run_stop_rx.changed() => {}
        }
    };

    // Env phase (the `downloading` state; a stop here cancels the download).
    let env_facts = match ensure_method_env(
        &drive,
        &plan,
        &mut stop_rx,
        &mut skip_rx,
        &mut run_stop_rx,
    )
    .await
    {
        EnvPhase::Ready(facts) => facts,
        EnvPhase::Failed(reason) => {
            drive
                .patch_terminal(&method_id, TxrMethodState::Failed, Some(reason))
                .await;
            return;
        }
        EnvPhase::UserStopped { skipped } => {
            let completion = if skipped {
                drive.patch_terminal_skip(&method_id).await
            } else {
                drive
                    .patch_terminal(
                        &method_id,
                        TxrMethodState::Stopped,
                        Some(TxrRunReason::from_engine(
                            EngineReasonCode::Aborted,
                            "stopped by the user",
                        )),
                    )
                    .await
            };
            let _ = completion;
            return;
        }
    };

    // Admission (DEC-3/4): the jobs row is the slot + the cancel registration
    // + the provenance record. `register_cancel` BEFORE the admit: a stop
    // racing the spawn is not lost (the provenance-verify discipline).
    let job_id = Uuid::new_v4();
    crate::modules::jobs::runtime::runtime().register_cancel(job_id);
    drive.record_job(&method_id, job_id);
    let label = drive
        .dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "run".to_string());
    let admitted = crate::modules::jobs::admission::admit_within(
        &drive.pool,
        job_id,
        drive.owner,
        "sandbox",
        &format!("{method_id} on {label}"),
        serde_json::json!({ "run_id": drive.run_id, "method_id": method_id }),
        None,
        crate::modules::jobs::admission::ADMISSION_WAIT,
        crate::modules::jobs::admission::ADMISSION_POLL,
    )
    .await;
    let job = match admitted {
        Ok(Some(job)) => job,
        Ok(None) => {
            // The detached wait budget expired with the pool still full — a
            // terminal, recorded refusal (never a silent skip; TEST-EE-13's
            // "returns the wait rather than dropping the run").
            let reason = TxrRunReason::from_engine(
                EngineReasonCode::SandboxUnavailable,
                format!(
                    "the compute pool stayed full for {}s",
                    crate::modules::jobs::admission::ADMISSION_WAIT.as_secs()
                ),
            );
            drive
                .patch_terminal(&method_id, TxrMethodState::Failed, Some(reason))
                .await;
            return;
        }
        Err(e) => {
            let reason = execution_failure_reason(&e);
            drive
                .patch_terminal(&method_id, TxrMethodState::Failed, Some(reason))
                .await;
            return;
        }
    };
    let _ = job;
    let patch = super::repository::MethodPatch {
        state: Some(TxrMethodState::Running),
        phase: Some(TxrPhase::Fit),
        job_id: Some(job_id),
        env_base_digest: Some(env_facts.base_digest.clone()),
        env_layer_digest: Some(env_facts.layer_digest.clone()),
        ..Default::default()
    };
    if let Err(e) = drive.patch(&method_id, patch).await {
        tracing::warn!(%method_id, error = %e, "execution engine: running patch failed");
    }

    // Execute (ITEM-9's seam), then the finally-shaped close: the admitted
    // jobs row is terminal on EVERY exit path (the provenance-verify
    // discipline — a running row holds a global slot forever).
    let cancel = crate::modules::jobs::runtime::runtime()
        .cancel_receiver(job_id)
        .unwrap_or_else(|| watch::channel(false).1);
    let ctx = super::orchestrator::MethodRunContext {
        run_id: drive.run_id,
        method_id: method_id.clone(),
        label: plan.label.clone(),
        version: plan.version.clone(),
        group: plan.group.clone(),
        min_draws: plan.min_draws,
        env: env_facts.clone(),
        job_id,
        cancel: cancel.clone(),
        config: drive.config.clone(),
        cpus: drive.cpus,
        train: prepared.train.clone(),
        predict: prepared.predict.clone(),
        predict_patients: prepared.predict_patients.clone(),
        run_dir: drive.dir.clone(),
        save_models: drive.config.save_models,
    };
    let outcome = drive.executor.execute(ctx).await;
    let failure = outcome.as_ref().err().map(|e| e.to_string());
    crate::modules::jobs::admission::close_slot(&drive.pool, job_id, failure.as_deref()).await;

    match outcome {
        Ok(outcome) => {
            let started = drive
                .repo
                .get_method(drive.run_id, &method_id)
                .await
                .ok()
                .flatten()
                .and_then(|m| m.started_at);
            let elapsed = started
                .map(|s| (Utc::now() - s).num_seconds().max(0) as u64)
                .unwrap_or(0);
            let patch = MethodPatch {
                state: Some(outcome.state),
                reason: outcome.reason.clone(),
                exit_code: outcome.exit_code,
                duration_ms: outcome.duration_ms,
                elapsed_secs: Some(elapsed),
                prob_source: outcome.prob_source,
                coverage_scored: outcome.coverage.as_ref().map(|c| c.scored),
                coverage_eligible: outcome.coverage.as_ref().map(|c| c.eligible),
                task: outcome.task,
                finished_at: Some(Utc::now()),
                model_out_digest: outcome.model.as_ref().map(|m| m.model_out_digest.clone()),
                model_dir: outcome.model.as_ref().map(|m| m.dir.clone()),
                trained_on_patients: outcome.model.as_ref().map(|m| m.trained_on_patients),
                size_bytes: outcome.model.as_ref().map(|m| m.size_bytes),
                own_auc: outcome.model.as_ref().and_then(|m| m.own_auc),
                ..Default::default()
            };
            if let Err(e) = drive.patch(&method_id, patch).await {
                tracing::warn!(%method_id, error = %e, "execution engine: terminal patch failed");
            }
            // The frames: method (already broadcast by patch) + the finished
            // column announcement + the engine line.
            if let (Some(ps), Some(cov)) = (&outcome.prob_source, &outcome.coverage) {
                let frame = super::types::TxrRunPredictionFrame {
                    method_id: method_id.clone(),
                    prob_source: ps.as_str().to_string(),
                    coverage_fraction: cov.fraction,
                    scored: cov.scored as u64,
                    eligible: cov.eligible as u64,
                };
                drive.runtime.broadcast(
                    drive.run_id,
                    super::types::TxrRunEvent::Prediction(frame).into(),
                );
            }
            match outcome.state {
                TxrMethodState::Finished => {
                    drive
                        .append_log(Some(&method_id), &format!("{method_id} done in {elapsed}s"))
                        .await;
                }
                TxrMethodState::Failed => {
                    let reason = outcome.reason.unwrap_or_else(|| {
                        TxrRunReason::from_engine(EngineReasonCode::PredictionInvalid, "failed")
                    });
                    drive
                        .append_log(
                            Some(&method_id),
                            &format!("{method_id} failed: {} — {}", reason.code, reason.detail),
                        )
                        .await;
                }
                TxrMethodState::Stopped => {
                    drive
                        .append_log(Some(&method_id), "stopped by the user")
                        .await;
                }
                _ => {}
            }
        }
        Err(e) => {
            let aborted = e.error_code() == EngineReasonCode::Aborted.as_str();
            let reason = execution_failure_reason(&e);
            let state = if aborted {
                TxrMethodState::Stopped
            } else {
                TxrMethodState::Failed
            };
            drive.patch_terminal(&method_id, state, Some(reason)).await;
        }
    }
}

/// One state transition to a terminal state + reason (the shared tail of the
/// stop/skip/fail arms).
impl RunDrive {
    async fn patch_terminal(
        &self,
        method_id: &str,
        state: TxrMethodState,
        reason: Option<TxrRunReason>,
    ) {
        let patch = MethodPatch {
            state: Some(state),
            reason,
            finished_at: Some(Utc::now()),
            ..Default::default()
        };
        if let Err(e) = self.patch(method_id, patch).await {
            tracing::warn!(%method_id, error = %e, "execution engine: terminal patch failed");
        }
        self.append_log(Some(method_id), &format!("{method_id} ended"))
            .await;
    }

    async fn patch_terminal_skip(&self, method_id: &str) {
        let patch = MethodPatch {
            state: Some(TxrMethodState::Skipped),
            finished_at: Some(Utc::now()),
            ..Default::default()
        };
        if let Err(e) = self.patch(method_id, patch).await {
            tracing::warn!(%method_id, error = %e, "execution engine: skip patch failed");
        }
        self.append_log(Some(method_id), "skipped").await;
    }
}

/// The env phase: `downloading` while the base + layer `ensure` run (blocking
/// on `spawn_blocking`), with the 500 ms status poll driving
/// `bytes_downloaded` → row patch + `method`/`progress` frames. Stops cancel
/// the in-flight download.
async fn ensure_method_env(
    drive: &RunDrive,
    plan: &MethodPlan,
    stop_rx: &mut watch::Receiver<bool>,
    skip_rx: &mut watch::Receiver<bool>,
    run_stop_rx: &mut watch::Receiver<bool>,
) -> EnvPhase {
    let entry = match plan.entry {
        Some(e) => e,
        None => {
            return EnvPhase::Failed(TxrRunReason::from_engine(
                EngineReasonCode::EnvUnknown,
                format!("no published environment for method {:?}", plan.method_id),
            ));
        }
    };
    let base = base_env_ref(entry);
    let layer = layer_env_ref(entry);
    let base_digest = base.digest.clone();
    let layer_digest = layer.digest.clone();
    let layer_id = entry.env_id.clone();
    let base_id = base_env_id(entry);
    let budget = crate::modules::sandbox::settings_cache::get(&drive.pool)
        .await
        .staging_budget();

    drive
        .append_log(
            Some(&plan.method_id),
            &format!(
                "starting environment (base {}, layer {} MB)",
                base_id,
                entry.size_bytes / (1024 * 1024)
            ),
        )
        .await;
    let patch = MethodPatch {
        state: Some(TxrMethodState::Downloading),
        phase: Some(TxrPhase::Env),
        started_at: Some(Utc::now()),
        ..Default::default()
    };
    if let Err(e) = drive.patch(&plan.method_id, patch).await {
        tracing::warn!(method_id = %plan.method_id, error = %e, "execution engine: downloading patch failed");
    }

    let env_ensure = drive.env.clone();
    let env_poll = drive.env.clone();
    let base_r = base.clone();
    let layer_r = layer.clone();
    let budget_c = budget;
    let ensure_task = tokio::task::spawn_blocking(move || {
        let base_mount = env_ensure.ensure(&base_r, EnvKind::Base, budget_c)?;
        let layer_mount = env_ensure.ensure(&layer_r, EnvKind::Layer, budget_c)?;
        Ok::<_, AppError>((base_mount, layer_mount))
    });

    let mut last_bytes = 0u64;
    let mut last_state = crate::modules::sandbox::method_env::MethodEnvState::NotDownloaded;
    let mut base_logged = false;
    let mut ensure_task_handle = ensure_task;
    let phase = loop {
        tokio::select! {
            biased;
            result = &mut ensure_task_handle => {
                match result {
                    Ok(Ok((_base_mount, _layer_mount))) => {
                        // The record: the verified pins (ensure verified the
                        // bytes against exactly these digests).
                        break EnvPhase::Ready(EnvFacts {
                            base,
                            layer,
                            base_digest,
                            layer_digest,
                        });
                    }
                    Ok(Err(e)) => break EnvPhase::Failed(env_failure_reason(&e)),
                    Err(e) => break EnvPhase::Failed(execution_failure_reason(&AppError::internal_error(format!("env ensure task join: {e}")))),
                }
            }
            _ = tokio::time::sleep(ENV_POLL_INTERVAL) => {
                let st = env_poll.status(&layer_id);
                if st.bytes_downloaded != last_bytes || st.state != last_state {
                    let changed = st.bytes_downloaded.saturating_sub(last_bytes);
                    last_bytes = st.bytes_downloaded;
                    last_state = st.state;
                    let patch = MethodPatch {
                        bytes_downloaded: Some(st.bytes_downloaded),
                        ..Default::default()
                    };
                    if let Err(e) = drive.patch(&plan.method_id, patch).await {
                        tracing::warn!(method_id = %plan.method_id, error = %e, "execution engine: byte patch failed");
                    }
                    let pct = if entry.size_bytes > 0 {
                        Some((st.bytes_downloaded as f64 / entry.size_bytes as f64) * 100.0)
                    } else {
                        None
                    };
                    drive
                        .broadcast_progress(
                            &plan.method_id,
                            Some(TxrPhase::Env),
                            pct,
                            Some(format!("downloading {} ({changed} bytes since last poll)", plan.method_id)),
                        )
                        .await;
                }
                // The base download's own line (the shared base is never a row
                // counter — the row's bytes are the method's layer): the line
                // lands ONCE per env phase when the base turns ready (the
                // provider's cache makes later attempts instant).
                if !base_logged {
                    let base_st = env_poll.status(&base_id);
                    if base_st.state == crate::modules::sandbox::method_env::MethodEnvState::Ready {
                        base_logged = true;
                        drive
                            .append_log(
                                Some(&plan.method_id),
                                &format!("base environment {base_id} ready"),
                            )
                            .await;
                    }
                }
            }
            _ = run_stop_rx.changed() => {
                // A stop-all signals BOTH the run stop AND this method's stop
                // flag — the run-stop arm must win over the per-method stop
                // arm, or the two in-flight downloads would turn into
                // different states nondeterministically. PROV-EE-6's stop-all
                // typing: waiting/downloading methods turn `skipped`; a
                // PER-METHOD stop (stop flag alone, no run stop, no skip) is
                // the one `stopped` + ABORTED shape. (`biased;` above gives
                // exactly this priority.)
                cancel_env(&env_poll, &base_id, &layer_id);
                break EnvPhase::UserStopped { skipped: true };
            }
            _ = skip_rx.changed() => {
                cancel_env(&env_poll, &base_id, &layer_id);
                break EnvPhase::UserStopped { skipped: true };
            }
            _ = stop_rx.changed() => {
                cancel_env(&env_poll, &base_id, &layer_id);
                break EnvPhase::UserStopped { skipped: false };
            }
        }
    };

    // A stopped env phase left the ensure task to unwind itself (the cancel
    // was issued; the attempt's worker joins within the provider's own
    // CANCEL_JOIN_TIMEOUT) — the task handle is dropped, its result never
    // read, which is the honest post-cancel state.
    phase
}

/// Cancel both envs of a stopped download (fire-and-forget: the provider's
/// cancel joins the worker on its own thread and bounds itself; the drive
/// must not block up to 30 s on the async side).
fn cancel_env(env: &Arc<dyn EnvProvider>, base_id: &str, layer_id: &str) {
    let env = env.clone();
    let base_id = base_id.to_string();
    let layer_id = layer_id.to_string();
    tokio::task::spawn_blocking(move || {
        env.cancel(&base_id);
        env.cancel(&layer_id);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-EE-01 note (b)'s RunRuntime half lives in runtime.rs; the
// in-crate pins here are the item's own unit half of TEST-EE-06 (run-start
// classification), TEST-EE-12/13/17's loopback-free halves (lane cap, enqueue
// stop/skip, env failure typing, admission finally-shape) over the module +
// merged chains with scripted fixtures (TESTS.md note (bb) precedent).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::modules::execution_engine::repository::TxrRepository;
    use crate::modules::execution_engine::types::{
        CreateRunRequest, RunConfig, TxrMethodEnv, TxrRunInput, TxrRunMode, TxrTask,
    };
    use crate::modules::file_validator::types::{ParsedTable, ParsedTableSource, TableFormat};
    use crate::modules::sandbox::method_env::{EnvKind, MethodEnvState};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    // ── fixture tables (the board shape: four outcome columns, one marker
    //    with a baseline + two on-treatment draws per patient) ──────────────

    fn table(columns: &[&str], rows: &[&[&str]]) -> ParsedTable {
        ParsedTable {
            source: ParsedTableSource {
                name: "fixture.csv".to_string(),
                format: TableFormat::Csv,
            },
            header_row: 1,
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows: rows
                .iter()
                .map(|r| r.iter().map(|c| Some(c.to_string())).collect())
                .collect(),
        }
    }

    fn patients_table() -> ParsedTable {
        table(
            &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
            &[
                &["P1", "100", "1", "140", "0"],
                &["P2", "60", "1", "60", "1"],
                &["P3", "200", "0", "200", "0"],
                &["P4", "90", "1", "120", "0"],
                &["P5", "150", "0", "150", "0"],
                &["P6", "75", "1", "75", "1"],
            ],
        )
    }

    /// 6 patients × draws at days 0 (baseline), 28, 56 (on-treatment) — the
    /// 3-draw fixture the `min_draws: 3` method needs.
    fn measurements_table() -> ParsedTable {
        let mut rows = Vec::new();
        for p in 1..=6 {
            for (day, value) in [("0", "100"), ("28", "110"), ("56", "105")] {
                rows.push(vec![
                    format!("P{p}"),
                    day.to_string(),
                    "14804-9".to_string(),
                    value.to_string(),
                    "U/L".to_string(),
                ]);
            }
        }
        let columns = vec![
            "patient_id".to_string(),
            "day".to_string(),
            "marker".to_string(),
            "value".to_string(),
            "unit".to_string(),
        ];
        ParsedTable {
            source: ParsedTableSource {
                name: "values.csv".to_string(),
                format: TableFormat::Csv,
            },
            header_row: 1,
            columns,
            rows: rows
                .into_iter()
                .map(|r| r.into_iter().map(Some).collect())
                .collect(),
        }
    }

    fn run_request(methods: &[&str], at_a_time: u32, keep_copies: bool) -> CreateRunRequest {
        CreateRunRequest {
            mode: TxrRunMode::Train,
            input: TxrRunInput {
                patients: Some(patients_table()),
                measurements: measurements_table(),
                predict_measurements: None,
                joins: Vec::new(),
                mapping: Vec::new(),
                keep_copies,
            },
            config: RunConfig {
                at_a_time,
                decision_day: 56.0,
                look_ahead_day: 238.0,
                ..Default::default()
            },
            method_ids: methods.iter().map(|s| s.to_string()).collect(),
            model_ids: Vec::new(),
        }
    }

    /// The full app chain (the jobs + sandbox settings tables the admission
    /// wrapper reads; the four module tables are a subset — the merged chain
    /// is the integration harness's template DB shape, TESTS.md note (bb)).
    async fn merged_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory pool connects");
        sqlx::query!("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("foreign keys on");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR.run(&pool).await.expect("merged migrations apply");
        // The admission INSERT's `jobs.owner_id` is a FK into `users` (the
        // harness seeds users; the in-crate pool seeds one fixture user).
        sqlx::query!(
            "INSERT INTO users (id, username, email) VALUES (X'00000000000000000000000000000001', 'txr-fixture', 'txr-fixture@example.test')"
        )
        .execute(&pool)
        .await
        .expect("fixture user inserts");
        pool
    }

    /// The fixture owner (the seeded users row + every admission's owner_id).
    fn owner() -> Uuid {
        Uuid::from_u128(1)
    }

    /// The per-test app data root (under the worktree's gitignored `target/`
    /// — run dirs never touch the repo).
    fn test_data_dir(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("target")
            .join("txr-execution-engine-item8")
            .join(name)
    }

    async fn wait_terminal(repo: &TxrRepository, run_id: Uuid) -> super::super::repository::RunRow {
        for _ in 0..500 {
            if let Some(r) = repo.get_run(run_id).await.expect("get_run") {
                let s = r.status().expect("status parses");

                if matches!(
                    s,
                    TxrRunStatus::Finished | TxrRunStatus::Failed | TxrRunStatus::Stopped
                ) {
                    return r;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("run {run_id} did not turn terminal");
    }

    // ── the scripted fixtures ──────────────────────────────────────────────

    #[derive(Clone, Copy)]
    enum EnvPolicy {
        Ready,
        Downloading { total: u64 },
        Fail { code: &'static str },
    }

    #[derive(Clone)]
    struct FakeEnv {
        inner: Arc<FakeEnvInner>,
    }

    struct FakeEnvInner {
        ensure_delay: Duration,
        policy: Mutex<std::collections::HashMap<String, EnvPolicy>>,
        progress: Mutex<std::collections::HashMap<String, (std::time::Instant, u64)>>,
        cancelled: Mutex<Vec<String>>,
    }

    impl FakeEnv {
        fn new(delay: Duration) -> Self {
            Self {
                inner: Arc::new(FakeEnvInner {
                    ensure_delay: delay,
                    policy: Mutex::new(std::collections::HashMap::new()),
                    progress: Mutex::new(std::collections::HashMap::new()),
                    cancelled: Mutex::new(Vec::new()),
                }),
            }
        }

        fn set(&self, env_id: &str, policy: EnvPolicy) {
            self.inner
                .policy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(env_id.to_string(), policy);
        }

        fn cancelled(&self) -> Vec<String> {
            self.inner
                .cancelled
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    fn ref_env_id(r: &EnvRef) -> String {
        r.oci_ref
            .rsplit('/')
            .next()
            .unwrap_or(&r.oci_ref)
            .split('@')
            .next()
            .unwrap_or(&r.oci_ref)
            .to_string()
    }

    impl EnvProvider for FakeEnv {
        fn ensure(
            &self,
            r: &EnvRef,
            _kind: EnvKind,
            _deadline: Duration,
        ) -> Result<ProvidedMount, AppError> {
            let env_id = ref_env_id(r);
            let policy = self
                .inner
                .policy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&env_id)
                .copied()
                .unwrap_or(EnvPolicy::Ready);
            self.inner
                .progress
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(env_id, (std::time::Instant::now(), 0));
            std::thread::sleep(self.inner.ensure_delay);
            match policy {
                EnvPolicy::Fail { code } => Err(AppError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    code,
                    "fixture download failed",
                )),
                EnvPolicy::Ready | EnvPolicy::Downloading { .. } => Ok(ProvidedMount {
                    mount_dir: PathBuf::from("/fixture-mount"),
                    digest: Some("a".repeat(64)),
                }),
            }
        }

        fn status(&self, env_id: &str) -> MethodEnvStatus {
            let policy = self
                .inner
                .policy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(env_id)
                .copied()
                .unwrap_or(EnvPolicy::Ready);
            let mut progress = self
                .inner
                .progress
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let (started, bytes) = progress
                .get(env_id)
                .copied()
                .unwrap_or((std::time::Instant::now(), 0));
            let state = match policy {
                EnvPolicy::Fail { .. } => MethodEnvState::Failed,
                EnvPolicy::Ready => MethodEnvState::Ready,
                EnvPolicy::Downloading { total } => {
                    let mut now = bytes;
                    if now < total {
                        now = ((started.elapsed().as_secs_f64() * 64.0 * 1024.0) as u64).min(total);
                        progress.insert(env_id.to_string(), (started, now));
                    }
                    if now >= total {
                        MethodEnvState::Ready
                    } else {
                        MethodEnvState::Downloading
                    }
                }
            };
            MethodEnvStatus {
                env_id: env_id.to_string(),
                kind: EnvKind::Layer,
                state,
                bytes_downloaded: bytes,
                bytes_total: match policy {
                    EnvPolicy::Downloading { total } => Some(total),
                    _ => None,
                },
                digest: None,
                mounted: false,
                error: None,
            }
        }

        fn cancel(&self, env_id: &str) {
            self.inner
                .cancelled
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(env_id.to_string());
        }
    }

    fn finish_outcome() -> MethodOutcome {
        MethodOutcome {
            state: TxrMethodState::Finished,
            reason: None,
            exit_code: Some(0),
            duration_ms: Some(42),
            prob_source: Some(TxrProbSource::Native),
            coverage: Some(TxrCoverage {
                scored: 6,
                eligible: 6,
                fraction: 1.0,
            }),
            task: Some(TxrTask::Pfs),
            model: Some(ProducedModelFacts {
                model_out_digest: "aa".repeat(32),
                dir: "/fixture/model".to_string(),
                trained_on_patients: 6,
                size_bytes: 1234,
                own_auc: Some(0.7),
            }),
        }
    }

    struct FakeExecutor {
        sleep: Duration,
        runs: Arc<Mutex<Vec<String>>>,
        concurrency: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        fail_code: Option<&'static str>,
        wait_for_cancel: bool,
    }

    impl FakeExecutor {
        fn new(sleep: Duration) -> Self {
            Self {
                sleep,
                runs: Arc::new(Mutex::new(Vec::new())),
                concurrency: Arc::new(AtomicUsize::new(0)),
                peak: Arc::new(AtomicUsize::new(0)),
                fail_code: None,
                wait_for_cancel: false,
            }
        }
    }

    #[async_trait]
    impl MethodExecutor for FakeExecutor {
        async fn execute(&self, ctx: MethodRunContext) -> Result<MethodOutcome, AppError> {
            self.runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(ctx.method_id.clone());
            let now = self.concurrency.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = self.peak.fetch_max(now, Ordering::SeqCst);
            if self.wait_for_cancel {
                // A method being stopped: the ITEM-9 executor observes the
                // admitted job's cancel channel.
                let mut cancel = ctx.cancel;
                tokio::select! {
                    _ = cancel.changed() => {}
                    _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                }
                self.concurrency.fetch_sub(1, Ordering::SeqCst);
                if *cancel.borrow() {
                    return Err(AppError::new(
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "ABORTED",
                        "fixture: cancelled by the user",
                    ));
                }
                return Ok(finish_outcome());
            }
            tokio::time::sleep(self.sleep).await;
            self.concurrency.fetch_sub(1, Ordering::SeqCst);
            if let Some(code) = self.fail_code {
                return Err(AppError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    code,
                    "fixture execution failure",
                ));
            }
            Ok(finish_outcome())
        }
    }

    // ── the pure pieces (TEST-EE-12/13/17's loopback-free halves) ──────────

    #[test]
    fn lane_gate_holds_the_cap_and_applies_changes_from_the_next_admission() {
        let gate = LaneGate::new(2);
        let p1 = gate.try_acquire().expect("1st");
        let p2 = gate.try_acquire().expect("2nd");
        assert!(gate.try_acquire().is_none(), "third at cap → waits");
        assert_eq!(gate.active(), 2);

        // A mid-run lane raise admits the next method immediately.
        gate.set_lanes(3);
        let p3 = gate.try_acquire().expect("lane raise admits a new method");
        // A lowering never revokes a held permit.
        gate.set_lanes(1);
        assert_eq!(gate.active(), 3, "a running method is never interrupted");
        drop(p1);
        drop(p2);
        drop(p3);
        assert_eq!(gate.active(), 0);
        gate.set_lanes(1);
        let _p = gate
            .try_acquire()
            .expect("count applies from the next admission");
        assert!(gate.try_acquire().is_none());
    }

    #[test]
    fn env_refs_follow_the_manifest_pairs_verbatim() {
        let entry = envmanifest::ManifestEntry {
            env_id: "landmark-cox-current".to_string(),
            method_id: "landmark-cox-current".to_string(),
            method_version: "1.0.0".to_string(),
            language: envmanifest::EnvLanguage::R,
            arch: envmanifest::EnvArch::Amd64,
            oci_ref: "ghcr.io/tinnlab/txr-method-env-layers/landmark-cox-current".to_string(),
            tag: "1.0.0-amd64".to_string(),
            digest: format!("sha256:{}", "d".repeat(64)),
            layer_sha256: "e".repeat(64),
            size_bytes: 250 * 1024 * 1024,
            base_ref: "ghcr.io/tinnlab/txresbench-base-r:2.0".to_string(),
            base_digest: format!("sha256:{}", "f".repeat(64)),
            contract: "2.0".to_string(),
            licence: "fixture".to_string(),
            wrapper_code_sha256: "ab".repeat(32),
            layer_schema: 1,
        };

        let layer = layer_env_ref(&entry);
        assert_eq!(layer.oci_ref, entry.oci_ref);
        assert_eq!(layer.digest, entry.layer_sha256);
        assert_eq!(layer.tag.as_deref(), Some("1.0.0-amd64"));

        let base = base_env_ref(&entry);
        assert_eq!(
            base.oci_ref,
            format!("{TXR_BASE_REGISTRY_PREFIX}/base-r@{}", "f".repeat(64)),
            "language → the app's base repo, digest-addressed, NEVER the benchmark base_ref"
        );
        assert_eq!(
            base.digest,
            "f".repeat(64),
            "the pairing anchor minus the sha256: prefix"
        );
        assert!(
            base.tag.is_none(),
            "digest-addressed — a tag would be a moving ref"
        );
        assert_eq!(base_env_id(&entry), "base-r");
    }

    #[test]
    fn env_failure_reason_keeps_provider_codes_and_types_the_rest() {
        let staged = AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_STAGING_TIMEOUT",
            "budget spent",
        );
        assert_eq!(env_failure_reason(&staged).code, "ENV_STAGING_TIMEOUT");
        let verify = AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ENV_VERIFY_FAILED",
            "digest mismatch",
        );
        assert_eq!(env_failure_reason(&verify).code, "ENV_VERIFY_FAILED");
        let stray = AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "SOME_NEW_PROVIDER_CODE",
            "x",
        );
        assert_eq!(
            env_failure_reason(&stray).code,
            "ENV_UNREADY",
            "everything else is the engine's type"
        );
        let exec = AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "RECALIBRATION_FAILED",
            "unrankable",
        );
        assert_eq!(
            execution_failure_reason(&exec).code,
            "RECALIBRATION_FAILED",
            "executor codes keep their typing"
        );
    }

    #[test]
    fn per_method_cpus_is_the_lane_floor() {
        assert_eq!(per_method_cpus(8, 3), 2, "floor(8/3)");
        assert_eq!(
            per_method_cpus(16, 3),
            4,
            "clamped to the 4-CPU lane ceiling"
        );
        assert_eq!(per_method_cpus(2, 3), 1, "floor < 1 → 1");
        assert_eq!(per_method_cpus(1, 4), 1);
    }

    #[test]
    fn run_dir_name_is_the_board_folder_spelling() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-21T10:02:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let id = Uuid::parse_str("0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(run_dir_name(at, id), "analysis-2026-10-21-1002-01234567");
    }

    #[test]
    fn table_csv_round_trips_the_parser_cells() {
        let t = table(&["a", "b"], &[&["1", "x,y"], &["2", ""]]);
        assert_eq!(table_csv(&t), "a,b\n1,\"x,y\"\n2,\n");
    }

    /// TEST-EE-06's run-start half: the classification of the run's selected
    /// methods (queued + the two cannot-run shapes) — the fixture is a real
    /// validated file against the REAL provider engines, so the verdicts are
    /// the providers' own (one code path with the screens).
    #[test]
    fn starts_from_the_validators_own_marker_count_and_classification() {
        let req = run_request(
            &["landmark-cox-current", "jm-mem-lq", "bayes-pt-cure-joint"],
            2,
            true,
        );
        let prepared = prepare_run(
            &req.input,
            &req.config,
            TxrRunMode::Train,
            &req.method_ids,
            &[],
        )
        .expect("the fixture file validates + classifies");

        assert!(prepared.markers >= 1, "the marker column resolves");
        assert!(prepared.train.is_some() && prepared.predict.is_none());

        let by_id: std::collections::HashMap<_, _> = prepared
            .plans
            .iter()
            .map(|p| (p.method_id.as_str(), p))
            .collect();
        let cox = by_id["landmark-cox-current"];
        assert!(!cox.cannot_run, "survival task + draws met → queued");
        assert!(cox.entry.is_some(), "has a published environment");
        assert!(matches!(cox.target, RunTarget::TrainMethod));

        let jm = by_id["jm-mem-lq"];
        assert!(jm.cannot_run);
        assert_eq!(
            jm.reason.as_ref().map(|r| r.code.as_str()),
            Some("ENV_UNKNOWN"),
            "runnable method with no published environment — never a silent skip"
        );

        let bayes = by_id["bayes-pt-cure-joint"];
        assert!(bayes.cannot_run);
        assert_eq!(
            bayes.reason.as_ref().map(|r| r.code.as_str()),
            Some("TASK_INCOMPATIBLE"),
            "the provider's code verbatim (task-less method on an outcome file)"
        );
    }

    // ── the drive-loop halves over the merged chain (lanes, admission,
    //    stop/skip, env typing) ─────────────────────────────────────────────

    #[tokio::test]
    async fn start_run_drives_three_methods_within_the_lane_cap() {
        let _g = rootfs::scoped_data_root(test_data_dir("lane-cap"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let executor = Arc::new(FakeExecutor::new(Duration::from_millis(120)));
        let req = run_request(
            &["landmark-cox-current", "ctdna-tf-four-group", "jm-lme"],
            2,
            true,
        );
        let summary = start_run(
            pool.clone(),
            runtime.clone(),
            env,
            executor.clone(),
            owner(),
            req,
        )
        .await
        .expect("create");

        assert!(
            matches!(
                summary.status,
                TxrRunStatus::Preparing | TxrRunStatus::Running
            ),
            "the 202 summary is the classified run, already preparing/running"
        );
        let repo = TxrRepository::new(pool.clone());
        let row = wait_terminal(&repo, summary.id).await;
        assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);

        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        assert_eq!(methods.len(), 3);
        for m in &methods {
            assert_eq!(m.state, "finished", "{}", m.method_id);
            assert!(m.job_id.is_some(), "admitted via a jobs row");
            assert_eq!(m.reason_code, None);
            assert!(
                m.env_base_digest.as_deref().is_some_and(|d| d.len() == 64),
                "the verified base pin recorded (the ref's digest, 64 hex)"
            );
            assert!(
                m.model_out_digest.is_some(),
                "produced-model facts land on the row"
            );
        }
        assert_eq!(
            executor.peak.load(Ordering::SeqCst),
            2,
            "at_a_time 2 → never a third in running"
        );
        assert_eq!(
            executor
                .runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            3
        );

        // TEST-EE-13's half: every admitted jobs row is terminal (the
        // finally-shaped close on the success path).
        let jobs = crate::modules::jobs::repository::JobRepository::new(pool.clone());
        for m in &methods {
            let job_id = m.job_id.expect("admitted");
            let job = jobs.get_any(job_id).await.expect("get").expect("row");
            assert_ne!(job.status, "running", "close_slot closed it");
        }

        // The counts JSON matches the rows (ONE aggregate statement).
        let after = repo.get_run(summary.id).await.expect("get").unwrap();
        let counts: serde_json::Value = serde_json::from_str(&after.counts.to_string()).unwrap();
        assert_eq!(counts["finished"], 3);
        assert_eq!(after.predictions_ready, true);
    }

    #[tokio::test]
    async fn global_cap_bumps_for_the_run_and_restores_when_it_is_the_last() {
        let _g = rootfs::scoped_data_root(test_data_dir("cap-bump"));
        let pool = merged_pool().await;
        let settings = crate::modules::jobs::settings::JobSettingsRepository::new(pool.clone());
        let before = settings.get().await.expect("settings");
        assert_eq!(before.max_concurrent_jobs, 2, "the seeded default");

        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let executor = Arc::new(FakeExecutor::new(Duration::from_millis(80)));
        let req = run_request(&["landmark-cox-current"], 3, true);
        let summary = start_run(pool.clone(), runtime, env, executor, owner(), req)
            .await
            .expect("create");
        let bumped = settings.get().await.expect("settings");
        assert_eq!(
            bumped.max_concurrent_jobs, 3,
            "DEC-6: the run's lanes are not silently capped"
        );

        let repo = TxrRepository::new(pool.clone());
        let _ = wait_terminal(&repo, summary.id).await;
        // The restore is the drive's final arm — poll briefly.
        let mut restored = false;
        for _ in 0..100 {
            if settings.get().await.expect("settings").max_concurrent_jobs == 2 {
                restored = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(restored, "the LAST drive restores the previous cap");
    }

    #[tokio::test]
    async fn stop_all_marks_waiting_skipped_and_running_stopped() {
        let _g = rootfs::scoped_data_root(test_data_dir("stop-all"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let mut executor = FakeExecutor::new(Duration::ZERO);
        executor.wait_for_cancel = true;
        let executor = Arc::new(executor);
        let req = run_request(
            &["landmark-cox-current", "ctdna-tf-four-group", "jm-lme"],
            2,
            true,
        );
        let summary = start_run(pool.clone(), runtime, env, executor.clone(), owner(), req)
            .await
            .expect("create");

        // Let the two lane slots fill + reach the executor.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let repo = TxrRepository::new(pool.clone());
        let drive = drive_for(summary.id).expect("the drive is live");
        drive.signal_stop_all();

        let row = wait_terminal(&repo, summary.id).await;
        assert_eq!(row.status().expect("parses"), TxrRunStatus::Stopped);
        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        assert_eq!(methods.len(), 3);
        let stopped = methods.iter().filter(|m| m.state == "stopped").count();
        let skipped = methods.iter().filter(|m| m.state == "skipped").count();
        assert_eq!(stopped, 2, "the running methods turn stopped");
        assert_eq!(skipped, 1, "the waiting method turns skipped");
        for m in methods.iter().filter(|m| m.state == "stopped") {
            assert_eq!(
                m.reason_code.as_deref(),
                Some("ABORTED"),
                "the stop reason is the run's, not a generic failure"
            );
        }
    }

    #[tokio::test]
    async fn stop_during_env_download_cancels_the_inflight_ensure() {
        let _g = rootfs::scoped_data_root(test_data_dir("env-stop"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_secs(5)));
        env.set(
            "landmark-cox-current",
            EnvPolicy::Downloading {
                total: 250 * 1024 * 1024,
            },
        );
        let executor = Arc::new(FakeExecutor::new(Duration::ZERO));
        let req = run_request(
            &["landmark-cox-current", "ctdna-tf-four-group", "jm-lme"],
            2,
            true,
        );
        let summary = start_run(
            pool.clone(),
            runtime,
            env.clone(),
            executor.clone(),
            owner(),
            req,
        )
        .await
        .expect("create");

        // Both lane slots are inside the (blocking) ensure by now; the third
        // method still waits at the gate.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let drive = drive_for(summary.id).expect("the drive is live in the env phase");
        drive.signal_stop_all();

        let repo = TxrRepository::new(pool.clone());
        let row = wait_terminal(&repo, summary.id).await;
        assert_eq!(row.status().expect("parses"), TxrRunStatus::Stopped);
        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        // PROV-EE-6's stop-all typing: ABORTED on running, SKIPPED on
        // waiting/downloading — the two in-flight downloads were never
        // admitted, so both records are `skipped`, like the queued method.
        assert!(
            methods.iter().all(|m| m.state == "skipped"),
            "every not-yet-running method turns skipped: {:?}",
            methods
                .iter()
                .map(|m| (m.method_id.clone(), m.state.clone()))
                .collect::<Vec<_>>()
        );
        assert!(
            executor
                .runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "the stop hit the env phase — nothing was admitted, let alone run"
        );

        // DEC: the stop cancels the in-flight ensure (base + layer each). The
        // cancel is fire-and-forget, so poll shortly for the record.
        let mut cancelled = Vec::new();
        for _ in 0..100 {
            cancelled = env.cancelled();
            if cancelled.iter().any(|c| c == "base-r") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            cancelled.iter().any(|c| c == "base-r"),
            "the in-flight base ensure was cancelled: {cancelled:?}"
        );
        assert!(
            cancelled.len() >= 2,
            "the layer ensures were cancelled too: {cancelled:?}"
        );
    }

    #[tokio::test]
    async fn skip_a_waiting_method_marks_it_skipped_without_running() {
        let _g = rootfs::scoped_data_root(test_data_dir("skip"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let executor = Arc::new(FakeExecutor::new(Duration::from_millis(500)));
        let req = run_request(
            &["landmark-cox-current", "ctdna-tf-four-group", "jm-lme"],
            1,
            true,
        );
        let summary = start_run(pool.clone(), runtime, env, executor, owner(), req)
            .await
            .expect("create");

        tokio::time::sleep(Duration::from_millis(250)).await;
        let drive = drive_for(summary.id).expect("live");
        assert!(drive.signal_skip_method("jm-lme"), "a queued method skips");

        let repo = TxrRepository::new(pool.clone());
        let row = wait_terminal(&repo, summary.id).await;
        assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        let by_id: std::collections::HashMap<_, _> =
            methods.iter().map(|m| (m.method_id.as_str(), m)).collect();
        assert_eq!(by_id["jm-lme"].state, "skipped", "never executed");
        assert_eq!(by_id["landmark-cox-current"].state, "finished");
        assert_eq!(by_id["ctdna-tf-four-group"].state, "finished");
    }

    #[tokio::test]
    async fn env_download_failure_fails_the_method_with_the_provider_code() {
        let _g = rootfs::scoped_data_root(test_data_dir("env-fail"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        env.set(
            "landmark-cox-current",
            EnvPolicy::Fail {
                code: "ENV_STAGING_TIMEOUT",
            },
        );
        let executor = Arc::new(FakeExecutor::new(Duration::ZERO));
        let req = run_request(&["landmark-cox-current"], 2, true);
        let summary = start_run(pool.clone(), runtime, env, executor, owner(), req)
            .await
            .expect("create");

        let repo = TxrRepository::new(pool.clone());
        let row = wait_terminal(&repo, summary.id).await;
        assert_eq!(
            row.status().expect("parses"),
            TxrRunStatus::Finished,
            "the other methods were done"
        );
        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].state, "failed", "INV-2: no silent retry");
        assert_eq!(
            methods[0].reason_code.as_deref(),
            Some("ENV_STAGING_TIMEOUT"),
            "the provider's typed code verbatim"
        );
        assert!(methods[0].job_id.is_none(), "never admitted");
    }

    #[tokio::test]
    async fn env_poll_updates_the_row_bytes_while_downloading() {
        let _g = rootfs::scoped_data_root(test_data_dir("env-poll"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(1500)));
        env.set(
            "landmark-cox-current",
            EnvPolicy::Downloading {
                total: 250 * 1024 * 1024,
            },
        );
        let executor = Arc::new(FakeExecutor::new(Duration::ZERO));
        let req = run_request(&["landmark-cox-current"], 2, true);
        let summary = start_run(pool.clone(), runtime, env, executor, owner(), req)
            .await
            .expect("create");

        let repo = TxrRepository::new(pool.clone());
        let _ = wait_terminal(&repo, summary.id).await;
        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        let m = &methods[0];
        assert_eq!(m.state, "finished");
        assert!(
            m.bytes_downloaded >= 32 * 1024,
            "the 500 ms poll patched the row counter: {}",
            m.bytes_downloaded
        );
        let entry = envmanifest::env_for("landmark-cox-current").expect("entry");
        assert_eq!(
            m.bytes_total,
            Some(entry.size_bytes as i64),
            "the manifest size is the denominator"
        );
    }

    #[tokio::test]
    async fn input_snapshot_keeps_copies_and_always_writes_the_canonical() {
        let dir = test_data_dir("snapshot");
        let _ = std::fs::remove_dir_all(&dir);
        let req = run_request(&["landmark-cox-current"], 3, true);
        let prepared = prepare_run(
            &req.input,
            &req.config,
            TxrRunMode::Train,
            &req.method_ids,
            &[],
        )
        .unwrap();
        write_input_snapshot(&dir, &req.input, prepared.train.as_ref().unwrap()).unwrap();
        let input = dir.join("input");
        for name in [
            "patients.csv",
            "values.csv",
            "features.csv",
            "measurements.csv",
        ] {
            assert!(input.join(name).exists(), "{name} written");
        }

        let dir2 = test_data_dir("snapshot-no-copies");
        let _ = std::fs::remove_dir_all(&dir2);
        let req2 = run_request(&["landmark-cox-current"], 3, false);
        let prepared2 = prepare_run(
            &req2.input,
            &req2.config,
            TxrRunMode::Train,
            &req2.method_ids,
            &[],
        )
        .unwrap();
        write_input_snapshot(&dir2, &req2.input, prepared2.train.as_ref().unwrap()).unwrap();
        assert!(
            !dir2.join("input").join("measurements.csv").exists(),
            "keep_copies=false → no uploaded copy (board K's promise)"
        );
        assert!(
            dir2.join("input").join("values.csv").exists(),
            "the canonical snapshot is the run's own record"
        );
    }

    #[tokio::test]
    async fn reuse_asset_verify_refusal_is_typed_before_any_spawn() {
        let _g = rootfs::scoped_data_root(test_data_dir("reuse-verify"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let executor = Arc::new(FakeExecutor::new(Duration::ZERO));
        // A tampered asset: the dir does not exist (the cleanest mismatch the
        // verify gate answers without touching the fixture bytes).
        let req = CreateRunRequest {
            mode: TxrRunMode::Reuse,
            input: TxrRunInput {
                patients: None,
                measurements: measurements_table(),
                predict_measurements: None,
                joins: Vec::new(),
                mapping: Vec::new(),
                keep_copies: false,
            },
            config: RunConfig {
                at_a_time: 2,
                ..Default::default()
            },
            method_ids: vec!["landmark-cox-current".to_string()],
            model_ids: vec![crate::modules::execution_engine::types::TxrModelAsset {
                model_id: "model-1".to_string(),
                host_dir: test_data_dir("no-such-directory").display().to_string(),
                tree_sha256: "bb".repeat(32),
                method_id: "landmark-cox-current".to_string(),
                method_version: "1.0.0".to_string(),
                env: TxrMethodEnv {
                    base_digest: "c".repeat(64),
                    layer_digest: "d".repeat(64),
                },
                contract: "2.0".to_string(),
            }],
        };
        let summary = start_run(pool.clone(), runtime, env, executor, owner(), req)
            .await
            .expect("create");
        let repo = TxrRepository::new(pool.clone());
        let row = wait_terminal(&repo, summary.id).await;
        assert_eq!(
            row.status().expect("parses"),
            TxrRunStatus::Finished,
            "all cannot-run → finished"
        );
        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].state, "cannot_run");
        assert_eq!(
            methods[0].reason_code.as_deref(),
            Some("MODEL_TREE_READ_FAILED"),
            "the verify-before-bind refusal, typed, before any spawn"
        );
    }
}
