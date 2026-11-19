//! What the Windows installer needs to know about WSL, as a decision on facts.
//!
//! Methods on Windows run in the app's WSL 2 distro (`wsl_run`). The Windows
//! installer sets WSL up when the PC does not have it: its hook
//! (`src-app/desktop/tauri/windows/installer-hooks.nsh`) runs
//! `txresbench-desktop.exe --wsl-status` and acts on the exit code, a
//! [`WslStatus`]. `wsl_run::installer_status` gathers the [`WslFacts`] on
//! Windows; [`classify`] turns them into the status. Both the version rule and
//! this decision live here, without I/O, so that they are tested on every
//! platform and the installer and the app's own check (`wsl_run::probe_host`)
//! apply the same rule.

/// The exit codes of `txresbench-desktop.exe --wsl-status`: the installer
/// hook's contract. The hook's `!define TXR_WSL_<NAME>` lines carry the same
/// numbers (`src-app/desktop/tauri/tests/installer_hooks.rs` checks both ways).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WslStatus {
    /// WSL is installed, new enough, and its Virtual Machine Platform is running.
    Ready = 0,
    /// Not a WSL question: not Windows, or wrong arguments.
    Unsupported = 2,
    /// WSL is installed and new enough, but Windows has not restarted since its
    /// Virtual Machine Platform was turned on.
    ReadyAfterRestart = 20,
    /// No WSL: `wsl --install --no-distribution` installs it.
    Missing = 21,
    /// WSL is older than [`wsl_version_ok`] allows: `wsl --update`.
    Old = 22,
    /// `wsl --version` does not work, but an older WSL is there (the WSL that
    /// came with Windows, or a broken WSL package): `wsl --update`.
    Legacy = 23,
    /// There is no `wsl.exe` in System32: this Windows cannot install WSL by
    /// itself.
    NoWslExe = 24,
    /// The x64 build of the app on ARM64 Windows: it could not use WSL there.
    Emulated = 25,
    /// The organization turned WSL off (policy `AllowWSL` = 0).
    Policy = 26,
}

impl WslStatus {
    /// Every status, for the tests that compare them with the installer hook.
    pub const ALL: [WslStatus; 9] = [
        WslStatus::Ready,
        WslStatus::Unsupported,
        WslStatus::ReadyAfterRestart,
        WslStatus::Missing,
        WslStatus::Old,
        WslStatus::Legacy,
        WslStatus::NoWslExe,
        WslStatus::Emulated,
        WslStatus::Policy,
    ];

    /// The process exit code.
    pub fn code(self) -> i32 {
        self as i32
    }

    /// The name the installer hook uses: `TXR_WSL_<name>`.
    pub fn name(self) -> &'static str {
        match self {
            WslStatus::Ready => "READY",
            WslStatus::Unsupported => "UNSUPPORTED",
            WslStatus::ReadyAfterRestart => "READY_AFTER_RESTART",
            WslStatus::Missing => "MISSING",
            WslStatus::Old => "OLD",
            WslStatus::Legacy => "LEGACY",
            WslStatus::NoWslExe => "NO_WSL_EXE",
            WslStatus::Emulated => "EMULATED",
            WslStatus::Policy => "POLICY",
        }
    }
}

/// What `wsl --version` gave, when it finished in time.
#[derive(Clone, Debug, Default)]
pub struct VersionRun {
    /// It exited with 0.
    pub exit_ok: bool,
    /// Its standard output (UTF-8 with `WSL_UTF8=1`, else UTF-16 read as bytes):
    /// the version is read from it, as the app's probe reads it.
    pub stdout: String,
    /// What it printed on both streams, as one message (the in-box wsl.exe of
    /// a Windows without WSL says so on its standard error): for the check's
    /// one line, not for the decision.
    pub text: String,
}

/// What the installer's check found on this PC (`wsl_run::installer_status`).
#[derive(Clone, Debug, Default)]
pub struct WslFacts {
    /// This is the x64 build running on ARM64 Windows.
    pub emulated: bool,
    /// `HKLM\SOFTWARE\Policies\WSL` `AllowWSL` is 0.
    pub turned_off_by_policy: bool,
    /// `%SystemRoot%\System32\wsl.exe` exists.
    pub wsl_exe_present: bool,
    /// `wsl --version`; `None` when it was not run, could not start or did not
    /// finish in time.
    pub version_run: Option<VersionRun>,
    /// The service of the WSL that came with Windows (`LxssManager`) exists.
    pub inbox_wsl_on: bool,
    /// The WSL package is registered
    /// (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss\MSI`).
    pub package_registered: bool,
    /// The Virtual Machine Platform runs: services `HNS` and `vmcompute` exist,
    /// and `vfpext` too on Windows builds 22621 and later (the test WSL itself
    /// uses before it turns the component on).
    pub vm_platform_running: bool,
}

