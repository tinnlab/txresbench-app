//! Where a run's `/output` bytes are staged (ITEM-17) — the KEPT half of the
//! former outputs contract.
//!
//! strip-single-cell ITEM-3 (map §1 `sandbox` KEEP (trim), "outputs.rs
//! artifact in/out"): the `/outputs/manifest.json` artifact contract and its
//! readers ([`OutputsManifest`]/[`ProducedOutput`]/[`load_produced_outputs`])
//! were removed with the workstore ingest pipeline they fed. What stays is the
//! STAGING TREE the stacked method run writes into: [`staging_root`],
//! [`staging_dir`], [`outputs_dir`] — the host-side layout the method sandbox
//! binds read-write at `/output` and the execution-engine's model/asset harvest
//! reads. (The `discard_staging` reaper arm went with the removing caller; the
//! boot sweep reclaims abandoned trees.)

use std::path::{Path, PathBuf};

use uuid::Uuid;

// ─────────────────────── where a run's outputs are staged (ITEM-17) ──────────

/// Root of the per-run OUTPUT STAGING trees: `<data_root>/run-staging/`.
///
/// A SIBLING of the sandbox workspace root (`<data_root>/sandboxes/`), never a
/// subdirectory of a workspace. The two have different lifetimes and that is the
/// whole reason they are different trees:
///
/// * a workspace is scratch — `/home`, `/inputs`, `/code`, the progress FIFO —
///   and dies with the run;
/// * outputs must survive until the engine's caller has consumed them, which
///   happens after the child has exited and (on a crash) possibly after a
///   restart.
///
/// While they were one tree, anything that reclaimed a workspace also destroyed
/// outputs that were still needed. Separating the trees is what makes "reclaim
/// the workspace" unable to mean "destroy the outputs".
pub fn staging_root() -> PathBuf {
    crate::modules::rootfs::data_root().join("run-staging")
}

/// One run's output staging dir: `<staging_root>/<job_id>/`.
///
/// Takes the root rather than calling [`staging_root`] so the callers and the
/// tests can be driven against an explicit pair of roots (the same shape the
/// workspace root already has).
pub fn staging_dir(staging_root: &Path, job_id: Uuid) -> PathBuf {
    staging_root.join(job_id.to_string())
}

/// The host directory bound READ-WRITE at `/output` for a run whose staging dir
/// is `staging_dir`. The ONE definition of that subdirectory name: the mkdir and
/// the bind mount both go through here, so the sandbox path and the host path
/// cannot drift apart.
pub fn outputs_dir(staging_dir: &Path) -> PathBuf {
    staging_dir.join("outputs")
}
