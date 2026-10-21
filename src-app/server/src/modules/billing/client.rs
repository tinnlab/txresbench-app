//! The Stripe REST client (ITEM-5).
//!
//! A thin typed wrapper over the Stripe REST endpoints the design uses — no
//! official Rust Stripe SDK dependency (DEC-1): the wrappers call the same REST
//! shapes the `stripe-samples` reference server does, which keeps the
//! `STRIPE_API_BASE` seam trivial and matches B0's spec-valid mock.
//!
//! - **Base URL is a per-client value** (DEC-4), resolved by [`stripe_base_url`]:
//!   real `https://api.stripe.com` in release; the loopback `STRIPE_API_BASE`
//!   (PROV-B0-4) honored **only under `#[cfg(debug_assertions)]`**, exactly like
//!   `EnvImageSeams`/`DEFAULT_REGISTRY` (`sandbox/env_image.rs`). It is a passed
//!   parameter read once at construction, NEVER a process-wide `set_var` (env_image
//!   records the cross-test `set_var` leak race).
//! - **One shared `reqwest::Client`** (`connect_timeout` + `timeout`,
//!   `redirect::Policy::none()`) mirroring `mcp/handlers.rs`.
//! - **The Stripe secret key is a 12-factor env secret** (`STRIPE_SECRET_KEY`,
//!   DEC-3) — never an admin settings row, never logged, never in `Debug`.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;
use ziee_core::AppError;

/// The real Stripe API base — what a release binary always talks to.
pub const DEFAULT_STRIPE_BASE: &str = "https://api.stripe.com";

/// The env var carrying the Stripe secret key (12-factor, DEC-3).
pub const SECRET_KEY_ENV: &str = "STRIPE_SECRET_KEY";

/// The debug-only endpoint-override env var (PROV-B0-4). Honored ONLY under
/// `#[cfg(debug_assertions)]` — a release binary ignores it entirely.
pub const API_BASE_ENV: &str = "STRIPE_API_BASE";

/// Resolve the Stripe API base URL from an explicit override (DEC-4) — a PURE
/// function (no global env read) so the debug-only posture is deterministically
/// unit-testable without mutating process env.
///
/// Release: always [`DEFAULT_STRIPE_BASE`], whatever `override_base` holds. Debug:
/// the loopback override (PROV-B0-4) when `Some` + non-empty, else the default. The
/// override arm lives inside a `#[cfg(debug_assertions)]` block, so it is
/// **physically compiled out** of a release build — the negative control that makes
/// "no real Stripe, no network" mean something (INV-4, TEST-6).
pub fn resolve_base(override_base: Option<&str>) -> String {
    #[cfg(debug_assertions)]
    {
        if let Some(base) = override_base {
            let base = base.trim();
            if !base.is_empty() {
                return base.trim_end_matches('/').to_string();
            }
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = override_base; // release ignores the override entirely
    }
    DEFAULT_STRIPE_BASE.to_string()
}

/// The Stripe API base URL for THIS process: [`resolve_base`] applied to the
/// debug-only `STRIPE_API_BASE` env override (read once, at client construction).
pub fn stripe_base_url() -> String {
    resolve_base(std::env::var(API_BASE_ENV).ok().as_deref())
}

/// One shared client for outbound Stripe calls (mirrors `mcp/handlers.rs`):
/// bounded connect+request timeouts, no redirects (a user-influenced param must not
/// follow a redirect to an internal host).
static HTTP_CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            tracing::error!(error = %e, "billing: failed to build Stripe HTTP client");
        })
        .ok()
});

