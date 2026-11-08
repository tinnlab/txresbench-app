//! The `execution_engine` HTTP surface — `routes.rs` (PLAN ITEM-10): the 16
//! `Txr.*` endpoints (PROV-EE-2..EE-8 + the at-a-time route GROWN at
//! reconcile) under `/api/txr/*`, gated by the REUSED `jobs::use` permission
//! (DEC-14: no new permission, so the framework's restricted-user surface is
//! untouched and the single local owner passes automatically — A10 not
//! triggered).
//!
//! ## Handler posture
//!
//! The handlers are thin transport: every decision lives in the repository +
//! the orchestrator (`start_run`, the control seams, the run dir) and the
//! pure predictions engines below. The predictions/CSV reads parse text
//! files with the module's one CSV codec (no `csv` crate,
//! `check-no-format-crates.sh` green) on `spawn_blocking` (a run dir can
//! carry tens of thousands of patients).
//!
//! ## Error mapping (closed, documented)
//!
//! - `400` — the create-request validation rules (`EMPTY_METHODS`,
//!   `EMPTY_MODELS`, `INVALID_AT_A_TIME`, `INVALID_DECISION_DAY`,
//!   `INVALID_LOOK_AHEAD`, `INVALID_MODEL_ASSET` via
//!   [`orchestrator::request_error_to_app`]); `INVALID_MODE` /
//!   `INVALID_AT_A_TIME` / `INVALID_BODY` from the typed-body extractor (a
//!   body that does not match the schema is the named 400, NOT the
//!   framework's 422 — the file_validator precedent);
//!   `RUN_INPUT_RECORD_MISSING` on a rerun without a record.
//! - `404` — `RUN_NOT_FOUND` (every scoped route), `METHOD_NOT_FOUND` (a
//!   stop/skip target absent from the run).
//! - `409` — `RUN_ALREADY_ACTIVE` (a create/rerun while one run is live),
//!   `RUN_NOT_ACTIVE` (a stop/lane-change of a finished/failed run — the
//!   terminal-run answer, grown here; PROV-EE-6 names only the method-level
//!   conflicts), `METHOD_NOT_ACTIVE` / `METHOD_NOT_SKIPPABLE`,
//!   `PREDICTIONS_UNAVAILABLE` (no finished method's column yet).
//! - `401` without the session bearer; `403` without `jobs::use` (the
//!   gated-route proof, as everywhere).
//!
//! ## The SSE stream contract (PROV-EE-4)
//!
//! Subscribe FIRST, then replay (the `jobs::stream_job` discipline): the run
//! status frame, the LAST 200 log lines (ascending), every method row frame,
//! and a `prediction` frame per finished method; then live frames. A
//! terminal run closes the channel (the drive's `finalize` calls
//! `close_run`), and the stream then serves the replay snapshot only — the
//! race-close arm re-checks the status right after subscribing.
//!
//! ## The predictions read surface (PROV-EE-7)
//!
//! The per-method columns are the executor's RECORDED artifact
//! (`output/<method_id>/chance.csv` — see [`super::predictions::write_chance_column`]):
//! the assembled per-patient chance column, including the per-patient
//! abstention notes and the recalibration-derived probabilities that the raw
//! container output cannot be re-derived into (the conversion's training
//! scores are per-call). The response's `patients` is the ordered union of
//! the finished methods' surfaces (each method's file order, run-method
//! order), and every method column is aligned to it (`null` + no note where
//! a patient is not on that method's surface).

use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use aide::axum::routing::{delete_with, get_with, post_with, put_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use aide::OperationInput;
use axum::extract::{FromRequest, Path as AxumPath, Query};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::{Extension, Json};
use futures_util::stream::Stream;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::{ApiResult, AppError};

use crate::modules::jobs::JobsUse;
use crate::modules::permissions::{with_permission, RequirePermissions};

use super::envmanifest;
use super::orchestrator;
use super::repository::{produced_models, MethodRow, TxrRepository};
use super::runtime::RunRuntime;
use super::types::{
    CreateRunRequest, RunConfig, TxrAppConfig, TxrAtATimeRequest, TxrCoverage, TxrDeleteQuery,
    TxrPredictionMethod, TxrPredictionsResponse, TxrProbSource, TxrRunDetail, TxrRunEvent,
    TxrRunListQuery, TxrRunListResponse, TxrRunLogsResponse, TxrRunMethodFrame, TxrRunOutcome,
    TxrRunPredictionFrame, TxrRunStatus, TxrRunStatusFrame, TxrRunSummary, TxrTask,
};

/// The module-held state the routes need beyond the framework's pool
/// extension (the `sync` module's layered-resolver precedent): the per-run
/// runtime (SSE registry + run-stop signals) and the real env/executor seams
/// both `start_run` and `rerun_run` consume. Layered by
/// [`super::ExecutionEngineModule::register_routes`].
#[derive(Clone)]
pub struct TxrRouteState {
    pub runtime: std::sync::Arc<RunRuntime>,
    pub env: std::sync::Arc<dyn orchestrator::EnvProvider>,
    pub executor: std::sync::Arc<dyn orchestrator::MethodExecutor>,
}

/// The 16 registered endpoints (the inventory IS the registration surface:
/// [`txr_routes`] builds the router from [`TxrRoute::ALL`], so a route
/// cannot be mounted with one path and documented with another).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxrRoute {
    CreateRun,
    ListRuns,
    GetRun,
    StreamRun,
    ListRunLogs,
    StopRun,
    StopMethod,
    SkipMethod,
    RerunRun,
    SetAtATime,
    DeleteRun,
    ClearRuns,
    GetPredictions,
    DownloadPredictions,
    GetAnalysisConfig,
    UpdateAnalysisConfig,
}

impl TxrRoute {
    /// The registration order (the inventory's stability pin).
    pub const ALL: [TxrRoute; 16] = [
        TxrRoute::CreateRun,
        TxrRoute::ListRuns,
        TxrRoute::GetRun,
        TxrRoute::StreamRun,
        TxrRoute::ListRunLogs,
        TxrRoute::StopRun,
        TxrRoute::StopMethod,
        TxrRoute::SkipMethod,
        TxrRoute::RerunRun,
        TxrRoute::SetAtATime,
        TxrRoute::DeleteRun,
        TxrRoute::ClearRuns,
        TxrRoute::GetPredictions,
        TxrRoute::DownloadPredictions,
        TxrRoute::GetAnalysisConfig,
        TxrRoute::UpdateAnalysisConfig,
    ];

