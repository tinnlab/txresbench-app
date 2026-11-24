//! TxResBench integration-test harness — the app side of the SDK's
//! `txresbench-test-harness` `HarnessApp` seam.
//!
//! The SDK crate owns the generic engine (per-worktree template, per-test
//! database, spawn + readiness + teardown). TxResBench supplies ONE `HarnessApp`
//! impl (binary name, template-DB base, migration dirs, rendered config) plus a
//! thin `TestServer` wrapper that re-exposes `base_url`/`api_url` + HTTP helpers.
//!
//! The engine runs the sqlite leg (a `sqlite://` `DATABASE_URL`, which is what
//! `.cargo/config.toml` ships): the per-test database is a FILE copied from a
//! fully-migrated template file, rendered into the config as `database.url`.
//! No Postgres cluster, no `DATABASE_URL`-reaching server — only the temp dir.

use std::path::{Path, PathBuf};

use txresbench_test_harness::{HarnessApp, SpawnFacts, SpawnPlan, SpawnedServer, TestHarness, Variant};

/// B0 — the local Stripe sim harness (signed-webhook injector + reference verifier +
/// placeholder webhook consumer + meter-event capture stand-in). TEST-ONLY; carries
/// its own `#[cfg(test)]` self-tests (the INV-2 acceptance proof). Some of its public
/// surface is consumed only by `tests/billing/` (the L2 tier), so `dead_code` is
/// allowed here like `zarr` above — the shape is deliberately broader than any one
/// caller so B2/B3 can build on it without re-forking.
#[allow(dead_code)]
pub mod stripe_sim;

/// TxResBench's `HarnessApp`. Server-only (no desktop test crate yet).
pub struct CytoHarnessApp;

/// The fixed bytes of every pre-staged method-env squashfs
/// ([`TestOptions::prestage_method_envs`]). The bytes are deliberately
/// NOT a real rootfs: the record's purpose is the manager's `ready` +
/// cache-entry load rule (so `DELETE /envs/{id}?prune=true` has a real 204
/// target with a real digest), not a mountable artifact — nothing in the
/// boot/test path mounts it.
pub const PRESTAGED_METHOD_ENV_SQUASHFS: &[u8] = b"txr-prestaged-method-env-squashfs-bytes";

/// Per-spawn knobs. Grow as tests need config overrides (mirrors txresbench's
/// `TestServerOptions`).
#[derive(Default, Clone)]
pub struct TestOptions {
    /// Report the per-test database name the harness generated, through
    /// `plan_spawn` — the ONLY place the app can see it before the spawn either
    /// succeeds or panics. `harness_db_lifecycle` uses it to name the database it
    /// must then find gone; nothing else reads it.
    pub observed_database_name: Option<std::sync::Arc<std::sync::Mutex<Option<String>>>>,

    /// Point the spawn at a binary stem that does not exist, so `TestHarness::start`
    /// panics AFTER `CREATE DATABASE` and BEFORE it can construct the handle. That
    /// window is a real leak path (the readiness-ceiling panic took it during this
    /// change's own validation run) and it is not otherwise reachable from a test.
    pub break_binary_name: bool,

    /// Override the sync stream's periodic re-check cadence
    /// (`SYNC_RECHECK_TICK_MS`, a debug-only seam compiled out of release
    /// builds). Production ticks every 60s; a test that must observe a
    /// mid-stream teardown — deactivation, permission loss, logout — sets this
    /// to a few hundred ms instead of sleeping a minute.
    pub sync_recheck_tick_ms: Option<u64>,

    /// Override the billing rollup loop's tick period, in milliseconds
    /// (`TXR_BILLING_ROLLUP_TICK_MS`, a debug-only seam compiled out of release
    /// builds — mirrors `SYNC_RECHECK_TICK_MS`). Production ticks every
    /// `rollup_interval_hours` (≥1h); a test that must observe a fold+emit after
    /// seeding meter rows sets this to a few hundred ms instead of waiting an hour.
    /// `saas`-only (the rollup loop is gated on the feature); ignored otherwise.
    pub billing_rollup_tick_ms: Option<u64>,

    /// Override the billing usage-alert ladder loop's tick period, in milliseconds
    /// (`TXR_BILLING_ALERT_TICK_MS`, a debug-only seam compiled out of release builds —
    /// mirrors `billing_rollup_tick_ms`). A test that must observe an alert emit after
    /// seeding a rollup row sets this to a few hundred ms. `saas`-only.
    pub billing_alert_tick_ms: Option<u64>,

    /// Gate the spawned server's job scheduler loop (T3 / G2 / PROV-T3-2). `None` (default)
    /// leaves `TXR_SCHEDULER_ENABLED` unset → the loop runs (single-box default). `Some(false)`
    /// spawns an ENQUEUE-ONLY `serve` pod that never claims (the SaaS API-pod posture);
    /// `Some(true)` sets it explicitly on (positive control).
    pub scheduler_enabled: Option<bool>,

