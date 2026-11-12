//! Project HTTP handlers. Gated `projects::use`; the per-project resource ACL
//! (owner/editor/viewer) is enforced server-side in every mutating handler.
//! Owner-scoped sync emits + recipient notifications on share/transfer.

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_auth::auth::context::AuthContext;
use txresbench_core::{ApiResult, AppError};
use txresbench_notification::NewNotification;

use crate::modules::permissions::RequirePermissions;
use crate::modules::sync::{
    fan_out_owner_scoped, publish, Actor, Audience, SyncAction, SyncEntity, SyncOrigin,
};
use crate::modules::workstore::detach_guard::detach_verdict;

use super::models::*;
use super::permissions::ProjectsUse;
use super::repository::ProjectRepository;
use super::scope::{authz_precedence, project_audience, ProjectScope};

/// Notification kinds this module contributes (the FE registers renderers for
/// these; see the backend kind registry in `mod.rs`).
pub const KIND_SHARE_INVITE: &str = "project_share_invite";
pub const KIND_TRANSFER_INVITE: &str = "project_transfer_invite";
/// Informational — an admin moved a project to you (no accept/decline).
pub const KIND_OWNERSHIP_CHANGED: &str = "project_ownership_changed";

pub(crate) fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// Resolve the acting user's `ProjectScope` (the single per-project ACL chokepoint),
/// 404 if the project is invisible to them. Handlers then call `scope.require_*()`.
async fn resolve_scope(
    repo: &ProjectRepository,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<ProjectScope, (StatusCode, AppError)> {
    // A3 (ITEM-1/7): resolve through the account-aware chokepoint — the OUTER
    // `RequirePermissions` RBAC gate (403) is unchanged at every caller; this adds the
    // mid account-membership rung (404) UNDER it. Behaviour-identical to `resolve` for
    // personal-account users (INV-4).
    ProjectScope::resolve_in_account(repo, project_id, user_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project")))
}

pub(crate) fn display_name(user: &txresbench_auth::User) -> String {
    user.display_name
        .clone()
        .unwrap_or_else(|| user.username.clone())
}

/// Fan a `Project` change to a caller-resolved audience.
///
/// `owner_id` is the fan-out ANCHOR, not necessarily the project's owner: since #168
/// the audience is the account's CURRENT membership ∪ accepted shares, and the row's
/// `owner_id` anchors it only while they are still in that set. `actor` is WHO changed
/// it — an editor recipient reaches `update`/`attach`/`detach` too, so the two are not
/// the same user in general. The rule (and why `origin` follows the actor rather than
/// the anchor) lives in [`fan_out_owner_scoped`]; slot 0 carries no privilege.
///
/// Prefer [`publish_project_audience`], which resolves the audience for you. This raw
/// form exists for the DELETE paths, which must capture the audience BEFORE the row
/// and its shares are gone.
pub(crate) fn publish_project_to_all(
    action: SyncAction,
    project_id: Uuid,
    owner_id: Uuid,
    recipients: &[Uuid],
    actor: Actor,
) {
    fan_out_owner_scoped(
        SyncEntity::Project,
        action,
        project_id,
        owner_id,
        recipients,
        actor,
    );
}

/// Resolve the project's audience through [`project_audience`] and fan one change to
/// it — the form every non-delete project mutation uses (#168).
///
/// The handlers used to inline `(project.owner_id, accepted_recipient_ids(id))` at each
/// emit site, which is a hand-copy of an audience rule and drifted exactly as every
/// other hand-copied predicate in this codebase has: `project_audience` was hardened to
/// derive from CURRENT account membership and these four sites never called it, so a
/// removed ex-creator kept receiving `update`/`attach`/`detach` frames for a project
/// they could no longer open. Routing them through the one helper closes that and
/// removes the copy that produced it.
///
/// `delete_project` deliberately does NOT use this: it must resolve the audience
/// BEFORE the row (and its cascading shares) are gone, so it holds the pair across the
/// delete itself.
async fn publish_project_audience(
    repo: &ProjectRepository,
    action: SyncAction,
    project_id: Uuid,
    actor: Actor,
) {
    match project_audience(repo, project_id).await {
        Ok(Some((owner_id, recipients))) => {
            publish_project_to_all(action, project_id, owner_id, &recipients, actor);
        }
        Ok(None) => {
            tracing::debug!(%project_id, "project sync: nobody may see this project; no frame emitted");
        }
        Err(err) => {
            tracing::warn!(%project_id, error = ?err, "project sync: audience unresolved; connected devices will not live-refresh this project until their next refetch");
        }
    }
}

// ============================= project CRUD =============================

pub async fn list_projects(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<ProjectListQuery>,
) -> ApiResult<Json<ProjectListResponse>> {
    let repo = ProjectRepository::new(pool);
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let search = q.search.as_deref().filter(|s| !s.trim().is_empty());
    let (projects, total) = repo
        .list_visible(auth.user.id, search, page, per_page)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ProjectListResponse {
            projects,
            total,
            page,
            per_page,
        }),
    ))
}

