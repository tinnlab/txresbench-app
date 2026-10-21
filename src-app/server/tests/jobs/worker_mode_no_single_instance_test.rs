//! TEST-7 [invariant: INV-6] — the single-INSTANCE assumption is dropped: TWO
//! independent claim loops against ONE shared `jobs` queue BOTH make progress
//! (neither is shut out), and no row is double-claimed.
//!
//! The old `SCHEDULER_ACTIVE` guard is process-local memory — it never bounded
//! claiming across processes; it only stopped a double-spawn WITHIN one process.
//! T4 makes N claimers on one DB the intended posture, with the DB-level
//! cap-folded SKIP-LOCKED claim as the safety (INV-1/INV-2). This test proves the
//! LIVENESS half of INV-6: two concurrent claimers share the queue rather than
//! one starving the other. Positive control: a single claimer also drains it.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;

use super::{pool_for, register_user};
use crate::common::{TestOptions, TestServer};

async fn insert_queued(pool: &PgPool, owner: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name) VALUES ($1, $2, 'stub', $3)")
        .bind(id)
        .bind(owner)
        .bind(name)
        .execute(pool)
        .await
        .expect("insert queued");
    id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_concurrent_claimers_both_make_progress() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "wminst").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;

    // Caps well above the backlog so ALL work is claimable (this is the
    // no-single-instance / liveness leg, not the cap leg).
    const QUEUED: usize = 20;
    for i in 0..QUEUED {
        insert_queued(&pool, owner, &format!("wm{i}")).await;
    }

    // TWO independent claim loops (two "worker processes"), each with its OWN
    // worker id, racing on the same pool.
    let by_a: Arc<Mutex<Vec<Uuid>>> = Arc::new(Mutex::new(Vec::new()));
    let by_b: Arc<Mutex<Vec<Uuid>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for (wid, sink) in [("worker-A", by_a.clone()), ("worker-B", by_b.clone())] {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            let repo = JobRepository::new(pool);
            loop {
                // A tiny yield between claims so both loops genuinely interleave
                // rather than one draining the whole queue before the other starts.
                match repo
                    .claim_next_fair(false, wid, 64, 64)
                    .await
                    .expect("claim")
                {
                    Some(job) => {
                        sink.lock().unwrap().push(job.id);
                        tokio::task::yield_now().await;
                    }
                    None => break,
                }
            }
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    let a = by_a.lock().unwrap().clone();
    let b = by_b.lock().unwrap().clone();
    // Both claimers made progress — neither was shut out by any single-instance
    // guard (INV-6). This is the property the DB claim now provides in place of
    // the dropped single-scheduler assumption.
    assert!(!a.is_empty(), "worker A claimed some rows (not shut out)");
    assert!(!b.is_empty(), "worker B claimed some rows (not shut out)");
    // The whole backlog was drained, exactly once each (INV-2: no double-claim).
    let mut all = a.clone();
    all.extend(b.iter().copied());
    let set: HashSet<Uuid> = all.iter().copied().collect();
    assert_eq!(
        set.len(),
        all.len(),
        "no row was claimed by BOTH workers (INV-2)"
    );
    assert_eq!(
        all.len(),
        QUEUED,
        "the two claimers together drained the queue"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn single_claimer_positive_control() {
    // POSITIVE CONTROL: one claimer alone still drains the queue — the machinery
    // works with a single worker (single-box `serve` posture unchanged).
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "wmsingle").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;
    for i in 0..5 {
        insert_queued(&pool, owner, &format!("s{i}")).await;
    }
    let repo = JobRepository::new(pool.clone());
    let mut n = 0;
    while repo
        .claim_next_fair(false, "solo", 64, 64)
        .await
        .expect("claim")
        .is_some()
    {
        n += 1;
    }
    assert_eq!(n, 5, "a single claimer drains the whole queue");
}
