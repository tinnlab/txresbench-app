//! Persistence for the dataset project-extension. sqlx COMPILE-TIME macros (the
//! canonical pattern; see `dataset/repository.rs`). The project↔dataset link lives
//! in the project-owned `project_datasets` junction — now a composite-PK M:N join
//! (a dataset belongs to many projects; both FKs `ON DELETE CASCADE`).

use sqlx::{Sqlite, Transaction};
use uuid::Uuid;
use txresbench_core::AppError;

use super::models::ProjectDatasetSummary;

/// Re-link (NOT copy) every dataset attached to `src_project_id` onto
/// `dst_project_id`, inside the caller's tx. Datasets are owner-scoped, shareable,
/// and M:N to projects (a dataset belongs to many projects), so a project duplicate
/// SHARES the same dataset rows rather than deep-copying them. Returns the number
/// of links added.
pub async fn relink_datasets_to_project(
    tx: &mut Transaction<'_, Sqlite>,
    src_project_id: Uuid,
    dst_project_id: Uuid,
) -> Result<u64, AppError> {
    let res = sqlx::query!(
        r#"INSERT INTO project_datasets (project_id, dataset_id)
           SELECT $2, dataset_id FROM project_datasets WHERE project_id = $1
           ON CONFLICT (project_id, dataset_id) DO NOTHING"#,
        src_project_id,
        dst_project_id,
    )
    .execute(&mut **tx)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}

/// Number of datasets attached to a project (for the summary tag).
pub async fn summary_for_project(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
) -> Result<ProjectDatasetSummary, AppError> {
    let row = sqlx::query!(
        r#"SELECT count(*) as "dataset_count!"
           FROM project_datasets sd WHERE sd.project_id = $1"#,
        project_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(ProjectDatasetSummary {
        dataset_count: row.dataset_count,
    })
}
