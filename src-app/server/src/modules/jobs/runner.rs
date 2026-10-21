//! The pluggable job-runner seam + the stub runner + the sandbox (analysis)
//! runner + the job-type dispatcher.
//!
//! `JobRunner::spawn` returns a real OS child process the executor drives (reads
//! its logs, samples it, waits/kills it). `DispatchRunner` routes on
//! `Job.job_type`: `analysis` → `SandboxJobRunner` (bwrap streaming), everything
//! else → `StubJobRunner` (the proven stub, kept for tests). The sandbox runner
//! delegates to a `ComputeBackend` (`LocalBwrapBackend`) behind the compute seam.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;

use super::models::Job;
use super::seams::PeakMetrics;
use crate::modules::sandbox::backend::{
    BackendAvailability, ComputeBackend, ProgressFrame, ProgressSink, ResourceClass,
};

/// A spawned job process handed back to the executor. `guards` (opaque) holds the
/// sandbox cgroup scope + seccomp pipe + FIFO-drain handle so their Drop outlives
/// the child; `workspace` is the per-job SCRATCH dir (`home/`, `inputs/`, `code/`)
/// the executor removes when the run ends; `outputs_staging` is the separate dir the
/// run wrote `/outputs` into, which `finalize` ingests from and THEN removes;
/// `cgroup_path` lets the sampler read whole-subtree metrics by path.
///
/// The two dirs are carried separately (ITEM-17) because they have different
/// lifetimes: the workspace is scratch, the outputs must survive until ingest has
/// consumed them.
pub struct SpawnedJob {
    pub child: tokio::process::Child,
    pub guards: Option<Box<dyn Send + 'static>>,
    pub workspace: Option<PathBuf>,
    /// The run's output staging dir (`<staging_root>/<job_id>/`), whose `outputs/`
    /// subdir is bound RW at `/outputs`. `None` for a runner that produces no
    /// outputs (the stub).
    pub outputs_staging: Option<PathBuf>,
    pub cgroup_path: Option<PathBuf>,
    /// Wall-clock budget (seconds) the executor enforces — killing the child +
    /// failing the job if exceeded. `None` = no wall-clock cap (the stub, which
    /// is self-bounded). Set for analysis jobs from the resolved caps so a
    /// low-CPU blocking script (which never trips RLIMIT_CPU) can't run forever.
    pub timeout_secs: Option<u64>,
}

impl SpawnedJob {
    /// A bare spawned child with no sandbox guards/workspace (the stub path).
    fn bare(child: tokio::process::Child) -> Self {
        Self {
            child,
            guards: None,
            workspace: None,
            outputs_staging: None,
            cgroup_path: None,
            timeout_secs: None,
        }
    }
}

/// Spawns a job's process. The executor owns the returned child (log capture,
/// metric sampling, wait / signal) + the guards (dropped after the terminal
/// persist).
#[async_trait]
pub trait JobRunner: Send + Sync {
    async fn spawn(&self, job: &Job) -> Result<SpawnedJob, String>;
}

/// Stub runner: a REAL child process that streams incremental stdout, burns a
/// little CPU + memory each step, runs a bounded duration, and dies on signal.
pub struct StubJobRunner;

#[async_trait]
impl JobRunner for StubJobRunner {
    async fn spawn(&self, job: &Job) -> Result<SpawnedJob, String> {
        let (program, args) = stub_command(job);
        let child = tokio::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // Die with the server process even on kill -9 / OOM (no orphaned
            // stub children; the boot crash-safety pass then reaps their rows).
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn failed: {e}"))?;
        // An optional `params.timeout_secs` lets a caller/test exercise the
        // executor's wall-clock enforcement (the same path analysis jobs use).
        let timeout_secs = job
            .params
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .filter(|&s| s > 0);
        Ok(SpawnedJob {
            timeout_secs,
            ..SpawnedJob::bare(child)
        })
    }
}

// ───────────────────────────── analysis runner ──────────────────────────────

/// A progress sink that broadcasts drained FIFO frames onto the job's SSE stream.
/// Milestones are ALSO persisted to `job_milestones` (for detail-view / reconnect
/// replay), so the sink carries a pool for the fire-and-forget insert.
struct JobProgressSink {
    job_id: uuid::Uuid,
    pool: PgPool,
    // The sandbox invokes `progress`/`milestone` from a SYNCHRONOUS (non-Tokio)
    // callback thread, so `tokio::spawn` there panics ("no reactor running").
    // Capture the runtime handle at construction (which runs on a Tokio thread)
    // and spawn the fire-and-forget milestone insert onto it instead.
    rt: tokio::runtime::Handle,
}

impl ProgressSink for JobProgressSink {
    fn progress(&self, frame: ProgressFrame) {
        super::runtime::runtime()
            .broadcast(self.job_id, super::sse::SSEJobEvent::Progress(frame).into());
    }

    fn milestone(&self, frame: crate::modules::sandbox::backend::MilestoneFrame) {
        // Emit onto the live SSE stream (the end-user-facing step ticker)…
        super::runtime::runtime().broadcast(
            self.job_id,
            super::sse::SSEJobEvent::Milestone(frame.clone()).into(),
        );
        // …and persist for reload/reconnect replay. Fire-and-forget (mirrors the
        // tool-call recorder): a DB hiccup must never fail the running job.
        let pool = self.pool.clone();
        let job_id = self.job_id;
        self.rt.spawn(async move {
            let repo = super::repository::JobRepository::new(pool);
            if let Err(e) = repo
                .append_milestone(job_id, &frame.id, &frame.status, &frame.detail)
                .await
            {
                tracing::warn!(%job_id, milestone = %frame.id, "append_milestone failed: {e}");
            }
        });
    }
}

/// The analysis runner: decodes the analysis spec, stages code + inputs, resolves
/// caps, and delegates to the selected `ComputeBackend`.
pub struct SandboxJobRunner {
    pool: PgPool,
    registry: Arc<crate::modules::sandbox::backend::local_bwrap::BackendRegistry>,
}

impl SandboxJobRunner {
    pub fn new(
        pool: PgPool,
        registry: Arc<crate::modules::sandbox::backend::local_bwrap::BackendRegistry>,
    ) -> Self {
        Self { pool, registry }
    }
}

/// The deployment allowlist of host-path ROOTS a reference `ExtraMount` may bind
/// from (ITEM-5c / DEC-11). Admin-controlled via `CYTO_SANDBOX_REFERENCE_MOUNTS`
/// (colon-separated absolute roots, mirroring `CYTO_SANDBOX_CGROUP_PARENT`).
/// **Empty by default** — a reference mount is refused until an operator
/// allowlists its root, so the wiring is safe-by-default: a job with no
/// `extra_mounts` is unaffected (the allow-check over an empty set is a no-op),
/// and an un-allowlisted mount fails the job rather than binding an unvetted path.
pub fn reference_mount_allowlist() -> Vec<PathBuf> {
    std::env::var("CYTO_SANDBOX_REFERENCE_MOUNTS")
        .ok()
        .map(|s| {
            s.split(':')
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Validate + convert an analysis spec's declared reference mounts (ITEM-5c) into
/// the RO [`ExtraMount`] binds the compute backend mounts. Enforces the deployment
/// allowlist BEFORE converting: first a fast LEXICAL prefix pre-check
/// (`validate_extra_mounts_allowed`), then the authoritative symlink-resolving
/// `canonicalize_under_allowlist` per mount (FIX-3 — a symlink under an
/// allowlisted root can no longer bind an arbitrary host path). Each RO bind uses
/// the CANONICAL host path, so a symlink swapped in after the check can't redirect
/// the bind. A non-allowlisted / escaping / unresolvable host path → a clear error
/// (the job fails instead of binding an unvetted path); an empty `extra_mounts`
/// yields an empty vec. NOT pure (canonicalization touches the filesystem).
pub fn build_reference_mounts(
    spec: &crate::modules::sandbox::spec::AnalysisSpec,
    allowlist: &[PathBuf],
) -> Result<Vec<crate::modules::sandbox::types::ExtraMount>, String> {
    use crate::modules::sandbox::types::{ExtraMount, MountMode};
    // Lexical pre-check (rejects an obviously-non-allowlisted / `..` path fast).
    spec.validate_extra_mounts_allowed(allowlist)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(spec.extra_mounts.len());
    for m in &spec.extra_mounts {
        let canon =
            crate::modules::sandbox::spec::canonicalize_under_allowlist(&m.host_path, allowlist)
                .map_err(|e| e.to_string())?;
        out.push(ExtraMount {
            host_path: canon,
            sandbox_path: m.sandbox_path.clone(),
            mode: MountMode::ReadOnly,
        });
    }
    Ok(out)
}

/// The env var an operator sets to point a DECLARED host-resource NAME at a host
/// path (S7): `reference` → `CYTO_SANDBOX_RESOURCE_REFERENCE`. `-` becomes `_` and
/// the name is uppercased; anything outside `[a-z0-9_-]` is refused so a declared
/// name can never reach outside the env namespace.
pub fn host_resource_env_var(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("a host-resource requirement declares an empty `name`".to_string());
    }
    if !n
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "host-resource name {n:?} must use only letters, digits, `_` and `-`"
        ));
    }
    Ok(format!(
        "CYTO_SANDBOX_RESOURCE_{}",
        n.to_ascii_uppercase().replace('-', "_")
    ))
}