    /// Pre-stage this many fake rootfs digest dirs under the spawned server's
    /// `<data_dir>/sandbox-rootfs/` BEFORE it boots, so the boot pass of the
    /// rootfs-cache GC (#154) has a backlog to reclaim. Zero (the default) stages
    /// nothing and leaves the cache untouched.
    ///
    /// Pre-staging is the only way to observe the BOOT pass: the sweep runs inside
    /// the server subprocess as `provenance` initializes, so anything a test writes
    /// after `TestServer::start` returns has already missed it.
    pub prestage_rootfs_digests: usize,

    /// Pre-stage method-env records under the spawned server's
    /// `<data_dir>/txr-envs/` + a matching cached artifact at
    /// `<data_dir>/sandbox-rootfs/<digest>/rootfs.squashfs` BEFORE it boots.
    /// The txr method-env manager loads its persisted ledger at sandbox init
    /// (`method_env::manager()`), so a record written after `spawn` returns is
    /// invisible to it — the same boot-window reason as
    /// `prestage_rootfs_digests`. Each tuple is `(env_id, kind)` with
    /// `kind` = `"base"` | `"layer"`; the digest is the sha256 of
    /// [`PRESTAGED_METHOD_ENV_SQUASHFS`] (the manager honors a `ready` record
    /// only while the cache entry exists), the state is `ready`.
    ///
    /// This is what lets a route test reach `DELETE /envs/{id}`'s 204+prune
    /// arm without network and without oras (a real `ensure` would pull).
    pub prestage_method_envs: Vec<(String, String)>,

    /// Set the at-rest secret storage key (`TXR_SECRET_STORAGE_KEY`, #60) for the
    /// spawned server, enabling ENCRYPTED billing-integration storage. `None` (default)
    /// leaves it unset → compat mode (no DB secret storage; env fallback). A test that
    /// must exercise encrypt-at-rest / masked-read sets a ≥32-char key here. Mirrors the
    /// other opt-in env knobs above.
    pub secret_storage_key: Option<String>,

    /// Point the spawned server's pretrained-catalogue boot refresh at this
    /// catalogue URL (`TXR_CATALOGUE_URL` — the module's documented
    /// default-resolution seam). `None` (default) defaults to a CLOSED
    /// loopback port: the boot refresh fails instantly without network, so
    /// every spawned server boots offline-fast and no test suite dials the
    /// production catalogue host. A test that must serve a live catalogue
    /// sets its own loopback URL here.
    pub catalogue_url: Option<String>,

    /// Point the spawned server's method list checks at this reference
    /// (`TXR_METHOD_LIST_REF=<host>[:<port>]/<path>:<tag>` — the module's
    /// debug-only seam). `None` (default) names a CLOSED loopback port: the
    /// boot check and every run-start check fail at once without network, so
    /// no test suite dials the production registry. A test that serves a list
    /// names its own loopback reference and stages a stand-in `bin/oras`
    /// ([`TestOptions::prestage_data_files`]).
    pub method_list_ref: Option<String>,

    /// Trust one more method list key in the spawned server
    /// (`TXR_METHOD_LIST_TEST_KEY`, debug only): a minisign public key file
    /// (the fixture test key's `test-key.pub`).
    pub method_list_test_key: Option<PathBuf>,

    /// Files written under the spawned server's `<data_dir>` BEFORE it boots:
    /// `(relative path, bytes, executable)`. A stand-in `bin/oras` (the tool
    /// lookup's `<app_data>/bin`) or a stored method list
    /// (`method-list/v2/…`) must exist before the boot reads them.
    pub prestage_data_files: Vec<(String, Vec<u8>, bool)>,

    /// Point the spawned server's pretrained bundled-models dir at this
    /// directory (`TXR_BUNDLED_MODELS_DIR` — the module's documented
    /// bundle-layout resolution). `None` (default) leaves the env unset →
    /// `<data_dir>/pretrained-bundled`. A test that must exercise the
    /// bundled install source (TEST-PC-07/23) writes its fixture `.txr` here
    /// before the spawn.
    pub pretrained_bundled_dir: Option<PathBuf>,

    /// Spawn the server in DEMO MODE (`TXR_DEMO=1`; demo-mode ITEM-1). All
    /// other knobs are unchanged — the demo boot is the same binary with the
    /// switch on, exactly the deployment shape.
    pub demo: bool,

    /// Point the spawned server's demo bundle at this directory
    /// (`TXR_DEMO_BUNDLE` — demo-mode ITEM-2; the manifest + table files must
    /// already exist, a test builds the fixture before the spawn). `None`
    /// (default) leaves the env unset → the loader's default
    /// `<data_dir>/demo-bundle`, which this harness provisions with a minimal
    /// VALID fixture for every demo-mode spawn (a demo boot refuses an
    /// invalid bundle, so ITEM-1's demo tests boot against the fixture).
    pub demo_bundle_dir: Option<PathBuf>,

    /// Withhold the harness's default valid bundle fixture (demo-mode
    /// ITEM-2): a demo spawn with this set has NO bundle anywhere, so the
    /// boot REFUSES — the refusal test's knob.
    pub demo_missing_bundle: bool,

    /// Extra top-level YAML appended to the rendered config (demo-mode
    /// ITEM-1: a test that tunes `demo.max_bytes` or the notice key passes
    /// its snippet here). Appended AFTER the `jwt:` block, so it may add NEW
    /// top-level keys only — it must not repeat `server:`/`database:` (the
    /// demo tests use [`rate_limit`] for the server block).
    pub extra_config_yaml: Option<String>,

