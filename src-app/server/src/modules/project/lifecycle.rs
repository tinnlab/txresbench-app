//! Shared project-lifecycle operations that fire extension hooks.
//!
//! These are the SINGLE delete/duplicate chokepoints: every delete path (the
//! owner-facing `delete_project` handler AND the admin-delete endpoint) MUST call
//! `delete_project_with_extensions`, and every duplicate path MUST call
//! `duplicate_project_with_extensions`, so each module's `on_project_deleted` /
//! `on_project_duplicated` hook fires atomically. Do not add a second bare
//! `repo.delete`/`repo.duplicate_in_tx` path — that would silently skip cleanup
//! (or the deep-copy) for the modules that registered it.

use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use super::core::extension::get_global_registry;
use super::gc::{sweep_gc_manifest, GcManifest};
use super::models::Project;
use super::repository::ProjectRepository;

/// Delete a project, firing every extension's `on_project_deleted` cleanup hook in
/// the SAME transaction as the project-row delete (atomic: any hook error rolls the
/// whole delete back). Hooks COLLECT content-addressed blob refs into a
/// [`GcManifest`]; AFTER the commit succeeds, the manifest is handed to
/// [`sweep_gc_manifest`] — the P1-owned post-commit refcount sweep (a no-op stub
/// today). The returned manifest lets a caller/test inspect what was marked.
///
/// The caller is responsible for the ACL check (owner-only) and any
/// sync/notification emission AFTER this returns.
pub async fn delete_project_with_extensions(
    pool: &SqlitePool,
    project_id: Uuid,
) -> Result<GcManifest, AppError> {
    let repo = ProjectRepository::new(pool.clone());
    // SQLite port: `BEGIN IMMEDIATE` — the delete transaction is a WRITE
    // transaction (extension hooks + the row delete); opening it immediate
    // takes the write lock up front instead of on the first mutation (the
    // ITEM-15/17 substitution for the absent row locks).
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(AppError::database_error)?;
    let mut gc = GcManifest::for_project(project_id);

    // Fire extension cleanup BEFORE deleting the project row, so extensions can read
    // their project-scoped rows (e.g. via the project_datasets junction) that an
    // `ON DELETE CASCADE` would otherwise drop out from under them, and mark their
    // blob refs into `gc`.
    if let Some(registry) = get_global_registry() {
        registry.fire_on_project_deleted(project_id, &mut tx, &mut gc).await?;
    }

    repo.delete_in_tx(&mut tx, project_id).await?;
    tx.commit().await.map_err(AppError::database_error)?;

    // Post-commit: the content-address refcount sweep that actually frees blobs
    // (P1-owned; a no-op stub until P1 wires it). Runs on EVERY delete path.
    // BEST-EFFORT by design: the delete already committed, so a sweep failure must
    // NOT fail the request — that would 500 an already-deleted project and skip the
    // caller's sync publish, leaving collaborators stale. P1's real sweep logs +
    // self-heals via its background orphan-reaper.
    if let Err(err) = sweep_gc_manifest(pool, &gc).await {
        tracing::error!(
            project_id = %project_id,
            "project gc: post-commit sweep failed (delete already committed; reaper will retry): {err}"
        );
    }
    Ok(gc)
}

/// Duplicate a project, firing every extension's `on_project_duplicated` deep-copy
/// hook in the SAME transaction as the destination-row create (atomic: any hook
/// error rolls the whole duplicate back). `source` carries the DESTINATION owner
/// (the caller overrides `owner_id` to the acting user) while `source.id` is the
/// SOURCE project id the hook copies FROM. Returns the created duplicate row.
pub async fn duplicate_project_with_extensions(
    pool: &SqlitePool,
    source: &Project,
) -> Result<Project, AppError> {
    let repo = ProjectRepository::new(pool.clone());
    // SQLite port: `BEGIN IMMEDIATE` (see `delete_project_with_extensions`).
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(AppError::database_error)?;
    let dup = repo.duplicate_in_tx(&mut tx, source).await?;
    if let Some(registry) = get_global_registry() {
        registry
            .fire_on_project_duplicated(source.id, dup.id, &mut tx)
            .await?;
    }
    tx.commit().await.map_err(AppError::database_error)?;
    Ok(dup)
}
