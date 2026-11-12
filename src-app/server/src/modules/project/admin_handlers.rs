//! Admin (cross-user) project-management handlers. Gated `project::admin::{read,manage}`
//! (admin-only — held via `is_admin`/`*`). These BYPASS owner-scoping: an admin
//! sees + governs every user's projects. Every mutation fans sync out to the
//! affected users (old owner, new owner, share recipients) so their owner-facing
//! views refetch, and notifies the new owner / share recipient via the SDK seam.

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::{ApiResult, AppError};
use txresbench_notification::NewNotification;

use crate::modules::permissions::RequirePermissions;
use crate::modules::sync::{publish, Actor, Audience, SyncAction, SyncEntity};

use super::handlers::{e, publish_project_to_all, KIND_OWNERSHIP_CHANGED, KIND_SHARE_INVITE};
use super::models::*;
use super::permissions::{ProjectAdminManage, ProjectAdminRead};
use super::repository::ProjectRepository;

// ------------------------- shared internals -------------------------

/// Reject an admin-mutation target that is absent (400) or deactivated (422). A
/// deactivated owner/recipient would instantly orphan the project + receive an
/// unseeable notification (mirrors create_share/create_transfer's inactive guard).
async fn require_active_user(
    repo: &ProjectRepository,
    user_id: Uuid,
) -> Result<(), (StatusCode, AppError)> {
    match repo.user_active_status(user_id).await.map_err(e)? {
        None => Err(e(AppError::bad_request("INVALID_USER", "No such user"))),
        Some(false) => Err(e(AppError::unprocessable_entity(
            "INACTIVE_USER",
            "That user's account is inactive",
        ))),
        Some(true) => Ok(()),
    }
}

/// Immediately move a project's owner (no accept), re-point shares, cancel any
/// pending transfer, and fan sync to the affected users. The NEW owner's list
/// gains the project (Create), the OLD owner's drops it (Delete), and accepted
/// recipients (who keep their share) refetch it (Update). Notifies the new owner
/// only when `notify` (batch callers suppress the per-project storm + send ONE
/// summary). Returns `AppError` so batch ops can collect per-item failures.
async fn perform_change_owner(
    pool: &SqlitePool,
    id: Uuid,
    new_owner: Uuid,
    keep_old_as_editor: bool,
    notify: bool,
) -> Result<bool, AppError> {
    let repo = ProjectRepository::new(pool.clone());
    let project = repo.get(id).await?.ok_or_else(|| AppError::not_found("Project"))?;
    let recipients = repo.accepted_recipient_ids(id).await?;
    // Captured BEFORE the change: admin_change_owner cancels any pending transfer,
    // so we must tell its parties to refetch (else a stale 'accept' invite 404s).
    let cancelled_transfer = repo.get_pending_transfer(id).await?;
    let old_owner = repo
        .admin_change_owner(id, new_owner, keep_old_as_editor)
        .await?
        .ok_or_else(|| AppError::not_found("Project"))?;

    if old_owner == new_owner {
        return Ok(false); // true no-op (already owns it) — no sync/notification
    }
    // Add/remove intent (the sync frame is notify-only, but Create/Delete match
    // the accept_transfer semantics + are robust to a patch-not-refetch client).
    publish(SyncEntity::Project, SyncAction::Create, id, Audience::owner(new_owner), None);
    publish(SyncEntity::Project, SyncAction::Delete, id, Audience::owner(old_owner), None);
    for &rid in &recipients {
        if rid != new_owner && rid != old_owner {
            publish(SyncEntity::Project, SyncAction::Update, id, Audience::owner(rid), None);
        }
    }
    if let Some(t) = cancelled_transfer {
        // The pending transfer was cancelled by the ownership change — clear the
        // stale invite on both parties' devices.
        publish(SyncEntity::ProjectTransfer, SyncAction::Delete, t.id, Audience::owner(t.to_user_id), None);
        publish(SyncEntity::ProjectTransfer, SyncAction::Delete, t.id, Audience::owner(t.from_user_id), None);
    }

    if notify {
        // NON-FATAL: ownership is already committed.
        if let Err(err) = txresbench_notification::create_and_emit(
            pool,
            NewNotification::new(new_owner, KIND_OWNERSHIP_CHANGED, format!("You now own: {}", project.name))
                .body(format!("An administrator made you the owner of \"{}\".", project.name))
                .payload(serde_json::json!({ "project_id": project.id, "project_name": project.name })),
        )
        .await
        {
            tracing::warn!("ownership-changed notification failed (owner still moved): {err}");
        }
    }
    Ok(true)
}