    /// The `server.rate_limit` block (demo-mode ITEM-1: a test that must
    /// observe a 429 bucket sets 1 req/s, burst 2). Rendered INSIDE the
    /// rendered `server:` block, so the block is never duplicated.
    pub rate_limit: Option<(u64, u32)>,
}

/// The harness's minimal VALID demo bundle fixture (demo-mode ITEM-2): a
/// version-1 manifest whose recorded example hashes are the REAL embedded
/// assets' (computed in-process with the library's canonical function —
/// never a hard-coded value that would go stale), one recorded configuration
/// + one method with parseable train/reuse tables. Written under the server's
/// own data dir, so a demo spawn finds it at the default path without an env
/// var. The ITEM-2 scenario tests pass their OWN fixture instead (via
/// [`TestOptions::demo_bundle_dir`]).
fn write_demo_bundle_fixture(bundle_dir: &Path) {
    use txresbench::modules::demo::bundle::{
        FORMAT_TAG, FORMAT_VERSION, asset_table_facts, csv_bytes_content_hash,
    };
    use txresbench::modules::file_validator::assets;

    let table_hash = |bytes: &[u8]| csv_bytes_content_hash(bytes);
    let (patients_rows, patients_cols) = asset_table_facts(assets::ASSETS.patients_example);
    let (measurements_rows, measurements_cols) =
        asset_table_facts(assets::ASSETS.measurements_example);
    let (predict_rows, predict_cols) =
        asset_table_facts(assets::ASSETS.predict_measurements_example);
    let manifest = serde_json::json!({
        "format": FORMAT_TAG,
        "version": FORMAT_VERSION,
        "generated_at": "2026-11-14T00:00:00Z",
        "dataset_id": "example",
        "tables": {
            "patients": {"content_hash": table_hash(assets::ASSETS.patients_example), "rows": patients_rows, "columns": patients_cols},
            "measurements": {"content_hash": table_hash(assets::ASSETS.measurements_example), "rows": measurements_rows, "columns": measurements_cols},
            "predict_measurements": {"content_hash": table_hash(assets::ASSETS.predict_measurements_example), "rows": predict_rows, "columns": predict_cols},
        },
        "configurations": [{
            "id": "pfs_d56_h238",
            "endpoint": "pfs",
            "decision_day": 56.0,
            "look_ahead_day": 238.0,
            "covariates": false,
            "logs": [{"method_id": "kelim", "stream": "engine", "content": "started"}],
        }],
        "methods": [{
            "method_id": "kelim",
            "records": [{
                "configuration_id": "pfs_d56_h238",
                "seconds": 12.5,
                "train": {
                    "table": "train/pfs_d56_h238/kelim.csv",
                    "label": "kelim",
                    "group": "kinetics",
                    "group_label": "Kinetics",
                    "task": "pfs",
                    "prob_source": "native",
                    "flat_conversion": false,
                    "coverage": {"scored": 94, "eligible": 94, "fraction": 1.0},
                    "rows": 94,
                },
                "model": {
                    "name": "kelim",
                    "method_version": "1.0.0",
                    "group": "kinetics",
                    "group_label": "Kinetics",
                    "task": "pfs",
                    "trained_on_patients": 94,
                    "trained_at": "2026-11-14T00:00:00Z",
                    "decision_day": 56.0,
                    "endpoint": "pfs",
                    "horizon": 238.0,
                    "size_bytes": 1024,
                    "embeds_training_data": false,
                    "own_auc": 0.71,
                    "marker_count": 3,
                    "marker_kind": "all",
                    "uses_covariates": false,
                },
                "reuse": {
                    "table": "reuse/pfs_d56_h238/kelim.csv",
                    "label": "kelim",
                    "group": "kinetics",
                    "group_label": "Kinetics",
                    "task": "pfs",
                    "prob_source": "native",
                    "flat_conversion": false,
                    "coverage": {"scored": 15, "eligible": 15, "fraction": 1.0},
                    "rows": 15,
                },
            }],
        }],
    });
    std::fs::create_dir_all(bundle_dir).expect("demo bundle dir");
    std::fs::write(
        bundle_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).expect("demo fixture manifest"),
    )
    .expect("write demo fixture manifest");
    std::fs::create_dir_all(bundle_dir.join("train/pfs_d56_h238")).expect("train dir");
    let train: String = (0..94).map(|i| format!("J{i:04},0.5,\n")).collect();
    std::fs::write(
        bundle_dir.join("train/pfs_d56_h238/kelim.csv"),
        format!("patient_id,probability,note\n{train}"),
    )
    .expect("write train table");
    std::fs::create_dir_all(bundle_dir.join("reuse/pfs_d56_h238")).expect("reuse dir");
    let reuse: String = (0..15).map(|i| format!("J1{i:03},0.5,\n")).collect();
    std::fs::write(
        bundle_dir.join("reuse/pfs_d56_h238/kelim.csv"),
        format!("patient_id,probability,note\n{reuse}"),
    )
    .expect("write reuse table");
}

impl HarnessApp for CytoHarnessApp {
    type Options = TestOptions;

