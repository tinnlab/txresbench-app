//! Admin read-any-account billing surface (#36) — the cross-account, PATH-scoped READS of
//! ANY account's subscription / usage / quota, for an `is_admin` / `billing::admin` caller.
//!
//! This is the Tier-1 billing twin of the Tier-0 `admin::AdminAccountScope` seam: it resolves
//! an account by the PATH `{account_id}` WITHOUT the membership requirement (contrast the
//! self-serve `ActiveAccount` extractor, which 404s a non-member), gated on `billing::admin`
//! (NOT `admin::accounts` — the cross-account BILLING key, #32). It lives in the saas-gated
//! `billing` module (INV-4) so no `billing::admin` / Stripe symbol leaks into the
//! desktop/default binary — the whole surface compiles out with the module.
//!
//! It REUSES the self-serve read functions (`repository::list_usage`,
//! `handlers::build_quota_state`, `repository::account_subscription_state`), path-scoped for
//! admin: every handler passes `scope.account_id` (the resolved PATH id) to the account-keyed
//! reads, never the `X-Account-Id` membership header, so the response is always the RIGHT
//! account's data (INV-5). READ-only — set/override (spend-cap-for-any, plan-override,
//! credits) are Tier-2 (#38/#39).
//!
//! Order of operations in the extractor (SECURITY-CRITICAL, mirrors `AdminAccountScope`):
//!   1. authenticate (401),
//!   2. authorize on `is_admin || billing::admin` → **403** UNIFORMLY *before* any lookup
//!      (so the admin route is not an existence oracle),
//!   3. read the PATH `account_id` (400 malformed / 500 wiring bug),
//!   4. resolve the account → **404** if it does not exist.

use std::sync::Arc;

use aide::axum::routing::{delete_with, get_with, put_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use aide::OperationIo;
use axum::extract::{FromRequestParts, Path, Query, RawPathParams};
use axum::http::{request::Parts, StatusCode};
use axum::{Extension, Json};
use sqlx::PgPool;
use uuid::Uuid;

use ziee_auth::auth::DefaultIdentityResolver;
use ziee_core::{ApiResult, AppError};
use ziee_framework::permissions::IdentityResolver;

use crate::modules::account::{Account, AccountRepository};
use crate::modules::admin::ACCOUNT_PATH_PARAM;
use crate::modules::permissions::{principal_holds, with_permission, PermissionCheck};

use super::dunning::is_suspended;
use super::handlers::build_quota_state;
use super::models::{
    total_pages, AccountUsageResponse, AdminBillingStateResponse, AdminPlanOverrideResponse,
    CreditBalanceResponse, CreditGrantResponse, GrantCreditRequest, PremiumOverrideRequest,
    PremiumOverrideResponse, QuotaStateResponse, SetPlanRequest, UsagePaginationQuery,
};
use super::permissions::BillingAdmin;
use super::repository::{
    account_plan_state, account_subscription_state, clear_account_plan_override, credit_balance,
    get_credit_grant, insert_credit_grant, list_credit_grants, list_usage, quota_override,
    revoke_credit_grant, set_account_plan_override, set_quota_override, CreditGrant,
    PlanOverrideState,
};

/// An admin-scoped, membership-free view onto ONE account's BILLING, resolved by path id for a
/// caller proven `is_admin` or holding `billing::admin`. `#[aide(input)]` so it is transparent
/// to the OpenAPI schema (a request-context extractor, not a body). Distinct from
/// `admin::AdminAccountScope` only in the permission it gates on (`billing::admin`, not
/// `admin::accounts`) — so a pure `admin::accounts` holder without `billing::admin` does NOT
/// reach the billing reads, and a `billing::admin` holder without `admin::accounts` DOES.
#[derive(Debug, Clone, OperationIo)]
#[aide(input)]
pub struct AdminBillingScope {
    /// The path-scoped account id (proven to exist).
    pub account_id: Uuid,
    /// The resolved account row — handed to the handler so it need not re-read.
    pub account: Account,
    /// The authenticated ADMIN's user id (#39) — stamped into `granted_by`/`set_by`/`revoked_by`
    /// on a credit/premium mutation so the ledger is auditable (INV-4). Captured from the same
    /// `authenticate` step the authz decision uses.
    pub admin_user_id: Uuid,
}

/// Pure resolver over `(name, value)` path pairs — robust to additional params on nested
/// routes. Absent `account_id` ⇒ 500 (route wiring bug); malformed value ⇒ 400. Split out so
/// it is unit-testable without an axum request (`RawPathParams` has no public constructor).
/// Keyed on the SHARED `admin::ACCOUNT_PATH_PARAM` constant so the route declaration and this
/// extractor cannot drift (the same constant the Tier-0 admin extractor uses).
fn resolve_account_id_param<'a>(
    mut pairs: impl Iterator<Item = (&'a str, &'a str)>,
) -> Result<Uuid, AppError> {
    let raw = pairs
        .find(|(k, _)| *k == ACCOUNT_PATH_PARAM)
        .map(|(_, v)| v)
        .ok_or_else(|| {
            AppError::internal_error(format!(
                "admin billing route is missing the `{ACCOUNT_PATH_PARAM}` path parameter"
            ))
        })?;
    Uuid::parse_str(raw.trim())
        .map_err(|_| AppError::bad_request("INVALID_ACCOUNT_ID", "account_id must be a UUID"))
}

