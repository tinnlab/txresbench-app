//! TEST-4 [ITEM-3] — M:N project attach: one dataset in TWO projects (composite PK),
//! detach, the `PROJECT_MAX_DATASETS=100` cap → 422, attach gated by
//! `ProjectScope.require_can_edit` (a viewer → 403) AND by dataset visibility (an
//! editor attaching a dataset they can't see → 403).

use serde_json::{json, Value};

use super::{create_dataset, create_user, login, setup_admin};
use crate::common::TestServer;

async fn create_project(server: &TestServer, token: &str, name: &str) -> String {
    let r = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 201);
    r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn project_total(server: &TestServer, token: &str, sid: &str) -> i64 {
    let list: Value = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/datasets")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    list["total"].as_i64().unwrap()
}

/// Owner shares `sid` with `email` at `level`; the recipient accepts.
async fn share_and_accept(
    server: &TestServer,
    owner: &str,
    sid: &str,
    email: &str,
    level: &str,
    recipient: &str,
) {
    let share = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "email": email, "permission_level": level }))
        .send()
        .await
        .unwrap();
    assert_eq!(share.status().as_u16(), 201, "share {sid} → {email}");
    let share_id = share.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let acc = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(recipient)
        .send()
        .await
        .unwrap();
    assert_eq!(acc.status().as_u16(), 200, "accept share");
}

#[tokio::test]
async fn one_dataset_in_two_projects_then_detach() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "mo", "mo@x.test").await;
    let mo = login(&server, "mo").await;

    let s1 = create_project(&server, &mo, "S1").await;
    let s2 = create_project(&server, &mo, "S2").await;
    let ds = create_dataset(&server, &mo, "one-ds").await;

    for sid in [&s1, &s2] {
        let att = server
            .client
            .post(server.api_url(&format!("/projects/{sid}/datasets/{ds}")))
            .bearer_auth(&mo)
            .send()
            .await
            .unwrap();
        assert_eq!(att.status().as_u16(), 200, "attach → {sid}");
    }
    // The SAME dataset is now in BOTH projects (M:N — composite PK).
    assert_eq!(project_total(&server, &mo, &s1).await, 1);
    assert_eq!(project_total(&server, &mo, &s2).await, 1);

    // Detach from S1 → still in S2.
    let de = server
        .client
        .delete(server.api_url(&format!("/projects/{s1}/datasets/{ds}")))
        .bearer_auth(&mo)
        .send()
        .await
        .unwrap();
    assert_eq!(de.status().as_u16(), 200);
    assert_eq!(
        project_total(&server, &mo, &s1).await,
        0,
        "detached from S1"
    );
    assert_eq!(project_total(&server, &mo, &s2).await, 1, "still in S2");
}

#[tokio::test]
async fn attach_cap_returns_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "cap", "cap@x.test").await;
    let cap = login(&server, "cap").await;
    let sid = create_project(&server, &cap, "Capped").await;

    for i in 0..100 {
        let ds = create_dataset(&server, &cap, &format!("d{i}")).await;
        let r = server
            .client
            .post(server.api_url(&format!("/projects/{sid}/datasets/{ds}")))
            .bearer_auth(&cap)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 200, "attach {i}");
    }
    let overflow = create_dataset(&server, &cap, "overflow").await;
    let r = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{overflow}")))
        .bearer_auth(&cap)
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.status().as_u16(),
        422,
        "the 101st dataset hits the cap → 422"
    );
}

#[tokio::test]
async fn viewer_and_invisible_dataset_are_403() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "own", "own@x.test").await;
    let own = login(&server, "own").await;
    create_user(&server, &admin, "ved", "ved@x.test").await;
    let ved = login(&server, "ved").await;
    create_user(&server, &admin, "edr", "edr@x.test").await;
    let edr = login(&server, "edr").await;

    let sid = create_project(&server, &own, "Owned").await;

    // --- require_can_edit 403: a VIEWER of the project cannot attach. ---
    share_and_accept(&server, &own, &sid, "ved@x.test", "viewer", &ved).await;
    let ved_ds = create_dataset(&server, &ved, "ved-ds").await; // ved owns it (visible to ved)
    let viewer_attach = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{ved_ds}")))
        .bearer_auth(&ved)
        .send()
        .await
        .unwrap();
    assert_eq!(
        viewer_attach.status().as_u16(),
        403,
        "a viewer cannot attach (require_can_edit)"
    );

    // --- dataset-visibility 403: an EDITOR cannot attach a dataset they can't see. ---
    share_and_accept(&server, &own, &sid, "edr@x.test", "editor", &edr).await;
    // The owner has a PRIVATE dataset the editor cannot see.
    let owner_private = create_dataset(&server, &own, "owner-private").await;
    let editor_attach = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{owner_private}")))
        .bearer_auth(&edr)
        .send()
        .await
        .unwrap();
    assert_eq!(
        editor_attach.status().as_u16(),
        403,
        "editor cannot attach a dataset they can't see"
    );

    // Sanity: the editor CAN attach their OWN (visible) dataset.
    let editor_ds = create_dataset(&server, &edr, "editor-ds").await;
    let ok = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{editor_ds}")))
        .bearer_auth(&edr)
        .send()
        .await
        .unwrap();
    assert_eq!(
        ok.status().as_u16(),
        200,
        "editor attaches their own visible dataset"
    );
}
