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

pub mod bundle;
pub mod envmanifest;
pub mod orchestrator;
pub mod predictions;
pub mod reconcile;
pub mod repository;
pub mod routes;
pub mod runtime;
pub mod types;

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;
use sqlx::SqlitePool;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The module instance. It holds the process pool for the boot-time work this
/// node owns (CONS-EE-1: `database::get_database_pool`'s single pool; the
/// routes receive the same pool as the `axum::Extension<SqlitePool>` the
/// framework layers — CONS-EE-1b), plus the per-run [`RunRuntime`] the ITEM-8
/// drive loops and ITEM-10's SSE routes share, and the real [`EnvProvider`]
/// (TEST-EE-01 note (b)'s "init installs the pool + the RunRuntime" half; the
/// env seam is the `jobs::seams` install precedent).
pub struct ExecutionEngineModule {
    pool: Option<Arc<SqlitePool>>,
    runtime: Option<Arc<runtime::RunRuntime>>,
    env: Option<Arc<dyn orchestrator::EnvProvider>>,
    executor: Option<Arc<dyn orchestrator::MethodExecutor>>,
}

impl ExecutionEngineModule {
    pub fn new() -> Self {
        Self {
            pool: None,
            runtime: None,
            env: None,
            executor: None,
        }
    }

    /// The run route's executor arm (ITEM-9's real [`orchestrator::MethodExecutor`]
    /// — the per-method bundle write + `run_method_in_stack` + predictions
    /// ingest + model collection behind one hook; installed at init).
    /// Consumed by ITEM-10's routes (the `mcp` field precedent).
    #[allow(dead_code)]
    pub(crate) fn executor(&self) -> Arc<dyn orchestrator::MethodExecutor> {
        self.executor
            .clone()
            .expect("init installs the executor (module init order)")
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
        // The manifest boot check (INV-4 / PROV-method-env-images-1): parse +
        // validate the embedded env manifest ONCE here, exactly like the
        // `method_catalogue` module's boot check. An error is the boxed named
        // refusal (`envmanifest::ManifestLoadError`) — module init errors
        // abort the boot, so a malformed first-party manifest is never
        // silently degraded into a per-method ENV_UNKNOWN forest. The
        // catalogue facts (`envmanifest::facts_for`) need no boot-time call:
        // the provider validates its own embed at ITS init (order 47, before
        // this module).
        envmanifest::ensure_loaded().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!(
                "method env manifest load failed: {e}"
            ))
        })?;

        // The pool the engine's repository + drive loop bind (CONS-EE-1/1b).
        // The inquiry/verification of the module-owned tables belongs to the
        // repository (query-time) and to the migration set applied at boot
        // (CONS-EE-2) — a schema the migration chain does not deliver fails at
        // query, never as a silent empty.
        let pool: Arc<SqlitePool> = ctx.db_pool.clone();
        self.pool = Some(pool.clone());

        // The per-run runtime (ITEM-8): the process's ONE instance (the
        // model_store example-set seam shares it — a run started by
        // `POST /api/txr/models/example` must stream + stop through the same
        // registry the run routes read). The real env provider + the real
        // method executor (ITEM-9) are installed the same way — the run route
        // hands both to `orchestrator::start_run` (the env seam's accessor is
        // the `jobs::seams` install precedent).
        self.runtime = Some(Arc::clone(runtime::global()));
        self.env = Some(orchestrator::real_env_provider());
        self.executor = Some(Arc::new(orchestrator::StackMethodExecutor::new(
            (*pool).clone(),
        )));
        tracing::info!(
            envs = envmanifest::envs().len(),
            "execution engine module initialized (embedded env manifest loaded)"
        );

        // Boot reconcile of runs interrupted by an app restart (ITEM-7 /
        // DEC-17): one detached pass (never awaited, so the openapi-gen
        // lazy-pool path is not blocked — a failed query there only logs;
        // the pass is data-idempotent, so a second module instance is a
        // no-op). The admitted `jobs` rows are closed by the jobs module's
        // own boot reconcile, never here.
        reconcile::spawn_boot_reconcile((*pool).clone());
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // The 16 endpoints of PROV-EE-2..EE-8 register here under `/api/txr/*`
        // (DEC-1: the free app-owned namespace) with the reused `JobsUse`
        // permission (DEC-14 — no new permission, A10 not triggered). The
        // module-installed runtime/env/executor state rides as a layered
        // extension (the `sync` resolver precedent); pool comes from the
        // framework's own `Extension<SqlitePool>`.
        let state = routes::TxrRouteState {
            runtime: self
                .runtime
                .clone()
                .expect("init installs the RunRuntime before register_routes"),
            env: self
                .env
                .clone()
                .expect("init installs the env provider before register_routes"),
            executor: self
                .executor
                .clone()
                .expect("init installs the executor before register_routes"),
        };
        router.merge(routes::txr_routes(state))
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
    use txresbench_framework::MODULE_ENTRIES;

    use super::*;

    /// TEST-EE-01 (node half, the part ITEM-1 note (b) defers to the item
    /// owning the reconcile): module init SPAWNS the boot reconcile — a run
    /// left `running` by a previous process turns `failed` + `INTERRUPTED`
    /// shortly after init, its in-flight method row marks failed, and the
    /// "interrupted on restart" line lands (DEC-17; nothing auto-reruns).
    #[tokio::test]
    async fn init_spawns_the_boot_reconcile() {
        use crate::modules::execution_engine::repository::test_support::module_pool;
        use crate::modules::execution_engine::repository::{NewMethod, NewRun, TxrRepository};
        use crate::modules::execution_engine::types::{
            RunConfig, TxrMethodState, TxrRunCounts, TxrRunFileNames, TxrRunInputSummary,
            TxrRunMode, TxrRunStatus,
        };
        use std::time::Duration;

        let pool = module_pool().await;
        let repo = TxrRepository::new(pool.clone());
        let run = NewRun {
            id: uuid::Uuid::new_v4(),
            created_at: None,
            status: TxrRunStatus::Running,
            mode: TxrRunMode::Train,
            config: RunConfig::default(),
            input_summary: TxrRunInputSummary {
                patients: Some(4),
                predict_patients: None,
                markers: 2,
                events: Some(1),
                file_names: TxrRunFileNames {
                    patients: Some("patients.csv".to_string()),
                    measurements: "measurements.csv".to_string(),
                    predict_measurements: None,
                },
            },
            model_ids: Vec::new(),
            method_count: 1,
            counts: TxrRunCounts {
                finished: 0,
                failed: 0,
                stopped: 0,
                skipped: 0,
                cannot_run: 0,
                running: 1,
                downloading: 0,
                waiting: 0,
            },
            dir: "/app-data/analysis-2026-10-21-1002-abcd1234".to_string(),
            memory_total_bytes: None,
            cpus: Some(4),
            seed: 1,
            estimate: None,
        };
        repo.insert_run(&run).await.expect("run");
        repo.insert_method(&NewMethod {
            id: uuid::Uuid::new_v4(),
            run_id: run.id,
            method_id: "dynforest".to_string(),
            label: "dynforest".to_string(),
            version: "2.0.1".to_string(),
            group: "dynamic_risk".to_string(),
            state: TxrMethodState::Running,
            bytes_total: Some(250 * 1024 * 1024),
        })
        .await
        .expect("method");

        let cfg: txresbench_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-engine-module-over-32-chars\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx = ModuleContext::new(
            Arc::new(pool),
            Arc::new(cfg),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );
        let mut module = ExecutionEngineModule::new();
        module.init(&ctx).expect("init succeeds");

        // The spawned reconcile is a background task: wait (bounded) for the
        // run to turn failed, then assert the full interruption record.
        let run_id = run.id;
        let mut row = None;
        for _ in 0..250 {
            if let Some(r) = repo.get_run(run_id).await.expect("get") {
                if r.status == "failed" {
                    row = Some(r);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let row = row.expect("the boot reconcile must fail the interrupted run");
        assert_eq!(row.error.as_deref(), Some("interrupted on restart"));
        let methods = repo.methods_for_run(run_id).await.expect("methods");
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].state, "failed");
        assert_eq!(methods[0].reason_code.as_deref(), Some("INTERRUPTED"));
        assert_eq!(repo.log_total(run_id).await.expect("logs"), 1);
    }

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
        let cfg: txresbench_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-engine-module-over-32-chars\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
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
        let cfg2: txresbench_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-engine-module-over-32-chars\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
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

    /// TEST-EE-01 note (b)'s deferred half, landed by the item that owns
    /// `runtime.rs` (ITEM-8): init installs the per-run RunRuntime AND the
    /// real env provider, and the installed runtime is live (a subscribe →
    /// broadcast round-trip reaches the stream — the drive loops and the SSE
    /// routes share this exact instance).
    #[tokio::test]
    async fn init_installs_the_run_runtime_and_env_provider() {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("in-memory pool connects");
        let cfg: txresbench_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-engine-module-over-32-chars\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx = ModuleContext::new(
            Arc::new(pool),
            Arc::new(cfg),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );

        let mut module = ExecutionEngineModule::new();
        module.init(&ctx).expect("init succeeds");
        let rt = module.runtime.as_ref().expect("init installs the RunRuntime");
        assert!(
            module.env.is_some(),
            "init installs the real env provider (the run route's seam)"
        );

        // The installed instance is live: subscribe, broadcast, receive.
        let run = uuid::Uuid::new_v4();
        let mut rx = rt.subscribe(run).expect("under cap → Some");
        rt.broadcast(
            run,
            axum::response::sse::Event::default().data("hi"),
        );
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("frame arrives")
            .expect("stream open")
            .expect("event ok");
        assert!(format!("{event:?}").contains("hi"));
        rt.close_run(run);
    }

    /// TEST-EE-01 (node half): the module-owned migrations are declared
    /// next to the module with the plan's version numbers PROV-EE-10 and
    /// each one creates its table (the build composes them into the merged
    /// chain — the table names are the seams the repository + consumers bind).
    /// The fifth file (`0005`) is the reconcile growth GAP-B/GAP-C: the
    /// produced-model columns on `txr_run_methods` — an additive `ALTER`, no
    /// new table (the table set stays PROV-EE-10's four).
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

        // The reconcile growth: 0005 adds the produced-model columns to
        // `txr_run_methods` (no CREATE TABLE — the four-table set holds).
        let grown = dir.join("202610260005_txr_run_methods_model_fields.sql");
        let grown_sql = std::fs::read_to_string(&grown)
            .unwrap_or_else(|e| panic!("migration 0005 must exist: {} ({e})", grown.display()));
        assert!(
            grown_sql.contains("ALTER TABLE txr_run_methods ADD COLUMN trained_on_patients")
                && grown_sql.contains("ALTER TABLE txr_run_methods ADD COLUMN size_bytes")
                && grown_sql.contains("ALTER TABLE txr_run_methods ADD COLUMN own_auc"),
            "0005 carries the three produced-model fields as ALTERs"
        );
        assert!(
            !grown_sql.contains("CREATE TABLE"),
            "0005 declares no table — the table set stays PROV-EE-10's four"
        );
    }
}
