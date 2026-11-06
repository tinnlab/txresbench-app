//! `updates` — the update-check runtime surface (PROV-IR-6, ITEM-4).
//!
//! TxResBench's only allowed runtime network use is checking for updates
//! (INV-1, common.md:18-19): a single identifier-free GET of the stable feed
//! URL (INV-4, models.md:16). The Tauri v2 updater plugin owns the download +
//! minisign signature verification + install; this module owns the shell's
//! decision surface on top of it — a pure state machine, the three IPC
//! commands, the once-per-start boot check with a native ask, and an injected
//! check seam so the network edge is testable without a real feed.
//!
//! Design (DECS 1/2/5/6/7/8/14/15, PROV-IR-6):
//! - `UPDATER_FEED_URL` is the ONLY http(s) literal in the crate's shipped
//!   source (TEST-IR-15); `tauri.conf.json` `plugins.updater.endpoints`
//!   carries the same value (TEST-IR-14) and is what the plugin dials.
//! - An EMPTY `plugins.updater.pubkey` is a runtime-disabled state, not a
//!   marker (DEC-5, INV-5): the check short-circuits to
//!   `UpdateState::Unconfigured` and never invokes the check seam, so the
//!   app cannot dial the network before the owner supplies the key.
//! - One check per app start, release builds only, silent on
//!   `Error`/`UpToDate` (DEC-14): offline is a valid state; the next app
//!   start retries.
//! - The check itself is a single plugin `check()` (the plugin's HTTP is
//!   reqwest-based — no new direct dependency). The `CheckFn` seam exists so
//!   tests exercise the whole decision pipeline (state machine, `is_newer`
//!   gate, `parse_feed` wire-shape reader) against a loopback feed.
//!
//! Seam contract (the seams are the edges the tests replace; production uses
//! the plugin):
//! - `CheckFn(&feed_url, &mut events) -> Future<Result<Option<UpdateInfo>>>`:
//!   resolve the update for THIS device. `feed_url` is always the fixed
//!   `UPDATER_FEED_URL` constant — the crate never builds a URL from user or
//!   install data (INV-4, TEST-IR-21). `Ok(None)` means "no update" (also a
//!   platform without a feed entry or a 404 — silent, DEC-14); `Err` is a
//!   real failure and records `UpdateState::Error`.
//! - `InstallFn(&UpdateInfo, events) -> Future<Result<()>>`: download +
//!   verify + install. The owned `UpdateEvents` handle (not a borrowed sink)
//!   because the seam's future is `'static` and must report download
//!   progress across awaits (DRIFT-1 ITEM-4).
//! - `RestartFn()`: the final restart step (production: a "Restart now?"
//!   native ask then `app.restart()`; tests inject a recording no-op).
//!
//! The `is_newer` gate is a conservative second check on top of the plugin's
//! semver comparator (the plugin's comparator is the primary gate; this one
//! refuses a malformed announced version), and `parse_feed` is this crate's
//! reader of the frozen landing-site PROV-5 wire shape (CONS-IR-2) — the
//! loopback contract test drives the real reader against a real feed body.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// The canonical FEED URL (CONS-IR-1 / PROV-landing-site-3) — the only
/// runtime network the app dials (INV-1). Stable path: no version in the
/// URL; the feed content carries it. `tauri.conf.json`
/// `plugins.updater.endpoints` mirrors this exact value (TEST-IR-14).
pub const UPDATER_FEED_URL: &str = "https://tinnlab.github.io/txresbench-app/updates/latest.json";

/// An update-lifecycle event a seam reports to the shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateEvent {
    /// The download reported bytes received / bytes total. The shell records
    /// it as `UpdateState::Downloading`.
    DownloadProgress {
        bytes_downloaded: u64,
        bytes_total: u64,
    },
}

/// What a check resolved (the fields the state machine binds; the feed's
/// `signature` never reaches the state machine — the plugin's install path
/// verifies it against the configured public key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
}

/// The update state machine (PROV-IR-6; serde-agnostic — converted to the
/// DTO's string key in the commands).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateState {
    /// `plugins.updater.pubkey` is empty: the update path is disabled and the
    /// network is never dialed (DEC-5, INV-1).
    Unconfigured,
    /// No check has run this session yet (or the last action completed).
    Idle,
    /// A check is in flight.
    Checking,
    /// A newer version is available (`url` is the feed's artifact URL).
    Available { version: String, url: String },
    /// The update is downloading (progress in bytes).
    Downloading { bytes: u64, total: u64 },
    /// The download + verify + install succeeded; only the restart remains.
    ReadyToRestart,
    /// The feed was current (or offline/silent — a valid state, DEC-14).
    UpToDate,
    /// The last check/install failed; the reason is recorded.
    Error { message: String },
}

/// The IPC status snapshot (PROV-IR-6). `state` is the lowercase
/// state-machine key; the other fields carry the variant's payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateStatusDto {
    pub state: String,
    pub current_version: String,
    pub update_version: Option<String>,
    pub bytes_downloaded: u64,
    pub bytes_total: u64,
    pub message: Option<String>,
}

/// The check seam (PROV-IR-6): resolve the update for this device, reporting
/// lifecycle events through the sink. `feed_url` is always `UPDATER_FEED_URL`.
///
/// The sink is synchronous-only by design: the check emits no progress and
/// the seam's future is `'static` (the owned [`UpdateEvents`] handle is the
/// install seam's equivalent for progress across awaits — DRIFT-1 ITEM-4).
pub type CheckFn = Box<
    dyn FnOnce(&str, &mut dyn FnMut(UpdateEvent)) -> Pin<
        Box<dyn Future<Output = Result<Option<UpdateInfo>, String>> + Send>,
    > + Send
        + 'static,
>;

