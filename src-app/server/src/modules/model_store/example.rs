//! The example saved set (qa-fixes3 ITEM-3) — `POST /api/txr/models/example`.
//!
//! The saved-model path of the flow ("Use a model I saved") needs an example
//! model set WITHOUT the user training anything first. This module creates
//! and remembers it:
//!
//! 1. The METHODS are chosen deterministically from the real catalogue
//!    ([`pick_fast_methods`]): the host-arch methods with a published
//!    environment (`runtime_env_available`), `saves_model`, a `CanRun`
//!    verdict on the example training data's own inventory, every bundle
//!    the run's train call builds built without a refusal
//!    ([`orchestrator::train_bundle_preflight`] — the engine's own marker
//!    set, train/test bundles and cross-fit bundles; the example carries
//!    three main markers, so e.g. a `single` method without a fixed marker
//!    list would be refused `BUNDLE_MARKER_COUNT_UNMET` before it starts),
//!    and a catalogue estimate under 30 s (the plan's "3 that run in under
//!    30 s each"); fastest-first, id tie-break, capped at 3. The pick judges
//!    the data the run trains on: [`example_run_inputs`] canonicalizes
//!    [`example_run_request`]'s own tables and config through
//!    [`orchestrator::canonicalize_run`] (the run's `prepare_run` pass). It
//!    is a function of the embedded catalogue + the embedded example + the
//!    host's published env set only — no calibration, no host-CPU
//!    dependence — and is computed once per process ([`example_methods`]).
//! 2. The RUN is a real run through the engine's normal path
//!    ([`orchestrator::start_run`], seam-injected so the test harness can
//!    script the env/executor) over the embedded example training tables —
//!    a real fit, real predictions, real produced `/model` trees (DEC-2:
//!    never a hand-made fixture).
//! 3. When the run finishes, the normal save-models path
//!    ([`store::save_from_run`]) records the produced models into a real
//!    set named [`EXAMPLE_SET_NAME`] — "Example models".
//! 4. The single-row [`txr_example_set`] state (one row, id = 1) remembers
//!    the creating run / ready set / failure reason, so a second call
//!    returns the existing set, a call while training reports the run's
//!    job state, and deleting the set + calling again recreates it.
//!
//! ### Boundaries
//!
//! - No model training of its own: the run engine does (the boundary of this
//!   module, PROV-MS-1); everything here is orchestration + persistence.
//! - No network I/O at create time: the example data is the embedded bytes;
//!   the methods' environment downloads happen inside the run (the one
//!   allowed network use), and a download that cannot complete is the run's
//!   typed failure, surfaced honestly in the `failed` state.
//! - No auto-retry loop: a failed run leaves `failed` with the reason; the
//!   next call retries (the UI's "Try again" policy), never a background
//!   requeue.
//!
//! ### Determinism
//!
//! The example family is byte-identical on every call (the generator commits
//! seeded bytes; the assets are `include_bytes!`), the method pick is a
//! function of those bytes and the host's published env set, and the run's
//! seed is the engine's single fixed
//! contract seed — so a recreated set trains the same methods on the same
//! data. What differs per machine is only the environment contents the run
//! downloads (the digest-pinned published layers).

use std::sync::Arc;

use axum::http::StatusCode;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::AppError;

use crate::modules::execution_engine::bundle::{BundleError, BundleSettings};
use crate::modules::execution_engine::orchestrator::{
    self, detect_cpus, EnvProvider, MethodExecutor,
};
use crate::modules::execution_engine::runtime::RunRuntime;
use crate::modules::execution_engine::types::{
    CreateRunRequest, RunConfig, TxrRunInput, TxrRunMode, TxrRunStatus,
};
use crate::modules::file_validator::assets;
use crate::modules::file_validator::types::{
    CanonicalBundle, ParsedTable, ParsedTableSource, ProblemSeverity, TableFormat,
    ValidationResponse,
};
use crate::modules::method_catalogue::catalogue::catalogue;
use crate::modules::method_catalogue::eligibility::{
    eligibility_for, estimate_seconds_for, runtime_env_available, REFERENCE_CPUS,
};
use crate::modules::method_catalogue::types::{
    Catalogue, EligibilityRequest, EligibilityStatus, Method,
};
use crate::modules::model_store::repository::{ExampleStateRow, ModelStoreRepository};
use crate::modules::model_store::types::{ExampleSetResponse, ExampleSetState};

/// The reserved set name of the example saved models (the plan's "named
/// 'Example models'"; case-insensitively unique like any set name).
pub const EXAMPLE_SET_NAME: &str = "Example models";

/// The plan's method pick: at most 3 methods.
pub const EXAMPLE_METHOD_CAP: usize = 3;

/// The plan's fast budget: run in under 30 s each (the catalogue estimate —
/// `base_seconds_per_fold` scaled by the example's patient count at the
/// reference CPU count).
pub const EXAMPLE_METHOD_SECONDS_MAX: f64 = 30.0;

/// The example run's own lane count: the example trains in the background
/// while the user may be running their own analysis; one lane never crowds
/// the user's run (the engine still bumps the global cap if needed).
pub const EXAMPLE_AT_A_TIME: u32 = 1;

/// The source names carried into the example run's input summary (the set's
/// "trained on …" label is engine truth: the run's recorded names).
pub const EXAMPLE_PATIENTS_NAME: &str = "example-patients.csv";
pub const EXAMPLE_MEASUREMENTS_NAME: &str = "example-measurements.csv";

/// The engine seams the example run is driven with (the same trait objects
/// the run routes hold — PROV-EE-2's seam; the module wiring installs the
/// real ones, the test harness scripts them).
#[derive(Clone)]
pub struct ExampleRunSeams {
    pub runtime: Arc<RunRuntime>,
    pub env: Arc<dyn EnvProvider>,
    pub executor: Arc<dyn MethodExecutor>,
}

/// The example run's inputs exactly as the run sees them: the validation
/// and canonical sides [`orchestrator::canonicalize_run`] (the run's own
/// `prepare_run` pass) builds from [`example_run_request`]'s tables and
/// config — ONE builder, so the pick judges the data the run trains on.
pub struct ExampleRunInputs {
    pub validation: ValidationResponse,
    pub train: Arc<CanonicalBundle>,
    pub predict: Option<Arc<CanonicalBundle>>,
    pub config: RunConfig,
    /// The bundle settings the run's method calls build with
    /// ([`orchestrator::method_bundle_settings`] over the run config and the
    /// CPU count the run detects at start) — computed once with the inputs,
    /// so a pick derives them once, not per candidate.
    pub(crate) settings: BundleSettings,
}

impl ExampleRunInputs {
    /// The example's training patient count for the estimate: the train
    /// side's distinct canonical patients — the count the run's own estimate
    /// uses (`compute_estimate`), never the patients table's row count.
    pub fn patients(&self) -> u32 {
        self.train.patients.len() as u32
    }

    /// The pick's bundle filter for one method: every bundle the run's train
    /// call builds for it on these inputs ([`orchestrator::train_bundle_preflight`]
    /// — marker set, train/test, cross-fit), with the run's settings and the
    /// method's `min_draws`. `Ok` means the run never refuses the method with
    /// a `BUNDLE_*` code.
    pub fn preflight(&self, method: &Method) -> Result<(), BundleError> {
        orchestrator::train_bundle_preflight(
            &self.train,
            self.predict.as_deref(),
            method,
            &self.settings,
            method.min_draws,
        )
    }
}

