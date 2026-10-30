//! The DATASET's sync audience, resolved from the dataset — for detached emits.
//!
//! ## Why this exists rather than an `owner_id` parameter
//!
//! Every `SyncEntity::Dataset` frame belongs to everyone who may currently SEE the
//! dataset — since #168, the CURRENT members of its account ∪ its sharees.
//! The user-originated handlers get that right because `routes.rs::publish_to_all`
//! names `owner_id` and `actor` as separate parameters, so passing the actor where
//! the owner belongs is at least VISIBLE at the call site.
//!
//! The DETACHED emits had no such protection, and two of them were wrong. A job's
//! terminal transition and its metadata write both published to
//! `Audience::owner(job.owner_id)` — the JOB's owner, which is simply a different
//! fact from the DATASET's owner. They coincide whenever a user processes their own
//! dataset, i.e. in every single-user test; they diverge the moment an `edit`-role
//! sharee calls `POST /datasets/{id}/process`, which `require_can_edit` explicitly
//! admits. On that path the dataset's OWNER was never told their dataset finished
//! processing, and no sharee was told either — the badge on their open dataset stayed
//! "processing" until a manual reload.
//!
//! So this helper accepts **no owner argument at all**. There is no parameter to
//! pass the wrong id into: the audience is derived from the only id that can be
//! correct, the dataset's own. That is the same move `sync::Actor` made for `origin`
//! — make the confusion impossible to express rather than something every author
//! must remember.
//!
//! ## Why sharees are in the audience
//!
//! A sharee is ALREADY authorized to read this dataset and is very likely rendering
//! it. Withholding the frame does not withhold information — they can see the new
//! status by pressing reload — it only guarantees their view is silently stale, which
//! is the worst of the three options. And the wire is notify-and-refetch: the frame is
//! `{entity: dataset, action: update, id}` and carries no job, no actor and no row
//! data, so "someone else's job touched this dataset" is not disclosed by it. The
//! sharee learns only that the dataset they can already read has changed, and refetches
//! it through the same permission-checked endpoint as always.
//!
//! `dataset/integration.rs` already resolved this audience correctly on an ADJACENT
//! leg of the very same job completion, with its own hand-rolled copy of the fan-out
//! loop — so two sibling paths in one job's finalize disagreed about who to tell.
//! All three now share this one.

use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::repository::DatasetRepository;
use crate::modules::sync::{fan_out_owner_scoped, Actor, SyncAction, SyncEntity};

/// A dataset's sync audience as `Some((anchor, the-rest))` — the exact shape
/// `fan_out_owner_scoped` consumes, and the dataset twin of
/// `project::scope::project_audience`. `None` ⇒ nobody may see it.
///
/// ## Why this is public, and why the workstore calls it
///
/// "Who can see this dataset" was written out FOUR times: this module (via the
/// repository), `workstore::sync::publish_artifact_for_dataset` (inline SQL),
/// `workstore::authz::require_dataset_read` (inline SQL), and the repository's own
/// `access`/`is_visible_to`. The workstore's two copies each carried the same
/// justification — "self-contained, no cross-module coupling to the dataset module".
///
/// That reason does not survive being looked at. `workstore::sync`'s FIRST function
/// imports `project::scope::project_audience` and `project::ProjectRepository` to
/// answer the identical question for a project, in the same file, eight lines up. So
/// the module was never coupling-free; it had a project dependency and a
/// dataset EXCEPTION, and the exception cost real correctness: the inline copies
/// resolve group shares through `user_groups` alone, while every gate on the dataset
/// side filters to ACTIVE groups — so a disabled group already granted more through
/// the workstore's copy than through the dataset's own.
///
/// The exit condition for the deleted comment was "it will drift the moment dataset
/// sharing gains a principal type". That test was already failed by a predicate that
/// existed at the time, which is the argument for converging now rather than at the
/// next schema change: a duplicated authorization rule does not announce its drift.
/// ## #168 — derived from CURRENT membership, not from `datasets.owner_id`
///
/// The dataset half of the same defect, named in #168's comment: this was
/// `(owner_of(id), sharee_user_ids(id))`, i.e. an audience anchored on a column a
/// removal does not touch. A member removed from the organization stopped being able
/// to open the dataset they created there and kept being told, live, every time it
/// changed — an activity oracle over the account's data.
///
/// The audience is now the dataset's account's CURRENT membership ∪ its user- and
/// ACTIVE-group sharees: exactly the set `DatasetRepository::is_visible_to` admits, so
/// every added recipient could already read the row and every removed one had already
/// lost the ability to. `None` ⇒ nobody may see it; the callers skip the emit through
/// the arm they already had for a resolution error.
///
/// `owner_of` is deliberately left bare — it is a factual lookup used elsewhere for
/// non-authorization purposes, and hiding a membership rule inside it would be the
/// same mistake one layer down. The rule lives here, at the audience.
pub async fn dataset_audience(
    pool: &SqlitePool,
    dataset_id: Uuid,
) -> Result<Option<(Uuid, Vec<Uuid>)>, AppError> {
    let repo = DatasetRepository::new(pool.clone());
    let owner = repo
        .owner_of(dataset_id)
        .await?
        .ok_or_else(|| AppError::not_found("Dataset"))?;
    let audience = repo.audience_user_ids(dataset_id).await?;
    Ok(crate::modules::sync::owner_scoped_audience(owner, audience))
}

/// Publish a `Dataset` change to the dataset's own audience (current account members
/// ∪ user-sharees ∪ members of shared ACTIVE groups — #168).
///
/// `actor` carries WHO acted and from which connection — [`Actor::detached`] for the
/// background emits this module exists for (a job reaching a terminal state, a
/// metadata harvest, a supporting-file integrate), where nobody acted and therefore
/// nothing is suppressed.
///
/// A resolution failure skips the emit rather than failing the caller: these are all
/// post-commit announcements of work that already happened, and the client's 60s sync
/// re-check / next reconnect is the backstop.
pub async fn publish_dataset_change(
    pool: &SqlitePool,
    dataset_id: Uuid,
    action: SyncAction,
    actor: Actor,
) {
    let Ok(Some((owner, sharees))) = dataset_audience(pool, dataset_id).await else {
        tracing::warn!(
            %dataset_id,
            "dataset sync emit: audience unresolved or empty; connected devices will \
             not live-refresh this dataset until their next refetch"
        );
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::Dataset,
        action,
        dataset_id,
        owner,
        &sharees,
        actor,
    );
}