    /// The route's doc id (the `Txr.*` vocabulary of [`super::types::ROUTE_DOC_IDS`]).
    pub fn doc_id(self) -> &'static str {
        match self {
            TxrRoute::CreateRun => "Txr.createRun",
            TxrRoute::ListRuns => "Txr.listRuns",
            TxrRoute::GetRun => "Txr.getRun",
            TxrRoute::StreamRun => "Txr.streamRun",
            TxrRoute::ListRunLogs => "Txr.listRunLogs",
            TxrRoute::StopRun => "Txr.stopRun",
            TxrRoute::StopMethod => "Txr.stopMethod",
            TxrRoute::SkipMethod => "Txr.skipMethod",
            TxrRoute::RerunRun => "Txr.rerunRun",
            TxrRoute::SetAtATime => "Txr.setAtATime",
            TxrRoute::DeleteRun => "Txr.deleteRun",
            TxrRoute::ClearRuns => "Txr.clearRuns",
            TxrRoute::GetPredictions => "Txr.getPredictions",
            TxrRoute::DownloadPredictions => "Txr.downloadPredictions",
            TxrRoute::GetAnalysisConfig => "Txr.getAnalysisConfig",
            TxrRoute::UpdateAnalysisConfig => "Txr.updateAnalysisConfig",
        }
    }

    /// The HTTP verb.
    pub fn method(self) -> &'static str {
        match self {
            TxrRoute::CreateRun
            | TxrRoute::StopRun
            | TxrRoute::StopMethod
            | TxrRoute::SkipMethod
            | TxrRoute::RerunRun
            | TxrRoute::SetAtATime => "POST",
            TxrRoute::ListRuns
            | TxrRoute::GetRun
            | TxrRoute::StreamRun
            | TxrRoute::ListRunLogs
            | TxrRoute::GetPredictions
            | TxrRoute::DownloadPredictions
            | TxrRoute::GetAnalysisConfig => "GET",
            TxrRoute::DeleteRun | TxrRoute::ClearRuns => "DELETE",
            TxrRoute::UpdateAnalysisConfig => "PUT",
        }
    }

    /// The registered path under `/api` (the `{id}`/`{method_id}` segment
    /// names of the `Path<Uuid>`/`Path<String>` extractors).
    pub fn path(self) -> &'static str {
        match self {
            TxrRoute::CreateRun | TxrRoute::ListRuns => "/txr/runs",
            TxrRoute::GetRun => "/txr/runs/{id}",
            TxrRoute::StreamRun => "/txr/runs/{id}/stream",
            TxrRoute::ListRunLogs => "/txr/runs/{id}/logs",
            TxrRoute::StopRun => "/txr/runs/{id}/stop",
            TxrRoute::StopMethod => "/txr/runs/{id}/methods/{method_id}/stop",
            TxrRoute::SkipMethod => "/txr/runs/{id}/methods/{method_id}/skip",
            TxrRoute::RerunRun => "/txr/runs/{id}/rerun",
            TxrRoute::SetAtATime => "/txr/runs/{id}/at-a-time",
            TxrRoute::DeleteRun => "/txr/runs/{id}",
            TxrRoute::ClearRuns => "/txr/runs",
            TxrRoute::GetPredictions => "/txr/runs/{id}/predictions",
            TxrRoute::DownloadPredictions => "/txr/runs/{id}/predictions.csv",
            TxrRoute::GetAnalysisConfig | TxrRoute::UpdateAnalysisConfig => "/txr/analysis-config",
        }
    }
}

/// The module's route set + the layered state (registered by
/// [`super::ExecutionEngineModule::register_routes`] under the framework's
/// `/api` prefix; no root catch-all).
pub fn txr_routes(state: TxrRouteState) -> ApiRouter {
    let mut router = ApiRouter::new();
    for route in TxrRoute::ALL {
        let method_router = match route {
            TxrRoute::CreateRun => post_with(create_run, create_run_docs),
            TxrRoute::ListRuns => get_with(list_runs, list_runs_docs),
            TxrRoute::GetRun => get_with(get_run, get_run_docs),
            TxrRoute::StreamRun => get_with(stream_run, stream_run_docs),
            TxrRoute::ListRunLogs => get_with(list_run_logs, list_run_logs_docs),
            TxrRoute::StopRun => post_with(stop_run, stop_run_docs),
            TxrRoute::StopMethod => post_with(stop_method, stop_method_docs),
            TxrRoute::SkipMethod => post_with(skip_method, skip_method_docs),
            TxrRoute::RerunRun => post_with(rerun_run, rerun_run_docs),
            TxrRoute::SetAtATime => post_with(set_at_a_time, set_at_a_time_docs),
            TxrRoute::DeleteRun => delete_with(delete_run, delete_run_docs),
            TxrRoute::ClearRuns => delete_with(clear_runs, clear_runs_docs),
            TxrRoute::GetPredictions => get_with(get_predictions, get_predictions_docs),
            TxrRoute::DownloadPredictions => {
                get_with(download_predictions, download_predictions_docs)
            }
            TxrRoute::GetAnalysisConfig => get_with(get_analysis_config, get_analysis_config_docs),
            TxrRoute::UpdateAnalysisConfig => {
                put_with(update_analysis_config, update_analysis_config_docs)
            }
        };
        router = router.api_route(route.path(), method_router);
    }
    router.layer(Extension(state))
}

// ─────────────────────────────────────────────────────────────────────────────
// The request-body extractor (the file_validator precedent): the emitted
// request-body schema stays the typed one, the REJECTION is the endpoint's
// named 400 — a body that does not match the contract is the plan's code
// (INVALID_MODE / INVALID_AT_A_TIME / INVALID_BODY), never the framework's
// default 422.
// ─────────────────────────────────────────────────────────────────────────────

/// The named parse-error code of one POST/PUT endpoint.
pub trait BodyErrorCode {
    const CODE: &'static str;
}

pub enum CreateBodyCode {}
pub enum AtATimeBodyCode {}
pub enum ConfigBodyCode {}

impl BodyErrorCode for CreateBodyCode {
    const CODE: &'static str = "INVALID_MODE";
}

impl BodyErrorCode for AtATimeBodyCode {
    const CODE: &'static str = "INVALID_AT_A_TIME";
}

