//! Realtime cross-device sync module.
//!
//! Mounts the SDK's per-user SSE stream (`GET /api/sync/subscribe`,
//! `txresbench_framework::sync::sync_routes`) over TxResBench's concrete wire
//! vocabulary (`event`) + registry/surface (`surface`). Mutating handlers call
//! [`publish`] with an explicit `Audience`; the per-user keyed registry routes
//! delivery + suppresses self-echo. Notify-and-refetch only — no row data
//! crosses the wire.

mod auth_sink;
mod event;
mod resolver;
mod surface;

pub use auth_sink::install as install_auth_sync_sink;
#[allow(unused_imports)]
pub use event::publish_session_to_users;
pub use event::{
    fan_out_owner_scoped, owner_scoped_audience, publish, Actor, SyncAction, SyncEntity,
};
pub use txresbench_framework::sync::{Audience, SyncOrigin};

use std::sync::Arc;

use aide::axum::ApiRouter;
use axum::Extension;
use linkme::distributed_slice;

use txresbench_auth::auth::JwtService;
use txresbench_framework::sync::sync_routes;
use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

use resolver::SyncIdentityResolver;

#[derive(Default)]
pub struct SyncModule {
    /// Built in `init`, consumed by `register_routes` (which only has `&self`).
    resolver: Option<Arc<SyncIdentityResolver>>,
}

impl AppModule for SyncModule {
    fn name(&self) -> &'static str {
        "sync"
    }

    fn description(&self) -> &'static str {
        "Realtime cross-device sync over SSE"
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // Capture the pool so the static SSE re-check can re-resolve identities.
        surface::set_pool((*ctx.db_pool).clone());
        // The resolver backing THIS module's routes. It exists only to supply
        // `access_token_ver` — the access-token revocation epoch the periodic
        // re-check needs to end a stream on logout (see `resolver.rs`). Built
        // from the same `jwt` config block `AuthModule` mints with, so the
        // tokens are interoperable.
        let jwt = Arc::new(JwtService::try_new(ctx.config.jwt.clone())?);
        self.resolver = Some(Arc::new(SyncIdentityResolver::new(
            (*ctx.db_pool).clone(),
            jwt,
        )));
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        let Some(resolver) = self.resolver.clone() else {
            tracing::error!("SyncModule: not initialized before register_routes");
            return router;
        };
        // The subscribe route resolves identity through `SyncIdentityResolver`,
        // so it needs that resolver in the request extensions — the turnkey
        // `AuthModule` installs only `Arc<DefaultIdentityResolver>`. Layered
        // AFTER the merge so it covers the route just added.
        router
            .merge(sync_routes::<SyncIdentityResolver, surface::CytoSyncSurface>())
            .layer(Extension(resolver))
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static SYNC: ModuleEntry = ModuleEntry {
    name: "sync",
    // Leaf SSE module; low order so the route + registry are ready early.
    order: 5,
    description: "Realtime cross-device sync over SSE",
    constructor: || Box::new(SyncModule::default()),
};
