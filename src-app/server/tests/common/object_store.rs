//! The TEST BINARY's one process-wide blob store — harness-owned, because the
//! thing it wraps is a process-wide singleton and four tests were treating it as
//! private state.
//!
//! ## The defect this exists to make impossible
//!
//! `workstore::init_working_store` fills three WRITE-ONCE process statics
//! (`OBJECT_STORE`, `LIMITS`, `STORE_CLAIM`). That is correct for a SERVER: it
//! boots once, those three are a boot-time fact, and every later reader wants
//! exactly what boot installed. It is wrong for a TEST BINARY, where ~440 tests
//! share one process: whichever test reaches `init_working_store` FIRST installs
//! all three for the whole run, and every later `init_working_store` is a silent
//! no-op (its writes are `let _ = …set(..)`, so a lost race is discarded without
//! a word). Three integration tests each built a private throwaway root and
//! called it, believing they had installed their own; at most one ever had.
//!
//! That alone was invisible (the store is content-addressed, so sharing a root is
//! harmless and the three tests assert catalog ROWS). What made it a failure is
//! that two of those tests then `remove_dir_all`'d their root on the way out,
//! while the process-global `STORE_CLAIM` went on naming it. Any later test in
//! the same process that reached a sweep therefore pointed the GC at a directory
//! that no longer existed:
//!
//! ```text
//! project::scope::gc_manifest_threading_and_sweep ... FAILED
//!   workstore.gc: refusing to sweep /tmp/txr-ingest-store-<uuid>/workstore
//!   — its .catalog-owner claim could not be read (No such file or directory)
//! ```
//!
//! Green in isolation (nothing else had set the statics, so the sweep degraded to
//! the documented `try_get_store_claim() == None` no-op), red under parallelism,
//! on `main` and on every branch — the signature of a shared-state defect wearing
//! a flake's clothes.
//!
//! ## The fix, and what it deliberately does NOT do
//!
//! It does not retry, does not serialise the suite, and does not touch the claim
//! mechanism — `partition.rs`'s refusal to sweep a root it cannot attribute is
//! CORRECT and is what stopped one worktree's GC deleting another's blobs. The
//! claim did its job here too: it refused, loudly, naming the exact directory.
//!
//! What was wrong is that a process-lifetime global was pointed at a test-lifetime
//! directory. So the singleton gets a single owner — this module — and a root that
//! lives exactly as long as the process that installed it. No test creates one, no
//! test deletes one, and a test that needs "the process store" asks for it.
//!
//! Sharing one root across tests is safe for the same reason one server shares one
//! root across all its projects: the store is content-addressed, and
//! `GcSweeper::sweep_marked` only ever considers hashes the caller's own manifest
//! marked. It cannot reach a peer test's blob.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use txresbench::modules::workstore::config::{ObjectStoreKind, WorkstoreConfig, WorkstoreLimits};
use txresbench::modules::workstore::partition::resolve_owned_root;
use txresbench::modules::workstore::{init_working_store, try_get_store_claim};

static SHARED: OnceLock<PathBuf> = OnceLock::new();

/// Install (once) and return the test binary's process-wide blob-store root.
///
/// Call this from any test that needs `try_get_object_store()` /
/// `try_get_store_claim()` to resolve — i.e. anything exercising an ingest sink,
/// a capture, or a GC sweep from inside the test process. Idempotent, race-safe
/// across the harness's worker threads, and cheap after the first call.
///
/// Returns the DATA ROOT that was claimed; the store itself lives at
/// `<root>/workstore` (see `partition::resolve_owned_root`).
#[allow(dead_code)] // not every integration target links every test module
pub fn shared_object_store_root() -> &'static Path {
    SHARED.get_or_init(|| {
        reap_stale_roots();
        let root = std::env::temp_dir().join(format!("txr-testbin-store-{}", std::process::id()));
        let key = format!("testbin-{}", std::process::id());
        let claim = resolve_owned_root(&root, &key);
        init_working_store(&WorkstoreConfig {
            claim,
            backend: ObjectStoreKind::Local,
            limits: WorkstoreLimits::default(),
            // Local backend ⇒ no cloud connection config (T2).
            s3: None,
        })
        .expect("local-fs store always constructs");

        // `init_working_store` writes write-once statics and SWALLOWS a lost race,
        // which is exactly how the original defect stayed invisible: a test believed
        // it had installed its root and had not. Assert the installed STATE rather
        // than the call, so a future test that reaches `init_working_store` directly
        // fails HERE, naming the fix, instead of stranding this root the way the
        // deleted ones stranded theirs.
        let installed = try_get_store_claim()
            .expect("init_working_store must have installed a claim")
            .root()
            .to_path_buf();
        let expected = root.join("workstore");
        assert_eq!(
            installed,
            expected,
            "another test installed the process-wide workstore first ({}), so this root ({}) is \
             NOT in effect. `OBJECT_STORE`/`STORE_CLAIM` are write-once statics — first writer \
             wins and every later `init_working_store` is a silent no-op. Route the other call \
             site through `common::object_store::shared_object_store_root()` too; do not call \
             `init_working_store` from a test.",
            installed.display(),
            expected.display()
        );
        root
    })
}

/// Best-effort removal of roots left by test binaries that have since exited.
///
/// The root has to outlive every test in the process, so it cannot be cleaned up
/// by the test that created it — the whole point of this module. Age is the
/// portable liveness proxy: no run of this suite lasts a day, so a sibling root
/// older than that belongs to a process that is gone. Concurrent worktrees are
/// unaffected (each root is pid-scoped, and a live run's root is minutes old).
/// Failures are ignored — this is hygiene, never correctness.
fn reap_stale_roots() {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("txr-testbin-store-") {
            continue;
        }
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|age| age > MAX_AGE).unwrap_or(false))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}
