//! The agent channel: a DEDICATED per-user duplex bridge between the backend
//! `invoke_capability(kind=frontend)` dispatcher (`handlers.rs`) and the
//! user's ONE paired/controlled browser session (the frontend "engine",
//! slice 3 — not built in this backend slice). Deliberately separate from
//! `modules::sync` (a per-user *fan-out*, notify-and-refetch-only registry) —
//! this channel carries real PAYLOADS (`agent_invoke`/`ping`/`agent_cancel`
//! down; `result`/`progress`/`pong` up) and targets exactly ONE bound
//! connection per user, never a broadcast. Reusing `sync` would either break
//! its notify-only invariant or misroute (see INFRA_INTEGRATION.md).
//!
//! - **Down (SSE):** `GET /api/mcp/agent/stream?session_id=<uuid>`
//!   ([`agent_stream`]) binds `user → session_id → this connection`; a
//!   reconnect with the same user rebinds (single controlled session this
//!   slice — multi-window "take control" is ITEM-24, descoped).
//! - **Up (POST):** `agent_result` / `agent_progress` / `agent_pong`
//!   correlate by `request_id` into the process-wide PENDING map, scoped to
//!   the entry's owning user (a caller can't touch another user's pending
//!   request even though `request_id`s are unguessable UUIDv4s — defense in
//!   depth). `agent_capabilities` ([`super::capabilities`]) correlates by
//!   `connection_id` instead, and its payload is stored ON the session
//!   ([`ControlSession::capabilities`]) so the reported catalog's lifetime IS
//!   the connection's.
//! - **Liveness:** [`LivenessState`] is a PURE, unit-tested state machine
//!   (CONTRACT.md's "Liveness" section) driving [`dispatch`]'s per-request
//!   wait loop.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::modules::permissions::RequirePermissions;

use super::frontend_catalog::FrontendActionEntry;
use super::models::{
    AckResponse, AgentPongBody, AgentProgressBody, AgentResultBody, AgentStreamQuery, PongStatus,
};
use super::permissions::McpUse;

// The global control-session cap (OOM guard, 1024), the per-user in-flight invoke
// cap (DoS guard, 16), and the outer per-action wall-clock backstop (15 min) used to
// be bare consts here. They are now the admin settings `max_control_sessions` /
// `max_inflight_per_user` / `action_wall_clock_secs` (issue #54), read-at-use via
// `settings_cache::snapshot()` (these are pool-less free functions). The settings
// defaults EQUAL the old consts (byte-preserving, INV-1); the two caps are
// SAFETY-BOUNDED (DEC-3): admin-tunable only within a bounded range, never unbounded.

/// How long a per-request liveness tick waits for progress/a pong before
/// acting (send a ping, or advance the missed-ping count). CONTRACT.md: "quiet
/// for T (~3-5s, no progress) -> ping".
const LIVENESS_TICK: Duration = Duration::from_secs(4);

/// Missed pongs tolerated before declaring the frontend unresponsive.
/// CONTRACT.md: "~2 missed pings / stream closed -> FAIL (FRONTEND_UNRESPONSIVE)".
const MAX_MISSED_PINGS: u32 = 2;

type EventSender = mpsc::UnboundedSender<Result<Event, axum::Error>>;

// ============================== wire (down) =================================

/// SSE down-frames. Internally tagged on `type` so the serialized shape is
/// exactly CONTRACT.md's `{ "type": "agent_invoke", ... }`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DownFrame {
    AgentInvoke {
        request_id: Uuid,
        action_id: String,
        params: Value,
        /// Present for a `kind: "instance"` action — the target `view_id`,
        /// extracted server-side from the invoke body (`handlers.rs`'s
        /// `invoke_frontend`, ai-actions slice 3, ARCHITECTURE.md Layer 4).
        /// `None` for a `kind: "global"` action.
        #[serde(skip_serializing_if = "Option::is_none")]
        view_id: Option<String>,
        /// Present when the target is `mutating && stateful` AND the caller
        /// supplied one — the read-before-write guard's claimed state token
        /// (ARCHITECTURE.md Layer 6). The engine (frontend), not this
        /// backend, decides `READ_REQUIRED`/`STALE_STATE` from this —
        /// trust (permission) is backend-enforced, correctness (staleness)
        /// is engine-enforced (Layer 5/6 split).
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_token: Option<String>,
    },
    Ping {
        request_id: Uuid,
    },
    #[allow(dead_code)] // cancellation is wired from the MCP-cancel path in a later slice.
    AgentCancel {
        request_id: Uuid,
    },
}

fn send_frame(sender: &EventSender, frame: &DownFrame) -> Result<(), ()> {
    let data = serde_json::to_string(frame).unwrap_or_else(|_| "{}".to_string());
    sender.send(Ok(Event::default().data(data))).map_err(|_| ())
}

// ============================== registry state ===============================