impl BodyErrorCode for ConfigBodyCode {
    const CODE: &'static str = "INVALID_BODY";
}

#[derive(Debug)]
pub struct BodyJson<T, C> {
    pub value: T,
    _code: PhantomData<C>,
}

impl<T, C> BodyJson<T, C> {
    pub fn into_inner(self) -> T {
        self.value
    }
}

fn reject(status: StatusCode, body_text: String, code: &'static str) -> (StatusCode, AppError) {
    let status = if status == StatusCode::UNPROCESSABLE_ENTITY {
        StatusCode::BAD_REQUEST
    } else {
        status
    };
    let message = match status {
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "the request body must be JSON".to_string(),
        StatusCode::BAD_REQUEST => {
            format!("the request body does not match the contract: {body_text}")
        }
        _ => format!("the request body could not be read: {body_text}"),
    };
    (status, AppError::new(status, code, message))
}

impl<S, T, C> FromRequest<S> for BodyJson<T, C>
where
    S: Send + Sync,
    T: DeserializeOwned,
    C: BodyErrorCode,
    axum::Json<T>: FromRequest<S, Rejection = axum::extract::rejection::JsonRejection>,
{
    type Rejection = (StatusCode, AppError);

    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, Self::Rejection> {
        let axum::Json(value) =
            axum::Json::<T>::from_request(req, state)
                .await
                .map_err(|rejection| {
                    let status = rejection.status();
                    let text = rejection.body_text();
                    reject(status, text, C::CODE)
                })?;
        Ok(BodyJson {
            value,
            _code: PhantomData,
        })
    }
}

impl<T: JsonSchema, C: BodyErrorCode> OperationInput for BodyJson<T, C> {
    fn operation_input(
        ctx: &mut aide::generate::GenContext,
        operation: &mut aide::openapi::Operation,
    ) {
        <axum::Json<T> as OperationInput>::operation_input(ctx, operation);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-2 — POST /api/txr/runs
// ─────────────────────────────────────────────────────────────────────────────

async fn create_run(
    state: Extension<TxrRouteState>,
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    body: BodyJson<CreateRunRequest, CreateBodyCode>,
) -> ApiResult<Json<TxrRunSummary>> {
    let summary = orchestrator::start_run(
        pool,
        state.runtime.clone(),
        state.env.clone(),
        state.executor.clone(),
        auth.user.id,
        body.into_inner(),
    )
    .await
    .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::ACCEPTED, Json(summary)))
}

fn create_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Create + start a run: one analysis = one persisted run row (input snapshot + \
             analysis config + selected methods, or the resolved model assets for a reuse \
             run). The engine validates the tables in-process, classifies every selected \
             method (queued / cannot-run with its reason), writes the run dir + input \
             copies, and drives the methods in their own sandboxed stacks until the run \
             finishes. A second create while one run is active is 409 \
             RUN_ALREADY_ACTIVE.",
        )
        .id("Txr.createRun")
        .tag("txr")
        .response::<202, Json<TxrRunSummary>>()
        .response_with::<400, (), _>(|r| r.description("EMPTY_METHODS / EMPTY_MODELS / INVALID_AT_A_TIME / INVALID_DECISION_DAY / INVALID_LOOK_AHEAD / INVALID_MODEL_ASSET / INVALID_MODE"))
        .response_with::<404, (), _>(|r| r.description("METHOD_NOT_FOUND"))
        .response_with::<409, (), _>(|r| r.description("RUN_ALREADY_ACTIVE"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-3 — GET /api/txr/runs, GET /api/txr/runs/{id}
// ─────────────────────────────────────────────────────────────────────────────

async fn list_runs(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<TxrRunListQuery>,
) -> ApiResult<Json<TxrRunListResponse>> {
    let limit = q
        .limit
        .unwrap_or(super::types::TxrLimits::RUN_LIST_LIMIT_DEFAULT)
        .clamp(1, super::types::TxrLimits::RUN_LIST_LIMIT_MAX);
    let offset = q.offset.unwrap_or(0);
    let repo = TxrRepository::new(pool);
    let (runs, total) = repo
        .list_run_summaries(limit, offset)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((
        StatusCode::OK,
        Json(TxrRunListResponse {
            runs,
            total,
            limit,
            offset,
        }),
    ))
}

fn list_runs_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "The History page (K): runs newest first, paged (limit default 50, max 200), \
             one summary per run (status, counts, config, input summary, run dir).",
        )
        .id("Txr.listRuns")
        .tag("txr")
        .response::<200, Json<TxrRunListResponse>>()
}

async fn get_run(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
) -> ApiResult<Json<TxrRunDetail>> {
    let detail = run_detail(&TxrRepository::new(pool), id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(detail)))
}

fn get_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "One run's detail = the summary + the per-method rows (state, phase, reason, \
             coverage, probability source) + the produced models + the create-time \
             estimate (null when not computed) + the outcome facts.",
        )
        .id("Txr.getRun")
        .tag("txr")
        .response::<200, Json<TxrRunDetail>>()
        .response_with::<404, (), _>(|r| r.description("Unknown run (RUN_NOT_FOUND)"))
}

