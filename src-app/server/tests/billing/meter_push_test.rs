//! TEST-3 [acceptance][INV-3][covers ITEM-9][pins PROV-B2-3]: the meter-event push.
//!
//! `report_usage(account, "storage_gb_months", 12.5, <identifier>)` issues a
//! `POST /v1/billing/meter_events` to the **PROV-B0-3** capture stand-in, carrying
//! the right shape `{event_name, payload.stripe_customer_id, payload.value,
//! identifier}`; a re-send with the SAME `identifier` carries that same exactly-once
//! idempotency key (BQ-INV-1) — what makes it idempotent at Stripe. Runs fully local
//! against the stand-in on an ephemeral loopback port (no network, no global-env
//! mutation — the base is a passed parameter, DEC-4).

use cytoanalyst::modules::billing::client::StripeClient;
use cytoanalyst::modules::billing::meter::report_usage;

use crate::account::{create_user, pool_for, setup_admin};
use crate::billing::helpers::personal_account_id;
use crate::common::stripe_sim::meter_capture;

#[tokio::test]
async fn report_usage_pushes_the_right_shape_and_a_stable_identifier() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_mp_u", "bill_mp_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    // Give the account a Stripe customer (report_usage resolves it via PROV-B2-1).
    sqlx::query("UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2")
        .bind("cus_meter_1")
        .bind(account)
        .execute(&pool)
        .await
        .expect("stamp a customer id");

    // Stand up the PROV-B0-3 meter-events capture on an ephemeral loopback port.
    let (router, log) = meter_capture();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind capture listener");
    let addr = listener.local_addr().expect("capture addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    // A client pointed EXPLICITLY at the stand-in (base is a passed param, DEC-4).
    let client = StripeClient::new(format!("http://{addr}"), "sk_test_local");

    // First push.
    report_usage(
        &pool,
        &client,
        account,
        "storage_gb_months",
        12.5,
        "idem-meter-1",
    )
    .await
    .expect("report_usage push");

    let calls = log.calls();
    assert_eq!(calls.len(), 1, "one meter push recorded");
    assert_eq!(calls[0].event_name, "storage_gb_months");
    assert_eq!(calls[0].stripe_customer_id, "cus_meter_1");
    assert_eq!(calls[0].value, "12.5");
    assert_eq!(calls[0].identifier, "idem-meter-1");

    // A re-send with the SAME identifier carries that same exactly-once key — the
    // idempotency key Stripe dedups on (BQ-INV-1).
    report_usage(
        &pool,
        &client,
        account,
        "storage_gb_months",
        12.5,
        "idem-meter-1",
    )
    .await
    .expect("idempotent re-send");
    let calls = log.calls();
    assert_eq!(
        calls.len(),
        2,
        "the reporter sent again (Stripe dedups server-side)"
    );
    assert_eq!(
        calls[1].identifier, "idem-meter-1",
        "the identifier is STABLE across re-send — the exactly-once key (BQ-INV-1)"
    );
    assert_eq!(calls[0].identifier, calls[1].identifier);
}

/// report_usage for an account with NO Stripe customer errors sensibly (the caller
/// B1/B4 decides fatal-vs-skip) rather than pushing a meter event with an empty
/// customer — closes the untested NO_STRIPE_CUSTOMER path.
#[tokio::test]
async fn report_usage_without_a_customer_errors() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_mp_nc", "bill_mp_nc@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    // No customer stamped → resolve_customer is None → a typed error, no push.
    let (router, log) = meter_capture();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let client = StripeClient::new(format!("http://{addr}"), "sk_test_local");

    let err = report_usage(&pool, &client, account, "compute_seconds", 1.0, "idem-nc").await;
    assert!(err.is_err(), "no customer → report_usage errors");
    assert!(
        log.calls().is_empty(),
        "no meter event is pushed when the account has no customer"
    );
}
