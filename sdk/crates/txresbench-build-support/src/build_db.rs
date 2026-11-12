//! Per-worktree build-DB provisioning for `build.rs` (G4).
//!
//! sqlx compile-time `query!` verification needs a migrated build database.
//! These helpers create + migrate a per-worktree-isolated database on the
//! shared build cluster so concurrent worktree builds don't clobber each
//! other's schema, and hand back the URL to feed sqlx's `DATABASE_URL`.
//!
//! The driver is selected by the `DATABASE_URL` SCHEME at build time — the
//! same compile-time selection the rest of the dual-driver SDK uses:
//!
//!   * `sqlite:`  → the sqlite leg: a build FILE under
//!     `<worktree-root>/target/sqlx-build/` (sentinel) or at the exact path
//!     an operator override names. Wipe = delete the file, not `DROP SCHEMA`.
//!   * anything else → the postgres leg, byte-for-byte the pre-split
//!     behavior (cluster DB, `DROP SCHEMA public CASCADE`, etc.).
//!
//! Two entry points:
//!   - [`ensure_build_db`] — async, CREATE-if-missing only. Used by txresbench's own
//!     `#[tokio::main]` `build.rs`, which owns the schema wipe + multi-source
//!     migrate itself (equivalence-preserving refactor of the former inline
//!     block).
//!   - [`provision_build_db`] — sync, ONE-CALL (derive isolated URL → create →
//!     wipe → migrate → return URL) for a plain app's `build.rs`. Spins its own
//!     current-thread runtime, so it must NOT be called from inside an existing
//!     tokio runtime.

use std::path::{Path, PathBuf};

use crate::worktree_db;

/// Ensure `db_name` exists on the cluster of `base_url`: connect to the
/// maintenance `postgres` database, `CREATE DATABASE` if missing (idempotent +
/// race tolerant — a concurrent creator just makes our CREATE a swallowed
/// duplicate-database error), and return the URL pointing at `db_name`. On a
/// cluster-unreachable error, fall back to `base_url` unchanged so the caller's
/// connect surfaces the real error. Async — the caller must already be on a
/// tokio runtime.
///
/// Under a `sqlite:` `base_url` the same "ensure" contract is fulfilled by a
/// build FILE: `db_name` is the file stem, the file lives under
/// `<worktree-root>/target/sqlx-build/` when `base_url` is the committed
/// sentinel and at the operator-override URL's own path otherwise, and a
/// CREATE-if-missing is a touch (a zero-length file IS a valid empty SQLite
/// database). Still no wipe, no migrate — the caller owns both.
pub async fn ensure_build_db(base_url: &str, db_name: &str) -> String {
    if worktree_db::is_sqlite_url(base_url) {
        return ensure_sqlite_build_db(base_url, db_name).await;
    }
    let admin_url = worktree_db::with_database(base_url, "postgres");
    match sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url)
        .await
    {
        Ok(admin) => {
            let exists: Option<(i32,)> =
                sqlx::query_as("SELECT 1 FROM pg_database WHERE datname = $1")
                    .bind(db_name)
                    .fetch_optional(&admin)
                    .await
                    .ok()
                    .flatten();
            if exists.is_none() {
                // CREATE DATABASE can't run in a tx; ignore the
                // duplicate_database error if another worktree's build raced us.
                let _ = sqlx::query(&format!("CREATE DATABASE {db_name}"))
                    .execute(&admin)
                    .await;
            }
            admin.close().await;
            println!(
                "build.rs: per-worktree build DB → {db_name} \
                 (set TXR_BUILD_DB_PERWORKTREE=0 to disable)"
            );
            worktree_db::with_database(base_url, db_name)
        }
        Err(e) => {
            eprintln!("build.rs: per-worktree DB provisioning skipped: {e}");
            base_url.to_string()
        }
    }
}

