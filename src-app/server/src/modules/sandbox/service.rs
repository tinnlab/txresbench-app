//! The analysis calling seam (DEC-5).
//!
//! `run_analysis` is the in-process service fn the dataset pipeline will call to
//! run an R/Python analysis script in the sandbox; the thin `POST
//! /api/sandbox/execute` route (routes.rs) is a companion so the whole
//! mechanism is exercisable + testable now. NOT an MCP server (companion-driven
//! — txresbench drives TxResBench via control_mcp).
//!
//! `run_method_in_stack` is the txr method-run seam (PROV-SS-1): ONE benchmark
//! method in its OWN stacked base+layer sandbox, per contract.md's
//! fit/predict modes, with live log/milestone forwarding (the engine's
//! per-method log pane + phase ticker — GAP-1/GAP-2 growths). The shipped
//! analysis path is untouched; the two modes share the ONE hardening core.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use super::env_image::EnvImageProvider;
use super::stack::{MethodRunMode, MethodRunRequest, MethodRunResult, ModelMount};
use super::types::ExtraMount;
#[cfg(target_os = "linux")]
use super::backend::{ProgressFrame, ProgressSink};
#[cfg(target_os = "linux")]
use std::sync::Arc;

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
    // serves. The operator overrides (`TXR_SANDBOX_ENV_ID`, the settings row) remain
    // the only way to move this path off the default.
    let env_id = super::env_image::default_env_id().ok_or_else(|| {
        unavailable(
            "no sandbox env image declared: no installed processor manifest declares an \
             `env`, and TXR_SANDBOX_ENV_ID is unset"
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

// ─────────────────────────── stacked method run seam ────────────────────────

/// The progress-frame phase of a live wrapper STDOUT line forwarded through the
/// run's sink (PROV-SS-1's GAP-2 growth: "forwards the wrapper's stdout/stderr
/// lines LIVE through sink as log frames"). The engine's `txr_run_logs` rows
/// carry a per-stream `stream` column, so the frame phase names which stream
/// the line came from; every line frame carries `pct: None` and the line text
/// in `message` (a line is a log line, never a percentage).
pub const LOG_PHASE_STDOUT: &str = "log.stdout";

/// The progress-frame phase of a live wrapper STDERR line (see
/// [`LOG_PHASE_STDOUT`]).
pub const LOG_PHASE_STDERR: &str = "log.stderr";

/// A reuse-model run carried no [`ModelMount`] (DEC-5: ReuseModel needs the
/// verified model at `/model`; nothing else can produce predictions).
pub const MODEL_MOUNT_MISSING_CODE: &str = "MODEL_MOUNT_MISSING";

/// A fit-mode run carried a [`ModelMount`] — a verified SAVED model on a run
/// that is going to fit one. The two intents contradict; the run is refused.
pub const MODEL_MOUNT_UNEXPECTED_CODE: &str = "MODEL_MOUNT_UNEXPECTED";

/// A fit-mode run carried no `model_out_dir`, so the fit's `/model` output
/// would vanish with the call (DEC-6: the trained model must be written into
/// the caller's staging, outside the workspace).
pub const MODEL_OUT_DIR_MISSING_CODE: &str = "MODEL_OUT_DIR_MISSING";

/// A reuse-model run carried a `model_out_dir` — predict writes no model.
pub const MODEL_OUT_DIR_UNEXPECTED_CODE: &str = "MODEL_OUT_DIR_UNEXPECTED";

/// A request dir (bundle / outputs / model-out) sits INSIDE the per-run
/// workspace. The workspace is scratch and dies with the run; outputs staged
/// there are destroyed before ingest can read them (the ITEM-17 rule the
/// `outputs` module exists to enforce).
pub const RUN_STAGING_DIR_INVALID_CODE: &str = "RUN_STAGING_DIR_INVALID";

/// The contract-shaped input bundle the run would bind at `/input` does not
/// exist. The caller writes it BEFORE the call; a missing bundle is a caller
/// error, not a run the sandbox should silently run without inputs.
pub const RUN_BUNDLE_MISSING_CODE: &str = "RUN_BUNDLE_MISSING";

/// The mode/model-call agreement (DEC-5) as a pure check: ReuseModel requires
/// the verified model and refuses a `model_out_dir`; the fit modes require a
/// `model_out_dir` and refuse a model. A caller mixing the two intents is a
/// caller bug, never a silently-ignored field.
fn validate_model_contract(
    mode: MethodRunMode,
    model: &Option<ModelMount>,
    model_out_dir: &Option<std::path::PathBuf>,
) -> Result<(), AppError> {
    match mode {
        MethodRunMode::ReuseModel => {
            if model.is_none() {
                return Err(AppError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    MODEL_MOUNT_MISSING_CODE,
                    "a reuse-model run needs the saved model (the tree digest is verified \
                     before the read-only bind)",
                ));
            }
            if model_out_dir.is_some() {
                return Err(AppError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    MODEL_OUT_DIR_UNEXPECTED_CODE,
                    "a reuse-model run writes no model; drop model_out_dir",
                ));
            }
        }
        MethodRunMode::FitOnly | MethodRunMode::FitPredict => {
            if model.is_some() {
                return Err(AppError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    MODEL_MOUNT_UNEXPECTED_CODE,
                    "a fit run fits its own model; a saved model belongs on a reuse run",
                ));
            }
            if model_out_dir.is_none() {
                return Err(AppError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    MODEL_OUT_DIR_MISSING_CODE,
                    "a fit run needs model_out_dir — the trained /model is written there \
                     and its tree digest returned",
                ));
            }
        }
    }
    Ok(())
}

