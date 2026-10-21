//! `mcp` module HTTP routes.
//!
//! `POST /api/mcp` (JSON-RPC) and `GET /api/mcp/agent/stream` (SSE) are plain
//! axum `route()`s — NOT aide-documented, mirroring ziee `modules/control_mcp`
//! (the MCP client is ziee, not the FE, so these have no place in
//! `ApiClient`/`types.ts`). The agent up-endpoints + pairing endpoints ARE
//! aide-documented (`.id("Mcp.*")`) so `just openapi-regen` emits
//! `Permissions.McpUse` + `ApiClient.Mcp.*` for the FE connect surface
//! (ITEM-17/18, a later slice).

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json};
use sqlx::PgPool;

use ziee_core::ApiResult;

use crate::modules::permissions::{with_permission, RequirePermissions};

use super::agent_channel::{agent_pong, agent_progress, agent_result, agent_stream};
use super::capabilities::agent_capabilities;
use super::handlers::jsonrpc_handler;
use super::models::{AckResponse, PairExchangeResponse, PairStartResponse};
use super::pairing::{pair_exchange, pair_start};
use super::permissions::{McpSettingsManage, McpSettingsRead, McpUse};
use super::settings::{McpSettings, McpSettingsRepository, UpdateMcpSettings};
use super::settings_cache;

pub fn mcp_routes() -> ApiRouter {
    ApiRouter::new()
        // JSON-RPC — plain, undocumented (see module doc).
        .route("/mcp", post(jsonrpc_handler))
        // Agent SSE stream — plain, undocumented (server→client payload push;
        // binds `user → session_id → this connection`).
        .route("/mcp/agent/stream", get(agent_stream))
        // Agent up-endpoints — typed + documented.
        .api_route(
            "/mcp/agent/result",
            post_with(agent_result, agent_result_docs),
        )
        .api_route(
            "/mcp/agent/progress",
            post_with(agent_progress, agent_progress_docs),
        )
        .api_route("/mcp/agent/pong", post_with(agent_pong, agent_pong_docs))
        .api_route(
            "/mcp/agent/capabilities",
            post_with(agent_capabilities, agent_capabilities_docs),
        )
        // Pairing.
        .api_route("/mcp/pair/start", post_with(pair_start, pair_start_docs))
        .api_route(
            "/mcp/pair/exchange",
            post_with(pair_exchange, pair_exchange_docs),
        )
        // --- admin settings (issue #54): agent/tool caps + pairing-TTL ---
        .api_route(
            "/mcp/settings",
            get_with(get_settings, get_settings_docs).put_with(update_settings, update_settings_docs),
        )
}

// ───────────────────────── admin settings (issue #54) ─────────────────────────
// Gated routes call `with_permission::<(..)>` in their `*_docs` so the 403 example
// carries `required_permissions` — what the framework scrapes to emit the FE
// `Permissions.<Name>` constants. Mirrors `modules/workstore/routes.rs`.

async fn get_settings(
    _auth: RequirePermissions<(McpSettingsRead,)>,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<McpSettings>> {
    let row = McpSettingsRepository::new(pool)
        .get()
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(row)))
}

fn get_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(McpSettingsRead,)>(op)
        .id("Mcp.getSettings")
        .tag("mcp")
        .summary("Read the MCP agent/tool caps + pairing-code TTL")
        .response::<200, Json<McpSettings>>()
}

async fn update_settings(
    auth: RequirePermissions<(McpSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(body): Json<UpdateMcpSettings>,
) -> ApiResult<Json<McpSettings>> {
    let repo = McpSettingsRepository::new(pool);
    // Merge the partial onto the current row, validate the RESULT (422 on
    // out-of-range — the safety bounds, DEC-3), then persist + refresh the
    // read-at-use cache so the next use reads the new values (INV-1).
    let current = repo.get().await.map_err(|e| e.to_api_error())?;
    let merged = McpSettingsRepository::merge(&current, &body);
    merged.validate().map_err(|e| e.to_api_error())?;
    let row = repo.update(&body, auth.user.id).await.map_err(|e| e.to_api_error())?;
    settings_cache::invalidate(row.clone());
    super::emit_settings_changed();
    Ok((StatusCode::OK, Json(row)))
}

fn update_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(McpSettingsManage,)>(op)
        .id("Mcp.updateSettings")
        .tag("mcp")
        .summary("Update the MCP agent/tool caps + pairing-code TTL")
        .response::<200, Json<McpSettings>>()
}

fn agent_result_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(McpUse,)>(op)
        .id("Mcp.agentResult")
        .tag("mcp")
        .description("The controlled browser session's engine posts the final outcome of a dispatched frontend action, correlated by request_id.")
        .response::<200, Json<AckResponse>>()
}

fn agent_progress_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(McpUse,)>(op)
        .id("Mcp.agentProgress")
        .tag("mcp")
        .description("The controlled browser session's engine streams an intermediate progress note for an in-flight dispatched action (also resets its liveness timer).")
        .response::<200, Json<AckResponse>>()
}

fn agent_pong_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(McpUse,)>(op)
        .id("Mcp.agentPong")
        .tag("mcp")
        .description("The controlled browser session's engine answers a liveness ping for an in-flight dispatched action.")
        .response::<200, Json<AckResponse>>()
}

fn agent_capabilities_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(McpUse,)>(op)
        .id("Mcp.agentCapabilities")
        .tag("mcp")
        .description("The controlled browser session's engine REPLACES the view-scoped AI capability set it has registered, correlated by the connection_id from the stream handshake. The server stores what it is given (validated + capped) instead of deriving it.")
        .response::<200, Json<AckResponse>>()
}

fn pair_start_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(McpUse,)>(op)
        .id("Mcp.pairStart")
        .tag("mcp")
        .description("Mint a short-lived, single-use pairing code an AI assistant (e.g. ziee chat) exchanges for access to this account's MCP surface.")
        .response::<200, Json<PairStartResponse>>()
}

fn pair_exchange_docs(op: TransformOperation) -> TransformOperation {
    // Deliberately NOT `with_permission` — this endpoint is code-authenticated
    // (CONTRACT.md), not permission-gated; documenting a `McpUse` requirement
    // here would be inaccurate.
    op.id("Mcp.pairExchange")
        .tag("mcp")
        .description("Exchange a one-time pairing code for an access+refresh token pair. Code-authenticated; no bearer token required.")
        .response::<200, Json<PairExchangeResponse>>()
}
