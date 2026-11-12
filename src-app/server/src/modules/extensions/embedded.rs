//! Embedded processor SEED + extract-on-first-use + seed-version-wins reconciliation
//! (ITEM-3 + ITEM-4). Mirrors `modules::rootfs::embedded::ensure_extracted`:
//! `include_dir!` the in-tree `../packages` tree as the SEED asset → on first run
//! extract it under `<data_root>/processors/<pkg>/…` with temp-write + atomic
//! `rename` → a per-package version marker (`.seed-manifest.json`) is the
//! skip-if-fresh fast path (the analog of rootfs's `.sqfs-sha`).
//!
//! Why extract at all (vs reading the `include_dir!` embed directly): the extracted
//! `<data_root>/processors` folder is the RUNTIME source of truth so a user /
//! separate-repo can drop additional processor packages next to the seeded ones and
//! the boot scan discovers them from ONE folder. As of S4 this `PROCESSORS_SEED`
//! embed is the SOLE `include_dir!` of the processor tree — `loader.rs`'s duplicate
//! embed was removed and the registry now scans the extracted folder only (INV-1);
//! both boot paths (order-17 datatype + order-18 extensions) call `ensure_extracted`
//! then `ExtensionRegistry::build_from_dir`.
//!
//! ## Seed-vs-user boundary (the reconciliation contract, DEC-3)
//! `.seed-manifest.json` records, per SEED-owned package, the version last extracted
//! AND a digest of every file that extraction wrote (`files`). On every
//! `ensure_extracted`:
//! - a MISSING seed package is extracted;
//! - a seed package whose EMBEDDED version is newer than the recorded one is
//!   OVERWRITTEN (seed-version-wins) — including over a user edit to that
//!   seed-owned package (documented: customize by copying to a NEW id). This arm is
//!   WHOLESALE: the package directory is replaced, so a user-created file placed
//!   inside a seed package dir does not survive a version bump either. See
//!   [`extract_package`];
//! - a seed package at the SAME version whose EMBEDDED BYTES changed since the
//!   recorded extraction is repaired SURGICALLY — only the files whose embedded
//!   bytes differ from what was recorded, plus files missing on disk, are rewritten.
//!   Everything else on disk (a user edit to a file the seed did NOT change; any
//!   user-created file in the package dir) is left alone. See [`plan_repair`];
//! - any folder NOT listed in the seed manifest (a user / separate-repo package) is
//!   INVISIBLE to reconciliation — never read, overwritten, or deleted.
//!
//! A seed package dropped from the embed on a later build is simply no longer
//! listed in the new manifest; its extracted folder is LEFT on disk (it becomes an
//! unmanaged package, treated like a user package thereafter) — reconciliation is
//! non-destructive by construction.
//!
//! ### What "user edits survive" means, precisely
//! The guarantee is per-FILE, not per-package: an edit survives for as long as the
//! seed does not itself change that file (and the package's version does not move).
//! When a new build ships different bytes for a file, those bytes win — that is the
//! whole point of shipping them. The previous wording promised the edit survived
//! "until a version bump" while the repair path replaced the entire directory, so a
//! single missing file took a user's edits AND their own files with it; that is the
//! gap [`plan_repair`] closes.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use include_dir::{include_dir, Dir};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};

/// The embedded processor SEED tree. `$CARGO_MANIFEST_DIR` = `src-app/server`, so
/// this resolves to `src-app/packages`. As of S4 this is the SOLE `include_dir!`
/// of the tree (the loader's duplicate embed was removed); it is used ONLY as the
/// extract SEED — the registry scans the extracted folder, never these bytes (INV-1).
static PROCESSORS_SEED: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../packages");

/// The filename of the top-level seed marker + reconciliation manifest.
const SEED_MANIFEST_NAME: &str = ".seed-manifest.json";

/// Process-wide guard so the first `ensure_extracted` reconciles exactly once and
/// caches the folder path; subsequent callers (order-17 datatype + order-18
/// extensions boot paths) get the cached path without re-walking the seed.
static EXTRACTED: OnceCell<PathBuf> = OnceCell::new();

/// Serializes the mutating section of [`reconcile`] within this process so two
/// racing boot paths / threads never overwrite the same package concurrently. The
/// per-file/per-dir atomic `rename` is the cross-PROCESS torn-write defense; this
/// mutex is the intra-process one. Poison-recovering (a panic mid-reconcile leaves
/// only atomically-renamed files behind, so the lock is safe to reuse).
static RECONCILE_LOCK: Mutex<()> = Mutex::new(());

/// Monotonic suffix source for temp dirs, so concurrent callers never collide on a
/// `.<pkg>.tmp-*` staging path even within one process/pid.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------------

/// `<data_root>/processors` — the extracted runtime source of truth. Honors
/// `TXR_APP_DATA_DIR` via [`rootfs::data_root`](crate::modules::rootfs::data_root)
/// (how the integration harness isolates each test's data dir).
///
/// ## Why the in-process unit-test build gets its own root
/// The integration harness sets `TXR_APP_DATA_DIR` per test (`tests/common/mod.rs`),
/// so every integration test already extracts into a private folder. The in-process
/// UNIT tests (`cargo test --lib`) have no such harness: `data_root()` falls back to
/// the SDK default `~/.<app_name>`, and `app_name()` reads an `APP_NAME` `OnceCell`
/// that a test binary never sets — so it resolves to the literal **`~/.app`**, ONE
/// folder shared by every worktree, branch and SDK-consuming app on the machine.
///
/// Reconciliation is version-keyed and seed-version-**wins-only** (see [`reconcile`]):
/// an extracted copy a sibling checkout left there at a HIGHER package version is
/// skipped forever, so the seed assertions silently read that FOREIGN manifest instead
/// of this tree's embedded seed. That is not hypothetical — it turned
/// `datatype::layout::tests::seed_selector_maps_are_declared` and
/// `datatype::tests::lattice_golden_fixture` red on a clean checkout of `main`, with
/// no local edit involved, purely because another worktree had run its tests first.
///
/// So the `--lib` binary extracts into its OWN root, keyed by this crate's manifest
/// dir (two worktrees never share one) and wiped once per process (so a same-version
/// in-tree manifest edit is never masked by a stale extracted copy — the other half of
/// the version-keyed staleness trap). `#[cfg(test)]` means this exists ONLY in the
/// `--lib` test build: the server binary and the integration-test crates are unchanged.
/// An explicit `TXR_APP_DATA_DIR` still wins, so a test can still aim at a chosen dir.
///
/// ## Why this is still called `processors` when the SOURCE tree is `packages` (DEC-8b)
/// The in-tree source directory was renamed `src-app/processors/` → `src-app/packages/`
/// (visualize-pane ITEM-69), and the `include_dir!` above follows it. This RUNTIME root
/// deliberately did NOT move with it, and the divergence is recorded here — at the one
/// line that decides it — rather than in a plan nobody reads from this file.
///
/// Renaming a source directory is mechanical; renaming a DEPLOYED DATA ROOT is a
/// migration. [`reconcile`] is version-keyed and seed-version-**wins-only**: an extracted
/// copy at a higher version is skipped forever, and nothing anywhere scans a second root.
/// So a rename here would not move an existing install's data — it would leave every one
/// of them with a fully populated `<data_root>/processors` that nothing reads, beside a
/// new empty `<data_root>/packages`, with no path that ever repairs it. That migration is
/// worth writing when there is a reason to; there was none, and doing it inside a
/// mechanical rename commit is the wrong place to spend the risk — not least because
/// `sandbox::processors::confine_under_package` canonicalises against THIS root to reject
/// a symlink escape, a gate that reads host files with full server privilege and outside
/// bwrap. `tests/extensions/api_test.rs` pins both halves: the packages load from the
/// renamed source, extract to this unchanged root, and the escape is still refused here.
pub fn processors_data_dir() -> PathBuf {
    #[cfg(test)]
    {
        if std::env::var_os("TXR_APP_DATA_DIR").is_none() {
            return unit_test_processors_dir();
        }
    }
    crate::modules::rootfs::data_root().join("processors")
}

/// The `--lib` test binary's private extraction root — see [`processors_data_dir`].
///
/// Keyed by `CARGO_MANIFEST_DIR` (per-worktree) **and** the pid (so two concurrent
/// `--lib` runs of the same worktree cannot wipe each other's folder mid-scan), wiped
/// on first use in this process so every run re-extracts THIS tree's embedded seed.
/// Per §5 (every temp dir gets an eviction path) the first caller also sweeps the
/// same-worktree siblings a previous run left behind once they are older than
/// [`UNIT_TEST_DIR_TTL`]; a live sibling's folder is far younger, so it is never touched.
#[cfg(test)]
fn unit_test_processors_dir() -> PathBuf {
    static UNIT_TEST_DIR: OnceCell<PathBuf> = OnceCell::new();
    UNIT_TEST_DIR
        .get_or_init(|| {
            let prefix = format!(
                "txr-libtest-appdata-{:016x}",
                fnv1a64(env!("CARGO_MANIFEST_DIR"))
            );
            let base = std::env::temp_dir();
            sweep_stale_unit_test_dirs(&base, &prefix);
            let dir = base.join(format!("{prefix}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            dir.join("processors")
        })
        .clone()
}

/// How long an abandoned `--lib` extraction root is kept before the next run reclaims it.
#[cfg(test)]
const UNIT_TEST_DIR_TTL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Best-effort eviction of this worktree's abandoned `--lib` extraction roots (a run
/// that was killed cannot clean up after itself). Age-based rather than pid-based so it
/// stays portable and can never delete a folder a concurrently-running sibling owns.
#[cfg(test)]
fn sweep_stale_unit_test_dirs(base: &Path, prefix: &str) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name();
        if !name.to_string_lossy().starts_with(prefix) {
            continue;
        }
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > UNIT_TEST_DIR_TTL);
        if stale {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// FNV-1a over the crate's manifest dir — the per-worktree key of the `--lib`
/// extraction root. Mirrors the per-worktree build/test DB keying the build helper uses.
#[cfg(test)]
fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// Extract + reconcile the embedded seed on the first call, returning the extracted
/// `<data_root>/processors` folder. Idempotent + safe under concurrent callers
/// (guarded by a `OnceCell`; the reconcile itself is also independently idempotent).
/// This is the entry the S4 boot scan calls before scanning the folder.
pub fn ensure_extracted() -> Result<PathBuf, String> {
    EXTRACTED
        .get_or_try_init(|| {
            let dir = processors_data_dir();
            let outcome = reconcile(&dir, &embedded_seed())?;
            tracing::info!(
                dir = %dir.display(),
                extracted = outcome.extracted.len(),
                overwritten = outcome.overwritten.len(),
                skipped = outcome.skipped.len(),
                // Surfaced on the summary line too, not only in the per-package `warn!`:
                // `extracted=0 … skipped=N` was the line an operator read while a
                // package was silently incomplete, and a count of 0 here is what makes
                // "nothing was wrong" a statement rather than an absence.
                repaired = outcome.repaired.len(),
                "processors: seed extract+reconcile complete"
            );
            Ok(dir)
        })
        .cloned()
}

// ---------------------------------------------------------------------------------
// Seed model
// ---------------------------------------------------------------------------------

/// One seed package: its declared version (from `manifest.yaml`) + every file it
/// ships, keyed by path RELATIVE to the package dir (e.g. `manifest.yaml`,
/// `compute/run.py`).
#[derive(Clone)]
pub(crate) struct SeedPackage {
    pub version: String,
    pub files: Vec<(PathBuf, Vec<u8>)>,
}

/// The whole embedded seed: package-id → package. `BTreeMap` for a deterministic
/// (id-sorted) reconcile order.
#[derive(Clone, Default)]
pub(crate) struct SeedSet {
    pub packages: BTreeMap<String, SeedPackage>,
}

/// The set of BAKED-seed package ids (from the compile-time seed, robust even if the
/// on-disk `.seed-manifest.json` was tampered). The SEED-ONLY kill-switch (M8) uses this
/// to restrict the folder scan to seed-managed packages, ignoring unmanaged drop-ins.
pub fn seed_managed_ids() -> std::collections::HashSet<String> {
    seed_managed_id_set().clone()
}

/// [`seed_managed_ids`] without the clone, computed ONCE per process.
///
/// The id set is now consulted on EVERY scan, not only when the SEED-ONLY kill-switch is
/// on: `ExtensionRegistry::scan_dir` derives each package's ORIGIN from it (#190/#197 —
/// a first-party rejection is a refusal, a dropped-in one is a tolerated skip). Rebuilding
/// the whole [`SeedSet`] for that would walk and hash every embedded file on every reflect,
/// which the watcher can fire repeatedly; the ids alone never change within a process
/// (they come from `include_dir!`), so they are cached.
///
/// Derived from the compile-time seed, never from a written-down list: a package added to
/// `src-app/packages/` is first-party the moment it is embedded, with no edit here.
pub(crate) fn seed_managed_id_set() -> &'static std::collections::HashSet<String> {
    static IDS: std::sync::OnceLock<std::collections::HashSet<String>> = std::sync::OnceLock::new();
    IDS.get_or_init(|| {
        PROCESSORS_SEED
            .dirs()
            .filter_map(|dir| {
                let base = dir.path();
                let id = base.file_name().and_then(|s| s.to_str())?;
                // A seed package must carry a `manifest.yaml` — the same rule
                // `embedded_seed` applies, so the two sets cannot diverge.
                PROCESSORS_SEED.get_file(base.join("manifest.yaml"))?;
                Some(id.to_string())
            })
            .collect()
    })
}

/// The BYTES this binary embedded for `<id>/manifest.yaml`, if `id` is a seed package.
///
/// #190/#197 — this is what lets the loader ask a question its folder-name check cannot:
/// *are the bytes on disk the ones we shipped?* The seed reconcile is deliberately
/// no-clobber for content (`plan_repair` compares embedded-vs-recorded-embedded digests and
/// "never reads disk content"), so a hand-edited — or attacker-written —
/// `<data_root>/processors/<seed-id>/manifest.yaml` survives every restart while keeping a
/// seed-managed NAME. Classifying that as "our own artifact" would hand anyone who can write
/// one file under the processors folder a permanent boot refusal.
pub(crate) fn embedded_manifest_bytes(id: &str) -> Option<&'static [u8]> {
    // Reject any id that is not a single plain path component, so a crafted folder name can
    // never make this reach outside the embedded package it names.
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.starts_with('.') {
        return None;
    }
    #[cfg(test)]
    if let Some(forced) = test_seam::forced_embedded_bytes(id) {
        return Some(forced);
    }
    PROCESSORS_SEED
        .get_file(Path::new(id).join("manifest.yaml"))
        .map(|f| f.contents())
}

