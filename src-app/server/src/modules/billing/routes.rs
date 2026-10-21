//! Billing HTTP routes (aide-documented) — the self-serve Checkout + Portal
//! surfaces (ITEM-3/-4 / **PROV-B2-4**). Gating mirrors `jobs/routes.rs`
//! (`with_permission` in the `_docs` fn + a `RequirePermissions` extractor in the
//! handler). Both are `billing::manage` + account-scoped (`ActiveAccount`).

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;

use crate::modules::permissions::with_permission;

use super::handlers::{
    create_checkout, create_portal, get_catalog, get_quota, get_settings, get_usage, put_settings,
    put_spend_cap,
};
use super::models::{
    AccountUsageResponse, BillingSettings, CheckoutResponse, PortalResponse, QuotaStateResponse,
};
use super::permissions::{BillingManage, BillingRead};
use super::webhook::stripe_webhook;

/// The `/billing/*` routes (mounted under `/api` by the app router).
pub fn billing_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/billing/checkout",
            post_with(create_checkout, create_checkout_docs),
        )
        .api_route(
            "/billing/portal",
            post_with(create_portal, create_portal_docs),
        )
        .api_route("/billing/usage", get_with(get_usage, get_usage_docs))
        // B4 (ITEM-5 / PROV-B4-2): the account-scoped quota-state read + spend-cap PUT.
        .api_route("/billing/quota", get_with(get_quota, get_quota_docs))
        .api_route(
            "/billing/quota/spend-cap",
            aide::axum::routing::put_with(put_spend_cap, put_spend_cap_docs),
        )
        // B3 (PROV-B3-2): the signature-authenticated reconciliation boundary. NO
        // `RequirePermissions` — the Stripe signature IS the auth (DEC-8).
        .api_route(
            "/billing/webhook",
            post_with(stripe_webhook, stripe_webhook_docs),
        )
        // B3 (ITEM-9 / DEC-6) + #41: the deployment-wide billing settings singleton
        // (grace + overage projection rates + webhook retention/tolerance).
        .api_route(
            "/billing/settings",
            get_with(get_settings, get_settings_docs).put_with(put_settings, put_settings_docs),
        )
        // #41 (ITEM-5): the READ-ONLY plan catalog view (code-defined, no PUT — INV-1).
        .api_route("/billing/catalog", get_with(get_catalog, get_catalog_docs))
}

fn get_catalog_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingManage,)>(op)
        .description(
            "Read the code-defined plan catalog — each tier's id, compute/storage/SEAT allowance, \
             and hard-cap-vs-overage policy. READ-ONLY: the plan set + allowance policy are a \
             COGS boundary kept out of an operator's reach (there is no PUT). Stripe price ids \
             are omitted (env-sourced deployment config). A deployment singleton (not \
             account-scoped). Requires `billing::manage`.",
        )
        .id("Billing.getCatalog")
        .tag("billing")
        .response::<200, Json<Vec<super::catalog::PlanCatalogEntry>>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
}

fn stripe_webhook_docs(op: TransformOperation) -> TransformOperation {
    // Deliberately NO `with_permission` — the route is signature-authenticated, not JWT
    // (DEC-8). A blind authz audit should read this as intentional: Stripe cannot present a
    // token, so the HMAC signature verify is the load-bearing security control (INV-2).
    op.description(
        "Stripe webhook reconciliation boundary (server-to-server; NOT called by a browser). \
         The raw body is HMAC-SHA256 signature-verified against the configured `whsec_` \
         (Stripe's `t=,v1=` scheme, 300s tolerance) — the signature IS the authentication, so \
         this route carries NO JWT/permission gate (the documented exception). Dedupes on the \
         Stripe `event.id` (a redelivered event is a 200 no-op), then drives the account \
         billing-state machine (active/past_due/canceled) + the suspend-never-delete dunning \
         lifecycle. Returns 200 on accept/duplicate/unhandled-type; 401 on a bad signature.",
    )
    .id("Billing.webhook")
    .tag("billing")
    .response_with::<200, (), _>(|r| r.description("Accepted (or a duplicate/unhandled no-op)"))
    .response_with::<401, (), _>(|r| {
        r.description("Missing / invalid / stale Stripe signature (`BAD_STRIPE_SIGNATURE`)")
    })
    .response_with::<400, (), _>(|r| {
        r.description("Verified but the event envelope was unparseable")
    })
}

