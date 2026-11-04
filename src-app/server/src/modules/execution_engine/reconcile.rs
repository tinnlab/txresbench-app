//! Boot reconciliation of interrupted runs (PLAN ITEM-7, DEC-17): an app
//! restart mid-run cannot resume the sandboxed methods (the children died with
//! the server), so the boot pass marks every run left in
//! `creating|preparing|running|finishing` as `failed` with the engine code
//! `INTERRUPTED`, fails the method rows that were still in flight (a finished
//! method KEEPS its result — DEC-17's "finished methods' predictions stay
//! readable"), refreshes the run's counts JSON from the aggregate counts
//! query, appends one "interrupted on restart" engine log line, and never
//! auto-reruns. The admitted `jobs` rows of the interrupted methods are NOT
//! touched here: the jobs module's own boot reconcile closes them (their
//! `job_type = 'sandbox'` rows are non-`analysis` orphans to that module).
//!
//! The reconcile is IDEMPOTENT by construction: it touches only the four
//! non-terminal run states and the non-terminal method states, so a second
//! boot (or a second spawn) changes nothing and appends no second line.
//!
//! ### The boot spawn
//!
//! Module `init` calls [`spawn_boot_reconcile`]: a detached task per module
//! instance (the framework constructs each module once per process, so the
//! production boot runs the pass once; a second module instance — a test that
//! inits twice — spawns a second pass, which the DATA-level idempotency makes
//! a no-op: no terminal run is touched twice and no second log line lands).
//! Spawned (not awaited) so the OpenAPI-gen lazy-pool path is never blocked;
//! a failed query there logs a warning.

use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::repository::{append_log_in_tx, method_counts_on};
use super::types::TxrLogStream;

/// The engine code on the interrupted rows (the ONE vocabulary — PROV-EE-3's
/// `INTERRUPTED`; the reconciler binds the code's verbatim string).
const INTERRUPTED: &str = "INTERRUPTED";

/// The reason detail on the run row + every interrupted method row.
const INTERRUPTED_DETAIL: &str = "interrupted on restart";

/// The log line appended per interrupted run (DEC-17: the K/F histories show
/// WHY the run died).
const INTERRUPTED_LOG_LINE: &str = "interrupted on restart";

/// What one reconcile pass did (the boot log's facts + ITEM-11's assertion
/// seam: `runs > 0` means the pass found interrupted work).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileReport {
    /// The runs moved from a live state to `failed` this pass.
    pub runs: usize,
    /// The method rows moved to `failed` + `INTERRUPTED` this pass.
    pub methods: usize,
}

/// The boot spawn (called by module `init`): one detached reconcile pass.
pub fn spawn_boot_reconcile(pool: SqlitePool) {
    tokio::spawn(async move {
        match reconcile_interrupted_runs(&pool).await {
            Ok(report) if report.runs > 0 => {
                tracing::info!(
                    runs = report.runs,
                    methods = report.methods,
                    "execution_engine: boot reconcile failed the interrupted runs"
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = ?e, "execution_engine: boot reconcile failed");
            }
        }
    });
}