/// The TEST-ONLY seam that makes the first-party REFUSAL reachable through the real path.
///
/// A first-party refusal means "a package this binary shipped, still carrying the bytes we
/// shipped, fails the RUNTIME lint" — which is the #190/#197 defect itself, and is
/// therefore unreachable from a healthy tree by construction. It cannot be staged on disk:
/// editing the manifest is exactly what makes the bytes no longer ours.
///
/// Mutating a built registry after the fact (the earlier `force_origin_for_test`) proves the
/// posture FUNCTION but leaves the edge that matters — `build_from_dir_checked` actually
/// applying it at boot and on every reflect — unasserted. A blind audit confirmed the gap:
/// disconnecting the posture from the checked path left the whole suite green, which is
/// structurally the same "the mechanism exists but nothing calls it" defect this branch
/// exists to fix.
///
/// So the seam is placed on the ONE input the state depends on: what this binary believes
/// it embedded. A test declares "pretend we shipped THESE bytes", writes those same bytes to
/// the folder, and the package genuinely classifies first-party through the real
/// `PackageOrigin::of_bytes` — an honest simulation of a bad shipped package rather than a
/// forced verdict. It is thread-local, so parallel tests cannot see each other's override,
/// and `#[cfg(test)]`, so it does not exist in a shipped binary.
#[cfg(test)]
pub(crate) mod test_seam {
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static FORCED: RefCell<HashMap<String, &'static [u8]>> = RefCell::new(HashMap::new());
    }

    /// Pretend this binary embedded `bytes` for `<id>/manifest.yaml`, for THIS thread only.
    /// The bytes are leaked to `'static` deliberately: the production signature returns
    /// `&'static [u8]` because the real source is `include_dir!`, and a test override that
    /// changed that signature would stop testing the production shape. Test-only, bounded by
    /// the number of overrides a test makes.
    pub(crate) fn force_embedded_manifest(id: &str, bytes: &[u8]) {
        let leaked: &'static [u8] = Box::leak(bytes.to_vec().into_boxed_slice());
        FORCED.with(|f| f.borrow_mut().insert(id.to_string(), leaked));
    }

    /// Drop every override on this thread, so a test cannot leak into the next one that
    /// happens to run on the same worker.
    pub(crate) fn clear_forced_embedded_manifests() {
        FORCED.with(|f| f.borrow_mut().clear());
    }

    pub(super) fn forced_embedded_bytes(id: &str) -> Option<&'static [u8]> {
        FORCED.with(|f| f.borrow().get(id).copied())
    }
}

/// Build the [`SeedSet`] from the compile-time-embedded `PROCESSORS_SEED` tree.
/// Each top-level dir with a `manifest.yaml` is one seed package; its version is the
/// manifest's `version` (default `0.0.0` if absent — the loader does strict manifest
/// validation later, S4). A top-level dir WITHOUT a `manifest.yaml` is not a package
/// and is skipped (mirrors `loader.rs`).
pub(crate) fn embedded_seed() -> SeedSet {
    let mut packages = BTreeMap::new();
    for dir in PROCESSORS_SEED.dirs() {
        let base = dir.path();
        let Some(id) = base.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // A seed package must carry a manifest.yaml (its version + identity source).
        let manifest_path = base.join("manifest.yaml");
        let Some(mf) = PROCESSORS_SEED.get_file(&manifest_path) else {
            continue;
        };
        let version = mf
            .contents_utf8()
            .and_then(parse_manifest_version)
            .unwrap_or_else(|| "0.0.0".to_string());

        let mut files = Vec::new();
        collect_files(dir, base, &mut files);
        packages.insert(id.to_string(), SeedPackage { version, files });
    }
    SeedSet { packages }
}

/// Directory names that are PYTHON BUILD NOISE, not package content.
///
/// `include_dir!` walks the filesystem, not git, so a `.gitignore`d `__pycache__/`
/// left behind by a local `pytest` run is embedded into the binary exactly like a
/// source file. On this host that was 44 of the seed's 102 embedded files (16 of
/// `_lib`'s 29), and the consequences are not cosmetic:
/// - the embedded set — and therefore the binary — differs between two build hosts
///   that ran their test suites differently, for no source difference at all;
/// - every one of those files becomes something reconciliation must account for on
///   a SHARED processors dir, so two build hosts each see files "missing" that the
///   other's `.pyc` set happens to contain, and re-extract over each other forever.
///
/// Excluding them is what makes the embed a function of the SOURCE tree.
const EXCLUDED_DIR_NAMES: &[&str] = &["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"];

/// True when `rel` (a path relative to a package dir) is build noise rather than
/// package content: anything under an [`EXCLUDED_DIR_NAMES`] directory at any depth,
/// or a compiled-python artifact.
fn is_build_noise(rel: &Path) -> bool {
    rel.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| EXCLUDED_DIR_NAMES.contains(&s))
    }) || rel
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e == "pyc" || e == "pyo")
}

/// Recursively collect every file under `dir`, storing each path relative to `base`
/// (the package dir) alongside its bytes. Build noise ([`is_build_noise`]) is skipped
/// — it is still baked into the binary's `include_dir!` blob (that macro has no
/// exclusion hook), but it is never part of the seed, never extracted, and never
/// considered by reconciliation.
fn collect_files(dir: &Dir<'_>, base: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
    for f in dir.files() {
        if let Ok(rel) = f.path().strip_prefix(base) {
            if is_build_noise(rel) {
                continue;
            }
            out.push((rel.to_path_buf(), f.contents().to_vec()));
        }
    }
    for sub in dir.dirs() {
        if sub
            .path()
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| EXCLUDED_DIR_NAMES.contains(&s))
        {
            continue;
        }
        collect_files(sub, base, out);
    }
}

/// Pull just the `version:` scalar out of a `manifest.yaml` with the SAME parser the
/// runtime loader uses (`serde_norway`), ignoring every other field.
fn parse_manifest_version(text: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct VersionOnly {
        version: Option<String>,
    }
    serde_norway::from_str::<VersionOnly>(text)
        .ok()
        .and_then(|v| v.version)
        .filter(|s| !s.trim().is_empty())
}

// ---------------------------------------------------------------------------------
// Reconciliation (ITEM-4)
// ---------------------------------------------------------------------------------

/// On-disk `<data_root>/processors/.seed-manifest.json`: the set of SEED-owned
/// packages, the version last extracted for each, and a digest of every file that
/// extraction wrote. Its ONLY keys are seed packages — a folder absent from
/// `packages` is a user/separate-repo package and is invisible to reconciliation.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SeedManifest {
    packages: BTreeMap<String, String>,
    /// package id → (`/`-joined relative path → hex SHA-256 of the EMBEDDED bytes
    /// that were written there). This is a record of what the SEED shipped, not of
    /// what is on disk, which is exactly what makes it able to tell "the seed changed
    /// this file" apart from "the user changed this file" without reading the file.
    ///
    /// `#[serde(default)]` so a `.seed-manifest.json` written by a binary from before
    /// this field existed still parses; a package with no recorded digests is treated
    /// as fully stale and re-asserted once (see [`plan_repair`]).
    #[serde(default)]
    files: BTreeMap<String, BTreeMap<String, String>>,
}

/// The manifest key for a package-relative path: components joined with `/`, so the
/// recorded map is byte-identical whichever OS wrote it.
fn rel_key(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

/// Hex SHA-256 of every file this package EMBEDS, keyed by [`rel_key`].
///
/// Hashing the embedded bytes (which live in the binary's static data — no I/O) is
/// what makes content-change detection unforgettable: the previous freshness key was
/// `manifest.yaml`'s `version` string, which is only a faithful content identity if a
/// human remembers to bump it on every edit. `_lib` shipped as `0.1.0` through every
/// change since it was introduced, so on a shared processors dir it could not
/// distinguish two different file sets, and the never-bumped content simply never
/// reached an already-provisioned host. A digest cannot be forgotten; it is derived.
fn embedded_digests(pkg: &SeedPackage) -> BTreeMap<String, String> {
    use sha2::{Digest, Sha256};
    pkg.files
        .iter()
        .map(|(rel, bytes)| {
            let mut h = Sha256::new();
            h.update(bytes);
            (rel_key(rel), format!("{:x}", h.finalize()))
        })
        .collect()
}

/// What a single [`reconcile`] did — for logging + tests.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ReconcileOutcome {
    /// Newly-extracted (previously missing) seed package ids.
    pub extracted: Vec<String>,
    /// Overwritten (seed-version-wins) seed package ids.
    pub overwritten: Vec<String>,
    /// Left as-is (already fresh, or a locally-newer copy kept) seed package ids.
    pub skipped: Vec<String>,
    /// Re-extracted because the on-disk package was INCOMPLETE — the manifest recorded
    /// a version whose folder exists, but a file this binary embeds was not on disk.
    /// Separate from `overwritten` (a deliberate seed-version-wins) because this one is
    /// a DESYNC, not a normal upgrade, and boot should say so out loud.
    pub repaired: Vec<String>,
}

/// The files `pkg` embeds that are NOT present under `<dir>/<id>/`.
///
/// **Why an existence check exists at all.** Freshness used to be keyed on `(recorded
/// version string, package directory exists)`. Neither describes the FILE SET. Processors
/// extract into a SHARED host dir (`<data_root>/processors`, one per machine — not per
/// worktree/build), so a binary built at one commit writes `_lib@0.1.0` with ITS file set
/// and a binary built at another commit then sees "recorded 0.1.0, folder present" and
/// skips. Any file only the second binary ships never lands. That surfaced as
/// `ModuleNotFoundError: No module named 'txr_columns'` raised from inside a sandboxed
/// run — about as far from the cause as a symptom can travel.
///
/// Existence alone is NOT sufficient, which is what [`plan_repair`] adds: a file that is
/// present but stale is invisible here, and a stale conformance gate is exactly as broken
/// as a missing one — quieter, in fact.
///
/// **Cost**, measured rather than estimated: after [`is_build_noise`] filtering the whole
/// embedded seed is 10 packages / 58 files, so a fully-fresh boot pays at most 58 `stat`s,
/// once per process (`ensure_extracted` is behind a `OnceCell`). See
/// `reconcile_cost_on_the_real_seed_is_reported` for the measured numbers.
fn disk_missing_files(dir: &Path, id: &str, pkg: &SeedPackage) -> Vec<PathBuf> {
    let pkg_dir = dir.join(id);
    pkg.files
        .iter()
        .map(|(rel, _)| rel)
        .filter(|rel| !pkg_dir.join(rel).exists())
        .cloned()
        .collect()
}

/// What a surgical repair of one package would do.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RepairPlan {
    /// Embedded files to (re)write: the seed's bytes for them changed since the recorded
    /// extraction, or they are absent from disk.
    pub write: Vec<PathBuf>,
    /// Files a PREVIOUS extraction of this same package wrote and the seed no longer
    /// ships. Only paths the manifest records as seed-written are ever candidates, so
    /// this cannot reach a user's own file.
    pub retire: Vec<PathBuf>,
    /// True when at least one entry in `write` is there because it is MISSING from disk
    /// (rather than merely stale) — the anomalous case, worth a `warn!` rather than an
    /// `info!`.
    pub had_missing: bool,
}

impl RepairPlan {
    fn is_empty(&self) -> bool {
        self.write.is_empty() && self.retire.is_empty()
    }
}

