//! TEST-4 [acceptance][INV-3][covers ITEM-3] + TEST-10 [acceptance][INV-3][covers ITEM-3,
//! ITEM-7] [pins PROV-B3-2]: a redelivered event is a NO-OP. The SAME signed event delivered
//! twice returns 200 both times, changes NO state on the second delivery, and leaves EXACTLY
//! ONE `billing_webhook_events` row (the dedupe PK on `event.id`; the mark is written in the
//! same txn as the state change — DEC-5).

use serde_json::{json, Value};

use crate::account::{create_user, pool_for, setup_admin};
use crate::billing::helpers::{
    billing_state, count_webhook_events, link_customer, personal_account_id, post_webhook,
    require_sim,
};
use crate::common::stripe_sim::make_event;

#[tokio::test]
async fn redelivered_event_is_a_no_op() {
    let test = "billing::redelivered_event_is_a_no_op";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_idem", "bill_idem@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    link_customer(&pool, account, "cus_idem").await;

    // Build ONE event (a fixed `event.id`) and deliver it TWICE.
    let (body, sig) = make_event(
        "invoice.payment_failed",
        json!({"id":"in_idem","customer":"cus_idem"}),
    );
    let event_id = serde_json::from_slice::<Value>(&body)
        .expect("parse body")
        .get("id")
        .and_then(|v| v.as_str())
        .expect("event id")
        .to_string();

    // First delivery: applies past_due + grace G1, records exactly one dedupe row.
    assert_eq!(
        post_webhook(&server, &sig, &body).await.status().as_u16(),
        200
    );
    let (status1, _plan1, grace1) = billing_state(&pool, account).await;
    assert_eq!(status1, "past_due");
    let grace1 = grace1.expect("grace set on first delivery");
    assert_eq!(
        count_webhook_events(&pool, &event_id).await,
        1,
        "exactly one dedupe row after the first delivery"
    );

    // Second delivery of the SAME event: 200, but NO state change (deduped on event.id).
    assert_eq!(
        post_webhook(&server, &sig, &body).await.status().as_u16(),
        200
    );
    let (status2, _plan2, grace2) = billing_state(&pool, account).await;
    assert_eq!(status2, "past_due", "status unchanged on redelivery");
    assert_eq!(
        grace2.expect("grace still set"),
        grace1,
        "INV-3: the grace deadline was NOT re-advanced — the redelivery applied nothing"
    );
    assert_eq!(
        count_webhook_events(&pool, &event_id).await,
        1,
        "PROV-B3-2: still exactly one dedupe row — the redelivery left one effect, not two"
    );
}
