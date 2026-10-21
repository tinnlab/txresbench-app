//! TEST-17 [A9 deny] — a user LACKING `infra::settings::manage` is refused 403 on GET/PUT/
//! test for BOTH surfaces; the root admin (who holds it via `*`/is_admin) succeeds.

use serde_json::json;

use crate::account::{create_user, login, setup_admin};
use crate::common::TestServer;
use crate::infra::encrypted_opts;

/// TEST-17 [covers: ITEM-3, ITEM-10]: A9 backend deny — a normal user (no
/// `infra::settings::manage`) gets 403 on every infra endpoint; an admin gets 200 on GET.
#[tokio::test]
async fn non_infra_admin_is_denied_403_on_all_endpoints() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    // A normal user: no infra permission (it is admin-only, not group-granted).
    create_user(&server, &admin, "plainuser", "plain@cyto.test").await;
    let user = login(&server, "plainuser").await;

    let endpoints_get = [
        "/admin/infra/object-store",
        "/admin/infra/compute",
    ];
    for path in endpoints_get {
        // Admin allowed.
        let ok = server
            .client
            .get(server.api_url(path))
            .bearer_auth(&admin)
            .send()
            .await
            .expect("admin GET");
        assert_eq!(ok.status().as_u16(), 200, "admin GET {path} allowed");
        // User denied.
        let denied = server
            .client
            .get(server.api_url(path))
            .bearer_auth(&user)
            .send()
            .await
            .expect("user GET");
        assert_eq!(denied.status().as_u16(), 403, "GET {path} denied without infra perm");
    }

    // PUT + test denied for the user on both surfaces.
    for (put_path, test_path, body) in [
        (
            "/admin/infra/object-store",
            "/admin/infra/object-store/test",
            json!({ "bucket": "nope" }),
        ),
        (
            "/admin/infra/compute",
            "/admin/infra/compute/test",
            json!({ "namespace": "nope" }),
        ),
    ] {
        let put = server
            .client
            .put(server.api_url(put_path))
            .bearer_auth(&user)
            .json(&body)
            .send()
            .await
            .expect("user PUT");
        assert_eq!(put.status().as_u16(), 403, "PUT {put_path} denied");
        let test = server
            .client
            .post(server.api_url(test_path))
            .bearer_auth(&user)
            .json(&json!({}))
            .send()
            .await
            .expect("user POST test");
        assert_eq!(test.status().as_u16(), 403, "POST {test_path} denied");
    }
}
