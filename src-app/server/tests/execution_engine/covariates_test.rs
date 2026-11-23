//! The per-method covariates rule (bug 2) integration leg: a train call with
//! the run's covariates checkbox ON, a TRAIN patients table that carries a
//! cov_* column, and a separate predict measurements file WITHOUT a patients
//! table. The covariates flag is per method:
//! - `none` → off (the method runs, its bundles carry no covariates.csv);
//! - `optional` → off (the predict side has no patients table — the method
//!   runs without covariates);
//! - `required` → on (only THIS method is refused,
//!   `BUNDLE_TEST_COVARIATES_MISSING`).
//!
//! The other half — the run's covariates checkbox OFF with a `required`
//! method — is `covariates_switch_off_only_refuses_a_required_method`: the
//! required method is refused `BUNDLE_COVARIATES_OFF` before anything is
//! written, while `none` / `optional` still run without covariates.csv.
//!
//! The real executor path is driven in-process (the `StackMethodExecutor` +
//! the scripted `StackRunSeam` the run-flow tests share) with the canonical
//! sides built through the REAL validator (`canonical_bundle` — the same
//! call the run start's `prepare_run` makes, DEC-15). A `required`-mode
//! catalogue method has no published environment entry, so the run-start
//! classification would answer `cannot_run` (ENV_IMAGE_MISSING) before the
//! bundle stage — this leg drives the executor directly, which is exactly
//! the stage the bug is in.

use std::sync::Arc;

use super::{pool, scratch_dir, FakeStackRunSeam};
use crate::common::TestServer;
use txresbench::modules::execution_engine::orchestrator::MethodSink;
use txresbench::modules::execution_engine::orchestrator::{
    MethodExecutor, MethodRunContext, RunTarget, StackMethodExecutor,
};
use txresbench::modules::execution_engine::types::{RunConfig, TxrMethodState};
use txresbench::modules::execution_engine::types::TxrRunReason;
use txresbench::modules::file_validator::bundle::canonical_bundle;
use txresbench::modules::file_validator::types::{
    AnalysisParameters, JoinOffer, MarkerMapping, ValidationMode, ValidationRequest,
};
use txresbench::modules::rootfs;
use txresbench::modules::sandbox::stack::EnvRef;
use txresbench::modules::execution_engine::types::TxrMethodEnv;
use txresbench::modules::method_list;

/// A no-op [`MethodSink`] (the executor's progress/log seam — this leg only
/// reads the verdicts and the written bundle files).
#[derive(Default)]
struct SilentSink;

impl MethodSink for SilentSink {
    fn line(&self, _stream: txresbench::modules::execution_engine::types::TxrLogStream, _content: String) {}
    fn progress(
        &self,
        _phase: txresbench::modules::execution_engine::types::TxrPhase,
        _pct: Option<f64>,
        _message: Option<String>,
    ) {
    }
}

/// The 30-patient cohort patients table with an `age` covariate column (the
/// validator's tidy covariate rule: a known-by-name `age` column).
fn patients_with_age() -> txresbench::modules::file_validator::types::ParsedTable {
    let mut rows = Vec::new();
    for (i, row) in super::cohort_patients_parsed().rows.into_iter().enumerate() {
        let mut fields: Vec<Option<String>> = row.into_iter().collect();
        fields.push(Some(format!("{}", 40 + (i % 40))));
        rows.push(fields);
    }
    let par = super::cohort_patients_parsed();
    txresbench::modules::file_validator::types::ParsedTable {
        source: par.source,
        header_row: 1,
        columns: [
            vec![
                "patient_id".to_string(),
                "pfs_days".to_string(),
                "pfs_event".to_string(),
                "os_days".to_string(),
                "os_event".to_string(),
            ],
            vec!["age".to_string()],
        ]
        .concat(),
        rows,
    }
}

fn train_vreq() -> ValidationRequest {
    ValidationRequest {
        mode: ValidationMode::Files,
        patients: Some(patients_with_age()),
        measurements: super::cohort_measurements_parsed(),
        joins: Vec::<JoinOffer>::new(),
        mapping: Vec::<MarkerMapping>::new(),
        parameters: AnalysisParameters {
            decision_day: 56.0,
            ..Default::default()
        },
    }
}