/// The raw drive outcome of one bwrap child — what the run seam turns into a
/// [`MethodRunResult`] (the extra run facts — digests, model state — are added
/// by [map_run_result], which is pure + unit-tested).
struct StackRunOutcome {
    exit_code: i32,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
    timed_out: bool,
    duration_ms: u64,
}

/// Map a drive outcome + the run facts into the wire result (TEST-14: every
/// field preserved, truncation flags exact — the mirror of
/// [`AnalysisResult::from_run`]).
fn map_run_result(
    o: StackRunOutcome,
    base_env_digest: String,
    layer_env_digest: String,
    model_verified: bool,
    model_out_digest: Option<String>,
) -> MethodRunResult {
    MethodRunResult {
        exit_code: o.exit_code,
        stdout: o.stdout,
        stderr: o.stderr,
        stdout_truncated: o.stdout_truncated,
        stderr_truncated: o.stderr_truncated,
        timed_out: o.timed_out,
        duration_ms: o.duration_ms,
        base_env_digest,
        layer_env_digest,
        model_verified,
        model_out_digest,
    }
}

/// Run ONE benchmark method in its own stacked sandbox (PROV-SS-1).
///
/// Contract: the caller is responsible for having been ADMITTED
/// (`jobs::admission::admit`, job_type `sandbox`, exactly like
/// `POST /api/sandbox/execute`) — this function spawns the bwrap child
/// unconditionally. The caller passes `mounts` for the in-process pipeline
/// seam (additional read-only mounts; the REST route never accepts
/// client-supplied host paths beyond the request's own dirs — ITEM-5). The
/// request's own `bundle_dir` / `outputs_dir` are bound at `/input` (RO)
/// and `/output` (RW) UNLESS the caller already supplied a mount for that
/// path (the caller's mount list wins per path; the request's dirs are still
/// validated + created).
///
/// The run: `ensure` the base + layer artifacts (verify bytes against the
/// pinned digests — INV-1), parse the layer's `layer-manifest.json` (validated
/// entries — PROV-SS-2), assert each entry's parent exists in the base
/// (DEC-14), derive the wrapper command from the layer's `/code`, VERIFY the
/// model tree for a reuse run (INV-4, before any spawn), build the stacked
/// argv (hardening prefix reused — INV-5), spawn, drive stdout/stderr LIVE to
/// the sink as log frames + drain the progress FIFO into milestone/progress
/// frames (GAP-1/GAP-2), and record BOTH digests (INV-6) beside the run's
/// `env-digest` before the child runs.
///
/// Linux-only; other targets return the typed `SANDBOX_UNAVAILABLE` 503.
#[cfg(target_os = "linux")]
pub async fn run_method_in_stack(
    pool: &SqlitePool,
    req: &MethodRunRequest,
    mounts: &[ExtraMount],
    job_id: Uuid,
    sink: Option<Arc<dyn ProgressSink>>,
) -> Result<MethodRunResult, AppError> {
    use super::sandbox::SandboxSetup;
    use super::types::{MountMode, SandboxContext};

    let state = super::config::get_state().ok_or_else(|| {
        unavailable(format!(
            "the method sandbox is not available ({:?})",
            super::config::init_status()
        ))
    })?;
    let limits = super::settings_cache::get(pool).await;

    // ── caller-data boundaries, before any filesystem / spawn work ──────────
    // The OCI refs are boundaries (ENV_REF_HOST_UNALLOWED before a pull is
    // attempted); the base-vs-layer kind agreement is enforced inside
    // `ensure` (ENV_KIND_INVALID) against the same prefixes.
    super::stack::validate_oci_ref(&req.base.oci_ref)?;
    super::stack::validate_oci_ref(&req.layer.oci_ref)?;
    validate_model_contract(req.mode, &req.model, &req.model_out_dir)?;

    // ── the verified model (INV-4), BEFORE any spawn ────────────────────────
    let model_verified = if let Some(m) = &req.model {
        super::stack::verify_model_tree(&m.host_path, &m.tree_sha256)?;
        true
    } else {
        false
    };

    // ── fetch / verify / mount base + layer (INV-1) ─────────────────────────
    // Blocking + bounded (the host-tool calls + the verify sha256): off the
    // executor, exactly like `run_analysis`'s `EnvImageProvider::provide`.
    let budget = limits.staging_budget();
    let (base, layer) = {
        let base_ref = req.base.clone();
        let layer_ref = req.layer.clone();
        tokio::task::spawn_blocking(move || {
            let manager = super::method_env::manager();
            let base = manager.ensure(
                &base_ref,
                super::method_env::EnvKind::Base,
                budget,
            )?;
            let layer = manager.ensure(
                &layer_ref,
                super::method_env::EnvKind::Layer,
                budget,
            )?;
            Ok::<_, AppError>((base, layer))
        })
        .await
        .map_err(|e| unavailable(format!("method env staging task join: {e}")))?
    }?;
    let base_dir = base.mount_dir;
    let layer_dir = layer.mount_dir;

    // ── layer manifest + entry parents + the wrapper command (PROV-SS-2) ────
    let layer_entries = super::stack::layer_entries_from_manifest(&layer_dir)?;
    super::stack::assert_entry_parents_exist(&base_dir, &layer_entries)?;
    let command = super::stack::method_entry_command(&layer_dir)?;

    // Rootfs-dependent caps (strict PID-ns probe against the mounted base).
    let caps = super::probes::probe_rootfs_dependent(&state.host_caps, &base_dir)
        .map_err(unavailable)?;

    // ── workspace (0700) + staging (ITEM-17: outside the workspace) ─────────
    let workspace = state.workspace_root.join(job_id.to_string());
    create_private_dir(&workspace)?;
    let staging = super::outputs::staging_dir(&state.staging_root, job_id);
    create_private_dir(&staging)?;
    for (dir, what) in [
        (&req.outputs_dir, "outputs dir"),
        (&req.bundle_dir, "bundle dir"),
    ] {
        ensure_staging_dir(&workspace, dir, what)?;
    }
    if let Some(mdir) = &req.model_out_dir {
        ensure_staging_dir(&workspace, mdir, "model-out dir")?;
    }
    if !req.bundle_dir.is_dir() {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            RUN_BUNDLE_MISSING_CODE,
            format!(
                "the input bundle at {} does not exist; write the contract-shaped \
                 bundle (params.json, train/, test/) before running",
                req.bundle_dir.display()
            ),
        ));
    }
    create_private_dir(&req.outputs_dir)?;
    if let Some(mdir) = &req.model_out_dir {
        create_private_dir(mdir)?;
    }

    // ── the run's mounts: the request's own dirs, caller mounts first ───────
    let mut run_mounts: Vec<ExtraMount> = Vec::with_capacity(mounts.len() + 2);
    run_mounts.extend(mounts.iter().cloned());
    push_mount_if_absent(&mut run_mounts, ExtraMount {
        host_path: req.bundle_dir.clone(),
        sandbox_path: "/input".into(),
        mode: MountMode::ReadOnly,
    });
    push_mount_if_absent(&mut run_mounts, ExtraMount {
        host_path: req.outputs_dir.clone(),
        sandbox_path: "/output".into(),
        mode: MountMode::ReadWrite,
    });

    // The model bind: ALWAYS read-only at the fixed /model dest; the builder
    // force-read-onlys the mount (its mode/sandbox_path fields are ignored).
    let model_mount = req.model.as_ref().map(|m| ExtraMount {
        host_path: m.host_path.clone(),
        sandbox_path: super::stack::MODEL_SANDBOX_PATH.into(),
        mode: MountMode::ReadOnly,
    });

    // DEC-6 / PROV-SS-1: a FIT mode's trained model is written at /model, so
    // the request's model_out_dir is bound READ-WRITE at the same fixed dest
    // (the reuse path above binds a VERIFIED model read-only there — the two
    // modes are disjoint, enforced by `validate_model_contract`). Same
    // caller-mount-wins rule as /input + /output; the dir was validated +
    // created above (ITEM-17: it lives outside the run workspace).
    if let Some(mount) = fit_model_mount(req.mode, &req.model_out_dir) {
        push_mount_if_absent(&mut run_mounts, mount);
    }

    // ── record BOTH digests before the child runs (INV-6) ───────────────────
    // `env-digest` (base, shipped) + `layer-env-digest` (new sidecar); each
    // `None` clears a stale file a previous attempt of this job may have left.
    super::env_image::write_run_env_digest(&workspace, base.digest.as_deref());
    super::stack::write_run_layer_digest(&workspace, layer.digest.as_deref());

    // ── progress FIFO (milestones + wrapper progress; best-effort) ──────────
    let (fifo_src, fifo) = match sink.clone() {
        Some(s) => match setup_method_progress_fifo(&workspace, s) {
            Ok(f) => (Some(f.path_string()), Some(f)),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "method run: progress FIFO setup failed; continuing without live progress"
                );
                (None, None)
            }
        },
        None => (None, None),
    };

    // ── spawn: one hardening setup, the stacked argv ────────────────────────
    let ctx = SandboxContext {
        job_id,
        workspace: workspace.clone(),
    };
    let setup = SandboxSetup::prepare(&state, &ctx, &limits, &caps)?;
    let argv = super::stack::build_stacked_bwrap_argv(
        &caps,
        &ctx,
        &base_dir,
        &layer_dir,
        &layer_entries,
        &command,
        setup.synthetic.passwd(),
        setup.synthetic.group(),
        setup.synthetic.mask(),
        setup.seccomp_pipe.as_ref().map(|p| p.target_fd()),
        &limits,
        &run_mounts,
        model_mount.as_ref(),
        req.n_cpu,
        fifo_src.as_deref(),
        req.mode.sigbench_mode(),
    )?;
    let child = super::sandbox::spawn_argv_child(&setup, &caps, argv)?;

    // ── drive: live log frames + milestones, capped capture, timeout ────────
    let effective_timeout = clamp_timeout(req.timeout_secs, limits.timeout_secs);
    let outcome = drive_method_child(child, effective_timeout, sink).await?;
    drop(setup);
    drop(fifo);

    // ── the fit's /model digest (DEC-6: return tree_sha256 of what was fit) ─
    let model_out_digest = match &req.model_out_dir {
        Some(d) if d.is_dir() => Some(super::stack::tree_sha256(d)?),
        _ => None,
    };

    // Read the recorded sidecars back — the result says what the platform
    // MOUNTED (never what this call happened to remember), the same honesty
    // rule as the shipped run's digest read-back.
    let base_env_digest =
        super::env_image::read_run_env_digest(&workspace).unwrap_or_default();
    let layer_env_digest =
        super::stack::read_run_layer_digest(&workspace).unwrap_or_default();

    Ok(map_run_result(
        outcome,
        base_env_digest,
        layer_env_digest,
        model_verified,
        model_out_digest,
    ))
}

