//! TEST-154 integration — the rootfs cache actually has an eviction path now.
//!
//! The unit tests in `rootfs::cache` prove the POLICY and the removal MECHANISM.
//! Neither can prove the thing #154 was actually about: that something *calls*
//! them. `gc_unreferenced` was correct-looking, unit-tested and completely
//! unwired for its whole life, and every gate stayed green — so the test that
//! matters here is one that boots a real server and watches the cache shrink.

use crate::common::{TestOptions, TestServer};

/// How many digest dirs the pre-staged backlog holds. Comfortably above the
/// `MAX_CACHED_DIGESTS_DEFAULT` cap of 4 so the assertion cannot pass by accident
/// on a deployment that happened to be under it.
const PRESTAGED: usize = 9;

/// Poll `<data_dir>/sandbox-rootfs/` for the digest-dir count to settle at or
/// under `cap`. The boot pass is a detached task, so a fixed sleep would either
/// flake or waste time.
fn wait_for_cache_bound(base: &std::path::Path, cap: usize) -> usize {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut last = usize::MAX;
    loop {
        last = count_cached(base);
        if last <= cap || std::time::Instant::now() > deadline {
            return last;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// A cached digest = a 64-hex subdir holding a non-empty `rootfs.squashfs`, the
/// same definition the server's own cache listing uses. Counted from the OUTSIDE
/// (plain filesystem), never through the code under test.
fn count_cached(base: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(base) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let Some(name) = name.to_str() else {
                return false;
            };
            name.len() == 64
                && name
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && std::fs::metadata(e.path().join("rootfs.squashfs"))
                    .map(|m| m.is_file() && m.len() > 0)
                    .unwrap_or(false)
        })
        .count()
}

/// The whole point of #154: a booting server reclaims an over-cap rootfs cache.
///
/// Uniquely kills: deleting the `rootfs_gc::spawn_loop(pool.clone())` line from
/// `provenance::init`. Every unit test, every compile check and `check-pub-orphans`
/// stay green under that deletion — this is the only thing in the suite that goes
/// red, because it is the only thing that observes the cache from outside the
/// process that owns it.
///
/// It also covers the halves the unit tests cannot reach: the `SELECT DISTINCT
/// env_rootfs_sha256` against a real Postgres (a fresh deployment has no runs, so
/// the referenced set is legitimately empty), and `data_root()` resolving through
/// `TXR_APP_DATA_DIR` in the spawned binary rather than through a thread-local.
#[tokio::test]
async fn boot_pass_bounds_an_over_cap_rootfs_cache() {
    let server = TestServer::spawn_with(TestOptions {
        prestage_rootfs_digests: PRESTAGED,
        ..Default::default()
    })
    .await;

    let base = server.data_dir().join("sandbox-rootfs");
    assert!(
        base.is_dir(),
        "the harness pre-staged the cache at {}",
        base.display()
    );

    // `MAX_CACHED_DIGESTS_DEFAULT`; asserted as a literal on purpose. If someone
    // raises the cap they must come here and say so, rather than have an
    // inequality quietly absorb an unbounded default.
    let cap = 4;
    let remaining = wait_for_cache_bound(&base, cap);

    assert!(
        remaining <= cap,
        "the boot GC pass must bound the cache: {PRESTAGED} pre-staged, {remaining} left, cap {cap}"
    );
    assert!(
        remaining > 0,
        "eviction is bounded, not a wipe — the cap keeps the most recent digests"
    );
    // And it is stable: a second observation after the loop has had time to run
    // again finds the same bound, not an oscillation down to zero.
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(
        count_cached(&base),
        remaining,
        "GC converges — a settled cache is not swept further"
    );
}

/// The negative control. Without it the test above could pass on a server that
/// simply deleted the whole directory, or on a harness that never staged anything.
///
/// Uniquely kills: a GC that evicts unconditionally (ignoring the cap) — under
/// which an at-cap cache would still be emptied and this assertion fails.
#[tokio::test]
async fn a_cache_already_under_the_cap_is_left_alone() {
    let server = TestServer::spawn_with(TestOptions {
        prestage_rootfs_digests: 2,
        ..Default::default()
    })
    .await;

    let base = server.data_dir().join("sandbox-rootfs");
    // Give the boot pass the same window the positive test gets.
    std::thread::sleep(std::time::Duration::from_secs(2));

    assert_eq!(
        count_cached(&base),
        2,
        "an under-cap cache keeps every digest — GC is a bound, not a purge"
    );
}

// ─────────────────────────── #54: settings-driven GC ───────────────────────────

use txresbench::modules::provenance::repository::{NewRun, ProvenanceRepository};
use txresbench::modules::provenance::rootfs_gc;
use txresbench::modules::provenance::settings::ProvenanceSettingsRepository;
use txresbench::modules::rootfs::{cache, scoped_data_root};
use super::{create_project, setup_admin};
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;
use uuid::Uuid;

async fn gc_pool(server: &TestServer) -> sqlx::SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

fn hex64(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

fn place_digest(base: &std::path::Path, digest: &str) {
    let d = base.join(digest);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("rootfs.squashfs"), b"sqfs-bytes").unwrap();
}

// TEST-10 [acceptance][INV-1] — the eviction cap is read from the `provenance_settings` row
// AT USE, not baked from the compile-time const. With the row set to a cap DISTINCT from the
// default (2, not 4), the sweep the GC driver runs bounds the cache to THAT value — proving
// an admin PUT changes GC behavior with no code release. This test drives the EXACT per-cycle
// sequence `rootfs_gc::spawn_loop` runs every iteration — read settings → `resolve_max_digests`
// → `referenced_digests` → `sweep_now_with_cap` — so it is not a hollow seam test: reverting
// spawn_loop to the hardcoded const would leave THIS assertion green only because the loop
// wiring is separately pinned by `boot_pass_bounds_an_over_cap_rootfs_cache` (which goes RED if
// the `spawn_loop` call is deleted from provenance::init).
#[tokio::test]
async fn gc_cap_is_read_from_settings_at_use() {
    let server = TestServer::spawn().await;
    let pool = gc_pool(&server).await;

    // Point base_dir() at the server's cache dir FOR THIS THREAD (the tokio::test runtime is
    // current-thread, so the override survives the awaits below and the inline sweep sees it).
    let _guard = scoped_data_root(server.data_dir());
    let base = cache::base_dir();
    std::fs::create_dir_all(&base).unwrap();
    for i in 0..6u8 {
        place_digest(&base, &hex64(i));
    }

    // Admin lowers the cap to 2 (distinct from the seeded default of 4).
    sqlx::query("UPDATE provenance_settings SET rootfs_cache_max_digests = 2 WHERE id = TRUE")
        .execute(&pool)
        .await
        .expect("set cap");

    let settings = ProvenanceSettingsRepository::new(pool.clone())
        .get()
        .await
        .expect("read settings row");
    let cap = rootfs_gc::resolve_max_digests(&settings);
    assert_eq!(cap, 2, "the cap is resolved from the settings row, not the const 4");

    let referenced = rootfs_gc::referenced_digests(&pool).await.expect("referenced set");
    assert!(referenced.is_empty(), "a fresh deployment pins no digests");
    let evicted = rootfs_gc::sweep_now_with_cap(&referenced, cap);

    let remaining = count_cached(&base);
    assert_eq!(remaining, 2, "the sweep bounded the cache to the settings cap (2), not the const 4");
    assert_eq!(evicted.len(), 4, "4 of 6 evicted");
}

// TEST-11 [acceptance][INV-5] — the GC deletes only the local, re-obtainable rootfs cache; it
// NEVER deletes a provenance RECORD. A seeded run's `provenance_run_repro` audit row (and its
// pinned digest) survive a tiny-cap sweep untouched, and the referenced digest's cache dir is
// preferentially kept over unreferenced ones.
#[tokio::test]
async fn gc_never_deletes_provenance_records() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = gc_pool(&server).await;
    let project_id = create_project(&server, &admin, "gc-audit project").await;

    // Seed an audit record: a run_repro row pinning a rootfs digest.
    let pinned = hex64(0);
    let run_id = Uuid::new_v4();
    ProvenanceRepository::new(pool.clone())
        .insert_run(&NewRun {
            run_id,
            project_id: Some(project_id),
            dataset_id: None,
            kind: "compute".into(),
            status: "completed".into(),
            generator_id: "test".into(),
            generator_version: "0".into(),
            code_sha256: None,
            env_rootfs_sha256: Some(pinned.clone()),
            lockfile_json: None,
            seed: Some(7),
            params: json!({}),
            inputs_json: json!([]),
            acting_user: None,
            rerun_spec_json: None,
        })
        .await
        .expect("seed run_repro audit row");

    let repro_count = |p: sqlx::SqlitePool| async move {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM provenance_run_repro")
            .fetch_one(&p)
            .await
            .expect("count run_repro")
    };
    let before = repro_count(pool.clone()).await;
    assert_eq!(before, 1, "one audit record seeded");

    // Cache dirs: the pinned (referenced) digest + several unreferenced ones.
    let _guard = scoped_data_root(server.data_dir());
    let base = cache::base_dir();
    std::fs::create_dir_all(&base).unwrap();
    place_digest(&base, &pinned);
    for i in 1..6u8 {
        place_digest(&base, &hex64(i));
    }

    // A tiny cap that forces eviction.
    let referenced = rootfs_gc::referenced_digests(&pool).await.expect("referenced");
    assert!(referenced.contains(&pinned), "the seeded run pins its digest");
    let evicted = rootfs_gc::sweep_now_with_cap(&referenced, 1);
    assert!(!evicted.is_empty(), "the sweep did real work (evicted unreferenced dirs)");
    assert!(!evicted.contains(&pinned), "the referenced digest is kept over unreferenced ones");

    // The audit record is UNTOUCHED — GC never deletes a provenance row.
    let after = repro_count(pool.clone()).await;
    assert_eq!(after, before, "no provenance_run_repro record was deleted by the GC sweep");
    assert!(
        ProvenanceRepository::new(pool.clone())
            .get_run(run_id)
            .await
            .expect("query run")
            .is_some(),
        "the seeded run node still exists after the sweep"
    );
}

