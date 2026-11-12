//! Generic SQLite bootstrap — the driver-side counterpart of `embedded_pg`
//! (Chunk BG-3).
//!
//! `embedded_pg` builds the app's runtime PostgreSQL instance and PG pool;
//! this module is the SQLite-variant half of the same seam: connect to the
//! app's SQLite file (create-if-missing), apply the app's merged [`Migrator`],
//! cache the process-wide pool, and expose the matching `get_database_pool` /
//! `cleanup_database` accessors. The two modules are never selected at
//! runtime — the driver is chosen at COMPILE time by the SDK feature set
//! (`embedded-pg` vs `sqlite-backend`), so a binary links exactly one.
//!
//! **The option profile** (pragmas are correctness properties, not tuning):
//!
//! - `create_if_missing` — the DB file is the app's whole state; first boot
//!   creates it, later boots open it.
//! - `journal_mode = WAL` + `synchronous = NORMAL` — concurrent local reads
//!   with a single-writer app (the jobs runner's writes serialize on the
//!   `busy_timeout`, matching the WAL + small-write-transaction profile the
//!   DEC-7 decision records).
//! - `foreign_keys = ON` — SQLite ignores FK constraints by default; the
//!   framework's schema relies on cascade/restrict semantics, so the pragma is
//!   forced on every connection.
//! - `busy_timeout` — from `database.pool.busy_timeout_ms` (default 5000 ms);
//!   a contended write WAITS instead of erroring immediately.
//!
//! No Postgres process, no ports, no `pg_ctl`, no binary download — the file
//! lifecycle is the only state. The caller resolves the connection target
//! (its override chain: `database.path` > `database.url` > environment >
//! default `<app data dir>/txresbench.db`); this module accepts either a
//! `sqlite:` URL or a plain filesystem path.
//!
//! ## Recreation rule (unchanged from embedded_pg's baseline doctrine)
//!
//! A pre-existing SQLite file that was created by an OLDER migration chain is
//! NOT upgradeable — `_sqlx_migrations` records versions that no longer
//! exist and the next boot fails loudly on the first baseline. Delete the
//! file (plus its `-wal`/`-shm` sidecars) to recreate the schema from scratch;
//! this module deliberately uses plain (non-`IF NOT EXISTS`) DDL through the
//! migrator so the conflict is loud, not half-applied.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use sqlx::migrate::Migrator;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use tokio::sync::OnceCell;

use txresbench_core::config::DatabasePoolConfig;

static DATABASE_POOL: OnceCell<Arc<SqlitePool>> = OnceCell::const_new();

/// Build the SQLite connect options for the DEC-7 profile. Split out of
/// [`initialize_database`] so the pragma set is one reviewable pure function
/// (and unit-testable against a real connection).
pub fn connect_options(
    url_or_path: &str,
    pool: &DatabasePoolConfig,
) -> Result<SqliteConnectOptions, sqlx::Error> {
    let mut options = if url_or_path.starts_with("sqlite:") {
        SqliteConnectOptions::from_str(url_or_path)?
    } else {
        SqliteConnectOptions::new().filename(url_or_path)
    };
    options = options
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_millis(pool.busy_timeout_ms));
    Ok(options)
}

/// Initialize (once) the process-wide SQLite pool: open the file (create if
/// missing), apply `migrator`, cache the pool. Idempotent — a second call
/// returns the cached pool like the embedded-PG path.
///
/// The connection target is the caller's resolved value: a `sqlite:` URL or a
/// plain filesystem path (see the module docs for the override chain). A
/// failure is a HARD error naming the target — the app refuses to boot rather
/// than serve with a half-initialized store.
pub async fn initialize_database(
    url_or_path: &str,
    pool: &DatabasePoolConfig,
    migrator: &'static Migrator,
) -> Result<Arc<SqlitePool>, Box<dyn std::error::Error + Send + Sync>> {
    let pooled = DATABASE_POOL
        .get_or_try_init(|| async move {
            let options = connect_options(url_or_path, pool)
                .map_err(|e| format!("invalid sqlite database target '{url_or_path}': {e}"))?;
            let p = SqlitePoolOptions::new()
                .max_connections(pool.max_connections)
                .min_connections(pool.min_connections)
                .acquire_timeout(Duration::from_secs(pool.acquire_timeout_secs))
                .connect_with(options)
                .await
                .map_err(|e| format!("failed to open sqlite database '{url_or_path}': {e}"))?;

            migrator.run(&p).await.map_err(|e| {
                format!("failed to migrate sqlite database '{url_or_path}': {e}")
            })?;
            log_schema_version(&p).await;

            Ok::<Arc<SqlitePool>, Box<dyn std::error::Error + Send + Sync>>(Arc::new(p))
        })
        .await?;

    Ok(pooled.clone())
}

