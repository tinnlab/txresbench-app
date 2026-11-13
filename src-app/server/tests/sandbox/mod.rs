//! Sandbox integration tests over the SDK harness (real spawned server +
//! SQLite). strip-single-cell ITEM-3: the analysis-rootfs/env-image/processor/
//! in-pod suites went with their modules; the kept tier is the txr method-env
//! stack + settings + the dev-registry acceptance.

use serde_json::{json, Value};

use crate::common::TestServer;

mod dev_registry_test;
mod method_env_layer_test;
mod method_stack_test;
mod settings_test;

/// First-run setup → returns the owner's access token.
async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "sbxadmin",
            "email": "sbx@txresbench.test",
            "password": "sbxPassw0rd!",
            "display_name": "Sandbox Admin"
        }))
        .send()
        .await
        .expect("setup/admin request");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    let body: Value = resp.json().await.expect("setup/admin json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("setup response carries an access token")
        .to_string()
}

/// Create a restricted (no-permission) user via the admin API and log in as
/// them → their access token.
async fn restricted_user_token(server: &TestServer, admin: &str) -> String {
    let create = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": "sbxuser",
            "email": "sbxuser@txresbench.test",
            "password": "sbxUserP0!",
            "permissions": []
        }))
        .send()
        .await
        .expect("create user request");
    let s = create.status().as_u16();
    assert!(s == 201 || s == 200, "create restricted user -> {s}");

    let login = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": "sbxuser", "password": "sbxUserP0!" }))
        .send()
        .await
        .expect("login request");
    assert_eq!(login.status().as_u16(), 200, "restricted user can log in");
    let body: Value = login.json().await.expect("login json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("login carries a token")
        .to_string()
}
