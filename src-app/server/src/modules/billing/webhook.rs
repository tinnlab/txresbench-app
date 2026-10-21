//! B3 — the `POST /api/billing/webhook` reconciliation boundary (ITEM-1/-2/-4 —
//! **PROV-B3-2**). The SINGLE route that keeps every account's billing-state in sync with
//! Stripe and drives the payment-failure lifecycle, WITHOUT ever deleting tenant data (INV-1).
//!
//! Shape (follows `stripe-samples/checkout-single-subscription` `server.js`: capture the RAW
//! body BEFORE parsing → `constructEvent(rawBody, sig, whsec)` → branch on `event.type` →
//! 2xx/4xx):
//!   raw `Bytes` → [`verify_signature`] (real `t=,v1=` HMAC-SHA256, DEC-1) → parse the thin
//!   envelope → [`to_billing_event`] → `dunning::next_state` → `repository::process_webhook`
//!   (idempotent dedupe + state write in ONE txn) → 200; a bad signature → 401.
//!
//! **NO `RequirePermissions` on this route (DEC-8).** Stripe is the caller and cannot present
//! a JWT — the signature verify IS the authentication (the load-bearing INV-2 control). This
//! is the one documented exception to the §1 "every route gates authz in the handler
//! signature" rule; every OTHER billing route keeps its extractor. The whole `billing` module
//! is `#[cfg(feature = "saas")]` at its parent declaration, so this route + the `hmac` usage
//! compile out of desktop (INV-5).

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::Extension;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use sqlx::PgPool;
use ziee_core::{ApiResult, AppError};

use super::dunning::{self, BillingEvent};
use super::models::StripeEvent;
use super::{catalog, repository, sync};

type HmacSha256 = Hmac<Sha256>;

/// Stripe's webhook-signature freshness tolerance: reject a body whose `t` is more than this
/// many seconds in the past (`now - t > tolerance`). One-sided, matching Stripe's libraries.
pub const SIGNATURE_TOLERANCE_SECS: i64 = 300;

// ─────────────────────────────── signature verify (INV-2) ──────────────────────────────

