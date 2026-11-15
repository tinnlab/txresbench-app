//! The demo's anonymous browser sessions (demo-mode ITEM-1).
//!
//! ## What a demo session is
//!
//! `POST /api/session/local` in demo mode does NOT mint the owner (there is
//! no owner in a public demo): it mints an anonymous visit session —
//!
//! * a random session id carried in a cookie (`txr_demo_session`, HttpOnly,
//!   SameSite=Strict, path `/` so every request carries it — it is what the
//!   rate limiter and the run-ownership gate read);
//! * a real `users` row behind it (username `guest-<32-hex>`, a synthetic
//!   email, no password — the auth machinery needs a user; the row holds NO
//!   personal data because nothing about the visitor is known or stored);
//! * membership in the ONE demo role group, which holds EXACTLY the
//!   permissions the allowed/adapted routes demand (`jobs::use` +
//!   `projects::use` — the app-surface gates, see `crate::modules::perms`
//!   [sic] the routes' `RequirePermissions` tuples): "a role with only the
//!   allowed capabilities", no more.
//!
//! ## Why a per-visit USER row and not a token alone
//!
//! The framework's `RequirePermissions` validates the JWT and loads the user
//! + its groups on every gated request (`DefaultIdentityResolver`), so the
//! anonymous identity must be a real row or no txr route would pass. The
//! session→user indirection (`txr_demo_sessions`) is what lets ITEM-4's
//! stale-session cleanup remove the ROW without guessing at identities, and
//! what lets the gate compare session ids without exposing user rows.
//!
//! ## The cookie is not a credential
//!
//! Every API call still authenticates with the bearer access token; the
//! cookie only names the SESSION for rate limiting and for the run-control
//! ownership check (stop/skip/at-a-time/rerun by the run's starting session
//! only). Losing the cookie loses the right to control one's runs — never
//! the shared pool's data.
//!
//! ## Ownership (run records its creator)
//!
//! A run created by a session is recorded in `txr_demo_run_sessions`
//! (`run_id` PK, `session_id`); the demo gate 403s any control op whose
//! session is not the recorded one. Runs with no row (a seeded/pinned run)
//! are controlled by nobody in demo mode — the safest default, and exactly
//! the `stop`/`skip` by the starting session rule the plan states.

use axum::http::{HeaderValue, header};
use sqlx::SqlitePool;
use txresbench_auth::auth::refresh_tokens::mint_session_tokens;
use txresbench_auth::auth::JwtService;
use txresbench_auth::user::{GroupRepository, UserRepository};
use txresbench_core::AppError;
use uuid::Uuid;

use crate::modules::localsession::LocalSession;

/// The demo session cookie name (`txr_` prefix, like the SDK's
/// `txresbench_refresh`).
pub const DEMO_SESSION_COOKIE: &str = "txr_demo_session";

/// The role group: ONE group for all demo visitors, holding exactly the
/// permissions the app-surface routes require.
const DEMO_ROLE_GROUP: &str = "Demo visitors";
const DEMO_ROLE_PERMISSIONS: &[&str] = &["jobs::use", "projects::use"];

/// Cookie lifetime: 30 days (a visitor returning within a month keeps the
/// same session; ITEM-4's stale-session reaper decides actual staleness).
const DEMO_SESSION_MAX_AGE_SECS: i64 = 30 * 24 * 60 * 60;

/// The mint result: the session (shape-compatible with the desktop owner
/// session) + the cookie header to set (always `Some` in demo mode).
pub struct DemoMint {
    pub session: LocalSession,
    pub cookie: HeaderValue,
}

/// Read the session id from the request's `Cookie` header(s).
pub fn read_session_id(headers: &header::HeaderMap) -> Option<Uuid> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(s) = value.to_str() else { continue };
        for pair in s.split(';') {
            let pair = pair.trim();
            let Some(id) = pair.strip_prefix(DEMO_SESSION_COOKIE).and_then(|p| p.strip_prefix('='))
            else {
                continue;
            };
            if let Ok(uuid) = Uuid::parse_str(id) {
                return Some(uuid);
            }
        }
    }
    None
}

/// Build the `Set-Cookie` value for a (new or refreshed) session.
pub fn build_cookie(session_id: Uuid) -> HeaderValue {
    let cookie = format!(
        "{DEMO_SESSION_COOKIE}={session_id}; HttpOnly; SameSite=Strict; Path=/; Max-Age={DEMO_SESSION_MAX_AGE_SECS}"
    );
    // A uuid is ASCII plus hyphens — always valid header bytes; from_str can
    // only fail on a malformed value, in which case sending no cookie is the
    // safe degradation.
    HeaderValue::from_str(&cookie).unwrap_or(HeaderValue::from_static(""))
}

/// Ensure the demo role group exists (idempotent). Returns its id.
async fn ensure_demo_role(pool: &SqlitePool) -> Result<Uuid, AppError> {
    let repo = GroupRepository::new(pool.clone());
    if let Some(group) = repo.get_by_name(DEMO_ROLE_GROUP).await? {
        return Ok(group.id);
    }
    let group = repo
        .create(
            DEMO_ROLE_GROUP,
            Some("The role of every anonymous demo visitor (only the demo routes' capabilities).".to_string()),
            DEMO_ROLE_PERMISSIONS.iter().map(|s| s.to_string()).collect(),
        )
        .await?;
    Ok(group.id)
}

