//! The HTTP-surface integration suite (TEST-EE-05/19/20/25/26/30 + the
//! seeded halves of TEST-EE-19/35/36): the real spawned server + the
//! local-owner mint, with every stateful shape seeded through the module's
//! own repository over the per-test DB (`TestServer::database_url`) — no
//! method executes here (the drive-level execution is the sibling files;
//! the server's own drive uses the real provider, whose layers are host-
//! gated).

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Value};
use uuid::Uuid;

use super::{cohort_run_body, error_code, owner_token, pool, register_user};
use crate::common::TestServer;
use txresbench::modules::execution_engine::envmanifest;
use txresbench::modules::execution_engine::reconcile::reconcile_interrupted_runs;
use txresbench::modules::execution_engine::repository::{
    MethodPatch, NewMethod, NewRun, TxrRepository,
};
use txresbench::modules::execution_engine::types::{
    RunConfig, TxrMethodState, TxrProbSource, TxrRunCounts, TxrRunFileNames, TxrRunInputSummary,
    TxrRunMode, TxrRunStatus, TxrTask,
};
use txresbench::modules::sandbox::stack::{validate_oci_ref, TXR_LAYER_REGISTRY_PREFIX};

static SEQ: AtomicUsize = AtomicUsize::new(1);

/// The 401/403 matrix route list — (verb, path template) with `{id}` bound.
fn route_matrix() -> Vec<(&'static str, String)> {
    let id = "00000000-0000-0000-0000-00000000abcd";
    let mid = "cox-cutpoint-risk";
    let mut out: Vec<(&'static str, String)> = vec![
        ("GET", format!("/txr/runs")),
        ("GET", format!("/txr/runs/{id}")),
        ("GET", format!("/txr/runs/{id}/stream")),
        ("GET", format!("/txr/runs/{id}/logs")),
        ("GET", format!("/txr/runs/{id}/predictions")),
        ("GET", format!("/txr/runs/{id}/predictions.csv")),
        ("GET", format!("/txr/analysis-config")),
        ("POST", format!("/txr/runs")),
        ("POST", format!("/txr/runs/{id}/stop")),
        ("POST", format!("/txr/runs/{id}/methods/{mid}/stop")),
        ("POST", format!("/txr/runs/{id}/methods/{mid}/skip")),
        ("POST", format!("/txr/runs/{id}/rerun")),
        ("POST", format!("/txr/runs/{id}/at-a-time")),
        ("DELETE", format!("/txr/runs/{id}")),
        ("DELETE", format!("/txr/runs")),
        ("PUT", format!("/txr/analysis-config")),
    ];
    out.dedup();
    out
}

