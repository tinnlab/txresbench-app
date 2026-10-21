//! The meter-event push API (ITEM-9 — **PROV-B2-3**, bound by B1 + B4).
//!
//! `report_usage` resolves the account's Stripe Customer (PROV-B2-1) and pushes a
//! Billing-Meters event (`POST /v1/billing/meter_events`) via the client. The
//! `identifier` is the exactly-once idempotency key (BQ-INV-1) — Stripe dedups on
//! it, so a re-send with the same identifier is a no-op at Stripe. B1 computes the
//! per-account rollup overage delta and CALLS this; B4 reports usage alerts; B2
//! provides the push, not the schedule. Locally satisfied against PROV-B0-3.

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use super::client::StripeClient;
use super::repository::resolve_customer;

/// Push one usage event for `account_id` to Stripe Billing Meters (PROV-B2-3).
///
/// `event_name` is the meter's event name (e.g. `compute_seconds`,
/// `storage_gb_months`); `value` is the metered quantity; `identifier` is the
/// exactly-once idempotency key. Errors if the account has no Stripe Customer yet
/// (usage can't be metered before the account has subscribed) — the caller (B1/B4)
/// decides whether that is fatal or a skip.
pub async fn report_usage(
    pool: &PgPool,
    client: &StripeClient,
    account_id: Uuid,
    event_name: &str,
    value: f64,
    identifier: &str,
) -> Result<(), AppError> {
    let customer = resolve_customer(pool, account_id).await?.ok_or_else(|| {
        AppError::bad_request(
            "NO_STRIPE_CUSTOMER",
            "account has no Stripe customer; cannot report usage before checkout",
        )
    })?;
    // Stripe's Meter Events API takes `value` as a string.
    let value_str = format_value(value);
    client
        .push_meter_event(event_name, &customer, &value_str, identifier)
        .await
}

/// Serialize a meter value the way Stripe expects (a plain decimal string, integers
/// without a trailing `.0`).
fn format_value(value: f64) -> String {
    if value.fract() == 0.0 {
        // Whole number → no trailing `.0` (Stripe wants "42", not "42.0").
        format!("{}", value as i64)
    } else {
        // Fractional → Rust's default `f64` Display (no exponent for finite
        // magnitudes, minimal digits): 12.5 → "12.5".
        format!("{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_formats_integers_without_fraction() {
        assert_eq!(format_value(42.0), "42");
        assert_eq!(format_value(0.0), "0");
        assert_eq!(format_value(12.5), "12.5");
    }
}
