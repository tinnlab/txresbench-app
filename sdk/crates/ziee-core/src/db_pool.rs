//! Dual-driver pool aliases — the SDK's one compile-time driver switch.
//!
//! The schema-bound SDK crates (`ziee-core`, `ziee-framework`, and below them
//! `ziee-auth` / `ziee-file` / `ziee-notification` / `ziee-build-support` /
//! `ziee-test-harness` / `ziee-desktop-harness`) are shared substrate: ziee
//! (app #1) builds them against PostgreSQL, a second app builds the SAME
//! crates against SQLite. The selection is a cargo feature
//! (`sqlite-backend`), NOT a runtime config switch:
//!
//! - `sqlite-backend` OFF (default) → [`DbPool`] = `sqlx::PgPool`,
//!   [`Db`] = `sqlx::Postgres` — ziee's build is byte-identical to the
//!   pre-seam state (0.0.0-version crates, `query!` still PG-verified against
//!   the PG `DATABASE_URL`).
//! - `sqlite-backend` ON → [`DbPool`] = `sqlx::SqlitePool`,
//!   [`Db`] = `sqlx::Sqlite` — the app's build binds every `query!` against
//!   the SQLite build DB.
//!
//! Why an alias pair and not `sqlx::Any` (the thought is worth recording):
//! the compile-time `query!` macros bind a CONCRETE database and `Any` pools
//! would force every query onto the dynamic `sqlx::query` path, losing the
//! compile-time verification the framework's whole DB contract rests on. The
//! alias keeps the concrete driver while letting shared code be written once.
//!
//! [`Db`] exists because `sqlx::Transaction<'t, DB>` cannot be named through
//! the pool alias — the entity-extension `fire_in_tx` seam needs the database
//! type itself (see `ziee-framework`'s `entity_extension.rs`).

/// The driver-selected pool type: `SqlitePool` under `sqlite-backend`,
/// `PgPool` otherwise.
#[cfg(feature = "sqlite-backend")]
pub type DbPool = sqlx::SqlitePool;

/// The driver-selected pool type: `PgPool` by default (see [`DbPool`]).
#[cfg(not(feature = "sqlite-backend"))]
pub type DbPool = sqlx::PgPool;

/// The driver-selected SQL database type behind [`DbPool`]: `Sqlite` under
/// `sqlite-backend`, `Postgres` otherwise.
#[cfg(feature = "sqlite-backend")]
pub type Db = sqlx::Sqlite;

/// The driver-selected SQL database type behind [`DbPool`] (see [`Db`]).
#[cfg(not(feature = "sqlite-backend"))]
pub type Db = sqlx::Postgres;

/// The driver-selected raw connection type of [`Db`] — the type a
/// `Transaction<'t, Db>` derefs to (`&mut <Db as Database>::Connection`).
/// Named here because schema-bound crates expose connection-taking seams
/// (e.g. the user-created hook, gap G-AUTHEVT) where `DbPool` alone cannot
/// express "the creation transaction's own connection".
#[cfg(feature = "sqlite-backend")]
pub type DbConnection = <sqlx::Sqlite as sqlx::Database>::Connection;

/// See [`DbConnection`] — the postgres half of the pair.
#[cfg(not(feature = "sqlite-backend"))]
pub type DbConnection = <sqlx::Postgres as sqlx::Database>::Connection;

#[cfg(test)]
mod tests {
    use super::*;

    /// The alias must track the feature — the only way to observe a type
    /// alias at runtime is `type_name`. The two assertions are compiled
    /// exclusively, so each feature state proves exactly its own side.
    ///
    /// (`type_name` reports the pool's underlying defining path, e.g.
    /// `sqlx_core::pool::Pool<sqlx_postgres::database::Postgres>`, so the DB
    /// type name is matched at the END of the string — the crate path varies
    /// with the dependency graph, the DB type name does not.)
    #[test]
    fn db_pool_resolves_to_the_driver_the_feature_selects() {
        #[cfg(feature = "sqlite-backend")]
        {
            let n = std::any::type_name::<DbPool>();
            assert!(
                n.ends_with("Sqlite>"),
                "DbPool must be SqlitePool with sqlite-backend on; got {n}"
            );
        }
        #[cfg(not(feature = "sqlite-backend"))]
        {
            let n = std::any::type_name::<DbPool>();
            assert!(
                n.ends_with("Postgres>"),
                "DbPool must be PgPool without sqlite-backend; got {n}"
            );
        }
    }

    /// `Db` is the database-type half of the pair — the one a
    /// `Transaction<'t, Db>` names. It must follow the same feature.
    #[test]
    fn db_resolves_to_the_driver_the_feature_selects() {
        #[cfg(feature = "sqlite-backend")]
        {
            let n = std::any::type_name::<Db>();
            assert!(
                n.ends_with("Sqlite"),
                "Db must be Sqlite with sqlite-backend on; got {n}"
            );
        }
        #[cfg(not(feature = "sqlite-backend"))]
        {
            let n = std::any::type_name::<Db>();
            assert!(
                n.ends_with("Postgres"),
                "Db must be Postgres without sqlite-backend; got {n}"
            );
        }
    }

    /// The pool and the transaction type must agree: `DbPool::begin()` yields
    /// a `Transaction<'t, Db>` (`sqlx::Acquire`'s associated `Database` is the
    /// driver's own type), so mixing the two sides of the alias would be a
    /// compile error at the first consumer `begin()`. This pins the pair
    /// together here instead of waiting for a consumer crate.
    #[test]
    fn db_pool_and_db_type_chain_is_coherent() {
        fn assert_acquire<'a, A: sqlx::Acquire<'a, Database = Db>>(_: A) {}
        fn probe(pool: &DbPool) {
            assert_acquire(pool);
        }
        let _ = probe;
    }
}