/// The RO bind for ONE manifest-DECLARED host resource (S7).
///
/// ## What this replaced
///
/// `reference_root_mount` hardcoded the reference-genome CONCEPT into the server:
/// the fixed env var `CYTO_SANDBOX_REFERENCE_ROOT`, the fixed in-sandbox mount
/// `/refdata`, and an error message reading "this processor requires a
/// reference-genome mount". A processor now DECLARES `{name, mount_path}` in its
/// manifest `run.host_resources`, and the operator maps the NAME to a host path —
/// the server understands neither genomes nor indexes nor models, only "this entry
/// asked for the resource called X".
///
/// The host path is still BACKEND-controlled (env, never the model-/FE-supplied
/// spec) and MUST resolve under the `CYTO_SANDBOX_REFERENCE_MOUNTS` allowlist — else
/// the job fails with a clear reason (it never binds an unvetted path and never
/// emulates a missing resource). `mount_path` is validated absolute + escape-free
/// because it comes from a package manifest, which a contributor writes.
///
/// **Back-compat:** the legacy `CYTO_SANDBOX_REFERENCE_ROOT` is still honored, as a
/// documented ALIAS for the resource named `reference`, so an existing deployment
/// keeps working without an operator edit.
pub fn host_resource_mount(
    req: &crate::modules::extensions::types::HostResourceRequirement,
    allowlist: &[PathBuf],
) -> Result<crate::modules::sandbox::types::ExtraMount, String> {
    use crate::modules::sandbox::types::{ExtraMount, MountMode};
    let var = host_resource_env_var(&req.name)?;
    validate_mount_path(&req.mount_path)?;
    let root = std::env::var(&var)
        .ok()
        // Documented back-compat alias (see the doc above).
        .or_else(|| {
            (req.name.trim().eq_ignore_ascii_case("reference"))
                .then(|| std::env::var("CYTO_SANDBOX_REFERENCE_ROOT").ok())
                .flatten()
        })
        .ok_or_else(|| {
            format!(
                "this processor declares the host resource {:?} (mounted at {}), which this \
                 deployment does not provide; set {var} to the host path and allowlist its \
                 root via CYTO_SANDBOX_REFERENCE_MOUNTS",
                req.name, req.mount_path
            )
        })?;
    let canon = crate::modules::sandbox::spec::canonicalize_under_allowlist(&root, allowlist)
        .map_err(|e| e.to_string())?;
    Ok(ExtraMount {
        host_path: canon,
        sandbox_path: req.mount_path.clone(),
        mode: MountMode::ReadOnly,
    })
}

/// A DECLARED in-sandbox mount path must be absolute, escape-free, and must not
/// shadow a path the runner owns (`/code`, `/inputs`, `/outputs`, `/home`) — a
/// package manifest is contributor-authored, so this is a real boundary.
pub fn validate_mount_path(path: &str) -> Result<(), String> {
    use std::path::{Component, Path};
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("declared mount_path {path:?} must be absolute"));
    }
    if p.components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(format!("declared mount_path {path:?} must be escape-free"));
    }
    for owned in ["/", "/code", "/inputs", "/outputs", "/home"] {
        if p == Path::new(owned) {
            return Err(format!(
                "declared mount_path {path:?} would shadow the runner-owned {owned}"
            ));
        }
    }
    Ok(())
}

/// Guard: the backend must support the class AND be available, else a CLEAR error
/// (so the executor marks the job `failed` with a reason, never silently hangs).
/// Pure — unit-testable with a fake backend (ITEM-29 / TEST-23).
pub fn precheck_backend(backend: &dyn ComputeBackend, class: ResourceClass) -> Result<(), String> {
    if !backend.supports(class) {
        return Err(format!("backend does not support resource class {class:?}"));
    }
    match backend.probe() {
        BackendAvailability::Available => Ok(()),
        BackendAvailability::Unavailable(reason) => {
            Err(format!("compute backend unavailable: {reason}"))
        }
    }
}

#[async_trait]
impl JobRunner for SandboxJobRunner {
    async fn spawn(&self, job: &Job) -> Result<SpawnedJob, String> {
        use crate::modules::sandbox::spec::AnalysisSpec;

        // Decode + validate the analysis spec.
        let spec = AnalysisSpec::parse(&job.params).map_err(|e| e.to_string())?;

        // Auto-freeze-on-consume (draftable-entity ITEM-8 / INV-4 / DEC-2 corrected):
        // a `draft_ref` input is resolved — frozen + pinned into a persisted
        // `artifact_ref` — at JOB-CREATE time (`jobs::create_job`), BEFORE the consuming
        // job is enqueued or takes a scheduler slot. So by the time the spec reaches the
        // runner it must carry NO `draft_ref`. This is the defense-in-depth guard: a spec
        // that still names an unresolved draft is refused here (never staged unpinned),
        // which turns an internal invariant break into a clean job failure rather than a
        // silent unpinned consumption. Doing the freeze HERE (the phase-5 placement) is
        // what self-deadlocked — the consumer already held a slot while awaiting the
        // nested freeze — so it is deliberately NOT done here.
        crate::modules::drafts::assert_no_unresolved_draft_refs(&spec)?;

        // Resource class + backend selection (clear error if unavailable — this
        // is the non-Linux / unbuilt-class degrade, ITEM-29).
        let class = ResourceClass::clamped(&job.resource_class);
        let backend = self.registry.select(class).map_err(|e| e.to_string())?;
        precheck_backend(backend.as_ref(), class)?;

        // REMOTE data-plane fork (ITEM-2 / #66): a backend that stages inputs + collects
        // outputs IN THE POD (the `KubernetesBackend` job-per-run fallback) must NOT be handed
        // control-plane-materialized inputs — the pod re-fetches them from the object store and
        // pushes outputs back itself (via `cytoanalyst run-job`, reusing the SAME
        // materialize_inputs + finalize_analysis). So we skip local materialization + local
        // workspace/output staging entirely and return a `SpawnedJob` with NO local dirs, so the
        // executor's finalize block is skipped (the pod owns finalize; the executor reflects the
        // pod's exit code into the job status).
        if backend.stages_inputs_remotely() {
            return self.launch_remote(job, &spec, class, backend.as_ref()).await;
        }

        // LOCAL path: stage a per-job workspace + output staging dir, materialize inputs, and
        // launch the local bwrap child (the cpu-sandbox / worker-pod topology, byte-unchanged).
        self.stage_with_cleanup(job, &spec, class, backend.as_ref())
            .await
    }
}

