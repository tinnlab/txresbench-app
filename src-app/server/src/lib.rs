//! TxResBench server library — the reusable boot spine.
//!
//! Exposes the module set + a `boot_in_background` that both the CLI binary
//! (`main.rs`) and the desktop harness consume. Uses the SDK batteries: the
//! framework's `serve` (connect-info + graceful shutdown; was SDK_GAPS G7) and
//! `ServerConfig::load*` (via `config`; was G2). The identity resolver is now
//! the SDK's turnkey `AuthModule` (txresbench-auth module support, gap N-3) — it
//! self-registers via `MODULE_ENTRIES` and mounts `/api/auth/*` + the whole-app
//! auth extensions, so the app carries no hand-written auth module.

pub mod config;
pub mod database;
pub mod harness_sentinel;
pub mod modules;
pub mod openapi;


use std::net::SocketAddr;
use std::sync::Arc;

use sqlx::SqlitePool;
use txresbench_core::ServerConfig;
use txresbench_framework::app_builder::{
    apply_rate_limit_layer, build_api_router, create_cors_layer, create_modules, initialize_modules,
};
use txresbench_framework::ModuleContext;

// Re-export the JWT service so the desktop crate names it through the app.
pub use txresbench_auth::auth::JwtService;

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

/// What a booted embedded server hands back: bound address + the app's SQLite
/// pool + JWT service. `pool` is the `Arc<SqlitePool>` the store shim booted
/// (PROV-sqlite-store-2: the desktop harness's `DbPool` seam materializes it
/// as this app's sqlite store on ITEM-24's manifest flip).
pub struct BootParts {
    pub addr: SocketAddr,
    pub pool: Arc<SqlitePool>,
    pub jwt: Arc<JwtService>,
}

/// Assemble the full app router (SQLite store + migrations + modules + auth
/// extensions + CORS + rate-limit) without serving. Shared by both entrypoints.
async fn build_app(
    config: &ServerConfig,
) -> Result<(axum::Router, Arc<SqlitePool>, Arc<JwtService>), BoxErr> {
    let pool = database::initialize_database(config).await?;
    let jwt = Arc::new(JwtService::try_new(config.jwt.clone())?);

    // (At-rest secret storage key (#60) is initialized at the ENTRYPOINTS — `main`
    // for the CLI serve/worker binary, `boot_in_background` for desktop — NOT here in
    // the shared assembler, so a single first-wins init runs per process with no
    // spurious "called twice" warning.)

    // Initialize the txresbench-file blob store under the app-data dir (honors
    // TXR_APP_DATA_DIR, so each integration test isolates its own file store).
    // Global, called once at boot — the store-generic file handlers + the
    // dataset upload path read it via `get_file_storage()`.
    let files_root = modules::rootfs::data_root().join("files");
    txresbench_file::init_file_storage(&files_root);

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

    // Warm the mcp settings cache from the DB (issue #54) so the pool-less
    // agent-channel read-at-use sites (`snapshot()`) reflect an admin-configured
    // row immediately, not only after the first pairing/list request loads it. A
    // DB error here is non-fatal — the cache stays at the compiled defaults and the
    // next read retries. Runs AFTER migrations so the singleton row exists.
    let _ = modules::mcp::settings_cache::get(&pool).await;
    // The per-request handle the mountable `file_routes` handlers pull from
    // `Extension<FileContext>` (severs them from app globals). Installed as a
    // global layer below (mirrors the framework's `Extension<DbPool>` — the
    // `SqlitePool` on this build). No-op
    // events seam (no `SyncEntity::File` today); the download-token signer
    // shares the access-token JWT issuer/secret so a generated token verifies.
    let file_ctx = txresbench_file::http::FileContext {
        files: Arc::new(txresbench_file::FileRepository::new((*pool).clone())),
        events: Arc::new(modules::file::NoopFileEvents),
        download_token: txresbench_file::http::DownloadTokenSigner {
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
    txresbench_notification::set_sync_emitter(Arc::new(|user_id, action, id, origin| {
        use modules::sync::{publish, Audience, SyncAction, SyncEntity};
        let action = match action {
            txresbench_notification::NotifSyncAction::Create => SyncAction::Create,
            txresbench_notification::NotifSyncAction::Update => SyncAction::Update,
            txresbench_notification::NotifSyncAction::Delete => SyncAction::Delete,
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
    // `txresbench-auth` fires this INSIDE the user-creation transaction on EVERY creation
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
    txresbench_auth::install_user_created_hook(Arc::new(modules::account::hook::PersonalAccountHook));

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
    // extensions are installed by the SDK's turnkey `AuthModule` (txresbench-auth
    // module support, gap N-3) — a MODULE_ENTRIES module that registers LAST
    // and layers those extensions over every module's routes. No app-side
    // `install_auth_layers` needed. `jwt` here is still built for `BootParts`
    // (the desktop harness mints tokens with it; same secret ⇒ interoperable).
    let app: axum::Router = api_router.finish_api(&mut api_doc);
    // Boot the two AI-controllable-actions capability catalogs (`modules/mcp`,
    // ai-mcp slice 1) from the now-finished OpenAPI doc: the SDK-derived
    // REST/OpenAPI catalog, then the compile-time frontend-action manifest.
    // Must run AFTER `finish_api` (the doc isn't fully populated before it).
    txresbench_control_mcp::catalog::init_from_openapi(&api_doc);
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
    // not parse a CLI `--config-file`, so it resolves from `TXR_SECRET_STORAGE_KEY` or
    // the discovered config's `secrets.storage_key`). First-wins OnceCell. `None` ⇒
    // compat mode. (The CLI serve/worker binary inits in `main` with the explicit path.)
    txresbench_framework::secrets::init_storage_key(config::resolve_storage_key(None));
    let (app, pool, jwt) = build_app(&config).await?;
    let listener = tokio::net::TcpListener::bind(config.server_address()).await?;
    let addr = listener.local_addr()?;
    tracing::info!(
        "TxResBench listening on http://{addr}{}",
        config.server.api_prefix
    );

    tokio::spawn(async move {
        // SDK `serve`: connect-info (rate-limiter PeerIp) + graceful shutdown.
        if let Err(e) = txresbench_framework::serve(listener, app).await {
            tracing::error!("server task exited: {e}");
        }
        // Tear down any squashfuse rootfs mount on graceful shutdown (LOW-4).
        // PDEATHSIG is the SIGKILL/OOM backstop; this is the clean-exit path.
        modules::rootfs::shutdown();
    });

    Ok(BootParts { addr, pool, jwt })
}

/// Blocking entrypoint for the CLI binary: boot, serve (graceful shutdown on
/// Ctrl-C/SIGTERM), then tear the embedded database down.
pub async fn serve_blocking(config: ServerConfig) -> Result<(), BoxErr> {
    let (app, _pool, _jwt) = build_app(&config).await?;
    let listener = tokio::net::TcpListener::bind(config.server_address()).await?;
    let addr = listener.local_addr()?;
    println!("TxResBench listening on http://{}/api", addr);

    txresbench_framework::serve(listener, app).await?;
    // Clean-exit teardown of the squashfuse rootfs mount (LOW-4); PDEATHSIG is
    // the SIGKILL/OOM backstop.
    modules::rootfs::shutdown();
    database::cleanup_database().await;
    Ok(())
}

/// Close the SQLite pool (WAL checkpoint TRUNCATE first). Idempotent. Used by
/// the desktop harness `ServerBoot::shutdown`.
pub async fn cleanup() {
    database::cleanup_database().await
}

/// Install a default `info`-level tracing subscriber (idempotent).
pub fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).try_init();
}