/// The installer's decision. The order is the probe's: emulation first, then
/// policy, then wsl.exe, then the version.
pub fn classify(facts: &WslFacts) -> WslStatus {
    if facts.emulated {
        return WslStatus::Emulated;
    }
    if facts.turned_off_by_policy {
        return WslStatus::Policy;
    }
    if !facts.wsl_exe_present {
        return WslStatus::NoWslExe;
    }
    let version = facts
        .version_run
        .as_ref()
        .filter(|run| run.exit_ok)
        .and_then(|run| parse_wsl_version(&run.stdout));
    match version {
        Some(v) if wsl_version_ok(v) => {
            if facts.vm_platform_running {
                WslStatus::Ready
            } else {
                WslStatus::ReadyAfterRestart
            }
        }
        Some(_) => WslStatus::Old,
        None if facts.inbox_wsl_on || facts.package_registered => WslStatus::Legacy,
        None => WslStatus::Missing,
    }
}

/// The WSL version from `wsl --version`: the first `a.b.c[.d]` number on the
/// first line (`WSL version: 2.6.1.0`; the label is translated on other
/// Windows languages, the number is not).
pub fn parse_wsl_version(text: &str) -> Option<(u32, u32, u32)> {
    let first = text.replace('\0', "");
    let first = first.lines().find(|l| !l.trim().is_empty())?;
    first.split(|c: char| !(c.is_ascii_digit() || c == '.')).find_map(|word| {
        let nums: Vec<u32> = word.split('.').map(|n| n.parse().ok()).collect::<Option<_>>()?;
        (nums.len() >= 3).then(|| (nums[0], nums[1], nums[2]))
    })
}

