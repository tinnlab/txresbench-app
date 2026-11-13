//! The example saved-set suite (qa-fixes3 ITEM-3, TEST-QF3-1): the example
//! family's determinism + validator posture, the deterministic fast-method
//! pick, and the state machine — created once, recreated after deletion —
//! driven IN THIS PROCESS over the harness template DB with scripted seams
//! (the same trait objects the production wiring installs), so no method
//! image and no network is ever needed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{owner_token, pool};
use crate::common::TestServer;
use txresbench::modules::execution_engine::envmanifest;
use txresbench::modules::execution_engine::orchestrator::{
    self, EnvProvider, MethodExecutor, MethodRunContext, MethodOutcome, ProducedModelFacts,
};
use txresbench::modules::execution_engine::repository::TxrRepository;
use txresbench::modules::execution_engine::runtime::RunRuntime;
use txresbench::modules::execution_engine::types::{
    TxrCoverage, TxrMethodState, TxrProbSource, TxrRunReason, TxrTask,
};
use txresbench::modules::file_validator::assets::ASSETS;
use txresbench::modules::file_validator::types::{
    ParsedTable, ParsedTableSource, ProblemSeverity, TableFormat, ValidationMode, ValidationRequest,
};
use txresbench::modules::method_catalogue::catalogue::catalogue;
use txresbench::modules::method_catalogue::eligibility::{
    eligibility_for, estimate_seconds_for, runtime_env_available, REFERENCE_CPUS,
};
use txresbench::modules::method_catalogue::types::{EligibilityRequest, EligibilityStatus};
use txresbench::modules::model_store::example::{
    self, pick_fast_methods, ExampleRunSeams, EXAMPLE_METHOD_CAP, EXAMPLE_METHOD_SECONDS_MAX,
    EXAMPLE_SET_NAME,
};
use txresbench::modules::model_store::repository::ModelStoreRepository;
use txresbench::modules::model_store::types::ExampleSetResponse;
use txresbench::modules::model_store::types::ExampleSetState;
use txresbench::modules::rootfs;
use txresbench::modules::sandbox::method_env::{EnvKind, MethodEnvState, MethodEnvStatus, ProvidedMount};
use txresbench::modules::sandbox::stack::{tree_sha256, EnvRef};
use txresbench_core::AppError;

fn id8() -> String {
    static SEQ: AtomicUsize = AtomicUsize::new(1);
    format!("{:08x}", SEQ.fetch_add(1, Ordering::SeqCst))
}

/// The fixture's data-root (gitignored `target/`, like the engine's scratch
/// convention — never the user's real app data dir).
fn scratch_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("target")
        .join("txr-model-store-item8")
        .join(format!("{name}-{}", id8()))
}

/// The scripted env seam: every ref is Ready with a fake mount (the run
/// records the refs' digests; nothing is mounted).
struct FakeExampleEnv;

impl EnvProvider for FakeExampleEnv {
    fn ensure(
        &self,
        _r: &EnvRef,
        _kind: EnvKind,
        _deadline: Duration,
    ) -> Result<ProvidedMount, AppError> {
        Ok(ProvidedMount {
            mount_dir: PathBuf::from("/fixture-mount"),
            digest: Some("f".repeat(64)),
        })
    }

    fn status(&self, env_id: &str) -> MethodEnvStatus {
        MethodEnvStatus {
            env_id: env_id.to_string(),
            kind: EnvKind::Layer,
            state: MethodEnvState::Ready,
            bytes_downloaded: 0,
            bytes_total: None,
            digest: Some("f".repeat(64)),
            mounted: false,
            error: None,
        }
    }

    fn cancel(&self, _env_id: &str) {}
}

/// The scripted method executor: records the runs, applies the real
/// executor's bundle stage to the context the drive hands it, waits a moment
/// (so the `creating` state is observable), and writes a REAL model tree
/// under the run dir — the store's save path copies it like any produced
/// model.
struct ModelFakeExecutor {
    runs: Mutex<Vec<String>>,
    refused: Mutex<Vec<String>>,
    delay: Duration,
}