pub async fn create_project(
    auth: RequirePermissions<(ProjectsUse,)>,
    active: crate::modules::account::ActiveAccount,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(req): Json<CreateProjectRequest>,
) -> ApiResult<Json<ProjectDto>> {
    let name = validate_name(&req.name).map_err(|m| e(AppError::bad_request("INVALID_NAME", m)))?;
    validate_description(&req.description)
        .map_err(|m| e(AppError::bad_request("INVALID_DESCRIPTION", m)))?;
    let repo = ProjectRepository::new(pool);
    // A4 ITEM-7: stamp the ACTIVE account (PROV-A4-1) — the account the caller is
    // acting under (their personal account by default; a member org when switched).
    // The extractor already 404'd a non-member header, so this write is authorized.
    let project = repo
        .create_in_account(auth.user.id, active.account_id, &name, &req.description)
        .await
        .map_err(e)?;
    publish(
        SyncEntity::Project,
        SyncAction::Create,
        project.id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((
        StatusCode::CREATED,
        Json(ProjectDto::from_project(
            project,
            EffectivePermission::Owner,
            0,
        )),
    ))
}

pub async fn get_project(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProjectDto>> {
    let repo = ProjectRepository::new(pool);
    let ProjectScope { project, perm, .. } = resolve_scope(&repo, id, auth.user.id).await?;
    let count = repo.dataset_count(id).await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ProjectDto::from_project(project, perm, count)),
    ))
}

/// `GET /projects/{id}/access` — the acting user's resolved role on a project
/// (`{role, can_edit, is_owner}`). P10's single seam INTO the P6 workbench shell:
/// the bootstrap reads the role WITHOUT loading the full `ProjectDto`. 404 if the
/// project is invisible (the two-level gate: outer `projects::use` via the extractor,
/// inner project role via `resolve_scope`).
pub async fn get_project_access(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProjectAccessDto>> {
    let repo = ProjectRepository::new(pool);
    // Two-level authz (DEC-4) made explicit: the OUTER `projects::use` capability is
    // enforced by the `RequirePermissions` extractor BEFORE this body runs (so the
    // capability is satisfied here), then `authz_precedence` applies the INNER
    // project-role 404. This is the same shared guard extension endpoints (P5/P9/P11)
    // reuse when they resolve their capability in-body.
    let scope = authz_precedence(
        true,
        ProjectScope::resolve_in_account(&repo, id, auth.user.id)
            .await
            .map_err(e)?,
    )
    .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ProjectAccessDto {
            project_id: id,
            role: scope.perm.as_str().to_string(),
            can_edit: scope.can_edit(),
            is_owner: scope.is_owner(),
        }),
    ))
}