/// Decide, for a package at its RECORDED version, the minimum set of files to touch.
///
/// This is the answer to two separate defects at once.
///
/// **It detects a content change.** `recorded` holds the digest of the bytes the last
/// extraction wrote for each path. A file whose embedded digest no longer matches is one
/// the SEED changed, and it is re-asserted regardless of whether anyone bumped
/// `manifest.yaml`'s `version` — the version string was the previous freshness key, and it
/// is only a faithful content identity if a human remembers to move it. `_lib`, the
/// conformance gate, shipped as `0.1.0` through every change since it was introduced, and
/// the branch-born-package exemption in `scripts/check-processor-seed-versions.sh` meant
/// nothing was going to catch that either. A derived digest cannot be forgotten.
///
/// **And it keeps the repair surgical.** The previous repair was a whole-package
/// `remove_dir_all` + `rename`, so ONE missing file reverted every user edit in that
/// package and deleted every file the user had created inside it — while the docstring
/// directly above it explained that the check was deliberately existence-only *in order to*
/// preserve those edits. Here, a file whose embedded digest is unchanged is never written,
/// so an edit to it survives; and a path the seed never shipped is never named, so a
/// user's own file is never touched.
///
/// **The one-time migration.** A package with NO recorded digests (a
/// `.seed-manifest.json` written before the `files` map existed) is treated as fully
/// stale: every embedded file is re-asserted once. Anything else would keep already-
/// provisioned hosts — the ones this whole mechanism exists for — on their stale copy for
/// one more generation, which is precisely how the previous round's hardening failed to
/// land. That migration also RETIRES the build noise such a binary extracted; the
/// retirement block below states why that branch needs its own candidate bound.
fn plan_repair(
    dir: &Path,
    id: &str,
    pkg: &SeedPackage,
    embedded: &BTreeMap<String, String>,
    recorded: Option<&BTreeMap<String, String>>,
) -> RepairPlan {
    let mut plan = RepairPlan::default();
    let missing = disk_missing_files(dir, id, pkg);
    plan.had_missing = !missing.is_empty();
    let missing: std::collections::HashSet<String> = missing.iter().map(|p| rel_key(p)).collect();

    for (rel, _) in &pkg.files {
        let key = rel_key(rel);
        let stale = match recorded {
            // No digests recorded for this package → one-time full re-assert (see above).
            None => true,
            Some(rec) => rec.get(&key) != embedded.get(&key),
        };
        if stale || missing.contains(&key) {
            plan.write.push(rel.clone());
        }
    }

    // A path a previous extraction of THIS package wrote that the seed no longer ships
    // (e.g. every `__pycache__/*.pyc` a pre-[`is_build_noise`] binary extracted, or a
    // module that was renamed). Left behind, a retired module keeps satisfying an import
    // that should now fail loudly.
    //
    // Where the candidates come from depends on whether that extraction left a record:
    //
    // * RECORDED — the tight bound. Only paths the manifest lists as seed-written are
    //   candidates, so this reaches neither a user's own file nor a path outside the
    //   package dir.
    // * NOT RECORDED — the legacy manifest, and the very case this retirement was written
    //   for. [`is_build_noise`] and the digest map landed in the SAME commit, so a binary
    //   that extracted `__pycache__/*.pyc` is BY CONSTRUCTION one that recorded no
    //   digests: skipping retirement whenever nothing is recorded meant those leftovers
    //   survived the one-time re-assert AND every boot after it, because that re-assert
    //   records the noise-free embedded set and nothing ever names the stale path again.
    //   With no record, the bound is by CLASS instead — a path [`is_build_noise`] rejects
    //   is not package content by definition, and an interpreter rebuilds its own
    //   bytecode. A module the seed RENAMED away is deliberately NOT retired on this
    //   branch: with no record, nothing on disk tells it apart from a file the user wrote.
    //   It becomes retirable from this extraction onward, because this reconcile writes
    //   the digest map.
    let candidates: Vec<PathBuf> = match recorded {
        Some(rec) => rec.keys().map(PathBuf::from).collect(),
        None => disk_build_noise(&dir.join(id)),
    };
    for rel in candidates {
        // Never retire a path the seed still ships. On the legacy branch that path was
        // just queued into `write`, and `apply_repair` retires AFTER it writes — so a
        // disagreement between [`is_build_noise`] and [`collect_files`] would otherwise
        // delete the file this repair had just restored.
        if embedded.contains_key(&rel_key(&rel)) || !is_safe_relative(&rel) {
            continue;
        }
        if dir.join(id).join(&rel).is_file() {
            plan.retire.push(rel);
        }
    }
    plan
}

/// Package-relative paths of files under `pkg_dir` that [`is_build_noise`] classifies as
/// build noise rather than package content — the retirement bound for a package whose
/// extraction recorded no digests (see [`plan_repair`]).
///
/// `DirEntry::file_type` does NOT follow symlinks, so a link is neither a dir nor a file
/// here: the walk cannot leave the package dir, and cannot name a target outside it.
fn disk_build_noise(pkg_dir: &Path) -> Vec<PathBuf> {
    fn walk(root: &Path, rel: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(root.join(rel)) else {
            return;
        };
        for e in entries.filter_map(|e| e.ok()) {
            let child = rel.join(e.file_name());
            match e.file_type() {
                Ok(t) if t.is_dir() => walk(root, &child, out),
                Ok(t) if t.is_file() && is_build_noise(&child) => out.push(child),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(pkg_dir, Path::new(""), &mut out);
    // `read_dir` order is not defined; sorting keeps a plan (and the example path the
    // desync log names) the same on every host.
    out.sort();
    out
}

/// A manifest-sourced relative path is only usable if it stays inside the package dir.
/// The manifest is ours, but it is a file on disk that a broken/edited copy could point
/// at `../..`, and [`plan_repair`] deletes what it names.
fn is_safe_relative(rel: &Path) -> bool {
    !rel.as_os_str().is_empty()
        && rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// The directory a repair is allowed to write into and delete from: `<dir>/<id>` itself,
/// never a LINK standing where it should be.
///
/// [`is_safe_relative`] bounds the RELATIVE half of every path [`apply_repair`] touches —
/// each component is `Normal`, so nothing climbs out lexically. Nothing bounded the
/// DIRECTORY half. `pkg_dir.join(rel)` resolves through a symlinked `<dir>/<id>`, so a
/// package directory replaced by a link into a user's own checkout turned a repair into
/// an overwrite of that checkout and a retirement into a delete inside it — the two
/// things [`apply_repair`]'s own docstring says it does not do. The pruning loop's
/// `starts_with(&pkg_dir)` does not notice: it compares the un-resolved path, which stays
/// inside the package dir lexically the whole time it is landing somewhere else.
///
/// A link is REFUSED rather than resolved-and-checked-for-containment, because
/// containment is not the property that matters. `qc -> ../_lib` canonicalizes to a path
/// inside the processors dir and would pass a containment check, while repairing `qc`
/// would still overwrite and retire files belonging to `_lib`. A seed package directory
/// is either the directory this module extracted or it is not one this module may write
/// through, and that has one answer, not a policy.
///
/// That is a DELIBERATE divergence from the read side, not an oversight of it:
/// `confine_under_package` (in `sandbox::processors`) canonicalizes against the
/// processors ROOT and says in its own docstring that a link from one package to a
/// sibling's file is harmless. It is — for a read. This is a write and a delete, so the
/// same tolerance is the whole defect.
///
/// Scope, stated rather than implied: this is the package-directory half. A link
/// substituted for a directory INSIDE a package (`qc/compute -> …`) is still followed by
/// the write and the retire below. The legacy retirement bound cannot reach one
/// ([`disk_build_noise`]'s walk does not descend a link), so what remains reachable is a
/// path the manifest already records as seed-written, under a directory the user replaced
/// by hand inside a package the seed owns.
fn require_owned_package_dir(dir: &Path, id: &str) -> Result<PathBuf, String> {
    let pkg_dir = dir.join(id);
    if std::fs::symlink_metadata(&pkg_dir)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "repair package `{id}`: `{}` is a symlink, not the extracted package \
             directory — refusing to write or delete through it",
            pkg_dir.display()
        ));
    }
    Ok(pkg_dir)
}

/// Extract missing seed packages, overwrite seed packages whose EMBEDDED version is
/// newer than the recorded one, and NEVER touch anything not in the seed manifest.
/// Idempotent: a second call with no seed-version change rewrites nothing (the
/// `.seed-manifest.json` marker is the fast path). Safe under concurrent callers.
pub(crate) fn reconcile(dir: &Path, seed: &SeedSet) -> Result<ReconcileOutcome, String> {
    let _guard = RECONCILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir processors dir: {e}"))?;

    // Startup orphan reclamation (§5): a crash BETWEEN `remove_dir_all(final)` and
    // `rename(staging→final)` in a PRIOR run orphans its uniquely-named `.{id}.tmp-{pid}-{seq}`
    // staging dir (a later run uses a fresh seq, so it never cleans it). Sweep ALL leftover
    // `.*.tmp-*` staging dirs here so they can't accumulate unbounded. Best-effort.
    //
    // This is the module's ONLY reclamation, which is why [`new_staging_dir`] is the only
    // place a temp is written: a temp put anywhere else — a repair's, beside its
    // destination inside the LIVE package dir; the manifest's, a top-level FILE next to a
    // sweep that matches DIRECTORIES — is stranded, in a package that then reports
    // complete. Add a temp, not a sweep.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.filter_map(|e| e.ok()) {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') && name.contains(".tmp-") && e.path().is_dir() {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    let mut manifest = read_seed_manifest(dir);
    let mut outcome = ReconcileOutcome::default();

    for (id, pkg) in &seed.packages {
        let pkg_dir = dir.join(id);
        let recorded = manifest.packages.get(id).cloned();
        let embedded = embedded_digests(pkg);

        match recorded.as_deref() {
            // Missing from the manifest, or recorded-but-the-folder-vanished (a
            // repair): extract. The manifest AND the folder must both be present to
            // count as fresh (mirrors rootfs `squashfs_path.exists() && marker`).
            None => {
                extract_package(dir, id, pkg)?;
                manifest.packages.insert(id.clone(), pkg.version.clone());
                manifest.files.insert(id.clone(), embedded);
                outcome.extracted.push(id.clone());
            }
            // The SAME-VERSION arm — the fast path, and the one the whole desync lived
            // on. Taking it now requires answering two questions the recorded version
            // string cannot: did the SEED's bytes for any of these files change since we
            // wrote them, and is every one of them still on disk? See [`plan_repair`].
            Some(rec) if rec == pkg.version && pkg_dir.is_dir() => {
                let plan = plan_repair(dir, id, pkg, &embedded, manifest.files.get(id));
                if plan.is_empty() {
                    // Fresh: same version, present on disk, every embedded file present
                    // AND byte-identical to what the seed shipped when it was written →
                    // skip. A user's edit to any of those files is untouched, because the
                    // comparison is embedded-vs-recorded-embedded and never reads disk
                    // content.
                    outcome.skipped.push(id.clone());
                } else {
                    report_desync(id, rec, &plan);
                    apply_repair(dir, id, pkg, &plan)?;
                    manifest.packages.insert(id.clone(), pkg.version.clone());
                    manifest.files.insert(id.clone(), embedded);
                    outcome.repaired.push(id.clone());
                }
            }
            Some(rec) if pkg_dir.is_dir() && !seed_version_wins(&pkg.version, rec) => {
                // A locally-recorded copy is strictly NEWER; honor "seed-version-wins
                // only when the embedded version is NEWER" — keep the local copy and its
                // recorded version. Digests are NOT consulted here: they describe a
                // different (newer) version's extraction, so every file would compare
                // stale and the older embed would clobber a package it is not allowed to
                // touch. Only the completeness check applies — a locally-newer package
                // missing a file this binary imports is the same broken import, and "it
                // says it is newer" is not evidence that its files are there.
                let missing = disk_missing_files(dir, id, pkg);
                if missing.is_empty() {
                    outcome.skipped.push(id.clone());
                } else {
                    let plan = RepairPlan {
                        write: missing,
                        retire: Vec::new(),
                        had_missing: true,
                    };
                    report_desync(id, rec, &plan);
                    apply_repair(dir, id, pkg, &plan)?;
                    // The recorded version + digest map still describe the newer local
                    // extraction; only the absent files were restored, so neither is
                    // rewritten here.
                    outcome.repaired.push(id.clone());
                }
            }
            Some(_) => {
                // Recorded but the folder vanished (repair), or the embedded version
                // is newer (seed-version-wins): (re)extract WHOLESALE, replacing the
                // package directory — see [`extract_package`] for what that costs a user.
                extract_package(dir, id, pkg)?;
                manifest.packages.insert(id.clone(), pkg.version.clone());
                manifest.files.insert(id.clone(), embedded);
                outcome.overwritten.push(id.clone());
            }
        }
    }

    // Stop OWNING seed packages that are no longer in the embed (their folder is left
    // on disk — non-destructive), so the manifest reflects only currently-shipped
    // seed packages. User packages were never in `manifest.packages` to begin with.
    manifest
        .packages
        .retain(|id, _| seed.packages.contains_key(id));
    manifest
        .files
        .retain(|id, _| seed.packages.contains_key(id));

    write_seed_manifest_if_changed(dir, &manifest)?;
    Ok(outcome)
}

/// Apply a [`RepairPlan`]: write exactly the named embedded files in place (each via
/// temp-file + `rename`, so a reader sees the old or the new bytes and never a torn
/// file), then remove exactly the named retired ones.
///
/// This is the surgical counterpart to [`extract_package`]. It exists because the repair
/// path used to call `extract_package`, i.e. answer "one file of this package is missing"
/// with "delete the directory and put the embed back" — which reverted every user edit in
/// the package and deleted every file the user had created inside it, immediately below a
/// docstring explaining that the check avoided content comparison specifically so user
/// edits would survive. Only the seed's own paths are ever named here — and
/// [`require_owned_package_dir`] is what makes "here" the package directory itself rather
/// than wherever a link standing at that path happens to point.
///
/// Deliberately NOT atomic at package granularity: an interrupted repair leaves some
/// files updated and some not, which the very next reconcile detects and finishes,
/// because the manifest's digests are only written after a repair completes.
fn apply_repair(dir: &Path, id: &str, pkg: &SeedPackage, plan: &RepairPlan) -> Result<(), String> {
    let pkg_dir = require_owned_package_dir(dir, id)?;
    let wanted: std::collections::HashSet<&Path> =
        plan.write.iter().map(PathBuf::as_path).collect();

    // Every temp goes in a staging dir, NOT beside its destination — see
    // [`new_staging_dir`]. A repair writes into the LIVE package dir, so a temp beside the
    // destination was stranded there by any interruption: [`reconcile`]'s reclamation
    // matches top-level `.*.tmp-*` DIRECTORIES, and a `.part-` file is in neither the
    // seed's file list nor the recorded digest map, so nothing else would ever notice it —
    // it survived inside a package that then reported complete on every later boot.
    let staging = new_staging_dir(dir, id)?;
    for (rel, bytes) in &pkg.files {
        if !wanted.contains(rel.as_path()) {
            continue;
        }
        write_file_atomically(&pkg_dir.join(rel), bytes, &staging)?;
    }
    // On the error path above this is deliberately NOT reached: the dir is left for the
    // next reconcile's sweep, which is the reclamation this now relies on rather than a
    // second cleanup mechanism of its own.
    let _ = std::fs::remove_dir_all(&staging);

    for rel in &plan.retire {
        // A retirement that could not delete is reported, not swallowed — this is
        // [`extract_package`]'s failure shape one function over, and the record is what
        // makes it permanent. The manifest write that follows a successful repair drops
        // the retired path from the digest map (the seed no longer ships it), and the
        // RECORDED branch of [`plan_repair`] draws its candidates from exactly that map,
        // so a path retired-on-paper but still on disk is never named again by any later
        // boot. The retired module goes on satisfying an import that should now fail
        // loudly, which is the outcome the retirement exists to prevent. Failing here
        // leaves the map naming it, so the next boot tries again.
        match std::fs::remove_file(pkg_dir.join(rel)) {
            Ok(()) => {}
            // Already gone is the state this asks for, not a failure to reach it.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "retire `{}` from package `{id}`: {e}",
                    rel.display()
                ))
            }
        }
        // Prune the directory the retired file lived in, but ONLY while it is empty —
        // `remove_dir` refuses a non-empty dir, so a user's own file in the same folder
        // keeps it alive.
        let mut parent = pkg_dir.join(rel);
        while parent.pop() && parent.starts_with(&pkg_dir) && parent != pkg_dir {
            if std::fs::remove_dir(&parent).is_err() {
                break;
            }
        }
    }
    Ok(())
}

