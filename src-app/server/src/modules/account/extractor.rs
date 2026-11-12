//! A4 ITEM-1 — the **active-account request context** (`PROV-A4-1`).
//!
//! An axum extractor [`ActiveAccount`] that runs AFTER identity resolution and
//! reads the per-request `X-Account-Id: <uuid>` header (mirroring the
//! `X-Sync-Connection-Id` echo-header carrier, `sync/event.rs`). Resolution
//! (design §7 verbatim):
//!
//! - header **absent** → `personal_account_of(user)` (CONS-A4-5 / PROV-A5-1 — the
//!   guaranteed personal account; the INV-1 default). Every current flow is
//!   unchanged for a solo user, whose active account == their personal account.
//! - header **present + user IS a member** → that account + the resolved
//!   [`AccountRole`] (INV-2).
//! - header **present + user is NOT a member** → **404** via the membership check
//!   (CONS-A4-1 / PROV-A3-1 — never 403, an existence oracle; INV-3). The
//!   membership resolution is A1's `membership_role` — the exact primitive A3's
//!   authz layer maps `None ⇒ 404`, NOT a re-implemented check.
//! - header **present but malformed** (non-UUID) → **400**.
//!
//! It is **not** baked into the JWT (a switch would need a re-mint + would outlive
//! a membership revocation until the token expires — design §7 "Why a header").
//! This is the boundary billing/metering read to attribute usage to an account:
//! `account_of(a request's writes) = ActiveAccount.account_id`.

use std::sync::Arc;

use aide::OperationIo;
use axum::extract::FromRequestParts;
use axum::http::{request::Parts, HeaderMap, StatusCode};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_auth::auth::DefaultIdentityResolver;
use txresbench_core::AppError;
use txresbench_framework::permissions::IdentityResolver;

use super::models::AccountRole;
use super::repository::AccountRepository;
use super::scope::ensure_personal_account_for;

/// The per-request header carrying the acting account (design §7). Mirrors the
/// existing `X-Sync-Connection-Id` echo-header precedent.
pub const ACCOUNT_HEADER: &str = "X-Account-Id";

/// The acting user's resolved active account for THIS request. `#[aide(input)]` so
/// it is transparent to the OpenAPI schema (a request-context extractor, not a body).
#[derive(Debug, Clone, Copy, PartialEq, Eq, OperationIo)]
#[aide(input)]
pub struct ActiveAccount {
    pub account_id: Uuid,
    /// The acting user's coarse role on `account_id` (owner for the personal
    /// default).
    pub role: AccountRole,
}

/// Parse the `X-Account-Id` header. `Ok(None)` when absent (the INV-1 default
/// path); `Ok(Some(id))` for a well-formed UUID; `Err(400)` for a malformed one
/// (never a panic, never a silent drop → an existence oracle can't be widened by a
/// parse fallthrough). Pure — unit-tested (TEST-1).
pub fn parse_account_header(headers: &HeaderMap) -> Result<Option<Uuid>, AppError> {
    match headers.get(ACCOUNT_HEADER) {
        None => Ok(None),
        Some(value) => {
            let s = value.to_str().map_err(|_| {
                AppError::bad_request(
                    "INVALID_ACCOUNT_HEADER",
                    "X-Account-Id must be a valid UTF-8 UUID",
                )
            })?;
            let id = Uuid::parse_str(s.trim()).map_err(|_| {
                AppError::bad_request("INVALID_ACCOUNT_HEADER", "X-Account-Id must be a UUID")
            })?;
            Ok(Some(id))
        }
    }
}

/// Resolve the active account for `user_id` from the (already-parsed) requested id.
///
/// - `None` (absent header) → the user's personal account (INV-1), ENSURED to exist
///   via PROV-A5-1's idempotent backstop so the default can never 404.
/// - `Some(id)` + member → `(id, role)` (INV-2).
/// - `Some(id)` + non-member → `Err(404)` (INV-3, the existence-oracle guard routed
///   through A1's `membership_role` — the PROV-A3-1 `None ⇒ 404` signal).
pub async fn resolve_active_account(
    pool: &SqlitePool,
    user_id: Uuid,
    requested: Option<Uuid>,
) -> Result<ActiveAccount, AppError> {
    let repo = AccountRepository::new(pool.clone());
    match requested {
        None => {
            // The INV-1 default. `ensure_personal_account_for` is idempotent and
            // guarantees a personal account + owner membership exist (PROV-A5-1),
            // so this branch never 404s.
            let account_id = ensure_personal_account_for(pool, user_id).await?;
            let role = repo
                .membership_role(account_id, user_id)
                .await?
                .unwrap_or(AccountRole::Owner);
            Ok(ActiveAccount { account_id, role })
        }
        Some(account_id) => match repo.membership_role(account_id, user_id).await? {
            Some(role) => Ok(ActiveAccount { account_id, role }),
            // Non-member ⇒ 404, byte-identical to a nonexistent account id (INV-3 /
            // PROV-A3-1 — never 403, never any account data).
            None => Err(AppError::not_found("Account")),
        },
    }
}

impl FromRequestParts<()> for ActiveAccount {
    type Rejection = (StatusCode, AppError);

    fn from_request_parts(
        parts: &mut Parts,
        _state: &(),
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            // Authenticate through the SAME app-installed resolver `RequirePermissions`
            // uses (runs AFTER identity, mirrors the existing extractors). A missing
            // resolver is a server misconfiguration → 500.
            let resolver = parts
                .extensions
                .get::<Arc<DefaultIdentityResolver>>()
                .cloned()
                .ok_or_else(|| {
                    AppError::internal_error("Identity resolver not configured").to_api_error()
                })?;
            let user = resolver.authenticate(parts).await?;

            let pool = parts
                .extensions
                .get::<SqlitePool>()
                .cloned()
                .ok_or_else(|| AppError::internal_error("pool not configured").to_api_error())?;

            let requested = parse_account_header(&parts.headers).map_err(|e| e.to_api_error())?;
            resolve_active_account(&pool, user.id, requested)
                .await
                .map_err(|e| e.to_api_error())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    // TEST-1 [covers: ITEM-1]: header parsing — absent → None; a well-formed UUID →
    // Some(uuid); a malformed / non-UUID value → 400 (never a panic, never a silent
    // drop). The DB-backed resolution paths (default→personal, member→role,
    // non-member→404) are the integration TEST-6/7/8 (they need real membership rows).
    #[test]
    fn parse_account_header_absent_present_and_malformed() {
        // absent → None
        let empty = HeaderMap::new();
        assert_eq!(parse_account_header(&empty).unwrap(), None);

        // well-formed → Some(uuid)
        let id = Uuid::new_v4();
        let mut ok = HeaderMap::new();
        ok.insert(
            ACCOUNT_HEADER,
            HeaderValue::from_str(&id.to_string()).unwrap(),
        );
        assert_eq!(parse_account_header(&ok).unwrap(), Some(id));

        // surrounding whitespace is tolerated (trimmed)
        let mut padded = HeaderMap::new();
        padded.insert(
            ACCOUNT_HEADER,
            HeaderValue::from_str(&format!(" {id} ")).unwrap(),
        );
        assert_eq!(parse_account_header(&padded).unwrap(), Some(id));

        // malformed → 400 (BAD_REQUEST), NOT a fallthrough to the personal default
        let mut bad = HeaderMap::new();
        bad.insert(ACCOUNT_HEADER, HeaderValue::from_static("not-a-uuid"));
        let err = parse_account_header(&bad).unwrap_err();
        assert_eq!(err.status_code(), 400);
    }
}
