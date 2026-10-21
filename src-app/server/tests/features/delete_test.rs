//! Clear-override (DELETE) integration contracts (#53) — driven through a real spawned
//! server + real Postgres (per-test DB). These are the executable acceptance proofs for:
//!   TEST-1 [INV-1] clearing an override reverts the account to inheriting the global.
//!   TEST-2 [INV-2] fail-closed edges: unknown flag / unknown account / missing param /
//!                  idempotent clear-when-absent (fabricates no row).
//!   TEST-3 [INV-3] independence: clearing account A touches neither the global row nor B.
//!   TEST-4 [INV-4] A9 deny: a caller lacking features::manage is 403 on set + clear.

use uuid::Uuid;

use super::{
    account_body, create_plain_user, features_delete, features_get, features_put, global_body,
    DEMO_FLAG,
};
use crate::account::{pool_for, setup_admin};
use crate::common::TestServer;

/// Insert a real account row and return its id as a string.
async fn make_account(server: &TestServer, name: &str) -> String {
    let pool = pool_for(server).await;
    let id: Uuid = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO accounts (kind, name) VALUES ('organization', $1) RETURNING id",
    )
    .bind(name)
    .fetch_one(&pool)
    .await
    .expect("insert account");
    id.to_string()
}

// TEST-1 [acceptance] [invariant: INV-1]
#[tokio::test]
async fn clearing_an_override_reverts_to_inheriting_the_global() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let account = make_account(&server, "acct-1").await;

    // Global default ON, then a per-account override OFF (opposite the global).
    let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, global_body(true)).await;
    assert_eq!(s, 200);
    let (s, body) = features_put(&server, Some(&admin), DEMO_FLAG, account_body(false, &account)).await;
    assert_eq!(s, 200);
    assert_eq!(body["account_enabled"].as_bool(), Some(false), "override recorded");
    assert_eq!(body["effective"].as_bool(), Some(false), "override wins pre-clear");

    // GET for the account confirms the override is in effect.
    let (s, body) = features_get(&server, Some(&admin), Some(&account)).await;
    assert_eq!(s, 200);
    let flag = body["flags"].as_array().unwrap().iter()
        .find(|f| f["flag_key"] == DEMO_FLAG).unwrap();
    assert_eq!(flag["account_enabled"].as_bool(), Some(false));
    assert_eq!(flag["effective"].as_bool(), Some(false));

    // CLEAR the override → the returned view reverts to inheriting the global (true).
    let (s, body) = features_delete(&server, Some(&admin), DEMO_FLAG, Some(&account)).await;
    assert_eq!(s, 200, "clear succeeds: {body}");
    assert!(body["account_enabled"].is_null(), "override removed → account_enabled null: {body}");
    assert_eq!(body["global_enabled"].as_bool(), Some(true), "global untouched");
    assert_eq!(body["effective"].as_bool(), Some(true), "effective reverts to the global default");

    // A fresh GET confirms the DB row is gone (still inheriting).
    let (_, body) = features_get(&server, Some(&admin), Some(&account)).await;
    let flag = body["flags"].as_array().unwrap().iter()
        .find(|f| f["flag_key"] == DEMO_FLAG).unwrap();
    assert!(flag["account_enabled"].is_null(), "row gone after clear");
    assert_eq!(flag["effective"].as_bool(), Some(true));
}

