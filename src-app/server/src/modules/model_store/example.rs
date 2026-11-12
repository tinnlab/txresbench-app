//! The example saved set (qa-fixes3 ITEM-3) — `POST /api/txr/models/example`.
//!
//! The saved-model path of the flow ("Use a model I saved") needs an example
//! model set WITHOUT the user training anything first. This module creates
//! and remembers it:
//!
//! 1. The METHODS are chosen deterministically from the real catalogue
//!    ([`pick_fast_methods`]): the host-arch methods with a published
//!    environment (`runtime_env_available`), `saves_model`, a `CanRun`
//!    verdict on the example training data's own inventory, a marker set
//!    the run's bundle builder accepts on the example's canonical rows
//!    (the engine's own [`bundle::method_marker_set`] — the example carries
//!    three main markers, so a `single` method without a fixed marker list
//!    would be refused `BUNDLE_MARKER_COUNT_UNMET` before it starts), and a
//!    catalogue estimate under 30 s (the plan's "3 that run in under 30 s
//!    each"); fastest-first, id tie-break, capped at 3. The pick is a PURE
//!    function of the embedded catalogue + the embedded example — no
//!    calibration, no host-CPU dependence, so every machine's first call
//!    trains the same methods.
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
//! seeded bytes; the assets are `include_bytes!`), the method pick is a pure
//! function of those bytes, and the run's seed is the engine's single fixed
//! contract seed — so a recreated set trains the same methods on the same
//! data. What differs per machine is only the environment contents the run
//! downloads (the digest-pinned published layers).

use std::sync::Arc;

use axum::http::StatusCode;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::AppError;

use crate::modules::execution_engine::bundle;
use crate::modules::execution_engine::orchestrator::{self, EnvProvider, MethodExecutor};
use crate::modules::execution_engine::runtime::RunRuntime;
use crate::modules::execution_engine::types::{
    CreateRunRequest, RunConfig, TxrRunInput, TxrRunMode, TxrRunStatus,
};
use crate::modules::file_validator::types::{
    CanonicalBundle, ParsedTable, ParsedTableSource, TableFormat, ValidationMode, ValidationRequest,
};
use crate::modules::file_validator::{assets, canonical_bundle, validate};
use crate::modules::method_catalogue::catalogue::catalogue;
use crate::modules::method_catalogue::eligibility::{
    eligibility_for, estimate_seconds_for, runtime_env_available, REFERENCE_CPUS,
};
use crate::modules::method_catalogue::types::{EligibilityRequest, EligibilityStatus};
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

/// The deterministic fast-method pick (pure; the test seam of the real
/// catalogue). The verdicts are the PURE eligibility engine over the example
/// validation's inventory; the runtime-env + saves_model filters implement
/// the plan's "methods that have a published environment"; the marker filter
/// is the run's own per-method marker rule ([`bundle::method_marker_set`])
/// over the example's canonical rows (`train` — the same bundle the run
/// builds from the same request), so a picked method is never refused
/// `BUNDLE_MARKER_COUNT_UNMET`/`BUNDLE_NO_MAIN_MARKER` before it starts; the
/// estimate is the catalogue's (`REFERENCE_CPUS` — host-independent).
pub fn pick_fast_methods(
    inventory: &crate::modules::method_catalogue::types::InventoryEligibilityRequest,
    patients: u32,
    train: &CanonicalBundle,
) -> Vec<String> {
    pick_fast_methods_with(inventory, patients, train, runtime_env_available)
}

/// [`pick_fast_methods`] with the published-environment predicate injected
/// (production passes the host-arch [`runtime_env_available`]; the unit
/// tests pass a fixed arch so the pick is checked on any host).
fn pick_fast_methods_with(
    inventory: &crate::modules::method_catalogue::types::InventoryEligibilityRequest,
    patients: u32,
    train: &CanonicalBundle,
    env_available: impl Fn(&str) -> bool,
) -> Vec<String> {
    let cat = catalogue();
    let verdicts = eligibility_for(
        cat,
        &EligibilityRequest::Inventory {
            inventory: inventory.clone(),
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
            // The run's own marker rule on the example rows: a method whose
            // marker set does not resolve would fail before it starts.
            if bundle::method_marker_set(train, &method.markers, method.required_markers.as_ref())
                .is_err()
            {
                return None;
            }
            let seconds = estimate_seconds_for(method, patients, REFERENCE_CPUS);
            (seconds < EXAMPLE_METHOD_SECONDS_MAX).then_some((seconds, m.id))
        })
        .collect();
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    candidates
        .into_iter()
        .take(EXAMPLE_METHOD_CAP)
        .map(|(_, id)| id)
        .collect()
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

/// The example training pair as the validator's request (Files mode, no
/// joins/mapping, the default parameters) — the ONE request both the
/// validation and the canonical rows are built from.
fn example_validation_request() -> ValidationRequest {
    ValidationRequest {
        mode: ValidationMode::Files,
        patients: Some(parsed_example(
            assets::ASSETS.patients_example,
            EXAMPLE_PATIENTS_NAME,
        )),
        measurements: parsed_example(
            assets::ASSETS.measurements_example,
            EXAMPLE_MEASUREMENTS_NAME,
        ),
        joins: Vec::new(),
        mapping: Vec::new(),
        parameters: Default::default(),
    }
}

/// The example training pair + the validator's verdict (the ONE validation
/// the endpoint pins: zero errors and at most the normal A04 notes, asserted
/// here and in the material test — a generator change that breaks the example
/// fails before any endpoint serves it).
pub fn example_validation() -> Result<crate::modules::file_validator::types::ValidationResponse, AppError> {
    let request = example_validation_request();
    let response = validate(&request).map_err(|e| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXAMPLE_VALIDATION_FAILED",
            format!("the embedded example data does not validate: {e}"),
        )
    })?;
    let errors: Vec<_> = response
        .problems
        .iter()
        .filter(|p| p.severity == crate::modules::file_validator::types::ProblemSeverity::Error)
        .collect();
    if !errors.is_empty() {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXAMPLE_VALIDATION_FAILED",
            format!(
                "the embedded example data carries {} error(s): {:?}",
                errors.len(),
                errors
                    .iter()
                    .map(|p| format!("{}: {}", p.code.code(), p.message))
                    .collect::<Vec<_>>()
            ),
        ));
    }
    Ok(response)
}

