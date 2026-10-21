//! Billing request/response DTOs (the `/api/billing/*` wire types).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use ziee_core::AppError;

// ─────────────────────────── B3 webhook envelope (DEC-9) ───────────────────────────
//
// The THIN Stripe event envelope B3 deserializes (NOT a full async-stripe typed `Event` —
// there is no such dep, DEC-1). Only `id` / `type` / `data.object` are needed; per-arm the
// dispatcher reaches into `object` for the minimal fields (`customer`, `status`, the price
// id). NOT a wire DTO — internal to the webhook path, so no `JsonSchema`/OpenAPI surface.

/// The Stripe `event` envelope over the raw webhook body.
#[derive(Debug, Clone, Deserialize)]
pub struct StripeEvent {
    /// The Stripe event id — the idempotency key (`billing_webhook_events` PK, INV-3).
    pub id: String,
    /// The event type (`checkout.session.completed` / `customer.subscription.updated` / …).
    #[serde(rename = "type")]
    pub type_: String,
    /// The `data.object` payload (a checkout session / subscription / invoice).
    pub data: StripeEventData,
}

/// The `data` wrapper of a Stripe event (only `object` is consumed).
#[derive(Debug, Clone, Deserialize)]
pub struct StripeEventData {
    pub object: serde_json::Value,
}

// ─────────────────────────── B3 billing-settings DTOs (ITEM-9) ──────────────────────

/// `GET /api/billing/settings` response — the deployment-wide billing config singleton.
/// `grace_period_days` is the original DEC-6 dunning window; #41 (admin-settings-coverage)
/// added the four operational knobs (overage projection rates, webhook retention/tolerance)
/// that were previously bare source constants, plus `updated_by` (the audit column stamped
/// from the acting admin on the last PUT). Every value is bounds-validated at PUT (in
/// `validate()`) AND by a DB CHECK.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BillingSettings {
    /// The dunning grace window (days) B3 sets on `invoice.payment_failed`
    /// (`grace_until = now() + grace_period_days`). Admin-configurable; default 14.
    pub grace_period_days: i32,
    /// cents/core-hour used to project a paid account's overage cost against its spend cap
    /// (`quota.rs`). Default 10.0. NOT a plan ALLOWANCE (those stay code-defined, INV-1).
    pub overage_cents_per_core_hour: f64,
    /// cents/GB-month for the same spend-cap projection (`quota.rs`). Default 5.0.
    pub overage_cents_per_gb_month: f64,
    /// Days processed Stripe webhook dedupe rows are kept before pruning (`rollup.rs`). Default 90.
    pub webhook_event_retention_days: i64,
    /// Clock-skew window (seconds) accepted on a Stripe webhook signature (`webhook.rs`). Default 300.
    pub webhook_signature_tolerance_secs: i64,
    /// The admin who last PUT these settings (audit — #41 INV-4). `None` on the seeded row
    /// before any PUT.
    pub updated_by: Option<Uuid>,
}

/// `PUT /api/billing/settings` body — a PARTIAL update: every field is `Option`, and an absent
/// field leaves the stored value unchanged (COALESCE). Mirrors `UpdateSandboxResourceLimits`.
/// Backward-compatible with the old full-body PUT that sent only `{grace_period_days}`.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateBillingSettingsRequest {
    #[serde(default)]
    pub grace_period_days: Option<i32>,
    #[serde(default)]
    pub overage_cents_per_core_hour: Option<f64>,
    #[serde(default)]
    pub overage_cents_per_gb_month: Option<f64>,
    #[serde(default)]
    pub webhook_event_retention_days: Option<i64>,
    #[serde(default)]
    pub webhook_signature_tolerance_secs: Option<i64>,
}

