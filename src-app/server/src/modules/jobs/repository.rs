//! Jobs persistence — owner-scoped CRUD + the class-aware fair-share scheduler
//! claim + log/metric append + boot crash-safety.
//!
//! Uses sqlx COMPILE-TIME `query_as!`/`query!` macros (the canonical pattern —
//! see `modules/dataset/repository.rs`): every query is verified against the
//! build DB schema at `cargo check`.
//!
//! SQLite driver (sqlite-store DEC-1: the app's modules are single-driver):
//! `uuid` columns are 16-byte BLOBs and `timestamptz` columns are canonical
//! RFC3339-UTC TEXT (DEC-8's map), so the plugin `<ident: Type>` overrides the
//! PG macro inference cannot produce are written out explicitly everywhere the
//! DB type differs from the Rust type — `created_at as "created_at:
//! DateTime<Utc>"`, and the INTEGER-affinity columns the sqlite macro infers
//! as `i64`/`f64` get their `i32`/`f32` field types spelled out (`seq as
//! "seq: i32"`, `cpu_pct as "cpu_pct: f32"`). The serialization-substitution
//! notes (PG row/advisory locks → the SQLite write lock + `BEGIN IMMEDIATE`,
//! the reaper's single-leader gate) are at [`JobRepository::claim_next_fair`],
//! [`JobRepository::reaper_sweep`] and [`JobRepository::unblock_dependents`];
//! the `now()`/`make_interval` → `strftime` rewrite convention is at
//! [`reclaim_stale_rows`]; the JSON1-membership port of `= ANY(uuid[])` is at
//! [`uuid_list_json`].

use chrono::{DateTime, Utc};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;
use txresbench_core::AppError;

use super::models::{CreateJobRequest, Job, JobLog, JobMetric, JobMilestone};
use super::runtime::runtime;
use super::sse::SSEJobEvent;

/// The in-process single-leader gate for the stale-claim reaper
/// ([`JobRepository::reaper_sweep`]) — the SQLite substitution for the PG path's
/// `pg_try_advisory_xact_lock(REAPER_ADVISORY_KEY)` transaction-scoped lock,
/// which has no SQLite form. "Try" semantics preserved: a tick that loses the
/// gate no-ops immediately (`Ok(None)`) exactly as the losing `try_advisory`
/// did; the gate is per-process because that is the app's topology (one server
/// process; its scheduler tick tasks are threads). The cross-process residue is
/// analyzed at [`JobRepository::reaper_sweep`]. The value is `()` — the gate
/// only arbitrates, it carries no state.
static REAPER_GATE: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

/// The reason written onto a job whose DEPENDENCY failed, and therefore the reason that
/// job can never run. ONE spelling, bound as a query parameter by every writer of it (the
/// runtime cascade, the boot cascade, and the born-failed create), so the reason a reader
/// meets in the log cannot drift from the reason stored in `jobs.error`.
pub const DEPENDENCY_FAILED: &str = "dependency_failed";

/// T4: the claim count-and-claim critical section is serialized by the SQLite
/// write lock itself (`BEGIN IMMEDIATE` at the mutation's open — ITEM-18's
/// substitution), so the READ-COMMITTED cap sub-selects can never both observe
/// `count = cap - 1` and both admit (INV-1). The PG path used a
/// transaction-scoped `pg_advisory_xact_lock` for the same purpose; SQLite has
/// no advisory locks and no READ-COMMITTED snapshot ladder — one writer, one
/// lock — so the lock statement is gone and the transaction is the lock (see
/// [`JobRepository::claim_next_fair`]).

/// The (id, owner) rows a single reaper sweep acted on — returned by
/// [`JobRepository::reaper_sweep`] so the caller can emit `sync:job` for each and
/// run the DAG cascade for the discarded (failed) ones (a raw UPDATE performs
/// neither). T4 / ITEM-4.
#[derive(Debug, Default, Clone)]
pub struct ReaperOutcome {
    /// (job_id, owner_id) rows re-queued (running → queued) this sweep.
    pub reclaimed: Vec<(Uuid, Uuid)>,
    /// (job_id, owner_id) poison rows discarded (running → failed) this sweep.
    pub discarded: Vec<(Uuid, Uuid)>,
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume: a JSON array of 32-char lowercase hex strings (the
/// `uuid::Uuid::simple()` form), compared against a 16-byte BLOB column
/// through `unhex()` — `id IN (SELECT unhex(j.value) FROM json_each($1) AS j)`.
/// This is the ITEM-15 `txresbench-file` convention (its `uuid_list_json`), kept
/// local here because the app's modules are single-driver (DEC-1) and beside
/// the `= ANY(uuid[])` sites in this module it serves no other surface.
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}

/// Shared re-queue SQL for the stale-claim reaper (INV-3), usable on a pool OR a
/// transaction connection so [`JobRepository::reclaim_stale`] and
/// [`JobRepository::reaper_sweep`] run the SAME statement (no drift). Clears
/// `claimed_by`/`claim_heartbeat`/`started_at`/`pid` and bumps `reclaim_count`;
/// `LIMIT`-capped (§4). Returns the (id, owner) pairs reclaimed.
///
/// SQLite port (DEC-12): the interval arithmetic `claim_heartbeat < now() -
/// make_interval(secs => $1::double precision)` has no SQLite form; it is
/// expressed in the chain's canonical clock —
/// `strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || CAST($1 AS TEXT) || ' seconds')`
/// — so both sides are RFC3339-UTC TEXT and the comparison stays
/// lexicographic == chronological. The `FOR UPDATE SKIP LOCKED` in the
/// bounded sub-select is dropped: SQLite has no row locks to skip, and the
/// reaper's own transaction opens `BEGIN IMMEDIATE`, so no claimer can be
/// mid-write on a row this statement reads.
async fn reclaim_stale_rows<'e, E>(
    executor: E,
    stale_secs: i64,
    max_reclaims: i32,
    limit: i64,
) -> Result<Vec<(Uuid, Uuid)>, AppError>
where
    E: sqlx::SqliteExecutor<'e>,
{
    let rows = sqlx::query!(
        r#"UPDATE jobs
              SET status = 'queued', claimed_by = NULL, claim_heartbeat = NULL,
                  started_at = NULL, pid = NULL, reclaim_count = reclaim_count + 1
           WHERE id IN (
               SELECT id FROM jobs
               WHERE status = 'running'
                 AND claim_heartbeat IS NOT NULL
                 AND claim_heartbeat <
                     strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || CAST($1 AS TEXT) || ' seconds')
                 AND reclaim_count < $2
               ORDER BY claim_heartbeat ASC
               LIMIT $3
           )
           RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid""#,
        stale_secs,
        max_reclaims,
        limit
    )
    .fetch_all(executor)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows.into_iter().map(|r| (r.id, r.owner_id)).collect())
}

/// Shared discard-at-max SQL (DEC-9): fail a poison row already reclaimed
/// `max_reclaims` times, bounded by the same stale predicate. Usable on a pool or
/// a tx connection so the standalone method and the sweep share it. Returns the
/// (id, owner) pairs discarded. Same SQLite port as [`reclaim_stale_rows`].
async fn discard_exhausted_rows<'e, E>(
    executor: E,
    stale_secs: i64,
    max_reclaims: i32,
    limit: i64,
) -> Result<Vec<(Uuid, Uuid)>, AppError>
where
    E: sqlx::SqliteExecutor<'e>,
{
    let rows = sqlx::query!(
        r#"UPDATE jobs
              SET status = 'failed',
                  finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  error = COALESCE(error,
                      'reclaimed by the stale-claim reaper more than the max allowed times (poison-job guard)')
           WHERE id IN (
               SELECT id FROM jobs
               WHERE status = 'running'
                 AND claim_heartbeat IS NOT NULL
                 AND claim_heartbeat <
                     strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || CAST($1 AS TEXT) || ' seconds')
                 AND reclaim_count >= $2
               ORDER BY claim_heartbeat ASC
               LIMIT $3
           )
           RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid""#,
        stale_secs,
        max_reclaims,
        limit
    )
    .fetch_all(executor)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows.into_iter().map(|r| (r.id, r.owner_id)).collect())
}

/// What a terminal transition actually DID — and, consequently, what its caller owes once
/// the transaction commits.
///
/// Both fields are post-commit obligations, and neither can be discharged from inside the
/// transaction: the transaction may still roll back, and announcing (or explaining) a
/// change that never committed is worse than doing neither.
#[derive(Debug, Default, Clone)]
pub struct TerminalTransition {
    /// The OWNER of the job this call transitioned, or `None` when the guarded UPDATE
    /// matched no row (already terminal — a double-finish). The caller's gate for
    /// [`JobRepository::publish_dataset_after_terminal`].
    pub owner_id: Option<Uuid>,
    /// The ids this transition CASCADE-failed. Each is a job that never ran, so nothing
    /// can have written it a log line; the caller owes them
    /// [`JobRepository::note_cascaded_reasons`].
    pub cascaded: Vec<Uuid>,
    /// The draft ids the draftable freeze-completion hook stamped `frozen` (DEC-2). A
    /// post-commit obligation: the caller emits their detached `Draft/Update` sync via
    /// `seams::freeze_completion_sink().emit_frozen(...)` (INV-6). Empty for every
    /// non-freeze completion.
    pub frozen_drafts: Vec<Uuid>,
}

/// The tenancy scope a job resolves to (ITEM-68), read from the single-source-of-
/// truth `job_scope` table: a project (workbench) OR a dataset (owner processing).
/// A scope-less job resolves to `None` at the lookup, so this enum is total.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobScope {
    Project(Uuid),
    Dataset(Uuid),
}

impl JobScope {
    /// Split into the `(project_id, dataset_id)` pair (exactly one `Some`) that the
    /// ingest sink + provenance recorder thread into `ingest_run_outputs` / `NewRun`.
    pub fn split(self) -> (Option<Uuid>, Option<Uuid>) {
        match self {
            JobScope::Project(p) => (Some(p), None),
            JobScope::Dataset(d) => (None, Some(d)),
        }
    }
}

#[derive(Clone)]
pub struct JobRepository {
    pool: SqlitePool,
}

