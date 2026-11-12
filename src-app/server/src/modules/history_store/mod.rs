//! `history_store` — the TxResBench run-history home (PROV-HS-1): the server
//! module that (a) serves the K screen's history as a searchable,
//! filterable, bounded-paged view over the engine's run records (PROV-HS-2/3
//! — one shaped item per run carrying everything the K row renders, so the
//! screen makes no N+1 per-run detail fetches), (b) owns the retention
//! policy the K footer exposes — the keep-copies preference, the per-run and
//! all-runs copy-clear operations, and the disk-usage figure (PROV-HS-4/5/6),
//! and (c) declares the contracts `ui-history` (K, wave 4) binds.
//!
//! ### Boundaries (what this module is NOT)
//!
//! - No run creation, no run control, no run persistence: `POST
//!   /api/txr/runs`, stop/skip and the run tables are `execution_engine`'s
//!   (PROV-EE-2/6/10). This module never writes `txr_runs` /
//!   `txr_run_methods` / `txr_run_logs` — the view is a READ-SIDE
//!   projection (the declared seam, PROV-EE-10; INV-6).
//! - No duplication of the engine's delete/clear routes: `DELETE
//!   /api/txr/runs/{id}?delete_files=` / `DELETE /api/txr/runs?delete_files=`
//!   stay the engine's and are CONSUMED (CONS-HS-8). This node adds only the
//!   retention-specific surface the engine's routes do not cover (copy-clear
//!   without row deletion; the preference row).
//! - No model-store writes: "Made: N models" + the reuse model names are a
//!   READ bind over `txr_model_sets` / `txr_models` (PROV-MS-11, DEC-9);
//!   the node never saves, edits, deletes or resolves a model asset
//!   (PROV-MS-8 is model-store's).
//! - No UI: screen K is `ui-history` (wave 4, consumes this node); no code
//!   under `src-app/ui/src/modules/`, no e2e tier here.
//! - No SSE/WebSocket/SyncEntity/notification channel (PROV-HS-8, mirror of
//!   PROV-EE-11): all six routes are request/response; K's freshness is the
//!   consumer's reload-on-focus choice (DEC-16).
//! - No metric/search machinery: plain SQL substring per PROV-sqlite-store-4
//!   (DEC-3) — no FTS, no index, no in-memory search engine, no new crate
//!   (DEC-15).
//! - No disk GC beyond the two explicit copy-clear operations and clear-all's
//!   `delete_files=true`: no retention window, no env-cache cleanup, no
//!   model-dir pruning (those belong elsewhere).
//!
//! ### Retention discipline (INV-2)
//!
//! The module never silently deletes a user's uploaded file copies. Copy
//! deletion exists only as the explicit per-run / all-runs clear actions
//! (PROV-HS-5), and each removes ONLY `<run_dir>/input/` (the user's file
//! copies) — never `bundles/`, never per-method outputs, never a model tree,
//! never a run record — guarded by canonicalize + the two floor checks
//! (strictly under the run's recorded `dir` AND under `rootfs::data_root()`,
//! DEC-12; a refusal = `UNSAFE_RUN_DIR`, nothing deleted).
//!
//! ### Data discipline (INV-1 / INV-4 / INV-5 / INV-7)
//!
//! No network I/O, no host, no `http(s)://` literal (the allowlist guard
//! stays green, no edit); no telemetry, no identifiers. No data in the repo:
//! tests seed synthetic runs (generated patient ids, generated file names)
//! and exercise run dirs under a temp `TXR_APP_DATA_DIR`. The K board's
//! display strings are the consumer's (`ui-history`); this module delivers
//! data verbatim (DEC-4).
//!
//! ### Persistence (PROV-HS-7)
//!
//! The module's two tables are module-owned migrations
//! `202610260009_txr_history_preferences` /
//! `202610260010_txr_run_retention` (SQLite dialect per
//! PROV-sqlite-store-4's type map). The plan's numbers 007/008 are the
//! MODEL-STORE's files (it moved onto them when the engine grew 005/006 —
//! its own DRIFT-1 ITEM-2), so the prefix marched to 009/010; see the node's
//! DRIFT-1 ITEM-1. `txr_history_preferences` is the seeded singleton
//! (created by the migration, never by code — a code INSERT is a test
//! failure), `txr_run_retention` is written lazily by the clear operations.
//!
//! ### Reuse discipline (INV-6)
//!
//! The module pattern is `modules/drafts`' flat CRUD shape minus writes;
//! the pool + migration + type-map seams are `sqlite-store`'s (CONS-HS-1..4);
//! the run-record shapes, run-dir convention and reason vocabulary are the
//! ENGINE's (CONS-HS-6/7/15) — bound, never restated; the estimator is
//! `method_catalogue`'s in-process call (CONS-HS-12, the same one the
//! engine's detail uses); all six routes gate on the reused `JobsUse`
//! permission (DEC-15 — no new permission, A10 not triggered).

