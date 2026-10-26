//! The `jobs` chain invariants — TESTS.md TEST-15, the ITEM-8 per-item test.
//!
//! Test-15: "the `jobs` chain applies and the scheduler-critical invariants
//! hold on SQLite: `job_settings` singleton pin, `job_dependencies` FK
//! cascade, `job_logs(job_id, seq)` index, `ON CONFLICT` seed idempotence."
//!
//! The chain is the REAL merged chain (composed + applied by the shared
//! harness in `apply_chain.rs`, the same code path the build and the runtime
//! use), so this file's job is the jobs-specific semantics — the four
//! invariants above plus the scheduler-reaper bound triggers (the one
//! construct the port had to enforce with triggers rather than declarative
//! DDL, so it gets its own pin).

use sqlx::Row;

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};

/// TEST-15 (ITEM-8): the four scheduler-critical invariants — the `job_settings`
/// singleton cannot be doubled, the seed INSERT is idempotent under `ON
/// CONFLICT DO NOTHING` (re-running the seed leaves exactly one row), a job
/// delete cascades to its dependency rows, and the
/// `idx_job_logs_job_seq` index exists with the `(job_id, seq)` column pair.
#[tokio::test]
async fn job_settings_singleton_seed_cascade_and_log_index_hold() {
    let scratch = Scratch::new("jobs-invariants");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // --- singleton pin (CONSTRAINT job_settings_singleton CHECK (id = 1)) --
    let err = sqlx::query("INSERT INTO job_settings (id) VALUES (2)")
        .execute(&pool)
        .await
        .expect_err("a second job_settings row must be refused");
    assert!(
        err.to_string().contains("job_settings_singleton"),
        "the refusal must name the singleton constraint: {err}"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM job_settings")
        .fetch_one(&pool)
        .await
        .expect("job_settings");
    assert_eq!(count, 1, "exactly one row after the refused insert");

    // --- ON CONFLICT seed idempotence ----------------------------------
    // The baseline's seed statement, run again verbatim, must leave the
    // seeded values intact (the scheduler reads them on every boot).
    sqlx::query(
        "INSERT INTO job_settings (id, max_concurrent_jobs, reserved_interactive_slots) \
         VALUES (1, 2, 1) ON CONFLICT (id) DO NOTHING",
    )
    .execute(&pool)
    .await
    .expect("re-run seed");
    let (max_concurrent, reserved, sse_max): (i64, i64, i64) = sqlx::query_as(
        "SELECT max_concurrent_jobs, reserved_interactive_slots, sse_max_clients FROM job_settings",
    )
    .fetch_one(&pool)
    .await
    .expect("job_settings row");
    assert_eq!(max_concurrent, 2, "seed values survive the re-run");
    assert_eq!(reserved, 1);
    assert_eq!(
        sse_max, 256,
        "scheduler defaults come from the migration chain"
    );

    // --- job_dependencies FK cascade -----------------------------------
    let owner = uuid::Uuid::new_v4();
    let job_a = uuid::Uuid::new_v4();
    let job_b = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'dep_owner', 'dep@x.io')")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("owner");
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type) VALUES (?, ?, 'probe')")
        .bind(job_a)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("job a");
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type) VALUES (?, ?, 'probe')")
        .bind(job_b)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("job b");
    sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)")
        .bind(job_a)
        .bind(job_b)
        .execute(&pool)
        .await
        .expect("dep a -> b");
    sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)")
        .bind(job_b)
        .bind(job_a)
        .execute(&pool)
        .await
        .expect("dep b -> a");
    // Dependency rows cascade when the DEPENDENCY (not merely the job) is gone.
    sqlx::query("DELETE FROM jobs WHERE id = ?")
        .bind(job_b)
        .execute(&pool)
        .await
        .expect("delete job b");
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM job_dependencies WHERE job_id = ?")
            .bind(job_a)
            .fetch_one(&pool)
            .await
            .expect("deps");
    assert_eq!(
        remaining, 0,
        "job_dependencies cascade on the referenced job"
    );
    // The self-reference CHECK is live too (the constraint's own invariant).
    let err = sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)")
        .bind(job_a)
        .bind(job_a)
        .execute(&pool)
        .await
        .expect_err("a job cannot depend on itself");
    assert!(
        err.to_string().contains("job_dependencies_check"),
        "self-dependency must be refused: {err}"
    );

    // --- idx_job_logs_job_seq: exists, keyed on (job_id, seq) -----------
    let idx: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_job_logs_job_seq'",
    )
    .fetch_one(&pool)
    .await
    .expect("index lookup");
    assert_eq!(idx, 1, "idx_job_logs_job_seq exists");
    // index_xinfo lists (seqno, cid, name, desc, coll, key): the key columns
    // carry key = 1 (the B-tree's rowid aux column carries key = 0); the
    // index tuple must be (job_id, seq).
    let cols: Vec<(i64, String, i64)> = sqlx::query("PRAGMA index_xinfo('idx_job_logs_job_seq')")
        .fetch_all(&pool)
        .await
        .expect("index columns")
        .iter()
        .map(|r| (r.get(0), r.get(2), r.get(5)))
        .filter(|(_, _, key)| *key == 1)
        .collect();
    assert_eq!(
        cols,
        vec![(0, "job_id".to_string(), 1), (1, "seq".to_string(), 1)]
    );

    // --- the reaper's cross-field bound (trigger port) ------------------
    // `stale_threshold_secs >= 3 * heartbeat_secs` (the INV-4 guardrail):
    // a stale threshold below 3× the heartbeat must be refused on any row
    // write, in either column's direction.
    let err = sqlx::query("UPDATE job_settings SET stale_threshold_secs = 5")
        .execute(&pool)
        .await
        .expect_err("stale threshold below 3x heartbeat must be refused");
    assert!(
        err.to_string()
            .contains("job_settings_stale_threshold_bounds"),
        "the reaper bound names its constraint: {err}"
    );
    let err = sqlx::query("UPDATE job_settings SET heartbeat_secs = 60")
        .execute(&pool)
        .await
        .expect_err("raising the heartbeat above stale/3 must be refused");
    assert!(
        err.to_string()
            .contains("job_settings_stale_threshold_bounds"),
        "the reaper bound fires from the heartbeat side too: {err}"
    );
    // In-bounds values still apply (the triggers never block a valid write).
    sqlx::query("UPDATE job_settings SET stale_threshold_secs = 120")
        .execute(&pool)
        .await
        .expect("valid stale threshold applies");
    let stale: i64 = sqlx::query_scalar("SELECT stale_threshold_secs FROM job_settings")
        .fetch_one(&pool)
        .await
        .expect("stale");
    assert_eq!(stale, 120);

    // --- the SSE admission cross-field bound (trigger port) -------------
    // `admission_poll_ms < admission_wait_secs * 1000`: a poll that no longer
    // fits the budget must be refused from either column's side.
    sqlx::query("UPDATE job_settings SET admission_poll_ms = 1000")
        .execute(&pool)
        .await
        .expect("poll 1000 fits the 15s default wait");
    let err = sqlx::query("UPDATE job_settings SET admission_wait_secs = 1")
        .execute(&pool)
        .await
        .expect_err("shrinking the wait below poll/1000 must be refused");
    assert!(
        err.to_string()
            .contains("job_settings_admission_poll_bounds"),
        "the admission bound names its constraint: {err}"
    );

    // --- the settings singleton survives (the whole row is sane) --------
    let (per_tenant, dispatch, metric): (i64, i64, i64) = sqlx::query_as(
        "SELECT per_tenant_max_concurrent, dispatch_tick_ms, metric_tick_secs FROM job_settings",
    )
    .fetch_one(&pool)
    .await
    .expect("job_settings defaults");
    assert_eq!(per_tenant, 2);
    assert_eq!(dispatch, 500);
    assert_eq!(metric, 1);
}