#[cfg(not(target_os = "linux"))]
pub async fn run_method_in_stack(
    _pool: &SqlitePool,
    _req: &MethodRunRequest,
    _mounts: &[ExtraMount],
    _job_id: Uuid,
    _sink: Option<std::sync::Arc<dyn super::backend::ProgressSink>>,
) -> Result<MethodRunResult, AppError> {
    Err(unavailable("the method sandbox is Linux-only"))
}

/// The fit-mode `/model` mount (DEC-6): the request's `model_out_dir` bound
/// READ-WRITE at the fixed `/model` dest, so the mode (`SIGBENCH_MODE` /
/// `TXRESBENCH_MODE=fit`) writes the
/// trained model into the caller's staging tree. `None` for a reuse run (its
/// verification + read-only bind is the separate [`ModelMount`] path — never
/// both, enforced by [`validate_model_contract`]). Pure + testable.
#[cfg(target_os = "linux")]
fn fit_model_mount(
    mode: MethodRunMode,
    model_out_dir: &Option<std::path::PathBuf>,
) -> Option<ExtraMount> {
    use super::types::MountMode;

    if matches!(mode, MethodRunMode::ReuseModel) {
        return None;
    }
    model_out_dir.as_ref().map(|dir| ExtraMount {
        host_path: dir.clone(),
        sandbox_path: super::stack::MODEL_SANDBOX_PATH.into(),
        mode: MountMode::ReadWrite,
    })
}

