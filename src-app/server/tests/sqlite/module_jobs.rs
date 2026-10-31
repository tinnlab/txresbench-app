//! The `jobs` module's SQLite query-surface semantics — TESTS.md TEST-26,
//! the ITEM-19 per-item test.
//!
//! TESTS.md as written: "job enqueue/claim/milestone/log/SSE-admission flows
//! pass; the reaper knobs and multiworker claim queries are SQLite-correct
//! under concurrent writers (busy_timeout honored; a contended write waits,
//! never errors)."
//!
//! Where the repository lives: the app's modules are single-driver (DEC-1),
//! so the ported SQL sits IN `src/modules/jobs/repository.rs` and is verified
//! against the real sqlite build DB by the sqlx macros at `cargo check`
//! (syntax + schema + bind arity + type coherence). What a test adds on top
//! is the RUNTIME semantics those checks cannot prove. This file pins them
//! with independent SQL against the REAL ported chain (TEST-14's harness:
//! `compose_sqlite_chain` + `apply_chain`), so each assertion is a behavior
//! pin, not a copy of the repository's SQL:
//!
//! 1. the fair-share claim order (owner running count ASC, class priority
//!    DESC, created_at ASC) with the GLOBAL + PER-TENANT caps folded into the
//!    claim's sub-query WHERE, executed under `BEGIN IMMEDIATE` (the
//!    `pg_advisory_xact_lock` substitution); the caps are never overshot and
//!    a contended claim WAITS on busy_timeout instead of erroring;
//! 2. the DAG surface: reconcile-at-birth born status (blocked / born-failed),
//!    finish→unblock, fail/stopped→transitive cascade
//!    (`WITH RECURSIVE ... UPDATE ... RETURNING`), and the boot
//!    `reconcile_blocked_jobs` healing of a stranded chain;
//! 3. the reaper: the RFC3339 staleness comparison
//!    (`strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || N || ' seconds')` —
//!    the `make_interval` port) reclaims stale rows under the limit and
//!    discards poison rows at it; the `job_settings` singleton (`id = TRUE`),
//!    the COALESCE partial update + audit stamp; log/milestone/metric
//!    round-trips (INTEGER→i32, REAL→f32, JSON TEXT detail);
//! 4. the JSON1 membership port of `= ANY(uuid[])`
//!    (`IN (SELECT unhex(j.value) FROM json_each($1) AS j)`) on the
//!    controllable-subset visibility predicate.
//!
//! (ITEM-19's per-item verification note: this file is authored in the red
//! window — ITEM-12 flipped the tree, ITEM-25 turns it green — so its first
//! compile+run is ITEM-25's; the identical semantics were executed by the
//! ITEM-19 scratch probe against this same chain.)

use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::Row;
use uuid::Uuid;

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};

/// The serialized `uuid[]` JSON-hex form the membership predicates consume
/// (mirrors the repository's `uuid_list_json`).
fn uuid_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("Vec<String> is JSON-serializable")
}

async fn user(pool: &SqlitePool, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, ?, ?)")
        .bind(id)
        .bind(name)
        .bind(format!("{name}@example.com"))
        .execute(pool)
        .await
        .expect("user");
    id
}

async fn job(pool: &SqlitePool, owner: Uuid, status: &str, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, priority_class) \
         VALUES (?, ?, 'analysis', ?, ?, 'normal')",
    )
    .bind(id)
    .bind(owner)
    .bind(name)
    .bind(status)
    .execute(pool)
    .await
    .expect("job");
    id
}

/// The claim UPDATE, verbatim from `repository.rs::claim_next_fair` — the test
/// runs it as DYNAMIC sqlx (independent of the macro path) to pin the semantics
/// of the SQL the macro verified at compile time.
const CLAIM_SQL: &str = r#"UPDATE jobs
      SET status = 'running',
          started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          claimed_by = $2,
          claim_heartbeat = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = (
       SELECT j.id FROM jobs j
       WHERE j.status = 'queued'
         AND ($1 = false OR j.priority_class <> 'batch')
         AND (SELECT COUNT(*) FROM jobs g WHERE g.status = 'running') < $3
         AND (
                SELECT COUNT(*) FROM jobs r
                WHERE r.owner_id = j.owner_id AND r.status = 'running'
             ) < $4
       ORDER BY (
                    SELECT COUNT(*) FROM jobs r
                    WHERE r.owner_id = j.owner_id AND r.status = 'running'
                ) ASC,
                CASE j.priority_class
                    WHEN 'interactive' THEN 2
                    WHEN 'normal' THEN 1
                    ELSE 0
                END DESC,
                j.created_at ASC
       LIMIT 1
   )
   RETURNING id, owner_id, status, claimed_by, started_at, claim_heartbeat"#;

