//! "Set up WSL" from inside the app: for a Windows PC where methods cannot run
//! because WSL 2 is missing or too old (the installer's WSL step was declined
//! or failed, or WSL was removed or left old later).
//!
//! The boot probe (`wsl_run::probe_host`) keeps the installer's status of this
//! PC ([`WslStatus`], decided by `wsl_status::classify`) when it fails because
//! of WSL itself. [`offer_for`] turns that status into what the app can do:
//! install WSL (`Missing`) or update it (`Old`, `Legacy`). Every other reason
//! (the x64 app on ARM64 Windows, WSL turned off by policy, no `wsl.exe`, the
//! app's own WSL runtime missing) gets no offer: the probe's sentence says why.
//!
//! `POST /api/sandbox/wsl/setup` ([`run`]) runs the installer's own commands
//! (`src-app/desktop/tauri/windows/installer-hooks.nsh`) as administrator
//! through one UAC prompt: `wsl --install --no-distribution`, after
//! `wsl --update` for an old WSL. Windows asks the person at the PC, so an AI
//! caller can start the action but can never elevate by itself. One setup runs
//! at a time; it ends as the installer's does: WSL is set up when the
//! installer's check says so afterwards. Its result is kept for the notice
//! (`GET /api/sandbox/envs`' `stack.wsl_setup`, [`notice`]).
//!
//! The elevation is a seam ([`SetupHost`]): the tests drive [`run`] with a
//! fake, and the Windows tests drive the real one with a stand-in program.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use schemars::JsonSchema;
use serde::Serialize;
use txresbench_core::AppError;

use super::wsl_status::WslStatus;

/// The setup is not offered on this PC (not Windows, methods can run, the
/// reason is not one the app can fix, or a setup already finished).
pub const WSL_SETUP_NOT_OFFERED_CODE: &str = "WSL_SETUP_NOT_OFFERED";
/// A setup started from the app is still running.
pub const WSL_SETUP_RUNNING_CODE: &str = "WSL_SETUP_RUNNING";

/// Windows' `ERROR_CANCELLED`: the person said No to the UAC prompt.
const ERROR_CANCELLED: u32 = 1223;

/// How long `POST /api/sandbox/wsl/setup` waits for the setup's end before it
/// answers `timed_out` (WSL comes from Microsoft: a slow connection can take a
/// long time). The setup itself is never stopped: it keeps the one-at-a-time
/// lock until it ends, and its result is kept for the notice.
const SETUP_ANSWER_LIMIT: Duration = Duration::from_secs(60 * 60);

/// What the "Set up WSL" button does on this PC.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WslSetupOffer {
    /// `wsl --install --no-distribution`.
    Install,
    /// `wsl --update`, then `wsl --install --no-distribution`.
    Update,
}

/// The offer for the installer's status of this PC: install a missing WSL,
/// update an old one or the WSL that came with Windows; nothing for the other
/// statuses (WSL is ready, or the app cannot fix the reason by itself).
fn offer_for(status: WslStatus) -> Option<WslSetupOffer> {
    match status {
        WslStatus::Missing => Some(WslSetupOffer::Install),
        WslStatus::Old | WslStatus::Legacy => Some(WslSetupOffer::Update),
        WslStatus::Ready
        | WslStatus::ReadyAfterRestart
        | WslStatus::Unsupported
        | WslStatus::NoWslExe
        | WslStatus::Emulated
        | WslStatus::Policy => None,
    }
}

/// How a setup ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WslSetupOutcome {
    /// WSL is set up. The app must start again to use it.
    Done,
    /// The person said No to Windows' permission prompt: nothing changed.
    Declined,
    /// Windows could not start the setup (`windows_error`).
    NotStarted,
    /// The setup ran, but WSL is still missing or too old (`exit_code`,
    /// `output`).
    Failed,
    /// No answer within [`SETUP_ANSWER_LIMIT`]: the setup may still be running
    /// (the status's `running` says so).
    TimedOut,
}

/// The result of a setup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct WslSetupResult {
    pub outcome: WslSetupOutcome,
    /// `done`: Windows must restart before WSL can be used.
    pub restart_windows: bool,
    /// `failed`: the setup's exit code (wsl.exe's), when Windows gave one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    /// `not_started`: Windows' error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_error: Option<u32>,
    /// `failed`: the last lines wsl.exe printed (empty when it printed nothing
    /// or its words could not be kept).
    pub output: String,
}

impl WslSetupResult {
    fn of(outcome: WslSetupOutcome) -> Self {
        Self { outcome, restart_windows: false, exit_code: None, windows_error: None, output: String::new() }
    }

    fn done(restart_windows: bool) -> Self {
        Self { restart_windows, ..Self::of(WslSetupOutcome::Done) }
    }

    fn failed(exit_code: Option<u32>, output: String) -> Self {
        Self { exit_code, output, ..Self::of(WslSetupOutcome::Failed) }
    }
}

/// What the notice shows about the setup (`GET /api/sandbox/envs`'
/// `stack.wsl_setup`, Windows only, while methods cannot run).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct WslSetupStatus {
    /// What "Set up WSL" does here; absent when the app cannot set WSL up
    /// (the stack's `reason` says why) or a setup is done (restart).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offer: Option<WslSetupOffer>,
    /// A setup started from the app is running.
    pub running: bool,
    /// The last setup's result since the app started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<WslSetupResult>,
}

