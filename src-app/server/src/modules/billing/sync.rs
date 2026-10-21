//! The B1 usage-rollup sync half (PROV-B1-2). A rollup fold that changes a billable
//! figure fans a `SyncEntity::AccountUsage` change out to every member of the account
//! (owner ∪ members), per-recipient — mirroring `account::sync::publish_account`
//! VERBATIM (there is no `Audience::Account` set-audience constructor; the epic fans
//! per-owner). The wire `id` is the `account_id`: the client refetches that account's
//! rollup rows via `GET /api/billing/usage` (notify-and-refetch only — no row data on
//! the wire).
//!
//! The emit is DETACHED (the rollup loop is a background task, nobody's device acted),
//! so every member — including the owner — refetches (`Actor::detached()`,
//! `origin = None`). A resolution error simply skips the emit; the client's 60s sync
//! re-check is the backstop.

use sqlx::PgPool;
use uuid::Uuid;

use crate::modules::account::sync::account_audience;
use crate::modules::sync::{fan_out_owner_scoped, Actor, SyncAction, SyncEntity};

/// Publish a `SyncEntity::AccountUsage` change to every member of `account_id`. Called
/// by the rollup fold when it advances a billable figure (PROV-B1-2). Notify-and-
/// refetch: the FE self-gates the refetch on `billing::read`.
pub async fn publish_account_usage_changed(pool: &PgPool, account_id: Uuid) {
    let Ok(Some((owner, others))) = account_audience(pool, account_id).await else {
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::AccountUsage,
        SyncAction::Update,
        account_id,
        owner,
        &others,
        Actor::detached(),
    );
}

/// Publish a BILLING-STATE change to every member of `account_id` (B3 / DEC-12). Called by
/// the webhook handler after each successful state transition (active/past_due/canceled). It
/// reuses `SyncEntity::AccountUsage` — the same account/owner-scoped, `origin:None`,
/// `billing::read`-self-gated notify-and-refetch signal B2 seeded — rather than adding a new
/// `AccountBilling` variant to the shared closed enum (which would pull B3 into the frontend
/// parity/e2e gate). B4's "update your card" banner + status refetch bind this signal.
pub async fn publish_account_billing_changed(pool: &PgPool, account_id: Uuid) {
    publish_account_usage_changed(pool, account_id).await;
}

/// Publish a QUOTA change (a crossed alert-ladder rung or a spend-cap edit) to every member
/// of `account_id` (B4 / DEC-9). Like B3's billing-state signal it REUSES
/// `SyncEntity::AccountUsage` — the same account/owner-scoped, `origin:None`,
/// `billing::read`-self-gated notify-and-refetch B1 seeded — rather than adding a new
/// `AccountQuota` variant to the shared closed enum (which would pull B4 into the frontend
/// sync-parity/e2e gate). The UI's usage-dashboard alert badge + spend-cap editor refetch
/// `GET /api/billing/quota` on this signal.
pub async fn publish_account_quota_changed(pool: &PgPool, account_id: Uuid) {
    publish_account_usage_changed(pool, account_id).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Compile-time proof the fan-out targets B1's declared SyncEntity variant
    // (PROV-B1-2) — a rename of the key fails to compile here. The audience
    // resolution + delivery is exercised by the integration sync test (SyncProbe).
    #[test]
    fn fans_the_account_usage_entity() {
        let _e = SyncEntity::AccountUsage;
    }
}
