//! HTTP handler for the dataset project-extension's owned route.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::{Extension, Json};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::{ApiResult, AppError};

use crate::modules::permissions::RequirePermissions;
use crate::modules::project::{ProjectsUse, ProjectRepository};

use super::models::ProjectDatasetSummary;
use super::repository::summary_for_project;

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// `GET /projects/{id}/dataset-summary` — aggregate stats for a project's datasets.
/// Gated `projects::use`; the per-project ACL (owner ∪ accepted-share) is enforced
/// via the project repository (a foreign/nonexistent project reads as `None` → 404).
pub async fn dataset_summary(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProjectDatasetSummary>> {
    let repo = ProjectRepository::new(pool.clone());
    // ACL: only a user who can see the project gets its summary.
    if repo
        .effective_permission(id, auth.user.id)
        .await
        .map_err(e)?
        .is_none()
    {
        return Err(e(AppError::not_found("Project")));
    }
    let summary = summary_for_project(&pool, id).await.map_err(e)?;
    Ok((StatusCode::OK, Json(summary)))
}