/// How the elevated setup went, as the launcher saw it.
#[derive(Debug)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))] // only Windows' host runs one
enum Launch {
    /// Windows did not start it: its error (`ERROR_CANCELLED` when the person
    /// said No).
    NotStarted { error: u32 },
    /// It ran to its end: its exit code (when Windows gave one) and what it
    /// printed.
    Exited { code: Option<u32>, output: String },
}

/// The seam between the setup's rules and Windows.
trait SetupHost: Send + Sync {
    /// Run the installer's commands for `offer` as administrator (one UAC
    /// prompt) and wait for them to end.
    fn run_elevated(&self, offer: WslSetupOffer) -> Launch;
    /// The installer's WSL check of this PC, now.
    fn status_now(&self) -> WslStatus;
}

/// The setup's state in this process: one setup at a time, and the last result.
#[derive(Default)]
struct SetupState {
    inner: Mutex<StateInner>,
}

#[derive(Default)]
struct StateInner {
    running: bool,
    last: Option<WslSetupResult>,
}

impl SetupState {
    fn lock(&self) -> MutexGuard<'_, StateInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The notice's view, for the probe's status `boot`.
    fn status(&self, boot: Option<WslStatus>) -> WslSetupStatus {
        let inner = self.lock();
        WslSetupStatus { offer: offer_now(boot, inner.last.as_ref()), running: inner.running, last: inner.last.clone() }
    }

    /// Claim the one setup slot, or say why not.
    fn begin(self: &Arc<Self>, boot: Option<WslStatus>) -> Result<(Running, WslSetupOffer, WslStatus), AppError> {
        let mut inner = self.lock();
        if inner.running {
            return Err(AppError::conflict_code(
                WSL_SETUP_RUNNING_CODE,
                "a WSL setup is already running; wait for it to end",
            ));
        }
        let offered = boot.and_then(|status| offer_now(Some(status), inner.last.as_ref()).map(|offer| (offer, status)));
        let Some((offer, before)) = offered else {
            let why = if inner.last.as_ref().is_some_and(|r| r.outcome == WslSetupOutcome::Done) {
                "WSL is set up: restart Windows if it asked for it, then open the app again"
            } else {
                "there is no WSL setup to run on this computer"
            };
            return Err(AppError::conflict_code(WSL_SETUP_NOT_OFFERED_CODE, why));
        };
        inner.running = true;
        Ok((Running { state: Arc::clone(self) }, offer, before))
    }
}

/// The offer now: the probe's, until a setup is done.
fn offer_now(boot: Option<WslStatus>, last: Option<&WslSetupResult>) -> Option<WslSetupOffer> {
    if last.is_some_and(|r| r.outcome == WslSetupOutcome::Done) {
        return None;
    }
    boot.and_then(offer_for)
}

/// The claimed setup slot: freed when dropped (also when the setup's thread
/// panics), with the result kept when it [`finish`](Running::finish)es.
struct Running {
    state: Arc<SetupState>,
}

impl Running {
    fn finish(self, result: WslSetupResult) {
        self.state.lock().last = Some(result);
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.state.lock().running = false;
    }
}

/// Run a setup for the probe's status `boot` on `host`: refused (409) when
/// nothing is offered or one is running; else the result, or `timed_out`
/// after `limit` (the setup goes on, holding the slot, and its result is kept).
async fn run(
    state: Arc<SetupState>,
    boot: Option<WslStatus>,
    host: Arc<dyn SetupHost>,
    limit: Duration,
) -> Result<WslSetupResult, AppError> {
    let (running, offer, before) = state.begin(boot)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    // The blocking task owns the slot: a request that goes away (or times out)
    // leaves the setup running to its end, and nobody can start a second one
    // beside it.
    tokio::task::spawn_blocking(move || {
        let result = set_up(host.as_ref(), offer, before);
        tracing::info!(?result, "sandbox: WSL setup ended");
        running.finish(result.clone());
        let _ = tx.send(result);
    });
    Ok(match tokio::time::timeout(limit, rx).await {
        Ok(Ok(result)) => result,
        // The setup's thread ended without a result (it panicked).
        Ok(Err(_)) => WslSetupResult::failed(None, String::new()),
        Err(_) => WslSetupResult::of(WslSetupOutcome::TimedOut),
    })
}

/// One setup, as the installer hook does it: run the commands as
/// administrator, then check again; WSL is set up when the check says it is
/// ready (now or after a restart), whatever the exit code. Windows must
/// restart when the check says so, or when WSL was missing or of the old kind
/// before (its Virtual Machine Platform is turned on then).
fn set_up(host: &dyn SetupHost, offer: WslSetupOffer, before: WslStatus) -> WslSetupResult {
    match host.run_elevated(offer) {
        Launch::NotStarted { error: ERROR_CANCELLED } => WslSetupResult::of(WslSetupOutcome::Declined),
        Launch::NotStarted { error } => {
            WslSetupResult { windows_error: Some(error), ..WslSetupResult::of(WslSetupOutcome::NotStarted) }
        }
        Launch::Exited { code, output } => match host.status_now() {
            after @ (WslStatus::Ready | WslStatus::ReadyAfterRestart) => WslSetupResult::done(
                after == WslStatus::ReadyAfterRestart || matches!(before, WslStatus::Missing | WslStatus::Legacy),
            ),
            _ => WslSetupResult::failed(code, last_words(&output)),
        },
    }
}

/// The setup's state in this app.
fn state() -> Arc<SetupState> {
    static STATE: std::sync::LazyLock<Arc<SetupState>> = std::sync::LazyLock::new(Arc::default);
    Arc::clone(&STATE)
}

