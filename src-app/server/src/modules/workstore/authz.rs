//! Project-scoped authorization for the data plane (ITEM-7/8/9).
//!
//! Mirrors `project/handlers.rs::resolve`: the acting user's `projects::use` RBAC
//! capability is checked by `RequirePermissions<(ProjectsUse,)>` at the route; the
//! per-project ROLE is resolved here through the ALREADY-MERGED
//! `ProjectRepository::effective_permission` — Viewer+ read, Editor+ write, a
//! foreign project → 404 (invisible). DEC-6: reuse the merged resolver (NOT the
//! unmerged `ProjectScope` extractor); a later refactor can point this at P10's
//! `ProjectScope` when it lands.

use axum::http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use super::catalog::models::Artifact;
use crate::modules::project::ProjectRepository;

/// Require the acting user to have ANY role on the project (Viewer+). A foreign /
/// nonexistent project is a 404 (matches the owner-scoped 404 idiom — no leak).
pub async fn require_project_read(
    pool: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<(), (StatusCode, AppError)> {
    let repo = ProjectRepository::new(pool.clone());
    match repo
        .effective_permission(project_id, user_id)
        .await
        .map_err(|e| e.to_api_error())?
    {
        Some(_) => Ok(()),
        None => Err(AppError::not_found("Project").to_api_error()),
    }
}

/// Require the acting user to be able to EDIT the project (Owner/Editor). A Viewer
/// is a 403; a foreign project is a 404. This is the server-authoritative write
/// boundary (the FE gate is UX-only).
pub async fn require_project_edit(
    pool: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<(), (StatusCode, AppError)> {
    let repo = ProjectRepository::new(pool.clone());
    match repo
        .effective_permission(project_id, user_id)
        .await
        .map_err(|e| e.to_api_error())?
    {
        Some(perm) if perm.can_edit() => Ok(()),
        Some(_) => Err(AppError::forbidden(
            "PROJECT_READ_ONLY",
            "You have read-only access to this project",
        )
        .to_api_error()),
        None => Err(AppError::not_found("Project").to_api_error()),
    }
}

/// Require read access to a DATASET (owner ∪ sharees), the dataset-scope arm of
/// artifact authz (ITEM-23). Resolves the acting user's group memberships INLINE
/// (via `user_groups`) so no group ids need threading from the handler. A foreign /
/// nonexistent dataset is invisible → 404 (no existence oracle).
///
/// ## The `g.is_active` clause is not decoration
///
/// This predicate is a hand-copy of `DatasetRepository::is_visible_to`, and it had
/// already drifted from it. Every caller on the dataset side passes group ids
/// filtered by `permissions::active_group_ids`, i.e. ACTIVE groups only; this copy
/// joined `user_groups` alone, so a share granted to a group an administrator had
/// since DISABLED still let its members read the dataset's artifacts through the
/// workstore, after the dataset's own endpoints had stopped honouring it.
/// Deactivating a group is a revocation, and it has to mean the same thing at every
/// gate. The clause is spelled out rather than delegated because this arm must not
/// take a `group_ids` parameter (its callers do not have one); the drift risk is
/// answered instead by `require_dataset_read_matches_is_visible_to_for_a_removed_owner`
/// in the integration suite (`tests/account/removal_revokes_test.rs`), which asserts
/// the two predicates agree rather than trusting that a reader notices two SQL
/// literals diverging.
///
/// NOTE (H-1, #147): this comment previously named a test
/// `require_dataset_read_matches_is_visible_to` that **did not exist anywhere in the
/// tree** — the claim of a lock-step guard was false, and the two literals were in
/// fact free to diverge. The test now exists and covers both the removed-owner
/// condition and the co-member/account-owner principals.
pub async fn require_dataset_read(
    pool: &PgPool,
    dataset_id: Uuid,
    user_id: Uuid,
) -> Result<(), (StatusCode, AppError)> {
    let visible = sqlx::query_scalar!(
        // A3 (ITEM-4): kept in lock-step with `DatasetRepository::is_visible_to`
        // (asserted by TEST-11, see the doc comment above) — the SAME
        // account-membership union is added: any member of the dataset's account is
        // visible, PRESERVING the owner ∪ active-group-share unions.
        //
        // H-1 (#147, disposition (c)): the standalone `d.owner_id = $2` disjunct is
        // GONE, exactly as in `is_visible_to` — the two must stay in lock-step, and
        // TEST-11 now asserts they agree on precisely this condition. Conjoined with
        // current membership the owner branch is a strict subset of the role-agnostic
        // membership union below, so it is deleted rather than kept as a disjunct
        // that can never be the reason a row matches. A member removed from the
        // dataset's account therefore loses artifact/workstore read on the datasets
        // they created there; every current member, and every personal-account user,
        // is admitted exactly as before.
        r#"SELECT EXISTS(
             SELECT 1 FROM datasets d WHERE d.id = $1 AND (
               d.account_id IN (SELECT am.account_id FROM account_members am
                                 WHERE am.user_id = $2)
               OR EXISTS (
                 SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id AND (
                      (ds.principal_type = 'user'  AND ds.principal_id = $2)
                   OR (ds.principal_type = 'group' AND ds.principal_id IN (
                         SELECT ug.group_id FROM user_groups ug
                           JOIN groups g ON g.id = ug.group_id
                          WHERE ug.user_id = $2 AND g.is_active)) )
               )
             )) as "e!""#,
        dataset_id,
        user_id,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| AppError::database_error(e).to_api_error())?;
    if visible {
        Ok(())
    } else {
        Err(AppError::not_found("Dataset").to_api_error())
    }
}

/// The tenancy scope an artifact resolves to (ITEM-23): a project (workbench), a
/// dataset (owner processing), or none (invalid for a live row). A project scope
/// takes precedence if — defensively — both columns were somehow set. Pure, so
/// the gate decision is unit-testable without a DB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactScope {
    Project(Uuid),
    Dataset(Uuid),
    None,
}