/// Log the schema version + applied-migration count after a successful
/// migrate — the boot log line the operator greps for (`_sqlx_migrations` is
/// the migrator's own bookkeeping table).
async fn log_schema_version(pool: &SqlitePool) {
    let res = sqlx::query_as::<_, (i64, i64)>(
        "SELECT COALESCE(MAX(version), 0), COUNT(*) FROM _sqlx_migrations",
    )
    .fetch_one(pool)
    .await;
    match res {
        Ok((version, count)) => {
            tracing::info!(
                "SQLite database ready: schema version {}, {} applied migrations",
                version,
                count
            );
        }
        Err(e) => tracing::warn!(
            error = %e,
            "migrator ran but the schema-version log query failed — NOT a boot \
             failure, the migration itself already succeeded"
        ),
    }
}

/// The process-wide SQLite pool, or `PoolTimedOut` when the DB never
/// initialized (same contract as `embedded_pg::get_database_pool`).
pub fn get_database_pool() -> Result<Arc<SqlitePool>, sqlx::Error> {
    DATABASE_POOL
        .get()
        .cloned()
        .ok_or(sqlx::Error::PoolTimedOut)
}

/// Close the pool and checkpoint the WAL (TRUNCATE) so the `-wal` sidecar is
/// folded back into the main file. Idempotent.
pub async fn cleanup_database() {
    tracing::info!("Cleaning up SQLite database...");
    if let Some(pool) = DATABASE_POOL.get() {
        // Checkpoint BEFORE closing: the checkpoint needs an open connection,
        // and TRUNCATE folds the WAL fully back into the DB file (a plain
        // checkpoint would leave the sidecar around). A failure here is
        // logged, not fatal — the WAL is durable either way.
        match sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_all(pool.as_ref())
            .await
        {
            Ok(_) => tracing::info!("SQLite WAL checkpointed (TRUNCATE)"),
            Err(e) => tracing::warn!(error = %e, "SQLite WAL checkpoint failed"),
        }
        pool.close().await;
        tracing::info!("SQLite database pool closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use txresbench_core::config::DatabasePoolConfig;

    /// The DEC-7 profile must actually be in force on a real connection:
    /// journal mode WAL, synchronous NORMAL, foreign_keys ON, busytimeout
    /// honored. Uses a temp FILE (not `:memory:`, where WAL is inapplicable).
    #[tokio::test]
    async fn connect_options_apply_the_documented_pragma_profile() {
        let dir = tempfile::tempdir().expect("tempdir for sqlite profile test");
        let db_path = dir.path().join("profile.db");
        let pool_cfg = DatabasePoolConfig::default();
        let options = connect_options(db_path.to_str().unwrap(), &pool_cfg).unwrap();
        let pool = SqlitePool::connect_with(options).await.expect("open temp sqlite");

        let journal: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(journal.0.to_ascii_lowercase(), "wal");

        let sync: (i64,) = sqlx::query_as("PRAGMA synchronous").fetch_one(&pool).await.unwrap();
        assert_eq!(sync.0, 1, "synchronous=NORMAL is 1");

        let fk: (i64,) = sqlx::query_as("PRAGMA foreign_keys").fetch_one(&pool).await.unwrap();
        assert_eq!(fk.0, 1, "foreign_keys must be ON (SQLite defaults it OFF)");

        let busy: (i64,) = sqlx::query_as("PRAGMA busy_timeout").fetch_one(&pool).await.unwrap();
        assert_eq!(busy.0, pool_cfg.busy_timeout_ms as i64);
    }

    /// Plain filesystem paths and `sqlite:` URLs are both accepted; a bare
    /// path is never interpreted as a URL with a host component.
    #[test]
    fn connect_options_accept_paths_and_urls() {
        let pool_cfg = DatabasePoolConfig::default();
        let from_path = connect_options("some-dir/db.sqlite", &pool_cfg).unwrap();
        assert_eq!(from_path.get_filename(), std::path::Path::new("some-dir/db.sqlite"));
        // `sqlite:///abs/db.sqlite` = absolute path `/abs/db.sqlite` (three
        // slashes; two would be a relative URL).
        let from_url = connect_options("sqlite:///abs/db.sqlite", &pool_cfg).unwrap();
        assert_eq!(from_url.get_filename(), std::path::Path::new("/abs/db.sqlite"));
    }
}