/// The inclusive bounds an admin-supplied `grace_period_days` must fall within (DEC-6).
pub const GRACE_PERIOD_MIN_DAYS: i32 = 1;
pub const GRACE_PERIOD_MAX_DAYS: i32 = 90;
/// #41 DEC-4 bounds (mirror the DB CHECKs). Conservative operational ranges preventing an
/// admin footgun; adjustable by the owner.
///
/// The overage rate is an EXCLUSIVE-lower bound: it must be strictly `> 0`. A rate of 0 would
/// zero the spend-cap projection in `check_quota`, silently disabling a paid account's opt-in
/// bill-shock guard (a customer protection an operator should not be able to switch off by
/// mistake) — so 0 is rejected (FIX_ROUND-1, security). The upper bound is a generous ceiling.
pub const OVERAGE_RATE_MIN_CENTS: f64 = 0.0; // exclusive — rate must be > this
pub const OVERAGE_RATE_MAX_CENTS: f64 = 1_000_000.0;
pub const RETENTION_MIN_DAYS: i64 = 1;
pub const RETENTION_MAX_DAYS: i64 = 3650;
pub const TOLERANCE_MIN_SECS: i64 = 30;
/// Max webhook signature clock-skew tolerance. Bounded well above Stripe's 300 s default (to
/// absorb real skew) but far below a wide replay window (FIX_ROUND-1 tightened 3600 → 900;
/// replay is additionally neutralized by the `billing_webhook_events` idempotency dedupe).
pub const TOLERANCE_MAX_SECS: i64 = 900;

impl BillingSettings {
    /// Validate every field against its bounds. `grace_period_days` keeps its original
    /// **400 `INVALID_GRACE_PERIOD`** contract (backward-compat with the pre-#41 handler);
    /// the #41 operational knobs are **422** (matching the sandbox/jobs settings convention).
    /// Validated on the MERGED candidate before the DB write, so the DB never holds an invalid
    /// value.
    pub fn validate(&self) -> Result<(), AppError> {
        if !(GRACE_PERIOD_MIN_DAYS..=GRACE_PERIOD_MAX_DAYS).contains(&self.grace_period_days) {
            return Err(AppError::bad_request(
                "INVALID_GRACE_PERIOD",
                format!(
                    "grace_period_days must be {GRACE_PERIOD_MIN_DAYS}..={GRACE_PERIOD_MAX_DAYS} (got {})",
                    self.grace_period_days
                ),
            ));
        }
        for (label, v) in [
            ("overage_cents_per_core_hour", self.overage_cents_per_core_hour),
            ("overage_cents_per_gb_month", self.overage_cents_per_gb_month),
        ] {
            if !v.is_finite() || v <= OVERAGE_RATE_MIN_CENTS || v > OVERAGE_RATE_MAX_CENTS {
                return Err(AppError::unprocessable_entity(
                    "INVALID_OVERAGE_RATE",
                    format!("{label} must be > {OVERAGE_RATE_MIN_CENTS} and <= {OVERAGE_RATE_MAX_CENTS} (got {v})"),
                ));
            }
        }
        if !(RETENTION_MIN_DAYS..=RETENTION_MAX_DAYS).contains(&self.webhook_event_retention_days) {
            return Err(AppError::unprocessable_entity(
                "INVALID_RETENTION",
                format!(
                    "webhook_event_retention_days must be {RETENTION_MIN_DAYS}..={RETENTION_MAX_DAYS} (got {})",
                    self.webhook_event_retention_days
                ),
            ));
        }
        if !(TOLERANCE_MIN_SECS..=TOLERANCE_MAX_SECS)
            .contains(&self.webhook_signature_tolerance_secs)
        {
            return Err(AppError::unprocessable_entity(
                "INVALID_TOLERANCE",
                format!(
                    "webhook_signature_tolerance_secs must be {TOLERANCE_MIN_SECS}..={TOLERANCE_MAX_SECS} (got {})",
                    self.webhook_signature_tolerance_secs
                ),
            ));
        }
        Ok(())
    }

    /// Overlay a partial update onto the current row, producing the candidate to validate +
    /// write. An absent (`None`) field is left unchanged (the COALESCE contract). `updated_by`
    /// is set by the caller (the handler), not by the wire body.
    pub fn merge(&self, req: &UpdateBillingSettingsRequest) -> BillingSettings {
        BillingSettings {
            grace_period_days: req.grace_period_days.unwrap_or(self.grace_period_days),
            overage_cents_per_core_hour: req
                .overage_cents_per_core_hour
                .unwrap_or(self.overage_cents_per_core_hour),
            overage_cents_per_gb_month: req
                .overage_cents_per_gb_month
                .unwrap_or(self.overage_cents_per_gb_month),
            webhook_event_retention_days: req
                .webhook_event_retention_days
                .unwrap_or(self.webhook_event_retention_days),
            webhook_signature_tolerance_secs: req
                .webhook_signature_tolerance_secs
                .unwrap_or(self.webhook_signature_tolerance_secs),
            updated_by: self.updated_by,
        }
    }
}

#[cfg(test)]
mod billing_settings_tests {
    use super::*;

