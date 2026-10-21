//! Project-extension core seam. See `registry.rs`.

pub mod registry;

pub use registry::{
    get_global_registry, set_global_registry, ProjectExtension, ProjectExtensionEntry,
    ProjectExtensionRegistry, ProjectSummaryTag, PROJECT_EXTENSIONS,
};
