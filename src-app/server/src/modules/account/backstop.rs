//! A5 ITEM-4/5 — the lazy-ensure personal-account backstop.
//!
//! A tower/axum middleware ([`ensure_personal_account_backstop`]) layered over the
//! WHOLE app (see `lib.rs::build_app`, where it sits with the other cross-cutting
//! layers — `FileContext`, CORS, rate-limit). On every request it best-effort
//! resolves the acting user from the bearer access token and, on the FIRST sighting
//! of a user this process lifetime, calls A1's idempotent
//! [`AccountRepository::ensure_personal_account`] so that a personal account exists
//! by their first authenticated request.
//!
//! It is the universal coverage for the **SDK-turnkey-owned** creation paths — local
//! `register`, LDAP first-login, OAuth first-login, link-account — which the app has
//! NO synchronous call-site to wrap until the SDK ships an in-tx
//! `install_user_created_hook` (external blocker #2 / G-AUTHEVT, recorded in
//! `SDK_GAPS.md`). It ALSO self-heals any pre-existing user the A1 backfill or the
//! synchronous ensure sites (ITEM-1/2/3) missed (§11 "self-healed on their next
//! request").
//!
//! ## Why global (not layered in `account/mod.rs::register_routes`)
//!
//! `build_api_router` layers each module's `register_routes` over the router
//! ACCUMULATED SO FAR. A `.layer()` added by the `account` module (order 23) would
//! therefore cover only the routes of modules registered at order ≤ 23 and MISS
//! every later module (dataset/file/sandbox/app/health) AND the turnkey
//! `AuthModule`'s own `/api/auth/*` routes (it registers LAST, `order = i32::MAX`).
//! PROV-A5-1 requires the backstop to fire on ANY authenticated request, so it must
//! wrap the FULLY-accumulated router — the same reason `AuthModule` layers its auth
//! extensions at `order = i32::MAX`. A global layer in `build_app` (where cross-
//! cutting concerns already live) is that placement. This is a build-time refinement
//! of the plan's illustrative "layer in `register_routes`" (JEDUF internal freedom;
//! it makes PROV-A5-1 actually hold — see DRIFT-1).
//!
//! ## Guarantees (blind-audit surface)
//!
//! - **Never gates.** On no identity (public route / absent/invalid token) it is a
//!   pure pass-through; it NEVER rejects a request — identity enforcement stays the
//!   route's `RequirePermissions` job. It runs OUTSIDE the auth extensions, so it
//!   validates the token with its OWN [`JwtService`] rather than reading
//!   `AuthContext` (which is injected by an inner layer and not yet present here).
//! - **Never fails the request.** A DB error on ensure is logged and swallowed
//!   (`tracing::warn!`); the request proceeds. It is correctness machinery, not an
//!   operational gate (DEC-3), so it must not turn a tenancy hiccup into a 5xx.
//! - **One DB touch per user per process.** A process-local [`ENSURED`] set
//!   short-circuits the second and later sightings, so steady state is a `HashSet`
//!   membership check, not a DB round-trip. A user is inserted into the set only
//!   AFTER a successful ensure, so a transient DB failure is retried on the next
//!   request rather than being cached as done.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use uuid::Uuid;

use txresbench_auth::auth::JwtService;

use super::repository::AccountRepository;

/// Process-local "already ensured a personal account this process" set. Bounds the
/// backstop to one DB touch per user per process lifetime (DEC-3). Growth is one
/// `Uuid` (16 bytes) per DISTINCT authenticated user seen — bounded by the user
/// population, never per-request, so no unbounded blow-up. A deleted user's id
/// lingering in the set is harmless: the set only ever SKIPS work, and account ids
/// are freshly random, so a stale entry can never mis-attribute a later user.
static ENSURED: LazyLock<Mutex<HashSet<Uuid>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// The middleware's captured state: the token validator + the repo it ensures
/// through. Cloned per request (both fields are cheap `Arc`/pool handles).
#[derive(Clone)]
pub struct BackstopState {
    jwt: Arc<JwtService>,
    repo: Arc<AccountRepository>,
}

impl BackstopState {
    /// Build from the app pool + the app's JWT service (the same one `AuthModule`
    /// mints with — same secret ⇒ the access tokens validate here).
    pub fn new(pool: sqlx::SqlitePool, jwt: Arc<JwtService>) -> Self {
        Self {
            jwt,
            repo: Arc::new(AccountRepository::new(pool)),
        }
    }
}

/// The acting `(user_id, name)` from the request's bearer access token, or `None`
/// when the header is absent/malformed or the token does not validate.
///
/// Returning `None` (never an error) is correct: this is a best-effort backstop, not
/// an auth gate. `name` is the token's `username` (DEC-4 — mirrors A1's backfill
/// which names a personal account after the user's `username`).
fn acting_identity(jwt: &JwtService, req: &Request) -> Option<(Uuid, String)> {
    let header = req.headers().get("Authorization")?.to_str().ok()?;
    let token = JwtService::extract_token_from_header(header).ok()?;
    let claims = jwt.validate_access_token(token).ok()?;
    let id = claims.sub.parse().ok()?;
    Some((id, claims.username))
}

/// Has `user_id` already been ensured this process lifetime?
fn already_ensured(user_id: Uuid) -> bool {
    ENSURED
        .lock()
        .map(|s| s.contains(&user_id))
        .unwrap_or(false)
}

/// Mark `user_id` ensured (called only AFTER a successful ensure).
fn mark_ensured(user_id: Uuid) {
    if let Ok(mut s) = ENSURED.lock() {
        s.insert(user_id);
    }
}

/// The middleware. Best-effort, never gates, never fails the request.
pub async fn ensure_personal_account_backstop(
    State(state): State<BackstopState>,
    req: Request,
    next: Next,
) -> Response {
    // Resolve identity WITHOUT failing on its absence — a public route or an
    // unauthenticated request simply flows through untouched.
    if let Some((user_id, name)) = acting_identity(&state.jwt, &req) {
        if !already_ensured(user_id) {
            // Idempotent (A1 `ON CONFLICT`). On success mark the process cache; on
            // error log-and-continue WITHOUT marking, so a transient failure retries
            // next request rather than being cached as done.
            match state.repo.ensure_personal_account(user_id, &name).await {
                Ok(_) => mark_ensured(user_id),
                Err(err) => {
                    tracing::warn!(
                        %user_id,
                        error = %err,
                        "personal-account backstop: ensure failed (best-effort, request proceeds)"
                    );
                }
            }
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-4 [covers: ITEM-5]: the process-local ensured-set short-circuits a second
    // ensure for the same user id (no second DB call), and an unknown id is not
    // pre-marked. Exercises the cache primitives directly (the DB path is covered by
    // the integration tests).
    #[test]
    fn ensured_set_short_circuits_and_does_not_premark() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();

        // Nothing is pre-marked.
        assert!(!already_ensured(a), "an unseen id is not pre-marked");
        assert!(!already_ensured(b));

        // First sighting → mark; second sighting is a cache hit (would skip the DB).
        assert!(!already_ensured(a));
        mark_ensured(a);
        assert!(already_ensured(a), "after mark, the id short-circuits");

        // Marking `a` does not mark an unrelated id.
        assert!(!already_ensured(b), "marking one id never marks another");
    }
}
