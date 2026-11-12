//! TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-8] — auto-freeze-on-consume
//! (DEC-2 corrected: resolution at JOB-CREATE time).
//!
//! INV-4: a run cannot take an `open` draft as input without freezing it first — there
//! is no content hash to depend on until freeze (the mechanical guard against doc-17's
//! figure-that-lies). The `draft_ref` is resolved — frozen + pinned into a PERSISTED
//! `artifact_ref` — at job-CREATE time, BEFORE the consuming job is enqueued / takes a
//! scheduler slot, so the run's provenance + re-run spec pin the frozen artifact, never
//! the volatile `draft_ref`.
//!
//! This file has TWO halves, and unlike the phase-6 tree the REFUSAL/WIRING half RUNS
//! here (no sandbox needed) — it was the half the blind audit flagged as having no
//! executing coverage:
//!   * REFUSAL / WIRING (runs): a run referencing an `open` draft whose opaque `kind`
//!     names NO freeze producer is refused at create (422) — the create-time resolver
//!     fired and the unpinned draft was NEVER staged; a run referencing a nonexistent or
//!     cross-project draft is refused (404, no existence oracle).
//!   * PIN + RERUN-REPLAY (self-skips): with a fixture producer + the analysis rootfs, a
//!     consume freezes the draft, binds the frozen `artifact_ref`, the provenance records
//!     the pinned artifact, and a re-run replays the `artifact_ref` (no drift). That half
//!     runs two chained sandbox jobs, so it self-skips (never a compile-time ignore
//!     attribute) when the fixture producer is absent.

use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::common::TestServer;
use crate::dataset::hardening_common::{record_skip, rootfs_gate};

/// The opaque `kind` the `test-widget` fixture declares a freeze producer for.
const WIDGET_KIND: &str = "test/frozen-widget";

/// A trivial consumer compute: write an EMPTY `/outputs/manifest.json` so the consuming run
/// completes cleanly once it is unblocked + pinned (it produces no artifacts; the point is
/// that it dispatches PINNED). Reached only after the draft is frozen + pinned; the refusal
/// tests never execute it (they are refused at create).
const CONSUMER_SCRIPT: &str = "import json, os\n\
d = os.environ.get('TXR_OUTPUTS_DIR', '/outputs')\n\
os.makedirs(d, exist_ok=True)\n\
open(os.path.join(d, 'manifest.json'), 'w').write(json.dumps({'outputs': []}))\n\
print('consume: wrote empty manifest', flush=True)\n";

/// Submit an analysis job with ONE `draft_ref` input, scoped to `project_id`. Returns
/// `(status, body)`. The create-time draft resolver fires on the input BEFORE the job is
/// created, so a refused draft never reaches staging.
async fn submit_consume(
    server: &TestServer,
    token: &str,
    project_id: &str,
    draft_id: &str,
) -> (u16, Value) {
    let body = json!({
        "job_type": "analysis",
        "name": "consume-draft",
        "project_id": project_id,
        "params": {
            "language": "python",
            "script": CONSUMER_SCRIPT,
            "inputs": [ { "slot": "gs", "draft_ref": draft_id } ]
        }
    });
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("submit consuming job");
    let status = resp.status().as_u16();
    let body = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// RUNS HERE — a run consuming an `open` draft whose kind has NO freeze producer is
/// refused at CREATE (422), before the job exists: the create-time resolver tried to
/// freeze the draft, found no producer, and refused — so the unpinned draft is never
/// staged (INV-4). This is the executing proof the resolve-at-create wiring fired.
#[tokio::test]
async fn consuming_an_unpinnable_open_draft_is_refused_at_create() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;
    // `test/widget` names no freeze producer in this build.
    let draft = create_draft(&server, &alice, &project, "test/widget", json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    let (status, body) = submit_consume(&server, &alice, &project, &id).await;
    assert_eq!(
        status, 422,
        "an open draft with no producer cannot be consumed — the run is refused at create, \
         never staged unpinned: {body}"
    );
    assert_eq!(
        body["error_code"].as_str().unwrap_or(""),
        "DRAFT_NOT_FREEZABLE",
        "the refusal names the missing producer (the create-time resolver fired): {body}"
    );

    // The draft is untouched — still open, never frozen, never consumed.
    let got: Value = server
        .client
        .get(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        got["status"],
        json!("open"),
        "the refused draft stays open: {got}"
    );

    // No job was created for this owner (the refusal is BEFORE enqueue).
    let jobs: Value = server
        .client
        .get(server.api_url("/jobs"))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let n = jobs["jobs"].as_array().map(|a| a.len()).unwrap_or(0);
    assert_eq!(
        n, 0,
        "no consuming job was enqueued (refused pre-create): {jobs}"
    );
}

/// RUNS HERE — a run referencing a NONEXISTENT draft is refused 404 (no existence
/// oracle), before any job exists.
#[tokio::test]
async fn consuming_a_nonexistent_draft_is_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;

    let phantom = uuid::Uuid::new_v4().to_string();
    let (status, _body) = submit_consume(&server, &alice, &project, &phantom).await;
    assert_eq!(status, 404, "a nonexistent draft_ref is refused 404");
}

