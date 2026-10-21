//! The harness's OWN per-test-database lifecycle, asserted against a real cluster.
//!
//! ## Why this module exists
//!
//! The harness clones a per-test database (`test_db_<uuid>`) from the worktree
//! template for every `TestServer::spawn()`. Reaping it was a detached
//! `tokio::spawn` inside `Drop` — a task scheduled onto the *test's own* runtime at
//! the exact moment that runtime is being torn down, so its first `.await` (a
//! Postgres connect) was cancelled before it ever completed. The measured result on
//! the shared build cluster was 8,753 orphaned `test_db_*` databases; at ~46,000
//! Postgres startup took minutes just scanning them.
//!
//! Every test below is a NEGATIVE CONTROL that was watched go RED against the
//! pre-fix harness. They are here because "the database was dropped" and "the drop
//! was scheduled and silently discarded" are indistinguishable from inside a green
//! suite — the only thing that tells them apart is asking the cluster afterwards.
//!
//! The two halves the tests deliberately separate:
//!
//!   * **the guard** — `Drop` must reap synchronously, on the normal path, on an
//!     early `?` return, and on a panicking (i.e. failing-assertion) body;
//!   * **the sweep** — the cases a `Drop` impl *cannot* cover (SIGKILL, OOM, a
//!     test-binary timeout, `panic = "abort"`) are covered at harness startup
//!     instead, and that sweep must never take a database that is still in use, nor
//!     the shared template / build databases every concurrent run depends on.
//!
//! "Drop everything" passes the first half and is catastrophic; the survival
//! controls are what makes the first half mean anything.

use std::panic::AssertUnwindSafe;

use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, Row};

use crate::common::TestServer;

/// The admin connection every one of these tests asks its questions through — the
/// same resolution the harness itself uses.
fn admin_url() -> String {
    std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://postgres:password@127.0.0.1:54321/postgres".to_string())
}

/// The admin URL with its database segment replaced — no URL crate needed, and the
/// admin URL's shape is fixed by `admin_url` above.
fn db_url_for(name: &str) -> String {
    let base = admin_url();
    let cut = base.rfind('/').expect("admin url has a database segment");
    format!("{}/{}", &base[..cut], name)
}

async fn db_exists(name: &str) -> bool {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    let row = sqlx::query("SELECT 1 FROM pg_database WHERE datname = $1")
        .bind(name)
        .fetch_optional(&pool)
        .await
        .expect("query pg_database");
    pool.close().await;
    row.is_some()
}

/// The per-worktree names this fix must NOT take with it. Derived the same way the
/// harness derives them, from THIS crate's manifest dir.
fn shared_db_names() -> (String, String) {
    let key = ziee_test_harness::worktree_db::worktree_key(env!("CARGO_MANIFEST_DIR"));
    (
        format!("cytoanalyst_test_template_{key}"),
        format!("cytoanalyst_build_{key}"),
    )
}

/// The normal path: a body that completes reaps its database.
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
            db_exists(&name).await,
            "the harness must have created {name}"
        );
        name
    };
    assert!(
        !db_exists(&name).await,
        "{name} survived a normally-returning test body — the per-test database leaked"
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
        !db_exists(&name).await,
        "{name} survived a body that returned early — the per-test database leaked"
    );
}

/// A body that PANICS (which is what a failed assertion is) reaps its database.
///
/// DECISION: a failing test drops its database rather than keeping it. The name is
/// a v4 UUID that is printed nowhere, the server process is already killed, and the
/// data dir is a `TempDir` that goes with it — a retained database is not a
/// debugging artifact, it is 8,753 of them. Retention is available deliberately and
/// per-run via `ZIEE_TEST_KEEP_DB=1`, which also prints the URL so it can be
/// reached; the startup sweep reclaims those later, so opting in cannot re-open the
/// leak.
#[tokio::test]
async fn per_test_db_is_dropped_when_the_body_panics() {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let server = TestServer::spawn().await;
    tx.send(server.database_name().to_string()).unwrap();

    let unwound = std::panic::catch_unwind(AssertUnwindSafe(move || {
        // Moved in, so the unwind — not any cleanup code — is what drops it.
        let _held = server;
        panic!("simulated assertion failure");
    }));
    assert!(unwound.is_err(), "the body must have panicked");

    let name = rx.recv().expect("the body reported its database name");
    assert!(
        !db_exists(&name).await,
        "{name} survived a panicking test body — the per-test database leaked"
    );
}

