//! The harness's OWN per-test-database lifecycle, asserted against real FILES.
//!
//! ## Why this module exists
//!
//! The harness's sqlite leg copies a per-test DATABASE FILE from the worktree
//! template (`txresbench_test_template_<key>.sqlite`) for every
//! `TestServer::spawn()`. Reaping it was once a fire-and-forget task that got
//! cancelled at runtime teardown; the measured result on the shared build
//! cluster was 8,753 orphaned `test_db_*` databases, and Postgres startup took
//! minutes just scanning them. The file leg keeps the same discipline: the
//! per-test FILE is owned from the moment it is copied and deleted
//! synchronously on drop; the exit paths a destructor cannot reach (SIGKILL,
//! OOM, test-binary timeout, `panic = "abort"`) are covered by the startup
//! sweep.
//!
//! Every test below is a NEGATIVE CONTROL shaped to go RED if the owning or
//! sweeping half is dismantled: "the file was deleted" and "the delete was
//! scheduled and discarded" are indistinguishable from inside a green suite —
//! the only thing that tells them apart is asking the filesystem afterwards.
//!
//! The two halves the tests deliberately separate:
//!
//!   * **the guard** — `Drop` must reap synchronously, on the normal path, on an
//!     early `?` return, and on a panicking (i.e. failing-assertion) body;
//!   * **the sweep** — the cases a `Drop` impl *cannot* cover are covered at
//!     harness startup instead, and that sweep must never take a file that is
//!     still in use, nor the shared template / build files.
//!
//! "Drop everything" passes the first half and is catastrophic; the survival
//! controls are what makes the first half mean anything.

use std::path::PathBuf;

use crate::common::TestServer;

/// The app-side template-DB base — the same literal `CytoHarnessApp::
/// template_db_base` returns; the engine appends the per-worktree key.
const TEMPLATE_BASE: &str = "txresbench_test_template";

/// The root of per-test db files: `TestHarness::start` puts the per-test copy
/// and the template in the system temp dir (honoring `TMPDIR`).
fn file_for(stem: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{stem}.sqlite"))
}

/// The per-worktree shared FILE names this fix must NOT take with it. Derived
/// the same way the harness derives them, from THIS crate's manifest dir.
fn shared_file_names() -> (String, String) {
    let key = txresbench_test_harness::worktree_db::worktree_key(env!("CARGO_MANIFEST_DIR"));
    let build_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root walk")
        .join("target/sqlx-build");
    (
        format!("{TEMPLATE_BASE}_{key}"),
        // The build script's per-worktree file — present when this worktree has
        // been built (i.e. always, under the sqlite driver).
        build_root
            .join(format!("txresbench_build_{key}.sqlite"))
            .display()
            .to_string(),
    )
}

async fn file_exists(stem: &str) -> bool {
    file_for(stem).exists()
}

/// The normal path: a body that completes reaps its database file.
///
/// This is the weakest of the three and is here as the baseline — it is the one
/// case a detached `Drop` task could occasionally win by luck, so a green here
/// says nothing on its own.
#[tokio::test]
async fn per_test_db_is_dropped_on_the_normal_path() {
    let name = {
        let server = TestServer::spawn().await;
        let name = server.database_name().to_string();
        assert!(
            file_exists(&name).await,
            "the harness must have created {name}"
        );
        name
    };
    assert!(
        !file_exists(&name).await,
        "{name} survived a normally-returning test body — the per-test database file leaked"
    );
}

/// A body that returns early with an error (the `?` path) reaps its database.
///
/// An explicit cleanup call at the end of a test body is skipped by every early
/// return; this asserts the reap is bound to the HANDLE's lifetime instead.
#[tokio::test]
async fn per_test_db_is_dropped_when_the_body_returns_early() {
    // The name escapes through a channel because the failing body cannot return it.
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    async fn failing_body(tx: std::sync::mpsc::Sender<String>) -> Result<(), String> {
        let server = TestServer::spawn().await;
        tx.send(server.database_name().to_string()).unwrap();
        // The shape of every `?` in a test body: the handle is still in scope and
        // is dropped by the early return, not by any code the author wrote.
        Err("simulated early return".to_string())?;
        unreachable!("the body returned early on purpose");
    }

    let outcome = failing_body(tx).await;
    assert!(
        outcome.is_err(),
        "the body must have taken the early return"
    );

    let name = rx.recv().expect("the body reported its database name");
    assert!(
        !file_exists(&name).await,
        "{name} survived a body that returned early — the per-test database file leaked"
    );
}

