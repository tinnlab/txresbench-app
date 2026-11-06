//! # The download manager (PROV-PC-6)
//!
//! One download per catalogue id, keyed state map, `MAX_CONCURRENT_DOWNLOADS`
//! in flight, staged file `<data_root>/pretrained/staging/<id>@<version>.txr.part`
//! whose growing length IS the `bytes_downloaded` poll, sha256 verification
//! against the catalogue entry (INV-2) BEFORE the verified file moves into
//! the content-addressed cache `<data_root>/pretrained/cache/<sha256>.txr`,
//! cancel + zip (prune) semantics, and the state persisted under
//! `<data_root>/txr-pretrained/<id>.json` so a restart sees the terminal
//! truth (method_env's rule: a persisted `ready` is honoured only while the
//! digest is still in the cache; a persisted `downloading` is a crash
//! leftover's honest `not_downloaded`; a persisted `failed` keeps its error).
//!
//! ## The two entry points
//!
//! - [`DownloadManager::start`] — the `POST /api/txr/pretrained/{id}/download`
//!   route's semantics: idempotent (an in-flight or ready entry returns its
//!   current status, never a second download), and a BUNDLED asset is never
//!   downloaded — the bundle is the source (INV-8); its status is the ground
//!   truth.
//! - [`DownloadManager::fetch`] — the install path's fallback (PROV-PC-7's
//!   source order): same transfer, but a bundled entry whose file is missing
//!   DOES fall through to the asset URL (TEST-PC-23 — the bundle is only the
//!   first source, not a quarantine of the URL).
//!
//! ## Network posture
//!
//! - The URL host is gated by the catalogue's shared `host_allowed` policy
//!   (INV-5) BEFORE any socket work; a refusal surfaces as `state: failed`
//!   with the free-text tag [`HOST_NOT_ALLOWED_TAG`] (defensive only — the
//!   catalogue validator refuses such entries, so no closed wire code was
//!   added for a state that cannot ship).
//! - The transfer is a plain GET of `asset.url`: no query string, no
//!   cookies, no identifiers (INV-4 — TEST-PC-04's download leg).
//!
//! ## Verification
//!
//! The sha256 is checked against the ENTRY's `asset.sha256` on the streaming
//! bytes; a mismatch is `state: failed` + the [`VERIFY_FAILED_TAG`] error
//! text and the staged file is removed — a byte that has not verified never
//! reaches the cache or the store (INV-2).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::modules::pretrained_catalogue::bundled;
use crate::modules::pretrained_catalogue::catalogue::{
    host_allowed, host_of, PretrainedCatalogueSeams,
};
use crate::modules::pretrained_catalogue::types::{
    PretrainedDownloadState, PretrainedDownloadStatus, PretrainedModel,
};

/// The download concurrency cap (PROV-PC-6; mirrors the method-environment
/// manager's cap — the same state machine shape, DEC-6).
pub const MAX_CONCURRENT_DOWNLOADS: usize = 2;

/// The free-text tag of a sha256 verification failure (the status `error`
/// field is prose; this is the machine-searched fragment).
pub const VERIFY_FAILED_TAG: &str = "PRETRAINED_VERIFY_FAILED";

/// The free-text tag of the INV-5 host refusal (defensive-only — see the
/// module docs).
pub const HOST_NOT_ALLOWED_TAG: &str = "PRETRAINED_HOST_NOT_ALLOWED";

// ─────────────────────────────────────────────────────────────────────────────
// The layout (DEC-13) — the ONE place the paths are spelled
// ─────────────────────────────────────────────────────────────────────────────

/// `<data_root>/txr-pretrained/` (the catalogue's last-good copy lives in the
/// same dir — DEC-13; the download states are sibling files).
pub fn state_dir(root: &Path) -> PathBuf {
    root.join("txr-pretrained")
}

/// `<data_root>/txr-pretrained/<id>.json` — the per-id persisted state.
pub fn state_path(root: &Path, id: &str) -> PathBuf {
    state_dir(root).join(format!("{id}.json"))
}

/// `<data_root>/pretrained/staging/` — the in-flight download area.
pub fn staging_dir(root: &Path) -> PathBuf {
    root.join("pretrained").join("staging")
}

/// `<data_root>/pretrained/staging/<id>@<version>.txr.part` — the staged
/// file whose granted length is the wire's `bytes_downloaded` (PROV-PC-6).
pub fn staged_path(root: &Path, id: &str, version: &str) -> PathBuf {
    staging_dir(root).join(format!("{id}@{version}.txr.part"))
}

/// `<data_root>/pretrained/cache/` — the verified content-addressed cache.
pub fn cache_dir(root: &Path) -> PathBuf {
    root.join("pretrained").join("cache")
}

/// `<data_root>/pretrained/cache/<sha256>.txr` — the file only gets this
/// name AFTER its bytes verified (INV-2).
pub fn cache_path(root: &Path, sha256: &str) -> PathBuf {
    cache_dir(root).join(format!("{sha256}.txr"))
}

// ─────────────────────────────────────────────────────────────────────────────
// The manager
// ─────────────────────────────────────────────────────────────────────────────

/// The per-id download slot: the cancellation flag + the live task handle
/// (the task owns its own staged path; the slot is what makes a second
/// `start`/`fetch` for the same id join the running task).
struct DownloadSlot {
    cancel: Arc<AtomicBool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl DownloadSlot {
    fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            task: Mutex::new(None),
        }
    }

    fn live(&self) -> bool {
        self.task
            .lock()
            .expect("the download slot task lock is not poisoned")
            .as_ref()
            .is_some_and(|h| !h.is_finished())
    }
}

/// The download manager (PROV-PC-6) — constructed with the SAME seams as the
/// catalogue runtime (PROV-PC-9: constructor args, never process-global
/// `set_var`), process-live (routes and the install seam share one instance;
/// the state is file-backed, so a restart sees the terminal truth).
#[derive(Clone)]
pub struct DownloadManager {
    seams: PretrainedCatalogueSeams,
    slots: Arc<Mutex<HashMap<String, Arc<DownloadSlot>>>>,
    permits: Arc<Semaphore>,
}

