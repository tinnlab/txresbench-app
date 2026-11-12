//! ITEM-5 — the eight HTTP operations of the pretrained catalogue
//! (PROV-PC-3..8): the D-list rows, the model card, the catalogue refresh,
//! the download-manager surface, the install path and the per-model
//! eligibility.
//!
//! All routes mount through [`super::PretrainedCatalogueModule::register_routes`]
//! under the framework's `/api` prefix — `/api/txr/pretrained*` — and are
//! gated by the REUSED `jobs::use` permission (DEC-11: no new permission,
//! A10 not triggered; the single local owner passes automatically).
//!
//! ## Handler posture
//!
//! The handlers are thin transport: every decision lives in the engines —
//! the catalogue runtime (`catalogue.rs`, the live → disk → embedded view),
//! the download manager (`downloader.rs`, ITEM-4), the install core
//! (`install.rs`, ITEM-4's PROV-PC-7 seam) and the eligibility engine
//! (`eligibility.rs`, the pure PROV-PC-8 core). The list route's only join is
//! the store's own `list_pretrained` seam (CONS-PC-4 — the caller-side
//! mapping of the installed rows; this module never reads the store's
//! tables). The eligibility engine + its per-entry bundle verification run
//! through `spawn_blocking` — the engine is pure and CPU-cheap (a bounded
//! ≤200-id request), and the file verification is blocking I/O the module
//! pattern keeps off a tokio worker.
//!
//! ## State merge (the D-list rows)
//!
//! The row `state` is ONE derivation over the download status (the ITEM-4
//! single-source derive) plus the installed-row mapping: installed >
//! bundled (a verified bundle file — INV-8's offline source) > downloading >
//! ready (verified cache) > unavailable (a failed download — the entry has
//! no verified form) > not_downloaded. `installed_model_id` is the strict
//! id+version store row (GAP-PC-3's resolved seam), null before install.
//!
//! ## Error mapping (closed, documented)
//!
//! - `404 PRETRAINED_UNKNOWN` — an unknown id on the card/install/download/
//!   delete routes (one code, one entity).
//! - `400 PRETRAINED_UNKNOWN` — an unknown id inside the eligibility BATCH:
//!   the batch's ids are request data (PROV-PC-8's 400), a resource path's
//!   id is a lookup (the 404s) — same code, documented per surface.
//! - `400 EMPTY_MODEL_IDS` / `400 TOO_MANY_MODEL_IDS` — PROV-PC-8's 1..=200
//!   bound.
//! - `409` — the install/download core's `PRETRAINED_VERIFY_FAILED`,
//!   `PRETRAINED_DOWNLOAD_IN_PROGRESS`, `PRETRAINED_LICENCE_MISSING`, and the
//!   store seam's errors pass through UNREWRITTEN.
//! - A body that is syntactically invalid JSON is the framework's `400`
//!   (JsonSyntaxError); one that does not match the schema is the framework's
//!   `422` (JsonDataError).

use std::collections::BTreeMap;

use aide::axum::routing::{delete_with, get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use sqlx::SqlitePool;

use txresbench_core::{ApiResult, AppError};

use crate::modules::jobs::JobsUse;
use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::pretrained_catalogue::types::{
    PretrainedDownloadState, PretrainedDownloadStatus, PretrainedDownloadsResponse,
    PretrainedEligibilityRequest, PretrainedEligibilityResponse, PretrainedEntryState,
    PretrainedInstallStatus, PretrainedListResponse, PretrainedModelCard, PretrainedRefreshResponse,
    PretrainedSummary, ELIGIBILITY_MODEL_IDS_MAX,
};

use super::bundled;
use super::eligibility;
use super::install;
use super::runtime;

/// The route inventory (method, path, doc id) — the mounting order AND the
/// pin: the registered set is exactly [`ROUTE_DOC_IDS`], in order (the
/// `history_store` precedent), and no two operations share one path+verb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PretrainedRoute {
    ListModels,
    GetModel,
    RefreshCatalogue,
    ListDownloads,
    DownloadModel,
    DeleteDownload,
    InstallModel,
    CheckEligibility,
}