async fn seed_run(
    server: &TestServer,
    repo: &TxrRepository,
    name: &str,
    status: TxrRunStatus,
    at_a_time: u32,
) -> Uuid {
    let dir = server
        .data_dir()
        .join(format!("analysis-2026-10-26-1002-{}-{}", name, id8()));
    std::fs::create_dir_all(dir.join("input")).expect("seed run dir");
    std::fs::create_dir_all(dir.join("output/cox-cutpoint-risk")).expect("seed output dir");
    let run = NewRun {
        id: Uuid::new_v4(),
        created_at: Some(chrono::Utc::now()),
        status,
        mode: TxrRunMode::Train,
        config: RunConfig {
            endpoint: txresbench::modules::execution_engine::types::TxrEndpoint::Pfs,
            decision_day: 56.0,
            look_ahead_day: 238.0,
            at_a_time,
            ..Default::default()
        },
        input_summary: TxrRunInputSummary {
            patients: Some(30),
            predict_patients: None,
            markers: 1,
            events: Some(15),
            file_names: TxrRunFileNames {
                patients: Some("patients.csv".to_string()),
                measurements: "values.csv".to_string(),
                predict_measurements: None,
            },
        },
        model_ids: Vec::new(),
        method_count: 1,
        counts: TxrRunCounts {
            finished: if status == TxrRunStatus::Finished {
                1
            } else {
                0
            },
            failed: 0,
            stopped: 0,
            skipped: 0,
            cannot_run: 0,
            running: if status == TxrRunStatus::Running {
                1
            } else {
                0
            },
            downloading: 0,
            waiting: 0,
        },
        dir: dir.display().to_string(),
        memory_total_bytes: Some(16 * 1024 * 1024 * 1024),
        cpus: Some(4),
        seed: 1,
        estimate: None,
    };
    repo.insert_run(&run).await.expect("seed run");
    // One finished method with the FULL column facts (the G surface reads
    // the row's coverage/prob_source/task + the recorded chance.csv).
    let m = NewMethod {
        id: Uuid::new_v4(),
        run_id: run.id,
        method_id: "cox-cutpoint-risk".to_string(),
        label: "cox-cutpoint-risk".to_string(),
        version: "2.0.1".to_string(),
        group: "landmark".to_string(),
        state: TxrMethodState::Finished,
        bytes_total: Some(250 * 1024 * 1024),
    };
    repo.insert_method(&m).await.expect("seed method");
    repo.patch_method(
        run.id,
        "cox-cutpoint-risk",
        &MethodPatch {
            prob_source: Some(TxrProbSource::Native),
            coverage_scored: Some(30),
            coverage_eligible: Some(30),
            task: Some(TxrTask::Pfs),
            duration_ms: Some(42),
            exit_code: Some(0),
            ..Default::default()
        },
    )
    .await
    .expect("patch method facts");

    // The recorded column the predictions route serves.
    let mut csv = String::from("patient_id,probability,note\n");
    for i in 1..=30 {
        csv.push_str(&format!("C{i:02},{:.6},\n", 0.2 + (i as f64) * 0.01));
    }
    std::fs::write(dir.join("output/cox-cutpoint-risk/chance.csv"), csv).expect("seed chance.csv");
    run.id
}

fn id8() -> String {
    format!("{:08x}", SEQ.fetch_add(1, Ordering::SeqCst))
}

fn seed_rerun_input(dir: &PathBuf) {
    // The create-time request verbatim (the rerun seam reads it).
    let body = cohort_run_body(&["jm-mem-lq"], 3, false);
    let record = json!({
        "mode": body["mode"],
        "input": body["input"],
        "config": body["config"],
        "method_ids": ["jm-mem-lq"],
        "model_ids": [],
        "rerun_of": null,
    });
    std::fs::write(dir.join("input/run-input.json"), record.to_string())
        .expect("seed run-input.json");
    // The canonical snapshot the History "open the folder" promise names.
    std::fs::write(dir.join("input/patients.csv"), "patient_id\nC01\n").expect("seed csv");
}