pub async fn update_project(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateProjectRequest>,
) -> ApiResult<Json<ProjectDto>> {
    let repo = ProjectRepository::new(pool);
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    scope.require_can_edit().map_err(e)?;
    let perm = scope.perm;
    let name = match &req.name {
        Some(n) => Some(validate_name(n).map_err(|m| e(AppError::bad_request("INVALID_NAME", m)))?),
        None => None,
    };
    if let Some(d) = &req.description {
        validate_description(d).map_err(|m| e(AppError::bad_request("INVALID_DESCRIPTION", m)))?;
    }
    let project = repo
        .update(id, name.as_deref(), req.description.as_deref())
        .await
        .map_err(e)?;
    // #168: the audience comes from `project_audience` — the account's CURRENT
    // membership u accepted shares — never from `project.owner_id` + recipients.
    // Inlining that pair here is what let a removed ex-creator keep receiving live
    // frames for a project they can no longer open; see `publish_project_audience`.
    publish_project_audience(&repo, SyncAction::Update, id, Actor::user(auth.user.id, origin.0))
        .await;
    let count = repo.dataset_count(id).await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ProjectDto::from_project(project, perm, count)),
    ))
}

pub async fn delete_project(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
) -> ApiResult<()> {
    let repo = ProjectRepository::new(pool.clone());
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    scope.require_owner().map_err(e)?;
    // Resolve the sync audience BEFORE deleting — the account membership rows survive
    // the delete but the SHARES cascade away with the project, so resolving afterwards
    // would silently drop every sharee.
    //
    // #168: the fallback used to be `unwrap_or((scope.project.owner_id, Vec::new()))`,
    // justified as "a delete must not 500 on a recipient-lookup hiccup". The
    // no-500 half is right and is kept; the OWNER-ADDRESSED half was the leak — it
    // resolves to the project's creator whether or not they are still in the account.
    // An unresolved or empty audience now sends nothing, exactly like every other
    // audience site, and the client's 60s sync re-check is the backstop.
    let audience = project_audience(&repo, id).await.ok().flatten();
    // Fire every module's `on_project_deleted` cleanup + delete the project row in one
    // tx (the shared chokepoint — an admin-delete path MUST call this too so
    // cleanup fires for it as well). The returned GcManifest is swept post-commit
    // inside the chokepoint (P1's refcount sweep); the owner-delete path ignores it.
    super::lifecycle::delete_project_with_extensions(&pool, id)
        .await
        .map_err(e)?;
    if let Some((owner_id, recipients)) = audience {
        publish_project_to_all(
            SyncAction::Delete,
            id,
            owner_id,
            &recipients,
            Actor::user(auth.user.id, origin.0),
        );
    } else {
        tracing::warn!(project_id = %id, "project delete: audience unresolved or empty; no sync frame emitted");
    }
    Ok((StatusCode::NO_CONTENT, ()))
}

