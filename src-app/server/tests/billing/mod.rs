//! B0 — the Level-2 full-flow-local billing tier (PROV-B0-5 / TEST-3, -6, -9).
//!
//! This is the harness B2/B3 plug their real contract tests into. It proves the
//! ENTIRE server-side billing loop is drivable with NO network and NO real Stripe:
//!
//!   checkout.sessions.create (against stripe-mock)
//!     → inject a locally-signed `checkout.session.completed`
//!     → the placeholder consumer verifies + dispatches            (TEST-3)
//!   invoice.payment_failed + customer.subscription.deleted        (TEST-9, dunning)
//!   POST /v1/billing/meter_events → recorded {name,customer,value,identifier} (TEST-6)
//!
//! It is **env-gated** on `STRIPE_API_BASE` (which `just billing-sim-test-l2` exports
//! after `billing-sim-up`). When that is absent the test SELF-SKIPS via the skip
//! ledger — never a bare `eprintln!` (invisible, reads as a pass) and never the
//! libtest ignore-attribute (A3). Under `CYTO_TEST_NO_SKIP=1` (the mode the tier runs
//! in) the skip becomes a HARD FAILURE, so the acceptance run cannot pass vacuously.
//!
//! DEC-8: the consumer here is B0's placeholder; B3 replaces it with the real
//! `/api/billing/webhook` handler in this same harness.

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt; // oneshot

use crate::common::stripe_sim::{
    make_event, meter_capture, placeholder_webhook_consumer, DEFAULT_TEST_WHSEC,
};

// ── B2 (Stripe integration) test modules ────────────────────────────────────────────
// The saas-gating source-grep runs in BOTH builds (it imports no billing code).
// #141 — the seat fields on the quota read surface (member_allowance + members_used).
// saas-gated like every other billing HTTP test here: it reads `billing::catalog`, which
// does not exist in the default build.
#[cfg(feature = "saas")]
mod seat_quota_read_test;
mod saas_gating_test;
// The route/repository/client contract tests compile only under `--features saas` (the
// billing module is saas-gated, INV-5); they run against B0's sim substrate.
#[cfg(feature = "saas")]
mod accounts_contract_test;
#[cfg(feature = "saas")]
mod checkout_test;
#[cfg(feature = "saas")]
mod customer_link_test;
// `pub(crate)` so the compute-quota (T6) acceptance tests can reuse the account/rollup/plan seed
// helpers instead of re-implementing them (both modules are saas-gated).
#[cfg(feature = "saas")]
pub(crate) mod helpers;
#[cfg(feature = "saas")]
mod meter_push_test;
#[cfg(feature = "saas")]
mod portal_test;
// B1 — the usage-rollup fold + report + read-API acceptance tests.
#[cfg(feature = "saas")]
mod rollup_test;
// B3 — the webhook reconciliation boundary + dunning state machine (replaces B0's
// placeholder consumer with the real `/api/billing/webhook` handler in this same harness).
#[cfg(feature = "saas")]
mod dunning_suspend_test;
#[cfg(feature = "saas")]
mod settings_test;
// #41 (admin-settings-coverage) — the billing operational-knob settings + read-only catalog.
#[cfg(feature = "saas")]
mod catalog_read_test;
#[cfg(feature = "saas")]
mod settings_knobs_test;
#[cfg(feature = "saas")]
mod webhook_idempotency_test;
#[cfg(feature = "saas")]
mod webhook_lifecycle_test;
#[cfg(feature = "saas")]
mod webhook_unknown_type_test;
#[cfg(feature = "saas")]
mod webhook_verify_test;
// #36 — the admin read-any-account subscription/usage/quota acceptance tests (cross-account,
// path-scoped reads gated on billing::admin). saas-gated with the routes they exercise.
#[cfg(feature = "saas")]
mod admin_billing_read_test;
// #60 — the admin Billing-integration ENCRYPTED-at-rest Stripe config: ciphertext-at-rest,
// masked GET (no plaintext), resolve DB-then-env, A9 deny. The SECURITY acceptance anchor.
#[cfg(feature = "saas")]
mod integration_config_test;
// #39 — the admin credit ledger + comp/premium override acceptance tests (grant changes the
// verdict; revoke/expiry honored; append-only ledger; admin-gated; no-grant regression control).
#[cfg(feature = "saas")]
mod credits_test;
// B4 — the quota decision + read/spend-cap API + the usage-alert ladder.
#[cfg(feature = "saas")]
mod alerts_test;
#[cfg(feature = "saas")]
mod quota_test;
// #37 — the admin-suspend QUOTA EFFECT (suspend → check_quota Blocks; precedence over
// credits/premium). saas-gated because check_quota is the saas-only quota gate.
#[cfg(feature = "saas")]
mod admin_suspend_quota_test;
// #38 — the admin plan/tier override + the webhook-vs-override reconciliation (the crux).
#[cfg(feature = "saas")]
mod plan_override_test;

