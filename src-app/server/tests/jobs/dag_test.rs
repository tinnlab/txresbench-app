//! TEST-21 [ITEM-19] — the JOB DAG (`job_dependencies` + the `blocked` status).
//!
//! Drives the `JobRepository` DAG primitives directly against a spawned server's
//! per-test Postgres (the same production surface the dataset conversion DAG
//! composes): a job with an incomplete dependency is `blocked` and is NOT claimed
//! by the scheduler; on the dependency reaching `completed` it unblocks
//! (`blocked`→`queued`) and runs; on a dependency reaching `failed` its dependents
//! CASCADE (transitively) to `failed` with `dependency_failed` and never run; and a
//! diamond (A→B, A→C, B&C→D) runs D only after BOTH B and C complete.
//!
//! Determinism: a controllable ROOT is seeded directly as `running` (the scheduler
//! only claims `queued` rows, so a `running`/`blocked` job is never grabbed
//! out from under the test — mirrors the reconcile tests' raw-insert pattern),
//! then terminalized via the repo. The happy-path arms let the real background
//! scheduler drain the unblocked stub children (as the other jobs tests do).

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::models::{CreateJobRequest, Job};
use cytoanalyst::modules::jobs::repository::JobRepository;

use super::{pool_for, setup_admin};
use crate::common::TestServer;

// ------------------------------------------------------------------ helpers

async fn admin_owner(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(pool)
        .await
        .expect("an admin user exists after setup")
}

/// Seed a controllable root directly as `running` (never claimed by the scheduler,
/// which only claims `queued`). The test terminalizes it via `finish`/`fail`.
async fn insert_running_root(pool: &PgPool, owner: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at) \
         VALUES ($1, $2, 'stub', $3, 'running', now())",
    )
    .bind(id)
    .bind(owner)
    .bind(name)
    .execute(pool)
    .await
    .expect("insert running root");
    id
}

/// Create a dependent stub job via the real DAG create path (born `blocked` when it
/// has any not-yet-completed dependency).
async fn create_child(repo: &JobRepository, owner: Uuid, name: &str, deps: &[Uuid]) -> Job {
    let req = CreateJobRequest {
        job_type: "stub".to_string(),
        name: Some(name.to_string()),
        params: Some(json!({ "steps": 1 })),
        priority_class: None,
        resource_class: None,
        project_id: None,
        dataset_id: None,
    };
    repo.create_with_deps(owner, &req, deps).await.expect("create dependent job")
}

/// Terminalize a job by RAW UPDATE, bypassing `repo.finish`/`fail` (so its
/// unblock/cascade scan never runs) — reproduces the post-crash state where a
/// dependency reached a terminal status but its dependents were left `blocked`.
async fn raw_set_terminal(pool: &PgPool, id: Uuid, status: &str) {
    sqlx::query("UPDATE jobs SET status = $2, finished_at = now() WHERE id = $1")
        .bind(id)
        .bind(status)
        .execute(pool)
        .await
        .expect("raw-terminalize job");
}

async fn status_of(pool: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read job status")
}

async fn error_of(pool: &PgPool, id: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read job error")
}

async fn started_at(pool: &PgPool, id: Uuid) -> Option<DateTime<Utc>> {
    sqlx::query_scalar("SELECT started_at FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read started_at")
}

async fn finished_at(pool: &PgPool, id: Uuid) -> Option<DateTime<Utc>> {
    sqlx::query_scalar("SELECT finished_at FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read finished_at")
}

