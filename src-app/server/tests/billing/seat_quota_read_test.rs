//! #141 TEST-10 [covers: ITEM-8] — the seat fields on the quota READ surface.
//!
//! `member_allowance` + `members_used` on `QuotaStateResponse`, which is what lets #149
//! render "7 of 10 seats" without a new route (the same DTO backs `GET /api/billing/quota`
//! and the admin `GET /api/admin/accounts/{account_id}/quota` via `build_quota_state`).
//!
//! Lives in `tests/billing/`, not `tests/account/`, for the reason every billing HTTP
//! acceptance test here does: the billing route surface mounts only when a Stripe secret is
//! configured (billing's §16 deploy kill-switch), which the saas tier
//! (`just billing-sim-test-l2-saas`) exports. NO Stripe call, NO network — a pure DB read
//! through the admin route, exactly like `admin_billing_read_test.rs`.

use serde_json::Value;

use crate::account::{add_member, create_user, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

async fn member_count(pool: &sqlx::PgPool, account: uuid::Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM account_members WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("count members")
}

/// TEST-10 — the read surface carries the plan's seat allowance and the LIVE member count.
///
/// `members_used` is checked BEFORE and AFTER a member is added. A constant, or a value
/// sourced from `usage_rollup` (which has no headcount dimension at all), would pass the
/// first check and fail the second — which is the whole point of re-reading.
#[tokio::test]
async fn test10_quota_read_surface_carries_member_allowance_and_live_count() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Read from the CATALOG, never hardcoded: the numbers are an owner call (#141 DEC-8)
    // and re-pricing must not break this test.
    let limit = cytoanalyst::modules::billing::catalog::plan("free")
        .expect("the free plan exists")
        .member_allowance;

    let owner = create_user(&server, &admin, "seatq_owner", "seatq_owner@x.test").await;
    let org = make_org_account(&pool, "Seat Quota Lab", owner).await;

    let read = |account: uuid::Uuid| {
        let server = &server;
        let admin = &admin;
        async move {
            let resp = server
                .client
                .get(server.api_url(&format!("/admin/accounts/{account}/quota")))
                .bearer_auth(admin)
                .send()
                .await
                .expect("admin quota read");
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            (status, body)
        }
    };

    let (status, body) = read(org).await;
    assert_eq!(
        status, 200,
        "quota read (needs the billing routes mounted — run in the saas billing tier): {body}"
    );
    assert_eq!(
        body["member_allowance"], limit,
        "the plan's seat allowance, projected from the catalog: {body}"
    );
    assert_eq!(
        body["members_used"],
        member_count(&pool, org).await,
        "the LIVE member count: {body}"
    );

    // Add one, re-read: it must MOVE.
    let u = create_user(&server, &admin, "seatq_u", "seatq_u@x.test").await;
    add_member(&pool, org, u, "member").await;

    let (status2, body2) = read(org).await;
    assert_eq!(status2, 200, "second quota read: {body2}");
    assert_eq!(
        body2["members_used"],
        member_count(&pool, org).await,
        "members_used tracks the live count rather than being a constant: {body2}"
    );
    assert_ne!(
        body2["members_used"], body["members_used"],
        "and it actually CHANGED between the two reads"
    );
    assert_eq!(
        body2["member_allowance"], limit,
        "while the ALLOWANCE is unmoved — it comes from the plan, not from usage"
    );
}
