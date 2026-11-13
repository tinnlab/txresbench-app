//! Job-row persistence — the CORE the txr run engine's admission path owns.
//!
//! This is the kept half of the former platform-wide job repository. The
//! single-cell platform's arms were removed with their modules
//! (strip-single-cell ITEM-3, map §1 `jobs` KEEP (trim)): the `job_scope`
//! tenancy table and its project/dataset visibility JOINs (project, dataset,
//! workstore — all removed), the job DAG (`job_dependencies`, the `blocked`
//! status), the draft-freeze completion seam (`drafts`), the dataset-sync
//! terminal announcement (`dataset::sync`) and the log/milestone/metric record
//! surfaces (their jobs UI + SSE routes are removed with them).
//!
//! What remains is exactly what the kept surface needs (DEC-2):
//! [`JobRepository::create_running_under_cap`] — the ONE insert the box-wide
//! concurrency cap is enforced through, the shared front door `jobs::admission`
//! drives for every out-of-scheduler sandbox run (`/api/sandbox/method-run`,
//! the execution-engine drive loop) — plus [`JobRepository::get_any`] /
//! [`JobRepository::finish`] / [`JobRepository::fail`], the slot-close trio
//! `close_slot` uses so a leaked `running` row can never wedge the cap.
//!
//! The `jobs`, `job_logs`, `job_milestones`, `job_metrics`, `job_scope`,
//! `job_dependencies` and `job_settings` tables stay untouched (DEC-4: kept
//! modules' migrations are not edited; the app is unreleased and the chain
//! keeps its historical shape).

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use txresbench_core::AppError;
use uuid::Uuid;

use super::models::Job;

pub struct JobRepository {
    pool: SqlitePool,
}

impl JobRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Claim a concurrency slot by minting the run's `jobs` row —
    /// `status = 'running'`, under the box-wide cap.
    ///
    /// The admission check is a SUB-SELECT of the INSERT (one statement), so an
    /// HTTP handler with N of itself in flight cannot check-then-act past the
    /// cap. On SQLite the `BEGIN IMMEDIATE` write lock additionally serializes
    /// the count-and-insert against the scheduler's own claim path, so the
    /// GLOBAL cap is atomic ACROSS both admit paths. `Ok(None)` ⇒ the pool was
    /// full and NO row was created.
    ///
    /// The row carries no tenancy scope (the `job_scope` table and its
    /// project/dataset resolution died with the single-cell platform); reach is
    /// creator-and-admin, which is the reach of every slot this app mints.
    pub async fn create_running_under_cap(
        &self,
        id: Uuid,
        owner_id: Uuid,
        job_type: &str,
        name: &str,
        params: serde_json::Value,
        cap: i64,
    ) -> Result<Option<Job>, AppError> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let job = sqlx::query_as!(
            Job,
            r#"INSERT INTO jobs (id, owner_id, job_type, name, status, params,
                                 priority_class, resource_class, started_at)
               SELECT $1, $2, $3, $4, 'running', $5, 'normal', 'cpu-sandbox',
                      strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE (SELECT count(*) FROM jobs WHERE status = 'running') < $6
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", job_type, name, status,
                         params as "params: serde_json::Value",
                         created_at as "created_at: DateTime<Utc>",
                         started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         exit_code as "exit_code?: i32", error, pid as "pid?: i32",
                         priority_class, resource_class, req_cpu as "req_cpu?: i32",
                         req_mem_bytes, run_id as "run_id: Uuid""#,
            id,
            owner_id,
            job_type,
            name,
            params,
            cap,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let Some(job) = job else {
            tx.rollback().await.map_err(AppError::database_error)?;
            return Ok(None);
        };
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(Some(job))
    }

    /// Read any job row by id (no reach grading — the callers gate themselves).
    pub async fn get_any(&self, id: Uuid) -> Result<Option<Job>, AppError> {
        sqlx::query_as!(
            Job,
            r#"SELECT id as "id: Uuid", owner_id as "owner_id: Uuid", job_type, name, status,
                      params as "params: serde_json::Value",
                      created_at as "created_at: DateTime<Utc>",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      exit_code as "exit_code?: i32", error, pid as "pid?: i32",
                      priority_class, resource_class, req_cpu as "req_cpu?: i32",
                      req_mem_bytes, run_id as "run_id: Uuid"
               FROM jobs WHERE id = $1"#,
            id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Mark a `running` job terminal from its exit code (0 → completed, else
    /// failed). Clears the pid; a DOUBLE close (0 rows) is a quiet no-op — the
    /// guarded UPDATE matches only a non-terminal row.
    pub async fn finish(&self, id: Uuid, exit_code: i32) -> Result<(), AppError> {
        let status = if exit_code == 0 { "completed" } else { "failed" };
        sqlx::query!(
            r#"UPDATE jobs SET status = $2,
               finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), exit_code = $3, pid = NULL
               WHERE id = $1 AND status = 'running'"#,
            id,
            status,
            exit_code
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Fail a job with an error message (spawn failure, etc.), recording the
    /// reason as the job's terminal `error`. Already-terminal rows are a no-op,
    /// so a double close never rewrites a terminal row.
    pub async fn fail(&self, id: Uuid, error: &str) -> Result<(), AppError> {
        sqlx::query!(
            r#"UPDATE jobs SET status = 'failed',
               finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = $2, pid = NULL
               WHERE id = $1 AND status IN ('blocked','queued','running')"#,
            id,
            error
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }
}
