//! **A failed job must carry its reason in its own log stream.**
//!
//! `job_logs` has exactly ONE writer on the live path — `scheduler.rs::append`, driven by
//! the stdout/stderr pump over a LIVE child process. So a job that fails with NO child
//! ever produced zero log lines, and its only explanation lived in the `jobs.error`
//! column: a separate field that the log pane does not render and that no SSE follower
//! ever receives. The measured consequence is a job that ends `failed` with an empty log
//! and a frontend left to reconcile two channels by string heuristics.
//!
//! Six writers of `jobs.error` cannot have produced a log line, because in each of them
//! no child process ever ran:
//!
//! | writer | why there is no child |
//! |---|---|
//! | `scheduler.rs` arch gate | refused BEFORE any spawn |
//! | `scheduler.rs` staging ceiling | the spawn itself timed out |
//! | `repository.rs::cascade_fail_dependents` | the dependent never ran |
//! | `repository.rs::reconcile_blocked_jobs` | boot cascade over a stranded `blocked` job |
//! | `repository.rs::create_with_deps` (born failed) | the job was failed at birth |
//! | `scheduler.rs` boot reconcile | the process that would have logged it is the one that died |
//!
//! Every test below drives a REAL writer (the HTTP+scheduler path where one exists, the
//! repository primitive otherwise) and asserts the reason reached `job_logs` as a
//! terminal `stderr` line, VERBATIM.
//!
//! **Verbatim is load-bearing, not cosmetic.** The detail pane decides whether to render
//! the standalone `error` block by asking whether the log already ends with it; a
//! paraphrased or prefixed log line makes that test false and the reason renders twice.
//! `the_appended_line_is_the_error_verbatim_so_a_reader_cannot_double_render_it` pins it.

use std::time::Duration;

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::models::{CreateJobRequest, Job};
use cytoanalyst::modules::jobs::repository::{JobRepository, DEPENDENCY_FAILED};

use super::{create_job_full, poll_until, pool_for, register_user, setup_admin};
use crate::common::TestServer;

// ------------------------------------------------------------------ helpers

async fn admin_owner(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(pool)
        .await
        .expect("an admin user exists after setup")
}

/// Seed a controllable job directly as `running` — the scheduler only claims
/// `queued`, so it is never grabbed out from under the test (the `dag_test`
/// pattern).
async fn insert_running(pool: &PgPool, owner: Uuid, name: &str) -> Uuid {
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
    .expect("insert running job");
    id
}

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
    repo.create_with_deps(owner, &req, deps)
        .await
        .expect("create dependent job")
}

/// Every `(seq, stream, content)` line a job logged, oldest first.
async fn log_lines(repo: &JobRepository, id: Uuid) -> Vec<(i32, String, String)> {
    repo.list_logs(id)
        .await
        .expect("read job logs")
        .into_iter()
        .map(|l| (l.seq, l.stream, l.content))
        .collect()
}

async fn error_of(pool: &PgPool, id: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read job error")
}

/// The reason a job's log ENDS with — the terminal explanation a reader meets last.
/// Panics with the whole log when there is none, because "the log is empty" is the
/// exact defect these tests exist to catch and a bare `unwrap` would hide it.
fn terminal_stderr(lines: &[(i32, String, String)], what: &str) -> String {
    let last = lines.last().unwrap_or_else(|| {
        panic!("{what}: the job logged NOTHING, so its failure has no explanation a reader can see")
    });
    assert_eq!(
        last.1, "stderr",
        "{what}: the terminal reason must land on the STDERR stream — a failure reason on \
         stdout reads as ordinary output: {lines:?}"
    );
    last.2.clone()
}

// ------------------------------------------------- the direct `fail()` chokepoint