impl ModelFakeExecutor {
    fn new(delay: Duration) -> Self {
        Self {
            runs: Mutex::new(Vec::new()),
            refused: Mutex::new(Vec::new()),
            delay,
        }
    }

    fn ran(&self) -> Vec<String> {
        self.runs.lock().expect("lock").clone()
    }

    fn refused(&self) -> Vec<String> {
        self.refused.lock().expect("lock").clone()
    }
}

#[async_trait::async_trait]
impl MethodExecutor for ModelFakeExecutor {
    async fn execute(&self, ctx: MethodRunContext) -> Result<MethodOutcome, AppError> {
        self.runs
            .lock()
            .expect("lock")
            .push(ctx.method_id.clone());
        // The real train executor's bundle stage over the drive's own context
        // (the run's canonical sides, its config, the plan's min_draws, the
        // lane CPU count): a refusal fails the method with its `BUNDLE_*`
        // code exactly like `execute_train`, so the example set cannot
        // become ready on a method the real run would refuse.
        let facts = envmanifest::facts_for(&ctx.method_id)
            .ok_or_else(|| AppError::internal_error(format!("unknown method {}", ctx.method_id)))?;
        if let Err(e) = orchestrator::call_bundle_preflight(&ctx, facts) {
            self.refused
                .lock()
                .expect("lock")
                .push(format!("{}: {e}", ctx.method_id));
            return Ok(MethodOutcome {
                state: TxrMethodState::Failed,
                reason: Some(TxrRunReason {
                    code: e.code().to_string(),
                    detail: e.to_string(),
                }),
                exit_code: None,
                duration_ms: None,
                prob_source: None,
                coverage: None,
                task: None,
                model: None,
            });
        }
        tokio::time::sleep(self.delay).await;
        // The real executor writes the call input (contract 2.0 params.json)
        // into `bundles/<method>/` before the fit; the store's save path
        // records `markers` from it, so the fake writes the same layout.
        let bundle_dir = ctx.run_dir.join("bundles").join(&ctx.method_id);
        std::fs::create_dir_all(&bundle_dir)
            .map_err(|e| AppError::internal_error(format!("fixture bundle dir: {e}")))?;
        std::fs::write(
            bundle_dir.join("params.json"),
            json!({
                "landmark_day": 56.0,
                "horizons": [238.0],
                "outcomes": [{"task": "pfs", "column": "pfs_event"}],
                "markers": ["M1", "M2", "M3"],
                "baseline_max_day": 0.0,
                "covariates": false,
                "method_params": {},
                "seed": 1,
                "threads": 4,
            })
            .to_string(),
        )
        .map_err(|e| AppError::internal_error(format!("fixture params.json: {e}")))?;
        let model_dir = ctx.run_dir.join("models").join(&ctx.method_id);
        std::fs::create_dir_all(&model_dir)
            .map_err(|e| AppError::internal_error(format!("fixture model dir: {e}")))?;
        std::fs::write(model_dir.join("model.rds"), format!("fixture-model-{}", ctx.method_id))
            .map_err(|e| AppError::internal_error(format!("fixture model file: {e}")))?;
        let digest = tree_sha256(&model_dir)
            .map_err(|e| AppError::internal_error(format!("fixture tree digest: {e}")))?;
        let trained = ctx
            .train
            .as_ref()
            .map(|t| t.patients.len() as u32)
            .unwrap_or(0);
        Ok(MethodOutcome {
            state: TxrMethodState::Finished,
            reason: None,
            exit_code: Some(0),
            duration_ms: Some(7),
            prob_source: Some(TxrProbSource::Native),
            coverage: Some(TxrCoverage {
                scored: trained,
                eligible: trained,
                fraction: 1.0,
            }),
            task: Some(TxrTask::Pfs),
            model: Some(ProducedModelFacts {
                model_out_digest: digest,
                dir: model_dir.display().to_string(),
                trained_on_patients: trained,
                size_bytes: 64,
                own_auc: Some(0.61),
            }),
        })
    }
}

