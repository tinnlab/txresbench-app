//! TEST-HS-11/12/14 — the retention policy's integration legs: the per-run
//! and all-runs copy-clear (the ONLY destructive surface of the module —
//! `<run_dir>/input/` only, INV-2; the run row, bundles, per-method outputs,
//! models and logs survive; the lazy retention row lands; `can_rerun` flips
//! false — DEC-6), the tamper matrix (a recorded `dir` of `/`, a foreign
//! path and a symlinked `input/` are each refused with `400 UNSAFE_RUN_DIR`,
//! nothing deleted, the retention row untouched) and the preference
//! round-trip (the migration-seeded default, the id=1 upsert, durability in
//! the per-test DB file, the 422 on a non-schema body — never a code INSERT).

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::{owner_token, pool, seed_run, SeedMethod, SeedRun};
use crate::common::TestServer;
use txresbench::modules::execution_engine::repository::TxrRepository;
use txresbench::modules::execution_engine::types::{
    TxrMethodState, TxrRunMode, TxrRunStatus,
};

fn at(s: &str) -> DateTime<Utc> {
    s.parse().expect("fixture timestamp")
}

/// A minimal finished train run with its run-dir tree (one method).
async fn seed_simple_run(
    server: &TestServer,
    repo: &TxrRepository,
    name: &'static str,
) -> (Uuid, std::path::PathBuf) {
    seed_run(
        server,
        repo,
        SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T09:00:00+00:00"),
            started_at: Some(at("2026-10-20T09:00:01+00:00")),
            finished_at: Some(at("2026-10-20T09:05:00+00:00")),
            elapsed_secs: Some(240),
            predictions_ready: true,
            config: super::config_pfs(),
            files: super::files_train(),
            patients: Some(30),
            predict_patients: Some(10),
            markers: 3,
            model_ids: Vec::new(),
            estimate: None,
            methods: vec![SeedMethod {
                method_id: "cox-cutpoint-risk",
                state: TxrMethodState::Finished,
                reason: None,
                elapsed_secs: Some(240),
                finished_at: Some(at("2026-10-20T09:05:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Create(name),
        },
    )
    .await
}

/// TEST-HS-11 — the per-run clear removes ONLY `<run_dir>/input/`, keeps the
/// run row + `bundles/` + per-method outputs + `models/`, marks the lazy
/// retention row (`copies_kept = 0` + stamp), flips `can_rerun` false, and is
/// idempotent (a second call is a 204 no-op); an unknown run is 404
/// `RUN_NOT_FOUND`; the all-runs clear does the same for every run,
/// idempotently.
#[tokio::test]
async fn copy_clear_removes_input_only_and_marks_retention() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);
    let (run_id, run_dir) = seed_simple_run(&server, &repo, "2026-10-20-0900").await;
    let (other_id, other_dir) = seed_simple_run(&server, &repo, "2026-10-20-0901").await;

    // The seeded run-dir tree facts (the engine's layout — the copies the
    // K board's "Your files" block renders + the analysis artifacts that
    // must SURVIVE the clear).
    assert!(run_dir.join("input").join("patients.csv").is_file());
    assert!(run_dir.join("bundles/cox-cutpoint-risk/params.json").is_file());
    assert!(run_dir.join("output/cox-cutpoint-risk/result.csv").is_file());
    assert!(run_dir.join("models/cox-cutpoint-risk").is_dir());

    // ── per-run clear ─────────────────────────────────────────────────────
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/history/{run_id}/copies/clear")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clear");
    assert_eq!(resp.status().as_u16(), 204);

    assert!(
        !run_dir.join("input").exists(),
        "the user's file copies are removed"
    );
    assert!(
        run_dir.join("bundles/cox-cutpoint-risk/params.json").is_file(),
        "the per-method bundle survives (INV-2)"
    );
    assert!(
        run_dir.join("output/cox-cutpoint-risk/result.csv").is_file(),
        "the per-method output survives"
    );
    assert!(
        run_dir.join("models/cox-cutpoint-risk").is_dir(),
        "the produced-model dir survives"
    );
    assert!(
        repo.get_run(run_id).await.expect("read").is_some(),
        "the run row survives"
    );

    // The lazy retention row: born with the clear, marked + stamped.
    let (kept, cleared_at): (bool, Option<String>) = sqlx::query_as(
        "SELECT copies_kept, copies_cleared_at FROM txr_run_retention WHERE run_id = ?1",
    )
    .bind(run_id)
    .fetch_one(&pool(&server).await)
    .await
    .expect("retention row");
    assert!(!kept);
    assert!(
        cleared_at.as_deref().is_some_and(|s| !s.is_empty()),
        "the clear stamp is recorded"
    );

    // The K row flips: copies_kept false, can_rerun false — the engine call
    // is NOT issued by this module (DEC-6: the capability is data).
    let page: Value = server
        .client
        .get(server.api_url("/txr/history"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("page");
    let item = page["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|i| i["id"] == run_id.to_string())
        .expect("the run is listed")
        .clone();
    assert_eq!(item["copies_kept"], false);
    assert_eq!(item["can_rerun"], false);
    // The detail's copies note + the honest file facts (no copies → no sizes;
    // the surviving bundles still give the dir its bytes).
    let detail: Value = server
        .client
        .get(server.api_url(&format!("/txr/history/{run_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail")
        .json()
        .await
        .expect("detail");
    assert_eq!(detail["copies"]["kept"], false);
    assert!(detail["copies"]["cleared_at"].as_str().is_some());
    assert_eq!(detail["file_sizes"].as_array().expect("sizes").len(), 0);
    assert!(detail["dir_bytes"].as_u64().is_some(), "the dir still has bytes");

    // Idempotent: a second call is a 204 no-op with the row still marked.
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/history/{run_id}/copies/clear")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clear again");
    assert_eq!(resp.status().as_u16(), 204);
    let kept2: bool = sqlx::query_scalar(
        "SELECT copies_kept FROM txr_run_retention WHERE run_id = ?1",
    )
    .bind(run_id)
    .fetch_one(&pool(&server).await)
    .await
    .expect("row");
    assert!(!kept2);

    // Unknown run → the plan's 404 (one entity, one code — DEC-20).
    let missing = Uuid::new_v4();
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/history/{missing}/copies/clear")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clear unknown");
    assert_eq!(resp.status().as_u16(), 404);
    let body: Value = resp.json().await.expect("error json");
    assert_eq!(super::error_code(&body), "RUN_NOT_FOUND");

    // ── all-runs clear ────────────────────────────────────────────────────
    assert!(
        other_dir.join("input").exists(),
        "the other run still keeps its copies before the sweep"
    );
    let resp = server
        .client
        .post(server.api_url("/txr/history/copies/clear"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clear all");
    assert_eq!(resp.status().as_u16(), 204);
    assert!(!other_dir.join("input").exists());
    assert!(
        other_dir.join("bundles/cox-cutpoint-risk/params.json").is_file(),
        "the sweep is input/-only too"
    );
    let other_kept: bool = sqlx::query_scalar(
        "SELECT copies_kept FROM txr_run_retention WHERE run_id = ?1",
    )
    .bind(other_id)
    .fetch_one(&pool(&server).await)
    .await
    .expect("other retention row");
    assert!(!other_kept);

    // Idempotent sweep.
    let resp = server
        .client
        .post(server.api_url("/txr/history/copies/clear"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clear all again");
    assert_eq!(resp.status().as_u16(), 204);
}

/// TEST-HS-12 — the tamper matrix: a recorded dir of `/` (against the DEC-12
/// naming rule), a foreign path and a symlinked `input/` are each refused
/// with `400 UNSAFE_RUN_DIR`; nothing is deleted and the retention row is
/// untouched.
#[tokio::test]
async fn tampered_dirs_are_refused_and_nothing_is_deleted() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);

    // 1. The recorded dir is `/` — refused by the naming rule before any fs
    //    work (the run row is engine-shaped otherwise).
    let (slash_id, _) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T09:00:00+00:00"),
            started_at: Some(at("2026-10-20T09:00:01+00:00")),
            finished_at: Some(at("2026-10-20T09:01:00+00:00")),
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
                finished_at: Some(at("2026-10-20T09:01:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Record("/".to_string()),
        },
    )
    .await;
    // 2. A foreign path outside the data root (a sibling of it) — refused.
    let outside = std::env::temp_dir().join("history-store-outside-secret");
    std::fs::create_dir_all(&outside).expect("outside dir");
    std::fs::write(outside.join("secret.csv"), b"patient_id,outcome\nS1,1\n").expect("secret");
    let (foreign_id, _) = seed_run(
        &server,
        &repo,
        SeedRun {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at: at("2026-10-20T09:00:00+00:00"),
            started_at: Some(at("2026-10-20T09:00:01+00:00")),
            finished_at: Some(at("2026-10-20T09:01:00+00:00")),
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
                finished_at: Some(at("2026-10-20T09:01:00+00:00")),
            }],
            cpus: Some(4),
            memory_total_bytes: None,
            seed: 1,
            dir: super::SeedDir::Record(outside.to_str().expect("utf8").to_string()),
        },
    )
    .await;
    // 3. A run whose `input/` IS a symlink out of the run dir (a path that
    //    passes the lexical naming rule, then fails the canonical floor
    //    probes — the layered fence of DEC-12/PROV-HS-5).
    let (sym_id, sym_dir) = seed_simple_run(&server, &repo, "2026-10-20-0902").await;
    let trap = server.data_dir().join("trap-target");
    std::fs::create_dir_all(&trap).expect("trap dir");
    std::fs::write(trap.join("secret.csv"), b"patient_id,outcome\nS1,1\n").expect("trap file");
    std::fs::remove_dir_all(sym_dir.join("input")).expect("drop the real input dir");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&trap, sym_dir.join("input")).expect("symlink input out");

    // Each refusal: 400 UNSAFE_RUN_DIR, nothing deleted, no retention row.
    for (id, guard) in [
        (slash_id, "the `/` dir fails the naming rule"),
        (foreign_id, "a foreign path fails the naming rule"),
        (sym_id, "the symlinked input fails the canonical floor"),
    ] {
        let resp = server
            .client
            .post(server.api_url(&format!("/txr/history/{id}/copies/clear")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("clear");
        assert_eq!(resp.status().as_u16(), 400, "{guard}");
        let body: Value = resp.json().await.expect("error json");
        assert_eq!(super::error_code(&body), "UNSAFE_RUN_DIR", "{guard}");
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM txr_run_retention WHERE run_id = ?1")
            .bind(id)
            .fetch_one(&pool(&server).await)
            .await
            .expect("retention rows");
        assert_eq!(rows, 0, "{guard}: the retention row is untouched");
    }
    assert!(outside.join("secret.csv").is_file(), "nothing outside was touched");
    assert!(trap.join("secret.csv").is_file(), "the symlink target survives");
    assert!(
        sym_dir.join("input").is_symlink(),
        "the symlink itself survives the refusal"
    );
}

/// TEST-HS-14 — the preference round-trip: the migration-seeded default
/// `true` before any write, the id=1 upsert (the row is in the DB FILE — the
/// durable value a restarted server boots with; the module never caches it),
/// and the framework's 422 for a body that is not the `{keep_file_copies}`
/// schema.
#[tokio::test]
async fn preferences_round_trip_and_persist_in_the_db_file() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    // GET before any PUT → the seeded default (the board's "Copies are kept
    // with this run so it can be repeated").
    let resp = server
        .client
        .get(server.api_url("/txr/history/preferences"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("get");
    assert_eq!(resp.status().as_u16(), 200);
    let prefs: Value = resp.json().await.expect("prefs");
    assert_eq!(prefs["keep_file_copies"], true);
    assert!(
        prefs["updated_at"].as_str().is_some(),
        "the seed row carries its stamp"
    );

    // PUT → 204; the round trip reads the new value.
    let resp = server
        .client
        .put(server.api_url("/txr/history/preferences"))
        .bearer_auth(&token)
        .json(&json!({"keep_file_copies": false}))
        .send()
        .await
        .expect("put");
    assert_eq!(resp.status().as_u16(), 204);
    let prefs: Value = server
        .client
        .get(server.api_url("/txr/history/preferences"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("prefs");
    assert_eq!(prefs["keep_file_copies"], false);

    // Durability: the value is a row in the per-test DB file, read through a
    // FRESH pool — the same file a re-spawned server boots with (the module
    // has no in-memory preference state; TEST-HS-1 pins the fresh-pool read at
    // the unit level). The harness creates a NEW per-test DB per spawn, so
    // the literal second spawn has nothing to share; the durability half is
    // the file's row, asserted here directly.
    let fresh = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("fresh pool");
    let (kept, updated): (bool, String) = sqlx::query_as(
        "SELECT keep_file_copies, updated_at FROM txr_history_preferences WHERE id = 1",
    )
    .fetch_one(&fresh)
    .await
    .expect("the serialized row");
    assert!(!kept, "the PUT wrote the DB row");
    assert!(!updated.is_empty());
    fresh.close().await;

    // The plan's 422s: a valid-JSON body that is not the schema.
    for bad in [json!({"keep_file_copies": "yes"}), json!({}), json!({"nope": 1})] {
        let resp = server
            .client
            .put(server.api_url("/txr/history/preferences"))
            .bearer_auth(&token)
            .json(&bad)
            .send()
            .await
            .expect("put bad");
        assert_eq!(resp.status().as_u16(), 422, "{bad}");
    }

    // The preference write is NOT destructive: copies are untouched by a PUT
    // (the immediate-clear half of D25 is the explicit all-runs call).
    let (run_id, run_dir) = seed_simple_run(&server, &repo_for(&server).await, "2026-10-20-0903").await;
    let _ = run_id;
    let resp = server
        .client
        .put(server.api_url("/txr/history/preferences"))
        .bearer_auth(&token)
        .json(&json!({"keep_file_copies": true}))
        .send()
        .await
        .expect("put back");
    assert_eq!(resp.status().as_u16(), 204);
    assert!(
        run_dir.join("input").exists(),
        "the PUT flips the default only (DRIFT-1 ITEM-3 #23) — copies stay"
    );
}

/// The per-test pool helper (repo_for).
async fn repo_for(server: &TestServer) -> TxrRepository {
    TxrRepository::new(pool(server).await)
}
