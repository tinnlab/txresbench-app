//! TEST-73 [ITEM-26 / DEC-29] — the scheduler's CPU-arch refuse gate
//! (defense-in-depth) through the FULL production path (real spawned server +
//! real Postgres + the real background scheduler). Plus the dataset-scope
//! create-path wiring (ITEM-23 / DEC-scope): a `dataset_id` on the create request
//! is persisted onto `jobs.dataset_id` (so the finalize ingest tags
//! `artifacts.dataset_id`), owner-gated, and mutually exclusive with `project_id`.
//!
//! (ITEM-68 update: scope is now persisted in the `job_scope` table, not a
//! `jobs.dataset_id` column, so the DB-level assertion reads `job_scope`.)
//!
//! The arch gate is arch-agnostic: it computes the backend arch at runtime
//! (`std::env::consts::ARCH`) and declares an analysis for the OTHER arch, so the
//! test refuses/passes correctly whether it runs on x86_64 or aarch64. No
//! sandbox/rootfs is needed — a refused job never spawns, and an arch-COMPATIBLE
//! analysis fails LATER (the sandbox is disabled in the test image) with a
//! non-arch reason, which is exactly what proves the arch gate let it through.

use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{create_dataset, create_user, login, setup_admin};
use crate::common::TestServer;

/// The backend arch (== the test binary's compile-target arch, == the spawned
/// server's) and a DIFFERENT real arch guaranteed to be incompatible.
fn backend_and_incompatible_arch() -> (&'static str, &'static str) {
    let backend = std::env::consts::ARCH;
    let other = if backend == "aarch64" {
        "x86_64"
    } else {
        "aarch64"
    };
    (backend, other)
}

/// POST /jobs, returning (status_code, body).
async fn post_job(server: &TestServer, token: &str, body: Value) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("create job request");
    let code = resp.status().as_u16();
    (code, resp.json().await.unwrap_or(Value::Null))
}

