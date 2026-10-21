//! `AdminAccountScope` — the #31 cross-account admin resolution SEAM.
//!
//! The self-serve `ActiveAccount` extractor (`account/extractor.rs`) resolves the
//! `X-Account-Id` header through `membership_role`, so a non-member gets 404 with no
//! admin bypass — an admin cannot view/act on another account. This extractor is the
//! parallel admin path (DEC-1, approach (b)): it keys off the PATH `account_id` and
//! resolves ANY account WITHOUT the membership requirement — but ONLY for a caller
//! who `is_admin` OR holds `admin::accounts`.
//!
//! It is **self-securing**: authz and resolution are bundled, so a downstream Tier-1
//! admin route (#33/#34/#35/#36) gets the authz gate for free by taking
//! `admin: AdminAccountScope` — the "resolve any account without membership" power is
//! never reachable un-gated (DEC-3).
//!
//! Order of operations (SECURITY-CRITICAL, DEC-2):
//!   1. authenticate (401 if unauthenticated),
//!   2. authorize on `is_admin || principal_holds(admin::accounts)` → **403** if not,
//!      returned UNIFORMLY *before* any account lookup, so the 403 is identical
//!      whether the account exists or not — the admin route is NOT an existence
//!      oracle (contrast the self-serve path, which returns 404 for a non-member),
//!   3. read the PATH `account_id` (400 if malformed, 500 if the route lacks the
//!      param — a wiring bug, never a client's fault),
//!   4. resolve the account → **404** if it does not exist (an authorized admin may
//!      learn existence).
//!
//! The self-serve path is UNCHANGED — this file adds a new boundary, it does not
//! touch `ActiveAccount`, so INV-1/INV-3 hold by construction.

use std::sync::Arc;

use aide::OperationIo;
use axum::extract::{FromRequestParts, RawPathParams};
use axum::http::{request::Parts, StatusCode};
use sqlx::PgPool;
use uuid::Uuid;

use ziee_auth::auth::DefaultIdentityResolver;
use ziee_core::AppError;
use ziee_framework::permissions::IdentityResolver;

use crate::modules::account::{Account, AccountRepository};
use crate::modules::permissions::{principal_holds, PermissionCheck};

use super::permissions::AdminAccounts;

/// The path parameter name every `/api/admin/accounts/{account_id}/…` route MUST use
/// for the account it scopes to. Kept as one constant so the route declaration and
/// this extractor cannot drift.
pub const ACCOUNT_PATH_PARAM: &str = "account_id";

/// An admin-scoped, membership-free view onto ONE account, resolved by path id for a
/// caller proven `is_admin` or holding `admin::accounts`. `#[aide(input)]` so it is
/// transparent to the OpenAPI schema (a request-context extractor, not a body).
#[derive(Debug, Clone, OperationIo)]
#[aide(input)]
pub struct AdminAccountScope {
    /// The path-scoped account id (proven to exist).
    pub account_id: Uuid,
    /// The resolved account row — handed to the admin handler so it need not re-read.
    pub account: Account,
    /// The authenticated ADMIN's user id (#37) — stamped into `admin_suspended_by` on a
    /// suspend mutation so the hold is auditable. Captured from the same `authenticate`
    /// step the authz decision uses (mirrors `billing::admin::AdminBillingScope`).
    pub admin_user_id: Uuid,
}

/// Pure resolver over `(name, value)` path pairs — robust to additional params on
/// nested routes (DEC-4). Absent `account_id` ⇒ 500 (route wiring bug); malformed
/// value ⇒ 400. Split out so it is unit-testable without an axum request
/// (`RawPathParams` has no public constructor).
fn resolve_account_id_param<'a>(
    mut pairs: impl Iterator<Item = (&'a str, &'a str)>,
) -> Result<Uuid, AppError> {
    let raw = pairs
        .find(|(k, _)| *k == ACCOUNT_PATH_PARAM)
        .map(|(_, v)| v)
        .ok_or_else(|| {
            AppError::internal_error(format!(
                "admin route is missing the `{ACCOUNT_PATH_PARAM}` path parameter"
            ))
        })?;
    Uuid::parse_str(raw.trim())
        .map_err(|_| AppError::bad_request("INVALID_ACCOUNT_ID", "account_id must be a UUID"))
}

