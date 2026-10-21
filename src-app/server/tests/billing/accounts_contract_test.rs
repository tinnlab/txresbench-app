//! TEST-7 [acceptance][INV-1][covers ITEM-6, ITEM-8][pins PROV-B2-1]: the cross-epic
//! **PROV-accounts-1** contract.
//!
//! Against the REAL accounts baseline (this branch carries the accounts epic):
//!  - the billing-owned `stripe_customer_id`/`plan_id`/`subscription_status`/
//!    `grace_until` ALTER applies cleanly ON TOP of the accounts baseline — a fresh
//!    account carries the four columns with their safe defaults (ITEM-8);
//!  - B2 keys the tenant on **`account_id`, never `user_id`** (BQ-INV-3): the
//!    forward + reverse resolvers operate on an account uuid, and two distinct
//!    accounts have independent customer links (ITEM-6).
//!
//! No Stripe/sim needed — this is a pure DB + repository contract test, so it always
//! runs (it is the Pact that fails if the accounts shape ever diverges).

use cytoanalyst::modules::billing::repository::{account_by_customer, resolve_customer};

use crate::account::{create_user, pool_for, setup_admin};
use crate::billing::helpers::personal_account_id;

#[tokio::test]
async fn billing_columns_apply_on_the_accounts_baseline_with_defaults() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "bill_ac_u", "bill_ac_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    // The ALTER applied on the accounts baseline: the four columns exist with the §3.5
    // defaults on a fresh account (INV-5 desktop-safe defaults / ITEM-8).
    let row = sqlx::query_as::<
        _,
        (
            Option<String>,
            String,
            String,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        "SELECT stripe_customer_id, plan_id, subscription_status, grace_until \
         FROM accounts WHERE id = $1",
    )
    .bind(account)
    .fetch_one(&pool)
    .await
    .expect("the billing columns exist on the accounts baseline");
    assert_eq!(row.0, None, "stripe_customer_id defaults NULL");
    assert_eq!(row.1, "free", "plan_id defaults 'free'");
    assert_eq!(row.2, "active", "subscription_status defaults 'active'");
    assert_eq!(row.3, None, "grace_until defaults NULL");
}

#[tokio::test]
async fn billing_keys_the_tenant_on_account_id_not_user_id() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid_a = create_user(&server, &admin, "bill_ac_a", "bill_ac_a@cyto.test").await;
    let uid_b = create_user(&server, &admin, "bill_ac_b", "bill_ac_b@cyto.test").await;
    let pool = pool_for(&server).await;
    let account_a = personal_account_id(&pool, uid_a).await;
    let account_b = personal_account_id(&pool, uid_b).await;
    assert_ne!(account_a, account_b);
    // The account id is NOT the user id (the tenant boundary is the account, BQ-INV-3).
    assert_ne!(
        account_a, uid_a,
        "account_id is a distinct key from user_id"
    );

    // Link a customer to account A only, keyed by account_id.
    sqlx::query("UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2")
        .bind("cus_acct_a")
        .bind(account_a)
        .execute(&pool)
        .await
        .expect("stamp account A customer");

    // Forward resolver keys on account_id: A resolves, B is independent (None).
    assert_eq!(
        resolve_customer(&pool, account_a)
            .await
            .expect("resolve A")
            .as_deref(),
        Some("cus_acct_a")
    );
    assert!(resolve_customer(&pool, account_b)
        .await
        .expect("resolve B")
        .is_none());

    // Reverse resolver returns the ACCOUNT id (never a user id).
    assert_eq!(
        account_by_customer(&pool, "cus_acct_a")
            .await
            .expect("reverse"),
        Some(account_a),
        "reverse lookup returns the account_id, not a user_id"
    );
}