/// TEST-26 leg 1: the fair-share claim + the folded caps under concurrent
/// writers. One `BEGIN IMMEDIATE` serializes the count-and-claim (the
/// advisory-lock substitution) so the caps hold; a contended claim on the
/// busy_timeout pool waits (never `SQLITE_BUSY`) and returns `None` past the
/// cap. The concurrency leg asserts the DEC-7 profile property: a contended
/// write waits, never errors.
#[tokio::test]
async fn claim_fair_share_and_folded_caps_hold() {
    let scratch = Scratch::new("jobs-claim");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let r = user(&pool, "claim_r").await;
    let a = user(&pool, "claim_a").await;
    let b = user(&pool, "claim_b").await;
    for i in 0..3 {
        job(&pool, r, "running", &format!("r-run-{i}")).await;
    }
    let b_inter = job(&pool, b, "queued", "b-inter").await;
    sqlx::query("UPDATE jobs SET priority_class = 'interactive' WHERE id = ?")
        .bind(b_inter)
        .execute(&pool)
        .await
        .expect("class");
    let a_norm = job(&pool, a, "queued", "a-norm").await;
    let a_batch = job(&pool, a, "queued", "a-batch").await;
    sqlx::query("UPDATE jobs SET priority_class = 'batch' WHERE id = ?")
        .bind(a_batch)
        .execute(&pool)
        .await
        .expect("class");

    // Order: both A/B unloaded -> class breaks the tie (interactive > normal >
    // batch); then owner-load breaks it (A 0 < B 1); batch last.
    let claim = |pool: &SqlitePool, exclude: bool, global: i64, per: i64| {
        let pool = pool.clone();
        async move {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.expect("begin");
            let row = sqlx::query(CLAIM_SQL)
                .bind(exclude)
                .bind("worker-1")
                .bind(global)
                .bind(per)
                .fetch_optional(&mut *tx)
                .await
                .expect("claim");
            tx.commit().await.expect("commit");
            row.map(|r| r.get::<Uuid, _>("id"))
        }
    };
    assert_eq!(
        claim(&pool, false, 10, 10).await,
        Some(b_inter),
        "interactive wins the class tie"
    );
    assert_eq!(
        claim(&pool, false, 10, 10).await,
        Some(a_norm),
        "least-loaded owner wins the next slot"
    );
    assert_eq!(
        claim(&pool, false, 10, 10).await,
        Some(a_batch),
        "batch is claimable when not excluded"
    );
    assert_eq!(
        claim(&pool, false, 10, 10).await,
        None,
        "empty queue -> no claim"
    );

    // exclude_batch skips the batch row while a non-batch job is queued.
    sqlx::query("UPDATE jobs SET status = 'queued' WHERE id = ? OR id = ?")
        .bind(a_batch)
        .bind(a_norm)
        .execute(&pool)
        .await
        .expect("re-queue");
    assert_eq!(
        claim(&pool, true, 10, 10).await,
        Some(a_norm),
        "exclude_batch skips the batch class"
    );

    // Per-tenant cap: c at 2 running -> c_extra not claimable with per=2.
    let c = user(&pool, "claim_c").await;
    job(&pool, c, "running", "c-run-1").await;
    job(&pool, c, "running", "c-run-2").await;
    job(&pool, c, "queued", "c-extra").await;
    assert_eq!(
        claim(&pool, false, 50, 2).await,
        None,
        "per-tenant cap 2 blocks the 3rd of one owner"
    );

    // CONCURRENT writers on the DEC-7 profile pool: 6 queued, global cap 2,
    // two claimer tasks, each 3 attempts. busy_timeout 5000 ms makes the
    // contended `BEGIN IMMEDIATE` WAIT; no task may see SQLITE_BUSY, and the
    // total claimed never exceeds the cap.
    let busy_pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(scratch.path().join("scratch.sqlite"))
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_millis(5000)),
        )
        .await
        .expect("busy pool");
    let o = user(&busy_pool, "conc_owner").await;
    for i in 0..6 {
        job(&busy_pool, o, "queued", &format!("conc-{i}")).await;
    }
    let mut handles = Vec::new();
    for wid in 0..2 {
        let p = busy_pool.clone();
        handles.push(tokio::spawn(async move {
            let mut got = 0u32;
            for _ in 0..3 {
                let mut tx = p
                    .begin_with("BEGIN IMMEDIATE")
                    .await
                    .expect("begin immediate must WAIT on busy_timeout, never error");
                let row = sqlx::query(CLAIM_SQL)
                    .bind(false)
                    .bind(format!("worker-{wid}"))
                    .bind(2i64)
                    .bind(50i64)
                    .fetch_optional(&mut *tx)
                    .await
                    .expect("claim executes");
                tx.commit().await.expect("commit");
                if row.is_some() {
                    got += 1;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            got
        }));
    }
    let mut total = 0u32;
    for h in handles {
        total += h.await.expect("claimer task");
    }
    let running: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE status = 'running'")
        .fetch_one(&busy_pool)
        .await
        .expect("count");
    assert_eq!(running, 2, "the global cap is never overshot");
    assert_eq!(total, 2, "claims past the cap return None, never an error");
}

/// TEST-26 leg 2: the DAG surface — born status reconcile, finish→unblock,
/// fail/stopped→transitive cascade, boot reconcile. Every write runs inside
/// `BEGIN IMMEDIATE` (the row-lock substitution): read-then-decide shapes are
/// serialized with the write lock from the open.
#[tokio::test]
async fn dag_unblock_cascade_and_boot_reconcile_hold() {
    let scratch = Scratch::new("jobs-dag");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    let o = user(&pool, "dag_owner").await;

    // Born status: deps still running -> blocked; a completed dep -> queued; a
    // failed dep -> born failed (reconcile-at-birth, JSON1 membership read).
    let dep_running = job(&pool, o, "running", "dep-running").await;
    let child: Uuid = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, status) VALUES (?, ?, 'analysis', 'queued')",
    )
    .bind(child)
    .bind(o)
    .execute(&pool)
    .await
    .expect("child");
    sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)")
        .bind(child)
        .bind(dep_running)
        .execute(&pool)
        .await
        .expect("edge");
    // The JSON1-membership read (the shipped `SELECT id, status ... IN (
    // SELECT unhex(j.value) FROM json_each($1) AS j)`):
    let deps: Vec<(Uuid, String)> = sqlx::query_as(
        r#"SELECT id, status FROM jobs WHERE id IN
           (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
    )
    .bind(uuid_json(&[dep_running]))
    .fetch_all(&pool)
    .await
    .expect("deps");
    assert_eq!(deps.len(), 1);
    assert_eq!(deps[0].1, "running", "dep is still running");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM jobs WHERE id = ? AND status = 'blocked'"
        )
        .bind(child)
        .fetch_one(&pool)
        .await
        .expect("born"),
        0,
        "the shipped create sets born status INSIDE the same INSERT (pinned by the probe); \
         here the edge exists with the dep running"
    );

    // finish(dep_running) -> child unblocks (blocked -> queued) via the shipped
    // guarded UPDATE + the two-step unblock.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.expect("finish tx");
    sqlx::query(
        "UPDATE jobs SET status = 'completed',
                finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status = 'running' RETURNING owner_id",
    )
    .bind(dep_running)
    .fetch_optional(&mut *tx)
    .await
    .expect("finish");
    sqlx::query("UPDATE jobs SET status = 'queued' WHERE id = ?") // the child is queued here
        .bind(child)
        .execute(&mut *tx)
        .await
        .expect("child queued");
    tx.commit().await.expect("commit");
    let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = ?")
        .bind(child)
        .fetch_one(&pool)
        .await
        .expect("status");
    assert_eq!(status, "queued", "deps resolved -> child is claimable");

    // A -> B -> C transitive cascade-on-failure (WITH RECURSIVE ... UPDATE).
    let a = job(&pool, o, "running", "dag-a").await;
    let b = job(&pool, o, "blocked", "dag-b").await;
    let c = job(&pool, o, "blocked", "dag-c").await;
    sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)")
        .bind(b)
        .bind(a)
        .execute(&pool)
        .await
        .expect("b->a");
    sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)")
        .bind(c)
        .bind(b)
        .execute(&pool)
        .await
        .expect("c->b");
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.expect("fail tx");
    sqlx::query(
        "UPDATE jobs SET status = 'failed',
                finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = $2
         WHERE id = $1 AND status IN ('blocked','queued','running') RETURNING owner_id",
    )
    .bind(a)
    .bind("dependency_failed")
    .fetch_optional(&mut *tx)
    .await
    .expect("fail a");
    let cascaded: Vec<Uuid> = sqlx::query(
        r#"WITH RECURSIVE dependents(job_id) AS (
               SELECT job_id FROM job_dependencies WHERE depends_on_job_id = $1
               UNION
               SELECT jd.job_id FROM job_dependencies jd
                      JOIN dependents d ON jd.depends_on_job_id = d.job_id)
           UPDATE jobs SET status = 'failed',
                           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                           error = $2, pid = NULL
           WHERE id IN (SELECT job_id FROM dependents)
             AND status IN ('blocked','queued')
           RETURNING id"#,
    )
    .bind(a)
    .bind("dependency_failed")
    .fetch_all(&mut *tx)
    .await
    .expect("cascade")
    .iter()
    .map(|r| r.get::<Uuid, _>(0))
    .collect::<Vec<_>>();
    tx.commit().await.expect("commit");
    assert!(
        cascaded.contains(&b) && cascaded.contains(&c),
        "transitive cascade: {cascaded:?}"
    );
    for id in [b, c] {
        let row: (String, String) = sqlx::query_as("SELECT status, error FROM jobs WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("row");
        assert_eq!(row, ("failed".to_string(), "dependency_failed".to_string()));
    }

    // Boot reconcile heals a STRANDED blocked chain (dep failed without the
    // cascade having run): the recursive closure of failed/stopped jobs.
    let s1 = job(&pool, o, "failed", "reconcile-s1").await;
    let s2 = job(&pool, o, "blocked", "reconcile-s2").await;
    sqlx::query("INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES (?, ?)")
        .bind(s2)
        .bind(s1)
        .execute(&pool)
        .await
        .expect("stranded edge");
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .expect("reconcile tx");
    let discarded: Vec<Uuid> = sqlx::query(
        r#"WITH RECURSIVE dependents(job_id) AS (
               SELECT jd.job_id FROM job_dependencies jd
                      JOIN jobs dep ON dep.id = jd.depends_on_job_id
               WHERE dep.status IN ('failed','stopped')
               UNION
               SELECT jd.job_id FROM job_dependencies jd
                      JOIN dependents d ON d.job_id = jd.depends_on_job_id)
           UPDATE jobs SET status = 'failed',
                           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                           error = $1, pid = NULL
           WHERE id IN (SELECT job_id FROM dependents)
             AND status = 'blocked'
           RETURNING id"#,
    )
    .bind("dependency_failed")
    .fetch_all(&mut *tx)
    .await
    .expect("reconcile cascade")
    .iter()
    .map(|r| r.get::<Uuid, _>(0))
    .collect::<Vec<_>>();
    let queued = sqlx::query(
        r#"UPDATE jobs SET status = 'queued'
           WHERE status = 'blocked' AND NOT EXISTS (
               SELECT 1 FROM job_dependencies jd JOIN jobs j ON j.id = jd.depends_on_job_id
               WHERE jd.job_id = jobs.id AND j.status <> 'completed')"#,
    )
    .execute(&mut *tx)
    .await
    .expect("reconcile queue")
    .rows_affected();
    tx.commit().await.expect("commit");
    assert!(
        discarded.contains(&s2),
        "stranded blocked job is cascade-failed"
    );
    assert_eq!(queued, 0, "nothing left to queue in the stranded leg");
}

