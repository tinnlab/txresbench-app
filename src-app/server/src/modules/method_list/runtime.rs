//! The list the app runs on.
//!
//! The app embeds ONE file, its built-in copy of the method list
//! (`data/method-list/method-list.json`, plus its `.minisig` once a published list is
//! imported; `scripts/import-method-list.sh` writes both). The catalogue and the image
//! list the app reads are that file's two nested documents: nothing else is compiled in.
//!
//! [`current`] hands out the list as an `Arc` snapshot. A request takes one snapshot and
//! asks it everything; a run takes one at its start and keeps it to the end (its plans,
//! its facts, its images), so a list that changes meanwhile never mixes into it.
//!
//! The built-in copy is first-party data: one that does not verify or parse is a boot
//! refusal (the module's `init`), never a silently empty list.
//!
//! A newer list replaces it between runs ([`ListRuntime`]): the last good list on disk
//! (`store`), and the live one from the registry (`fetch`). Each one verifies before it
//! parses, and the valid list with the highest sequence wins: a lower one is a rollback
//! and an equal one with other bytes a conflict, both refused (their digests remembered,
//! never pulled again, never written to disk). A check runs at boot (in the background)
//! and before a run starts (short budgets; any failure keeps the list in use); checks
//! never overlap and one within the last minute is reused. There is no timer: the app
//! does not ask the registry while it is idle. Demo mode never moves off the built-in
//! list.

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::Serialize;

use super::fetch::{self, FetchError, Fetched, ListSource};
use super::format::{self, ListError, MethodList};
use super::keys::TrustedKeys;
use super::store::{ListStore, StoreState};
use super::verify::{self, VerifiedList, VerifyError};
use crate::modules::execution_engine::envmanifest::{self, ManifestLoadError};

/// The built-in list. `$CARGO_MANIFEST_DIR` is `src-app/server`.
const BUILTIN_LIST: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../data/method-list/method-list.json"
));

// `BUILTIN_SIGNATURE: Option<&[u8]>`: the built-in list's `.minisig`, which exists only from
// the first imported published list on (the sequence 0 bootstrap copy has none). The build
// script writes the include, or `None`, because `include_bytes!` cannot name a file that
// may be absent.
include!(concat!(env!("OUT_DIR"), "/builtin_method_list_signature.rs"));

/// Why the built-in list cannot be loaded (a build defect: the boot refuses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuiltinError {
    /// The signature does not verify with the compiled-in trusted keys.
    Verify(VerifyError),
    /// The list's body is refused.
    List(ListError),
    /// The debug-only `TXR_ENV_MANIFEST` override cannot be read.
    DevManifest(ManifestLoadError),
}

impl fmt::Display for BuiltinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BuiltinError::Verify(e) => write!(f, "the built-in method list: {e}"),
            BuiltinError::List(e) => write!(f, "the built-in method list: {e}"),
            BuiltinError::DevManifest(e) => write!(f, "the TXR_ENV_MANIFEST override: {e}"),
        }
    }
}

impl std::error::Error for BuiltinError {}

/// Verify and parse a built-in copy: with its signature against `keys`, or, without one,
/// as the unsigned bootstrap copy (accepted only at sequence 0).
fn load_builtin_with(
    bytes: &[u8],
    signature: Option<&[u8]>,
    keys: &TrustedKeys,
) -> Result<MethodList, BuiltinError> {
    let verified = match signature {
        Some(sig) => verify::verify_with(bytes, sig, keys).map_err(BuiltinError::Verify)?,
        None => VerifiedList::unsigned_bootstrap(bytes.to_vec()).map_err(BuiltinError::Verify)?,
    };
    format::parse(verified).map_err(BuiltinError::List)
}

/// The built-in list, with the debug-only `TXR_ENV_MANIFEST` override applied (a debug
/// build may replace the images half with a dev registry's list; a release build never
/// reads the variable).
fn load_builtin() -> Result<MethodList, BuiltinError> {
    let keys = TrustedKeys::builtin().map_err(|e| BuiltinError::Verify(e.into()))?;
    let mut list = load_builtin_with(BUILTIN_LIST, BUILTIN_SIGNATURE, keys)?;
    if let Some(images) = envmanifest::dev_manifest_override().map_err(BuiltinError::DevManifest)? {
        list.images = images;
    }
    Ok(list)
}

static BUILTIN: OnceLock<Result<Arc<MethodList>, BuiltinError>> = OnceLock::new();

/// Load (once) the built-in list, or the named refusal. The module's `init` calls this, so
/// a bad built-in copy stops the boot.
pub fn ensure_builtin() -> Result<&'static Arc<MethodList>, BuiltinError> {
    BUILTIN
        .get_or_init(|| load_builtin().map(Arc::new))
        .as_ref()
        .map_err(Clone::clone)
}

/// The built-in list. Production code asks [`current`]; the built-in copy is for what
/// must not move with an update (demo mode replays recordings made against it) and for
/// tests about the shipped data.
pub fn builtin() -> &'static MethodList {
    ensure_builtin().expect(
        "method_list: the built-in method list failed its boot check; a bad first-party \
         list is a boot refusal, not an empty one",
    )
}

/// Whether the debug-only `TXR_ENV_MANIFEST` override replaced the built-in images.
pub fn dev_manifest_active() -> bool {
    envmanifest::dev_manifest_override_path().is_some()
}

// ─────────────────────────────────────────────────────────────────────────────
// The current list: built-in, last good on disk, live
// ─────────────────────────────────────────────────────────────────────────────

