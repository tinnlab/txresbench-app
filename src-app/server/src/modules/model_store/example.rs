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
//!    is a function of the method list (its catalogue and this host's
//!    published env set) + the embedded example only — no calibration, no
//!    host-CPU dependence — and is computed once per list the process runs
//!    on ([`example_methods`]).
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

use crate::modules::execution_engine::bundle::BundleError;
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
use crate::modules::method_catalogue::eligibility::{
    eligibility_ignoring_filters, estimate_seconds_for, REFERENCE_CPUS,
};
use crate::modules::execution_engine::envmanifest::EnvArch;
use crate::modules::method_list::MethodList;
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
    /// The example run's ONE marker plan (audit fix 4): the example run IS a
    /// learn run — the run start computes the plan the same way — so the
    /// pick's preflight must judge the no-list methods by the SAME plan
    /// (otherwise a method the run would run on its ranked marker is refused
    /// at the pick, or a method the run would refuse is picked).
    pub marker_plan: Option<crate::modules::execution_engine::marker_rank::MarkerPlan>,
    /// The CPU count the run detects at start
    /// ([`orchestrator::detect_cpus`]) — the count every method's call
    /// settings are derived with, so a pick derives each method's settings
    /// with the SAME count as the run ([`ExampleRunInputs::preflight`], bug
    /// 2: the per-method covariates rule replaces the run-wide flag).
    pub(crate) cpus: u32,
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
    /// — marker set, train/test, cross-fit), with the method's OWN call
    /// settings ([`orchestrator::train_call_bundle_settings`] — the same
    /// per-method rule as the run, so e.g. a `none`-mode method is never
    /// refused for the run's covariates checkbox, bug 2) and the method's
    /// `min_draws`. The settings carry the example run's marker plan (audit
    /// fix 4), so a no-list method is preflighted on its PLANNED markers —
    /// exactly what the run will do. `Ok` means the run never refuses the
    /// method with a `BUNDLE_*` code.
    pub fn preflight(&self, method: &Method) -> Result<(), BundleError> {
        let mut settings = orchestrator::train_call_bundle_settings(
            &self.config,
            self.cpus,
            method,
            &self.train,
            self.predict.as_deref(),
        );
        settings.marker_plan = self.marker_plan.clone();
        orchestrator::train_bundle_preflight(
            &self.train,
            self.predict.as_deref(),
            method,
            self.config.endpoint,
            &settings,
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
    run_inputs_of(&crate::modules::method_list::current(), example_run_request(&[]))
}

fn run_inputs_of(list: &MethodList, request: CreateRunRequest) -> Result<ExampleRunInputs, AppError> {
    require_training_side(&request)?;
    let canonical =
        orchestrator::canonicalize_run(list, &request.input, &request.config, request.mode)
            .map_err(not_valid)?;
    let validation = error_free(canonical.validated)?;
    let train = canonical.train.ok_or_else(no_training_side)?;
    // The example run's ONE marker plan (audit fix 4): the SAME function and
    // inputs as a learn run's plan (run start) — the canonical train side,
    // the endpoint, the decision day, the baseline maximum and the choice.
    let marker_plan = Some(crate::modules::execution_engine::marker_rank::plan_for(
        &train,
        request.config.endpoint,
        request.config.decision_day,
        crate::modules::file_validator::types::DEFAULT_BASELINE_MAX_DAY,
        request
            .config
            .single_marker
            .clone()
            .unwrap_or(crate::modules::execution_engine::marker_rank::SingleMarkerChoice::Ranked),
    ));
    let cpus = detect_cpus();
    Ok(ExampleRunInputs {
        validation,
        train,
        predict: canonical.predict,
        config: request.config,
        marker_plan,
        cpus,
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
    orchestrator::validate_run(
        &crate::modules::method_list::current(),
        &request.input,
        &request.config,
        request.mode,
    )
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
    pick_in(&crate::modules::method_list::current(), inputs)
}

/// The pick over one method list: its catalogue, and its host-arch images as
/// the published-environment predicate.
fn pick_in(list: &MethodList, inputs: &ExampleRunInputs) -> Vec<String> {
    pick_from(&list.catalogue, inputs, |id| list.has_env(id))
}

/// [`pick_fast_methods`] with the published-environment predicate injected
/// (production passes the host-arch images; the tests pass a fixed arch so
/// the pick is checked on any host).
#[cfg(test)]
fn pick_fast_methods_with(
    inputs: &ExampleRunInputs,
    env_available: impl Fn(&str) -> bool,
) -> Vec<String> {
    pick_from(&crate::modules::method_list::current().catalogue, inputs, env_available)
}

/// The pick over a given catalogue (production: the current list's; the tests
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
    // The example inventory never carries method filters (the answers only
    // choose which methods are OFFERED, not what a run can compute), and the
    // total seam variant ignores them anyway — no error path, no `expect`.
    eligibility_ignoring_filters(
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
fn compute_example_pick(list: &MethodList) -> Result<Vec<String>, AppError> {
    #[cfg(test)]
    tests::PICK_COMPUTATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    run_inputs_of(list, example_run_request(&[])).map(|inputs| pick_in(list, &inputs))
}

/// The process's example pick, per method list ([`PickCache`] over
/// [`compute_example_pick`]). Every input is fixed for one list — the
/// embedded example bytes, the list's catalogue and images, and the host
/// arch (a compile-time constant) — so the stored outcome is what a fresh
/// computation returns, and the endpoint's polls (every 1.5 s while the set
/// trains) never redo the work. When the app moves to a newer list, the pick
/// is made again over it (one cache per list the process moves to; a
/// handful at most, so the old ones are simply kept).
static EXAMPLE_PICKS: std::sync::Mutex<Option<(u64, &'static PickCache)>> =
    std::sync::Mutex::new(None);

/// The example's method pick ([`EXAMPLE_PICKS`]), over the current list.
pub async fn example_methods() -> Result<Vec<String>, AppError> {
    let list = crate::modules::method_list::current();
    let cache: &'static PickCache = {
        let mut slot = EXAMPLE_PICKS.lock().unwrap_or_else(|p| p.into_inner());
        match *slot {
            Some((sequence, cache)) if sequence == list.sequence => cache,
            _ => {
                let cache: &'static PickCache = Box::leak(Box::new(PickCache::new()));
                *slot = Some((list.sequence, cache));
                cache
            }
        }
    };
    cache.get(move || compute_example_pick(&list)).await
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
        method_list_sequence: None,
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

/// The example's error line when no method can run at all, with the runner's
/// own reason (one full sentence, whatever punctuation the reason ends in).
fn cannot_make_example(reason: &str) -> String {
    format!("Example models cannot be made: {}.", reason.trim().trim_end_matches('.'))
}

/// The empty-pick message when the list has methods for this kind of
/// processor, but none finishes the example data quickly enough.
const NO_FAST_EXAMPLE_METHOD: &str = "Example models cannot be made: no method that is ready to run \
     finishes the example data in under 30 seconds. Train your own models instead.";

/// The empty-pick message for a processor the app does not support.
const UNSUPPORTED_PROCESSOR: &str = "Example models cannot be made: the app does not support this \
     kind of processor.";

/// The empty-pick message for a method list that has nothing for this kind
/// of processor.
const NO_METHODS_FOR_PROCESSOR: &str = "Example models cannot be made: the method list has no methods \
     for this kind of processor yet.";

/// The example's empty-pick message. A list with no method image for this
/// kind of processor (e.g. a list built only for Intel/AMD, opened on an
/// Apple-chip Mac) says so: no method can run at all, so the message never
/// suggests training instead. Otherwise it is the old meaning, no method
/// is fast enough on the example data. The words are plain and never say
/// where the app runs.
fn empty_pick_message(list: &MethodList, host: Option<EnvArch>) -> String {
    let Some(arch) = host else {
        return UNSUPPORTED_PROCESSOR.to_string();
    };
    if list.images.envs.iter().any(|entry| entry.arch == arch) {
        return NO_FAST_EXAMPLE_METHOD.to_string();
    }
    NO_METHODS_FOR_PROCESSOR.to_string()
}

/// Start a fresh example training run + record the creating state.
async fn start_fresh(
    pool: &SqlitePool,
    seams: &ExampleRunSeams,
    owner: Uuid,
    methods: &[String],
) -> Result<ExampleSetResponse, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    // A machine that cannot run methods at all (Windows without WSL 2) gets
    // that reason, not a run that cannot start or a word on environments.
    let runner_missing = seams.executor.runner_unavailable();
    if methods.is_empty() || runner_missing.is_some() {
        // The plan's honest fallback: no fast method that is ready to run
        // can run on the example data — say so, never a fake set, never a
        // half-empty one. When the list has nothing for this kind of
        // processor at all, say THAT: training would fail the same way, so
        // "train your own models" would be wrong advice.
        let error = match &runner_missing {
            Some(reason) => cannot_make_example(reason),
            None => empty_pick_message(&crate::modules::method_list::current(), EnvArch::host()),
        };
        let _ = repo
            .upsert_example_state(&ExampleStateRow {
                state: ExampleSetState::Failed.as_str().to_string(),
                run_id: None,
                set_id: None,
                error: Some(error.clone()),
            })
            .await;
        return Ok(ExampleSetResponse {
            state: ExampleSetState::Failed,
            set_id: None,
            run_id: None,
            run_status: None,
            methods: Vec::new(),
            error: Some(error),
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
    use crate::modules::execution_engine::envmanifest::{EnvArch, ManifestEntry};
    use crate::modules::execution_engine::marker_rank as marker_rank;
    use crate::modules::method_catalogue::types::{MarkerKind, ReasonCode};

    // The shipped list (the built-in method list), as one request reads it.
    fn catalogue() -> &'static Catalogue {
        &crate::modules::method_list::builtin().catalogue
    }
    fn env_for_arch(id: &str, arch: EnvArch) -> Option<&'static ManifestEntry> {
        crate::modules::method_list::builtin().env_for_arch(id, arch)
    }
    fn runtime_env_available(id: &str) -> bool {
        crate::modules::method_list::builtin().has_env(id)
    }

    /// How many times [`EXAMPLE_PICKS`]'s initializer ran in this process.
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
    /// function it calls, with the method's OWN call settings —
    /// [`orchestrator::train_call_bundle_settings`], the same rule the
    /// executor applies — and the method's `min_draws`), and passes the full
    /// bundle preflight (the cross-fit or cohort bundles too). The amd64 pick
    /// is not empty, so this is never vacuous.
    #[test]
    fn every_picked_method_builds_every_run_bundle_on_the_example() {
        let inputs = inputs();
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
            let settings = orchestrator::train_call_bundle_settings(
                &inputs.config,
                inputs.cpus,
                method,
                &inputs.train,
                inputs.predict.as_deref(),
            );
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
                inputs.config.endpoint,
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

    /// The three-marker example's plan is a valid ranking (audit fix 4 makes
    /// the pick's preflight carry it — the same plan a learn run computes), so
    /// a `single` method without a fixed list is now runnable on the ranked
    /// top marker: its preflight passes and the pick may include it. The
    /// count rule still refuses it WITHOUT the plan (the eligibility/
    /// preview no-plan path and any reuse/other caller), pinned here.
    #[test]
    fn a_single_marker_method_without_a_fixed_list_is_rankable_under_the_plan() {
        let inputs = inputs();
        assert_eq!(
            MarkerSelection::all(&inputs.train).mains(),
            ["M1", "M2", "M3"],
            "the example carries three main markers"
        );

        let cat = catalogue();
        let verdicts = eligibility_ignoring_filters(
            cat,
            &EligibilityRequest::Inventory {
                inventory: inputs.validation.inventory.clone(),
            },
        );
        let single_without_list: Vec<String> = verdicts
            .methods
            .iter()
            .filter(|m| amd64_env(&m.id))
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
            "the catalogue has fast single-marker methods without a fixed list (the case \
             under test)"
        );

        // The run's ONE plan: a valid ranking on the example (100 patients,
        // three main markers all measured by the decision day).
        let plan = inputs.marker_plan.as_ref().expect("the example run carries its plan");
        let ranking = plan.result.as_ref().expect("the example ranks");
        assert!(ranking.ranking_patients >= crate::modules::execution_engine::marker_rank::MIN_PATIENTS);
        assert!(ranking.top.len() >= 1, "{ranking:?}");
        for id in &single_without_list {
            let method = cat.method(id).expect("catalogue method");
            // The screens' inventory verdict WITHOUT the plan block still
            // says the count rule (hidden) — the no-plan path is unchanged.
            let verdict = verdicts
                .methods
                .iter()
                .find(|m| &m.id == id)
                .expect("a verdict per catalogue method");
            assert_eq!(verdict.status, EligibilityStatus::CannotRun, "{id}: no-plan → hidden");
            assert!(
                verdict.reasons.iter().any(|r| r.code == ReasonCode::MarkerCountUnmet),
                "{id}: the count rule names the cause: {:?}",
                verdict.reasons
            );
            // The pick's preflight WITHOUT the plan still refuses it with the
            // count rule (today's rule for a caller with no plan).
            let settings = orchestrator::train_call_bundle_settings(
                &inputs.config,
                inputs.cpus,
                method,
                &inputs.train,
                inputs.predict.as_deref(),
            );
            assert_eq!(
                orchestrator::train_bundle_preflight(
                    &inputs.train,
                    inputs.predict.as_deref(),
                    method,
                    inputs.config.endpoint,
                    &settings,
                    method.min_draws,
                ),
                Err(BundleError::MarkerCountUnmet { expected: 1, names: vec!["M1".to_string(), "M2".to_string(), "M3".to_string()] }),
                "{id}: without the plan the count rule still refuses it"
            );
            // WITH the example run's plan, the same preflight passes on the
            // ranked top marker — the pick and the run agree.
            assert!(
                inputs.preflight(method).is_ok(),
                "{id}: under the plan the single method runs on the ranked marker"
            );
            assert_eq!(
                marker_rank::markers_for(MarkerKind::Single, 1, plan),
                vec![ranking.top[0].clone()],
                "{id}: the single method receives the top-ranked marker"
            );
        }

        // The pick may now include these methods (they pass the pick's own
        // preflight); whichever of them is picked runs on the plan's marker,
        // never the whole file.
        let host = pick_fast_methods(&inputs);
        let amd64 = pick_fast_methods_with(&inputs, amd64_env);
        for id in host.iter().chain(amd64.iter()) {
            if single_without_list.contains(id) {
                assert_eq!(
                    marker_rank::markers_for(
                        MarkerKind::Single,
                        1,
                        inputs.marker_plan.as_ref().expect("plan"),
                    ),
                    vec![ranking.top[0].clone()],
                    "{id}: a picked no-list single method runs on the ranked marker"
                );
            }
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
        let amd64 = pick_fast_methods_with(&inputs, amd64_env);
        let id = amd64.first().expect("the amd64 pick is not empty");
        let mut method = catalogue().method(id).expect("catalogue method").clone();
        let settings = orchestrator::train_call_bundle_settings(
            &inputs.config,
            inputs.cpus,
            &method,
            &inputs.train,
            inputs.predict.as_deref(),
        );
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
                inputs.config.endpoint,
                &settings,
                method.min_draws,
            ),
            Err(BundleError::NoTrainingPatient { min_draws: 10_000 }),
            "{id} with an unmet draw minimum"
        );

        // Covariates on over a copy of the example rows whose patients carry
        // no covariate column (the example itself has age/sex/stage).
        let method = catalogue().method(id).expect("catalogue method");
        let covariate_settings = bundle::BundleSettings {
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
                inputs.config.endpoint,
                &covariate_settings,
                method.min_draws,
            ),
            Err(BundleError::CovariatesWithoutColumns),
            "{id} with covariates on and no covariate column"
        );
    }

    /// The example cohort clears the cross-check thresholds — the new
    /// small-cohort refusal ([`BundleError::CrossCheckTooSmall`]) must NOT
    /// silently shrink the example set: every fitted method's bundle refusal
    /// comes from ANOTHER leg, never from the cross-check (a generator change
    /// that shrinks the example fails here instead of silently dropping a
    /// method from the pick).
    #[test]
    fn example_cohort_clears_the_crosscheck_minimum() {
        let inputs = inputs();
        // The strata of the run's displayed outcome (the displayed survival
        // outcome at the run's look-ahead day) over the canonical train side
        // the pick judges: the cohort-level form of the per-fold rule.
        let h = inputs.config.look_ahead_day;
        let (event, beyond) =
            inputs
                .train
                .patients
                .iter()
                .fold((0usize, 0usize), |(e, b), p| {
                    match (p.pfs_days, p.pfs_event) {
                        (Some(t), Some(ev)) if ev == 1 && t <= h => (e + 1, b),
                        (Some(t), Some(_)) if t > h => (e, b + 1),
                        _ => (e, b),
                    }
                });
        let known = event + beyond;
        assert!(
            known >= bundle::CROSSCHECK_MIN_PATIENTS,
            "the example keeps only {known} known labels — below \
             CROSSCHECK_MIN_PATIENTS = {}",
            bundle::CROSSCHECK_MIN_PATIENTS
        );
        assert!(
            event >= bundle::CROSSCHECK_MIN_PER_CLASS && beyond >= bundle::CROSSCHECK_MIN_PER_CLASS,
            "the example's classes are {event}/{beyond} — each must be >= \
             CROSSCHECK_MIN_PER_CLASS = {}",
            bundle::CROSSCHECK_MIN_PER_CLASS
        );
        // And, exactly: no fitted method's bundle preflight on the example is
        // refused by the cross-check (a different leg — the marker rule, say —
        // may still refuse it).
        for method in &catalogue().methods {
            if method.fitted {
                if let Err(e) = inputs.preflight(method) {
                    assert_ne!(
                        e.code(),
                        "BUNDLE_CROSSCHECK_TOO_SMALL",
                        "{}: the cross-check must not refuse an example method",
                        method.id
                    );
                }
            }
        }
    }

    /// Bug 2's example half: the pick applies the run's per-method covariates
    /// rule, so a `none`-mode method is never refused by the example preflight
    /// just because the run's covariates checkbox is ON. With the checkbox ON
    /// and a patients table WITHOUT a cov_* column (the case the run-wide
    /// settings refused with `BUNDLE_COVARIATES_MISSING`), a searched
    /// `none`-mode method the pick would run still passes `preflight` —
    /// while a `required`-mode method on the same table is refused, exactly as
    /// the run would refuse it.
    #[test]
    fn a_none_mode_method_is_not_refused_by_the_example_preflight_with_covariates_on() {
        use crate::modules::method_catalogue::types::CovariateMode;

        // The run's covariates checkbox ON (the bug-2 example inputs carry the
        // run's default checkbox OFF; turning it on is the case that split the
        // old run-wide settings from the per-method rule).
        let mut request = example_run_request(&[]);
        request.config.covariates = true;
        let inputs = run_inputs_of(crate::modules::method_list::builtin(), request)
            .expect("the covariates-on example canonicalizes");
        assert!(
            inputs.train.patients.iter().any(|p| !p.covariates.is_empty()),
            "the example patients carry the cov_* columns"
        );

        // A `none`-mode method the example preflight accepts (the marker rule
        // and draw minimum hold) — the run would run it.
        let none = catalogue()
            .methods
            .iter()
            .find(|m| {
                m.covariates == CovariateMode::None
                    && m.saves_model
                    && inputs.preflight(m).is_ok()
            })
            .expect("the catalogue has a none-mode method the example preflight accepts");
        let none_id = none.id.clone();

        // Strip the cov_* columns: the per-method rule keeps the method's
        // call settings covariates OFF, so the example preflight still
        // accepts it — the run-wide-flag era refused it
        // `BUNDLE_COVARIATES_MISSING` here.
        let mut bare = (*inputs.train).clone();
        for patient in &mut bare.patients {
            patient.covariates.clear();
        }
        let bare_inputs = ExampleRunInputs {
            train: Arc::new(bare),
            ..inputs
        };
        let none = catalogue().method(&none_id).expect("the catalogue method");
        assert!(
            bare_inputs.preflight(none).is_ok(),
            "{none_id}: a none-mode method is not refused with covariates on"
        );

        // The run-wide base settings WOULD have refused it — the exact
        // verdict the fix removes from the pick (the same base settings the
        // per-method derivation starts from, covariates forced on; the run's
        // marker plan is carried, so the ONLY difference from the preflight
        // is the covariates flag, not the marker rule).
        let run_wide = bundle::BundleSettings {
            covariates: true,
            marker_plan: bare_inputs.marker_plan.clone(),
            ..orchestrator::train_call_bundle_settings(
                &bare_inputs.config,
                bare_inputs.cpus,
                none,
                &bare_inputs.train,
                bare_inputs.predict.as_deref(),
            )
        };
        assert_eq!(
            orchestrator::train_bundle_preflight(
                &bare_inputs.train,
                bare_inputs.predict.as_deref(),
                none,
                bare_inputs.config.endpoint,
                &run_wide,
                none.min_draws,
            ),
            Err(BundleError::CovariatesWithoutColumns),
            "{none_id}: the run-wide covariates flag refused it"
        );

        // The per-method rule still refuses what the run would refuse: a
        // required-mode method on the same bare table (the marker rule first —
        // a required method the run could run at all).
        let required = catalogue()
            .methods
            .iter()
            .find(|m| {
                m.covariates == CovariateMode::Required
                    && m.saves_model
                    && bundle::method_marker_set(
                        &bare_inputs.train,
                        &m.markers,
                        m.required_markers.as_ref(),
                    )
                    .is_ok()
            })
            .expect("the catalogue has a required-mode method the marker rule accepts");
        assert_eq!(
            bare_inputs.preflight(required),
            Err(BundleError::CovariatesWithoutColumns),
            "{}: a required-mode method is refused on the same table",
            required.id
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
        let run = orchestrator::canonicalize_run(crate::modules::method_list::builtin(), &request.input, &request.config, request.mode)
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
        let from_inputs = match run_inputs_of(crate::modules::method_list::builtin(), request.clone()) {
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
        assert!(validation_of(&real).is_ok() && run_inputs_of(crate::modules::method_list::builtin(), real).is_ok());
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

    /// Poll `caller` until `started` holds, then drop it: the caller goes
    /// away while its computation runs.
    async fn drop_once_started<F: std::future::Future>(caller: F, started: impl Fn() -> bool) {
        let mut caller = std::pin::pin!(caller);
        tokio::select! {
            _ = &mut caller => panic!("the computation finished before it was released"),
            _ = until(started) => {}
        }
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
        let first = SHARED.get(move || {
            SHARED_RUNS.fetch_add(1, Ordering::SeqCst);
            wait.recv().expect("released");
            Ok(vec!["m".to_string()])
        });
        drop_once_started(first, || SHARED_RUNS.load(Ordering::SeqCst) == 1).await;
        let second = SHARED.get(|| {
            SHARED_RUNS.fetch_add(1, Ordering::SeqCst);
            Ok(vec!["a second computation".to_string()])
        });
        // `join!` polls the second caller first, so it is waiting on the
        // running computation before that is released.
        let (picked, ()) = tokio::join!(second, async {
            tokio::task::yield_now().await;
            release.send(()).expect("the computation waits");
        });
        assert_eq!(picked.expect("picked"), ["m"]);
        assert_eq!(SHARED_RUNS.load(Ordering::SeqCst), 1, "one computation");

        // No caller left: the outcome still reaches the cache.
        static ALONE: PickCache = PickCache::new();
        static ALONE_RUNS: AtomicUsize = AtomicUsize::new(0);
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let first = ALONE.get(move || {
            ALONE_RUNS.fetch_add(1, Ordering::SeqCst);
            wait.recv().expect("released");
            Ok(vec!["m".to_string()])
        });
        drop_once_started(first, || ALONE_RUNS.load(Ordering::SeqCst) == 1).await;
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
    /// The marker plan is recomputed over the cut train side (the same
    /// plan_for a learn run would compute on those rows).
    fn cut_inputs(full: &ExampleRunInputs, n: usize) -> ExampleRunInputs {
        let train = first_patients(&full.train, n);
        let marker_plan = Some(crate::modules::execution_engine::marker_rank::plan_for(
            &train,
            full.config.endpoint,
            full.config.decision_day,
            crate::modules::file_validator::types::DEFAULT_BASELINE_MAX_DAY,
            full.config
                .single_marker
                .clone()
                .unwrap_or(crate::modules::execution_engine::marker_rank::SingleMarkerChoice::Ranked),
        ));
        ExampleRunInputs {
            validation: full.validation.clone(),
            train: Arc::new(train),
            predict: full.predict.clone(),
            config: full.config.clone(),
            marker_plan,
            cpus: full.cpus,
        }
    }

    /// A REAL catalogue method the bundle stage refuses on a cut cohort
    /// (brief 3: the cross-check now also covers a fixed-rule method WITH a
    /// conversion need, so no synthetic `fitted` mark is needed): for each
    /// cohort size (ascending, stopping at the first that gives the case), a
    /// fast candidate that is picked on the FULL example — one eligibility
    /// run, since the cut leaves the inventory unchanged — whose marker set
    /// and first train/test bundles build on the cut but whose bundle
    /// preflight is refused [`BundleError::CrossCheckTooSmall`] (the cohort
    /// is below [`CROSSCHECK_MIN_PATIENTS`], so some fold's training part
    /// cannot support the stratified fit — the refusal the user's rule puts
    /// before the first call). Returns the cut inputs and the method.
    fn crossfit_refused_case(full: &ExampleRunInputs) -> Option<(ExampleRunInputs, Method)> {
        let refused = Err(BundleError::CrossCheckTooSmall {
            needed_patients: bundle::MIN_TRAINING_PATIENTS,
            needed_per_class: bundle::CROSSCHECK_FOLD_MIN_PER_CLASS,
        });
        let runnable = runnable_methods(catalogue(), full, amd64_env);
        let picked_full = pick_fast_methods_with(full, amd64_env);
        (bundle::MIN_TRAINING_PATIENTS..bundle::CROSSCHECK_MIN_PATIENTS).find_map(|n| {
            let cut = cut_inputs(full, n);
            let target = rank_fast(&runnable, cut.patients())
                .into_iter()
                .filter(|(_, m)| picked_full.contains(&m.id))
                .find_map(|(_, m)| {
                    let settings = orchestrator::train_call_bundle_settings(
                        &cut.config,
                        cut.cpus,
                        m,
                        &cut.train,
                        cut.predict.as_deref(),
                    );
                    let first_bundles = orchestrator::method_bundles(
                        &cut.train,
                        cut.predict.as_deref(),
                        m,
                        &settings,
                        m.min_draws,
                    );
                    (first_bundles.is_ok() && cut.preflight(m) == refused).then_some(m)
                })?;
            Some((cut, target.clone()))
        })
    }

    /// A method the bundle stage refuses is not picked, even when it passes
    /// every other filter including the marker rule and its first train/test
    /// bundles ([`orchestrator::method_bundles`]). On the real catalogue and
    /// the real example no method is refused past the marker rule, so the
    /// case is built and searched for ([`crossfit_refused_case`]): the rows
    /// are cut to a cohort the full-cohort train bundle learns from but that
    /// is too small to cross-check, and a picked method whose shown chances
    /// need the cross-check gets `BUNDLE_CROSSCHECK_TOO_SMALL` before its
    /// first container call (brief 3: that now includes a fixed-rule method
    /// WITH a conversion need — the pick skips it as it skips a fitted one).
    /// The method leaves the pick on the cut rows while staying picked on
    /// the full example rows.
    #[test]
    fn a_method_the_bundle_stage_refuses_is_not_picked() {
        let full = inputs();
        let (cut, method) = crossfit_refused_case(&full)
            .expect("a picked method the cross-check refuses on the cut");
        let target = method.id.clone();

        // Every other filter keeps it.
        let verdicts = eligibility_ignoring_filters(
            catalogue(),
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
        assert!(amd64_env(&target) && method.saves_model, "{target}");
        assert!(
            estimate_seconds_for(&method, cut.patients(), REFERENCE_CPUS)
                < EXAMPLE_METHOD_SECONDS_MAX,
            "{target} stays under the time budget"
        );
        assert!(
            bundle::method_marker_set(
                &cut.train,
                &method.markers,
                method.required_markers.as_ref()
            )
            .is_ok(),
            "{target}: the marker rule accepts it"
        );

        // The bundle stage refuses it, so the pick leaves it out.
        assert_eq!(
            cut.preflight(&method),
            Err(BundleError::CrossCheckTooSmall {
                needed_patients: bundle::MIN_TRAINING_PATIENTS,
                needed_per_class: bundle::CROSSCHECK_FOLD_MIN_PER_CLASS,
            }),
            "{target}: the cut cohort is too small to cross-check"
        );
        assert!(
            pick_fast_methods_with(&full, amd64_env).contains(&target),
            "{target} is picked on the full example rows"
        );
        let picked = pick_from(catalogue(), &cut, amd64_env);
        assert!(
            !picked.contains(&target),
            "{target} is refused, not picked: {picked:?}"
        );
    }

    /// Round 2 (review fix 1's example half): the example's DEFAULT config
    /// has the Extra inputs switch OFF, so a method whose catalogue
    /// covariates requirement is `required` is dropped by the pick through
    /// the preflight (`BUNDLE_COVARIATES_OFF` — it would only have failed
    /// inside the example run, before anything is written). The same method
    /// with its shipped mode is still picked.
    #[test]
    fn a_required_method_is_dropped_on_the_switch_off_example() {
        use crate::modules::method_catalogue::types::CovariateMode;

        let inputs = inputs();
        let picked = pick_fast_methods_with(&inputs, amd64_env);
        let base = picked.first().expect("the amd64 pick is not empty");
        let method = catalogue().method(base).expect("a catalogue method");
        assert_ne!(
            method.covariates,
            CovariateMode::Required,
            "the picked base method is not already required-mode"
        );

        let mut required = method.clone();
        required.covariates = CovariateMode::Required;
        assert_eq!(
            inputs.preflight(&required),
            Err(BundleError::CovariatesSwitchedOff),
            "{base} marked required: the example preflight drops it (Extra inputs off)"
        );

        let mut cat = catalogue().clone();
        *cat.methods
            .iter_mut()
            .find(|m| m.id == *base)
            .expect("the picked method is in the catalogue") = required;
        let with_required = pick_from(&cat, &inputs, amd64_env);
        assert!(
            !with_required.contains(base),
            "{base}: required on the switch-off example is not picked: {with_required:?}"
        );
        for id in picked.iter().filter(|id| *id != base) {
            assert!(
                with_required.contains(id),
                "{id} is still picked: {with_required:?}"
            );
        }
    }

    /// FU 123: an empty pick on a list with no method image for this kind of
    /// processor says so, in plain words that never say where the app runs,
    /// and never suggests training instead.
    #[test]
    fn empty_pick_message_says_the_list_has_nothing_for_the_processor() {
        let mut amd_only = crate::modules::method_list::builtin().clone();
        amd_only.images.envs.retain(|entry| entry.arch == EnvArch::Amd64);
        assert!(!amd_only.images.envs.is_empty(), "the built-in list carries Intel/AMD images");

        let on_arm = empty_pick_message(&amd_only, Some(EnvArch::Arm64));
        assert_eq!(
            on_arm,
            "Example models cannot be made: the method list has no methods for this kind of processor yet."
        );
        assert!(!on_arm.contains("train your own models"), "{on_arm}");

        // The other way round: a list with Apple-chip images only, on an
        // Intel/AMD processor; and a list with no image at all.
        let mut arm_only = amd_only.clone();
        for entry in &mut arm_only.images.envs {
            entry.arch = EnvArch::Arm64;
        }
        assert_eq!(empty_pick_message(&arm_only, Some(EnvArch::Amd64)), on_arm);
        let mut none = amd_only.clone();
        none.images.envs.clear();
        assert_eq!(empty_pick_message(&none, Some(EnvArch::Amd64)), on_arm);

        // A processor the app does not support.
        let unsupported = empty_pick_message(&amd_only, None);
        assert_eq!(
            unsupported,
            "Example models cannot be made: the app does not support this kind of processor."
        );
        assert!(!unsupported.contains("train your own models"), "{unsupported}");

        // No server text for this error says where the app runs or uses the
        // chip-type and environment jargon (U47, U44).
        for text in [
            &on_arm,
            &unsupported,
            &NO_FAST_EXAMPLE_METHOD.to_string(),
            &cannot_make_example("the part of the app that runs methods did not start"),
        ] {
            let lower = text.to_lowercase();
            for banned in [
                "this computer", "your computer", "this machine", "this mac", "chip type",
                "published environment", "method images", "offline", "stays on",
            ] {
                assert!(!lower.contains(banned), "{banned:?} in {text}");
            }
        }
    }

    #[test]
    fn the_runner_reason_becomes_one_plain_sentence() {
        assert_eq!(
            cannot_make_example("bubblewrap is not installed"),
            "Example models cannot be made: bubblewrap is not installed."
        );
        assert_eq!(
            cannot_make_example("install WSL 2 first. "),
            "Example models cannot be made: install WSL 2 first.",
            "no doubled full stop"
        );
    }

    /// FU 123: when the list has images for this processor, an empty pick
    /// keeps the old meaning (no fast method fits the example data).
    #[test]
    fn empty_pick_message_keeps_the_no_fast_method_text_when_the_chip_has_images() {
        let mut amd_only = crate::modules::method_list::builtin().clone();
        amd_only.images.envs.retain(|entry| entry.arch == EnvArch::Amd64);
        assert_eq!(empty_pick_message(&amd_only, Some(EnvArch::Amd64)), NO_FAST_EXAMPLE_METHOD);
        assert!(NO_FAST_EXAMPLE_METHOD.contains("Train your own models instead"));
    }
}