impl SandboxJobRunner {
    /// Stage a per-job LOCAL workspace + output staging dir, then launch, reclaiming BOTH dirs
    /// on ANY staging error (FIX-4 / ITEM-17) and bounding the whole phase by the staging
    /// budget (job-hang fix). Shared by [`SandboxJobRunner::spawn`] (the cpu-sandbox/worker path)
    /// and [`SandboxJobRunner::spawn_local`] (the in-pod one-shot executor) — the ONE definition
    /// of the local staging + cleanup contract.
    async fn stage_with_cleanup(
        &self,
        job: &Job,
        spec: &crate::modules::sandbox::spec::AnalysisSpec,
        class: ResourceClass,
        backend: &dyn ComputeBackend,
    ) -> Result<SpawnedJob, String> {
        // Per-job workspace ROOT: <sandbox_root>/<job_id>/ (DEC-6), and the run's OUTPUT STAGING
        // dir <staging_root>/<job_id>/ (ITEM-17) — a sibling tree, never a subdir of the
        // workspace. BOTH resolved BEFORE staging so the cleanup arm can reclaim BOTH on ANY error.
        let state = crate::modules::sandbox::config::get_state()
            .ok_or_else(|| "the analysis sandbox is not available".to_string())?;
        let root = state.workspace_root.join(job.id.to_string());
        let staging = crate::modules::sandbox::outputs::staging_dir(&state.staging_root, job.id);

        // STAGING DEADLINE (job-hang fix): a stall in staging (a hung env-image pull, a wedged
        // object-store read while materializing inputs) must not pin the job at `running`
        // forever. Bounding it here keeps the cleanup arm below reachable.
        let budget = crate::modules::sandbox::settings_cache::get(&self.pool)
            .await
            .staging_budget();

        let staged = tokio::time::timeout(
            budget,
            self.stage_and_launch(job, spec, class, backend, &root, &staging),
        )
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "staging timed out after {}s before the job process could start (env-image \
                 fetch/verify/mount or input materialization stalled); raise \
                 `staging_timeout_secs` in the sandbox settings if this deployment needs a \
                 longer cold-start budget",
                budget.as_secs()
            ))
        });

        match staged {
            Ok(spawned) => Ok(spawned),
            Err(e) => {
                if let Err(err) = tokio::fs::remove_dir_all(&root).await {
                    if err.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(job_id = %job.id, error = %err, "analysis workspace cleanup failed after a staging error");
                    }
                }
                crate::modules::sandbox::outputs::discard_staging(&staging).await;
                Err(e)
            }
        }
    }

    /// Launch a REMOTE (job-per-run) analysis (ITEM-2 / #66). The control plane does NO local
    /// input materialization + NO local output staging: the pod re-fetches inputs from the object
    /// store and pushes outputs back itself (`cytoanalyst run-job`). We build a MINIMAL,
    /// path-agnostic `ComputeSpec` (the `KubernetesBackend` uses only `job_id` +
    /// `resource_class` from it — it re-derives everything else from the DB job row in-pod), then
    /// hand back a `SpawnedJob` with NO local workspace/staging so the executor's local finalize
    /// block is skipped (the pod owns finalize; the executor reflects the pod's exit → status).
    async fn launch_remote(
        &self,
        job: &Job,
        spec: &crate::modules::sandbox::spec::AnalysisSpec,
        class: ResourceClass,
        backend: &dyn ComputeBackend,
    ) -> Result<SpawnedJob, String> {
        use crate::modules::sandbox::backend::ComputeSpec;

        let priority =
            crate::modules::sandbox::backend::PriorityClass::clamped(&job.priority_class);
        let ceiling = crate::modules::sandbox::settings_cache::get(&self.pool).await;
        let req = crate::modules::sandbox::settings::ResourceRequest {
            priority,
            cpu_cores: spec.schedule.cpu,
            mem_bytes: spec.schedule.mem_bytes,
            timeout_secs: spec.timeout_secs,
        };
        let profile = crate::modules::sandbox::settings::resolve_caps(&req, &ceiling);

        // Path-agnostic minimal spec. `command`/mounts/dirs are UNUSED by the remote pod path
        // (the pod runs `run-job --job-id`, not `spec.command`), but the fields must be present.
        //
        // `env_id` is NOT in that "unused" set (#189): the pod re-enters via
        // `run-job --job-id` and resolves its env from the process environment, so the
        // env-id the K8s backend stamps into the pod's `CYTO_SANDBOX_ENV_ID` is the only
        // channel by which this job's declared env reaches the run.
        let compute = ComputeSpec {
            job_id: job.id,
            workspace_root: std::path::PathBuf::from("/remote"),
            outputs_dir: std::path::PathBuf::from("/remote"),
            command: String::new(),
            input_mounts: vec![],
            code_mount: None,
            extra_mounts: vec![],
            profile,
            priority,
            resource_class: class,
            env_id: spec.env.clone(),
        };

        let sink: Arc<dyn ProgressSink> = Arc::new(JobProgressSink {
            job_id: job.id,
            pool: self.pool.clone(),
            rt: tokio::runtime::Handle::current(),
        });
        let launched = backend
            .launch(compute, sink)
            .await
            .map_err(|e| e.to_string())?;

        Ok(SpawnedJob {
            child: launched.child,
            guards: Some(launched.guards),
            // No local dirs → the executor skips its local finalize (the pod finalized already).
            workspace: None,
            outputs_staging: None,
            cgroup_path: launched.cgroup_path,
            // The pod enforces its OWN wall-clock in-pod; the shepherd is a bare exit-mirror, and
            // the KubernetesBackend watcher has its own ceiling — so no executor wall-clock here.
            timeout_secs: None,
        })
    }

    /// The IN-POD one-shot execution path (ITEM-3 / #66): FORCE the local bwrap backend
    /// regardless of the job's resource_class. A heavy-class (`gpu`/`highmem`/`cluster-batch`)
    /// pod is ALREADY placed on its node by the job-per-run pod scheduler, so it runs bwrap
    /// LOCALLY in-pod — it must NOT re-select the remote `KubernetesBackend` (which would
    /// recursively mint another pod). This runs the UNCHANGED local stage path
    /// (materialize_inputs from the object store into the pod's workspace + bwrap), so the
    /// inputs.json / `/outputs` contract is byte-identical to the cpu-sandbox path.
    pub async fn spawn_local(&self, job: &Job) -> Result<SpawnedJob, String> {
        use crate::modules::sandbox::spec::AnalysisSpec;

        let spec = AnalysisSpec::parse(&job.params).map_err(|e| e.to_string())?;
        crate::modules::drafts::assert_no_unresolved_draft_refs(&spec)?;

        let backend = self.registry.local_backend();
        // The local backend serves cpu-sandbox; precheck it under that class (the compute is the
        // same local bwrap whatever the job's SCHEDULING resource_class was).
        precheck_backend(backend.as_ref(), ResourceClass::CpuSandbox)?;
        self.stage_with_cleanup(job, &spec, ResourceClass::CpuSandbox, backend.as_ref())
            .await
    }

    /// The fallible workspace-staging + launch body. Every `?`/early-return here is
    /// covered by [`SandboxJobRunner::spawn`]'s cleanup wrapper, so a failure after
    /// the workspace or staging dir exists never orphans either (FIX-4 / ITEM-17).
    #[allow(clippy::too_many_arguments)]
    async fn stage_and_launch(
        &self,
        job: &Job,
        spec: &crate::modules::sandbox::spec::AnalysisSpec,
        class: ResourceClass,
        backend: &dyn ComputeBackend,
        root: &std::path::Path,
        staging: &std::path::Path,
    ) -> Result<SpawnedJob, String> {
        use crate::modules::sandbox::backend::ComputeSpec;
        use crate::modules::sandbox::types::{ExtraMount, MountMode};

        // Per-job workspace subdirs: home/inputs/code (DEC-6). `outputs` is NOT one
        // of them any more — it lives in the run's staging tree (ITEM-17).
        for sub in ["home", "inputs", "code"] {
            tokio::fs::create_dir_all(root.join(sub))
                .await
                .map_err(|e| format!("create workspace {sub}: {e}"))?;
        }
        // The host dir bound RW at /outputs, under the run's STAGING dir. Created
        // through the same helper the mount and the manifest load use, so there is
        // one definition of where a run's outputs are.
        let outputs_dir = crate::modules::sandbox::outputs::outputs_dir(staging);
        tokio::fs::create_dir_all(&outputs_dir)
            .await
            .map_err(|e| format!("create output staging dir: {e}"))?;

        // Resolve the entry (ITEM-18 "last mile"): an inline `script`, OR a BUILTIN
        // processor baked into the binary (`code_ref` → `sandbox::processors`). The
        // SAME resolution feeds the provenance recorder, so the bytes RUN are the
        // bytes RECORDED (reproduce). An unknown code_ref fails the job here with a
        // clear reason instead of the old blanket "code_ref not supported" reject.
        // `resolve_entry` now READS the compute bytes from the extracted folder (blocking
        // `std::fs`), so run it on a blocking pool — never the tokio worker (§5). The
        // `ResolvedEntry` is `'static` (owned/`Cow<'static>`), so it crosses the boundary.
        let spec_for_resolve = spec.clone();
        let resolved = tokio::task::spawn_blocking(move || spec_for_resolve.resolve_entry())
            .await
            .map_err(|e| format!("resolve entry task join: {e}"))?
            .map_err(|e| e.to_string())?;
        let entry_filename = resolved.language.entry_filename();
        let entry_sandbox_path = format!("/code/{entry_filename}");
        let code_dir = root.join("code");
        tokio::fs::write(code_dir.join(entry_filename), resolved.script.as_bytes())
            .await
            .map_err(|e| format!("stage entry script: {e}"))?;
        // Stage the shared Python helper modules alongside the entry (ITEM-13/21):
        // processor scripts `sys.path.insert(0, dirname(__file__))` then
        // `import colsummary` / `import align` / `import multimodal`, so the modules
        // must resolve at /code. Read FROM THE EXTRACTED FOLDER (INV-7), same source as
        // the entry itself.
        // S6: the helper set is DECLARED, not a fixed table — `resolve_entry`
        // already read each one (the entry's own package siblings plus the app's
        // cross-cutting helpers), on the same blocking pool as the entry itself.
        for (name, body) in &resolved.helpers {
            tokio::fs::write(code_dir.join(name), body)
                .await
                .map_err(|e| format!("stage helper {name}: {e}"))?;
        }
        // Bind the whole per-job `/code` DIR read-only (not just the entry file) so
        // the staged helper modules are importable in-sandbox. The dir is per-job and
        // contains only what we just wrote.
        let code_mount = ExtraMount {
            host_path: code_dir,
            sandbox_path: "/code".into(),
            mode: MountMode::ReadOnly,
        };

        // The deployment reference-mount allowlist — gates BOTH `host_path` inputs
        // (FIX-1) and declared `extra_mounts` (ITEM-5c / FIX-3). Resolved once.
        let allowlist = reference_mount_allowlist();

        // Materialize inputs (content-addressed) → RO mounts + inputs.json. Each ref
        // is authorized against the JOB OWNER before any byte is staged (FIX-1 IDOR).
        let store = crate::modules::workstore::try_get_object_store()
            .ok_or_else(|| "object store not initialized".to_string())?;
        let materialized = crate::modules::sandbox::inputs::materialize_inputs(
            spec,
            &root.join("inputs"),
            job.owner_id,
            &allowlist,
            &self.pool,
            store.as_ref(),
        )
        .await
        .map_err(|e| e.to_string())?;
        let input_mounts =
            crate::modules::sandbox::inputs::input_mounts(&materialized, &root.join("inputs"));

        // Resolve per-job HARD caps, clamped to the admin ceiling (ITEM-26).
        let priority =
            crate::modules::sandbox::backend::PriorityClass::clamped(&job.priority_class);
        let ceiling = crate::modules::sandbox::settings_cache::get(&self.pool).await;
        let req = crate::modules::sandbox::settings::ResourceRequest {
            priority,
            cpu_cores: spec.schedule.cpu,
            mem_bytes: spec.schedule.mem_bytes,
            timeout_secs: spec.timeout_secs,
        };
        let profile = crate::modules::sandbox::settings::resolve_caps(&req, &ceiling);
        // The resolved wall-clock budget the executor enforces (A1 — the sandbox
        // caps are RLIMIT_CPU, not wall time; a blocking low-CPU script needs a
        // wall-clock kill).
        let timeout_secs = profile.timeout_secs;

        // Reference mounts (ITEM-5c): validate the declared `extra_mounts` against
        // the deployment allowlist (lexical + symlink-resolving) + convert to RO
        // binds of the CANONICAL host path. A non-allowlisted / escaping path fails
        // the job here (never binds an unvetted host path).
        let mut extra_mounts = build_reference_mounts(spec, &allowlist)?;
        // Every host resource the entry's manifest DECLARES (S7) is bound RO at its
        // DECLARED path. Backend-controlled — the FE never supplies a host path;
        // refused with a clear reason unless the operator set + allowlisted the
        // resource's env var.
        for req in &resolved.host_resources {
            extra_mounts.push(host_resource_mount(req, &allowlist)?);
        }

        let compute = ComputeSpec {
            job_id: job.id,
            workspace_root: root.to_path_buf(),
            outputs_dir,
            command: resolved.language.command_for(&entry_sandbox_path),
            input_mounts,
            code_mount: Some(code_mount),
            extra_mounts,
            profile,
            priority,
            resource_class: class,
            // #189 — the job's declared env. `None` ⇒ the backend resolves the
            // deployment default, exactly as every job did before this field existed.
            env_id: spec.env.clone(),
        };

        let sink: Arc<dyn ProgressSink> = Arc::new(JobProgressSink {
            job_id: job.id,
            pool: self.pool.clone(),
            rt: tokio::runtime::Handle::current(),
        });
        let launched = backend
            .launch(compute, sink)
            .await
            .map_err(|e| e.to_string())?;

        Ok(SpawnedJob {
            child: launched.child,
            guards: Some(launched.guards),
            workspace: Some(root.to_path_buf()),
            outputs_staging: Some(staging.to_path_buf()),
            cgroup_path: launched.cgroup_path,
            timeout_secs: Some(timeout_secs),
        })
    }
}