/// The detail assembly (the route's only non-trivial read): summary +
/// method rows + produced models + log count + the derivation facts.
async fn run_detail(repo: &TxrRepository, id: Uuid) -> Result<TxrRunDetail, AppError> {
    let Some(row) = repo.get_run(id).await? else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {id}"),
        ));
    };
    let method_ids = repo.method_ids_for_run(id).await?;
    let summary = row.summarize(method_ids)?;
    let rows = repo.methods_for_run(id).await?;
    let methods = rows
        .iter()
        .map(|m| m.clone().into_method())
        .collect::<Result<Vec<_>, AppError>>()?;
    let models = produced_models(repo.pool(), id).await?;
    let log_lines = repo.log_total(id).await?;
    let estimate = row.estimate()?;
    let endpoint = summary.config.endpoint;
    let horizon = summary.config.look_ahead_day;
    let cpus = row
        .cpus
        .map(|c| c as u32)
        .unwrap_or_else(orchestrator::detect_cpus);
    let task_is_mixed = {
        let mut seen: Vec<&str> = Vec::new();
        for m in &rows {
            if let Some(t) = &m.task {
                if !seen.contains(&t.as_str()) {
                    seen.push(t.as_str());
                }
            }
        }
        seen.len() > 1
    };
    Ok(TxrRunDetail {
        summary,
        methods,
        models,
        log_lines,
        estimate,
        cpus,
        memory_total_bytes: row.memory_total_bytes.map(|v| v as u64),
        outcome: TxrRunOutcome {
            endpoint,
            horizon,
            task_is_mixed,
        },
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-5 — GET /api/txr/runs/{id}/logs
// ─────────────────────────────────────────────────────────────────────────────

async fn list_run_logs(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
    Query(q): Query<super::types::TxrRunLogsQuery>,
) -> ApiResult<Json<TxrRunLogsResponse>> {
    let repo = TxrRepository::new(pool);
    if repo
        .get_run(id)
        .await
        .map_err(|e| e.to_api_error())?
        .is_none()
    {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {id}"),
        )
        .to_api_error());
    }
    let limit = q
        .limit
        .unwrap_or(super::types::TxrLimits::LOG_PAGE_LIMIT_MAX)
        .clamp(1, super::types::TxrLimits::LOG_PAGE_LIMIT_MAX);
    let (lines, total, next_seq) = repo
        .logs_page(id, q.method_id.as_deref(), q.after_seq.unwrap_or(0), limit)
        .await
        .map_err(|e| e.to_api_error())?;
    let mut out = Vec::with_capacity(lines.len());
    for l in lines {
        out.push(l.into_line().map_err(|e| e.to_api_error())?);
    }
    Ok((
        StatusCode::OK,
        Json(TxrRunLogsResponse {
            lines: out,
            next_seq,
            total,
        }),
    ))
}

fn list_run_logs_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "One run's log page (ascending seq after `after_seq`; optional `method_id` \
             filter; `limit` ≤ 2000): engine-authored state lines + the methods' \
             stdout/stderr lines. The pane pages forward with `next_seq`.",
        )
        .id("Txr.listRunLogs")
        .tag("txr")
        .response::<200, Json<TxrRunLogsResponse>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-4 — GET /api/txr/runs/{id}/stream (SSE)
// ─────────────────────────────────────────────────────────────────────────────

async fn stream_run(
    state: Extension<TxrRouteState>,
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, axum::Error>>>> {
    let repo = TxrRepository::new(pool);
    let Some(row) = repo.get_run(id).await.map_err(|e| e.to_api_error())? else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {id}"),
        )
        .to_api_error());
    };

    // Subscribe FIRST (no gap between the replay snapshot and live frames),
    // then re-read the status to close the race where the run finalized just
    // before we subscribed (its finalize already called `close_run`).
    let terminal_now = row.status().map(is_terminal).unwrap_or(true);
    let live_rx = if terminal_now {
        None
    } else {
        match state.runtime.subscribe(id) {
            Some(rx) => Some(rx),
            None => return Err(AppError::internal_error("run stream registry full").to_api_error()),
        }
    };

    // Replay snapshot: status + the last 200 log lines + every method row +
    // each finished method's prediction frame.
    let logs = repo.logs_tail(id, 200).await.unwrap_or_default();
    let methods = repo.methods_for_run(id).await.unwrap_or_default();
    let current_row = repo.get_run(id).await.ok().flatten();
    let current_status = current_row
        .as_ref()
        .map(|r| r.status.clone())
        .unwrap_or_else(|| row.status.clone());
    let now_terminal = current_row
        .as_ref()
        .and_then(|r| r.status().ok())
        .map(is_terminal)
        .unwrap_or(true);

    // A run that finalized between the check and the subscribe: its
    // `close_run` already ran, so the sender registered above would leak
    // (nothing will ever prune it). Close it; the stream serves the replay.
    if now_terminal && live_rx.is_some() {
        state.runtime.close_run(id);
    }

    let live = live_rx;
    let stream = async_stream::stream! {
        yield Ok(TxrRunEvent::Status(TxrRunStatusFrame { status: current_status }).into());
        for l in logs {
            if let Ok(line) = l.into_line() {
                yield Ok(TxrRunEvent::Log(line).into());
            }
        }
        for m in methods {
            yield Ok(TxrRunEvent::Method(method_frame(&m)).into());
            if let Some(frame) = prediction_frame(&m) {
                yield Ok(TxrRunEvent::Prediction(frame).into());
            }
        }
        if !now_terminal {
            if let Some(mut rx) = live {
                while let Some(ev) = rx.recv().await {
                    yield ev;
                }
            }
        }
    };

    Ok((
        StatusCode::OK,
        Sse::new(stream).keep_alive(KeepAlive::default()),
    ))
}

fn stream_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "SSE stream of one run's status / method / log / progress / prediction frames \
             (text/event-stream). On connect the server replays the snapshot (status + the \
             last 200 log lines + every method row + the finished methods' prediction \
             frames), then streams live frames until the run turns terminal.",
        )
        .id("Txr.streamRun")
        .tag("txr")
        // Schema carrier so TxrRunEvent enters types.ts (the live body is SSE).
        .response::<200, Json<TxrRunEvent>>()
}

fn is_terminal(status: TxrRunStatus) -> bool {
    matches!(
        status,
        TxrRunStatus::Finished | TxrRunStatus::Failed | TxrRunStatus::Stopped
    )
}

/// The frame helper for a method row (the SSE vocabulary of PROV-EE-4).
fn method_frame(m: &MethodRow) -> TxrRunMethodFrame {
    TxrRunMethodFrame {
        method_id: m.method_id.clone(),
        state: m.state.clone(),
        reason_code: m.reason_code.clone(),
        phase: m.phase.clone(),
        bytes_downloaded: m.bytes_downloaded.max(0) as u64,
        bytes_total: m.bytes_total.map(|v| v.max(0) as u64),
        elapsed_secs: m.elapsed_secs.map(|v| v.max(0) as u64),
    }
}

