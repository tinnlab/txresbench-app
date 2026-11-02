//! CytoAnalyst build script.
//!
//! 1. Composes `migrations-merged/` (SDK `compose_merged_migrations_from`) for
//!    the runtime `sqlx::migrate!`. The source is UNCONDITIONAL (ITEM-26: the
//!    driver-selection branch is gone — there is one chain): the module-owned
//!    SQLite migrations under `src/modules/<m>/migrations/` (globbed through
//!    the `src/modules` root) plus the three schema-bound SDK crates'
//!    `migrations/` dirs, passed explicitly.
//! 2. Provisions a per-worktree BUILD DATABASE (`sqlx::` macros verify SQL at
//!    compile time): the build FILE under `target/sqlx-build/` derived from
//!    the committed `sqlite:` sentinel (see `ziee_build_support::
//!    provision_build_db`; that helper keeps its postgres leg for the SDK's
//!    own standalone builds, but THIS crate's compose is sqlite-only).
//!    `cargo:rustc-env=DATABASE_URL` then holds the resolved URL (scoped to
//!    THIS crate) — SDK gap G4, resolved by `provision_build_db`. Beneath it:
//!    the build-time processor-manifest / env-pin gates, the sandbox-rootfs
//!    embed (fail-soft), and the `rootfs_version` freshness single-sourcing
//!    (lib + build script path-include).
//!
//! The build DB is the per-worktree file `cytoanalyst_build_<key>.sqlite` the
//! one-call `provision_build_db` derives from the committed sqlite sentinel
//! (wiped + re-migrated on every build).

use std::path::PathBuf;

use ziee_build_support::{compose_merged_migrations_from, provision_build_db};

// The rootfs schema/freshness logic is single-sourced in the lib
// (`src/modules/rootfs/version.rs`) and `#[path]`-included here so the build
// helper and the runtime can never drift. Only `sha2` is needed (a build-dep).
#[path = "src/modules/rootfs/version.rs"]
mod rootfs_version;

#[path = "build_helper/mod.rs"]
mod build_helper;

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let merged = manifest.join("migrations-merged");

    // Single-chain composition (ITEM-26): the ONE sqlite migration set is the
    // module-owned `src/modules/*/migrations/` dirs (globbed by the composer)
    // plus the three schema-bound SDK crates' `migrations/` dirs (explicit —
    // their names are the crates the app schema-binds; ziee-onboarding/seed
    // are not bound). There is no driver branch: the PG chains were deleted
    // with the engine swap and the merged dir always holds the sqlite chain.
    let module_roots = vec![manifest.join("src/modules")];
    let sdk_migration_dirs: Vec<PathBuf> = ["ziee-auth", "ziee-file", "ziee-notification"]
        .iter()
        .map(|c| manifest.join("../../sdk/crates").join(c).join("migrations"))
        .collect();
    compose_merged_migrations_from(&merged, &module_roots, &sdk_migration_dirs);

    // BUILD-TIME processor-manifest syntax gate (ITEM-8/DEC-5, INV-5): parse +
    // `deny_unknown_fields`-lint EVERY `src-app/packages/*/manifest.yaml` against
    // the unified (backend+FE) schema and PANIC with a package-scoped error on any
    // malformed package (typo'd key / bad type / dangling `extends` / malformed
    // `schema`). A separate-repo processor contribution must fail at COMPILE time,
    // not silently mis-load or surface only at server boot. Re-lint whenever the
    // processors tree changes.
    let processors_dir = manifest.join("../packages");
    // Watch the top dir (catches add/remove/rename of a whole package) AND — B1 —
    // each `manifest.yaml` + `ui/*.yaml` per-file, so an IN-PLACE manifest edit
    // (cargo does NOT re-fire on a dir's own mtime for that) re-runs the gate under
    // incremental builds.
    println!("cargo:rerun-if-changed={}", processors_dir.display());
    for f in build_helper::processor_manifest::watched_manifest_files(&processors_dir) {
        println!("cargo:rerun-if-changed={}", f.display());
    }
    // …and the DEPENDENCY gate's other input (#80): each env recipe's pin file. Without
    // a per-file watch, moving a pin under a shipped declaration would not re-fire the
    // gate under an incremental build — the exact drift the gate exists to catch.
    let env_root = manifest.join("../env-rootfs");
    println!("cargo:rerun-if-changed={}", env_root.display());
    for f in build_helper::processor_manifest::watched_env_pin_files(&env_root) {
        println!("cargo:rerun-if-changed={}", f.display());
    }
    // #214 — THE EXPORTED PARSE. The gate's parse of every recipe's pin file is generated
    // into a committed artefact that every OTHER consumer reads instead of parsing the file
    // itself (`docs/design/pin-file-single-parse.md`). This is the freshness gate: the
    // artefact is re-derived here and byte-compared, so the server cannot be compiled
    // against a stale one. A stale artefact is a disagreement between the gate and its
    // consumers — the same defect class one level up.
    //
    // It runs BEFORE the manifest gate and is not conditional on anything, which is also
    // the second unconditional route to the canonical-bytes precondition (INV-3): the
    // generator refuses a non-canonical pin file before it parses a byte of it.
    //
    // Under CYTO_REGEN_ENV_PINS=1 (`just env-pins-regen`) it WRITES instead of comparing —
    // otherwise a stale artefact would fail the build that is the only thing able to
    // refresh it.
    println!(
        "cargo:rerun-if-env-changed={}",
        build_helper::processor_manifest::ENV_PIN_REGEN_VAR
    );
    if let Err(e) = build_helper::processor_manifest::env_pin_artefact_check_or_write(&env_root) {
        panic!("env-pin artefact gate failed:\n  {e}");
    }
    // #80 — the gate now also resolves every `run.dependencies[]` a package declares
    // against the env recipes' pin sets, so a library that is absent from the environment
    // (or pinned outside a declared supported range) fails HERE rather than as a raw
    // import error inside a user's sandboxed job.
    if let Err(e) = build_helper::processor_manifest::lint_processor_tree_with_env(
        &processors_dir,
        Some(&env_root),
    ) {
        panic!("processor-manifest build gate failed:\n  {e}");
    }

    // Provision + migrate the per-worktree build DB and set DATABASE_URL so the
    // sqlx query macros verify at compile time. The committed `.cargo/config.toml`
    // sentinel is a `sqlite:` URL, so the SQLite leg of `provision_build_db`
    // derives the per-worktree file under `target/sqlx-build/` (the SDK helper
    // keeps its postgres leg for the SDK's own standalone builds; this crate's
    // chain is sqlite and a postgres-leg run here would fail loudly at apply).
    provision_build_db(&merged);

    // Docker-build + embed the analysis rootfs (fail-soft: stub on any failure,
    // so a box without docker still builds; the sandbox self-disables at
    // runtime). THE KEY DIRECTIVE — see build_helper/sandbox_rootfs.rs.
    if let Err(e) = build_helper::sandbox_rootfs::setup(&manifest) {
        println!("cargo:warning=sandbox rootfs setup errored ({e}); continuing (sandbox self-disables)");
    }

    // NOTE (artifact-model ITEM-13): a `#[cfg(feature = "tiledb_serve")]` block used to
    // sit here and point the linker at a prebuilt core `libtiledb` given by the
    // `CYTO_TILEDB_LIB` env var. Both the feature and the module it served are gone.
    // INV-1: the server never opens a byte for meaning, so this build script emits NO
    // `rustc-link-lib` for any format-parsing library — there is deliberately no link
    // path to a format reader for a future change to re-enable.
}
