//! The analysis calling seam (DEC-5).
//!
//! `run_analysis` is the in-process service fn the dataset pipeline will call to
//! run an R/Python analysis script in the sandbox; the thin `POST
//! /api/sandbox/execute` route (routes.rs) is a companion so the whole
//! mechanism is exercisable + testable now. NOT an MCP server (companion-driven
//! — ziee drives CytoAnalyst via control_mcp).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::env_image::EnvImageProvider;
use super::types::ExtraMount;

/// Request to run an analysis command in the sandbox.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AnalysisRequest {
    /// The shell command run via `/bin/bash -lc` inside the sandbox (e.g. an
    /// `Rscript`/`python3` invocation).
    pub command: String,
    /// Optional wall-clock timeout override (seconds). Defaults to the
    /// configured `timeout_secs`.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// Result of a sandboxed analysis run (the REST response + pipeline return).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AnalysisResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

impl AnalysisResult {
    /// Map a raw `SandboxRunResult` into the API/service result. Pure +
    /// testable (TEST-15).
    pub fn from_run(r: super::sandbox::SandboxRunResult) -> Self {
        Self {
            exit_code: r.exit_code,
            stdout: r.stdout,
            stderr: r.stderr,
            stdout_truncated: r.stdout_truncated,
            stderr_truncated: r.stderr_truncated,
            timed_out: r.timed_out,
            duration_ms: r.duration_ms,
        }
    }
}

/// Resolve the effective wall-clock timeout: a client value is clamped to the
/// admin cap (`cap_secs`); an absent client value uses the cap. A caller can
/// only make a run SHORTER, never exceed the configured ceiling. [blind-audit HIGH-1]
pub fn clamp_timeout(client: Option<u64>, cap_secs: i64) -> u64 {
    let cap = cap_secs.max(1) as u64;
    client.unwrap_or(cap).min(cap)
}

fn unavailable(detail: impl Into<String>) -> AppError {
    AppError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "SANDBOX_UNAVAILABLE",
        detail.into(),
    )
}

/// Run an analysis command in the sandbox. `extra_mounts` lets the pipeline
/// plumb input matrices / output dirs (the REST route passes none — it never
/// takes client-supplied host paths). Linux-only; other targets return 503.
///
/// `job_id` names the run: it is the per-run workspace dir AND the id of the `jobs`
/// row the caller minted to claim its concurrency slot. Passed in rather than
/// generated here so those two are the SAME identity — a run whose workspace has a
/// different name than its row is a run an operator cannot connect to the slot it is
/// holding. **The caller is responsible for having been ADMITTED** (see
/// `jobs::admission::admit`); this function spawns a bwrap child unconditionally.
#[cfg(target_os = "linux")]
pub async fn run_analysis(
    pool: &SqlitePool,
    req: &AnalysisRequest,
    extra_mounts: &[ExtraMount],
    job_id: Uuid,
) -> Result<AnalysisResult, AppError> {
    let state = super::config::get_state().ok_or_else(|| {
        unavailable(format!(
            "the analysis sandbox is not available ({:?})",
            super::config::init_status()
        ))
    })?;

    let limits = super::settings_cache::get(pool).await;

    // Resolve the env's rootfs through the EnvImageProvider seam. `OciEnvImageProvider`
    // lazy-fetches the NEWEST published image for the env (fetch-newest, DEC-I),
    // cosign-verifies it, and mounts it — nothing is embedded. Injecting behind the
    // trait keeps this call site put if an alternate provider ever replaces it.
    //
    // OFF THE EXECUTOR + BOUNDED (job-hang fix): `provide` shells to `oras`/`cosign`
    // synchronously; inline it blocked this tokio worker inside one `poll`, so no
    // outer timeout could fire. See the same treatment in `backend/local_bwrap.rs`.
    let budget = limits.staging_budget();
    // The env-id is DATA (a contributed manifest declares it) — see
    // `env_image::default_env_id`. No env declared ⇒ nothing to stage.
    //
    // #189 — THIS PATH DELIBERATELY KEEPS THE DEPLOYMENT DEFAULT, and takes no per-job
    // env. It is the ad-hoc `POST /api/sandbox/execute` seam: a raw COMMAND supplied by
    // the caller, with no analysis/converter contribution behind it. There is therefore
    // nothing to derive a declared env FROM, and accepting one from the request body is
    // the precise hole DEC-4 closes elsewhere — the env registry is open by design (any
    // well-formed id resolves to its own repo, asserted by `env_image_test.rs`), so a
    // caller-supplied env-id here would let a request select any image the registry
    // serves. The operator overrides (`CYTO_SANDBOX_ENV_ID`, the settings row) remain
    // the only way to move this path off the default.
    let env_id = super::env_image::default_env_id().ok_or_else(|| {
        unavailable(
            "no sandbox env image declared: no installed processor manifest declares an \
             `env`, and CYTO_SANDBOX_ENV_ID is unset"
                .to_string(),
        )
    })?;
    let rootfs_dir = tokio::task::spawn_blocking(move || {
        super::env_image::OciEnvImageProvider::new().provide(&env_id, budget)
    })
    .await
    .map_err(|e| unavailable(format!("env image staging task join: {e}")))??
    .rootfs_dir;

    // Promote host caps to full caps against the mounted rootfs (PID-ns probe).
    let caps = super::probes::probe_rootfs_dependent(&state.host_caps, &rootfs_dir)
        .map_err(unavailable)?;

    // Per-job workspace dir (0700), named by the caller's admitted run id.
    let workspace = state.workspace_root.join(job_id.to_string());
    create_private_dir(&workspace)?;

    // Clamp any client-supplied timeout to the admin cap (a caller may request
    // a SHORTER wall-clock, never a longer one). [blind-audit HIGH-1]
    let effective_timeout = Some(clamp_timeout(req.timeout_secs, limits.timeout_secs));

    let ctx = super::types::SandboxContext {
        job_id,
        workspace: workspace.clone(),
    };

    let result = super::sandbox::run_in_sandbox(
        &state,
        &ctx,
        &rootfs_dir,
        &req.command,
        effective_timeout,
        &limits,
        extra_mounts,
        &caps,
    )
    .await;

    // Best-effort cleanup of the per-job workspace.
    let _ = std::fs::remove_dir_all(&workspace);

    result.map(AnalysisResult::from_run)
}

