//! CytoAnalyst server library — the reusable boot spine.
//!
//! Exposes the module set + a `boot_in_background` that both the CLI binary
//! (`main.rs`) and the desktop harness consume. Uses the SDK batteries: the
//! framework's `serve` (connect-info + graceful shutdown; was SDK_GAPS G7) and
//! `ServerConfig::load*` (via `config`; was G2). The identity resolver is now
//! the SDK's turnkey `AuthModule` (ziee-auth `module` feature, gap N-3) — it
//! self-registers via `MODULE_ENTRIES` and mounts `/api/auth/*` + the whole-app
//! auth extensions, so the app carries no hand-written auth module.

pub mod config;
pub mod database;
pub mod harness_sentinel;
pub mod modules;
pub mod openapi;

// The separability-manifest validator lives in `build_helper/processor_manifest.rs`
// as the SINGLE SOURCE for BOTH boundaries (INV-8): `build.rs` `#[path]`-includes
// it (whole-tree fail-fast panic on a malformed `packages/*/manifest.yaml`) and
// the lib `#[path]`-includes the SAME file here as a REAL `pub` module — so the
// runtime (S4 loader replacement) validates a runtime-dropped package with the
// EXACT `lint_*` logic the build uses (mirrors the `rootfs::version` single-source
// pattern `build.rs` uses at its `#[path = "src/modules/rootfs/version.rs"]`). It
// is SELF-CONTAINED (std + serde/serde_norway/serde_json only, no crate imports),
// so it compiles into the lib unchanged. Its `#[cfg(test)]` backstop (TEST-12 +
// the per-package + single-source anchors) runs under `cargo test -p cytoanalyst`.
#[path = "../build_helper/processor_manifest.rs"]
pub mod processor_manifest_lint;

use std::net::SocketAddr;
use std::sync::Arc;

use sqlx::PgPool;
use ziee_core::ServerConfig;
use ziee_framework::app_builder::{
    apply_rate_limit_layer, build_api_router, create_cors_layer, create_modules, initialize_modules,
};
use ziee_framework::ModuleContext;

// Re-export the JWT service so the desktop crate names it through the app.
pub use ziee_auth::auth::JwtService;

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

/// What a booted embedded server hands back: bound address + pool + JWT service.
pub struct BootParts {
    pub addr: SocketAddr,
    pub pool: Arc<PgPool>,
    pub jwt: Arc<JwtService>,
}