/// A uniquely-named TOP-LEVEL staging dir under `dir`, named to the `.<tag>.tmp-<pid>-<seq>`
/// shape [`reconcile`]'s startup reclamation already sweeps.
///
/// It is the ONLY place this module writes a temp: an orphan left by a crash then lands
/// where the existing sweep reaches it, instead of needing a second sweep of its own for
/// each new temp spelling. `.`-prefixed, so the package loader skips it while it exists.
///
/// The stated cost: that sweep is unconditional, so a concurrent PROCESS booting against
/// the same folder can reclaim a staging dir this one is still filling, and the `rename`
/// then fails and is reported. The window is not new — an extraction has always staged
/// exactly this way, and holds its dir open for far longer than the two calls a manifest
/// write takes — and it is what having ONE reclamation rule costs.
fn new_staging_dir(dir: &Path, tag: &str) -> Result<PathBuf, String> {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let staging = dir.join(format!(".{tag}.tmp-{}-{}", std::process::id(), seq));
    // A leftover staging dir from a crashed prior run must not poison this write.
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir staging `{tag}`: {e}"))?;
    Ok(staging)
}

/// Write `bytes` to `dest`, creating parents, via a uniquely-named temp file in `staging`
/// which is then `rename`d onto `dest` (atomic on one filesystem — `staging` is a
/// top-level dir of the same processors folder `dest` lives under, i.e. the filesystem
/// the staged-dir swap in [`extract_package`] already renames across).
///
/// The temp name carries this process's pid and a live counter, so it can never collide
/// with a seed-shipped path when `staging` is also a destination root.
fn write_file_atomically(dest: &Path, bytes: &[u8], staging: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir `{}`: {e}", parent.display()))?;
    }
    let tmp = staging.join(format!(
        ".part-{}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("create `{}`: {e}", tmp.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write `{}`: {e}", tmp.display()))?;
        f.flush()
            .map_err(|e| format!("flush `{}`: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("promote `{}`: {e}", dest.display()))
}

/// Extract one package's files under `<dir>/<id>/…` atomically: stage into a unique
/// temp dir, remove any existing package dir, then `rename` the staged dir into
/// place (an atomic directory swap on the same filesystem, so a concurrent reader
/// sees either the whole old package or the whole new one — never a torn mix).
///
/// **This REPLACES the package directory**, so nothing that was in it survives: not a
/// user's edit to a seed-owned file, and not a file the user created inside the package
/// dir. That is intentional on the two arms that call it — a first extraction (there is
/// nothing to lose) and a seed-version bump (the documented "seed-version-wins", where
/// re-asserting the package IS the operation). It is NOT acceptable as a repair, which is
/// why a repair goes through [`apply_repair`] instead.
fn extract_package(dir: &Path, id: &str, pkg: &SeedPackage) -> Result<(), String> {
    // Both the destination root and the temp dir: an extraction's temps were always
    // inside this swept staging dir, so they were never the stranded class — and the
    // whole dir is renamed away on success, so none of them survives either way.
    let staging = new_staging_dir(dir, id)?;

    for (rel, bytes) in &pkg.files {
        write_file_atomically(&staging.join(rel), bytes, &staging)?;
    }

    let final_dir = dir.join(id);
    // rename(2) can't replace a non-empty dir, so remove the old package first. A
    // removal that FAILS is reported here rather than swallowed: it is the reason the
    // rename below cannot install anything, and letting the rename report it instead
    // names the symptom ("Directory not empty") while hiding the cause. Already-absent
    // is the state this asks for, not a failure.
    if let Err(e) = std::fs::remove_dir_all(&final_dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("replace package `{id}`: {e}"));
        }
    }
    // A rename that did not happen installed nothing, and that is the whole of what
    // this function is in a position to know.
    //
    // It used to ask `final_dir.is_dir()` on failure and read a directory there as
    // "another process renamed its byte-for-byte copy into place first, so this is a
    // benign concurrent win". The directory that answers is the OLD one whenever the
    // removal above did not succeed — a read-only package dir refuses the unlink of its
    // children — so the arm returned `Ok(())` for an extraction that had installed
    // nothing. [`reconcile`] then recorded the new version AND the new per-file digests
    // for content on nobody's disk, and because the same-version fast path compares the
    // embed against the RECORDED embed (never against disk), it matched on every later
    // boot: the package stayed stale forever behind a manifest asserting it was current,
    // which is the exact repair this module exists to perform.
    //
    // The option is DELETED rather than narrowed, because no version of that check can
    // tell the old directory from a winner's — both are a directory at that path. The
    // honest answer to a failed rename is that the extraction failed; [`reconcile`]
    // propagates it, the manifest keeps describing what IS installed, and the next boot
    // takes the same arm again and repairs. That is also what [`new_staging_dir`]'s
    // docstring has always said happens when a concurrent process sweeps a staging dir
    // out from under this one ("the `rename` then fails and is reported") — the branch
    // removed here was the thing making that sentence false.
    //
    // The staging dir is left where it is on the error path, for the same reason
    // [`apply_repair`] leaves its own: [`reconcile`]'s sweep is this module's single
    // reclamation, and a second cleanup mechanism is a second thing to get wrong.
    std::fs::rename(&staging, &final_dir).map_err(|e| format!("promote package `{id}`: {e}"))
}

/// Say, at BOOT, that the extracted copy of a seed package did not match what this
/// binary embeds — naming the package, how many files are involved and one of them.
///
/// This is the point of the check as much as the repair is. The desync's only previous
/// symptom was an import error raised by a Python process inside a sandbox, several layers
/// and one process boundary away from the cause, with the boot log cheerfully reporting
/// `extracted=0 … skipped=N`.
///
/// The two cases are logged at DIFFERENT levels on purpose. A file MISSING from disk is an
/// anomaly — something on this host removed it — so it stays `warn!`. Bytes that merely
/// changed are the ordinary consequence of running a newer build against an existing
/// processors dir, and now that a digest (not a hand-maintained version string) is what
/// notices, that will happen routinely; logging it at `warn!` would train an operator to
/// ignore the line that also carries the anomaly.
fn report_desync(id: &str, recorded_version: &str, plan: &RepairPlan) {
    // Named for what it is rather than with a collection noun: INV-5 keeps domain
    // vocabulary out of the core, and several natural words here are specimen terms.
    let first_affected = plan
        .write
        .first()
        .or_else(|| plan.retire.first())
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    if plan.had_missing {
        tracing::warn!(
            package = id,
            recorded_version,
            rewrite = plan.write.len(),
            retire = plan.retire.len(),
            example_file = %first_affected,
            "processors: the extracted seed package is INCOMPLETE — a file this binary \
             embeds is absent on disk. Restoring just the affected files. This happens \
             when servers built from different commits share one processors dir"
        );
    } else {
        tracing::info!(
            package = id,
            recorded_version,
            rewrite = plan.write.len(),
            retire = plan.retire.len(),
            example_file = %first_affected,
            "processors: this binary embeds different bytes for a seed package than the \
             extraction on disk recorded, at the SAME version. Re-asserting just the \
             changed files; unchanged files (including any local edit to them) are left \
             alone"
        );
    }
}

