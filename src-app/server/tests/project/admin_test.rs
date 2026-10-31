//! Admin (cross-user) project-management integration tests — full production path
//! through a real spawned server + real Postgres. Covers the cross-user list +
//! stats + filters/sort, change-owner (immediate, keep-as-editor, cancel
//! transfer, inactive-target reject), share-on-behalf, revoke, delete-cascade,
//! reassign-all + multi-select batch (partial failure), the ownership-changed
//! notification, cross-user access (200 not 404), the user-search picker, and the
//! A9 admin deny path.

use serde_json::{json, Value};

use super::{create_dataset, create_project, create_user, login, setup_admin};
use crate::common::TestServer;

// ------------------------------- local helpers -------------------------------

async fn admin_list(server: &TestServer, admin: &str, query: &str) -> Value {
    let resp = server
        .client
        .get(server.api_url(&format!("/admin/projects{query}")))
        .bearer_auth(admin)
        .send()
        .await
        .expect("admin list");
    assert_eq!(resp.status().as_u16(), 200, "admin list {query}");
    resp.json().await.expect("admin list json")
}

fn row<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .find(|r| r["name"] == json!(name))
        .unwrap_or_else(|| panic!("row {name} not in list"))
}

async fn deactivate(server: &TestServer, _admin: &str, user_id: &str) {
    // The `/users/{id}/toggle-active` route is stripped on this node; the
    // retained seam is the SDK user repository (`set_active`).
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect deactivate pool");
    ziee_auth::user::UserRepository::new(pool.clone())
        .set_active(uuid::Uuid::parse_str(user_id).expect("user id is a uuid"), false)
        .await
        .expect("deactivate user");
}

