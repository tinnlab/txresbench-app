//! Sandbox HTTP surface: status + resource-limits settings + execute + the
//! txr method-env + method-run routes (PROV-SS-5).
//!
//! Gated routes call `with_permission::<(..)>` in their `*_docs` so the 403
//! example carries `required_permissions` — that is what the framework's
//! `emit_ts` scrapes to emit the FE `Permissions.<Name>` constants
//! (PLAN_AUDIT correction #2).
//!
//! The txr half mirrors the DEC-5 pattern of the rest of the module: a thin
//! typed route over the `service` seam (DEC-1 — the sandbox module extension,
//! no new module registration, no new permission — DEC-12 reuses the three
//! existing sandbox permissions). The env routes WRAP the
//! [`super::method_env`] manager's in-process surface; the method-run route
//! wraps [`super::service::run_method_in_stack`] exactly like `/sandbox/execute`
//! wraps `run_analysis` (admission first, 429 on a full pool, the seam's typed
//! 503 for a non-Linux / sandbox-disabled host). The route never accepts
//! client-supplied host mounts beyond the request's own bundle/outputs/model
//! dirs (the in-process pipeline seam passes `mounts`; this wrapper passes
//! none).

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::{ApiResult, AppError};

use crate::modules::jobs::admission;
use crate::modules::permissions::{with_permission, RequirePermissions};

use super::config::{init_status, SandboxAvailability};
use super::env_id::is_valid_env_id;
use super::method_env::{self, EnvKind, MethodEnvStatus};
use super::permissions::{SandboxExecute, SandboxSettingsManage, SandboxSettingsRead};
use super::service::{run_analysis, run_method_in_stack, AnalysisRequest, AnalysisResult};
use super::settings::{SandboxResourceLimits, SandboxSettingsRepository, UpdateSandboxResourceLimits};
use super::settings_cache;
use super::stack::{MethodRunRequest, MethodRunResult};
use crate::modules::rootfs::{self, cache, RootfsStatus};

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
        // ── txr method-env + method-run surface (PROV-SS-5, DEC-12) ──────────
        .api_route("/sandbox/envs", get_with(list_envs, list_envs_docs))
        .api_route(
            "/sandbox/envs/{env_id}",
            get_with(env_status, env_status_docs).delete_with(delete_env, delete_env_docs),
        )
        .api_route("/sandbox/method-run", post_with(method_run, method_run_docs))
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
    repo.update(&body, auth.user.id).await.map_err(|e| e.to_api_error())?;
    // Re-read (not the UPDATE's RETURNING row): the sqlite driver returns the
    // bound value of a NULL written through the CASE "clear" expression as an
    // empty string, while the row itself is NULL (a GET right after shows null).
    // The response must never lie about a clear.
    let row = repo.get().await.map_err(|e| e.to_api_error())?;
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

// ─────────────────────────── method envs + method run ────────────────────────

/// `404` for an env path that names no env id (PROV-SS-5). A well-formed env
/// id the manager has never seen is NOT 404: it is answered 200
/// `not_downloaded` + `EnvKind::Unknown` — the manager's `status` contract
/// (ITEM-3, DRIFT-1 #15) is that its answer for a never-ensured env is a
/// status, and the client (the catalogue holder) is what knows the env exists.
/// The 404 / `ENV_UNKNOWN` refusal is for an id that is not even a valid env
/// id — a name no env can ever exist under.
pub const ENV_UNKNOWN_CODE: &str = "ENV_UNKNOWN";

/// The OpenAPI operation ids of the four txr routes, as single consts so
/// TEST-15 can pin them the way the permission consts are pinned (and the docs
/// functions below cannot drift from the asserted spelling — they USE the
/// consts). These ride the `emit_ts` scraper into the FE
/// `ApiClient.ApiEndpoints` map exactly like `Sandbox.execute`.
pub const LIST_ENVS_DOC_ID: &str = "Sandbox.listEnvs";
pub const ENV_STATUS_DOC_ID: &str = "Sandbox.envStatus";
pub const DELETE_ENV_DOC_ID: &str = "Sandbox.deleteEnv";
pub const METHOD_RUN_DOC_ID: &str = "Sandbox.methodRun";

