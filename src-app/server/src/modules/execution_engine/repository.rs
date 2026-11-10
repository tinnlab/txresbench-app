//! Run persistence — the engine's repository over the four module-owned
//! tables (PLAN ITEM-7, PROV-EE-10): `txr_runs`, `txr_run_methods`,
//! `txr_run_logs`, `txr_app_config` (+ the additive `0005` produced-model
//! columns), one typed `TxrRepository` for the orchestrator + routes, the
//! JSON columns round-tripped as the wire types, the per-run method rows and
//! the run-scoped log with global `seq` allocation + the
//! `MAX_LOG_LINES_PER_RUN` trim, the per-state aggregate counts query, and —
//! PROV-EE-9 — the `produced_models` seam `model-store` binds to.
//!
//! ### SQLite port conventions (CONS-EE-3 / PROV-sqlite-store-4 type map)
//!
//! Every query is a compile-time sqlx macro (compiled against the per-worktree
//! build DB), never dynamit text: `uuid` columns are 16-byte BLOBs (`id as
//! "id: Uuid"`), `DateTime<Utc>` is RFC3339 TEXT (written by the app as
//! chrono's `+00:00` form and by the SQLite `strftime(...,'now')` default,
//! both readable), JSON columns are TEXT decoded as `serde_json::Value` and
//! parsed into the wire type by the row converters, INTEGER columns decode as
//! `i64` (ints that need fewer bytes are spelled `i32`/`bool` in the macro
//! override — the sqlite `bool` decoder reads `!= 0`), and `REAL` as `f64`.
//! The `"group"` column is a SQLite keyword — the identifier is double-quoted
//! in every query, exactly as the migration writes it.
//!
//! ### seq allocation + trim (DEC-13 / DEC-21)
//!
//! A log line's `seq` is `COALESCE(MAX(seq), 0) + 1` over the run's rows,
//! evaluated INSIDE the insert statement: SQLite serializes writers, so two
//! concurrent appends cannot both allocate the same `seq` (the write lock is
//! taken by the insert statement itself; a second writer's subselect sees the
//! first's committed rows). `UNIQUE(run_id, seq)` is the backstop. After the
//! insert the oldest rows past [`TxrLimits::MAX_LOG_LINES_PER_RUN`] are
//! trimmed in the same transaction — the run's "Copy the log" stays bounded.

use chrono::{DateTime, Utc};
use serde_json::Value as Json;
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;
use ziee_core::AppError;

use super::types::{
    EngineReasonCode, RunConfig, TxrAppConfig, TxrCoverage, TxrLogStream, TxrMethodEnv,
    TxrMethodState, TxrPhase, TxrProbSource, TxrProducedModel, TxrRunCounts, TxrRunEstimate,
    TxrRunInputSummary, TxrRunLogLine, TxrRunMethod, TxrRunMode, TxrRunReason, TxrRunStatus,
    TxrRunSummary, TxrTask,
};

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (the DB columns; the wire conversion lives on the converters)
// ─────────────────────────────────────────────────────────────────────────────

/// One `txr_runs` row, decoded with the sqlite type map. The JSON columns are
/// `serde_json::Value` here and become the wire types via
/// [`RunRow::summarize`].
#[derive(Debug, Clone, FromRow)]
pub struct RunRow {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub status: String,
    pub mode: String,
    pub config: Json,
    pub input_summary: Json,
    /// NULL in train mode; the resolved asset ids JSON array in reuse mode
    /// (reconcile GAP-HS-3).
    pub model_ids: Option<Json>,
    pub method_count: i64,
    pub counts: Json,
    pub elapsed_secs: Option<i64>,
    pub dir: String,
    pub memory_total_bytes: Option<i64>,
    pub cpus: Option<i32>,
    pub error: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub predictions_ready: bool,
    pub seed: i32,
    /// The estimate facts JSON (PROV-MC-6's response shape; the `0006`
    /// additive column — NULL = never computed, a display fact).
    pub estimate: Option<Json>,
}

impl RunRow {
    /// The `status` column as the closed vocabulary (stored by the engine's
    /// own writers — a foreign string is a corrupt row, reported not panicked).
    pub fn status(&self) -> Result<TxrRunStatus, AppError> {
        enum_from_wire(&self.status, "run status")
    }

    /// The `mode` column as the closed vocabulary.
    pub fn mode(&self) -> Result<TxrRunMode, AppError> {
        enum_from_wire(&self.mode, "run mode")
    }

    /// The summary the routes/consumers render (PROV-EE-3): the JSON columns
    /// parsed as the wire types — `config`, `input_summary` (incl. the
    /// captured `file_names`), the per-state `counts`, and `model_ids` (`[]`
    /// for the NULL train-mode cell). `method_ids` is the run's selected
    /// method list (a `txr_run_methods` fact — the run row itself keeps only
    /// the count; see [`TxrRepository::method_ids_for_run`]).
    pub fn summarize(&self, method_ids: Vec<String>) -> Result<TxrRunSummary, AppError> {
        let config: RunConfig = json_parse(&self.config, "txr_runs.config")?;
        let input_summary: TxrRunInputSummary =
            json_parse(&self.input_summary, "txr_runs.input_summary")?;
        let counts: TxrRunCounts = json_parse(&self.counts, "txr_runs.counts")?;
        let model_ids: Vec<String> = match &self.model_ids {
            Some(v) => json_parse(v, "txr_runs.model_ids")?,
            // Train mode: the column is NULL — the wire answer is the empty
            // list (`[]`), never `null` (PROV-EE-3).
            None => Vec::new(),
        };
        Ok(TxrRunSummary {
            id: self.id,
            status: self.status()?,
            mode: self.mode()?,
            created_at: self.created_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            elapsed_secs: self.elapsed_secs.map(|v| v as u64),
            config,
            method_ids,
            model_ids,
            counts,
            predictions_ready: self.predictions_ready,
            dir: self.dir.clone(),
            input_summary,
        })
    }

    /// The run's estimate facts (the `0006` column; `None` = never computed —
    /// a legacy row or a create-time compute failure; the estimate is a
    /// display fact, never a run failure).
    pub fn estimate(&self) -> Result<Option<TxrRunEstimate>, AppError> {
        match &self.estimate {
            Some(v) => json_parse(v, "txr_runs.estimate").map(Some),
            None => Ok(None),
        }
    }
}

/// Parse the stored RunConfig JSON (the detail + predictions routes read the
/// row's config without re-deriving it — the stored value IS the run's).
pub(crate) fn parse_config(cell: &Json) -> Result<RunConfig, AppError> {
    json_parse(cell, "txr_runs.config")
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume: a JSON array of 32-char lowercase hex strings,
/// compared against a 16-byte BLOB column through `unhex()` — the ITEM-15
/// `ziee-file` convention (its `uuid_list_json` is the `jobs` repository's
/// copy; the app's modules are single-driver so the one helper is local
/// again, beside the only `IN (…)` site this module has).
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}

fn json_value<T: serde::Serialize>(v: &T, what: &str) -> Result<Json, AppError> {
    serde_json::to_value(v).map_err(|e| AppError::database_error(format!("{what} serializes: {e}")))
}

fn json_parse<T: serde::de::DeserializeOwned>(v: &Json, what: &str) -> Result<T, AppError> {
    serde_json::from_value(v.clone())
        .map_err(|e| AppError::database_error(format!("{what} is not a valid stored value: {e}")))
}

fn enum_from_wire<E: serde::de::DeserializeOwned>(s: &str, what: &str) -> Result<E, AppError> {
    serde_json::from_value(Json::String(s.to_string())).map_err(|e| {
        AppError::database_error(format!("{what} '{s}' is not a vocabulary member: {e}"))
    })
}

/// One method row (PROV-EE-10) with the `0005` produced-model fields appended.
#[derive(Debug, Clone, FromRow)]
pub struct MethodRow {
    pub id: Uuid,
    pub run_id: Uuid,
    pub method_id: String,
    pub label: String,
    pub version: String,
    pub group: String,
    pub state: String,
    pub reason_code: Option<String>,
    pub reason_detail: Option<String>,
    pub phase: Option<String>,
    pub bytes_downloaded: i64,
    pub bytes_total: Option<i64>,
    pub job_id: Option<Uuid>,
    pub env_base_digest: Option<String>,
    pub env_layer_digest: Option<String>,
    pub model_out_digest: Option<String>,
    pub model_dir: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub elapsed_secs: Option<i64>,
    pub prob_source: Option<String>,
    pub coverage_scored: Option<i64>,
    pub coverage_eligible: Option<i64>,
    pub task: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub trained_on_patients: Option<i64>,
    pub size_bytes: Option<i64>,
    pub own_auc: Option<f64>,
}

impl MethodRow {
    /// The state column as the closed vocabulary.
    pub fn state(&self) -> Result<TxrMethodState, AppError> {
        enum_from_wire(&self.state, "method state")
    }

    /// The `reason` the plan's detail carries (one vocabulary — eligibility
    /// codes verbatim, engine codes verbatim; `None` when the row is fine).
    pub fn reason(&self) -> Option<TxrRunReason> {
        let code = self.reason_code.as_ref()?;
        Some(TxrRunReason {
            code: code.clone(),
            detail: self.reason_detail.clone().unwrap_or_default(),
        })
    }

