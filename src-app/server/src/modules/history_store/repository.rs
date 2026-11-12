//! The `history_store` read-side projection (ITEM-2 — PROV-HS-2 / PROV-HS-3):
//! the paged K list row and the expanded K block, shaped in ONE place so
//! screen K makes no N+1 per-run detail fetches (INV-3).
//!
//! ## What is read, and from where (the seam rule)
//!
//! - `txr_runs` / `txr_run_methods` / `txr_run_logs` — the engine's declared
//!   READ seam (PROV-EE-10, CONS-HS-6). The run row is the ENGINE's own
//!   [`RunRow`] (never a second 21-column row shape): its `status()`/`mode()`
//!   converters, `summarize()` (config/`input_summary`/`counts`/`model_ids`
//!   JSON → the wire types) and `estimate()` (the create-time estimate facts
//!   stored by the engine, `txr_runs.estimate`) are the provider's parse
//!   rules — a stored JSON that stops parsing fails HERE, not in a parallel
//!   model (INV-6). The per-method rows are the engine's [`MethodRow`]
//!   converted with the engine's own `into_method()` (the catalogue
//!   `group_label` shim included), and the produced-model facts come from the
//!   engine's own `produced_models` seam (PROV-EE-9) — the completeness rule
//!   (digest + dir + both env digests + `trained_on_patients` + `size_bytes`)
//!   is the provider's, never restated.
//! - `txr_model_sets` / `txr_models` — model-store's bindable seam
//!   (PROV-MS-11, CONS-HS-13, DEC-9, owner-approved D67): read-only, for the
//!   K "Made: N models (…)" block, the detail's saved-model record list and
//!   the set-name search term. Nothing here ever writes a model row (the
//!   store's own surface is model-store's; PROV-MS-8 is its resolve path).
//!   The reuse run's consumed models join the engine-grown
//!   `txr_runs.model_ids` (JSON array of the MODEL-STORE row ids,
//!   GAP-HS-3/CONS-HS-14) over `txr_models.id` through
//!   `unhex(replace(j.value, '-', ''))` — the hyphenated-UUID SQLite JSON1
//!   membership idiom (the `workstore` catalog's `unhex(replace(...))`
//!   convention).
//! - `txr_run_retention` — this module's own row, READ here (a run without a
//!   row reads as `copies_kept = true` — INV-2's conservative default); the
//!   WRITE half (the lazy upsert by the clear operations) is `retention.rs`
//!   (ITEM-3).
//!
//! ## The projection's decisions (recorded in DRIFT-1 ITEM-2)
//!
//! - `estimate_total_seconds` / `use_estimate` come from the run's STORED
//!   estimate (`txr_runs.estimate`, the engine's `RunRow::estimate()` — the
//!   SAME JSON the engine's own detail serves). The plan's CONS-HS-12 asked
//!   for the in-process estimator call; the engine stores at create
//!   (CONS-EE-9b) and never re-derives at read, so re-deriving here would let
//!   K and F disagree whenever the catalogue facts or CPU count changed since
//!   create, and would invent an estimate for a row whose estimate was never
//!   computed. The stored facts ARE the result of the engine's create-time
//!   call to the one estimator — "the two renderings can never disagree" is
//!   realized by reading the same stored value, `None` when absent (D36:
//!   render when the record carries it; never a fabricated zero).
//! - The SQL is macro-checked (`query_as!`/`query_scalar!` against the sqlite
//!   build DB — PROV-sqlite-store-5 / CONS-HS-16): the q/kind/status WHERE is
//!   ONE parameterized statement per shape with NULL-sentinel predicates
//!   (`$n IS NULL OR …` — the model-store `list_models` filter idiom), never
//!   string-composed (a bound term cannot be SQL; the PROV-sqlite-store-4
//!   `instr(lower(x), lower($1)) > 0` substring rule, ASCII folding — DEC-19).
//! - The per-run aggregates of a page are fetched in ONE batched statement
//!   each over the page's run ids (the engine's own `list_run_summaries`
//!   one-batch precedent; `id IN (SELECT unhex(j.value) FROM json_each($1)
//!   AS j)` — the shared `uuid_list_json` convention), so a 100-row page is
//!   a bounded constant number of statements, never N per run.
//!
//! ## Scope (the module's NON-scope, enforced)
//!
//! No writes: no `INSERT`/`UPDATE`/`DELETE` anywhere in this file (the
//! retention row's lazy upsert is ITEM-3's; the run/method/log rows are the
//! engine's). The `dir` values pass through verbatim and no filesystem path
//! is ever joined into a DELETE here.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;
use txresbench_core::AppError;

use crate::modules::execution_engine::repository::{produced_models, MethodRow, RunRow, TxrRepository};
use crate::modules::execution_engine::types::{TxrRunFileNames, TxrRunStatus};
use crate::modules::history_store::types::{
    HistoryLimits, TxrHistoryBucket, TxrHistoryCopies, TxrHistoryDetail, TxrHistoryEstimate,
    TxrHistoryFileSize, TxrHistoryItem, TxrHistoryMethodRef, TxrHistoryModelRef,
    TxrHistoryModelSaved, TxrHistoryModelsMade, TxrHistoryPage, TxrHistorySavedSet,
    TxrHistoryListQuery, TxrRunSettingsView,
};

// ─────────────────────────────────────────────────────────────────────────────
// The filter vocabulary mapping (DEC-4) + the pure projection rules
// ─────────────────────────────────────────────────────────────────────────────

/// A named history-view failure — the caller's bug shapes the routes' 400
/// (ITEM-4: `INVALID_STATUS`; the framework's 422 covers the `kind` enum
/// through serde). The plan's pinned error vocabulary (RUN_NOT_FOUND,
/// UNSAFE_RUN_DIR — PROV-HS-3/5) is untouched: parsing errors are REQUEST
/// errors, not entity errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryQueryError {
    /// The `status` filter is not the bucket vocabulary (an unknown bucket or
    /// an empty segment in the comma-separated multi-value).
    InvalidStatus { value: String },
}

impl HistoryQueryError {
    /// The stable machine code (the 400 surface's `error.error_code`).
    pub fn code(&self) -> &'static str {
        match self {
            HistoryQueryError::InvalidStatus { .. } => "INVALID_STATUS",
        }
    }
}

impl std::fmt::Display for HistoryQueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HistoryQueryError::InvalidStatus { value } => write!(
                f,
                "INVALID_STATUS: `{value}` is not the bucket vocabulary \
                 (running|finished|stopped|failed, comma-separated for one OR filter)"
            ),
        }
    }
}

impl std::error::Error for HistoryQueryError {}

impl From<HistoryQueryError> for AppError {
    fn from(e: HistoryQueryError) -> AppError {
        AppError::bad_request(e.code(), e.to_string())
    }
}

/// The DEC-4 map: the engine's run status vocabulary → the K list's four
/// buckets (TEST-HS-4). The engine's `creating|preparing|running|finishing`
/// all land in `running` (K's "Running" render, the F screen's live run); the
/// terminal states are verbatim.
pub fn bucket_for(status: TxrRunStatus) -> TxrHistoryBucket {
    match status {
        TxrRunStatus::Creating
        | TxrRunStatus::Preparing
        | TxrRunStatus::Running
        | TxrRunStatus::Finishing => TxrHistoryBucket::Running,
        TxrRunStatus::Finished => TxrHistoryBucket::Finished,
        TxrRunStatus::Stopped => TxrHistoryBucket::Stopped,
        TxrRunStatus::Failed => TxrHistoryBucket::Failed,
    }
}

/// The engine statuses a bucket filter matches (DEC-4, inverted for SQL): the
/// `status=` filter speaks the BUCKET vocabulary, the stored column speaks
/// the ENGINE vocabulary — the mapping is the one place the two meet.
pub fn engine_statuses_for_bucket(bucket: TxrHistoryBucket) -> &'static [&'static str] {
    match bucket {
        TxrHistoryBucket::Running => &["creating", "preparing", "running", "finishing"],
        TxrHistoryBucket::Finished => &["finished"],
        TxrHistoryBucket::Stopped => &["stopped"],
        TxrHistoryBucket::Failed => &["failed"],
    }
}

/// Parse the wire `status` filter (PROV-HS-2, GAP-HIST-3): ONE bucket or the
/// comma-separated multi-value (the K "Stopped or failed" filter is ONE call,
/// OR semantics — TEST-HS-20). Returns the ENGINE statuses the WHERE binds,
/// or `None` when the filter is absent/empty (no status constraint). An
/// unknown bucket or an empty segment is a [`HistoryQueryError`] — strict by
/// design: the K select only ever sends the vocabulary, and a typo must not
/// silently widen the filter (never-weaken discipline).
pub fn parse_status_filter(value: Option<&str>) -> Result<Option<Vec<String>>, HistoryQueryError> {
    let Some(value) = value else { return Ok(None) };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let mut out: Vec<String> = Vec::new();
    for segment in trimmed.split(',') {
        let segment = segment.trim();
        if segment.is_empty() {
            return Err(HistoryQueryError::InvalidStatus {
                value: value.to_string(),
            });
        }
        let bucket = match segment {
            "running" => TxrHistoryBucket::Running,
            "finished" => TxrHistoryBucket::Finished,
            "stopped" => TxrHistoryBucket::Stopped,
            "failed" => TxrHistoryBucket::Failed,
            _ => {
                return Err(HistoryQueryError::InvalidStatus {
                    value: segment.to_string(),
                })
            }
        };
        for status in engine_statuses_for_bucket(bucket) {
            if !out.iter().any(|s| s == status) {
                out.push(status.to_string());
            }
        }
    }
    Ok(Some(out))
}