/// Assemble the full app router (embedded PG + migrations + modules + auth
/// extensions + CORS + rate-limit) without serving. Shared by both entrypoints.
async fn build_app(
    config: &ServerConfig,
) -> Result<(axum::Router, Arc<PgPool>, Arc<JwtService>), BoxErr> {
    let pool = database::initialize_database(config).await?;
    let jwt = Arc::new(JwtService::try_new(config.jwt.clone())?);

    // (At-rest secret storage key (#60) is initialized at the ENTRYPOINTS — `main`
    // for the CLI serve/worker binary, `boot_in_background` for desktop — NOT here in
    // the shared assembler, so a single first-wins init runs per process with no
    // spurious "called twice" warning.)

    // Initialize the ziee-file blob store under the app-data dir (honors
    // CYTO_APP_DATA_DIR, so each integration test isolates its own file store).
    // Global, called once at boot — the store-generic file handlers + the
    // dataset upload path read it via `get_file_storage()`.
    let files_root = modules::rootfs::data_root().join("files");
    ziee_file::init_file_storage(&files_root);

    // #182 (ITEM-6): reclaim upload temp parts abandoned by a process that was
    // KILLED mid-upload. `StagedPart`'s Drop guard covers every in-process exit
    // path (including a cancelled request future); nothing covers a SIGKILL, and an
    // abandoned multi-GB part would otherwise sit on the data volume forever.
    // Runs here, before the listener accepts, and only removes parts older than a
    // day — either condition alone makes racing a live upload impossible (DEC-5).
    // Best-effort and non-fatal, like the boot reapers below.
    modules::file::stream::sweep_stale_tmp_uploads().await;
    // ...and keep sweeping. A boot-only sweep misses the dominant case: a SIGKILL is
    // normally followed by an IMMEDIATE restart, so the abandoned parts are seconds
    // old and the age gate correctly skips them — after which a server that stays up
    // for months never reclaims them.
    modules::file::stream::spawn_tmp_upload_sweeper();

    // Initialize the workstore content-addressed object store under the app-data
    // dir (mirrors `init_file_storage`; honors CYTO_APP_DATA_DIR per-worktree),
    // PARTITIONED by the identity of the catalog `config` binds us to — see
    // `workstore::partition`. `config` is passed for exactly that: the sweep
    // spawned two lines below unlinks the complement of THIS pool's keep-set, so
    // it may only ever run against a store this catalog owns.
    // Then spawn the standing blob-GC union sweep (ITEM-14); the loop self-gates on
    // the live `gc_enabled` setting (issue #54).
    // Effective object-store config (#63): under `saas`, the admin DB row
    // (`infra_object_store`) is layered over the env resolution so an admin PUT takes
    // effect at THIS construction seam; an unconfigured row is byte-identical to
    // env-only (INV-5). Desktop/default keeps the pure env resolution unchanged.
    // FAIL-CLOSED (#69): an unrecognized CYTO_WORKSTORE_BACKEND makes resolution return Err, so
    // the server REFUSES TO BOOT here rather than silently running on the local-fs backend.
    #[cfg(feature = "saas")]
    let workstore_cfg =
        modules::workstore::infra_object_store::resolve_effective_object_store(&pool, config)
            .await?;
    #[cfg(not(feature = "saas"))]
    let workstore_cfg = modules::workstore::config::WorkstoreConfig::resolve_for(config)?;
    let workstore_store = modules::workstore::init_working_store(&workstore_cfg)?;
    // #61 fail-safe boot reaper: an object-store migration left `copying`/`verifying` by a
    // process that died mid-copy is marked `failed` (never silently `verified`), clearing the
    // single-active-migration index so a new migration can start after a restart. Runs after the
    // DB migrations (initialize_database above) so the table exists.
    match modules::workstore::migration_repo::reap_interrupted(&pool).await {
        Ok(n) if n > 0 => tracing::warn!(reaped = n, "workstore: reaped interrupted object-store migration(s) at boot"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "workstore: could not reap interrupted migrations at boot"),
    }
    // #64 boot-resume (ITEM-7 / DEC-5): if a migration to the current store is still un-retired,
    // the OLD store holds blobs the NEW copy may not (pre-switch data + write-during-migration
    // blobs) — so re-establish the live cutover state `DualRead(new, old)` for THIS restart, for
    // ANY store pair: reads try NEW then fall back to OLD (nothing stranded), writes go to NEW. OLD
    // is rebuilt from its ENCRYPTED preserved config (cloud creds decrypted here) or the local root
    // (local source). Only a manual retire (which proves every blob is in NEW) drops the fallback.
    // FAIL-CLOSED: if OLD cannot be rebuilt (undecryptable/missing config), we stay on NEW only and
    // log LOUDLY rather than silently serving a store that may 404 a straggler.
    #[cfg(feature = "saas")]
    match modules::workstore::migration_repo::latest_unretired(&pool).await {
        Ok(Some(row)) => {
            match modules::workstore::migration_repo::decrypt_preserved_old_config(&pool, &row).await {
                Some(old_cfg) => {
                    match modules::workstore::cutover::build_store_from_preserved(&old_cfg, workstore_cfg.root()) {
                        Ok(old) => {
                            let new = modules::workstore::get_object_store();
                            let dual = modules::workstore::cutover::build_dual_read(new, old);
                            modules::workstore::swap_object_store(dual);
                            tracing::warn!(migration = %row.id, src = %row.src_backend, "workstore: boot re-established DualRead(new→old) for an un-retired object-store migration (#64); reads fall back to the retained OLD store until an explicit retire");
                        }
                        Err(e) => tracing::error!(error = %e, migration = %row.id, "workstore: could NOT rebuild the OLD store fallback at boot (#64) — staying on the NEW store only; a write-window straggler could read as absent until the migration is re-run. Investigate."),
                    }
                }
                None => tracing::error!(migration = %row.id, src = %row.src_backend, "workstore: un-retired migration has no reconstructable OLD config at boot (#64) — staying on the NEW store only; investigate (missing/undecryptable preserved config)."),
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(error = %e, "workstore: could not check for an un-retired object-store migration at boot (#64)"),
    }
    // Byte-preservation for env-configured deployments (INV-1 / DEC-8): the legacy
    // GC env overrides (`CYTO_WORKSTORE_GC_ENABLED` / `_INTERVAL_HOURS`) seed the
    // settings row while it has never been admin-modified, so a deployment that tuned
    // GC via env and never PUTs behaves exactly as before this feature. A later admin
    // PUT (which stamps `updated_by`) supersedes env for good. Runs AFTER migrations
    // (initialize_database above) so the singleton row exists.
    let env_ov = modules::workstore::settings::gc_env_overrides();
    if !env_ov.is_empty() {
        let repo = modules::workstore::settings::WorkstoreSettingsRepository::new((*pool).clone());
        if let Err(e) = repo.seed_from_env_if_unmodified(&env_ov).await {
            tracing::warn!("workstore: GC env-seed failed ({e}); using stored settings");
        }
    }

    // Warm the mcp settings cache from the DB (issue #54) so the pool-less
    // agent-channel read-at-use sites (`snapshot()`) reflect an admin-configured
    // row immediately, not only after the first pairing/list request loads it. A
    // DB error here is non-fatal — the cache stays at the compiled defaults and the
    // next read retries. Runs AFTER migrations so the singleton row exists.
    let _ = modules::mcp::settings_cache::get(&pool).await;
    // Same pattern for provenance's rootfs-cache GC cap: the legacy
    // `CYTO_ROOTFS_CACHE_MAX_DIGESTS` env override seeds the `provenance_settings` row while
    // it has never been admin-modified, so an env-tuned deployment that never PUTs behaves
    // exactly as before #54 (INV-2). The DB setting is authoritative at read-at-use, so a
    // later admin change to the cap is never silently overridden by the env var (DEC-2
    // correction). Runs AFTER migrations so the singleton row exists.
    let prov_env_seed = modules::provenance::settings::rootfs_cache_max_digests_env_seed();
    if prov_env_seed.is_some() {
        let repo =
            modules::provenance::settings::ProvenanceSettingsRepository::new((*pool).clone());
        if let Err(e) = repo.seed_rootfs_cap_from_env_if_unmodified(prov_env_seed).await {
            tracing::warn!("provenance: rootfs-cache-cap env-seed failed ({e}); using stored settings");
        }
    }

    // Spawn the standing blob-GC loop UNCONDITIONALLY (DEC-5, issue #54): the loop
    // reads `gc_enabled` + `gc_interval_hours` from the workstore settings cache each
    // cycle (read-at-use, INV-4), so an admin can toggle GC or change the cadence
    // live without a restart. A disabled cycle just sleeps.
    let sweeper = std::sync::Arc::new(modules::workstore::gc::GcSweeper::new(
        (*pool).clone(),
        workstore_store,
        workstore_cfg.claim.clone(),
    ));
    sweeper.spawn_loop();

    // Spawn the standing billing usage-rollup fold+report loop (B1 / PROV-B1-1) if
    // enabled. `saas`-only (the billing MODULE compiles out of desktop, INV-5) AND
    // gated on the `billing.rollup_enabled` kill-switch (DEC-4), exactly like the GC
    // sweep above is gated on `gc_enabled`.
    // The billing loops spawn only when billing is CONFIGURED for this deployment
    // (§16 / B5 ITEM-5: the `Option<BillingConfig>` deploy kill-switch). No Stripe
    // secret ⇒ `from_env_opt()` is `None` ⇒ no fold job, no alert loop — the runtime
    // second side that matches the `register_routes` mount guard. (Desktop compiles
    // the whole block out; this is the belt for a saas binary left unconfigured.)
    #[cfg(feature = "saas")]
    if modules::billing::config::BillingConfig::from_env_opt().is_some() {
        let billing_limits = modules::billing::config::BillingLimits::from_env();
        if billing_limits.rollup_enabled {
            let sweeper = std::sync::Arc::new(modules::billing::rollup::RollupSweeper::new(
                (*pool).clone(),
            ));
            sweeper.spawn_loop(billing_limits.rollup_interval_hours);
        }
        // B4 (ITEM-4 / DEC-6): the standing usage-alert ladder loop, gated on
        // `billing.alert_enabled` exactly like the rollup loop above.
        if billing_limits.alert_enabled {
            let alerts =
                std::sync::Arc::new(modules::billing::alerts::AlertSweeper::new((*pool).clone()));
            alerts.spawn_loop(billing_limits.alert_interval_hours);
        }
    }

    // The per-request handle the mountable `file_routes` handlers pull from
    // `Extension<FileContext>` (severs them from app globals). Installed as a
    // global layer below (mirrors the framework's `Extension<PgPool>`). No-op
    // events seam (no `SyncEntity::File` today); the download-token signer
    // shares the access-token JWT issuer/secret so a generated token verifies.
    let file_ctx = ziee_file::http::FileContext {
        files: Arc::new(ziee_file::FileRepository::new((*pool).clone())),
        events: Arc::new(modules::file::NoopFileEvents),
        download_token: ziee_file::http::DownloadTokenSigner {
            issuer: config.jwt.issuer.clone(),
            secret: config.jwt.secret.clone(),
        },
        // Authorization for the mounted `file_routes`. The store scopes to
        // `files.user_id` — the UPLOADING actor — which is provenance, not
        // entitlement: it keeps naming a member after they are removed from the
        // account whose dataset the file belongs to. This policy resolves the
        // real standing (dataset → account membership ∪ shares) through the same
        // predicate the sandbox byte-staging gate uses.
        access: Arc::new(modules::file::access::DatasetFileAccessPolicy::new(
            (*pool).clone(),
        )),
    };

    // Wire the SDK notification module's pluggable sync seam to this app's
    // concrete `SyncEntity::Notification` (the crate never names it). Idempotent.
    ziee_notification::set_sync_emitter(Arc::new(|user_id, action, id, origin| {
        use modules::sync::{publish, Audience, SyncAction, SyncEntity};
        let action = match action {
            ziee_notification::NotifSyncAction::Create => SyncAction::Create,
            ziee_notification::NotifSyncAction::Update => SyncAction::Update,
            ziee_notification::NotifSyncAction::Delete => SyncAction::Delete,
        };
        publish(
            SyncEntity::Notification,
            action,
            id,
            Audience::owner(user_id),
            origin,
        );
    }));

    // Declare how the SDK auth module's cross-device sync is wired, BEFORE
    // `initialize_modules` runs `AuthModule::init`. This is not optional: the
    // module refuses to boot without a declaration, because the alternative it
    // used to have — a hard-coded `NoopAuthSyncSink` — dropped all seven of its
    // publishes silently and cost a debugging session to find. See
    // `modules::sync::auth_sink`.
    modules::sync::install_auth_sync_sink();

    // A5 / G-AUTHEVT: install the clean in-transaction personal-account hook BEFORE
    // `initialize_modules` (so it is live before any user can be created). The SDK's
    // `ziee-auth` fires this INSIDE the user-creation transaction on EVERY creation
    // path (local register, LDAP/OAuth first-login, admin-create, first-run setup),
    // so a fresh user's personal account is provisioned atomically with the user row
    // — no window in which a committed user lacks one, and no authenticated request
    // needed to heal it. `OnceLock` first-install-wins; call once at boot.
    //
    // The lazy-ensure backstop (`account::backstop`, layered below) is KEPT: it
    // self-heals users created BEFORE this hook landed (and any future bypass path)
    // on their next authenticated request. Both bind the same idempotent upsert, so
    // a user covered by both converges on exactly one account. See
    // `modules::account::hook`.
    ziee_auth::install_user_created_hook(Arc::new(modules::account::hook::PersonalAccountHook));

    let ctx = ModuleContext::new(
        pool.clone(),
        Arc::new(config.clone()),
        Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
    );
    let mut modules = create_modules();
    initialize_modules(&mut modules, &ctx)?;

    let (api_router, mut api_doc) =
        build_api_router(&modules, &config.server.api_prefix, (*pool).clone());
    // Auth routes (`/api/auth/*`) + the whole-app resolver/JWT/AuthContext
    // extensions are installed by the SDK's turnkey `AuthModule` (ziee-auth
    // `module` feature, gap N-3) — a MODULE_ENTRIES module that registers LAST
    // and layers those extensions over every module's routes. No app-side
    // `install_auth_layers` needed. `jwt` here is still built for `BootParts`
    // (the desktop harness mints tokens with it; same secret ⇒ interoperable).
    let app: axum::Router = api_router.finish_api(&mut api_doc);
    // Boot the two AI-controllable-actions capability catalogs (`modules/mcp`,
    // ai-mcp slice 1) from the now-finished OpenAPI doc: the SDK-derived
    // REST/OpenAPI catalog, then the compile-time frontend-action manifest.
    // Must run AFTER `finish_api` (the doc isn't fully populated before it).
    ziee_control_mcp::catalog::init_from_openapi(&api_doc);
    modules::mcp::frontend_catalog::init_from_manifest();
    // The harness WORKTREE SENTINEL — `GET /__worktree`, debug builds only,
    // registered on the plain axum router (AFTER `finish_api`) so it never enters
    // the OpenAPI spec. It is what lets the full-backend Playwright tier PROVE the
    // backend on its port was compiled from this worktree before talking to it; the
    // backend-free tiers have had the vite twin of this since `ab51cabc`, and this
    // tier was left exposed precisely because a cargo server could not answer the
    // question. See `harness_sentinel` for the release posture.
    let app = harness_sentinel::install(app);
    // A5 ITEM-5: the lazy-ensure personal-account backstop (PROV-A5-1). A cross-
    // cutting global layer — NOT a per-module `register_routes` layer — because
    // `build_api_router` layers each module over only the routes accumulated so far,
    // so a layer added by the `account` module (order 23) would miss every later
    // module AND the turnkey `AuthModule`'s own routes (`order = i32::MAX`). Layered
    // here, with the other cross-cutting concerns (`FileContext`/CORS/rate-limit), it
    // wraps EVERY route — the same reason `AuthModule` layers at `order = i32::MAX`.
    // It validates the bearer token with its OWN `JwtService` (it runs outside the
    // auth extensions), is best-effort, and NEVER fails a request. See
    // `modules::account::backstop`.
    let backstop_state =
        modules::account::backstop::BackstopState::new((*pool).clone(), jwt.clone());
    let app = app.layer(axum::middleware::from_fn_with_state(
        backstop_state,
        modules::account::backstop::ensure_personal_account_backstop,
    ));
    // Install the file-store request handle globally (the mountable file_routes
    // handlers extract `Extension<FileContext>`).
    let app = app.layer(axum::Extension(file_ctx));
    let app = app.layer(create_cors_layer(config));
    // `None` absent-default: config omitting `rate_limit` (desktop) → no limiter.
    let app = apply_rate_limit_layer(app, config, None);

    Ok((app, pool, jwt))
}

/// Boot + spawn `serve` on the background runtime; return the handle.
/// **Non-blocking** — the caller keeps the process alive (desktop event loop).
pub async fn boot_in_background(config: ServerConfig) -> Result<BootParts, BoxErr> {
    // At-rest secret storage key (#60): the DESKTOP entrypoint's init (this path does
    // not parse a CLI `--config-file`, so it resolves from `CYTO_SECRET_STORAGE_KEY` or
    // the discovered config's `secrets.storage_key`). First-wins OnceCell. `None` ⇒
    // compat mode. (The CLI serve/worker binary inits in `main` with the explicit path.)
    ziee_framework::secrets::init_storage_key(config::resolve_storage_key(None));
    let (app, pool, jwt) = build_app(&config).await?;
    let listener = tokio::net::TcpListener::bind(config.server_address()).await?;
    let addr = listener.local_addr()?;
    tracing::info!(
        "CytoAnalyst listening on http://{addr}{}",
        config.server.api_prefix
    );

    tokio::spawn(async move {
        // SDK `serve`: connect-info (rate-limiter PeerIp) + graceful shutdown.
        if let Err(e) = ziee_framework::serve(listener, app).await {
            tracing::error!("server task exited: {e}");
        }
        // Tear down any squashfuse rootfs mount on graceful shutdown (LOW-4).
        // PDEATHSIG is the SIGKILL/OOM backstop; this is the clean-exit path.
        modules::rootfs::shutdown();
        // Stop the live processor-folder watcher (ITEM-13, §5): signal cancel + drop
        // the notify guard + abort the task, so no watcher thread/task leaks.
        modules::extensions::watch::shutdown();
    });

    Ok(BootParts { addr, pool, jwt })
}

/// Blocking entrypoint for the CLI binary: boot, serve (graceful shutdown on
/// Ctrl-C/SIGTERM), then tear the embedded database down.
pub async fn serve_blocking(config: ServerConfig) -> Result<(), BoxErr> {
    let (app, _pool, _jwt) = build_app(&config).await?;
    let listener = tokio::net::TcpListener::bind(config.server_address()).await?;
    let addr = listener.local_addr()?;
    println!("CytoAnalyst listening on http://{}/api", addr);

    ziee_framework::serve(listener, app).await?;
    // Clean-exit teardown of the squashfuse rootfs mount (LOW-4); PDEATHSIG is
    // the SIGKILL/OOM backstop.
    modules::rootfs::shutdown();
    // Stop the live processor-folder watcher (ITEM-13, §5) on clean exit.
    modules::extensions::watch::shutdown();
    database::cleanup_database().await;
    Ok(())
}

/// Worker entrypoint (T3 / ITEM-2 / §4.3): boot the SAME library assembly the CLI `serve`
/// path boots — same `PgPool`, same module set (which builds the `BackendRegistry` + object
/// store), same scheduler loop — **minus the public router**. `cytoanalyst worker` is a MODE
/// of the binary, not a second service (INV-1): it reuses `build_app` (so `JobsModule::init`
/// runs verbatim) and never binds a listener. `set_worker_mode()` is set FIRST so the jobs
/// module's G2 gate always spawns the scheduler loop here (a worker ALWAYS claims, regardless
/// of `CYTO_SCHEDULER_ENABLED`). The process then blocks on a shutdown signal so the
/// background scheduler keeps claiming + running jobs.
pub async fn run_worker(config: ServerConfig) -> Result<(), BoxErr> {
    crate::modules::jobs::scheduler::set_worker_mode();
    // Build the full assembly (initializes every module, incl. the scheduler loop) but do
    // NOT serve — the worker has no public HTTP surface. `_app` is intentionally dropped.
    let (_app, _pool, _jwt) = build_app(&config).await?;
    tracing::info!("cytoanalyst worker started — claiming + running jobs (no public router)");
    println!("cytoanalyst worker started (no public router; claiming jobs)");
    worker_shutdown_signal().await;
    tracing::info!("cytoanalyst worker shutting down");
    modules::rootfs::shutdown();
    modules::extensions::watch::shutdown();
    database::cleanup_database().await;
    Ok(())
}

/// In-pod ONE-SHOT job executor (ITEM-5 / #66) — the body of `cytoanalyst run-job --job-id X`.
///
/// This is the entrypoint the job-per-run `KubernetesBackend` pod runs (its container command).
/// It boots the SAME `build_app` assembly `serve`/`worker` boot — same `PgPool`, same module set
/// (which builds the object store + the ingest/provenance/meter seams + the sandbox config) —
/// but runs NO public router and, crucially, NO scheduler loop / boot reconcile: it sets
/// `CYTO_SCHEDULER_ENABLED=off` and never enters worker mode, so `scheduler_should_spawn()` is
/// `false` (jobs module G2 gate) and this pod NEVER claims or reconciles OTHER jobs — it executes
/// exactly the one job it was launched for and exits.
///
/// It loads the already-claimed job row, runs the full in-pod data plane
/// ([`crate::modules::jobs::runner::execute_job_in_pod`]: materialize inputs from the object
/// store → bwrap → finalize/ingest back to the object store + catalog), and exits with that
/// pipeline's code — `0` iff the outputs were durably cataloged, non-zero otherwise. The
/// control-plane executor (watching this pod via the shepherd) reflects the exit code into the
/// job's terminal status.
pub async fn run_job_once(config: ServerConfig, job_id: uuid::Uuid) -> Result<(), BoxErr> {
    // Disable the scheduler loop + boot reconcile on THIS process (G2, jobs/mod.rs) — a run-job
    // pod must not claim or reconcile jobs other processes own. Set BEFORE build_app so
    // `JobsModule::init` sees it. NOT worker mode (which would force the loop on).
    std::env::set_var("CYTO_SCHEDULER_ENABLED", "off");

    let (_app, pool, _jwt) = build_app(&config).await?;
    // `build_app` hands back an `Arc<PgPool>`; the jobs/sandbox APIs take a bare `PgPool` (itself
    // an `Arc` internally — cloning is cheap).
    let pool: PgPool = (*pool).clone();

    let repo = crate::modules::jobs::repository::JobRepository::new(pool.clone());
    let job = repo
        .get_any(job_id)
        .await?
        .ok_or_else(|| format!("run-job: job {job_id} not found in the database"))?;

    let registry = std::sync::Arc::new(
        crate::modules::sandbox::backend::local_bwrap::BackendRegistry::new(pool.clone()),
    );

    tracing::info!(%job_id, "cytoanalyst run-job: executing one analysis in-pod (no scheduler)");
    let code = crate::modules::jobs::runner::execute_job_in_pod(&job, pool.clone(), registry)
        .await
        .map_err(|e| -> BoxErr { e.into() })?;

    modules::rootfs::shutdown();
    modules::extensions::watch::shutdown();
    database::cleanup_database().await;

    if code != 0 {
        // Non-zero → the control-plane executor fails the job. Exit directly so the pod's
        // terminal status is the analysis/finalize outcome, not a masked 0.
        std::process::exit(code);
    }
    Ok(())
}

/// Block until Ctrl-C or SIGTERM (mirrors the framework's private `shutdown_signal`), so the
/// worker's background scheduler loop keeps running until the pod is stopped.
async fn worker_shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

/// Stop the embedded Postgres + close the pool. Idempotent. Used by the desktop
/// harness `ServerBoot::shutdown`.
pub async fn cleanup() {
    database::cleanup_database().await
}

/// Install a default `info`-level tracing subscriber (idempotent).
pub fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).try_init();
}
