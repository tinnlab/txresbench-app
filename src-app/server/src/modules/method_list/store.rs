//! The last good list on disk: `<data_root>/method-list/v1/`.
//!
//! - `method-list.json` + `method-list.json.minisig` (+ `pair.sum`): the newest list this app
//!   verified and took. Written only after the verify, so a list that was refused never
//!   reaches the disk. The write keeps the pair it replaces in `previous/` and the checksum
//!   tells a torn pair (a crash between the two files) from a whole one, so a crash leaves
//!   the previous good pair to use. Re-verified at the next start: a copy that does not
//!   verify (an edit) is ignored and the app runs on its built-in list.
//! - `state.json`: the digest of the published list the app holds, up to 8 digests of
//!   published lists it refused (never pulled again while the same keys and the same app
//!   judge them: `judged_by`), the last check's time and error.
//!
//! The `v1` folder is the format line: a newer app reading another line keeps its own folder.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fetch::{LIST_FILE, SIGNATURE_FILE};
use super::verify::{MAX_LIST_BYTES, MAX_SIGNATURE_BYTES};

/// How many refused digests `state.json` keeps (the oldest goes first).
pub const MAX_BAD_DIGESTS: usize = 8;

/// The state file's name.
const STATE_FILE: &str = "state.json";

/// The checksum of the pair in place (it tells a whole pair from a torn one).
const SUM_FILE: &str = "pair.sum";

/// The folder holding the pair that was in place before the newest write.
const PREVIOUS_DIR: &str = "previous";

/// Staging folders of a write start with this.
const STAGE_PREFIX: &str = ".stage-";

/// A staging folder older than this belongs to a write that was cut short.
const STALE_STAGE_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// The checksum of a pair (the lengths keep the two parts apart).
fn pair_sum(list: &[u8], signature: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update((list.len() as u64).to_le_bytes());
    h.update(list);
    h.update(signature);
    hex::encode(h.finalize())
}

/// Write a pair and its checksum into `dir` (made if missing).
fn write_pair_files(dir: &Path, list: &[u8], signature: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("make {}: {e}", dir.display()))?;
    for (name, bytes) in [
        (LIST_FILE, list),
        (SIGNATURE_FILE, signature),
        (SUM_FILE, pair_sum(list, signature).as_bytes()),
    ] {
        std::fs::write(dir.join(name), bytes).map_err(|e| format!("write {name}: {e}"))?;
    }
    Ok(())
}

/// The pair in `dir`, read capped; `None` when a file is missing or not a plain file, or the
/// checksum names another pair. A folder without a checksum (written by an earlier app) is
/// taken as it is.
fn read_pair(dir: &Path) -> Option<(Vec<u8>, Vec<u8>)> {
    let read = |name: &str, cap: usize| -> Option<Vec<u8>> {
        use std::io::Read as _;
        let path = dir.join(name);
        if !std::fs::symlink_metadata(&path).ok()?.file_type().is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&path)
            .ok()?
            .take(cap as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() <= cap).then_some(bytes)
    };
    let list = read(LIST_FILE, MAX_LIST_BYTES)?;
    let signature = read(SIGNATURE_FILE, MAX_SIGNATURE_BYTES)?;
    if dir.join(SUM_FILE).exists() {
        let sum = read(SUM_FILE, 128)?;
        if sum != pair_sum(&list, &signature).as_bytes() {
            return None;
        }
    }
    Some((list, signature))
}

/// What `state.json` holds. Every field is optional on read: a missing or unreadable file
/// is a fresh state, never an error.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreState {
    /// The digest of the published list the app holds (on disk or in memory).
    #[serde(default)]
    pub live_digest: Option<String>,
    /// Digests of published lists the app refused, newest last.
    #[serde(default)]
    pub bad_digests: Vec<String>,
    /// What judged `bad_digests`: a fingerprint of the trusted keys, the built-in list and
    /// the app (`runtime::judgement`). Another one (an app update, a new key) forgets them.
    #[serde(default)]
    pub judged_by: Option<String>,
    /// The last check's time (RFC 3339).
    #[serde(default)]
    pub last_check_at: Option<String>,
    /// The last check's error, when it failed.
    #[serde(default)]
    pub last_error: Option<String>,
}