fn predict_vreq() -> ValidationRequest {
    ValidationRequest {
        mode: ValidationMode::Predict,
        patients: None,
        measurements: super::cohort_measurements_parsed(),
        joins: Vec::<JoinOffer>::new(),
        mapping: Vec::<MarkerMapping>::new(),
        parameters: AnalysisParameters {
            decision_day: 56.0,
            ..Default::default()
        },
    }
}

fn env_facts() -> txresbench::modules::execution_engine::orchestrator::EnvFacts {
    txresbench::modules::execution_engine::orchestrator::EnvFacts {
        base: EnvRef {
            env_id: "base-r".to_string(),
            oci_ref: "ghcr.io/fixture/base-r@sha256:abc".to_string(),
            digest: "c".repeat(64),
            tag: None,
        },
        layer: EnvRef {
            env_id: "layer".to_string(),
            oci_ref: "ghcr.io/fixture/layer".to_string(),
            digest: "d".repeat(64),
            tag: None,
        },
        base_digest: "c".repeat(64),
        layer_digest: "d".repeat(64),
        image: TxrMethodEnv::digests("c".repeat(64), "d".repeat(64)),
    }
}

/// One train-mode call's context over the same prepared sides: the train
/// canonical bundle (patients table WITH covariates) and the separate
/// predict measurements bundle (NO patients table). `save_models` off keeps
/// the leg on the bundle/predict surface.
#[allow(clippy::type_complexity)]
fn train_ctx(
    run_dir: &std::path::Path,
    method_id: &str,
    facts: &txresbench::modules::method_catalogue::types::Method,
    train: Arc<txresbench::modules::file_validator::types::CanonicalBundle>,
    predict: Arc<txresbench::modules::file_validator::types::CanonicalBundle>,
) -> (MethodRunContext, tokio::sync::watch::Sender<bool>) {
    let (cancel_tx, cancel) = tokio::sync::watch::channel(false);
    (
        MethodRunContext {
        run_id: uuid::Uuid::new_v4(),
        method_id: method_id.to_string(),
        label: method_id.to_string(),
        version: facts.version.clone(),
        group: facts.group.as_str().to_string(),
        min_draws: facts.min_draws,
        env: env_facts(),
        job_id: uuid::Uuid::new_v4(),
        cancel,
        config: RunConfig {
            decision_day: 56.0,
            look_ahead_day: 238.0,
            covariates: true,
            ..Default::default()
        },
        cpus: 4,
        train: Some(train),
        predict: Some(predict),
        predict_patients: None,
        run_dir: run_dir.to_path_buf(),
        save_models: false,
        target: RunTarget::TrainMethod,
        sink: Arc::new(SilentSink),
        list: method_list::current(),
    },
        cancel_tx,
    )
}

