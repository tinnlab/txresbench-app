//! `job_settings` singleton persistence (concurrency cap + reserved interactive
//! slots).
//!
//! Mirrors ziee-auth's `SessionSettingsRepository`: a single `id = TRUE` row,
//! partial COALESCE update, read-at-use (the scheduler reads it every tick, with
//! a safe fallback on DB error so the hot path never breaks). Compile-time
//! `query_as!` macros (SDK gap G4 resolved).
//!
//! SQLite driver (sqlite-store DEC-1): the INTEGER-affinity columns keep their
//! Rust field types spelled out (`max_concurrent_jobs as "…: i32"` — the sqlite
//! macro infers INTEGER as `i64`), and the write clock is the canonical
//! `now()` → `strftime('%Y-%m-%dT%H:%M:%fZ','now')` rewrite. `id = TRUE` is
//! legal SQLite 3.46 (TRUE is the integer 1) and is kept verbatim.

use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::models::{JobSettings, UpdateJobSettingsRequest};
use super::scheduler::ReaperLimits;

/// The safe default concurrency if the settings row can't be read.
pub const DEFAULT_MAX_CONCURRENT: i32 = 2;
/// Inclusive bounds for `max_concurrent_jobs` (matches the DB CHECK).
pub const MIN_MAX_CONCURRENT: i32 = 1;
pub const MAX_MAX_CONCURRENT: i32 = 64;
/// The safe default reserved interactive slots if the row can't be read.
pub const DEFAULT_RESERVED_INTERACTIVE: i32 = 1;
/// The safe default per-tenant concurrency cap if the settings row can't be read (T4 §6).
pub const DEFAULT_PER_TENANT_MAX_CONCURRENT: i32 = 2;
/// Inclusive bounds for `per_tenant_max_concurrent` (matches the DB CHECK).
pub const MIN_PER_TENANT_MAX_CONCURRENT: i32 = 1;
pub const MAX_PER_TENANT_MAX_CONCURRENT: i32 = 64;

// ── SSE + admission knobs (#54). Defaults EXACTLY equal the compiled constants
// they replace, so a never-PUT deployment is byte-identical (INV-1). Bounds are the
// guardrails (DEC-3): an admin must not be able to set a hang or an OOM.

/// SSE heartbeat interval, seconds. Default == the axum `KeepAlive::default()` (15s).
pub const DEFAULT_SSE_KEEP_ALIVE_SECS: i64 = 15;
pub const MIN_SSE_KEEP_ALIVE_SECS: i64 = 1;
pub const MAX_SSE_KEEP_ALIVE_SECS: i64 = 300;
/// Global per-job SSE subscriber cap. Default == `runtime::MAX_SSE_CLIENTS` (256).
pub const DEFAULT_SSE_MAX_CLIENTS: i32 = 256;
pub const MIN_SSE_MAX_CLIENTS: i32 = 1;
pub const MAX_SSE_MAX_CLIENTS: i32 = 4096;
/// Detached-admit wait budget, seconds. Default == `admission::ADMISSION_WAIT` (15s).
pub const DEFAULT_ADMISSION_WAIT_SECS: i64 = 15;
pub const MIN_ADMISSION_WAIT_SECS: i64 = 1;
pub const MAX_ADMISSION_WAIT_SECS: i64 = 60;
/// Admit poll interval, ms. Default == `admission::ADMISSION_POLL` (250ms).
pub const DEFAULT_ADMISSION_POLL_MS: i64 = 250;
pub const MIN_ADMISSION_POLL_MS: i64 = 10;
pub const MAX_ADMISSION_POLL_MS: i64 = 10_000;

// ── Scheduler/reaper timing knobs (#56). Defaults EXACTLY equal the compiled
// `scheduler::ReaperLimits::default()` + the two inline tick literals, so a never-PUT
// deployment is byte-identical (INV-5). Bounds are guardrails (DEC-2/DEC-3).