/// A body that PANICS (which is what a failed assertion is) reaps its database.
///
/// DECISION: a failing test drops its database rather than keeping it. The name
/// is a v4 UUID that is printed nowhere, the server process is already killed,
/// and the data dir is a `TempDir` that goes with it — a retained database is
/// not a debugging artifact, it is thousands of them. Retention is available
/// deliberately and per-run via `TXR_TEST_KEEP_DB=1`, which also prints the URL
/// so it can be reached; the startup sweep reclaims those later, so opting in
/// cannot re-open the leak.
#[tokio::test]
async fn per_test_db_is_dropped_when_the_body_panics() {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let server = TestServer::spawn().await;
    tx.send(server.database_name().to_string()).unwrap();

    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        // Moved in, so the unwind — not any cleanup code — is what drops it.
        let _held = server;
        panic!("simulated assertion failure");
    }));
    assert!(unwound.is_err(), "the body must have panicked");

    let name = rx.recv().expect("the body reported its database name");
    assert!(
        !file_exists(&name).await,
        "{name} survived a panicking test body — the per-test database file leaked"
    );
}

/// The control that makes the three above mean something: reaping a per-test
/// database file must not reap the SHARED template or build files.
///
/// Both are shared by every concurrent test in the run; deleting either mid-run
/// breaks every other test in the binary. Without this control, "drop every file
/// whose name we recognise" passes the leak tests.
#[tokio::test]
async fn reaping_a_per_test_db_leaves_the_template_and_build_files_alone() {
    let (template, build) = shared_file_names();

    let name = {
        let server = TestServer::spawn().await;
        // The template must exist BEFORE the reap — a copy was just taken from it.
        assert!(
            file_exists(&template).await,
            "{template} must exist: the harness copied this test's database from it"
        );
        server.database_name().to_string()
    };

    assert!(!file_exists(&name).await, "{name} leaked");
    assert!(
        file_exists(&template).await,
        "{template} was destroyed by the per-test reap — every concurrent test in \
         this run now has no template to copy from"
    );
    // The build DB file is `build.rs`'s, not the harness's — always present
    // under the sqlite driver. Assert non-destruction: a second spawn would
    // fail loudly at sqlx compile-time verification if it were broken.
    if std::path::Path::new(&build).exists() {
        let _second = TestServer::spawn().await;
        assert!(
            std::path::Path::new(&build).exists(),
            "{build} was destroyed by the harness — sqlx compile-time verification \
             for this worktree is now broken"
        );
    }
}

// ───────────────────────── the startup sweep ─────────────────────────
//
// The sweep exists for the exit paths `Drop` cannot reach. Its danger is the
// mirror image of the leak: several test binaries start at once, so a sweep that
// takes another run's LIVE file is far worse than the orphans it collects.

/// The sweep must not take a file that has a live owner, even when that file is
/// old enough to qualify on age alone.
///
/// This is the control that stops the sweep from becoming the outage. It runs
/// with the age floor set to zero — i.e. with the age discriminator deliberately
/// disarmed — so the ONLY thing that can save the file is the liveness lock.
#[tokio::test]
async fn the_sweep_spares_a_test_db_that_has_a_live_connection() {
    let name = format!(
        "{TEMPLATE_BASE}_test_{}_deadbeefdeadbeefdeadbeefdeadbeef",
        uuid::Uuid::new_v4().simple()
    );
    let path = file_for(&name);
    std::fs::write(&path, b"fixture").expect("create fixture file");

    // Hold the same flock the harness holds for the life of a test.
    let held = txresbench_test_harness::OwnedTestFile::lock(path.clone())
        .expect("lock the in-use fixture file");

    let report = txresbench_test_harness::sweep_stale_test_db_files(TEMPLATE_BASE, 0);

    assert!(
        path.exists(),
        "the sweep dropped {name} while a live owner held its flock — a \
         concurrently-running test binary would have lost its database mid-test"
    );
    // Asserted on CONSIDERED, not on removed: a sweep whose liveness check has
    // been removed also fails to drop a locked file on some paths, but the
    // deletion would still have been ATTEMPTED — which is the mutation under test.
    assert!(
        !report.considered.contains(&path),
        "the sweep tried to delete {name} while its flock was held; a live run \
         loses its database. considered={:?}",
        report.considered
    );

    drop(held);
    // Never leave behind what this test created.
    let _ = std::fs::remove_file(&path);
}

