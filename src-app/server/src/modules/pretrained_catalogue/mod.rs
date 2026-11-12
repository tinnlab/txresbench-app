//! `pretrained_catalogue` — the frozen published models feature (TxResBench,
//! PROV-PC-1..PROV-PC-12): the catalogue of published frozen models (cards +
//! release-asset pointers, generated at build time and gated against
//! restricted data — DEC-8), a server module that serves the catalogue with
//! a live → disk → embedded refresh (INV-8), downloads + sha256-verifies +
//! caches model assets (the same download-state vocabulary as method
//! environments — DEC-6), installs verified assets into the local model store
//! (`model_store`'s pretrained provenance seam, CONS-PC-3/4/5 — the same
//! import path a user's own `.txr` takes), answers per-model eligibility +
//! time estimates from the uploaded file (DEC-10), and declares the bundle
//! contract the installer build consumes (PROV-PC-12).
//!
//! ## Boundaries (what this module is NOT)
//!
//! - No UI: screen D and the pretrained rows of the shared list are
//!   `ui-models`; this node serves data + actions only (no `src-app/ui/**`
//!   workspace file, no e2e tier).
//! - No model execution, no sandbox calls, no env downloads — a model never
//!   runs here (INV-6). The only execution path is the engine's reuse mode
//!   against the verified store row.
//! - No model-store logic: the store owns rows, trees, sets, `.txr` parsing,
//!   provenance records and delete semantics; this node verifies the
//!   network-level asset sha256 (INV-2) and hands verified bytes to the
//!   import seam (CONS-PC-3).
//! - No DB, no migrations, no sqlx: catalogue + download state are files
//!   under the app data root (`<data_root>/pretrained/`,
//!   `<data_root>/txr-pretrained/`, `<data_root>/pretrained-bundled/` — DEC-13).
//! - No signing (owner decision: `signature` stays empty, DEC-7), no release
//!   publishing to `tinnlab/txresbench-models` (owner-gated runbook), no
//!   update-feed logic (that is `installers-release`; DEC-12).
//! - No events/SSE/WebSocket/queue (PROV-PC-11 — all 8 routes are
//!   request/response; download progress reaches the UI by polling
//!   PROV-PC-6).
//!
//! ## Boot posture
//!
//! The embedded snapshot + bundled manifest are first-party generated files:
//! a malformed or schema-drifted file FAILS BOOT (the extensions `_checked`
//! posture, DEC-16) — the server refuses to serve rather than run with a
//! silently empty or half-understood catalogue. An ABSENT snapshot cannot
//! reach boot (`include_bytes!` fails the build). An EMPTY `models[]` is a
//! VALID catalogue (the shipped snapshot carries zero entries until the
//! owner's publish pass — ITEM-2's honest empty; the D list renders the
//! no-models state). The spirit of "never silently-empty" is realized as:
//! absent → build failure, malformed → boot failure, empty → valid (DRIFT-1
//! ITEM-3).
//!
//! ## Network posture (the only uses allowed)
//!
//! The boot/on-demand refresh fetches [`catalogue::CATALOGUE_URL`] (the
//! host `tinnlab.github.io` — allowlisted by this node, DEC-15) and asset
//! downloads resolve `asset.url` (github.com / objects.githubusercontent.com
//! — INV-5). Both are plain GETs: no query strings, no cookies, no
//! identifiers (INV-4). The refresh is a detached task with short timeouts —
//! offline is a valid state and never blocks or fails boot (INV-8). The
//! `TXR_CATALOGUE_URL` env seam (documented in `catalogue.rs`) lets a
//! blocked-network boot or the integration harness point the fetch at a
//! closed loopback port instead.
//!
//! ## Registration (ITEM-3/ITEM-4/ITEM-5's scope)
//!
//! ITEM-3: `mod.rs` + `types.rs` + `catalogue.rs` + the `modules/mod.rs`
//! line + the reqwest `stream` feature; ITEM-4 adds the download manager
//! (`downloader.rs`), the ensure/install path (`install.rs`) and the
//! bundled-layout helpers (`bundled.rs`). ITEM-5 adds the eligibility
//! engine (`eligibility.rs` — PROV-PC-8's pure verdicts) and the eight
//! routes (`routes.rs` — PROV-PC-3..8, mounted by `register_routes` under
//! `/api/txr/pretrained*` with the reused `JobsUse` gate), so the OpenAPI
//! regen's diff at this item is exactly the 8 `Pretrained.*` operations +
//! their schema types (TEST-PC-25).

pub mod bundled;
pub mod catalogue;
pub mod downloader;
pub mod eligibility;
pub mod install;
pub mod routes;
pub mod types;

pub use catalogue::{ActiveCatalogue, CatalogueRuntime, PretrainedCatalogueSeams};
pub use downloader::DownloadManager;