pub async fn duplicate_project(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProjectDto>> {
    let repo = ProjectRepository::new(pool.clone());
    // Duplicate creates a NEW project owned by the acting user; they must be able
    // to see the source (owner or shared).
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    // The duplicate is owned by the acting user (not necessarily the source owner).
    // `source_for_user.id` stays the SOURCE id so the deep-copy hook copies FROM it.
    let source_for_user = Project {
        owner_id: auth.user.id,
        ..scope.project
    };
    // Create the duplicate project row AND fire every module's deep-copy hook in one
    // tx via the shared chokepoint (atomic: a hook failure rolls the whole
    // duplicate back — symmetric with `delete_project_with_extensions`).
    let dup = super::lifecycle::duplicate_project_with_extensions(&pool, &source_for_user)
        .await
        .map_err(e)?;
    // Report the ACTUAL dataset count of the duplicate — extensions may have
    // deep-copied datasets into it, so a hardcoded 0 would understate the copy
    // until the next sync refetch.
    let count = repo.dataset_count(dup.id).await.map_err(e)?;
    publish(
        SyncEntity::Project,
        SyncAction::Create,
        dup.id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((
        StatusCode::CREATED,
        Json(ProjectDto::from_project(
            dup,
            EffectivePermission::Owner,
            count,
        )),
    ))
}

// ============================= datasets =============================

pub async fn attach_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((id, dataset_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<ProjectDto>> {
    let repo = ProjectRepository::new(pool.clone());
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    scope.require_can_edit().map_err(e)?;
    let ProjectScope { project, perm, .. } = scope;
    if !repo.dataset_exists(dataset_id).await.map_err(e)? {
        return Err(e(AppError::not_found("Dataset")));
    }
    // Datasets are owner-scoped + shareable and belong to MANY projects (M:N):
    // attaching adds a link, it does NOT move the dataset out of any other project.
    // The caller must be able to SEE the dataset (owner ∪ sharee) — a project
    // editor cannot pull a dataset they have no visibility into.
    let group_ids: Vec<Uuid> = auth
        .groups
        .iter()
        .filter(|g| g.is_active)
        .map(|g| g.id)
        .collect();
    let visible = crate::modules::dataset::repository::DatasetRepository::new(pool)
        .is_visible_to(dataset_id, auth.user.id, &group_ids)
        .await
        .map_err(e)?;
    if !visible {
        return Err(e(AppError::forbidden(
            "FORBIDDEN",
            "You do not have access to that dataset",
        )));
    }
    // Attach with the per-project cap enforced atomically (row-locked). false = cap.
    if !repo
        .attach_dataset_capped(id, dataset_id, PROJECT_MAX_DATASETS)
        .await
        .map_err(e)?
    {
        return Err(e(AppError::unprocessable_entity(
            "PROJECT_DATASET_CAP",
            "This project already has the maximum number of datasets (100)",
        )));
    }
    // #168: membership-derived audience, not `project.owner_id` + recipients.
    publish_project_audience(&repo, SyncAction::Update, id, Actor::user(auth.user.id, origin.0))
        .await;
    let count = repo.dataset_count(id).await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ProjectDto::from_project(project, perm, count)),
    ))
}

pub async fn detach_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((id, dataset_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<ProjectDto>> {
    let repo = ProjectRepository::new(pool.clone());
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    scope.require_can_edit().map_err(e)?;
    let ProjectScope { project, perm, .. } = scope;

    // ── ITEM-40 — the GATE, before the delete ────────────────────────────────────────────
    //
    // An ordinary dataset detaches freely: its derived artifacts are orphaned but preserved,
    // and re-attaching restores them. A dataset an INTEGRATED dataset is built from is
    // different in kind — a gathered artifact has no blob of its own, so removing a source
    // makes every artifact derived from it unreadable. That is a correctness question, not a
    // visibility one, which is why this refuses rather than warns.
    //
    // It runs BEFORE `detach_dataset`, not after: the delete is the thing being prevented, and
    // a check that ran afterwards would be reporting damage rather than refusing it.
    let verdict = detach_verdict(&pool, id, dataset_id).await.map_err(e)?;
    if let Some(message) = verdict.message() {
        return Err(e(AppError::new(
            StatusCode::CONFLICT,
            "DATASET_HAS_DEPENDENTS",
            message,
        )));
    }

    repo.detach_dataset(id, dataset_id).await.map_err(e)?;
    // #168: membership-derived audience, not `project.owner_id` + recipients.
    publish_project_audience(&repo, SyncAction::Update, id, Actor::user(auth.user.id, origin.0))
        .await;
    let count = repo.dataset_count(id).await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ProjectDto::from_project(project, perm, count)),
    ))
}

pub async fn list_project_datasets(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Query(q): Query<ProjectListQuery>,
) -> ApiResult<Json<ProjectDatasetsResponse>> {
    let repo = ProjectRepository::new(pool);
    // Visibility check (any role — Viewer+).
    let _ = resolve_scope(&repo, id, auth.user.id).await?;
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let (datasets, total) = repo.list_datasets(id, page, per_page).await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ProjectDatasetsResponse {
            datasets,
            total,
            page,
            per_page,
        }),
    ))
}

// ============================= shares =============================

