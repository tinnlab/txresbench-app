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
use txresbench::modules::execution_engine::orchestrator::{self, StackMethodExecutor};
use txresbench::modules::execution_engine::predictions::{
    self, crossfit_folds_stratified, fit_conversion, fold_strata, ipcw_labels, Conversion,
    IpcwLabel, TrainingLabel,
};
use txresbench::modules::execution_engine::repository::TxrRepository;
use txresbench::modules::execution_engine::runtime::RunRuntime;
use txresbench::modules::execution_engine::types::{TxrLimits, TxrRunStatus};
use txresbench::modules::rootfs;
use txresbench::modules::sandbox::stack::MethodRunMode;

/// The run's cross-fit constants (the engine's public values).
const CROSS_FIT_FOLDS: usize = 3;
const SEED: u64 = TxrLimits::SEED as u64;
const LOOK_AHEAD: f64 = 238.0;

/// The recorded bundle's `train/outcomes.csv` parsed locally (the engine's
/// CSV codec is crate-private; the bundle's own file is plain, so the test
/// reads the same cells: patient_id, pfs_time, pfs_event, ...).
fn parsed_outcomes(text: &str) -> Vec<(String, Option<f64>, Option<f64>)> {
    text.lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let cells: Vec<&str> = l.split(',').collect();
            let num = |s: &str| s.parse::<f64>().ok();
            (cells[0].to_string(), num(cells[1]), num(cells[2]))
        })
        .collect()
}

/// The K=3 stratified folds the engine uses for the fixture cohort (the
/// public pieces of [`orchestrator::cohort_folds`]: strata of the DISPLAYED
/// outcome — progression at the run's look-ahead — then the seeded stratified
/// construction; the run's seed and K are the engine's).
fn cohort_folds_public(outcomes: &[(String, Option<f64>, Option<f64>)]) -> Vec<usize> {
    let labels: Vec<TrainingLabel> = outcomes
        .iter()
        .map(|(id, t, e)| TrainingLabel {
            patient_id: id.clone(),
            pfs_time: *t,
            pfs_event: *e,
            os_time: None,
            os_event: None,
            no_response: None,
            progressive_disease: None,
        })
        .collect();
    let strata = fold_strata(&labels, "progression", LOOK_AHEAD);
    crossfit_folds_stratified(&strata, SEED, CROSS_FIT_FOLDS)
}

/// The IPCW-labelled pfs rows of the fold's OTHER patients (the fixture's
/// fold memberships, `folds` in the same order as `outcomes`) — the engine's
/// own public `ipcw_labels`, computed over those rows ONLY (F4: a fold's
/// conversion's censoring estimate must never include the held-out fold, so
/// fold k's outcomes never move conversion_k's weights).
fn fold_pfs_labels(
    outcomes: &[(String, Option<f64>, Option<f64>)],
    folds: &[usize],
    k: usize,
) -> Vec<(String, IpcwLabel)> {
    let subset: Vec<&(String, Option<f64>, Option<f64>)> = outcomes
        .iter()
        .zip(folds)
        .filter(|(_, f)| **f != k)
        .map(|(o, _)| o)
        .collect();
    let times: Vec<f64> = subset.iter().map(|(_, t, _)| t.unwrap_or(0.0)).collect();
    let events: Vec<Option<f64>> = subset.iter().map(|(_, _, e)| *e).collect();
    let labels = ipcw_labels(&times, &events, LOOK_AHEAD);
    subset
        .iter()
        .zip(labels)
        .map(|((id, _, _), lbl)| (id.clone(), lbl))
        .collect()
}