/// A request dir must not live inside the per-run workspace (ITEM-17), and
/// must be a server-side staging path (the in-process seam never mounts a
/// client-chosen path — the REST route builds its request from the staging
/// tree). Creation is the caller's staging responsibility — this only refuses
/// the violating shape before any bind.
#[cfg(target_os = "linux")]
fn ensure_staging_dir(
    workspace: &std::path::Path,
    dir: &std::path::Path,
    what: &str,
) -> Result<(), AppError> {
    if dir.starts_with(workspace) {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            RUN_STAGING_DIR_INVALID_CODE,
            format!(
                "the {what} {} is inside the run workspace {}; outputs staged in the \
                 workspace are destroyed with it (ITEM-17) — stage under the run-staging \
                 tree instead",
                dir.display(),
                workspace.display()
            ),
        ));
    }
    Ok(())
}

/// Push `mount` unless a mount for the same sandbox path already exists: the
/// caller's mount list is authoritative for a path it names (the engine hands
/// `/input` + `/output` itself), while the request's own dirs stay the
/// guarantee for the paths it did NOT name.
#[cfg(target_os = "linux")]
fn push_mount_if_absent(mounts: &mut Vec<ExtraMount>, mount: ExtraMount) {
    if mounts.iter().any(|m| m.sandbox_path == mount.sandbox_path) {
        return;
    }
    mounts.push(mount);
}