use std::sync::{Arc, OnceLock};

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// The process runtime (live/disk/embedded source), installed by the module's
/// `init`. The in-process seams (`catalogue::catalogue`, `catalogue::model`,
/// `catalogue::bundled_assets`) read the EMBEDDED first-party files; this
/// runtime is the refreshable layer the routes serve (ITEM-5).
static RUNTIME: OnceLock<Arc<CatalogueRuntime>> = OnceLock::new();

/// The installed catalogue runtime (the boot path; panics only if called
/// before `init` in a build whose boot has not run — the mutable-before-boot
/// window `init` closes).
pub fn runtime() -> &'static Arc<CatalogueRuntime> {
    RUNTIME.get().expect(
        "pretrained_catalogue: the catalogue runtime is installed by module init — \
         a module used before boot is an initialization-order bug",
    )
}

/// The process-live download manager (PROV-PC-6): built from the SAME seams
/// as the runtime (first use lazily installs it — the routes and the
/// install seam share one instance; the state is file-backed).
static DOWNLOADS: OnceLock<Arc<DownloadManager>> = OnceLock::new();

/// The installed download manager (the install seam's manager; panics only
/// when called before `init`, same as [`runtime`]).
pub fn downloads() -> &'static Arc<DownloadManager> {
    DOWNLOADS.get_or_init(|| Arc::new(DownloadManager::new(runtime().seams().clone())))
}

/// The module instance. It holds the (test-overridable) seams + the
/// once-per-instance boot-refresh flag; the shared runtime is the static
/// above (first init installs it — the framework boots exactly one instance
/// per process).
pub struct PretrainedCatalogueModule {
    seams: PretrainedCatalogueSeams,
    boot_refresh_spawned: bool,
}

impl PretrainedCatalogueModule {
    pub fn new() -> Self {
        Self::with_seams(PretrainedCatalogueSeams::default())
    }

    /// The test seam (EnvImageSeams pattern — constructor args, never
    /// process-global `set_var`).
    pub fn with_seams(seams: PretrainedCatalogueSeams) -> Self {
        Self {
            seams,
            boot_refresh_spawned: false,
        }
    }
}

impl Default for PretrainedCatalogueModule {
    fn default() -> Self {
        Self::new()
    }
}

impl AppModule for PretrainedCatalogueModule {
    fn name(&self) -> &'static str {
        "pretrained_catalogue"
    }

    fn description(&self) -> &'static str {
        "TxResBench frozen published models: the pretrained catalogue (cards + release assets), the live→disk→embedded refresh, download/sha256/cache of model assets, install into the model store, per-model eligibility."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // The boot checks (DEC-16): parse + validate the embedded snapshot and
        // the bundled manifest ONCE here, then the parity between the two
        // generated files. An error is the boxed named refusal — module init
        // errors abort the boot, so a malformed first-party file is never
        // silently degraded into an empty catalogue.
        catalogue::ensure_loaded().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!(
                "pretrained catalogue embedded snapshot load failed: {e}"
            ))
        })?;
        catalogue::ensure_bundled_loaded().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!(
                "pretrained catalogue bundled manifest load failed: {e}"
            ))
        })?;
        catalogue::validate_bundled_parity().map_err(|e| {
            Box::<dyn std::error::Error>::from(format!(
                "pretrained catalogue bundled parity check failed: {e}"
            ))
        })?;

        // The refreshable runtime starts on the embedded layer; the boot
        // refresh task below elevates it (live → disk) without ever failing
        // boot (INV-8 — offline is a valid state).
        let runtime = Arc::new(CatalogueRuntime::new(self.seams.clone()));
        let _ = RUNTIME.set(runtime.clone());

        // INV-8's "read at start": ONE detached refresh per module instance
        // (the framework initializes exactly one module per boot; the flag
        // keeps a re-init — e.g. a test — from stacking refreshes). The
        // result is only logged: a failed refresh is silent by contract.
        if !self.boot_refresh_spawned {
            self.boot_refresh_spawned = true;
            let rt = runtime.clone();
            tokio::spawn(async move {
                let r = rt.refresh().await;
                tracing::info!(
                    origin = r.origin.as_str(),
                    models = r.models,
                    "pretrained catalogue boot refresh finished"
                );
            });
        }

        tracing::info!(
            models = catalogue::catalogue().models.len(),
            "pretrained catalogue loaded from the embedded snapshot"
        );
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // The eight `Pretrained.*` operations (PROV-PC-3..8; ITEM-5's
        // routes.rs) mount under `/api/txr/pretrained*` with the reused
        // `JobsUse` permission (DEC-11 — no new permission, A10 not
        // triggered; the single local owner passes automatically). The doc
        // ids are `types::ROUTE_DOC_IDS`; the routes' own suite pins the
        // registered set to that vocabulary (the history_store precedent).
        router.merge(routes::pretrained_routes())
    }
}