pub async fn create_share(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateShareRequest>,
) -> ApiResult<Json<ProjectShare>> {
    let repo = ProjectRepository::new(pool.clone());
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    scope.require_owner().map_err(e)?;
    let ProjectScope { project, .. } = scope;
    let level = match req.permission_level.as_str() {
        "viewer" | "editor" => req.permission_level.as_str(),
        _ => {
            return Err(e(AppError::bad_request(
                "INVALID_LEVEL",
                "permission_level must be 'viewer' or 'editor'",
            )))
        }
    };
    let recipient = ctx
        .user()
        .get_by_email(req.email.trim())
        .await
        .map_err(e)?
        .ok_or_else(|| {
            e(AppError::unprocessable_entity(
                "UNKNOWN_RECIPIENT",
                "No user with that email exists",
            ))
        })?;
    if recipient.id == auth.user.id {
        return Err(e(AppError::bad_request(
            "SELF_SHARE",
            "You cannot share a project with yourself",
        )));
    }
    if !recipient.is_active {
        // A deactivated recipient can never accept → don't create a dead invite.
        return Err(e(AppError::unprocessable_entity(
            "INACTIVE_RECIPIENT",
            "That user's account is inactive",
        )));
    }
    if repo
        .active_share_exists(id, recipient.id)
        .await
        .map_err(e)?
    {
        return Err(e(AppError::new(
            StatusCode::CONFLICT,
            "ALREADY_SHARED",
            "This project is already shared with that user",
        )));
    }
    let share = repo
        .upsert_share(id, auth.user.id, recipient.id, level)
        .await
        .map_err(e)?;

    // Notify the recipient (kind-dispatched renderer offers Accept/Decline).
    // NON-FATAL: the share row is already committed — a notification-insert
    // hiccup must not 500 the request (which would leave the share unnotified
    // and a retry hitting 409). Log and continue; the recipient still sees the
    // project via the sync publish below + their next list refetch.
    if let Err(err) = txresbench_notification::create_and_emit(
        &pool,
        NewNotification::new(
            recipient.id,
            KIND_SHARE_INVITE,
            format!("Project shared: {}", project.name),
        )
        .body(format!(
            "{} shared the project \"{}\" with you",
            display_name(&auth.user),
            project.name
        ))
        .payload(serde_json::json!({
            "project_id": project.id,
            "share_id": share.id,
            "project_name": project.name,
            "sharer_name": display_name(&auth.user),
            "permission_level": level,
        })),
    )
    .await
    {
        tracing::warn!("project share notification failed (share still created): {err}");
    }

    // Both parties refetch their share views.
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Create,
        share.id,
        Audience::owner(recipient.id),
        None,
    );
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Create,
        share.id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::CREATED, Json(share)))
}