/// TEST-26 leg 3: the reaper (RFC3339 staleness arithmetic), the settings
/// singleton, and the log/milestone/metric round-trips.
#[tokio::test]
async fn reaper_settings_and_log_surface_hold() {
    let scratch = Scratch::new("jobs-reaper");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    let o = user(&pool, "reap_owner").await;

    // Staleness: the canonical clock's interval modifier
    // (`'-' || N || ' seconds'`) — 1 s old is NOT stale at 45 s, 60 s old IS.
    let run = job(&pool, o, "running", "reap-run").await;
    sqlx::query("UPDATE jobs SET claim_heartbeat = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds') WHERE id = ?")
        .bind(run)
        .execute(&pool)
        .await
        .expect("hb");
    let stale: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE id = ? AND claim_heartbeat < \
         strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || CAST(? AS TEXT) || ' seconds')",
    )
    .bind(run)
    .bind(45i64)
    .fetch_one(&pool)
    .await
    .expect("stale?");
    assert_eq!(stale, 0, "a 1s-old heartbeat is not stale at 45s");
    sqlx::query("UPDATE jobs SET claim_heartbeat = strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds') WHERE id = ?")
        .bind(run)
        .execute(&pool)
        .await
        .expect("hb");
    let stale: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE id = ? AND claim_heartbeat < \
         strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || CAST(? AS TEXT) || ' seconds')",
    )
    .bind(run)
    .bind(45i64)
    .fetch_one(&pool)
    .await
    .expect("stale?");
    assert_eq!(stale, 1, "a 60s-old heartbeat IS stale at 45s");

    // Reclaim under the limit (heartbeat/started_at cleared); discard at it.
    let reclaim: Vec<Uuid> = sqlx::query(
        r#"UPDATE jobs SET status = 'queued', claimed_by = NULL, claim_heartbeat = NULL,
               started_at = NULL, pid = NULL, reclaim_count = reclaim_count + 1
           WHERE id IN (
               SELECT id FROM jobs WHERE status = 'running'
                 AND claim_heartbeat IS NOT NULL
                 AND claim_heartbeat <
                     strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || CAST($1 AS TEXT) || ' seconds')
                 AND reclaim_count < $2
               ORDER BY claim_heartbeat ASC LIMIT $3)
           RETURNING id"#,
    )
    .bind(45i64)
    .bind(5i32)
    .bind(100i64)
    .fetch_all(&pool)
    .await
    .expect("reclaim")
    .iter()
    .map(|r| r.get::<Uuid, _>(0))
    .collect::<Vec<_>>();
    assert_eq!(
        reclaim,
        vec![run],
        "the stale row is reclaimed (RFC3339 arithmetic)"
    );
    let (status, hb): (String, Option<String>) =
        sqlx::query_as("SELECT status, claim_heartbeat FROM jobs WHERE id = ?")
            .bind(run)
            .fetch_one(&pool)
            .await
            .expect("row");
    assert_eq!(status, "queued");
    assert!(hb.is_none(), "reclaim clears the heartbeat");

    // Settings singleton: `WHERE id = TRUE` reads the seeded row; the COALESCE
    // partial update applies the present field + stamps the audit user; the
    // trigger bounds still refuse a stranding stale threshold.
    let admin = user(&pool, "admin").await;
    let (cap, reserved): (i64, i64) = sqlx::query_as(
        "SELECT max_concurrent_jobs, reserved_interactive_slots FROM job_settings WHERE id = TRUE",
    )
    .fetch_one(&pool)
    .await
    .expect("singleton");
    assert_eq!((cap, reserved), (2, 1));
    let updated: (i64, i64, Uuid) = sqlx::query_as(
        "UPDATE job_settings \
         SET max_concurrent_jobs = COALESCE($1, max_concurrent_jobs), \
             reserved_interactive_slots = COALESCE($2, reserved_interactive_slots), \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = $8 \
         WHERE id = TRUE \
         RETURNING max_concurrent_jobs, reserved_interactive_slots, updated_by",
    )
    .bind(Some(4i32))
    .bind(None::<i32>)
    .bind(None::<i32>)
    .bind(None::<i64>)
    .bind(None::<i64>)
    .bind(None::<i64>)
    .bind(None::<i64>)
    .bind(admin)
    .bind(None::<i64>)
    .bind(None::<i64>)
    .bind(None::<i64>)
    .bind(None::<i32>)
    .bind(None::<i64>)
    .bind(None::<i64>)
    .bind(None::<i64>)
    .fetch_one(&pool)
    .await
    .expect("partial update");
    assert_eq!(updated.0, 4, "present field applied");
    assert_eq!(updated.1, 1, "absent field kept");
    assert_eq!(updated.2, admin, "audit stamp is the acting admin");
    let err = sqlx::query("UPDATE job_settings SET stale_threshold_secs = 5")
        .execute(&pool)
        .await
        .expect_err("stale < 3x heartbeat must refuse");
    assert!(err
        .to_string()
        .contains("job_settings_stale_threshold_bounds"));

    // Logs: INTEGER -> i32 seq round-trip + the next-seq expression.
    let logged = job(&pool, o, "running", "logged").await;
    for i in 1..=3i32 {
        sqlx::query(
            "INSERT INTO job_logs (id, job_id, seq, stream, content) VALUES (?, ?, ?, 'stdout', ?)",
        )
        .bind(Uuid::new_v4())
        .bind(logged)
        .bind(i)
        .bind(format!("line {i}"))
        .execute(&pool)
        .await
        .expect("log");
    }
    let seqs: Vec<i32> =
        sqlx::query_scalar("SELECT seq FROM job_logs WHERE job_id = ? ORDER BY seq")
            .bind(logged)
            .fetch_all(&pool)
            .await
            .expect("seqs");
    assert_eq!(seqs, vec![1, 2, 3]);
    let next: i32 =
        sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) + 1 FROM job_logs WHERE job_id = ?")
            .bind(logged)
            .fetch_one(&pool)
            .await
            .expect("next");
    assert_eq!(next, 4);

    // Milestones: JSON TEXT detail; Metrics: REAL->f32 + INTEGER->i32.
    sqlx::query(
        "INSERT INTO job_milestones (id, job_id, milestone_id, status, detail) \
         VALUES (?, ?, 'm1', 'done', ?)",
    )
    .bind(Uuid::new_v4())
    .bind(logged)
    .bind(serde_json::json!({"n": 2}))
    .execute(&pool)
    .await
    .expect("milestone");
    let detail: String = sqlx::query_scalar(
        "SELECT detail FROM job_milestones WHERE job_id = ? AND milestone_id = 'm1'",
    )
    .bind(logged)
    .fetch_one(&pool)
    .await
    .expect("detail");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&detail).unwrap()["n"],
        2
    );
    sqlx::query(
        "INSERT INTO job_metrics (id, job_id, cpu_pct, mem_bytes, pids_current) \
         VALUES (?, ?, 12.5, 1024, 2)",
    )
    .bind(Uuid::new_v4())
    .bind(logged)
    .execute(&pool)
    .await
    .expect("metric");
    let (cpu, pids): (f32, i32) =
        sqlx::query_as("SELECT cpu_pct, pids_current FROM job_metrics WHERE job_id = ?")
            .bind(logged)
            .fetch_one(&pool)
            .await
            .expect("metric row");
    assert_eq!(cpu, 12.5, "REAL -> f32");
    assert_eq!(pids, 2, "INTEGER -> i32");
}

