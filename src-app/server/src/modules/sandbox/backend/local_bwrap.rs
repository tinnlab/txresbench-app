//! The only implemented `ComputeBackend`: local bwrap (ITEM-9 / ITEM-17).
//!
//! Delegates to the streaming spawn (`streaming::run_analysis_streaming`),
//! assembling the `ExtraMount` vec (RO inputs + RW `/outputs` + RO `/code`). The
//! GPU / highmem / cluster resource classes + remote/HPC backends are `// SEAM`
//! TODOs routed to a typed `BACKEND_UNAVAILABLE`. A `BackendRegistry` (local-only
//! today) selects a backend by `job.resource_class`.

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;
use ziee_core::AppError;

use super::{
    backend_unavailable, BackendAvailability, ComputeBackend, ComputeSpec, LaunchedCompute,
    ProgressSink, ResourceClass,
};
use crate::modules::sandbox::types::{ExtraMount, MountMode};

/// Assemble the full read/write mount vec for a compute spec (ITEM-17): N
/// read-only `/inputs/*` binds + one read-write `/outputs` + the read-only
/// `/code/entry.*` bind (when present) + any read-only **reference** mounts
/// (ITEM-5c — e.g. a genome at `/refs/…`, already allowlist-validated by the
/// caller). Pure + unit-testable (the FIFO is an argv bind added by
/// `build_bwrap_argv`, not an `ExtraMount`).
///
/// `/outputs` stays READ-WRITE — the processor must still write there. What
/// ITEM-17 changed is the HOST path behind it: `spec.outputs_dir`, which sits in
/// the run's staging tree, NOT under `spec.workspace_root`.
pub fn assemble_mounts(spec: &ComputeSpec, reference_mounts: &[ExtraMount]) -> Vec<ExtraMount> {
    let mut mounts: Vec<ExtraMount> = spec.input_mounts.clone();
    mounts.push(ExtraMount {
        host_path: spec.outputs_dir.clone(),
        sandbox_path: "/outputs".into(),
        mode: MountMode::ReadWrite,
    });
    if let Some(code) = &spec.code_mount {
        mounts.push(code.clone());
    }
    // Reference mounts are always read-only (a genome is never written to). The
    // caller (the queued runner) validates each against the admin allowlist
    // (`spec::validate_extra_mounts_allowed`) + converts via `ExtraMountDecl::to_ro_mount`
    // BEFORE handing them here.
    for m in reference_mounts {
        debug_assert_eq!(m.mode, MountMode::ReadOnly, "reference mounts must be read-only");
        mounts.push(m.clone());
    }
    mounts
}

/// The local bwrap backend. Holds the pool (to read the resource-limits ceiling).
pub struct LocalBwrapBackend {
    #[allow(dead_code)] // used only on the Linux launch path
    pool: PgPool,
}