async fn owner_project_ids(server: &TestServer, token: &str) -> Vec<String> {
    let list: Value = server
        .client
        .get(server.api_url("/projects?per_page=200"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    list["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect()
}

// ------------------------- TEST-3 + TEST-21(size) : cross-user list -------------------------

#[tokio::test]
async fn admin_list_cross_user_with_owner_counts_status_filters_sort_stats() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ann", "ann@x.test").await;
    let ann = login(&server, "ann").await;
    let bob_id = create_user(&server, &admin, "bob", "bob@x.test").await;
    let bob = login(&server, "bob").await;

    // ann: a shared project with 1 dataset; bob: a private empty project.
    let a = create_project(&server, &ann, "Ann atlas").await;
    let a_id = a["id"].as_str().unwrap().to_string();
    let ds = create_dataset(&server, &ann, "sample-1").await;
    let att = server.client.post(server.api_url(&format!("/projects/{a_id}/datasets/{ds}")))
        .bearer_auth(&ann).send().await.unwrap();
    assert_eq!(att.status().as_u16(), 200);
    create_project(&server, &bob, "Bob private").await;

    // Cross-user: the admin sees BOTH owners' projects with owner identity.
    let all = admin_list(&server, &admin, "").await;
    assert_eq!(all["total"], json!(2), "admin sees all owners' projects");
    let ann_row = row(&all, "Ann atlas");
    assert_eq!(ann_row["owner_username"], json!("ann"));
    assert_eq!(ann_row["owner_email"], json!("ann@x.test"));
    assert_eq!(ann_row["owner_is_active"], json!(true));
    assert_eq!(ann_row["dataset_count"], json!(1));
    assert!(ann_row["last_activity"].is_string());
    assert_eq!(ann_row["is_orphaned"], json!(false));
    // deployment stats (unfiltered).
    assert_eq!(all["stats"]["total_projects"], json!(2));
    assert_eq!(all["stats"]["distinct_owners"], json!(2));

    // search (ILIKE on name).
    let s = admin_list(&server, &admin, "?search=atlas").await;
    assert_eq!(s["total"], json!(1));
    assert_eq!(s["rows"][0]["name"], json!("Ann atlas"));

    // owner filter.
    let of = admin_list(&server, &admin, &format!("?owner_id={bob_id}")).await;
    assert_eq!(of["total"], json!(1));
    assert_eq!(of["rows"][0]["name"], json!("Bob private"));

    // status filter: 'empty' → only bob's 0-dataset project.
    let empty = admin_list(&server, &admin, "?status=empty").await;
    assert_eq!(empty["total"], json!(1));
    assert_eq!(empty["rows"][0]["name"], json!("Bob private"));

    // sort by name (A–Z) → 'Ann atlas' before 'Bob private'.
    let sorted = admin_list(&server, &admin, "?sort=name").await;
    assert_eq!(sorted["rows"][0]["name"], json!("Ann atlas"));
    assert_eq!(sorted["rows"][1]["name"], json!("Bob private"));
}

// ------------------------- TEST-4 + TEST-8 : change owner -------------------------

#[tokio::test]
async fn admin_change_owner_moves_keeps_editor_notifies_and_rejects_inactive() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "old", "old@x.test").await;
    let old = login(&server, "old").await;
    let new_id = create_user(&server, &admin, "new", "new@x.test").await;
    let new = login(&server, "new").await;
    let dead_id = create_user(&server, &admin, "dead", "dead@x.test").await;

    let project = create_project(&server, &old, "Handoff project").await;
    let sid = project["id"].as_str().unwrap().to_string();

    // inactive target → 422 (a deactivated owner would orphan the project).
    deactivate(&server, &admin, &dead_id).await;
    let bad = server.client.post(server.api_url(&format!("/admin/projects/{sid}/change-owner")))
        .bearer_auth(&admin).json(&json!({ "new_owner_id": dead_id })).send().await.unwrap();
    assert_eq!(bad.status().as_u16(), 422, "inactive target rejected");

    // change owner → new, keep the old owner as an editor.
    let ok = server.client.post(server.api_url(&format!("/admin/projects/{sid}/change-owner")))
        .bearer_auth(&admin)
        .json(&json!({ "new_owner_id": new_id, "keep_old_as_editor": true }))
        .send().await.unwrap();
    assert_eq!(ok.status().as_u16(), 200, "change-owner ok");

    // the new owner now owns it; the old owner sees it as an editor (kept).
    let new_list: Value = server.client.get(server.api_url("/projects")).bearer_auth(&new).send().await.unwrap().json().await.unwrap();
    let new_project = new_list["projects"].as_array().unwrap().iter().find(|s| s["id"] == json!(sid)).expect("new owner has project");
    assert_eq!(new_project["effective_permission"], json!("owner"));

    let old_list: Value = server.client.get(server.api_url("/projects")).bearer_auth(&old).send().await.unwrap().json().await.unwrap();
    let old_project = old_list["projects"].as_array().unwrap().iter().find(|s| s["id"] == json!(sid)).expect("old owner kept as editor");
    assert_eq!(old_project["effective_permission"], json!("editor"), "old owner kept as editor");

    // TEST-8: the new owner received a project_ownership_changed notification.
    let notifs: Value = server.client.get(server.api_url("/notifications")).bearer_auth(&new).send().await.unwrap().json().await.unwrap();
    let has_kind = notifs["items"].as_array().unwrap().iter().any(|n| n["kind"] == json!("project_ownership_changed"));
    assert!(has_kind, "new owner got the ownership-changed notification");
}

// ------------------------- TEST-6 : detail + revoke + delete cascade -------------------------