/// A cloneable, owned event sink — the install seam's progress channel.
/// Owned (not a borrowed `&mut dyn FnMut`) because the seam's future must be
/// `'static` and still report download progress across awaits (DRIFT-1
/// ITEM-4); an `Arc`-wrapped `Fn` is the shell-side mirror.
#[derive(Clone)]
pub struct UpdateEvents(Arc<dyn Fn(UpdateEvent) + Send + Sync + 'static>);

impl UpdateEvents {
    /// Wrap a handler; every `emit` calls it (the shell updates its state
    /// from it).
    pub fn new<F: Fn(UpdateEvent) + Send + Sync + 'static>(f: F) -> Self {
        Self(Arc::new(f))
    }

    /// Deliver one event.
    pub fn emit(&self, event: UpdateEvent) {
        (self.0)(event);
    }
}

/// The install seam: download + verify + install the update `info`
/// announces, reporting progress through `events`. Production re-checks via
/// the plugin (the plugin's `Update` carries the signature the install must
/// verify); tests inject a seam against loopback bytes.
pub type InstallFn = Box<
    dyn FnOnce(&UpdateInfo, UpdateEvents) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + 'static,
>;

/// The restart seam: the final step of a successful install (production: a
/// "Restart now?" native ask then `app.restart()`; tests inject a recording
/// no-op). `Fn` (not `FnOnce`) so the ask flow and the direct command both
/// route through the same seam.
pub type RestartFn = Box<dyn Fn() + Send + Sync + 'static>;

/// The runtime state backing the three commands (PROV-IR-6). Holds the
/// injected seams + the state machine; constructed once per app start by
/// [`register`] and replaced only by the test seam (`set_runtime_for_tests`).
pub struct UpdateRuntime {
    /// `plugins.updater.pubkey` non-empty (DEC-5).
    configured: bool,
    /// The running app's version (`package_info.version`).
    current_version: String,
    state: Arc<Mutex<UpdateState>>,
    /// One-shot per session (DEC-14: one check per app start); `take`n on
    /// the first check.
    check: Mutex<Option<CheckFn>>,
    /// One-shot per session (a single install in flight).
    install: Mutex<Option<InstallFn>>,
    restart: RestartFn,
}

impl UpdateRuntime {
    /// Build a runtime from its seams (production: [`register`]; tests: the
    /// loopback seam's own constructors).
    pub fn new(
        configured: bool,
        current_version: String,
        check: CheckFn,
        install: InstallFn,
        restart: RestartFn,
    ) -> Self {
        Self {
            configured,
            current_version,
            state: Arc::new(Mutex::new(if configured {
                UpdateState::Idle
            } else {
                UpdateState::Unconfigured
            })),
            check: Mutex::new(Some(check)),
            install: Mutex::new(Some(install)),
            restart,
        }
    }

    /// The current state snapshot.
    pub fn state(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }

    /// The status DTO for the current state.
    pub fn dto(&self) -> UpdateStatusDto {
        let state = self.state.lock().unwrap();
        let (update_version, bytes_downloaded, bytes_total, message) = match &*state {
            UpdateState::Available { version, .. } => (Some(version.clone()), 0, 0, None),
            UpdateState::Downloading { bytes, total } => (None, *bytes, *total, None),
            UpdateState::Error { message } => (None, 0, 0, Some(message.clone())),
            _ => (None, 0, 0, None),
        };
        UpdateStatusDto {
            state: state_key(&state).to_string(),
            current_version: self.current_version.clone(),
            update_version,
            bytes_downloaded,
            bytes_total,
            message,
        }
    }
}

static RUNTIME: Mutex<Option<Arc<UpdateRuntime>>> = Mutex::new(None);

/// The runtime, or an error naming the missing wiring (a command called
/// before the shell's `setup` registered it — a boot-order bug).
fn runtime() -> Result<Arc<UpdateRuntime>, String> {
    RUNTIME
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "update runtime not started".to_string())
}

/// Wire the production seams (the plugin's HTTP + the native asks) and the
/// current version into the runtime. Called once from the shell's `setup`
/// closure — BEFORE `start_boot_check` (PROV-IR-8's ordering).
pub fn register(app: &tauri::AppHandle) {
    let configured = updater_configured(app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|cfg| cfg.get("pubkey"))
        .and_then(|pk| pk.as_str()));
    let current_version = app.package_info().version.to_string();
    let runtime = Arc::new(UpdateRuntime::new(
        configured,
        current_version,
        plugin_check(app.clone()),
        plugin_install(app.clone()),
        ask_restart(app.clone()),
    ));
    *RUNTIME.lock().unwrap() = Some(runtime);
}

/// Test-only: replace the runtime with one built from the loopback seams.
/// `pub` because the integration suite is a separate crate. Dead in the
/// shipped lib (the shell's `register` is the only production writer) — the
/// injection surface is deliberately test-facing.
#[doc(hidden)]
#[allow(dead_code)]
pub fn set_runtime_for_tests(runtime: Arc<UpdateRuntime>) {
    *RUNTIME.lock().unwrap() = Some(runtime);
}

/// True when the config's updater `pubkey` is present and non-empty (DEC-5:
/// an EMPTY value is the runtime-disabled state; never a marker).
pub fn updater_configured(pubkey: Option<&str>) -> bool {
    matches!(pubkey, Some(pk) if !pk.trim().is_empty())
}

/// The state machine's lowercase key (the DTO's `state`).
pub fn state_key(state: &UpdateState) -> &'static str {
    match state {
        UpdateState::Unconfigured => "unconfigured",
        UpdateState::Idle => "idle",
        UpdateState::Checking => "checking",
        UpdateState::Available { .. } => "available",
        UpdateState::Downloading { .. } => "downloading",
        UpdateState::ReadyToRestart => "ready_to_restart",
        UpdateState::UpToDate => "up_to_date",
        UpdateState::Error { .. } => "error",
    }
}

