//! `model_store` — the TxResBench saved-model home (PROV-MS-1): the server
//! module that (a) saves a run's produced `/model` trees (PROV-EE-9) into a
//! managed local store as named sets with optional training-file copies, (b)
//! provides the inventory the J / I screens render (metadata, sizes,
//! training-data warning, provenance), (c) exports/imports the single-file
//! `.txr` container for moving models between computers, (d) answers
//! per-model eligibility + time estimates for the shared list component, and
//! (e) resolves a model id to the verified asset record the engine binds
//! read-only on reuse (PROV-EE-9's caller-side join shape by design — the
//! engine never imports this module, and the join happens with the engine's
//! own asset element).
//!
//! ### Boundaries (what this module is NOT)
//!
//! - No model training or execution: `execution_engine` produces `/model`
//!   artifacts; the store never runs a method, never parses a model file for
//!   meaning, never ships one into a sandbox (INV-2).
//! - No pretrained catalogue / download / sha256-of-release-asset
//!   verification / update checks: `pretrained-catalogue`'s surfaces. The
//!   store's pretrained import seam receives ALREADY-VERIFIED bytes and
//!   refuses a licence-less install.
//! - No history/rerun semantics: a saved model's reuse runs live in
//!   `execution-engine` and `history-store`; deleting a store entry never
//!   touches a run row (board J: "Results already made with it are kept in
//!   History").
//! - No second DB, no scheduler, no blob store, no `SyncEntity`, no
//!   SSE/WebSocket surface (DEC-15): model trees are plain directories under
//!   `rootfs::data_root()` because the sandbox binds PATHs (DEC-2), and all
//!   routes are request/response.
//!
//! ### Data discipline (INV-1 / INV-8)
//!
//! The store performs no network I/O at all; the only bytes it ever
//! imports/exports are the user's own `.txr` files. The produced tree is an
//! OPAQUE, immutable artifact: copied byte-for-byte under
//! `<data_root>/models/trees/<tree_sha256>/`, content-addressed by the
//! engine's own digest (PROV-SS-3), every row a reference (the tree layer in
//! [`store`]: dirs, copy, size, training copies, prune). `embeds_training_data`
//! is the catalogue's fact verbatim (GAP-A) — the L dialog's warning is data,
//! never an app-side hardcoded method list.
//!
//! ### Persistence (PROV-MS-11)
//!
//! The module's two tables are the module-owned migrations
//! `202610260007_txr_model_sets` / `202610260008_txr_models` (SQLite
//! dialect per PROV-sqlite-store-4's type map; the plan's numbers 005/006
//! were taken by the engine's own growth — see the node's DRIFT-1 ITEM-2).
//! `txr_model_sets` is the user-named save set (DEC-10), `txr_models` the
//! saved-model rows with the recorded requirements + provenance; all reads
//! and writes live in [`repository`] (`ModelStoreRepository`, the flat-CRUD
//! shape of `modules/drafts`).
//!
//! ### Reuse discipline (INV-7)
//!
//! Flat CRUD over `sqlite-store`'s pool + migration seams (CONS-MS-1..4) like
//! `modules/drafts`; tree bytes stream through `modules::file::stream` for the
//! import route; the tree digest comes from `modules::sandbox::stack`
//! (PROV-SS-3 — ONE definition, the store never re-implements the algorithm);
//! the eligibility verdicts bind `method_catalogue`'s in-process matchers +
//! estimator (PROV-MC-7) with the provider's reason vocabulary + one added
//! code; `size_bytes` / `own_auc` are the ENGINE's recorded fields (GAP-B/C —
//! this module computes no metrics, reads no CSV).

pub mod repository;
pub mod store;
pub mod types;

pub use types::{
    CovariateFacts, ExportTarget, ImportOutcome, MarkerFacts, ModelDetail, ModelEligibility,
    ModelEligibilityRequest, ModelEligibilityResponse, ModelListQuery, ModelListResponse,
    ModelProvenance, ModelReason, ModelReasonCode, ModelRequestError, ModelRequestErrorCode,
    ModelSaveResponse, ModelSetListResponse, ModelStoreLimits, ModelSummary, ModelWarning,
    ModelWarningCode, RenameRequest, ResolveRequest, ResolveResponse, ResolvedAsset,
    SaveModelsRequest, SaveTarget, SetDeleteQuery, SetSummary,
};

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use sqlx::SqlitePool;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The module instance. It holds the process pool for the boot-time work this
/// node owns (CONS-MS-1/2: `database::get_database_pool`'s single pool; the
/// routes receive the same pool as the `axum::Extension<SqlitePool>` the
/// framework layers), mirroring the `execution_engine` module's shape.
pub struct ModelStoreModule {
    pool: Option<Arc<SqlitePool>>,
}

impl ModelStoreModule {
    pub fn new() -> Self {
        Self { pool: None }
    }
}

impl Default for ModelStoreModule {
    fn default() -> Self {
        Self::new()
    }
}

