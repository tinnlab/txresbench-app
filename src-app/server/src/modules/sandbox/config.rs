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
    /// own (`wsl_run::runner_unavailable`), and the fallback of
    /// [`methods_cannot_run_for`] when the probe recorded no sentence.
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
/// Why the boot probe found no way to run methods, in plain words (first
/// value wins). Set only where the probe failed.
#[cfg(not(target_os = "windows"))]
static PROBE_FAILURE: OnceCell<String> = OnceCell::new();
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

/// The plain sentence for a failed boot probe, from the platform
/// (`std::env::consts::OS`) and the probe's own technical `raw` reason. The
/// raw text names paths, launcher files and environment variables, so it is
/// only logged; the user gets one of these sentences instead. (Windows says
/// its own, in `wsl_run`.)
pub fn plain_probe_reason(os: &str, raw: &str) -> String {
    match os {
        "macos" if raw.contains("Apple Silicon") => {
            "methods need a Mac with an Apple chip (M1 or newer); a Mac with an Intel chip cannot run them"
                .to_string()
        }
        "macos" if raw.contains("missing") || raw.contains("VM runtime") || raw.contains("guest root") => {
            "the part of the app that runs methods on a Mac is missing or out of date; \
             install the app again from a full release"
                .to_string()
        }
        "macos" => "the part of the app that runs methods on a Mac did not start".to_string(),
        "linux" => "bubblewrap, the tool that keeps methods isolated, is not installed; \
             install bubblewrap and squashfuse"
            .to_string(),
        _ => "methods cannot run on this system".to_string(),
    }
}

/// Record why the boot probe failed (plain words, first value wins).
#[cfg(not(target_os = "windows"))]
pub fn set_probe_failure(plain: String) {
    let _ = PROBE_FAILURE.set(plain);
}

/// Why no method can run on this machine at all, known once the boot probe
/// has failed; `None` while the sandbox is ready or has not booted yet (a run
/// that cannot start still fails with its own typed code).
#[cfg(not(target_os = "windows"))]
pub fn runner_unavailable() -> Option<String> {
    runner_reason(init_status(), PROBE_FAILURE.get().map(String::as_str))
}

/// [`runner_unavailable`] for a given status and recorded probe failure.
pub fn runner_reason(status: SandboxAvailability, probe_failure: Option<&str>) -> Option<String> {
    match status {
        SandboxAvailability::Ready | SandboxAvailability::NotInitialized => None,
        SandboxAvailability::WorkspaceInitFailed => {
            Some("the app could not set up the folder it runs methods in".to_string())
        }
        SandboxAvailability::HostUnsupported | SandboxAvailability::RootfsUnavailable => Some(
            probe_failure
                .map(str::to_string)
                .unwrap_or_else(|| "the part of the app that runs methods did not start".to_string()),
        ),
    }
}

/// Whether NO method can run on this computer, in the one sentence the method
/// list / study preview / picker rows show when it cannot (the eligibility
/// stage's `RUNNER_UNAVAILABLE`). `None` while the sandbox is `Ready` or has
/// NOT booted yet ([`NotInitialized`]: unit tests, pre-boot — nothing is
/// known; a run that cannot start still fails with its own typed code).
/// Unlike [`SandboxAvailability::in_words`] this is not a label for *this*
/// process's status alone: `why` is the runner's own boot-probe sentence
/// (e.g. Windows: `wsl_run::runner_unavailable`), and when it has none the
/// status's own words are the fallback.
pub fn methods_cannot_run_for(
    status: SandboxAvailability,
    why: Option<String>,
) -> Option<String> {
    match status {
        SandboxAvailability::Ready | SandboxAvailability::NotInitialized => None,
        _ => Some(why.unwrap_or_else(|| status.in_words().to_string())),
    }
}

