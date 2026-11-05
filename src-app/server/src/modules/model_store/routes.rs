//! The model store's HTTP surface (PLAN Phase E + F, PROV-MS-2..MS-9) — the
//! inventory (J/I), the save flow (L/L2), the `.txr` import/export (J's "open
//! a model file" / L's "also save as a file"), the set CRUD, the verified
//! reuse resolution (PROV-MS-8) and the per-model eligibility (PROV-MS-9,
//! ITEM-6's `eligibility.rs`). The doc ids for all thirteen are declared in
//! [`super::types::ROUTE_DOC_IDS`].
//!
//! All routes mount through [`super::ModelStoreModule::register_routes`] under
//! the framework's `/api` prefix — `/api/txr/models*` +
//! `/api/txr/model-sets*` — and are gated by the REUSED `jobs::use`
//! permission (DEC-14: no new permission, A10 not triggered; the local owner
//! passes automatically).
//!
//! ## Handler posture
//!
//! Handlers are thin transport: the save core + the import seam live in
//! [`super::store`] (where the tree layer + the in-process seams already
//! live), and every projection of a row back into a wire type is the store's
//! `summary_from` / `detail_from` / `set_summary_from` (the recorded facts
//! are ever only rendered, never re-derived). The two heavy walks — a large
//! `.txr` container's streaming extraction on import, a large export's write
//! on export — run through `spawn_blocking` (a 16 GiB container must never
//! block a tokio worker); tree copies are per-tree fs walks of the user's own
//! saved models.
//!
//! ## Error mapping (closed, documented)
//!
//! - `400` — the request-validation codes (`EMPTY_METHODS`,
//!   `INVALID_SET_NAME`, `INVALID_NAME`, `INVALID_TARGET`, `EMPTY_MODELS`,
//!   `TOO_MANY_MODELS` — the store's typed `ModelRequestError`, mapped by its
//!   code + the offending field) and the import's container codes
//!   (`INVALID_CONTAINER`, `CONTAINER_TOO_LARGE`, `UNSAFE_PATH`,
//!   `INVALID_SET_ID`) + the seam's `MODEL_VERIFY_FAILED`.
//! - `404` — `MODEL_NOT_FOUND`, `SET_NOT_FOUND`, `RUN_NOT_FOUND`,
//!   `MODEL_ASSET_UNKNOWN`.
//! - `409` — `SET_NAME_TAKEN` (the repository's domain conflict), the
//!   save flow's `METHOD_NOT_FINISHED` / `METHOD_NOT_IN_CATALOGUE`, and the
//!   resolve flow's `MODEL_VERIFY_FAILED` (a host_dir that no longer matches
//!   its recorded digest — the asset does not leave).
//! - `422 LICENCE_REQUIRED` — never through the REST import (a reservation
//!   for the pretrained seam, PROV-MS-6).
//! - A body that is syntactically invalid JSON is the framework's `400`
//!   (JsonSyntaxError); one that does not match the schema is the framework's
//!   `422` (JsonDataError).

use aide::axum::routing::{delete_with, get_with, patch_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};

use crate::modules::file::stream::{multipart_error, read_text_capped, stage_multipart_field, StagedPart};
use crate::modules::jobs::JobsUse;
use crate::modules::model_store::types::ImportOutcome;
use crate::modules::permissions::{with_permission, RequirePermissions};

use super::eligibility;
use super::repository::ModelStoreRepository;
use super::store;
use super::types::{
    ModelDetail, ModelEligibilityRequest, ModelEligibilityResponse, ModelListQuery,
    ModelListResponse, ModelRequestError, ModelSaveResponse, ModelSetListResponse, ModelSummary,
    RenameRequest, ResolveRequest, ResolveResponse, SaveModelsRequest, SetDeleteQuery,
    SetSummary,
};