/// The stacked-mode availability half of [`EnvIndexStatus`] (PROV-SS-5).
///
/// `supported` is the host-capability bit the stacked mode shares with the
/// shipped sandbox (`SandboxAvailability::Ready` — bwrap + squashfuse + userns
/// / `/proc` are all probed at boot); the env-FETCH half (oras) is reported
/// separately in `tool_bins` + `reason` because a staged-or-cached deployment
/// runs without it (ITEM-6's preflight is the operator's checklist, DEC-16).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct StackStatus {
    /// The stacked sandbox mode is available on this host.
    pub supported: bool,
    /// The degradation note when something short of hard-unavailable is wrong
    /// (e.g. `oras` not found for env downloads); `None` when nothing is noted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The compiled txr base-registry prefix — READ-ONLY (a release-time
    /// security boundary, displayed exactly like
    /// [`SandboxStatus::env_registry_base`]).
    pub registry_base: String,
    /// Map of the host tools the txr env fetch path resolves through
    /// (`method_env::tool_bin`): `{ "oras": "<path>" | null }`. Machine-
    /// readable so the admin view can render the exact gap; never trusted for
    /// anything security-relevant.
    pub tool_bins: serde_json::Value,
}

/// `GET /api/sandbox/envs` (PROV-SS-5): the stack half + the two env indexes.
///
/// The `base`/`layers` split is THIS route's classification job — an
/// [`EnvKind::Unknown`] record belongs to neither list (DRIFT-1 #15: the
/// manager never guesses base/layer, so an unknown entry only answers the
/// per-env `status` route).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct EnvIndexStatus {
    pub stack: StackStatus,
    pub base: Vec<MethodEnvStatus>,
    pub layers: Vec<MethodEnvStatus>,
}

/// The `?prune=true` flag of `DELETE /api/sandbox/envs/{env_id}` — separate
/// from the delete itself so "forget the download state" and "also reclaim the
/// cached artifact" are two explicit intents (DEC-17: prune on demand only).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteEnvQuery {
    #[serde(default)]
    pub prune: bool,
}

/// The `supported` + `reason` decision, pure so TEST-15-style unit tests can
/// pin it without a booted server.
fn stack_availability(availability: SandboxAvailability, oras_present: bool) -> (bool, Option<String>) {
    match availability {
        SandboxAvailability::Ready => {
            if oras_present {
                (true, None)
            } else {
                (
                    true,
                    Some(
                        "`oras` not found (<app_data>/bin, then PATH); env DOWNLOADS are \
                         unavailable until it is installed — cached or seam-staged (air-gapped) \
                         environments still run"
                            .to_string(),
                    ),
                )
            }
        }
        other => (
            false,
            Some(format!("the method sandbox is unavailable on this host ({other:?})")),
        ),
    }
}

/// The pure `base`/`layers` classification of the manager's `list()`.
fn split_envs(list: Vec<MethodEnvStatus>) -> (Vec<MethodEnvStatus>, Vec<MethodEnvStatus>) {
    let mut base = Vec::new();
    let mut layers = Vec::new();
    for status in list {
        match status.kind {
            EnvKind::Base => base.push(status),
            EnvKind::Layer => layers.push(status),
            EnvKind::Unknown => {}
        }
    }
    (base, layers)
}

/// The typed 404 answer both env-id routes share.
fn unknown_env(env_id: &str) -> (StatusCode, AppError) {
    (
        StatusCode::NOT_FOUND,
        AppError::new(
            StatusCode::NOT_FOUND,
            ENV_UNKNOWN_CODE,
            format!(
                "no method env named {env_id:?} — the id is not a valid env id \
                 (lowercase alphanumerics, `.` `_` `-` only)"
            ),
        ),
    )
}

