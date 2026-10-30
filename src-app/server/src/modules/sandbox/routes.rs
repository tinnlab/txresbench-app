//! Sandbox HTTP surface: status + resource-limits settings + execute.
//!
//! Gated routes call `with_permission::<(..)>` in their `*_docs` so the 403
//! example carries `required_permissions` — that is what the framework's
//! `emit_ts` scrapes to emit the FE `Permissions.<Name>` constants
//! (PLAN_AUDIT correction #2).

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_core::ApiResult;

use crate::modules::jobs::admission;
use crate::modules::permissions::{with_permission, RequirePermissions};

use super::config::{init_status, SandboxAvailability};
use super::permissions::{SandboxExecute, SandboxSettingsManage, SandboxSettingsRead};
use super::service::{run_analysis, AnalysisRequest, AnalysisResult};
use super::settings::{SandboxResourceLimits, SandboxSettingsRepository, UpdateSandboxResourceLimits};
use super::settings_cache;
use crate::modules::rootfs::{self, RootfsStatus};

/// Combined sandbox status for the admin UI.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct SandboxStatus {
    pub availability: SandboxAvailability,
    pub rootfs: RootfsStatus,
    /// #54: the env-image registry BASE analyses pull from — READ-ONLY. This is a
    /// release-time security boundary (a release binary carries no code that could
    /// redirect a pull elsewhere), so it is DISPLAYED but never operator-writable.
    pub env_registry_base: String,
    /// #54: the moving `schema<N>-latest-<arch>` tag resolved at pull time — READ-ONLY,
    /// derived from the binary's rootfs schema + arch.
    pub env_moving_tag: String,
}

pub fn sandbox_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/sandbox/status", get_with(get_status, get_status_docs))
        .api_route(
            "/sandbox/settings",
            get_with(get_settings, get_settings_docs).put_with(update_settings, update_settings_docs),
        )
        .api_route("/sandbox/execute", post_with(execute, execute_docs))
}

// ─────────────────────────────── status ───────────────────────────────

async fn get_status(
    _auth: RequirePermissions<(SandboxSettingsRead,)>,
) -> ApiResult<Json<SandboxStatus>> {
    Ok((
        StatusCode::OK,
        Json(SandboxStatus {
            availability: init_status(),
            rootfs: rootfs::status(),
            env_registry_base: super::env_image::registry_base_display().to_string(),
            env_moving_tag: super::env_image::moving_tag(),
        }),
    ))
}

fn get_status_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsRead,)>(op)
        .id("Sandbox.getStatus")
        .tag("sandbox")
        .summary("Sandbox availability + embedded rootfs status")
        .response::<200, Json<SandboxStatus>>()
}

// ────────────────────────────── settings ──────────────────────────────

async fn get_settings(
    _auth: RequirePermissions<(SandboxSettingsRead,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<SandboxResourceLimits>> {
    let row = SandboxSettingsRepository::new(pool)
        .get()
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(row)))
}

fn get_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsRead,)>(op)
        .id("Sandbox.getSettings")
        .tag("sandbox")
        .summary("Read sandbox resource limits")
        .response::<200, Json<SandboxResourceLimits>>()
}

async fn update_settings(
    auth: RequirePermissions<(SandboxSettingsManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(body): Json<UpdateSandboxResourceLimits>,
) -> ApiResult<Json<SandboxResourceLimits>> {
    let repo = SandboxSettingsRepository::new(pool);
    // Merge the partial update onto the current row, validate the RESULT (422
    // on out-of-range), then persist + refresh the hot-path cache. The acting admin
    // is stamped into `updated_by` (audit, #54; the `*_by` idiom).
    let current = repo.get().await.map_err(|e| e.to_api_error())?;
    let merged = SandboxSettingsRepository::merge(&current, &body);
    merged.validate().map_err(|e| e.to_api_error())?;
    let row = repo.update(&body, auth.user.id).await.map_err(|e| e.to_api_error())?;
    settings_cache::invalidate(row.clone());
    // Realtime cross-device sync is wired at merge (DEC-4) — no-op seam today.
    super::emit_settings_changed();
    Ok((StatusCode::OK, Json(row)))
}

fn update_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsManage,)>(op)
        .id("Sandbox.updateSettings")
        .tag("sandbox")
        .summary("Update sandbox resource limits")
        .response::<200, Json<SandboxResourceLimits>>()
}