/// Where the list in use came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ListOrigin {
    /// The copy built into this app release.
    Builtin,
    /// The last good list a previous session fetched (`<data_root>/method-list/v1/`).
    Disk,
    /// Fetched and verified in this session.
    Live,
}

/// The list in use and where it came from.
#[derive(Debug, Clone)]
pub struct Active {
    pub list: Arc<MethodList>,
    pub origin: ListOrigin,
}

/// What the last check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckResult {
    /// No check yet.
    NotChecked,
    /// The published list is the one in use (or older than the built-in copy).
    Current,
    /// A newer published list was verified and is in use.
    Updated,
    /// The registry could not be reached (no connection, DNS, a firewall, a timeout).
    Unreachable,
    /// This build cannot fetch (no download tool next to the app).
    Unavailable,
    /// The published list was refused (signature, key, size, contents, an older or a
    /// conflicting list): the app keeps the list it has.
    Refused,
    /// The published list is of a newer format: a newer app is needed for it.
    NeedsNewerApp,
    /// Updates are off (demo mode; a debug build's dev images list).
    Off,
}

/// `GET /api/methods/updates`: the list in use and the last check.
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
pub struct MethodListStatus {
    /// The sequence of the list in use (0: the built-in copy from before the first publish).
    pub sequence: u64,
    pub origin: ListOrigin,
    /// When the list in use was assembled (`YYYY-MM-DDTHH:MM:SSZ`).
    pub assembled_at: String,
    /// Who signed the list in use; `None` for the unsigned built-in copy.
    pub signer: Option<String>,
    /// Whether this app checks for newer lists (false in demo mode).
    pub updates_enabled: bool,
    pub last_check: CheckResult,
    /// When the last check finished (in this or an earlier session).
    pub last_checked_at: Option<DateTime<Utc>>,
    /// The last check's problem, in a plain sentence; `None` when it went well.
    pub last_error: Option<String>,
}

/// How long one check may wait on the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckBudget {
    pub resolve: Duration,
    /// Spent only when the published digest is new.
    pub pull: Duration,
}

impl CheckBudget {
    /// At boot (in the background) and from the Settings button.
    pub const BACKGROUND: CheckBudget = CheckBudget {
        resolve: Duration::from_secs(10),
        pull: Duration::from_secs(60),
    };
    /// Before a run starts: short, a run never waits long for the list.
    pub const RUN_START: CheckBudget = CheckBudget {
        resolve: Duration::from_secs(5),
        pull: Duration::from_secs(30),
    };
}

/// A check within this window is reused instead of asking the registry again.
pub const COALESCE_WINDOW: Duration = Duration::from_secs(60);

/// What the runtime is built with (production: [`production_seams`]; tests: their own).
pub struct RuntimeSeams {
    /// `<data_root>`: the last good list lives under `method-list/v1/`.
    pub data_root: PathBuf,
    /// Where lists come from; `None` turns updates off.
    pub source: Option<Arc<dyn ListSource>>,
    /// Why updates are off (logged), when `source` is `None`.
    pub off_reason: Option<String>,
    /// The keys a fetched or stored list must be signed with.
    pub keys: TrustedKeys,
    /// [`COALESCE_WINDOW`] in production.
    pub coalesce: Duration,
}

/// What one check did (recorded for the status).
#[derive(Debug, Clone)]
struct CheckRecord {
    result: CheckResult,
    /// The plain sentence the status shows.
    error: Option<String>,
    at: Option<DateTime<Utc>>,
    /// When it finished in THIS process (the coalescing clock).
    finished: Option<Instant>,
}

/// How a verified, parsed candidate compares with the list in use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    /// A higher sequence: it replaces the list in use.
    Newer,
    /// The same sequence and the same bytes.
    Same,
    /// A lower sequence: a rollback, refused.
    Older,
    /// The same sequence with other bytes: refused.
    Conflict,
}

/// The highest valid sequence wins; a lower one is a rollback, the same one with other
/// bytes a conflict.
pub fn choose(in_use: &MethodList, candidate: &MethodList) -> Choice {
    use std::cmp::Ordering::*;
    match candidate.sequence.cmp(&in_use.sequence) {
        Greater => Choice::Newer,
        Less => Choice::Older,
        Equal if candidate.sha256 == in_use.sha256 => Choice::Same,
        Equal => Choice::Conflict,
    }
}

/// The current list and its updates.
pub struct ListRuntime {
    active: RwLock<Active>,
    seams: RuntimeSeams,
    store: ListStore,
    /// One check at a time; a caller that waited reuses the check that just ran.
    turn: tokio::sync::Mutex<()>,
    record: Mutex<CheckRecord>,
    /// `state.json`: the held digest and the refused ones.
    state: Mutex<StoreState>,
}

/// Verify (before anything reads it) and parse a list.
fn verify_and_parse(list: &[u8], signature: &[u8], keys: &TrustedKeys) -> Result<MethodList, String> {
    let verified = verify::verify_with(list, signature, keys).map_err(|e| e.to_string())?;
    format::parse(verified).map_err(|e| e.to_string())
}

