//! TEST-24 — recording a selection emits an owner-scoped `sync:provenance` frame
//! on the owner's `/api/sync/subscribe` stream (the full mount → publish →
//! deliver path). Asserted via the real SSE stream (the established sync-probe).

use std::time::Duration;

use super::*;

/// Read an open SSE response until `needle` appears (or overall timeout).
async fn read_until(resp: &mut reqwest::Response, needle: &str, overall: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + overall;
    let mut buf = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, resp.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if buf.contains(needle) {
                    return true;
                }
            }
            _ => return false,
        }
    }
}

#[tokio::test]
async fn recording_a_selection_emits_provenance_sync_frame() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "sync project").await;

    // Open the owner's SSE stream; drain the handshake.
    let mut stream = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&admin)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .expect("subscribe");
    assert_eq!(stream.status().as_u16(), 200);
    assert!(
        read_until(&mut stream, "connected", Duration::from_secs(5)).await,
        "handshake received"
    );

    // Record a selection from a SEPARATE client (so the stream keeps reading).
    let client2 = reqwest::Client::new();
    let resp = client2
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(&admin)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": root_id,
            "recipe": column_recipe("3"),
            "label": null,
        }))
        .send()
        .await
        .expect("record selection");
    assert_eq!(resp.status().as_u16(), 201);

    // The owner's stream receives a structurally-correct `provenance` sync frame
    // — matching the exact `{"entity":"provenance",…}` wire field, not a bare
    // substring that could match elsewhere in the SSE bytes.
    assert!(
        read_until(
            &mut stream,
            "\"entity\":\"provenance\"",
            Duration::from_secs(5)
        )
        .await,
        "the owner's stream receives the provenance sync frame (entity=provenance)"
    );
}

/// A project EDITOR's capture reaches the project OWNER.
///
/// The test above is the one that let this ship: the owner records, so a frame
/// addressed to `auth.user.id` and a frame addressed to the project's audience are
/// the same frame. `record_selection`/`record_action` are gated by
/// `require_project_edit`, so a shared EDITOR reaches them — and the emit went to
/// `Audience::owner(auth.user.id)`, i.e. the actor alone. The runs list the client
/// refetches is scoped by `project_id`, so the owner's graph silently stopped
/// tracking what their collaborators recorded in it.
///
/// The fix resolves the same `project_audience` (owner ∪ accepted recipients) the
/// workstore artifact emit already resolves; this asserts it from the OWNER's side.
#[tokio::test]
async fn an_editors_capture_reaches_the_project_owner() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "shared capture").await;
    let editor = shared_collaborator(&server, &admin, project_id, "capture_editor", "editor").await;

    // The OWNER's stream, opened before the collaborator acts.
    let mut owner_probe = crate::common::sync_probe::SyncProbe::open(&server, &admin).await;

    let resp = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(&editor)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": root_id,
            "recipe": column_recipe("7"),
            "label": null,
        }))
        .send()
        .await
        .expect("editor records a selection");
    assert_eq!(resp.status().as_u16(), 201, "an editor may record");
    let run_id = resp.json::<serde_json::Value>().await.expect("run json")["run_id"]
        .as_str()
        .expect("run id")
        .to_string();

    let f = owner_probe
        .expect_event("provenance", "create", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, run_id, "the frame names the run the editor recorded");
}

// ───────────────────── the `provenance` id vocabulary ─────────────────────
//
// `{entity, action, id}` is the WHOLE wire payload, so a subscriber can only act on
// `id` if the entity fixes its meaning. `sync:provenance` had TWO: a capture sent the
// RUN id, and building an export sent the PROJECT id on the same entity — so a client
// receiving `{entity: provenance, id: X}` could not tell which kind of row `X` named,
// and nothing in the frame let it find out.
//
// The rule this app follows everywhere else is that `id` is the primary key of a row
// of the type the entity NAMES (a settings singleton uses `Uuid::nil()`). These tests
// pin `provenance` = the run id, from BOTH sides: the id must resolve as a run, and
// the site that used to send a project id must now send nothing at all.