/// The bug-2 integration case (bug 2): the covariates flag is per method.
/// With the run's covariates ON, a train patients table WITH cov columns and
/// a separate predict file WITHOUT a patients table:
/// - `none` runs (bundles without covariates.csv);
/// - `optional` runs (bundles without covariates.csv — no predict patients
///   table);
/// - `required` is refused with `BUNDLE_TEST_COVARIATES_MISSING` (only that
///   method).
#[tokio::test]
async fn per_method_covariates_only_refuses_a_required_method() {
    let server = TestServer::spawn().await;
    let pool = pool(&server).await;
    let scratch = scratch_dir("per-method-covariates");
    let _g = rootfs::scoped_data_root(&scratch);
    let list = method_list::current();

    // The canonical sides through the real validator.
    let train = Arc::new(
        canonical_bundle(&train_vreq()).expect("the train side with covariates validates"),
    );
    assert!(
        train.patients.iter().any(|p| !p.covariates.is_empty()),
        "the fixture's patients table carries the cov_* column"
    );
    let predict = Arc::new(canonical_bundle(&predict_vreq()).expect("the predict side validates"));

    // none / optional / required: real catalogue facts for the modes, pinned
    // so a catalogue change that swaps a fixture method's mode fails loudly
    // here rather than silently relabelling the leg.
    let none = list.method("ctdna-tf-four-group").expect("a none-mode method");
    let optional = list.method("jm-lme").expect("an optional-mode method");
    let required = list.method("jmgpu-linear").expect("a required-mode method");
    assert_eq!(
        none.covariates,
        txresbench::modules::method_catalogue::types::CovariateMode::None,
        "ctdna-tf-four-group stays none-mode"
    );
    assert_eq!(
        optional.covariates,
        txresbench::modules::method_catalogue::types::CovariateMode::Optional,
        "jm-lme stays optional-mode"
    );
    assert_eq!(
        required.covariates,
        txresbench::modules::method_catalogue::types::CovariateMode::Required,
        "jmgpu-linear stays required-mode"
    );

    for (method_id, key) in [
        ("ctdna-tf-four-group", "none"),
        ("jm-lme", "optional"),
        ("jmgpu-linear", "required"),
    ] {
        let facts = list.method(method_id).expect("facts");
        let run_dir = rootfs::data_root().join(key);
        for sub in ["bundles", "output", "models"] {
            std::fs::create_dir_all(run_dir.join(sub).join(method_id)).expect("method dirs");
        }
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool.clone(), seam);
        let (ctx, _cancel_tx) = train_ctx(&run_dir, method_id, facts, train.clone(), predict.clone());
        let outcome = exec.execute(ctx).await.expect("a verdict");

        match key {
            "required" => {
                assert_eq!(outcome.state, TxrMethodState::Failed, "{method_id}");
                let reason: TxrRunReason = outcome.reason.expect("a failure reason");
                assert_eq!(reason.code, "BUNDLE_TEST_COVARIATES_MISSING", "{method_id}");
                assert!(
                    reason.detail.contains("patients to predict"),
                    "plain-words detail: {reason:?}"
                );
            }
            _ => {
                assert_eq!(outcome.state, TxrMethodState::Finished, "{method_id}");
                assert!(outcome.reason.is_none(), "{method_id}");
                assert!(outcome.coverage.is_some(), "{method_id}: patients were scored");
            }
        }

        // The written bundles: no covariates.csv anywhere for none / optional
        // (the required method is refused BEFORE any bundle is written).
        let bundle_dir = run_dir.join("bundles").join(method_id);
        let params = std::fs::read_to_string(bundle_dir.join("params.json"))
            .ok()
            .map(|s| serde_json::from_str::<serde_json::Value>(&s).expect("params.json"));
        if key == "required" {
            assert!(
                !bundle_dir.join("train").join("long.csv").exists(),
                "{method_id}: nothing written before the refusal"
            );
            assert!(params.is_none(), "{method_id}: no params.json before the refusal");
        } else {
            assert!(
                !bundle_dir.join("train").join("covariates.csv").exists(),
                "{method_id}: train bundle has no covariates.csv"
            );
            assert!(
                !bundle_dir.join("test").join("covariates.csv").exists(),
                "{method_id}: test bundle has no covariates.csv"
            );
            assert!(
                bundle_dir.join("train").join("long.csv").exists(),
                "{method_id}: the train bundle wrote long.csv"
            );
            let params = params.expect("params.json written");
            assert_eq!(params["covariates"], serde_json::json!(false), "{method_id}");
        }
    }
}

