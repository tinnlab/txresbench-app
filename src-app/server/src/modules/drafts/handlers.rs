//! Draft HTTP handlers. Gated `drafts::use` (the extractor). A draft is
//! project-scoped: the per-project resource ACL (owner/editor/viewer) is resolved in
//! every handler, and a cross-user / cross-project draft id yields 404 (never the
//! row — INV-3). Owner∪share-audience sync emit on every mutation (INV-6).

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use sqlx::PgPool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};

use crate::modules::permissions::RequirePermissions;
use crate::modules::project::scope::ProjectScope;
use crate::modules::project::ProjectRepository;
use crate::modules::sync::{Actor, SyncAction, SyncOrigin};

use super::models::*;
use super::permissions::DraftsUse;
use super::repository::DraftRepository;
use super::sync::publish_draft;

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// Resolve the acting user's `ProjectScope` for a project, 404 if invisible (the
/// owner-scoped-invisible idiom). The OUTER `drafts::use` capability is enforced by
/// the extractor; this is the INNER project role.
async fn resolve_project_scope(
    pool: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<ProjectScope, (StatusCode, AppError)> {
    let repo = ProjectRepository::new(pool.clone());
    ProjectScope::resolve(&repo, project_id, user_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Draft")))
}

/// Fetch a draft by id AND resolve the acting user's project scope for it. A
/// nonexistent draft, or one whose project is invisible to the user, both yield 404
/// (no existence oracle — INV-3).
async fn resolve_draft(
    pool: &PgPool,
    draft_id: Uuid,
    user_id: Uuid,
) -> Result<(super::models::Draft, ProjectScope), (StatusCode, AppError)> {
    let repo = DraftRepository::new(pool.clone());
    let draft = repo
        .get(draft_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Draft")))?;
    let scope = resolve_project_scope(pool, draft.project_id, user_id).await?;
    Ok((draft, scope))
}

pub async fn list_drafts(
    auth: RequirePermissions<(DraftsUse,)>,
    Extension(pool): Extension<PgPool>,
    Query(q): Query<DraftListQuery>,
) -> ApiResult<Json<DraftListResponse>> {
    // Any project role (Viewer+) may LIST drafts; 404 if the project is invisible.
    let _ = resolve_project_scope(&pool, q.project_id, auth.user.id).await?;
    let repo = DraftRepository::new(pool);
    let drafts = repo
        .list_by_project(q.project_id, q.kind.as_deref())
        .await
        .map_err(e)?;
    Ok((StatusCode::OK, Json(DraftListResponse { drafts })))
}

pub async fn create_draft(
    auth: RequirePermissions<(DraftsUse,)>,
    Extension(pool): Extension<PgPool>,
    origin: SyncOrigin,
    Json(req): Json<CreateDraftRequest>,
) -> ApiResult<Json<super::models::Draft>> {
    if req.kind.trim().is_empty() {
        return Err(e(AppError::bad_request("INVALID_KIND", "kind is required")));
    }
    let data = req.data.unwrap_or_else(|| serde_json::json!({}));
    validate_data_size(&data)
        .map_err(|m| e(AppError::unprocessable_entity("DRAFT_DATA_TOO_LARGE", m)))?;
    // Creating a draft writes into a project → require EDIT on it (a foreign project
    // is 404, no existence leak).
    let scope = resolve_project_scope(&pool, req.project_id, auth.user.id).await?;
    scope.require_can_edit().map_err(e)?;
    // A fork draft (INV-7 / DEC-11) carries the prior frozen version as its parent. Validate it
    // references an artifact in THIS project before persisting it as the row's `frozen_artifact_id`
    // (a foreign / nonexistent artifact → 422, never an FK-500, never a cross-project parent edge).
    if let Some(parent) = req.parent_frozen_artifact_id {
        use crate::modules::workstore::catalog::repository::CatalogRepository;
        let ok = CatalogRepository::new(pool.clone())
            .get_any_status(parent)
            .await
            .map_err(e)?
            // Same project AND actually FROZEN: a committed/frozen artifact is `status = 'ready'`
            // (the freeze producer mints it ready; a pending/failed ingest is not a version to
            // fork from). Tightening this to `ready` keeps a non-frozen same-project id out of the
            // fork's `frozen_artifact_id`, so the lineage chain never links to a non-artifact.
            .is_some_and(|a| a.project_id == Some(req.project_id) && a.status == "ready");
        if !ok {
            return Err(e(AppError::unprocessable_entity(
                "DRAFT_PARENT_ARTIFACT_INVALID",
                "parent_frozen_artifact_id must reference a frozen artifact in this project",
            )));
        }
    }
    let repo = DraftRepository::new(pool.clone());
    // Per-project draft count cap (bounded-write §4; mirrors the project_files 100-cap)
    // — a `drafts::use` holder cannot grow unbounded rows in an editable project. Over
    // the cap → 422 (never a silent truncation).
    let count = repo.count_by_project(req.project_id).await.map_err(e)?;
    if count >= DRAFT_MAX_PER_PROJECT {
        return Err(e(AppError::unprocessable_entity(
            "DRAFT_LIMIT_REACHED",
            format!("this project already has the maximum of {DRAFT_MAX_PER_PROJECT} drafts"),
        )));
    }
    let draft = repo
        .create(
            req.kind.trim(),
            req.project_id,
            &data,
            auth.user.id,
            req.parent_frozen_artifact_id,
        )
        .await
        .map_err(e)?;
    publish_draft(
        &pool,
        draft.project_id,
        SyncAction::Create,
        draft.id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::CREATED, Json(draft)))
}

pub async fn get_draft(
    auth: RequirePermissions<(DraftsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<super::models::Draft>> {
    let (draft, _scope) = resolve_draft(&pool, id, auth.user.id).await?;
    Ok((StatusCode::OK, Json(draft)))
}

pub async fn update_draft(
    auth: RequirePermissions<(DraftsUse,)>,
    Extension(pool): Extension<PgPool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateDraftRequest>,
) -> ApiResult<Json<super::models::Draft>> {
    validate_data_size(&req.data)
        .map_err(|m| e(AppError::unprocessable_entity("DRAFT_DATA_TOO_LARGE", m)))?;
    let (draft, scope) = resolve_draft(&pool, id, auth.user.id).await?;
    scope.require_can_edit().map_err(e)?;
    let repo = DraftRepository::new(pool.clone());
    // Editing ALWAYS flips a frozen draft back to open (DEC-3) — done in the repo SQL.
    let updated = repo.update_data(draft.id, &req.data).await.map_err(e)?;
    publish_draft(
        &pool,
        updated.project_id,
        SyncAction::Update,
        updated.id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::OK, Json(updated)))
}

pub async fn delete_draft(
    auth: RequirePermissions<(DraftsUse,)>,
    Extension(pool): Extension<PgPool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
) -> ApiResult<()> {
    let (draft, scope) = resolve_draft(&pool, id, auth.user.id).await?;
    scope.require_can_edit().map_err(e)?;
    let repo = DraftRepository::new(pool.clone());
    repo.delete(draft.id).await.map_err(e)?;
    publish_draft(
        &pool,
        draft.project_id,
        SyncAction::Delete,
        draft.id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::NO_CONTENT, ()))
}

/// `GET /drafts/artifacts/{artifact_id}/lineage` — the frozen-artifact version chain (INV-7).
///
/// Walks the artifact's `parent_artifact_id` links newest-first. Owner-scoped: when the artifact
/// IS a draftable-frozen version, the acting user must be able to see its draft's project (a
/// foreign/invisible project → 404, no existence oracle — INV-3). An artifact that is not a
/// draftable-frozen version (or whose lineage row was GC'd) yields an EMPTY chain (200) — the
/// FE renders no lineage readout for it, and nothing about another user's data is disclosed.
pub async fn get_artifact_lineage(
    auth: RequirePermissions<(DraftsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(artifact_id): Path<Uuid>,
) -> ApiResult<Json<DraftLineageResponse>> {
    let repo = DraftRepository::new(pool.clone());
    let chain = repo.lineage_chain(artifact_id).await.map_err(e)?;
    // Owner-scope on the draft that minted the requested version (chain head). Empty ⇒ not a
    // draftable-frozen version ⇒ nothing to scope and nothing to disclose.
    if let Some(head) = chain.first() {
        // A surviving chain implies a live draft (a deleted draft cascades its lineage rows); a
        // vanished draft here ⇒ treat as no lineage. Resolving via the draft reuses the
        // project-invisible-⇒-404 idiom (a foreign project's version chain is never returned).
        match repo.get(head.draft_id).await.map_err(e)? {
            Some(d) => {
                let _ = resolve_project_scope(&pool, d.project_id, auth.user.id).await?;
            }
            None => {
                return Ok((StatusCode::OK, Json(DraftLineageResponse { chain: vec![] })));
            }
        }
    }
    Ok((StatusCode::OK, Json(DraftLineageResponse { chain })))
}

pub async fn freeze_draft(
    auth: RequirePermissions<(DraftsUse,)>,
    Extension(pool): Extension<PgPool>,
    _origin: SyncOrigin,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<FreezeResponse>> {
    // DEC-2 final: enqueue a freeze PRODUCER job and return 202 immediately — never
    // await the run (a full sandbox run) while holding the HTTP request. The client
    // polls the draft (or the returned `freeze_job_id`) for `frozen`, or refetches on
    // the `Draft/Update` sync the freeze-completion hook emits (INV-6).
    let (draft, scope) = resolve_draft(&pool, id, auth.user.id).await?;
    scope.require_can_edit().map_err(e)?;
    // INV-5 idempotent: an unchanged frozen draft (an edit would have flipped it back to
    // `open`, DEC-3) returns its existing artifact with NO new job.
    if draft.status == DRAFT_STATUS_FROZEN && draft.frozen_artifact_id.is_some() {
        return Ok((
            StatusCode::OK,
            Json(FreezeResponse {
                draft,
                freeze_job_id: None,
            }),
        ));
    }
    // Enqueue (or reuse an in-flight) freeze producer. A draft whose opaque `kind` names
    // no declared producer is refused SYNCHRONOUSLY (422) — the one error a client can
    // act on without polling.
    let freeze_job_id = super::freeze::enqueue_freeze_for_draft(&pool, &draft, auth.user.id)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(FreezeResponse {
            draft,
            freeze_job_id: Some(freeze_job_id),
        }),
    ))
}
