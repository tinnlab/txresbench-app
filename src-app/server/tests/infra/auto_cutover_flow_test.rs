//! #64 ITEM-5/ITEM-7 — the AUTO hot-cutover end-to-end against the floci cloud-sim: an
//! admin PUT that CHANGES the effective object store (local→cloud) auto-starts a migration and, on
//! `verified`, cuts the LIVE handle over to `DualRead(new, old)` with NO restart — proving the
//! auto-trigger + orchestrator + live-cutover + DB-state wiring is actually reached on the runtime
//! path (not just unit-tested in isolation). Env-gated on the floci substrate; self-skips (skip
//! ledger, never a bare pass) when the emulator is absent.

use serde_json::json;

use crate::account::setup_admin;
use crate::common::TestServer;
use crate::infra::{encrypted_opts, record_skip};

/// TEST-CUF3 [covers: ITEM-5, ITEM-7] — a config PUT (local→floci S3) auto-triggers a migration
/// that reaches `verified` AND applies the LIVE cutover (`cutover:true`) with no restart, marked
/// `auto_started`. This is the wired-and-behaving proof for the auto path.
#[tokio::test]
// TEST-CUF3
// TEST-I2 — superseded placeholder (deferred-scope auto-trigger integration test), realized here.
async fn config_switch_auto_migrates_and_cuts_over_live() {
    let (endpoint, ak, sk, bucket) = match (
        std::env::var("S3_ENDPOINT").ok().filter(|s| !s.is_empty()),
        std::env::var("AWS_ACCESS_KEY_ID").ok().filter(|s| !s.is_empty()),
        std::env::var("AWS_SECRET_ACCESS_KEY").ok().filter(|s| !s.is_empty()),
        std::env::var("CYTO_WORKSTORE_S3_BUCKET").ok().filter(|s| !s.is_empty()),
    ) {
        (Some(e), Some(a), Some(s), Some(b)) => (e, a, s, b),
        _ => {
            record_skip(
                "infra::config_switch_auto_migrates_and_cuts_over_live",
                "floci S3 substrate not up; run `just cloud-sim-test-floci`",
            );
            return;
        }
    };

    // Boot the server on the LOCAL store so the PUT below is a genuine local→cloud CHANGE. The
    // floci env contract sets CYTO_WORKSTORE_BACKEND=s3 (for the direct S3 contract tests); we
    // override it for THIS server's boot so we can exercise the config-SWITCH auto-cutover. Safe
    // under the integration suite's --test-threads=1: set → spawn (subprocess reads it at exec) →
    // restore, with no concurrent spawn.
    let prev_backend = std::env::var("CYTO_WORKSTORE_BACKEND").ok();
    std::env::set_var("CYTO_WORKSTORE_BACKEND", "local");
    let server = TestServer::spawn_with(encrypted_opts()).await;
    match &prev_backend {
        Some(v) => std::env::set_var("CYTO_WORKSTORE_BACKEND", v),
        None => std::env::remove_var("CYTO_WORKSTORE_BACKEND"),
    }
    let admin = setup_admin(&server).await;

    // PUT the object-store config: switch the effective store from local → floci S3. This alone
    // (no explicit "start migration") must kick the auto-migration + live cutover (#64 ITEM-5).
    let put = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({
            "backend": "s3",
            "provider": "s3",
            "endpoint": endpoint,
            "bucket": bucket,
            "region": "us-east-1",
            "path_style": true,
            "access_key_id": ak,
            "secret_access_key": sk,
        }))
        .send()
        .await
        .expect("PUT object-store");
    assert_eq!(put.status().as_u16(), 200, "config PUT should succeed");

    // Poll the migration status: it must appear (auto_started), reach `verified`, and then show the
    // LIVE cutover applied (cutover:true) — all with no restart.
    let mut last = serde_json::Value::Null;
    let mut cutover_seen = false;
    for _ in 0..80 {
        let v: serde_json::Value = server
            .client
            .get(server.api_url("/admin/infra/migration"))
            .bearer_auth(&admin)
            .send()
            .await
            .expect("GET migration")
            .json()
            .await
            .expect("json");
        last = v.clone();
        let phase = v["phase"].as_str().unwrap_or("");
        assert_ne!(phase, "failed", "the auto-migration must not FAIL against a healthy dest: {v}");
        if phase == "verified" && v["cutover"] == json!(true) {
            assert_eq!(v["auto_started"], json!(true), "a config-switch migration is auto_started: {v}");
            cutover_seen = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert!(cutover_seen, "the auto-migration did not reach verified+cutover (last status: {last})");
}