/// Poll a job until its status is one of `wanted` (or panic on timeout).
async fn poll_status(pool: &PgPool, id: Uuid, wanted: &[&str], timeout: Duration) -> String {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let s = status_of(pool, id).await;
        if wanted.contains(&s.as_str()) {
            return s;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("job {id} did not reach {wanted:?} within {timeout:?} (last = {s})");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

// ------------------------------------------------------------------ TEST-21a

// A `blocked` job (unmet dependency) is NOT claimable — the scheduler never grabs
// it — and it unblocks to `queued`→runs only once its dependency `completed`.
#[tokio::test]
async fn blocked_job_not_claimed_then_unblocks_on_completion() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    // Root A (running, controllable) → child B depends on A.
    let a = insert_running_root(&pool, owner, "dag-A-root").await;
    let b = create_child(&repo, owner, "dag-B-dependent", &[a]).await.id;
    assert_eq!(status_of(&pool, b).await, "blocked", "a job with an incomplete dependency is born blocked");

    // The scheduler cannot claim a blocked job: a direct claim (the exact call the
    // scheduler makes) returns None — nothing is `queued` while B is blocked.
    assert!(
        repo.claim_next_fair(false, "dag-test", i64::MAX, i64::MAX)
            .await
            .expect("claim")
            .is_none(),
        "the blocked dependent is NOT claimable"
    );
    // Give the background scheduler a moment; B must still be blocked + unstarted.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(status_of(&pool, b).await, "blocked", "B stays blocked while A is unfinished");
    assert!(started_at(&pool, b).await.is_none(), "the blocked job never started");

    // A completes → B unblocks (blocked→queued) and the scheduler runs it to done.
    repo.finish(a, 0).await.expect("finish A");
    let terminal = poll_status(&pool, b, &["completed"], Duration::from_secs(45)).await;
    assert_eq!(terminal, "completed", "on A completing, B unblocked → queued → ran to completion");
    assert!(started_at(&pool, b).await.is_some(), "the unblocked job actually started");
}

// ------------------------------------------------------------------ TEST-21b

// A dependency reaching `failed` CASCADES to its dependents transitively
// (`dependency_failed`); they never run.
#[tokio::test]
async fn failed_dependency_cascades_transitively() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    // A (running) → B depends on A → C depends on B (a 2-hop chain).
    let a = insert_running_root(&pool, owner, "cascade-A-root").await;
    let b = create_child(&repo, owner, "cascade-B", &[a]).await.id;
    let c = create_child(&repo, owner, "cascade-C", &[b]).await.id;
    assert_eq!(status_of(&pool, b).await, "blocked", "B blocked on A");
    assert_eq!(status_of(&pool, c).await, "blocked", "C blocked on B (transitive)");

    // A fails → the failure cascades to B AND C (transitively) as dependency_failed.
    repo.fail(a, "boom").await.expect("fail A");

    assert_eq!(status_of(&pool, b).await, "failed", "direct dependent B cascaded to failed");
    assert_eq!(status_of(&pool, c).await, "failed", "transitive dependent C cascaded to failed");
    assert_eq!(error_of(&pool, b).await.as_deref(), Some("dependency_failed"), "B carries dependency_failed");
    assert_eq!(error_of(&pool, c).await.as_deref(), Some("dependency_failed"), "C carries dependency_failed");
    // Cascaded jobs never ran.
    assert!(started_at(&pool, b).await.is_none(), "cascaded B never started");
    assert!(started_at(&pool, c).await.is_none(), "cascaded C never started");
}

// ------------------------------------------------------------------ TEST-21c

// Diamond dependency A→B, A→C, B&C→D: D unblocks (and runs) ONLY after BOTH B and
// C complete — never after just one.
#[tokio::test]
async fn diamond_runs_join_only_after_both_branches() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let a = insert_running_root(&pool, owner, "diamond-A-root").await;
    let b = create_child(&repo, owner, "diamond-B", &[a]).await.id;
    let c = create_child(&repo, owner, "diamond-C", &[a]).await.id;
    let d = create_child(&repo, owner, "diamond-D-join", &[b, c]).await.id;
    assert_eq!(status_of(&pool, d).await, "blocked", "the join D is blocked on both branches");

    // A completes → B and C unblock (queued) and the scheduler drains them. When the
    // FIRST of B/C completes, D must still be blocked (its other dep is unfinished);
    // only when the SECOND completes does D unblock.
    repo.finish(a, 0).await.expect("finish A");

    // D runs to completion (join satisfied) — proves it eventually unblocked.
    poll_status(&pool, d, &["completed"], Duration::from_secs(60)).await;

    let b_fin = finished_at(&pool, b).await.expect("B finished");
    let c_fin = finished_at(&pool, c).await.expect("C finished");
    let d_start = started_at(&pool, d).await.expect("D started");
    assert!(
        d_start >= b_fin && d_start >= c_fin,
        "the join D started only AFTER both branches finished (D {d_start} >= B {b_fin}, C {c_fin})"
    );
}

// ----------------------------------------------------------- TEST-21c (race)