/// The exact-once meter invariant is part of the jobs chain's scheduler
/// contract (INV-5): a re-emit of the same finished run collapses via
/// `ON CONFLICT (job_id) DO NOTHING`, so a live finalize and a boot
/// re-finalize never double-count.
#[tokio::test]
async fn compute_meter_emits_exactly_once_per_job() {
    let scratch = Scratch::new("jobs-meter");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // The metering ledger carries NO FK by design (it must outlive the job it
    // accounts for), so only the natural key is needed.
    let job = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO compute_meter (job_id, cpu_secs, wall_secs, exit_code) \
         VALUES (?, 1.5, 10, 0)",
    )
    .bind(job)
    .execute(&pool)
    .await
    .expect("first emit");
    let r = sqlx::query(
        "INSERT INTO compute_meter (job_id, cpu_secs, wall_secs, exit_code) \
         VALUES (?, 99, 99, 1) ON CONFLICT (job_id) DO NOTHING",
    )
    .bind(job)
    .execute(&pool)
    .await
    .expect("boot re-finalize");
    assert_eq!(r.rows_affected(), 0, "re-emit is a no-op");
    let (cpu, wall, exit): (f64, f64, i64) =
        sqlx::query_as("SELECT cpu_secs, wall_secs, exit_code FROM compute_meter WHERE job_id = ?")
            .bind(job)
            .fetch_one(&pool)
            .await
            .expect("meter row");
    assert_eq!((cpu, wall, exit), (1.5, 10.0, 0), "first writer wins");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM compute_meter")
        .fetch_one(&pool)
        .await
        .expect("meter count");
    assert_eq!(count, 1);
}
