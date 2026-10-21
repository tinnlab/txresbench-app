//! TEST-4 [acceptance][INV-2][covers ITEM-4][pins PROV-B2-4]: the Customer Portal
//! endpoint.
//!
//! `POST /api/billing/portal` for an account WITH a Customer returns a spec-valid
//! Portal Session `portal_url` against the mock; a portal request for an account
//! with NO Customer yet returns a typed 400 (not a 500). 401/403 covered.

use crate::account::{create_user, create_user_without_projects, login, pool_for, setup_admin};
use crate::billing::helpers::{checkout, personal_account_id, portal};

#[tokio::test]
async fn portal_returns_url_for_an_account_with_a_customer() {
    let test = "billing::portal_returns_url_for_an_account_with_a_customer";
    if crate::billing::helpers::require_sim(test).is_none() {
        return;
    }

    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_po_u", "bill_po_u@cyto.test").await;
    let token = login(&server, "bill_po_u").await;
    let pool = pool_for(&server).await;
    let _account = personal_account_id(&pool, uid).await;

    // Give the account a Customer by running checkout first.
    let c = checkout(&server, &token, None, "pro").await;
    assert_eq!(c.status().as_u16(), 200, "checkout to create a customer");

    let resp = portal(&server, &token, None).await;
    assert_eq!(resp.status().as_u16(), 200, "portal for a customer → 200");
    let body: serde_json::Value = resp.json().await.expect("portal json");
    let url = body["portal_url"].as_str().expect("portal_url present");
    assert!(url.starts_with("http"), "a hosted portal url: {url}");
}

#[tokio::test]
async fn portal_without_a_customer_is_typed_400_not_500() {
    let test = "billing::portal_without_a_customer_is_typed_400_not_500";
    // This path is fully local (no Stripe call before the 400), but keep the guard so
    // the tier stays uniform when run credential-free.
    if crate::billing::helpers::require_sim(test).is_none() {
        return;
    }

    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _uid = create_user(&server, &admin, "bill_po_nc", "bill_po_nc@cyto.test").await;
    let token = login(&server, "bill_po_nc").await;

    // No checkout → no Customer → a typed 400, NOT a 500.
    let resp = portal(&server, &token, None).await;
    assert_eq!(
        resp.status().as_u16(),
        400,
        "portal with no customer yet → typed 400 (not 500)"
    );
}

#[tokio::test]
async fn portal_unauthenticated_is_401() {
    let server = crate::common::TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let resp = server
        .client
        .post(server.api_url("/billing/portal"))
        .send()
        .await
        .expect("unauth portal");
    assert_eq!(resp.status().as_u16(), 401, "no bearer → 401");
}

#[tokio::test]
async fn portal_without_billing_manage_is_403() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _uid =
        create_user_without_projects(&server, &admin, "bill_po_np", "bill_po_np@cyto.test").await;
    let token = login(&server, "bill_po_np").await;
    let resp = portal(&server, &token, None).await;
    assert_eq!(resp.status().as_u16(), 403, "missing billing::manage → 403");
}