/// Module registration. Distinct order (52) — see
/// `modules/mod.rs::module_order_is_unique`; 47 is `method_catalogue`, 48
/// `file_validator`, 49 `execution_engine`, 50 `model_store`, 51
/// `history_store` (the in-process providers, earlier in the topological
/// order — the embedded snapshot's CONS-PC-2 cross-check needs
/// `method_catalogue` loaded first), 60 is `rootfs`, 61 `sandbox`.
#[distributed_slice(MODULE_ENTRIES)]
static PRETRAINED_CATALOGUE: ModuleEntry = ModuleEntry {
    name: "pretrained_catalogue",
    order: 52,
    description: "TxResBench frozen published models: catalogue, refresh, download/verify/install, eligibility.",
    constructor: || Box::new(PretrainedCatalogueModule::new()),
};

// The TEST-PC-01 suite: the module registers exactly once at order 52 (the
// framework's GLOBAL `module_order_is_unique` /
// `sorted_module_order_is_link_order_independent` stay red on the
// PRE-EXISTING order-4 tie (`health` + `localsession` — documented by every
// prior txr node; an epic-level finding, NOT caused by this node), and the
// boot path installs the embedded catalogue + the runtime and spawns the boot
// refresh exactly once. The malformed/absent-snapshot boot-refusal rules are
// asserted at their own seam (`catalogue::parse_catalogue` — the real loader;
// absent cannot reach runtime: the file is committed + `include_bytes!`).
#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    use super::*;

    /// TEST-PC-01 (node half): `pretrained_catalogue` is registered under
    /// `MODULE_ENTRIES` exactly once, with the declared order 52, and no
    /// OTHER module occupies 52.
    #[test]
    fn registers_once_at_unique_order_52() {
        let me: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.name == "pretrained_catalogue")
            .collect();
        assert_eq!(
            me.len(),
            1,
            "exactly one pretrained_catalogue registration: {me:?}"
        );
        assert_eq!(me[0].order, 52, "the declared integration order");

        let order52: Vec<_> = MODULE_ENTRIES
            .iter()
            .filter(|e| e.order == 52)
            .map(|e| e.name)
            .collect();
        assert_eq!(
            order52,
            vec!["pretrained_catalogue"],
            "no other module at order 52"
        );

        let built = (me[0].constructor)();
        assert_eq!(built.name(), "pretrained_catalogue");
        assert!(built
            .description()
            .starts_with("TxResBench frozen published models"));
    }

    /// TEST-PC-01 (module half): `init` installs the embedded catalogue (the
    /// boot check), installs the runtime on the embedded layer, and spawns
    /// the boot refresh EXACTLY once (a second init call does not stack a
    /// second refresh).
    #[tokio::test]
    async fn init_installs_runtime_and_spawns_one_boot_refresh() {
        // A closed loopback port: the boot refresh fails instantly, so the
        // test never dials a real network and the detached task settles fast.
        let root =
            std::env::temp_dir().join(format!("pretrained-module-init-{}", uuid::Uuid::new_v4()));
        let seams = PretrainedCatalogueSeams {
            catalogue_url: Some("http://127.0.0.1:9/catalogue.json".to_string()),
            http: None,
            bundled_dir: Some(root.join("pretrained-bundled")),
            data_root: Some(root.clone()),
        };

        let pool: SqlitePool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_lazy("sqlite::memory:")
            .expect("lazy pool parses");
        let cfg: txresbench_core::ServerConfig = serde_norway::from_str(
            "database:\n  path: \"\"\nserver:\n  host: \"127.0.0.1\"\n  port: 3100\n  api_prefix: \"/api\"\njwt:\n  secret: \"test-secret-for-the-pretrained-catalogue-module-32\"\n  issuer: \"txresbench\"\n  audience: \"txresbench-api\"\n  access_token_expiry_hours: 24\n  refresh_token_expiry_days: 30\n",
        )
        .expect("test config parses");
        let ctx = ModuleContext::new(
            Arc::new(pool),
            Arc::new(cfg),
            Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
        );

        let mut module = PretrainedCatalogueModule::with_seams(seams);
        module
            .init(&ctx)
            .expect("init succeeds against the committed snapshot");
        assert!(
            module.boot_refresh_spawned,
            "the boot refresh is spawned once"
        );

        // The boot checks made the snapshot + manifest visible in-process.
        assert_eq!(
            catalogue::catalogue().schema_version,
            types::PRETRAINED_SCHEMA_VERSION
        );
        assert!(
            !catalogue::bundled_assets().is_empty() || catalogue::catalogue().models.is_empty()
        );

        // The runtime is installed and starts on the embedded layer.
        let rt = runtime();
        assert_eq!(
            rt.origin(),
            crate::modules::pretrained_catalogue::types::PretrainedOrigin::Embedded
        );

        // A second init (the openapi-gen re-boot shape) does not stack a
        // second refresh.
        module.init(&ctx).expect("init is idempotent");
        assert!(module.boot_refresh_spawned);

        // Let the detached refresh task settle (a closed port fails fast).
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let _ = std::fs::remove_dir_all(&root);
    }
}