pub mod repository;
pub mod retention;
pub mod routes;
pub mod types;

pub use repository::{HistoryQueryError, HistoryRepository};
pub use retention::{reset_usage_cache, Retention};
pub use types::{
    HistoryErrorCode, HistoryLimits, TxrHistoryBucket, TxrHistoryCopies, TxrHistoryDetail,
    TxrHistoryEstimate, TxrHistoryFileSize, TxrHistoryItem, TxrHistoryKind,
    TxrHistoryListQuery, TxrHistoryMethodRef, TxrHistoryModelRef, TxrHistoryModelSaved,
    TxrHistoryModelsMade, TxrHistoryPage, TxrHistoryPreferences, TxrHistoryPreferencesUpdate,
    TxrHistorySavedSet, TxrHistoryUsage, TxrRunSettingsView,
};

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use sqlx::SqlitePool;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The module instance. It holds the process pool for the boot-time work this
/// node owns (CONS-HS-1: `database::get_database_pool`'s single pool; the
/// repository + retention code bind it, and the routes receive the same pool
/// as the `axum::Extension<SqlitePool>` the framework layers), mirroring the
/// `execution_engine` / `model_store` module shapes.
pub struct HistoryStoreModule {
    pool: Option<Arc<SqlitePool>>,
}

impl HistoryStoreModule {
    pub fn new() -> Self {
        Self { pool: None }
    }
}

impl Default for HistoryStoreModule {
    fn default() -> Self {
        Self::new()
    }
}

impl AppModule for HistoryStoreModule {
    fn name(&self) -> &'static str {
        "history_store"
    }

    fn description(&self) -> &'static str {
        "TxResBench run history: the K screen's searchable paged run view, the keep-copies retention policy, and the data-usage figure (TxResBench)."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // The pool the repository + retention code bind (CONS-HS-1/2). The
        // module's tables are module-owned migrations applied at boot
        // (CONS-HS-3); their inquiry is query-time — a missing table fails at
        // query, never as a silent empty (the execution_engine regimen). No
        // other init work: the view reads on demand, the retention ops write
        // lazily, nothing here touches the DB or the data root (an
        // openapi-gen boot that only lists routes must not require a
        // writable data dir).
        let pool: Arc<SqlitePool> = ctx.db_pool.clone();
        self.pool = Some(pool);
        tracing::info!("history store module initialized");
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // The seven operations of PROV-HS-2..HS-6 register under
        // `/api/txr/history*` — the app-owned free namespace
        // (`/api/txr/runs*` + `/api/txr/models*` are the providers') — with
        // the reused `JobsUse` permission (DEC-15: no new permission, A10
        // not triggered; the engine's gate). They are the enumerated
        // `routes::HistoryRoute::ALL` inventory — one place for path, verb
        // and doc id, so a route cannot be mounted with one name and
        // documented with another (the execution_engine `TxrRoute` precedent).
        // The doc ids are `types::ROUTE_DOC_IDS` (the 7 `History.*` ids
        // pinned and asserted by the types suite AND by the routes' own
        // test); the OpenAPI regen diff is exactly these operations.
        router.merge(routes::history_routes())
    }
}

/// Module registration. Distinct order (51) — see
/// `modules/mod.rs::module_order_is_unique`; 47 is `method_catalogue`, 48 is
/// `file_validator`, 49 is `execution_engine`, 50 is `model_store` (the
/// in-process providers, earlier in the topological order), 60 is `rootfs`.
#[distributed_slice(MODULE_ENTRIES)]
static HISTORY_STORE: ModuleEntry = ModuleEntry {
    name: "history_store",
    order: 51,
    description: "TxResBench run history: the K screen's run view, retention policy, usage figure.",
    constructor: || Box::new(HistoryStoreModule::new()),
};