impl ListRuntime {
    /// A runtime on `builtin`, moved to the stored list when that one verifies and is
    /// newer (updates on only).
    pub fn new(builtin: Arc<MethodList>, seams: RuntimeSeams) -> ListRuntime {
        let store = ListStore::new(&seams.data_root);
        let mut state = store.read_state();
        let mut active = Active {
            list: builtin.clone(),
            origin: ListOrigin::Builtin,
        };
        let updates_on = seams.source.is_some();
        if updates_on {
            if let Some((bytes, sig)) = store.read_list() {
                match verify_and_parse(&bytes, &sig, &seams.keys) {
                    Ok(stored) => match choose(&builtin, &stored) {
                        Choice::Newer => match stored.keeps_rows_of(&builtin) {
                            Ok(()) => {
                                tracing::info!(
                                    sequence = stored.sequence,
                                    builtin = builtin.sequence,
                                    "method list: using the stored list"
                                );
                                active = Active {
                                    list: Arc::new(stored),
                                    origin: ListOrigin::Disk,
                                };
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "method list: the stored list drops a row of the built-in one; ignored");
                                state.live_digest = None;
                            }
                        },
                        Choice::Same | Choice::Older => tracing::info!(
                            stored = stored.sequence,
                            builtin = builtin.sequence,
                            "method list: the built-in list is the same or newer than the stored one (an app update)"
                        ),
                        Choice::Conflict => {
                            tracing::warn!(
                                sequence = stored.sequence,
                                stored = %stored.sha256,
                                builtin = %builtin.sha256,
                                "method list: the stored list has the built-in sequence with other bytes; ignored"
                            );
                            state.live_digest = None;
                        }
                    },
                    Err(e) => {
                        // A torn write or an edit: run on the built-in list, fetch again.
                        tracing::warn!(error = %e, "method list: the stored list does not verify; ignored");
                        state.live_digest = None;
                        let _ = store.write_state(&state);
                    }
                }
            }
        }
        let record = CheckRecord {
            result: if updates_on {
                CheckResult::NotChecked
            } else {
                CheckResult::Off
            },
            error: if updates_on { state.last_error.clone() } else { None },
            at: state
                .last_check_at
                .as_deref()
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&Utc)),
            finished: None,
        };
        ListRuntime {
            active: RwLock::new(active),
            seams,
            store,
            turn: tokio::sync::Mutex::new(()),
            record: Mutex::new(record),
            state: Mutex::new(state),
        }
    }

    /// The list in use, as a snapshot.
    pub fn current(&self) -> Arc<MethodList> {
        self.active().list
    }

    /// The list in use and its origin.
    pub fn active(&self) -> Active {
        self.active.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Whether this runtime checks for newer lists.
    pub fn updates_enabled(&self) -> bool {
        self.seams.source.is_some()
    }

    /// The status the routes answer.
    pub fn status(&self) -> MethodListStatus {
        let active = self.active();
        let record = self.record.lock().unwrap_or_else(|e| e.into_inner()).clone();
        MethodListStatus {
            sequence: active.list.sequence,
            origin: active.origin,
            assembled_at: active.list.assembled_at.clone(),
            signer: active.list.signer.as_ref().map(|s| s.label.clone()),
            updates_enabled: self.updates_enabled(),
            last_check: record.result,
            last_checked_at: record.at,
            last_error: record.error,
        }
    }

    /// An automatic check (boot, run start): at most one check runs at a time, and one that
    /// finished within the coalescing window (a minute) is reused. Never fails: a problem
    /// is the status (the app keeps the list it has).
    pub async fn check(self: &Arc<Self>, budget: CheckBudget) -> MethodListStatus {
        self.check_within(budget, self.seams.coalesce).await
    }

    /// A check the user asked for (the Settings button and its action): it asks the
    /// registry now, unless a check finished while this one waited for its turn (two
    /// presses at once share one).
    pub async fn check_now(self: &Arc<Self>) -> MethodListStatus {
        self.check_within(CheckBudget::BACKGROUND, Duration::ZERO).await
    }

    async fn check_within(self: &Arc<Self>, budget: CheckBudget, window: Duration) -> MethodListStatus {
        let Some(source) = self.seams.source.clone() else {
            return self.status();
        };
        let asked = Instant::now();
        let _turn = self.turn.lock().await;
        let reuse = self
            .record
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finished
            .is_some_and(|t| t >= asked || t.elapsed() < window);
        if reuse {
            return self.status();
        }
        let this = self.clone();
        let outcome = tokio::task::spawn_blocking(move || this.check_blocking(source.as_ref(), budget))
            .await
            .unwrap_or_else(|e| (CheckResult::Unreachable, Some(format!("The check did not finish ({e})."))));
        self.finish(outcome);
        self.status()
    }

    /// Record a finished check and save the state.
    fn finish(&self, (result, error): (CheckResult, Option<String>)) {
        let now = Utc::now();
        {
            let mut record = self.record.lock().unwrap_or_else(|e| e.into_inner());
            *record = CheckRecord {
                result,
                error: error.clone(),
                at: Some(now),
                finished: Some(Instant::now()),
            };
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.last_check_at = Some(now.to_rfc3339());
        state.last_error = error;
        if let Err(e) = self.store.write_state(&state) {
            tracing::warn!(error = %e, "method list: the check state could not be saved");
        }
    }

    fn remember_bad(&self, digest: &str) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remember_bad(digest);
    }

    /// One check (blocking: oras runs as a child process).
    fn check_blocking(&self, source: &dyn ListSource, budget: CheckBudget) -> (CheckResult, Option<String>) {
        let digest = match source.resolve(budget.resolve) {
            Ok(d) => d,
            Err(e) => return self.fetch_failed(source, None, e),
        };
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.live_digest.as_deref() == Some(digest.as_str()) {
                return (CheckResult::Current, None);
            }
            if state.is_bad(&digest) {
                return (
                    CheckResult::Refused,
                    Some("The published method list was refused before; the app keeps the list it has.".to_string()),
                );
            }
        }
        let fetched = match source.pull(&digest, budget.pull) {
            Ok(f) => f,
            Err(e) => return self.fetch_failed(source, Some(&digest), e),
        };
        // The signature is checked on the raw bytes before anything parses them.
        let verified = match verify::verify_with(&fetched.list, &fetched.signature, &self.seams.keys) {
            Ok(v) => v,
            Err(e) => return self.refuse(&digest, e.code(), &e.to_string()),
        };
        let list = match format::parse(verified) {
            Ok(l) => l,
            Err(e @ ListError::FormatVersion { .. }) => {
                self.remember_bad(&digest);
                tracing::warn!(%digest, error = %e, "method list: the published list needs a newer app");
                return (
                    CheckResult::NeedsNewerApp,
                    Some("A newer method list was published for a newer version of the app.".to_string()),
                );
            }
            Err(e) => return self.refuse(&digest, e.code(), &e.to_string()),
        };
        self.offer(list, &digest, &fetched)
    }

    /// A verified, parsed list from the registry: taken when newer, refused when older or
    /// conflicting.
    fn offer(&self, list: MethodList, digest: &str, fetched: &Fetched) -> (CheckResult, Option<String>) {
        let in_use = self.current();
        match choose(&in_use, &list) {
            Choice::Newer => {
                if let Err(e) = list.keeps_rows_of(&in_use) {
                    return self.refuse(digest, e.code(), &e.to_string());
                }
                let stored = self.store.write_list(&fetched.list, &fetched.signature);
                let (from, to) = (in_use.sequence, list.sequence);
                *self.active.write().unwrap_or_else(|e| e.into_inner()) = Active {
                    list: Arc::new(list),
                    origin: ListOrigin::Live,
                };
                tracing::info!(from, to, %digest, "method list: a newer list is in use");
                match stored {
                    Ok(()) => {
                        self.state.lock().unwrap_or_else(|e| e.into_inner()).live_digest =
                            Some(digest.to_string());
                        (CheckResult::Updated, None)
                    }
                    Err(e) => {
                        // In use for this session; not remembered, so the next start fetches it again.
                        tracing::warn!(error = %e, "method list: the new list could not be saved");
                        (
                            CheckResult::Updated,
                            Some(format!(
                                "Method list #{to} is in use but could not be saved; the app fetches it again at the next start."
                            )),
                        )
                    }
                }
            }
            Choice::Same => {
                self.state.lock().unwrap_or_else(|e| e.into_inner()).live_digest = Some(digest.to_string());
                (CheckResult::Current, None)
            }
            Choice::Older => {
                tracing::warn!(
                    published = list.sequence,
                    in_use = in_use.sequence,
                    published_sha256 = %list.sha256,
                    in_use_sha256 = %in_use.sha256,
                    %digest,
                    "method list: the published list is older than the one in use (a rollback); refused"
                );
                self.remember_bad(digest);
                (
                    CheckResult::Refused,
                    Some(format!(
                        "The published method list #{} is older than #{} in use; it was not used.",
                        list.sequence, in_use.sequence
                    )),
                )
            }
            Choice::Conflict => {
                tracing::warn!(
                    sequence = list.sequence,
                    published_sha256 = %list.sha256,
                    in_use_sha256 = %in_use.sha256,
                    %digest,
                    "method list: the published list has the sequence in use with other bytes; refused"
                );
                self.remember_bad(digest);
                (
                    CheckResult::Refused,
                    Some(format!(
                        "The published method list #{} is not the #{} in use; it was not used.",
                        list.sequence, in_use.sequence
                    )),
                )
            }
        }
    }

    /// A refused published list: remembered (never pulled again), never written to disk.
    fn refuse(&self, digest: &str, code: &str, detail: &str) -> (CheckResult, Option<String>) {
        tracing::warn!(%digest, code, detail, "method list: the published list was refused");
        self.remember_bad(digest);
        (
            CheckResult::Refused,
            Some(format!(
                "The published method list was refused ({code}); the app keeps the list it has."
            )),
        )
    }

    fn fetch_failed(
        &self,
        source: &dyn ListSource,
        digest: Option<&str>,
        e: FetchError,
    ) -> (CheckResult, Option<String>) {
        tracing::info!(source = %source.describe(), error = %e, "method list: the check did not get a list");
        if let (true, Some(d)) = (e.is_artifact_fault(), digest) {
            return self.refuse(d, e.code(), &e.to_string());
        }
        match e {
            FetchError::ToolMissing => (
                CheckResult::Unavailable,
                Some("This build cannot check for method updates (its download tool is missing).".to_string()),
            ),
            FetchError::Local { .. } => (
                CheckResult::Unreachable,
                Some("The method list check could not run.".to_string()),
            ),
            _ => (
                CheckResult::Unreachable,
                Some("The method list could not be reached (no connection, or blocked by a firewall or proxy).".to_string()),
            ),
        }
    }
}

