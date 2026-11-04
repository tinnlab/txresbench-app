//! The predictions ingest + conversion-band integration legs
//! (TEST-EE-14, with the ITEM-9 notes' pins): the REAL executor path
//! (`StackMethodExecutor` + the scripted container seam) driven through
//! `start_run` over the harness template DB — the output-side half of the
//! contract-2.0 pipeline the `api_test.rs` HTTP surface serves.
//!
//! The container-fed leg (a REAL fixture container through the stacked
//! sandbox) is host-gated like the other real-stack legs (see
//! `run_flow_test.rs`); the scripted leg below is the deterministic half the
//! plan assigns to the harness fixture container (TEST-EE-14's converted
//! values within [0, 1], ordered with the raw training risk,
//! `prob_source == "recalibrated"`, training-only fit, native untouched).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::run_flow_test::real_stack_gate;
use super::{
    cohort_run_request, pool, register_user, scratch_dir, wait_terminal, FakeEnv, FakeStackRunSeam,
};
use crate::common::TestServer;
use cytoanalyst::modules::execution_engine::orchestrator::{self, StackMethodExecutor};
use cytoanalyst::modules::execution_engine::repository::TxrRepository;
use cytoanalyst::modules::execution_engine::runtime::RunRuntime;
use cytoanalyst::modules::execution_engine::types::TxrRunStatus;
use cytoanalyst::modules::rootfs;
use cytoanalyst::modules::sandbox::stack::MethodRunMode;

/// TEST-EE-14 (scripted half): a risk-only method (the catalogue declares no
/// native probability) is run through the executor's conversion band — the
/// recorded column carries `prob_source: "recalibrated"`, values within
/// [0, 1] and ordered exactly as the raw risk.
#[tokio::test]
async fn risk_only_method_is_recalibrated_and_ordered_with_the_raw_risk() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-cal").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("calibrated"));

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let seam = FakeStackRunSeam::new();
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, true),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods.len(), 1);
    assert_eq!(methods[0].state, "finished", "{:?}", methods[0].reason_code);
    assert_eq!(
        methods[0].prob_source.as_deref(),
        Some("recalibrated"),
        "a no-native method converts (INV-3, never mixed)"
    );
    let coverage = methods[0].coverage_scored.expect("coverage recorded");
    assert_eq!(coverage, 30, "every cohort patient scored");
    assert_eq!(methods[0].coverage_eligible, Some(30));

    // The recorded column: 30 rows, probabilities in [0, 1], ordered with the
    // raw risk (the fixture's event pattern makes the fitted map rise with
    // the risk order — the package's constant fallback is a unit pin).
    let chance = row_dir(&row.dir).join("output/ctdna-tf-four-group/chance.csv");
    let text = std::fs::read_to_string(&chance).expect("chance.csv recorded");
    let mut lines: Vec<Vec<&str>> = text
        .lines()
        .map(|l| l.split(',').collect::<Vec<_>>())
        .collect();
    let header = lines.remove(0);
    assert_eq!(
        header,
        vec!["patient_id", "probability", "note"],
        "the DEC-11 recorded column shape"
    );
    assert_eq!(lines.len(), 30);
    // The map rises with the fixture risk order (the event pattern is
    // engineered for that, see the cohort fixture); ties at the 6-decimal
    // record are tolerated — the ORDER pin is non-decreasing + the strict
    // C01 < C30 extremes.
    let mut prev = -1.0f64;
    let mut first_p = None;
    let mut last_p = None;
    for line in &lines {
        let id = line[0];
        let p: f64 = line[1].parse().expect("probability");
        assert!(
            (0.0..=1.0).contains(&p),
            "{id}: probability in [0, 1] ({p})"
        );
        assert!(
            p >= prev - 1e-9,
            "probabilities ordered with the raw risk: {p} after {prev}"
        );
        first_p.get_or_insert(p);
        last_p = Some(p);
        prev = p;
        assert_eq!(line.len(), 3, "patient_id,probability,note");
        assert!(
            line[2].is_empty(),
            "a scored patient carries no note (the note cell is the abstention's reason)"
        );
    }
    assert!(
        first_p.unwrap() < last_p.unwrap(),
        "the lowest-risk patient converts below the highest-risk one"
    );

    // The raw container output is untouched provenance.
    let raw = row_dir(&row.dir).join("output/ctdna-tf-four-group/predictions.csv");
    let raw_text = std::fs::read_to_string(&raw).expect("raw kept");
    assert!(raw_text.contains("risk"), "raw columns untouched");
}

