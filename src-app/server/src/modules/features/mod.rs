//! `features` module — the runtime, admin-togglable feature-flags subsystem (#40).
//!
//! Adds a RUNTIME flag layer on top of the app's compile-time gating (cargo `saas`,
//! `MODULE_ENTRIES`, `CORE_MODULE_BLOCKLIST`, the `seed_only_enabled` env). A flag has
//! a GLOBAL default plus optional PER-ACCOUNT overrides (`feature_flags` table), a
//! compiled registry of defaults (`registry`), a single runtime guard
//! (`guard::is_feature_enabled` — the seam other modules consult), and an admin
//! GET/PUT surface (`/api/admin/features`) gated by `features::manage`.
//!
//! NOT saas-gated: runtime feature toggles are a general admin capability that belongs
//! in every build (mirrors `admin/mod.rs`, which is likewise in every build). Thin: no
//! background task, no sync emitter this round (the surface is a settings-style
//! GET/PUT; live cross-console refresh can be added later like `JobSettings`).
//!
//! `guard`, `registry`, `models`, `repository` are `pub` so other modules can consult
//! the seam and so integration tests can drive the layers directly against a per-test
//! pool.

pub mod guard;
pub mod models;
pub mod registry;
pub mod repository;

mod permissions;
mod routes;

// The seam + vocabulary other modules / the FE consume.
pub use guard::is_feature_enabled;
pub use permissions::FeaturesManage;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub struct FeaturesModule;

impl AppModule for FeaturesModule {
    fn name(&self) -> &'static str {
        "features"
    }

    fn description(&self) -> &'static str {
        "Runtime feature flags (global defaults + per-account overrides)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // No init-time work: the flag registry is compiled, the table is migrated by
        // the merged migrator, and the guard reads at use.
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // `/api/admin/features` (+ `/{flag_key}`) — the admin flag surface.
        router.merge(routes::features_routes())
    }
}

// A unique `order` (see `modules/mod.rs::module_order_is_unique`). 45 is `admin`, 40 is
// the saas-gated `billing`; `features` takes 46 — clear of every current value and
// adjacent to the admin surface it belongs beside.
#[distributed_slice(MODULE_ENTRIES)]
static FEATURES: ModuleEntry = ModuleEntry {
    name: "features",
    order: 46,
    description: "Runtime feature-flags subsystem (TxResBench admin console).",
    constructor: || Box::new(FeaturesModule),
};
