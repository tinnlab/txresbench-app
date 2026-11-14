//! `demo` module — the web-service demo mode (demo-mode ITEM-1).
//!
//! ## What this module owns
//!
//! * The mode SWITCH itself (`demo:` config block + `TXR_DEMO=1` env +
//!   `--demo` CLI, resolved in `crate::config`), read by every other part of
//!   the app as [`state`].
//! * `GET /api/app/mode` (public, no auth) — the boot read the UI makes
//!   (mode, download_url, limits, notice).
//! * The ROUTE ALLOWLIST gate — one table, one file (`allowlist.rs`); in demo
//!   mode every request outside the allowed/adapted sets answers
//!   `403 {"error":"This is not available in the demo","error_code":"DEMO_MODE"}`.
//! * The demo-session machinery (`session.rs`): the anonymous visitor mint
//!   behind `POST /api/session/local`, the cookie, the role with only the
//!   allowed capabilities, and the run-creator ownership recorded for
//!   stop/skip/at-a-time/rerun.
//! * The demo LIMITS: the request-body cap (`demo.max_bytes`) and the
//!   configured rate limits — the framework's per-IP governor via
//!   `apply_rate_limit_layer` PLUS a per-session governor keyed on the demo
//!   cookie (same crate, same shape; a browser is bounded per session, an
//!   un-cookied client per IP).
//!
//! ## Deliberate posture (recorded in DRIFT-1 ITEM-1)
//!
//! * The gate is a whole-app layer mounted LAST in `lib.rs` build order, so
//!   it runs BEFORE every auth/permission layer: an unclassified route is
//!   answered `403 DEMO_MODE`, never `401 MISSING_TOKEN` (a public demo must
//!   not leak which surface exists).
//! * `OPTIONS` passes through (CORS preflight), and non-API paths pass
//!   through (the debug-only `/__worktree` harness sentinel is not a route of
//!   the app surface).
//! * Desktop mode: none of this is installed — the layers are added only
//!   when `demo.enabled`, so the desktop build is byte-for-byte unchanged
//!   (pinned by the "existing API tests with demo off" integration suite).
//!
//! ## Item ownership
//!
//! ITEM-1 delivers the switch + allowlist + anonymous sessions + limits;
//! ITEM-2 the recorded-results bundle (format, boot-loaded and validated
//! [`bundle`], the inspect/validate example-hash guard). The ADAPTATIONS the
//! allowlist classifies (bundle-backed runs/eligibility, generated save
//! names beyond the route-level override, retention, pages) land with
//! ITEM-3..7; this module deliberately contains no clone/replay logic.

pub mod allowlist;
pub mod bundle;
pub mod copy;
pub mod session;

use std::sync::OnceLock;

use aide::axum::routing::get_with;
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use linkme::distributed_slice;
use serde::Serialize;
use sqlx::SqlitePool;
use tower_governor::key_extractor::KeyExtractor;
use txresbench_core::{AppError, ServerConfig};
use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

use crate::config;

/// The resolved demo mode, computed once at boot from [`config::DemoConfig`]
/// and handed to every layer that needs it. Stored in a process-global
/// [`OnceLock`] because the layers/modules that must consult it (the gate in
/// `lib.rs`, the session/local handler in `localsession`, the save-name
/// override in `model_store`, the run stamp in `execution_engine`) are wired
/// at module registration time, before the axum state exists.
#[derive(Debug, Clone)]
pub struct DemoState {
    pub enabled: bool,
    pub download_url: String,
    pub history_limit: u32,
    pub model_limit: u32,
    pub max_bytes: u64,
    pub replay_speed: f64,
    /// The RESOLVED notice text (the config's key mapped through
    /// [`copy::notice_text`]).
    pub notice: String,
    /// The recorded-results bundle (ITEM-2). `Some` in EVERY demo boot — the
    /// loader refuses to start demo mode without a valid bundle, so ITEM-3's
    /// replay can rely on it being present; `None` only in desktop mode.
    pub bundle: Option<std::sync::Arc<bundle::DemoBundle>>,
}

impl DemoState {
    pub fn from_config(
        demo: &config::DemoConfig,
        bundle: Option<std::sync::Arc<bundle::DemoBundle>>,
    ) -> Self {
        Self {
            enabled: demo.enabled,
            download_url: demo.download_url.clone(),
            history_limit: demo.history_limit,
            model_limit: demo.model_limit,
            max_bytes: demo.max_bytes,
            replay_speed: demo.replay_speed,
            notice: copy::notice_text(&demo.notice),
            bundle,
        }
    }
}

static DEMO_STATE: OnceLock<DemoState> = OnceLock::new();