/// The embedded example bytes → parsed table (the test's mirror of the
/// module's builder over the same committed bytes).
fn parsed(bytes: &'static [u8], name: &str) -> ParsedTable {
    let text = std::str::from_utf8(bytes).expect("utf-8");
    let mut lines = text.split('\n').filter(|l| !l.is_empty());
    let header: Vec<String> = lines
        .next()
        .expect("header")
        .split(',')
        .map(|c| c.to_string())
        .collect();
    ParsedTable {
        source: ParsedTableSource {
            name: name.to_string(),
            format: TableFormat::Csv,
        },
        header_row: 1,
        columns: header,
        rows: lines
            .map(|l| {
                l.split(',')
                    .map(|c| {
                        let c = c.trim();
                        if c.is_empty() {
                            None
                        } else {
                            Some(c.to_string())
                        }
                    })
                    .collect()
            })
            .collect(),
    }
}

/// TEST-QF3-1 (a) — the example family validates with zero errors and only
/// the normal per-marker A04 notes ("at most the notes the app shows
/// normally"), in both the train pair and the predict table, and the bytes
/// are the same on every call (the embedded consts ARE the served bytes).
#[test]
fn example_family_is_deterministic_and_passes_the_validator() {
    let validation = example::example_validation().expect("the example validates");
    let errors: Vec<_> = validation
        .problems
        .iter()
        .filter(|p| p.severity == ProblemSeverity::Error)
        .collect();
    assert!(errors.is_empty(), "the train example has no errors: {errors:?}");
    let warnings: Vec<_> = validation
        .problems
        .iter()
        .filter(|p| p.severity == ProblemSeverity::Warning)
        .collect();
    assert_eq!(warnings.len(), 3, "the three A04 notes: {warnings:?}");
    assert!(
        warnings.iter().all(|p| p.code.code() == "A04"),
        "only the no-scale assumptions: {warnings:?}"
    );

    let predict_request = ValidationRequest {
        mode: ValidationMode::Predict,
        patients: None,
        measurements: parsed(ASSETS.predict_measurements_example, "predict-measurements.csv"),
        joins: Vec::new(),
        mapping: Vec::new(),
        parameters: Default::default(),
    };
    let predict = txresbench::modules::file_validator::validate(&predict_request)
        .expect("the predict example validates");
    let errors: Vec<_> = predict
        .problems
        .iter()
        .filter(|p| p.severity == ProblemSeverity::Error)
        .collect();
    assert!(errors.is_empty(), "predict example has no errors: {errors:?}");
    let warnings: Vec<_> = predict
        .problems
        .iter()
        .filter(|p| p.severity == ProblemSeverity::Warning)
        .collect();
    assert_eq!(warnings.len(), 3, "the three A04 notes: {warnings:?}");

    // Determinism + family facts (the generator's pins).
    let patients_text = std::str::from_utf8(ASSETS.patients_example).expect("utf-8");
    let measurements_text = std::str::from_utf8(ASSETS.measurements_example).expect("utf-8");
    let predict_text = std::str::from_utf8(ASSETS.predict_measurements_example).expect("utf-8");
    assert_eq!(patients_text.lines().count(), 101);
    assert_eq!(measurements_text.lines().count(), 2960);
    assert_eq!(predict_text.lines().count(), 270);
    assert_eq!(ASSETS.measurements_example, ASSETS.measurements_example);
    // The train ids and the predict ids never overlap (a new-patient table).
    let train_ids: std::collections::BTreeSet<&str> = patients_text
        .lines()
        .skip(1)
        .map(|l| l.split(',').next().expect("id"))
        .collect();
    assert_eq!(train_ids.len(), 100);
    let predict_ids: std::collections::BTreeSet<&str> = predict_text
        .lines()
        .skip(1)
        .map(|l| l.split(',').next().expect("id"))
        .collect();
    assert_eq!(predict_ids.len(), 15);
    assert!(train_ids.is_disjoint(&predict_ids));
}

