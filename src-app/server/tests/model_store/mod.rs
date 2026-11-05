//! The `model_store` integration suites (TEST-MS-08/09/10/15/16, the ITEM-5
//! surface): the save-from-run flow, the inventory/set CRUD, the `.txr`
//! import/export round trip over the real multipart route, the pretrained
//! import seam and the route matrix — all over the real spawned server
//! (`TestServer` + the local-owner mint) with rows seeded through the engine's
//! own repository over the per-test DB (the `execution_engine` suite's
//! discipline: no method runs here, every stateful shape is seeded, and the
//! produced trees are synthetic opaque bytes — patient ids S0000.., markers
//! M1/M2 — never real data, never the restricted trees).
//!
//! ITEM-6 will add `eligibility_test.rs` (TEST-MS-11..14) and ITEM-7 the
//! guard runbook + README; the files here are the routes' verification.

mod api_test;
mod roundtrip_test;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Value};
use uuid::Uuid;

use super::common::TestServer;
use cytoanalyst::modules::execution_engine::envmanifest;
use cytoanalyst::modules::execution_engine::repository::{
    MethodPatch, NewMethod, NewRun, TxrRepository,
};
use cytoanalyst::modules::execution_engine::types::{
    RunConfig, TxrMethodState, TxrRunCounts, TxrRunFileNames, TxrRunInputSummary, TxrRunMode,
    TxrRunStatus, TxrTask,
};
use cytoanalyst::modules::method_catalogue::catalogue;
use cytoanalyst::modules::sandbox::stack::tree_sha256;

// ─────────────────────────────── shared helpers ──────────────────────────────

/// The 8-hex run-name salt (per-test unique-ish).
fn id8() -> String {
    static SEQ: AtomicUsize = AtomicUsize::new(1);
    format!("{:08x}", SEQ.fetch_add(1, Ordering::SeqCst))
}

/// The fixed-owner mint (the local session) → bearer token.
pub async fn owner_token(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({}))
        .send()
        .await
        .expect("local session");
    assert_eq!(resp.status().as_u16(), 200, "local session mints the owner");
    let body: Value = resp.json().await.expect("session body");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("session carries a token")
        .to_string()
}

/// The `error_code` of the framework error body.
pub fn error_code(body: &Value) -> String {
    body["error_code"]
        .as_str()
        .or_else(|| body["error"]["error_code"].as_str())
        .unwrap_or_else(|| panic!("no error_code in body: {body}"))
        .to_string()
}

/// The per-test pool (the same database the spawned server serves).
pub async fn pool(server: &TestServer) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("per-test pool connects")
}