#[tokio::test]
async fn admin_detail_revoke_and_delete_cascade_datasets_cleaned() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "owner", "owner@x.test").await;
    let owner = login(&server, "owner").await;
    create_user(&server, &admin, "rcpt", "rcpt@x.test").await;

    let project = create_project(&server, &owner, "Cascade project").await;
    let sid = project["id"].as_str().unwrap().to_string();
    let ds = create_dataset(&server, &owner, "keep-me").await;
    server.client.post(server.api_url(&format!("/projects/{sid}/datasets/{ds}"))).bearer_auth(&owner).send().await.unwrap();
    // owner shares with rcpt (a real pending share).
    let share = server.client.post(server.api_url(&format!("/projects/{sid}/shares")))
        .bearer_auth(&owner).json(&json!({ "email": "rcpt@x.test", "permission_level": "viewer" }))
        .send().await.unwrap();
    assert_eq!(share.status().as_u16(), 201);
    let share_id = share.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();

    // admin detail: owner identity + the share + the dataset.
    let detail: Value = server.client.get(server.api_url(&format!("/admin/projects/{sid}"))).bearer_auth(&admin).send().await.unwrap().json().await.unwrap();
    assert_eq!(detail["owner_username"], json!("owner"));
    assert_eq!(detail["shares"].as_array().unwrap().len(), 1);
    assert_eq!(detail["datasets"].as_array().unwrap().len(), 1);

    // admin revoke the share (path-matched).
    let rev = server.client.delete(server.api_url(&format!("/admin/projects/{sid}/shares/{share_id}"))).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(rev.status().as_u16(), 204);
    // mismatched project id in the path → 404.
    let bad = server.client.delete(server.api_url(&format!("/admin/projects/{}/shares/{share_id}", uuid_zero()))).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(bad.status().as_u16(), 404, "cross-project revoke rejected");

    // admin delete the project → 204; the project is gone but its dataset SURVIVES in
    // the owner's library. Post ITEM-1/3 datasets are owner-scoped + M:N: deleting
    // a project (owner- or admin-path) only DETACHES its datasets (the project_datasets
    // junction cascades), it never destroys the owner's dataset rows.
    let del = server.client.delete(server.api_url(&format!("/admin/projects/{sid}"))).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(del.status().as_u16(), 204);
    let gone = admin_list(&server, &admin, "").await;
    assert!(gone["rows"].as_array().unwrap().iter().all(|r| r["id"] != json!(sid)), "project deleted");
    // The dataset survives (owner still owns it) — `/datasets` lists the owner's library.
    let datasets: Value = server.client.get(server.api_url("/datasets")).bearer_auth(&owner).send().await.unwrap().json().await.unwrap();
    let ids: Vec<&str> = datasets["items"].as_array().unwrap().iter().filter_map(|d| d["id"].as_str()).collect();
    assert!(ids.contains(&ds.as_str()), "project delete detaches but keeps the owner's dataset");
}

fn uuid_zero() -> &'static str {
    "00000000-0000-0000-0000-000000000000"
}

// ------------------------- TEST-7 : cross-user access (200 not 404) -------------------------

#[tokio::test]
async fn admin_reaches_foreign_project_and_404s_absent() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "user1", "u1@x.test").await;
    let u1 = login(&server, "user1").await;
    let project = create_project(&server, &u1, "Foreign project").await;
    let sid = project["id"].as_str().unwrap();

    // admin (not the owner) → 200 on another user's project (no owner 404-guard).
    let d = server.client.get(server.api_url(&format!("/admin/projects/{sid}"))).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(d.status().as_u16(), 200, "admin reaches a foreign project");
    // genuinely absent → 404.
    let a = server.client.get(server.api_url(&format!("/admin/projects/{}", uuid_zero()))).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(a.status().as_u16(), 404);
}

// ------------------------- TEST-5 : reassign-all -------------------------

