//! `txresbench-auth` — the DEFAULT (optional, replaceable) schema-bound auth module.
//!
//! Owns the concrete user/group/session wire types + (progressively) the auth
//! module's queries, login/register/LDAP/OAuth2, admin CRUD, the Session &
//! Token-Refresh subsystem, and the dual-mode auth strategies. Owns its
//! migrations. Consumed by txresbench via equivalence-preserving re-export shims
//! (decision N2), so the ~hundreds of call sites + the wire schemas are
//! unchanged (schemars keys types by short ident, so moving the crate that
//! defines `User`/`Group` does not move the OpenAPI schema name).

mod models;

pub mod auth;
#[cfg(feature = "sqlite-backend")]
pub mod sqlite_types;
pub mod user;

pub use models::{Group, User};

// The injectable in-transaction user-created hook (gap G-AUTHEVT). Re-exported
// at the crate root so a consumer installs it as `txresbench_auth::install_user_created_hook(..)`,
// mirroring the ergonomics of `txresbench_auth::auth::install_auth_sync_sink`.
pub use user::hook::{
    NoopUserCreatedHook, UserCreatedHook, install_user_created_hook, user_created_hook,
};

/// The auth module's own migrations (structural auth-table DDL), embedded at
/// build time. The app composes these ∪ its remaining migrations into one
/// version-sorted merged set for BOTH its runtime `migrate` and its build-DB
/// provisioner; txresbench-auth's own `build.rs` provisions an auth-only build DB
/// from exactly this set for its `query!` verification. The moved files keep
/// their original version numbers + byte content (checksums preserved), so the
/// merged set reproduces txresbench's exact `_sqlx_migrations` history — deployed DBs
/// are unaffected.
///
/// Dual-driver: the SQLite leg embeds `./migrations` — the DEC-8/DEC-9 port
/// of the same chain (same version numbers, SQLite dialect), which is the
/// FORK's canonical chain (ITEM-26 renamed `migrations-sqlite/` to
/// `migrations/`); txresbench's postgres leg embeds `./migrations-pg`. The
/// selection is a compile-time property of the `sqlite-backend` feature and
/// AGREES with `build.rs`'s scheme selection by construction: a
/// `sqlite-backend` build verifies its `query!` sets against a sqlite
/// `DATABASE_URL` (which is how the build script provisions the build DB).
#[cfg(not(feature = "sqlite-backend"))]
pub static AUTH_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-pg");
#[cfg(feature = "sqlite-backend")]
pub static AUTH_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// In-crate unit-test support (never built into the lib proper).
///
/// The turnkey/module tests only need the TYPE shape (a lazy pool never
/// dials), so the pool is driver-selected here the same way the production
/// `DbPool` is.
#[cfg(test)]
mod test_support {
    use txresbench_core::DbPool;

    /// A lazy pool for unit tests that only type-check/wire — never connects
    /// (mirrors the pre-seam test's `PgPool::connect_lazy`, which likewise
    /// never dialed).
    #[cfg(not(feature = "sqlite-backend"))]
    pub fn lazy_test_pool() -> DbPool {
        sqlx::postgres::PgPool::connect_lazy(
            "postgresql://postgres:password@127.0.0.1:54321/postgres",
        )
        .expect("valid postgres URL")
    }

    #[cfg(feature = "sqlite-backend")]
    pub fn lazy_test_pool() -> DbPool {
        sqlx::sqlite::SqlitePool::connect_lazy("sqlite::memory:").expect("valid sqlite URL")
    }
}