/// Delete any project; its shares/dataset-links/transfers cascade (datasets survive).
/// Fans a `Delete` to everyone who could currently SEE it (captured before delete).
///
/// #168: this used to fan to `project.owner_id + accepted_recipient_ids` — the EIGHTH
/// inlined audience of that shape, and the one a first sweep of the owner-facing
/// handlers missed. It failed in both directions at once: a member removed from the
/// account was still told, live, that the project they created there had been deleted,
/// and the account's remaining members — who could open the project right up until this
/// call — were told nothing. It resolves through `project_audience` like every other
/// site now.
async fn perform_delete(pool: &SqlitePool, id: Uuid) -> Result<(), AppError> {
    let repo = ProjectRepository::new(pool.clone());
    // Resolve BEFORE the delete: the membership rows survive it, but the shares cascade
    // away with the project.
    let audience = crate::modules::project::scope::project_audience(&repo, id).await?;
    // Route admin-delete through the SHARED chokepoint so every module's
    // `on_project_deleted` cleanup fires in-tx (project-extensions replaced the bare
    // `repo.delete`). The audience is captured above, before the row is gone.
    super::lifecycle::delete_project_with_extensions(pool, id).await?;
    // An ADMIN acting on someone else's project. `Actor::detached()` is the honest
    // spelling: the acting user is not in this audience at all, so there is no frame
    // for their connection to suppress — every party refetches.
    if let Some((anchor, recipients)) = audience {
        publish_project_to_all(SyncAction::Delete, id, anchor, &recipients, Actor::detached());
    } else {
        tracing::warn!(project_id = %id, "admin project delete: audience unresolved or empty; no sync frame emitted");
    }
    Ok(())
}

async fn run_batch_reassign(pool: &SqlitePool, ids: &[Uuid], to: Uuid) -> BatchResult {
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    let mut moved = 0usize; // projects that ACTUALLY changed owner (not no-ops)
    for &id in ids {
        // notify=false: one summary below, not a per-project notification storm.
        match perform_change_owner(pool, id, to, false, false).await {
            Ok(did_move) => {
                succeeded.push(id);
                if did_move {
                    moved += 1;
                }
            }
            Err(err) => failed.push(BatchFailure { id, error: err.to_string() }),
        }
    }
    if moved > 0 {
        let n = moved;
        if let Err(err) = txresbench_notification::create_and_emit(
            pool,
            NewNotification::new(
                to,
                KIND_OWNERSHIP_CHANGED,
                format!("You now own {n} more {}", if n == 1 { "project" } else { "projects" }),
            )
            .body(format!(
                "An administrator reassigned {n} {} to you.",
                if n == 1 { "project" } else { "projects" }
            ))
            .payload(serde_json::json!({ "count": n })),
        )
        .await
        {
            tracing::warn!("batch reassign summary notification failed: {err}");
        }
    }
    BatchResult { succeeded, failed }
}

// ------------------------- handlers -------------------------

pub async fn admin_list(
    _auth: RequirePermissions<(ProjectAdminRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<AdminProjectListQuery>,
) -> ApiResult<Json<AdminProjectListResponse>> {
    let repo = ProjectRepository::new(pool);
    let (page, per_page) = q.paging();
    let search = q.search.as_deref().filter(|s| !s.trim().is_empty());
    let (rows, total, stats) = repo
        .admin_list_all(search, q.owner_id, q.status_filter(), q.sort_key(), page, per_page)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(AdminProjectListResponse { rows, total, page, per_page, stats }),
    ))
}