/// Worker heartbeat cadence, seconds. Default == `ReaperLimits::default().heartbeat` (10s).
pub const DEFAULT_HEARTBEAT_SECS: i64 = 10;
pub const MIN_HEARTBEAT_SECS: i64 = 1;
pub const MAX_HEARTBEAT_SECS: i64 = 60;
/// Reaper sweep cadence, seconds. Default == `ReaperLimits::default().reaper_tick` (15s).
pub const DEFAULT_REAPER_TICK_SECS: i64 = 15;
pub const MIN_REAPER_TICK_SECS: i64 = 1;
pub const MAX_REAPER_TICK_SECS: i64 = 300;
/// Stale-reclaim threshold, seconds. Default == `ReaperLimits::default().stale_threshold` (45s).
pub const DEFAULT_STALE_THRESHOLD_SECS: i64 = 45;
pub const MIN_STALE_THRESHOLD_SECS: i64 = 5;
pub const MAX_STALE_THRESHOLD_SECS: i64 = 3600;
/// The reaper safety guardrail (INV-4 / DEC-3): the stale threshold must be at least this many
/// heartbeat intervals, so a still-live worker (which beats every `heartbeat_secs`) is NEVER
/// reclaimed. The compiled default is 4.5×; 3× is the conservative hard floor.
///
/// This value is duplicated as the literal `3` in the migration's
/// `job_settings_stale_threshold_bounds` DB CHECK — the two MUST stay in sync (the CHECK is the
/// DB twin of this const). Changing one without the other lets a value pass one layer and fail
/// the other.
pub const STALE_HEARTBEAT_MULTIPLE: i64 = 3;
/// Poison-job discard-at-max. Default == `ReaperLimits::default().max_reclaims` (5).
pub const DEFAULT_MAX_RECLAIMS: i32 = 5;
pub const MIN_MAX_RECLAIMS: i32 = 1;
pub const MAX_MAX_RECLAIMS: i32 = 100;
/// Bounded reclaim/discard batch per sweep. Default == `ReaperLimits::default().reclaim_batch` (100).
pub const DEFAULT_RECLAIM_BATCH: i64 = 100;
pub const MIN_RECLAIM_BATCH: i64 = 1;
pub const MAX_RECLAIM_BATCH: i64 = 10_000;
/// Dispatch (claim) loop cadence, ms. Default == the inline `interval(from_millis(500))`.
pub const DEFAULT_DISPATCH_TICK_MS: i64 = 500;
pub const MIN_DISPATCH_TICK_MS: i64 = 50;
pub const MAX_DISPATCH_TICK_MS: i64 = 60_000;
/// CPU/RSS metric sampling cadence, seconds. Default == the inline `interval(from_secs(1))`.
pub const DEFAULT_METRIC_TICK_SECS: i64 = 1;
pub const MIN_METRIC_TICK_SECS: i64 = 1;
pub const MAX_METRIC_TICK_SECS: i64 = 60;

pub struct JobSettingsRepository {
    pool: SqlitePool,
}

