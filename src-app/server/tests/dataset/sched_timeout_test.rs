//! TEST-60 [ITEM-25, ITEM-19] — wall-clock timeout. A job that BLOCKS without
//! burning CPU (so RLIMIT_CPU never fires) is killed at the WALL-CLOCK deadline
//! and marked `failed` with a clear reason mentioning the timeout.

use std::time::{Duration, Instant};

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn blocked_job_killed_at_wall_clock_deadline() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // steps=30 (~30s of sleeping — blocked, not CPU-burning) but a 2s wall-clock
    // deadline. The executor's wall-clock kill fires long before step 30.
    let job = submit_stub(
        &server,
        &admin,
        "blocker",
        serde_json::json!({ "steps": 30, "timeout_secs": 2 }),
        None,
    )
    .await;

    let t0 = Instant::now();
    let status = wait_terminal(&pool, job, Duration::from_secs(20)).await;
    assert_eq!(
        status, "failed",
        "a wall-clock timeout marks the job failed"
    );
    assert!(
        t0.elapsed() < Duration::from_secs(15),
        "killed at the ~2s wall-clock deadline, not left to run ~30s"
    );

    let (_, _, _, error) = job_row(&pool, job).await;
    let error = error.unwrap_or_default().to_lowercase();
    assert!(
        error.contains("timeout") || error.contains("wall-clock"),
        "the failure reason names the wall-clock timeout (got: {error:?})"
    );
}