/// `GET /api/sandbox/envs` — stack status + every method-env fetch state,
/// split base/layer (PROV-SS-5). Gated `SandboxSettingsRead`, like the other
/// two sandbox GETs.
async fn list_envs(
    _auth: RequirePermissions<(SandboxSettingsRead,)>,
) -> ApiResult<Json<EnvIndexStatus>> {
    let oras = method_env::tool_bin("oras");
    let (supported, reason) = stack_availability(init_status(), oras.is_some());
    let (base, layers) = split_envs(method_env::manager().list());
    Ok((
        StatusCode::OK,
        Json(EnvIndexStatus {
            stack: StackStatus {
                supported,
                reason,
                // The EFFECTIVE base prefix: a debug build with the dev
                // registry seam reports the loopback host, a release build the
                // compiled ghcr.io prefix — the surface never claims a fetch
                // host it does not fetch from (ITEM-2, qa-hardening).
                registry_base: method_env::effective_base_prefix(),
                tool_bins: serde_json::json!({
                    "oras": oras.map(|p| p.to_string_lossy().into_owned())
                }),
            },
            base,
            layers,
        }),
    ))
}

fn list_envs_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsRead,)>(op)
        .id(LIST_ENVS_DOC_ID)
        .tag("sandbox")
        .summary("Stack support + method-env download states (base + layer index)")
        .response::<200, Json<EnvIndexStatus>>()
}

/// `GET /api/sandbox/envs/{env_id}` — one env's download state (PROV-SS-5).
/// A WELL-FORMED id the manager has never ensured answers 200
/// `not_downloaded` + `EnvKind::Unknown` (the manager is catalogue-free — the
/// client holds the id's kind from its own records); only a grammar-invalid id
/// is 404 `ENV_UNKNOWN`.
async fn env_status(
    _auth: RequirePermissions<(SandboxSettingsRead,)>,
    Path(env_id): Path<String>,
) -> ApiResult<Json<MethodEnvStatus>> {
    if !is_valid_env_id(&env_id) {
        return Err(unknown_env(&env_id));
    }
    Ok((StatusCode::OK, Json(method_env::manager().status(&env_id))))
}

fn env_status_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsRead,)>(op)
        .id(ENV_STATUS_DOC_ID)
        .tag("sandbox")
        .summary("One method env's download state")
        .response::<200, Json<MethodEnvStatus>>()
        .response_with::<404, (), _>(|r| {
            r.description("The env id is not a valid env id (ENV_UNKNOWN)")
        })
}

/// `DELETE /api/sandbox/envs/{env_id}?prune=true` — cancel an in-flight
/// download and forget the env's record; `prune` additionally removes the
/// cached artifact for its recorded digest (PROV-SS-5, DEC-17). Gated
/// `SandboxSettingsManage` (a destructive / cache-pruning action).
///
/// The state half is the manager's [`method_env::manager()`] cancellation +
/// record removal; the cache half is [`cache::prune_digest`] (the cache's own
/// rename-then-delete discipline — a busy, mounted digest dir is left intact
/// rather than half-destroyed).
async fn delete_env(
    _auth: RequirePermissions<(SandboxSettingsManage,)>,
    Path(env_id): Path<String>,
    Query(q): Query<DeleteEnvQuery>,
) -> ApiResult<()> {
    // Existence first: a grammar-invalid id, or an env the manager has never
    // ensured (nothing to cancel, forget or prune), is 404 ENV_UNKNOWN.
    let manager = method_env::manager();
    if !is_valid_env_id(&env_id) || manager.status(&env_id).kind == EnvKind::Unknown {
        return Err(unknown_env(&env_id));
    }
    let digest = manager.cancel_and_forget(&env_id);
    if q.prune {
        if let Some(d) = digest.as_deref() {
            if cache::prune_digest(d) {
                tracing::info!(env = %env_id, digest = %d, "txr method env cache entry pruned");
            } else {
                tracing::warn!(
                    env = %env_id,
                    digest = %d,
                    "txr method env cache entry busy (mounted) or absent — left intact"
                );
            }
        }
    }
    Ok((StatusCode::NO_CONTENT, ()))
}