// TEST-2 [acceptance] [invariant: INV-2]
#[tokio::test]
async fn clear_fail_closed_edges() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let account = make_account(&server, "acct-2").await;

    // Unknown flag → 404 UNKNOWN_FLAG (checked before the account lookup).
    let (s, body) = features_delete(&server, Some(&admin), "nope.not_a_flag", Some(&account)).await;
    assert_eq!(s, 404, "unknown flag → 404: {body}");
    assert_eq!(body["error_code"].as_str(), Some("UNKNOWN_FLAG"), "carries UNKNOWN_FLAG: {body}");

    // Unknown account (known flag) → 404.
    let ghost = Uuid::new_v4().to_string();
    let (s, _) = features_delete(&server, Some(&admin), DEMO_FLAG, Some(&ghost)).await;
    assert_eq!(s, 404, "clear against a non-existent account → 404");

    // No account segment → the base path has no DELETE handler → 405 (the clear is
    // per-account only, keyed in the PATH; DEC-2). Never a "clear the global" path.
    let (s, _) = features_delete(&server, Some(&admin), DEMO_FLAG, None).await;
    assert_eq!(s, 405, "DELETE on the base path (no account segment) → 405, never clears global");

    // Idempotent clear when NO override exists → 200 inherited view, no row fabricated.
    let (s, body) = features_delete(&server, Some(&admin), DEMO_FLAG, Some(&account)).await;
    assert_eq!(s, 200, "clearing an absent override succeeds (idempotent): {body}");
    assert!(body["account_enabled"].is_null(), "still inheriting");
    assert_eq!(body["effective"].as_bool(), Some(false), "compiled default (demo flag is OFF)");
    // A follow-up GET proves the clear fabricated no row (still inheriting the compiled default).
    let (_, body) = features_get(&server, Some(&admin), Some(&account)).await;
    let flag = body["flags"].as_array().unwrap().iter()
        .find(|f| f["flag_key"] == DEMO_FLAG).unwrap();
    assert!(flag["account_enabled"].is_null(), "no row was fabricated by an idempotent clear");
}

// TEST-3 [acceptance] [invariant: INV-3]
#[tokio::test]
async fn clearing_one_account_leaves_the_global_and_other_accounts_intact() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let account_a = make_account(&server, "acct-a").await;
    let account_b = make_account(&server, "acct-b").await;

    // Global ON; A override OFF; B override OFF.
    features_put(&server, Some(&admin), DEMO_FLAG, global_body(true)).await;
    features_put(&server, Some(&admin), DEMO_FLAG, account_body(false, &account_a)).await;
    features_put(&server, Some(&admin), DEMO_FLAG, account_body(false, &account_b)).await;

    // Clear A only.
    let (s, _) = features_delete(&server, Some(&admin), DEMO_FLAG, Some(&account_a)).await;
    assert_eq!(s, 200);

    // Global row unchanged (global view still ON).
    let (_, body) = features_get(&server, Some(&admin), None).await;
    let g = body["flags"].as_array().unwrap().iter()
        .find(|f| f["flag_key"] == DEMO_FLAG).unwrap();
    assert_eq!(g["global_enabled"].as_bool(), Some(true), "global row untouched by clearing A");

    // A reverted to inheriting the global (true).
    let (_, body) = features_get(&server, Some(&admin), Some(&account_a)).await;
    let a = body["flags"].as_array().unwrap().iter()
        .find(|f| f["flag_key"] == DEMO_FLAG).unwrap();
    assert!(a["account_enabled"].is_null(), "A's override cleared");
    assert_eq!(a["effective"].as_bool(), Some(true), "A now inherits the global");

    // B's override is intact (still OFF).
    let (_, body) = features_get(&server, Some(&admin), Some(&account_b)).await;
    let b = body["flags"].as_array().unwrap().iter()
        .find(|f| f["flag_key"] == DEMO_FLAG).unwrap();
    assert_eq!(b["account_enabled"].as_bool(), Some(false), "B's override untouched");
    assert_eq!(b["effective"].as_bool(), Some(false), "B still overridden OFF");
}

// TEST-4 [acceptance] [invariant: INV-4] — A9 deny path.
#[tokio::test]
async fn clear_and_set_require_features_manage() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let account = make_account(&server, "acct-4").await;
    let plain = create_plain_user(&server, &admin, "plainuser").await;

    // A plain user lacking features::manage is 403 on the clear AND on a per-account set.
    let (s, _) = features_delete(&server, Some(&plain), DEMO_FLAG, Some(&account)).await;
    assert_eq!(s, 403, "clear without features::manage → 403");
    let (s, _) = features_put(&server, Some(&plain), DEMO_FLAG, account_body(true, &account)).await;
    assert_eq!(s, 403, "per-account set without features::manage → 403");

    // No bearer → 401 for both.
    let (s, _) = features_delete(&server, None, DEMO_FLAG, Some(&account)).await;
    assert_eq!(s, 401, "clear unauthenticated → 401");
    let (s, _) = features_put(&server, None, DEMO_FLAG, account_body(true, &account)).await;
    assert_eq!(s, 401, "set unauthenticated → 401");

    // The admin (holds features::manage via *) can clear.
    let (s, _) = features_delete(&server, Some(&admin), DEMO_FLAG, Some(&account)).await;
    assert_eq!(s, 200, "admin can clear");
}