impl PretrainedRoute {
    /// The registration order (the inventory's stability pin — the doc-id
    /// order of types::ROUTE_DOC_IDS, the ITEM-3 declaration's).
    pub const ALL: [PretrainedRoute; 8] = [
        PretrainedRoute::ListModels,
        PretrainedRoute::GetModel,
        PretrainedRoute::InstallModel,
        PretrainedRoute::DownloadModel,
        PretrainedRoute::ListDownloads,
        PretrainedRoute::DeleteDownload,
        PretrainedRoute::RefreshCatalogue,
        PretrainedRoute::CheckEligibility,
    ];

    /// The route's doc id (the `Pretrained.*` vocabulary of
    /// types::ROUTE_DOC_IDS — the ITEM-3 pin and this inventory cannot
    /// differ; consumed by the inventory test below).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn doc_id(self) -> &'static str {
        match self {
            PretrainedRoute::ListModels => "Pretrained.listModels",
            PretrainedRoute::GetModel => "Pretrained.getModel",
            PretrainedRoute::RefreshCatalogue => "Pretrained.refreshCatalogue",
            PretrainedRoute::ListDownloads => "Pretrained.listDownloads",
            PretrainedRoute::DownloadModel => "Pretrained.downloadModel",
            PretrainedRoute::DeleteDownload => "Pretrained.deleteDownload",
            PretrainedRoute::InstallModel => "Pretrained.installModel",
            PretrainedRoute::CheckEligibility => "Pretrained.checkEligibility",
        }
    }

    /// The HTTP verb (the inventory test's pin half).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn method(self) -> &'static str {
        match self {
            PretrainedRoute::ListModels
            | PretrainedRoute::GetModel
            | PretrainedRoute::ListDownloads => "GET",
            PretrainedRoute::RefreshCatalogue
            | PretrainedRoute::DownloadModel
            | PretrainedRoute::InstallModel
            | PretrainedRoute::CheckEligibility => "POST",
            PretrainedRoute::DeleteDownload => "DELETE",
        }
    }

    /// The registered path under `/api` (the `{id}` segment name of the
    /// `Path<String>` extractor). The static segments at the `{id}` level
    /// (`refresh`, `downloads`, `eligibility`) are the matchit
    /// static-over-dynamic rule — the same layout `model_store`'s
    /// `/txr/models/{id}` next to `/txr/models/save` uses.
    pub fn path(self) -> &'static str {
        match self {
            PretrainedRoute::ListModels => "/txr/pretrained",
            PretrainedRoute::GetModel => "/txr/pretrained/{id}",
            PretrainedRoute::RefreshCatalogue => "/txr/pretrained/refresh",
            PretrainedRoute::ListDownloads => "/txr/pretrained/downloads",
            PretrainedRoute::DownloadModel => "/txr/pretrained/{id}/download",
            PretrainedRoute::DeleteDownload => "/txr/pretrained/{id}/download",
            PretrainedRoute::InstallModel => "/txr/pretrained/{id}/install",
            PretrainedRoute::CheckEligibility => "/txr/pretrained/eligibility",
        }
    }
}

