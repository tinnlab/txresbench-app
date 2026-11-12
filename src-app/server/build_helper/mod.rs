//! TxResBench build-helper modules (invoked from `build.rs`).
//!
//! Mirrors txresbench's `build_helper/` layout: each file stages one embedded asset
//! under `binaries/` for the runtime `include_bytes!`, fail-soft (a failure
//! writes a zero-byte stub and the feature self-disables at runtime — never a
//! build panic). See [[feedback_build_system]].
//!
//! The build-time processor-manifest syntax gate used to live here
//! (`processor_manifest.rs`) — the strip node removed its build.rs invocation
//! with the processor packages; the FILE stays as the lib's single-source
//! `processor_manifest_lint` (see `src/lib.rs`) until ITEM-3 removes the
//! extensions/processor machinery with it.

pub mod sandbox_rootfs;
