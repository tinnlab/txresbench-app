//! `rootfs` module — the EMBEDDED analysis-rootfs slot (`include_bytes!`), extracted +
//! squashfuse-mounted on first sandbox use WHEN a non-empty asset was staged.
//!
//! CURRENT STATE: docker is no longer a build dependency of CytoAnalyst, so the embedded
//! slot is an INTENTIONAL, PERMANENT 0-byte stub in normal builds. That is NOT a broken
//! or degraded build and the sandbox does NOT self-disable because of it — the analysis
//! rootfs is lazy-fetched at RUNTIME by [`crate::modules::sandbox::env_image::OciEnvImageProvider`]
//! from `ghcr.io/ziee-ai/cyto-env/<env>:schema<N>-latest-<arch>`, cosign-verified and
//! squashfuse-mounted on the first `run_analysis`. This module's embedded path is the
//! legacy/optional route (and the digest-keyed cache it shares with the OCI provider).
//!
//! Public surface for the `sandbox` module: [`ensure_ready`] (lazy extract +
//! mount, returns the mount dir whose `usr/` bwrap binds read-only) and
//! [`status`] (for the admin UI). Registration exists only to log rootfs
//! availability at boot; the HTTP surface lives in the `sandbox` module.

pub mod cache;
pub mod embedded;
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

use ziee_core::AppError;
use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub use version::ROOTFS_SCHEMA_VERSION;

/// The base app-data directory the sandbox + rootfs write under (rootfs extract,
/// squashfuse mount, per-job workspaces). Resolution order:
///
/// 1. a THREAD-scoped override installed by [`scoped_data_root`] (in-process tests);
/// 2. `CYTO_APP_DATA_DIR` — how the integration harness isolates each test's SERVER
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
    std::env::var_os("CYTO_APP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(ziee_core::app_state::get_app_data_dir)
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
/// The in-process counterpart of the harness's `cmd.env("CYTO_APP_DATA_DIR", …)`, and
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

/// Cached successful mount dir — [`ensure_ready`] mounts once per process.
static READY: OnceCell<PathBuf> = OnceCell::new();

/// Per-digest mount serialization (blind-audit MED). Unlike [`ensure_ready`]
/// (serialized by the single `READY` `OnceCell`), [`ensure_ready_by_digest`]
/// mounts a HISTORICAL rootfs BY DIGEST and has no single init cell — so two
/// concurrent reproduce/verify runs of the SAME digest could both pass
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
    /// Short content hash of the embedded rootfs (empty when it's a stub).
    pub content_version: String,
    /// The FULL sha256 hex digest of the embedded rootfs (the env digest the
    /// provenance layer pins). Empty when it's a stub (ITEM-6, additive).
    pub content_sha256: String,
    /// Size of the embedded rootfs in bytes (0 = stub / not built in).
    pub embedded_bytes: u64,
    /// The build embedded a real (non-stub) rootfs.
    pub supported: bool,
    /// The rootfs has been extracted to the app data dir.
    pub extracted: bool,
    /// The rootfs is currently squashfuse-mounted.
    pub mounted: bool,
}

/// Lazy extract + mount. Returns the mount dir (contains `usr/`, `etc/…`, and the
/// schema marker). Cached after the first success. Errors (stub build, no
/// squashfuse, schema mismatch, non-Linux) are cheap to re-raise.
pub fn ensure_ready() -> Result<PathBuf, AppError> {
    // `get_or_try_init` serializes the extract+mount so only ONE thread ever
    // spawns squashfuse (a plain check-then-act let two concurrent first-runs
    // both spawn, orphaning the first FUSE daemon). On error the cell stays
    // empty so a later call retries. [blind-audit HIGH-2]
    READY
        .get_or_try_init(|| {
            let extracted = embedded::ensure_extracted()?;
            mount::ensure_mounted(&extracted)
        })
        .cloned()
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
    // Serialize concurrent mounts of the SAME digest so only ONE squashfuse is
    // ever spawned for it (blind-audit MED). The lock is held only across the
    // mount; a different digest takes a different lock and proceeds in parallel.
    // The loser wakes to `mount_at`'s fast path (`usr/` present) and returns the
    // same mount dir — no orphaned FUSE daemon.
    let lock = digest_mount_lock(digest);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    mount::mount_at(
        &cache::squashfs_path_for(digest),
        &cache::digest_dir(digest).join("mnt"),
        false,
    )
}