/// The module's route set under `/api/txr/` (registered by
/// `register_routes`; no root catch-all — the `/api` prefix stays the
/// framework's).
pub fn pretrained_routes() -> ApiRouter {
    let mut router = ApiRouter::new();
    for route in PretrainedRoute::ALL {
        let method_router = match route {
            PretrainedRoute::ListModels => get_with(list_models, list_models_docs),
            PretrainedRoute::GetModel => get_with(get_model, get_model_docs),
            PretrainedRoute::RefreshCatalogue => {
                post_with(refresh_catalogue, refresh_catalogue_docs)
            }
            PretrainedRoute::ListDownloads => {
                get_with(list_downloads, list_downloads_docs)
            }
            PretrainedRoute::DownloadModel => {
                post_with(start_download, start_download_docs)
            }
            PretrainedRoute::DeleteDownload => {
                delete_with(delete_download, delete_download_docs)
            }
            PretrainedRoute::InstallModel => {
                post_with(install_model, install_model_docs)
            }
            PretrainedRoute::CheckEligibility => {
                post_with(check_eligibility, check_eligibility_docs)
            }
        };
        router = router.api_route(route.path(), method_router);
    }
    router
}

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-3 — GET /api/txr/pretrained
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/pretrained` — the D-list rows (unpaged — the catalogue is
/// bounded; the row's `state` merges the download status + the installed
/// mapping, `origin` tells the UI where the catalogue came from).
async fn list_models(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<PretrainedListResponse>> {
    let active = runtime().active();
    let manager = super::downloads();
    let installed =
        crate::modules::model_store::store::list_pretrained(&pool, None).await.map_err(e)?;

    let models: Vec<PretrainedSummary> = active
        .catalogue
        .models
        .iter()
        .map(|entry| {
            let installed_model_id = installed
                .iter()
                .find(|m| {
                    m.pretrained_catalogue_id.as_deref() == Some(entry.id.as_str())
                        && m.pretrained_catalogue_version.as_deref()
                            == Some(entry.version.as_str())
                })
                .map(|m| m.id.to_string());
            let st = manager.status(entry);
            PretrainedSummary {
                id: entry.id.clone(),
                version: entry.version.clone(),
                kind: entry.kind,
                name: entry.name.clone(),
                description: entry.description.clone(),
                method_id: entry.method_id.clone(),
                method_version: entry.method_version.clone(),
                group: entry.group.clone(),
                group_label: entry.group_label.clone(),
                paper: entry.paper.as_ref().map(|p| {
                    crate::modules::pretrained_catalogue::types::PretrainedPaperSummary::from_paper(p)
                }),
                decision_day: entry.needs.decision_day,
                endpoint: entry.needs.endpoint,
                horizon: entry.needs.horizon,
                transfer: entry
                    .transfer
                    .as_ref()
                    .map(crate::modules::pretrained_catalogue::types::PretrainedTransferSummary::from_transfer),
                warnings: entry.assay_warnings.clone(),
                research_notice: entry.research_notice,
                licence: entry.licence.clone(),
                asset: crate::modules::pretrained_catalogue::types::PretrainedAssetSummary::from_asset(
                    &entry.asset,
                ),
                state: entry_state(&st, installed_model_id.is_some()),
                installed_model_id,
            }
        })
        .collect();
    let total = models.len() as u32;
    Ok((
        StatusCode::OK,
        Json(PretrainedListResponse {
            origin: active.origin,
            generated_at: Some(active.catalogue.generated_from.generated_at.clone()),
            models,
            total,
        }),
    ))
}

/// The D-list row state, derived not guessed: an installed row wins (the D
/// Run passes its model_id), then the download status's own single-source
/// derive (a verified bundled file is `bundled` — INV-8's offline source; a
/// verified cache is `ready`; a failed transfer leaves no verified form —
/// `unavailable`; everything else is `not_downloaded`).
fn entry_state(
    st: &PretrainedDownloadStatus,
    installed: bool,
) -> PretrainedEntryState {
    if installed {
        return PretrainedEntryState::Installed;
    }
    match st.state {
        PretrainedDownloadState::Downloading => PretrainedEntryState::Downloading,
        PretrainedDownloadState::Ready if st.bundled && !st.cached => PretrainedEntryState::Bundled,
        PretrainedDownloadState::Ready => PretrainedEntryState::Ready,
        PretrainedDownloadState::Failed => PretrainedEntryState::Unavailable,
        PretrainedDownloadState::NotDownloaded => PretrainedEntryState::NotDownloaded,
    }
}

fn list_models_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The pretrained catalogue rows (unpaged — the bounded card set; the D list filters client-side). Each row merges the catalogue entry, the download state and the installed store mapping; `origin` says which layer served it (live → disk → embedded).")
        .id("Pretrained.listModels")
        .tag("pretrained-catalogue")
        .response::<200, Json<PretrainedListResponse>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-4 — GET /api/txr/pretrained/{id}
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/pretrained/{id}` — one model's card (the models.md card:
/// source paper, needs, decision day, other-cohort results, assay warnings,
/// research-use notice, licence, data sources, asset). Unknown id → 404
/// `PRETRAINED_UNKNOWN`.
async fn get_model(
    _auth: RequirePermissions<(JobsUse,)>,
    Path(id): Path<String>,
) -> ApiResult<Json<PretrainedModelCard>> {
    let active = runtime().active();
    let entry = active
        .catalogue
        .models
        .iter()
        .find(|m| m.id == id)
        .cloned()
        .ok_or_else(|| crate::modules::pretrained_catalogue::types::unknown_id(&id))?;
    Ok((StatusCode::OK, Json(entry)))
}

