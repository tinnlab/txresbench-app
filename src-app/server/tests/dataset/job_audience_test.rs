//! A job reaching a TERMINAL state tells the DATASET's audience — not the job's owner.
//!
//! ## Why one user could never have caught this
//!
//! A dataset's `processing_status` is DERIVED from its job's row, so a job flipping
//! terminal changes what `GET /datasets/{id}` returns with no write to `datasets` at
//! all. `publish_dataset_after_terminal` announced that change to
//! `Audience::owner(job.owner_id)` — the JOB's owner.
//!
//! "Whose job is this" and "whose dataset is this" are both a `Uuid`, and they are the
//! SAME `Uuid` whenever a user processes their own dataset — which is every
//! single-user test in this suite. They diverge through one endpoint:
//! `POST /datasets/{id}/process` is gated by `require_can_edit` (owner ∪ `edit`-role
//! sharee) but stamps `auth.user.id` as `jobs.owner_id`. `tests/dataset/authz_test.rs`
//! already asserts "edit sharee CAN process (job enqueued)" → 201, so this is not a
//! hypothetical path; it is a tested, supported one.
//!
//! On it, the dataset's OWNER was told nothing. Their dataset's badge read
//! "Processing" until they manually reloaded — and no other sharee was told either.
//!
//! ## The product question: should a sharee learn that someone ELSE's job touched
//! a dataset shared with them?
//!
//! Yes, and the alternative is worse than it first looks. A sharee with the dataset
//! open has exactly two possible experiences: the row changes under them, or it does
//! not change and they are looking at something false. There is no third option where
//! withholding the frame keeps them correctly informed — silence here does not mean
//! "nothing happened", it means "you are shown a stale status indefinitely".
//!
//! And nothing is disclosed by telling them. The wire is notify-and-refetch: the
//! frame is `{entity: dataset, action: update, id}` and carries no job, no actor, no
//! row data. The sharee learns only that a dataset they are ALREADY authorized to
//! read has changed — which they could learn at any moment by pressing reload — and
//! then refetches it through the same permission-checked endpoint as always. Whose
//! job caused it is not on the wire.
//!
//! So the audience is the dataset's own: owner ∪ sharees, exactly like every other
//! `sync:dataset` frame. `dataset/integration.rs` already resolved it that way on an
//! ADJACENT leg of the same job completion, which is the tell — two sibling paths in
//! one finalize disagreed about who to tell.

use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

use super::{create_user, login, setup_admin};
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

const WAIT: Duration = Duration::from_secs(10);
/// Long enough that a frame the server DID send would have arrived (the fan-out is
/// synchronous and in-process, and every positive assertion here resolves well inside
/// this budget), short enough that the suite does not crawl.
const SILENCE: Duration = Duration::from_secs(2);

/// A processor run needs a dataset with ≥1 file, so upload one rather than using the
/// file-less `create_dataset`. The payload is deliberately domain-free — nothing here
/// reads it; it exists only so the dataset is non-empty enough to enqueue.
async fn upload_one(server: &TestServer, token: &str, filename: &str) -> String {
    let form = Form::new().part(
        "file",
        Part::bytes(b"col_a,col_b\nrow_1,3\n".to_vec()).file_name(filename.to_string()),
    );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload");
    assert_eq!(resp.status().as_u16(), 200, "upload succeeds");
    let body: Value = resp.json().await.expect("upload json");
    body["datasets"][0]["id"]
        .as_str()
        .expect("dataset id")
        .to_string()
}

async fn share_with(server: &TestServer, owner: &str, ds: &str, principal_id: &str, role: &str) {
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(owner)
        .json(&json!({ "principal_type": "user", "principal_id": principal_id, "role": role }))
        .send()
        .await
        .expect("share dataset");
    let s = resp.status().as_u16();
    assert!(s == 200 || s == 201, "share with role {role} → {s}");
}

/// One dataset owned by `owner`, shared `edit` with `editor` and `view` with `viewer`.
/// Returns `(admin_token, owner_token, editor_token, viewer_token, dataset_id)`.
///
/// The admin token is RETURNED rather than re-derived: `POST /app/setup/admin` is
/// first-run-only and answers 403 once an admin exists, so a second `setup_admin`
/// call in the test body fails the fixture rather than the assertion.
async fn owner_editor_viewer(server: &TestServer) -> (String, String, String, String, String) {
    let admin = setup_admin(server).await;
    create_user(server, &admin, "jaowner", "jaowner@x.test").await;
    let owner = login(server, "jaowner").await;
    let editor_id = create_user(server, &admin, "jaeditor", "jaeditor@x.test").await;
    let editor = login(server, "jaeditor").await;
    let viewer_id = create_user(server, &admin, "javiewer", "javiewer@x.test").await;
    let viewer = login(server, "javiewer").await;

    let ds = upload_one(server, &owner, "ja.csv").await;
    share_with(server, &owner, &ds, &editor_id, "edit").await;
    share_with(server, &owner, &ds, &viewer_id, "view").await;
    (admin, owner, editor, viewer, ds)
}

