//! Round-3 concurrency-edge regressions (draftable-entity, phase-7 round 3) — the three
//! defects the round-3 blind re-audit confirmed in the async job-dependency auto-freeze.
//! Each ships a test that FAILS before its fix:
//!
//!   * HIGH   multi-dependency lost-update — a consumer with TWO open-draft inputs whose
//!            two freeze producers complete (concurrently) must land BOTH pins; before the
//!            fix the second completion's snapshot clobbered the first's pin, leaving one
//!            `draft_ref` unresolved. [`two_open_draft_inputs_both_pinned`]
//!   * MEDIUM create-after-complete race — a consumer BORN depending on an ALREADY-
//!            `completed` freeze still gets its `artifact_ref` pinned (the freeze's
//!            completion hook ran before the consumer's edge existed, so it found no
//!            dependent). [`consumer_born_on_a_completed_freeze_is_pinned`]
//!   * MEDIUM content-blind dedup — a draft edited mid-freeze makes a new consumer freeze
//!            the NEW content instead of reusing the stale in-flight freeze.
//!            [`editing_a_draft_mid_freeze_freezes_the_new_content`]
//!
//! All three run the real freeze producer through the sandbox, so they self-skip (via
//! `record_skip`, never a compile-time ignore attribute) when the fixture producer or the analysis rootfs is
//! absent, naming the blocker. Point `CYTO_ENV_ROOTFS_SQUASHFS` at a rootfs to execute.

use std::collections::HashSet;
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::models::CreateJobRequest;
use cytoanalyst::modules::jobs::repository::JobRepository;

use super::*;
use crate::common::TestServer;
use crate::dataset::hardening_common::{record_skip, rootfs_gate};

const WIDGET_KIND: &str = "test/frozen-widget";

/// A trivial consumer compute: write an EMPTY `/outputs/manifest.json` so the consuming
/// run completes cleanly once unblocked + pinned (it produces no artifacts; the point is
/// that it dispatches PINNED). Never reached by the assertions here — they read the
/// consumer's PERSISTED params, not its outputs.
const CONSUMER_SCRIPT: &str = "import json, os\n\
d = os.environ.get('CYTO_OUTPUTS_DIR', '/outputs')\n\
os.makedirs(d, exist_ok=True)\n\
open(os.path.join(d, 'manifest.json'), 'w').write(json.dumps({'outputs': []}))\n\
print('consume: wrote empty manifest', flush=True)\n";

