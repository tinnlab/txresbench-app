//! TEST-57 [ITEM-25, ITEM-19] — priority + reserved-interactive. A `batch` burst
//! does NOT head-of-line-block a just-arrived `interactive` re-run: with a reserved
//! interactive slot the interactive claims the free slot ahead of queued batch;
//! and among the remaining queue `normal` is admitted before `batch` (priority).

use std::time::Duration;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn interactive_not_blocked_by_batch_and_normal_beats_batch() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // 2 slots, 1 reserved for interactive.
    set_job_settings(&server, &admin, 2, 1).await;

    // A long-running batch job holds slot 1 for the whole test.
    let batch1 = submit_stub(
        &server,
        &admin,
        "batch1",
        serde_json::json!({ "steps": 12 }),
        Some("batch"),
    )
    .await;
    assert!(
        wait_started(&pool, batch1, Duration::from_secs(15)).await,
        "batch1 starts in slot 1"
    );

    // Now an interactive re-run arrives, plus a normal + a second batch. With the
    // reserved slot, the scheduler admits the INTERACTIVE into slot 2 (not a 2nd
    // batch), and — once it finishes — prefers `normal` over `batch`.
    let interactive = submit_stub(
        &server,
        &admin,
        "inter",
        serde_json::json!({ "steps": 2 }),
        Some("interactive"),
    )
    .await;
    let normal1 = submit_stub(
        &server,
        &admin,
        "normal1",
        serde_json::json!({ "steps": 2 }),
        Some("normal"),
    )
    .await;
    let batch2 = submit_stub(
        &server,
        &admin,
        "batch2",
        serde_json::json!({ "steps": 2 }),
        Some("batch"),
    )
    .await;

    // The interactive runs (reserved slot honored) despite the batch backlog.
    assert!(
        wait_started(&pool, interactive, Duration::from_secs(15)).await,
        "the interactive re-run is admitted (reserved slot), not blocked behind batch"
    );
    assert_eq!(
        wait_terminal(&pool, interactive, Duration::from_secs(30)).await,
        "completed"
    );
    assert_eq!(
        wait_terminal(&pool, normal1, Duration::from_secs(60)).await,
        "completed"
    );
    assert_eq!(
        wait_terminal(&pool, batch2, Duration::from_secs(60)).await,
        "completed"
    );

    let t_i = job_started_at(&pool, interactive).await.unwrap();
    let t_n = job_started_at(&pool, normal1).await.unwrap();
    let t_b2 = job_started_at(&pool, batch2).await.unwrap();
    // The interactive got the reserved slot FIRST — ahead of the queued normal + batch.
    assert!(
        t_i < t_n && t_i < t_b2,
        "interactive ran before the queued normal + batch (not HOL-blocked)"
    );
    // Among the queue, normal is admitted before batch (priority weight).
    assert!(
        t_n < t_b2,
        "normal is admitted before batch (priority), never held back"
    );
}
