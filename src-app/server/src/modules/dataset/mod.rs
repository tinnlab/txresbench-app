//! `dataset` module — dataset lifecycle management: upload, grouping, promotion,
//! supporting-file integration, and the processor-run launch. Domain-agnostic: what
//! a dataset CONTAINS is decided by the contributed datatype registry, never here.
//! Registers itself into the framework's `MODULE_ENTRIES` slice.

pub mod models;
// `POST /datasets/{id}/process` — the dataset-scoped processor-run launch (reuses
// the jobs/sandbox path). Its route is registered from `routes::dataset_routes()`.
pub mod process;
// The supporting-file integration-completion hook (installs the jobs
// `IntegrationSink` seam from this module's `init` — see `DatasetModule::init`).
pub mod integration;
pub mod repository;
mod routes;
/// This deployment's upload SIZE POLICY (#185 §1): `None` on desktop/self-hosted
/// (the owner's ruling — the user's own disk is the limit), `Some(configured)` under
/// `#[cfg(feature = "saas")]`.
///
/// Re-exported rather than left private because it is the one function that encodes
/// the ruling, and the acceptance test for INV-1 has to assert the PRODUCTION
/// resolver's answer — not a `None` the test picked itself, which would stay green if
/// a desktop build grew a cap.
pub use routes::upload_body_ceiling;
// The dataset's OWN sync audience (owner ∪ sharees), for the DETACHED emits that
// have no acting user — a job's terminal transition, its metadata harvest, a
// supporting-file integrate. Takes no `owner_id` parameter by design; see the
// module docs.
pub mod sync;
// The dataset project-extension (registers into `PROJECT_EXTENSIONS` via a
// distributed-slice static in `project_extension/extension.rs` — this `pub mod` is
// what links that registration).
pub mod project_extension;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub struct DatasetModule;

impl AppModule for DatasetModule {
    fn name(&self) -> &'static str {
        "dataset"
    }

    fn description(&self) -> &'static str {
        "Dataset lifecycle management (upload, grouping, promotion, integration)."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Install the supporting-file integration-completion hook into the jobs
        // `IntegrationSink` seam (pool baked in). The jobs runner calls it when an
        // integrate job finalizes to write the coverage summary + emit `sync:dataset`.
        // Installed here (NOT from jobs/mod.rs) so jobs never imports the dataset
        // module; the slot is read only at runtime finalize, so order-20-before-30 is
        // not load-bearing.
        let pool = (*ctx.db_pool).clone();
        crate::modules::jobs::seams::install_integration_sink(std::sync::Arc::new(
            integration::DatasetIntegrationSink::new(pool),
        ));
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::dataset_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static DATASET: ModuleEntry = ModuleEntry {
    name: "dataset",
    order: 20,
    description: "Dataset lifecycle management (upload, grouping, promotion, integration).",
    constructor: || Box::new(DatasetModule),
};
