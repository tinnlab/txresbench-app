//! TEST-4 [acceptance] [invariant: INV-1, INV-2] — the cap-folded claim under N
//! CONCURRENT claimers (the DB-level core concurrency proof; issue #11 AC-1
//! without k8s).
//!
//! M async tasks call the T4 `claim_next_fair` against ONE Postgres, simulating N
//! worker pods claiming from the shared SKIP-LOCKED `jobs` queue. Two legs:
//!   (a) PER-TENANT: > per_tenant_cap queued rows for ONE owner ⇒ that owner's
//!       running count NEVER exceeds the per-tenant cap (INV-1), and no row is
//!       ever claimed twice (INV-2).
//!   (b) GLOBAL: queued rows across MANY owners ⇒ total running never exceeds the
//!       GLOBAL cap.
//! Positive control: with both caps raised above the queued count, ALL rows claim
//! (the caps are load-bearing, not vacuous).
//!
//! The scheduler loop is DISABLED (`scheduler_enabled: Some(false)`) so nothing
//! but these tasks claims — the concurrency under test is theirs alone.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;

use super::{pool_for, register_user};
use crate::common::{TestOptions, TestServer};

/// Insert a `queued` job for `owner` and return its id (status defaults to
/// 'queued'; priority/resource classes default).
async fn insert_queued(pool: &SqlitePool, owner: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name) VALUES ($1, $2, 'stub', $3)")
        .bind(id)
        .bind(owner)
        .bind(name)
        .execute(pool)
        .await
        .expect("insert queued job");
    id
}

async fn running_count_for(pool: &SqlitePool, owner: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id = $1 AND status = 'running'")
        .bind(owner)
        .fetch_one(pool)
        .await
        .expect("count running for owner")
}

async fn total_running(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM jobs WHERE status = 'running'")
        .fetch_one(pool)
        .await
        .expect("count running")
}

/// Run `workers` claimers concurrently, each draining the queue until it returns
/// None. Returns every claimed id (with duplicates, if any bug produced them) so
/// the caller can assert single-claim.
async fn drain_concurrently(
    pool: &SqlitePool,
    workers: usize,
    global_cap: i64,
    per_tenant_cap: i64,
) -> Vec<Uuid> {
    let claimed: Arc<Mutex<Vec<Uuid>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for w in 0..workers {
        let pool = pool.clone();
        let claimed = claimed.clone();
        let worker_id = format!("w{w}");
        handles.push(tokio::spawn(async move {
            let repo = JobRepository::new(pool);
            loop {
                match repo
                    .claim_next_fair(false, &worker_id, global_cap, per_tenant_cap)
                    .await
                    .expect("claim")
                {
                    Some(job) => claimed.lock().unwrap().push(job.id),
                    None => break,
                }
            }
        }));
    }
    for h in handles {
        h.await.expect("worker task");
    }
    Arc::try_unwrap(claimed).unwrap().into_inner().unwrap()
}

// ---------------------------------------------------------------- leg (a): per-tenant

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn per_tenant_cap_never_exceeded_under_concurrent_claimers() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_tok, owner_s) = register_user(&server, "capowner").await;
    let owner: Uuid = owner_s.parse().expect("owner uuid");
    let pool = pool_for(&server).await;

    // 12 queued jobs for ONE owner; per-tenant cap 3, global cap comfortably high.
    const QUEUED: usize = 12;
    const PER_TENANT: i64 = 3;
    const GLOBAL: i64 = 64;
    for i in 0..QUEUED {
        insert_queued(&pool, owner, &format!("t{i}")).await;
    }

    // 6 workers race to claim. The cap is folded into the claim, so once 3 of this
    // owner's rows are running every further claim returns None.
    let claimed = drain_concurrently(&pool, 6, GLOBAL, PER_TENANT).await;

    // INV-1: the owner's running count never exceeds the per-tenant cap. Since
    // nothing finishes a running row here, the surviving running count IS the peak.
    assert_eq!(
        running_count_for(&pool, owner).await,
        PER_TENANT,
        "exactly per_tenant_cap rows are running; the cap was never exceeded (INV-1)"
    );
    // INV-2: no row was claimed twice (SKIP LOCKED) — and exactly cap rows total.
    let set: HashSet<Uuid> = claimed.iter().copied().collect();
    assert_eq!(
        set.len(),
        claimed.len(),
        "no row was double-claimed (INV-2)"
    );
    assert_eq!(
        claimed.len() as i64,
        PER_TENANT,
        "the per-tenant cap bounded total claims"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn per_tenant_positive_control_all_claim_when_cap_high() {
    // POSITIVE CONTROL: with the per-tenant cap ABOVE the queued count, all rows
    // claim — proving the cap (not some other limit) is what bounded leg (a).
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_tok, owner_s) = register_user(&server, "capowner2").await;
    let owner: Uuid = owner_s.parse().expect("owner uuid");
    let pool = pool_for(&server).await;

    const QUEUED: usize = 8;
    for i in 0..QUEUED {
        insert_queued(&pool, owner, &format!("p{i}")).await;
    }
    let claimed = drain_concurrently(&pool, 6, 64, 20).await;
    assert_eq!(
        claimed.len(),
        QUEUED,
        "with the caps above the backlog, every queued row is claimed (caps are load-bearing)"
    );
    let set: HashSet<Uuid> = claimed.iter().copied().collect();
    assert_eq!(set.len(), claimed.len(), "still no double-claim (INV-2)");
}

// ---------------------------------------------------------------- leg (b): global

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn global_cap_never_exceeded_across_many_owners() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let pool = pool_for(&server).await;

    // 4 owners × 3 queued each = 12 queued; global cap 5, per-tenant comfortably high.
    const GLOBAL: i64 = 5;
    const PER_TENANT: i64 = 64;
    let mut owners = Vec::new();
    for u in 0..4 {
        let (_t, id_s) = register_user(&server, &format!("gcap{u}")).await;
        let owner: Uuid = id_s.parse().expect("owner uuid");
        owners.push(owner);
        for i in 0..3 {
            insert_queued(&pool, owner, &format!("g{u}-{i}")).await;
        }
    }

    let claimed = drain_concurrently(&pool, 8, GLOBAL, PER_TENANT).await;

    // INV-1 (global leg): total running never exceeds the global cap.
    assert_eq!(
        total_running(&pool).await,
        GLOBAL,
        "total running is bounded by the GLOBAL cap across owners (DEC-1)"
    );
    let set: HashSet<Uuid> = claimed.iter().copied().collect();
    assert_eq!(
        set.len(),
        claimed.len(),
        "no row double-claimed across owners (INV-2)"
    );
    assert_eq!(
        claimed.len() as i64,
        GLOBAL,
        "global cap bounded total claims"
    );
}
