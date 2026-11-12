//! The provenance project-extension (ITEM-26). Registers into `PROJECT_EXTENSIONS`
//! (order 60) so a project delete cascades its provenance sidecar + project-scoped
//! reference rows AND marks orphaned code-blob refs into the `GcManifest`
//! (collect-in-tx / free-post-commit). `on_project_duplicated` is a no-op (DEC-6).

use async_trait::async_trait;
use linkme::distributed_slice;
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::sync::Arc;
use uuid::Uuid;

use txresbench_core::AppError;

use crate::modules::project::{ProjectExtension, ProjectExtensionEntry, PROJECT_EXTENSIONS};

use super::repository::{collect_code_refs, delete_provenance_for_project};

#[derive(Default)]
pub struct ProvenanceProjectExtension;

impl ProvenanceProjectExtension {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl ProjectExtension for ProvenanceProjectExtension {
    fn name(&self) -> &str {
        "provenance"
    }

    async fn on_project_deleted(
        &self,
        project_id: Uuid,
        tx: &mut Transaction<'_, Sqlite>,
        gc: &mut crate::modules::project::GcManifest,
    ) -> Result<(), AppError> {
        // Mark the project's code-blob refs for the post-commit refcount sweep
        // BEFORE the run rows (which reference them) are deleted.
        let code_refs = collect_code_refs(tx, project_id).await?;
        for hash in &code_refs {
            gc.mark(hash.clone(), "provenance");
        }
        let removed = delete_provenance_for_project(tx, project_id).await?;
        if removed > 0 || !code_refs.is_empty() {
            tracing::debug!(
                project_id = %project_id,
                removed,
                code_refs = code_refs.len(),
                "provenance.project_extension: cleaned up run/reference rows on project delete"
            );
        }
        Ok(())
    }

    async fn on_project_duplicated(
        &self,
        src_project_id: Uuid,
        dst_project_id: Uuid,
        _tx: &mut Transaction<'_, Sqlite>,
    ) -> Result<(), AppError> {
        // MVP no-op behind a flag (DEC-6): deep-copying content-addressed graph
        // storage refs across projects is nontrivial — noted as an SDK gap.
        tracing::debug!(
            src_project_id = %src_project_id,
            dst_project_id = %dst_project_id,
            "provenance duplicate no-op — SDK gap (DEC-6)"
        );
        Ok(())
    }
}

fn create(_pool: SqlitePool) -> Arc<dyn ProjectExtension> {
    Arc::new(ProvenanceProjectExtension::new())
}

#[distributed_slice(PROJECT_EXTENSIONS)]
static PROVENANCE_PROJECT_EXTENSION: ProjectExtensionEntry = ProjectExtensionEntry {
    name: "provenance",
    order: 60,
    factory: create,
};
