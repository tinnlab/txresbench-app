//! TEST-9 [covers: ITEM-5] — a create/PUT whose serialized `data` exceeds 256 KiB is
//! rejected (422), and a blob just under the cap succeeds.

use serde_json::json;

use super::*;
use crate::common::TestServer;

const CAP: usize = 256 * 1024;

#[tokio::test]
async fn data_over_the_cap_is_422_under_it_succeeds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;

    // Just under the cap → 201. (Leave headroom for the JSON envelope `{"v":"..."}`.)
    let under = "x".repeat(CAP - 64);
    let ok = server
        .client
        .post(server.api_url("/drafts"))
        .bearer_auth(&alice)
        .json(&json!({ "kind": "test/widget", "project_id": project, "data": { "v": under } }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        ok.status().as_u16(),
        201,
        "a blob just under 256 KiB succeeds"
    );
    let created: serde_json::Value = ok.json().await.unwrap();
    let id = created["id"].as_str().unwrap().to_string();

    // Over the cap → 422 on create.
    let over = "x".repeat(CAP + 1);
    let too_big = server
        .client
        .post(server.api_url("/drafts"))
        .bearer_auth(&alice)
        .json(&json!({ "kind": "test/widget", "project_id": project, "data": { "v": over } }))
        .send()
        .await
        .unwrap();
    assert_eq!(too_big.status().as_u16(), 422, "over-cap create is 422");

    // Over the cap → 422 on PUT too.
    let over2 = "y".repeat(CAP + 1);
    let put = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": { "v": over2 } }))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status().as_u16(), 422, "over-cap PUT is 422");
}
