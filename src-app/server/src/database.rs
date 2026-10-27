//! Database bootstrap — the SQLite store shim over `ziee_framework::embedded_db`
//! (the driver-side counterpart of `embedded_pg`, which this app never starts
//! or embeds any more).
//!
//! The framework owns the app-agnostic lifecycle: the local FILE (create-if-
//! missing), the DEC-7 pragma profile (WAL, synchronous=NORMAL, foreign_keys=ON,
//! busy_timeout from `database.pool`), the pool (max/min/acquire from
//! `database.pool`), the process-wide pool cache, and the WAL checkpoint on
//! cleanup. We supply only the two app-bound pieces it is parameterized over:
//!   - the resolved database target — `CYTO_DATABASE_URL` >
//!     `database.url` > `database.path` > `<app-data-dir>/txresbench.db`
//!     (src/config.rs, DEC-13's precedence as amended), where the app data
//!     dir is `modules::rootfs::data_root()` (`CYTO_APP_DATA_DIR`, else the
//!     desktop's `~/.txresbench`);
//!   - `MERGED_MIGRATOR` — our merged (`migrations-merged`) migration set, with
//!     `set_ignore_missing(true)` so a subset-owning binary is tolerated. See
//!     its doc comment for the rule that follows from checksum verification.
//!
//! There is no server process, no port, no `pg_ctl`, no stop/cleanup hook for
//! anything but the pool: the file (+ its `-wal`/`-shm` sidecars) is the whole
//! store. No network access and no binary download — the engine is the
//! sqlx-bundled libsqlite3 amalgamation (INV-1).

use std::sync::Arc;

use sqlx::SqlitePool;
use ziee_core::ServerConfig;
use ziee_framework::embedded_db;

/// The merged migration set composed by build.rs (driver-selected: the staged
/// `migrations-sqlite/` chain under a `sqlite:` `DATABASE_URL` — the committed
/// state since the ITEM-12 flip), version-sorted. `LazyLock` so the framework
/// receives a `&'static Migrator`.
///
/// ## AN APPLIED MIGRATION FILE IS IMMUTABLE — INCLUDING ITS COMMENTS
///
/// `sqlx::migrate!` stores a CHECKSUM of each migration's FULL FILE BYTES in
/// `_sqlx_migrations` and re-verifies it on every boot, so editing a
/// **`--` comment** in an already-applied file is just as fatal as editing its
/// DDL: the next startup fails with `VersionMismatch` on every database that
/// already ran it. There is no "cosmetic" migration edit.
///
/// `set_ignore_missing(true)` below does NOT soften this, and that asymmetry is
/// the whole footgun: it tolerates an applied migration whose FILE IS ABSENT
/// (so a subset-owning binary — desktop, a partial module set — boots fine),
/// which reads like general leniency, but a MODIFIED file is a different code
/// path and is still rejected. Missing is forgiven; changed is not.
///
/// So: a prose/rename/lint sweep must SKIP `**/migrations/*.sql` entirely, and
/// a wording fix in a shipped migration is worth exactly one thing — nothing —
/// against bricking every persistent dev database. Change the schema by adding
/// a NEW migration; leave the old file's bytes alone.
///
/// (This rule deliberately lives HERE, next to the migrator, and not as a
/// banner comment inside a migration file: writing it into an applied migration
/// would itself trip the checksum it warns about.)
///
/// ## RECREATION RULE — EVERY PRE-SWAP DATABASE MUST BE RECREATED
///
/// The engine changed: the app now runs a single SQLite FILE where it ran an
/// embedded PostgreSQL cluster (ITEM-12 flip, DEC-3). A PostgreSQL data
/// directory cannot be migrated — its `_sqlx_migrations` history and wire
/// types have no SQLite reading — and a SQLite file created by an OLDER
/// migration chain is likewise not upgradeable (its `_sqlx_migrations`
/// records versions that no longer exist, so the next boot fails loudly on the
/// first file that conflicts). **Delete it. There is no upgrade path, and any
/// data in it is lost.**
///
///   * **Dev, default store:** stop the server and delete the database file +
///     its sidecars — `<app-data-dir>/txresbench.db` (`-wal`/`-shm` next to
///     it), or the `database.path`/`database.url` target from your config.
///     Restart: the server re-creates the file and runs the chain on an empty
///     one.
///   * **The per-worktree BUILD database** (`build.rs`): nothing to do —
///     `provision_build_db` deletes + re-migrates
///     `target/sqlx-build/cytoanalyst_build_<key>.sqlite` on every build. If a
///     stale one somehow survives, `cargo clean -p cytoanalyst` forces
///     `build.rs` to re-run.
///
/// A new migration is still an ADDITIVE file, exactly as before: the chain is
/// applied history and is immutable like any other applied file.
static MERGED_MIGRATOR: std::sync::LazyLock<sqlx::migrate::Migrator> =
    std::sync::LazyLock::new(|| {
        let mut m = sqlx::migrate!("./migrations-merged");
        m.set_ignore_missing(true);
        m
    });

