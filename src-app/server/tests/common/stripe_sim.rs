//! B0 — the local Stripe sim harness (TEST-ONLY; never compiled into the
//! server/desktop binary — it lives under `tests/`, upholding INV-4).
//!
//! Three capabilities, all 100% offline:
//!
//!  1. **The signed-webhook injector** (PROV-B0-2 / INV-2). [`sign_event`] +
//!     [`make_event`] build a Stripe-shaped event envelope and sign it with a local
//!     `whsec_` test secret using Stripe's real
//!     `Stripe-Signature: t=<ts>,v1=<HMAC-SHA256("{ts}.{raw_body}")>` scheme, so a
//!     webhook handler verifies it byte-for-byte exactly as it would a genuine Stripe
//!     event. Client-library-agnostic: the produced bytes verify under async-stripe's
//!     `Webhook::construct_event` OR the [`verify_signature`] reference verifier below.
//!     Byte-exactness is anchored by a known-answer vector computed by an INDEPENDENT
//!     tool (OpenSSL `dgst -sha256 -hmac`) in the tests at the bottom.
//!
//!  2. **A reference verifier + placeholder webhook consumer** (ITEM-7 / PROV-B0-5).
//!     [`placeholder_webhook_consumer`] is a trivial axum router that reads the RAW
//!     body, runs [`verify_signature`], and `match`es on `event.type` — the stand-in
//!     B3 replaces with the real `/api/billing/webhook` handler in this same harness.
//!
//!  3. **A local Billing-Meters ingestion stand-in** (ITEM-4 / PROV-B0-3).
//!     [`meter_capture`] accepts `POST /v1/billing/meter_events`, returns a spec-valid
//!     ack, and RECORDS each call so a test can assert the reporter pushed the right
//!     `{event_name, stripe_customer_id, value, identifier}`.
//!
//! The webhook secret and dummy key are FIXED TEST CONSTANTS (DEC-10) — never
//! admin-configurable settings; they exist only in the test environment.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// The local test webhook secret the injector signs with by default. MUST equal the
/// `STRIPE_WEBHOOK_SECRET` the `billing-sim-up` recipe exports (DEC-10 fixed constant),
/// so a shell tier's `stripe-sign.mjs` and this Rust injector agree byte-for-byte.
pub const DEFAULT_TEST_WHSEC: &str = "whsec_b0_local_test_secret";

/// The dummy secret key the recipe exports. NOT a real Stripe credential — the guard
/// (`billing-sim-guard.sh`) allows exactly this value and refuses every other `sk_`.
pub const DUMMY_SECRET_KEY: &str = "sk_test_local";

/// Stripe's default webhook-signature freshness tolerance: reject an event whose `t`
/// is more than this many seconds in the PAST (`now - t > tolerance`). One-sided, to
/// match Stripe's official libraries exactly.
pub const DEFAULT_TOLERANCE_SECS: i64 = 300;

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ─────────────────────────────── the signer (INV-2) ───────────────────────────────

/// The hex `v1` signature: `HMAC-SHA256( "{ts}.{raw_body}", key=whsec )`, lower-hex.
/// This is the raw documented Stripe scheme — no client library involved — so the
/// output verifies under any spec-compliant verifier.
pub fn v1_signature(raw_body: &[u8], whsec: &str, ts: i64) -> String {
    // HMAC accepts a key of any length, so `new_from_slice` cannot fail here.
    let mut mac = HmacSha256::new_from_slice(whsec.as_bytes()).expect("HMAC key of any length");
    mac.update(ts.to_string().as_bytes());
    mac.update(b".");
    mac.update(raw_body);
    hex::encode(mac.finalize().into_bytes())
}

/// The full `Stripe-Signature` header value: `t=<ts>,v1=<hex>` (PROV-B0-2).
pub fn sign_event(raw_body: &[u8], whsec: &str, ts: i64) -> String {
    format!("t={},v1={}", ts, v1_signature(raw_body, whsec, ts))
}

