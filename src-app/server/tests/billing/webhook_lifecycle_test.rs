//! TEST-5 [acceptance][INV-4][covers ITEM-4, ITEM-5, ITEM-8]: billing-state stays in sync
//! with Stripe. The full lifecycle walk — checkout.completed → payment_failed → invoice.paid
//! → subscription.updated (plan re-derived) → subscription.deleted — with
//! `subscription_status` mirroring the event at each step, the account resolved from the
//! event `customer` (reverse link), and a detached `AccountUsage` sync frame emitted on a
//! state change (ITEM-8 / DEC-12).

use serde_json::json;

use crate::account::{create_user, login, pool_for, setup_admin};
use crate::billing::helpers::{
    base_price_for, billing_state, link_customer, personal_account_id, post_webhook, require_sim,
};
use crate::common::stripe_sim::make_event;
use crate::common::sync_probe::SyncProbe;

#[tokio::test]
async fn webhook_walks_the_full_lifecycle_in_sync() {
    let test = "billing::webhook_walks_the_full_lifecycle_in_sync";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_life", "bill_life@cyto.test").await;
    let token = login(&server, "bill_life").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    link_customer(&pool, account, "cus_life").await;

    // 1. checkout.session.completed → active.
    let (b, s) = make_event(
        "checkout.session.completed",
        json!({"id":"cs_life","object":"checkout.session","customer":"cus_life","subscription":"sub_life"}),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    assert_eq!(
        billing_state(&pool, account).await.0,
        "active",
        "checkout → active"
    );

    // 2. invoice.payment_failed → past_due. Open the OWNER's sync stream first, then inject:
    //    the state change must fan a detached AccountUsage frame (ITEM-8 / DEC-12).
    let mut probe = SyncProbe::open(&server, &token).await;
    let (b, s) = make_event(
        "invoice.payment_failed",
        json!({"id":"in_life","customer":"cus_life"}),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    assert_eq!(
        billing_state(&pool, account).await.0,
        "past_due",
        "payment_failed → past_due"
    );
    let account_id = account.to_string();
    let frame = probe
        .expect_event_for(
            "account_usage",
            "update",
            &account_id,
            std::time::Duration::from_secs(20),
        )
        .await;
    assert_eq!(
        frame.id, account_id,
        "the billing-state change fanned an AccountUsage frame"
    );

    // 3. invoice.paid → active + grace cleared.
    let (b, s) = make_event(
        "invoice.paid",
        json!({"id":"in_life2","customer":"cus_life"}),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    let (status, _plan, grace) = billing_state(&pool, account).await;
    assert_eq!(status, "active", "invoice.paid → active");
    assert!(grace.is_none(), "invoice.paid cleared the grace deadline");

    // 4. customer.subscription.updated with the PRO base price → plan re-derived to `pro`.
    let (b, s) = make_event(
        "customer.subscription.updated",
        json!({
            "id":"sub_life","customer":"cus_life","status":"active",
            "items": { "data": [ { "price": { "id": base_price_for("pro") } } ] }
        }),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    let (status, plan, _grace) = billing_state(&pool, account).await;
    assert_eq!(status, "active", "updated mirrors Subscription.status");
    assert_eq!(
        plan, "pro",
        "the plan is re-derived from the subscription's price"
    );

    // 5. customer.subscription.deleted → canceled + free.
    let (b, s) = make_event(
        "customer.subscription.deleted",
        json!({"id":"sub_life","customer":"cus_life"}),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    let (status, plan, _grace) = billing_state(&pool, account).await;
    assert_eq!(status, "canceled", "deleted → canceled");
    assert_eq!(plan, "free", "deleted reverts to free");
}
