//! Project-scoped authorization for provenance routes (ITEM-30). Mirrors
//! `workstore/authz.rs`: the acting user's `provenance::read`/`export` RBAC
//! capability is checked by `RequirePermissions<..>` at the route; the per-project
//! ROLE is resolved here through the merged `ProjectRepository::effective_permission`
//! — Viewer+ read, Editor+ write, a foreign project → 404 (invisible).

use axum::http::StatusCode;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::project::ProjectRepository;

/// Require the acting user to have ANY role on the project (Viewer+). A foreign /
/// nonexistent project is a 404 (owner-scoped 404 idiom — no leak).
pub async fn require_project_read(
    pool: &SqlitePool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<(), (StatusCode, AppError)> {
    let repo = ProjectRepository::new(pool.clone());
    match repo
        .effective_permission(project_id, user_id)
        .await
        .map_err(|e| e.to_api_error())?
    {
        Some(_) => Ok(()),
        None => Err(AppError::not_found("Project").to_api_error()),
    }
}

/// Require the acting user to be able to EDIT the project (Owner/Editor). A Viewer
/// is a 403; a foreign project is a 404. The server-authoritative write boundary.
pub async fn require_project_edit(
    pool: &SqlitePool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<(), (StatusCode, AppError)> {
    let repo = ProjectRepository::new(pool.clone());
    match repo
        .effective_permission(project_id, user_id)
        .await
        .map_err(|e| e.to_api_error())?
    {
        Some(perm) if perm.can_edit() => Ok(()),
        Some(_) => Err(AppError::forbidden(
            "PROJECT_READ_ONLY",
            "You have read-only access to this project",
        )
        .to_api_error()),
        None => Err(AppError::not_found("Project").to_api_error()),
    }
}
