//! TxResBench build script.
//!
//! 1. Composes `migrations-merged/` (SDK `compose_merged_migrations_from`) for
//!    the runtime `sqlx::migrate!`. The source is UNCONDITIONAL (ITEM-26: the
//!    driver-selection branch is gone — there is one chain): the module-owned
//!    SQLite migrations under `src/modules/<m>/migrations/` (globbed through
//!    the `src/modules` root) plus the three schema-bound SDK crates'
//!    `migrations/` dirs, passed explicitly.
//! 2. Provisions a per-worktree BUILD DATABASE (`sqlx::` macros verify SQL at
//!    compile time): the build FILE under `target/sqlx-build/` derived from
//!    the committed `sqlite:` sentinel (see `txresbench_build_support::
//!    provision_build_db`; that helper keeps its postgres leg for the SDK's
//!    own standalone builds, but THIS crate's compose is sqlite-only).
//!    `cargo:rustc-env=DATABASE_URL` then holds the resolved URL (scoped to
//!    THIS crate) — SDK gap G4, resolved by `provision_build_db`. Beneath it:
//!    the sandbox-rootfs embed slot stub (fail-soft — the single-cell
//!    analysis-rootfs recipes were removed in the strip node (ITEM-2), the
//!    embed slot is retained only so the runtime `include_bytes!` still
//!    compiles, and ITEM-3 removes the slot with the single-cell arms).
//!
//! The build DB is the per-worktree file `txresbench_build_<key>.sqlite` the
//! one-call `provision_build_db` derives from the committed sqlite sentinel
//! (wiped + re-migrated on every build).

use std::path::PathBuf;

use txresbench_build_support::{compose_merged_migrations_from, provision_build_db};

#[path = "build_helper/mod.rs"]
mod build_helper;

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let merged = manifest.join("migrations-merged");

    // Single-chain composition (ITEM-26): the ONE sqlite migration set is the
    // module-owned `src/modules/*/migrations/` dirs (globbed by the composer)
    // plus the three schema-bound SDK crates' `migrations/` dirs (explicit —
    // their names are the crates the app schema-binds; txresbench-onboarding/seed
    // are not bound). There is no driver branch: the PG chains were deleted
    // with the engine swap and the merged dir always holds the sqlite chain.
    let module_roots = vec![manifest.join("src/modules")];
    let sdk_migration_dirs: Vec<PathBuf> = ["txresbench-auth", "txresbench-file", "txresbench-notification"]
        .iter()
        .map(|c| manifest.join("../../sdk/crates").join(c).join("migrations"))
        .collect();
    compose_merged_migrations_from(&merged, &module_roots, &sdk_migration_dirs);

    // Provision + migrate the per-worktree build DB and set DATABASE_URL so the
    // sqlx query macros verify at compile time. The committed `.cargo/config.toml`
    // sentinel is a `sqlite:` URL, so the SQLite leg of `provision_build_db`
    // derives the per-worktree file under `target/sqlx-build/` (the SDK helper
    // keeps its postgres leg for the SDK's own standalone builds; this crate's
    // chain is sqlite and a postgres-leg run here would fail loudly at apply).
    provision_build_db(&merged);

    // Sandbox-rootfs embed slot: fail-soft stub writer. The analysis-rootfs
    // recipes (`env-rootfs/`) are gone (strip node ITEM-2 — the method
    // environments come from the txresbench-env pipeline, not these recipes);
    // the runtime still `include_bytes!`s the slot, so the build writes a
    // zero-byte stub ("rootfs unavailable" → the embedded path self-disables).
    if let Err(e) = build_helper::sandbox_rootfs::setup(&manifest) {
        println!("cargo:warning=sandbox rootfs setup errored ({e}); continuing (sandbox self-disables)");
    }

    // NOTE (artifact-model ITEM-13): a `#[cfg(feature = "tiledb_serve")]` block used to
    // sit here and point the linker at a prebuilt core `libtiledb` given by the
    // `TXR_TILEDB_LIB` env var. Both the feature and the module it served are gone.
    // INV-1: the server never opens a byte for meaning, so this build script emits NO
    // `rustc-link-lib` for any format-parsing library — there is deliberately no link
    // path to a format reader for a future change to re-enable.
}