impl FromRequestParts<()> for AdminBillingScope {
    type Rejection = (StatusCode, AppError);

    fn from_request_parts(
        parts: &mut Parts,
        _state: &(),
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            // Same app-installed resolver `RequirePermissions`/`ActiveAccount`/`AdminAccountScope`
            // use (runs AFTER identity). Missing resolver ⇒ 500 (server misconfig).
            let resolver = parts
                .extensions
                .get::<Arc<DefaultIdentityResolver>>()
                .cloned()
                .ok_or_else(|| {
                    AppError::internal_error("Identity resolver not configured").to_api_error()
                })?;

            // 1. authenticate (401 on any auth failure).
            let user = resolver.authenticate(parts).await?;

            // 2. authorize FIRST — is_admin OR the billing::admin grant — BEFORE any account
            //    lookup, so a non-admin's 403 cannot depend on account existence (no oracle).
            //    Admins skip the group query (the `principal_holds` short-circuit).
            let authorized = if user.is_admin {
                true
            } else {
                let groups = resolver.load_groups(&user).await?;
                principal_holds(&user, &groups, BillingAdmin::PERMISSION)
            };
            if !authorized {
                return Err(AppError::forbidden(
                    "BILLING_ADMIN_REQUIRED",
                    "Cross-account billing access requires the billing::admin permission",
                )
                .to_api_error());
            }

            // 3. read the path account id (400 malformed / 500 wiring bug).
            let params = RawPathParams::from_request_parts(parts, &())
                .await
                .map_err(|rej| {
                    AppError::internal_error(format!("admin billing route path params: {rej}"))
                        .to_api_error()
                })?;
            let account_id =
                resolve_account_id_param(params.iter()).map_err(|e| e.to_api_error())?;

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

            Ok(AdminBillingScope {
                account_id,
                account,
                admin_user_id: user.id,
            })
        }
    }
}

/// The `/api/admin/accounts/{account_id}/{billing,usage,quota}` READ routes (mounted under
/// `/api` by the billing module, behind the same §16 `BillingConfig` kill-switch as the
/// self-serve routes).
pub fn admin_billing_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/admin/accounts/{account_id}/billing",
            get_with(get_admin_account_billing, get_admin_account_billing_docs),
        )
        .api_route(
            "/admin/accounts/{account_id}/usage",
            get_with(get_admin_account_usage, get_admin_account_usage_docs),
        )
        .api_route(
            "/admin/accounts/{account_id}/quota",
            get_with(get_admin_account_quota, get_admin_account_quota_docs),
        )
        // #39 — the credit ledger + comp/premium override WRITE surface (Tier-2). Same
        // `AdminBillingScope` gate + §16 kill-switch + saas gate as the reads above.
        .api_route(
            "/admin/accounts/{account_id}/credits",
            get_with(get_admin_account_credits, get_admin_account_credits_docs)
                .post_with(grant_admin_account_credit, grant_admin_account_credit_docs),
        )
        .api_route(
            "/admin/accounts/{account_id}/credits/{grant_id}",
            delete_with(revoke_admin_account_credit, revoke_admin_account_credit_docs),
        )
        .api_route(
            "/admin/accounts/{account_id}/premium",
            put_with(put_admin_account_premium, put_admin_account_premium_docs),
        )
        // #38 — the admin plan/tier override (write plan_id directly, no Stripe) + clear. Same
        // `AdminBillingScope` gate + §16 kill-switch + saas gate.
        .api_route(
            "/admin/accounts/{account_id}/plan",
            put_with(put_admin_account_plan, put_admin_account_plan_docs)
                .delete_with(clear_admin_account_plan, clear_admin_account_plan_docs),
        )
}