/// Build the `application/x-www-form-urlencoded` body for a subscription-mode
/// Checkout Session — a PURE function so the wire SHAPE (PROV-B2-4) is unit-testable
/// without a network round-trip (the stripe-mock returns a canned session for ANY
/// spec-shaped request, so an HTTP-level test cannot catch a `mode=payment` / wrong
/// `client_reference_id` / dropped-metered-line regression — this can).
///
/// Follows `stripe-samples/checkout-single-subscription`: `mode=subscription`,
/// `line_items[0]` = the flat base price (quantity 1), `line_items[1..]` = the metered
/// prices (a metered line carries NO quantity), `client_reference_id` = the account id.
pub fn build_checkout_form(
    customer: &str,
    base_price: &str,
    metered_prices: &[String],
    success_url: &str,
    cancel_url: &str,
    client_reference_id: &str,
) -> Vec<(String, String)> {
    let mut form = vec![
        ("mode".to_string(), "subscription".to_string()),
        ("customer".to_string(), customer.to_string()),
        ("success_url".to_string(), success_url.to_string()),
        ("cancel_url".to_string(), cancel_url.to_string()),
        (
            "client_reference_id".to_string(),
            client_reference_id.to_string(),
        ),
        ("allow_promotion_codes".to_string(), "true".to_string()),
    ];
    form.push(("line_items[0][price]".to_string(), base_price.to_string()));
    form.push(("line_items[0][quantity]".to_string(), "1".to_string()));
    for (i, mp) in metered_prices.iter().enumerate() {
        form.push((format!("line_items[{}][price]", i + 1), mp.clone()));
    }
    form
}

/// The Stripe REST client. Holds the decrypted secret key, so it does **not**
/// `#[derive(Debug)]` — [`std::fmt::Debug`] is hand-written to redact the key
/// (CODING_GUIDELINES §3).
#[derive(Clone)]
pub struct StripeClient {
    base: String,
    secret: String,
}