    fn template_db_base(&self, _variant: Variant) -> String {
        // The engine appends the per-worktree suffix so concurrent worktrees
        // never clobber each other's template.
        "txresbench_test_template".to_string()
    }

    fn migration_dirs(&self, _variant: Variant, manifest_dir: &Path) -> Vec<PathBuf> {
        // build.rs composes the app + txresbench-auth migrations here.
        vec![manifest_dir.join("migrations-merged")]
    }

    fn plan_spawn(&self, opts: &Self::Options, facts: &SpawnFacts) -> SpawnPlan {
        // demo-mode ITEM-2: a demo boot requires a valid bundle, so every
        // demo-mode spawn gets the harness's minimal valid fixture (unless
        // the test provides its own, or opts out with `demo_missing_bundle`
        // to prove the refusal). The fixture is written BEFORE the spawn;
        // the server resolves it at the default `<data_dir>/demo-bundle`
        // path, the deployment shape minus the env override.
        let default_bundle_dir = facts.data_dir.join("demo-bundle");
        if opts.demo && !opts.demo_missing_bundle {
            write_demo_bundle_fixture(&default_bundle_dir);
        }
        // The sqlite leg hands the app the per-test FILE's connection URL (the
        // harness copied it from the migrated template and owns its lifecycle);
        // `database.url` is exactly the config key `ServerConfig` resolves.
        // Both paths are single-quoted: YAML reads no escapes there, so a
        // Windows path (`C:\Users\...`) is taken as written; in double quotes
        // `\U` starts an escape and the config does not parse.
        // The postgresql block is GONE from the app's config surface — the app
        // is single-driver (sqlite) under this node.
        let config_yaml = format!(
            r#"
app:
  data_dir: '{data_dir}'

database:
  url: '{database_url}'

server:
  host: "127.0.0.1"
  port: {server_port}
  api_prefix: "/api"
  trust_forwarded_headers: false
{rate_limit}

logging:
  level: "warn"
  format: "pretty"

jwt:
  secret: "test-secret-key-for-jwt-tokens-min-32-chars-long"
  issuer: "txresbench"
  audience: "txresbench-api"
  access_token_expiry_hours: 24
  refresh_token_expiry_days: 30
{extra}
"#,
            data_dir = facts.data_dir.display(),
            database_url = facts.database_url,
            server_port = facts.server_port,
            rate_limit = opts
                .rate_limit
                .map(|(per_second, burst)| {
                    format!(
                        "  rate_limit:\n    per_second: {per_second}\n    burst_size: {burst}\n"
                    )
                })
                .unwrap_or_default(),
            extra = opts.extra_config_yaml.clone().unwrap_or_default(),
        );

        if let Some(slot) = &opts.observed_database_name {
            *slot.lock().expect("observed-db-name slot") = Some(facts.database_name.to_string());
        }

        SpawnPlan {
            config_yaml,
            binary_name: if opts.break_binary_name {
                "txresbench-no-such-binary".to_string()
            } else {
                "txresbench".to_string()
            },
            extra_argv: vec![],
            // Isolate each test's sandbox/rootfs writes to its own data dir.
            // `ServerConfig` drops the `app.data_dir` key, so without this every
            // test would collapse onto the shared `~/.app` (see rootfs::data_root).
            extra_env: {
                if opts.prestage_rootfs_digests > 0 {
                    let base = facts.data_dir.join("sandbox-rootfs");
                    std::fs::create_dir_all(&base).expect("prestage rootfs cache dir");
                    for i in 0..opts.prestage_rootfs_digests {
                        // A valid 64-char lowercase-hex digest, distinct per index.
                        let digest = format!("{:02x}", i as u8).repeat(32);
                        let dir = base.join(&digest);
                        std::fs::create_dir_all(&dir).expect("prestage digest dir");
                        std::fs::write(dir.join("rootfs.squashfs"), b"prestaged-rootfs-bytes")
                            .expect("prestage squashfs");
                    }
                }
                if !opts.prestage_method_envs.is_empty() {
                    use sha2::{Digest, Sha256};
                    let txr = facts.data_dir.join("txr-envs");
                    std::fs::create_dir_all(&txr).expect("prestage txr-envs dir");
                    let cache_base = facts.data_dir.join("sandbox-rootfs");
                    std::fs::create_dir_all(&cache_base).expect("prestage method-env cache dir");
                    let digest = hex::encode(Sha256::digest(PRESTAGED_METHOD_ENV_SQUASHFS));
                    let digest_dir = cache_base.join(&digest);
                    std::fs::create_dir_all(&digest_dir).expect("prestage method-env digest dir");
                    std::fs::write(
                        digest_dir.join("rootfs.squashfs"),
                        PRESTAGED_METHOD_ENV_SQUASHFS,
                    )
                    .expect("prestage method-env squashfs");
                    for (env_id, kind) in &opts.prestage_method_envs {
                        if !txresbench::modules::sandbox::env_id::is_valid_env_id(env_id) {
                            panic!("prestage_method_envs: {env_id:?} is not a valid env id");
                        }
                        if !matches!(kind.as_str(), "base" | "layer") {
                            panic!("prestage_method_envs: kind {kind:?} is not base|layer");
                        }
                        let record = serde_json::json!({
                            "env_id": env_id,
                            "kind": kind,
                            "state": "ready",
                            "digest": digest,
                            "last_used": 0,
                        });
                        std::fs::write(
                            txr.join(format!("{env_id}.json")),
                            record.to_string(),
                        )
                        .expect("prestage method-env ledger");
                    }
                }
                for (rel, bytes, executable) in &opts.prestage_data_files {
                    let path = facts.data_dir.join(rel);
                    std::fs::create_dir_all(path.parent().expect("a file under the data dir"))
                        .expect("prestage data dir");
                    std::fs::write(&path, bytes).expect("prestage data file");
                    #[cfg(unix)]
                    if *executable {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                            .expect("prestage data file mode");
                    }
                    #[cfg(not(unix))]
                    let _ = executable;
                }
                let mut env = vec![
                    (
                        "TXR_APP_DATA_DIR".to_string(),
                        facts.data_dir.display().to_string(),
                    ),
                    // The server refuses every request without this key (demo
                    // mode excepted: it installs no lock).
                    ("TXR_LOCAL_API_KEY".to_string(), TEST_LOCAL_API_KEY.to_string()),
                ];
                if let Some(ms) = opts.sync_recheck_tick_ms {
                    env.push(("SYNC_RECHECK_TICK_MS".to_string(), ms.to_string()));
                }
                if let Some(on) = opts.scheduler_enabled {
                    env.push((
                        "TXR_SCHEDULER_ENABLED".to_string(),
                        if on { "1" } else { "0" }.to_string(),
                    ));
                }
                if let Some(ms) = opts.billing_rollup_tick_ms {
                    env.push(("TXR_BILLING_ROLLUP_TICK_MS".to_string(), ms.to_string()));
                }
                if let Some(ms) = opts.billing_alert_tick_ms {
                    env.push(("TXR_BILLING_ALERT_TICK_MS".to_string(), ms.to_string()));
                }
                if let Some(key) = &opts.secret_storage_key {
                    env.push(("TXR_SECRET_STORAGE_KEY".to_string(), key.clone()));
                }
                // The pretrained-catalogue boot refresh (a detached task) must
                // never dial the production catalogue host from a test suite:
                // the default is a CLOSED loopback port (instant refusal), a
                // test that needs a live catalogue passes its own URL.
                env.push((
                    "TXR_CATALOGUE_URL".to_string(),
                    opts.catalogue_url
                        .clone()
                        .unwrap_or_else(|| "http://127.0.0.1:9/catalogue.json".to_string()),
                ));
                // The method list check (boot + run start) must never dial the
                // production registry from a test suite either: a CLOSED loopback
                // port by default, a test that serves a list passes its own.
                env.push((
                    "TXR_METHOD_LIST_REF".to_string(),
                    opts.method_list_ref
                        .clone()
                        .unwrap_or_else(|| "127.0.0.1:9/tinnlab/txresbench-method-list:v2".to_string()),
                ));
                if let Some(key) = &opts.method_list_test_key {
                    env.push((
                        "TXR_METHOD_LIST_TEST_KEY".to_string(),
                        key.display().to_string(),
                    ));
                }
                // The same for the pretrained bundled-models dir: a test that
                // must exercise the bundled install source passes its own
                // layout (the module's documented env seam).
                if let Some(dir) = &opts.pretrained_bundled_dir {
                    env.push((
                        "TXR_BUNDLED_MODELS_DIR".to_string(),
                        dir.display().to_string(),
                    ));
                }
                if opts.demo {
                    env.push(("TXR_DEMO".to_string(), "1".to_string()));
                }
                if let Some(dir) = &opts.demo_bundle_dir {
                    env.push(("TXR_DEMO_BUNDLE".to_string(), dir.display().to_string()));
                }
                env
            },
            keep_alive: vec![],
        }
    }