impl AppModule for ModelStoreModule {
    fn name(&self) -> &'static str {
        "model_store"
    }

    fn description(&self) -> &'static str {
        "TxResBench saved-model home: named sets, .txr import/export, verified reuse resolution, per-model eligibility (TxResBench)."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // The pool the store's repository + tree store bind (CONS-MS-1/1b).
        // The module's tables are module-owned migrations applied at boot
        // (CONS-MS-3); their inquiry is query-time — the schema the migration
        // chain delivers fails at query, never as a silent empty (the
        // execution_engine regimen). The store dirs are created lazily by the
        // tree store on first write, never at init (a boot that only lists
        // models must not require a writable data dir).
        let pool: Arc<SqlitePool> = ctx.db_pool.clone();
        self.pool = Some(pool);
        tracing::info!("model store module initialized");
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // The 13 endpoints of PROV-MS-2..MS-9 register under
        // `/api/txr/models*` + `/api/txr/model-sets*` (the app-owned free
        // namespace) with the reused `JobsUse` permission (DEC-14 — no new
        // permission, A10 not triggered; the engine's gate). The doc ids
        // they bind are `types::ROUTE_DOC_IDS`; the routes' own suite pins
        // the registered set to that vocabulary.
        router
    }
}

/// Module registration. Distinct order (50) — see
/// `modules/mod.rs::module_order_is_unique`; 47 is `method_catalogue`, 48 is
/// `file_validator`, 49 is `execution_engine` (this node's in-process
/// providers, earlier in the topological order), 60 is `rootfs`.
#[distributed_slice(MODULE_ENTRIES)]
static MODEL_STORE: ModuleEntry = ModuleEntry {
    name: "model_store",
    order: 50,
    description: "TxResBench saved-model home: named sets, .txr import/export, reuse resolution.",
    constructor: || Box::new(ModelStoreModule::new()),
};

// The registration + init invariants, pinned HERE so the node owns its half of
// the check (TEST-MS-01): the module is registered exactly once at the
// declared order, and init installs the process pool on the module (the
// repository + tree store seam, CONS-MS-1) without touching the DB (the
// openapi-gen path runs the same init with a lazy pool — the engine's
// TEST-EE-01 split precedent). Order 50 is unique (50 is free in the linked
// set); the framework's GLOBAL `module_order_is_unique` /
// `sorted_module_order_is_link_order_independent` stay red on the
// PRE-EXISTING order-4 tie (`health` + `localsession` — documented by
// execution_engine / method_catalogue / file-validator; an epic-level
// finding, NOT caused by this node). The store-dir idempotence half belongs
// to the item that owns `store.rs` (dir creation is the tree store's
// first-write concern).
#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;
    use ziee_framework::MODULE_ENTRIES;

    use super::*;

    /// TEST-MS-01 (node half): `model_store` is registered under
    /// `MODULE_ENTRIES` exactly once, with the declared order 50, and no OTHER
    /// module occupies 50.
    #[test]
    fn registers_once_at_unique_order_50() {
        let me: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.name == "model_store")
            .collect();
        assert_eq!(
            me.len(),
            1,
            "exactly one model_store registration: {me:?}"
        );
        assert_eq!(me[0].order, 50, "the declared integration order");

        let order50: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.order == 50)
            .map(|e| e.name)
            .collect();
        assert_eq!(
            order50,
            vec!["model_store"],
            "no other module at order 50"
        );

        let built = (me[0].constructor)();
        assert_eq!(built.name(), "model_store");
        assert!(built
            .description()
            .starts_with("TxResBench saved-model home"));
    }

    /// TEST-MS-01 (node half): the module's init installs the process pool on
    /// the module (the seam the repository + tree store bind). It must not
    /// touch the DB — the openapi-gen init runs the same code with a lazy,
    /// never-connected pool.
    #[tokio::test]
    async fn init_installs_the_pool() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("in-memory pool connects");
        let cfg: ziee_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-model-store-module-over-32-chars\"\n  issuer: \"cytoanalyst\"\n  audience: \"cytoanalyst-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx = ModuleContext::new(
            Arc::new(pool),
            Arc::new(cfg),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );

        let mut module = ModelStoreModule::new();
        module.init(&ctx).expect("init succeeds against a live pool");
        assert!(
            module.pool.is_some(),
            "init must install the process pool on the module"
        );

        // The openapi-gen path: same init, lazy never-connected pool.
        let lazy = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_lazy("sqlite::memory:")
            .expect("lazy pool parses");
        let cfg2: ziee_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-model-store-module-over-32-chars\"\n  issuer: \"cytoanalyst\"\n  audience: \"cytoanalyst-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx2 = ModuleContext::new(
            Arc::new(lazy),
            Arc::new(cfg2),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );
        let mut module2 = ModelStoreModule::new();
        module2.init(&ctx2).expect("lazy-pool init succeeds");
        assert!(module2.pool.is_some());
    }
}
