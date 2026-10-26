//! Database bootstrap — a thin shim over `ziee_framework::embedded_pg`.
//!
//! The framework owns the app-agnostic lifecycle (embedded-PG setup/start/stop,
//! pool connect + retry, process-wide statics, cleanup on panic/drop). We supply
//! only the two app-bound pieces it is parameterized over:
//!   - `MERGED_MIGRATOR` — our merged (`migrations-merged`) migration set, with
//!     `set_ignore_missing(true)` so a subset-owning binary is tolerated. See its
//!     doc comment for the rule that follows from checksum verification: an
//!     APPLIED migration file is immutable, comments included.
//!   - the Postgres-extension hooks — CytoAnalyst installs no PG extension yet,
//!     so both are no-ops (contrast ziee, which installs pgvector here).

use std::sync::Arc;

use sqlx::PgPool;
use ziee_core::ServerConfig;
use ziee_framework::embedded_pg::{self, EmbeddedPgHooks};

/// The embedded-Postgres binary version — used only for the `pg_ctl` stop path.
/// Keep identical to `.cargo/config.toml`'s `POSTGRESQL_VERSION` and dev.yaml's
/// `postgresql.embedded.version`.
const POSTGRES_VERSION: &str = "18.3.0";

/// The merged migration set composed by build.rs (module `migrations/` ∪ SDK
/// `crates/*/migrations/`), version-sorted. `LazyLock` so the framework receives
/// a `&'static Migrator`.
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
/// ## SQUASHED BASELINE — EVERY PRE-SQUASH DATABASE MUST BE RECREATED
///
/// The app-owned migration history was **squashed** while still pre-release:
/// the 49 incremental `src/modules/*/migrations/*.sql` files are gone, replaced
/// by ONE baseline per module (`2026080300NN_<module>_baseline.sql`, 8 files).
/// The SDK-crate migrations (`sdk/crates/ziee-{auth,file,notification}/
/// migrations`, 5 files) are submodule-owned and were NOT touched.
///
/// Why: the retired chain CREATEd, ALTERed and then DROPped an earlier
/// domain-specific data model, so its files carried that model's vocabulary
/// forward forever in files describing a schema that no longer contains it. The
/// immutability rule above is exactly why it could not be edited out in place —
/// only a squash removes it.
///
/// The squashed baseline reproduces the pre-squash schema EXACTLY (verified by
/// diffing `pg_dump --schema-only` of both chains — byte-identical — plus an
/// order-independent `pg_catalog` census of columns / constraints / indexes /
/// triggers / sequences / extensions / functions). The seeded rows are likewise
/// identical in value; the only intentional deviation is the ELEMENT ORDER of
/// `groups.permissions` (a set, only ever read with `= ANY`), which now follows
/// the module apply order. The only physical difference is that `datasets` and
/// `jobs` no longer carry the `attnum` holes their dropped columns left behind
/// — the visible column order is unchanged.
///
/// ### WHAT A DEVELOPER MUST DO
///
/// Any database that ran the OLD chain is incompatible: its `_sqlx_migrations`
/// records 49 versions that no longer exist and none of the 8 new ones, so the
/// next boot tries to APPLY the baselines onto a populated schema and fails
/// loudly on the first one (`relation "job_dependencies" already exists`,
/// verified against a database that had run the old chain). The baselines use
/// plain `CREATE TABLE` — not `IF NOT EXISTS` — precisely so this is a loud
/// stop rather than a half-applied schema. `set_ignore_missing(true)` does
/// not help — it forgives an applied-but-absent file, not a schema that is
/// already there. **Recreate the database. There is no upgrade path, and any
/// data in it is lost.**
///
///   * **Dev, embedded Postgres (the default):** stop the server and delete the
///     cluster's data directory — `postgresql.embedded.data_dir` from your
///     config (`config/dev.yaml` ships `../../cytoanalyst-data/dev/postgres-data`),
///     or `<app_data>/postgres-data` when that field is unset. Restart: the
///     server re-initializes the cluster and runs the baselines on an empty one.
///   * **Dev, external Postgres (`database_url` set):**
///     `DROP DATABASE <db>; CREATE DATABASE <db>;` then restart.
///   * **The per-worktree BUILD database** (`build.rs`, `:54321`): nothing to
///     do — `provision_build_db` wipes and re-migrates `cytoanalyst_build_<key>`
///     on every build. If a stale one somehow survives, `cargo clean -p
///     cytoanalyst` forces `build.rs` to re-run.
///   * **The integration-test template DB:** nothing to do — the harness
///     rebuilds `cytoanalyst_test_template_<key>` from the migration chain.
///
/// A new migration is still an ADDITIVE file, exactly as before: the baselines
/// are now applied history and are immutable like any other applied file.
static MERGED_MIGRATOR: std::sync::LazyLock<sqlx::migrate::Migrator> =
    std::sync::LazyLock::new(|| {
        let mut m = sqlx::migrate!("./migrations-merged");
        m.set_ignore_missing(true);
        m
    });

/// No-op Postgres-extension hooks (CytoAnalyst has no PG extensions yet).
const NOOP_HOOKS: EmbeddedPgHooks = EmbeddedPgHooks {
    after_setup: noop_after_setup,
    smoke_test: noop_smoke,
};

fn noop_after_setup(_install_dir: &std::path::Path) {}

fn noop_smoke(_url: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async {})
}

/// Bring up the database (embedded or external), run migrations, cache the pool.
pub async fn initialize_database(
    config: &ServerConfig,
) -> Result<Arc<PgPool>, Box<dyn std::error::Error + Send + Sync>> {
    embedded_pg::initialize_database(
        config.postgresql.clone(),
        config.database_url(),
        POSTGRES_VERSION.to_string(),
        std::sync::LazyLock::force(&MERGED_MIGRATOR),
        NOOP_HOOKS,
    )
    .await
}

/// Close the pool + stop the embedded instance. Idempotent.
pub async fn cleanup_database() {
    embedded_pg::cleanup_database().await
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
    //! test can even run. Nothing here touches a database — it asserts the
    //! compile/link environment, which is exactly the surface ITEM-1 changes.

    use sqlx::PgPool;
    use sqlx::SqlitePool;
    use sqlx::postgres::PgPoolOptions;
    use sqlx::sqlite::SqlitePoolOptions;

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
        let version = unsafe {
            std::ffi::CStr::from_ptr(libsqlite3_sys::sqlite3_libversion())
        }
        .to_str()
        .expect("sqlite3_libversion is not UTF-8");
        let number = unsafe { libsqlite3_sys::sqlite3_libversion_number() };
        assert!(
            number >= 3_046_000,
            "bundled SQLite is {version} ({number}), expected >= 3.46.0"
        );
    }
}