/// Extract `account_id` from the matched path params (delegates to the pure
/// [`resolve_account_id_param`]).
fn account_id_from_path(params: &RawPathParams) -> Result<Uuid, AppError> {
    resolve_account_id_param(params.iter())
}

impl FromRequestParts<()> for AdminAccountScope {
    type Rejection = (StatusCode, AppError);

    fn from_request_parts(
        parts: &mut Parts,
        _state: &(),
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            // Same app-installed resolver `RequirePermissions`/`ActiveAccount` use
            // (runs AFTER identity). Missing resolver ⇒ 500 (server misconfig).
            let resolver = parts
                .extensions
                .get::<Arc<DefaultIdentityResolver>>()
                .cloned()
                .ok_or_else(|| {
                    AppError::internal_error("Identity resolver not configured").to_api_error()
                })?;

            // 1. authenticate (401 on any auth failure).
            let user = resolver.authenticate(parts).await?;

            // 2. authorize FIRST — is_admin OR the admin::accounts grant — BEFORE any
            //    account lookup, so a non-admin's 403 cannot depend on account
            //    existence (no oracle, DEC-2). Admins skip the group query (the
            //    `principal_holds` short-circuit), matching `RequirePermissions`.
            let authorized = if user.is_admin {
                true
            } else {
                let groups = resolver.load_groups(&user).await?;
                principal_holds(&user, &groups, AdminAccounts::PERMISSION)
            };
            if !authorized {
                return Err(AppError::forbidden(
                    "ADMIN_ACCOUNTS_REQUIRED",
                    "Cross-account admin access requires the admin::accounts permission",
                )
                .to_api_error());
            }

            // 3. read the path account id (400 malformed / 500 wiring bug).
            let params = RawPathParams::from_request_parts(parts, &())
                .await
                .map_err(|rej| {
                    AppError::internal_error(format!("admin route path params: {rej}"))
                        .to_api_error()
                })?;
            let account_id = account_id_from_path(&params).map_err(|e| e.to_api_error())?;

            // 4. resolve the account (404 if it does not exist).
            let pool =
                parts.extensions.get::<PgPool>().cloned().ok_or_else(|| {
                    AppError::internal_error("pool not configured").to_api_error()
                })?;
            let account = AccountRepository::new(pool)
                .get(account_id)
                .await
                .map_err(|e| e.to_api_error())?
                .ok_or_else(|| AppError::not_found("Account").to_api_error())?;

            Ok(AdminAccountScope {
                account_id,
                account,
                admin_user_id: user.id,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unit-cover the pure path-param resolver: the DB-backed authz/resolution paths
    // are the integration TEST-3..8 (they need a real user + membership rows +
    // server). A well-formed `account_id` resolves; extra params are ignored; a
    // malformed value 400s and an absent param 500s — never a panic, never a silent
    // fallthrough that could widen the scope.
    #[test]
    fn resolve_picks_account_id_ignoring_other_params() {
        let id = Uuid::new_v4();
        let ids = id.to_string();
        // A nested route's extra params must not confuse the lookup.
        let pairs = [("member_id", "x"), (ACCOUNT_PATH_PARAM, ids.as_str())];
        assert_eq!(
            resolve_account_id_param(pairs.iter().map(|(k, v)| (*k, *v))).unwrap(),
            id
        );
    }

    #[test]
    fn resolve_absent_account_id_is_500() {
        let pairs = [("member_id", "x")];
        let err = resolve_account_id_param(pairs.iter().map(|(k, v)| (*k, *v))).unwrap_err();
        assert_eq!(err.status_code(), 500);
    }

    #[test]
    fn resolve_malformed_account_id_is_400() {
        let pairs = [(ACCOUNT_PATH_PARAM, "not-a-uuid")];
        let err = resolve_account_id_param(pairs.iter().map(|(k, v)| (*k, *v))).unwrap_err();
        assert_eq!(err.status_code(), 400);
    }
}