/// A finished method's prediction frame (the G screen appends the column
/// live) — only when the row carries the full column facts.
fn prediction_frame(m: &MethodRow) -> Option<TxrRunPredictionFrame> {
    if !matches!(m.state(), Ok(super::types::TxrMethodState::Finished)) {
        return None;
    }
    let prob_source = m.prob_source.as_ref()?;
    let scored = m.coverage_scored?;
    let eligible = m.coverage_eligible?;
    Some(TxrRunPredictionFrame {
        method_id: m.method_id.clone(),
        prob_source: prob_source.clone(),
        coverage_fraction: if eligible > 0 {
            scored as f64 / eligible as f64
        } else {
            0.0
        },
        scored: scored.max(0) as u64,
        eligible: eligible.max(0) as u64,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-6 — control: stop / stop-method / skip-method / at-a-time / rerun /
// delete / clear
// ─────────────────────────────────────────────────────────────────────────────

async fn stop_run(
    state: Extension<TxrRouteState>,
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
) -> ApiResult<()> {
    orchestrator::stop_run(pool, state.runtime.clone(), id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::ACCEPTED, ()))
}

fn stop_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Stop the whole run: running methods turn stopped (ABORTED), \
             waiting/downloading turn skipped, the run row turns `stopped`, and the last \
             log line names the user's stop. Already stopped → 202 (idempotent); a \
             finished/failed run → 409 RUN_NOT_ACTIVE.",
        )
        .id("Txr.stopRun")
        .tag("txr")
        .response::<202, ()>()
        .response_with::<409, (), _>(|r| r.description("RUN_NOT_ACTIVE / the run is terminal"))
}

async fn stop_method(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath((id, method_id)): AxumPath<(Uuid, String)>,
) -> ApiResult<()> {
    orchestrator::stop_method(pool, id, &method_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::ACCEPTED, ()))
}

fn stop_method_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Stop ONE method (waiting/downloading/running → stopped + ABORTED; the run \
             keeps the other methods' results). A method that already finished/failed/\
             skipped cannot_run → 409 METHOD_NOT_ACTIVE; an unknown method → 404 \
             METHOD_NOT_FOUND.",
        )
        .id("Txr.stopMethod")
        .tag("txr")
        .response::<202, ()>()
}

async fn skip_method(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath((id, method_id)): AxumPath<(Uuid, String)>,
) -> ApiResult<()> {
    orchestrator::skip_method(pool, id, &method_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::ACCEPTED, ()))
}

fn skip_method_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Skip ONE method that has not run yet (waiting/downloading → skipped, never \
             executed). A running method → 409 METHOD_NOT_SKIPPABLE (stop it first); a \
             terminal method → 409 METHOD_NOT_SKIPPABLE.",
        )
        .id("Txr.skipMethod")
        .tag("txr")
        .response::<202, ()>()
}

async fn set_at_a_time(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
    body: BodyJson<TxrAtATimeRequest, AtATimeBodyCode>,
) -> ApiResult<Json<TxrRunSummary>> {
    let summary = orchestrator::set_at_a_time_run(pool, id, body.value.at_a_time)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(summary)))
}

fn set_at_a_time_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "The mid-run lane change: `at_a_time` outside 1..=8 → 400 \
             INVALID_AT_A_TIME; a running method is never interrupted — the new permit \
             count applies from the next admission; the returned summary carries the \
             updated config.",
        )
        .id("Txr.setAtATime")
        .tag("txr")
        .response::<200, Json<TxrRunSummary>>()
}

async fn rerun_run(
    state: Extension<TxrRouteState>,
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
) -> ApiResult<Json<TxrRunSummary>> {
    let summary = orchestrator::rerun_run(
        pool,
        state.runtime.clone(),
        state.env.clone(),
        state.executor.clone(),
        auth.user.id,
        id,
    )
    .await
    .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::ACCEPTED, Json(summary)))
}

fn rerun_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "The K board's \"Run again with the same settings\": clone the run from its \
             persisted input record (new run id, same config + inputs + methods/models). \
             404 RUN_NOT_FOUND; 400 RUN_INPUT_RECORD_MISSING when the run dir holds no \
             record; 409 RUN_ALREADY_ACTIVE while another run is live.",
        )
        .id("Txr.rerunRun")
        .tag("txr")
        .response::<202, Json<TxrRunSummary>>()
}

async fn delete_run(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
    Query(q): Query<TxrDeleteQuery>,
) -> ApiResult<()> {
    let repo = TxrRepository::new(pool);
    let Some(row) = repo.get_run(id).await.map_err(|e| e.to_api_error())? else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {id}"),
        )
        .to_api_error());
    };
    // A live run is stopped first (a running drive writing to deleted rows
    // would only log; the user's stop is the honest order).
    if let Some(drive) = orchestrator::drive_for(id) {
        drive.signal_stop_all();
    }
    if !repo.delete_run(id).await.map_err(|e| e.to_api_error())? {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {id}"),
        )
        .to_api_error());
    }
    if q.delete_files {
        orchestrator::prune_run_dir(Path::new(&row.dir)).map_err(|e| e.to_api_error())?;
    }
    Ok((StatusCode::NO_CONTENT, ()))
}

fn delete_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Delete one run (its method rows + logs cascade). `delete_files=false` keeps \
             the run folder (the K board's \"do not keep copies\" sends true); \
             `delete_files=true` prunes the tree. 404 RUN_NOT_FOUND.",
        )
        .id("Txr.deleteRun")
        .tag("txr")
        .response::<204, ()>()
}

async fn clear_runs(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<TxrDeleteQuery>,
) -> ApiResult<()> {
    let repo = TxrRepository::new(pool);
    let dirs = repo.all_run_dirs().await.map_err(|e| e.to_api_error())?;
    for (id, _) in &dirs {
        if let Some(drive) = orchestrator::drive_for(*id) {
            drive.signal_stop_all();
        }
    }
    repo.delete_all_runs().await.map_err(|e| e.to_api_error())?;
    if q.delete_files {
        for (_, dir) in dirs {
            orchestrator::prune_run_dir(Path::new(&dir)).map_err(|e| e.to_api_error())?;
        }
    }
    Ok((StatusCode::NO_CONTENT, ()))
}

fn clear_runs_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "The K board's \"Clear all history\": delete every run (rows cascade); \
             `delete_files=true` also prunes the run folders.",
        )
        .id("Txr.clearRuns")
        .tag("txr")
        .response::<204, ()>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-7 — GET /api/txr/runs/{id}/predictions (+ .csv)
// ─────────────────────────────────────────────────────────────────────────────

/// One recorded per-patient cell of [`super::predictions::write_chance_column`]'s
/// artifact.
#[derive(Debug, Clone, PartialEq)]
pub struct ChanceRow {
    pub patient_id: String,
    pub probability: Option<f64>,
    pub note: String,
}

