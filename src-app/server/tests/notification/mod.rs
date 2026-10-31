//! TEST-7/8/10 — the SDK notification inbox (dogfooded by project sharing): the
//! inbox CRUD + per-user isolation, the A9 deny path, and the kind registry +
//! Users-group grant.

use serde_json::{json, Value};

use crate::common::TestServer;

const USERS_GROUP_ID: &str = "79668b78-16ff-4d3f-80e6-afdbb3236dc9";

async fn setup_admin(server: &TestServer) -> String {
    let r = server.client.post(server.api_url("/session/local"))
        .json(&json!({"username":"adm","email":"adm@x.test","password":"admPassw0rd!"})).send().await.unwrap();
    let b: Value = r.json().await.unwrap();
    b["access_token"].as_str().or_else(|| b["token"].as_str()).unwrap().to_string()
}

async fn user(server: &TestServer, admin: &str, name: &str) -> (String, String) {
    let cr = server.client.post(server.api_url("/auth/register")).bearer_auth(admin)
        .json(&json!({"username":name,"email":format!("{name}@x.test"),"password":"userPassw0rd!"})).send().await.unwrap();
    let id = cr.json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let lr = server.client.post(server.api_url("/auth/login"))
        .json(&json!({"username":name,"password":"userPassw0rd!"})).send().await.unwrap();
    let token = lr.json::<Value>().await.unwrap()["access_token"].as_str().unwrap().to_string();
    (id, token)
}

/// Produce a notification for `recipient_email` by having `owner` share a project.
async fn share_to(server: &TestServer, owner: &str, recipient_email: &str) {
    let sid = server.client.post(server.api_url("/projects")).bearer_auth(owner)
        .json(&json!({"name":"S"})).send().await.unwrap().json::<Value>().await.unwrap()["id"].as_str().unwrap().to_string();
    let r = server.client.post(server.api_url(&format!("/projects/{sid}/shares"))).bearer_auth(owner)
        .json(&json!({"email":recipient_email,"permission_level":"viewer"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 201);
}

#[tokio::test]
async fn inbox_crud_and_per_user_isolation() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (_oid, owner) = user(&server, &admin, "owner").await;
    let (_bid, bob) = user(&server, &admin, "bob").await;
    let (_cid, carol) = user(&server, &admin, "carol").await;

    // owner shares with bob → bob gets a project_share_invite notification.
    share_to(&server, &owner, "bob@x.test").await;

    let page: Value = server.client.get(server.api_url("/notifications")).bearer_auth(&bob).send().await.unwrap().json().await.unwrap();
    assert_eq!(page["total"], json!(1), "bob has 1 notification");
    assert_eq!(page["unread"], json!(1));
    let n = &page["items"][0];
    assert_eq!(n["kind"], json!("project_share_invite"));
    assert!(n["payload"]["project_id"].is_string(), "payload carries project_id");
    let nid = n["id"].as_str().unwrap().to_string();

    // carol's inbox is empty (per-user isolation).
    let carol_page: Value = server.client.get(server.api_url("/notifications")).bearer_auth(&carol).send().await.unwrap().json().await.unwrap();
    assert_eq!(carol_page["total"], json!(0));

    // unread-count.
    let uc: Value = server.client.get(server.api_url("/notifications/unread-count")).bearer_auth(&bob).send().await.unwrap().json().await.unwrap();
    assert_eq!(uc["unread"], json!(1));

    // carol cannot READ bob's notification: the owner-scoped GET 404s (no
    // existence leak).
    let foreign_get = server.client.get(server.api_url(&format!("/notifications/{nid}"))).bearer_auth(&carol).send().await.unwrap();
    assert_eq!(foreign_get.status().as_u16(), 404, "cross-user GET → 404");

    // carol's mark-read of bob's notification is an owner-scoped no-op. R2's
    // mark-read is idempotent + owner-scoped: it returns 200 with the CALLER'S
    // own unread count (it does NOT 404 / leak existence), and bob's row is left
    // untouched — the actual cross-user isolation guarantee, asserted below.
    let foreign = server.client.post(server.api_url(&format!("/notifications/{nid}/read"))).bearer_auth(&carol).send().await.unwrap();
    assert_eq!(foreign.status().as_u16(), 200, "cross-user mark-read is an owner-scoped no-op (R2 contract)");
    let bob_uc: Value = server.client.get(server.api_url("/notifications/unread-count")).bearer_auth(&bob).send().await.unwrap().json().await.unwrap();
    assert_eq!(bob_uc["unread"], json!(1), "carol's mark-read must NOT touch bob's inbox");

    // mark-read flips read_at.
    let mr = server.client.post(server.api_url(&format!("/notifications/{nid}/read"))).bearer_auth(&bob).send().await.unwrap();
    assert_eq!(mr.status().as_u16(), 200);
    let uc2: Value = server.client.get(server.api_url("/notifications/unread-count")).bearer_auth(&bob).send().await.unwrap().json().await.unwrap();
    assert_eq!(uc2["unread"], json!(0));

    // delete removes it.
    let del = server.client.delete(server.api_url(&format!("/notifications/{nid}"))).bearer_auth(&bob).send().await.unwrap();
    assert_eq!(del.status().as_u16(), 204);
    let empty: Value = server.client.get(server.api_url("/notifications")).bearer_auth(&bob).send().await.unwrap().json().await.unwrap();
    assert_eq!(empty["total"], json!(0));
}

#[tokio::test]
async fn deny_and_kinds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Unauthenticated → 401.
    let un = server.client.get(server.api_url("/notifications")).send().await.unwrap();
    assert_eq!(un.status().as_u16(), 401);

    // A fresh Users member holds notifications::read (grant) → 200.
    let (_mid, member) = user(&server, &admin, "member").await;
    let ok = server.client.get(server.api_url("/notifications")).bearer_auth(&member).send().await.unwrap();
    assert_eq!(ok.status().as_u16(), 200);

    // The registered kinds include the project kinds.
    let kinds: Value = server.client.get(server.api_url("/notifications/kinds")).bearer_auth(&member).send().await.unwrap().json().await.unwrap();
    let names: Vec<&str> = kinds.as_array().unwrap().iter().map(|k| k["kind"].as_str().unwrap()).collect();
    assert!(names.contains(&"project_share_invite"), "kinds: {names:?}");
    assert!(names.contains(&"project_transfer_invite"));

    // A user stripped of the Users group lacks notifications::read → 403 (A9).
    let (id, _t) = user(&server, &admin, "nogrant").await;
    server.client.delete(server.api_url(&format!("/groups/{id}/{USERS_GROUP_ID}/remove"))).bearer_auth(&admin).send().await.unwrap();
    let ng = server.client.post(server.api_url("/auth/login")).json(&json!({"username":"nogrant","password":"userPassw0rd!"})).send().await.unwrap();
    let ngt = ng.json::<Value>().await.unwrap()["access_token"].as_str().unwrap().to_string();
    let deny = server.client.get(server.api_url("/notifications")).bearer_auth(&ngt).send().await.unwrap();
    assert_eq!(deny.status().as_u16(), 403, "no notifications::read → 403");
}
