//! The OWNER is told when an `edit`-role SHAREE mutates their dataset.
//!
//! ## Why this file exists, and why one user could never have caught it
//!
//! Every mutation behind `require_can_edit` is reachable by TWO different people:
//! the dataset's owner, and anyone the owner gave the `edit` role. `upload_dataset`
//! and `add_supporting_file` (whose twin test lives in `supporting_files_test.rs`,
//! where the typed-primary fixture already is) both fanned their `sync:dataset` frame out with
//! `auth.user.id` in the parameter that means "whose dataset is this" — which is
//! indistinguishable from correct whenever the actor IS the owner, i.e. in every
//! single-user test in this suite. It is only wrong for the sharee case, and there
//! it is maximally wrong: `sharee_user_ids` does not include the owner either, so
//! the frame went to the actor and the OWNER received nothing at all.
//!
//! So these tests assert on the OWNER's stream while a DIFFERENT user acts.
//! `rename_dataset` is the control: it always passed `ds.owner_id`, so it is the
//! shape the other two should have had, and its test must be green before and after.
//!
//! Each test also pins the ORIGIN half (`origin` follows the actor, not the owner),
//! because an audience assertion alone cannot see it: a frame delivered to the owner
//! is delivered whether or not the sharee's own connection was correctly suppressed.

use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde_json::json;

use super::{create_dataset, create_user, login, setup_admin};
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

const WAIT: Duration = Duration::from_secs(5);
/// Long enough that a frame the server DID send would have arrived (the fan-out is
/// synchronous, in-process, and every positive assertion above resolves well inside
/// this budget), short enough that the suite does not crawl.
const SILENCE: Duration = Duration::from_secs(2);

/// Owner + an `edit`-role sharee on one dataset. Returns
/// `(owner_token, editor_token, dataset_id)`.
async fn owner_and_edit_sharee(server: &TestServer) -> (String, String, String) {
    let admin = setup_admin(server).await;
    create_user(server, &admin, "dsowner", "dsowner@x.test").await;
    let owner = login(server, "dsowner").await;
    let editor_id = create_user(server, &admin, "dseditor", "dseditor@x.test").await;
    let editor = login(server, "dseditor").await;

    let ds = create_dataset(server, &owner, "shared-for-edit").await;
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&owner)
        .json(&json!({ "principal_type": "user", "principal_id": editor_id, "role": "edit" }))
        .send()
        .await
        .unwrap();
    assert_eq!(share.status().as_u16(), 201, "owner shares with edit role");
    (owner, editor, ds)
}

fn payload(name: &str) -> Part {
    Part::bytes(b"opaque payload bytes".to_vec()).file_name(name.to_string())
}

// ─────────────────────────── the two named holes ───────────────────────────

/// `POST /datasets/{id}/upload` performed by an edit-sharee.
#[tokio::test]
async fn an_edit_sharees_upload_reaches_the_owner() {
    let server = TestServer::spawn().await;
    let (owner, editor, ds) = owner_and_edit_sharee(&server).await;

    let mut owner_probe = SyncProbe::open(&server, &owner).await;
    let mut editor_probe = SyncProbe::open(&server, &editor).await;

    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/upload")))
        .bearer_auth(&editor)
        // The editor's own connection, so the ORIGIN half is exercised too.
        .header("X-Sync-Connection-Id", editor_probe.connection_id().to_string())
        .multipart(Form::new().part("file", payload("extra.bin")))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "an edit-sharee may upload");

    // THE ASSERTION: the dataset's OWNER learns their dataset changed.
    let frame = owner_probe.expect_event("dataset", "update", WAIT).await;
    assert_eq!(frame.id, ds, "the frame names the dataset that changed");

    // ORIGIN follows the ACTOR: the editor's own connection is suppressed (their tab
    // re-emits it locally). Pinned to the owner's frame instead, the editor would get
    // their own mutation back over the wire AND echo it — a double fetch.
    editor_probe.expect_silence(SILENCE).await;
}

// ─────────────────────────── the control ───────────────────────────

