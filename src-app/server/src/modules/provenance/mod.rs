//! `provenance` module (P4) — provenance capture + content-addressed code-blob
//! store + selection-recipe interaction chokepoint + reproduce/RO-Crate export,
//! grounded on P1's already-merged `workstore` catalog. The graph = P1's catalog;
//! this module owns the run-node/used-edge sidecar + the backward walk + the
//! export wedge. Registers into `MODULE_ENTRIES` (order 35).

pub mod action_registry;
pub mod authz;
pub mod capture;
pub mod criteria_script;
pub mod env_obtain;
pub mod export;
pub mod graph;
pub mod handlers;
pub mod inputs;
pub mod interaction;
pub mod models;
pub mod permissions;
/// TEST-ONLY python driver for the emitted `select(ctx)` scripts.
#[cfg(test)]
pub mod pyrun;
pub mod recorder;
pub mod repository;
/// The rootfs-cache eviction driver (#154) — the schedule + the referenced-digest
/// set that `rootfs::cache`'s eviction mechanism needs.
pub mod rootfs_gc;
pub mod routes;
pub mod seams;
pub mod settings;
pub mod settings_cache;
// Links the `#[distributed_slice(PROJECT_EXTENSIONS)]` registration.
pub mod project_extension;
pub mod verify;

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub struct ProvenanceModule;

impl AppModule for ProvenanceModule {
    fn name(&self) -> &'static str {
        "provenance"
    }

    fn description(&self) -> &'static str {
        "Provenance capture + code-blob store + reproduce/RO-Crate export (CytoAnalyst P4)."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Install the process-wide capture notify seam (no-op this round; a future
        // compute chokepoint swaps in a real impl here).
        seams::install_capture(Arc::new(seams::NoopProvenanceCapture));
        // Install the REAL run recorder into the jobs seam (P4 ITEM-1/2). jobs
        // (order 30) leaves the recorder slot free; provenance (order 35) fills it
        // here, so jobs never imports provenance.
        let pool = (*ctx.db_pool).clone();
        crate::modules::jobs::seams::install_recorder(Arc::new(
            recorder::ProvenanceRunRecorder::new(pool.clone()),
        ));

        // Bound the rootfs extraction cache (#154). Nothing else reclaims it: the
        // OCI provider re-resolves a MOVING tag on every run and stages each new
        // content digest under `<app_data>/sandbox-rootfs/`, so without this the
        // directory grows by one ~300 MB dir per env-image republish, forever.
        // Driven from here because the keep-set is `provenance_run_repro`'s.
        rootfs_gc::spawn_loop(pool.clone());

        // Boot reclamation: resolve any `pending` verification orphaned by a prior
        // process (its detached re-run task died with the server) so it never
        // hangs forever. Spawned (not awaited) — mirrors the jobs orphan reset.
        tokio::spawn(async move {
            let repo = repository::ProvenanceRepository::new(pool);
            match repo.reset_pending_verifications().await {
                Ok(n) if n > 0 => {
                    tracing::info!(count = n, "provenance: reset orphaned pending verifications on boot")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = ?e, "provenance: pending-verification reset failed"),
            }
        });
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::provenance_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static PROVENANCE: ModuleEntry = ModuleEntry {
    name: "provenance",
    order: 35,
    description: "Provenance capture + reproduce/RO-Crate export (CytoAnalyst P4).",
    constructor: || Box::new(ProvenanceModule),
};
