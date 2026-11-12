//! Project module integration tests — full production path through a real spawned
//! server + real Postgres (per-test DB). Covers CRUD/search/duplicate, the
//! authz deny path (A9), the Users-group grant, the per-project resource ACL
//! (owner/editor/viewer), dataset grouping + cap, sharing, transfer, and the
//! admin settings gate.

use serde_json::{json, Value};

use crate::common::TestServer;

// ------------------------------- helpers -------------------------------

/// First-run setup → the admin owner + their access token.
async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "admin",
            "email": "admin@txresbench.test",
            "password": "adminPassw0rd!",
            "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 200);
    token_of(resp.json().await.expect("setup json"))
}

fn token_of(body: Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Create a user (admin) — auto-joined to the Users group, so they hold
/// `projects::use` + `notifications::read` (the migration grant). Returns the id.
async fn create_user(server: &TestServer, admin: &str, username: &str, email: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": email,
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert!(resp.status().is_success(), "create user {username}: {}", resp.status());
    let body: Value = resp.json().await.expect("user json");
    body["user"]["id"].as_str().expect("user id").to_string()
}

/// Log in → an access token.
async fn login(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login");
    assert_eq!(resp.status().as_u16(), 200, "login {username}");
    token_of(resp.json().await.expect("login json"))
}

/// Create a user then STRIP them from the Users group → they no longer hold
/// `projects::use` (for the A9 deny path). The `/groups` HTTP surface is
/// stripped on this node, so the removal goes through the SDK user repository.
async fn create_user_without_projects(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = create_user(server, admin, username, email).await;
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect strip pool");
    crate::common::group_remove_from_users(
        &pool,
        uuid::Uuid::parse_str(&id).expect("user id is a uuid"),
    )
    .await;
    id
}

async fn create_project(server: &TestServer, token: &str, name: &str) -> Value {
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(resp.status().as_u16(), 201, "create project {name}");
    resp.json().await.expect("project json")
}

async fn create_dataset(server: &TestServer, token: &str, name: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("create dataset");
    assert_eq!(resp.status().as_u16(), 201);
    let body: Value = resp.json().await.expect("dataset json");
    body["id"].as_str().expect("dataset id").to_string()
}

// ------------------------------- TEST-14: CRUD -------------------------------

#[tokio::test]
async fn crud_owner_scoped_404_not_403() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice_id = create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let bob = {
        create_user(&server, &admin, "bob", "bob@x.test").await;
        login(&server, "bob").await
    };

    // Create (201) — owner_id is the creator, effective_permission=owner.
    let project = create_project(&server, &alice, "PBMC atlas").await;
    let sid = project["id"].as_str().unwrap().to_string();
    assert_eq!(project["owner_id"], json!(alice_id));
    assert_eq!(project["effective_permission"], json!("owner"));
    assert_eq!(project["dataset_count"], json!(0));

    // Get own → 200.
    let g = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&alice).send().await.unwrap();
    assert_eq!(g.status().as_u16(), 200);

    // Bob (a foreign user) → 404 (NOT 403 — no existence leak).
    let f = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&bob).send().await.unwrap();
    assert_eq!(f.status().as_u16(), 404, "foreign project is 404 not 403");

    // Update.
    let u = server.client.post(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&alice)
        .json(&json!({ "name": "PBMC atlas v2" })).send().await.unwrap();
    assert_eq!(u.status().as_u16(), 200);
    assert_eq!(u.json::<Value>().await.unwrap()["name"], json!("PBMC atlas v2"));

    // List (alice sees 1, bob sees 0).
    let list: Value = server.client.get(server.api_url("/projects")).bearer_auth(&alice).send().await.unwrap().json().await.unwrap();
    assert_eq!(list["total"], json!(1));
    let blist: Value = server.client.get(server.api_url("/projects")).bearer_auth(&bob).send().await.unwrap().json().await.unwrap();
    assert_eq!(blist["total"], json!(0));

    // Delete → 204; then gone.
    let d = server.client.delete(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&alice).send().await.unwrap();
    assert_eq!(d.status().as_u16(), 204);
    let g2 = server.client.get(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&alice).send().await.unwrap();
    assert_eq!(g2.status().as_u16(), 404);
}

// ------------------------------- TEST-15: search + pagination -------------------------------

#[tokio::test]
async fn search_ilike_and_pagination() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "sam", "sam@x.test").await;
    let sam = login(&server, "sam").await;

    create_project(&server, &sam, "Alpha project").await;
    create_project(&server, &sam, "Beta project").await;
    create_project(&server, &sam, "alpha centauri").await;

    // Case-insensitive substring on name.
    let res: Value = server.client.get(server.api_url("/projects?search=ALPHA")).bearer_auth(&sam).send().await.unwrap().json().await.unwrap();
    assert_eq!(res["total"], json!(2), "ILIKE %alpha% matches 2");

    // per_page clamp + page.
    let p1: Value = server.client.get(server.api_url("/projects?page=1&per_page=2")).bearer_auth(&sam).send().await.unwrap().json().await.unwrap();
    assert_eq!(p1["projects"].as_array().unwrap().len(), 2);
    assert_eq!(p1["total"], json!(3));
}

// ------------------------------- TEST-16: duplicate -------------------------------

#[tokio::test]
async fn duplicate_copy_suffix() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "dan", "dan@x.test").await;
    let dan = login(&server, "dan").await;
    let project = create_project(&server, &dan, "My project").await;
    let sid = project["id"].as_str().unwrap();

    let dup1: Value = server.client.post(server.api_url(&format!("/projects/{sid}/duplicate"))).bearer_auth(&dan).send().await.unwrap().json().await.unwrap();
    assert_eq!(dup1["name"], json!("My project (copy 1)"));
    let dup2: Value = server.client.post(server.api_url(&format!("/projects/{sid}/duplicate"))).bearer_auth(&dan).send().await.unwrap().json().await.unwrap();
    assert_eq!(dup2["name"], json!("My project (copy 2)"));
}

// ------------------------------- TEST-17/18: A9 deny + grant -------------------------------

#[tokio::test]
async fn authz_deny_and_grant() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Unauthenticated → 401.
    let un = server.client.get(server.api_url("/projects")).send().await.unwrap();
    assert_eq!(un.status().as_u16(), 401);

    // A fresh Users-group member holds projects::use (grant) → 200 (TEST-18).
    create_user(&server, &admin, "member", "member@x.test").await;
    let member = login(&server, "member").await;
    let ok = server.client.get(server.api_url("/projects")).bearer_auth(&member).send().await.unwrap();
    assert_eq!(ok.status().as_u16(), 200, "Users-group member holds projects::use");

    // A user stripped of the Users group lacks projects::use → 403 (TEST-17, A9).
    create_user_without_projects(&server, &admin, "nogrant", "nogrant@x.test").await;
    let nogrant = login(&server, "nogrant").await;
    let deny_get = server.client.get(server.api_url("/projects")).bearer_auth(&nogrant).send().await.unwrap();
    assert_eq!(deny_get.status().as_u16(), 403, "no projects::use → 403 on GET");
    let deny_post = server.client.post(server.api_url("/projects")).bearer_auth(&nogrant).json(&json!({"name":"x"})).send().await.unwrap();
    assert_eq!(deny_post.status().as_u16(), 403, "no projects::use → 403 on POST");
}

mod accept_origin_test;
mod admin_test;
mod datasets;
mod extensions;
mod scope;
mod settings;
mod shares;
mod transfer;