/// Read one finished method's recorded column (the executor's
/// `output/<method_id>/chance.csv`; `None` when the method never recorded one
/// — a failed/stopped/skipped method, or an old tree).
fn read_chance_column(run_dir: &Path, method_id: &str) -> Option<Vec<ChanceRow>> {
    let text =
        std::fs::read_to_string(run_dir.join("output").join(method_id).join("chance.csv")).ok()?;
    let table = super::bundle::parse_csv(&text).ok()?;
    let ids = table.col("patient_id")?;
    let probs = table.col("probability").unwrap_or_default();
    let notes = table.col("note").unwrap_or_default();
    Some(
        ids.iter()
            .enumerate()
            .map(|(i, id)| ChanceRow {
                patient_id: id.clone(),
                probability: probs
                    .get(i)
                    .and_then(|c| super::bundle::parse_number(c))
                    .filter(|x| x.is_finite()),
                note: notes.get(i).cloned().unwrap_or_default(),
            })
            .collect(),
    )
}

/// The run's finished-method columns, aligned to the ordered union of the
/// methods' surfaces. Every finished method row is read in run-method order;
/// the FIRST column defines the patient order and later methods append
/// patients they alone carry (a different marker set can surface a slightly
/// different cohort).
fn assemble_predictions(
    run_dir: &Path,
    rows: &[MethodRow],
) -> (Vec<String>, Vec<TxrPredictionMethod>) {
    let mut patients: Vec<String> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut methods_out: Vec<TxrPredictionMethod> = Vec::new();
    for m in rows {
        if !matches!(m.state(), Ok(super::types::TxrMethodState::Finished)) {
            continue;
        }
        let Some(chance) = read_chance_column(run_dir, &m.method_id) else {
            tracing::warn!(
                method_id = %m.method_id,
                run_id = %m.run_id,
                "execution engine: finished method has no recorded chance column"
            );
            continue;
        };
        let mut local: Vec<(usize, Option<f64>, Option<String>)> = Vec::new();
        for c in &chance {
            let slot = match index.get(&c.patient_id) {
                Some(i) => *i,
                None => {
                    let i = patients.len();
                    index.insert(c.patient_id.clone(), i);
                    patients.push(c.patient_id.clone());
                    i
                }
            };
            local.push((
                slot,
                c.probability,
                if c.note.is_empty() {
                    None
                } else {
                    Some(c.note.clone())
                },
            ));
        }
        // Pad to the FULL patient list: a patient this method's surface
        // does not carry is a null probability + no note (never a gap in
        // the aligned arrays).
        let mut probabilities: Vec<Option<f64>> = vec![None; patients.len()];
        let mut notes: Vec<Option<String>> = vec![None; patients.len()];
        for (slot, p, n) in local {
            probabilities[slot] = p;
            notes[slot] = n;
        }
        // The group label: the catalogue fact for the row's method id first
        // (the train case), then for the row's LABEL — a reuse run's
        // method_id is the model's UUID while its label is the model's name
        // (an app-manifest id) — else the raw group id (a renamed model or a
        // method removed from the catalogue after the run still renders —
        // qa-fixes RES-05).
        let group_label = envmanifest::facts_for(&m.method_id)
            .or_else(|| envmanifest::facts_for(&m.label))
            .map(|f| f.group_label.clone())
            .unwrap_or_else(|| m.group.clone());
        methods_out.push(TxrPredictionMethod {
            method_id: m.method_id.clone(),
            label: m.label.clone(),
            group: m.group.clone(),
            group_label,
            task: match m.task.as_deref() {
                Some("os") => TxrTask::Os,
                Some("response") => TxrTask::Response,
                _ => TxrTask::Pfs,
            },
            prob_source: match m.prob_source.as_deref() {
                Some("recalibrated") => TxrProbSource::Recalibrated,
                Some("none") => TxrProbSource::None,
                _ => TxrProbSource::Native,
            },
            coverage: match (m.coverage_scored, m.coverage_eligible) {
                (Some(scored), Some(eligible)) => TxrCoverage {
                    scored: scored.max(0) as u32,
                    eligible: eligible.max(0) as u32,
                    fraction: if eligible > 0 {
                        scored as f64 / eligible as f64
                    } else {
                        0.0
                    },
                },
                _ => TxrCoverage {
                    scored: 0,
                    eligible: 0,
                    fraction: 0.0,
                },
            },
            probabilities,
            notes,
        });
    }
    (patients, methods_out)
}

/// The per-patient average over the methods' non-null values (DEC-11 — the
/// G board's "per-patient average" column; null when no method scored the
/// patient).
fn average_column(patients: &[String], methods: &[TxrPredictionMethod]) -> Vec<Option<f64>> {
    patients
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let vals: Vec<f64> = methods
                .iter()
                .filter_map(|m| m.probabilities.get(i).copied().flatten())
                .collect();
            if vals.is_empty() {
                None
            } else {
                Some(vals.iter().sum::<f64>() / vals.len() as f64)
            }
        })
        .collect()
}

/// The run's displayed (endpoint, horizon) facts (the config JSON on the
/// row — parsed once per read).
fn run_config(row: &super::repository::RunRow) -> Result<RunConfig, AppError> {
    super::repository::parse_config(&row.config)
        .map_err(|e| AppError::database_error(format!("stored run config invalid: {e}")))
}

async fn get_predictions(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
) -> ApiResult<Json<TxrPredictionsResponse>> {
    let repo = TxrRepository::new(pool);
    let Some(row) = repo.get_run(id).await.map_err(|e| e.to_api_error())? else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {id}"),
        )
        .to_api_error());
    };
    let config = run_config(&row).map_err(|e| e.to_api_error())?;
    let rows = repo
        .methods_for_run(id)
        .await
        .map_err(|e| e.to_api_error())?;
    let (patients, methods) = tokio::task::spawn_blocking({
        let dir = PathBuf::from(&row.dir);
        move || assemble_predictions(&dir, &rows)
    })
    .await
    .map_err(|e| {
        AppError::internal_error(format!("predictions read task join: {e}")).to_api_error()
    })?;
    if methods.is_empty() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "PREDICTIONS_UNAVAILABLE",
            "no method has finished a predictions column yet".to_string(),
        )
        .to_api_error());
    }
    let average = average_column(&patients, &methods);
    Ok((
        StatusCode::OK,
        Json(TxrPredictionsResponse {
            run_id: id,
            endpoint: config.endpoint,
            horizon: config.look_ahead_day,
            patients,
            methods,
            average,
            generated_at: chrono::Utc::now(),
        }),
    ))
}

