//! Build-time staging of the TxResBench analysis-rootfs embed slot.
//!
//! STUB-ONLY (DEC-24 reversed / DEC-I, and the strip node ITEM-2): the analysis
//! rootfs is a CI-built, GHCR-published OCI artifact that the runtime
//! lazy-fetched + verified + mounted (see `src/modules/sandbox/env_image.rs`).
//! Its recipes (`src-app/env-rootfs/<env>/Dockerfile`) and the env-images
//! publish workflow were single-cell-owned and are REMOVED; the METHOD
//! environments come from the txresbench-env pipeline, not these recipes.
//!
//! This helper therefore does NO docker build and reads NO recipe tree — it
//! stages only a ZERO-BYTE stub into the `include_bytes!` slot (kept so the
//! runtime embed symbol still compiles; the embedded path is never taken and
//! the runtime self-disables on an empty payload). ITEM-3 trims the runtime
//! analysis-rootfs arms (`rootfs::embedded.rs`, the sandbox env-image provider)
//! with the single-cell machinery; until then the slot must exist for
//! `include_bytes!`.

use std::fs;
use std::path::Path;

/// Staging path (manifest-relative, so it persists across `cargo clean` like
/// txresbench's hub-seed — avoids re-running docker on every clean build).
const STAGE_REL: &str = "binaries/sandbox-rootfs/rootfs.squashfs";
const VERSION_REL: &str = "binaries/sandbox-rootfs/.version";

/// Entry point called from `build.rs`. Never returns `Err` for a rootfs-build
/// failure — it stages a stub and returns Ok (fail-soft).
pub fn setup(manifest_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let stage = manifest_dir.join(STAGE_REL);
    let version_file = manifest_dir.join(VERSION_REL);

    if let Some(parent) = stage.parent() {
        fs::create_dir_all(parent)?;
    }

    // Stub only: nothing to watch, nothing to build — see the module doc.
    write_stub(&stage, &version_file)
}

/// Write a zero-byte stub so `include_bytes!` compiles. The runtime treats an
/// empty payload as "rootfs unavailable" and self-disables.
fn write_stub(stage: &Path, version_file: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = stage.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::File::create(stage)?; // zero bytes
    let _ = fs::write(version_file, "stub");
    println!("sandbox rootfs: wrote zero-byte stub at {}", stage.display());
    Ok(())
}