impl JobRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    // ---- create / read ----

    pub async fn create(&self, owner_id: Uuid, req: &CreateJobRequest) -> Result<Job, AppError> {
        self.create_with_deps(owner_id, req, &[]).await
    }

    /// Create a job that DEPENDS on `deps` (ITEM-19 DAG). With any dependency the
    /// job starts `blocked` (not scheduler-claimable) and is unblocked when ALL
    /// deps reach `completed` (or cascaded to `failed` if one fails). With no deps
    /// it is `queued` — identical to `create`. Reconciles at birth so a dep that
    /// already finished before this job was created does not strand it `blocked`.
    pub async fn create_with_deps(
        &self,
        owner_id: Uuid,
        req: &CreateJobRequest,
        deps: &[Uuid],
    ) -> Result<Job, AppError> {
        // One transaction: the scope-agnostic jobs row, its `job_scope` row, and its
        // `job_dependencies` rows land together or none does (multi-step write —
        // CODING_GUIDELINES §4).
        // SQLite: `BEGIN IMMEDIATE` — the read-then-write reconcile-at-birth below
        // must hold the write lock from the transaction's OPEN (the ITEM-18
        // substitution for PG's `FOR UPDATE` row locks; a deferred `BEGIN` would
        // only take it at the first write and could busy-fail the upgrade).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let (job, born_error) = self
            .create_with_deps_in_conn(&mut tx, owner_id, req, deps)
            .await?;
        tx.commit().await.map_err(AppError::database_error)?;
        // A job BORN failed is the sixth writer of `jobs.error` that no log line can
        // follow: the row and its only explanation are written by the same INSERT, and
        // there is not now (and never will be) a child process to print anything. So it
        // owes the reader the same terminal line every other failure does.
        if job.status == "failed" {
            if let Some(reason) = born_error {
                self.append_terminal_reason(job.id, reason).await;
            }
        }
        Ok(job)
    }

    /// [`Self::create_with_deps`] on a CALLER-OWNED connection/transaction — the pool
    /// wrapper is exactly `begin` + this + `commit` + the post-commit born-failed reason
    /// append. Returns `(job, born_error)`; the caller commits and, if the job was born
    /// `failed`, appends `born_error` as its terminal reason AFTER committing.
    ///
    /// Split out so an existing transaction can create a job atomically with its own
    /// writes — the draftable freeze producer (`drafts::freeze::find_or_create_freeze_job`)
    /// inserts the freeze `jobs` row AND its `draft_freeze_jobs` mapping in ONE transaction
    /// this way (so a mapping-insert failure can never leave an orphan producer running,
    /// and no second pool connection is acquired mid-flow).
    pub async fn create_with_deps_in_conn(
        &self,
        conn: &mut SqliteConnection,
        owner_id: Uuid,
        req: &CreateJobRequest,
        deps: &[Uuid],
    ) -> Result<(Job, Option<&'static str>), AppError> {
        let id = Uuid::new_v4();
        let name = req.name.clone().unwrap_or_default();
        let mut params = req.params.clone().unwrap_or_else(|| serde_json::json!({}));
        // The handler resolves priority_class (trigger inference) + clamps the
        // resource_class before calling; default here defensively.
        let priority = req
            .priority_class
            .clone()
            .unwrap_or_else(|| "normal".to_string());
        let resource = req
            .resource_class
            .clone()
            .unwrap_or_else(|| "cpu-sandbox".to_string());

        // Resolve the job's tenancy scope (ITEM-68): a project (workbench) XOR a
        // dataset (owner processing) XOR neither. Enforce the project-XOR-dataset
        // invariant at THIS single write chokepoint — both the jobs create handler
        // AND the dataset process path call `create` directly, so guarding here (not
        // only in the HTTP handler) means no path can persist a double-scoped job.
        let scope: Option<(&'static str, Uuid)> = match (req.project_id, req.dataset_id) {
            (Some(_), Some(_)) => {
                return Err(AppError::bad_request(
                    "AMBIGUOUS_JOB_SCOPE",
                    "a job may be scoped to a project OR a dataset, not both",
                ))
            }
            (Some(p), None) => Some(("project", p)),
            (None, Some(d)) => Some(("dataset", d)),
            (None, None) => None,
        };

        // Reconcile-at-birth (ITEM-19), race-safe. A job with dependencies is born
        // `blocked` UNLESS a dep already terminalized. The born status is derived
        // from the dependency rows read INSIDE this transaction, which is
        // `BEGIN IMMEDIATE` when this module opens it — so the read serializes
        // against a concurrent finish()/fail()/mark_stopped() of a dep exactly as
        // the PG `FOR UPDATE` did: the write lock is held from the open, the
        // concurrent finisher's own `BEGIN IMMEDIATE` waits until this
        // transaction commits, and its unblock/cascade scan then sees the newly
        // inserted dependency edge. Without the serialization a NON-locking read
        // could see a dep as still-running while that dep's terminal
        // transaction commits AND runs its unblock/cascade scan BEFORE this edge
        // is inserted — stranding the new job `blocked` forever (lost-unblock
        // TOCTOU). A caller that passes its OWN transaction (the drafts freeze
        // producer) must open it `BEGIN IMMEDIATE` for the same property.
        //
        // The (id, status) pairs are kept — not just the status set — because a dep
        // already `completed` at birth is the draftable create-after-complete race: its
        // freeze-completion hook ran BEFORE this consumer's dependency edge existed and
        // so found no dependent to substitute. We pin those completed freeze deps into
        // `params` NOW, in this same transaction, before the INSERT (below), so the
        // consumer is BORN pinned — never queued with a live `draft_ref` (INV-4).
        let mut completed_deps: Vec<Uuid> = Vec::new();
        let (born_status, born_error): (&str, Option<&str>) = if deps.is_empty() {
            ("queued", None)
        } else {
            // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
            let json_deps = uuid_list_json(deps);
            let dep_rows = sqlx::query!(
                r#"SELECT id as "id: Uuid", status as "status!"
                   FROM jobs
                  WHERE id IN (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
                json_deps,
            )
            .fetch_all(&mut *conn)
            .await
            .map_err(AppError::database_error)?;
            for r in &dep_rows {
                if r.status == "completed" {
                    completed_deps.push(r.id);
                }
            }
            if dep_rows
                .iter()
                .any(|r| r.status == "failed" || r.status == "stopped")
            {
                // A dep already failed/stopped → this job can never run → born
                // failed (same cascade semantics as a runtime cascade_fail).
                ("failed", Some(DEPENDENCY_FAILED))
            } else if dep_rows.iter().all(|r| r.status == "completed") {
                // Every present dep already completed → nothing left to wait on →
                // born queued (a missing dep is dropped, matching the edge JOIN).
                ("queued", None)
            } else {
                ("blocked", None)
            }
        };

        // Create-after-complete race (draftable-entity DEC-2): for any dep already
        // `completed` at birth, substitute its minted freeze artifact into this
        // consumer's `params` before the INSERT, so the consumer is born with a pinned
        // `artifact_ref` (never a `queued` job carrying a live `draft_ref`). A no-op
        // (params unchanged) for deps that are not freeze producers, and entirely inert
        // under the no-op sink. Skipped for a born-failed job (it never runs).
        if !completed_deps.is_empty() && born_status != "failed" {
            params = crate::modules::jobs::seams::freeze_completion_sink()
                .substitute_completed_freeze_deps_in_tx(&mut *conn, &params, &completed_deps)
                .await
                .map_err(AppError::internal_error)?;
        }

        let job = sqlx::query_as!(
            Job,
            r#"INSERT INTO jobs (id, owner_id, job_type, name, status, params,
                                 priority_class, resource_class, error, finished_at)
               VALUES ($1, $2, $3, $4, $8, $5, $6, $7, $9,
                       CASE WHEN $8 = 'failed'
                            THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END)
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
            req.job_type,
            name,
            params,
            priority,
            resource,
            born_status,
            born_error,
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(AppError::database_error)?;

        if let Some((kind, scope_id)) = scope {
            sqlx::query!(
                r#"INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, $2, $3)"#,
                job.id,
                kind,
                scope_id,
            )
            .execute(&mut *conn)
            .await
            .map_err(AppError::database_error)?;
        }

        // Dependency edges. The dep rows were read under this transaction's write
        // lock above, so inserting the edges here (before commit) can no longer race
        // a dep's terminal transition: either that transition already committed
        // (reflected in `born_status`) or its `BEGIN IMMEDIATE` waits on our lock
        // until we commit these edges, after which its unblock/cascade scan sees them.
        for dep in deps {
            sqlx::query!(
                r#"INSERT INTO job_dependencies (job_id, depends_on_job_id)
                   VALUES ($1, $2) ON CONFLICT DO NOTHING"#,
                job.id,
                dep,
            )
            .execute(&mut *conn)
            .await
            .map_err(AppError::database_error)?;
        }

        Ok((job, born_error))
    }

    /// Resolve a job's tenancy scope from the single-source-of-truth `job_scope`
    /// table (ITEM-68): a project (workbench) OR a dataset (owner processing). Kept
    /// an associated fn (pool + job id, not `&Job`) so the ingest sink + provenance
    /// recorder resolve scope without a full `Job` load. Returns `None` for a
    /// scope-less job (no row) and for a missing job id. An unknown `scope_kind`
    /// (impossible under the table's CHECK) is treated as scope-less, never a panic.
    ///
    /// EXISTENCE-AWARE (dataset/project-delete safety — mirrors the old
    /// `jobs.dataset_id ON DELETE SET NULL`). `job_scope.scope_id` is a FK-LESS
    /// polymorphic pointer, so a `job_scope` row SURVIVES the delete of its target
    /// project/dataset (only a JOB delete cascades it away). Migration 202607250006
    /// explicitly guaranteed "deleting the dataset of an in-flight job must not break
    /// the job": under the old schema the SET NULL nulled `jobs.dataset_id`, so the
    /// run finalized SCOPE-LESS (outputs uncataloged, job COMPLETED). To preserve that
    /// guarantee this resolves to `None` (scope-less) when the referenced project /
    /// dataset row no longer exists — so both callers (ingest sink + provenance
    /// recorder) skip scope→artifact tagging and the job finalizes COMPLETED, instead
    /// of inserting `artifacts.dataset_id`/`project_id` (or `provenance_run_repro`)
    /// against a deleted FK target and FAILING a previously-succeeding run. The
    /// now-dangling `job_scope` row is harmless: it is never re-resolved (v4 scope ids
    /// never collide with a future project/dataset), never matched by the LIVE-id
    /// `?project_id=`/`?dataset_id=` list filters, and is reclaimed by the
    /// `ON DELETE CASCADE` when the job itself is deleted.
    pub async fn job_scope(pool: &SqlitePool, job_id: Uuid) -> Result<Option<JobScope>, AppError> {
        let row = sqlx::query!(
            r#"SELECT js.scope_kind, js.scope_id as "scope_id: Uuid"
               FROM job_scope js
               WHERE js.job_id = $1
                 AND (
                       (js.scope_kind = 'project'
                            AND EXISTS (SELECT 1 FROM projects p WHERE p.id = js.scope_id))
                    OR (js.scope_kind = 'dataset'
                            AND EXISTS (SELECT 1 FROM datasets d WHERE d.id = js.scope_id))
                 )"#,
            job_id,
        )
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.and_then(|r| match r.scope_kind.as_str() {
            "project" => Some(JobScope::Project(r.scope_id)),
            "dataset" => Some(JobScope::Dataset(r.scope_id)),
            _ => None,
        }))
    }

    /// Paginated list of every job `user_id` may SEE (newest first) — their own, plus
    /// every job scoped to a dataset/project they may EDIT. `project_id`, when `Some`,
    /// filters to jobs scoped to that project (ITEM-67 project jobs panel).
    ///
    /// This replaced a purely `owner_id = $1` query. That query's doc comment called
    /// the shared-project case a "deliberate, safe direction" limitation, and it was
    /// half right: it leaked nothing. But it also hid, from the owner of a dataset, the
    /// job that an `edit`-role sharee was at that moment running ON that dataset — a
    /// job the owner could see the EFFECT of (the derived processing badge) and could
    /// not open or stop. `799d0cf3` opened that path deliberately (`POST /jobs` and
    /// `POST /datasets/{id}/process` both admit an edit-sharee) and named this as its
    /// companion hole. Under-showing is not safe when what is hidden is activity on
    /// your own data.
    ///
    /// ## The predicate, and the three traps in widening it
    ///
    /// 1. **`EXISTS`, never `JOIN`.** A job matching by BOTH arms (its creator is also
    ///    an editor of its scope) is one row, not two. A `JOIN job_scope` would emit it
    ///    twice AND inflate `total` — the classic "list grew a new source of rows"
    ///    duplication.
    /// 2. **`total` uses the IDENTICAL predicate** to the page query, so the pager
    ///    cannot promise pages that do not exist (or hide ones that do).
    /// 3. **`ORDER BY created_at DESC, id DESC`.** `created_at` alone is not a total
    ///    order, and this list now interleaves rows from several creators produced in
    ///    the same burst, so ties are ordinary rather than exotic. Paging a
    ///    non-deterministic order repeats one row on page 2 and drops another forever.
    ///    The `id` tiebreaker makes the order total. (`list_all` carries the same fix.)
    ///
    /// ## Drift
    ///
    /// This SQL is a second implementation of [`super::authz::resolve_job_reach`],
    /// which cannot be called from inside a query. The integration test
    /// `a_job_is_listed_exactly_when_it_can_be_opened` asserts the two agree for every
    /// principal × scope kind, rather than trusting a reader to notice them diverging
    /// — the failure mode `799d0cf3` found in the hand-copied share predicates.
    /// `group_ids` arrives already filtered to ACTIVE groups by
    /// `permissions::active_group_ids` (the caller's job, exactly as for
    /// `DatasetRepository::access`), so a disabled group revokes here too.
    ///
    /// ## H-1 (#147) — the dataset/project OWNER arms require current membership
    ///
    /// The `d.owner_id = $1` / `p.owner_id = $1` arms are conjoined with membership
    /// of the row's `account_id`, matching the fix applied to
    /// `DatasetRepository::access` and `ProjectRepository::effective_permission`.
    /// This is not optional tidying: `resolve_job_reach`'s scope arms call those two
    /// functions, so leaving this SQL alone would make a removed member's job LISTED
    /// but not OPENABLE — exactly the drift
    /// `a_job_is_listed_exactly_when_it_can_be_opened` exists to prevent. The
    /// `jobs.owner_id = $1` (job CREATOR) arm was deliberately NOT touched there —
    /// see #167 below, which is the branch that closes it.
    ///
    /// ## #167 — the CREATOR arm requires STANDING on the job's scope
    ///
    /// `jobs` carries no `account_id`, so #147's transform has no account to name and
    /// the arm was left as a bare `jobs.owner_id = $1`: a member removed from the
    /// organization kept every job they had started there in their list, forever.
    /// The conjunct added here is the SQL mirror of `authz::creator_retains_standing`
    /// — a scope-LESS job stays creator-only (`NOT EXISTS` a live scope; the
    /// existence-aware form matches `Self::job_scope`, so a job whose dataset was
    /// deleted reads as scope-less on BOTH sides), and a scoped job additionally
    /// requires that the creator still reaches its scope through current membership
    /// or a surviving share.
    ///
    /// Note the standing arms are the VISIBILITY predicates (any dataset share, any
    /// accepted project share), NOT the edit-level predicates the scope arms below
    /// use. That asymmetry is deliberate and matches the Rust original: the scope
    /// arms answer "may a third party see this run", the creator arm answers "does
    /// the person who STARTED it still have any business here at all". Narrowing the
    /// creator arm to the edit level would strand a bare account `member` who created
    /// a job on a co-member's dataset, which is a live legitimate user.
    pub async fn list_visible_to(
        &self,
        user_id: Uuid,
        group_ids: &[Uuid],
        project_id: Option<Uuid>,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<Job>, i64), AppError> {
        let offset = (page - 1).max(0) * per_page;
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_group_ids = uuid_list_json(group_ids);
        let jobs = sqlx::query_as!(
            Job,
            r#"SELECT id as "id: Uuid", owner_id as "owner_id: Uuid", job_type, name, status,
                      params as "params: serde_json::Value",
                      created_at as "created_at: DateTime<Utc>",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      exit_code as "exit_code?: i32", error, pid as "pid?: i32",
                      priority_class, resource_class, req_cpu as "req_cpu?: i32",
                      req_mem_bytes, run_id as "run_id: Uuid"
               FROM jobs
               WHERE (
                       (jobs.owner_id = $1 AND (
                          NOT EXISTS (
                            SELECT 1 FROM job_scope jsc WHERE jsc.job_id = jobs.id
                              AND ( (jsc.scope_kind = 'project'
                                       AND EXISTS (SELECT 1 FROM projects pc
                                                    WHERE pc.id = jsc.scope_id))
                                 OR (jsc.scope_kind = 'dataset'
                                       AND EXISTS (SELECT 1 FROM datasets dc
                                                    WHERE dc.id = jsc.scope_id)) ))
                          OR EXISTS (
                            SELECT 1 FROM job_scope jsc WHERE jsc.job_id = jobs.id
                              AND ( (jsc.scope_kind = 'dataset' AND EXISTS (
                                       SELECT 1 FROM datasets dc
                                        WHERE dc.id = jsc.scope_id
                                          AND (dc.account_id IN (
                                                 SELECT am.account_id FROM account_members am
                                                  WHERE am.user_id = $1)
                                            OR EXISTS (
                                                 SELECT 1 FROM dataset_shares dsc
                                                  WHERE dsc.dataset_id = dc.id
                                                    AND ( (dsc.principal_type = 'user'
                                                             AND dsc.principal_id = $1)
                                                       OR (dsc.principal_type = 'group'
                                                             AND dsc.principal_id
                                                               IN (SELECT unhex(j.value)
                                                                     FROM json_each($2) AS j)) )))))
                                 OR (jsc.scope_kind = 'project' AND EXISTS (
                                       SELECT 1 FROM projects pc
                                        WHERE pc.id = jsc.scope_id
                                          AND (pc.account_id IN (
                                                 SELECT am.account_id FROM account_members am
                                                  WHERE am.user_id = $1)
                                            OR EXISTS (
                                                 SELECT 1 FROM project_shares psc
                                                  WHERE psc.project_id = pc.id
                                                    AND psc.recipient_id = $1
                                                    AND psc.status = 'accepted')))) ))))
                    OR EXISTS (
                         SELECT 1 FROM job_scope js WHERE js.job_id = jobs.id AND (
                              (js.scope_kind = 'dataset' AND EXISTS (
                                 SELECT 1 FROM datasets d WHERE d.id = js.scope_id AND (
                                      (d.owner_id = $1
                                       AND d.account_id IN (
                                             SELECT am.account_id FROM account_members am
                                              WHERE am.user_id = $1))
                                   OR EXISTS (
                                        SELECT 1 FROM dataset_shares ds
                                         WHERE ds.dataset_id = d.id AND ds.role = 'edit'
                                           AND ( (ds.principal_type = 'user'
                                                    AND ds.principal_id = $1)
                                              OR (ds.principal_type = 'group'
                                                    AND ds.principal_id
                                                      IN (SELECT unhex(j.value)
                                                            FROM json_each($2) AS j)) )))))
                           OR (js.scope_kind = 'project' AND EXISTS (
                                 SELECT 1 FROM projects p WHERE p.id = js.scope_id AND (
                                      (p.owner_id = $1
                                       AND p.account_id IN (
                                             SELECT am.account_id FROM account_members am
                                              WHERE am.user_id = $1))
                                   OR EXISTS (
                                        SELECT 1 FROM project_shares ps
                                         WHERE ps.project_id = p.id
                                           AND ps.recipient_id = $1
                                           AND ps.status = 'accepted'
                                           AND ps.permission_level = 'editor'))))))
                     )
                 AND ($5 IS NULL OR EXISTS (
                       SELECT 1 FROM job_scope js2
                       WHERE js2.job_id = jobs.id
                         AND js2.scope_kind = 'project' AND js2.scope_id = $5))
               ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4"#,
            user_id,
            json_group_ids,
            per_page,
            offset,
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_group_ids = uuid_list_json(group_ids);
        let total = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM jobs
               WHERE (
                       (jobs.owner_id = $1 AND (
                          NOT EXISTS (
                            SELECT 1 FROM job_scope jsc WHERE jsc.job_id = jobs.id
                              AND ( (jsc.scope_kind = 'project'
                                       AND EXISTS (SELECT 1 FROM projects pc
                                                    WHERE pc.id = jsc.scope_id))
                                 OR (jsc.scope_kind = 'dataset'
                                       AND EXISTS (SELECT 1 FROM datasets dc
                                                    WHERE dc.id = jsc.scope_id)) ))
                          OR EXISTS (
                            SELECT 1 FROM job_scope jsc WHERE jsc.job_id = jobs.id
                              AND ( (jsc.scope_kind = 'dataset' AND EXISTS (
                                       SELECT 1 FROM datasets dc
                                        WHERE dc.id = jsc.scope_id
                                          AND (dc.account_id IN (
                                                 SELECT am.account_id FROM account_members am
                                                  WHERE am.user_id = $1)
                                            OR EXISTS (
                                                 SELECT 1 FROM dataset_shares dsc
                                                  WHERE dsc.dataset_id = dc.id
                                                    AND ( (dsc.principal_type = 'user'
                                                             AND dsc.principal_id = $1)
                                                       OR (dsc.principal_type = 'group'
                                                             AND dsc.principal_id
                                                               IN (SELECT unhex(j.value)
                                                                     FROM json_each($2) AS j)) )))))
                                 OR (jsc.scope_kind = 'project' AND EXISTS (
                                       SELECT 1 FROM projects pc
                                        WHERE pc.id = jsc.scope_id
                                          AND (pc.account_id IN (
                                                 SELECT am.account_id FROM account_members am
                                                  WHERE am.user_id = $1)
                                            OR EXISTS (
                                                 SELECT 1 FROM project_shares psc
                                                  WHERE psc.project_id = pc.id
                                                    AND psc.recipient_id = $1
                                                    AND psc.status = 'accepted')))) ))))
                    OR EXISTS (
                         SELECT 1 FROM job_scope js WHERE js.job_id = jobs.id AND (
                              (js.scope_kind = 'dataset' AND EXISTS (
                                 SELECT 1 FROM datasets d WHERE d.id = js.scope_id AND (
                                      (d.owner_id = $1
                                       AND d.account_id IN (
                                             SELECT am.account_id FROM account_members am
                                              WHERE am.user_id = $1))
                                   OR EXISTS (
                                        SELECT 1 FROM dataset_shares ds
                                         WHERE ds.dataset_id = d.id AND ds.role = 'edit'
                                           AND ( (ds.principal_type = 'user'
                                                    AND ds.principal_id = $1)
                                              OR (ds.principal_type = 'group'
                                                    AND ds.principal_id
                                                      IN (SELECT unhex(j.value)
                                                            FROM json_each($2) AS j)) )))))
                           OR (js.scope_kind = 'project' AND EXISTS (
                                 SELECT 1 FROM projects p WHERE p.id = js.scope_id AND (
                                      (p.owner_id = $1
                                       AND p.account_id IN (
                                             SELECT am.account_id FROM account_members am
                                              WHERE am.user_id = $1))
                                   OR EXISTS (
                                        SELECT 1 FROM project_shares ps
                                         WHERE ps.project_id = p.id
                                           AND ps.recipient_id = $1
                                           AND ps.status = 'accepted'
                                           AND ps.permission_level = 'editor'))))))
                     )
                 AND ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM job_scope js2
                       WHERE js2.job_id = jobs.id
                         AND js2.scope_kind = 'project' AND js2.scope_id = $3))"#,
            user_id,
            json_group_ids,
            project_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok((jobs, total))
    }

    /// Mint the `jobs` row for a run this module does NOT schedule — today, a
    /// provenance verification re-run (`provenance::verify`) — admitting it under the
    /// SAME `max_concurrent_jobs` cap the scheduler enforces. `Ok(None)` ⇒ the pool is
    /// full and the caller refuses (429); the row is never created.
    ///
    /// ## Why a real row, and why born `running`
    ///
    /// A verification re-run is a full bwrap child, and before this it had no `jobs`
    /// row at all: it could not be listed, could not be stopped by anyone including an
    /// admin, and — because the cap is `SELECT count(*) … WHERE status = 'running'` —
    /// did not exist as far as admission control was concerned. A row is not
    /// bookkeeping here; it is the ONE fact that the whole jobs surface (list, get,
    /// logs, stop, sync fan-out, boot reconcile, the stale-workspace sweep) is already
    /// keyed on. Minting it buys all of them at once, versus re-implementing five
    /// mechanisms for one caller.
    ///
    /// Born `running`, never `queued`: `claim_next_fair` selects `status = 'queued'`,
    /// so a queued row would be claimed by the scheduler and dispatched a SECOND time,
    /// through the ingest path a verification must never touch. The caller drives the
    /// child itself; this row records and accounts for it.
    ///
    /// ## The admission check is INSIDE the INSERT
    ///
    /// `count_running() < cap` as a separate statement is the check-then-act the
    /// scheduler documents living with (safe only because one sequential loop owns the
    /// database). This caller is an HTTP handler and N of them can be in flight at
    /// once, so the count is a sub-select of the INSERT — one statement, no window.
    ///
    /// `job_type` is `"verify"`, NOT `"analysis"`, and that is load-bearing:
    /// `reconcile_orphaned_running` FINALIZES + INGESTS an orphaned running *analysis*
    /// job at boot. A verification must never reach the catalog, so it must not answer
    /// to that name; as a non-analysis orphan it is simply failed, which is correct.
    pub async fn create_running_under_cap(
        &self,
        id: Uuid,
        owner_id: Uuid,
        job_type: &str,
        name: &str,
        params: serde_json::Value,
        project_id: Option<Uuid>,
        cap: i64,
    ) -> Result<Option<Job>, AppError> {
        // T4: take the SAME claim serializer as `claim_next_fair` so the GLOBAL cap
        // is atomic ACROSS both admit paths — otherwise a verify born-running admit
        // here and a worker claim could both read `count = cap - 1` under READ
        // COMMITTED and both admit, overshooting the global cap. On SQLite the
        // serializer IS the transaction: `BEGIN IMMEDIATE` takes the database write
        // lock up front, so concurrent admits/claims serialize on it (the
        // `pg_advisory_xact_lock` statement of the PG path has no SQLite form).
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
        // The scope is what makes the row REACHABLE: without it `resolve_job_reach`
        // resolves scope-less ⇒ creator-and-admin-only, and the project's owner — whose
        // box is running this — could neither see nor stop it.
        if let Some(pid) = project_id {
            sqlx::query!(
                r#"INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)"#,
                job.id,
                pid,
            )
            .execute(&mut *tx)
            .await
            .map_err(AppError::database_error)?;
        }
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(Some(job))
    }

    /// Which of `ids` the caller may **STOP** — the batched form of
    /// [`super::authz::resolve_job_reach`]'s `Control` arm, for the list path, which
    /// must grade a whole page without a `resolve_job_reach` (2–3 queries) per row.
    ///
    /// Deliberately shaped like `DatasetRepository::editable_subset`, which exists for
    /// the same reason one directory over. And held to its Rust original the same way:
    /// this is a SECOND implementation of one rule, and `799d0cf3`'s second finding was
    /// a hand-copied predicate that had silently drifted from its original, so
    /// `the_batched_stop_grader_and_the_per_job_gate_agree` in the integration suite
    /// asserts the two answer identically per principal rather than trusting a reader
    /// to keep them in step.
    ///
    /// `is_admin` is NOT expressed here — an admin controls every job, and the caller
    /// short-circuits before asking. Everything else collapses to ownership: the job's
    /// own `owner_id` (its creator), or the owner of the dataset/project it is scoped
    /// to. The scope arms JOIN the target table, so a job whose dataset/project has
    /// since been deleted resolves to nobody — matching `job_scope`'s existence-aware
    /// lookup, which is what makes the Rust side answer `None` for the same row.
    ///
    /// Note what is ABSENT: no share table, no group predicate. That is the rule, not
    /// an omission — an `edit` sharee, a group editor and a project Editor may all SEE
    /// a job and none of them may end it, so a share join here would be the widening
    /// this pair of commits exists to prevent.
    ///
    /// H-1 (#147): the dataset/project owner arms additionally require CURRENT
    /// membership of the row's account, mirroring `resolve_job_reach`'s now-fixed
    /// dataset/project arms — otherwise a removed member could still STOP the
    /// account's running jobs on data they created.
    /// #167: the `j.owner_id = $2` (job CREATOR) arm now requires STANDING on the
    /// job's scope, the SQL mirror of `authz::creator_retains_standing`. `group_ids`
    /// is new for exactly that reason: standing admits an ACTIVE-group dataset share,
    /// and without the parameter this grader would refuse a principal
    /// `resolve_job_reach` admits — the drift
    /// `the_batched_stop_grader_and_the_per_job_gate_agree` exists to catch. It
    /// arrives already filtered to ACTIVE groups by `permissions::active_group_ids`
    /// (the caller's job, exactly as for [`Self::list_visible_to`]).
    pub async fn controllable_subset(
        &self,
        ids: &[Uuid],
        user_id: Uuid,
        group_ids: &[Uuid],
    ) -> Result<std::collections::HashSet<Uuid>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_ids = uuid_list_json(ids);
        let json_group_ids = uuid_list_json(group_ids);
        let rows = sqlx::query_scalar!(
            r#"SELECT j.id as "id: Uuid" FROM jobs j
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
                              AND ( (jsc.scope_kind = 'dataset' AND EXISTS (
                                       SELECT 1 FROM datasets dc
                                        WHERE dc.id = jsc.scope_id
                                          AND (dc.account_id IN (
                                                 SELECT am.account_id FROM account_members am
                                                  WHERE am.user_id = $2)
                                            OR EXISTS (
                                                 SELECT 1 FROM dataset_shares dsc
                                                  WHERE dsc.dataset_id = dc.id
                                                    AND ( (dsc.principal_type = 'user'
                                                             AND dsc.principal_id = $2)
                                                       OR (dsc.principal_type = 'group'
                                                             AND dsc.principal_id
                                                               IN (SELECT unhex(jv.value)
                                                                     FROM json_each($3) AS jv)) )))))
                                 OR (jsc.scope_kind = 'project' AND EXISTS (
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
                               (js.scope_kind = 'dataset' AND EXISTS (
                                  SELECT 1 FROM datasets d
                                   WHERE d.id = js.scope_id AND d.owner_id = $2
                                     AND d.account_id IN (
                                           SELECT am.account_id FROM account_members am
                                            WHERE am.user_id = $2)))
                            OR (js.scope_kind = 'project' AND EXISTS (
                                  SELECT 1 FROM projects p
                                   WHERE p.id = js.scope_id AND p.owner_id = $2
                                     AND p.account_id IN (
                                           SELECT am.account_id FROM account_members am
                                            WHERE am.user_id = $2)))))
                 )"#,
            json_ids,
            user_id,
            json_group_ids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().collect())
    }

    /// Every user who may SEE a job — the audience its `SyncEntity::Job` frames must
    /// reach. Mirrors [`Self::list_visible_to`]'s predicate from the other direction
    /// (given a job, who; rather than given a user, which jobs), because a row a user
    /// can list but is never told about is a row that sits stale until a manual
    /// reload. Returns the audience as `Some((anchor, others))` shaped for
    /// `fan_out_owner_scoped`, or `None` when NOBODY may see the job.
    ///
    /// The group arm resolves through ACTIVE groups only, matching every other gate.
    ///
    /// H-1 (#147): the dataset/project owner arms require that the row's OWN
    /// `owner_id` is still a member of the row's account (a correlated check, since
    /// this query enumerates principals rather than testing one). A removed member
    /// must stop receiving live job frames for the account's work, not merely be
    /// unable to fetch it.
    ///
    /// ## #167 × #168 — the CREATOR anchor (the fourth instance neither issue named)
    ///
    /// The job's own creator used to be returned unconditionally, from a bare
    /// `SELECT owner_id as "owner_id: Uuid" FROM jobs WHERE id = $1`, and the caller then put that id in
    /// the fan-out's owner slot. #147 hardened the dataset/project arms of the query
    /// BELOW and left that anchor standing, so a removed member could no longer OPEN
    /// the account's jobs and was still told, in real time, every time one changed
    /// state — a continuous activity oracle over the organization's compute. It is
    /// the creator short-circuit of #167 living inside the sync audience of #168, and
    /// it is fixed with #167's own predicate: the creator is in the audience iff they
    /// still have STANDING on the job's scope (a scope-LESS job stays creator-only,
    /// matching `Self::job_scope` and `authz::creator_retains_standing`).
    ///
    /// The creator arm carries an `is_admin` disjunct, and its scope is exactly one
    /// principal: **the admin who CREATED the job**. Without it, gating the creator arm
    /// would have dropped a platform admin who started a job against a tenant's dataset
    /// out of the audience for a job they can still open and STOP — a recipient removed
    /// who can demonstrably still read the row, the mirror-image of the leak this
    /// function is fixing.
    ///
    /// It does NOT make this audience agree with `authz::resolve_job_reach` in general,
    /// and no claim of that kind is made here: `resolve_job_reach` returns `Control` to
    /// ANY admin for ANY job, while this query (like `Self::list_visible_to`, which it
    /// mirrors) enumerates principals from the row and has never had a general admin
    /// arm. An admin who did not create the job is still absent from the audience and
    /// still absent from `list_visible_to` — the two are consistent with each other,
    /// which is the property the lock-step tests hold, and widening either to "every
    /// admin" would be a change to who receives raw job frames rather than a fix.
    ///
    /// Returning `Option` is what makes "nobody may see this job" expressible instead
    /// of silently addressing the ex-creator; it mirrors
    /// `account::sync::account_audience`. The anchor is the job's own owner when they
    /// are in the audience — so the ordinary case is byte-identical, including
    /// `origin` self-echo suppression — and otherwise the first other recipient,
    /// which `fan_out_owner_scoped` treats no differently (slot 0 is not privileged;
    /// it dedupes and stamps `origin` on whichever recipient IS the actor).
    pub async fn visible_to_user_ids(
        pool: &SqlitePool,
        job_id: Uuid,
    ) -> Result<Option<(Uuid, Vec<Uuid>)>, AppError> {
        let owner = sqlx::query_scalar!(r#"SELECT owner_id as "owner_id: Uuid" FROM jobs WHERE id = $1"#, job_id)
            .fetch_optional(pool)
            .await
            .map_err(AppError::database_error)?
            .ok_or_else(|| AppError::not_found("Job"))?;
        // Enumerated FORWARD (scope → its principals), not by testing every row of
        // `users` against the visibility predicate. The predicate form reads more like
        // `list_visible_to`'s mirror image, but it is O(users) per emit and this runs on
        // EVERY job transition — the shape that looks tidiest is the one that degrades
        // with the size of the deployment.
        let audience = sqlx::query_scalar!(
            r#"SELECT DISTINCT uid as "id: Uuid" FROM (
                 SELECT j.owner_id AS uid
                   FROM jobs j
                  WHERE j.id = $1 AND (
                        EXISTS (SELECT 1 FROM users u
                                 WHERE u.id = j.owner_id AND u.is_admin)
                     OR NOT EXISTS (
                          SELECT 1 FROM job_scope jsc WHERE jsc.job_id = j.id
                            AND ( (jsc.scope_kind = 'project'
                                     AND EXISTS (SELECT 1 FROM projects pc
                                                  WHERE pc.id = jsc.scope_id))
                               OR (jsc.scope_kind = 'dataset'
                                     AND EXISTS (SELECT 1 FROM datasets dc
                                                  WHERE dc.id = jsc.scope_id)) ))
                     OR EXISTS (
                          SELECT 1 FROM job_scope jsc WHERE jsc.job_id = j.id
                            AND ( (jsc.scope_kind = 'dataset' AND EXISTS (
                                     SELECT 1 FROM datasets dc
                                      WHERE dc.id = jsc.scope_id
                                        AND (dc.account_id IN (
                                               SELECT am.account_id FROM account_members am
                                                WHERE am.user_id = j.owner_id)
                                          OR EXISTS (
                                               SELECT 1 FROM dataset_shares dsc
                                                WHERE dsc.dataset_id = dc.id
                                                  AND ( (dsc.principal_type = 'user'
                                                           AND dsc.principal_id = j.owner_id)
                                                     OR (dsc.principal_type = 'group'
                                                           AND EXISTS (
                                                             SELECT 1 FROM user_groups ug2
                                                               JOIN groups g2
                                                                 ON g2.id = ug2.group_id
                                                                AND g2.is_active
                                                              WHERE ug2.group_id
                                                                      = dsc.principal_id
                                                                AND ug2.user_id
                                                                      = j.owner_id)) )))))
                               OR (jsc.scope_kind = 'project' AND EXISTS (
                                     SELECT 1 FROM projects pc
                                      WHERE pc.id = jsc.scope_id
                                        AND (pc.account_id IN (
                                               SELECT am.account_id FROM account_members am
                                                WHERE am.user_id = j.owner_id)
                                          OR EXISTS (
                                               SELECT 1 FROM project_shares psc
                                                WHERE psc.project_id = pc.id
                                                  AND psc.recipient_id = j.owner_id
                                                  AND psc.status = 'accepted')))) )) )
                 UNION
                 SELECT d.owner_id AS uid
                   FROM job_scope js JOIN datasets d ON d.id = js.scope_id
                  WHERE js.job_id = $1 AND js.scope_kind = 'dataset'
                    AND d.account_id IN (SELECT am.account_id FROM account_members am
                                          WHERE am.user_id = d.owner_id)
                 UNION
                 SELECT ds.principal_id
                   FROM job_scope js JOIN dataset_shares ds ON ds.dataset_id = js.scope_id
                  WHERE js.job_id = $1 AND js.scope_kind = 'dataset'
                    AND ds.role = 'edit' AND ds.principal_type = 'user'
                 UNION
                 SELECT ug.user_id
                   FROM job_scope js
                   JOIN dataset_shares ds ON ds.dataset_id = js.scope_id
                   JOIN user_groups ug ON ug.group_id = ds.principal_id
                   JOIN groups g ON g.id = ug.group_id AND g.is_active
                  WHERE js.job_id = $1 AND js.scope_kind = 'dataset'
                    AND ds.role = 'edit' AND ds.principal_type = 'group'
                 UNION
                 SELECT p.owner_id
                   FROM job_scope js JOIN projects p ON p.id = js.scope_id
                  WHERE js.job_id = $1 AND js.scope_kind = 'project'
                    AND p.account_id IN (SELECT am.account_id FROM account_members am
                                          WHERE am.user_id = p.owner_id)
                 UNION
                 SELECT ps.recipient_id
                   FROM job_scope js JOIN project_shares ps ON ps.project_id = js.scope_id
                  WHERE js.job_id = $1 AND js.scope_kind = 'project'
                    AND ps.status = 'accepted' AND ps.permission_level = 'editor'
               ) audience
               ORDER BY 1"#,
            job_id,
        )
        .fetch_all(pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(crate::modules::sync::owner_scoped_audience(owner, audience))
    }

    /// Admin: every user's jobs (newest first). `project_id`, when `Some`, filters to
    /// jobs scoped to that project via the `job_scope` JOIN (ITEM-67).
    ///
    /// Ordered `created_at DESC, id DESC` for the same reason as
    /// [`Self::list_visible_to`]: `created_at` alone is not a total order, so paging it
    /// can repeat one row and drop another. This list has ALWAYS spanned many creators
    /// (it is every user's jobs), so it has always been the most tie-prone of the three.
    pub async fn list_all(
        &self,
        project_id: Option<Uuid>,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<Job>, i64), AppError> {
        let offset = (page - 1).max(0) * per_page;
        let jobs = sqlx::query_as!(
            Job,
            r#"SELECT id as "id: Uuid", owner_id as "owner_id: Uuid", job_type, name, status,
                      params as "params: serde_json::Value",
                      created_at as "created_at: DateTime<Utc>",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      exit_code as "exit_code?: i32", error, pid as "pid?: i32",
                      priority_class, resource_class, req_cpu as "req_cpu?: i32",
                      req_mem_bytes, run_id as "run_id: Uuid"
               FROM jobs
               WHERE ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM job_scope js
                       WHERE js.job_id = jobs.id
                         AND js.scope_kind = 'project' AND js.scope_id = $3))
               ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2"#,
            per_page,
            offset,
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        let total = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM jobs
               WHERE ($1 IS NULL OR EXISTS (
                       SELECT 1 FROM job_scope js
                       WHERE js.job_id = jobs.id
                         AND js.scope_kind = 'project' AND js.scope_id = $1))"#,
            project_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok((jobs, total))
    }

    /// Fetch any job by id (the caller performs the owner-or-admin check).
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

    // ---- scheduler transitions ----

    /// Atomically claim the next queued job → `running`, ordered by fair-share:
    /// (owner's current running count ASC, class priority DESC, created_at ASC).
    /// When `exclude_batch`, `batch`-class jobs are skipped this tick (the
    /// reserved-interactive-slot admission gate, DEC-B). Reduces to FCFS when all
    /// queued rows share one owner + class. Safe under concurrent dispatch: the
    /// claim runs inside a transaction the caller opened `BEGIN IMMEDIATE` (the
    /// SQLite substitution for the PG `FOR UPDATE SKIP LOCKED` row lock — one
    /// writer at a time, no row to skip).
    ///
    /// ## T4 — the two concurrency caps are FOLDED into the claim (INV-1/INV-2)
    ///
    /// `global_cap` and `per_tenant_cap` are evaluated as sub-selects INSIDE the
    /// claim's `LIMIT 1` sub-query. The `LIMIT` prevents two workers grabbing the
    /// SAME row (INV-2), but it does NOT by itself make the CAP atomic: the
    /// `count(*)` sub-selects could each read a state where a peer's uncommitted
    /// `queued → running` claim is not visible, so two claimers picking DIFFERENT
    /// rows could each observe `count = cap - 1` and both claim — overshooting the
    /// cap. So the count-and-claim is serialized: on PG by a transaction-scoped
    /// `pg_advisory_xact_lock(CLAIM_ADVISORY_KEY)`, on SQLite by the write lock the
    /// `BEGIN IMMEDIATE` in this method takes BEFORE the statement — exactly one
    /// claimer runs the count+claim at a time, each sees the previous claim already
    /// COMMITTED, and the cap is enforced atomically across N workers (INV-1). The
    /// lock is held only for the fast claim UPDATE (a single indexed statement),
    /// never for job EXECUTION, and auto-releases at commit — so it serializes the
    /// claim DECISION (sub-ms) without serializing the jobs themselves.
    /// `create_running_under_cap` takes the SAME write lock first so the global cap
    /// is consistent across both admit paths.
    ///
    /// Both caps are kept (DEC-1): the GLOBAL cap bounds in-process concurrency on
    /// single-box `serve` (replica count = 1); the PER-TENANT cap bounds one owner
    /// across N workers. At the shipped defaults (global = per-tenant = 2)
    /// single-box behavior is unchanged. Passing a cap at/above the queued backlog
    /// makes that cap a no-op.
    ///
    /// `worker_id` is stamped into `claimed_by` (with `claim_heartbeat` = the
    /// canonical clock) alongside `status/started_at` — the ONLY additions to the
    /// SET clause; the fair-share `ORDER BY` and the RETURNING columns are
    /// unchanged (INV-5), so every `execute_job`/`finalize_analysis_with` caller
    /// sees the same row shape.
    pub async fn claim_next_fair(
        &self,
        exclude_batch: bool,
        worker_id: &str,
        global_cap: i64,
        per_tenant_cap: i64,
    ) -> Result<Option<Job>, AppError> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        // Serialize the count-and-claim across ALL claimers so the cap count
        // sub-selects can never both read cap-1 (INV-1). The SQLite substitution:
        // the write lock taken by `BEGIN IMMEDIATE` above IS the serializer — one
        // writer at a time, each claimer's count sub-select sees the previous
        // claimer's COMMITTED claim (a deferred `BEGIN` would defer the lock to
        // the first write and defeat the count-and-claim; the PG
        // `pg_advisory_xact_lock` statement has no SQLite form).
        let claimed = sqlx::query_as!(
            Job,
            r#"UPDATE jobs
                  SET status = 'running',
                      started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      claimed_by = $2,
                      claim_heartbeat = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = (
                   SELECT j.id FROM jobs j
                   WHERE j.status = 'queued'
                     AND ($1 = false OR j.priority_class <> 'batch')
                     -- GLOBAL cap (DEC-1): total running < $3.
                     AND (SELECT COUNT(*) FROM jobs g WHERE g.status = 'running') < $3
                     -- PER-TENANT cap (§6): this owner's running < $4. The same
                     -- per-owner sub-query the ORDER BY already uses (reused, not
                     -- invented) — index-only via idx_jobs_status_owner.
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
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", job_type, name, status,
                         params as "params: serde_json::Value",
                         created_at as "created_at: DateTime<Utc>",
                         started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         exit_code as "exit_code?: i32", error, pid as "pid?: i32",
                         priority_class, resource_class, req_cpu as "req_cpu?: i32",
                         req_mem_bytes, run_id as "run_id: Uuid""#,
            exclude_batch,
            worker_id,
            global_cap,
            per_tenant_cap
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        // Commit releases the write lock, publishing this claim to the next claimer.
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(claimed)
    }

    /// T4 (INV-3, ITEM-3): advance `claim_heartbeat` for THIS worker's own
    /// `running` rows only. Called on the heartbeat cadence (~10s, apalis-shaped)
    /// so a live worker's rows are never seen as stale by the reaper. Scoped to
    /// `claimed_by = $worker_id` so one worker can never refresh another's rows.
    /// Returns the number of rows touched (0 when this worker holds nothing).
    pub async fn heartbeat_running(&self, worker_id: &str) -> Result<u64, AppError> {
        let res = sqlx::query!(
            r#"UPDATE jobs SET claim_heartbeat = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE status = 'running' AND claimed_by = $1"#,
            worker_id
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected())
    }

    /// T4 (INV-3/INV-4, ITEM-4): the stale-claim reaper's re-queue step
    /// (Oban-Lifeline-shaped). Reset back to `queued` — clearing `claimed_by`/
    /// `claim_heartbeat`/`started_at`/`pid`, bumping `reclaim_count` — every
    /// `running` row whose heartbeat is older than `stale_secs` AND still UNDER
    /// `max_reclaims` (a poison job at the limit is discarded by
    /// [`Self::reaper_sweep`], through the shared `discard_exhausted_rows` helper,
    /// never re-queued). `LIMIT`-capped per §4.
    /// Returns the (id, owner) pairs reclaimed. Shares its SQL with
    /// [`Self::reaper_sweep`] (the production path) via [`reclaim_stale_rows`], so
    /// the two can never drift.
    pub async fn reclaim_stale(
        &self,
        stale_secs: i64,
        max_reclaims: i32,
        limit: i64,
    ) -> Result<u64, AppError> {
        let rows = reclaim_stale_rows(&self.pool, stale_secs, max_reclaims, limit).await?;
        Ok(rows.len() as u64)
    }

    // The standalone `discard_exhausted` wrapper (T4, DEC-9) was DELETED by #295: it was a
    // convenience shim over [`discard_exhausted_rows`] that never acquired a caller, unlike
    // its sibling `reclaim_stale`. The discard-at-max BEHAVIOUR is unchanged and still on the
    // production path — [`Self::reaper_sweep`] calls the same helper inside the leader-locked
    // sweep, driven from `scheduler.rs`, and `tests/jobs/reaper_single_runner_test.rs` proves
    // it. A `pub` shim with no caller is invisible to `dead_code` in a library crate.

    /// T4 (INV-3/INV-4, ITEM-4): the full stale-claim reaper sweep under a
    /// single-leader gate, in ONE transaction — THE production reaper path.
    ///
    /// The PG path took a **transaction-scoped** `pg_try_advisory_xact_lock($key)`
    /// FIRST so that, of N workers ticking their reaper at once, exactly ONE
    /// acquires the lock and runs the sweep; the rest see `false` and no-op
    /// immediately (River's single-maintenance-leader intent). SQLite has no
    /// advisory locks; the single-leader gate is therefore an in-process
    /// `tokio::sync::Mutex` **try**-lock — the same "exactly one leader per tick"
    /// contract for the app's one-process topology (the desktop/`serve` box runs
    /// one server; each scheduler tick task is in-process). The cross-process
    /// residue is benign by construction: a second process's losing sweep is a
    /// predicate no-op, because SQLite serializes its writes on the database lock
    /// and the sweep statements re-check the heartbeat predicate — a row the
    /// winner already re-queued is no longer `running`. The `key` parameter is
    /// gone with the mechanism.
    ///
    /// The sweep transaction opens `BEGIN IMMEDIATE` (the claim+heartbeat writers
    /// serialize on it), re-queues stale-but-under-limit rows and discards poison
    /// rows AT the limit, using the SAME [`reclaim_stale_rows`]/
    /// [`discard_exhausted_rows`] the standalone methods use (no duplicated SQL),
    /// both `LIMIT`-capped (§4). Returns a [`ReaperOutcome`] naming the (id, owner)
    /// rows it touched so the CALLER can emit sync + run the DAG cascade for the
    /// discards (a raw UPDATE cannot); `None` for a worker that did not win the
    /// gate this tick.
    pub async fn reaper_sweep(
        &self,
        stale_secs: i64,
        max_reclaims: i32,
        limit: i64,
    ) -> Result<Option<ReaperOutcome>, AppError> {
        let _leader = match REAPER_GATE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .try_lock()
        {
            Ok(guard) => guard,
            Err(_) => {
                // Either another reaper in THIS process owns this tick (the PG
                // path's `pg_try_advisory_xact_lock` false arm) or the gate
                // mutex was poisoned by a panic in a previous sweep. The gate is
                // an optimization, never a correctness requirement — both arms
                // are the same no-op. (tokio 1.52's `TryLockError` is a unit
                // struct with no variants to match.)
                return Ok(None);
            }
        };
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let reclaimed = reclaim_stale_rows(&mut *tx, stale_secs, max_reclaims, limit).await?;
        let discarded = discard_exhausted_rows(&mut *tx, stale_secs, max_reclaims, limit).await?;
        // Cascade each discarded poison job's failure to its transitive
        // `blocked`/`queued` dependents — IN THE SAME transaction, under the reaper
        // lock, via the CANONICAL ordered cascade the normal fail/finish paths use.
        // (Not a runtime `reconcile_blocked_jobs`: that runs a differently-ordered
        // CTE whose lock order could deadlock against a live finisher on PG; on
        // SQLite the single write lock makes lock order moot, but the canonical
        // path is still the one to reuse.) Without this a dependent
        // of a discarded job would hang `blocked` forever.
        for (id, _owner) in &discarded {
            Self::cascade_fail_dependents(&mut *tx, *id).await?;
        }
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(Some(ReaperOutcome {
            reclaimed,
            discarded,
        }))
    }

    pub async fn count_running(&self) -> Result<i64, AppError> {
        sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!" FROM jobs WHERE status = 'running'"#)
            .fetch_one(&self.pool)
            .await
            .map_err(AppError::database_error)
    }

    /// Count running jobs of a given priority class (the reserved-slot gate).
    pub async fn count_running_class(&self, class: &str) -> Result<i64, AppError> {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM jobs
               WHERE status = 'running' AND priority_class = $1"#,
            class
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Whether any queued job of a given priority class exists (interactive
    /// pressure lets batch use the reserved slots only when this is false).
    pub async fn has_queued_class(&self, class: &str) -> Result<bool, AppError> {
        let n = sqlx::query_scalar!(
            r#"SELECT EXISTS(
                   SELECT 1 FROM jobs WHERE status = 'queued' AND priority_class = $1
               ) as "exists: bool""#,
            class
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(n)
    }

    /// Record the running child's pid (so stop can signal it). Guarded on
    /// `status = 'running'` so a stop that raced the claim (already flipped the
    /// row to `stopped`) doesn't get a stale pid written back onto it.
    pub async fn set_pid(&self, id: Uuid, pid: i32) -> Result<(), AppError> {
        sqlx::query!(
            "UPDATE jobs SET pid = $2 WHERE id = $1 AND status = 'running'",
            id,
            pid
        )
        .execute(&self.pool)
        .await
        .map(|_| ())
        .map_err(AppError::database_error)
    }

    /// Mark a running job terminal from its exit code (0 → completed, else
    /// failed). Clears the pid.
    pub async fn finish(&self, id: Uuid, exit_code: i32) -> Result<(), AppError> {
        // The terminal transition + DAG propagation (unblock on completion, cascade
        // on failure) land in ONE transaction so no concurrent claim sees a
        // half-propagated graph (ITEM-19). `BEGIN IMMEDIATE`: see
        // [`Self::unblock_dependents`] — the read-then-write DAG decision needs
        // the write lock from the open.
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let transitioned = Self::finish_in_tx(&mut tx, id, exit_code).await?;
        tx.commit().await.map_err(AppError::database_error)?;
        // §7 notify-and-refetch — AFTER the commit, and only when THIS call actually
        // performed the transition. `transitioned.owner_id` is the TRANSITION GUARD
        // (`Some` ⇔ the guarded UPDATE matched a row), not the audience: the frame is
        // about the DATASET, so it is addressed to the dataset's own owner ∪ sharees.
        // See [`Self::publish_dataset_after_terminal`].
        if transitioned.owner_id.is_some() {
            self.publish_dataset_after_terminal(id).await;
        }
        self.note_cascaded_reasons(&transitioned.cascaded).await;
        // draftable-entity DEC-2 (INV-6): announce every draft this completion froze —
        // a DETACHED `Draft/Update` to the project audience, post-commit + best-effort.
        crate::modules::jobs::seams::freeze_completion_sink()
            .emit_frozen(&transitioned.frozen_drafts)
            .await;
        Ok(())
    }

    /// [`Self::finish`] on a CALLER-OWNED transaction — `finish` is exactly
    /// `begin` + this + `commit` + the post-commit sync emit.
    ///
    /// Split out so a caller that is already mid-transaction can finish a job
    /// atomically with its own writes, and so the concurrent-finisher
    /// interleaving that [`Self::unblock_dependents`] guards against can be
    /// driven DETERMINISTICALLY from a test (two transactions, explicit commit
    /// order) instead of being raced for.
    ///
    /// Returns a [`TerminalTransition`]: the OWNER of the job this call transitioned
    /// (`None` when the guarded UPDATE matched no row — already terminal, a
    /// double-finish), plus the ids it cascade-failed. BOTH are post-commit obligations
    /// of a caller that owns the transaction — [`Self::publish_dataset_after_terminal`]
    /// for the first (else the dataset badge stays stale) and
    /// [`Self::note_cascaded_reasons`] for the second (else a job that was failed
    /// without ever running has no explanation any reader can see). Neither can happen
    /// in here: this transaction may still roll back, and announcing — or explaining — a
    /// change that never committed is worse than doing neither.
    pub async fn finish_in_tx(
        conn: &mut SqliteConnection,
        id: Uuid,
        exit_code: i32,
    ) -> Result<TerminalTransition, AppError> {
        let status = if exit_code == 0 {
            "completed"
        } else {
            "failed"
        };
        // RETURNING the owner rather than counting rows: it answers "did this call
        // transition the row?" AND "whose devices should hear about it?" in the ONE
        // guarded statement, read off the row we just wrote (no second lookup that a
        // concurrent delete could race).
        let owner_id = sqlx::query_scalar!(
            r#"UPDATE jobs SET status = $2,
              finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), exit_code = $3, pid = NULL
             WHERE id = $1 AND status = 'running'
             RETURNING owner_id as "owner_id: Uuid""#,
            id,
            status,
            exit_code
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)?;
        let mut cascaded = Vec::new();
        let mut frozen_drafts = Vec::new();
        if owner_id.is_some() {
            if exit_code == 0 {
                // draftable-entity DEC-2: if THIS job is a draft-freeze producer, stamp
                // its draft `frozen` and substitute draft_ref→artifact_ref into every
                // dependent consumer's persisted params — BEFORE unblocking them, so the
                // consumer dispatches pinned (no unresolved draft_ref reaches staging).
                // No-op (returns empty) for every non-freeze completion.
                frozen_drafts = crate::modules::jobs::seams::freeze_completion_sink()
                    .on_freeze_completed_in_tx(&mut *conn, id)
                    .await
                    .map_err(AppError::internal_error)?;
                Self::unblock_dependents(&mut *conn, id).await?;
            } else {
                cascaded = Self::cascade_fail_dependents(&mut *conn, id).await?;
            }
        }
        Ok(TerminalTransition {
            owner_id,
            cascaded,
            frozen_drafts,
        })
    }

    /// Announce a job's just-committed TERMINAL transition to the owner's devices as
    /// a `sync:dataset` Update, when that job is dataset-scoped (ITEM-68).
    ///
    /// ## Why this exists
    ///
    /// A dataset's `processing_status` is DERIVED from its processing job's row
    /// (`dataset::repository::processing_status_map`), so `running → completed|failed`
    /// changes what `GET /api/datasets/{id}` returns with no write to `datasets` at
    /// all. During an on-ingest converter run exactly one `sync:dataset` frame used to
    /// be published — from the metadata-write finalize seam (`jobs/seams.rs`), which
    /// runs while the job is still `running` — and NOTHING was published when the job
    /// then flipped terminal. A client that loaded (or refetched) before that flip was
    /// stale for the life of the page: measured, the detail badge read "Processing" for
    /// 40 s of continuous polling while the API already said `completed`, and one manual
    /// reload showed "Ready".
    ///
    /// ## Contract
    ///
    /// - **Post-commit only.** Every caller invokes this AFTER its transaction
    ///   committed, never inside it — a rolled-back change must not be announced.
    /// - **Transitions only.** Callers gate on their guarded UPDATE having matched a
    ///   row, so a double-finish (0 rows) emits nothing.
    /// - **Dataset-scoped only.** A project-scoped or scope-less job resolves to no
    ///   dataset and emits nothing — no frame is invented for a job that has none.
    ///   Resolution goes through [`Self::job_scope`], so it inherits that lookup's
    ///   existence-awareness: a job whose dataset was deleted mid-run resolves to
    ///   `None` and is silent rather than pointing devices at a dead id.
    /// - **Addressed to the DATASET's audience, `origin = None`.** This is a DETACHED
    ///   completion (the scheduler's executor, or a boot reconcile), not a
    ///   user-originated mutation, so there is no originating connection to suppress.
    ///   It used to take an `owner_id` and address `Audience::owner(job.owner_id)` —
    ///   the JOB's owner, which is a different fact from the DATASET's owner. They
    ///   coincide only when a user processes their own dataset; `require_can_edit`
    ///   admits an `edit`-role sharee to `POST /datasets/{id}/process`, and on that
    ///   path the dataset's OWNER was told nothing at all while their dataset's badge
    ///   sat on "Processing". The parameter is gone: this resolves the audience from
    ///   the dataset (see `dataset::sync::publish_dataset_change`), so there is no
    ///   longer an id to pass the wrong value into.
    ///
    /// Best-effort by construction: `sync::publish` is synchronous and infallible, and
    /// a scope-lookup error is logged rather than propagated — a realtime hint must
    /// never turn an already-persisted terminal transition into a failure.
    pub async fn publish_dataset_after_terminal(&self, job_id: Uuid) {
        let scope = match Self::job_scope(&self.pool, job_id).await {
            Ok(scope) => scope,
            Err(err) => {
                tracing::warn!(
                    %job_id, error = ?err,
                    "resolving job scope for the terminal sync emit failed; the owner's \
                     devices will not live-refresh this dataset until their next refetch"
                );
                return;
            }
        };
        let Some(JobScope::Dataset(dataset_id)) = scope else {
            return;
        };
        crate::modules::dataset::sync::publish_dataset_change(
            &self.pool,
            dataset_id,
            crate::modules::sync::SyncAction::Update,
            crate::modules::sync::Actor::detached(),
        )
        .await;
        tracing::debug!(%job_id, %dataset_id, "terminal job transition published as a dataset sync update");
    }

    /// Mark a job failed with an error message (spawn failure, etc.), and record that
    /// reason as the job's TERMINAL `stderr` log line.
    ///
    /// ## Why the log line is part of failing, not part of each call site
    ///
    /// `job_logs` has exactly one other writer: the scheduler's stdout/stderr pump over a
    /// LIVE child process. Every caller of this method fails a job that has NO child — the
    /// pre-spawn arch refusal, the staging-ceiling spawn timeout, the two boot-reconcile
    /// refusals — so each of them produced a job whose entire explanation lived in the
    /// `jobs.error` column: a field the log stream does not carry, no SSE follower ever
    /// receives, and a log pane does not render. The reason existed and was unreachable
    /// from where a reader was looking.
    ///
    /// Doing it HERE rather than at those four call sites is the point. A predicate
    /// repeated at N call sites has the same shape as the bug it fixes: the N+1th author
    /// writes the `fail` and forgets the log, and nothing tells them. There is exactly one
    /// caller for whom the log ALREADY carries the reason, and it says so by name —
    /// [`Self::fail_reason_already_logged`].
    ///
    /// The line is the `error` string VERBATIM: no prefix, no paraphrase. A reader that
    /// also renders `job.error` decides whether that standalone block is still needed by
    /// asking whether the log already ends with it, so any decoration would make the same
    /// sentence render twice.
    pub async fn fail(&self, id: Uuid, error: &str) -> Result<(), AppError> {
        self.fail_inner(id, error, true).await
    }

    /// [`Self::fail`] for the ONE caller whose `error` is a FOLD of lines the job's log
    /// already carries.
    ///
    /// `scheduler::with_stderr_tail` builds a failed analysis's terminal `error` by
    /// appending the child's last stderr lines to the reason, precisely so that surfaces
    /// showing only `job.error` carry a diagnosis. That job HAD a child and its log holds
    /// those lines in full and in order; appending the fold back onto the log would print
    /// the tail a second time, joined by `" | "` and truncated — a lossy duplicate of what
    /// is already there.
    ///
    /// This is the explicit opt-out, and the only one. It is deliberately NOT the default:
    /// a new call site gets the log line unless its author states, here, that the log has
    /// the reason covered.
    pub async fn fail_reason_already_logged(&self, id: Uuid, error: &str) -> Result<(), AppError> {
        self.fail_inner(id, error, false).await
    }

    async fn fail_inner(&self, id: Uuid, error: &str, note_in_log: bool) -> Result<(), AppError> {
        // `BEGIN IMMEDIATE` for the same read-then-cascade reason as `finish`.
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        // RETURNING the owner for the same reason [`Self::finish_in_tx`] does: this is
        // the OTHER terminal path an on-ingest converter takes (the executor calls it
        // when finalize/ingest fails, and the boot reconcile calls it for an
        // unfinalizable orphan), and `failed` is just as terminal for the dataset badge
        // as `completed` is.
        let owner = sqlx::query_scalar!(
            r#"UPDATE jobs SET status = 'failed',
              finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error = $2, pid = NULL
             WHERE id = $1 AND status IN ('blocked','queued','running')
             RETURNING owner_id as "owner_id: Uuid""#,
            id,
            error
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let mut cascaded = Vec::new();
        if owner.is_some() {
            cascaded = Self::cascade_fail_dependents(&mut tx, id).await?;
        }
        tx.commit().await.map_err(AppError::database_error)?;
        // Everything below is POST-COMMIT and gated on this call having actually
        // transitioned the row: a `fail` that matched no row (already terminal — a retry,
        // a racing caller) changed nothing, so it explains nothing and announces nothing.
        // The log is a record of transitions, not of attempts.
        if owner.is_some() && note_in_log {
            self.append_terminal_reason(id, error).await;
        }
        if owner.is_some() {
            self.publish_dataset_after_terminal(id).await;
        }
        self.note_cascaded_reasons(&cascaded).await;
        Ok(())
    }

    /// Append `reason` to a job's log as its TERMINAL `stderr` line, and push it to every
    /// live SSE follower so a client watching the job meets it AT THE MOMENT IT HAPPENS
    /// rather than on its next refetch.
    ///
    /// POST-COMMIT and best-effort, in that order and for the same reason as
    /// [`Self::publish_dataset_after_terminal`]: a rolled-back failure must not leave a log
    /// line claiming it happened, and a DB fault while writing the record of a reason must
    /// never be able to un-fail a job that is already durably failed. A failure here is
    /// therefore logged at `warn!` and dropped — never swallowed silently, because "the
    /// explanation is missing" is itself something an operator needs to know.
    ///
    /// `seq` comes from [`Self::next_log_seq`] (`max + 1`), which is what makes the line
    /// TERMINAL: it sorts after everything the run itself wrote. Same mechanism
    /// `jobs::conformance::record_outcome` uses to append to a finished run.
    async fn append_terminal_reason(&self, job_id: Uuid, reason: &str) {
        let seq = match self.next_log_seq(job_id).await {
            Ok(seq) => seq,
            Err(e) => {
                tracing::warn!(
                    %job_id, error = ?e,
                    "jobs: could not resolve the next log seq; this job's failure reason \
                     stays in the `error` column only"
                );
                return;
            }
        };
        match self.append_log(job_id, seq, "stderr", reason).await {
            Ok(log) => runtime().broadcast(job_id, SSEJobEvent::Log(log).into()),
            Err(e) => tracing::warn!(
                %job_id, error = ?e,
                "jobs: the terminal failure reason was NOT recorded on the job's log — the \
                 job is still failed, but a reader of its log will not see why"
            ),
        }
    }

    /// The post-commit half a terminal transition owes every job it CASCADE-failed.
    ///
    /// A cascade-failed job never ran, so nothing can have logged for it: `dependency_failed`
    /// in a column is, to a reader of the job's log, indistinguishable from no explanation
    /// at all. [`DEPENDENCY_FAILED`] is the same constant the cascade UPDATE binds, so the
    /// reason in the log cannot drift from the reason in the row.
    ///
    /// `pub` because [`Self::finish_in_tx`] hands its caller the ids and cannot discharge
    /// this itself — see [`TerminalTransition`].
    pub async fn note_cascaded_reasons(&self, cascaded: &[Uuid]) {
        for id in cascaded {
            self.append_terminal_reason(*id, DEPENDENCY_FAILED).await;
        }
    }

    /// The LAST `n` captured `stderr` lines, oldest→newest — the diagnostic tail the
    /// executor folds into a failed analysis's terminal `error`.
    ///
    /// Without it a non-zero exit persists only `analysis exited with code 1`, which says
    /// nothing about WHY: the actual reason (e.g. a converter fed a malformed upload
    /// printing `h5ad_import: FAILED: OSError: Unable to synchronously open file (bad
    /// superblock version number)`) lives ONLY in `job_logs`, so every surface that shows
    /// `job.error` reports a terminal failure with no cause.
    pub async fn last_stderr_lines(&self, id: Uuid, n: i64) -> Result<Vec<String>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement, so a
        // fn-call temporary would drop before the execute (E0716 class).
        let tail = n.clamp(1, 100);
        let mut rows: Vec<String> = sqlx::query_scalar!(
            "SELECT content FROM job_logs WHERE job_id = $1 AND stream = 'stderr'
             ORDER BY seq DESC LIMIT $2",
            id,
            tail,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        rows.reverse();
        Ok(rows)
    }

    /// Mark a job stopped (cancel a queued job, or record a signalled running
    /// job). Only non-terminal jobs transition; returns the updated row, or
    /// `None` if it was already terminal (→ 409 in the handler).
    pub async fn mark_stopped(&self, id: Uuid) -> Result<Option<Job>, AppError> {
        // `BEGIN IMMEDIATE` (the write lock covers the guarded UPDATE + the
        // cascade scan as one unit).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let job = sqlx::query_as!(
            Job,
            r#"UPDATE jobs SET status = 'stopped',
                      finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), pid = NULL
               WHERE id = $1 AND status IN ('blocked','queued','running')
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", job_type, name, status,
                         params as "params: serde_json::Value",
                         created_at as "created_at: DateTime<Utc>",
                         started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         exit_code as "exit_code?: i32", error, pid as "pid?: i32",
                         priority_class, resource_class, req_cpu as "req_cpu?: i32",
                         req_mem_bytes, run_id as "run_id: Uuid""#,
            id
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        // A stopped job cascade-fails its dependents (they can never run — ITEM-19).
        let mut cascaded = Vec::new();
        if job.is_some() {
            cascaded = Self::cascade_fail_dependents(&mut tx, id).await?;
        }
        tx.commit().await.map_err(AppError::database_error)?;
        // The stopped job itself gets no terminal log line: a cancel is not a failure with
        // a reason (it writes no `error`), and the user who asked for it already knows. Its
        // cascade-failed dependents DO — they were failed by something they never saw.
        self.note_cascaded_reasons(&cascaded).await;
        // The THIRD terminal writer (`stopped` maps to the dataset badge's `failed` —
        // `dataset::models::map_processing_status`), so it owes the same post-commit
        // emit as `finish`/`fail`; `None` here means "was already terminal", which is
        // exactly the no-emit case. `origin = None` even though a cancel can be
        // user-originated: the wire frame carries no row data, so the worst case is
        // that the originating device performs one redundant refetch of a dataset it
        // just changed.
        if job.is_some() {
            self.publish_dataset_after_terminal(id).await;
        }
        Ok(job)
    }

    /// Unblock the direct dependents of a just-`completed` job whose EVERY
    /// dependency is now `completed` (`blocked`→`queued`, ITEM-19). Same-txn with
    /// the completion write.
    ///
    /// ## Why the LOCK case (lost-unblock under two concurrent finishers)
    ///
    /// Diamond `A→B`, `A→C`, `B&C→D`. When B and C complete CONCURRENTLY, each
    /// runs this in its own transaction. C's `NOT EXISTS` would still see B
    /// incomplete (and vice versa) — **neither unblocks D and D stays `blocked`
    /// forever** — unless the two finishers' decisions are serialized.
    ///
    /// A single guarded `UPDATE` cannot fix this by itself: a row filtered out by
    /// the `NOT EXISTS` is never written, so on PG, where the isolation model lets
    /// two writers each decide on their own snapshot, nothing serialized them.
    /// On SQLite the isolation model is SINGLE-writer: every terminal transition
    /// opens `BEGIN IMMEDIATE`, so the database write lock is taken at the
    /// transaction's open and a concurrent finisher's `BEGIN IMMEDIATE` BLOCKS
    /// there until the first commits. The loser's transaction then begins with a
    /// snapshot that INCLUDES the winner's committed `completed`, so the decision
    /// made in step (2) below sees it — the same "the last finisher in wins" sweep
    /// PG's `FOR UPDATE` + per-statement snapshots produced, but the lock is held
    /// for the whole transition, not just the dependent rows.
    ///
    /// The two statements are therefore kept (they are the read-then-decide shape;
    /// the second one re-matches the join condition against the snapshot the write
    /// lock guarantees), but the `FOR UPDATE` clauses are gone and the first
    /// statement is a plain read: the caller's transaction IS the lock.
    /// `ORDER BY id` is kept — deterministic processing of a shared dependent set,
    /// and harmless under the single write lock.
    async fn unblock_dependents(
        conn: &mut SqliteConnection,
        completed_id: Uuid,
    ) -> Result<(), AppError> {
        // (1) Read the still-`blocked` direct dependents.
        let locked: Vec<Uuid> = sqlx::query_scalar!(
            r#"SELECT id as "id: Uuid" FROM jobs
               WHERE status = 'blocked'
                 AND id IN (SELECT job_id FROM job_dependencies WHERE depends_on_job_id = $1)
               ORDER BY id"#,
            completed_id,
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(AppError::database_error)?;
        if locked.is_empty() {
            return Ok(());
        }

        // (2) Re-check the join condition in a SEPARATE statement. Under the
        // `BEGIN IMMEDIATE` write lock this transaction's snapshot was taken after
        // every concurrent finisher committed, so it is GUARANTEED to see the
        // winner's `completed` — the same "last finisher in wins" property the PG
        // per-statement READ-COMMITTED snapshots produced.
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_locked = uuid_list_json(&locked);
        sqlx::query!(
            r#"UPDATE jobs SET status = 'queued'
               WHERE status = 'blocked'
                 AND id IN (SELECT unhex(jv.value) FROM json_each($1) AS jv)
                 AND NOT EXISTS (
                     SELECT 1 FROM job_dependencies jd JOIN jobs j ON j.id = jd.depends_on_job_id
                     WHERE jd.job_id = jobs.id AND j.status <> 'completed')"#,
            json_locked,
        )
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(AppError::database_error)
    }

    /// Cascade a just-`failed`/`stopped` job's failure to ALL its transitive
    /// dependents that have not yet run (`blocked`/`queued` → `failed`,
    /// [`DEPENDENCY_FAILED`]). Recursive over the dependency graph (ITEM-19).
    ///
    /// **Returns the ids it failed**, because they are the caller's post-commit
    /// obligation: each is a job that never ran, so nothing can have written it a log line
    /// and its reason would otherwise exist only in a column. The caller discharges it
    /// with [`Self::note_cascaded_reasons`] after committing.
    async fn cascade_fail_dependents(
        conn: &mut SqliteConnection,
        failed_id: Uuid,
    ) -> Result<Vec<Uuid>, AppError> {
        sqlx::query_scalar!(
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
               RETURNING id as "id: Uuid""#,
            failed_id,
            DEPENDENCY_FAILED,
        )
        .fetch_all(conn)
        .await
        .map_err(AppError::database_error)
    }

    /// The `(id, params)` of every direct dependent of `dep_job_id` still `blocked`
    /// (draftable-entity DEC-2). Generic — the caller (the drafts
    /// freeze-completion hook) decides what to rewrite in each `params`; the jobs module
    /// owns the SQL but carries no draftable vocabulary. Runs on the completion
    /// transaction's `conn` so the read + the follow-up [`Self::update_job_params_in_conn`]
    /// write are atomic with the completion + unblock.
    ///
    /// The serialization is load-bearing for a consumer with MULTIPLE open-draft inputs
    /// whose freeze producers complete CONCURRENTLY: without it, each completion's hook
    /// could read its own snapshot of the consumer's `params`, substitute only its own
    /// `draft_ref`, and the last writer clobber the first's pin — one `draft_ref` then
    /// reaching staging unresolved and the consumer failing. On PG the completion's
    /// `SELECT … FOR UPDATE` serialized the two hooks on the consumer row (with the
    /// READ-COMMITTED EvalPlanQual re-read delivering the already-pinned params to the
    /// second hook). On SQLite the substitution is the caller's transaction: the
    /// completion transaction opens `BEGIN IMMEDIATE`, so the second hook's
    /// transaction waits at its open and then reads the committed first pin — both
    /// pins land, in order. The `FOR UPDATE` clause is therefore gone (the lock is
    /// the transaction) and `ORDER BY id` is kept for deterministic processing.
    pub async fn list_blocked_dependents_with_params(
        conn: &mut SqliteConnection,
        dep_job_id: Uuid,
    ) -> Result<Vec<(Uuid, serde_json::Value)>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT id as "id: Uuid", params as "params: serde_json::Value"
               FROM jobs
               WHERE status = 'blocked'
                 AND id IN (SELECT job_id FROM job_dependencies WHERE depends_on_job_id = $1)
               ORDER BY id"#,
            dep_job_id,
        )
        .fetch_all(conn)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| (r.id, r.params)).collect())
    }

    /// Replace a job's persisted `params` on the caller's `conn` (draftable-entity
    /// DEC-2). Generic — used by the freeze-completion hook to pin `artifact_ref` into a
    /// blocked consumer's spec before it is unblocked. Guarded to `blocked` so a params
    /// rewrite can only touch a job that has not yet been claimed.
    pub async fn update_job_params_in_conn(
        conn: &mut SqliteConnection,
        job_id: Uuid,
        params: &serde_json::Value,
    ) -> Result<(), AppError> {
        sqlx::query!(
            "UPDATE jobs SET params = $2 WHERE id = $1 AND status = 'blocked'",
            job_id,
            params,
        )
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(AppError::database_error)
    }

    /// A completed job's EFFECTIVE run id (`COALESCE(run_id, id)`, DEC-G), read on the
    /// caller's `conn` (draftable-entity DEC-2). The freeze-completion hook needs it to
    /// resolve the minted artifact. `None` for a missing job.
    pub async fn effective_run_id_in_conn(
        conn: &mut SqliteConnection,
        job_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        let row = sqlx::query_scalar!(
            r#"SELECT COALESCE(run_id, id) as "run_id: Uuid" FROM jobs WHERE id = $1"#,
            job_id,
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.flatten())
    }

    /// Boot run-durability reconcile (ITEM-19 / DEC-18): every job still `running`
    /// from a prior process (its child died with the server), full rows, so the
    /// scheduler can decide per-job whether to FINALIZE (workspace holds a valid
    /// `/outputs/manifest.json`) or FAIL with the workspace preserved. Replaces the
    /// old blanket `running → failed` reset (which discarded a finished-but-
    /// uningested, possibly hours-long, run).
    pub async fn list_running(&self) -> Result<Vec<Job>, AppError> {
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
               FROM jobs WHERE status = 'running' ORDER BY created_at ASC"#
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Every non-terminal job's id (for the boot stale-workspace sweep: a
    /// workspace dir whose job is terminal/absent is safe to remove). `blocked` is
    /// included alongside `queued`/`running` so a job still waiting on its
    /// dependencies keeps any future workspace — a blocked job is LIVE, not dead.
    pub async fn all_live_job_ids(&self) -> Result<Vec<Uuid>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT id as "id: Uuid" FROM jobs WHERE status IN ('blocked','queued','running')"#
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Boot reconcile of STRANDED `blocked` jobs (ITEM-19). A crash between a
    /// dependency reaching a terminal state and its unblock/cascade committing can
    /// leave a dependent `blocked` forever (the runtime unblock/cascade fires only
    /// from the dep's terminal transition, which never completed). This re-evaluates
    /// every `blocked` job against its dependencies, set-based + idempotent:
    ///
    /// 1. Cascade-fail (transitively): any `blocked` job on the dependency-graph
    ///    closure of a `failed`/`stopped` job → `failed`/`dependency_failed`.
    /// 2. Queue: any remaining `blocked` job whose EVERY dependency is `completed`
    ///    → `queued` (so the scheduler can claim it).
    ///
    /// A `blocked` job with at least one still-non-terminal dependency is left as-is
    /// (its normal runtime unblock/cascade will fire when that dep terminalizes).
    /// Returns `(cascaded, queued)` row counts for the boot log. Runs in one
    /// transaction; safe to call repeatedly (a re-run touches nothing new).
    pub async fn reconcile_blocked_jobs(&self) -> Result<(u64, u64), AppError> {
        // One transaction, `BEGIN IMMEDIATE` (the cascade + queue scans must be a
        // single serialized unit against live finishers).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        // (1) Transitive cascade-fail. The recursive CTE walks the dependent closure
        // of every `failed`/`stopped` job (mirrors `cascade_fail_dependents`), then
        // the UPDATE fails only the `blocked` members of that closure. Doing the full
        // closure in ONE statement heals a whole stranded chain in a single boot.
        let cascaded_ids: Vec<Uuid> = sqlx::query_scalar!(
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
               RETURNING id as "id: Uuid""#,
            DEPENDENCY_FAILED,
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let cascaded = cascaded_ids.len() as u64;
        // (2) Queue every `blocked` job whose deps are ALL `completed` (none left to
        // wait on). Runs AFTER the cascade so a job with a mix of completed + failed
        // deps is failed, not queued (its failed dep makes this NOT EXISTS false).
        let queued = sqlx::query!(
            r#"UPDATE jobs SET status = 'queued'
               WHERE status = 'blocked' AND NOT EXISTS (
                   SELECT 1 FROM job_dependencies jd JOIN jobs j ON j.id = jd.depends_on_job_id
                   WHERE jd.job_id = jobs.id AND j.status <> 'completed')"#,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .rows_affected();
        tx.commit().await.map_err(AppError::database_error)?;
        // A job failed by a BOOT pass has no other channel at all: nobody was watching, and
        // the process that would have explained it is the one that died. Post-commit, for
        // the same reason as every other terminal writer.
        self.note_cascaded_reasons(&cascaded_ids).await;
        Ok((cascaded, queued))
    }

    // ---- logs ----

    pub async fn append_log(
        &self,
        job_id: Uuid,
        seq: i32,
        stream: &str,
        content: &str,
    ) -> Result<JobLog, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            JobLog,
            r#"INSERT INTO job_logs (id, job_id, seq, stream, content)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id as "id: Uuid", job_id as "job_id: Uuid", seq as "seq: i32", stream, content,
                         created_at as "created_at: DateTime<Utc>""#,
            id,
            job_id,
            seq,
            stream,
            content
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The next free `seq` for a job's log, i.e. `max(seq) + 1` (1 for a job with none).
    ///
    /// The streaming path owns a monotone counter for the life of the child; a writer
    /// that appends AFTER the run finished (the conformance gate records its outcome on
    /// the run it gated) has no such counter and must not collide with, or sort before,
    /// what the run already wrote.
    pub async fn next_log_seq(&self, job_id: Uuid) -> Result<i32, AppError> {
        sqlx::query_scalar!(
            r#"SELECT COALESCE(MAX(seq), 0) + 1 as "next: i32" FROM job_logs WHERE job_id = $1"#,
            job_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn list_logs(&self, job_id: Uuid) -> Result<Vec<JobLog>, AppError> {
        // Defensive cap on the detail response + SSE replay. The stub is bounded
        // well under this; a real long-running (sandbox) job's full scrollback is
        // served by the paged endpoint (`list_logs_paged`, ITEM-12b).
        sqlx::query_as!(
            JobLog,
            r#"SELECT id as "id: Uuid", job_id as "job_id: Uuid", seq as "seq: i32", stream, content,
                      created_at as "created_at: DateTime<Utc>"
               FROM job_logs WHERE job_id = $1 ORDER BY seq ASC LIMIT 10000"#,
            job_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Long-job log paging (ITEM-12b): a bounded forward page of log lines whose
    /// `seq` is strictly greater than `after_seq` (the stable cursor — `seq` is a
    /// per-job monotonic key, index-backed by `(job_id, seq)`), ordered ASC, at
    /// most `limit` rows. `after_seq = 0` starts from the beginning. The catch-up /
    /// scrollback path for an hours-long Cell Ranger run whose logs overflow the
    /// 10k `list_logs` cap; the SSE stream stays the live/replay path.
    pub async fn list_logs_paged(
        &self,
        job_id: Uuid,
        after_seq: i32,
        limit: i64,
    ) -> Result<Vec<JobLog>, AppError> {
        sqlx::query_as!(
            JobLog,
            r#"SELECT id as "id: Uuid", job_id as "job_id: Uuid", seq as "seq: i32", stream, content,
                      created_at as "created_at: DateTime<Utc>"
               FROM job_logs WHERE job_id = $1 AND seq > $2
               ORDER BY seq ASC LIMIT $3"#,
            job_id,
            after_seq,
            limit
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Total captured log lines for a job (so the paged endpoint reports the full
    /// size — a client knows a page is a WINDOW, never a silent truncation).
    pub async fn count_logs(&self, job_id: Uuid) -> Result<i64, AppError> {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count!" FROM job_logs WHERE job_id = $1"#,
            job_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    // ---- milestones ----

    /// Persist an end-user-facing milestone transition (ITEM-24): a declared step
    /// `milestone_id` reaching `status` (`started|done|failed`) with an optional
    /// structured `detail` finding. Mirrors [`append_log`](Self::append_log); the
    /// runner fans each transition to the SSE `milestone` frame AND this durable
    /// timeline (so a reconnecting client replays the steps it missed).
    pub async fn append_milestone(
        &self,
        job_id: Uuid,
        milestone_id: &str,
        status: &str,
        detail: &serde_json::Value,
    ) -> Result<JobMilestone, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            JobMilestone,
            r#"INSERT INTO job_milestones (id, job_id, milestone_id, status, detail)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id as "id: Uuid", job_id as "job_id: Uuid", milestone_id, status,
                         detail as "detail: serde_json::Value",
                         created_at as "created_at: DateTime<Utc>""#,
            id,
            job_id,
            milestone_id,
            status,
            detail
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// A job's full milestone timeline, oldest first (detail-view / reload +
    /// reconnect replay). Bounded like `list_logs`.
    pub async fn list_milestones(&self, job_id: Uuid) -> Result<Vec<JobMilestone>, AppError> {
        sqlx::query_as!(
            JobMilestone,
            r#"SELECT id as "id: Uuid", job_id as "job_id: Uuid", milestone_id, status,
                      detail as "detail: serde_json::Value",
                      created_at as "created_at: DateTime<Utc>"
               FROM job_milestones WHERE job_id = $1 ORDER BY created_at ASC, id ASC LIMIT 10000"#,
            job_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    // ---- metrics ----

    /// Insert a metric sample. `mem_peak_bytes`/`pids_current` are `Some` only on
    /// the cgroup read-back path (ITEM-25); the single-pid sysinfo fallback
    /// passes `None`.
    pub async fn insert_metric(
        &self,
        job_id: Uuid,
        cpu_pct: f32,
        mem_bytes: i64,
        mem_peak_bytes: Option<i64>,
        pids_current: Option<i32>,
    ) -> Result<JobMetric, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            JobMetric,
            r#"INSERT INTO job_metrics (id, job_id, cpu_pct, mem_bytes, mem_peak_bytes, pids_current)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id as "id: Uuid", job_id as "job_id: Uuid", sampled_at as "sampled_at: DateTime<Utc>",
                         cpu_pct as "cpu_pct: f32", mem_bytes, mem_peak_bytes,
                         pids_current as "pids_current?: i32""#,
            id,
            job_id,
            cpu_pct,
            mem_bytes,
            mem_peak_bytes,
            pids_current
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn list_metrics(&self, job_id: Uuid) -> Result<Vec<JobMetric>, AppError> {
        sqlx::query_as!(
            JobMetric,
            r#"SELECT id as "id: Uuid", job_id as "job_id: Uuid", sampled_at as "sampled_at: DateTime<Utc>",
                      cpu_pct as "cpu_pct: f32", mem_bytes, mem_peak_bytes,
                      pids_current as "pids_current?: i32"
               FROM job_metrics WHERE job_id = $1 ORDER BY sampled_at ASC LIMIT 10000"#,
            job_id
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }
}

/// The pure fair-share ordering key for a queued job: (owner's running count ASC,
/// class priority DESC, created_at ASC). Mirrors the SQL `ORDER BY` in
/// `claim_next_fair` so it can be unit-tested without a DB. Lower tuple = claimed
/// first (priority is negated so higher priority sorts first).
pub fn fair_order_key(
    owner_running_count: i64,
    priority_weight: i32,
    created_at: DateTime<Utc>,
) -> (i64, i32, DateTime<Utc>) {
    (owner_running_count, -priority_weight, created_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::backend::PriorityClass;

    // TEST-13: the fair-share ordering key sorts so a single-job owner is not
    // starved behind a many-job owner, and reduces to FCFS within one owner+class.
    #[test]
    fn fair_order_key_prevents_owner_starvation_and_reduces_to_fcfs() {
        let t = |secs: i64| DateTime::<Utc>::from_timestamp(1_700_000_000 + secs, 0).unwrap();
        let w = |c: PriorityClass| c.weight();

        // Owner A has 3 running; owner B has 0. Both submit a normal job at the
        // same time. B (fewer running) must sort first (least-recently-served).
        let a = fair_order_key(3, w(PriorityClass::Normal), t(0));
        let b = fair_order_key(0, w(PriorityClass::Normal), t(0));
        assert!(b < a, "the less-loaded owner is claimed first");

        // Same owner-load: interactive outranks normal outranks batch.
        let inter = fair_order_key(1, w(PriorityClass::Interactive), t(0));
        let norm = fair_order_key(1, w(PriorityClass::Normal), t(0));
        let batch = fair_order_key(1, w(PriorityClass::Batch), t(0));
        assert!(
            inter < norm && norm < batch,
            "class priority breaks the owner-load tie"
        );

        // Same owner-load + same class: oldest first (FCFS).
        let older = fair_order_key(1, w(PriorityClass::Normal), t(0));
        let newer = fair_order_key(1, w(PriorityClass::Normal), t(10));
        assert!(older < newer, "reduces to FCFS within one owner+class");

        // Sorting a mixed set puts the least-loaded / highest-priority / oldest first.
        let mut set = vec![a, newer, inter, batch];
        set.sort();
        assert_eq!(
            set[0], inter,
            "interactive by the least-loaded-ish wins overall"
        );
    }

    // TEST-6 (INV-5, "reuse verbatim"): T4 folds the two caps into `claim_next_fair`
    // as pure AND-filters in the sub-select WHERE — it does NOT touch the fair-share
    // ordering. `fair_order_key` (the pure mirror of the SQL `ORDER BY`) takes NO
    // cap argument, so the caps CANNOT reorder the queue: the same job that ranked
    // first without a cap ranks first under any cap (it is either claimable or
    // skipped, never re-ranked). Together with sqlx's compile-time check that the
    // RETURNING columns still map to the full `Job` struct (a mismatch would not
    // compile), this pins the "reuse verbatim" invariant.
    #[test]
    fn caps_do_not_reorder_fair_share() {
        let t = |secs: i64| DateTime::<Utc>::from_timestamp(1_700_000_000 + secs, 0).unwrap();
        let w = |c: PriorityClass| c.weight();
        // The ordering key is a pure function of (owner-load, class, created_at) —
        // no cap term. So whatever the global/per-tenant caps are, the winner among
        // claimable rows is decided by exactly this key, unchanged from pre-T4.
        let least = fair_order_key(0, w(PriorityClass::Interactive), t(0));
        let most = fair_order_key(9, w(PriorityClass::Batch), t(100));
        assert!(least < most, "fair-share winner is cap-independent (INV-5)");
        // The tuple SHAPE is unchanged (owner_count, -priority, created_at): a caller
        // depending on `(i64, i32, DateTime)` still compiles + sorts identically.
        let (c, p, _at) = fair_order_key(3, w(PriorityClass::Normal), t(5));
        assert_eq!((c, p), (3, -w(PriorityClass::Normal)));
    }
}
