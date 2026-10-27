//! `ziee-auth` build script — provisions the **auth-only** build DB for sqlx
//! compile-time `query!` verification.
//!
//! ziee-auth is one of the schema-bound SDK crates (framework/core/identity are
//! build-DB-free). Its `query!` macros only touch the auth tables, so it needs
//! an auth-only database: a sibling `ziee_auth_build_<key>` DB on the shared
//! `:54321` cluster (postgres leg) or the per-worktree FILE
//! `<crate>/target/sqlx-build/ziee_auth_build_<key>.sqlite` (sqlite leg).
//!
//! The driver split, the per-worktree key derivation and the migration
//! application are single-sourced in `ziee_build_support` — the same helper the
//! app's `build.rs` uses, so the two never drift. The leg is chosen by the
//! `DATABASE_URL` SCHEME at build time:
//!
//!   * unset, the committed `:54321` postgres sentinel (or the app's committed
//!     sqlite sentinel `sqlite://target/sqlx-build/cytoanalyst_build.sqlite`)
//!     → auto-isolate: derive the per-worktree build DB, wipe + re-migrate it.
//!     For sqlite the file is `ziee_auth_build_<key>.sqlite` under the crate's
//!     own `target/sqlx-build/` — an SDK manifest path carries no `/src-app`
//!     marker, so the key is the crate dir itself, mirroring the per-crate PG
//!     database names.
//!   * any other `DATABASE_URL` → a deliberate operator/CI override, honored
//!     byte-for-byte.
//!
//! The migrations applied here are EXACTLY the migrations this crate ships (the
//! structural auth-table chain) — but which of the two chains is the driver's
//! property: the `DATABASE_URL` SCHEME selects both the provisioner leg AND
//! this directory (`migrations` for postgres, `migrations-sqlite` for sqlite),
//! through the same `is_sqlite_url` rule `BuildDbLeg` uses, so the migration
//! directory can never disagree with the dialect the leg applies. The library
//! side (`AUTH_MIGRATOR` in `lib.rs`) selects the same pair via the
//! `sqlite-backend` cargo feature; a build where the two disagree (a
//! `sqlite:` build URL with the PG query set, or vice versa) fails LOUDLY at
//! macro verification — never silently verifies the wrong dialect.

use std::path::PathBuf;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let sqlite_leg = std::env::var("DATABASE_URL")
        .map(|u| ziee_build_support::worktree_db::is_sqlite_url(&u))
        .unwrap_or(false);
    let migrations = if sqlite_leg {
        PathBuf::from(&manifest_dir).join("migrations-sqlite")
    } else {
        PathBuf::from(&manifest_dir).join("migrations")
    };

    // One-call provision: pick the leg from the DATABASE_URL scheme, derive the
    // per-worktree build DB / file when the sentinel says "safe", wipe + apply
    // the chain, emit `cargo:rustc-env=DATABASE_URL=...` (the URL the sqlx
    // macros verify against). The return value is the same URL — echoed as a
    // warning so build logs name the DB/file the auth `query!`s checked.
    let url = ziee_build_support::provision_build_db_named("ziee_auth_build_", &migrations);
    println!("cargo:warning=ziee-auth: build DB = {url}");
}