/// TEST-EE-05: with no benchmark tree and no `SIGTRANS_ROOT` the spawned
/// server serves the engine surface entirely from the committed embedded
/// files — the empty list, the 404 refusal and a run whose rows carry the
/// embedded catalogue facts + the manifest's `bytes_total`.
#[tokio::test]
async fn embedded_data_serves_the_surface_without_a_benchmark_tree() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let resp = server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list runs");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("list json");
    assert_eq!(body["total"], 0);

    let missing = Uuid::new_v4();
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{missing}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("get unknown");
    assert_eq!(resp.status().as_u16(), 404);
    let body: Value = resp.json().await.expect("error json");
    assert_eq!(error_code(&body), "RUN_NOT_FOUND");

    // A real create through the embedded facts: jm-mem-lq is a runnable
    // catalogue method with NO published layer — the run starts, classifies
    // the method cannot_run + ENV_IMAGE_MISSING (the ITEM-2 code the
    // eligibility stage pushes first — never erased, never a silent
    // hole), and finishes.
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&cohort_run_body(&["jm-mem-lq"], 3, false))
        .send()
        .await
        .expect("create");
    assert_eq!(resp.status().as_u16(), 202);
    let summary: Value = resp.json().await.expect("summary json");
    let id = summary["id"].as_str().expect("id").to_string();

    let mut detail = Value::Null;
    for _ in 0..300 {
        let resp = server
            .client
            .get(server.api_url(&format!("/txr/runs/{id}")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("detail");
        detail = resp.json().await.expect("detail json");
        let status = detail["status"].as_str().unwrap_or("");
        if matches!(status, "finished" | "failed" | "stopped") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(detail["status"], "finished", "{detail}");
    assert_eq!(detail["counts"]["cannot_run"], 1, "{detail}");
    let method = &detail["methods"][0];
    assert_eq!(method["method_id"], "jm-mem-lq");
    assert_eq!(method["state"], "cannot_run");
    assert_eq!(method["reason"]["code"], "ENV_IMAGE_MISSING", "{method}");
    assert_eq!(
        method["label"], "jm-mem-lq",
        "the catalogue id is the label"
    );
    assert!(
        method["version"].as_str().is_some(),
        "the catalogue version is recorded"
    );
    assert!(
        method["bytes_total"].is_null(),
        "no manifest entry → no download total"
    );

    // The embedded answers for a method WITH an entry (the manifest's
    // size_bytes is the F screen's denominator).
    let entry = envmanifest::env_for("cox-cutpoint-risk").expect("entry");
    assert!(entry.size_bytes > 0);
    let facts = envmanifest::facts_for("cox-cutpoint-risk").expect("facts");
    assert!(facts.group_label.as_str().len() > 0);
}

/// TEST-EE-05's boot half: the loader refusal the boot path converts into its
/// named boxed error — a mangled manifest can never be embedded at runtime,
/// so the refusal + the boot wrapper's named-code contract are pinned here
/// over the REAL loader, and the shipped bytes prove they PASS the check.
#[test]
fn a_mangled_manifest_refuses_with_the_named_loader_code() {
    let mangled = br#"{"schema_version": 2, "generator_version": "x", "source_revision": "x", "base_contract": "2.0", "envs": []}"#;
    let err = envmanifest::parse_manifest(mangled).expect_err("schema 2 refuses");
    assert_eq!(err.code(), "MANIFEST_SCHEMA_VERSION");
    // The module init's wrapper text (the boot refusal the operator sees).
    let wrapped = format!("method env manifest load failed: {err}");
    assert!(wrapped.contains("MANIFEST_SCHEMA_VERSION"), "{wrapped}");

    let empty = br#"{"schema_version": 1, "generator_version": "x", "source_revision": "x", "base_contract": "2.0", "envs": []}"#;
    assert_eq!(
        envmanifest::parse_manifest(empty)
            .expect_err("empty envs refuses")
            .code(),
        "MANIFEST_EMPTY"
    );

    // The SHIPPED bytes pass their own boot check (the first-party posture —
    // a corrupted install refuses loudly, a healthy one boots).
    assert!(
        envmanifest::ensure_loaded().is_ok(),
        "the committed manifest passes its boot validation"
    );
}

/// TEST-EE-20: the K screen's surface — newest-first list with the config +
/// input summary + dir, the sticky analysis-config round-trip, rerun with the
/// same settings from the stored input record, and delete with the copy
/// semantics (`delete_files=false` keeps the folder).
#[tokio::test]
async fn history_surface_lists_reruns_deletes_and_round_trips_the_config() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let p = pool(&server).await;
    let repo = TxrRepository::new(p.clone());

    // The sticky config round-trip.
    let cfg = json!({
        "config": {
            "endpoint": "os",
            "decision_day": 42.0,
            "look_ahead_day": 180.0,
            "covariates": true,
            "at_a_time": 2,
            "cpus": 4,
            "save_models": true,
            "label_day": 28.0,
        },
        "last_input_summary": {"patients": 151, "predict_patients": 38, "markers": 5},
    });
    let resp = server
        .client
        .put(server.api_url("/txr/analysis-config"))
        .bearer_auth(&token)
        .json(&cfg)
        .send()
        .await
        .expect("put config");
    assert_eq!(resp.status().as_u16(), 204);
    let resp = server
        .client
        .get(server.api_url("/txr/analysis-config"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("get config");
    let body: Value = resp.json().await.expect("config json");
    assert_eq!(body["config"]["decision_day"], 42.0);
    assert_eq!(body["last_input_summary"]["patients"], 151);

    // Seed two runs: the rerun source (with its stored input record) and an
    // older failed one.
    let id_a = seed_run(&server, &repo, "rerun-src", TxrRunStatus::Finished, 3).await;
    let dir_a = PathBuf::from(repo.get_run(id_a).await.expect("get").expect("row").dir);
    seed_rerun_input(&dir_a);
    let id_b = seed_run(&server, &repo, "older", TxrRunStatus::Failed, 3).await;
    let dir_b = PathBuf::from(repo.get_run(id_b).await.expect("get").expect("row").dir);
    // The list orders `created_at DESC, id DESC`; two seeds inside one tick
    // are a tie (id DESC = a random winner), so the older row is back-dated
    // through the same chrono codec the repository writes.
    sqlx::query("UPDATE txr_runs SET created_at = ?1 WHERE id = ?2")
        .bind(chrono::Utc::now() - chrono::Duration::minutes(5))
        .bind(id_b)
        .execute(&p)
        .await
        .expect("backdate the older run");

    let resp = server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    let body: Value = resp.json().await.expect("list json");
    let runs = body["runs"].as_array().expect("runs array");
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0]["id"], id_a.to_string(), "newest first");
    assert_eq!(runs[1]["id"], id_b.to_string());
    assert_eq!(runs[0]["config"]["decision_day"], 56.0);
    assert_eq!(runs[0]["dir"], json!(dir_a.display().to_string()));
    assert_eq!(
        runs[0]["input_summary"]["file_names"]["measurements"],
        "values.csv"
    );

    // Rerun: the new run clone's config + methods come from the STORED input
    // record; its drive classifies jm-mem-lq cannot_run (+ENV_IMAGE_MISSING)
    // and finishes without touching the sandbox.
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{id_a}/rerun")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("rerun");
    assert_eq!(resp.status().as_u16(), 202, "{resp:?}");
    let new: Value = resp.json().await.expect("rerun json");
    let new_id = new["id"].as_str().expect("rerun json id").to_string();
    assert_ne!(new["id"], id_a.to_string(), "a NEW run id");
    assert_eq!(new["config"]["endpoint"], "pfs");
    assert_eq!(new["config"]["look_ahead_day"], 238.0);
    assert_eq!(new["method_ids"], json!(["jm-mem-lq"]));
    for _ in 0..300 {
        let resp = server
            .client
            .get(server.api_url(&format!("/txr/runs/{new_id}")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("new detail");
        let status = resp.status().as_u16();
        let text = resp.text().await.expect("new detail body");
        let d: Value = serde_json::from_str(&text).unwrap_or_else(|e| {
            panic!(
                "new detail {status} ({new_id}): {e} — body: {:?}",
                &text[..text.len().min(200)]
            )
        });
        if matches!(
            d["status"].as_str(),
            Some("finished" | "failed" | "stopped")
        ) {
            assert_eq!(d["status"], "finished", "{d}");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Delete one keeping the folder, one pruning it.
    let resp = server
        .client
        .delete(server.api_url(&format!("/txr/runs/{id_a}?delete_files=false")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("delete keep");
    assert_eq!(resp.status().as_u16(), 204);
    assert!(dir_a.is_dir(), "delete_files=false keeps the folder");
    let resp = server
        .client
        .delete(server.api_url(&format!("/txr/runs/{id_b}?delete_files=true")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("delete prune");
    assert_eq!(resp.status().as_u16(), 204);
    assert!(!dir_b.exists(), "delete_files=true prunes the folder");

    // Clear all.
    let resp = server
        .client
        .delete(server.api_url("/txr/runs?delete_files=true"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clear");
    assert_eq!(resp.status().as_u16(), 204);
    let resp = server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list after clear");
    let body: Value = resp.json().await.expect("list json");
    assert_eq!(body["total"], 0);
}

/// TEST-EE-19's HTTP half + TEST-EE-35's HTTP half: a run in `running` with
/// ONE finished method serves that method's column (with its `task` enum) and
/// the CSV download while the run continues; the SSE stream replays the
/// snapshot (status + method + prediction frames) and — for a terminal run —
/// closes.
#[tokio::test]
async fn results_while_running_and_the_sse_replay_serve_the_seeded_columns() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let p = pool(&server).await;
    let repo = TxrRepository::new(p.clone());

    // The running run + its one finished column (mixed-task: a response
    // method row too, so the task enum arm of TEST-EE-35 is served).
    let id = seed_run(&server, &repo, "running", TxrRunStatus::Running, 3).await;
    let dir = PathBuf::from(repo.get_run(id).await.expect("get").expect("row").dir);
    std::fs::create_dir_all(dir.join("output/direct-on")).expect("seed second output");
    std::fs::write(
        dir.join("output/direct-on/chance.csv"),
        "patient_id,probability,note\nC01,0.610000,\n",
    )
    .expect("seed response column");
    repo.insert_method(&NewMethod {
        id: Uuid::new_v4(),
        run_id: id,
        method_id: "direct-on".to_string(),
        label: "direct-on".to_string(),
        version: "2.0.0".to_string(),
        group: "response".to_string(),
        state: TxrMethodState::Finished,
        bytes_total: Some(10 * 1024 * 1024),
    })
    .await
    .expect("response method row");
    repo.patch_method(
        id,
        "direct-on",
        &MethodPatch {
            prob_source: Some(TxrProbSource::Native),
            coverage_scored: Some(1),
            coverage_eligible: Some(1),
            task: Some(TxrTask::Response),
            duration_ms: Some(7),
            exit_code: Some(0),
            ..Default::default()
        },
    )
    .await
    .expect("response facts");

    // Results-while-running: the run is still "running".
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{id}/predictions")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("predictions");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("predictions json");
    assert_eq!(body["endpoint"], "pfs");
    assert_eq!(body["horizon"], 238.0);
    assert_eq!(body["patients"].as_array().expect("patients").len(), 30);
    let methods = body["methods"].as_array().expect("methods");
    assert_eq!(methods.len(), 2, "both finished columns, in run order");
    assert_eq!(methods[0]["method_id"], "cox-cutpoint-risk");
    assert_eq!(methods[0]["task"], "pfs", "the enumerated task (CONS-UR-8)");
    assert_eq!(methods[0]["prob_source"], "native");
    assert_eq!(methods[1]["method_id"], "direct-on");
    assert_eq!(
        methods[1]["task"], "response",
        "a response-task method carries its enum"
    );
    assert_eq!(
        methods[0]["probabilities"].as_array().expect("col").len(),
        30,
        "aligned to the patient order"
    );
    assert_eq!(
        methods[1]["probabilities"][0], 0.61,
        "the second method's column aligns by patient id"
    );
    let avg = body["average"].as_array().expect("average");
    assert_eq!(avg.len(), 30, "one average per patient row");
    let first = avg[0].as_f64().expect("average value");
    assert!(
        (first - 0.21).abs() < 1e-9,
        "C01's average covers the run's pfs task only (0.21): the response column never joins the progression mean — qa-fixes2 R2-06's endpoint scope: {first}"
    );

    // CSV download while active.
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{id}/predictions.csv")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("csv");
    assert_eq!(resp.status().as_u16(), 200);
    let text = resp.text().await.expect("csv text");
    assert!(
        text.starts_with("patient_id,cox-cutpoint-risk,direct-on,notes"),
        "DEC-11's header: {text}"
    );
    assert!(text.lines().count() == 31, "header + 30 rows");

    // The SSE replay: subscribe → snapshot frames (status, method, log...,
    // prediction), the run being non-terminal stays open — the snapshot is
    // what we assert.
    let run_id = id.to_string();
    let mut resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{run_id}/stream")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("stream");
    assert_eq!(resp.status().as_u16(), 200);
    let mut body = String::new();
    for _ in 0..200 {
        let Ok(Ok(Some(chunk))) =
            tokio::time::timeout(std::time::Duration::from_secs(15), resp.chunk()).await
        else {
            break;
        };
        body.push_str(&String::from_utf8_lossy(&chunk));
        if body.contains("event: prediction") && body.contains("event: method") {
            break;
        }
    }
    assert!(
        body.contains("event: status"),
        "status frame replayed: {body}"
    );
    assert!(body.contains("event: method"), "method frames replayed");
    assert!(
        body.contains("event: prediction"),
        "prediction frames replayed"
    );
    assert!(
        body.contains("cox-cutpoint-risk"),
        "the finished method's frame: {body}"
    );
}

/// TEST-EE-19's restart half: the boot reconcile (the pass `init` spawns) turns
/// an interrupted run `failed` + `INTERRUPTED`, keeps the finished method's
/// column readable and never auto-reruns.
#[tokio::test]
async fn an_interrupted_run_is_reconciled_and_keeps_finished_results() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let p = pool(&server).await;
    let repo = TxrRepository::new(p.clone());

    let id = seed_run(&server, &repo, "interrupted", TxrRunStatus::Preparing, 3).await;
    // In-flight methods at the interrupt: the reconciler marks each `failed`
    // + `INTERRUPTED` (the run's own `error` column is the DB record; the
    // WIRE carries the reason on the rows — INV-2's "failure kept with its
    // reason", TxrRunReason).
    for mid in ["jm-lme", "landmark-cox-current"] {
        repo.insert_method(&NewMethod {
            id: Uuid::new_v4(),
            run_id: id,
            method_id: mid.to_string(),
            label: mid.to_string(),
            version: "2.0.1".to_string(),
            group: "landmark".to_string(),
            state: TxrMethodState::Waiting,
            bytes_total: Some(250 * 1024 * 1024),
        })
        .await
        .expect("seed in-flight method");
    }
    let report = reconcile_interrupted_runs(&p).await.expect("reconcile");
    assert_eq!(report.runs, 1);

    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail");
    let body: Value = resp.json().await.expect("detail json");
    assert_eq!(body["status"], "failed", "{body}");
    let interrupted = body["methods"]
        .as_array()
        .expect("methods array")
        .iter()
        .find(|m| m["method_id"] == "jm-lme")
        .expect("the in-flight row");
    assert_eq!(interrupted["state"], "failed", "{body}");
    assert_eq!(interrupted["reason"]["code"], "INTERRUPTED", "{body}");
    assert_eq!(
        interrupted["reason"]["detail"], "interrupted on restart",
        "{body}"
    );
    // The finished method's row kept its verdict (no INTERRUPTED rewrite).
    let finished = body["methods"]
        .as_array()
        .expect("methods array")
        .iter()
        .find(|m| m["method_id"] == "cox-cutpoint-risk")
        .expect("the finished row");
    assert_eq!(finished["state"], "finished", "{body}");
    assert!(finished["reason"].is_null(), "{body}");
    // The finished method's result is still readable (DEC-17).
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/runs/{id}/predictions")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("predictions");
    assert_eq!(resp.status().as_u16(), 200);
    // Nothing auto-reruns: the list is unchanged (no new run row).
    let resp = server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    let body: Value = resp.json().await.expect("list json");
    assert_eq!(body["total"], 1);
}

/// TEST-EE-30: the route matrix — 401 unauthenticated on every route, 403 for
/// a restricted user, 404 for an unknown run, the 400 validation refusals and
/// the 409 active-run guard, with the unauthenticated `/health` positive
/// control.
#[tokio::test]
async fn the_route_matrix_is_401_403_404_400_and_409() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    // 401 on every route, unauthenticated.
    for (verb, path) in route_matrix() {
        let resp = match verb {
            "GET" => server
                .client
                .get(server.api_url(&path))
                .send()
                .await
                .expect("request"),
            "POST" => server
                .client
                .post(server.api_url(&path))
                .json(&json!({}))
                .send()
                .await
                .expect("request"),
            "PUT" => server
                .client
                .put(server.api_url(&path))
                .json(&json!({}))
                .send()
                .await
                .expect("request"),
            "DELETE" => server
                .client
                .delete(server.api_url(&path))
                .send()
                .await
                .expect("request"),
            _ => unreachable!(),
        };
        assert_eq!(
            resp.status().as_u16(),
            401,
            "{verb} {path} without a token → 401"
        );
    }

    // 403: a user LACKING jobs::use reaches /health but not txr. Registration
    // grants the seeded `Users` group (which holds jobs::use), so the group
    // is removed over the per-test DB first — the jobs suite's own recipe
    // (TEST-19).
    let (restricted, restricted_id) = register_user(&server, "txr-restricted").await;
    let rp = pool(&server).await;
    crate::common::group_remove_from_users(&rp, restricted_id).await;
    let resp = server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(&restricted)
        .send()
        .await
        .expect("restricted list");
    assert_eq!(resp.status().as_u16(), 403, "the JobsUse gate refuses");
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&restricted)
        .json(&cohort_run_body(&["cox-cutpoint-risk"], 3, false))
        .send()
        .await
        .expect("restricted create");
    assert_eq!(resp.status().as_u16(), 403);
    let resp = server
        .client
        .get(server.api_url("/health"))
        .send()
        .await
        .expect("health");
    assert_eq!(resp.status().as_u16(), 200, "positive control");

    // 404 for an unknown run (all the stateful read/control arms).
    let missing = Uuid::new_v4();
    for path in [
        format!("/txr/runs/{missing}"),
        format!("/txr/runs/{missing}/logs"),
        format!("/txr/runs/{missing}/predictions"),
    ] {
        let resp = server
            .client
            .get(server.api_url(&path))
            .bearer_auth(&token)
            .send()
            .await
            .expect("get");
        assert_eq!(resp.status().as_u16(), 404, "{path}");
        let body: Value = resp.json().await.expect("json");
        assert_eq!(error_code(&body), "RUN_NOT_FOUND", "{path}");
    }
    for path in [
        format!("/txr/runs/{missing}/stop"),
        format!("/txr/runs/{missing}/methods/cox-cutpoint-risk/skip"),
        format!("/txr/runs/{missing}/rerun"),
    ] {
        let resp = server
            .client
            .post(server.api_url(&path))
            .bearer_auth(&token)
            .send()
            .await
            .expect("post");
        assert_eq!(resp.status().as_u16(), 404, "{path}");
    }

    // The 400 validation refusals of TEST-EE-03.
    let mut body = cohort_run_body(&["cox-cutpoint-risk"], 3, false);
    body["method_ids"] = json!([]);
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("empty methods");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        error_code(&resp.json().await.expect("json")),
        "EMPTY_METHODS"
    );

    let body = cohort_run_body(&["cox-cutpoint-risk"], 0, false);
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("bad at_a_time");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        error_code(&resp.json().await.expect("json")),
        "INVALID_AT_A_TIME"
    );

    let mut body = cohort_run_body(&["cox-cutpoint-risk"], 3, false);
    body["config"]["decision_day"] = json!(0.0);
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("bad decision day");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        error_code(&resp.json().await.expect("json")),
        "INVALID_DECISION_DAY"
    );

    let mut body = cohort_run_body(&["cox-cutpoint-risk"], 3, false);
    body["config"]["look_ahead_day"] = json!(900.0);
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("bad look ahead");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        error_code(&resp.json().await.expect("json")),
        "INVALID_LOOK_AHEAD"
    );

    let mut body = cohort_run_body(&["cox-cutpoint-risk"], 3, false);
    body["mode"] = json!("watch");
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .expect("bad mode");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        error_code(&resp.json().await.expect("json")),
        "INVALID_MODE"
    );

    // The at-a-time route's refusal (missing/out-of-range 400 arm).
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/runs/{missing}/at-a-time")))
        .bearer_auth(&token)
        .json(&json!({"at_a_time": 9}))
        .send()
        .await
        .expect("bad lane change");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        error_code(&resp.json().await.expect("json")),
        "INVALID_AT_A_TIME"
    );

    // The 409 active-run guard: seed a live run, then create.
    let p = pool(&server).await;
    let repo = TxrRepository::new(p.clone());
    seed_run(&server, &repo, "live", TxrRunStatus::Preparing, 3).await;
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&cohort_run_body(&["cox-cutpoint-risk"], 3, false))
        .send()
        .await
        .expect("create while active");
    assert_eq!(resp.status().as_u16(), 409);
    assert_eq!(
        error_code(&resp.json().await.expect("json")),
        "RUN_ALREADY_ACTIVE"
    );
}

