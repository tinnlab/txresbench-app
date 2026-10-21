//! `user` module — user + group administration over ziee-auth's repositories.

pub mod handlers;
pub mod permissions;
pub mod routes;
pub mod types;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub struct UserModule;

impl AppModule for UserModule {
    fn name(&self) -> &'static str {
        "user"
    }

    fn description(&self) -> &'static str {
        "User and group administration."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router
            .merge(routes::user_router())
            .merge(routes::group_router())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static USER: ModuleEntry = ModuleEntry {
    name: "user",
    order: 15,
    description: "User and group administration.",
    constructor: || Box::new(UserModule),
};
