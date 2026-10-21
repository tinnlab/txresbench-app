//! The dataset project-extension — the FIRST consumer of the project-extension seam,
//! proving it end-to-end: it owns a route, DETACHES (not deletes) datasets on project
//! delete, RE-LINKS datasets (M:N share, not a deep copy) on project duplicate, and
//! contributes a summary tag. A future analysis module
//! (samples/clustering/…) drops in the same way with ZERO project-core changes.

use aide::axum::ApiRouter;
use async_trait::async_trait;
use linkme::distributed_slice;
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::Arc;
use uuid::Uuid;

use ziee_core::AppError;

use crate::modules::project::{
    ProjectExtension, ProjectExtensionEntry, ProjectSummaryTag, PROJECT_EXTENSIONS,
};

use super::repository::{relink_datasets_to_project, summary_for_project};
use super::routes::dataset_project_routes;

pub struct DatasetProjectExtension {
    pool: PgPool,
}

impl DatasetProjectExtension {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ProjectExtension for DatasetProjectExtension {
    fn name(&self) -> &str {
        "dataset"
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(dataset_project_routes())
    }

    async fn on_project_deleted(
        &self,
        _project_id: Uuid,
        _tx: &mut Transaction<'_, Postgres>,
        _gc: &mut crate::modules::project::GcManifest,
    ) -> Result<(), AppError> {
        // Datasets are owner-scoped, shareable, and M:N to projects (they may
        // belong to OTHER projects). Deleting a project must NOT delete its
        // datasets — only DETACH them. The `project_datasets.project_id ... ON DELETE
        // CASCADE` FK already removes this project's junction rows when the project
        // row is deleted, so there is nothing to do here (the datasets survive in
        // the owner's library). No blob GC either — the owner still owns the files.
        Ok(())
    }

    async fn on_project_duplicated(
        &self,
        src_project_id: Uuid,
        dst_project_id: Uuid,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<(), AppError> {
        // M:N: a project duplicate SHARES (re-links) the same dataset rows, not a
        // deep copy — one dataset legitimately belongs to both projects.
        let linked = relink_datasets_to_project(tx, src_project_id, dst_project_id).await?;
        if linked > 0 {
            tracing::debug!(
                src_project_id = %src_project_id,
                dst_project_id = %dst_project_id,
                linked,
                "dataset.project_extension: re-linked datasets into duplicate (M:N)"
            );
        }
        Ok(())
    }

    async fn collect_summary(
        &self,
        project_id: Uuid,
        _user_id: Uuid,
    ) -> Result<Vec<ProjectSummaryTag>, AppError> {
        let summary = summary_for_project(&self.pool, project_id).await?;
        if summary.dataset_count == 0 {
            return Ok(Vec::new());
        }
        let label = if summary.dataset_count == 1 {
            "1 dataset".to_string()
        } else {
            format!("{} datasets", summary.dataset_count)
        };
        Ok(vec![ProjectSummaryTag { id: "dataset", label }])
    }
}

fn create(pool: PgPool) -> Arc<dyn ProjectExtension> {
    Arc::new(DatasetProjectExtension::new(pool))
}

#[distributed_slice(PROJECT_EXTENSIONS)]
static DATASET_PROJECT_EXTENSION: ProjectExtensionEntry = ProjectExtensionEntry {
    name: "dataset",
    order: 40,
    factory: create,
};
