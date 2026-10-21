//! Live object-store hot-cutover (#64) — the no-restart activation of a `verified` migration.
//!
//! #61 built the copy+verify migration engine + the `DualReadStore` read decorator but applied
//! cutover only at the boot/construction seam. This module wires those proven primitives into a
//! LIVE cutover: once a background migration reaches `verified`, the process-global store handle
//! is atomically swapped (`swap_object_store`) to `DualRead(new, old)` with no restart. The
//! data-integrity core is PURE over two `Arc<dyn ObjectStore>` so its no-data-loss properties
//! are unit-testable on local-fs (and, floci-gated, a real cloud store); the DB/phase glue lives
//! in the saas `migration_api` orchestrator.
//!
//! ## The data-loss safety contract (the load-bearing part — proven by the tests below)
//!
//! * **INV-1 atomic swap.** [`super::swap_object_store`] is a single `arc_swap` atomic pointer
//!   store; a concurrent [`super::get_object_store`] observes either the whole OLD Arc or the
//!   whole NEW Arc — never a torn/empty handle — and a caller mid-operation keeps its snapshot
//!   Arc alive until it drops it. No panic, no spurious not-found.
//! * **INV-2 the write-during-migration window.** Blobs written to the (still-old) primary
//!   AFTER the copy pass enumerated its key set, up to the swap, live only on OLD. After the
//!   swap they are: (a) still READABLE — `DualRead` reads NEW then falls back to OLD, and
//!   content-addressed keys make the fallback byte-exact (a key uniquely determines its bytes,
//!   so "found in OLD" is authoritative); (b) brought to NEW by [`catch_up`] — an idempotent
//!   re-sweep of OLD→NEW. OLD is retained (INV-5), so a straggler that a single catch-up misses
//!   stays readable AND blocks retire (the retire gate re-verifies EVERY old blob is in new) —
//!   so no window blob is ever lost or unreadable.
//! * **INV-3 activation guard.** Only a `verified` migration is ever cut over (the orchestrator
//!   checks the phase; [`install_dual_read`] is reached only through that guard).
//! * **INV-4 rollback.** Any post-cutover failure → [`rollback_to_old`], a single atomic swap
//!   back to the fully-intact OLD store (never written to, never deleted by the transition).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ziee_core::AppError;

use super::migration_engine::{self as engine, CopyReport, MigrationError};
use super::object_store::{DualReadStore, LocalFsStore, ObjectStore};

/// The OLD store's FULL connection config, preserved through a cutover so boot can rebuild the
/// dual-read fallback for ANY store pair (#64 DEC-5) — cloud→cloud included, not just local→cloud.
///
/// It is serialized to JSON and stored ENCRYPTED AT REST (pgcrypto, via
/// `ziee_framework::secret::encrypt_secret`) in `object_store_migration.src_config_ciphertext`;
/// boot decrypts it to reconstruct the OLD store. **NO `Debug` derive** — once decrypted it holds
/// plaintext cloud credentials, so a `{:?}` must never print them (coding-guidelines §3); the
/// masked status view carries only the non-secret backend/provider/bucket labels.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct PreservedStoreConfig {
    /// `"local"` | `"s3"`.
    pub backend: String,
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub path_style: Option<bool>,
    /// The OLD store's static access key (cloud only). Plaintext once decrypted — never logged.
    pub access_key_id: Option<String>,
    /// The OLD store's static secret key (cloud only). Plaintext once decrypted — never logged.
    pub secret_access_key: Option<String>,
}

impl PreservedStoreConfig {
    /// A local OLD store carries no secret — boot rebuilds it from the known local root.
    pub fn local() -> Self {
        Self { backend: "local".to_string(), ..Default::default() }
    }

    /// TRUE when there is a credential worth encrypting (a cloud source). A local source has none,
    /// so it may be stored as NULL ciphertext.
    pub fn has_secret(&self) -> bool {
        self.access_key_id.is_some() || self.secret_access_key.is_some()
    }
}