    fn defaults() -> BillingSettings {
        BillingSettings {
            grace_period_days: 14,
            overage_cents_per_core_hour: 10.0,
            overage_cents_per_gb_month: 5.0,
            webhook_event_retention_days: 90,
            webhook_signature_tolerance_secs: 300,
            updated_by: None,
        }
    }

    // TEST-5 [covers ITEM-2]: validate() enforces every field's bounds; grace stays 400,
    // the #41 knobs are 422; in-range passes.
    #[test]
    fn validate_bounds() {
        assert!(defaults().validate().is_ok(), "defaults are in-range");

        // grace keeps its original 400 / INVALID_GRACE_PERIOD contract.
        let mut s = defaults();
        s.grace_period_days = 0;
        let e = s.validate().unwrap_err();
        assert_eq!(e.error_code(), "INVALID_GRACE_PERIOD");

        // overage rate: zero (would disable the spend-cap guard), negative, above-ceiling,
        // and non-finite are all rejected (422). Zero is the FIX_ROUND-1 case.
        for bad in [0.0, -1.0, OVERAGE_RATE_MAX_CENTS + 1.0, f64::NAN, f64::INFINITY] {
            let mut s = defaults();
            s.overage_cents_per_core_hour = bad;
            assert_eq!(
                s.validate().unwrap_err().error_code(),
                "INVALID_OVERAGE_RATE",
                "overage rate {bad} rejected"
            );
        }

        // retention 1..=3650.
        for bad in [0, RETENTION_MAX_DAYS + 1] {
            let mut s = defaults();
            s.webhook_event_retention_days = bad;
            assert_eq!(s.validate().unwrap_err().error_code(), "INVALID_RETENTION");
        }

        // tolerance 30..=3600.
        for bad in [5, TOLERANCE_MAX_SECS + 1] {
            let mut s = defaults();
            s.webhook_signature_tolerance_secs = bad;
            assert_eq!(s.validate().unwrap_err().error_code(), "INVALID_TOLERANCE");
        }
    }

    // TEST-6 [covers ITEM-2]: merge() leaves absent fields unchanged and applies present ones
    // (the COALESCE contract), and never touches updated_by from the wire body.
    #[test]
    fn merge_is_partial() {
        let current = defaults();
        // Only retention set → everything else unchanged.
        let req = UpdateBillingSettingsRequest {
            webhook_event_retention_days: Some(120),
            ..Default::default()
        };
        let merged = current.merge(&req);
        assert_eq!(merged.webhook_event_retention_days, 120, "set field applied");
        assert_eq!(merged.grace_period_days, 14, "absent field unchanged");
        assert_eq!(merged.overage_cents_per_core_hour, 10.0, "absent field unchanged");
        assert_eq!(merged.webhook_signature_tolerance_secs, 300, "absent field unchanged");
        assert!(merged.updated_by.is_none(), "merge does not set updated_by from the body");

        // Multiple fields set.
        let req2 = UpdateBillingSettingsRequest {
            grace_period_days: Some(7),
            overage_cents_per_gb_month: Some(8.5),
            ..Default::default()
        };
        let merged2 = current.merge(&req2);
        assert_eq!(merged2.grace_period_days, 7);
        assert_eq!(merged2.overage_cents_per_gb_month, 8.5);
        assert_eq!(merged2.overage_cents_per_core_hour, 10.0, "untouched");
    }
}

/// Pagination query (`?page=&per_page=`) for `GET /api/billing/usage`. Defaults 1 /
/// 20; clamped on read (page ≥ 1, per_page 1..=100) so a caller can't request an
/// unbounded page (coding-guidelines §4). Billing-local mirror of the user module's
/// query — kept here so `billing` does not depend on `user` internals.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UsagePaginationQuery {
    #[serde(default = "default_page")]
    pub page: i32,
    #[serde(default = "default_per_page")]
    pub per_page: i32,
}

fn default_page() -> i32 {
    1
}
fn default_per_page() -> i32 {
    20
}

impl UsagePaginationQuery {
    /// `(page ≥ 1, per_page ∈ 1..=100)`.
    pub fn clamped(&self) -> (i32, i32) {
        (self.page.max(1), self.per_page.clamp(1, 100))
    }
}

/// Ceil-divide `total` into pages of `per_page`.
pub fn total_pages(total: i64, per_page: i32) -> i64 {
    if per_page > 0 {
        (total + per_page as i64 - 1) / per_page as i64
    } else {
        0
    }
}

