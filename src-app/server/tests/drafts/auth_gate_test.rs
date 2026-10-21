//! TEST-8 [covers: ITEM-3] — every `/drafts*` endpoint returns 401 unauthenticated
//! and 403 for a user WITHOUT `drafts::use` (the A9 backend deny half).

use serde_json::{json, Value};

use super::*;
use crate::common::TestServer;

#[tokio::test]
async fn drafts_endpoints_are_401_unauth_and_403_without_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    // Alice holds drafts::use (Users group) and owns a project + draft.
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;
    let draft = create_draft(&server, &alice, &project, "test/widget", json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    // Carol is stripped of the Users group → no drafts::use.
    create_user_without_drafts(&server, &admin, "carol", "carol@x.test").await;
    let carol = login(&server, "carol").await;

    // Each endpoint: (method, path, optional body). Unauthenticated → 401; with
    // Carol (no perm) → 403.
    let cases: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", format!("/drafts?project_id={project}"), None),
        (
            "POST",
            "/drafts".to_string(),
            Some(json!({ "kind": "test/widget", "project_id": project })),
        ),
        ("GET", format!("/drafts/{id}"), None),
        ("PUT", format!("/drafts/{id}"), Some(json!({ "data": {} }))),
        ("DELETE", format!("/drafts/{id}"), None),
        ("POST", format!("/drafts/{id}/freeze"), None),
        // INV-7 lineage read is gated the same (`drafts::use`); a random artifact id is enough
        // to reach the extractor (401/403 fire BEFORE any lookup).
        (
            "GET",
            format!("/drafts/artifacts/{}/lineage", uuid::Uuid::new_v4()),
            None,
        ),
    ];

    for (method, path, body) in &cases {
        let build = |tok: Option<&str>| {
            let mut rb = match *method {
                "GET" => server.client.get(server.api_url(path)),
                "POST" => server.client.post(server.api_url(path)),
                "PUT" => server.client.put(server.api_url(path)),
                "DELETE" => server.client.delete(server.api_url(path)),
                _ => unreachable!(),
            };
            if let Some(t) = tok {
                rb = rb.bearer_auth(t);
            }
            if let Some(b) = body {
                rb = rb.json(b);
            }
            rb
        };

        // Unauthenticated → 401.
        let un = build(None).send().await.unwrap();
        assert_eq!(un.status().as_u16(), 401, "{method} {path} unauth → 401");

        // Authenticated but lacking drafts::use → 403.
        let denied = build(Some(&carol)).send().await.unwrap();
        assert_eq!(
            denied.status().as_u16(),
            403,
            "{method} {path} no-perm → 403"
        );
    }
}

/// INV-7 — the lineage read of an artifact that is NOT a draftable-frozen version yields an EMPTY
/// chain (200), not a 404 and not a leak: an unknown/non-lineage artifact discloses nothing. (No
/// rootfs needed — the recorded-chain path is proven by `geneset::freeze_test`.)
#[tokio::test]
async fn lineage_of_non_lineage_artifact_is_empty_200() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;

    let resp = server
        .client
        .get(server.api_url(&format!(
            "/drafts/artifacts/{}/lineage",
            uuid::Uuid::new_v4()
        )))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "unknown artifact → 200 empty");
    let body: Value = resp.json().await.unwrap();
    assert_eq!(
        body["chain"].as_array().map(|a| a.len()),
        Some(0),
        "no lineage row ⇒ empty chain, no oracle: {body}"
    );
}