/// The two `scheduler.rs` pre-spawn refusals (arch-incompatible, staging ceiling) and the
/// two boot-reconcile refusals all reach the SAME writer: `JobRepository::fail`. Asserting
/// on that writer covers all four, and covers the fifth author who adds a call site later.
#[tokio::test]
async fn a_job_failed_with_no_child_explains_itself_in_its_own_log() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let id = insert_running(&pool, owner, "no-child").await;
    // Verbatim one of the real messages (`scheduler.rs`'s arch gate).
    let reason = "arch-incompatible: requires an x86_64 backend";
    repo.fail(id, reason).await.expect("fail the job");

    let lines = log_lines(&repo, id).await;
    assert_eq!(
        terminal_stderr(&lines, "no-child fail"),
        reason,
        "the reason a job failed must reach the LOG, not only the `error` column: {lines:?}"
    );
    assert_eq!(
        lines.len(),
        1,
        "exactly one line — the reason, once: {lines:?}"
    );
    assert_eq!(
        error_of(&pool, id).await.as_deref(),
        Some(reason),
        "…and the `error` column still carries it (this ADDS a channel, it replaces none)"
    );
}

/// The appended line is the error string BYTE-FOR-BYTE.
///
/// A reader that already renders `job.error` decides whether the standalone error block is
/// still needed by asking whether the log already ends with it. Prefixing the log line
/// (`"job failed: …"`) or paraphrasing it makes that question answer "no" and the same
/// sentence renders twice — the duplication this whole change is supposed to retire.
#[tokio::test]
async fn the_appended_line_is_the_error_verbatim_so_a_reader_cannot_double_render_it() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let id = insert_running(&pool, owner, "verbatim").await;
    let reason = "job runner did not start a process within 35s (staging ceiling); failing \
                  the job rather than leaving it running forever";
    repo.fail(id, reason).await.expect("fail the job");

    let lines = log_lines(&repo, id).await;
    let logged = terminal_stderr(&lines, "verbatim");
    let error = error_of(&pool, id).await.expect("error column written");
    assert_eq!(logged, error, "the logged line IS the error, verbatim");
    // The exact predicate the detail pane applies.
    assert!(
        error.ends_with(logged.trim()),
        "a reader asking `error.endsWith(lastStderrLine)` must get TRUE, or it renders the \
         reason a second time: error={error:?} logged={logged:?}"
    );
}

/// A second `fail()` on an ALREADY-terminal job transitions nothing, so it must log
/// nothing. Without this, a retry loop or a racing caller would append the same reason
/// repeatedly to a job that never changed state.
#[tokio::test]
async fn failing_an_already_terminal_job_logs_nothing() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let id = insert_running(&pool, owner, "double-fail").await;
    repo.fail(id, "the first reason").await.expect("first fail");
    let after_first = log_lines(&repo, id).await;
    assert_eq!(after_first.len(), 1, "the transition logged its reason");

    repo.fail(id, "a second reason for a job that already failed")
        .await
        .expect("second fail is a no-op, not an error");

    assert_eq!(
        log_lines(&repo, id).await,
        after_first,
        "a fail that transitioned NOTHING must log nothing — the log is a record of \
         transitions, not of attempts"
    );
    assert_eq!(
        error_of(&pool, id).await.as_deref(),
        Some("the first reason"),
        "…matching the guarded UPDATE, which also kept the first reason"
    );
}

/// **The opt-out, and the reason it exists.**
///
/// A failed ANALYSIS had a child, and `scheduler::with_stderr_tail` builds its terminal
/// `error` by folding that child's last stderr lines into the reason — so its log ALREADY
/// carries them, in full and in order. Appending the fold back would print the tail a
/// second time, joined by `" | "` and truncated: a lossy duplicate of what is already
/// there, in the one place a reader is looking.
///
/// The negative control is the test above: the SAME repository, the same job shape, the
/// default `fail` — which does append. So this test cannot pass by the append machinery
/// having quietly stopped working.
#[tokio::test]
async fn a_reason_the_log_already_carries_is_not_appended_a_second_time() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let id = insert_running(&pool, owner, "folded").await;
    // What the child printed, as the scheduler's pump would have persisted it.
    for (seq, line) in [
        (1, "Traceback (most recent call last):"),
        (2, "OSError: bad file"),
    ] {
        repo.append_log(id, seq, "stderr", line)
            .await
            .expect("seed a child's stderr line");
    }
    let before = log_lines(&repo, id).await;

    // The shape `with_stderr_tail` produces: reason + ": " + the trimmed lines joined.
    let folded =
        "analysis exited with code 1: Traceback (most recent call last): | OSError: bad file";
    repo.fail_reason_already_logged(id, folded)
        .await
        .expect("fail with an already-logged reason");

    assert_eq!(
        log_lines(&repo, id).await,
        before,
        "the fold is built FROM these lines; appending it back duplicates them"
    );
    assert_eq!(
        error_of(&pool, id).await.as_deref(),
        Some(folded),
        "…while `error` still carries the fold, which is why the fold exists"
    );
}