/// Bug 2's other half: the run's Extra inputs switch OFF with a method whose
/// catalogue covariates requirement is `required` → only THAT method is
/// refused, with `BUNDLE_COVARIATES_OFF` and the exact message, and BEFORE
/// anything is written (no sandbox call, no params.json, no bundle file) —
/// never a whole-run refusal, never a silent run without the inputs. The
/// `none` and `optional` methods keep today's rule exactly: switch off → no
/// covariates.csv, they run and score.
#[tokio::test]
async fn covariates_switch_off_only_refuses_a_required_method() {
    let server = TestServer::spawn().await;
    let pool = pool(&server).await;
    let scratch = scratch_dir("covariates-switch-off");
    let _g = rootfs::scoped_data_root(&scratch);
    let list = method_list::current();

    // The same canonical sides as the switch-ON leg (the real validator).
    let train = Arc::new(
        canonical_bundle(&train_vreq()).expect("the train side with covariates validates"),
    );
    let predict = Arc::new(canonical_bundle(&predict_vreq()).expect("the predict side validates"));

    // none / optional / required: real catalogue facts for the modes, pinned
    // so a catalogue change that swaps a fixture method's mode fails loudly
    // here rather than silently relabelling the leg.
    let none = list.method("ctdna-tf-four-group").expect("a none-mode method");
    let optional = list.method("jm-lme").expect("an optional-mode method");
    let required = list.method("jmgpu-linear").expect("a required-mode method");
    assert_eq!(
        none.covariates,
        txresbench::modules::method_catalogue::types::CovariateMode::None,
        "ctdna-tf-four-group stays none-mode"
    );
    assert_eq!(
        optional.covariates,
        txresbench::modules::method_catalogue::types::CovariateMode::Optional,
        "jm-lme stays optional-mode"
    );
    assert_eq!(
        required.covariates,
        txresbench::modules::method_catalogue::types::CovariateMode::Required,
        "jmgpu-linear stays required-mode"
    );

    for (method_id, key) in [
        ("ctdna-tf-four-group", "none"),
        ("jm-lme", "optional"),
        ("jmgpu-linear", "required"),
    ] {
        let facts = list.method(method_id).expect("facts");
        let run_dir = rootfs::data_root().join(key);
        for sub in ["bundles", "output", "models"] {
            std::fs::create_dir_all(run_dir.join(sub).join(method_id)).expect("method dirs");
        }
        let seam = FakeStackRunSeam::new();
        let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
        let (mut ctx, _cancel_tx) =
            train_ctx(&run_dir, method_id, facts, train.clone(), predict.clone());
        // The run's Extra inputs switch OFF (the harness defaults it ON).
        ctx.config.covariates = false;
        let outcome = exec.execute(ctx).await.expect("a verdict");

        match key {
            "required" => {
                assert_eq!(outcome.state, TxrMethodState::Failed, "{method_id}");
                let reason: TxrRunReason = outcome.reason.expect("a failure reason");
                assert_eq!(reason.code, "BUNDLE_COVARIATES_OFF", "{method_id}");
                assert_eq!(
                    reason.detail,
                    "BUNDLE_COVARIATES_OFF: This method needs the extra inputs, \
                     but this run was started with Extra inputs off.",
                    "{method_id}: the exact refusal message"
                );
                let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
                assert!(
                    calls.is_empty(),
                    "{method_id}: no sandbox call before the refusal"
                );
                drop(calls);
            }
            _ => {
                assert_eq!(outcome.state, TxrMethodState::Finished, "{method_id}");
                assert!(outcome.reason.is_none(), "{method_id}");
                assert!(
                    outcome.coverage.is_some(),
                    "{method_id}: patients were scored"
                );
            }
        }

        // The written bundles: nothing for the refused method; no
        // covariates.csv anywhere for none / optional (switch off → no
        // covariates, today's rule).
        let bundle_dir = run_dir.join("bundles").join(method_id);
        let params = std::fs::read_to_string(bundle_dir.join("params.json"))
            .ok()
            .map(|s| serde_json::from_str::<serde_json::Value>(&s).expect("params.json"));
        if key == "required" {
            assert!(
                !bundle_dir.join("train").join("long.csv").exists(),
                "{method_id}: nothing written before the refusal"
            );
            assert!(params.is_none(), "{method_id}: no params.json before the refusal");
        } else {
            assert!(
                !bundle_dir.join("train").join("covariates.csv").exists(),
                "{method_id}: train bundle has no covariates.csv"
            );
            assert!(
                !bundle_dir.join("test").join("covariates.csv").exists(),
                "{method_id}: test bundle has no covariates.csv"
            );
            assert!(
                bundle_dir.join("train").join("long.csv").exists(),
                "{method_id}: the train bundle wrote long.csv"
            );
            let params = params.expect("params.json written");
            assert_eq!(params["covariates"], serde_json::json!(false), "{method_id}");
        }
    }
}
