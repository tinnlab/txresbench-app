//! Project HTTP routes (aide-documented so they appear in the OpenAPI spec).
//! `.id("Project.*")` drives `ApiClient.Project.*` + the `Permissions`/`ApiEndpoints`
//! codegen. Re-run `just openapi-regen` after any change here.

use aide::axum::routing::{delete_with, get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;

use crate::modules::permissions::with_permission;

use super::admin_handlers::*;
use super::handlers::*;
use super::models::*;
use super::permissions::*;

pub fn project_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/projects",
            get_with(list_projects, list_docs).post_with(create_project, create_docs),
        )
        .api_route(
            "/projects/{id}",
            get_with(get_project, get_docs)
                .post_with(update_project, update_docs)
                .delete_with(delete_project, delete_docs),
        )
        .api_route(
            "/projects/{id}/duplicate",
            post_with(duplicate_project, duplicate_docs),
        )
        .api_route(
            "/projects/{id}/access",
            get_with(get_project_access, access_docs),
        )
        .api_route(
            "/projects/{id}/datasets",
            get_with(list_project_datasets, list_datasets_docs),
        )
        .api_route(
            "/projects/{id}/datasets/{dataset_id}",
            post_with(attach_dataset, attach_docs).delete_with(detach_dataset, detach_docs),
        )
        .api_route(
            "/projects/{id}/shares",
            get_with(list_project_shares, list_shares_docs).post_with(create_share, create_share_docs),
        )
        .api_route(
            "/project-shares/{id}/accept",
            post_with(accept_share, accept_share_docs),
        )
        .api_route(
            "/project-shares/{id}/decline",
            post_with(decline_share, decline_share_docs),
        )
        .api_route(
            "/project-shares/{id}",
            delete_with(revoke_share, revoke_share_docs),
        )
        .api_route(
            "/projects/{id}/transfer",
            post_with(create_transfer, create_transfer_docs),
        )
        .api_route(
            "/project-transfers/{id}/accept",
            post_with(accept_transfer, accept_transfer_docs),
        )
        .api_route(
            "/project-transfers/{id}/decline",
            post_with(decline_transfer, decline_transfer_docs),
        )
        .api_route(
            "/project-transfers/{id}",
            delete_with(cancel_transfer, cancel_transfer_docs),
        )
        .api_route(
            "/project/settings",
            get_with(get_settings, get_settings_docs).put_with(update_settings, update_settings_docs),
        )
}

/// Admin cross-user routes. `/admin/projects/{reassign-owner,batch-*}` are static
/// siblings of `/admin/projects/{id}` — matchit gives static precedence (the
/// `/users/me` vs `/users/{id}` pattern), so there is no route collision.
pub fn project_admin_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/admin/projects", get_with(admin_list, admin_list_docs))
        .api_route(
            "/admin/user-search",
            get_with(admin_user_search, admin_user_search_docs),
        )
        .api_route(
            "/admin/projects/reassign-owner",
            post_with(admin_reassign_owner, admin_reassign_docs),
        )
        .api_route(
            "/admin/projects/batch-reassign",
            post_with(admin_batch_reassign, admin_batch_reassign_docs),
        )
        .api_route(
            "/admin/projects/batch-delete",
            post_with(admin_batch_delete, admin_batch_delete_docs),
        )
        .api_route(
            "/admin/projects/{id}",
            get_with(admin_detail, admin_detail_docs).delete_with(admin_delete, admin_delete_docs),
        )
        .api_route(
            "/admin/projects/{id}/change-owner",
            post_with(admin_change_owner, admin_change_owner_docs),
        )
        .api_route(
            "/admin/projects/{id}/shares",
            post_with(admin_share, admin_share_docs),
        )
        .api_route(
            "/admin/projects/{id}/shares/{share_id}",
            delete_with(admin_revoke_share, admin_revoke_docs),
        )
}

