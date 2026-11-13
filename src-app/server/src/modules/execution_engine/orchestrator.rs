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

use txresbench_core::AppError;

use super::repository::{MethodPatch, NewMethod, NewRun, RunRow, TxrRepository};
use super::runtime::RunRuntime;
use super::types::{
    CreateRunRequest, EngineReasonCode, RunConfig, TxrCoverage, TxrLimits, TxrLogStream,
    TxrMethodState, TxrPhase, TxrProbSource, TxrRequestError, TxrRunCounts, TxrRunEstimate,
    TxrRunInputSummary, TxrRunReason, TxrRunStatus, TxrRunSummary, TxrTask,
};
use crate::modules::file_validator::types::{
    CanonicalBundle, CanonicalPatient, JoinOffer, MarkerMapping, ParsedTable, ValidationMode,
    ValidationRequest, DEFAULT_BASELINE_MAX_DAY,
};
use crate::modules::method_catalogue::eligibility;
use crate::modules::method_catalogue::estimate;
use crate::modules::method_catalogue::types::{
    EligibilityRequest, EligibilityStatus, EstimateRequest, Method, TimingQuality,
};
use crate::modules::rootfs;
use crate::modules::sandbox::backend::{MilestoneFrame, ProgressFrame, ProgressSink};
use crate::modules::sandbox::method_env::{
    EnvKind, MethodEnvManager, MethodEnvStatus, ProvidedMount,
};
use crate::modules::sandbox::stack::{
    EnvRef, MethodRunMode, MethodRunRequest, MethodRunResult, ModelMount, TXR_BASE_REGISTRY_PREFIX,
};

