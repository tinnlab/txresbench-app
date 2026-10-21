//! MCP admin settings (issue #54) — the singleton GET/PUT + read-at-use + A9 deny.
//!
//!  * TEST-7 [acceptance INV-1] — a fresh (never-PUT) deployment GETs the
//!    BYTE-IDENTICAL compiled defaults.
//!  * TEST-8 [acceptance INV-4] — a partial PUT persists + re-reads + stamps
//!    `updated_by`.
//!  * TEST-9 — an out-of-range PUT is a 422 and does NOT mutate the row (the
//!    safety bounds, DEC-3).
//!  * TEST-10 — read-at-use: a PUT that lowers `pairing_ttl_secs` takes effect at
//!    the `pair/start` use site with no restart (the persisted `expires_at`
//!    reflects the NEW ttl, not the compiled 300s default).
//!  * TEST-11 [A9] — a user lacking the permission gets 403 on GET and PUT; an
//!    unauthenticated request gets 401.

use serde_json::json;
use uuid::Uuid;

use crate::common::TestServer;

use super::{create_user, login, setup_admin};

async fn pool_for(server: &TestServer) -> sqlx::PgPool {
    sqlx::PgPool::connect(server.database_url())
        .await
        .expect("connect test db")
}

// TEST-7 [acceptance INV-1]: the default GET is byte-identical to the compiled consts.
#[tokio::test]
async fn get_settings_returns_byte_identical_defaults() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let resp = server
        .client
        .get(server.api_url("/mcp/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();

    // Each value equals the pre-existing compiled constant (INV-1).
    assert_eq!(body["max_control_sessions"], json!(1024));
    assert_eq!(body["max_inflight_per_user"], json!(16));
    assert_eq!(body["pairing_ttl_secs"], json!(300));
    assert_eq!(body["action_wall_clock_secs"], json!(900));
    assert_eq!(body["max_list_results"], json!(200));
    assert_eq!(body["max_result_bytes"], json!(1_048_576));
}

// TEST-8 [acceptance INV-4]: a partial PUT persists + re-reads + stamps updated_by.
#[tokio::test]
async fn put_settings_persists_and_stamps_updated_by() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // Partial PUT — only the in-flight cap changes.
    let resp = server
        .client
        .put(server.api_url("/mcp/settings"))
        .bearer_auth(&token)
        .json(&json!({ "max_inflight_per_user": 32 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["max_inflight_per_user"], json!(32), "sent field changed");
    assert_eq!(body["max_control_sessions"], json!(1024), "untouched field preserved");
    assert_eq!(body["pairing_ttl_secs"], json!(300), "untouched field preserved");

    // Persisted: a fresh GET reflects it.
    let resp = server
        .client
        .get(server.api_url("/mcp/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(
        resp.json::<serde_json::Value>().await.unwrap()["max_inflight_per_user"],
        json!(32)
    );

    // updated_by is stamped (audit column, INV-4).
    let pool = pool_for(&server).await;
    let updated_by: Option<Uuid> =
        sqlx::query_scalar("SELECT updated_by FROM mcp_settings WHERE id = TRUE")
            .fetch_one(&pool)
            .await
            .expect("read updated_by");
    assert!(updated_by.is_some(), "PUT stamps updated_by");
}

// TEST-9: out-of-range → 422 (safety bounds, DEC-3) and the row is unchanged.
#[tokio::test]
async fn put_out_of_range_is_422_and_does_not_mutate() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    for bad in [
        // Raise a SAFETY cap ABOVE its ceiling.
        json!({ "max_control_sessions": 16_385 }),
        json!({ "max_result_bytes": 65i64 * 1024 * 1024 }),
        // Drop a knob BELOW its floor.
        json!({ "pairing_ttl_secs": 10 }),
        json!({ "max_inflight_per_user": 0 }),
    ] {
        let resp = server
            .client
            .put(server.api_url("/mcp/settings"))
            .bearer_auth(&token)
            .json(&bad)
            .send()
            .await
            .expect("PUT settings");
        assert_eq!(resp.status().as_u16(), 422, "out-of-range {bad} → 422");
    }

    // The row is untouched (still the defaults) — validation ran before the write.
    let resp = server
        .client
        .get(server.api_url("/mcp/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["max_control_sessions"], json!(1024), "rejected PUT left the row unchanged");
    assert_eq!(body["pairing_ttl_secs"], json!(300));
}

// TEST-10: read-at-use — a PUT lowering `pairing_ttl_secs` takes effect at the
// `pair/start` use site with NO restart. The persisted code's `expires_at`
// reflects the NEW (30s) ttl, not the compiled 300s default (proving the cache
// was invalidated by the PUT and the mint reads-at-use).
#[tokio::test]
async fn pairing_ttl_is_read_at_use_after_a_settings_change() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // Lower the pairing TTL to its floor (30s).
    let resp = server
        .client
        .put(server.api_url("/mcp/settings"))
        .bearer_auth(&token)
        .json(&json!({ "pairing_ttl_secs": 30 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 200);

    // Mint a pairing code (admin holds mcp::use).
    let resp = server
        .client
        .post(server.api_url("/mcp/pair/start"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("pair/start");
    assert_eq!(resp.status().as_u16(), 200);

    // The persisted code expires ~30s out (the new ttl), NOT ~300s (the default).
    let pool = pool_for(&server).await;
    let secs_to_expiry: f64 = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float8 FROM mcp_pairing_codes ORDER BY expires_at DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .expect("read expires_at");
    assert!(
        secs_to_expiry > 0.0 && secs_to_expiry <= 45.0,
        "code expires in ~30s (read-at-use), got {secs_to_expiry}s — the compiled 300s default would be ~300"
    );
}

// TEST-11 [A9]: unauth → 401; a user lacking the permission → 403 on GET and PUT.
#[tokio::test]
async fn deny_path_401_unauth_and_403_without_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // No bearer → 401.
    let resp = server
        .client
        .get(server.api_url("/mcp/settings"))
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 401, "no bearer → 401");

    // A regular Users-group member holds `mcp::use` but NOT `mcp::settings::*`
    // (admin-only). Even that caller is refused — proving settings is not on the
    // Users grant.
    let _uid = create_user(&server, &admin, "mcp_set_np", "mcp_set_np@cyto.test").await;
    let token = login(&server, "mcp_set_np").await;

    let resp = server
        .client
        .get(server.api_url("/mcp/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 403, "missing mcp::settings::read → 403");

    let resp = server
        .client
        .put(server.api_url("/mcp/settings"))
        .bearer_auth(&token)
        .json(&json!({ "max_inflight_per_user": 32 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 403, "missing mcp::settings::manage → 403");
}