pub async fn list_project_shares(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ProjectSharesResponse>> {
    let repo = ProjectRepository::new(pool);
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    scope.require_owner().map_err(e)?;
    let shares = repo.list_shares_for_project(id).await.map_err(e)?;
    Ok((StatusCode::OK, Json(ProjectSharesResponse { shares })))
}

pub async fn accept_share(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(share_id): Path<Uuid>,
) -> ApiResult<Json<ProjectShare>> {
    let repo = ProjectRepository::new(pool);
    let updated = repo
        .set_share_status(share_id, auth.user.id, "accepted")
        .await
        .map_err(e)?;
    if !updated {
        return Err(e(AppError::not_found("Project share")));
    }
    let share = repo
        .get_share(share_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project share")))?;
    // The recipient now sees the project; refresh both share + project lists.
    //
    // Both frames addressed to the ACTOR carry `origin` — including the `Project`
    // one. It used to carry `None`, making it the single frame in this module
    // published to the acting user without self-echo suppression, for the semantically
    // identical event `accept_transfer` publishes WITH `origin` ("you just gained this
    // project"). Nothing was visibly broken — the FE compensated by not echoing this
    // one — but the compensation is a per-frame exception a reader has to look up, and
    // an exception is what the acting-tab convention exists to eliminate. The rule is
    // now uniform and checkable by reading one line: a frame addressed to the actor
    // carries `origin`; a frame addressed to anyone else carries `None`.
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Update,
        share_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    publish(
        SyncEntity::Project,
        SyncAction::Create,
        share.project_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Update,
        share_id,
        Audience::owner(share.owner_id),
        None,
    );
    Ok((StatusCode::OK, Json(share)))
}

pub async fn decline_share(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(share_id): Path<Uuid>,
) -> ApiResult<Json<ProjectShare>> {
    let repo = ProjectRepository::new(pool);
    let updated = repo
        .set_share_status(share_id, auth.user.id, "declined")
        .await
        .map_err(e)?;
    if !updated {
        return Err(e(AppError::not_found("Project share")));
    }
    let share = repo
        .get_share(share_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project share")))?;
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Update,
        share_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Update,
        share_id,
        Audience::owner(share.owner_id),
        None,
    );
    Ok((StatusCode::OK, Json(share)))
}

pub async fn revoke_share(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(share_id): Path<Uuid>,
) -> ApiResult<()> {
    let repo = ProjectRepository::new(pool);
    let share = repo
        .get_share(share_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project share")))?;
    let removed = repo.revoke_share(share_id, auth.user.id).await.map_err(e)?;
    if !removed {
        // Not the owner of this share → 404 (same as a nonexistent id), so the
        // endpoint isn't an existence oracle for a share you don't own.
        return Err(e(AppError::not_found("Project share")));
    }
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Delete,
        share_id,
        Audience::owner(share.recipient_id),
        None,
    );
    publish(
        SyncEntity::Project,
        SyncAction::Delete,
        share.project_id,
        Audience::owner(share.recipient_id),
        None,
    );
    publish(
        SyncEntity::ProjectShare,
        SyncAction::Delete,
        share_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::NO_CONTENT, ()))
}

// ============================= transfers =============================

pub async fn create_transfer(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateTransferRequest>,
) -> ApiResult<Json<ProjectTransfer>> {
    let repo = ProjectRepository::new(pool.clone());
    // Resolve ownership FIRST (404 if invisible, 403 if not owner) — BEFORE
    // reading the admin-gated transfer_enabled setting, so a non-owner can't
    // infer that deployment-wide flag from a 409-vs-404/403 on an arbitrary id.
    let scope = resolve_scope(&repo, id, auth.user.id).await?;
    scope.require_owner().map_err(e)?;
    let ProjectScope { project, .. } = scope;
    if !repo.get_settings().await.map_err(e)?.transfer_enabled {
        return Err(e(AppError::new(
            StatusCode::CONFLICT,
            "TRANSFER_DISABLED",
            "Ownership transfer is disabled for this deployment",
        )));
    }
    let recipient = ctx
        .user()
        .get_by_email(req.email.trim())
        .await
        .map_err(e)?
        .ok_or_else(|| {
            e(AppError::unprocessable_entity(
                "UNKNOWN_RECIPIENT",
                "No user with that email exists",
            ))
        })?;
    if recipient.id == auth.user.id {
        return Err(e(AppError::bad_request(
            "SELF_TRANSFER",
            "You already own this project",
        )));
    }
    if !recipient.is_active {
        return Err(e(AppError::unprocessable_entity(
            "INACTIVE_RECIPIENT",
            "That user's account is inactive",
        )));
    }
    if repo.pending_transfer_exists(id).await.map_err(e)? {
        return Err(e(AppError::new(
            StatusCode::CONFLICT,
            "TRANSFER_PENDING",
            "A transfer of this project is already pending",
        )));
    }
    let transfer = repo
        .create_transfer(id, auth.user.id, recipient.id)
        .await
        .map_err(e)?;

    // NON-FATAL notification (the transfer row is already committed).
    if let Err(err) = txresbench_notification::create_and_emit(
        &pool,
        NewNotification::new(
            recipient.id,
            KIND_TRANSFER_INVITE,
            format!("Ownership transfer: {}", project.name),
        )
        .body(format!(
            "{} wants to transfer ownership of \"{}\" to you",
            display_name(&auth.user),
            project.name
        ))
        .payload(serde_json::json!({
            "project_id": project.id,
            "transfer_id": transfer.id,
            "project_name": project.name,
            "from_name": display_name(&auth.user),
        })),
    )
    .await
    {
        tracing::warn!("project transfer notification failed (transfer still created): {err}");
    }

    publish(
        SyncEntity::ProjectTransfer,
        SyncAction::Create,
        transfer.id,
        Audience::owner(recipient.id),
        None,
    );
    publish(
        SyncEntity::ProjectTransfer,
        SyncAction::Create,
        transfer.id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::CREATED, Json(transfer)))
}