/// `POST /api/billing/checkout` body — which plan to subscribe to.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CheckoutRequest {
    /// The plan/tier id (a `billing::catalog` key, e.g. `"pro"`).
    pub plan_id: String,
}

/// `POST /api/billing/checkout` response — the hosted Checkout page URL to redirect
/// the browser to. The account's plan is NOT flipped here (INV-2); B3's webhook does.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CheckoutResponse {
    pub checkout_url: String,
}

/// `POST /api/billing/portal` response — the hosted Customer Portal URL.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PortalResponse {
    pub portal_url: String,
}

/// One `usage_rollup` row on the wire (PROV-B1-2). The account's per-period billable
/// figures the usage dashboard renders. Keyed on `account_id` (INV-2); never carries a
/// user id. The `last_meter_seen`/`reported_at`/`stripe_usage_ref` bookkeeping is
/// exposed read-only so the UI can show "reported vs pending".
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct UsageRollupRow {
    pub id: uuid::Uuid,
    pub account_id: uuid::Uuid,
    pub period_start: chrono::DateTime<chrono::Utc>,
    pub period_end: chrono::DateTime<chrono::Utc>,
    pub compute_core_hours: f64,
    pub gpu_hours: f64,
    pub storage_gb_months: f64,
    pub egress_gb: f64,
    /// The compute high-water mark (nullable until the first compute fold).
    pub last_meter_seen: Option<chrono::DateTime<chrono::Utc>>,
    /// When last reported to Stripe (nullable ⇒ pending/dirty).
    pub reported_at: Option<chrono::DateTime<chrono::Utc>>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// `GET /api/billing/usage` response — the active account's rollup rows, paginated
/// (PROV-B1-2). Mirrors the `UserListResponse` pagination envelope.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AccountUsageResponse {
    pub rows: Vec<UsageRollupRow>,
    pub total: i64,
    pub page: i32,
    pub per_page: i32,
    pub total_pages: i64,
}

// ─────────────────────────── B4 quota DTOs (ITEM-5 — PROV-B4-2) ──────────────────────

/// `GET /api/billing/quota` response — the active account's quota state (ITEM-5): plan-derived
/// limits + current-period usage + the opt-in spend cap + the per-resource alert level. The
/// usage-dashboard's current-vs-allowance bands, alert badge and spend-cap editor bind this.
/// Account-scoped (INV-4). `saas`-only (the route compiles out of desktop).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct QuotaStateResponse {
    /// The account's plan id (`accounts.plan_id`).
    pub plan_id: String,
    /// Plan compute allowance in CORE-HOURS (projected from B2's catalog).
    pub compute_allowance: f64,
    /// Plan storage allowance in GB-MONTHS.
    pub storage_allowance: f64,
    /// Current-period compute usage (core-hours + gpu-hours) from `usage_rollup`.
    pub compute_used: f64,
    /// Current-period storage usage (GB-months) from `usage_rollup`.
    pub storage_used: f64,
    /// Plan SEAT allowance (#141) — the max number of `account_members` rows this account
    /// may hold. Paired with `members_used` so the FE renders "7 of 10 seats".
    ///
    /// A hard COUNT, not a metered allowance: `overage`/`hard_cap` below describe usage and
    /// say nothing about seats, so a `pro` account is refused a 51st member rather than
    /// billed for it. Enforced transactionally at membership creation (`account::seat`);
    /// the #39 `premium` comp lifts it.
    pub member_allowance: i64,
    /// The account's CURRENT member count — a live `SELECT count(*) FROM account_members`,
    /// not a `usage_rollup` figure (there is no headcount dimension there). May legitimately
    /// EXCEED `member_allowance` for an account that predates the limit or was un-comped:
    /// the limit gates new memberships and evicts nobody, so the FE must render `used > limit`
    /// rather than assume it cannot happen.
    pub members_used: i64,
    /// Plan meters overage beyond the allowance (paid tiers).
    pub overage: bool,
    /// Plan hard-blocks at the allowance (free tier).
    pub hard_cap: bool,
    /// The account is suspended (terminal billing-state) — new consumption is gated.
    pub suspended: bool,
    /// The opt-in spend cap in cents, or `null` when no cap is set (§4.3 default).
    pub spend_cap_cents: Option<i64>,
    /// The highest alert-ladder rung already fired this period for compute (0/50/80/95/100).
    pub alert_level_compute: i16,
    /// The highest alert-ladder rung already fired this period for storage.
    pub alert_level_storage: i16,
}