    /// The framework's always-200 health endpoint is the readiness probe (the
    /// previously-named `/api/app/setup/status` route does not exist on the
    /// shipped router; measured against a live boot).
    fn health_path(&self) -> String {
        "/api/health".to_string()
    }

    /// `/api/health` is behind the local-API lock too: the readiness poll
    /// sends the test key.
    fn health_headers(&self) -> Vec<(String, String)> {
        vec![("x-txr-local-key".to_string(), TEST_LOCAL_API_KEY.to_string())]
    }
}

// ───────────────── the test process's own "boot": process-global registries ─────
//
// strip-single-cell ITEM-3: the extension/datatype registry publication helpers
// (`processors_root`, `ensure_extension_registry`) were removed with the
// extensions/processor platform; no kept in-process reader loads them.

/// The SSE sync probe, imported FROM THE SDK.
///
/// This was a 258-line hand-rolled mirror of `txresbench_test_harness`'s own
/// `fixtures::sync_probe`, written only because that fixture sat behind the
/// all-or-nothing `fixtures` cargo flag, whose other members (`testcontainers`,
/// `wiremock`, `rsa`) are not otherwise in this workspace. The SDK now ships a narrow
/// `sync-probe` cargo flag (209 resolved crates vs `fixtures`' 359), so the mirror is
/// deleted and this re-export keeps every `crate::common::sync_probe::SyncProbe`
/// import site unchanged.
///
/// `expect_event_for` and the frame-decoding tests the mirror had grown went UPSTREAM
/// with it rather than being dropped — see the SDK commit.
pub mod sync_probe {
    pub use txresbench_test_harness::fixtures::sync_probe::SyncProbe;
}