/// The example training pair's canonical rows — the train-side bundle the
/// run builds from the same tables (`canonical_bundle` over the same
/// Files-mode request: no joins, no mapping; the canonical rows do not
/// depend on the decision day), the input of the pick's marker rule.
pub fn example_canonical_bundle() -> Result<CanonicalBundle, AppError> {
    canonical_bundle(&example_validation_request()).map_err(|e| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXAMPLE_VALIDATION_FAILED",
            format!("the embedded example data does not build its canonical rows: {e}"),
        )
    })
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

    // The inventory + the fast-method pick (pure; recomputed per call — the
    // catalogue and the assets are immutable).
    let validation = example_validation()?;
    let patients = validation.patients.as_ref().map(|p| p.rows).unwrap_or(0);
    let train = example_canonical_bundle()?;
    let methods = pick_fast_methods(&validation.inventory, patients, &train);

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
// Tests — the pick applies the run's own marker rule
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::bundle::{BundleError, MarkerSelection};
    use crate::modules::execution_engine::envmanifest::{env_for_arch, EnvArch};
    use crate::modules::method_catalogue::types::{InventoryEligibilityRequest, MarkerKind};

    /// The pick's inputs, exactly as [`inner`] computes them.
    fn example_inputs() -> (InventoryEligibilityRequest, u32, CanonicalBundle) {
        let validation = example_validation().expect("the example validates");
        let patients = validation.patients.as_ref().map(|p| p.rows).unwrap_or(0);
        let train = example_canonical_bundle().expect("the example builds its canonical rows");
        (validation.inventory, patients, train)
    }

    /// The committed manifest's amd64 env set (the published arch), so the
    /// pick is exercised on every host, not only where the host arch has
    /// published environments.
    fn amd64_env(id: &str) -> bool {
        env_for_arch(id, EnvArch::Amd64).is_some()
    }

    /// Every method the pick returns — on the host arch and on the committed
    /// amd64 env set — gets a marker set from the run's own rule
    /// ([`bundle::method_marker_set`], the call `execute_train` makes first)
    /// on the example's canonical rows; the amd64 pick is not empty, so the
    /// assertion is never vacuous.
    #[test]
    fn every_picked_method_passes_the_run_marker_rule_on_the_example() {
        let (inventory, patients, train) = example_inputs();
        let host = pick_fast_methods(&inventory, patients, &train);
        let amd64 = pick_fast_methods_with(&inventory, patients, &train, amd64_env);
        assert!(
            !amd64.is_empty(),
            "the committed amd64 env set yields at least one example method"
        );
        assert!(amd64.len() <= EXAMPLE_METHOD_CAP, "{amd64:?}");
        assert_eq!(
            amd64,
            pick_fast_methods_with(&inventory, patients, &train, amd64_env),
            "the pick is deterministic"
        );
        let cat = catalogue();
        for id in host.iter().chain(amd64.iter()) {
            let method = cat.method(id).expect("a picked id is a catalogue method");
            let selection = bundle::method_marker_set(
                &train,
                &method.markers,
                method.required_markers.as_ref(),
            )
            .unwrap_or_else(|e| panic!("{id} is refused by the run's marker rule: {e}"));
            assert!(!selection.mains().is_empty(), "{id} receives a marker");
        }
    }

    /// The three-marker example refuses every `single` method without a fixed
    /// marker list (`BUNDLE_MARKER_COUNT_UNMET`), so none is picked — even
    /// though eligibility says `CanRun` for them and they otherwise pass the
    /// pick's filters (the methods the pick used to return).
    #[test]
    fn a_single_marker_method_without_a_fixed_list_is_not_picked_on_the_three_marker_example() {
        let (inventory, patients, train) = example_inputs();
        assert_eq!(
            MarkerSelection::all(&train).mains(),
            ["M1", "M2", "M3"],
            "the example carries three main markers"
        );

        let cat = catalogue();
        let verdicts = eligibility_for(
            cat,
            &EligibilityRequest::Inventory {
                inventory: inventory.clone(),
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
                    && estimate_seconds_for(m, patients, REFERENCE_CPUS)
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
            match bundle::method_marker_set(&train, &method.markers, None) {
                Err(BundleError::MarkerCountUnmet { expected: 1, names }) => {
                    assert_eq!(names, ["M1", "M2", "M3"], "{id}");
                }
                other => panic!("{id}: expected BUNDLE_MARKER_COUNT_UNMET, got {other:?}"),
            }
        }

        let host = pick_fast_methods(&inventory, patients, &train);
        let amd64 = pick_fast_methods_with(&inventory, patients, &train, amd64_env);
        for id in host.iter().chain(amd64.iter()) {
            assert!(
                !single_without_list.contains(id),
                "{id} is a single-marker method without a fixed list — the run refuses it"
            );
        }
    }
}