/// Map the plan-override state row to the wire DTO (shared by the PUT + DELETE responses).
fn to_plan_override_response(s: PlanOverrideState) -> AdminPlanOverrideResponse {
    AdminPlanOverrideResponse {
        account_id: s.account_id,
        plan_id: s.plan_id,
        plan_manually_set: s.plan_manually_set,
        plan_override_at: s.plan_override_at,
        plan_override_by: s.plan_override_by,
    }
}

/// Read + map the account's plan-override state (used after each mutation so the response reflects
/// the fresh persisted state). The extractor already proved the account exists; `None` is
/// defensive (a delete racing the read) → 404, never 500.
async fn read_plan_state(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<AdminPlanOverrideResponse, AppError> {
    let s = account_plan_state(pool, account_id)
        .await?
        .ok_or_else(|| AppError::not_found("Account"))?;
    Ok(to_plan_override_response(s))
}

/// `PUT /api/admin/accounts/{account_id}/plan` (#38): set an admin plan/tier override. Validates
/// `plan_id` against the code-defined catalog (400 `INVALID_PLAN` on unknown), writes `plan_id`
/// DIRECTLY (no Stripe round-trip) and marks it manually-set so a later webhook cannot clobber it
/// (DEC-6). Records the acting admin. Emits a billing-state sync. Returns the fresh plan state.
async fn put_admin_account_plan(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<SetPlanRequest>,
) -> ApiResult<Json<AdminPlanOverrideResponse>> {
    req.validate()
        .map_err(|m| AppError::bad_request("INVALID_PLAN", m).to_api_error())?;
    // The catalog is the authoritative plan set (a COGS boundary out of an operator's reach); an
    // unknown id would make `check_quota` fail closed, so refuse it at write time (DEC-11).
    if super::catalog::plan(req.plan_id.trim()).is_none() {
        return Err(AppError::bad_request(
            "INVALID_PLAN",
            format!("unknown plan id '{}'", req.plan_id.trim()),
        )
        .to_api_error());
    }
    set_account_plan_override(&pool, scope.account_id, req.plan_id.trim(), scope.admin_user_id)
        .await
        .map_err(|e| e.to_api_error())?;
    super::sync::publish_account_billing_changed(&pool, scope.account_id).await;
    let body = read_plan_state(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(body)))
}