struct ControlSession {
    /// Unique per-connection token, freshly minted in [`bind_session`] —
    /// deliberately DISTINCT from the client-supplied `session_id` (see
    /// `AgentStreamQuery`), which a real reload legitimately PERSISTS (e.g.
    /// from `localStorage`), so two unrelated connections can legitimately
    /// share the same `session_id`. [`unbind_session`] discriminates "am I
    /// still the bound connection" on this token, never on `session_id` —
    /// comparing by `session_id` would let the OLD connection's teardown (a
    /// client disconnect / reload is detected asynchronously, so it can race
    /// AFTER the new connection has already rebound) wrongly clobber the NEW
    /// connection that shares it.
    conn_id: Uuid,
    sender: EventSender,
    /// The VIEW-SCOPED AI capabilities THIS connection reported
    /// (`POST /api/mcp/agent/capabilities`, [`super::capabilities`]).
    ///
    /// Held HERE rather than in a side table on purpose: a frontend capability
    /// is only invokable through a bound control session ([`dispatch`] fails
    /// `NotConnected` without one), so the reported catalog's correct lifetime
    /// IS this session's — and storing it on the session makes that structural.
    /// Dropping the entry in [`unbind_session`] drops the catalog with it;
    /// there is no separate invalidation path that could be forgotten, and no
    /// TTL that would either advertise a dead tab's capabilities or discard a
    /// live one's.
    ///
    /// `Arc` so the read path ([`capabilities_for`]) hands out a snapshot
    /// without cloning the vector under the registry lock.
    ///
    /// Per-CONNECTION, not per-user: today the registry binds one session per
    /// user, but nothing here assumes that — turning `sessions` into a
    /// `user -> Vec<ControlSession>` for multi-window "take control" (ITEM-24,
    /// descoped) leaves this field exactly as it is and only unions in
    /// [`capabilities_for`].
    capabilities: Arc<Vec<FrontendActionEntry>>,
}

struct PendingEntry {
    /// The user who dispatched this request — up-endpoint handlers verify the
    /// caller matches before touching the entry (a `request_id` is an
    /// unguessable UUIDv4, but this is cheap defense in depth).
    owner: Uuid,
    /// Progress/pong signals feeding the liveness loop in [`run_liveness_loop`].
    events_tx: mpsc::UnboundedSender<LivenessSignal>,
    /// Consumed exactly once by the `result` up-endpoint.
    result_tx: Mutex<Option<oneshot::Sender<AgentResultFrame>>>,
}

enum LivenessSignal {
    Progress,
    Pong(PongStatus),
}

struct AgentChannelState {
    /// user_id -> the single control session bound for that user.
    sessions: Mutex<HashMap<Uuid, ControlSession>>,
    /// request_id -> the in-flight dispatch awaiting a result.
    pending: Mutex<HashMap<Uuid, PendingEntry>>,
    /// user_id -> count of that user's currently in-flight dispatches
    /// (maintained alongside `pending`; see the `max_inflight_per_user` setting).
    inflight_per_user: Mutex<HashMap<Uuid, usize>>,
}

static STATE: LazyLock<AgentChannelState> = LazyLock::new(|| AgentChannelState {
    sessions: Mutex::new(HashMap::new()),
    pending: Mutex::new(HashMap::new()),
    inflight_per_user: Mutex::new(HashMap::new()),
});

/// Binds `user_id -> this connection`, returning the freshly minted
/// [`ControlSession::conn_id`] the caller must hand back to
/// [`unbind_session`] on teardown (NOT the client-supplied `session_id` —
/// see the field doc on [`ControlSession::conn_id`]).
fn bind_session(user_id: Uuid, sender: EventSender) -> Result<Uuid, ()> {
    let mut sessions = STATE.sessions.lock().unwrap_or_else(|e| e.into_inner());
    // Read-at-use (issue #54): admin-tunable `max_control_sessions`, default 1024.
    let max_sessions = super::settings_cache::snapshot().max_control_sessions_usize();
    if !sessions.contains_key(&user_id) && sessions.len() >= max_sessions {
        tracing::warn!("mcp: agent-channel session registry full; refusing new connection");
        return Err(());
    }
    let conn_id = Uuid::new_v4();
    sessions.insert(
        user_id,
        ControlSession {
            conn_id,
            sender,
            // A fresh connection starts with NO view-scoped capabilities: it
            // has reported none yet. The engine reports its full snapshot the
            // moment it sees the `connected` handshake, so the empty window is
            // one round trip — and advertising the PREVIOUS connection's set
            // during it would advertise what this connection cannot invoke.
            capabilities: Arc::new(Vec::new()),
        },
    );
    Ok(conn_id)
}

/// REPLACE the view-scoped capability set of `user_id`'s CURRENTLY BOUND
/// connection. Returns `false` — storing nothing — when `conn_id` is not that
/// connection, which is how a superseded tab's late report is refused (the same
/// `conn_id`-not-`session_id` discrimination [`unbind_session`] uses, for the
/// same reason).
///
/// A REPLACE, not a merge: the browser holds the authoritative registry, and an
/// add-only protocol could never express a removal.
pub(super) fn set_capabilities(
    user_id: Uuid,
    conn_id: Uuid,
    entries: Vec<FrontendActionEntry>,
) -> bool {
    let mut sessions = STATE.sessions.lock().unwrap_or_else(|e| e.into_inner());
    match sessions.get_mut(&user_id) {
        Some(session) if session.conn_id == conn_id => {
            session.capabilities = Arc::new(entries);
            true
        }
        _ => false,
    }
}