/// The hex `v1` signature over `"{ts}.{raw_body}"`, keyed by `whsec` — the raw documented
/// Stripe scheme (no client library), byte-identical to what PROV-B0-2's injector signs.
fn v1_signature(raw_body: &[u8], whsec: &str, ts: i64) -> String {
    // HMAC accepts a key of any length, so `new_from_slice` cannot fail.
    let mut mac = HmacSha256::new_from_slice(whsec.as_bytes()).expect("HMAC key of any length");
    mac.update(ts.to_string().as_bytes());
    mac.update(b".");
    mac.update(raw_body);
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time byte-equality (length is not secret — both are 64-char hex).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Verify a `Stripe-Signature` header over `raw_body`, exactly as a spec-compliant Stripe
/// library does (INV-2 / DEC-1): parse `t` + all `v1` elements (several during secret
/// rotation), enforce the freshness window one-sided (`now - t > tolerance` → reject),
/// recompute `v1` and constant-time-compare against each provided value. `Err(())` on a
/// missing timestamp / no `v1` scheme / stale `t` / no matching signature — the handler maps
/// every one to 401 `BAD_STRIPE_SIGNATURE`.
pub fn verify_signature(
    raw_body: &[u8],
    sig_header: &str,
    whsec: &str,
    tolerance_secs: i64,
    now: i64,
) -> Result<(), ()> {
    let mut t: Option<i64> = None;
    let mut v1s: Vec<String> = Vec::new();
    for element in sig_header.split(',') {
        let element = element.trim();
        let Some((k, v)) = element.split_once('=') else {
            continue; // a malformed element is ignored, like Stripe's parser
        };
        match k.trim() {
            "t" => t = v.trim().parse::<i64>().ok(),
            "v1" => v1s.push(v.trim().to_string()),
            _ => {} // v0 and any future scheme are ignored — only v1 is verified
        }
    }
    let t = t.ok_or(())?;
    if v1s.is_empty() {
        return Err(());
    }
    if now - t > tolerance_secs {
        return Err(());
    }
    let expected = v1_signature(raw_body, whsec, t);
    if v1s
        .iter()
        .any(|got| ct_eq(got.as_bytes(), expected.as_bytes()))
    {
        Ok(())
    } else {
        Err(())
    }
}

// ─────────────────────────────── event → BillingEvent (dispatch) ────────────────────────

/// The Stripe `customer` id on an event's `data.object`, if any.
fn event_customer(object: &Value) -> Option<String> {
    object
        .get("customer")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// The plan id (`accounts.plan_id`) a subscription's BASE price maps to, via the code catalog
/// (`items.data[0].price.id` → `catalog::plan_id_for_price`). `None` if the object carries no
/// price or the price matches no plan (the caller then leaves the plan unchanged).
fn subscription_plan(object: &Value) -> Option<String> {
    let price = object
        .get("items")?
        .get("data")?
        .get(0)?
        .get("price")?
        .get("id")?
        .as_str()?;
    catalog::plan_id_for_price(price).map(str::to_string)
}

/// Map a parsed Stripe event to `(customer, transition-event)`. A `None` `BillingEvent` is an
/// UNHANDLED type — it is still recorded for idempotency (§3.4) but drives no state change
/// (design §3.4: unknown types are a fast 200 no-op so Stripe stops retrying).
pub fn to_billing_event(ev: &StripeEvent) -> (Option<String>, Option<BillingEvent>) {
    let obj = &ev.data.object;
    let customer = event_customer(obj);
    let be = match ev.type_.as_str() {
        "checkout.session.completed" => Some(BillingEvent::CheckoutCompleted {
            plan: subscription_plan(obj),
        }),
        "customer.subscription.created" | "customer.subscription.updated" => {
            let status = obj
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("active")
                .to_string();
            Some(BillingEvent::SubscriptionUpdated {
                status,
                plan: subscription_plan(obj),
            })
        }
        "customer.subscription.deleted" => Some(BillingEvent::SubscriptionDeleted),
        "invoice.paid" => Some(BillingEvent::InvoicePaid),
        "invoice.payment_failed" => Some(BillingEvent::InvoicePaymentFailed),
        _ => None,
    };
    (customer, be)
}

// ─────────────────────────────── the handler (ITEM-1) ───────────────────────────────────

/// `POST /api/billing/webhook` (**PROV-B3-2**). Signature-authenticated (DEC-8, no JWT).
/// Returns 200 on accept / duplicate-no-op / unhandled-type; 401 `BAD_STRIPE_SIGNATURE` on a
/// missing/tampered/wrong-secret/stale signature. Raw body via `axum::body::Bytes` (the HMAC
/// must run over the exact received bytes — a re-serialization would change them).
#[axum::debug_handler]
pub async fn stripe_webhook(
    Extension(pool): Extension<PgPool>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<()> {
    // The signing secret resolves DB-stored (decrypted, #60/DEC-7) then the
    // `STRIPE_WEBHOOK_SECRET` env (DEC-13); absent ⇒ fail closed (reject). A resolver
    // error (e.g. bad storage key) also fails closed — never a silent accept.
    let whsec = super::client::resolve_webhook_secret(&pool)
        .await
        .map_err(|e| e.to_api_error())?
        .ok_or_else(|| {
            AppError::unauthorized(
                "BAD_STRIPE_SIGNATURE",
                "the Stripe webhook signing secret is not configured",
            )
            .to_api_error()
        })?;

    let sig = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let now = chrono::Utc::now().timestamp();
    // #41 (INV-2): the signature clock-skew tolerance is read AT USE from billing_settings
    // (an admin-configurable knob), falling back to the compiled default on a DB error.
    let tolerance = super::repository::get_billing_settings(&pool)
        .await
        .map(|s| s.webhook_signature_tolerance_secs)
        .unwrap_or(SIGNATURE_TOLERANCE_SECS);
    verify_signature(&body, sig, &whsec, tolerance, now).map_err(|_| {
        AppError::unauthorized(
            "BAD_STRIPE_SIGNATURE",
            "Stripe webhook signature verification failed",
        )
        .to_api_error()
    })?;

    // Verified — parse the thin envelope (DEC-9) over the SAME raw bytes.
    let event: StripeEvent = serde_json::from_slice(&body).map_err(|_| {
        AppError::bad_request("BAD_STRIPE_EVENT", "unparseable Stripe event envelope")
            .to_api_error()
    })?;

    let (customer, be) = to_billing_event(&event);
    let transition = be.as_ref().map(dunning::next_state);
    let grace_days = repository::grace_period_days(&pool)
        .await
        .map_err(|e| e.to_api_error())?;

    // Idempotent dedupe + state write in ONE txn (INV-3 / DEC-5).
    let outcome = repository::process_webhook(
        &pool,
        &event.id,
        &event.type_,
        customer.as_deref(),
        transition.as_ref(),
        grace_days,
    )
    .await
    .map_err(|e| e.to_api_error())?;

    // A real state change fans a detached, account-scoped notify (DEC-12 — reuses
    // `AccountUsage`); the FE self-gates the refetch on `billing::read`.
    if outcome.state_changed {
        if let Some(account_id) = outcome.account_id {
            sync::publish_account_billing_changed(&pool, account_id).await;
        }
    }

    Ok((StatusCode::OK, ()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-7 (part) [invariant: INV-5]: `hmac` is only reachable through this saas-gated
    // module — its very presence in this compiled file proves the sig-verify code is behind
    // the feature (the whole `billing` module is `#[cfg(feature = "saas")]`). The saas-OFF
    // absence + the `dep:hmac` feature wiring are asserted by `tests/billing/saas_gating_test.rs`.
    #[test]
    fn signed_body_roundtrips_under_the_real_scheme() {
        let whsec = "whsec_unit_local";
        let body = br#"{"id":"evt_unit_1","type":"invoice.paid","data":{"object":{}}}"#;
        let ts = 1_700_000_000i64;
        let sig = format!("t={ts},v1={}", v1_signature(body, whsec, ts));
        // Verifies at `now == ts` (fresh); a tampered body / wrong secret / stale ts do not.
        assert!(verify_signature(body, &sig, whsec, SIGNATURE_TOLERANCE_SECS, ts).is_ok());
        let mut tampered = body.to_vec();
        tampered[0] ^= 0xFF;
        assert!(verify_signature(&tampered, &sig, whsec, SIGNATURE_TOLERANCE_SECS, ts).is_err());
        assert!(verify_signature(body, &sig, "whsec_wrong", SIGNATURE_TOLERANCE_SECS, ts).is_err());
        assert!(
            verify_signature(body, &sig, whsec, SIGNATURE_TOLERANCE_SECS, ts + 400).is_err(),
            "stale timestamp is rejected"
        );
        // Unhandled type → no transition; a handled type → Some.
        let ev: StripeEvent = serde_json::from_slice(body).unwrap();
        let (_c, be) = to_billing_event(&ev);
        assert!(matches!(be, Some(BillingEvent::InvoicePaid)));
    }
}