/// Poll a job's detail until its status is terminal (or timeout), returning the
/// job object (`body["job"]`).
async fn poll_terminal(server: &TestServer, token: &str, id: &str) -> Value {
    let start = tokio::time::Instant::now();
    loop {
        let resp = server
            .client
            .get(server.api_url(&format!("/jobs/{id}")))
            .bearer_auth(token)
            .send()
            .await
            .expect("get job");
        if resp.status().as_u16() == 200 {
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let status = body["job"]["status"].as_str().unwrap_or("");
            if matches!(status, "failed" | "completed" | "stopped") {
                return body["job"].clone();
            }
        }
        if start.elapsed() > Duration::from_secs(20) {
            panic!("job {id} did not reach a terminal state in time");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn analysis_body(name: &str, arch: Value, extra: Value) -> Value {
    let mut params = json!({ "language": "python", "script": "print('hi')" });
    if !arch.is_null() {
        params["arch"] = arch;
    }
    let mut body = json!({ "job_type": "analysis", "name": name, "params": params });
    if let Value::Object(m) = extra {
        for (k, v) in m {
            body[k] = v;
        }
    }
    body
}

// TEST-73: the scheduler REFUSES (clear reason, no spawn) an analysis whose arch
// excludes the backend arch, and lets an arch-COMPATIBLE analysis through the gate.
#[tokio::test]
async fn test_73_scheduler_refuses_arch_incompatible_analysis() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (backend, incompatible) = backend_and_incompatible_arch();

    // (a) An analysis declaring ONLY the other arch → refused before spawn.
    let (code, body) = post_job(
        &server,
        &admin,
        analysis_body("cellranger-like", json!([incompatible]), Value::Null),
    )
    .await;
    assert_eq!(
        code, 201,
        "an arch-declaring analysis is still ACCEPTED at create (create body: {body})"
    );
    let bad_id = body["id"].as_str().expect("job id").to_string();

    let terminal = poll_terminal(&server, &admin, &bad_id).await;
    assert_eq!(
        terminal["status"],
        json!("failed"),
        "arch-incompatible job is refused → failed"
    );
    let err = terminal["error"].as_str().unwrap_or("");
    assert!(
        err.contains("arch-incompatible"),
        "refusal carries the arch reason (got {err:?})"
    );
    assert!(
        err.contains(incompatible),
        "refusal names the required arch {incompatible:?} (got {err:?})"
    );

    // (b) An analysis declaring the backend arch → NOT refused by the arch gate.
    // (It still fails later — the sandbox is disabled in the test image — but with
    // a NON-arch reason, which is what proves the gate let it through: no emulation
    // means we can't assert it completes, only that the arch gate didn't stop it.)
    let (code, body) = post_job(
        &server,
        &admin,
        analysis_body("scanpy-like", json!([backend]), Value::Null),
    )
    .await;
    assert_eq!(
        code, 201,
        "arch-compatible analysis accepted (body: {body})"
    );
    let ok_id = body["id"].as_str().expect("job id").to_string();
    let terminal = poll_terminal(&server, &admin, &ok_id).await;
    let err = terminal["error"].as_str().unwrap_or("");
    assert!(
        !err.contains("arch-incompatible"),
        "arch-compatible analysis passed the arch gate (unexpected arch refusal: {err:?})"
    );

    // (c) An analysis with NO arch (default = all arches) is likewise not refused.
    let (code, body) = post_job(
        &server,
        &admin,
        analysis_body("default-arch", Value::Null, Value::Null),
    )
    .await;
    assert_eq!(code, 201);
    let def_id = body["id"].as_str().expect("job id").to_string();
    let terminal = poll_terminal(&server, &admin, &def_id).await;
    let err = terminal["error"].as_str().unwrap_or("");
    assert!(
        !err.contains("arch-incompatible"),
        "default-arch analysis not arch-refused ({err:?})"
    );
}

// ITEM-23 / DEC-scope: a `dataset_id` on create is persisted to `jobs.dataset_id`
// (so finalize ingest scopes artifacts to the dataset), owner-gated, and mutually
// exclusive with `project_id`.
#[tokio::test]
async fn test_dataset_scoped_job_persists_dataset_id_owner_gated() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ann", "ann@arch.test").await;
    let ann = login(&server, "ann").await;
    create_user(&server, &admin, "bob", "bob@arch.test").await;
    let bob = login(&server, "bob").await;

    let dataset_id = create_dataset(&server, &ann, "proc-ds").await;

    // Ann (owner) creates a dataset-scoped analysis job → 201.
    let (code, body) = post_job(
        &server,
        &ann,
        analysis_body("scoped", Value::Null, json!({ "dataset_id": dataset_id })),
    )
    .await;
    assert_eq!(
        code, 201,
        "owner may create a dataset-scoped job (body: {body})"
    );
    let job_id = body["id"].as_str().expect("job id").to_string();

    // The scope reached the row: a `job_scope(scope_kind='dataset')` row points at
    // the dataset (ITEM-68 — jobs is scope-agnostic; scope lives in `job_scope`).
    let pool = sqlx::PgPool::connect(server.database_url())
        .await
        .expect("connect test db");
    let stored: Option<Uuid> = sqlx::query_scalar(
        "SELECT scope_id FROM job_scope WHERE job_id = $1 AND scope_kind = 'dataset'",
    )
    .bind(Uuid::parse_str(&job_id).unwrap())
    .fetch_optional(&pool)
    .await
    .expect("read job_scope");
    assert_eq!(
        stored,
        Some(Uuid::parse_str(&dataset_id).unwrap()),
        "the create path persisted a dataset-scoped job_scope row"
    );

    // Bob (not the owner) may NOT scope a job to Ann's dataset → 404 (no leak).
    let (code, _) = post_job(
        &server,
        &bob,
        analysis_body("foreign", Value::Null, json!({ "dataset_id": dataset_id })),
    )
    .await;
    assert_eq!(
        code, 404,
        "a foreign dataset is a 404 (owner-only, no existence oracle)"
    );

    // Both project_id AND dataset_id → 400 (a job is project- OR dataset-scoped).
    let (code, body) = post_job(
        &server,
        &ann,
        analysis_body(
            "ambiguous",
            Value::Null,
            json!({ "dataset_id": dataset_id, "project_id": Uuid::new_v4().to_string() }),
        ),
    )
    .await;
    assert_eq!(code, 400, "double-scoped job is rejected (body: {body})");
    assert_eq!(body["error_code"], json!("AMBIGUOUS_JOB_SCOPE"));
}
