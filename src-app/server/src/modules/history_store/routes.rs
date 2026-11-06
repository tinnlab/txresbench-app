//! The history store's HTTP surface (PROV-HS-2..HS-6) — the K screen's
//! paged run view (`/api/txr/history`), the expanded run block
//! (`/api/txr/history/{id}`), the retention preferences, the two copy-clear
//! operations and the data-usage figure. The doc ids for all seven are
//! declared in [`super::types::ROUTE_DOC_IDS`] and pinned by the enum below.
//!
//! All routes mount through [`super::HistoryStoreModule::register_routes`]
//! under the framework's `/api` prefix and are gated by the REUSED
//! `jobs::use` permission (DEC-15 — no new permission, A10 not triggered;
//! the local owner passes automatically).
//!
//! ## Handler posture
//!
//! Handlers are thin transport. The list + detail answers are the
//! repository's shaped projections (PROV-HS-2/3 — one row per run, no N+1
//! per-run fetches); the retention answers are [`Retention`]'s (PROV-HS-4/5/6).
//! The blocking I/O of this surface — the usage walk and the detail's
//! run-dir walks — runs on the blocking pool (`Retention::usage` and the
//! repository's detail path each call `spawn_blocking` around the fs walk; a
//! 16 GiB data root must never block a tokio worker), so the handlers never
//! name `spawn_blocking` themselves.
//!
//! ## Validation + error mapping (closed, documented)
//!
//! - `200` — `TxrHistoryPage` / `TxrHistoryDetail` / `TxrHistoryPreferences`
//!   / `TxrHistoryUsage` (the list/detail/preferences/usage reads).
//! - `204` — the preference PUT and the two copy-clear operations (all
//!   idempotent; a repeat clear is a still-204 no-op, PROV-HS-5).
//! - `400` — `INVALID_STATUS` (a `status` filter outside the bucket
//!   vocabulary or with an empty multi-value segment — the repository's
//!   `HistoryQueryError`, mapped by its own `From<AppError>`; `q`/`kind`/
//!   `limit`/`offset` are serde-validated) and `UNSAFE_RUN_DIR` (the
//!   tampered-dir refusal of the copy-clear guard, DEC-12 — the ONLY path
//!   that can refuse a delete, and it refuses before anything is touched).
//! - `404` — `RUN_NOT_FOUND` (the engine's own vocabulary for the same
//!   entity, DEC-20 — one not-found state for the K screen).
//! - `422` — a preference body that is valid JSON but not the schema (the
//!   framework's serde `Json` rejection; a missing or mistyped
//!   `keep_file_copies` is exactly the plan's stated 422, PROV-HS-4).
//! - A body that is syntactically invalid JSON is the framework's `400`
//!   (JsonSyntaxError) — same as the sibling modules.
//!
//! ## Non-scope (the module's lines, enforced here)
//!
//! No run creation/control (the engine's `POST /api/txr/runs`), no rerun /
//! delete / clear-all duplication (the engine's `POST …/rerun` and `DELETE
//! /api/txr/runs*` are CONSUMED by `ui-history`, CONS-HS-8, never
//! re-exposed), no model-store writes, no UI, no stream surface (PROV-HS-8).
//! `can_reopen`/`can_download`/`can_rerun` are DATA; the actions themselves
//! are the engine's or `ui-results`' routes.

use aide::axum::routing::{get_with, post_with, put_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};

use crate::modules::jobs::JobsUse;
use crate::modules::permissions::{with_permission, RequirePermissions};

use super::repository::HistoryRepository;
use super::retention::Retention;
use super::types::{
    HistoryErrorCode, TxrHistoryDetail, TxrHistoryListQuery, TxrHistoryPage,
    TxrHistoryPreferences, TxrHistoryPreferencesUpdate, TxrHistoryUsage,
};