/// Resolve an artifact's `(project_id, dataset_id)` to its [`ArtifactScope`] (ITEM-23).
pub fn artifact_scope(project_id: Option<Uuid>, dataset_id: Option<Uuid>) -> ArtifactScope {
    match (project_id, dataset_id) {
        (Some(s), _) => ArtifactScope::Project(s),
        (None, Some(d)) => ArtifactScope::Dataset(d),
        (None, None) => ArtifactScope::None,
    }
}

/// Require read access to an artifact by its OWN tenancy scope (ITEM-23). An
/// artifact is scoped to a project (workbench) OR a dataset (owner processing); the
/// gate dispatches on whichever scope is set — project role (Viewer+) for a
/// project-scoped artifact, dataset visibility (owner ∪ sharees) for a
/// dataset-scoped one. A scope-less artifact (neither set — should never exist
/// for a live row) is treated as invisible → 404. Used by the by-artifact-id
/// data-plane routes (the artifact carries its scope).
pub async fn require_artifact_read(
    pool: &PgPool,
    artifact: &Artifact,
    user_id: Uuid,
) -> Result<(), (StatusCode, AppError)> {
    match artifact_scope(artifact.project_id, artifact.dataset_id) {
        ArtifactScope::Project(project_id) => require_project_read(pool, project_id, user_id).await,
        ArtifactScope::Dataset(dataset_id) => require_dataset_read(pool, dataset_id, user_id).await,
        ArtifactScope::None => Err(AppError::not_found("Artifact").to_api_error()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-43 (unit): the artifact-scope gate resolves to project OR dataset OR
    // none — the ITEM-23 decision that `require_artifact_read` dispatches on.
    #[test]
    fn artifact_scope_resolves_project_or_dataset_or_none() {
        let s = Uuid::new_v4();
        let d = Uuid::new_v4();
        // Project-scoped (workbench) → the project arm.
        assert_eq!(artifact_scope(Some(s), None), ArtifactScope::Project(s));
        // Dataset-scoped (owner processing, project_id NULL) → the dataset arm.
        assert_eq!(artifact_scope(None, Some(d)), ArtifactScope::Dataset(d));
        // Neither → invalid for a live row → None (the 404 arm).
        assert_eq!(artifact_scope(None, None), ArtifactScope::None);
        // Defensive: if both were somehow set, project wins (never a dataset leak
        // for a project-scoped row).
        assert_eq!(artifact_scope(Some(s), Some(d)), ArtifactScope::Project(s));
    }
}