/// The current platform's feed key (PROV-IR-1's mapping: the SAME artifact
/// serves both darwin keys; Linux x86_64; Windows x86_64 — the release
/// matrix, D09). The production check delegates the key resolution to the
/// plugin; the crate's own reader binds the same mapping for the loopback
/// contract test (dead in the shipped lib by design).
#[allow(dead_code)]
pub fn current_feed_target() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "linux-x86_64"
    }
    #[cfg(target_os = "macos")]
    {
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64"
        } else {
            "darwin-x86_64"
        }
    }
    #[cfg(target_os = "windows")]
    {
        "windows-x86_64"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "unknown"
    }
}

/// Read the frozen feed wire shape (PROV-landing-site-5 / CONS-IR-2): root
/// `{version, pub_date?, notes?, platforms: {key: {url, signature}}}`.
/// `Ok(None)` when the feed has no entry for [`current_feed_target`] (a valid
/// platform-less state — e.g. a macOS-only release on Linux). Every other
/// shape violation is `Err` naming the field. This is the crate's normative
/// reader of the contract — the loopback contract test drives it against the
/// body the ITEM-5 writer emits; production's check delegates the same shape
/// to the plugin (`Update` carries the same fields). Dead in the shipped lib
/// by design (production = the plugin); the reader is the crate's pinned
/// consumer grammar.
#[allow(dead_code)]
pub fn parse_feed(bytes: &[u8]) -> Result<Option<UpdateInfo>, String> {
    let feed: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("feed is not valid JSON: {e}"))?;
    let obj = feed
        .as_object()
        .ok_or_else(|| "feed root is not an object".to_string())?;
    let version = obj
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "feed is missing a non-empty version".to_string())?;
    let platforms = obj
        .get("platforms")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "feed is missing the platforms object".to_string())?;
    let entry = match platforms.get(current_feed_target()) {
        Some(entry) => entry,
        None => return Ok(None),
    };
    let entry = entry
        .as_object()
        .ok_or_else(|| "platform entry is not an object".to_string())?;
    let url = entry
        .get("url")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "platform entry is missing a non-empty url".to_string())?;
    // The signature is part of the frozen entry shape (the install path
    // verifies the artifact against it); the reader validates + discards it —
    // the state machine binds only version + url.
    if !entry
        .get("signature")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
    {
        return Err("platform entry is missing a non-empty signature".to_string());
    }
    Ok(Some(UpdateInfo {
        version: version.to_string(),
        url: url.to_string(),
    }))
}

/// True when `update` is strictly newer than `current`. CONSERVATIVE: a
/// version the parser does not understand (malformed, extra components,
/// empty pre-release identifiers) is never treated as newer — the plugin's
/// semver comparator remains the primary gate (TEST-IR-4).
pub fn is_newer(update: &str, current: &str) -> bool {
    match (parse_version(update), parse_version(current)) {
        (Some(u), Some(c)) => compare_versions(u, c).is_gt(),
        _ => false,
    }
}

/// A parsed version: `(major, minor, patch, pre)`.
type ParsedVersion = (u64, u64, u64, Option<String>);

fn parse_version(s: &str) -> Option<ParsedVersion> {
    let (core, pre) = match s.split_once('-') {
        Some((c, pre)) => {
            if pre.is_empty() {
                return None;
            }
            (c, Some(pre.to_string()))
        }
        None => (s, None),
    };
    let mut parts = core.split('.');
    let major = parts.next().and_then(|p| p.parse::<u64>().ok())?;
    let minor = parts.next().map(|p| p.parse::<u64>().ok()).unwrap_or(Some(0))?;
    let patch = parts.next().map(|p| p.parse::<u64>().ok()).unwrap_or(Some(0))?;
    if parts.next().is_some() || core.is_empty() {
        return None;
    }
    Some((major, minor, patch, pre))
}

/// semver-ish ordering: numeric dot-components then the pre-release part
/// (a pre-release is BELOW its plain release: `1.0.0-rc.1 < 1.0.0`).
fn compare_versions(a: ParsedVersion, b: ParsedVersion) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)) {
        Equal => match (a.3, b.3) {
            (None, None) => Equal,
            (Some(_), None) => Less,
            (None, Some(_)) => Greater,
            (Some(pa), Some(pb)) => compare_pre(&pa, &pb),
        },
        ord => ord,
    }
}

/// semver pre-release precedence: dot-separated identifiers, numeric ones
/// rank below alphanumeric ones, shorter suffixes below longer when a
/// prefix matches.
fn compare_pre(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let as_ = a.split('.');
    let bs = b.split('.');
    for (x, y) in as_.zip(bs) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
            (Ok(_), Err(_)) => Less,
            (Err(_), Ok(_)) => Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ord != Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len()).then_with(|| {
        // Equal identifiers but different lengths (e.g. `1` vs `01`) cannot
        // happen after segment comparison; fall back to byte order.
        a.cmp(b)
    })
}

/// The native-ask text for an available update (PROV-IR-6's copy; carries the
/// version and NO clinical claim — research-use app, DEC-15).
pub fn available_prompt_text(version: &str) -> String {
    format!(
        "TxResBench {version} is available — download and install now? \
         The app will restart after installing."
    )
}

/// The boot-check prompt decision (TEST-IR-17): `Some(text)` exactly when an
/// update is available; `None` on the silent states (`UpToDate`, `Error`,
/// `Unconfigured`, ...) — offline and failure are valid, quiet states
/// (DEC-14).
pub fn boot_prompt(state: &UpdateState) -> Option<String> {
    match state {
        UpdateState::Available { version, .. } => Some(available_prompt_text(version)),
        _ => None,
    }
}

