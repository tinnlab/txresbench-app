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
//! `POST /api/sandbox/wsl/setup` ([`start_here`]) starts the installer's own
//! commands (`src-app/desktop/tauri/windows/installer-hooks.nsh`):
//! `wsl --install --no-distribution`, after `wsl --update` for an old WSL. It
//! answers at once with the setup's status (`running`); the result is read
//! later from the status (`GET /api/sandbox/envs`' `stack.wsl_setup`,
//! [`notice`]).
//!
//! Nothing runs as administrator unless a person confirms in the app's own
//! dialog first ([`question`]): a window on this PC that no caller of the
//! route can answer, that no letter key answers ([`buttons`]), and whose
//! go button a click cannot hit as the dialog comes up ([`GO_DELAY_MS`]).
//! That dialog is the barrier. Windows' permission prompt (UAC) may come after it,
//! but is not relied on: with UAC off or set to never notify, or with the app
//! itself run as administrator, Windows elevates without asking anyone. After
//! a decline (in the dialog or in Windows' prompt) the setup is not offered again for [`DECLINE_PAUSE_SECS`], so that
//! a caller cannot put the question up again and again.
//!
//! Only the desktop app offers a setup ([`mark_desktop_app`]). Its server is
//! behind the local API lock (`modules::local_api_lock`: the app's own window,
//! or a caller holding the app's per-run key), and its window is on this PC.
//! A headless server (`serve_blocking`) never offers one: its key may be
//! given to programs on other machines, and nobody may be at the PC it runs
//! on to answer the question.
//!
//! One setup runs at a time; it ends as the installer's does: WSL is set up
//! when the installer's check says it is ready afterwards, or, after wsl.exe
//! exited with 0, when the check says it is ready after a restart or, where
//! WSL was missing or of the old kind, still finds it so (Windows must restart
//! then). A small file in the app's data dir ([`Marker`]) carries a setup
//! across a restart of the app, and to a second app open beside the first:
//! neither offers a second setup while the first one asks or its elevated
//! commands still run, and both keep saying "restart Windows" until Windows
//! did.
//!
//! The dialog, the elevation and the PC are seams ([`SetupHost`],
//! [`Machine`]): the tests drive the setup with fakes, and the Windows tests
//! drive the real launcher with stand-in programs (never the real dialog).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use txresbench_core::AppError;

use super::wsl_status::WslStatus;

/// The setup is not offered on this PC (not Windows, not the desktop app,
/// methods can run, the reason is not one the app can fix, or a setup
/// already finished).
pub const WSL_SETUP_NOT_OFFERED_CODE: &str = "WSL_SETUP_NOT_OFFERED";
/// A setup is still running (started from this app, from the app before it
/// was last closed, or from a second app open beside it).
pub const WSL_SETUP_RUNNING_CODE: &str = "WSL_SETUP_RUNNING";
/// The last setup was declined less than [`DECLINE_PAUSE_SECS`] ago.
const WSL_SETUP_DECLINED_RECENTLY_CODE: &str = "WSL_SETUP_DECLINED_RECENTLY";

/// Windows' `ERROR_CANCELLED`: the person said No to the UAC prompt.
const ERROR_CANCELLED: u32 = 1223;

/// How long a declined setup is not offered again.
const DECLINE_PAUSE_SECS: u64 = 60;

/// How far apart two readings of Windows' start time may be and still name
/// the same start. The reading is the clock minus the time since the start,
/// to the second, so it moves with the clock's corrections. Without Windows'
/// boot counter ([`Machine::boot_id`]) this is all the slack: after a week or
/// two the reading may have moved by more at worst, and the app then forgets
/// "restart Windows" and offers the setup again. A restart is minutes apart.
const SAME_BOOT_SLACK_SECS: u64 = 60;

/// With Windows' boot counter the same in both readings, the slack grows by
/// a second for every this many seconds since the setup started (200 ppm, a
/// clock's corrections at worst; two weeks: about 4 minutes more). The
/// counter says whether Windows restarted; the start times must still agree,
/// so that a Windows that keeps the counter but stopped moving it does not
/// say "restart Windows" for ever: once they drift apart, the setup is
/// offered again.
const BOOT_DRIFT_SECS_PER_SEC: u64 = 5000;

/// How far Windows' running time, read twice in the same start, may seem to
/// go back (each reading is to the second).
const UPTIME_SLACK_SECS: u64 = 2;

/// The marker file's name in the app's data dir.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const MARKER_FILE: &str = "wsl-setup.json";

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
///
/// `ReadyAfterRestart` (WSL installed, its Virtual Machine Platform off or
/// waiting for a restart) gets no offer either, although the installer asks
/// to turn the platform on for it: the boot probe does not read the platform,
/// so it never fails on that status, and a run on such a PC fails with the
/// runner's own hint (turn the platform on, restart).
fn offer_for(status: WslStatus) -> Option<WslSetupOffer> {
    match status {
        WslStatus::Missing => Some(WslSetupOffer::Install),
        WslStatus::Old | WslStatus::Legacy => Some(WslSetupOffer::Update),
        WslStatus::ReadyAfterRestart => None,
        WslStatus::Ready
        | WslStatus::Unsupported
        | WslStatus::NoWslExe
        | WslStatus::Emulated
        | WslStatus::Policy => None,
    }
}

/// How a setup ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WslSetupOutcome {
    /// WSL is set up. The app must start again to use it.
    Done,
    /// The person did not go on (Not now in the app's dialog, or No in
    /// Windows' permission prompt): nothing changed.
    Declined,
    /// Windows could not start the setup (`windows_error`).
    NotStarted,
    /// The setup ran, but WSL is not set up (`exit_code`, `output`).
    Failed,
}

/// The result of a setup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
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

    /// WSL is set up and waits for Windows to restart.
    fn waits_for_a_restart(&self) -> bool {
        self.outcome == WslSetupOutcome::Done && self.restart_windows
    }
}

/// What the notice shows about the setup (`GET /api/sandbox/envs`'
/// `stack.wsl_setup`, Windows only, while methods cannot run), and what
/// `POST /api/sandbox/wsl/setup` answers once a setup started.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct WslSetupStatus {
    /// What "Set up WSL" does here; absent when the app cannot set WSL up
    /// (the stack's `reason` says why) or a setup is done (restart).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offer: Option<WslSetupOffer>,
    /// A setup is running: started from the app, from the app before it was
    /// last closed, or from a second app open beside it. Its result comes in
    /// `last` when it ends.
    pub running: bool,
    /// The last setup's result: since the app started, or a setup done
    /// before the app was last closed that waits for Windows to restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<WslSetupResult>,
    /// After a declined setup: the seconds until it can be started again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_in_secs: Option<u64>,
}

/// A process (the setup's elevated one, the app that started it): its id,
/// and when it started (Windows' creation time), so that a later process
/// with the same id is not taken for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Process {
    pid: u32,
    created: u64,
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
    /// Ask the person at the PC, in the app's own dialog, whether to go on
    /// (`true`: they chose the question's `go` button).
    fn confirm(&self, question: &Question) -> bool;
    /// Run the installer's commands for `offer` as administrator and wait for
    /// them to end; `started` gets the elevated process once Windows started
    /// it.
    fn run_elevated(&self, offer: WslSetupOffer, started: &mut dyn FnMut(Process)) -> Launch;
    /// The installer's WSL check of this PC, now.
    fn status_now(&self) -> WslStatus;
}

/// What the setup's state reads of this PC besides WSL.
trait Machine: Send + Sync {
    /// The time, in seconds since 1970.
    fn now(&self) -> u64;
    /// When Windows started, in seconds since 1970; `None` when not known.
    fn boot_time(&self) -> Option<u64>;
    /// Windows' boot counter, one more at every start of Windows; `None` when
    /// not known.
    fn boot_id(&self) -> Option<u32>;
    /// `process` still runs.
    fn alive(&self, process: Process) -> bool;
    /// This process (the app); `None` when not known.
    fn this_process(&self) -> Option<Process>;
    /// Where the marker file is; `None`: no marker is kept.
    fn marker(&self) -> Option<PathBuf>;
}

/// The setup as a reopened app, or a second app open beside the first,
/// finds it: started at `started_at` while Windows had started at
/// `boot_time` and had the boot counter `boot_id`, by the app process `app`,
/// its elevated process once Windows started one, and its result once it
/// ended at `ended_at`. Written when a setup starts, when its elevated
/// process started and when it ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    started_at: u64,
    boot_time: Option<u64>,
    /// Absent, so none, in a marker of an older build.
    boot_id: Option<u32>,
    /// The app that started the setup (absent, so none, in a marker of an
    /// older build).
    app: Option<Process>,
    process: Option<Process>,
    result: Option<WslSetupResult>,
    /// When the setup ended ([`Machine::now`]): a decline pauses the setup
    /// in every app, not only in the one that asked. Absent while it runs,
    /// and in a marker of an older build.
    ended_at: Option<u64>,
}

/// What the marker says of a setup started before (by this app, by the app
/// before it was last closed, or by a second app open beside it).
enum Earlier {
    Nothing,
    /// It still runs: its elevated process does, or the other app that
    /// started it is open (at its question, or keeping the result).
    Running,
    /// It is done and waits for Windows to restart, which it has not yet.
    WaitsForRestart(WslSetupResult),
    /// It was declined, at this time ([`Machine::now`]).
    Declined(u64),
}

fn read_marker(path: &Path) -> Option<Marker> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Write `marker` to `path` whole (a new file, then renamed over the old).
fn write_marker(path: &Path, marker: &Marker) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(marker).map_err(std::io::Error::other)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let new = path.with_extension("json.new");
    std::fs::write(&new, bytes)?;
    std::fs::rename(&new, path)
}

/// The setup's state in this process: one setup at a time, the last result,
/// the last decline; and the marker for a reopened app.
struct SetupState {
    inner: Mutex<StateInner>,
    machine: Arc<dyn Machine>,
}

#[derive(Default)]
struct StateInner {
    running: bool,
    last: Option<WslSetupResult>,
    /// When this app's last setup was declined ([`Machine::now`]); another
    /// app's decline is read from the marker.
    declined_at: Option<u64>,
}

impl SetupState {
    fn new(machine: Arc<dyn Machine>) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::default(), machine })
    }

    fn lock(&self) -> MutexGuard<'_, StateInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The notice's view, for the probe's status `boot`.
    fn status(&self, boot: Option<WslStatus>) -> WslSetupStatus {
        self.view(&self.lock(), boot)
    }

    fn view(&self, inner: &StateInner, boot: Option<WslStatus>) -> WslSetupStatus {
        // The marker matters only where a setup is offered: a setup started
        // before runs, or waits for a restart, while the probe finds WSL
        // missing or old.
        let earlier = if boot.is_some() { self.earlier() } else { Earlier::Nothing };
        let running = inner.running || matches!(earlier, Earlier::Running);
        // The pause after a decline: in this app, or in another app (beside
        // this one, or before it was reopened), whichever came last.
        let declined_at = match earlier {
            Earlier::Declined(at) => inner.declined_at.max(Some(at)),
            _ => inner.declined_at,
        };
        let last = match earlier {
            Earlier::WaitsForRestart(done) if inner.last.is_none() => Some(done),
            _ => inner.last.clone(),
        };
        let offer = if last.as_ref().is_some_and(|r| r.outcome == WslSetupOutcome::Done) {
            None
        } else {
            boot.and_then(offer_for)
        };
        let now = self.machine.now();
        let retry_in_secs = declined_at
            .filter(|&at| now >= at && now < at + DECLINE_PAUSE_SECS)
            .map(|at| at + DECLINE_PAUSE_SECS - now);
        WslSetupStatus { offer, running, last, retry_in_secs }
    }

    /// What the marker says. A setup without a result runs while its
    /// elevated process does, or while the app that started it is open and
    /// is not this one: a second app beside it, which may be at its question
    /// (no elevated process yet; the desktop app does not keep to one
    /// window). Else it is over: its result unknown when its process is gone
    /// (the app was closed while it ran); nothing ran when no process ever
    /// started (the app was closed at its question). A declined setup says
    /// when it ended, for the pause after it.
    fn earlier(&self) -> Earlier {
        let Some(marker) = self.machine.marker().and_then(|path| read_marker(&path)) else {
            return Earlier::Nothing;
        };
        match marker.result {
            None => {
                let alive = |process: Option<Process>| process.is_some_and(|p| self.machine.alive(p));
                let other_app = marker.app.filter(|&app| Some(app) != self.machine.this_process());
                if alive(marker.process) || alive(other_app) {
                    Earlier::Running
                } else {
                    Earlier::Nothing
                }
            }
            Some(result) if result.waits_for_a_restart() && self.same_boot(&marker) => {
                Earlier::WaitsForRestart(result)
            }
            Some(result) if result.outcome == WslSetupOutcome::Declined => {
                marker.ended_at.map_or(Earlier::Nothing, Earlier::Declined)
            }
            Some(_) => Earlier::Nothing,
        }
    }

    /// Windows has not restarted since `marker` was written. When both
    /// readings have Windows' boot counter: the same counter, Windows has run
    /// no less time now than it had then, and the two start times agree
    /// within [`SAME_BOOT_SLACK_SECS`] plus a second for every
    /// [`BOOT_DRIFT_SECS_PER_SEC`] since the setup started. The counter does
    /// not drift, where the start time read from the clock moves with the
    /// clock's corrections; but the counter is not documented by Microsoft,
    /// so a counter that stopped moving must not hide a restart for ever.
    /// Without the counter, the two start times must agree within
    /// [`SAME_BOOT_SLACK_SECS`]. Not known: not the same boot (the setup is
    /// offered again rather than "restart Windows" for ever).
    fn same_boot(&self, marker: &Marker) -> bool {
        let now = self.machine.now();
        let boot_now = self.machine.boot_time();
        let starts_within =
            |slack: u64| matches!((marker.boot_time, boot_now), (Some(then), Some(now)) if then.abs_diff(now) <= slack);
        match (marker.boot_id, self.machine.boot_id()) {
            (Some(id_then), Some(id_now)) => {
                let ran_then = marker.boot_time.map(|boot| marker.started_at.saturating_sub(boot));
                let ran_now = boot_now.map(|boot| now.saturating_sub(boot));
                let ran_less = matches!((ran_then, ran_now), (Some(then), Some(now)) if now + UPTIME_SLACK_SECS < then);
                let drift = now.saturating_sub(marker.started_at) / BOOT_DRIFT_SECS_PER_SEC;
                id_then == id_now && !ran_less && starts_within(SAME_BOOT_SLACK_SECS + drift)
            }
            _ => starts_within(SAME_BOOT_SLACK_SECS),
        }
    }

    fn write(&self, marker: &Marker) {
        if let Some(path) = self.machine.marker() {
            if let Err(e) = write_marker(&path, marker) {
                tracing::warn!("sandbox: WSL setup marker {}: {e}", path.display());
            }
        }
    }

    /// Claim the one setup slot, or say why not.
    fn begin(self: &Arc<Self>, boot: Option<WslStatus>) -> Result<(Running, WslSetupOffer, WslStatus), AppError> {
        let mut inner = self.lock();
        let now = self.view(&inner, boot);
        if now.running {
            return Err(AppError::conflict_code(
                WSL_SETUP_RUNNING_CODE,
                "a WSL setup is already running; wait for it to end",
            ));
        }
        if let Some(secs) = now.retry_in_secs {
            return Err(AppError::conflict_code(
                WSL_SETUP_DECLINED_RECENTLY_CODE,
                format!("the WSL setup was just declined; it can be started again in {secs} s"),
            ));
        }
        let (Some(offer), Some(before)) = (now.offer, boot) else {
            let why = if now.last.as_ref().is_some_and(|r| r.outcome == WslSetupOutcome::Done) {
                "WSL is set up: restart Windows if it asked for it, then open the app again"
            } else {
                "there is no WSL setup to run here"
            };
            return Err(AppError::conflict_code(WSL_SETUP_NOT_OFFERED_CODE, why));
        };
        inner.running = true;
        let marker = Marker {
            started_at: self.machine.now(),
            boot_time: self.machine.boot_time(),
            boot_id: self.machine.boot_id(),
            app: self.machine.this_process(),
            process: None,
            result: None,
            ended_at: None,
        };
        self.write(&marker);
        Ok((Running { state: Arc::clone(self), marker, result: None }, offer, before))
    }
}