/// Wait until `pid`'s backend is BLOCKED on a lock, or `done` reports that its
/// statement already returned. Panics on timeout — if neither ever happens the
/// interleaving this test depends on did not materialize and any verdict it
/// reached would be meaningless.
async fn until_lock_blocked_or_done(pool: &PgPool, pid: i32, done: &std::sync::atomic::AtomicBool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if done.load(std::sync::atomic::Ordering::SeqCst) {
            return; // its unblock statement returned WITHOUT blocking
        }
        let waiting: Option<Option<String>> =
            sqlx::query_scalar("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1")
                .bind(pid)
                .fetch_optional(pool)
                .await
                .expect("read pg_stat_activity");
        if waiting.flatten().as_deref() == Some("Lock") {
            return; // it is parked on the dependent's row lock
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("second finisher (backend {pid}) neither blocked on a lock nor completed");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

// LOST UNBLOCK under READ COMMITTED (BUG 2), driven DETERMINISTICALLY.
//
// Diamond join D depends on B and C. Two CONCURRENT finishers each run the
// unblock scan in their own transaction. Under READ COMMITTED each statement
// reads a snapshot from its own start, so B's `NOT EXISTS` sees C incomplete and
// C's sees B incomplete — pre-fix, NEITHER unblocks D and D is stranded `blocked`
// forever.
//
// This does not HOPE the race fires: it constructs the exact interleaving with
// two explicit transactions and an observed hand-off, so it is red pre-fix and
// green post-fix every run. (The sibling
// `diamond_runs_join_only_after_both_branches` covers the same defect through the
// real scheduler, but only lands on the bad interleaving some of the time.)
#[tokio::test]
async fn concurrent_finishers_of_a_join_never_lose_the_unblock() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    // B and C are seeded `running` (never claimable by the scheduler), so this
    // test — not the background scheduler — owns exactly when each completes.
    let b = insert_running_root(&pool, owner, "lost-unblock-B").await;
    let c = insert_running_root(&pool, owner, "lost-unblock-C").await;
    let d = create_child(&repo, owner, "lost-unblock-D-join", &[b, c]).await.id;
    assert_eq!(status_of(&pool, d).await, "blocked", "the join D starts blocked on B and C");

    let mut tx1 = pool.begin().await.expect("begin tx1");
    let mut tx2 = pool.begin().await.expect("begin tx2");
    let tx2_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx2)
        .await
        .expect("tx2 backend pid");

    // Finisher 1: B completes and runs its unblock scan. C is still `running`, so
    // it must NOT unblock D — but it MUST leave D locked, uncommitted.
    // The return value is the owner of the row this call actually transitioned
    // (`None` = the guarded UPDATE matched nothing) — the caller's gate for the
    // post-commit `sync:dataset` emit. Asserted, not dropped: a silent `None` here
    // would mean the interleaving below is racing two no-ops.
    assert_eq!(
        JobRepository::finish_in_tx(&mut tx1, b, 0)
            .await
            .expect("finish B in tx1")
            .owner_id,
        Some(owner),
        "finishing the running B transitions it and reports its owner",
    );

    // Finisher 2: C completes and runs its unblock scan CONCURRENTLY, while tx1
    // is still open. Post-fix it parks on D's row lock; pre-fix it sails through
    // reading a snapshot in which B is not yet completed.
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done_task = done.clone();
    let h = tokio::spawn(async move {
        assert_eq!(
            JobRepository::finish_in_tx(&mut tx2, c, 0)
                .await
                .expect("finish C in tx2")
                .owner_id,
            Some(owner),
            "finishing the running C transitions it and reports its owner",
        );
        done_task.store(true, std::sync::atomic::Ordering::SeqCst);
        tx2.commit().await.expect("commit tx2");
    });

    until_lock_blocked_or_done(&pool, tx2_pid, &done).await;
    tx1.commit().await.expect("commit tx1");
    h.await.expect("second finisher task");

    // Both dependencies are `completed`; SOMEBODY had to unblock the join.
    let s = status_of(&pool, d).await;
    assert_ne!(
        s, "blocked",
        "D is stranded `blocked` after BOTH its dependencies completed — the \
         concurrent finishers each read a snapshot missing the other's commit and \
         both skipped the unblock (lost unblock under READ COMMITTED)"
    );
    // …and it is genuinely runnable, not merely re-labelled.
    poll_status(&pool, d, &["completed"], Duration::from_secs(45)).await;
}

// ------------------------------------------------------------------ TEST-21d

