//! Wire types for the `mcp` module's typed (aide-documented) HTTP surface:
//! the agent channel's up-endpoint bodies + the pairing request/response
//! shapes. Field names/shapes match CONTRACT.md exactly. The JSON-RPC POST
//! body (`/api/mcp`) and the SSE down-frames (`agent_channel::DownFrame`) are
//! NOT here — they're plain-`route()` wire formats, not part of the typed
//! OpenAPI-documented surface.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// `pong.status` — CONTRACT.md's `"processing"|"unknown"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PongStatus {
    /// The engine still has this request's execution record in flight.
    Processing,
    /// The engine has no record of this request (e.g. it reloaded) — an
    /// orphaned in-flight action, per CONTRACT.md's liveness section.
    Unknown,
}

/// `POST /api/mcp/agent/result` body.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentResultBody {
    pub request_id: Uuid,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub logs: Vec<String>,
}

/// `POST /api/mcp/agent/progress` body.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentProgressBody {
    pub request_id: Uuid,
    pub message: String,
    /// Optional structured payload alongside `message`. Accepted for
    /// CONTRACT.md parity; not yet surfaced anywhere (no streamed-progress
    /// channel back to the LLM this slice — see `handlers.rs`'s module doc).
    #[serde(default)]
    #[allow(dead_code)]
    pub data: Option<serde_json::Value>,
}

/// `POST /api/mcp/agent/pong` body.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentPongBody {
    pub request_id: Uuid,
    pub status: PongStatus,
    #[serde(default)]
    pub waiting_on: Option<String>,
    #[serde(default)]
    pub since_ms: Option<i64>,
}

/// `POST /api/mcp/agent/capabilities` body — the controlled session REPLACES
/// its VIEW-SCOPED capability set (`modules/mcp/capabilities.rs`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AgentCapabilitiesBody {
    /// The server-minted connection id the SSE `connected` handshake handed
    /// THIS session. The report is accepted only while this still identifies
    /// the user's bound control connection — a superseded tab (a reload racing
    /// a rebind) must not overwrite the live session's catalog. Deliberately
    /// NOT the client-supplied `session_id`, which a reload legitimately
    /// persists (see `agent_channel::ControlSession::conn_id`).
    pub connection_id: Uuid,
    /// The FULL current set, not a delta: an add-only protocol could never
    /// express a removal, and the browser holds the authoritative registry.
    pub capabilities: Vec<super::frontend_catalog::FrontendActionEntry>,
}

/// Uniform ack for the agent up-endpoints. `ok: false` means the request did
/// not correlate to something owned by the caller — a `request_id` with no
/// pending dispatch (already resolved / timed out / never existed / owned by
/// another user), or a `connection_id` that is no longer the caller's bound
/// control connection. Not an error the engine needs to retry, just
/// informational.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AckResponse {
    pub ok: bool,
}

/// `POST /api/mcp/pair/start` response.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PairStartResponse {
    pub code: String,
    pub mcp_url: String,
}

/// `POST /api/mcp/pair/exchange` request.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PairExchangeRequest {
    pub code: String,
}

/// `POST /api/mcp/pair/exchange` response — an access+refresh token pair for
/// the pairing code's owner, minted the same way any other login-shaped flow
/// mints one (`ziee-auth`'s `mint_session_tokens`).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PairExchangeResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
}

/// `GET /api/mcp/agent/stream` query — plain (not aide-documented; the SSE
/// stream isn't part of the typed OpenAPI/`ApiClient` surface, mirrors the
/// JSON-RPC endpoint).
#[derive(Debug, Clone, Deserialize)]
pub struct AgentStreamQuery {
    pub session_id: Uuid,
}