// ─────────────────────────── Admin read-any-account DTOs (#36) ──────────────────────

/// `GET /api/admin/accounts/{account_id}/billing` response (#36) — ANY account's
/// subscription state, resolved by PATH id for an `is_admin` / `billing::admin` caller (the
/// `AdminBillingScope` extractor). `saas`-only (the route compiles out of desktop with the
/// billing module). The FE admin Subscription page (#45) binds this. The `subscription_status`
/// + `grace_until` come straight from the `accounts` billing columns B3 writes; `suspended` is
/// the derived terminal-state flag (`dunning::is_suspended`) so the FE need not re-derive it.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AdminBillingStateResponse {
    /// The account the state belongs to (echoes the resolved path id — INV-5, path-scoped).
    pub account_id: uuid::Uuid,
    /// The account's current plan id (`accounts.plan_id`).
    pub plan_id: String,
    /// The Stripe subscription lifecycle state (`active` / `past_due` / `canceled` / …).
    pub subscription_status: String,
    /// The dunning grace deadline (`null` unless a payment failed and the grace window is open).
    pub grace_until: Option<chrono::DateTime<chrono::Utc>>,
    /// Derived: the account is in a suspended (terminal) billing state — new consumption gated.
    pub suspended: bool,
    /// The comp/premium allowance override (`account_quota_override.premium`, #39) — `true` means
    /// the account is comped to UNLIMITED plan allowance. Read projection of the WRITE-only
    /// `PUT .../premium` surface (so the admin console can show the live override, not just set it).
    pub premium: bool,
    /// The admin plan-override marker (`accounts.plan_manually_set`, #38) — `true` means an admin
    /// pinned `plan_id` directly (no Stripe) and a later webhook will NOT clobber it. Read
    /// projection of the WRITE-only `PUT/DELETE .../plan` surface.
    pub plan_manually_set: bool,
    /// The account's current EFFECTIVE credit balance in integer cents (#39) — the SUM of active
    /// (non-revoked, non-expired) `credit_grants`, `0` when none. The SAME active-grant sum the
    /// admission engine's `credit_balance()` reads (INV-2), projected for the admin console.
    pub credit_balance_cents: i64,
}

/// `PUT /api/billing/quota/spend-cap` body — set (or, with `null`, clear) the opt-in
/// per-account overage spend cap in cents (ITEM-2). A negative value is a typed 400.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SpendCapRequest {
    /// The overage cap in integer cents; `null` clears the cap (no cap = paid tiers never
    /// hard-block on usage, the §4.3 opt-in default).
    pub overage_cap_cents: Option<i64>,
}

impl SpendCapRequest {
    /// `Ok` iff the cap is absent (clear) or `≥ 0` (a negative cap is a footgun).
    pub fn validate(&self) -> Result<(), String> {
        match self.overage_cap_cents {
            Some(c) if c < 0 => Err(format!("overage_cap_cents must be ≥ 0 (got {c})")),
            _ => Ok(()),
        }
    }
}

// ─────────────────────────── #39 credit / comp-premium DTOs ──────────────────────────

/// `POST /api/admin/accounts/{account_id}/credits` body (#39) — grant credits to an account. The
/// amount is integer CENTS of overage-admission budget (DEC-1); `reason` is the required audit
/// note; `expires_at = null` never expires. Admin-gated (`billing::admin`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct GrantCreditRequest {
    /// The grant amount in integer cents (must be > 0).
    pub amount_cents: i64,
    /// The admin's human reason for the comp (required, non-empty — audit trail, INV-4).
    pub reason: String,
    /// When the grant stops counting; `null` = never expires.
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl GrantCreditRequest {
    /// `Ok` iff `amount_cents > 0` and `reason` is non-empty (a DB CHECK backs the amount).
    pub fn validate(&self) -> Result<(), String> {
        if self.amount_cents <= 0 {
            return Err(format!("amount_cents must be > 0 (got {})", self.amount_cents));
        }
        if self.reason.trim().is_empty() {
            return Err("reason must not be empty".to_string());
        }
        Ok(())
    }
}