impl JobSettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn get(&self) -> Result<JobSettings, AppError> {
        sqlx::query_as!(
            JobSettings,
            r#"SELECT max_concurrent_jobs as "max_concurrent_jobs: i32",
                      reserved_interactive_slots as "reserved_interactive_slots: i32",
                      per_tenant_max_concurrent as "per_tenant_max_concurrent: i32",
                      sse_keep_alive_secs, sse_max_clients as "sse_max_clients: i32",
                      admission_wait_secs, admission_poll_ms,
                      heartbeat_secs, reaper_tick_secs, stale_threshold_secs,
                      max_reclaims as "max_reclaims: i32", reclaim_batch,
                      dispatch_tick_ms, metric_tick_secs,
                      updated_at as "updated_at: DateTime<Utc>",
                      updated_by as "updated_by: Uuid"
               FROM job_settings WHERE id = TRUE"#
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Persist a PARTIAL settings update (COALESCE), stamping the audit `updated_by`
    /// (INV-4) from the acting admin — NOT from the wire body.
    pub async fn update(
        &self,
        req: &UpdateJobSettingsRequest,
        updated_by: Uuid,
    ) -> Result<JobSettings, AppError> {
        sqlx::query_as!(
            JobSettings,
            r#"UPDATE job_settings
               SET max_concurrent_jobs = COALESCE($1, max_concurrent_jobs),
                   reserved_interactive_slots = COALESCE($2, reserved_interactive_slots),
                   per_tenant_max_concurrent = COALESCE($3, per_tenant_max_concurrent),
                   sse_keep_alive_secs = COALESCE($4, sse_keep_alive_secs),
                   sse_max_clients = COALESCE($5, sse_max_clients),
                   admission_wait_secs = COALESCE($6, admission_wait_secs),
                   admission_poll_ms = COALESCE($7, admission_poll_ms),
                   heartbeat_secs = COALESCE($9, heartbeat_secs),
                   reaper_tick_secs = COALESCE($10, reaper_tick_secs),
                   stale_threshold_secs = COALESCE($11, stale_threshold_secs),
                   max_reclaims = COALESCE($12, max_reclaims),
                   reclaim_batch = COALESCE($13, reclaim_batch),
                   dispatch_tick_ms = COALESCE($14, dispatch_tick_ms),
                   metric_tick_secs = COALESCE($15, metric_tick_secs),
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                   updated_by = $8
               WHERE id = TRUE
               RETURNING max_concurrent_jobs as "max_concurrent_jobs: i32",
                         reserved_interactive_slots as "reserved_interactive_slots: i32",
                         per_tenant_max_concurrent as "per_tenant_max_concurrent: i32",
                         sse_keep_alive_secs, sse_max_clients as "sse_max_clients: i32",
                         admission_wait_secs, admission_poll_ms,
                         heartbeat_secs, reaper_tick_secs, stale_threshold_secs,
                         max_reclaims as "max_reclaims: i32", reclaim_batch,
                         dispatch_tick_ms, metric_tick_secs,
                         updated_at as "updated_at: DateTime<Utc>",
                         updated_by as "updated_by: Uuid""#,
            req.max_concurrent_jobs,
            req.reserved_interactive_slots,
            req.per_tenant_max_concurrent,
            req.sse_keep_alive_secs,
            req.sse_max_clients,
            req.admission_wait_secs,
            req.admission_poll_ms,
            updated_by,
            req.heartbeat_secs,
            req.reaper_tick_secs,
            req.stale_threshold_secs,
            req.max_reclaims,
            req.reclaim_batch,
            req.dispatch_tick_ms,
            req.metric_tick_secs
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Read-at-use (keep-alive interval, subscriber cap) for the SSE stream handler
    /// (INV-5). Falls back to the const defaults on any DB error so the hot path never
    /// breaks (byte-preserving, INV-1). `sse_max_clients` is floored at its minimum.
    pub async fn sse_config(&self) -> (Duration, usize) {
        match self.get().await {
            Ok(s) => (
                Duration::from_secs(s.sse_keep_alive_secs.max(MIN_SSE_KEEP_ALIVE_SECS) as u64),
                s.sse_max_clients.max(MIN_SSE_MAX_CLIENTS) as usize,
            ),
            Err(e) => {
                tracing::warn!(error = ?e, "job_settings read failed; using default SSE config");
                (
                    Duration::from_secs(DEFAULT_SSE_KEEP_ALIVE_SECS as u64),
                    DEFAULT_SSE_MAX_CLIENTS as usize,
                )
            }
        }
    }

    /// Read-at-use (wait budget, poll interval) for the detached admission loop
    /// (INV-5). Falls back to the const defaults on any DB error (byte-preserving,
    /// INV-1). `poll` is clamped strictly below `wait` so at least two attempts fit.
    pub async fn admission_config(&self) -> (Duration, Duration) {
        match self.get().await {
            Ok(s) => {
                let wait_secs = s.admission_wait_secs.max(MIN_ADMISSION_WAIT_SECS);
                let poll_ms = s
                    .admission_poll_ms
                    .max(MIN_ADMISSION_POLL_MS)
                    .min((wait_secs * 1000 - 1).max(MIN_ADMISSION_POLL_MS));
                (
                    Duration::from_secs(wait_secs as u64),
                    Duration::from_millis(poll_ms as u64),
                )
            }
            Err(e) => {
                tracing::warn!(error = ?e, "job_settings read failed; using default admission config");
                (
                    Duration::from_secs(DEFAULT_ADMISSION_WAIT_SECS as u64),
                    Duration::from_millis(DEFAULT_ADMISSION_POLL_MS as u64),
                )
            }
        }
    }

    /// Read-at-use (cap, reserved) pair for the scheduler's admission gate. Falls
    /// back to the safe defaults on any DB error; `reserved` is clamped so it can
    /// never exceed `cap - 1` (a reservation can't swallow the whole pool).
    pub async fn cap_and_reserved(&self) -> (i64, i64) {
        let (cap, reserved, _per_tenant) = self.caps().await;
        (cap, reserved)
    }

    /// Read-at-use (global cap, reserved, per-tenant cap) triple for the T4
    /// cap-folded claim (INV-1). BOTH caps are enforced inside the claim UPDATE
    /// (DEC-1): the global one keeps single-box `serve` byte-identical, the
    /// per-tenant one bounds one owner across N workers. Falls back to the safe
    /// defaults on any DB error so the hot path never breaks; `reserved` is
    /// clamped to `cap - 1` (a reservation can't swallow the whole pool) and the
    /// per-tenant cap is floored at its minimum.
    pub async fn caps(&self) -> (i64, i64, i64) {
        match self.get().await {
            Ok(s) => caps_of(&s),
            Err(e) => {
                tracing::warn!(error = ?e, "job_settings read failed; using default caps");
                default_caps()
            }
        }
    }

    /// One-read dispatch config (#56 perf-round): the `job_settings` row is read ONCE and
    /// BOTH the dispatch-tick cadence AND the `(cap, reserved, per_tenant)` triple are
    /// derived from that single snapshot — so the dispatch loop no longer issues two
    /// full-row SELECTs of the same singleton per tick (was `scheduler_limits()` +
    /// `caps()`). Falls back to the compiled defaults on a DB error. The claim loop still
    /// re-reads `caps()` on each SUBSEQUENT iteration for mid-tick admin-cap freshness; only
    /// the FIRST iteration's caps come from this combined read.
    pub async fn dispatch_config(&self) -> (Duration, (i64, i64, i64)) {
        match self.get().await {
            Ok(s) => {
                let limits = clamp_scheduler_limits(
                    s.heartbeat_secs,
                    s.reaper_tick_secs,
                    s.stale_threshold_secs,
                    s.max_reclaims,
                    s.reclaim_batch,
                    s.dispatch_tick_ms,
                    s.metric_tick_secs,
                );
                (limits.dispatch_tick, caps_of(&s))
            }
            Err(e) => {
                tracing::warn!(error = ?e, "job_settings read failed; using default dispatch config");
                (ReaperLimits::default().dispatch_tick, default_caps())
            }
        }
    }

    /// Read-at-use scheduler/reaper timing limits (#56, INV-1) — consumed at the TOP
    /// of each scheduler-loop iteration (dispatch/heartbeat/reaper) and once per job
    /// for the metric sampler, so an admin PUT takes effect without a restart. Falls
    /// back to the compiled `ReaperLimits::default()` on any DB error so the hot path
    /// never breaks (byte-preserving, INV-5). Every field is floored/clamped to its
    /// bounds, and `stale_threshold` is floored at `3 × heartbeat` (INV-4) so a stored
    /// row that somehow escaped validation can never drive a live-job reclaim.
    pub async fn scheduler_limits(&self) -> ReaperLimits {
        match self.get().await {
            Ok(s) => clamp_scheduler_limits(
                s.heartbeat_secs,
                s.reaper_tick_secs,
                s.stale_threshold_secs,
                s.max_reclaims,
                s.reclaim_batch,
                s.dispatch_tick_ms,
                s.metric_tick_secs,
            ),
            Err(e) => {
                tracing::warn!(error = ?e, "job_settings read failed; using default scheduler limits");
                ReaperLimits::default()
            }
        }
    }
}

/// Pure derivation of the `(global_cap, reserved, per_tenant_cap)` admission triple from a
/// settings row: `cap` floored at its min, `reserved` clamped to `cap - 1` (a reservation
/// can't swallow the whole pool), `per_tenant` floored at its min. Shared by `caps()` and
/// `dispatch_config()` so the one-read path derives identical values (no DB).
fn caps_of(s: &JobSettings) -> (i64, i64, i64) {
    let cap = s.max_concurrent_jobs.max(MIN_MAX_CONCURRENT) as i64;
    let reserved = (s.reserved_interactive_slots.max(0) as i64).min((cap - 1).max(0));
    let per_tenant = s.per_tenant_max_concurrent.max(MIN_PER_TENANT_MAX_CONCURRENT) as i64;
    (cap, reserved, per_tenant)
}

/// The safe-default admission triple used when the settings row can't be read.
fn default_caps() -> (i64, i64, i64) {
    (
        DEFAULT_MAX_CONCURRENT as i64,
        DEFAULT_RESERVED_INTERACTIVE as i64,
        DEFAULT_PER_TENANT_MAX_CONCURRENT as i64,
    )
}

/// Pure clamp of the seven raw scheduler-knob values into a bounds-safe `ReaperLimits`
/// (unit-testable, no DB). Each field is clamped to its `MIN_/MAX_`, and the stale
/// threshold is additionally floored at `STALE_HEARTBEAT_MULTIPLE × heartbeat` (INV-4)
/// AFTER the heartbeat itself is clamped — so no stored/legacy row can ever yield a
/// stale threshold below the live-worker safety floor.
pub fn clamp_scheduler_limits(
    heartbeat_secs: i64,
    reaper_tick_secs: i64,
    stale_threshold_secs: i64,
    max_reclaims: i32,
    reclaim_batch: i64,
    dispatch_tick_ms: i64,
    metric_tick_secs: i64,
) -> ReaperLimits {
    let heartbeat = heartbeat_secs.clamp(MIN_HEARTBEAT_SECS, MAX_HEARTBEAT_SECS);
    let reaper_tick = reaper_tick_secs.clamp(MIN_REAPER_TICK_SECS, MAX_REAPER_TICK_SECS);
    let stale_floor = (heartbeat * STALE_HEARTBEAT_MULTIPLE).max(MIN_STALE_THRESHOLD_SECS);
    let stale = stale_threshold_secs
        .clamp(MIN_STALE_THRESHOLD_SECS, MAX_STALE_THRESHOLD_SECS)
        .max(stale_floor);
    let max_reclaims = max_reclaims.clamp(MIN_MAX_RECLAIMS, MAX_MAX_RECLAIMS);
    let reclaim_batch = reclaim_batch.clamp(MIN_RECLAIM_BATCH, MAX_RECLAIM_BATCH);
    let dispatch_tick_ms = dispatch_tick_ms.clamp(MIN_DISPATCH_TICK_MS, MAX_DISPATCH_TICK_MS);
    let metric_tick = metric_tick_secs.clamp(MIN_METRIC_TICK_SECS, MAX_METRIC_TICK_SECS);
    ReaperLimits {
        heartbeat: Duration::from_secs(heartbeat as u64),
        reaper_tick: Duration::from_secs(reaper_tick as u64),
        stale_threshold: Duration::from_secs(stale as u64),
        max_reclaims,
        reclaim_batch,
        dispatch_tick: Duration::from_millis(dispatch_tick_ms as u64),
        metric_tick: Duration::from_secs(metric_tick as u64),
    }
}

/// Validate a `per_tenant_max_concurrent` update against its bounds
/// (mirrors the DB CHECK, surfaced as a 422 before the write). T4 / ITEM-6.
pub fn validate_per_tenant_cap(per_tenant: i32) -> Result<(), AppError> {
    if per_tenant < MIN_PER_TENANT_MAX_CONCURRENT || per_tenant > MAX_PER_TENANT_MAX_CONCURRENT {
        return Err(AppError::unprocessable_entity(
            "INVALID_PER_TENANT_CAP",
            format!(
                "per_tenant_max_concurrent must be between {MIN_PER_TENANT_MAX_CONCURRENT} and {MAX_PER_TENANT_MAX_CONCURRENT}"
            ),
        ));
    }
    Ok(())
}

/// Validate a reserved-interactive-slots update against the effective
/// `max_concurrent`: `0 <= reserved < max_concurrent` (mirrors the DB CHECK,
/// surfaced as a 422 before the write).
pub fn validate_reserved_slots(reserved: i32, max_concurrent: i32) -> Result<(), AppError> {
    if reserved < 0 || reserved >= max_concurrent {
        return Err(AppError::unprocessable_entity(
            "INVALID_RESERVED_SLOTS",
            format!(
                "reserved_interactive_slots must satisfy 0 <= reserved < max_concurrent ({max_concurrent})"
            ),
        ));
    }
    Ok(())
}

/// Validate the SSE + admission knobs in an update against their bounds (INV-2 /
/// DEC-3), surfaced as a 422 BEFORE the write (mirrors the DB CHECK). The
/// cross-field `poll < wait*1000` rule is checked against the EFFECTIVE poll AND
/// the EFFECTIVE wait (the requested new value if present, else the stored one) so
/// a change to EITHER field that would strand the pair is caught here — including
/// LOWERING `admission_wait_secs` alone below an already-stored high poll (which
/// would otherwise escape to the DB CHECK and surface as a 500, not a 422).
/// `current_wait_secs` / `current_poll_ms` are the stored values used when the
/// request does not set the corresponding field.
pub fn validate_sse_admission(
    req: &UpdateJobSettingsRequest,
    current_wait_secs: i64,
    current_poll_ms: i64,
) -> Result<(), AppError> {
    if let Some(n) = req.sse_keep_alive_secs {
        if !(MIN_SSE_KEEP_ALIVE_SECS..=MAX_SSE_KEEP_ALIVE_SECS).contains(&n) {
            return Err(AppError::unprocessable_entity(
                "INVALID_SSE_KEEP_ALIVE",
                format!(
                    "sse_keep_alive_secs must be between {MIN_SSE_KEEP_ALIVE_SECS} and {MAX_SSE_KEEP_ALIVE_SECS}"
                ),
            ));
        }
    }
    if let Some(n) = req.sse_max_clients {
        if !(MIN_SSE_MAX_CLIENTS..=MAX_SSE_MAX_CLIENTS).contains(&n) {
            return Err(AppError::unprocessable_entity(
                "INVALID_SSE_MAX_CLIENTS",
                format!(
                    "sse_max_clients must be between {MIN_SSE_MAX_CLIENTS} and {MAX_SSE_MAX_CLIENTS}"
                ),
            ));
        }
    }
    if let Some(n) = req.admission_wait_secs {
        if !(MIN_ADMISSION_WAIT_SECS..=MAX_ADMISSION_WAIT_SECS).contains(&n) {
            return Err(AppError::unprocessable_entity(
                "INVALID_ADMISSION_WAIT",
                format!(
                    "admission_wait_secs must be between {MIN_ADMISSION_WAIT_SECS} and {MAX_ADMISSION_WAIT_SECS}"
                ),
            ));
        }
    }
    // Absolute range on an explicit poll value.
    if let Some(n) = req.admission_poll_ms {
        if !(MIN_ADMISSION_POLL_MS..=MAX_ADMISSION_POLL_MS).contains(&n) {
            return Err(AppError::unprocessable_entity(
                "INVALID_ADMISSION_POLL",
                format!(
                    "admission_poll_ms must be between {MIN_ADMISSION_POLL_MS} and {MAX_ADMISSION_POLL_MS}"
                ),
            ));
        }
    }
    // Cross-field guardrail against the EFFECTIVE pair (mirrors the DB CHECK), checked
    // whenever EITHER field is in the request — so lowering the wait alone below a
    // stored high poll is a typed 422, not a DB-level 500. The poll must fit strictly
    // inside the budget, or only one attempt is ever made (admission.rs invariant).
    if req.admission_poll_ms.is_some() || req.admission_wait_secs.is_some() {
        let effective_wait = req.admission_wait_secs.unwrap_or(current_wait_secs);
        let effective_poll = req.admission_poll_ms.unwrap_or(current_poll_ms);
        if effective_poll >= effective_wait * 1000 {
            return Err(AppError::unprocessable_entity(
                "INVALID_ADMISSION_POLL",
                format!(
                    "admission_poll_ms ({effective_poll}) must be strictly less than \
                     admission_wait_secs*1000 ({})",
                    effective_wait * 1000
                ),
            ));
        }
    }
    Ok(())
}

/// Validate the scheduler/reaper timing knobs (#56, INV-2/INV-4) against their bounds,
/// surfaced as a typed 422 BEFORE the write (mirrors the DB CHECK). The cross-field
/// `stale_threshold_secs >= STALE_HEARTBEAT_MULTIPLE × heartbeat_secs` guardrail is
/// checked against the EFFECTIVE pair (the requested new value if present, else the
/// stored one) so a change to EITHER field that would strand the pair — including
/// LOWERING `heartbeat_secs` alone under an already-stored stale, or lowering
/// `stale_threshold_secs` alone — is caught here as a 422, not escaped to the DB CHECK
/// as a 500. `current_heartbeat_secs` / `current_stale_secs` are the stored values used
/// when the request does not set the corresponding field.
pub fn validate_scheduler_limits(
    req: &UpdateJobSettingsRequest,
    current_heartbeat_secs: i64,
    current_stale_secs: i64,
) -> Result<(), AppError> {
    fn range_i64(v: i64, lo: i64, hi: i64, code: &'static str, field: &str) -> Result<(), AppError> {
        if !(lo..=hi).contains(&v) {
            return Err(AppError::unprocessable_entity(
                code,
                format!("{field} must be between {lo} and {hi}"),
            ));
        }
        Ok(())
    }

    if let Some(n) = req.heartbeat_secs {
        range_i64(n, MIN_HEARTBEAT_SECS, MAX_HEARTBEAT_SECS, "INVALID_HEARTBEAT", "heartbeat_secs")?;
    }
    if let Some(n) = req.reaper_tick_secs {
        range_i64(n, MIN_REAPER_TICK_SECS, MAX_REAPER_TICK_SECS, "INVALID_REAPER_TICK", "reaper_tick_secs")?;
    }
    if let Some(n) = req.stale_threshold_secs {
        range_i64(n, MIN_STALE_THRESHOLD_SECS, MAX_STALE_THRESHOLD_SECS, "INVALID_STALE_THRESHOLD", "stale_threshold_secs")?;
    }
    if let Some(n) = req.max_reclaims {
        if !(MIN_MAX_RECLAIMS..=MAX_MAX_RECLAIMS).contains(&n) {
            return Err(AppError::unprocessable_entity(
                "INVALID_MAX_RECLAIMS",
                format!("max_reclaims must be between {MIN_MAX_RECLAIMS} and {MAX_MAX_RECLAIMS}"),
            ));
        }
    }
    if let Some(n) = req.reclaim_batch {
        range_i64(n, MIN_RECLAIM_BATCH, MAX_RECLAIM_BATCH, "INVALID_RECLAIM_BATCH", "reclaim_batch")?;
    }
    if let Some(n) = req.dispatch_tick_ms {
        range_i64(n, MIN_DISPATCH_TICK_MS, MAX_DISPATCH_TICK_MS, "INVALID_DISPATCH_TICK", "dispatch_tick_ms")?;
    }
    if let Some(n) = req.metric_tick_secs {
        range_i64(n, MIN_METRIC_TICK_SECS, MAX_METRIC_TICK_SECS, "INVALID_METRIC_TICK", "metric_tick_secs")?;
    }

    // The reaper safety guardrail (INV-4 / DEC-3), against the EFFECTIVE pair — a still-live
    // worker heartbeats every `heartbeat_secs`, so the reclaim threshold must be a generous
    // multiple of it or the reaper could reclaim rows a live worker is still running.
    if req.heartbeat_secs.is_some() || req.stale_threshold_secs.is_some() {
        let effective_heartbeat = req.heartbeat_secs.unwrap_or(current_heartbeat_secs);
        let effective_stale = req.stale_threshold_secs.unwrap_or(current_stale_secs);
        if effective_stale < STALE_HEARTBEAT_MULTIPLE * effective_heartbeat {
            return Err(AppError::unprocessable_entity(
                "INVALID_STALE_THRESHOLD",
                format!(
                    "stale_threshold_secs ({effective_stale}) must be at least \
                     {STALE_HEARTBEAT_MULTIPLE}× heartbeat_secs ({}) so a live worker is never \
                     reclaimed",
                    STALE_HEARTBEAT_MULTIPLE * effective_heartbeat
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1 (SSE/admission bounds leg): validate_sse_admission enforces each knob's
    // range and the cross-field poll < wait*1000 rule.
    #[test]
    fn sse_admission_bounds() {
        let ok = UpdateJobSettingsRequest {
            sse_keep_alive_secs: Some(30),
            sse_max_clients: Some(512),
            admission_wait_secs: Some(20),
            admission_poll_ms: Some(500),
            ..Default::default()
        };
        assert!(validate_sse_admission(&ok, 15, 250).is_ok());

        let bad_keepalive = UpdateJobSettingsRequest {
            sse_keep_alive_secs: Some(0),
            ..Default::default()
        };
        assert_eq!(
            validate_sse_admission(&bad_keepalive, 15, 250)
                .unwrap_err()
                .error_code(),
            "INVALID_SSE_KEEP_ALIVE"
        );

        let bad_clients = UpdateJobSettingsRequest {
            sse_max_clients: Some(1_000_000),
            ..Default::default()
        };
        assert_eq!(
            validate_sse_admission(&bad_clients, 15, 250)
                .unwrap_err()
                .error_code(),
            "INVALID_SSE_MAX_CLIENTS"
        );

        let bad_wait = UpdateJobSettingsRequest {
            admission_wait_secs: Some(3600),
            ..Default::default()
        };
        assert_eq!(
            validate_sse_admission(&bad_wait, 15, 250).unwrap_err().error_code(),
            "INVALID_ADMISSION_WAIT"
        );

        // poll >= wait*1000 (against the effective wait) → rejected.
        let poll_ge_wait = UpdateJobSettingsRequest {
            admission_wait_secs: Some(1),
            admission_poll_ms: Some(1000),
            ..Default::default()
        };
        assert_eq!(
            validate_sse_admission(&poll_ge_wait, 15, 250)
                .unwrap_err()
                .error_code(),
            "INVALID_ADMISSION_POLL"
        );

        // poll out of absolute range → rejected.
        let poll_range = UpdateJobSettingsRequest {
            admission_poll_ms: Some(5),
            ..Default::default()
        };
        assert_eq!(
            validate_sse_admission(&poll_range, 15, 250)
                .unwrap_err()
                .error_code(),
            "INVALID_ADMISSION_POLL"
        );

        // FIX_ROUND-1 regression (finding #1): LOWERING admission_wait_secs alone,
        // below an already-stored high poll, must be a typed 422 here — not escape to
        // the DB CHECK as a 500. Stored poll=5000; PUT wait=4 → 5000 >= 4000 → reject.
        let lower_wait_alone = UpdateJobSettingsRequest {
            admission_wait_secs: Some(4),
            ..Default::default()
        };
        assert_eq!(
            validate_sse_admission(&lower_wait_alone, 15, 5000)
                .unwrap_err()
                .error_code(),
            "INVALID_ADMISSION_POLL",
            "lowering wait alone below the stored poll is caught by the Rust validator"
        );
        // And a benign wait-lowering that still clears the stored poll is accepted.
        assert!(
            validate_sse_admission(&lower_wait_alone, 15, 250).is_ok(),
            "wait=4 with stored poll=250 (250 < 4000) is fine"
        );
    }

    // TEST-20 (bounds leg): the reserved-slots validator enforces
    // 0 <= reserved < max_concurrent.
    #[test]
    fn reserved_slots_bounds() {
        assert!(validate_reserved_slots(0, 2).is_ok());
        assert!(validate_reserved_slots(1, 2).is_ok());
        assert!(
            validate_reserved_slots(2, 2).is_err(),
            "reserved == cap rejected"
        );
        assert!(
            validate_reserved_slots(3, 2).is_err(),
            "reserved > cap rejected"
        );
        assert_eq!(
            validate_reserved_slots(-1, 2).unwrap_err().error_code(),
            "INVALID_RESERVED_SLOTS"
        );
    }

    // TEST-11u (bounds unit leg / ITEM-6): the per-tenant cap validator enforces
    // 1 <= per_tenant <= 64 (mirrors the DB CHECK), surfaced as a 422.
    #[test]
    fn per_tenant_cap_bounds() {
        assert!(validate_per_tenant_cap(1).is_ok());
        assert!(validate_per_tenant_cap(2).is_ok());
        assert!(validate_per_tenant_cap(64).is_ok());
        assert!(validate_per_tenant_cap(0).is_err(), "below min rejected");
        assert!(validate_per_tenant_cap(65).is_err(), "above max rejected");
        assert_eq!(
            validate_per_tenant_cap(0).unwrap_err().error_code(),
            "INVALID_PER_TENANT_CAP"
        );
    }

    // TEST-1 (#56): validate_scheduler_limits enforces each knob's range AND the cross-field
    // stale >= 3×heartbeat guardrail against the EFFECTIVE (requested-else-stored) pair.
    #[test]
    fn scheduler_limits_bounds_and_guardrail() {
        // A wholly valid update (stale 60 >= 3*15).
        let ok = UpdateJobSettingsRequest {
            heartbeat_secs: Some(15),
            reaper_tick_secs: Some(20),
            stale_threshold_secs: Some(60),
            max_reclaims: Some(3),
            reclaim_batch: Some(500),
            dispatch_tick_ms: Some(250),
            metric_tick_secs: Some(2),
            ..Default::default()
        };
        assert!(validate_scheduler_limits(&ok, DEFAULT_HEARTBEAT_SECS, DEFAULT_STALE_THRESHOLD_SECS).is_ok());

        // Each per-field range violation → its typed code.
        for (req, code) in [
            (UpdateJobSettingsRequest { heartbeat_secs: Some(0), ..Default::default() }, "INVALID_HEARTBEAT"),
            (UpdateJobSettingsRequest { reaper_tick_secs: Some(301), ..Default::default() }, "INVALID_REAPER_TICK"),
            (UpdateJobSettingsRequest { stale_threshold_secs: Some(4), ..Default::default() }, "INVALID_STALE_THRESHOLD"),
            (UpdateJobSettingsRequest { max_reclaims: Some(0), ..Default::default() }, "INVALID_MAX_RECLAIMS"),
            (UpdateJobSettingsRequest { reclaim_batch: Some(0), ..Default::default() }, "INVALID_RECLAIM_BATCH"),
            (UpdateJobSettingsRequest { dispatch_tick_ms: Some(10), ..Default::default() }, "INVALID_DISPATCH_TICK"),
            (UpdateJobSettingsRequest { metric_tick_secs: Some(61), ..Default::default() }, "INVALID_METRIC_TICK"),
        ] {
            assert_eq!(
                validate_scheduler_limits(&req, DEFAULT_HEARTBEAT_SECS, DEFAULT_STALE_THRESHOLD_SECS)
                    .unwrap_err()
                    .error_code(),
                code,
            );
        }

        // Guardrail: setting BOTH so stale < 3×heartbeat → rejected (heartbeat 10, stale 20 < 30).
        let both = UpdateJobSettingsRequest {
            heartbeat_secs: Some(10),
            stale_threshold_secs: Some(20),
            ..Default::default()
        };
        assert_eq!(
            validate_scheduler_limits(&both, DEFAULT_HEARTBEAT_SECS, DEFAULT_STALE_THRESHOLD_SECS)
                .unwrap_err()
                .error_code(),
            "INVALID_STALE_THRESHOLD"
        );

        // Guardrail asymmetric: RAISING heartbeat alone (to 20) above stored stale/3 (45/3=15)
        // strands the pair (45 < 60) → rejected against the EFFECTIVE (stored) stale.
        let raise_hb = UpdateJobSettingsRequest { heartbeat_secs: Some(20), ..Default::default() };
        assert_eq!(
            validate_scheduler_limits(&raise_hb, DEFAULT_HEARTBEAT_SECS, 45)
                .unwrap_err()
                .error_code(),
            "INVALID_STALE_THRESHOLD",
            "raising heartbeat alone under a stored stale is a typed 422, never a DB 500"
        );

        // Lowering stale alone below 3×stored-heartbeat → rejected.
        let lower_stale = UpdateJobSettingsRequest { stale_threshold_secs: Some(20), ..Default::default() };
        assert_eq!(
            validate_scheduler_limits(&lower_stale, 10, DEFAULT_STALE_THRESHOLD_SECS)
                .unwrap_err()
                .error_code(),
            "INVALID_STALE_THRESHOLD"
        );
    }

    // TEST-2 (#56): clamp_scheduler_limits floors/clamps every field to its bounds and floors
    // stale at 3×heartbeat, so read-at-use never yields an out-of-bounds or unsafe cadence.
    #[test]
    fn clamp_scheduler_limits_is_bounds_safe() {
        // The compiled defaults round-trip byte-identically (INV-5).
        let d = clamp_scheduler_limits(
            DEFAULT_HEARTBEAT_SECS,
            DEFAULT_REAPER_TICK_SECS,
            DEFAULT_STALE_THRESHOLD_SECS,
            DEFAULT_MAX_RECLAIMS,
            DEFAULT_RECLAIM_BATCH,
            DEFAULT_DISPATCH_TICK_MS,
            DEFAULT_METRIC_TICK_SECS,
        );
        assert_eq!(d.heartbeat, Duration::from_secs(10));
        assert_eq!(d.reaper_tick, Duration::from_secs(15));
        assert_eq!(d.stale_threshold, Duration::from_secs(45));
        assert_eq!(d.max_reclaims, 5);
        assert_eq!(d.reclaim_batch, 100);
        assert_eq!(d.dispatch_tick, Duration::from_millis(500));
        assert_eq!(d.metric_tick, Duration::from_secs(1));

        // Out-of-range values are clamped, and a too-low stored stale is floored at 3×heartbeat.
        let c = clamp_scheduler_limits(30, 9999, 5, 9999, 0, 1, 9999);
        assert_eq!(c.heartbeat, Duration::from_secs(30));
        assert_eq!(c.reaper_tick, Duration::from_secs(MAX_REAPER_TICK_SECS as u64));
        // stale floored at 3*30 = 90 despite the row saying 5.
        assert_eq!(c.stale_threshold, Duration::from_secs(90));
        assert_eq!(c.max_reclaims, MAX_MAX_RECLAIMS);
        assert_eq!(c.reclaim_batch, MIN_RECLAIM_BATCH);
        assert_eq!(c.dispatch_tick, Duration::from_millis(MIN_DISPATCH_TICK_MS as u64));
        assert_eq!(c.metric_tick, Duration::from_secs(MAX_METRIC_TICK_SECS as u64));
    }
}