/// The K row's first terminal reason (TEST-HS-4): among the run's terminal
/// methods (`failed` / `cannot_run` / `stopped` — the plan's three: a
/// skipped/waiting method carries no K reason), the winner is the EARLIEST
/// one in the `failed → cannot_run → stopped` priority order; within one
/// priority, the earliest `started_at`, then the earliest `finished_at`
/// (NULLs last — a `cannot_run` row is classified at run start and may never
/// have started), then `seq` (the method's insert order — fully
/// deterministic). The reason passes through VERBATIM (code + detail — the
/// engine's own vocabulary and human text, CONS-HS-15); a terminal row
/// without a `reason_code` is skipped (a corrupt row, never a fabricated
/// "failure").
pub fn first_terminal_reason(rows: &[TerminalReasonRow]) -> Option<crate::modules::execution_engine::types::TxrRunReason> {
    let mut ranked: Vec<&TerminalReasonRow> = rows
        .iter()
        .filter(|r| r.reason_code.is_some())
        .collect();
    ranked.sort_by(|a, b| {
        let pa = match a.state.as_str() {
            "failed" => 0u8,
            "cannot_run" => 1,
            _ => 2,
        };
        let pb = match b.state.as_str() {
            "failed" => 0u8,
            "cannot_run" => 1,
            _ => 2,
        };
        pa.cmp(&pb)
            .then_with(|| stamp_cmp(a.started_at, b.started_at))
            .then_with(|| stamp_cmp(a.finished_at, b.finished_at))
            .then_with(|| a.seq.cmp(&b.seq))
    });
    ranked.first().map(|r| crate::modules::execution_engine::types::TxrRunReason {
        code: r.reason_code.clone().expect("filtered"),
        detail: r.reason_detail.clone().unwrap_or_default(),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Batched page row shapes (each is ONE statement over the page's run ids)
// ─────────────────────────────────────────────────────────────────────────────

/// One compact method fact of a K list row (`TxrHistoryMethodRef`'s row half).
#[derive(Debug, Clone, FromRow)]
pub struct MethodRefRow {
    pub run_id: Uuid,
    pub method_id: String,
    pub version: String,
    pub elapsed_secs: Option<i64>,
}

/// One terminal method row of a run (only `failed` / `cannot_run` / `stopped`
/// — the `first_reason` candidates). `seq` is the rowid (the method's insert
/// order — the engine's run order).
#[derive(Debug, Clone, FromRow)]
pub struct TerminalReasonRow {
    pub run_id: Uuid,
    pub state: String,
    pub reason_code: Option<String>,
    pub reason_detail: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub seq: i64,
}

/// One run's produced-model count (the COMPLETE-record rule of the engine's
/// `produced_models` — PROV-EE-9; the batched COUNT uses the same predicate,
/// pinned against the engine's own seam in the tests).
#[derive(Debug, Clone, FromRow)]
pub struct ProducedCountRow {
    pub run_id: Uuid,
    pub count: i64,
}

/// One saved set of a run's "Made" block (the `source_run_id` join —
/// PROV-MS-11) with its model count.
#[derive(Debug, Clone, FromRow)]
pub struct SavedSetRow {
    pub run_id: Uuid,
    pub set_id: Uuid,
    pub set_name: String,
    pub model_count: i64,
}

/// One consumed model of a reuse run (the engine-grown `model_ids` joined
/// over `txr_model_sets` / `txr_models` — GAP-HS-3 / CONS-HS-14). A model
/// row WITHOUT a set is skipped: no set name exists to render, and the wire
/// type's `set_id`/`set_name` are non-nullable — never a fabricated name
/// (DEC-21).
#[derive(Debug, Clone, FromRow)]
pub struct UsedModelRow {
    pub run_id: Uuid,
    pub set_id: Uuid,
    pub set_name: String,
    pub model_id: Uuid,
    pub model_name: String,
}

/// One saved model record of the detail's `models_saved` (the same
/// `source_run_id` join at the MODEL row level with its byte size).
#[derive(Debug, Clone, FromRow)]
pub struct SavedModelRow {
    pub set_id: Uuid,
    pub set_name: String,
    pub model_id: Uuid,
    pub model_name: String,
    pub size_bytes: i64,
}

/// One retention row of the page's runs (a run without a row reads as
/// `copies_kept = true` — the lazy-row rule, PROV-HS-5).
#[derive(Debug, Clone, FromRow)]
pub struct RetentionRow {
    pub run_id: Uuid,
    pub copies_kept: bool,
    pub copies_cleared_at: Option<DateTime<Utc>>,
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume: a JSON array of 32-char lowercase hex strings (the
/// `uuid::Uuid::simple()` form), compared against a 16-byte BLOB column
/// through `unhex()` — the shared `txresbench-file`/jobs/engine convention, kept
/// local per the single-driver rule (the jobs + engine precedent).
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}

// ─────────────────────────────────────────────────────────────────────────────
// The repository
// ─────────────────────────────────────────────────────────────────────────────

/// The history view's repository: a pool-bound clone over the process pool
/// (CONS-HS-1/2 — the same `Arc<SqlitePool>` the module installed, as the
/// `axum::Extension<SqlitePool>` the routes receive; ITEM-4).
#[derive(Clone)]
pub struct HistoryRepository {
    pool: SqlitePool,
}

impl HistoryRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The pool (routes + the retention/usage code bind the same handle).
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    // ── the page (PROV-HS-2) ────────────────────────────────────────────────

    /// The paged K row list: newest-first (`created_at DESC`, `id DESC` —
    /// tie-stable), bounded (`limit` default + clamp per
    /// [`HistoryLimits`] — a caller asking for 200 gets the cap, INV-3),
    /// with the `q` / `kind` / `status` filters and the true `total` under
    /// the active filters. One filter statement + one count statement (the
    /// WHERE is duplicated by the macro-literal rule — the totals-are-the-
    /// same pin is the integration suite's TEST-HS-7/20) + five batched
    /// statements over the page's run ids.
    pub async fn page(&self, query: &TxrHistoryListQuery) -> Result<TxrHistoryPage, AppError> {
        let term = query.q.as_deref();
        let kind = query.kind.map(|k| k.selects_mode().as_str());
        let statuses = parse_status_filter(query.status.as_deref())?;
        // The parameterized JSON array of the ENGINE statuses the bucket
        // filter selects (the DEC-4 map vectorized; one bind, never string
        // interpolation).
        let statuses_json = match &statuses {
            Some(statuses) => serde_json::to_string(statuses)
                .map_err(|e| AppError::internal_error(format!("status set serializes: {e}")))?,
            None => String::new(),
        };
        let statuses_json = if statuses.is_some() {
            Some(statuses_json)
        } else {
            None
        };
        let limit = query
            .limit
            .unwrap_or(HistoryLimits::DEFAULT_LIMIT)
            .clamp(1, HistoryLimits::MAX_LIMIT);
        let offset = query.offset.unwrap_or(0);
        let limit_bind = limit as i64;
        let offset_bind = offset as i64;
        // The binds as LOCALS — a macro argument that borrows a temporary
        // (`Option::as_deref` on a temporary `Option<String>`) would outlive
        // the generated block's scope.
        let statuses_bind = statuses_json.as_deref();

        // Both statements share the one WHERE: the three OR-joined `q`
        // EXISTS subqueries (each guarded on the OUTER run id — closed-form
        // composition; TEST-HS-5), the `kind`→mode predicate and the
        // bucket→engine-status JSON membership. The `q` term is bound —
        // `$1 IS NULL OR` keeps the clause inert when absent — and every
        // compare is the PROV-sqlite-store-4 `instr(lower(x), lower($1)) > 0`
        // substring rule (ASCII folding, DEC-19).
        let rows = sqlx::query_as!(
            RunRow,
            r#"SELECT r.id as "id: Uuid", r.created_at as "created_at: DateTime<Utc>",
                      r.status, r.mode,
                      r.config as "config: serde_json::Value",
                      r.input_summary as "input_summary: serde_json::Value",
                      r.model_ids as "model_ids?: serde_json::Value",
                      r.method_count, r.counts as "counts: serde_json::Value",
                      r.elapsed_secs, r.dir, r.memory_total_bytes, r.cpus as "cpus?: i32",
                      r.error, r.started_at as "started_at?: DateTime<Utc>",
                      r.finished_at as "finished_at?: DateTime<Utc>",
                      r.predictions_ready as "predictions_ready: bool",
                      r.seed as "seed: i32",
                      r.estimate as "estimate?: serde_json::Value"
               FROM txr_runs r
               WHERE ($1 IS NULL OR EXISTS (
                        SELECT 1 FROM json_each(COALESCE(
                                   json_extract(r.input_summary, '$.file_names'), '{}')) AS f
                        WHERE instr(lower(COALESCE(f.value, '')), lower($1)) > 0)
                      OR EXISTS (SELECT 1 FROM txr_run_methods m
                        WHERE m.run_id = r.id
                          AND instr(lower(m.method_id), lower($1)) > 0)
                      OR EXISTS (SELECT 1 FROM txr_model_sets s
                        WHERE s.source_run_id = r.id
                          AND instr(lower(s.name), lower($1)) > 0))
                 AND ($2 IS NULL OR r.mode = $2)
                 AND ($3 IS NULL OR r.status IN (SELECT j.value FROM json_each($3) AS j))
               ORDER BY r.created_at DESC, r.id DESC
               LIMIT $4 OFFSET $5"#,
            term,
            kind,
            statuses_bind,
            limit_bind,
            offset_bind,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        // The true count under the same filter (INV-3: the page carries the
        // engine-truth total, never "the page is full").
        let total = sqlx::query_scalar!(
            r#"SELECT COUNT(*) FROM txr_runs r
               WHERE ($1 IS NULL OR EXISTS (
                        SELECT 1 FROM json_each(COALESCE(
                                   json_extract(r.input_summary, '$.file_names'), '{}')) AS f
                        WHERE instr(lower(COALESCE(f.value, '')), lower($1)) > 0)
                      OR EXISTS (SELECT 1 FROM txr_run_methods m
                        WHERE m.run_id = r.id
                          AND instr(lower(m.method_id), lower($1)) > 0)
                      OR EXISTS (SELECT 1 FROM txr_model_sets s
                        WHERE s.source_run_id = r.id
                          AND instr(lower(s.name), lower($1)) > 0))
                 AND ($2 IS NULL OR r.mode = $2)
                 AND ($3 IS NULL OR r.status IN (SELECT j.value FROM json_each($3) AS j))"#,
            term,
            kind,
            statuses_bind,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
        let context = self.page_context(&ids).await?;
        let items = rows
            .iter()
            .map(|row| self.assemble_item(row, &context))
            .collect::<Result<Vec<_>, AppError>>()?;
        Ok(TxrHistoryPage {
            items,
            total: total as u64,
            limit,
            offset,
        })
    }

    /// The five batched page reads (compact method refs, terminal reasons,
    /// produced counts, saved sets, consumed models, retention rows — six
    /// statements, a bounded count per 100-row page).
    async fn page_context(&self, ids: &[Uuid]) -> Result<PageContext, AppError> {
        if ids.is_empty() {
            return Ok(PageContext::default());
        }
        let ids_json = uuid_list_json(ids);

        let method_refs = sqlx::query_as!(
            MethodRefRow,
            r#"SELECT run_id as "run_id: Uuid", method_id, version, elapsed_secs
               FROM txr_run_methods
               WHERE run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
               ORDER BY run_id, rowid"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let terminal_reasons = sqlx::query_as!(
            TerminalReasonRow,
            r#"SELECT run_id as "run_id: Uuid", state, reason_code, reason_detail,
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      rowid as "seq!: i64"
               FROM txr_run_methods
               WHERE run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
                 AND state IN ('failed', 'cannot_run', 'stopped')
               ORDER BY run_id, rowid"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        // The COMPLETE-record rule is the engine's PROV-EE-9 predicate,
        // replicated verbatim as a batched COUNT (the page cannot call the
        // engine's per-run seam without N+1; the equivalence to
        // `produced_models` per run is pinned in the tests).
        let produced_counts = sqlx::query_as!(
            ProducedCountRow,
            r#"SELECT run_id as "run_id: Uuid", COUNT(*) as "count!: i64"
               FROM txr_run_methods
               WHERE run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
                 AND model_out_digest IS NOT NULL
                 AND model_dir IS NOT NULL
                 AND env_base_digest IS NOT NULL
                 AND env_layer_digest IS NOT NULL
                 AND trained_on_patients IS NOT NULL
                 AND size_bytes IS NOT NULL
               GROUP BY run_id"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let saved_sets = sqlx::query_as!(
            SavedSetRow,
            r#"SELECT s.source_run_id as "run_id!: Uuid", s.id as "set_id: Uuid",
                      s.name as "set_name", COUNT(m.id) as "model_count!: i64"
               FROM txr_model_sets s
               LEFT JOIN txr_models m ON m.set_id = s.id
               WHERE s.source_run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
               GROUP BY s.id
               ORDER BY s.created_at DESC, s.id DESC"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        // The reuse run's consumed models: the engine-grown `model_ids` JSON
        // array (hyphenated model-store ids) → `txr_models.id` through
        // `unhex(replace(j.value, '-', ''))`; inner-joined to the set so only
        // named models render (a set-less row carries no name — skipped, not
        // fabricated).
        let used_models = sqlx::query_as!(
            UsedModelRow,
            r#"SELECT r.id as "run_id: Uuid", s.id as "set_id: Uuid",
                      s.name as "set_name", m.id as "model_id: Uuid",
                      m.name as "model_name"
               FROM txr_runs r
               JOIN json_each(r.model_ids) AS j
               JOIN txr_models m ON m.id = unhex(replace(j.value, '-', ''))
               JOIN txr_model_sets s ON s.id = m.set_id
               WHERE r.id IN (SELECT unhex(jv.value) FROM json_each($1) AS jv)
               ORDER BY r.created_at DESC, r.id DESC"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let retention = sqlx::query_as!(
            RetentionRow,
            r#"SELECT run_id as "run_id: Uuid",
                      copies_kept as "copies_kept: bool",
                      copies_cleared_at as "copies_cleared_at?: DateTime<Utc>"
               FROM txr_run_retention
               WHERE run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok(PageContext::from_rows(
            method_refs,
            terminal_reasons,
            produced_counts,
            saved_sets,
            used_models,
            retention,
        ))
    }

    /// One shaped K row from the run row + the page context (the assembly —
    /// every wire fact is a projection of a stored fact; the capability
    /// booleans are computed by the DEC-6 rule only).
    fn assemble_item(
        &self,
        row: &RunRow,
        context: &PageContext,
    ) -> Result<TxrHistoryItem, AppError> {
        let status = row.status()?;
        let mode = row.mode()?;
        let bucket = bucket_for(status);
        let summary = row.summarize(Vec::new())?;
        let estimate = row.estimate()?;
        let file_names = file_name_list(&summary.input_summary.file_names);
        let copies_kept = context.copies_kept(row.id);
        let produced = context.produced(row.id);
        let reason = first_terminal_reason(context.terminal_reasons(row.id));
        Ok(TxrHistoryItem {
            id: row.id,
            mode,
            bucket,
            created_at: row.created_at,
            started_at: row.started_at,
            finished_at: row.finished_at,
            elapsed_secs: row.elapsed_secs.map(|v| v as u64),
            estimate_total_seconds: estimate
                .as_ref()
                .map(|e| e.total_seconds),
            method_count: row.method_count as u32,
            file_names: file_names.clone(),
            learned_from: summary.input_summary.patients,
            predicted: summary.input_summary.predict_patients,
            markers: summary.input_summary.markers,
            endpoint: summary.config.endpoint,
            decision_day: summary.config.decision_day,
            look_ahead_day: summary.config.look_ahead_day,
            methods: context
                .method_refs(row.id)
                .into_iter()
                .map(|m| TxrHistoryMethodRef {
                    id: m.method_id.clone(),
                    version: m.version.clone(),
                    elapsed_secs: m.elapsed_secs.map(|v| v as u64),
                })
                .collect(),
            reason,
            models_made: TxrHistoryModelsMade {
                produced,
                saved_sets: context
                    .saved_sets(row.id)
                    .into_iter()
                    .map(|s| TxrHistorySavedSet {
                        set_id: s.set_id,
                        set_name: s.set_name.clone(),
                        model_count: s.model_count as u32,
                    })
                    .collect(),
            },
            models_used: context.used_models(row.id),
            copies_kept,
            can_rerun: copies_kept && bucket != TxrHistoryBucket::Running,
            can_reopen: row.predictions_ready,
            can_download: row.predictions_ready,
            dir: row.dir.clone(),
            markers_saved: produced > 0,
        })
    }

    // ── the detail (PROV-HS-3) ───────────────────────────────────────────────

    /// The expanded K block. `None` = no such run (the route's 404
    /// `RUN_NOT_FOUND` — DEC-20: one entity, one code, the engine's own
    /// vocabulary). The engine's repository supplies the run row, the method
    /// rows (`into_method()` — the engine's own row build, catalogue
    /// `group_label` shim included), the produced-model seam and the log
    /// count; this repository adds the model-store joins, the retention row
    /// and the run-dir file facts.
    pub async fn get_detail(&self, id: Uuid) -> Result<Option<TxrHistoryDetail>, AppError> {
        let engine = TxrRepository::new(self.pool.clone());
        let Some(row) = engine.get_run(id).await? else {
            return Ok(None);
        };
        let status = row.status()?;
        let mode = row.mode()?;
        let bucket = bucket_for(status);
        let summary = row.summarize(Vec::new())?;
        let estimate = row.estimate()?;
        let method_rows = engine.methods_for_run(id).await?;
        let methods = method_rows
            .iter()
            .map(|m| m.clone().into_method())
            .collect::<Result<Vec<_>, AppError>>()?;
        let produced = produced_models(self.pool(), id).await?;
        let saved_models = self.saved_models_for_run(id).await?;
        let used_models = self.used_models_for_run(id).await?;
        let log_line_count = engine.log_total(id).await?;
        let retention = self.retention_for_run(id).await?;
        let copies_kept = retention.as_ref().map(|r| r.copies_kept).unwrap_or(true);
        let file_names = file_name_list(&summary.input_summary.file_names);
        // The detail's two fs reads (the recorded input-copy sizes + the run
        // dir's recursive size) are the blocking half of the view build —
        // they run on the blocking pool, never on a tokio worker (the plan's
        // ITEM-4 `spawn_blocking` line: the view build itself is async — the
        // DB reads happen through sqlx — so the blocking work is isolated at
        // the walks, exactly as `retention::usage` isolates its data-root
        // walk). A join failure (the runtime shutting down) is an internal
        // error, never a silent empty figure.
        let repo_walk = self.clone();
        let dir_walk = row.dir.clone();
        let names_walk = summary.input_summary.file_names.clone();
        let (file_sizes, dir_bytes) = tokio::task::spawn_blocking(move || {
            let sizes = repo_walk.copy_file_sizes(&dir_walk, &names_walk, copies_kept);
            let bytes = dir_size(Path::new(&dir_walk));
            (sizes, bytes)
        })
        .await
        .map_err(|e| AppError::internal_error(format!("run-dir walk join: {e}")))?;

        Ok(Some(TxrHistoryDetail {
            id: row.id,
            mode,
            bucket,
            created_at: row.created_at,
            started_at: row.started_at,
            finished_at: row.finished_at,
            elapsed_secs: row.elapsed_secs.map(|v| v as u64),
            estimate_total_seconds: estimate.as_ref().map(|e| e.total_seconds),
            method_count: row.method_count as u32,
            file_names: file_names.clone(),
            learned_from: summary.input_summary.patients,
            predicted: summary.input_summary.predict_patients,
            markers: summary.input_summary.markers,
            endpoint: summary.config.endpoint,
            decision_day: summary.config.decision_day,
            look_ahead_day: summary.config.look_ahead_day,
            methods,
            reason: first_terminal_reason(&terminal_reason_rows(&method_rows, id)),
            models_made: TxrHistoryModelsMade {
                produced: produced.len() as u32,
                saved_sets: self.saved_set_views_for_run(id).await?,
            },
            models_used: used_models,
            copies_kept,
            can_rerun: copies_kept && bucket != TxrHistoryBucket::Running,
            can_reopen: row.predictions_ready,
            can_download: row.predictions_ready,
            dir: row.dir.clone(),
            markers_saved: !produced.is_empty(),
            file_sizes,
            settings: TxrRunSettingsView {
                endpoint: summary.config.endpoint,
                decision_day: summary.config.decision_day,
                look_ahead_day: summary.config.look_ahead_day,
                covariates: summary.config.covariates,
                seed: Some(row.seed as i64),
                cpus: row.cpus.map(|c| c as u32),
                memory_total_bytes: row.memory_total_bytes.map(|v| v as u64),
                at_a_time: summary.config.at_a_time,
                save_models: summary.config.save_models,
                mode,
            },
            models_saved: saved_models,
            log_line_count,
            copies: TxrHistoryCopies {
                kept: copies_kept,
                cleared_at: retention.as_ref().and_then(|r| r.copies_cleared_at),
            },
            dir_bytes,
            use_estimate: estimate.map(|e| TxrHistoryEstimate {
                total_seconds: e.total_seconds,
                estimate_quality: e.estimate_quality,
            }),
        }))
    }

    /// The detail's saved-model records (the `source_run_id` join at the MODEL
    /// row level — names + byte sizes; PROV-MS-11).
    async fn saved_models_for_run(&self, run_id: Uuid) -> Result<Vec<TxrHistoryModelSaved>, AppError> {
        let rows = sqlx::query_as!(
            SavedModelRow,
            r#"SELECT s.id as "set_id: Uuid", s.name as "set_name",
                      m.id as "model_id: Uuid", m.name as "model_name", m.size_bytes
               FROM txr_models m
               JOIN txr_model_sets s ON s.id = m.set_id
               WHERE s.source_run_id = $1
               ORDER BY s.created_at DESC, s.id DESC, m.created_at DESC, m.id DESC"#,
            run_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            .map(|r| TxrHistoryModelSaved {
                set_id: r.set_id,
                set_name: r.set_name,
                model_id: r.model_id,
                model_name: r.model_name,
                size_bytes: r.size_bytes as u64,
            })
            .collect())
    }

    /// The detail's "Made" set views (same join, set-level, with model
    /// counts — the expanded block renders the same block as the row).
    async fn saved_set_views_for_run(&self, run_id: Uuid) -> Result<Vec<TxrHistorySavedSet>, AppError> {
        let rows = sqlx::query_as!(
            SavedSetRow,
            r#"SELECT s.source_run_id as "run_id!: Uuid", s.id as "set_id: Uuid",
                      s.name as "set_name", COUNT(m.id) as "model_count!: i64"
               FROM txr_model_sets s
               LEFT JOIN txr_models m ON m.set_id = s.id
               WHERE s.source_run_id = $1
               GROUP BY s.id
               ORDER BY s.created_at DESC, s.id DESC"#,
            run_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            .map(|r| TxrHistorySavedSet {
                set_id: r.set_id,
                set_name: r.set_name,
                model_count: r.model_count as u32,
            })
            .collect())
    }

    /// The detail's consumed-model records (same join as the page's batched
    /// one, for one run; `[]` in train mode — the page's GAP-HIST-2 answer).
    async fn used_models_for_run(&self, run_id: Uuid) -> Result<Vec<TxrHistoryModelRef>, AppError> {
        let ids_json = uuid_list_json(&[run_id]);
        let rows = sqlx::query_as!(
            UsedModelRow,
            r#"SELECT r.id as "run_id: Uuid", s.id as "set_id: Uuid",
                      s.name as "set_name", m.id as "model_id: Uuid",
                      m.name as "model_name"
               FROM txr_runs r
               JOIN json_each(r.model_ids) AS j
               JOIN txr_models m ON m.id = unhex(replace(j.value, '-', ''))
               JOIN txr_model_sets s ON s.id = m.set_id
               WHERE r.id IN (SELECT unhex(jv.value) FROM json_each($1) AS jv)
               ORDER BY r.created_at DESC, r.id DESC"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            .map(|r| TxrHistoryModelRef {
                set_id: r.set_id,
                set_name: r.set_name,
                model_id: r.model_id,
                model_name: r.model_name,
            })
            .collect())
    }

    /// The retention row of one run (`None` = the lazy-row default
    /// `copies_kept true` — INV-2).
    async fn retention_for_run(&self, run_id: Uuid) -> Result<Option<RetentionRow>, AppError> {
        let ids_json = uuid_list_json(&[run_id]);
        let rows = sqlx::query_as!(
            RetentionRow,
            r#"SELECT run_id as "run_id: Uuid",
                      copies_kept as "copies_kept: bool",
                      copies_cleared_at as "copies_cleared_at?: DateTime<Utc>"
               FROM txr_run_retention
               WHERE run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().next())
    }

    /// The recorded input copies' sizes ({name, size_bytes} keyed by the
    /// RECORDED names — the user-visible "Your files" block of the K
    /// expanded block). The fs layout under `<run_dir>/input/` is the
    /// engine's (`PROV-EE-7`'s run-dir convention, CONS-HS-7): the patients
    /// copy at `<sanitized stem>.csv`, `measurements.csv`,
    /// `predict-measurements.csv` (the engine's `write_input_snapshot`
    /// names), beside the engine-owned canonical `values.csv`/`features.csv`
    /// and `run-input.json` — those are never listed here. Empty when the
    /// copies were cleared or never kept or the dir is gone (never a
    /// fabricated 0 — a missing file also skips its entry: the run may still
    /// be preparing).
    fn copy_file_sizes(
        &self,
        dir: &str,
        file_names: &TxrRunFileNames,
        copies_kept: bool,
    ) -> Vec<TxrHistoryFileSize> {
        if !copies_kept {
            return Vec::new();
        }
        let input = Path::new(dir).join("input");
        let mut out = Vec::new();
        if let Some(name) = &file_names.patients {
            let fs_name = format!("{}.csv", copy_stem(name, "patients"));
            push_size(&mut out, name.clone(), &input.join(fs_name));
        }
        push_size(
            &mut out,
            file_names.measurements.clone(),
            &input.join("measurements.csv"),
        );
        if let Some(name) = &file_names.predict_measurements {
            push_size(
                &mut out,
                name.clone(),
                &input.join("predict-measurements.csv"),
            );
        }
        out
    }
}

fn push_size(out: &mut Vec<TxrHistoryFileSize>, name: String, path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        out.push(TxrHistoryFileSize {
            name,
            size_bytes: meta.len(),
        });
    }
}

/// The sanitized stem of an uploaded name + `.csv` — the input-copy file NAME
/// (the engine's `file_stem` rule mirrored: keep ASCII alphanumerics,
/// `-`,`_`,`.`, replace everything else with `_`, `patients` fallback for an
/// empty stem). The fs layout of the run's `input/` is the declared
/// run-dir convention (CONS-HS-7); the mirror is a bounded, documented
/// surface (DRIFT-1 ITEM-2).
fn copy_stem(name: &str, fallback: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// The recorded file names in the run's own order (patients, measurements,
/// predict — the plan's `file_names` order; never a dir-stem derivation).
fn file_name_list(file_names: &TxrRunFileNames) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(p) = &file_names.patients {
        out.push(p.clone());
    }
    out.push(file_names.measurements.clone());
    if let Some(p) = &file_names.predict_measurements {
        out.push(p.clone());
    }
    out
}

/// The recursive byte size of a directory when it exists (the detail's
/// `dir_bytes` — "size of `<run_dir>` when it exists", and the per-segment
/// walker of the usage figure: `retention::walk_data_root` shares THIS
/// implementation — one walker, never duplicated). Best-effort: entries
/// that do not read are skipped (their bytes are not counted — an honest
/// figure, never a zero substituted for an error); symlinks are not followed
/// (`DirEntry::metadata` is the lstat — the run tree's own bytes only). No
/// new crate (DEC-15): plain `read_dir` recursion.
pub(crate) fn dir_size(path: &Path) -> Option<u64> {
    fn walk(dir: &Path, acc: &mut u64) -> Option<()> {
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            match entry.metadata() {
                Ok(meta) if meta.is_dir() => walk(&entry.path(), acc)?,
                Ok(meta) if meta.is_file() => *acc += meta.len(),
                _ => {}
            }
        }
        Some(())
    }
    let mut acc = 0u64;
    walk(path, &mut acc)?;
    Some(acc)
}

// ─────────────────────────────────────────────────────────────────────────────
// The page context (per-run projections grouped from the batched rows)
// ─────────────────────────────────────────────────────────────────────────────

/// The page's per-run projections, keyed by run id (the assembly only reads
/// from this — the batch queries stay behind the repository's own methods).
#[derive(Default)]
struct PageContext {
    method_refs: HashMap<Uuid, Vec<MethodRefRow>>,
    terminal_reasons: HashMap<Uuid, Vec<TerminalReasonRow>>,
    produced: HashMap<Uuid, u32>,
    saved_sets: HashMap<Uuid, Vec<SavedSetRow>>,
    used_models: HashMap<Uuid, Vec<TxrHistoryModelRef>>,
    retention: HashMap<Uuid, RetentionRow>,
}

impl PageContext {
    fn from_rows(
        method_refs: Vec<MethodRefRow>,
        terminal_reasons: Vec<TerminalReasonRow>,
        produced_counts: Vec<ProducedCountRow>,
        saved_sets: Vec<SavedSetRow>,
        used_models: Vec<UsedModelRow>,
        retention: Vec<RetentionRow>,
    ) -> Self {
        let mut ctx = PageContext::default();
        for r in method_refs {
            ctx.method_refs.entry(r.run_id).or_default().push(r);
        }
        for r in terminal_reasons {
            ctx.terminal_reasons.entry(r.run_id).or_default().push(r);
        }
        for r in produced_counts {
            ctx.produced.insert(r.run_id, r.count as u32);
        }
        for r in saved_sets {
            ctx.saved_sets.entry(r.run_id).or_default().push(r);
        }
        for r in used_models {
            ctx.used_models
                .entry(r.run_id)
                .or_default()
                .push(TxrHistoryModelRef {
                    set_id: r.set_id,
                    set_name: r.set_name,
                    model_id: r.model_id,
                    model_name: r.model_name,
                });
        }
        for r in retention {
            ctx.retention.insert(r.run_id, r);
        }
        ctx
    }

    fn method_refs(&self, run_id: Uuid) -> &[MethodRefRow] {
        self.method_refs.get(&run_id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    fn terminal_reasons(&self, run_id: Uuid) -> &[TerminalReasonRow] {
        self.terminal_reasons.get(&run_id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    fn produced(&self, run_id: Uuid) -> u32 {
        self.produced.get(&run_id).copied().unwrap_or(0)
    }

    fn saved_sets(&self, run_id: Uuid) -> &[SavedSetRow] {
        self.saved_sets.get(&run_id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    fn used_models(&self, run_id: Uuid) -> Vec<TxrHistoryModelRef> {
        self.used_models.get(&run_id).cloned().unwrap_or_default()
    }

    fn copies_kept(&self, run_id: Uuid) -> bool {
        self.retention.get(&run_id).map(|r| r.copies_kept).unwrap_or(true)
    }
}

/// The "earliest stamp" ordering: a `Some` sorts BEFORE `None` (an
/// unstamped terminal row is the `cannot_run`-at-start case — no run time it
/// could beat; it sorts last within its priority). `Option`'s own Ord puts
/// `None` first, so the rule is spelled out once here.
fn stamp_cmp(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

/// The detail's `first_reason` inputs from the engine's own method rows (the
/// engine's `MethodRow` → the batched row shape; the ordering rule is the
/// one [`first_terminal_reason`] implements).
fn terminal_reason_rows(rows: &[MethodRow], run_id: Uuid) -> Vec<TerminalReasonRow> {
    rows.iter()
        .filter(|m| matches!(m.state.as_str(), "failed" | "cannot_run" | "stopped"))
        .enumerate()
        .map(|(i, m)| TerminalReasonRow {
            run_id,
            state: m.state.clone(),
            reason_code: m.reason_code.clone(),
            reason_detail: m.reason_detail.clone(),
            started_at: m.started_at,
            finished_at: m.finished_at,
            seq: i as i64,
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-HS-4 (the DEC-4 bucket map + `first_reason` ordering),
// TEST-HS-5 (the q/kind/status WHERE: bound term, INSTR idiom, closed-form
// OR-joins) and the ITEM-2 assembly pins (the page's shaped row + the
// detail's shaped block over the engine's own insert/repository seams).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::repository::{NewMethod, NewRun, TxrRepository};
    use crate::modules::execution_engine::repository::MethodPatch;
    use crate::modules::execution_engine::types::{
        RunConfig, TxrMethodState, TxrRunCounts, TxrRunEstimate, TxrRunInputSummary,
        TxrRunReason, TxrTask,
    };
    use crate::modules::method_catalogue::types::TimingQuality;
    use crate::modules::model_store::repository::{
        ModelStoreRepository, NewModel,
    };
    use crate::modules::model_store::types::ModelProvenance;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;

    /// A fresh temp-FILE pool with the FULL merged chain applied (the build
    /// composer's one chain — the runtime's `MERGED_MIGRATOR` shape; the
    /// module's two tables + the engine's three + model-store's two), `WAL`
    /// off, `foreign_keys` ON like the app pool (PROV-sqlite-store-1) so the
    /// FK seams are exercised. The file lives under `TMPDIR` (never /tmp).
    async fn merged_pool(label: &str) -> SqlitePool {
        let path = std::env::temp_dir().join(format!("history-store-item2-{label}-{}.sqlite", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite file connects");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR
            .run(&pool)
            .await
            .expect("the merged chain applies");
        pool
    }

    /// The plan's EXAMPLE-HS-1 input summary (synthetic facts, none from any
    /// real dataset — INV-4).
    fn input_summary(
        patients: Option<u32>,
        predict: Option<u32>,
        markers: u32,
        file_names: crate::modules::execution_engine::types::TxrRunFileNames,
    ) -> TxrRunInputSummary {
        TxrRunInputSummary {
            patients,
            predict_patients: predict,
            markers,
            events: Some(62),
            file_names,
        }
    }

    fn counts() -> TxrRunCounts {
        TxrRunCounts {
            finished: 0,
            failed: 0,
            stopped: 0,
            skipped: 0,
            cannot_run: 0,
            running: 0,
            downloading: 0,
            waiting: 0,
        }
    }

    /// One seeded run through the ENGINE's own insert (the view is a
    /// projection over the declared seam — the fixture is the provider's).
    async fn seed_run(
        engine: &TxrRepository,
        id: Uuid,
        created_at: chrono::DateTime<Utc>,
        status: TxrRunStatus,
        mode: crate::modules::execution_engine::types::TxrRunMode,
        summary: TxrRunInputSummary,
        model_ids: Vec<String>,
        method_count: u32,
        dir: String,
        estimate: Option<TxrRunEstimate>,
    ) -> RunRow {
        let new = NewRun {
            id,
            created_at: Some(created_at),
            status,
            mode,
            config: RunConfig {
                endpoint: crate::modules::execution_engine::types::TxrEndpoint::Pfs,
                decision_day: 56.0,
                look_ahead_day: 238.0,
                covariates: true,
                at_a_time: 3,
                cpus: Some(4),
                save_models: true,
                label_day: None,
            },
            input_summary: summary,
            model_ids,
            method_count,
            counts: counts(),
            dir,
            memory_total_bytes: Some(16 * 1024 * 1024 * 1024),
            cpus: Some(4),
            seed: 1,
            estimate,
        };
        engine.insert_run(&new).await.expect("insert run")
    }

    /// One seeded method row (the engine's own insert) then the engine's own
    /// patch for a terminal-with-reason row.
    async fn seed_method(
        engine: &TxrRepository,
        run_id: Uuid,
        method_id: &str,
        state: TxrMethodState,
        elapsed_secs: Option<u64>,
    ) {
        engine
            .insert_method(
                &NewMethod {
                    id: Uuid::new_v4(),
                    run_id,
                    method_id: method_id.to_string(),
                    label: method_id.to_string(),
                    version: "1.0".to_string(),
                    group: "dynamic-risk".to_string(),
                    state,
                    bytes_total: None,
                },
            )
            .await
            .expect("insert method");
        if let Some(secs) = elapsed_secs {
            let secs_bind = secs as i64;
            sqlx::query!(
                "UPDATE txr_run_methods SET elapsed_secs = $3 WHERE run_id = $1 AND method_id = $2",
                run_id,
                method_id,
                secs_bind,
            )
            .execute(engine.pool())
            .await
            .expect("set elapsed seconds");
        }
    }

    /// The seeded world of the filter/assembly tests (synthetic, INV-4):
    /// - A: train, finished, 2 methods, estimate stored, produced models,
    ///      the set "CRC cohort, day 56" saved against it;
    /// - B: reuse, finished, consumed the model of set A (model_ids), the
    ///      predict file "march_new.csv";
    /// - C: train, stopped, one cannot_run method with the plan's
    ///      REQUIRED_MARKER_MISSING reason;
    /// - D: train, preparing (bucket running);
    /// - E: train, failed.
    /// Returns (pool, engine, ids, dirs, model id).
    struct Seed {
        pool: SqlitePool,
        run_a: Uuid,
        run_b: Uuid,
        run_c: Uuid,
        run_d: Uuid,
        run_e: Uuid,
        dir_a: std::path::PathBuf,
        model_a: Uuid,
    }

    async fn seed_world(label: &str) -> Seed {
        let pool = merged_pool(label).await;
        let engine = TxrRepository::new(pool.clone());
        let root = std::env::temp_dir().join(format!("history-store-item2-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("root dir");

        let run_a = Uuid::new_v4();
        let run_b = Uuid::new_v4();
        let run_c = Uuid::new_v4();
        let run_d = Uuid::new_v4();
        let run_e = Uuid::new_v4();
        let dir_a = root.join("analysis-2026-10-26-1002-aaaaaaaa");
        let dir_b = root.join("analysis-2026-10-26-0930-bbbbbbbb");
        let dir_c = root.join("analysis-2026-10-26-0900-cccccccc");
        let dir_d = root.join("analysis-2026-10-26-0800-dddddddd");
        let dir_e = root.join("analysis-2026-10-26-0700-eeeeeeee");

        let now = chrono::DateTime::<chrono::Utc>::from_timestamp(1_800_000_000, 0).expect("stamp");
        let t = |secs: i64| {
            chrono::DateTime::<chrono::Utc>::from_timestamp(1_800_000_000 + secs, 0).expect("stamp")
        };

        seed_run(
            &engine,
            run_a,
            t(5),
            TxrRunStatus::Finished,
            crate::modules::execution_engine::types::TxrRunMode::Train,
            input_summary(
                Some(151),
                Some(38),
                5,
                crate::modules::execution_engine::types::TxrRunFileNames {
                    patients: Some("patients.csv".to_string()),
                    measurements: "measurements.csv".to_string(),
                    predict_measurements: Some("new_measurements.csv".to_string()),
                },
            ),
            Vec::new(),
            2,
            dir_a.display().to_string(),
            Some(TxrRunEstimate {
                total_seconds: 240.0,
                schedule_seconds: 300.0,
                estimate_quality: TimingQuality::Estimate,
            }),
        )
        .await;
        seed_method(&engine, run_a, "landmark-cox-current", TxrMethodState::Finished, Some(120)).await;
        seed_method(&engine, run_a, "cox-cutpoint-risk", TxrMethodState::Finished, Some(70)).await;
        // The produced-model record (COMPLETENESS = the engine's PROV-EE-9
        // rule: digest + dir + env digests + trained_on_patients + size).
        let model_dir_bind = dir_a
            .join("bundles/landmark-cox-current/model")
            .display()
            .to_string();
        sqlx::query!(
            r#"UPDATE txr_run_methods
               SET model_out_digest = 'aa', model_dir = $2, env_base_digest = 'bb',
                   env_layer_digest = 'cc', trained_on_patients = 151, size_bytes = 4096
               WHERE run_id = $1 AND method_id = 'landmark-cox-current'"#,
            run_a,
            model_dir_bind,
        )
        .execute(&pool)
        .await
        .expect("produced model record");
        // The run's predictions are ready.
        sqlx::query!("UPDATE txr_runs SET predictions_ready = 1 WHERE id = $1", run_a)
            .execute(&pool)
            .await
            .expect("predictions ready");

        let store = ModelStoreRepository::new(pool.clone());
        let set_a = store
            .insert_set("CRC cohort, day 56", Some(run_a), Some("patients.csv"), false, None)
            .await
            .expect("insert set")
            .id;
        let model_a = store
            .insert_model(&NewModel {
                set_id: Some(set_a),
                name: "cox-cutpoint-risk".to_string(),
                method_id: "cox-cutpoint-risk".to_string(),
                method_version: "1.0".to_string(),
                group: "dynamic-risk".to_string(),
                group_label: "Dynamic risk".to_string(),
                task: Some(TxrTask::Pfs.as_str().to_string()),
                provenance: ModelProvenance::Run.as_str().to_string(),
                imported_from: None,
                pretrained_catalogue_id: None,
                pretrained_catalogue_version: None,
                licence: None,
                tree_sha256: "aa".repeat(32),
                dir: dir_a.join("bundles/cox-cutpoint-risk/model").display().to_string(),
                size_bytes: 4096,
                contract: "2.0".to_string(),
                env_base_digest: Some("bb".to_string()),
                env_layer_digest: Some("cc".to_string()),
                trained_on_patients: Some(151),
                trained_at: Some(now),
                decision_day: 56.0,
                endpoint: "pfs".to_string(),
                horizon: 238.0,
                features: serde_json::json!([]),
                required_markers: Some(serde_json::json!([])),
                marker_facts: serde_json::json!([]),
                covariates: serde_json::json!([]),
                embeds_training_data: false,
                own_auc: Some(0.7),
                own_c: None,
            })
            .await
            .expect("insert model")
            .id;

        seed_run(
            &engine,
            run_b,
            t(4),
            TxrRunStatus::Finished,
            crate::modules::execution_engine::types::TxrRunMode::Reuse,
            input_summary(
                None,
                Some(22),
                5,
                crate::modules::execution_engine::types::TxrRunFileNames {
                    patients: None,
                    measurements: "march_new.csv".to_string(),
                    predict_measurements: None,
                },
            ),
            vec![model_a.to_string()],
            1,
            dir_b.display().to_string(),
            None,
        )
        .await;
        seed_method(&engine, run_b, "cox-cutpoint-risk", TxrMethodState::Finished, Some(60)).await;

        seed_run(
            &engine,
            run_c,
            t(3),
            TxrRunStatus::Stopped,
            crate::modules::execution_engine::types::TxrRunMode::Train,
            input_summary(
                Some(40),
                None,
                4,
                crate::modules::execution_engine::types::TxrRunFileNames {
                    patients: Some("patients.csv".to_string()),
                    measurements: "measurements.csv".to_string(),
                    predict_measurements: None,
                },
            ),
            Vec::new(),
            1,
            dir_c.display().to_string(),
            None,
        )
        .await;
        seed_method(&engine, run_c, "relchange-threshold", TxrMethodState::CannotRun, None).await;
        // The plan's verbatim reason (EXAMPLE-HS-1: code + detail pass
        // through, never re-authored).
        engine
            .patch_method(
                run_c,
                "relchange-threshold",
                &MethodPatch {
                    state: Some(TxrMethodState::CannotRun),
                    reason: Some(TxrRunReason {
                        code: "REQUIRED_MARKER_MISSING".to_string(),
                        detail: "marker LDH is missing from the measurements".to_string(),
                    }),
                    finished_at: Some(t(0)),
                    ..Default::default()
                },
            )
            .await
            .expect("patch reason");

        seed_run(
            &engine,
            run_d,
            t(2),
            TxrRunStatus::Preparing,
            crate::modules::execution_engine::types::TxrRunMode::Train,
            input_summary(
                Some(20),
                None,
                3,
                crate::modules::execution_engine::types::TxrRunFileNames {
                    patients: Some("patients.csv".to_string()),
                    measurements: "measurements.csv".to_string(),
                    predict_measurements: None,
                },
            ),
            Vec::new(),
            1,
            dir_d.display().to_string(),
            None,
        )
        .await;
        seed_method(&engine, run_d, "cox-cutpoint-risk", TxrMethodState::Waiting, None).await;

        seed_run(
            &engine,
            run_e,
            t(1),
            TxrRunStatus::Failed,
            crate::modules::execution_engine::types::TxrRunMode::Train,
            input_summary(
                Some(10),
                None,
                2,
                crate::modules::execution_engine::types::TxrRunFileNames {
                    patients: Some("patients.csv".to_string()),
                    measurements: "measurements.csv".to_string(),
                    predict_measurements: None,
                },
            ),
            Vec::new(),
            1,
            dir_e.display().to_string(),
            None,
        )
        .await;
        seed_method(&engine, run_e, "landmark-cox", TxrMethodState::Failed, None).await;
        engine
            .patch_method(
                run_e,
                "landmark-cox",
                &MethodPatch {
                    state: Some(TxrMethodState::Failed),
                    reason: Some(TxrRunReason {
                        code: "ENV_UNREADY".to_string(),
                        detail: "environment is not ready".to_string(),
                    }),
                    finished_at: Some(t(0)),
                    ..Default::default()
                },
            )
            .await
            .expect("patch failed reason");

        Seed {
            pool,
            run_a,
            run_b,
            run_c,
            run_d,
            run_e,
            dir_a,
            model_a,
        }
    }

    fn query(q: Option<&str>, kind: Option<&str>, status: Option<&str>) -> TxrHistoryListQuery {
        TxrHistoryListQuery {
            q: q.map(|s| s.to_string()),
            kind: kind.and_then(|k| serde_json::from_value(serde_json::Value::String(k.to_string())).ok()),
            status: status.map(|s| s.to_string()),
            limit: None,
            offset: None,
        }
    }


    // ── TEST-HS-4 ─────────────────────────────────────────────────────────────

    #[test]
    fn bucket_map_is_the_dec4_rule() {
        assert_eq!(bucket_for(TxrRunStatus::Creating), TxrHistoryBucket::Running);
        assert_eq!(bucket_for(TxrRunStatus::Preparing), TxrHistoryBucket::Running);
        assert_eq!(bucket_for(TxrRunStatus::Running), TxrHistoryBucket::Running);
        assert_eq!(bucket_for(TxrRunStatus::Finishing), TxrHistoryBucket::Running);
        assert_eq!(bucket_for(TxrRunStatus::Finished), TxrHistoryBucket::Finished);
        assert_eq!(bucket_for(TxrRunStatus::Stopped), TxrHistoryBucket::Stopped);
        assert_eq!(bucket_for(TxrRunStatus::Failed), TxrHistoryBucket::Failed);

        // The inverted map (the WHERE's engine-status set per bucket).
        assert_eq!(
            engine_statuses_for_bucket(TxrHistoryBucket::Running),
            &["creating", "preparing", "running", "finishing"]
        );
        assert_eq!(engine_statuses_for_bucket(TxrHistoryBucket::Finished), &["finished"]);
        assert_eq!(engine_statuses_for_bucket(TxrHistoryBucket::Stopped), &["stopped"]);
        assert_eq!(engine_statuses_for_bucket(TxrHistoryBucket::Failed), &["failed"]);
    }

    #[test]
    fn status_filter_parses_buckets_to_engine_statuses() {
        assert_eq!(parse_status_filter(None).expect("none"), None);
        assert_eq!(parse_status_filter(Some("")).expect("empty"), None);
        assert_eq!(
            parse_status_filter(Some("running")).expect("running"),
            Some(vec![
                "creating".to_string(),
                "preparing".to_string(),
                "running".to_string(),
                "finishing".to_string()
            ])
        );
        assert_eq!(
            parse_status_filter(Some("stopped,failed")).expect("multi"),
            Some(vec!["stopped".to_string(), "failed".to_string()])
        );
        // The K "Stopped or failed" filter's OR union, deduplicated.
        assert_eq!(
            parse_status_filter(Some("failed,stopped,failed")).expect("dedup"),
            Some(vec!["failed".to_string(), "stopped".to_string()])
        );
        assert!(matches!(
            parse_status_filter(Some("stopped,")),
            Err(HistoryQueryError::InvalidStatus { .. })
        ));
        assert!(matches!(
            parse_status_filter(Some("nope")),
            Err(HistoryQueryError::InvalidStatus { .. })
        ));
        assert_eq!(HistoryQueryError::InvalidStatus { value: "nope".into() }.code(), "INVALID_STATUS");
    }

    #[test]
    fn first_reason_orders_failed_then_cannot_run_then_stopped() {
        let row = |state: &str, code: Option<&str>, started: Option<i64>, seq: i64| TerminalReasonRow {
            run_id: Uuid::nil(),
            state: state.to_string(),
            reason_code: code.map(|c| c.to_string()),
            reason_detail: Some("d".to_string()),
            started_at: started.map(|s| chrono::DateTime::<Utc>::from_timestamp(s, 0).expect("stamp")),
            finished_at: None,
            seq,
        };
        fn reason(r: &crate::modules::execution_engine::types::TxrRunReason) -> &str {
            r.code.as_str()
        }

        // Priority: a stopped method does not beat a failed one.
        let rows = vec![
            row("stopped", Some("S"), None, 0),
            row("cannot_run", Some("C"), None, 1),
            row("failed", Some("F"), None, 2),
        ];
        assert_eq!(reason(&first_terminal_reason(&rows).expect("a reason")), "F");

        // cannot_run beats stopped.
        let rows = vec![row("stopped", Some("S"), None, 0), row("cannot_run", Some("C"), None, 1)];
        assert_eq!(reason(&first_terminal_reason(&rows).expect("a reason")), "C");

        // Within one priority: the EARLIEST started_at wins.
        let rows = vec![
            row("failed", Some("LATE"), Some(100), 0),
            row("failed", Some("EARLY"), Some(50), 1),
        ];
        assert_eq!(reason(&first_terminal_reason(&rows).expect("a reason")), "EARLY");

        // NULL started_at sorts after a stamped one; seq is the final tie-break.
        let rows = vec![
            row("failed", Some("NULLS"), None, 0),
            row("failed", Some("STAMPED"), Some(50), 1),
        ];
        assert_eq!(reason(&first_terminal_reason(&rows).expect("a reason")), "STAMPED");
        let rows = vec![
            row("failed", Some("SEQ-1"), None, 1),
            row("failed", Some("SEQ-0"), None, 0),
        ];
        assert_eq!(reason(&first_terminal_reason(&rows).expect("a reason")), "SEQ-0");

        // A terminal row WITHOUT a reason is not a candidate (never fabricated).
        let rows = vec![row("failed", None, None, 0), row("cannot_run", Some("C"), None, 1)];
        assert_eq!(reason(&first_terminal_reason(&rows).expect("a reason")), "C");
        let rows = vec![row("failed", None, None, 0)];
        assert!(first_terminal_reason(&rows).is_none());

        // The detail passes the engine's own reason text VERBATIM.
        let rows = vec![TerminalReasonRow {
            run_id: Uuid::nil(),
            state: "cannot_run".to_string(),
            reason_code: Some("REQUIRED_MARKER_MISSING".to_string()),
            reason_detail: Some("marker LDH is missing from the measurements".to_string()),
            started_at: None,
            finished_at: None,
            seq: 0,
        }];
        let r = first_terminal_reason(&rows).expect("reason");
        assert_eq!(r.code, "REQUIRED_MARKER_MISSING");
        assert_eq!(r.detail, "marker LDH is missing from the measurements");
    }

    // ── TEST-HS-5 (the WHERE) + the assembly pins ────────────────────────────

    #[tokio::test]
    async fn where_builder_binds_and_composes_closed_form() {
        let seed = seed_world("where").await;
        let repo = HistoryRepository::new(seed.pool.clone());

        // No filter: all five, newest first (created_at DESC — the seeded
        // timestamps make the order deterministic).
        let page = repo.page(&query(None, None, None)).await.expect("page");
        assert_eq!(page.total, 5);
        assert_eq!(page.items.len(), 5);
        assert_eq!(page.items[0].id, seed.run_a);
        assert_eq!(page.items[4].id, seed.run_e);

        // `q` is case-insensitive over METHOD ids (INSTR(LOWER...)); the
        // run-drowned lowercase spelling is matched by the uppercase query.
        let page = repo.page(&query(Some("COX-CUTPOINT"), None, None)).await.expect("page");
        assert_eq!(page.total, 3, "A + D selected it; B applied it as the model's method");
        for item in &page.items {
            assert!(item.methods.iter().any(|m| m.id == "cox-cutpoint-risk"));
        }

        // `q` over SAVED SET names (the PROV-MS-11 join, DEC-9).
        let page = repo.page(&query(Some("crc"), None, None)).await.expect("page");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, seed.run_a);
        assert_eq!(page.items[0].models_made.saved_sets[0].set_name, "CRC cohort, day 56");

        // `q` over the RECORDED FILE names (GAP-HS-1) — the reuse run finds
        // the file it was run on, and TRAIN-mode runs do not leak in.
        let page = repo.page(&query(Some("MARCH_NEW"), None, None)).await.expect("page");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, seed.run_b);
        assert_eq!(page.items[0].file_names, vec!["march_new.csv".to_string()]);

        // The term is BOUND: a SQL-shaped or wildcard-shaped string is data.
        let page = repo.page(&query(Some("x' OR 1=1 --"), None, None)).await.expect("page");
        assert_eq!(page.total, 0);
        let page = repo.page(&query(Some("%"), None, None)).await.expect("page");
        assert_eq!(page.total, 0);
        let page = repo.page(&query(Some(""), None, None)).await.expect("page");
        assert_eq!(page.total, 5, "the empty substring matches every run");

        // `kind` (the K filter) → the engine's mode; combined with `q` it is
        // an AND between filters — the OR-joins stay closed-form (each EXISTS
        // subquery guards its own run id — the run matched by SET NAME under
        // `kind=learned` is a train run and stays, the reuse run matched by
        // FILE NAME under `kind=learned` is excluded).
        let page = repo.page(&query(None, Some("learned"), None)).await.expect("page");
        assert_eq!(page.total, 4, "A C D E are train runs");
        let page = repo.page(&query(None, Some("saved-model"), None)).await.expect("page");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, seed.run_b);
        let page = repo.page(&query(Some("crc"), Some("learned"), None)).await.expect("page");
        assert_eq!(page.total, 1, "A: train + set name match");
        let page = repo.page(&query(Some("march_new"), Some("learned"), None)).await.expect("page");
        assert_eq!(page.total, 0, "B is reuse — the mode filter intersects");

        // `status` (the bucket vocabulary, one call for "Stopped or failed" —
        // OR semantics, engine statuses matched through the DEC-4 map).
        let page = repo.page(&query(None, None, Some("running"))).await.expect("page");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, seed.run_d);
        assert_eq!(page.items[0].bucket, TxrHistoryBucket::Running);
        let page = repo.page(&query(None, None, Some("stopped,failed"))).await.expect("page");
        assert_eq!(page.total, 2);
        let ids: Vec<Uuid> = page.items.iter().map(|i| i.id).collect();
        assert!(ids.contains(&seed.run_c) && ids.contains(&seed.run_e));
        let page = repo.page(&query(None, None, Some("finished"))).await.expect("page");
        assert_eq!(page.total, 2, "A + B");

        // Paging bounds: the default + clamp are the exact wire echoes.
        let page = repo.page(&TxrHistoryListQuery {
            limit: Some(200),
            offset: Some(6),
            ..Default::default()
        })
        .await
        .expect("page");
        assert_eq!(page.limit, HistoryLimits::MAX_LIMIT);
        assert_eq!(page.offset, 6);
        assert_eq!(page.total, 5);
        assert!(page.items.is_empty(), "offset past the end is an empty page");
        let page = repo.page(&TxrHistoryListQuery {
            limit: Some(0),
            ..Default::default()
        })
        .await
        .expect("page");
        assert_eq!(page.limit, 1, "0 clamps to the floor");
    }

    #[tokio::test]
    async fn page_assembles_the_shaped_row() {
        let seed = seed_world("row").await;
        let repo = HistoryRepository::new(seed.pool.clone());

        let page = repo.page(&query(None, None, Some("finished"))).await.expect("page");
        let a = page.items.iter().find(|i| i.id == seed.run_a).expect("run A").clone();
        let b = page.items.iter().find(|i| i.id == seed.run_b).expect("run B").clone();

        // The K row facts of EXAMPLE-HS-1.
        assert_eq!(a.mode, crate::modules::execution_engine::types::TxrRunMode::Train);
        assert_eq!(a.bucket, TxrHistoryBucket::Finished);
        assert_eq!(a.method_count, 2);
        assert_eq!(a.file_names, vec!["patients.csv", "measurements.csv", "new_measurements.csv"]);
        assert_eq!(a.learned_from, Some(151));
        assert_eq!(a.predicted, Some(38));
        assert_eq!(a.markers, 5);
        assert_eq!(a.endpoint, crate::modules::execution_engine::types::TxrEndpoint::Pfs);
        assert_eq!(a.decision_day, 56.0);
        assert_eq!(a.look_ahead_day, 238.0);
        assert_eq!(a.methods.len(), 2);
        assert_eq!(a.methods[0].id, "landmark-cox-current");
        assert_eq!(a.methods[0].version, "1.0");
        assert_eq!(a.methods[0].elapsed_secs, Some(120));
        // The STORED create-time estimate (the engine's own facts — never a
        // re-derivation and never a fabricated zero).
        assert_eq!(a.estimate_total_seconds, Some(240.0));
        assert_eq!(a.models_made.produced, 1, "one COMPLETE produced record");
        assert_eq!(a.models_made.saved_sets.len(), 1);
        assert_eq!(a.models_made.saved_sets[0].set_name, "CRC cohort, day 56");
        assert_eq!(a.models_made.saved_sets[0].model_count, 1);
        assert!(a.markers_saved, "the run's produced model was saved");
        assert!(a.copies_kept, "no retention row reads as kept");
        assert!(a.can_rerun, "copies kept + terminal");
        assert!(a.can_reopen && a.can_download, "predictions_ready");
        assert_eq!(a.dir, seed.dir_a.display().to_string());

        // The reuse run carries its consumed set/model names (GAP-HS-3 /
        // GAP-HIST-2) — the engine-grown model_ids joined over the store.
        assert_eq!(b.mode, crate::modules::execution_engine::types::TxrRunMode::Reuse);
        assert_eq!(b.models_used.len(), 1);
        assert_eq!(b.models_used[0].set_name, "CRC cohort, day 56");
        assert_eq!(b.models_used[0].model_name, "cox-cutpoint-risk");
        assert_eq!(b.models_used[0].model_id, seed.model_a);
        assert!(b.models_made.saved_sets.is_empty(), "a reuse run made nothing");
        assert!(!b.markers_saved);

        // The stopped run's reason passes VERBATIM (the first terminal
        // method's — the batched page path).
        let page = repo.page(&query(None, None, Some("stopped"))).await.expect("page");
        let c = &page.items[0];
        assert_eq!(
            c.reason.as_ref().expect("a reason").code,
            "REQUIRED_MARKER_MISSING"
        );
        assert_eq!(
            c.reason.as_ref().expect("a reason").detail,
            "marker LDH is missing from the measurements"
        );
        assert_eq!(c.bucket, TxrHistoryBucket::Stopped);

        // A retention row flips the flags (a lazy row + the DEC-6 rule).
        sqlx::query!(
            "INSERT INTO txr_run_retention (run_id, copies_kept, copies_cleared_at) VALUES ($1, 0, $2)",
            seed.run_c,
            "2026-10-26T10:00:00.000Z",
        )
        .execute(&seed.pool)
        .await
        .expect("retention row");
        let page = repo.page(&query(None, None, Some("stopped"))).await.expect("page");
        assert!(!page.items[0].copies_kept);
        assert!(!page.items[0].can_rerun, "DEC-6: no copies → no engine rerun");

        // The batched produced COUNT agrees with the engine's own seam (the
        // COMPLETE-record rule is the provider's, pinned here).
        let produced = produced_models(&seed.pool, seed.run_a).await.expect("produced seam");
        assert_eq!(produced.len() as u32, a.models_made.produced);
    }

    #[tokio::test]
    async fn detail_assembles_the_shaped_block() {
        let seed = seed_world("detail").await;
        let repo = HistoryRepository::new(seed.pool.clone());

        // The input copy files of run A (the plan's fs layout: the patients
        // copy at its stem, measurements.csv, beside engine-owned
        // values.csv / features.csv / run-input.json).
        let input = seed.dir_a.join("input");
        std::fs::create_dir_all(&input).expect("input dir");
        std::fs::write(input.join("patients.csv"), vec![0u8; 100]).expect("patients copy");
        std::fs::write(input.join("measurements.csv"), vec![0u8; 200]).expect("measurements copy");
        std::fs::write(input.join("values.csv"), vec![0u8; 300]).expect("canonical values");
        std::fs::write(input.join("features.csv"), vec![0u8; 40]).expect("canonical features");
        std::fs::write(input.join("run-input.json"), b"{}").expect("rerun record");
        std::fs::create_dir_all(seed.dir_a.join("bundles/landmark-cox-current/out")).expect("bundle");
        std::fs::write(seed.dir_a.join("bundles/landmark-cox-current/out/result.csv"), vec![0u8; 999])
            .expect("method output");

        let detail = repo
            .get_detail(seed.run_a)
            .await
            .expect("detail")
            .expect("run A exists");
        assert_eq!(detail.id, seed.run_a);
        assert_eq!(detail.mode, crate::modules::execution_engine::types::TxrRunMode::Train);
        assert_eq!(detail.bucket, TxrHistoryBucket::Finished);
        assert_eq!(detail.method_count, 2);
        assert_eq!(detail.file_names.len(), 3);
        assert_eq!(detail.methods.len(), 2, "the engine's own rows verbatim");
        assert_eq!(detail.methods[0].method_id, "landmark-cox-current");
        assert_eq!(detail.methods[0].elapsed_secs, Some(120));
        assert_eq!(detail.models_made.produced, 1);
        assert_eq!(detail.models_saved.len(), 1);
        assert_eq!(detail.models_saved[0].set_name, "CRC cohort, day 56");
        assert_eq!(detail.models_saved[0].model_name, "cox-cutpoint-risk");
        assert_eq!(detail.models_saved[0].size_bytes, 4096);
        assert!(detail.models_used.is_empty(), "train mode → []");
        assert_eq!(detail.settings.endpoint, crate::modules::execution_engine::types::TxrEndpoint::Pfs);
        assert_eq!(detail.settings.decision_day, 56.0);
        assert_eq!(detail.settings.look_ahead_day, 238.0);
        assert!(detail.settings.covariates);
        assert_eq!(detail.settings.seed, Some(1));
        assert_eq!(detail.settings.cpus, Some(4));
        assert_eq!(detail.settings.memory_total_bytes, Some(16 * 1024 * 1024 * 1024));
        assert_eq!(detail.settings.at_a_time, 3);
        assert!(detail.settings.save_models);
        assert_eq!(detail.settings.mode, crate::modules::execution_engine::types::TxrRunMode::Train);
        assert_eq!(detail.log_line_count, 0, "no log rows seeded — an honest 0 count");
        assert!(detail.copies.kept);
        assert!(detail.copies.cleared_at.is_none());
        // The recorded copies only — the engine-owned canonical CSVs and the
        // rerun record are never listed as "Your files".
        let names: Vec<&str> = detail.file_sizes.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["patients.csv", "measurements.csv"]);
        assert_eq!(detail.file_sizes[0].size_bytes, 100);
        assert_eq!(detail.file_sizes[1].size_bytes, 200);
        // The whole run dir's bytes (copies + canonical + bundle outputs).
        assert_eq!(detail.dir_bytes, Some(100 + 200 + 300 + 40 + 2 + 999));
        // The stored estimate, projected ("took X (estimated Y)").
        let est = detail.use_estimate.as_ref().expect("stored estimate");
        assert_eq!(est.total_seconds, 240.0);
        assert_eq!(est.estimate_quality, TimingQuality::Estimate);
        assert_eq!(detail.estimate_total_seconds, Some(240.0));

        // The reuse run: models_used through the detail join (same set as the
        // list row's), log count, no saved row of its own.
        let log_id = Uuid::new_v4();
        sqlx::query!(
            "INSERT INTO txr_run_logs (id, run_id, seq, method_id, stream, content) VALUES ($1, $2, 0, $3, 'engine', $4)",
            log_id,
            seed.run_b,
            Some("cox-cutpoint-risk"),
            "run started",
        )
        .execute(&seed.pool)
        .await
        .expect("log row");
        let detail = repo
            .get_detail(seed.run_b)
            .await
            .expect("detail")
            .expect("run B exists");
        assert_eq!(detail.models_used.len(), 1);
        assert_eq!(detail.models_used[0].model_name, "cox-cutpoint-risk");
        assert_eq!(detail.log_line_count, 1);
        assert!(detail.file_sizes.is_empty(), "the reuse run's input dir holds no copies — none recorded");

        // A cleared run: copies_kept false, can_rerun false, file_sizes empty
        // even when the dir still exists (run C's dir is not created — the
        // retention flag is the gate, not the fs state).
        sqlx::query!(
            "INSERT INTO txr_run_retention (run_id, copies_kept, copies_cleared_at) VALUES ($1, 0, $2)",
            seed.run_c,
            "2026-10-26T10:00:00.000Z",
        )
        .execute(&seed.pool)
        .await
        .expect("retention row");
        let detail = repo
            .get_detail(seed.run_c)
            .await
            .expect("detail")
            .expect("run C exists");
        assert_eq!(detail.copies.kept, false);
        assert_eq!(detail.copies.cleared_at.map(|d| d.to_rfc3339()), Some("2026-10-26T10:00:00+00:00".to_string()));
        assert!(!detail.can_rerun);
        assert!(detail.file_sizes.is_empty(), "cleared → no copy sizes");

        // A missing dir is never a 500: the detail lists with the fs facts
        // null/empty.
        let detail = repo
            .get_detail(seed.run_d)
            .await
            .expect("detail")
            .expect("run D exists");
        assert_eq!(detail.bucket, TxrHistoryBucket::Running);
        assert!(!detail.can_rerun, "a running bucket cannot be rerun");
        assert!(detail.dir_bytes.is_none(), "dir does not exist");
        assert!(detail.file_sizes.is_empty());

        // Unknown id → None (the route's 404 RUN_NOT_FOUND).
        assert!(repo.get_detail(Uuid::new_v4()).await.expect("no error").is_none());
    }
}