/// Create the anonymous visitor user behind a fresh session (no personal
/// data: the username/email are derived from the random session id and hold
/// no information about the visitor; the password is never set).
async fn create_visitor_user(
    pool: &SqlitePool,
    session_id: Uuid,
    role_group_id: Uuid,
) -> Result<Uuid, AppError> {
    let suffix = session_id.simple().to_string(); // 32 hex chars
    let username = format!("guest-{suffix}");
    let email = format!("{username}@demo.invalid");
    let users = UserRepository::new(pool.clone());
    let user = users.create(&username, &email, None, None, None).await?;
    users.assign_to_group(user.id, role_group_id, None).await?;
    Ok(user.id)
}

/// Mint (or re-mint) an anonymous demo session.
///
/// * A request carrying a KNOWN `txr_demo_session` cookie re-mints for the
///   same user (a page reload keeps the session: the same session also keeps
///   the right to stop/skip the runs it started) and re-sets the cookie.
/// * Otherwise a brand-new session + visitor user is created.
///
/// The response is the same `LocalSession` shape the owner mint returns, so
/// the UI's single-user session flow is unchanged.
pub async fn mint_anonymous_session(
    pool: &SqlitePool,
    jwt: &JwtService,
    headers: &header::HeaderMap,
) -> Result<DemoMint, AppError> {
    // Already visited? Re-mint for the recorded user.
    if let Some(session_id) = read_session_id(headers) {
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM txr_demo_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?;
        if let Some(user_id) = user_id {
            let user = UserRepository::new(pool.clone())
                .get_by_id(user_id)
                .await?
                .ok_or_else(|| {
                    AppError::unauthorized("DEMO_SESSION_USER_MISSING", "The demo session's user no longer exists")
                })?;
            let session = mint_for_user(pool, jwt, &user).await?;
            sqlx::query(
                "UPDATE txr_demo_sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            )
            .bind(session_id)
            .execute(pool)
            .await
            .map_err(AppError::database_error)?;
            return Ok(DemoMint { session, cookie: build_cookie(session_id) });
        }
        // Unknown cookie → a brand-new visit (the cookie is stale/forged).
    }

    let session_id = Uuid::new_v4();
    let role_group_id = ensure_demo_role(pool).await?;
    let user_id = create_visitor_user(pool, session_id, role_group_id).await?;
    let user = UserRepository::new(pool.clone())
        .get_by_id(user_id)
        .await?
        .ok_or_else(|| AppError::internal_error("Demo visitor user was not created"))?;
    let session = mint_for_user(pool, jwt, &user).await?;
    sqlx::query(
        "INSERT INTO txr_demo_sessions (id, user_id, last_seen_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    )
    .bind(session_id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(DemoMint { session, cookie: build_cookie(session_id) })
}

async fn mint_for_user(
    pool: &SqlitePool,
    jwt: &JwtService,
    user: &txresbench_auth::User,
) -> Result<LocalSession, AppError> {
    let minted = mint_session_tokens(
        pool,
        jwt,
        user.id,
        &user.username,
        &user.email,
        user.is_admin,
    )
    .await?;
    Ok(LocalSession {
        user: user.clone(),
        access_token: minted.pair.access_token,
        refresh_token: minted.pair.refresh_token,
        expires_in: minted.pair.expires_in,
    })
}

/// Record that a run was started by this session (the run-create / rerun
/// stamp; no-op when no session is present).
pub async fn stamp_run(
    pool: &SqlitePool,
    run_id: Uuid,
    session_id: Option<Uuid>,
) -> Result<(), AppError> {
    let Some(session_id) = session_id else { return Ok(()) };
    sqlx::query(
        "INSERT INTO txr_demo_run_sessions (run_id, session_id) VALUES (?, ?) \
         ON CONFLICT (run_id) DO UPDATE SET session_id = excluded.session_id",
    )
    .bind(run_id)
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// The session that started a run (the gate's ownership read). `Ok(None)` for
/// a run with no recorded session (seeded/pinned runs: nobody controls them
/// in demo mode).
pub async fn run_session(pool: &SqlitePool, run_id: Uuid) -> Result<Option<Uuid>, AppError> {
    let session_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT session_id FROM txr_demo_run_sessions WHERE run_id = ?",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_round_trips_a_uuid() {
        let id = Uuid::new_v4();
        let cookie = build_cookie(id);
        let text = cookie.to_str().unwrap().to_string();
        let mut headers = header::HeaderMap::new();
        // A cookiejar may carry other cookies; ours is found regardless of order.
        let mixed = format!("other=a; {text}; something=b");
        headers.insert(header::COOKIE, mixed.parse().unwrap());
        assert_eq!(read_session_id(&headers), Some(id));
    }

    #[test]
    fn cookie_attributes_are_the_safe_ones() {
        let cookie = build_cookie(Uuid::new_v4()).to_str().unwrap().to_string();
        assert!(cookie.contains("HttpOnly"), "JS must not read the session id");
        assert!(cookie.contains("SameSite=Strict"), "CSRF posture");
        assert!(cookie.contains("Path=/"), "the limiter + gate see it on every request");
        assert!(cookie.contains("Max-Age="), "it expires");
    }

    #[test]
    fn missing_or_malformed_cookie_is_none() {
        let mut headers = header::HeaderMap::new();
        headers.insert(header::COOKIE, "other=a".parse().unwrap());
        assert_eq!(read_session_id(&headers), None);
        headers.insert(header::COOKIE, format!("{DEMO_SESSION_COOKIE}=not-a-uuid").parse().unwrap());
        assert_eq!(read_session_id(&headers), None);
    }
}
