//! #37 admin suspend/reactivate/status — the DEFAULT-BUILD half (the routes + the `accounts`
//! column ride desktop; they are NOT saas-gated). The QUOTA EFFECT of a suspend (check_quota
//! Blocks) is the saas-only quota gate and is proven in `tests/billing/admin_suspend_quota_test.rs`
//! (TEST-5/TEST-6). Here we prove: the routes exist + persist + are admin-gated in the default
//! build, and the generated default OpenAPI spec carries the (non-saas) suspend routes but not the
//! (saas) plan route.

use uuid::Uuid;

use crate::account::{create_user, login, pool_for, setup_admin};
use crate::admin::{
    admin_account_status, admin_reactivate, admin_suspend, create_admin_accounts_holder,
};
use crate::common::TestServer;

/// The personal account id of a user (the default account every user auto-gets).
async fn personal_account(pool: &sqlx::PgPool, user_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal account exists")
}

/// The raw `admin_suspended` column of an account.
async fn db_admin_suspended(pool: &sqlx::PgPool, account: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT admin_suspended FROM accounts WHERE id=$1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("read admin_suspended")
}

// TEST-11 (part) [acceptance][invariant: INV-7][covers ITEM-5, ITEM-10, ITEM-11]: the suspend /
// reactivate / status routes are served in the DEFAULT (non-saas) build and persist the
// `accounts.admin_suspended` column (the column + mutation ride desktop, admin-gated).
#[tokio::test]
async fn suspend_reactivate_persists_and_reports_status_in_default_build() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "susp_u1", "susp_u1@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account(&pool, uid).await;
    let acct = account.to_string();

    // Baseline: not suspended.
    assert!(!db_admin_suspended(&pool, account).await, "starts un-suspended");
    let (st, body) = admin_account_status(&server, Some(&admin), &acct).await;
    assert_eq!(st, 200, "status read ok");
    assert_eq!(body["admin_suspended"], serde_json::json!(false));

    // Suspend with a reason → flag + audit set.
    let (st, body) = admin_suspend(&server, Some(&admin), &acct, Some("abuse hold")).await;
    assert_eq!(st, 200, "suspend ok: {body}");
    assert_eq!(body["admin_suspended"], serde_json::json!(true));
    assert_eq!(body["admin_suspend_reason"], serde_json::json!("abuse hold"));
    assert!(!body["admin_suspended_at"].is_null(), "suspended_at stamped");
    assert!(!body["admin_suspended_by"].is_null(), "suspended_by stamped");
    assert!(db_admin_suspended(&pool, account).await, "DB flag set");

    // Reactivate → flag + audit cleared.
    let (st, body) = admin_reactivate(&server, Some(&admin), &acct).await;
    assert_eq!(st, 200, "reactivate ok: {body}");
    assert_eq!(body["admin_suspended"], serde_json::json!(false));
    assert!(body["admin_suspend_reason"].is_null(), "reason cleared");
    assert!(body["admin_suspended_at"].is_null(), "suspended_at cleared");
    assert!(body["admin_suspended_by"].is_null(), "suspended_by cleared");
    assert!(!db_admin_suspended(&pool, account).await, "DB flag cleared");
}

// TEST-11 (part) [covers ITEM-5]: a suspend POST with NO request body (the natural "suspend, no
// reason" call) succeeds — `reason` is genuinely optional, not a required JSON body.
#[tokio::test]
async fn suspend_with_no_body_succeeds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "susp_nb", "susp_nb@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account(&pool, uid).await;

    // A bare POST — no body, no Content-Type. Must suspend, not 415/422.
    let resp = server
        .client
        .post(server.api_url(&format!("/admin/accounts/{account}/suspend")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("bodyless suspend");
    assert_eq!(resp.status().as_u16(), 200, "a bodyless suspend succeeds");
    assert!(db_admin_suspended(&pool, account).await, "flag set with no body");
    let body: serde_json::Value = resp.json().await.expect("json");
    assert!(body["admin_suspend_reason"].is_null(), "no reason recorded");
}

// TEST-10 (admin half) [acceptance][invariant: INV-5][covers ITEM-5]: unauth → 401 and a
// non-admin (no admin::accounts) → 403 on suspend/reactivate/status; the flag is UNCHANGED after
// a rejected suspend (the deny actually prevented the write). The A9 backend deny path.
#[tokio::test]
async fn suspend_routes_require_admin_accounts() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "susp_u2", "susp_u2@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account(&pool, uid).await;
    let acct = account.to_string();

    // A plain user (Users group only — no admin::accounts).
    let _plain_uid = create_user(&server, &admin, "susp_plain", "susp_plain@cyto.test").await;
    let plain = login(&server, "susp_plain").await;

    // unauth → 401.
    assert_eq!(admin_suspend(&server, None, &acct, None).await.0, 401, "suspend unauth 401");
    assert_eq!(admin_reactivate(&server, None, &acct).await.0, 401, "reactivate unauth 401");
    assert_eq!(admin_account_status(&server, None, &acct).await.0, 401, "status unauth 401");

    // non-admin → 403.
    assert_eq!(admin_suspend(&server, Some(&plain), &acct, None).await.0, 403, "suspend 403");
    assert_eq!(admin_reactivate(&server, Some(&plain), &acct).await.0, 403, "reactivate 403");
    assert_eq!(admin_account_status(&server, Some(&plain), &acct).await.0, 403, "status 403");

    // The rejected suspend did NOT flip the flag.
    assert!(
        !db_admin_suspended(&pool, account).await,
        "a 403'd suspend must not write the flag"
    );

    // A dedicated admin::accounts holder (not is_admin) CAN suspend — the grant path works.
    let holder = create_admin_accounts_holder(&server, &admin, "susp_holder", "susp_holder@cyto.test").await;
    assert_eq!(admin_suspend(&server, Some(&holder), &acct, None).await.0, 200, "grant-holder suspends");
    assert!(db_admin_suspended(&pool, account).await, "grant-holder write took effect");
}

// TEST-11 (part) [acceptance][invariant: INV-7][covers ITEM-11]: the generated DEFAULT OpenAPI
// spec carries the (non-saas, admin-module) suspend + status routes, but NOT the (saas, billing-
// module) plan route — proving the plan surface is saas-gated while the suspend surface rides
// desktop. Reads the committed regenerated spec.
#[tokio::test]
async fn default_openapi_has_suspend_routes_but_not_plan_route() {
    let spec_path = format!("{}/../ui/openapi/openapi.json", env!("CARGO_MANIFEST_DIR"));
    let spec = std::fs::read_to_string(&spec_path).unwrap_or_else(|e| panic!("read {spec_path}: {e}"));
    assert!(
        spec.contains("/admin/accounts/{account_id}/suspend"),
        "the non-saas suspend route is in the default OpenAPI spec"
    );
    assert!(
        spec.contains("/admin/accounts/{account_id}/status"),
        "the non-saas status route is in the default OpenAPI spec"
    );
    assert!(
        !spec.contains("/admin/accounts/{account_id}/plan"),
        "the saas-gated plan route must NOT be in the default (non-saas) OpenAPI spec"
    );
}