/// The seven registered endpoints (the inventory IS the registration surface:
/// [`history_routes`] builds the router from [`HistoryRoute::ALL`], so a route
/// cannot be mounted with one path and documented with another — the
/// execution_engine [`TxrRoute`] precedent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryRoute {
    /// `GET /api/txr/history` — the paged K list (PROV-HS-2).
    ListHistory,
    /// `GET /api/txr/history/{id}` — the expanded K block (PROV-HS-3).
    GetHistory,
    /// `GET /api/txr/history/preferences` — the keep-copies default (PROV-HS-4).
    GetPreferences,
    /// `PUT /api/txr/history/preferences` — the keep-copies default (PROV-HS-4).
    UpdatePreferences,
    /// `POST /api/txr/history/{id}/copies/clear` — one run's copies (PROV-HS-5).
    ClearCopies,
    /// `POST /api/txr/history/copies/clear` — every run's copies (PROV-HS-5).
    ClearAllCopies,
    /// `GET /api/txr/history/usage` — the K footer's figure (PROV-HS-6).
    GetUsage,
}

impl HistoryRoute {
    /// The registration order (the inventory's stability pin).
    pub const ALL: [HistoryRoute; 7] = [
        HistoryRoute::ListHistory,
        HistoryRoute::GetHistory,
        HistoryRoute::GetPreferences,
        HistoryRoute::UpdatePreferences,
        HistoryRoute::ClearCopies,
        HistoryRoute::ClearAllCopies,
        HistoryRoute::GetUsage,
    ];

    /// The route's doc id (the `History.*` vocabulary of
    /// [`ROUTE_DOC_IDS`] — the ITEM-1 pin and this inventory cannot differ).
    pub fn doc_id(self) -> &'static str {
        match self {
            HistoryRoute::ListHistory => "History.listHistory",
            HistoryRoute::GetHistory => "History.getHistory",
            HistoryRoute::GetPreferences => "History.getPreferences",
            HistoryRoute::UpdatePreferences => "History.updatePreferences",
            HistoryRoute::ClearCopies => "History.clearCopies",
            HistoryRoute::ClearAllCopies => "History.clearAllCopies",
            HistoryRoute::GetUsage => "History.getUsage",
        }
    }

    /// The HTTP verb.
    pub fn method(self) -> &'static str {
        match self {
            HistoryRoute::ListHistory
            | HistoryRoute::GetHistory
            | HistoryRoute::GetPreferences
            | HistoryRoute::GetUsage => "GET",
            HistoryRoute::UpdatePreferences => "PUT",
            HistoryRoute::ClearCopies | HistoryRoute::ClearAllCopies => "POST",
        }
    }

    /// The registered path under `/api` (the `{id}` segment name of the
    /// `Path<Uuid>` extractor). The two static segments at the `{id}` level
    /// (`preferences`, `copies/clear`, `usage`) are the matchit
    /// static-over-dynamic rule — the same layout `model_store`'s
    /// `/txr/models/{id}` next to `/txr/models/save` uses.
    pub fn path(self) -> &'static str {
        match self {
            HistoryRoute::ListHistory => "/txr/history",
            HistoryRoute::GetHistory => "/txr/history/{id}",
            HistoryRoute::GetPreferences | HistoryRoute::UpdatePreferences => "/txr/history/preferences",
            HistoryRoute::ClearCopies => "/txr/history/{id}/copies/clear",
            HistoryRoute::ClearAllCopies => "/txr/history/copies/clear",
            HistoryRoute::GetUsage => "/txr/history/usage",
        }
    }
}