/// Test-only: bind a stand-in control connection for `user_id`. Returns the
/// connection id plus the receiver end, which the caller MUST keep alive — a
/// dropped receiver is what a closed browser looks like to `send_frame`.
/// Exists so a sibling module's tests (`frontend_catalog`) can establish the
/// session its read path now depends on, without widening `bind_session`.
#[cfg(test)]
pub(super) fn bind_test_session(
    user_id: Uuid,
) -> (Uuid, mpsc::UnboundedReceiver<Result<Event, axum::Error>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let conn_id = bind_session(user_id, tx).expect("registry has room");
    (conn_id, rx)
}

/// Test-only counterpart of [`bind_test_session`].
#[cfg(test)]
pub(super) fn unbind_test_session(user_id: Uuid, conn_id: Uuid) {
    unbind_session(user_id, conn_id);
}

/// The view-scoped capabilities `user_id`'s bound connection reported. EMPTY
/// when no connection is bound — which is exactly right: [`dispatch`] fails
/// `NotConnected` then, so there is nothing view-scoped this user could invoke,
/// and `list_capabilities` must not advertise it.
pub(super) fn capabilities_for(user_id: Uuid) -> Arc<Vec<FrontendActionEntry>> {
    let sessions = STATE.sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions
        .get(&user_id)
        .map(|s| s.capabilities.clone())
        .unwrap_or_default()
}

/// Unbind, but ONLY if `conn_id` still identifies the currently bound
/// connection. A stale connection's teardown always passes ITS OWN `conn_id`
/// (never the client-supplied `session_id`), so a newer connection that
/// happens to share the same `session_id` (an ordinary reload persisting it)
/// is never wrongly clobbered.
fn unbind_session(user_id: Uuid, conn_id: Uuid) {
    let mut sessions = STATE.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = sessions.get(&user_id) {
        if existing.conn_id == conn_id {
            sessions.remove(&user_id);
        }
        // else: a newer connection already rebound (reload) — don't clobber it.
    }
}

/// The CURRENTLY bound sender for `user_id`, re-resolved fresh from the
/// registry on every call. `dispatch`/`run_liveness_loop` call this instead
/// of caching a sender snapshot so a mid-dispatch reconnect (browser reload
/// rebinding a fresh SSE connection into [`bind_session`]) is picked up on
/// the very next send — see the module-level "Down (SSE)" doc.
fn current_sender(user_id: Uuid) -> Option<EventSender> {
    let sessions = STATE.sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions.get(&user_id).map(|s| s.sender.clone())
}

/// Reserve one in-flight slot for `user_id`, enforcing the `max_inflight_per_user` setting.
/// Returns `false` (no slot reserved) when the user is already at the cap.
fn try_reserve_inflight(user_id: Uuid) -> bool {
    let mut counts = STATE
        .inflight_per_user
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let count = counts.entry(user_id).or_insert(0);
    // Read-at-use (issue #54): admin-tunable `max_inflight_per_user`, default 16.
    let max_inflight = super::settings_cache::snapshot().max_inflight_per_user_usize();
    if *count >= max_inflight {
        false
    } else {
        *count += 1;
        true
    }
}

/// Release a slot reserved by [`try_reserve_inflight`]. Called from
/// `dispatch`'s cleanup [`Guard`] on every exit path.
fn release_inflight(user_id: Uuid) {
    let mut counts = STATE
        .inflight_per_user
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(count) = counts.get_mut(&user_id) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            counts.remove(&user_id);
        }
    }
}

// ============================== liveness FSM (pure) ===========================