/// The sqlite leg of [`ensure_build_db`] — create-if-missing ONLY (see the
/// doc on [`ensure_build_db`] for the contract).
async fn ensure_sqlite_build_db(base_url: &str, db_name: &str) -> String {
    let (path, database_url) = if worktree_db::should_auto_isolate(&Some(base_url.to_string())) {
        // Committed sentinel → derive the per-worktree file. Prefer
        // CARGO_MANIFEST_DIR (build scripts), fall back to CWD for
        // non-build-script callers — both resolve the same worktree root.
        let path = match std::env::var("CARGO_MANIFEST_DIR") {
            Ok(manifest) => worktree_db::sqlite_build_path(&manifest, db_name),
            Err(_) => worktree_db::sqlite_build_path_for_cwd(db_name),
        };
        (path.clone(), worktree_db::sqlite_file_url(&path))
    } else {
        // Operator override → the file the URL names, URL honored byte-for-byte.
        let path = worktree_db::sqlite_url_to_path(base_url);
        (path, base_url.to_string())
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|e| {
            panic!(
                "build.rs: failed to create sqlite build dir {}: {e}",
                parent.display()
            )
        });
    }
    if !path.exists() {
        std::fs::File::create(&path).unwrap_or_else(|e| {
            panic!(
                "build.rs: failed to create sqlite build file {}: {e}",
                path.display()
            )
        });
    }
    println!(
        "build.rs: sqlite build DB ensured → {} (set TXR_BUILD_DB_PERWORKTREE=0 to disable)",
        path.display()
    );
    database_url
}

/// ONE-CALL build-DB provisioning for a plain app's `build.rs` — the ergonomic
/// entry point TxResBench (G4) needed so an app module can use compile-time
/// `query!` verification without copying txresbench's ~60 lines of glue.
///
/// Derives a per-worktree-isolated database name (`<CARGO_PKG_NAME>_build_<key>`)
/// on the shared local build cluster when `DATABASE_URL` is unset / the
/// committed sentinel, honors a genuine external `DATABASE_URL` override
/// unchanged, creates the database, wipes + re-applies `migrations_dir`, and
/// returns the URL to hand to sqlx. Emits `cargo:rustc-env=DATABASE_URL=<url>`.
///
/// Reads `CARGO_MANIFEST_DIR`, `CARGO_PKG_NAME`, and `DATABASE_URL` from the
/// build environment. Creates its own current-thread runtime, so it must be
/// called from a SYNC `fn main()` (NOT a `#[tokio::main]` one).
pub fn provision_build_db(migrations_dir: &Path) -> String {
    let pkg = std::env::var("CARGO_PKG_NAME").unwrap_or_else(|_| "app".to_string());
    // Sanitize the package name to a valid unquoted postgres identifier.
    let pkg_ident: String = pkg
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    provision_build_db_named(&format!("{pkg_ident}_build_"), migrations_dir)
}

/// [`provision_build_db`] with an explicit database-name prefix (the per-worktree
/// key is appended). Use when the default `<CARGO_PKG_NAME>_build_` prefix isn't
/// what you want.
///
/// The leg is chosen by the `DATABASE_URL` scheme (see [`BuildDbLeg`]); the
/// postgres leg is byte-for-byte the pre-split behavior.
pub fn provision_build_db_named(db_prefix: &str, migrations_dir: &Path) -> String {
    println!("cargo:rerun-if-env-changed=DATABASE_URL");
    println!("cargo:rerun-if-env-changed=TXR_BUILD_DB_PERWORKTREE");
    println!("cargo:rerun-if-changed={}", migrations_dir.display());

    let explicit = std::env::var("DATABASE_URL").ok();
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build.rs: failed to build current-thread runtime");

    let database_url = rt.block_on(async move {
        match build_db_leg(&explicit) {
            BuildDbLeg::Sqlite => {
                let url = explicit
                    .as_deref()
                    .unwrap_or(worktree_db::DEFAULT_SQLITE_BUILD_URL);
                provision_sqlite_build_db(url, db_prefix, &manifest_dir, migrations_dir).await
            }
            BuildDbLeg::Postgres => {
                provision_postgres_build_db(&explicit, db_prefix, &manifest_dir, migrations_dir)
                    .await
            }
        }
    });

    println!("cargo:rustc-env=DATABASE_URL={database_url}");
    database_url
}