fn read_seed_manifest(dir: &Path) -> SeedManifest {
    std::fs::read_to_string(dir.join(SEED_MANIFEST_NAME))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write `.seed-manifest.json` (temp + atomic rename) only when it actually changed,
/// so a no-op reconcile rewrites nothing (preserves skip-if-fresh idempotence).
///
/// Its temp goes in a swept staging dir for the same reason a repair's does: written
/// beside the manifest it was `<dir>/.seed-manifest.json.tmp-<pid>`, a top-level FILE, and
/// the reclamation matches top-level DIRECTORIES — so an interruption between the write
/// and the rename left a file nothing would ever remove.
fn write_seed_manifest_if_changed(dir: &Path, manifest: &SeedManifest) -> Result<(), String> {
    let path = dir.join(SEED_MANIFEST_NAME);
    let next = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("serialize seed manifest: {e}"))?;
    if std::fs::read_to_string(&path).ok().as_deref() == Some(next.as_str()) {
        return Ok(());
    }
    let staging = new_staging_dir(dir, "seed-manifest")?;
    let tmp = staging.join(SEED_MANIFEST_NAME);
    std::fs::write(&tmp, &next).map_err(|e| format!("write seed manifest tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("promote seed manifest: {e}"))?;
    let _ = std::fs::remove_dir_all(&staging);
    Ok(())
}

/// True when the embedded `version` is strictly newer than the `recorded` one by
/// dotted-numeric semver (major.minor.patch, pre-release/build tags dropped). A
/// difference that can't be semver-ordered defensively lets the SEED win (any
/// mismatch republishes the shipped seed). Equal versions are NOT "newer".
fn seed_version_wins(embedded: &str, recorded: &str) -> bool {
    if embedded == recorded {
        return false;
    }
    match (parse_semver(embedded), parse_semver(recorded)) {
        (Some(a), Some(b)) => a > b,
        _ => true,
    }
}

/// Parse `major.minor.patch` into a fixed 3-tuple (missing components → 0), dropping
/// any `-pre`/`+build` suffix. `None` if a core component isn't a non-negative int.
fn parse_semver(v: &str) -> Option<[u64; 3]> {
    let core = v.split(['-', '+']).next().unwrap_or(v);
    let mut out = [0u64; 3];
    for (i, part) in core.split('.').enumerate() {
        if i >= 3 {
            return None; // more than 3 components → not a plain semver
        }
        out[i] = part.parse::<u64>().ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway data dir under the system temp dir (no `TXR_APP_DATA_DIR` env
    /// mutation, so tests stay parallel-safe and never pollute the real data dir).
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir()
                .join(format!("txr-seed-test-{tag}-{}-{seq}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn seed(id: &str, version: &str, manifest_body: &str) -> SeedSet {
        let mut packages = BTreeMap::new();
        packages.insert(
            id.to_string(),
            SeedPackage {
                version: version.to_string(),
                files: vec![
                    (
                        PathBuf::from("manifest.yaml"),
                        manifest_body.as_bytes().to_vec(),
                    ),
                    (
                        PathBuf::from("compute/run.py"),
                        format!("# {id} {version}\n").into_bytes(),
                    ),
                ],
            },
        );
        SeedSet { packages }
    }

    /// A one-package seed with an EXPLICIT file set, so a test can ship the same version
    /// with different bytes — the situation the version string cannot describe and the
    /// whole reason [`plan_repair`] digests the embed.
    fn seed_files(id: &str, version: &str, files: &[(&str, &str)]) -> SeedSet {
        let mut packages = BTreeMap::new();
        packages.insert(
            id.to_string(),
            SeedPackage {
                version: version.to_string(),
                files: files
                    .iter()
                    .map(|(p, b)| (PathBuf::from(p), b.as_bytes().to_vec()))
                    .collect(),
            },
        );
        SeedSet { packages }
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    /// Hex SHA-256 of `bytes` — what the manifest records for a file the seed wrote, and
    /// therefore what "this package is current" is asserted with.
    fn digest_of(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    /// Every FILE under `dir`, as `/`-joined paths relative to it, INCLUDING hidden ones.
    ///
    /// Used to state a leftover assertion as the whole expected file set rather than as
    /// "no `*.part-*` survives": an assertion shaped like the implementation has to name
    /// the orphan's spelling in advance, which is precisely how one orphan class went
    /// unnoticed while another was being swept.
    fn all_files_under(dir: &Path) -> std::collections::BTreeSet<String> {
        fn walk(root: &Path, cur: &Path, out: &mut std::collections::BTreeSet<String>) {
            let Ok(entries) = std::fs::read_dir(cur) else {
                return;
            };
            for e in entries.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() {
                    walk(root, &p, out);
                } else if let Ok(rel) = p.strip_prefix(root) {
                    out.insert(rel_key(rel));
                }
            }
        }
        let mut out = std::collections::BTreeSet::new();
        walk(dir, dir, &mut out);
        out
    }

    fn set_of(paths: &[&str]) -> std::collections::BTreeSet<String> {
        paths.iter().map(|s| s.to_string()).collect()
    }

    // ---- TEST: the INV-5 reconciliation anchor (seed-version-wins AND user-untouched) ----
    #[test]
    fn reconcile_seed_version_wins_leaves_user_package_untouched() {
        let d = TmpDir::new("inv5");
        let dir = d.path();

        // 1) First run extracts the seed package from v0.1.0.
        let v1 = seed("qc", "0.1.0", "id: qc\nversion: 0.1.0\n");
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.extracted, vec!["qc".to_string()]);
        assert_eq!(
            read(&dir.join("qc/manifest.yaml")),
            "id: qc\nversion: 0.1.0\n"
        );

        // 2) A USER drops a non-seed package into the folder.
        std::fs::create_dir_all(dir.join("my-custom")).unwrap();
        std::fs::write(dir.join("my-custom/manifest.yaml"), "USER PACKAGE").unwrap();

        // 3) Re-launch, no version change → seed skipped, user package untouched.
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.skipped, vec!["qc".to_string()]);
        assert!(out.extracted.is_empty() && out.overwritten.is_empty());
        assert_eq!(read(&dir.join("my-custom/manifest.yaml")), "USER PACKAGE");
        assert_eq!(
            read(&dir.join("qc/manifest.yaml")),
            "id: qc\nversion: 0.1.0\n"
        );

        // 4) Bump the EMBEDDED seed version → the seed package is OVERWRITTEN
        //    (seed-version-wins) while the user package is STILL untouched.
        let v2 = seed("qc", "0.2.0", "id: qc\nversion: 0.2.0\nnew: true\n");
        let out = reconcile(dir, &v2).unwrap();
        assert_eq!(out.overwritten, vec!["qc".to_string()]);
        assert_eq!(
            read(&dir.join("qc/manifest.yaml")),
            "id: qc\nversion: 0.2.0\nnew: true\n"
        );
        assert_eq!(
            read(&dir.join("my-custom/manifest.yaml")),
            "USER PACKAGE",
            "a user/separate-repo package is invisible to reconciliation"
        );

        // 5) The manifest lists ONLY the seed package at its new version — never the
        //    user package.
        let mf: SeedManifest = serde_json::from_str(&read(&dir.join(SEED_MANIFEST_NAME))).unwrap();
        assert_eq!(mf.packages.get("qc").map(String::as_str), Some("0.2.0"));
        assert!(!mf.packages.contains_key("my-custom"));
    }

    // ---- TEST: a user edit to a SEED-owned package is overwritten on a version bump ----
    #[test]
    fn user_edit_to_seed_package_overwritten_on_bump_not_on_same_version() {
        let d = TmpDir::new("edit");
        let dir = d.path();
        let v1 = seed("cell-filter", "0.1.0", "orig");
        reconcile(dir, &v1).unwrap();

        // User edits the seed-owned file.
        std::fs::write(dir.join("cell-filter/manifest.yaml"), "HACKED").unwrap();

        // Same version → NOT re-asserted (documented: version bump is what re-writes).
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.skipped, vec!["cell-filter".to_string()]);
        assert_eq!(read(&dir.join("cell-filter/manifest.yaml")), "HACKED");

        // Version bump → seed-version-wins overwrites the user edit.
        let v2 = seed("cell-filter", "0.1.1", "reasserted");
        let out = reconcile(dir, &v2).unwrap();
        assert_eq!(out.overwritten, vec!["cell-filter".to_string()]);
        assert_eq!(read(&dir.join("cell-filter/manifest.yaml")), "reasserted");
    }

    // ---- TEST: extract idempotence / skip-if-fresh (marker fast path, no rewrite) ----
    #[test]
    fn reconcile_is_idempotent_second_call_rewrites_nothing() {
        let d = TmpDir::new("idem");
        let dir = d.path();
        let v1 = seed("qc", "0.1.0", "body");

        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.extracted, vec!["qc".to_string()]);

        // Capture the extracted file's mtime; a second same-version reconcile must
        // NOT rewrite it (the manifest marker short-circuits).
        let f = dir.join("qc/manifest.yaml");
        let mtime1 = std::fs::metadata(&f).unwrap().modified().unwrap();

        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.skipped, vec!["qc".to_string()]);
        assert!(out.extracted.is_empty() && out.overwritten.is_empty());
        let mtime2 = std::fs::metadata(&f).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "a fresh package file is not rewritten");
    }

    // ---- TEST: a vanished-on-disk seed package is repaired (folder re-extracted) ----
    #[test]
    fn reconcile_repairs_a_deleted_seed_package() {
        let d = TmpDir::new("repair");
        let dir = d.path();
        let v1 = seed("qc", "0.1.0", "body");
        reconcile(dir, &v1).unwrap();
        std::fs::remove_dir_all(dir.join("qc")).unwrap();

        // Manifest still records qc@0.1.0, but the folder is gone → re-extract.
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.overwritten, vec!["qc".to_string()]);
        assert!(dir.join("qc/manifest.yaml").is_file());
    }

    // ---- TEST: an INCOMPLETE package at the recorded version is repaired, not skipped ----
    //
    // The live failure this closes: processors extract into a SHARED host dir, so a
    // binary built at one commit writes `<pkg>@<version>` with ITS file set and a binary
    // built at another commit — same version string, more files — then read "recorded
    // version matches, folder present" and SKIPPED. The extra file never landed, and the
    // only symptom was `ModuleNotFoundError` raised by a Python process inside a sandbox.
    // (`_lib` has shipped as `0.1.0` through every content change since it was
    // introduced, so its version string cannot distinguish two file sets.)
    //
    // Modelled exactly that way: extract v1, DELETE one file (standing in for "the binary
    // that wrote this dir never shipped it"), reconcile again at the SAME version.
    #[test]
    fn reconcile_repairs_a_package_missing_a_file_at_the_recorded_version() {
        let d = TmpDir::new("incomplete");
        let dir = d.path();
        let v1 = seed("qc", "0.1.0", "body");
        reconcile(dir, &v1).unwrap();

        // The package dir SURVIVES — only one file inside it is gone. That is what makes
        // this distinct from `reconcile_repairs_a_deleted_seed_package`: the directory
        // existence check that already existed passes here, and used to be the whole test.
        let victim = dir.join("qc/compute/run.py");
        std::fs::remove_file(&victim).unwrap();
        assert!(
            dir.join("qc").is_dir(),
            "the folder is present — only a FILE is missing"
        );

        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(
            out.repaired,
            vec!["qc".to_string()],
            "an incomplete package must be re-extracted, and reported as a DESYNC rather \
             than as an ordinary seed-version-wins overwrite"
        );
        assert!(
            out.skipped.is_empty(),
            "…and must NOT be on the skip list, which is what silently shipped the hole"
        );
        assert_eq!(
            read(&victim),
            "# qc 0.1.0\n",
            "the missing file is back, with the embedded bytes"
        );
    }

    // NEGATIVE CONTROL for the check above — the fast path must still be fast.
    //
    // A completeness check that re-extracted every package on every boot would satisfy the
    // test above just as well, while disabling skip-if-fresh entirely and silently
    // reverting every user edit to a seed-owned package (which the reconciliation contract
    // promises survives until a version bump). Both halves are asserted: an untouched
    // package is skipped, and a package whose file was EDITED at the same version is also
    // skipped WITH THE EDIT INTACT — the check is existence, never content.
    #[test]
    fn a_complete_package_is_still_skipped_and_a_user_edit_at_the_same_version_survives() {
        let d = TmpDir::new("complete");
        let dir = d.path();
        let v1 = seed("qc", "0.1.0", "body");
        reconcile(dir, &v1).unwrap();

        // (a) untouched → skipped, and not rewritten (mtime unchanged).
        let f = dir.join("qc/manifest.yaml");
        let mtime1 = std::fs::metadata(&f).unwrap().modified().unwrap();
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.skipped, vec!["qc".to_string()]);
        assert!(
            out.repaired.is_empty(),
            "a complete package is not a desync — otherwise the warn! cries wolf on every \
             boot and an operator learns to ignore it"
        );
        assert_eq!(
            std::fs::metadata(&f).unwrap().modified().unwrap(),
            mtime1,
            "the fast path still writes nothing"
        );

        // (b) a user EDIT at the same version → still skipped, edit preserved.
        std::fs::write(dir.join("qc/compute/run.py"), "# user's own edit\n").unwrap();
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.skipped, vec!["qc".to_string()]);
        assert!(out.repaired.is_empty());
        assert_eq!(
            read(&dir.join("qc/compute/run.py")),
            "# user's own edit\n",
            "the check is EXISTENCE, not content: reverting a user's edit at the same \
             version would change documented behaviour under cover of a bugfix"
        );
    }

    // The desync is detected on the OTHER skip arm too (a locally-recorded version that
    // is newer than the embedded one — "seed-version-wins only when the seed is NEWER").
    // A locally-newer package missing a file this binary imports is the same broken import,
    // and "it says it is newer" is not evidence that its files are there.
    #[test]
    fn an_incomplete_locally_newer_package_is_repaired_too() {
        let d = TmpDir::new("incomplete-newer");
        let dir = d.path();
        let v2 = seed("qc", "0.2.0", "newer body");
        reconcile(dir, &v2).unwrap();

        // Now the EMBEDDED seed is OLDER than what is recorded (0.1.0 < 0.2.0), which is
        // the arm that keeps the local copy…
        let v1 = seed("qc", "0.1.0", "older body");
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.skipped, vec!["qc".to_string()], "control: kept as-is");

        // …but with a file gone it must still be repaired rather than skipped.
        std::fs::remove_file(dir.join("qc/compute/run.py")).unwrap();
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.repaired, vec!["qc".to_string()]);
        assert!(dir.join("qc/compute/run.py").is_file());
    }

    // ---- TEST: concurrent reconcile converges with no torn files ----
    #[test]
    fn concurrent_reconcile_converges_without_torn_files() {
        let d = TmpDir::new("concurrent");
        let dir = d.path().to_path_buf();
        let s = std::sync::Arc::new(seed("qc", "0.1.0", "concurrent-body"));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.clone();
                let s = s.clone();
                std::thread::spawn(move || reconcile(&dir, &s).unwrap())
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        // Exactly one intact copy of every file, byte-correct.
        assert_eq!(read(&dir.join("qc/manifest.yaml")), "concurrent-body");
        assert_eq!(read(&dir.join("qc/compute/run.py")), "# qc 0.1.0\n");
        let mf: SeedManifest = serde_json::from_str(&read(&dir.join(SEED_MANIFEST_NAME))).unwrap();
        assert_eq!(mf.packages.get("qc").map(String::as_str), Some("0.1.0"));
        // No staging temp dirs left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".qc.tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "no staging dirs leaked");
    }

    // ---- TEST: the REAL embedded seed builds a non-empty, versioned SeedSet ----
    #[test]
    fn embedded_seed_parses_the_in_tree_processors() {
        let s = embedded_seed();
        assert!(
            s.packages.len() >= 7,
            "the in-tree packages/ tree contributes its seed packages, got {}",
            s.packages.len()
        );
        // Every seed package has a version and at least a manifest.yaml.
        for (id, pkg) in &s.packages {
            assert!(!pkg.version.trim().is_empty(), "`{id}` has a version");
            assert!(
                pkg.files
                    .iter()
                    .any(|(p, _)| p == Path::new("manifest.yaml")),
                "`{id}` ships a manifest.yaml"
            );
        }
        assert!(
            s.packages.contains_key("qc"),
            "the `qc` seed package is present"
        );
    }

    // ---- TEST: end-to-end extract of the REAL embedded seed into a temp dir ----
    #[test]
    fn reconcile_real_embedded_seed_end_to_end() {
        let d = TmpDir::new("real");
        let dir = d.path();
        let out = reconcile(dir, &embedded_seed()).unwrap();
        assert!(!out.extracted.is_empty(), "first run extracts the seed");
        assert!(dir.join("qc/manifest.yaml").is_file());
        // Idempotent on the real seed too.
        let out2 = reconcile(dir, &embedded_seed()).unwrap();
        assert!(out2.extracted.is_empty() && out2.overwritten.is_empty());
    }

    // ---- TEST: the REPORTED symptom, on the REAL seed ----
    //
    // The literal failure: a run died with `ModuleNotFoundError: No module named
    // 'txr_columns'` while the boot log read `extracted=0 … skipped=N`. `_lib` is a
    // shared library package this branch introduced, imported by other packages, and its
    // `version:` has not moved since — so on a SHARED processors dir a copy written by a
    // binary that did not ship one of its modules was preferred over the embedded one,
    // and the module never arrived.
    //
    // Driven against the real embedded seed rather than the `seed()` fixture, because the
    // premise under test is a property of the SHIPPED packages (a version string that does
    // not track contents), not of a synthetic one. The file is taken FROM the seed rather
    // than named here, so the test cannot go stale if `_lib` is reorganized.
    #[test]
    fn the_real_lib_package_is_repaired_when_one_of_its_modules_is_missing() {
        let d = TmpDir::new("real-lib");
        let dir = d.path();
        let seed = embedded_seed();
        let pkg = seed
            .packages
            .get("_lib")
            .expect("`_lib` is a shipped seed package (this branch introduced it)");
        let victim = pkg
            .files
            .iter()
            .map(|(rel, _)| rel.clone())
            .find(|rel| rel.extension().is_some_and(|e| e == "py"))
            .expect("`_lib` ships at least one python module");

        reconcile(dir, &seed).unwrap();
        let on_disk = dir.join("_lib").join(&victim);
        assert!(
            on_disk.is_file(),
            "control: the module extracted in the first place"
        );

        // Stand in for "the binary that last wrote this shared dir did not ship it".
        std::fs::remove_file(&on_disk).unwrap();

        let out = reconcile(dir, &seed).unwrap();
        assert!(
            out.repaired.contains(&"_lib".to_string()),
            "an `_lib` missing one of its modules must be repaired, not skipped — being \
             skipped is what turned into a ModuleNotFoundError inside a sandboxed run. \
             repaired={:?} skipped={:?}",
            out.repaired,
            out.skipped
        );
        assert!(
            on_disk.is_file(),
            "…and the module is back on disk, so the import that failed now resolves"
        );
        // NEGATIVE CONTROL: only the broken package was touched. A repair that
        // re-extracted the whole seed would satisfy the assertions above while throwing
        // away every user edit on the box.
        assert_eq!(
            out.repaired,
            vec!["_lib".to_string()],
            "exactly the incomplete package is repaired; the rest stay on the fast path"
        );
    }

    // =================================================================================
    // FINDING 3 — a content change must reach an already-provisioned host, with no
    // human remembering to bump anything.
    // =================================================================================

    /// POSITIVE: the same version shipping DIFFERENT bytes is detected and re-asserted.
    /// NEGATIVE: the same version shipping the SAME bytes is skipped, and writes nothing.
    ///
    /// This is the exact shape of the live defect. `_lib` — the conformance gate every
    /// processor's output is judged by — has shipped as `0.1.0` since it was introduced,
    /// through 678 lines of change in one round alone, with an identical file set. The
    /// existence-only completeness check added the round before could not see that (all
    /// the files were present), and the version guard could not see it either
    /// (`scripts/check-processor-seed-versions.sh` skips packages absent at the merge
    /// base, and `_lib` was born on this branch, so there is no earlier version to require
    /// movement from — the script cannot fix this, which is why the runtime must).
    #[test]
    fn a_content_change_at_the_same_version_is_re_asserted_but_an_identical_one_is_not() {
        let d = TmpDir::new("content-change");
        let dir = d.path();

        let v1 = seed_files(
            "_lib",
            "0.1.0",
            &[
                ("manifest.yaml", "id: _lib\nversion: 0.1.0\n"),
                ("conformance.py", "def check(): pass  # pre-fix\n"),
            ],
        );
        assert_eq!(reconcile(dir, &v1).unwrap().extracted, vec!["_lib"]);

        // NEGATIVE LEG: byte-identical seed at the same version → skipped, not rewritten.
        let f = dir.join("_lib/conformance.py");
        let mtime1 = std::fs::metadata(&f).unwrap().modified().unwrap();
        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(
            out.skipped,
            vec!["_lib"],
            "identical bytes are still the fast path"
        );
        assert!(out.repaired.is_empty());
        assert_eq!(
            std::fs::metadata(&f).unwrap().modified().unwrap(),
            mtime1,
            "a digest check that rewrote on every boot would pass the positive leg too"
        );

        // POSITIVE LEG: same version, CHANGED bytes → repaired, new bytes on disk.
        let v1_changed = seed_files(
            "_lib",
            "0.1.0",
            &[
                ("manifest.yaml", "id: _lib\nversion: 0.1.0\n"),
                (
                    "conformance.py",
                    "def check(): assert _chunk_grid  # fixed\n",
                ),
            ],
        );
        let out = reconcile(dir, &v1_changed).unwrap();
        assert_eq!(
            out.repaired,
            vec!["_lib"],
            "a content change at an unchanged version must reach a provisioned host; \
             skipped={:?}",
            out.skipped
        );
        assert_eq!(read(&f), "def check(): assert _chunk_grid  # fixed\n");

        // …and it converges: the next boot is back on the fast path.
        assert_eq!(reconcile(dir, &v1_changed).unwrap().skipped, vec!["_lib"]);
    }

    /// The same property, driven against the REAL embedded seed and the REAL `_lib`,
    /// because the premise is about a SHIPPED package whose version does not track its
    /// contents, not about a fixture.
    ///
    /// Models an already-provisioned host exactly: extract, then make the on-disk copy of
    /// `_lib/conformance.py` the PRE-FIX file that some earlier binary wrote (content
    /// differs, version identical, file present, file set identical) by rewriting both the
    /// file and the digest the manifest recorded for it. Before this change every one of
    /// those signals said "fresh".
    #[test]
    fn the_real_lib_conformance_gate_reaches_a_provisioned_host_without_a_version_bump() {
        let d = TmpDir::new("real-lib-content");
        let dir = d.path();
        let seed = embedded_seed();
        let pkg = seed
            .packages
            .get("_lib")
            .expect("`_lib` is a shipped seed package");
        let (victim, want) = pkg
            .files
            .iter()
            .find(|(rel, _)| rel == Path::new("conformance.py"))
            .expect("`_lib` ships the conformance gate");

        reconcile(dir, &seed).unwrap();
        let on_disk = dir.join("_lib").join(victim);
        assert_eq!(
            &std::fs::read(&on_disk).unwrap(),
            want,
            "control: extracted"
        );

        // Stand in for "the binary that last wrote this shared dir shipped an older
        // conformance gate": stale bytes AND the digest that binary would have recorded.
        let stale = b"# pre-fix conformance gate: no _chunk_grid check\n";
        std::fs::write(&on_disk, stale).unwrap();
        let mut mf = read_seed_manifest(dir);
        {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(stale);
            mf.files
                .get_mut("_lib")
                .expect("digests recorded")
                .insert("conformance.py".to_string(), format!("{:x}", h.finalize()));
        }
        std::fs::write(
            dir.join(SEED_MANIFEST_NAME),
            serde_json::to_string_pretty(&mf).unwrap(),
        )
        .unwrap();

        let out = reconcile(dir, &seed).unwrap();
        assert!(
            out.repaired.contains(&"_lib".to_string()),
            "the conformance gate this binary ships must land on a host that already has \
             an older one at the same version. repaired={:?} skipped={:?}",
            out.repaired,
            out.skipped
        );
        assert_eq!(
            &std::fs::read(&on_disk).unwrap(),
            want,
            "…with THIS binary's bytes"
        );
        // NEGATIVE CONTROL: exactly the desynced package was touched. A repair that
        // re-asserted the whole seed would satisfy the assertions above while rewriting
        // every package on the box.
        assert_eq!(out.repaired, vec!["_lib".to_string()]);
        assert_eq!(out.skipped.len(), seed.packages.len() - 1);
    }

    /// A `.seed-manifest.json` written before the `files` digest map existed must not
    /// leave that host stale for one more generation — the failure mode this whole line of
    /// work is about. POSITIVE: a legacy manifest re-asserts once. NEGATIVE: having done
    /// so, the very next boot is back on the fast path (it does not re-assert forever).
    #[test]
    fn a_legacy_manifest_without_digests_re_asserts_exactly_once() {
        let d = TmpDir::new("legacy-manifest");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[("manifest.yaml", "v1"), ("compute/run.py", "A")],
        );
        reconcile(dir, &v1).unwrap();

        // Rewrite the manifest in the OLD shape (no `files` key at all) and leave stale
        // content behind, exactly as a pre-digest binary would have.
        std::fs::write(dir.join("qc/compute/run.py"), "STALE").unwrap();
        std::fs::write(
            dir.join(SEED_MANIFEST_NAME),
            r#"{"packages":{"qc":"0.1.0"}}"#,
        )
        .unwrap();

        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(
            out.repaired,
            vec!["qc"],
            "legacy manifest → one-time re-assert"
        );
        assert_eq!(read(&dir.join("qc/compute/run.py")), "A");

        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.skipped, vec!["qc"], "…and exactly once");
    }

    // =================================================================================
    // FINDING 4 — the repair must not destroy what the contract says it preserves.
    // =================================================================================

    /// The gap in the previous negative control, stated plainly: it only covered the
    /// COMPLETE package, i.e. the branch on which the repair cannot fire. This covers the
    /// branch on which it DOES.
    ///
    /// The old repair answered "one file is missing" with `remove_dir_all` +
    /// `rename` — reverting every user edit in the package and deleting every file the
    /// user had created inside it, directly beneath a docstring explaining that the check
    /// avoided content comparison *in order to* preserve those edits.
    #[test]
    fn a_repair_restores_only_what_is_broken_and_keeps_user_edits_and_user_files() {
        let d = TmpDir::new("surgical");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[
                ("manifest.yaml", "v1"),
                ("compute/run.py", "SEED RUN"),
                ("compute/util.py", "SEED UTIL"),
            ],
        );
        reconcile(dir, &v1).unwrap();

        // A user (a) edits a seed-owned file, (b) creates their own file inside the
        // package dir, and (c) one seed file goes missing — the repair trigger.
        std::fs::write(dir.join("qc/compute/util.py"), "USER EDIT").unwrap();
        std::fs::write(dir.join("qc/my-notes.txt"), "USER FILE").unwrap();
        std::fs::remove_file(dir.join("qc/compute/run.py")).unwrap();

        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(
            out.repaired,
            vec!["qc"],
            "the repair FIRES — this is that branch"
        );
        assert_eq!(
            read(&dir.join("qc/compute/run.py")),
            "SEED RUN",
            "the broken file is restored"
        );
        assert_eq!(
            read(&dir.join("qc/compute/util.py")),
            "USER EDIT",
            "a user edit to a file the SEED did not change survives a repair — the \
             contract the whole-package remove_dir_all+rename silently broke"
        );
        assert_eq!(
            read(&dir.join("qc/my-notes.txt")),
            "USER FILE",
            "and a file the user created inside the package dir is not deleted"
        );
    }

    /// The complement, with the contract NARROWED rather than pretended: a seed VERSION
    /// BUMP is wholesale, so nothing in the package dir survives it. Pinned so the
    /// docstring on [`extract_package`] and the code cannot drift apart, and so anyone
    /// widening the guarantee has to change a test that says why.
    #[test]
    fn a_version_bump_is_wholesale_and_takes_user_files_with_it() {
        let d = TmpDir::new("bump-wholesale");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[("manifest.yaml", "v1"), ("compute/run.py", "A")],
        );
        reconcile(dir, &v1).unwrap();
        std::fs::write(dir.join("qc/compute/run.py"), "USER EDIT").unwrap();
        std::fs::write(dir.join("qc/my-notes.txt"), "USER FILE").unwrap();

        let v2 = seed_files(
            "qc",
            "0.2.0",
            &[("manifest.yaml", "v2"), ("compute/run.py", "B")],
        );
        let out = reconcile(dir, &v2).unwrap();
        assert_eq!(out.overwritten, vec!["qc"]);
        assert_eq!(
            read(&dir.join("qc/compute/run.py")),
            "B",
            "seed-version-wins"
        );
        assert!(
            !dir.join("qc/my-notes.txt").exists(),
            "documented and deliberate: a version bump REPLACES the package directory, so \
             a user-created file inside it does not survive. Customize by copying to a NEW \
             package id"
        );
    }

    /// A file a PREVIOUS extraction wrote that the seed no longer ships is removed
    /// (positive) — otherwise a retired module keeps satisfying an import that should now
    /// fail loudly. A file the seed NEVER wrote is not (negative) — retirement is bounded
    /// to paths the manifest records as seed-written.
    ///
    /// This covers the RECORDED branch, and only that one: the fixture ships the pyc as a
    /// seed file first, so the digest map names it and retirement can fire. It used to
    /// claim the `__pycache__` a pre-exclusion binary left behind as well — a case it
    /// cannot reach, because such a binary predates the digest map (see
    /// `a_legacy_manifest_retires_the_build_noise_a_pre_digest_binary_left`, which covers
    /// that branch, and which was red until the retirement learned to bound its candidates
    /// without a record).
    #[test]
    fn a_retired_seed_file_is_removed_and_a_user_file_in_the_same_folder_is_not() {
        let d = TmpDir::new("retire");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[
                ("manifest.yaml", "v1"),
                ("compute/run.py", "A"),
                ("compute/__pycache__/run.cpython-310.pyc", "BYTECODE"),
            ],
        );
        reconcile(dir, &v1).unwrap();
        assert!(dir
            .join("qc/compute/__pycache__/run.cpython-310.pyc")
            .is_file());
        std::fs::write(dir.join("qc/compute/mine.py"), "USER FILE").unwrap();

        // Same version, same real content, but the pyc is no longer part of the seed.
        let v1_clean = seed_files(
            "qc",
            "0.1.0",
            &[("manifest.yaml", "v1"), ("compute/run.py", "A")],
        );
        let out = reconcile(dir, &v1_clean).unwrap();
        assert_eq!(out.repaired, vec!["qc"]);
        assert!(
            !dir.join("qc/compute/__pycache__/run.cpython-310.pyc")
                .exists(),
            "a path the seed no longer ships is retired"
        );
        assert_eq!(
            read(&dir.join("qc/compute/mine.py")),
            "USER FILE",
            "…while a path the seed never wrote is untouched, and its folder survives"
        );
        assert_eq!(
            read(&dir.join("qc/compute/run.py")),
            "A",
            "still-shipped file kept"
        );
        assert_eq!(
            reconcile(dir, &v1_clean).unwrap().skipped,
            vec!["qc"],
            "converges"
        );
    }

    /// The LEGACY half of retirement: the one case the retire loop's own docstring names,
    /// and the one case a record-bounded retirement cannot reach.
    ///
    /// [`is_build_noise`] and the recorded digest map landed in the SAME commit, so a
    /// binary that extracted `__pycache__/*.pyc` into a package dir is BY CONSTRUCTION one
    /// that recorded no digests. With retirement skipped whenever nothing is recorded, the
    /// bytecode survived the one-time re-assert — and then survived every boot after it,
    /// because that re-assert records the noise-free embedded set, so nothing ever names
    /// the stale path again. The test above this one asserted this case in prose while its
    /// fixture recorded the pyc as seed-written, i.e. it exercised the branch on which
    /// retirement CAN fire.
    ///
    /// POSITIVE: the leftover bytecode goes, and its now-empty folder with it.
    /// NEGATIVE, on the SAME branch — the one where the fix fires: a user's own module in
    /// that folder is untouched, as is every path the seed still ships.
    /// NEGATIVE, on the other branch: once digests ARE recorded, bytecode the user's own
    /// interpreter wrote is left alone — this is a one-time migration, not a standing
    /// noise-cleaner with a licence to delete inside a package dir.
    #[test]
    fn a_legacy_manifest_retires_the_build_noise_a_pre_digest_binary_left() {
        let d = TmpDir::new("legacy-retire");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[("manifest.yaml", "v1"), ("compute/run.py", "A")],
        );
        reconcile(dir, &v1).unwrap();

        // Put the dir into the state a PRE-DIGEST binary left it in: the bytecode it also
        // extracted (it had no exclusion rule), a user's own module beside it, and a
        // manifest in the old shape — `packages` only, no `files` key at all.
        let pyc = dir.join("qc/compute/__pycache__/run.cpython-310.pyc");
        std::fs::create_dir_all(pyc.parent().unwrap()).unwrap();
        std::fs::write(&pyc, "BYTECODE").unwrap();
        std::fs::write(dir.join("qc/compute/mine.py"), "USER FILE").unwrap();
        std::fs::write(
            dir.join(SEED_MANIFEST_NAME),
            r#"{"packages":{"qc":"0.1.0"}}"#,
        )
        .unwrap();

        let out = reconcile(dir, &v1).unwrap();
        assert_eq!(out.repaired, vec!["qc"], "the legacy re-assert fires");
        assert!(
            !pyc.exists(),
            "a path a pre-digest binary extracted and the seed does not ship must be \
             retired — this is the case the retirement exists for, and the one a \
             record-bounded candidate list skips entirely"
        );
        assert!(
            !dir.join("qc/compute/__pycache__").exists(),
            "…and the folder it lived in is pruned once empty"
        );
        assert_eq!(
            read(&dir.join("qc/compute/mine.py")),
            "USER FILE",
            "NEGATIVE, same branch: a user's own module in that folder is not a \
             retirement candidate"
        );
        assert_eq!(read(&dir.join("qc/compute/run.py")), "A", "still shipped");
        assert_eq!(
            reconcile(dir, &v1).unwrap().skipped,
            vec!["qc"],
            "converges: the migration happens once"
        );

        // NEGATIVE, other branch: digests are recorded now, so bytecode written by the
        // USER's own interpreter is nothing to do with the seed and stays put.
        std::fs::create_dir_all(dir.join("qc/compute/__pycache__")).unwrap();
        std::fs::write(
            dir.join("qc/compute/__pycache__/mine.cpython-310.pyc"),
            "OWN",
        )
        .unwrap();
        assert_eq!(reconcile(dir, &v1).unwrap().skipped, vec!["qc"]);
        assert_eq!(
            read(&dir.join("qc/compute/__pycache__/mine.cpython-310.pyc")),
            "OWN",
            "with a record to bound it, retirement is bounded by that record"
        );
    }

    /// A repair that dies part-way must not strand a temp file where nothing will ever
    /// reclaim it.
    ///
    /// [`reconcile`]'s startup reclamation matches TOP-LEVEL `.*.tmp-*` DIRECTORIES.
    /// `apply_repair` wrote its temp beside the destination — i.e. INSIDE the live package
    /// dir, a path that sweep does not match, that is in neither the seed's file list nor
    /// the recorded digest map, and that therefore survives inside a package which then
    /// reports complete on every subsequent boot.
    ///
    /// The crash is MODELLED rather than planted: one destination is made un-renameable (a
    /// directory where the file belongs), so the temp left behind is the one the CODE
    /// chose, at whatever path the code chooses — a test that planted the orphan itself
    /// would be asserting its own spelling.
    #[test]
    fn a_repair_that_fails_part_way_strands_no_temp_the_next_reconcile_cannot_reclaim() {
        let d = TmpDir::new("orphan-temp");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[
                ("manifest.yaml", "v1"),
                ("compute/run.py", "A"),
                ("compute/util.py", "U"),
            ],
        );
        reconcile(dir, &v1).unwrap();
        std::fs::write(dir.join("qc/my-notes.txt"), "USER FILE").unwrap();

        let converged = set_of(&[
            ".seed-manifest.json",
            "qc/manifest.yaml",
            "qc/compute/run.py",
            "qc/compute/util.py",
            "qc/my-notes.txt",
        ]);
        assert_eq!(
            all_files_under(dir),
            converged,
            "control: a clean starting point"
        );

        // Same version, changed bytes → a repair is planned for both compute files. Block
        // the second: rename(2) cannot replace a directory with a file, so `apply_repair`
        // fails AFTER it has already created that file's temp.
        let v1b = seed_files(
            "qc",
            "0.1.0",
            &[
                ("manifest.yaml", "v1"),
                ("compute/run.py", "A2"),
                ("compute/util.py", "U2"),
            ],
        );
        std::fs::remove_file(dir.join("qc/compute/util.py")).unwrap();
        std::fs::create_dir(dir.join("qc/compute/util.py")).unwrap();
        assert!(
            reconcile(dir, &v1b).is_err(),
            "control: the repair really did fail part-way"
        );
        let stranded: Vec<String> = all_files_under(dir)
            .difference(&converged)
            .cloned()
            .collect();
        assert!(
            !stranded.is_empty(),
            "control: …and it really did leave a temp file behind"
        );

        // Unblock and let the next boot finish the job.
        std::fs::remove_dir(dir.join("qc/compute/util.py")).unwrap();
        let out = reconcile(dir, &v1b).unwrap();
        assert_eq!(out.repaired, vec!["qc"]);
        assert_eq!(read(&dir.join("qc/compute/util.py")), "U2");
        assert_eq!(read(&dir.join("qc/compute/run.py")), "A2");
        assert_eq!(
            read(&dir.join("qc/my-notes.txt")),
            "USER FILE",
            "reclamation takes temps, never a user's file"
        );
        assert_eq!(
            all_files_under(dir),
            converged,
            "the processors dir holds exactly the seed's paths, the user's file and the \
             manifest — a temp a crashed repair stranded is gone, wherever it was written. \
             Stranded by the failed run: {stranded:?}"
        );
    }

    /// A manifest whose recorded path escapes the package dir must not be followed — the
    /// manifest is a file on disk and [`plan_repair`]'s retirement list is a delete list.
    #[test]
    fn a_manifest_path_that_escapes_the_package_dir_is_never_retired() {
        assert!(!is_safe_relative(Path::new("../../etc/passwd")));
        assert!(!is_safe_relative(Path::new("/etc/passwd")));
        assert!(!is_safe_relative(Path::new("compute/../../x")));
        assert!(!is_safe_relative(Path::new("")));
        assert!(is_safe_relative(Path::new("compute/run.py")));

        let d = TmpDir::new("escape");
        let dir = d.path();
        let v1 = seed_files("qc", "0.1.0", &[("manifest.yaml", "v1")]);
        reconcile(dir, &v1).unwrap();
        let outside = dir.join("victim.txt");
        std::fs::write(&outside, "DO NOT DELETE").unwrap();

        let mut mf = read_seed_manifest(dir);
        mf.files
            .get_mut("qc")
            .unwrap()
            .insert("../victim.txt".to_string(), "deadbeef".to_string());
        std::fs::write(
            dir.join(SEED_MANIFEST_NAME),
            serde_json::to_string_pretty(&mf).unwrap(),
        )
        .unwrap();

        reconcile(dir, &v1).unwrap();
        assert!(
            outside.is_file(),
            "traversal in the manifest is not followed"
        );
    }

    // =================================================================================
    // An operation that FAILED must never be recorded as one that happened. The record
    // is what makes a failure permanent: every fast path in this module compares the
    // embed against the RECORDED embed, never against disk, so a manifest describing
    // content nobody installed matches on every later boot and repairs nothing.
    // =================================================================================

    /// An extraction that could not install its bytes must not be recorded as one that
    /// did — and the boot after it must repair rather than skip.
    ///
    /// [`extract_package`] clears the old package dir and renames the staged one into
    /// place. When the clearing FAILS the old directory is still standing when the rename
    /// runs, so the rename fails too — and the code asked `final_dir.is_dir()` and read
    /// the answer as "a concurrent process won the race with a byte-identical copy". It
    /// returned `Ok(())`, so [`reconcile`] recorded the new version AND the new per-file
    /// digests for content on no disk anywhere; the same-version fast path then matched
    /// forever, and the package stayed stale behind a manifest asserting it was current.
    ///
    /// The failure is FORCED, never planted: dropping write permission on the package dir
    /// is a real cause of a real removal failure (`remove_dir_all` cannot unlink the
    /// children of a directory it may not write), so the arm taken, the temp left behind
    /// and the error text are the ones the CODE chooses.
    ///
    /// What that exposed, and what the assertions below are therefore shaped around:
    /// `remove_dir_all` is not atomic either. It gets as far as it can before the refusal,
    /// so the package it could not replace is left PARTIALLY deleted, in a state no record
    /// anywhere describes. Which files survive is up to a traversal order nothing
    /// promises, so nothing here asserts on that; what is asserted is that the MANIFEST
    /// did not move, because that is the only thing standing between a package in an
    /// unknown state and a fast path that skips it forever.
    #[cfg(unix)]
    #[test]
    fn a_failed_extraction_is_reported_and_never_recorded_as_installed() {
        use std::os::unix::fs::PermissionsExt;
        let d = TmpDir::new("failed-extract");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[("manifest.yaml", "v1"), ("compute/run.py", "A")],
        );
        reconcile(dir, &v1).unwrap();

        let pkg = dir.join("qc");
        let manifest_before = read(&dir.join(SEED_MANIFEST_NAME));
        std::fs::write(pkg.join("probe.tmp"), "x").unwrap();
        std::fs::set_permissions(&pkg, std::fs::Permissions::from_mode(0o555)).unwrap();
        // PRECONDITION, asserted rather than assumed: mode bits do not apply to uid 0, and
        // a test that passes because its trigger never fired is worse than no test. The
        // probe is a file of the test's own, so a run that CAN unlink here has not also
        // quietly altered the package.
        assert!(
            std::fs::remove_file(pkg.join("probe.tmp")).is_err(),
            "this test needs an unlink that is genuinely refused — run the suite as a \
             non-root user"
        );

        // A version bump takes the wholesale-extract arm, which is where the rename is.
        let v2 = seed_files(
            "qc",
            "0.2.0",
            &[("manifest.yaml", "v2"), ("compute/run.py", "B")],
        );
        let first = reconcile(dir, &v2);
        let second = reconcile(dir, &v2);
        // Restored before asserting, so a failing assertion cannot also leak the dir.
        std::fs::set_permissions(&pkg, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = first.unwrap_err();
        assert!(err.contains("qc"), "the failure names the package: {err}");
        assert!(
            second.is_err(),
            "…and it does not go quiet on the next boot: while the cause persists every \
             boot says so, instead of the fast path resuming over a package that was \
             never written"
        );

        let mf = read_seed_manifest(dir);
        assert_eq!(
            mf.packages.get("qc").map(String::as_str),
            Some("0.1.0"),
            "an extraction that installed nothing must not be recorded as installed"
        );
        assert_eq!(
            mf.files["qc"]["compute/run.py"],
            digest_of(b"A"),
            "…and no more must its per-file digests, which are what every later boot \
             compares the embed against"
        );
        // NEGATIVE CONTROL, on the branch where the fix FIRES: the failing run recorded
        // NOTHING — not the new version, not a narrower version of it, not a digest. The
        // manifest is byte-for-byte the one that was there before.
        assert_eq!(
            read(&dir.join(SEED_MANIFEST_NAME)),
            manifest_before,
            "a run that failed part-way through a package must leave the record alone"
        );
        assert_eq!(
            read(&dir.join("qc/manifest.yaml")),
            "v1",
            "the file carrying the package's own version is still the old one, which is \
             what the record says"
        );

        // …and with the cause removed, the very next reconcile installs the new version —
        // ALL of it, not only the files the partial removal happened to take with it. On
        // the false-Ok path this is the assertion that stays red forever: the same-version
        // fast path would find `manifest.yaml` present, with a recorded digest equal to
        // the embedded one it was never actually written from.
        let out = reconcile(dir, &v2).unwrap();
        assert_eq!(
            out.overwritten,
            vec!["qc"],
            "the next boot REPAIRS rather than skipping; skipped={:?} repaired={:?}",
            out.skipped,
            out.repaired
        );
        assert_eq!(read(&dir.join("qc/manifest.yaml")), "v2");
        assert_eq!(read(&dir.join("qc/compute/run.py")), "B");
        assert_eq!(
            all_files_under(dir),
            set_of(&[
                ".seed-manifest.json",
                "qc/manifest.yaml",
                "qc/compute/run.py"
            ]),
            "and the two failed runs stranded nothing the sweep could not reclaim"
        );
    }

    /// A repair must not write into, or delete out of, a tree that merely has a LINK
    /// pointing at it from the processors dir.
    ///
    /// [`is_safe_relative`] bounded the relative half of every path a repair touches;
    /// nothing bounded the directory half, so a package directory replaced by a link into
    /// a user's own checkout turned a repair into an overwrite of that checkout and a
    /// retirement into a delete inside it — under a docstring promising neither. The
    /// pruning loop's lexical `starts_with` cannot see it: the path stays inside the
    /// package dir on paper the whole time it is landing somewhere else.
    #[cfg(unix)]
    #[test]
    fn a_repair_never_writes_or_deletes_through_a_symlinked_package_dir() {
        let d = TmpDir::new("symlinked-pkg");
        let dir = d.path();
        // The user's own tree, deliberately OUTSIDE the processors dir.
        let user = TmpDir::new("symlinked-pkg-checkout");
        let target = user.path().join("qc");

        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[
                ("manifest.yaml", "v1"),
                ("compute/run.py", "A"),
                ("compute/retired.py", "R"),
            ],
        );
        reconcile(dir, &v1).unwrap();

        // Swap the extracted directory for a link into that tree, which holds the SAME
        // paths — which is what makes the package look repairable rather than missing.
        std::fs::create_dir_all(target.join("compute")).unwrap();
        std::fs::write(target.join("manifest.yaml"), "USER").unwrap();
        std::fs::write(target.join("compute/run.py"), "USER RUN").unwrap();
        std::fs::write(target.join("compute/retired.py"), "USER RETIRED").unwrap();
        std::fs::remove_dir_all(dir.join("qc")).unwrap();
        std::os::unix::fs::symlink(&target, dir.join("qc")).unwrap();

        // Same version, one file's bytes changed and one dropped from the seed → the plan
        // carries BOTH a write and a retirement, i.e. both of the operations that would
        // otherwise land in the user's tree.
        let v1b = seed_files(
            "qc",
            "0.1.0",
            &[("manifest.yaml", "v1"), ("compute/run.py", "A2")],
        );
        let err = reconcile(dir, &v1b).unwrap_err();
        assert!(
            err.contains("qc") && err.contains("symlink"),
            "the refusal names the package and the reason: {err}"
        );
        assert_eq!(
            read(&target.join("compute/run.py")),
            "USER RUN",
            "no write through the link"
        );
        assert_eq!(
            read(&target.join("compute/retired.py")),
            "USER RETIRED",
            "no delete through the link"
        );
        assert_eq!(read(&target.join("manifest.yaml")), "USER");
        assert_eq!(
            read_seed_manifest(dir).files["qc"]["compute/retired.py"],
            digest_of(b"R"),
            "a repair that did not happen is not recorded as done — the retired path is \
             still named, so a later boot still tries"
        );

        // NEGATIVE CONTROL, on the branch where the guard FIRES: put a REAL directory back
        // in the identical state and the identical reconcile DOES write and DOES retire.
        // The plan was never empty; the link is what stopped it.
        std::fs::remove_file(dir.join("qc")).unwrap();
        std::fs::create_dir_all(dir.join("qc/compute")).unwrap();
        std::fs::write(dir.join("qc/manifest.yaml"), "v1").unwrap();
        std::fs::write(dir.join("qc/compute/run.py"), "A").unwrap();
        std::fs::write(dir.join("qc/compute/retired.py"), "R").unwrap();
        let out = reconcile(dir, &v1b).unwrap();
        assert_eq!(out.repaired, vec!["qc"]);
        assert_eq!(read(&dir.join("qc/compute/run.py")), "A2");
        assert!(!dir.join("qc/compute/retired.py").exists());
    }

    /// A retirement that could not delete is [`extract_package`]'s failure shape one
    /// function over: swallowed by `let _ =`, so `apply_repair` returned `Ok(())` and the
    /// manifest write that follows a completed repair dropped the retired path from the
    /// digest map. The RECORDED branch of [`plan_repair`] draws its candidates from
    /// exactly that map, so nothing ever named the path again — the module stayed on disk
    /// forever, still satisfying the import the retirement exists to break.
    #[cfg(unix)]
    #[test]
    fn a_retirement_that_cannot_delete_is_reported_rather_than_recorded_as_done() {
        use std::os::unix::fs::PermissionsExt;
        let d = TmpDir::new("retire-blocked");
        let dir = d.path();
        let v1 = seed_files(
            "qc",
            "0.1.0",
            &[
                ("manifest.yaml", "v1"),
                ("compute/run.py", "A"),
                ("compute/retired.py", "R"),
            ],
        );
        reconcile(dir, &v1).unwrap();
        std::fs::write(dir.join("qc/compute/mine.py"), "USER FILE").unwrap();

        // The seed stops shipping `compute/retired.py`, and the unlink that retires it is
        // refused — a directory whose children may not be unlinked is a real cause.
        let v1b = seed_files(
            "qc",
            "0.1.0",
            &[("manifest.yaml", "v1"), ("compute/run.py", "A")],
        );
        let compute = dir.join("qc/compute");
        std::fs::write(compute.join("probe.tmp"), "x").unwrap();
        std::fs::set_permissions(&compute, std::fs::Permissions::from_mode(0o555)).unwrap();
        assert!(
            std::fs::remove_file(compute.join("probe.tmp")).is_err(),
            "this test needs an unlink that is genuinely refused — run the suite as a \
             non-root user"
        );

        let first = reconcile(dir, &v1b);
        let second = reconcile(dir, &v1b);
        std::fs::set_permissions(&compute, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = first.unwrap_err();
        assert!(
            err.contains("qc") && err.contains("retired.py"),
            "the failure names the package and the file: {err}"
        );
        assert!(second.is_err(), "…and does not go quiet on the next boot");
        assert_eq!(
            read_seed_manifest(dir).files["qc"]["compute/retired.py"],
            digest_of(b"R"),
            "the path is still recorded as seed-written, which is the ONLY thing that \
             makes a later boot name it again"
        );
        // NEGATIVE CONTROL, on the branch where the fix FIRES: refusing is not deleting
        // something else instead, and the write half of the same plan is unharmed.
        assert!(compute.join("retired.py").is_file());
        assert_eq!(read(&compute.join("run.py")), "A");
        assert_eq!(read(&compute.join("mine.py")), "USER FILE");

        // With the cause removed the retirement completes — and only then is it recorded.
        let out = reconcile(dir, &v1b).unwrap();
        assert_eq!(out.repaired, vec!["qc"]);
        assert!(!compute.join("retired.py").exists());
        assert!(
            !read_seed_manifest(dir).files["qc"].contains_key("compute/retired.py"),
            "recorded once, and only once, it is true"
        );
        assert_eq!(read(&compute.join("mine.py")), "USER FILE");
        assert_eq!(
            reconcile(dir, &v1b).unwrap().skipped,
            vec!["qc"],
            "converges"
        );
    }

    // =================================================================================
    // Build noise must not be part of the seed at all.
    // =================================================================================

    #[test]
    fn build_noise_is_classified_by_path_not_by_luck() {
        assert!(is_build_noise(Path::new("__pycache__/x.cpython-310.pyc")));
        assert!(is_build_noise(Path::new("compute/__pycache__/x.pyc")));
        assert!(is_build_noise(Path::new(".pytest_cache/v/cache/nodeids")));
        assert!(is_build_noise(Path::new("a/b/.mypy_cache/c")));
        assert!(is_build_noise(Path::new("compute/run.pyc")));
        assert!(is_build_noise(Path::new("compute/run.pyo")));
        // NEGATIVE: real content, including files that merely LOOK adjacent.
        assert!(!is_build_noise(Path::new("compute/run.py")));
        assert!(!is_build_noise(Path::new("manifest.yaml")));
        assert!(!is_build_noise(Path::new(".gitignore")));
        assert!(!is_build_noise(Path::new("pycache_notes.py")));
        assert!(!is_build_noise(Path::new("tests/test_pytest_cache.py")));
    }

    /// `include_dir!` walks the FILESYSTEM, not git, so a developer's local `pytest` run
    /// puts `__pycache__` into the binary. On the host this was written on that was 44 of
    /// 102 embedded files (16 of `_lib`'s 29) — build noise that makes the embedded set,
    /// and every reconcile decision derived from it, a function of which test suites the
    /// build host happened to run. Two build hosts then each see files "missing" that the
    /// other's bytecode set contains, and re-extract over each other indefinitely.
    #[test]
    fn the_real_seed_contains_no_build_noise() {
        let s = embedded_seed();
        // Asserted on the literal path text, NOT by calling `is_build_noise` — a test that
        // classifies with the same predicate the code under test uses passes for free the
        // moment that predicate is wrong, which is the one case it exists to catch.
        // (Verified: neutering `is_build_noise` leaves this test red.)
        let offenders: Vec<String> = s
            .packages
            .iter()
            .flat_map(|(id, pkg)| {
                pkg.files
                    .iter()
                    .map(move |(rel, _)| format!("{id}/{}", rel.display()))
            })
            .filter(|p| {
                p.contains("__pycache__")
                    || p.contains(".pytest_cache")
                    || p.contains(".mypy_cache")
                    || p.contains(".ruff_cache")
                    || p.ends_with(".pyc")
                    || p.ends_with(".pyo")
            })
            .collect();
        assert!(
            offenders.is_empty(),
            "the seed must be a function of the SOURCE tree, not of what the build host \
             happened to run: {offenders:?}"
        );
        // NEGATIVE CONTROL: the filter did not simply empty the seed.
        assert!(s.packages.contains_key("_lib"));
        let lib = &s.packages["_lib"];
        for want in ["manifest.yaml", "conformance.py", "txr_zarr.py"] {
            assert!(
                lib.files.iter().any(|(rel, _)| rel == Path::new(want)),
                "`_lib` still ships {want}"
            );
        }
    }

    /// Reconcile runs at EVERY boot, so the digest is a cost, not a free lunch. Measured
    /// rather than estimated, on the real seed, for the two paths that matter: the
    /// fully-fresh first extraction and the steady-state skip. Printed with `--nocapture`;
    /// the assertion is a loose ceiling that only fires if the cost changes by an order of
    /// magnitude, so this reports rather than flakes.
    ///
    /// Measured on the box this was written on — 10 packages / 58 files / ~1.1 MB (the
    /// byte figure moves as `_lib` is edited; the file count and the timings do not):
    ///
    /// | build | hash-only | first extract | steady-state reconcile |
    /// |---|---|---|---|
    /// | dev (this test) | ~33 ms | ~38 ms | ~33 ms |
    /// | release (what ships) | **~0.6 ms** | — | — |
    ///
    /// The 55× gap is the whole story of the dev number: the workspace sets no
    /// `[profile.dev.package."*"]` override, so `sha2` is compiled at `opt-level = 0` and
    /// never reaches its SHA-NI path. The shipped cost of making content-change detection
    /// derived rather than hand-maintained is **sub-millisecond, once per process**
    /// (`ensure_extracted` is behind a `OnceCell`). Hashing reads the binary's static
    /// data, not the disk, so it adds no I/O; the `stat` per embedded file that
    /// [`disk_missing_files`] already did is unchanged at 58.
    ///
    /// The release figure comes from an optimized micro-benchmark of the same `sha2 0.10`
    /// over the same byte count in the same 58 chunks (100 iterations, 60.1 ms total), not
    /// from scaling the dev number by a guess.
    ///
    /// For contrast, the same measurement with build noise still embedded (the state
    /// before [`is_build_noise`]) was 102 files / 2.30 MB / ~69 ms hash-only — so
    /// excluding `__pycache__` did not merely tidy the tree, it halved this cost.
    #[test]
    fn reconcile_cost_on_the_real_seed_is_reported() {
        let d = TmpDir::new("cost");
        let dir = d.path();
        let seed = embedded_seed();
        let files: usize = seed.packages.values().map(|p| p.files.len()).sum();
        let bytes: usize = seed
            .packages
            .values()
            .flat_map(|p| p.files.iter())
            .map(|(_, b)| b.len())
            .sum();

        let t = std::time::Instant::now();
        let digest_only: BTreeMap<_, _> = seed
            .packages
            .iter()
            .map(|(id, p)| (id.clone(), embedded_digests(p)))
            .collect();
        let hash_us = t.elapsed().as_micros();
        assert_eq!(digest_only.len(), seed.packages.len());

        let t = std::time::Instant::now();
        reconcile(dir, &seed).unwrap();
        let first_ms = t.elapsed().as_millis();

        let t = std::time::Instant::now();
        let out = reconcile(dir, &seed).unwrap();
        let steady_us = t.elapsed().as_micros();
        assert_eq!(
            out.skipped.len(),
            seed.packages.len(),
            "steady state is all-skip"
        );

        eprintln!(
            "COST seed={} packages / {files} files / {bytes} bytes | \
             hash-only {hash_us} us | first extract {first_ms} ms | steady-state reconcile {steady_us} us",
            seed.packages.len()
        );
        assert!(
            steady_us < 500_000,
            "a steady-state boot reconcile took {steady_us} us — if this ever trips, the \
             per-boot cost stopped being negligible and the design needs revisiting"
        );
    }

    // ---- TEST: semver ordering used by seed-version-wins ----
    #[test]
    fn seed_version_wins_semantics() {
        assert!(seed_version_wins("0.2.0", "0.1.0"), "newer minor wins");
        assert!(seed_version_wins("0.1.1", "0.1.0"), "newer patch wins");
        assert!(seed_version_wins("1.0.0", "0.9.9"), "newer major wins");
        assert!(!seed_version_wins("0.1.0", "0.1.0"), "equal is not newer");
        assert!(!seed_version_wins("0.1.0", "0.2.0"), "older does not win");
        // Equal core with padding: 0.1 == 0.1.0.
        assert!(!seed_version_wins("0.1", "0.1.0"), "0.1 == 0.1.0");
        // Unorderable difference → defensive seed-wins.
        assert!(
            seed_version_wins("nightly", "0.1.0"),
            "unparseable mismatch → seed wins"
        );
    }
}
