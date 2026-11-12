//! Freeze-transition acceptance tests (draftable-entity ITEM-6/7, invariants INV-2/5/6).
//!
//! DEC-2 final: freezing a draft ENQUEUES the package's declared `draftable.freeze`
//! PRODUCER as a background run (create job → scheduler → sandbox → ingest); the draft
//! flips `frozen` + `frozen_artifact_id` when the run completes. The happy path therefore
//! needs BOTH:
//!   1. a **fixture producer package** declaring `draftable: { kind, freeze }` + a compute
//!      script that writes `/outputs` + `manifest.json` — installed here by
//!      [`install_test_widget_fixture`] (the `test-widget` package, kind `test/frozen-widget`),
//!      and
//!   2. the analysis **sandbox rootfs** — gated by [`rootfs_gate`].
//!
//! When both are present these run their real assertions; a self-skip (via `record_skip`,
//! NEVER a compile-time ignore attribute) fires only when the fixture cannot install OR the sandbox genuinely
//! cannot execute, and then it names the exact blocker. The
//! `freeze_without_a_declared_producer_is_422` test is runnable everywhere and pins the
//! freeze handler → producer-resolver 422 wiring end-to-end (using the still-UNregistered
//! `test/widget` kind).
//!
//! - TEST-17 [ITEM-6/7 + INV-6] freeze mints an immutable content-addressed `ready`
//!            artifact AND emits the DETACHED freeze-completion `Draft/update` sync.
//! - TEST-2  [INV-2] re-freeze after an edit mints a NEW artifact.
//! - TEST-5  [INV-5] re-freezing an unchanged frozen draft is a 200 no-op (same artifact,
//!            `freeze_job_id: null`, no second producer run).

use std::time::Duration;

use serde_json::json;

use super::*;
use crate::common::TestServer;
use crate::dataset::hardening_common::{record_skip, rootfs_gate};

/// The opaque `kind` the `test-widget` fixture declares a freeze producer for. Distinct
/// from the UNregistered `test/widget` the refusal tests use.
const WIDGET_KIND: &str = "test/frozen-widget";