/// Which driver leg [`provision_build_db_named`] takes for a given
/// `DATABASE_URL`. The scheme decides, not the isolation rule: an unset or
/// postgres URL keeps txresbench's legacy path; ANY `sqlite:` URL (sentinel or
/// override) takes the file leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BuildDbLeg {
    Postgres,
    Sqlite,
}

/// The dispatch rule, pure and testable (the (scheme, expected leg) table).
pub(crate) fn build_db_leg(explicit: &Option<String>) -> BuildDbLeg {
    match explicit.as_deref() {
        Some(url) if worktree_db::is_sqlite_url(url) => BuildDbLeg::Sqlite,
        _ => BuildDbLeg::Postgres,
    }
}

/// The postgres leg — the historical provision body, unchanged: derive the
/// isolated DB name on the shared cluster (or honor an override), connect,
/// `DROP SCHEMA public CASCADE` + recreate, migrate, return the URL.
async fn provision_postgres_build_db(
    explicit: &Option<String>,
    db_prefix: &str,
    manifest_dir: &str,
    migrations_dir: &Path,
) -> String {
    let database_url = if worktree_db::should_auto_isolate(explicit) {
        let base = explicit
            .clone()
            .unwrap_or_else(|| worktree_db::DEFAULT_BUILD_DB_URL.to_string());
        let db_name = format!("{db_prefix}{}", worktree_db::worktree_key(manifest_dir));
        ensure_build_db(&base, &db_name).await
    } else {
        explicit
            .clone()
            .unwrap_or_else(|| worktree_db::DEFAULT_BUILD_DB_URL.to_string())
    };

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .unwrap_or_else(|e| panic!("build.rs: failed to connect to build DB: {e}"));

    // Wipe + reapply the migration set (idempotent, isolated schema).
    sqlx::query("DROP SCHEMA IF EXISTS public CASCADE")
        .execute(&pool)
        .await
        .ok();
    sqlx::query("CREATE SCHEMA public")
        .execute(&pool)
        .await
        .expect("build.rs: create schema failed");
    sqlx::query("GRANT ALL ON SCHEMA public TO PUBLIC")
        .execute(&pool)
        .await
        .ok();

    let migrator = sqlx::migrate::Migrator::new(migrations_dir)
        .await
        .unwrap_or_else(|e| panic!("build.rs: migrator create failed: {e}"));
    if let Err(e) = migrator.run(&pool).await {
        panic!("build.rs: migration apply failed: {e}");
    }
    pool.close().await;
    database_url
}

/// The sqlite leg: resolve the build FILE (per-worktree file for the committed
/// sentinel, the URL's own path for an operator override), wipe it (delete —
/// a sqlite file has no `DROP SCHEMA`), migrate it, return the URL. The
/// migration dir must be the SQLite-dialect chain (the dialect is a caller
/// property; the leg does not translate).
async fn provision_sqlite_build_db(
    url: &str,
    db_prefix: &str,
    manifest_dir: &str,
    migrations_dir: &Path,
) -> String {
    let (path, database_url) = if worktree_db::should_auto_isolate(&Some(url.to_string())) {
        // Committed sentinel → `<worktree-root>/target/sqlx-build/<prefix><key>.sqlite`.
        let db_name = format!("{db_prefix}{}", worktree_db::worktree_key(manifest_dir));
        let path = worktree_db::sqlite_build_path(manifest_dir, &db_name);
        (path.clone(), worktree_db::sqlite_file_url(&path))
    } else {
        // Operator override → the file the URL names; URL honored byte-for-byte.
        let path = worktree_db::sqlite_url_to_path(url);
        (path, url.to_string())
    };

    // Wipe: delete the file (+ sidecars) so the build DB is exactly what the
    // migration set produces — the file analogue of DROP SCHEMA public CASCADE.
    remove_sqlite_file(&path);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|e| {
            panic!(
                "build.rs: failed to create sqlite build dir {}: {e}",
                parent.display()
            )
        });
    }

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap_or_else(|e| {
            panic!(
                "build.rs: failed to open sqlite build DB {}: {e}",
                path.display()
            )
        });

    let migrator = sqlx::migrate::Migrator::new(migrations_dir)
        .await
        .unwrap_or_else(|e| panic!("build.rs: migrator create failed: {e}"));
    if let Err(e) = migrator.run(&pool).await {
        panic!("build.rs: sqlite migration apply failed: {e}");
    }
    pool.close().await;

    println!(
        "build.rs: per-worktree sqlite build DB → {}",
        path.display()
    );
    database_url
}

