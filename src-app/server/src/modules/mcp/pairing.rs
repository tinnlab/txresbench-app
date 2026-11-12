//! One-time-code pairing (ITEM-12): `POST /api/mcp/pair/start` mints a
//! short-lived, single-use code for the calling user; `POST
//! /api/mcp/pair/exchange` (code-authenticated, NO permission gate — the code
//! IS the credential) atomically claims it and mints an access+refresh token
//! pair for that user via `txresbench-auth`'s `mint_session_tokens` — the SAME mint
//! path every other login-shaped flow uses (jti-whitelisted, revocable on
//! logout). Secrets never ride a URL: `pair/start` returns an opaque code, not
//! a token.

use std::sync::Arc;

use axum::http::StatusCode;
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_auth::auth::JwtService;
use txresbench_auth::user::UserRepository;
use txresbench_core::{ApiResult, AppError};

use crate::modules::permissions::RequirePermissions;

use super::handlers;
use super::models::{PairExchangeRequest, PairExchangeResponse, PairStartResponse};
use super::permissions::McpUse;

// How long a minted pairing code stays claimable used to be the bare const
// `PAIRING_TTL_MINUTES = 5`. It is now the admin setting `pairing_ttl_secs`
// (issue #54), read-at-use in `pair_start` via `settings_cache::get`. The setting
// default EQUALS the old const (300s, byte-preserving, INV-1). Short by design —
// the handshake is a synchronous "click connect, txresbench exchanges it" flow.

/// Pure single-use + TTL predicate, extracted so it's unit-testable without a
/// DB. The real claim path (`PairingRepository::claim`) encodes the EXACT
/// same predicate atomically inside one `UPDATE ... WHERE used_at IS NULL AND
/// expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING ...` (race-safe
/// against a concurrent double exchange) — this function documents + tests that
/// predicate.
///
/// Not called from non-test code (the real path is the atomic SQL above, not
/// this function) — exercised only by the `#[cfg(test)]` module below.
#[allow(dead_code)]
pub fn code_is_claimable(
    used_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    used_at.is_none() && expires_at > now
}

pub struct PairingRepository {
    pool: SqlitePool,
}

