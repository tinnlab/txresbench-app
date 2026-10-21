//! TEST-6 [covers ITEM-4]: an unhandled `event.type` verifies and returns 200 no-op (no
//! state change) and is still recorded in `billing_webhook_events` (so a redelivery of the
//! unknown type is also a no-op) — design §3.4: unknown types are a fast 200 so Stripe stops
//! retrying.

use serde_json::{json, Value};

use crate::account::{create_user, pool_for, setup_admin};
use crate::billing::helpers::{
    billing_state, count_webhook_events, link_customer, personal_account_id, post_webhook,
    require_sim,
};
use crate::common::stripe_sim::make_event;

#[tokio::test]
async fn unhandled_event_type_is_a_recorded_no_op() {
    let test = "billing::unhandled_event_type_is_a_recorded_no_op";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_unk", "bill_unk@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    link_customer(&pool, account, "cus_unk").await;

    let (body, sig) = make_event(
        "charge.refunded",
        json!({"id":"ch_unk","customer":"cus_unk"}),
    );
    let event_id = serde_json::from_slice::<Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Verified → 200 (no-op), no state change.
    assert_eq!(
        post_webhook(&server, &sig, &body).await.status().as_u16(),
        200
    );
    let (status, plan, grace) = billing_state(&pool, account).await;
    assert_eq!(status, "active", "unknown type does not change status");
    assert_eq!(plan, "free");
    assert!(grace.is_none());

    // …but it IS recorded, so a redelivery is deduped.
    assert_eq!(
        count_webhook_events(&pool, &event_id).await,
        1,
        "the unhandled event is still recorded for idempotency"
    );
}
