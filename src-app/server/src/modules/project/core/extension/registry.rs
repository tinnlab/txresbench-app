//! Project-extension registry — the backend seam by which future project
//! sub-modules (samples, upload, clustering, embedding, visualization, …) plug
//! into a project without the project core importing any of them.
//!
//! Mirrors ziee's `project/core/extension/registry.rs` (the Chat-Projects
//! extension pattern): a `linkme` distributed slice of registration entries, a
//! `ProjectExtension` trait whose hooks default to no-ops, a registry that folds
//! routes + fans lifecycle hooks over one shared transaction, and a process-wide
//! `OnceCell` singleton.
//!
//! **Intentional divergence from ziee (per the feature brief):** we add an
//! `on_project_deleted` hook. ziee's project pattern is cascade-only (it leans on
//! `ON DELETE CASCADE`); here a project delete must let each module clean up its
//! project-scoped data AND files/artifacts (not just the DB rows a cascade would
//! drop), so the delete runs in a transaction that fires this hook first.

use aide::axum::ApiRouter;
use async_trait::async_trait;
use linkme::distributed_slice;
use once_cell::sync::OnceCell;
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::Arc;
use uuid::Uuid;

use ziee_core::AppError;

use crate::modules::project::gc::GcManifest;

/// A summary tag an extension contributes about a project (e.g. `"3 datasets"`).
/// The backend analog of the FE `card_tags` slot — available for tags that
/// aren't already projected onto `ProjectDto`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSummaryTag {
    /// Stable id (dedup / React key on the FE if surfaced).
    pub id: &'static str,
    /// Human-readable label, e.g. `"3 datasets"`.
    pub label: String,
}

/// Registration entry collected into the [`PROJECT_EXTENSIONS`] distributed slice.
/// `Copy` so it can live as a `static`; `factory` is a bare fn pointer building
/// the trait object from the DB pool (the only dependency the first consumer
/// needs — kept narrower than ziee's `(PgPool, Config)`).
#[derive(Clone, Copy)]
pub struct ProjectExtensionEntry {
    pub name: &'static str,
    pub order: i32,
    pub factory: fn(PgPool) -> Arc<dyn ProjectExtension>,
}

/// Distributed slice collecting every project extension at link time. A consumer
/// registers by declaring a `#[distributed_slice(PROJECT_EXTENSIONS)] static … =
/// ProjectExtensionEntry { … }` — no central edit, no `submit!` macro.
#[distributed_slice]
pub static PROJECT_EXTENSIONS: [ProjectExtensionEntry] = [..];

/// A project extension contributes routes + in-transaction lifecycle hooks.
///
/// Only [`name`](ProjectExtension::name) is required; every hook defaults to a
/// no-op so an extension implements just what it cares about and the whole seam
/// degrades cleanly to zero extensions.
#[async_trait]
pub trait ProjectExtension: Send + Sync {
    /// Extension name (logging/debugging).
    fn name(&self) -> &str;

    /// Mount this extension's API routes. Default: none.
    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router
    }

    /// Called inside the project-DELETE transaction, BEFORE the project row is
    /// deleted. Override to remove this extension's project-scoped data (beyond what
    /// `ON DELETE CASCADE` handles) AND to `gc.mark()` any content-addressed blob
    /// refs the deleted rows pointed at — collect-in-tx / free-post-commit (the tx
    /// CANNOT unlink object-store blobs; see `project::gc`). Default: no-op.
    async fn on_project_deleted(
        &self,
        _project_id: Uuid,
        _tx: &mut Transaction<'_, Postgres>,
        _gc: &mut GcManifest,
    ) -> Result<(), AppError> {
        Ok(())
    }

    /// Called inside the project-DUPLICATE transaction, after the destination
    /// project row is created. Override to deep-copy this extension's per-project
    /// rows into the duplicate. Default: no-op.
    async fn on_project_duplicated(
        &self,
        _src_project_id: Uuid,
        _dst_project_id: Uuid,
        _tx: &mut Transaction<'_, Postgres>,
    ) -> Result<(), AppError> {
        Ok(())
    }

    /// Contribute summary tags for a project (the backend analog of the FE
    /// `card_tags` slot). Default: none.
    async fn collect_summary(
        &self,
        _project_id: Uuid,
        _user_id: Uuid,
    ) -> Result<Vec<ProjectSummaryTag>, AppError> {
        Ok(Vec::new())
    }

    /// Initialize once at startup. Default: no-op.
    async fn initialize(&self, _pool: &PgPool) -> Result<(), AppError> {
        Ok(())
    }
}

/// Holds the registered extensions and drives routes + hooks.
pub struct ProjectExtensionRegistry {
    extensions: Vec<Arc<dyn ProjectExtension>>,
}

impl ProjectExtensionRegistry {
    pub fn new() -> Self {
        Self { extensions: Vec::new() }
    }

    pub fn register(&mut self, extension: Arc<dyn ProjectExtension>) {
        tracing::info!("Registering project extension: {}", extension.name());
        self.extensions.push(extension);
    }