impl StoreState {
    /// Remember a refused digest (once; at most [`MAX_BAD_DIGESTS`], oldest dropped).
    pub fn remember_bad(&mut self, digest: &str) {
        if self.bad_digests.iter().any(|d| d == digest) {
            return;
        }
        self.bad_digests.push(digest.to_string());
        let over = self.bad_digests.len().saturating_sub(MAX_BAD_DIGESTS);
        self.bad_digests.drain(..over);
    }

    /// Whether `digest` was refused before.
    pub fn is_bad(&self, digest: &str) -> bool {
        self.bad_digests.iter().any(|d| d == digest)
    }
}

/// The on-disk copy of one format line.
#[derive(Debug, Clone)]
pub struct ListStore {
    dir: PathBuf,
}

impl ListStore {
    /// The store under `<data_root>/method-list/v<format_version>`.
    pub fn new(data_root: &Path) -> ListStore {
        ListStore {
            dir: data_root
                .join("method-list")
                .join(format!("v{}", super::format::FORMAT_VERSION)),
        }
    }

    /// The store's folder (pulls use fresh folders inside it).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The stored list and signature, read capped; `None` when either is missing,
    /// unreadable or torn (see [`ListStore::write_list`]). The caller verifies them before
    /// any use.
    pub fn read_list(&self) -> Option<(Vec<u8>, Vec<u8>)> {
        read_pair(&self.dir)
    }

    /// The pair kept before the newest write (the fallback of a write that was cut short).
    pub fn read_previous(&self) -> Option<(Vec<u8>, Vec<u8>)> {
        read_pair(&self.dir.join(PREVIOUS_DIR))
    }

