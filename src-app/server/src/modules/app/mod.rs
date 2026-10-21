//! `app` module — deployment-level endpoints (first-run setup), mounted under
//! `/app`.

mod handlers;

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

use handlers::{get_setup_status, setup_admin, SetupStatusResponse};

pub struct AppSetupModule;

impl AppModule for AppSetupModule {
    fn name(&self) -> &'static str {
        "app"
    }

    fn description(&self) -> &'static str {
        "Deployment-level endpoints (first-run setup)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.nest(
            "/app",
            ApiRouter::new()
                .api_route("/setup/status", get_with(get_setup_status, status_docs))
                .api_route("/setup/admin", post_with(setup_admin, admin_docs)),
        )
    }
}

fn status_docs(op: TransformOperation) -> TransformOperation {
    op.description("Whether the deployment still needs first-run setup")
        .id("App.getSetupStatus")
        .tag("app")
        .response::<200, Json<SetupStatusResponse>>()
}

fn admin_docs(op: TransformOperation) -> TransformOperation {
    op.description("Create the first admin account (only when none exists)")
        .id("App.setupAdmin")
        .tag("app")
        .response::<201, Json<ziee_auth::auth::types::AuthResponse>>()
}

#[distributed_slice(MODULE_ENTRIES)]
static APP: ModuleEntry = ModuleEntry {
    name: "app",
    order: 3,
    description: "Deployment-level endpoints (first-run setup).",
    constructor: || Box::new(AppSetupModule),
};
