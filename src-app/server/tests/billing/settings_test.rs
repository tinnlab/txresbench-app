//! TEST-9 [covers ITEM-9]: `GET/PUT /api/billing/settings` roundtrips `grace_period_days`;
//! 401 (unauth) + 403 (missing `billing::manage`) are covered; out-of-bounds (0, 91) → 400;
//! and the new grace value is honored by the next `invoice.payment_failed` (read-at-use).
//!
//! #295 — `repository::set_grace_period_days` (B3's ITEM-9/DEC-6 single-field writer) was
//! DELETED as an unconsumed `pub` item. The grace roundtrip below has gone through
//! `repository::update_billing_settings` since #41 replaced `put_settings`, so nothing here
//! called the deleted setter. NOTE: that roundtrip is stripe-sim-gated (`require_sim`) and
//! self-skips without `just billing-sim-up`; #295's TEST-6 therefore lands on
//! `settings_knobs_test.rs`, which exercises the same write path with no sim.

use serde_json::json;

use crate::account::{create_user, create_user_without_projects, login, pool_for, setup_admin};
use crate::billing::helpers::{
    billing_state, link_customer, personal_account_id, post_webhook, require_sim,
};
use crate::common::stripe_sim::make_event;
use crate::common::TestServer;

/// GET without a bearer → 401 (enforced before any DB work; no sim needed).
#[tokio::test]
async fn settings_unauthenticated_is_401() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let resp = server
        .client
        .get(server.api_url("/billing/settings"))
        .send()
        .await
        .expect("settings GET");
    assert_eq!(resp.status().as_u16(), 401, "no bearer → 401");
}

/// A user stripped of `billing::manage` → 403 (no sim needed).
#[tokio::test]
async fn settings_without_billing_manage_is_403() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _uid =
        create_user_without_projects(&server, &admin, "bill_set_np", "bill_set_np@cyto.test").await;
    let token = login(&server, "bill_set_np").await;
    let resp = server
        .client
        .get(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("settings GET");
    assert_eq!(resp.status().as_u16(), 403, "missing billing::manage → 403");
}

/// PUT roundtrips the value; out-of-bounds → 400; and the next payment_failed honors it.
#[tokio::test]
async fn settings_roundtrip_bounds_and_honored_by_dunning() {
    let test = "billing::settings_roundtrip_bounds_and_honored_by_dunning";
    if require_sim(test).is_none() {
        return;
    }
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_set", "bill_set@cyto.test").await;
    let token = login(&server, "bill_set").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    link_customer(&pool, account, "cus_set").await;

    // Default GET → 14.
    let resp = server
        .client
        .get(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["grace_period_days"], 14, "default grace is 14 days");

    // Out-of-bounds → 400 (0 and 91).
    for bad in [0, 91] {
        let resp = server
            .client
            .put(server.api_url("/billing/settings"))
            .bearer_auth(&token)
            .json(&json!({ "grace_period_days": bad }))
            .send()
            .await
            .expect("PUT settings");
        assert_eq!(
            resp.status().as_u16(),
            400,
            "grace {bad} out of bounds → 400"
        );
    }

    // Valid PUT → roundtrips.
    let resp = server
        .client
        .put(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .json(&json!({ "grace_period_days": 3 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(
        resp.json::<serde_json::Value>().await.unwrap()["grace_period_days"],
        3
    );

    // Read-at-use: the next payment_failed honors the new 3-day window.
    let before = chrono::Utc::now();
    let (b, s) = make_event(
        "invoice.payment_failed",
        json!({"id":"in_set","customer":"cus_set"}),
    );
    assert_eq!(post_webhook(&server, &s, &b).await.status().as_u16(), 200);
    let (_status, _plan, grace) = billing_state(&pool, account).await;
    let grace = grace.expect("grace set");
    // ≈ now + 3 days (allow a wide slack for test timing): well under 4 days, well over 2.
    assert!(
        grace > before + chrono::Duration::days(2) && grace < before + chrono::Duration::days(4),
        "the new 3-day grace window was honored (grace_until ≈ now + 3d): {grace}"
    );
}
