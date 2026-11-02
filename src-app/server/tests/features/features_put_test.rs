//! TEST-8 — PUT edge cases + the view shape: an unknown flag → 404 UNKNOWN_FLAG; a
//! non-existent account_id → 404; a happy global + per-account PUT return a
//! `FeatureFlagView` with the correct global_enabled/account_enabled/effective.

use uuid::Uuid;

use super::{account_body, features_put, global_body, DEMO_FLAG};
use crate::account::{pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn unknown_flag_is_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (s, body) = features_put(&server, Some(&admin), "nope.not_a_flag", global_body(true)).await;
    assert_eq!(s, 404, "unknown flag → 404: {body}");
    assert_eq!(
        body["error_code"].as_str(),
        Some("UNKNOWN_FLAG"),
        "the 404 carries the UNKNOWN_FLAG code: {body}"
    );
}

#[tokio::test]
async fn nonexistent_account_is_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ghost = Uuid::new_v4().to_string();
    let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, account_body(true, &ghost)).await;
    assert_eq!(s, 404, "a per-account PUT against a non-existent account → 404");
}

#[tokio::test]
async fn happy_put_returns_correct_view() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let account = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES ($1, 'organization', 'acct')")
        .bind(account)
        .execute(&pool)
        .await
        .expect("insert account");
    let account_s = account.to_string();

    // Global PUT true → view reflects global_enabled=true, effective=true (no account).
    let (s, body) = features_put(&server, Some(&admin), DEMO_FLAG, global_body(true)).await;
    assert_eq!(s, 200);
    assert_eq!(body["flag_key"].as_str(), Some(DEMO_FLAG));
    assert_eq!(body["default_enabled"].as_bool(), Some(false), "compiled default surfaced");
    assert_eq!(body["global_enabled"].as_bool(), Some(true));
    assert!(body["account_enabled"].is_null(), "no account queried → account_enabled null");
    assert_eq!(body["effective"].as_bool(), Some(true));

    // Per-account PUT false → view is resolved for THAT account: account_enabled=false,
    // effective=false (override wins over the global true).
    let (s, body) = features_put(&server, Some(&admin), DEMO_FLAG, account_body(false, &account_s)).await;
    assert_eq!(s, 200);
    assert_eq!(body["global_enabled"].as_bool(), Some(true), "global unchanged");
    assert_eq!(body["account_enabled"].as_bool(), Some(false));
    assert_eq!(body["effective"].as_bool(), Some(false), "override wins");
}
