//! Billing HTTP handlers — the self-serve Checkout + Portal surfaces (ITEM-3/-4 —
//! **PROV-B2-4**). Both are `RequirePermissions<(BillingManage,)>` + account-scoped
//! (the `ActiveAccount` extractor: a cross-account request 404s at the extractor, so
//! a caller can never checkout for an account they are not a member of).
//!
//! Handlers stay thin (CODING_GUIDELINES §9): SQL lives in `repository.rs`, the
//! Stripe calls in `client.rs`.

use axum::extract::Query;
use axum::{Extension, Json};
use sqlx::PgPool;
use ziee_core::{ApiResult, AppError};

use crate::modules::account::ActiveAccount;
use crate::modules::permissions::RequirePermissions;

use super::catalog;
use super::client::StripeClient;
use super::config::BillingConfig;
use super::dunning::is_suspended;
use super::models::{
    total_pages, AccountUsageResponse, BillingSettings, CheckoutRequest, CheckoutResponse,
    PortalResponse, QuotaStateResponse, SpendCapRequest, UpdateBillingSettingsRequest,
    UsagePaginationQuery,
};
use super::permissions::{BillingManage, BillingRead};
use super::quota::limits_of;
use super::repository::{
    account_billing_context, current_alert_levels, current_period_usage, ensure_stripe_customer,
    get_billing_settings, list_usage, resolve_customer, set_spend_cap, spend_cap,
    update_billing_settings,
};

/// `POST /api/billing/checkout` (ITEM-3): create a subscription-mode Checkout
/// Session for the active account's chosen plan and return its hosted `checkout_url`.
/// Follows `stripe-samples/checkout-single-subscription`. The plan is NOT flipped
/// here (INV-2) — B3's `checkout.session.completed` webhook does that, so a user who
/// abandons the hosted page changes nothing.
#[axum::debug_handler]
pub async fn create_checkout(
    auth: RequirePermissions<(BillingManage,)>,
    active: ActiveAccount,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<CheckoutRequest>,
) -> ApiResult<Json<CheckoutResponse>> {
    let _ = &auth; // permission + identity already enforced by the extractor
    let plan = catalog::plan(&req.plan_id).ok_or_else(|| {
        AppError::bad_request("UNKNOWN_PLAN", format!("no such plan: {}", req.plan_id))
            .to_api_error()
    })?;

    // #60 INV-4: resolve the Stripe secret DB-then-env (compat mode ⇒ byte-identical
    // to the old `from_env`). Built per-request, so a rotate is picked up next call.
    let client = StripeClient::resolve(&pool).await.map_err(|e| e.to_api_error())?;
    let cfg = BillingConfig::from_env();

    // Ensure the account IS the Stripe customer (INV-1): create + persist on first
    // checkout, reuse thereafter (1:1, BQ-INV-9).
    let customer = ensure_stripe_customer(&pool, &client, active.account_id)
        .await
        .map_err(|e| e.to_api_error())?;

    // #60: admin-configured price-ID overrides (else env/defaults). A read failure is
    // non-fatal — fall back to the env/default resolution (the pre-#60 behavior).
    let price_overrides = super::repository::get_billing_integration(&pool)
        .await
        .map(|r| r.price_ids)
        .unwrap_or_else(|_| serde_json::json!({}));
    let base_price = plan.base_price_id_with(&price_overrides);
    let metered_prices = plan.metered_price_ids_with(&price_overrides);
    let checkout_url = client
        .create_checkout_session(
            &customer,
            &base_price,
            &metered_prices,
            &cfg.success_url,
            &cfg.cancel_url,
            &active.account_id.to_string(),
        )
        .await
        .map_err(|e| e.to_api_error())?;

    Ok((
        axum::http::StatusCode::OK,
        Json(CheckoutResponse { checkout_url }),
    ))
}