fn get_model_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("One pretrained model's full card (the card fields of PROV-PC-1: description, paper, needs in full, env digests, contract, per-cohort transfer values, assay warnings, licence, data sources, asset). Unknown id → 404 PRETRAINED_UNKNOWN.")
        .id("Pretrained.getModel")
        .tag("pretrained-catalogue")
        .response::<200, Json<PretrainedModelCard>>()
        .response_with::<404, (), _>(|r| r.description("Unknown pretrained id (PRETRAINED_UNKNOWN)"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-5 — POST /api/txr/pretrained/refresh
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/pretrained/refresh` — the boot/on-demand refresh: fetch +
/// validate + write the last-good copy (live), else the last-good disk copy,
/// else keep the current layer. The response is the origin actually in use;
/// a failed refresh is silent (offline is a valid state — INV-8).
async fn refresh_catalogue(
    _auth: RequirePermissions<(JobsUse,)>,
) -> ApiResult<Json<PretrainedRefreshResponse>> {
    let response = runtime().refresh().await;
    Ok((StatusCode::ACCEPTED, Json(response)))
}

fn refresh_catalogue_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Refresh the catalogue (live → last-good disk → keep the current layer). The response carries the origin actually in use; a failed refresh is silent — offline is a valid state and never an error (INV-8).")
        .id("Pretrained.refreshCatalogue")
        .tag("pretrained-catalogue")
        .response::<202, Json<PretrainedRefreshResponse>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-6 — GET /api/txr/pretrained/downloads
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/pretrained/downloads` — one status per catalogue entry
/// (the D list's download state; byte progress is polled here).
async fn list_downloads(
    _auth: RequirePermissions<(JobsUse,)>,
) -> ApiResult<Json<PretrainedDownloadsResponse>> {
    let active = runtime().active();
    let manager = super::downloads();
    let downloads = active
        .catalogue
        .models
        .iter()
        .map(|entry| manager.status(entry))
        .collect();
    Ok((StatusCode::OK, Json(PretrainedDownloadsResponse { downloads })))
}

fn list_downloads_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The download status of every catalogue entry (bytes polled from the growing staged file; `digest` once verified; `bundled` flags the entry whose asset ships in the installer).")
        .id("Pretrained.listDownloads")
        .tag("pretrained-catalogue")
        .response::<200, Json<PretrainedDownloadsResponse>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-6 — POST /api/txr/pretrained/{id}/download
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/pretrained/{id}/download` — start the asset download
/// (202; idempotent — an in-flight or ready asset returns its current
/// status; a bundled asset is never downloaded, the bundle is the source —
/// INV-8).
async fn start_download(
    _auth: RequirePermissions<(JobsUse,)>,
    Path(id): Path<String>,
) -> ApiResult<Json<PretrainedDownloadStatus>> {
    let entry = resolve_entry(&id)?;
    let st = super::downloads().start(&entry);
    Ok((StatusCode::ACCEPTED, Json(st)))
}

fn start_download_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Start (or join) the asset download for one catalogue entry. Idempotent: an in-flight or already-ready asset returns its current status; a bundled asset is never downloaded (the bundle is the source). Unknown id → 404 PRETRAINED_UNKNOWN.")
        .id("Pretrained.downloadModel")
        .tag("pretrained-catalogue")
        .response::<202, Json<PretrainedDownloadStatus>>()
        .response_with::<404, (), _>(|r| r.description("Unknown pretrained id (PRETRAINED_UNKNOWN)"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-6 — DELETE /api/txr/pretrained/{id}/download?prune=true
// ─────────────────────────────────────────────────────────────────────────────

/// The cancel/prune query (`?prune=true` removes the cached file for the
/// entry's digest — DEC-17's explicit prune).
#[derive(Debug, Clone, Default, Deserialize, schemars::JsonSchema)]
pub struct DownloadCancelQuery {
    /// Also remove the cached file for the entry's digest.
    #[serde(default)]
    pub prune: bool,
}

/// `DELETE /api/txr/pretrained/{id}/download?prune=true` — cancel an
/// in-flight download (cooperative, 2 s bound + hard abort) and optionally
/// prune the cached file; 204 (the route resolves the id first).
async fn delete_download(
    _auth: RequirePermissions<(JobsUse,)>,
    Path(id): Path<String>,
    Query(q): Query<DownloadCancelQuery>,
) -> ApiResult<()> {
    let entry = resolve_entry(&id)?;
    super::downloads().cancel(&entry, q.prune).await;
    Ok((StatusCode::NO_CONTENT, ()))
}

fn delete_download_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Cancel the entry's in-flight download (`prune=true` also removes the cached file for its digest); 204 always once the id resolves. Unknown id → 404 PRETRAINED_UNKNOWN.")
        .id("Pretrained.deleteDownload")
        .tag("pretrained-catalogue")
        .response_with::<204, (), _>(|r| r.description("Cancelled (and pruned when requested)"))
        .response_with::<404, (), _>(|r| r.description("Unknown pretrained id (PRETRAINED_UNKNOWN)"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-7 — POST /api/txr/pretrained/{id}/install
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/pretrained/{id}/install` — ensure the entry is installed:
/// 200 `installed` (the idempotent existing row, a verified bundle or a
/// verified cache — source order bundled → cache → download, INV-8) or 202
/// `installing` when a download was started and the caller polls the
/// downloads surface. Unknown id → 404; the verification refusals are the
/// 409s of the install core.
async fn install_model(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<String>,
) -> ApiResult<Json<crate::modules::pretrained_catalogue::types::PretrainedInstallResponse>> {
    let outcome = install::ensure_installed(&pool, &id).await.map_err(e)?;
    let status = if outcome.status == PretrainedInstallStatus::Installed {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    Ok((status, Json(outcome.into_response())))
}

fn install_model_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Install the entry (idempotent): 200 `installed` with the store row once the bytes verified from a bundled file, the cache or a completed download; 202 `installing` when a required download was started. Unknown id → 404 PRETRAINED_UNKNOWN; a verification mismatch or a licence-less entry → 409.")
        .id("Pretrained.installModel")
        .tag("pretrained-catalogue")
        .response::<200, Json<crate::modules::pretrained_catalogue::types::PretrainedInstallResponse>>()
        .response_with::<202, Json<crate::modules::pretrained_catalogue::types::PretrainedInstallResponse>, _>(|r| r.description("The download was started; poll the downloads surface"))
        .response_with::<404, (), _>(|r| r.description("Unknown pretrained id (PRETRAINED_UNKNOWN)"))
        .response_with::<409, (), _>(|r| r.description("PRETRAINED_VERIFY_FAILED / PRETRAINED_LICENCE_MISSING"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-8 — POST /api/txr/pretrained/eligibility
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/pretrained/eligibility` — the per-entry D-list verdicts
/// against the file inventory (the SAME `InventoryEligibilityRequest` object
/// the methods / saved-models providers accept — one component feeds all
/// three list endpoints). Validation order: the `model_ids` bound (1..=200)
/// first, then the ids' presence in the active catalogue — the first failure
/// wins, 400.
async fn check_eligibility(
    _auth: RequirePermissions<(JobsUse,)>,
    Json(body): Json<PretrainedEligibilityRequest>,
) -> ApiResult<Json<PretrainedEligibilityResponse>> {
    if body.model_ids.is_empty() {
        return Err(AppError::bad_request(
            "EMPTY_MODEL_IDS",
            "the eligibility request carries no model ids",
        )
        .to_api_error());
    }
    if body.model_ids.len() > ELIGIBILITY_MODEL_IDS_MAX {
        return Err(AppError::bad_request(
            "TOO_MANY_MODEL_IDS",
            format!(
                "the eligibility request carries {} model ids (the cap is {ELIGIBILITY_MODEL_IDS_MAX})",
                body.model_ids.len()
            ),
        )
        .to_api_error());
    }

    // Keep the ACTIVE view's entries, in request order (a live catalogue may
    // differ from the embedded file; the card/list/eligibility surfaces all
    // serve the same active view).
    let active = runtime().active();
    let mut entries: Vec<crate::modules::pretrained_catalogue::types::PretrainedModel> =
        Vec::with_capacity(body.model_ids.len());
    for id in &body.model_ids {
        let Some(entry) = active.catalogue.models.iter().find(|m| m.id == *id).cloned() else {
            return Err(AppError::bad_request(
                "PRETRAINED_UNKNOWN",
                format!("no pretrained model {id} in the catalogue"),
            )
            .to_api_error());
        };
        entries.push(entry);
    }

    // The bundle-presence input (the one file check the pure engine leaves
    // to the route): a requested entry with a bundled asset whose file
    // verifies is asset-available with zero network (INV-8).
    let manager = super::downloads();
    let mut bundled_available: BTreeMap<String, bool> = BTreeMap::new();
    for entry in &entries {
        if entry.asset.bundled && bundled::verify(manager.seams(), entry).is_ok() {
            bundled_available.insert(entry.id.clone(), true);
        }
    }

    let response = tokio::task::spawn_blocking(move || {
        eligibility::eligibility_response(&entries, &body.model_ids, &body.inventory, &bundled_available)
    })
    .await
    .map_err(|e| {
        AppError::internal_error(format!("eligibility task join failed: {e}")).to_api_error()
    })?;
    Ok((StatusCode::OK, Json(response)))
}

fn check_eligibility_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Per-model eligibility verdicts (can_run / can_run_some / cannot_run) with the PROV-MC-5 reason vocabulary + ASSET_NOT_AVAILABLE, computed from the catalogue's recorded needs. `model_ids` is 1..=200; unknown ids and the bounds answer 400.")
        .id("Pretrained.checkEligibility")
        .tag("pretrained-catalogue")
        .response::<200, Json<PretrainedEligibilityResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description("EMPTY_MODEL_IDS / TOO_MANY_MODEL_IDS / PRETRAINED_UNKNOWN (an id absent from the active catalogue)")
        })
        .response_with::<422, (), _>(|r| r.description("JSON body that does not match the request schema"))
}

/// The active-catalogue entry lookup shared by the resource routes (the one
/// 404 of the surface; the entry is cloned — the active view is a swap-able
/// `Arc` behind the runtime lock, never a borrowed-over-await value).
fn resolve_entry(
    id: &str,
) -> Result<crate::modules::pretrained_catalogue::types::PretrainedModel, (StatusCode, AppError)> {
    let active = runtime().active();
    active
        .catalogue
        .models
        .iter()
        .find(|m| m.id == id)
        .cloned()
        .ok_or_else(|| crate::modules::pretrained_catalogue::types::unknown_id(id).to_api_error())
}

// ─────────────────────────────────────────────────────────────────────────────
// The route-inventory tests: the registered set is exactly the eight
// `Pretrained.*` doc ids in order, no two operations share a path+verb, and
// the router builds (the static-over-dynamic layout at the `{id}` level is
// the matchit rule — a conflict panics here, at eager registration, not at
// first boot).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pretrained_catalogue::types::ROUTE_DOC_IDS;

    #[test]
    fn routes_are_the_eight_pretrained_operations() {
        let ids: Vec<&str> = PretrainedRoute::ALL.iter().map(|r| r.doc_id()).collect();
        assert_eq!(ids, ROUTE_DOC_IDS);

        // The (method, path) pairs are distinct — no two operations share a
        // path+verb.
        let mut pairs: Vec<String> = PretrainedRoute::ALL
            .iter()
            .map(|r| format!("{} {}", r.method(), r.path()))
            .collect();
        let before = pairs.len();
        pairs.sort();
        pairs.dedup();
        assert_eq!(pairs.len(), before, "no two routes share a path + verb");

        for id in &ids {
            assert!(id.starts_with("Pretrained."), "{id} must be a Pretrained.* doc id");
        }
    }

    #[test]
    fn pretrained_routes_build_without_path_conflict() {
        let _ = pretrained_routes();
    }
}