impl DownloadManager {
    pub fn new(seams: PretrainedCatalogueSeams) -> Self {
        Self {
            seams,
            slots: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
        }
    }

    /// The seams the manager derives its layout + HTTP client from.
    pub fn seams(&self) -> &PretrainedCatalogueSeams {
        &self.seams
    }

    fn slot_for(&self, id: &str) -> Option<Arc<DownloadSlot>> {
        self.slots
            .lock()
            .expect("the download slots lock is not poisoned")
            .get(id)
            .cloned()
    }

    /// The entry's current status — derived, never guessed: a live task wins
    /// (bytes polled from the staged file); then the content-addressed cache;
    /// then a verified bundled file; then a persisted failure; then
    /// not_downloaded. (A persisted `downloading` is a crash leftover's
    /// honest not_downloaded; a persisted `ready` whose cache file is gone
    /// is not_downloaded — method_env's rule.)
    pub fn status(&self, entry: &PretrainedModel) -> PretrainedDownloadStatus {
        let root = self.seams.data_root();
        if let Some(slot) = self.slot_for(&entry.id) {
            if slot.live() {
                let bytes = std::fs::metadata(staged_path(&root, &entry.id, &entry.version))
                    .map(|m| m.len())
                    .unwrap_or(0);
                return self.downloading_status(entry, bytes);
            }
        }
        // The cache is the ready truth (its name IS the verified digest).
        if cache_path(&root, &entry.asset.sha256).is_file() {
            return self.ready_status(entry, true);
        }
        // A bundled entry whose file verifies is ready without a cache
        // (INV-8: the bundle is the source).
        if entry.asset.bundled && bundled::verify(self.seams(), entry).is_ok() {
            return self.ready_status(entry, false);
        }
        // INV-5: refuse a non-bundled entry whose host is outside the
        // allowlist before anything else (the same gate `start`/`fetch` run;
        // a bundled entry's /download status is the bundle's ground truth
        // and only the install path ever gates it).
        if !entry.asset.bundled && !host_allowed(&entry.asset.url) {
            return self.host_refused_status(entry);
        }
        if let Some(rec) = read_state(&state_path(&root, &entry.id)) {
            if rec.version == entry.version && rec.state == PretrainedDownloadState::Failed {
                return self.failed_status(
                    entry,
                    rec.error
                        .filter(|e| !e.is_empty())
                        .unwrap_or_else(|| format!("{VERIFY_FAILED_TAG}: the download failed")),
                );
            }
        }
        self.not_downloaded_status(entry)
    }

    /// The `POST /api/txr/pretrained/{id}/download` surface (PROV-PC-6):
    /// idempotent — an in-flight or ready entry returns its current status;
    /// a bundled asset is never downloaded (the bundle is the source); a
    /// refused host fails before any I/O; otherwise the download starts (or
    /// joins the running task).
    pub fn start(&self, entry: &PretrainedModel) -> PretrainedDownloadStatus {
        if let Some(slot) = self.slot_for(&entry.id) {
            if slot.live() {
                return self.status(entry);
            }
        }
        if entry.asset.bundled {
            return self.status(entry);
        }
        if cache_path(&self.seams.data_root(), &entry.asset.sha256).is_file() {
            return self.status(entry);
        }
        if !host_allowed(&entry.asset.url) {
            return self.host_refused_status(entry);
        }
        self.begin(entry)
    }

    /// The install path's fallback (PROV-PC-7's source order): the same
    /// transfer, but the bundled rule does NOT apply — a bundled entry whose
    /// file is missing falls through to its asset URL (TEST-PC-23).
    pub fn fetch(&self, entry: &PretrainedModel) -> PretrainedDownloadStatus {
        if let Some(slot) = self.slot_for(&entry.id) {
            if slot.live() {
                return self.status(entry);
            }
        }
        if cache_path(&self.seams.data_root(), &entry.asset.sha256).is_file() {
            return self.status(entry);
        }
        if !host_allowed(&entry.asset.url) {
            return self.host_refused_status(entry);
        }
        self.begin(entry)
    }

    /// Cancel the entry's download (if any) and optionally prune the cached
    /// file for the entry's digest (PROV-PC-6's `DELETE ...?prune=true`):
    /// 204 always (the route resolves the id first); files are removed
    /// best-effort and the post-cancel truth is persisted.
    pub async fn cancel(&self, entry: &PretrainedModel, prune: bool) {
        let root = self.seams.data_root();
        if let Some(slot) = self.slot_for(&entry.id) {
            slot.cancel.store(true, Ordering::SeqCst);
            let handle = slot
                .task
                .lock()
                .expect("the download slot task lock")
                .take();
            if let Some(h) = handle {
                // The cooperative loop exits at the next chunk boundary and
                // removes its own staged file; the hard abort is the
                // fallback (a no-op when the task already finished).
                let abort = h.abort_handle();
                let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
                abort.abort();
            }
            let _ = std::fs::remove_file(staged_path(&root, &entry.id, &entry.version));
        }
        if prune {
            let _ = std::fs::remove_file(cache_path(&root, &entry.asset.sha256));
        }
        let st = self.status(entry);
        persist_state(&state_path(&root, &entry.id), &st);
    }

    fn begin(&self, entry: &PretrainedModel) -> PretrainedDownloadStatus {
        let root = self.seams.data_root();
        let staged = staged_path(&root, &entry.id, &entry.version);
        let slot = Arc::new(DownloadSlot::new());
        // Publish the slot AND its task handle under the map lock (the same
        // lock `status`'s slot lookup takes), so a concurrent poll never
        // observes a published slot without a handle — the only transient is
        // a task that already finished before the handle landed, which the
        // idempotency checks treat as not-live (correct: it is done).
        let mut slots = self.slots.lock().expect("the download slots lock");
        slots.insert(entry.id.clone(), slot.clone());
        let handle = tokio::spawn(run_download(
            self.seams.clone(),
            entry.clone(),
            staged.clone(),
            cache_path(&root, &entry.asset.sha256),
            slot.cancel.clone(),
            self.permits.clone(),
        ));
        *slot.task.lock().expect("the download slot task lock") = Some(handle);
        drop(slots);
        let st = self.downloading_status(entry, 0);
        persist_state(&state_path(&root, &entry.id), &st);
        st
    }