const SILENCE: Duration = Duration::from_secs(2);

/// The id on a `sync:provenance` frame RESOLVES AS A RUN.
///
/// Deliberately asserted by dereferencing the id through `GET /provenance/runs/{id}`
/// rather than by comparing it to a value the test already holds. A string equality
/// pins the id to whatever the handler happens to send; fetching it pins the id to
/// what it MEANS. Swap the publish back to `project_id` and this fails at the fetch —
/// a project id is not a run id, so the endpoint 404s — which is the same failure a
/// real subscriber would suffer, rather than a bare assert-not-equal.
#[tokio::test]
async fn the_provenance_frame_id_names_a_run_and_resolves_as_one() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "id vocabulary").await;

    let mut probe = crate::common::sync_probe::SyncProbe::open(&server, &admin).await;

    let resp = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(&admin)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": root_id,
            "recipe": column_recipe("11"),
            "label": null,
        }))
        .send()
        .await
        .expect("record selection");
    assert_eq!(resp.status().as_u16(), 201);

    let f = probe
        .expect_event("provenance", "create", Duration::from_secs(5))
        .await;

    // The id dereferences as a RUN.
    let run = server
        .client
        .get(server.api_url(&format!("/provenance/runs/{}", f.id)))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("fetch the run the frame names");
    assert_eq!(
        run.status().as_u16(),
        200,
        "the id on a `provenance` frame must resolve through GET /provenance/runs/{{id}}"
    );
    let body: serde_json::Value = run.json().await.expect("run json");
    assert_eq!(
        body["run_id"].as_str(),
        Some(f.id.as_str()),
        "the run fetched by the frame's id IS that run"
    );

    // And it is emphatically not the project — the other meaning the entity carried.
    assert_ne!(
        f.id,
        project_id.to_string(),
        "`provenance` ids name runs; a project-wide event needs its own entity"
    );
}

/// Building an export publishes NOTHING.
///
/// It used to publish `provenance/update` carrying the PROJECT id — the second id
/// meaning. Deleted rather than corrected, because `build_bundle` mutates no row:
/// the bundle is an in-memory record consumed by the first authorized download, with
/// no list endpoint and no surface that renders it, so there is no id the frame could
/// correctly carry. It was not even inert — sent with `origin: None` it was NOT
/// suppressed for the acting connection, so the actor's own tab refetched the runs
/// list and the graph, neither of which an export changes.
///
/// The export must still SUCCEED; silence is the assertion, so a mutant that simply
/// breaks the endpoint cannot pass by emitting nothing.
#[tokio::test]
async fn building_an_export_publishes_nothing() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "export silence").await;

    // Record first, and CONSUME that frame, so the silence below is attributable to
    // the export alone rather than to an empty project.
    let rec = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(&admin)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": root_id,
            "recipe": column_recipe("13"),
            "label": null,
        }))
        .send()
        .await
        .expect("record selection");
    assert_eq!(rec.status().as_u16(), 201);

    let mut probe = crate::common::sync_probe::SyncProbe::open(&server, &admin).await;

    let export = server
        .client
        .post(server.api_url("/provenance/export"))
        .bearer_auth(&admin)
        .json(&json!({ "project_id": project_id, "target": null, "scope": "project" }))
        .send()
        .await
        .expect("build export");
    assert_eq!(
        export.status().as_u16(),
        200,
        "the export itself must still succeed — silence is the assertion, not failure"
    );
    let body: serde_json::Value = export.json().await.expect("export json");
    assert!(
        body["export_id"].as_str().is_some(),
        "a built export still returns its id in the RESPONSE, which is how the client \
         downloads it — no sync frame was ever needed for that"
    );

    probe.expect_silence(SILENCE).await;
}