/// `rename_dataset` already passed `ds.owner_id`. It is the NEGATIVE CONTROL for the
/// two tests above: if it were also red on unmodified `main`, the red there would be
/// evidence about the harness (a probe that never receives anything) rather than
/// about the handlers.
#[tokio::test]
async fn an_edit_sharees_rename_reaches_the_owner_control() {
    let server = TestServer::spawn().await;
    let (owner, editor, ds) = owner_and_edit_sharee(&server).await;

    let mut owner_probe = SyncProbe::open(&server, &owner).await;

    let resp = server
        .client
        .put(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&editor)
        .json(&json!({ "name": "renamed-by-the-sharee" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "an edit-sharee may rename");

    let frame = owner_probe.expect_event("dataset", "update", WAIT).await;
    assert_eq!(frame.id, ds);
}

// ─────────────────────────── wire parity ───────────────────────────
//
// The assertions above prove the owner is REACHED. They cannot see a frame carrying
// the wrong action, nor a second frame nobody asked for. This block pins the exact
// set each handler publishes to the owner, so a mutant that changes `Update`→`Create`
// or adds a stray emit dies here rather than passing as "it refetched".

/// The owner's stream receives EXACTLY one `dataset` frame per sharee mutation, with
/// the action the handler declares, naming the mutated dataset.
#[tokio::test]
async fn owner_wire_parity_for_sharee_mutations() {
    let server = TestServer::spawn().await;
    let (owner, editor, ds) = owner_and_edit_sharee(&server).await;
    let mut owner_probe = SyncProbe::open(&server, &owner).await;

    // (1) upload → dataset/update, once.
    let r = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/upload")))
        .bearer_auth(&editor)
        .multipart(Form::new().part("file", payload("one.bin")))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let f = owner_probe.expect_event("dataset", "update", WAIT).await;
    assert_eq!((f.entity.as_str(), f.action.as_str(), f.id.as_str()), ("dataset", "update", ds.as_str()));
    owner_probe.expect_silence(SILENCE).await;

    // (2) rename → dataset/update, once.
    let r = server
        .client
        .put(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&editor)
        .json(&json!({ "name": "parity" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let f = owner_probe.expect_event("dataset", "update", WAIT).await;
    assert_eq!((f.entity.as_str(), f.action.as_str(), f.id.as_str()), ("dataset", "update", ds.as_str()));
    owner_probe.expect_silence(SILENCE).await;
}

/// An owner acting on their OWN dataset keeps the property the fan-out was built for:
/// their acting connection is suppressed, and no OTHER frame appears in its place.
///
/// This is the mutant-killer for "just drop `origin` and send to everyone": that
/// would make every test above pass while re-introducing the acting tab's double
/// fetch, which is the whole reason `origin` exists.
#[tokio::test]
async fn an_owners_own_mutation_is_suppressed_on_their_acting_connection() {
    let server = TestServer::spawn().await;
    let (owner, _editor, ds) = owner_and_edit_sharee(&server).await;
    let mut owner_probe = SyncProbe::open(&server, &owner).await;

    let r = server
        .client
        .put(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&owner)
        .header("X-Sync-Connection-Id", owner_probe.connection_id().to_string())
        .json(&json!({ "name": "by-the-owner" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    owner_probe.expect_silence(SILENCE).await;
}

/// A dataset a user neither owns nor is shared into never reaches their stream —
/// the positive control for "the probe only hears what it should".
#[tokio::test]
async fn a_stranger_hears_nothing() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "dsowner2", "dsowner2@x.test").await;
    let owner = login(&server, "dsowner2").await;
    create_user(&server, &admin, "stranger", "stranger@x.test").await;
    let stranger = login(&server, "stranger").await;

    let ds = create_dataset(&server, &owner, "private").await;
    let mut stranger_probe = SyncProbe::open(&server, &stranger).await;

    let r = server
        .client
        .put(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&owner)
        .json(&json!({ "name": "still-private" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    stranger_probe.expect_silence(SILENCE).await;
}

// ──────────────── the converged audience resolver (TASK 3) ────────────────

/// **`dataset_audience` is the one answer to "who can see this dataset", and this
/// pins it.**
///
/// `workstore::sync::publish_artifact_for_dataset` used to carry its own inline
/// `datasets`/`dataset_shares`/`user_groups` SQL — a fourth copy of the rule — and now
/// resolves through `dataset::sync::dataset_audience`, the same function the dataset
/// module's own frames use. This asserts the SET that function returns, across all
/// three principal shapes the deleted SQL enumerated (owner, direct user share, group
/// share), because that set is the entire contract the two emitters now share.
///
/// SCOPE, stated so it is not mistaken for more than it is: this tests the
/// RESOLVER, not delivery. Delivery for the detached finalize legs (the harvested
/// `dataset-metadata` write, and the dataset-scoped artifact catalog insert) still has
/// no direct test — see the report. An earlier attempt to get one by calling
/// `WorkstoreIngestSink::ingest_outputs` from the test process was a FALSE POSITIVE and
/// was deleted: `TestServer` runs the server as a separate PROCESS, so a `publish` made
/// in the test process reaches the test process's own sync registry and can never reach
/// the probe. It appeared to pass only because the server's scheduler had meanwhile
/// picked up the queued job the fixture created and emitted its own terminal-transition
/// `dataset/update`. Closing that leg needs a real in-server converter finalize.
///
/// NEGATIVE CONTROL: a user who is neither owner nor sharee must be absent, or an
/// implementation returning "every user" would satisfy every positive assertion.
#[tokio::test]
async fn dataset_audience_resolves_owner_user_share_and_group_share() {
    use txresbench::modules::dataset::sync::dataset_audience;
    use uuid::Uuid;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "audowner", "audowner@x.test").await;
    let owner = login(&server, "audowner").await;
    let direct_id = create_user(&server, &admin, "audirect", "audirect@x.test").await;
    let grouped_id = create_user(&server, &admin, "augrouped", "augrouped@x.test").await;
    let stranger_id = create_user(&server, &admin, "austranger", "austranger@x.test").await;

    let pool = super::hardening_common::pool_for(&server).await;
    let ds = create_dataset(&server, &owner, "audience-ds").await;
    let ds_id = Uuid::parse_str(&ds).expect("dataset uuid");
    let owner_id: Uuid = sqlx::query_scalar("SELECT owner_id FROM datasets WHERE id = $1")
        .bind(ds_id)
        .fetch_one(&pool)
        .await
        .expect("dataset owner");

    // A group containing exactly one of the three non-owners. The `/groups`
    // HTTP surface is stripped on this node; create/assign go through the SDK
    // repos over the pool the test already holds.
    let group_id = crate::common::group_create(&pool, "audience-group", vec![])
        .await
        .to_string();
    crate::common::group_assign(
        &pool,
        Uuid::parse_str(&grouped_id).expect("grouped id is a uuid"),
        Uuid::parse_str(&group_id).expect("group id is a uuid"),
    )
    .await;

    for body in [
        json!({ "principal_type": "user", "principal_id": direct_id, "role": "view" }),
        json!({ "principal_type": "group", "principal_id": group_id, "role": "edit" }),
    ] {
        let r = server
            .client
            .post(server.api_url(&format!("/datasets/{ds}/shares")))
            .bearer_auth(&owner)
            .json(&body)
            .send()
            .await
            .expect("share");
        assert_eq!(r.status().as_u16(), 201, "share created: {body}");
    }

    let (resolved_owner, recipients) = dataset_audience(&pool, ds_id)
        .await
        .expect("resolve the dataset audience")
        .expect("#168: a live dataset with a current owner has a non-empty audience");

    assert_eq!(
        resolved_owner, owner_id,
        "the audience's owner half is the DATASET's owner"
    );
    let got: std::collections::HashSet<Uuid> = recipients.into_iter().collect();
    assert!(
        got.contains(&Uuid::parse_str(&direct_id).unwrap()),
        "a direct user-share recipient is in the audience: {got:?}"
    );
    assert!(
        got.contains(&Uuid::parse_str(&grouped_id).unwrap()),
        "a member of a shared GROUP is in the audience: {got:?}"
    );
    assert!(
        !got.contains(&Uuid::parse_str(&stranger_id).unwrap()),
        "a non-sharee must NOT be in the audience: {got:?}"
    );
    assert!(
        !got.contains(&owner_id),
        "the owner is carried separately, never duplicated into recipients \
         (`fan_out_owner_scoped` adds them) — a copy here would double-send"
    );
}