/// The module's route set under `/api/txr/` (registered by
/// `register_routes`; no root catch-all — the `/api` prefix stays the
/// framework's).
pub fn history_routes() -> ApiRouter {
    let mut router = ApiRouter::new();
    for route in HistoryRoute::ALL {
        let method_router = match route {
            HistoryRoute::ListHistory => get_with(list_history, list_history_docs),
            HistoryRoute::GetHistory => get_with(get_history, get_history_docs),
            HistoryRoute::GetPreferences => get_with(get_preferences, get_preferences_docs),
            HistoryRoute::UpdatePreferences => {
                put_with(update_preferences, update_preferences_docs)
            }
            HistoryRoute::ClearCopies => post_with(clear_copies, clear_copies_docs),
            HistoryRoute::ClearAllCopies => post_with(clear_all_copies, clear_all_copies_docs),
            HistoryRoute::GetUsage => get_with(get_usage, get_usage_docs),
        };
        router = router.api_route(route.path(), method_router);
    }
    router
}

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-HS-2 — GET /api/txr/history
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/history` — the K list: runs newest-first
/// (`created_at DESC`, id tie-break), bounded `limit` (default 20, clamp
/// 1..=100, INV-3 — a caller asking for 200 gets the cap) with the true
/// `total` under the active filters, and the three server-side filters:
/// `q` (case-insensitive substring over file names / method ids / saved set
/// names — one bound parameter, PROV-sqlite-store-4), `kind`
/// (`learned` | `saved-model`), `status` (one bucket or the comma-separated
/// multi-value, OR semantics — the K "Stopped or failed" filter is ONE call).
async fn list_history(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<TxrHistoryListQuery>,
) -> ApiResult<Json<TxrHistoryPage>> {
    let repo = HistoryRepository::new(pool);
    let page = repo.page(&q).await.map_err(e)?;
    Ok((StatusCode::OK, Json(page)))
}

fn list_history_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The K screen's run history, newest first: one shaped row per run (file names, method count + per-method seconds, learned/predicted/markers facts, endpoint + decision day + look-ahead, the first failing/stopped reason verbatim, the made/used model names, the retention flag and the capability booleans). Server-side search + filter + paging: `q` = case-insensitive substring over file names / method ids / saved set names; `kind` = learned | saved-model; `status` = running | finished | stopped | failed, comma-separated for one OR filter (the K \"Stopped or failed\" list); `limit` default 20 max 100, `offset` >= 0. 400 INVALID_STATUS.")
        .id("History.listHistory")
        .tag("history")
        .response::<200, Json<TxrHistoryPage>>()
        .response_with::<400, (), _>(|r| r.description("INVALID_STATUS (an unknown bucket or an empty multi-value segment)"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-HS-3 — GET /api/txr/history/{id}
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/history/{id}` — the expanded K block: the row's facts plus
/// the per-method rows (the engine's `TxrRunMethod` verbatim), the settings
/// line, the saved-model records, the log count, the input-copy sizes, the
/// run dir's size and the "took X (estimated Y)" facts. Unknown id → 404
/// `RUN_NOT_FOUND` (DEC-20: one entity, one code — the engine's own).
async fn get_history(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<TxrHistoryDetail>> {
    let repo = HistoryRepository::new(pool);
    let Some(detail) = repo.get_detail(id).await.map_err(e)? else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            HistoryErrorCode::RunNotFound.code(),
            format!("no run {id}"),
        )
        .to_api_error());
    };
    Ok((StatusCode::OK, Json(detail)))
}