/// The fold's own cross-checked conversion, built from the PUBLIC pieces the
/// engine uses (the scores of the OTHER folds + the IPCW labels of the other
/// folds' rows — F4): `scores` maps patient → risk (0.1 + index·0.05, the
/// fixture seam's formula on the call's scored order).
fn fold_conversion_public(
    outcomes: &[(String, Option<f64>, Option<f64>)],
    scores: &std::collections::BTreeMap<String, f64>,
    folds: &[usize],
) -> Vec<Conversion> {
    (0..CROSS_FIT_FOLDS)
        .map(|k| {
            let mut risk: Vec<Option<f64>> = Vec::new();
            let mut label: Vec<Option<f64>> = Vec::new();
            let mut weight: Vec<f64> = Vec::new();
            for (id, lbl) in fold_pfs_labels(outcomes, folds, k) {
                if !lbl.keep {
                    continue;
                }
                risk.push(scores.get(&id).copied());
                label.push(lbl.label);
                weight.push(lbl.weight);
            }
            fit_conversion(&risk, &label, &weight)
        })
        .collect()
}

/// The fixture seam's index of a patient in a call's scored (sorted) list
/// (the index the scripted containers' risk/native formula uses).
fn seam_index(scored: &[String], id: &str) -> Option<usize> {
    scored.iter().position(|s| s == id)
}

/// TEST-EE-14 (scripted half): a risk-only method (the catalogue declares no
/// native probability) is run through the executor's conversion band — the
/// recorded column carries `prob_source: "recalibrated"`, values within
/// [0, 1], and (brief 3) the shown chance is the CROSS-CHECKED one: the
/// patient's own fold's conversion applied to the one cohort predict's
/// score, recomputed here from the public pieces.
#[tokio::test]
async fn risk_only_method_is_recalibrated_and_ordered_with_the_raw_risk() {
    // The run must classify the method as queued (a published environment for
    // this machine's chip type) or nothing executes.
    crate::skip_unless_host_env!();
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
    // Brief 3: the shown chance is the CROSS-CHECKED one — each patient's
    // OWN fold's conversion (fitted on the OTHER folds' patients' scores)
    // applied to the one cohort predict's score — recomputed here from the
    // public pieces, so the recorded column is exactly what the engine
    // showed. Every value stays in [0, 1], a scored patient carries no note,
    // and the old pin that the single full map's probabilities are ordered
    // with the raw risk is superseded (each fold now has its own curve, so
    // the order is pinned WITHIN a fold — the exact value check implies it).
    let recorded_outcomes =
        row_dir(&row.dir).join("bundles/ctdna-tf-four-group/train/outcomes.csv");
    let outcomes = parsed_outcomes(
        &std::fs::read_to_string(&recorded_outcomes).expect("the recorded outcomes file"),
    );
    let folds = cohort_folds_public(&outcomes);
    let fold_of: std::collections::BTreeMap<&str, usize> = outcomes
        .iter()
        .map(|(id, _, _)| id.as_str())
        .zip(&folds)
        .map(|(id, k)| (id, *k))
        .collect();
    let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(
        calls.len(),
        3,
        "fit + the one cohort predict + the final predict"
    );
    let cohort_scored = calls[1].scored.clone();
    drop(calls);
    let scores: std::collections::BTreeMap<String, f64> = cohort_scored
        .iter()
        .map(|id| {
            (
                id.clone(),
                0.1 + seam_index(&cohort_scored, id).expect("scored") as f64 * 0.05,
            )
        })
        .collect();
    let fold_conversions = fold_conversion_public(&outcomes, &scores, &folds);
    // The restored per-fold ordering (brief 3b): the shown chances are
    // ordered like the OOF risks WITHIN each fold — the fold's conversion is
    // monotone, and the fixture's event pattern makes it rise with the risk
    // order, so each fold's values are non-decreasing in the (one cohort
    // predict's) risk. Across folds the order may differ (each fold has its
    // own curve — that is expected), so the old global order pin is restored
    // per fold, not over the whole column.
    let mut per_fold: Vec<Vec<(f64, f64)>> = vec![Vec::new(); CROSS_FIT_FOLDS];
    for line in &lines {
        let id = line[0];
        let p: f64 = line[1].parse().expect("probability");
        let k = *fold_of
            .get(id)
            .expect("every patient is in the cohort's fold");
        per_fold[k].push((scores[id], p));
    }
    for (k, rows) in per_fold.iter().enumerate() {
        assert!(!rows.is_empty(), "fold {k} has patients");
        let mut prev = -1.0f64;
        for (_risk, p) in rows.iter() {
            assert!(
                *p >= prev - 1e-9,
                "fold {k}: shown chances ordered with the OOF risks ({p} after {prev})"
            );
            prev = *p;
        }
    }
    for line in &lines {
        let id = line[0];
        let p: f64 = line[1].parse().expect("probability");
        assert!(
            (0.0..=1.0).contains(&p),
            "{id}: probability in [0, 1] ({p})"
        );
        let k = *fold_of
            .get(id)
            .expect("every patient is in the cohort's fold");
        let want = fold_conversions[k]
            .apply(Some(scores[id]))
            .expect("a scored risk");
        assert!(
            (p - want).abs() < 1e-6,
            "{id}: the shown chance is the fold's own conversion ({p} vs {want})"
        );
        assert_eq!(line.len(), 3, "patient_id,probability,note");
        assert!(
            line[2].is_empty(),
            "a scored patient carries no note (the note cell is the abstention's reason)"
        );
    }

    // The raw container output is untouched provenance.
    let raw = row_dir(&row.dir).join("output/ctdna-tf-four-group/predictions.csv");
    let raw_text = std::fs::read_to_string(&raw).expect("raw kept");
    assert!(raw_text.contains("risk"), "raw columns untouched");
}

