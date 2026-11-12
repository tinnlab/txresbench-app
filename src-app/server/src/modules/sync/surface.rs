//! TxResBench's concrete realtime-sync surface — everything the SDK's mountable
//! `sync_routes` handler needs that the framework will not name: the
//! per-connection permission snapshot, the process-wide registry singleton, the
//! SSE wire schema, the baseline subscribe permission, the handshake event, and
//! the periodic re-check. TxResBench is the FIRST `SyncSurface` consumer in the
//! ecosystem (SDK dogfooding — no prior example existed).

use std::sync::OnceLock;

use axum::response::sse::Event;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_auth::auth::http::jwt_extractor::verify_token_version;
use txresbench_auth::user::permissions::ProfileRead;
use txresbench_auth::user::UserRepository;
use txresbench_auth::{Group, User};
use txresbench_framework::sync::{RecheckOutcome, SyncEntityKind, SyncRegistry, SyncSurface};
use txresbench_identity::{PermissionCheck, Principal};

use super::event::{connected_event, SyncSseEvent};

/// The per-connection permission snapshot registered in the pool: the user plus
/// their active groups, so a `Perm`-audience event routes against the full
/// (direct ∪ active-group) permission union.
pub struct SyncConnPrincipal {
    pub user: User,
    pub groups: Vec<Group>,
}

impl Principal for SyncConnPrincipal {
    fn is_admin(&self) -> bool {
        self.user.is_admin
    }
    fn direct_permissions(&self) -> &[String] {
        &self.user.permissions
    }
    fn active_group_permissions(&self) -> Vec<&[String]> {
        self.groups
            .iter()
            .filter(|g| g.is_active)
            .map(|g| g.permissions.as_slice())
            .collect()
    }
}

impl From<(User, Vec<Group>)> for SyncConnPrincipal {
    fn from((user, groups): (User, Vec<Group>)) -> Self {
        Self { user, groups }
    }
}

/// The process-wide sync connection registry, keyed to TxResBench's principal.
static REGISTRY: OnceLock<SyncRegistry<SyncConnPrincipal>> = OnceLock::new();

pub fn registry() -> &'static SyncRegistry<SyncConnPrincipal> {
    REGISTRY.get_or_init(SyncRegistry::new)
}

/// The DB pool, captured at module init so the static `recheck` can re-resolve
/// a connection's identity without a per-request `Extension`.
static POOL: OnceLock<SqlitePool> = OnceLock::new();

pub fn set_pool(pool: SqlitePool) {
    let _ = POOL.set(pool);
}

/// Marker type carrying the `SyncSurface` + `SyncEntityKind` impls.
pub struct CytoSyncSurface;

impl SyncEntityKind for CytoSyncSurface {
    fn session_signal(user_id: Uuid) -> Event {
        // A `sync` frame `{entity:session, action:update, id:user_id}` — the
        // client re-bootstraps `/auth/me`. Built inline (not via SyncEvent) to
        // avoid a snake_case round-trip; matches the SDK SyncClient contract.
        Event::default().event("sync").data(
            serde_json::json!({
                "entity": "session",
                "action": "update",
                "id": user_id,
            })
            .to_string(),
        )
    }
}

#[async_trait::async_trait]
impl SyncSurface for CytoSyncSurface {
    type Principal = SyncConnPrincipal;
    type Wire = SyncSseEvent;
    type BaselinePerms = (ProfileRead,);