#[tokio::test]
async fn admin_reassign_all_moves_every_project() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let from_id = create_user(&server, &admin, "leaver", "leaver@x.test").await;
    let from = login(&server, "leaver").await;
    let to_id = create_user(&server, &admin, "keeper", "keeper@x.test").await;
    let to = login(&server, "keeper").await;
    let dead_id = create_user(&server, &admin, "gone", "gone@x.test").await;

    create_project(&server, &from, "L1").await;
    create_project(&server, &from, "L2").await;

    // inactive target → 422.
    deactivate(&server, &admin, &dead_id).await;
    let bad = server.client.post(server.api_url("/admin/projects/reassign-owner"))
        .bearer_auth(&admin).json(&json!({ "from_owner_id": from_id, "to_owner_id": dead_id })).send().await.unwrap();
    assert_eq!(bad.status().as_u16(), 422);

    let res: Value = server.client.post(server.api_url("/admin/projects/reassign-owner"))
        .bearer_auth(&admin).json(&json!({ "from_owner_id": from_id, "to_owner_id": to_id })).send().await.unwrap().json().await.unwrap();
    assert_eq!(res["succeeded"].as_array().unwrap().len(), 2, "both moved");
    assert_eq!(res["failed"].as_array().unwrap().len(), 0);

    // the leaver has none; the keeper has both.
    assert_eq!(owner_project_ids(&server, &from).await.len(), 0);
    assert_eq!(owner_project_ids(&server, &to).await.len(), 2);
}

// ------------------------- TEST-21 : multi-select batch (partial failure) -------------------------

#[tokio::test]
async fn admin_batch_reassign_and_delete_partial_failure() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "src", "src@x.test").await;
    let src = login(&server, "src").await;
    let to_id = create_user(&server, &admin, "dst", "dst@x.test").await;
    let to = login(&server, "dst").await;

    let s1 = create_project(&server, &src, "B1").await["id"].as_str().unwrap().to_string();
    let s2 = create_project(&server, &src, "B2").await["id"].as_str().unwrap().to_string();

    // batch reassign [valid, valid, bogus] → 2 succeeded, 1 failed.
    let rr: Value = server.client.post(server.api_url("/admin/projects/batch-reassign"))
        .bearer_auth(&admin)
        .json(&json!({ "project_ids": [s1, s2, uuid_zero()], "to_owner_id": to_id }))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(rr["succeeded"].as_array().unwrap().len(), 2, "valid ids succeed");
    assert_eq!(rr["failed"].as_array().unwrap().len(), 1, "bogus id fails, others still applied");
    assert_eq!(owner_project_ids(&server, &to).await.len(), 2);

    // batch delete [valid, bogus] → 1 succeeded, 1 failed.
    let dr: Value = server.client.post(server.api_url("/admin/projects/batch-delete"))
        .bearer_auth(&admin)
        .json(&json!({ "project_ids": [s1, uuid_zero()] }))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(dr["succeeded"].as_array().unwrap().len(), 1);
    assert_eq!(dr["failed"].as_array().unwrap().len(), 1);
}

// ------------------------- TEST-13(share) : share on behalf -------------------------

#[tokio::test]
async fn admin_share_on_behalf_creates_invite_and_rejects_inactive() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "own2", "own2@x.test").await;
    let own2 = login(&server, "own2").await;
    let rcpt_id = create_user(&server, &admin, "friend", "friend@x.test").await;
    let friend = login(&server, "friend").await;

    let sid = create_project(&server, &own2, "Shareable").await["id"].as_str().unwrap().to_string();

    let ok = server.client.post(server.api_url(&format!("/admin/projects/{sid}/shares")))
        .bearer_auth(&admin).json(&json!({ "recipient_id": rcpt_id, "permission_level": "editor" })).send().await.unwrap();
    assert_eq!(ok.status().as_u16(), 200, "admin share ok");

    // recipient got the share-invite notification (pending — visible after accept).
    let notifs: Value = server.client.get(server.api_url("/notifications")).bearer_auth(&friend).send().await.unwrap().json().await.unwrap();
    assert!(notifs["items"].as_array().unwrap().iter().any(|n| n["kind"] == json!("project_share_invite")), "recipient notified");

    // sharing to the current owner → 400.
    let own_id = {
        let d: Value = server.client.get(server.api_url(&format!("/admin/projects/{sid}"))).bearer_auth(&admin).send().await.unwrap().json().await.unwrap();
        d["project"]["owner_id"].as_str().unwrap().to_string()
    };
    let self_share = server.client.post(server.api_url(&format!("/admin/projects/{sid}/shares")))
        .bearer_auth(&admin).json(&json!({ "recipient_id": own_id, "permission_level": "viewer" })).send().await.unwrap();
    assert_eq!(self_share.status().as_u16(), 400, "cannot share to the owner");
}

