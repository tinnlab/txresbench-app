//! P2 REST introspection + host-lite convert (ITEM-16/17/20). aide-documented JSON
//! control plane (tag `datatype`), all gated by the REUSED `projects::use` (DEC-10 —
//! no new permission). New routes only: `GET /api/datatypes`,
//! `GET /api/artifacts/{id}/catalog`, `POST /api/datatypes/sniff`,
//! `POST /api/datatypes/convert`. The type-FILTERED artifact query extends P1's
//! existing `GET /api/projects/{id}/artifacts` (not a duplicate route).

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Multipart, Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};

use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::project::ProjectsUse;
use crate::modules::workstore::authz::require_artifact_read;
use crate::modules::workstore::catalog::repository::CatalogRepository;

use super::catalog_view::ArtifactCatalog;
use super::convert::{find_converter, run_converter};
use super::registry::registry;
use super::sniff::{sniff, SNIFF_MAGIC_BYTES};
use super::types::Datatype;

pub fn datatype_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/datatypes", get_with(list_datatypes, list_datatypes_docs))
        .api_route(
            "/datatypes/sniff",
            post_with(sniff_upload, sniff_upload_docs),
        )
        .api_route(
            "/datatypes/convert",
            post_with(convert_upload, convert_upload_docs),
        )
        .api_route(
            "/artifacts/{id}/catalog",
            get_with(get_artifact_catalog, get_artifact_catalog_docs),
        )
}

/// Dump the live datatype registry (the FE mirror + pickers read this).
async fn list_datatypes(
    _auth: RequirePermissions<(ProjectsUse,)>,
) -> ApiResult<Json<Vec<Datatype>>> {
    let reg = registry();
    let types: Vec<Datatype> = reg.all().into_iter().cloned().collect();
    Ok((StatusCode::OK, Json(types)))
}

fn list_datatypes_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Dump the live datatype registry: lattice + capabilities + layouts + viewers.")
        .id("Datatype.list")
        .tag("datatype")
        .response::<200, Json<Vec<Datatype>>>()
}

/// One artifact's registry-enriched catalog view (row ⊗ datatype descriptor).
async fn get_artifact_catalog(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ArtifactCatalog>> {
    let repo = CatalogRepository::new(pool.clone());
    let artifact = repo
        .get_any_status(id)
        .await
        .map_err(|e| e.to_api_error())?
        .ok_or_else(|| AppError::not_found("Artifact").to_api_error())?;
    // P1's per-project authz. A foreign/inaccessible project is folded into the SAME
    // "Artifact not found" 404 as a nonexistent id, so the route is not an
    // artifact-existence oracle across projects.
    require_artifact_read(&pool, &artifact, auth.user.id)
        .await
        .map_err(|_| AppError::not_found("Artifact").to_api_error())?;
    let view = ArtifactCatalog::build(&registry(), artifact);
    Ok((StatusCode::OK, Json(view)))
}

fn get_artifact_catalog_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("An artifact's registry-enriched catalog view (datatype descriptor + viewers + capabilities + per-selector access tier). Unknown datatype → a fail-soft generic view.")
        .id("Datatype.artifactCatalog")
        .tag("datatype")
        .response::<200, Json<ArtifactCatalog>>()
        .response_with::<404, (), _>(|r| r.description("Artifact not found / not visible"))
}

/// The result of sniffing an uploaded file.
#[derive(Debug, Serialize, JsonSchema)]
pub struct SniffResult {
    /// The detected datatype id, or `null` when unrecognized (the FE shows "unknown").
    pub datatype: Option<String>,
    pub filename: String,
}