    // The status builders.

    fn base(&self, entry: &PretrainedModel) -> (String, String, bool, Option<u64>) {
        (
            entry.id.clone(),
            entry.version.clone(),
            entry.asset.bundled,
            Some(entry.asset.size_bytes),
        )
    }

    fn downloading_status(
        &self,
        entry: &PretrainedModel,
        bytes_downloaded: u64,
    ) -> PretrainedDownloadStatus {
        let (id, version, bundled, bytes_total) = self.base(entry);
        PretrainedDownloadStatus {
            id,
            version,
            state: PretrainedDownloadState::Downloading,
            bytes_downloaded,
            bytes_total,
            digest: None,
            cached: false,
            bundled,
            error: None,
        }
    }

    fn ready_status(&self, entry: &PretrainedModel, cached: bool) -> PretrainedDownloadStatus {
        let (id, version, bundled, bytes_total) = self.base(entry);
        PretrainedDownloadStatus {
            id,
            version,
            state: PretrainedDownloadState::Ready,
            bytes_downloaded: entry.asset.size_bytes,
            bytes_total,
            digest: Some(entry.asset.sha256.clone()),
            cached,
            bundled,
            error: None,
        }
    }

    fn failed_status(&self, entry: &PretrainedModel, error: String) -> PretrainedDownloadStatus {
        let (id, version, bundled, bytes_total) = self.base(entry);
        PretrainedDownloadStatus {
            id,
            version,
            state: PretrainedDownloadState::Failed,
            bytes_downloaded: 0,
            bytes_total,
            digest: None,
            cached: false,
            bundled,
            error: Some(error),
        }
    }

    fn not_downloaded_status(&self, entry: &PretrainedModel) -> PretrainedDownloadStatus {
        let (id, version, bundled, bytes_total) = self.base(entry);
        PretrainedDownloadStatus {
            id,
            version,
            state: PretrainedDownloadState::NotDownloaded,
            bytes_downloaded: 0,
            bytes_total,
            digest: None,
            cached: false,
            bundled,
            error: None,
        }
    }

    fn host_refused_status(&self, entry: &PretrainedModel) -> PretrainedDownloadStatus {
        let host = host_of(&entry.asset.url).unwrap_or("?");
        let (id, version, bundled, bytes_total) = self.base(entry);
        PretrainedDownloadStatus {
            id,
            version,
            state: PretrainedDownloadState::Failed,
            bytes_downloaded: 0,
            bytes_total,
            digest: None,
            cached: false,
            bundled,
            error: Some(format!(
                "{HOST_NOT_ALLOWED_TAG}: the asset host {host} is not on the network allowlist"
            )),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The transfer itself
// ─────────────────────────────────────────────────────────────────────────────

enum FetchOutcome {
    Verified,
    Cancelled,
    Failed(String),
}

enum TerminalState {
    Ready,
    NotDownloaded,
    Failed(String),
}

/// One transfer: acquire a download permit, GET the asset URL (the host gate
/// already ran in `start`/`fetch`), stream the body into the staged file
/// while hashing (the file's length is the polled progress), verify the
/// sha256, then move the verified bytes into the content-addressed cache.
/// Every terminal transition is persisted; the staged file is removed on ANY
/// non-verified outcome (INV-2).
async fn run_download(
    seams: PretrainedCatalogueSeams,
    entry: PretrainedModel,
    staged: PathBuf,
    cache_target: PathBuf,
    cancel: Arc<AtomicBool>,
    permits: Arc<Semaphore>,
) {
    let _permit = match permits.acquire_owned().await {
        Ok(p) => p,
        Err(_) => return, // the semaphore is never closed
    };
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&staged);
        return;
    }
    let terminal = match fetch_bytes(&seams, &entry, &staged, &cancel).await {
        FetchOutcome::Verified => {
            let _ = std::fs::create_dir_all(
                cache_target
                    .parent()
                    .expect("the cache path has a parent dir"),
            );
            match std::fs::rename(&staged, &cache_target) {
                Ok(()) => TerminalState::Ready,
                Err(e) => {
                    // Verified bytes that cannot be cached are a failure the
                    // caller can retry — never a "ready" lie.
                    let _ = std::fs::remove_file(&staged);
                    TerminalState::Failed(format!("move the verified bytes into the cache: {e}"))
                }
            }
        }
        FetchOutcome::Cancelled => TerminalState::NotDownloaded,
        FetchOutcome::Failed(msg) => TerminalState::Failed(msg),
    };
    // INV-2/cleanup: any non-verified terminal consumes the staged file;
    // only the cache move leaves it gone by renaming.
    if !matches!(terminal, TerminalState::Ready) {
        let _ = std::fs::remove_file(&staged);
    }
    let st = status_for(&entry, &terminal);
    persist_state(&state_path(&seams.data_root(), &entry.id), &st);
}

async fn fetch_bytes(
    seams: &PretrainedCatalogueSeams,
    entry: &PretrainedModel,
    staged: &Path,
    cancel: &AtomicBool,
) -> FetchOutcome {
    use tokio::io::AsyncWriteExt;
    let client = seams.http_client();
    let resp = match client.get(&entry.asset.url).send().await {
        Ok(r) => r,
        Err(e) => return FetchOutcome::Failed(format!("fetch {}: {e}", entry.asset.url)),
    };
    if !resp.status().is_success() {
        return FetchOutcome::Failed(format!("fetch {}: HTTP {}", entry.asset.url, resp.status()));
    }
    if let Some(parent) = staged.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return FetchOutcome::Failed(format!(
                "create the staging dir {}: {e}",
                parent.display()
            ));
        }
    }
    let mut file = match tokio::fs::File::create(staged).await {
        Ok(f) => f,
        Err(e) => {
            return FetchOutcome::Failed(format!(
                "create the staged file {}: {e}",
                staged.display()
            ))
        }
    };
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            return FetchOutcome::Cancelled;
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                return FetchOutcome::Failed(format!("read the response body: {e}"));
            }
        };
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            return FetchOutcome::Failed(format!("write the staged file: {e}"));
        }
    }
    if let Err(e) = file.flush().await {
        drop(file);
        return FetchOutcome::Failed(format!("flush the staged file: {e}"));
    }
    drop(file);
    if cancel.load(Ordering::SeqCst) {
        return FetchOutcome::Cancelled;
    }
    let actual = hex::encode(hasher.finalize());
    if actual != entry.asset.sha256 {
        return FetchOutcome::Failed(format!(
            "{VERIFY_FAILED_TAG}: sha256 mismatch (expected {}, got {actual})",
            entry.asset.sha256
        ));
    }
    FetchOutcome::Verified
}

