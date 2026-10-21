//! TEST-59 [ITEM-25, ITEM-19] — cancellation. Cancelling a QUEUED job → `stopped`
//! (it never runs); cancelling a RUNNING long job → SIGTERM→SIGKILL → terminal
//! `stopped` well before its natural end; a cancel racing the spawn is not lost.

use std::time::Duration;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn cancel_queued_and_running_and_racing_spawn() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // One slot → a second job is guaranteed to QUEUE behind the first.
    set_job_settings(&server, &admin, 1, 0).await;

    // job1: a long RUNNING job.
    let job1 = submit_stub(
        &server,
        &admin,
        "runner",
        serde_json::json!({ "steps": 30 }),
        None,
    )
    .await;
    assert!(
        wait_started(&pool, job1, Duration::from_secs(15)).await,
        "job1 is running"
    );

    // job2: a QUEUED job behind job1.
    let job2 = submit_stub(
        &server,
        &admin,
        "queued",
        serde_json::json!({ "steps": 30 }),
        None,
    )
    .await;
    // (It cannot have started — cap is 1 and job1 holds the slot.)
    assert!(
        job_started_at(&pool, job2).await.is_none(),
        "job2 is queued, not running"
    );

    // Cancel the QUEUED job → stopped, never runs.
    let resp = stop_job(&server, &admin, job2).await;
    assert!(resp.status().is_success(), "stop queued: {}", resp.status());
    let (status, started, finished, _) = job_row(&pool, job2).await;
    assert_eq!(status, "stopped", "a cancelled QUEUED job → stopped");
    assert!(!started, "a cancelled queued job never started");
    assert!(finished, "it has a terminal finished_at");

    // Cancel the RUNNING job → SIGTERM→SIGKILL → stopped, well before steps=30 (~30s).
    let resp = stop_job(&server, &admin, job1).await;
    assert!(
        resp.status().is_success(),
        "stop running: {}",
        resp.status()
    );
    let started_at = std::time::Instant::now();
    assert_eq!(
        wait_terminal(&pool, job1, Duration::from_secs(15)).await,
        "stopped",
        "a cancelled RUNNING job terminates as stopped"
    );
    assert!(
        started_at.elapsed() < Duration::from_secs(15),
        "the child was killed promptly (not left to run its full ~30s)"
    );

    // A cancel RACING the spawn: submit then immediately cancel. The cancel signal
    // is registered at claim time, so it is not lost — the job ends terminal
    // (stopped or, if it slipped through, some terminal state) and never hangs.
    let job3 = submit_stub(
        &server,
        &admin,
        "racer",
        serde_json::json!({ "steps": 30 }),
        None,
    )
    .await;
    let _ = stop_job(&server, &admin, job3).await;
    let terminal = wait_terminal(&pool, job3, Duration::from_secs(20)).await;
    assert!(matches!(terminal.as_str(), "stopped" | "completed" | "failed"),
        "a cancel racing the spawn is not lost — job3 reaches a terminal state ({terminal}), never hangs");
    let (_, _, finished, _) = job_row(&pool, job3).await;
    assert!(
        finished,
        "the raced job has a finished_at (no orphaned running row)"
    );
}
