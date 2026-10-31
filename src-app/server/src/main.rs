//! CytoAnalyst server CLI — a thin binary over the `cytoanalyst` library.
//!
//! Boot logic lives in `lib.rs` (`boot_in_background` / `serve_blocking`) so the
//! desktop harness can embed the identical server assembly.

use clap::{Parser, Subcommand};

/// The run MODE (T3 / ITEM-2 / §4.3). Absent ⇒ `serve` (the historical default — the
/// existing invocation + the openapi/backfill flags below are untouched). `worker` boots the
/// SAME library assembly minus the public router and runs the scheduler loop (claims jobs).
#[derive(Subcommand, Debug)]
enum Mode {
    /// Run the HTTP API server (the default when no subcommand is given).
    Serve,
    /// Run a job worker: claim + execute queued jobs, no public router (SaaS worker pod).
    Worker,
    /// Execute exactly ONE already-claimed job in-pod, then exit (the job-per-run
    /// `KubernetesBackend` pod entrypoint, #66): stage inputs from the object store → bwrap →
    /// finalize outputs back. No public router, no scheduler loop (claims nothing else).
    RunJob {
        /// The id of the already-claimed job to execute.
        #[arg(long)]
        job_id: uuid::Uuid,
    },
}

#[derive(Parser, Debug)]
#[command(
    name = "cytoanalyst",
    about = "TxResBench server — treatment response from blood markers (ziee SDK)"
)]
struct Cli {
    /// Run mode. Omit for `serve` (default). `worker` runs the job scheduler loop only.
    #[command(subcommand)]
    mode: Option<Mode>,

    /// Config file (YAML). Falls back to $CONFIG_FILE, then config/dev.yaml.
    #[arg(long)]
    config_file: Option<String>,

    /// Generate the DEFAULT (saas-OFF) OpenAPI spec + TypeScript client into <DIR>
    /// (emitting `<DIR>/../src/api-client/*`), then exit. Consumed by the desktop/OSS build.
    #[arg(long, value_name = "DIR")]
    generate_openapi: Option<String>,

    /// Report what the artifact→dataset backfill (ITEM-45) WOULD change, then exit.
    ///
    /// **Read-only.** It is the migration's own code path with `write = false` — DEC-9: a
    /// dry-run implemented as a separate query is a dry-run of something other than the
    /// migration, and can agree with itself while diverging from what runs.
    ///
    /// Reads `DATABASE_URL`, so it can be pointed at a database WITHOUT booting the server
    /// or going through the running application.
    #[arg(long)]
    backfill_dry_run: bool,

    /// PERFORM the artifact→dataset backfill (the same code path, `write = true`).
    #[arg(long)]
    backfill_write: bool,
}

#[tokio::main]
async fn main() {
    cytoanalyst::init_tracing();
    let cli = Cli::parse();

    if let Some(dir) = cli.generate_openapi {
        let subdir = "api-client";
        match cytoanalyst::openapi::generate_openapi_spec(&dir, subdir, cli.config_file).await {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("OpenAPI generation failed: {e}");
                std::process::exit(1);
            }
        }
    }

    if cli.backfill_dry_run || cli.backfill_write {
        let url = match std::env::var("DATABASE_URL") {
            Ok(u) => u,
            Err(_) => {
                eprintln!(
                    "backfill: set DATABASE_URL to the database to read. This path never \
                     boots the server and never goes through the running application."
                );
                std::process::exit(2);
            }
        };
        let pool = match sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("backfill: cannot connect: {e}");
                std::process::exit(2);
            }
        };
        match cytoanalyst::modules::workstore::ownership_backfill::run_backfill(
            &pool,
            cli.backfill_write,
        )
        .await
        {
            Ok(report) => {
                println!("{}", report.render());
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("backfill failed: {e}");
                std::process::exit(1);
            }
        }
    }

    let config = match cytoanalyst::config::load_config(cli.config_file.as_deref()) {
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
    ziee_framework::secrets::init_storage_key(cytoanalyst::config::resolve_storage_key(
        cli.config_file.as_deref(),
    ));

    // Dispatch on the run mode. No subcommand ⇒ `serve` (default, unchanged); `worker`
    // boots the same assembly minus the public router and runs the scheduler loop (ITEM-2).
    let result = match cli.mode {
        Some(Mode::Worker) => cytoanalyst::run_worker(config).await,
        Some(Mode::RunJob { job_id }) => cytoanalyst::run_job_once(config, job_id).await,
        Some(Mode::Serve) | None => cytoanalyst::serve_blocking(config).await,
    };
    if let Err(e) = result {
        eprintln!("fatal: {e}");
        cytoanalyst::cleanup().await;
        std::process::exit(1);
    }
}
