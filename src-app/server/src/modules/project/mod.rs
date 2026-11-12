//! `project` module — the top-level, owner-scoped grouping above datasets/analyses
//! (TxResBench's home surface). Owner-scoped CRUD + dataset grouping + a
//! per-project resource ACL (email sharing) + admin-gated ownership transfer, with
//! realtime sync + notification delivery.

mod admin_handlers;
mod core;
mod extension_registration;
pub mod gc;
mod handlers;
pub mod lifecycle;
mod models;
mod permissions;
mod repository;
mod routes;
pub mod scope;

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};
use txresbench_notification::{NotificationKindDescriptor, NOTIFICATION_KINDS};

pub use self::core::extension::{
    ProjectExtension, ProjectExtensionEntry, ProjectExtensionRegistry, ProjectSummaryTag, PROJECT_EXTENSIONS,
};
// Re-exports consumed by project extensions living in other modules (e.g. the
// dataset project-extension's summary route needs the project permission + the ACL
// resolver). Keeps those internals reachable without widening the whole module.
// `EffectivePermission` is re-exported for `jobs::authz`, which grades a project-scoped
// job's audience by the SAME resolver the project's own gates use rather than
// hand-copying its share predicate (the drift `799d0cf3` had to repair).
pub use models::EffectivePermission;
pub use permissions::ProjectsUse;
// `CancelledTransfer` rides out with the repository: #171 (a)'s offboarding hook is
// called from `account::AccountRepository::remove_member` (the one chokepoint every
// removal path reaches) and its result is fanned out by the admin removal route, so
// both live outside this module.
pub use repository::{CancelledTransfer, ProjectRepository};
// The P10-owned cross-part seams downstream parts consume (P1 data-API + blob-GC,
// P6 workbench bootstrap, P9 per-project MCP).
pub use gc::{sweep_gc_manifest, BlobRef, GcManifest};
pub use scope::{
    authz_precedence, role_allows_safety, role_max_safety, project_audience, SafetyTier, ProjectScope,
};

pub struct ProjectModule;

impl AppModule for ProjectModule {
    fn name(&self) -> &'static str {
        "project"
    }

    fn description(&self) -> &'static str {
        "Projects — owner-scoped grouping of datasets/analyses, with sharing + transfer."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Build the project-extension registry from every discovered
        // `#[distributed_slice(PROJECT_EXTENSIONS)]` entry and publish it as the
        // process-wide singleton. `init` runs (for ALL modules) before any
        // `register_routes`, so the singleton is set before the route fold reads
        // it, and before any delete/duplicate handler fires a hook.
        let registry = Arc::new(extension_registration::auto_register_project_extensions(
            (*ctx.db_pool).clone(),
        ));

        {
            let registry = registry.clone();
            let pool = (*ctx.db_pool).clone();
            tokio::spawn(async move {
                if let Err(e) = registry.initialize_all(&pool).await {
                    tracing::error!("Project extension initialize_all failed: {}", e);
                }
            });
        }

        self::core::extension::set_global_registry(registry);
        tracing::info!("Project module initialized with auto-registered extensions");
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // Fold in each extension's routes (e.g. the dataset extension's
        // dataset-summary route), then the project core + admin routes.
        let router = match self::core::extension::get_global_registry() {
            Some(registry) => registry.register_routes(router),
            None => router,
        };
        router
            .merge(routes::project_routes())
            .merge(routes::project_admin_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static PROJECT: ModuleEntry = ModuleEntry {
    name: "project",
    order: 25,
    description: "Project management (TxResBench).",
    constructor: || Box::new(ProjectModule),
};

// ---- notification kinds this module contributes (backend half of the SDK
// per-module notification seam; the FE registers the matching renderers) ----

#[distributed_slice(NOTIFICATION_KINDS)]
static SHARE_INVITE_KIND: NotificationKindDescriptor = NotificationKindDescriptor {
    kind: handlers::KIND_SHARE_INVITE,
    description: "A user shared a project with you (accept to import, or decline).",
};

#[distributed_slice(NOTIFICATION_KINDS)]
static TRANSFER_INVITE_KIND: NotificationKindDescriptor = NotificationKindDescriptor {
    kind: handlers::KIND_TRANSFER_INVITE,
    description: "A user offered to transfer project ownership to you (accept or decline).",
};

#[distributed_slice(NOTIFICATION_KINDS)]
static OWNERSHIP_CHANGED_KIND: NotificationKindDescriptor = NotificationKindDescriptor {
    kind: handlers::KIND_OWNERSHIP_CHANGED,
    description: "An administrator moved a project to you; you are now its owner.",
};