fn get_history_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The expanded K block of one run: the row's facts plus the rich per-method rows (state, reason, coverage, probability source, task — the engine's own row shape, the F screen's vocabulary), the settings line (endpoint, decision day, look-ahead, covariates, seed, CPUs, memory, at-a-time, save-models, mode), the saved-model records (names + byte sizes), the log line count, the recorded input-copy sizes (empty once copies were cleared), the run dir's recursive size and the stored estimate facts (\"took X (estimated Y)\" — null when the create-time estimate was never computed). Unknown id → 404 RUN_NOT_FOUND.")
        .id("History.getHistory")
        .tag("history")
        .response::<200, Json<TxrHistoryDetail>>()
        .response_with::<404, (), _>(|r| r.description("Unknown run id (RUN_NOT_FOUND)"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-HS-4 — GET/PUT /api/txr/history/preferences
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/history/preferences` — the K footer's keep-copies default.
/// The row is the migration's seed (id = 1, `keep_file_copies: true` — the
/// board's "Copies are kept with this run so it can be repeated"); `ui-run`
/// reads this route at create time (DEC-13, the `history-store -> ui-run`
/// edge) so a NEW run's `keep_copies` follows the one preference.
async fn get_preferences(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<TxrHistoryPreferences>> {
    let retention = Retention::new(pool);
    let prefs = retention.get_preferences().await.map_err(e)?;
    Ok((StatusCode::OK, Json(prefs)))
}

fn get_preferences_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The K footer's keep-copies default (the singleton row, seeded `true` — the board's \"Copies are kept with this run so it can be repeated\"). `ui-run` reads this at create time so a new run's `input.keep_copies` follows it.")
        .id("History.getPreferences")
        .tag("history")
        .response::<200, Json<TxrHistoryPreferences>>()
}

/// `PUT /api/txr/history/preferences` — upsert the keep-copies default
/// (id = 1). This write is NOT destructive: it only flips the default; the
/// explicit all-runs copy-clear (D25/D27's "immediate clear" half, after the
/// UI's confirmation) is the separate [`clear_all_copies`] operation.
/// A body that is valid JSON but not the schema (missing/mistyped
/// `keep_file_copies`) is the framework's 422.
async fn update_preferences(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(update): Json<TxrHistoryPreferencesUpdate>,
) -> ApiResult<()> {
    let retention = Retention::new(pool);
    retention
        .update_preferences(&update)
        .await
        .map_err(e)?;
    Ok((StatusCode::NO_CONTENT, ()))
}

fn update_preferences_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Set the keep-copies default (id = 1 upsert; the row was created by the migration, never by this route). 204; the write flips the default only — clearing the copies of EXISTING runs is the separate all-runs clear operation, issued by the UI after its confirmation. 422 for a body that is not the `{keep_file_copies}` schema.")
        .id("History.updatePreferences")
        .tag("history")
        .response::<204, ()>()
        .response_with::<422, (), _>(|r| r.description("The body is not the TxrHistoryPreferencesUpdate schema"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-HS-5 — POST /api/txr/history/{id}/copies/clear, POST /api/txr/history/copies/clear
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/history/{id}/copies/clear` — the K row's per-run action:
/// remove ONLY `<run_dir>/input/` (INV-2 — the bundles, per-method outputs,
/// models, logs and the run row survive), mark the run's retention row
/// (`copies_kept = 0` + stamp, so `can_rerun` flips false — DEC-6), 204.
/// Idempotent; unknown run → 404 `RUN_NOT_FOUND`; a tampered recorded dir →
/// 400 `UNSAFE_RUN_DIR` with NOTHING deleted.
async fn clear_copies(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<()> {
    let retention = Retention::new(pool);
    retention.clear_run_copies(id).await.map_err(e)?;
    Ok((StatusCode::NO_CONTENT, ()))
}

fn clear_copies_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Remove one run's uploaded file copies (`<run_dir>/input/` ONLY — the K \"copies of my files\" action; bundles, per-method outputs, models, logs and the run record stay) and mark its retention row (the K row's `can_rerun` flips false). 204, idempotent (a run whose copies are already gone is a still-204 no-op); 404 RUN_NOT_FOUND; 400 UNSAFE_RUN_DIR for a recorded dir that fails the naming + canonical floor checks — nothing is deleted.")
        .id("History.clearCopies")
        .tag("history")
        .response::<204, ()>()
        .response_with::<404, (), _>(|r| r.description("Unknown run id (RUN_NOT_FOUND)"))
        .response_with::<400, (), _>(|r| r.description("UNSAFE_RUN_DIR (the recorded dir is not a data-root analysis-* path or escapes it)"))
}

/// `POST /api/txr/history/copies/clear` — the K footer's destructive half of
/// "Do not keep copies of my files" (after the UI's D27 confirmation): the
/// same per-run guard + removal + retention mark composed over every run.
/// A run whose recorded dir is tampered is SKIPPED by the sweep (its guard
/// refusal still means nothing is deleted; one corrupt row must not leave
/// every healthy run's copies uncleared — DRIFT-1 ITEM-3).
async fn clear_all_copies(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<()> {
    let retention = Retention::new(pool);
    retention.clear_all_copies().await.map_err(e)?;
    Ok((StatusCode::NO_CONTENT, ()))
}

fn clear_all_copies_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Remove EVERY run's uploaded file copies (`<run_dir>/input/` only, per run) and mark each retention row — the K footer's \"Do not keep copies of my files\" destructive half, issued after the UI's confirmation. 204, idempotent; a run with a tampered recorded dir is skipped by the sweep (nothing is deleted for it).")
        .id("History.clearAllCopies")
        .tag("history")
        .response::<204, ()>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-HS-6 — GET /api/txr/history/usage
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/txr/history/usage` — the K footer's accountability figure:
/// `run_count` from the DB and the grouped recursive size walk of the app
/// data root (`analysis-*` → runs, `models/` → models, the rest → other),
/// with the user-visible `data_dir` and the stamp. The walk runs on the
/// blocking pool and is cached for 10 seconds (DEC-8 — a large data root is
/// not walked per keystroke).
async fn get_usage(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<TxrHistoryUsage>> {
    let retention = Retention::new(pool);
    let usage = retention.usage().await.map_err(e)?;
    Ok((StatusCode::OK, Json(usage)))
}

fn get_usage_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("The K footer's figure: the run count (the DB truth) and the recursive byte size of the app data root grouped by top-level segment (analysis-* → runs, models/ → models, everything else → other), the user-visible data dir (the UI never hardcodes or derives a path) and the computation stamp. The walk runs in the background and is cached for 10 seconds.")
        .id("History.getUsage")
        .tag("history")
        .response::<200, Json<TxrHistoryUsage>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the ITEM-4 pins: the inventory IS the registration surface and the
// seven doc ids, and the router builds (a static/dynamic path layout conflict
// panics HERE, at build, not at first boot).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::types::ROUTE_DOC_IDS;
    use super::*;

    /// The route inventory matches `types::ROUTE_DOC_IDS` exactly, in the
    /// declared order — a route registered with a spare doc id or a missing
    /// registration fails HERE (the ITEM-1 pin's route-side half).
    #[test]
    fn routes_are_the_seven_history_operations() {
        let ids: Vec<&str> = HistoryRoute::ALL.iter().map(|r| r.doc_id()).collect();
        assert_eq!(ids, ROUTE_DOC_IDS);

        // The (method, path) pairs are distinct — no two operations share
        // one path+verb (the GET/PUT split on `/txr/history/preferences` is
        // opposite verbs; the two clear operations differ in path).
        let pairs: Vec<(String, &str)> = HistoryRoute::ALL
            .iter()
            .map(|r| (format!("{} {}", r.method(), r.path()), r.doc_id()))
            .collect();
        let unique: std::collections::HashSet<&str> =
            pairs.iter().map(|(_, id)| *id).collect();
        assert_eq!(unique.len(), pairs.len(), "routes must be unique");
        let mut methods_paths: Vec<&String> = pairs.iter().map(|(mp, _)| mp).collect();
        let before = methods_paths.len();
        methods_paths.sort();
        methods_paths.dedup();
        assert_eq!(
            methods_paths.len(),
            before,
            "no two routes share a path + verb"
        );

        // The doc id vocabulary is the history family only.
        for id in &ids {
            assert!(
                id.starts_with("History."),
                "{id} must be a History.* doc id"
            );
        }
    }

    /// The router builds: registering `/txr/history/preferences` and
    /// `/txr/history/{id}` (and the same at `copies/clear`) is the matchit
    /// static-over-dynamic layout — a conflict would panic here (eager
    /// registration), not at first boot.
    #[test]
    fn history_routes_build_without_path_conflict() {
        let _ = history_routes();
    }
}
