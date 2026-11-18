//! The last good list on disk: `<data_root>/method-list/v1/`.
//!
//! - `method-list.json` + `method-list.json.minisig`: the newest list this app verified and
//!   took. Written only after the verify (temp file + rename, each), so a list that was
//!   refused never reaches the disk. Re-verified at the next start: a copy that does not
//!   verify (a torn write, an edit) is ignored and the app runs on its built-in list.
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

    /// The stored list and signature, read capped; `None` when either is missing or
    /// unreadable (the caller verifies them before any use).
    pub fn read_list(&self) -> Option<(Vec<u8>, Vec<u8>)> {
        let read = |name: &str, cap: usize| -> Option<Vec<u8>> {
            use std::io::Read as _;
            let path = self.dir.join(name);
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
        Some((read(LIST_FILE, MAX_LIST_BYTES)?, read(SIGNATURE_FILE, MAX_SIGNATURE_BYTES)?))
    }

    /// Write a VERIFIED list and its signature: each through a temp file and a rename (a
    /// reader never sees a half-written file; a torn pair fails the next start's verify
    /// and is ignored).
    pub fn write_list(&self, list: &[u8], signature: &[u8]) -> Result<(), String> {
        self.write_file(LIST_FILE, list)?;
        self.write_file(SIGNATURE_FILE, signature)
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
        let dir = std::env::temp_dir()
            .join("txr-method-list-store-tests")
            .join(format!("{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
