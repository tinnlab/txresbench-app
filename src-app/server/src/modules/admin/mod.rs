//! `admin` module — the cross-account ADMIN surface (Tier-0 of the Admin Console
//! epic #30). Owns the admin permission vocabulary (`admin::accounts`), the
//! membership-free `AdminAccountScope` resolution SEAM (#31), and the
//! `/api/admin/accounts/{account_id}` proof-of-concept read (the surface #33/#34/#35/#36
//! build on).
//!
//! NOT saas-gated: accounts and `is_admin` exist in every build (the `account` module
//! is not saas-gated), so cross-account admin belongs in every build (DEC-5). The
//! cross-account BILLING key (`billing::admin`) lives in the saas-gated `billing`
//! module instead, so no Stripe/billing symbol leaks into the desktop/default binary.
//!
//! Deliberately thin: no sync emitters, no background task, no migration (the
//! `admin::accounts` vocabulary is route-bound, not group-granted — Administrators
//! hold it via `*` / `is_admin`; DEC-8). Mirrors `account/mod.rs`.

pub mod extractor;
mod permissions;
mod routes;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

// The seam + vocabulary Tier-1 (#33/#34/#35/#36) consume.
pub use extractor::{AdminAccountScope, ACCOUNT_PATH_PARAM};
pub use permissions::AdminAccounts;

pub struct AdminModule;

impl AppModule for AdminModule {
    fn name(&self) -> &'static str {
        "admin"
    }

    fn description(&self) -> &'static str {
        "Admin — cross-account administration surface + vocabulary."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // No init-time work: no extension registry, no background task, no migration.
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // `/api/admin/accounts/{account_id}` — the cross-account admin read (#31 PoC).
        router.merge(routes::admin_routes())
    }
}

// A unique `order` (see `modules/mod.rs::module_order_is_unique`). 40 is taken by the
// saas-gated `billing` module (which links under `--features saas`), so `admin` takes
// 45 — clear of every current value and of the account module (23) it depends on for
// `AccountRepository`.
#[distributed_slice(MODULE_ENTRIES)]
static ADMIN: ModuleEntry = ModuleEntry {
    name: "admin",
    order: 45,
    description: "Cross-account administration surface (CytoAnalyst admin console).",
    constructor: || Box::new(AdminModule),
};