/// One `credit_grants` ledger row on the wire (#39) — the audit view, incl. revoked + expired rows.
/// `active` is the derived "counts toward the balance right now" flag (not revoked AND not expired).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CreditGrantResponse {
    pub id: uuid::Uuid,
    pub account_id: uuid::Uuid,
    pub amount_cents: i64,
    pub reason: String,
    pub granted_by: uuid::Uuid,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub revoked_by: Option<uuid::Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Derived: the grant counts toward the balance right now (not revoked AND not expired).
    pub active: bool,
}

/// `GET /api/admin/accounts/{account_id}/credits` response (#39) — the effective balance + the
/// FULL ledger (newest first). The FE Credits page (#47) binds this.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CreditBalanceResponse {
    pub account_id: uuid::Uuid,
    /// The effective credit balance in cents = sum of active (non-revoked, non-expired) grants.
    pub balance_cents: i64,
    /// The full ledger incl. revoked/expired rows (audit, INV-4).
    pub grants: Vec<CreditGrantResponse>,
}

/// `PUT /api/admin/accounts/{account_id}/premium` body (#39) — set/clear the comp/premium override.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PremiumOverrideRequest {
    /// `true` comps the account to unlimited allowance (INV-3); `false` clears the comp.
    pub premium: bool,
    /// Optional admin audit note for the comp.
    pub reason: Option<String>,
}

/// `PUT /api/admin/accounts/{account_id}/premium` response (#39) — the persisted override state.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PremiumOverrideResponse {
    pub account_id: uuid::Uuid,
    pub premium: bool,
    pub reason: Option<String>,
    pub set_by: Option<uuid::Uuid>,
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

// ─────────────────────────── #38 admin plan-override DTOs ──────────────────────────

/// `PUT /api/admin/accounts/{account_id}/plan` body (#38) — set an admin plan override. Writes
/// `accounts.plan_id` DIRECTLY (no Stripe round-trip) and marks it manually-set so a later
/// webhook cannot clobber it. The `plan_id` MUST name a code-defined catalog tier (validated in
/// the handler; an unknown id is a typed 400). Admin-gated (`billing::admin`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SetPlanRequest {
    /// The catalog plan id to set (e.g. `"free"` / `"pro"`).
    pub plan_id: String,
}

impl SetPlanRequest {
    /// `Ok` iff `plan_id` is non-empty (the catalog membership check is the handler's, which owns
    /// the `catalog` import). A blank id is refused here as a cheap first guard.
    pub fn validate(&self) -> Result<(), String> {
        if self.plan_id.trim().is_empty() {
            return Err("plan_id must not be empty".to_string());
        }
        Ok(())
    }
}