/// Bring up the SQLite store (create-if-missing), run migrations, cache the
/// pool. The driver is fixed — this app's driver is the SQLite seam of the
/// SDK (`embedded_db`); there is no runtime driver choice and no
/// embedded-Postgres leg.
pub async fn initialize_database(
    config: &ServerConfig,
) -> Result<Arc<SqlitePool>, Box<dyn std::error::Error + Send + Sync>> {
    // The DEC-17 transition contract, loud at boot: a config that still selects
    // the legacy embedded-Postgres leg is refused (message pinned by TEST-13)...
    if let Some(msg) = crate::config::postgres_transition_refusal(config) {
        return Err(msg.into());
    }
    // ...and a config that merely CARRIES a `postgresql:` block (external PG,
    // `use_embedded: false` — the accepted-with-warning leg) is logged ONCE at
    // boot: the block is dead, the `database:` store is the one in use, and the
    // operator hears about the stale block from the boot log, not from a
    // surprise when the store differs from what they configured (DEC-17). This
    // is the only chokepoint every entrypoint funnels through, so the message is
    // per-boot, never per-request.
    if let Some(msg) = crate::config::postgres_transition_warning(config) {
        tracing::warn!(target: "cytoanalyst::database", "{msg}");
    }
    let target =
        crate::config::resolve_database_target(config, &crate::modules::rootfs::data_root());
    let pool_config = config
        .database
        .as_ref()
        .map(|db| db.pool.clone())
        .unwrap_or_default();
    embedded_db::initialize_database(&target, &pool_config, &MERGED_MIGRATOR).await
}

/// The process-wide SQLite pool, or `PoolTimedOut` when the store never
/// initialized (same contract as the framework's accessor — and the one the
/// embedded-PG path exposed before the flip).
pub fn get_database_pool() -> Result<Arc<SqlitePool>, sqlx::Error> {
    embedded_db::get_database_pool()
}

/// Close the pool + checkpoint the WAL (TRUNCATE). Idempotent.
pub async fn cleanup_database() {
    embedded_db::cleanup_database().await
}

#[cfg(test)]
mod tests {
    //! TEST-8 (sqlite-store ITEM-1): the server crate's resolved sqlx feature
    //! set carries BOTH drivers, and the bundled SQLite meets the version floor
    //! the node's type map and port rules are written against (3.46.0).
    //!
    //! The driver assertions are a compile-time probe by construction: the
    //! `sqlx::sqlite` and `sqlx::postgres` modules (and the pool option types
    //! below) only exist when the matching feature is enabled on the crate's
    //! sqlx dependency, so a dropped feature set breaks the build before the
    //! test can even run. The PROV-sqlx-1 contract keeps BOTH feature sets in
    //! the graph (the SDK stays dual-driver for ziee), so the postgres probe
    //! stays meaningful after the flip. Nothing here touches a database — it
    //! asserts the compile/link environment, which is exactly the surface
    //! ITEM-1 changes.

    use sqlx::postgres::PgPoolOptions;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::PgPool;
    use sqlx::SqlitePool;

    #[test]
    fn both_driver_feature_sets_are_resolved() {
        // Unused-value expressions would be optimised away even without `let`;
        // the point is that the NAMES resolve, i.e. the features are on.
        let _ = std::any::type_name::<SqlitePoolOptions>();
        let _ = std::any::type_name::<PgPoolOptions>();
        let _ = std::any::type_name::<SqlitePool>();
        let _ = std::any::type_name::<PgPool>();
    }

    #[test]
    fn bundled_sqlite_meets_the_version_floor() {
        // SAFETY: both calls go to the SQLite library C API, returning a
        // static NUL-terminated string / an int; the libsqlite3-sys bindings
        // mark them `unsafe` per the FFI convention.
        let version = unsafe { std::ffi::CStr::from_ptr(libsqlite3_sys::sqlite3_libversion()) }
            .to_str()
            .expect("sqlite3_libversion is not UTF-8");
        let number = unsafe { libsqlite3_sys::sqlite3_libversion_number() };
        assert!(
            number >= 3_046_000,
            "bundled SQLite is {version} ({number}), expected >= 3.46.0"
        );
    }
}