pub async fn admin_user_search(
    _auth: RequirePermissions<(ProjectAdminRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<AdminUserSearchQuery>,
) -> ApiResult<Json<AdminUserSearchResponse>> {
    let repo = ProjectRepository::new(pool);
    let search = q.search.as_deref().filter(|s| !s.trim().is_empty());
    let users = repo.admin_search_users(search, 20).await.map_err(e)?;
    Ok((StatusCode::OK, Json(AdminUserSearchResponse { users })))
}

pub async fn admin_detail(
    _auth: RequirePermissions<(ProjectAdminRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<AdminProjectDetail>> {
    let repo = ProjectRepository::new(pool);
    let detail = repo
        .admin_get_detail(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project")))?;
    Ok((StatusCode::OK, Json(detail)))
}

pub async fn admin_change_owner(
    _auth: RequirePermissions<(ProjectAdminManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Json(req): Json<AdminChangeOwnerRequest>,
) -> ApiResult<Json<AdminProjectDetail>> {
    let repo = ProjectRepository::new(pool.clone());
    require_active_user(&repo, req.new_owner_id).await?;
    perform_change_owner(&pool, id, req.new_owner_id, req.keep_old_as_editor, true)
        .await
        .map_err(e)?;
    let detail = repo
        .admin_get_detail(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project")))?;
    Ok((StatusCode::OK, Json(detail)))
}

pub async fn admin_share(
    _auth: RequirePermissions<(ProjectAdminManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Json(req): Json<AdminShareRequest>,
) -> ApiResult<Json<AdminProjectDetail>> {
    let level = match req.permission_level.as_str() {
        "editor" => "editor",
        "viewer" => "viewer",
        _ => return Err(e(AppError::bad_request("INVALID_LEVEL", "permission_level must be viewer or editor"))),
    };
    let repo = ProjectRepository::new(pool.clone());
    let project = repo.get(id).await.map_err(e)?.ok_or_else(|| e(AppError::not_found("Project")))?;
    if req.recipient_id == project.owner_id {
        return Err(e(AppError::bad_request("SHARE_TO_OWNER", "That user already owns this project")));
    }
    // A deactivated recipient can never accept the invite — reject (mirrors create_share).
    require_active_user(&repo, req.recipient_id).await?;
    if repo.active_share_exists(id, req.recipient_id).await.map_err(e)? {
        return Err(e(AppError::new(
            StatusCode::CONFLICT,
            "ALREADY_SHARED",
            "This project is already shared with that user",
        )));
    }
    let share = repo
        .upsert_share(id, project.owner_id, req.recipient_id, level)
        .await
        .map_err(e)?;

    // NON-FATAL notify (share row is committed). Reuses the share-invite kind so
    // the recipient gets the same Accept/Decline renderer.
    if let Err(err) = txresbench_notification::create_and_emit(
        &pool,
        NewNotification::new(req.recipient_id, KIND_SHARE_INVITE, format!("Project shared: {}", project.name))
            .body(format!("An administrator shared \"{}\" with you.", project.name))
            .payload(serde_json::json!({
                "project_id": project.id,
                "share_id": share.id,
                "project_name": project.name,
                "sharer_name": "an administrator",
                "permission_level": level,
            })),
    )
    .await
    {
        tracing::warn!("admin share notification failed (share still created): {err}");
    }

    publish(SyncEntity::ProjectShare, SyncAction::Create, share.id, Audience::owner(req.recipient_id), None);
    publish(SyncEntity::ProjectShare, SyncAction::Create, share.id, Audience::owner(project.owner_id), None);

    let detail = repo
        .admin_get_detail(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project")))?;
    Ok((StatusCode::OK, Json(detail)))
}

pub async fn admin_revoke_share(
    _auth: RequirePermissions<(ProjectAdminManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Path((project_id, share_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<()> {
    let repo = ProjectRepository::new(pool);
    let share = repo
        .get_share(share_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project share")))?;
    // The share must actually belong to the project named in the URL (no
    // cross-project revoke via a mismatched path).
    if share.project_id != project_id {
        return Err(e(AppError::not_found("Project share")));
    }
    if !repo.admin_revoke_share(share_id).await.map_err(e)? {
        return Err(e(AppError::not_found("Project share")));
    }
    // The ex-recipient loses the project (Delete); the owner's share panel refreshes.
    publish(SyncEntity::ProjectShare, SyncAction::Delete, share_id, Audience::owner(share.recipient_id), None);
    publish(SyncEntity::ProjectShare, SyncAction::Delete, share_id, Audience::owner(share.owner_id), None);
    publish(SyncEntity::Project, SyncAction::Delete, share.project_id, Audience::owner(share.recipient_id), None);
    Ok((StatusCode::NO_CONTENT, ()))
}

pub async fn admin_delete(
    _auth: RequirePermissions<(ProjectAdminManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<()> {
    perform_delete(&pool, id).await.map_err(e)?;
    Ok((StatusCode::NO_CONTENT, ()))
}

pub async fn admin_reassign_owner(
    _auth: RequirePermissions<(ProjectAdminManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<AdminReassignRequest>,
) -> ApiResult<Json<BatchResult>> {
    let repo = ProjectRepository::new(pool.clone());
    require_active_user(&repo, req.to_owner_id).await?;
    let ids = repo.projects_owned_by(req.from_owner_id).await.map_err(e)?;
    if ids.len() > ADMIN_BATCH_MAX {
        return Err(e(AppError::unprocessable_entity(
            "TOO_MANY",
            "This owner has too many projects to reassign at once; select them in batches",
        )));
    }
    let result = run_batch_reassign(&pool, &ids, req.to_owner_id).await;
    Ok((StatusCode::OK, Json(result)))
}

pub async fn admin_batch_reassign(
    _auth: RequirePermissions<(ProjectAdminManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<BatchReassignRequest>,
) -> ApiResult<Json<BatchResult>> {
    if req.project_ids.len() > ADMIN_BATCH_MAX {
        return Err(e(AppError::bad_request("TOO_MANY", "Too many projects in one batch (max 500)")));
    }
    let repo = ProjectRepository::new(pool.clone());
    require_active_user(&repo, req.to_owner_id).await?;
    let result = run_batch_reassign(&pool, &req.project_ids, req.to_owner_id).await;
    Ok((StatusCode::OK, Json(result)))
}

pub async fn admin_batch_delete(
    _auth: RequirePermissions<(ProjectAdminManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<BatchDeleteRequest>,
) -> ApiResult<Json<BatchResult>> {
    if req.project_ids.len() > ADMIN_BATCH_MAX {
        return Err(e(AppError::bad_request("TOO_MANY", "Too many projects in one batch (max 500)")));
    }
    let mut succeeded = Vec::new();
    let mut failed = Vec::new();
    for id in req.project_ids {
        match perform_delete(&pool, id).await {
            Ok(()) => succeeded.push(id),
            Err(err) => failed.push(BatchFailure { id, error: err.to_string() }),
        }
    }
    Ok((StatusCode::OK, Json(BatchResult { succeeded, failed })))
}