impl std::fmt::Debug for StripeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StripeClient")
            .field("base", &self.base)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl StripeClient {
    /// Build the client from the 12-factor env (DEC-3): the secret key from
    /// `STRIPE_SECRET_KEY`, the base from [`stripe_base_url`]. Errors (500) if the
    /// secret is unset — a saas deployment MUST configure it.
    pub fn from_env() -> Result<Self, AppError> {
        let secret = std::env::var(SECRET_KEY_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                AppError::internal_error(
                    "billing: STRIPE_SECRET_KEY is not configured (12-factor env secret)",
                )
            })?;
        Ok(Self {
            base: stripe_base_url(),
            secret,
        })
    }

    /// Build a client with an EXPLICIT base + secret (DEC-4: base is a passed
    /// parameter). Used where the base is chosen at the call site rather than read
    /// from env — e.g. an integration test pointing the meter push at the PROV-B0-3
    /// capture stand-in on an ephemeral loopback port, with no global-env mutation.
    pub fn new(base: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            base: base.into().trim_end_matches('/').to_string(),
            secret: secret.into(),
        }
    }

    /// The resolved base URL (test/observability only — never the secret).
    pub fn base(&self) -> &str {
        &self.base
    }

    fn client() -> Result<&'static reqwest::Client, AppError> {
        HTTP_CLIENT
            .as_ref()
            .ok_or_else(|| AppError::internal_error("billing: Stripe HTTP client unavailable"))
    }

    /// POST a form-encoded body to `path` and parse the JSON response, mapping a
    /// transport error or a non-2xx to a clear error (context preserved, secret
    /// never included).
    async fn post_form(&self, path: &str, form: &[(String, String)]) -> Result<Value, AppError> {
        let url = format!("{}{}", self.base, path);
        let resp = Self::client()?
            .post(&url)
            .bearer_auth(&self.secret)
            .form(form)
            .send()
            .await
            .map_err(|e| {
                AppError::internal_error(format!("billing: Stripe request to {path} failed: {e}"))
            })?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // LOG the Stripe error body for operators (it can echo customer/price ids
            // and Stripe-internal detail — no secret), but return a GENERIC message to
            // the end user so no Stripe-internal detail is disclosed downstream.
            tracing::warn!(
                %status, %path, stripe_body = %body.chars().take(500).collect::<String>(),
                "billing: Stripe request returned a non-2xx status"
            );
            return Err(AppError::internal_error(format!(
                "billing: Stripe {path} request failed ({status})"
            )));
        }
        serde_json::from_str(&body).map_err(|e| {
            AppError::internal_error(format!("billing: Stripe {path} returned non-JSON: {e}"))
        })
    }

    /// Create a Stripe `Customer` for `account_id`, returning its id (`cus_…`).
    /// `client_reference` (the account id) is stamped into metadata so a Customer is
    /// traceable back to its account.
    pub async fn create_customer(&self, account_id: &str) -> Result<String, AppError> {
        let form = vec![
            ("metadata[account_id]".to_string(), account_id.to_string()),
            (
                "description".to_string(),
                format!("CytoAnalyst account {account_id}"),
            ),
        ];
        let v = self.post_form("/v1/customers", &form).await?;
        v.get("id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::internal_error("billing: Stripe customer response had no id"))
    }

    /// Create a subscription-mode Checkout Session (ITEM-3), following
    /// `stripe-samples/checkout-single-subscription`
    /// (`stripe.checkout.sessions.create({ mode:'subscription', line_items,
    /// success_url, cancel_url, client_reference_id })`). Returns the hosted
    /// `checkout_url`. The plan is NOT flipped here (INV-2) — B3's webhook does that.
    pub async fn create_checkout_session(
        &self,
        customer: &str,
        base_price: &str,
        metered_prices: &[String],
        success_url: &str,
        cancel_url: &str,
        client_reference_id: &str,
    ) -> Result<String, AppError> {
        let form = build_checkout_form(
            customer,
            base_price,
            metered_prices,
            success_url,
            cancel_url,
            client_reference_id,
        );
        let v = self.post_form("/v1/checkout/sessions", &form).await?;
        v.get("url")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::internal_error("billing: Stripe checkout session had no url"))
    }

    /// Create a Billing Portal Session (ITEM-4), following
    /// `stripe-samples/customer-portal`
    /// (`stripe.billingPortal.sessions.create({ customer, return_url })`). Returns
    /// the hosted `portal_url`.
    pub async fn create_portal_session(
        &self,
        customer: &str,
        return_url: &str,
    ) -> Result<String, AppError> {
        let form = vec![
            ("customer".to_string(), customer.to_string()),
            ("return_url".to_string(), return_url.to_string()),
        ];
        let v = self.post_form("/v1/billing_portal/sessions", &form).await?;
        v.get("url")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::internal_error("billing: Stripe portal session had no url"))
    }

    /// Push a Billing-Meters usage event (ITEM-9), following
    /// `POST /v1/billing/meter_events`
    /// (`{ event_name, payload:{ stripe_customer_id, value }, identifier }`) — the
    /// CURRENT usage API that replaced the removed legacy usage-records. `identifier`
    /// is the exactly-once idempotency key (BQ-INV-1). Per PROV-B0-7 the async
    /// aggregation is live-mode-only, so locally this asserts the SEND shape against
    /// PROV-B0-3, never Stripe's aggregation.
    pub async fn push_meter_event(
        &self,
        event_name: &str,
        stripe_customer_id: &str,
        value: &str,
        identifier: &str,
    ) -> Result<(), AppError> {
        let form = vec![
            ("event_name".to_string(), event_name.to_string()),
            (
                "payload[stripe_customer_id]".to_string(),
                stripe_customer_id.to_string(),
            ),
            ("payload[value]".to_string(), value.to_string()),
            ("identifier".to_string(), identifier.to_string()),
        ];
        self.post_form("/v1/billing/meter_events", &form).await?;
        Ok(())
    }

    /// GET a Stripe endpoint and parse the JSON — the READ transport (mirrors
    /// `post_form`). The secret rides `bearer_auth` (NEVER logged / in a URL). A
    /// non-2xx is surfaced as `Err(status)` for the caller to classify; the raw body
    /// is logged for operators but NEVER returned to the client and never carries the
    /// key. Used by the Test-connection validation call.
    async fn get_json(&self, path: &str) -> Result<Value, (u16, AppError)> {
        let url = format!("{}{}", self.base, path);
        let resp = Self::client()
            .map_err(|e| (0u16, e))?
            .get(&url)
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(|e| {
                (
                    0u16,
                    AppError::internal_error(format!(
                        "billing: Stripe request to {path} failed: {e}"
                    )),
                )
            })?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // Operators see the Stripe body (may echo error detail — never the secret,
            // which only travels in the Authorization header); the caller gets a code.
            tracing::warn!(
                %status, %path,
                stripe_body = %body.chars().take(500).collect::<String>(),
                "billing: Stripe test call returned a non-2xx status"
            );
            return Err((
                status.as_u16(),
                AppError::internal_error(format!(
                    "billing: Stripe {path} request failed ({status})"
                )),
            ));
        }
        serde_json::from_str(&body).map_err(|e| {
            (
                status.as_u16(),
                AppError::internal_error(format!("billing: Stripe {path} returned non-JSON: {e}")),
            )
        })
    }

    /// Validate the configured Stripe secret with ONE lightweight authenticated call
    /// (`GET /v1/balance`, DEC-5 — no params, cheap, 401 on a bad key). Returns a
    /// `{ok,message}` view that NEVER contains the key or the raw Stripe body. A bad
    /// key is a clean `ok:false` (HTTP 200 from OUR endpoint), never a 500 that could
    /// leak detail (INV-5).
    pub async fn check_connection(&self) -> super::models::TestConnectionResponse {
        match self.get_json("/v1/balance").await {
            Ok(_) => classify_test_result(true, 200),
            Err((status, _)) => classify_test_result(false, status),
        }
    }
}

