//! Persistence for the provenance project-extension cascade (ITEM-26). sqlx
//! COMPILE-TIME macros live on `ProvenanceRepository`; these are thin tx wrappers.

use sqlx::{Sqlite, Transaction};
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::provenance::repository::ProvenanceRepository;

/// Distinct code-blob refs the project's runs point at (collected BEFORE delete so
/// the delete-time `GcManifest` can mark them for post-commit refcount GC).
pub async fn collect_code_refs(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: Uuid,
) -> Result<Vec<String>, AppError> {
    ProvenanceRepository::code_sha_refs_for_project_in_tx(tx, project_id).await
}

/// Delete a project's provenance rows (run sidecar + project-scoped reference
/// resources) inside the caller's tx. The global (`project_id IS NULL`) references
/// are never touched. Returns the number of run rows removed.
pub async fn delete_provenance_for_project(
    tx: &mut Transaction<'_, Sqlite>,
    project_id: Uuid,
) -> Result<u64, AppError> {
    // Re-run verification records (ITEM-16) — no orphans on a project delete.
    ProvenanceRepository::delete_verifications_for_project_in_tx(tx, project_id).await?;
    ProvenanceRepository::delete_references_for_project_in_tx(tx, project_id).await?;
    ProvenanceRepository::delete_runs_for_project_in_tx(tx, project_id).await
}
