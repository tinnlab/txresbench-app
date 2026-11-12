//! `txresbench-auth` build script — provisions the **auth-only** build DB for sqlx
//! compile-time `query!` verification.
//!
//! txresbench-auth is one of the schema-bound SDK crates (framework/core/identity are
//! build-DB-free). Its `query!` macros only touch the auth tables, so it needs
//! an auth-only database: a sibling `txresbench_auth_build_<key>` DB on the shared
//! `:54321` cluster (postgres leg) or the per-worktree FILE
//! `<crate>/target/sqlx-build/txresbench_auth_build_<key>.sqlite` (sqlite leg).
//!
//! The driver split, the per-worktree key derivation and the migration
//! application are single-sourced in `txresbench_build_support` — the same helper the
//! app's `build.rs` uses, so the two never drift. The leg is chosen by the
//! `DATABASE_URL` SCHEME at build time:
//!
//!   * unset, the committed `:54321` postgres sentinel (or the app's committed
//!     sqlite sentinel `sqlite://target/sqlx-build/txresbench_build.sqlite`)
//!     → auto-isolate: derive the per-worktree build DB, wipe + re-migrate it.
//!     For sqlite the file is `txresbench_auth_build_<key>.sqlite` under the crate's
//!     own `target/sqlx-build/` — an SDK manifest path carries no `/src-app`
//!     marker, so the key is the crate dir itself, mirroring the per-crate PG
//!     database names.
//!   * any other `DATABASE_URL` → a deliberate operator/CI override, honored
//!     byte-for-byte.
//!
//! The migrations applied here are EXACTLY the migrations this crate ships (the
//! structural auth-table chain) — but which chain is the driver's property:
//! the `DATABASE_URL` SCHEME selects both the provisioner leg AND this
//! directory (`migrations-pg` for postgres, `migrations` for sqlite — ITEM-26:
//! the sqlite chain took the canonical name, the retained postgres chain the
//! `-pg` suffix), through the same `is_sqlite_url` rule `BuildDbLeg` uses, so
//! the migration directory can never disagree with the dialect the leg
//! applies. The library side (`AUTH_MIGRATOR` in `lib.rs`) selects the same
//! pair via the `sqlite-backend` cargo feature; a build where the two disagree
//! (a `sqlite:` build URL with the PG query set, or vice versa) fails LOUDLY
//! at macro verification — never silently verifies the wrong dialect.

use std::path::PathBuf;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let sqlite_leg = std::env::var("DATABASE_URL")
        .map(|u| txresbench_build_support::worktree_db::is_sqlite_url(&u))
        .unwrap_or(false);
    let migrations = if sqlite_leg {
        PathBuf::from(&manifest_dir).join("migrations")
    } else {
        PathBuf::from(&manifest_dir).join("migrations-pg")
    };

    // One-call provision: pick the leg from the DATABASE_URL scheme, derive the
    // per-worktree build DB / file when the sentinel says "safe", wipe + apply
    // the chain, emit `cargo:rustc-env=DATABASE_URL=...` (the URL the sqlx
    // macros verify against). The return value is the same URL — echoed as a
    // warning so build logs name the DB/file the auth `query!`s checked.
    let url = txresbench_build_support::provision_build_db_named("txresbench_auth_build_", &migrations);
    println!("cargo:warning=txresbench-auth: build DB = {url}");
}