/// The one-line progress frame of a live wrapper output line (the `log` frame
/// carrier of GAP-2: [`ProgressFrame`] is the sink trait's only data shape,
/// so a log line rides it with a log phase, `pct: None`, the line text as the
/// message). Pure + testable.
#[cfg(target_os = "linux")]
fn log_frame(phase: &str, line: &str) -> ProgressFrame {
    ProgressFrame {
        phase: phase.to_string(),
        pct: None,
        message: Some(line.to_string()),
    }
}

/// Forward one raw output line to the sink (trimmed of its line terminators,
/// never of leading whitespace — log panes keep indentation). Empty lines are
/// dropped from the live stream but still captured in the returned buffer.
#[cfg(target_os = "linux")]
fn forward_log_line(
    line: &[u8],
    sink: Option<&dyn ProgressSink>,
    phase: &'static str,
) {
    let Some(sink) = sink else { return };
    let text = String::from_utf8_lossy(line);
    let text = text.trim_end_matches(['\n', '\r']);
    if text.is_empty() {
        return;
    }
    sink.progress(log_frame(phase, text));
}

/// Drive the child to completion: capture stdout/stderr capped (the shipped
/// [`super::sandbox::OUTPUT_CAP_BYTES`]; the child is NOT killed at the cap),
/// forward each complete line LIVE to the sink as a [`LOG_PHASE_STDOUT`] /
/// [`LOG_PHASE_STDERR`] frame, and wait under the effective wall-clock
/// timeout. The caller keeps the capture in `MethodRunResult.stdout/stderr`
/// (the terminal snapshot) while the sink handles the live pane.
#[cfg(target_os = "linux")]
async fn drive_method_child(
    mut child: tokio::process::Child,
    timeout_secs: u64,
    sink: Option<Arc<dyn ProgressSink>>,
) -> Result<StackRunOutcome, AppError> {
    use std::time::{Duration, Instant};

    let started = Instant::now();
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let stdout_handle =
        tokio::spawn(stream_lines_capped(stdout, sink.clone(), LOG_PHASE_STDOUT));
    let stderr_handle =
        tokio::spawn(stream_lines_capped(stderr, sink, LOG_PHASE_STDERR));

    let budget = Duration::from_secs(timeout_secs.max(1));
    let wait = tokio::time::timeout(budget, child.wait()).await;
    let (timed_out, status) = match wait {
        Ok(Ok(s)) => (false, s.code().unwrap_or(-1)),
        Ok(Err(e)) => {
            return Err(AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "BWRAP_WAIT_FAILED",
                format!("wait on bwrap child failed: {e}"),
            ));
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            (true, -1)
        }
    };

    let (stdout_buf, stdout_truncated) =
        stdout_handle.await.unwrap_or_else(|_| (Vec::new(), false));
    let (stderr_buf, stderr_truncated) =
        stderr_handle.await.unwrap_or_else(|_| (Vec::new(), false));
    let duration_ms = started.elapsed().as_millis() as u64;

    Ok(StackRunOutcome {
        exit_code: status,
        stdout: super::sandbox::lossy_string_with_marker(stdout_buf, stdout_truncated),
        stderr: super::sandbox::lossy_string_with_marker(stderr_buf, stderr_truncated),
        stdout_truncated,
        stderr_truncated,
        timed_out,
        duration_ms,
    })
}

