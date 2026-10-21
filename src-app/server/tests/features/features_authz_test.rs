//! TEST-4 [acceptance] [invariant: INV-4] — the admin flag routes are gated: an admin
//! gets 200 on GET + PUT; an authenticated non-admin lacking `features::manage` gets
//! 403 (A9 backend deny); no bearer gets 401. Reaching the route also proves the
//! module is registered/mounted (ITEM-8).

use super::{create_plain_user, features_get, features_put, global_body, DEMO_FLAG};
use crate::account::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn admin_allowed_nonadmin_403_unauth_401() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // --- admin (holds features::manage via *) → 200 on GET and PUT ---
    let (s, body) = features_get(&server, Some(&admin), None).await;
    assert_eq!(s, 200, "admin GET /admin/features → 200: {body}");
    assert!(
        body["flags"].is_array(),
        "GET returns a flags array: {body}"
    );

    let (s, _) = features_put(&server, Some(&admin), DEMO_FLAG, global_body(true)).await;
    assert_eq!(s, 200, "admin PUT /admin/features/{DEMO_FLAG} → 200");

    // --- authenticated non-admin WITHOUT features::manage → 403 on GET and PUT ---
    let plain = create_plain_user(&server, &admin, "plainuser").await;
    let (s, _) = features_get(&server, Some(&plain), None).await;
    assert_eq!(s, 403, "non-admin GET → 403 (lacks features::manage)");
    let (s, _) = features_put(&server, Some(&plain), DEMO_FLAG, global_body(false)).await;
    assert_eq!(s, 403, "non-admin PUT → 403 (lacks features::manage)");

    // --- no bearer → 401 on GET and PUT ---
    let (s, _) = features_get(&server, None, None).await;
    assert_eq!(s, 401, "unauthenticated GET → 401");
    let (s, _) = features_put(&server, None, DEMO_FLAG, global_body(false)).await;
    assert_eq!(s, 401, "unauthenticated PUT → 401");
}