/// Current rootfs status (never errors — reports availability instead).
pub fn status() -> RootfsStatus {
    // The extraction cache is content-digest-keyed now (ITEM-22), so probe the
    // embedded digest's dir rather than a schema-keyed one.
    let digest = embedded::content_sha256_full();
    let dir = cache::digest_dir(&digest);
    let extracted = !digest.is_empty() && cache::has_digest(&digest);
    RootfsStatus {
        schema_version: ROOTFS_SCHEMA_VERSION,
        content_version: embedded::content_version(),
        content_sha256: digest,
        embedded_bytes: embedded::embedded_len() as u64,
        supported: embedded::is_supported(),
        extracted,
        mounted: extracted && mount::is_mounted(&dir),
    }
}

/// Tear down the squashfuse mount (best-effort; PDEATHSIG is the real backstop).
pub fn shutdown() {
    mount::teardown();
}

/// The content-digest cache as the reproducibility-readiness obtainability check
/// (ITEM-22 / DEC-32): a run's PINNED `env_rootfs_sha256` is obtainable here iff
/// its squashfs is present in the local digest-keyed cache. Installed into the
/// `provenance` seam at `init` so `readiness.env_pinned` reflects the WHOLE cache
/// (every extracted/served/operator-placed digest), not just the embedded one.
struct RootfsCacheObtain;

impl crate::modules::provenance::env_obtain::RootfsObtainability for RootfsCacheObtain {
    fn has_digest(&self, digest: &str) -> bool {
        // The pinned digest is stored bare (lowercase hex), but tolerate a
        // `sha256:` scheme prefix defensively (the seam contract): `cache::has_digest`
        // requires a bare 64-char hex, so normalize before delegating.
        let bare = crate::modules::provenance::env_obtain::normalize_digest(digest);
        cache::has_digest(&bare)
    }
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
        let s = status();
        if s.supported {
            tracing::info!(
                schema = s.schema_version,
                content = %s.content_version,
                bytes = s.embedded_bytes,
                "rootfs: embedded analysis rootfs present (lazy-mounts on first use)"
            );
        } else {
            // NOT a warning: docker was removed as a build dependency, so the embedded
            // slot is a 0-byte stub BY DESIGN in normal builds. The sandbox stays enabled —
            // the analysis rootfs is lazy-fetched over OCI on the first `run_analysis`.
            tracing::info!(
                "rootfs: no embedded analysis rootfs — the embedded slot is a 0-byte stub by \
                 design (docker is not a build dependency). The sandbox is NOT disabled: the \
                 analysis rootfs is lazy-fetched at runtime from \
                 ghcr.io/ziee-ai/cyto-env/<env>:schema<N>-latest-<arch>, cosign-verified and \
                 squashfuse-mounted on the first run_analysis"
            );
        }
        // Wire the digest-keyed cache into the provenance reproducibility-readiness
        // obtainability seam (ITEM-22 / DEC-32). Without this, `readiness.env_pinned`
        // falls back to "only the embedded digest is obtainable"; with it, any digest
        // present in the local cache (extracted / served / operator-placed) reports
        // obtainable. Idempotent (`OnceLock::set`).
        crate::modules::provenance::env_obtain::install_rootfs_obtainability(
            std::sync::Arc::new(RootfsCacheObtain),
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
mod obtainability_tests {
    use super::*;
    use crate::modules::provenance::env_obtain::{self, RootfsObtainability};

    // FIX 3 (ITEM-22 / DEC-32): the cache-backed obtainability seam reports a
    // digest obtainable exactly when its squashfs is present in the local cache,
    // tolerates a `sha256:` prefix, and — after install — drives the process-wide
    // `is_env_obtainable` check the provenance readiness layer consults.
    #[test]
    fn cache_obtainability_reports_cached_digest() {
        // A unique, valid (64-char lowercase hex) digest so this never collides
        // with a real cached rootfs and needs no shared-dir isolation.
        let digest = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let seam = RootfsCacheObtain;
        // Un-cached → not obtainable.
        assert!(!seam.has_digest(&digest), "an un-cached digest is not obtainable");

        // Place a non-empty squashfs at the digest's cache path → now obtainable.
        let path = cache::squashfs_path_for(&digest);
        std::fs::create_dir_all(path.parent().unwrap()).expect("mk digest dir");
        std::fs::write(&path, b"squashfs-bytes").expect("write squashfs");
        assert!(seam.has_digest(&digest), "a cached digest is obtainable");
        // The seam tolerates a `sha256:` scheme prefix (stored key is bare hex).
        assert!(
            seam.has_digest(&format!("sha256:{digest}")),
            "sha256: scheme prefix is tolerated"
        );

        // Installing it wires the provenance readiness obtainability check to the
        // cache (idempotent) — the cached digest now reports obtainable process-wide.
        env_obtain::install_rootfs_obtainability(std::sync::Arc::new(RootfsCacheObtain));
        assert!(
            env_obtain::is_env_obtainable(Some(&digest)),
            "after install, the process-wide check reports the cached digest obtainable"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}

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
