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
    /// Check a method list (and its signature) exactly as the app loads one, and print
    /// what it holds: format, sequence, counts, the signer. Exit 1 on any refusal. The
    /// arbiter `scripts/publish-method-list.sh` and `scripts/import-method-list.sh` run.
    CheckMethodList {
        /// The list file (`method-list.json`).
        #[arg(long)]
        list: std::path::PathBuf,
        /// Its minisign signature (`method-list.json.minisig`). Without it only the
        /// unsigned sequence 0 bootstrap copy passes.
        #[arg(long)]
        signature: Option<std::path::PathBuf>,
        /// A trusted-keys file to use instead of the compiled-in keys (test fixtures and
        /// rehearsals only; the report names it).
        #[arg(long)]
        keys: Option<std::path::PathBuf>,
    },
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

    /// Run in DEMO MODE (web-service demo: example data only, recorded runs,
    /// shared pool, route allowlist). Overrides `TXR_DEMO=1` and the config
    /// file's `demo.enabled`; default off (desktop mode unchanged).
    #[arg(long)]
    demo: bool,

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

    // A file check: no config, no data root, no server.
    if let Some(Mode::CheckMethodList {
        list,
        signature,
        keys,
    }) = &cli.mode
    {
        match txresbench::modules::method_list::check_method_list_cli(
            list,
            signature.as_deref(),
            keys.as_deref(),
        ) {
            Ok(report) => {
                print!("{report}");
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("check-method-list: {e}");
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
        Some(Mode::Serve) | None => {
            // The demo switch: CLI `--demo` > TXR_DEMO env > `demo:` block > off.
            let demo = txresbench::config::resolve_demo_config(
                cli.demo,
                cli.config_file.as_deref(),
            );
            // The local-API key every request must carry (not in demo mode: a public
            // web service with anonymous visitors by design). Env > config file >
            // generated; a generated key is printed once, like a notebook token.
            let (local_key, generated) = match txresbench::modules::local_api_lock::resolve_headless_key(
                txresbench::config::read_local_api_key(cli.config_file.as_deref()),
            ) {
                Ok(k) => k,
                Err(e) => {
                    eprintln!("fatal: {e}");
                    std::process::exit(1);
                }
            };
            if generated && !demo.enabled {
                println!("{}", txresbench::modules::local_api_lock::key_banner(&local_key));
            }
            txresbench::serve_blocking(config, demo, local_key).await
        }
        Some(Mode::CheckMethodList { .. }) => unreachable!("handled before the config load"),
    };
    if let Err(e) = result {
        eprintln!("fatal: {e}");
        txresbench::cleanup().await;
        std::process::exit(1);
    }
}