/// Submit an analysis job whose inputs each reference one of `draft_ids`. Returns
/// `(status, body)`.
async fn submit_consume_multi(
    server: &TestServer,
    token: &str,
    project_id: &str,
    draft_ids: &[&str],
) -> (u16, Value) {
    let inputs: Vec<Value> = draft_ids
        .iter()
        .enumerate()
        .map(|(i, d)| json!({ "slot": format!("gs{i}"), "draft_ref": d }))
        .collect();
    let body = json!({
        "job_type": "analysis",
        "name": "consume-draft",
        "project_id": project_id,
        "params": { "language": "python", "script": CONSUMER_SCRIPT, "inputs": inputs }
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

/// POST `/drafts/{id}/freeze`; returns `(status, body)`.
async fn freeze(server: &TestServer, token: &str, draft_id: &str) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url(&format!("/drafts/{draft_id}/freeze")))
        .bearer_auth(token)
        .send()
        .await
        .expect("freeze");
    (
        resp.status().as_u16(),
        resp.json().await.unwrap_or(Value::Null),
    )
}

/// Poll `GET /jobs/{id}` until the consumer leaves `blocked` (its freeze-completion hook
/// has pinned + unblocked it), failing loudly if it cascade-fails. Returns the detail
/// wrapper (`{ job: {...}, ... }`).
async fn wait_consumer_unblocked(server: &TestServer, token: &str, consumer_id: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let detail: Value = server
            .client
            .get(server.api_url(&format!("/jobs/{consumer_id}")))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let st = detail["job"]["status"].as_str().unwrap_or("");
        assert_ne!(st, "failed", "the consumer cascade-failed: {detail}");
        if st != "blocked" && !st.is_empty() {
            return detail;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the consumer never unblocked after its freezes completed: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Fixture + rootfs gate shared by all three tests. `Ok((admin, alice_id, alice, project))`
/// when the freeze path can execute; `Err(())` after a precise `record_skip`.
async fn ready(server: &TestServer, test: &str) -> Result<(String, String, String, String), ()> {
    let admin = setup_admin(server).await;
    let alice_id = create_user(server, &admin, "alice", "alice@x.test").await;
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
            "the analysis sandbox rootfs is not runnable here — the round-3 concurrency-edge \
             tests run the real freeze producer through the sandbox. Point \
             CYTO_ENV_ROOTFS_SQUASHFS at a rootfs (and ensure unprivileged userns + bwrap + \
             squashfuse).",
        );
        return Err(());
    }
    Ok((admin, alice_id, alice, project))
}

/// HIGH — a consumer with TWO open-draft inputs whose two freeze producers complete must
/// land BOTH pins (no `draft_ref` survives). Before the fix, the two completion hooks each
/// read their own snapshot of the consumer's params and the last writer clobbered the
/// other's pin, so one input reached staging unresolved and the consumer failed.
#[tokio::test]
async fn two_open_draft_inputs_both_pinned() {
    let server = TestServer::spawn().await;
    let Ok((_admin, _alice_id, alice, project)) = ready(&server, "ROUND3-HIGH").await else {
        return;
    };

    // Two DISTINCT open drafts with DIFFERENT content → two distinct freeze artifacts.
    let d1 = create_draft(&server, &alice, &project, WIDGET_KIND, json!({ "n": 1 })).await;
    let d2 = create_draft(&server, &alice, &project, WIDGET_KIND, json!({ "n": 2 })).await;
    let id1 = d1["id"].as_str().unwrap().to_string();
    let id2 = d2["id"].as_str().unwrap().to_string();

    // One consumer depending on BOTH open drafts → born blocked on two freeze jobs.
    let (status, body) = submit_consume_multi(&server, &alice, &project, &[&id1, &id2]).await;
    assert_eq!(
        status, 202,
        "a consumer of two open drafts is blocked: {body}"
    );
    assert_eq!(
        body["status"],
        json!("blocked"),
        "born blocked (INV-4): {body}"
    );
    let consumer_id = body["id"].as_str().unwrap().to_string();

    // Both drafts freeze in the background (their producers run in parallel).
    let f1 = super::wait_frozen(&server, &alice, &id1).await;
    let f2 = super::wait_frozen(&server, &alice, &id2).await;
    let art1 = f1["frozen_artifact_id"].as_str().unwrap().to_string();
    let art2 = f2["frozen_artifact_id"].as_str().unwrap().to_string();
    assert_ne!(art1, art2, "distinct content freezes to distinct artifacts");

    // The consumer unblocks with BOTH inputs pinned and NO surviving `draft_ref`.
    let consumer = wait_consumer_unblocked(&server, &alice, &consumer_id).await;
    let inputs = consumer["job"]["params"]["inputs"]
        .as_array()
        .expect("consumer inputs");
    for inp in inputs {
        assert!(
            inp.get("draft_ref").map(|v| v.is_null()).unwrap_or(true),
            "no draft_ref survives on any input — both pins landed: {consumer}"
        );
        assert!(
            inp.get("artifact_ref").and_then(|v| v.as_str()).is_some(),
            "every draft input is pinned to an artifact_ref: {consumer}"
        );
    }
    let pinned: HashSet<&str> = inputs
        .iter()
        .filter_map(|i| i["artifact_ref"].as_str())
        .collect();
    assert!(
        pinned.contains(art1.as_str()) && pinned.contains(art2.as_str()),
        "BOTH freeze artifacts are pinned (the multi-dependency lost-update fix): {consumer}"
    );
}

/// MEDIUM — a consumer BORN depending on an ALREADY-`completed` freeze still gets its
/// `artifact_ref` pinned. Reproduces the create-after-complete window deterministically:
/// drive a real freeze to completion (mints the artifact + maps the freeze→draft), then
/// create a consumer whose input references that draft and whose dependency is the
/// already-completed freeze — exactly the state the race leaves. Before the fix,
/// `create_with_deps` substituted nothing for completed deps, so the consumer was born
/// `queued` with a live `draft_ref`.
#[tokio::test]
async fn consumer_born_on_a_completed_freeze_is_pinned() {
    let server = TestServer::spawn().await;
    let Ok((_admin, alice_id, alice, project)) = ready(&server, "ROUND3-CREATE-RACE").await else {
        return;
    };
    let owner: Uuid = alice_id.parse().expect("alice uuid");
    let project_uuid: Uuid = project.parse().expect("project uuid");

    // Drive a REAL freeze to completion via a first consume (mints artifact A, maps F→D).
    let draft = create_draft(&server, &alice, &project, WIDGET_KIND, json!({ "n": 7 })).await;
    let id = draft["id"].as_str().unwrap().to_string();
    let (s, b) = submit_consume_multi(&server, &alice, &project, &[&id]).await;
    assert_eq!(s, 202, "first consume blocks on the freeze: {b}");
    super::wait_frozen(&server, &alice, &id).await;

    // Resolve the now-completed freeze job F + its minted artifact A from the DB.
    let pool = SqlitePool::connect(server.database_url()).await.unwrap();
    let draft_uuid = Uuid::parse_str(&id).unwrap();
    let row = sqlx::query!(
        r#"SELECT f.job_id as "freeze_id!: Uuid", d.frozen_artifact_id as "artifact_id!: Uuid", j.status as "status!"
           FROM draft_freeze_jobs f
           JOIN drafts d ON d.id = f.draft_id
           JOIN jobs j ON j.id = f.job_id
           WHERE f.draft_id = $1::uuid"#,
        draft_uuid,
    )
    .fetch_one(&pool)
    .await
    .expect("resolve completed freeze + artifact");
    assert_eq!(row.status, "completed", "the freeze producer completed");
    let freeze_id = row.freeze_id;
    let artifact_id = row.artifact_id;

    // `create_with_deps`'s completed-dep substitution runs through the installed
    // `FreezeCompletionSink`. The SERVER installs it in ITS process (from
    // `DraftsModule::init`); this test drives `create_with_deps` directly IN THE TEST
    // PROCESS, which has its own empty seam slot, so install the real hook here (pointed at
    // the same DB) — otherwise the no-op default would substitute nothing and mask the fix.
    cytoanalyst::modules::jobs::seams::install_freeze_completion_sink(std::sync::Arc::new(
        cytoanalyst::modules::drafts::FreezeCompletion::new(pool.clone()),
    ));

    // Create a consumer whose input references the (still-referenced) draft AND whose
    // dependency is the ALREADY-completed freeze — the create-after-complete state.
    let req = CreateJobRequest {
        job_type: "analysis".to_string(),
        name: Some("race-consumer".to_string()),
        params: Some(json!({
            "language": "python",
            "script": CONSUMER_SCRIPT,
            "inputs": [ { "slot": "gs", "draft_ref": id } ]
        })),
        priority_class: None,
        resource_class: None,
        project_id: Some(project_uuid),
        dataset_id: None,
    };
    let born = JobRepository::new(pool.clone())
        .create_with_deps(owner, &req, &[freeze_id])
        .await
        .expect("create consumer on a completed freeze");

    // Born queued (its only dep already completed) — and its persisted params pin the
    // frozen artifact_ref with NO draft_ref (the create-after-complete fix).
    assert_eq!(
        born.status, "queued",
        "a consumer whose only dep already completed is born queued: {born:?}"
    );
    let input0 = &born.params["inputs"][0];
    assert_eq!(
        input0["artifact_ref"].as_str(),
        Some(artifact_id.to_string().as_str()),
        "the consumer is BORN pinned to the completed freeze's artifact (create-after-complete fix): {born:?}"
    );
    assert!(
        input0.get("draft_ref").map(|v| v.is_null()).unwrap_or(true),
        "no live draft_ref survives on a consumer born after its freeze completed: {born:?}"
    );
}

/// MEDIUM — a draft edited mid-freeze makes a new consumer freeze the NEW content, never
/// reuses the stale in-flight freeze. Before the fix, dedup reused ANY in-flight freeze for
/// the draft regardless of content, so the consumer depended on the stale (S1) freeze and
/// would consume a stale snapshot.
#[tokio::test]
async fn editing_a_draft_mid_freeze_freezes_the_new_content() {
    let server = TestServer::spawn().await;
    let Ok((_admin, _alice_id, alice, project)) = ready(&server, "ROUND3-STALE-DEDUP").await else {
        return;
    };

    // Draft at content S1; enqueue an explicit freeze F1 (its producer runs in the
    // background — in-flight while we edit + submit below).
    let draft = create_draft(&server, &alice, &project, WIDGET_KIND, json!({ "n": 1 })).await;
    let id = draft["id"].as_str().unwrap().to_string();
    let (fs, fb) = freeze(&server, &alice, &id).await;
    assert_eq!(fs, 202, "explicit freeze accepted: {fb}");
    let f1_id = fb["freeze_job_id"]
        .as_str()
        .expect("freeze job id")
        .to_string();

    // Edit → S2 (flips the draft back to `open`; F1 now froze STALE content).
    let edited: Value = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": { "n": 99 } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        edited["status"],
        json!("open"),
        "an edit re-opens the draft: {edited}"
    );

    // A consumer of the (now S2) open draft must depend on a FRESH freeze, never F1.
    let (cs, cb) = submit_consume_multi(&server, &alice, &project, &[&id]).await;
    assert_eq!(
        cs, 202,
        "consumer of the edited open draft is blocked: {cb}"
    );
    let consumer_id = cb["id"].as_str().unwrap().to_string();

    let pool = SqlitePool::connect(server.database_url()).await.unwrap();
    let consumer_uuid = Uuid::parse_str(&consumer_id).unwrap();
    let deps: Vec<Uuid> = sqlx::query_scalar!(
        r#"SELECT depends_on_job_id as "dep!: Uuid" FROM job_dependencies WHERE job_id = $1::uuid"#,
        consumer_uuid,
    )
    .fetch_all(&pool)
    .await
    .expect("consumer freeze deps");
    assert_eq!(
        deps.len(),
        1,
        "the consumer depends on exactly one freeze: {deps:?}"
    );
    let f1_uuid = Uuid::parse_str(&f1_id).unwrap();
    assert_ne!(
        deps[0], f1_uuid,
        "the consumer must depend on a FRESH freeze for the edited (S2) content, never the \
         stale S1 freeze F1 (content-aware dedup)"
    );

    // The fresh freeze captured DIFFERENT content than F1 (its content_hash differs) — the
    // positive proof it is not a reuse of the stale snapshot.
    let draft_uuid = Uuid::parse_str(&id).unwrap();
    let hashes: Vec<String> = sqlx::query_scalar!(
        r#"SELECT content_hash as "h!" FROM draft_freeze_jobs WHERE draft_id = $1::uuid ORDER BY created_at"#,
        draft_uuid,
    )
    .fetch_all(&pool)
    .await
    .expect("freeze content hashes");
    assert_eq!(
        hashes.len(),
        2,
        "two distinct freezes exist for the draft (S1 + S2): {hashes:?}"
    );
    assert_ne!(
        hashes[0], hashes[1],
        "the fresh freeze captured different content than the stale one: {hashes:?}"
    );
}
