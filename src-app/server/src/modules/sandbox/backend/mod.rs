//! The `ComputeBackend` topology seam (P3 §4.1.2 / DEC-D).
//!
//! Distinct from `jobs::runner::JobRunner` (the queue's spawn contract):
//! `ComputeBackend` is *where* compute runs. `SandboxJobRunner` implements
//! `JobRunner` and delegates to a `dyn ComputeBackend` (`LocalBwrapBackend`), so
//! "run elsewhere" (GPU / remote worker / HPC) is a backend swap behind this ONE
//! seam, never a queue rewrite. Only the local bwrap arm is built this round; the
//! other `ResourceClass` variants are typed-unavailable.
//!
//! `ComputeSpec` is path-agnostic — the analysis script never learns where it
//! runs (the same materialized-inputs / `/outputs` contract a remote backend
//! would fetch through).

use std::path::PathBuf;

use async_trait::async_trait;
use uuid::Uuid;
use ziee_core::AppError;

use super::types::ExtraMount;

pub mod local_bwrap;

// ───────────────────────────── scheduling vocabularies ──────────────────────

/// Scheduling priority class (text-stored on `jobs.priority_class`). Governs
/// admission (reserved interactive slots) + fair-share weight — NOT resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PriorityClass {
    Interactive,
    Normal,
    Batch,
}

impl PriorityClass {
    pub fn as_str(self) -> &'static str {
        match self {
            PriorityClass::Interactive => "interactive",
            PriorityClass::Normal => "normal",
            PriorityClass::Batch => "batch",
        }
    }

    /// Parse a stored/wire value; unknown → `None` (callers clamp to `Normal`).
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "interactive" => PriorityClass::Interactive,
            "normal" => PriorityClass::Normal,
            "batch" => PriorityClass::Batch,
            _ => return None,
        })
    }

    /// Clamp an arbitrary string to a class (unknown → `Normal`), the server-side
    /// safety net for a client/extension-supplied value.
    pub fn clamped(s: &str) -> Self {
        Self::from_str(s).unwrap_or(PriorityClass::Normal)
    }

    /// Higher = scheduled first. Used by the fair-share claim ordering.
    pub fn weight(self) -> i32 {
        match self {
            PriorityClass::Interactive => 2,
            PriorityClass::Normal => 1,
            PriorityClass::Batch => 0,
        }
    }
}

/// The resource topology a job needs (text-stored on `jobs.resource_class`).
/// Only `CpuSandbox` is implemented; the rest are future rows behind the seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceClass {
    CpuSandbox,
    Gpu,
    Highmem,
    ClusterBatch,
}

impl ResourceClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ResourceClass::CpuSandbox => "cpu-sandbox",
            ResourceClass::Gpu => "gpu",
            ResourceClass::Highmem => "highmem",
            ResourceClass::ClusterBatch => "cluster-batch",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "cpu-sandbox" => ResourceClass::CpuSandbox,
            "gpu" => ResourceClass::Gpu,
            "highmem" => ResourceClass::Highmem,
            "cluster-batch" => ResourceClass::ClusterBatch,
            _ => return None,
        })
    }

    /// Clamp to a known class (unknown → the default `CpuSandbox`).
    pub fn clamped(s: &str) -> Self {
        Self::from_str(s).unwrap_or(ResourceClass::CpuSandbox)
    }
}

// ───────────────────────────── resource profile ─────────────────────────────

/// The concrete per-job cgroup caps + wall-clock a backend enforces, ALREADY
/// clamped to the admin ceiling (`sandbox_settings`) by
/// `settings::resolve_caps`. `cpu_max` is bwrap/cgroup's `"<quota> <period>"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceProfile {
    pub memory_max_bytes: i64,
    pub memory_swap_max_bytes: i64,
    pub pids_max: i64,
    pub cpu_max: String,
    pub timeout_secs: u64,
}

// ───────────────────────────── compute spec ─────────────────────────────────

