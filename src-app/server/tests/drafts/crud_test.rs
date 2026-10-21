//! TEST-10 [covers: ITEM-4] — create/get/update/delete/list_by_project round-trip,
//! each scoped by project/owner; `list?project_id&kind` filters correctly.

use serde_json::{json, Value};

use super::*;
use crate::common::TestServer;

#[tokio::test]
async fn crud_and_list_filtering_round_trip() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;

    // Create two opaque kinds, one with two rows.
    let d1 = create_draft(&server, &alice, &project, "test/widget", json!({"n": 1})).await;
    let d1_id = d1["id"].as_str().unwrap().to_string();
    assert_eq!(d1["kind"], json!("test/widget"));
    assert_eq!(d1["status"], json!("open"));
    assert_eq!(d1["data"], json!({"n": 1}));
    assert!(
        d1["frozen_artifact_id"].is_null(),
        "a fresh draft has no artifact"
    );

    let _d2 = create_draft(&server, &alice, &project, "test/widget", json!({"n": 2})).await;
    let d3 = create_draft(
        &server,
        &alice,
        &project,
        "test/palette",
        json!({"hue": "x"}),
    )
    .await;
    let d3_id = d3["id"].as_str().unwrap().to_string();

    // GET one.
    let g = server
        .client
        .get(server.api_url(&format!("/drafts/{d1_id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(g.status().as_u16(), 200);
    let g: Value = g.json().await.unwrap();
    assert_eq!(g["data"], json!({"n": 1}));

    // PUT (replace data).
    let u = server
        .client
        .put(server.api_url(&format!("/drafts/{d1_id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": {"n": 42, "note": "edited"} }))
        .send()
        .await
        .unwrap();
    assert_eq!(u.status().as_u16(), 200);
    let u: Value = u.json().await.unwrap();
    assert_eq!(u["data"], json!({"n": 42, "note": "edited"}));
    assert_eq!(u["status"], json!("open"));

    // LIST all in project.
    let all: Value = server
        .client
        .get(server.api_url(&format!("/drafts?project_id={project}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        all["drafts"].as_array().unwrap().len(),
        3,
        "three drafts in project"
    );

    // LIST filtered by opaque kind.
    let filtered: Value = server
        .client
        .get(server.api_url(&format!("/drafts?project_id={project}&kind=test/widget")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rows = filtered["drafts"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "kind filter returns only test/widget rows");
    assert!(rows.iter().all(|r| r["kind"] == json!("test/widget")));

    // DELETE → 204, then GET → 404.
    let del = server
        .client
        .delete(server.api_url(&format!("/drafts/{d3_id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 204, "DELETE returns 204");
    let gone = server
        .client
        .get(server.api_url(&format!("/drafts/{d3_id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status().as_u16(), 404, "deleted draft is gone");

    // The remaining project list is now 2.
    let after: Value = server
        .client
        .get(server.api_url(&format!("/drafts?project_id={project}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["drafts"].as_array().unwrap().len(), 2);
}
