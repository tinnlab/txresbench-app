//! TEST-8 [invariant: INV-4] — the reaper is ADDITIVE, not a replacement for the
//! boot reconcile; and the T4 schema deltas exist post-migration.
//!
//! Two proofs:
//!   * SCHEMA PARITY: the new `jobs` columns (`claimed_by`/`claim_heartbeat`/
//!     `reclaim_count`) + partial indexes + the `job_settings.per_tenant_max_concurrent`
//!     column exist after migration.
//!   * ADDITIVITY (INV-4): a `running` row with NO `claim_heartbeat` — a
//!     pre-T4-style boot orphan the BOOT RECONCILE owns — is NOT touched by the
//!     stale-claim reaper (`reclaim_stale`), so the reaper cannot swallow a case
//!     the boot reconcile is meant to handle.

use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;

use super::{pool_for, register_user};
use crate::common::{TestOptions, TestServer};

async fn column_exists(pool: &PgPool, table: &str, column: &str) -> bool {
    sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    )
    .bind(table)
    .bind(column)
    .fetch_one(pool)
    .await
    .expect("information_schema query")
        > 0
}

async fn index_exists(pool: &PgPool, index: &str) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM pg_indexes WHERE indexname = $1")
        .bind(index)
        .fetch_one(pool)
        .await
        .expect("pg_indexes query")
        > 0
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn t4_schema_deltas_exist_post_migration() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let pool = pool_for(&server).await;

    assert!(
        column_exists(&pool, "jobs", "claimed_by").await,
        "jobs.claimed_by"
    );
    assert!(
        column_exists(&pool, "jobs", "claim_heartbeat").await,
        "jobs.claim_heartbeat"
    );
    assert!(
        column_exists(&pool, "jobs", "reclaim_count").await,
        "jobs.reclaim_count"
    );
    assert!(
        column_exists(&pool, "job_settings", "per_tenant_max_concurrent").await,
        "job_settings.per_tenant_max_concurrent"
    );
    assert!(
        index_exists(&pool, "idx_jobs_status_owner").await,
        "the per-tenant count partial index exists"
    );
    assert!(
        index_exists(&pool, "idx_jobs_running_heartbeat").await,
        "the reaper-scan partial index exists"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reaper_does_not_touch_a_heartbeatless_boot_orphan() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "bootorphan").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;
    let repo = JobRepository::new(pool.clone());

    // A `running` row with NULL claim_heartbeat — exactly a pre-T4 orphan a crash
    // left behind, which the BOOT RECONCILE (not the reaper) is responsible for.
    let orphan = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at) \
         VALUES ($1, $2, 'stub', 'orphan', 'running', now())",
    )
    .bind(orphan)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("insert heartbeatless running orphan");

    // The reaper only reclaims rows that HAVE a stale heartbeat. A NULL-heartbeat
    // row is invisible to it → left for the boot reconcile (INV-4, additive).
    let reclaimed = repo.reclaim_stale(45, 5, 100).await.expect("reclaim");
    assert_eq!(reclaimed, 0, "the reaper reclaims no heartbeatless row");
    let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(orphan)
        .fetch_one(&pool)
        .await
        .expect("status");
    assert_eq!(
        status, "running",
        "the boot-orphan is untouched by the reaper (boot reconcile still owns it)"
    );
}
