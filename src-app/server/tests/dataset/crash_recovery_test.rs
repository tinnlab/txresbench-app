//! TEST-62 [ITEM-25, ITEM-19] — crash-recovery reconcile. With one job mid-run
//! (no manifest) and one completed-but-uningested (a valid `/outputs/manifest.json`
//! on disk), a boot reconcile FINALIZES the uningested run (idempotent ingest +
//! record, no double-insert) and FAILS the mid-run one with its dirs preserved.
//! Exercises the real reconcile path for DATASET-scoped pipeline jobs.
//!
//! Staged in the TWO-ROOT shape `JobsModule::init` passes (ITEM-17): a workspace
//! under the sandboxes root and the run's outputs in a SEPARATE staging tree. That
//! is not cosmetic here — with one dir serving as both, `finalize_analysis_with`'s
//! `remove_dir_all(workspace)` and `discard_staging(staging)` aimed at the same
//! path, so the second was a no-op `NotFound` and neither reclamation could be
//! observed independently. Both are asserted below.

use std::sync::Arc;

use txresbench::modules::jobs::scheduler::reconcile_orphaned_running_in;
use txresbench::modules::jobs::seams::NoopRunRecorder;
use txresbench::modules::workstore::ingest::ingest_run_outputs;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn reconcile_finalizes_uningested_and_fails_midrun_preserving_workspace() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let admin_id = admin_user_id(&pool).await;
    let root = sandboxes_root(&server);
    let staging_root = run_staging_root(&server);
    assert!(
        !staging_root.starts_with(&root),
        "the staging root is a SIBLING of the workspace root, not a subdir of it"
    );

    // A dataset the finalized run's artifacts land in (owner-processing scope).
    let dataset = new_dataset(&server, &admin, "recovery ds").await;

    // job_done: a completed-but-uningested analysis run — a valid manifest + file
    // sit in its output STAGING dir (where a real run writes them, ITEM-17), with
    // its workspace beside them. The child finished; ingest never ran before the crash.
    let job_done = insert_running_job(&pool, admin_id, "analysis", Some(dataset)).await;
    let (done_ws, done_stg) = stage_job_run_dirs(
        &server,
        job_done,
        &[OutSpec::file(
            "result",
            "file/upload",
            b"DETERMINISTIC-RESULT",
            "artifact",
        )],
    )
    .await;

    // job_mid: a genuinely mid-run crash — both dirs exist, NO manifest in staging.
    let job_mid = insert_running_job(&pool, admin_id, "analysis", Some(dataset)).await;
    let (mid_dir, mid_stg) = stage_job_run_dirs(&server, job_mid, &[]).await;

    // Boot reconcile with the REAL ingest (dataset scope).
    let report = reconcile_orphaned_running_in(
        &pool,
        &root,
        &staging_root,
        Arc::new(RealIngest {
            pool: pool.clone(),
            store_root: store_root(&server),
            project_id: None,
            dataset_id: Some(dataset),
        }),
        Arc::new(NoopRunRecorder),
    )
    .await;

    assert_eq!(
        report.finalized,
        vec![job_done],
        "the uningested run is finalized"
    );
    assert_eq!(
        report.failed_preserved,
        vec![job_mid],
        "the mid-run crash is fail-preserved"
    );

    // Terminal states.
    assert_eq!(
        job_row(&pool, job_done).await.0,
        "completed",
        "the recovered run is completed"
    );
    assert_eq!(
        job_row(&pool, job_mid).await.0,
        "failed",
        "the dead mid-run is failed"
    );
    // The mid-run run dirs are preserved (not swept by the reconcile). BOTH of them:
    // a fail-preserve exists so a half-finished run can be inspected, and after
    // ITEM-17 its partial outputs — the part actually worth inspecting — are in the
    // staging tree, which no longer disappears along with the workspace.
    assert!(
        mid_dir.exists(),
        "the mid-run workspace is preserved for inspection"
    );
    assert!(
        mid_stg.exists(),
        "the mid-run output staging is preserved with it"
    );

    // …and the finalized run's dirs are BOTH reclaimed. Two separate reclamations in
    // `finalize_analysis_with` (`remove_dir_all(workspace)` + `discard_staging`), which
    // a co-located fixture could not tell apart — it aimed both at one path, so the
    // second call returned `NotFound` and asserted nothing. The staging assertion in
    // particular cannot pass by the dir never having existed: the manifest and bytes
    // just ingested were read out of it.
    assert!(
        !done_ws.exists(),
        "the finalized run's workspace is reclaimed after a successful ingest"
    );
    assert!(
        !done_stg.exists(),
        "…and so is its output staging, a separate tree the outputs were read from"
    );

    // The finalize ingested the run's output exactly once (idempotent, run_id == job id).
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(job_done)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "the recovered run cataloged exactly one artifact");
    let (dataset_id, hash): (Option<uuid::Uuid>, String) =
        sqlx::query_as("SELECT dataset_id, content_hash FROM artifacts WHERE run_id = $1")
            .bind(job_done)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        dataset_id,
        Some(dataset),
        "the recovered artifact carries the dataset scope"
    );
    assert!(hash.starts_with("sha256:"), "content identity stamped");

    // No double-insert: re-ingesting the SAME run manifest (natural key) keeps it at 1.
    let (ws, _) = stage_manifest(
        &server,
        job_done,
        &[OutSpec::file(
            "result",
            "file/upload",
            b"DETERMINISTIC-RESULT",
            "artifact",
        )],
    )
    .await;
    let store = server_store(&server);
    ingest_run_outputs(&pool, &store, None, Some(dataset), job_done, None, &ws)
        .await
        .expect("re-ingest is idempotent");
    let n2: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(job_done)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        n2, 1,
        "re-ingest did not double-insert (natural-key upsert)"
    );
}
