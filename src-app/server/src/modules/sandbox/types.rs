//! Sandbox capability + context types.
//!
//! Ported from ziee `code_sandbox/types.rs`, collapsed to the Linux-only,
//! single-rootfs, companion-driven shape (no JSON-RPC envelope, no per-flavor
//! lock — DEC-2/DEC-3).

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Host-level capabilities probed once at boot (rootfs-independent).
#[derive(Debug, Clone)]
pub struct HostCapabilities {
    pub bwrap_path: PathBuf,
    pub cgroup: CgroupMode,
    pub seccomp: SeccompMode,
}

/// Full hardening capabilities — complete only after the rootfs is lazily
/// mounted (the `pid_namespace` probe needs the mounted rootfs).
#[derive(Debug, Clone)]
pub struct HardeningCapabilities {
    pub bwrap_path: PathBuf,
    pub pid_namespace: PidNsMode,
    pub cgroup: CgroupMode,
    pub seccomp: SeccompMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PidNsMode {
    /// `--unshare-pid --proc /proc` works (bare-metal Linux).
    Strict,
    /// PID-ns probe failed; fall back to `--dev-bind /proc /proc` (host PIDs
    /// visible inside the sandbox — info leak, no escape).
    DevBindFallback,
    /// Neither mode works. Sandbox is forced off.
    Disabled,
}

#[derive(Debug, Clone)]
pub enum CgroupMode {
    /// Delegated parent cgroup is writable; a per-call scope is created under it.
    Delegated(PathBuf),
    /// No cgroup write access. rlimits-only mode.
    None,
}

#[derive(Debug, Clone)]
pub enum SeccompMode {
    /// Filter compiled once at boot; piped to bwrap's `--seccomp <fd>` per call.
    Loaded(Arc<Vec<u8>>),
    /// The `sandbox_seccomp` cargo feature is not compiled in (default).
    NotLinked,
    /// Feature on, but libseccomp failed at runtime.
    Disabled,
}

/// Per-analysis-job context built before dispatching a sandbox run.
#[derive(Debug, Clone)]
pub struct SandboxContext {
    /// Identifies the job (used in the cgroup scope name + logs). For an ad-hoc
    /// execute this is a fresh UUID; the dataset pipeline will pass its run id.
    pub job_id: Uuid,
    /// The per-job workspace dir (bound read-write at `/home/analyst`).
    pub workspace: PathBuf,
}

/// A read-only / read-write mount plumbed into the sandbox — e.g. an input
/// count matrix or BAM the analysis needs. Kept generic (the MCP/attachment
/// coupling from ziee is dropped — DEC-3).
#[derive(Debug, Clone)]
pub struct ExtraMount {
    pub host_path: PathBuf,
    /// Absolute path inside the sandbox (e.g. `/inputs/matrix.mtx`).
    pub sandbox_path: String,
    pub mode: MountMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MountMode {
    ReadOnly,
    ReadWrite,
}

/// A declared read-only **reference** mount (ITEM-5c / DEC-11): a large,
/// admin-allowlisted host path (e.g. a Cell Ranger reference transcriptome)
/// bound RO into the sandbox WITHOUT being copied+hashed as an input. This is
/// the WIRE form carried on `AnalysisSpec.extra_mounts`; the runner validates it
/// against the deployment allowlist and turns it into a RO [`ExtraMount`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtraMountDecl {
    /// The host path to bind (must be under an admin allowlist entry; absolute
    /// + `..`-free per `spec::validate`).
    pub host_path: String,
    /// The absolute in-sandbox mount target (e.g. `/refs/transcriptome`), never a
    /// harness-managed root.
    pub sandbox_path: String,
}

impl ExtraMountDecl {
    /// Convert a declared reference mount into a concrete read-only [`ExtraMount`]
    /// bind. (Allowlist enforcement is the caller's — `spec::validate_extra_mounts_allowed`.)
    pub fn to_ro_mount(&self) -> ExtraMount {
        ExtraMount {
            host_path: PathBuf::from(&self.host_path),
            sandbox_path: self.sandbox_path.clone(),
            mode: MountMode::ReadOnly,
        }
    }
}

impl HardeningCapabilities {
    /// Compose the full capabilities from the boot-probed host half + the
    /// rootfs-dependent `pid_namespace` probe.
    pub fn from_host(host: &HostCapabilities, pid_namespace: PidNsMode) -> Self {
        Self {
            bwrap_path: host.bwrap_path.clone(),
            pid_namespace,
            cgroup: host.cgroup.clone(),
            seccomp: host.seccomp.clone(),
        }
    }
}

/// Human-readable one-line hardening summary for the boot log. Pure so the
/// mode→token mapping is unit-testable.
pub fn hardening_summary(caps: &HardeningCapabilities) -> String {
    let pid_ns = match caps.pid_namespace {
        PidNsMode::Strict => "on",
        PidNsMode::DevBindFallback => "off-fallback-dev-bind",
        PidNsMode::Disabled => "DISABLED",
    };
    let cg = match &caps.cgroup {
        CgroupMode::Delegated(_) => "on (delegated)",
        CgroupMode::None => "off-needs-delegation",
    };
    let sc = match &caps.seccomp {
        SeccompMode::Loaded(_) => "on",
        SeccompMode::NotLinked => "off-feature-not-linked",
        SeccompMode::Disabled => "off-libseccomp-failed",
    };
    format!("sandbox: hardening = {{ rlimits: on, bwrap: on, pid_ns: {pid_ns}, cgroup_v2: {cg}, seccomp: {sc} }}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-14: capability composition + hardening-summary token mapping.
    #[test]
    fn from_host_composes_and_summary_maps_tokens() {
        let host = HostCapabilities {
            bwrap_path: PathBuf::from("/usr/bin/bwrap"),
            cgroup: CgroupMode::None,
            seccomp: SeccompMode::NotLinked,
        };
        let caps = HardeningCapabilities::from_host(&host, PidNsMode::Strict);
        assert_eq!(caps.bwrap_path, PathBuf::from("/usr/bin/bwrap"));
        assert_eq!(caps.pid_namespace, PidNsMode::Strict);

        let s = hardening_summary(&caps);
        assert!(s.contains("pid_ns: on"), "{s}");
        assert!(s.contains("cgroup_v2: off-needs-delegation"), "{s}");
        assert!(s.contains("seccomp: off-feature-not-linked"), "{s}");

        let degraded = HardeningCapabilities {
            bwrap_path: PathBuf::from("/usr/bin/bwrap"),
            pid_namespace: PidNsMode::DevBindFallback,
            cgroup: CgroupMode::Delegated(PathBuf::from("/sys/fs/cgroup/x")),
            seccomp: SeccompMode::Disabled,
        };
        let s2 = hardening_summary(&degraded);
        assert!(s2.contains("pid_ns: off-fallback-dev-bind"), "{s2}");
        assert!(s2.contains("cgroup_v2: on (delegated)"), "{s2}");
        assert!(s2.contains("seccomp: off-libseccomp-failed"), "{s2}");
    }
}