    /// The wire row of the F screen (PROV-EE-3): the stored facts + the
    /// catalogue `group_label` resolved through the facts shim (the row keeps
    /// the catalogue group id; the HUMAN label is the catalogue's — a method
    /// removed from the catalogue after the run falls back to its group id so
    /// the row still renders). Every derived value is computed BEFORE the
    /// moves (partial moves would leave `self` unborrowable).
    pub fn into_method(self) -> Result<TxrRunMethod, AppError> {
        let state = self.state()?;
        let reason = self.reason();
        let group_label = super::envmanifest::facts_for(&self.method_id)
            .map(|m| m.group_label.clone())
            .unwrap_or_else(|| self.group.clone());
        let task = match &self.task {
            Some(t) => Some(enum_from_wire(t, "method task")?),
            None => None,
        };
        let prob_source = match &self.prob_source {
            Some(p) => Some(enum_from_wire(p, "probability source")?),
            None => None,
        };
        let phase = match &self.phase {
            Some(p) => Some(enum_from_wire(p, "method phase")?),
            None => None,
        };
        let coverage = match (self.coverage_scored, self.coverage_eligible) {
            (Some(scored), Some(eligible)) => Some(TxrCoverage {
                scored: scored as u32,
                eligible: eligible as u32,
                fraction: coverage_fraction(scored as u32, eligible as u32),
            }),
            _ => None,
        };
        let env = match (
            self.env_base_digest.as_deref(),
            self.env_layer_digest.as_deref(),
        ) {
            (Some(base), Some(layer)) => Some(TxrMethodEnv {
                base_digest: base.to_string(),
                layer_digest: layer.to_string(),
            }),
            _ => None,
        };
        // `progress_pct` is NOT a column (PROV-EE-10): the download phase's
        // progress is derived at read from the persisted counters — the
        // ratio of bytes_downloaded to bytes_total while the row IS
        // downloading, null outside that phase (the plan's spelling).
        let progress_pct = if state == TxrMethodState::Downloading {
            match self.bytes_total {
                Some(total) if total > 0 => {
                    Some((self.bytes_downloaded as f64 / total as f64) * 100.0)
                }
                _ => None,
            }
        } else {
            None
        };
        let bytes_downloaded = self.bytes_downloaded as u64;
        Ok(TxrRunMethod {
            method_id: self.method_id,
            label: self.label,
            group: self.group,
            group_label,
            version: self.version,
            state,
            task,
            reason,
            bytes_downloaded,
            bytes_total: self.bytes_total.map(|v| v as u64),
            progress_pct,
            phase,
            started_at: self.started_at,
            finished_at: self.finished_at,
            elapsed_secs: self.elapsed_secs.map(|v| v as u64),
            exit_code: self.exit_code,
            duration_ms: self.duration_ms.map(|v| v as u64),
            prob_source,
            coverage,
            env,
        })
    }
}

/// The coverage fraction of the per-patient abstention rule.
fn coverage_fraction(scored: u32, eligible: u32) -> f64 {
    if eligible == 0 {
        0.0
    } else {
        (scored as f64) / (eligible as f64)
    }
}