// ─────────────────────────────── execute ──────────────────────────────

/// Run a command in the sandbox, synchronously, under the box-wide concurrency cap.
///
/// ## Admission, and why this route did not have any
///
/// This handler spawns a full bwrap child and waits for it. It used to do so with NO
/// admission control whatsoever: N concurrent requests meant N concurrent sandbox
/// children, bounded by nothing but the caller's patience, while `max_concurrent_jobs`
/// sat there bounding the scheduler's children only. A cap that half the spawners
/// ignore is not a cap; it is a number in a settings page.
///
/// It now claims a slot from the SAME pool, through the SAME statement, as the
/// scheduler and `provenance::verify` (`jobs::admission::admit` →
/// `create_running_under_cap`, whose check is a sub-select of the INSERT — N of this
/// handler are in flight at once and a separate `count < cap` read would be a
/// check-then-act race). Deliberately NOT a second limiter beside the first: two
/// independent caps over one CPU pool sum, they do not bound.
///
/// ## The refusal is immediate and typed, not a queue
///
/// A human is holding this socket open. Queueing them behind an invisible depth is
/// indistinguishable from a hang, so a full pool answers **429 `SANDBOX_POOL_FULL`**
/// straight away — a status a client can branch on and a message naming the knob.
///
/// ## What the row buys besides the bound
///
/// `job_type = "sandbox"` (NOT `"analysis"`: boot reconcile finalizes and INGESTS an
/// orphaned running *analysis* job, and this run must never reach the catalog). Minting
/// it also makes the run listable and stoppable through the ordinary jobs surface,
/// which it previously was not — an unbounded run was also an invisible, unkillable
/// one.
async fn execute(
    auth: RequirePermissions<(SandboxExecute,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<AnalysisRequest>,
) -> ApiResult<Json<AnalysisResult>> {
    let job_id = Uuid::new_v4();
    let admitted = admission::admit(
        &pool,
        job_id,
        auth.user.id,
        "sandbox",
        "Sandbox execute",
        serde_json::json!({ "timeout_secs": req.timeout_secs }),
        // No project scope: this route takes no project and invents none. The row is
        // reachable by its owner and by an admin, which is the correct reach for a run
        // nobody else can name.
        None,
    )
    .await
    .map_err(|e| e.to_api_error())?;
    if admitted.is_none() {
        return Err(admission::pool_full("SANDBOX_POOL_FULL").to_api_error());
    }

    // The REST route never accepts client-supplied host mounts (path-escape
    // risk); the pipeline seam passes those in-process.
    let result = run_analysis(&pool, &req, &[], job_id).await;

    // FINALLY-shaped: the slot is released on the error path too. A `running` row that
    // never closes permanently consumes a slot of `max_concurrent_jobs`, so leaking
    // enough of them wedges the scheduler for the life of the process — which would
    // turn this fix into a worse bug than the one it replaces.
    //
    // A non-zero EXIT CODE from the sandboxed command is not a failed run: the run did
    // what it was asked. Only a failure to run at all is `Some(reason)`.
    let failure = result.as_ref().err().map(|e| e.to_string());
    admission::close_slot(&pool, job_id, failure.as_deref()).await;

    let result = result.map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(result)))
}

fn execute_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxExecute,)>(op)
        .id("Sandbox.execute")
        .tag("sandbox")
        .summary("Run an analysis command in the sandbox")
        .response::<200, Json<AnalysisResult>>()
        .response_with::<429, (), _>(|r| {
            r.description("The compute pool is full (max_concurrent_jobs); retry shortly")
        })
}
