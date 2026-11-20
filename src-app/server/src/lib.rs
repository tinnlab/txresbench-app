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
    apply_rate_limit_layer, build_api_router, create_cors_layer_with, create_modules,
    initialize_modules, FRAMEWORK_REQUIRED_REQUEST_HEADERS,
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
    demo: &config::DemoConfig,
    lock: Option<&modules::local_api_lock::LocalApiLock>,
) -> Result<(axum::Router, Arc<SqlitePool>, Arc<JwtService>), BoxErr> {
    // Demo mode is a runtime setting of THIS process: install the resolved
    // state once, BEFORE module init, so every module/layer that consults it
    // (`localsession`, `model_store`, `execution_engine`, the gate) reads the
    // same answer. Desktop mode sets an `enabled: false` state — the module
    // set and every route behave exactly as before (the layers below are
    // installed only when enabled).
    //
    // A demo boot also REQUIRES its recorded-results bundle (ITEM-2): the
    // loader validates the manifest (schema, the recorded example hashes
    // against the embedded example data) and an invalid or missing bundle is
    // a hard refusal — the demo never starts "without data", it names the
    // path and the recorder instead.
    let bundle = if demo.enabled {
        let path = modules::demo::bundle::resolve_path(demo, &modules::rootfs::data_root());
        Some(modules::demo::bundle::load(&path)?)
    } else {
        None
    };
    crate::modules::demo::set_state(crate::modules::demo::DemoState::from_config(
        demo,
        bundle,
    ));

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
    // qa-fixes4 ITEM-1: the ONE user-facing error-message sanitiser at the
    // txr modules' API boundary (engine, model store, history, catalogue,
    // pretrained). Deliberately a WHOLE-APP layer with an internal route
    // scope — a per-module `register_routes` layer would cover only the
    // routes registered before that module and could not be ONE shared
    // sanitiser; the middleware selects the txr surface by path and passes
    // framework routes through untouched. It runs AFTER `finish_api`, so
    // the OpenAPI spec (and the generated client) is unaware of it — the
    // `internal_detail` field is a runtime-only addition, never rendered.
    let app = app.layer(axum::middleware::from_fn(
        modules::err_sanitiser::txr_json_boundary,
    ));
    // Install the file-store request handle globally (the mountable file_routes
    // handlers extract `Extension<FileContext>`).
    let app = app.layer(axum::Extension(file_ctx));
    // The local API lock (`modules::local_api_lock`): the per-run key + Host +
    // Origin check in front of EVERY route. Layered here, after every route,
    // the harness sentinel and every other layer above exist, so no route can
    // sit outside it; and INSIDE the CORS layer below, so a preflight is
    // answered by CORS first and a refusal never carries an allow-origin for a
    // foreign page. The caller decides: the desktop always passes a lock (even if a stray
    // demo setting is present), the headless server passes none in demo mode.
    let app = match lock {
        Some(lock) => app.layer(axum::middleware::from_fn_with_state(
            lock.clone(),
            modules::local_api_lock::enforce,
        )),
        None => app,
    };
    // The framework's own required request header plus the local-API key header:
    // an explicit `allow_headers` list (the desktop's) gets both unioned in, so a
    // webview preflight for the key header can never be refused for omission.
    let mut cors_headers: Vec<&'static str> = FRAMEWORK_REQUIRED_REQUEST_HEADERS.to_vec();
    cors_headers.push(modules::local_api_lock::KEY_HEADER);
    let app = app.layer(create_cors_layer_with(config, &cors_headers));
    // `None` absent-default: config omitting `rate_limit` (desktop) → no limiter.
    // In demo mode the framework limiter is CONFIGURED always — the plan's
    // "use the framework's rate-limit module, configured, not disabled": an
    // operator's `server.rate_limit` block is honored; an absent block gets the
    // documented demo defaults rather than no limiter at all.
    let app = if demo.enabled {
        let (per_second, burst_size) = modules::demo::demo_rate_burst(config);
        apply_rate_limit_layer(app, config, Some((per_second, burst_size)))
    } else {
        apply_rate_limit_layer(app, config, None)
    };

    // ── the demo-only layers (installed ONLY in demo mode — desktop mode gets
    //    none of them, so its behavior is byte-for-byte unchanged) ────────────
    // Order (axum: last layered = outermost): the GATE outermost, so a blocked
    // route answers 403 DEMO_MODE before any auth/permission layer can answer
    // 401; then the per-session governor; then the body-size cap.
    let app = if demo.enabled {
        // The request-body size cap (demo.max_bytes): visitors may only post
        // the small example tables, so a generous cap still bounds a hostile
        // payload. Deliberately a WIRE-level middleware (tower-http
        // RequestBodyLimitLayer), not the extractor-level `DefaultBodyLimit`
        // layer: the adapted inspect/validate routes carry route-level
        // `DefaultBodyLimit::disable()` (they parse big body schemas), which
        // would override a global extractor default and leave the ONE
        // visitor-content surface uncapped in demo mode. The middleware wraps
        // the body stream itself, so `disable()` cannot repeal the demo cap.
        let app = app.layer(tower_http::limit::RequestBodyLimitLayer::new(
            demo.max_bytes as usize,
        ));
        // The per-session governor: the same tower-governor module the
        // framework's limiter uses, keyed on the demo session cookie (falling
        // back to the peer IP), so a browser is bounded per SESSION and an
        // un-cookied client per IP — the plan's paired limits.
        let (per_second, burst_size) = modules::demo::demo_rate_burst(config);
        let governor_conf = Arc::new(
            tower_governor::governor::GovernorConfigBuilder::default()
                .per_second(per_second)
                .burst_size(burst_size)
                .key_extractor(modules::demo::SessionOrPeerKeyExtractor)
                .finish()
                .expect("Failed to build demo session governor config"),
        );
        let app = app.layer(tower_governor::GovernorLayer {
            config: governor_conf,
        });
        // The route allowlist gate = the ONE enforcement point of the demo
        // policy (see `modules::demo`). Captured-by-closure (not
        // `from_fn_with_state`): the middleware needs no per-router state at
        // all — the gate state is a plain value the closure owns.
        let gate = modules::demo::GateState::new(
            modules::demo::state().expect("demo state installed at boot"),
            (*pool).clone(),
            config,
        );
        let gate_layer = axum::middleware::from_fn(move |req, next| {
            let gate = gate.clone();
            async move { modules::demo::demo_gate(gate, req, next).await }
        });
        app.layer(gate_layer)
    } else {
        app
    };

    // Demo-mode ITEM-4 (retention, global, pinned examples): the boot pass —
    // seed the pinned example runs (one finished replay run per recorded
    // configuration), enforce the shared-pool limits, sweep the orphan files
    // of a crashed cleanup, reap the stale anonymous sessions, and arm the
    // 10-minute job. Runs here, before the caller binds the listener, so the
    // seeded runs are born terminal and no request can race them.
    if demo.enabled {
        modules::demo::retention::boot_pass((*pool).clone()).await;
    }

    Ok((app, pool, jwt))
}

