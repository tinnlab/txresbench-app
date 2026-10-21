//! The host-owned artifacts catalog (ITEM-2/ITEM-7 control-plane data).

pub mod models;
pub mod repository;

pub use models::{Artifact, ArtifactFilter, NewArtifact};
pub use repository::{BlobRefRow, CatalogRepository};
