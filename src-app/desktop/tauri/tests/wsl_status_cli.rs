//! The built `txresbench-desktop` binary answers the Windows installer's
//! `--wsl-status` and exits, without starting the app. The installer waits for
//! that exit code (`windows/installer-hooks.nsh`): a binary that started the
//! app instead would keep the installer waiting until the user closed the app,
//! and then hand it an exit code that is not a status.
//!
//! The app's first step when it starts is to create its data dir
//! (`~/.txresbench`, `config::desktop_config`), so the binary runs here with a
//! home dir of its own, and the test stops it as soon as that dir appears.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use txresbench::modules::sandbox::wsl_status::WslStatus;
use txresbench_desktop_lib::installer_cli::WSL_STATUS_ARG;

/// The check's own budget is `wsl --version`'s 20 s timeout; the rest is
/// start-up time on a slow test machine.
const LIMIT: Duration = Duration::from_secs(90);

fn empty_dir(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_binary_answers_wsl_status_without_starting_the_app() {
    let home = empty_dir("wsl-status-home");
    let app_data = home.join(".txresbench");
    let mut child = Command::new(env!("CARGO_BIN_EXE_txresbench-desktop"))
        .arg(WSL_STATUS_ARG)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        // Nor a store elsewhere, should the app start after all.
        .env_remove("TXR_DATABASE_URL")
        .env_remove("RUST_LOG")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the desktop binary starts");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if app_data.exists() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the app started (its data dir {} appeared)", app_data.display());
        }
        if started.elapsed() > LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            panic!("no answer within {LIMIT:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stdout = String::new();
    child.stdout.take().unwrap().read_to_string(&mut stdout).unwrap();
    let mut stderr = String::new();
    child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
    assert!(!app_data.exists(), "the app started");
    let code = status.code().unwrap_or_else(|| panic!("ended without an exit code: {status:?}"));
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 1, "one line, and nothing of the app: {stdout:?} {stderr:?}");

    #[cfg(windows)]
    {
        let known = WslStatus::ALL.iter().find(|s| s.code() == code && **s != WslStatus::Unsupported);
        let known = known.unwrap_or_else(|| panic!("{code} is not a status: {stdout:?} {stderr:?}"));
        assert!(lines[0].starts_with(&format!("{}: ", known.name())), "{stdout:?}");
    }
    #[cfg(not(windows))]
    {
        assert_eq!(code, WslStatus::Unsupported.code(), "{stdout:?} {stderr:?}");
        assert_eq!(lines[0], format!("{WSL_STATUS_ARG} is the Windows installer's check; this is not Windows"));
    }
    let _ = std::fs::remove_dir_all(&home);
}