/// Detect the datatype of an uploaded file (multipart `file` field). The FE upload
/// picker calls this to pre-fill the type — the user never types a raw datatype id.
async fn sniff_upload(
    _auth: RequirePermissions<(ProjectsUse,)>,
    mut multipart: Multipart,
) -> ApiResult<Json<SniffResult>> {
    let mut filename = String::new();
    let mut head: Vec<u8> = Vec::new();
    let mut saw_file = false;
    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        AppError::bad_request(
            "INVALID_MULTIPART",
            format!("Malformed multipart body: {e}"),
        )
        .to_api_error()
    })? {
        if field.name() == Some("file") {
            saw_file = true;
            if let Some(fname) = field.file_name() {
                filename = fname.to_string();
            }
            // Read only the HEAD bytes for magic detection — stream chunks and stop
            // once we have `SNIFF_MAGIC_BYTES`, so a huge upload is never fully
            // buffered just to inspect its first bytes.
            while head.len() < SNIFF_MAGIC_BYTES {
                match field.chunk().await.map_err(|e| {
                    AppError::bad_request(
                        "UPLOAD_READ_FAILED",
                        format!("Failed to read upload: {e}"),
                    )
                    .to_api_error()
                })? {
                    Some(chunk) => {
                        let need = SNIFF_MAGIC_BYTES - head.len();
                        head.extend_from_slice(&chunk[..chunk.len().min(need)]);
                    }
                    None => break,
                }
            }
        }
    }
    if !saw_file {
        return Err(
            AppError::bad_request("MISSING_FILE", "Multipart body has no `file` field")
                .to_api_error(),
        );
    }
    let datatype = sniff(&registry(), &filename, &head);
    Ok((StatusCode::OK, Json(SniffResult { datatype, filename })))
}

fn sniff_upload_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Sniff the datatype of an uploaded file (multipart `file` field) by extension + magic bytes.")
        .id("Datatype.sniff")
        .tag("datatype")
        .response::<200, Json<SniffResult>>()
}

/// Query for a host-lite conversion (`from`/`to` datatype-or-format keys).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConvertQuery {
    /// The source format/datatype key of a declared converter (e.g. `file/csv`).
    pub from: String,
    /// The target datatype (e.g. `columnar-table` — the target of the one near-term
    /// host-lite converter, `csv/tsv → columnar-table`).
    pub to: String,
}

/// The result of a host-lite conversion.
#[derive(Debug, Serialize, JsonSchema)]
pub struct ConvertResult {
    pub datatype: String,
    pub storage_layout: String,
    /// The converted payload (a `{columns, rows}` table for the columnar-table layout).
    pub result: serde_json::Value,
}

/// Run a declared host-lite converter over an uploaded file (multipart `file` field).
/// The single near-term converter is `csv/tsv → columnar-table` (DEC-9); a
/// `run: Sandbox` converter returns a typed `SANDBOX_CONVERTER_IS_ASYNC` here — it
/// runs asynchronously via the on-ingest jobs pipeline, not on this endpoint.
async fn convert_upload(
    _auth: RequirePermissions<(ProjectsUse,)>,
    Query(q): Query<ConvertQuery>,
    mut multipart: Multipart,
) -> ApiResult<Json<ConvertResult>> {
    let converter = find_converter(&registry(), &q.from, &q.to).ok_or_else(|| {
        AppError::bad_request(
            "NO_CONVERTER",
            format!("no converter `{}`→`{}` is registered", q.from, q.to),
        )
        .to_api_error()
    })?;

    let mut bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        AppError::bad_request(
            "INVALID_MULTIPART",
            format!("Malformed multipart body: {e}"),
        )
        .to_api_error()
    })? {
        if field.name() == Some("file") {
            let data = field.bytes().await.map_err(|e| {
                AppError::bad_request("UPLOAD_READ_FAILED", format!("Failed to read upload: {e}"))
                    .to_api_error()
            })?;
            bytes = Some(data.to_vec());
        }
    }
    let bytes = bytes.ok_or_else(|| {
        AppError::bad_request("MISSING_FILE", "Multipart body has no `file` field").to_api_error()
    })?;

    let out = run_converter(&converter, &bytes).map_err(|e| e.to_api_error())?;
    // The host-lite converter emits a columnar-table as `{columns, rows}` JSON.
    let result: serde_json::Value =
        serde_json::from_slice(&out.bytes).unwrap_or(serde_json::Value::Null);
    Ok((
        StatusCode::OK,
        Json(ConvertResult {
            datatype: out.datatype,
            storage_layout: out.storage_layout,
            result,
        }),
    ))
}

fn convert_upload_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Run a host-lite converter (e.g. csv/tsv → columnar-table) over an uploaded file. `from`/`to` name a declared converter.")
        .id("Datatype.convert")
        .tag("datatype")
        .response::<200, Json<ConvertResult>>()
        .response_with::<400, (), _>(|r| r.description("No such converter, or a bad/non-UTF-8 file"))
}