#[cfg(not(target_os = "linux"))]
pub async fn run_analysis(
    _pool: &SqlitePool,
    _req: &AnalysisRequest,
    _extra_mounts: &[ExtraMount],
    _job_id: Uuid,
) -> Result<AnalysisResult, AppError> {
    Err(unavailable("the analysis sandbox is Linux-only"))
}

/// Create a directory with 0700 perms (owner-only). On non-Unix, best-effort.
#[cfg(target_os = "linux")]
fn create_private_dir(path: &std::path::Path) -> Result<(), AppError> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|e| {
            AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "WORKSPACE_INIT_FAILED",
                format!("create workspace {}: {e}", path.display()),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::sandbox::SandboxRunResult;

    // [blind-audit HIGH-1] the timeout clamp: a client can shorten but never
    // exceed the admin cap; an absent value uses the cap; a degenerate cap floors at 1.
    #[test]
    fn clamp_timeout_caps_client_value() {
        assert_eq!(clamp_timeout(None, 600), 600, "absent → cap");
        assert_eq!(clamp_timeout(Some(60), 600), 60, "shorter client value honored");
        assert_eq!(clamp_timeout(Some(u64::MAX), 600), 600, "huge client value clamped to cap");
        assert_eq!(clamp_timeout(Some(0), 600), 0, "a client can request ~immediate");
        assert_eq!(clamp_timeout(None, 0), 1, "degenerate cap floors at 1");
    }

    // TEST-15: AnalysisResult mapping preserves fields + truncation flags.
    #[test]
    fn from_run_preserves_fields() {
        let run = SandboxRunResult {
            exit_code: 3,
            stdout: "out".into(),
            stderr: "err".into(),
            stdout_truncated: true,
            stderr_truncated: false,
            duration_ms: 1234,
            timed_out: true,
        };
        let r = AnalysisResult::from_run(run);
        assert_eq!(r.exit_code, 3);
        assert_eq!(r.stdout, "out");
        assert_eq!(r.stderr, "err");
        assert!(r.stdout_truncated);
        assert!(!r.stderr_truncated);
        assert!(r.timed_out);
        assert_eq!(r.duration_ms, 1234);
    }
}
