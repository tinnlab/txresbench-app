//! TEST-6 [acceptance, INV-3] — self-serve UNCHANGED (regression).
//!
//! The admin work is purely additive (a new module + extractor); it adds NO branch to
//! the membership-scoped path. So the existing behavior must be identical: a MEMBER
//! still lists their own account's members (200), a non-member still 404s. If a future
//! change accidentally routed the self-serve path through the admin bypass, the
//! non-member 200 here would catch it.

use serde_json::Value;

use crate::account::{create_user, login, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn self_serve_membership_scope_is_unchanged() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Alice owns (is an owner-member of) an ORG account; carol is not a member.
    let alice_id = create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let org = make_org_account(&pool, "Acme Lab", alice_id).await;
    let org_s = org.to_string();
    let _carol_id = create_user(&server, &admin, "carol", "carol@x.test").await;
    let carol = login(&server, "carol").await;

    // A member still reaches their own account's members → 200.
    let member = server
        .client
        .get(server.api_url(&format!("/accounts/{org_s}/members")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(
        member.status().as_u16(),
        200,
        "the account member still lists members (self-serve unchanged)"
    );
    let body: Value = member.json().await.unwrap();
    assert!(
        body["members"]
            .as_array()
            .map(|m| !m.is_empty())
            .unwrap_or(false),
        "the owner appears in the member list: {body}"
    );

    // A non-member still 404s on the same self-serve endpoint (no admin bypass leaked
    // into the membership-scoped path).
    let non_member = server
        .client
        .get(server.api_url(&format!("/accounts/{org_s}/members")))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap();
    assert_eq!(
        non_member.status().as_u16(),
        404,
        "a non-member still 404s the self-serve endpoint (not 200, not 403)"
    );
}
