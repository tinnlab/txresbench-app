//! #38 — the admin plan/tier override (write plan_id directly, no Stripe) + the
//! webhook-vs-override RECONCILIATION (the correctness crux). Mirrors `credits_test` (drive the
//! admin billing::admin HTTP surface against the real server; call `check_quota` directly) and
//! `webhook_lifecycle_test` (inject locally-signed Stripe events into the real `/api/billing/webhook`).
//! The webhook-posting tests guard on the sim env (`require_sim`); the pure PUT/DELETE tests do not.

use cytoanalyst::modules::billing::quota::{check_quota, QuotaAsk, QuotaVerdict};
use serde_json::json;

use crate::account::{create_user, login, pool_for, setup_admin};
use crate::billing::helpers::{
    base_price_for, billing_state, clear_plan, link_customer, personal_account_id, plan_state,
    post_webhook, require_sim, seed_rollup_usage, set_plan,
};
use crate::common::stripe_sim::make_event;

const FREE_COMPUTE_ALLOWANCE: f64 = 1.0;

fn ask(n: f64) -> QuotaAsk {
    QuotaAsk::Compute { resource_class: "cpu".into(), est_core_hours: n }
}

// TEST-7 [acceptance][invariant: INV-3] — an admin PUT /plan writes plan_id DIRECTLY (no Stripe)
// and the new allowance takes effect immediately in check_quota.
#[tokio::test]
async fn admin_set_plan_changes_plan_id_and_allowance_immediately() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "plan_u1", "plan_u1@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let acct = account.to_string();

    // A FREE account AT its allowance: a positive ask is over-allowance → hard-block (control).
    seed_rollup_usage(&pool, account, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    assert!(
        matches!(check_quota(&pool, account, ask(0.5)).await.expect("cq"), QuotaVerdict::BlockOverQuota { .. }),
        "free at allowance, over-ask → Block (control)"
    );

    // Admin sets the plan to pro directly — no Stripe.
    let resp = set_plan(&server, Some(&admin), &acct, "pro").await;
    assert_eq!(resp.status().as_u16(), 200, "PUT /plan → 200");
    let body: serde_json::Value = resp.json().await.expect("plan json");
    assert_eq!(body["plan_id"], json!("pro"));
    assert_eq!(body["plan_manually_set"], json!(true));
    assert!(!body["plan_override_at"].is_null(), "override_at stamped");

    let (plan_id, manual) = plan_state(&pool, account).await;
    assert_eq!(plan_id, "pro", "plan_id written directly");
    assert!(manual, "plan_manually_set marker set");

    // The pro allowance (100 core-h) now covers the same ask (used 1.0 + 0.5 ≤ 100) → Allow.
    assert_eq!(
        check_quota(&pool, account, ask(0.5)).await.expect("cq"),
        QuotaVerdict::Allow,
        "the new pro allowance takes effect immediately in check_quota"
    );

    // Reject an unknown plan id → 400, and the plan is unchanged.
    let bad = set_plan(&server, Some(&admin), &acct, "enterprise").await;
    assert_eq!(bad.status().as_u16(), 400, "unknown plan → 400 INVALID_PLAN");
    assert_eq!(plan_state(&pool, account).await.0, "pro", "a rejected set did not change the plan");
}

// TEST-8 [acceptance][invariant: INV-4] — the reconciliation crux: after an admin override, a
// Stripe webhook does NOT clobber plan_id, but DOES still advance subscription_status.
#[tokio::test]
async fn webhook_after_override_does_not_clobber_plan_but_updates_status() {
    let test = "billing::webhook_after_override_does_not_clobber_plan_but_updates_status";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "plan_u2", "plan_u2@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let acct = account.to_string();
    link_customer(&pool, account, "cus_ovr").await;

    // Admin comps the account onto pro (marker set).
    assert_eq!(set_plan(&server, Some(&admin), &acct, "pro").await.status().as_u16(), 200);
    assert_eq!(plan_state(&pool, account).await, ("pro".to_string(), true));

    // A signed subscription.updated whose price maps to FREE and status past_due arrives. WITHOUT
    // the override this would re-derive plan_id → free; WITH it, plan_id stays pro.
    let (b, s) = make_event(
        "customer.subscription.updated",
        json!({
            "id":"sub_ovr","customer":"cus_ovr","status":"past_due",
            "items": { "data": [ { "price": { "id": base_price_for("free") } } ] }
        }),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);

    let (status, plan, _grace) = billing_state(&pool, account).await;
    assert_eq!(plan, "pro", "the admin override is NOT clobbered by the webhook (the crux)");
    assert_eq!(status, "past_due", "but the subscription_status STILL advanced with the webhook");
    assert!(plan_state(&pool, account).await.1, "the override marker is still set");
}