/// The native-ask title for the update prompt.
pub const UPDATE_ASK_TITLE: &str = "Update available";
/// The affirmative button of the update ask.
pub const UPDATE_ASK_YES: &str = "Download & install";
/// The negative button of the update ask.
pub const UPDATE_ASK_NO: &str = "Later";
/// The "Restart now?" ask (the post-install step, DEC-15).
pub const RESTART_ASK_TITLE: &str = "Update installed";
pub const RESTART_ASK_MESSAGE: &str = "The new version is installed. Restart now?";
pub const RESTART_ASK_YES: &str = "Restart now";
pub const RESTART_ASK_NO: &str = "Later";

/// Current update status (IPC).
#[tauri::command]
pub fn get_update_status() -> Result<UpdateStatusDto, String> {
    Ok(runtime()?.dto())
}

/// Run one update check (IPC). `Unconfigured` (empty pubkey, DEC-5) returns
/// immediately WITHOUT touching the check seam — the never-dials rule
/// (TEST-IR-4). The seam is one-shot per session (DEC-14: one check per app
/// start); a second call returns the latched result as the error so a
/// double-trigger cannot re-dial.
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateStatusDto, String> {
    let rt = runtime()?;
    if !rt.configured {
        *rt.state.lock().unwrap() = UpdateState::Unconfigured;
        return Ok(rt.dto());
    }
    let check = rt
        .check
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "an update check already ran this session".to_string())?;
    *rt.state.lock().unwrap() = UpdateState::Checking;
    let mut sink = |_event: UpdateEvent| {};
    let result = check(UPDATER_FEED_URL, &mut sink).await;
    let outcome = match result {
        Ok(Some(info)) => {
            if is_newer(&info.version, &rt.current_version) {
                *rt.state.lock().unwrap() = UpdateState::Available {
                    version: info.version,
                    url: info.url,
                };
                Ok(rt.dto())
            } else {
                // Equal/older (or malformed announced version): not an update
                // — the plugin's comparator said "newer" over our parse; our
                // conservative gate refuses (TEST-IR-4).
                *rt.state.lock().unwrap() = UpdateState::UpToDate;
                Ok(rt.dto())
            }
        }
        Ok(None) => {
            // No update (feed current, no entry for this platform, 404).
            *rt.state.lock().unwrap() = UpdateState::UpToDate;
            Ok(rt.dto())
        }
        Err(message) => {
            *rt.state.lock().unwrap() = UpdateState::Error {
                message: message.clone(),
            };
            Err(message)
        }
    };
    outcome
}

/// Download + verify + install the available update, then request the restart
/// (IPC). A `ReadyToRestart` state (an install already completed) skips the
/// download and goes straight to the restart seam (TEST-IR-17); a failure
/// records `UpdateState::Error` and surfaces exactly one message (DEC-15).
#[tauri::command]
pub async fn install_update() -> Result<(), String> {
    let rt = runtime()?;
    if !rt.configured {
        return Err("update flow is not configured".to_string());
    }
    let info = {
        let state = rt.state.lock().unwrap();
        match &*state {
            UpdateState::Available { version, url } => UpdateInfo {
                version: version.clone(),
                url: url.clone(),
            },
            UpdateState::ReadyToRestart => {
                // The install already completed (a previous call): only the
                // restart remains (TEST-IR-17) — nothing to download.
                drop(state);
                (rt.restart)();
                return Ok(());
            }
            _ => {
                return Err("no update is available to install (state is not available)".to_string())
            }
        }
    };
    let install = rt
        .install
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "an update installation already ran this session".to_string())?;
    *rt.state.lock().unwrap() = UpdateState::Downloading { bytes: 0, total: 0 };
    let events = UpdateEvents::new({
        let state = rt.state.clone();
        move |event| match event {
            UpdateEvent::DownloadProgress {
                bytes_downloaded,
                bytes_total,
            } => {
                *state.lock().unwrap() = UpdateState::Downloading {
                    bytes: bytes_downloaded,
                    total: bytes_total,
                };
            }
        }
    });
    match install(&info, events).await {
        Ok(()) => {
            *rt.state.lock().unwrap() = UpdateState::ReadyToRestart;
            (rt.restart)();
            Ok(())
        }
        Err(message) => {
            *rt.state.lock().unwrap() = UpdateState::Error {
                message: message.clone(),
            };
            Err(message)
        }
    }
}

/// The once-per-start boot check (DEC-14): release builds only
/// (`!cfg!(debug_assertions)` — the DEV build never dials the feed), one
/// check per process, silent on `Error`/`UpToDate`, and a native ask on
/// `Available` (the already-registered `tauri-plugin-dialog`, DEC-2). The
/// next app start retries (no in-session retry loop).
///
/// Called from the shell's post-window setup path (PROV-IR-8; pinned by
/// TEST-IR-16's ITEM-4 half).
pub fn start_boot_check(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    if BOOT_CHECKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check_for_update().await {
            Ok(_) => {
                // The state carries the verdict (the DTO is the status
                // surface); the prompt decision is derived from it.
                match runtime() {
                    Ok(rt) => {
                        if let Some(prompt) = boot_prompt(&rt.state()) {
                            show_update_ask(&app, &prompt);
                        }
                    }
                    Err(_) => {}
                }
            }
            // Silent failure: offline is a valid state (DEC-14).
            Err(_) => {}
        }
    });
}

static BOOT_CHECKED: AtomicBool = AtomicBool::new(false);

