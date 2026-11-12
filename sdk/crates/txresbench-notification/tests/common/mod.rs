//! Shared throwaway-DB harness for `txresbench-notification`'s crate-scoped
//! integration tests.
//!
//! Each test provisions a fresh, uniquely-named database, applies the crate's
//! OWN migration (the `notifications` inbox baseline), hands back a pool, and
//! drops the DB on teardown.
//!
//! Dual-driver (sqlite-store DEC-1): the postgres leg provisions a cluster DB
//! on the shared `:54321` (the historical behavior — `include_str!` of the PG
//! migration from the retained `migrations-pg/` chain, the driver's own file
//! since ITEM-26); the sqlite leg provisions a fresh FILE under
//! `TMPDIR` (a directory per test) and applies the crate's sqlite
//! `NOTIFICATION_MIGRATOR`, and drops it by unlinking the file + `-wal`/`-shm`
//! sidecars. The first value of `(DbPool, String)` is the pool; the second is
//! the opaque "database identity" the test threads to `drop_db`.

// Each integration-test binary includes this module and uses only a subset of
// its helpers, so silence the per-binary dead-code pass.
#![allow(dead_code)]

use uuid::Uuid;

/// The pool type of the leg under test. Local alias rather than
/// `txresbench_core::DbPool`: `txresbench-core` is an optional (routes-gated) dependency of
/// this crate, and the crate's types-only `default` lane must still be able to
/// compile its schema-control tests. The alias tracks the same driver rule
/// `txresbench_core::DbPool` implements.
#[cfg(not(feature = "sqlite-backend"))]
pub type DbPool = sqlx::PgPool;
#[cfg(feature = "sqlite-backend")]
pub type DbPool = sqlx::SqlitePool;

#[cfg(not(feature = "sqlite-backend"))]
pub fn admin_url() -> String {
    std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://postgres:password@127.0.0.1:54321/postgres".to_string())
}

/// Provision a fresh throwaway DB and apply the crate's migration. The migration
/// applying at all IS the standalone-apply proof (no domain tables present).
#[cfg(not(feature = "sqlite-backend"))]
pub async fn fresh_db() -> (DbPool, String) {
    use sqlx::{Connection, Executor};

    let admin = admin_url();
    let (base, _) = admin.rsplit_once('/').expect("admin url has a /db suffix");
    let dbname = format!("txresbench_notif_test_{}", Uuid::new_v4().simple());

    let mut conn = sqlx::PgConnection::connect(&admin)
        .await
        .expect("connect admin db");
    conn.execute(format!("CREATE DATABASE \"{dbname}\"").as_str())
        .await
        .expect("create test db");
    conn.close().await.ok();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&format!("{base}/{dbname}"))
        .await
        .expect("connect test db");

    pool.execute(include_str!(
        "../../migrations-pg/202607140190_notification_schema.sql"
    ))
    .await
    .expect("crate migration applies standalone on a bare DB");

    (pool, dbname)
}

/// Provision a fresh FILE DB (sqlite leg), apply the crate's sqlite
/// `NOTIFICATION_MIGRATOR`, return `(pool, file_path)`. The file (and its
/// WAL/SHM sidecars) lives under a per-test directory so teardown is a single
/// unlink.
#[cfg(feature = "sqlite-backend")]
pub async fn fresh_db() -> (DbPool, String) {
    let dir = std::env::temp_dir().join(format!("txresbench_notif_test_{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("create per-test dir");
    let path = dir.join("test.sqlite");

    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .expect("connect test file");

    txresbench_notification::NOTIFICATION_MIGRATOR
        .run(&pool)
        .await
        .expect("NOTIFICATION_MIGRATOR applies the sqlite chain on a bare file");

    (pool, path.to_string_lossy().into_owned())
}

#[cfg(not(feature = "sqlite-backend"))]
pub async fn drop_db(dbname: &str) {
    use sqlx::{Connection, Executor};

    if let Ok(mut conn) = sqlx::PgConnection::connect(&admin_url()).await {
        let _ = conn
            .execute(format!("DROP DATABASE IF EXISTS \"{dbname}\" WITH (FORCE)").as_str())
            .await;
        conn.close().await.ok();
    }
}

/// Unlink the per-test file + its sidecars. SQLite keeps an open pool usable
/// for the rest of the test (the file is already unlinked); a busy holder's
/// checkpoint is irrelevant because the file is scratch state.
#[cfg(feature = "sqlite-backend")]
pub async fn drop_db(path: &str) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{path}-wal"));
    let _ = std::fs::remove_file(format!("{path}-shm"));
    if let Some(dir) = std::path::Path::new(path).parent() {
        let _ = std::fs::remove_dir(dir);
    }
}