/// The sweep must not take the shared template or build files — they do not
/// carry the anchored `{base}_test_` prefix, and no age or idleness may
/// override that.
#[tokio::test]
async fn the_sweep_spares_the_template_and_build_files() {
    let (template, build) = shared_file_names();
    // Materialise the template by spawning once, then release the handle so the
    // template is idle — the state that would tempt an age-only sweep.
    {
        let _server = TestServer::spawn().await;
    }
    assert!(
        file_exists(&template).await,
        "{template} must exist to be spared"
    );
    let build_existed = std::path::Path::new(&build).exists();

    let report = txresbench_test_harness::sweep_stale_test_db_files(TEMPLATE_BASE, 0);

    assert!(
        !report
            .considered
            .iter()
            .any(|p| p.file_name().and_then(|n| n.to_str()) == Some(template.as_str())),
        "the sweep tried to drop a shared file: {:?}",
        report.considered
    );
    assert!(
        file_exists(&template).await,
        "the sweep destroyed {template}"
    );
    if build_existed {
        assert!(
            std::path::Path::new(&build).exists(),
            "the sweep destroyed {build}"
        );
    }
}

/// The sweep DOES collect an orphan: an unlocked `{base}_test_*` older than the
/// floor. Without this the two controls above are satisfied by a sweep that does
/// nothing at all.
#[tokio::test]
async fn the_sweep_collects_an_idle_orphan() {
    let name = format!(
        "{TEMPLATE_BASE}_test_{}_deadbeefdeadbeefdeadbeefdeadbeef",
        uuid::Uuid::new_v4().simple()
    );
    let path = file_for(&name);
    std::fs::write(&path, b"orphan").expect("create the orphan fixture");
    // Nothing holds its flock — the state a SIGKILLed run leaves.

    let report = txresbench_test_harness::sweep_stale_test_db_files(TEMPLATE_BASE, 0);

    let gone = !path.exists();
    if !gone {
        // Clean up before failing, so a red test does not itself leak.
        let _ = std::fs::remove_file(&path);
    }
    assert!(
        gone && report.removed.contains(&path),
        "the sweep left the idle orphan {name} behind (considered {} entries) — it \
         collects nothing, and the two sparing controls above are vacuous",
        report.considered.len()
    );
}

/// The age floor is real: a freshly-created idle orphan is NOT collected when
/// the floor is non-zero.
///
/// This is what makes the sweep safe against the one window the liveness lock
/// cannot see — a file created by a concurrent run microseconds ago, whose
/// harness has not yet locked it. Age and liveness are each individually
/// insufficient; the sweep requires both.
#[tokio::test]
async fn the_sweep_spares_a_freshly_created_orphan_under_the_age_floor() {
    let name = format!(
        "{TEMPLATE_BASE}_test_{}_deadbeefdeadbeefdeadbeefdeadbeef",
        uuid::Uuid::new_v4().simple()
    );
    let path = file_for(&name);
    std::fs::write(&path, b"fresh").expect("create the fresh fixture");

    let report = txresbench_test_harness::sweep_stale_test_db_files(TEMPLATE_BASE, 3600);

    let survived = path.exists();

    let _ = std::fs::remove_file(&path);

    assert!(
        survived && !report.considered.contains(&path),
        "the sweep took {name}, created seconds ago, under a one-hour age floor — \
         it would race a concurrently-starting test binary"
    );
}

