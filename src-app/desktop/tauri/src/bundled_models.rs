//! `bundled_models` — the bundled pretrained-model provision (PROV-IR-5).
//!
//! The installer carries a read-only copy of the bundled-model manifest +
//! `.txr` files inside the bundle (`bundle.resources:
//! ["resources/pretrained-bundled"]`, staged at build time by
//! `scripts/installer/bundle-pretrained-models.mjs` — PROV-IR-4). Package
//! layouts can be read-only mounts (AppImage, signed macOS `.app`), so the
//! app never serves from inside the bundle: this module VERIFIES the shipped
//! set against the shipped `bundled-models.json` (sha256 + size_bytes — the
//! bytes stay opaque, INV-7) and copies the verified set to
//! `<app-data-dir>/pretrained-bundled/` — the host-side layout PROV-PC-12
//! binds — then points `TXR_BUNDLED_MODELS_DIR` at it BEFORE the
//! embedded server boots (the `pretrained_catalogue` module resolves its
//! bundled dir from that env var).
//!
//! Contract details (PROV-IR-5 / CONS-IR-5):
//! - the manifest is the one source of truth: the same fields the build-time
//!   staging script binds (`id`, `version`, `file` == `<id>@<version>.txr`,
//!   `url`, `sha256`, `size_bytes`); the `url` host policy is the staging
//!   script's concern (a provision never fetches), so this module only
//!   requires the field to be present;
//! - provision is IDEMPOTENT: a destination file that already verifies is not
//!   re-copied; a byte-mismatched destination file is re-copied from the
//!   verified resource (added files only — nothing is ever deleted,
//!   DEC-20); every write goes through `<file>.part` + rename, so a crash or
//!   a failed copy never leaves a partial file at the final name;
//! - a missing manifest (`--skip-models` build, fresh-checkout marker) is
//!   `Ok(BundledProvision::None)` — no models bundled is a valid state and
//!   the env var is left untouched;
//! - a verify failure is `Err` naming the file and NOTHING is written: the
//!   previous verified copy at the destination survives, boot continues, and
//!   the catalogue module's install path re-verifies per file at use time
//!   (`PRETRAINED_VERIFY_FAILED` — the consumer's belt over this strap).

use std::fmt;
use std::path::{Path, PathBuf};

use txresbench::modules::pretrained_catalogue::bundled::sha256_file;
use serde::Deserialize;
use tauri::Manager;

/// The resource-dir subdirectory the bundler embeds
/// (`$RESOURCE/pretrained-bundled/` — PROV-IR-7) and the destination
/// subdirectory under the app-data dir.
pub const BUNDLED_RESOURCE_SUBDIR: &str = "pretrained-bundled";

/// The staged manifest file name next to the `.txr` files (PROV-PC-12; the
/// build-time staging script copies it byte-identical).
pub const BUNDLED_MANIFEST_FILE: &str = "bundled-models.json";

/// The env var this module sets before the server boots — the
/// `pretrained_catalogue` module's bundled-dir resolution reads it
/// (PROV-PC-12 / CONS-IR-5).
pub const BUNDLED_MODELS_DIR_ENV: &str = "TXR_BUNDLED_MODELS_DIR";

/// The isolation env var the integration harness uses; resolved FIRST so a
/// test never touches the real app-data dir (the server's `rootfs::data_root`
/// uses the same order).
const DATA_DIR_ENV: &str = "TXR_APP_DATA_DIR";

/// The manifest `schema_version` accepted (PROV-PC-1).
const SCHEMA_VERSION: u64 = 1;