/// The production seams: the registry through oras (the debug seams may name another
/// reference and one more key), the app data root, the compiled-in keys. Updates are off
/// in demo mode (recorded runs replay the built-in list) and while a debug build's
/// `TXR_ENV_MANIFEST` replaces the images.
pub fn production_seams(data_root: PathBuf) -> RuntimeSeams {
    let builtin_keys = TrustedKeys::builtin().cloned();
    let mut keys = builtin_keys.unwrap_or_else(|_| {
        TrustedKeys::from_json(br#"{"format":"txresbench-method-list-keys","format_version":1,"keys":[]}"#)
            .expect("an empty key set")
    });
    let off = |why: &str| RuntimeSeams {
        data_root: data_root.clone(),
        source: None,
        off_reason: Some(why.to_string()),
        keys: keys.clone(),
        coalesce: COALESCE_WINDOW,
    };
    if crate::modules::demo::enabled() {
        return off("demo mode replays the built-in list");
    }
    if dev_manifest_active() {
        return off("TXR_ENV_MANIFEST replaces the images (a debug build)");
    }
    let list_ref = match fetch::list_ref() {
        Ok(r) => r,
        Err(e) => return off(&e),
    };
    if let Some(path) = fetch::test_key_path() {
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| keys.with_minisign_pub(&text, "test key (TXR_METHOD_LIST_TEST_KEY)").map_err(|e| e.to_string()))
        {
            Ok(k) => {
                tracing::warn!(path = %path.display(), "method list: trusting a TEST key (debug build)");
                keys = k;
            }
            Err(e) => return off(&format!("{}: {e}", fetch::TEST_KEY_ENV)),
        }
    }
    if list_ref != fetch::ListRef::production() {
        tracing::warn!(reference = %list_ref.tag_ref(), "method list: fetching from the debug reference");
    }
    let work_dir = ListStore::new(&data_root).dir().to_path_buf();
    RuntimeSeams {
        source: Some(Arc::new(fetch::OrasSource::new(list_ref, work_dir))),
        data_root,
        off_reason: None,
        keys,
        coalesce: COALESCE_WINDOW,
    }
}