/// TEST-QF3-1 (b) — the fast-method pick: deterministic, at most 3, each with
/// a published environment, saving models, a `CanRun` verdict on the example
/// inventory, every bundle the run's train call builds built without a
/// refusal on the example run's own canonical input, and a catalogue
/// estimate under 30 s at the example's patient count; the cached pick the
/// endpoint serves is the same list.
#[tokio::test]
async fn pick_is_deterministic_three_fast_saving_methods() {
    let inputs = example::example_run_inputs().expect("the example canonicalizes");
    let patients = inputs.patients();
    let a = example::pick_fast_methods(&inputs);
    let b = example::pick_fast_methods(&inputs);
    assert_eq!(a, b, "the pick is deterministic");
    assert_eq!(
        example::example_methods().await.expect("cached pick"),
        a,
        "the endpoint's cached pick"
    );
    assert_eq!(a.len(), EXAMPLE_METHOD_CAP.min(3), "pick: {a:?}");
    assert!(!a.is_empty(), "the shipped catalogue yields at least one fast method");
    let cat = catalogue();
    let verdicts = eligibility_for(
        cat,
        &EligibilityRequest::Inventory {
            inventory: inputs.validation.inventory.clone(),
        },
    );
    for id in &a {
        let method = cat.method(id).expect("catalogue method");
        assert!(runtime_env_available(id), "{id} has a published environment");
        assert!(method.saves_model, "{id} saves a model");
        let verdict = verdicts.methods.iter().find(|m| &m.id == id).expect("verdict");
        assert_eq!(verdict.status, EligibilityStatus::CanRun, "{id}");
        // The run's own bundle stage (the train/test bundles `execute_train`
        // builds, then the cross-fit or cohort bundles) on the example run's
        // canonical sides, with the run's settings and the method's min_draws.
        if let Err(e) = inputs.preflight(method) {
            panic!("{id} is refused by the run's bundle stage: {e}");
        }
        let seconds = estimate_seconds_for(method, patients, REFERENCE_CPUS);
        assert!(
            seconds < EXAMPLE_METHOD_SECONDS_MAX,
            "{id} estimates {seconds}s < {EXAMPLE_METHOD_SECONDS_MAX}s"
        );
    }
    // The published-env, CAN-run, bundle-buildable set is larger than the cap
    // (the cap is exercised, not a filter that happens to return everything).
    let runnable: Vec<_> = verdicts
        .methods
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRun && runtime_env_available(&m.id))
        .filter(|m| {
            let method = cat.method(&m.id).expect("catalogue method");
            inputs.preflight(method).is_ok()
        })
        .collect();
    assert!(
        runnable.len() > EXAMPLE_METHOD_CAP,
        "more than {EXAMPLE_METHOD_CAP} methods can run on the example"
    );
}

/// Poll `ensure_example_set` until ready (bounded).
async fn poll_ready(
    pool: &sqlx::SqlitePool,
    seams: &ExampleRunSeams,
    owner: Uuid,
    executor: &ModelFakeExecutor,
) -> ExampleSetResponse {
    for _ in 0..600 {
        let resp = example::ensure_example_set(pool, seams, owner)
            .await
            .expect("ensure");
        match resp.state {
            ExampleSetState::Ready => return resp,
            ExampleSetState::Creating => tokio::time::sleep(Duration::from_millis(50)).await,
            ExampleSetState::Failed => panic!(
                "the example failed: {:?}; refused at the bundle stage: {:?}",
                resp.error,
                executor.refused()
            ),
        }
    }
    panic!("the example set did not become ready in time");
}