fn validation_failed(message: impl Into<String>) -> AppError {
    AppError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "EXAMPLE_VALIDATION_FAILED",
        message.into(),
    )
}

/// The ONE validation verdict the endpoint pins on the example: zero errors
/// and at most the normal A04 notes (asserted here and in the material test
/// — a generator change that breaks the example fails before any endpoint
/// serves it).
fn error_free(validated: ValidationResponse) -> Result<ValidationResponse, AppError> {
    let errors: Vec<_> = validated
        .problems
        .iter()
        .filter(|p| p.severity == ProblemSeverity::Error)
        .collect();
    if !errors.is_empty() {
        return Err(validation_failed(format!(
            "the embedded example data carries {} error(s): {:?}",
            errors.len(),
            errors
                .iter()
                .map(|p| format!("{}: {}", p.code.code(), p.message))
                .collect::<Vec<_>>()
        )));
    }
    Ok(validated)
}

fn not_valid(e: AppError) -> AppError {
    validation_failed(format!("the embedded example data does not validate: {e}"))
}

fn no_training_side() -> AppError {
    validation_failed("the example run carries no training side")
}

/// The example's one rule on the run's shape, shared by
/// [`example_run_inputs`] and [`example_validation`]: the run's pass must
/// build a train side ([`orchestrator::run_has_train_side`]).
fn require_training_side(request: &CreateRunRequest) -> Result<(), AppError> {
    if orchestrator::run_has_train_side(&request.input, request.mode) {
        Ok(())
    } else {
        Err(no_training_side())
    }
}

/// Canonicalize the example run's request through the run's own pass
/// ([`orchestrator::canonicalize_run`]), checked by
/// [`require_training_side`] and [`error_free`].
pub fn example_run_inputs() -> Result<ExampleRunInputs, AppError> {
    run_inputs_of(example_run_request(&[]))
}

fn run_inputs_of(request: CreateRunRequest) -> Result<ExampleRunInputs, AppError> {
    require_training_side(&request)?;
    let canonical = orchestrator::canonicalize_run(&request.input, &request.config, request.mode)
        .map_err(not_valid)?;
    let validation = error_free(canonical.validated)?;
    let train = canonical.train.ok_or_else(no_training_side)?;
    let settings = orchestrator::method_bundle_settings(&request.config, detect_cpus());
    Ok(ExampleRunInputs {
        validation,
        train,
        predict: canonical.predict,
        config: request.config,
        settings,
    })
}

/// The example training pair + the validator's verdict: the run's own
/// validation of [`example_run_request`]'s tables
/// ([`orchestrator::validate_run`], the first step of the run's pass),
/// without building the canonical sides — checked by the same
/// [`require_training_side`] and [`error_free`] as [`example_run_inputs`].
pub fn example_validation() -> Result<ValidationResponse, AppError> {
    validation_of(&example_run_request(&[]))
}

fn validation_of(request: &CreateRunRequest) -> Result<ValidationResponse, AppError> {
    require_training_side(request)?;
    orchestrator::validate_run(&request.input, &request.config, request.mode)
        .map_err(not_valid)
        .and_then(error_free)
}

/// The deterministic fast-method pick (the test seam of the real catalogue).
/// The verdicts are the PURE eligibility engine over the example run's
/// inventory; the runtime-env + saves_model filters implement the plan's
/// "methods that have a published environment"; the bundle filter is
/// [`ExampleRunInputs::preflight`], so a picked method is never refused with
/// a `BUNDLE_*` code; the estimate is the catalogue's (`REFERENCE_CPUS` —
/// host-independent).
pub fn pick_fast_methods(inputs: &ExampleRunInputs) -> Vec<String> {
    pick_fast_methods_with(inputs, runtime_env_available)
}

/// [`pick_fast_methods`] with the published-environment predicate injected
/// (production passes the host-arch [`runtime_env_available`]; the tests
/// pass a fixed arch so the pick is checked on any host).
fn pick_fast_methods_with(
    inputs: &ExampleRunInputs,
    env_available: impl Fn(&str) -> bool,
) -> Vec<String> {
    pick_from(catalogue(), inputs, env_available)
}

/// The pick over a given catalogue (production: the embedded one; the tests
/// inject a modified copy to reach a method only the bundle stage refuses).
fn pick_from(
    cat: &Catalogue,
    inputs: &ExampleRunInputs,
    env_available: impl Fn(&str) -> bool,
) -> Vec<String> {
    first_passing(fast_candidates(cat, inputs, env_available), |method| {
        // The run's own bundle stage on the example rows: a method it would
        // refuse fails before (or between) its calls.
        inputs.preflight(method).is_ok()
    })
}

/// The cheap filters, fastest first with an id tie-break
/// ([`runnable_methods`], then [`rank_fast`]).
fn fast_candidates<'c>(
    cat: &'c Catalogue,
    inputs: &ExampleRunInputs,
    env_available: impl Fn(&str) -> bool,
) -> Vec<(f64, &'c Method)> {
    rank_fast(
        &runnable_methods(cat, inputs, env_available),
        inputs.patients(),
    )
}

/// The methods with a `CanRun` verdict on the inputs' inventory (the one
/// eligibility run), a published environment and `saves_model`.
fn runnable_methods<'c>(
    cat: &'c Catalogue,
    inputs: &ExampleRunInputs,
    env_available: impl Fn(&str) -> bool,
) -> Vec<&'c Method> {
    eligibility_for(
        cat,
        &EligibilityRequest::Inventory {
            inventory: inputs.validation.inventory.clone(),
        },
    )
    .methods
    .into_iter()
    .filter(|m| m.status == EligibilityStatus::CanRun)
    .filter(|m| env_available(&m.id))
    .map(|m| {
        cat.method(&m.id)
            .expect("every verdict id is a catalogue method")
    })
    .filter(|method| method.saves_model)
    .collect()
}

/// The methods whose catalogue estimate at `patients` is under
/// [`EXAMPLE_METHOD_SECONDS_MAX`], fastest first with an id tie-break.
fn rank_fast<'c>(methods: &[&'c Method], patients: u32) -> Vec<(f64, &'c Method)> {
    let mut candidates: Vec<(f64, &Method)> = methods
        .iter()
        .map(|method| {
            (
                estimate_seconds_for(method, patients, REFERENCE_CPUS),
                *method,
            )
        })
        .filter(|(seconds, _)| *seconds < EXAMPLE_METHOD_SECONDS_MAX)
        .collect();
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    candidates
}

/// The first [`EXAMPLE_METHOD_CAP`] candidates, in order, that pass
/// `preflight` — the (costly) preflight runs in that order and stops once
/// the cap is reached. Filtering an ordered list keeps its order, so this is
/// the same set as preflighting every candidate, then sorting and capping.
fn first_passing(
    candidates: Vec<(f64, &Method)>,
    mut preflight: impl FnMut(&Method) -> bool,
) -> Vec<String> {
    candidates
        .into_iter()
        .filter(|(_, method)| preflight(method))
        .take(EXAMPLE_METHOD_CAP)
        .map(|(_, method)| method.id.clone())
        .collect()
}