/// Pure per-request liveness state machine (CONTRACT.md "Liveness" section).
/// No timers, no I/O — [`run_liveness_loop`] is the only caller, and it feeds
/// real elapsed-time / pong events into `on_event`. Kept pure + `pub(super)`
/// so it's directly unit-testable (ITEM-9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LivenessState {
    /// No ping outstanding; either freshly dispatched or just saw
    /// progress/`pong{processing}`.
    Quiet,
    /// A ping was sent `missed` times without a resolving pong yet.
    PingOutstanding { missed: u32 },
    /// Terminal — the dispatch has failed. Further events are ignored.
    Failed(LivenessFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LivenessFailure {
    /// `pong{unknown}` — the controlled window lost this request (reloaded).
    FrontendReloaded,
    /// `MAX_MISSED_PINGS` pongs missed in a row, or the connection closed.
    FrontendUnresponsive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LivenessEvent {
    /// A `progress` frame arrived — resets quietness (implicit liveness).
    Progress,
    /// The quiet timer elapsed with no progress/result while `Quiet`.
    QuietElapsed,
    /// A `pong` frame arrived while a ping was outstanding.
    Pong(PongStatus),
    /// The ping-wait timer elapsed with no pong.
    PingElapsed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LivenessTransition {
    pub state: LivenessState,
    /// True when this transition should cause a fresh `ping{request_id}`
    /// frame to be sent to the controlled session.
    pub send_ping: bool,
}

impl LivenessState {
    pub(super) const fn new() -> Self {
        LivenessState::Quiet
    }

    /// Advance the state machine on one event. See CONTRACT.md's "Liveness"
    /// section: quiet -> ping on a quiet timeout; `pong{processing}` resets to
    /// quiet (keep waiting); `pong{unknown}` fails `FrontendReloaded`;
    /// `MAX_MISSED_PINGS` missed pongs in a row fails `FrontendUnresponsive`.
    /// `Failed` is terminal (further events are no-ops).
    pub(super) fn on_event(self, event: LivenessEvent) -> LivenessTransition {
        let no_op = |state| LivenessTransition {
            state,
            send_ping: false,
        };
        match self {
            LivenessState::Failed(f) => no_op(LivenessState::Failed(f)),
            LivenessState::Quiet => match event {
                LivenessEvent::Progress => no_op(LivenessState::Quiet),
                LivenessEvent::QuietElapsed => LivenessTransition {
                    state: LivenessState::PingOutstanding { missed: 0 },
                    send_ping: true,
                },
                // A stray pong / ping-elapsed with no ping outstanding is a no-op.
                LivenessEvent::Pong(_) | LivenessEvent::PingElapsed => no_op(LivenessState::Quiet),
            },
            LivenessState::PingOutstanding { missed } => match event {
                LivenessEvent::Progress => no_op(LivenessState::Quiet),
                LivenessEvent::Pong(PongStatus::Processing) => no_op(LivenessState::Quiet),
                LivenessEvent::Pong(PongStatus::Unknown) => {
                    no_op(LivenessState::Failed(LivenessFailure::FrontendReloaded))
                }
                LivenessEvent::PingElapsed => {
                    let missed = missed + 1;
                    if missed >= MAX_MISSED_PINGS {
                        no_op(LivenessState::Failed(LivenessFailure::FrontendUnresponsive))
                    } else {
                        LivenessTransition {
                            state: LivenessState::PingOutstanding { missed },
                            send_ping: true,
                        }
                    }
                }
                // A ping is already outstanding; the quiet timer firing again
                // (e.g. a slow tick) is a no-op — the ping-wait timer governs.
                LivenessEvent::QuietElapsed => no_op(LivenessState::PingOutstanding { missed }),
            },
        }
    }
}

// ============================== dispatch =====================================

/// The final outcome the frontend engine POSTed via `result`.
#[derive(Debug, Clone)]
pub(super) struct AgentResultFrame {
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub logs: Vec<String>,
}

/// Why a frontend-action dispatch failed — maps 1:1 onto CONTRACT.md's error
/// codes (NOT_PERMITTED is checked by the caller BEFORE calling `dispatch`,
/// so it isn't a `DispatchError` variant).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DispatchError {
    /// No live control session for this user at dispatch time.
    NotConnected,
    /// `pong{unknown}` — the controlled window reloaded mid-action.
    Reloaded,
    /// Missed pings / closed connection / wall-clock cap exceeded.
    Unresponsive,
    /// This user already has the `max_inflight_per_user` setting dispatches outstanding.
    TooManyInflight,
}

fn map_failure(f: LivenessFailure) -> DispatchError {
    match f {
        LivenessFailure::FrontendReloaded => DispatchError::Reloaded,
        LivenessFailure::FrontendUnresponsive => DispatchError::Unresponsive,
    }
}

/// Relay a frontend action to `user_id`'s controlled session and await its
/// result, per CONTRACT.md's "Liveness" protocol. The caller (`handlers.rs`)
/// has ALREADY checked `principal_holds` — this function only handles
/// connectivity + the per-request liveness loop.
///
/// Deliberately does NOT snapshot the sender once and hold it for the whole
/// dispatch: a mid-dispatch browser reload rebinds a FRESH sender into the
/// session registry (`bind_session`), and the stale sender's channel can
/// still accept sends even though nobody reads it anymore (the reloaded tab
/// never sees them). Every send — the initial invoke AND every liveness ping
/// — re-resolves the CURRENT bound sender via [`current_sender`], so a
/// rebind is picked up immediately: the reloaded tab receives the next ping
/// for a `request_id` it has no record of and answers `pong{unknown}`,
/// which correctly surfaces as `FRONTEND_RELOADED` instead of the dispatch
/// silently timing out into a misleading `FRONTEND_UNRESPONSIVE`.
pub(super) async fn dispatch(
    user_id: Uuid,
    action_id: &str,
    params: Value,
    view_id: Option<String>,
    expected_token: Option<String>,
) -> Result<AgentResultFrame, DispatchError> {
    // Fast-path check only — NOT the sender actually used for the initial
    // send below, which re-resolves fresh via `send_to_current` AFTER the
    // pending entry is inserted (see the doc comment above). This just
    // avoids reserving an inflight slot for a definitely-disconnected user.
    if current_sender(user_id).is_none() {
        return Err(DispatchError::NotConnected);
    }

    if !try_reserve_inflight(user_id) {
        return Err(DispatchError::TooManyInflight);
    }

    let request_id = Uuid::new_v4();
    let (events_tx, events_rx) = mpsc::unbounded_channel::<LivenessSignal>();
    let (result_tx, result_rx) = oneshot::channel();
    {
        let mut pending = STATE.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.insert(
            request_id,
            PendingEntry {
                owner: user_id,
                events_tx,
                result_tx: Mutex::new(Some(result_tx)),
            },
        );
    }
    // Always clean up the PENDING entry + release the inflight reservation on
    // any exit path (success, failure, or the outer timeout below dropping
    // the future).
    struct Guard(Uuid, Uuid);
    impl Drop for Guard {
        fn drop(&mut self) {
            STATE
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.1);
            release_inflight(self.0);
        }
    }
    let _guard = Guard(user_id, request_id);

    let invoke_frame = DownFrame::AgentInvoke {
        request_id,
        action_id: action_id.to_string(),
        params,
        view_id,
        expected_token,
    };
    // Re-resolve the CURRENT bound sender (not a snapshot from before the
    // pending entry existed above) — a reload/rebind racing the dispatch
    // between the fast-path check and here is picked up on this very first
    // send, same as every liveness ping below.
    if send_to_current(user_id, &invoke_frame).is_err() {
        return Err(DispatchError::NotConnected);
    }

    // Read-at-use (issue #54): admin-tunable `action_wall_clock_secs`, default 900s.
    let wall_clock_cap = super::settings_cache::snapshot().action_wall_clock();
    match tokio::time::timeout(
        wall_clock_cap,
        run_liveness_loop(user_id, request_id, events_rx, result_rx),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_elapsed) => Err(DispatchError::Unresponsive),
    }
}