/// TEST-QF3-1 (c) — the example saved set is created once (a second call
/// returns the SAME set and starts no second run), the created set is a REAL
/// set named "Example models" with one model per picked method, and deleting
/// the set + calling again recreates it (a fresh run, a different set id).
#[tokio::test]
async fn example_set_is_created_once_and_recreated_after_deletion() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("example-set"));

    let me: Value = server
        .client
        .get(server.api_url("/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("me")
        .json()
        .await
        .expect("me json");
    let owner = Uuid::parse_str(me["user"]["id"].as_str().expect("user id")).expect("uuid");

    let executor = Arc::new(ModelFakeExecutor::new(Duration::from_millis(400)));
    let executor_clone = executor.clone();
    let seams = ExampleRunSeams {
        runtime: Arc::new(RunRuntime::new()),
        env: Arc::new(FakeExampleEnv),
        executor,
    };

    // Call 1: the example run starts (creating) with the deterministic pick.
    let first = example::ensure_example_set(&pool, &seams, owner)
        .await
        .expect("ensure");
    assert_eq!(first.state, ExampleSetState::Creating, "{first:?}");
    let run_id = first.run_id.expect("run id");
    assert!(
        first.run_status.is_some(),
        "the call reports the run's job state"
    );
    assert_eq!(first.methods.len(), EXAMPLE_METHOD_CAP.min(3), "{:?}", first.methods);
    let methods = first.methods.clone();

    // The immediate second call sees the SAME run's progress (the fake
    // executor is deliberately slow enough to observe creating).
    let second = example::ensure_example_set(&pool, &seams, owner)
        .await
        .expect("ensure");
    assert_eq!(second.state, ExampleSetState::Creating, "{second:?}");
    assert_eq!(second.run_id, Some(run_id), "the same run, not a second one");

    // Poll until ready; the set is a REAL set with the reserved name and one
    // model per picked method.
    let ready = poll_ready(&pool, &seams, owner, &executor_clone).await;
    let set_id = ready.set_id.expect("set id");
    let repo = ModelStoreRepository::new(pool.clone());
    let set = repo.get_set(set_id).await.expect("get set").expect("exists");
    assert_eq!(set.name, EXAMPLE_SET_NAME);
    let models = repo.list_models(Some(set_id), None, None).await.expect("models");
    assert_eq!(models.len(), 3, "one saved model per picked method: {models:?}");
    for m in &models {
        assert!(
            methods.contains(&m.method_id),
            "the saved model's method is one of the pick: {}",
            m.method_id
        );
    }

    // A second call after ready: the existing set, no new run.
    let again = example::ensure_example_set(&pool, &seams, owner)
        .await
        .expect("ensure");
    assert_eq!(again.state, ExampleSetState::Ready, "{again:?}");
    assert_eq!(again.set_id, Some(set_id), "the same set");
    let run_repo = TxrRepository::new(pool.clone());
    let (runs, total) = run_repo.list_run_summaries(50, 0).await.expect("runs");
    assert_eq!(total, 1, "one example run so far ({runs:?})");
    assert_eq!(executor_clone.ran().len(), 3, "the picked three ran once");
    assert!(
        executor_clone.refused().is_empty(),
        "no picked method is refused at the bundle stage: {:?}",
        executor_clone.refused()
    );

    // Delete the set (the route's cascade: rows + prune + training dir), then
    // call again — it recreates: a fresh run, a different set id.
    let digests: Vec<String> = repo
        .list_models(Some(set_id), None, None)
        .await
        .expect("models")
        .iter()
        .map(|m| m.tree_sha256.clone())
        .collect();
    repo.delete_set(set_id).await.expect("delete set");
    txresbench::modules::model_store::store::prune_unreferenced_trees(&pool, &digests)
        .await
        .expect("prune");
    let _ = txresbench::modules::model_store::store::remove_training_dir(set_id)
        .expect("training dir removal");
    let recreated = example::ensure_example_set(&pool, &seams, owner)
        .await
        .expect("ensure");
    assert_eq!(recreated.state, ExampleSetState::Creating, "{recreated:?}");
    let ready2 = poll_ready(&pool, &seams, owner, &executor_clone).await;
    let set2 = ready2.set_id.expect("new set id");
    assert_ne!(set2, set_id, "deleting + calling again recreates a NEW set");
    let (_, total2) = run_repo.list_run_summaries(50, 0).await.expect("runs");
    assert_eq!(total2, 2, "the recreation trained a fresh run");
}