/// `DELETE /api/admin/accounts/{account_id}/plan` (#38): clear the admin plan override — hand plan
/// control back to Stripe (the NEXT webhook reconciles `plan_id`). Leaves the current `plan_id`
/// as-is. Idempotent. Emits a billing-state sync. Returns the fresh plan state.
async fn clear_admin_account_plan(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<AdminPlanOverrideResponse>> {
    clear_account_plan_override(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    super::sync::publish_account_billing_changed(&pool, scope.account_id).await;
    let body = read_plan_state(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(body)))
}

/// Build the wire DTO for one ledger row, computing the derived `active` flag (not revoked AND not
/// expired) against the current instant.
fn to_grant_response(g: &CreditGrant) -> CreditGrantResponse {
    let now = chrono::Utc::now();
    let active = g.revoked_at.is_none() && g.expires_at.map(|e| e > now).unwrap_or(true);
    CreditGrantResponse {
        id: g.id,
        account_id: g.account_id,
        amount_cents: g.amount_cents,
        reason: g.reason.clone(),
        granted_by: g.granted_by,
        expires_at: g.expires_at,
        revoked_at: g.revoked_at,
        revoked_by: g.revoked_by,
        created_at: g.created_at,
        active,
    }
}

/// Compose the `{balance, ledger}` response for an account (shared by the GET read + the mutation
/// responses so a grant/revoke returns the fresh state without a client round-trip).
async fn build_credit_balance(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<CreditBalanceResponse, AppError> {
    let balance_cents = credit_balance(pool, account_id).await?;
    let grants = list_credit_grants(pool, account_id).await?;
    Ok(CreditBalanceResponse {
        account_id,
        balance_cents,
        grants: grants.iter().map(to_grant_response).collect(),
    })
}

/// `GET /api/admin/accounts/{account_id}/credits` (#39): ANY account's effective credit balance +
/// full ledger (incl. revoked/expired rows, audit view). Gated by `AdminBillingScope`.
async fn get_admin_account_credits(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<CreditBalanceResponse>> {
    let body = build_credit_balance(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(body)))
}

/// `POST /api/admin/accounts/{account_id}/credits` (#39): grant credits to an account. Validates
/// `amount_cents > 0` + a non-empty reason (typed 400; a DB CHECK backs the amount). Records the
/// authenticated admin as `granted_by` (INV-4). Emits a quota-changed sync. Returns the fresh
/// balance + ledger.
async fn grant_admin_account_credit(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<GrantCreditRequest>,
) -> ApiResult<Json<CreditBalanceResponse>> {
    req.validate()
        .map_err(|m| AppError::bad_request("INVALID_CREDIT_GRANT", m).to_api_error())?;
    insert_credit_grant(
        &pool,
        scope.account_id,
        req.amount_cents,
        req.reason.trim(),
        scope.admin_user_id,
        req.expires_at,
    )
    .await
    .map_err(|e| e.to_api_error())?;
    super::sync::publish_account_quota_changed(&pool, scope.account_id).await;
    let body = build_credit_balance(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(body)))
}

/// `DELETE /api/admin/accounts/{account_id}/credits/{grant_id}` (#39): revoke a grant (stamp
/// `revoked_at`/`revoked_by` — NEVER hard-delete, INV-4). 404 if the grant does not exist OR
/// belongs to a different account (no cross-account revoke). A grant already revoked → 200 no-op
/// (idempotent, INV-7). Emits a quota-changed sync. Returns the fresh balance + ledger.
async fn revoke_admin_account_credit(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
    // Positional path params of `/admin/accounts/{account_id}/credits/{grant_id}` — the first is
    // re-validated by `AdminBillingScope` (the authoritative resolved id, used below); the second
    // names the grant to revoke.
    Path((_account_id, grant_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<CreditBalanceResponse>> {
    // 404 a nonexistent or foreign-account grant BEFORE acting (never reveal/act on another
    // account's grant through this account's path).
    let grant = get_credit_grant(&pool, grant_id)
        .await
        .map_err(|e| e.to_api_error())?
        .filter(|g| g.account_id == scope.account_id)
        .ok_or_else(|| AppError::not_found("Credit grant").to_api_error())?;

    // Idempotent: only a currently-active grant is newly revoked; a re-revoke changes nothing.
    if grant.revoked_at.is_none() {
        revoke_credit_grant(&pool, grant_id, scope.account_id, scope.admin_user_id)
            .await
            .map_err(|e| e.to_api_error())?;
        super::sync::publish_account_quota_changed(&pool, scope.account_id).await;
    }
    let body = build_credit_balance(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(body)))
}

/// `PUT /api/admin/accounts/{account_id}/premium` (#39): set/clear the comp/premium override
/// (unlimited allowance, INV-3). Records the authenticated admin as `set_by`. Emits a
/// quota-changed sync. Returns the persisted override.
async fn put_admin_account_premium(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<PremiumOverrideRequest>,
) -> ApiResult<Json<PremiumOverrideResponse>> {
    set_quota_override(
        &pool,
        scope.account_id,
        req.premium,
        req.reason.as_deref(),
        scope.admin_user_id,
    )
    .await
    .map_err(|e| e.to_api_error())?;
    super::sync::publish_account_quota_changed(&pool, scope.account_id).await;
    let ov = quota_override(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((
        StatusCode::OK,
        Json(PremiumOverrideResponse {
            account_id: scope.account_id,
            premium: ov.premium,
            reason: ov.reason,
            set_by: ov.set_by,
            updated_at: ov.updated_at,
        }),
    ))
}

/// `GET /api/admin/accounts/{account_id}/billing` (#36): ANY account's subscription state
/// (plan_id / subscription_status / grace_until + derived `suspended`), resolved by PATH id.
/// Gated to `is_admin` / `billing::admin` by the `AdminBillingScope` extractor.
async fn get_admin_account_billing(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<AdminBillingStateResponse>> {
    // The extractor already proved the account exists; `None` is defensive (a delete racing the
    // read) and maps to 404, never a 500.
    let (plan_id, subscription_status, grace_until) =
        account_subscription_state(&pool, scope.account_id)
            .await
            .map_err(|e| e.to_api_error())?
            .ok_or_else(|| AppError::not_found("Account").to_api_error())?;
    let suspended = is_suspended(&subscription_status);
    // Read projections of the WRITE-only override surfaces so the admin console can show the LIVE
    // state (#38/#39): the comp/premium allowance override, the admin plan-override marker, and the
    // effective credit balance. `plan_manually_set` is defensive-`false` if the plan-state read
    // races a delete (`None`) — the subscription read above already proved the account exists.
    let premium = quota_override(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?
        .premium;
    let plan_manually_set = account_plan_state(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?
        .map(|s| s.plan_manually_set)
        .unwrap_or(false);
    let credit_balance_cents = credit_balance(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((
        StatusCode::OK,
        Json(AdminBillingStateResponse {
            account_id: scope.account_id,
            plan_id,
            subscription_status,
            grace_until,
            suspended,
            premium,
            plan_manually_set,
            credit_balance_cents,
        }),
    ))
}

/// `GET /api/admin/accounts/{account_id}/usage` (#36): ANY account's `usage_rollup` rows
/// (compute core-h / gpu-h / storage GB-months, per period), newest first, paginated. REUSES
/// the self-serve `list_usage` + `AccountUsageResponse`, path-scoped to `scope.account_id`.
async fn get_admin_account_usage(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
    Query(q): Query<UsagePaginationQuery>,
) -> ApiResult<Json<AccountUsageResponse>> {
    let (page, per_page) = q.clamped();
    let (rows, total) = list_usage(&pool, scope.account_id, page, per_page)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((
        StatusCode::OK,
        Json(AccountUsageResponse {
            rows,
            total,
            page,
            per_page,
            total_pages: total_pages(total, per_page),
        }),
    ))
}

/// `GET /api/admin/accounts/{account_id}/quota` (#36): ANY account's quota state — plan-derived
/// limits + current-period consumption + spend cap + alert levels. REUSES the self-serve
/// `build_quota_state` (a pure account-keyed reader), path-scoped to `scope.account_id`.
async fn get_admin_account_quota(
    scope: AdminBillingScope,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<QuotaStateResponse>> {
    let state = build_quota_state(&pool, scope.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(state)))
}

fn get_admin_account_billing_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Read ANY account's subscription state (plan_id / subscription_status / grace_until \
             + a derived `suspended`) by path id (cross-account admin). Requires `billing::admin` \
             (or is_admin); a caller without it gets 403 (before any lookup), an admin on a \
             nonexistent id gets 404. saas-only.",
        )
        .id("Admin.getAccountBilling")
        .tag("admin")
        .response::<200, Json<AdminBillingStateResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn get_admin_account_usage_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "List ANY account's usage-rollup rows (per-period billable compute-core-hours / \
             gpu-hours / storage-GB-months), newest first, paginated (`?page=&per_page=`), by \
             path id (cross-account admin). Requires `billing::admin` (or is_admin); 403 without \
             it, 404 on a nonexistent id. saas-only.",
        )
        .id("Admin.getAccountUsage")
        .tag("admin")
        .response::<200, Json<AccountUsageResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn get_admin_account_quota_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Read ANY account's quota state — plan-derived compute/storage allowances, \
             current-period usage, the opt-in spend cap (cents; null when unset), and the \
             per-resource usage-alert level — by path id (cross-account admin). Requires \
             `billing::admin` (or is_admin); 403 without it, 404 on a nonexistent id. saas-only.",
        )
        .id("Admin.getAccountQuota")
        .tag("admin")
        .response::<200, Json<QuotaStateResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn get_admin_account_credits_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Read ANY account's admin-granted credit balance + full ledger (incl. revoked/expired \
             rows, audit view) by path id. Credits are integer cents of overage-admission budget \
             the quota engine consults before the plan-derived verdict. Requires `billing::admin` \
             (or is_admin); 403 without it, 404 on a nonexistent id. saas-only.",
        )
        .id("Admin.getAccountCredits")
        .tag("admin")
        .response::<200, Json<CreditBalanceResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn grant_admin_account_credit_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Grant credits to ANY account by path id (append-only ledger). Body: `amount_cents` \
             (> 0), `reason` (required), optional `expires_at`. A subsequent quota check for the \
             account reflects the grant (a Block becomes Allow, or overage is offset). Records the \
             admin as `granted_by`. Requires `billing::admin`; 400 on a non-positive amount or \
             empty reason, 403 without the permission, 404 on a nonexistent id. saas-only.",
        )
        .id("Admin.grantAccountCredit")
        .tag("admin")
        .response::<200, Json<CreditBalanceResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description("`amount_cents` ≤ 0 or empty `reason` (`INVALID_CREDIT_GRANT`)")
        })
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn revoke_admin_account_credit_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Revoke a credit grant by id (stamps `revoked_at`/`revoked_by` — NEVER hard-deletes; \
             the ledger row survives for audit). The revoked amount stops counting toward the \
             balance. Idempotent: re-revoking is a no-op. Requires `billing::admin`; 403 without \
             it, 404 if the grant does not exist or belongs to a different account. saas-only.",
        )
        .id("Admin.revokeAccountCredit")
        .tag("admin")
        .response::<200, Json<CreditBalanceResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| {
            r.description("No such grant (or it belongs to a different account)")
        })
}