/// Pin the global concurrency cap at 1 and burn the slot with a long-running stub job
/// owned by `token`, so the NEXT job created is guaranteed to sit `queued` and can be
/// driven to a terminal state deterministically by cancelling it — no processor
/// sandbox, no timing race. (Same device as `jobs/stop_sync_test.rs`.)
async fn hold_the_only_slot(server: &TestServer, admin: &str, token: &str) {
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(admin)
        .json(&json!({ "max_concurrent_jobs": 1 }))
        .send()
        .await
        .expect("put job settings");
    assert_eq!(put.status().as_u16(), 200, "admin set concurrency=1");

    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&json!({ "job_type": "stub", "name": "holds-the-slot", "params": { "steps": 60 } }))
        .send()
        .await
        .expect("create holding job");
    assert_eq!(resp.status().as_u16(), 201, "holding job created");
}

/// The editor launches a run on the OWNER's dataset, and it is cancelled — the
/// terminal transition (`mark_stopped` → `publish_dataset_after_terminal`).
/// Returns the process job's id.
async fn process_then_stop(server: &TestServer, editor: &str, ds: &str) -> String {
    let proc = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/process")))
        .bearer_auth(editor)
        .json(&json!({ "spec": { "language": "python", "script": "print('qc')" } }))
        .send()
        .await
        .expect("editor processes the owner's dataset");
    assert_eq!(
        proc.status().as_u16(),
        201,
        "an edit-role sharee may process a dataset they do not own"
    );
    let body: Value = proc.json().await.expect("process json");
    let job_id = body["id"]
        .as_str()
        .or_else(|| body["job"]["id"].as_str())
        .or_else(|| body["job_id"].as_str())
        .expect("process job id")
        .to_string();

    let stop = server
        .client
        .post(server.api_url(&format!("/jobs/{job_id}/stop")))
        .bearer_auth(editor)
        .send()
        .await
        .expect("stop the queued job");
    assert_eq!(
        stop.status().as_u16(),
        200,
        "the job's own owner may cancel it"
    );
    job_id
}

// ─────────────────────── the bug: the owner is never told ───────────────────────

/// THE regression. The dataset's OWNER learns their dataset's processing finished,
/// when somebody ELSE's job did the processing.
#[tokio::test]
async fn a_sharees_run_reaching_terminal_tells_the_dataset_owner() {
    let server = TestServer::spawn().await;
    let (admin, owner, editor, _viewer, ds) = owner_editor_viewer(&server).await;
    hold_the_only_slot(&server, &admin, &editor).await;

    // The OWNER's stream, opened before the collaborator acts.
    let mut owner_probe = SyncProbe::open(&server, &owner).await;

    process_then_stop(&server, &editor, &ds).await;

    let f = owner_probe.expect_event("dataset", "update", WAIT).await;
    assert_eq!(
        f.id, ds,
        "the frame names the DATASET whose processing status changed"
    );
}

/// The job's own owner — an `edit` sharee who is NOT the dataset owner — is still in
/// the audience. This is the mutant-killer for "just swap `job.owner_id` for
/// `dataset.owner_id`": that would fix the test above and silently break the person
/// who actually pressed the button.
#[tokio::test]
async fn the_acting_sharee_is_still_told() {
    let server = TestServer::spawn().await;
    let (admin, _owner, editor, _viewer, ds) = owner_editor_viewer(&server).await;
    hold_the_only_slot(&server, &admin, &editor).await;

    let mut editor_probe = SyncProbe::open(&server, &editor).await;
    process_then_stop(&server, &editor, &ds).await;

    let f = editor_probe
        .expect_event_for("dataset", "update", &ds, WAIT)
        .await;
    assert_eq!(f.id, ds);
}