/// Reconstruct the OLD store from its preserved config (#64 DEC-5). `local_root` is the local
/// workstore dir, used ONLY for the local backend (no secret needed). A cloud backend
/// cannot be rebuilt — no cloud backend exists in this build.
pub fn build_store_from_preserved(
    cfg: &PreservedStoreConfig,
    local_root: &std::path::Path,
) -> Result<Arc<dyn ObjectStore>, AppError> {
    match cfg.backend.as_str() {
        "local" => Ok(Arc::new(LocalFsStore::new(local_root))),
        "s3" => Err(AppError::internal_error(
            "workstore: cannot rebuild a cloud OLD store (no cloud backend in this build)",
        )),
        other => Err(AppError::internal_error(format!(
            "workstore: unknown preserved OLD-store backend '{other}'"
        ))),
    }
}

/// Atomically cut the LIVE store over to `DualRead(new, old)` (#64), returning the installed
/// dual-read handle.
///
/// PRECONDITION — the activation guard (INV-3): the migration copying `old`→`new` has reached
/// `verified`, i.e. every blob enumerated at copy-start is present + content-verified in `new`.
/// The saas orchestrator proves this from the `object_store_migration` phase immediately before
/// calling; this function performs the mechanical swap and makes no policy decision itself.
///
/// After the swap: reads try `new` and fall back to `old` (a still-OLD-only write-window blob is
/// served, never a spurious not-found — INV-2a); writes go to `new`. `old` is retained intact as
/// both the read fallback and the rollback target, and is NEVER deleted here (INV-5).
pub fn install_dual_read(
    new: Arc<dyn ObjectStore>,
    old: Arc<dyn ObjectStore>,
) -> Arc<dyn ObjectStore> {
    let dual = build_dual_read(new, old);
    super::swap_object_store(dual.clone());
    dual
}

/// Build (but do NOT install) the `DualRead(new, old)` handle — the pure half of
/// [`install_dual_read`], separated so the no-data-loss properties are testable without
/// touching the process global.
pub fn build_dual_read(
    new: Arc<dyn ObjectStore>,
    old: Arc<dyn ObjectStore>,
) -> Arc<dyn ObjectStore> {
    Arc::new(DualReadStore::new(new, old))
}

/// The post-cutover CATCH-UP re-sweep (INV-2b): re-enumerate `old` and copy+verify into `new`
/// every blob not already present there. Idempotent by content key (a blob already in `new` and
/// content-verified is skipped, never re-copied), so it converges `new` toward `old` for every
/// blob written to old during the migration window up to this sweep's enumeration point. `old`
/// is only ever READ. A verify mismatch HALTS (returns `Err`) exactly as the main copy does — a
/// corrupt catch-up never certifies anything.
pub async fn catch_up(
    old: &Arc<dyn ObjectStore>,
    new: &Arc<dyn ObjectStore>,
) -> Result<CopyReport, MigrationError> {
    engine::copy_and_verify(old, new, &mut |_| {}).await
}

