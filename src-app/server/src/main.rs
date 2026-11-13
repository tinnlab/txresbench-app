//! TxResBench server CLI — a thin binary over the `txresbench` library.
//!
//! Boot logic lives in `lib.rs` (`boot_in_background` / `serve_blocking`) so the
//! desktop harness can embed the identical server assembly.

use clap::{Parser, Subcommand};

/// Run mode. Absent ⇒ `serve` (the historical default — the existing invocation
/// and the `--generate-openapi` flag below are untouched). The single-cell platform's
/// `worker`/`run-job` pod modes and the artifact backfill flags were removed with
/// their modules (strip-single-cell ITEM-3).
#[derive(Subcommand, Debug)]
enum Mode {
    /// Run the HTTP API server (the default when no subcommand is given).
    Serve,
}

#[derive(Parser, Debug)]
#[command(
    name = "txresbench",
    about = "TxResBench server — treatment response from blood markers (txresbench SDK)"
)]
struct Cli {
    /// Run mode. Omit for `serve` (default).
    #[command(subcommand)]
    mode: Option<Mode>,

    /// Config file (YAML). Falls back to $CONFIG_FILE, then config/dev.yaml.
    #[arg(long)]
    config_file: Option<String>,

    /// Generate the DEFAULT (saas-OFF) OpenAPI spec + TypeScript client into <DIR>
    /// (emitting `<DIR>/../src/api-client/*`), then exit. Consumed by the desktop/OSS build.
    #[arg(long, value_name = "DIR")]
    generate_openapi: Option<String>,
}

#[tokio::main]
async fn main() {
    txresbench::init_tracing();
    let cli = Cli::parse();

    if let Some(dir) = cli.generate_openapi {
        let subdir = "api-client";
        match txresbench::openapi::generate_openapi_spec(&dir, subdir, cli.config_file).await {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("OpenAPI generation failed: {e}");
                std::process::exit(1);
            }
        }
    }

    let config = match txresbench::config::load_config(cli.config_file.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fatal: {e}");
            std::process::exit(1);
        }
    };

    // At-rest secret storage key (#60): initialize from the SAME explicit `--config-file`
    // path `load_config` used (or discovery/env when absent), so a deployment launched
    // with an explicit config that sets `secrets.storage_key` actually gets encryption —
    // NOT silently compat mode. `init_storage_key` is a first-wins OnceCell, so this
    // authoritative call precedes (and no-ops) the discovery-based fallback in `build_app`
    // that still covers the desktop `boot_in_background` entrypoint.
    txresbench_framework::secrets::init_storage_key(txresbench::config::resolve_storage_key(
        cli.config_file.as_deref(),
    ));

    // Dispatch on the run mode. No subcommand ⇒ `serve` (default, unchanged); `worker`
    // boots the same assembly minus the public router and runs the scheduler loop (ITEM-2).
    let result = match cli.mode {
        Some(Mode::Serve) | None => txresbench::serve_blocking(config).await,
    };
    if let Err(e) = result {
        eprintln!("fatal: {e}");
        txresbench::cleanup().await;
        std::process::exit(1);
    }
}