/// `PUT`/`DELETE /api/admin/accounts/{account_id}/plan` response (#38) — the persisted plan +
/// manual-override state. The FE admin Subscription page (#45) binds this. `plan_manually_set`
/// tells the FE whether the account's plan is an admin comp (webhook-protected) or Stripe-driven.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AdminPlanOverrideResponse {
    pub account_id: uuid::Uuid,
    /// The account's current plan id (`accounts.plan_id`).
    pub plan_id: String,
    /// Whether the plan is an admin manual override (a later webhook will NOT overwrite `plan_id`).
    pub plan_manually_set: bool,
    /// When the current override was applied (`null` when not overridden).
    pub plan_override_at: Option<chrono::DateTime<chrono::Utc>>,
    /// The admin (user id) who applied it (`null` when not overridden).
    pub plan_override_by: Option<uuid::Uuid>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-4 [covers: ITEM-9]: the #38 plan-override wire types. `SetPlanRequest::validate`
    // rejects a blank plan_id + accepts a real one; `AdminPlanOverrideResponse` serializes the
    // documented shape (a rename breaks the #45 FE Subscription page).
    #[test]
    fn plan_override_wire_types_validate_and_serialize() {
        assert!(SetPlanRequest { plan_id: "pro".into() }.validate().is_ok());
        assert!(SetPlanRequest { plan_id: "   ".into() }.validate().is_err(), "blank plan_id rejected");
        assert!(SetPlanRequest { plan_id: "".into() }.validate().is_err(), "empty plan_id rejected");

        let acct = uuid::Uuid::new_v4();
        let resp = AdminPlanOverrideResponse {
            account_id: acct,
            plan_id: "pro".into(),
            plan_manually_set: true,
            plan_override_at: None,
            plan_override_by: None,
        };
        let v = serde_json::to_value(&resp).expect("serialize AdminPlanOverrideResponse");
        assert_eq!(v["account_id"], serde_json::json!(acct));
        assert_eq!(v["plan_id"], serde_json::json!("pro"));
        assert_eq!(v["plan_manually_set"], serde_json::json!(true));
        assert!(v["plan_override_at"].is_null());
    }

    // TEST-10 [covers: ITEM-6]: the grant request validates (amount > 0 + non-empty reason) and
    // the credit/premium DTOs serialize with their documented field names — a rename here silently
    // breaks the #47 FE Credits page.
    #[test]
    fn grant_request_validate_and_dto_shapes() {
        assert!(GrantCreditRequest {
            amount_cents: 500,
            reason: "partner comp".into(),
            expires_at: None,
        }
        .validate()
        .is_ok());
        assert!(GrantCreditRequest {
            amount_cents: 0,
            reason: "x".into(),
            expires_at: None,
        }
        .validate()
        .is_err(), "zero amount rejected");
        assert!(GrantCreditRequest {
            amount_cents: -5,
            reason: "x".into(),
            expires_at: None,
        }
        .validate()
        .is_err(), "negative amount rejected");
        assert!(GrantCreditRequest {
            amount_cents: 10,
            reason: "   ".into(),
            expires_at: None,
        }
        .validate()
        .is_err(), "empty reason rejected");

        let acct = uuid::Uuid::new_v4();
        let bal = CreditBalanceResponse {
            account_id: acct,
            balance_cents: 750,
            grants: vec![CreditGrantResponse {
                id: uuid::Uuid::new_v4(),
                account_id: acct,
                amount_cents: 750,
                reason: "comp".into(),
                granted_by: uuid::Uuid::new_v4(),
                expires_at: None,
                revoked_at: None,
                revoked_by: None,
                created_at: chrono::Utc::now(),
                active: true,
            }],
        };
        let v = serde_json::to_value(&bal).expect("serialize CreditBalanceResponse");
        assert_eq!(v["account_id"], serde_json::json!(acct));
        assert_eq!(v["balance_cents"], 750);
        assert_eq!(v["grants"][0]["amount_cents"], 750);
        assert_eq!(v["grants"][0]["active"], serde_json::json!(true));

        let prem = PremiumOverrideResponse {
            account_id: acct,
            premium: true,
            reason: Some("vip".into()),
            set_by: None,
            updated_at: None,
        };
        let pv = serde_json::to_value(&prem).expect("serialize PremiumOverrideResponse");
        assert_eq!(pv["premium"], serde_json::json!(true));
    }

    // TEST-6 [covers: ITEM-2]: the admin subscription-state DTO carries exactly the #36 read
    // contract (plan_id / subscription_status / grace_until) plus the derived `suspended` +
    // the echoed `account_id`, and serializes with those field names. A shape guard — a rename
    // here silently breaks the FE Subscription page (#45) that binds these keys.
    #[test]
    fn admin_billing_state_response_shape() {
        let id = uuid::Uuid::new_v4();
        let dto = AdminBillingStateResponse {
            account_id: id,
            plan_id: "pro".into(),
            subscription_status: "past_due".into(),
            grace_until: None,
            suspended: false,
            premium: true,
            plan_manually_set: true,
            credit_balance_cents: 2_500,
        };
        let v = serde_json::to_value(&dto).expect("serialize AdminBillingStateResponse");
        assert_eq!(v["account_id"], serde_json::json!(id));
        assert_eq!(v["plan_id"], "pro");
        assert_eq!(v["subscription_status"], "past_due");
        assert!(
            v.get("grace_until").is_some(),
            "grace_until is present (null-able)"
        );
        assert_eq!(v["suspended"], serde_json::json!(false));
        // TEST-1 [covers: ITEM-1]: the three #38/#39 read projections serialize with their exact
        // wire keys + values — a rename here silently breaks the admin console binding.
        assert_eq!(v["premium"], serde_json::json!(true));
        assert_eq!(v["plan_manually_set"], serde_json::json!(true));
        assert_eq!(v["credit_balance_cents"], serde_json::json!(2_500));
    }
}

// ───────────────────── Billing integration (#60) — encrypted Stripe config ─────────────────────
//
// The admin Billing-integration surface DTOs. SECURITY: the response DTO
// (`BillingIntegrationView`) carries NO secret field — only a `configured` flag and
// a `last4` fragment. The plaintext secret NEVER appears in any wire type.