/// A path-agnostic, materialized compute request the backend launches. Built by
/// `SandboxJobRunner::build_compute_spec` from the wire `AnalysisSpec`
/// (`spec.rs`) + materialized inputs (`inputs.rs`).
pub struct ComputeSpec {
    /// The owning job's id (→ cgroup scope name, provenance line-up — DEC-G).
    pub job_id: Uuid,
    /// The per-job workspace ROOT (holds `home/`, `inputs/`, `code/`). Bound:
    /// `home/`→`/home/analyst` RW. Run SCRATCH — reclaimed with the run.
    pub workspace_root: PathBuf,
    /// The host dir bound READ-WRITE at `/outputs` (ITEM-17). It lives under the
    /// run's OUTPUT STAGING dir, which is NOT under `workspace_root` — outputs
    /// outlive the workspace, because ingest consumes them after the child exits.
    /// Carried as its own field rather than derived from `workspace_root`, so a
    /// backend cannot re-couple the two by joining a subdirectory name.
    pub outputs_dir: PathBuf,
    /// The bash command run inside the sandbox (e.g. `python3 /code/entry.py`).
    pub command: String,
    /// Read-only input binds (materialized content-addressed blobs / host paths).
    pub input_mounts: Vec<ExtraMount>,
    /// Read-only `/code/entry.<ext>` bind (the staged entry script).
    pub code_mount: Option<ExtraMount>,
    /// Read-only **reference** mounts (ITEM-5c / DEC-11): admin-allowlisted host
    /// paths (e.g. a Cell Ranger transcriptome at `/refs/…`) the queued runner
    /// validated (`AnalysisSpec::validate_extra_mounts_allowed`) + converted
    /// (`ExtraMountDecl::to_ro_mount`) BEFORE building the spec. `assemble_mounts`
    /// appends them after `/outputs` + `/code` (they can't shadow a managed root).
    /// Empty for a normal run.
    pub extra_mounts: Vec<ExtraMount>,
    /// Resolved + clamped per-job caps.
    pub profile: ResourceProfile,
    pub priority: PriorityClass,
    pub resource_class: ResourceClass,
    /// The env image THIS job runs inside (#189), threaded from the declaring
    /// analysis/converter contribution via `AnalysisSpec::env`.
    ///
    /// `None` ⇒ the backend resolves the deployment default
    /// (`env_image::default_env_id`), which is what every job did before per-job
    /// selection existed — so an env-less job is byte-identical to today (INV-1).
    ///
    /// This field is what makes per-job selection POSSIBLE at all: before it, the
    /// backends were handed a `ComputeSpec` carrying no env and had no choice but to
    /// resolve one process-wide, so a declared env could not have reached the run even
    /// if every other layer had carried it.
    pub env_id: Option<String>,
}

/// A launched compute: the live child the executor drives + the opaque guards
/// (cgroup scope + seccomp pipe + workspace + progress-drain handle) whose Drop
/// must outlive the child, + the cgroup scope PATH (so the executor's sampler can
/// read whole-subtree metrics by path while the guards still own the scope).
pub struct LaunchedCompute {
    pub child: tokio::process::Child,
    pub guards: Box<dyn Send + 'static>,
    /// The cgroup-v2 scope dir, if one was created (metrics read-back path).
    pub cgroup_path: Option<PathBuf>,
}

/// Whether a backend can serve right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendAvailability {
    Available,
    Unavailable(String),
}

// ───────────────────────────── progress sink ────────────────────────────────

/// One structured progress frame drained from the in-sandbox progress FIFO
/// (ITEM-5), surfaced on the job SSE as a `progress` frame.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ProgressFrame {
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pct: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One end-user-facing MILESTONE transition drained from the in-sandbox progress
/// FIFO (ITEM-24 / DEC-25): a manifest-declared step `id`, its `status`
/// (`started|done|failed`), and an optional structured `detail` payload the script
/// emits as it inspects the data (e.g. `{rows, columns}`, `{count: 3, names: […]}`).
/// Distinct from the fine `ProgressFrame` %: this is the "what step" checklist the
/// person WATCHING the run sees, in the manifest's own declared step vocabulary
/// rather than in runtime internals. Surfaced on the job SSE as a `milestone` frame
/// and persisted to `job_milestones`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct MilestoneFrame {
    pub id: String,
    /// One of `started|done|failed`.
    pub status: String,
    /// Structured, data-determined finding the script emitted; `Null` when absent.
    #[serde(default)]
    pub detail: serde_json::Value,
}

/// Where drained progress frames go (the jobs executor supplies an SSE-broadcast
/// sink; tests supply a capturing one).
pub trait ProgressSink: Send + Sync {
    fn progress(&self, frame: ProgressFrame);

    /// An end-user-facing milestone transition (ITEM-24). Default no-op so existing
    /// sinks that only care about fine progress keep compiling unchanged.
    fn milestone(&self, _frame: MilestoneFrame) {}
}

/// A progress sink that drops every frame (used where progress isn't wired).
pub struct NullProgressSink;
impl ProgressSink for NullProgressSink {
    fn progress(&self, _frame: ProgressFrame) {}
}

// ───────────────────────────── the seam ─────────────────────────────────────

/// A compute backend: launches a `ComputeSpec` and hands back the live child +
/// guards for the executor to drive. `probe`/`supports` gate selection.
#[async_trait]
pub trait ComputeBackend: Send + Sync {
    async fn launch(
        &self,
        spec: ComputeSpec,
        sink: std::sync::Arc<dyn ProgressSink>,
    ) -> Result<LaunchedCompute, AppError>;

    /// Runtime availability (bwrap present, rootfs mountable, …).
    fn probe(&self) -> BackendAvailability;

    /// Whether this backend serves a given resource class.
    fn supports(&self, class: ResourceClass) -> bool;

