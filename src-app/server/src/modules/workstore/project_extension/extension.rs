//! The workstore project-extension (ITEM-12) — registers into `PROJECT_EXTENSIONS`
//! (order 50, after dataset's 40) so a project delete/duplicate fires the workstore
//! cascade atomically via the merged `delete_project_with_extensions` chokepoint.
//!
//! `on_project_deleted` deletes the project's catalog rows in-tx (the axis rows +
//! catalog rows also carry `ON DELETE CASCADE`, so this is explicit intent +
//! gives a count); the now-unreferenced blobs are reclaimed post-commit by the
//! standing GC union-sweep (ITEM-14). **The delete-time blob-ref COLLECT into
//! P10's `GcManifest` is the ONE piece deferred to P10** — correctness holds
//! without it because the standing sweep re-derives orphans from live tables.
//! `on_project_duplicated` deep-copies catalog rows (re-referencing the same
//! immutable blobs by key — DEC-14) + the axis rows.

use async_trait::async_trait;
use linkme::distributed_slice;
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::sync::Arc;
use uuid::Uuid;

use ziee_core::AppError;

use crate::modules::project::{
    GcManifest, ProjectExtension, ProjectExtensionEntry, ProjectSummaryTag, PROJECT_EXTENSIONS,
};

use super::super::catalog::repository::CatalogRepository;
use super::super::object_store::{decode_manifest, ContentKey};

pub struct WorkstoreProjectExtension {
    pool: SqlitePool,
}

impl WorkstoreProjectExtension {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ProjectExtension for WorkstoreProjectExtension {
    fn name(&self) -> &str {
        "workstore"
    }

    async fn on_project_deleted(
        &self,
        project_id: Uuid,
        tx: &mut Transaction<'_, Sqlite>,
        gc: &mut GcManifest,
    ) -> Result<(), AppError> {
        // Collect the project's blob refs into the GcManifest BEFORE deleting the
        // rows (ITEM-14 collect). The post-commit refcount sweep
        // (`sweep_gc_manifest` → `workstore::gc::sweep_marked_manifest`) frees a
        // marked blob only when its hash has no surviving storage-ref (shared
        // blobs across projects survive — the dedup guard).
        let refs = CatalogRepository::object_keys_for_project_in_tx(tx, project_id).await?;
        let store = crate::modules::workstore::get_object_store();
        for r in &refs {
            gc.mark(r.object_key.clone(), "catalog");
            if r.is_multifile {
                // A multi-file artifact's members are marked too (resolved from its
                // manifest blob, which is still present pre-commit).
                if let Ok(bytes) = store.get(&ContentKey::parse(&r.object_key)).await {
                    if let Ok(map) = decode_manifest(&bytes) {
                        for member in map.into_values() {
                            gc.mark(member, "catalog");
                        }
                    }
                }
            }
        }

        let removed = CatalogRepository::delete_for_project_in_tx(tx, project_id).await?;
        if removed > 0 {
            tracing::debug!(project_id = %project_id, removed, marked = refs.len(), "workstore.project_extension: deleted catalog rows + marked blobs on project delete");
        }
        Ok(())
    }

    async fn on_project_duplicated(
        &self,
        src_project_id: Uuid,
        dst_project_id: Uuid,
        tx: &mut Transaction<'_, Sqlite>,
    ) -> Result<(), AppError> {
        // Re-reference the same immutable content-addressed blobs by key (no byte
        // copy — DEC-14). That is the WHOLE duplicate now: ITEM-8 removed the second
        // step (a `workstore_axis_entry` deep-copy), because under INV-3 an axis IS
        // its key artifact, so copying the artifact rows copies the axes with them.
        let copied =
            CatalogRepository::copy_to_project_in_tx(tx, src_project_id, dst_project_id).await?;
        if copied > 0 {
            tracing::debug!(src = %src_project_id, dst = %dst_project_id, copied, "workstore.project_extension: deep-copied catalog into duplicate");
        }
        Ok(())
    }

    async fn collect_summary(
        &self,
        project_id: Uuid,
        _user_id: Uuid,
    ) -> Result<Vec<ProjectSummaryTag>, AppError> {
        let repo = CatalogRepository::new(self.pool.clone());
        let (count, bytes) = repo.footprint(project_id).await?;
        if count == 0 {
            return Ok(Vec::new());
        }
        let label = if count == 1 {
            format!("1 result / {}", human_bytes(bytes))
        } else {
            format!("{count} results / {}", human_bytes(bytes))
        };
        Ok(vec![ProjectSummaryTag {
            id: "workstore",
            label,
        }])
    }
}

fn human_bytes(bytes: i64) -> String {
    let b = bytes.max(0) as f64;
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{} {}", bytes.max(0), UNITS[u])
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

fn create(pool: SqlitePool) -> Arc<dyn ProjectExtension> {
    Arc::new(WorkstoreProjectExtension::new(pool))
}

#[distributed_slice(PROJECT_EXTENSIONS)]
static WORKSTORE_PROJECT_EXTENSION: ProjectExtensionEntry = ProjectExtensionEntry {
    name: "workstore",
    order: 50,
    factory: create,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_formats_units() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1536), "1.5 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
    }
}