/// The import/export stream chunk (the workstore's `STREAM_CHUNK_BYTES`
/// precedent — never a whole-container buffer).
const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// The module's route set under `/api/txr/` (registered by
/// `register_routes`; no root catch-all — the `/api` prefix stays the
/// framework's).
pub fn model_store_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/txr/models/save", post_with(save_models, save_models_docs))
        .api_route("/txr/models/import", post_with(import_model, import_model_docs).layer(DefaultBodyLimit::disable()))
        .api_route(
            "/txr/models",
            get_with(list_models, list_models_docs),
        )
        .api_route("/txr/models/{id}", get_with(get_model, get_model_docs))
        .api_route("/txr/models/{id}", patch_with(rename_model, rename_model_docs))
        .api_route("/txr/models/{id}", delete_with(delete_model, delete_model_docs))
        .api_route(
            "/txr/models/{id}/export",
            get_with(export_model, export_model_docs).layer(DefaultBodyLimit::disable()),
        )
        .api_route("/txr/model-sets", get_with(list_sets, list_sets_docs))
        .api_route("/txr/model-sets/{id}", patch_with(rename_set, rename_set_docs))
        .api_route("/txr/model-sets/{id}", delete_with(delete_set, delete_set_docs))
        .api_route(
            "/txr/model-sets/{id}/export",
            get_with(export_set, export_set_docs).layer(DefaultBodyLimit::disable()),
        )
        .api_route(
            "/txr/models/resolve",
            post_with(resolve_models, resolve_models_docs),
        )
        .api_route(
            "/txr/models/eligibility",
            post_with(check_eligibility, check_eligibility_docs),
        )
}