/// TEST-EE-25: every ref in the committed manifest is scheme-less on the
/// allowlisted prefix (never a host literal in the engine — the manifest is
/// DATA, and its refs pass the provider's OWN validation), and an off-host ref
/// is the provider's typed `ENV_REF_HOST_UNALLOWED`.
#[test]
fn manifest_refs_are_scheme_less_allowlisted_and_typed_when_not() {
    let manifest_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("data/method-env-images.json");
    let bytes = std::fs::read_to_string(&manifest_path).expect("committed manifest");
    // The REF fields carry no scheme (INV-5 — a ref is DATA, and the provider
    // parses it with its own OCI grammar below). Free-text fields of the
    // manifest legitimately cite paper URLs in licence provenance text, so
    // the scheme scan is per-ref, never a byte scan.
    let parsed: Value = serde_json::from_str(&bytes).expect("manifest json");
    let envs = parsed["envs"].as_array().expect("envs");
    assert!(!envs.is_empty());
    for e in envs {
        let oci = e["oci_ref"].as_str().expect("oci_ref");
        assert!(
            !oci.contains("://"),
            "{oci} is scheme-less (the ref is data, never a host literal)"
        );
        assert!(
            oci.starts_with(TXR_LAYER_REGISTRY_PREFIX),
            "{oci} on the allowlisted publish prefix"
        );
        let base = e["base_ref"].as_str().expect("base_ref");
        assert!(
            !base.contains("://"),
            "{base} is scheme-less (the ref is data, never a host literal)"
        );
        assert!(base.starts_with("ghcr.io/tinnlab/"), "{base}");
        assert!(base.contains("txresbench-base-"), "{base}");
        // The REFS pass the provider's own OCI grammar (a byte-parity cross-
        // check of the two nodes' compiled constants).
        validate_oci_ref(oci).expect("the manifest refs validate");
    }

    // An off-allowlist host is the provider's typed refusal, never a retry.
    let err = validate_oci_ref("https://evil.example/not-txr:1").expect_err("off-host");
    assert_eq!(err.error_code(), "ENV_REF_HOST_UNALLOWED");
}