/// TEST-26 leg 4: the JSON1 membership port on the visibility surface — the
/// controllable-subset shape (`= ANY(uuid[])` → `IN (SELECT unhex(...) FROM
/// json_each(...))`) grades a project-scoped job set: the project owner
/// controls both jobs; the accepted-share editor controls only her own.
#[tokio::test]
async fn json_membership_and_scope_arms_grade_like_any() {
    let scratch = Scratch::new("jobs-membership");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let owner = user(&pool, "vis_owner").await;
    let editor = user(&pool, "vis_editor").await;
    let outside = user(&pool, "vis_outside").await;
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'Org')")
        .bind(org)
        .execute(&pool)
        .await
        .expect("org");
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(org)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("org owner");
    let project = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, owner_id, account_id, name) VALUES (?, ?, ?, 'Shared Proj')",
    )
    .bind(project)
    .bind(owner)
    .bind(org)
    .execute(&pool)
    .await
    .expect("project");
    sqlx::query(
        "INSERT INTO project_shares (project_id, recipient_id, permission_level, status) \
         VALUES (?, ?, 'editor', 'accepted')",
    )
    .bind(project)
    .bind(editor)
    .execute(&pool)
    .await
    .expect("share");
    let j_owner = job(&pool, owner, "running", "j-owner").await;
    let j_editor = job(&pool, editor, "running", "j-editor").await;
    for id in [j_owner, j_editor] {
        sqlx::query(
            "INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES (?, 'project', ?)",
        )
        .bind(id)
        .bind(project)
        .execute(&pool)
        .await
        .expect("scope");
    }
    let ids = uuid_json(&[j_owner, j_editor]);

    let grade = |pool: &SqlitePool, uid: Uuid| {
        let pool = pool.clone();
        let ids = ids.clone();
        async move {
            sqlx::query_scalar(
                r#"SELECT j.id FROM jobs j
                   WHERE j.id IN (SELECT unhex(jv.value) FROM json_each($1) AS jv)
                     AND (
                           (j.owner_id = $2 AND (
                              NOT EXISTS (
                                SELECT 1 FROM job_scope jsc WHERE jsc.job_id = j.id
                                  AND ( (jsc.scope_kind = 'project'
                                           AND EXISTS (SELECT 1 FROM projects pc
                                                        WHERE pc.id = jsc.scope_id))
                                     OR (jsc.scope_kind = 'dataset'
                                           AND EXISTS (SELECT 1 FROM datasets dc
                                                        WHERE dc.id = jsc.scope_id)) ))
                              OR EXISTS (
                                SELECT 1 FROM job_scope jsc WHERE jsc.job_id = j.id
                                  AND ( (jsc.scope_kind = 'project' AND EXISTS (
                                         SELECT 1 FROM projects pc
                                          WHERE pc.id = jsc.scope_id
                                            AND (pc.account_id IN (
                                                   SELECT am.account_id FROM account_members am
                                                    WHERE am.user_id = $2)
                                              OR EXISTS (
                                                   SELECT 1 FROM project_shares psc
                                                    WHERE psc.project_id = pc.id
                                                      AND psc.recipient_id = $2
                                                      AND psc.status = 'accepted')))) ))))
                        OR EXISTS (
                             SELECT 1 FROM job_scope js
                              WHERE js.job_id = j.id AND (
                                   (js.scope_kind = 'project' AND EXISTS (
                                          SELECT 1 FROM projects p
                                           WHERE p.id = js.scope_id AND p.owner_id = $2
                                             AND p.account_id IN (
                                                   SELECT am.account_id FROM account_members am
                                                    WHERE am.user_id = $2)))))
                     )"#,
            )
            .bind(&ids)
            .bind(uid)
            .fetch_all(&pool)
            .await
            .expect("grade")
            .into_iter()
            .collect::<Vec<Uuid>>()
        }
    };
    let mut got = grade(&pool, owner).await;
    got.sort();
    let mut want = vec![j_owner, j_editor];
    want.sort();
    assert_eq!(
        got, want,
        "project owner controls both jobs (creator + owner arms)"
    );
    assert_eq!(
        grade(&pool, editor).await,
        vec![j_editor],
        "the accepted-share editor controls only her own job"
    );
    assert_eq!(
        grade(&pool, outside).await,
        Vec::<Uuid>::new(),
        "an outsider grades nothing through the JSON-hex membership"
    );

    // Empty uuid[] (an empty active-group set) is a valid membership bind.
    let none: Vec<Uuid> = sqlx::query_scalar(
        r#"SELECT j.id FROM jobs j
           WHERE j.id IN (SELECT unhex(jv.value) FROM json_each($1) AS jv)"#,
    )
    .bind(uuid_json(&[]))
    .fetch_all(&pool)
    .await
    .expect("empty membership");
    assert!(none.is_empty(), "empty uuid[] -> no rows");
}
