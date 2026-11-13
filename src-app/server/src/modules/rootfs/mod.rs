//! `rootfs` module — the content-digest squashfs cache + mount core the
//! sandbox's environments are staged through.
//!
//! strip-single-cell ITEM-3 (map §1 `rootfs` KEEP (trim)): the EMBEDDED
//! analysis-rootfs slot (`embedded.rs`, the build-time staging stub) and the
//! provenance reproducibility glue (`env_obtain`/`RootfsCacheObtain`) were
//! removed with the single-cell platform. What stays is what the METHOD
//! environments run on: [`data_root`] (the app data root every kept module
//! resolves), the digest-keyed cache (cache.rs), the squashfuse mount core
//! (mount.rs), and [`ensure_ready_by_digest`] — the mount the
//! `sandbox::method_env` manager drives for every base + layer artifact,
//! digest-pinned and byte-verified before it is mounted.
//!
//! `ensure_ready` (the embedded extract+mount path) is gone with the slot; the
//! per-digest mount serialization stays, because by-digest mounts are the only
//! mounts there are now.

pub mod cache;
pub mod mount;
/// Process-lifetime `PR_SET_PDEATHSIG` spawning (Linux-only, like the mount itself).
#[cfg(target_os = "linux")]
pub mod pdeathsig;
pub mod routes;
pub mod version;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use once_cell::sync::OnceCell;
use schemars::JsonSchema;
use serde::Serialize;

use txresbench_core::AppError;
use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub use version::ROOTFS_SCHEMA_VERSION;

/// The base app-data directory the sandbox + rootfs write under (rootfs extract,
/// squashfuse mount, per-job workspaces). Resolution order:
///
/// 1. a THREAD-scoped override installed by [`scoped_data_root`] (in-process tests);
/// 2. `TXR_APP_DATA_DIR` — how the integration harness isolates each test's SERVER
///    SUBPROCESS to its own data dir (`ServerConfig` drops the `app.data_dir` key, so
///    `get_app_data_dir()` alone would collapse every test onto the shared `~/.app`;
///    see SDK_GAPS + DEC-8);
/// 3. the SDK's `get_app_data_dir()` in production/desktop.
pub fn data_root() -> PathBuf {
    // `try_with`, never `with`: a thread-local is already destroyed while that thread's
    // OTHER destructors run, and `with` PANICS there. `data_root` is reachable from a
    // Drop (teardown paths resolve cache dirs), and no override can be installed at
    // that point anyway, so an unavailable slot simply falls through to the env var.
    if let Ok(Some(dir)) = DATA_ROOT_OVERRIDE.try_with(|m| lock_override(m).clone()) {
        return dir;
    }
    std::env::var_os("TXR_APP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(txresbench_core::app_state::get_app_data_dir)
}

thread_local! {
    /// See [`scoped_data_root`]. Thread-scoped precisely so it is invisible to every
    /// other thread — which, under libtest's thread-per-test, means every other test.
    ///
    /// A per-thread `Mutex` rather than the obvious `RefCell`: nothing outside this
    /// thread can reach it, so the lock is never contended and costs a relaxed CAS.
    /// `RefCell` is on the `no-domain-in-builtin` guard's structural suppression
    /// list, but its std MODULE path is not — that bare path segment is exactly the
    /// vocabulary noun the guard exists to catch, and suppressing it would blind the
    /// guard to the real thing.
    static DATA_ROOT_OVERRIDE: std::sync::Mutex<Option<PathBuf>> =
        const { std::sync::Mutex::new(None) };
}

/// Point [`data_root`] at `dir` FOR THE CURRENT THREAD until the returned guard drops.
///
/// The in-process counterpart of the harness's `cmd.env("TXR_APP_DATA_DIR", …)`, and
/// the reason it exists: a test that drives production code IN THIS PROCESS (the OCI
/// env-image end-to-end drives `OciEnvImageProvider::provide` directly) needs an
/// isolated app-data dir, and `set_var` is the wrong tool for it. `set_var` is
/// PROCESS-wide — every sibling test thread reading `data_root()` sees it for as long
/// as the setter runs, and the value outlives the temp dir the test then deletes.
/// A thread-scoped override cannot be observed by a sibling at all, and the guard
/// restores whatever was there before (so nesting/replacement is safe).
///
/// This is a TESTABILITY SEAM in the same class as `cache::list_cached_digests_in`:
/// production never installs one, so production behaviour is byte-identical to
/// reading the env var directly.
#[must_use = "the override is reverted as soon as the guard is dropped"]
pub fn scoped_data_root(dir: impl Into<PathBuf>) -> DataRootGuard {
    let dir = dir.into();
    let previous = DATA_ROOT_OVERRIDE
        .try_with(|m| lock_override(m).replace(dir))
        .expect("scoped_data_root is called from a live test thread, never from a destructor");
    DataRootGuard { previous }
}

/// Take the thread's own override lock. It is only ever taken by the thread that
/// owns it, so it cannot be contended; a poisoned guard is recovered rather than
/// propagated (a panic elsewhere on this thread must not brick `data_root`).
fn lock_override(
    m: &std::sync::Mutex<Option<PathBuf>>,
) -> std::sync::MutexGuard<'_, Option<PathBuf>> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// RAII handle from [`scoped_data_root`] — restores the previous thread-scoped
/// value (usually `None`) on drop, on every exit path including a panic unwind.
pub struct DataRootGuard {
    previous: Option<PathBuf>,
}

impl Drop for DataRootGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        // A thread-local destroyed during thread teardown makes `with` fail; there is
        // nothing left to restore in that case, so ignore it rather than panic in Drop.
        let _ = DATA_ROOT_OVERRIDE.try_with(|m| *lock_override(m) = previous);
    }
}

