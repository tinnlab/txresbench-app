//! OpenAPI + TypeScript-client generation driver.
//!
//! App-side head (load config, publish a lazy pool, instantiate + init modules,
//! build the router) → the SDK's `finish_and_emit` tail, which writes
//! `openapi.json` + `types.ts`. Generation walks the router structure only and
//! never executes a handler, so the pool is created with `connect_lazy` and
//! never dialed — no live DB required.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use sqlx::sqlite::SqlitePoolOptions;
use txresbench_framework::app_builder::{build_api_router, create_modules};
use txresbench_framework::openapi::finish_and_emit;
use txresbench_framework::ModuleContext;

use crate::config;

/// Generate `<output_dir>/openapi.json` and the typed api-client into
/// `<output_dir>/../src/<api_client_subdir>/{types,permissions,permissionDescriptions,apiEndpoints}.ts`.
///
/// `api_client_subdir` is the ONLY thing that differs between the two-spec targets
/// (INV: same backend, two clients): the desktop/default regen passes `"api-client"`
/// and the saas regen (built `--features saas`) passes `"api-client-saas"`, so the
/// saas-ON `billing::admin` permission + billing endpoints/types land in a SEPARATE,
/// committed client tree instead of overwriting the default one. The api-client path
/// is APP output, never SDK-hardcoded — `finish_and_emit` takes the types.ts path as
/// a separate arg and derives its four siblings from that file's directory.
pub async fn generate_openapi_spec(
    output_dir: &str,
    api_client_subdir: &str,
    config_file: Option<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("Generating OpenAPI specification...");
    let cfg = config::load_config(config_file.as_deref())?;

    // Lazy, never-connected pool — the URL is parsed at construction but no
    // socket opens, and generation issues no query. The sqlite driver is the
    // app's only driver under this node, so the resolved target (env override
    // > config > app-data-dir default) is what gets parsed, never dialed.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_lazy(&config::resolve_database_target(
            &cfg,
            &crate::modules::rootfs::data_root(),
        ))?;

    let ctx = ModuleContext::new(
        Arc::new(pool.clone()),
        Arc::new(cfg.clone()),
        Arc::new(()) as Arc<dyn std::any::Any + Send + Sync>,
    );

    // Same declaration the real boot makes (`lib.rs`). Spec generation never
    // publishes anything, but `AuthModule::init` now REFUSES without one — and
    // an init failure here is only a warning, after which `register_routes`
    // early-returns and every `/api/auth/*` path would silently vanish from the
    // emitted spec. So the declaration is what keeps the generated surface equal
    // to the served one.
    crate::modules::sync::install_auth_sync_sink();

    let mut modules = create_modules();
    for m in modules.iter_mut() {
        if let Err(e) = m.init(&ctx) {
            eprintln!(
                "openapi-gen: module '{}' init failed: {e} (continuing — routes still register)",
                m.name()
            );
        }
    }

    let (api_router, api_doc) = build_api_router(&modules, &cfg.server.api_prefix, pool.clone());

    let out = Path::new(output_dir);
    let types_ts = out.join(format!("../src/{api_client_subdir}/types.ts"));

    // The previously-committed artifacts, kept so a FAILED generation cannot leave a
    // half-true spec on disk for someone to commit (see the auth-surface check below).
    let prior_spec = fs::read(out.join("openapi.json")).ok();
    let prior_types = fs::read(&types_ts).ok();

    finish_and_emit(api_router, api_doc, out, &types_ts)?;

    // A module whose `init` failed above still gets `register_routes` called — and
    // `AuthModule::register_routes` EARLY-RETURNS when it was not initialized, so the
    // "continuing — routes still register" line above is not true for it. The result would
    // be a spec + a generated client silently missing every `/api/auth/*` path, committed
    // by whoever ran the regen. So assert the shape instead of trusting the warning.
    //
    // The check runs on the EMITTED spec, and that placement is the whole point. It used to
    // read `api_doc` as returned by `build_api_router` — a doc that is EMPTY by construction
    // there (`OpenApi::default()` plus a security scheme; every path is added later, by
    // aide's `finish_api` inside `finish_and_emit`). So it counted zero paths on every run,
    // for every module, and `--generate-openapi` could not succeed at all: a guard against
    // an incomplete spec that instead refused every complete one. Asserting on the artifact
    // that will actually be committed is the only version of this check that can be true.
    let emitted = fs::read_to_string(out.join("openapi.json"))?;
    let auth_paths = serde_json::from_str::<serde_json::Value>(&emitted)
        .ok()
        .and_then(|v| v.get("paths").and_then(|p| p.as_object()).cloned())
        .map(|paths| {
            let prefix = format!("{}/auth", cfg.server.api_prefix);
            paths.keys().filter(|k| k.starts_with(&prefix)).count()
        })
        .unwrap_or(0);
    if auth_paths == 0 {
        // Put the previous artifacts back: a non-zero exit is easy to miss, a silently
        // rewritten spec is not easy to notice, and the two together are how a client with
        // no auth surface gets committed.
        if let Some(bytes) = prior_spec {
            fs::write(out.join("openapi.json"), bytes)?;
        }
        if let Some(bytes) = prior_types {
            fs::write(&types_ts, bytes)?;
        }
        return Err(format!(
            "openapi-gen: the emitted spec exposes ZERO {}/auth/* paths. A module init \
             failure (see any 'init failed' line above) drops routes silently; emitting \
             this spec would ship a client with no auth surface. The previously-committed \
             openapi.json + types.ts have been restored.",
            cfg.server.api_prefix
        )
        .into());
    }

    Ok(())
}