fn get_quota_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingRead,)>(op)
        .description(
            "Get the ACTIVE account's quota state — plan-derived compute/storage allowances, \
             current-period usage, the SEAT allowance + live member count (#141), the opt-in spend cap (cents; null when unset), and the \
             per-resource usage-alert level (0/50/80/95/100). Account-scoped via `X-Account-Id` \
             (a cross-account id 404s at the extractor). Requires `billing::read`.",
        )
        .id("Billing.quota")
        .tag("billing")
        .response::<200, Json<QuotaStateResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| {
            r.description("The `X-Account-Id` account is not one the caller is a member of")
        })
}

fn put_spend_cap_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingManage,)>(op)
        .description(
            "Set or clear the ACTIVE account's opt-in overage spend cap (`overage_cap_cents`; \
             null clears it). When a cap is set, the quota check flips a paid account's \
             over-allowance usage to BlockOverQuota once the projected overage cost would \
             exceed the cap (the customer's own bill-shock guard). A negative cap → 400. \
             Account-scoped. Requires `billing::manage`.",
        )
        .id("Billing.setSpendCap")
        .tag("billing")
        .response::<200, Json<QuotaStateResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description("`overage_cap_cents` is negative (`INVALID_SPEND_CAP`)")
        })
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| {
            r.description("The `X-Account-Id` account is not one the caller is a member of")
        })
}

fn get_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingManage,)>(op)
        .description(
            "Get the deployment-wide dunning grace-period setting (`grace_period_days`, the \
             window an account keeps working after a failed payment before it is suspended). \
             A deployment singleton (not account-scoped). Requires `billing::manage`.",
        )
        .id("Billing.getSettings")
        .tag("billing")
        .response::<200, Json<BillingSettings>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
}

fn put_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingManage,)>(op)
        .description(
            "Partial-update the deployment-wide billing settings (every field optional; absent \
             = unchanged). `grace_period_days` (1..=90) keeps its 400 `INVALID_GRACE_PERIOD` \
             contract; the operational knobs — `overage_cents_per_core_hour`/`_gb_month` \
             (>0..=1000000), `webhook_event_retention_days` (1..=3650), \
             `webhook_signature_tolerance_secs` (30..=900) — return 422 out of range. The \
             acting admin is recorded in `updated_by` (audit). Read-at-use: the next webhook / \
             quota check honors the new values. Requires `billing::manage`.",
        )
        .id("Billing.putSettings")
        .tag("billing")
        .response::<200, Json<BillingSettings>>()
        .response_with::<400, (), _>(|r| {
            r.description("`grace_period_days` out of the 1..=90 bounds (`INVALID_GRACE_PERIOD`)")
        })
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<422, (), _>(|r| {
            r.description(
                "An operational knob is out of range (`INVALID_OVERAGE_RATE` / \
                 `INVALID_RETENTION` / `INVALID_TOLERANCE`)",
            )
        })
}

fn get_usage_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingRead,)>(op)
        .description(
            "List the ACTIVE account's usage-rollup rows (per-period billable \
             compute-core-hours / gpu-hours / storage-GB-months), newest period first, \
             paginated (`?page=&per_page=`). Account-scoped: the acting account is the \
             `X-Account-Id` context, so the rows are that account's only (a cross-account \
             `X-Account-Id` 404s at the extractor). Requires `billing::read`.",
        )
        .id("Billing.usage")
        .tag("billing")
        .response::<200, Json<AccountUsageResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| {
            r.description("The `X-Account-Id` account is not one the caller is a member of")
        })
}

fn create_checkout_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingManage,)>(op)
        .description(
            "Create a subscription-mode Stripe Checkout Session for the ACTIVE account's \
             chosen plan and return its hosted `checkout_url`. Account-scoped: the acting \
             account is the `X-Account-Id` context (a cross-account request 404s). The \
             account's plan is NOT flipped here — the `checkout.session.completed` webhook \
             does that, so an abandoned hosted page changes nothing.",
        )
        .id("Billing.checkout")
        .tag("billing")
        .response::<200, Json<CheckoutResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description("Unknown plan id, or the Stripe request was rejected")
        })
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| {
            r.description("The `X-Account-Id` account is not one the caller is a member of")
        })
}

fn create_portal_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(BillingManage,)>(op)
        .description(
            "Create a Stripe Customer Portal Session for the ACTIVE account and return its \
             hosted `portal_url` (self-manage plan change / cancel / payment method). \
             Account-scoped. An account that has never checked out (no Stripe Customer yet) \
             gets a typed 400, not a 500.",
        )
        .id("Billing.portal")
        .tag("billing")
        .response::<200, Json<PortalResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description("The account has no Stripe customer yet (start checkout first)")
        })
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<404, (), _>(|r| {
            r.description("The `X-Account-Id` account is not one the caller is a member of")
        })
}