/// The `ModelRequestError` 400 layer (one mapping, every request-validation
/// code).
fn request_err(e: ModelRequestError) -> (StatusCode, AppError) {
    AppError::bad_request(e.code.code(), e.to_string()).to_api_error()
}

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-2 — GET /api/txr/models + GET /api/txr/models/{id}
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/models` — the inventory (J's model lines + I's per-run
/// rows). Filters per PROV-MS-2 (`set_id`, `q` substring on name/method id,
/// `provenance`); no pagination (DEC-19); `models_dir` exposed once here for
/// J's "Open the folder".
async fn list_models(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<ModelListQuery>,
) -> ApiResult<Json<ModelListResponse>> {
    let repo = ModelStoreRepository::new(pool);
    let provenance = q.provenance.map(|p| p.as_str().to_string());
    let rows = repo
        .list_models(q.set_id, q.q.as_deref(), provenance.as_deref())
        .await
        .map_err(e)?;
    let set_names = store::set_name_map(&repo).await.map_err(e)?;
    let mut models = Vec::with_capacity(rows.len());
    for row in &rows {
        let set_name = row
            .set_id
            .as_ref()
            .and_then(|sid| set_names.get(sid))
            .map(|s| s.as_str());
        models.push(store::summary_from(row, set_name).map_err(e)?);
    }
    let total = models.len() as u32;
    Ok((
        StatusCode::OK,
        Json(ModelListResponse {
            models,
            total,
            models_dir: Some(store::models_dir().display().to_string()),
        }),
    ))
}

/// `GET /api/txr/models/{id}` — one model's full recorded fact set
/// (PROV-MS-2: the summary flatten + the recorded requirements, env digests,
/// content-addressed dir and the catalogue-consistency warnings).
async fn get_model(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ModelDetail>> {
    let repo = ModelStoreRepository::new(pool);
    let row = repo.get_model(id).await.map_err(e)?.ok_or_else(|| {
        AppError::new(StatusCode::NOT_FOUND, "MODEL_NOT_FOUND", format!("no model {id}"))
            .to_api_error()
    })?;
    let set_name = match row.set_id {
        Some(sid) => repo.get_set(sid).await.map_err(e)?.map(|s| s.name),
        None => None,
    };
    Ok((StatusCode::OK, Json(store::detail_from(&row, set_name.as_deref()).map_err(e)?)))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-3 — POST /api/txr/models/save
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/models/save` (201) — the save flow's thin transport: the
/// core is [`store::save_from_run`] (the run seam's produced models + the
/// bundle facts + the catalogue facts → trees + rows + optional training
/// copy + optional one-off export).
async fn save_models(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<SaveModelsRequest>,
) -> ApiResult<Json<ModelSaveResponse>> {
    let resp = store::save_from_run(&pool, &req).await.map_err(e)?;
    Ok((StatusCode::CREATED, Json(resp)))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-6 — POST /api/txr/models/import
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/models/import` (201) — the colleague flow. The `file` part
/// (the `.txr` container) is STREAMED to the uploads staging area
/// (`stage_multipart_field` — the dataset-upload pattern; the container byte
/// cap is the codec's own bound, so no body ceiling is imposed on the
/// multipart envelope), the optional `set_id` text field names an existing
/// set to import into (the merge path). The stage is then read + verified +
/// installed through the store's import seam — provenance `imported` +
/// `imported_from` = the multipart file name (board J).
async fn import_model(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    mut multipart: Multipart,
) -> ApiResult<Json<ImportOutcome>> {
    let mut file_part: Option<(String, StagedPart)> = None;
    let mut set_id: Option<Uuid> = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| e(multipart_error("INVALID_MULTIPART", "Malformed multipart body", &err)))?
    {
        let field_name = field.name().map(|n| n.to_string());
        match field_name.as_deref() {
            Some("file") => {
                let filename = field
                    .file_name()
                    .filter(|f| !f.trim().is_empty())
                    .map(|f| f.to_string())
                    .unwrap_or_else(|| "models.txr".to_string());
                let staged = stage_multipart_field(&mut field).await.map_err(e)?;
                file_part = Some((filename, staged));
            }
            Some("set_id") => {
                let raw = read_text_capped(&mut field, "set_id", "INVALID_SET_ID", "Failed to read set_id")
                    .await
                    .map_err(e)?;
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    let parsed = Uuid::parse_str(trimmed).map_err(|err| {
                        e(AppError::bad_request(
                            "INVALID_SET_ID",
                            format!("set_id must be a UUID: {err}"),
                        ))
                    })?;
                    set_id = Some(parsed);
                }
            }
            _ => {}
        }
    }
    let Some((filename, staged)) = file_part else {
        return Err(e(AppError::bad_request(
            "MISSING_FILE",
            "Multipart body has no `file` field",
        )));
    };
    let opts = store::ImportOptions {
        set_id,
        provenance: store::Provenance::Imported {
            source_name: filename,
        },
    };
    let staged_path = staged.path().ok_or_else(|| {
        e(AppError::internal_error(
            "the staged import file was consumed before the container read",
        ))
    })?;
    let outcome = store::install_imported_from_path(&pool, staged_path, &opts)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::CREATED,
        Json(ImportOutcome {
            models: outcome.models,
            set_id: outcome.set_id,
        }),
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-5 — PATCH/DELETE /api/txr/models/{id}
// ─────────────────────────────────────────────────────────────────────────────

/// `PATCH /api/txr/models/{id}` — the display label (board J's Rename; a
/// label is not an identity, so no uniqueness rule).
async fn rename_model(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Json(req): Json<RenameRequest>,
) -> ApiResult<Json<ModelSummary>> {
    req.validate().map_err(request_err)?;
    let repo = ModelStoreRepository::new(pool);
    let ok = repo.rename_model(id, req.name.trim()).await.map_err(e)?;
    if !ok {
        return Err(AppError::new(StatusCode::NOT_FOUND, "MODEL_NOT_FOUND", format!("no model {id}")).to_api_error());
    }
    let row = repo.get_model(id).await.map_err(e)?.expect("renamed row exists");
    let set_name = match row.set_id {
        Some(sid) => repo.get_set(sid).await.map_err(e)?.map(|s| s.name),
        None => None,
    };
    Ok((StatusCode::OK, Json(store::summary_from(&row, set_name.as_deref()).map_err(e)?)))
}

/// `DELETE /api/txr/models/{id}` (204) — removes the row; the tree dir is
/// pruned when no other row references its digest (board J: "Deleting a model
/// removes its file"; DEC-3's last-reference rule). Run records are never
/// touched (DEC-17).
async fn delete_model(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<()> {
    let repo = ModelStoreRepository::new(pool.clone());
    let row = repo.get_model(id).await.map_err(e)?.ok_or_else(|| {
        AppError::new(StatusCode::NOT_FOUND, "MODEL_NOT_FOUND", format!("no model {id}")).to_api_error()
    })?;
    repo.delete_model(id).await.map_err(e)?;
    store::prune_unreferenced_tree(&pool, &row.tree_sha256).await.map_err(e)?;
    Ok((StatusCode::NO_CONTENT, ()))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-7 — GET /api/txr/models/{id}/export + GET /api/txr/model-sets/{id}/export
// ─────────────────────────────────────────────────────────────────────────────

/// The streamed attachment for an export: the container is written as a
/// complete file (the store's staging + rename) and streamed from disk — the
/// container is never buffered whole.
async fn stream_container(path: std::path::PathBuf, attachment: String) -> Result<Response, (StatusCode, AppError)> {
    let file = tokio::fs::File::open(&path).await.map_err(|io_err| {
        e(AppError::internal_error(format!("open the exported container {}: {io_err}", path.display())))
    })?;
    let len = file
        .metadata()
        .await
        .map(|m| m.len())
        .map_err(|e2| e(AppError::internal_error(format!("stat the exported container: {e2}"))))?;
    let stream = tokio_util::io::ReaderStream::with_capacity(file, STREAM_CHUNK_BYTES);
    let body = Body::from_stream(stream);
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{attachment}\""),
            ),
        ],
        body,
    )
        .into_response())
}

/// `GET /api/txr/models/{id}/export` — the single-model `.txr` container
/// (kind `model`; the attachment name is the sanitized model name + `.txr`).
async fn export_model(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    let repo = ModelStoreRepository::new(pool);
    let row = repo.get_model(id).await.map_err(e)?.ok_or_else(|| {
        AppError::new(StatusCode::NOT_FOUND, "MODEL_NOT_FOUND", format!("no model {id}")).to_api_error()
    })?;
    let export = store::export_model(&row).map_err(e)?;
    let id8 = &row.id.simple().to_string()[..8];
    let file_name = format!("{}-{id8}.txr", store::set_slug(&row.name));
    let path_c = file_name.clone();
    let (path, _len) = tokio::task::spawn_blocking(move || store::write_export_file(&path_c, &export))
        .await
        .map_err(|join_err| e(AppError::internal_error(format!("export write task join: {join_err}"))))?
        .map_err(e)?;
    let attachment = format!("{}.txr", store::sanitize_attachment_name(&row.name));
    let resp = stream_container(path, attachment).await?;
    Ok((StatusCode::OK, resp))
}

/// `GET /api/txr/model-sets/{id}/export` — the whole-set `.txr` container
/// (kind `set`: every model of the set + the kept training files) — the
/// colleague flow's "send the whole thing".
async fn export_set(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    let repo = ModelStoreRepository::new(pool.clone());
    let set = repo.get_set(id).await.map_err(e)?.ok_or_else(|| {
        AppError::new(StatusCode::NOT_FOUND, "SET_NOT_FOUND", format!("no set {id}")).to_api_error()
    })?;
    let rows = repo.list_models(Some(id), None, None).await.map_err(e)?;
    if rows.is_empty() {
        return Err(e(AppError::new(
            StatusCode::CONFLICT,
            "EMPTY_SET",
            format!("set {id} holds no models; a .txr set container carries at least one"),
        )));
    }
    let training_dir = match &set.training_dir {
        Some(d) => std::path::PathBuf::from(d),
        None => std::path::PathBuf::new(),
    };
    let has_training = set.training_dir.is_some() && training_dir.is_dir();
    let export = store::export_set(&set, &rows, has_training.then_some(training_dir.as_path())).map_err(e)?;
    let id8 = &set.id.simple().to_string()[..8];
    let file_name = format!("{}-{id8}.txr", store::set_slug(&set.name));
    let path_c = file_name.clone();
    let (path, _len) = tokio::task::spawn_blocking(move || store::write_export_file(&path_c, &export))
        .await
        .map_err(|join_err| e(AppError::internal_error(format!("export write task join: {join_err}"))))?
        .map_err(e)?;
    let attachment = format!("{}.txr", store::sanitize_attachment_name(&set.name));
    let resp = stream_container(path, attachment).await?;
    Ok((StatusCode::OK, resp))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-4 — GET/PATCH/DELETE /api/txr/model-sets
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/model-sets` — the set inventory (J's sets / I's run
/// headers); no pagination (DEC-19), counts + summed sizes on the rows.
async fn list_sets(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<ModelSetListResponse>> {
    let repo = ModelStoreRepository::new(pool);
    let rows = repo.list_sets().await.map_err(e)?;
    let sets: Vec<SetSummary> = rows.iter().map(store::set_summary_from).collect();
    let total = sets.len() as u32;
    Ok((StatusCode::OK, Json(ModelSetListResponse { sets, total })))
}

/// `PATCH /api/txr/model-sets/{id}` — the set's name (DEC-10: case-
/// insensitive uniqueness; the repository's domain conflict → 409).
async fn rename_set(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Json(req): Json<RenameRequest>,
) -> ApiResult<Json<SetSummary>> {
    req.validate().map_err(request_err)?;
    let repo = ModelStoreRepository::new(pool.clone());
    let renamed = repo.rename_set(id, req.name.trim()).await.map_err(e)?;
    if !renamed {
        return Err(AppError::new(StatusCode::NOT_FOUND, "SET_NOT_FOUND", format!("no set {id}")).to_api_error());
    }
    let row = repo.get_set_with_counts(id).await.map_err(e)?.expect("renamed set exists");
    Ok((StatusCode::OK, Json(store::set_summary_from(&row))))
}

/// `DELETE /api/txr/model-sets/{id}` (204) — the default (`keep_files=false`)
/// is the cascade (DEC-10/D14: the set's rows + pruned unreferenced trees +
/// the training dir); `keep_files=true` removes the rows only and leaves the
/// files (the I board's "Delete the run's models" escape).
async fn delete_set(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Query(q): Query<SetDeleteQuery>,
) -> ApiResult<()> {
    let repo = ModelStoreRepository::new(pool.clone());
    let set = repo.get_set(id).await.map_err(e)?.ok_or_else(|| {
        AppError::new(StatusCode::NOT_FOUND, "SET_NOT_FOUND", format!("no set {id}")).to_api_error()
    })?;
    let rows = repo.list_models(Some(id), None, None).await.map_err(e)?;
    let digests: Vec<String> = rows.iter().map(|r| r.tree_sha256.clone()).collect();
    repo.delete_set(id).await.map_err(e)?;
    if q.keep_files {
        // Rows only — the tree dirs + training files stay (the board's
        // escape hatch; the inventory entry is what the delete removed).
        return Ok((StatusCode::NO_CONTENT, ()));
    }
    store::prune_unreferenced_trees(&pool, &digests).await.map_err(e)?;
    store::remove_training_dir(set.id).map_err(e)?;
    Ok((StatusCode::NO_CONTENT, ()))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-8 — POST /api/txr/models/resolve
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/models/resolve` (200) — the verified-artifact resolution
/// (the `execution-engine` reuse contract): each id → the row's asset record
/// with its `host_dir` RE-VERIFIED against the recorded `tree_sha256` before
/// it leaves (409 `MODEL_VERIFY_FAILED` — the engine only ever sees an honest
/// asset); the response's element shape is byte-compatible with
/// `CreateRunRequest.model_ids[]`, so `ui-models` passes it straight through.
async fn resolve_models(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<ResolveRequest>,
) -> ApiResult<Json<ResolveResponse>> {
    req.validate().map_err(request_err)?;
    let assets = store::resolve_assets(&pool, &req.model_ids).await.map_err(e)?;
    Ok((StatusCode::OK, Json(ResolveResponse { assets })))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MS-9 — POST /api/txr/models/eligibility
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/models/eligibility` (200) — the I list's per-model verdicts:
/// each model's RECORDED requirements against the file's inventory (the same
/// `InventoryEligibilityRequest` object `file-validator`'s validation carries
/// — one component feeds both eligibility providers). The verdicts use the
/// PROV-MC-5 reason vocabulary + `MODEL_REQUIREMENTS_UNRECORDED`; the times
/// come from the catalogue estimator.
async fn check_eligibility(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<ModelEligibilityRequest>,
) -> ApiResult<Json<ModelEligibilityResponse>> {
    req.validate().map_err(request_err)?;
    let resp = eligibility::eligible(&pool, &req.model_ids, &req.inventory)
        .await
        .map_err(e)?;
    Ok((StatusCode::OK, Json(resp)))
}

// ─────────────────────────────────────────────────────────────────────────────
// Route docs (the 13 doc ids are pinned by `types::ROUTE_DOC_IDS`; the ids
// below are the ITEM-5 half of that vocabulary — resolve + eligibility
// register with ITEM-6)
// ─────────────────────────────────────────────────────────────────────────────

fn list_models_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The saved-model inventory (unpaged, DEC-19): the J screen's model lines and the I screen's per-run rows, with optional `set_id` / `q` (case-insensitive substring on name or method id) / `provenance` filters. `models_dir` is the store's folder (J's \"Open the folder\", forwarded from the engine after the app move).")
        .id("Models.listModels")
        .tag("models")
        .response::<200, Json<ModelListResponse>>()
}

fn get_model_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("One model's full recorded fact set: the summary flatten plus the tree digest + dir, contract, env digests, the recorded requirements and the catalogue-consistency warnings. Unknown id → 404 MODEL_NOT_FOUND.")
        .id("Models.getModel")
        .tag("models")
        .response::<200, Json<ModelDetail>>()
        .response_with::<404, (), _>(|r| r.description("Unknown model id (MODEL_NOT_FOUND)"))
}

fn save_models_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Save the run's produced models into a set (L's \"Name of this set\" = a new set; L2's \"into an existing set\" = `set_id`), copying each produced tree into the content-addressed store, recording the requirements + how-it-did facts, optionally copying the training files and optionally writing the one-off `.txr` export. 201 with the set + the saved rows + the export record; 400 EMPTY_METHODS / INVALID_SET_NAME / INVALID_TARGET; 404 RUN_NOT_FOUND / MODEL_ASSET_UNKNOWN; 409 SET_NAME_TAKEN / METHOD_NOT_FINISHED / METHOD_NOT_IN_CATALOGUE.")
        .id("Models.saveModels")
        .tag("models")
        .response::<201, Json<ModelSaveResponse>>()
        .response_with::<400, (), _>(|r| r.description("EMPTY_METHODS / INVALID_SET_NAME / INVALID_TARGET"))
        .response_with::<404, (), _>(|r| r.description("RUN_NOT_FOUND / MODEL_ASSET_UNKNOWN"))
        .response_with::<409, (), _>(|r| r.description("SET_NAME_TAKEN / METHOD_NOT_FINISHED / METHOD_NOT_IN_CATALOGUE"))
}