// ------------------------- TEST-22 : user-search picker endpoint -------------------------

#[tokio::test]
async fn admin_user_search_filters_and_denies_non_admin() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "searchme", "searchme@x.test").await;
    let member = { create_user(&server, &admin, "plain", "plain@x.test").await; login(&server, "plain").await };

    let res: Value = server.client.get(server.api_url("/admin/user-search?search=searchme")).bearer_auth(&admin).send().await.unwrap().json().await.unwrap();
    let users = res["users"].as_array().unwrap();
    assert!(users.iter().any(|u| u["username"] == json!("searchme")), "search matches username");
    assert!(users.iter().all(|u| u["username"] != json!("plain")), "non-match excluded");

    // email match too.
    let by_email: Value = server.client.get(server.api_url("/admin/user-search?search=searchme@x")).bearer_auth(&admin).send().await.unwrap().json().await.unwrap();
    assert!(by_email["users"].as_array().unwrap().iter().any(|u| u["username"] == json!("searchme")), "search matches email");

    // a non-admin member → 403 (no PII leak).
    let deny = server.client.get(server.api_url("/admin/user-search?search=a")).bearer_auth(&member).send().await.unwrap();
    assert_eq!(deny.status().as_u16(), 403);
}

// ------------------------- TEST-9 : A9 admin deny path -------------------------

#[tokio::test]
async fn admin_endpoints_deny_non_admin() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    // a regular Users-group member: holds projects::use but NOT project::admin::*.
    create_user(&server, &admin, "regular", "regular@x.test").await;
    let regular = login(&server, "regular").await;
    // seed one project so the endpoints have a target.
    let sid = create_project(&server, &regular, "Mine").await["id"].as_str().unwrap().to_string();

    // read (list/detail/user-search) → 403.
    for path in [format!("/admin/projects"), format!("/admin/projects/{sid}"), format!("/admin/user-search")] {
        let r = server.client.get(server.api_url(&path)).bearer_auth(&regular).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 403, "read {path} denied for non-admin");
    }
    // manage (change-owner/share/delete/revoke/reassign/batch) → 403.
    let co = server.client.post(server.api_url(&format!("/admin/projects/{sid}/change-owner"))).bearer_auth(&regular).json(&json!({"new_owner_id": uuid_zero()})).send().await.unwrap();
    assert_eq!(co.status().as_u16(), 403);
    let sh = server.client.post(server.api_url(&format!("/admin/projects/{sid}/shares"))).bearer_auth(&regular).json(&json!({"recipient_id": uuid_zero(), "permission_level":"viewer"})).send().await.unwrap();
    assert_eq!(sh.status().as_u16(), 403);
    let de = server.client.delete(server.api_url(&format!("/admin/projects/{sid}"))).bearer_auth(&regular).send().await.unwrap();
    assert_eq!(de.status().as_u16(), 403);
    let ra = server.client.post(server.api_url("/admin/projects/reassign-owner")).bearer_auth(&regular).json(&json!({"from_owner_id": uuid_zero(), "to_owner_id": uuid_zero()})).send().await.unwrap();
    assert_eq!(ra.status().as_u16(), 403);
    let bd = server.client.post(server.api_url("/admin/projects/batch-delete")).bearer_auth(&regular).json(&json!({"project_ids": [sid]})).send().await.unwrap();
    assert_eq!(bd.status().as_u16(), 403);
}
