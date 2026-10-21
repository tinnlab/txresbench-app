//! The dataset project-extension: registers into `PROJECT_EXTENSIONS` so a project
//! delete cleans up its datasets, a project duplicate deep-copies them, and the
//! project exposes a dataset-summary route. The `#[distributed_slice]` registration
//! in `extension.rs` links only because this `pub mod` is in the tree.

pub mod extension;
mod handlers;
pub mod models;
mod repository;
mod routes;