/// A `view`-role sharee, who neither owns the dataset nor launched the job, is told
/// too — the product decision this file argues in its header. They are rendering the
/// dataset; silence would leave them reading a status that is no longer true.
#[tokio::test]
async fn a_view_sharee_who_did_nothing_is_told() {
    let server = TestServer::spawn().await;
    let (admin, _owner, editor, viewer, ds) = owner_editor_viewer(&server).await;
    hold_the_only_slot(&server, &admin, &editor).await;

    let mut viewer_probe = SyncProbe::open(&server, &viewer).await;
    process_then_stop(&server, &editor, &ds).await;

    let f = viewer_probe
        .expect_event_for("dataset", "update", &ds, WAIT)
        .await;
    assert_eq!(f.id, ds);
}

// ─────────────────────────────── wire parity ───────────────────────────────
//
// The assertions above prove each party is REACHED. They cannot see a frame carrying
// the wrong action, an id naming the JOB instead of the dataset, or a second frame
// nobody asked for. This block pins the exact set the terminal transition publishes to
// the dataset's owner, so those mutants die here rather than passing as "it refetched".

/// The owner's stream receives, for one terminal transition, EXACTLY: a `job/create`
/// when the collaborator enqueues, then `dataset/update` naming the dataset and
/// `job/update` naming the job — and nothing else.
///
/// **This test used to assert the opposite of its last claim, and it was right to at
/// the time.** It ended `// The owner does not own the JOB, so no job frame is theirs
/// either` + `expect_silence` — a true statement about a system where `GET /jobs` was
/// job-owner scoped, so a `job` frame would have told the owner to refetch a row they
/// could not read. `fix/job-visibility` made that row readable (the dataset owner is a
/// principal for a job running on their data), and the instant it did, the silence
/// this test pinned became the defect: a row you can list but are never told about
/// sits stale until a manual reload. So the frame set widened, and the assertion
/// widened with it — it is still an EXACT set, which is the property worth keeping.
///
/// The two `update` frames are collected with one order-independent matcher rather
/// than two ordered waits: `dataset/update` is published inside `mark_stopped` while
/// `job/update` is published from a spawned task, so their arrival order is likely but
/// not guaranteed, and a test that encodes "likely" is a flake waiting for a busy box.
#[tokio::test]
async fn owner_wire_parity_for_a_terminal_transition() {
    let server = TestServer::spawn().await;
    let (admin, owner, editor, _viewer, ds) = owner_editor_viewer(&server).await;
    hold_the_only_slot(&server, &admin, &editor).await;

    let mut owner_probe = SyncProbe::open(&server, &owner).await;
    let job_id = process_then_stop(&server, &editor, &ds).await;

    // The enqueue leg. Safe to await first: the test itself only issues the stop after
    // `/process` has returned, so no stop-phase frame can precede this one.
    let c = owner_probe
        .expect_event_for("job", "create", &job_id, WAIT)
        .await;
    assert_eq!(
        (c.entity.as_str(), c.action.as_str()),
        ("job", "create"),
        "the dataset owner is told a job APPEARED on their dataset"
    );

    // The terminal leg: exactly {dataset/update(ds), job/update(job_id)}, either order.
    let mut updates = vec![];
    for _ in 0..2 {
        let f = owner_probe
            .expect_event_any(&["dataset", "job"], "update", WAIT)
            .await;
        updates.push((f.entity, f.id));
    }
    updates.sort();
    let mut expected = vec![
        ("dataset".to_string(), ds.clone()),
        ("job".to_string(), job_id.clone()),
    ];
    expected.sort();
    assert_eq!(
        updates, expected,
        "the terminal transition publishes the DATASET's change and the JOB's, each \
         naming its own id — a `dataset` frame carrying the job's id (or a duplicate \
         of either) fails here rather than passing as 'it refetched'"
    );
    assert_ne!(ds, job_id, "fixture sanity: the two ids are distinct");

    // Nothing further: widening the audience must not have widened the frame SET.
    owner_probe.expect_silence(SILENCE).await;
}

/// A user who neither owns the dataset nor is shared into it hears nothing — the
/// positive control proving the probes above only receive what they should, and that
/// widening the audience to sharees did not widen it to everyone.
#[tokio::test]
async fn a_stranger_hears_nothing() {
    let server = TestServer::spawn().await;
    let (admin, _owner, editor, _viewer, ds) = owner_editor_viewer(&server).await;
    create_user(&server, &admin, "jastranger", "jastranger@x.test").await;
    let stranger = login(&server, "jastranger").await;
    hold_the_only_slot(&server, &admin, &editor).await;

    let mut stranger_probe = SyncProbe::open(&server, &stranger).await;
    process_then_stop(&server, &editor, &ds).await;

    stranger_probe.expect_silence(SILENCE).await;
}