/// The pick's computation: the example run's inputs, then the pick. Pure and
/// CPU-bound (validate + canonicalize + every candidate's bundles up to the
/// cap), so it runs on the blocking pool ([`PickCache`]).
fn compute_example_pick() -> Result<Vec<String>, AppError> {
    #[cfg(test)]
    tests::PICK_COMPUTATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    example_run_inputs().map(|inputs| pick_fast_methods(&inputs))
}

/// The process's example pick ([`PickCache`] over [`compute_example_pick`]).
/// Every input is fixed for the process lifetime — the embedded example
/// bytes, the embedded catalogue, the env manifest (itself loaded once) and
/// the host arch (a compile-time constant) — so the stored outcome is what a
/// fresh computation returns, and the endpoint's polls (every 1.5 s while
/// the set trains) never redo the work.
static EXAMPLE_PICK: PickCache = PickCache::new();

/// The example's method pick ([`EXAMPLE_PICK`]).
pub async fn example_methods() -> Result<Vec<String>, AppError> {
    EXAMPLE_PICK.get(compute_example_pick).await
}

/// A failed pick as the cache keeps it ([`AppError`] is not `Clone`).
#[derive(Debug, Clone)]
struct CachedFailure {
    status: u16,
    code: String,
    message: String,
}

/// A finished computation's outcome: the list, or its typed error.
type PickOutcome = Result<Vec<String>, CachedFailure>;

/// The state of the one computation in flight.
#[derive(Debug, Clone)]
enum Flight {
    Running,
    /// The outcome is stored in the cache.
    Done,
    /// The computation panicked (its message); nothing is stored.
    Panicked(String),
}

/// The example pick's cache: one computation at a time, on the blocking
/// pool, that stores its own outcome.
///
/// - A finished computation's outcome is stored, success OR failure. The
///   computation's errors come from the embedded example and catalogue
///   (e.g. `EXAMPLE_VALIDATION_FAILED`), so they are deterministic: a retry
///   would only redo the whole pick on every poll, under the endpoint's
///   lock, for the same error.
/// - Only a computation that did not finish is retried by the next call: a
///   panic (caught, answered as `EXAMPLE_PICK_FAILED`) or a blocking task
///   that never ran. Nothing poisons.
/// - The blocking task stores the outcome itself, so a caller whose future
///   is dropped mid-computation loses nothing: later callers wait on the
///   same computation, or read its stored outcome — never a second one.
struct PickCache {
    outcome: std::sync::OnceLock<PickOutcome>,
    /// `Some` while a computation runs: its completion signal.
    flight: std::sync::Mutex<Option<tokio::sync::watch::Receiver<Flight>>>,
}

impl PickCache {
    const fn new() -> Self {
        Self {
            outcome: std::sync::OnceLock::new(),
            flight: std::sync::Mutex::new(None),
        }
    }

    /// The stored outcome, else wait for the computation in flight, else
    /// start one with `compute` (unused when a computation already runs).
    async fn get<F>(&'static self, compute: F) -> Result<Vec<String>, AppError>
    where
        F: FnOnce() -> Result<Vec<String>, AppError> + Send + 'static,
    {
        let mut done = match self.join_or_start(compute) {
            Ok(outcome) => return served(outcome),
            Err(done) => done,
        };
        let flight = done
            .wait_for(|f| !matches!(f, Flight::Running))
            .await
            .map(|f| f.clone());
        match flight {
            Ok(Flight::Panicked(message)) => Err(typed_error(
                "EXAMPLE_PICK_FAILED",
                format!("the example method pick panicked: {message}"),
            )),
            Ok(_) => served(
                self.outcome
                    .get()
                    .expect("a finished computation stored its outcome"),
            ),
            Err(_) => {
                // The blocking task was dropped before it ran (a runtime
                // shutting down): clear its flight so a later call starts
                // a new computation.
                let mut flight = self.flight.lock().unwrap_or_else(|p| p.into_inner());
                if flight.as_ref().is_some_and(|f| f.same_channel(&done)) {
                    *flight = None;
                }
                Err(typed_error(
                    "EXAMPLE_PICK_FAILED",
                    "the example method pick did not run",
                ))
            }
        }
    }

    /// The stored outcome (`Ok`), or the completion signal of the
    /// computation in flight — started here when there is none (`Err`).
    fn join_or_start<F>(
        &'static self,
        compute: F,
    ) -> Result<&'static PickOutcome, tokio::sync::watch::Receiver<Flight>>
    where
        F: FnOnce() -> Result<Vec<String>, AppError> + Send + 'static,
    {
        if let Some(outcome) = self.outcome.get() {
            return Ok(outcome);
        }
        let mut flight = self.flight.lock().unwrap_or_else(|p| p.into_inner());
        // Re-checked under the lock: the task stores the outcome before it
        // clears the flight.
        if let Some(outcome) = self.outcome.get() {
            return Ok(outcome);
        }
        if let Some(done) = flight.as_ref() {
            return Err(done.clone());
        }
        let (tx, done) = tokio::sync::watch::channel(Flight::Running);
        *flight = Some(done.clone());
        drop(flight);
        tokio::task::spawn_blocking(move || {
            let finished = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(compute)) {
                Ok(outcome) => {
                    let _ = self.outcome.set(outcome.map_err(|e| CachedFailure {
                        status: e.status_code(),
                        code: e.error_code().to_string(),
                        message: e.to_string(),
                    }));
                    Flight::Done
                }
                Err(panic) => Flight::Panicked(
                    panic
                        .downcast_ref::<&str>()
                        .map(|m| m.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "a non-string panic".to_string()),
                ),
            };
            *self.flight.lock().unwrap_or_else(|p| p.into_inner()) = None;
            let _ = tx.send(finished);
        });
        Err(done)
    }
}

/// A stored outcome as the endpoint answers it.
fn served(outcome: &PickOutcome) -> Result<Vec<String>, AppError> {
    outcome.clone().map_err(|f| {
        AppError::new(
            StatusCode::from_u16(f.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            f.code,
            f.message,
        )
    })
}

/// The embedded example training tables as parsed tables (the browser-decode
/// equivalent — the committed bytes are unquoted, verified by the assets
/// check; this is the ONE CSV split the server does for its own assets).
fn parsed_example(bytes: &'static [u8], name: &str) -> ParsedTable {
    let text = std::str::from_utf8(bytes).expect("the embedded example is utf-8");
    let mut lines = text.split('\n').filter(|l| !l.is_empty());
    let header = lines.next().expect("the example has a header line");
    let columns: Vec<String> = header.split(',').map(|c| c.trim().to_string()).collect();
    let rows: Vec<Vec<Option<String>>> = lines
        .map(|line| {
            line.split(',')
                .map(|cell| {
                    let cell = cell.trim();
                    if cell.is_empty() {
                        None
                    } else {
                        Some(cell.to_string())
                    }
                })
                .collect()
        })
        .collect();
    ParsedTable {
        source: ParsedTableSource {
            name: name.to_string(),
            format: TableFormat::Csv,
        },
        header_row: 1,
        columns,
        rows,
    }
}

/// The example run request (the normal engine's input snapshot: the embedded
/// training pair, the app's default decision day/horizon, save_models true
/// so the produced `/model` facts are recorded, `keep_copies` true like any
/// E-screen run).
pub fn example_run_request(methods: &[String]) -> CreateRunRequest {
    CreateRunRequest {
        mode: TxrRunMode::Train,
        input: TxrRunInput {
            patients: Some(parsed_example(
                assets::ASSETS.patients_example,
                EXAMPLE_PATIENTS_NAME,
            )),
            measurements: parsed_example(
                assets::ASSETS.measurements_example,
                EXAMPLE_MEASUREMENTS_NAME,
            ),
            predict_measurements: None,
            joins: Vec::new(),
            mapping: Vec::new(),
            keep_copies: true,
        },
        config: RunConfig {
            at_a_time: EXAMPLE_AT_A_TIME,
            save_models: true,
            ..Default::default()
        },
        method_ids: methods.to_vec(),
        model_ids: Vec::new(),
    }
}

fn typed_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(StatusCode::INTERNAL_SERVER_ERROR, code, message.into())
}