/// TEST-EE-14 (native half): a method that DECLARES its probability keeps
/// `prob_source: "native"` and its recorded column is the container's OWN
/// declared column bytes (never re-derived) — brief 3: a native LEARNER
/// cross-fits, so the shown value is its OOF fold call's verbatim value.
#[tokio::test]
async fn native_method_keeps_its_probability_verbatim() {
    crate::skip_unless_host_env!();
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

    // jm-lme declares `p_progression_H*`: the shown column stays native
    // (never converted, never re-derived) — brief 3 makes a native LEARNER
    // cross-fit, so the recorded value is the OOF native probability of the
    // patient's OWN fold call, not the final full-fit column's; both are the
    // method's own verbatim values (the record is the module's `{:.6}`
    // format of the same float, so the pin is on the parsed value, never the
    // byte representation — the raw file's `0.2` and `0.200000` are the same
    // probability).
    let bundle_dir = row_dir(&row.dir).join("bundles/jm-lme/train/outcomes.csv");
    let outcomes =
        parsed_outcomes(&std::fs::read_to_string(&bundle_dir).expect("the recorded outcomes file"));
    let folds = cohort_folds_public(&outcomes);
    let fold_of: std::collections::BTreeMap<&str, usize> = outcomes
        .iter()
        .map(|(id, _, _)| id.as_str())
        .zip(&folds)
        .map(|(id, k)| (id, *k))
        .collect();
    let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
    let full_scored = calls[calls.len() - 1].scored.clone();
    drop(calls);
    let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
    // The shown column is the OOF one — assert that explicitly: each row
    // equals its own fold call's native value (the fixture's formula on the
    // fold call's scored order — the method's own verbatim value, never
    // re-derived), and at least one patient differs from the final full-fit
    // value.
    let mut differs_from_full_fit = false;
    let chance = row_dir(&row.dir).join("output/jm-lme/chance.csv");
    let text = std::fs::read_to_string(&chance).expect("chance.csv");
    for line in text.lines().skip(1) {
        let cells: Vec<&str> = line.split(',').collect();
        let id = cells[0];
        let p: f64 = cells[1].parse().expect("probability");
        let k = *fold_of
            .get(id)
            .expect("every patient is in the cohort's fold");
        let fold_scored = &calls[2 + 2 * k].scored;
        let idx = seam_index(fold_scored, id).expect("the fold scored the patient");
        let want = 0.2 + ((idx % 12) as f64) * 0.05;
        assert!(
            (p - want).abs() < 1e-6,
            "{id}: the shown native value is the OOF one ({p} vs {want})"
        );
        if let Some(i) = seam_index(&full_scored, id) {
            let full = 0.2 + ((i % 12) as f64) * 0.05;
            if (full - want).abs() > 1e-12 {
                differs_from_full_fit = true;
            }
        }
    }
    assert!(
        differs_from_full_fit,
        "the OOF indices differ from the full-fit's on this cohort: the test must see a difference"
    );
    // The raw container output is untouched provenance.
    let raw = row_dir(&row.dir).join("output/jm-lme/predictions.csv");
    let raw_text = std::fs::read_to_string(&raw).expect("raw kept");
    assert!(raw_text.contains("risk"), "raw columns untouched");
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
    crate::skip_unless_host_env!();
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

    // Brief 3: the shown chance of a cohort patient is the cross-checked one
    // — the ONE cohort predict's score converted by the patient's own fold's
    // conversion, which the run fitted on the OTHER folds' cohort scores. The
    // final predict call's REVERSED ranking never becomes the shown ranking:
    // the shown column orders with the CROSS-CHECKED (the training call's
    // rising) scores — C01 < C30 — and the fit is still never rebuilt from
    // the predict call's own ranking.
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
        first.1 < last.1,
        "the shown column orders with the cross-checked (training-call rising) scores: C01 < C30"
    );
    // And the exact values are the fold conversions over the TRAINING call's
    // RISING risks — recomputed from the public pieces, so the reversed
    // predict ranking demonstrably did not flow through.
    let recorded_outcomes =
        row_dir(&row.dir).join("bundles/ctdna-tf-four-group/train/outcomes.csv");
    let outcomes = parsed_outcomes(
        &std::fs::read_to_string(&recorded_outcomes).expect("the recorded outcomes file"),
    );
    let folds = cohort_folds_public(&outcomes);
    let fold_of: std::collections::BTreeMap<&str, usize> = outcomes
        .iter()
        .map(|(id, _, _)| id.as_str())
        .zip(&folds)
        .map(|(id, k)| (id, *k))
        .collect();
    let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
    let training_scored = calls[1].scored.clone();
    drop(calls);
    let scores: std::collections::BTreeMap<String, f64> = training_scored
        .iter()
        .map(|id| {
            (
                id.clone(),
                0.1 + seam_index(&training_scored, id).expect("scored") as f64 * 0.05,
            )
        })
        .collect();
    let fold_conversions = fold_conversion_public(&outcomes, &scores, &folds);
    for (id, p) in &probs {
        let k = *fold_of
            .get(id.as_str())
            .expect("every patient is in a fold");
        let want = fold_conversions[k]
            .apply(Some(scores[id]))
            .expect("a scored risk");
        assert!(
            (p - want).abs() < 1e-6,
            "{id}: the cross-checked value is the fold's own conversion ({p} vs {want})"
        );
    }
    // Restored within-fold ordering (brief 3b): within each fold the shown
    // chances are ordered like the CROSS-CHECKED (the training call's rising)
    // scores — the fold's conversion is monotone, so the per-fold order is
    // the same as per-fold risk order. Across folds the order may differ
    // (each fold has its own curve — expected), so the global order
    // assertion is restored per fold, not over the whole column.
    let mut per_fold: Vec<Vec<f64>> = vec![Vec::new(); CROSS_FIT_FOLDS];
    for (id, p) in &probs {
        let k = *fold_of
            .get(id.as_str())
            .expect("every patient is in a fold");
        per_fold[k].push(*p);
    }
    for (k, rows) in per_fold.iter().enumerate() {
        assert!(!rows.is_empty(), "fold {k} has patients");
        let mut prev = -1.0f64;
        for p in rows {
            assert!(
                *p >= prev - 1e-9,
                "fold {k}: shown chances ordered with the OOF risks ({p} after {prev})"
            );
            prev = *p;
        }
    }
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