/// The app-data root: `TXR_APP_DATA_DIR` (test isolation / harness), else
/// the SDK's app-data getter (CONS-IR-7 — the single data root the whole
/// app binds; the desktop boot sets the app name in `config::init_app_name`).
pub fn bundled_data_dir() -> PathBuf {
    std::env::var_os(DATA_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(txresbench_core::app_state::get_app_data_dir)
}

/// Resolve the embedded resource dir and run the provision (PROV-IR-5).
///
/// The resource-dir resolution is the only `AppHandle`-dependent step (the
/// Tauri path resolver derives it from the running bundle/executable); the
/// provision itself is the path-argumented [`provision_from`] so the whole
/// copy/verify behavior is unit-testable without an event loop.
pub fn provision_bundled_models(app: &tauri::AppHandle) -> Result<BundledProvision, BundledError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| BundledError::ResourceDir(e.to_string()))?
        .join(BUNDLED_RESOURCE_SUBDIR);
    provision_from(&resource_dir, &bundled_data_dir())
}

/// The provision result (PROV-IR-5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundledProvision {
    /// The bundle carries no `bundled-models.json`; nothing provisioned and
    /// the env var left untouched (no bundled models yet — a valid state).
    None,
    /// The shipped set verified + provisioned; `models_dir` is
    /// `<app-data-dir>/pretrained-bundled/` and `BUNDLED_MODELS_DIR_ENV`
    /// points at it.
    Bundled {
        /// The verified copy location the env var names.
        models_dir: PathBuf,
        /// Manifest rows (the bundled set size).
        entries: usize,
        /// Files written this run (0 = the set was already verified).
        copied: usize,
    },
}