pub async fn accept_transfer(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(transfer_id): Path<Uuid>,
) -> ApiResult<Json<ProjectTransfer>> {
    let repo = ProjectRepository::new(pool);
    let transfer = repo
        .get_transfer(transfer_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project transfer")))?;
    let ok = repo
        .accept_transfer(transfer_id, auth.user.id)
        .await
        .map_err(e)?;
    if !ok {
        return Err(e(AppError::not_found("Project transfer")));
    }
    // Old owner loses it; new owner gains it. Both refetch their lists.
    publish(
        SyncEntity::Project,
        SyncAction::Delete,
        transfer.project_id,
        Audience::owner(transfer.from_user_id),
        None,
    );
    publish(
        SyncEntity::Project,
        SyncAction::Create,
        transfer.project_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    publish(
        SyncEntity::ProjectTransfer,
        SyncAction::Update,
        transfer_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    let updated = repo
        .get_transfer(transfer_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project transfer")))?;
    Ok((StatusCode::OK, Json(updated)))
}

pub async fn decline_transfer(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(transfer_id): Path<Uuid>,
) -> ApiResult<Json<ProjectTransfer>> {
    let repo = ProjectRepository::new(pool);
    let transfer = repo
        .get_transfer(transfer_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project transfer")))?;
    let ok = repo
        .decline_transfer(transfer_id, auth.user.id)
        .await
        .map_err(e)?;
    if !ok {
        return Err(e(AppError::not_found("Project transfer")));
    }
    publish(
        SyncEntity::ProjectTransfer,
        SyncAction::Update,
        transfer_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    publish(
        SyncEntity::ProjectTransfer,
        SyncAction::Update,
        transfer_id,
        Audience::owner(transfer.from_user_id),
        None,
    );
    let updated = repo
        .get_transfer(transfer_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project transfer")))?;
    Ok((StatusCode::OK, Json(updated)))
}

/// The initiating owner cancels a still-pending transfer (recovery from an
/// unresponsive recipient — otherwise the pending-unique index would lock the
/// project's transfer capability forever). Scoped to the from_user + pending.
pub async fn cancel_transfer(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(transfer_id): Path<Uuid>,
) -> ApiResult<()> {
    let repo = ProjectRepository::new(pool);
    let transfer = repo
        .get_transfer(transfer_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Project transfer")))?;
    let ok = repo
        .cancel_transfer(transfer_id, auth.user.id)
        .await
        .map_err(e)?;
    if !ok {
        // Not the initiator, or already accepted/declined → 404 (no oracle).
        return Err(e(AppError::not_found("Project transfer")));
    }
    publish(
        SyncEntity::ProjectTransfer,
        SyncAction::Delete,
        transfer_id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    publish(
        SyncEntity::ProjectTransfer,
        SyncAction::Delete,
        transfer_id,
        Audience::owner(transfer.to_user_id),
        None,
    );
    Ok((StatusCode::NO_CONTENT, ()))
}

// ============================= settings =============================

pub async fn get_settings(
    // READ is gated by `projects::use` (not the admin `project::settings::read`): the
    // single transfer_enabled bool isn't sensitive, and every projects user needs
    // it so the client can correctly hide the Transfer affordance when it's off.
    // MANAGE (PUT) stays admin-only.
    _auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<ProjectSettings>> {
    let repo = ProjectRepository::new(pool);
    let settings = repo.get_settings().await.map_err(e)?;
    Ok((StatusCode::OK, Json(settings)))
}

pub async fn update_settings(
    _auth: RequirePermissions<(super::permissions::ProjectSettingsManage,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(req): Json<UpdateProjectSettingsRequest>,
) -> ApiResult<Json<ProjectSettings>> {
    let repo = ProjectRepository::new(pool);
    let settings = repo
        .update_settings(req.transfer_enabled)
        .await
        .map_err(e)?;
    // Deployment-wide; delivered to every projects user (they all read the flag to
    // gate the Transfer affordance) — matching the `projects::use` read gate.
    publish(
        SyncEntity::ProjectSettings,
        SyncAction::Update,
        Uuid::nil(),
        Audience::perm::<ProjectsUse>(),
        origin.0,
    );
    Ok((StatusCode::OK, Json(settings)))
}
