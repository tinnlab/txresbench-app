//! #54 — per-class resource defaults + deployment default env-id on the
//! `sandbox_settings` singleton, over the real spawned-server + Postgres harness.
//! Mirrors the module's other endpoint tests (auth via `setup_admin`, partial PUT).

use serde_json::{json, Value};

use super::{restricted_user_token, setup_admin};
use crate::common::TestServer;

async fn get_settings(server: &TestServer, token: &str) -> Value {
    let resp = server
        .client
        .get(server.api_url("/sandbox/settings"))
        .bearer_auth(token)
        .send()
        .await
        .expect("get settings");
    assert_eq!(resp.status().as_u16(), 200, "admin reads sandbox settings");
    resp.json().await.expect("settings json")
}

async fn put_settings(server: &TestServer, token: &str, body: Value) -> reqwest::Response {
    server
        .client
        .put(server.api_url("/sandbox/settings"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("put settings")
}

// TEST-7 [ITEM-1/2]: the migration applied + seeded the per-class defaults byte-equal
// to the retired constants, and default_env_id / updated_by start unset.
#[tokio::test]
async fn seeded_per_class_defaults_are_byte_preserving() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let s = get_settings(&server, &token).await;
    assert_eq!(s["interactive_cpu_cores"], json!(2));
    assert_eq!(s["interactive_mem_bytes"], json!(4i64 * 1024 * 1024 * 1024));
    assert_eq!(s["normal_cpu_cores"], json!(2));
    assert_eq!(s["normal_mem_bytes"], json!(4i64 * 1024 * 1024 * 1024));
    assert_eq!(s["batch_cpu_cores"], json!(4));
    assert_eq!(s["batch_mem_bytes"], json!(8i64 * 1024 * 1024 * 1024));
    assert!(s["default_env_id"].is_null(), "unset → auto-detect");
    assert!(s["updated_by"].is_null(), "no admin has written yet");
}

// TEST-10 [ITEM-4/5]: a partial PUT of ONLY batch_cpu_cores leaves the other per-class
// fields and the ceiling unchanged (COALESCE partial update).
#[tokio::test]
async fn partial_put_touches_only_the_named_field() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let before = get_settings(&server, &token).await;

    let resp = put_settings(&server, &token, json!({ "batch_cpu_cores": 8 })).await;
    assert_eq!(resp.status().as_u16(), 200, "partial PUT ok");
    let after: Value = resp.json().await.expect("put json");

    assert_eq!(after["batch_cpu_cores"], json!(8), "named field updated");
    assert_eq!(after["normal_cpu_cores"], before["normal_cpu_cores"], "untouched class preserved");
    assert_eq!(after["batch_mem_bytes"], before["batch_mem_bytes"], "untouched field preserved");
    assert_eq!(after["memory_max_bytes"], before["memory_max_bytes"], "ceiling untouched");
}

// TEST-6 [acceptance][INV-6][ITEM-5]: every PUT stamps updated_by from the acting
// admin — null before any write, a non-null uuid after an admin PUT.
#[tokio::test]
async fn put_stamps_updated_by_from_the_acting_admin() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let before = get_settings(&server, &token).await;
    assert!(before["updated_by"].is_null(), "unset before any write");

    let resp = put_settings(&server, &token, json!({ "normal_cpu_cores": 3 })).await;
    assert_eq!(resp.status().as_u16(), 200);
    let after: Value = resp.json().await.expect("put json");
    let uid = after["updated_by"].as_str().expect("updated_by stamped as a uuid string");
    assert!(!uid.is_empty(), "updated_by is the acting admin's id, not null");
    // Re-read persists the stamp.
    let reread = get_settings(&server, &token).await;
    assert_eq!(reread["updated_by"].as_str(), Some(uid));
}

// TEST-3 [acceptance][INV-3][ITEM-6]: the env registry stays OPEN — an arbitrary
// well-formed env-id (no image published for it) is accepted as default_env_id with
// NO allowlist rejection; this change added no curated env list.
#[tokio::test]
async fn arbitrary_env_id_accepted_no_allowlist() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // A name no image exists for — accepted at the settings layer (openness). It would
    // only fail at PULL time, from the registry itself, exactly like a typo'd image.
    let resp = put_settings(&server, &token, json!({ "default_env_id": "some-unpublished-env-xyz" })).await;
    assert_eq!(resp.status().as_u16(), 200, "well-formed env-id accepted, no allowlist");
    let after: Value = resp.json().await.expect("put json");
    assert_eq!(after["default_env_id"], json!("some-unpublished-env-xyz"));

    // A MALFORMED id is rejected (422) — the grammar guard, not an allowlist.
    let bad = put_settings(&server, &token, json!({ "default_env_id": "Bad/Id:tag" })).await;
    assert_eq!(bad.status().as_u16(), 422, "malformed env-id rejected by grammar");

    // Empty string clears back to auto-detect (null).
    let clear = put_settings(&server, &token, json!({ "default_env_id": "" })).await;
    assert_eq!(clear.status().as_u16(), 200);
    let cleared: Value = clear.json().await.expect("put json");
    assert!(cleared["default_env_id"].is_null(), "empty clears to auto-detect");
}

