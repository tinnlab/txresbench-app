//! TEST-20 [ITEM-24] — the end-user-facing MILESTONE channel. A run emits
//! `milestone|<id>|<status>[|<detail-json>]` lines on the sandbox progress FIFO;
//! the drain (`sandbox::streaming::parse_milestone_line`) turns each into a
//! `MilestoneFrame` and the runner persists it via
//! `JobRepository::append_milestone` (the durable timeline distinct from raw logs
//! + fine progress %), replayed on reconnect via `list_milestones` and streamed
//! live as the SSE `milestone` frame (whose `data()` IS the `MilestoneFrame`
//! serialization).
//!
//! The sandbox run itself is rootfs-gated, so this drives the SAME chokepoints the
//! streaming sink feeds — parse → persist → replay — directly against a real
//! spawned server + Postgres (DB-only, no rootfs), mirroring how the boot-reconcile
//! tests drive the reconcile fn directly. The FIFO codec + SSE frame naming are
//! additionally unit-tested in `streaming.rs` / `sse.rs`.

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;
use cytoanalyst::modules::sandbox::backend::MilestoneFrame;
use cytoanalyst::modules::sandbox::streaming::parse_milestone_line;

use super::{pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn milestone_lines_parse_persist_and_replay() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // A real jobs row is the FK target for `job_milestones` (ON DELETE CASCADE).
    // Insert a terminal job directly so the scheduler leaves it alone.
    let owner: Uuid = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("an admin user exists");
    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status) \
         VALUES ($1, $2, 'analysis', 'milestone run', 'completed')",
    )
    .bind(job_id)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("insert host job");

    let repo = JobRepository::new(pool.clone());

    // The exact stdout the h5ad importer emits as it inspects the data. The drain
    // routes each `milestone|…` line to the milestone callback; non-milestone
    // lines stay fine-progress (asserted rejected below).
    let emitted = [
        "milestone|read|started",
        "milestone|read|done|{\"cells\":1200,\"genes\":31053}",
        "milestone|detect_counts|done|{\"layer\":\"counts\"}",
        "milestone|embeddings|done|{\"count\":3,\"names\":[\"UMAP\",\"PCA\",\"tSNE\"]}",
    ];

    // Parse → persist each transition (the runner's sink chokepoint).
    for line in emitted {
        let frame = parse_milestone_line(line)
            .unwrap_or_else(|| panic!("`{line}` is a valid milestone line"));
        repo.append_milestone(job_id, &frame.id, &frame.status, &frame.detail)
            .await
            .expect("persist milestone");
    }

    // A non-milestone progress line + a malformed status are rejected by the codec
    // (they never reach `append_milestone`).
    assert!(parse_milestone_line("normalizing|40|scaling counts").is_none(), "progress line is not a milestone");
    assert!(parse_milestone_line("milestone|oops|weird-status").is_none(), "unknown status → rejected");

    // --- replay: the persisted timeline, oldest-first (reconnect / detail view) ---
    let timeline = repo.list_milestones(job_id).await.expect("list milestones");
    assert_eq!(timeline.len(), 4, "every emitted transition persisted");

    let ids: Vec<&str> = timeline.iter().map(|m| m.milestone_id.as_str()).collect();
    assert_eq!(ids, vec!["read", "read", "detect_counts", "embeddings"], "ordered oldest-first");
    let statuses: Vec<&str> = timeline.iter().map(|m| m.status.as_str()).collect();
    assert_eq!(statuses, vec!["started", "done", "done", "done"]);

    // The structured findings round-trip through the jsonb column.
    let read_done = &timeline[1];
    assert_eq!(read_done.milestone_id, "read");
    assert_eq!(read_done.status, "done");
    assert_eq!(read_done.detail["cells"], json!(1200));
    assert_eq!(read_done.detail["genes"], json!(31053));
    let embeddings = timeline.iter().find(|m| m.milestone_id == "embeddings").unwrap();
    assert_eq!(embeddings.detail["count"], json!(3));
    assert_eq!(embeddings.detail["names"][0], json!("UMAP"));
    // A no-detail line parses to `Value::Null` (the frame's default) and is
    // persisted verbatim — the migration `DEFAULT '{}'` only fires when the column
    // is omitted, but `append_milestone` always supplies `detail`.
    let read_started = &timeline[0];
    assert_eq!(read_started.status, "started");
    assert_eq!(read_started.detail, json!(null), "no-detail transition persists a JSON null");

    // --- the SSE `milestone` frame payload IS the MilestoneFrame serialization ---
    // (the private SSEJobEvent::Milestone wraps this verbatim; assert the wire the
    // reconnecting client / live stream receives carries id/status/detail).
    let frame = MilestoneFrame {
        id: embeddings.milestone_id.clone(),
        status: embeddings.status.clone(),
        detail: embeddings.detail.clone(),
    };
    let wire = serde_json::to_value(&frame).expect("frame serializes");
    assert_eq!(wire["id"], json!("embeddings"));
    assert_eq!(wire["status"], json!("done"));
    assert_eq!(wire["detail"]["count"], json!(3));

    // --- retention: milestones cascade with the job (mirrors job_logs) ---
    sqlx::query("DELETE FROM jobs WHERE id = $1")
        .bind(job_id)
        .execute(&pool)
        .await
        .expect("delete job");
    let after = repo.list_milestones(job_id).await.expect("list after delete");
    assert!(after.is_empty(), "job_milestones cascade-delete with the job");
}
