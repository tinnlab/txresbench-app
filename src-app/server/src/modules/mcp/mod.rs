//! `mcp` module — the AI-controllable-actions MCP exposure surface (`ai-mcp`
//! slice 1, backend). CytoAnalyst is the MCP **server** (exposer); ziee chat
//! is the AI **host** (owns the LLM/chat loop/approval UX) — this module never
//! runs an LLM and never shows an approval prompt.
//!
//! A single JSON-RPC endpoint (`POST /api/mcp`, [`handlers::jsonrpc_handler`])
//! merges TWO capability catalogs behind one uniform
//! `list_capabilities`/`describe_capability`/`invoke_capability` surface:
//! - the SDK-derived REST/OpenAPI catalog (`ziee_control_mcp::catalog`,
//!   populated from the finished OpenAPI doc in `lib.rs::build_app`), and
//! - the frontend-action catalog ([`frontend_catalog`]) — the APP-OWNED shell
//!   actions parsed from the committed `frontend-actions.json`, MERGED with the
//!   VIEW-SCOPED actions the controlled browser session REPORTS
//!   ([`capabilities`]) when it registers a declarative processor's view_spec.
//!   The server never parses a view_spec: the FE runtime owns that schema, so it
//!   owns the projection, and a new domain never needs a server rebuild.
//!
//! `invoke_capability` routes by where the operation_id resolved: a REST
//! (`kind=rest`) op dispatches over loopback carrying the caller's forwarded
//! JWT (ported from ziee's `modules/control_mcp`, minus its `chat_extension` /
//! `repository` / approval-decision plumbing — CytoAnalyst has no
//! `mcp_servers` table and no chat loop to gate); a frontend (`kind=frontend`)
//! action relays over the dedicated duplex [`agent_channel`] (SSE-down +
//! POST-up, per-request liveness) to the user's ONE paired/controlled browser
//! session. One-time-code pairing ([`pairing`]) lets ziee mint an
//! access+refresh token pair scoped to the connecting user without a token
//! ever riding a URL.
//!
//! Everything here is gated by the single `mcp::use` permission
//! ([`permissions::McpUse`]) except `POST /api/mcp/pair/exchange`, which is
//! deliberately code-authenticated (CONTRACT.md) — the one-time pairing code
//! IS the credential.

mod agent_channel;
mod capabilities;
pub mod frontend_catalog;
mod handlers;
mod models;
mod pairing;
mod permissions;
mod routes;
pub mod settings;
pub mod settings_cache;

use std::error::Error;
use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use sqlx::SqlitePool;

use ziee_framework::{loopback_host, AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub use permissions::McpUse;

pub struct McpModule {
    #[allow(dead_code)]
    pool: Option<Arc<SqlitePool>>,
}

impl McpModule {
    pub fn new() -> Self {
        Self { pool: None }
    }
}

impl Default for McpModule {
    fn default() -> Self {
        Self::new()
    }
}

impl AppModule for McpModule {
    fn name(&self) -> &'static str {
        "mcp"
    }

    fn description(&self) -> &'static str {
        "AI-controllable-actions MCP surface: backend + frontend capability exposure, the agent channel, and one-time-code pairing."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn Error>> {
        self.pool = Some(ctx.db_pool.clone());

        // Pin the loopback base URL (never the operator's `server.host`, and
        // never model/ziee-supplied) so the REST-kind `invoke_capability`
        // dispatch and the pairing `mcp_url` both target THIS process only.
        // Mirrors ziee `control_mcp`'s `set_base_url` defense.
        let host = loopback_host(&ctx.config.server.host);
        let port = ctx.config.server.port;
        handlers::set_base_url(format!("http://{host}:{port}"));

        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::mcp_routes())
    }
}

/// Called after an mcp settings PUT. A log-only seam today (mirrors workstore /
/// sandbox `emit_settings_changed`, DEC-8): the writing node's cache is invalidated
/// inline; cross-node realtime sync (a `SyncEntity` variant) is a follow-up.
pub fn emit_settings_changed() {
    tracing::info!("mcp: settings changed (cache invalidated; sync seam is a no-op today)");
}

#[distributed_slice(MODULE_ENTRIES)]
static MCP: ModuleEntry = ModuleEntry {
    name: "mcp",
    order: 90,
    description:
        "AI-controllable-actions MCP surface (backend exposure + agent channel + pairing).",
    constructor: || Box::new(McpModule::new()),
};