// TEST-9 [acceptance][invariant: INV-6] — WITHOUT an override the webhook plan-write path is
// byte-preserved (it DOES update plan_id); and DELETE /plan clears the marker so control returns
// to Stripe (a subsequent webhook then reconciles plan_id). (DEC-7.)
#[tokio::test]
async fn no_override_webhook_updates_plan_and_delete_hands_control_back() {
    let test = "billing::no_override_webhook_updates_plan_and_delete_hands_control_back";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "plan_u3", "plan_u3@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let acct = account.to_string();
    link_customer(&pool, account, "cus_noovr").await;

    let pro_update = || {
        make_event(
            "customer.subscription.updated",
            json!({
                "id":"sub_noovr","customer":"cus_noovr","status":"active",
                "items": { "data": [ { "price": { "id": base_price_for("pro") } } ] }
            }),
        )
    };

    // Part A — no override: the webhook DOES re-derive plan_id to pro (existing path unchanged).
    assert_eq!(plan_state(&pool, account).await, ("free".to_string(), false));
    let (b, s) = pro_update();
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    assert_eq!(plan_state(&pool, account).await.0, "pro", "no override → webhook updates plan_id (byte-preserved)");

    // Part B — set an override to free, confirm the SAME webhook is now blocked, then DELETE the
    // override and confirm the webhook reconciles plan_id again.
    assert_eq!(set_plan(&server, Some(&admin), &acct, "free").await.status().as_u16(), 200);
    assert_eq!(plan_state(&pool, account).await, ("free".to_string(), true));
    // The dedupe table keys on event.id, so use a fresh id per post.
    let (b, s) = make_event(
        "customer.subscription.updated",
        json!({"id":"sub_noovr2","customer":"cus_noovr","status":"active",
               "items": { "data": [ { "price": { "id": base_price_for("pro") } } ] }}),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    assert_eq!(plan_state(&pool, account).await.0, "free", "override protects plan_id from the webhook");

    // DELETE the override → marker cleared, plan_id left as-is (free).
    let del = clear_plan(&server, Some(&admin), &acct).await;
    assert_eq!(del.status().as_u16(), 200, "DELETE /plan → 200");
    assert_eq!(plan_state(&pool, account).await, ("free".to_string(), false), "marker cleared, plan_id unchanged");

    // Now a webhook reconciles plan_id again (control handed back to Stripe).
    let (b, s) = make_event(
        "customer.subscription.updated",
        json!({"id":"sub_noovr3","customer":"cus_noovr","status":"active",
               "items": { "data": [ { "price": { "id": base_price_for("pro") } } ] }}),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    assert_eq!(plan_state(&pool, account).await.0, "pro", "after clear, the webhook reconciles plan_id again");
}

// TEST-10 (plan half) [acceptance][invariant: INV-5] — the plan routes require billing::admin:
// unauth → 401, a non-admin → 403 on PUT + DELETE; the plan/marker are UNCHANGED after a rejected
// call (the A9 backend deny path for #38).
#[tokio::test]
async fn plan_routes_require_billing_admin() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "plan_u4", "plan_u4@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let acct = account.to_string();

    // A plain user (Users group only — no billing::admin).
    let _p = create_user(&server, &admin, "plan_plain", "plan_plain@cyto.test").await;
    let plain = login(&server, "plan_plain").await;

    // unauth → 401.
    assert_eq!(set_plan(&server, None, &acct, "pro").await.status().as_u16(), 401, "PUT unauth 401");
    assert_eq!(clear_plan(&server, None, &acct).await.status().as_u16(), 401, "DELETE unauth 401");
    // non-admin → 403.
    assert_eq!(set_plan(&server, Some(&plain), &acct, "pro").await.status().as_u16(), 403, "PUT 403");
    assert_eq!(clear_plan(&server, Some(&plain), &acct).await.status().as_u16(), 403, "DELETE 403");

    // The rejected writes did NOT change the plan or set the marker.
    assert_eq!(plan_state(&pool, account).await, ("free".to_string(), false), "a denied plan write changed nothing");
}
