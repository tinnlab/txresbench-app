//! TEST-3 [acceptance, INV-2] + TEST-4 [acceptance, INV-4] — the core #31 proof.
//!
//! INV-2 (admin reaches any account): a root admin AND a non-admin holding
//! `admin::accounts` both resolve an ORG account they are NOT members of → 200.
//! INV-4 (bypass gated on admin ONLY): a non-admin holding only UNRELATED perms → 403
//! (the negative control + the A9 backend deny path).

use serde_json::Value;

use super::{admin_get_account, create_admin_accounts_holder};
use crate::account::{create_user, login, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn admin_and_grant_holder_reach_a_foreign_account_but_unrelated_perm_is_denied() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Alice owns an ORG account. Neither the root admin, the grant-holder, nor the
    // unrelated-perm user is a member of it — so any 200 here is a MEMBERSHIP-FREE
    // admin resolution, exactly the #31 bypass.
    let alice_id = create_user(&server, &admin, "alice", "alice@x.test").await;
    let org = make_org_account(&pool, "Acme Lab", alice_id).await;
    let org_s = org.to_string();

    // --- INV-2a: the root admin (is_admin) reaches it → 200 + the account body.
    let (status, body) = admin_get_account(&server, Some(&admin), &org_s).await;
    assert_eq!(status, 200, "root admin reaches a foreign account: {body}");
    let acct: Value = serde_json::from_str(&body).expect("account json");
    assert_eq!(
        acct["id"],
        Value::String(org_s.clone()),
        "the right account"
    );
    assert_eq!(acct["kind"], "organization");
    assert_eq!(acct["name"], "Acme Lab");

    // --- INV-2b: a NON-admin holding admin::accounts (via a group) reaches it → 200.
    let holder = create_admin_accounts_holder(&server, &admin, "bob", "bob@x.test").await;
    let (status, body) = admin_get_account(&server, Some(&holder), &org_s).await;
    assert_eq!(
        status, 200,
        "an admin::accounts holder reaches a foreign account (grant, not is_admin): {body}"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["id"],
        Value::String(org_s.clone())
    );

    // --- INV-4: a non-admin holding only the default Users perms (account::read,
    // billing::*, …) but NOT admin::accounts is DENIED → 403 (the negative control;
    // the bypass is gated on is_admin/admin::accounts ONLY).
    let _carol_id = create_user(&server, &admin, "carol", "carol@x.test").await;
    let carol = login(&server, "carol").await;
    let (status, body) = admin_get_account(&server, Some(&carol), &org_s).await;
    assert_eq!(
        status, 403,
        "a non-admin with only unrelated perms is denied the admin surface: {body}"
    );
}