fn admin_list_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminRead,)>(op)
        .id("ProjectAdmin.list")
        .tag("project-admin")
        .response::<200, Json<AdminProjectListResponse>>()
}
fn admin_user_search_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminRead,)>(op)
        .id("ProjectAdmin.searchUsers")
        .tag("project-admin")
        .response::<200, Json<AdminUserSearchResponse>>()
}
fn admin_detail_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminRead,)>(op)
        .id("ProjectAdmin.detail")
        .tag("project-admin")
        .response::<200, Json<AdminProjectDetail>>()
}
fn admin_change_owner_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminManage,)>(op)
        .id("ProjectAdmin.changeOwner")
        .tag("project-admin")
        .response::<200, Json<AdminProjectDetail>>()
}
fn admin_share_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminManage,)>(op)
        .id("ProjectAdmin.share")
        .tag("project-admin")
        .response::<200, Json<AdminProjectDetail>>()
}
fn admin_revoke_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminManage,)>(op)
        .id("ProjectAdmin.revokeShare")
        .tag("project-admin")
        .response::<204, ()>()
}
fn admin_delete_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminManage,)>(op)
        .id("ProjectAdmin.delete")
        .tag("project-admin")
        .response::<204, ()>()
}
fn admin_reassign_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminManage,)>(op)
        .id("ProjectAdmin.reassignOwner")
        .tag("project-admin")
        .response::<200, Json<BatchResult>>()
}
fn admin_batch_reassign_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminManage,)>(op)
        .id("ProjectAdmin.batchReassign")
        .tag("project-admin")
        .response::<200, Json<BatchResult>>()
}
fn admin_batch_delete_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectAdminManage,)>(op)
        .id("ProjectAdmin.batchDelete")
        .tag("project-admin")
        .response::<200, Json<BatchResult>>()
}

fn list_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.list")
        .tag("project")
        .response::<200, Json<ProjectListResponse>>()
}
fn create_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.create")
        .tag("project")
        .response::<201, Json<ProjectDto>>()
}
fn get_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.get")
        .tag("project")
        .response::<200, Json<ProjectDto>>()
}
fn update_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.update")
        .tag("project")
        .response::<200, Json<ProjectDto>>()
}
fn delete_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.delete")
        .tag("project")
        .response::<204, ()>()
}
fn duplicate_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.duplicate")
        .tag("project")
        .response::<201, Json<ProjectDto>>()
}
fn access_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.access")
        .tag("project")
        .response::<200, Json<ProjectAccessDto>>()
}
fn list_datasets_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.listDatasets")
        .tag("project")
        .response::<200, Json<ProjectDatasetsResponse>>()
}
fn attach_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.attachDataset")
        .tag("project")
        .response::<200, Json<ProjectDto>>()
}
fn detach_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.detachDataset")
        .tag("project")
        .response::<200, Json<ProjectDto>>()
}
fn list_shares_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.listShares")
        .tag("project")
        .response::<200, Json<ProjectSharesResponse>>()
}
fn create_share_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.createShare")
        .tag("project")
        .response::<201, Json<ProjectShare>>()
}
fn accept_share_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.acceptShare")
        .tag("project")
        .response::<200, Json<ProjectShare>>()
}
fn decline_share_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.declineShare")
        .tag("project")
        .response::<200, Json<ProjectShare>>()
}
fn revoke_share_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.revokeShare")
        .tag("project")
        .response::<204, ()>()
}
fn create_transfer_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.createTransfer")
        .tag("project")
        .response::<201, Json<ProjectTransfer>>()
}
fn accept_transfer_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "Accept a pending ownership transfer addressed to you. Requires projects::use. The project's owner and account are re-stamped to you. Refuses (409 `TRANSFER_REVOKED`) if the user who offered it no longer has authority over the project, or (409 `TRANSFER_BUSY`, retryable) if the project is concurrently contended. 404 if there is no such pending transfer addressed to you.",
        )
        .id("Project.acceptTransfer")
        .tag("project")
        .response::<200, Json<ProjectTransfer>>()
        // #171 — DECLARED, unlike this module's older undeclared 409s (DEC-31). The
        // spec is the only machine-readable contract an external/SDK consumer gets,
        // and this branch ADDS a refusal class; leaving it out because the module's
        // pre-existing error codes are undeclared would widen a module-local gap
        // rather than follow a repo-wide convention — 15 route files do declare their
        // 4xx, including `Admin.removeMember`, which this same branch edits.
        .response_with::<409, (), _>(|r| {
            r.description(
                "`TRANSFER_REVOKED` — the user who offered this transfer no longer has authority over the project (removed from its account, demoted, or deactivated), so the offer is dead; or `TRANSFER_BUSY` — the project is being modified concurrently and the request timed out waiting, which is RETRYABLE. Distinguish by the error CODE, not the status",
            )
        })
}
fn decline_transfer_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.declineTransfer")
        .tag("project")
        .response::<200, Json<ProjectTransfer>>()
}
fn cancel_transfer_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .id("Project.cancelTransfer")
        .tag("project")
        .response::<204, ()>()
}
fn get_settings_docs(op: TransformOperation) -> TransformOperation {
    // READ gated by projects::use (the flag drives the client's Transfer gate);
    // MANAGE (PUT) stays project::settings::manage.
    with_permission::<(ProjectsUse,)>(op)
        .id("ProjectSettings.get")
        .tag("project")
        .response::<200, Json<ProjectSettings>>()
}
fn update_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectSettingsManage,)>(op)
        .id("ProjectSettings.update")
        .tag("project")
        .response::<200, Json<ProjectSettings>>()
}