fn import_model_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Import a `.txr` container (a colleague's model file, board J): multipart `file` part, streamed to disk and verified on arrival (magic/version, per-file sha256, restored-tree digest, path safety, size cap); an optional `set_id` form field merges into an existing set, else the container's recorded set is recreated (kind set) or the model stands alone (kind model). 201 with the restored rows; 400 INVALID_CONTAINER / CONTAINER_TOO_LARGE / UNSAFE_PATH / INVALID_SET_ID / MODEL_VERIFY_FAILED / MISSING_FILE; 404 SET_NOT_FOUND.")
        .id("Models.importModel")
        .tag("models")
        .response::<201, Json<ImportOutcome>>()
        .response_with::<400, (), _>(|r| r.description("INVALID_CONTAINER / CONTAINER_TOO_LARGE / UNSAFE_PATH / INVALID_SET_ID / MODEL_VERIFY_FAILED / MISSING_FILE"))
        .response_with::<404, (), _>(|r| r.description("SET_NOT_FOUND"))
}

fn export_model_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The single-model `.txr` container, streamed as an attachment (`<name>.txr`; the sanitized name has no path separators). The export is verified against the recorded tree digest before the first byte. Unknown id → 404 MODEL_NOT_FOUND.")
        .id("Models.exportModel")
        .tag("models")
        .response_with::<200, (), _>(|r| r.description("application/octet-stream — the .txr container"))
        .response_with::<404, (), _>(|r| r.description("Unknown model id (MODEL_NOT_FOUND)"))
}

