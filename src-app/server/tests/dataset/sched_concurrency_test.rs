//! TEST-58 [ITEM-25, ITEM-19] — concurrency cap. `max_concurrent_jobs` is
//! honored: excess jobs queue and drain in claim order (FCFS within one owner),
//! and the running count NEVER exceeds the cap under a burst.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn cap_is_never_exceeded_and_drains_in_order() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    set_job_settings(&server, &admin, 2, 0).await;

    // A burst of 5 jobs against a cap of 2.
    let mut ids = Vec::new();
    for i in 0..5 {
        ids.push(
            submit_stub(
                &server,
                &admin,
                &format!("burst{i}"),
                serde_json::json!({ "steps": 2 }),
                None,
            )
            .await,
        );
    }

    // Sample the running count throughout — it must never exceed the cap.
    let max_seen = Arc::new(AtomicI64::new(0));
    let sampler = {
        let pool = pool.clone();
        let max_seen = max_seen.clone();
        tokio::spawn(async move {
            for _ in 0..200 {
                let n = count_running(&pool).await;
                max_seen.fetch_max(n, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        })
    };

    for id in &ids {
        assert_eq!(
            wait_terminal(&pool, *id, Duration::from_secs(90)).await,
            "completed"
        );
    }
    sampler.abort();

    assert!(
        max_seen.load(Ordering::SeqCst) <= 2,
        "the running count never exceeded max_concurrent_jobs=2 (saw {})",
        max_seen.load(Ordering::SeqCst)
    );
    assert!(
        max_seen.load(Ordering::SeqCst) >= 1,
        "the scheduler actually ran jobs (sampled ≥1 running)"
    );

    // Drained in claim order: same owner + class → FCFS by created_at, so
    // started_at is monotonic in submission order.
    let mut prev = None;
    for id in &ids {
        let t = job_started_at(&pool, *id).await.expect("started");
        if let Some(p) = prev {
            assert!(t >= p, "jobs drain in claim (submission) order");
        }
        prev = Some(t);
    }
}