/// Build a Stripe-shaped `event` envelope wrapping `object_json` as `data.object`,
/// signed with `whsec` at timestamp `ts`. Returns the RAW body bytes (the exact bytes
/// that were signed — a verifier must hash THESE, not a re-serialization) plus the
/// `Stripe-Signature` header. PROV-B0-2.
pub fn make_event_with(
    event_type: &str,
    object_json: Value,
    whsec: &str,
    ts: i64,
) -> (Bytes, String) {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let envelope = json!({
        "id": format!("evt_b0_{ts}_{seq}"),
        "object": "event",
        "api_version": "2024-06-20",
        "created": ts,
        "type": event_type,
        "livemode": false,
        "pending_webhooks": 1,
        "request": { "id": Value::Null, "idempotency_key": Value::Null },
        "data": { "object": object_json },
    });
    let raw = serde_json::to_vec(&envelope).expect("serialize event envelope");
    let sig = sign_event(&raw, whsec, ts);
    (Bytes::from(raw), sig)
}

/// [`make_event_with`] using the default local secret + `now` (PROV-B0-2). The common
/// path: `let (body, sig) = make_event("checkout.session.completed", obj);`.
pub fn make_event(event_type: &str, object_json: Value) -> (Bytes, String) {
    make_event_with(event_type, object_json, DEFAULT_TEST_WHSEC, now_ts())
}

// ─────────────────────────── the reference verifier (INV-2) ────────────────────────

/// Why a signed body was rejected. The negative-control vocabulary that makes INV-2
/// mean something: a tampered / unsigned / wrong-secret / stale body must map to one
/// of these, never to `Ok`.
#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// No `t=` element in the header.
    MissingTimestamp,
    /// No `v1=` scheme element (Stripe verifiers ignore non-`v1` schemes; a header
    /// carrying only `v0=`/`v2=` therefore has nothing to verify).
    NoV1Scheme,
    /// `t=` is more than `tolerance` seconds in the past (stale replay).
    TimestampOutOfTolerance,
    /// The header parsed but no `v1` matched the recomputed signature (tampered body /
    /// wrong secret).
    SignatureMismatch,
}

/// Constant-time byte-equality. Length is not secret (both are 64-char hex), so a
/// fast length reject is fine; the byte loop then runs without early exit.
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

/// Verify a `Stripe-Signature` header over `raw_body`, exactly as a spec-compliant
/// Stripe library does: parse `t` + all `v1` elements (Stripe permits several during
/// secret rotation), enforce the freshness window one-sided (`now - t > tolerance` →
/// reject), recompute `v1` and constant-time-compare against each provided value.
pub fn verify_signature(
    raw_body: &[u8],
    sig_header: &str,
    whsec: &str,
    tolerance_secs: i64,
    now: i64,
) -> Result<(), VerifyError> {
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
    let t = t.ok_or(VerifyError::MissingTimestamp)?;
    if v1s.is_empty() {
        return Err(VerifyError::NoV1Scheme);
    }
    if now - t > tolerance_secs {
        return Err(VerifyError::TimestampOutOfTolerance);
    }
    let expected = v1_signature(raw_body, whsec, t);
    if v1s
        .iter()
        .any(|got| ct_eq(got.as_bytes(), expected.as_bytes()))
    {
        Ok(())
    } else {
        Err(VerifyError::SignatureMismatch)
    }
}

// ─────────────── the placeholder webhook consumer (ITEM-7 / DEC-8) ─────────────────

/// Records every event `type` the placeholder consumer verified + dispatched, so a
/// test can assert the local inject → verify → dispatch loop actually ran.
#[derive(Clone, Default)]
pub struct DispatchLog {
    events: Arc<Mutex<Vec<String>>>,
}

impl DispatchLog {
    /// The event types dispatched so far, in order.
    pub fn dispatched(&self) -> Vec<String> {
        self.events.lock().expect("dispatch log lock").clone()
    }
}

#[derive(Clone)]
struct ConsumerState {
    whsec: String,
    log: DispatchLog,
}

