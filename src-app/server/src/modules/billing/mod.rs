//! `billing` module (B2) — the self-serve payments layer: the `billing` module +
//! `/api/billing/*` routes that turn a Free account into an active Stripe
//! subscription (Checkout), let it self-manage (Customer Portal), and push metered
//! overage (Billing Meters). Registers into `MODULE_ENTRIES` like `jobs`.
//!
//! **`saas`-gated (INV-5 / §8).** The WHOLE module is compiled only under
//! `#[cfg(feature = "saas")]` — its declaration in `modules/mod.rs` carries the
//! gate, so on desktop/default the module, the Stripe client, the routes and the
//! `MODULE_ENTRIES` registration are all physically absent. The `accounts` billing
//! COLUMNS, by contrast, exist in BOTH builds (the migration tree is scanned by
//! build.rs regardless of the feature), so desktop carries the columns with their
//! safe defaults and simply never creates a Customer.
//!
//! Provides (the frozen SEAMS contracts B3/B4 bind — see `.lifecycle/billing/`):
//!  - **PROV-B2-1** account↔customer link (BIDIRECTIONAL) + state columns — `repository`.
//!  - **PROV-B2-2** plan/price catalog + allowance lookup — `catalog`.
//!  - **PROV-B2-3** meter-event push API — `meter`.
//!  - **PROV-B2-4** self-serve `/api/billing/{checkout,portal}` + this module mount.

// Admin read-any-account billing surface (#36) — the cross-account, PATH-scoped reads of ANY
// account's subscription/usage/quota, gated on `billing::admin`. A member of THIS saas-gated
// module (INV-4) so no `billing::admin`/Stripe symbol leaks into the desktop/default binary.
pub mod admin;
pub mod alerts;
pub mod catalog;
pub mod client;
pub mod config;
pub mod dunning;
// Admin Billing-integration surface (#60) — the deployment-level ENCRYPTED Stripe
// credential config, gated `billing::admin`. A saas member (INV-4) so no secret-config
// symbol leaks into the desktop/default binary.
pub mod integration;
pub mod meter;
pub mod models;
pub mod permissions;
pub mod quota;
pub mod repository;
pub mod rollup;
// #141 — the SEAT allowance policy (the plan-derived member limit + its 422). The
// counting half and the call sites live in `account::seat`, which is UNGATED; this half
// is a saas member like every other billing surface, so desktop links none of it.
pub mod seat;
pub mod sync;
pub mod webhook;

mod handlers;
mod routes;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The billing module. Stateless — it mounts routes and validates env at first use
/// (the Stripe secret / price ids are 12-factor env, DEC-3), so `init` only logs the
/// enablement posture.
pub struct BillingModule;

impl AppModule for BillingModule {
    fn name(&self) -> &'static str {
        "billing"
    }

    fn description(&self) -> &'static str {
        "Self-serve Stripe billing (Checkout + Customer Portal + Billing Meters)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // §16 deploy-level kill-switch (second side of INV-2, B5 ITEM-5): the SAME
        // `Option<BillingConfig>`-present check that ENFORCES the mount refusal in
        // `register_routes` (before `.merge()`) and the fold-loop spawn in `lib.rs`
        // is surfaced here too. `init` itself has no side effect to suppress — it only
        // LOGS the enablement posture (so an operator sees WHY billing did/didn't
        // mount); the actual refusal lives in `register_routes` + the `lib.rs` guard.
        match config::BillingConfig::from_env_opt() {
            Some(_) => tracing::info!(
                base = %client::stripe_base_url(),
                "billing: module enabled (saas) — Stripe configured; routes will mount"
            ),
            None => tracing::info!(
                "billing: compiled (saas) but NO Stripe secret configured — the \
                 Option<BillingConfig> deploy kill-switch (§16) refuses to mount \
                 /api/billing/* and spawns no fold/alert loop"
            ),
        }
        Ok(())
    }

    fn register_routes(&self, mut router: ApiRouter) -> ApiRouter {
        // Admin Billing-integration config (#60, DEC-3): mounted UNCONDITIONALLY in a
        // saas binary, INDEPENDENT of the §16 env kill-switch — an admin must be able to
        // reach this page to perform the FIRST DB config even when no `STRIPE_SECRET_KEY`
        // env is set (bootstrapping). It is NOT gated on `secrets.storage_key`: gating the
        // MOUNT on a runtime config value would make the endpoints non-deterministic in
        // the generated OpenAPI spec (`just openapi-regen` sets no storage key). Instead
        // the STORAGE is gated at the handler — a PUT with no `storage_key` returns a clean
        // 400 (`encrypt_or_refuse`), and GET/test still work (masked env-fallback view).
        // Still saas-gated (this whole module) + `billing::admin`-gated (its extractor).
        router = router.merge(integration::integration_routes());

        // §16: the kill-switch guard for the SELF-SERVE surface. No `BillingConfig` (no
        // Stripe secret env) ⇒ `/api/billing/*` + the #36 cross-account admin reads are
        // not mounted even in a saas binary — the runtime second side of the compile-out.
        // (The integration-config routes above are deliberately NOT behind this gate.)
        if config::BillingConfig::from_env_opt().is_none() {
            return router;
        }
        // The self-serve `/api/billing/*` routes + the #36 cross-account admin
        // `/api/admin/accounts/{id}/{billing,usage,quota}` READ routes. Both ride this same
        // §16 kill-switch (mounted only when Stripe is configured) and the module's saas gate.
        router
            .merge(routes::billing_routes())
            .merge(admin::admin_billing_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static BILLING: ModuleEntry = ModuleEntry {
    name: "billing",
    // 40 — a distinct order (unique across the linked set; see
    // `modules::tests::module_order_is_unique`). After jobs (30) / provenance (35).
    order: 40,
    description: "Self-serve Stripe billing (Checkout + Customer Portal + Billing Meters).",
    constructor: || Box::new(BillingModule),
};

#[cfg(test)]
mod tests {
    use ziee_framework::MODULE_ENTRIES;

    // TEST-8 (part) [invariant: INV-5]: under `saas` the billing module registers
    // its `MODULE_ENTRIES` entry (this test only compiles under the feature, so its
    // presence IS the saas-on half of the compile-out proof). The saas-OFF half — the
    // module + registration are ABSENT — is asserted by the source-grep integration
    // test `tests/billing/saas_gating_test.rs`, which runs in the default build.
    #[test]
    fn billing_module_registers_under_saas() {
        let entry = MODULE_ENTRIES
            .iter()
            .find(|e| e.name == "billing")
            .expect("billing ModuleEntry registered under the saas feature");
        assert_eq!(entry.order, 40, "billing keeps its distinct module order");
    }
}