/// The claimed setup slot. When dropped it keeps the result (a failure when
/// the setup's thread ended without one: it panicked), notes a decline,
/// writes the result and its time into the marker, and frees the slot.
struct Running {
    state: Arc<SetupState>,
    marker: Marker,
    result: Option<WslSetupResult>,
}

impl Running {
    /// The elevated process started: a reopened app finds it in the marker.
    fn started(&mut self, process: Process) {
        let _inner = self.state.lock();
        self.marker.process = Some(process);
        self.state.write(&self.marker);
    }

    fn finish(mut self, result: WslSetupResult) {
        self.result = Some(result);
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let result = self.result.take().unwrap_or_else(|| WslSetupResult::failed(None, String::new()));
        let state = Arc::clone(&self.state);
        let mut inner = state.lock();
        let now = state.machine.now();
        if result.outcome == WslSetupOutcome::Declined {
            inner.declined_at = Some(now);
        }
        self.marker.result = Some(result.clone());
        self.marker.ended_at = Some(now);
        state.write(&self.marker);
        inner.last = Some(result);
        inner.running = false;
    }
}

/// Start a setup for the probe's status `boot` on `host`: refused (409) when
/// nothing is offered, one is running, or the last was declined a moment
/// ago; else the status with the setup running. The setup goes on in its own
/// thread, which holds the slot until it ends and keeps its result.
fn start(state: &Arc<SetupState>, boot: Option<WslStatus>, host: Arc<dyn SetupHost>) -> Result<WslSetupStatus, AppError> {
    let (running, offer, before) = state.begin(boot)?;
    let status = state.status(boot);
    std::thread::Builder::new()
        .name("wsl-setup".into())
        .spawn(move || {
            let mut running = running;
            let result = set_up(host.as_ref(), offer, before, &mut |process| running.started(process));
            tracing::info!(?result, "sandbox: WSL setup ended");
            running.finish(result);
        })
        .map_err(|e| AppError::internal_error(format!("the WSL setup could not start: {e}")))?;
    Ok(status)
}

/// The app's question before anything runs as administrator: its words, and
/// the label of the button that goes on (the other is [`NOT_NOW`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Question {
    text: &'static str,
    go: &'static str,
}

/// The app's question before anything runs as administrator, in the
/// installer's words, saying where the request may have come from: the
/// app's button, its palette, an AI assistant, or any other program on this
/// PC (the local API lock lets through the app's own window and any caller
/// holding the app's per-run key, and the route's token needs no sign-in).
fn question(before: WslStatus) -> Question {
    match before {
        WslStatus::Missing => Question {
            go: "Install WSL",
            text: "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux), which is not installed.\r\n\r\n\
             Install WSL 2 now? It is downloaded from Microsoft (about 400 MB). Windows may also ask for \
             permission, and Windows usually needs a restart afterwards.\r\n\r\n\
             This was asked for with TxResBench's Set up WSL button, its command palette or an AI assistant \
             connected to it, or by another program on this PC. If you did not ask for this, choose Not now.",
        },
        WslStatus::Legacy => Question {
            go: "Update WSL",
            text: "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux). The WSL installed is an older \
             kind that TxResBench cannot use.\r\n\r\n\
             Update WSL now? The update is downloaded from Microsoft (about 400 MB). Windows may also ask for \
             permission. Linux programs running in WSL will be closed, and Windows may need a restart \
             afterwards.\r\n\r\n\
             This was asked for with TxResBench's Update WSL button, its command palette or an AI assistant \
             connected to it, or by another program on this PC. If you did not ask for this, choose Not now.",
        },
        // `Old`: the only other status offered a setup (`offer_for`).
        _ => Question {
            go: "Update WSL",
            text: "TxResBench runs methods inside WSL 2 (Windows Subsystem for Linux). The WSL installed is too old: \
             it has a known security flaw that newer versions fix.\r\n\r\n\
             Update WSL now? The update is downloaded from Microsoft (about 400 MB). Windows may also ask for \
             permission. Linux programs running in WSL will be closed.\r\n\r\n\
             This was asked for with TxResBench's Update WSL button, its command palette or an AI assistant \
             connected to it, or by another program on this PC. If you did not ask for this, choose Not now.",
        },
    }
}

/// The question's title.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const QUESTION_TITLE: &str = "TxResBench: set up WSL";

/// The label of the question's other button, the default.
const NOT_NOW: &str = "Not now";

/// The ids of the question's two buttons (the dialog's answer).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const GO_BUTTON: i32 = 100;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const NOT_NOW_BUTTON: i32 = 101;

/// The question's buttons (id, label): `question.go` and [`NOT_NOW`], the
/// default. No label has an `&`, so no letter key presses either: someone
/// typing in the app as the question comes up (an agent may start a setup
/// at any moment) cannot answer it. (Windows' own Yes and No are "&Yes" and
/// "&No": a "y" would say Yes.) Enter and Space press the default, Not now;
/// Esc closes the dialog, which is a No too. The go button is greyed out for
/// the first [`GO_DELAY_MS`], so that a click cannot answer it either.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn buttons(question: &Question) -> [(i32, &'static str); 2] {
    [(GO_BUTTON, question.go), (NOT_NOW_BUTTON, NOT_NOW)]
}

/// The dialog's answer, from `TaskDialogIndirect`'s result and the button
/// that closed it: go on only after the go button. A dialog Windows did not
/// show (a failed result), one closed with Esc or its close box
/// (`IDCANCEL`), and Not now are a No.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn goes_on(result: i32, button: i32) -> bool {
    result == 0 && button == GO_BUTTON
}

/// How long the go button stays greyed out after the dialog is made. The
/// dialog comes up above every window, centred on the app, at a moment the
/// caller chose: a click aimed at something else that lands on the go button
/// as the dialog appears must not be a Yes.
const GO_DELAY_MS: usize = 1000;

/// The go button can be pressed `elapsed_ms` after the dialog was made (the
/// count the task dialog's timer gives).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn go_ready(elapsed_ms: usize) -> bool {
    elapsed_ms >= GO_DELAY_MS
}

/// One setup, as the installer hook does it: ask, run the commands as
/// administrator, then check again. WSL is set up when the check says it is
/// ready, whatever the exit code; Windows must restart when WSL was missing or
/// of the old kind before (its Virtual Machine Platform is turned on then).
/// Any other answer counts only after a setup that exited with 0 (an unknown
/// code is not 0): WSL ready after a restart is a setup Windows must restart
/// to finish, and so is WSL still missing or of the old kind where it was so
/// before (WSL may answer only after Windows restarts). After a setup that
/// failed, ready after a restart cannot tell a Virtual Machine Platform turned
/// on from one still off: the setup failed, and no restart is asked for.
fn set_up(
    host: &dyn SetupHost,
    offer: WslSetupOffer,
    before: WslStatus,
    started: &mut dyn FnMut(Process),
) -> WslSetupResult {
    if !host.confirm(&question(before)) {
        return WslSetupResult::of(WslSetupOutcome::Declined);
    }
    let missing_or_legacy = |status| matches!(status, WslStatus::Missing | WslStatus::Legacy);
    match host.run_elevated(offer, started) {
        Launch::NotStarted { error: ERROR_CANCELLED } => WslSetupResult::of(WslSetupOutcome::Declined),
        Launch::NotStarted { error } => {
            WslSetupResult { windows_error: Some(error), ..WslSetupResult::of(WslSetupOutcome::NotStarted) }
        }
        Launch::Exited { code, output } => match host.status_now() {
            WslStatus::Ready => WslSetupResult::done(missing_or_legacy(before)),
            WslStatus::ReadyAfterRestart if code == Some(0) => WslSetupResult::done(true),
            after if code == Some(0) && missing_or_legacy(before) && missing_or_legacy(after) => {
                WslSetupResult::done(true)
            }
            _ => WslSetupResult::failed(code, last_words(&output)),
        },
    }
}

/// The setup's state in this app.
fn state() -> Arc<SetupState> {
    static STATE: std::sync::LazyLock<Arc<SetupState>> =
        std::sync::LazyLock::new(|| SetupState::new(Arc::new(SystemMachine)));
    Arc::clone(&STATE)
}

/// Set once when this process is the desktop app ([`mark_desktop_app`]).
static DESKTOP_APP: OnceLock<()> = OnceLock::new();

/// This process is the desktop app: called once by its server at start
/// (`boot_in_background`), and by nothing else (crate-private, so no other
/// crate can). Only the desktop app offers a setup.
pub(crate) fn mark_desktop_app() {
    let _ = DESKTOP_APP.set(());
}

/// The probe's status `probe` where a setup may be offered: in the desktop
/// app (`desktop`) only. Elsewhere there is nothing to set up.
fn offered_for(desktop: bool, probe: Option<WslStatus>) -> Option<WslStatus> {
    probe.filter(|_| desktop)
}

/// [`offered_for`] in this process: the desktop app when it was marked
/// ([`mark_desktop_app`]).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))] // tests use it everywhere
fn offered(probe: Option<WslStatus>) -> Option<WslStatus> {
    offered_for(DESKTOP_APP.get().is_some(), probe)
}