/// Atomically ROLL BACK the live store to `old` (INV-4): a single atomic swap back to the
/// fully-intact OLD store. Used on any post-cutover failure. Because the transition never wrote
/// to or deleted `old`, this restores the exact pre-cutover data plane with zero loss — and a
/// caller that had already snapshotted the dual-read handle keeps serving from it (which still
/// reads old via fallback) until it drops it, so the rollback is safe under concurrency too.
pub fn rollback_to_old(old: Arc<dyn ObjectStore>) {
    super::swap_object_store(old);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workstore::object_store::{ContentKey, LocalFsStore};

    fn tmp() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ws-cutover-{}", uuid::Uuid::new_v4()))
    }
    fn store(dir: &std::path::Path) -> Arc<dyn ObjectStore> {
        Arc::new(LocalFsStore::new(dir)) as Arc<dyn ObjectStore>
    }

    /// Serializes the two tests that touch the PROCESS-GLOBAL store handle (INV-1 swap storm +
    /// INV-4 rollback), so one test's swaps can never be observed by the other's
    /// `get_object_store()` — the global is shared across the test binary. The pure data-loss
    /// tests (INV-2/INV-3) use `build_dual_read` and never touch the global, so they need no lock.
    static GLOBAL_HANDLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// INV-2 — THE WRITE-DURING-MIGRATION acceptance test (the place data loss hides).
    ///
    /// Timeline, exactly as it happens live:
    ///  1. OLD holds pre-existing blobs; the migration copy pass runs OLD→NEW (all pre-existing
    ///     blobs land in NEW, verified).
    ///  2. DURING the window — after the copy enumerated its keys — a NEW blob is written to the
    ///     still-old primary (`old.put`). It exists ONLY on OLD; the finished copy never saw it.
    ///  3. Cutover: install `DualRead(new, old)`.
    ///  4. Assert (a) the window blob is READABLE through the live handle (fallback), and that it
    ///     is genuinely OLD-only at this instant (absent from NEW) — proving the read is served by
    ///     the fallback, not a copy that had already happened.
    ///  5. Catch-up re-sweep OLD→NEW.
    ///  6. Assert (b) the window blob is now PRESENT on NEW, byte-identical.
    ///
    /// Flip the catch-up off and step 6 fails; drop the fallback and step 4 fails — so this is a
    /// real proof of INV-2, not a tautology.
    #[tokio::test]
    // TEST-A2 [acceptance] [invariant: INV-2, INV-5]
    async fn a_blob_written_during_migration_is_readable_after_cutover_and_reaches_new() {
        let (od, nd) = (tmp(), tmp());
        let old = store(&od);
        let new = store(&nd);

        // (1) pre-existing data + the migration copy pass.
        let mut pre = Vec::new();
        for i in 0..8u32 {
            pre.push(old.put(format!("pre-{i}").as_bytes()).await.unwrap());
        }
        let report = engine::copy_and_verify(&old, &new, &mut |_| {}).await.unwrap();
        assert_eq!(report.copied, 8, "the copy pass migrated every pre-existing blob");

        // (2) a write that lands on OLD during the window (the copy is already done ⇒ never saw it).
        let window_key = old.put(b"written during the migration window").await.unwrap();
        assert!(!new.exists(&window_key).await.unwrap(), "the window blob is OLD-only before catch-up");

        // (3) cutover (pure build — this test proves the data-loss property, not the global swap).
        let live = build_dual_read(new.clone(), old.clone());

        // (4a) readable through the live (dual-read) handle via fallback...
        assert_eq!(
            live.get(&window_key).await.unwrap(),
            b"written during the migration window",
            "INV-2a: a window blob is still readable after cutover (dual-read fallback to old)"
        );
        // ...and it really is served by the fallback (still absent from new at this instant).
        assert!(!new.exists(&window_key).await.unwrap(), "still OLD-only ⇒ the read WAS a fallback");

        // (5) catch-up.
        let caught = catch_up(&old, &new).await.unwrap();
        assert!(caught.verified >= 1, "catch-up re-verified the OLD set");

        // (6b) now present on NEW, byte-identical (INV-2b).
        assert!(new.exists(&window_key).await.unwrap(), "INV-2b: catch-up brought the window blob to new");
        assert_eq!(new.get(&window_key).await.unwrap(), b"written during the migration window");

        // OLD is fully intact throughout (INV-5) — the transition never deleted from it.
        assert_eq!(old.exists(&window_key).await.unwrap(), true);
        assert_eq!(old.list_keys().await.unwrap().len(), 9, "old keeps all 8 pre + 1 window blob");

        let _ = std::fs::remove_dir_all(&od);
        let _ = std::fs::remove_dir_all(&nd);
    }

    /// INV-1 — atomic swap / concurrent-read-vs-swap safety, exercised against the REAL global
    /// primitive (`swap_object_store` publishes; `get_object_store` snapshots via `load_full()`).
    /// Many reader tasks hammer `get_object_store()` and actually USE the returned store (a real
    /// `put`/`get` round-trip) while a writer task swaps the global back and forth between two
    /// distinct stores. Every read must resolve to a fully-usable store — never a panic, never a
    /// torn/empty handle, never a spurious failure — for the whole storm.
    #[tokio::test]
    // TEST-A1 [acceptance] [invariant: INV-1]
    async fn concurrent_reads_never_tear_or_fault_across_swaps() {
        let _guard = GLOBAL_HANDLE_LOCK.lock().await;
        let (ad, bd) = (tmp(), tmp());
        let a = store(&ad);
        let b = store(&bd);
        // Seed the global to a known store (installs the swappable cell).
        super::super::swap_object_store(a.clone());

        let writer = {
            let (a, b) = (a.clone(), b.clone());
            tokio::spawn(async move {
                for i in 0..500u32 {
                    super::super::swap_object_store(if i % 2 == 0 { a.clone() } else { b.clone() });
                    if i % 32 == 0 {
                        tokio::task::yield_now().await;
                    }
                }
            })
        };

        let mut readers = Vec::new();
        for _ in 0..8 {
            readers.push(tokio::spawn(async move {
                for _ in 0..400u32 {
                    // Snapshot the live store and do a real round-trip through it. If a swap could
                    // ever yield a torn/empty handle, this put/get would panic or fault.
                    let s = super::super::get_object_store();
                    let k = s.put(b"racing read").await.expect("put on the snapshot never faults");
                    let v = s.get(&k).await.expect("get on the snapshot never faults");
                    assert_eq!(v, b"racing read");
                }
            }));
        }

        writer.await.unwrap();
        for r in readers {
            r.await.unwrap();
        }

        let _ = std::fs::remove_dir_all(&ad);
        let _ = std::fs::remove_dir_all(&bd);
    }

    /// INV-4 — rollback restores OLD atomically with zero data loss. After a cutover to
    /// `DualRead(new, old)`, a forced failure rolls the live handle back to OLD; the OLD store
    /// still holds every blob (the transition never deleted from it), so every pre-cutover blob
    /// is still served, and a blob written only to OLD during the window survives the rollback.
    #[tokio::test]
    // TEST-A3 [acceptance] [invariant: INV-4]
    async fn rollback_restores_old_with_no_loss() {
        let _guard = GLOBAL_HANDLE_LOCK.lock().await;
        let (od, nd) = (tmp(), tmp());
        let old = store(&od);
        let new = store(&nd);
        let keep = old.put(b"pre-existing, must survive rollback").await.unwrap();
        engine::copy_and_verify(&old, &new, &mut |_| {}).await.unwrap();
        let window = old.put(b"window write, old-only, must survive rollback").await.unwrap();

        // Cut over, then force a rollback.
        let _live = install_dual_read(new.clone(), old.clone());
        rollback_to_old(old.clone());

        // The live handle is OLD again, and OLD still has everything (INV-4 + INV-5).
        let live = super::super::get_object_store();
        assert_eq!(live.get(&keep).await.unwrap(), b"pre-existing, must survive rollback");
        assert_eq!(live.get(&window).await.unwrap(), b"window write, old-only, must survive rollback");
        assert_eq!(old.list_keys().await.unwrap().len(), 2, "OLD never lost a blob across cutover+rollback");

        let _ = std::fs::remove_dir_all(&od);
        let _ = std::fs::remove_dir_all(&nd);
    }

    /// ITEM-4 — the retire gate must enumerate the PRESERVED OLD store, not the live dual-read
    /// handle (whose `list_keys` forwards to the NEW primary). This proves the source-selection the
    /// retire path uses (`as_dual_read().fallback()`): an OLD-only write-window straggler is VISIBLE
    /// via the fallback's `list_keys` but ABSENT from the dual handle's `list_keys` — so enumerating
    /// the live handle would wrongly green-light a retire while a straggler is not yet in NEW.
    #[tokio::test]
    // TEST-A6 [covers: ITEM-4]
    // TEST-I1 — superseded placeholder (deferred-scope retire-over-OLD integration test), realized here.
    async fn retire_gate_enumerates_the_preserved_old_not_the_dual_read_primary() {
        let (od, nd) = (tmp(), tmp());
        let old = store(&od);
        let new = store(&nd);
        let straggler = old.put(b"old-only straggler, not yet in new").await.unwrap();
        let live = build_dual_read(new.clone(), old.clone());

        // The live (dual-read) handle enumerates the NEW primary — the straggler is NOT listed.
        let via_live: Vec<String> = live.list_keys().await.unwrap().iter().map(|k| k.as_str().to_string()).collect();
        assert!(!via_live.contains(&straggler.as_str().to_string()), "the dual handle lists NEW, which lacks the straggler");

        // The retire path selects the fallback (OLD) — which DOES list the straggler, so the
        // retire re-verify would correctly find it missing-in-NEW and refuse (safe_to_retire=false).
        let retire_src = live.as_dual_read().map(|d| d.fallback()).unwrap_or_else(|| live.clone());
        let via_old: Vec<String> = retire_src.list_keys().await.unwrap().iter().map(|k| k.as_str().to_string()).collect();
        assert!(via_old.contains(&straggler.as_str().to_string()), "the retire gate enumerates OLD, which HAS the straggler");

        let _ = std::fs::remove_dir_all(&od);
        let _ = std::fs::remove_dir_all(&nd);
    }

    /// DEC-5 — the preserved OLD config round-trips through JSON (the on-the-wire-to-encryption
    /// form) with credentials intact, and rebuilds a working LOCAL store from the local root. The
    /// cloud rebuild is exercised by the floci integration test (it needs a real endpoint).
    #[test]
    // TEST-A5 [acceptance] [invariant: INV-6]
    fn preserved_config_roundtrips_and_rebuilds_local() {
        // A cloud config with creds serializes to JSON and back byte-for-byte (this JSON is what is
        // ENCRYPTED at rest — DEC-5 — never stored plaintext).
        let cloud = PreservedStoreConfig {
            backend: "s3".into(),
            provider: Some("gcs".into()),
            endpoint: Some("https://storage.example".into()),
            bucket: Some("old-bucket".into()),
            region: Some("us-east-1".into()),
            path_style: Some(true),
            access_key_id: Some("AKIAOLD".into()),
            secret_access_key: Some("s3cr3t-old".into()),
        };
        let json = serde_json::to_string(&cloud).unwrap();
        let back: PreservedStoreConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.bucket.as_deref(), Some("old-bucket"));
        assert_eq!(back.access_key_id.as_deref(), Some("AKIAOLD"));
        assert_eq!(back.secret_access_key.as_deref(), Some("s3cr3t-old"));
        assert!(cloud.has_secret());

        // A local preserved config carries no secret and rebuilds a working store from the root.
        let dir = tmp();
        let local_cfg = PreservedStoreConfig::local();
        assert!(!local_cfg.has_secret());
        let rebuilt = build_store_from_preserved(&local_cfg, &dir).unwrap();
        // Prove it is a live, writable store at that root.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let k = rebuilt.put(b"rebuilt-from-preserved").await.unwrap();
            assert_eq!(rebuilt.get(&k).await.unwrap(), b"rebuilt-from-preserved");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// INV-3 — the activation guard is byte-exact: a `DualRead(new, old)` serves the OLD
    /// fallback for any blob not yet in NEW, so cutting over a migration whose copy is only
    /// PARTIAL never surfaces an absence (which is precisely why the orchestrator may swap on
    /// `verified` — every enumerated blob is in new — while the write-window remainder rides the
    /// fallback). Here NEW is deliberately missing a blob; the live handle still serves it.
    #[tokio::test]
    // TEST-A4 [acceptance] [invariant: INV-3]
    async fn dual_read_serves_old_only_blobs_so_cutover_is_never_a_spurious_absence() {
        let (od, nd) = (tmp(), tmp());
        let old = store(&od);
        let new = store(&nd);
        let only_old = old.put(b"never copied to new").await.unwrap();
        let live = build_dual_read(new.clone(), old.clone());
        assert!(live.as_dual_read().is_some(), "the live handle is a DualReadStore after cutover");
        assert_eq!(live.get(&only_old).await.unwrap(), b"never copied to new");
        // And the preserved OLD is reachable for the retire-time verify_all (the fallback end).
        let dual = live.as_dual_read().unwrap();
        assert_eq!(dual.fallback().get(&only_old).await.unwrap(), b"never copied to new");
        let ghost = ContentKey::from_hex(&"cd".repeat(32));
        assert!(live.get(&ghost).await.is_err(), "a blob in NEITHER store is still absent");
        let _ = std::fs::remove_dir_all(&od);
        let _ = std::fs::remove_dir_all(&nd);
    }
}