fn status_for(entry: &PretrainedModel, terminal: &TerminalState) -> PretrainedDownloadStatus {
    let mut st = PretrainedDownloadStatus {
        id: entry.id.clone(),
        version: entry.version.clone(),
        state: PretrainedDownloadState::NotDownloaded,
        bytes_downloaded: 0,
        bytes_total: Some(entry.asset.size_bytes),
        digest: None,
        cached: false,
        bundled: entry.asset.bundled,
        error: None,
    };
    match terminal {
        TerminalState::Ready => {
            st.state = PretrainedDownloadState::Ready;
            st.bytes_downloaded = entry.asset.size_bytes;
            st.digest = Some(entry.asset.sha256.clone());
            st.cached = true;
        }
        TerminalState::NotDownloaded => {}
        TerminalState::Failed(msg) => {
            st.state = PretrainedDownloadState::Failed;
            st.error = Some(msg.clone());
        }
    }
    st
}

// ─────────────────────────────────────────────────────────────────────────────
// The persistence (atomic tmp + rename, best-effort — the download itself
// never fails because a state record could not be written; the derive side
// treats an unreadable record as absent)
// ─────────────────────────────────────────────────────────────────────────────

fn persist_state(path: &Path, st: &PretrainedDownloadStatus) {
    let Ok(bytes) = serde_json::to_vec(st) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &bytes).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, path);
}