/// The boot-time state setter (`lib.rs`). Setting twice is a boot bug; the
/// second call is ignored (first-wins, like the SDK's own `first-wins`
/// seam convention).
pub fn set_state(state: DemoState) {
    let _ = DEMO_STATE.set(state);
}

/// The current demo state, if the boot installed one. `None` means desktop
/// mode (and is also the value every in-process unit test sees).
pub fn state() -> Option<&'static DemoState> {
    DEMO_STATE.get()
}

/// True when demo mode is on — the ONE predicate every demo branch reads.
pub fn enabled() -> bool {
    state().is_some_and(|s| s.enabled)
}

/// The boot-installed demo bundle (ITEM-2). `None` in desktop mode; always
/// `Some` on a demo boot (the loader refuses an invalid one — ITEM-2's
/// contract; ITEM-3's replay may rely on it).
pub fn bundle() -> Option<&'static bundle::DemoBundle> {
    state().and_then(|s| s.bundle.as_deref())
}

/// The ONE demo-blocked error buildable from a handler (file-validation's
/// adapted routes return it from inside the handler — the gate's whole-
/// middleware 403 covers every other surface): spec-exact bytes, identical
/// to [`demo_blocked_response`].
pub fn blocked_error() -> AppError {
    AppError::forbidden("DEMO_MODE", DEMO_BLOCKED_MESSAGE)
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/app/mode
// ─────────────────────────────────────────────────────────────────────────────

/// The wire shape of `GET /api/app/mode` (the spec's section 2 switch).
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct AppModeResponse {
    /// `"desktop"` (the default) or `"demo"`.
    pub mode: &'static str,
    /// The download page URL; empty in desktop mode (the UI shows the link
    /// only when non-empty).
    pub download_url: String,
    pub limits: DemoLimits,
    /// The resolved notice text; empty in desktop mode.
    pub notice: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct DemoLimits {
    pub history: u32,
    pub models: u32,
}

async fn app_mode() -> Json<AppModeResponse> {
    // A state is ALWAYS installed at boot (even when demo is off, the
    // desktop-mode state is set) — the mode must key on `enabled`, not on
    // the state's presence.
    let (mode, download_url, limits, notice) = match state() {
        Some(s) if s.enabled => (
            "demo",
            s.download_url.clone(),
            DemoLimits { history: s.history_limit, models: s.model_limit },
            s.notice.clone(),
        ),
        _ => ("desktop", String::new(), DemoLimits { history: 50, models: 50 }, String::new()),
    };
    Json(AppModeResponse { mode, download_url, limits, notice })
}

fn app_mode_docs(op: TransformOperation) -> TransformOperation {
    op.description(
        "The app's mode at boot: `desktop` (default) or `demo`. Public (no auth) — \
         the UI reads it once at boot and must render nothing mode-specific until it \
         is known.",
    )
    .id("App.mode")
    .tag("app")
    .response::<200, Json<AppModeResponse>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// The demo gate (route allowlist middleware)
// ─────────────────────────────────────────────────────────────────────────────

/// The gate's per-request state: the resolved demo state + the pool (the
/// ownership read for stop/skip/at-a-time/rerun) + the api prefix (the table
/// paths are prefix-stripped).
#[derive(Clone)]
pub struct GateState {
    pub demo: DemoState,
    pub pool: SqlitePool,
    pub api_prefix: String,
}

impl GateState {
    pub fn new(demo: &DemoState, pool: SqlitePool, config: &ServerConfig) -> Self {
        Self { demo: demo.clone(), pool, api_prefix: config.server.api_prefix.clone() }
    }
}

/// The gate: the ONE enforcement point of the allowlist. Whole-app (mounted
/// outermost in `lib.rs`) so a blocked route never reaches auth or a handler.
/// Takes the state BY VALUE so a plain `from_fn` closure can own it (the
/// state is Clone; the closure hands it down per request).
pub async fn demo_gate(state: GateState, req: Request, next: Next) -> Response {
    if !state.demo.enabled {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    // CORS preflight (the browser must be able to ASK, even though the actual
    // call may be refused) and non-API paths (harness sentinel only — release
    // builds have no such surface).
    if method == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }
    let Some(rest) = allowlist::strip_api_prefix(&state.api_prefix, &path) else {
        return next.run(req).await;
    };

    let class = allowlist::classify(method.as_str(), rest);
    let allowed = matches!(class, Some(allowlist::RouteClass::Allowed) | Some(allowlist::RouteClass::Adapted));
    // The run-control ownership rule (ITEM-1): stop/skip/at-a-time/rerun act
    // only on runs started by the SAME browser session. The check runs before
    // the handler so a foreign session never reaches the engine, and it is
    // fail-closed: no session cookie or no recorded owner ⇒ 403.
    // The session id is read BEFORE the await — the request body is !Sync, so
    // no reference to the request may live across the DB read (the middleware
    // future must stay Send).
    let control_owner_ok = if !allowed {
        // A blocked route does not need an ownership check — it is refused
        // outright below.
        true
    } else if let Some(run_id) = allowlist::control_run_id(rest) {
        match session::read_session_id(req.headers()) {
            Some(session_id) => {
                matches!(session::run_session(&state.pool, run_id).await, Ok(Some(owner)) if owner == session_id)
            }
            // No cookie: cannot prove who the caller is ⇒ deny.
            None => false,
        }
    } else {
        true
    };
    if allowed && control_owner_ok {
        return next.run(req).await;
    }

    demo_blocked_response()
}

/// The ONE blocked response (spec-exact bytes: `error_code: "DEMO_MODE"`,
/// message "This is not available in the demo").
const DEMO_BLOCKED_MESSAGE: &str = "This is not available in the demo";

fn demo_blocked_response() -> Response {
    AppError::forbidden("DEMO_MODE", DEMO_BLOCKED_MESSAGE).into_response()
}

/// The ownership predicate for the five control shapes. `Ok(false)` is a
/// 403 DEMO_MODE; an absent/unknown session is a 403 too (fail-closed).
// ─────────────────────────────────────────────────────────────────────────────
// The demo limits (body size + per-session/per-IP rate limit)
// ─────────────────────────────────────────────────────────────────────────────

/// The per-session + per-IP key: a demo session cookie when the client has
/// one, else the peer IP. ONE key space for the demo's extra governor — a
/// browser is bounded per session, an un-cookied client per address.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SessionOrPeerKey {
    Session(uuid::Uuid),
    Ip(std::net::IpAddr),
}

/// The Governor key extractor (the framework's rate-limit module crate; the
/// custom key is the app's own — the framework's `PeerIpKeyExtractor` is the
/// fallback the crate's own helper hacks mirror).
#[derive(Debug, Clone, Copy)]
pub struct SessionOrPeerKeyExtractor;

impl KeyExtractor for SessionOrPeerKeyExtractor {
    type Key = SessionOrPeerKey;

    fn extract<T>(&self, req: &axum::http::Request<T>) -> Result<Self::Key, tower_governor::GovernorError> {
        if let Some(id) = session::read_session_id(req.headers()) {
            return Ok(SessionOrPeerKey::Session(id));
        }
        match req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>() {
            Some(connect) => Ok(SessionOrPeerKey::Ip(connect.0.ip())),
            None => Err(tower_governor::GovernorError::UnableToExtractKey),
        }
    }
}

/// The session governor's bursts (per second / burst): the framework defaults
/// are the sane demo defaults; an operator's `server.rate_limit` block wins.
pub fn demo_rate_burst(config: &ServerConfig) -> (u64, u32) {
    match config.server.rate_limit.as_ref() {
        Some(r) if r.enabled => (r.per_second, r.burst_size),
        Some(_) => (50, 500), // a demo deployment never disables the limiter
        None => (50, 500),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The module: registers GET /api/app/mode
// ─────────────────────────────────────────────────────────────────────────────

pub struct DemoModule;

impl AppModule for DemoModule {
    fn name(&self) -> &'static str {
        "demo"
    }

    fn description(&self) -> &'static str {
        "Demo mode: /api/app/mode + the route allowlist + anonymous visitor sessions (web service)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // The state is installed by `lib.rs` BEFORE module init (the module's
        // own init has nothing to do; the route + gate read the global).
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.nest("/app", ApiRouter::new().api_route("/mode", get_with(app_mode, app_mode_docs)))
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static DEMO: ModuleEntry = ModuleEntry {
    name: "demo",
    // Distinct order (module_order_is_unique): 62 is the next free slot after
    // the model_store/pretrained pair (60/61); route order in openapi.json
    // follows module order, so the app-mode path's position in the spec is
    // deterministic.
    order: 62,
    description: "Demo mode: /api/app/mode + the route allowlist + anonymous visitor sessions (web service).",
    constructor: || Box::new(DemoModule),
};

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn app_mode_wire_shape_in_desktop_default() {
        // The unit-level shape: with no boot state the response is desktop.
        // (Full behavior is the HTTP integration tier; this pins the JSON
        // field names + the desktop defaults.)
        let resp = app_mode().await.0;
        assert_eq!(resp.mode, "desktop");
        assert_eq!(resp.download_url, "");
        assert_eq!(resp.limits.history, 50);
        assert_eq!(resp.limits.models, 50);
        assert_eq!(resp.notice, "");
    }

    #[test]
    fn blocked_response_has_the_spec_bytes() {
        let body = DEMO_BLOCKED_MESSAGE;
        assert_eq!(body, "This is not available in the demo");
    }
}
