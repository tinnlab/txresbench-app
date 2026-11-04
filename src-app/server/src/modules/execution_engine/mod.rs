//! `execution_engine` — the TxResBench run engine (PROV-EE-1): one analysis =
//! one persisted run row holding the analysis config, the input snapshot and
//! the selected methods / resolved models; the engine validates eligibility
//! per method at run start, prepares each method's contract bundle, drives the
//! environment download state, executes each method in its own sandboxed
//! stack, streams per-method progress/log/state over SSE, supports
//! stop/skip, keeps failures with their reasons, normalizes container output
//! into the contract's universal outputs and persists everything so History
//! can reopen, rerun and clear runs (see the node's PLAN for the full
//! contract; the module's own `README.md` documents the surface).
//!
//! ### Boundaries (what this module is NOT)
//!
//! - No sandbox machinery: bwrap argv, layer mounting, env fetch/verify/cache
//!   are the `sandbox` module's (`run_method_in_stack`, PROV-SS-1/3/4).
//! - No env-image build/publish (`method-env-images` publishes the committed
//!   `src-app/server/data/method-env-images.json` this node embeds).
//! - No catalogue facts / eligibility engine / estimates (`method_catalogue`
//!   is this node's in-process provider, CONS-EE-9/9c).
//! - No CSV/Excel parsing or the canonical bundle model itself
//!   (`file_validator`; the engine calls `validate` + `canonical_bundle` on
//!   the in-memory parsed tables, CONS-EE-11/11b).
//! - No SQLite runtime, no DB bootstrap (`sqlite-store`; the engine takes the
//!   process `SqlitePool`, CONS-EE-1/1b).
//! - No model persistence: saving/exporting trained models is `model-store`'s
//!   join against this node's `produced_models` surface (PROV-EE-9).
//!
//! ### Reuse discipline (INV-7)
//!
//! The engine is a module, not a parallel scheduler: per-method execution is
//! admitted through `jobs::admission` (one global concurrency cap), stoppable
//! through `jobs::runtime` (cancel registration + signal), and the run drive
//! loop follows the `provenance::verify` finally-close discipline. The engine
//! adds its own per-run lane semaphore (the board's "run N at a time").

pub mod types;

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use sqlx::SqlitePool;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The module instance. It holds the process pool for the boot-time work this
/// node owns (CONS-EE-1: `database::get_database_pool`'s single pool; the
/// routes receive the same pool as the `axum::Extension<SqlitePool>` the
/// framework layers — CONS-EE-1b).
pub struct ExecutionEngineModule {
    pool: Option<Arc<SqlitePool>>,
}

impl ExecutionEngineModule {
    pub fn new() -> Self {
        Self { pool: None }
    }
}

impl Default for ExecutionEngineModule {
    fn default() -> Self {
        Self::new()
    }
}

impl AppModule for ExecutionEngineModule {
    fn name(&self) -> &'static str {
        "execution_engine"
    }

    fn description(&self) -> &'static str {
        "TxResBench run engine: per-method sandboxed runs, run persistence, progress/logs over SSE, contract predictions (TxResBench)."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // The pool the engine's repository + drive loop bind (CONS-EE-1/1b).
        // The inquiry/verification of the module-owned tables belongs to the
        // repository (query-time) and to the migration set applied at boot
        // (CONS-EE-2) — a schema the migration chain does not deliver fails at
        // query, never as a silent empty.
        let pool: Arc<SqlitePool> = ctx.db_pool.clone();
        self.pool = Some(pool);
        tracing::info!("execution engine module initialized");
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // The 15 endpoints of PROV-EE-2..EE-8 register here under `/api/txr/*`
        // (DEC-1: the free app-owned namespace) with the reused `JobsUse`
        // permission (DEC-14 — no new permission, A10 not triggered).
        router
    }
}

/// Module registration. Distinct order (49) — see
/// `modules/mod.rs::module_order_is_unique`; 47 is `method_catalogue`, 48 is
/// `file_validator` (this node's in-process providers, earlier in the
/// topological order), 60 is `rootfs`.
#[distributed_slice(MODULE_ENTRIES)]
static EXECUTION_ENGINE: ModuleEntry = ModuleEntry {
    name: "execution_engine",
    order: 49,
    description: "TxResBench run engine: per-method sandboxed runs, run persistence, logs, stop/skip.",
    constructor: || Box::new(ExecutionEngineModule::new()),
};