/// `POST /api/billing/portal` (ITEM-4): create a Customer Portal Session for the
/// active account and return its hosted `portal_url`. Follows
/// `stripe-samples/customer-portal`. An account with NO Stripe Customer yet (never
/// checked out) gets a typed 400, not a 500.
#[axum::debug_handler]
pub async fn create_portal(
    auth: RequirePermissions<(BillingManage,)>,
    active: ActiveAccount,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<PortalResponse>> {
    let _ = &auth;
    let customer = resolve_customer(&pool, active.account_id)
        .await
        .map_err(|e| e.to_api_error())?
        .ok_or_else(|| {
            AppError::bad_request(
                "NO_STRIPE_CUSTOMER",
                "account has no subscription yet; start checkout before opening the portal",
            )
            .to_api_error()
        })?;

    // #60 INV-4: resolve the Stripe secret DB-then-env (compat ⇒ byte-identical).
    let client = StripeClient::resolve(&pool).await.map_err(|e| e.to_api_error())?;
    let cfg = BillingConfig::from_env();
    let portal_url = client
        .create_portal_session(&customer, &cfg.return_url)
        .await
        .map_err(|e| e.to_api_error())?;

    Ok((
        axum::http::StatusCode::OK,
        Json(PortalResponse { portal_url }),
    ))
}

/// `GET /api/billing/usage` (ITEM-4 — **PROV-B1-2**): the active account's
/// `usage_rollup` rows, newest period first, paginated. `RequirePermissions<(
/// BillingRead,)>` + account-scoped via the `ActiveAccount` extractor — a caller only
/// ever sees the rollup rows of the account they are acting in (INV-2); a cross-account
/// `X-Account-Id` 404s at the extractor, so a foreign account's usage is never visible.
#[axum::debug_handler]
pub async fn get_usage(
    auth: RequirePermissions<(BillingRead,)>,
    active: ActiveAccount,
    Extension(pool): Extension<PgPool>,
    Query(q): Query<UsagePaginationQuery>,
) -> ApiResult<Json<AccountUsageResponse>> {
    let _ = &auth; // permission + identity already enforced by the extractor
    let (page, per_page) = q.clamped();
    let (rows, total) = list_usage(&pool, active.account_id, page, per_page)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((
        axum::http::StatusCode::OK,
        Json(AccountUsageResponse {
            rows,
            total,
            page,
            per_page,
            total_pages: total_pages(total, per_page),
        }),
    ))
}

/// `GET /api/billing/quota` (B4 ITEM-5 — **PROV-B4-2**): the active account's quota state —
/// plan-derived limits + current-period usage + the opt-in spend cap + per-resource alert
/// level. `RequirePermissions<(BillingRead,)>` + account-scoped via `ActiveAccount` (a
/// cross-account `X-Account-Id` 404s at the extractor, INV-4). Composes PROV-B1-1 usage +
/// ITEM-3 limits + ITEM-2 cap + ITEM-4 alert state.
#[axum::debug_handler]
pub async fn get_quota(
    auth: RequirePermissions<(BillingRead,)>,
    active: ActiveAccount,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<QuotaStateResponse>> {
    let _ = &auth; // permission + identity already enforced by the extractor
    let state = build_quota_state(&pool, active.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((axum::http::StatusCode::OK, Json(state)))
}

/// Compose the account's quota-state DTO (shared by `get_quota` + `put_spend_cap` + the admin
/// read `admin::get_admin_account_quota`, #36): plan limits (ITEM-3) + current usage
/// (PROV-B1-1) + spend cap (ITEM-2) + alert levels (ITEM-4). A pure account-keyed READER, so
/// passing a path-resolved account id path-scopes it for the admin surface (INV-5). `pub(crate)`
/// so the sibling admin module reuses it rather than re-deriving the composition.
pub(crate) async fn build_quota_state(
    pool: &PgPool,
    account_id: uuid::Uuid,
) -> Result<QuotaStateResponse, AppError> {
    let (plan_id, subscription_status) = account_billing_context(pool, account_id)
        .await?
        .ok_or_else(|| AppError::not_found("Account"))?;
    let limits = limits_of(&plan_id).unwrap_or(super::quota::QuotaLimits {
        compute_allowance: 0.0,
        storage_allowance: 0.0,
        // An unknown plan reports a seat allowance of ZERO, which is the SAME answer
        // `billing::seat::decide_seat` gives it (#141 DEC-9: fail closed, never unlimited).
        // These two must agree or the read surface would promise seats the enforcement
        // refuses. The value is a SHARED const so the test can read what production uses —
        // it was a bare literal, and the test that claimed to pin it re-declared its own 0
        // and asserted 0 == 0 (FIX_ROUND-5, R5-1).
        member_allowance: super::quota::UNKNOWN_PLAN_MEMBER_ALLOWANCE,
        overage: false,
        hard_cap: true,
    });
    let usage = current_period_usage(pool, account_id).await?;
    // #141 — the live seat count for the "N of M seats" surface, through the account
    // module's EXISTING `count_members` (FIX_ROUND-3, R3-6: the first version added a
    // byte-identical second one taking a connection, which forced a `pool.acquire()`/`drop`
    // dance here for a plain read and put two same-named functions in two modules).
    //
    // A pooled read is correct HERE and only here: this is a read-only projection with
    // nothing to guard, unlike the enforcement in `account::seat`, which must ride the
    // mutation's own transaction.
    let members_used = crate::modules::account::AccountRepository::new(pool.clone())
        .count_members(account_id)
        .await?;
    let cap = spend_cap(pool, account_id).await?;
    let (alert_level_compute, alert_level_storage) = current_alert_levels(pool, account_id).await?;
    Ok(QuotaStateResponse {
        plan_id,
        compute_allowance: limits.compute_allowance,
        storage_allowance: limits.storage_allowance,
        compute_used: usage.compute_core_hours + usage.gpu_hours,
        storage_used: usage.storage_gb_months,
        member_allowance: limits.member_allowance,
        members_used,
        overage: limits.overage,
        hard_cap: limits.hard_cap,
        suspended: is_suspended(&subscription_status),
        spend_cap_cents: cap,
        alert_level_compute,
        alert_level_storage,
    })
}

/// `PUT /api/billing/quota/spend-cap` (B4 ITEM-5 / ITEM-2 — **PROV-B4-2**): set or clear the
/// active account's opt-in overage spend cap. `RequirePermissions<(BillingManage,)>` +
/// account-scoped. A negative cap is a typed 400 (a DB CHECK backs it). Emits a
/// `sync:account_usage` notify-and-refetch so the account's devices re-read the quota state.
#[axum::debug_handler]
pub async fn put_spend_cap(
    auth: RequirePermissions<(BillingManage,)>,
    active: ActiveAccount,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<SpendCapRequest>,
) -> ApiResult<Json<QuotaStateResponse>> {
    let _ = &auth;
    req.validate()
        .map_err(|m| AppError::bad_request("INVALID_SPEND_CAP", m).to_api_error())?;
    set_spend_cap(&pool, active.account_id, req.overage_cap_cents)
        .await
        .map_err(|e| e.to_api_error())?;
    // Notify-and-refetch: a cap change is a quota change (DEC-9, reuses AccountUsage).
    super::sync::publish_account_quota_changed(&pool, active.account_id).await;
    // Return the fresh quota state (so the client need not immediately refetch).
    let state = build_quota_state(&pool, active.account_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((axum::http::StatusCode::OK, Json(state)))
}

/// `GET /api/billing/settings` (ITEM-9 + #41): the deployment-wide billing config singleton —
/// `grace_period_days` plus the #41 operational knobs (overage projection rates, webhook
/// retention/tolerance) and the `updated_by` audit stamp. Deployment-wide singleton (mirrors
/// `project_settings`), NOT account-scoped — so no `ActiveAccount` extractor. Gated
/// `billing::manage` (reuses B2's permission, no new perm).
#[axum::debug_handler]
pub async fn get_settings(
    auth: RequirePermissions<(BillingManage,)>,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<BillingSettings>> {
    let _ = &auth;
    let settings = get_billing_settings(&pool)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((axum::http::StatusCode::OK, Json(settings)))
}

/// `PUT /api/billing/settings` (ITEM-9 + #41): PARTIAL update of the deployment-wide billing
/// config. Every field is optional (absent = unchanged, COALESCE). Bounds-validated on the
/// MERGED candidate before the write — `grace_period_days` keeps its `1..=90` / **400
/// `INVALID_GRACE_PERIOD`** contract; the #41 knobs are **422** (DB CHECKs back them). The
/// acting admin is stamped into `updated_by` (audit, #41 INV-4). Read-at-use: the next
/// webhook / quota check honors the new values (no cache to invalidate).
#[axum::debug_handler]
pub async fn put_settings(
    auth: RequirePermissions<(BillingManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<UpdateBillingSettingsRequest>,
) -> ApiResult<Json<BillingSettings>> {
    // Validate the MERGED candidate (current ⊕ request) for the typed 422 error, then apply
    // the partial update ATOMICALLY via SQL COALESCE from the request itself (not the merged
    // struct) — so a concurrent PUT of a DIFFERENT field is not clobbered (FIX_ROUND-1). The
    // DB CHECKs are the atomic backstop if the row moved between the read and the write.
    let current = get_billing_settings(&pool)
        .await
        .map_err(|e| e.to_api_error())?;
    current.merge(&req).validate().map_err(|e| e.to_api_error())?;
    let stored = update_billing_settings(&pool, &req, auth.user.id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((axum::http::StatusCode::OK, Json(stored)))
}

/// `GET /api/billing/catalog` (#41 ITEM-5): the READ-ONLY plan catalog view — each plan's id +
/// compute/storage allowance + hard-cap/overage policy (NO Stripe price ids). The catalog is
/// **code-defined and NOT editable** (INV-1: a COGS boundary must not be operator-weakened),
/// so there is deliberately NO PUT. Gated `billing::manage` (reuses B2's permission, no new perm).
#[axum::debug_handler]
pub async fn get_catalog(
    auth: RequirePermissions<(BillingManage,)>,
) -> ApiResult<Json<Vec<catalog::PlanCatalogEntry>>> {
    let _ = &auth;
    Ok((axum::http::StatusCode::OK, Json(catalog::catalog_view())))
}