/// The native ask (DEC-15): on "Download & install" the install runs (its
/// OWN `RestartFn` asks "Restart now?"); on "Later" the state stays
/// `Available` and the next app start re-checks.
fn show_update_ask(app: &tauri::AppHandle, prompt: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let message = prompt.to_string();
    app.dialog()
        .message(message)
        .title(UPDATE_ASK_TITLE)
        .kind(tauri_plugin_dialog::MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            UPDATE_ASK_YES.to_string(),
            UPDATE_ASK_NO.to_string(),
        ))
        .show(move |yes| {
            if yes {
                tauri::async_runtime::spawn(async move {
                    let _ = install_update().await;
                });
            }
        });
}

// ────────────────────────────────────────────────────────────────────────────
// Production seams (the plugin's HTTP + the native asks).
// ────────────────────────────────────────────────────────────────────────────

/// The plugin-backed check seam: `app.updater()` reads the config endpoints +
/// pubkey, checks, and maps the plugin result to the shell's
/// `UpdateInfo`/classification. `feed_url` is the crate's constant (the
/// plugin dials the config endpoints, which TEST-IR-14 pins to the same
/// value).
fn plugin_check(app: tauri::AppHandle) -> CheckFn {
    Box::new(move |_feed_url: &str, _events: &mut dyn FnMut(UpdateEvent)| {
        Box::pin(async move {
            use tauri_plugin_updater::UpdaterExt;
            let updater = app.updater().map_err(|e| e.to_string())?;
            match updater.check().await {
                Ok(Some(update)) => Ok(Some(UpdateInfo {
                    version: update.version.clone(),
                    url: update.download_url.to_string(),
                })),
                Ok(None) => Ok(None),
                // 404 / no entry for this platform / unsupported platform
                // are the silent "no update" class (acceptance example 5's
                // 404; DEC-14).
                Err(e) if silently_no_update(&e) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        })
    })
}

/// The plugin-backed install seam: re-check (the plugin's `Update` carries
/// the signature the download verifies against), then
/// `download_and_install` with the progress routed into the event sink.
fn plugin_install(app: tauri::AppHandle) -> InstallFn {
    Box::new(move |_info: &UpdateInfo, events: UpdateEvents| {
        Box::pin(async move {
            use tauri_plugin_updater::UpdaterExt;
            let updater = app.updater().map_err(|e| e.to_string())?;
            let update = match updater.check().await {
                Ok(Some(update)) => update,
                Ok(None) => return Err("update no longer available".to_string()),
                Err(e) if silently_no_update(&e) => {
                    return Err("update no longer available".to_string())
                }
                Err(e) => return Err(e.to_string()),
            };
            let mut downloaded: u64 = 0;
            update
                .download_and_install(
                    |chunk, total| {
                        downloaded += chunk as u64;
                        let total = total.unwrap_or(downloaded);
                        events.emit(UpdateEvent::DownloadProgress {
                            bytes_downloaded: downloaded,
                            bytes_total: total,
                        });
                    },
                    || {},
                )
                .await
                .map_err(|e| e.to_string())
        })
    })
}

/// The production restart seam: ask "Restart now?" (DEC-15), then
/// `app.restart()` on yes. `app.restart()` is tauri core's method — the
/// same underlying restart the process plugin's `restart` command wraps
/// (`request_restart`); tauri-plugin-process 2.4.0 ships no `ProcessExt`
/// trait any more (DRIFT-1 ITEM-4).
fn ask_restart(app: tauri::AppHandle) -> RestartFn {
    Box::new(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            app.dialog()
                .message(RESTART_ASK_MESSAGE)
                .title(RESTART_ASK_TITLE)
                .kind(tauri_plugin_dialog::MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    RESTART_ASK_YES.to_string(),
                    RESTART_ASK_NO.to_string(),
                ))
                .show(move |yes| {
                    if yes {
                        app.restart();
                    }
                });
        });
    })
}

