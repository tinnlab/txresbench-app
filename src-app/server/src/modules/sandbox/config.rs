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
