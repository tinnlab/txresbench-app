//! Project-scoped `SyncEntity::Artifact` emit (ITEM-13). Consumes P10's
//! `project_audience` seam (current account members ∪ accepted shares, since #168) — there is NO `Audience::project`
//! constructor (DEC-15), so we fan per-recipient via `Audience::owner`, exactly
//! like `project/handlers.rs::publish_project_to_all`. Notify-and-refetch only.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::modules::dataset::sync::dataset_audience;
use crate::modules::project::scope::project_audience;
use crate::modules::project::ProjectRepository;
use crate::modules::sync::{fan_out_owner_scoped, Actor, SyncAction, SyncEntity};

/// Publish an `Artifact` change to the project audience (current account members ∪
/// accepted shares, via P10's `project_audience` — #168). `actor` carries WHO acted and from which
/// connection ([`Actor::detached`] for background emits such as ingest completion);
/// self-echo is suppressed for that actor whether or not they are the project owner
/// — `delete_artifact` is gated on project EDIT, so an editor recipient reaches it.
/// An empty recipient list (desktop single-user) is a valid fan-to-self.
pub async fn publish_artifact(
    pool: &SqlitePool,
    project_id: Uuid,
    action: SyncAction,
    artifact_id: Uuid,
    actor: Actor,
) {
    let repo = ProjectRepository::new(pool.clone());
    let Ok(Some((owner, recipients))) = project_audience(&repo, project_id).await else {
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::Artifact,
        action,
        artifact_id,
        owner,
        &recipients,
        actor,
    );
}

/// Publish an `Artifact` change to a DATASET's audience (current account members ∪
/// user-sharees ∪ ACTIVE-group sharees, since #168) for a dataset-scoped
/// (project-less) artifact (ITEM-23).
///
/// Symmetric with [`publish_artifact`] above in BOTH halves now: each resolves its
/// audience through the module that owns the sharing rule — `project::scope::
/// project_audience` for a project, `dataset::sync::dataset_audience` for a dataset —
/// and both hand the result to the one fan-out. This function used to inline its own
/// `datasets`/`dataset_shares`/`user_groups` SQL instead, a fourth copy of "who can
/// see this dataset"; see `dataset::sync::dataset_audience` for why the
/// no-cross-module-coupling reason it cited did not hold in a file that already
/// imports the project module for the identical purpose.
///
/// Notify-and-refetch only; a resolution error simply skips the emit (the 60s sync
/// re-check is the backstop).
///
/// ## UNCOVERED: the delivery leg (surviving mutant M9)
///
/// The AUDIENCE this consumes is pinned — `dataset_audience` has a direct test
/// (`dataset::sharee_fanout_test::dataset_audience_resolves_owner_user_share_and_group_share`)
/// and dropping its sharees fails that test. What is NOT pinned is this function's
/// own hand-off: narrowing `recipients` to an empty vec HERE, so the artifact frame
/// reaches only the owner and no sharee, passes every test in the suite.
///
/// Both call sites (`ingest::…` on catalog insert, `conformance::…` on a status flip)
/// are reached only from an in-SERVER dataset-scoped run at finalize, and `TestServer`
/// runs the server as a separate PROCESS — a `publish` invoked from a test process
/// lands in the test process's own sync registry and can never reach an SSE probe.
/// (An attempt to test it that way looked green for the wrong reason: the frame the
/// probe saw was the scheduler's terminal-transition emit for the fixture's own job.)
///
/// EXIT CONDITION: a dataset-scoped converter run driven to finalize inside the server
/// — the sandbox-rootfs tier — with a SHAREE's `SyncProbe` asserting `artifact/create`.
/// Until then this hand-off is held by review, not by a test.
pub async fn publish_artifact_for_dataset(
    pool: &SqlitePool,
    dataset_id: Uuid,
    action: SyncAction,
    artifact_id: Uuid,
    actor: Actor,
) {
    let Ok(Some((owner, recipients))) = dataset_audience(pool, dataset_id).await else {
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::Artifact,
        action,
        artifact_id,
        owner,
        &recipients,
        actor,
    );
}
