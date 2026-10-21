//! TEST-1 [acceptance][INV-2][covers ITEM-2, ITEM-3][pins PROV-B2-4]: the
//! self-serve Checkout endpoint.
//!
//! `POST /api/billing/checkout` for a Free account returns a spec-valid
//! subscription-mode Checkout Session (a `checkout_url`) created against the B0
//! stripe-mock with NO network — and the account's `plan_id` stays `free` (INV-2:
//! the webhook flips it, not this endpoint). The authz gate (401 unauth + 403
//! missing `billing::manage`) is covered.

use crate::account::{create_user, create_user_without_projects, login, pool_for, setup_admin};
use crate::billing::helpers::{account_plan, checkout, checkout_unauth, personal_account_id};

#[tokio::test]
async fn checkout_creates_subscription_session_without_flipping_plan() {
    let test = "billing::checkout_creates_subscription_session_without_flipping_plan";
    if crate::billing::helpers::require_sim(test).is_none() {
        return;
    }

    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_co_u", "bill_co_u@cyto.test").await;
    let token = login(&server, "bill_co_u").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    // Precondition: a fresh account is on the free plan and has no Stripe customer.
    assert_eq!(account_plan(&pool, account).await, "free", "starts on free");

    let resp = checkout(&server, &token, None, "pro").await;
    assert_eq!(
        resp.status().as_u16(),
        200,
        "checkout for a free account → 200"
    );
    let body: serde_json::Value = resp.json().await.expect("checkout json");
    let url = body["checkout_url"].as_str().expect("checkout_url present");
    assert!(
        url.starts_with("http"),
        "a hosted checkout url came back from the mock: {url}"
    );

    // INV-2: the endpoint did NOT flip the plan — that is the webhook's job (B3). A
    // user who abandons the hosted page has changed nothing.
    assert_eq!(
        account_plan(&pool, account).await,
        "free",
        "checkout must NOT flip plan_id (INV-2 — the webhook does)"
    );
}

#[tokio::test]
async fn checkout_unauthenticated_is_401() {
    // No sim needed: the 401 is enforced before any Stripe call.
    let server = crate::common::TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let resp = checkout_unauth(&server, "pro").await;
    assert_eq!(resp.status().as_u16(), 401, "no bearer → 401");
}

#[tokio::test]
async fn checkout_without_billing_manage_is_403() {
    // A user stripped from the Users group loses `billing::manage` → 403, before any
    // Stripe call (so no sim needed).
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _uid =
        create_user_without_projects(&server, &admin, "bill_co_np", "bill_co_np@cyto.test").await;
    let token = login(&server, "bill_co_np").await;
    let resp = checkout(&server, &token, None, "pro").await;
    assert_eq!(resp.status().as_u16(), 403, "missing billing::manage → 403");
}