/// Map a Stripe validation outcome to the operator-facing `{ok,message}`. PURE (no
/// key, no body in scope) so it is unit-testable and structurally CANNOT leak the
/// secret (INV-5). The message is a fixed operator string keyed only on the status.
pub fn classify_test_result(ok: bool, status: u16) -> super::models::TestConnectionResponse {
    use super::models::TestConnectionResponse;
    if ok {
        return TestConnectionResponse {
            ok: true,
            message: "Connection succeeded — the Stripe secret is valid.".to_string(),
        };
    }
    let message = match status {
        401 => "Invalid Stripe secret key (401 Unauthorized).".to_string(),
        403 => "The Stripe key is valid but lacks permission for this call (403).".to_string(),
        0 => "Could not reach Stripe (network/transport error).".to_string(),
        s => format!("Stripe validation failed (HTTP {s})."),
    };
    TestConnectionResponse { ok: false, message }
}

/// Resolve the effective Stripe secret for THIS request (#60, INV-4): the DB-stored
/// key (decrypted) when at-rest encryption is configured AND a ciphertext is present,
/// ELSE the `STRIPE_SECRET_KEY` env var (today's 12-factor path), ELSE `None`
/// (unconfigured). Compat mode (no `storage_key`) skips the DB branch entirely, so the
/// result is byte-identical to `from_env`'s env read (INV-3). Never logs the value.
pub async fn resolve_secret(pool: &sqlx::PgPool) -> Result<Option<String>, AppError> {
    // Compat mode (no storage key): skip the DB read entirely — byte-identical to the
    // old env-only `from_env` (INV-3).
    if ziee_framework::secrets::storage_key().is_none() {
        return Ok(env_secret_key());
    }
    // Encryption configured: prefer the DB ciphertext, ELSE env. `resolve_optional_secret`
    // decrypts the ciphertext when a storage key is set AND, on a decrypt FAILURE (a wrong
    // key after a rotation / corrupted bytes), logs a generic error and GRACEFULLY falls
    // back to the supplied env value rather than 500-ing — so a mis-rotated key never
    // bricks the admin page (round-1 audit; the SDK primitive built for this). No secret
    // is logged (pgcrypto's error is generic).
    let ct = super::repository::get_billing_integration(pool)
        .await?
        .stripe_secret_ciphertext;
    Ok(ziee_framework::secret::resolve_optional_secret(pool, ct, env_secret_key()).await)
}