// ───────────────────────────── dispatcher ───────────────────────────────────

/// Routes a job to the right runner by `job_type`. `analysis` → the sandbox
/// runner; anything else → the stub (preserving the pre-P3 "any type → stub"
/// behavior, so existing stub jobs/tests are unchanged).
pub struct DispatchRunner {
    stub: Arc<dyn JobRunner>,
    analysis: Arc<dyn JobRunner>,
}

impl DispatchRunner {
    pub fn new(stub: Arc<dyn JobRunner>, analysis: Arc<dyn JobRunner>) -> Self {
        Self { stub, analysis }
    }
}

#[async_trait]
impl JobRunner for DispatchRunner {
    async fn spawn(&self, job: &Job) -> Result<SpawnedJob, String> {
        match job.job_type.as_str() {
            "analysis" => self.analysis.spawn(job).await,
            _ => self.stub.spawn(job).await,
        }
    }
}

// ───────────────────────────── finalize ─────────────────────────────────────

/// Whether an analysis job is a dataset supporting-file INTEGRATE run (ITEM-11/20):
/// its `AnalysisSpec` binds the dataset's per-axis entity index at slot `axis_index`
/// (a `dataset_axis_index` input — see `dataset::process::build_integrate_inputs`).
/// Keys the integration-completion hook. A non-analysis / unparseable spec → false.
fn is_integrate_job(job: &Job) -> bool {
    crate::modules::sandbox::spec::AnalysisSpec::parse(&job.params)
        .map(|spec| {
            spec.inputs
                .iter()
                .any(|i| i.slot == "axis_index" && i.dataset_axis_index.is_some())
        })
        .unwrap_or(false)
}

/// What a finalize does with a run's TWO dirs (its workspace + its output staging).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunDirs {
    /// Remove both, now.
    Reclaim,
    /// Keep both, for inspection and retry.
    Preserve,
}

/// **THE rule for a run's output bytes — the ONE place the decision is made.**
///
/// Reclaim the run's two dirs only when its bytes are either *redundant* (already
/// in the catalog) or *scratch* (the run itself never succeeded). Otherwise —
/// the child exited 0 and the server declined to catalog what it produced —
/// PRESERVE them, because they are the sole copy of completed work.
///
/// | `child_succeeded` | `outputs_cataloged` | | why |
/// |---|---|---|---|
/// | false | — | `Reclaim` | the run failed/was cancelled: scratch, not a work product |
/// | true | true | `Reclaim` | the catalog holds the bytes now; the staging copy is redundant |
/// | true | false | `Preserve` | **completed work the server would otherwise delete** |
///
/// ### Why this function exists at all
///
/// Two code paths reach this decision — the LIVE finalize
/// ([`finalize_analysis_with`]) and the BOOT re-finalize
/// ([`super::scheduler::reconcile_orphaned_running_in`]) — and they used to reach
/// it *independently*, from the same predicate, and disagree. Both asked
/// `load_produced_outputs(staging).is_ok()`; on `Err` the live path removed the
/// workspace and discarded the staging, while the boot path took `FailPreserve` and
/// touched neither. So a run whose 5th output misdeclared a path LOST the four good
/// outputs if the failure was caught live and KEPT them if the server had restarted
/// first: same input, opposite data outcome, decided by timing. Both paths now call
/// this, so the rule cannot be half-changed.
///
/// ### Why `Preserve` is the right resolution, not `Reclaim`
///
/// `load_produced_outputs` is ALL-OR-NOTHING — the first entry that fails to
/// resolve errors the whole manifest — so a rejected *declaration* is not the same
/// event as a failed *run*. The bytes of every correctly-declared output are
/// sitting in `<staging>/outputs/`, complete, and they are the only copy: the
/// compute that produced them may have been hours. A misdeclared path is a producer
/// bug, and the bug is exactly what the user needs the evidence to diagnose.
///
/// This is also the rule the surrounding code already applied to the *adjacent*
/// case. A failed ingest has always preserved ("outputs preserved" is in its own
/// error message), and `tests/sandbox` TEST-23 leg 2 states the principle outright:
/// *"an ingest FAILURE is NOT this case. There, the outputs are the sole copy of
/// work that succeeded, so both dirs are PRESERVED."* A manifest rejection is the
/// same class of event one step earlier in the same pipeline — the server refusing
/// to catalog bytes a successful child produced — so it takes the same disposition.
///
/// ITEM-17's cleanup rule ("cleanup after ingest on success, immediately on error")
/// is not violated by this. Its "error" meant *the run produced nothing ingestable*
/// — the cancelled / executor-error / non-zero-exit paths, which is exactly what
/// [`super::scheduler::cleanup_run_dirs`] and the `child_succeeded == false` row
/// above still reclaim immediately. That premise is simply false for an invalid
/// manifest: four resolvable outputs on disk are ingestable bytes, and only the
/// declaration naming a fifth is broken.
///
/// ### Why the retention is bounded (the disk-leak objection)
///
/// Preserved dirs are NOT retained indefinitely. `JobsModule::init` computes its
/// sweep keep-set as `all_live_job_ids()` (`status IN ('blocked','queued','running')`)
/// plus *this boot's* `failed_preserved`; a job failed by a finalize is `failed`, so
/// at the NEXT boot it is in neither set and
/// [`super::scheduler::sweep_stale_run_dirs`] reclaims both of its dirs. Retention
/// is therefore bounded by one server lifetime — the same bound the ingest-failure
/// arm has always relied on (C2) — which is a cost a restart clears, against data
/// loss that nothing does.
pub fn run_dirs_disposition(child_succeeded: bool, outputs_cataloged: bool) -> RunDirs {
    if outputs_cataloged || !child_succeeded {
        RunDirs::Reclaim
    } else {
        RunDirs::Preserve
    }
}

