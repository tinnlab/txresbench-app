//! TEST-2 [acceptance][INV-1][covers ITEM-6][pins PROV-B2-1]: the account↔Stripe
//! Customer link — BOTH directions + 1:1 reuse.
//!
//! First checkout for an account with a null `stripe_customer_id` creates a Customer
//! against the mock and PERSISTS the id on `accounts.stripe_customer_id`;
//! `resolve_customer(account_id)` returns it; a SECOND checkout REUSES the same
//! Customer (1:1, BQ-INV-9); and the REVERSE `account_by_customer(customer_id)`
//! resolves back to the account (the direction B3's webhook path needs).

use cytoanalyst::modules::billing::repository::{account_by_customer, resolve_customer};

use crate::account::{create_user, login, pool_for, setup_admin};
use crate::billing::helpers::{account_customer, checkout, personal_account_id};

#[tokio::test]
async fn customer_link_persists_reuses_and_reverse_resolves() {
    let test = "billing::customer_link_persists_reuses_and_reverse_resolves";
    if crate::billing::helpers::require_sim(test).is_none() {
        return;
    }

    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_cl_u", "bill_cl_u@cyto.test").await;
    let token = login(&server, "bill_cl_u").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    // Pre: no customer yet; the forward resolver is None.
    assert!(account_customer(&pool, account).await.is_none());
    assert!(resolve_customer(&pool, account)
        .await
        .expect("resolve_customer")
        .is_none());

    // First checkout → a Customer is created + persisted on the account row.
    let r1 = checkout(&server, &token, None, "pro").await;
    assert_eq!(r1.status().as_u16(), 200, "first checkout ok");
    let cust = account_customer(&pool, account)
        .await
        .expect("stripe_customer_id persisted after first checkout");
    assert!(cust.starts_with("cus_"), "a Stripe customer id: {cust}");

    // The forward resolver returns exactly the persisted id.
    assert_eq!(
        resolve_customer(&pool, account)
            .await
            .expect("resolve_customer")
            .as_deref(),
        Some(cust.as_str()),
        "resolve_customer returns the persisted id"
    );

    // Second checkout REUSES the same Customer (1:1 — no second customer id).
    let r2 = checkout(&server, &token, None, "pro").await;
    assert_eq!(r2.status().as_u16(), 200, "second checkout ok");
    assert_eq!(
        account_customer(&pool, account).await.as_deref(),
        Some(cust.as_str()),
        "the SAME Customer is reused on a second checkout (1:1, BQ-INV-9)"
    );

    // REVERSE direction (B3's webhook path): customer_id → account_id, exact.
    assert_eq!(
        account_by_customer(&pool, &cust)
            .await
            .expect("account_by_customer"),
        Some(account),
        "the reverse lookup resolves the customer back to its account"
    );
    // A customer id that belongs to no account resolves to None (not a wrong account).
    assert!(account_by_customer(&pool, "cus_does_not_exist")
        .await
        .expect("account_by_customer none")
        .is_none());
}
