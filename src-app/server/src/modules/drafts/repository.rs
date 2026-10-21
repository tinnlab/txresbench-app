//! Draft persistence. All SQL lives here (handlers call repo fns). Compile-time
//! `sqlx::query_as!` verified against the build DB. `timestamptz` columns need the
//! `col as "col: DateTime<Utc>"` override (the `time` crate's default is
//! `OffsetDateTime`). Reads are BY ID only — the owner/project 404-guard lives in the
//! handler (via `ProjectScope`), exactly like `project::repository` get/delete.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use super::models::{Draft, DraftLineageEntry};

/// The maximum lineage-chain length walked (a defensive bound against a pathological /
/// cyclic parent chain — a linear fork history never approaches it). A chain longer than
/// this is truncated at the requested-version end.
const LINEAGE_CHAIN_MAX: usize = 512;

pub struct DraftRepository {
    pool: PgPool,
}

impl DraftRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Insert a draft, born `open`. `parent_frozen_artifact_id` (INV-7 / DEC-11) seeds the
    /// row's `frozen_artifact_id` so a fork draft's next freeze records that prior version as
    /// its `parent_artifact_id` — identical to a reopened draft's lineage edge. `None` for a
    /// fresh New-collection draft (version 1, no parent).
    pub async fn create(
        &self,
        kind: &str,
        project_id: Uuid,
        data: &serde_json::Value,
        created_by: Uuid,
        parent_frozen_artifact_id: Option<Uuid>,
    ) -> Result<Draft, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            Draft,
            r#"INSERT INTO drafts (id, kind, project_id, data, status, created_by, frozen_artifact_id)
               VALUES ($1, $2, $3, $4, 'open', $5, $6)
               RETURNING id, kind, project_id,
                         data as "data: serde_json::Value", status, frozen_artifact_id,
                         created_by,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            kind,
            project_id,
            data,
            created_by,
            parent_frozen_artifact_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Draft>, AppError> {
        sqlx::query_as!(
            Draft,
            r#"SELECT id, kind, project_id,
                      data as "data: serde_json::Value", status, frozen_artifact_id,
                      created_by,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM drafts WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Replace a draft's `data` (LWW). Editing ALWAYS flips status → `open` (DEC-3):
    /// a post-freeze edit means the current frozen artifact no longer matches, so the
    /// next freeze must fork. `fetch_optional` → 404 if the row vanished mid-request.
    pub async fn update_data(&self, id: Uuid, data: &serde_json::Value) -> Result<Draft, AppError> {
        sqlx::query_as!(
            Draft,
            r#"UPDATE drafts SET
                 data = $2,
                 status = 'open',
                 updated_at = now()
               WHERE id = $1
               RETURNING id, kind, project_id,
                         data as "data: serde_json::Value", status, frozen_artifact_id,
                         created_by,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            data,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?
        .ok_or_else(|| AppError::not_found("Draft"))
    }

    /// Count the drafts in a project — the per-project create cap guard (bounded-write
    /// §4; mirrors the `project_files` 100-cap). `COUNT(*)` returns `Some` always, but
    /// the sqlx nullable projection is unwrapped defensively to 0.
    pub async fn count_by_project(&self, project_id: Uuid) -> Result<i64, AppError> {
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "n!" FROM drafts WHERE project_id = $1"#,
            project_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.n)
    }

    pub async fn delete(&self, id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!("DELETE FROM drafts WHERE id = $1", id)
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    // ------- async auto-freeze: the freeze-job ↔ draft mapping (DEC-2 final) -------

    /// The in-flight freeze producer job for `draft_id` **whose captured content matches
    /// `content_hash`**, if one exists (CONTENT-AWARE dedup — DEC-2). "In-flight" = a
    /// mapped freeze job not yet terminal. Read on the caller's dedup transaction
    /// (advisory-locked on the draft) so the find + the create decision are serialized
    /// against a concurrent consumer.
    ///
    /// The `content_hash` match is load-bearing: a plain "any in-flight freeze for this
    /// draft" dedup would let a consumer arriving AFTER the draft was edited mid-freeze
    /// (an earlier freeze froze snapshot S1; the draft now holds S2) reuse the S1 freeze
    /// and consume a STALE snapshot. Keying dedup on a hash of `draft.data` captured at
    /// freeze-create means a consumer only reuses a freeze that froze the SAME bytes it
    /// would freeze itself; if the draft changed, no in-flight freeze matches and a fresh
    /// producer is created for the current content.
    pub async fn find_inflight_freeze_job(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        draft_id: Uuid,
        content_hash: &str,
    ) -> Result<Option<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT f.job_id as "job_id!"
               FROM draft_freeze_jobs f JOIN jobs j ON j.id = f.job_id
               WHERE f.draft_id = $1 AND f.content_hash = $2
                 AND j.status IN ('blocked','queued','running')
               LIMIT 1"#,
            draft_id,
            content_hash,
        )
        .fetch_optional(&mut **tx)
        .await
        .map_err(AppError::database_error)
    }

    /// Record that `job_id` is the freeze producer for `draft_id`, stamping the
    /// `content_hash` of the `draft.data` it captured (the CONTENT-AWARE dedup key) — on
    /// the caller's dedup transaction, so it becomes visible the instant the advisory lock
    /// releases. The job row is inserted in the SAME transaction (see
    /// `freeze::find_or_create_freeze_job`), so the FK holds and a mapping-insert failure
    /// rolls the producer job back with it (no orphan producer).
    pub async fn insert_freeze_mapping(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        job_id: Uuid,
        draft_id: Uuid,
        content_hash: &str,
    ) -> Result<(), AppError> {
        sqlx::query!(
            "INSERT INTO draft_freeze_jobs (job_id, draft_id, content_hash) VALUES ($1, $2, $3)",
            job_id,
            draft_id,
            content_hash,
        )
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(AppError::database_error)
    }

    /// The `draft_id` a freeze `job_id` froze — a PK lookup on `draft_freeze_jobs` ALONE,
    /// touching NO other table. `None` when `job_id` is not a freeze producer — the
    /// completion hook's no-op signal for every non-draftable completion. This is the
    /// hook's FIRST query on every job completion, so it is deliberately the minimal
    /// possible: a non-freeze completion (every ordinary analysis/converter job) does zero
    /// work against the `drafts` table, so a `drafts`-table problem can never abort an
    /// unrelated job's completion transaction. Only a CONFIRMED freeze then reads `drafts`
    /// (via [`Self::draft_project_in_conn`]). Runs on the completion `conn`.
    pub async fn freeze_target_draft(
        conn: &mut sqlx::PgConnection,
        job_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT draft_id as "draft_id!" FROM draft_freeze_jobs WHERE job_id = $1"#,
            job_id,
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)
    }

    /// The `project_id` of a draft, read on the completion `conn`. Called only AFTER
    /// [`Self::freeze_target_draft`] confirmed a freeze job, to scope the minted-artifact
    /// pick — so the `drafts` table is touched only for a genuine freeze completion.
    pub async fn draft_project_in_conn(
        conn: &mut sqlx::PgConnection,
        draft_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT project_id as "project_id!" FROM drafts WHERE id = $1"#,
            draft_id,
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)
    }

    /// Stamp a draft `frozen` at the minted artifact, on the completion `conn`, ONLY if
    /// it has not been edited since the freeze was requested (`drafts.updated_at <` the
    /// freeze job's `created_at`, read via a correlated subquery so no timestamp is bound
    /// through Rust). This is the async design's answer to the edit-races-freeze case
    /// (DEC-3/INV-2): a draft edited WHILE its freeze ran is now `open` with newer data,
    /// and a stale artifact must not silently re-freeze it — the consumer that requested
    /// the freeze still pins the snapshot it asked for (params substitution is
    /// unconditional), but the draft keeps the user's current edit. Returns whether the
    /// row was stamped.
    ///
    /// The comparison is STRICT (`<`, not `<=`): a draft edited AT the freeze's creation
    /// instant (`updated_at == created_at`, a same-microsecond PUT) is a draft whose data
    /// may already differ from the snapshot the producer captured, so it must NOT be
    /// stamped from that (possibly stale) artifact. Only a draft last touched STRICTLY
    /// before the freeze was requested is provably the snapshot the producer froze.
    pub async fn set_frozen_if_unmodified_in_conn(
        conn: &mut sqlx::PgConnection,
        draft_id: Uuid,
        freeze_job_id: Uuid,
        frozen_artifact_id: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            r#"UPDATE drafts SET
                 status = 'frozen',
                 frozen_artifact_id = $3,
                 updated_at = now()
               WHERE id = $1
                 AND updated_at < (SELECT created_at FROM jobs WHERE id = $2)"#,
            draft_id,
            freeze_job_id,
            frozen_artifact_id,
        )
        .execute(&mut *conn)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Deterministically pick the minted artifact of a freeze run, on the completion
    /// `conn` (draftable-entity DEC-2). Reading it on the completion transaction's own
    /// connection — rather than acquiring a SECOND pool connection inside the transaction
    /// — avoids pool-starvation-within-a-transaction (a saturated pool would otherwise
    /// deadlock the freeze completion). The run's artifacts were committed by the ingest
    /// sink BEFORE this completion, so they are visible. Selection: a freeze producer's
    /// contract is a SINGLE typed non-hidden output; `ORDER BY hidden ASC, output_id ASC,
    /// id ASC` picks the non-hidden output by a stable key (falling back to a hidden one
    /// only if that is all there is), so equal `created_at` never ties non-deterministically.
    pub async fn pick_run_artifact_in_conn(
        conn: &mut sqlx::PgConnection,
        project_id: Uuid,
        run_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT id as "id!" FROM artifacts
               WHERE project_id = $1 AND run_id = $2
               ORDER BY hidden ASC, output_id ASC, id ASC
               LIMIT 1"#,
            project_id,
            run_id,
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)
    }

    // ------------------- frozen-artifact version lineage (INV-7 / DEC-11) -------------------

    /// The draft's CURRENT `frozen_artifact_id` (the PRIOR frozen version), read on the
    /// completion `conn` BEFORE [`Self::set_frozen_if_unmodified_in_conn`] overwrites it — so
    /// the lineage row can stamp the new artifact's `parent_artifact_id`. `None` for a first
    /// freeze (the draft has never been frozen) or if the row vanished.
    pub async fn draft_frozen_artifact_in_conn(
        conn: &mut sqlx::PgConnection,
        draft_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        // A row exists (freeze_target_draft confirmed the draft); its `frozen_artifact_id` may be
        // NULL (first freeze). The double-Option flattens "no row" and "row with NULL" to None.
        Ok(sqlx::query_scalar!(
            r#"SELECT frozen_artifact_id FROM drafts WHERE id = $1"#,
            draft_id,
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)?
        .flatten())
    }

    /// Record the fork-edge for a newly-frozen artifact (INV-7): `artifact_id` is this version,
    /// `parent_artifact_id` is the draft's prior frozen artifact (`None` ⇒ first freeze ⇒
    /// `version = 1`; otherwise `version = parent.version + 1`). Idempotent
    /// (`ON CONFLICT DO NOTHING`) so a replayed completion never double-records. Runs on the
    /// completion `conn`, so the lineage row commits atomically with the `frozen` stamp.
    ///
    /// The parent's version is read from its OWN lineage row; a parent with no lineage row
    /// (frozen before lineage was recorded, or GC'd) is treated as version 1, so its child is 2.
    pub async fn record_lineage_in_conn(
        conn: &mut sqlx::PgConnection,
        artifact_id: Uuid,
        draft_id: Uuid,
        parent_artifact_id: Option<Uuid>,
    ) -> Result<(), AppError> {
        let version: i32 = match parent_artifact_id {
            None => 1,
            Some(parent) => {
                let parent_version: Option<i32> = sqlx::query_scalar!(
                    r#"SELECT version FROM draft_artifact_lineage WHERE artifact_id = $1"#,
                    parent,
                )
                .fetch_optional(&mut *conn)
                .await
                .map_err(AppError::database_error)?;
                parent_version.unwrap_or(1).saturating_add(1)
            }
        };
        sqlx::query!(
            r#"INSERT INTO draft_artifact_lineage (artifact_id, draft_id, parent_artifact_id, version)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (artifact_id) DO NOTHING"#,
            artifact_id,
            draft_id,
            parent_artifact_id,
            version,
        )
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(AppError::database_error)
    }

    /// Walk a frozen artifact's lineage chain from `artifact_id` UP its `parent_artifact_id`
    /// links, NEWEST-first (the requested version at index 0). Empty when the artifact has no
    /// lineage row. Bounded by [`LINEAGE_CHAIN_MAX`] (a cycle or absurd depth truncates rather
    /// than loops forever). One indexed PK lookup per hop — a curated fork history is short.
    pub async fn lineage_chain(
        &self,
        artifact_id: Uuid,
    ) -> Result<Vec<DraftLineageEntry>, AppError> {
        let mut chain: Vec<DraftLineageEntry> = Vec::new();
        let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
        let mut current = Some(artifact_id);
        while let Some(id) = current {
            if chain.len() >= LINEAGE_CHAIN_MAX || !seen.insert(id) {
                break;
            }
            let entry = sqlx::query_as!(
                DraftLineageEntry,
                r#"SELECT artifact_id, draft_id, parent_artifact_id,
                          version,
                          created_at as "created_at: DateTime<Utc>"
                   FROM draft_artifact_lineage WHERE artifact_id = $1"#,
                id,
            )
            .fetch_optional(&self.pool)
            .await
            .map_err(AppError::database_error)?;
            match entry {
                Some(e) => {
                    current = e.parent_artifact_id;
                    chain.push(e);
                }
                None => break,
            }
        }
        Ok(chain)
    }

    /// List drafts in a project, optionally filtered by opaque `kind`, newest-touched
    /// first (the `drafts_project_idx` order).
    pub async fn list_by_project(
        &self,
        project_id: Uuid,
        kind: Option<&str>,
    ) -> Result<Vec<Draft>, AppError> {
        sqlx::query_as!(
            Draft,
            r#"SELECT id, kind, project_id,
                      data as "data: serde_json::Value", status, frozen_artifact_id,
                      created_by,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM drafts
               WHERE project_id = $1 AND ($2::text IS NULL OR kind = $2)
               ORDER BY updated_at DESC"#,
            project_id,
            kind,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }
}
