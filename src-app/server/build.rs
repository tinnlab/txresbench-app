//! CytoAnalyst build script.
//!
//! 1. Composes `migrations-merged/` (SDK `compose_merged_migrations_from`) for
//!    the runtime `sqlx::migrate!`.
//! 2. Provisions a per-worktree BUILD DATABASE on the shared local build cluster
//!    (`127.0.0.1:54321`, see `src-app/docker-compose.yaml`), wipes + migrates
//!    it, and sets `DATABASE_URL` (`cargo:rustc-env`, scoped to THIS crate) so
//!    sqlx compile-time `query!`/`query_as!` macros verify SQL against the real
//!    schema at `cargo check` time — SDK gap G4, resolved by `provision_build_db`.
//!
//! The build DB lives on the SDK's committed `:54321` sentinel, so the one-call
//! `provision_build_db` handles per-worktree isolation (`cytoanalyst_build_<key>`)
//! automatically — same cluster ziee-auth uses, so a single running Postgres
//! serves everything. If a cluster is already up on `:54321` (e.g. ziee's
//! pgvector container), we reuse it; pgvector is a superset of plain Postgres, so
//! CytoAnalyst's (vector-free) schema is happy either way.

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

    let auth_migrations = manifest.join("../../sdk/crates/ziee-auth/migrations");
    // The notification crate (linked with `features = ["module"]`) ships the
    // generic inbox schema; fold its migrations into the merged set.
    let notification_migrations =
        manifest.join("../../sdk/crates/ziee-notification/migrations");
    // The ziee-file crate ships the base `files`/`file_versions` store schema;
    // fold it in so the dataset upload path (+ the `datasets.file_id` FK) has the
    // files table at build-DB provision + runtime migrate time.
    let file_migrations = manifest.join("../../sdk/crates/ziee-file/migrations");
    // Re-run when any SDK crate's migrations change (the fn emits rerun hints
    // for the app module roots; make the explicit SDK dirs just as robust).
    println!("cargo:rerun-if-changed={}", auth_migrations.display());
    println!("cargo:rerun-if-changed={}", notification_migrations.display());
    println!("cargo:rerun-if-changed={}", file_migrations.display());

    compose_merged_migrations_from(
        &merged,
        &[manifest.join("src/modules")],
        &[auth_migrations, notification_migrations, file_migrations],
    );

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
    // sqlx query macros verify at compile time. Requires the `:54321` build
    // cluster up: `cd src-app && docker compose up -d` (or reuse an existing one).
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
