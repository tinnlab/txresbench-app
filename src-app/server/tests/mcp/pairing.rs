//! TEST-12 — one-time-code pairing: `pair/start` (authed) returns a code +
//! `mcp_url`; `pair/exchange` claims it for an access+refresh pair that then
//! authenticates a real `POST /api/mcp` call; the code is single-use (a
//! second exchange of the SAME code fails) and TTL-bounded. Exercises the
//! REAL atomic `UPDATE ... RETURNING` claim path in
//! `PairingRepository::claim` (`pairing.rs:92`) — NOT the pure
//! `code_is_claimable` predicate (`pairing.rs:41`, `#[allow(dead_code)]`,
//! never called from production code and only exercised by its own unit
//! tests) — so this is genuine coverage of the code path a client actually
//! hits, including the finding that the decoy unit test alone couldn't prove
//! (double-exchange racing on Postgres's row lock, not on in-memory state).

use serde_json::{json, Value};
use uuid::Uuid;

use super::{create_user, login, mcp_rpc, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn pair_start_exchange_mints_tokens_and_is_single_use() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "pairer", "pairer@x.test").await;
    let pairer = login(&server, "pairer").await;

    let start = server
        .client
        .post(server.api_url("/mcp/pair/start"))
        .bearer_auth(&pairer)
        .send()
        .await
        .unwrap();
    assert_eq!(start.status().as_u16(), 200);
    let start_body: Value = start.json().await.unwrap();
    let code = start_body["code"].as_str().expect("code").to_string();
    assert!(
        start_body["mcp_url"].as_str().unwrap().ends_with("/api/mcp"),
        "{start_body}"
    );

    // First exchange succeeds and mints a real, usable access+refresh pair.
    let exchange = server
        .client
        .post(server.api_url("/mcp/pair/exchange"))
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(exchange.status().as_u16(), 200);
    let tokens: Value = exchange.json().await.unwrap();
    let access = tokens["access_token"].as_str().expect("access_token").to_string();
    assert!(tokens["refresh_token"].as_str().is_some(), "{tokens}");
    assert!(tokens["expires_in"].as_i64().unwrap() > 0, "{tokens}");

    // The minted access token actually authenticates the MCP surface.
    let (status, body) = mcp_rpc(&server, &access, "tools/list", json!({})).await;
    assert_eq!(status, 200, "the minted pairing token authenticates POST /api/mcp: {body}");
    assert_eq!(body["result"]["tools"].as_array().unwrap().len(), 3);

    // A SECOND exchange of the SAME code fails — single-use, via the real
    // atomic claim (not the pure predicate).
    let replay = server
        .client
        .post(server.api_url("/mcp/pair/exchange"))
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        replay.status().as_u16(),
        401,
        "a claimed pairing code cannot be exchanged twice"
    );
}

#[tokio::test]
async fn pair_exchange_rejects_unknown_code() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;

    let unknown = server
        .client
        .post(server.api_url("/mcp/pair/exchange"))
        .json(&json!({ "code": "not-a-real-code" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status().as_u16(), 401, "an unknown code is rejected");
}

#[tokio::test]
async fn pair_exchange_rejects_expired_code() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let user_id = create_user(&server, &admin, "expireduser", "expireduser@x.test").await;

    // The real TTL is 5 minutes — too long to wait out here. Insert an
    // ALREADY-EXPIRED code directly at the DB layer (this test's own
    // isolated per-test database) to exercise the same `expires_at > NOW()`
    // clause the atomic claim enforces, without a real-time wait.
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect test db");
    let code = Uuid::new_v4().to_string();
    let id = Uuid::new_v4();
    let user_uuid = Uuid::parse_str(&user_id).expect("user id is a uuid");
    sqlx::query(
        "INSERT INTO mcp_pairing_codes (id, code, user_id, expires_at) \
         VALUES ($1, $2, $3, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))",
    )
    .bind(id)
    .bind(&code)
    .bind(user_uuid)
    .execute(&pool)
    .await
    .expect("insert expired pairing code");

    let resp = server
        .client
        .post(server.api_url("/mcp/pair/exchange"))
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "an expired code cannot be exchanged");
}