fn get_predictions_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "The heatmap data (G): one aligned array per patient, one entry per FINISHED \
             method (partial while the run continues). A null probability is an \
             abstention with its note; `average` is the per-patient mean over non-null \
             values. 409 PREDICTIONS_UNAVAILABLE when no method has finished yet.",
        )
        .id("Txr.getPredictions")
        .tag("txr")
        .response::<200, Json<TxrPredictionsResponse>>()
}

async fn download_predictions(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    AxumPath(id): AxumPath<Uuid>,
) -> ApiResult<impl axum::response::IntoResponse> {
    let repo = TxrRepository::new(pool);
    let Some(row) = repo.get_run(id).await.map_err(|e| e.to_api_error())? else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "RUN_NOT_FOUND",
            format!("no run {id}"),
        )
        .to_api_error());
    };
    let rows = repo
        .methods_for_run(id)
        .await
        .map_err(|e| e.to_api_error())?;
    let (patients, methods) = tokio::task::spawn_blocking({
        let dir = PathBuf::from(&row.dir);
        move || assemble_predictions(&dir, &rows)
    })
    .await
    .map_err(|e| {
        AppError::internal_error(format!("predictions read task join: {e}")).to_api_error()
    })?;
    if methods.is_empty() {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "PREDICTIONS_UNAVAILABLE",
            "no method has finished a predictions column yet".to_string(),
        )
        .to_api_error());
    }
    let csv = predictions_csv_text(&patients, &methods);
    let id8 = &id.simple().to_string()[..8];
    Ok((
        StatusCode::OK,
        (
            [
                (
                    header::CONTENT_TYPE,
                    String::from("text/csv; charset=utf-8"),
                ),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"txr-predictions-{id8}.csv\""),
                ),
            ],
            csv,
        ),
    ))
}

fn download_predictions_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "The predictions CSV download (board G's \"Download\"): header `patient_id` + \
             one column per finished method (its id; probability, 6 decimals, empty when \
             abstained) + one `notes` column (`\"<method_id>: <note>\"` per note, \
             newline-joined in one cell). Works while the run is active (finished methods \
             only). 409 PREDICTIONS_UNAVAILABLE when none finished.",
        )
        .id("Txr.downloadPredictions")
        .tag("txr")
        .response_with::<200, (), _>(|r| {
            r.description("text/csv; charset=utf-8 — the per-patient chance columns")
        })
}

/// The CSV download text (DEC-11's shapes).
fn predictions_csv_text(patients: &[String], methods: &[TxrPredictionMethod]) -> String {
    let mut out = String::from("patient_id");
    for m in methods {
        out.push(',');
        out.push_str(&super::bundle::csv_cell(&m.method_id));
    }
    out.push_str(",notes\n");
    for (i, p) in patients.iter().enumerate() {
        out.push_str(&super::bundle::csv_cell(p));
        for m in methods {
            out.push(',');
            if let Some(v) = m.probabilities.get(i).copied().flatten() {
                out.push_str(&format!("{v:.6}"));
            }
        }
        out.push(',');
        let notes_cell: Vec<String> = methods
            .iter()
            .filter_map(|m| {
                m.notes
                    .get(i)
                    .and_then(|n| n.as_deref())
                    .map(|n| format!("{}: {n}", m.method_id))
            })
            .collect();
        out.push_str(&super::bundle::csv_cell(&notes_cell.join("\n")));
        out.push('\n');
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-EE-8 — GET/PUT /api/txr/analysis-config
// ─────────────────────────────────────────────────────────────────────────────

async fn get_analysis_config(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<TxrAppConfig>> {
    let repo = TxrRepository::new(pool);
    let config = repo
        .get_analysis_config()
        .await
        .map_err(|e| e.to_api_error())?
        .unwrap_or(TxrAppConfig {
            config: None,
            last_input_summary: None,
        });
    Ok((StatusCode::OK, Json(config)))
}

fn get_analysis_config_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "The sticky E-screen settings (the singleton `txr_app_config` row; null \
             values are the honest never-configured answers).",
        )
        .id("Txr.getAnalysisConfig")
        .tag("txr")
        .response::<200, Json<TxrAppConfig>>()
}

async fn update_analysis_config(
    _auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    body: BodyJson<TxrAppConfig, ConfigBodyCode>,
) -> ApiResult<()> {
    TxrRepository::new(pool)
        .put_analysis_config(&body.into_inner())
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::NO_CONTENT, ()))
}