async fn consume_webhook(
    State(state): State<ConsumerState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    // Read the RAW body + the signature header (exactly what B3's real handler will do).
    let sig = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if verify_signature(&body, sig, &state.whsec, DEFAULT_TOLERANCE_SECS, now_ts()).is_err() {
        // Stripe's guidance: an unverifiable body is a 400. B3 keeps this contract.
        return (StatusCode::BAD_REQUEST, "signature verification failed").into_response();
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let event_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    // The placeholder "dispatch": B3 swaps this `match` for real handlers.
    match event_type.as_str() {
        "checkout.session.completed"
        | "customer.subscription.updated"
        | "customer.subscription.deleted"
        | "invoice.payment_failed"
        | "invoice.paid" => { /* recognised billing event */ }
        _ => { /* unrecognised — still 2xx-fast so Stripe stops retrying */ }
    }
    state
        .log
        .events
        .lock()
        .expect("dispatch log lock")
        .push(event_type);
    (StatusCode::OK, "ok").into_response()
}

/// A trivial axum router that verifies a `POST /api/billing/webhook` signature and
/// dispatches on `event.type` — the local placeholder B3 replaces (DEC-8). Drive it
/// with `tower::ServiceExt::oneshot` (no port bind). Returns the router + a handle to
/// inspect what it dispatched.
pub fn placeholder_webhook_consumer(whsec: &str) -> (Router, DispatchLog) {
    let log = DispatchLog::default();
    let router = Router::new()
        .route("/api/billing/webhook", post(consume_webhook))
        .with_state(ConsumerState {
            whsec: whsec.to_string(),
            log: log.clone(),
        });
    (router, log)
}

// ─────────────── the local meter-event stand-in (ITEM-4 / PROV-B0-3) ───────────────

/// One recorded `POST /v1/billing/meter_events` call — the fields a test asserts the
/// reporter pushed (DEC-9: assert the SEND shape, not Stripe's async aggregation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeterRecord {
    pub event_name: String,
    pub stripe_customer_id: String,
    pub value: String,
    pub identifier: String,
}

/// Handle to the calls the meter stand-in captured.
#[derive(Clone, Default)]
pub struct MeterLog {
    calls: Arc<Mutex<Vec<MeterRecord>>>,
}

impl MeterLog {
    /// Every captured meter push, in order.
    pub fn calls(&self) -> Vec<MeterRecord> {
        self.calls.lock().expect("meter log lock").clone()
    }
}

/// Minimal `application/x-www-form-urlencoded` decode (`+`→space, `%XX`→byte).
/// Enough for the meter-event fields; no external crate.
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => {
                let hex = |c: u8| (c as char).to_digit(16);
                if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                } else {
                    out.push(b[i]);
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse the meter-event body into a `serde_json::Value` from EITHER wire format:
/// Stripe's real API is `application/x-www-form-urlencoded` (the shape B2's reporter
/// serializes for Stripe — `event_name=…&payload[stripe_customer_id]=…&payload[value]=…
/// &identifier=…`, bracket keys percent-encoded), and JSON is also accepted for
/// convenience. Both normalize to `{event_name, identifier, payload:{...}}`.
fn meter_body_to_value(content_type: &str, body: &[u8]) -> Value {
    if content_type.contains("application/json") {
        return serde_json::from_slice(body).unwrap_or(Value::Null);
    }
    // form-urlencoded (the production Stripe shape)
    let raw = String::from_utf8_lossy(body);
    let mut top = serde_json::Map::new();
    let mut inner = serde_json::Map::new();
    for pair in raw.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let key = pct_decode(k);
        let val = Value::String(pct_decode(v));
        if let Some(rest) = key.strip_prefix("payload[") {
            let field = rest.strip_suffix(']').unwrap_or(rest);
            inner.insert(field.to_string(), val);
        } else {
            top.insert(key, val);
        }
    }
    top.insert("payload".to_string(), Value::Object(inner));
    Value::Object(top)
}

