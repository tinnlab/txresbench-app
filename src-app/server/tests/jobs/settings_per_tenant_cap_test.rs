//! TEST-11 [covers: ITEM-1, ITEM-6] — the per-tenant cap round-trips through the
//! EXISTING `job_settings` admin GET/PUT with bounds validation, and appears in
//! the response as a numeric field (the OpenAPI shape). No NEW permission is
//! introduced, so the existing job_settings gate covers it (no separate
//! negative-perm e2e required for T4).

use serde_json::{json, Value};

use super::setup_admin;
use crate::common::TestServer;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn per_tenant_cap_round_trips_with_bounds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Default is 2, exposed as a NUMBER (the regenerated OpenAPI numeric field).
    let get: Value = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("get json");
    assert_eq!(
        get["per_tenant_max_concurrent"],
        json!(2),
        "default per-tenant cap is 2"
    );
    assert!(
        get["per_tenant_max_concurrent"].is_number(),
        "per_tenant_max_concurrent maps to a TS number, not a string"
    );

    // PUT updates it (and leaves the global cap independent).
    let put: Value = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "per_tenant_max_concurrent": 7 }))
        .send()
        .await
        .expect("put")
        .json()
        .await
        .expect("put json");
    assert_eq!(
        put["per_tenant_max_concurrent"],
        json!(7),
        "per-tenant cap updated"
    );
    assert_eq!(
        put["max_concurrent_jobs"],
        json!(2),
        "the global cap is untouched by a per-tenant PUT"
    );

    // Out-of-range → 422 (or 400). The bound mirrors the DB CHECK (1..=64).
    for bad in [0, 65] {
        let resp = server
            .client
            .put(server.api_url("/job-settings"))
            .bearer_auth(&admin)
            .json(&json!({ "per_tenant_max_concurrent": bad }))
            .send()
            .await
            .expect("put bad");
        let code = resp.status().as_u16();
        assert!(
            code == 400 || code == 422,
            "out-of-bounds per_tenant_max_concurrent {bad} rejected (got {code})"
        );
    }

    // The rejected writes did not stick — the value is still the last VALID one.
    let get2: Value = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get2")
        .json()
        .await
        .expect("get2 json");
    assert_eq!(
        get2["per_tenant_max_concurrent"],
        json!(7),
        "an out-of-range PUT left the prior valid value intact"
    );
}