/// The in-process seed of the example-set state machine (single-user app; the
/// lock makes a concurrent double-call a single decision, never two runs).
static ENSURE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Ensure the example saved set exists (the endpoint's core): returns the set
/// id when ready, the creating run's id + status while it trains, or the
/// failed reason. Idempotent: a second call returns the existing set, a call
/// after the set was deleted recreates it (fresh run through the normal
/// engine — DEC-2's real-set rule), and a failed run is retried by the next
/// call.
pub async fn ensure_example_set(
    pool: &SqlitePool,
    seams: &ExampleRunSeams,
    owner: Uuid,
) -> Result<ExampleSetResponse, AppError> {
    let _guard = ENSURE_LOCK.lock().await;
    inner(pool, seams, owner).await
}

async fn inner(
    pool: &SqlitePool,
    seams: &ExampleRunSeams,
    owner: Uuid,
) -> Result<ExampleSetResponse, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());

    // The fast-method pick (computed once per process on the blocking pool —
    // the catalogue, the assets and the env manifest are immutable).
    let methods = example_methods().await?;

    // The state row (may be None).
    let state_row = repo.example_state().await.map_err(|e| typed_error("EXAMPLE_STATE_READ", e.to_string()))?;

    // A ready row whose set still exists is the answer.
    if let Some(row) = &state_row {
        if row.state == ExampleSetState::Ready.as_str() {
            if let Some(set_id) = row.set_id {
                if repo.get_set(set_id).await.map_err(|e| typed_error("EXAMPLE_STATE_READ", e.to_string()))?.is_some() {
                    return Ok(ExampleSetResponse {
                        state: ExampleSetState::Ready,
                        set_id: Some(set_id),
                        run_id: None,
                        run_status: None,
                        methods,
                        error: None,
                    });
                }
            }
            // The set is gone (deleted by the user) — recreate below.
        }
    }

    // A creating row: report the run's job state; finalize when it finished.
    if let Some(row) = &state_row {
        if row.state == ExampleSetState::Creating.as_str() {
            if let Some(run_id) = row.run_id {
                let run = crate::modules::execution_engine::repository::TxrRepository::new(pool.clone())
                    .get_run(run_id)
                    .await
                    .map_err(|e| typed_error("EXAMPLE_RUN_READ", e.to_string()))?;
                let Some(run) = run else {
                    // The run row is gone (History cleared): the creation is
                    // orphaned — reset and start a fresh one below.
                    return start_fresh(pool, seams, owner, &methods).await;
                };
                let status = run.status().map_err(|e| typed_error("EXAMPLE_RUN_READ", e.to_string()))?;
                match status {
                    TxrRunStatus::Finished => {
                        return save_example_set(pool, run_id, &methods).await;
                    }
                    TxrRunStatus::Failed | TxrRunStatus::Stopped => {
                        let reason = run.error.clone().unwrap_or_else(|| status.as_str().to_string());
                        repo.upsert_example_state(&ExampleStateRow {
                            state: ExampleSetState::Failed.as_str().to_string(),
                            run_id: Some(run_id),
                            set_id: None,
                            error: Some(format!("the example training run {} — {reason}", status.as_str())),
                        })
                        .await
                        .map_err(|e| typed_error("EXAMPLE_STATE_WRITE", e.to_string()))?;
                        return Ok(ExampleSetResponse {
                            state: ExampleSetState::Failed,
                            set_id: None,
                            run_id: Some(run_id),
                            run_status: Some(status.as_str().to_string()),
                            methods,
                            error: Some(format!(
                                "the example models could not be trained: {reason}"
                            )),
                        });
                    }
                    _ => {
                        return Ok(ExampleSetResponse {
                            state: ExampleSetState::Creating,
                            set_id: None,
                            run_id: Some(run_id),
                            run_status: Some(status.as_str().to_string()),
                            methods,
                            error: None,
                        });
                    }
                }
            }
        }
    }

    // A failed row (or none) — start a fresh run.
    start_fresh(pool, seams, owner, &methods).await
}

/// Start a fresh example training run + record the creating state.
async fn start_fresh(
    pool: &SqlitePool,
    seams: &ExampleRunSeams,
    owner: Uuid,
    methods: &[String],
) -> Result<ExampleSetResponse, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    if methods.is_empty() {
        // The plan's honest fallback: no fast method with a published
        // environment can run on the example data — say so, never a fake
        // set, never a half-empty one.
        let error = "no method with a published environment can run on the example data \
                     (needs a runnable method under 30 s) — train your own models instead";
        let _ = repo
            .upsert_example_state(&ExampleStateRow {
                state: ExampleSetState::Failed.as_str().to_string(),
                run_id: None,
                set_id: None,
                error: Some(error.to_string()),
            })
            .await;
        return Ok(ExampleSetResponse {
            state: ExampleSetState::Failed,
            set_id: None,
            run_id: None,
            run_status: None,
            methods: Vec::new(),
            error: Some(error.to_string()),
        });
    }
    let request = example_run_request(methods);
    let summary = orchestrator::start_run(
        pool.clone(),
        seams.runtime.clone(),
        seams.env.clone(),
        seams.executor.clone(),
        owner,
        request,
    )
    .await
    .map_err(|e| {
        // A start failure (e.g. the user's own run holds the one run slot)
        // is the honest failed state — never a dangling creating row.
        let code = e.error_code().to_string();
        let message = e.to_string();
        let _ = repo.upsert_example_state(&ExampleStateRow {
            state: ExampleSetState::Failed.as_str().to_string(),
            run_id: None,
            set_id: None,
            error: Some(format!("the example training could not start: {code} — {message}")),
        });
        typed_error("EXAMPLE_RUN_START", format!("{code} — {message}"))
    })?;
    let run_id = summary.id;
    repo.upsert_example_state(&ExampleStateRow {
        state: ExampleSetState::Creating.as_str().to_string(),
        run_id: Some(run_id),
        set_id: None,
        error: None,
    })
    .await
    .map_err(|e| typed_error("EXAMPLE_STATE_WRITE", e.to_string()))?;
    Ok(ExampleSetResponse {
        state: ExampleSetState::Creating,
        set_id: None,
        run_id: Some(run_id),
        run_status: Some(summary.status.as_str().to_string()),
        methods: methods.to_vec(),
        error: None,
    })
}

