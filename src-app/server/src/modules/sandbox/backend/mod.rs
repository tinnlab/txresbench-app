//! The sandbox progress vocabulary + scheduling classes (the kept half of the
//! former `ComputeBackend` topology seam).
//!
//! strip-single-cell ITEM-3 (map §1 `sandbox` KEEP (trim)): the single-cell
//! compute-backend seam — [`ComputeBackend`]/[`ComputeSpec`]/[`LaunchedCompute`]
//! and the `local_bwrap` backend — was removed with the processor pipeline
//! (`jobs::runner`, `sandbox::spec`, `sandbox::inputs`). What stays is what the
//! kept method-stack path and the jobs module use:
//!
//! - [`ProgressFrame`]/[`MilestoneFrame`]/[`ProgressSink`] — the live
//!   progress/milestone sink the execution-engine's `StackSink` adaptor and
//!   the stacked run seam forward through;
//! - [`PriorityClass`]/[`ResourceClass`] — the text-stored scheduling
//!   vocabulary on the `jobs` row (re-exported by `jobs::models`), which the
//!   engine's admitted rows still carry at their defaults.

use schemars::JsonSchema;

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

/// The concrete per-sandbox caps + wall-clock, ALREADY clamped to the admin
/// ceiling (`sandbox_settings`) by `settings::resolve_caps`. `cpu_max` is
/// bwrap/cgroup's `"<quota> <period>"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceProfile {
    pub memory_max_bytes: i64,
    pub memory_swap_max_bytes: i64,
    pub pids_max: i64,
    pub cpu_max: String,
    pub timeout_secs: u64,
}

// ───────────────────────────── progress sink ────────────────────────────────

/// One structured progress frame drained from the in-sandbox progress FIFO
/// (ITEM-5), surfaced on the run's progress sink as a `progress` frame.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonSchema)]
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
/// rather than in runtime internals.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonSchema)]
pub struct MilestoneFrame {
    pub id: String,
    /// One of `started|done|failed`.
    pub status: String,
    /// Structured, data-determined finding the script emitted; `Null` when absent.
    #[serde(default)]
    pub detail: serde_json::Value,
}

/// Where drained progress frames go (the method-run seam supplies the run's own
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
