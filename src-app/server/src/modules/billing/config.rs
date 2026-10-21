//! Billing operational config (DEC-9) — the success/cancel/return URLs the
//! Checkout + Portal sessions redirect back to, sourced from env (12-factor,
//! DEC-3), with dev defaults so the local tier needs no env. The Stripe SECRET is
//! read by [`super::client::StripeClient::from_env`], not here.

/// Env var names for the redirect URLs.
pub const SUCCESS_URL_ENV: &str = "STRIPE_CHECKOUT_SUCCESS_URL";
pub const CANCEL_URL_ENV: &str = "STRIPE_CHECKOUT_CANCEL_URL";
pub const RETURN_URL_ENV: &str = "STRIPE_PORTAL_RETURN_URL";

/// The Stripe webhook signing secret env var (`whsec_…`, PROV-B0-4 / DEC-2/-13).
pub const WEBHOOK_SECRET_ENV: &str = "STRIPE_WEBHOOK_SECRET";

/// The Stripe webhook signing secret (`whsec_…`), read from env at request time (DEC-13).
/// `None` when unset/empty — the webhook route then **fails closed** (rejects every event,
/// because nothing can be verified), which is the correct secure default for a misconfigured
/// deployment and never a silent accept. Never a process-wide `set_var`; the local test
/// harness (`billing-sim-up`) exports it (PROV-B0-4), inherited by the spawned server.
pub fn webhook_secret() -> Option<String> {
    std::env::var(WEBHOOK_SECRET_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// Kill-switch env var for the whole rollup fold+report loop (B1, DEC-4).
pub const ROLLUP_ENABLED_ENV: &str = "CYTO_BILLING_ROLLUP_ENABLED";
/// Rollup cadence env var, in hours (B1, DEC-4).
pub const ROLLUP_INTERVAL_ENV: &str = "CYTO_BILLING_ROLLUP_INTERVAL_HOURS";
/// Kill-switch env var for the usage-alert ladder loop (B4, DEC-6).
pub const ALERT_ENABLED_ENV: &str = "CYTO_BILLING_ALERT_ENABLED";
/// Alert-ladder cadence env var, in hours (B4, DEC-6).
pub const ALERT_INTERVAL_ENV: &str = "CYTO_BILLING_ALERT_INTERVAL_HOURS";

const DEFAULT_SUCCESS_URL: &str = "https://app.cytoanalyst.local/billing/success";
const DEFAULT_CANCEL_URL: &str = "https://app.cytoanalyst.local/billing/cancel";
const DEFAULT_RETURN_URL: &str = "https://app.cytoanalyst.local/billing";

/// The redirect URLs a checkout/portal session sends the browser back to.
#[derive(Debug, Clone)]
pub struct BillingConfig {
    pub success_url: String,
    pub cancel_url: String,
    pub return_url: String,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

impl BillingConfig {
    /// Read the redirect URLs from env, falling back to dev defaults.
    pub fn from_env() -> Self {
        Self {
            success_url: env_or(SUCCESS_URL_ENV, DEFAULT_SUCCESS_URL),
            cancel_url: env_or(CANCEL_URL_ENV, DEFAULT_CANCEL_URL),
            return_url: env_or(RETURN_URL_ENV, DEFAULT_RETURN_URL),
        }
    }

    /// The **deploy-level `Option<BillingConfig>` kill-switch** (§16 second side /
    /// B5 ITEM-5, INV-2): billing is CONFIGURED for a deployment only when the
    /// Stripe secret is present. Returns `Some(BillingConfig)` (the redirect URLs)
    /// when configured, `None` otherwise.
    ///
    /// This is the runtime second side of the `saas` compile-out. On desktop the
    /// whole `billing` module is compiled OUT (the primary side), so this is never
    /// reached there; but even a *hypothetically* saas-compiled binary that ships
    /// no Stripe secret returns `None` here, and the `BillingModule::init` +
    /// `register_routes` guards then refuse to mount `/api/billing/*` and the boot
    /// loop spawns nothing — "no `BillingConfig` ⇒ billing does not mount" (§16, the
    /// runtime config flag). Keyed on the Stripe secret (a 12-factor env, DEC-3),
    /// read once here; never a process-wide `set_var`.
    pub fn from_env_opt() -> Option<Self> {
        let configured = std::env::var(super::client::SECRET_KEY_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .is_some();
        configured.then(Self::from_env)
    }
}

/// Operational tunables for the B1 rollup loop (DEC-4). Mirrors
/// `WorkstoreLimits` (`workstore/config.rs`): safe defaults, an env override each so
/// an operator/test can adjust without a rebuild, and a deploy kill-switch. Promotable
/// to an admin `*_settings` row later without a rewrite (the `Limits`-struct shape).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BillingLimits {
    /// Enable the standing rollup fold+report loop (the DEC-4 kill-switch; the boot
    /// spawn is gated on it, exactly like `gc_enabled`).
    pub rollup_enabled: bool,
    /// Fold+report cadence in hours (default 6, mirroring the GC sweep). Clamped to
    /// `1..=720` so a footgun value can't disable the loop or hammer the DB.
    pub rollup_interval_hours: u64,
    /// Enable the standing usage-alert ladder loop (the DEC-6 kill-switch; the boot spawn
    /// is gated on it, exactly like `rollup_enabled`).
    pub alert_enabled: bool,
    /// Alert-ladder cadence in hours (default 6, mirroring the rollup loop). Clamped to
    /// `1..=720`.
    pub alert_interval_hours: u64,
}

impl Default for BillingLimits {
    fn default() -> Self {
        Self {
            rollup_enabled: true,
            rollup_interval_hours: 6,
            alert_enabled: true,
            alert_interval_hours: 6,
        }
    }
}

impl BillingLimits {
    /// Resolve from env overrides, falling back to defaults (bounds-clamped).
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            rollup_enabled: env_bool(ROLLUP_ENABLED_ENV).unwrap_or(d.rollup_enabled),
            rollup_interval_hours: env_u64(ROLLUP_INTERVAL_ENV)
                .map(|h| h.clamp(1, 24 * 30))
                .unwrap_or(d.rollup_interval_hours),
            alert_enabled: env_bool(ALERT_ENABLED_ENV).unwrap_or(d.alert_enabled),
            alert_interval_hours: env_u64(ALERT_INTERVAL_ENV)
                .map(|h| h.clamp(1, 24 * 30))
                .unwrap_or(d.alert_interval_hours),
        }
    }
}

/// Parse a boolean env var (`1`/`true`/`yes`/`on` ⇒ true; `0`/`false`/`no`/`off` ⇒
/// false); `None` when unset or unrecognized (so the default stands).
fn env_bool(name: &str) -> Option<bool> {
    match std::env::var(name)
        .ok()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Parse a `u64` env var; `None` when unset or unparsable.
fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.trim().parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_env_unset() {
        // The pure `env_or` fallback is what a no-env local run uses.
        assert_eq!(
            env_or("BILLING_NO_SUCH_ENV_XYZ", DEFAULT_SUCCESS_URL),
            DEFAULT_SUCCESS_URL
        );
    }

    // TEST-10 (unit) [covers: ITEM-2] — the DEC-4 tunable/kill-switch defaults:
    // rollup ON, cadence 6h (mirrors WorkstoreLimits). The clamp keeps a footgun
    // value in-range.
    #[test]
    fn billing_limits_defaults_are_enabled_and_six_hours() {
        let d = BillingLimits::default();
        assert!(d.rollup_enabled, "rollup loop defaults ON");
        assert_eq!(d.rollup_interval_hours, 6, "default cadence 6h (GC parity)");
    }

    #[test]
    fn env_bool_none_when_unset() {
        // An unset var yields None so the default stands (no global-env mutation, to
        // avoid cross-test set_var races — the spellings are covered by from_env at
        // the integration layer where env is controlled per-process).
        assert_eq!(env_bool("BILLING_NO_SUCH_ENV_XYZ_UNSET"), None);
        assert_eq!(env_u64("BILLING_NO_SUCH_ENV_XYZ_UNSET"), None);
    }
}