/// The seam `SyncProbe::open` needs: it builds the `/sync/subscribe` URL without the
/// fixture naming any app-side type.
impl txresbench_test_harness::ApiUrlTarget for TestServer {
    fn api_url(&self, path: &str) -> String {
        TestServer::api_url(self, path)
    }

    fn extra_headers(&self) -> Vec<(String, String)> {
        vec![("x-txr-local-key".to_string(), TEST_LOCAL_API_KEY.to_string())]
    }
}

/// The local-API key every test server runs with (`TXR_LOCAL_API_KEY`): the
/// server refuses requests without it, so every client the tests build sends it.
pub const TEST_LOCAL_API_KEY: &str = "txr-test-local-api-key-0123456789abcdef";

/// A client that sends the test server's local-API key on every request.
pub fn keyed_client() -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-txr-local-key",
        reqwest::header::HeaderValue::from_static(TEST_LOCAL_API_KEY),
    );
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .expect("keyed test client")
}

/// Thin wrapper over the engine's `SpawnedServer` — the handle tests hold. Drops
/// the server + per-test DB when it goes out of scope.
pub struct TestServer {
    inner: SpawnedServer,
    pub client: reqwest::Client,
}

impl TestServer {
    /// Boot a fresh isolated server (own per-test DB) and wait until healthy.
    pub async fn spawn() -> Self {
        Self::spawn_with(TestOptions::default()).await
    }

    /// [`spawn`](Self::spawn) with per-spawn knobs (see [`TestOptions`]).
    pub async fn spawn_with(opts: TestOptions) -> Self {
        let harness = TestHarness::new(
            CytoHarnessApp,
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            Variant::Server,
        );
        let inner = harness.start(opts).await;
        Self {
            inner,
            client: keyed_client(),
        }
    }

    /// A second client with the same key (a test that needs requests on a
    /// separate connection pool).
    pub fn new_client(&self) -> reqwest::Client {
        keyed_client()
    }

    /// Absolute URL for an API path (already `/api`-prefixed): `"/auth/me"` →
    /// `http://127.0.0.1:<port>/api/auth/me`.
    pub fn api_url(&self, path: &str) -> String {
        format!("{}/api{}", self.inner.base_url, path)
    }

    /// Absolute URL for a ROOT path (NOT `/api`-prefixed). The harness sentinel
    /// (`GET /__worktree`) is mounted at the root deliberately — it must answer on the
    /// same path the backend-free tiers' vite sentinel does, so `classifyOrigin` has ONE
    /// rule for every tier.
    pub fn root_url(&self, path: &str) -> String {
        format!("{}{}", self.inner.base_url, path)
    }

    /// The per-test database's NAME. Exposed so the harness's own lifecycle tests
    /// can ask the cluster whether it was reaped — the only question that
    /// distinguishes "the drop ran" from "the drop was scheduled and discarded".
    pub fn database_name(&self) -> &str {
        &self.inner.database_name
    }

    /// Connection URL for this test's isolated database — lets a test assert at
    /// the DB layer (e.g. a boot-crash-safety reset) via its own sqlx pool.
    /// General accessor over the harness's `SpawnedServer`.
    pub fn database_url(&self) -> &str {
        &self.inner.database_url
    }

    /// The spawned server's per-test isolated `app.data_dir` — lets a test seed
    /// the server's on-disk stores (e.g. write a content-addressed blob under
    /// `<data_dir>/workstore/blobs` that the server then range-serves).
    pub fn data_dir(&self) -> &std::path::Path {
        self.inner.data_dir()
    }
}

// ── the group seam ────────────────────────────────────────────────────────
//
// The `/groups` HTTP surface is stripped on this node (e38a55d), so group
// operations that tests used to drive over the wire go through the SDK user
// repositories instead — the same retained seam the account tests use. All of
// them run over the per-test DB pool (`pool_for` in each module).
pub async fn group_create(
    pool: &sqlx::SqlitePool,
    name: &str,
    permissions: Vec<String>,
) -> uuid::Uuid {
    let groups = txresbench_auth::user::GroupRepository::new(pool.clone());
    let group = groups
        .create(name, Some(String::new()), permissions)
        .await
        .expect("create group");
    group.id
}

pub async fn group_assign(pool: &sqlx::SqlitePool, user_id: uuid::Uuid, group_id: uuid::Uuid) {
    let users = txresbench_auth::user::UserRepository::new(pool.clone());
    users
        .assign_to_group(user_id, group_id, None)
        .await
        .expect("assign member to group");
}

/// Remove a user from the seeded `Users` group (the group every registered user
/// joins) — the repo substitute for `DELETE /groups/{user}/{group}/remove`.
pub async fn group_remove_from_users(pool: &sqlx::SqlitePool, user_id: uuid::Uuid) {
    let groups = txresbench_auth::user::GroupRepository::new(pool.clone());
    let users_group = groups
        .get_by_name("Users")
        .await
        .expect("look up the Users group")
        .expect("the seeded Users group exists");
    let users = txresbench_auth::user::UserRepository::new(pool.clone());
    users
        .remove_from_group(user_id, users_group.id)
        .await
        .expect("remove from the Users group");
}

