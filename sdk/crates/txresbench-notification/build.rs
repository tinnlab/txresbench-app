//! `txresbench-notification` build script — provisions the **notification-only**
//! build DB for sqlx compile-time `query!` verification.
//!
//! When built with the `routes` feature (which the `module` feature implies),
//! provision + migrate a per-worktree build DB from this crate's own migration
//! and set `DATABASE_URL` (scoped to this crate) so the `query!`/`query_as!`
//! macros in `repository` verify SQL against the real `notifications` schema at
//! `cargo check` time. A types-only build (no `routes`) skips this entirely and
//! needs no database — the crate's build-DB-free property is preserved for
//! consumers that only want the wire types.
//!
//! The driver split, the per-worktree key derivation and the migration
//! application are single-sourced in `txresbench_build_support` — the same helper the
//! app's `build.rs` and `txresbench-auth`/`txresbench-file` use, so the three never drift.
//! The leg is chosen by the `DATABASE_URL` SCHEME at build time:
//!
//!   * unset, the default postgres cluster URL (the sdk standalone build), or
//!     the app's committed sqlite sentinel
//!     (`sqlite://target/sqlx-build/txresbench_build.sqlite`) → auto-isolate:
//!     derive the per-worktree build DB / file, wipe + re-migrate it. For
//!     sqlite the file is `txresbench_notification_build_<key>.sqlite` under the
//!     crate's own `target/sqlx-build/` — an SDK manifest path carries no
//!     `/src-app` marker, so the key is the crate dir itself, mirroring the
//!     per-crate PG database names.
//!   * any other `DATABASE_URL` → a deliberate operator/CI override, honored
//!     byte-for-byte.
//!
//! The migrations applied here are EXACTLY the migrations this crate ships (the
//! notification inbox schema, globbed into the app's merged chain) — but which
//! chain is the driver's property: the `DATABASE_URL` SCHEME selects both the
//! provisioner leg AND this directory (`migrations-pg` for postgres,
//! `migrations` for sqlite — ITEM-26: the sqlite chain took the canonical
//! name, the retained postgres chain the `-pg` suffix), through the same
//! `is_sqlite_url` rule the provisioner's `BuildDbLeg` dispatch uses, so the
//! migration directory can never disagree with the dialect the leg applies.
//! The library side
//! (`NOTIFICATION_MIGRATOR` in `lib.rs`) selects the same pair via the
//! `sqlite-backend` cargo feature; a build where the two disagree (a
//! `sqlite:` build URL with the PG query set, or vice versa) fails LOUDLY at
//! macro verification — never silently verifies the wrong dialect.

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=migrations");
    println!("cargo:rerun-if-changed=migrations-pg");
    // `CARGO_FEATURE_ROUTES` is set by cargo iff the `routes` feature is enabled
    // (the `module` feature enables `routes`, so it is set for that too). The
    // compile-time `query!` macros live in the `routes`-gated `repository`.
    if std::env::var_os("CARGO_FEATURE_ROUTES").is_none() {
        return;
    }
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
    // warning so build logs name the DB/file the notification `query!`s
    // checked against.
    let url = txresbench_build_support::provision_build_db_named("txresbench_notification_build_", &migrations);
    println!("cargo:warning=txresbench-notification: build DB = {url}");
}
