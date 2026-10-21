//! TEST-3 [ITEM-2] — dataset sharing: share/unshare via `dataset_shares`
//! (user + group principals); visibility = owner ∪ sharees (a non-sharee 404s);
//! `SyncEntity::Dataset` emits to the owner+sharees audience over the real SSE
//! stream.

use std::time::Duration;

use serde_json::{json, Value};

use super::{create_user, login, read_until, setup_admin};
use crate::common::TestServer;

async fn create_dataset(server: &TestServer, token: &str, name: &str) -> String {
    let r = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 201);
    r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn user_share_visibility_and_sync() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ann", "ann@x.test").await;
    let ann = login(&server, "ann").await;
    let bob_id = create_user(&server, &admin, "bob", "bob@x.test").await;
    let bob = login(&server, "bob").await;

    let ds = create_dataset(&server, &ann, "shared-ds").await;

    // Before any share: bob can't see it (list-shared empty, get → 404).
    let shared0: Value = server
        .client
        .get(server.api_url("/datasets/shared"))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        shared0["items"].as_array().unwrap().is_empty(),
        "not shared yet"
    );
    let get0 = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(get0.status().as_u16(), 404, "non-sharee 404s");

    // Open bob's sync stream (drain the handshake) so we observe the share emit.
    let mut bob_stream = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&bob)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert!(read_until(&mut bob_stream, "connected", Duration::from_secs(5)).await);

    // ann shares the dataset with bob (view).
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&ann)
        .json(&json!({ "principal_type": "user", "principal_id": bob_id, "role": "view" }))
        .send()
        .await
        .unwrap();
    assert_eq!(share.status().as_u16(), 201, "share created");
    let share_id = share.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();

    // bob's stream receives a `dataset` sync frame (owner+sharees audience).
    assert!(
        read_until(&mut bob_stream, "\"dataset\"", Duration::from_secs(5)).await,
        "sharee receives the dataset sync frame"
    );

    // bob now sees it (list-shared + get read-only).
    let shared1: Value = server
        .client
        .get(server.api_url("/datasets/shared"))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        shared1["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == json!(ds)),
        "in bob's shared list"
    );
    let get1 = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(get1.status().as_u16(), 200, "sharee can read");

    // Only the owner may manage the share list (bob → 404).
    let bob_shares = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(
        bob_shares.status().as_u16(),
        404,
        "sharee is not the share manager"
    );

    // Unshare → bob loses visibility.
    let un = server
        .client
        .delete(server.api_url(&format!("/datasets/{ds}/shares/{share_id}")))
        .bearer_auth(&ann)
        .send()
        .await
        .unwrap();
    assert_eq!(un.status().as_u16(), 204, "DELETE share → 204 No Content");
    let get2 = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(get2.status().as_u16(), 404, "unshared → 404 again");
}

#[tokio::test]
async fn group_share_visibility() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "gowner", "gowner@x.test").await;
    let owner = login(&server, "gowner").await;
    let carol_id = create_user(&server, &admin, "carol", "carol@x.test").await;
    create_user(&server, &admin, "dave", "dave@x.test").await;
    let dave = login(&server, "dave").await;

    // A dedicated group; carol is a member (assigned BEFORE she logs in so her
    // token's resolved groups include it), dave is not.
    let group = server
        .client
        .post(server.api_url("/groups"))
        .bearer_auth(&admin)
        .json(&json!({ "name": "lab-A", "description": "", "permissions": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(group.status().as_u16(), 201);
    let group_id = group.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let assign = server
        .client
        .post(server.api_url("/groups/assign"))
        .bearer_auth(&admin)
        .json(&json!({ "user_id": carol_id, "group_id": group_id }))
        .send()
        .await
        .unwrap();
    assert!(assign.status().is_success(), "assign carol → lab-A");
    let carol = login(&server, "carol").await;

    let ds = create_dataset(&server, &owner, "group-shared").await;

    // Share with the group.
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&owner)
        .json(&json!({ "principal_type": "group", "principal_id": group_id, "role": "edit" }))
        .send()
        .await
        .unwrap();
    assert_eq!(share.status().as_u16(), 201);

    // carol (in the group) sees it; dave (not in the group) does not.
    let carol_get = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap();
    assert_eq!(
        carol_get.status().as_u16(),
        200,
        "group member sees the shared dataset"
    );
    let carol_shared: Value = server
        .client
        .get(server.api_url("/datasets/shared"))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(carol_shared["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["id"] == json!(ds)));

    let dave_get = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&dave)
        .send()
        .await
        .unwrap();
    assert_eq!(
        dave_get.status().as_u16(),
        404,
        "a non-member does not see it"
    );
}
