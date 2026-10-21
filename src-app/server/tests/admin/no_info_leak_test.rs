//! TEST-5 [acceptance, INV-1] — NO info leak.
//!
//! (a) The UNCHANGED self-serve path: a non-member requesting another account's
//!     resource gets **404 byte-identical** to a genuinely-nonexistent id — never
//!     403, never any data (the existence-oracle guard, preserved because the admin
//!     work did not touch the account module).
//! (b) The admin path: a non-admin gets **403 byte-identical** whether the requested
//!     account EXISTS or NOT — the 403 precedes any lookup, so the admin route is not
//!     an existence oracle either (DEC-2).

use super::admin_get_account;
use crate::account::{create_user, login, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn no_info_leak_self_serve_404_and_admin_403_are_existence_blind() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Alice owns an ORG account; carol is not a member of it.
    let alice_id = create_user(&server, &admin, "alice", "alice@x.test").await;
    let org = make_org_account(&pool, "Acme Lab", alice_id).await;
    let org_s = org.to_string();
    let _carol_id = create_user(&server, &admin, "carol", "carol@x.test").await;
    let carol = login(&server, "carol").await;
    let ghost = uuid::Uuid::new_v4().to_string();

    // --- (a) self-serve: cross-account vs nonexistent are 404 + byte-identical.
    let cross = server
        .client
        .get(server.api_url(&format!("/accounts/{org_s}/members")))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap();
    let ghost_resp = server
        .client
        .get(server.api_url(&format!("/accounts/{ghost}/members")))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap();
    assert_eq!(
        cross.status().as_u16(),
        404,
        "self-serve cross-account → 404"
    );
    assert_eq!(
        ghost_resp.status().as_u16(),
        404,
        "self-serve nonexistent → 404"
    );
    let cross_body = cross.text().await.unwrap();
    let ghost_body = ghost_resp.text().await.unwrap();
    assert_eq!(
        cross_body, ghost_body,
        "self-serve 404 body must be BYTE-IDENTICAL to a nonexistent id (no oracle)"
    );

    // --- (b) admin path: a non-admin's 403 does not depend on account existence.
    let (exists_status, exists_body) = admin_get_account(&server, Some(&carol), &org_s).await;
    let (ghost_status, ghost_body2) = admin_get_account(&server, Some(&carol), &ghost).await;
    assert_eq!(
        exists_status, 403,
        "admin path, non-admin, real account → 403"
    );
    assert_eq!(
        ghost_status, 403,
        "admin path, non-admin, nonexistent → 403"
    );
    assert_eq!(
        exists_body, ghost_body2,
        "the admin 403 must be BYTE-IDENTICAL whether the account exists or not (no oracle)"
    );
}