/// Post-exit finalize for an analysis job (ITEM-7 / DEC-G). On exit-0 parse the
/// `/outputs` manifest out of the run's STAGING dir (invalid = a contract
/// violation → Err), hand the parsed outputs to the ingest sink (P1) + run
/// recorder (P4), THEN remove the workspace AND the staging dir. On a non-zero
/// exit nothing is ingested and both dirs are still removed; on a manifest
/// violation nothing is ingested but both are KEPT ([`run_dirs_disposition`]).
/// Returns Ok on success, Err(reason) to fail the job.
///
/// ITEM-17: the two dirs are separate arguments because they are separate trees.
/// `staging_dir` is where `/outputs` was mounted from; `workspace_root` is the run
/// scratch (the provenance recorder hashes `<workspace_root>/code/entry.*` out of
/// it). Whether both are removed on return (best-effort) is decided by
/// [`run_dirs_disposition`] — see it for the rule and the reasoning.
pub async fn finalize_analysis(
    job: &Job,
    exit_code: i32,
    workspace_root: &std::path::Path,
    staging_dir: &std::path::Path,
    peak: PeakMetrics,
) -> Result<(), String> {
    finalize_analysis_with(
        job,
        exit_code,
        workspace_root,
        staging_dir,
        peak,
        super::seams::ingest_sink(),
        super::seams::run_recorder(),
    )
    .await
}

/// The finalize CORE with the ingest sink + run recorder injected. The public
/// [`finalize_analysis`] passes the process-installed seams; the boot-durability
/// reconcile (`scheduler::reconcile_orphaned_running`) passes them too, so a
/// crash-recovery finalize takes the EXACT same code path as a normal completion
/// (one implementation — no drift). Injecting the seams also makes the finalize
/// unit-testable without touching the process-wide `OnceLock`s.
#[allow(clippy::too_many_arguments)]
pub async fn finalize_analysis_with(
    job: &Job,
    exit_code: i32,
    workspace_root: &std::path::Path,
    staging_dir: &std::path::Path,
    peak: PeakMetrics,
    ingest: std::sync::Arc<dyn super::seams::ArtifactIngestSink>,
    recorder: std::sync::Arc<dyn super::seams::RunRecorder>,
) -> Result<(), String> {
    // Hoisted so the dataset integration-completion hook (below) sees the loaded
    // outputs on the SUCCESS path (they carry the coverage `integration_summary`).
    let mut loaded_outputs: Vec<crate::modules::sandbox::outputs::ProducedOutput> = Vec::new();
    let result = if exit_code != 0 {
        Err(format!("analysis exited with code {exit_code}"))
    } else {
        // The manifest + the declared bytes come from the STAGING dir, not the
        // workspace (ITEM-17) — so does the ingest read below.
        match crate::modules::sandbox::outputs::load_produced_outputs(staging_dir).await {
            Ok(outputs) => {
                let ingested = if super::seams::should_ingest(job) {
                    ingest.ingest_outputs(job, &outputs, staging_dir).await
                } else {
                    Ok(())
                };
                match ingested {
                    Ok(()) => {
                        // Record provenance only once the outputs are safely cataloged.
                        // Pass the workspace so the recorder hashes the bytes ACTUALLY
                        // staged+run (`<root>/code/entry.*`) instead of re-resolving the
                        // live folder (M4 — a mid-run edit must not change the record).
                        recorder
                            .record_run(job, &outputs, exit_code, peak, workspace_root)
                            .await;
                        // THE CREATOR (stage 2). The one point where both of its ordering
                        // bounds hold: the outputs are cataloged (it references them by id),
                        // and `run_dirs_disposition` → `RunDirs::Reclaim` has not yet removed
                        // `workspace_root` (it reads `<workspace_root>/inputs/inputs.json`).
                        // A no-op for every run that emitted no `dataset-alignment`.
                        // Fire-and-forget: it logs its own failures and never fails a run
                        // whose outputs are already safe — see `VirtualDatasetSink`.
                        super::seams::virtual_dataset_sink()
                            .on_run_finalized(job, workspace_root)
                            .await;
                        loaded_outputs = outputs;
                        Ok(())
                    }
                    Err(e) => {
                        // Do NOT report success when the artifacts were not cataloged.
                        Err(format!("output ingest failed (outputs preserved): {e}"))
                    }
                }
            }
            // The child SUCCEEDED and the server is refusing its declaration. The
            // correctly-declared outputs are on disk and are the only copy, so this
            // is a preserve, not a reclaim — see `run_dirs_disposition`.
            Err(e) => Err(format!("outputs manifest invalid (outputs preserved): {e}")),
        }
    };

    // Dataset supporting-file integration-completion hook (ITEM-11/20): an integrate
    // job's per-file STATUS derives from the job row, but the coverage summary + a
    // live `sync:dataset` nudge need this completion callback. On success pass the
    // loaded outputs (they carry the hidden `integration_summary` output); on failure
    // pass none. Installed from `DatasetModule::init`; the no-op default otherwise.
    if is_integrate_job(job) {
        let success = result.is_ok();
        let outs: &[crate::modules::sandbox::outputs::ProducedOutput] =
            if success { &loaded_outputs } else { &[] };
        super::seams::integration_sink()
            .on_integrate_finalized(job, success, outs)
            .await;
    }

    // G3 teardown-metrics emit (T3 / ITEM-5 / INV-5): the exactly-once-per-`job_id`
    // child-exit hook. `peak` already carries the FINAL cgroup reading (a post-exit
    // `read_metrics_at` done in `run_and_sample`); we convert it to a `ComputeUsage`
    // and emit through the installed `ComputeMeter` seam (NoopComputeMeter on desktop
    // records nothing; the real `DbComputeMeter` lands an append-only `job_id`-keyed
    // row, idempotent so a boot re-finalize does not double-emit). Placed here so it
    // fires for BOTH the exit-0 and non-zero-exit analysis paths (a failed run still
    // consumed compute); a boot re-finalize passes `PeakMetrics::default()` → a
    // zero-metric row, but `ON CONFLICT (job_id) DO NOTHING` keeps the first writer.
    super::seams::compute_meter()
        .record_usage(job, super::seams::ComputeUsage::from_peak(peak, exit_code))
        .await;

    // Ingest happens BEFORE cleanup, so the disposition below can ask whether the
    // bytes were actually cataloged.
    //
    // ITEM-17's two in-process cleanup paths meet here: cleanup-after-ingest-on-
    // success, and cleanup-immediately-on-error for a run that produced nothing
    // ingestable (a non-zero exit — its staging goes now rather than waiting for the
    // next boot sweep). An invalid manifest is NOT that case and is preserved; see
    // `run_dirs_disposition`, which BOTH this path and the boot re-finalize consult.
    // The third path, for a crash that reaches neither, is
    // `scheduler::sweep_stale_run_dirs`.
    //
    // `result.is_ok()` IS "the outputs were cataloged": every other arm above —
    // non-zero exit, invalid manifest, failed ingest — returns Err, and the Ok arm
    // is reached only after `ingest_outputs` succeeded.
    match run_dirs_disposition(exit_code == 0, result.is_ok()) {
        RunDirs::Reclaim => {
            if let Err(e) = tokio::fs::remove_dir_all(workspace_root).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(job_id = %job.id, error = %e, "analysis workspace cleanup failed");
                }
            }
            crate::modules::sandbox::outputs::discard_staging(staging_dir).await;
        }
        // Kept for inspection/retry; the next boot's sweep reclaims them (C2). The
        // WORKSPACE is kept with the staging: a boot re-finalize also re-records
        // provenance, which hashes `<workspace_root>/code/entry.*`.
        RunDirs::Preserve => {
            tracing::warn!(
                job_id = %job.id,
                workspace = %workspace_root.display(),
                staging = %staging_dir.display(),
                "analysis finalize failed after a successful run; both run dirs preserved \
                 for inspection (reclaimed by the next boot sweep)"
            );
        }
    }
    result
}