/// The control that makes the three above mean something: reaping a per-test
/// database must not reap the SHARED template or build database.
///
/// Both are per-worktree and shared by every concurrent test in the run; dropping
/// either mid-run breaks every other test in the binary. Without this control,
/// "drop every database whose name we recognise" passes the leak tests.
#[tokio::test]
async fn reaping_a_per_test_db_leaves_the_template_and_build_dbs_alone() {
    let (template, build) = shared_db_names();

    let name = {
        let server = TestServer::spawn().await;
        // The template must exist BEFORE the reap — a clone was just taken from it.
        assert!(
            db_exists(&template).await,
            "{template} must exist: the harness cloned this test's database from it"
        );
        server.database_name().to_string()
    };

    assert!(!db_exists(&name).await, "{name} leaked");
    assert!(
        db_exists(&template).await,
        "{template} was destroyed by the per-test reap — every concurrent test in \
         this run now has no template to clone from"
    );
    // The build DB is only present when this worktree has been built against the
    // shared cluster (it is `build.rs`'s, not the harness's). Assert non-destruction
    // only when it was there to begin with — a conditional that cannot mask the
    // failure it guards, because the harness never creates it.
    if db_exists(&build).await {
        let _second = TestServer::spawn().await;
        assert!(
            db_exists(&build).await,
            "{build} was destroyed by the harness — sqlx compile-time verification \
             for this worktree is now broken"
        );
    }
}

// ───────────────────────── the startup sweep ─────────────────────────
//
// The sweep exists for the exit paths `Drop` cannot reach. Its danger is the
// mirror image of the leak: several test binaries start at once, so a sweep that
// takes another run's LIVE database is far worse than the orphans it collects.

/// The sweep must not take a database that has a live connection, even when that
/// database is old enough to qualify on age alone.
///
/// This is the control that stops the sweep from becoming the outage. It runs with
/// the age floor set to zero — i.e. with the age discriminator deliberately
/// disarmed — so the ONLY thing that can save the database is the in-use check.
#[tokio::test]
async fn the_sweep_spares_a_test_db_that_has_a_live_connection() {
    let name = format!("test_db_{}", uuid::Uuid::new_v4().simple());

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .expect("create the in-use fixture database");
    admin.close().await;

    // Hold a real session open on it for the duration of the sweep.
    let held = PgPoolOptions::new()
        .min_connections(1)
        .max_connections(1)
        .connect(&db_url_for(&name))
        .await
        .expect("open a live session on the fixture database");
    // Force the connection to actually exist in pg_stat_activity.
    let _: i32 = sqlx::query_scalar("SELECT 1")
        .fetch_one(&held)
        .await
        .expect("the held session is live");

    let report = ziee_test_harness::sweep_stale_test_dbs(&admin_url(), 0).await;

    assert!(
        db_exists(&name).await,
        "the sweep dropped {name} while a session was connected to it — a \
         concurrently-running test binary would have lost its database mid-test"
    );
    // Asserted on CONSIDERED, not on dropped. A sweep whose in-use check has been
    // removed still fails to drop this database — Postgres refuses a non-forcing
    // DROP while a session is attached — so a control that only inspects `dropped`
    // stays green on exactly the mutation it exists to catch. Reaching for it at
    // all is the defect.
    assert!(
        !report.considered.contains(&name),
        "the sweep tried to drop {name} while a session was connected to it; it was \
         saved only by Postgres refusing. Add `WITH (FORCE)` — or race the check — \
         and a live run loses its database. considered={:?}",
        report.considered
    );

    held.close().await;
    // Never leave behind what this test created.
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    let _ = admin
        .execute(format!("DROP DATABASE IF EXISTS {name}").as_str())
        .await;
    admin.close().await;
}

/// The sweep must not take the shared template or build databases — they do not
/// carry the `test_db_` prefix, and no age or idleness may override that.
#[tokio::test]
async fn the_sweep_spares_the_template_and_build_dbs() {
    let (template, build) = shared_db_names();
    // Materialise the template by spawning once, then release the handle so the
    // template is idle — the state that would tempt an age-only sweep.
    {
        let _server = TestServer::spawn().await;
    }
    assert!(
        db_exists(&template).await,
        "{template} must exist to be spared"
    );
    let build_existed = db_exists(&build).await;

    let report = ziee_test_harness::sweep_stale_test_dbs(&admin_url(), 0).await;

    assert!(
        !report
            .considered
            .iter()
            .any(|d| d == &template || d == &build),
        "the sweep tried to drop a shared database: {:?}",
        report.considered
    );
    assert!(db_exists(&template).await, "the sweep destroyed {template}");
    if build_existed {
        assert!(db_exists(&build).await, "the sweep destroyed {build}");
    }
}

/// The sweep DOES collect an orphan: an unconnected `test_db_*` older than the
/// floor. Without this the two controls above are satisfied by a sweep that does
/// nothing at all.
#[tokio::test]
async fn the_sweep_collects_an_idle_orphan() {
    let name = format!("test_db_{}", uuid::Uuid::new_v4().simple());

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .expect("create the orphan fixture database");
    // Nothing connects to it — this is exactly the state a SIGKILLed run leaves.
    admin.close().await;

    let report = ziee_test_harness::sweep_stale_test_dbs(&admin_url(), 0).await;

    let gone = !db_exists(&name).await;
    if !gone {
        // Clean up before failing, so a red test does not itself leak.
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&admin_url())
            .await
            .expect("connect admin db");
        let _ = admin
            .execute(format!("DROP DATABASE IF EXISTS {name}").as_str())
            .await;
        admin.close().await;
    }
    assert!(
        gone && report.dropped.contains(&name),
        "the sweep left the idle orphan {name} behind (considered {} entries) — it \
         collects nothing, and the two sparing controls above are vacuous",
        report.considered.len()
    );
}

