//! The sync stream's identity resolver: the SDK's `DefaultIdentityResolver`
//! plus the ONE seam it leaves at its trait default — `access_token_ver`.
//!
//! Why this type exists at all. `sync_routes::<R, S>` reads the connection's
//! access-token revocation epoch through `IdentityResolver::access_token_ver`
//! and hands it to [`SyncSurface::recheck`], which compares it against the live
//! `users.token_version` so a LOGOUT ends an already-open SSE stream instead of
//! letting it live to the token's `exp`. `DefaultIdentityResolver` implements
//! only `authenticate` / `load_groups` / `active_group_permissions`, so it
//! inherits the `None` default for that seam — and `None` means "no epoch
//! gate". Wiring the gate without also supplying the epoch would compile, pass
//! its tests, and never fire.
//!
//! CytoAnalyst's access tokens DO carry the epoch: they are minted by the SDK's
//! `JwtService::generate_access_token`, which stamps `ver: Some(token_version)`
//! (`sdk/crates/ziee-auth/src/auth/jwt.rs`). Nothing was reading it. This
//! resolver reads it.
//!
//! Scope: deliberately used ONLY by the sync module's routes, so the app-wide
//! `RequirePermissions` alias keeps resolving through the plain
//! `DefaultIdentityResolver` that the SDK's turnkey `AuthModule` installs. The
//! delegation is total — authentication, group loading and the permission union
//! are byte-identical to the default resolver's.

use std::sync::Arc;

use axum::http::{request::Parts, StatusCode};

use ziee_auth::auth::jwt::Claims;
use ziee_auth::auth::{DefaultIdentityResolver, JwtService};
use ziee_auth::user::{Group, User};
use ziee_core::AppError;
use ziee_framework::permissions::IdentityResolver;

/// `DefaultIdentityResolver` + the access-token epoch seam.
pub struct SyncIdentityResolver {
    inner: DefaultIdentityResolver,
    jwt: Arc<JwtService>,
}

impl SyncIdentityResolver {
    /// Build from the app pool + JWT service. The `JwtService` must be
    /// configured from the same `jwt` config block as the one `AuthModule`
    /// mints with — same secret ⇒ the tokens are interoperable (the same
    /// argument `lib.rs` makes for the `BootParts` service).
    pub fn new(pool: sqlx::SqlitePool, jwt: Arc<JwtService>) -> Self {
        Self {
            inner: DefaultIdentityResolver::new(pool, jwt.clone()),
            jwt,
        }
    }

    /// The validated claims of the request's bearer access token, or `None` if
    /// the header is absent/malformed or the token does not validate.
    ///
    /// Returning `None` rather than an error is correct here: this only feeds
    /// the OPTIONAL `access_token_*` seams. The route is still gated by
    /// `RequirePermissions`, which runs `authenticate` (the same validation)
    /// and rejects the request outright — so an unvalidatable token never
    /// reaches a point where a missing epoch matters.
    fn claims(&self, parts: &Parts) -> Option<Claims> {
        let header = parts.headers.get("Authorization")?.to_str().ok()?;
        let token = JwtService::extract_token_from_header(header).ok()?;
        self.jwt.validate_access_token(token).ok()
    }
}

#[async_trait::async_trait]
impl IdentityResolver for SyncIdentityResolver {
    type User = User;
    type Group = Group;

    async fn authenticate(&self, parts: &mut Parts) -> Result<User, (StatusCode, AppError)> {
        self.inner.authenticate(parts).await
    }

    async fn load_groups(&self, user: &User) -> Result<Vec<Group>, (StatusCode, AppError)> {
        self.inner.load_groups(user).await
    }

    fn active_group_permissions(group: &Group) -> Option<&[String]> {
        DefaultIdentityResolver::active_group_permissions(group)
    }

    /// The `ver` claim — a snapshot of `users.token_version` taken when this
    /// connection's access token was minted. The periodic re-check compares it
    /// against the live column and tears the stream down on a mismatch, which
    /// is what makes a logout terminate an already-open stream.
    ///
    /// `None` for a token minted before the epoch shipped; the re-check then
    /// applies no epoch gate, exactly as the trait documents.
    fn access_token_ver(&self, parts: &Parts) -> Option<i32> {
        self.claims(parts).and_then(|c| c.ver)
    }

    /// The access token's `exp`, so the stream's deadline is the TOKEN's, not a
    /// far-future fallback.
    ///
    /// The SDK default is `None`, which it documents as "the stream falls back
    /// to a far-future deadline". Left at the default, an SSE stream outlives
    /// the token that authorized it: `recheck` re-resolves the user, groups and
    /// revocation epoch, but it never re-validates the token itself, so an
    /// EXPIRED-but-unrevoked token keeps its stream for the connection's whole
    /// life. Revocation and expiry are two different ways a token stops being
    /// good; the epoch gate above closes the first, and this closes the second.
    ///
    /// Free: `claims()` already parsed and validated the token for the `ver`
    /// read above, and `exp` is on the same struct.
    fn access_token_exp(&self, parts: &Parts) -> Option<i64> {
        self.claims(parts).map(|c| c.exp)
    }
}
