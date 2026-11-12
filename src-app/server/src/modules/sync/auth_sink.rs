//! The app's `AuthSyncSink` — the one place `txresbench-auth`'s crate-local sync
//! vocabulary becomes this app's concrete [`SyncEntity`] / [`SyncAction`].
//!
//! ── why this file exists ────────────────────────────────────────────────────
//!
//! `txresbench-auth` cannot name `SyncEntity`: it derives `JsonSchema` for the OpenAPI
//! codegen contract and stays app-side. So the SDK's auth handlers publish in
//! terms of `AuthSyncEntity` / `AuthSyncAction` through an `AuthSyncSink`, and
//! the app maps.
//!
//! Until the SDK grew an injection point there was no way to install one on the
//! turnkey `AuthModule` path: `AuthModule::init` hard-coded `NoopAuthSyncSink`.
//! Seven publish sites in `txresbench-auth` — profile update, session-settings update,
//! logout's session signal, all four auth-provider mutations — ran, computed
//! their frames, and dropped them. The frontend's `sync:profile` and
//! `sync:session_settings` subscriptions were refreshes that could never happen,
//! and both were allow-listed in `core/sync/syncChannelParity.test.ts` with the
//! blocker filed in `SDK_GAPS.md`. This sink is the other end of that fix.
//!
//! ── audiences are the SDK's, not ours ───────────────────────────────────────
//!
//! Each `txresbench-auth` call site picks its own `Audience` (owner-scoped for
//! profile/session, `perm::<SessionSettingsRead>()` / `perm::<AuthProvidersRead>()`
//! for the admin singletons) and passes it through. This sink FORWARDS it
//! unchanged — widening an audience here would turn a per-user notification into
//! a broadcast, which is exactly the leak `publish`'s explicit-audience design
//! exists to prevent.

use std::sync::Arc;

use uuid::Uuid;

use txresbench_auth::auth::{AuthSyncAction, AuthSyncEntity, AuthSyncSink};

use super::{publish, publish_session_to_users, Audience, SyncAction, SyncEntity};

/// Routes `txresbench-auth`'s publishes into this app's SSE fan-out.
pub struct AuthPublishSink;

/// Map the SDK's abstract auth entity onto this app's concrete wire entity.
///
/// Total by construction — a new `AuthSyncEntity` variant fails to compile here
/// rather than being quietly dropped, which is the property that makes this a
/// mapping and not a filter.
fn entity_of(entity: AuthSyncEntity) -> SyncEntity {
    match entity {
        AuthSyncEntity::User => SyncEntity::User,
        AuthSyncEntity::Group => SyncEntity::Group,
        AuthSyncEntity::Profile => SyncEntity::Profile,
        AuthSyncEntity::Session => SyncEntity::Session,
        AuthSyncEntity::SessionSettings => SyncEntity::SessionSettings,
        AuthSyncEntity::AuthProvider => SyncEntity::AuthProvider,
    }
}

fn action_of(action: AuthSyncAction) -> SyncAction {
    match action {
        AuthSyncAction::Create => SyncAction::Create,
        AuthSyncAction::Update => SyncAction::Update,
        AuthSyncAction::Delete => SyncAction::Delete,
    }
}

impl AuthSyncSink for AuthPublishSink {
    fn publish(
        &self,
        entity: AuthSyncEntity,
        action: AuthSyncAction,
        id: Uuid,
        audience: Audience,
        origin: Option<Uuid>,
    ) {
        publish(entity_of(entity), action_of(action), id, audience, origin);
    }

    fn publish_session_to_users(&self, user_ids: &[Uuid], origin: Option<Uuid>) {
        publish_session_to_users(user_ids, origin);
    }
}

/// Declare the app's auth sync wiring. Call ONCE at boot, BEFORE
/// `initialize_modules` — `AuthModule::init` refuses to boot without a
/// declaration, so a missing call is a loud startup failure and not a silently
/// dead channel.
pub fn install() {
    txresbench_auth::auth::install_auth_sync_sink(Arc::new(AuthPublishSink));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EVERY auth entity maps to a distinct app entity.
    ///
    /// Written as an exhaustive `match` over a listed set rather than a spot
    /// check: `AuthSyncEntity::AuthProvider` had no `SyncEntity` counterpart at
    /// all, so the sink could not have been written without either adding the
    /// variant or dropping that one on the floor. Pinning the whole table is
    /// what makes the second option visible if anyone takes it later.
    #[test]
    fn every_auth_entity_maps_to_a_distinct_app_entity() {
        let table = [
            (AuthSyncEntity::User, SyncEntity::User),
            (AuthSyncEntity::Group, SyncEntity::Group),
            (AuthSyncEntity::Profile, SyncEntity::Profile),
            (AuthSyncEntity::Session, SyncEntity::Session),
            (AuthSyncEntity::SessionSettings, SyncEntity::SessionSettings),
            (AuthSyncEntity::AuthProvider, SyncEntity::AuthProvider),
        ];
        for (from, to) in table {
            assert_eq!(
                entity_of(from),
                to,
                "{from:?} must map to {to:?}; a wrong arm sends the frame to the wrong \
                 store and the right store never refreshes"
            );
        }
        // Distinctness: two auth entities collapsing onto one wire entity would
        // make one of them un-targetable by any subscriber.
        let mapped: Vec<SyncEntity> = table.iter().map(|(f, _)| entity_of(*f)).collect();
        for (i, a) in mapped.iter().enumerate() {
            for b in mapped.iter().skip(i + 1) {
                assert_ne!(a, b, "two auth entities collapsed onto {a:?}");
            }
        }
    }

    #[test]
    fn actions_map_one_to_one() {
        assert_eq!(action_of(AuthSyncAction::Create), SyncAction::Create);
        assert_eq!(action_of(AuthSyncAction::Update), SyncAction::Update);
        assert_eq!(action_of(AuthSyncAction::Delete), SyncAction::Delete);
    }
}