/// The provision failure vocabulary. Every variant NAMES the file or entry
/// so a boot log is actionable; boot itself continues (the catalogue
/// module's install path re-verifies and answers
/// `PRETRAINED_VERIFY_FAILED` per file).
#[derive(Debug)]
pub enum BundledError {
    /// `app.path().resource_dir()` failed.
    ResourceDir(String),
    /// The embedded manifest could not be read.
    ManifestRead(String),
    /// The embedded manifest did not parse (JSON / shape / entry fields).
    ManifestParse(String),
    /// An entry is missing a required field.
    EntryMissing { entry: String, field: &'static str },
    /// An entry's sha256 is not 64 lowercase hex (INV-2's format rule).
    EntrySha256Format { entry: String, value: String },
    /// An entry's file is not the PROV-PC-12 `<id>@<version>.txr` name.
    EntryFileName {
        entry: String,
        file: String,
        expected: String,
    },
    /// An entry's size_bytes is not a positive integer.
    EntrySize { entry: String, size: u64 },
    /// Two entries stage the same file.
    DuplicateFile { file: String },
    /// A shipped file named by the manifest is absent or unreadable.
    ResourceFile { file: String, detail: String },
    /// A shipped file failed verification (the destination is untouched).
    VerifyFailed { file: String, detail: String },
    /// The destination copy failed (the `.part` is removed; the previous
    /// verified file or no file stays at the target).
    ProvisionIo { file: String, detail: String },
}

impl fmt::Display for BundledError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BundledError::ResourceDir(d) => write!(f, "resource dir unavailable: {d}"),
            BundledError::ManifestRead(d) => write!(f, "bundled manifest unreadable: {d}"),
            BundledError::ManifestParse(d) => write!(f, "bundled manifest invalid: {d}"),
            BundledError::EntryMissing { entry, field } => {
                write!(f, "bundled manifest entry {entry} is missing {field}")
            }
            BundledError::EntrySha256Format { entry, value } => write!(
                f,
                "bundled manifest entry {entry} sha256 {value} is not 64 lowercase hex"
            ),
            BundledError::EntryFileName {
                entry,
                file,
                expected,
            } => write!(
                f,
                "bundled manifest entry {entry} file {file} is not the expected {expected}"
            ),
            BundledError::EntrySize { entry, size } => write!(
                f,
                "bundled manifest entry {entry} size_bytes {size} is not a positive integer"
            ),
            BundledError::DuplicateFile { file } => {
                write!(f, "bundled manifest stages {file} more than once")
            }
            BundledError::ResourceFile { file, detail } => {
                write!(f, "bundled model file {file} unavailable: {detail}")
            }
            BundledError::VerifyFailed { file, detail } => {
                write!(f, "bundled model file {file} failed verification: {detail}")
            }
            BundledError::ProvisionIo { file, detail } => {
                write!(
                    f,
                    "bundled model file {file} could not be provisioned: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for BundledError {}

/// A validated manifest row (the fields the provision binds; `url` is
/// validated as present-only — the host policy is the build script's).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestEntry {
    id: String,
    version: String,
    file: String,
    sha256: String,
    size_bytes: u64,
}

/// The validated bundled manifest (PROV-PC-1's `{schema_version: 1,
/// models: [...]}` shape; an empty `models[]` is valid).
#[derive(Debug, Clone, PartialEq, Eq)]
struct BundledManifest {
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    schema_version: u64,
    models: Vec<RawEntry>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    id: Option<String>,
    version: Option<String>,
    file: Option<String>,
    url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
}

/// Parse + validate the shipped manifest (TEST-IR-1). The frozen grammar is
/// the staging script's (PROV-IR-4), mirrored here so the two sides of
/// PROV-PC-12 never disagree.
fn parse_manifest(bytes: &[u8]) -> Result<BundledManifest, BundledError> {
    let raw: RawManifest = serde_json::from_slice(bytes)
        .map_err(|e| BundledError::ManifestParse(format!("{BUNDLED_MANIFEST_FILE}: {e}")))?;
    if raw.schema_version != SCHEMA_VERSION {
        return Err(BundledError::ManifestParse(format!(
            "unsupported schema_version {} (expected {SCHEMA_VERSION})",
            raw.schema_version
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::with_capacity(raw.models.len());
    for (i, entry) in raw.models.into_iter().enumerate() {
        let required = |name: &'static str,
                        value: Option<String>,
                        entry: &str|
         -> Result<String, BundledError> {
            match value {
                Some(v) if !v.is_empty() => Ok(v),
                _ => Err(BundledError::EntryMissing {
                    entry: entry.to_string(),
                    field: name,
                }),
            }
        };
        let id = required("id", entry.id, &format!("models[{i}]"))?;
        let version = required("version", entry.version, &format!("{id}@?"))?;
        let entry_name = format!("{id}@{version}");
        let file = required("file", entry.file, &entry_name)?;
        // `url` is a required field of the frozen shape (the staging script
        // binds it); a provision never uses it — present-only validation.
        let _url = required("url", entry.url, &entry_name)?;
        let sha256 = required("sha256", entry.sha256, &entry_name)?;
        let size_bytes = match entry.size_bytes {
            Some(v) if v > 0 => v,
            Some(v) => {
                return Err(BundledError::EntrySize {
                    entry: entry_name,
                    size: v,
                })
            }
            None => {
                return Err(BundledError::EntryMissing {
                    entry: entry_name,
                    field: "size_bytes",
                })
            }
        };
        if !is_64_lower_hex(&sha256) {
            return Err(BundledError::EntrySha256Format {
                entry: entry_name,
                value: sha256,
            });
        }
        let expected = format!("{id}@{version}.txr");
        if file != expected {
            return Err(BundledError::EntryFileName {
                entry: entry_name,
                file,
                expected: format!("{expected} (PROV-PC-12 naming)"),
            });
        }
        if !seen.insert(expected.clone()) {
            return Err(BundledError::DuplicateFile { file: expected });
        }
        entries.push(ManifestEntry {
            id,
            version,
            file: expected,
            sha256,
            size_bytes,
        });
    }
    Ok(BundledManifest { entries })
}

/// The sha256 format rule (mirrors the staging script's `[0-9a-f]{64}`).
fn is_64_lower_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

/// The provision core: verify the shipped set, copy it to the data root,
/// point the env var at the copy. Path-argumented so the behavior is
/// unit-testable (the `AppHandle` wrapper only resolves the resource dir).
fn provision_from(resource_dir: &Path, data_root: &Path) -> Result<BundledProvision, BundledError> {
    let manifest_path = resource_dir.join(BUNDLED_MANIFEST_FILE);
    let manifest_bytes = match std::fs::read(&manifest_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BundledProvision::None),
        Err(e) => {
            return Err(BundledError::ManifestRead(format!(
                "{}: {e}",
                manifest_path.display()
            )))
        }
    };
    let manifest = parse_manifest(&manifest_bytes)?;

    // Phase 1 — verify every shipped file BEFORE any write: a corrupt bundle
    // never half-replaces a previously verified set (TEST-IR-3 keeps the
    // previous verified copy). The bytes are read only for hashing (INV-7:
    // a `.txr` is an opaque byte container here).
    for entry in &manifest.entries {
        let path = resource_dir.join(&entry.file);
        let meta = match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => m,
            Ok(_) => {
                return Err(BundledError::ResourceFile {
                    file: entry.file.clone(),
                    detail: "not a file".to_string(),
                })
            }
            Err(e) => {
                return Err(BundledError::ResourceFile {
                    file: entry.file.clone(),
                    detail: e.to_string(),
                })
            }
        };
        if meta.len() != entry.size_bytes {
            return Err(BundledError::VerifyFailed {
                file: entry.file.clone(),
                detail: format!(
                    "size mismatch (expected {} bytes, found {})",
                    entry.size_bytes,
                    meta.len()
                ),
            });
        }
        let digest = sha256_file(&path).map_err(|e| BundledError::VerifyFailed {
            file: entry.file.clone(),
            detail: e.to_string(),
        })?;
        if digest != entry.sha256 {
            return Err(BundledError::VerifyFailed {
                file: entry.file.clone(),
                detail: format!(
                    "sha256 mismatch (expected {}, found {digest})",
                    entry.sha256
                ),
            });
        }
    }

    // Phase 2 — copy the verified set; the manifest goes first, byte
    // identical, so the data-root layout mirrors the bundle layout
    // (PROV-PC-12's one source of truth stays next to the bytes).
    let models_dir = data_root.join(BUNDLED_RESOURCE_SUBDIR);
    std::fs::create_dir_all(&models_dir).map_err(|e| BundledError::ProvisionIo {
        file: models_dir.display().to_string(),
        detail: e.to_string(),
    })?;
    write_atomic(&models_dir.join(BUNDLED_MANIFEST_FILE), &manifest_bytes).map_err(|e| {
        BundledError::ProvisionIo {
            file: BUNDLED_MANIFEST_FILE.to_string(),
            detail: e.to_string(),
        }
    })?;
    let mut copied = 0usize;
    for entry in &manifest.entries {
        let target = models_dir.join(&entry.file);
        if verified(&target, entry) {
            continue;
        }
        let source = resource_dir.join(&entry.file);
        let bytes = std::fs::read(&source).map_err(|e| BundledError::ProvisionIo {
            file: entry.file.clone(),
            detail: e.to_string(),
        })?;
        write_atomic(&target, &bytes).map_err(|e| BundledError::ProvisionIo {
            file: entry.file.clone(),
            detail: e.to_string(),
        })?;
        copied += 1;
    }

    std::env::set_var(BUNDLED_MODELS_DIR_ENV, &models_dir);
    Ok(BundledProvision::Bundled {
        models_dir,
        entries: manifest.entries.len(),
        copied,
    })
}

/// True when the destination file matches the entry's size + sha256 (the
/// idempotency + heal test: a mismatch is re-copied, never trusted).
fn verified(target: &Path, entry: &ManifestEntry) -> bool {
    let Ok(meta) = std::fs::metadata(target) else {
        return false;
    };
    if !meta.is_file() || meta.len() != entry.size_bytes {
        return false;
    }
    sha256_file(target)
        .map(|d| d == entry.sha256)
        .unwrap_or(false)
}

/// Atomic write: `<file>.part` then rename. A failure removes the `.part`
/// (the final name is only ever a complete file; a partial write stays a
/// temporary, never an orphan).
fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut part_name = target.as_os_str().to_os_string();
    part_name.push(".part");
    let part = PathBuf::from(part_name);
    if let Err(e) = std::fs::write(&part, bytes) {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&part, target) {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Item-3 tests — TEST-IR-1 (manifest parse + opaque bytes), TEST-IR-2
// (copy + env var + idempotency), TEST-IR-3 (corrupt/missing shipped file
// names it and keeps the previous verified copy; no orphaned `.part`).
// Every test that mutates a process env takes ENV_MUTEX: the env vars are
// process-global, and no other test in this binary reads them.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    static SEQ: AtomicU64 = AtomicU64::new(0);
    /// Serializes the env-mutating tests (set_var is process-wide; the vars
    /// are only read by this module, so the mutex is an exclusive-writer
    /// lock, not a global slowdown).
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// A unique scratch root under TMPDIR (owner rule: never `/tmp` directly
    /// — the harness exports TMPDIR under /data/pbya).
    fn scratch(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("txr-bundled-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    /// Saves + restores a process env var around the test (a panic still
    /// restores, so a failing test never leaks state into its siblings).
    struct EnvVar {
        var: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVar {
        fn set(var: &'static str, value: &Path) -> Self {
            let previous = std::env::var_os(var);
            std::env::set_var(var, value);
            Self { var, previous }
        }

        fn unset(var: &'static str) -> Self {
            let previous = std::env::var_os(var);
            std::env::remove_var(var);
            Self { var, previous }
        }
    }

    impl Drop for EnvVar {
        fn drop(&mut self) {
            match &self.previous {
                Some(v) => std::env::set_var(self.var, v),
                None => std::env::remove_var(self.var),
            }
        }
    }

    /// A manifest entry value (fake but format-valid sha256; the
    /// digest-accurate entries are built by [`fixture_resource_dir`]).
    fn manifest_entry(id: &str, version: &str) -> serde_json::Value {
        let file = format!("{id}@{version}.txr");
        serde_json::json!({
            "id": id,
            "version": version,
            "file": file,
            "url": format!(
                "https://github.com/tinnlab/txresbench-models/releases/download/models-v{version}/{file}"
            ),
            "sha256": "ab".repeat(32),
            "size_bytes": 64,
        })
    }

    fn manifest_bytes(entries: &[serde_json::Value]) -> Vec<u8> {
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "models": entries,
        }))
        .expect("manifest serializes")
    }

    /// Write a fixture resource dir: the `.txr` bytes + a manifest whose
    /// sha256/size_bytes are digest-accurate for those bytes.
    fn fixture_resource_dir(tag: &str, bodies: &[(&str, &str, &[u8])]) -> PathBuf {
        let dir = scratch(tag);
        let entries: Vec<serde_json::Value> = bodies
            .iter()
            .map(|(id, version, body)| {
                let file = format!("{id}@{version}.txr");
                let path = dir.join(&file);
                std::fs::write(&path, body).expect("write fixture body");
                let sha = sha256_file(&path).expect("fixture digest");
                serde_json::json!({
                    "id": id,
                    "version": version,
                    "file": file,
                    "url": format!(
                        "https://github.com/tinnlab/txresbench-models/releases/download/models-v{version}/{file}"
                    ),
                    "sha256": sha,
                    "size_bytes": body.len(),
                })
            })
            .collect();
        let bytes = manifest_bytes(&entries);
        write_atomic(&dir.join(BUNDLED_MANIFEST_FILE), &bytes).expect("write fixture manifest");
        dir
    }

    // ── TEST-IR-1 ──────────────────────────────────────────────────────────

    #[test]
    fn parse_manifest_accepts_the_frozen_shape() {
        let parsed = parse_manifest(&manifest_bytes(&[manifest_entry(
            "relchange-threshold",
            "0.4.0",
        )]))
        .expect("the frozen shape parses");
        assert_eq!(parsed.entries.len(), 1);
        let e = &parsed.entries[0];
        assert_eq!(e.id, "relchange-threshold");
        assert_eq!(e.version, "0.4.0");
        assert_eq!(e.file, "relchange-threshold@0.4.0.txr");
        assert_eq!(e.size_bytes, 64);
        assert_eq!(e.sha256.len(), 64);
    }

    #[test]
    fn parse_manifest_accepts_an_empty_models_set() {
        let parsed = parse_manifest(&manifest_bytes(&[])).expect("empty models[] is valid");
        assert!(parsed.entries.is_empty());
    }

    #[test]
    fn parse_manifest_rejects_a_non_64_hex_sha256() {
        let mut entry = manifest_entry("relchange-threshold", "0.4.0");
        entry["sha256"] = serde_json::json!("zz".repeat(32));
        let err = parse_manifest(&manifest_bytes(&[entry])).expect_err("bad sha256 refused");
        assert!(
            matches!(err, BundledError::EntrySha256Format { .. }),
            "naming the format rule: {err}"
        );
        assert!(
            err.to_string().contains("relchange-threshold@0.4.0"),
            "{err}"
        );
    }

    #[test]
    fn parse_manifest_rejects_an_entry_missing_its_file() {
        let mut entry = manifest_entry("relchange-threshold", "0.4.0");
        entry.as_object_mut().expect("entry object").remove("file");
        let err = parse_manifest(&manifest_bytes(&[entry])).expect_err("missing file refused");
        assert!(
            matches!(err, BundledError::EntryMissing { field: "file", .. }),
            "{err}"
        );
    }

    #[test]
    fn parse_manifest_rejects_a_file_that_is_not_id_at_version_txr() {
        let mut entry = manifest_entry("relchange-threshold", "0.4.0");
        entry["file"] = serde_json::json!("other@0.4.0.txr");
        let err = parse_manifest(&manifest_bytes(&[entry])).expect_err("the wrong name is refused");
        assert!(matches!(err, BundledError::EntryFileName { .. }), "{err}");
    }

    #[test]
    fn parse_manifest_rejects_non_positive_size_and_an_unknown_schema() {
        let mut entry = manifest_entry("relchange-threshold", "0.4.0");
        entry["size_bytes"] = serde_json::json!(0);
        let err = parse_manifest(&manifest_bytes(&[entry])).expect_err("zero size refused");
        assert!(matches!(err, BundledError::EntrySize { .. }), "{err}");

        let doc = serde_json::json!({"schema_version": 2, "models": []});
        let err = parse_manifest(&serde_json::to_vec(&doc).expect("serialize"))
            .expect_err("schema 2 refused");
        assert!(matches!(err, BundledError::ManifestParse(_)), "{err}");
    }

    #[test]
    fn parse_manifest_rejects_duplicate_staged_files() {
        let entry = manifest_entry("relchange-threshold", "0.4.0");
        let err = parse_manifest(&manifest_bytes(&[entry.clone(), entry]))
            .expect_err("a duplicate staged file is refused");
        assert!(matches!(err, BundledError::DuplicateFile { .. }), "{err}");
    }

    // ── TEST-IR-2 ──────────────────────────────────────────────────────────

    #[test]
    fn provision_copies_verified_files_and_points_the_env_var_at_them() {
        let _env = ENV_MUTEX.lock().unwrap();
        let data_root = scratch("provision");
        let _data_var = EnvVar::set(DATA_DIR_ENV, &data_root);
        let _models_var = EnvVar::unset(BUNDLED_MODELS_DIR_ENV);
        let resource = fixture_resource_dir(
            "provision",
            &[
                ("relchange-threshold", "0.4.0", b"first synthetic model"),
                ("squeeze-fit", "1.2.0", b"second synthetic model"),
            ],
        );

        let provision = provision_from(&resource, &bundled_data_dir()).expect("provision succeeds");
        let (models_dir, entries, copied) = match provision {
            BundledProvision::Bundled {
                models_dir,
                entries,
                copied,
            } => (models_dir, entries, copied),
            BundledProvision::None => panic!("a present manifest is not None"),
        };
        assert_eq!(models_dir, data_root.join("pretrained-bundled"));
        assert_eq!(entries, 2);
        assert_eq!(copied, 2);
        assert_eq!(
            std::env::var_os(BUNDLED_MODELS_DIR_ENV),
            Some(models_dir.as_os_str().to_os_string()),
            "the env var names the verified copy (PROV-PC-12)",
        );

        // Every destination file verifies against the manifest (INV-2/INV-3).
        for file in [
            "relchange-threshold@0.4.0.txr",
            "squeeze-fit@1.2.0.txr",
            BUNDLED_MANIFEST_FILE,
        ] {
            assert!(models_dir.join(file).exists(), "destination carries {file}");
        }
        let bytes: Vec<(&str, &str, Vec<u8>)> = vec![
            (
                "relchange-threshold",
                "0.4.0",
                b"first synthetic model".to_vec(),
            ),
            ("squeeze-fit", "1.2.0", b"second synthetic model".to_vec()),
        ];
        for (id, version, body) in bytes {
            let path = models_dir.join(format!("{id}@{version}.txr"));
            assert_eq!(
                std::fs::read(&path).expect("dest file readable"),
                body,
                "{id}@{version} is byte-exact"
            );
        }

        // Second run: every file is already verified — nothing is copied.
        let again = provision_from(&resource, &bundled_data_dir()).expect("second run succeeds");
        match again {
            BundledProvision::Bundled { copied: 0, .. } => {}
            other => panic!("idempotent: no file re-copied, got {other:?}"),
        }
    }

    #[test]
    fn bundled_data_dir_prefers_the_harness_isolation_env_var() {
        let _env = ENV_MUTEX.lock().unwrap();
        let data_root = scratch("data-dir");
        let _data_var = EnvVar::set(DATA_DIR_ENV, &data_root);
        assert_eq!(
            bundled_data_dir(),
            data_root,
            "TXR_APP_DATA_DIR wins over the SDK default — the same order the \
             server's rootfs::data_root uses"
        );
    }

    // ── TEST-IR-3 ──────────────────────────────────────────────────────────

    #[test]
    fn a_corrupt_shipped_file_fails_naming_it_and_keeps_the_previous_copy() {
        let _env = ENV_MUTEX.lock().unwrap();
        let data_root = scratch("corrupt");
        let _data_var = EnvVar::set(DATA_DIR_ENV, &data_root);
        let _models_var = EnvVar::unset(BUNDLED_MODELS_DIR_ENV);
        let resource = fixture_resource_dir(
            "corrupt",
            &[
                ("relchange-threshold", "0.4.0", b"the verified model"),
                ("squeeze-fit", "1.2.0", b"the second model"),
            ],
        );

        // First run: the verified set lands at the destination.
        let first = provision_from(&resource, &bundled_data_dir()).expect("provision");
        let dest = match &first {
            BundledProvision::Bundled { models_dir, .. } => models_dir.clone(),
            BundledProvision::None => panic!("manifest present"),
        };
        let kept = std::fs::read(dest.join("squeeze-fit@1.2.0.txr")).expect("previous copy");

        // Byte-flip the SHIPPED file (a corrupt bundle — a reinstall matter,
        // never a silent trust of the bytes).
        let shipped = resource.join("squeeze-fit@1.2.0.txr");
        let tampered: Vec<u8> = kept.iter().copied().rev().collect();
        std::fs::write(&shipped, &tampered).expect("tamper the shipped file");

        let err = provision_from(&resource, &bundled_data_dir()).expect_err("tamper refused");
        assert!(matches!(err, BundledError::VerifyFailed { .. }), "{err}");
        assert!(
            err.to_string().contains("squeeze-fit@1.2.0.txr"),
            "the Err names the file: {err}"
        );

        // The destination keeps the previous verified copy — never the
        // tampered bytes, never a partial write.
        assert_eq!(
            std::fs::read(dest.join("squeeze-fit@1.2.0.txr")).expect("kept copy"),
            kept,
            "the previous verified copy survives"
        );
        for path in std::fs::read_dir(&dest).expect("dest dir") {
            let path = path.expect("entry").path();
            assert!(
                !path.to_string_lossy().ends_with(".part"),
                "no orphaned .part: {}",
                path.display()
            );
        }
    }

    #[test]
    fn a_missing_shipped_file_fails_naming_it_and_stages_nothing_on_first_run() {
        let _env = ENV_MUTEX.lock().unwrap();
        let data_root = scratch("missing-shipped");
        let _data_var = EnvVar::set(DATA_DIR_ENV, &data_root);
        let _models_var = EnvVar::unset(BUNDLED_MODELS_DIR_ENV);
        let resource = fixture_resource_dir(
            "missing-shipped",
            &[("relchange-threshold", "0.4.0", b"the only model")],
        );
        std::fs::remove_file(resource.join("relchange-threshold@0.4.0.txr"))
            .expect("remove the shipped file");

        let err = provision_from(&resource, &bundled_data_dir()).expect_err("absent file refused");
        assert!(matches!(err, BundledError::ResourceFile { .. }), "{err}");
        assert!(
            err.to_string().contains("relchange-threshold@0.4.0.txr"),
            "{err}"
        );
        assert!(
            !data_root.join("pretrained-bundled").exists(),
            "nothing written on a failed verify (no half-provision)"
        );
    }

    #[test]
    fn a_missing_manifest_is_none_and_leaves_the_env_var_alone() {
        let _env = ENV_MUTEX.lock().unwrap();
        let data_root = scratch("no-manifest");
        let _data_var = EnvVar::set(DATA_DIR_ENV, &data_root);
        let _models_var = EnvVar::unset(BUNDLED_MODELS_DIR_ENV);
        let resource = scratch("no-manifest-resource");

        let provision = provision_from(&resource, &data_root).expect("absent manifest is Ok");
        assert_eq!(provision, BundledProvision::None);
        assert!(
            std::env::var_os(BUNDLED_MODELS_DIR_ENV).is_none(),
            "the None state leaves the env var untouched"
        );
    }

    #[test]
    fn a_failed_copy_leaves_no_part_file() {
        let _env = ENV_MUTEX.lock().unwrap();
        let data_root = scratch("failed-copy");
        let _data_var = EnvVar::set(DATA_DIR_ENV, &data_root);
        let _models_var = EnvVar::unset(BUNDLED_MODELS_DIR_ENV);
        let resource = fixture_resource_dir(
            "failed-copy",
            &[("relchange-threshold", "0.4.0", b"the model bytes")],
        );
        let dest = data_root.join("pretrained-bundled");
        std::fs::create_dir_all(&dest).expect("dest dir");
        // The target NAME is occupied by a DIRECTORY: the atomic rename is
        // refused (rename file→dir), and the `.part` must be gone.
        std::fs::create_dir(dest.join("relchange-threshold@0.4.0.txr"))
            .expect("occupy the target name");

        let err = provision_from(&resource, &data_root).expect_err("copy refused");
        assert!(matches!(err, BundledError::ProvisionIo { .. }), "{err}");
        let leftovers: Vec<String> = std::fs::read_dir(&dest)
            .expect("dest dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".part"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no orphaned .part after a failed copy: {leftovers:?}"
        );
    }

    #[test]
    fn provision_treats_txr_bytes_as_opaque() {
        let _env = ENV_MUTEX.lock().unwrap();
        let data_root = scratch("opaque");
        let _data_var = EnvVar::set(DATA_DIR_ENV, &data_root);
        let _models_var = EnvVar::unset(BUNDLED_MODELS_DIR_ENV);
        // Not valid UTF-8, not JSON — a provision must never parse a model.
        let garbage: Vec<u8> = vec![0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f];
        let resource = fixture_resource_dir("opaque", &[("garbage-model", "0.1.0", &garbage)]);

        let provision = provision_from(&resource, &bundled_data_dir()).expect("opaque ok");
        let dest = match provision {
            BundledProvision::Bundled { models_dir, .. } => models_dir,
            BundledProvision::None => panic!("manifest present"),
        };
        assert_eq!(
            std::fs::read(dest.join("garbage-model@0.1.0.txr")).expect("copied"),
            garbage,
            "the bytes are copied byte-exact, never interpreted (INV-7)"
        );
    }
}
