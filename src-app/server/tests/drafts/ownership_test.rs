//! TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-3, ITEM-4] — a
//! GET/PUT/DELETE/freeze on another user's (or another project's) draft id yields
//! 404, never the row.

use serde_json::json;

use super::*;
use crate::common::TestServer;

#[tokio::test]
async fn cross_user_draft_is_404_not_the_row() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    create_user(&server, &admin, "bob", "bob@x.test").await;
    let bob = login(&server, "bob").await;

    let project = create_project(&server, &alice, "Alice atlas").await;
    let draft = create_draft(&server, &alice, &project, "test/widget", json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    // Bob (foreign, no access to Alice's project) → 404 on every verb, never the row.
    let g = server
        .client
        .get(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(g.status().as_u16(), 404, "foreign GET is 404");

    let p = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&bob)
        .json(&json!({ "data": {"hacked": true} }))
        .send()
        .await
        .unwrap();
    assert_eq!(p.status().as_u16(), 404, "foreign PUT is 404");

    let del = server
        .client
        .delete(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 404, "foreign DELETE is 404");

    let fz = server
        .client
        .post(server.api_url(&format!("/drafts/{id}/freeze")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(fz.status().as_u16(), 404, "foreign freeze is 404");

    // And a nonexistent id is also 404 (no oracle) for the owner.
    let missing = uuid::Uuid::new_v4();
    let m = server
        .client
        .get(server.api_url(&format!("/drafts/{missing}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(m.status().as_u16(), 404, "nonexistent draft is 404");

    // The row is untouched by Bob's PUT attempt.
    let g2 = server
        .client
        .get(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = g2.json().await.unwrap();
    assert_eq!(
        body["data"],
        json!({"n": 1}),
        "Bob's PUT never mutated the row"
    );
}