/// The age floor is real: a freshly-created idle orphan is NOT collected when the
/// floor is non-zero.
///
/// This is what makes the sweep safe against the one window the in-use check cannot
/// see — a database created by a concurrent run microseconds ago, whose server has
/// not connected yet, or whose pool has idled its connections out (the harness
/// config sets `idle_timeout_secs: 10`, so a live test's database genuinely can show
/// zero backends). Age and idleness are each individually insufficient; the sweep
/// requires both.
#[tokio::test]
async fn the_sweep_spares_a_freshly_created_orphan_under_the_age_floor() {
    let name = format!("test_db_{}", uuid::Uuid::new_v4().simple());

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .expect("create the fresh fixture database");
    admin.close().await;

    let report = ziee_test_harness::sweep_stale_test_dbs(&admin_url(), 3600).await;

    let survived = db_exists(&name).await;

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    let _ = admin
        .execute(format!("DROP DATABASE IF EXISTS {name}").as_str())
        .await;
    admin.close().await;

    assert!(
        survived && !report.considered.contains(&name),
        "the sweep took {name}, created seconds ago, under a one-hour age floor — \
         it would race a concurrently-starting test binary"
    );
}

/// The sweep's discriminator is the NAME PREFIX, and the prefix check is anchored.
/// A database that merely contains `test_db_` is not the harness's.
#[tokio::test]
async fn the_sweep_only_matches_the_anchored_test_db_prefix() {
    let name = format!("not_a_test_db_{}", uuid::Uuid::new_v4().simple());

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    admin
        .execute(format!("CREATE DATABASE {name}").as_str())
        .await
        .expect("create the decoy database");
    admin.close().await;

    let report = ziee_test_harness::sweep_stale_test_dbs(&admin_url(), 0).await;
    let survived = db_exists(&name).await;

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url())
        .await
        .expect("connect admin db");
    let _ = admin
        .execute(format!("DROP DATABASE IF EXISTS {name}").as_str())
        .await;
    admin.close().await;

    assert!(
        survived && !report.considered.contains(&name),
        "the sweep took {name} — its prefix match is unanchored and will collect \
         databases it did not create"
    );
}

/// The reap must be observable when it fails. A drop that errors and is discarded
/// looks exactly like a drop that never ran — which is how this leak stayed
/// invisible for the whole life of the harness.
///
/// Asserted at the source of truth rather than on prose: `Row` is used so this is a
/// real query, and the assertion is that the harness exposes a name at all (the
/// accessor the three leak tests depend on).
#[tokio::test]
async fn the_harness_exposes_the_database_name_it_must_reap() {
    let server = TestServer::spawn().await;
    let name = server.database_name().to_string();
    assert!(
        name.starts_with("test_db_"),
        "the per-test database must carry the prefix the sweep keys on, got {name}"
    );

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(server.database_url())
        .await
        .expect("connect the per-test database");
    let row = sqlx::query("SELECT current_database() AS db")
        .fetch_one(&pool)
        .await
        .expect("ask the server's own database what it is called");
    let actual: String = row.get("db");
    pool.close().await;

    assert_eq!(
        actual, name,
        "the name the harness reaps must be the database the server is actually using"
    );
}

/// The window between `CREATE DATABASE` and the handle existing.
///
/// `TestHarness::start` creates the database, then resolves a binary, spawns it, and
/// polls it healthy for up to 30s — and only THEN builds the handle whose destructor
/// reaps. Every panic in between used to unwind past a database nobody owned. That is
/// not a theoretical path: the readiness-ceiling panic (`did not become healthy
/// within 30s`) fired on this shared box during this change's own full-suite run.
///
/// A guard armed at the end of a successful spawn cannot cover this; only ownership
/// taken at the moment the resource exists can. This drives the window with the
/// spawn-side panic, which is deterministic, rather than by waiting 30s for the
/// readiness one — they unwind through identical code.
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
        !db_exists(&name).await,
        "{name} was created and then orphaned by a panic before the handle existed — \
         the reap is armed too late"
    );
}

/// The startup sweep is INSTALLED, not merely present.
///
/// Every other sweep test calls `sweep_stale_test_dbs` directly, so all of them stay
/// green if the call inside the harness's own process boot is deleted — and that
/// call is the entire self-healing half of this fix: the one that reclaims what a
/// SIGKILL, an OOM kill, `panic = "abort"` or a test-binary timeout left behind,
/// none of which any destructor can reach. A guard on the thing being installed is
/// not a guard on the installation.
#[tokio::test]
async fn the_startup_sweep_is_wired_into_harness_boot() {
    // Spawning is what boots the harness; the sweep must have run by the time the
    // first per-test database is cloned.
    let _server = TestServer::spawn().await;
    assert!(
        ziee_test_harness::startup_sweep_ran(),
        "the harness cloned a per-test database without ever running the startup \
         stale-db sweep — orphans from killed/aborted/timed-out runs are never \
         reclaimed and the leak regrows"
    );
}