static RUNTIME: OnceLock<Arc<ListRuntime>> = OnceLock::new();

/// Install the process's runtime (the module's `init`; the first one wins).
pub fn install(runtime: ListRuntime) -> &'static Arc<ListRuntime> {
    let _ = RUNTIME.set(Arc::new(runtime));
    RUNTIME.get().expect("installed by this call or an earlier one")
}

/// The process's runtime, once the module's `init` installed it.
pub fn runtime() -> Option<&'static Arc<ListRuntime>> {
    RUNTIME.get()
}

/// The current list, as a snapshot: take it once per request (or once per run) and ask
/// it everything. Before the module's `init` (in unit tests), the built-in list.
pub fn current() -> Arc<MethodList> {
    match RUNTIME.get() {
        Some(rt) => rt.current(),
        None => ensure_builtin()
            .cloned()
            .unwrap_or_else(|e| panic!("method_list: {e}")),
    }
}

/// The status, or the built-in list's when no runtime is installed.
pub fn status() -> MethodListStatus {
    match RUNTIME.get() {
        Some(rt) => rt.status(),
        None => {
            let b = builtin();
            MethodListStatus {
                sequence: b.sequence,
                origin: ListOrigin::Builtin,
                assembled_at: b.assembled_at.clone(),
                signer: b.signer.as_ref().map(|s| s.label.clone()),
                updates_enabled: false,
                last_check: CheckResult::Off,
                last_checked_at: None,
                last_error: None,
            }
        }
    }
}