/// [`methods_cannot_run_for`] for THIS process: the cheap boot-flag read the
/// eligibility/estimate stages use per request (the `OnceLock`s are set once
/// at boot — never a `wsl_run::probe()`/`installer_status()` call, which
/// spawn `wsl.exe`). On Windows the WSL runner's own sentence (which is
/// `Some` before boot too — the [`NotInitialized`] guard lives in
/// [`methods_cannot_run_for`]); on every other OS `None` — Linux/macOS keep
/// today's behaviour, their `runner_unavailable` could feed this later.
pub fn methods_cannot_run_here() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        methods_cannot_run_for(init_status(), super::wsl_run::runner_unavailable())
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
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

    /// A5: each platform's failed probe reads as a plain sentence that says
    /// why methods cannot run, never the probe's paths or variable names.
    #[test]
    fn a_failed_probe_reads_as_a_plain_reason_per_platform() {
        let intel = plain_probe_reason(
            "macos",
            "method VMs need an Apple Silicon Mac (libkrun runs arm64 guests only) — method VMs disabled (host_unsupported)",
        );
        assert!(intel.contains("Apple chip") && intel.contains("Intel"), "{intel}");

        let no_launcher = plain_probe_reason(
            "macos",
            "the VM launcher is missing at /Applications/App/resources/vm/launcher (build the app's VM runtime \
             with scripts/build-macos-vm-runtime.sh, or set TXR_MAC_VM_LAUNCHER) — method VMs disabled (host_unsupported)",
        );
        assert!(no_launcher.contains("missing or out of date"), "{no_launcher}");
        let old_root = plain_probe_reason("macos", "the VM guest root at /x: older protocol (rebuild it)");
        assert_eq!(old_root, no_launcher);
        let other = plain_probe_reason("macos", "the VM launcher at /x cannot run: denied");
        assert!(other.contains("did not start"), "{other}");

        let linux = plain_probe_reason(
            "linux",
            "bwrap not found on PATH — sandbox disabled (host_unsupported). Install bubblewrap + squashfuse to enable.",
        );
        assert!(linux.contains("bubblewrap") && linux.contains("not installed"), "{linux}");

        for text in [&intel, &no_launcher, &other, &linux] {
            for jargon in ["/", "TXR_", "libkrun", "host_unsupported", "this computer", "bwrap "] {
                assert!(!text.contains(jargon), "{jargon:?} in {text}");
            }
        }
    }

    #[test]
    fn methods_cannot_run_for_ignores_ready_and_not_initialized() {
        use SandboxAvailability::*;
        assert_eq!(methods_cannot_run_for(Ready, Some("x".to_string())), None);
        assert_eq!(methods_cannot_run_for(NotInitialized, None), None);
        // Windows' `wsl_run::runner_unavailable` answers Some even before the
        // boot probe ran; the stage must NOT mark methods cannot-run on that
        // answer (nothing is known, the run keeps its typed refusal).
        assert_eq!(
            methods_cannot_run_for(NotInitialized, Some("WSL 2 is not installed".to_string())),
            None
        );
    }

    #[test]
    fn methods_cannot_run_for_surfaces_the_given_sentence_or_the_status_words() {
        use SandboxAvailability::*;
        assert_eq!(
            methods_cannot_run_for(HostUnsupported, Some("WSL 2 is not installed".to_string()))
                .as_deref(),
            Some("WSL 2 is not installed")
        );
        // No sentence recorded: the status's own words (never the variant's
        // code name) are the fallback.
        assert_eq!(
            methods_cannot_run_for(WorkspaceInitFailed, None).as_deref(),
            Some(WorkspaceInitFailed.in_words())
        );
        assert_eq!(
            methods_cannot_run_for(HostUnsupported, None).as_deref(),
            Some(HostUnsupported.in_words())
        );
    }

    #[test]
    fn the_runner_reason_follows_the_boot_status() {
        use SandboxAvailability::*;
        assert_eq!(runner_reason(Ready, Some("x")), None);
        assert_eq!(runner_reason(NotInitialized, None), None, "before boot nothing is known");
        assert_eq!(runner_reason(HostUnsupported, Some("why")).as_deref(), Some("why"));
        assert!(runner_reason(HostUnsupported, None).unwrap().contains("did not start"));
        assert!(runner_reason(WorkspaceInitFailed, None).unwrap().contains("folder"));
    }

    #[test]
    fn init_status_defaults_to_not_initialized() {
        // Process-global OnceCell; this test only reads the default and never
        // sets it, so it can't perturb (or be perturbed by) sibling tests.
        assert_eq!(init_status(), SandboxAvailability::NotInitialized);
    }
}