impl LocalBwrapBackend {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ComputeBackend for LocalBwrapBackend {
    #[cfg(target_os = "linux")]
    async fn launch(
        &self,
        spec: ComputeSpec,
        sink: Arc<dyn ProgressSink>,
    ) -> Result<LaunchedCompute, AppError> {
        use crate::modules::sandbox::{config, probes, settings_cache, streaming, types::SandboxContext};

        let state = config::get_state()
            .ok_or_else(|| backend_unavailable("the analysis sandbox is not available"))?;
        let ceiling = settings_cache::get(&self.pool).await;
        // Fetch-newest env image via the OCI provider (DEC-24 reversed — nothing
        // embedded; lazy-pull + cosign-verify + mount the newest schema-matched image).
        //
        // OFF THE EXECUTOR + BOUNDED (job-hang fix): `provide` shells to
        // `oras`/`cosign` and does synchronous I/O. Called inline it blocked this
        // tokio worker *inside a single `poll`*, which is why no outer
        // `tokio::time::timeout` could ever fire — the task never yielded. On a
        // blocking thread the caller stays pollable, and `staging_budget` bounds
        // the host-tool calls so the blocking work itself also terminates.
        use crate::modules::sandbox::env_image::EnvImageProvider;
        let budget = ceiling.staging_budget();
        // The env-id is DATA (a contributed manifest declares it) — see
        // `env_image::default_env_id`. #189: the JOB's declared env wins when it has one;
        // a job that declares none resolves the deployment default exactly as before, so
        // an env-less job is byte-identical to its pre-#189 behaviour (INV-1).
        let env_id = crate::modules::sandbox::env_image::resolve_env_id(spec.env_id.as_deref())
            .ok_or_else(|| {
                backend_unavailable(
                    "no sandbox env image declared: this job declares no `env`, no installed \
                     processor manifest declares one, and CYTO_SANDBOX_ENV_ID is unset",
                )
            })?;
        // CLEAR any sidecar a PREVIOUS attempt at this job left, BEFORE trying to
        // provide. A run workspace is keyed by `job.id` and deliberately preserved across
        // a failed finalize, so a retry reuses it — and if this attempt fails to provide
        // at all (an unreachable registry, or one of the staged-env refusals above), the
        // stale file would otherwise survive for the recorder to read as THIS run's
        // image. Clearing first makes the sidecar mean "the env THIS attempt mounted" on
        // every path, not just the ones that reach the write below.
        crate::modules::sandbox::env_image::write_run_env_digest(&spec.workspace_root, None);
        let provided = tokio::task::spawn_blocking(move || {
            crate::modules::sandbox::env_image::OciEnvImageProvider::new().provide(&env_id, budget)
        })
        .await
        .map_err(|e| backend_unavailable(format!("env image staging task join: {e}")))?
        // A staged-env MISMATCH propagates with its own typed code and message intact
        // (INV-2): it names the requested and the staged env, and flattening that into a
        // generic "backend unavailable" would erase exactly the detail that stops a
        // reader debugging the image instead of the resolver. Every other provider error
        // keeps its existing wrapping so no other call site's error code moves.
        .map_err(|e| {
            use crate::modules::sandbox::env_image as ei;
            if matches!(
                e.error_code(),
                c if c == ei::ENV_STAGED_MISMATCH_CODE
                    || c == ei::ENV_STAGED_UNASSOCIATED_CODE
                    || c == ei::ENV_STAGED_UNUSABLE_CODE
            ) {
                e
            } else {
                backend_unavailable(format!("env image not ready: {e}"))
            }
        })?;
        // Hand the digest to the run's own workspace so provenance records the image
        // THIS run mounted (INV-3), rather than whatever the process resolved last.
        crate::modules::sandbox::env_image::write_run_env_digest(
            &spec.workspace_root,
            provided.digest.as_deref(),
        );
        let rootfs_dir = provided.rootfs_dir;
        let caps = probes::probe_rootfs_dependent(&state.host_caps, &rootfs_dir)
            .map_err(backend_unavailable)?;

        // The home dir is bound at /home/analyst; outputs/code are ExtraMounts.
        let ctx = SandboxContext {
            job_id: spec.job_id,
            workspace: spec.workspace_root.join("home"),
        };
        streaming::run_analysis_streaming(&state, &ctx, &rootfs_dir, &spec, &caps, &ceiling, sink)
            .await
    }

    #[cfg(not(target_os = "linux"))]
    async fn launch(
        &self,
        _spec: ComputeSpec,
        _sink: Arc<dyn ProgressSink>,
    ) -> Result<LaunchedCompute, AppError> {
        Err(backend_unavailable("the analysis sandbox is Linux-only"))
    }

    fn probe(&self) -> BackendAvailability {
        #[cfg(target_os = "linux")]
        {
            match crate::modules::sandbox::config::init_status() {
                crate::modules::sandbox::config::SandboxAvailability::Ready => {
                    BackendAvailability::Available
                }
                other => BackendAvailability::Unavailable(format!("sandbox {other:?}")),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            BackendAvailability::Unavailable("Linux-only".into())
        }
    }

    fn supports(&self, class: ResourceClass) -> bool {
        matches!(class, ResourceClass::CpuSandbox)
    }
}

/// Selects a `ComputeBackend` by resource class. `cpu-sandbox` → local bwrap; the
/// `{gpu, highmem, cluster-batch}` classes stay typed-unavailable (no cloud backend
/// in this build).
pub struct BackendRegistry {
    local: Arc<dyn ComputeBackend>,
}

impl BackendRegistry {
    /// Build the registry over the local bwrap backend.
    pub fn new(pool: PgPool) -> Self {
        Self {
            local: Arc::new(LocalBwrapBackend::new(pool)),
        }
    }

