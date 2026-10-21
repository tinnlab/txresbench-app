//! TEST-18 — the object-store test-connection HAPPY path against the floci cloud-sim
//! substrate: with valid S3 creds pointed at the emulator, the test performs a real
//! put→get→delete round-trip and returns `{ok:true}`. Env-gated on the floci substrate
//! (`S3_ENDPOINT` + AWS creds, exported by `scripts/cloud-sim-floci.sh`); self-skips (via
//! the skip ledger, never a bare pass or an ignore attribute) when the emulator is absent.

use serde_json::json;

use crate::account::setup_admin;
use crate::common::TestServer;
use crate::infra::{encrypted_opts, record_skip};

/// TEST-18 [covers: ITEM-4]: a real put/get/delete round-trip against the floci S3 emulator.
#[tokio::test]
async fn object_store_roundtrip_ok_against_floci() {
    let (endpoint, ak, sk, bucket) = match (
        std::env::var("S3_ENDPOINT").ok().filter(|s| !s.is_empty()),
        std::env::var("AWS_ACCESS_KEY_ID").ok().filter(|s| !s.is_empty()),
        std::env::var("AWS_SECRET_ACCESS_KEY").ok().filter(|s| !s.is_empty()),
        std::env::var("CYTO_WORKSTORE_S3_BUCKET").ok().filter(|s| !s.is_empty()),
    ) {
        (Some(e), Some(a), Some(s), Some(b)) => (e, a, s, b),
        _ => {
            record_skip(
                "infra::object_store_roundtrip_ok_against_floci",
                "floci S3 substrate not up (S3_ENDPOINT/AWS_*/CYTO_WORKSTORE_S3_BUCKET unset); run `just cloud-sim-test-floci`",
            );
            return;
        }
    };

    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    server
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

    let v: serde_json::Value = server
        .client
        .post(server.api_url("/admin/infra/object-store/test"))
        .bearer_auth(&admin)
        .json(&json!({}))
        .send()
        .await
        .expect("POST test")
        .json()
        .await
        .expect("json");
    assert_eq!(v["ok"], json!(true), "round-trip against floci must succeed: {v}");
}
