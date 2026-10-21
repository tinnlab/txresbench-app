//! Project-scoped `SyncEntity::Draft` emit (ITEM-6). Mirrors
//! `workstore::sync::publish_artifact`: there is NO `Audience::project` constructor,
//! so the project audience — the account's CURRENT membership ∪ accepted shares, since
//! #168 — is resolved via P10's `project_audience` and fanned per-recipient through
//! `fan_out_owner_scoped`.
//! Notify-and-refetch only — the client refetches via the `drafts::use`-gated
//! `GET /api/drafts`.

use sqlx::PgPool;
use uuid::Uuid;

use crate::modules::project::scope::project_audience;
use crate::modules::project::ProjectRepository;
use crate::modules::sync::{fan_out_owner_scoped, Actor, SyncAction, SyncEntity};

/// Publish a `Draft` change to the project audience (current account members ∪
/// accepted shares — #168; NOT `projects.owner_id`, which a removal does not touch).
/// `actor` carries WHO acted + from which connection ([`Actor::detached`] for a
/// background emit such as an auto-freeze completion — origin None). A resolution
/// error simply skips the emit (the 60s sync re-check is the backstop).
pub async fn publish_draft(
    pool: &PgPool,
    project_id: Uuid,
    action: SyncAction,
    draft_id: Uuid,
    actor: Actor,
) {
    let repo = ProjectRepository::new(pool.clone());
    let Ok(Some((owner, recipients))) = project_audience(&repo, project_id).await else {
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::Draft,
        action,
        draft_id,
        owner,
        &recipients,
        actor,
    );
}
