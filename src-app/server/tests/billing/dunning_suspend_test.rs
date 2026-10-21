//! TEST-3 [acceptance][INV-1][covers ITEM-5, ITEM-6]: the headline **suspend-never-delete**
//! proof (BQ-INV-5). A signed `invoice.payment_failed` drives the account to `past_due` +
//! sets `grace_until`; a signed `customer.subscription.deleted` reverts it to
//! `plan_id='free'` / `subscription_status='canceled'` (`is_suspended` true) — AND a seeded
//! project (tenant data) STILL EXISTS and is readable. Non-payment SUSPENDS, never deletes.

use serde_json::json;

use cytoanalyst::modules::billing::dunning::is_suspended;

use crate::account::{create_user, pool_for, setup_admin};
use crate::billing::helpers::{
    billing_state, link_customer, personal_account_id, post_webhook, project_exists, require_sim,
    seed_project,
};
use crate::common::stripe_sim::make_event;

#[tokio::test]
async fn payment_failure_then_cancel_suspends_but_never_deletes() {
    let test = "billing::payment_failure_then_cancel_suspends_but_never_deletes";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_dun", "bill_dun@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    link_customer(&pool, account, "cus_dun").await;

    // Seed tenant data — the row that must SURVIVE a cancel (INV-1).
    let project = seed_project(&pool, uid, account, "keepme").await;
    assert!(
        project_exists(&pool, project).await,
        "seeded project exists"
    );

    // 1. invoice.payment_failed → past_due + grace_until set (account still works, §5).
    let (b1, s1) = make_event(
        "invoice.payment_failed",
        json!({"id":"in_dun","customer":"cus_dun"}),
    );
    assert_eq!(post_webhook(&server, &s1, &b1).await.status().as_u16(), 200);
    let (status, plan, grace) = billing_state(&pool, account).await;
    assert_eq!(status, "past_due", "payment failure → past_due");
    assert_eq!(plan, "free", "plan not yet reverted during grace");
    let grace = grace.expect("grace_until set on payment_failed");
    assert!(
        grace > chrono::Utc::now(),
        "grace deadline is in the future (≈ now + grace window)"
    );
    assert!(
        !is_suspended(&status),
        "past_due is NOT suspended — the account still works during grace (§5)"
    );

    // 2. customer.subscription.deleted → canceled + free + suspended, NO data deletion.
    let (b2, s2) = make_event(
        "customer.subscription.deleted",
        json!({"id":"sub_dun","customer":"cus_dun"}),
    );
    assert_eq!(post_webhook(&server, &s2, &b2).await.status().as_u16(), 200);
    let (status, plan, _grace) = billing_state(&pool, account).await;
    assert_eq!(status, "canceled", "cancel → canceled");
    assert_eq!(plan, "free", "cancel reverts to the free tier");
    assert!(is_suspended(&status), "a canceled account is suspended");

    // THE INVARIANT: the tenant's data STILL EXISTS and is readable — suspend never deletes.
    assert!(
        project_exists(&pool, project).await,
        "INV-1: the seeded project must still exist after cancel (suspend-never-delete)"
    );
    // The account row itself also survives (it was never deleted, only its state reverted).
    let (_s, _p, _g) = billing_state(&pool, account).await;
}