/// The plugin error class that means "no update" (silent, DEC-14) — versus a
/// real failure (network down, bad pubkey, malformed feed) which records an
/// error state. Mirrors the plugin's own release-not-found semantics.
fn silently_no_update(e: &tauri_plugin_updater::Error) -> bool {
    matches!(
        e,
        tauri_plugin_updater::Error::ReleaseNotFound
            | tauri_plugin_updater::Error::TargetNotFound(_)
            | tauri_plugin_updater::Error::TargetsNotFound(_)
            | tauri_plugin_updater::Error::UnsupportedOs
            | tauri_plugin_updater::Error::UnsupportedArch
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Item-4 tests — TEST-IR-4 (state machine + is_newer + never-dials rule),
// TEST-IR-15 (single http(s) literal scan), plus the pure gate tests.
// Every test that replaces the runtime takes SERIAL: the runtime is
// process-global (a OnceLock), so the tests that mutate it are serialized.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the runtime-mutating tests (the one global slot).
    static SERIAL: Mutex<()> = Mutex::new(());

    /// A fake check seam: returns a canned outcome, records whether it was
    /// invoked, and (optionally) panics if invoked (never-dials).
    #[allow(clippy::too_many_arguments)]
    fn fake_runtime(
        configured: bool,
        check: CheckFn,
        install: Option<InstallFn>,
        restart_ran: Arc<AtomicBool>,
    ) -> Arc<UpdateRuntime> {
        let rt = UpdateRuntime::new(
            configured,
            "0.1.0".to_string(),
            check,
            install.unwrap_or_else(|| {
                Box::new(|_info: &UpdateInfo, _events: UpdateEvents| {
                    Box::pin(async { Err("install not injected".to_string()) })
                })
            }),
            Box::new(move || {
                restart_ran.store(true, Ordering::SeqCst);
            }),
        );
        let arc = Arc::new(rt);
        set_runtime_for_tests(arc.clone());
        arc
    }

    fn ok_check(info: Option<UpdateInfo>) -> CheckFn {
        Box::new(move |_url, _events| {
            let info = info.clone();
            Box::pin(async move { Ok(info) })
        })
    }

    fn err_check(message: &'static str) -> CheckFn {
        Box::new(move |_url, _events| {
            Box::pin(async move { Err(message.to_string()) })
        })
    }

    fn panicking_check() -> CheckFn {
        Box::new(|_url, _events| {
            panic!("the check seam must never run when the updater is unconfigured");
        })
    }

    fn download_install(ok: bool) -> InstallFn {
        Box::new(move |_info, events| {
            let ok = ok;
            Box::pin(async move {
                events.emit(UpdateEvent::DownloadProgress {
                    bytes_downloaded: 10,
                    bytes_total: 20,
                });
                // The event sink updates the state machine synchronously, so
                // the progress is observable on the runtime right after emit.
                assert_eq!(
                    runtime().expect("runtime set").state(),
                    UpdateState::Downloading { bytes: 10, total: 20 },
                    "the shell routes DownloadProgress into the state machine"
                );
                if ok {
                    Ok(())
                } else {
                    Err("download failed".to_string())
                }
            })
        })
    }

    // ── TEST-IR-4 ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn empty_pubkey_is_unconfigured_and_never_dials() {
        let _serial = SERIAL.lock().unwrap();
        let rt = fake_runtime(
            false,
            panicking_check(),
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let dto = check_for_update().await.expect("unconfigured is not an error");
        assert_eq!(dto.state, "unconfigured");
        assert_eq!(rt.state(), UpdateState::Unconfigured);
        // The check seam is a panicking seam: reaching this line proves it
        // was never invoked — an empty pubkey never dials the network
        // (INV-1, DEC-5).
    }

    #[tokio::test]
    async fn check_newer_feed_reaches_available() {
        let _serial = SERIAL.lock().unwrap();
        let rt = fake_runtime(
            true,
            ok_check(
                Some(UpdateInfo {
                    version: "0.2.0".to_string(),
                    url: "https://example.invalid/0.2.0.AppImage".to_string(),
                }),
            ),
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let dto = check_for_update().await.expect("check ok");
        assert_eq!(dto.state, "available");
        assert_eq!(dto.update_version.as_deref(), Some("0.2.0"));
        assert_eq!(
            rt.state(),
            UpdateState::Available {
                version: "0.2.0".to_string(),
                url: "https://example.invalid/0.2.0.AppImage".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn check_equal_or_older_feed_is_up_to_date() {
        let _serial = SERIAL.lock().unwrap();
        let rt = fake_runtime(
            true,
            ok_check(
                Some(UpdateInfo {
                    version: "0.1.0".to_string(),
                    url: "https://example.invalid/0.1.0.AppImage".to_string(),
                }),
            ),
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let dto = check_for_update().await.expect("older feed is ok");
        assert_eq!(dto.state, "up_to_date");
        assert_eq!(rt.state(), UpdateState::UpToDate);
    }

    #[tokio::test]
    async fn check_no_update_is_up_to_date() {
        let _serial = SERIAL.lock().unwrap();
        let rt = fake_runtime(
            true,
            ok_check(None),
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let dto = check_for_update().await.expect("no update is fine");
        assert_eq!(dto.state, "up_to_date");
        assert_eq!(rt.state(), UpdateState::UpToDate);
    }

    #[tokio::test]
    async fn the_state_is_checking_while_the_seam_runs() {
        // The transient `Checking` state is observable from INSIDE the seam:
        // the seam runs only after the state machine set `Checking`, so an
        // assertion in the seam fails on any reorder of that transition.
        let _serial = SERIAL.lock().unwrap();
        let rt = UpdateRuntime::new(
            true,
            "0.1.0".to_string(),
            Box::new(|_url, _events| {
                let rt = runtime().expect("runtime is set before the seam runs");
                assert_eq!(
                    rt.state(),
                    UpdateState::Checking,
                    "the state machine sets Checking before invoking the seam"
                );
                Box::pin(async { Ok(None) })
            }),
            Box::new(|_info, _events| Box::pin(async { Err("unused".to_string()) })),
            Box::new(|| {}),
        );
        let rt = Arc::new(rt);
        set_runtime_for_tests(rt.clone());

        let dto = check_for_update().await.expect("check");
        assert_eq!(dto.state, "up_to_date");
        assert_eq!(rt.state(), UpdateState::UpToDate);
    }

    #[tokio::test]
    async fn check_failure_records_error() {
        let _serial = SERIAL.lock().unwrap();
        let rt = fake_runtime(
            true,
            err_check("feed unreachable"),
            None,
            Arc::new(AtomicBool::new(false)),
        );

        let err = check_for_update().await.expect_err("failure surfaces");
        assert_eq!(err, "feed unreachable");
        assert_eq!(
            rt.state(),
            UpdateState::Error {
                message: "feed unreachable".to_string()
            }
        );
    }

    #[tokio::test]
    async fn the_check_seam_is_one_shot_per_session() {
        let _serial = SERIAL.lock().unwrap();
        let rt = fake_runtime(
            true,
            ok_check(None),
            None,
            Arc::new(AtomicBool::new(false)),
        );
        let first = check_for_update().await.expect("first check");
        assert_eq!(first.state, "up_to_date");
        // DEC-14: one check per app start — a second call errors instead of
        // re-dialing (the seam is consumed).
        let err = check_for_update().await.expect_err("one check per start");
        assert!(err.contains("already ran"), "{err}");
        assert_eq!(rt.state(), UpdateState::UpToDate, "the latched state survives");
    }

    #[tokio::test]
    async fn install_downloads_then_ready_to_restart_then_restart() {
        let _serial = SERIAL.lock().unwrap();
        let restart_ran = Arc::new(AtomicBool::new(false));
        let rt = fake_runtime(
            true,
            ok_check(
                Some(UpdateInfo {
                    version: "0.2.0".to_string(),
                    url: "https://example.invalid/u".to_string(),
                }),
            ),
            Some(download_install(true)),
            restart_ran.clone(),
        );

        check_for_update().await.expect("check");
        assert_eq!(
            rt.state(),
            UpdateState::Available {
                version: "0.2.0".to_string(),
                url: "https://example.invalid/u".to_string(),
            }
        );

        install_update().await.expect("install ok");
        assert_eq!(rt.state(), UpdateState::ReadyToRestart);
        assert!(
            restart_ran.load(Ordering::SeqCst),
            "a successful install requests the restart seam"
        );
        // The progress event was routed into the state machine.
        // (The seam emits 10/20 → Downloading is overwritten by ReadyToRestart;
        // the transition is pinned by the failed-install test's Error state.)
    }

    #[tokio::test]
    async fn install_failure_records_error_and_does_not_restart() {
        let _serial = SERIAL.lock().unwrap();
        let restart_ran = Arc::new(AtomicBool::new(false));
        let rt = fake_runtime(
            true,
            ok_check(
                Some(UpdateInfo {
                    version: "0.2.0".to_string(),
                    url: "https://example.invalid/u".to_string(),
                }),
            ),
            Some(download_install(false)),
            restart_ran.clone(),
        );

        check_for_update().await.expect("check");
        let err = install_update().await.expect_err("install failure");
        assert_eq!(err, "download failed");
        assert_eq!(
            rt.state(),
            UpdateState::Error {
                message: "download failed".to_string()
            }
        );
        assert!(
            !restart_ran.load(Ordering::SeqCst),
            "a failed install never requests a restart"
        );
    }

    #[tokio::test]
    async fn install_without_available_is_an_error_and_keeps_the_seam() {
        let _serial = SERIAL.lock().unwrap();
        let rt = fake_runtime(
            true,
            ok_check(None),
            Some(download_install(true)),
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(rt.state(), UpdateState::Idle);

        let err = install_update().await.expect_err("no update to install");
        assert!(err.contains("no update is available"), "{err}");
        // The state check runs BEFORE the seam is taken — a no-op never
        // consumes the install path.
        assert!(rt.install.lock().unwrap().is_some(), "seam kept");
    }

    #[tokio::test]
    async fn install_update_when_already_ready_requests_the_restart() {
        // TEST-IR-17: an install that already completed skips the download
        // and routes straight to the restart seam.
        let _serial = SERIAL.lock().unwrap();
        let restart_ran = Arc::new(AtomicBool::new(false));
        let rt = fake_runtime(
            true,
            ok_check(
                Some(UpdateInfo {
                    version: "0.2.0".to_string(),
                    url: "https://example.invalid/u".to_string(),
                }),
            ),
            Some(download_install(true)),
            restart_ran.clone(),
        );

        // Force the post-install state directly (the download path is pinned
        // by the test above).
        *rt.state.lock().unwrap() = UpdateState::ReadyToRestart;
        install_update().await.expect("the restart step only");
        assert!(
            restart_ran.load(Ordering::SeqCst),
            "install_update on ReadyToRestart requests the restart seam"
        );
        assert!(
            rt.install.lock().unwrap().is_some(),
            "the install seam is not consumed by the restart-only call"
        );
    }

    // ── TEST-IR-4: is_newer ───────────────────────────────────────────────

    #[test]
    fn newer_versions_compare_true() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("1.2.3", "1.2.2"));
        assert!(is_newer("1.2", "1.1.9"));
    }

    #[test]
    fn equal_older_and_malformed_versions_compare_false() {
        assert!(!is_newer("0.1.0", "0.1.0"), "equal is not newer");
        assert!(!is_newer("0.1.0", "0.2.0"), "older is not newer");
        assert!(!is_newer("abc", "0.1.0"), "malformed announced version refused");
        assert!(!is_newer("0.1.0", "abc"), "malformed current version refused");
        assert!(!is_newer("1.0.0.0", "1.0.0"), "extra component refused");
        assert!(!is_newer("", "0.1.0"), "empty announced version refused");
    }

    #[test]
    fn pre_release_versions_compare_semver_ish() {
        // A pre-release ranks BELOW its plain release (semver), so a feed
        // announcing the same numeric version as a pre-release is not newer.
        assert!(!is_newer("0.2.0-rc.1", "0.2.0"));
        assert!(is_newer("0.2.0-rc.1", "0.1.0"));
        assert!(!is_newer("0.2.0-rc.2", "0.2.0-rc.3"), "older pre-release refused");
    }

    // ── parse_feed (the wire-shape reader) ─────────────────────────────────

    fn feed_body(version: &str, platforms: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "version": version, "platforms": platforms }))
            .expect("feed serializes")
    }

    #[test]
    fn parse_feed_reads_the_current_platform_entry() {
        let body = feed_body(
            "0.2.0",
            serde_json::json!({
                "linux-x86_64": {"url": "https://example.invalid/app.AppImage", "signature": "sig"},
                "windows-x86_64": {"url": "https://example.invalid/app.exe", "signature": "sig"},
            }),
        );
        let info = parse_feed(&body)
            .expect("feed parses")
            .expect("current platform has an entry");
        assert_eq!(info.version, "0.2.0");
        assert_eq!(info.url, "https://example.invalid/app.AppImage");
    }

    #[test]
    fn parse_feed_none_when_the_current_platform_has_no_entry() {
        let body = feed_body(
            "0.2.0",
            serde_json::json!({
                "windows-x86_64": {"url": "https://example.invalid/app.exe", "signature": "sig"},
            }),
        );
        assert_eq!(
            parse_feed(&body).expect("feed parses"),
            None,
            "a release without an artifact for this platform is not an update"
        );
    }

    #[test]
    fn parse_feed_rejects_shape_violations() {
        for bad in [
            vec![b'{', b'a', b'c'],
            // platforms missing entirely (an empty OBJECT is valid — no
            // entry for this platform → Ok(None), asserted separately).
            serde_json::to_vec(&serde_json::json!({"version": "0.2.0"})).unwrap(),
            feed_body(
                "0.2.0",
                serde_json::json!({"linux-x86_64": {"url": "https://example.invalid/x", "signature": ""}}),
            ),
            feed_body(
                "0.2.0",
                serde_json::json!({"linux-x86_64": {"url": "", "signature": "sig"}}),
            ),
        ] {
            assert!(
                parse_feed(&bad).is_err(),
                "a malformed feed is refused: {bad:?}"
            );
        }
        let no_version = serde_json::to_vec(&serde_json::json!({"platforms": {}})).unwrap();
        assert!(parse_feed(&no_version).is_err(), "version is required");
    }

    // ── updater_configured ─────────────────────────────────────────────────

    #[test]
    fn updater_configured_rules() {
        assert!(updater_configured(Some("RWT9kY28Xo07UQyYSU8VJg==")));
        assert!(!updater_configured(Some("")));
        assert!(!updater_configured(Some("   ")));
        assert!(!updater_configured(None));
    }

    // ── TEST-IR-15 ─────────────────────────────────────────────────────────

    /// Count `http(s)://` literals in the crate's SHIPPED non-test source,
    /// with the same comment- and `#[cfg(test)]`-block stripping the repo's
    /// network-allowlist guard applies (scripts/check-network-allowlist.sh,
    /// its `clean()`). The invariant pairs with that guard: the crate's only
    /// literal is the feed URL, and the tauri config introduces no third URL.
    #[test]
    fn shipped_source_spells_exactly_one_https_url() {
        let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut literals: Vec<String> = Vec::new();
        let mut src_files = Vec::new();
        for entry in std::fs::read_dir(crate_dir.join("src")).expect("src dir") {
            let path = entry.expect("entry").path();
            if path.extension().is_some_and(|e| e == "rs") {
                src_files.push(path);
            }
        }
        src_files.sort();
        for path in src_files {
            let text = std::fs::read_to_string(&path).expect("read source");
            for lit in shipped_http_literals(&text) {
                literals.push(format!("{}: {lit}", path.file_name().unwrap().to_string_lossy()));
            }
        }
        let distinct: std::collections::BTreeSet<&str> =
            literals.iter().map(|l| l.split(": ").nth(1).unwrap()).collect();
        let feed_host = format!(
            "https://{}",
            UPDATER_FEED_URL
                .strip_prefix("https://")
                .expect("feed url is https")
                .split('/')
                .next()
                .expect("feed host")
        );
        assert_eq!(
            distinct.len(),
            1,
            "shipped desktop source spells exactly ONE https host (the feed's); got {literals:?}"
        );
        assert_eq!(
            distinct.iter().next().copied(),
            Some(feed_host.as_str()),
            "the one https host is the feed endpoint's (UPDATER_FEED_URL): {literals:?}"
        );

        // The tauri config mirrors the feed URL (TEST-IR-14) and carries the
        // schema URL (a pre-existing, never-fetched data line the guard
        // allowlists separately) and the dev server's loopback URL (also
        // guard-always; dev-only build config) — no THIRD host enters with
        // this item.
        let config = std::fs::read_to_string(crate_dir.join("tauri.conf.json")).expect("config");
        for lit in shipped_http_literals(&config) {
            assert!(
                lit == feed_host
                    || lit == "https://schema.tauri.app"
                    || lit == "http://localhost",
                "unexpected URL host in tauri.conf.json: {lit}"
            );
        }
    }

    /// The guard's `clean()` stripped to what the URL count needs: the
    /// package's `#[cfg(test)]` blocks (skip until a bare `}` line), `//`
    /// line comments (keeping `://`), and `/* */` blocks.
    fn shipped_http_literals(source: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut in_test = false;
        let mut stripped = String::new();
        for raw_line in source.lines() {
            let mut line: &str = raw_line;
            if line.trim_start().starts_with("///") || line.trim_start().starts_with("//!") {
                continue;
            }
            if line.contains("//") || line.contains("/*") {
                // Keep `://` intact while cutting `//` line comments and
                // `/* */` block comments (the crate's sources carry no
                // multi-line block comment — the guard's own `clean()` is
                // the authoritative implementation; this is the count's
                // approximation).
                let protected = line.replace("://", "PROT_SEQ");
                let code = protected.split("//").next().unwrap_or("");
                let code = code.replace("PROT_SEQ", "://");
                let code = code.split("/*").next().unwrap_or("").to_string();
                stripped.clear();
                stripped.push_str(&code);
                line = stripped.as_str();
            }
            if !in_test && line.contains("#[cfg(test)]") {
                in_test = true;
                continue;
            }
            if in_test {
                if line == "}" || line == "}\r" {
                    in_test = false;
                }
                continue;
            }
            for m in regex_like_urls(line) {
                out.push(m);
            }
        }
        out
    }

    /// `https?://host` extraction (same shape as the guard's regex).
    fn regex_like_urls(line: &str) -> Vec<String> {
        let mut urls = Vec::new();
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i..].starts_with(b"https://") {
                let rest = &line[i + 8..];
                let host: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
                    .collect();
                if !host.is_empty() {
                    urls.push(format!("https://{host}"));
                }
                i += 8 + host.len();
            } else if bytes[i..].starts_with(b"http://") {
                let rest = &line[i + 7..];
                let host: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
                    .collect();
                if !host.is_empty() {
                    urls.push(format!("http://{host}"));
                }
                i += 7 + host.len();
            } else {
                i += 1;
            }
        }
        urls
    }
}