// ───────────────────────────── in-pod one-shot execution ────────────────────

/// The IN-POD one-shot job executor (ITEM-3/5 / #66) — the body of `cytoanalyst run-job`.
///
/// Runs the COMPLETE data-plane pipeline for a single, already-claimed job, IN THE POD, by
/// reusing the unchanged local path: stage (materialize inputs from the object store into the
/// pod's workspace) + launch bwrap (`spawn_local`), drive the child to exit (forwarding its
/// output to this process's stdout so the control-plane pod-log stream sees it, and enforcing
/// the resolved wall-clock), then `finalize_analysis` (ingest outputs → object store + catalog +
/// provenance + meters). It writes NO job-status row — the control-plane executor reflects THIS
/// process's exit code into the job status.
///
/// Returns the process exit code: `0` iff the analysis exited 0 AND finalize cataloged the
/// outputs; non-zero on ANY failure (a staging/input-fetch failure, a non-zero analysis exit, or
/// an ingest failure). This is the data-integrity contract (INV-3): an input fetch that fails
/// FAILS the job (the pod never runs on empty inputs), and outputs are durably cataloged BEFORE
/// this returns 0.
pub async fn execute_job_in_pod(
    job: &Job,
    pool: PgPool,
    registry: Arc<crate::modules::sandbox::backend::local_bwrap::BackendRegistry>,
) -> Result<i32, String> {
    let runner = SandboxJobRunner::new(pool, registry);

    // Stage + launch the local bwrap child. A staging/materialize failure here means the inputs
    // could not be fetched — we FAIL (return non-zero), never run on empty inputs (INV-3).
    let mut spawned = match runner.spawn_local(job).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("run-job: staging failed (inputs not fetched): {e}");
            return Ok(1);
        }
    };

    let _guards = spawned.guards.take();
    let workspace = spawned.workspace.take();
    let staging = spawned.outputs_staging.take();
    let timeout_secs = spawned.timeout_secs;

    // Forward the analysis child's stdout/stderr to THIS process's stdout/stderr so `kubectl
    // logs` (→ the control-plane pod-log stream → the job SSE) sees the run's output.
    let mut forwards = Vec::new();
    if let Some(out) = spawned.child.stdout.take() {
        forwards.push(tokio::spawn(forward_lines(out, false)));
    }
    if let Some(err) = spawned.child.stderr.take() {
        forwards.push(tokio::spawn(forward_lines(err, true)));
    }

    let exit = drive_child_to_exit(&mut spawned.child, timeout_secs).await;
    // The child (and its pid-ns children) have exited, so both pipes hit EOF and the forwarders
    // finish on their own — await them plainly (no timeout to leak a detached task; FIX-2).
    for f in forwards {
        let _ = f.await;
    }

    // Finalize: parse /outputs, ingest to the object store + catalog, record provenance + meters.
    // A remote SpawnedJob always carries both dirs on the in-pod (local) path; if somehow absent,
    // there is nothing to finalize and the raw exit stands.
    let (ws, stg) = match (workspace, staging) {
        (Some(w), Some(s)) => (w, s),
        _ => return Ok(exit),
    };
    match finalize_analysis(job, exit, &ws, &stg, PeakMetrics::default()).await {
        // Outputs are cataloged (durably uploaded) — success (INV-3 ingest-before-success).
        Ok(()) => Ok(0),
        Err(reason) => {
            eprintln!("run-job: finalize failed: {reason}");
            // Preserve a non-zero analysis exit; otherwise surface the finalize failure as 1.
            Ok(if exit != 0 { exit } else { 1 })
        }
    }
}

/// Copy a child pipe line-by-line to this process's stdout (`is_err=false`) or stderr
/// (`is_err=true`), so the in-pod analysis output reaches `kubectl logs`.
async fn forward_lines<R>(reader: R, is_err: bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if is_err {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    }
}

/// Wait for the analysis child to exit, enforcing the resolved wall-clock budget (a low-CPU
/// blocking script never trips RLIMIT_CPU, so a wall-clock kill is the backstop). On timeout the
/// child is killed and `124` is returned (the conventional timeout code). An unknown exit → `1`.
async fn drive_child_to_exit(child: &mut tokio::process::Child, timeout_secs: Option<u64>) -> i32 {
    let wait = child.wait();
    let status = match timeout_secs {
        Some(secs) if secs > 0 => {
            match tokio::time::timeout(std::time::Duration::from_secs(secs), wait).await {
                Ok(s) => s,
                Err(_) => {
                    eprintln!("run-job: analysis exceeded the {secs}s wall-clock budget — killing");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return 124;
                }
            }
        }
        _ => wait.await,
    };
    match status {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => {
            eprintln!("run-job: waiting on the analysis child failed: {e}");
            1
        }
    }
}

/// Number of ~1s steps the stub runs. Read from `params.steps` (default 5,
/// clamped) so callers/tests can make jobs short.
fn stub_steps(job: &Job) -> i64 {
    job.params
        .get("steps")
        .and_then(|v| v.as_i64())
        .unwrap_or(5)
        .clamp(1, 120)
}

/// Build the stub child command (a bounded loop echoing progress + burning a
/// little in-shell CPU so the per-pid sampler reads real usage).
#[cfg(unix)]
pub fn stub_command(job: &Job) -> (String, Vec<String>) {
    let name = job.name.replace(['"', '`', '$', '\\'], "");
    let steps = stub_steps(job);
    let script = format!(
        "i=0; while [ $i -lt {steps} ]; do i=$((i+1)); \
         echo \"[{name}] step $i/{steps}\"; \
         j=0; while [ $j -lt 80000 ]; do j=$((j+1)); done; \
         sleep 1; done; echo \"[{name}] done\"",
    );
    ("sh".to_string(), vec!["-c".to_string(), script])
}

