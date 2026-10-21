//! A4 ITEM-6 — the account/membership sync half (`PROV-A4-2`; A1 DEC-5 assigned
//! the emit + fan-out to A4).
//!
//! `account_audience` + `publish_account`/`publish_account_member` fan a change
//! **per-recipient** to every member of the account via `Audience::owner`, mirroring
//! `workstore/sync.rs::publish_artifact` VERBATIM — there is NO `Audience::Account`
//! set-audience constructor (the GRAPH substrate note + design DEC-15). A personal
//! account's membership is `[owner]` → a valid fan-to-self (the documented
//! `publish_artifact` empty-recipient case).
//!
//! The keys are A1's declared `SyncEntity::Account` / `::AccountMember` (PROV-A1-7);
//! the entity **id** on the wire is the `account_id` in both cases — the client
//! refetches `GET /api/accounts` (the switcher list) / `GET /api/accounts/{id}/members`
//! keyed by account (notify-and-refetch only; no row data on the wire).

use sqlx::PgPool;
use uuid::Uuid;

use ziee_core::AppError;

use super::models::AccountRole;
use super::repository::AccountRepository;
use crate::modules::sync::{fan_out_owner_scoped, Actor, SyncAction, SyncEntity};

/// Resolve `(owner_id, other_member_ids)` for `account_id` — the fan-out audience
/// (owner ∪ the rest of the members). The owner is the `Owner`-role member (a
/// personal account's sole member; an org's creating member); if none carries the
/// `Owner` role the first member is used as the fan anchor. Reads A1's
/// `list_members` (CONS-A4-2 / PROV-A1-5). An account with no members yields
/// `None` (nothing to fan).
pub async fn account_audience(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<Option<(Uuid, Vec<Uuid>)>, AppError> {
    let repo = AccountRepository::new(pool.clone());
    let members = repo.list_members(account_id).await?;
    if members.is_empty() {
        return Ok(None);
    }
    // Pick the Owner-role member as the anchor (falls back to the first member).
    let owner = members
        .iter()
        .find(|m| m.role == AccountRole::Owner)
        .map(|m| m.user_id)
        .unwrap_or(members[0].user_id);
    let others = members
        .iter()
        .map(|m| m.user_id)
        .filter(|uid| *uid != owner)
        .collect::<Vec<_>>();
    Ok(Some((owner, others)))
}

/// Publish a `SyncEntity::Account` change to every member of `account_id`
/// (owner ∪ members), per-recipient (mirror `publish_artifact`). `actor` carries
/// WHO acted; a personal-account creation is a detached emit (nobody's other device
/// acted specifically) so every member — the owner — refetches. A resolution error
/// simply skips the emit (the 60s sync re-check is the backstop).
pub async fn publish_account(pool: &PgPool, account_id: Uuid, action: SyncAction, actor: Actor) {
    let Ok(Some((owner, others))) = account_audience(pool, account_id).await else {
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::Account,
        action,
        account_id,
        owner,
        &others,
        actor,
    );
}

/// Publish a `SyncEntity::AccountMember` change to every member of `account_id`.
/// The wire id is the `account_id` (the client refetches that account's members).
pub async fn publish_account_member(
    pool: &PgPool,
    account_id: Uuid,
    action: SyncAction,
    actor: Actor,
) {
    let Ok(Some((owner, others))) = account_audience(pool, account_id).await else {
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::AccountMember,
        action,
        account_id,
        owner,
        &others,
        actor,
    );
}

/// Emit the account + owner-membership CREATION frames (the sole Phase-2 mutation —
/// the `ensure_personal_account_for` create branch calls this; the Phase-3 org
/// writes will call the same helpers). Detached actor ⇒ every member refetches.
pub async fn publish_account_created(pool: &PgPool, account_id: Uuid) {
    publish_account(pool, account_id, SyncAction::Create, Actor::detached()).await;
    publish_account_member(pool, account_id, SyncAction::Create, Actor::detached()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Compile-time proof the fan-out targets A1's two declared SyncEntity variants
    // (PROV-A1-7) — a rename of either key would fail to compile here. The audience
    // resolution + delivery is exercised by the integration TEST-10 (SyncProbe).
    #[test]
    fn fans_the_account_entities() {
        let _a = SyncEntity::Account;
        let _m = SyncEntity::AccountMember;
    }
}