/// The sweep's discriminator is the NAME PREFIX, and the prefix check is
/// anchored. A file that merely contains `{base}_test_` is not the harness's.
#[tokio::test]
async fn the_sweep_only_matches_the_anchored_test_db_prefix() {
    let decoy = format!(
        "not_a_{TEMPLATE_BASE}_test_{}_deadbeefdeadbeefdeadbeefdeadbeef",
        uuid::Uuid::new_v4().simple()
    );
    let too_short = format!("{TEMPLATE_BASE}_test_00.sqlite");
    let decoy_path = file_for(&decoy);
    let short_path = file_for(&too_short);
    std::fs::write(&decoy_path, b"decoy").expect("create the decoy file");
    std::fs::write(&short_path, b"short").expect("create the short file");

    let report = txresbench_test_harness::sweep_stale_test_db_files(TEMPLATE_BASE, 0);
    let survived = decoy_path.exists() && short_path.exists();

    let _ = std::fs::remove_file(&decoy_path);
    let _ = std::fs::remove_file(&short_path);

    assert!(
        survived && report.considered.is_empty(),
        "the sweep took a file it did not create: considered={:?}",
        report.considered
    );
}

/// The reap must be observable when it fails. A delete that errors and is
/// discarded looks exactly like a delete that never ran — which is how the
/// cluster-database leak stayed invisible for the whole life of the harness.
///
/// Asserted at the source of truth rather than on prose: the URL's file stem is
/// the name the handle exposes, and the file exists under it.
#[tokio::test]
async fn the_harness_exposes_the_database_name_it_must_reap() {
    let server = TestServer::spawn().await;
    let name = server.database_name().to_string();
    assert!(
        name.starts_with(&format!("{TEMPLATE_BASE}_test_")),
        "the per-test database must carry the file stem the sweep keys on, got {name}"
    );

    assert!(
        server.database_url().starts_with("sqlite://"),
        "the per-test database URL must be a sqlite URL, got {}",
        server.database_url()
    );
    // URL-file stem === the exposed database_name, and the file exists.
    let url_path = server
        .database_url()
        .strip_prefix("sqlite://")
        .expect("sqlite url has a path");
    assert!(
        std::path::Path::new(url_path)
            .file_stem()
            .and_then(|s| s.to_str())
            == Some(name.as_str()),
        "the name the harness reaps must be the file the server is actually using"
    );
    assert!(
        std::path::Path::new(url_path).exists(),
        "the per-test file the server uses must exist under its exposed URL"
    );
}

/// The window between the copy and the handle existing.
///
/// `TestHarness::start` copies the per-test file, locks it, then resolves a
/// binary, spawns it, and polls it healthy for up to 30s — and only THEN builds
/// the handle whose destructor reaps. Every panic in between used to unwind past
/// a file nobody owned. A guard armed at the end of a successful spawn cannot
/// cover this; only ownership taken at the moment the resource exists can.
#[tokio::test]
async fn per_test_db_is_dropped_when_the_spawn_itself_panics() {
    let observed = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let opts = crate::common::TestOptions {
        observed_database_name: Some(observed.clone()),
        break_binary_name: true,
        ..Default::default()
    };

    // Run it as a task so the panic is caught as a `JoinError` instead of aborting
    // this test — the unwind path itself is unchanged.
    let outcome = tokio::spawn(async move { TestServer::spawn_with(opts).await }).await;
    assert!(
        outcome.is_err(),
        "the spawn was supposed to panic before it could return a handle"
    );

    let name = observed
        .lock()
        .expect("observed-db-name slot")
        .clone()
        .expect("the harness must have reached plan_spawn, i.e. created the database");
    assert!(
        !file_exists(&name).await,
        "{name} was created and then orphaned by a panic before the handle existed — \
         the reap is armed too late"
    );
}

/// The startup sweep is INSTALLED, not merely present.
///
/// Every other sweep test calls `sweep_stale_test_db_files` directly, so all of
/// them stay green if the call inside the harness's own process boot is deleted —
/// and that call is the entire self-healing half of this fix: the one that
/// reclaims what a SIGKILL, an OOM kill, `panic = "abort"` or a test-binary
/// timeout left behind, none of which any destructor can reach.
#[tokio::test]
async fn the_startup_sweep_is_wired_into_harness_boot() {
    // Spawning is what boots the harness; the sweep must have run by the time the
    // first per-test database is copied.
    let _server = TestServer::spawn().await;
    assert!(
        txresbench_test_harness::startup_sweep_ran(),
        "the harness cloned a per-test database without ever running the startup \
         stale-file sweep — orphans from killed/aborted/timed-out runs are never \
         reclaimed and the leak regrows"
    );
}
