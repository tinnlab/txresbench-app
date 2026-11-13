//! Shared throwaway-DB harness for `txresbench-auth`'s crate-scoped integration tests.
//!
//! Each test provisions a fresh, uniquely-named database, applies the crate's
//! OWN migrator (`AUTH_MIGRATOR` — the schema + fkeys + seed set, in version
//! order), hands back a pool, and drops the DB on teardown. Mirrors the
//! committed patterns in the SDK's other crate-scoped test suites (the
//! notification crate's schema_and_models test), except it runs the real
//! `Migrator` so the seed rows (Administrators/Users groups, the 3 auth
//! providers, the `session_settings` singleton) are present — the auth
//! repositories depend on them.
//!
//! Dual-driver: the postgres leg provisions a cluster DB on the shared
//! `:54321` (the historical behavior); the sqlite leg provisions a fresh FILE
//! under `TMPDIR` (a directory per test) and drops it by unlinking the file +
//! `-wal`/`-shm` sidecars. The first value of `(DbPool, String)` is the pool;
//! the second is the opaque "database identity" the test threads to `drop_db`.

// Each integration-test binary includes this module and uses only a subset of
// its helpers, so silence the per-binary dead-code pass.
#![allow(dead_code)]

/// A lazy pool of the build's driver for tests that need a pool TYPE but
/// never dial (the wiring/mounting tests). `connect_lazy` never connects,
/// so both legs are DB-free.
pub fn lazy_test_pool() -> DbPool {
    #[cfg(not(feature = "sqlite-backend"))]
    {
        sqlx::postgres::PgPool::connect_lazy(
            "postgresql://postgres:password@127.0.0.1:54321/postgres",
        )
        .expect("lazy pool")
    }
    #[cfg(feature = "sqlite-backend")]
    {
        sqlx::sqlite::SqlitePool::connect_lazy("sqlite::memory:").expect("lazy pool")
    }
}

#[cfg(not(feature = "sqlite-backend"))]
use sqlx::{Connection, Executor};
use uuid::Uuid;
use txresbench_core::DbPool;

/// One of the seeded `auth_providers` rows (google) — a valid FK target for
/// `oauth_sessions` / `pending_account_links` / `user_auth_links`.
pub const SEEDED_PROVIDER_ID: &str = "92e74a99-ffa4-4c49-a05f-4a2b3e2b2efe";

/// The seeded default group (`Users`, `is_default = true`).
pub const DEFAULT_GROUP_NAME: &str = "Users";

#[cfg(not(feature = "sqlite-backend"))]
pub fn admin_url() -> String {
    std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://postgres:password@127.0.0.1:54321/postgres".to_string())
}

/// Provision a fresh throwaway DB, run the crate's `AUTH_MIGRATOR`, return
/// `(pool, dbname)`. The migrator applying at all IS the standalone-apply proof.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn fresh_db() -> (DbPool, String) {
    let admin = admin_url();
    let base_full = admin.split('?').next().unwrap();
    let (base, _) = base_full.rsplit_once('/').expect("admin url has a /db suffix");
    let dbname = format!("txresbench_auth_test_{}", Uuid::new_v4().simple());

    let mut conn = sqlx::PgConnection::connect(&admin).await.expect("connect admin db");
    conn.execute(format!("CREATE DATABASE \"{dbname}\"").as_str())
        .await
        .expect("create test db");
    conn.close().await.ok();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(&format!("{base}/{dbname}"))
        .await
        .expect("connect test db");

    txresbench_auth::AUTH_MIGRATOR
        .run(&pool)
        .await
        .expect("AUTH_MIGRATOR applies (schema + fkeys + seed) on a bare DB");

    (pool, dbname)
}

/// Provision a fresh FILE DB (sqlite leg), run the crate's sqlite
/// `AUTH_MIGRATOR`, return `(pool, file_path)`. The file (and its WAL/SHM
/// sidecars) lives under a per-test directory so teardown is a single unlink.
#[cfg(feature = "sqlite-backend")]
pub async fn fresh_db() -> (DbPool, String) {
    let dir = std::env::temp_dir().join(format!("txresbench_auth_test_{}", Uuid::new_v4().simple()));
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

    txresbench_auth::AUTH_MIGRATOR
        .run(&pool)
        .await
        .expect("AUTH_MIGRATOR applies (schema + fkeys + seed) on a bare file");

    (pool, path.to_string_lossy().into_owned())
}

#[cfg(not(feature = "sqlite-backend"))]
pub async fn drop_db(dbname: &str) {
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
