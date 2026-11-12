//! MCP admin settings singleton (issue #54): the agent/tool caps + pairing-TTL,
//! promoted from hardcoded constants (`agent_channel.rs`, `pairing.rs`,
//! `handlers.rs`) to an admin-tunable settings row.
//!
//! Mirrors `modules/workstore/settings.rs` (struct + `defaults()` cache-fallback +
//! `validate()` 422-bounds + partial `Update` + `Repository` COALESCE-update +
//! `merge()`). Defaults EQUAL the compiled constants so a never-PUT deployment is
//! byte-identical (INV-1). The `usize`-typed caps are stored `bigint`/`i64` and
//! read via saturating `*_usize` accessors (DEC-5). Repository uses
//! `sqlx::query_as!` (build-DB checked — `build.rs::provision_build_db`
//! auto-migrates the sqlite build file; the `WHERE id = TRUE` singleton
//! predicate and the canonical `strftime` write clock are the DEC-8 port).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

/// The singleton MCP settings row — the six promoted knobs (agent caps + tool
/// caps + pairing-TTL). All fields are `bigint`/`i64` (DEC-5), converted to
/// `usize`/`u64`/`Duration` at the read-at-use sites via the accessors below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, sqlx::FromRow)]
pub struct McpSettings {
    /// Global cap on live agent control-session connections (OOM guard — SAFETY,
    /// DEC-3). One session per user, so it effectively caps concurrent AI-paired
    /// users. Source: `agent_channel.rs MAX_CONTROL_SESSIONS`.
    pub max_control_sessions: i64,
    /// Per-user cap on concurrent in-flight frontend-action invokes (DoS guard —
    /// SAFETY, DEC-3). Source: `agent_channel.rs MAX_INFLIGHT_PER_USER`.
    pub max_inflight_per_user: i64,
    /// Pairing-code time-to-live, in seconds. Source: `pairing.rs
    /// PAIRING_TTL_MINUTES` (5 min = 300s).
    pub pairing_ttl_secs: i64,
    /// Outer wall-clock backstop on a single dispatched frontend action, in
    /// seconds. Source: `agent_channel.rs WALL_CLOCK_CAP` (15 min = 900s).
    pub action_wall_clock_secs: i64,
    /// Cap on how many capabilities `list_capabilities` returns in one call.
    /// Source: `handlers.rs MAX_LIST_RESULTS`.
    pub max_list_results: i64,
    /// Cap on the REST-invoke result body relayed back to the model, in bytes
    /// (OOM guard — SAFETY, DEC-3). Source: `handlers.rs MAX_RESULT_BYTES` (1 MiB).
    pub max_result_bytes: i64,
}

impl McpSettings {
    /// Hardcoded defaults — the SEED of the migration AND the cache fallback if the
    /// DB read fails. Each value equals the pre-existing compiled constant (INV-1).
    pub fn defaults() -> Self {
        Self {
            max_control_sessions: 1024,
            max_inflight_per_user: 16,
            pairing_ttl_secs: 300,          // 5 minutes
            action_wall_clock_secs: 900,    // 15 minutes
            max_list_results: 200,
            max_result_bytes: 1024 * 1024,  // 1 MiB
        }
    }

    // ── read-at-use accessors (DEC-5: stored i64, consumed usize/u64/Duration) ──
    /// Global control-session cap as a `usize` (a degenerate ≤0 floors to 0, which
    /// refuses every new connection rather than panicking — validate/CHECK keep it
    /// in range in practice).
    pub fn max_control_sessions_usize(&self) -> usize {
        self.max_control_sessions.max(0) as usize
    }
    /// Per-user in-flight cap as a `usize`.
    pub fn max_inflight_per_user_usize(&self) -> usize {
        self.max_inflight_per_user.max(0) as usize
    }
    /// Pairing-code TTL as a `chrono::Duration` (floored at 1s).
    pub fn pairing_ttl(&self) -> chrono::Duration {
        chrono::Duration::seconds(self.pairing_ttl_secs.max(1))
    }
    /// Action wall-clock backstop as a `std::time::Duration` (floored at 1s).
    pub fn action_wall_clock(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.action_wall_clock_secs.max(1) as u64)
    }
    /// `list_capabilities` truncation cap as a `usize`.
    pub fn max_list_results_usize(&self) -> usize {
        self.max_list_results.max(0) as usize
    }
    /// REST-invoke result truncation cap as a `usize` (bytes).
    pub fn max_result_bytes_usize(&self) -> usize {
        self.max_result_bytes.max(0) as usize
    }

    /// Validate a candidate row. Returns a 422 `MCP_SETTING_OUT_OF_RANGE` on any
    /// out-of-range value. The bounds mirror the DB CHECK constraints (DEC-9): a
    /// SAFETY guard (the session/in-flight OOM/DoS caps, the result-byte ceiling)
    /// is bounded and NEVER admin-raisable unbounded (DEC-3).
    pub fn validate(&self) -> Result<(), AppError> {
        fn range(name: &str, v: i64, lo: i64, hi: i64) -> Result<(), AppError> {
            if v < lo || v > hi {
                return Err(AppError::unprocessable_entity(
                    "MCP_SETTING_OUT_OF_RANGE",
                    format!("{name}={v} out of range ({lo}..={hi})"),
                ));
            }
            Ok(())
        }
        // Agent session cap (OOM guard): 16 .. 16384.
        range("max_control_sessions", self.max_control_sessions, 16, 16_384)?;
        // Per-user in-flight cap (DoS guard): 1 .. 256.
        range("max_inflight_per_user", self.max_inflight_per_user, 1, 256)?;
        // Pairing-code TTL: 30s .. 1h.
        range("pairing_ttl_secs", self.pairing_ttl_secs, 30, 3_600)?;
        // Action wall-clock backstop: 30s .. 1h.
        range("action_wall_clock_secs", self.action_wall_clock_secs, 30, 3_600)?;
        // list_capabilities cap: 1 .. 2000.
        range("max_list_results", self.max_list_results, 1, 2_000)?;
        // Result-byte ceiling (OOM guard): 1 KiB .. 64 MiB.
        range("max_result_bytes", self.max_result_bytes, 1024, 64 * 1024 * 1024)?;
        Ok(())
    }
}