async fn capture_meter_event(
    State(log): State<MeterLog>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let payload = meter_body_to_value(content_type, &body);
    let event_name = payload
        .get("event_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let inner = payload.get("payload").cloned().unwrap_or(Value::Null);
    let stripe_customer_id = inner
        .get("stripe_customer_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    // `value` is a string in the Meter Events API payload.
    let value = inner
        .get("value")
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let identifier = payload
        .get("identifier")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    log.calls.lock().expect("meter log lock").push(MeterRecord {
        event_name: event_name.clone(),
        stripe_customer_id,
        value,
        identifier: identifier.clone(),
    });
    // A spec-valid Billing Meter Event ack.
    (
        StatusCode::OK,
        Json(json!({
            "object": "billing.meter_event",
            "event_name": event_name,
            "identifier": identifier,
            "livemode": false,
        })),
    )
        .into_response()
}

/// A tiny axum router standing in for Stripe's `POST /v1/billing/meter_events`
/// ingestion — returns a spec-valid ack and records the pushed fields (PROV-B0-3).
/// Drive it with `oneshot`.
pub fn meter_capture() -> (Router, MeterLog) {
    let log = MeterLog::default();
    let router = Router::new()
        .route("/v1/billing/meter_events", post(capture_meter_event))
        .with_state(log.clone());
    (router, log)
}

// ───────────────────────────────── self-tests (TEST-2) ─────────────────────────────
//
// These are the INV-2 acceptance proof + its negative controls. They need NO docker
// and NO env, so they run in the normal `cargo test --test integration_tests` suite.

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt; // oneshot

    // Known-answer vector computed by an INDEPENDENT tool (this proves byte-exactness
    // against the real scheme, not merely self-consistency of this module):
    //   secret = "whsec_b0_local_test_secret"
    //   ts     = 1700000000
    //   body   = {"id":"evt_test_b0","object":"event","type":"checkout.session.completed"}
    //   $ printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$secret" -r
    const KAT_SECRET: &str = "whsec_b0_local_test_secret";
    const KAT_TS: i64 = 1700000000;
    const KAT_BODY: &str =
        r#"{"id":"evt_test_b0","object":"event","type":"checkout.session.completed"}"#;
    const KAT_V1: &str = "72a3eec1985eb2895f730aadbda5fd29e7a9cdfd8665f6ac7bd4487399f8e09e";

    #[test]
    fn t2_signature_is_byte_exact_vs_openssl() {
        // The load-bearing INV-2 proof: our RustCrypto HMAC output equals OpenSSL's,
        // so a real Stripe SDK (which verifies with OpenSSL) would accept our bytes.
        assert_eq!(
            v1_signature(KAT_BODY.as_bytes(), KAT_SECRET, KAT_TS),
            KAT_V1
        );
        assert_eq!(
            sign_event(KAT_BODY.as_bytes(), KAT_SECRET, KAT_TS),
            format!("t={KAT_TS},v1={KAT_V1}")
        );
    }

    #[test]
    fn t2_sign_then_verify_roundtrips() {
        let (body, sig) = make_event("checkout.session.completed", json!({"id":"cs_1"}));
        assert!(verify_signature(
            &body,
            &sig,
            DEFAULT_TEST_WHSEC,
            DEFAULT_TOLERANCE_SECS,
            now_ts()
        )
        .is_ok());
    }

    #[test]
    fn t2_tampered_body_is_rejected() {
        let (body, sig) = make_event("checkout.session.completed", json!({"id":"cs_1"}));
        let mut tampered = body.to_vec();
        tampered[0] ^= 0xFF; // flip a byte
        assert_eq!(
            verify_signature(
                &tampered,
                &sig,
                DEFAULT_TEST_WHSEC,
                DEFAULT_TOLERANCE_SECS,
                now_ts()
            ),
            Err(VerifyError::SignatureMismatch)
        );
    }

    #[test]
    fn t2_wrong_secret_is_rejected() {
        let (body, sig) = make_event("checkout.session.completed", json!({"id":"cs_1"}));
        assert_eq!(
            verify_signature(
                &body,
                &sig,
                "whsec_the_wrong_secret",
                DEFAULT_TOLERANCE_SECS,
                now_ts()
            ),
            Err(VerifyError::SignatureMismatch)
        );
    }

    #[test]
    fn t2_unsigned_body_is_rejected() {
        let (body, _sig) = make_event("checkout.session.completed", json!({"id":"cs_1"}));
        // No signature header at all → nothing to verify.
        assert_eq!(
            verify_signature(
                &body,
                "",
                DEFAULT_TEST_WHSEC,
                DEFAULT_TOLERANCE_SECS,
                now_ts()
            ),
            Err(VerifyError::MissingTimestamp)
        );
        // A header carrying a timestamp but only a non-v1 scheme is also refused.
        let ts = now_ts();
        assert_eq!(
            verify_signature(
                &body,
                &format!("t={ts},v0=deadbeef"),
                DEFAULT_TEST_WHSEC,
                DEFAULT_TOLERANCE_SECS,
                ts
            ),
            Err(VerifyError::NoV1Scheme)
        );
    }

    #[test]
    fn t2_stale_timestamp_is_rejected() {
        let old = 1_600_000_000; // years in the past
        let (body, sig) = make_event_with(
            "checkout.session.completed",
            json!({"id":"cs_1"}),
            DEFAULT_TEST_WHSEC,
            old,
        );
        // Even though the signature itself is valid for `old`, the freshness window
        // rejects it (now ≫ old + 300s).
        assert_eq!(
            verify_signature(
                &body,
                &sig,
                DEFAULT_TEST_WHSEC,
                DEFAULT_TOLERANCE_SECS,
                now_ts()
            ),
            Err(VerifyError::TimestampOutOfTolerance)
        );
    }

    #[test]
    fn t2_multiple_v1_elements_any_match_passes() {
        // Stripe sends several `v1=` during secret rotation; any matching one verifies.
        let (body, sig) = make_event("invoice.paid", json!({"id":"in_1"}));
        let real_v1 = sig.split_once("v1=").unwrap().1;
        let t = sig.split(',').next().unwrap(); // "t=..."
        let header = format!("{t},v1=00deadbeef,v1={real_v1}");
        assert!(verify_signature(
            &body,
            &header,
            DEFAULT_TEST_WHSEC,
            DEFAULT_TOLERANCE_SECS,
            now_ts()
        )
        .is_ok());
    }

    #[tokio::test]
    async fn t2_placeholder_consumer_accepts_signed_rejects_tampered() {
        use axum::body::Body;
        use axum::http::Request;

        let (body, sig) = make_event("checkout.session.completed", json!({"id":"cs_ok"}));

        // signed → 200, dispatched
        let (router, log) = placeholder_webhook_consumer(DEFAULT_TEST_WHSEC);
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/billing/webhook")
                    .header("stripe-signature", &sig)
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(log.dispatched(), vec!["checkout.session.completed"]);

        // tampered → 400, NOT dispatched
        let mut tampered = body.to_vec();
        tampered[10] ^= 0xFF;
        let (router2, log2) = placeholder_webhook_consumer(DEFAULT_TEST_WHSEC);
        let resp2 = router2
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/billing/webhook")
                    .header("stripe-signature", &sig)
                    .body(Body::from(tampered))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp2.status(), StatusCode::BAD_REQUEST);
        assert!(log2.dispatched().is_empty());
    }

    #[tokio::test]
    async fn t6_meter_capture_records_pushed_fields() {
        use axum::body::Body;
        use axum::http::Request;

        let (router, log) = meter_capture();
        let payload = json!({
            "event_name": "compute_seconds",
            "payload": { "stripe_customer_id": "cus_abc", "value": "42" },
            "identifier": "idem-key-1",
        });
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/billing/meter_events")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            log.calls(),
            vec![MeterRecord {
                event_name: "compute_seconds".into(),
                stripe_customer_id: "cus_abc".into(),
                value: "42".into(),
                identifier: "idem-key-1".into(),
            }]
        );
    }

    #[tokio::test]
    async fn t6_meter_capture_records_form_encoded_production_shape() {
        // The PRODUCTION wire format B2's reporter serializes for Stripe:
        // application/x-www-form-urlencoded with percent-encoded bracket keys
        // (`payload%5Bstripe_customer_id%5D=…`). The stand-in must record the same
        // fields from THIS shape, not only JSON — otherwise it tests a shape the
        // reporter never emits.
        use axum::body::Body;
        use axum::http::Request;

        let (router, log) = meter_capture();
        let form = "event_name=compute_seconds\
            &payload%5Bstripe_customer_id%5D=cus_abc\
            &payload%5Bvalue%5D=42\
            &identifier=idem-key-1";
        let resp = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/billing/meter_events")
                    .header("content-type", "application/x-www-form-urlencoded")
                    .body(Body::from(form))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            log.calls(),
            vec![MeterRecord {
                event_name: "compute_seconds".into(),
                stripe_customer_id: "cus_abc".into(),
                value: "42".into(),
                identifier: "idem-key-1".into(),
            }]
        );
    }
}