// The registration + init invariants, pinned HERE so the node owns its half
// of the check (the ITEM-1 split of TEST-HS-6 — the module is registered
// exactly once at the declared order, init installs the process pool on the
// module without touching the DB, and the merged migration chain delivers
// the module's two tables + the seeded preference row; the integration half
// — real boot, health, the route list — lands with the suites that own the
// boot + routes, ITEM-4/5, per the model_store TEST-MS-01 split precedent).
// Order 51 is unique in the linked set (see the order list above); the
// framework's GLOBAL `module_order_is_unique` /
// `sorted_module_order_is_link_order_independent` stay red on the
// PRE-EXISTING order-4 tie (`health` + `localsession` — documented by every
// prior txr node; an epic-level finding, NOT caused by this node).
#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use uuid::Uuid;
    use txresbench_framework::MODULE_ENTRIES;

    use super::*;

    /// TEST-HS-6 (node half): `history_store` is registered under
    /// `MODULE_ENTRIES` exactly once, with the declared order 51, and no
    /// OTHER module occupies 51.
    #[test]
    fn registers_once_at_unique_order_51() {
        let me: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.name == "history_store")
            .collect();
        assert_eq!(
            me.len(),
            1,
            "exactly one history_store registration: {me:?}"
        );
        assert_eq!(me[0].order, 51, "the declared integration order");

        let order51: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.order == 51)
            .map(|e| e.name)
            .collect();
        assert_eq!(
            order51,
            vec!["history_store"],
            "no other module at order 51"
        );

        let built = (me[0].constructor)();
        assert_eq!(built.name(), "history_store");
        assert!(built
            .description()
            .starts_with("TxResBench run history"));
    }

    /// TEST-HS-6 (node half): the module's init installs the process pool on
    /// the module (the seam the repository + retention code bind). It must
    /// not touch the DB — the openapi-gen init runs the same code with a
    /// lazy, never-connected pool.
    #[tokio::test]
    async fn init_installs_the_pool() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("in-memory pool connects");
        let cfg: txresbench_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-history-store-module-over-32-chars\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx = ModuleContext::new(
            Arc::new(pool),
            Arc::new(cfg),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );

        let mut module = HistoryStoreModule::new();
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
        let cfg2: txresbench_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-history-store-module-over-32-chars\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx2 = ModuleContext::new(
            Arc::new(lazy),
            Arc::new(cfg2),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );
        let mut module2 = HistoryStoreModule::new();
        module2.init(&ctx2).expect("lazy-pool init succeeds");
        assert!(module2.pool.is_some());
    }

    /// TEST-HS-6 (node half): the MERGED chain (the runtime's
    /// `MERGED_MIGRATOR` shape — build.rs composes the module-owned dirs
    /// into `migrations-merged/`) applies cleanly against a fresh database
    /// and delivers the module's two tables: the preference singleton seeded
    /// by the migration (the board's `keep_file_copies: true`, `updated_at`
    /// stamped) and an empty `txr_run_retention`. `txr_runs` (the engine's
    /// table) is present — the FK's parent, and the proof that the two
    /// modules' chains compose in one order.
    #[tokio::test]
    async fn merged_chain_delivers_the_module_tables() {
        let path = std::env::temp_dir().join(format!(
            "history-store-item1-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite file connects");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR
            .run(&pool)
            .await
            .expect("merged migrations apply");

        let row = sqlx::query_as::<_, (i64, i64, String)>(
            "SELECT id, keep_file_copies, updated_at FROM txr_history_preferences WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .expect("the preference singleton exists");
        assert_eq!(row.0, 1, "the singleton id");
        assert_eq!(row.1, 1, "the migration seeds keep_file_copies = true");
        assert!(
            !row.2.is_empty(),
            "the migration stamps updated_at (RFC3339 UTC): {}",
            row.2
        );

        let retention: i64 = sqlx::query_scalar("SELECT count(*) FROM txr_run_retention")
            .fetch_one(&pool)
            .await
            .expect("retention table exists");
        assert_eq!(retention, 0, "retention rows are lazy (never seeded)");

        let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM txr_runs")
            .fetch_one(&pool)
            .await
            .expect("the engine's run table exists (the FK parent)");
        assert_eq!(runs, 0);

        let _ = std::fs::remove_file(&path);
    }
}