use super::bundle;
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
/// BENCHMARK namespace, provenance only), pinned by the immutable base tag
/// `<contract>-<arch>` and verified against the payload digest — the manifest
/// `base_digest` recorded by the app-side base publisher (ITEM-2 note: for
/// the qa-hardening dev publisher that value is the dev base squashfs sha256;
/// see DRIFT-1 ITEM-2 — the published manifest's benchmark base digest is a
/// provenance anchor, never a fetch target, and the digest-addressed spelling
/// cannot work because an OCI manifest digest never equals the payload hash
/// it references).
pub fn base_env_ref(entry: &envmanifest::ManifestEntry) -> EnvRef {
    let digest = entry
        .base_digest
        .strip_prefix("sha256:")
        .unwrap_or(&entry.base_digest);
    EnvRef {
        oci_ref: format!(
            "{TXR_BASE_REGISTRY_PREFIX}/base-{}",
            entry.language.base_family()
        ),
        digest: digest.to_string(),
        tag: Some(format!("{}-{}", entry.contract, entry.arch.as_str())),
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
    /// The train-side canonical bundle (train mode, or reuse with a patients
    /// table — its outcomes are then the reuse conversion's training side).
    pub train: Option<Arc<CanonicalBundle>>,
    /// The predict-side canonical bundle (path 2/3).
    pub predict: Option<Arc<CanonicalBundle>>,
    /// The predict-side patients rows (covariates; reuse mode).
    pub predict_patients: Option<Arc<[CanonicalPatient]>>,
    /// The run dir (`analysis-…`; DEC-5) — bundles/output/models live under it.
    pub run_dir: PathBuf,
    /// Whether `/model` outputs are saved (board E's checkbox).
    pub save_models: bool,
    /// What the drive runs (train method vs a resolved reuse asset).
    pub target: RunTarget,
    /// ITEM-9's live channel back into the drive (log lines + progress
    /// frames — the sandbox sink's frames ride this seam).
    pub sink: Arc<dyn MethodSink>,
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

/// ITEM-9's live channel back into the drive: one method's wrapper log lines
/// + progress frames (the sandbox `ProgressSink`'s frames ride this seam —
/// CONS-EE-5 GAP-1/GAP-2, the log pane streams during the run instead of
/// buffering to completion). The drive's [`RunMethodSink`] appends to
/// `txr_run_logs` + broadcasts `log`/`progress` SSE frames; the method row's
/// `phase` column follows the milestone frames.
pub trait MethodSink: Send + Sync {
    /// One wrapper stdout/stderr line (the sandbox's `log.stdout` /
    /// `log.stderr` frames).
    fn line(&self, stream: TxrLogStream, content: String);
    /// A milestone/progress sample (the sandbox's `fit`/`predict` frames).
    fn progress(&self, phase: TxrPhase, pct: Option<f64>, message: Option<String>);
}

/// The drive-side [`MethodSink`]: an mpsc channel the drain task consumes
/// (the executor's calls never block on a DB write — the sink's frames are
/// enqueued and the drive's drainer appends them, bounded by the module's
/// log cap + the SSE quota).
pub(crate) enum SinkMessage {
    Line {
        stream: TxrLogStream,
        content: String,
    },
    Progress {
        phase: TxrPhase,
        pct: Option<f64>,
        message: Option<String>,
    },
}

#[derive(Clone)]
pub(crate) struct RunMethodSink {
    tx: tokio::sync::mpsc::UnboundedSender<SinkMessage>,
}

impl RunMethodSink {
    /// The pair the drive wires up per method: the sink (handed to the
    /// executor) + the drainer's receiver. When the executor drops its
    /// `Arc` the channel closes and the drain task ends.
    pub(crate) fn channel() -> (Arc<Self>, tokio::sync::mpsc::UnboundedReceiver<SinkMessage>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (Arc::new(Self { tx }), rx)
    }
}

impl MethodSink for RunMethodSink {
    fn line(&self, stream: TxrLogStream, content: String) {
        // The line is enqueued and never blocks the executor; the drive's
        // drainer owns the DB write + the SSE broadcast. A closed channel
        // (the run is finalizing) drops the line — logs never fail a method.
        let _ = self.tx.send(SinkMessage::Line { stream, content });
    }

    fn progress(&self, phase: TxrPhase, pct: Option<f64>, message: Option<String>) {
        let _ = self.tx.send(SinkMessage::Progress {
            phase,
            pct,
            message,
        });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-9 — the per-method executor: bundle write + the contract 2.0 call
// orchestration + predictions ingest + model collection (a port of
// `package/core/src/engine.cpp`'s `fit()` + `predict()`; the plan's "bundle
// write per method (ITEM-3/4 output), `run_method_in_stack`, result capture,
// predictions ingest (ITEM-5/6), model-dir collection")
// ─────────────────────────────────────────────────────────────────────────────

/// The displayed (task, outcome, horizon) of a method's column — one
/// deterministic derivation (a response-method task → the response outcome
/// without a horizon; every other runnable method → the run endpoint's
/// survival outcome at the run's look-ahead; TEST-EE-35). See [`run_task`].
pub struct TxrRunOutcomeSpec {
    pub task: TxrTask,
    /// "progression" | "death" | "no_response".
    pub outcome: &'static str,
    /// The survival horizon (None for a response outcome).
    pub horizon: Option<f64>,
}

impl TxrRunOutcomeSpec {
    fn survival(endpoint: super::types::TxrEndpoint, look_ahead: f64) -> Self {
        match endpoint {
            super::types::TxrEndpoint::Pfs => Self {
                task: TxrTask::Pfs,
                outcome: "progression",
                horizon: Some(look_ahead),
            },
            super::types::TxrEndpoint::Os => Self {
                task: TxrTask::Os,
                outcome: "death",
                horizon: Some(look_ahead),
            },
        }
    }

    fn response() -> Self {
        Self {
            task: TxrTask::Response,
            outcome: super::predictions::RESPONSE_OUTCOME,
            horizon: None,
        }
    }
}

/// The task + displayed column of one method (DEC-9's per-method task; the
/// run record and the heatmap column carry it — never the endpoint alone).
fn run_task(
    facts: &Method,
    endpoint: super::types::TxrEndpoint,
    look_ahead: f64,
) -> TxrRunOutcomeSpec {
    if facts
        .tasks
        .iter()
        .any(|t| t.eq_ignore_ascii_case("response"))
    {
        TxrRunOutcomeSpec::response()
    } else {
        TxrRunOutcomeSpec::survival(endpoint, look_ahead)
    }
}

/// The sandbox run seam behind the executor (the injectable boundary): the
/// real seam wraps [`crate::modules::sandbox::service::run_method_in_stack`],
/// the scripted fixtures implement the same contract without bwrap — the
/// ITEM-8 `EnvProvider`/`MethodExecutor` fixture pattern.
#[async_trait]
pub trait StackRunSeam: Send + Sync {
    /// One sandboxed call; `sink` receives the wrapper's live log lines +
    /// milestone frames (the engine's [`MethodSink`] adaptor).
    async fn run(
        &self,
        req: &MethodRunRequest,
        job_id: Uuid,
        sink: Arc<dyn ProgressSink>,
    ) -> Result<MethodRunResult, AppError>;
}

/// The production seam: one `run_method_in_stack` call (PROV-SS-1).
pub struct RealStackSeam {
    pool: sqlx::SqlitePool,
}

impl RealStackSeam {
    pub fn new(pool: sqlx::SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl StackRunSeam for RealStackSeam {
    async fn run(
        &self,
        req: &MethodRunRequest,
        job_id: Uuid,
        sink: Arc<dyn ProgressSink>,
    ) -> Result<MethodRunResult, AppError> {
        crate::modules::sandbox::service::run_method_in_stack(
            &self.pool,
            req,
            &[],
            job_id,
            Some(sink),
        )
        .await
    }
}

/// The sandbox `ProgressSink` → engine [`MethodSink`] adaptor: the provider
/// forwards the wrapper's stdout/stderr lines as `log.stdout`/`log.stderr`
/// frames (CONS-EE-5 GAP-2) and the fit/predict milestones as
/// `MilestoneFrame`s (GAP-1).
struct StackSink {
    sink: Arc<dyn MethodSink>,
}

impl ProgressSink for StackSink {
    fn progress(&self, frame: ProgressFrame) {
        let stream = match frame.phase.as_str() {
            crate::modules::sandbox::service::LOG_PHASE_STDOUT => TxrLogStream::Stdout,
            crate::modules::sandbox::service::LOG_PHASE_STDERR => TxrLogStream::Stderr,
            _ => return,
        };
        if let Some(line) = frame.message {
            self.sink.line(stream, line);
        }
    }

    fn milestone(&self, frame: MilestoneFrame) {
        let phase = match frame.id.as_str() {
            "fit" => TxrPhase::Fit,
            "predict" => TxrPhase::Predict,
            _ => return,
        };
        self.sink
            .progress(phase, None, Some(format!("{} {}", frame.id, frame.status)));
    }
}

/// The real [`MethodExecutor`]: one method's full contract-2.0 call sequence
/// (`engine.cpp::fit` + `predict`).
///
/// **Train mode** — the marker selection (ITEM-4) over the run's train side →
/// the train bundle → the calls:
/// - `saves_model` (the 2.0 switch; the whole shipped catalogue declares it):
///   `FitOnly` (writes `/model`) → when the displayed probability needs a
///   conversion, the training-score call (`ReuseModel` over the training
///   cohort; a `fitted` method runs the 3-fold cross-fit instead — fit on the
///   rest, predict the fold, so the map is fitted on out-of-fold risks) →
///   the final `ReuseModel` over the predict surface;
/// - no `saves_model`: the combined `FitPredict` calls (fit + predict in one
///   call with the training files kept alongside — the contract's unset
///   mode);
/// - the final call's output is validated + assembled (ITEM-5) and the
///   missing probability filled by the conversion band (ITEM-6);
///   `prob_source` is native or recalibrated, never mixed (INV-3); the
///   produced `/model` tree is collected when the run saves models.
///
/// **Reuse mode** — no fit: one `ReuseModel` call against the verified asset;
/// the probabilities are the model's own native column when it declares one,
/// otherwise the conversion is re-fitted from the reuse run's own outcomes
/// when it carries them (a predict-only reuse has no training data — the
/// column reports `prob_source: "none"` + the note, never an invented
/// number; DRIFT-1 ITEM-9 #3).
pub struct StackMethodExecutor {
    pool: sqlx::SqlitePool,
    seam: Arc<dyn StackRunSeam>,
}

impl StackMethodExecutor {
    /// The production executor (the real sandbox seam over the process pool).
    pub fn new(pool: sqlx::SqlitePool) -> Self {
        let seam: Arc<dyn StackRunSeam> = Arc::new(RealStackSeam::new(pool.clone()));
        Self { pool, seam }
    }

    /// The test seam (scripted calls — no bwrap; the ITEM-8 fixture pattern).
    pub fn with_seam(pool: sqlx::SqlitePool, seam: Arc<dyn StackRunSeam>) -> Self {
        Self { pool, seam }
    }
}

/// The terminal arm for a machinery/bundle/prediction refusal — `Ok(state:
/// failed, reason)` (a method that ran and produced bad output is a verdict,
/// never an `Err` — the trait's contract).
fn failed_outcome(reason: TxrRunReason) -> MethodOutcome {
    MethodOutcome {
        state: TxrMethodState::Failed,
        reason: Some(reason),
        exit_code: None,
        duration_ms: None,
        prob_source: None,
        coverage: None,
        task: None,
        model: None,
    }
}

fn aborted_outcome() -> MethodOutcome {
    MethodOutcome {
        state: TxrMethodState::Stopped,
        reason: Some(TxrRunReason::from_engine(
            EngineReasonCode::Aborted,
            "stopped by the user",
        )),
        exit_code: None,
        duration_ms: None,
        prob_source: None,
        coverage: None,
        task: None,
        model: None,
    }
}

/// The engine's typed reason of a bundle refusal (the `BUNDLE_*` code
/// verbatim + the package's message text).
fn bundle_failure(e: &bundle::BundleError) -> TxrRunReason {
    TxrRunReason {
        code: e.code().to_string(),
        detail: e.to_string(),
    }
}

/// The typed failure line of a call result (the package's wording):
/// `JOB_TIMEOUT` for the stopped-by-time arm, `PREDICTION_INVALID` for a
/// non-zero exit (the package's "failed during <mode> (exit code N): last
/// lines"). `None` = the call was healthy.
fn call_failure(method_id: &str, mode: &str, r: &MethodRunResult) -> Option<TxrRunReason> {
    if r.timed_out {
        return Some(TxrRunReason::from_engine(
            EngineReasonCode::JobTimeout,
            format!("method '{method_id}' stopped: the time limit was reached during {mode}"),
        ));
    }
    if r.exit_code != 0 {
        let last: String = r
            .stderr
            .lines()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Some(TxrRunReason::from_engine(
            EngineReasonCode::PredictionInvalid,
            format!(
                "method '{method_id}' failed during {mode} (exit code {}):\n{}",
                r.exit_code,
                if last.is_empty() {
                    "(no stderr)"
                } else {
                    &last
                }
            ),
        ));
    }
    None
}

/// The executor-side error shim: an [`AppError`] with the reason's typed code
/// (the drive's `execution_failure_reason` preserves the code verbatim — one
/// reason vocabulary).
fn fail_app(reason: TxrRunReason) -> AppError {
    AppError::new(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        reason.code,
        reason.detail,
    )
}

enum CallOutcome {
    Ran(MethodRunResult),
    /// A user stop fired: the method row turns `stopped` + `ABORTED`; the
    /// in-flight sandbox call is NOT killed — the child runs out under the
    /// sandbox's own wall clock (its output is never read), a bounded and
    /// sandboxed tail (DRIFT-1 ITEM-9 #4).
    Aborted,
}

#[async_trait]
impl MethodExecutor for StackMethodExecutor {
    async fn execute(&self, ctx: MethodRunContext) -> Result<MethodOutcome, AppError> {
        let method_id = ctx.method_id.clone();
        // `ctx.method_id` is the plan id — for reuse plans that is the MODEL
        // id, not a catalogue method id. start_run validated the asset's
        // catalogue `method_id`; resolve facts from the target, not the plan id.
        let facts = match &ctx.target {
            RunTarget::TrainMethod => {
                envmanifest::facts_for(&method_id).expect("checked at start_run")
            }
            RunTarget::ReuseModel { asset } => {
                envmanifest::facts_for(&asset.method_id).expect("checked at start_run")
            }
        };
        let spec = super::predictions::PredictionSpec::new(facts);
        let settings = method_bundle_settings(&ctx.config, ctx.cpus);
        let limits = crate::modules::sandbox::settings_cache::get(&self.pool).await;
        let timeout_secs = (limits.timeout_secs.max(1) as u64) * 2;

        match &ctx.target {
            RunTarget::TrainMethod => {
                self.execute_train(&ctx, facts, &spec, &settings, timeout_secs)
                    .await
            }
            RunTarget::ReuseModel { asset } => {
                self.execute_reuse(&ctx, facts, &spec, &settings, timeout_secs, asset)
                    .await
            }
        }
    }
}

impl StackMethodExecutor {
    /// Train mode (path 1/2): fit + the prediction calls + conversion +
    /// model collection.
    #[allow(clippy::too_many_lines)]
    async fn execute_train(
        &self,
        ctx: &MethodRunContext,
        facts: &Method,
        spec: &super::predictions::PredictionSpec<'_>,
        settings: &bundle::BundleSettings,
        timeout_secs: u64,
    ) -> Result<MethodOutcome, AppError> {
        let method_id = ctx.method_id.clone();
        let train = ctx
            .train
            .clone()
            .expect("train mode always carries the train side");

        // The marker set, the train bundle and the test bundle over the
        // predict surface ([`method_bundles`]): a refusal is terminal with the
        // typed `BUNDLE_*` code — the method never runs on the wrong markers.
        let MethodBundles {
            selection,
            train: train_bundle,
            test: test_bundle,
        } = match method_bundles(
            &train,
            ctx.predict.as_deref(),
            facts,
            settings,
            ctx.min_draws,
        ) {
            Ok(b) => b,
            Err(e) => return Ok(failed_outcome(bundle_failure(&e))),
        };
        let outcome_spec = run_task(facts, ctx.config.endpoint, settings.look_ahead_day);

        let bundle_dir = ctx.run_dir.join("bundles").join(&method_id);
        let outputs_dir = ctx.run_dir.join("output").join(&method_id);
        let model_dir = ctx.run_dir.join("models").join(&method_id);
        let mut duration_ms: u64 = 0;
        let mut model_digest: Option<String> = None;

        // ── the fit call (X1's `SIGBENCH_MODE=fit`) ─────────────────────────
        if facts.saves_model {
            if let Err(e) = write_call_input(&bundle_dir, Some(&train_bundle), None) {
                return Ok(failed_outcome(io_failure(&e)));
            }
            ctx.sink
                .progress(TxrPhase::Fit, None, Some(format!("{method_id}: fitting")));
            let req = MethodRunRequest {
                base: ctx.env.base.clone(),
                layer: ctx.env.layer.clone(),
                mode: MethodRunMode::FitOnly,
                bundle_dir: bundle_dir.clone(),
                outputs_dir: outputs_dir.clone(),
                model: None,
                model_out_dir: Some(model_dir.clone()),
                n_cpu: settings.threads,
                timeout_secs: Some(timeout_secs),
            };
            match self.run_one(ctx, &req, &mut duration_ms).await? {
                CallOutcome::Aborted => return Ok(aborted_outcome()),
                CallOutcome::Ran(r) => {
                    if let Some(reason) = call_failure(&method_id, "fit", &r) {
                        return Ok(failed_outcome(reason));
                    }
                    model_digest = match r.model_out_digest {
                        Some(d) => Some(d),
                        None => {
                            // The fit wrote no /model tree — the reuse bind
                            // would verify a digest that does not exist; name
                            // it as the model failure (INV-2's reason).
                            return Ok(failed_outcome(TxrRunReason::from_engine(
                                EngineReasonCode::ModelVerifyFailed,
                                format!(
                                    "method '{method_id}' wrote no /model during fit; nothing can be reused"
                                ),
                            )));
                        }
                    };
                }
            }
        }

        // ── the training scores (the conversion band's input) ───────────────
        let needs = needs_list(facts, &train_bundle.outcomes, settings);
        let mut score_tables: Vec<bundle::CsvTable> = Vec::new();
        if !needs.is_empty() {
            if facts.fitted {
                // The inner 3-fold cross-fit (engine.cpp): the per-fold method
                // runs are the item's v1 calls — fit on the rest, predict the
                // fold, so the map is fitted on out-of-fold risks.
                let folds = super::predictions::crossfit_folds(
                    train_bundle.patient_ids.len(),
                    TxrLimits::SEED as u64,
                    super::predictions::CROSS_FIT_FOLDS,
                );
                for k in 0..super::predictions::CROSS_FIT_FOLDS {
                    let (sub_bundle, fold_test) = match crossfit_fold_bundles(
                        &train,
                        &train_bundle.patient_ids,
                        &folds,
                        k,
                        settings,
                        ctx.min_draws,
                        &selection,
                    ) {
                        Ok(b) => b,
                        Err(e) => return Ok(failed_outcome(bundle_failure(&e))),
                    };
                    ctx.sink.progress(
                        TxrPhase::Fit,
                        None,
                        Some(format!(
                            "cross-fit {} of {} for the probability conversion",
                            k + 1,
                            super::predictions::CROSS_FIT_FOLDS
                        )),
                    );
                    // The fold's own /model tree (engine.cpp: each fold fits
                    // into its OWN work dir — the produced model tree is never
                    // overwritten, so the final predict's digest still
                    // verifies against the main fit's tree).
                    let fold_model_dir = outputs_dir.join(".crossfit").join(k.to_string());
                    let fold_digest = if facts.saves_model {
                        if let Err(e) = write_call_input(&bundle_dir, Some(&sub_bundle), None) {
                            return Ok(failed_outcome(io_failure(&e)));
                        }
                        let req = MethodRunRequest {
                            base: ctx.env.base.clone(),
                            layer: ctx.env.layer.clone(),
                            mode: MethodRunMode::FitOnly,
                            bundle_dir: bundle_dir.clone(),
                            outputs_dir: outputs_dir.clone(),
                            model: None,
                            model_out_dir: Some(fold_model_dir.clone()),
                            n_cpu: settings.threads,
                            timeout_secs: Some(timeout_secs),
                        };
                        match self.run_one(ctx, &req, &mut duration_ms).await? {
                            CallOutcome::Aborted => return Ok(aborted_outcome()),
                            CallOutcome::Ran(r) => {
                                if let Some(reason) = call_failure(&method_id, "fit", &r) {
                                    return Ok(failed_outcome(reason));
                                }
                                match r.model_out_digest {
                                    Some(d) => d,
                                    None => {
                                        return Ok(failed_outcome(TxrRunReason::from_engine(
                                            EngineReasonCode::ModelVerifyFailed,
                                            format!(
                                                "method '{method_id}' wrote no /model during cross-fit fold {}",
                                                k + 1
                                            ),
                                        )));
                                    }
                                }
                            }
                        }
                    } else {
                        String::new()
                    };
                    let score = self
                        .predict_call(
                            ctx,
                            facts,
                            settings,
                            timeout_secs,
                            &method_id,
                            spec,
                            &outcome_spec,
                            &train_bundle.outcomes,
                            &sub_bundle.params,
                            (!facts.saves_model).then_some(&sub_bundle),
                            &fold_test,
                            facts
                                .saves_model
                                .then_some((fold_digest.as_str(), fold_model_dir.as_path())),
                            (!facts.saves_model).then_some(fold_model_dir.as_path()),
                            &bundle_dir,
                            &outputs_dir,
                            &mut duration_ms,
                        )
                        .await?;
                    let Some(score) = score else {
                        return Ok(aborted_outcome());
                    };
                    score_tables.push(score.table);
                }
            } else {
                // One call over the training cohort (engine.cpp's
                // `test_from_train`): the model's scores of the patients it
                // was trained on — the conversion band's training side.
                let cohort_test =
                    match cohort_test_bundle(&train, settings, ctx.min_draws, &selection) {
                        Ok(b) => b,
                        Err(e) => return Ok(failed_outcome(bundle_failure(&e))),
                    };
                let score = self
                    .predict_call(
                        ctx,
                        facts,
                        settings,
                        timeout_secs,
                        &method_id,
                        spec,
                        &outcome_spec,
                        &train_bundle.outcomes,
                        &train_bundle.params,
                        (!facts.saves_model).then_some(&train_bundle),
                        &cohort_test,
                        model_digest.as_deref().map(|d| (d, model_dir.as_path())),
                        (!facts.saves_model).then_some(model_dir.as_path()),
                        &bundle_dir,
                        &outputs_dir,
                        &mut duration_ms,
                    )
                    .await?;
                let Some(score) = score else {
                    return Ok(aborted_outcome());
                };
                score_tables.push(score.table);
            }
        }

        // ── the conversion (ITEM-6's band; one map for the displayed
        //    (outcome, horizon) — INV-3's one-source-per-column rule) ────────
        let outcomes_csv = bundle::parse_csv(
            &train_bundle
                .files
                .iter()
                .find(|f| f.name == "outcomes.csv")
                .map(|f| f.csv.clone())
                .unwrap_or_default(),
        )
        .unwrap_or_else(|_| bundle::CsvTable::empty());
        let conversion = if super::predictions::own_probability(
            &facts.own_outputs,
            outcome_spec.outcome,
            outcome_spec.horizon,
        ) {
            None
        } else {
            let map = score_map_for(&score_tables, spec, &outcome_spec.outcome);
            match super::predictions::fit_recalibration(
                spec,
                &outcomes_csv,
                &map,
                outcome_spec.outcome,
                outcome_spec.horizon,
            ) {
                Ok(c) => Some(c),
                Err(e) => {
                    let reason = TxrRunReason::from_engine(e.engine_code(), e.detail());
                    return Ok(failed_outcome(reason));
                }
            }
        };

        // ── the final predict call over the predict surface ─────────────────
        let score = self
            .predict_call(
                ctx,
                facts,
                settings,
                timeout_secs,
                &method_id,
                spec,
                &outcome_spec,
                &train_bundle.outcomes,
                &train_bundle.params,
                (!facts.saves_model).then_some(&train_bundle),
                &test_bundle,
                model_digest.as_deref().map(|d| (d, model_dir.as_path())),
                (!facts.saves_model).then_some(model_dir.as_path()),
                &bundle_dir,
                &outputs_dir,
                &mut duration_ms,
            )
            .await?;
        let Some(score) = score else {
            return Ok(aborted_outcome());
        };
        // The last call's exit code is 0 here (`call_failure` already refused
        // any non-zero / timed-out result — a healthy last call).
        let exit_code = Some(0);

        // The recorded bundle: the final contract state (params + train +
        // the predict surface) — a rerun reproduces `bundles/<method_id>/`
        // byte-for-byte (ITEM-3's entity rule).
        if let Err(e) = write_recorded_bundle(&bundle_dir, &train_bundle, &test_bundle) {
            return Ok(failed_outcome(io_failure(&e)));
        }

        let (prob_source, rows) = match conversion {
            Some(c) => (
                TxrProbSource::Recalibrated,
                super::predictions::converted_rows(&c, &score.rows),
            ),
            None => (TxrProbSource::Native, score.rows),
        };
        let coverage = super::predictions::coverage(&rows);

        // The recorded chance column (ITEM-10's PROV-EE-7 read surface:
        // `output/<method_id>/chance.csv` — the assembled per-patient column
        // the heatmap + CSV download serve; the raw container output stays
        // the provenance). A write failure is a typed method failure — a
        // finished method whose column was never recorded would be a hole in
        // the results surface (INV-2, never a silent skip).
        if let Err(e) = super::predictions::write_chance_column(&ctx.run_dir, &method_id, &rows) {
            return Ok(failed_outcome(io_failure(&e)));
        }

        // The produced model: ONLY a `saves_model` method has a `/model` tree
        // (the fit's `model_out_digest`); a combined method's "model" is its
        // train files — recorded in the bundle, never a TxrProducedModel
        // (engine.cpp's `train_files`, not `model_files`).
        let model = if ctx.save_models && facts.saves_model {
            model_digest.as_ref().map(|digest| ProducedModelFacts {
                model_out_digest: digest.clone(),
                dir: model_dir.display().to_string(),
                trained_on_patients: train_bundle.patient_ids.len() as u32,
                size_bytes: dir_size(&model_dir),
                own_auc: own_auc(
                    &score_tables,
                    spec,
                    &train_bundle,
                    &outcome_spec.outcome,
                    outcome_spec.horizon,
                ),
            })
        } else {
            None
        };

        Ok(MethodOutcome {
            state: TxrMethodState::Finished,
            reason: None,
            exit_code,
            duration_ms: Some(duration_ms),
            prob_source: Some(prob_source),
            coverage: Some(coverage),
            task: Some(outcome_spec.task),
            model,
        })
    }

    /// Reuse mode: one `ReuseModel` call against the verified asset.
    async fn execute_reuse(
        &self,
        ctx: &MethodRunContext,
        facts: &Method,
        spec: &super::predictions::PredictionSpec<'_>,
        settings: &bundle::BundleSettings,
        timeout_secs: u64,
        asset: &super::types::TxrModelAsset,
    ) -> Result<MethodOutcome, AppError> {
        let method_id = ctx.method_id.clone();
        let predict = ctx
            .predict
            .clone()
            .expect("reuse mode always carries the predict side");
        let selection = match bundle::method_marker_set(
            &predict,
            &facts.markers,
            facts.required_markers.as_ref(),
        ) {
            Ok(s) => s,
            Err(e) => return Ok(failed_outcome(bundle_failure(&e))),
        };
        let test_bundle = match bundle::test_bundle_with_markers(
            ctx.predict_patients.as_deref(),
            &predict,
            settings,
            ctx.min_draws,
            &selection,
        ) {
            Ok(b) => b,
            Err(e) => return Ok(failed_outcome(bundle_failure(&e))),
        };
        let outcome_spec = run_task(facts, ctx.config.endpoint, settings.look_ahead_day);

        // The reuse run's own outcomes (Files-mode reuse) are the model's
        // predict params' `outcomes`; a predict-only reuse carries the empty
        // list (the schema allows it — the predict call has no training data).
        let reuse_train = ctx.train.clone();
        let reuse_outcomes: Vec<String> = match &reuse_train {
            Some(t) => {
                match bundle::train_bundle_with_markers(t, settings, ctx.min_draws, &selection) {
                    Ok(b) => b.outcomes,
                    Err(e) => return Ok(failed_outcome(bundle_failure(&e))),
                }
            }
            None => Vec::new(),
        };
        let params = params_value(settings, &reuse_outcomes, &selection.mains());

        let bundle_dir = ctx.run_dir.join("bundles").join(&method_id);
        let outputs_dir = ctx.run_dir.join("output").join(&method_id);
        let mut duration_ms: u64 = 0;

        if let Err(e) = write_call_input_with_params(&bundle_dir, &params, None, Some(&test_bundle))
        {
            return Ok(failed_outcome(io_failure(&e)));
        }
        let req = MethodRunRequest {
            base: ctx.env.base.clone(),
            layer: ctx.env.layer.clone(),
            mode: MethodRunMode::ReuseModel,
            bundle_dir: bundle_dir.clone(),
            outputs_dir: outputs_dir.clone(),
            model: Some(ModelMount {
                host_path: PathBuf::from(&asset.host_dir),
                tree_sha256: asset.tree_sha256.clone(),
            }),
            model_out_dir: None,
            n_cpu: settings.threads,
            timeout_secs: Some(timeout_secs),
        };
        let result = match self.run_one(ctx, &req, &mut duration_ms).await? {
            CallOutcome::Aborted => return Ok(aborted_outcome()),
            CallOutcome::Ran(r) => r,
        };
        if let Some(reason) = call_failure(&method_id, "predict", &result) {
            return Ok(failed_outcome(reason));
        }

        // The assembly's validation outcomes: the model's trained set when
        // known (Files mode), else the displayed one when the method declares
        // a native column for it (so the declared-columns check runs — an
        // all-empty accepted column is never silently served).
        let validation_outcomes: Vec<String> = if reuse_outcomes.is_empty()
            && super::predictions::own_probability(
                &facts.own_outputs,
                outcome_spec.outcome,
                outcome_spec.horizon,
            ) {
            vec![outcome_spec.outcome.to_string()]
        } else {
            reuse_outcomes
        };
        let csv = std::fs::read_to_string(outputs_dir.join("predictions.csv")).unwrap_or_default();
        let has_csv = !csv.is_empty();
        let run_json = std::fs::read_to_string(outputs_dir.join("run.json")).unwrap_or_default();
        let score = match super::predictions::method_predictions(
            if has_csv { Some(&csv) } else { None },
            &run_json,
            spec,
            &test_bundle.scored,
            &test_bundle.skipped,
            &validation_outcomes,
            &[settings.look_ahead_day],
            outcome_spec.outcome,
            outcome_spec.horizon,
        ) {
            Ok(m) => m,
            Err(e) => {
                let reason = TxrRunReason::from_engine(e.engine_code(), e.detail());
                return Ok(failed_outcome(reason));
            }
        };

        let (prob_source, rows) = if score.native_column.is_some() {
            (TxrProbSource::Native, score.rows)
        } else if let Some(train) = reuse_train {
            // A data-carrying reuse run: the conversion is re-fitted from the
            // model's scores over the run's own cohort (the honest
            // training-side band). The cohort's marker set, train bundle and
            // test bundle over the cohort itself are exactly a train call's
            // first bundles with no predict file ([`method_bundles`]).
            let MethodBundles {
                train: train_bundle,
                test: cohort_test,
                ..
            } = match method_bundles(&train, None, facts, settings, ctx.min_draws) {
                Ok(b) => b,
                Err(e) => return Ok(failed_outcome(bundle_failure(&e))),
            };
            let cohort_score = self
                .predict_call(
                    ctx,
                    facts,
                    settings,
                    timeout_secs,
                    &method_id,
                    spec,
                    &outcome_spec,
                    &train_bundle.outcomes,
                    &train_bundle.params,
                    (!facts.saves_model).then_some(&train_bundle),
                    &cohort_test,
                    Some((&asset.tree_sha256, Path::new(&asset.host_dir))),
                    None,
                    &bundle_dir,
                    &outputs_dir,
                    &mut duration_ms,
                )
                .await?;
            let Some(cohort_score) = cohort_score else {
                return Ok(aborted_outcome());
            };
            let map = score_map_for(&[cohort_score.table], spec, &outcome_spec.outcome);
            // The conversion is fitted on the cohort, but APPLIED to the
            // predict-surface rows (`score` above — the patients the board
            // scored); the cohort table was only the map's training side.
            let predict_rows = score.rows;
            let outcomes_csv = bundle::parse_csv(
                &train_bundle
                    .files
                    .iter()
                    .find(|f| f.name == "outcomes.csv")
                    .map(|f| f.csv.clone())
                    .unwrap_or_default(),
            )
            .unwrap_or_else(|_| bundle::CsvTable::empty());
            match super::predictions::fit_recalibration(
                spec,
                &outcomes_csv,
                &map,
                outcome_spec.outcome,
                outcome_spec.horizon,
            ) {
                Ok(c) => (
                    TxrProbSource::Recalibrated,
                    super::predictions::converted_rows(&c, &predict_rows),
                ),
                Err(e) => {
                    let reason = TxrRunReason::from_engine(e.engine_code(), e.detail());
                    return Ok(failed_outcome(reason));
                }
            }
        } else {
            // A predict-only reuse: no training data to fit a conversion. The
            // honest record names the missing source (`prob_source: "none"`)
            // instead of an invented number.
            let rows: Vec<super::predictions::PredictionRow> = score
                .rows
                .into_iter()
                .map(|mut r| {
                    if r.probability.is_none() && r.risk.is_some() && r.note.is_empty() {
                        r.note =
                            "no native probability; a predict-only reuse has no training data to fit the conversion"
                                .to_string();
                    }
                    r
                })
                .collect();
            (TxrProbSource::None, rows)
        };
        let coverage = super::predictions::coverage(&rows);

        // The recorded chance column (ITEM-10's read surface — same as the
        // train arm; the reuse column is this run's own).
        if let Err(e) = super::predictions::write_chance_column(&ctx.run_dir, &method_id, &rows) {
            return Ok(failed_outcome(io_failure(&e)));
        }

        Ok(MethodOutcome {
            state: TxrMethodState::Finished,
            reason: None,
            exit_code: Some(result.exit_code),
            duration_ms: Some(duration_ms),
            prob_source: Some(prob_source),
            coverage: Some(coverage),
            task: Some(outcome_spec.task),
            model: None,
        })
    }

    /// One sandboxed call (the seam) + the cancel select: the call runs on
    /// its own task while the cancel channel is watched, so a user stop
    /// mid-call returns `Aborted` promptly (the child itself is bounded by
    /// the sandbox wall clock).
    async fn run_one(
        &self,
        ctx: &MethodRunContext,
        req: &MethodRunRequest,
        duration_ms: &mut u64,
    ) -> Result<CallOutcome, AppError> {
        if *ctx.cancel.borrow() {
            return Ok(CallOutcome::Aborted);
        }
        let seam = self.seam.clone();
        let sink: Arc<dyn ProgressSink> = Arc::new(StackSink {
            sink: ctx.sink.clone(),
        });
        let req = req.clone();
        let job_id = ctx.job_id;
        let mut cancel = ctx.cancel.clone();
        let call = tokio::spawn(async move { seam.run(&req, job_id, sink).await });
        let result = tokio::select! {
            r = call => r.map_err(|e| AppError::internal_error(format!("method call task join: {e}")))??,
            _ = cancel.changed() => return Ok(CallOutcome::Aborted),
        };
        if *ctx.cancel.borrow() {
            return Ok(CallOutcome::Aborted);
        }
        *duration_ms += result.duration_ms;
        Ok(CallOutcome::Ran(result))
    }

    /// One predict-side call (the training-scores or the final surface call):
    /// writes the call's `/input` (params + the test surface, with the
    /// training files when the method cannot save a model), runs it
    /// (`ReuseModel`, or the combined `FitPredict` for a `saves_model: false`
    /// method), validates + assembles the output (ITEM-5). `Ok(None)` = the
    /// method was stopped.
    ///
    /// `params` is the call's `params.json` (the trained side's
    /// `make_params` shape); `train_bundle` is the combined call's training
    /// files (a `saves_model` method's predict never sees `/input/train` —
    /// X1: only `/model` + `/input/test`); `model_mount` is the verified
    /// `/model` tree of the reuse call (digest + host path); `model_out` is
    /// the combined call's `model_out_dir` (the sandbox's fit-mode rule — a
    /// scratch write; the method's produced model is its train files).
    #[allow(clippy::too_many_arguments)]
    async fn predict_call(
        &self,
        ctx: &MethodRunContext,
        facts: &Method,
        settings: &bundle::BundleSettings,
        timeout_secs: u64,
        method_id: &str,
        spec: &super::predictions::PredictionSpec<'_>,
        outcome_spec: &TxrRunOutcomeSpec,
        validation_outcomes: &[String],
        params: &serde_json::Value,
        train_bundle: Option<&bundle::TrainBundle>,
        test_bundle: &bundle::TestBundle,
        model_mount: Option<(&str, &Path)>,
        model_out: Option<&Path>,
        bundle_dir: &Path,
        outputs_dir: &Path,
        duration_ms: &mut u64,
    ) -> Result<Option<super::predictions::MethodPredictions>, AppError> {
        if *ctx.cancel.borrow() {
            return Ok(None);
        }
        let combined = !facts.saves_model;
        if let Err(e) =
            write_call_input_with_params(bundle_dir, params, train_bundle, Some(test_bundle))
        {
            return Err(fail_app(io_failure(&e)));
        }
        let req = MethodRunRequest {
            base: ctx.env.base.clone(),
            layer: ctx.env.layer.clone(),
            mode: if combined {
                MethodRunMode::FitPredict
            } else {
                MethodRunMode::ReuseModel
            },
            bundle_dir: bundle_dir.to_path_buf(),
            outputs_dir: outputs_dir.to_path_buf(),
            model: model_mount.map(|(digest, dir)| ModelMount {
                host_path: dir.to_path_buf(),
                tree_sha256: digest.to_string(),
            }),
            model_out_dir: model_out.map(|p| p.to_path_buf()),
            n_cpu: settings.threads,
            timeout_secs: Some(timeout_secs),
        };
        let result = match self.run_one(ctx, &req, duration_ms).await? {
            CallOutcome::Aborted => return Ok(None),
            CallOutcome::Ran(r) => r,
        };
        if let Some(reason) = call_failure(method_id, "predict", &result) {
            return Err(fail_app(reason));
        }
        let csv = std::fs::read_to_string(outputs_dir.join("predictions.csv")).unwrap_or_default();
        let run_json = std::fs::read_to_string(outputs_dir.join("run.json")).unwrap_or_default();
        match super::predictions::method_predictions(
            Some(&csv),
            &run_json,
            spec,
            &test_bundle.scored,
            &test_bundle.skipped,
            validation_outcomes,
            &[settings.look_ahead_day],
            outcome_spec.outcome,
            outcome_spec.horizon,
        ) {
            Ok(m) => Ok(Some(m)),
            Err(e) => Err(fail_app(TxrRunReason::from_engine(
                e.engine_code(),
                e.detail(),
            ))),
        }
    }
}

/// The bundle settings of one method call of a run (the ONE derivation the
/// executor, the example pick and the tests share): the run config's
/// fields, with `threads` = the per-method lane CPU count over the run's
/// detected `cpus` (DEC-12; it only reaches `params.json`).
pub(crate) fn method_bundle_settings(config: &RunConfig, cpus: u32) -> bundle::BundleSettings {
    bundle::BundleSettings::for_run(config, per_method_cpus(cpus, config.at_a_time))
}

/// [`train_bundle_preflight`] over a train call's own context: its canonical
/// sides, its `min_draws` and the settings `execute` builds from it
/// ([`method_bundle_settings`]). `Ok` means the call is not refused with a
/// `BUNDLE_*` code.
pub fn call_bundle_preflight(
    ctx: &MethodRunContext,
    facts: &Method,
) -> Result<(), bundle::BundleError> {
    let train = ctx
        .train
        .as_deref()
        .expect("a train call always carries the train side");
    train_bundle_preflight(
        train,
        ctx.predict.as_deref(),
        facts,
        &method_bundle_settings(&ctx.config, ctx.cpus),
        ctx.min_draws,
    )
}

/// The bundles a train-mode call builds before its first method call: the
/// per-method marker set (ITEM-4), the train bundle and the test bundle over
/// the predict surface.
pub(crate) struct MethodBundles {
    pub selection: bundle::MarkerSelection,
    pub train: bundle::TrainBundle,
    pub test: bundle::TestBundle,
}

/// Build a train-mode call's [`MethodBundles`] (the `execute_train` stage;
/// pure). The predict surface is the separate predict file when given, else
/// the training cohort (path 2's heatmap rows are the uploaded patients —
/// the prediction surface is the cohort when no predict file is mounted;
/// DRIFT-1 ITEM-9 #1).
pub(crate) fn method_bundles(
    train: &CanonicalBundle,
    predict: Option<&CanonicalBundle>,
    facts: &Method,
    settings: &bundle::BundleSettings,
    min_draws: u32,
) -> Result<MethodBundles, bundle::BundleError> {
    let selection =
        bundle::method_marker_set(train, &facts.markers, facts.required_markers.as_ref())?;
    let train_bundle = bundle::train_bundle_with_markers(train, settings, min_draws, &selection)?;
    let (predict_bundle, predict_patients): (&CanonicalBundle, Option<&[CanonicalPatient]>) =
        match predict {
            Some(p) => (p, None),
            None => (train, Some(&train.patients)),
        };
    let test_bundle = bundle::test_bundle_with_markers(
        predict_patients,
        predict_bundle,
        settings,
        min_draws,
        &selection,
    )?;
    Ok(MethodBundles {
        selection,
        train: train_bundle,
        test: test_bundle,
    })
}

/// One cross-fit fold's bundles (engine.cpp): the train bundle over the
/// cohort minus fold `k` and the test bundle over fold `k`.
fn crossfit_fold_bundles(
    train: &CanonicalBundle,
    cohort_ids: &[String],
    folds: &[usize],
    k: usize,
    settings: &bundle::BundleSettings,
    min_draws: u32,
    selection: &bundle::MarkerSelection,
) -> Result<(bundle::TrainBundle, bundle::TestBundle), bundle::BundleError> {
    let (rest, fold) = split_folds(train, cohort_ids, folds, k);
    let sub_bundle = bundle::train_bundle_with_markers(&rest, settings, min_draws, selection)?;
    let fold_test = bundle::test_bundle_with_markers(
        Some(&fold.patients),
        &fold,
        settings,
        min_draws,
        selection,
    )?;
    Ok((sub_bundle, fold_test))
}

/// The non-fitted conversion input (engine.cpp's `test_from_train`): the
/// test bundle over the training cohort itself.
fn cohort_test_bundle(
    train: &CanonicalBundle,
    settings: &bundle::BundleSettings,
    min_draws: u32,
    selection: &bundle::MarkerSelection,
) -> Result<bundle::TestBundle, bundle::BundleError> {
    bundle::test_bundle_with_markers(Some(&train.patients), train, settings, min_draws, selection)
}

/// Every bundle a train-mode call builds, built without running anything —
/// [`method_bundles`], then (when the conversion band needs scores) the
/// cross-fit folds' bundles for a fitted method or the cohort test bundle
/// otherwise, through the same helpers `execute_train` calls. `Ok` means the
/// call cannot be refused with a `BUNDLE_*` code on these inputs; the method
/// itself can still fail when it runs.
pub(crate) fn train_bundle_preflight(
    train: &CanonicalBundle,
    predict: Option<&CanonicalBundle>,
    facts: &Method,
    settings: &bundle::BundleSettings,
    min_draws: u32,
) -> Result<(), bundle::BundleError> {
    let bundles = method_bundles(train, predict, facts, settings, min_draws)?;
    if needs_list(facts, &bundles.train.outcomes, settings).is_empty() {
        return Ok(());
    }
    if facts.fitted {
        let folds = super::predictions::crossfit_folds(
            bundles.train.patient_ids.len(),
            TxrLimits::SEED as u64,
            super::predictions::CROSS_FIT_FOLDS,
        );
        for k in 0..super::predictions::CROSS_FIT_FOLDS {
            crossfit_fold_bundles(
                train,
                &bundles.train.patient_ids,
                &folds,
                k,
                settings,
                min_draws,
                &bundles.selection,
            )?;
        }
    } else {
        cohort_test_bundle(train, settings, min_draws, &bundles.selection)?;
    }
    Ok(())
}

/// The `needs` list (engine.cpp): every learned (outcome, horizon) the method
/// does not declare a native probability for — the conversion band's inputs.
fn needs_list(
    facts: &Method,
    outcomes: &[String],
    settings: &bundle::BundleSettings,
) -> Vec<(String, Option<f64>)> {
    let mut needs = Vec::new();
    for o in outcomes {
        let h = if super::predictions::is_survival(o) {
            Some(settings.look_ahead_day)
        } else {
            None
        };
        if !super::predictions::own_probability(&facts.own_outputs, o, h) {
            needs.push((o.clone(), h));
        }
    }
    needs
}

/// Write one call's `/input`: `params.json` + the side's files (`train/` from
/// the train bundle, `test/` from the test bundle). The combined call gets
/// both.
fn write_call_input(
    dir: &Path,
    train: Option<&bundle::TrainBundle>,
    test: Option<&bundle::TestBundle>,
) -> std::io::Result<()> {
    let params = train
        .map(|t| t.params.clone())
        .unwrap_or_else(|| serde_json::json!({}));
    write_call_input_with_params(dir, &params, train, test)
}

fn write_call_input_with_params(
    dir: &Path,
    params: &serde_json::Value,
    train: Option<&bundle::TrainBundle>,
    test: Option<&bundle::TestBundle>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(
        dir.join("params.json"),
        serde_json::to_vec_pretty(params).unwrap_or_default(),
    )?;
    // One call's `/input` is the previous call's dir (the sandbox binds the
    // WHOLE bundle dir at `/input`): a side the current call does not write
    // must not survive from an earlier call — a reuse predict never sees
    // `train/`, a fit never sees `test/` (engine.cpp's per-call input shape;
    // the recorded bundle is written after the calls with both sides).
    let clear = |sub: &str| -> std::io::Result<()> {
        let p = dir.join(sub);
        if p.exists() {
            std::fs::remove_dir_all(p)?;
        }
        Ok(())
    };
    if let Some(t) = train {
        let tdir = dir.join("train");
        std::fs::create_dir_all(&tdir)?;
        for f in &t.files {
            std::fs::write(tdir.join(f.name), &f.csv)?;
        }
    } else {
        clear("train")?;
    }
    if let Some(t) = test {
        let tdir = dir.join("test");
        std::fs::create_dir_all(&tdir)?;
        for f in &t.files {
            std::fs::write(tdir.join(f.name), &f.csv)?;
        }
    } else {
        clear("test")?;
    }
    Ok(())
}

/// The recorded bundle (`bundles/<method_id>/`): params + `train/` + `test/`
/// — the run's contract state (TEST-EE-18; a rerun reproduces it).
fn write_recorded_bundle(
    dir: &Path,
    train: &bundle::TrainBundle,
    test: &bundle::TestBundle,
) -> std::io::Result<()> {
    write_call_input(dir, Some(train), Some(test))
}

/// The params.json value of a reuse call (train mode's calls carry the train
/// bundle's own params — `make_params`' single shape).
fn params_value(
    settings: &bundle::BundleSettings,
    outcomes: &[String],
    markers: &[String],
) -> serde_json::Value {
    serde_json::json!({
        "landmark_day": settings.decision_day,
        "horizons": [settings.look_ahead_day],
        "outcomes": outcomes,
        "markers": markers,
        "baseline_max_day": settings.baseline_max_day,
        "covariates": settings.covariates,
        "method_params": {},
        "seed": settings.seed,
        "threads": settings.threads,
    })
}

/// The engine's reason for an I/O failure of the bundle/staging writes.
fn io_failure(e: &std::io::Error) -> TxrRunReason {
    TxrRunReason::from_engine(
        EngineReasonCode::PredictionInvalid,
        format!("bundle staging failed: {e}"),
    )
}

/// The score map of one outcome: the calls' per-patient risk of the outcome's
/// `risk_col` (the package's `take_scores`), unioned across the cross-fit
/// folds (a later fold's score wins — the map is the union of the out-of-fold
/// risks).
fn score_map_for(
    tables: &[bundle::CsvTable],
    spec: &super::predictions::PredictionSpec<'_>,
    outcome: &str,
) -> std::collections::BTreeMap<String, Option<f64>> {
    let mut map = std::collections::BTreeMap::new();
    for table in tables {
        let ids: Vec<String> = table
            .col("patient_id")
            .map(|c| c.to_vec())
            .unwrap_or_default();
        let risks = super::predictions::outcome_risks(spec, table, &ids, outcome);
        for (id, r) in ids.iter().zip(risks) {
            if r.is_some() || !map.contains_key(id) {
                map.insert(id.clone(), r);
            }
        }
    }
    map
}

/// The own-data AUC (Mann–Whitney with half-counted ties) of the method's
/// score vs the training outcome: the training-score call's risk against the
/// horizon label (event by h = 1; follow-up beyond h = 0; censored before h =
/// dropped) for survival, the plain label for response. Null when no scores
/// or no usable pair (GAP-C's "null when the outcome/the data does not allow
/// it").
fn own_auc(
    tables: &[bundle::CsvTable],
    spec: &super::predictions::PredictionSpec<'_>,
    train_bundle: &bundle::TrainBundle,
    outcome: &str,
    horizon: Option<f64>,
) -> Option<f64> {
    if tables.is_empty() {
        return None;
    }
    let map = score_map_for(tables, spec, outcome);
    let outcomes_csv = train_bundle
        .files
        .iter()
        .find(|f| f.name == "outcomes.csv")
        .map(|f| f.csv.clone())?;
    let table = bundle::parse_csv(&outcomes_csv).ok()?;
    let labels = super::predictions::training_labels(&table);
    let mut pairs: Vec<(f64, f64)> = Vec::new();
    for lbl in &labels {
        let Some(risk) = map.get(&lbl.patient_id).copied().flatten() else {
            continue;
        };
        let (time, event) = match outcome {
            "progression" => (lbl.pfs_time, lbl.pfs_event),
            "death" => (lbl.os_time, lbl.os_event),
            _ => (None, None),
        };
        let label = if outcome == super::predictions::RESPONSE_OUTCOME {
            lbl.no_response?
        } else {
            let (Some(t), Some(e)) = (time, event) else {
                continue;
            };
            if t <= horizon? {
                if e == 1.0 {
                    1.0
                } else {
                    continue; // censored before the horizon
                }
            } else {
                0.0
            }
        };
        pairs.push((risk, label));
    }
    if pairs.len() < 2 {
        return None;
    }
    let mut wins = 0.0;
    let mut ties = 0.0;
    let mut cmps = 0.0;
    for i in 0..pairs.len() {
        for j in 0..pairs.len() {
            if i == j || pairs[i].1 == pairs[j].1 {
                continue;
            }
            let (a, b) = (pairs[i].0, pairs[j].0);
            let hi = if pairs[i].1 > pairs[j].1 {
                a > b
            } else {
                a < b
            };
            cmps += 1.0;
            if hi {
                wins += 1.0;
            } else if a == b {
                ties += 1.0;
            }
        }
    }
    if cmps == 0.0 {
        return None;
    }
    Some((wins + ties * 0.5) / cmps)
}

/// The recursive byte size of a tree (the produced model's `size_bytes`).
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += dir_size(&p);
        } else if let Ok(md) = entry.metadata() {
            total += md.len();
        }
    }
    total
}

/// The cross-fit fold split (engine.cpp): `rest` = the cohort minus fold k,
/// `fold` = the cohort of fold k — canonical subsets (values too, so each
/// bundle counts the method's own draws per subset).
fn split_folds(
    train: &CanonicalBundle,
    cohort_ids: &[String],
    folds: &[usize],
    k: usize,
) -> (CanonicalBundle, CanonicalBundle) {
    use std::collections::HashSet;
    let rest: HashSet<&str> = cohort_ids
        .iter()
        .zip(folds)
        .filter(|(_, f)| **f != k)
        .map(|(id, _)| id.as_str())
        .collect();
    let fold: HashSet<&str> = cohort_ids
        .iter()
        .zip(folds)
        .filter(|(_, f)| **f == k)
        .map(|(id, _)| id.as_str())
        .collect();
    (
        subset_canonical(train, &rest),
        subset_canonical(train, &fold),
    )
}

fn subset_canonical(
    bundle: &CanonicalBundle,
    keep: &std::collections::HashSet<&str>,
) -> CanonicalBundle {
    CanonicalBundle {
        patients: bundle
            .patients
            .iter()
            .filter(|p| keep.contains(p.patient_id.as_str()))
            .cloned()
            .collect(),
        values: bundle
            .values
            .iter()
            .filter(|v| keep.contains(v.patient_id.as_str()))
            .cloned()
            .collect(),
        features: bundle.features.clone(),
    }
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
        self.append_log_as(method_id, TxrLogStream::Engine, content)
            .await
    }

    /// The stream-typed append (the wrapper's stdout/stderr lines from
    /// ITEM-9's sink; engine lines are the [`TxrLogStream::Engine`] default
    /// above). One line per broadcast frame — the pane's "All methods" view
    /// and "Copy the log" both read `txr_run_logs`.
    async fn append_log_as(&self, method_id: Option<&str>, stream: TxrLogStream, content: &str) {
        if let Err(e) = self
            .repo
            .append_log(self.run_id, method_id, stream, content)
            .await
        {
            tracing::warn!(run_id = %self.run_id, error = %e, "execution engine: log append failed");
            return;
        }
        let line = super::types::TxrRunLogLine {
            seq: 0,
            method_id: method_id.map(|s| s.to_string()),
            stream,
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

/// The rerun record beside the run (`input/run-input.json` — DEC-16's
/// "copies kept so it can be repeated"): the create request verbatim +
/// `rerun_of`, so `rerun_run` clones without re-parsing (the record's input
/// IS the parsed snapshot the same validator accepted).
fn write_run_input_record(
    dir: &Path,
    req: &CreateRunRequest,
    rerun_of: Option<Uuid>,
) -> Result<(), AppError> {
    let record = super::types::RunInputRecord {
        mode: req.mode,
        input: req.input.clone(),
        config: req.config.clone(),
        method_ids: req.method_ids.clone(),
        model_ids: req.model_ids.clone(),
        rerun_of,
    };
    let bytes = serde_json::to_vec_pretty(&record)
        .map_err(|e| AppError::internal_error(format!("run input record serialize: {e}")))?;
    let path = dir.join("input").join("run-input.json");
    std::fs::write(&path, bytes).map_err(io_app("write run-input record", path.clone()))
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
    start_run_inner(pool, runtime, env, executor, owner, req, None).await
}

/// `POST /api/txr/runs/{id}/rerun` (ITEM-10's route seam; PROV-EE-6): clone a
/// run from its PERSISTED record (`<run_dir>/input/run-input.json` — the
/// create-time request verbatim; the K board's "Run again with the same
/// settings"). 404 `RUN_NOT_FOUND` on an unknown id; 400
/// `RUN_INPUT_RECORD_MISSING` when the run dir holds no record (an engine
/// before ITEM-9, or pruned files). The new run's own record carries
/// `rerun_of = <source id>`.
pub async fn rerun_run(
    pool: sqlx::SqlitePool,
    runtime: Arc<RunRuntime>,
    env: Arc<dyn EnvProvider>,
    executor: Arc<dyn MethodExecutor>,
    owner: Uuid,
    run_id: Uuid,
) -> Result<TxrRunSummary, AppError> {
    let repo = TxrRepository::new(pool.clone());
    let source = repo.get_run(run_id).await?.ok_or_else(|| {
        AppError::new(
            axum::http::StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {run_id}"),
        )
    })?;
    let record_path = Path::new(&source.dir).join("input").join("run-input.json");
    let bytes = std::fs::read(&record_path).map_err(|e| {
        AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "RUN_INPUT_RECORD_MISSING",
            format!("run {run_id} input record missing: {e}"),
        )
    })?;
    let record: super::types::RunInputRecord = serde_json::from_slice(&bytes).map_err(|e| {
        AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "RUN_INPUT_RECORD_MISSING",
            format!("run {run_id} input record unreadable: {e}"),
        )
    })?;
    start_run_inner(
        pool,
        runtime,
        env,
        executor,
        owner,
        CreateRunRequest {
            mode: record.mode,
            input: record.input,
            config: record.config,
            method_ids: record.method_ids,
            model_ids: record.model_ids,
        },
        Some(run_id),
    )
    .await
}

/// Delete a run dir (PLAN ITEM-9's prune path; ITEM-10's `DELETE
/// ?delete_files=true` tail — the row cascade is the repository's, the FILES
/// are this): best-effort removal, a missing dir is success (the run's files
/// were already pruned / never written), and an error is returned for the
/// caller to surface (a delete that silently keeps a folder would violate
/// the K board's "copies are not kept").
pub fn prune_run_dir(dir: &Path) -> Result<(), AppError> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_app("prune run dir", dir.to_path_buf())(e)),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The control surface (ITEM-10's route seams — PROV-EE-6): every stop/skip/
// lane change resolves the LIVE drive first (the drive owns its method tasks
// and cancel channels — INV-2's "stop/skip" machine), then falls back to a
// DB transition for a run whose drive is not in THIS process (a boot-
// reconcile leftover, or the create-race window between the runtime
// registration and the drive registration). The fallback is the SAME typing
// the drive applies, so a consumer cannot observe one heading from the drive
// and another from the fallback.
// ─────────────────────────────────────────────────────────────────────────────

fn run_not_found(run_id: Uuid) -> AppError {
    AppError::new(
        axum::http::StatusCode::NOT_FOUND,
        "RUN_NOT_FOUND",
        format!("no run {run_id}"),
    )
}

fn method_not_found(run_id: Uuid, method_id: &str) -> AppError {
    AppError::new(
        axum::http::StatusCode::NOT_FOUND,
        "METHOD_NOT_FOUND",
        format!("method {method_id:?} is not part of run {run_id}"),
    )
}

fn method_not_active(run_id: Uuid, method_id: &str, state: &str) -> AppError {
    AppError::new(
        axum::http::StatusCode::CONFLICT,
        "METHOD_NOT_ACTIVE",
        format!("method {method_id:?} of run {run_id} is already {state}"),
    )
}

fn method_not_skippable(run_id: Uuid, method_id: &str, state: &str) -> AppError {
    AppError::new(
        axum::http::StatusCode::CONFLICT,
        "METHOD_NOT_SKIPPABLE",
        format!("method {method_id:?} of run {run_id} is {state}"),
    )
}

fn run_not_active(run_id: Uuid, state: &str) -> AppError {
    AppError::new(
        axum::http::StatusCode::CONFLICT,
        "RUN_NOT_ACTIVE",
        format!("run {run_id} is already {state}"),
    )
}

/// Stop the whole run (stop-all). The drive path signals the run-stop +
/// every method flag + the admitted jobs' cancels; the DB fallback marks
/// running → `stopped` + `ABORTED` and waiting/downloading → `skipped`
/// (PROV-EE-6's typing), finalizes the run `stopped`, and logs "stopped by
/// the user". An already-stopped run is an idempotent success; `finished`/
/// `failed` is `409 RUN_NOT_ACTIVE`.
pub async fn stop_run(
    pool: sqlx::SqlitePool,
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
    if let Some(drive) = drive_for(run_id) {
        drive.signal_stop_all();
        return Ok(());
    }
    // A run-stop ALREADY registered on the runtime (a drive about to start —
    // the create-race window): the signal reaches the drive's run_stop
    // channel, so the DB fallback must not pre-empt the drive's own finalize.
    if runtime.signal_cancel(run_id) {
        return Ok(());
    }
    stop_run_from_db(&repo, &row).await
}

async fn stop_run_from_db(repo: &TxrRepository, row: &RunRow) -> Result<(), AppError> {
    let run_id = row.id;
    for m in repo.methods_for_run(run_id).await? {
        match m.state()? {
            TxrMethodState::Waiting | TxrMethodState::Downloading => {
                repo.patch_method(
                    run_id,
                    &m.method_id,
                    &MethodPatch {
                        state: Some(TxrMethodState::Skipped),
                        finished_at: Some(Utc::now()),
                        ..Default::default()
                    },
                )
                .await?;
            }
            TxrMethodState::Running => {
                repo.patch_method(
                    run_id,
                    &m.method_id,
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
            }
            _ => {}
        }
    }
    let counts = repo.method_counts(run_id).await?;
    let elapsed = row
        .started_at
        .map(|s| (Utc::now() - s).num_seconds().max(0) as u64)
        .unwrap_or(0);
    repo.finish_run(
        run_id,
        TxrRunStatus::Stopped,
        elapsed,
        &counts,
        counts.finished > 0,
        None,
    )
    .await?;
    repo.append_log(run_id, None, TxrLogStream::Engine, "stopped by the user")
        .await?;
    Ok(())
}

/// Stop ONE method (waiting/downloading/running → `stopped` + `ABORTED`; a
/// terminal row is `409 METHOD_NOT_ACTIVE`, PROV-EE-6's wording).
pub async fn stop_method(
    pool: sqlx::SqlitePool,
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
    if let Some(drive) = drive_for(run_id) {
        if drive.signal_stop_method(method_id) {
            return Ok(());
        }
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
    repo.append_log(run_id, Some(method_id), TxrLogStream::Engine, "stopped by the user")
        .await?;
    let counts = repo.method_counts(run_id).await?;
    repo.update_run_counts(run_id, &counts).await?;
    Ok(())
}

/// Skip ONE method (waiting/downloading only — a running method is never
/// skippable, `409 METHOD_NOT_SKIPPABLE`: it must be stopped first,
/// PROV-EE-6).
pub async fn skip_method(
    pool: sqlx::SqlitePool,
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
    if let Some(drive) = drive_for(run_id) {
        if drive.signal_skip_method(method_id) {
            return Ok(());
        }
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
    repo.append_log(run_id, Some(method_id), TxrLogStream::Engine, "skipped")
        .await?;
    let counts = repo.method_counts(run_id).await?;
    repo.update_run_counts(run_id, &counts).await?;
    Ok(())
}

/// The mid-run lane change (CONS-UI-RUN-11): outside 1..=8 is
/// `400 INVALID_AT_A_TIME` (reject, never silently clamp — the estimate
/// provider's own posture); a running method is never interrupted (the
/// drive's lane gate applies the new count from the next admission); the
/// run row's config is rewritten so the summary serves the change.
pub async fn set_at_a_time_run(
    pool: sqlx::SqlitePool,
    run_id: Uuid,
    at_a_time: u32,
) -> Result<TxrRunSummary, AppError> {
    if !(TxrLimits::AT_A_TIME_MIN..=TxrLimits::AT_A_TIME_MAX).contains(&at_a_time) {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
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
    if let Some(drive) = drive_for(run_id) {
        drive.set_at_a_time(at_a_time);
    }
    repo.update_run_at_a_time(run_id, at_a_time).await?;
    // qa-fixes2 ITEM-6 (R2-2): the lane change REPLACES the run's stored
    // estimate — same create-time inputs (the run's queued method set, its
    // patient count and CPU count), the new lane count, the same measured-
    // time calibration — so the F header's time-left follows the control
    // instead of keeping the create-time schedule. A recompute failure
    // leaves the old estimate (a display fact, never a run error).
    recompute_run_estimate(&repo, &row, at_a_time).await;
    repo.get_run_summary(run_id)
        .await?
        .ok_or_else(|| AppError::internal_error("run row vanished after lane change"))
}

/// The lane-change estimate recompute: the run's stored estimate is replaced
/// with the schedule at the new lane count (the same estimate-model
/// semantics as create — the F header keeps subtracting the elapsed from
/// it). The calibration snapshot applies like at create, so a lane change
/// also picks up any measurement recorded since the run started.
async fn recompute_run_estimate(
    repo: &TxrRepository,
    row: &RunRow,
    at_a_time: u32,
) {
    let cpus = row.cpus.map(|c| c.max(1) as u32).unwrap_or_else(crate::modules::method_catalogue::estimate::host_cpus);
    let Ok(input_summary) = serde_json::from_value::<super::types::TxrRunInputSummary>(row.input_summary.clone()) else {
        tracing::warn!(run_id = %row.id, "execution engine: lane-change estimate skipped — unreadable input summary");
        return;
    };
    let Some(patients) = input_summary.patients else {
        return; // no cohort fact — nothing to scale (same as create-time None)
    };
    let Ok(method_rows) = repo.methods_for_run(row.id).await else {
        tracing::warn!(run_id = %row.id, "execution engine: lane-change estimate skipped — unreadable rows");
        return;
    };
    // The create-time method set: the queued (not `cannot_run`) plans. The
    // run's terminal rows stay in the set — the estimate model is the whole
    // schedule at this lane count, and the header subtracts the elapsed.
    let method_ids: Vec<String> = method_rows
        .iter()
        .filter(|m| !matches!(m.state(), Ok(super::types::TxrMethodState::CannotRun)))
        .map(|m| m.method_id.clone())
        .collect();
    if method_ids.is_empty() {
        return;
    }
    let calibration = load_timing_calibration(repo).await;
    let req = EstimateRequest {
        method_ids,
        patients,
        cpus: Some(cpus),
        at_a_time: at_a_time.max(1),
    };
    let resp = match estimate::estimate_for_runtime_calibrated(
        crate::modules::method_catalogue::catalogue::catalogue(),
        &req,
        &calibration,
    ) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(run_id = %row.id, error = %e, "execution engine: lane-change estimate failed");
            return;
        }
    };
    let quality = resp.methods.iter().fold(TimingQuality::Measured, |q, m| {
        if q == TimingQuality::Measured && m.estimate_quality == TimingQuality::Estimate {
            TimingQuality::Estimate
        } else {
            q
        }
    });
    if let Err(e) = repo
        .update_run_estimate(row.id, &super::types::TxrRunEstimate {
            total_seconds: resp.total_seconds,
            schedule_seconds: resp.schedule_seconds,
            estimate_quality: quality,
        })
        .await
    {
        tracing::warn!(run_id = %row.id, error = %e, "execution engine: lane-change estimate store failed");
    }
}

async fn start_run_inner(
    pool: sqlx::SqlitePool,
    runtime: Arc<RunRuntime>,
    env: Arc<dyn EnvProvider>,
    executor: Arc<dyn MethodExecutor>,
    owner: Uuid,
    req: CreateRunRequest,
    rerun_of: Option<Uuid>,
) -> Result<TxrRunSummary, AppError> {
    req.validate().map_err(request_error_to_app)?;
    check_methods_known(&req)?;

    // PROV-EE-2's `409 RUN_ALREADY_ACTIVE`: the app drives ONE analysis at a
    // time (a second create — or a rerun of a STILL-ACTIVE run — would spawn
    // a second lane fleet against the same inputs). A boot-reconciled run is
    // terminal, so a fresh boot never trips this on a stale row; the check
    // lives in `start_run_inner` so the rerun path inherits it (ITEM-10's
    // route seam; TEST-EE-30's 409 arm).
    if let Some(active) = TxrRepository::new(pool.clone()).active_run().await? {
        return Err(AppError::new(
            axum::http::StatusCode::CONFLICT,
            "RUN_ALREADY_ACTIVE",
            format!("a run is already active: {active}"),
        ));
    }

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
    // The estimate facts (CONS-EE-9b's "stored on the run"; ITEM-9's estimate
    // store): the F header's "about 7 minutes left" is a create-time fact —
    // computed once here, never re-derived (the estimate provider's response
    // shape; a compute failure is logged and stays NULL, never a run error).
    // The measured-time calibration snapshot is loaded per create (R2-3) —
    // fail-open, an empty calibration is the uncalibrated engine.
    let calibration = load_timing_calibration(&repo).await;
    let estimate = compute_estimate(&req, &prepared, cpus, &calibration);

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
        estimate,
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
        write_run_input_record(&dir, &req, rerun_of)?;
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

/// The measured-time calibration snapshot (qa-fixes2 ITEM-6, R2-3): the
/// estimate's per-method bases come from THIS app's recorded durations. The
/// load fails OPEN — the estimate is a display fact, never a run error; an
/// empty calibration is byte-identical to the uncalibrated engine.
async fn load_timing_calibration(
    repo: &TxrRepository,
) -> crate::modules::method_catalogue::calibration::TimingCalibration {
    match repo.timing_samples().await {
        Ok(samples) => crate::modules::method_catalogue::calibration::TimingCalibration::from_samples(&samples),
        Err(e) => {
            tracing::warn!(error = %e, "execution engine: timing calibration read failed; estimating uncalibrated");
            crate::modules::method_catalogue::calibration::TimingCalibration::empty()
        }
    }
}

/// The create-time estimate facts (CONS-EE-9b's "the engine stores it on the
/// run" — the F header's "about 7 minutes left"): the ITEM-4 provider over the
/// run's QUEUED (not `cannot_run`) plans, the run's patient count, and the
/// run's own cpus/at_a_time — with the app's measured-time calibration
/// applied (qa-fixes2 ITEM-6, R2-3: the estimate was 2-7 times too high; a
/// method the app has already measured estimates with its own median per-fold
/// seconds). A provider failure or an empty queued set is logged and yields
/// `None` — the estimate is a display fact, NEVER a run error (DRIFT-1
/// ITEM-9 #6: stored at create, not finalize — the header needs it while the
/// run is still running).
fn compute_estimate(
    req: &CreateRunRequest,
    prepared: &PreparedRun,
    cpus: u32,
    calibration: &crate::modules::method_catalogue::calibration::TimingCalibration,
) -> Option<TxrRunEstimate> {
    // Reuse plans carry model_ids as their method_id, but the estimate engine
    // resolves CATALOGUE ids — the plan's `label` is the catalogue method id
    // in both modes (train: id == label).
    let method_ids: Vec<String> = prepared
        .plans
        .iter()
        .filter(|p| !p.cannot_run)
        .map(|p| p.label.clone())
        .collect();
    let patients = match req.mode {
        super::types::TxrRunMode::Train => prepared.train.as_ref()?.patients.len() as u32,
        super::types::TxrRunMode::Reuse => prepared.predict.as_ref()?.patients.len() as u32,
    };
    let at_a_time = req.config.at_a_time.max(1);
    let resp = match estimate::estimate_for_runtime_calibrated(
        crate::modules::method_catalogue::catalogue::catalogue(),
        &EstimateRequest {
            method_ids,
            patients,
            cpus: Some(cpus),
            at_a_time,
        },
        calibration,
    ) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "execution engine: run estimate failed");
            return None;
        }
    };
    // The run-level quality: the worst of the per-method qualities (the
    // schedule is only "measured" when every leg is).
    let quality = resp.methods.iter().fold(TimingQuality::Measured, |q, m| {
        if q == TimingQuality::Measured && m.estimate_quality == TimingQuality::Estimate {
            TimingQuality::Estimate
        } else {
            q
        }
    });
    Some(TxrRunEstimate {
        total_seconds: resp.total_seconds,
        schedule_seconds: resp.schedule_seconds,
        estimate_quality: quality,
    })
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
        // qa-fixes2 R2-04: the predict-side PATIENT count — the validator's
        // distinct-patient fact (`measurements.patients`), never the row
        // count. The K row's "Predicted N patients" was printing 630 for a
        // 94-patient / 630-row file (the wire field's old meaning).
        predict_patients: prepared.predict_patient_count,
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

/// Detected CPU count (DEC-12: `available_parallelism`, fallback 4) — the ONE
/// implementation lives with the estimate provider ([`method_catalogue::estimate::host_cpus`]),
/// so the run's detection and the estimate's Auto resolution cannot drift
/// (CM-7); this accessor is the engine's name for the same fact.
pub fn detect_cpus() -> u32 {
    crate::modules::method_catalogue::estimate::host_cpus()
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

/// The run's one validate + canonicalize pass over its tables
/// ([`canonicalize_run`]): the validation response (whose `inventory` the
/// classification judges) and the canonical sides the method calls build
/// their bundles from.
pub(crate) struct CanonicalRun {
    pub validated: crate::modules::file_validator::types::ValidationResponse,
    pub train: Option<Arc<CanonicalBundle>>,
    pub predict: Option<Arc<CanonicalBundle>>,
    pub predict_patients: Option<Arc<[CanonicalPatient]>>,
    /// The predict side's distinct patient count (qa-fixes2 R2-04 — the
    /// validator's measurements summary, never the row count).
    pub predict_patient_count: Option<u32>,
}

/// The prepared facts of a run: the canonical sides + the classified plans +
/// the validator's marker count.
pub struct PreparedRun {
    pub train: Option<Arc<CanonicalBundle>>,
    pub predict: Option<Arc<CanonicalBundle>>,
    pub predict_patients: Option<Arc<[CanonicalPatient]>>,
    /// The predict side's distinct patient count (qa-fixes2 R2-04 — the
    /// validator's measurements summary, never the row count).
    pub predict_patient_count: Option<u32>,
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
    let canonical = canonicalize_run(input, config, run_mode)?;
    let plans = classify(
        run_mode,
        method_ids,
        assets,
        &canonical.validated.inventory,
        config,
    )?;
    Ok(PreparedRun {
        markers: canonical.validated.markers.len(),
        train: canonical.train,
        predict: canonical.predict,
        predict_patients: canonical.predict_patients,
        // qa-fixes2 R2-04: the predict side's distinct patient count (the
        // validator's measurements summary) — the K row's "Predicted N
        // patients" fact; None when the run has no predict file.
        predict_patient_count: canonical.predict_patient_count,
        plans,
    })
}

/// The run's validation request over the RUN's table set. The mode
/// disambiguates the pair (train: patients + measurements; reuse: predict
/// patients + predict measurements — the run's only side). The inventory
/// the eligibility engine sees is the SAME object the screens rendered —
/// one code path (DEC-15).
fn run_validation_request(
    input: &super::types::TxrRunInput,
    config: &RunConfig,
    run_mode: super::types::TxrRunMode,
) -> ValidationRequest {
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
    validation_request(
        mode,
        patients,
        measurements,
        &input.joins,
        &input.mapping,
        config.decision_day,
    )
}

/// The run's one validation (the first step of [`canonicalize_run`]),
/// without building the canonical sides — for a caller that needs only the
/// validator's verdict on a run request's tables (the example saved set).
pub(crate) fn validate_run(
    input: &super::types::TxrRunInput,
    config: &RunConfig,
    run_mode: super::types::TxrRunMode,
) -> Result<crate::modules::file_validator::types::ValidationResponse, AppError> {
    crate::modules::file_validator::validate::validate(&run_validation_request(
        input, config, run_mode,
    ))
    .map_err(validation_error_to_app)
}

/// The run's validate + canonicalize pass (the first half of `prepare_run`,
/// also used by the example saved set, so it judges exactly the tables and
/// canonical sides the run will use).
pub(crate) fn canonicalize_run(
    input: &super::types::TxrRunInput,
    config: &RunConfig,
    run_mode: super::types::TxrRunMode,
) -> Result<CanonicalRun, AppError> {
    use crate::modules::file_validator::{bundle, validate};

    // One validate per run over the RUN's table set.
    let vreq = run_validation_request(input, config, run_mode);
    let mode = vreq.mode;
    let validated = validate::validate(&vreq).map_err(validation_error_to_app)?;

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
            // The predict-side bundle AND its forensic facts come from ONE
            // validation pass (the same pure pass the FILES request got).
            let pv = validate::validate(&pvreq).map_err(validation_error_to_app)?;
            let predict_patients = Some(pv.measurements.patients);
            Some((
                Arc::new(bundle::canonical_bundle(&pvreq).map_err(validation_error_to_app)?),
                predict_patients,
            ))
        }
        _ => None,
    };
    let (train_canonical, predict_canonical, predict_patient_count) = if mode == ValidationMode::Files {
        (
            files_canonical,
            predict_extra.as_ref().map(|(b, _)| b.clone()),
            predict_extra.as_ref().and_then(|(_, p)| *p),
        )
    } else {
        // Predict-only reuse: the run's one table set is the predict side —
        // its validation's distinct-patient count is the 'predicted N' fact.
        (
            None,
            Some(Arc::new(
                bundle::canonical_bundle(&vreq).map_err(validation_error_to_app)?,
            )),
            Some(validated.measurements.patients),
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

    Ok(CanonicalRun {
        validated,
        train: train_canonical,
        predict: predict_canonical,
        predict_patients,
        predict_patient_count,
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
/// list — DEC-15's replay of the screens' one judgement; a runnable method
/// with no published environment is `cannot_run` + `ENV_UNKNOWN` at the env
/// resolution layer and `ENV_IMAGE_MISSING` from the eligibility stage
/// (TEST-EE-06: the screens' verdict and the run row now carry the SAME code
/// — the stage runs before this branch, so the CannotRun arm is what its
/// rows take; the ENV_UNKNOWN arm stays the defensive backstop).
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
                        // The verdict's first reason is the row's one reason
                        // (the eligibility stage pushes ENV_IMAGE_MISSING
                        // first for a method with no published environment —
                        // the SAME fact this branch used to discover itself
                        // and report as ENV_UNKNOWN; one vocabulary now, the
                        // screens' verdict and the run row agree, CONS-EE-10).
                        let reason = verdict
                            .reasons
                            .first()
                            .map(|r| {
                                if r.code
                                    == crate::modules::method_catalogue::types::ReasonCode::EnvImageMissing
                                {
                                    TxrRunReason::from_catalogue(
                                        r.code,
                                        format!("no published environment for method {id:?}"),
                                    )
                                } else {
                                    TxrRunReason::from_catalogue(r.code, reason_line(r))
                                }
                            })
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
    // The `finishing → finished` step (PLAN ITEM-9): the terminal state is
    // BROADCAST in `finishing` before the final counts/elapsed/predictions-
    // ready land — the F header's spinner says "finishing" while the row's
    // last write runs (a crashed finalize leaves a `finishing` row the boot
    // reconcile fails as `INTERRUPTED`, TEST-EE-19's shape).
    drive
        .repo
        .set_run_status(drive.run_id, TxrRunStatus::Finishing, None)
        .await?;
    drive.broadcast_status(TxrRunStatus::Finishing).await;

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
    let (sink, mut sink_rx) = RunMethodSink::channel();
    // The drainer: the executor's log lines + progress frames land in
    // `txr_run_logs` + the SSE stream (the pane streams during the run); it
    // ends when the executor drops its `Arc<RunMethodSink>` (one channel is
    // one method's call sequence — per-method seq stays monotone).
    {
        let drive = drive.clone();
        let method_id = method_id.clone();
        tokio::spawn(async move {
            while let Some(msg) = sink_rx.recv().await {
                match msg {
                    SinkMessage::Line { stream, content } => {
                        drive
                            .append_log_as(Some(&method_id), stream, &content)
                            .await;
                    }
                    SinkMessage::Progress {
                        phase,
                        pct,
                        message,
                    } => {
                        drive
                            .broadcast_progress(&method_id, Some(phase), pct, message)
                            .await;
                        // The phase column follows the milestone frames (the
                        // fit/predict ticker); patch is a COALESCE step so the
                        // row's other fields keep their values.
                        let _ = drive
                            .patch(
                                &method_id,
                                MethodPatch {
                                    phase: Some(phase),
                                    ..Default::default()
                                },
                            )
                            .await;
                    }
                }
            }
        });
    }
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
        target: match &plan.target {
            RunTarget::TrainMethod => RunTarget::TrainMethod,
            RunTarget::ReuseModel { asset } => RunTarget::ReuseModel {
                asset: asset.clone(),
            },
        },
        sink,
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
            // qa-fixes2 ITEM-6 (R2-3): a finished TRAIN-mode method records
            // its measured seconds for the estimate calibration — the next
            // run's per-method estimate uses this app's own median. A reuse
            // run measures the predict half alone (no fit) and is excluded;
            // a record write failure is a warn, never a method failure (the
            // calibration is a display fact).
            if outcome.state == TxrMethodState::Finished && prepared.train.is_some() {
                if let Some(ms) = outcome.duration_ms {
                    let sample = crate::modules::method_catalogue::calibration::TimingSample {
                        method_id: method_id.clone(),
                        measured_ms: ms,
                        patients: prepared.train.as_ref().map(|t| t.patients.len() as u32).unwrap_or(0),
                        cpus: drive.cpus,
                    };
                    if let Err(e) = drive.repo.record_timing_sample(&sample, drive.run_id).await {
                        tracing::warn!(%method_id, error = %e, "execution engine: timing sample record failed");
                    }
                }
            }
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
    // qa-fixes2 ITEM-6 (R2-4): the downloading state is a fact about a
    // FETCH, not about the env phase — a cache-hit phase (the layer is
    // already verified; `bytes_downloaded` stays 0) must not render a
    // "downloading" row and count it in the strip. The row's START still
    // marks the env phase's beginning (`started_at` — the Time column's
    // live-elapsed anchor), and the state patch is deferred until the
    // 500 ms poll sees bytes flowing (or a download in flight); the row
    // stays `waiting` (its pre-lane state — a cache hit turns `running` as
    // before).
    let start_patch = MethodPatch {
        phase: Some(TxrPhase::Env),
        started_at: Some(Utc::now()),
        ..Default::default()
    };
    if let Err(e) = drive.patch(&plan.method_id, start_patch).await {
        tracing::warn!(method_id = %plan.method_id, error = %e, "execution engine: env start patch failed");
    }
    let mut downloading_patched = false;
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
                // The deferred downloading patch (see above): only a real
                // fetch counts. The row's `phase` follows the state; the
                // progress frames carry the env phase either way.
                if !downloading_patched
                    && (st.bytes_downloaded > 0
                        || st.state == crate::modules::sandbox::method_env::MethodEnvState::Downloading)
                {
                    downloading_patched = true;
                    let patch = MethodPatch {
                        state: Some(TxrMethodState::Downloading),
                        ..Default::default()
                    };
                    if let Err(e) = drive.patch(&plan.method_id, patch).await {
                        tracing::warn!(method_id = %plan.method_id, error = %e, "execution engine: downloading patch failed");
                    }
                }
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

/// Engine fixtures that other modules' tests drive: the REAL train executor
/// over a scripted sandbox, with the context the drive builds. A feature's
/// tests exercise the engine path through this, so the engine's own tests do
/// not depend on that feature.
#[cfg(test)]
pub(crate) mod test_support {
    use super::tests::{
        executor_ctx, make_method_dirs, merged_pool, test_data_dir, FakeStackRunSeam,
    };
    use super::*;

    /// One planned method of [`train_with_scripted_sandbox`].
    pub(crate) struct ScriptedMethod {
        pub method_id: String,
        /// The plan's `cannot_run` flag and reason (`classify`).
        pub cannot_run: bool,
        pub reason: Option<TxrRunReason>,
        /// The plan's `min_draws` (the context's).
        pub min_draws: u32,
        /// [`call_bundle_preflight`] over the call's context.
        pub preflight: Result<(), bundle::BundleError>,
        /// The real executor's verdict.
        pub outcome: MethodOutcome,
        /// The scripted sandbox's calls, in order.
        pub calls: Vec<MethodRunMode>,
    }

    /// The prepared canonical sides + every planned method's run.
    pub(crate) struct ScriptedTrainRun {
        pub train: Option<Arc<CanonicalBundle>>,
        pub predict: Option<Arc<CanonicalBundle>>,
        pub methods: Vec<ScriptedMethod>,
    }

    /// Prepare a train request through the run's own `prepare_run`, then run
    /// every planned method through the real `StackMethodExecutor::execute`
    /// with the context `run_method` builds (the plan's `min_draws`, the run
    /// config, the detected CPU count, the prepared sides) and a scripted
    /// sandbox. A plan the host cannot run (no published env) is still
    /// executed — the bundle stage and the calls do not depend on the env —
    /// and its `cannot_run` facts are reported.
    pub(crate) async fn train_with_scripted_sandbox(
        req: &CreateRunRequest,
        data_dir: &str,
    ) -> ScriptedTrainRun {
        assert_eq!(
            req.mode,
            crate::modules::execution_engine::types::TxrRunMode::Train,
            "a train request"
        );
        let _g = rootfs::scoped_data_root(test_data_dir(data_dir));
        let prepared = prepare_run(
            &req.input,
            &req.config,
            req.mode,
            &req.method_ids,
            &req.model_ids,
        )
        .expect("the request prepares");
        let pool = merged_pool().await;
        let mut methods = Vec::new();
        for plan in &prepared.plans {
            let facts = envmanifest::facts_for(&plan.method_id).expect("a catalogue method");
            let seam = FakeStackRunSeam::new();
            let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
            let run_dir = rootfs::data_root().join(&plan.method_id);
            make_method_dirs(&run_dir, &plan.method_id);
            let (mut ctx, _cancel) = executor_ctx(
                &run_dir,
                &plan.method_id,
                prepared.train.clone(),
                prepared.predict.clone(),
                prepared.predict_patients.clone(),
                req.config.save_models,
                RunTarget::TrainMethod,
            );
            ctx.label = plan.label.clone();
            ctx.version = plan.version.clone();
            ctx.group = plan.group.clone();
            ctx.min_draws = plan.min_draws;
            ctx.config = req.config.clone();
            ctx.cpus = detect_cpus();
            let preflight = call_bundle_preflight(&ctx, facts);
            let outcome = exec.execute(ctx).await.expect("an executor verdict");
            let calls = seam
                .calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .map(|c| c.mode)
                .collect();
            methods.push(ScriptedMethod {
                method_id: plan.method_id.clone(),
                cannot_run: plan.cannot_run,
                reason: plan.reason.clone(),
                min_draws: plan.min_draws,
                preflight,
                outcome,
                calls,
            });
        }
        ScriptedTrainRun {
            train: prepared.train,
            predict: prepared.predict,
            methods,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::modules::execution_engine::predictions;
    use crate::modules::execution_engine::repository::TxrRepository;
    use crate::modules::execution_engine::types::{
        self, CreateRunRequest, RunConfig, TxrMethodEnv, TxrRunFileNames, TxrRunInput,
        TxrRunInputSummary, TxrRunMode, TxrTask,
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

    /// 30 patients (so each cross-fit fold's REST subset clears
    /// [`bundle::MIN_TRAINING_PATIENTS`] — 20 per fold — and every learned
    /// outcome of it is never warning-dropped) × 3 draws, all events strictly
    /// after the decision day. The survival times STRADDLE the 238-day
    /// look-ahead (110..=410), so the own-data AUC sees both label classes
    /// (event by h → 1, event-free beyond h → 0); a fixture with every time
    /// below h has no usable comparison pair (the engine's null-when-no-data
    /// rule).
    fn cohort_patients_table() -> ParsedTable {
        let mut rows = Vec::new();
        for i in 1..=30 {
            let id = format!("C{i:02}");
            let pfs = 100 + i * 10;
            let os = 120 + i * 10;
            rows.push(vec![
                id,
                (pfs as f64).to_string(),
                if i % 2 == 1 { "1" } else { "0" }.to_string(),
                (os as f64).to_string(),
                if i % 3 == 0 { "1" } else { "0" }.to_string(),
            ]);
        }
        let rows: Vec<Vec<&str>> = rows
            .iter()
            .map(|r| r.iter().map(|s| s.as_str()).collect())
            .collect();
        let rows_ref: Vec<&[&str]> = rows.iter().map(|r| r.as_slice()).collect();
        table(
            &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
            &rows_ref,
        )
    }

    fn cohort_measurements_table() -> ParsedTable {
        let mut rows = Vec::new();
        for i in 1..=30 {
            let id = format!("C{i:02}");
            for (day, value) in [("0", "100"), ("28", "110"), ("56", "105")] {
                rows.push(vec![
                    id.clone(),
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

    /// The cohort run request: 30 patients, the drive-able methods' fixture.
    fn cohort_run_request(methods: &[&str], at_a_time: u32, save_models: bool) -> CreateRunRequest {
        CreateRunRequest {
            mode: TxrRunMode::Train,
            input: TxrRunInput {
                patients: Some(cohort_patients_table()),
                measurements: cohort_measurements_table(),
                predict_measurements: None,
                joins: Vec::new(),
                mapping: Vec::new(),
                keep_copies: true,
            },
            config: RunConfig {
                at_a_time,
                decision_day: 56.0,
                look_ahead_day: 238.0,
                save_models,
                ..Default::default()
            },
            method_ids: methods.iter().map(|s| s.to_string()).collect(),
            model_ids: Vec::new(),
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
    pub(super) async fn merged_pool() -> SqlitePool {
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
    pub(super) fn test_data_dir(name: &str) -> PathBuf {
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
            format!("{TXR_BASE_REGISTRY_PREFIX}/base-r"),
            "language → the app's base repo, NEVER the benchmark base_ref (provenance only)"
        );
        assert_eq!(
            base.digest,
            "f".repeat(64),
            "the app-side base payload pin (DEV: the dev publisher records the base squashfs sha256; \
             the published manifest's benchmark base digest is provenance)"
        );
        assert_eq!(
            base.tag.as_deref(),
            Some("2.0-amd64"),
            "the immutable base tag <contract>-<arch> — a digest-addressed ref would need a \
             manifest digest that equals the payload hash, which no OCI registry can serve"
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
            Some("ENV_IMAGE_MISSING"),
            "runnable method with no published environment — never a silent skip; the \
             eligibility stage's own code is the run row's code (one vocabulary)"
        );
        assert_eq!(
            jm.reason.as_ref().map(|r| r.detail.as_str()),
            Some("no published environment for method \"jm-mem-lq\""),
            "the row's detail line is the engine's plain reason"
        );

        let bayes = by_id["bayes-pt-cure-joint"];
        assert!(bayes.cannot_run);
        assert_eq!(
            bayes.reason.as_ref().map(|r| r.code.as_str()),
            Some("ENV_IMAGE_MISSING"),
            "task-less method is compatible with the file's outcomes (owner rule 2026-10-20) \
             but has no published environment — the cannot-run reason is the env entry, never \
             a task mismatch"
        );
    }

    // qa-fixes2 R2-04: GET /runs/<id> history's "Predicted N patients" was
    // the predict table's ROW count (630 rows for a 94-patient file). The
    // fact is now the validator's distinct-patient count.
    #[test]
    fn predict_patient_count_is_the_validators_distinct_patients_not_the_row_count() {
        let measurements = measurements_table(); // 6 patients × 18 rows
        let input = TxrRunInput {
            patients: None,
            measurements: measurements.clone(),
            predict_measurements: Some(measurements.clone()),
            joins: Vec::new(),
            mapping: Vec::new(),
            keep_copies: true,
        };
        let config = RunConfig {
            at_a_time: 2,
            decision_day: 56.0,
            look_ahead_day: 238.0,
            ..Default::default()
        };
        let prepared = prepare_run(
            &input,
            &config,
            TxrRunMode::Reuse,
            &["landmark-cox-current".to_string()],
            &[],
        )
        .expect("the predict-only file validates");
        assert_eq!(
            prepared.predict_patient_count,
            Some(6),
            "6 patients across 18 rows — the fact is the validator's distinct count"
        );
        let req = CreateRunRequest {
            mode: TxrRunMode::Reuse,
            input,
            config,
            method_ids: vec!["landmark-cox-current".to_string()],
            model_ids: Vec::new(),
        };
        assert_eq!(
            input_summary(&req, &prepared).predict_patients,
            Some(6),
            "the history row's 'Predicted N patients' reads the distinct count"
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
    async fn a_finished_train_method_records_its_timing_sample() {
        // qa-fixes2 ITEM-6 (R2-3): the estimate calibration memory — a
        // finished train-mode method's duration + the run's patient count and
        // CPU count land in `txr_timing_samples` (a reuse run never records:
        // it predicts alone and would skew the per-fold base).
        let _g = rootfs::scoped_data_root(test_data_dir("timing-sample"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_secs(5)));
        let executor = Arc::new(FakeExecutor::new(Duration::from_millis(30)));
        let req = run_request(&["landmark-cox-current"], 1, true);
        let summary = start_run(pool.clone(), runtime, env, executor, owner(), req)
            .await
            .expect("create");
        let repo = TxrRepository::new(pool.clone());
        let _ = wait_terminal(&repo, summary.id).await;
        let samples = repo.timing_samples().await.expect("samples read");
        assert_eq!(samples.len(), 1, "one finished method = one sample: {samples:?}");
        let s = &samples[0];
        assert_eq!(s.method_id, "landmark-cox-current");
        assert!(s.measured_ms > 0, "the run was measured: {}", s.measured_ms);
        assert!(s.patients > 0);
        assert!(s.cpus >= 1);
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

    // ── ITEM-9: the executor over scripted sandbox calls ────────────────────

    /// One scripted sandbox call (the assertion side of the seam): what the
    /// executor handed the sandbox, + the request's own understanding of its
    /// task (the mount + the fit-model-out request).
    #[derive(Debug, Clone, PartialEq)]
    pub(super) struct SeamCall {
        pub(super) mode: MethodRunMode,
        /// The `ModelMount{host, digest}` of a reuse call (None for a fit).
        mount: Option<(String, String)>,
        /// The fit writes its `/model` into this dir (None for a reuse call).
        model_out: Option<std::path::PathBuf>,
        /// The scored ids the fake read from `test/patients.csv` (the rows
        /// the predictions.csv must answer, exactly).
        scored: Vec<String>,
        /// The params.json the executor wrote for the call.
        params: serde_json::Value,
        /// The training files present? (combined mode writes train/ too).
        has_train: bool,
    }

    /// The scripted [`StackRunSeam`]: reads the request's bundle, emits a
    /// deterministic `predictions.csv` + `run.json`, verifies + records the
    /// mount, writes a `/model` tree on fit — the bwrap-free executor half
    /// (the ITEM-8 FakeEnv/FakeExecutor pattern; TEST-EE-18's loopback-free
    /// fixture.
    pub(super) struct FakeStackRunSeam {
        pub(super) calls: Arc<Mutex<Vec<SeamCall>>>,
        /// `Some` = the next call fails with this `(exit_code, timed_out)`.
        fail: Arc<Mutex<Option<(i32, bool)>>>,
    }

    impl FakeStackRunSeam {
        pub(super) fn new() -> Arc<Self> {
            Arc::new(Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                fail: Arc::new(Mutex::new(None)),
            })
        }
    }

    impl FakeStackRunSeam {
        fn read_params(bundle_dir: &Path) -> serde_json::Value {
            std::fs::read_to_string(bundle_dir.join("params.json"))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({}))
        }

        /// The scored ids of `bundle_dir/test/patients.csv` (column 0).
        fn read_scored(bundle_dir: &Path) -> Vec<String> {
            let text = std::fs::read_to_string(bundle_dir.join("test").join("patients.csv"))
                .unwrap_or_default();
            text.lines()
                .skip(1)
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.split(',').next().unwrap_or_default().to_string())
                .collect()
        }

        /// A valid scripted output: one row per scored patient, risk varying
        /// (the `>= 5 scored` constant-risk rule), the declared columns
        /// present (the method in the tests declares risk + call — the fake
        /// writes the superset the two test methods need).
        fn write_predictions(outputs_dir: &Path, scored: &[String]) -> std::io::Result<()> {
            let mut csv = String::from(
                "patient_id,risk,risk_progression,risk_death,p_progression_H238,p_death_H238,call,note\n",
            );
            for (i, id) in scored.iter().enumerate() {
                let risk = 0.1 + (i as f64) * 0.05;
                // A fixed cycle keeps the probability inside [0, 1] whatever
                // the cohort size (the validation's probability band).
                let prob = 0.2 + ((i % 12) as f64) * 0.05;
                csv.push_str(&format!("{id},{risk},{risk},{risk},{prob},{prob},1,\n"));
            }
            std::fs::create_dir_all(outputs_dir)?;
            std::fs::write(outputs_dir.join("predictions.csv"), csv)?;
            std::fs::write(outputs_dir.join("run.json"), "{\"fixture\": true}")?;
            Ok(())
        }
    }

    #[async_trait]
    impl StackRunSeam for FakeStackRunSeam {
        async fn run(
            &self,
            req: &MethodRunRequest,
            _job_id: Uuid,
            sink: Arc<dyn ProgressSink>,
        ) -> Result<MethodRunResult, AppError> {
            let scored = Self::read_scored(&req.bundle_dir);
            let params = Self::read_params(&req.bundle_dir);
            let has_train = req.bundle_dir.join("train").is_dir();
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(SeamCall {
                    mode: req.mode,
                    mount: req
                        .model
                        .as_ref()
                        .map(|m| (m.host_path.display().to_string(), m.tree_sha256.clone())),
                    model_out: req.model_out_dir.clone(),
                    scored: scored.clone(),
                    params,
                    has_train,
                });
            // The mount is verified like the service's verify-before-bind.
            if let Some(m) = &req.model {
                let digest = crate::modules::sandbox::stack::tree_sha256(&m.host_path)?;
                if digest != m.tree_sha256 {
                    return Err(AppError::new(
                        axum::http::StatusCode::BAD_REQUEST,
                        "MODEL_VERIFY_FAILED",
                        format!("fixture: digest mismatch of {}", m.host_path.display()),
                    ));
                }
            }
            let model_out_digest = if let Some(mdir) = &req.model_out_dir {
                let dir_err =
                    |e: std::io::Error| AppError::internal_error(format!("fixture model dir: {e}"));
                std::fs::create_dir_all(mdir).map_err(dir_err)?;
                std::fs::write(mdir.join("model.rds"), "fixture-model").map_err(dir_err)?;
                Some(crate::modules::sandbox::stack::tree_sha256(mdir)?)
            } else {
                None
            };
            // The log line + milestone ride the sink (CONS-EE-5's frames);
            // the milestone id follows the call mode exactly like the real
            // wrapper's `sigbench_mode` (stack.rs): fit vs predict.
            sink.progress(ProgressFrame {
                phase: crate::modules::sandbox::service::LOG_PHASE_STDOUT.to_string(),
                pct: None,
                message: Some("fixture says hi".to_string()),
            });
            sink.milestone(MilestoneFrame {
                id: match req.mode {
                    MethodRunMode::FitOnly => "fit",
                    _ => "predict",
                }
                .to_string(),
                status: "done".to_string(),
                detail: serde_json::Value::Null,
            });
            // The scripted failure arm (a non-zero exit / a timeout).
            let (exit_code, timed_out) = self
                .fail
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .unwrap_or((0, false));
            if exit_code != 0 || timed_out {
                // A failed call writes the outputs the sandbox would have — a
                // partial file is exactly what a real timeout leaves behind.
            } else {
                Self::write_predictions(&req.outputs_dir, &scored)
                    .map_err(|e| AppError::internal_error(format!("fixture outputs: {e}")))?;
            }
            Ok(MethodRunResult {
                exit_code,
                stderr: if exit_code != 0 {
                    "fixture boom\nline two\n".to_string()
                } else {
                    String::new()
                },
                stdout: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out,
                duration_ms: 42,
                base_env_digest: "a".repeat(64),
                layer_env_digest: "b".repeat(64),
                model_verified: req.model.is_some(),
                model_out_digest,
            })
        }
    }

    /// The scripted-`MethodRunContext` helper (the executor unit fixture does
    /// not need the lane/admission wiring — ctx construction is IN this file).
    /// The cancel SENDER is returned alongside, and the caller keeps it alive
    /// for the `execute` call (a dropped sender makes `cancel.changed()`
    /// error immediately, which the executor reads as an abort).
    pub(super) fn executor_ctx(
        run_dir: &Path,
        method_id: &str,
        train: Option<Arc<CanonicalBundle>>,
        predict: Option<Arc<CanonicalBundle>>,
        predict_patients: Option<Arc<[CanonicalPatient]>>,
        save_models: bool,
        target: RunTarget,
    ) -> (MethodRunContext, watch::Sender<bool>) {
        let (cancel_tx, cancel) = watch::channel(false);
        (
            MethodRunContext {
                run_id: Uuid::new_v4(),
                method_id: method_id.to_string(),
                label: method_id.to_string(),
                version: "2.0.0".to_string(),
                group: "fixture".to_string(),
                min_draws: 2,
                env: EnvFacts {
                    base: crate::modules::sandbox::stack::EnvRef {
                        oci_ref: "ghcr.io/fixture/base-r@sha256:abc".to_string(),
                        digest: "c".repeat(64),
                        tag: None,
                    },
                    layer: crate::modules::sandbox::stack::EnvRef {
                        oci_ref: "ghcr.io/fixture/layer".to_string(),
                        digest: "d".repeat(64),
                        tag: None,
                    },
                    base_digest: "c".repeat(64),
                    layer_digest: "d".repeat(64),
                },
                job_id: Uuid::new_v4(),
                cancel,
                config: RunConfig {
                    decision_day: 56.0,
                    look_ahead_day: 238.0,
                    save_models,
                    ..Default::default()
                },
                cpus: 4,
                train,
                predict,
                predict_patients,
                run_dir: run_dir.to_path_buf(),
                save_models,
                target,
                sink: RunMethodSink::channel().0,
            },
            cancel_tx,
        )
    }

    /// The executor's per-method dir skeleton (bundles/output/models).
    pub(super) fn make_method_dirs(run_dir: &Path, method_id: &str) -> (PathBuf, PathBuf, PathBuf) {
        let bundles = run_dir.join("bundles").join(method_id);
        let outputs = run_dir.join("output").join(method_id);
        let models = run_dir.join("models").join(method_id);
        std::fs::create_dir_all(&bundles).unwrap();
        std::fs::create_dir_all(&outputs).unwrap();
        std::fs::create_dir_all(&models).unwrap();
        (bundles, outputs, models)
    }

    /// The executor fixture's pre-run milestone: the trained `CanonicalBundle`
    /// (the cohort fixture, validated like the run start's, tightened to the
    /// 30-patient cohort so the train bundle LEARNS both outcomes and
    /// each cross-fit fold's rest subset stays learnable).
    async fn executor_prepared(method_id: &str) -> PreparedRun {
        let req = cohort_run_request(&[method_id], 2, true);
        prepare_run(
            &req.input,
            &req.config,
            TxrRunMode::Train,
            &req.method_ids,
            &[],
        )
        .expect("the cohort fixture validates + classifies")
    }

    #[tokio::test]
    async fn executor_drives_risk_only_method_to_recalibrated_predictions() {
        let _g = rootfs::scoped_data_root(test_data_dir("executor-train"));
        let pool = merged_pool().await;
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool, seam.clone());
        let prepared = executor_prepared("ctdna-tf-four-group").await;
        let run_dir = rootfs::data_root();
        let bundles = run_dir.join("bundles").join("ctdna-tf-four-group");
        let outputs = run_dir.join("output").join("ctdna-tf-four-group");
        let models = run_dir.join("models").join("ctdna-tf-four-group");
        std::fs::create_dir_all(&bundles).unwrap();
        std::fs::create_dir_all(&outputs).unwrap();
        std::fs::create_dir_all(&models).unwrap();

        let (ctx, _cancel) = executor_ctx(
            &run_dir,
            "ctdna-tf-four-group",
            prepared.train,
            None,
            None,
            true,
            RunTarget::TrainMethod,
        );
        let outcome = exec
            .execute(ctx)
            .await
            .expect("the executor outcome is an Ok verdict");
        assert_eq!(outcome.state, TxrMethodState::Finished);
        assert!(outcome.reason.is_none());
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(
            outcome.prob_source,
            Some(TxrProbSource::Recalibrated),
            "risk-only method → the conversion band fills the column"
        );
        let cov = outcome.coverage.expect("coverage");
        assert_eq!(
            (cov.scored, cov.eligible),
            (30, 30),
            "every cohort patient is scored + converted"
        );
        assert_eq!(outcome.task, Some(TxrTask::Pfs));
        let model = outcome.model.expect("save_models → produced model");
        assert_eq!(model.trained_on_patients, 30);
        assert_eq!(model.model_out_digest.len(), 64);
        assert!(model.size_bytes > 0, "the /model tree has bytes");
        assert!(model.own_auc.is_some(), "own-data AUC computed from scores");

        // The call sequence: fit (FitOnly) → training scores (ReuseModel over
        // the cohort) → final predict (ReuseModel over the surface).
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(calls.len(), 3, "fit + score + final predict");
        assert_eq!(calls[0].mode, MethodRunMode::FitOnly);
        assert!(calls[0].model_out.is_some());
        assert!(calls[0].mount.is_none());
        assert!(calls[0].has_train, "fit sees the train bundle");
        assert_eq!(calls[1].mode, MethodRunMode::ReuseModel);
        assert!(calls[1].mount.is_some());
        assert_eq!(
            calls[1].scored.len(),
            30,
            "the training-score call scores the cohort"
        );
        assert!(!calls[1].has_train, "a reuse call never sees /input/train");
        assert_eq!(calls[2].mode, MethodRunMode::ReuseModel);
        assert_eq!(calls[2].scored.len(), 30);
        // The params carry the run's contract facts (landmark + horizon).
        for c in calls.iter() {
            assert_eq!(c.params["landmark_day"], 56.0);
            assert_eq!(c.params["horizons"], serde_json::json!([238.0]));
            assert_eq!(c.params["seed"], 1);
        }
        drop(calls);
    }

    #[tokio::test]
    async fn executor_native_method_reports_native_source_without_crossfit() {
        let _g = rootfs::scoped_data_root(test_data_dir("executor-native"));
        let pool = merged_pool().await;
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool, seam.clone());
        let prepared = executor_prepared("jm-lme").await; // declares p_progression_H*
        let run_dir = rootfs::data_root();
        make_method_dirs(&run_dir, "jm-lme");

        let (ctx, _cancel) = executor_ctx(
            &run_dir,
            "jm-lme",
            prepared.train,
            None,
            None,
            false,
            RunTarget::TrainMethod,
        );
        let outcome = exec.execute(ctx).await.expect("verdict");
        assert_eq!(outcome.state, TxrMethodState::Finished);
        assert_eq!(outcome.prob_source, Some(TxrProbSource::Native));
        // The native method still needs death's conversion → the method is
        // fitted → the 3-fold cross-fit runs (engine.cpp's fitted branch); the
        // DISPLAYED column stays native. Fold calls: 3 × (fit + predict).
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(calls.len(), 2 + 2 * predictions::CROSS_FIT_FOLDS);
        assert_eq!(calls[0].mode, MethodRunMode::FitOnly);
        let fold_fits = calls[1..1 + 2 * predictions::CROSS_FIT_FOLDS]
            .iter()
            .filter(|c| c.mode == MethodRunMode::FitOnly)
            .count();
        assert_eq!(fold_fits, predictions::CROSS_FIT_FOLDS);
        drop(calls);
    }

    // ── the bundle preflight against the executor's own bundle stage ──────

    /// The cohort fixture's train side cut to its first `n` patients (sorted
    /// ids) — a canonical subset like a cross-fit fold's.
    fn first_cohort_patients(train: &CanonicalBundle, n: usize) -> CanonicalBundle {
        let mut ids: Vec<&str> = train
            .patients
            .iter()
            .map(|p| p.patient_id.as_str())
            .collect();
        ids.sort_unstable();
        let keep: std::collections::HashSet<&str> = ids.into_iter().take(n).collect();
        subset_canonical(train, &keep)
    }

    /// A fitted catalogue method plus a cohort size where the method's first
    /// bundles build but a cross-fit fold's rest set learns no outcome — a
    /// search over the catalogue and the sizes, so the case does not hang on
    /// one method's facts.
    fn crossfit_refusal_case(
        train: &CanonicalBundle,
        settings: &bundle::BundleSettings,
    ) -> Option<(String, CanonicalBundle)> {
        let cat = crate::modules::method_catalogue::catalogue::catalogue();
        let refused = Err(bundle::BundleError::NoLearnableOutcome {
            min: bundle::MIN_TRAINING_PATIENTS,
        });
        (bundle::MIN_TRAINING_PATIENTS..train.patients.len()).find_map(|n| {
            let cut = first_cohort_patients(train, n);
            cat.methods
                .iter()
                .filter(|m| m.fitted)
                .find(|m| {
                    method_bundles(&cut, None, m, settings, m.min_draws).is_ok()
                        && train_bundle_preflight(&cut, None, m, settings, m.min_draws) == refused
                })
                .map(|m| (m.id.clone(), cut.clone()))
        })
    }

    /// The bundle preflight ([`call_bundle_preflight`], the example pick's
    /// filter) answers what the train executor's bundle stage does: in every
    /// case the preflight's refusal is the method's failure reason (same code,
    /// same detail) and a preflight `Ok` is a call not refused with a
    /// `BUNDLE_*` code. The cases cover each leg on the cohort fixture: the
    /// marker rule, the train bundle (draw minimum, covariates), the test
    /// bundle over a separate predict file (covariates without a predict
    /// patients table, a missing marker) and a cross-fit fold refused after
    /// the main fit call.
    #[tokio::test]
    async fn call_bundle_preflight_matches_the_executor_bundle_stage() {
        use crate::modules::file_validator::types::CanonCell;

        let _g = rootfs::scoped_data_root(test_data_dir("executor-preflight-parity"));
        let pool = merged_pool().await;
        let base = "ctdna-tf-four-group";
        let train = executor_prepared(base)
            .await
            .train
            .expect("the cohort fixture's train side");
        let config = RunConfig {
            decision_day: 56.0,
            look_ahead_day: 238.0,
            save_models: true,
            ..Default::default()
        };
        let settings = method_bundle_settings(&config, detect_cpus());
        let cat = crate::modules::method_catalogue::catalogue::catalogue();

        // A method the cohort's one marker cannot satisfy.
        let marker_refused = cat
            .methods
            .iter()
            .find(|m| {
                bundle::method_marker_set(&train, &m.markers, m.required_markers.as_ref()).is_err()
            })
            .expect("a method whose marker rule the one-marker cohort fails");
        let marker_code = bundle::method_marker_set(
            &train,
            &marker_refused.markers,
            marker_refused.required_markers.as_ref(),
        )
        .expect_err("refused")
        .code();

        let mut with_covariates = (*train).clone();
        for (i, p) in with_covariates.patients.iter_mut().enumerate() {
            p.covariates = vec![("age".to_string(), CanonCell::Number(40.0 + i as f64))];
        }
        let with_covariates = Arc::new(with_covariates);
        let base_facts = envmanifest::facts_for(base).expect("facts");
        let main = bundle::method_marker_set(
            &train,
            &base_facts.markers,
            base_facts.required_markers.as_ref(),
        )
        .expect("the base method's marker set")
        .mains()[0]
            .clone();
        let mut without_marker = (*train).clone();
        without_marker.values.retain(|v| v.feature != main);
        let (crossfit, small) = crossfit_refusal_case(&train, &settings)
            .expect("a fitted method refused only at its cross-fit folds");

        let covariates_on = RunConfig {
            covariates: true,
            ..config.clone()
        };
        struct Case {
            name: &'static str,
            method: String,
            train: Arc<CanonicalBundle>,
            predict: Option<Arc<CanonicalBundle>>,
            config: RunConfig,
            min_draws: Option<u32>,
            expect: Option<&'static str>,
        }
        let case = |name, method: &str, train: &Arc<CanonicalBundle>| Case {
            name,
            method: method.to_string(),
            train: train.clone(),
            predict: None,
            config: config.clone(),
            min_draws: None,
            expect: None,
        };
        let cases = vec![
            case("the base method on the cohort", base, &train),
            Case {
                expect: Some(marker_code),
                ..case("the marker rule", &marker_refused.id, &train)
            },
            Case {
                min_draws: Some(10_000),
                expect: Some("BUNDLE_NO_TRAINING_PATIENT"),
                ..case("the draw minimum", base, &train)
            },
            Case {
                config: covariates_on.clone(),
                expect: Some("BUNDLE_COVARIATES_MISSING"),
                ..case("covariates without a covariate column", base, &train)
            },
            Case {
                config: covariates_on.clone(),
                ..case(
                    "covariates over the cohort as the predict surface",
                    base,
                    &with_covariates,
                )
            },
            Case {
                predict: Some(with_covariates.clone()),
                config: covariates_on.clone(),
                expect: Some("BUNDLE_TEST_COVARIATES_MISSING"),
                ..case(
                    "covariates over a predict file without a patients table",
                    base,
                    &with_covariates,
                )
            },
            Case {
                predict: Some(train.clone()),
                ..case("a predict file", base, &train)
            },
            Case {
                predict: Some(Arc::new(without_marker)),
                expect: Some("BUNDLE_TEST_MARKER_MISSING"),
                ..case("a predict file without the trained marker", base, &train)
            },
            Case {
                expect: Some("BUNDLE_NO_LEARNABLE_OUTCOME"),
                ..case(
                    "a cross-fit fold too small to learn",
                    &crossfit,
                    &Arc::new(small),
                )
            },
        ];

        for (i, case) in cases.into_iter().enumerate() {
            let name = case.name;
            let facts = envmanifest::facts_for(&case.method).expect("a catalogue method");
            let seam = FakeStackRunSeam::new();
            let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
            let run_dir = rootfs::data_root().join(format!("case-{i}"));
            make_method_dirs(&run_dir, &case.method);
            let (mut ctx, _cancel) = executor_ctx(
                &run_dir,
                &case.method,
                Some(case.train),
                case.predict,
                None,
                case.config.save_models,
                RunTarget::TrainMethod,
            );
            ctx.config = case.config;
            ctx.cpus = detect_cpus();
            ctx.min_draws = case.min_draws.unwrap_or(facts.min_draws);
            let preflight = call_bundle_preflight(&ctx, facts);
            let outcome = exec.execute(ctx).await.expect("an executor verdict");
            let reason = outcome.reason.clone();
            match &preflight {
                Ok(()) => assert!(
                    reason
                        .as_ref()
                        .map_or(true, |r| !r.code.starts_with("BUNDLE_")),
                    "{name}: preflight Ok but the executor refused {reason:?}"
                ),
                Err(e) => {
                    assert_eq!(outcome.state, TxrMethodState::Failed, "{name}");
                    let r = reason.expect("a failure reason");
                    assert_eq!(
                        (r.code.as_str(), r.detail.clone()),
                        (e.code(), e.to_string()),
                        "{name}"
                    );
                }
            }
            assert_eq!(
                preflight.as_ref().err().map(|e| e.code()),
                case.expect,
                "{name}: the case reaches the leg it names"
            );
            let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
            if name == "a cross-fit fold too small to learn" {
                // The fold bundles are built between calls, as before: the
                // main fit ran, then the first fold's bundle was refused.
                assert_eq!(calls.len(), 1, "{name}: only the main fit ran");
                assert_eq!(calls[0].mode, MethodRunMode::FitOnly, "{name}");
            } else if preflight.is_err() {
                assert!(calls.is_empty(), "{name}: refused before any call");
            }
        }
    }

    // ── reuse: the data-carrying conversion builds a train call's bundles ──

    /// A Files-mode reuse request over the cohort (the run's own patients
    /// table + a predict file): the reuse call scores the predict file, and
    /// the conversion is re-fitted from the model's scores over the cohort.
    fn cohort_reuse_request(asset_dir: &Path, digest: &str, method_id: &str) -> CreateRunRequest {
        CreateRunRequest {
            mode: TxrRunMode::Reuse,
            input: TxrRunInput {
                patients: Some(cohort_patients_table()),
                measurements: cohort_measurements_table(),
                predict_measurements: Some(cohort_measurements_table()),
                joins: Vec::new(),
                mapping: Vec::new(),
                keep_copies: false,
            },
            config: RunConfig {
                at_a_time: 2,
                decision_day: 56.0,
                look_ahead_day: 238.0,
                ..Default::default()
            },
            method_ids: Vec::new(),
            model_ids: vec![crate::modules::execution_engine::types::TxrModelAsset {
                model_id: "m-1".to_string(),
                host_dir: asset_dir.display().to_string(),
                tree_sha256: digest.to_string(),
                method_id: method_id.to_string(),
                method_version: "2.0.0".to_string(),
                env: TxrMethodEnv {
                    base_digest: "c".repeat(64),
                    layer_digest: "d".repeat(64),
                },
                contract: "2.0".to_string(),
            }],
        }
    }

    /// A model asset tree under `run_dir` + its digest.
    fn fixture_asset(run_dir: &Path) -> (PathBuf, String) {
        let asset_dir = run_dir.join("asset-model");
        std::fs::create_dir_all(&asset_dir).unwrap();
        std::fs::write(asset_dir.join("model.rds"), "fixture-model").unwrap();
        let digest = crate::modules::sandbox::stack::tree_sha256(&asset_dir).unwrap();
        (asset_dir, digest)
    }

    /// The data-carrying reuse conversion builds the cohort's bundles with
    /// [`method_bundles`] (marker set → train bundle → test bundle over the
    /// cohort itself, no predict file): its cohort call receives exactly that
    /// train bundle's params and that test bundle's scored rows, and the
    /// conversion is re-fitted (Recalibrated).
    #[tokio::test]
    async fn executor_reuse_with_cohort_converts_over_the_train_call_bundles() {
        let _g = rootfs::scoped_data_root(test_data_dir("executor-reuse-cohort"));
        let pool = merged_pool().await;
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool, seam.clone());
        let run_dir = rootfs::data_root();
        let (asset_dir, digest) = fixture_asset(&run_dir);
        make_method_dirs(&run_dir, "m-1");
        let method = "ctdna-tf-four-group";
        let req = cohort_reuse_request(&asset_dir, &digest, method);
        let prepared = prepare_run(
            &req.input,
            &req.config,
            TxrRunMode::Reuse,
            &req.method_ids,
            &req.model_ids,
        )
        .expect("the reuse fixture validates");
        let train = prepared
            .train
            .clone()
            .expect("a Files-mode reuse carries the cohort");
        let (mut ctx, _cancel) = executor_ctx(
            &run_dir,
            "m-1",
            prepared.train,
            prepared.predict,
            prepared.predict_patients,
            false,
            RunTarget::ReuseModel {
                asset: req.model_ids[0].clone(),
            },
        );
        ctx.config = req.config.clone();
        let facts = envmanifest::facts_for(method).expect("facts");
        let expected = method_bundles(
            &train,
            None,
            facts,
            &method_bundle_settings(&ctx.config, ctx.cpus),
            ctx.min_draws,
        )
        .expect("the cohort's train call bundles build");

        let outcome = exec.execute(ctx).await.expect("verdict");
        assert_eq!(
            outcome.state,
            TxrMethodState::Finished,
            "{:?}",
            outcome.reason
        );
        assert_eq!(
            outcome.prob_source,
            Some(TxrProbSource::Recalibrated),
            "a risk-only reuse with the cohort re-fits the conversion"
        );
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(calls.len(), 2, "the predict-surface call + the cohort call");
        assert!(calls.iter().all(|c| c.mode == MethodRunMode::ReuseModel));
        assert_eq!(
            calls[1].scored, expected.test.scored,
            "the cohort test bundle"
        );
        assert_eq!(
            calls[1].params, expected.train.params,
            "the cohort train bundle"
        );
        drop(calls);
    }

    /// A refusal while building the reuse conversion's cohort bundles is
    /// [`method_bundles`]' refusal, code and detail. The case: a cohort with
    /// two markers and a predict file with one, for a single-marker method
    /// with no native probability — the predict side's marker set builds, so
    /// the reuse call runs, then the cohort's marker set is refused.
    #[tokio::test]
    async fn executor_reuse_cohort_refusal_is_the_train_call_bundle_refusal() {
        use crate::modules::file_validator::types::{CanonicalFeature, CanonicalValue};
        use crate::modules::method_catalogue::types::MarkerKind;

        let _g = rootfs::scoped_data_root(test_data_dir("executor-reuse-cohort-refusal"));
        let pool = merged_pool().await;
        let run_dir = rootfs::data_root();
        let (asset_dir, digest) = fixture_asset(&run_dir);
        make_method_dirs(&run_dir, "m-1");
        let cat = crate::modules::method_catalogue::catalogue::catalogue();
        let method = cat
            .methods
            .iter()
            .find(|m| {
                let spec = run_task(m, super::super::types::TxrEndpoint::Pfs, 238.0);
                m.markers.kind == MarkerKind::Single
                    && m.required_markers.is_none()
                    && m.saves_model
                    && !predictions::own_probability(&m.own_outputs, spec.outcome, spec.horizon)
            })
            .expect("a single-marker method without a native probability");
        let req = cohort_reuse_request(&asset_dir, &digest, &method.id);
        let prepared = prepare_run(
            &req.input,
            &req.config,
            TxrRunMode::Reuse,
            &req.method_ids,
            &req.model_ids,
        )
        .expect("the reuse fixture validates");

        // The cohort gains a second marker; the predict file keeps one.
        let mut two_markers = (*prepared.train.clone().expect("the cohort")).clone();
        let second: Vec<CanonicalValue> = two_markers
            .values
            .iter()
            .map(|v| CanonicalValue {
                feature: "M2".to_string(),
                ..v.clone()
            })
            .collect();
        two_markers.values.extend(second);
        two_markers.features.push(CanonicalFeature {
            feature: "M2".to_string(),
            unit: None,
            marker_id: None,
            is_detection_companion: false,
        });
        let two_markers = Arc::new(two_markers);

        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool, seam.clone());
        let (mut ctx, _cancel) = executor_ctx(
            &run_dir,
            "m-1",
            Some(two_markers.clone()),
            prepared.predict,
            prepared.predict_patients,
            false,
            RunTarget::ReuseModel {
                asset: req.model_ids[0].clone(),
            },
        );
        ctx.config = req.config.clone();
        let refusal = method_bundles(
            &two_markers,
            None,
            method,
            &method_bundle_settings(&ctx.config, ctx.cpus),
            ctx.min_draws,
        )
        .err()
        .expect("the two-marker cohort refuses a single-marker method");
        assert_eq!(refusal.code(), "BUNDLE_MARKER_COUNT_UNMET");

        let outcome = exec.execute(ctx).await.expect("verdict");
        assert_eq!(outcome.state, TxrMethodState::Failed);
        let reason = outcome.reason.expect("a failure reason");
        assert_eq!(
            (reason.code.as_str(), reason.detail),
            (refusal.code(), refusal.to_string())
        );
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            calls.len(),
            1,
            "the reuse call ran before the cohort refusal"
        );
        assert_eq!(calls[0].mode, MethodRunMode::ReuseModel);
        drop(calls);
    }

    #[tokio::test]
    async fn executor_reuse_predict_only_reports_prob_source_none() {
        let _g = rootfs::scoped_data_root(test_data_dir("executor-reuse"));
        let pool = merged_pool().await;
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool, seam.clone());
        // The asset: a /model tree the fixture writes + digests (the verify-
        // before-bind digest of the request).
        let run_dir = rootfs::data_root();
        let asset_dir = run_dir.join("asset-model");
        std::fs::create_dir_all(&asset_dir).unwrap();
        std::fs::write(asset_dir.join("model.rds"), "fixture-model").unwrap();
        let digest = crate::modules::sandbox::stack::tree_sha256(&asset_dir).unwrap();
        make_method_dirs(&run_dir, "m-1");
        let req = CreateRunRequest {
            mode: TxrRunMode::Reuse,
            input: TxrRunInput {
                patients: None,
                measurements: cohort_measurements_table(),
                predict_measurements: Some(cohort_measurements_table()),
                joins: Vec::new(),
                mapping: Vec::new(),
                keep_copies: false,
            },
            config: RunConfig {
                at_a_time: 2,
                decision_day: 56.0,
                look_ahead_day: 238.0,
                ..Default::default()
            },
            method_ids: Vec::new(),
            model_ids: vec![crate::modules::execution_engine::types::TxrModelAsset {
                model_id: "m-1".to_string(),
                host_dir: asset_dir.display().to_string(),
                tree_sha256: digest.clone(),
                method_id: "ctdna-tf-four-group".to_string(),
                method_version: "2.0.0".to_string(),
                env: TxrMethodEnv {
                    base_digest: "c".repeat(64),
                    layer_digest: "d".repeat(64),
                },
                contract: "2.0".to_string(),
            }],
        };
        let prepared = prepare_run(
            &req.input,
            &req.config,
            TxrRunMode::Reuse,
            &req.method_ids,
            &req.model_ids,
        )
        .expect("the reuse fixture validates");
        let (ctx, _cancel) = executor_ctx(
            &run_dir,
            "m-1",
            prepared.train,
            prepared.predict,
            prepared.predict_patients,
            false,
            RunTarget::ReuseModel {
                asset: req.model_ids[0].clone(),
            },
        );
        let outcome = exec.execute(ctx).await.expect("verdict");
        assert_eq!(outcome.state, TxrMethodState::Finished);
        assert_eq!(
            outcome.prob_source,
            Some(TxrProbSource::None),
            "predict-only reuse of a risk-only method has no conversion source"
        );
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(calls.len(), 1, "one reuse call");
        assert_eq!(calls[0].mode, MethodRunMode::ReuseModel);
        assert_eq!(
            calls[0].mount.as_ref().map(|(_, d)| d.as_str()),
            Some(digest.as_str())
        );
        drop(calls);
    }

    #[tokio::test]
    async fn executor_timeout_and_exit_failures_are_typed() {
        let _g = rootfs::scoped_data_root(test_data_dir("executor-timeout"));
        let pool = merged_pool().await;

        // The timeout arm: JOB_TIMEOUT, BEFORE any output is read.
        let seam = FakeStackRunSeam::new();
        *seam.fail.lock().unwrap_or_else(|e| e.into_inner()) = Some((0, true));
        let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
        let prepared = executor_prepared("ctdna-tf-four-group").await;
        let run_dir = rootfs::data_root();
        make_method_dirs(&run_dir, "ctdna-tf-four-group");
        let (ctx, _cancel) = executor_ctx(
            &run_dir,
            "ctdna-tf-four-group",
            prepared.train,
            None,
            None,
            true,
            RunTarget::TrainMethod,
        );
        let outcome = exec.execute(ctx).await.expect("verdict");
        assert_eq!(outcome.state, TxrMethodState::Failed);
        assert_eq!(
            outcome.reason.as_ref().map(|r| r.code.as_str()),
            Some("JOB_TIMEOUT")
        );
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(calls.len(), 1, "the fit call times out — nothing after");
        drop(calls);

        // The non-zero exit arm: PREDICTION_INVALID + the stderr tail.
        let seam2 = FakeStackRunSeam::new();
        *seam2.fail.lock().unwrap_or_else(|e| e.into_inner()) = Some((3, false));
        let exec2 = StackMethodExecutor::with_seam(pool, seam2);
        let prepared2 = executor_prepared("ctdna-tf-four-group").await;
        let run_dir2 = rootfs::data_root();
        make_method_dirs(&run_dir2, "ctdna-tf-four-group");
        let (ctx2, _cancel2) = executor_ctx(
            &run_dir2,
            "ctdna-tf-four-group",
            prepared2.train,
            None,
            None,
            true,
            RunTarget::TrainMethod,
        );
        let outcome2 = exec2.execute(ctx2).await.expect("verdict");
        assert_eq!(outcome2.state, TxrMethodState::Failed);
        let reason = outcome2.reason.expect("reason");
        assert_eq!(reason.code, "PREDICTION_INVALID");
        assert!(reason.detail.contains("exit code 3"), "{}", reason.detail);
        assert!(
            reason.detail.contains("fixture boom"),
            "stderr tail in the detail"
        );
    }

    #[tokio::test]
    async fn executor_bundle_refusal_is_typed_before_any_call() {
        let _g = rootfs::scoped_data_root(test_data_dir("executor-refusal"));
        let pool = merged_pool().await;
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool, seam.clone());
        // A marker-count mismatch: a single-marker method over the two-marker
        // cohort (the fixture's one LOINC + the method's single rule expects
        // exactly one) → BUNDLE_MARKER_COUNT_UNMET before any sandbox call.
        let prepared = executor_prepared("landmark-cox-current").await;
        let run_dir = rootfs::data_root();
        make_method_dirs(&run_dir, "landmark-cox-current");

        // Force the mismatch: the cohort carries ONE main marker, so pick a
        // method whose selection rule cannot be met — the fixture's marker is
        // a single LOINC id, and `marker kind single` + a required list it
        // does not match still yields the count refusal.
        let (ctx, _cancel) = executor_ctx(
            &run_dir,
            "ca125-auc-cutoff",
            prepared.train,
            None,
            None,
            false,
            RunTarget::TrainMethod,
        );
        let outcome = exec.execute(ctx).await.expect("verdict");
        assert_eq!(outcome.state, TxrMethodState::Failed);
        assert_eq!(
            outcome.reason.as_ref().map(|r| r.code.as_str()),
            Some("BUNDLE_MARKER_COUNT_UNMET")
        );
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            calls.is_empty(),
            "a bundle refusal never reaches the sandbox"
        );
        drop(calls);
    }

    #[tokio::test]
    async fn run_input_record_round_trips_and_rerun_clones_it() {
        let _g = rootfs::scoped_data_root(test_data_dir("rerun"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let executor = Arc::new(FakeExecutor::new(Duration::ZERO));
        let req = cohort_run_request(&["ctdna-tf-four-group"], 2, false);
        let first = start_run(
            pool.clone(),
            runtime.clone(),
            env.clone(),
            executor.clone(),
            owner(),
            req.clone(),
        )
        .await
        .expect("create");
        let repo = TxrRepository::new(pool.clone());
        let _ = wait_terminal(&repo, first.id).await;

        // The record file exists + round-trips the request (the validator
        // accepted the SAME tables — the clone never re-parses CSVs).
        let record_path = Path::new(&first.dir).join("input").join("run-input.json");
        let bytes = std::fs::read(&record_path).expect("run-input.json written");
        let record: types::RunInputRecord = serde_json::from_slice(&bytes).expect("record parses");
        assert_eq!(record.mode, TxrRunMode::Train);
        assert_eq!(record.method_ids, vec!["ctdna-tf-four-group".to_string()]);
        assert!(record.rerun_of.is_none());
        assert_eq!(record.config.decision_day, 56.0);
        assert_eq!(
            record.input.patients.as_ref().map(|p| p.rows.len()),
            Some(30)
        );

        // rerun_run: a NEW run whose record carries the source link.
        let second = rerun_run(pool.clone(), runtime, env, executor, owner(), first.id)
            .await
            .expect("rerun");
        assert_ne!(second.id, first.id);
        let second_record: types::RunInputRecord = serde_json::from_slice(
            &std::fs::read(Path::new(&second.dir).join("input").join("run-input.json"))
                .expect("second record"),
        )
        .expect("parses");
        assert_eq!(second_record.rerun_of, Some(first.id));
        assert_eq!(second_record.method_ids, req.method_ids);

        // prune: not-found is fine; a real dir goes away.
        prune_run_dir(Path::new("/no/such/run-dir")).expect("missing dir is success");
        let _ = wait_terminal(&repo, second.id).await;
        prune_run_dir(Path::new(&second.dir)).expect("prune removes the tree");
        assert!(!Path::new(&second.dir).exists());
        prune_run_dir(Path::new(&second.dir)).expect("idempotent");
    }

    #[tokio::test]
    async fn estimate_facts_are_stored_on_the_run_row() {
        let _g = rootfs::scoped_data_root(test_data_dir("estimate"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let executor = Arc::new(FakeExecutor::new(Duration::ZERO));
        let req = cohort_run_request(&["ctdna-tf-four-group"], 2, false);
        let summary = start_run(pool.clone(), runtime, env, executor, owner(), req)
            .await
            .expect("create");
        let repo = TxrRepository::new(pool.clone());
        let row = repo.get_run(summary.id).await.expect("get").expect("row");
        let estimate = row.estimate().expect("estimate parses").expect("stored");
        assert!(
            estimate.total_seconds > 0.0,
            "the FIFO of the catalogue estimate"
        );
        assert!(estimate.schedule_seconds > 0.0);
        let _ = wait_terminal(&repo, summary.id).await;
    }

    #[tokio::test]
    async fn drive_uses_the_real_executor_with_the_sink_drainer() {
        let _g = rootfs::scoped_data_root(test_data_dir("drive-executor"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(10)));
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
        let req = cohort_run_request(&["ctdna-tf-four-group"], 2, true);
        let summary = start_run(
            pool.clone(),
            runtime.clone(),
            env,
            Arc::new(exec),
            owner(),
            req,
        )
        .await
        .expect("create");
        let repo = TxrRepository::new(pool.clone());
        let row = wait_terminal(&repo, summary.id).await;
        assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);

        let methods = repo.methods_for_run(summary.id).await.expect("methods");
        assert_eq!(methods.len(), 1);
        let m = &methods[0];
        assert_eq!(m.state, "finished", "{}", m.method_id);
        assert_eq!(m.prob_source.as_deref(), Some("recalibrated"));
        assert_eq!(m.coverage_scored, Some(30));
        assert!(m.model_out_digest.as_deref().is_some_and(|d| d.len() == 64));
        assert_eq!(m.trained_on_patients, Some(30));
        assert!(m.exit_code == Some(0), "{m:?}");

        // The drainer moved the seam's log line + milestone into the log rows
        // and the phase patch (the frames the sink carried to the drive).
        let (logs, _, _) = repo
            .logs_page(summary.id, Some("ctdna-tf-four-group"), 0, 100)
            .await
            .expect("logs");
        assert!(
            logs.iter()
                .any(|l| l.stream == "stdout" && l.content.contains("fixture says hi")),
            "the sandbox log line landed in txr_run_logs"
        );
        let m2 = repo
            .get_method(summary.id, &m.method_id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(
            m2.phase.as_deref(),
            Some("predict"),
            "the milestone patched the phase"
        );
    }

    #[tokio::test]
    async fn crossfit_fod_model_dirs_never_overwrite_the_produced_tree() {
        let _g = rootfs::scoped_data_root(test_data_dir("executor-crossfit-dirs"));
        let pool = merged_pool().await;
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool, seam.clone());
        let prepared = executor_prepared("cox-cutpoint-risk").await;
        let run_dir = rootfs::data_root();
        let (_, outputs, models) = make_method_dirs(&run_dir, "cox-cutpoint-risk");
        let (ctx, _cancel) = executor_ctx(
            &run_dir,
            "cox-cutpoint-risk",
            prepared.train,
            None,
            None,
            false,
            RunTarget::TrainMethod,
        );
        let outcome = exec.execute(ctx).await.expect("verdict");
        assert_eq!(outcome.state, TxrMethodState::Finished);
        assert!(
            models.join("model.rds").exists(),
            "the MAIN fit's tree stays"
        );
        for k in 0..predictions::CROSS_FIT_FOLDS {
            let fold_dir = outputs.join(".crossfit").join(k.to_string());
            assert!(
                fold_dir.join("model.rds").exists(),
                "fold {k} has its own tree"
            );
        }
        let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            calls.len() >= 3 * 2,
            "fit + 3×(fit + predict) for a fitted method"
        );
        drop(calls);
    }

    // ── ITEM-10: the control surface (PROV-EE-6) + the 409 guards ──────────

    /// A run row + method rows inserted DIRECTLY (no drive registered — the
    /// DB-fallback path's precondition).
    async fn seed_live_run(
        pool: &SqlitePool,
        states: &[(&str, TxrMethodState)],
        status: TxrRunStatus,
    ) -> uuid::Uuid {
        let repo = TxrRepository::new(pool.clone());
        let id = uuid::Uuid::new_v4();
        let dir = run_dir_root().join(run_dir_name(Utc::now(), id));
        repo.insert_run(&NewRun {
            id,
            created_at: None,
            status,
            mode: TxrRunMode::Train,
            config: RunConfig::default(),
            input_summary: TxrRunInputSummary {
                patients: Some(4),
                predict_patients: None,
                markers: 2,
                events: Some(1),
                file_names: TxrRunFileNames {
                    patients: Some("patients.csv".to_string()),
                    measurements: "measurements.csv".to_string(),
                    predict_measurements: None,
                },
            },
            model_ids: Vec::new(),
            method_count: states.len() as u32,
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
            memory_total_bytes: None,
            cpus: Some(4),
            seed: 1,
            estimate: None,
        })
        .await
        .expect("run inserts");
        for (mid, state) in states {
            repo.insert_method(&NewMethod {
                id: uuid::Uuid::new_v4(),
                run_id: id,
                method_id: mid.to_string(),
                label: mid.to_string(),
                version: "2.0.1".to_string(),
                group: "dynamic_risk".to_string(),
                state: *state,
                bytes_total: Some(0),
            })
            .await
            .expect("method inserts");
        }
        id
    }

    #[tokio::test]
    async fn create_and_rerun_are_refused_while_an_active_run_exists() {
        let _g = rootfs::scoped_data_root(test_data_dir("active-409"));
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let env = Arc::new(FakeEnv::new(Duration::from_millis(50)));
        let executor = Arc::new(FakeExecutor::new(Duration::from_millis(50)));
        let req = cohort_run_request(&["ctdna-tf-four-group"], 2, false);
        let first = start_run(
            pool.clone(),
            runtime.clone(),
            env.clone(),
            executor.clone(),
            owner(),
            req.clone(),
        )
        .await
        .expect("create");

        let second = start_run(
            pool.clone(),
            runtime.clone(),
            env.clone(),
            executor.clone(),
            owner(),
            req,
        )
        .await;
        let err = second.expect_err("a second create while one is active");
        assert_eq!(err.error_code(), "RUN_ALREADY_ACTIVE");
        assert_eq!(err.status_code(), 409);

        // The rerun path inherits the guard (rerunning a STILL-ACTIVE run
        // would spawn a second fleet).
        let rerun = rerun_run(
            pool.clone(),
            runtime.clone(),
            env.clone(),
            executor.clone(),
            owner(),
            first.id,
        )
        .await;
        let err = rerun.expect_err("rerun of an active run");
        assert_eq!(err.error_code(), "RUN_ALREADY_ACTIVE");

        // After the run turns terminal the same rerun succeeds.
        let repo = TxrRepository::new(pool.clone());
        let _ = wait_terminal(&repo, first.id).await;
        let rerun = rerun_run(pool, runtime, env, executor, owner(), first.id)
            .await
            .expect("rerun of a terminal run");
        let _ = wait_terminal(&repo, rerun.id).await;
    }

    #[tokio::test]
    async fn stop_all_db_path_marks_methods_and_finalizes_stopped() {
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let run_id = seed_live_run(
            &pool,
            &[
                ("m-running", TxrMethodState::Running),
                ("m-waiting", TxrMethodState::Waiting),
                ("m-downloading", TxrMethodState::Downloading),
            ],
            TxrRunStatus::Running,
        )
        .await;

        stop_run(pool.clone(), runtime.clone(), run_id)
            .await
            .expect("stop all");

        let repo = TxrRepository::new(pool.clone());
        let row = repo.get_run(run_id).await.expect("get").expect("row");
        assert_eq!(row.status().expect("parses"), TxrRunStatus::Stopped);
        let methods = repo.methods_for_run(run_id).await.expect("methods");
        let by_id: std::collections::HashMap<_, _> = methods
            .into_iter()
            .map(|m| (m.method_id.clone(), m))
            .collect();
        assert_eq!(by_id["m-running"].state, "stopped");
        assert_eq!(
            by_id["m-running"].reason_code.as_deref(),
            Some("ABORTED"),
            "running → stopped + ABORTED (PROV-EE-6)"
        );
        assert_eq!(by_id["m-waiting"].state, "skipped");
        assert_eq!(by_id["m-downloading"].state, "skipped");
        let (logs, _, _) = repo.logs_page(run_id, None, 0, 10).await.expect("logs");
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].content, "stopped by the user");

        // Idempotent stop of the stopped run.
        stop_run(pool.clone(), runtime.clone(), run_id)
            .await
            .expect("stop again is a no-op success");
        // Stop of a FINISHED run is 409 RUN_NOT_ACTIVE.
        repo.finish_run(
            run_id,
            TxrRunStatus::Finished,
            1,
            &repo.method_counts(run_id).await.expect("counts"),
            false,
            None,
        )
        .await
        .expect("finish");
        let err = stop_run(pool, runtime, run_id).await.expect_err("terminal stop");
        assert_eq!(err.error_code(), "RUN_NOT_ACTIVE");
        assert_eq!(err.status_code(), 409);
    }

    #[tokio::test]
    async fn stop_skip_method_db_paths_and_their_refusals() {
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let run_id = seed_live_run(
            &pool,
            &[
                ("m-running", TxrMethodState::Running),
                ("m-waiting", TxrMethodState::Waiting),
                ("m-done", TxrMethodState::Finished),
            ],
            TxrRunStatus::Running,
        )
        .await;
        let repo = TxrRepository::new(pool.clone());

        // Skip of a waiting method → skipped; skip of a RUNNING method is
        // refused (it must be stopped first).
        skip_method(pool.clone(), run_id, "m-waiting")
            .await
            .expect("skip waiting");
        let m = repo
            .get_method(run_id, "m-waiting")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(m.state, "skipped");
        let err = skip_method(pool.clone(), run_id, "m-running")
            .await
            .expect_err("skip running");
        assert_eq!(err.error_code(), "METHOD_NOT_SKIPPABLE");
        assert_eq!(err.status_code(), 409);
        let err = skip_method(pool.clone(), run_id, "m-done")
            .await
            .expect_err("skip finished");
        assert_eq!(err.error_code(), "METHOD_NOT_SKIPPABLE");

        // Stop of the running method → stopped + ABORTED; stop of a finished
        // method is refused.
        stop_method(pool.clone(), run_id, "m-running")
            .await
            .expect("stop running");
        let m = repo
            .get_method(run_id, "m-running")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(m.state, "stopped");
        assert_eq!(m.reason_code.as_deref(), Some("ABORTED"));
        let err = stop_method(pool.clone(), run_id, "m-done")
            .await
            .expect_err("stop finished");
        assert_eq!(err.error_code(), "METHOD_NOT_ACTIVE");

        // Unknown method / run answers 404.
        let err = stop_method(pool.clone(), run_id, "nope")
            .await
            .expect_err("unknown method");
        assert_eq!(err.error_code(), "METHOD_NOT_FOUND");
        assert_eq!(err.status_code(), 404);
        let err = skip_method(pool.clone(), uuid::Uuid::new_v4(), "m-running")
            .await
            .expect_err("unknown run");
        assert_eq!(err.error_code(), "RUN_NOT_FOUND");
    }

    #[tokio::test]
    async fn at_a_time_is_gated_and_updates_the_persisted_config() {
        let pool = merged_pool().await;
        let runtime = Arc::new(RunRuntime::new());
        let run_id = seed_live_run(&pool, &[("m-waiting", TxrMethodState::Waiting)], TxrRunStatus::Running)
            .await;

        let err = set_at_a_time_run(pool.clone(), run_id, 0)
            .await
            .expect_err("below the floor");
        assert_eq!(err.error_code(), "INVALID_AT_A_TIME");
        assert_eq!(err.status_code(), 400);

        let summary = set_at_a_time_run(pool.clone(), run_id, 5)
            .await
            .expect("lane change");
        assert_eq!(summary.config.at_a_time, 5);
        let m = TxrRepository::new(pool.clone())
            .get_run(run_id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(
            TxrRepository::new(pool.clone())
                .get_run_summary(run_id)
                .await
                .expect("summary")
                .expect("row")
                .config
                .at_a_time,
            5,
            "the persisted config serves the change"
        );

        // A terminal run is 409 RUN_NOT_ACTIVE.
        TxrRepository::new(pool.clone())
            .finish_run(
                run_id,
                TxrRunStatus::Finished,
                1,
                &TxrRepository::new(pool.clone())
                    .method_counts(run_id)
                    .await
                    .expect("counts"),
                false,
                None,
            )
            .await
            .expect("finish");
        let err = set_at_a_time_run(pool, run_id, 3)
            .await
            .expect_err("terminal lane change");
        assert_eq!(err.error_code(), "RUN_NOT_ACTIVE");
    }
}
