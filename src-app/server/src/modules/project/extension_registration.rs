//! Auto-register discovered project extensions in `order`. Mirrors ziee's
//! `project/extension_registration.rs`.

use sqlx::SqlitePool;

use super::core::extension::{ProjectExtensionRegistry, PROJECT_EXTENSIONS};

/// Build a registry from every `#[distributed_slice(PROJECT_EXTENSIONS)]` entry,
/// sorted by `order`.
pub fn auto_register_project_extensions(pool: SqlitePool) -> ProjectExtensionRegistry {
    let mut registry = ProjectExtensionRegistry::new();

    let mut entries: Vec<_> = PROJECT_EXTENSIONS.iter().collect();
    entries.sort_by_key(|e| e.order);

    for entry in entries {
        tracing::debug!(
            "Registering project extension: {} (order: {})",
            entry.name,
            entry.order
        );
        registry.register((entry.factory)(pool.clone()));
    }

    registry
}