fn read_state(path: &Path) -> Option<PretrainedDownloadStatus> {
    if !path.is_file() {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-PC-04 (download leg) / TEST-PC-05 / TEST-PC-06 — the download
// manager's state machine, verify-then-cache, cancel + prune, restart
// persistence, the concurrency cap and the INV-5/INV-4 refusals, against a
// REAL loopback server that streams 4 MiB in 64 KiB chunks and counts
// concurrent connections (no framework, no extra dependency; the fixtures
// are synthetic opaque bytes, never real model data).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pretrained_catalogue::types::{
        PretrainedAsset, PretrainedEndpoint, PretrainedEnv, PretrainedKind, PretrainedMarkerFacts,
        PretrainedModel, PretrainedNeeds,
    };
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;

    const CHUNK: usize = 64 * 1024;

    fn patterned(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn scratch_root(name: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("target")
            .join("pretrained-catalogue-item4-downloader")
            .join(name);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("scratch root");
        root
    }

    fn sample_entry(id: &str, url: &str, sha: &str, size: u64, bundled: bool) -> PretrainedModel {
        PretrainedModel {
            id: id.to_string(),
            version: "1.0.0".to_string(),
            kind: PretrainedKind::PublishedRule,
            name: "Sample rule".to_string(),
            description: "A synthetic card fact set.".to_string(),
            method_id: "landmark-cox-current".to_string(),
            method_version: "2.0.0".to_string(),
            group: "dynamic-risk".to_string(),
            group_label: "Dynamic risk".to_string(),
            paper: None,
            needs: PretrainedNeeds {
                marker_facts: PretrainedMarkerFacts {
                    kind: crate::modules::method_catalogue::types::MarkerKind::Single,
                    count: 1,
                    min_draws: 1,
                    needs_baseline: true,
                    uses_history: crate::modules::method_catalogue::types::UsesHistory::Landmark,
                    needs_detection_call: false,
                    marker_groups_required: vec![],
                },
                required_markers: None,
                covariates: crate::modules::method_catalogue::types::CovariateMode::None,
                decision_day: 56.0,
                endpoint: PretrainedEndpoint::Pfs,
                horizon: 180.0,
                task: Some(crate::modules::pretrained_catalogue::types::PretrainedTask::Survival),
            },
            env: PretrainedEnv {
                base_digest: format!("sha256:{}", "aa".repeat(32)),
                layer_digest: format!("sha256:{}", "bb".repeat(32)),
            },
            contract: "2.0".to_string(),
            embeds_training_data: false,
            transfer: None,
            assay_warnings: vec![],
            research_notice: true,
            licence: "CC0 1.0".to_string(),
            data_sources: vec![],
            asset: PretrainedAsset {
                bundled,
                file: format!("{id}@1.0.0.txr"),
                url: url.to_string(),
                size_bytes: size,
                sha256: sha.to_string(),
                signature: String::new(),
            },
        }
    }

    /// The fixture loopback server: binds 127.0.0.1:0, streams the fixed
    /// body in 64 KiB chunks (the polled staged-file growth is observable),
    /// RECORDS every request line + headers (the INV-4 assertions), and
    /// counts concurrent connections (the MAX_CONCURRENT_DOWNLOADS cap is
    /// asserted against the wire).
    struct ChunkServer {
        port: u16,
        requests: Arc<Mutex<Vec<String>>>,
        headers: Arc<Mutex<Vec<String>>>,
        max_concurrent: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl ChunkServer {
        async fn spawn(body: Vec<u8>, per_chunk_delay: Duration) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("loopback bind");
            let port = listener.local_addr().expect("addr").port();
            let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let headers: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let concurrent = Arc::new(AtomicUsize::new(0));
            let max_concurrent = Arc::new(AtomicUsize::new(0));
            let body = Arc::new(body);
            let (reqs, hdrs, conc, maxc) = (
                requests.clone(),
                headers.clone(),
                concurrent.clone(),
                max_concurrent.clone(),
            );
            let task = tokio::spawn(async move {
                loop {
                    let (stream, _) = match listener.accept().await {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let (body, reqs, hdrs, conc, maxc) = (
                        body.clone(),
                        reqs.clone(),
                        hdrs.clone(),
                        conc.clone(),
                        maxc.clone(),
                    );
                    tokio::spawn(async move {
                        let mut stream = stream;
                        conc.fetch_add(1, Ordering::SeqCst);
                        maxc.fetch_max(conc.load(Ordering::SeqCst), Ordering::SeqCst);
                        let mut buf = Vec::new();
                        let mut tmp = [0u8; 1024];
                        loop {
                            match stream.read(&mut tmp).await {
                                Ok(0) => break,
                                Ok(n) => {
                                    buf.extend_from_slice(&tmp[..n]);
                                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        let head = String::from_utf8_lossy(&buf);
                        let request_line = head.lines().next().unwrap_or("").to_string();
                        let mut header_text = String::new();
                        for line in head.lines().skip(1) {
                            if line.trim().is_empty() {
                                break;
                            }
                            header_text.push_str(line);
                            header_text.push('\n');
                        }
                        reqs.lock().expect("request log").push(request_line);
                        hdrs.lock().expect("header log").push(header_text);
                        let head = format!(
                            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: \
                             application/octet-stream\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        if stream.write_all(head.as_bytes()).await.is_err() {
                            conc.fetch_sub(1, Ordering::SeqCst);
                            return;
                        }
                        for chunk in body.chunks(CHUNK) {
                            if stream.write_all(chunk).await.is_err() {
                                break;
                            }
                            if !per_chunk_delay.is_zero() {
                                tokio::time::sleep(per_chunk_delay).await;
                            }
                        }
                        let _ = stream.shutdown().await;
                        conc.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            });
            Self {
                port,
                requests,
                headers,
                max_concurrent,
                task,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn request_lines(&self) -> Vec<String> {
            self.requests.lock().expect("request log").clone()
        }

        fn header_lines(&self) -> Vec<String> {
            self.headers.lock().expect("header log").clone()
        }

        fn max_concurrent(&self) -> usize {
            self.max_concurrent.load(Ordering::SeqCst)
        }

        async fn stop(self) {
            self.task.abort();
            let _ = self.task.await;
        }
    }

    /// The redirect fixture: `/redirect/<name>` answers 302 with a
    /// `location:` header to `/assets/<name>` (no body — the client must
    /// follow), `/assets/<name>` streams the fixed body in 64 KiB chunks like
    /// [`ChunkServer`]. Both legs RECORD their request line + headers, so the
    /// redirect test asserts the follow AND the INV-4 properties of both
    /// requests. This is the asset-host shape DEC-15 names: the release
    /// download URL redirects to the object-storage host, and
    /// `objects.githubusercontent.com` is on the allowlist precisely because
    /// the downloader follows it.
    struct RedirectServer {
        port: u16,
        requests: Arc<Mutex<Vec<String>>>,
        headers: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl RedirectServer {
        async fn spawn(body: Vec<u8>, per_chunk_delay: Duration) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("loopback bind");
            let port = listener.local_addr().expect("addr").port();
            let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let headers: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let body = Arc::new(body);
            let (reqs, hdrs, body) = (requests.clone(), headers.clone(), body.clone());
            let task = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = match listener.accept().await {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let (body, reqs, hdrs) = (body.clone(), reqs.clone(), hdrs.clone());
                    tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let mut tmp = [0u8; 1024];
                        loop {
                            match stream.read(&mut tmp).await {
                                Ok(0) => break,
                                Ok(n) => {
                                    buf.extend_from_slice(&tmp[..n]);
                                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        let head = String::from_utf8_lossy(&buf);
                        let request_line = head.lines().next().unwrap_or("").to_string();
                        let mut header_text = String::new();
                        for line in head.lines().skip(1) {
                            if line.trim().is_empty() {
                                break;
                            }
                            header_text.push_str(line);
                            header_text.push('\n');
                        }
                        reqs.lock().expect("request log").push(request_line);
                        hdrs.lock().expect("header log").push(header_text);
                        let path = head
                            .lines()
                            .next()
                            .unwrap_or("")
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("")
                            .to_string();
                        if let Some(name) = path.strip_prefix("/redirect/") {
                            let out = format!(
                                "HTTP/1.1 302 Found\r\nlocation: /assets/{name}\r\n\
                                 content-length: 0\r\nconnection: close\r\n\r\n"
                            )
                            .into_bytes();
                            let _ = stream.write_all(&out).await;
                        } else {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: \
                                 application/octet-stream\r\nconnection: close\r\n\r\n",
                                body.len()
                            );
                            if stream.write_all(head.as_bytes()).await.is_err() {
                                return;
                            }
                            for chunk in body.chunks(CHUNK) {
                                if stream.write_all(chunk).await.is_err() {
                                    break;
                                }
                                if !per_chunk_delay.is_zero() {
                                    tokio::time::sleep(per_chunk_delay).await;
                                }
                            }
                        }
                        let _ = stream.shutdown().await;
                    });
                }
            });
            Self {
                port,
                requests,
                headers,
                task,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn request_lines(&self) -> Vec<String> {
            self.requests.lock().expect("request log").clone()
        }

        fn header_lines(&self) -> Vec<String> {
            self.headers.lock().expect("header log").clone()
        }

        async fn stop(self) {
            self.task.abort();
            let _ = self.task.await;
        }
    }

    /// Poll until the state leaves `Downloading` (the terminal state is the
    /// answer); fails the test if the transfer stalls.
    async fn wait_terminal(
        manager: &DownloadManager,
        entry: &PretrainedModel,
        what: &str,
    ) -> PretrainedDownloadStatus {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let st = manager.status(entry);
            if st.state != PretrainedDownloadState::Downloading {
                return st;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{what}: the download stalls at byte {}/{:?}",
                st.bytes_downloaded,
                st.bytes_total
            );
            tokio::time::sleep(Duration::from_millis(4)).await;
        }
    }

    fn manager_at(root: &Path) -> DownloadManager {
        DownloadManager::new(PretrainedCatalogueSeams {
            data_root: Some(root.to_path_buf()),
            ..Default::default()
        })
    }

    /// TEST-PC-05 (state machine): start → downloading with monotonically
    /// growing `bytes_downloaded` polled from the staged file (4 MiB in 64
    /// KiB chunks), sha256 verification → `ready` + the verified file moved
    /// into the content-addressed cache, staged file consumed; a second
    /// start while in flight joins the SAME task (exactly one GET on the
    /// wire).
    #[tokio::test]
    async fn state_machine_ready_and_cache_move() {
        let root = scratch_root("ready");
        let body = patterned(4 * 1024 * 1024);
        let sha = sha_of(&body);
        let total = body.len() as u64;
        let server = ChunkServer::spawn(body.clone(), Duration::from_millis(6)).await;
        let manager = manager_at(&root);
        let entry = sample_entry(
            "fx-rule-001",
            &server.url("/assets/fx-rule-001@1.0.0.txr"),
            &sha,
            total,
            false,
        );

        let st = manager.start(&entry);
        assert_eq!(st.state, PretrainedDownloadState::Downloading);
        assert_eq!(st.bytes_downloaded, 0);
        assert_eq!(st.bytes_total, Some(total));
        assert!(!st.bundled && !st.cached && st.digest.is_none());

        // Idempotent: a second start while the task is in flight joins it.
        let again = manager.start(&entry);
        assert_eq!(again.state, PretrainedDownloadState::Downloading);

        // The polled bytes are monotone (read from the growing staged file).
        let mut last = 0u64;
        let mut saw_mid = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let s = manager.status(&entry);
            if s.state != PretrainedDownloadState::Downloading {
                break;
            }
            assert!(s.bytes_downloaded >= last, "bytes_downloaded is monotone");
            last = s.bytes_downloaded;
            assert!(last <= total, "never beyond the declared total");
            if last > 0 && last < total {
                saw_mid = true;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the download stalls at {last}/{total}"
            );
            tokio::time::sleep(Duration::from_millis(4)).await;
        }

        let st = manager.status(&entry);
        assert_eq!(
            st.state,
            PretrainedDownloadState::Ready,
            "the verified bytes are ready; error: {:?}",
            st.error
        );
        assert_eq!(st.digest.as_deref(), Some(sha.as_str()));
        assert!(st.cached);
        assert_eq!(st.bytes_downloaded, total);
        assert_eq!(st.bytes_total, Some(total));
        assert!(st.error.is_none());

        let cache = cache_path(&root, &sha);
        assert!(cache.is_file(), "the verified file moved into the cache");
        assert_eq!(
            std::fs::read(&cache).expect("read the cached bytes"),
            body,
            "the cache holds the exact transferred bytes"
        );
        assert!(
            !staged_path(&root, "fx-rule-001", "1.0.0").exists(),
            "the staged file was consumed by the cache move"
        );
        assert_eq!(
            server.request_lines().len(),
            1,
            "the second start joined the running task: exactly one GET"
        );
        assert!(
            saw_mid,
            "the status poll observed the staged file growing (0 < {last} < {total})"
        );
        server.stop().await;
    }

    /// TEST-PC-05 (verify): tampered bytes (same length, different content)
    /// fail with the PRETRAINED_VERIFY_FAILED tag, and BOTH the staged file
    /// and any cache entry for the digest are removed.
    #[tokio::test]
    async fn tampered_body_fails_and_removes_staged() {
        let root = scratch_root("tampered");
        let expected = patterned(1024 * 1024);
        let sha = sha_of(&expected);
        let tampered: Vec<u8> = expected.iter().rev().copied().collect();
        assert_ne!(sha_of(&tampered), sha, "the tampered body differs");
        let server = ChunkServer::spawn(tampered, Duration::from_millis(1)).await;
        let manager = manager_at(&root);
        let entry = sample_entry(
            "fx-rule-001",
            &server.url("/assets/fx-rule-001@1.0.0.txr"),
            &sha,
            expected.len() as u64,
            false,
        );

        assert_eq!(
            manager.start(&entry).state,
            PretrainedDownloadState::Downloading
        );
        let st = wait_terminal(&manager, &entry, "tampered download").await;
        assert_eq!(st.state, PretrainedDownloadState::Failed);
        assert!(
            st.error
                .as_deref()
                .is_some_and(|e| e.contains(VERIFY_FAILED_TAG)),
            "the failure names the verify tag: {:?}",
            st.error
        );
        assert!(
            !staged_path(&root, "fx-rule-001", "1.0.0").exists(),
            "the staged file is removed on failure"
        );
        assert!(
            !cache_path(&root, &sha).exists(),
            "no cache entry for unverified bytes"
        );
        server.stop().await;
    }

    /// TEST-PC-05 (idempotent start + cancel while in flight): cancelling a
    /// running download leaves the staged file removed and the state
    /// not_downloaded.
    #[tokio::test]
    async fn cancel_stops_a_running_download() {
        let root = scratch_root("cancel");
        let body = patterned(4 * 1024 * 1024);
        let sha = sha_of(&body);
        let server = ChunkServer::spawn(body, Duration::from_millis(20)).await;
        let manager = manager_at(&root);
        let entry = sample_entry(
            "fx-rule-001",
            &server.url("/assets/fx-rule-001@1.0.0.txr"),
            &sha,
            (4 * 1024 * 1024) as u64,
            false,
        );
        assert_eq!(
            manager.start(&entry).state,
            PretrainedDownloadState::Downloading
        );

        // Let some bytes land, then cancel.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while manager.status(&entry).bytes_downloaded == 0 {
            assert!(std::time::Instant::now() < deadline, "no bytes arrived");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        manager.cancel(&entry, false).await;

        let st = manager.status(&entry);
        assert_eq!(st.state, PretrainedDownloadState::NotDownloaded);
        assert!(!st.cached && st.digest.is_none());
        assert!(
            !staged_path(&root, "fx-rule-001", "1.0.0").exists(),
            "the staged file is removed on cancel"
        );
        assert!(
            !cache_path(&root, &sha).exists(),
            "cancel without prune leaves no cache"
        );
        server.stop().await;
    }

    /// TEST-PC-05 (prune): a ready entry's cached bytes are removed by
    /// `cancel(prune = true)` and the state returns to not_downloaded.
    #[tokio::test]
    async fn prune_removes_the_cached_bytes() {
        let root = scratch_root("prune");
        let body = patterned(1024 * 1024);
        let sha = sha_of(&body);
        let server = ChunkServer::spawn(body, Duration::from_millis(1)).await;
        let manager = manager_at(&root);
        let entry = sample_entry(
            "fx-rule-001",
            &server.url("/assets/fx-rule-001@1.0.0.txr"),
            &sha,
            (1024 * 1024) as u64,
            false,
        );
        manager.start(&entry);
        let st = wait_terminal(&manager, &entry, "prune setup").await;
        assert_eq!(st.state, PretrainedDownloadState::Ready);
        assert!(cache_path(&root, &sha).is_file());

        manager.cancel(&entry, true).await;
        assert!(
            !cache_path(&root, &sha).exists(),
            "prune removes the cached file for the digest"
        );
        let st = manager.status(&entry);
        assert_eq!(st.state, PretrainedDownloadState::NotDownloaded);
        assert!(
            !st.cached && st.digest.is_none(),
            "the pruned entry has no verified digest"
        );
        server.stop().await;
    }

    /// TEST-PC-05 (restart persistence): the per-id state file at
    /// `<data_root>/txr-pretrained/<id>.json` carries a terminal state
    /// across a manager recreation (ready while the cache file exists;
    /// failed with its error).
    #[tokio::test]
    async fn persisted_status_survives_a_restart() {
        let root = scratch_root("restart");
        let body = patterned(1024 * 1024);
        let sha = sha_of(&body);
        let server = ChunkServer::spawn(body.clone(), Duration::from_millis(1)).await;
        let entry = sample_entry(
            "fx-rule-001",
            &server.url("/assets/fx-rule-001@1.0.0.txr"),
            &sha,
            (1024 * 1024) as u64,
            false,
        );
        {
            let manager = manager_at(&root);
            manager.start(&entry);
            let st = wait_terminal(&manager, &entry, "restart ready").await;
            assert_eq!(st.state, PretrainedDownloadState::Ready);
        } // the manager is dropped — the state file is the only memory
        let state_file = state_path(&root, "fx-rule-001");
        assert!(state_file.is_file(), "the per-id state file exists");

        let manager = manager_at(&root);
        let st = manager.status(&entry);
        assert_eq!(st.state, PretrainedDownloadState::Ready);
        assert_eq!(st.digest.as_deref(), Some(sha.as_str()));
        assert!(st.cached);
        server.stop().await;

        // The failed terminal survives too (kept with its error). The
        // failing entry has a DIFFERENT digest, so the ready leg's cache file
        // cannot mask the failure.
        let expect = patterned(1024 * 1024 + 1);
        let expect_sha = sha_of(&expect);
        let tampered: Vec<u8> = expect.iter().rev().copied().collect();
        assert_ne!(sha_of(&tampered), expect_sha);
        let server2 = ChunkServer::spawn(tampered, Duration::from_millis(1)).await;
        let entry2 = sample_entry(
            "fx-rule-002",
            &server2.url("/assets/fx-rule-002@1.0.0.txr"),
            &expect_sha,
            expect.len() as u64,
            false,
        );
        {
            let manager = manager_at(&root);
            manager.start(&entry2);
            let st = wait_terminal(&manager, &entry2, "restart failed").await;
            assert_eq!(st.state, PretrainedDownloadState::Failed);
        }
        let manager = manager_at(&root);
        let st = manager.status(&entry2);
        assert_eq!(st.state, PretrainedDownloadState::Failed);
        assert!(
            st.error
                .as_deref()
                .is_some_and(|e| e.contains(VERIFY_FAILED_TAG)),
            "the restart keeps the failure: {:?}",
            st.error
        );
        server2.stop().await;
    }

    /// TEST-PC-06 (the concurrency cap): three simultaneous starts keep at
    /// most MAX_CONCURRENT_DOWNLOADS connections truly in flight (asserted
    /// against the server's concurrent-connection counter — the third waits
    /// for a permit), and all three still reach `ready`.
    #[tokio::test]
    async fn max_concurrent_downloads_is_two() {
        let root = scratch_root("concurrent");
        let body = patterned(4 * 1024 * 1024);
        let sha = sha_of(&body);
        let total = body.len() as u64;
        let server = ChunkServer::spawn(body, Duration::from_millis(12)).await;
        let manager = manager_at(&root);
        let entries: Vec<PretrainedModel> = ["fx-rule-001", "fx-rule-002", "fx-rule-003"]
            .iter()
            .map(|id| {
                sample_entry(
                    id,
                    &server.url(&format!("/assets/{id}@1.0.0.txr")),
                    &sha,
                    total,
                    false,
                )
            })
            .collect();

        for e in &entries {
            assert_eq!(
                manager.start(e).state,
                PretrainedDownloadState::Downloading,
                "{} starts",
                e.id
            );
        }
        for e in &entries {
            let st = wait_terminal(&manager, e, "concurrent").await;
            assert_eq!(
                st.state,
                PretrainedDownloadState::Ready,
                "{} finishes",
                e.id
            );
        }
        assert_eq!(
            server.max_concurrent(),
            MAX_CONCURRENT_DOWNLOADS,
            "at most two downloads are truly in flight (the third waits on the permit)"
        );
        assert_eq!(server.request_lines().len(), 3, "three assets, three GETs");
        server.stop().await;
    }

    /// TEST-PC-06 (the INV-5 host gate): a host outside the allowlist is
    /// refused BEFORE any I/O — the call answers `failed` synchronously, no
    /// download task exists, no staged file is ever created, and the
    /// derived status agrees.
    #[tokio::test]
    async fn host_outside_allowlist_refused_before_io() {
        let root = scratch_root("host");
        let manager = manager_at(&root);
        let sha = sha_of(&patterned(16));
        let entry = sample_entry(
            "fx-rule-001",
            "http://not-on-the-allowlist.example.invalid/assets/fx-rule-001@1.0.0.txr",
            &sha,
            16,
            false,
        );
        let st = manager.start(&entry);
        assert_eq!(st.state, PretrainedDownloadState::Failed);
        assert!(
            st.error
                .as_deref()
                .is_some_and(|e| e.contains(HOST_NOT_ALLOWED_TAG)),
            "the refusal names the host gate: {:?}",
            st.error
        );
        assert!(
            !staged_path(&root, "fx-rule-001", "1.0.0").exists(),
            "refused before any socket work: no staged file exists"
        );
        assert!(
            !manager.slot_for("fx-rule-001").is_some_and(|s| s.live()),
            "refused before any task was spawned"
        );
        let derived = manager.status(&entry);
        assert_eq!(derived.state, PretrainedDownloadState::Failed);
        assert!(derived
            .error
            .is_some_and(|e| e.contains(HOST_NOT_ALLOWED_TAG)));
    }

    /// TEST-PC-04 (download leg, INV-4): the transfer is a plain GET of the
    /// entry's `asset.url` — the request line carries the exact path with NO
    /// query string, and the headers carry no cookie or custom `x-*`
    /// identifier.
    #[tokio::test]
    async fn download_request_is_url_with_no_identifiers() {
        let root = scratch_root("inv4");
        let body = patterned(128 * 1024);
        let sha = sha_of(&body);
        let server = ChunkServer::spawn(body, Duration::from_millis(1)).await;
        let manager = manager_at(&root);
        let entry = sample_entry(
            "fx-rule-001",
            &server.url("/assets/fx-rule-001@1.0.0.txr"),
            &sha,
            (128 * 1024) as u64,
            false,
        );
        manager.start(&entry);
        let st = wait_terminal(&manager, &entry, "inv4 download").await;
        assert_eq!(st.state, PretrainedDownloadState::Ready);

        let lines = server.request_lines();
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0], "GET /assets/fx-rule-001@1.0.0.txr HTTP/1.1",
            "the request line is exactly the asset path"
        );
        assert!(!lines[0].contains('?'), "no query string: {}", lines[0]);
        for text in server.header_lines() {
            for header in text.lines() {
                let lower = header.to_ascii_lowercase();
                assert!(!lower.starts_with("cookie:"), "no cookie: {header}");
                assert!(!lower.starts_with("x-"), "no identifier header: {header}");
            }
        }
        server.stop().await;
    }

    /// ITEM-6's bread: the release-asset redirect (DEC-15's shape — the
    /// `releases/download/...` URL answers 302 to the object-storage host).
    /// The transfer follows the redirect, streams + verifies the FINAL bytes,
    /// and lands the verified file in the cache; both request legs are
    /// identifier-free (INV-4). The redirect target host is the allowlisted
    /// asset host (INV-5 — `objects.githubusercontent.com` is listed for
    /// exactly this follow); the fixture serves both legs on loopback.
    #[tokio::test]
    async fn redirect_302_is_followed_and_bytes_verify() {
        let root = scratch_root("redirect");
        let body = patterned(1024 * 1024);
        let sha = sha_of(&body);
        let server = RedirectServer::spawn(body.clone(), Duration::from_millis(2)).await;
        let manager = manager_at(&root);
        let entry = sample_entry(
            "fx-rule-001",
            &server.url("/redirect/fx-rule-001@1.0.0.txr"),
            &sha,
            body.len() as u64,
            false,
        );

        assert_eq!(
            manager.start(&entry).state,
            PretrainedDownloadState::Downloading
        );
        let st = wait_terminal(&manager, &entry, "redirected download").await;
        assert_eq!(
            st.state,
            PretrainedDownloadState::Ready,
            "the redirected transfer verifies: {:?}",
            st.error
        );
        assert_eq!(st.digest.as_deref(), Some(sha.as_str()));

        let cache = cache_path(&root, &sha);
        assert!(cache.is_file(), "the verified bytes land in the cache");
        assert_eq!(std::fs::read(&cache).expect("read cache"), body);

        let lines = server.request_lines();
        assert_eq!(lines.len(), 2, "the redirect + the followed GET");
        assert_eq!(
            lines[0], "GET /redirect/fx-rule-001@1.0.0.txr HTTP/1.1",
            "the initial URL is the entry's asset.url"
        );
        assert_eq!(
            lines[1], "GET /assets/fx-rule-001@1.0.0.txr HTTP/1.1",
            "the follow goes to the location header"
        );
        for line in &lines {
            assert!(!line.contains('?'), "no query string: {line}");
        }
        for text in server.header_lines() {
            for header in text.lines() {
                let lower = header.to_ascii_lowercase();
                assert!(!lower.starts_with("cookie:"), "no cookie: {header}");
                assert!(!lower.starts_with("x-"), "no identifier header: {header}");
            }
        }
        server.stop().await;
    }
}