/// TEST-EE-14 (native half): a method that DECLARES its probability keeps
/// `prob_source: "native"` and its recorded column equals the container's
/// declared column bytes (never re-derived).
#[tokio::test]
async fn native_method_keeps_its_probability_verbatim() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-native").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("native"));

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let seam = FakeStackRunSeam::new();
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["jm-lme"], 2, true),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods[0].prob_source.as_deref(), Some("native"));

    // jm-lme declares `p_progression_H*`: the recorded column equals the
    // container's own column value — the record is the module's `{:.6}`
    // format of the same float, so the pin is on the parsed value, never the
    // byte representation (the raw file's `0.2` and `0.200000` are the same
    // probability).
    let chance = row_dir(&row.dir).join("output/jm-lme/chance.csv");
    let text = std::fs::read_to_string(&chance).expect("chance.csv");
    let raw = row_dir(&row.dir).join("output/jm-lme/predictions.csv");
    let raw_text = std::fs::read_to_string(&raw).expect("raw");
    let expected = raw_text
        .lines()
        .skip(1)
        .map(|l| l.split(',').nth(4).expect("p_progression_H238"))
        .collect::<Vec<_>>();
    let recorded = text
        .lines()
        .skip(1)
        .map(|l| l.split(',').nth(1).expect("probability"))
        .collect::<Vec<_>>();
    assert_eq!(
        recorded.len(),
        expected.len(),
        "one recorded row per patient"
    );
    for (r, e) in recorded.iter().zip(&expected) {
        let rv: f64 = r.parse().expect("recorded probability");
        let ev: f64 = e.parse().expect("native probability");
        assert!(
            (rv - ev).abs() < 1e-12,
            "the native column is served verbatim: {r} vs {e}"
        );
    }
}