/// One log row. `seq` is the run's global sequence (DEC-13).
#[derive(Debug, Clone, FromRow)]
pub struct LogRow {
    pub id: Uuid,
    pub run_id: Uuid,
    pub seq: i64,
    pub method_id: Option<String>,
    pub stream: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

impl LogRow {
    /// The wire line.
    pub fn into_line(self) -> Result<TxrRunLogLine, AppError> {
        Ok(TxrRunLogLine {
            seq: self.seq as u64,
            method_id: self.method_id,
            stream: enum_from_wire(&self.stream, "log stream")?,
            content: self.content,
            created_at: self.created_at,
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert shapes
// ─────────────────────────────────────────────────────────────────────────────

/// The new-run row the orchestrator persists at create (PROV-EE-2). The JSON
/// facts are bound as their wire types; the repository serializes them.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub id: Uuid,
    /// `None` = the repository stamps `now()` (the run's real create time).
    pub created_at: Option<DateTime<Utc>>,
    pub status: TxrRunStatus,
    pub mode: TxrRunMode,
    pub config: RunConfig,
    pub input_summary: TxrRunInputSummary,
    /// Resolved asset ids (empty in train mode → NULL column).
    pub model_ids: Vec<String>,
    pub method_count: u32,
    pub counts: TxrRunCounts,
    pub dir: String,
    pub memory_total_bytes: Option<u64>,
    pub cpus: Option<u32>,
    pub seed: u32,
    /// The estimate facts (None = never computed — CONS-EE-9b's "stores it on
    /// the run"; the provider's response is only a display fact).
    pub estimate: Option<TxrRunEstimate>,
}

/// The new method row (the F screen's row at classification time; the rest of
/// the columns are NULL until the state machine writes them).
#[derive(Debug, Clone)]
pub struct NewMethod {
    pub id: Uuid,
    pub run_id: Uuid,
    pub method_id: String,
    pub label: String,
    pub version: String,
    pub group: String,
    pub state: TxrMethodState,
    /// The manifest `size_bytes` (the download progress denominator).
    pub bytes_total: Option<u64>,
}

/// One state-machine step's row facts (INV-2): the state is always written,
/// every other column is COALESCE'd (an untouched field keeps its value — the
/// F screen's counters never regress through a partial update). Enums are the
/// wire types; the repository binds their closed spellings.
#[derive(Debug, Clone, Default)]
pub struct MethodPatch {
    pub state: Option<TxrMethodState>,
    /// The reason as ONE record (ITEM-8's classification + executor arms:
    /// the one-vocabulary reasons — provider codes verbatim OR engine codes —
    /// write BOTH columns in one patch; wins over the typed arm below when
    /// both are present).
    pub reason: Option<TxrRunReason>,
    pub reason_code: Option<EngineReasonCode>,
    pub reason_detail: Option<String>,
    pub phase: Option<TxrPhase>,
    pub bytes_downloaded: Option<u64>,
    pub bytes_total: Option<u64>,
    pub job_id: Option<Uuid>,
    pub env_base_digest: Option<String>,
    pub env_layer_digest: Option<String>,
    pub model_out_digest: Option<String>,
    pub model_dir: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub elapsed_secs: Option<u64>,
    pub prob_source: Option<TxrProbSource>,
    pub coverage_scored: Option<u32>,
    pub coverage_eligible: Option<u32>,
    pub task: Option<TxrTask>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub trained_on_patients: Option<u32>,
    pub size_bytes: Option<u64>,
    pub own_auc: Option<f64>,
}

impl MethodPatch {
    /// The terminal-with-reason shortcut (a failed/stopped/cannot-run row gets
    /// its typed reason in ONE call — INV-2's "failure kept with its reason").
    pub fn terminal(
        state: TxrMethodState,
        reason: EngineReasonCode,
        detail: impl Into<String>,
        finished_at: DateTime<Utc>,
    ) -> Self {
        Self {
            state: Some(state),
            reason_code: Some(reason),
            reason_detail: Some(detail.into()),
            finished_at: Some(finished_at),
            ..Self::default()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The repository
// ─────────────────────────────────────────────────────────────────────────────

/// The engine's repository over the four tables (a clone of the process pool —
/// `Arc`-backed, cheap; CONS-EE-1).
#[derive(Clone)]
pub struct TxrRepository {
    pool: SqlitePool,
}

impl TxrRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The pool (routes + runtime reuse the same handle for transactions).
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    // ── runs ────────────────────────────────────────────────────────────────

    /// Insert a run row (the id is the engine's `Uuid::new_v4()` — the schema
    /// has no AUTOINCREMENT). Returns the created row.
    pub async fn insert_run(&self, new: &NewRun) -> Result<RunRow, AppError> {
        // The JSON cells bind as owned Values (a temporary in the macro's
        // argument list would outlive the query's borrow — bind locals).
        let created_at = new.created_at.unwrap_or_else(Utc::now);
        let config = json_value(&new.config, "RunConfig")?;
        let input_summary = json_value(&new.input_summary, "input_summary")?;
        let model_ids = if new.model_ids.is_empty() {
            None
        } else {
            Some(json_value(&new.model_ids, "model_ids")?)
        };
        let counts = json_value(&new.counts, "counts")?;
        let estimate = match &new.estimate {
            Some(e) => Some(json_value(e, "estimate")?),
            None => None,
        };
        // Every bind is a LOCAL (the macro's generated block drops statement
        // temporaries before the executor borrows them).
        let status = new.status.as_str();
        let mode = new.mode.as_str();
        let method_count = new.method_count as i64;
        let dir = new.dir.as_str();
        let memory_total_bytes = new.memory_total_bytes.map(|v| v as i64);
        let cpus = new.cpus.map(|v| v as i32);
        let seed = new.seed as i32;
        sqlx::query_as!(
            RunRow,
            r#"INSERT INTO txr_runs
                 (id, created_at, status, mode, config, input_summary, model_ids,
                  method_count, counts, dir, memory_total_bytes, cpus, seed, estimate)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
               RETURNING id as "id: Uuid", created_at as "created_at: DateTime<Utc>",
                         status, mode,
                         config as "config: serde_json::Value",
                         input_summary as "input_summary: serde_json::Value",
                         model_ids as "model_ids?: serde_json::Value",
                         method_count, counts as "counts: serde_json::Value",
                         elapsed_secs, dir, memory_total_bytes, cpus as "cpus?: i32",
                         error, started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         predictions_ready as "predictions_ready: bool",
                         seed as "seed: i32",
                         estimate as "estimate?: serde_json::Value""#,
            new.id,
            created_at,
            status,
            mode,
            config,
            input_summary,
            model_ids,
            method_count,
            counts,
            dir,
            memory_total_bytes,
            cpus,
            seed,
            estimate,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The run row, or `None` (404 `RUN_NOT_FOUND` at the routes).
    pub async fn get_run(&self, id: Uuid) -> Result<Option<RunRow>, AppError> {
        sqlx::query_as!(
            RunRow,
            r#"SELECT id as "id: Uuid", created_at as "created_at: DateTime<Utc>",
                      status, mode,
                      config as "config: serde_json::Value",
                      input_summary as "input_summary: serde_json::Value",
                      model_ids as "model_ids?: serde_json::Value",
                      method_count, counts as "counts: serde_json::Value",
                      elapsed_secs, dir, memory_total_bytes, cpus as "cpus?: i32",
                      error, started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      predictions_ready as "predictions_ready: bool",
                      seed as "seed: i32",
                      estimate as "estimate?: serde_json::Value"
               FROM txr_runs WHERE id = $1"#,
            id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The History (K) list: newest-first page + the total count (DEC-21).
    pub async fn list_runs(&self, limit: u32, offset: u32) -> Result<(Vec<RunRow>, u64), AppError> {
        let limit = limit as i64;
        let offset = offset as i64;
        let rows = sqlx::query_as!(
            RunRow,
            r#"SELECT id as "id: Uuid", created_at as "created_at: DateTime<Utc>",
                      status, mode,
                      config as "config: serde_json::Value",
                      input_summary as "input_summary: serde_json::Value",
                      model_ids as "model_ids?: serde_json::Value",
                      method_count, counts as "counts: serde_json::Value",
                      elapsed_secs, dir, memory_total_bytes, cpus as "cpus?: i32",
                      error, started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      predictions_ready as "predictions_ready: bool",
                      seed as "seed: i32",
                      estimate as "estimate?: serde_json::Value"
               FROM txr_runs
               ORDER BY created_at DESC, id DESC
               LIMIT $1 OFFSET $2"#,
            limit,
            offset
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        let total = sqlx::query_scalar!("SELECT COUNT(*) FROM txr_runs")
            .fetch_one(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok((rows, total as u64))
    }

    /// The run's selected method ids (PROV-EE-3's `method_ids` fact — a
    /// `txr_run_methods` projection; the run row keeps only the count).
    pub async fn method_ids_for_run(&self, run_id: Uuid) -> Result<Vec<String>, AppError> {
        let rows = sqlx::query!(
            "SELECT method_id FROM txr_run_methods WHERE run_id = $1 ORDER BY rowid",
            run_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| r.method_id).collect())
    }

    /// The run summary (list/detail wire shape, PROV-EE-3): the run row +
    /// its method ids, assembled in one place.
    pub async fn get_run_summary(&self, id: Uuid) -> Result<Option<TxrRunSummary>, AppError> {
        let Some(row) = self.get_run(id).await? else {
            return Ok(None);
        };
        let method_ids = self.method_ids_for_run(id).await?;
        row.summarize(method_ids).map(Some)
    }

    /// The History page as summaries. The page's method ids are fetched with
    /// ONE JSON-membership query (the sqlite port of `= ANY(uuid[])` — the
    /// `ziee-file` `unhex`/`json_each` convention this module's plan binds,
    /// CONS-EE-3): a second statement per run row would be N+1 on a 200-row
    /// page.
    pub async fn list_run_summaries(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<TxrRunSummary>, u64), AppError> {
        let (rows, total) = self.list_runs(limit, offset).await?;
        if rows.is_empty() {
            return Ok((Vec::new(), total));
        }
        let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
        let ids_json = uuid_list_json(&ids);
        let method_rows = sqlx::query!(
            r#"SELECT run_id as "run_id: Uuid", method_id
               FROM txr_run_methods
               WHERE run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
               ORDER BY rowid"#,
            ids_json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        let mut by_run: std::collections::HashMap<Uuid, Vec<String>> =
            std::collections::HashMap::new();
        for r in method_rows {
            by_run.entry(r.run_id).or_default().push(r.method_id);
        }
        let mut summaries = Vec::with_capacity(rows.len());
        for row in rows {
            let method_ids = by_run.remove(&row.id).unwrap_or_default();
            summaries.push(row.summarize(method_ids)?);
        }
        Ok((summaries, total))
    }

    /// The terminal transition of a run: state + finished_at + elapsed + the
    /// final counts + the predictions-ready flag, in ONE update (the
    /// `finishing → finished|failed|stopped` steps of ITEM-9).
    #[allow(clippy::too_many_arguments)]
    pub async fn finish_run(
        &self,
        id: Uuid,
        status: TxrRunStatus,
        elapsed_secs: u64,
        counts: &TxrRunCounts,
        predictions_ready: bool,
        error: Option<String>,
    ) -> Result<(), AppError> {
        let finished_at = Utc::now();
        let status = status.as_str();
        let elapsed_secs = elapsed_secs as i64;
        let predictions_ready = predictions_ready as i32;
        let counts_json = json_value(counts, "counts")?;
        sqlx::query!(
            r#"UPDATE txr_runs SET status = $2, finished_at = $3, elapsed_secs = $4,
                    counts = $5, predictions_ready = $6, error = $7
               WHERE id = $1"#,
            id,
            status,
            finished_at,
            elapsed_secs,
            counts_json,
            predictions_ready,
            error
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// A status transition that is not a finalize (creating → preparing →
    /// running → finishing; the interim step of ITEM-8's drive loop).
    pub async fn set_run_status(
        &self,
        id: Uuid,
        status: TxrRunStatus,
        started_at: Option<DateTime<Utc>>,
    ) -> Result<(), AppError> {
        let status = status.as_str();
        sqlx::query!(
            r#"UPDATE txr_runs SET status = $2,
                    started_at = COALESCE($3, started_at)
               WHERE id = $1"#,
            id,
            status,
            started_at
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// The live counts JSON on the run row (the F header's counters change
    /// with every method transition — the read path recomputes from the
    /// method rows; this write is the boot-reconcile refresh).
    pub async fn update_run_counts(&self, id: Uuid, counts: &TxrRunCounts) -> Result<(), AppError> {
        let counts_json = json_value(counts, "counts")?;
        sqlx::query!(
            "UPDATE txr_runs SET counts = $2 WHERE id = $1",
            id,
            counts_json,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Any run still in a live state (creating/preparing/running/finishing)
    /// — PROV-EE-2's `409 RUN_ALREADY_ACTIVE` guard: the single-user app
    /// drives ONE analysis at a time, so a second create (or a rerun) while
    /// one is live is refused rather than silently over-subscribing the
    /// sandbox lanes. A boot-reconciled run is terminal (`failed` +
    /// `INTERRUPTED`), so a fresh boot never sees a stale live row.
    pub async fn active_run(&self) -> Result<Option<Uuid>, AppError> {
        let id = sqlx::query_scalar!(
            r#"SELECT id as "id: Uuid" FROM txr_runs
               WHERE status IN ('creating', 'preparing', 'running', 'finishing')
               ORDER BY created_at DESC LIMIT 1"#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(id)
    }

    /// The mid-run lane change (CONS-UI-RUN-11 / TEST-EE-34): the run row's
    /// `config.at_a_time` is replaced (the lane gate itself is the drive's —
    /// this write is the persisted config the summary serves).
    pub async fn update_run_at_a_time(&self, id: Uuid, at_a_time: u32) -> Result<(), AppError> {
        let row = self.get_run(id).await?.ok_or_else(|| {
            AppError::new(
                axum::http::StatusCode::NOT_FOUND,
                "RUN_NOT_FOUND",
                format!("no run {id}"),
            )
        })?;
        let mut config = json_parse::<serde_json::Value>(&row.config, "txr_runs.config")?;
        config["at_a_time"] = serde_json::json!(at_a_time);
        sqlx::query!(
            "UPDATE txr_runs SET config = $2 WHERE id = $1",
            id,
            config,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// The mid-run estimate replacement (qa-fixes2 ITEM-6, R2-2): the lane
    /// change recomputes the schedule at the new `at_a_time`, so the run's
    /// stored estimate always matches its current setting (the F header's
    /// time-left follows the control instead of keeping the create-time
    /// schedule).
    pub async fn update_run_estimate(
        &self,
        id: Uuid,
        estimate: &TxrRunEstimate,
    ) -> Result<(), AppError> {
        let estimate_json = json_value(estimate, "TxrRunEstimate")?;
        sqlx::query!(
            "UPDATE txr_runs SET estimate = $2 WHERE id = $1",
            id,
            estimate_json,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Record one measured method run (qa-fixes2 ITEM-6, R2-3) — the
    /// estimate engine's calibration memory: a finished train-mode method's
    /// `duration_ms` + the run's own facts (`patients`, `cpus`), normalized
    /// into the DEC-7 reference shape by the calibration module.
    pub async fn record_timing_sample(
        &self,
        sample: &crate::modules::method_catalogue::calibration::TimingSample,
        run_id: Uuid,
    ) -> Result<(), AppError> {
        let measured_ms = sample.measured_ms as i64;
        let patients = sample.patients as i64;
        let cpus = sample.cpus as i64;
        sqlx::query!(
            r#"INSERT INTO txr_timing_samples (method_id, run_id, measured_ms, patients, cpus)
               VALUES ($1, $2, $3, $4, $5)"#,
            sample.method_id,
            run_id,
            measured_ms,
            patients,
            cpus,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Every recorded timing sample (the whole calibration snapshot — the
    /// estimate routes + the run start load it once per request and pass the
    /// pure `TimingCalibration` into the engines).
    pub async fn timing_samples(
        &self,
    ) -> Result<Vec<crate::modules::method_catalogue::calibration::TimingSample>, AppError> {
        let rows = sqlx::query!("SELECT method_id, measured_ms, patients, cpus FROM txr_timing_samples")
            .fetch_all(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            .map(|r| crate::modules::method_catalogue::calibration::TimingSample {
                method_id: r.method_id,
                measured_ms: r.measured_ms as u64,
                patients: r.patients as u32,
                cpus: r.cpus as u32,
            })
            .collect())
    }

    /// Every run's id + dir (the clear-all route's prune surface — the rows
    /// cascade on delete, the FOLDERS are this list).
    pub async fn all_run_dirs(&self) -> Result<Vec<(Uuid, String)>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT id as "id: Uuid", dir FROM txr_runs ORDER BY created_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| (r.id, r.dir)).collect())
    }

    /// The run's LAST `n` log lines, ascending (the SSE replay-on-connect's
    /// "last 200 log lines" — a seq-ascending page cannot express the tail).
    pub async fn logs_tail(&self, run_id: Uuid, n: u32) -> Result<Vec<LogRow>, AppError> {
        let n = n as i64;
        let mut rows = sqlx::query_as!(
            LogRow,
            r#"SELECT id as "id: Uuid", run_id as "run_id: Uuid", seq,
                      method_id, stream, content,
                      created_at as "created_at: DateTime<Utc>"
               FROM txr_run_logs
               WHERE run_id = $1
               ORDER BY seq DESC
               LIMIT $2"#,
            run_id,
            n,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        rows.reverse();
        Ok(rows)
    }

    /// Delete one run (+ its method rows + log rows — the cascade is the
    /// schema's FK). Returns whether a run row existed (204 vs 404).
    pub async fn delete_run(&self, id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!("DELETE FROM txr_runs WHERE id = $1", id)
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Clear-all (the K board's "Clear all history"): the number of runs
    /// deleted.
    pub async fn delete_all_runs(&self) -> Result<u64, AppError> {
        let res = sqlx::query!("DELETE FROM txr_runs")
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected() as u64)
    }

    // ── methods ─────────────────────────────────────────────────────────────

    /// Insert the selected method's row at classification (the state the
    /// classification decided; the rest of the row is the defaults).
    pub async fn insert_method(&self, new: &NewMethod) -> Result<MethodRow, AppError> {
        let state = new.state.as_str();
        let bytes_total = new.bytes_total.map(|v| v as i64);
        let method_id = new.method_id.as_str();
        let label = new.label.as_str();
        let version = new.version.as_str();
        let group = new.group.as_str();
        sqlx::query_as!(
            MethodRow,
            r#"INSERT INTO txr_run_methods
                 (id, run_id, method_id, label, version, "group", state, bytes_total)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id as "id: Uuid", run_id as "run_id: Uuid", method_id, label,
                         version, "group",
                         state, reason_code, reason_detail, phase, bytes_downloaded,
                         bytes_total, job_id as "job_id?: Uuid", env_base_digest,
                         env_layer_digest, model_out_digest, model_dir,
                         exit_code as "exit_code?: i32", duration_ms, elapsed_secs, prob_source,
                         coverage_scored, coverage_eligible, task,
                         started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         trained_on_patients, size_bytes, own_auc"#,
            new.id,
            new.run_id,
            method_id,
            label,
            version,
            group,
            state,
            bytes_total,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// One method row (the routes' 409 checks + ITEM-9's per-method drive).
    pub async fn get_method(
        &self,
        run_id: Uuid,
        method_id: &str,
    ) -> Result<Option<MethodRow>, AppError> {
        sqlx::query_as!(
            MethodRow,
            r#"SELECT id as "id: Uuid", run_id as "run_id: Uuid", method_id, label,
                      version, "group",
                      state, reason_code, reason_detail, phase, bytes_downloaded,
                      bytes_total, job_id as "job_id?: Uuid", env_base_digest,
                      env_layer_digest, model_out_digest, model_dir,
                      exit_code as "exit_code?: i32", duration_ms, elapsed_secs, prob_source,
                      coverage_scored, coverage_eligible, task,
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      trained_on_patients, size_bytes, own_auc
               FROM txr_run_methods
               WHERE run_id = $1 AND method_id = $2"#,
            run_id,
            method_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The run's method rows in run order (the F screen's list).
    pub async fn methods_for_run(&self, run_id: Uuid) -> Result<Vec<MethodRow>, AppError> {
        let rows = sqlx::query_as!(
            MethodRow,
            r#"SELECT id as "id: Uuid", run_id as "run_id: Uuid", method_id, label,
                      version, "group",
                      state, reason_code, reason_detail, phase, bytes_downloaded,
                      bytes_total, job_id as "job_id?: Uuid", env_base_digest,
                      env_layer_digest, model_out_digest, model_dir,
                      exit_code as "exit_code?: i32", duration_ms, elapsed_secs, prob_source,
                      coverage_scored, coverage_eligible, task,
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      trained_on_patients, size_bytes, own_auc
               FROM txr_run_methods
               WHERE run_id = $1
               ORDER BY rowid"#,
            run_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows)
    }

    /// One state-machine step: state + reason + phase + counters + env facts +
    /// result facts + coverage, COALESCE'd (untouched columns keep their
    /// value). `job_id = COALESCE($…, job_id)` lets the E download phase
    /// record the admitted jobs row without disturbing the rest.
    #[allow(clippy::too_many_arguments)]
    pub async fn patch_method(
        &self,
        run_id: Uuid,
        method_id: &str,
        patch: &MethodPatch,
    ) -> Result<MethodRow, AppError> {
        let state = patch.state.map(|s| s.as_str());
        let reason_code: Option<String> = match &patch.reason {
            Some(r) => Some(r.code.clone()),
            None => patch.reason_code.map(|c| c.as_str().to_string()),
        };
        let reason_detail: Option<String> = match &patch.reason {
            Some(r) => Some(r.detail.clone()),
            None => patch.reason_detail.clone(),
        };
        let reason_code = reason_code.as_deref();
        let reason_detail = reason_detail.as_deref();
        let phase = patch.phase.map(|p| p.as_str());
        let prob_source = patch.prob_source.map(|p| p.as_str());
        let task = patch.task.map(|t| t.as_str());
        let bytes_downloaded = patch.bytes_downloaded.map(|v| v as i64);
        let bytes_total = patch.bytes_total.map(|v| v as i64);
        let duration_ms = patch.duration_ms.map(|v| v as i64);
        let elapsed_secs = patch.elapsed_secs.map(|v| v as i64);
        let coverage_scored = patch.coverage_scored.map(|v| v as i64);
        let coverage_eligible = patch.coverage_eligible.map(|v| v as i64);
        let trained_on_patients = patch.trained_on_patients.map(|v| v as i64);
        let size_bytes = patch.size_bytes.map(|v| v as i64);
        let env_base_digest = patch.env_base_digest.as_deref();
        let env_layer_digest = patch.env_layer_digest.as_deref();
        let model_out_digest = patch.model_out_digest.as_deref();
        let model_dir = patch.model_dir.as_deref();
        sqlx::query_as!(
            MethodRow,
            r#"UPDATE txr_run_methods SET
                 state = COALESCE($3, state),
                 reason_code = COALESCE($4, reason_code),
                 reason_detail = COALESCE($5, reason_detail),
                 phase = COALESCE($6, phase),
                 bytes_downloaded = COALESCE($7, bytes_downloaded),
                 bytes_total = COALESCE($8, bytes_total),
                 job_id = COALESCE($9, job_id),
                 env_base_digest = COALESCE($10, env_base_digest),
                 env_layer_digest = COALESCE($11, env_layer_digest),
                 model_out_digest = COALESCE($12, model_out_digest),
                 model_dir = COALESCE($13, model_dir),
                 exit_code = COALESCE($14, exit_code),
                 duration_ms = COALESCE($15, duration_ms),
                 elapsed_secs = COALESCE($16, elapsed_secs),
                 prob_source = COALESCE($17, prob_source),
                 coverage_scored = COALESCE($18, coverage_scored),
                 coverage_eligible = COALESCE($19, coverage_eligible),
                 task = COALESCE($20, task),
                 started_at = COALESCE($21, started_at),
                 finished_at = COALESCE($22, finished_at),
                 trained_on_patients = COALESCE($23, trained_on_patients),
                 size_bytes = COALESCE($24, size_bytes),
                 own_auc = COALESCE($25, own_auc)
               WHERE run_id = $1 AND method_id = $2
               RETURNING id as "id: Uuid", run_id as "run_id: Uuid", method_id, label,
                         version, "group",
                         state, reason_code, reason_detail, phase, bytes_downloaded,
                         bytes_total, job_id as "job_id?: Uuid", env_base_digest,
                         env_layer_digest, model_out_digest, model_dir,
                         exit_code as "exit_code?: i32", duration_ms, elapsed_secs, prob_source,
                         coverage_scored, coverage_eligible, task,
                         started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         trained_on_patients, size_bytes, own_auc"#,
            run_id,
            method_id,
            state,
            reason_code,
            reason_detail,
            phase,
            bytes_downloaded,
            bytes_total,
            patch.job_id,
            env_base_digest,
            env_layer_digest,
            model_out_digest,
            model_dir,
            patch.exit_code,
            duration_ms,
            elapsed_secs,
            prob_source,
            coverage_scored,
            coverage_eligible,
            task,
            patch.started_at,
            patch.finished_at,
            trained_on_patients,
            size_bytes,
            patch.own_auc,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?
        .ok_or_else(|| {
            AppError::database_error(format!(
                "no method row for run {run_id} / method {method_id}"
            ))
        })
    }

    /// The per-state aggregate counts (the F header's
    /// done/running/downloading/waiting line — ONE query).
    pub async fn method_counts(&self, run_id: Uuid) -> Result<TxrRunCounts, AppError> {
        method_counts_on(&self.pool, run_id).await
    }

    // ── logs ────────────────────────────────────────────────────────────────

    /// Append one engine- or method line. Returns the allocated `seq` (the
    /// run's next global sequence number) after the cap trim.
    pub async fn append_log(
        &self,
        run_id: Uuid,
        method_id: Option<&str>,
        stream: TxrLogStream,
        content: &str,
    ) -> Result<u64, AppError> {
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;
        let seq = append_log_in_tx(&mut tx, run_id, method_id, stream, content).await?;
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(seq)
    }

    /// Append a batch of lines in ONE transaction (ITEM-9's live wrapper
    /// stdout/stderr chunks — the pane streams, the rows land atomically).
    /// Returns the seqs in input order.
    pub async fn append_logs(
        &self,
        run_id: Uuid,
        lines: &[(Option<String>, TxrLogStream, String)],
    ) -> Result<Vec<u64>, AppError> {
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;
        let mut seqs = Vec::with_capacity(lines.len());
        for (method_id, stream, content) in lines {
            seqs.push(
                append_log_in_tx(&mut tx, run_id, method_id.as_deref(), *stream, content).await?,
            );
        }
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(seqs)
    }

    /// The log page (PROV-EE-5): `after_seq` = 0 means "from the start";
    /// `method_id` = the per-method pane (engine lines carry NULL — they never
    /// match). Returns the lines, the filtered total and the next seq to poll
    /// from (`last_seq + 1`, or the caller's `after_seq` when the page is
    /// empty — "nothing new since").
    pub async fn logs_page(
        &self,
        run_id: Uuid,
        method_id: Option<&str>,
        after_seq: u64,
        limit: u32,
    ) -> Result<(Vec<LogRow>, u64, u64), AppError> {
        let after = after_seq as i64;
        let limit = limit as i64;
        let (lines, total) = match method_id {
            Some(mid) => {
                let lines = sqlx::query_as!(
                    LogRow,
                    r#"SELECT id as "id: Uuid", run_id as "run_id: Uuid", seq,
                              method_id, stream, content,
                              created_at as "created_at: DateTime<Utc>"
                       FROM txr_run_logs
                       WHERE run_id = $1 AND method_id = $2 AND seq > $3
                       ORDER BY seq ASC
                       LIMIT $4"#,
                    run_id,
                    mid,
                    after,
                    limit,
                )
                .fetch_all(&self.pool)
                .await
                .map_err(AppError::database_error)?;
                let total = sqlx::query_scalar!(
                    r#"SELECT COUNT(*) FROM txr_run_logs
                       WHERE run_id = $1 AND method_id = $2"#,
                    run_id,
                    mid,
                )
                .fetch_one(&self.pool)
                .await
                .map_err(AppError::database_error)?;
                (lines, total)
            }
            None => {
                let lines = sqlx::query_as!(
                    LogRow,
                    r#"SELECT id as "id: Uuid", run_id as "run_id: Uuid", seq,
                              method_id, stream, content,
                              created_at as "created_at: DateTime<Utc>"
                       FROM txr_run_logs
                       WHERE run_id = $1 AND seq > $2
                       ORDER BY seq ASC
                       LIMIT $3"#,
                    run_id,
                    after,
                    limit,
                )
                .fetch_all(&self.pool)
                .await
                .map_err(AppError::database_error)?;
                let total = sqlx::query_scalar!(
                    "SELECT COUNT(*) FROM txr_run_logs WHERE run_id = $1",
                    run_id,
                )
                .fetch_one(&self.pool)
                .await
                .map_err(AppError::database_error)?;
                (lines, total)
            }
        };
        let next_seq = lines.last().map(|l| l.seq as u64 + 1).unwrap_or(after_seq);
        Ok((lines, total as u64, next_seq))
    }

    /// The run's log total (the detail's `log_lines` fact).
    pub async fn log_total(&self, run_id: Uuid) -> Result<u64, AppError> {
        let n = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM txr_run_logs WHERE run_id = $1",
            run_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(n as u64)
    }

    // ── analysis-config singleton (PROV-EE-8) ───────────────────────────────

    /// The sticky E-screen config (`None` = never configured — the honest
    /// `config: null` answer).
    pub async fn get_analysis_config(&self) -> Result<Option<TxrAppConfig>, AppError> {
        // `config?:` — the cell is nullable (a PUT with `config: null` stores
        // SQL NULL); the OUTER Option is the row's presence. `Value::Null`
        // (a stored JSON null) is the same honest never-configured answer.
        let cell: Option<Option<Json>> = sqlx::query_scalar!(
            r#"SELECT config as "config?: serde_json::Value" FROM txr_app_config WHERE id = 1"#
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        match cell {
            Some(Some(v)) if v.is_null() => Ok(None),
            Some(Some(v)) => Ok(Some(json_parse(&v, "txr_app_config.config")?)),
            Some(None) | None => Ok(None),
        }
    }

    /// Upsert the singleton (id = 1; the schema's CHECK pins the row).
    pub async fn put_analysis_config(&self, config: &TxrAppConfig) -> Result<(), AppError> {
        let cell = json_value(config, "TxrAppConfig")?;
        sqlx::query!(
            r#"INSERT INTO txr_app_config (id, config, updated_at)
               VALUES (1, $1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               ON CONFLICT(id) DO UPDATE SET
                 config = excluded.config,
                 updated_at = excluded.updated_at"#,
            cell,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }
}

/// The aggregate per-method counts query, usable on a pool OR a transaction
/// connection (the reconciler recomputes the JSON counts inside its per-run
/// transaction with the SAME statement the repository serves — no drift).
pub(crate) async fn method_counts_on<'e, E>(
    executor: E,
    run_id: Uuid,
) -> Result<TxrRunCounts, AppError>
where
    E: sqlx::SqliteExecutor<'e>,
{
    let row = sqlx::query!(
        r#"SELECT
             COALESCE(SUM(CASE WHEN state = 'finished' THEN 1 ELSE 0 END), 0) AS "finished: i64",
             COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS "failed: i64",
             COALESCE(SUM(CASE WHEN state = 'stopped' THEN 1 ELSE 0 END), 0) AS "stopped: i64",
             COALESCE(SUM(CASE WHEN state = 'skipped' THEN 1 ELSE 0 END), 0) AS "skipped: i64",
             COALESCE(SUM(CASE WHEN state = 'cannot_run' THEN 1 ELSE 0 END), 0) AS "cannot_run: i64",
             COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS "running: i64",
             COALESCE(SUM(CASE WHEN state = 'downloading' THEN 1 ELSE 0 END), 0) AS "downloading: i64",
             COALESCE(SUM(CASE WHEN state = 'waiting' THEN 1 ELSE 0 END), 0) AS "waiting: i64"
           FROM txr_run_methods WHERE run_id = $1"#,
        run_id,
    )
    .fetch_one(executor)
    .await
    .map_err(AppError::database_error)?;
    Ok(TxrRunCounts {
        finished: row.finished as u32,
        failed: row.failed as u32,
        stopped: row.stopped as u32,
        skipped: row.skipped as u32,
        cannot_run: row.cannot_run as u32,
        running: row.running as u32,
        downloading: row.downloading as u32,
        waiting: row.waiting as u32,
    })
}

/// One log append inside a caller's transaction: seq allocation
/// (`COALESCE(MAX(seq),0)+1` INSIDE the insert — the write lock serializes
/// concurrent appenders) + the oldest-trim past
/// [`TxrLimits::MAX_LOG_LINES_PER_RUN`] (DEC-13). Returns the seq.
pub(crate) async fn append_log_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: Uuid,
    method_id: Option<&str>,
    stream: TxrLogStream,
    content: &str,
) -> Result<u64, AppError> {
    let line_id = Uuid::new_v4();
    let stream = stream.as_str();
    let inserted = sqlx::query!(
        r#"INSERT INTO txr_run_logs (id, run_id, seq, method_id, stream, content)
           SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5
           FROM txr_run_logs WHERE run_id = $2
           RETURNING seq"#,
        line_id,
        run_id,
        method_id,
        stream,
        content,
    )
    .fetch_one(&mut **tx)
    .await
    .map_err(AppError::database_error)?;
    let seq = inserted.seq;
    let cap = super::types::TxrLimits::MAX_LOG_LINES_PER_RUN as i64;
    sqlx::query!(
        r#"DELETE FROM txr_run_logs
           WHERE run_id = $1
             AND seq <= (SELECT MAX(seq) - $2 FROM txr_run_logs WHERE run_id = $1)"#,
        run_id,
        cap,
    )
    .execute(&mut **tx)
    .await
    .map_err(AppError::database_error)?;
    Ok(seq as u64)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-9: the produced-model seam `model-store` binds to
// ─────────────────────────────────────────────────────────────────────────────

/// The produced-model surface (PROV-EE-9): the run's method rows that
/// completed X1 with a `/model` tree, as the wire records. A row is exposed
/// only when the record is COMPLETE — `model_out_digest` + `model_dir` + both
/// env digests + `trained_on_patients` + `size_bytes` (a half-written record
/// from an interrupted finalize is never presented as a saved artifact;
/// `own_auc` is optional by contract — null when the outcome/data does not
/// allow the cross-check).
pub async fn produced_models(
    pool: &SqlitePool,
    run_id: Uuid,
) -> Result<Vec<TxrProducedModel>, AppError> {
    let rows = sqlx::query_as!(
        MethodRow,
        r#"SELECT id as "id: Uuid", run_id as "run_id: Uuid", method_id, label,
                  version, "group",
                  state, reason_code, reason_detail, phase, bytes_downloaded,
                  bytes_total, job_id as "job_id?: Uuid", env_base_digest,
                  env_layer_digest, model_out_digest, model_dir,
                  exit_code as "exit_code?: i32", duration_ms, elapsed_secs, prob_source,
                  coverage_scored, coverage_eligible, task,
                  started_at as "started_at?: DateTime<Utc>",
                  finished_at as "finished_at?: DateTime<Utc>",
                  trained_on_patients, size_bytes, own_auc
           FROM txr_run_methods
           WHERE run_id = $1
             AND model_out_digest IS NOT NULL
             AND model_dir IS NOT NULL
             AND env_base_digest IS NOT NULL
             AND env_layer_digest IS NOT NULL
             AND trained_on_patients IS NOT NULL
             AND size_bytes IS NOT NULL
           ORDER BY method_id"#,
        run_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let digest = r.model_out_digest.expect("filtered NOT NULL");
        let env = TxrMethodEnv {
            base_digest: r.env_base_digest.expect("filtered NOT NULL"),
            layer_digest: r.env_layer_digest.expect("filtered NOT NULL"),
        };
        out.push(TxrProducedModel {
            method_id: r.method_id,
            method_version: r.version,
            model_out_digest: digest.clone(),
            // The same value — the model-store bind key (PROV-EE-9).
            tree_sha256: digest,
            dir: r.model_dir.expect("filtered NOT NULL"),
            env,
            trained_on_patients: r.trained_on_patients.expect("filtered NOT NULL") as u32,
            size_bytes: r.size_bytes.expect("filtered NOT NULL") as u64,
            own_auc: r.own_auc,
        });
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod test_support {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    /// A fresh in-memory pool with the module's OWN migration chain applied
    /// (the five module files — the unit half of the engine's schema; the
    /// full merged chain is the integration harness's template DB). The pool
    /// keeps ONE connection so the in-memory database (not the pool) is the
    /// store, and `foreign_keys` is on like the app pool
    /// (PROV-sqlite-store-1) so the ON DELETE CASCADE seams are exercised.
    pub async fn module_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory pool connects");
        sqlx::query!("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("foreign keys on");
        static MIGRATOR: sqlx::migrate::Migrator =
            sqlx::migrate!("src/modules/execution_engine/migrations");
        MIGRATOR.run(&pool).await.expect("module migrations apply");
        pool
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::module_pool;
    use super::*;
    use crate::modules::execution_engine::types::{
        TxrLastInputSummary, TxrLimits, TxrRunFileNames,
    };

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

    fn sample_counts() -> TxrRunCounts {
        TxrRunCounts {
            finished: 0,
            failed: 0,
            stopped: 0,
            skipped: 0,
            cannot_run: 0,
            running: 0,
            downloading: 0,
            waiting: 3,
        }
    }

    fn sample_new_run(created_at: Option<DateTime<Utc>>) -> NewRun {
        NewRun {
            id: Uuid::new_v4(),
            created_at,
            status: TxrRunStatus::Preparing,
            mode: TxrRunMode::Train,
            config: RunConfig::default(),
            input_summary: sample_input_summary(),
            model_ids: vec![],
            method_count: 3,
            counts: sample_counts(),
            dir: "/app-data/analysis-2026-10-21-1002-abcd1234".to_string(),
            memory_total_bytes: Some(16 * 1024 * 1024 * 1024),
            cpus: Some(4),
            seed: 1,
            estimate: None,
        }
    }

    fn sample_new_method(run_id: Uuid, method_id: &str, state: TxrMethodState) -> NewMethod {
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

    /// ITEM-7: the run row round-trips every JSON column as the wire type —
    /// `config`, `input_summary` (WITH `file_names` — reconcile GAP-HS-1),
    /// `counts`, and `model_ids` (`[]` for the NULL train-mode cell).
    #[tokio::test]
    async fn run_row_round_trips_the_json_columns() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let new = sample_new_run(None);

        repo.insert_run(&new).await.expect("insert");
        let row = repo.get_run(new.id).await.expect("get").expect("exists");
        let summary = row.summarize(Vec::new()).expect("summarize");

        assert_eq!(summary.id, new.id);
        assert_eq!(summary.status, TxrRunStatus::Preparing);
        assert_eq!(summary.mode, TxrRunMode::Train);
        assert_eq!(summary.config, new.config);
        assert_eq!(summary.input_summary.patients, Some(151));
        assert_eq!(summary.input_summary.predict_patients, Some(38));
        assert_eq!(summary.input_summary.markers, 5);
        assert_eq!(
            summary.input_summary.file_names.patients.as_deref(),
            Some("patients.csv")
        );
        assert_eq!(
            summary.input_summary.file_names.measurements,
            "measurements.csv"
        );
        assert_eq!(
            summary
                .input_summary
                .file_names
                .predict_measurements
                .as_deref(),
            Some("new_measurements.csv")
        );
        assert_eq!(summary.model_ids, Vec::<String>::new());
        assert_eq!(summary.counts.waiting, 3);
        assert_eq!(summary.counts.finished, 0);
        assert_eq!(summary.dir, new.dir);
        // The ROW carries the detail's machine facts (memory + cpus are the
        // detail lines, not the History summary).
        assert_eq!(row.memory_total_bytes, Some(16 * 1024 * 1024 * 1024));
        assert_eq!(row.cpus, Some(4));
        assert_eq!(
            row.created_at
                .signed_duration_since(Utc::now())
                .num_seconds(),
            0,
            "created_at defaults to now at insert"
        );
    }

    /// ITEM-7: a reuse-mode run round-trips its resolved `model_ids` JSON
    /// array (reconcile GAP-HS-3).
    #[tokio::test]
    async fn reuse_run_round_trips_model_ids() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let mut new = sample_new_run(None);
        new.mode = TxrRunMode::Reuse;
        new.model_ids = vec!["model-1".to_string(), "model-2".to_string()];

        repo.insert_run(&new).await.expect("insert");
        let row = repo.get_run(new.id).await.expect("get").expect("exists");
        assert_eq!(
            row.summarize(Vec::new()).expect("summarize").model_ids,
            new.model_ids
        );
    }

    /// ITEM-7: the History list is newest-first, paged, with the total
    /// (PROV-EE-3 / DEC-21).
    #[tokio::test]
    async fn list_runs_is_newest_first_paged_with_total() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let t0 = DateTime::<Utc>::from_timestamp(1_700_000_000, 0).expect("valid ts");

        let mut a = sample_new_run(Some(t0));
        let mut b = sample_new_run(Some(t0 + chrono::Duration::seconds(60)));
        let mut c = sample_new_run(Some(t0 + chrono::Duration::seconds(120)));
        a.dir = "analysis-a".into();
        b.dir = "analysis-b".into();
        c.dir = "analysis-c".into();
        for new in [&a, &b, &c] {
            repo.insert_run(new).await.expect("insert");
        }

        let (page, total) = repo.list_runs(10, 0).await.expect("page");
        assert_eq!(total, 3);
        let dirs: Vec<&str> = page.iter().map(|r| r.dir.as_str()).collect();
        assert_eq!(dirs, vec!["analysis-c", "analysis-b", "analysis-a"]);

        let (page2, total2) = repo.list_runs(2, 1).await.expect("page 2");
        assert_eq!(total2, 3);
        let dirs2: Vec<&str> = page2.iter().map(|r| r.dir.as_str()).collect();
        assert_eq!(dirs2, vec!["analysis-b", "analysis-a"]);
    }

    /// ITEM-7: the summary assembly (get_run_summary + list_run_summaries)
    /// carries the run's `method_ids` from the method rows — the page is one
    /// JSON-membership query over a 200-row page, never N+1 (CONS-EE-3).
    #[tokio::test]
    async fn summaries_carry_method_ids() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let a = sample_new_run(Some(
            DateTime::<Utc>::from_timestamp(1_700_000_100, 0).expect("ts"),
        ));
        let b = sample_new_run(Some(
            DateTime::<Utc>::from_timestamp(1_700_000_200, 0).expect("ts"),
        ));
        repo.insert_run(&a).await.expect("run a");
        repo.insert_run(&b).await.expect("run b");
        repo.insert_method(&sample_new_method(a.id, "m1", TxrMethodState::Waiting))
            .await
            .expect("m1");
        repo.insert_method(&sample_new_method(a.id, "m2", TxrMethodState::Waiting))
            .await
            .expect("m2");
        repo.insert_method(&sample_new_method(b.id, "m3", TxrMethodState::Waiting))
            .await
            .expect("m3");

        let one = repo
            .get_run_summary(a.id)
            .await
            .expect("summary")
            .expect("a");
        assert_eq!(one.method_ids, vec!["m1".to_string(), "m2".to_string()]);
        assert_eq!(one.status, TxrRunStatus::Preparing);

        let (page, total) = repo.list_run_summaries(10, 0).await.expect("page");
        assert_eq!(total, 2);
        assert_eq!(page[0].id, b.id, "newest-first");
        assert_eq!(page[0].method_ids, vec!["m3".to_string()]);
        assert_eq!(page[1].id, a.id);
        assert_eq!(page[1].method_ids.len(), 2);

        let (empty, total2) = repo.list_run_summaries(10, 5).await.expect("past end");
        assert!(empty.is_empty());
        assert_eq!(total2, 2);
    }

    /// ITEM-7: the method rows insert under the run + the aggregate counts
    /// query sums exactly the eight states (the F header's counters).
    #[tokio::test]
    async fn method_rows_aggregate_into_the_counts() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");

        repo.insert_method(&sample_new_method(
            run.id,
            "done-m",
            TxrMethodState::Finished,
        ))
        .await
        .expect("m1");
        repo.insert_method(&sample_new_method(run.id, "fail-m", TxrMethodState::Failed))
            .await
            .expect("m2");
        repo.insert_method(&sample_new_method(
            run.id,
            "wait-m",
            TxrMethodState::Waiting,
        ))
        .await
        .expect("m3");
        repo.insert_method(&sample_new_method(
            run.id,
            "down-m",
            TxrMethodState::Downloading,
        ))
        .await
        .expect("m4");
        repo.insert_method(&sample_new_method(
            run.id,
            "cant-m",
            TxrMethodState::CannotRun,
        ))
        .await
        .expect("m5");

        let counts = repo.method_counts(run.id).await.expect("counts");
        assert_eq!(counts.finished, 1);
        assert_eq!(counts.failed, 1);
        assert_eq!(counts.downloading, 1);
        assert_eq!(counts.waiting, 1);
        assert_eq!(counts.cannot_run, 1);
        assert_eq!(counts.running, 0);
        assert_eq!(counts.stopped, 0);
        assert_eq!(counts.skipped, 0);

        // UNIQUE(run_id, method_id) is the one-method-per-stack pin (INV-2).
        let dup = repo
            .insert_method(&sample_new_method(
                run.id,
                "wait-m",
                TxrMethodState::Waiting,
            ))
            .await;
        assert!(
            dup.is_err(),
            "a method may never be inserted twice for a run"
        );

        // methods_for_run returns them in insertion order.
        let rows = repo.methods_for_run(run.id).await.expect("rows");
        let ids: Vec<&str> = rows.iter().map(|r| r.method_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["done-m", "fail-m", "wait-m", "down-m", "cant-m"],
            "insertion order (the F screen's list order)"
        );
    }

    /// ITEM-7: `patch_method` is one state-machine step — `state` writes, the
    /// untouched columns keep their values, the touched columns update, and
    /// the return is the new row.
    #[tokio::test]
    async fn patch_method_writes_state_and_patched_fields_only() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");
        repo.insert_method(&sample_new_method(run.id, "m", TxrMethodState::Waiting))
            .await
            .expect("m");

        let patch = MethodPatch {
            state: Some(TxrMethodState::Downloading),
            bytes_downloaded: Some(160),
            bytes_total: Some(250),
            phase: Some(TxrPhase::Env),
            ..MethodPatch::default()
        };
        let row = repo.patch_method(run.id, "m", &patch).await.expect("patch");
        assert_eq!(row.state().expect("state"), TxrMethodState::Downloading);
        assert_eq!(row.bytes_downloaded, 160);
        assert_eq!(row.bytes_total, Some(250));
        assert_eq!(
            row.phase.as_deref(),
            Some("env"),
            "the env phase was written"
        );
        assert_eq!(row.reason_code, None, "untouched reason stays NULL");

        let fail = MethodPatch::terminal(
            TxrMethodState::Failed,
            EngineReasonCode::JobTimeout,
            "the method exceeded the wall-clock budget",
            Utc::now(),
        );
        let row = repo
            .patch_method(run.id, "m", &fail)
            .await
            .expect("terminal");
        assert_eq!(row.state().expect("state"), TxrMethodState::Failed);
        assert_eq!(
            row.reason_code.as_deref(),
            Some("JOB_TIMEOUT"),
            "the ENGINE code's verbatim spelling"
        );
        assert_eq!(
            row.reason().expect("reason").detail,
            "the method exceeded the wall-clock budget"
        );
        assert_eq!(
            row.bytes_downloaded, 160,
            "an earlier patch's column is NOT reset by a later patch"
        );
        assert!(row.finished_at.is_some());
    }

    /// ITEM-7: the method row converts to the wire row — coverage math,
    /// digest pair, task/prob source vocabulary, the catalogue group_label
    /// through the facts shim.
    #[tokio::test]
    async fn method_row_converts_to_the_wire_row() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");
        repo.insert_method(&sample_new_method(
            run.id,
            "dynforest",
            TxrMethodState::Finished,
        ))
        .await
        .expect("m");

        let row = repo
            .patch_method(
                run.id,
                "dynforest",
                &MethodPatch {
                    state: Some(TxrMethodState::Finished),
                    task: Some(TxrTask::Pfs),
                    prob_source: Some(TxrProbSource::Native),
                    coverage_scored: Some(120),
                    coverage_eligible: Some(151),
                    env_base_digest: Some("b".repeat(64)),
                    env_layer_digest: Some("c".repeat(64)),
                    elapsed_secs: Some(42),
                    ..MethodPatch::default()
                },
            )
            .await
            .expect("patch");

        let wire = row.into_method().expect("wire");
        assert_eq!(wire.method_id, "dynforest");
        assert_eq!(wire.task, Some(TxrTask::Pfs));
        assert_eq!(wire.prob_source, Some(TxrProbSource::Native));
        let coverage = wire.coverage.expect("coverage");
        assert_eq!((coverage.scored, coverage.eligible), (120, 151));
        assert!((coverage.fraction - 0.795).abs() < 1e-3);
        assert_eq!(wire.elapsed_secs, Some(42));
        assert_eq!(wire.bytes_downloaded, 0);
        assert_eq!(wire.env.expect("env").base_digest.len(), 64);
        // The catalogue fact fills the row's group_label (dynforest is a
        // real catalogue id — the fact is the fixture's own poster).
        assert!(!wire.group_label.is_empty());
    }

    /// ITEM-7: `progress_pct` is DERIVED at read (PROV-EE-10 has no column):
    /// the download ratio while the row is `downloading`, null outside that
    /// phase (the plan's "download phase only" spelling).
    #[tokio::test]
    async fn progress_pct_is_derived_at_read() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");
        repo.insert_method(&sample_new_method(run.id, "m", TxrMethodState::Downloading))
            .await
            .expect("m");

        let row = repo
            .patch_method(
                run.id,
                "m",
                &MethodPatch {
                    state: Some(TxrMethodState::Downloading),
                    bytes_downloaded: Some(160),
                    bytes_total: Some(250),
                    ..MethodPatch::default()
                },
            )
            .await
            .expect("download snap");
        let pct = row.into_method().expect("wire").progress_pct.expect("pct");
        assert!((pct - 64.0).abs() < 1e-9, "160 of 250 MB = 64%");

        let row = repo
            .patch_method(
                run.id,
                "m",
                &MethodPatch {
                    state: Some(TxrMethodState::Running),
                    ..MethodPatch::default()
                },
            )
            .await
            .expect("running");
        assert_eq!(
            row.into_method().expect("wire").progress_pct,
            None,
            "outside the download phase the derived value is null"
        );
    }

    /// ITEM-7: log seqs are allocated globally per run, start at 1, stay
    /// monotonic across appends, and the appends are paged by seq + method.
    #[tokio::test]
    async fn log_seq_allocation_and_paging() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");

        let s1 = repo
            .append_log(run.id, None, TxrLogStream::Engine, "starting")
            .await
            .expect("l1");
        let s2 = repo
            .append_log(run.id, Some("m"), TxrLogStream::Stdout, "out-1")
            .await
            .expect("l2");
        let s3 = repo
            .append_log(run.id, Some("m"), TxrLogStream::Stderr, "err-1")
            .await
            .expect("l3");
        assert_eq!((s1, s2, s3), (1, 2, 3), "one global seq per run, from 1");

        let (all, total, next) = repo.logs_page(run.id, None, 0, 10).await.expect("page");
        assert_eq!(total, 3);
        assert_eq!(next, 4);
        let seqs: Vec<u64> = all.iter().map(|l| l.seq as u64).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
        assert_eq!(all[0].method_id, None, "engine lines carry NULL");
        assert_eq!(all[0].stream, "engine");

        let (m_lines, m_total, _) = repo
            .logs_page(run.id, Some("m"), 0, 10)
            .await
            .expect("method page");
        assert_eq!(m_total, 2, "engine line never matches a method pane");
        assert_eq!(m_lines.len(), 2);

        let (since, since_total, next2) = repo
            .logs_page(run.id, None, 2, 10)
            .await
            .expect("after-seq page");
        assert_eq!(since.len(), 1);
        assert_eq!(since[0].seq, 3);
        assert_eq!(since_total, 3, "total is the filtered total, not the page");
        assert_eq!(next2, 4);

        let (empty, _, next3) = repo
            .logs_page(run.id, None, 3, 10)
            .await
            .expect("empty page");
        assert!(empty.is_empty());
        assert_eq!(next3, 3, "nothing new since after_seq");

        let batch = repo
            .append_logs(
                run.id,
                &[
                    (
                        Some("m".to_string()),
                        TxrLogStream::Stdout,
                        "out-2".to_string(),
                    ),
                    (None, TxrLogStream::Engine, "done in 3s".to_string()),
                ],
            )
            .await
            .expect("batch");
        assert_eq!(
            batch,
            vec![4, 5],
            "the batch allocates the next seqs in order"
        );
    }

    /// ITEM-7: the log cap trims the OLDEST rows — the newest
    /// `MAX_LOG_LINES_PER_RUN` survive, the seqs never renumber (Copy-the-log
    /// order stays deterministic + gap-tolerant).
    #[tokio::test]
    async fn log_cap_trims_the_oldest_rows_and_keeps_seq_monotonic() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");

        let cap = TxrLimits::MAX_LOG_LINES_PER_RUN;
        let over = cap + 5;
        let lines: Vec<(Option<String>, TxrLogStream, String)> = (0..over)
            .map(|i| (None, TxrLogStream::Engine, format!("line {i}")))
            .collect();
        let seqs = repo.append_logs(run.id, &lines).await.expect("bulk");
        assert_eq!(seqs.len(), over);
        assert_eq!(seqs[0], 1);
        assert_eq!(seqs[over - 1], over as u64);

        let (kept, total, _) = repo
            .logs_page(run.id, None, 0, 100_000)
            .await
            .expect("page");
        assert_eq!(total, cap as u64, "the cap bounds the run's log");
        assert_eq!(kept.len(), cap);
        assert_eq!(
            kept[0].seq,
            (over - cap + 1) as i64,
            "the oldest past the cap were trimmed"
        );
        assert_eq!(kept.last().expect("last").seq, over as i64);

        // The sequence keeps ADVANCING after the trim (MAX, not COUNT) — a
        // later line never collides with a trimmed one.
        let s = repo
            .append_log(run.id, None, TxrLogStream::Engine, "post-trim")
            .await
            .expect("post-trim");
        assert_eq!(s, over as u64 + 1);
    }

    /// ITEM-7: delete removes the run + cascades its method + log rows
    /// (204 semantics: false for an absent run), and clear-all returns the
    /// count.
    #[tokio::test]
    async fn delete_cascades_and_reports_existence() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");
        repo.insert_method(&sample_new_method(run.id, "m", TxrMethodState::Waiting))
            .await
            .expect("m");
        repo.append_log(run.id, None, TxrLogStream::Engine, "line")
            .await
            .expect("log");

        assert!(repo.delete_run(run.id).await.expect("delete"));
        assert!(repo.get_run(run.id).await.expect("get").is_none());
        assert!(repo
            .methods_for_run(run.id)
            .await
            .expect("methods")
            .is_empty());
        assert_eq!(repo.log_total(run.id).await.expect("logs"), 0);
        assert!(
            !repo.delete_run(run.id).await.expect("second delete"),
            "an absent run is not deleted (404 at the routes)"
        );

        let run2 = sample_new_run(None);
        repo.insert_run(&run2).await.expect("run2");
        assert_eq!(repo.delete_all_runs().await.expect("clear"), 1);
    }

    /// ITEM-7: the analysis-config singleton upserts (the PUT-then-GET
    /// round-trip of PROV-EE-8; the second PUT overwrites, never duplicates).
    #[tokio::test]
    async fn analysis_config_singleton_upserts() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        assert!(
            repo.get_analysis_config().await.expect("empty").is_none(),
            "never PUT yet → null is the honest answer"
        );

        let first = TxrAppConfig {
            config: Some(RunConfig::default()),
            last_input_summary: None,
        };
        repo.put_analysis_config(&first).await.expect("put 1");
        let got = repo
            .get_analysis_config()
            .await
            .expect("get")
            .expect("some");
        assert_eq!(got.config, Some(RunConfig::default()));

        let second = TxrAppConfig {
            config: None,
            last_input_summary: Some(TxrLastInputSummary {
                patients: Some(151),
                predict_patients: Some(38),
                markers: 5,
            }),
        };
        repo.put_analysis_config(&second).await.expect("put 2");
        let got = repo
            .get_analysis_config()
            .await
            .expect("get 2")
            .expect("some");
        assert_eq!(got.config, None, "the row is ONE (upsert, not append)");
        assert_eq!(got.last_input_summary.expect("summary").patients, Some(151));
        assert_eq!(repo.log_total(Uuid::new_v4()).await.expect("other run"), 0);
    }

    /// ITEM-7 + PROV-EE-9: the produced-models seam returns exactly the
    /// complete model records — method rows without the produced facts are
    /// not artifacts; `tree_sha256` mirrors `model_out_digest`; the env pair +
    /// size + cohort + own_auc are carried.
    #[tokio::test]
    async fn produced_models_seam_returns_complete_records_only() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");

        // A fully-recorded model.
        repo.insert_method(&sample_new_method(
            run.id,
            "saved-m",
            TxrMethodState::Finished,
        ))
        .await
        .expect("saved-m");
        repo.patch_method(
            run.id,
            "saved-m",
            &MethodPatch {
                state: Some(TxrMethodState::Finished),
                model_out_digest: Some("a1".repeat(32)),
                model_dir: Some("/app-data/run/models/saved-m".to_string()),
                env_base_digest: Some("b".repeat(64)),
                env_layer_digest: Some("c".repeat(64)),
                trained_on_patients: Some(151),
                size_bytes: Some(3_000),
                own_auc: Some(0.71),
                ..MethodPatch::default()
            },
        )
        .await
        .expect("model facts");

        // A method that FAILED before the model record was complete.
        repo.insert_method(&sample_new_method(run.id, "half-m", TxrMethodState::Failed))
            .await
            .expect("half-m");
        repo.patch_method(
            run.id,
            "half-m",
            &MethodPatch {
                state: Some(TxrMethodState::Failed),
                model_out_digest: Some("d".repeat(64)),
                model_dir: Some("/data/half".to_string()),
                reason_code: Some(EngineReasonCode::Interrupted),
                ..MethodPatch::default()
            },
        )
        .await
        .expect("partial facts");

        // A finished method with NO model output.
        repo.insert_method(&sample_new_method(
            run.id,
            "no-model",
            TxrMethodState::Finished,
        ))
        .await
        .expect("no-model");

        let models = produced_models(repo.pool(), run.id).await.expect("seam");
        assert_eq!(models.len(), 1, "only the complete record is exposed");
        let m = &models[0];
        assert_eq!(m.method_id, "saved-m");
        assert_eq!(m.method_version, "2.0.1");
        assert_eq!(m.tree_sha256, m.model_out_digest, "one value, two names");
        assert_eq!(m.dir, "/app-data/run/models/saved-m");
        assert_eq!(m.env.layer_digest, "c".repeat(64));
        assert_eq!(m.trained_on_patients, 151);
        assert_eq!(m.size_bytes, 3_000);
        assert_eq!(m.own_auc, Some(0.71));
    }

    /// ITEM-7: `get_method` resolves one row; the aggregate counts query is
    /// EMPTY-consistent (all zeros) for a run whose methods never landed.
    #[tokio::test]
    async fn empty_run_counts_and_method_lookup() {
        let pool = module_pool().await;
        let repo = TxrRepository::new(pool);
        let run = sample_new_run(None);
        repo.insert_run(&run).await.expect("run");

        let counts = repo.method_counts(run.id).await.expect("counts");
        assert_eq!(counts.finished, 0);
        assert_eq!(counts.waiting, 0);

        assert!(repo
            .get_method(run.id, "nope")
            .await
            .expect("lookup")
            .is_none());
    }
}