/// The MASKED read view of the billing integration config (GET response). Contains
/// NO plaintext secret — only whether each secret is configured, the last-4 fragment
/// of the Stripe secret, the resolved connection status, and the price-ID mapping.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BillingIntegrationView {
    /// True when a Stripe secret is resolvable (DB-stored OR the env fallback).
    pub configured: bool,
    /// The last 4 characters of the resolved Stripe secret (display only), or `None`
    /// when unconfigured. NEVER the full key.
    pub last4: Option<String>,
    /// True when a webhook signing secret is configured (DB-stored OR env).
    pub webhook_configured: bool,
    /// Where the resolved secret comes from: `"database"`, `"environment"`, or
    /// `"unconfigured"` — an operator-facing status, never the value.
    pub connected: String,
    /// The Stripe price-ID overrides (plaintext operator config, not secret): a JSON
    /// object keyed by the catalog's price env-var names. `{}` ⇒ env/defaults.
    pub prices: serde_json::Value,
}

/// The PUT request to set/rotate the integration config. A blank/absent secret field
/// means "leave the stored secret unchanged" (a price-only edit never wipes a secret).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateBillingIntegrationRequest {
    /// A NEW Stripe secret key to store (encrypted). Absent/blank ⇒ unchanged.
    #[serde(default)]
    pub stripe_secret: Option<String>,
    /// A NEW Stripe webhook signing secret to store (encrypted). Absent/blank ⇒ unchanged.
    #[serde(default)]
    pub webhook_secret: Option<String>,
    /// Replacement price-ID mapping (plaintext). Absent ⇒ unchanged.
    #[serde(default)]
    pub prices: Option<serde_json::Value>,
}

impl UpdateBillingIntegrationRequest {
    /// The Stripe secret to store, trimmed, iff a non-blank value was supplied.
    /// Blank/whitespace ⇒ `None` (leave-unchanged).
    pub fn stripe_secret_to_store(&self) -> Option<&str> {
        self.stripe_secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
    /// The webhook secret to store, iff a non-blank value was supplied.
    pub fn webhook_secret_to_store(&self) -> Option<&str> {
        self.webhook_secret
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

/// The POST /test request: validate the STORED key, or (if supplied) a just-typed
/// candidate key without persisting it.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct TestConnectionRequest {
    /// A candidate Stripe secret to test WITHOUT storing. Absent ⇒ test the stored/env key.
    #[serde(default)]
    pub stripe_secret: Option<String>,
}

/// The POST /test response. Carries a generic operator-facing message — NEVER the key.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TestConnectionResponse {
    /// True iff the lightweight Stripe validation call succeeded.
    pub ok: bool,
    /// A generic operator-facing message (e.g. "Connection succeeded" / "Invalid key
    /// (401)"). NEVER contains the secret or the raw Stripe body.
    pub message: String,
}

#[cfg(test)]
mod integration_config_dto_tests {
    use super::*;

    // TEST-8 [covers: ITEM-4]: the masked view serializes with NO secret field.
    #[test]
    fn view_has_no_secret_field() {
        let view = BillingIntegrationView {
            configured: true,
            last4: Some("4242".to_string()),
            webhook_configured: false,
            connected: "database".to_string(),
            prices: serde_json::json!({"STRIPE_PRICE_PRO_BASE": "price_123"}),
        };
        let json = serde_json::to_string(&view).unwrap();
        // The masked fragment is present; a full-secret field name never is.
        assert!(json.contains("\"last4\":\"4242\""));
        assert!(!json.to_lowercase().contains("secret"));
        assert!(!json.contains("ciphertext"));
    }

    // TEST-8 [covers: ITEM-4]: absent/blank stripe_secret ⇒ leave-unchanged (None).
    #[test]
    fn blank_secret_is_leave_unchanged() {
        let absent: UpdateBillingIntegrationRequest =
            serde_json::from_str(r#"{"prices":{"a":"b"}}"#).unwrap();
        assert!(absent.stripe_secret_to_store().is_none());

        let blank: UpdateBillingIntegrationRequest =
            serde_json::from_str(r#"{"stripe_secret":"   "}"#).unwrap();
        assert!(blank.stripe_secret_to_store().is_none());

        let set: UpdateBillingIntegrationRequest =
            serde_json::from_str(r#"{"stripe_secret":"sk_live_abc"}"#).unwrap();
        assert_eq!(set.stripe_secret_to_store(), Some("sk_live_abc"));
    }
}