/// The probe's status of this PC when methods cannot run because of WSL
/// (Windows); `None` elsewhere.
fn boot_status() -> Option<WslStatus> {
    #[cfg(target_os = "windows")]
    {
        super::wsl_run::probe_wsl_status()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Why methods cannot run on this Windows PC (the probe's sentence); `None`
/// when they can, and on other systems (this notice is about WSL only).
fn runner_unavailable() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        super::wsl_run::runner_unavailable()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Windows, while methods cannot run: why (the probe's sentence), and the
/// setup's status for the notice. `None` when methods can run and on other
/// systems.
pub fn notice() -> Option<(String, WslSetupStatus)> {
    let why = runner_unavailable()?;
    Some((why, state().status(boot_status())))
}

/// `POST /api/sandbox/wsl/setup`: a setup on this PC through Windows.
pub async fn run_here() -> Result<WslSetupResult, AppError> {
    run(state(), boot_status(), system_host(), SETUP_ANSWER_LIMIT).await
}

#[cfg(target_os = "windows")]
fn system_host() -> Arc<dyn SetupHost> {
    Arc::new(elevated::ElevatedSetup::system())
}

/// No setup is ever offered elsewhere ([`boot_status`] is `None`), so this host
/// is never asked to run.
#[cfg(not(target_os = "windows"))]
fn system_host() -> Arc<dyn SetupHost> {
    struct NoWindows;
    impl SetupHost for NoWindows {
        fn run_elevated(&self, _offer: WslSetupOffer) -> Launch {
            Launch::NotStarted { error: 50 } // ERROR_NOT_SUPPORTED
        }
        fn status_now(&self) -> WslStatus {
            WslStatus::Unsupported
        }
    }
    Arc::new(NoWindows)
}

/// The parameters of `cmd.exe` that run the commands for `offer` with `wsl`
/// (wsl.exe's full path), as the installer hook runs them (`/d`: no AutoRun
/// commands; `/s /c "…"`: the line between the outer quotes, as it is). With
/// `capture`, both output streams go to that file, so that the app can show
/// what wsl.exe said. `None` when a path holds a character cmd.exe would read
/// as more than a path (`"`, `%`, `!`, a line break): nothing with such a
/// path may run as administrator.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn setup_params(wsl: &str, offer: WslSetupOffer, capture: Option<&str>) -> Option<String> {
    let plain = |s: &str| !s.contains(['"', '%', '!', '\r', '\n']);
    if !plain(wsl) || !capture.is_none_or(plain) {
        return None;
    }
    let install = format!("\"{wsl}\" --install --no-distribution");
    let commands = match offer {
        WslSetupOffer::Install => install,
        WslSetupOffer::Update => format!("\"{wsl}\" --update && {install}"),
    };
    Some(match capture {
        Some(file) => format!("/d /s /c \"({commands}) > \"{file}\" 2>&1\""),
        None => format!("/d /s /c \"{commands}\""),
    })
}

/// What wsl.exe printed, as text: UTF-16 (wsl.exe's own messages into a file)
/// or UTF-8, as the bytes look.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn decode_output(bytes: &[u8]) -> String {
    let nuls = bytes.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
    let text = if bytes.starts_with(&[0xFF, 0xFE]) || (bytes.len() >= 2 && nuls * 4 >= bytes.len()) {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.trim_start_matches(['\u{feff}']).replace('\0', "")
}

/// Lines kept from what wsl.exe printed, and their length at most.
const OUTPUT_LINES: usize = 6;
const OUTPUT_CHARS: usize = 600;

/// The last lines wsl.exe printed: no blank lines, no progress bars (lines
/// without a letter), no line twice in a row, at most [`OUTPUT_LINES`] lines
/// and [`OUTPUT_CHARS`] characters.
fn last_words(output: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in output.split(['\r', '\n']).map(str::trim) {
        if line.chars().any(char::is_alphabetic) && lines.last() != Some(&line) {
            lines.push(line);
        }
    }
    let kept = lines[lines.len().saturating_sub(OUTPUT_LINES)..].join("\n");
    let skip = kept.chars().count().saturating_sub(OUTPUT_CHARS);
    kept.chars().skip(skip).collect()
}

/// The setup through Windows: `ShellExecuteExW` with the "runas" verb.
#[cfg(target_os = "windows")]
mod elevated {
    use std::ffi::OsStr;
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use super::{decode_output, setup_params, Launch, SetupHost, WslSetupOffer, WslStatus};

    // The app is a 64-bit program: its System32 is the real one, where wsl.exe
    // is (a 32-bit build would need the `Sysnative` alias, as the installer does).
    #[cfg(not(target_pointer_width = "64"))]
    compile_error!("the WSL setup starts System32's cmd.exe and wsl.exe: a 64-bit build only");

    /// `nShow`: hidden when the output goes to a file (the app shows the
    /// progress), else shown, so that the person sees wsl.exe's words.
    const SW_HIDE: i32 = 0;
    const SW_SHOWNORMAL: i32 = 1;
    /// `ERROR_BAD_PATHNAME`: a path not fit for the command line.
    const ERROR_BAD_PATHNAME: u32 = 161;
    /// How much of the output's end is read.
    const OUTPUT_TAIL: u64 = 64 * 1024;

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// A directory Windows names, from the API (never from the environment).
    fn api_dir(get: unsafe extern "system" fn(*mut u16, u32) -> u32) -> Option<PathBuf> {
        let mut buf = vec![0u16; 512];
        // SAFETY: `buf` holds `buf.len()` u16s; the call writes at most that
        // many and returns the length written, without the NUL.
        let n = unsafe { get(buf.as_mut_ptr(), buf.len() as u32) } as usize;
        (n > 0 && n < buf.len()).then(|| PathBuf::from(String::from_utf16_lossy(&buf[..n])))
    }

    /// The system's System32 (`GetSystemDirectoryW`).
    pub(super) fn system_dir() -> PathBuf {
        use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
        api_dir(GetSystemDirectoryW).unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32"))
    }

    /// The system's Windows directory (`GetSystemWindowsDirectoryW`).
    fn windows_dir() -> PathBuf {
        use windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
        api_dir(GetSystemWindowsDirectoryW).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
    }

    /// The installer's commands, run as administrator.
    pub(super) struct ElevatedSetup {
        /// The `ShellExecuteExW` verb: "runas".
        pub(super) verb: &'static str,
        /// System32's cmd.exe.
        pub(super) cmd: PathBuf,
        /// System32's wsl.exe (a stand-in in the tests).
        pub(super) wsl: PathBuf,
        /// Where the output file goes: the Windows directory's `Temp`, where
        /// every user may create a file but none may list it or read another's,
        /// and whose path holds nothing a user chose.
        pub(super) capture_dir: PathBuf,
    }

    impl ElevatedSetup {
        pub(super) fn system() -> Self {
            let system = system_dir();
            Self {
                verb: "runas",
                cmd: system.join("cmd.exe"),
                wsl: system.join("wsl.exe"),
                capture_dir: windows_dir().join("Temp"),
            }
        }

        /// The program and parameters for `offer`, with the output into
        /// `capture`; `None` when a path does not fit a command line.
        pub(super) fn command(&self, offer: WslSetupOffer, capture: Option<&Path>) -> Option<(PathBuf, String)> {
            let capture = match capture {
                Some(path) => Some(path.to_str()?),
                None => None,
            };
            let params = setup_params(self.wsl.to_str()?, offer, capture)?;
            Some((self.cmd.clone(), params))
        }
    }

    impl SetupHost for ElevatedSetup {
        fn run_elevated(&self, offer: WslSetupOffer) -> Launch {
            let capture = match Capture::create(&self.capture_dir) {
                Ok(c) => Some(c),
                Err(e) => {
                    tracing::warn!("sandbox: WSL setup output file in {}: {e}", self.capture_dir.display());
                    None
                }
            };
            let Some((program, params)) = self.command(offer, capture.as_ref().map(|c| c.path.as_path())) else {
                return Launch::NotStarted { error: ERROR_BAD_PATHNAME };
            };
            let show = if capture.is_some() { SW_HIDE } else { SW_SHOWNORMAL };
            let dir = program.parent().map(Path::to_path_buf).unwrap_or_default();
            match shell_execute_wait(self.verb, &program, &params, &dir, show) {
                Err(error) => Launch::NotStarted { error },
                Ok(code) => Launch::Exited { code, output: capture.map(Capture::read).unwrap_or_default() },
            }
        }

        fn status_now(&self) -> WslStatus {
            crate::modules::sandbox::wsl_run::installer_status().0
        }
    }

    /// The file the elevated commands write their output to. Created new under
    /// a name nobody can guess, and held open by the app until it is read:
    /// read-only, shared for reading and writing (cmd.exe's redirection opens
    /// and truncates it) but never for deleting, so that it cannot be removed,
    /// renamed or replaced (by a link elsewhere, say) while the elevated
    /// commands run. Removed when dropped.
    struct Capture {
        path: PathBuf,
        file: Option<std::fs::File>,
    }

    impl Capture {
        fn create(dir: &Path) -> std::io::Result<Self> {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Foundation::GENERIC_READ;
            const FILE_SHARE_READ: u32 = 0x1;
            const FILE_SHARE_WRITE: u32 = 0x2;
            let path = dir.join(format!("txresbench-wsl-setup-{}.txt", uuid::Uuid::new_v4().simple()));
            // `write` only so that `create_new` is allowed; the handle's
            // access is `access_mode`'s: read.
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .access_mode(GENERIC_READ)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(&path)?;
            Ok(Self { path, file: Some(file) })
        }

        /// What was written, from its last [`OUTPUT_TAIL`] bytes.
        fn read(mut self) -> String {
            let Some(file) = self.file.as_mut() else { return String::new() };
            let mut bytes = Vec::new();
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            // An even offset keeps UTF-16 text aligned.
            let start = len.saturating_sub(OUTPUT_TAIL) & !1;
            if file.seek(SeekFrom::Start(start)).is_ok() {
                let _ = file.take(OUTPUT_TAIL).read_to_end(&mut bytes);
            }
            decode_output(&bytes)
        }
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            drop(self.file.take());
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// `ShellExecuteExW(verb, program, params)` with the working dir `dir`,
    /// waiting for the program's end: its exit code (`None` when Windows gave
    /// no process to wait for), or Windows' error when it did not start.
    fn shell_execute_wait(verb: &str, program: &Path, params: &str, dir: &Path, show: i32) -> Result<Option<u32>, u32> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
        use windows_sys::Win32::UI::Shell::{
            ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
        };
        let (verb, program, params, dir) =
            (wide(OsStr::new(verb)), wide(program.as_os_str()), wide(OsStr::new(params)), wide(dir.as_os_str()));
        // SAFETY: SHELLEXECUTEINFOW is a plain C struct for which all zeroes is
        // a valid (empty) value.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
        info.lpVerb = verb.as_ptr();
        info.lpFile = program.as_ptr();
        info.lpParameters = params.as_ptr();
        info.lpDirectory = dir.as_ptr();
        info.nShow = show;
        // SAFETY: `info` is initialised as the call expects, and the strings
        // it points to are NUL-terminated and outlive the call.
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            // SAFETY: no Windows call in between.
            return Err(unsafe { GetLastError() });
        }
        if info.hProcess.is_null() {
            return Ok(None);
        }
        let mut code: u32 = 0;
        // SAFETY: `hProcess` is the process handle the call returned
        // (SEE_MASK_NOCLOSEPROCESS); it is closed once, here.
        let got = unsafe {
            WaitForSingleObject(info.hProcess, INFINITE);
            let got = GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            got
        };
        Ok((got != 0).then_some(code))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// A host that answers as told, and can hold the setup until released.
    struct FakeHost {
        launch: Mutex<Option<Launch>>,
        after: WslStatus,
        hold: Mutex<Option<mpsc::Receiver<()>>>,
        offers: Mutex<Vec<WslSetupOffer>>,
    }

    impl FakeHost {
        fn new(launch: Launch, after: WslStatus) -> Self {
            Self { launch: Mutex::new(Some(launch)), after, hold: Mutex::new(None), offers: Mutex::new(Vec::new()) }
        }

        fn held(launch: Launch, after: WslStatus) -> (Arc<Self>, mpsc::Sender<()>) {
            let (tx, rx) = mpsc::channel();
            let host = Self::new(launch, after);
            *host.hold.lock().unwrap() = Some(rx);
            (Arc::new(host), tx)
        }

        fn offers(&self) -> Vec<WslSetupOffer> {
            self.offers.lock().unwrap().clone()
        }
    }

    impl SetupHost for FakeHost {
        fn run_elevated(&self, offer: WslSetupOffer) -> Launch {
            self.offers.lock().unwrap().push(offer);
            if let Some(rx) = self.hold.lock().unwrap().take() {
                let _ = rx.recv();
            }
            self.launch.lock().unwrap().take().expect("one launch per fake")
        }
        fn status_now(&self) -> WslStatus {
            self.after
        }
    }

    fn exited(code: u32, output: &str) -> Launch {
        Launch::Exited { code: Some(code), output: output.to_string() }
    }

    const LIMIT: Duration = Duration::from_secs(30);

    async fn run_once(boot: WslStatus, launch: Launch, after: WslStatus) -> (WslSetupResult, Vec<WslSetupOffer>) {
        let host = Arc::new(FakeHost::new(launch, after));
        let result = run(Arc::default(), Some(boot), host.clone(), LIMIT).await.expect("offered");
        (result, host.offers())
    }

    #[test]
    fn only_a_missing_or_old_wsl_is_offered_a_setup() {
        let offers: Vec<(WslStatus, Option<WslSetupOffer>)> =
            WslStatus::ALL.iter().map(|&s| (s, offer_for(s))).collect();
        assert_eq!(
            offers,
            [
                (WslStatus::Ready, None),
                (WslStatus::Unsupported, None),
                (WslStatus::ReadyAfterRestart, None),
                (WslStatus::Missing, Some(WslSetupOffer::Install)),
                (WslStatus::Old, Some(WslSetupOffer::Update)),
                (WslStatus::Legacy, Some(WslSetupOffer::Update)),
                (WslStatus::NoWslExe, None),
                (WslStatus::Emulated, None),
                (WslStatus::Policy, None),
            ]
        );
    }

    #[tokio::test]
    async fn nothing_offered_is_refused_with_its_code_and_runs_nothing() {
        // No probe status: not Windows, methods can run, or the probe failed
        // for a reason that is not WSL's (the app's WSL runtime is missing).
        let host = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        let state = Arc::<SetupState>::default();
        for boot in [None, Some(WslStatus::Emulated), Some(WslStatus::Policy), Some(WslStatus::NoWslExe), Some(WslStatus::Ready)] {
            let e = run(state.clone(), boot, host.clone(), LIMIT).await.expect_err("not offered");
            assert_eq!(e.status_code(), 409, "{boot:?}");
            assert_eq!(e.error_code(), WSL_SETUP_NOT_OFFERED_CODE, "{boot:?}");
        }
        assert!(host.offers().is_empty(), "nothing ran");
        assert_eq!(state.status(None), WslSetupStatus { offer: None, running: false, last: None }, "nothing changed");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn elsewhere_than_windows_nothing_is_offered() {
        assert_eq!(boot_status(), None);
        assert_eq!(notice(), None);
    }

    #[tokio::test]
    async fn the_offer_decides_the_commands() {
        let (_, offers) = run_once(WslStatus::Missing, exited(0, ""), WslStatus::ReadyAfterRestart).await;
        assert_eq!(offers, [WslSetupOffer::Install]);
        for boot in [WslStatus::Old, WslStatus::Legacy] {
            let (_, offers) = run_once(boot, exited(0, ""), WslStatus::Ready).await;
            assert_eq!(offers, [WslSetupOffer::Update], "{boot:?}");
        }
    }

    #[tokio::test]
    async fn a_setup_after_which_the_check_says_ready_is_done() {
        // Installed where WSL was missing: Windows restarts (the check may
        // not know it yet).
        let (r, _) = run_once(WslStatus::Missing, exited(0, "The operation completed successfully."), WslStatus::Ready).await;
        assert_eq!(r, WslSetupResult::done(true));
        // Updated from the WSL that came with Windows: a restart too.
        let (r, _) = run_once(WslStatus::Legacy, exited(0, ""), WslStatus::Ready).await;
        assert_eq!(r, WslSetupResult::done(true));
        // An old WSL updated: no restart unless the check asks for one.
        let (r, _) = run_once(WslStatus::Old, exited(0, ""), WslStatus::Ready).await;
        assert_eq!(r, WslSetupResult::done(false));
        let (r, _) = run_once(WslStatus::Old, exited(0, ""), WslStatus::ReadyAfterRestart).await;
        assert_eq!(r, WslSetupResult::done(true));
        // The check decides, not the exit code (as in the installer).
        let (r, _) = run_once(WslStatus::Old, exited(1, "already up to date"), WslStatus::Ready).await;
        assert_eq!(r.outcome, WslSetupOutcome::Done);
    }

    #[tokio::test]
    async fn no_to_the_permission_prompt_is_declined() {
        let (r, _) = run_once(WslStatus::Missing, Launch::NotStarted { error: 1223 }, WslStatus::Missing).await;
        assert_eq!(r, WslSetupResult::of(WslSetupOutcome::Declined));
        assert_eq!(ERROR_CANCELLED, 1223);
    }

    #[tokio::test]
    async fn another_windows_error_is_not_started() {
        let (r, _) = run_once(WslStatus::Missing, Launch::NotStarted { error: 2 }, WslStatus::Missing).await;
        assert_eq!(r.outcome, WslSetupOutcome::NotStarted);
        assert_eq!(r.windows_error, Some(2));
    }

    #[tokio::test]
    async fn a_setup_after_which_wsl_is_still_missing_failed_with_its_code_and_words() {
        let printed = "Installing: Windows Subsystem for Linux\r\n[====      20.0%      ]\r[==========100.0%==========]\r\n\
                       Catastrophic failure \r\nError code: Wsl/InstallLibrary/0x8000ffff\r\n";
        let (r, _) = run_once(WslStatus::Missing, exited(0x8000_FFFF, printed), WslStatus::Missing).await;
        assert_eq!(r.outcome, WslSetupOutcome::Failed);
        assert_eq!(r.exit_code, Some(0x8000_FFFF));
        assert_eq!(
            r.output,
            "Installing: Windows Subsystem for Linux\nCatastrophic failure\nError code: Wsl/InstallLibrary/0x8000ffff"
        );
        // Exit 0 but still too old: failed too (the check decides).
        let (r, _) = run_once(WslStatus::Old, exited(0, ""), WslStatus::Old).await;
        assert_eq!(r, WslSetupResult::failed(Some(0), String::new()));
    }

    #[tokio::test]
    async fn one_setup_at_a_time_and_none_after_one_is_done() {
        let state = Arc::<SetupState>::default();
        let (host, release) = FakeHost::held(exited(0, ""), WslStatus::ReadyAfterRestart);
        let first = tokio::spawn(run(state.clone(), Some(WslStatus::Missing), host.clone(), LIMIT));
        while !state.status(None).running {
            tokio::task::yield_now().await;
        }
        let e = run(state.clone(), Some(WslStatus::Missing), host.clone(), LIMIT).await.expect_err("one is running");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_RUNNING_CODE));
        let s = state.status(Some(WslStatus::Missing));
        assert_eq!((s.offer, s.running, s.last), (Some(WslSetupOffer::Install), true, None));

        release.send(()).unwrap();
        let r = first.await.unwrap().expect("ran");
        assert_eq!(r, WslSetupResult::done(true));
        assert_eq!(host.offers(), [WslSetupOffer::Install], "the refused call ran nothing");
        let s = state.status(Some(WslStatus::Missing));
        assert_eq!((s.offer, s.running, s.last), (None, false, Some(WslSetupResult::done(true))));
        let e = run(state.clone(), Some(WslStatus::Missing), host, LIMIT).await.expect_err("done");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_NOT_OFFERED_CODE));
    }

    #[tokio::test]
    async fn a_declined_or_failed_setup_can_be_run_again() {
        let state = Arc::<SetupState>::default();
        for launch in [Launch::NotStarted { error: ERROR_CANCELLED }, exited(1, "no")] {
            let host = Arc::new(FakeHost::new(launch, WslStatus::Old));
            run(state.clone(), Some(WslStatus::Old), host, LIMIT).await.expect("offered");
            assert_eq!(state.status(Some(WslStatus::Old)).offer, Some(WslSetupOffer::Update));
        }
    }

    #[tokio::test]
    async fn a_setup_past_the_limit_answers_timed_out_and_keeps_the_slot_until_it_ends() {
        let state = Arc::<SetupState>::default();
        let (host, release) = FakeHost::held(exited(5, "Error code: Wsl/0x80072ee7"), WslStatus::Missing);
        let r = run(state.clone(), Some(WslStatus::Missing), host.clone(), Duration::from_millis(50)).await.unwrap();
        assert_eq!(r.outcome, WslSetupOutcome::TimedOut);
        assert!(state.status(None).running, "still running");
        let e = run(state.clone(), Some(WslStatus::Missing), host, LIMIT).await.expect_err("one is running");
        assert_eq!(e.error_code(), WSL_SETUP_RUNNING_CODE);

        release.send(()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while state.status(None).running {
            assert!(std::time::Instant::now() < deadline, "the setup's end frees the slot");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let last = state.status(None).last.expect("kept");
        assert_eq!(last, WslSetupResult::failed(Some(5), "Error code: Wsl/0x80072ee7".into()));
    }

    #[test]
    fn a_setup_thread_that_panics_frees_the_slot() {
        let state = Arc::<SetupState>::default();
        let (running, _, _) = state.begin(Some(WslStatus::Missing)).expect("offered");
        assert!(state.status(None).running);
        let _ = std::thread::spawn(move || {
            let _held = running;
            panic!("the setup's thread fails");
        })
        .join();
        assert!(!state.status(None).running);
        assert_eq!(state.status(None).last, None);
    }

    #[test]
    fn the_commands_are_the_installers_with_the_output_into_the_file() {
        let wsl = r"C:\Windows\system32\wsl.exe";
        let out = r"C:\Windows\Temp\txresbench-wsl-setup-0123.txt";
        assert_eq!(
            setup_params(wsl, WslSetupOffer::Install, Some(out)).unwrap(),
            r#"/d /s /c "("C:\Windows\system32\wsl.exe" --install --no-distribution) > "C:\Windows\Temp\txresbench-wsl-setup-0123.txt" 2>&1""#
        );
        assert_eq!(
            setup_params(wsl, WslSetupOffer::Update, Some(out)).unwrap(),
            r#"/d /s /c "("C:\Windows\system32\wsl.exe" --update && "C:\Windows\system32\wsl.exe" --install --no-distribution) > "C:\Windows\Temp\txresbench-wsl-setup-0123.txt" 2>&1""#
        );
        // Without the file: exactly the installer hook's parameters.
        assert_eq!(
            setup_params(wsl, WslSetupOffer::Update, None).unwrap(),
            r#"/d /s /c ""C:\Windows\system32\wsl.exe" --update && "C:\Windows\system32\wsl.exe" --install --no-distribution""#
        );
        let hook = include_str!("../../../../desktop/tauri/windows/installer-hooks.nsh");
        assert!(hook.contains(r#"'/d /s /c ""$WINDIR\Sysnative\wsl.exe" --update && "$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'"#));
        assert!(hook.contains(r#"'/d /s /c ""$WINDIR\Sysnative\wsl.exe" --install --no-distribution"'"#));
    }

    #[test]
    fn a_path_cmd_would_read_as_more_than_a_path_runs_nothing() {
        for bad in [r#"C:\a"&calc&"\wsl.exe"#, r"C:\%EVIL%\wsl.exe", r"C:\a!b!\wsl.exe", "C:\\a\r\nb\\wsl.exe"] {
            assert_eq!(setup_params(bad, WslSetupOffer::Install, None), None, "{bad:?}");
            assert_eq!(setup_params(r"C:\Windows\system32\wsl.exe", WslSetupOffer::Install, Some(bad)), None, "{bad:?}");
        }
        // `&`, `^`, `(` and spaces are plain inside the quotes.
        assert!(setup_params(r"C:\Program Files (x86)\a&b^c\wsl.exe", WslSetupOffer::Install, None).is_some());
    }

    #[test]
    fn the_output_is_read_as_utf16_or_utf8() {
        let utf16: Vec<u8> = "WSL wird installiert …\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_output(&utf16), "WSL wird installiert …\r\n");
        let with_bom: Vec<u8> = [0xFF, 0xFE].into_iter().chain(utf16.iter().copied()).collect();
        assert_eq!(decode_output(&with_bom), "WSL wird installiert …\r\n");
        assert_eq!(decode_output("Zugriff verweigert\r\n".as_bytes()), "Zugriff verweigert\r\n");
        assert_eq!(decode_output(b""), "");
        assert_eq!(decode_output(b"\xEF\xBB\xBFok"), "ok");
    }

    #[test]
    fn the_words_kept_are_the_last_lines_and_bounded() {
        let many: String = (1..=10).map(|i| format!("line {i}\r\n")).collect();
        assert_eq!(last_words(&many), "line 5\nline 6\nline 7\nline 8\nline 9\nline 10");
        assert_eq!(last_words("  \r\n[=====  50%  ]\r\n\r\n"), "");
        assert_eq!(last_words("same\r\nsame\r\nother"), "same\nother");
        let long = "x".repeat(2000);
        assert_eq!(last_words(&long).chars().count(), OUTPUT_CHARS);
    }

    #[test]
    fn the_wire_spellings_are_snake_case() {
        let r = WslSetupResult::failed(Some(7), "words".into());
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({ "outcome": "failed", "restart_windows": false, "exit_code": 7, "output": "words" })
        );
        let s = WslSetupStatus { offer: Some(WslSetupOffer::Update), running: false, last: None };
        assert_eq!(serde_json::to_value(&s).unwrap(), serde_json::json!({ "offer": "update", "running": false }));
        for (o, name) in [
            (WslSetupOutcome::Done, "done"),
            (WslSetupOutcome::Declined, "declined"),
            (WslSetupOutcome::NotStarted, "not_started"),
            (WslSetupOutcome::Failed, "failed"),
            (WslSetupOutcome::TimedOut, "timed_out"),
        ] {
            assert_eq!(serde_json::to_value(o).unwrap(), serde_json::json!(name));
        }
    }

    /// The real launcher on Windows (in the VM): the command line, and runs
    /// through `ShellExecuteExW` with a stand-in in place of wsl.exe. Never
    /// the real wsl.exe: these tests call the launcher directly, not
    /// [`run_here`], and the seam's check of WSL is not asked.
    #[cfg(target_os = "windows")]
    mod on_windows {
        use std::path::{Path, PathBuf};

        use super::super::elevated::{system_dir, ElevatedSetup};
        use super::super::{Launch, SetupHost, WslSetupOffer};

        fn test_dir(tag: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("txr-wsl-setup-{tag}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// The output files of the setup's runs now in the capture dir.
        fn captures(dir: &Path) -> Vec<PathBuf> {
            std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("txresbench-wsl-setup-")))
                .collect()
        }

        #[test]
        fn the_setup_runs_system32s_cmd_and_wsl_by_their_full_paths() {
            let system = system_dir();
            let root = std::env::var_os("SystemRoot").map(PathBuf::from).expect("SystemRoot");
            assert_eq!(
                system.to_string_lossy().to_lowercase(),
                root.join("System32").to_string_lossy().to_lowercase(),
                "GetSystemDirectoryW is the 64-bit System32"
            );
            let setup = ElevatedSetup::system();
            assert_eq!(setup.verb, "runas");
            assert_eq!(setup.cmd, system.join("cmd.exe"));
            assert!(setup.cmd.is_file(), "{}", setup.cmd.display());
            assert_eq!(setup.wsl, system.join("wsl.exe"));
            assert_eq!(setup.capture_dir.to_string_lossy().to_lowercase(), root.join("Temp").to_string_lossy().to_lowercase());

            let capture = setup.capture_dir.join("txresbench-wsl-setup-0123.txt");
            let (program, params) = setup.command(WslSetupOffer::Update, Some(&capture)).unwrap();
            let wsl = setup.wsl.display().to_string();
            assert_eq!(program, setup.cmd);
            assert_eq!(
                params,
                format!(
                    "/d /s /c \"(\"{wsl}\" --update && \"{wsl}\" --install --no-distribution) > \"{}\" 2>&1\"",
                    capture.display()
                )
            );
            let (_, params) = setup.command(WslSetupOffer::Install, None).unwrap();
            assert_eq!(params, format!("/d /s /c \"\"{wsl}\" --install --no-distribution\""));
            assert!(Path::new(&wsl).is_absolute() && !params.contains(" wsl "), "never from PATH: {params}");
        }

        /// A stand-in for wsl.exe: says what it was asked, tries to remove or
        /// rename the setup's output file (as administrator), succeeds on
        /// `--update` and fails on `--install` with code 7.
        fn stand_in(dir: &Path, capture_dir: &Path) -> PathBuf {
            let script = dir.join("wsl-stand-in.cmd");
            let pattern = capture_dir.join("txresbench-wsl-setup-*.txt");
            let body = format!(
                "@echo off\r\n\
                 echo stand-in %*\r\n\
                 for %%f in ({}) do (\r\n\
                   ren \"%%f\" \"%%~nf.moved\" 2>nul && echo renamed || echo rename refused\r\n\
                   del /q \"%%f\" 2>nul\r\n\
                   if exist \"%%f\" (echo still there) else (echo deleted)\r\n\
                 )\r\n\
                 if \"%1\"==\"--update\" exit /b 0\r\n\
                 echo Error code: Wsl/InstallDistro/0x80370102\r\n\
                 exit /b 7\r\n",
                pattern.display()
            );
            std::fs::write(&script, body).unwrap();
            script
        }

        #[test]
        fn a_setup_runs_as_administrator_and_its_words_and_code_come_back() {
            let dir = test_dir("launch");
            let system = ElevatedSetup::system();
            let setup = ElevatedSetup { wsl: stand_in(&dir, &system.capture_dir), ..system };
            let before = captures(&setup.capture_dir).len();

            let Launch::Exited { code, output } = setup.run_elevated(WslSetupOffer::Update) else {
                panic!("not started");
            };
            assert_eq!(code, Some(7), "{output}");
            assert!(output.contains("stand-in --update"), "{output}");
            assert!(output.contains("stand-in --install --no-distribution"), "{output}");
            assert!(output.contains("Error code: Wsl/InstallDistro/0x80370102"), "{output}");
            assert!(output.contains("rename refused") && !output.contains("renamed"), "{output}");
            assert!(output.contains("still there") && !output.contains("deleted"), "{output}");

            // Install alone: no --update; and the words of a run are its own.
            let Launch::Exited { code, output } = setup.run_elevated(WslSetupOffer::Install) else {
                panic!("not started");
            };
            assert_eq!(code, Some(7), "{output}");
            assert!(!output.contains("--update"), "{output}");
            assert!(output.contains("stand-in --install --no-distribution"), "{output}");

            assert_eq!(captures(&setup.capture_dir).len(), before, "the output files are removed");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_program_windows_cannot_start_is_not_started_with_its_error() {
            let dir = test_dir("missing");
            let system = ElevatedSetup::system();
            // Its output file in the test's own dir: the other test's stand-in
            // tries to remove every one in the Windows Temp dir.
            let setup = ElevatedSetup { cmd: dir.join("no-such-cmd.exe"), capture_dir: dir.clone(), ..system };
            match setup.run_elevated(WslSetupOffer::Install) {
                Launch::NotStarted { error } => assert_eq!(error, 2, "ERROR_FILE_NOT_FOUND"),
                other => panic!("{other:?}"),
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