fn put_admin_account_premium_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Set or clear ANY account's comp/premium override by path id. `premium: true` comps \
             the account to unlimited plan allowance (an over-allowance quota check returns Allow, \
             independent of plan_id); it does NOT bypass a suspended (delinquent) subscription. \
             Records the admin as `set_by`. Requires `billing::admin`; 403 without it, 404 on a \
             nonexistent id. saas-only.",
        )
        .id("Admin.putAccountPremium")
        .tag("admin")
        .response::<200, Json<PremiumOverrideResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn put_admin_account_plan_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Set an admin plan/tier override for ANY account by path id: write `accounts.plan_id` \
             DIRECTLY (no Stripe round-trip) and mark it manually-set so a later Stripe webhook \
             does NOT overwrite it (the override wins until explicitly cleared). Body: `plan_id` (a \
             code-defined catalog tier, e.g. `free`/`pro`). The account's quota allowance reflects \
             the new plan immediately. Records the admin. Requires `billing::admin`; 400 on an \
             unknown/blank plan id (`INVALID_PLAN`), 403 without the permission, 404 on a \
             nonexistent id. saas-only.",
        )
        .id("Admin.setAccountPlan")
        .tag("admin")
        .response::<200, Json<AdminPlanOverrideResponse>>()
        .response_with::<400, (), _>(|r| r.description("Unknown or blank plan id (`INVALID_PLAN`)"))
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn clear_admin_account_plan_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingAdmin,)>(op)
        .description(
            "Clear an admin plan override for ANY account by path id — hand plan control back to \
             Stripe (the next webhook reconciles `plan_id`). Leaves the current `plan_id` as-is. \
             Idempotent. Requires `billing::admin`; 403 without it, 404 on a nonexistent id. \
             saas-only.",
        )
        .id("Admin.clearAccountPlan")
        .tag("admin")
        .response::<200, Json<AdminPlanOverrideResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unit-cover the pure path-param resolver (the DB-backed authz/resolution is the
    // integration acceptance suite `tests/billing/admin_billing_read_test.rs`). A well-formed
    // `account_id` resolves; an extra nested param is ignored; a malformed value 400s and an
    // absent param 500s — never a panic, never a silent fallthrough that could widen the scope.
    #[test]
    fn resolve_picks_account_id_ignoring_other_params() {
        let id = Uuid::new_v4();
        let ids = id.to_string();
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