/// The `STRIPE_SECRET_KEY` env value iff set + non-empty (the 12-factor read shared by
/// `from_env` and the env-fallback branch of `resolve_secret`).
pub fn env_secret_key() -> Option<String> {
    std::env::var(SECRET_KEY_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// Resolve the effective Stripe WEBHOOK signing secret (#60, DEC-7): DB-stored
/// (decrypted) when configured, ELSE the `STRIPE_WEBHOOK_SECRET` env
/// (`config::webhook_secret`), ELSE `None`. Symmetric to `resolve_secret`; the webhook
/// path stays fail-closed on `None`. Never logs the value.
pub async fn resolve_webhook_secret(pool: &sqlx::PgPool) -> Result<Option<String>, AppError> {
    if ziee_framework::secrets::storage_key().is_none() {
        return Ok(super::config::webhook_secret());
    }
    // Graceful fallback on a decrypt failure (see `resolve_secret`): the webhook path
    // stays fail-closed — a `None` result (no DB secret, no env) rejects the event.
    let ct = super::repository::get_billing_integration(pool)
        .await?
        .webhook_secret_ciphertext;
    Ok(ziee_framework::secret::resolve_optional_secret(pool, ct, super::config::webhook_secret()).await)
}

impl StripeClient {
    /// Build a client from the resolved secret (#60): DB-stored-then-env
    /// ([`resolve_secret`]). Errors (500) if NEITHER is configured — the same posture
    /// as `from_env`, so a compat deployment behaves identically. Built per-request, so
    /// a rotate is picked up on the next call (no cached client to invalidate, INV-4).
    pub async fn resolve(pool: &sqlx::PgPool) -> Result<Self, AppError> {
        let secret = resolve_secret(pool).await?.ok_or_else(|| {
            AppError::internal_error(
                "billing: no Stripe secret configured (set it in the admin Billing \
                 integration page or the STRIPE_SECRET_KEY env var)",
            )
        })?;
        Ok(Self {
            base: stripe_base_url(),
            secret,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-6 (part) [invariant: INV-4]: the base-URL override is a debug-only seam,
    // proven WITHOUT mutating global process env (via the pure `resolve_base`).
    // No override → the real Stripe host (release posture); a loopback override is
    // honored + trimmed only in a debug build. The override arm is inside a
    // `#[cfg(debug_assertions)]` block, so it is compiled OUT of a release binary —
    // the negative control for "no real Stripe, no network".
    #[test]
    fn base_url_default_is_real_stripe() {
        assert_eq!(resolve_base(None), DEFAULT_STRIPE_BASE);
        assert_eq!(resolve_base(Some("")), DEFAULT_STRIPE_BASE);
        assert_eq!(resolve_base(Some("   ")), DEFAULT_STRIPE_BASE);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_override_is_honored_and_trimmed() {
        assert_eq!(
            resolve_base(Some("http://127.0.0.1:12111/")),
            "http://127.0.0.1:12111"
        );
        assert_eq!(
            resolve_base(Some(" http://127.0.0.1:12111 ")),
            "http://127.0.0.1:12111"
        );
    }

    // The release negative control: in a release build the override is IGNORED (the
    // arm is compiled out). This test only compiles/runs under `--release`, but it
    // pins the release posture in source so a regression that reads env in release
    // fails to compile-or-pass under a release test run.
    #[cfg(not(debug_assertions))]
    #[test]
    fn release_ignores_override() {
        assert_eq!(
            resolve_base(Some("http://127.0.0.1:12111")),
            DEFAULT_STRIPE_BASE
        );
    }

    // TEST-1 (unit half) [invariant: INV-2] [PROV-B2-4]: the Checkout Session request
    // SHAPE — mode=subscription, base line item (qty 1) + one metered line PER metered
    // price (no quantity), client_reference_id == the account id, the success/cancel
    // urls, and allow_promotion_codes. This is the assertion an HTTP-level test against
    // the (canned-response) stripe-mock cannot make; it fails on a mode=payment / wrong
    // client_reference_id / dropped-metered-line regression.
    #[test]
    fn checkout_form_shape_is_a_subscription_with_base_and_metered_lines() {
        let form = build_checkout_form(
            "cus_123",
            "price_base",
            &["price_m_compute".to_string(), "price_m_storage".to_string()],
            "https://x/success",
            "https://x/cancel",
            "acct-uuid-abc",
        );
        let get = |k: &str| form.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.as_str());
        assert_eq!(
            get("mode"),
            Some("subscription"),
            "must be subscription mode (INV-2)"
        );
        assert_eq!(get("customer"), Some("cus_123"));
        assert_eq!(
            get("client_reference_id"),
            Some("acct-uuid-abc"),
            "client_reference_id MUST be the account id (the webhook keys the account off it)"
        );
        assert_eq!(get("success_url"), Some("https://x/success"));
        assert_eq!(get("cancel_url"), Some("https://x/cancel"));
        assert_eq!(get("allow_promotion_codes"), Some("true"));
        // base line item [0] with quantity 1
        assert_eq!(get("line_items[0][price]"), Some("price_base"));
        assert_eq!(get("line_items[0][quantity]"), Some("1"));
        // one metered line PER metered price, none carrying a quantity
        assert_eq!(get("line_items[1][price]"), Some("price_m_compute"));
        assert_eq!(get("line_items[2][price]"), Some("price_m_storage"));
        assert!(
            get("line_items[1][quantity]").is_none(),
            "a metered line carries no quantity"
        );
        assert!(get("line_items[2][quantity]").is_none());
    }

    #[test]
    fn checkout_form_with_no_metered_prices_has_only_the_base_line() {
        let form = build_checkout_form("cus_1", "price_base", &[], "s", "c", "a");
        assert!(form.iter().any(|(k, _)| k == "line_items[0][price]"));
        assert!(!form.iter().any(|(k, _)| k == "line_items[1][price]"));
    }

    // TEST-6 (part) [security]: the secret is never in Debug output.
    #[test]
    fn secret_is_redacted_in_debug() {
        let c = StripeClient {
            base: DEFAULT_STRIPE_BASE.to_string(),
            secret: "sk_live_SUPERSECRET".to_string(),
        };
        let dbg = format!("{c:?}");
        assert!(
            !dbg.contains("SUPERSECRET"),
            "secret must not appear in Debug: {dbg}"
        );
        assert!(dbg.contains("<redacted>"));
    }
}

#[cfg(test)]
mod integration_config_tests {
    use super::*;

    fn lazy_pool() -> sqlx::PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy("postgresql://postgres:password@127.0.0.1:54321/unused")
            .expect("lazy pool")
    }

    // TEST-3 [acceptance] [invariant: INV-3]: compat mode (no storage key) resolves the
    // secret from the STRIPE_SECRET_KEY env var via the SAME path as today, touching no
    // DB — byte-identical to `from_env`. In a unit-test context `storage_key()` is unset
    // (only `build_app` initializes it), so the DB branch is never taken and the lazy
    // pool is never dialled.
    #[tokio::test]
    async fn compat_mode_resolves_from_env_without_db() {
        assert!(
            ziee_framework::secrets::storage_key().is_none(),
            "unit-test context must be in compat mode (no storage key initialized)"
        );
        std::env::set_var(SECRET_KEY_ENV, "sk_live_compat_env_value");
        let got = resolve_secret(&lazy_pool()).await.expect("compat resolve");
        std::env::remove_var(SECRET_KEY_ENV);
        assert_eq!(got.as_deref(), Some("sk_live_compat_env_value"));
    }

    // TEST-5 [acceptance] [invariant: INV-5]: the Test-connection classifier never
    // embeds the key or the Stripe body — a bad key is a clean ok:false with a generic
    // message; a 2xx is ok:true. Structurally the fn has no access to the secret.
    #[test]
    fn classify_never_leaks_and_maps_status() {
        let ok = classify_test_result(true, 200);
        assert!(ok.ok);

        let bad = classify_test_result(false, 401);
        assert!(!bad.ok);
        assert!(bad.message.contains("401"));
        // The message is a fixed operator string — it cannot contain a key.
        assert!(!bad.message.to_lowercase().contains("sk_"));

        let neterr = classify_test_result(false, 0);
        assert!(!neterr.ok);
        assert!(neterr.message.to_lowercase().contains("reach"));
    }
}