    /// Whether this backend stages inputs + collects outputs REMOTELY (in the compute
    /// pod), rather than expecting the control-plane runner to materialize inputs into a
    /// local workspace and finalize a local `/outputs` staging dir.
    ///
    /// `false` (the default) is the in-process contract: the `SandboxJobRunner` fetches the
    /// content-addressed inputs from the object store into a LOCAL workspace and the executor
    /// ingests a LOCAL `/outputs` staging dir after the child exits (the `LocalBwrapBackend`
    /// path — and the worker-pod topology, where the worker IS the local process).
    ///
    /// `true` (the `KubernetesBackend` job-per-run fallback) means the DATA plane lives in the
    /// pod: the pod re-fetches the inputs from the object store and pushes the outputs back
    /// itself (via the in-pod `cytoanalyst run-job` entrypoint, which reuses the SAME
    /// `materialize_inputs` + `finalize_analysis`). The control-plane runner must therefore NOT
    /// waste-materialize inputs locally for such a job, and must return a `SpawnedJob` with no
    /// local workspace/staging so the executor skips its local finalize (the pod owns it).
    fn stages_inputs_remotely(&self) -> bool {
        false
    }
}

/// The typed error a not-yet-built backend / class returns.
pub fn backend_unavailable(detail: impl Into<String>) -> AppError {
    AppError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "BACKEND_UNAVAILABLE",
        detail.into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1: PriorityClass + ResourceClass serde round-trip + from_str defaults.
    #[test]
    fn priority_class_roundtrips_snake_case() {
        for (v, s) in [
            (PriorityClass::Interactive, "\"interactive\""),
            (PriorityClass::Normal, "\"normal\""),
            (PriorityClass::Batch, "\"batch\""),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), s);
            assert_eq!(PriorityClass::from_str(v.as_str()), Some(v));
        }
        assert_eq!(PriorityClass::from_str("bogus"), None);
        assert_eq!(PriorityClass::clamped("bogus"), PriorityClass::Normal);
        // Interactive outranks normal outranks batch.
        assert!(PriorityClass::Interactive.weight() > PriorityClass::Normal.weight());
        assert!(PriorityClass::Normal.weight() > PriorityClass::Batch.weight());
    }

    // ITEM-5c wiring: a `ComputeSpec.extra_mounts` reaches `assemble_mounts` when
    // called as the streaming path now calls it (`assemble_mounts(spec,
    // &spec.extra_mounts)`) — the reference mount is appended RO, after /outputs.
    // (`streaming::run_analysis_streaming` makes exactly this call; this proves the
    // spec field is the channel, without needing a live bwrap.)
    #[test]
    fn compute_spec_extra_mounts_reach_assemble_mounts() {
        use super::local_bwrap::assemble_mounts;
        use crate::modules::sandbox::types::{ExtraMount, MountMode};
        use std::path::PathBuf;

        let ref_mount = ExtraMount {
            host_path: PathBuf::from("/srv/refs/GRCh38"),
            sandbox_path: "/refs/GRCh38".into(),
            mode: MountMode::ReadOnly,
        };
        let spec = ComputeSpec {
            job_id: Uuid::nil(),
            workspace_root: PathBuf::from("/ws"),
            outputs_dir: PathBuf::from("/staging/outputs"),
            command: "python3 /code/entry.py".into(),
            input_mounts: vec![],
            code_mount: None,
            extra_mounts: vec![ref_mount],
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
        };
        // The exact call streaming.rs makes after this slice's wiring.
        let mounts = assemble_mounts(&spec, &spec.extra_mounts);
        let refm = mounts
            .iter()
            .find(|m| m.sandbox_path == "/refs/GRCh38")
            .expect("the reference mount reaches assemble_mounts via ComputeSpec.extra_mounts");
        assert_eq!(refm.mode, MountMode::ReadOnly, "reference mounts are read-only");
        assert_eq!(refm.host_path, PathBuf::from("/srv/refs/GRCh38"));
        // Appended AFTER /outputs (can't shadow a hardening-managed root).
        let out_i = mounts.iter().position(|m| m.sandbox_path == "/outputs").unwrap();
        let ref_i = mounts.iter().position(|m| m.sandbox_path == "/refs/GRCh38").unwrap();
        assert!(ref_i > out_i, "reference mount appended after /outputs");
    }

    #[test]
    fn resource_class_roundtrips_kebab_case() {
        for (v, s) in [
            (ResourceClass::CpuSandbox, "\"cpu-sandbox\""),
            (ResourceClass::Gpu, "\"gpu\""),
            (ResourceClass::Highmem, "\"highmem\""),
            (ResourceClass::ClusterBatch, "\"cluster-batch\""),
        ] {
            assert_eq!(serde_json::to_string(&v).unwrap(), s);
            assert_eq!(ResourceClass::from_str(v.as_str()), Some(v));
        }
        assert_eq!(ResourceClass::from_str("bogus"), None);
        // Unknown clamps to the default cpu-sandbox.
        assert_eq!(ResourceClass::clamped("bogus"), ResourceClass::CpuSandbox);
    }
}