/// TEST-EE-14 (training-only half): the conversion's map is fitted on the
/// TRAINING-scoring call's risks (the pure-layer pin is ITEM-9's unit test —
/// `fit_recalibration` over the training score map, never a recomputed one);
/// the predict call's own ranking then flows through `apply`, which is
/// EXAMPLE-EE-2's "ordering the same patients as the raw risk": a predict
/// call carrying the container's REVERSED ranking is served reversed, and
/// the fit is never rebuilt from it (the executor's v1 shape stays
/// fit → training scores → predict).
#[tokio::test]
async fn a_shifted_predict_ranking_flows_through_the_fitted_map() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-train-only").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("training-only"));

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let seam = FakeStackRunSeam::new();
    // Calls 0 = the fit call, 1 = the training scores, 2 = the final predict.
    // The training call carries the RISING order; the final predict call is
    // the container's own REVERSED order — the risks written per call are
    // recorded so the shift is pinned on the seam's bytes.
    let risks = Arc::new(Mutex::new(Vec::<(usize, f64, f64)>::new()));
    {
        let risks = risks.clone();
        seam.writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(Box::new(move |call_no, bundle_dir, outputs_dir, scored| {
                let rising = call_no <= 1;
                let mut csv = String::from(
                    "patient_id,risk,risk_progression,risk_death,p_progression_H238,p_death_H238,call,note\n",
                );
                let mut r01 = 0.0f64;
                let mut r30 = 0.0f64;
                for (i, id) in scored.iter().enumerate() {
                    let rank = if rising { i } else { scored.len() - 1 - i };
                    let risk = 0.1 + (rank as f64) * 0.05;
                    let prob = 0.2 + ((rank % 12) as f64) * 0.05;
                    if id == "C01" {
                        r01 = risk;
                    }
                    if id == "C30" {
                        r30 = risk;
                    }
                    csv.push_str(&format!("{id},{risk},{risk},{risk},{prob},{prob},1,\n"));
                }
                risks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((call_no, r01, r30));
                std::fs::create_dir_all(outputs_dir)?;
                std::fs::write(outputs_dir.join("predictions.csv"), csv)?;
                std::fs::write(outputs_dir.join("run.json"), "{\"fixture\": true}")?;
                let _ = bundle_dir;
                Ok(())
            }));
    }
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, true),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods[0].prob_source.as_deref(), Some("recalibrated"));
    // The executor's v1 shape for a saves-model, non-fitted method: the fit
    // call, then the training scores, then the final predict — the map's
    // input is the TRAINING call; the predict call never rebuilds it.
    let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(calls.len(), 3, "fit + training scores + predict: {calls:?}");
    assert_eq!(calls[0].mode, MethodRunMode::FitOnly);
    assert!(calls[0].scored.is_empty(), "the fit call scores nothing");
    assert!(calls[0].model_out.is_some(), "the fit wrote /model");
    assert_eq!(calls[1].mode, MethodRunMode::ReuseModel);
    assert_eq!(calls[2].mode, MethodRunMode::ReuseModel);
    assert!(calls[1].mount.is_some() && calls[2].mount.is_some());
    assert_eq!(calls[2].scored.len(), 30);
    drop(calls);

    // The recorded risks: the training call rises with the patient index, the
    // predict call's own ranking is the container's reversed one.
    let written = risks.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(written.len(), 3, "one risk record per call");
    assert!(
        written[1].1 < written[1].2,
        "training call: C01 risk < C30 risk"
    );
    assert!(
        written[2].1 > written[2].2,
        "predict call: the container's reversed ranking"
    );
    drop(written);

    // The served column orders the same patients as the PREDICT call's raw
    // risk (the fitted map's `apply` over the predict-side risks) — the
    // reversed ranking is served, the fit is not rebuilt from it.
    let chance = row_dir(&row.dir).join("output/ctdna-tf-four-group/chance.csv");
    let text = std::fs::read_to_string(&chance).expect("chance.csv");
    let probs: Vec<(String, f64)> = text
        .lines()
        .skip(1)
        .map(|l| {
            let mut it = l.split(',');
            let id = it.next().expect("id").to_string();
            let p = it.next().expect("p").parse().expect("probability");
            (id, p)
        })
        .collect();
    assert_eq!(probs.len(), 30);
    let first = probs.iter().find(|(id, _)| id == "C01").expect("C01");
    let last = probs.iter().find(|(id, _)| id == "C30").expect("C30");
    assert!(
        first.1 > last.1,
        "the predict call's reversed ranking is served (C01 > C30)"
    );
}

/// TEST-EE-14 (gated container leg): the REAL fixture container through the
/// stacked sandbox — self-skips until the published layers are staged at the
/// manifest digests (the run_flow real-stack gate).
#[tokio::test]
async fn test_ee14_real_container_conversion() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-ee14").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("ee14"));
    let methods = ["ctdna-tf-four-group"];
    if !real_stack_gate(&server, "TEST-EE-14", &methods) {
        return;
    }

    let runtime = Arc::new(RunRuntime::new());
    let env = orchestrator::real_env_provider();
    let exec = StackMethodExecutor::new(pool.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&methods, 2, false),
    )
    .await
    .expect("create");
    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let m = &repo.methods_for_run(summary.id).await.expect("methods")[0];
    assert_eq!(m.state, "finished");
    assert_eq!(m.prob_source.as_deref(), Some("recalibrated"));
}

fn row_dir(dir: &str) -> PathBuf {
    PathBuf::from(dir)
}
