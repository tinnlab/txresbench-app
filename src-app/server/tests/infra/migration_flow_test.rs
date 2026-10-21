//! #61 §2/§3 — the data-migration ORCHESTRATOR end-to-end against the floci cloud-sim:
//! start a copy+verify migration from the live (local) store to a real cloud destination, poll
//! the status endpoint until it reaches a terminal phase, and assert it VERIFIES (a corrupt
//! destination would land `failed` instead — auto-rollback). Env-gated on the floci substrate
//! (`S3_ENDPOINT` + AWS creds + bucket, exported by `scripts/cloud-sim-floci.sh`); self-skips
//! (via the skip ledger, never a bare pass) when the emulator is absent.
//!
//! The engine's data-integrity guarantees (copy → content-hash verify → HALT-on-mismatch →
//! source-never-touched → retire-gate) are proven exhaustively by the unit tests in
//! `migration_engine.rs`; this test proves the REST + orchestrator + DB-state wiring against a
//! real cloud store.

use serde_json::json;

use crate::account::setup_admin;
use crate::common::TestServer;
use crate::infra::{encrypted_opts, record_skip};

/// TEST-M1 [covers: ITEM-10, ITEM-11]: start → poll → verified against the floci S3 emulator.
#[tokio::test]
    // TEST-M1
    async fn migration_runs_and_verifies_against_floci() {
    let (endpoint, ak, sk, bucket) = match (
        std::env::var("S3_ENDPOINT").ok().filter(|s| !s.is_empty()),
        std::env::var("AWS_ACCESS_KEY_ID").ok().filter(|s| !s.is_empty()),
        std::env::var("AWS_SECRET_ACCESS_KEY").ok().filter(|s| !s.is_empty()),
        std::env::var("CYTO_WORKSTORE_S3_BUCKET").ok().filter(|s| !s.is_empty()),
    ) {
        (Some(e), Some(a), Some(s), Some(b)) => (e, a, s, b),
        _ => {
            record_skip(
                "infra::migration_runs_and_verifies_against_floci",
                "floci S3 substrate not up (S3_ENDPOINT/AWS_*/CYTO_WORKSTORE_S3_BUCKET unset); run `just cloud-sim-test-floci`",
            );
            return;
        }
    };

    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    // Start a migration from the live (local) store to the floci S3 destination.
    let start: serde_json::Value = server
        .client
        .post(server.api_url("/admin/infra/migration"))
        .bearer_auth(&admin)
        .json(&json!({
            "dest": {
                "provider": "s3",
                "endpoint": endpoint,
                "bucket": bucket,
                "region": "us-east-1",
                "path_style": true,
                "access_key_id": ak,
                "secret_access_key": sk,
            }
        }))
        .send()
        .await
        .expect("POST migration")
        .json()
        .await
        .expect("json");
    assert_eq!(start["started"], json!(true), "migration should start (local→cloud is not cost-gated): {start}");

    // Poll the status endpoint until a terminal phase.
    let mut phase = String::new();
    for _ in 0..60 {
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
        phase = v["phase"].as_str().unwrap_or("").to_string();
        if phase == "verified" || phase == "failed" {
            assert_eq!(phase, "verified", "migration must VERIFY (not fail) against a healthy dest: {v}");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert_eq!(phase, "verified", "migration did not reach 'verified' (last: {phase})");

    // TEST-M2 [acceptance] [invariant: INV-3] — retire-source is a SAFETY-VERIFIED readiness
    // check that DELETES NOTHING: it re-verifies every blob is present in the destination and
    // returns `safe_to_retire`, so the source is never auto-deleted (the old store's blobs still
    // exist after the migration + the retire call). The actual old-store deletion is manual.
    let retire: serde_json::Value = server
        .client
        .post(server.api_url("/admin/infra/migration/retire-source"))
        .bearer_auth(&admin)
        .json(&json!({
            "confirm": true,
            "dest": {
                "provider": "s3", "endpoint": endpoint, "bucket": bucket, "region": "us-east-1",
                "path_style": true, "access_key_id": ak, "secret_access_key": sk,
            }
        }))
        .send()
        .await
        .expect("POST retire-source")
        .json()
        .await
        .expect("json");
    assert_eq!(retire["safe_to_retire"], json!(true), "retire-readiness must confirm safe after a verified migration: {retire}");

    // TEST-M3 [covers: ITEM-8] — a `verified` migration (awaiting manual retire) does NOT block
    // a fresh migration from being started (it is excluded from the single-RUNNING-migration
    // constraint). Regression guard for the retire-slot lockout.
    let again: serde_json::Value = server
        .client
        .post(server.api_url("/admin/infra/migration"))
        .bearer_auth(&admin)
        .json(&json!({
            "dest": {
                "provider": "s3", "endpoint": endpoint, "bucket": bucket, "region": "us-east-1",
                "path_style": true, "access_key_id": ak, "secret_access_key": sk,
            }
        }))
        .send()
        .await
        .expect("POST migration (second)")
        .json()
        .await
        .expect("json");
    assert_eq!(again["started"], json!(true), "a verified migration must not block a fresh one: {again}");
}