// ─────────────────────────── test self-skip ledger ────────────────────────────
// Re-homed from `tests/dataset/hardening_common.rs` (strip-single-cell ITEM-3):
// the skip ledger is a general harness utility the kept sandbox tests use.

/// Where the self-skip ledger is written: `TXR_TEST_SKIP_LEDGER`, else
/// `<workspace>/target/test-skip-ledger.tsv`. Appended to, never truncated (the
/// suite runs many tests across threads and binaries) — clear it before a run.
pub fn skip_ledger_path() -> PathBuf {
    match std::env::var_os("TXR_TEST_SKIP_LEDGER") {
        Some(p) => PathBuf::from(p),
        // `CARGO_MANIFEST_DIR` = <workspace>/src-app/server.
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-skip-ledger.tsv"),
    }
}

/// Announce a self-skip on BOTH channels: the human `eprintln!` (visible only
/// under `--nocapture`) and the machine-readable ledger (survives libtest
/// capture, so a run's skips can be COUNTED). With `TXR_TEST_NO_SKIP=1` the gate
/// becomes a hard failure instead — the mode an acceptance tier runs in.
///
/// Call this from EVERY gate: a bare `eprintln!` skip is invisible by default and
/// reads as a PASS.
pub fn record_skip(test: &str, reason: &str) {
    let path = skip_ledger_path();
    eprintln!(
        "SKIP {test}: {reason} — self-skip, not the ignore attribute (also recorded in {})",
        path.display()
    );
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // O_APPEND: each line is one small `write(2)`, so concurrent test threads —
    // and concurrently-running test binaries — interleave lines, never bytes.
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let one_line: String = reason
            .chars()
            .map(|c| {
                if c == '\t' || c == '\n' || c == '\r' {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        let _ = writeln!(f, "{test}\t{one_line}");
    }
    if std::env::var("TXR_TEST_NO_SKIP").is_ok_and(|v| v == "1") {
        panic!(
            "SKIP {test}: {reason} — TXR_TEST_NO_SKIP=1 demands this tier ACTUALLY RUN, \
             so the skip is a hard failure"
        );
    }
}

// ─────────────────────── platform-capability helpers (Windows) ────────────────────
//
// The lead's Windows machine (an ARM64 VM) cannot run methods (no WSL and no
// published environment for arm64), has no Python 3 and no bash; a normal
// Windows PC (x64 + WSL) can. The helpers below make each affected test ONE
// line: on Windows a missing capability records the skip (`record_skip`) and
// the test returns early; on Linux/macOS (what the gate runs) the host has all
// three, so a would-be skip is a hard failure — the aggregate gate may never
// silently skip.

/// Records a Windows self-skip through [`record_skip`] (the ledger + the
/// stderr line; a bare `eprintln!` skip would read as a PASS), named by the
/// running test: libtest names each test's thread after the test. The test
/// then returns early. Referenced only from `#[cfg(windows)]` arms (on Linux
/// the gate panics instead of skipping), so this crate's Linux builds see it
/// as dead.
#[allow(dead_code)]
pub fn skip_reason(why: &str) {
    let thread = std::thread::current();
    record_skip(thread.name().unwrap_or("<unnamed test>"), why);
}

/// (A) Whether the built-in method list publishes an environment for this
/// machine's architecture — the same predicate the run classification reads
/// (`MethodList::env_for` → `EnvArch::host()`): on an ARM64 machine the
/// shipped list is amd64-only, so every `env_for`/`can_run`/`pick` answer is
/// `None` and methods can only classify `cannot_run`.
pub fn host_has_published_env() -> Result<(), String> {
    use txresbench::modules::execution_engine::envmanifest::EnvArch;
    let list = txresbench::modules::method_list::builtin();
    match EnvArch::host() {
        None => Err(
            "this machine's architecture is outside the published set (amd64 | arm64); \
             no method has a published environment here"
                .to_string(),
        ),
        Some(arch) => {
            if list.images.envs.iter().any(|e| e.arch == arch) {
                Ok(())
            } else {
                let mut published: Vec<&str> =
                    list.images.envs.iter().map(|e| e.arch.as_str()).collect();
                published.sort_unstable();
                published.dedup();
                Err(format!(
                    "no published environment for this machine type ({}); the built-in \
                     list publishes {}",
                    arch.as_str(),
                    published.join("/"),
                ))
            }
        }
    }
}

/// The local-owner session token (the owner carries the `"*"` permission
/// wildcard, so it passes every permission gate — the sandbox status routes
/// included).
pub async fn local_owner_token(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("local session");
    assert_eq!(resp.status().as_u16(), 200, "local session mints the owner");
    let body: serde_json::Value = resp.json().await.expect("session body");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("session carries a token")
        .to_string()
}

/// (B) Whether the spawned server reports the method stack as supported —
/// `GET /api/sandbox/envs`' `stack.supported` (`SandboxAvailability::Ready`).
/// Windows without WSL (the boot probe's `host_unsupported`), macOS without
/// the VM runtime and Linux without bwrap all report `false`, and a test that
/// must observe a METHOD actually RUN cannot pass there.
///
/// No test in the Windows failing set needs the B half alone — every one of
/// them is (A)-only (the faked/seeded drive never reaches the sandbox) — so
/// the probe is kept as the ready-made half of `skip_unless_methods_run!`
/// for a test that must see a method run through the real stack.
#[allow(dead_code)]
pub async fn server_stack_supported(server: &TestServer) -> Result<(), String> {
    let token = local_owner_token(server).await;
    let resp = server
        .client
        .get(server.api_url("/sandbox/envs"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("sandbox stack probe failed: {e}"))?;
    if resp.status().as_u16() != 200 {
        return Err(format!(
            "sandbox stack probe answered {}",
            resp.status().as_u16()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("sandbox stack body: {e}"))?;
    if body["stack"]["supported"] == serde_json::json!(true) {
        return Ok(());
    }
    let reason = body["stack"]["reason"]
        .as_str()
        .unwrap_or("its start-up check disabled them");
    Err(format!(
        "this server cannot run methods ({reason} — its start-up check disabled them)"
    ))
}

/// A usable Python 3 interpreter as the command to spawn: `TXR_TEST_PYTHON`
/// (a path or a wrapper) first, then `python3`, `python`, and on Windows the
/// `py -3` launcher — each must answer `--version` with a Python 3. `None` =
/// no Python 3 found. The same approach as the lib's
/// `pretrained_catalogue::install` test module (which the brief names as the
/// reference); this is the ONE integration-test copy.
pub fn python3() -> Option<Vec<String>> {
    let mut candidates: Vec<Vec<String>> = Vec::new();
    if let Ok(v) = std::env::var("TXR_TEST_PYTHON") {
        if !v.trim().is_empty() {
            candidates.push(vec![v]);
        }
    }
    candidates.push(vec!["python3".to_string()]);
    candidates.push(vec!["python".to_string()]);
    #[cfg(windows)]
    candidates.push(vec!["py".to_string(), "-3".to_string()]);
    for cmd in candidates {
        let out = std::process::Command::new(&cmd[0])
            .args(&cmd[1..])
            .arg("--version")
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                if text.to_ascii_lowercase().contains("python 3") {
                    return Some(cmd);
                }
            }
        }
    }
    None
}

/// The command [`python3`] resolved after `skip_unless_python3!` ran (it
/// panics on a non-Windows host, so this is never `None` past that check).
pub fn python3_cmd() -> Vec<String> {
    python3().unwrap_or_else(|| {
        panic!(
            "no Python 3 interpreter found — the call site must run \
             skip_unless_python3!() (or set TXR_TEST_PYTHON)"
        )
    })
}

/// Whether `bash` answers on PATH (a repo shell script can be run). Referenced
/// only from `skip_unless_bash!`'s `#[cfg(windows)]` arm (on Linux/macOS a
/// missing bash keeps failing at the spawn, exactly as before).
#[allow(dead_code)]
pub fn bash_on_path() -> bool {
    std::process::Command::new("bash")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// One-line gate for (A): the host must have a published environment.
#[macro_export]
macro_rules! skip_unless_host_env {
    () => {{
        if let Err(why) = $crate::common::host_has_published_env() {
            #[cfg(windows)]
            {
                $crate::common::skip_reason(&why);
                return;
            }
            #[cfg(not(windows))]
            {
                panic!("the gate host must have a published environment for its architecture, but: {why}");
            }
        }
    }};
}

/// One-line gate for (A)+(B): the host must have a published environment AND
/// the spawned server must report the method stack as supported (a test that
/// observes a method actually running).
#[macro_export]
macro_rules! skip_unless_methods_run {
    ($server:expr) => {{
        $crate::skip_unless_host_env!();
        if let Err(why) = $crate::common::server_stack_supported(&$server).await {
            #[cfg(windows)]
            {
                $crate::common::skip_reason(&why);
                return;
            }
            #[cfg(not(windows))]
            {
                panic!("the gate server must report the method stack as supported, but: {why}");
            }
        }
    }};
}

/// One-line gate for (C): a Python 3 interpreter must exist.
#[macro_export]
macro_rules! skip_unless_python3 {
    () => {{
        if $crate::common::python3().is_none() {
            #[cfg(windows)]
            {
                $crate::common::skip_reason(
                    "no Python 3 interpreter on this machine (the generator/packer is a Python tool)",
                );
                return;
            }
            #[cfg(not(windows))]
            panic!("no Python 3 interpreter on this machine (the generator/packer is a Python tool)");
        }
    }};
}

/// One-line gate for (D): a repo shell script can only run when `bash` is on
/// PATH. Windows-only: on Linux/macOS the gate host has bash, and a missing
/// one must keep failing loudly at the spawn exactly as today.
#[macro_export]
macro_rules! skip_unless_bash {
    () => {{
        #[cfg(windows)]
        if !$crate::common::bash_on_path() {
            $crate::common::skip_reason(
                "no bash/sh on PATH (the repo shell script cannot run on this machine)",
            );
            return;
        }
    }};
}