impl PairingRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Mint + persist a fresh single-use code for `user_id`, expiring after
    /// `ttl`. Returns the opaque code (a UUIDv4 — 122 bits of entropy, ample
    /// for a short-lived single-use secret).
    ///
    /// Opportunistically prunes any already-expired codes first (best-effort;
    /// a failure here doesn't block minting) — there's no dedicated pruning
    /// job for this table, so this is what keeps it from accumulating stale
    /// rows across a long-lived deployment. Cheap: at most a handful of
    /// short-lived rows exist system-wide at any moment.
    pub async fn create(&self, user_id: Uuid, ttl: chrono::Duration) -> Result<String, AppError> {
        if let Err(e) = sqlx::query!(
            "DELETE FROM mcp_pairing_codes WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')"
        )
        .execute(&self.pool)
        .await
        {
            tracing::warn!(error = %e, "mcp: failed to prune expired pairing codes (non-fatal)");
        }

        let code = Uuid::new_v4().to_string();
        let id = Uuid::new_v4();
        let expires_at = Utc::now() + ttl;
        // DEC-8: the `expires_at` column is the RFC3339-UTC TEXT form and the
        // canonical clock writes millisecond precision, so the BOUND value is
        // formatted to the SAME canonical 3-digit form (`%Y-%m-%dT%H:%M:%S%.3fZ`)
        // — a lexicographic comparison between a stored and a generated instant is
        // then chronological, exactly the txresbench-auth sqlite convention
        // (`refresh_tokens::register`'s ExpiryTz bind).
        let expires_at_str = expires_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        sqlx::query!(
            r#"INSERT INTO mcp_pairing_codes (id, code, user_id, expires_at) VALUES ($1, $2, $3, $4)"#,
            id,
            code,
            user_id,
            expires_at_str,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(code)
    }

    /// Atomically claim `code`: single-use + TTL enforced by the WHERE
    /// clause (mirrors `refresh_tokens::claim_rotation_and_register`'s
    /// atomic-claim pattern) — two concurrent exchanges of the same code can
    /// both run this UPDATE, but the single-writer transaction serializes
    /// them, so only one observes `used_at IS NULL` and wins (Postgres' row
    /// lock; on SQLite the write lock is the statement's own mutation, the
    /// ITEM-18/19 single-writer doctrine). Returns the code's owning
    /// `user_id` on success, `None` if the code is unknown, already used, or
    /// expired.
    ///
    /// Once claimed, the row is physically DELETEd (defense-in-depth beyond
    /// the `used_at` marking the atomic UPDATE above already performs): a
    /// used/expired code can never be inspected again, and the table doesn't
    /// accumulate spent rows. The delete happens AFTER the atomic claim
    /// (best-effort — a failure there is non-fatal), so it can never weaken
    /// the single-use guarantee: two concurrent exchanges still race on the
    /// row's write lock exactly as before, and only the winner ever reaches
    /// the delete.
    pub async fn claim(&self, code: &str) -> Result<Option<Uuid>, AppError> {
        let row = sqlx::query!(
            r#"
            UPDATE mcp_pairing_codes
            SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE code = $1 AND used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
            RETURNING id as "id: Uuid", user_id as "user_id: Uuid"
            "#,
            code,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let Some(row) = row else {
            return Ok(None);
        };

        if let Err(e) = sqlx::query!("DELETE FROM mcp_pairing_codes WHERE id = $1", row.id)
            .execute(&self.pool)
            .await
        {
            tracing::warn!(error = %e, "mcp: failed to delete claimed pairing code (non-fatal)");
        }

        Ok(Some(row.user_id))
    }
}

/// `POST /api/mcp/pair/start` — gated `mcp::use`. Mints a code + returns the
/// MCP URL txresbench dials to exchange it (the loopback base pinned at module
/// init; direct-HTTP transport only this slice — ITEM-23 reverse-tunnel is
/// descoped).
pub async fn pair_start(
    auth: RequirePermissions<(McpUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<PairStartResponse>> {
    // Read-at-use (issue #54): the pairing-code TTL is admin-tunable via the
    // `mcp_settings` row; a never-PUT deployment reads the compiled default
    // (the compiled default == the cache's `defaults()`, INV-1).
    let ttl = super::settings_cache::get(&pool).await.pairing_ttl();
    let repo = PairingRepository::new(pool);
    let code = repo
        .create(auth.user.id, ttl)
        .await
        .map_err(AppError::to_api_error)?;
    let base = handlers::base_url().unwrap_or_default();
    let mcp_url = format!("{base}/api/mcp");
    Ok((StatusCode::OK, Json(PairStartResponse { code, mcp_url })))
}

/// `POST /api/mcp/pair/exchange` — deliberately UNGATED (no
/// `RequirePermissions` extractor): the one-time code is itself the
/// credential, per CONTRACT.md. Claims the code, then mints a session token
/// pair for its owning user via the SAME path every login-shaped flow uses.
///
/// **Token scope, by design (DEC-4):** the minted pair is a FULL account
/// session token — identical in scope to a normal username/password login,
/// NOT restricted to the MCP surface. This is intentional for slice 1: the
/// AI host is trusted to act AS the user, the same trust boundary as the
/// user logging into the AI host itself. The practical consequence is that a
/// leaked AI-host credential (e.g. an exfiltrated txresbench-chat MCP connection
/// secret) is a FULL account takeover, not merely MCP-scoped access —
/// operators should treat pairing a new AI host with the same caution as
/// sharing a password. Permission-scoped / audience-restricted MCP tokens
/// (e.g. a JWT audience claim the `mcp::use`-gated routes could check
/// in addition to the account-wide claims) are a documented follow-up
/// hardening slice, not implemented here.
pub async fn pair_exchange(
    Extension(pool): Extension<SqlitePool>,
    Extension(jwt): Extension<Arc<JwtService>>,
    Json(body): Json<PairExchangeRequest>,
) -> ApiResult<Json<PairExchangeResponse>> {
    let repo = PairingRepository::new(pool.clone());
    let user_id = repo
        .claim(&body.code)
        .await
        .map_err(AppError::to_api_error)?
        .ok_or_else(|| {
            AppError::unauthorized(
                "INVALID_CODE",
                "pairing code is invalid, expired, or already used",
            )
            .to_api_error()
        })?;

    let user = UserRepository::new(pool.clone())
        .get_by_id(user_id)
        .await
        .map_err(AppError::to_api_error)?
        .filter(|u| u.is_active)
        .ok_or_else(|| {
            AppError::unauthorized(
                "INVALID_CODE",
                "the pairing code's user is no longer available",
            )
            .to_api_error()
        })?;

    let minted = txresbench_auth::auth::refresh_tokens::mint_session_tokens(
        &pool,
        &jwt,
        user.id,
        &user.username,
        &user.email,
        user.is_admin,
    )
    .await
    .map_err(AppError::to_api_error)?;

    Ok((
        StatusCode::OK,
        Json(PairExchangeResponse {
            access_token: minted.pair.access_token,
            refresh_token: minted.pair.refresh_token,
            expires_in: minted.pair.expires_in,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn fresh_unused_code_within_ttl_is_claimable() {
        let n = now();
        assert!(code_is_claimable(None, n + Duration::minutes(5), n));
    }

    #[test]
    fn already_used_code_is_never_claimable_even_before_expiry() {
        let n = now();
        assert!(!code_is_claimable(
            Some(n - Duration::seconds(1)),
            n + Duration::minutes(5),
            n
        ));
    }

    #[test]
    fn expired_unused_code_is_not_claimable() {
        let n = now();
        assert!(!code_is_claimable(None, n - Duration::seconds(1), n));
    }

    #[test]
    fn exactly_at_expiry_is_not_claimable() {
        // `expires_at > now`, strictly — the boundary instant itself is expired.
        let n = now();
        assert!(!code_is_claimable(None, n, n));
    }

    #[test]
    fn used_and_expired_is_not_claimable() {
        let n = now();
        assert!(!code_is_claimable(
            Some(n - Duration::minutes(10)),
            n - Duration::minutes(1),
            n
        ));
    }
}
