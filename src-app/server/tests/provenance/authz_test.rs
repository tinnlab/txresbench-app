//! TEST-26 (A9) — provenance route authorization: unauth → 401; a user lacking
//! the required perm → 403; a FOREIGN project's graph/runs → 404 (owner-scope, no
//! existence leak).
//!
//! Grant reality: the Users group HOLDS `provenance::read`/`export` (migration
//! grant), so the read-route 403 is exercised with a user STRIPPED from the Users
//! group; the admin-only settings routes give the 403 for a normal Users member.

use super::*;

#[tokio::test]
async fn unauthenticated_is_401_on_every_route() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let sid = Uuid::new_v4();

    let cases: Vec<(&str, String)> = vec![
        ("GET", format!("/provenance/graph?project_id={sid}")),
        ("GET", format!("/provenance/runs?project_id={sid}")),
        ("POST", "/provenance/selections".to_string()),
        ("POST", "/provenance/actions".to_string()),
        ("POST", "/provenance/export".to_string()),
        ("GET", "/provenance/settings".to_string()),
    ];
    for (method, path) in cases {
        let req = match method {
            "GET" => server.client.get(server.api_url(&path)),
            _ => server.client.post(server.api_url(&path)).json(&json!({})),
        };
        let resp = req.send().await.expect("unauth request");
        assert_eq!(resp.status().as_u16(), 401, "{method} {path} unauth → 401");
    }
}

#[tokio::test]
async fn lacking_perm_is_403() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // A user stripped of the Users group lacks provenance::read → 403 on a read
    // route (the perm check fails before any project lookup).
    let nogrant = create_user_without_provenance(&server, &admin, "nogrant", "ng@x.test").await;
    let sid = Uuid::new_v4();
    let deny_read = server
        .client
        .get(server.api_url(&format!("/provenance/graph?project_id={sid}")))
        .bearer_auth(&nogrant)
        .send()
        .await
        .expect("read without perm");
    assert_eq!(deny_read.status().as_u16(), 403, "no provenance::read → 403");

    // A normal Users member lacks provenance::settings::{read,manage} (admin-only)
    // → 403 on the settings routes.
    create_user(&server, &admin, "member", "member@x.test").await;
    let member = login(&server, "member").await;
    let deny_settings = server
        .client
        .get(server.api_url("/provenance/settings"))
        .bearer_auth(&member)
        .send()
        .await
        .expect("settings without perm");
    assert_eq!(deny_settings.status().as_u16(), 403, "no settings::read → 403");
}

#[tokio::test]
async fn foreign_project_is_404_not_a_leak() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Alice owns a project; Bob is a Users member (holds provenance::read) with no
    // role on it.
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    create_user(&server, &admin, "bob", "bob@x.test").await;
    let bob = login(&server, "bob").await;
    let project_id = create_project(&server, &alice, "alice private").await;

    // Bob HAS provenance::read (perm passes) but no project role → 404, not the row.
    let graph = server
        .client
        .get(server.api_url(&format!("/provenance/graph?project_id={project_id}")))
        .bearer_auth(&bob)
        .send()
        .await
        .expect("foreign graph");
    assert_eq!(graph.status().as_u16(), 404, "foreign project graph is 404");

    let runs = server
        .client
        .get(server.api_url(&format!("/provenance/runs?project_id={project_id}")))
        .bearer_auth(&bob)
        .send()
        .await
        .expect("foreign runs");
    assert_eq!(runs.status().as_u16(), 404, "foreign project runs is 404");
}
