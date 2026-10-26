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
//! structural auth-table chain). The app composes those ∪ its remaining
//! migrations into a merged set for its own (full-schema) build DB; here we
//! verify against the auth subset alone. The migration DIRECTORY is the
//! caller's property: the sqlite leg applies what it is given — it is a scheme
//! dispatch, not a PG→SQLite dialect translator.

use std::path::PathBuf;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let migrations = PathBuf::from(&manifest_dir).join("migrations");

    // One-call provision: pick the leg from the DATABASE_URL scheme, derive the
    // per-worktree build DB / file when the sentinel says "safe", wipe + apply
    // the chain, emit `cargo:rustc-env=DATABASE_URL=...` (the URL the sqlx
    // macros verify against). The return value is the same URL — echoed as a
    // warning so build logs name the DB/file the auth `query!`s checked.
    let url = ziee_build_support::provision_build_db_named("ziee_auth_build_", &migrations);
    println!("cargo:warning=ziee-auth: build DB = {url}");
}
