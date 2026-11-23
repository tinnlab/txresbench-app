//! Sandbox capability + context types.
//!
//! Ported from txresbench `code_sandbox/types.rs`, collapsed to the Linux-only,
//! single-rootfs, companion-driven shape (no JSON-RPC envelope, no per-flavor
//! lock — DEC-2/DEC-3).

use std::path::PathBuf;
use std::sync::Arc;

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

/// Why a method run is refused when the seccomp filter could not be built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeccompRefusal {
    /// The `sandbox_seccomp` cargo feature is not compiled in (the normal
    /// debug/dev state). Refused only in a release build: a release build
    /// must never run a method without the filter.
    NotLinked,
    /// Feature on, but libseccomp failed at runtime. Refused in every build.
    Disabled,
}

impl SeccompRefusal {
    /// The exact user-facing sentence for this refusal (pinned verbatim by
    /// unit tests; the installer/UI surface promises these words).
    pub fn message(&self) -> String {
        match self {
            SeccompRefusal::NotLinked => "Methods cannot run on this computer: a safety part of the method sandbox could not start. Install libseccomp2 (on Debian or Ubuntu: sudo apt install libseccomp2) and restart the app.".to_string(),
            SeccompRefusal::Disabled => "Methods cannot run on this computer: a safety part of the method sandbox could not start (the system filter could not be built).".to_string(),
        }
    }
}

/// True on `--release` builds, false on debug builds. Callers pass this to
/// [`require_filter`] so the `NotLinked` refusal applies to release only while
/// debug/dev builds keep running unfiltered (as they always have).
pub const RELEASE_BUILD: bool = !cfg!(debug_assertions);

/// The seccomp gate: a method run must be REFUSED when the filter cannot be
/// built. `Loaded` is always OK; `Disabled` is Err in every build; `NotLinked`
/// (feature not compiled in) is Err only when `release_build` is true.
pub fn require_filter(mode: &SeccompMode, release_build: bool) -> Result<(), SeccompRefusal> {
    match mode {
        SeccompMode::Loaded(_) => Ok(()),
        SeccompMode::Disabled => Err(SeccompRefusal::Disabled),
        SeccompMode::NotLinked if release_build => Err(SeccompRefusal::NotLinked),
        SeccompMode::NotLinked => Ok(()),
    }
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
/// coupling from txresbench is dropped — DEC-3).
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

    // The seccomp gate truth table: `Loaded` ok in both builds; `Disabled`
    // refused in both; `NotLinked` ok in a debug build and refused only in a
    // release build (the run is refused wherever a filter is missing).
    #[test]
    fn require_filter_truth_table() {
        let loaded = SeccompMode::Loaded(std::sync::Arc::new(vec![1, 2, 3]));
        assert!(require_filter(&loaded, false).is_ok(), "Loaded ok in debug");
        assert!(require_filter(&loaded, true).is_ok(), "Loaded ok in release");
        assert_eq!(
            require_filter(&SeccompMode::Disabled, false),
            Err(SeccompRefusal::Disabled),
            "Disabled refused in debug"
        );
        assert_eq!(
            require_filter(&SeccompMode::Disabled, true),
            Err(SeccompRefusal::Disabled),
            "Disabled refused in release"
        );
        assert!(
            require_filter(&SeccompMode::NotLinked, false).is_ok(),
            "NotLinked ok in a debug build"
        );
        assert_eq!(
            require_filter(&SeccompMode::NotLinked, true),
            Err(SeccompRefusal::NotLinked),
            "NotLinked refused in a release build"
        );
    }

    // The two refusal sentences are pinned verbatim — a debug/dev build with
    // the feature off must never show them, and the release/`Disabled` notices
    // are exactly these words, not a paraphrase.
    #[test]
    fn refusal_messages_are_pinned_verbatim() {
        assert_eq!(
            SeccompRefusal::NotLinked.message(),
            "Methods cannot run on this computer: a safety part of the method sandbox could not start. Install libseccomp2 (on Debian or Ubuntu: sudo apt install libseccomp2) and restart the app."
        );
        assert_eq!(
            SeccompRefusal::Disabled.message(),
            "Methods cannot run on this computer: a safety part of the method sandbox could not start (the system filter could not be built)."
        );
    }
}
