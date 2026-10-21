//! #61 §1 — the compute↔storage COUPLING GUARD at the API (INV-1). The one invalid pairing
//! (remote/kubernetes compute + Local object store) is REFUSED 422 `INCOMPATIBLE_BACKENDS` at
//! BOTH admin PUTs; the three valid pairings are accepted. Plus the end-to-end round-trip test
//! (INV-9) against the (local) selected store. No cloud substrate needed — the guard + the
//! local round-trip are exercised entirely in-process.

use serde_json::json;
use uuid::Uuid;

use crate::account::setup_admin;
use crate::common::TestServer;
use crate::infra::{encrypted_opts, pool_for};

/// TEST-C1 [acceptance] [invariant: INV-1]: PUT compute=kubernetes while the object store is
/// the default LOCAL store ⇒ 422 INCOMPATIBLE_BACKENDS (the one invalid pairing). Flip the guard
/// off and this returns 200 — that is what makes it a real proof of INV-1.
#[tokio::test]
async fn compute_put_refuses_remote_over_local_store() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    let resp = server
        .client
        .put(server.api_url("/admin/infra/compute"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "kubernetes" }))
        .send()
        .await
        .expect("PUT compute");
    assert_eq!(resp.status().as_u16(), 422, "remote compute + local store must be refused");
    let body = resp.text().await.expect("body");
    assert!(body.contains("INCOMPATIBLE_BACKENDS"), "the stable error code must be present: {body}");
}

/// TEST-C2 [acceptance] [invariant: INV-1]: with remote compute already valid (a cloud store
/// configured), switching the OBJECT STORE back to local is refused 422 at the object-store
/// PUT (the reciprocal guard).
#[tokio::test]
async fn object_store_put_refuses_local_under_remote_compute() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    // Establish the valid remote+cloud pairing first.
    let s = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "s3", "provider": "s3", "bucket": "cyto-worklab", "region": "us-east-1" }))
        .send()
        .await
        .expect("PUT s3 store");
    assert_eq!(s.status().as_u16(), 200);
    let c = server
        .client
        .put(server.api_url("/admin/infra/compute"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "kubernetes" }))
        .send()
        .await
        .expect("PUT kubernetes");
    assert_eq!(c.status().as_u16(), 200, "remote+cloud is valid");

    // Now switching the store back to local strands the remote compute ⇒ refused.
    let back = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "local" }))
        .send()
        .await
        .expect("PUT local store");
    assert_eq!(back.status().as_u16(), 422, "switching store to local under remote compute is refused");
    assert!(back.text().await.unwrap().contains("INCOMPATIBLE_BACKENDS"));
}

/// TEST-C3 [invariant: INV-1]: the three VALID pairings are accepted (local+local, local+cloud,
/// remote+cloud).
#[tokio::test]
async fn the_three_valid_pairings_are_accepted() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    let put = |path: &str, body: serde_json::Value| {
        let (client, url, admin) = (server.client.clone(), server.api_url(path), admin.clone());
        async move { client.put(url).bearer_auth(&admin).json(&body).send().await.unwrap().status().as_u16() }
    };
    // local compute + local store (defaults) — a no-op PUT is accepted.
    assert_eq!(put("/admin/infra/compute", json!({ "backend": "local" })).await, 200);
    assert_eq!(put("/admin/infra/object-store", json!({ "backend": "local" })).await, 200);
    // local compute + cloud store.
    assert_eq!(put("/admin/infra/object-store", json!({ "backend": "s3", "provider": "s3", "bucket": "b", "region": "us-east-1" })).await, 200);
    assert_eq!(put("/admin/infra/compute", json!({ "backend": "local" })).await, 200);
    // remote compute + cloud store.
    assert_eq!(put("/admin/infra/compute", json!({ "backend": "kubernetes" })).await, 200);
}

/// TEST-C4 [acceptance] [invariant: INV-9]: the end-to-end round-trip test proves the selected
/// compute backend can WRITE to and READ from the selected object store. Against the default
/// local store (local+local is valid) it performs a real put/get/verify/delete and returns
/// ok:true — a proof two green per-service checks cannot give.
#[tokio::test]
async fn roundtrip_test_ok_against_local_store() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    let v: serde_json::Value = server
        .client
        .post(server.api_url("/admin/infra/roundtrip-test"))
        .bearer_auth(&admin)
        .json(&json!({}))
        .send()
        .await
        .expect("POST roundtrip-test")
        .json()
        .await
        .expect("json");
    assert_eq!(v["ok"], json!(true), "local compute + local store must round-trip: {v}");
}

/// TEST-C6 [acceptance] [invariant: INV-6] — the IN-FLIGHT-JOB FENCE: retire-source (the
/// safe-to-retire readiness check) is REFUSED with 409 while a job is `running`, so the old
/// store is never declared safe to retire while a job might still be writing/reading it.
/// Deterministic (no cloud): seed a `verified` migration row + a `running` job directly, then
/// assert retire is fenced. Flip the fence off and this returns 200 — the proof of INV-6.
#[tokio::test]
async fn retire_is_fenced_while_a_job_is_running() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Seed a VERIFIED migration row (the retire readiness check requires phase == 'verified').
    sqlx::query(
        "INSERT INTO object_store_migration (src_backend, dst_backend, dst_provider, dst_bucket, phase) \
         VALUES ('local','s3','s3','cyto-worklab','verified')",
    )
    .execute(&pool)
    .await
    .expect("seed verified migration");

    // Seed a RUNNING job — the fence must see it. `owner_id` FKs to users(id), so use the real
    // admin user seeded above.
    let owner_id: Uuid = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("a seeded user exists");
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, resource_class, started_at) \
         VALUES ($1, $2, 'analysis', 'fence-probe', 'running', 'cpu-sandbox', now())",
    )
    .bind(Uuid::new_v4())
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed running job");

    let resp = server
        .client
        .post(server.api_url("/admin/infra/migration/retire-source"))
        .bearer_auth(&admin)
        .json(&json!({
            "confirm": true,
            "dest": { "provider": "s3", "bucket": "cyto-worklab", "region": "us-east-1" }
        }))
        .send()
        .await
        .expect("POST retire-source");
    assert_eq!(resp.status().as_u16(), 409, "retire must be fenced (409) while a job runs");
    assert!(
        resp.text().await.unwrap().to_lowercase().contains("jobs are currently running"),
        "the fence message must name the in-flight-job reason"
    );
}
