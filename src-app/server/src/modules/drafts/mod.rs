//! `drafts` module — the domain-free draftable-entity primitive.
//!
//! A draftable entity is the missing middle state between a run's transient form and
//! an immutable artifact: a mutable, project-scoped, serializable working document a
//! user curates across sessions, which FREEZES into an immutable, provenance-bearing
//! artifact. Core stores only an OPAQUE shape `{id, kind, project_id, data, status,
//! frozen_artifact_id}` — it interprets NOTHING about a draft's `kind` or `data`
//! (INV-1). The domain (the schema of `data`, the edit view, the freeze producer)
//! lives entirely in the package that declares a `draftable:` block.
//!
//! Flat CRUD module mirroring `modules/project`: `routes` / `handlers` / `models` /
//! `repository` / `permissions`, plus a `sync` emit split (mirroring
//! `workstore::sync`) and a `freeze` transition (ITEM-7).

mod freeze;
mod handlers;
mod models;
mod permissions;
mod repository;
mod routes;
mod sync;

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub use permissions::DraftsUse;

// The async auto-freeze-on-consume seam (ITEM-8 / INV-4 / DEC-2 final). At job-CREATE
// time `resolve_draft_inputs_for_create` validates every `draft_ref` input, enqueues a
// freeze producer per open draft, and returns the freeze-job DEPENDENCIES the consumer is
// made `blocked` on (no producer is ever awaited synchronously). The freeze-completion
// hook then pins `artifact_ref` into the consumer before it unblocks;
// `assert_no_unresolved_draft_refs` is the runner's defense-in-depth guard.
pub use freeze::{
    assert_no_unresolved_draft_refs, resolve_draft_inputs_for_create, DraftResolution,
    FreezeCompletion,
};

pub struct DraftsModule;

impl AppModule for DraftsModule {
    fn name(&self) -> &'static str {
        "drafts"
    }

    fn description(&self) -> &'static str {
        "Draftable entities — a domain-free mutable→frozen working-state primitive."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Install the draftable freeze-completion hook into the jobs `FreezeCompletionSink`
        // seam (pool baked in). The jobs completion path calls it when a freeze producer
        // job completes — to pin `artifact_ref` into dependent consumers + stamp the draft
        // `frozen` BEFORE unblocking them (DEC-2 final). Installed HERE (not from jobs)
        // so the jobs module never imports drafts; the slot is read only at runtime
        // completion, so drafts-init (order 26) before jobs-init (30) is not load-bearing.
        let pool = (*ctx.db_pool).clone();
        crate::modules::jobs::seams::install_freeze_completion_sink(Arc::new(
            freeze::FreezeCompletion::new(pool),
        ));
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::draft_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static DRAFTS: ModuleEntry = ModuleEntry {
    name: "drafts",
    order: 26,
    description: "Draftable entities (CytoAnalyst).",
    constructor: || Box::new(DraftsModule),
};