fn rename_model_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Rename a model's display label (board J's Rename; a label is not an identity — 1..=80 chars, no uniqueness). Unknown id → 404 MODEL_NOT_FOUND.")
        .id("Models.renameModel")
        .tag("models")
        .response::<200, Json<ModelSummary>>()
        .response_with::<404, (), _>(|r| r.description("Unknown model id (MODEL_NOT_FOUND)"))
}

fn delete_model_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Delete a model (board J: \"Deleting a model removes its file\"): the row goes, the tree dir is pruned when no other row references its digest; run records are never touched (results already made stay in History). 204; unknown id → 404 MODEL_NOT_FOUND.")
        .id("Models.deleteModel")
        .tag("models")
        .response::<204, ()>()
        .response_with::<404, (), _>(|r| r.description("Unknown model id (MODEL_NOT_FOUND)"))
}

fn list_sets_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The set inventory (unpaged, DEC-19): each set with its model count + summed tree sizes, newest first — the J screen's saved sets and the I screen's run headers.")
        .id("ModelSets.listSets")
        .tag("model-sets")
        .response::<200, Json<ModelSetListResponse>>()
}

fn rename_set_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Rename a set (case-insensitively unique — 409 SET_NAME_TAKEN; a case-only self-rename is a no-op success). Unknown id → 404 SET_NOT_FOUND.")
        .id("ModelSets.renameSet")
        .tag("model-sets")
        .response::<200, Json<SetSummary>>()
        .response_with::<404, (), _>(|r| r.description("Unknown set id (SET_NOT_FOUND)"))
        .response_with::<409, (), _>(|r| r.description("SET_NAME_TAKEN"))
}