/// The probe's status of this PC when methods cannot run because of WSL, in
/// the desktop app on Windows ([`offered`]); `None` elsewhere, so a headless
/// server offers no setup.
fn boot_status() -> Option<WslStatus> {
    #[cfg(target_os = "windows")]
    {
        offered(super::wsl_run::probe_wsl_status())
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
/// setup's status for the notice (no offer outside the desktop app). `None`
/// when methods can run and on other systems.
pub fn notice() -> Option<(String, WslSetupStatus)> {
    let why = runner_unavailable()?;
    Some((why, state().status(boot_status())))
}

/// `POST /api/sandbox/wsl/setup` after its permission check (the local API
/// lock checked the caller before any route ran): a setup starts on this PC,
/// and the answer is its status (`running`). Refused (409) where nothing is
/// offered, and in any process that is not the desktop app.
pub fn start_here() -> Result<WslSetupStatus, AppError> {
    start(&state(), boot_status(), system_host())
}

/// This PC, for the setup's state.
struct SystemMachine;

impl Machine for SystemMachine {
    fn now(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
    }

    fn boot_time(&self) -> Option<u64> {
        #[cfg(target_os = "windows")]
        {
            Some(elevated::boot_time(self.now()))
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    fn boot_id(&self) -> Option<u32> {
        #[cfg(target_os = "windows")]
        {
            elevated::boot_id()
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    fn alive(&self, process: Process) -> bool {
        #[cfg(target_os = "windows")]
        {
            elevated::alive(process)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = process;
            false
        }
    }

    fn this_process(&self) -> Option<Process> {
        #[cfg(target_os = "windows")]
        {
            elevated::this_process()
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }

    /// The app's data dir on Windows; no marker elsewhere (no setup there).
    fn marker(&self) -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        {
            Some(crate::modules::rootfs::data_root().join(MARKER_FILE))
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }
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
        fn confirm(&self, _question: &Question) -> bool {
            false
        }
        fn run_elevated(&self, _offer: WslSetupOffer, _started: &mut dyn FnMut(Process)) -> Launch {
            Launch::NotStarted { error: 50 } // ERROR_NOT_SUPPORTED
        }
        fn status_now(&self) -> WslStatus {
            WslStatus::Unsupported
        }
    }
    Arc::new(NoWindows)
}

/// The commands for `offer` with `wsl` (wsl.exe's full path), exactly as the
/// installer hook runs them (its `TxrWslInstallParams` / `TxrWslUpdateParams`
/// between `/d /s /c "` and the closing quote).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn setup_commands(wsl: &str, offer: WslSetupOffer) -> String {
    let install = format!("\"{wsl}\" --install --no-distribution");
    match offer {
        WslSetupOffer::Install => install,
        WslSetupOffer::Update => format!("\"{wsl}\" --update && {install}"),
    }
}

/// The parameters of `cmd.exe` that run the commands for `offer` with `wsl`
/// (`/d`: no AutoRun commands; `/s /c "…"`: the line between the outer
/// quotes, as it is). The commands read no input (`< nul`): the window is
/// hidden, so nobody could answer a question, and a command that asks ends
/// instead of waiting for ever. With `capture`, both output streams go to
/// that file, so that the app can show what wsl.exe said. `None` when a path
/// holds a character cmd.exe would read as more than a path (`"`, `%`, `!`, a
/// line break): nothing with such a path may run as administrator.
///
/// The installer runs the same commands without `< nul` and the redirection:
/// its window shows wsl.exe's progress to the person at the PC.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn setup_params(wsl: &str, offer: WslSetupOffer, capture: Option<&str>) -> Option<String> {
    let plain = |s: &str| !s.contains(['"', '%', '!', '\r', '\n']);
    if !plain(wsl) || !capture.is_none_or(plain) {
        return None;
    }
    let commands = setup_commands(wsl, offer);
    Some(match capture {
        Some(file) => format!("/d /s /c \"({commands}) < nul > \"{file}\" 2>&1\""),
        None => format!("/d /s /c \"({commands}) < nul\""),
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

/// The setup through Windows: the app's own dialog (`TaskDialogIndirect`),
/// then `ShellExecuteExW` with the "runas" verb.
#[cfg(target_os = "windows")]
mod elevated {
    use std::ffi::OsStr;
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use windows_sys::core::{BOOL, HRESULT};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, WAIT_TIMEOUT, WPARAM};
    use windows_sys::Win32::System::Threading::{
        GetProcessId, GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER,
        TDF_POSITION_RELATIVE_TO_WINDOW, TDM_ENABLE_BUTTON, TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE, TDN_CREATED,
        TDN_TIMER,
    };

    use super::{
        buttons, decode_output, setup_params, Launch, Process, Question, SetupHost, WslSetupOffer, WslStatus,
        GO_BUTTON, NOT_NOW_BUTTON, QUESTION_TITLE,
    };

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

    /// The question's dialog: Esc and the close box allowed (a No), centred
    /// on its owner, its callback called about every 200 ms (`TDN_TIMER`),
    /// which lets the go button be pressed after [`super::GO_DELAY_MS`].
    pub(super) const DIALOG_FLAGS: i32 =
        TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW | TDF_CALLBACK_TIMER;

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

    /// When Windows started, in seconds since 1970: `now` less the time
    /// since the start (`GetTickCount64`, which counts sleep too).
    pub(super) fn boot_time(now: u64) -> u64 {
        use windows_sys::Win32::System::SystemInformation::GetTickCount64;
        // SAFETY: no arguments; reads the system's tick count.
        now.saturating_sub(unsafe { GetTickCount64() } / 1000)
    }

    /// Where Windows keeps its boot counter, `BootId`: one more at every
    /// start of Windows. Not documented by Microsoft (it is the prefetcher's);
    /// in the test VM (Windows 11 26200) it equals the starts in the System
    /// log (Kernel-General event 12).
    const BOOT_ID_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters";

    /// Windows' boot counter, when this Windows keeps one.
    pub(super) fn boot_id() -> Option<u32> {
        crate::modules::sandbox::win_registry::hklm_dword(BOOT_ID_KEY, "BootId")
    }

    /// The process behind `handle`: its id and creation time.
    pub(super) fn identify(handle: HANDLE) -> Option<Process> {
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: `handle` is a process handle with query rights; the
        // FILETIMEs are written by the call.
        let (pid, got) = unsafe {
            (GetProcessId(handle), GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user))
        };
        let created = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        (pid != 0 && got != 0).then_some(Process { pid, created })
    }

    /// This process: its id and creation time.
    pub(super) fn this_process() -> Option<Process> {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        // SAFETY: no arguments; the pseudo handle it returns needs no closing.
        identify(unsafe { GetCurrentProcess() })
    }

    /// `process` still runs: a process with its id and creation time exists
    /// and has not ended. Querying an elevated process's times and waiting
    /// on it is allowed to a program that is not elevated.
    pub(super) fn alive(process: Process) -> bool {
        // SAFETY: plain call; a null handle is checked below.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, process.pid) };
        if handle.is_null() {
            return false;
        }
        let same = identify(handle) == Some(process);
        // SAFETY: `handle` is the process handle opened above, closed once, here.
        let running = unsafe {
            let running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
            CloseHandle(handle);
            running
        };
        same && running
    }

    /// The app's main window, to own the question: this process's first
    /// visible top-level window without an owner; null when it has none (the
    /// server runs alone, or in a test).
    pub(super) fn main_window() -> HWND {
        use windows_sys::Win32::System::Threading::GetCurrentProcessId;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindow, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
        };
        unsafe extern "system" fn each(window: HWND, found: LPARAM) -> BOOL {
            let mut pid = 0u32;
            // SAFETY: `window` comes from EnumWindows; `found` is the HWND
            // slot `main_window` passed, alive for the whole enumeration.
            unsafe {
                GetWindowThreadProcessId(window, &mut pid);
                if pid == GetCurrentProcessId() && IsWindowVisible(window) != 0 && GetWindow(window, GW_OWNER).is_null() {
                    *(found as *mut HWND) = window;
                    return 0; // found: stop
                }
            }
            1
        }
        let mut found: HWND = std::ptr::null_mut();
        // SAFETY: `each` writes at most once into `found`, which outlives the call.
        unsafe { EnumWindows(Some(each), &mut found as *mut HWND as LPARAM) };
        found
    }

    /// `TaskDialogIndirect` (commctrl.h).
    pub(super) type TaskDialogIndirect =
        unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;

    /// `TaskDialogIndirect`, from the Common Controls 6 that this process's
    /// manifest asks for. The desktop app's does: tauri-build's default
    /// manifest names Microsoft.Windows.Common-Controls 6.0.0.0 (it is in the
    /// built txresbench-desktop.exe). `None` in a process without one (the
    /// server run by itself, a test): the comctl32 Windows loads then is the
    /// old one, which has no task dialog. Looked up, not linked, so that such
    /// a process still starts; the library stays loaded, so the function
    /// stays valid.
    pub(super) fn task_dialog() -> Option<TaskDialogIndirect> {
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
        let name = wide(OsStr::new("comctl32.dll"));
        // SAFETY: `name` is NUL-terminated and outlives the call.
        let module = unsafe { LoadLibraryW(name.as_ptr()) };
        if module.is_null() {
            return None;
        }
        // SAFETY: `module` is loaded; the name is NUL-terminated ASCII.
        let found = unsafe { GetProcAddress(module, b"TaskDialogIndirect\0".as_ptr()) }?;
        // SAFETY: comctl32's TaskDialogIndirect has this signature (commctrl.h).
        Some(unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirect>(found) })
    }

    /// The question's words, as the dialog reads them.
    pub(super) struct Dialog {
        title: Vec<u16>,
        text: Vec<u16>,
        labels: [(i32, Vec<u16>); 2],
    }

    impl Dialog {
        pub(super) fn new(title: &str, question: &Question) -> Self {
            let text = |s: &str| wide(OsStr::new(s));
            let labels = buttons(question).map(|(id, label)| (id, text(label)));
            Self { title: text(title), text: text(question.text), labels }
        }

        /// The dialog's buttons ([`buttons`]), pointing into `self`.
        pub(super) fn buttons(&self) -> [TASKDIALOG_BUTTON; 2] {
            self.labels.each_ref().map(|(id, label)| TASKDIALOG_BUTTON { nButtonID: *id, pszButtonText: label.as_ptr() })
        }

        /// The dialog, owned by `owner` (null: none), pointing into `self`
        /// and `buttons`, which must outlive its use: the question's words
        /// and its two buttons only, Not now the default ([`DIALOG_FLAGS`];
        /// [`on_dialog`] puts it above every window, in front, and greys the
        /// go button out for a moment).
        pub(super) fn config(&self, owner: HWND, buttons: &[TASKDIALOG_BUTTON; 2]) -> TASKDIALOGCONFIG {
            TASKDIALOGCONFIG {
                cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
                hwndParent: owner,
                dwFlags: DIALOG_FLAGS,
                pszWindowTitle: self.title.as_ptr(),
                pszContent: self.text.as_ptr(),
                cButtons: buttons.len() as u32,
                pButtons: buttons.as_ptr(),
                nDefaultButton: NOT_NOW_BUTTON,
                pfCallback: Some(on_dialog),
                ..Default::default()
            }
        }
    }

    /// The dialog's callback. Once the dialog is made (before it is shown),
    /// it goes above every window and in front (as a message box's
    /// MB_TOPMOST and MB_SETFOREGROUND), and the go button gets Windows'
    /// shield (it runs as administrator) and is greyed out. At the first
    /// timer tick [`super::GO_DELAY_MS`] or more after that, the go button
    /// can be pressed (again at every later tick: enabling an enabled button
    /// changes nothing). Every notification gets S_OK: S_FALSE would keep
    /// the dialog open after a button, or start the timer's count again.
    pub(super) unsafe extern "system" fn on_dialog(
        window: HWND,
        msg: u32,
        wparam: WPARAM,
        _: LPARAM,
        _: isize,
    ) -> HRESULT {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageW, SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        };
        // SAFETY: `window` is the dialog TaskDialogIndirect made (in a test,
        // a window of the test's own); the messages are the task dialog's.
        let to_go_button = |message: i32, on: LPARAM| unsafe {
            SendMessageW(window, message as u32, GO_BUTTON as WPARAM, on);
        };
        if msg == TDN_CREATED as u32 {
            // SAFETY: as above.
            unsafe {
                SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                SetForegroundWindow(window);
            }
            to_go_button(TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE, 1);
            to_go_button(TDM_ENABLE_BUTTON, 0);
        } else if msg == TDN_TIMER as u32 && super::go_ready(wparam) {
            // `wparam`: the milliseconds since the dialog was made.
            to_go_button(TDM_ENABLE_BUTTON, 1);
        }
        0 // S_OK
    }

    /// The app's question (`TaskDialogIndirect`, [`Dialog`]), owned by the
    /// app's main window when it has one; `true`: the go button. Without
    /// Common Controls 6 ([`task_dialog`]) nothing is shown and the answer is
    /// No. Never in a test: nobody could answer it (in the test VM, over SSH,
    /// it would wait for ever).
    fn ask(title: &str, question: &Question) -> bool {
        #[cfg(test)]
        panic!("the app's own dialog is never shown in a test ({title}: {question:?})");
        #[cfg(not(test))]
        {
            let Some(task_dialog) = task_dialog() else {
                tracing::warn!(
                    "sandbox: the WSL setup's question needs Common Controls 6 (the desktop app's manifest); \
                     this process has none, so the setup does not go on"
                );
                return false;
            };
            let dialog = Dialog::new(title, question);
            let buttons = dialog.buttons();
            let config = dialog.config(main_window(), &buttons);
            let mut button = 0;
            // SAFETY: `config` points into `dialog` and `buttons`, which
            // outlive the call; `button` is written by it; the radio button
            // and check box answers are not asked for (null).
            let result = unsafe { task_dialog(&config, &mut button, std::ptr::null_mut(), std::ptr::null_mut()) };
            super::goes_on(result, button)
        }
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
        fn confirm(&self, question: &Question) -> bool {
            ask(QUESTION_TITLE, question)
        }

        fn run_elevated(&self, offer: WslSetupOffer, started: &mut dyn FnMut(Process)) -> Launch {
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
            match shell_execute_wait(self.verb, &program, &params, &dir, show, started) {
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
    /// `started` gets the process once Windows started it.
    fn shell_execute_wait(
        verb: &str,
        program: &Path,
        params: &str,
        dir: &Path,
        show: i32,
        started: &mut dyn FnMut(Process),
    ) -> Result<Option<u32>, u32> {
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, INFINITE};
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
        if let Some(process) = identify(info.hProcess) {
            started(process);
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// A host that answers as told, and can hold the setup until released.
    struct FakeHost {
        yes: bool,
        launch: Mutex<Option<Launch>>,
        after: WslStatus,
        hold: Mutex<Option<mpsc::Receiver<()>>>,
        /// Holds the setup at its question until released.
        hold_question: Mutex<Option<mpsc::Receiver<()>>>,
        questions: Mutex<Vec<Question>>,
        offers: Mutex<Vec<WslSetupOffer>>,
        /// The elevated process it reports as started.
        process: Option<Process>,
        /// The setup's thread panics in `run_elevated`.
        panics: bool,
    }

    impl FakeHost {
        fn new(launch: Launch, after: WslStatus) -> Self {
            Self {
                yes: true,
                launch: Mutex::new(Some(launch)),
                after,
                hold: Mutex::new(None),
                hold_question: Mutex::new(None),
                questions: Mutex::new(Vec::new()),
                offers: Mutex::new(Vec::new()),
                process: Some(PROCESS),
                panics: false,
            }
        }

        fn held(launch: Launch, after: WslStatus) -> (Arc<Self>, mpsc::Sender<()>) {
            let (tx, rx) = mpsc::channel();
            let host = Self::new(launch, after);
            *host.hold.lock().unwrap() = Some(rx);
            (Arc::new(host), tx)
        }

        fn held_at_question(launch: Launch, after: WslStatus) -> (Arc<Self>, mpsc::Sender<()>) {
            let (tx, rx) = mpsc::channel();
            let host = Self::new(launch, after);
            *host.hold_question.lock().unwrap() = Some(rx);
            (Arc::new(host), tx)
        }

        fn offers(&self) -> Vec<WslSetupOffer> {
            self.offers.lock().unwrap().clone()
        }

        fn questions(&self) -> Vec<Question> {
            self.questions.lock().unwrap().clone()
        }
    }

    impl SetupHost for FakeHost {
        fn confirm(&self, question: &Question) -> bool {
            self.questions.lock().unwrap().push(*question);
            if let Some(rx) = self.hold_question.lock().unwrap().take() {
                let _ = rx.recv();
            }
            self.yes
        }
        fn run_elevated(&self, offer: WslSetupOffer, started: &mut dyn FnMut(Process)) -> Launch {
            self.offers.lock().unwrap().push(offer);
            if let Some(process) = self.process {
                started(process);
            }
            if let Some(rx) = self.hold.lock().unwrap().take() {
                let _ = rx.recv();
            }
            assert!(!self.panics, "the setup's thread fails");
            self.launch.lock().unwrap().take().expect("one launch per fake")
        }
        fn status_now(&self) -> WslStatus {
            self.after
        }
    }

    /// The setup's elevated process.
    const PROCESS: Process = Process { pid: 4242, created: 133_000_000_000_000_000 };
    /// The app (the tests' state), a second app open beside it, and an app
    /// closed since.
    const APP: Process = Process { pid: 1000, created: 132_000_000_000_000_000 };
    const OTHER_APP: Process = Process { pid: 2000, created: 132_500_000_000_000_000 };
    const CLOSED_APP: Process = Process { pid: 900, created: 131_000_000_000_000_000 };
    const T0: u64 = 1_800_000_000;
    const BOOT: u64 = T0 - 3600;

    /// A PC with a clock to move, a start time to change, processes to end,
    /// and a marker file in a test dir (or none), seen by one app process.
    struct FakeMachine {
        now: AtomicU64,
        boot: Mutex<Option<u64>>,
        /// Windows' boot counter (none unless a test sets it).
        boot_id: Mutex<Option<u32>>,
        /// The processes that run (shared with the apps [`FakeMachine::beside`]).
        running: Arc<Mutex<Vec<Process>>>,
        /// This app's process.
        this: Process,
        marker: Option<PathBuf>,
    }

    impl FakeMachine {
        fn new(marker: Option<PathBuf>) -> Arc<Self> {
            Arc::new(Self {
                now: AtomicU64::new(T0),
                boot: Mutex::new(Some(BOOT)),
                boot_id: Mutex::new(None),
                running: Arc::new(Mutex::new(vec![PROCESS, APP, OTHER_APP])),
                this: APP,
                marker,
            })
        }
        /// A second app open beside this one: the same PC (clock, start,
        /// processes, marker file).
        fn beside(&self) -> Arc<Self> {
            Arc::new(Self {
                now: AtomicU64::new(self.now()),
                boot: Mutex::new(self.boot_time()),
                boot_id: Mutex::new(self.boot_id()),
                running: Arc::clone(&self.running),
                this: OTHER_APP,
                marker: self.marker.clone(),
            })
        }
        fn pass(&self, secs: u64) {
            self.now.fetch_add(secs, Ordering::SeqCst);
        }
        fn end(&self, process: Process) {
            self.running.lock().unwrap().retain(|&p| p != process);
        }
        fn run(&self, process: Process) {
            self.running.lock().unwrap().push(process);
        }
    }

    impl Machine for FakeMachine {
        fn now(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }
        fn boot_time(&self) -> Option<u64> {
            *self.boot.lock().unwrap()
        }
        fn boot_id(&self) -> Option<u32> {
            *self.boot_id.lock().unwrap()
        }
        fn alive(&self, process: Process) -> bool {
            self.running.lock().unwrap().contains(&process)
        }
        fn this_process(&self) -> Option<Process> {
            Some(self.this)
        }
        fn marker(&self) -> Option<PathBuf> {
            self.marker.clone()
        }
    }

    /// A test's own dir, removed when dropped.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("txr-wsl-setup-{tag}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn marker(&self) -> PathBuf {
            self.0.join(MARKER_FILE)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn exited(code: u32, output: &str) -> Launch {
        Launch::Exited { code: Some(code), output: output.to_string() }
    }

    /// Wait for `cond`, failing (never hanging) after 10 s.
    fn until(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond() {
            assert!(Instant::now() < deadline, "waited 10 s for: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Start a setup and wait for its end: the result kept.
    fn run_on(state: &Arc<SetupState>, boot: WslStatus, host: Arc<FakeHost>) -> WslSetupResult {
        let started = start(state, Some(boot), host).expect("offered");
        assert!(started.running, "the answer says the setup runs");
        until("the setup's end", || !state.status(Some(boot)).running);
        state.status(Some(boot)).last.expect("the result is kept")
    }

    fn run_once(boot: WslStatus, launch: Launch, after: WslStatus) -> (WslSetupResult, Vec<WslSetupOffer>) {
        let host = Arc::new(FakeHost::new(launch, after));
        let state = SetupState::new(FakeMachine::new(None));
        let result = run_on(&state, boot, host.clone());
        (result, host.offers())
    }

    fn status(offer: Option<WslSetupOffer>, running: bool, last: Option<WslSetupResult>) -> WslSetupStatus {
        WslSetupStatus { offer, running, last, retry_in_secs: None }
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

    #[test]
    fn nothing_offered_is_refused_with_its_code_and_runs_nothing() {
        // No probe status: not Windows, methods can run, or the probe failed
        // for a reason that is not WSL's (the app's WSL runtime is missing).
        let host = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        let dir = TestDir::new("refused");
        let state = SetupState::new(FakeMachine::new(Some(dir.marker())));
        for boot in [
            None,
            Some(WslStatus::Emulated),
            Some(WslStatus::Policy),
            Some(WslStatus::NoWslExe),
            Some(WslStatus::Ready),
            // The installer turns the Virtual Machine Platform on for this
            // status; the app does not offer it (see `offer_for`).
            Some(WslStatus::ReadyAfterRestart),
        ] {
            let e = start(&state, boot, host.clone()).expect_err("not offered");
            assert_eq!(e.status_code(), 409, "{boot:?}");
            assert_eq!(e.error_code(), WSL_SETUP_NOT_OFFERED_CODE, "{boot:?}");
        }
        assert!(host.questions().is_empty() && host.offers().is_empty(), "nothing asked, nothing ran");
        assert_eq!(state.status(None), status(None, false, None), "nothing changed");
        assert!(!dir.marker().exists(), "no marker");
    }

    /// Only the desktop app offers a setup: elsewhere (a headless server)
    /// every status the probe can find is nothing to set up, so the notice
    /// has no offer and the route refuses without asking anything.
    #[test]
    fn only_the_desktop_app_offers_a_setup() {
        for s in WslStatus::ALL {
            assert_eq!(offered_for(true, Some(s)), Some(s), "{s:?}");
            assert_eq!(offered_for(false, Some(s)), None, "{s:?}");
        }
        assert_eq!(offered_for(true, None), None);

        let host = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        let dir = TestDir::new("headless");
        let state = SetupState::new(FakeMachine::new(Some(dir.marker())));
        for boot in [WslStatus::Missing, WslStatus::Old, WslStatus::Legacy] {
            assert!(state.status(offered_for(true, Some(boot))).offer.is_some(), "{boot:?} in the desktop app");
            assert_eq!(state.status(offered_for(false, Some(boot))), status(None, false, None), "{boot:?}");
            let e = start(&state, offered_for(false, Some(boot)), host.clone()).expect_err("not the desktop app");
            assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_NOT_OFFERED_CODE), "{boot:?}");
        }
        assert!(host.questions().is_empty() && host.offers().is_empty(), "nothing asked, nothing ran");
        assert!(!dir.marker().exists(), "no marker");
    }

    /// A test process is not the desktop app (only `boot_in_background`
    /// marks one, see the next test), so it offers nothing for any status the
    /// probe can find, as a headless server; and its route refuses.
    #[test]
    fn a_process_not_marked_as_the_desktop_app_offers_nothing() {
        for s in WslStatus::ALL {
            assert_eq!(offered(Some(s)), None, "{s:?}");
        }
        let e = start_here().expect_err("nothing offered");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_NOT_OFFERED_CODE));
    }

    /// The desktop app's start (`boot_in_background`) marks the process, and
    /// nothing else does: the headless server (`serve_blocking`) offers no
    /// setup. `mark_desktop_app` is crate-private, so only this crate's
    /// sources can call it; they are read here, as no test can boot either
    /// server.
    #[test]
    fn only_the_desktop_apps_start_marks_the_desktop_app() {
        fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("read the source dir") {
                let path = entry.expect("a source dir entry").path();
                if path.is_dir() {
                    rust_files(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        assert!(files.len() > 100, "the crate's sources: {}", files.len());
        let callers: Vec<&PathBuf> = files
            .iter()
            .filter(|f| !f.ends_with(Path::new("modules").join("sandbox").join("wsl_setup.rs")))
            .filter(|f| std::fs::read_to_string(f).expect("a source file").contains("mark_desktop_app"))
            .collect();
        assert_eq!(callers, [&src.join("lib.rs")], "only lib.rs names it");

        // The probe's status reaches the notice and the route only through
        // `offered`.
        let this = include_str!("wsl_setup.rs");
        let code = &this[..this.find("#[cfg(test)]\nmod tests {").expect("the tests module")];
        assert_eq!(code.matches("probe_wsl_status").count(), 1);
        assert_eq!(code.matches("offered(super::wsl_run::probe_wsl_status())").count(), 1);
        // This module's own code only defines the mark (the scan above skips it).
        assert_eq!(code.matches("mark_desktop_app(").count(), 1);

        let lib = include_str!("../../lib.rs");
        let body = |name: &str| {
            let start = lib.find(&format!("pub async fn {name}(")).unwrap_or_else(|| panic!("{name} in lib.rs"));
            let len = lib[start..].find("\n}\n").unwrap_or_else(|| panic!("the end of {name}"));
            &lib[start..start + len]
        };
        assert_eq!(body("boot_in_background").matches("wsl_setup::mark_desktop_app();").count(), 1);
        assert!(!body("serve_blocking").contains("mark_desktop_app"));
        assert_eq!(lib.matches("mark_desktop_app").count(), 1, "called once, in boot_in_background");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn elsewhere_than_windows_nothing_is_offered() {
        assert_eq!(boot_status(), None);
        assert_eq!(notice(), None);
        assert_eq!(SystemMachine.marker(), None, "no marker file elsewhere");
    }

    #[test]
    fn the_offer_decides_the_commands() {
        let (_, offers) = run_once(WslStatus::Missing, exited(0, ""), WslStatus::ReadyAfterRestart);
        assert_eq!(offers, [WslSetupOffer::Install]);
        for boot in [WslStatus::Old, WslStatus::Legacy] {
            let (_, offers) = run_once(boot, exited(0, ""), WslStatus::Ready);
            assert_eq!(offers, [WslSetupOffer::Update], "{boot:?}");
        }
    }

    /// The person at the PC is asked in the app's own dialog before anything
    /// runs as administrator (Windows may not ask: UAC off or never notify,
    /// or the app itself run as administrator). No runs nothing.
    #[test]
    fn nothing_runs_as_administrator_before_a_yes_in_the_apps_own_dialog() {
        for boot in [WslStatus::Missing, WslStatus::Old, WslStatus::Legacy] {
            let host = Arc::new(FakeHost { yes: false, ..FakeHost::new(exited(0, ""), WslStatus::Ready) });
            let state = SetupState::new(FakeMachine::new(None));
            let r = run_on(&state, boot, host.clone());
            assert_eq!(r, WslSetupResult::of(WslSetupOutcome::Declined), "{boot:?}");
            assert_eq!(host.questions(), [question(boot)], "asked once, the question for {boot:?}");
            assert!(host.offers().is_empty(), "nothing ran as administrator: {boot:?}");
        }
        // Yes: asked first, then run.
        let host = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        let r = run_on(&SetupState::new(FakeMachine::new(None)), WslStatus::Missing, host.clone());
        assert_eq!(r, WslSetupResult::done(true));
        assert_eq!((host.questions().len(), host.offers()), (1, vec![WslSetupOffer::Install]));
    }

    #[test]
    fn the_question_says_what_happens_and_where_it_came_from() {
        for (status, verb) in
            [(WslStatus::Missing, "Install WSL 2 now?"), (WslStatus::Old, "Update WSL now?"), (WslStatus::Legacy, "Update WSL now?")]
        {
            let q = question(status).text;
            for words in [
                verb,
                "Microsoft",
                "about 400 MB",
                "Windows may also ask for permission",
                "with TxResBench's",
                "AI assistant",
                // Any program on this PC can start a setup, not only the app.
                "or by another program on this PC.",
                "If you did not ask for this, choose Not now.",
            ] {
                assert!(q.contains(words), "{status:?}: {words:?} in {q:?}");
            }
            assert!(!q.contains("To change nothing"), "{status:?}: {q:?}");
            // With UAC off or never notifying, or the app run as administrator,
            // Windows asks nothing: the question never says it will.
            assert!(!q.contains("will ask") && !q.contains("asks next"), "{status:?}: {q:?}");
        }
        assert!(question(WslStatus::Missing).text.contains("usually needs a restart"));
        let legacy = question(WslStatus::Legacy).text;
        assert!(legacy.contains("older kind") && legacy.contains("may need a restart"));
        assert!(question(WslStatus::Old).text.contains("security flaw"));
    }

    /// The question's buttons: the setup's own verb and Not now. No label has
    /// an `&`, so no letter key presses one (a "y" typed into the app as a
    /// message box's "&Yes" came up would have said Yes). Only the go button
    /// goes on: Not now, Esc or the close box (IDCANCEL), and a dialog
    /// Windows did not show are a No.
    #[test]
    fn the_question_cannot_be_answered_by_a_letter_key() {
        for (status, go) in [(WslStatus::Missing, "Install WSL"), (WslStatus::Old, "Update WSL"), (WslStatus::Legacy, "Update WSL")] {
            let q = question(status);
            assert_eq!(buttons(&q), [(GO_BUTTON, go), (NOT_NOW_BUTTON, NOT_NOW)], "{status:?}");
            assert!(buttons(&q).iter().all(|(_, label)| !label.contains('&')), "{status:?}");
            assert_ne!(GO_BUTTON, NOT_NOW_BUTTON);
            // The words name the buttons the dialog has.
            assert!(q.text.contains(NOT_NOW) && !q.text.contains("Yes") && !q.text.contains("Choose No"), "{q:?}");
        }
        assert_eq!(NOT_NOW, "Not now");
        assert!(goes_on(0, GO_BUTTON));
        const IDCANCEL: i32 = 2;
        const E_OUTOFMEMORY: i32 = 0x8007_000E_u32 as i32;
        for (result, button) in [(0, NOT_NOW_BUTTON), (0, IDCANCEL), (0, 0), (E_OUTOFMEMORY, GO_BUTTON), (1, GO_BUTTON)] {
            assert!(!goes_on(result, button), "{result:#x} {button}");
        }
    }

    /// The go button can be pressed only a second after the dialog was
    /// made, so that a click aimed elsewhere as it appears is not a Yes.
    #[test]
    fn the_go_button_waits_a_second_before_it_can_be_pressed() {
        assert_eq!(GO_DELAY_MS, 1000);
        for ms in [0, 200, 400, 600, 800, 999] {
            assert!(!go_ready(ms), "{ms} ms");
        }
        for ms in [1000, 1001, 1200, 60_000] {
            assert!(go_ready(ms), "{ms} ms");
        }
    }

    #[test]
    fn a_setup_after_which_the_check_says_ready_is_done() {
        // Installed where WSL was missing: Windows restarts (the check may
        // not know it yet).
        let (r, _) = run_once(WslStatus::Missing, exited(0, "The operation completed successfully."), WslStatus::Ready);
        assert_eq!(r, WslSetupResult::done(true));
        // Updated from the WSL that came with Windows: a restart too.
        let (r, _) = run_once(WslStatus::Legacy, exited(0, ""), WslStatus::Ready);
        assert_eq!(r, WslSetupResult::done(true));
        // An old WSL updated: no restart unless the check asks for one.
        let (r, _) = run_once(WslStatus::Old, exited(0, ""), WslStatus::Ready);
        assert_eq!(r, WslSetupResult::done(false));
        let (r, _) = run_once(WslStatus::Old, exited(0, ""), WslStatus::ReadyAfterRestart);
        assert_eq!(r, WslSetupResult::done(true));
        // The check decides, not the exit code (as in the installer).
        let (r, _) = run_once(WslStatus::Old, exited(1, "already up to date"), WslStatus::Ready);
        assert_eq!(r.outcome, WslSetupOutcome::Done);
    }

    #[test]
    fn no_to_the_permission_prompt_is_declined() {
        let (r, _) = run_once(WslStatus::Missing, Launch::NotStarted { error: 1223 }, WslStatus::Missing);
        assert_eq!(r, WslSetupResult::of(WslSetupOutcome::Declined));
        assert_eq!(ERROR_CANCELLED, 1223);
    }

    #[test]
    fn another_windows_error_is_not_started() {
        let (r, _) = run_once(WslStatus::Missing, Launch::NotStarted { error: 2 }, WslStatus::Missing);
        assert_eq!(r.outcome, WslSetupOutcome::NotStarted);
        assert_eq!(r.windows_error, Some(2));
    }

    #[test]
    fn a_setup_after_which_wsl_is_still_missing_failed_with_its_code_and_words() {
        let printed = "Installing: Windows Subsystem for Linux\r\n[====      20.0%      ]\r[==========100.0%==========]\r\n\
                       Catastrophic failure \r\nError code: Wsl/InstallLibrary/0x8000ffff\r\n";
        let (r, _) = run_once(WslStatus::Missing, exited(0x8000_FFFF, printed), WslStatus::Missing);
        assert_eq!(r.outcome, WslSetupOutcome::Failed);
        assert_eq!(r.exit_code, Some(0x8000_FFFF));
        assert_eq!(
            r.output,
            "Installing: Windows Subsystem for Linux\nCatastrophic failure\nError code: Wsl/InstallLibrary/0x8000ffff"
        );
        // Exit 0 but still too old: failed too (the check decides).
        let (r, _) = run_once(WslStatus::Old, exited(0, ""), WslStatus::Old);
        assert_eq!(r, WslSetupResult::failed(Some(0), String::new()));
    }

    /// As in the installer: where WSL was missing or of the old kind, exit 0
    /// with the check still finding it so is a setup Windows must restart to
    /// finish. Any other code, an unknown one, or another status before or
    /// after is a failure.
    #[test]
    fn exit_0_where_wsl_stays_missing_or_old_kind_waits_for_a_restart() {
        for (before, after) in [
            (WslStatus::Missing, WslStatus::Missing),
            (WslStatus::Missing, WslStatus::Legacy),
            (WslStatus::Legacy, WslStatus::Legacy),
            (WslStatus::Legacy, WslStatus::Missing),
        ] {
            let (r, _) = run_once(before, exited(0, "Restart Windows to finish."), after);
            assert_eq!(r, WslSetupResult::done(true), "{before:?} -> {after:?}");
        }
        for (before, launch, after) in [
            (WslStatus::Missing, exited(1, "no"), WslStatus::Missing),
            (WslStatus::Legacy, Launch::Exited { code: None, output: String::new() }, WslStatus::Legacy),
            (WslStatus::Missing, exited(0, ""), WslStatus::Old),
            (WslStatus::Old, exited(0, ""), WslStatus::Legacy),
        ] {
            let (r, _) = run_once(before, launch, after);
            assert_eq!(r.outcome, WslSetupOutcome::Failed, "{before:?} -> {after:?}");
        }
    }

    /// As in the installer: the check saying WSL is ready after a restart
    /// counts only after exit 0. After a failed setup (or an unknown code) it
    /// cannot tell the Virtual Machine Platform turned on from one still off:
    /// failed with the code and words, no restart asked for.
    #[test]
    fn ready_after_a_restart_counts_only_after_exit_0() {
        for before in [WslStatus::Missing, WslStatus::Old, WslStatus::Legacy] {
            let (r, _) = run_once(before, exited(0, ""), WslStatus::ReadyAfterRestart);
            assert_eq!(r, WslSetupResult::done(true), "{before:?}");
            let (r, _) = run_once(before, exited(1, "Catastrophic failure"), WslStatus::ReadyAfterRestart);
            assert_eq!(r, WslSetupResult::failed(Some(1), "Catastrophic failure".into()), "{before:?}");
            let launch = Launch::Exited { code: None, output: String::new() };
            let (r, _) = run_once(before, launch, WslStatus::ReadyAfterRestart);
            assert_eq!(r, WslSetupResult::failed(None, String::new()), "{before:?}");
        }
        // Ready now still wins over a failing code.
        let (r, _) = run_once(WslStatus::Missing, exited(1, ""), WslStatus::Ready);
        assert_eq!(r, WslSetupResult::done(true));
    }

    /// The POST answers as soon as the setup started (its status: running),
    /// not at its end; the result is read from the status afterwards.
    #[test]
    fn the_answer_comes_at_the_start_and_one_setup_runs_at_a_time() {
        let state = SetupState::new(FakeMachine::new(None));
        let (host, release) = FakeHost::held(exited(0, ""), WslStatus::ReadyAfterRestart);
        let answer = start(&state, Some(WslStatus::Missing), host.clone()).expect("started");
        assert_eq!(answer, status(Some(WslSetupOffer::Install), true, None), "answered while the setup is held");
        let e = start(&state, Some(WslStatus::Missing), host.clone()).expect_err("one is running");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_RUNNING_CODE));
        assert_eq!(state.status(Some(WslStatus::Missing)), status(Some(WslSetupOffer::Install), true, None));

        release.send(()).unwrap();
        until("the setup's end", || !state.status(None).running);
        assert_eq!(host.offers(), [WslSetupOffer::Install], "the refused call ran nothing");
        let s = state.status(Some(WslStatus::Missing));
        assert_eq!(s, status(None, false, Some(WslSetupResult::done(true))), "done: no offer, the result kept");
        let e = start(&state, Some(WslStatus::Missing), host).expect_err("done");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_NOT_OFFERED_CODE));
    }

    #[test]
    fn a_failed_setup_can_be_run_again_at_once() {
        let machine = FakeMachine::new(None);
        let state = SetupState::new(machine);
        for launch in [exited(1, "no"), Launch::NotStarted { error: 2 }] {
            let host = Arc::new(FakeHost::new(launch, WslStatus::Old));
            run_on(&state, WslStatus::Old, host);
            let s = state.status(Some(WslStatus::Old));
            assert_eq!((s.offer, s.retry_in_secs), (Some(WslSetupOffer::Update), None));
        }
    }

    /// After a No (in the app's dialog or in Windows' prompt) the setup is
    /// not offered for a minute, so that a caller cannot ask again and again.
    #[test]
    fn a_declined_setup_is_not_offered_again_for_a_minute() {
        for (yes, launch) in [(false, exited(0, "")), (true, Launch::NotStarted { error: ERROR_CANCELLED })] {
            let machine = FakeMachine::new(None);
            let state = SetupState::new(machine.clone());
            let host = Arc::new(FakeHost { yes, ..FakeHost::new(launch, WslStatus::Missing) });
            assert_eq!(run_on(&state, WslStatus::Missing, host).outcome, WslSetupOutcome::Declined);

            let s = state.status(Some(WslStatus::Missing));
            assert_eq!((s.offer, s.retry_in_secs), (Some(WslSetupOffer::Install), Some(DECLINE_PAUSE_SECS)));
            machine.pass(45);
            let again = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
            let e = start(&state, Some(WslStatus::Missing), again.clone()).expect_err("declined a moment ago");
            assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_DECLINED_RECENTLY_CODE));
            assert!(e.to_string().contains("in 15 s"), "{e}");
            assert_eq!(state.status(Some(WslStatus::Missing)).retry_in_secs, Some(15));
            assert!(again.questions().is_empty(), "not asked again");

            machine.pass(15);
            assert_eq!(state.status(Some(WslStatus::Missing)).retry_in_secs, None);
            assert_eq!(run_on(&state, WslStatus::Missing, again).outcome, WslSetupOutcome::Done, "offered again");
        }
    }

    /// A No in one app pauses the setup in a second app open beside it (and
    /// in the app reopened), from the moment the setup ended: the marker
    /// says when. Here the question was up for 30 s before the No.
    #[test]
    fn a_decline_in_one_app_pauses_the_setup_in_another_beside_it() {
        let dir = TestDir::new("declined-beside");
        let first = FakeMachine::new(Some(dir.marker()));
        let state = SetupState::new(first.clone());
        let (tx, rx) = mpsc::channel();
        let host = FakeHost { yes: false, ..FakeHost::new(exited(0, ""), WslStatus::Missing) };
        *host.hold_question.lock().unwrap() = Some(rx);
        let host = Arc::new(host);
        start(&state, Some(WslStatus::Missing), host.clone()).expect("started");
        until("the question is up", || !host.questions().is_empty());
        first.pass(30);
        tx.send(()).unwrap();
        until("the setup's end", || !state.status(None).running);
        assert_eq!(state.status(Some(WslStatus::Missing)).last, Some(WslSetupResult::of(WslSetupOutcome::Declined)));
        let marker = read_marker(&dir.marker()).expect("the marker");
        assert_eq!((marker.started_at, marker.ended_at), (T0, Some(T0 + 30)), "when it started and ended");

        first.pass(20);
        let beside = first.beside();
        let second = SetupState::new(beside.clone());
        let s = second.status(Some(WslStatus::Missing));
        assert_eq!((s.offer, s.running, s.retry_in_secs), (Some(WslSetupOffer::Install), false, Some(40)), "{s:?}");
        let other = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        let e = start(&second, Some(WslStatus::Missing), other.clone()).expect_err("declined in the first app");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_DECLINED_RECENTLY_CODE));
        assert!(e.to_string().contains("in 40 s"), "{e}");
        assert!(other.questions().is_empty() && other.offers().is_empty(), "the second app asked and ran nothing");
        // The first app reopened: paused too.
        assert_eq!(SetupState::new(first.clone()).status(Some(WslStatus::Missing)).retry_in_secs, Some(40));

        // After the pause the second app asks, and gets a No: the first
        // app's own decline is over, the second app's pauses it.
        beside.pass(40);
        assert_eq!(second.status(Some(WslStatus::Missing)).retry_in_secs, None);
        let no = Arc::new(FakeHost { yes: false, ..FakeHost::new(exited(0, ""), WslStatus::Missing) });
        assert_eq!(run_on(&second, WslStatus::Missing, no.clone()).outcome, WslSetupOutcome::Declined, "offered again");
        assert_eq!(no.questions().len(), 1);
        first.pass(45);
        assert_eq!(state.status(Some(WslStatus::Missing)).retry_in_secs, Some(55), "the later decline counts");
        let e = start(&state, Some(WslStatus::Missing), other.clone()).expect_err("declined in the second app");
        assert_eq!(e.error_code(), WSL_SETUP_DECLINED_RECENTLY_CODE);
        first.pass(55);
        assert_eq!(run_on(&state, WslStatus::Missing, other).outcome, WslSetupOutcome::Done, "offered again");
    }

    /// The setup's thread that panics ends the setup as failed: the slot is
    /// freed and the result kept, so the notice says it ended.
    #[test]
    fn a_setup_thread_that_panics_frees_the_slot_and_keeps_a_failure() {
        let dir = TestDir::new("panic");
        let state = SetupState::new(FakeMachine::new(Some(dir.marker())));
        let host = Arc::new(FakeHost { panics: true, ..FakeHost::new(exited(0, ""), WslStatus::Ready) });
        let r = run_on(&state, WslStatus::Missing, host);
        assert_eq!(r, WslSetupResult::failed(None, String::new()));
        assert_eq!(read_marker(&dir.marker()).and_then(|m| m.result), Some(r), "the marker says it ended");
    }

    /// The marker follows the setup: written at the start, when the elevated
    /// process started, and at the end.
    #[test]
    fn the_marker_follows_the_setup() {
        let dir = TestDir::new("marker");
        let machine = FakeMachine::new(Some(dir.marker()));
        let state = SetupState::new(machine.clone());
        let (host, release) = FakeHost::held(exited(0, ""), WslStatus::Missing);
        start(&state, Some(WslStatus::Missing), host).expect("started");
        assert_eq!(
            read_marker(&dir.marker()).map(|m| (m.started_at, m.boot_time)),
            Some((T0, Some(BOOT))),
            "written at the start"
        );
        until("the process in the marker", || read_marker(&dir.marker()).is_some_and(|m| m.process.is_some()));
        assert_eq!(
            read_marker(&dir.marker()),
            Some(Marker {
                started_at: T0,
                boot_time: Some(BOOT),
                boot_id: None,
                app: Some(APP),
                process: Some(PROCESS),
                result: None,
                ended_at: None
            })
        );
        release.send(()).unwrap();
        until("the setup's end", || !state.status(None).running);
        assert_eq!(
            read_marker(&dir.marker()),
            Some(Marker {
                started_at: T0,
                boot_time: Some(BOOT),
                boot_id: None,
                app: Some(APP),
                process: Some(PROCESS),
                result: Some(WslSetupResult::done(true)),
                ended_at: Some(T0)
            })
        );
    }

    /// A reopened app (a new state on the same marker) while the first
    /// app's elevated setup still runs: running, and no second setup. When
    /// that process ends, the setup is offered again (its result is not
    /// known).
    #[test]
    fn a_reopened_app_does_not_start_a_second_setup_beside_a_running_one() {
        let dir = TestDir::new("reopened-running");
        let machine = FakeMachine::new(Some(dir.marker()));
        let marker = Marker {
            started_at: T0,
            boot_time: Some(BOOT),
            boot_id: None,
            app: Some(CLOSED_APP),
            process: Some(PROCESS),
            result: None,
            ended_at: None,
        };
        write_marker(&dir.marker(), &marker).unwrap();

        let reopened = SetupState::new(machine.clone());
        let host = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        assert_eq!(reopened.status(Some(WslStatus::Missing)), status(Some(WslSetupOffer::Install), true, None));
        let e = start(&reopened, Some(WslStatus::Missing), host.clone()).expect_err("one is running");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_RUNNING_CODE));
        assert!(host.questions().is_empty());

        machine.end(PROCESS);
        assert_eq!(reopened.status(Some(WslStatus::Missing)), status(Some(WslSetupOffer::Install), false, None));
        assert_eq!(run_on(&reopened, WslStatus::Missing, host).outcome, WslSetupOutcome::Done);

        // The app closed at its question: no process ever started.
        let at_question = Marker { process: None, ..marker };
        write_marker(&dir.marker(), &at_question).unwrap();
        machine.run(PROCESS);
        let reopened = SetupState::new(machine);
        assert!(!reopened.status(Some(WslStatus::Missing)).running);
    }

    /// A second app open beside the first (the desktop app does not keep to
    /// one window) while the first one's question is up: no elevated process
    /// yet, but the marker names the first app, which is open. The second app
    /// sees the setup running and starts none. Once the first app is closed
    /// at its question, the setup is offered again.
    #[test]
    fn a_second_app_starts_no_setup_while_the_first_one_asks() {
        let dir = TestDir::new("second-app");
        let first = FakeMachine::new(Some(dir.marker()));
        let state = SetupState::new(first.clone());
        let (host, release) = FakeHost::held_at_question(exited(0, ""), WslStatus::Ready);
        start(&state, Some(WslStatus::Missing), host.clone()).expect("started");
        until("the question is up", || !host.questions().is_empty());
        let marker = read_marker(&dir.marker()).expect("the marker");
        assert_eq!((marker.app, marker.process, marker.result), (Some(APP), None, None), "the app that asks");

        let beside = SetupState::new(first.beside());
        assert_eq!(beside.status(Some(WslStatus::Missing)), status(Some(WslSetupOffer::Install), true, None));
        let other = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        let e = start(&beside, Some(WslStatus::Missing), other.clone()).expect_err("the first app asks");
        assert_eq!((e.status_code(), e.error_code()), (409, WSL_SETUP_RUNNING_CODE));
        assert!(other.questions().is_empty() && other.offers().is_empty(), "the second app asked and ran nothing");

        // The first app closed at its question: nothing ran there.
        first.end(APP);
        assert_eq!(beside.status(Some(WslStatus::Missing)), status(Some(WslSetupOffer::Install), false, None));
        release.send(()).unwrap();
        until("the first app's setup ends", || !state.status(None).running);
    }

    /// A marker this app wrote without a result (its end was not written):
    /// no setup of its own runs (it would hold the slot), but a second app
    /// beside it, seeing this app open, waits. The app that started a setup
    /// whose elevated process ended is still keeping its result: running.
    /// A marker of an older build (no app) reads as before.
    #[test]
    fn a_marker_without_a_result_runs_while_another_app_that_wrote_it_is_open() {
        let dir = TestDir::new("own-marker");
        let machine = FakeMachine::new(Some(dir.marker()));
        let marker = Marker {
            started_at: T0,
            boot_time: Some(BOOT),
            boot_id: None,
            app: Some(APP),
            process: None,
            result: None,
            ended_at: None,
        };
        write_marker(&dir.marker(), &marker).unwrap();
        assert!(!SetupState::new(machine.clone()).status(Some(WslStatus::Missing)).running, "this app's own marker");
        assert!(SetupState::new(machine.beside()).status(Some(WslStatus::Missing)).running, "the other app is open");

        machine.end(PROCESS);
        write_marker(&dir.marker(), &Marker { process: Some(PROCESS), ..marker }).unwrap();
        assert!(SetupState::new(machine.beside()).status(Some(WslStatus::Missing)).running, "its app keeps the result");
        machine.end(APP);
        assert!(!SetupState::new(machine.beside()).status(Some(WslStatus::Missing)).running, "both gone");

        let older = serde_json::json!({ "started_at": T0, "boot_time": BOOT, "process": null, "result": null });
        std::fs::write(dir.marker(), older.to_string()).unwrap();
        assert_eq!(read_marker(&dir.marker()).map(|m| m.app), Some(None), "read, with no app");
        assert!(!SetupState::new(machine.beside()).status(Some(WslStatus::Missing)).running);
    }

    /// A reopened app after a setup that is done and waits for a restart:
    /// "restart Windows" until Windows started again, then the probe decides.
    #[test]
    fn a_reopened_app_says_restart_windows_until_windows_restarted() {
        let dir = TestDir::new("reopened-restart");
        let machine = FakeMachine::new(Some(dir.marker()));
        let state = SetupState::new(machine.clone());
        let r = run_on(&state, WslStatus::Missing, Arc::new(FakeHost::new(exited(0, ""), WslStatus::Missing)));
        assert_eq!(r, WslSetupResult::done(true));

        machine.pass(600);
        let reopened = SetupState::new(machine.clone());
        let s = reopened.status(Some(WslStatus::Missing));
        assert_eq!(s, status(None, false, Some(WslSetupResult::done(true))), "restart Windows, no offer");
        let host = Arc::new(FakeHost::new(exited(0, ""), WslStatus::Ready));
        let e = start(&reopened, Some(WslStatus::Missing), host.clone()).expect_err("waits for a restart");
        assert_eq!(e.error_code(), WSL_SETUP_NOT_OFFERED_CODE);
        assert!(e.to_string().contains("restart Windows"), "{e}");
        // The clock's reading of the start moves by a second or so.
        *machine.boot.lock().unwrap() = Some(BOOT + 2);
        assert_eq!(SetupState::new(machine.clone()).status(Some(WslStatus::Missing)).offer, None);

        // Windows started again: the marker is old news.
        *machine.boot.lock().unwrap() = Some(T0 + 900);
        let restarted = SetupState::new(machine.clone());
        assert_eq!(restarted.status(Some(WslStatus::Missing)), status(Some(WslSetupOffer::Install), false, None));
        // The start time not known: never "restart Windows" for ever.
        *machine.boot.lock().unwrap() = None;
        assert_eq!(SetupState::new(machine.clone()).status(Some(WslStatus::Missing)).offer, Some(WslSetupOffer::Install));
        // Methods can run (no probe status): the marker is not read.
        *machine.boot.lock().unwrap() = Some(BOOT);
        assert_eq!(SetupState::new(machine).status(None), status(None, false, None));
        assert!(host.questions().is_empty());
    }

    /// With Windows' boot counter in both readings, a new counter is a
    /// restart, and the same counter lets the clock's reading of the start
    /// drift with the time since the setup: two weeks later four minutes off
    /// still say "restart Windows", ten minutes off do not (a counter that
    /// stopped moving). A counter that did not move while Windows ran for
    /// less time than when the setup started is a restart too. Without the
    /// counter in either reading, the clock decides within a minute, as
    /// before, however long ago the setup was.
    #[test]
    fn windows_boot_counter_says_whether_windows_restarted() {
        let dir = TestDir::new("boot-id");
        let machine = FakeMachine::new(Some(dir.marker()));
        *machine.boot_id.lock().unwrap() = Some(8);
        let state = SetupState::new(machine.clone());
        let r = run_on(&state, WslStatus::Missing, Arc::new(FakeHost::new(exited(0, ""), WslStatus::Missing)));
        assert_eq!(r, WslSetupResult::done(true));
        assert_eq!(read_marker(&dir.marker()).and_then(|m| m.boot_id), Some(8), "the counter in the marker");
        let waits = |machine: &Arc<FakeMachine>| {
            let s = SetupState::new(machine.clone()).status(Some(WslStatus::Missing));
            s.last.is_some_and(|r| r.waits_for_a_restart()) && s.offer.is_none()
        };

        machine.pass(14 * 24 * 3600);
        *machine.boot.lock().unwrap() = Some(BOOT + 240);
        assert!(waits(&machine), "the same start: the clock moved four minutes in two weeks, the counter did not");
        *machine.boot.lock().unwrap() = Some(BOOT + 600);
        assert!(!waits(&machine), "ten minutes in two weeks: a counter that stopped moving, offered again");
        *machine.boot.lock().unwrap() = Some(BOOT + 240);
        *machine.boot_id.lock().unwrap() = Some(9);
        assert!(!waits(&machine), "a new counter: Windows restarted");

        // Restarted 100 s after the setup, read 400 s later: Windows has run
        // for 400 s, less than the hour it had run when the setup started.
        *machine.boot_id.lock().unwrap() = Some(8);
        machine.now.store(T0 + 500, Ordering::SeqCst);
        *machine.boot.lock().unwrap() = Some(T0 + 100);
        assert!(!waits(&machine), "a counter that did not move with a shorter running time");

        // No counter now: the clock decides, within a minute only.
        *machine.boot_id.lock().unwrap() = None;
        machine.now.store(T0 + 14 * 24 * 3600, Ordering::SeqCst);
        *machine.boot.lock().unwrap() = Some(BOOT + 2);
        assert!(waits(&machine), "the clock within a minute");
        *machine.boot.lock().unwrap() = Some(BOOT + 240);
        assert!(!waits(&machine), "the clock four minutes off: no drift allowed without the counter");
        *machine.boot.lock().unwrap() = Some(BOOT + 600);
        assert!(!waits(&machine), "the clock ten minutes off");
        // A marker without the counter (an older build's), a counter now: the clock decides.
        let mut marker = read_marker(&dir.marker()).unwrap();
        marker.boot_id = None;
        write_marker(&dir.marker(), &marker).unwrap();
        *machine.boot_id.lock().unwrap() = Some(8);
        assert!(!waits(&machine), "an older marker, the clock ten minutes off");
        *machine.boot.lock().unwrap() = Some(BOOT);
        assert!(waits(&machine), "an older marker, the clock agrees");
    }

    /// The boot rule with the counter the same in both readings, on
    /// injected values: the start times may differ by 60 s plus a second per
    /// 5000 s since the setup; no start time read: not the same boot.
    #[test]
    fn a_boot_counter_that_stops_moving_does_not_say_restart_windows_for_ever() {
        let marker = |started_at: u64, boot_time: Option<u64>| Marker {
            started_at,
            boot_time,
            boot_id: Some(8),
            app: None,
            process: None,
            result: Some(WslSetupResult::done(true)),
            ended_at: Some(started_at),
        };
        let same_boot = |marker: &Marker, now: u64, boot: Option<u64>, boot_id: Option<u32>| {
            let machine = FakeMachine::new(None);
            machine.now.store(now, Ordering::SeqCst);
            *machine.boot.lock().unwrap() = boot;
            *machine.boot_id.lock().unwrap() = boot_id;
            SetupState::new(machine).same_boot(marker)
        };
        let m = marker(T0, Some(BOOT));
        const DAY: u64 = 24 * 3600;
        for (now, boot, same, why) in [
            (T0 + 600, BOOT, true, "the same start"),
            (T0 + 600, BOOT + 60, true, "a minute off, just after the setup"),
            (T0 + 600, BOOT - 60, true, "a minute off the other way"),
            (T0 + 600, BOOT + 61, false, "more than a minute off, just after the setup"),
            (T0 + 600, BOOT - 61, false, "more than a minute off the other way"),
            // 14 days: 60 + 1_209_600 / 5000 = 301 s.
            (T0 + 14 * DAY, BOOT + 301, true, "two weeks: up to 301 s off"),
            (T0 + 14 * DAY, BOOT + 302, false, "two weeks: 302 s off"),
            // A year: 60 + 31_536_000 / 5000 = 6367 s.
            (T0 + 365 * DAY, BOOT + 6367, true, "a year: up to 6367 s off"),
            (T0 + 365 * DAY, BOOT + 6368, false, "a year: 6368 s off"),
            // A restart that kept the counter, read days later: far off.
            (T0 + 3 * DAY, T0 + DAY, false, "a restart a day after the setup"),
        ] {
            assert_eq!(same_boot(&m, now, Some(boot), Some(8)), same, "{why}");
        }
        // A new counter: a restart, however close the start times.
        assert!(!same_boot(&m, T0 + 600, Some(BOOT), Some(9)));
        // No start time read, then or now: not the same boot.
        assert!(!same_boot(&m, T0 + 600, None, Some(8)));
        assert!(!same_boot(&marker(T0, None), T0 + 600, Some(BOOT), Some(8)));
        // The clock put back 50 s, 10 s after the setup: no drift, the
        // minute only.
        assert!(same_boot(&m, T0 - 40, Some(BOOT - 50), Some(8)));
        assert!(!same_boot(&m, T0 - 40, Some(BOOT - 61), Some(8)));
        // Started 20 s after Windows did, restarted 10 s later with the
        // counter kept, read 5 s after: the start times are 50 s apart
        // (within the minute), but Windows has run 5 s where it had run 20.
        let early = marker(T0, Some(T0 - 20));
        assert!(!same_boot(&early, T0 + 35, Some(T0 + 30), Some(8)), "ran less: restarted");
        assert!(same_boot(&early, T0 + 35, Some(T0 - 20), Some(8)), "the same start");
    }

    /// A marker of a setup that ended otherwise, of a decline a minute ago
    /// or more or without its time (an older build's), or a marker that
    /// cannot be read: offered, no pause.
    #[test]
    fn a_marker_of_another_outcome_or_unreadable_is_nothing() {
        let dir = TestDir::new("marker-other");
        let machine = FakeMachine::new(Some(dir.marker()));
        let declined = WslSetupResult::of(WslSetupOutcome::Declined);
        for (result, ended_at) in [
            (WslSetupResult::done(false), Some(T0)),
            (WslSetupResult::failed(Some(1), "no".into()), Some(T0)),
            (WslSetupResult::of(WslSetupOutcome::NotStarted), Some(T0)),
            (declined.clone(), None),
            (declined.clone(), Some(T0 - DECLINE_PAUSE_SECS)),
            // A clock that went back since: no pause rather than a long one.
            (declined, Some(T0 + 10)),
        ] {
            let marker = Marker {
                started_at: T0 - 5,
                boot_time: Some(BOOT),
                boot_id: None,
                app: None,
                process: Some(PROCESS),
                result: Some(result),
                ended_at,
            };
            write_marker(&dir.marker(), &marker).unwrap();
            let s = SetupState::new(machine.clone()).status(Some(WslStatus::Missing));
            assert_eq!(s, status(Some(WslSetupOffer::Install), false, None), "{marker:?}");
        }
        std::fs::write(dir.marker(), b"{ not json").unwrap();
        let s = SetupState::new(machine).status(Some(WslStatus::Missing));
        assert_eq!(s, status(Some(WslSetupOffer::Install), false, None));
    }

    /// The commands are the installer hook's, read no input (the window is
    /// hidden: a question would wait for ever), and send their output to the
    /// file.
    #[test]
    fn the_commands_are_the_installers_read_no_input_and_go_into_the_file() {
        let wsl = r"C:\Windows\system32\wsl.exe";
        let out = r"C:\Windows\Temp\txresbench-wsl-setup-0123.txt";
        assert_eq!(
            setup_params(wsl, WslSetupOffer::Install, Some(out)).unwrap(),
            r#"/d /s /c "("C:\Windows\system32\wsl.exe" --install --no-distribution) < nul > "C:\Windows\Temp\txresbench-wsl-setup-0123.txt" 2>&1""#
        );
        assert_eq!(
            setup_params(wsl, WslSetupOffer::Update, Some(out)).unwrap(),
            r#"/d /s /c "("C:\Windows\system32\wsl.exe" --update && "C:\Windows\system32\wsl.exe" --install --no-distribution) < nul > "C:\Windows\Temp\txresbench-wsl-setup-0123.txt" 2>&1""#
        );
        // Without the file (it could not be made): no input either.
        assert_eq!(
            setup_params(wsl, WslSetupOffer::Update, None).unwrap(),
            r#"/d /s /c "("C:\Windows\system32\wsl.exe" --update && "C:\Windows\system32\wsl.exe" --install --no-distribution) < nul""#
        );
        // The wsl.exe commands are the installer hook's, with its wsl.exe.
        let hook = include_str!("../../../../desktop/tauri/windows/installer-hooks.nsh");
        for (var, offer) in [("TxrWslInstallParams", WslSetupOffer::Install), ("TxrWslUpdateParams", WslSetupOffer::Update)] {
            let prefix = format!("StrCpy ${var} '/d /s /c \"");
            let hooks: Vec<&str> = hook.lines().filter_map(|l| l.trim().strip_prefix(prefix.as_str())).collect();
            assert_eq!(hooks.len(), 1, "one {var} in the hook");
            let commands = hooks[0].strip_suffix("\"'").expect("the hook's parameters end the quote");
            assert_eq!(commands.replace(r"$WINDIR\Sysnative\wsl.exe", wsl), setup_commands(wsl, offer), "{var}");
        }
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
        let s = WslSetupStatus { offer: Some(WslSetupOffer::Update), running: false, last: None, retry_in_secs: Some(9) };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "offer": "update", "running": false, "retry_in_secs": 9 })
        );
        for (o, name) in [
            (WslSetupOutcome::Done, "done"),
            (WslSetupOutcome::Declined, "declined"),
            (WslSetupOutcome::NotStarted, "not_started"),
            (WslSetupOutcome::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(o).unwrap(), serde_json::json!(name));
        }
    }

    /// The real launcher on Windows (in the VM): the command line, and runs
    /// through `ShellExecuteExW` with a stand-in in place of wsl.exe. Never
    /// the real wsl.exe and never the app's own dialog: these tests call the
    /// launcher directly, not [`start_here`], and the seam's check of WSL is
    /// not asked.
    #[cfg(target_os = "windows")]
    mod on_windows {
        use std::path::{Path, PathBuf};
        use std::sync::mpsc;
        use std::time::Duration;

        use super::super::elevated::{self, system_dir, Dialog, ElevatedSetup, DIALOG_FLAGS};
        use super::super::GO_DELAY_MS;
        use super::super::{
            question, Launch, Process, SetupHost, WslSetupOffer, WslStatus, GO_BUTTON, NOT_NOW_BUTTON,
            QUESTION_TITLE,
        };

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

        const PATHS_CHILD: &str = "TXR_WSL_SETUP_PATHS_CHILD";

        /// Run by [`the_setup_runs_system32s_cmd_and_wsl_by_their_full_paths`]
        /// in a child process (with `PATHS_CHILD` set): prints the setup's
        /// paths. Does nothing in a normal test run.
        #[test]
        fn child_prints_the_setup_paths() {
            if std::env::var_os(PATHS_CHILD).is_none() {
                return;
            }
            let setup = ElevatedSetup::system();
            // libtest prints the test's name on the line the output starts on.
            println!();
            println!("cmd={}", setup.cmd.display());
            println!("wsl={}", setup.wsl.display());
            println!("capture_dir={}", setup.capture_dir.display());
        }

        /// The paths come from Windows' API, not from the environment: a
        /// child test process whose `SystemRoot` and `windir` name another
        /// folder still finds System32's cmd.exe and wsl.exe and the Windows
        /// directory's Temp.
        #[test]
        fn the_setup_runs_system32s_cmd_and_wsl_by_their_full_paths() {
            let root = std::env::var_os("SystemRoot").map(PathBuf::from).expect("SystemRoot");
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "modules::sandbox::wsl_setup::tests::on_windows::child_prints_the_setup_paths",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(PATHS_CHILD, "1")
                .env("SystemRoot", r"C:\NotWindows")
                .env("windir", r"C:\NotWindows")
                .output()
                .expect("the child test runs");
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(out.status.success(), "{stdout}{}", String::from_utf8_lossy(&out.stderr));
            let value = |key: &str| {
                stdout
                    .lines()
                    .find_map(|l| l.trim().strip_prefix(&format!("{key}=")))
                    .unwrap_or_else(|| panic!("{key} in {stdout}"))
                    .to_lowercase()
            };
            let lower = |p: PathBuf| p.to_string_lossy().to_lowercase();
            assert_eq!(value("cmd"), lower(root.join("System32").join("cmd.exe")));
            assert_eq!(value("wsl"), lower(root.join("System32").join("wsl.exe")));
            assert_eq!(value("capture_dir"), lower(root.join("Temp")));
            assert!(!stdout.to_lowercase().contains("notwindows"), "{stdout}");

            let setup = ElevatedSetup::system();
            assert_eq!(setup.verb, "runas");
            assert_eq!(setup.cmd, system_dir().join("cmd.exe"));
            assert!(setup.cmd.is_file(), "{}", setup.cmd.display());
            let capture = setup.capture_dir.join("txresbench-wsl-setup-0123.txt");
            let (program, params) = setup.command(WslSetupOffer::Update, Some(&capture)).unwrap();
            let wsl = setup.wsl.display().to_string();
            assert_eq!(program, setup.cmd);
            assert_eq!(
                params,
                format!(
                    "/d /s /c \"(\"{wsl}\" --update && \"{wsl}\" --install --no-distribution) < nul > \"{}\" 2>&1\"",
                    capture.display()
                )
            );
            let (_, params) = setup.command(WslSetupOffer::Install, None).unwrap();
            assert_eq!(params, format!("/d /s /c \"(\"{wsl}\" --install --no-distribution) < nul\""));
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

            let mut started: Vec<Process> = Vec::new();
            let Launch::Exited { code, output } = setup.run_elevated(WslSetupOffer::Update, &mut |p| started.push(p)) else {
                panic!("not started");
            };
            assert_eq!(code, Some(7), "{output}");
            assert!(output.contains("stand-in --update"), "{output}");
            assert!(output.contains("stand-in --install --no-distribution"), "{output}");
            assert!(output.contains("Error code: Wsl/InstallDistro/0x80370102"), "{output}");
            assert!(output.contains("rename refused") && !output.contains("renamed"), "{output}");
            assert!(output.contains("still there") && !output.contains("deleted"), "{output}");
            // Windows' process was reported once, and it has ended.
            assert_eq!(started.len(), 1, "{started:?}");
            assert!(started[0].pid != 0 && started[0].created != 0, "{started:?}");
            assert!(!elevated::alive(started[0]), "the setup's process ended");

            // Install alone: no --update; and the words of a run are its own.
            let Launch::Exited { code, output } = setup.run_elevated(WslSetupOffer::Install, &mut |_| {}) else {
                panic!("not started");
            };
            assert_eq!(code, Some(7), "{output}");
            assert!(!output.contains("--update"), "{output}");
            assert!(output.contains("stand-in --install --no-distribution"), "{output}");

            assert_eq!(captures(&setup.capture_dir).len(), before, "the output files are removed");
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// A stand-in that asks for input twice (`set /p`, `pause`): the
        /// setup's commands get none, so it goes on at once instead of
        /// waiting in a hidden window for ever.
        #[test]
        fn a_setup_that_asks_for_input_ends_instead_of_waiting() {
            let dir = test_dir("asks");
            let script = dir.join("wsl-asks.cmd");
            std::fs::write(
                &script,
                "@echo off\r\n\
                 set /p ANSWER=Type something: \r\n\
                 echo answer [%ANSWER%]\r\n\
                 pause\r\n\
                 echo no input waited for\r\n\
                 exit /b 0\r\n",
            )
            .unwrap();
            // Its output file in the test's own dir: the other test's stand-in
            // tries to remove every one in the Windows Temp dir.
            let setup = ElevatedSetup { wsl: script, capture_dir: dir.clone(), ..ElevatedSetup::system() };
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(setup.run_elevated(WslSetupOffer::Install, &mut |_| {}));
            });
            let launch = rx.recv_timeout(Duration::from_secs(60)).expect("the setup waited for input");
            let Launch::Exited { code, output } = launch else { panic!("not started: {launch:?}") };
            assert_eq!(code, Some(0), "{output}");
            assert!(output.contains("answer []") && output.contains("no input waited for"), "{output}");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_program_windows_cannot_start_is_not_started_with_its_error() {
            let dir = test_dir("missing");
            let system = ElevatedSetup::system();
            // Its output file in the test's own dir: the other test's stand-in
            // tries to remove every one in the Windows Temp dir.
            let setup = ElevatedSetup { cmd: dir.join("no-such-cmd.exe"), capture_dir: dir.clone(), ..system };
            let mut started = 0;
            match setup.run_elevated(WslSetupOffer::Install, &mut |_| started += 1) {
                Launch::NotStarted { error } => assert_eq!(error, 2, "ERROR_FILE_NOT_FOUND"),
                other => panic!("{other:?}"),
            }
            assert_eq!(started, 0, "no process reported");
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// A process is alive while it runs, under its own creation time
        /// only; not once it ended.
        #[test]
        fn a_process_is_known_by_its_id_and_start_and_alive_until_it_ends() {
            use std::os::windows::io::AsRawHandle;
            let mut child = std::process::Command::new(system_dir().join("PING.EXE"))
                .args(["-n", "60", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .expect("ping runs");
            let process = elevated::identify(child.as_raw_handle()).expect("identified");
            assert_eq!(process.pid, child.id());
            assert!(elevated::alive(process), "{process:?}");
            assert!(!elevated::alive(Process { created: process.created + 1, ..process }), "another start");
            child.kill().unwrap();
            child.wait().unwrap();
            assert!(!elevated::alive(process), "ended");
        }

        /// The app's own process, which the marker names: this process, alive.
        #[test]
        fn this_process_is_known_by_its_id_and_start() {
            let me = elevated::this_process().expect("this process");
            assert_eq!(me.pid, std::process::id());
            assert!(me.created != 0 && elevated::alive(me), "{me:?}");
            assert_eq!(elevated::this_process(), Some(me), "the same twice");
        }

        /// Windows' boot counter as reg.exe reads it: `None` when this
        /// Windows has no `BootId` (or not as a DWORD).
        fn boot_id_by_reg() -> Option<u32> {
            let out = std::process::Command::new(system_dir().join("reg.exe"))
                .args([
                    "query",
                    r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters",
                    "/v",
                    "BootId",
                ])
                .output()
                .expect("reg.exe runs");
            if !out.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&out.stdout);
            let value = stdout.lines().find_map(|line| match line.split_whitespace().collect::<Vec<_>>()[..] {
                ["BootId", "REG_DWORD", value] => Some(value.to_string()),
                _ => None,
            })?;
            u32::from_str_radix(value.trim_start_matches("0x"), 16).ok()
        }

        /// Windows' start, read twice 2.5 s apart: the boot counter is what
        /// reg.exe reads (none on a Windows without it: the app then uses the
        /// clock alone, by design) and the same twice, and the start times
        /// from the clock are within a second of each other (a reading that
        /// followed the clock alone would be 2 s or more apart).
        #[test]
        fn windows_start_reads_the_same_twice() {
            let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            let first = (elevated::boot_id(), elevated::boot_time(now()), now());
            std::thread::sleep(Duration::from_millis(2500));
            let second = (elevated::boot_id(), elevated::boot_time(now()));
            assert_eq!(first.0, boot_id_by_reg(), "the counter as reg.exe reads it");
            assert_eq!(first.0, second.0, "the same counter");
            match first.0 {
                Some(id) => assert!(id > 0, "{first:?}"),
                None => println!("this Windows keeps no BootId: the setup's state uses the clock rule"),
            }
            assert!(first.1.abs_diff(second.1) <= 1, "the same start: {first:?} {second:?}");
            assert!(first.1 > 1_500_000_000 && first.1 <= first.2, "{first:?}");
        }

        fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
            use std::os::windows::ffi::OsStrExt;
            s.encode_wide().chain(std::iter::once(0)).collect()
        }

        /// A NUL-terminated UTF-16 string the dialog points to.
        fn read(p: *const u16) -> String {
            // SAFETY: `p` points into a live NUL-terminated buffer of the test.
            unsafe {
                let len = (0..).take_while(|&i| *p.add(i) != 0).count();
                String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
            }
        }

        /// The question: a task dialog with the question's words and its two
        /// buttons only (no Windows buttons, whose labels have letter keys),
        /// Not now the default, Esc and the close box allowed (a No), centred
        /// on the owner, its timer on, and the callback that puts it on top
        /// and holds the go button back. A test process has no window of its
        /// own: no owner. The dialog itself is never shown in a test.
        #[test]
        fn the_question_is_a_task_dialog_with_not_now_the_default() {
            use windows_sys::Win32::UI::Controls::{
                TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER, TDF_POSITION_RELATIVE_TO_WINDOW,
            };
            let q = question(WslStatus::Missing);
            let dialog = Dialog::new(QUESTION_TITLE, &q);
            let buttons = dialog.buttons();
            let config = dialog.config(elevated::main_window(), &buttons);
            // Copies: the struct is packed.
            let (flags, common, count, default) = (config.dwFlags, config.dwCommonButtons, config.cButtons, config.nDefaultButton);
            let (owner, callback, title, text) = (config.hwndParent, config.pfCallback, config.pszWindowTitle, config.pszContent);
            assert_eq!(
                DIALOG_FLAGS,
                TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW | TDF_CALLBACK_TIMER,
                "Esc and the close box, centred on the owner, and the timer that lets the go button be pressed"
            );
            assert_eq!(flags, DIALOG_FLAGS);
            assert_eq!((common, count, default), (0, 2, NOT_NOW_BUTTON), "only the two buttons, Not now the default");
            assert!(std::ptr::eq(config.pButtons, buttons.as_ptr()));
            let labels: Vec<(i32, String)> = buttons.iter().map(|b| (b.nButtonID, read(b.pszButtonText))).collect();
            assert_eq!(labels, [(GO_BUTTON, "Install WSL".to_string()), (NOT_NOW_BUTTON, "Not now".to_string())]);
            assert_eq!((read(title), read(text)), (QUESTION_TITLE.to_string(), q.text.to_string()));
            assert!(callback.is_some(), "the callback puts it on top");
            assert!(owner.is_null() && elevated::main_window().is_null(), "a test process has no window");
            let shown = std::panic::catch_unwind(|| ElevatedSetup::system().confirm(&q));
            assert!(shown.is_err(), "the real dialog is never shown in a test");
        }

        /// The task dialog messages (from WM_USER on: TDM_*) the test's
        /// window got, as (message, wparam, lparam).
        static TASK_DIALOG_MESSAGES: std::sync::Mutex<Vec<(u32, usize, isize)>> = std::sync::Mutex::new(Vec::new());
        /// The STATIC class's own window procedure, which the test's window
        /// passes every other message to.
        static STATIC_PROC: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

        unsafe extern "system" fn record_task_dialog_messages(
            window: windows_sys::Win32::Foundation::HWND,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize {
            use windows_sys::Win32::UI::WindowsAndMessaging::{CallWindowProcW, WM_USER, WNDPROC};
            if msg >= WM_USER {
                TASK_DIALOG_MESSAGES.lock().unwrap_or_else(|p| p.into_inner()).push((msg, wparam, lparam));
                return 0;
            }
            // SAFETY: STATIC_PROC holds the window procedure SetWindowLongPtrW
            // returned for this window (a function pointer, or 0: none).
            unsafe {
                let static_proc = std::mem::transmute::<isize, WNDPROC>(STATIC_PROC.load(std::sync::atomic::Ordering::SeqCst));
                CallWindowProcW(static_proc, window, msg, wparam, lparam)
            }
        }

        /// The dialog's callback, driven as TaskDialogIndirect drives it, on
        /// a hidden window of the test's own (never shown) that records the
        /// task dialog messages it gets. Once the dialog is made: above every
        /// window, the go button's shield, and the go button greyed out.
        /// Timer ticks before [`GO_DELAY_MS`] change nothing; the first at or
        /// after it lets the go button be pressed. Other notifications change
        /// nothing, and every one gets S_OK.
        #[test]
        fn the_dialog_goes_above_every_window_and_holds_the_go_button_back() {
            use windows_sys::Win32::UI::Controls::{
                TDM_ENABLE_BUTTON, TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE, TDN_BUTTON_CLICKED, TDN_CREATED,
                TDN_DESTROYED, TDN_DIALOG_CONSTRUCTED, TDN_HYPERLINK_CLICKED, TDN_NAVIGATED, TDN_TIMER,
            };
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetWindowLongPtrW, IsWindowVisible, SetWindowLongPtrW, GWLP_WNDPROC,
                GWL_EXSTYLE, WS_EX_TOPMOST, WS_POPUP,
            };
            let class = wide(std::ffi::OsStr::new("STATIC"));
            // SAFETY: a plain hidden popup of the system's STATIC class; no
            // parent, menu or creation data.
            let window = unsafe {
                CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_POPUP, 0, 0, 10, 10, std::ptr::null_mut(),
                    std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
            };
            assert!(!window.is_null(), "{}", std::io::Error::last_os_error());
            // SAFETY: `window` is the test's, on this thread; the procedure
            // passes what it does not record to the STATIC class's own.
            let static_proc = unsafe {
                SetWindowLongPtrW(window, GWLP_WNDPROC, record_task_dialog_messages as *const () as isize)
            };
            assert!(static_proc != 0, "{}", std::io::Error::last_os_error());
            STATIC_PROC.store(static_proc, std::sync::atomic::Ordering::SeqCst);
            let sent = || std::mem::take(&mut *TASK_DIALOG_MESSAGES.lock().unwrap());
            // SAFETY: `window` is the test's window, alive until destroyed below.
            let topmost = || unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST != 0;
            // SAFETY: as TaskDialogIndirect calls it, with the test's window.
            let notify = |notification: i32, wparam: usize| unsafe {
                elevated::on_dialog(window, notification as u32, wparam, 0, 0)
            };
            let go = GO_BUTTON as usize;
            let enable = |on: isize| (TDM_ENABLE_BUTTON as u32, go, on);
            let shield = (TDM_SET_BUTTON_ELEVATION_REQUIRED_STATE as u32, go, 1);
            let nothing: Vec<(u32, usize, isize)> = Vec::new();
            assert!(!topmost());

            // Other notifications than "made" and the timer change nothing.
            for other in [TDN_NAVIGATED, TDN_BUTTON_CLICKED, TDN_HYPERLINK_CLICKED, TDN_DESTROYED, TDN_DIALOG_CONSTRUCTED] {
                assert_eq!(notify(other, go), 0, "{other}");
            }
            assert!(!topmost());
            assert_eq!(sent(), nothing, "nothing sent before the dialog is made");

            assert_eq!(notify(TDN_CREATED, 0), 0);
            assert!(topmost(), "above every window");
            assert_eq!(sent(), [shield, enable(0)], "the shield, and the go button greyed out");

            // The timer ticks about every 200 ms with the milliseconds since
            // the dialog was made.
            for ms in [0, 200, 400, 600, 800, GO_DELAY_MS - 1] {
                assert_eq!(notify(TDN_TIMER, ms), 0, "S_OK keeps the timer's count ({ms} ms)");
            }
            assert_eq!(sent(), nothing, "still greyed out before {GO_DELAY_MS} ms");
            assert_eq!(notify(TDN_TIMER, GO_DELAY_MS + 13), 0);
            assert_eq!(sent(), [enable(1)], "the go button can be pressed");
            assert_eq!(notify(TDN_TIMER, GO_DELAY_MS + 213), 0);
            assert_eq!(sent(), [enable(1)], "again at the next tick: no change");
            assert_eq!(notify(TDN_BUTTON_CLICKED, go), 0, "a press closes the dialog (S_OK)");
            assert_eq!(sent(), nothing);

            // SAFETY: the test's window; its own procedure back before it goes.
            unsafe {
                assert_eq!(IsWindowVisible(window), 0, "never shown");
                SetWindowLongPtrW(window, GWLP_WNDPROC, static_proc);
                DestroyWindow(window);
            }
        }

        /// The tauri-build default manifest, embedded in txresbench-desktop.exe
        /// (read back from the built exe with mt.exe).
        const DESKTOP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>"#;

        /// TaskDialogIndirect is in Common Controls 6 only. The test binary has
        /// no manifest asking for it (as the server run by itself): the lookup
        /// finds nothing, so the question would be a No. With the desktop app's
        /// manifest active it is found. Nothing is shown.
        #[test]
        fn the_task_dialog_comes_with_the_desktop_apps_manifest() {
            use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
            use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
                ActivateActCtx, CreateActCtxW, DeactivateActCtx, ReleaseActCtx, ACTCTXW,
            };
            assert!(elevated::task_dialog().is_none(), "the test binary loads the old comctl32");

            let dir = test_dir("manifest");
            let manifest = dir.join("desktop.manifest");
            std::fs::write(&manifest, DESKTOP_MANIFEST).unwrap();
            let source = wide(manifest.as_os_str());
            let ctx = ACTCTXW { cbSize: std::mem::size_of::<ACTCTXW>() as u32, lpSource: source.as_ptr(), ..Default::default() };
            // SAFETY: `ctx` is filled as the call expects; `source` outlives it.
            let handle = unsafe { CreateActCtxW(&ctx) };
            assert!(handle != INVALID_HANDLE_VALUE, "{}", std::io::Error::last_os_error());
            let mut cookie = 0usize;
            // SAFETY: `handle` is the context just made; this thread activates
            // it, looks the function up, and deactivates and releases it.
            let found = unsafe {
                assert!(ActivateActCtx(handle, &mut cookie) != 0, "{}", std::io::Error::last_os_error());
                let found = elevated::task_dialog();
                DeactivateActCtx(0, cookie);
                ReleaseActCtx(handle);
                found
            };
            let _ = std::fs::remove_dir_all(&dir);
            assert!(found.is_some(), "Common Controls 6 has TaskDialogIndirect");
        }
    }
}