// ------------------------------------------------------- the cascade (never ran)

/// The cascade's reason has ONE spelling, and it is the one on the wire. The constant is
/// bound as a query parameter by all three writers of it (the runtime cascade, the boot
/// cascade, the born-failed create) and is what the log note is written from, so pinning
/// its VALUE here is what stops the row and the log from drifting apart under a rename.
/// The cascade tests below deliberately assert the literal for the same reason.
#[test]
fn the_cascade_reason_has_one_spelling() {
    assert_eq!(DEPENDENCY_FAILED, "dependency_failed");
}

/// `A → B → C`: failing A cascades B and C to `failed`/`dependency_failed`. Neither ever
/// ran, so neither could have logged anything — and `dependency_failed` in a column the
/// log pane does not render is indistinguishable, to a user, from no explanation at all.
#[tokio::test]
async fn every_cascade_failed_dependent_carries_its_reason_in_its_log() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let a = insert_running(&pool, owner, "cascade-A").await;
    let b = create_child(&repo, owner, "cascade-B", &[a]).await.id;
    let c = create_child(&repo, owner, "cascade-C", &[b]).await.id;

    repo.fail(a, "boom").await.expect("fail A");

    for (id, what) in [(b, "the direct dependent"), (c, "the transitive dependent")] {
        let lines = log_lines(&repo, id).await;
        let logged = terminal_stderr(&lines, what);
        let error = error_of(&pool, id).await.expect("cascaded error");
        assert_eq!(
            logged, error,
            "{what} must be able to say WHY it failed without reading a second field"
        );
        assert_eq!(logged, "dependency_failed", "{what}: {lines:?}");
    }
}

/// The same cascade reached through `finish(exit_code != 0)` — a different terminal
/// writer, the same "the dependent never ran" hole. Covered separately because the two
/// paths reach the cascade through different transactions.
#[tokio::test]
async fn a_nonzero_exit_cascade_also_explains_itself_to_its_dependents() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let a = insert_running(&pool, owner, "exit-A").await;
    let b = create_child(&repo, owner, "exit-B", &[a]).await.id;

    repo.finish(a, 3).await.expect("finish A non-zero");

    let lines = log_lines(&repo, b).await;
    assert_eq!(
        terminal_stderr(&lines, "dependent of a non-zero exit"),
        "dependency_failed",
        "{lines:?}"
    );
}

/// …and through `mark_stopped` (a cancel), the third terminal writer that cascades.
#[tokio::test]
async fn a_stopped_jobs_dependents_are_told_why_in_their_logs() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let a = insert_running(&pool, owner, "stop-A").await;
    let b = create_child(&repo, owner, "stop-B", &[a]).await.id;

    repo.mark_stopped(a)
        .await
        .expect("stop A")
        .expect("A transitioned");

    let lines = log_lines(&repo, b).await;
    assert_eq!(
        terminal_stderr(&lines, "dependent of a stopped job"),
        "dependency_failed",
        "{lines:?}"
    );
}

// ------------------------------------------------- born failed + the boot reconcile