/// Read one capped stream, forwarding complete lines live to the sink. The
/// capture holds the first [`super::sandbox::OUTPUT_CAP_BYTES`] bytes (a
/// marker is appended by the caller's lossy mapping) while the rest is drained
/// to completion — same cap semantics as the shipped path, with line
/// forwarding added (GAP-2).
#[cfg(target_os = "linux")]
async fn stream_lines_capped<R>(
    mut reader: R,
    sink: Option<Arc<dyn ProgressSink>>,
    phase: &'static str,
) -> (Vec<u8>, bool)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::AsyncReadExt;

    let mut buf = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];
    let mut partial: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                partial.extend_from_slice(&chunk[..n]);
                while let Some(at) = partial.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = partial.drain(..=at).collect();
                    forward_log_line(&line, sink.as_deref(), phase);
                    append_capped(&mut buf, &line, &mut truncated);
                }
                // A no-newline flood is bounded (drained + forwarded) so the
                // partial buffer cannot grow without limit.
                if partial.len() > 64 * 1024 {
                    forward_log_line(&partial, sink.as_deref(), phase);
                    append_capped(&mut buf, &partial, &mut truncated);
                    partial.clear();
                }
            }
            Err(_) => break,
        }
    }
    if !partial.is_empty() {
        forward_log_line(&partial, sink.as_deref(), phase);
        append_capped(&mut buf, &partial, &mut truncated);
    }
    (buf, truncated)
}

/// Append up to the capture cap; mark truncation when more bytes existed
/// (the capture is capped, the drain is not — the child can finish).
#[cfg(target_os = "linux")]
fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], truncated: &mut bool) {
    let remain = super::sandbox::OUTPUT_CAP_BYTES.saturating_sub(buf.len());
    if chunk.len() > remain {
        *truncated = true;
    }
    let take = chunk.len().min(remain);
    buf.extend_from_slice(&chunk[..take]);
}

/// The live-progress FIFO of a stacked run + its drain thread. Drop requests
/// the drain to stop and JOINS it (bounded: the drain's poll/sleep cadence is
/// 100 ms), so the wrapper's finale milestone/log lines are delivered to the
/// sink BEFORE the synchronous service call returns — the PROV-SS-1 sink
/// contract (TEST-22, the renumbered reconcile-growth sink test). Then the node is unlinked (the same guard shape
/// the streaming path's `StreamGuards` provides; this seam owns its own
/// because `streaming.rs` is deliberately untouched by this node).
#[cfg(target_os = "linux")]
struct MethodProgressFifo {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    path: std::path::PathBuf,
    /// The drain thread's join handle; `None` only if the thread never
    /// started (impossible today — the drain is spawned right after mkfifo).
    drain: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "linux")]
