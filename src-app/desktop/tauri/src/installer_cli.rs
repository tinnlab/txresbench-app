//! The desktop binary's one command-line mode, `--wsl-status`: the WSL check
//! the Windows installer runs after it copied the app
//! (`windows/installer-hooks.nsh`). It answers before anything of the app
//! starts (no window, no server, no single-user setup) and exits with a
//! `WslStatus` code (`txresbench::modules::sandbox::wsl_status`).

use std::ffi::OsString;

use txresbench::modules::sandbox::wsl_status::WslStatus;

/// The argument the installer passes (the hook spells it the same way;
/// `tests/installer_hooks.rs` checks that).
pub const WSL_STATUS_ARG: &str = "--wsl-status";

/// What the arguments (without the program name) ask for.
#[derive(Debug, PartialEq, Eq)]
enum Mode {
    /// A normal start of the app.
    App,
    /// `--wsl-status`, alone.
    WslStatus,
    /// `--wsl-status` with more arguments.
    Usage,
}

fn mode(args: &[OsString]) -> Mode {
    if args.first().map(|a| a.as_os_str()) != Some(WSL_STATUS_ARG.as_ref()) {
        Mode::App
    } else if args.len() == 1 {
        Mode::WslStatus
    } else {
        Mode::Usage
    }
}

/// `Some(exit code)` when the arguments (without the program name) ask for a
/// command-line mode; `None` for a normal start of the app.
pub fn cli_mode<I: IntoIterator<Item = OsString>>(args: I) -> Option<i32> {
    let args: Vec<OsString> = args.into_iter().collect();
    match mode(&args) {
        Mode::App => None,
        Mode::WslStatus => Some(wsl_status()),
        Mode::Usage => {
            say(&format!("usage: txresbench-desktop {WSL_STATUS_ARG}"));
            Some(WslStatus::Unsupported.code())
        }
    }
}

#[cfg(windows)]
fn wsl_status() -> i32 {
    let (status, line) = txresbench::modules::sandbox::wsl_run::installer_status();
    say(&format!("{}: {line}", status.name()));
    status.code()
}

#[cfg(not(windows))]
fn wsl_status() -> i32 {
    say(&format!("{WSL_STATUS_ARG} is the Windows installer's check; this is not Windows"));
    WslStatus::Unsupported.code()
}

/// One line on standard output, when there is one: the release build is a
/// GUI program, and the installer starts it without a console.
fn say(line: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout(), "{line}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_normal_start_is_not_a_command_line_mode() {
        assert_eq!(mode(&args(&[])), Mode::App);
        assert_eq!(mode(&args(&["--other"])), Mode::App);
        assert_eq!(mode(&args(&["txresbench://x", WSL_STATUS_ARG])), Mode::App, "only as the first argument");
        assert_eq!(cli_mode(args(&[])), None);
        assert_eq!(cli_mode(args(&["--other"])), None);
    }

    #[test]
    fn the_wsl_check_takes_no_other_argument() {
        assert_eq!(mode(&args(&[WSL_STATUS_ARG])), Mode::WslStatus);
        assert_eq!(mode(&args(&[WSL_STATUS_ARG, "x"])), Mode::Usage);
        assert_eq!(cli_mode(args(&[WSL_STATUS_ARG, "x"])), Some(WslStatus::Unsupported.code()));
    }

    #[cfg(not(windows))]
    #[test]
    fn the_wsl_check_is_windows_only() {
        assert_eq!(cli_mode(args(&[WSL_STATUS_ARG])), Some(WslStatus::Unsupported.code()));
    }

    /// On Windows the real check runs: whatever this PC's WSL, the code is one
    /// the installer knows.
    #[cfg(windows)]
    #[test]
    fn the_wsl_check_gives_a_status_the_installer_knows() {
        let code = cli_mode(args(&[WSL_STATUS_ARG])).unwrap();
        assert!(WslStatus::ALL.iter().any(|s| s.code() == code && *s != WslStatus::Unsupported), "{code}");
    }
}