/// A job whose dependency ALREADY failed is born `failed` by the create path itself — a
/// SIXTH writer of `jobs.error`, and one that by construction can never have logged: the
/// row and its explanation are written by the same INSERT.
#[tokio::test]
async fn a_job_born_failed_by_a_dead_dependency_explains_itself() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let a = insert_running(&pool, owner, "born-A").await;
    repo.fail(a, "the dependency died first")
        .await
        .expect("fail A");

    // B is created AFTER A already failed → born failed, never queued, never run.
    let b = create_child(&repo, owner, "born-B", &[a]).await;
    assert_eq!(b.status, "failed", "born failed on a dead dependency");

    let lines = log_lines(&repo, b.id).await;
    assert_eq!(
        terminal_stderr(&lines, "a job born failed"),
        "dependency_failed",
        "a job that was failed at birth still owes the reader a reason: {lines:?}"
    );
}

/// The BOOT reconcile of stranded `blocked` jobs (`reconcile_blocked_jobs`) — a crash
/// between a dependency terminalizing and its cascade committing leaves dependents
/// `blocked` forever, and the boot pass cascade-fails them with a set-based UPDATE that
/// touches rows no live code path is holding.
#[tokio::test]
async fn the_boot_reconcile_cascade_explains_the_jobs_it_fails() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_owner(&pool).await;
    let repo = JobRepository::new(pool.clone());

    let a = insert_running(&pool, owner, "stranded-A").await;
    let b = create_child(&repo, owner, "stranded-B", &[a]).await.id;
    // RAW terminalize: bypasses `fail`, so the runtime cascade never runs and B is left
    // `blocked` — exactly the post-crash state the boot pass exists to heal.
    sqlx::query("UPDATE jobs SET status = 'failed', finished_at = now() WHERE id = $1")
        .bind(a)
        .execute(&pool)
        .await
        .expect("raw-terminalize A");

    let (cascaded, _queued) = repo
        .reconcile_blocked_jobs()
        .await
        .expect("boot reconcile of blocked jobs");
    assert_eq!(cascaded, 1, "the stranded dependent was cascade-failed");

    let lines = log_lines(&repo, b).await;
    assert_eq!(
        terminal_stderr(&lines, "a boot-reconciled dependent"),
        "dependency_failed",
        "a job failed by a BOOT pass has no other channel at all — nobody was watching: \
         {lines:?}"
    );
}

// --------------------------------------------------- the full production path

/// End-to-end through the REAL server: a real HTTP create, the real background scheduler,
/// the real pre-spawn arch gate — and the reason arrives on the job's own log over the
/// real `GET /jobs/{id}` detail response. The lower tests pin the writer; this one proves
/// the writer is on the path a user actually meets.
#[tokio::test]
async fn the_real_scheduler_refusing_a_job_before_spawn_logs_the_refusal() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, _) = register_user(&server, "archuser").await;

    // A non-empty arch list that EXCLUDES the backend's own arch → refused before spawn.
    let foreign = if std::env::consts::ARCH == "x86_64" {
        "aarch64"
    } else {
        "x86_64"
    };
    let (code, body) = create_job_full(
        &server,
        &token,
        "foreign-arch",
        "analysis",
        None,
        json!({ "language": "python", "script": "print(1)", "arch": [foreign] }),
    )
    .await;
    assert_eq!(code, 201, "the job is accepted at create: {body}");
    let id = body["id"].as_str().expect("job id").to_string();

    let detail = poll_until(&server, &token, &id, &["failed"], Duration::from_secs(30)).await;
    let error = detail["job"]["error"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        error.contains("arch-incompatible"),
        "the arch gate refused it: {error:?}"
    );

    let logs = detail["logs"].as_array().cloned().unwrap_or_default();
    let last = logs
        .last()
        .unwrap_or_else(|| panic!("the refused job logged NOTHING; detail = {detail}"));
    assert_eq!(
        last["stream"], "stderr",
        "the refusal lands on stderr: {last}"
    );
    assert_eq!(
        last["content"].as_str().unwrap_or_default(),
        error,
        "the log the user reads carries the same refusal the `error` column does"
    );
}