// TEST-4 [acceptance][INV-4][ITEM-7]: the registry BASE is READ-ONLY — surfaced on
// /sandbox/status as the compiled const, and NOT changeable via the settings PUT (the
// Update body has no such field, so an attempt is silently ignored).
#[tokio::test]
async fn registry_base_is_readonly_and_not_writable() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let status: Value = server
        .client
        .get(server.api_url("/sandbox/status"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("status")
        .json()
        .await
        .expect("status json");
    assert_eq!(status["env_registry_base"], json!("ghcr.io/ziee-ai/cyto-env"), "registry base displayed");
    assert!(status["env_moving_tag"].as_str().is_some_and(|t| t.contains("latest")), "moving tag shown");

    // An attempt to send a registry override is ignored (unknown field) — the base
    // on the status endpoint is unchanged.
    let resp = put_settings(&server, &token, json!({ "env_registry_base": "evil.example.com/x" })).await;
    assert_eq!(resp.status().as_u16(), 200, "unknown field ignored, PUT still succeeds");
    let status2: Value = server
        .client
        .get(server.api_url("/sandbox/status"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("status")
        .json()
        .await
        .expect("status json");
    assert_eq!(status2["env_registry_base"], json!("ghcr.io/ziee-ai/cyto-env"), "base unchanged — not operator-writable");
}

// TEST-18 [ITEM-5, A9]: a user LACKING sandbox::settings::manage is refused the PUT
// (403 backend deny path) — the frontend-hidden A10 half is the restricted e2e.
#[tokio::test]
async fn put_denied_without_manage_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let restricted = restricted_user_token(&server, &admin).await;

    let resp = put_settings(&server, &restricted, json!({ "normal_cpu_cores": 3 })).await;
    assert_eq!(resp.status().as_u16(), 403, "no manage permission → 403");

    // The no-permission user also cannot READ (SandboxSettingsRead gates GET).
    let get = server
        .client
        .get(server.api_url("/sandbox/settings"))
        .bearer_auth(&restricted)
        .send()
        .await
        .expect("get");
    assert_eq!(get.status().as_u16(), 403, "no read permission → 403");
}

// ---------------------------------------------------------------------------
// uncapped-uploads TEST-7 [covers: ITEM-8, ITEM-9]
// ---------------------------------------------------------------------------

/// uncapped-uploads TEST-7 — the raised `fsize_bytes` default reaches a freshly
/// migrated database, and the bound still exists.
///
/// This is the only test of migration `202609020020_sandbox_fsize_default.sql`. It
/// was enumerated in TESTS.md but never written, so the migration could have been a
/// no-op — or could have moved a bound — with every test still green.
///
/// `fsize_bytes` is `RLIMIT_FSIZE` for every file written INSIDE a sandbox, including
/// archive extraction, which is why the old 2 GiB default is what blocked Xenium
/// import (`docs/design/upload-limits-policy.md` §"Ruling 2"; the largest measured
/// single bundle member is 5,179 MB, so 2 GiB refused it outright).
#[tokio::test]
async fn uncapped_uploads_test7_fsize_default_is_raised_on_a_fresh_database() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let s = get_settings(&server, &token).await;
    assert_eq!(
        s["fsize_bytes"],
        json!(68_719_476_736i64),
        "the migration's column default and SandboxResourceLimits::defaults() agree \
         on 64 GiB; a divergence here means a deployment's effective limit is not the \
         one the code documents"
    );

    // The bound survives the ruling (INV-4): an admin still cannot raise it past the
    // unchanged 256 GiB ceiling.
    let over = put_settings(
        &server,
        &token,
        json!({ "fsize_bytes": 257i64 * 1024 * 1024 * 1024 }),
    )
    .await;
    assert_eq!(over.status().as_u16(), 422, "past the range ceiling is still refused");
    let body: Value = over.json().await.expect("422 body");
    assert_eq!(body["error_code"], json!("SANDBOX_LIMIT_OUT_OF_RANGE"));

    // ...and an operator can still LOWER it, which is the point of keeping it a
    // setting rather than deleting the limit.
    let lowered = put_settings(&server, &token, json!({ "fsize_bytes": 1024 * 1024 })).await;
    assert_eq!(lowered.status().as_u16(), 200, "the 1 MiB floor is still reachable");
    let after = get_settings(&server, &token).await;
    assert_eq!(after["fsize_bytes"], json!(1024 * 1024), "the lowered value persisted");
}
