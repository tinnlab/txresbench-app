//! Provenance HTTP handlers (ITEM-30). Gated by the module perms + the per-project
//! role (`authz::require_project_*`, foreign→404). Owner-scoped sync emits on
//! capture/export; settings PUT invalidates the cache + emits.

use axum::extract::{Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};

use crate::modules::permissions::{active_group_ids, RequirePermissions};
use crate::modules::sync::{
    fan_out_owner_scoped, publish, Actor, Audience, SyncAction, SyncEntity, SyncOrigin,
};

use super::authz;
use super::export::bundle;
use super::graph;
use super::interaction;
use super::models::*;
use super::permissions::{
    ProvenanceExport, ProvenanceRead, ProvenanceSettingsManage, ProvenanceSettingsRead,
};
use super::repository::{ProvenanceRepository, VerificationRow};
use super::settings::{ProvenanceSettings, ProvenanceSettingsRepository, UpdateProvenanceSettings};
use super::settings_cache;
use super::verify::diff::ToleranceMode;
use super::verify::runner;
use crate::modules::jobs::repository::JobRepository;
use crate::modules::jobs::settings::JobSettingsRepository;

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GraphQuery {
    pub project_id: Uuid,
    pub target: Option<Uuid>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RunsQuery {
    pub project_id: Uuid,
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

// ------------------------------------ graph ----------------------------------

pub async fn get_graph(
    auth: RequirePermissions<(ProvenanceRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<GraphQuery>,
) -> ApiResult<Json<GraphDto>> {
    authz::require_project_read(&pool, q.project_id, auth.user.id).await?;
    // Thread the CALLER's identity into the walk so a dataset referenced by a
    // project run that the caller cannot see is filtered out (over-disclosure guard).
    let group_ids = active_group_ids(&auth.groups);
    let dto = graph::read_graph(&pool, q.project_id, q.target, auth.user.id, &group_ids)
        .await
        .map_err(e)?;
    Ok((StatusCode::OK, Json(dto)))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ForwardQuery {
    pub dataset_id: Uuid,
}

/// Forward lineage from a dataset (ITEM-21 / DEC-20): everything derived from THIS
/// dataset until the end. Dataset-scoped (processing needs no project, DEC-5) —
/// authorized by owner/sharee VISIBILITY; a foreign/invisible dataset → 404.
pub async fn get_forward(
    auth: RequirePermissions<(ProvenanceRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<ForwardQuery>,
) -> ApiResult<Json<ForwardGraphDto>> {
    let group_ids = active_group_ids(&auth.groups);
    let visible = crate::modules::dataset::repository::DatasetRepository::new(pool.clone())
        .is_visible_to(q.dataset_id, auth.user.id, &group_ids)
        .await
        .map_err(e)?;
    if !visible {
        return Err(e(AppError::not_found("Dataset")));
    }
    // The forward walk crosses promote boundaries into downstream datasets; pass
    // the caller's identity so a PRIVATE downstream dataset (not visible to this
    // sharee) is excluded from the graph (cross-user leak guard) — authorizing the
    // start dataset alone is NOT sufficient.
    let dto = graph::read_forward_graph(&pool, q.dataset_id, auth.user.id, &group_ids)
        .await
        .map_err(e)?;
    Ok((StatusCode::OK, Json(dto)))
}

// ------------------------------------ runs -----------------------------------

pub async fn list_runs(
    auth: RequirePermissions<(ProvenanceRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<RunsQuery>,
) -> ApiResult<Json<RunsPageDto>> {
    authz::require_project_read(&pool, q.project_id, auth.user.id).await?;
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(10).clamp(1, 500);
    let repo = ProvenanceRepository::new(pool);
    let (rows, total) = repo.list_runs(q.project_id, page, per_page).await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(RunsPageDto {
            runs: rows.iter().map(graph::run_to_dto).collect(),
            total,
            page,
            per_page,
        }),
    ))
}

pub async fn get_run(
    auth: RequirePermissions<(ProvenanceRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<RunNodeDto>> {
    let repo = ProvenanceRepository::new(pool.clone());
    let row = repo
        .get_run(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Provenance run")))?;
    // The run's project governs access; a foreign project → 404 (no leak). A
    // dataset-scoped run node (owner processing / promote, project_id NULL) is not
    // served by this project-oriented endpoint — the datasets lineage surface is
    // ITEM-20/21; until then such a run reads as 404 here (no leak).
    match row.project_id {
        Some(sid) => authz::require_project_read(&pool, sid, auth.user.id).await?,
        None => return Err(e(AppError::not_found("Provenance run"))),
    }
    Ok((StatusCode::OK, Json(graph::run_to_dto(&row))))
}

// -------------------------------- interaction --------------------------------

/// Fan a captured run node to the PROJECT's audience (current account members ∪
/// accepted recipients — #168),
/// not to the acting user alone.
///
/// `record_selection` / `record_action` are gated by `require_project_edit`, so a
/// project EDITOR reaches them — and the frame used to be addressed to
/// `Audience::owner(auth.user.id)`, i.e. the actor. The provenance runs list the FE
/// refetches is scoped by `project_id`, so an editor's capture never reached the
/// project OWNER's graph: the same who-acted-vs-whose-data confusion the dataset
/// upload path had. Mirrors `workstore::sync::publish_artifact`, which already
/// resolves this exact audience for artifacts.
async fn publish_run_to_project(
    pool: &SqlitePool,
    project_id: Uuid,
    run_id: Uuid,
    actor: Actor,
) {
    let repo = crate::modules::project::ProjectRepository::new(pool.clone());
    let Ok(Some((owner, recipients))) =
        crate::modules::project::scope::project_audience(&repo, project_id).await
    else {
        // A resolution hiccup must not fail an already-recorded run; the 60s sync
        // re-check / next reconnect is the backstop.
        tracing::warn!(%project_id, %run_id, "provenance capture: project audience unresolved or empty; skipping sync emit");
        return;
    };
    fan_out_owner_scoped(
        SyncEntity::Provenance,
        SyncAction::Create,
        run_id,
        owner,
        &recipients,
        actor,
    );
}

pub async fn record_selection(
    auth: RequirePermissions<(ProvenanceRead,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(req): Json<RecordSelectionRequest>,
) -> ApiResult<Json<RunNodeDto>> {
    authz::require_project_edit(&pool, req.project_id, auth.user.id).await?;
    let run = interaction::capture_selection(
        &pool,
        req.project_id,
        auth.user.id,
        req.input_artifact_id,
        req.recipe,
        req.label,
    )
    .await
    .map_err(e)?;
    publish_run_to_project(
        &pool,
        req.project_id,
        run.run_id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::CREATED, Json(run)))
}

pub async fn record_action(
    auth: RequirePermissions<(ProvenanceRead,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(req): Json<RecordActionRequest>,
) -> ApiResult<Json<RunNodeDto>> {
    authz::require_project_edit(&pool, req.project_id, auth.user.id).await?;
    // Dispatchable types come from `action_registry::catalog()` — `selection.*`
    // plus `subset.filter` (enforced again in capture).
    if !super::action_registry::is_dispatchable(&req.action_type) {
        return Err(e(AppError::bad_request(
            "PROVENANCE_ACTION_NOT_DISPATCHABLE",
            format!("action type '{}' is not dispatchable this round", req.action_type),
        )));
    }
    let run = interaction::capture_action(
        &pool,
        req.project_id,
        auth.user.id,
        &req.action_type,
        req.input_artifact_id,
        req.recipe,
        req.label,
    )
    .await
    .map_err(e)?;
    publish_run_to_project(
        &pool,
        req.project_id,
        run.run_id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::CREATED, Json(run)))
}

// --------------------------------- verification ------------------------------

fn verification_to_dto(row: VerificationRow) -> VerificationDto {
    VerificationDto {
        id: row.id,
        target_run_id: row.target_run_id,
        project_id: row.project_id,
        status: row.status,
        tolerance_mode: row.tolerance_mode,
        diff_report: row.diff_report,
        rootfs_digest: row.rootfs_digest,
        cert_json: row.cert_json,
        verified_at: row.verified_at,
        created_at: row.created_at,
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct VerificationsQuery {
    pub project_id: Uuid,
    pub target_run_id: Option<Uuid>,
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

/// Re-run a recorded compute run + verify its outputs against the recorded
/// signature. Requires project EDIT (it spawns a real sandbox re-run — a
/// write/execute-class action, not a read) + the `provenance::export` capability,
/// and claims a bounded concurrency slot (429 when the verify queue is full).
/// Inserts a `pending` verification, spawns the detached re-run, and returns the
/// pending row (202 Accepted); the client refetches on
/// `sync:provenance_verification`.
pub async fn verify(
    auth: RequirePermissions<(ProvenanceExport,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<VerifyRequest>,
) -> ApiResult<Json<VerificationDto>> {
    // Edit-level per-project role: triggering an expensive re-run is not a read.
    authz::require_project_edit(&pool, req.project_id, auth.user.id).await?;
    let repo = ProvenanceRepository::new(pool.clone());
    // The target run must exist AND belong to the project (foreign → 404, no leak).
    let run = repo
        .get_run(req.target_run_id)
        .await
        .map_err(e)?
        .filter(|r| r.project_id == Some(req.project_id))
        .ok_or_else(|| e(AppError::not_found("Provenance run")))?;
    let mode = ToleranceMode::parse(req.tolerance_mode.as_deref());
    let id = Uuid::new_v4();

    // ADMISSION + IDENTITY, in one statement, BEFORE any other row exists.
    //
    // A verification re-run is a full bwrap child, and it used to have no `jobs` row:
    // it could not be listed, could not be stopped by anyone (not even an admin), and
    // — because the cap counts `jobs WHERE status = 'running'` — was invisible to
    // admission control, which enforced a private `Semaphore::new(4)` ALONGSIDE
    // `max_concurrent_jobs` rather than under it. Two caps over one CPU pool sum, they
    // do not bound.
    //
    // Minting the row buys the whole surface at once — list, get, logs, stream, stop,
    // sync fan-out, boot reconcile, the stale-workspace sweep are all keyed on it —
    // instead of five parallel mechanisms for one caller. It also changes what a
    // verification IS to a user, deliberately and for the better: a listable, stoppable
    // run rather than a spinner nobody can end.
    //
    // Scoped to the PROJECT, so `resolve_job_reach` gives the project's editors sight
    // and its owner (plus the requester, who owns the row) the authority to stop —
    // exactly the rule every other project-scoped job follows. A scope-less row would
    // be creator-and-admin-only, which is the hole one layer down.
    let (cap, _reserved) = JobSettingsRepository::new(pool.clone()).cap_and_reserved().await;
    let job = JobRepository::new(pool.clone())
        .create_running_under_cap(
            id,
            auth.user.id,
            "verify",
            &format!("Verify run {}", &run.run_id.to_string()[..8]),
            serde_json::json!({
                "target_run_id": run.run_id,
                "tolerance_mode": mode.as_str(),
            }),
            Some(req.project_id),
            cap,
        )
        .await
        .map_err(e)?;
    if job.is_none() {
        return Err(e(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "VERIFY_QUEUE_FULL",
            "the compute pool is full; retry shortly",
        )));
    }
    // Register the cancel signal BEFORE the run can start, so a stop racing the spawn
    // is never lost — the same ordering `dispatch_ready` uses at claim time. The
    // detached task picks this receiver up via `cancel_receiver`.
    let _cancel_rx = crate::modules::jobs::runtime::runtime().register_cancel(id);

    // If the verification row cannot be written, the job row minted above must not be
    // left `running`: nothing would ever close it, and a `running` row permanently
    // consumes a slot of `max_concurrent_jobs`. Close it before returning the error.
    let row = match repo
        .insert_verification(id, run.run_id, req.project_id, mode.as_str())
        .await
    {
        Ok(row) => row,
        Err(err) => {
            let repo = JobRepository::new(pool.clone());
            if let Err(e2) = repo.fail(id, "verification row could not be created").await {
                tracing::error!(job_id = %id, error = %e2, "verify: failed to release the job slot after insert_verification failed");
            }
            crate::modules::jobs::runtime::runtime().close_job(id);
            return Err(e(err));
        }
    };
    runner::spawn_verification(pool, id, run.run_id, auth.user.id, mode);
    Ok((StatusCode::ACCEPTED, Json(verification_to_dto(row))))
}

/// List verifications for a project (optionally one target run), newest-first,
/// paginated (bounded — default 50, cap 500).
pub async fn list_verifications(
    auth: RequirePermissions<(ProvenanceRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<VerificationsQuery>,
) -> ApiResult<Json<VerificationsResponse>> {
    authz::require_project_read(&pool, q.project_id, auth.user.id).await?;
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 500);
    let rows = ProvenanceRepository::new(pool)
        .list_verifications(q.project_id, q.target_run_id, page, per_page)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(VerificationsResponse {
            verifications: rows.into_iter().map(verification_to_dto).collect(),
        }),
    ))
}

// ------------------------------------ export ---------------------------------

pub async fn export(
    auth: RequirePermissions<(ProvenanceExport,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<ExportRequest>,
) -> ApiResult<Json<ExportResponse>> {
    authz::require_project_read(&pool, req.project_id, auth.user.id).await?;
    // The export closure folds a project's datasets' owner-lineage; pass the caller's
    // identity so a dataset the caller cannot see is excluded from the bundle
    // (same over-disclosure guard as the graph read).
    let group_ids = active_group_ids(&auth.groups);
    let export_id =
        bundle::build_bundle(&pool, req.project_id, req.target, &req.scope, auth.user.id, &group_ids)
            .await
            .map_err(e)?;
    // Building an export deliberately publishes NOTHING. `SyncEntity::Provenance`
    // means "a provenance RUN NODE changed" and its `id` is that run's id — the
    // vocabulary `publish_run_to_project` uses, the FE echo pins, and every other
    // entity in this app follows (`id` is the primary key of a row of the type the
    // entity names; a settings singleton uses `Uuid::nil()`). This site used to send
    // `req.project_id` on that same entity, which made `{entity: provenance, id: X}`
    // ambiguous: a subscriber could not tell whether `X` named a run or a project.
    //
    // The resolution is deletion rather than a corrected id, because there is no id
    // it could correctly carry: `build_bundle` mutates NO row. The bundle lives in a
    // process-local in-memory store, is consumed by the first authorized download,
    // has no list endpoint and no renderer — so the frame was inert, which is what
    // the channel-parity guard condemns. It was in fact worse than inert: sent with
    // `origin: None` it was NOT suppressed for the acting connection, so the actor's
    // own tab refetched the runs list and the graph, neither of which an export
    // changes, on every Build click.
    //
    // EXIT CONDITION: if exports ever become durable rows with a list endpoint and a
    // surface that renders them, they get their OWN `SyncEntity` (e.g.
    // `ProvenanceExport`) whose `id` is the export id — NOT a second meaning loaded
    // onto this one.
    Ok((StatusCode::OK, Json(ExportResponse { export_id })))
}

/// Download a built bundle. A plain `Response` route (like the workstore
/// byte-serving path); the perm is enforced by the inline extractor + an
/// ownership re-check on the bundle's project.
pub async fn download_export(
    auth: RequirePermissions<(ProvenanceExport,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> Response {
    let Some(record) = bundle::read_bundle(id) else {
        return e(AppError::not_found("Export")).into_response();
    };
    if let Err(err) = authz::require_project_read(&pool, record.project_id, auth.user.id).await {
        return err.into_response();
    }
    // A successful, authorized download consumes the bundle (bound the in-memory
    // store; a re-download rebuilds).
    bundle::remove_bundle(id);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"provenance-export-{id}.zip\""),
            ),
            (header::CONTENT_LENGTH, record.bytes.len().to_string()),
        ],
        record.bytes,
    )
        .into_response()
}

// ----------------------------------- settings --------------------------------

pub async fn get_settings(
    _auth: RequirePermissions<(ProvenanceSettingsRead,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<ProvenanceSettings>> {
    let row = ProvenanceSettingsRepository::new(pool).get().await.map_err(e)?;
    Ok((StatusCode::OK, Json(row)))
}

pub async fn update_settings(
    auth: RequirePermissions<(ProvenanceSettingsManage,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(body): Json<UpdateProvenanceSettings>,
) -> ApiResult<Json<ProvenanceSettings>> {
    let repo = ProvenanceSettingsRepository::new(pool);
    let current = repo.get().await.map_err(e)?;
    let merged = ProvenanceSettingsRepository::merge(&current, &body);
    merged.validate().map_err(e)?;
    // Stamp the acting admin into `updated_by` (audit, #54; the `*_by` idiom).
    let row = repo.update(&body, auth.user.id).await.map_err(e)?;
    settings_cache::invalidate(row.clone());
    publish(
        SyncEntity::ProvenanceSettings,
        SyncAction::Update,
        Uuid::nil(),
        Audience::perm::<ProvenanceSettingsRead>(),
        origin.0,
    );
    Ok((StatusCode::OK, Json(row)))
}