/// Announce a self-skip on BOTH channels (human `eprintln!` + the machine-readable
/// ledger that survives libtest capture), and turn it into a HARD FAILURE under
/// `CYTO_TEST_NO_SKIP=1`. Mirrors `dataset::hardening_common::record_skip` — a bare
/// `eprintln!` skip is byte-for-byte indistinguishable from a real pass and is
/// forbidden in this repo.
fn record_skip(test: &str, reason: &str) {
    let path = match std::env::var("CYTO_TEST_SKIP_LEDGER").ok() {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-skip-ledger.tsv"),
    };
    eprintln!(
        "SKIP {test}: {reason} — self-skip, not the ignore attribute (also recorded in {})",
        path.display()
    );
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let one_line: String = reason
            .chars()
            .map(|c| {
                if c == '\t' || c == '\n' || c == '\r' {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        let _ = writeln!(f, "{test}\t{one_line}");
    }
    if std::env::var("CYTO_TEST_NO_SKIP").is_ok_and(|v| v == "1") {
        panic!("SKIP {test}: {reason} — CYTO_TEST_NO_SKIP=1 demands this tier ACTUALLY RUN, so the skip is a hard failure");
    }
}

/// The local webhook secret the tier signs + verifies with. Reads the exported
/// `STRIPE_WEBHOOK_SECRET`, falling back to the injector's default (they are the same
/// fixed constant — DEC-10) so the Rust injector and the recipe agree byte-for-byte.
fn tier_whsec() -> String {
    std::env::var("STRIPE_WEBHOOK_SECRET").unwrap_or_else(|_| DEFAULT_TEST_WHSEC.to_string())
}

/// TEST-3 + TEST-9 + TEST-6: the full-flow-local billing loop against the sim.
#[tokio::test]
async fn l2_full_flow_local() {
    let Ok(api_base) = std::env::var("STRIPE_API_BASE") else {
        record_skip(
            "billing::l2_full_flow_local",
            "STRIPE_API_BASE unset — run via `just billing-sim-test-l2` (brings up stripe-mock + exports the env contract)",
        );
        return;
    };
    let api_base = api_base.trim_end_matches('/').to_string();
    let whsec = tier_whsec();
    let client = reqwest::Client::new();

    // ── 1. checkout.sessions.create against the REAL mock (no network beyond loopback)
    let resp = client
        .post(format!("{api_base}/v1/checkout/sessions"))
        // stripe-mock accepts any bearer token; the dummy key is fine.
        .basic_auth("sk_test_local", Some(""))
        .form(&[
            ("mode", "subscription"),
            ("line_items[0][price]", "price_local_1"),
            ("line_items[0][quantity]", "1"),
            ("success_url", "https://example.test/success"),
            ("cancel_url", "https://example.test/cancel"),
        ])
        .send()
        .await
        .expect("POST /v1/checkout/sessions to stripe-mock");
    assert_eq!(resp.status(), StatusCode::OK, "checkout session create");
    let session: serde_json::Value = resp.json().await.expect("checkout session json");
    assert_eq!(
        session.get("object").and_then(|v| v.as_str()),
        Some("checkout.session"),
        "spec-valid checkout.session object came back from the mock"
    );

    // ── 2. inject a locally-signed checkout.session.completed → placeholder consumer
    let (router, log) = placeholder_webhook_consumer(&whsec);
    let (body, sig) = make_event(
        "checkout.session.completed",
        json!({
            "id": session.get("id").and_then(|v| v.as_str()).unwrap_or("cs_local_1"),
            "object": "checkout.session",
            "customer": "cus_local_1",
            "subscription": "sub_local_1",
        }),
    );
    // ONE router across the sequence: it is `Clone`, and every clone shares the same
    // dispatch log (an `Arc` in its state), so the log accumulates across calls.
    let status = post_webhook(&router, &sig, body).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "signed checkout.session.completed verifies"
    );

    // negative control INSIDE the full flow: a tampered body is refused, not dispatched.
    let (bad_body, sig2) = make_event("checkout.session.completed", json!({"id":"cs_evil"}));
    let mut tampered = bad_body.to_vec();
    tampered[5] ^= 0xFF;
    let bad_status = post_webhook(&router, &sig2, tampered.into()).await;
    assert_eq!(
        bad_status,
        StatusCode::BAD_REQUEST,
        "tampered body is rejected"
    );

    // ── 3. dunning (TEST-9): payment_failed (grace) + subscription.deleted (suspend)
    let (b1, s1) = make_event(
        "invoice.payment_failed",
        json!({"id":"in_1","customer":"cus_local_1"}),
    );
    assert_eq!(
        post_webhook(&router, &s1, b1).await,
        StatusCode::OK,
        "invoice.payment_failed routes"
    );
    let (b2, s2) = make_event(
        "customer.subscription.deleted",
        json!({"id":"sub_local_1","customer":"cus_local_1"}),
    );
    assert_eq!(
        post_webhook(&router, &s2, b2).await,
        StatusCode::OK,
        "subscription.deleted routes"
    );

    let dispatched = log.dispatched();
    assert_eq!(
        dispatched,
        vec![
            "checkout.session.completed".to_string(),
            "invoice.payment_failed".to_string(),
            "customer.subscription.deleted".to_string(),
        ],
        "the placeholder consumer verified + dispatched exactly the valid events, in order"
    );

    // ── 4. meter push (TEST-6): the local stand-in records the pushed fields, driven
    // with the PRODUCTION `application/x-www-form-urlencoded` shape (percent-encoded
    // bracket keys) B2's reporter serializes for Stripe — the same shape POSTed to the
    // real mock below, so the stand-in tests what the reporter actually emits.
    let (meter_router, meter_log) = meter_capture();
    let form = "event_name=compute_seconds\
        &payload%5Bstripe_customer_id%5D=cus_local_1\
        &payload%5Bvalue%5D=128\
        &identifier=idem-local-1";
    let meter_status = meter_router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/billing/meter_events")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from(form))
                .unwrap(),
        )
        .await
        .unwrap()
        .status();
    assert_eq!(meter_status, StatusCode::OK, "meter stand-in acks");
    let calls = meter_log.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event_name, "compute_seconds");
    assert_eq!(calls[0].stripe_customer_id, "cus_local_1");
    assert_eq!(calls[0].value, "128");
    assert_eq!(calls[0].identifier, "idem-local-1");

    // … AND stripe-mock itself serves the endpoint with a spec-valid ack (the contract
    // half of PROV-B0-3 — B2's real reporter POSTs here).
    let mock_meter = client
        .post(format!("{api_base}/v1/billing/meter_events"))
        .basic_auth("sk_test_local", Some(""))
        .form(&[
            ("event_name", "compute_seconds"),
            ("payload[stripe_customer_id]", "cus_local_1"),
            ("payload[value]", "128"),
        ])
        .send()
        .await
        .expect("POST /v1/billing/meter_events to stripe-mock");
    assert_eq!(
        mock_meter.status(),
        StatusCode::OK,
        "stripe-mock serves meter_events"
    );
}

/// Drive the shared placeholder consumer once and return the HTTP status. The router
/// is `Clone` and every clone shares its dispatch log, so calls accumulate.
async fn post_webhook(router: &axum::Router, sig: &str, body: axum::body::Bytes) -> StatusCode {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/billing/webhook")
                .header("stripe-signature", sig)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}