    fn registry() -> &'static SyncRegistry<Self::Principal> {
        registry()
    }

    fn principal_user_id(principal: &Self::Principal) -> Uuid {
        principal.user.id
    }

    fn connected_signal(conn_id: Uuid) -> Event {
        connected_event(conn_id)
    }

    async fn recheck(user_id: Uuid, token_ver: Option<i32>) -> RecheckOutcome<Self::Principal> {
        // No pool captured yet (should not happen once init ran) → keep the
        // stream and retry on the next tick rather than dropping it.
        let Some(pool) = POOL.get() else {
            return RecheckOutcome::Transient;
        };
        let repo = UserRepository::new(pool.clone());
        // Load the active user AND the live revocation epoch in ONE query: the
        // epoch check is free, since this row was already being fetched.
        match repo.get_by_id_with_token_version(user_id).await {
            Ok(Some((user, token_version))) if user.is_active => {
                // A logout must end an ALREADY-OPEN stream too. The subscribe
                // gate validates the token exactly once, but the stream then
                // lives until the token's `exp` (24h by default), and the
                // client-side Session fan-out is NOT a boundary against the
                // holder of a stolen token — they don't run our JS. So compare
                // the epoch this connection's token carried at subscribe time
                // against the live `users.token_version` column, and tear the
                // stream down when logout has moved it.
                //
                // `None` → no epoch gate, per the `SyncSurface::recheck`
                // contract ("a pre-epoch token / an app that doesn't implement
                // the seam"). Deliberately NOT folded into `0` the way
                // `verify_token_version` does on its own: against a resolver
                // that supplies no epoch, `None`-as-`0` would tear down every
                // user whose `token_version` has ever been bumped — i.e.
                // everyone who has logged out even once.
                if token_ver.is_some() && verify_token_version(token_ver, token_version).is_err() {
                    return RecheckOutcome::TearDown;
                }
                match repo.get_user_groups(user_id).await {
                    Ok(groups) => {
                        let principal = SyncConnPrincipal::from((user, groups));
                        // Baseline perm still held (admins bypass) → refresh the
                        // routing snapshot; otherwise tear the stream down.
                        if principal.is_admin() || principal.has_permission(ProfileRead::PERMISSION)
                        {
                            RecheckOutcome::Refresh(principal)
                        } else {
                            RecheckOutcome::TearDown
                        }
                    }
                    Err(_) => RecheckOutcome::Transient,
                }
            }
            // Deactivated or removed → tear down.
            Ok(_) => RecheckOutcome::TearDown,
            // Transient DB blip → keep the stream, retry next tick.
            Err(_) => RecheckOutcome::Transient,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(is_admin: bool, perms: &[&str]) -> User {
        User {
            id: Uuid::new_v4(),
            username: "u".into(),
            email: "u@x.y".into(),
            email_verified: true,
            password_hash: None,
            display_name: None,
            avatar_url: None,
            is_active: true,
            is_admin,
            permissions: perms.iter().map(|s| s.to_string()).collect(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            last_login_at: None,
            password_changed_at: None,
        }
    }

    fn group(is_active: bool, perms: &[&str]) -> Group {
        Group {
            id: Uuid::new_v4(),
            name: "g".into(),
            description: None,
            permissions: perms.iter().map(|s| s.to_string()).collect(),
            is_system: false,
            is_active,
            is_default: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn admin_principal_bypasses_via_is_admin() {
        // The admin bypass is `is_admin()` (checked at the registry delivery
        // site), NOT `has_permission` — the Principal trait deliberately excludes
        // is_admin from the permission union.
        let p = SyncConnPrincipal::from((user(true, &[]), vec![]));
        assert!(p.is_admin());
        assert!(
            !p.has_permission("anything::at::all"),
            "has_permission excludes is_admin"
        );
    }

    #[test]
    fn direct_permission_routes() {
        let p = SyncConnPrincipal::from((user(false, &["projects::use"]), vec![]));
        assert!(!p.is_admin());
        assert!(p.has_permission("projects::use"));
        assert!(!p.has_permission("project::settings::manage"));
    }

    #[test]
    fn active_group_permission_routes_but_inactive_group_does_not() {
        let active =
            SyncConnPrincipal::from((user(false, &[]), vec![group(true, &["projects::use"])]));
        assert!(active.has_permission("projects::use"));

        let inactive =
            SyncConnPrincipal::from((user(false, &[]), vec![group(false, &["projects::use"])]));
        assert!(!inactive.has_permission("projects::use"));
    }
}