/// Delete a sqlite build file and its sidecars. Missing files are fine; any
/// other removal error is a loud warning (a stale sidecar must never silently
/// survive a wipe).
fn remove_sqlite_file(path: &Path) {
    let base = path.as_os_str();
    for sidecar in ["-wal", "-shm", "-journal", ""] {
        let mut p = base.to_os_string();
        p.push(sidecar);
        let p = PathBuf::from(p);
        if let Err(e) = std::fs::remove_file(&p) {
            if e.kind() != std::io::ErrorKind::NotFound {
                println!(
                    "cargo:warning=build.rs: stale sqlite build file {} not removed: {e}",
                    p.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Mutex, MutexGuard};

    use super::*;
    use tempfile::tempdir;

    /// The tests below mutate process env (`DATABASE_URL`, `CARGO_MANIFEST_DIR`)
    /// which `provision_build_db_named` reads — serialize ALL env-touching
    /// tests on one lock so parallel test threads cannot interleave.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// (scheme, expected leg) — the dispatch table the plan pins (TEST-11):
    /// the leg is chosen by scheme, and the isolation rule is leg-internal.
    #[test]
    fn build_db_leg_dispatch_table() {
        let cases: &[(Option<&str>, BuildDbLeg)] = &[
            (None, BuildDbLeg::Postgres),
            (Some(""), BuildDbLeg::Postgres),
            (
                Some(worktree_db::DEFAULT_BUILD_DB_URL),
                BuildDbLeg::Postgres,
            ),
            (
                Some("postgresql://u:p@db.prod:5432/real"),
                BuildDbLeg::Postgres,
            ),
            (
                Some(worktree_db::DEFAULT_SQLITE_BUILD_URL),
                BuildDbLeg::Sqlite,
            ),
            (Some("sqlite:///data/op.sqlite"), BuildDbLeg::Sqlite),
            (Some("sqlite:plain.sqlite"), BuildDbLeg::Sqlite),
        ];
        for (url, expected) in cases {
            let got = build_db_leg(&url.map(|s| s.to_string()));
            assert_eq!(&got, expected, "scheme {url:?}");
        }
    }

    /// A one-step sqlite migration set for the fixture (SQLite dialect — the
    /// only thing the leg itself requires).
    fn write_migrations(dir: &Path, extra: bool) {
        fs::write(
            dir.join("20260101000000_build_db_probe_init.sql"),
            "CREATE TABLE build_db_probe (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);\n",
        )
        .unwrap();
        if extra {
            fs::write(
                dir.join("20260101000001_build_db_probe_extra.sql"),
                "ALTER TABLE build_db_probe ADD COLUMN extra TEXT;\n",
            )
            .unwrap();
        }
    }

    /// The sqlite provision leg against a tempdir operator override: creates
    /// the file, wipes it (delete + re-migrate), applies the given migration
    /// dir, and returns the `sqlite://` URL.
    #[test]
    fn sqlite_provision_leg_creates_wipes_and_migrates() {
        let _guard = lock_env();
        let tmp = tempdir().unwrap();
        let migrations = tmp.path().join("migrations");
        fs::create_dir_all(&migrations).unwrap();
        write_migrations(&migrations, false);

        let db_path = tmp.path().join("build").join("op.sqlite");
        let url = format!("sqlite://{}", db_path.display());
        std::env::set_var("DATABASE_URL", &url);
        // A bogus manifest dir — the override path must not consult it.
        std::env::set_var("CARGO_MANIFEST_DIR", tmp.path().join("src-app/server"));

        let returned = provision_build_db_named("test_build_", &migrations);
        assert_eq!(returned, url, "operator override is honored byte-for-byte");
        assert!(db_path.exists(), "provision created the file");

        // Prove the migrated state from a fresh connection.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let pool = sqlx::sqlite::SqlitePool::connect(&url).await.unwrap();
            let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(applied, 1, "the one fixture migration applied");
            sqlx::query("INSERT INTO build_db_probe (name) VALUES ('stale')")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        });

        // Wipe: a second provision with an EXTRA migration must start from a
        // deleted file — the 'stale' row is gone and the extra migration applied.
        write_migrations(&migrations, true);
        let returned = provision_build_db_named("test_build_", &migrations);
        assert_eq!(returned, url);
        rt.block_on(async {
            let pool = sqlx::sqlite::SqlitePool::connect(&url).await.unwrap();
            let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(applied, 2, "the added migration applied after the wipe");
            let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM build_db_probe")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(rows, 0, "wipe is a DELETE, not a truncate");
            pool.close().await;
        });
    }

    /// The sentinel leg: derives the per-worktree file under
    /// `<worktree>/target/sqlx-build/<prefix><key>.sqlite` and returns the
    /// absolute `sqlite://` URL (the marker itself is never opened).
    #[test]
    fn sqlite_provision_leg_auto_isolates_the_sentinel() {
        let _guard = lock_env();
        let tmp = tempdir().unwrap();
        let migrations = tmp.path().join("migrations");
        fs::create_dir_all(&migrations).unwrap();
        write_migrations(&migrations, false);

        let manifest = tmp.path().join("src-app/server");
        std::env::set_var("DATABASE_URL", worktree_db::DEFAULT_SQLITE_BUILD_URL);
        std::env::set_var("CARGO_MANIFEST_DIR", &manifest);

        let returned = provision_build_db_named("txresbench_build_", &migrations);
        assert!(
            returned.starts_with("sqlite://"),
            "returns a sqlite URL: {returned}"
        );

        let key = worktree_db::worktree_key(&manifest.to_string_lossy());
        let expected = worktree_db::sqlite_build_path(
            &manifest.to_string_lossy(),
            &format!("txresbench_build_{key}"),
        );
        assert_eq!(
            returned,
            worktree_db::sqlite_file_url(&expected),
            "sentinel → per-worktree absolute file URL"
        );
        assert!(
            expected.exists(),
            "derived file created: {}",
            expected.display()
        );
        assert!(expected
            .display()
            .to_string()
            .ends_with(&format!("target/sqlx-build/txresbench_build_{key}.sqlite")));
    }

    /// `ensure_build_db`'s sqlite leg (create-if-missing only): the sentinel
    /// derives the per-worktree file, the operator override is honored
    /// byte-for-byte, and neither leg wipes or migrates.
    #[test]
    fn ensure_build_db_sqlite_leg_touches_and_returns() {
        let _guard = lock_env();
        let tmp = tempdir().unwrap();
        let manifest = tmp.path().join("src-app/server");
        std::env::set_var("CARGO_MANIFEST_DIR", &manifest);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let u = rt.block_on(async {
            ensure_build_db(
                worktree_db::DEFAULT_SQLITE_BUILD_URL,
                "dummy_build_a1b2c3d4",
            )
            .await
        });
        let path = tmp
            .path()
            .join("target/sqlx-build/dummy_build_a1b2c3d4.sqlite");
        assert_eq!(u, worktree_db::sqlite_file_url(&path));
        assert!(path.exists(), "sentinel ensure created the derived file");

        let op = tmp.path().join("elsewhere").join("op-ensured.sqlite");
        let op_url = format!("sqlite://{}", op.display());
        let u2 = rt.block_on(async {
            let op_url = op_url.clone();
            ensure_build_db(&op_url, "ignored_stem").await
        });
        assert_eq!(u2, op_url, "override ensured byte-for-byte");
        assert!(
            op.exists(),
            "override ensure created the file at its own path"
        );
    }

    // ── SDK build-script shapes (ITEM-4, TEST-12) ───────────────────────────

    /// The (db-name prefix, crate-dir leaf) pairs the schema-bound SDK crate
    /// build scripts provision — `txresbench-auth` and `txresbench-file`. The prefixes are
    /// the plan's names (`txresbench_auth_build_` / `txresbench_file_build_`); the key is
    /// appended by the shared `worktree_key` derivation.
    const SDK_CRATE_SHAPES: &[(&str, &str)] = &[
        ("txresbench_auth_build_", "txresbench-auth"),
        ("txresbench_file_build_", "txresbench-file"),
    ];

    /// TEST-12 — the SQLITE leg of the SDK build scripts: with a `sqlite://`
    /// DATABASE_URL and an SDK-crate-shaped manifest dir (no `/src-app`
    /// marker → the worktree root IS the crate dir), the build script
    /// provisions the per-worktree FILE `<crate>/target/sqlx-build/
    /// <prefix><key>.sqlite`, applies the given chain to it, and returns the
    /// URL whose path decodes back to that exact file (the URL the sqlx macros
    /// end up reading). The POSTGRES leg derives the SAME per-crate identity
    /// (`<prefix><key>` on the shared cluster) — asserted via the shared
    /// derivation, so the two legs can never disagree on isolation.
    #[test]
    fn sdk_build_scripts_provision_their_crate_files() {
        let _guard = lock_env();
        let tmp = tempdir().unwrap();
        let migrations = tmp.path().join("migrations");
        fs::create_dir_all(&migrations).unwrap();
        write_migrations(&migrations, false);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        for (prefix, crate_name) in SDK_CRATE_SHAPES {
            let manifest = tmp.path().join("sdk").join("crates").join(crate_name);
            fs::create_dir_all(&manifest).unwrap();
            assert!(
                !manifest.to_string_lossy().contains("/src-app"),
                "SDK crate dirs carry no /src-app marker: {crate_name}"
            );
            std::env::set_var("DATABASE_URL", worktree_db::DEFAULT_SQLITE_BUILD_URL);
            std::env::set_var("CARGO_MANIFEST_DIR", &manifest);

            let returned = provision_build_db_named(prefix, &migrations);

            let key = worktree_db::worktree_key(&manifest.to_string_lossy());
            let file = worktree_db::sqlite_build_path(
                &manifest.to_string_lossy(),
                &format!("{prefix}{key}"),
            );
            assert_eq!(
                worktree_db::sqlite_url_to_path(&returned),
                file,
                "the returned URL decodes to the provisioned file ({crate_name})"
            );
            assert!(
                file.display()
                    .to_string()
                    .ends_with(&format!("target/sqlx-build/{prefix}{key}.sqlite")),
                "file stem = <prefix><key>.sqlite ({crate_name}): {}",
                file.display()
            );
            assert!(file.exists(), "provision created the file ({crate_name})");

            // The file is migrated (the applied count proves the leg ran the
            // chain, not merely touched the file).
            let url = returned.clone();
            rt.block_on(async move {
                let pool = sqlx::sqlite::SqlitePool::connect(&url).await.unwrap();
                let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                assert_eq!(applied, 1, "the fixture migration applied ({crate_name})");
                pool.close().await;
            });

            // The postgres leg derives the SAME per-crate DB name — the shared
            // suffix is what keeps the two legs' isolation identities aligned.
            assert_eq!(
                worktree_db::with_database(
                    worktree_db::DEFAULT_BUILD_DB_URL,
                    &format!("{prefix}{key}")
                ),
                format!("postgresql://postgres:password@127.0.0.1:54321/{prefix}{key}"),
                "same <prefix><key> identity on the cluster ({crate_name})"
            );
            assert_eq!(
                build_db_leg(&Some(worktree_db::DEFAULT_BUILD_DB_URL.to_string())),
                BuildDbLeg::Postgres,
                "PG sentinel still selects the postgres leg ({crate_name})"
            );
        }
    }
}