/// The short check before a run takes its snapshot (any failure: the run goes on with
/// the list in use).
pub async fn check_before_run() {
    if let Some(rt) = RUNTIME.get() {
        let _ = rt.check(CheckBudget::RUN_START).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The built-in copy verifies with the app's own trusted keys and parses; the sequence 0
    /// bootstrap copy (before the first publish) is the only one without a signature.
    #[test]
    fn builtin_signature_verifies() {
        let keys = TrustedKeys::builtin().expect("the compiled-in keys parse");
        let list = load_builtin_with(BUILTIN_LIST, BUILTIN_SIGNATURE, keys)
            .expect("the built-in list verifies and parses");
        match BUILTIN_SIGNATURE {
            Some(sig) => {
                let v = verify::verify(BUILTIN_LIST, sig).expect("signed by a trusted key");
                assert_eq!(v.comment().map(|c| c.sequence), Some(list.sequence));
                assert!(list.sequence >= 1, "a signed built-in copy is a published list");
                assert!(list.signer.is_some());
            }
            None => {
                assert_eq!(list.sequence, 0, "only the bootstrap copy is unsigned");
                assert!(list.signer.is_none());
            }
        }
        assert_eq!(builtin().sequence, list.sequence);
        assert!(!builtin().catalogue.methods.is_empty());
    }

    #[test]
    fn a_tampered_builtin_is_a_named_refusal() {
        let keys = TrustedKeys::builtin().expect("keys");
        let err = load_builtin_with(b"{ not json", None, keys).unwrap_err();
        assert!(matches!(err, BuiltinError::List(ref e) if e.code() == "METHOD_LIST_HEADER_INVALID"), "{err}");
        // A signature that does not verify is refused before the parse.
        let err = load_builtin_with(BUILTIN_LIST, Some(b"not a signature"), keys).unwrap_err();
        assert!(matches!(err, BuiltinError::Verify(_)), "{err}");
    }

    #[test]
    fn current_starts_on_the_builtin_list() {
        let list = current();
        assert_eq!(list.sha256, builtin().sha256);
    }

    // ── the runtime: built-in, disk, live ───────────────────────────────────

    use super::super::test_sign::TestSigner;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const FIXTURE_LIST: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/list-dir/method-list.json"
    ));
    const FIXTURE_KEYS: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/method-list/fixtures/fixture-keys.json"
    ));

    fn keys() -> TrustedKeys {
        TrustedKeys::from_json(FIXTURE_KEYS).expect("fixture keys")
    }

    /// The fixture list (3 methods) at `sequence`, signed by the test key. `variant` changes
    /// the assembly time, so two variants of one sequence are other bytes.
    fn signed(sequence: u64, variant: u32) -> Fetched {
        signed_doc(sequence, variant, |_| {})
    }

    fn signed_doc(sequence: u64, variant: u32, edit: impl FnOnce(&mut serde_json::Value)) -> Fetched {
        let mut doc: serde_json::Value = serde_json::from_slice(FIXTURE_LIST).unwrap();
        doc["sequence"] = sequence.into();
        doc["assembled_at"] = format!("2026-02-{:02}T00:00:{variant:02}Z", sequence.min(28) + 1).into();
        edit(&mut doc);
        let list = serde_json::to_vec(&doc).unwrap();
        let signature = TestSigner::fixture().sign_list(&list).into_bytes();
        Fetched { list, signature }
    }

    fn parsed(f: &Fetched) -> Arc<MethodList> {
        Arc::new(verify_and_parse(&f.list, &f.signature, &keys()).expect("a valid fixture list"))
    }

    /// The unsigned sequence 0 bootstrap copy of the fixture list.
    fn bootstrap() -> Arc<MethodList> {
        let mut doc: serde_json::Value = serde_json::from_slice(FIXTURE_LIST).unwrap();
        doc["sequence"] = 0.into();
        let v = VerifiedList::unsigned_bootstrap(serde_json::to_vec(&doc).unwrap()).unwrap();
        Arc::new(format::parse(v).unwrap())
    }

    fn digest(n: u8) -> String {
        format!("sha256:{}", format!("{n:02x}").repeat(32))
    }

    /// An in-memory registry: the moving tag's digest and the artifacts by digest.
    #[derive(Default)]
    struct FakeSource {
        tag: Mutex<Option<Result<String, FetchError>>>,
        artifacts: Mutex<HashMap<String, Result<Fetched, FetchError>>>,
        resolves: AtomicUsize,
        pulls: AtomicUsize,
        delay: Duration,
    }

    impl FakeSource {
        fn publish(&self, digest: &str, artifact: Result<Fetched, FetchError>) {
            *self.tag.lock().unwrap() = Some(Ok(digest.to_string()));
            self.artifacts.lock().unwrap().insert(digest.to_string(), artifact);
        }
        fn fail_resolve(&self, e: FetchError) {
            *self.tag.lock().unwrap() = Some(Err(e));
        }
        fn counts(&self) -> (usize, usize) {
            (self.resolves.load(Ordering::SeqCst), self.pulls.load(Ordering::SeqCst))
        }
    }

    impl ListSource for FakeSource {
        fn describe(&self) -> String {
            "fake registry".to_string()
        }
        fn resolve(&self, _timeout: Duration) -> Result<String, FetchError> {
            self.resolves.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            self.tag.lock().unwrap().clone().unwrap_or(Err(FetchError::Unreachable {
                detail: "nothing published".into(),
            }))
        }
        fn pull(&self, digest: &str, _timeout: Duration) -> Result<Fetched, FetchError> {
            self.pulls.fetch_add(1, Ordering::SeqCst);
            self.artifacts
                .lock()
                .unwrap()
                .get(digest)
                .cloned()
                .unwrap_or(Err(FetchError::Unreachable { detail: "no such digest".into() }))
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("txr-method-list-runtime-tests")
            .join(format!("{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn runtime_on(
        builtin: Arc<MethodList>,
        root: &Path,
        source: Option<Arc<FakeSource>>,
        coalesce: Duration,
    ) -> Arc<ListRuntime> {
        Arc::new(ListRuntime::new(
            builtin,
            RuntimeSeams {
                data_root: root.to_path_buf(),
                source: source.map(|s| s as Arc<dyn ListSource>),
                off_reason: None,
                keys: keys(),
                coalesce,
            },
        ))
    }

    fn store_on_disk(root: &Path, f: &Fetched) {
        ListStore::new(root).write_list(&f.list, &f.signature).unwrap();
    }

    #[tokio::test]
    async fn chooses_highest_valid_among_builtin_disk_live() {
        // (built-in, stored, published) → the sequence in use and where it came from.
        let cases: &[(u64, Option<u64>, Option<u64>, u64, ListOrigin)] = &[
            (1, None, None, 1, ListOrigin::Builtin),
            (1, Some(2), None, 2, ListOrigin::Disk),
            (1, Some(2), Some(3), 3, ListOrigin::Live),
            (1, None, Some(3), 3, ListOrigin::Live),
            (3, Some(2), None, 3, ListOrigin::Builtin),
            (1, Some(3), Some(2), 3, ListOrigin::Disk),
            (4, Some(2), Some(3), 4, ListOrigin::Builtin),
        ];
        for (i, &(b, disk, live, want, origin)) in cases.iter().enumerate() {
            let root = scratch(&format!("table-{i}"));
            if let Some(d) = disk {
                store_on_disk(&root, &signed(d, 0));
            }
            let source = Arc::new(FakeSource::default());
            if let Some(l) = live {
                source.publish(&digest(l as u8), Ok(signed(l, 0)));
            }
            let rt = runtime_on(parsed(&signed(b, 0)), &root, Some(source), COALESCE_WINDOW);
            rt.check(CheckBudget::BACKGROUND).await;
            let active = rt.active();
            assert_eq!(
                (active.list.sequence, active.origin),
                (want, origin),
                "case {i}: built-in {b}, stored {disk:?}, published {live:?}"
            );
        }
    }

    #[tokio::test]
    async fn lower_live_is_refused_rollback() {
        let root = scratch("rollback");
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(1), Ok(signed(1, 0)));
        let rt = runtime_on(parsed(&signed(2, 0)), &root, Some(source.clone()), Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::Refused);
        assert_eq!(status.sequence, 2, "the list in use stays");
        assert!(status.last_error.unwrap().contains("older than #2"));
        assert_eq!(ListStore::new(&root).read_list(), None, "never written to disk");
        assert!(ListStore::new(&root).read_state().is_bad(&digest(1)), "remembered");
    }

    #[tokio::test]
    async fn equal_sequence_other_bytes_is_conflict() {
        let root = scratch("conflict");
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(signed(2, 1)));
        let in_use = parsed(&signed(2, 0));
        let rt = runtime_on(in_use.clone(), &root, Some(source.clone()), Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::Refused);
        assert_eq!(rt.current().sha256, in_use.sha256);
        // The same sequence with the same bytes is simply the list in use.
        let root = scratch("same");
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(signed(2, 0)));
        let rt = runtime_on(in_use, &root, Some(source), Duration::ZERO);
        assert_eq!(rt.check(CheckBudget::BACKGROUND).await.last_check, CheckResult::Current);
        assert_eq!(ListStore::new(&root).read_state().live_digest, Some(digest(2)));
    }

    #[tokio::test]
    async fn bad_signature_not_written_to_disk() {
        let root = scratch("bad-sig");
        let mut tampered = signed(2, 0);
        let at = tampered.list.len() / 2;
        tampered.list[at] ^= 0x01;
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(tampered));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source), Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::Refused);
        assert!(status.last_error.unwrap().contains("METHOD_LIST_BAD_SIGNATURE"));
        assert_eq!(rt.current().sequence, 1);
        assert_eq!(ListStore::new(&root).read_list(), None);
        // A key the app does not trust is refused the same way.
        let root = scratch("unknown-key");
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(signed(2, 0)));
        let rt = Arc::new(ListRuntime::new(
            parsed(&signed(1, 0)),
            RuntimeSeams {
                data_root: root.clone(),
                source: Some(source),
                off_reason: None,
                keys: TrustedKeys::builtin().unwrap().clone(),
                coalesce: Duration::ZERO,
            },
        ));
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert!(status.last_error.unwrap().contains("METHOD_LIST_UNKNOWN_KEY"));
        assert_eq!(ListStore::new(&root).read_list(), None);
    }

    #[tokio::test]
    async fn tampered_disk_copy_falls_back() {
        let root = scratch("tampered-disk");
        let mut stored = signed(2, 0);
        stored.list[10] ^= 0x01;
        store_on_disk(&root, &stored);
        let store = ListStore::new(&root);
        store
            .write_state(&StoreState {
                live_digest: Some(digest(2)),
                ..Default::default()
            })
            .unwrap();
        let source = Arc::new(FakeSource::default());
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), Duration::ZERO);
        assert_eq!(rt.active().origin, ListOrigin::Builtin);
        assert_eq!(rt.current().sequence, 1);
        // The held digest is forgotten, so the next check pulls the list again.
        assert_eq!(store.read_state().live_digest, None);
        source.publish(&digest(2), Ok(signed(2, 0)));
        assert_eq!(rt.check(CheckBudget::BACKGROUND).await.last_check, CheckResult::Updated);
        assert_eq!(source.counts().1, 1, "pulled again");
    }

    #[tokio::test]
    async fn disk_write_failure_keeps_live_in_memory() {
        let root = scratch("unwritable");
        // A FILE where the store's folder should be: every write fails.
        std::fs::write(root.join("method-list"), b"not a folder").unwrap();
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(signed(2, 0)));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source), Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::Updated);
        assert_eq!((status.sequence, status.origin), (2, ListOrigin::Live));
        assert!(status.last_error.unwrap().contains("could not be saved"));
        // The next session starts on the built-in list again.
        let again = runtime_on(parsed(&signed(1, 0)), &root, Some(Arc::new(FakeSource::default())), Duration::ZERO);
        assert_eq!(again.current().sequence, 1);
    }

    #[tokio::test]
    async fn builtin_newer_than_disk_wins_after_app_update() {
        let root = scratch("app-update");
        store_on_disk(&root, &signed(2, 0));
        let rt = runtime_on(parsed(&signed(3, 0)), &root, Some(Arc::new(FakeSource::default())), Duration::ZERO);
        assert_eq!((rt.current().sequence, rt.active().origin), (3, ListOrigin::Builtin));
    }

    #[tokio::test]
    async fn bootstrap_sequence_0_loses_to_any_published() {
        let root = scratch("bootstrap");
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(1), Ok(signed(1, 0)));
        let rt = runtime_on(bootstrap(), &root, Some(source), Duration::ZERO);
        assert_eq!(rt.current().sequence, 0);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!((status.last_check, status.sequence), (CheckResult::Updated, 1));
        assert!(status.signer.is_some());
        // Written to disk: the next session starts on it.
        let again = runtime_on(bootstrap(), &root, Some(Arc::new(FakeSource::default())), Duration::ZERO);
        assert_eq!((again.current().sequence, again.active().origin), (1, ListOrigin::Disk));
    }

    #[tokio::test]
    async fn concurrent_checks_share_one_fetch() {
        let root = scratch("coalesce");
        let source = Arc::new(FakeSource {
            delay: Duration::from_millis(200),
            ..Default::default()
        });
        source.publish(&digest(2), Ok(signed(2, 0)));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), COALESCE_WINDOW);
        let (a, b) = tokio::join!(rt.check(CheckBudget::RUN_START), rt.check(CheckBudget::RUN_START));
        assert_eq!(source.counts(), (1, 1), "one resolve, one pull");
        assert_eq!((a.sequence, b.sequence), (2, 2));
        // Within the window a later check is the same answer, no registry call.
        rt.check(CheckBudget::RUN_START).await;
        assert_eq!(source.counts(), (1, 1));
    }

    #[tokio::test]
    async fn a_check_asked_for_does_not_reuse_a_finished_one() {
        let root = scratch("check-now");
        let source = Arc::new(FakeSource::default());
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), COALESCE_WINDOW);
        rt.check(CheckBudget::BACKGROUND).await;
        source.publish(&digest(2), Ok(signed(2, 0)));
        // An automatic check within the minute is the boot check's answer...
        assert_eq!(rt.check(CheckBudget::RUN_START).await.sequence, 1);
        assert_eq!(source.counts(), (1, 0));
        // ...the user's check asks the registry now.
        let status = rt.check_now().await;
        assert_eq!((status.last_check, status.sequence), (CheckResult::Updated, 2));
        assert_eq!(source.counts(), (2, 1));
    }

    #[tokio::test]
    async fn unchanged_digest_skips_pull() {
        let root = scratch("unchanged");
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(signed(2, 0)));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), Duration::ZERO);
        assert_eq!(rt.check(CheckBudget::BACKGROUND).await.last_check, CheckResult::Updated);
        assert_eq!(rt.check(CheckBudget::BACKGROUND).await.last_check, CheckResult::Current);
        assert_eq!(source.counts(), (2, 1), "resolved twice, pulled once");
        // A new session holding the stored list does not pull it again either.
        let again = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), Duration::ZERO);
        assert_eq!(again.check(CheckBudget::BACKGROUND).await.last_check, CheckResult::Current);
        assert_eq!(source.counts(), (3, 1));
    }

    #[tokio::test]
    async fn bad_digest_not_pulled_again() {
        let root = scratch("bad-digest");
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(9), Err(FetchError::TooLarge));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::Refused);
        assert!(status.last_error.unwrap().contains("METHOD_LIST_TOO_LARGE"));
        assert_eq!(rt.check(CheckBudget::BACKGROUND).await.last_check, CheckResult::Refused);
        assert_eq!(source.counts(), (2, 1), "the refused digest is not pulled again");
        // Remembered across sessions.
        let again = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), Duration::ZERO);
        again.check(CheckBudget::BACKGROUND).await;
        assert_eq!(source.counts(), (3, 1));
    }

    #[tokio::test]
    async fn a_list_that_drops_a_row_is_refused() {
        let root = scratch("row-removed");
        let dropped = signed_doc(2, 0, |d| {
            d["catalogue"]["methods"]
                .as_array_mut()
                .unwrap()
                .retain(|m| m["id"] != "fx-response-signature");
        });
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(dropped));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source), Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::Refused);
        assert!(status.last_error.unwrap().contains("METHOD_LIST_ROW_REMOVED"));
        assert_eq!(rt.current().sequence, 1);
    }

    #[tokio::test]
    async fn a_newer_format_needs_a_newer_app() {
        let root = scratch("format-2");
        let newer = signed_doc(2, 0, |d| d["format_version"] = 2.into());
        let source = Arc::new(FakeSource::default());
        source.publish(&digest(2), Ok(newer));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source), Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::NeedsNewerApp);
        assert_eq!(rt.current().sequence, 1);
    }

    #[tokio::test]
    async fn offline_or_no_tool_keeps_the_list_in_use() {
        let root = scratch("offline");
        let source = Arc::new(FakeSource::default());
        source.fail_resolve(FetchError::Unreachable {
            detail: "`/some/path/oras` failed: dial tcp: no such host".into(),
        });
        let rt = runtime_on(parsed(&signed(1, 0)), &root, Some(source.clone()), Duration::ZERO);
        let status = rt.check(CheckBudget::RUN_START).await;
        assert_eq!(status.last_check, CheckResult::Unreachable);
        let line = status.last_error.unwrap();
        assert!(!line.contains("oras") && !line.contains('/'), "a plain sentence: {line}");
        assert!(status.last_checked_at.is_some());
        source.fail_resolve(FetchError::ToolMissing);
        assert_eq!(rt.check(CheckBudget::RUN_START).await.last_check, CheckResult::Unavailable);
        assert_eq!(rt.current().sequence, 1);
        // The last check is remembered for the next session's status.
        let again = runtime_on(parsed(&signed(1, 0)), &root, Some(source), Duration::ZERO);
        assert!(again.status().last_checked_at.is_some());
    }

    #[tokio::test]
    async fn demo_mode_never_swaps() {
        // Updates off (demo mode): no registry call, and a newer stored list is not used
        // either — the demo replays the built-in list.
        let root = scratch("demo");
        store_on_disk(&root, &signed(5, 0));
        let rt = runtime_on(parsed(&signed(1, 0)), &root, None, Duration::ZERO);
        let status = rt.check(CheckBudget::BACKGROUND).await;
        assert_eq!(status.last_check, CheckResult::Off);
        assert!(!status.updates_enabled);
        assert_eq!((rt.current().sequence, rt.active().origin), (1, ListOrigin::Builtin));
    }

    #[test]
    fn choose_is_the_highest_sequence() {
        let one = parsed(&signed(1, 0));
        let two = parsed(&signed(2, 0));
        let two_b = parsed(&signed(2, 1));
        assert_eq!(choose(&one, &two), Choice::Newer);
        assert_eq!(choose(&two, &one), Choice::Older);
        assert_eq!(choose(&two, &two), Choice::Same);
        assert_eq!(choose(&two, &two_b), Choice::Conflict);
    }
}
