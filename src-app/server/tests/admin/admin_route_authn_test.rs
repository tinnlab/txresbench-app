//! TEST-7 [ITEM-3] — the admin route requires authentication (401 with no bearer).
//! TEST-8 [ITEM-3, ITEM-2] — an authorized admin GETting a genuinely-nonexistent
//! account id gets 404 (an admin MAY learn existence; distinct from the uniform 403 a
//! non-admin gets — confirms DEC-2's authorize-before-lookup ordering).

use super::admin_get_account;
use crate::account::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn admin_route_requires_authentication() {
    let server = TestServer::spawn().await;
    // Bootstrap an admin so the app is past first-run, but send NO bearer.
    let _admin = setup_admin(&server).await;
    let some_id = uuid::Uuid::new_v4().to_string();

    let (status, body) = admin_get_account(&server, None, &some_id).await;
    assert_eq!(
        status, 401,
        "the admin route rejects an unauthenticated request (401, before any authz/lookup): {body}"
    );
}

#[tokio::test]
async fn admin_on_nonexistent_account_gets_404_not_403() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ghost = uuid::Uuid::new_v4().to_string();

    let (status, body) = admin_get_account(&server, Some(&admin), &ghost).await;
    assert_eq!(
        status, 404,
        "an authorized admin GETting a nonexistent account id gets 404 (existence is not hidden from an admin): {body}"
    );
}