fn delete_env_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxSettingsManage,)>(op)
        .id(DELETE_ENV_DOC_ID)
        .tag("sandbox")
        .summary("Cancel + forget a method env (optionally prune its cached artifact)")
        .response::<204, ()>()
        .response_with::<404, (), _>(|r| {
            r.description("The env id is not a valid env id, or no such env is known (ENV_UNKNOWN)")
        })
}

/// `POST /api/sandbox/method-run` — run ONE benchmark method in its own
/// stacked sandbox (PROV-SS-5). The thin wrapper of
/// [`run_method_in_stack`] over
/// [`MethodRunRequest`]; mirrors [`execute`] exactly: admission FIRST (a full
/// pool answers 429 `SANDBOX_POOL_FULL` immediately — the slot is claimed
/// through the same `jobs::admission` pool as the scheduler and `execute`, so
/// N of these can never stack past `max_concurrent_jobs`), then the seam, then
/// `close_slot` on BOTH paths (a leaked `running` row permanently consumes a
/// slot).
///
/// The route never accepts client-supplied host mounts beyond the request's
/// own bundle/outputs/model dirs (the in-process pipeline seam passes
/// `mounts`; this wrapper passes none, exactly like [`execute`]). The seam's
/// typed 503 `SANDBOX_UNAVAILABLE` (non-Linux / sandbox-disabled host) and all
/// caller-data refusals propagate unchanged.
///
/// The sink is `None`: a synchronous POST has no live progress subscriber (the
/// real consumer is the engine's in-process seam with the run's own sink —
/// CONS-EE-7b); `stdout`/`stderr` in the result still carry the full text.
async fn method_run(
    auth: RequirePermissions<(SandboxExecute,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(req): Json<MethodRunRequest>,
) -> ApiResult<Json<MethodRunResult>> {
    let job_id = Uuid::new_v4();
    let admitted = admission::admit(
        &pool,
        job_id,
        auth.user.id,
        "sandbox",
        "Method stack run",
        serde_json::json!({ "mode": req.mode, "timeout_secs": req.timeout_secs }),
        // No project scope: this route takes no project and invents none (the
        // same reach rule as `execute`).
        None,
    )
    .await
    .map_err(|e| e.to_api_error())?;
    if admitted.is_none() {
        return Err(admission::pool_full("SANDBOX_POOL_FULL").to_api_error());
    }

    let result = run_method_in_stack(&pool, &req, &[], job_id, None).await;

    // FINALLY-shaped slot release: a non-zero EXIT CODE is not a failed run;
    // only a failure to run at all is Some(reason) — same rule as `execute`.
    let failure = result.as_ref().err().map(|e| e.to_string());
    admission::close_slot(&pool, job_id, failure.as_deref()).await;

    let result = result.map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(result)))
}

