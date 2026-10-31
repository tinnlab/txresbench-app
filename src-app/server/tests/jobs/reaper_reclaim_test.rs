//! TEST-5 [invariant: INV-3, INV-4] — the stale-claim reaper reclaims a dead
//! worker's rows, LEAVES a live-but-slow worker's rows, and the heartbeat touches
//! only a worker's OWN rows.
//!
//! DB-level (no k8s): stage `running` rows with controlled `claim_heartbeat`
//! ages + `claimed_by`, call the repo primitives directly.

use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;

use super::{pool_for, register_user};
use crate::common::{TestOptions, TestServer};

/// Insert a `running` row `claimed_by = worker`, with `claim_heartbeat` set
/// `age_secs` in the PAST (0 = now / fresh). Returns its id.
async fn insert_running(pool: &SqlitePool, owner: Uuid, worker: &str, age_secs: i64) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at, claimed_by, claim_heartbeat) \
         VALUES ($1, $2, 'stub', 'r', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), $3, strftime('%Y-%m-%dT%H:%M:%fZ','now') - make_interval(secs => $4::double precision))",
    )
    .bind(id)
    .bind(owner)
    .bind(worker)
    .bind(age_secs as f64)
    .execute(pool)
    .await
    .expect("insert running row");
    id
}

async fn status_of(pool: &SqlitePool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("status")
}

async fn claimed_by_of(pool: &SqlitePool, id: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT claimed_by FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("claimed_by")
}

async fn reclaim_count_of(pool: &SqlitePool, id: Uuid) -> i32 {
    sqlx::query_scalar("SELECT reclaim_count FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("reclaim_count")
}

async fn heartbeat_of(pool: &SqlitePool, id: Uuid) -> chrono::DateTime<chrono::Utc> {
    sqlx::query_scalar("SELECT claim_heartbeat FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("claim_heartbeat")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reaper_reclaims_stale_but_leaves_fresh() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false), // no live loop to interfere
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "reapowner").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;
    let repo = JobRepository::new(pool.clone());

    // A stale row (heartbeat 120s old, worker gone) and a FRESH row (heartbeat now).
    let stale = insert_running(&pool, owner, "deadworker", 120).await;
    let fresh = insert_running(&pool, owner, "liveworker", 0).await;

    // Reaper: stale threshold 45s, max_reclaims 5, batch 100.
    let reclaimed = repo.reclaim_stale(45, 5, 100).await.expect("reclaim");
    assert_eq!(reclaimed, 1, "exactly the stale row is reclaimed");

    // INV-3: the dead worker's row is back to queued, claim cleared, count bumped.
    assert_eq!(
        status_of(&pool, stale).await,
        "queued",
        "stale row re-queued"
    );
    assert_eq!(
        claimed_by_of(&pool, stale).await,
        None,
        "claimed_by cleared"
    );
    assert_eq!(
        reclaim_count_of(&pool, stale).await,
        1,
        "reclaim_count bumped"
    );

    // NEGATIVE CONTROL: the live-but-slow worker's fresh row is UNTOUCHED — a
    // heartbeating worker is never reclaimed (DEC-8, no double-execution).
    assert_eq!(
        status_of(&pool, fresh).await,
        "running",
        "a fresh-heartbeat row is NOT reclaimed (live worker safe)"
    );
    assert_eq!(
        claimed_by_of(&pool, fresh).await.as_deref(),
        Some("liveworker")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn heartbeat_advances_only_own_rows() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "hbowner").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;
    let repo = JobRepository::new(pool.clone());

    // Two rows aged 30s: one owned by worker A, one by worker B.
    let a_row = insert_running(&pool, owner, "workerA", 30).await;
    let b_row = insert_running(&pool, owner, "workerB", 30).await;
    let a_before = heartbeat_of(&pool, a_row).await;
    let b_before = heartbeat_of(&pool, b_row).await;

    // Worker A heartbeats: only A's row advances.
    let touched = repo.heartbeat_running("workerA").await.expect("heartbeat");
    assert_eq!(
        touched, 1,
        "heartbeat touches exactly worker A's one running row"
    );
    assert!(
        heartbeat_of(&pool, a_row).await > a_before,
        "worker A's own row heartbeat advanced"
    );
    assert_eq!(
        heartbeat_of(&pool, b_row).await,
        b_before,
        "worker B's row is UNTOUCHED by worker A's heartbeat (scoped to claimed_by)"
    );
}