/// Windows stub (cfg-gated; primary verification is Linux — the real runner is
/// the Linux-based sandbox).
#[cfg(windows)]
pub fn stub_command(job: &Job) -> (String, Vec<String>) {
    let name = job.name.replace(['"', '%', '&', '|', '<', '>'], "");
    let steps = stub_steps(job);
    let script = format!(
        "for /L %i in (1,1,{steps}) do (echo [{name}] step %i/{steps} & ping -n 2 127.0.0.1 >nul)",
    );
    ("cmd".to_string(), vec!["/C".to_string(), script])
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;

    fn job() -> Job {
        Job {
            id: Uuid::nil(),
            owner_id: Uuid::nil(),
            job_type: "stub".into(),
            name: "demo".into(),
            status: "queued".into(),
            params: serde_json::json!({}),
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            error: None,
            pid: None,
            priority_class: "normal".into(),
            resource_class: "cpu-sandbox".into(),
            req_cpu: None,
            req_mem_bytes: None,
            run_id: None,
        }
    }

    /// The complete decision table of [`run_dirs_disposition`] — the rule BOTH the
    /// live finalize and the boot re-finalize consult.
    ///
    /// The row that matters is `(succeeded, !cataloged) → Preserve`: that is the
    /// rejected-declaration case the live path used to Reclaim while the boot path
    /// Preserved. The two Reclaim rows are its negative controls — a "fix" that
    /// preserved unconditionally would leak a staging tree for every crashed run
    /// AND for every successful one, and fails here.
    #[test]
    fn run_dirs_are_preserved_only_for_uncataloged_work_that_succeeded() {
        // The child SUCCEEDED and the server did not catalog its bytes (no/invalid
        // manifest, a rejected declaration, or a failed ingest) — they are the sole
        // copy of completed work.
        assert_eq!(run_dirs_disposition(true, false), RunDirs::Preserve);

        // Cataloged: the catalog holds the bytes, so the staging copy is redundant.
        assert_eq!(run_dirs_disposition(true, true), RunDirs::Reclaim);

        // The run itself failed: its dirs are scratch, not a work product, and
        // keeping them is the unbounded-disk case with nothing to inspect.
        assert_eq!(run_dirs_disposition(false, false), RunDirs::Reclaim);
        // Degenerate (a failed child cannot have been cataloged) — pinned so the
        // rule stays total rather than accidentally depending on an unreachable arm.
        assert_eq!(run_dirs_disposition(false, true), RunDirs::Reclaim);
    }

    // TEST-2 (partial): stub command builder shape + injection-safety.
    #[test]
    fn stub_command_shape() {
        let (program, args) = stub_command(&job());
        #[cfg(unix)]
        {
            assert_eq!(program, "sh");
            assert_eq!(args[0], "-c");
            assert!(args[1].contains("step $i/5"), "{}", args[1]);
            assert!(args[1].contains("[demo]"));
            assert!(args[1].contains("i -lt 5"), "{}", args[1]);
        }
        #[cfg(windows)]
        {
            assert_eq!(program, "cmd");
            assert_eq!(args[0], "/C");
        }
        let _ = program;
    }

    #[test]
    #[cfg(unix)]
    fn stub_command_strips_shell_metacharacters() {
        let mut j = job();
        j.name = "a\"; rm -rf / #`$x\\".into();
        let (_p, args) = stub_command(&j);
        let script = &args[1];
        assert!(!script.contains('`'), "backtick leaked: {script}");
        assert!(!script.contains('\\'), "backslash leaked: {script}");
        assert!(
            script.contains("[a; rm -rf / #x]"),
            "sanitized name: {script}"
        );
    }

    // A fake runner that records it was called (for the dispatch routing test).
    struct RecordingRunner {
        label: &'static str,
        seen: Arc<std::sync::Mutex<Vec<&'static str>>>,
    }
    #[async_trait]
    impl JobRunner for RecordingRunner {
        async fn spawn(&self, _job: &Job) -> Result<SpawnedJob, String> {
            self.seen.lock().unwrap().push(self.label);
            // Return a real (immediately-exiting) child so the type is satisfied.
            let child = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(SpawnedJob::bare(child))
        }
    }

    // TEST-15: DispatchRunner routes analysis→sandbox, everything else→stub.
    #[tokio::test]
    async fn dispatch_routes_on_job_type() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let stub = Arc::new(RecordingRunner {
            label: "stub",
            seen: seen.clone(),
        });
        let analysis = Arc::new(RecordingRunner {
            label: "analysis",
            seen: seen.clone(),
        });
        let dispatch = DispatchRunner::new(stub, analysis);

        let mut j = job();
        j.job_type = "analysis".into();
        dispatch.spawn(&j).await.unwrap();
        j.job_type = "stub".into();
        dispatch.spawn(&j).await.unwrap();
        j.job_type = "something-else".into();
        dispatch.spawn(&j).await.unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            vec!["analysis", "stub", "stub"],
            "unknown → stub"
        );
    }

    // TEST-23: precheck returns a CLEAR error when the backend is unavailable
    // (the non-Linux / no-sandbox degrade), so the executor fails the job.
    #[test]
    fn precheck_backend_reports_unavailable_clearly() {
        use crate::modules::sandbox::backend::{ComputeSpec, LaunchedCompute};
        struct DownBackend;
        #[async_trait]
        impl ComputeBackend for DownBackend {
            async fn launch(
                &self,
                _s: ComputeSpec,
                _k: Arc<dyn ProgressSink>,
            ) -> Result<LaunchedCompute, ziee_core::AppError> {
                unreachable!()
            }
            fn probe(&self) -> BackendAvailability {
                BackendAvailability::Unavailable("no bwrap".into())
            }
            fn supports(&self, class: ResourceClass) -> bool {
                matches!(class, ResourceClass::CpuSandbox)
            }
        }
        let err = precheck_backend(&DownBackend, ResourceClass::CpuSandbox).unwrap_err();
        assert!(err.contains("unavailable"), "clear reason: {err}");
        assert!(
            err.contains("no bwrap"),
            "carries the backend reason: {err}"
        );

        // Unsupported class → also a clear error.
        let err2 = precheck_backend(&DownBackend, ResourceClass::Gpu).unwrap_err();
        assert!(err2.contains("does not support"), "{err2}");
    }

    // ITEM-5c + FIX-3: build_reference_mounts validates the declared extra_mounts
    // against the deployment allowlist (lexical + symlink-resolving) + converts to
    // RO binds of the CANONICAL host path; a non-allowlisted / symlink-escaping host
    // path fails the job; no extra_mounts → empty. Canonicalization touches the
    // filesystem, so this uses real temp dirs.
    #[test]
    #[cfg(unix)]
    fn build_reference_mounts_allowlist_and_convert() {
        use crate::modules::sandbox::spec::AnalysisSpec;
        use crate::modules::sandbox::types::MountMode;

        // A real allowlisted root with a real reference dir under it, and a secret
        // dir OUTSIDE the allowlist that a symlink will try to reach.
        let base = std::env::temp_dir().join(format!("cyto-refmnt-{}", uuid::Uuid::new_v4()));
        let refs_root = base.join("refs");
        let secret = base.join("secret");
        std::fs::create_dir_all(refs_root.join("GRCh38")).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        let refs_root_s = refs_root.to_str().unwrap();
        let grch38 = refs_root.join("GRCh38");

        let spec = AnalysisSpec::parse(&serde_json::json!({
            "language": "bash",
            "script": "echo ok > /outputs/manifest.json",
            "extra_mounts": [{ "host_path": grch38.to_str().unwrap(), "sandbox_path": "/refs/GRCh38" }],
        }))
        .expect("spec parses");

        // Allowlisted root → one RO reference mount bound at the CANONICAL host path.
        let mounts =
            build_reference_mounts(&spec, &[PathBuf::from(refs_root_s)]).expect("allowlisted ok");
        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].sandbox_path, "/refs/GRCh38");
        assert_eq!(mounts[0].mode, MountMode::ReadOnly);
        assert_eq!(mounts[0].host_path, std::fs::canonicalize(&grch38).unwrap());

        // Disjoint / empty allowlist → error (the job fails; no unvetted bind).
        assert!(build_reference_mounts(&spec, &[base.join("other")]).is_err());
        assert!(build_reference_mounts(&spec, &[]).is_err());

        // FIX-3: a SYMLINK under the allowlisted root pointing OUTSIDE it passes the
        // lexical prefix-check but is refused by the canonical resolution.
        let evil = refs_root.join("evil");
        std::os::unix::fs::symlink(&secret, &evil).unwrap();
        let escaping = AnalysisSpec::parse(&serde_json::json!({
            "language": "bash",
            "script": "echo ok > /outputs/manifest.json",
            "extra_mounts": [{ "host_path": evil.to_str().unwrap(), "sandbox_path": "/refs/x" }],
        }))
        .expect("spec parses");
        assert!(
            build_reference_mounts(&escaping, &[PathBuf::from(refs_root_s)]).is_err(),
            "a symlink escaping the allowlist is refused (canonical containment)"
        );

        // No extra_mounts → empty vec regardless of the allowlist (normal run).
        let bare = AnalysisSpec::parse(&serde_json::json!({
            "language": "python", "script": "print(1)"
        }))
        .unwrap();
        assert!(build_reference_mounts(&bare, &[])
            .expect("no mounts ok")
            .is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    // TEST-16: SpawnedJob carries guards + workspace; the stub sets both None; a
    // guard's Drop runs (drop-flag) after we free the SpawnedJob.
    #[tokio::test]
    async fn spawned_job_guards_and_workspace() {
        use std::sync::atomic::{AtomicBool, Ordering};
        static DROPPED: AtomicBool = AtomicBool::new(false);
        struct DropFlag;
        impl Drop for DropFlag {
            fn drop(&mut self) {
                DROPPED.store(true, Ordering::SeqCst);
            }
        }
        let spawn_true = || {
            tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        };

        let sj = SpawnedJob {
            child: spawn_true(),
            guards: Some(Box::new(DropFlag)),
            workspace: Some(PathBuf::from("/ws/123")),
            outputs_staging: Some(PathBuf::from("/staging/123")),
            cgroup_path: None,
            timeout_secs: None,
        };
        assert!(sj.workspace.is_some() && sj.guards.is_some());
        // TEST-23 (carrier leg, ITEM-17): the executor is handed TWO dirs, and the
        // staging one is not inside the workspace — a `SpawnedJob` that re-derived
        // it from the workspace could not satisfy this.
        let ws = sj.workspace.clone().unwrap();
        let staging = sj.outputs_staging.clone();
        let staging = staging.expect("the run carries a staging dir");
        assert!(
            !staging.starts_with(&ws),
            "staging is outside the workspace"
        );
        assert!(!DROPPED.load(Ordering::SeqCst), "guard not yet dropped");
        drop(sj);
        assert!(
            DROPPED.load(Ordering::SeqCst),
            "guard dropped when SpawnedJob freed"
        );

        // The stub path sets all three None.
        let stub_sj = StubJobRunner.spawn(&job()).await.unwrap();
        assert!(
            stub_sj.guards.is_none()
                && stub_sj.workspace.is_none()
                && stub_sj.outputs_staging.is_none()
        );
    }

    // S7: a DECLARED host resource binds the operator-configured, allowlisted host
    // path RO at the DECLARED mount path — and REFUSES (clear error) when
    // unconfigured (never binds an unvetted path, never emulates a missing
    // resource). Nothing here names a genome: the requirement is `{name, mount_path}`
    // DATA from a package manifest.
    #[test]
    fn a_declared_host_resource_refuses_without_config_and_binds_when_allowlisted() {
        use crate::modules::extensions::types::HostResourceRequirement;
        use crate::modules::sandbox::types::MountMode;

        let req = HostResourceRequirement {
            name: "reference".to_string(),
            mount_path: "/refdata".to_string(),
        };
        // Unconfigured → a clear refusal naming the resource AND its config var.
        std::env::remove_var("CYTO_SANDBOX_REFERENCE_ROOT");
        std::env::remove_var("CYTO_SANDBOX_RESOURCE_REFERENCE");
        let err = host_resource_mount(&req, &[]).expect_err("refused without a host path");
        assert!(
            err.contains("CYTO_SANDBOX_RESOURCE_REFERENCE"),
            "names the config: {err}"
        );
        assert!(
            err.contains("reference"),
            "names the declared resource: {err}"
        );

        // Configured + allowlisted → an RO bind of the canonical host path at the
        // DECLARED mount path.
        let tmp = std::env::temp_dir().join(format!("cyto-res-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("CYTO_SANDBOX_RESOURCE_REFERENCE", &tmp);
        let mount =
            host_resource_mount(&req, std::slice::from_ref(&tmp)).expect("resource mount built");
        assert_eq!(mount.sandbox_path, "/refdata", "bound at the DECLARED path");
        assert!(matches!(mount.mode, MountMode::ReadOnly), "read-only");

        // A configured-but-NOT-allowlisted root is refused (no unvetted bind).
        assert!(
            host_resource_mount(&req, &[]).is_err(),
            "unallowlisted root refused"
        );
        std::env::remove_var("CYTO_SANDBOX_RESOURCE_REFERENCE");

        // A resource with ANOTHER name mounts somewhere else entirely — the point of
        // the finding: the server understands no specific resource.
        let other = HostResourceRequirement {
            name: "plate-layouts".to_string(),
            mount_path: "/layouts".to_string(),
        };
        assert_eq!(
            host_resource_env_var(&other.name).unwrap(),
            "CYTO_SANDBOX_RESOURCE_PLATE_LAYOUTS",
            "`-` becomes `_`, uppercased"
        );
        std::env::set_var("CYTO_SANDBOX_RESOURCE_PLATE_LAYOUTS", &tmp);
        let m2 = host_resource_mount(&other, std::slice::from_ref(&tmp)).expect("built");
        assert_eq!(m2.sandbox_path, "/layouts");
        std::env::remove_var("CYTO_SANDBOX_RESOURCE_PLATE_LAYOUTS");

        // BACK-COMPAT: the legacy env var still serves the resource named `reference`,
        // so an existing deployment keeps working with no operator edit.
        std::env::set_var("CYTO_SANDBOX_REFERENCE_ROOT", &tmp);
        assert!(
            host_resource_mount(&req, std::slice::from_ref(&tmp)).is_ok(),
            "the legacy CYTO_SANDBOX_REFERENCE_ROOT is honored as an alias"
        );
        // …and ONLY for that name.
        assert!(host_resource_mount(&other, std::slice::from_ref(&tmp)).is_err());
        std::env::remove_var("CYTO_SANDBOX_REFERENCE_ROOT");

        std::fs::remove_dir_all(&tmp).ok();
    }

    // S7: a manifest is contributor-authored, so a declared `mount_path` is a real
    // boundary — it must be absolute, escape-free, and must not shadow a path the
    // runner owns.
    #[test]
    fn a_declared_mount_path_cannot_escape_or_shadow_the_runner_dirs() {
        for bad in [
            "",
            "refdata",
            "../etc",
            "/code/../etc",
            "/",
            "/code",
            "/inputs",
            "/outputs",
            "/home",
        ] {
            assert!(validate_mount_path(bad).is_err(), "{bad:?} must be refused");
        }
        for ok in ["/refdata", "/opt/ref", "/layouts"] {
            assert!(
                validate_mount_path(ok).is_ok(),
                "{ok:?} is a fine mount path"
            );
        }
        // A hostile resource NAME can never reach outside the env namespace.
        for bad in ["", "  ", "a b", "a/b", "a$b", "a;b"] {
            assert!(
                host_resource_env_var(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    /// **PROV-E1-2, the runner hop** — both `ComputeSpec` constructions in this file
    /// thread the job's declared env, rather than dropping it.
    ///
    /// **This is a STRUCTURAL guard, and it is weaker than a behavioural one — stated
    /// plainly rather than dressed up.** The behavioural test would drive
    /// `stage_and_launch` / `launch_remote` with a recording backend and assert the
    /// `ComputeSpec` handed over; both are private `async fn`s on a runner that owns a
    /// `PgPool` and does real filesystem staging, so exercising them needs the
    /// integration harness plus a fake `ComputeBackend`, which is a larger piece of test
    /// scaffolding than this branch should introduce into a shared runner.
    ///
    /// What makes the structural form defensible HERE, where the lifecycle rules
    /// otherwise warn against pattern-matching guards: the evasion space is two literal
    /// sites in one file, and the compiler already forces `env_id` to be set at BOTH of
    /// them (`ComputeSpec` has no `Default`, so omitting the field is E0063). The only
    /// reachable regression is therefore setting it to something OTHER than the job's
    /// env, which is exactly what this reads. A blind audit found this hop untested and
    /// a mutation confirmed the gap was real: replacing both with `env_id: None` left the
    /// whole suite green.
    /// Lifecycle id: **TEST-35** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn both_compute_spec_constructions_thread_the_jobs_declared_env() {
        // Scan PRODUCTION source only. A guard that greps its own file counts the
        // literals in its own assertions — self-reference, and it fired immediately when
        // this was first written (3 sites, not 2). Cutting at the `#[cfg(test)]` marker
        // is the same structural exclusion `check-derived-vocabulary.sh` uses.
        let whole = include_str!("runner.rs");
        let src = whole
            .split_once("\n#[cfg(test)]\n")
            .map(|(prod, _)| prod)
            .unwrap_or(whole);
        // Count the CONSTRUCTIONS, so a third site added later is covered rather than
        // silently unguarded — the enumeration failure mode this repo has been bitten by.
        // Match the TYPE, not a binding name: `let cs = ComputeSpec {` or one built
        // inline would have left `constructions == 2` and passed unguarded, which is
        // exactly the "a third site is covered" claim this comment makes.
        let constructions = src.matches("ComputeSpec {").count();
        assert_eq!(
            constructions, 2,
            "this file builds {constructions} ComputeSpec(s); the assertion below is \
             written for the local + remote pair. A new construction site must thread \
             `spec.env` too — update this guard deliberately rather than loosening it"
        );
        let threaded = src.matches("env_id: spec.env.clone(),").count();
        assert_eq!(
            threaded, constructions,
            "every ComputeSpec construction must set `env_id: spec.env.clone()`; {threaded} \
             of {constructions} do. Dropping it is invisible at runtime — the job simply \
             runs in the deployment default image and reports success, which is the exact \
             failure PROV-E1-2 exists to close"
        );
    }
}
