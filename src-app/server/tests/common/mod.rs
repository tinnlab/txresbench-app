//! CytoAnalyst integration-test harness — the app side of the SDK's
//! `ziee-test-harness` `HarnessApp` seam.
//!
//! The SDK crate owns the generic engine (per-worktree template, per-test
//! database, spawn + readiness + teardown). CytoAnalyst supplies ONE `HarnessApp`
//! impl (binary name, template-DB base, migration dirs, rendered config) plus a
//! thin `TestServer` wrapper that re-exposes `base_url`/`api_url` + HTTP helpers.
//!
//! The engine runs the sqlite leg (a `sqlite://` `DATABASE_URL`, which is what
//! `.cargo/config.toml` ships): the per-test database is a FILE copied from a
//! fully-migrated template file, rendered into the config as `database.url`.
//! No Postgres cluster, no `DATABASE_URL`-reaching server — only the temp dir.

use std::path::{Path, PathBuf};

use ziee_test_harness::{HarnessApp, SpawnFacts, SpawnPlan, SpawnedServer, TestHarness, Variant};

/// The suite's reader for what a processor emitted. Here rather than beside one
/// caller because two test modules in different trees need it, and a second copy of a
/// decoder is how two tests start disagreeing about the same bytes.
#[allow(dead_code)]
pub mod zarr;

/// B0 — the local Stripe sim harness (signed-webhook injector + reference verifier +
/// placeholder webhook consumer + meter-event capture stand-in). TEST-ONLY; carries
/// its own `#[cfg(test)]` self-tests (the INV-2 acceptance proof). Some of its public
/// surface is consumed only by `tests/billing/` (the L2 tier), so `dead_code` is
/// allowed here like `zarr` above — the shape is deliberately broader than any one
/// caller so B2/B3 can build on it without re-forking.
#[allow(dead_code)]
pub mod stripe_sim;

/// The test binary's ONE process-wide blob store. `workstore`'s store handle and
/// ownership claim are WRITE-ONCE process statics — a boot-time fact for a server,
/// shared mutable state for a 440-test binary — so the harness owns them rather than
/// letting each test install (and then delete) its own. See the module docs for the
/// failure this prevents.
pub mod object_store;

/// CytoAnalyst's `HarnessApp`. Server-only (no desktop test crate yet).
pub struct CytoHarnessApp;

/// The fixed bytes of every pre-staged method-env squashfs
/// ([`TestOptions::prestage_method_envs`]). The bytes are deliberately
/// NOT a real rootfs: the record's purpose is the manager's `ready` +
/// cache-entry load rule (so `DELETE /envs/{id}?prune=true` has a real 204
/// target with a real digest), not a mountable artifact — nothing in the
/// boot/test path mounts it.
pub const PRESTAGED_METHOD_ENV_SQUASHFS: &[u8] = b"txr-prestaged-method-env-squashfs-bytes";

