//! TEST-10 [invariant: INV-3] — the reaper's single-leader advisory-lock gate,
//! and discard-at-max (DEC-9).
//!
//!   * SINGLE-LEADER: while a session-level `pg_advisory_lock(KEY)` is held on a
//!     separate connection, `reaper_sweep` cannot take its `pg_try_advisory_xact_lock`
//!     and returns `None` (no-ops) — so of N workers ticking at once, only the one
//!     that wins the lock sweeps. Releasing it lets the next sweep proceed.
//!   * DISCARD-AT-MAX: a stale row already at `reclaim_count >= max_reclaims` is
//!     transitioned to `failed` (poison-job guard), while a stale row UNDER the
//!     limit is re-queued (positive control) — no reap-loop.

use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;
use cytoanalyst::modules::jobs::scheduler::REAPER_ADVISORY_KEY;

use super::{pool_for, register_user};
use crate::common::{TestOptions, TestServer};

async fn insert_running_stale(
    pool: &PgPool,
    owner: Uuid,
    reclaim_count: i32,
    age_secs: i64,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at, claimed_by, claim_heartbeat, reclaim_count) \
         VALUES ($1, $2, 'stub', 'r', 'running', now(), 'deadw', now() - make_interval(secs => $3::double precision), $4)",
    )
    .bind(id)
    .bind(owner)
    .bind(age_secs as f64)
    .bind(reclaim_count)
    .execute(pool)
    .await
    .expect("insert stale running row");
    id
}

async fn status_of(pool: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("status")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn advisory_lock_makes_exactly_one_sweeper() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "reaplock").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;
    let repo = JobRepository::new(pool.clone());

    // A stale row that WOULD be reclaimed if a sweep ran.
    let stale = insert_running_stale(&pool, owner, 0, 120).await;

    // Hold the reaper's advisory lock on a DEDICATED connection (session-level),
    // simulating "another worker is mid-sweep this tick".
    let holder = pool.acquire().await.expect("dedicated conn");
    let mut holder = holder;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(REAPER_ADVISORY_KEY)
        .fetch_one(&mut *holder)
        .await
        .expect("take holder lock");
    assert!(locked, "the holder took the advisory lock");

    // A concurrent sweep cannot get the xact lock → it no-ops (None), and the
    // stale row is LEFT running (the loser did not sweep).
    let swept = repo
        .reaper_sweep(REAPER_ADVISORY_KEY, 45, 5, 100)
        .await
        .expect("sweep call");
    assert!(
        swept.is_none(),
        "a non-leader sweep no-ops while the lock is held"
    );
    assert_eq!(
        status_of(&pool, stale).await,
        "running",
        "the stale row was NOT reclaimed by the shut-out sweeper"
    );

    // Release the holder lock → now the sweep wins the lock and reclaims.
    sqlx::query_scalar::<_, bool>("SELECT pg_advisory_unlock($1)")
        .bind(REAPER_ADVISORY_KEY)
        .fetch_one(&mut *holder)
        .await
        .expect("release holder lock");
    drop(holder);

    let swept2 = repo
        .reaper_sweep(REAPER_ADVISORY_KEY, 45, 5, 100)
        .await
        .expect("sweep call 2")
        .expect("with the lock free, this worker is the leader");
    assert_eq!(
        swept2.reclaimed.len(),
        1,
        "the leader reclaims the one stale row"
    );
    assert_eq!(
        swept2.discarded.len(),
        0,
        "nothing discarded (under the limit)"
    );
    assert_eq!(
        swept2.reclaimed[0].1, owner,
        "the reclaimed row carries its owner"
    );
    assert_eq!(
        status_of(&pool, stale).await,
        "queued",
        "reclaimed → queued"
    );
}

// TEST-5 (#295) — this is the test that carries the discard-at-max BEHAVIOUR. #295 deleted
// the unused standalone `JobRepository::discard_exhausted` wrapper; the production path
// asserted below (`reaper_sweep` -> `discard_exhausted_rows`, driven from `scheduler.rs`)
// is untouched, so this passing is the proof the deletion removed no behaviour.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discard_at_max_prevents_reap_loop() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let (_t, owner_s) = register_user(&server, "poison").await;
    let owner: Uuid = owner_s.parse().unwrap();
    let pool = pool_for(&server).await;
    let repo = JobRepository::new(pool.clone());

    const MAX: i32 = 5;
    // A poison row already AT the limit, and a healthy stale row UNDER it.
    let poison = insert_running_stale(&pool, owner, MAX, 120).await;
    let under = insert_running_stale(&pool, owner, MAX - 1, 120).await;
    // A `blocked` dependent of the poison job — discarding the poison job must
    // CASCADE its failure to this dependent (round-1 audit fix), never leave it
    // stranded `blocked` forever.
    let dependent = Uuid::new_v4();
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name, status) VALUES ($1, $2, 'stub', 'dep', 'blocked')")
        .bind(dependent)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("insert blocked dependent");
    sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES ($1, $2)")
        .bind(dependent)
        .bind(poison)
        .execute(&pool)
        .await
        .expect("link dependency");

    let outcome = repo
        .reaper_sweep(REAPER_ADVISORY_KEY, 45, MAX, 100)
        .await
        .expect("sweep")
        .expect("this worker is the leader");

    // DEC-9: the poison row is FAILED (discarded), not re-queued → no reap-loop.
    assert_eq!(
        outcome.discarded.len(),
        1,
        "the at-limit poison row is discarded"
    );
    assert_eq!(
        status_of(&pool, poison).await,
        "failed",
        "poison job → failed (discard-at-max)"
    );
    // CASCADE (round-1 audit fix): the discarded poison job's blocked dependent is
    // cascade-failed in the sweep's own transaction — not left stranded blocked.
    assert_eq!(
        status_of(&pool, dependent).await,
        "failed",
        "the discarded poison job's blocked dependent is cascade-failed"
    );
    // POSITIVE CONTROL: the under-limit row is re-queued, not failed.
    assert_eq!(
        outcome.reclaimed.len(),
        1,
        "the under-limit row is reclaimed"
    );
    assert_eq!(
        status_of(&pool, under).await,
        "queued",
        "an under-limit stale row is re-queued (not failed)"
    );
}