/// The reconcile pass, runnable directly (the boot task's body and the unit
/// tests' seam). One transaction per interrupted run: run row → failed,
/// in-flight method rows → failed + `INTERRUPTED`, counts refresh, log line.
pub async fn reconcile_interrupted_runs(pool: &SqlitePool) -> Result<ReconcileReport, AppError> {
    let mut report = ReconcileReport::default();

    let candidates = interrupted_run_ids(pool).await?;
    for run_id in candidates {
        let mut tx = pool.begin().await.map_err(AppError::database_error)?;

        // Guarded transition: only a run STILL in a live state becomes failed
        // (a finalize that raced the boot pass keeps its verdict — the jobs
        // repo's guarded-UPDATE discipline). An interrupted run's elapsed
        // clock is its own started_at → now span (NULL when it never got as
        // far as starting).
        let now = Utc::now();
        let moved = sqlx::query!(
            r#"UPDATE txr_runs
                 SET status = 'failed',
                     finished_at = $2,
                     elapsed_secs = COALESCE(elapsed_secs,
                         CAST(strftime('%s', 'now') - strftime('%s', started_at) AS INTEGER)),
                     error = $3
               WHERE id = $1 AND status IN ('creating','preparing','running','finishing')"#,
            run_id,
            now,
            INTERRUPTED_DETAIL,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        if moved.rows_affected() == 0 {
            // The run already left the live states (a concurrent finalize or
            // another reconciler) — nothing to do, nothing to append.
            tx.commit().await.map_err(AppError::database_error)?;
            continue;
        }

        // The in-flight methods + the INTERRUPTED reason on each (INV-2:
        // failure kept with its reason).
        let failed_methods = sqlx::query!(
            r#"UPDATE txr_run_methods
                 SET state = 'failed',
                     reason_code = $2,
                     reason_detail = $3,
                     phase = NULL,
                     finished_at = $4
               WHERE run_id = $1 AND state IN ('waiting','downloading','running')"#,
            run_id,
            INTERRUPTED,
            INTERRUPTED_DETAIL,
            now,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .rows_affected() as usize;

        // The run's counts JSON is refreshed from the aggregate query (the
        // SAME statement the repository serves — one counts definition).
        let counts = method_counts_on(&mut *tx, run_id).await?;
        let counts_json = serde_json::to_value(&counts)
            .map_err(|e| AppError::database_error(format!("counts serialize: {e}")))?;
        sqlx::query!(
            "UPDATE txr_runs SET counts = $2 WHERE id = $1",
            run_id,
            counts_json,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // The one "interrupted on restart" line (DEC-17).
        append_log_in_tx(
            &mut tx,
            run_id,
            None,
            TxrLogStream::Engine,
            INTERRUPTED_LOG_LINE,
        )
        .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        report.runs += 1;
        report.methods += failed_methods;
    }

    // Idempotency proof: the pass reports what it did (the second boot's
    // candidates set is empty, so a repeated call is a no-op).
    Ok(report)
}

/// The live run rows a boot must adjudicate (BLOB uuid column → `as`-typed).
async fn interrupted_run_ids(pool: &SqlitePool) -> Result<Vec<Uuid>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id as "id: Uuid" FROM txr_runs
           WHERE status IN ('creating','preparing','running','finishing')
           ORDER BY created_at"#
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::modules::execution_engine::repository::test_support::module_pool;
    use crate::modules::execution_engine::repository::{NewMethod, NewRun, TxrRepository};
    use crate::modules::execution_engine::types::{
        RunConfig, TxrMethodState, TxrRunCounts, TxrRunFileNames, TxrRunInputSummary, TxrRunMode,
        TxrRunStatus,
    };

    use super::*;

    fn sample_input_summary() -> TxrRunInputSummary {
        TxrRunInputSummary {
            patients: Some(151),
            predict_patients: Some(38),
            markers: 5,
            events: Some(62),
            file_names: TxrRunFileNames {
                patients: Some("patients.csv".to_string()),
                measurements: "measurements.csv".to_string(),
                predict_measurements: Some("new_measurements.csv".to_string()),
            },
        }
    }

    fn sample_counts(state: TxrMethodState, total: u32) -> TxrRunCounts {
        let mut counts = TxrRunCounts {
            finished: 0,
            failed: 0,
            stopped: 0,
            skipped: 0,
            cannot_run: 0,
            running: 0,
            downloading: 0,
            waiting: 0,
        };
        match state {
            TxrMethodState::Finished => counts.finished = total,
            TxrMethodState::Failed => counts.failed = total,
            TxrMethodState::Waiting => counts.waiting = total,
            TxrMethodState::Downloading => counts.downloading = total,
            TxrMethodState::Stopped => counts.stopped = total,
            TxrMethodState::Skipped => counts.skipped = total,
            TxrMethodState::CannotRun => counts.cannot_run = total,
            TxrMethodState::Running => counts.running = total,
        }
        counts
    }

    fn new_run(status: TxrRunStatus, methods: u32) -> NewRun {
        NewRun {
            id: Uuid::new_v4(),
            created_at: None,
            status,
            mode: TxrRunMode::Train,
            config: RunConfig::default(),
            input_summary: sample_input_summary(),
            model_ids: Vec::new(),
            method_count: methods,
            counts: sample_counts(TxrMethodState::Waiting, methods),
            dir: format!(
                "/app-data/analysis-{}-{:08}",
                chrono::Utc::now().format("%Y-%m-%d-%H%M"),
                Uuid::new_v4().simple()
            ),
            memory_total_bytes: None,
            cpus: Some(4),
            seed: 1,
        }
    }

    fn new_method(run_id: Uuid, method_id: &str, state: TxrMethodState) -> NewMethod {
        NewMethod {
            id: Uuid::new_v4(),
            run_id,
            method_id: method_id.to_string(),
            label: method_id.to_string(),
            version: "2.0.1".to_string(),
            group: "dynamic_risk".to_string(),
            state,
            bytes_total: Some(250 * 1024 * 1024),
        }
    }

    /// ITEM-7 + DEC-17: every live run becomes `failed` + `INTERRUPTED` (run
    /// error + method reasons), its in-flight method rows fail with the code,
    /// a finished method KEEPS its result, the counts JSON is refreshed, and
    /// one log line is appended — terminal runs are never touched.
    #[tokio::test]
    async fn interrupted_runs_fail_with_in_flight_methods_and_keep_finished_ones() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool.clone());

        // One live run per state.
        let mut live = Vec::new();
        for status in [
            TxrRunStatus::Creating,
            TxrRunStatus::Preparing,
            TxrRunStatus::Running,
            TxrRunStatus::Finishing,
        ] {
            let run = new_run(status, 3);
            repo.insert_run(&run).await.expect("live run");
            live.push(run);
        }
        // Terminal runs: finished + failed — must be untouched.
        let done = new_run(TxrRunStatus::Finished, 1);
        let failed_before = new_run(TxrRunStatus::Failed, 1);
        repo.insert_run(&done).await.expect("done run");
        repo.insert_run(&failed_before).await.expect("failed run");

        for run in &live {
            repo.insert_method(&new_method(run.id, "in-flight", TxrMethodState::Running))
                .await
                .expect("in-flight method");
            repo.insert_method(&new_method(run.id, "done-m", TxrMethodState::Finished))
                .await
                .expect("finished method");
            repo.insert_method(&new_method(run.id, "waiting", TxrMethodState::Waiting))
                .await
                .expect("waiting method");
        }

        let report = reconcile_interrupted_runs(&pool).await.expect("reconcile");
        assert_eq!(report.runs, 4);
        assert_eq!(
            report.methods, 8,
            "in-flight + waiting, not the finished ones"
        );

        for run in &live {
            let row = repo.get_run(run.id).await.expect("get").expect("exists");
            assert_eq!(row.status().expect("status"), TxrRunStatus::Failed);
            assert_eq!(row.error.as_deref(), Some(INTERRUPTED_DETAIL));
            assert!(row.finished_at.is_some(), "the interrupted run is closed");

            let methods = repo.methods_for_run(run.id).await.expect("methods");
            let in_flight = methods
                .iter()
                .find(|m| m.method_id == "in-flight")
                .expect("in-flight row");
            assert_eq!(in_flight.state().expect("state"), TxrMethodState::Failed);
            assert_eq!(in_flight.reason_code.as_deref(), Some(INTERRUPTED));
            let waiting = methods
                .iter()
                .find(|m| m.method_id == "waiting")
                .expect("waiting row");
            assert_eq!(waiting.state().expect("state"), TxrMethodState::Failed);
            assert_eq!(waiting.reason_code.as_deref(), Some(INTERRUPTED));
            let done_m = methods
                .iter()
                .find(|m| m.method_id == "done-m")
                .expect("finished row");
            assert_eq!(
                done_m.state().expect("state"),
                TxrMethodState::Finished,
                "a finished method's result is preserved (DEC-17)"
            );

            // The counts JSON reflects the interrupted reality.
            let summary = row
                .summarize(repo.method_ids_for_run(run.id).await.expect("method ids"))
                .expect("summary");
            assert_eq!(summary.counts.failed, 2);
            assert_eq!(summary.counts.finished, 1);

            // Exactly ONE log line, the engine-authored interruption.
            let (lines, total, _) = repo.logs_page(run.id, None, 0, 100).await.expect("logs");
            assert_eq!(total, 1);
            let line = lines
                .into_iter()
                .next()
                .expect("one line")
                .into_line()
                .expect("wire");
            assert_eq!(line.stream.as_str(), "engine");
            assert_eq!(line.content, INTERRUPTED_LOG_LINE);
        }

        // The terminal runs are untouched — same status, no log line.
        for run in [&done, &failed_before] {
            let row = repo.get_run(run.id).await.expect("get").expect("exists");
            assert_eq!(row.status().expect("status"), run.status);
            assert_eq!(repo.log_total(run.id).await.expect("logs"), 0);
        }
    }

    /// ITEM-7 (DEC-17): the reconcile is idempotent — a second pass is a
    /// no-op (no second log line, no second INTERRUPTED rewrite).
    #[tokio::test]
    async fn reconcile_is_idempotent() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool.clone());
        let run = new_run(TxrRunStatus::Running, 1);
        repo.insert_run(&run).await.expect("run");
        repo.insert_method(&new_method(run.id, "m", TxrMethodState::Running))
            .await
            .expect("m");

        let first = reconcile_interrupted_runs(&pool).await.expect("first");
        assert_eq!(first.runs, 1);
        assert_eq!(first.methods, 1);

        let second = reconcile_interrupted_runs(&pool).await.expect("second");
        assert_eq!(second.runs, 0, "no live run survives the first pass");
        assert_eq!(second.methods, 0);
        assert_eq!(
            repo.log_total(run.id).await.expect("logs"),
            1,
            "no second line"
        );
    }
}