fn method_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(SandboxExecute,)>(op)
        .id(METHOD_RUN_DOC_ID)
        .tag("sandbox")
        .summary("Run one benchmark method in its own stacked sandbox environment")
        .response::<200, Json<MethodRunResult>>()
        .response_with::<429, (), _>(|r| {
            r.description("The compute pool is full (max_concurrent_jobs); retry shortly")
        })
        .response_with::<503, (), _>(|r| {
            r.description("The method sandbox is unavailable on this host (SANDBOX_UNAVAILABLE)")
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::method_env::MethodEnvState;
    use crate::modules::sandbox::stack::MethodRunMode;
    use super::*;

    // TEST-15 / DRIFT-1 #9 + #h: the wire spellings of the three enums the
    // routes expose are exactly the frozen snake_case values (the OpenAPI regen
    // + the engine bind these).
    #[test]
    fn wire_spellings_are_the_frozen_snake_case_values() {
        assert_eq!(serde_json::to_value(MethodEnvState::NotDownloaded).unwrap(), json!("not_downloaded"));
        assert_eq!(serde_json::to_value(MethodEnvState::Downloading).unwrap(), json!("downloading"));
        assert_eq!(serde_json::to_value(MethodEnvState::Ready).unwrap(), json!("ready"));
        assert_eq!(serde_json::to_value(MethodEnvState::Failed).unwrap(), json!("failed"));
        assert_eq!(serde_json::to_value(EnvKind::Base).unwrap(), json!("base"));
        assert_eq!(serde_json::to_value(EnvKind::Layer).unwrap(), json!("layer"));
        assert_eq!(serde_json::to_value(EnvKind::Unknown).unwrap(), json!("unknown"));
        assert_eq!(serde_json::to_value(MethodRunMode::FitPredict).unwrap(), json!("fit_predict"));
        assert_eq!(serde_json::to_value(MethodRunMode::FitOnly).unwrap(), json!("fit_only"));
        assert_eq!(serde_json::to_value(MethodRunMode::ReuseModel).unwrap(), json!("reuse_model"));
    }

    // TEST-15 (second half): the four OpenAPI doc ids are exactly the frozen
    // set — pinned as consts (used by the docs functions themselves), the same
    // assertion style as `permissions::tests::permission_constants_are_stable`.
    #[test]
    fn openapi_doc_ids_are_the_frozen_set() {
        assert_eq!(LIST_ENVS_DOC_ID, "Sandbox.listEnvs");
        assert_eq!(ENV_STATUS_DOC_ID, "Sandbox.envStatus");
        assert_eq!(DELETE_ENV_DOC_ID, "Sandbox.deleteEnv");
        assert_eq!(METHOD_RUN_DOC_ID, "Sandbox.methodRun");
    }

    // The query flag defaults to no-prune (an explicit `?prune=true` is the
    // only thing that reclaims disk — DEC-17).
    #[test]
    fn delete_env_query_defaults_to_no_prune() {
        let q: DeleteEnvQuery = serde_json::from_value(json!({})).expect("empty query");
        assert!(!q.prune);
        let q: DeleteEnvQuery = serde_json::from_value(json!({ "prune": true })).expect("prune query");
        assert!(q.prune);
    }

    // The `base`/`layers` split: an Unknown record belongs to neither list
    // (DRIFT-1 #15 — it only answers `status`).
    #[test]
    fn unknown_statuses_belong_to_neither_index() {
        let mk = |env_id: &str, kind| MethodEnvStatus {
            env_id: env_id.to_string(),
            kind,
            state: MethodEnvState::NotDownloaded,
            bytes_downloaded: 0,
            bytes_total: None,
            digest: None,
            mounted: false,
            error: None,
        };
        let list = vec![
            mk("base-r", EnvKind::Base),
            mk("cox-delta", EnvKind::Layer),
            mk("never-seen", EnvKind::Unknown),
        ];
        let (base, layers) = split_envs(list);
        assert_eq!(base.len(), 1);
        assert_eq!(base[0].env_id, "base-r");
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].env_id, "cox-delta");
    }

    // The stack-support decision: Ready + oras → supported, no reason; Ready
    // without oras → still supported (staged/cached envs run; DEC-16 degrade
    // note only), with the oras note; any other availability → unsupported +
    // a named reason.
    #[test]
    fn stack_support_decision_covers_all_thirds() {
        let (supported, reason) = stack_availability(SandboxAvailability::Ready, true);
        assert!(supported);
        assert!(reason.is_none());

        let (supported, reason) = stack_availability(SandboxAvailability::Ready, false);
        assert!(supported, "a cached/staged deployment still stacks without oras");
        let note = reason.expect("missing oras is a noted degradation");
        assert!(note.contains("oras"), "the note names the missing tool: {note}");

        for avail in [
            SandboxAvailability::HostUnsupported,
            SandboxAvailability::RootfsUnavailable,
            SandboxAvailability::WorkspaceInitFailed,
            SandboxAvailability::NotInitialized,
        ] {
            let (supported, reason) = stack_availability(avail, true);
            assert!(!supported, "{avail:?} is not stack-supported");
            let r = reason.expect("an unavailable stack carries its reason");
            assert!(
                r.contains("unavailable"),
                "{avail:?}: the reason names the refusal: {r}"
            );
        }
    }

    // The 404 answer is typed ENV_UNKNOWN with the failing id named.
    #[test]
    fn unknown_env_error_is_typed() {
        let (status, err) = unknown_env("Bad/Id");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(err.error_code(), ENV_UNKNOWN_CODE);
    }
}