/// POST the freeze; returns `(status, body)`. Accepted (202) + run in the background
/// (DEC-2), or an idempotent 200 no-op for an unchanged frozen draft, or 422 for a
/// missing producer.
async fn freeze(server: &TestServer, token: &str, draft_id: &str) -> (u16, serde_json::Value) {
    let resp = server
        .client
        .post(server.api_url(&format!("/drafts/{draft_id}/freeze")))
        .bearer_auth(token)
        .send()
        .await
        .expect("freeze");
    let status = resp.status().as_u16();
    let body = resp.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

/// Fetch a draft by id → its row.
async fn get_draft(server: &TestServer, token: &str, id: &str) -> serde_json::Value {
    server
        .client
        .get(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get draft")
        .json()
        .await
        .unwrap_or(serde_json::Value::Null)
}

/// POLL the draft until it reports `frozen` (or the budget elapses), returning the frozen
/// row. The freeze was already POSTed (202); this awaits the background producer run.
async fn wait_frozen(server: &TestServer, token: &str, id: &str) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let row = get_draft(server, token, id).await;
        if row["status"] == json!("frozen") {
            return row;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the background freeze did not reach `frozen` in time: {row}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// True when the freeze endpoint refused with the missing-producer 422 (the refusal test's
/// oracle). A runtime probe, not a suppression.
fn no_fixture_producer(status: u16, body: &serde_json::Value) -> bool {
    status == 422
        && body
            .get("error_code")
            .and_then(|c| c.as_str())
            .map(|c| c == "DRAFT_NOT_FREEZABLE" || c == "DRAFT_FREEZE_PRODUCER_MISSING")
            .unwrap_or(false)
}

/// Install the fixture + gate the sandbox. Returns `Ok((admin, alice, project))` ready for
/// a happy-path freeze, or `Err(reason)` — the caller `record_skip`s with the exact blocker.
async fn ready_env(server: &TestServer, test: &str) -> Result<(String, String, String), ()> {
    let admin = setup_admin(server).await;
    create_user(server, &admin, "alice", "alice@x.test").await;
    let alice = login(server, "alice").await;
    let project = create_project(server, &alice, "Atlas").await;

    if let Err(reason) = install_test_widget_fixture(server, &admin).await {
        record_skip(
            test,
            &format!("the test-widget freeze fixture did not install: {reason}"),
        );
        return Err(());
    }
    if rootfs_gate(server, &admin).await.is_none() {
        record_skip(
            test,
            "the analysis sandbox rootfs is not runnable here — the freeze transition runs a \
             producer through the sandbox. Point TXR_ENV_ROOTFS_SQUASHFS at a rootfs (and \
             ensure unprivileged userns + bwrap + squashfuse) to run it.",
        );
        return Err(());
    }
    Ok((admin, alice, project))
}

/// RUNNABLE HERE — freezing a draft whose opaque `kind` names no declared freeze producer
/// is a clean 422 (never a silent no-op). Uses the still-UNregistered `test/widget`.
#[tokio::test]
async fn freeze_without_a_declared_producer_is_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;
    // `test/widget` is a fictitious kind no package declares (the fixture uses
    // `test/frozen-widget`, so `test/widget` stays unregistered).
    let draft = create_draft(&server, &alice, &project, "test/widget", json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    let (status, body) = freeze(&server, &alice, &id).await;
    assert_eq!(
        status, 422,
        "freezing an undeclared kind is 422, not a no-op: {body}"
    );
    assert!(
        no_fixture_producer(status, &body),
        "the refusal names the missing producer: {body}"
    );
}

// ---- TEST-17 [ITEM-6/7 + INV-6]: freeze mints an immutable content-addressed artifact
// AND emits the DETACHED freeze-completion Draft/update ----
#[tokio::test]
async fn freeze_ingests_an_immutable_content_addressed_artifact() {
    use crate::common::sync_probe::SyncProbe;

    let server = TestServer::spawn().await;
    let Ok((_admin, alice, project)) = ready_env(&server, "TEST-17").await else {
        return;
    };
    let draft = create_draft(&server, &alice, &project, WIDGET_KIND, json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    // Open a second device to observe the DETACHED freeze-completion emit (INV-6).
    let mut probe = SyncProbe::open(&server, &alice).await;

    let (status, body) = freeze(&server, &alice, &id).await;
    assert_eq!(status, 202, "freeze accepted (background): {body}");
    assert!(
        body["freeze_job_id"].is_string(),
        "a real freeze enqueues a producer job: {body}"
    );

    let frozen = wait_frozen(&server, &alice, &id).await;
    assert_eq!(frozen["status"], json!("frozen"), "draft flips to frozen");
    assert!(
        frozen["frozen_artifact_id"].is_string(),
        "frozen_artifact_id links the minted immutable artifact: {frozen}"
    );

    // INV-6: the freeze COMPLETION emits a `Draft/update` to the project audience,
    // DETACHED (`origin=None`) — nobody clicked freeze on completion.
    probe
        .expect_event_for("draft", "update", &id, Duration::from_secs(15))
        .await;
}

// ---- TEST-2 [INV-2]: re-freeze after an edit mints a NEW artifact ----
#[tokio::test]
async fn refreeze_after_edit_mints_a_new_artifact() {
    let server = TestServer::spawn().await;
    let Ok((_admin, alice, project)) = ready_env(&server, "TEST-2").await else {
        return;
    };
    let draft = create_draft(&server, &alice, &project, WIDGET_KIND, json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    let (status, body) = freeze(&server, &alice, &id).await;
    assert_eq!(status, 202, "first freeze accepted: {body}");
    let frozen1 = wait_frozen(&server, &alice, &id).await;
    let art1 = frozen1["frozen_artifact_id"].as_str().unwrap().to_string();

    // Edit → flips back to open (DEC-3), and the payload changes so the producer forks
    // different bytes.
    let edited: serde_json::Value = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": {"n": 2} }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        edited["status"],
        json!("open"),
        "an edit re-opens a frozen draft (DEC-3): {edited}"
    );

    // Re-freeze → a NEW artifact id (the first artifact's bytes are never mutated).
    let (s2, b2) = freeze(&server, &alice, &id).await;
    assert_eq!(s2, 202, "re-freeze accepted: {b2}");
    let frozen2 = wait_frozen(&server, &alice, &id).await;
    let art2 = frozen2["frozen_artifact_id"].as_str().unwrap().to_string();
    assert_ne!(
        art1, art2,
        "a post-edit freeze forks a NEW immutable artifact (INV-2)"
    );
}

// ---- TEST-5 [INV-5]: re-freezing an unchanged frozen draft is a 200 no-op ----
#[tokio::test]
async fn refreeze_unchanged_is_idempotent() {
    let server = TestServer::spawn().await;
    let Ok((_admin, alice, project)) = ready_env(&server, "TEST-5").await else {
        return;
    };
    let draft = create_draft(&server, &alice, &project, WIDGET_KIND, json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    let (status, body) = freeze(&server, &alice, &id).await;
    assert_eq!(status, 202, "first freeze accepted: {body}");
    let frozen1 = wait_frozen(&server, &alice, &id).await;
    let art1 = frozen1["frozen_artifact_id"].as_str().unwrap().to_string();

    // Freeze again with NO edit → the handler short-circuits: 200 with `freeze_job_id:null`
    // and the SAME artifact, NO second producer run (INV-5 idempotent). Asserted directly
    // on the 200 body.
    let (s2, b2) = freeze(&server, &alice, &id).await;
    assert_eq!(
        s2, 200,
        "an unchanged frozen re-freeze is a 200 no-op: {b2}"
    );
    assert_eq!(
        b2["freeze_job_id"],
        json!(null),
        "the idempotent no-op enqueues no producer job: {b2}"
    );
    assert_eq!(
        b2["draft"]["frozen_artifact_id"].as_str().unwrap(),
        art1,
        "re-freezing an unchanged frozen draft returns the existing artifact (INV-5)"
    );
}

// TEST-4 [INV-4] (auto-freeze-on-consume) lives in `auto_freeze_on_consume_test.rs` — its
// REFUSAL/WIRING half runs everywhere; its PIN + RERUN-REPLAY half uses the same fixture +
// rootfs gate as the tests above.
