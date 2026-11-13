//! `jobs` module — the box-wide concurrency slot the run engine's method runs
//! are admitted through.
//!
//! After strip-single-cell ITEM-3 this module is the KEPT core of the former
//! platform scheduler: [`admission`] (the shared front door every
//! out-of-scheduler sandbox child claims its cap slot through), [`runtime`]
//! (the in-process cancel registry), [`settings`] (the admin-configured
//! concurrency ceiling the engine's drive loop reads), [`models`] +
//! [`repository`] (the job-row core), and the reused [`JobsUse`] permission
//! that gates the `/api/txr/*` surfaces ("no new permission").
//!
//! The single-cell platform's arms are gone with their consumers: the FCFS
//! scheduler + reaper + worker modes (`scheduler.rs`), the dispatcher +
//! in-pod executor (`runner.rs`), the DAG/conformance/verify machinery, the
//! project/dataset authz and the `/jobs*` admin REST surface + its SSE stream
//! (the jobs drawer UI is removed in ITEM-4). The module's migrations stay
//! (DEC-4), so the `jobs` tables keep their historical shape.
//!
//! The module still registers in `MODULE_ENTRIES` for module-order identity,
//! but its init no longer spawns anything and it serves no routes.

pub mod models;
pub mod repository;

// `admission` is `pub` because it is the SHARED front door every out-of-scheduler
// sandbox child goes through (the method-run route + the execution-engine drive
// loop), and its constants are asserted by integration tests. There is exactly
// one concurrency cap in this process; this module is where a caller that is
// not the scheduler claims against it.
pub mod admission;
mod permissions;
pub use permissions::JobsUse;
// `runtime` is `pub` so a run this module does not schedule can still be stopped
// through it: the execution-engine registers the cancel signal at admission and
// its drive loop picks the receiver up.
pub mod runtime;
// `settings` is `pub` for the same reason: an out-of-scheduler run must be admitted
// under the SAME `max_concurrent_jobs` cap, so its caller has to read it.
pub mod settings;

use linkme::distributed_slice;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub struct JobsModule;

impl AppModule for JobsModule {
    fn name(&self) -> &'static str {
        "jobs"
    }

    fn description(&self) -> &'static str {
        "Box-wide concurrency slot for sandboxed method runs (admission + cancel + settings)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // strip-single-cell ITEM-3: the scheduler loop, the boot reconcile and
        // the seam installs were removed with the single-cell platform; the
        // kept surface drives admission/runtime in-process on demand.
        Ok(())
    }

    fn register_routes(&self, router: aide::axum::ApiRouter) -> aide::axum::ApiRouter {
        // strip-single-cell ITEM-3: the `/jobs*` admin REST surface was removed
        // with the jobs drawer UI; the txr routes gate on `JobsUse` directly.
        router
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static JOBS: ModuleEntry = ModuleEntry {
    name: "jobs",
    order: 30,
    description: "Box-wide concurrency slot for sandboxed method runs.",
    constructor: || Box::new(JobsModule),
};