fn delete_set_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Delete a set and its models (DEC-10/D14's cascade default): the rows go and the now-unreferenced trees + the set's training dir are pruned; `keep_files=true` removes the rows only and leaves the files. 204; unknown id → 404 SET_NOT_FOUND.")
        .id("ModelSets.deleteSet")
        .tag("model-sets")
        .response::<204, ()>()
        .response_with::<404, (), _>(|r| r.description("Unknown set id (SET_NOT_FOUND)"))
}

fn export_set_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The whole-set `.txr` container, streamed as an attachment (`<set-name>.txr`): every model of the set + the kept training files. Unknown id → 404 SET_NOT_FOUND; an empty set refuses (409 EMPTY_SET — the format's set container carries at least one model).")
        .id("ModelSets.exportSet")
        .tag("model-sets")
        .response_with::<200, (), _>(|r| r.description("application/octet-stream — the .txr container"))
        .response_with::<404, (), _>(|r| r.description("Unknown set id (SET_NOT_FOUND)"))
        .response_with::<409, (), _>(|r| r.description("An empty set (EMPTY_SET)"))
}

fn resolve_models_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Resolve model ids to the verified asset records the run engine binds on reuse (PROV-MS-8): each asset's host_dir is re-verified against the recorded tree digest before it leaves, so the engine only ever sees an honest asset. The response element shape is byte-compatible with `CreateRunRequest.model_ids[]` (the caller-side join — the engine never imports this module). 400 EMPTY_MODELS / TOO_MANY_MODELS; 404 MODEL_NOT_FOUND; 409 MODEL_VERIFY_FAILED.")
        .id("Models.resolveModels")
        .tag("models")
        .response::<200, Json<ResolveResponse>>()
        .response_with::<400, (), _>(|r| r.description("EMPTY_MODELS / TOO_MANY_MODELS"))
        .response_with::<404, (), _>(|r| r.description("Unknown model id (MODEL_NOT_FOUND)"))
        .response_with::<409, (), _>(|r| r.description("A host_dir no longer matches its recorded digest (MODEL_VERIFY_FAILED)"))
}

fn check_eligibility_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The per-model eligibility verdicts for the I list: each model's RECORDED requirements against the file's inventory (the same `InventoryEligibilityRequest` one component feeds both eligibility providers). Verdicts use the PROV-MC-5 reason vocabulary plus MODEL_REQUIREMENTS_UNRECORDED (an imported container with no requirements is cannot_run — the store never invents requirements); the times come from the catalogue's estimator. 400 EMPTY_MODELS / TOO_MANY_MODELS; 404 MODEL_NOT_FOUND.")
        .id("Models.checkEligibility")
        .tag("models")
        .response::<200, Json<ModelEligibilityResponse>>()
        .response_with::<400, (), _>(|r| r.description("EMPTY_MODELS / TOO_MANY_MODELS"))
        .response_with::<404, (), _>(|r| r.description("Unknown model id (MODEL_NOT_FOUND)"))
}