/// TEST-EE-26: the shipped files (module source, README, migrations, the
/// generated OpenAPI's Txr section) carry no build-status / placeholder
/// marker tokens — INV-6 (the run's own `phase`/`progress` vocabulary is the
/// product's, not a build marker).
#[test]
fn shipped_files_carry_no_status_marker_tokens() {
    let module_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/modules/execution_engine");
    let markers = [
        "TODO",
        "FIXME",
        "WIP",
        "XXX",
        "PLACEHOLDER",
        "not yet",
        "coming soon",
    ];
    let mut scanned = String::new();
    for entry in std::fs::read_dir(&module_dir).expect("module dir") {
        let p = entry.expect("entry").path();
        if p.is_file() {
            scanned.push_str(&std::fs::read_to_string(&p).expect("read"));
        }
    }
    for m in markers {
        assert!(!scanned.contains(m), "the module ships no {m:?} marker");
    }

    // The generated OpenAPI's Txr section: descriptions are the same surface
    // (the regen carries them into the typed client).
    let openapi_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/openapi/openapi.json");
    let openapi = std::fs::read_to_string(&openapi_path).expect("openapi");
    let parsed: Value = serde_json::from_str(&openapi).expect("openapi json");
    let ops = &parsed["paths"];
    for (path, item) in ops.as_object().expect("paths") {
        if !path.starts_with("/txr/") {
            continue;
        }
        for op in item.as_object().expect("path item").values() {
            let text = serde_json::to_string(op).expect("serialize op");
            for m in markers {
                assert!(!text.contains(m), "{path} carries {m:?}");
            }
        }
    }

    // The README mentions the run's phase vocabulary — that is the product's;
    // the marker scan above does not contain it either way.
    let readme = std::fs::read_to_string(module_dir.join("README.md")).expect("readme");
    assert!(!readme.contains("TODO") && !readme.contains("FIXME"));
}