/// Whether this WSL is new enough: free of CVE-2025-53788 (a local privilege
/// escalation in WSL fixed in 2.5.10 and 2.6.1).
pub fn wsl_version_ok(v: (u32, u32, u32)) -> bool {
    v >= (2, 6, 1) || ((2, 5, 10) <= v && v < (2, 6, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_versions_free_of_the_cve_are_accepted() {
        assert!(wsl_version_ok((2, 6, 1)));
        assert!(wsl_version_ok((2, 7, 0)));
        assert!(wsl_version_ok((3, 0, 0)));
        assert!(wsl_version_ok((2, 5, 10)));
        assert!(wsl_version_ok((2, 5, 11)));
        assert!(!wsl_version_ok((2, 6, 0)));
        assert!(!wsl_version_ok((2, 5, 9)));
        assert!(!wsl_version_ok((2, 4, 13)));
        assert!(!wsl_version_ok((1, 2, 5)));
    }

    #[test]
    fn the_wsl_version_is_read_from_the_first_line_in_any_language() {
        let en = "WSL version: 2.6.1.0\nKernel version: 6.6.87.2-1\nWSLg version: 1.0.66\n";
        assert_eq!(parse_wsl_version(en), Some((2, 6, 1)));
        let de = "WSL-Version: 2.5.10.0\nKernelversion: 6.6.87.2-1\n";
        assert_eq!(parse_wsl_version(de), Some((2, 5, 10)));
        // UTF-16 read as bytes leaves NULs between the characters.
        let utf16ish: String = "WSL version: 2.6.2.0".chars().flat_map(|c| [c, '\0']).collect();
        assert_eq!(parse_wsl_version(&utf16ish), Some((2, 6, 2)));
        assert_eq!(parse_wsl_version("Invalid command line option: --version"), None);
        assert_eq!(parse_wsl_version(""), None);
    }

    /// A PC with a working WSL package of `version`, everything else as on a
    /// PC where WSL 2 runs.
    fn installed(version: &str) -> WslFacts {
        WslFacts {
            wsl_exe_present: true,
            version_run: Some(VersionRun {
                exit_ok: true,
                stdout: format!("WSL version: {version}\nKernel version: 6.6.87.2-1\n"),
                ..VersionRun::default()
            }),
            package_registered: true,
            vm_platform_running: true,
            ..WslFacts::default()
        }
    }

    /// Windows 11 with the in-box wsl.exe only: `wsl --version` fails.
    fn bare_windows(stdout: &str) -> WslFacts {
        WslFacts {
            wsl_exe_present: true,
            version_run: Some(VersionRun { exit_ok: false, stdout: stdout.into(), ..VersionRun::default() }),
            ..WslFacts::default()
        }
    }

    #[test]
    fn a_new_enough_wsl_with_its_platform_running_is_ready() {
        assert_eq!(classify(&installed("2.6.1.0")), WslStatus::Ready);
        assert_eq!(classify(&installed("2.5.10.0")), WslStatus::Ready);
        assert_eq!(classify(&installed("3.0.5.0")), WslStatus::Ready);
    }

    #[test]
    fn a_new_wsl_whose_platform_is_not_running_yet_needs_a_restart() {
        let facts = WslFacts { vm_platform_running: false, ..installed("3.0.5.0") };
        assert_eq!(classify(&facts), WslStatus::ReadyAfterRestart);
    }

    #[test]
    fn a_wsl_with_the_flaw_is_old_whether_or_not_its_platform_runs() {
        for v in ["2.6.0.0", "2.5.9.0", "2.4.13.0", "1.2.5.0"] {
            assert_eq!(classify(&installed(v)), WslStatus::Old, "{v}");
            let stopped = WslFacts { vm_platform_running: false, ..installed(v) };
            assert_eq!(classify(&stopped), WslStatus::Old, "{v}");
        }
    }

    #[test]
    fn a_version_read_in_another_language_counts() {
        let mut facts = installed("2.6.1.0");
        facts.version_run = Some(VersionRun { exit_ok: true, stdout: "WSL-Version: 2.6.1.0\n".into(), ..VersionRun::default() });
        assert_eq!(classify(&facts), WslStatus::Ready);
    }

    #[test]
    fn a_version_from_a_failed_run_is_not_trusted() {
        let mut facts = installed("2.6.1.0");
        facts.version_run.as_mut().unwrap().exit_ok = false;
        assert_eq!(classify(&facts), WslStatus::Legacy, "the package is registered");
        facts.package_registered = false;
        assert_eq!(classify(&facts), WslStatus::Missing);
    }

    #[test]
    fn windows_without_wsl_is_missing() {
        assert_eq!(classify(&bare_windows("Invalid command line option: --version")), WslStatus::Missing);
        assert_eq!(classify(&bare_windows("")), WslStatus::Missing);
        let silent = WslFacts { version_run: None, ..bare_windows("") };
        assert_eq!(classify(&silent), WslStatus::Missing, "a wsl.exe that did not answer in time");
    }

    #[test]
    fn the_old_inbox_wsl_or_a_broken_package_is_updated_not_installed() {
        let inbox = WslFacts { inbox_wsl_on: true, ..bare_windows("Invalid command line option: --version") };
        assert_eq!(classify(&inbox), WslStatus::Legacy);
        let broken = WslFacts { package_registered: true, version_run: None, ..bare_windows("") };
        assert_eq!(classify(&broken), WslStatus::Legacy);
    }

    #[test]
    fn without_wsl_exe_nothing_else_is_asked() {
        let facts = WslFacts { wsl_exe_present: false, ..installed("2.6.1.0") };
        assert_eq!(classify(&facts), WslStatus::NoWslExe);
    }

    #[test]
    fn policy_comes_before_wsl_exe_and_the_version() {
        let facts = WslFacts { turned_off_by_policy: true, wsl_exe_present: false, ..installed("2.6.1.0") };
        assert_eq!(classify(&facts), WslStatus::Policy);
        let facts = WslFacts { turned_off_by_policy: true, ..bare_windows("") };
        assert_eq!(classify(&facts), WslStatus::Policy);
    }

    #[test]
    fn emulation_comes_first() {
        let facts = WslFacts { emulated: true, turned_off_by_policy: true, ..bare_windows("") };
        assert_eq!(classify(&facts), WslStatus::Emulated);
        let facts = WslFacts { emulated: true, ..installed("2.6.1.0") };
        assert_eq!(classify(&facts), WslStatus::Emulated);
    }

    #[test]
    fn every_status_has_its_own_code_and_name() {
        let codes: std::collections::BTreeSet<i32> = WslStatus::ALL.iter().map(|s| s.code()).collect();
        let names: std::collections::BTreeSet<&str> = WslStatus::ALL.iter().map(|s| s.name()).collect();
        assert_eq!(codes.len(), WslStatus::ALL.len());
        assert_eq!(names.len(), WslStatus::ALL.len());
        // 1 is what a crashed or refused program commonly returns: never a status.
        assert!(!codes.contains(&1));
        assert_eq!(WslStatus::Ready.code(), 0);
    }
}
