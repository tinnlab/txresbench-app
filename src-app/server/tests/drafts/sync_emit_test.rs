//! TEST-6 [acceptance] [invariant: INV-6] [covers: ITEM-6] — each of
//! create/edit/delete emits a `Draft` sync event to the PROJECT audience (the owner),
//! and a NON-MEMBER receives none (cross-user isolation). The freeze-completion emit
//! (also a `Draft` event, detached `origin=None`) is exercised by the sandbox-tier
//! freeze tests; here we pin the three non-sandbox mutations + the isolation control.

use std::time::Duration;

use serde_json::json;

use super::*;
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

#[tokio::test]
async fn draft_mutations_emit_to_project_audience_and_isolate_nonmembers() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    create_user(&server, &admin, "bob", "bob@x.test").await;
    let bob = login(&server, "bob").await;

    let project = create_project(&server, &alice, "Atlas").await;

    // Alice's OTHER device (a second sync connection) + Bob (a non-member).
    let mut alice_probe = SyncProbe::open(&server, &alice).await;
    let mut bob_probe = SyncProbe::open(&server, &bob).await;

    // CREATE — Alice's device gets Draft/create; Bob (non-member) gets nothing.
    let draft = create_draft(&server, &alice, &project, "test/widget", json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();
    let f = alice_probe
        .expect_event_for("draft", "create", &id, Duration::from_secs(5))
        .await;
    assert_eq!(f.id, id);
    bob_probe.expect_silence(Duration::from_millis(600)).await;

    // EDIT — Draft/update.
    let u = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": {"n": 2} }))
        .send()
        .await
        .unwrap();
    assert_eq!(u.status().as_u16(), 200);
    alice_probe
        .expect_event_for("draft", "update", &id, Duration::from_secs(5))
        .await;
    bob_probe.expect_silence(Duration::from_millis(600)).await;

    // DELETE — Draft/delete.
    let d = server
        .client
        .delete(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(d.status().as_u16(), 204);
    alice_probe
        .expect_event_for("draft", "delete", &id, Duration::from_secs(5))
        .await;
    bob_probe.expect_silence(Duration::from_millis(600)).await;
}
