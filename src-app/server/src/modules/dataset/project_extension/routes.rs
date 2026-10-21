//! Routes owned by the dataset project-extension (mounted via the project module's
//! `register_routes` fold — proves the extension route seam). `.id("Project.*")`
//! drives `ApiClient.Project.*`; re-run `just openapi-regen` after any change.

use aide::axum::routing::get_with;
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;

use crate::modules::permissions::with_permission;
use crate::modules::project::ProjectsUse;

use super::handlers::dataset_summary;
use super::models::ProjectDatasetSummary;

pub fn dataset_project_routes() -> ApiRouter {
    ApiRouter::new().api_route(
        "/projects/{id}/dataset-summary",
        get_with(dataset_summary, dataset_summary_docs),
    )
}

fn dataset_summary_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.datasetSummary")
        .tag("project")
        .response::<200, Json<ProjectDatasetSummary>>()
}
