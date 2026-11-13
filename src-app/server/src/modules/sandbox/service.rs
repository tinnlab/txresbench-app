//! The stacked method-run calling seam (DEC-5).
//!
//! `run_method_in_stack` is the txr method-run seam (PROV-SS-1): ONE benchmark
//! method in its OWN stacked base+layer sandbox, per contract.md's
//! fit/predict modes, with live log/milestone forwarding (the engine's
//! per-method log pane + phase ticker — GAP-1/GAP-2 growths).
//!
//! strip-single-cell ITEM-3: the platform's ANALYSIS-ROOTFS calling seam —
//! `run_analysis`, `AnalysisRequest`/`AnalysisResult` and the
//! `POST /api/sandbox/execute` companion — was removed with the processor
//! pipeline. `clamp_timeout` stays: the stacked seam shares its clamp shape.

use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use super::stack::{MethodRunMode, MethodRunRequest, MethodRunResult, ModelMount};
use super::types::ExtraMount;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::backend::{ProgressFrame, ProgressSink};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::sync::Arc;

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
/// — the mirror of the removed analysis-run mapping).
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
    // executor — the provider would have blocked one `poll` the same way.
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

/// Run ONE benchmark method in its own stacked sandbox — macOS (PROV-SS-1).
///
/// The same contract as the Linux seam above, and the same order of checks
/// up to the images (caller boundaries, the saved model, the images). The
/// layer checks come later than on Linux: the layer can only be read inside
/// the VM, and the VM's shares are fixed at boot, so they run once the run's
/// dirs and inputs are staged and the VM is up. What differs is where the
/// images are mounted: macOS can neither mount
/// squashfs nor run bwrap, so the base + layer images boot a per-run Linux VM
/// as read-only disks ([`super::mac_vm_run`]), the layer checks (manifest,
/// entry parents, wrapper command) run inside it with the same `stack` rules,
/// and the SAME stacked bwrap argv — built with guest paths — runs there.
///
/// Everything the VM reads is a private per-run copy, verified where it has a
/// pin: the two images are cloned (copy-on-write on APFS) and digest-verified
/// (INV-1), and the read-only inputs are readable copies, a saved model's copy
/// being the one digest-verified (INV-4) — nothing in the cache can change or
/// vanish under a booting VM. Everything the workload writes — `/output`, a
/// fit's `/model`, its home dir — is streamed back into host dirs before the
/// model digest is taken. One macOS difference: those outputs live in guest
/// RAM until the command exits, so they count against the run's memory limit.
#[cfg(target_os = "macos")]
pub async fn run_method_in_stack(
    pool: &SqlitePool,
    req: &MethodRunRequest,
    mounts: &[ExtraMount],
    job_id: Uuid,
    sink: Option<Arc<dyn ProgressSink>>,
) -> Result<MethodRunResult, AppError> {
    use super::mac_vm_run::{self as vm, MethodVm, VmSpec};
    use super::method_env::{EnvKind, ProvidedMount};
    use super::types::{CgroupMode, HardeningCapabilities, MountMode, PidNsMode, SandboxContext, SeccompMode};
    use std::path::{Path, PathBuf};

    /// Room in guest RAM for everything the workload writes (outputs + home)
    /// until it is streamed back; added to the VM's RAM.
    const OUTPUT_BUDGET_MIB: u32 = 2048;

    let state = super::config::get_state().ok_or_else(|| {
        unavailable(format!(
            "the method sandbox is not available ({:?})",
            super::config::init_status()
        ))
    })?;
    let limits = super::settings_cache::get(pool).await;

    // ── caller-data boundaries, before any filesystem / VM work ─────────────
    super::stack::validate_oci_ref(&req.base.oci_ref)?;
    super::stack::validate_oci_ref(&req.layer.oci_ref)?;
    validate_model_contract(req.mode, &req.model, &req.model_out_dir)?;

    // ── the verified model (INV-4), BEFORE any environment work ────────────
    // As on Linux, a wrong or tampered pin is refused before an image is
    // touched. What is verified is the model's STAGED copy — the readable
    // per-run copy the VM reads (see the input staging below) — so the files
    // checked are the files bound, hashed once. As on Linux, the pin covers
    // the model's regular files; symlinks in it are not part of the pin.
    let (input_stage, staged_model) = {
        let model = req.model.as_ref().map(|m| (m.host_path.clone(), m.tree_sha256.clone()));
        tokio::task::spawn_blocking(move || {
            let mut stage = vm::RoStage::new()?;
            let staged = match &model {
                Some((host, pin)) => {
                    if !host.is_dir() {
                        return Err(unavailable(format!(
                            "the saved model {} is not a directory; on macOS run inputs reach \
                             the method VM as shared directories",
                            host.display()
                        )));
                    }
                    let copy = stage.stage(host)?;
                    super::stack::verify_model_tree(&copy, pin)?;
                    Some(copy)
                }
                None => None,
            };
            Ok::<_, AppError>((stage, staged))
        })
        .await
        .map_err(|e| unavailable(format!("model staging task join: {e}")))??
    };
    let model_verified = staged_model.is_some();

    // ── fetch / verify base + layer (INV-1), then private verified copies ───
    // On macOS `mount_dir` is the cached squashfs IMAGE (nothing is mounted on
    // the host — `method_env::ready_artifact_path`). The VM must not boot the
    // cache file itself: a prune or a replacement between a check and the boot
    // would go unnoticed. Each image is cloned into the run's private dir and
    // the CLONE is verified; that is what the VM attaches.
    let budget = limits.staging_budget();
    let (base, layer, image_stage, base_image, layer_image) = {
        let base_ref = req.base.clone();
        let layer_ref = req.layer.clone();
        tokio::task::spawn_blocking(move || {
            let manager = super::method_env::manager();
            let base = manager.ensure(&base_ref, EnvKind::Base, budget)?;
            let layer = manager.ensure(&layer_ref, EnvKind::Layer, budget)?;
            let mut stage = vm::RoStage::for_images()?;
            let mut private_copy =
                |artifact: &ProvidedMount, what: &str| -> Result<PathBuf, AppError> {
                    if !artifact.mount_dir.is_file() {
                        return Err(unavailable(format!(
                            "the {what} environment at {} is not an image file; on macOS a \
                             method environment must be a squashfs image the method VM can \
                             attach (a pre-mounted environment dir cannot be used)",
                            artifact.mount_dir.display()
                        )));
                    }
                    stage.stage_file(&artifact.mount_dir)
                };
            // The cache file's identity before and after cloning: if it did not
            // change and this process already verified it, the clone holds
            // the verified bytes and needs no second full hash.
            let base_before = vm::image_identity(&base.mount_dir);
            let layer_before = vm::image_identity(&layer.mount_dir);
            let base_image = private_copy(&base, "base")?;
            let layer_image = private_copy(&layer, "layer")?;
            let unchanged = |before: Option<vm::ImageIdentity>, src: &Path| {
                before.filter(|id| vm::image_identity(src).as_ref() == Some(id))
            };
            let base_id = unchanged(base_before, &base.mount_dir);
            let layer_id = unchanged(layer_before, &layer.mount_dir);
            let needs_hash = |id: Option<vm::ImageIdentity>, digest: &str| {
                !id.is_some_and(|id| vm::verified_before(digest, id))
            };
            let hash_base = needs_hash(base_id, &base_ref.digest);
            let hash_layer = needs_hash(layer_id, &layer_ref.digest);
            // Verify the clones that need it, both at once (each is a full
            // read of the image).
            let (b, l) = std::thread::scope(|scope| {
                let b = scope.spawn(|| {
                    if hash_base {
                        super::method_env::verify_image_file(&base_image, &base_ref.digest)
                    } else {
                        Ok(())
                    }
                });
                let l = scope.spawn(|| {
                    if hash_layer {
                        super::method_env::verify_image_file(&layer_image, &layer_ref.digest)
                    } else {
                        Ok(())
                    }
                });
                (b.join(), l.join())
            });
            for verdict in [b, l] {
                verdict.map_err(|_| unavailable("image verification stopped unexpectedly"))??;
            }
            for (id, digest) in [(base_id, &base_ref.digest), (layer_id, &layer_ref.digest)] {
                if let Some(id) = id {
                    vm::record_verified(digest, id);
                }
            }
            Ok::<_, AppError>((base, layer, stage, base_image, layer_image))
        })
        .await
        .map_err(|e| unavailable(format!("method env staging task join: {e}")))?
    }?;

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
    if let Some(mount) = fit_model_mount(req.mode, &req.model_out_dir) {
        push_mount_if_absent(&mut run_mounts, mount);
    }

    // ── record BOTH digests before the method runs (INV-6) ──────────────────
    super::env_image::write_run_env_digest(&workspace, base.digest.as_deref());
    super::stack::write_run_layer_digest(&workspace, layer.digest.as_deref());

    // ── read-only inputs → readable per-run copies (off the executor) ───────
    // virtio-fs shows the guest the host's owner + modes, and the sandboxed
    // uid is not the host user, so a private host dir is unreadable inside;
    // the copies are readable, the host's modes are never loosened. Share i
    // is `/host-mounts/<i>` in the guest.
    let identity = super::sandbox::SyntheticIdentity::ensure(&state.workspace_root)?;
    let identity_dir = identity
        .passwd()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| unavailable("the synthetic identity files have no parent dir"))?;
    let mut ro_hosts: Vec<(PathBuf, String)> = run_mounts
        .iter()
        .filter(|m| matches!(m.mode, MountMode::ReadOnly))
        .map(|m| (m.host_path.clone(), m.sandbox_path.clone()))
        .collect();
    let model_share = req.model.as_ref().map(|m| {
        ro_hosts.push((m.host_path.clone(), super::stack::MODEL_SANDBOX_PATH.to_string()));
        ro_hosts.len() - 1
    });
    ro_hosts.push((identity_dir, "the synthetic identity".to_string()));
    let identity_share = ro_hosts.len() - 1;
    let (input_stage, ro_shares) = tokio::task::spawn_blocking(move || {
        let mut stage = input_stage;
        let mut staged = Vec::with_capacity(ro_hosts.len());
        for (i, (host, sandbox_path)) in ro_hosts.iter().enumerate() {
            // The saved model was staged and verified first (INV-4, above).
            if Some(i) == model_share {
                if let Some(copy) = &staged_model {
                    staged.push(copy.clone());
                    continue;
                }
            }
            // virtio-fs shares directories only.
            if !host.is_dir() {
                return Err(unavailable(format!(
                    "the read-only mount {} for {sandbox_path} is not a directory; on macOS \
                     run inputs reach the method VM as shared directories",
                    host.display()
                )));
            }
            staged.push(stage.stage(host)?);
        }
        Ok::<_, AppError>((stage, staged))
    })
    .await
    .map_err(|e| unavailable(format!("input staging task join: {e}")))??;
    let share_guest = |i: usize| PathBuf::from(format!("{}/{i}", vm::GUEST_EXTRA_MOUNTS_DIR));

    // ── host mounts → guest paths ───────────────────────────────────────────
    // RO mounts take their staged shares in order; everything the workload
    // writes is a guest-local dir the agent streams back (libkrun's virtio-fs
    // refuses file creation from the sandboxed uid).
    let mut collect_artifacts: Vec<String> = Vec::new();
    let mut artifact_dirs: Vec<vm::OutputDir> = Vec::new();
    let mut guest_mounts: Vec<ExtraMount> = Vec::with_capacity(run_mounts.len());
    let mut ro_index = 0usize;
    for m in &run_mounts {
        let host_path = match m.mode {
            MountMode::ReadOnly => {
                ro_index += 1;
                share_guest(ro_index - 1)
            }
            MountMode::ReadWrite => {
                let guest = format!("{}/{}", vm::GUEST_ARTIFACTS_OUT_DIR, collect_artifacts.len());
                collect_artifacts.push(guest.clone());
                artifact_dirs.push(vm::OutputDir {
                    host: m.host_path.clone(),
                    sandbox_path: m.sandbox_path.clone(),
                });
                PathBuf::from(guest)
            }
        };
        guest_mounts.push(ExtraMount {
            host_path,
            sandbox_path: m.sandbox_path.clone(),
            mode: m.mode.clone(),
        });
    }
    let guest_model_mount = model_share.map(|i| ExtraMount {
        host_path: share_guest(i),
        sandbox_path: super::stack::MODEL_SANDBOX_PATH.into(),
        mode: MountMode::ReadOnly,
    });
    let guest_identity = share_guest(identity_share);
    let guest_identity_file =
        |host: &Path| -> PathBuf { guest_identity.join(host.file_name().unwrap_or_default()) };
    // The home dir: bwrap creates the dotfile-mask mount points there and the
    // workload may keep caches in it. It is guest-local SCRATCH, never copied
    // back: it is not a run output, so nothing in it can fail a run, slow the
    // copy-back, or reach the run's records in the host workspace.
    let guest_home = format!("{}/home", vm::GUEST_ARTIFACTS_OUT_DIR);

    // ── size + boot the run's VM, read the layer plan inside it ─────────────
    let host_cpus = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1);
    let host_mib = vm::host_memory_bytes()
        .map(|b| u32::try_from(b / (1024 * 1024)).unwrap_or(u32::MAX))
        .unwrap_or(8192);
    let mem_cap_mib = u32::try_from(limits.memory_max_bytes.max(0) / (1024 * 1024)).unwrap_or(u32::MAX);
    // Guest RAM: the workload's memory cap (2 GiB when none is set) + room for
    // the guest kernel and agent + the output budget, never more than 3/4 of
    // the Mac's RAM.
    let ram_ceiling = (host_mib / 4 * 3).max(1024);
    let ram_mib = (if mem_cap_mib == 0 { 2048 } else { mem_cap_mib })
        .saturating_add(512 + OUTPUT_BUDGET_MIB)
        .clamp(1024, ram_ceiling);
    // The cgroup limit must fit inside the VM, or the guest kernel's OOM
    // killer (which can take the agent) fires before the cgroup's. With no cap
    // configured, the VM's usable RAM is the limit (0 would mean zero bytes).
    let usable = u64::from(ram_mib.saturating_sub(512).max(512)) * 1024 * 1024;
    let cgroup_memory_max = match limits.memory_max_bytes.max(0) as u64 {
        0 => usable,
        cap => cap.min(usable),
    };
    let spec = VmSpec {
        num_vcpus: req.n_cpu.clamp(1, host_cpus.clamp(1, 255)) as u8,
        ram_mib,
        base_disk: base_image,
        layer_disk: layer_image,
        ro_shares,
    };
    let method_vm = MethodVm::boot(&spec).await?;
    let (layer_entries, command) = method_vm.read_layer_plan().await?;

    // ── the stacked argv, with guest paths ──────────────────────────────────
    let caps = HardeningCapabilities {
        bwrap_path: PathBuf::from(vm::GUEST_BWRAP_PATH),
        // bwrap's PID namespace works in the guest kernel; cgroup + seccomp
        // are applied by the agent.
        pid_namespace: PidNsMode::Strict,
        cgroup: CgroupMode::None,
        seccomp: SeccompMode::NotLinked,
    };
    let guest_ctx = SandboxContext {
        job_id,
        workspace: PathBuf::from(&guest_home),
    };
    // The guest agent compiles the shared seccomp policy itself (static
    // libseccomp in the guest), so the filter is always on in the VM — it does
    // not depend on whether the host build enables its optional
    // `sandbox_seccomp` support, which links a Linux-only library.
    let seccomp_fd = Some(vm::GUEST_SECCOMP_FD);
    let fifo = sink.is_some().then_some(sandbox_vm_protocol::PROGRESS_GUEST_FIFO_PATH);
    let argv = super::stack::build_stacked_bwrap_argv(
        &caps,
        &guest_ctx,
        Path::new(vm::GUEST_BASE_MOUNT),
        Path::new(vm::GUEST_LAYER_MOUNT),
        &layer_entries,
        &command,
        &guest_identity_file(identity.passwd()),
        &guest_identity_file(identity.group()),
        &guest_identity_file(identity.mask()),
        seccomp_fd,
        &limits,
        &guest_mounts,
        guest_model_mount.as_ref(),
        req.n_cpu,
        fifo,
        req.mode.sigbench_mode(),
    )?;

    // ── run: live log frames + milestones, streamed outputs, timeout ────────
    let effective_timeout = clamp_timeout(req.timeout_secs, limits.timeout_secs);
    let exec = sandbox_vm_protocol::ExecRequest {
        protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
        request_id: 1,
        bwrap_path: vm::GUEST_BWRAP_PATH.to_string(),
        argv,
        timeout_ms: effective_timeout.saturating_mul(1000),
        seccomp_fd,
        cgroup: Some(sandbox_vm_protocol::CgroupLimits {
            memory_max_bytes: cgroup_memory_max,
            memory_swap_max_bytes: limits.memory_swap_max_bytes.max(0) as u64,
            pids_max: limits.pids_max.max(0) as u64,
            cpu_max: limits.cpu_max.clone(),
        }),
        progress: sink.is_some(),
        collect_artifacts,
        // One tmpfs holds every output dir and the home (the whole output
        // budget is shared); files come back in chunks, and anything that
        // cannot be sent fails the run instead of leaving partial outputs.
        artifacts: sandbox_vm_protocol::ArtifactOptions {
            tmpfs_size: Some(format!("{OUTPUT_BUDGET_MIB}m")),
            tmpfs_root: Some(vm::GUEST_ARTIFACTS_OUT_DIR.to_string()),
            scratch_dirs: vec![guest_home.clone()],
            // The outputs' logical sizes may not exceed the budget either: a
            // sparse file takes almost no tmpfs space but would come back as
            // its full size. The agent reports what is over, and the host
            // enforces the same total.
            total_cap_bytes: u64::from(OUTPUT_BUDGET_MIB) * 1024 * 1024,
        },
    };
    // The command's own budget (+ grace); the copy-back after it is bounded by
    // inactivity instead (`MethodVm::exec`).
    let command_budget = std::time::Duration::from_secs(effective_timeout.saturating_add(60));
    let mut outcome = method_vm
        .exec(exec, command_budget, sink.as_ref(), &artifact_dirs)
        .await?;
    drop(method_vm);
    // Outputs that did not come back: a run that otherwise succeeded is
    // refused (never kept with partial outputs); a run that failed keeps its
    // own exit code and stderr, with the missing outputs added to stderr.
    if !outcome.incomplete.is_empty() {
        if outcome.exit_code == 0 && !outcome.timed_out {
            return Err(vm::outputs_incomplete(&outcome.incomplete, &outcome.stderr_tail));
        }
        let note = format!(
            "\n[txresbench] the method's outputs could not all be copied back from the method VM: {}\n",
            outcome.incomplete.join("; ")
        );
        outcome.stderr.extend_from_slice(note.as_bytes());
    }
    // Symlinks that point outside their output dir are not written on the
    // host (host code reading the outputs would follow them); the run keeps
    // its result and says which links were left out.
    if !outcome.left_out_symlinks.is_empty() {
        tracing::warn!(
            links = ?outcome.left_out_symlinks,
            "method VM: output symlinks outside their output dir were not recreated"
        );
        let note = format!(
            "\n[txresbench] {} output symlink(s) point outside their output dir and were not \
             recreated on the host: {}\n",
            outcome.left_out_symlinks.len(),
            outcome.left_out_symlinks.join("; ")
        );
        outcome.stderr.extend_from_slice(note.as_bytes());
    }
    drop(image_stage);
    drop(input_stage);

    // ── the fit's /model digest (DEC-6), over the files written back ────────
    let model_out_digest = match &req.model_out_dir {
        Some(d) if d.is_dir() => Some(super::stack::tree_sha256(d)?),
        _ => None,
    };
    let base_env_digest =
        super::env_image::read_run_env_digest(&workspace).unwrap_or_default();
    let layer_env_digest =
        super::stack::read_run_layer_digest(&workspace).unwrap_or_default();

    Ok(map_run_result(
        StackRunOutcome {
            exit_code: outcome.exit_code,
            stdout: super::sandbox::lossy_string_with_marker(outcome.stdout, outcome.stdout_truncated),
            stderr: super::sandbox::lossy_string_with_marker(outcome.stderr, outcome.stderr_truncated),
            stdout_truncated: outcome.stdout_truncated,
            stderr_truncated: outcome.stderr_truncated,
            timed_out: outcome.timed_out,
            duration_ms: outcome.duration_ms,
        },
        base_env_digest,
        layer_env_digest,
        model_verified,
        model_out_digest,
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub async fn run_method_in_stack(
    _pool: &SqlitePool,
    _req: &MethodRunRequest,
    _mounts: &[ExtraMount],
    _job_id: Uuid,
    _sink: Option<std::sync::Arc<dyn super::backend::ProgressSink>>,
) -> Result<MethodRunResult, AppError> {
    Err(unavailable("the method sandbox runs on Linux and Apple Silicon macOS only"))
}

/// The fit-mode `/model` mount (DEC-6): the request's `model_out_dir` bound
/// READ-WRITE at the fixed `/model` dest, so the mode (`SIGBENCH_MODE` /
/// `TXRESBENCH_MODE=fit`) writes the
/// trained model into the caller's staging tree. `None` for a reuse run (its
/// verification + read-only bind is the separate [`ModelMount`] path — never
/// both, enforced by [`validate_model_contract`]). Pure + testable.
#[cfg(any(target_os = "linux", target_os = "macos"))]
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn forward_log_line(
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], truncated: &mut bool) {
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
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