/// Send `frame` to `user_id`'s CURRENTLY bound sender (re-resolved fresh, not
/// the caller's possibly-stale snapshot). `Err` covers both "no session
/// bound at all" and "the bound channel's receiver is gone" — both fold into
/// `DispatchError::Unresponsive` at the call sites below (a genuine
/// mid-dispatch disconnect, as opposed to a rebind, which `current_sender`
/// would have picked up as the reloaded tab's new sender instead).
fn send_to_current(user_id: Uuid, frame: &DownFrame) -> Result<(), ()> {
    let sender = current_sender(user_id).ok_or(())?;
    send_frame(&sender, frame)
}

async fn run_liveness_loop(
    user_id: Uuid,
    request_id: Uuid,
    mut events_rx: mpsc::UnboundedReceiver<LivenessSignal>,
    mut result_rx: oneshot::Receiver<AgentResultFrame>,
) -> Result<AgentResultFrame, DispatchError> {
    let mut state = LivenessState::new();
    loop {
        tokio::select! {
            biased;
            res = &mut result_rx => {
                // Sender dropped without ever sending → treat conservatively
                // as an unresponsive engine (shouldn't happen: the `result`
                // endpoint always sends, and dropping the pending entry only
                // happens on our own cleanup after this future resolves).
                return res.map_err(|_| DispatchError::Unresponsive);
            }
            maybe = events_rx.recv() => {
                let event = match maybe {
                    Some(LivenessSignal::Progress) => LivenessEvent::Progress,
                    Some(LivenessSignal::Pong(status)) => LivenessEvent::Pong(status),
                    // The sender side lives in the PENDING entry we own, so
                    // this channel only closes when we drop it ourselves —
                    // unreachable in practice, but fail safe rather than spin.
                    None => return Err(DispatchError::Unresponsive),
                };
                let t = state.on_event(event);
                state = t.state;
                if t.send_ping && send_to_current(user_id, &DownFrame::Ping { request_id }).is_err() {
                    return Err(DispatchError::Unresponsive);
                }
                if let LivenessState::Failed(f) = state {
                    return Err(map_failure(f));
                }
            }
            _ = tokio::time::sleep(LIVENESS_TICK) => {
                let ev = match state {
                    LivenessState::Quiet => LivenessEvent::QuietElapsed,
                    LivenessState::PingOutstanding { .. } => LivenessEvent::PingElapsed,
                    LivenessState::Failed(_) => unreachable!("Failed is terminal; loop returns before another tick"),
                };
                let t = state.on_event(ev);
                state = t.state;
                if t.send_ping && send_to_current(user_id, &DownFrame::Ping { request_id }).is_err() {
                    return Err(DispatchError::Unresponsive);
                }
                if let LivenessState::Failed(f) = state {
                    return Err(map_failure(f));
                }
            }
        }
    }
}

// ============================== up-endpoints =================================

fn record_progress(caller: Uuid, request_id: Uuid, message: &str) -> bool {
    let pending = STATE.pending.lock().unwrap_or_else(|e| e.into_inner());
    match pending.get(&request_id) {
        Some(entry) if entry.owner == caller => {
            tracing::debug!(%request_id, %message, "mcp: agent progress");
            entry.events_tx.send(LivenessSignal::Progress).is_ok()
        }
        _ => false,
    }
}

