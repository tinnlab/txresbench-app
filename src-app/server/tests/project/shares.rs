//! TEST-23/24/25 — email sharing (resource ACL): create/accept/decline/revoke,
//! the project appearing in the recipient's list with the effective permission,
//! and per-role enforcement (viewer read-only; editor edit+attach; owner-only
//! share/transfer/delete).

use serde_json::{json, Value};

use super::{create_dataset, create_project, create_user, login, setup_admin};
use crate::common::TestServer;

/// Owner shares `sid` with `email` at `level` → the created ProjectShare row.
async fn share(server: &TestServer, owner: &str, sid: &str, email: &str, level: &str) -> reqwest::Response {
    server
        .client
        .post(server.api_url(&format!("/projects/{sid}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "email": email, "permission_level": level }))
        .send()
        .await
        .expect("share")
}

#[tokio::test]
async fn create_share_guards() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "owner", "owner@x.test").await;
    let owner = login(&server, "owner").await;
    create_user(&server, &admin, "rcpt", "rcpt@x.test").await;
    create_user(&server, &admin, "outsider", "outsider@x.test").await;
    let outsider = login(&server, "outsider").await;

    let project = create_project(&server, &owner, "Shared project").await;
    let sid = project["id"].as_str().unwrap();

    // Unknown email → 422.
    let unknown = share(&server, &owner, sid, "nobody@x.test", "viewer").await;
    assert_eq!(unknown.status().as_u16(), 422);

    // Self-share → 400.
    let selfshare = share(&server, &owner, sid, "owner@x.test", "viewer").await;
    assert_eq!(selfshare.status().as_u16(), 400);

    // Non-owner (can't even see it) → 404.
    let byother = share(&server, &outsider, sid, "rcpt@x.test", "viewer").await;
    assert_eq!(byother.status().as_u16(), 404);

    // Valid → 201 pending.
    let ok = share(&server, &owner, sid, "rcpt@x.test", "editor").await;
    assert_eq!(ok.status().as_u16(), 201);
    assert_eq!(ok.json::<Value>().await.unwrap()["status"], json!("pending"));

    // Duplicate active share → 409.
    let dup = share(&server, &owner, sid, "rcpt@x.test", "viewer").await;
    assert_eq!(dup.status().as_u16(), 409);
}

#[tokio::test]
async fn accept_decline_and_effective_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "own2", "own2@x.test").await;
    let owner = login(&server, "own2").await;
    create_user(&server, &admin, "view", "view@x.test").await;
    let viewer = login(&server, "view").await;

    let project = create_project(&server, &owner, "For sharing").await;
    let sid = project["id"].as_str().unwrap().to_string();

    let share_resp = share(&server, &owner, &sid, "view@x.test", "viewer").await;
    let share_id = share_resp.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // Before accept: NOT in the viewer's list.
    let before: Value = server.client.get(server.api_url("/projects")).bearer_auth(&viewer).send().await.unwrap().json().await.unwrap();
    assert_eq!(before["total"], json!(0), "a pending share is not auto-added");

    // Owner sees the pending share in the panel.
    let panel: Value = server.client.get(server.api_url(&format!("/projects/{sid}/shares"))).bearer_auth(&owner).send().await.unwrap().json().await.unwrap();
    assert_eq!(panel["shares"][0]["recipient_username"], json!("view"));

    // Accept → now in the viewer's list, annotated viewer.
    let acc = server.client.post(server.api_url(&format!("/project-shares/{share_id}/accept"))).bearer_auth(&viewer).send().await.unwrap();
    assert_eq!(acc.status().as_u16(), 200);
    let after: Value = server.client.get(server.api_url("/projects")).bearer_auth(&viewer).send().await.unwrap().json().await.unwrap();
    assert_eq!(after["total"], json!(1));
    assert_eq!(after["projects"][0]["effective_permission"], json!("viewer"));

    // A viewer is READ-ONLY: update → 403.
    let upd = server.client.post(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&viewer).json(&json!({"name":"nope"})).send().await.unwrap();
    assert_eq!(upd.status().as_u16(), 403, "viewer cannot edit");

    // Owner revokes → the viewer loses it.
    let rev = server.client.delete(server.api_url(&format!("/project-shares/{share_id}"))).bearer_auth(&owner).send().await.unwrap();
    assert_eq!(rev.status().as_u16(), 204);
    let gone: Value = server.client.get(server.api_url("/projects")).bearer_auth(&viewer).send().await.unwrap().json().await.unwrap();
    assert_eq!(gone["total"], json!(0), "revoked share removes the project");
}

#[tokio::test]
async fn editor_can_edit_and_attach_but_not_share() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "own3", "own3@x.test").await;
    let owner = login(&server, "own3").await;
    create_user(&server, &admin, "edit", "edit@x.test").await;
    let editor = login(&server, "edit").await;
    create_user(&server, &admin, "third", "third@x.test").await;

    let project = create_project(&server, &owner, "Editable").await;
    let sid = project["id"].as_str().unwrap().to_string();
    let share_id = share(&server, &owner, &sid, "edit@x.test", "editor").await.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    server.client.post(server.api_url(&format!("/project-shares/{share_id}/accept"))).bearer_auth(&editor).send().await.unwrap();

    // Editor CAN update metadata.
    let upd = server.client.post(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&editor).json(&json!({"name":"Edited by editor"})).send().await.unwrap();
    assert_eq!(upd.status().as_u16(), 200, "editor can update");

    // Editor CAN attach a dataset.
    let ds = create_dataset(&server, &editor, "editor-ds").await;
    let att = server.client.post(server.api_url(&format!("/projects/{sid}/datasets/{ds}"))).bearer_auth(&editor).send().await.unwrap();
    assert_eq!(att.status().as_u16(), 200, "editor can attach");

    // Editor CANNOT share (owner-only) → 403.
    let esh = share(&server, &editor, &sid, "third@x.test", "viewer").await;
    assert_eq!(esh.status().as_u16(), 403, "editor cannot share");

    // Editor CANNOT delete (owner-only) → 403.
    let edel = server.client.delete(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&editor).send().await.unwrap();
    assert_eq!(edel.status().as_u16(), 403, "editor cannot delete");
}

#[tokio::test]
async fn revoke_by_non_owner_is_404_not_403() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "own4", "own4@x.test").await;
    let owner = login(&server, "own4").await;
    create_user(&server, &admin, "rcp4", "rcp4@x.test").await;
    create_user(&server, &admin, "attacker", "attacker@x.test").await;
    let attacker = login(&server, "attacker").await;

    let project = create_project(&server, &owner, "S").await;
    let sid = project["id"].as_str().unwrap();
    let share_id = share(&server, &owner, sid, "rcp4@x.test", "viewer").await.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // A non-owner revoking a REAL share id → 404 (no existence oracle).
    let r = server.client.delete(server.api_url(&format!("/project-shares/{share_id}"))).bearer_auth(&attacker).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 404, "non-owner revoke of a real share is 404, not 403");
}