/// strip-single-cell ITEM-3: the once-per-process embed mount cache
/// (`READY` + `ensure_ready`) was removed with the embedded slot; mounts are
/// now per-digest only ([`DIGEST_MOUNT_LOCKS`]).

/// Per-digest mount serialization (blind-audit MED): [`ensure_ready_by_digest`]
/// mounts an artifact BY DIGEST and has no single init cell — so two
/// concurrent runs of the SAME digest could both pass
/// `mount_at`'s check-then-act probe and each spawn a squashfuse daemon
/// (orphaning one). A per-digest mutex admits only ONE thread into the
/// extract+mount for a given digest; the loser then hits `mount_at`'s fast path
/// (`usr/` already present) and returns the same mount dir. Different digests
/// still mount in parallel.
static DIGEST_MOUNT_LOCKS: OnceCell<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceCell::new();

/// The (interned) per-digest mount lock. Callers hold the returned mutex across
/// the `mount_at` call for that digest.
fn digest_mount_lock(digest: &str) -> Arc<Mutex<()>> {
    let map = DIGEST_MOUNT_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .entry(digest.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Machine-readable rootfs status for the admin UI (`GET /api/sandbox/status`).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RootfsStatus {
    /// Embedded schema version the binary expects.
    pub schema_version: u32,
    /// Short content hash of the embedded rootfs (always empty — the slot is
    /// removed; kept only to preserve the wire shape).
    pub content_version: String,
    /// The FULL sha256 hex digest of the embedded rootfs (always empty — the
    /// slot is removed; kept only to preserve the wire shape).
    pub content_sha256: String,
    /// Size of the embedded rootfs in bytes (0 — the slot is removed).
    pub embedded_bytes: u64,
    /// The build embedded a real (non-stub) rootfs (always false — the slot is
    /// removed).
    pub supported: bool,
    /// The rootfs has been extracted to the app data dir (always false — see
    /// the module doc; the digest cache is the live store).
    pub extracted: bool,
    /// The rootfs is currently squashfuse-mounted (always false — see the
    /// module doc; `GET /api/sandbox/envs` reports per-env mount state).
    pub mounted: bool,
}

/// Mount the rootfs pinned by a run's CONTENT DIGEST (ITEM-22 / DEC-17) and
/// return its mount dir. Used by the in-server verify re-run + a pinned
/// reproduce so they target the EXACT historical rootfs a run recorded, never
/// the currently-embedded one. Reads the content-digest-keyed local cache: the
/// digest must already be present (`cache::has_digest`) — obtained via a prior
/// extraction, the serve endpoint, or an operator-placed file (v1 is
/// deployment-assisted, DEC-32; no remote pull here). The current-schema probe
/// is intentionally NOT enforced: a historical rootfs may be an older schema and
/// is used as-is for byte-faithful reproduction.
pub fn ensure_ready_by_digest(digest: &str) -> Result<PathBuf, AppError> {
    let image = cached_image_by_digest(digest)?;
    // Serialize concurrent mounts of the SAME digest so only ONE squashfuse is
    // ever spawned for it (blind-audit MED). The lock is held only across the
    // mount; a different digest takes a different lock and proceeds in parallel.
    // The loser wakes to `mount_at`'s fast path (`usr/` present) and returns the
    // same mount dir — no orphaned FUSE daemon.
    let lock = digest_mount_lock(digest);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    mount::mount_at(&image, &cache::digest_dir(digest).join("mnt"), false)
}

/// The cached squashfs image for `digest`, WITHOUT mounting it: the digest
/// must be well-formed (`ROOTFS_BAD_DIGEST`, 400) and present in the local
/// cache (`ROOTFS_DIGEST_ABSENT`, 404). [`ensure_ready_by_digest`] mounts the
/// returned image on Linux; the macOS method VM attaches it as a disk instead.
pub fn cached_image_by_digest(digest: &str) -> Result<PathBuf, AppError> {
    if !cache::is_valid_digest(digest) {
        return Err(AppError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "ROOTFS_BAD_DIGEST",
            "a rootfs digest must be a 64-char lowercase hex sha256",
        ));
    }
    if !cache::has_digest(digest) {
        return Err(AppError::new(
            axum::http::StatusCode::NOT_FOUND,
            "ROOTFS_DIGEST_ABSENT",
            format!(
                "rootfs digest {digest} is not present in the local cache; place its \
                 squashfs at {} or obtain it from a running deployment",
                cache::squashfs_path_for(digest).display()
            ),
        ));
    }
    Ok(cache::squashfs_path_for(digest))
}

/// Current rootfs status (never errors — reports availability instead).
///
/// strip-single-cell ITEM-3: the embedded analysis-rootfs slot was removed, so
/// the embedded-fact fields (`content_version`, `content_sha256`,
/// `embedded_bytes`, `supported`, `extracted`, `mounted`) are always the
/// absent-artifact values — the wire shape is kept so the status route's
/// schema does not churn. The live machine facts are the digest cache (per-env
/// download/mount state), which `GET /api/sandbox/envs` reports.
pub fn status() -> RootfsStatus {
    RootfsStatus {
        schema_version: ROOTFS_SCHEMA_VERSION,
        content_version: String::new(),
        content_sha256: String::new(),
        embedded_bytes: 0,
        supported: false,
        extracted: false,
        mounted: false,
    }
}

/// Tear down the squashfuse mount (best-effort; PDEATHSIG is the real backstop).
pub fn shutdown() {
    mount::teardown();
}

pub struct RootfsModule;

impl AppModule for RootfsModule {
    fn name(&self) -> &'static str {
        "rootfs"
    }

    fn description(&self) -> &'static str {
        "Embedded analysis rootfs (docker-built at build time, mounted at runtime)."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // strip-single-cell ITEM-3: the embedded-rootfs log lines and the
        // provenance obtainability install were removed with their arms. The
        // digest cache + mount core this module provides are booted on demand
        // by the sandbox's method-env manager.
        tracing::info!(
            "rootfs: digest cache + mount core ready (method environments mount by pinned digest; no embedded rootfs)"
        );
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // Status is served by the sandbox module; the ONLY route this module
        // owns is the serve-by-digest endpoint (ITEM-22) — a reproducer obtains
        // a run's pinned rootfs squashfs from a running deployment (DEC-32).
        routes::register(router)
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static ROOTFS: ModuleEntry = ModuleEntry {
    name: "rootfs",
    order: 60,
    description: "Embedded analysis rootfs (docker-built + embedded).",
    constructor: || Box::new(RootfsModule),
};

#[cfg(test)]
mod digest_mount_lock_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // blind-audit MED: the per-digest lock returns the SAME mutex for a given
    // digest (concurrent by-digest mounts of it serialize) and a DISTINCT mutex
    // for a different digest (unrelated digests still mount in parallel).
    #[test]
    fn same_digest_shares_one_lock_distinct_digests_dont() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let a1 = digest_mount_lock(&a);
        let a2 = digest_mount_lock(&a);
        let b1 = digest_mount_lock(&b);
        assert!(Arc::ptr_eq(&a1, &a2), "same digest → one shared mount lock");
        assert!(!Arc::ptr_eq(&a1, &b1), "different digests → independent locks");
    }

    // The lock actually serializes: with many threads contending on ONE digest's
    // lock, at most one is ever inside the critical section — so only one thread
    // would run the extract+mount (spawn squashfuse) at a time.
    #[test]
    fn digest_lock_serializes_concurrent_holders() {
        let digest = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let inside = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let d = digest.clone();
            let inside = inside.clone();
            let max_seen = max_seen.clone();
            handles.push(std::thread::spawn(move || {
                for _ in 0..50 {
                    let lock = digest_mount_lock(&d);
                    let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
                    let cur = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(cur, Ordering::SeqCst);
                    std::thread::yield_now();
                    inside.fetch_sub(1, Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            1,
            "the per-digest lock admits exactly one holder at a time"
        );
    }
}