fn record_pong(
    caller: Uuid,
    request_id: Uuid,
    status: PongStatus,
    waiting_on: Option<&str>,
    since_ms: Option<i64>,
) -> bool {
    let pending = STATE.pending.lock().unwrap_or_else(|e| e.into_inner());
    match pending.get(&request_id) {
        Some(entry) if entry.owner == caller => {
            tracing::debug!(%request_id, ?status, ?waiting_on, ?since_ms, "mcp: agent pong");
            entry.events_tx.send(LivenessSignal::Pong(status)).is_ok()
        }
        _ => false,
    }
}

fn record_result(caller: Uuid, request_id: Uuid, frame: AgentResultFrame) -> bool {
    let pending = STATE.pending.lock().unwrap_or_else(|e| e.into_inner());
    match pending.get(&request_id) {
        Some(entry) if entry.owner == caller => {
            let mut guard = entry.result_tx.lock().unwrap_or_else(|e| e.into_inner());
            match guard.take() {
                Some(tx) => tx.send(frame).is_ok(),
                None => false, // already resolved (duplicate result POST)
            }
        }
        _ => false,
    }
}

pub async fn agent_result(
    auth: RequirePermissions<(McpUse,)>,
    Json(body): Json<AgentResultBody>,
) -> Json<AckResponse> {
    let frame = AgentResultFrame {
        ok: body.ok,
        result: body.result,
        error: body.error,
        logs: body.logs,
    };
    Json(AckResponse {
        ok: record_result(auth.user.id, body.request_id, frame),
    })
}

pub async fn agent_progress(
    auth: RequirePermissions<(McpUse,)>,
    Json(body): Json<AgentProgressBody>,
) -> Json<AckResponse> {
    Json(AckResponse {
        ok: record_progress(auth.user.id, body.request_id, &body.message),
    })
}

pub async fn agent_pong(
    auth: RequirePermissions<(McpUse,)>,
    Json(body): Json<AgentPongBody>,
) -> Json<AckResponse> {
    Json(AckResponse {
        ok: record_pong(
            auth.user.id,
            body.request_id,
            body.status,
            body.waiting_on.as_deref(),
            body.since_ms,
        ),
    })
}

// ============================== SSE stream ===================================

