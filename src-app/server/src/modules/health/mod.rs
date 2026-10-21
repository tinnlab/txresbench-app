//! `health` module — the DB-free liveness surface, adopted verbatim from the
//! SDK's `ziee-health` crate.
//!
//! Mounts `GET /api/health` → `{ "status": "ok" }` (no DB, no auth, no
//! permission) by merging the SDK crate's `routes()` bundle. A self-registering
//! `MODULE_ENTRIES` module so the route lands under the shared `/api` prefix and
//! appears in the emitted OpenAPI like every other CytoAnalyst surface.

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub struct HealthModule;

impl AppModule for HealthModule {
    fn name(&self) -> &'static str {
        "health"
    }

    fn description(&self) -> &'static str {
        "DB-free liveness/readiness surface (GET /health)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(ziee_health::routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static HEALTH: ModuleEntry = ModuleEntry {
    name: "health",
    // Leaf, dependency-free surface; low order so the probe is ready early.
    order: 4,
    description: "DB-free liveness/readiness surface (GET /health).",
    constructor: || Box::new(HealthModule),
};