    /// Write a VERIFIED list and its signature so that a crash at any point leaves a pair
    /// that belongs together:
    /// 1. both files are staged in a new folder;
    /// 2. the pair in place (if it is whole) is copied to `previous/` (a folder built aside
    ///    and renamed);
    /// 3. `pair.sum` is replaced with the new pair's checksum, then the two files are renamed
    ///    over the old ones. Until the second rename is done the files do not match the sum,
    ///    so [`ListStore::read_list`] says `None` and the reader uses `previous/`.
    ///
    /// A folder written before this (no `pair.sum`) reads as before.
    ///
    /// Only crash safety is promised (the process killed at any point), not durability
    /// against a power cut: the files are not synced, and a pair that did not reach the disk
    /// reads as missing or torn, so the app runs on the previous pair or the built-in list.
    /// Two app processes on one data root are not excluded either; interleaved writes end in
    /// a torn pair, which reads as `None` and heals at the next fetch.
    pub fn write_list(&self, list: &[u8], signature: &[u8]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("make {}: {e}", self.dir.display()))?;
        self.remove_stale_stages();
        let stage = self.stage_dir("new");
        let result = self.write_pair_through(&stage, list, signature);
        let _ = std::fs::remove_dir_all(&stage);
        result
    }

    fn write_pair_through(&self, stage: &Path, list: &[u8], signature: &[u8]) -> Result<(), String> {
        write_pair_files(stage, list, signature)?;
        // Keep the pair in place as the fallback (best effort: a failure here only costs the
        // fallback).
        if let Some((old_list, old_sig)) = self.read_list() {
            let aside = self.stage_dir("previous");
            if write_pair_files(&aside, &old_list, &old_sig).is_ok() {
                let previous = self.dir.join(PREVIOUS_DIR);
                let _ = std::fs::remove_dir_all(&previous);
                if std::fs::rename(&aside, &previous).is_err() {
                    let _ = std::fs::remove_dir_all(&aside);
                }
            } else {
                let _ = std::fs::remove_dir_all(&aside);
            }
        }
        let rename_in = |name: &str| {
            std::fs::rename(stage.join(name), self.dir.join(name)).map_err(|e| format!("save {name}: {e}"))
        };
        // The sum first: from here the files in place are a torn pair until both are replaced.
        rename_in(SUM_FILE)?;
        rename_in(LIST_FILE)?;
        rename_in(SIGNATURE_FILE)
    }

    fn stage_dir(&self, what: &str) -> PathBuf {
        self.dir.join(format!("{STAGE_PREFIX}{what}-{}", uuid::Uuid::new_v4().simple()))
    }

    /// Staging folders of a write that was cut short (older than an hour; a write in
    /// progress is younger).
    fn remove_stale_stages(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with(STAGE_PREFIX) {
                continue;
            }
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_STAGE_AGE);
            if old {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    /// The saved state (a fresh one when missing or unreadable).
    pub fn read_state(&self) -> StoreState {
        std::fs::read(self.dir.join(STATE_FILE))
            .ok()
            .filter(|b| b.len() <= 64 * 1024)
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Save the state.
    pub fn write_state(&self, state: &StoreState) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
        self.write_file(STATE_FILE, &bytes)
    }

    fn write_file(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("make {}: {e}", self.dir.display()))?;
        let tmp = self
            .dir
            .join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
        std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, self.dir.join(name)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("save {name}: {e}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        crate::modules::method_list::test_scratch::dir("method-list-store", tag)
    }

    #[test]
    fn list_and_state_round_trip() {
        let root = scratch("round-trip");
        let store = ListStore::new(&root);
        assert_eq!(store.read_list(), None, "nothing stored yet");
        assert_eq!(store.read_state(), StoreState::default());
        store.write_list(b"list bytes", b"sig bytes").expect("written");
        assert_eq!(store.read_list(), Some((b"list bytes".to_vec(), b"sig bytes".to_vec())));
        assert!(root.join("method-list/v1/method-list.json").is_file());
        let mut state = StoreState {
            live_digest: Some("sha256:aa".into()),
            ..Default::default()
        };
        state.remember_bad("sha256:bb");
        store.write_state(&state).expect("state written");
        assert_eq!(store.read_state(), state);
        // No temp file is left behind.
        let names: Vec<String> = std::fs::read_dir(store.dir())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
    }

    #[test]
    fn a_corrupt_state_is_a_fresh_one() {
        let root = scratch("corrupt-state");
        let store = ListStore::new(&root);
        std::fs::create_dir_all(store.dir()).unwrap();
        std::fs::write(store.dir().join("state.json"), b"{ not json").unwrap();
        assert_eq!(store.read_state(), StoreState::default());
    }

    #[test]
    fn bad_digests_keep_the_newest_eight() {
        let mut s = StoreState::default();
        for i in 0..12 {
            s.remember_bad(&format!("d{i}"));
        }
        s.remember_bad("d11");
        assert_eq!(s.bad_digests.len(), MAX_BAD_DIGESTS);
        assert_eq!(s.bad_digests.first().map(String::as_str), Some("d4"));
        assert!(s.is_bad("d11") && !s.is_bad("d0"));
    }

    fn names(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_second_write_keeps_the_first_pair_as_previous() {
        let root = scratch("previous");
        let store = ListStore::new(&root);
        store.write_list(b"list 1", b"sig 1").unwrap();
        assert_eq!(store.read_previous(), None, "nothing before the first");
        store.write_list(b"list 2", b"sig 2").unwrap();
        assert_eq!(store.read_list(), Some((b"list 2".to_vec(), b"sig 2".to_vec())));
        assert_eq!(store.read_previous(), Some((b"list 1".to_vec(), b"sig 1".to_vec())));
        store.write_list(b"list 3", b"sig 3").unwrap();
        assert_eq!(store.read_previous(), Some((b"list 2".to_vec(), b"sig 2".to_vec())));
        assert!(names(store.dir()).iter().all(|n| !n.starts_with(".stage-")), "{:?}", names(store.dir()));
    }

    /// A crash after the list was replaced and before the signature was: the pair in place
    /// is torn (the checksum names the new pair) and is not read; the previous pair is.
    #[test]
    fn a_write_cut_between_the_two_files_leaves_the_previous_pair() {
        let root = scratch("torn");
        let store = ListStore::new(&root);
        store.write_list(b"list 1", b"sig 1").unwrap();
        store.write_list(b"list 2", b"sig 2").unwrap();
        // Replay the third write up to the crash: the sum and the list are in place.
        std::fs::write(store.dir().join(SUM_FILE), pair_sum(b"list 3", b"sig 3")).unwrap();
        std::fs::write(store.dir().join(LIST_FILE), b"list 3").unwrap();
        assert_eq!(store.read_list(), None, "list 3 with sig 2 is no pair");
        assert_eq!(store.read_previous(), Some((b"list 1".to_vec(), b"sig 1".to_vec())));
        // The next write does not copy the torn pair over the good fallback.
        store.write_list(b"list 4", b"sig 4").unwrap();
        assert_eq!(store.read_list(), Some((b"list 4".to_vec(), b"sig 4".to_vec())));
        assert_eq!(store.read_previous(), Some((b"list 1".to_vec(), b"sig 1".to_vec())));
    }

    /// A write that fails at the signature (a folder where the file belongs) leaves the
    /// previous pair readable and no staging folder behind.
    #[test]
    fn a_failed_write_leaves_the_previous_pair_and_no_stage() {
        let root = scratch("failed");
        let store = ListStore::new(&root);
        store.write_list(b"list 1", b"sig 1").unwrap();
        store.write_list(b"list 2", b"sig 2").unwrap();
        let sig = store.dir().join(SIGNATURE_FILE);
        std::fs::remove_file(&sig).unwrap();
        std::fs::create_dir(&sig).unwrap();
        assert!(store.write_list(b"list 3", b"sig 3").is_err());
        assert_eq!(store.read_list(), None);
        assert_eq!(store.read_previous(), Some((b"list 1".to_vec(), b"sig 1".to_vec())));
        assert!(names(store.dir()).iter().all(|n| !n.starts_with(".stage-")), "{:?}", names(store.dir()));
    }

    /// A folder an earlier app wrote (two files, no checksum) still reads, and the next write
    /// keeps it as the previous pair.
    #[test]
    fn the_old_layout_still_reads() {
        let root = scratch("old-layout");
        let store = ListStore::new(&root);
        std::fs::create_dir_all(store.dir()).unwrap();
        std::fs::write(store.dir().join(LIST_FILE), b"old list").unwrap();
        std::fs::write(store.dir().join(SIGNATURE_FILE), b"old sig").unwrap();
        assert_eq!(store.read_list(), Some((b"old list".to_vec(), b"old sig".to_vec())));
        store.write_list(b"new list", b"new sig").unwrap();
        assert_eq!(store.read_list(), Some((b"new list".to_vec(), b"new sig".to_vec())));
        assert_eq!(store.read_previous(), Some((b"old list".to_vec(), b"old sig".to_vec())));
    }

    #[test]
    fn a_tampered_pair_with_a_checksum_is_not_read() {
        let root = scratch("tampered");
        let store = ListStore::new(&root);
        store.write_list(b"list", b"sig").unwrap();
        std::fs::write(store.dir().join(LIST_FILE), b"other").unwrap();
        assert_eq!(store.read_list(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_list_is_not_read() {
        let root = scratch("symlink");
        let store = ListStore::new(&root);
        store.write_list(b"list", b"sig").unwrap();
        let list = store.dir().join(LIST_FILE);
        std::fs::remove_file(&list).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", &list).unwrap();
        assert_eq!(store.read_list(), None);
    }
}