// Reconcile-at-birth, race-safe (FIX-1, lost-unblock TOCTOU): a dependent CREATED
// AFTER its dependency already `completed` is born `queued` (runnable), never
// stranded `blocked`. The `FOR UPDATE` on the locked dep status decides the born
// status from the already-terminal dep — the deterministic image of the
// create-vs-finish ordering race (dep terminalizes just before the edge lands).
#[tokio::test]
async fn dependent_born_queued_when_dep_already_completed() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    // A completes FIRST, then B is created depending on the completed A.
    let a = insert_running_root(&pool, owner, "born-queued-A").await;
    repo.finish(a, 0).await.expect("finish A before B is created");

    let b = create_child(&repo, owner, "born-queued-B", &[a]).await;
    assert_eq!(
        b.status, "queued",
        "a dependent created after its dep completed is born queued, not stranded blocked"
    );
    // It is genuinely runnable: the scheduler drains it to completion.
    poll_status(&pool, b.id, &["completed"], Duration::from_secs(45)).await;
    assert!(started_at(&pool, b.id).await.is_some(), "the queued-at-birth dependent ran");
}

// A dependent created AFTER its dependency already `failed` is born `failed`
// (`dependency_failed`) at birth — the cascade image of the same reconcile path.
#[tokio::test]
async fn dependent_born_failed_when_dep_already_failed() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let a = insert_running_root(&pool, owner, "born-failed-A").await;
    repo.fail(a, "boom before B is created").await.expect("fail A before B");

    let b = create_child(&repo, owner, "born-failed-B", &[a]).await;
    assert_eq!(b.status, "failed", "a dependent created after its dep failed is born failed");
    assert_eq!(b.error.as_deref(), Some("dependency_failed"), "born-failed carries dependency_failed");
    assert!(b.finished_at.is_some(), "the born-failed dependent is terminal (finished_at set)");
    assert!(started_at(&pool, b.id).await.is_none(), "the born-failed dependent never started");
}

// ------------------------------------------------------------------ TEST-21e

// Boot reconcile of STRANDED `blocked` jobs (FIX-2): after a crash, a dependency
// can be terminal while its dependents were never unblocked/cascaded (here forced
// via a RAW terminalize that bypasses the runtime unblock/cascade). One
// `reconcile_blocked_jobs()` pass QUEUES a blocked job whose deps ALL completed and
// CASCADE-FAILS one whose dep failed — and is idempotent on a second pass.
#[tokio::test]
async fn reconcile_blocked_jobs_queues_completed_and_fails_failed() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    // B_queue: blocked on A_ok, which we raw-terminalize to completed (no unblock).
    let a_ok = insert_running_root(&pool, owner, "reconcile-A-ok").await;
    let b_queue = create_child(&repo, owner, "reconcile-B-queue", &[a_ok]).await.id;
    // C_fail: blocked on A_bad, which we raw-terminalize to failed (no cascade).
    let a_bad = insert_running_root(&pool, owner, "reconcile-A-bad").await;
    let c_fail = create_child(&repo, owner, "reconcile-C-fail", &[a_bad]).await.id;
    assert_eq!(status_of(&pool, b_queue).await, "blocked", "B born blocked (A_ok still running)");
    assert_eq!(status_of(&pool, c_fail).await, "blocked", "C born blocked (A_bad still running)");

    // Strand both dependents: the deps go terminal WITHOUT the unblock/cascade.
    raw_set_terminal(&pool, a_ok, "completed").await;
    raw_set_terminal(&pool, a_bad, "failed").await;
    // (Still blocked — nothing has re-evaluated them yet.)
    assert_eq!(status_of(&pool, b_queue).await, "blocked", "B stranded blocked before reconcile");
    assert_eq!(status_of(&pool, c_fail).await, "blocked", "C stranded blocked before reconcile");

    let (cascaded, queued) = repo.reconcile_blocked_jobs().await.expect("reconcile blocked");
    assert_eq!(queued, 1, "one blocked-with-all-deps-completed job was queued");
    assert_eq!(cascaded, 1, "one blocked-with-failed-dep job was cascade-failed");

    // B is now runnable (queued, or already drained by the scheduler); C is failed.
    assert!(
        matches!(status_of(&pool, b_queue).await.as_str(), "queued" | "running" | "completed"),
        "the reconciled B became runnable"
    );
    assert_eq!(status_of(&pool, c_fail).await, "failed", "the reconciled C cascade-failed");
    assert_eq!(error_of(&pool, c_fail).await.as_deref(), Some("dependency_failed"), "C carries dependency_failed");
    assert!(started_at(&pool, c_fail).await.is_none(), "the cascade-failed C never started");

    // Idempotent: a second pass touches nothing (no blocked jobs remain).
    let (c2, q2) = repo.reconcile_blocked_jobs().await.expect("reconcile again");
    assert_eq!((c2, q2), (0, 0), "reconcile_blocked_jobs is idempotent");
}
