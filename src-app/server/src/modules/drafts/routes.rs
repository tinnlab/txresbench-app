//! Draft HTTP routes (aide-documented → OpenAPI). `.id("Draft.*")` drives
//! `ApiClient.Draft.*` + the `Permissions`/`ApiEndpoints` codegen. Re-run
//! `just openapi-regen` after any change here.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;

use crate::modules::permissions::with_permission;

use super::handlers::*;
use super::models::*;
use super::permissions::*;

pub fn draft_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/drafts",
            get_with(list_drafts, list_docs).post_with(create_draft, create_docs),
        )
        .api_route(
            "/drafts/{id}",
            get_with(get_draft, get_docs)
                .put_with(update_draft, update_docs)
                .delete_with(delete_draft, delete_docs),
        )
        .api_route("/drafts/{id}/freeze", post_with(freeze_draft, freeze_docs))
        .api_route(
            "/drafts/artifacts/{artifact_id}/lineage",
            get_with(get_artifact_lineage, lineage_docs),
        )
}

fn list_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(DraftsUse,)>(op)
        .description("List the drafts in a project, optionally filtered by opaque `kind`.")
        .id("Draft.list")
        .tag("drafts")
        .response::<200, Json<DraftListResponse>>()
}
fn create_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(DraftsUse,)>(op)
        .description("Create a draftable entity in a project (requires EDIT on it).")
        .id("Draft.create")
        .tag("drafts")
        .response::<201, Json<Draft>>()
}
fn get_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(DraftsUse,)>(op)
        .description("Get one draft by id (404 if the project is invisible to you).")
        .id("Draft.get")
        .tag("drafts")
        .response::<200, Json<Draft>>()
}
fn update_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(DraftsUse,)>(op)
        .description(
            "Replace a draft's `data` (LWW). Editing a frozen draft flips it back to open.",
        )
        .id("Draft.update")
        .tag("drafts")
        .response::<200, Json<Draft>>()
}
fn delete_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(DraftsUse,)>(op)
        .description("Delete a draft (requires EDIT on its project).")
        .id("Draft.delete")
        .tag("drafts")
        .response::<204, ()>()
}
fn lineage_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(DraftsUse,)>(op)
        .description(
            "The frozen-artifact VERSION LINEAGE for a draftable artifact (INV-7): the chain \
             walked from the requested artifact up its `parent_artifact_id` links, newest-first. \
             Owner-scoped (a foreign project's chain yields 404). An artifact that never froze \
             through a draft yields an empty chain.",
        )
        .id("Draft.lineage")
        .tag("drafts")
        .response::<200, Json<DraftLineageResponse>>()
}
fn freeze_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(DraftsUse,)>(op)
        .description(
            "Freeze a draft: ENQUEUE its package's `freeze` producer over `data` as a \
             background job that ingests the output into an immutable content-addressed \
             artifact and stamps `frozen_artifact_id`. Accepted (202) with the current \
             (open) draft + the `freeze_job_id` to poll; the draft flips to `frozen` when \
             that job completes (refetch on the `Draft/Update` sync, or poll). Idempotent \
             (200, no job) for an unchanged frozen draft. A 422 is returned synchronously \
             when the draft's `kind` names no freeze producer.",
        )
        .id("Draft.freeze")
        .tag("drafts")
        .response::<202, Json<FreezeResponse>>()
        .response::<200, Json<FreezeResponse>>()
        .response_with::<422, (), _>(|r| {
            r.description("The draft's `kind` declares no freeze producer")
        })
}
