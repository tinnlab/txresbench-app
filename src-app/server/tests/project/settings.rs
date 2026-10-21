//! TEST-28 — project settings: GET readable by any projects::use holder, PUT
//! admin-only (A9 deny), default transfer_enabled=true, and the value persists.

use serde_json::{json, Value};

use super::{create_user, login, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn settings_read_open_write_admin_only() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "reader", "reader@x.test").await;
    let reader = login(&server, "reader").await;

    // Default is transfer_enabled = true, readable by a normal projects user.
    let get = server.client.get(server.api_url("/project/settings")).bearer_auth(&reader).send().await.unwrap();
    assert_eq!(get.status().as_u16(), 200, "any projects::use holder can read settings");
    assert_eq!(get.json::<Value>().await.unwrap()["transfer_enabled"], json!(true));

    // A non-admin PUT → 403 (project::settings::manage, held only via '*').
    let deny = server.client.put(server.api_url("/project/settings")).bearer_auth(&reader).json(&json!({"transfer_enabled": false})).send().await.unwrap();
    assert_eq!(deny.status().as_u16(), 403, "non-admin cannot manage settings");

    // Admin PUT persists + read-back reflects it.
    let put = server.client.put(server.api_url("/project/settings")).bearer_auth(&admin).json(&json!({"transfer_enabled": false})).send().await.unwrap();
    assert_eq!(put.status().as_u16(), 200);
    let after = server.client.get(server.api_url("/project/settings")).bearer_auth(&reader).send().await.unwrap();
    assert_eq!(after.json::<Value>().await.unwrap()["transfer_enabled"], json!(false), "read-at-use reflects the update");

    // Unauthenticated → 401.
    let un = server.client.get(server.api_url("/project/settings")).send().await.unwrap();
    assert_eq!(un.status().as_u16(), 401);
}