/// Save a finished example run's produced models through the normal save path
/// (PROV-MS-3) into the reserved set — the REAL set, made by the real engine.
async fn save_example_set(
    pool: &SqlitePool,
    run_id: Uuid,
    methods: &[String],
) -> Result<ExampleSetResponse, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    let saved = store_save(pool, run_id, methods).await;
    match saved {
        Ok(resp) => {
            let set_id = resp.set.id;
            repo.upsert_example_state(&ExampleStateRow {
                state: ExampleSetState::Ready.as_str().to_string(),
                run_id: Some(run_id),
                set_id: Some(set_id),
                error: None,
            })
            .await
            .map_err(|e| typed_error("EXAMPLE_STATE_WRITE", e.to_string()))?;
            Ok(ExampleSetResponse {
                state: ExampleSetState::Ready,
                set_id: Some(set_id),
                run_id: Some(run_id),
                run_status: Some(TxrRunStatus::Finished.as_str().to_string()),
                methods: methods.to_vec(),
                error: None,
            })
        }
        Err(e) => {
            // A save failure (missing produced tree, empty set…) is honest
            // feedback on the run — the run itself finished, but the set is
            // not usable; the failed state retries the whole creation.
            let message = e.to_string();
            repo.upsert_example_state(&ExampleStateRow {
                state: ExampleSetState::Failed.as_str().to_string(),
                run_id: Some(run_id),
                set_id: None,
                error: Some(format!("the example models finished training but could not be saved: {message}")),
            })
            .await
            .map_err(|e2| typed_error("EXAMPLE_STATE_WRITE", e2.to_string()))?;
            Ok(ExampleSetResponse {
                state: ExampleSetState::Failed,
                set_id: None,
                run_id: Some(run_id),
                run_status: Some(TxrRunStatus::Finished.as_str().to_string()),
                methods: methods.to_vec(),
                error: Some(format!(
                    "the example models could not be saved: {message}"
                )),
            })
        }
    }
}

/// The normal save-models path (the seam kept private so the state machine's
/// failure branch is the only caller of the error fate).
async fn store_save(
    pool: &SqlitePool,
    run_id: Uuid,
    methods: &[String],
) -> Result<crate::modules::model_store::types::ModelSaveResponse, AppError> {
    crate::modules::model_store::store::save_from_run(
        pool,
        &crate::modules::model_store::types::SaveModelsRequest {
            run_id,
            method_ids: methods.to_vec(),
            target: crate::modules::model_store::types::SaveTarget::NewSet {
                set_name: EXAMPLE_SET_NAME.to_string(),
            },
            keep_training_files: false,
            also_export: false,
            source_label: None,
        },
    )
    .await
}



