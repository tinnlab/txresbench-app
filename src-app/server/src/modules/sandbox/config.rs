//! Sandbox availability + global per-process state.
//!
//! Ported from txresbench `code_sandbox/config.rs`. The sandbox SELF-ENABLES (DEC-2:
//! there is no config toggle — `ServerConfig` ignores extra app keys); every
//! non-`Ready` variant is a specific reason `init()` recorded, surfaced by the
//! admin status endpoint so the UI degrades gracefully.

use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::OnceCell;
use schemars::JsonSchema;
use serde::Serialize;

use super::types::HostCapabilities;

/// Why the sandbox is (or isn't) available, in machine-readable form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SandboxAvailability {
    /// Fully initialized — the sandbox is registered and usable.
    Ready,
    /// The host boot probe failed — on Linux this means `bwrap` is not on PATH.
    HostUnsupported,
    /// No analysis rootfs was built into this binary (docker absent at build
    /// time, or a non-Linux build).
    RootfsUnavailable,
    /// The per-job workspace root could not be created.
    WorkspaceInitFailed,
    /// `init()` has not run yet, or bailed before recording a reason.
    NotInitialized,
}

impl SandboxAvailability {
    /// Why methods cannot run, in words for the person using the app: what
    /// the Windows notice says when the start-up check gave no sentence of its
    /// own (`wsl_run::runner_unavailable`).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn in_words(self) -> &'static str {
        match self {
            SandboxAvailability::Ready => "methods can run",
            SandboxAvailability::HostUnsupported => "the method runner could not start",
            SandboxAvailability::RootfsUnavailable => "the app's method runtime is missing; install the app again",
            SandboxAvailability::WorkspaceInitFailed => {
                "the app could not create its folder for method runs; check that the disk has free space, then \
                 start the app again"
            }
            SandboxAvailability::NotInitialized => {
                "the method runner has not started yet; if this stays, start the app again"
            }
        }
    }
}

/// Global per-process sandbox state, populated at `init()`.
#[derive(Debug)]
pub struct SandboxState {
    /// Workspace root: `<app_data>/sandboxes/`. Per-job subdirs are created on
    /// demand under here (chmod 0700). Holds only run SCRATCH — `home/`,
    /// `inputs/`, `code/`, the progress FIFO — and is reclaimed with the run.
    pub workspace_root: PathBuf,
    /// Output staging root: `<app_data>/run-staging/` (ITEM-17). A SIBLING of
    /// `workspace_root`, not a subdir of it: a run's `/outputs` lives here so that
    /// reclaiming a workspace can never destroy outputs that ingest has not yet
    /// consumed. See [`crate::modules::sandbox::outputs::staging_root`].
    pub staging_root: PathBuf,
    /// Rootfs-independent capabilities probed at boot. The rootfs-dependent
    /// `pid_namespace` is resolved lazily on the first run via the rootfs mount.
    pub host_caps: HostCapabilities,
}

/// The method VM (macOS) or the WSL distro (Windows) could not be prepared,
/// booted or reached, or stopped before the command finished.
pub const VM_UNAVAILABLE_CODE: &str = "SANDBOX_VM_UNAVAILABLE";

/// The WSL runner (Windows) could not be prepared or reached.
pub const WSL_UNAVAILABLE_CODE: &str = "SANDBOX_WSL_UNAVAILABLE";

/// Some of a run's output files could not be copied back from the method VM
/// or the WSL distro; the run is refused rather than kept with partial
/// outputs.
pub const VM_OUTPUTS_INCOMPLETE_CODE: &str = "SANDBOX_VM_OUTPUTS_INCOMPLETE";

/// The runner codes whose story is "the place methods run in could not be
/// prepared": the environment family, like `SANDBOX_UNAVAILABLE`. The
/// sanitiser (`err_sanitiser::is_env_code`), the run-reason pass-through
/// (`orchestrator::env_failure_reason`) and the UI's `ENV_FAMILY_CODES`
/// (`txrresults/lib/trouble.ts`) all list these; a test per side pins it.
pub const RUNNER_ENV_CODES: [&str; 2] = [VM_UNAVAILABLE_CODE, WSL_UNAVAILABLE_CODE];

/// Every typed code the VM and WSL runners raise (the env family above plus
/// the copy-back refusal). They reach run reasons verbatim.
pub const RUNNER_CODES: [&str; 3] =
    [VM_UNAVAILABLE_CODE, WSL_UNAVAILABLE_CODE, VM_OUTPUTS_INCOMPLETE_CODE];

static STATE: OnceCell<Arc<SandboxState>> = OnceCell::new();
static INIT_STATUS: OnceCell<SandboxAvailability> = OnceCell::new();

/// Record the module's init outcome (first value wins).
pub fn set_init_status(status: SandboxAvailability) {
    let _ = INIT_STATUS.set(status);
}

/// The recorded init outcome (defaults to `NotInitialized` before boot).
pub fn init_status() -> SandboxAvailability {
    INIT_STATUS
        .get()
        .copied()
        .unwrap_or(SandboxAvailability::NotInitialized)
}

/// Set the global state (called once at `init()`). First write wins.
pub fn init_state(state: SandboxState) -> Arc<SandboxState> {
    let arc = Arc::new(state);
    if STATE.set(arc.clone()).is_err() {
        tracing::warn!(
            "sandbox::init_state called more than once; second call discarded \
             (typically a test harness; in production it means a double init)."
        );
    }
    STATE.get().cloned().unwrap_or(arc)
}

/// Get the global state. `None` until `init_state` has run (i.e. when the
/// sandbox is unavailable or before boot).
pub fn get_state() -> Option<Arc<SandboxState>> {
    STATE.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words never carry the variant's code name (the notice showed
    /// "(WorkspaceInitFailed)" before).
    #[test]
    fn every_availability_has_plain_words() {
        for (a, name) in [
            (SandboxAvailability::Ready, "Ready"),
            (SandboxAvailability::HostUnsupported, "HostUnsupported"),
            (SandboxAvailability::RootfsUnavailable, "RootfsUnavailable"),
            (SandboxAvailability::WorkspaceInitFailed, "WorkspaceInitFailed"),
            (SandboxAvailability::NotInitialized, "NotInitialized"),
        ] {
            let words = a.in_words();
            assert!(!words.is_empty() && !words.contains(name) && !words.contains('_'), "{a:?}: {words}");
            assert!(words.starts_with(char::is_lowercase), "{a:?}: the notice makes the sentence");
        }
        assert!(SandboxAvailability::WorkspaceInitFailed.in_words().contains("folder for method runs"));
    }

    // TEST-4: SandboxAvailability serializes snake_case; init_status defaults.
    #[test]
    fn availability_serializes_snake_case() {
        let cases = [
            (SandboxAvailability::Ready, "\"ready\""),
            (SandboxAvailability::HostUnsupported, "\"host_unsupported\""),
            (SandboxAvailability::RootfsUnavailable, "\"rootfs_unavailable\""),
            (SandboxAvailability::WorkspaceInitFailed, "\"workspace_init_failed\""),
            (SandboxAvailability::NotInitialized, "\"not_initialized\""),
        ];
        for (variant, expected) in cases {
            assert_eq!(serde_json::to_string(&variant).unwrap(), expected);
        }
    }

    #[test]
    fn init_status_defaults_to_not_initialized() {
        // Process-global OnceCell; this test only reads the default and never
        // sets it, so it can't perturb (or be perturbed by) sibling tests.
        assert_eq!(init_status(), SandboxAvailability::NotInitialized);
    }
}
