//! TEST-27 — ownership transfer: create/accept (owner swaps, old owner loses it,
//! shares persist + re-point to the new owner), decline, the admin
//! transfer_enabled=false → 409 gate, and non-owner → 403.

use serde_json::{json, Value};

use super::{create_project, create_user, login, setup_admin};
use crate::common::TestServer;

async fn transfer(server: &TestServer, owner: &str, sid: &str, email: &str) -> reqwest::Response {
    server
        .client
        .post(server.api_url(&format!("/projects/{sid}/transfer")))
        .bearer_auth(owner)
        .json(&json!({ "email": email }))
        .send()
        .await
        .expect("transfer")
}

#[tokio::test]
async fn transfer_accept_swaps_ownership_and_repoints_shares() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let old_id = create_user(&server, &admin, "old", "old@x.test").await;
    let old = login(&server, "old").await;
    let new_id = create_user(&server, &admin, "new", "new@x.test").await;
    let new = login(&server, "new").await;
    create_user(&server, &admin, "colleague", "colleague@x.test").await;
    let colleague = login(&server, "colleague").await;

    let project = create_project(&server, &old, "To hand off").await;
    let sid = project["id"].as_str().unwrap().to_string();

    // The old owner shares with a colleague first (so we can prove shares survive
    // + re-point to the new owner).
    let share_id = server.client.post(server.api_url(&format!("/projects/{sid}/shares"))).bearer_auth(&old)
        .json(&json!({"email":"colleague@x.test","permission_level":"viewer"})).send().await.unwrap()
        .json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    server.client.post(server.api_url(&format!("/project-shares/{share_id}/accept"))).bearer_auth(&colleague).send().await.unwrap();

    // Transfer old → new.
    let t = transfer(&server, &old, &sid, "new@x.test").await;
    assert_eq!(t.status().as_u16(), 201);
    let transfer_id = t.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // New accepts → ownership swaps.
    let acc = server.client.post(server.api_url(&format!("/project-transfers/{transfer_id}/accept"))).bearer_auth(&new).send().await.unwrap();
    assert_eq!(acc.status().as_u16(), 200);

    // Old owner no longer sees it (404); new owner does, as owner.
    let old_get = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&old).send().await.unwrap();
    assert_eq!(old_get.status().as_u16(), 404, "old owner lost the project");
    let new_get: Value = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&new).send().await.unwrap().json().await.unwrap();
    assert_eq!(new_get["owner_id"], json!(new_id));
    assert_eq!(new_get["effective_permission"], json!("owner"));

    // The colleague's share PERSISTED, and the NEW owner can list + revoke it
    // (proves project_shares.owner_id was re-pointed to the new owner).
    let panel: Value = server.client.get(server.api_url(&format!("/projects/{sid}/shares"))).bearer_auth(&new).send().await.unwrap().json().await.unwrap();
    assert_eq!(panel["shares"].as_array().unwrap().len(), 1, "share survived transfer");
    let rev = server.client.delete(server.api_url(&format!("/project-shares/{share_id}"))).bearer_auth(&new).send().await.unwrap();
    assert_eq!(rev.status().as_u16(), 204, "new owner can revoke an inherited share");

    let _ = old_id;
}

#[tokio::test]
async fn transfer_decline_leaves_ownership() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let old_id = create_user(&server, &admin, "o2", "o2@x.test").await;
    let old = login(&server, "o2").await;
    create_user(&server, &admin, "n2", "n2@x.test").await;
    let new = login(&server, "n2").await;
    let project = create_project(&server, &old, "Keep").await;
    let sid = project["id"].as_str().unwrap().to_string();
    let tid = transfer(&server, &old, &sid, "n2@x.test").await.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    let dec = server.client.post(server.api_url(&format!("/project-transfers/{tid}/decline"))).bearer_auth(&new).send().await.unwrap();
    assert_eq!(dec.status().as_u16(), 200);
    let still: Value = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&old).send().await.unwrap().json().await.unwrap();
    assert_eq!(still["owner_id"], json!(old_id), "declined transfer keeps ownership");
}

#[tokio::test]
async fn transfer_disabled_returns_409_and_non_owner_403() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "o3", "o3@x.test").await;
    let owner = login(&server, "o3").await;
    create_user(&server, &admin, "n3", "n3@x.test").await;
    create_user(&server, &admin, "x3", "x3@x.test").await;
    let outsider = login(&server, "x3").await;
    let project = create_project(&server, &owner, "Gated").await;
    let sid = project["id"].as_str().unwrap().to_string();

    // A non-owner transfer of a project they can't see → 404 (before the settings
    // check — so the admin-gated flag isn't leaked).
    let byother = transfer(&server, &outsider, &sid, "n3@x.test").await;
    assert_eq!(byother.status().as_u16(), 404);

    // Admin disables transfers deployment-wide.
    let put = server.client.put(server.api_url("/project/settings")).bearer_auth(&admin).json(&json!({"transfer_enabled": false})).send().await.unwrap();
    assert_eq!(put.status().as_u16(), 200);

    // Owner's transfer now → 409.
    let disabled = transfer(&server, &owner, &sid, "n3@x.test").await;
    assert_eq!(disabled.status().as_u16(), 409, "transfer disabled → 409");
}