/// Per-spawn knobs. Grow as tests need config overrides (mirrors ziee's
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
    /// (`CYTO_BILLING_ROLLUP_TICK_MS`, a debug-only seam compiled out of release
    /// builds — mirrors `SYNC_RECHECK_TICK_MS`). Production ticks every
    /// `rollup_interval_hours` (≥1h); a test that must observe a fold+emit after
    /// seeding meter rows sets this to a few hundred ms instead of waiting an hour.
    /// `saas`-only (the rollup loop is gated on the feature); ignored otherwise.
    pub billing_rollup_tick_ms: Option<u64>,

    /// Override the billing usage-alert ladder loop's tick period, in milliseconds
    /// (`CYTO_BILLING_ALERT_TICK_MS`, a debug-only seam compiled out of release builds —
    /// mirrors `billing_rollup_tick_ms`). A test that must observe an alert emit after
    /// seeding a rollup row sets this to a few hundred ms. `saas`-only.
    pub billing_alert_tick_ms: Option<u64>,

    /// Gate the spawned server's job scheduler loop (T3 / G2 / PROV-T3-2). `None` (default)
    /// leaves `CYTO_SCHEDULER_ENABLED` unset → the loop runs (single-box default). `Some(false)`
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

    /// Set the at-rest secret storage key (`CYTO_SECRET_STORAGE_KEY`, #60) for the
    /// spawned server, enabling ENCRYPTED billing-integration storage. `None` (default)
    /// leaves it unset → compat mode (no DB secret storage; env fallback). A test that
    /// must exercise encrypt-at-rest / masked-read sets a ≥32-char key here. Mirrors the
    /// other opt-in env knobs above.
    pub secret_storage_key: Option<String>,

    /// Point the spawned server's pretrained-catalogue boot refresh at this
    /// catalogue URL (`CYTO_TXR_CATALOGUE_URL` — the module's documented
    /// default-resolution seam). `None` (default) defaults to a CLOSED
    /// loopback port: the boot refresh fails instantly without network, so
    /// every spawned server boots offline-fast and no test suite dials the
    /// production catalogue host. A test that must serve a live catalogue
    /// sets its own loopback URL here.
    pub catalogue_url: Option<String>,

    /// Point the spawned server's pretrained bundled-models dir at this
    /// directory (`CYTO_TXR_BUNDLED_MODELS_DIR` — the module's documented
    /// bundle-layout resolution). `None` (default) leaves the env unset →
    /// `<data_dir>/pretrained-bundled`. A test that must exercise the
    /// bundled install source (TEST-PC-07/23) writes its fixture `.txr` here
    /// before the spawn.
    pub pretrained_bundled_dir: Option<PathBuf>,
}

impl HarnessApp for CytoHarnessApp {
    type Options = TestOptions;

    fn template_db_base(&self, _variant: Variant) -> String {
        // The engine appends the per-worktree suffix so concurrent worktrees
        // never clobber each other's template.
        "cytoanalyst_test_template".to_string()
    }

    fn migration_dirs(&self, _variant: Variant, manifest_dir: &Path) -> Vec<PathBuf> {
        // build.rs composes the app + ziee-auth migrations here.
        vec![manifest_dir.join("migrations-merged")]
    }