// The registration + init invariants, pinned HERE so the node owns its half of
// the check (TEST-EE-01). The framework's global `module_order_is_unique` is
// red at the branch base on a PRE-EXISTING order-4 tie (`health` +
// `localsession`); the node's own acceptance is asserted locally and the
// framework tie stays an epic-level finding (file_validator's TEST-FV-19 note).
#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;
    use ziee_framework::MODULE_ENTRIES;

    use super::*;

    /// TEST-EE-01 (node half): `execution_engine` is registered under
    /// `MODULE_ENTRIES` exactly once, with the declared order 49, and no OTHER
    /// module occupies 49.
    #[test]
    fn registers_once_at_unique_order_49() {
        let me: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.name == "execution_engine")
            .collect();
        assert_eq!(
            me.len(),
            1,
            "exactly one execution_engine registration: {me:?}"
        );
        assert_eq!(me[0].order, 49, "the declared integration order");

        let order49: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.order == 49)
            .map(|e| e.name)
            .collect();
        assert_eq!(order49, vec!["execution_engine"], "no other module at order 49");

        let built = (me[0].constructor)();
        assert_eq!(built.name(), "execution_engine");
        assert!(built
            .description()
            .starts_with("TxResBench run engine"));
    }

    /// TEST-EE-01 (node half): the module's init installs the pool (the
    /// repository + drive loop seam, CONS-EE-1). The init runs the boot
    /// reconcile + installs the RunRuntime at the items that own those
    /// pieces (reconcile/runtime); the shape each lands in is asserted there.
    #[tokio::test]
    async fn init_installs_the_pool() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("in-memory pool connects");
        let cfg: ziee_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-engine-module-over-32-chars\"\n  issuer: \"cytoanalyst\"\n  audience: \"cytoanalyst-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx = ModuleContext::new(
            Arc::new(pool),
            Arc::new(cfg),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );

        let mut module = ExecutionEngineModule::new();
        module.init(&ctx).expect("init succeeds against a live pool");
        assert!(
            module.pool.is_some(),
            "init must install the process pool on the module"
        );

        // The init is also the openapi-gen path's init (spec generation calls
        // it with a lazy, never-connected pool) — it must not touch the DB.
        let lazy = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_lazy("sqlite::memory:")
            .expect("lazy pool parses");
        let cfg2: ziee_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-engine-module-over-32-chars\"\n  issuer: \"cytoanalyst\"\n  audience: \"cytoanalyst-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx2 = ModuleContext::new(
            Arc::new(lazy),
            Arc::new(cfg2),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );
        let mut module2 = ExecutionEngineModule::new();
        module2.init(&ctx2).expect("lazy-pool init succeeds");
        assert!(module2.pool.is_some());
    }

    /// TEST-EE-01 (node half): the four module-owned migrations are declared
    /// next to the module with the plan's exact version numbers PROV-EE-10 and
    /// each one creates its table (the build composes them into the merged
    /// chain — the table names are the seams the repository + consumers bind).
    #[test]
    fn migrations_declare_the_four_txr_tables() {
        use std::path::PathBuf;

        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/modules/execution_engine/migrations");
        let names = [
            "202610260001_txr_runs.sql",
            "202610260002_txr_run_methods.sql",
            "202610260003_txr_run_logs.sql",
            "202610260004_txr_app_config.sql",
        ];
        let mut tables = Vec::new();
        let mut sqls = Vec::new();
        for name in names {
            let path = dir.join(name);
            let sql = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("migration {} must exist: {e}", path.display()));
            let create: Vec<&str> = sql
                .lines()
                .filter(|l| l.starts_with("CREATE TABLE"))
                .collect();
            assert_eq!(create.len(), 1, "{name} declares exactly one table");
            tables.push(create[0].to_string());
            sqls.push(sql);
        }
        assert!(
            tables
                .iter()
                .any(|t| t.contains("txr_runs") && t.contains("CREATE TABLE")),
            "txr_runs declared"
        );
        assert!(
            sqls[1].contains("REFERENCES txr_runs")
                && tables[1].contains("txr_run_methods"),
            "txr_run_methods declared with its txr_runs reference"
        );
        assert!(
            sqls[2].contains("REFERENCES txr_runs") && tables[2].contains("txr_run_logs"),
            "txr_run_logs declared with its txr_runs reference"
        );
        assert!(
            tables[3].contains("txr_app_config"),
            "txr_app_config declared"
        );
        // The version numbers are the plan's, in order, unique per file
        // (merge-gate C2) and later than the current maximum.
        let versions: Vec<&str> = names.iter().map(|n| &n[..12]).collect();
        assert_eq!(
            versions,
            vec![
                "202610260001",
                "202610260002",
                "202610260003",
                "202610260004"
            ]
        );
    }
}