/// PUT body — every field optional (absent = leave unchanged).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateMcpSettings {
    #[serde(default)]
    pub max_control_sessions: Option<i64>,
    #[serde(default)]
    pub max_inflight_per_user: Option<i64>,
    #[serde(default)]
    pub pairing_ttl_secs: Option<i64>,
    #[serde(default)]
    pub action_wall_clock_secs: Option<i64>,
    #[serde(default)]
    pub max_list_results: Option<i64>,
    #[serde(default)]
    pub max_result_bytes: Option<i64>,
}

pub struct McpSettingsRepository {
    pool: SqlitePool,
}

impl McpSettingsRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Read the singleton row (the SELECT omits `updated_at`/`updated_by` — the
    /// projection is the six knobs).
    pub async fn get(&self) -> Result<McpSettings, AppError> {
        sqlx::query_as!(
            McpSettings,
            r#"SELECT max_control_sessions, max_inflight_per_user, pairing_ttl_secs,
                      action_wall_clock_secs, max_list_results, max_result_bytes
               FROM mcp_settings WHERE id = TRUE"#
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// COALESCE-update the singleton, stamp `updated_by`/`updated_at`, then re-read
    /// + return the new row. The caller validates the MERGED row before calling
    /// (so the DB never holds an invalid value; the DB CHECKs are the backstop).
    pub async fn update(
        &self,
        req: &UpdateMcpSettings,
        updated_by: Uuid,
    ) -> Result<McpSettings, AppError> {
        sqlx::query_as!(
            McpSettings,
            r#"UPDATE mcp_settings SET
                    max_control_sessions = COALESCE($1, max_control_sessions),
                    max_inflight_per_user = COALESCE($2, max_inflight_per_user),
                    pairing_ttl_secs = COALESCE($3, pairing_ttl_secs),
                    action_wall_clock_secs = COALESCE($4, action_wall_clock_secs),
                    max_list_results = COALESCE($5, max_list_results),
                    max_result_bytes = COALESCE($6, max_result_bytes),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    updated_by = $7
               WHERE id = TRUE
               RETURNING max_control_sessions, max_inflight_per_user, pairing_ttl_secs,
                         action_wall_clock_secs, max_list_results, max_result_bytes"#,
            req.max_control_sessions,
            req.max_inflight_per_user,
            req.pairing_ttl_secs,
            req.action_wall_clock_secs,
            req.max_list_results,
            req.max_result_bytes,
            updated_by,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Apply a partial update onto the current row → the merged candidate, for
    /// validation before the DB write.
    pub fn merge(current: &McpSettings, req: &UpdateMcpSettings) -> McpSettings {
        McpSettings {
            max_control_sessions: req.max_control_sessions.unwrap_or(current.max_control_sessions),
            max_inflight_per_user: req.max_inflight_per_user.unwrap_or(current.max_inflight_per_user),
            pairing_ttl_secs: req.pairing_ttl_secs.unwrap_or(current.pairing_ttl_secs),
            action_wall_clock_secs: req
                .action_wall_clock_secs
                .unwrap_or(current.action_wall_clock_secs),
            max_list_results: req.max_list_results.unwrap_or(current.max_list_results),
            max_result_bytes: req.max_result_bytes.unwrap_or(current.max_result_bytes),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1 [acceptance INV-1]: defaults equal the compiled constants EXACTLY and
    // pass validate() — a never-PUT deployment is byte-identical.
    #[test]
    fn defaults_equal_compiled_constants_and_validate() {
        let d = McpSettings::defaults();
        d.validate().expect("defaults valid");
        assert_eq!(d.max_control_sessions, 1024, "agent_channel.rs MAX_CONTROL_SESSIONS");
        assert_eq!(d.max_inflight_per_user, 16, "agent_channel.rs MAX_INFLIGHT_PER_USER");
        assert_eq!(d.pairing_ttl_secs, 300, "pairing.rs PAIRING_TTL_MINUTES=5 → 300s");
        assert_eq!(d.action_wall_clock_secs, 900, "agent_channel.rs WALL_CLOCK_CAP=15*60");
        assert_eq!(d.max_list_results, 200, "handlers.rs MAX_LIST_RESULTS");
        assert_eq!(d.max_result_bytes, 1_048_576, "handlers.rs MAX_RESULT_BYTES=1 MiB");
        // The accessors reproduce the original typed constants.
        assert_eq!(d.max_control_sessions_usize(), 1024);
        assert_eq!(d.max_inflight_per_user_usize(), 16);
        assert_eq!(d.pairing_ttl().num_minutes(), 5);
        assert_eq!(d.action_wall_clock(), std::time::Duration::from_secs(15 * 60));
        assert_eq!(d.max_list_results_usize(), 200);
        assert_eq!(d.max_result_bytes_usize(), 1024 * 1024);
    }

    // TEST-2 [acceptance INV-2]: no SAFETY guard is admin-raisable unbounded — a
    // raise ABOVE each ceiling and a drop BELOW each floor are 422s.
    #[test]
    fn out_of_range_rejected_422() {
        let cases = [
            McpSettings { max_control_sessions: 16_385, ..McpSettings::defaults() },
            McpSettings { max_control_sessions: 15, ..McpSettings::defaults() },
            McpSettings { max_inflight_per_user: 257, ..McpSettings::defaults() },
            McpSettings { max_inflight_per_user: 0, ..McpSettings::defaults() },
            McpSettings { pairing_ttl_secs: 29, ..McpSettings::defaults() },
            McpSettings { pairing_ttl_secs: 3_601, ..McpSettings::defaults() },
            McpSettings { action_wall_clock_secs: 29, ..McpSettings::defaults() },
            McpSettings { max_list_results: 0, ..McpSettings::defaults() },
            McpSettings { max_list_results: 2_001, ..McpSettings::defaults() },
            // Result-byte OOM ceiling: 65 MiB > the 64 MiB max.
            McpSettings { max_result_bytes: 65 * 1024 * 1024, ..McpSettings::defaults() },
            McpSettings { max_result_bytes: 1023, ..McpSettings::defaults() },
        ];
        for c in cases {
            let e = c.validate().unwrap_err();
            assert_eq!(e.status_code(), 422, "{c:?} should be 422");
            assert_eq!(e.error_code(), "MCP_SETTING_OUT_OF_RANGE");
        }
    }

    // TEST-3: merge overlays only the present fields.
    #[test]
    fn merge_overlays_only_present_fields() {
        let cur = McpSettings::defaults();
        let req = UpdateMcpSettings { max_inflight_per_user: Some(32), ..Default::default() };
        let merged = McpSettingsRepository::merge(&cur, &req);
        assert_eq!(merged.max_inflight_per_user, 32);
        assert_eq!(merged.max_control_sessions, cur.max_control_sessions, "untouched preserved");
        assert_eq!(merged.pairing_ttl_secs, cur.pairing_ttl_secs);
    }

    // TEST-6: the usize accessors saturate a degenerate/negative stored i64 to a
    // safe usize (no panic, floored at 0) — the read-at-use sites can't panic.
    #[test]
    fn usize_accessors_saturate_negative() {
        let degenerate = McpSettings {
            max_control_sessions: -5,
            max_inflight_per_user: -1,
            max_list_results: -10,
            max_result_bytes: -1,
            pairing_ttl_secs: -1,
            action_wall_clock_secs: -1,
        };
        assert_eq!(degenerate.max_control_sessions_usize(), 0);
        assert_eq!(degenerate.max_inflight_per_user_usize(), 0);
        assert_eq!(degenerate.max_list_results_usize(), 0);
        assert_eq!(degenerate.max_result_bytes_usize(), 0);
        // Durations floor at 1s rather than 0/negative.
        assert_eq!(degenerate.pairing_ttl().num_seconds(), 1);
        assert_eq!(degenerate.action_wall_clock(), std::time::Duration::from_secs(1));
    }
}