// ─────────────────────────────────────────────────────────────────────────────
// Tests — the pick applies the run's own bundle stage to the run's own data
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::modules::execution_engine::bundle::{self, BundleError, MarkerSelection};
    use crate::modules::execution_engine::envmanifest::{env_for_arch, EnvArch};
    use crate::modules::method_catalogue::types::MarkerKind;

    /// How many times [`EXAMPLE_PICK`]'s initializer ran in this process.
    pub(super) static PICK_COMPUTATIONS: AtomicUsize = AtomicUsize::new(0);

    fn inputs() -> ExampleRunInputs {
        example_run_inputs().expect("the example canonicalizes through the run's pass")
    }

    /// The committed manifest's amd64 env set (the published arch), so the
    /// pick is exercised on every host, not only where the host arch has
    /// published environments.
    fn amd64_env(id: &str) -> bool {
        env_for_arch(id, EnvArch::Amd64).is_some()
    }

    fn json<T: serde::Serialize>(v: &T) -> serde_json::Value {
        serde_json::to_value(v).expect("serializes")
    }

    /// Every method the pick returns — on the host arch and on the committed
    /// amd64 env set — gets its train and test bundles built exactly as
    /// `execute_train` builds them ([`orchestrator::method_bundles`], the
    /// function it calls, with the run's settings and the method's
    /// `min_draws`), and passes the full bundle preflight (the cross-fit or
    /// cohort bundles too). The amd64 pick is not empty, so this is never
    /// vacuous.
    #[test]
    fn every_picked_method_builds_every_run_bundle_on_the_example() {
        let inputs = inputs();
        let settings = inputs.settings.clone();
        let host = pick_fast_methods(&inputs);
        let amd64 = pick_fast_methods_with(&inputs, amd64_env);
        assert!(
            !amd64.is_empty(),
            "the committed amd64 env set yields at least one example method"
        );
        assert!(amd64.len() <= EXAMPLE_METHOD_CAP, "{amd64:?}");
        assert_eq!(
            amd64,
            pick_fast_methods_with(&inputs, amd64_env),
            "the pick is deterministic"
        );
        let cat = catalogue();
        for id in host.iter().chain(amd64.iter()) {
            let method = cat.method(id).expect("a picked id is a catalogue method");
            let built = orchestrator::method_bundles(
                &inputs.train,
                inputs.predict.as_deref(),
                method,
                &settings,
                method.min_draws,
            )
            .unwrap_or_else(|e| panic!("{id}: the run's bundle stage refuses it: {e}"));
            assert!(
                !built.selection.mains().is_empty(),
                "{id} receives a marker"
            );
            assert!(!built.train.outcomes.is_empty(), "{id} learns an outcome");
            assert!(
                !built.test.scored.is_empty(),
                "{id} scores the predict surface"
            );
            orchestrator::train_bundle_preflight(
                &inputs.train,
                inputs.predict.as_deref(),
                method,
                &settings,
                method.min_draws,
            )
            .unwrap_or_else(|e| panic!("{id}: a later bundle of the call is refused: {e}"));
        }
    }

    /// The example pick on this host plus the pick on the committed amd64 env
    /// set, so the check is never empty on a host whose arch has no published
    /// environments.
    fn pick_any_arch(inputs: &ExampleRunInputs) -> Vec<String> {
        let mut picked = pick_fast_methods(inputs);
        for id in pick_fast_methods_with(inputs, amd64_env) {
            if !picked.contains(&id) {
                picked.push(id);
            }
        }
        picked
    }

    /// "Use example" trains: every method the example pick returns goes
    /// through the run's own `prepare_run` over [`example_run_request`], then
    /// the REAL train executor with the context the drive builds (only the
    /// sandbox is scripted — the engine's `test_support`). No method is
    /// refused at the bundle stage, every one finishes with a produced
    /// model, and the pick judged the same canonical sides `prepare_run`
    /// hands the executor, under the same config.
    #[tokio::test]
    async fn every_example_pick_trains_through_the_real_executor() {
        use crate::modules::execution_engine::orchestrator::test_support::train_with_scripted_sandbox;
        use crate::modules::execution_engine::types::TxrMethodState;
        use crate::modules::sandbox::stack::MethodRunMode;

        let inputs = inputs();
        let picked = pick_any_arch(&inputs);
        assert!(!picked.is_empty(), "the amd64 pick is not empty");
        let req = example_run_request(&picked);
        assert_eq!(req.config, inputs.config, "the pick used the run's config");

        let run = train_with_scripted_sandbox(&req, "example-pick-executor").await;
        assert_eq!(
            run.train.as_deref().map(json),
            Some(json(&*inputs.train)),
            "the pick judged the run's train side"
        );
        assert_eq!(
            run.predict.as_deref().map(json),
            inputs.predict.as_deref().map(json),
            "the pick judged the run's predict side"
        );
        assert_eq!(
            run.methods
                .iter()
                .map(|m| m.method_id.clone())
                .collect::<Vec<_>>(),
            picked
        );
        for m in &run.methods {
            let id = &m.method_id;
            assert!(m.train_target, "{id}: a train request plans train calls");
            let facts = catalogue().method(id).expect("a catalogue method");
            assert_eq!(m.min_draws, facts.min_draws, "{id}: the plan's min_draws");
            // Only a host without a published env plans it `cannot_run`, and
            // then for the env — never a data reason.
            assert_eq!(
                m.cannot_run,
                !runtime_env_available(id),
                "{id}: {:?}",
                m.reason
            );
            if m.cannot_run {
                let reason = m.reason.as_ref().expect("a cannot_run reason");
                assert!(
                    ["ENV_IMAGE_MISSING", "ENV_UNKNOWN"].contains(&reason.code.as_str()),
                    "{id}: {reason:?}"
                );
            }
            assert_eq!(
                m.preflight,
                Ok(()),
                "{id}: the pick's preflight on the run's context"
            );
            assert!(m.outcome.reason.is_none(), "{id}: {:?}", m.outcome.reason);
            assert_eq!(m.outcome.state, TxrMethodState::Finished, "{id}");
            assert!(
                m.outcome.model.is_some(),
                "{id}: save_models → a produced model"
            );
            assert_eq!(
                m.calls.first(),
                Some(&MethodRunMode::FitOnly),
                "{id}: the fit ran"
            );
        }
    }

    /// The three-marker example refuses every `single` method without a fixed
    /// marker list (`BUNDLE_MARKER_COUNT_UNMET`), so none is picked — even
    /// though eligibility says `CanRun` for them and they otherwise pass the
    /// pick's filters (the methods the pick used to return).
    #[test]
    fn a_single_marker_method_without_a_fixed_list_is_not_picked_on_the_three_marker_example() {
        let inputs = inputs();
        let settings = inputs.settings.clone();
        assert_eq!(
            MarkerSelection::all(&inputs.train).mains(),
            ["M1", "M2", "M3"],
            "the example carries three main markers"
        );

        let cat = catalogue();
        let verdicts = eligibility_for(
            cat,
            &EligibilityRequest::Inventory {
                inventory: inputs.validation.inventory.clone(),
            },
        );
        let single_without_list: Vec<String> = verdicts
            .methods
            .iter()
            .filter(|m| m.status == EligibilityStatus::CanRun && amd64_env(&m.id))
            .filter_map(|m| cat.method(&m.id))
            .filter(|m| {
                m.saves_model
                    && m.markers.kind == MarkerKind::Single
                    && m.required_markers.is_none()
                    && estimate_seconds_for(m, inputs.patients(), REFERENCE_CPUS)
                        < EXAMPLE_METHOD_SECONDS_MAX
            })
            .map(|m| m.id.clone())
            .collect();
        assert!(
            !single_without_list.is_empty(),
            "the catalogue has fast single-marker methods without a fixed list that \
             eligibility lets run on the example (the case under test)"
        );
        for id in &single_without_list {
            let method = cat.method(id).expect("catalogue method");
            match orchestrator::train_bundle_preflight(
                &inputs.train,
                inputs.predict.as_deref(),
                method,
                &settings,
                method.min_draws,
            ) {
                Err(BundleError::MarkerCountUnmet { expected: 1, names }) => {
                    assert_eq!(names, ["M1", "M2", "M3"], "{id}");
                }
                other => panic!("{id}: expected BUNDLE_MARKER_COUNT_UNMET, got {other:?}"),
            }
        }

        let host = pick_fast_methods(&inputs);
        let amd64 = pick_fast_methods_with(&inputs, amd64_env);
        for id in host.iter().chain(amd64.iter()) {
            assert!(
                !single_without_list.contains(id),
                "{id} is a single-marker method without a fixed list — the run refuses it"
            );
        }
    }

    /// The preflight the pick filters on is the whole bundle stage, not only
    /// the marker rule: a picked method whose marker set resolves but whose
    /// draw minimum no example patient meets is refused with the run's
    /// `BUNDLE_NO_TRAINING_PATIENT`, and covariates on over patients without
    /// a covariate column with `BUNDLE_COVARIATES_MISSING`.
    #[test]
    fn the_pick_preflight_refuses_the_bundle_stage_beyond_the_marker_rule() {
        let inputs = inputs();
        let settings = inputs.settings.clone();
        let amd64 = pick_fast_methods_with(&inputs, amd64_env);
        let id = amd64.first().expect("the amd64 pick is not empty");
        let mut method = catalogue().method(id).expect("catalogue method").clone();
        assert!(
            bundle::method_marker_set(
                &inputs.train,
                &method.markers,
                method.required_markers.as_ref()
            )
            .is_ok(),
            "{id}: the marker rule alone accepts it"
        );

        method.min_draws = 10_000;
        assert_eq!(
            orchestrator::train_bundle_preflight(
                &inputs.train,
                inputs.predict.as_deref(),
                &method,
                &settings,
                method.min_draws,
            ),
            Err(BundleError::NoTrainingPatient { min_draws: 10_000 }),
            "{id} with an unmet draw minimum"
        );

        // Covariates on over a copy of the example rows whose patients carry
        // no covariate column (the example itself has age/sex/stage).
        let method = catalogue().method(id).expect("catalogue method");
        let covariate_settings = BundleSettings {
            covariates: true,
            ..settings.clone()
        };
        let mut no_covariates = (*inputs.train).clone();
        for patient in &mut no_covariates.patients {
            patient.covariates.clear();
        }
        assert_eq!(
            orchestrator::train_bundle_preflight(
                &no_covariates,
                inputs.predict.as_deref(),
                method,
                &covariate_settings,
                method.min_draws,
            ),
            Err(BundleError::CovariatesWithoutColumns),
            "{id} with covariates on and no covariate column"
        );
    }

    /// The pick's data is the run's data: the inputs come from
    /// [`example_run_request`] through the run's own canonicalization, and
    /// the request for the picked methods canonicalizes to the same train
    /// and predict sides and carries the same config (the method list never
    /// changes the data).
    #[test]
    fn the_pick_judges_the_run_s_own_canonical_input() {
        let inputs = inputs();
        let picked = pick_fast_methods_with(&inputs, amd64_env);
        let request = example_run_request(&picked);
        assert_eq!(request.method_ids, picked);
        assert_eq!(request.config, inputs.config, "the run's config");
        let run = orchestrator::canonicalize_run(&request.input, &request.config, request.mode)
            .expect("the run canonicalizes its request");
        let run_train = run.train.expect("a train run has a training side");
        assert_eq!(
            json(&*run_train),
            json(&*inputs.train),
            "the same train side"
        );
        assert_eq!(
            run.predict.as_deref().map(json),
            inputs.predict.as_deref().map(json),
            "the same predict side"
        );
        assert_eq!(
            json(&run.validated.inventory),
            json(&inputs.validation.inventory),
            "the same inventory the run's classification judges"
        );
    }

    /// The validate-only path answers the same verdict the run's full pass
    /// carries (one request builder, one validation).
    #[test]
    fn example_validation_is_the_run_pass_validation() {
        assert_eq!(
            json(&example_validation().expect("the example validates")),
            json(&inputs().validation)
        );
    }

    /// Both paths refuse the same way when the run's pass would build no
    /// train side: a predict-only request (reuse mode, no patients table)
    /// gets the same typed error from the inputs and the validation.
    #[test]
    fn inputs_and_validation_agree_when_the_run_has_no_training_side() {
        let mut request = example_run_request(&[]);
        request.mode = TxrRunMode::Reuse;
        request.input.patients = None;
        assert!(!orchestrator::run_has_train_side(
            &request.input,
            request.mode
        ));
        let from_inputs = match run_inputs_of(request.clone()) {
            Ok(_) => panic!("a run without a train side has no example inputs"),
            Err(e) => e,
        };
        let from_validation = validation_of(&request).expect_err("the same refusal");
        assert_eq!(from_inputs.error_code(), "EXAMPLE_VALIDATION_FAILED");
        assert_eq!(
            (from_inputs.error_code(), from_inputs.to_string()),
            (from_validation.error_code(), from_validation.to_string())
        );
        assert!(
            from_inputs.to_string().contains("no training side"),
            "{from_inputs}"
        );

        // The real request passes the rule on both paths.
        let real = example_run_request(&[]);
        assert!(orchestrator::run_has_train_side(&real.input, real.mode));
        assert!(validation_of(&real).is_ok() && run_inputs_of(real).is_ok());
    }

    /// The cached pick is the pick of a fresh computation on this host, and
    /// it is computed once: however many calls (the endpoint's polls) read
    /// it, the computation ran one time in this process.
    #[tokio::test]
    async fn the_cached_pick_is_computed_once_and_equals_a_fresh_pick() {
        let cached = example_methods().await.expect("the example validates");
        for _ in 0..20 {
            assert_eq!(example_methods().await.expect("again"), cached);
        }
        assert_eq!(
            PICK_COMPUTATIONS.load(Ordering::SeqCst),
            1,
            "the pick is computed once per process, not per call"
        );
        assert_eq!(
            cached,
            pick_fast_methods(&inputs()),
            "the cache holds a fresh pick"
        );
    }

    /// A failed computation is stored like a success: its typed error is
    /// answered again without computing. A panic is not stored — it comes
    /// back as `EXAMPLE_PICK_FAILED`, nothing poisons, and the next call
    /// computes again.
    #[tokio::test]
    async fn a_failed_pick_is_cached_and_a_panicked_one_is_retried() {
        static FAILS: PickCache = PickCache::new();
        static SUCCEEDS: PickCache = PickCache::new();
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn panics() -> Result<Vec<String>, AppError> {
            RUNS.fetch_add(1, Ordering::SeqCst);
            panic!("the pick computation panicked")
        }

        let panicked = FAILS.get(panics).await.expect_err("a panic is an error");
        assert_eq!(panicked.error_code(), "EXAMPLE_PICK_FAILED");
        assert!(FAILS.outcome.get().is_none(), "a panic is not stored");
        let failed = FAILS
            .get(|| {
                RUNS.fetch_add(1, Ordering::SeqCst);
                Err(validation_failed("the example does not validate"))
            })
            .await
            .expect_err("the failure is returned");
        assert_eq!(failed.error_code(), "EXAMPLE_VALIDATION_FAILED");
        let again = FAILS
            .get(|| {
                RUNS.fetch_add(1, Ordering::SeqCst);
                Ok(vec!["never computed".to_string()])
            })
            .await
            .expect_err("the stored failure is answered again");
        assert_eq!(
            (again.error_code(), again.to_string(), again.status_code()),
            (
                failed.error_code(),
                failed.to_string(),
                failed.status_code()
            )
        );
        assert_eq!(
            RUNS.load(Ordering::SeqCst),
            2,
            "the failure is not recomputed"
        );

        SUCCEEDS.get(panics).await.expect_err("a panic is an error");
        let picked = SUCCEEDS
            .get(|| {
                RUNS.fetch_add(1, Ordering::SeqCst);
                Ok(vec!["m".to_string()])
            })
            .await
            .expect("after a panic the next call computes again");
        assert_eq!(picked, ["m"]);
        let cached = SUCCEEDS.get(panics).await.expect("the success is stored");
        assert_eq!(cached, ["m"]);
        assert_eq!(RUNS.load(Ordering::SeqCst), 4);
    }

    /// Wait (bounded) until `done` holds.
    async fn until(done: impl Fn() -> bool) {
        for _ in 0..2000 {
            if done() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("the condition did not hold in time");
    }

    /// A caller dropped mid-computation does not lose the computation:
    /// a caller arriving while it runs waits on that same computation, and
    /// with no caller left its outcome is still stored — one computation
    /// either way.
    #[tokio::test]
    async fn a_cancelled_first_caller_does_not_start_a_second_computation() {
        // A second caller arrives while the computation runs.
        static SHARED: PickCache = PickCache::new();
        static SHARED_RUNS: AtomicUsize = AtomicUsize::new(0);
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let first = tokio::spawn(SHARED.get(move || {
            SHARED_RUNS.fetch_add(1, Ordering::SeqCst);
            wait.recv().expect("released");
            Ok(vec!["m".to_string()])
        }));
        until(|| SHARED_RUNS.load(Ordering::SeqCst) == 1).await;
        first.abort();
        assert!(first.await.expect_err("aborted").is_cancelled());
        let second = tokio::spawn(SHARED.get(|| {
            SHARED_RUNS.fetch_add(1, Ordering::SeqCst);
            Ok(vec!["a second computation".to_string()])
        }));
        tokio::task::yield_now().await;
        release.send(()).expect("the computation waits");
        assert_eq!(second.await.expect("joined").expect("picked"), ["m"]);
        assert_eq!(SHARED_RUNS.load(Ordering::SeqCst), 1, "one computation");

        // No caller left: the outcome still reaches the cache.
        static ALONE: PickCache = PickCache::new();
        static ALONE_RUNS: AtomicUsize = AtomicUsize::new(0);
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let first = tokio::spawn(ALONE.get(move || {
            ALONE_RUNS.fetch_add(1, Ordering::SeqCst);
            wait.recv().expect("released");
            Ok(vec!["m".to_string()])
        }));
        until(|| ALONE_RUNS.load(Ordering::SeqCst) == 1).await;
        first.abort();
        assert!(first.await.expect_err("aborted").is_cancelled());
        release.send(()).expect("the computation waits");
        until(|| ALONE.outcome.get().is_some()).await;
        let cached = ALONE
            .get(|| -> Result<Vec<String>, AppError> { panic!("never recomputed") })
            .await
            .expect("the stored outcome");
        assert_eq!(cached, ["m"]);
        assert_eq!(ALONE_RUNS.load(Ordering::SeqCst), 1, "one computation");
    }

    /// The preflight runs over the candidates in pick order (fastest first,
    /// id tie-break) and stops once the cap is reached, and the picked set is
    /// the one the old order gave: preflight every candidate, then sort and
    /// cap — on this host's env set and on the committed amd64 one.
    #[test]
    fn the_preflight_runs_in_pick_order_and_stops_at_the_cap() {
        let inputs = inputs();
        let host = |id: &str| runtime_env_available(id);
        let envs: [(&str, &dyn Fn(&str) -> bool); 2] = [("host", &host), ("amd64", &amd64_env)];
        for (arch, env) in envs {
            let candidates = fast_candidates(catalogue(), &inputs, env);
            let order: Vec<String> = candidates.iter().map(|(_, m)| m.id.clone()).collect();

            let mut eager: Vec<(f64, String)> = candidates
                .iter()
                .filter(|(_, m)| inputs.preflight(m).is_ok())
                .map(|(seconds, m)| (*seconds, m.id.clone()))
                .collect();
            eager.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            let eager: Vec<String> = eager
                .into_iter()
                .take(EXAMPLE_METHOD_CAP)
                .map(|(_, id)| id)
                .collect();

            let mut preflighted: Vec<String> = Vec::new();
            let lazy = first_passing(candidates, |m| {
                preflighted.push(m.id.clone());
                inputs.preflight(m).is_ok()
            });
            assert_eq!(lazy, eager, "{arch}: the same picked set");
            assert_eq!(lazy, pick_fast_methods_with(&inputs, env), "{arch}");
            assert_eq!(
                preflighted,
                order[..preflighted.len()],
                "{arch}: the preflight follows the pick order"
            );
            if lazy.len() == EXAMPLE_METHOD_CAP {
                // It stops at the cap: the last preflight is the last pick,
                // so every candidate after it is never preflighted.
                let last = order
                    .iter()
                    .position(|id| Some(id) == lazy.last())
                    .expect("the last pick is a candidate");
                assert_eq!(preflighted.len(), last + 1, "{arch}: stops at the cap");
                if last + 1 < order.len() {
                    assert!(
                        preflighted.len() < order.len(),
                        "{arch}: candidates after the last pick are skipped"
                    );
                }
            } else {
                // Fewer passes than the cap: every candidate was tried.
                assert_eq!(preflighted, order, "{arch}: every candidate tried");
            }
        }
    }

    /// The example rows cut to the first `n` patients (sorted ids) — a
    /// canonical subset like the run's cross-fit folds.
    fn first_patients(train: &CanonicalBundle, n: usize) -> CanonicalBundle {
        let mut ids: Vec<&str> = train
            .patients
            .iter()
            .map(|p| p.patient_id.as_str())
            .collect();
        ids.sort_unstable();
        let keep: HashSet<&str> = ids.into_iter().take(n).collect();
        CanonicalBundle {
            patients: train
                .patients
                .iter()
                .filter(|p| keep.contains(p.patient_id.as_str()))
                .cloned()
                .collect(),
            values: train
                .values
                .iter()
                .filter(|v| keep.contains(v.patient_id.as_str()))
                .cloned()
                .collect(),
            features: train.features.clone(),
        }
    }

    /// The example inputs with the training rows cut to the first `n`
    /// patients (the validation, the predict side and the config unchanged).
    fn cut_inputs(full: &ExampleRunInputs, n: usize) -> ExampleRunInputs {
        ExampleRunInputs {
            validation: full.validation.clone(),
            train: Arc::new(first_patients(&full.train, n)),
            predict: full.predict.clone(),
            config: full.config.clone(),
            settings: full.settings.clone(),
        }
    }

    /// A picked method that a cross-fit fold would refuse once it is
    /// `fitted`: for each cohort size (ascending, stopping at the first that
    /// gives the case), the unmodified amd64 pick on the cut rows — from ONE
    /// eligibility run, since the cut leaves the inventory unchanged — and,
    /// for each picked method that is not fitted, a copy of just that method
    /// marked `fitted` whose marker set and first train/test bundles build
    /// but whose call is refused `BUNDLE_NO_LEARNABLE_OUTCOME` at a
    /// cross-fit fold's rest set. Returns the cut inputs and the modified
    /// method.
    fn crossfit_refused_case(full: &ExampleRunInputs) -> Option<(ExampleRunInputs, Method)> {
        let refused = Err(BundleError::NoLearnableOutcome {
            min: bundle::MIN_TRAINING_PATIENTS,
        });
        let runnable = runnable_methods(catalogue(), full, amd64_env);
        (bundle::MIN_TRAINING_PATIENTS..full.train.patients.len()).find_map(|n| {
            let cut = cut_inputs(full, n);
            let picked = first_passing(rank_fast(&runnable, cut.patients()), |m| {
                cut.preflight(m).is_ok()
            });
            let fitted = picked
                .iter()
                .map(|id| catalogue().method(id).expect("a picked method"))
                .filter(|m| !m.fitted)
                .find_map(|m| {
                    let mut fitted = m.clone();
                    fitted.fitted = true;
                    let first_bundles = orchestrator::method_bundles(
                        &cut.train,
                        cut.predict.as_deref(),
                        &fitted,
                        &cut.settings,
                        fitted.min_draws,
                    );
                    (first_bundles.is_ok() && cut.preflight(&fitted) == refused).then_some(fitted)
                })?;
            Some((cut, fitted))
        })
    }

    /// A method the bundle stage refuses is not picked, even when it passes
    /// every other filter including the marker rule and its first train/test
    /// bundles ([`orchestrator::method_bundles`]). On the real catalogue and
    /// the real example no method is refused past the marker rule, so the
    /// case is built and searched for ([`crossfit_refused_case`]): the rows
    /// are cut so the full-cohort train bundle learns but a cross-fit fold's
    /// rest set does not, and a picked method is marked `fitted` in a copy
    /// of the catalogue, so its call would build the cross-fit bundles and be
    /// refused between its calls. That method leaves the pick (it was picked
    /// unmodified on the same rows); the rest of the pick stays.
    #[test]
    fn a_method_the_bundle_stage_refuses_is_not_picked() {
        let full = inputs();
        let (cut, modified) = crossfit_refused_case(&full)
            .expect("a picked method that a cross-fit fold refuses once fitted");
        let target = modified.id.clone();
        let mut cat = catalogue().clone();
        *cat.methods
            .iter_mut()
            .find(|m| m.id == target)
            .expect("the picked method is in the catalogue") = modified;
        let fitted = cat.method(&target).expect("the modified method");

        // Every other filter keeps it.
        let verdicts = eligibility_for(
            &cat,
            &EligibilityRequest::Inventory {
                inventory: cut.validation.inventory.clone(),
            },
        );
        let verdict = verdicts
            .methods
            .iter()
            .find(|m| m.id == target)
            .expect("a verdict for the method");
        assert_eq!(verdict.status, EligibilityStatus::CanRun, "{target}");
        assert!(amd64_env(&target) && fitted.saves_model, "{target}");
        assert!(
            estimate_seconds_for(fitted, cut.patients(), REFERENCE_CPUS)
                < EXAMPLE_METHOD_SECONDS_MAX,
            "{target} stays under the time budget"
        );
        assert!(
            bundle::method_marker_set(
                &cut.train,
                &fitted.markers,
                fitted.required_markers.as_ref()
            )
            .is_ok(),
            "{target}: the marker rule accepts it"
        );

        // The bundle stage refuses it, so the pick leaves it out.
        assert_eq!(
            cut.preflight(fitted),
            Err(BundleError::NoLearnableOutcome {
                min: bundle::MIN_TRAINING_PATIENTS
            }),
            "{target}: a cross-fit fold's rest set learns no outcome"
        );
        let unmodified = pick_from(catalogue(), &cut, amd64_env);
        assert!(
            unmodified.contains(&target),
            "{target} is picked unmodified"
        );
        let picked = pick_from(&cat, &cut, amd64_env);
        assert!(
            !picked.contains(&target),
            "{target} is refused, not picked: {picked:?}"
        );
        for id in unmodified.iter().filter(|id| **id != target) {
            assert!(picked.contains(id), "{id} is still picked: {picked:?}");
        }
    }
}
