//! `job_settings` singleton persistence (concurrency cap + reserved interactive
//! slots).
//!
//! Mirrors txresbench-auth's `SessionSettingsRepository`: a single `id = TRUE` row,
//! partial COALESCE update, read-at-use (the execution engine reads the cap at
//! admit/claim time, with a safe fallback on DB error so the hot path never
//! breaks). Compile-time `query_as!` macros (SDK gap G4 resolved).
//!
//! SQLite driver (sqlite-store DEC-1): the INTEGER-affinity columns keep their
//! Rust field types spelled out (`max_concurrent_jobs as "…: i32"` — the sqlite
//! macro infers INTEGER as `i64`), and the write clock is the canonical
//! `now()` → `strftime('%Y-%m-%dT%H:%M:%fZ','now')` rewrite. `id = TRUE` is
//! legal SQLite 3.46 (TRUE is the integer 1) and is kept verbatim.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use super::models::{JobSettings, UpdateJobSettingsRequest};

/// The safe default concurrency if the settings row can't be read.
pub const DEFAULT_MAX_CONCURRENT: i32 = 2;
/// Inclusive bounds for `max_concurrent_jobs` (matches the DB CHECK).
pub const MIN_MAX_CONCURRENT: i32 = 1;
/// The safe default reserved interactive slots if the row can't be read.
pub const DEFAULT_RESERVED_INTERACTIVE: i32 = 1;
/// The safe default per-tenant concurrency cap if the settings row can't be read (T4 §6).
pub const DEFAULT_PER_TENANT_MAX_CONCURRENT: i32 = 2;
/// Inclusive bounds for `per_tenant_max_concurrent` (matches the DB CHECK).
pub const MIN_PER_TENANT_MAX_CONCURRENT: i32 = 1;
pub const MAX_PER_TENANT_MAX_CONCURRENT: i32 = 64;

// ── SSE + admission knob bounds (#54). The stored singleton keeps the columns;
// the validators below are the read/update gate for the admin PUT surface of
// the platform — the values changed only through that surface, which is
// stripped, so the knobs remain stored-but-frozen. Bounds are the guardrails
// (DEC-3): an admin must not be able to set a hang or an OOM.

/// SSE heartbeat interval bounds, seconds (DB CHECK mirrors these).
pub const MIN_SSE_KEEP_ALIVE_SECS: i64 = 1;
pub const MAX_SSE_KEEP_ALIVE_SECS: i64 = 300;
/// Global per-job SSE subscriber cap bounds.
pub const MIN_SSE_MAX_CLIENTS: i32 = 1;
pub const MAX_SSE_MAX_CLIENTS: i32 = 4096;
/// Detached-admit wait budget bounds, seconds.
pub const MIN_ADMISSION_WAIT_SECS: i64 = 1;
pub const MAX_ADMISSION_WAIT_SECS: i64 = 60;
/// Admit poll interval bounds, ms.
pub const MIN_ADMISSION_POLL_MS: i64 = 10;
pub const MAX_ADMISSION_POLL_MS: i64 = 10_000;

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
}

/// Pure derivation of the `(global_cap, reserved, per_tenant_cap)` admission triple from a
/// settings row: `cap` floored at its min, `reserved` clamped to `cap - 1` (a reservation
/// can't swallow the whole pool), `per_tenant` floored at its min. Shared by `caps()`
/// / `cap_and_reserved` so every reader derives identical values (no DB).
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

}