    /// Number of registered extensions (test/introspection).
    pub fn len(&self) -> usize {
        self.extensions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.extensions.is_empty()
    }

    /// Run every extension's `initialize` once at startup.
    pub async fn initialize_all(&self, pool: &PgPool) -> Result<(), AppError> {
        for ext in &self.extensions {
            ext.initialize(pool).await?;
        }
        Ok(())
    }

    /// Fold every extension's routes into `router`.
    pub fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        self.extensions
            .iter()
            .fold(router, |router, ext| ext.register_routes(router))
    }

    /// Fire `on_project_deleted` on every extension sequentially over one shared
    /// `&mut tx`. First error aborts (the caller's `commit` is then never
    /// reached → the whole delete rolls back atomically).
    pub async fn fire_on_project_deleted(
        &self,
        project_id: Uuid,
        tx: &mut Transaction<'_, Postgres>,
        gc: &mut GcManifest,
    ) -> Result<(), AppError> {
        for ext in &self.extensions {
            ext.on_project_deleted(project_id, tx, gc).await?;
        }
        Ok(())
    }

    /// Fire `on_project_duplicated` on every extension sequentially over one shared
    /// `&mut tx`.
    pub async fn fire_on_project_duplicated(
        &self,
        src_project_id: Uuid,
        dst_project_id: Uuid,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<(), AppError> {
        for ext in &self.extensions {
            ext.on_project_duplicated(src_project_id, dst_project_id, tx).await?;
        }
        Ok(())
    }

    /// Aggregate summary tags from every extension (registration order).
    ///
    /// **No production caller — the tags this builds reach no route and no screen.** The
    /// project card's tags are contributed CLIENT-side through the `card_tags` slot
    /// (`ui/src/modules/project/core/extensions`), and only the dataset module
    /// contributes one today ("N datasets", read off the already-loaded
    /// `ProjectDto.dataset_count`). Every `ProjectExtension::collect_summary` impl below
    /// it is consequently unreached.
    ///
    /// Recorded rather than deleted because which of the two it should be is a decision
    /// with a UI half — mount this and drop the client-side slot, or drop this and let
    /// the slot be the mechanism — and not one to make as a side effect of fixing the
    /// arithmetic inside it (task #148, which found this while verifying that the
    /// "N results / X GB" tag it was fixing is not on screen).
    pub async fn collect_summary(
        &self,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<ProjectSummaryTag>, AppError> {
        let mut all = Vec::new();
        for ext in &self.extensions {
            all.extend(ext.collect_summary(project_id, user_id).await?);
        }
        Ok(all)
    }
}

impl Default for ProjectExtensionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

static PROJECT_EXTENSION_REGISTRY: OnceCell<Arc<ProjectExtensionRegistry>> = OnceCell::new();

/// Publish the process-wide registry (called once from the project module `init`).
pub fn set_global_registry(registry: Arc<ProjectExtensionRegistry>) {
    if PROJECT_EXTENSION_REGISTRY.set(registry).is_err() {
        tracing::warn!(
            "project: set_global_registry called more than once; ignoring. \
             A second bootstrap path — investigate."
        );
    }
}

/// The process-wide registry, or `None` before the project module has initialized.
pub fn get_global_registry() -> Option<Arc<ProjectExtensionRegistry>> {
    PROJECT_EXTENSION_REGISTRY.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockExt {
        name: &'static str,
        tag: &'static str,
    }

    #[async_trait]
    impl ProjectExtension for MockExt {
        fn name(&self) -> &str {
            self.name
        }
        async fn collect_summary(
            &self,
            _project_id: Uuid,
            _user_id: Uuid,
        ) -> Result<Vec<ProjectSummaryTag>, AppError> {
            Ok(vec![ProjectSummaryTag {
                id: self.name,
                label: self.tag.to_string(),
            }])
        }
    }

    #[tokio::test]
    async fn empty_registry_is_a_noop() {
        // The whole seam must degrade to zero extensions: collect returns empty,
        // len is 0. (fire_* over an empty vec is trivially Ok; it needs a real tx
        // so it's exercised at the integration tier — TEST-2/TEST-3.)
        let reg = ProjectExtensionRegistry::new();
        assert!(reg.is_empty());
        assert_eq!(reg.len(), 0);
        let tags = reg
            .collect_summary(Uuid::new_v4(), Uuid::new_v4())
            .await
            .expect("collect");
        assert!(tags.is_empty());
    }

    #[tokio::test]
    async fn collect_summary_aggregates_in_registration_order() {
        let mut reg = ProjectExtensionRegistry::new();
        reg.register(Arc::new(MockExt { name: "a", tag: "1 alpha" }));
        reg.register(Arc::new(MockExt { name: "b", tag: "2 beta" }));
        assert_eq!(reg.len(), 2);
        let tags = reg
            .collect_summary(Uuid::new_v4(), Uuid::new_v4())
            .await
            .expect("collect");
        // Aggregated across both extensions, in the order they were registered.
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].id, "a");
        assert_eq!(tags[0].label, "1 alpha");
        assert_eq!(tags[1].id, "b");
        assert_eq!(tags[1].label, "2 beta");
    }
}