    fn plan_spawn(&self, opts: &Self::Options, facts: &SpawnFacts) -> SpawnPlan {
        // The sqlite leg hands the app the per-test FILE's connection URL (the
        // harness copied it from the migrated template and owns its lifecycle);
        // `database.url` is exactly the config key `ServerConfig` resolves.
        // The postgresql block is GONE from the app's config surface — the app
        // is single-driver (sqlite) under this node.
        let config_yaml = format!(
            r#"
app:
  data_dir: '{data_dir}'

database:
  url: "{database_url}"

server:
  host: "127.0.0.1"
  port: {server_port}
  api_prefix: "/api"
  trust_forwarded_headers: false

logging:
  level: "warn"
  format: "pretty"

jwt:
  secret: "test-secret-key-for-jwt-tokens-min-32-chars-long"
  issuer: "cytoanalyst"
  audience: "cytoanalyst-api"
  access_token_expiry_hours: 24
  refresh_token_expiry_days: 30
"#,
            data_dir = facts.data_dir.display(),
            database_url = facts.database_url,
            server_port = facts.server_port,
        );

        if let Some(slot) = &opts.observed_database_name {
            *slot.lock().expect("observed-db-name slot") = Some(facts.database_name.to_string());
        }

        SpawnPlan {
            config_yaml,
            binary_name: if opts.break_binary_name {
                "cytoanalyst-no-such-binary".to_string()
            } else {
                "cytoanalyst".to_string()
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
                        if !cytoanalyst::modules::sandbox::env_id::is_valid_env_id(env_id) {
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
                let mut env = vec![(
                    "CYTO_APP_DATA_DIR".to_string(),
                    facts.data_dir.display().to_string(),
                )];
                if let Some(ms) = opts.sync_recheck_tick_ms {
                    env.push(("SYNC_RECHECK_TICK_MS".to_string(), ms.to_string()));
                }
                if let Some(on) = opts.scheduler_enabled {
                    env.push((
                        "CYTO_SCHEDULER_ENABLED".to_string(),
                        if on { "1" } else { "0" }.to_string(),
                    ));
                }
                if let Some(ms) = opts.billing_rollup_tick_ms {
                    env.push(("CYTO_BILLING_ROLLUP_TICK_MS".to_string(), ms.to_string()));
                }
                if let Some(ms) = opts.billing_alert_tick_ms {
                    env.push(("CYTO_BILLING_ALERT_TICK_MS".to_string(), ms.to_string()));
                }
                if let Some(key) = &opts.secret_storage_key {
                    env.push(("CYTO_SECRET_STORAGE_KEY".to_string(), key.clone()));
                }
                // The pretrained-catalogue boot refresh (a detached task) must
                // never dial the production catalogue host from a test suite:
                // the default is a CLOSED loopback port (instant refusal), a
                // test that needs a live catalogue passes its own URL.
                env.push((
                    "CYTO_TXR_CATALOGUE_URL".to_string(),
                    opts.catalogue_url
                        .clone()
                        .unwrap_or_else(|| "http://127.0.0.1:9/catalogue.json".to_string()),
                ));
                // The same for the pretrained bundled-models dir: a test that
                // must exercise the bundled install source passes its own
                // layout (the module's documented env seam).
                if let Some(dir) = &opts.pretrained_bundled_dir {
                    env.push((
                        "CYTO_TXR_BUNDLED_MODELS_DIR".to_string(),
                        dir.display().to_string(),
                    ));
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
}

// ───────────────── the test process's own "boot": process-global registries ─────
//
// WHY THIS LIVES IN THE HARNESS AND NOT IN ONE TEST MODULE.
//
// The server under test is a SUBPROCESS (`SpawnPlan::binary_name`), so its
// boot-time `extensions::init` publishes the extension + datatype registries in
// ITS address space, not ours. Anything a test calls IN-PROCESS
// (`env_image::default_env_id`, `processors::resolve_with_package`,
// `workstore::ingest`'s typing validation, …) reads the TEST process's globals,
// which nothing published unless some test module happened to.
//
// That "happened to" is a defect generator, and it has now produced two verdict
// inversions in a row:
//
//   * the DATATYPE registry — published only by `datatype::mod`, so
//     `workstore::axis_identity_test` ran with `ingest`'s typing validator ON or
//     OFF depending on which other module shared the invocation (round 13);
//   * the EXTENSION registry — published only by `analysis::mod`, so
//     `dataset::capsule_cross_version_test` (TEST-68, acceptance) EXECUTED with
//     an `analysis::*` neighbour in the selector and SELF-SKIPPED without one,
//     because `env_image::default_env_id()` resolves the env-id off that registry
//     (round 14).
//
// Both were the same shape: process-global state published by exactly ONE module,
// so a test's verdict is a function of its neighbours. Fixing the affected test
// only relocates the hole — the next in-process reader re-opens it, silently.
// The mechanism dies here for the EXTENSION registry instead: `TestServer::spawn`
// is this process's boot, so every server-using test sees that registry exactly as
// production does, whatever the selector. A test with no server still opts in by
// calling [`ensure_extension_registry`] directly (`analysis::stage_code_dir` does).
//
// The class-fix is enforced rather than trusted: `dataset::hardening_common::
// stage_second_env_image` treats an ABSENT extension registry as a HARNESS FAULT
// and panics, instead of folding it into an environmental self-skip. If this
// publication is ever removed, that acceptance test goes RED and names this
// function — it cannot go quiet again.
//
// STILL OWNED BY ONE MODULE, deliberately: the DATATYPE registry
// (`datatype::mod::test22_ingest_validates_each_output_against_registry`). Publishing
// it here would switch `workstore::ingest`'s typing validator ON for the ~8 test files
// that call `ingest_run_outputs` in-process — a behaviour change wider than the defect
// it would close, and measured NOT to be flipping any verdict today (`workstore::
// {schema_shape,conformance_gate,zarr_store}_test` + `dataset::process_test` were run
// with and without `datatype::test22_ingest` in the selector: 16/16 and 17/17, same
// set). It is a latent instance of this class, not a live one — if a verdict is ever
// found to turn on it, publish it here alongside the extension registry rather than
// hardening the affected test.

/// The repo's processors root — the same folder layout `sandbox::processors::resolve_in`
/// scans in production (there it is the extracted seed; here it is the working tree, so an
/// edit to a compute script is exercised without a rebuild).
pub fn processors_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../packages")
        .canonicalize()
        .unwrap_or_else(|e| panic!("locate the processors root: {e}"))
}

/// Publish the process-global EXTENSION registry the way boot does, once per test
/// binary, so in-process production code (`env_image::default_env_id`,
/// `processors::resolve_with_package`, …) resolves against the same contributed
/// manifests the running server does.
///
/// Built from the WORKING TREE — the same folder `analysis::stage_code_dir`
/// resolves against — so a manifest edit is exercised without re-baking the seed.
///
/// Never overwrites: a test module that owns the registry for its own fixture
/// (`extensions::*` builds bespoke ones) keeps it.
pub fn ensure_extension_registry() {
    use std::sync::OnceLock;
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        use cytoanalyst::modules::extensions::{loader, ExtensionRegistry};
        if loader::try_registry().is_some() {
            return;
        }
        match ExtensionRegistry::build_from_dir(&processors_root()) {
            Ok(reg) => loader::set_global_registry(std::sync::Arc::new(reg)),
            // A tree that will not fold is not this helper's failure to report:
            // in-process resolution then behaves as it does in any registry-less
            // context, and the acceptance test that REQUIRES the registry
            // (`stage_second_env_image`) fails loudly rather than self-skipping.
            Err(e) => eprintln!("test harness: extension registry did not build: {e}"),
        }
    });
}
/// The SSE sync probe, imported FROM THE SDK.
///
/// This was a 258-line hand-rolled mirror of `ziee_test_harness`'s own
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
    pub use ziee_test_harness::fixtures::sync_probe::SyncProbe;
}

/// The seam `SyncProbe::open` needs: it builds the `/sync/subscribe` URL without the
/// fixture naming any app-side type.
impl ziee_test_harness::ApiUrlTarget for TestServer {
    fn api_url(&self, path: &str) -> String {
        TestServer::api_url(self, path)
    }
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
        // This process's half of "boot" — see the block comment above. Cheap
        // (once per binary) and ordered BEFORE the server so a test that reads a
        // registry between `spawn()` and its first request still sees it.
        ensure_extension_registry();
        let harness = TestHarness::new(
            CytoHarnessApp,
            PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            Variant::Server,
        );
        let inner = harness.start(opts).await;
        Self {
            inner,
            client: reqwest::Client::new(),
        }
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
    let groups = ziee_auth::user::GroupRepository::new(pool.clone());
    let group = groups
        .create(name, Some(String::new()), permissions)
        .await
        .expect("create group");
    group.id
}

pub async fn group_assign(pool: &sqlx::SqlitePool, user_id: uuid::Uuid, group_id: uuid::Uuid) {
    let users = ziee_auth::user::UserRepository::new(pool.clone());
    users
        .assign_to_group(user_id, group_id, None)
        .await
        .expect("assign member to group");
}

pub async fn group_deactivate(pool: &sqlx::SqlitePool, group_id: uuid::Uuid) {
    let groups = ziee_auth::user::GroupRepository::new(pool.clone());
    groups
        .update(group_id, None, None, None, Some(false))
        .await
        .expect("deactivate group");
}

/// Remove a user from the seeded `Users` group (the group every registered user
/// joins) — the repo substitute for `DELETE /groups/{user}/{group}/remove`.
pub async fn group_remove_from_users(pool: &sqlx::SqlitePool, user_id: uuid::Uuid) {
    let groups = ziee_auth::user::GroupRepository::new(pool.clone());
    let users_group = groups
        .get_by_name("Users")
        .await
        .expect("look up the Users group")
        .expect("the seeded Users group exists");
    let users = ziee_auth::user::UserRepository::new(pool.clone());
    users
        .remove_from_group(user_id, users_group.id)
        .await
        .expect("remove from the Users group");
}
