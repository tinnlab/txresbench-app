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

use std::sync::{Arc, LazyLock};

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
}

impl ExampleRunInputs {
    /// The example's training patient count (the estimate's `patients`).
    pub fn patients(&self) -> u32 {
        self.validation
            .patients
            .as_ref()
            .map(|p| p.rows)
            .unwrap_or(0)
    }

    /// The bundle settings the run's method calls build with
    /// ([`orchestrator::method_bundle_settings`] over the run config and the
    /// CPU count the run detects at start).
    pub(crate) fn bundle_settings(&self) -> BundleSettings {
        orchestrator::method_bundle_settings(&self.config, detect_cpus())
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
            &self.bundle_settings(),
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

/// Canonicalize the example run's request through the run's own pass
/// ([`orchestrator::canonicalize_run`]), checked by [`error_free`].
pub fn example_run_inputs() -> Result<ExampleRunInputs, AppError> {
    let request = example_run_request(&[]);
    let canonical = orchestrator::canonicalize_run(&request.input, &request.config, request.mode)
        .map_err(not_valid)?;
    let validation = error_free(canonical.validated)?;
    let train = canonical
        .train
        .ok_or_else(|| validation_failed("the example run carries no training side"))?;
    Ok(ExampleRunInputs {
        validation,
        train,
        predict: canonical.predict,
        config: request.config,
    })
}

/// The example training pair + the validator's verdict: the run's own
/// validation of [`example_run_request`]'s tables
/// ([`orchestrator::validate_run`], the first step of the run's pass),
/// without building the canonical sides.
pub fn example_validation() -> Result<ValidationResponse, AppError> {
    let request = example_run_request(&[]);
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
    let patients = inputs.patients();
    let verdicts = eligibility_for(
        cat,
        &EligibilityRequest::Inventory {
            inventory: inputs.validation.inventory.clone(),
        },
    );
    let mut candidates: Vec<(f64, String)> = verdicts
        .methods
        .into_iter()
        .filter(|m| m.status == EligibilityStatus::CanRun)
        .filter(|m| env_available(&m.id))
        .filter_map(|m| {
            let method = cat
                .method(&m.id)
                .expect("every verdict id is a catalogue method");
            if !method.saves_model {
                return None;
            }
            let seconds = estimate_seconds_for(method, patients, REFERENCE_CPUS);
            if seconds >= EXAMPLE_METHOD_SECONDS_MAX {
                return None;
            }
            // The run's own bundle stage on the example rows: a method it
            // would refuse fails before (or between) its calls.
            inputs.preflight(method).ok()?;
            Some((seconds, m.id))
        })
        .collect();
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    candidates
        .into_iter()
        .take(EXAMPLE_METHOD_CAP)
        .map(|(_, id)| id)
        .collect()
}

/// The pick, computed once per process. Every input is fixed for the
/// process lifetime: the embedded example bytes, the embedded catalogue, the
/// env manifest (itself loaded once, `envmanifest::MANIFEST`) and the host
/// arch (a compile-time constant) — so the cached list is the list a fresh
/// computation returns, and the endpoint's polls (every 1.5 s while the set
/// trains) never re-parse the example or re-run eligibility under
/// [`ENSURE_LOCK`]. An example that does not validate is kept as its
/// `(status, code, message)` and answered as the same error on every call.
static EXAMPLE_PICK: LazyLock<Result<Vec<String>, (u16, String, String)>> = LazyLock::new(|| {
    #[cfg(test)]
    tests::PICK_COMPUTATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    example_run_inputs()
        .map(|inputs| pick_fast_methods(&inputs))
        .map_err(|e| (e.status_code(), e.error_code().to_string(), e.to_string()))
});

/// The example's method pick ([`EXAMPLE_PICK`]).
pub fn example_methods() -> Result<Vec<String>, AppError> {
    EXAMPLE_PICK.clone().map_err(|(status, code, message)| {
        AppError::new(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            code,
            message,
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

    // The fast-method pick (computed once per process — the catalogue, the
    // assets and the env manifest are immutable).
    let methods = example_methods()?;

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
        let settings = inputs.bundle_settings();
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
        let settings = inputs.bundle_settings();
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
        let settings = inputs.bundle_settings();
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

    /// The cached pick is the pick of a fresh computation on this host, and
    /// it is computed once: however many calls (the endpoint's polls) read
    /// it, the initializer ran one time in this process.
    #[test]
    fn the_cached_pick_is_computed_once_and_equals_a_fresh_pick() {
        let cached = example_methods().expect("the example validates");
        for _ in 0..20 {
            assert_eq!(example_methods().expect("again"), cached);
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

    /// A method the bundle stage refuses is not picked, even when it passes
    /// every other filter including the marker rule and its first train/test
    /// bundles ([`orchestrator::method_bundles`]). On the real catalogue and
    /// the real example no method is refused past the marker rule, so the
    /// case is built: the training rows are cut to 12 patients (enough for
    /// the full-cohort train bundle, too few for a cross-fit fold's rest
    /// set), and the first amd64 pick is marked `fitted` in a copy of the
    /// catalogue, so its call would build the cross-fit bundles and be
    /// refused `BUNDLE_NO_LEARNABLE_OUTCOME` between its calls. That method
    /// leaves the pick; unmodified, it stays in.
    #[test]
    fn a_method_the_bundle_stage_refuses_is_not_picked() {
        let full = inputs();
        let settings = full.bundle_settings();
        let target = pick_fast_methods_with(&full, amd64_env)
            .into_iter()
            .next()
            .expect("the amd64 pick is not empty");

        let cut = ExampleRunInputs {
            validation: full.validation.clone(),
            train: Arc::new(first_patients(&full.train, 12)),
            predict: full.predict.clone(),
            config: full.config.clone(),
        };
        let mut cat = catalogue().clone();
        let entry = cat
            .methods
            .iter_mut()
            .find(|m| m.id == target)
            .expect("the picked method is in the catalogue");
        assert!(
            !entry.fitted,
            "{target}: the case needs a method that is not fitted yet"
        );
        entry.fitted = true;
        let fitted = cat.method(&target).expect("the modified method").clone();

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
            estimate_seconds_for(&fitted, cut.patients(), REFERENCE_CPUS)
                < EXAMPLE_METHOD_SECONDS_MAX,
            "{target} stays under the time budget"
        );
        assert!(
            orchestrator::method_bundles(
                &cut.train,
                cut.predict.as_deref(),
                &fitted,
                &settings,
                fitted.min_draws
            )
            .is_ok(),
            "{target}: the marker set and the first train/test bundles build"
        );

        // The bundle stage refuses it, so the pick leaves it out.
        assert_eq!(
            orchestrator::train_bundle_preflight(
                &cut.train,
                cut.predict.as_deref(),
                &fitted,
                &settings,
                fitted.min_draws,
            ),
            Err(BundleError::NoLearnableOutcome {
                min: bundle::MIN_TRAINING_PATIENTS
            }),
            "{target}: a cross-fit fold's rest set learns no outcome"
        );
        let picked = pick_from(&cat, &cut, amd64_env);
        assert!(
            !picked.contains(&target),
            "{target} is refused, not picked: {picked:?}"
        );
        assert!(!picked.is_empty(), "the other candidates are still picked");

        // Control: the same rows with the unmodified catalogue keep it.
        assert!(
            pick_from(catalogue(), &cut, amd64_env).contains(&target),
            "{target} is picked when its call builds no cross-fit bundles"
        );
    }
}