fn update_analysis_config_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Store the sticky E-screen settings so \"Start → … → E\" restores the \
             last-used analysis config.",
        )
        .id("Txr.updateAnalysisConfig")
        .tag("txr")
        .response::<204, ()>()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the ITEM-10 unit half
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::repository::MethodRow;
    use crate::modules::execution_engine::types::TxrMethodState;

    /// TEST-EE-02's route half: the registered surface binds EXACTLY the
    /// `ROUTE_DOC_IDS` vocabulary (the inventory is the registration — a new
    /// route must name its doc id or the pin fails).
    #[test]
    fn registered_surface_binds_the_doc_id_vocabulary() {
        let ids: Vec<&str> = TxrRoute::ALL.iter().map(|r| r.doc_id()).collect();
        assert_eq!(ids, super::super::types::ROUTE_DOC_IDS);
        // The (method, path) pairs are distinct (a route cannot shadow
        // another — the two GET/POST-shared paths are opposite verbs).
        let pairs: Vec<(String, &str)> = TxrRoute::ALL
            .iter()
            .map(|r| (format!("{} {}", r.method(), r.path()), r.doc_id()))
            .collect();
        let unique: std::collections::HashSet<&str> = pairs.iter().map(|(_, id)| *id).collect();
        assert_eq!(unique.len(), pairs.len(), "routes must be unique");
    }

    /// One synthetic finished MethodRow shape (the assembly's input).
    fn method_row(
        method_id: &str,
        task: &str,
        prob_source: &str,
        scored: u32,
        eligible: u32,
    ) -> MethodRow {
        MethodRow {
            id: uuid::Uuid::new_v4(),
            run_id: uuid::Uuid::new_v4(),
            method_id: method_id.to_string(),
            label: method_id.to_string(),
            version: "2.0.1".to_string(),
            group: "dynamic_risk".to_string(),
            state: TxrMethodState::Finished.as_str().to_string(),
            reason_code: None,
            reason_detail: None,
            phase: Some("done".to_string()),
            bytes_downloaded: 0,
            bytes_total: Some(0),
            job_id: None,
            env_base_digest: None,
            env_layer_digest: None,
            model_out_digest: None,
            model_dir: None,
            exit_code: Some(0),
            duration_ms: Some(5),
            elapsed_secs: Some(5),
            prob_source: Some(prob_source.to_string()),
            coverage_scored: Some(scored as i64),
            coverage_eligible: Some(eligible as i64),
            task: Some(task.to_string()),
            started_at: None,
            finished_at: None,
            trained_on_patients: None,
            size_bytes: None,
            own_auc: None,
        }
    }

    #[test]
    fn predictions_assemble_one_aligned_table_with_notes_and_average() {
        let run_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/txr-execution-engine-item10/assemble")
            .join(uuid::Uuid::new_v4().simple().to_string());
        let rows = vec![
            super::super::predictions::PredictionRow {
                patient_id: "P1".into(),
                risk: Some(0.9),
                probability: Some(0.9),
                note: String::new(),
            },
            super::super::predictions::PredictionRow {
                patient_id: "P2".into(),
                risk: None,
                probability: None,
                note: "fewer than 3 draws by day 56".into(),
            },
            super::super::predictions::PredictionRow {
                patient_id: "P3".into(),
                risk: Some(0.5),
                probability: Some(0.5),
                note: String::new(),
            },
        ];
        super::super::predictions::write_chance_column(&run_dir, "m-a", &rows).expect("writes");
        // The second method's surface carries P1 + P3 only (a different
        // marker set's cohort) — the union keeps P2 and the alignment pads.
        let rows2 = vec![
            super::super::predictions::PredictionRow {
                patient_id: "P1".into(),
                risk: Some(0.2),
                probability: Some(0.2),
                note: String::new(),
            },
            super::super::predictions::PredictionRow {
                patient_id: "P3".into(),
                risk: Some(0.4),
                probability: Some(0.4),
                note: String::new(),
            },
        ];
        super::super::predictions::write_chance_column(&run_dir, "m-b", &rows2).expect("writes");

        let rows_db = vec![
            method_row("m-a", "pfs", "native", 2, 3),
            method_row("m-b", "pfs", "recalibrated", 2, 2),
        ];
        let (patients, methods) = assemble_predictions(&run_dir, &rows_db);
        assert_eq!(patients, vec!["P1", "P2", "P3"]);
        assert_eq!(methods.len(), 2);
        assert_eq!(methods[0].probabilities, vec![Some(0.9), None, Some(0.5)]);
        assert_eq!(
            methods[0].notes,
            vec![None, Some("fewer than 3 draws by day 56".into()), None]
        );
        assert_eq!(methods[1].probabilities, vec![Some(0.2), None, Some(0.4)]);
        assert_eq!(methods[0].task, TxrTask::Pfs);
        assert_eq!(methods[1].prob_source, TxrProbSource::Recalibrated);
        // The average over non-null values: P1 = (0.9+0.2)/2, P2 none,
        // P3 = (0.5+0.4)/2.
        let average = average_column(&patients, &methods);
        assert_eq!(average[0], Some(0.55));
        assert_eq!(average[1], None);
        assert_eq!(average[2], Some(0.45));

        let csv = predictions_csv_text(&patients, &methods);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "patient_id,m-a,m-b,notes");
        assert_eq!(lines[1], "P1,0.900000,0.200000,");
        assert_eq!(lines[2], "P2,,,m-a: fewer than 3 draws by day 56");
        assert_eq!(lines[3], "P3,0.500000,0.400000,");
        let _ = std::fs::remove_dir_all(&run_dir);
    }

    #[test]
    fn predictions_assembly_keeps_run_order_and_skips_unfinished() {
        let run_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/txr-execution-engine-item10/order")
            .join(uuid::Uuid::new_v4().simple().to_string());
        super::super::predictions::write_chance_column(
            &run_dir,
            "m-first",
            &[super::super::predictions::PredictionRow {
                patient_id: "P9".into(),
                risk: Some(0.1),
                probability: Some(0.1),
                note: String::new(),
            }],
        )
        .expect("writes");
        let mut failed = method_row("m-failed", "pfs", "native", 0, 0);
        failed.state = TxrMethodState::Failed.as_str().to_string();
        let rows_db = vec![failed, method_row("m-first", "pfs", "native", 1, 1)];
        let (patients, methods) = assemble_predictions(&run_dir, &rows_db);
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].method_id, "m-first");
        assert_eq!(patients, vec!["P9"]);
        let _ = std::fs::remove_dir_all(&run_dir);
    }

    /// qa-fixes RES-05: a reuse run's column is headed by the SAVED MODEL's
    /// NAME (the row's `label`), never the model id's UUID, and its group
    /// label is the catalogue's human label resolved through that name.
    #[test]
    fn predictions_assembly_labels_a_reuse_column_with_the_model_name() {
        let run_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/txr-execution-engine-item10/reuse-label")
            .join(uuid::Uuid::new_v4().simple().to_string());
        super::super::predictions::write_chance_column(
            &run_dir,
            "57519b29-fc69-4797-b38f-5822ae9dea91",
            &[super::super::predictions::PredictionRow {
                patient_id: "INS-A-002".into(),
                risk: Some(2.0),
                probability: Some(0.0),
                note: String::new(),
            }],
        )
        .expect("writes");
        let mut reuse_row =
            method_row("57519b29-fc69-4797-b38f-5822ae9dea91", "pfs", "native", 1, 1);
        // A reuse run's method row carries the model's name in `label`
        // (repository.rs), while `method_id` is the resolved model's UUID.
        reuse_row.label = "cfmedip-ctdna-clearance-three-group".to_string();
        reuse_row.group = "response-call".to_string();
        let (_, methods) = assemble_predictions(&run_dir, &[reuse_row]);
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].method_id, "57519b29-fc69-4797-b38f-5822ae9dea91");
        assert_eq!(methods[0].label, "cfmedip-ctdna-clearance-three-group");
        assert_eq!(methods[0].group_label, "Response call");
        let _ = std::fs::remove_dir_all(&run_dir);
    }
}