/// `GET /api/mcp/agent/stream?session_id=<uuid>` — plain, undocumented (mirrors
/// the JSON-RPC endpoint; server->client payload push isn't part of the
/// `ApiClient` surface). Binds `user -> session_id -> this connection`;
/// reconnecting with the same user REBINDS (a stale connection's in-flight
/// pendings fail via `pong{unknown}`/missed-ping, not via this rebind itself).
pub async fn agent_stream(
    auth: RequirePermissions<(McpUse,)>,
    Query(q): Query<AgentStreamQuery>,
) -> Response {
    let user_id = auth.user.id;
    let session_id = q.session_id;

    let (tx, mut rx) = mpsc::unbounded_channel::<Result<Event, axum::Error>>();
    let conn_id = match bind_session(user_id, tx) {
        Ok(id) => id,
        Err(()) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "agent channel registry full",
            )
                .into_response();
        }
    };

    let stream = async_stream::stream! {
        // Unbind on drop (client disconnect / stream torn down), but only if
        // WE are still the bound connection (identified by `conn_id`, NOT
        // `session_id` — a newer reconnect sharing the same client-supplied
        // `session_id`, e.g. an ordinary browser reload, must never be
        // clobbered by this stale connection's own teardown; see
        // `unbind_session`).
        struct Unbind(Uuid, Uuid);
        impl Drop for Unbind {
            fn drop(&mut self) {
                unbind_session(self.0, self.1);
            }
        }
        let _unbind = Unbind(user_id, conn_id);

        // The handshake carries the server-minted `connection_id` as well as
        // the client's own `session_id`: the engine echoes it back on
        // `POST /api/mcp/agent/capabilities` so a report can be attributed to
        // THIS connection rather than to whichever one happens to be bound
        // (`session_id` cannot serve — a reload legitimately persists it, so two
        // unrelated connections can share one; see `ControlSession::conn_id`).
        yield Ok(Event::default().data(
            serde_json::json!({
                "type": "connected",
                "session_id": session_id,
                "connection_id": conn_id,
            })
            .to_string(),
        ));

        while let Some(ev) = rx.recv().await {
            yield ev;
        }
    };

    (
        StatusCode::OK,
        Sse::new(stream).keep_alive(KeepAlive::default()),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::bind_test_session as bind_fake_session;

    fn cap(id: &str) -> FrontendActionEntry {
        FrontendActionEntry {
            id: id.to_string(),
            title: "An action".to_string(),
            kind: "instance".to_string(),
            mutating: true,
            stateful: true,
            context: "global".to_string(),
            permission: "jobs::use".to_string(),
            params_schema: serde_json::json!({}),
            group: None,
            description: None,
            aliases: Vec::new(),
            keywords: Vec::new(),
        }
    }

    fn cap_ids(user_id: Uuid) -> Vec<String> {
        capabilities_for(user_id)
            .iter()
            .map(|e| e.id.clone())
            .collect()
    }

    // ── the reported view-scoped catalog lives and dies with the session ─────

    #[test]
    fn a_report_from_the_bound_connection_is_stored_and_readable() {
        let user = Uuid::new_v4();
        let (conn_id, _rx) = bind_fake_session(user);
        assert!(
            cap_ids(user).is_empty(),
            "a fresh connection has reported nothing yet"
        );

        assert!(set_capabilities(
            user,
            conn_id,
            vec![cap("demo.view::d.first")]
        ));
        assert_eq!(cap_ids(user), vec!["demo.view::d.first"]);
        unbind_session(user, conn_id);
    }

    /// The invokability rule, enforced by LIFETIME rather than by a rule: with
    /// no bound connection `dispatch` fails `NotConnected`, so nothing
    /// view-scoped is invokable — and nothing is readable either.
    #[test]
    fn capabilities_die_with_the_session() {
        let user = Uuid::new_v4();
        let (conn_id, _rx) = bind_fake_session(user);
        set_capabilities(user, conn_id, vec![cap("demo.view::d.first")]);
        assert_eq!(cap_ids(user).len(), 1);

        unbind_session(user, conn_id);
        assert!(
            cap_ids(user).is_empty(),
            "a capability nobody can invoke must not survive its session"
        );
    }

    #[test]
    fn an_unbound_user_reports_nothing_and_reads_nothing() {
        let user = Uuid::new_v4();
        assert!(cap_ids(user).is_empty());
        assert!(
            !set_capabilities(user, Uuid::new_v4(), vec![cap("demo.view::d.first")]),
            "a report with no bound connection cannot correlate"
        );
        assert!(cap_ids(user).is_empty());
    }

    /// A reload rebinds a FRESH connection; the old tab's teardown and its late
    /// report both carry the OLD `conn_id`, so neither may clobber the new
    /// session's catalog.
    #[test]
    fn a_report_from_a_superseded_connection_is_refused() {
        let user = Uuid::new_v4();
        let (old_conn, _old_rx) = bind_fake_session(user);
        set_capabilities(user, old_conn, vec![cap("demo.view::d.old")]);

        let (new_conn, _new_rx) = bind_fake_session(user);
        assert_ne!(old_conn, new_conn);
        assert!(
            !set_capabilities(user, old_conn, vec![cap("demo.view::d.stale")]),
            "the superseded connection's report must not correlate"
        );
        assert!(
            cap_ids(user).is_empty(),
            "the fresh connection starts empty and the stale report changed nothing: {:?}",
            cap_ids(user)
        );

        assert!(set_capabilities(
            user,
            new_conn,
            vec![cap("demo.view::d.new")]
        ));
        assert_eq!(cap_ids(user), vec!["demo.view::d.new"]);
        unbind_session(user, new_conn);
    }

    /// REPLACE, not merge — which is what makes a REMOVAL expressible. (The
    /// deleted server-side scan got this for free by re-reading the files; a
    /// reported catalog has to say so.)
    #[test]
    fn a_second_report_replaces_the_first() {
        let user = Uuid::new_v4();
        let (conn_id, _rx) = bind_fake_session(user);
        set_capabilities(
            user,
            conn_id,
            vec![cap("demo.view::d.first"), cap("demo.view::d.second")],
        );
        assert_eq!(cap_ids(user).len(), 2);

        set_capabilities(user, conn_id, vec![cap("demo.view::d.first")]);
        assert_eq!(
            cap_ids(user),
            vec!["demo.view::d.first"],
            "the removed action must be gone from the AI surface"
        );
        unbind_session(user, conn_id);
    }

    #[test]
    fn one_users_report_is_invisible_to_another() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let (a_conn, _a_rx) = bind_fake_session(a);
        let (b_conn, _b_rx) = bind_fake_session(b);

        set_capabilities(a, a_conn, vec![cap("demo.view::a.only")]);
        assert_eq!(cap_ids(a), vec!["demo.view::a.only"]);
        assert!(cap_ids(b).is_empty(), "{:?}", cap_ids(b));

        assert!(
            !set_capabilities(b, a_conn, vec![cap("demo.view::a.hijack")]),
            "a connection id belonging to another user must not correlate"
        );
        assert_eq!(cap_ids(a), vec!["demo.view::a.only"]);

        unbind_session(a, a_conn);
        unbind_session(b, b_conn);
    }

    // ITEM-9: the pure per-request liveness state machine — quiet -> ping,
    // pong{processing} -> wait, pong{unknown} -> FRONTEND_RELOADED,
    // missed -> FRONTEND_UNRESPONSIVE.

    #[test]
    fn quiet_elapsed_sends_a_ping_and_moves_to_ping_outstanding() {
        let t = LivenessState::new().on_event(LivenessEvent::QuietElapsed);
        assert!(t.send_ping);
        assert_eq!(t.state, LivenessState::PingOutstanding { missed: 0 });
    }

    #[test]
    fn progress_while_quiet_stays_quiet_no_ping() {
        let t = LivenessState::new().on_event(LivenessEvent::Progress);
        assert!(!t.send_ping);
        assert_eq!(t.state, LivenessState::Quiet);
    }

    #[test]
    fn progress_while_ping_outstanding_resets_to_quiet() {
        let state = LivenessState::PingOutstanding { missed: 1 };
        let t = state.on_event(LivenessEvent::Progress);
        assert!(!t.send_ping);
        assert_eq!(t.state, LivenessState::Quiet);
    }

    #[test]
    fn pong_processing_resets_to_quiet_keeps_waiting() {
        let state = LivenessState::PingOutstanding { missed: 1 };
        let t = state.on_event(LivenessEvent::Pong(PongStatus::Processing));
        assert!(!t.send_ping);
        assert_eq!(t.state, LivenessState::Quiet);
    }

    #[test]
    fn pong_unknown_fails_frontend_reloaded() {
        let state = LivenessState::PingOutstanding { missed: 0 };
        let t = state.on_event(LivenessEvent::Pong(PongStatus::Unknown));
        assert!(!t.send_ping);
        assert_eq!(
            t.state,
            LivenessState::Failed(LivenessFailure::FrontendReloaded)
        );
    }

    #[test]
    fn one_missed_ping_sends_another_ping_not_yet_failed() {
        let state = LivenessState::PingOutstanding { missed: 0 };
        let t = state.on_event(LivenessEvent::PingElapsed);
        assert!(t.send_ping);
        assert_eq!(t.state, LivenessState::PingOutstanding { missed: 1 });
    }

    #[test]
    fn max_missed_pings_fails_frontend_unresponsive() {
        let state = LivenessState::PingOutstanding {
            missed: MAX_MISSED_PINGS - 1,
        };
        let t = state.on_event(LivenessEvent::PingElapsed);
        assert!(!t.send_ping);
        assert_eq!(
            t.state,
            LivenessState::Failed(LivenessFailure::FrontendUnresponsive)
        );
    }

    #[test]
    fn failed_state_is_terminal_ignores_further_events() {
        let state = LivenessState::Failed(LivenessFailure::FrontendReloaded);
        for ev in [
            LivenessEvent::Progress,
            LivenessEvent::QuietElapsed,
            LivenessEvent::Pong(PongStatus::Processing),
            LivenessEvent::PingElapsed,
        ] {
            let t = state.on_event(ev);
            assert!(!t.send_ping);
            assert_eq!(
                t.state,
                LivenessState::Failed(LivenessFailure::FrontendReloaded)
            );
        }
    }

    #[test]
    fn full_sequence_quiet_ping_processing_ping_unknown() {
        // Simulates: dispatch -> quiet -> goes quiet too long -> ping ->
        // engine says "still working" -> quiet again -> quiet too long again
        // -> ping -> the window reloaded -> FRONTEND_RELOADED.
        let mut state = LivenessState::new();
        let t1 = state.on_event(LivenessEvent::QuietElapsed);
        assert!(t1.send_ping);
        state = t1.state;

        let t2 = state.on_event(LivenessEvent::Pong(PongStatus::Processing));
        assert!(!t2.send_ping);
        state = t2.state;
        assert_eq!(state, LivenessState::Quiet);

        let t3 = state.on_event(LivenessEvent::QuietElapsed);
        assert!(t3.send_ping);
        state = t3.state;

        let t4 = state.on_event(LivenessEvent::Pong(PongStatus::Unknown));
        assert!(!t4.send_ping);
        assert_eq!(
            t4.state,
            LivenessState::Failed(LivenessFailure::FrontendReloaded)
        );
    }

    #[test]
    fn down_frame_serializes_to_contract_shape() {
        let request_id = Uuid::nil();
        let frame = DownFrame::AgentInvoke {
            request_id,
            action_id: "project.openProject".to_string(),
            params: serde_json::json!({ "project_id": "abc" }),
            view_id: None,
            expected_token: None,
        };
        let v: Value = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["type"], "agent_invoke");
        assert_eq!(v["request_id"], request_id.to_string());
        assert_eq!(v["action_id"], "project.openProject");
        assert_eq!(v["params"]["project_id"], "abc");
        // A global action carries neither field on the wire (skipped when None).
        assert!(v.get("view_id").is_none());
        assert!(v.get("expected_token").is_none());

        let ping = DownFrame::Ping { request_id };
        let v: Value = serde_json::to_value(&ping).unwrap();
        assert_eq!(v["type"], "ping");
    }

    #[test]
    fn down_frame_carries_view_id_and_expected_token_for_an_instance_action() {
        let request_id = Uuid::nil();
        let frame = DownFrame::AgentInvoke {
            request_id,
            action_id: "harness.setValue".to_string(),
            params: serde_json::json!({ "view_id": "v1", "value": 1, "expected": "v1@0" }),
            view_id: Some("v1".to_string()),
            expected_token: Some("v1@0".to_string()),
        };
        let v: Value = serde_json::to_value(&frame).unwrap();
        assert_eq!(v["view_id"], "v1");
        assert_eq!(v["expected_token"], "v1@0");
    }
}