/// A synthetic produced tree (opaque bytes — the store never opens them for
/// meaning): `model.json` + a nested weights file. Returns the dir + the
/// engine's own digest + the byte size.
pub fn fixture_tree(dir: &Path, variant: &str) -> (PathBuf, String, u64) {
    std::fs::create_dir_all(dir.join("weights")).expect("fixture tree dirs");
    std::fs::write(
        dir.join("model.json"),
        format!(r#"{{"contract":"2.0","method":"fixture","variant":"{variant}"}}"#),
    )
    .expect("fixture model.json");
    std::fs::write(
        dir.join("weights").join("tree-01.bin"),
        format!("opaque\x00{variant}\x00bytes"),
    )
    .expect("fixture tree file");
    let digest = tree_sha256(dir).expect("fixture digest");
    let size = std::fs::metadata(dir.join("model.json"))
        .expect("meta")
        .len()
        + std::fs::metadata(dir.join("weights").join("tree-01.bin"))
            .expect("meta")
            .len();
    (dir.to_path_buf(), digest, size)
}

/// One seeded produced method: a run method row patched to the FULL produced
/// record (the grown model fields + `finished_at` + `task`) with the env
/// digests of the method's CURRENT manifest entry (so a happy-path save
/// records the current digests — no false DIGEST_MISMATCH).
pub struct SeededMethod {
    pub method_id: String,
    pub dir: PathBuf,
    pub digest: String,
    pub size: u64,
}

/// Seed a FINISHED train run whose methods carry produced-model rows + the
/// run dir tree (input/, bundles/<method>/params.json, models/<method>).
/// Returns `(run_id, run_dir)`.
pub async fn seed_run_with_models(
    server: &TestServer,
    repo: &TxrRepository,
    name: &str,
    method_ids: &[&str],
) -> (Uuid, PathBuf) {
    let run_dir = server
        .data_dir()
        .join(format!("analysis-2026-10-26-1002-{}-{}", name, id8()));
    std::fs::create_dir_all(run_dir.join("input")).expect("seed input dir");
    std::fs::write(
        run_dir.join("input").join("patients.csv"),
        b"patient_id,outcome\nS0001,1\nS0002,0\n",
    )
    .expect("seed input patients");
    std::fs::write(run_dir.join("input").join("values.csv"), b"patient_id,day,marker,value\n")
        .expect("seed input values");

    let mut method_rows = Vec::new();
    for mid in method_ids {
        let facts = catalogue::method(mid).expect("catalogue method");
        let bundle_dir = run_dir.join("bundles").join(mid);
        std::fs::create_dir_all(&bundle_dir).expect("seed bundle dir");
        // The contract 2.0 params.json field set (TEST-EE-18's layout); the
        // store records `markers` as the model's features (DRIFT-1 ITEM-1).
        std::fs::write(
            bundle_dir.join("params.json"),
            json!({
                "landmark_day": 56.0,
                "horizons": [238.0],
                "outcomes": [{"task": "pfs", "column": "pfs_event"}],
                "markers": ["M1", "M2"],
                "baseline_max_day": 0.0,
                "covariates": false,
                "method_params": {},
                "seed": 1,
                "threads": 4,
            })
            .to_string(),
        )
        .expect("seed params.json");
        let model_dir = run_dir.join("models").join(mid);
        let (dir, digest, size) = fixture_tree(&model_dir, &format!("{mid}-{name}"));
        let _ = dir;
        let entry = envmanifest::env_for(mid).expect("a manifest entry for the seeded method");
        let env = cytoanalyst::modules::execution_engine::types::TxrMethodEnv {
            base_digest: entry
                .base_digest
                .strip_prefix("sha256:")
                .unwrap_or(&entry.base_digest)
                .to_string(),
            layer_digest: entry.layer_sha256.clone(),
        };
        method_rows.push(SeededMethod {
            method_id: mid.to_string(),
            dir: model_dir,
            digest,
            size,
        });
        let _ = facts;
    }

    let run = NewRun {
        id: Uuid::new_v4(),
        created_at: Some("2026-10-19T14:30:00+00:00".parse().expect("fixture date")),
        status: TxrRunStatus::Finished,
        mode: TxrRunMode::Train,
        config: RunConfig {
            endpoint: cytoanalyst::modules::execution_engine::types::TxrEndpoint::Pfs,
            decision_day: 56.0,
            look_ahead_day: 238.0,
            at_a_time: 2,
            save_models: true,
            ..Default::default()
        },
        input_summary: TxrRunInputSummary {
            patients: Some(2),
            predict_patients: None,
            markers: 2,
            events: Some(1),
            file_names: TxrRunFileNames {
                patients: Some("patients.csv".to_string()),
                measurements: "values.csv".to_string(),
                predict_measurements: None,
            },
        },
        model_ids: Vec::new(),
        method_count: method_ids.len() as u32,
        counts: TxrRunCounts {
            finished: method_ids.len() as u32,
            failed: 0,
            stopped: 0,
            skipped: 0,
            cannot_run: 0,
            running: 0,
            downloading: 0,
            waiting: 0,
        },
        dir: run_dir.display().to_string(),
        memory_total_bytes: Some(16 * 1024 * 1024 * 1024),
        cpus: Some(4),
        seed: 1,
        estimate: None,
    };
    repo.insert_run(&run).await.expect("seed run");

    for m in &method_rows {
        let facts = catalogue::method(&m.method_id).expect("catalogue facts");
        let entry = envmanifest::env_for(&m.method_id).expect("manifest entry");
        let method = NewMethod {
            id: Uuid::new_v4(),
            run_id: run.id,
            method_id: m.method_id.clone(),
            label: facts.id.clone(),
            version: facts.version.clone(),
            group: facts.group.as_str().to_string(),
            state: TxrMethodState::Finished,
            bytes_total: Some(250 * 1024 * 1024),
        };
        repo.insert_method(&method).await.expect("seed method");
        repo.patch_method(
            run.id,
            &m.method_id,
            &MethodPatch {
                task: Some(TxrTask::Pfs),
                model_out_digest: Some(m.digest.clone()),
                model_dir: Some(m.dir.display().to_string()),
                env_base_digest: Some(
                    entry
                        .base_digest
                        .strip_prefix("sha256:")
                        .unwrap_or(&entry.base_digest)
                        .to_string(),
                ),
                env_layer_digest: Some(entry.layer_sha256.clone()),
                trained_on_patients: Some(2),
                size_bytes: Some(m.size),
                own_auc: Some(0.66),
                finished_at: Some("2026-10-19T15:00:00+00:00".parse().expect("fixture date")),
                ..Default::default()
            },
        )
        .await
        .expect("patch produced-model facts");
    }

    (run.id, run_dir)
}
