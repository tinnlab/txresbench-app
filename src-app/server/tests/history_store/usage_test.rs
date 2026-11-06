//! TEST-HS-13/23 — the K footer's usage figure over the real server: the
//! recursive byte walk of the app data root grouped by top-level segment
//! (`analysis-*` → runs, `models/` → models, everything else → other), the
//! DB run count (never the walk's), the USER-VISIBLE `data_dir` (GAP-HIST-1:
//! the UI never hardcodes or derives a path from a run dir), the fresh
//! stamp, and the 10-second TTL (a later call after expiry re-walks and
//! reflects the fs change; the unit level pins the cache mechanics).

use std::time::Duration;

use serde_json::Value;

use super::{owner_token, pool, seed_run, SeedMethod, SeedRun};
use crate::common::TestServer;
use chrono::{DateTime, Utc};
use cytoanalyst::modules::execution_engine::repository::TxrRepository;
use cytoanalyst::modules::execution_engine::types::{TxrMethodState, TxrRunMode, TxrRunStatus};

fn at(s: &str) -> DateTime<Utc> {
    s.parse().expect("fixture timestamp")
}

/// TEST-HS-13 + TEST-HS-23 — the usage response: `run_count` is the DB's, the
/// bytes are the walk's, grouped per segment (an env cache under `txr-envs/`
/// lands in `other_bytes`), `data_dir` equals the configured data root (the
/// test-isolated `CYTO_APP_DATA_DIR`), `computed_at` is fresh, and after the
/// TTL expires a changed data root is reflected.
#[tokio::test]
async fn usage_walks_grouped_and_expires_after_the_ttl() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);
    let root = server.data_dir().to_path_buf();

    // The data-root shapes with known byte counts: one run dir, a `models/`
    // tree, an env-cache file under `txr-envs/`.
    let run_dir = root.join("analysis-2026-10-20-1200-hs-usage01");
    std::fs::create_dir_all(run_dir.join("input")).expect("run dir");
    std::fs::write(run_dir.join("input/patients.csv"), b"patient_id,outcome\n").expect("csv");
    std::fs::write(run_dir.join("input/measurements.csv"), b"patient_id,day,m,v\n").expect("csv");
    let run_bytes = std::fs::metadata(run_dir.join("input/patients.csv"))
        .expect("meta")
        .len()
        + std::fs::metadata(run_dir.join("input/measurements.csv"))
            .expect("meta")
            .len();

    let models_dir = root.join("models/trees");
    std::fs::create_dir_all(&models_dir).expect("models dir");
    std::fs::write(models_dir.join("tree.w"), vec![0u8; 100]).expect("model bytes");
    let models_bytes = 100u64;

    let env_dir = root.join("txr-envs");
    std::fs::create_dir_all(&env_dir).expect("env dir");
    std::fs::write(env_dir.join("env.json"), b"{\"id\":\"x\"}\n").expect("env bytes");
    let env_bytes = std::fs::metadata(env_dir.join("env.json")).expect("meta").len();

    // Two run rows (the DB truth; the dirs' bytes are walked, the count is
    // not derived from the walk — PROV-HS-6). Both record the SAME manually
    // shaped analysis dir (its bytes are the `runs_bytes` figure); nothing
    // else under the data root starts with `analysis-`.
    let (r1_id, _) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T12:00:00+00:00"),
            started_at: Some(at("2026-10-20T12:00:01+00:00")),
            finished_at: Some(at("2026-10-20T12:05:00+00:00")),
            elapsed_secs: Some(300),
            predictions_ready: true,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(30),
            predict_patients: Some(5),
            markers: 2,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "jm-mem-lq",
                state: TxrMethodState::Finished,
                reason: None,
                elapsed_secs: Some(300),
                finished_at: Some(at("2026-10-20T12:05:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Record(run_dir.display().to_string()),
        },
    )
    .await;
    let _ = r1_id;
    let (r2_id, _) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T13:00:00+00:00"),
            started_at: Some(at("2026-10-20T13:00:01+00:00")),
            finished_at: Some(at("2026-10-20T13:01:00+00:00")),
            elapsed_secs: Some(60),
            predictions_ready: false,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(5),
            predict_patients: None,
            markers: 2,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "jm-mem-lq",
                state: TxrMethodState::Finished,
                reason: None,
                elapsed_secs: Some(60),
                finished_at: Some(at("2026-10-20T13:01:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Record(run_dir.display().to_string()),
        },
    )
    .await;
    let _ = r2_id;

    // The first call: the fresh computation.
    let resp = server
        .client
        .get(server.api_url("/txr/history/usage"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("usage");
    assert_eq!(resp.status().as_u16(), 200);
    let usage: Value = resp.json().await.expect("usage json");
    assert_eq!(usage["run_count"], 2, "the DB truth, never the walk's dirs");
    assert_eq!(usage["runs_bytes"], run_bytes);
    assert_eq!(usage["models_bytes"], models_bytes);
    assert!(
        usage["other_bytes"].as_u64().expect("other") >= env_bytes,
        "the env cache lands in other (plus the boot-time cache dirs)"
    );
    assert_eq!(
        usage["total_bytes"],
        usage["runs_bytes"].as_u64().unwrap()
            + usage["models_bytes"].as_u64().unwrap()
            + usage["other_bytes"].as_u64().unwrap(),
        "total is the sum of the three segments"
    );
    assert!(
        usage["data_dir"].as_str().expect("data_dir") == root.to_str().expect("utf8"),
        "TEST-HS-23: the configured data root (user-visible), never a run-dir-derived path"
    );
    let computed_at: chrono::DateTime<Utc> = usage["computed_at"]
        .as_str()
        .expect("computed_at")
        .parse()
        .expect("rfc3339");
    assert!(
        (Utc::now() - computed_at).num_seconds() < 30,
        "the stamp is fresh"
    );

    // After the TTL expires the next call re-walks and reflects the change
    // (the cache is 10 seconds; the unit level pins the mechanics, this leg
    // pins the honest refresh).
    std::fs::write(run_dir.join("input/extra.csv"), vec![0u8; 25]).expect("extra bytes");
    tokio::time::sleep(Duration::from_secs(11)).await;
    let usage2: Value = server
        .client
        .get(server.api_url("/txr/history/usage"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("usage")
        .json()
        .await
        .expect("usage json");
    assert_eq!(usage2["runs_bytes"], run_bytes + 25, "the walk reflects the fs change");
}
