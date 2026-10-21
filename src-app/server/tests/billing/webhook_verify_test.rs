//! TEST-1 [acceptance][INV-2][covers ITEM-1, ITEM-2] + TEST-2
//! [acceptance][INV-2][negative-control][covers ITEM-2]: the REAL `/api/billing/webhook`
//! handler (replacing B0's placeholder, DEC-8) verifies a locally-signed body (200) and
//! REJECTS a tampered / unsigned / wrong-secret / stale body (401 `BAD_STRIPE_SIGNATURE`),
//! driving NO state change. Runs in B0's L2 harness (PROV-B0-5) with PROV-B0-2's injector;
//! NO real Stripe, NO network.

use serde_json::json;

use crate::account::{create_user, pool_for, setup_admin};
use crate::billing::helpers::{
    billing_state, link_customer, personal_account_id, post_webhook, require_sim,
};
use crate::common::stripe_sim::{make_event, make_event_with, DEFAULT_TEST_WHSEC};

/// TEST-1 — a validly-signed event is accepted (200) and dispatched.
#[tokio::test]
async fn webhook_accepts_a_validly_signed_event() {
    let test = "billing::webhook_accepts_a_validly_signed_event";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_wv_ok", "bill_wv_ok@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    link_customer(&pool, account, "cus_verify_ok").await;

    let (body, sig) = make_event(
        "invoice.payment_failed",
        json!({"id":"in_ok","customer":"cus_verify_ok"}),
    );
    let resp = post_webhook(&server, &sig, &body).await;
    assert_eq!(resp.status().as_u16(), 200, "validly-signed event accepted");

    // The real handler verified the `t=,v1=` HMAC over the raw body AND dispatched.
    let (status, _plan, grace) = billing_state(&pool, account).await;
    assert_eq!(
        status, "past_due",
        "the verified event drove the dunning transition"
    );
    assert!(grace.is_some(), "grace deadline set on payment_failed");
}

/// TEST-2 — the negative controls: every bad-signature variant is 401 and changes NO state.
#[tokio::test]
async fn webhook_rejects_tampered_unsigned_wrong_secret_and_stale() {
    let test = "billing::webhook_rejects_tampered_unsigned_wrong_secret_and_stale";
    if require_sim(test).is_none() {
        return;
    }
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_wv_bad", "bill_wv_bad@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    link_customer(&pool, account, "cus_reject").await;
    let obj = json!({"id":"in_bad","customer":"cus_reject"});

    // (a) tampered body, original signature.
    let (body, sig) = make_event("invoice.payment_failed", obj.clone());
    let mut tampered = body.to_vec();
    tampered[20] ^= 0xFF;
    assert_eq!(
        post_webhook(&server, &sig, &tampered)
            .await
            .status()
            .as_u16(),
        401,
        "tampered body → 401"
    );

    // (b) unsigned (no signature header value at all).
    let (body2, _sig2) = make_event("invoice.payment_failed", obj.clone());
    assert_eq!(
        post_webhook(&server, "", &body2).await.status().as_u16(),
        401,
        "unsigned body → 401"
    );

    // (c) wrong secret — a signature valid for a DIFFERENT whsec.
    let ts = chrono::Utc::now().timestamp();
    let (body3, sig3) = make_event_with("invoice.payment_failed", obj.clone(), "whsec_wrong", ts);
    assert_eq!(
        post_webhook(&server, &sig3, &body3).await.status().as_u16(),
        401,
        "wrong-secret signature → 401"
    );

    // (d) stale timestamp — signature valid but `t` is far in the past (>300s).
    let (body4, sig4) = make_event_with(
        "invoice.payment_failed",
        obj.clone(),
        DEFAULT_TEST_WHSEC,
        ts - 400,
    );
    assert_eq!(
        post_webhook(&server, &sig4, &body4).await.status().as_u16(),
        401,
        "stale timestamp → 401"
    );

    // NONE of the rejected bodies dispatched — the account is still at its default state.
    let (status, plan, grace) = billing_state(&pool, account).await;
    assert_eq!(status, "active", "no rejected event changed the status");
    assert_eq!(plan, "free");
    assert!(grace.is_none(), "no rejected event set a grace deadline");
}
