//! Rootfs schema constants — the marker the mount probe compares.
//!
//! strip-single-cell ITEM-3 (map §1 `rootfs` KEEP (trim), "version.rs
//! env-recipe discovery"): the env-rootfs recipe discovery + build-embed
//! freshness machinery (`discover_env_recipes`, `select_env_recipe`,
//! `build_arg_*`, `arch_variant`, …) was removed with the `env-rootfs`
//! recipes (ITEM-2). What stays is what the kept mount core reads: the schema
//! version + marker name.
//!
//! The version history note below is kept as the reference for what a bump
//! means (a breaking rootfs layout; the runtime refuses a mismatched marker).

/// The rootfs schema version baked into the image marker
/// (`/.txresbench-sandbox-rootfs-schema`) by the environment image build, and
/// compared by the runtime mount probe. Bump on any breaking rootfs layout
/// change; the runtime refuses to mount an artifact whose marker disagrees.
///
/// The last shipped bump (v5) moved the interpreter environment from a
/// micromamba conda env at `/opt/conda` to a wheels-only `uv` venv at
/// `/opt/venv`, so the sandbox PATH prepends `/opt/venv/bin` (still keeping
/// `/opt/conda/bin` behind it for a legacy image). A moved interpreter prefix
/// is exactly the breaking LAYOUT change this constant exists to fence.
pub const ROOTFS_SCHEMA_VERSION: u32 = 5;

/// The marker filename at the rootfs root (read after squashfuse-mount).
pub const ROOTFS_SCHEMA_MARKER: &str = ".txresbench-sandbox-rootfs-schema";