/// Boot + spawn `serve` on the background runtime; return the handle.
/// **Non-blocking** — the caller keeps the process alive (desktop event loop).
///
/// `secret` is the per-run local-API key the desktop shell made at start: the
/// server refuses every request that does not carry it (see
/// `modules::local_api_lock`). There is no unlocked variant.
pub async fn boot_in_background(config: ServerConfig, secret: String) -> Result<BootParts, BoxErr> {
    // At-rest secret storage key (#60): the DESKTOP entrypoint's init (this path does
    // not parse a CLI `--config-file`, so it resolves from `TXR_SECRET_STORAGE_KEY` or
    // the discovered config's `secrets.storage_key`). First-wins OnceCell. `None` ⇒
    // compat mode. (The CLI serve/worker binary inits in `main` with the explicit path.)
    txresbench_framework::secrets::init_storage_key(config::resolve_storage_key(None));
    // Demo mode for the desktop entrypoint: env + config file only (no CLI).
    let demo = config::resolve_demo_config(false, None);
    let lock = modules::local_api_lock::LocalApiLock::new(
        secret,
        modules::local_api_lock::LockMode::Desktop,
        &config.server.api_prefix,
    );
    let (app, pool, jwt) = build_app(&config, &demo, Some(&lock)).await?;
    let listener = tokio::net::TcpListener::bind(config.server_address()).await?;
    let addr = listener.local_addr()?;
    // The real port, known only now: the lock's Host check and the MCP
    // loopback dispatch both need it, and both must be set before `serve`
    // accepts a connection.
    lock.set_port(addr.port());
    modules::mcp::set_loopback(addr, Some(lock.secret().to_string()));
    // The WSL setup route takes requests to this port only (`wsl_setup::check_caller`).
    modules::sandbox::wsl_setup::note_server_port(addr.port());
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
pub async fn serve_blocking(
    config: ServerConfig,
    demo: config::DemoConfig,
    local_key: String,
) -> Result<(), BoxErr> {
    // Demo mode is a public web service with anonymous visitors by design (its
    // own route gate restricts them): no key. Every other headless server
    // requires the key on every request.
    let lock = (!demo.enabled).then(|| {
        modules::local_api_lock::LocalApiLock::new(
            local_key,
            modules::local_api_lock::LockMode::Headless,
            &config.server.api_prefix,
        )
    });
    let (app, _pool, _jwt) = build_app(&config, &demo, lock.as_ref()).await?;
    let listener = tokio::net::TcpListener::bind(config.server_address()).await?;
    let addr = listener.local_addr()?;
    if let Some(lock) = &lock {
        lock.set_port(addr.port());
    }
    modules::mcp::set_loopback(addr, lock.as_ref().map(|l| l.secret().to_string()));
    // The WSL setup route takes requests to this port only (`wsl_setup::check_caller`).
    modules::sandbox::wsl_setup::note_server_port(addr.port());
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