// TEST-16 [acceptance][INV-1] — the RUNNING GC loop honors a NON-default cap end-to-end.
// This closes the hollow-coverage gap the boot test cannot: `boot_pass_bounds_an_over_cap_
// rootfs_cache` asserts the cache settles at the DEFAULT cap (4 == the retired const), so it
// would stay green even if spawn_loop ignored settings. Here the spawned server inherits
// TXR_ROOTFS_CACHE_MAX_DIGESTS=2 (the harness spawns with env inherited), the boot-seed folds
// it into the settings row, and the REAL boot GC pass reads the settings cap and bounds the
// pre-staged cache to 2 — NOT the default 4. Mutation-kills reverting spawn_loop to
// `sweep_now_with_cap(&referenced, MAX_CACHED_DIGESTS_DEFAULT)`: that would settle at 4 and
// fail this assertion.
#[tokio::test]
async fn running_gc_loop_honors_a_non_default_settings_cap() {
    // Inherited by the spawned server (Command::env, no env_clear). Integration tests run
    // single-threaded (--test-threads=1), so this process-global set is race-free; remove it
    // right after spawn (the child captured it at spawn time).
    std::env::set_var("TXR_ROOTFS_CACHE_MAX_DIGESTS", "2");
    let server = TestServer::spawn_with(TestOptions {
        prestage_rootfs_digests: PRESTAGED, // 9, comfortably above both 4 and 2
        ..Default::default()
    })
    .await;
    std::env::remove_var("TXR_ROOTFS_CACHE_MAX_DIGESTS");

    let base = server.data_dir().join("sandbox-rootfs");
    assert!(base.is_dir(), "prestaged cache present");

    // The boot GC pass must bound to the SETTINGS cap (2, seeded from the env), not the
    // compile-time default of 4.
    let remaining = wait_for_cache_bound(&base, 2);
    assert_eq!(
        remaining, 2,
        "the running loop honored the non-default settings cap (2), not the const default (4)"
    );

    // Confirm the env was actually folded into the DB row (seed semantics, updated_by NULL).
    let pool = gc_pool(&server).await;
    let settings = ProvenanceSettingsRepository::new(pool)
        .get()
        .await
        .expect("read settings");
    assert_eq!(settings.rootfs_cache_max_digests, 2, "env seeded the cap into the row");
    assert!(settings.updated_by.is_none(), "the seed did not stamp updated_by");
}