    /// The backend for a resource class, or a typed `BACKEND_UNAVAILABLE` for a class no
    /// built backend serves. `cpu-sandbox` → local; otherwise unavailable.
    pub fn select(&self, class: ResourceClass) -> Result<Arc<dyn ComputeBackend>, AppError> {
        match class {
            ResourceClass::CpuSandbox => Ok(self.local.clone()),
            other => Err(backend_unavailable(format!(
                "no backend for resource class {:?} (only cpu-sandbox is built)",
                other
            ))),
        }
    }

    /// Availability of the local backend (for the boot log / status).
    pub fn local_probe(&self) -> BackendAvailability {
        self.local.probe()
    }

    /// The LOCAL bwrap backend, regardless of resource class. Used by the in-pod one-shot
    /// executor (`cytoanalyst run-job`): a heavy-class pod is ALREADY placed on its
    /// GPU/highmem node by the job-per-run pod scheduler, so it runs bwrap LOCALLY in-pod —
    /// it must NOT re-select the remote `KubernetesBackend` (which would recursively mint
    /// another pod). This is the one place the class→backend mapping is deliberately bypassed.
    pub fn local_backend(&self) -> Arc<dyn ComputeBackend> {
        self.local.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::backend::{PriorityClass, ResourceProfile};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn spec(with_code: bool, n_inputs: usize) -> ComputeSpec {
        let input_mounts = (0..n_inputs)
            .map(|i| ExtraMount {
                host_path: PathBuf::from(format!("/ws/inputs/in{i}")),
                sandbox_path: format!("/inputs/in{i}"),
                mode: MountMode::ReadOnly,
            })
            .collect();
        ComputeSpec {
            job_id: Uuid::nil(),
            workspace_root: PathBuf::from("/ws"),
            // ITEM-17: outside `/ws` on purpose — the assertions below pin that.
            outputs_dir: PathBuf::from("/staging/job/outputs"),
            command: "python3 /code/entry.py".into(),
            input_mounts,
            code_mount: with_code.then(|| ExtraMount {
                host_path: PathBuf::from("/ws/code/entry.py"),
                sandbox_path: "/code/entry.py".into(),
                mode: MountMode::ReadOnly,
            }),
            // Reference mounts are supplied per-call to `assemble_mounts`; the
            // spec-carried set is empty in this helper (ITEM-5c wiring, mod.rs).
            extra_mounts: vec![],
            profile: ResourceProfile {
                memory_max_bytes: 1 << 30,
                memory_swap_max_bytes: 1 << 30,
                pids_max: 128,
                cpu_max: "100000 100000".into(),
                timeout_secs: 60,
            },
            priority: PriorityClass::Normal,
            resource_class: ResourceClass::CpuSandbox,
            // #189 test fixture: no per-job env ⇒ the deployment default (INV-1).
            env_id: None,
        }
    }

    // TEST-8: mount assembly = N RO inputs + one RW /outputs + one RO /code.
    #[test]
    fn assemble_mounts_ro_inputs_rw_outputs_ro_code() {
        let m = assemble_mounts(&spec(true, 2), &[]);
        assert_eq!(m.len(), 4, "2 inputs + outputs + code");
        // The two inputs are read-only.
        assert!(m[0..2].iter().all(|x| x.mode == MountMode::ReadOnly));
        // /outputs is read-write.
        let out = m.iter().find(|x| x.sandbox_path == "/outputs").unwrap();
        assert_eq!(out.mode, MountMode::ReadWrite);
        // TEST-23 (unit leg, ITEM-17): the host path behind /outputs is the spec's
        // staging dir, and it is NOT under the workspace root. A regression that
        // re-derives it as `workspace_root.join("outputs")` fails BOTH assertions.
        assert_eq!(out.host_path, PathBuf::from("/staging/job/outputs"));
        assert!(
            !out.host_path.starts_with(&spec(true, 2).workspace_root),
            "outputs stage OUTSIDE the sandbox workspace"
        );
        // /code/entry.py is read-only.
        let code = m.iter().find(|x| x.sandbox_path == "/code/entry.py").unwrap();
        assert_eq!(code.mode, MountMode::ReadOnly);

        // No code mount → 1 input + outputs only.
        let m2 = assemble_mounts(&spec(false, 1), &[]);
        assert_eq!(m2.len(), 2);
        assert!(m2.iter().any(|x| x.sandbox_path == "/outputs"));
        assert!(!m2.iter().any(|x| x.sandbox_path.starts_with("/code")));
    }

    // TEST-10 (assemble leg): reference mounts (ITEM-5c) are appended as RO binds,
    // after inputs/outputs/code, and `ExtraMountDecl::to_ro_mount` yields RO.
    #[test]
    fn assemble_mounts_appends_reference_mounts_ro() {
        use crate::modules::sandbox::types::ExtraMountDecl;
        let decl = ExtraMountDecl {
            host_path: "/srv/refs/GRCh38".into(),
            sandbox_path: "/refs/GRCh38".into(),
        };
        let ref_mount = decl.to_ro_mount();
        assert_eq!(ref_mount.mode, MountMode::ReadOnly);

        let m = assemble_mounts(&spec(true, 1), std::slice::from_ref(&ref_mount));
        // 1 input + outputs + code + 1 reference.
        assert_eq!(m.len(), 4);
        let refm = m.iter().find(|x| x.sandbox_path == "/refs/GRCh38").unwrap();
        assert_eq!(refm.mode, MountMode::ReadOnly, "reference mount is read-only");
        assert_eq!(refm.host_path, PathBuf::from("/srv/refs/GRCh38"));
        // The reference mount lands AFTER /outputs + /code (can't shadow hardening).
        let out_i = m.iter().position(|x| x.sandbox_path == "/outputs").unwrap();
        let ref_i = m.iter().position(|x| x.sandbox_path == "/refs/GRCh38").unwrap();
        assert!(ref_i > out_i, "reference mount appended after /outputs");
    }

    // TEST-4 (ITEM-4): `local_backend()` returns the local arm regardless of class — it
    // supports cpu-sandbox and is NOT a remote-staging backend (so the in-pod `run-job`
    // executor forced onto it runs bwrap locally + materializes/finalizes in-process, never
    // re-dispatching to k8s). And `LocalBwrapBackend::stages_inputs_remotely()` is the default
    // `false` (ITEM-1), the negative control for the KubernetesBackend override.
    #[test]
    fn local_backend_accessor_returns_a_local_non_remote_backend() {
        struct Dummy;
        #[async_trait]
        impl ComputeBackend for Dummy {
            async fn launch(
                &self,
                _s: ComputeSpec,
                _k: Arc<dyn ProgressSink>,
            ) -> Result<LaunchedCompute, AppError> {
                Err(backend_unavailable("dummy"))
            }
            fn probe(&self) -> BackendAvailability {
                BackendAvailability::Available
            }
            fn supports(&self, class: ResourceClass) -> bool {
                matches!(class, ResourceClass::CpuSandbox)
            }
        }
        let reg = BackendRegistry {
            local: Arc::new(Dummy),
        };
        let local = reg.local_backend();
        assert!(local.supports(ResourceClass::CpuSandbox), "local serves cpu-sandbox");
        assert!(
            !local.stages_inputs_remotely(),
            "the local backend does NOT stage inputs remotely (default false)"
        );
    }

    // TEST-2: the registry selects local for cpu-sandbox + rejects other classes;
    // supports() + probe() report correctly.
    #[test]
    fn registry_selects_local_and_rejects_unbuilt_classes() {
        // A registry over a dummy backend (probe returns a fixed value).
        struct Dummy;
        #[async_trait]
        impl ComputeBackend for Dummy {
            async fn launch(
                &self,
                _s: ComputeSpec,
                _k: Arc<dyn ProgressSink>,
            ) -> Result<LaunchedCompute, AppError> {
                Err(backend_unavailable("dummy"))
            }
            fn probe(&self) -> BackendAvailability {
                BackendAvailability::Available
            }
            fn supports(&self, class: ResourceClass) -> bool {
                matches!(class, ResourceClass::CpuSandbox)
            }
        }
        let reg = BackendRegistry {
            local: Arc::new(Dummy),
        };

        assert!(reg.select(ResourceClass::CpuSandbox).is_ok(), "cpu-sandbox → local");
        for c in [ResourceClass::Gpu, ResourceClass::Highmem, ResourceClass::ClusterBatch] {
            let err = reg.select(c).err().expect("unbuilt class → error");
            assert_eq!(err.error_code(), "BACKEND_UNAVAILABLE", "{c:?} unbuilt → typed error");
        }
        assert_eq!(reg.local_probe(), BackendAvailability::Available);
        assert!(reg.local.supports(ResourceClass::CpuSandbox));
        assert!(!reg.local.supports(ResourceClass::Gpu));
    }
}
