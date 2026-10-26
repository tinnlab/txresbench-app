//! CytoAnalyst build-helper modules (invoked from `build.rs`).
//!
//! Mirrors ziee's `build_helper/` layout: each file stages one embedded asset
//! under `binaries/` for the runtime `include_bytes!`, fail-soft (a failure
//! writes a zero-byte stub and the feature self-disables at runtime — never a
//! build panic). See [[feedback_build_system]].

pub mod sandbox_rootfs;

// The BUILD-TIME processor-manifest syntax gate (ITEM-8/DEC-5). UNLIKE the
// fail-soft asset stagers above, this one PANICS the build on a malformed
// `packages/*/manifest.yaml` (mirrors the hub-seed panic contract) — a
// separate-repo processor contribution must fail at compile time, not boot.
pub mod processor_manifest;

// The migration-source selection by driver (ITEM-6): pure path logic that
// picks which chain `compose_merged_migrations_from` merges — the module-owned
// postgres chains today, the staged `migrations-sqlite/` chain under a
// `sqlite:` DATABASE_URL. No embedding and no build panic of its own (the
// composer's collision/read guards own the failure modes).
pub mod migration_chain;
