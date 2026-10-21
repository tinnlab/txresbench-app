//! `origin` means the same thing on every frame addressed to the acting user.
//!
//! Accepting a SHARE and accepting a TRANSFER both publish "you just gained this
//! project" (`Project`/`Create`) to the accepting user. They disagreed about
//! `origin`: `accept_transfer` stamped it (suppress → the acting tab re-emits
//! locally, per `core/sync/localEcho.ts`); `accept_share` sent `None`, making it the
//! ONE frame in the module addressed to the actor without suppression.
//!
//! Nothing was visibly broken — the frontend compensated by deliberately not echoing
//! that one — but the compensation is a per-frame exception a reader must look up,
//! and the whole point of the acting-tab convention is that there are none. These
//! tests pin the uniform rule from the wire's side, in both directions, so it cannot
//! drift back: a frame addressed to the ACTOR carries `origin`; a frame addressed to
//! anyone else carries `None`.

use std::time::Duration;

use serde_json::{json, Value};

use super::{create_project, create_user, login, setup_admin};
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

const WAIT: Duration = Duration::from_secs(5);
const SILENCE: Duration = Duration::from_secs(2);

/// Owner shares `project` with `recipient` (editor) → the pending share id.
async fn invite(server: &TestServer, owner: &str, project_id: &str, email: &str) -> String {
    let resp = server
        .client
        .post(server.api_url(&format!("/projects/{project_id}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "email": email, "permission_level": "editor" }))
        .send()
        .await
        .expect("create share");
    assert_eq!(resp.status().as_u16(), 201, "owner invites");
    let body: Value = resp.json().await.expect("share json");
    body["id"].as_str().expect("share id").to_string()
}

/// The ACCEPTING user's own connection is suppressed for BOTH frames the accept
/// publishes to them — `project_share`/update AND `project`/create. On the old
/// shape the `project`/create arrived here, so this stream was not silent.
#[tokio::test]
async fn accepting_a_share_suppresses_every_frame_on_the_acting_connection() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "sharee", "sharee@cyto.test").await;
    let sharee = login(&server, "sharee").await;

    let project = create_project(&server, &admin, "shared-project").await;
    let pid = project["id"].as_str().expect("project id").to_string();
    let share_id = invite(&server, &admin, &pid, "sharee@cyto.test").await;

    let mut sharee_probe = SyncProbe::open(&server, &sharee).await;

    let accept = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(&sharee)
        .header(
            "X-Sync-Connection-Id",
            sharee_probe.connection_id().to_string(),
        )
        .send()
        .await
        .expect("accept share");
    assert_eq!(accept.status().as_u16(), 200, "the recipient accepts");

    sharee_probe.expect_silence(SILENCE).await;
}

/// The same assertion for `accept_transfer`, which already behaved this way. It is
/// the CONTROL: green before and after, so a red above is about `accept_share` and
/// not about the probe or the accept path in general.
#[tokio::test]
async fn accepting_a_transfer_suppresses_every_frame_on_the_acting_connection_control() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "newowner", "newowner@cyto.test").await;
    let new_owner = login(&server, "newowner").await;

    let project = create_project(&server, &admin, "to-be-transferred").await;
    let pid = project["id"].as_str().expect("project id").to_string();

    let created = server
        .client
        .post(server.api_url(&format!("/projects/{pid}/transfer")))
        .bearer_auth(&admin)
        .json(&json!({ "email": "newowner@cyto.test" }))
        .send()
        .await
        .expect("create transfer");
    assert_eq!(created.status().as_u16(), 201, "owner offers the transfer");
    let transfer_id = created.json::<Value>().await.expect("transfer json")["id"]
        .as_str()
        .expect("transfer id")
        .to_string();

    let mut probe = SyncProbe::open(&server, &new_owner).await;
    let accept = server
        .client
        .post(server.api_url(&format!("/project-transfers/{transfer_id}/accept")))
        .bearer_auth(&new_owner)
        .header("X-Sync-Connection-Id", probe.connection_id().to_string())
        .send()
        .await
        .expect("accept transfer");
    assert_eq!(accept.status().as_u16(), 200, "the recipient accepts");

    probe.expect_silence(SILENCE).await;
}

/// The other half of the rule, and the mutant-killer for "just delete the emit":
/// a client that sends NO connection id still receives both frames, and the OWNER
/// (a non-actor) is told regardless.
#[tokio::test]
async fn accepting_a_share_still_reaches_a_non_acting_connection_and_the_owner() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "sharee2", "sharee2@cyto.test").await;
    let sharee = login(&server, "sharee2").await;

    let project = create_project(&server, &admin, "shared-project-2").await;
    let pid = project["id"].as_str().expect("project id").to_string();
    let share_id = invite(&server, &admin, &pid, "sharee2@cyto.test").await;

    // The sharee's SECOND device, and the owner — neither is the acting connection.
    let mut sharee_other_device = SyncProbe::open(&server, &sharee).await;
    let mut owner_probe = SyncProbe::open(&server, &admin).await;
    let acting = SyncProbe::open(&server, &sharee).await;

    let accept = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(&sharee)
        .header("X-Sync-Connection-Id", acting.connection_id().to_string())
        .send()
        .await
        .expect("accept share");
    assert_eq!(accept.status().as_u16(), 200);

    // The accepting user's OTHER device learns it gained the project…
    let gained = sharee_other_device
        .expect_event("project", "create", WAIT)
        .await;
    assert_eq!(gained.id, pid, "the frame names the gained project");
    // …and the owner is told their share was accepted.
    let seen = owner_probe
        .expect_event("project_share", "update", WAIT)
        .await;
    assert_eq!(seen.id, share_id);
}