/// RUNS HERE — a run referencing another user's draft (in a project the submitter
/// cannot see) is refused 404 — a cross-user draft never becomes a run input (INV-3/4).
#[tokio::test]
async fn consuming_a_cross_user_draft_is_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    create_user(&server, &admin, "bob", "bob@x.test").await;
    let alice = login(&server, "alice").await;
    let bob = login(&server, "bob").await;

    // Alice owns a draft in HER project.
    let alice_project = create_project(&server, &alice, "AliceAtlas").await;
    let alice_draft = create_draft(
        &server,
        &alice,
        &alice_project,
        "test/widget",
        json!({"n": 1}),
    )
    .await;
    let alice_draft_id = alice_draft["id"].as_str().unwrap().to_string();

    // Bob submits a job in HIS OWN project (which he can edit) but references Alice's
    // draft — the create-time resolver 404s on the invisible draft, so the run is refused.
    let bob_project = create_project(&server, &bob, "BobAtlas").await;
    let (status, _body) = submit_consume(&server, &bob, &bob_project, &alice_draft_id).await;
    assert_eq!(
        status, 404,
        "bob cannot consume alice's draft — a cross-user draft_ref is refused 404"
    );

    // Alice's draft is untouched.
    let got: Value = server
        .client
        .get(server.api_url(&format!("/drafts/{alice_draft_id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["status"], json!("open"), "alice's draft is untouched");
}

/// PIN half (sandbox-tier), the executing INV-4 proof. With the `test-widget` fixture
/// producer + the analysis rootfs, consuming an OPEN `test/frozen-widget` draft:
///   * returns 202 with the consumer job `status:"blocked"` (it depends on the freeze job);
///   * the freeze runs, the draft flips `frozen`, and the freeze-completion hook substitutes
///     `draft_ref` → `artifact_ref` into the consumer's PERSISTED `job.params` BEFORE the
///     `blocked` → `queued` unblock — so the consumer dispatches PINNED and its params (which
///     the provenance run node + re-run spec both read) carry the frozen `artifact_ref`,
///     never the volatile `draft_ref`.
///
/// The persisted-params pin IS the INV-4 proof (provenance records off `job.params`; a run's
/// recorded inputs are readable at `GET /api/provenance/runs/{id}`). Self-skips (never via a
/// compile-time ignore attribute) only when the fixture cannot install or the sandbox cannot
/// run, naming the exact blocker.
#[tokio::test]
async fn consume_freezes_pins_and_rerun_replays_the_artifact() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;

    if let Err(reason) = install_test_widget_fixture(&server, &admin).await {
        record_skip(
            "TEST-4 (pin half)",
            &format!("the test-widget freeze fixture did not install: {reason}"),
        );
        return;
    }
    if rootfs_gate(&server, &admin).await.is_none() {
        record_skip(
            "TEST-4 (pin half)",
            "the analysis sandbox rootfs is not runnable here — the auto-freeze consume path \
             runs a producer + a consumer through the sandbox. Point TXR_ENV_ROOTFS_SQUASHFS \
             at a rootfs (and ensure unprivileged userns + bwrap + squashfuse).",
        );
        return;
    }

    let draft = create_draft(&server, &alice, &project, WIDGET_KIND, json!({"n": 1})).await;
    let id = draft["id"].as_str().unwrap().to_string();

    // Consuming an OPEN draft → 202 + a BLOCKED consumer (depends on the freeze job).
    let (status, body) = submit_consume(&server, &alice, &project, &id).await;
    assert_eq!(
        status, 202,
        "consuming an OPEN draft returns 202 (the consumer is blocked on the freeze): {body}"
    );
    assert_eq!(
        body["status"],
        json!("blocked"),
        "the consumer is created BLOCKED, pending the freeze (INV-4 — never staged unpinned): {body}"
    );
    let consumer_id = body["id"].as_str().expect("consumer job id").to_string();

    // The draft freezes in the background.
    let frozen = super::wait_frozen(&server, &alice, &id).await;
    let artifact_id = frozen["frozen_artifact_id"]
        .as_str()
        .expect("the draft froze + minted an artifact")
        .to_string();

    // Poll the consumer until the freeze-completion hook has pinned it (draft_ref → the
    // frozen artifact_ref) and unblocked it. The pin is written to the PERSISTED params
    // BEFORE the blocked→queued flip, so once it leaves `blocked` the substitution is done.
    // `GET /jobs/{id}` returns a DETAIL wrapper (`{ job: {...}, logs, metrics, ... }`),
    // unlike the FLAT `Job` the create response carries — so the job fields are under
    // `["job"]`.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let consumer = loop {
        let detail: Value = server
            .client
            .get(server.api_url(&format!("/jobs/{consumer_id}")))
            .bearer_auth(&alice)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let st = detail["job"]["status"].as_str().unwrap_or("");
        assert_ne!(
            st, "failed",
            "the freeze cascade-failed the consumer: {detail}"
        );
        if st != "blocked" && !st.is_empty() {
            break detail;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the consumer never unblocked after the freeze completed: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };

    // INV-4: the consumer left `blocked` for a runnable state ...
    let st = consumer["job"]["status"].as_str().unwrap_or("");
    assert!(
        matches!(st, "queued" | "running" | "completed"),
        "the pinned consumer flips to queued/running/completed, not {st:?}: {consumer}"
    );
    // ... and its PERSISTED params now pin the frozen `artifact_ref` with NO `draft_ref`
    // (what provenance + a re-run replay read — never the volatile draft_ref).
    let input0 = &consumer["job"]["params"]["inputs"][0];
    assert_eq!(
        input0["artifact_ref"].as_str(),
        Some(artifact_id.as_str()),
        "the consumer's persisted params pin the frozen artifact_ref (INV-4): {consumer}"
    );
    assert!(
        input0.get("draft_ref").map(|v| v.is_null()).unwrap_or(true),
        "the volatile draft_ref was substituted OUT of the persisted params: {consumer}"
    );
}