impl MethodProgressFifo {
    fn path_string(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

#[cfg(target_os = "linux")]
impl Drop for MethodProgressFifo {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(handle) = self.drain.take() {
            let _ = handle.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(target_os = "linux")]
fn setup_method_progress_fifo(
    workspace: &std::path::Path,
    sink: Arc<dyn ProgressSink>,
) -> Result<MethodProgressFifo, AppError> {
    use std::os::unix::ffi::OsStrExt;

    let path = workspace.join(".progress.fifo");
    let _ = std::fs::remove_file(&path);
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|e| AppError::internal_error(format!("fifo path: {e}")))?;
    let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if rc != 0 {
        return Err(AppError::internal_error(format!(
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_reader = stop.clone();
    let reader_path = path.clone();
    // Blocking reader thread: the same open/poll/drain shape as
    // `streaming::drain_fifo` (that file is pinned untouched); the parse is the
    // SHARED `streaming::parse_milestone_line` / `parse_progress_line`.
    let drain = std::thread::spawn(move || drain_method_fifo(&reader_path, stop_reader, sink));

    Ok(MethodProgressFifo { stop, path, drain: Some(drain) })
}

/// Poll the FIFO for `milestone|…` and `phase|pct|message` lines, forwarding
/// each to the sink (milestones → `sink.milestone`, fine progress →
/// `sink.progress`). Mirrors `streaming::drain_fifo`; reused codecs.
#[cfg(target_os = "linux")]
fn drain_method_fifo(path: &std::path::Path, stop: std::sync::Arc<std::sync::atomic::AtomicBool>, sink: Arc<dyn ProgressSink>) {
    use std::io::Read;
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let c_path = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
        Ok(p) => p,
        Err(_) => return,
    };
    let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK) };
    if fd < 0 {
        return;
    }
    // SAFETY: `fd` is a freshly-opened, owned fd; File takes ownership + closes it.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut buf = [0u8; 4096];
    let mut partial: Vec<u8> = Vec::new();

    loop {
        // READ FIRST, stop-check after an EMPTY read — the order is the
        // contract: a wrapper writes its finale milestone/log lines just
        // before exiting, so a stop flag set on the guard drop must not win
        // over bytes that are already buffered in the FIFO (the lose-the-last-
        // frames race the shipped streaming path cannot have because its
        // guards outlive the run; this seam's guard drops the moment the child
        // does). `Ok(0)` / `WouldBlock` mean NOTHING left to read — only then
        // is the stop flag consulted, so the join in the guard's Drop is
        // bounded by the 100 ms poll cadence and never loses a frame.
        match file.read(&mut buf) {
            Ok(0) => {
                if stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Ok(n) => {
                partial.extend_from_slice(&buf[..n]);
                while let Some(nl) = partial.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = partial.drain(..=nl).collect();
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim_end();
                    if let Some(frame) = super::streaming::parse_milestone_line(trimmed) {
                        sink.milestone(frame);
                    } else if let Some(frame) = super::streaming::parse_progress_line(trimmed) {
                        sink.progress(frame);
                    }
                }
                if partial.len() > 64 * 1024 {
                    partial.clear();
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }
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

    // TEST-14: MethodRunResult mapping preserves fields + truncation flags
    // (the mirror of from_run_preserves_fields), and the non-Linux arm's error
    // is the typed 503 SANDBOX_UNAVAILABLE (the arm itself is compiled out on
    // Linux — the shared `unavailable` it delegates to is what is pinned).
    #[test]
    fn map_run_result_preserves_fields() {
        let o = StackRunOutcome {
            exit_code: 3,
            stdout: "out".into(),
            stderr: "err".into(),
            stdout_truncated: true,
            stderr_truncated: false,
            timed_out: true,
            duration_ms: 1234,
        };
        let r = map_run_result(
            o,
            "base-digest".into(),
            "layer-digest".into(),
            true,
            Some("model-digest".into()),
        );
        assert_eq!(r.exit_code, 3);
        assert_eq!(r.stdout, "out");
        assert_eq!(r.stderr, "err");
        assert!(r.stdout_truncated);
        assert!(!r.stderr_truncated);
        assert!(r.timed_out);
        assert_eq!(r.duration_ms, 1234);
        assert_eq!(r.base_env_digest, "base-digest");
        assert_eq!(r.layer_env_digest, "layer-digest");
        assert!(r.model_verified);
        assert_eq!(r.model_out_digest.as_deref(), Some("model-digest"));

        let r2 = map_run_result(
            StackRunOutcome {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: false,
                duration_ms: 0,
            },
            String::new(),
            String::new(),
            false,
            None,
        );
        assert!(!r2.model_verified);
        assert_eq!(r2.model_out_digest, None);

        let err = unavailable("the method sandbox is Linux-only");
        assert_eq!(err.status_code(), 503);
        assert_eq!(err.error_code(), "SANDBOX_UNAVAILABLE");
    }

    // DEC-5 mode/model agreement: a mixed intent is refused with the matching
    // typed code — never a silently ignored field.
    #[test]
    fn model_contract_refuses_mixed_intents() {
        use std::path::PathBuf;
        let model = ModelMount {
            host_path: PathBuf::from("/m"),
            tree_sha256: String::new(),
        };
        let dir = Some(PathBuf::from("/out/model"));

        validate_model_contract(MethodRunMode::FitOnly, &None, &dir).expect("fit + out ok");
        validate_model_contract(MethodRunMode::FitPredict, &None, &dir).expect("fit+predict ok");
        validate_model_contract(MethodRunMode::ReuseModel, &Some(model.clone()), &None)
            .expect("reuse + model ok");

        let e = validate_model_contract(MethodRunMode::ReuseModel, &None, &None).unwrap_err();
        assert_eq!(e.error_code(), MODEL_MOUNT_MISSING_CODE);
        let e = validate_model_contract(MethodRunMode::ReuseModel, &Some(model.clone()), &dir)
            .unwrap_err();
        assert_eq!(e.error_code(), MODEL_OUT_DIR_UNEXPECTED_CODE);
        let e = validate_model_contract(MethodRunMode::FitOnly, &Some(model.clone()), &None)
            .unwrap_err();
        assert_eq!(e.error_code(), MODEL_MOUNT_UNEXPECTED_CODE);
        let e = validate_model_contract(MethodRunMode::FitPredict, &None, &None).unwrap_err();
        assert_eq!(e.error_code(), MODEL_OUT_DIR_MISSING_CODE);
    }

    // GAP-2's live log-frame shape: a log phase, pct None, the line text as the
    // message — the carrier the engine maps onto `txr_run_logs`.
    #[cfg(target_os = "linux")]
    #[test]
    fn log_frame_shapes_and_mount_dedup() {
        let f = log_frame(LOG_PHASE_STDOUT, "dynforest tree 140 of 500");
        assert_eq!(f.phase, "log.stdout");
        assert_eq!(f.pct, None);
        assert_eq!(f.message.as_deref(), Some("dynforest tree 140 of 500"));
        let f2 = log_frame(LOG_PHASE_STDERR, "warn");
        assert_eq!(f2.phase, "log.stderr");

        let mut mounts = Vec::new();
        push_mount_if_absent(
            &mut mounts,
            ExtraMount {
                host_path: std::path::PathBuf::from("/caller/input"),
                sandbox_path: "/input".into(),
                mode: crate::modules::sandbox::types::MountMode::ReadOnly,
            },
        );
        push_mount_if_absent(
            &mut mounts,
            ExtraMount {
                host_path: std::path::PathBuf::from("/req/input"),
                sandbox_path: "/input".into(),
                mode: crate::modules::sandbox::types::MountMode::ReadOnly,
            },
        );
        assert_eq!(mounts.len(), 1, "the caller's /input mount wins — no duplicate");
        assert_eq!(mounts[0].host_path, std::path::PathBuf::from("/caller/input"));
    }

    // (TEST-08's /model half, DEC-6): a fit run binds its model_out_dir
    // READ-WRITE at the fixed /model dest; a reuse run never does (its
    // verified model binds READ-ONLY through the separate ModelMount path).
    #[cfg(target_os = "linux")]
    #[test]
    fn fit_modes_bind_model_out_at_model_rw_only() {
        use crate::modules::sandbox::types::MountMode;

        let dir = Some(std::path::PathBuf::from("/staging/model"));
        for mode in [MethodRunMode::FitPredict, MethodRunMode::FitOnly] {
            let m = fit_model_mount(mode, &dir)
                .unwrap_or_else(|| panic!("{mode:?} binds its model_out_dir"));
            assert_eq!(
                m.sandbox_path,
                crate::modules::sandbox::stack::MODEL_SANDBOX_PATH,
                "the fit's /model is the fixed dest"
            );
            assert_eq!(
                m.mode,
                MountMode::ReadWrite,
                "a fit WRITES the trained model; DEC-6"
            );
            assert_eq!(m.host_path, std::path::PathBuf::from("/staging/model"));
        }
        assert!(
            fit_model_mount(MethodRunMode::ReuseModel, &dir).is_none(),
            "a reuse run's model is the verified READ-ONLY ModelMount, never this"
        );
        assert!(
            fit_model_mount(MethodRunMode::FitPredict, &None).is_none(),
            "no model_out_dir ⇒ nothing to bind (validate_model_contract refuses it)"
        );
    }
}
