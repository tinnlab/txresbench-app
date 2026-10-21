//! The provenance project-extension: registers into `PROJECT_EXTENSIONS` so a project
//! delete cascades its provenance rows + marks orphaned code-blob refs into the
//! `GcManifest`. The `#[distributed_slice]` registration in `extension.rs` links
//! only because this `pub mod` is in the tree.

pub mod extension;
mod repository;
