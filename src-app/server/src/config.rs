//! Config loading — a thin wrapper over the SDK's `ServerConfig` loader.
//!
//! Was SDK_GAPS G2 (a ~40-line reimplementation): the SDK now ships
//! `ServerConfig::load_from` / `::load` (CONFIG_FILE discovery + weak-`jwt.secret`
//! refusal), so this just picks explicit-path vs discovery.
//!
//! **App-side `secrets.storage_key` (#60).** The SDK `ServerConfig` (a FROZEN
//! submodule pin) has no `secrets` field, and serde ignores the extra top-level
//! key, so the at-rest secret storage key is parsed HERE (app-side) from the same
//! config file, with a `CYTO_SECRET_STORAGE_KEY` env override. It is initialized
//! once at boot via `ziee_framework::secrets::init_storage_key` (see `lib.rs`).
//! Unset ⇒ compat mode (no DB secret encryption; env fallback).
//!
//! **App-side DB target (sqlite-store ITEM-5).** The SDK `ServerConfig` parses
//! the `database:` block (URL/path + pool knobs); the resolution CHAIN — env
//! override > block URL > block path > default app-data-dir file — is the app
//! bootstrap's concern (DEC-13), and lives here as pure functions so it is
//! pinned by the item's unit tests and consumed by `database.rs` at the driver
//! flip (ITEM-12). The transition contract (DEC-17) also lives here: a config
//! that still selects the legacy embedded-Postgres leg produces the hard boot
//! refusal message.

use serde::Deserialize;
use ziee_core::ServerConfig;

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

/// Env var overriding `secrets.storage_key` (12-factor). Takes precedence over the
/// config file when set + non-empty.
pub const STORAGE_KEY_ENV: &str = "CYTO_SECRET_STORAGE_KEY";

/// Env var overriding the DB target (12-factor). Takes precedence over the
/// config file's `database:` block when set + non-empty — the same shape as
/// [`STORAGE_KEY_ENV`] and the SDK's own `CONFIG_FILE` discovery.
pub const DATABASE_URL_ENV: &str = "CYTO_DATABASE_URL";

/// Default SQLite database file name inside the app-data dir. Kept in sync
/// with the plan's `<app-data-dir>/txresbench.db` (DEC-13 / PROV-sqlite-store-1).
pub const DEFAULT_DB_FILE_NAME: &str = "txresbench.db";

/// App-side secrets config: the at-rest encryption key for the pgcrypto secret
/// columns. A DEPLOYMENT secret (like `jwt.secret`) — fixed via config, NOT
/// admin-configurable. `None` ⇒ compat mode.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AppSecretsConfig {
    /// pgcrypto symmetric key for `encrypt_secret`/`decrypt_secret` (≥32 chars, else
    /// the SDK helpers refuse to use it). `None`/absent ⇒ compat mode.
    #[serde(default)]
    pub storage_key: Option<String>,
}

/// The `secrets:` wrapper deserialized from the config file. Every field defaults,
/// so a config with no `secrets:` block parses cleanly to an empty config.
#[derive(Debug, Clone, Default, Deserialize)]
struct SecretsFileShape {
    #[serde(default)]
    secrets: AppSecretsConfig,
}

/// Load + validate the server config: an explicit `--config-file`, else SDK
/// discovery (`$CONFIG_FILE` → `config/dev.yaml`).
pub fn load_config(explicit: Option<&str>) -> Result<ServerConfig, BoxErr> {
    match explicit {
        Some(path) => ServerConfig::load_from(std::path::Path::new(path)),
        None => ServerConfig::load(),
    }
}

/// Resolve the at-rest secret storage key for THIS process. The
/// `CYTO_SECRET_STORAGE_KEY` env override wins; otherwise the discovered config
/// file's `secrets.storage_key`. `None` ⇒ compat mode. A parse failure is
/// non-fatal (returns `None` + logs) — an unreadable `secrets:` block must never
/// crash boot, it simply falls back to compat mode.
pub fn resolve_storage_key(explicit: Option<&str>) -> Option<String> {
    if let Ok(v) = std::env::var(STORAGE_KEY_ENV) {
        let v = v.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    let path = match explicit.map(std::path::PathBuf::from) {
        Some(p) => Some(p),
        None => ServerConfig::discover(),
    }?;
    let content = std::fs::read_to_string(&path).ok()?;
    match serde_norway::from_str::<SecretsFileShape>(&content) {
        Ok(shape) => shape
            .secrets
            .storage_key
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "failed to parse `secrets:` from config; running in compat mode (no at-rest \
                 secret encryption)"
            );
            None
        }
    }
}

/// Resolve the SQLite DB target this process must open.
///
/// Returns a value the sqlite bootstrap accepts verbatim: a `sqlite://` URL or
/// a plain filesystem path (the framework's `embedded_db` handles both
/// spellings). Precedence, highest first:
///
/// 1. [`DATABASE_URL_ENV`] — the 12-factor override, when set + non-empty
///    (mirrors [`STORAGE_KEY_ENV`]);
/// 2. the `database:` block's `url` — a `sqlite://` URL; the preferred
///    spelling when it and `path` are both set (they are two forms of one
///    value);
/// 3. the `database:` block's `path` — a plain filesystem path;
/// 4. `<default_db_dir>/txresbench.db` — the app-data-dir location
///    (`CYTO_APP_DATA_DIR` / `get_app_data_dir()`; `~/.txresbench` for the
///    desktop once the app name is set).
///
/// `default_db_dir` is the caller's already-resolved app data dir (the app
/// passes `modules::rootfs::data_root()`); this function stays pure so the
/// chain is unit-testable without the module tree.
pub fn resolve_database_target(config: &ServerConfig, default_db_dir: &std::path::Path) -> String {
    if let Ok(v) = std::env::var(DATABASE_URL_ENV) {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return v;
        }
    }
    config.sqlite_database_url().unwrap_or_else(|| {
        default_db_dir
            .join(DEFAULT_DB_FILE_NAME)
            .to_string_lossy()
            .into_owned()
    })
}

/// The hard boot refusal for a config that still carries a `postgresql:` block
/// (ITEM-26: the compat parse is DROPPED — every block is refused, loudly,
/// not just `use_embedded: true`). `None` ⇒ no block ⇒ legal.
///
/// Deliberate (DEC-17 / PROV-sqlite-store-7): the app ships no Postgres engine
/// anymore; the block is dead configuration and an operator who set it had a
/// PG data dir the app cannot migrate (DEC-3). The ITEM-12 transition window
/// accepted `use_embedded: false` with a boot warning; it is over — the boot
/// error names the key and the replacement, and the transition message is
/// gone (a block is never merely "loud but accepted").
pub fn postgresql_block_refusal(config: &ServerConfig) -> Option<String> {
    config.postgresql.as_ref()?;
    Some(
        "config still carries a `postgresql:` block: this build runs on the embedded SQLite \
         store (a single local file, no server process, no network). Remove the block; the \
         `database:` block configures the store and defaults to \
         <app-data-dir>/txresbench.db. Existing Postgres data cannot be migrated — delete \
         its data directory and let the app boot fresh."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-7 [covers: ITEM-2]: parse `secrets.storage_key` from a YAML string.
    #[test]
    fn parses_storage_key_from_yaml() {
        let yaml = "jwt:\n  secret: x\nsecrets:\n  storage_key: \"a-32-char-minimum-storage-key-value!!\"\n";
        let shape: SecretsFileShape = serde_norway::from_str(yaml).unwrap();
        assert_eq!(
            shape.secrets.storage_key.as_deref(),
            Some("a-32-char-minimum-storage-key-value!!")
        );
    }

    // TEST-7 [covers: ITEM-2]: an absent `secrets:` block ⇒ None (compat mode).
    #[test]
    fn absent_secrets_block_is_none() {
        let yaml = "jwt:\n  secret: x\n";
        let shape: SecretsFileShape = serde_norway::from_str(yaml).unwrap();
        assert!(shape.secrets.storage_key.is_none());
    }

    // TEST-7 [covers: ITEM-2]: the env override wins over the config file. Uses a
    // unique var name to avoid cross-test races; asserts the precedence branch.
    #[test]
    fn env_override_takes_precedence() {
        // The env branch is checked BEFORE the file, so a set env var short-circuits.
        // (We assert the pure precedence logic without mutating the shared var name.)
        std::env::set_var(STORAGE_KEY_ENV, "env-provided-storage-key-32-characters!!");
        let got = resolve_storage_key(None);
        std::env::remove_var(STORAGE_KEY_ENV);
        assert_eq!(got.as_deref(), Some("env-provided-storage-key-32-characters!!"));
    }
}

/// TEST-13 (sqlite-store ITEM-5 + ITEM-26): the app-side `database:` config
/// surface — block parse (url wins over path; defaults for pool), the
/// `CYTO_DATABASE_URL` override precedence, the default app-data-dir target,
/// and the boot refusal message for a config that still carries ANY
/// `postgresql:` block (ITEM-26 dropped the accepted-with-warning leg).
#[cfg(test)]
mod database_target_tests {
    use super::*;
    use std::sync::Mutex;

    const STRONG_SECRET: &str = "0123456789abcdef0123456789abcdef-strong";

    /// Serializes tests that mutate `CYTO_DATABASE_URL` (env vars are process-
    /// global; a second test reading the var mid-mutation would be flaky).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// An app-shaped config (the extra `secrets:`/`memory:` keys the SDK ignores)
    /// with the runner's `database:` block (empty = no block). Post-flip shape:
    /// NO `postgresql:` block (ITEM-12/ITEM-26).
    fn app_yaml(database_block: &str) -> String {
        format!(
            "{database}server:\n  host: 127.0.0.1\n  port: 3100\n  api_prefix: /api\nlogging:\n  level: info\n  format: pretty\njwt:\n  secret: '{SECRET}'\n  issuer: app\n  audience: app-api\n  access_token_expiry_hours: 24\nsecrets:\n  storage_key: null\n",
            database = database_block,
            SECRET = STRONG_SECRET
        )
    }

    /// The REFUSAL shape: an app-shaped config that still carries a
    /// `postgresql:` block (embedded leg by default; pass `use_embedded=false`
    /// for the external-PG variant). ITEM-26 refuses both.
    fn app_yaml_with_postgresql(use_embedded: bool) -> String {
        format!(
            "postgresql:\n  use_embedded: {use_embedded}\n  embedded:\n    version: '18.3.0'\n    port: 54341\n    bind_address: 127.0.0.1\n    username: postgres\n    password: pw\n    database: postgres\n    timezone: UTC\n    log_timezone: UTC\n    logging:\n      collector: false\n      directory: log\n      filename: pg.log\n      statement: none\ndatabase:\n  path: /data/app.db\nserver:\n  host: 127.0.0.1\n  port: 3100\n  api_prefix: /api\nlogging:\n  level: info\n  format: pretty\njwt:\n  secret: '{SECRET}'\n  issuer: app\n  audience: app-api\n  access_token_expiry_hours: 24\n",
            use_embedded = use_embedded,
            SECRET = STRONG_SECRET
        )
    }

    #[test]
    fn database_block_url_wins_over_path_and_pool_defaults_to_profile() {
        let _guard = ENV_LOCK.lock().unwrap();
        let yaml =
            app_yaml("database:\n  path: /tmp/from-path.db\n  url: sqlite:///tmp/from-url.db\n");
        let cfg: ServerConfig = serde_norway::from_str(&yaml).expect("app config parses");
        let db = cfg.database.as_ref().expect("database block present");
        assert_eq!(db.url.as_deref(), Some("sqlite:///tmp/from-url.db"));
        assert_eq!(db.path.as_deref(), Some("/tmp/from-path.db"));
        // url wins over path (both spellings present).
        assert_eq!(
            cfg.sqlite_database_url().as_deref(),
            Some("sqlite:///tmp/from-url.db")
        );
        assert_eq!(
            resolve_database_target(&cfg, std::path::Path::new("/data/app")),
            "sqlite:///tmp/from-url.db"
        );
        // The pool knobs default to the framework profile (10 / 1 / 5 s / 5000 ms).
        let pool = &db.pool;
        assert_eq!(pool.max_connections, 10);
        assert_eq!(pool.min_connections, 1);
        assert_eq!(pool.acquire_timeout_secs, 5);
        assert_eq!(pool.busy_timeout_ms, 5000);
    }

    #[test]
    fn database_path_is_used_when_url_is_absent() {
        let _guard = ENV_LOCK.lock().unwrap();
        let yaml = app_yaml(&format!(
            "database:\n  path: /home/user/txresbench/app.db\n  pool:\n    max_connections: 3\n    busy_timeout_ms: 100\n"
        ));
        let cfg: ServerConfig = serde_norway::from_str(&yaml).expect("app config parses");
        assert_eq!(
            resolve_database_target(&cfg, std::path::Path::new("/data/app")),
            "/home/user/txresbench/app.db"
        );
        // An explicit pool block overrides the baked-in defaults, field by field.
        let pool = &cfg.database.as_ref().unwrap().pool;
        assert_eq!(pool.max_connections, 3);
        assert_eq!(pool.min_connections, 1); // untouched -> default
        assert_eq!(pool.busy_timeout_ms, 100);
    }

    #[test]
    fn cyto_database_url_env_overrides_the_database_block() {
        let _guard = ENV_LOCK.lock().unwrap();
        let yaml = app_yaml("database:\n  url: sqlite:///from-config.db\n");
        let cfg: ServerConfig = serde_norway::from_str(&yaml).expect("app config parses");
        std::env::set_var(DATABASE_URL_ENV, "sqlite:///from-env.db");
        let resolved = resolve_database_target(&cfg, std::path::Path::new("/data/app"));
        std::env::remove_var(DATABASE_URL_ENV);
        assert_eq!(resolved, "sqlite:///from-env.db");
    }

    #[test]
    fn empty_env_value_does_not_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        let yaml = app_yaml("database:\n  path: /from-config/app.db\n");
        let cfg: ServerConfig = serde_norway::from_str(&yaml).expect("app config parses");
        std::env::set_var(DATABASE_URL_ENV, "   ");
        let resolved = resolve_database_target(&cfg, std::path::Path::new("/data/app"));
        std::env::remove_var(DATABASE_URL_ENV);
        assert_eq!(resolved, "/from-config/app.db");
    }

    #[test]
    fn default_target_is_the_app_data_dir_file() {
        let _guard = ENV_LOCK.lock().unwrap();
        let yaml = app_yaml("");
        let cfg: ServerConfig = serde_norway::from_str(&yaml).expect("app config parses");
        assert!(cfg.database.is_none(), "no database block -> None");
        assert_eq!(
            resolve_database_target(&cfg, std::path::Path::new("/home/user/.txresbench")),
            "/home/user/.txresbench/txresbench.db"
        );
    }

    #[test]
    fn any_postgresql_block_is_refused_with_a_loud_message() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Both the embedded leg and the external-PG leg are refused: the
        // ITEM-12 accepted-with-warning transition is over (ITEM-26).
        for use_embedded in [true, false] {
            let yaml = app_yaml_with_postgresql(use_embedded);
            let cfg: ServerConfig = serde_norway::from_str(&yaml).expect("app config parses");
            let msg = postgresql_block_refusal(&cfg)
                .unwrap_or_else(|| panic!("use_embedded={use_embedded}: a postgresql block is refused"));
            assert!(msg.contains("postgresql"), "names the offending key: {msg}");
            assert!(
                msg.contains("SQLite"),
                "the message names the new engine: {msg}"
            );
            assert!(
                msg.contains("database"),
                "the message names the replacement block: {msg}"
            );
        }
    }

    #[test]
    fn an_absent_postgresql_block_is_legal() {
        let _guard = ENV_LOCK.lock().unwrap();
        // No postgresql block at all (the sqlite-shaped config) is legal — the
        // refusal returns None and the app boots on the `database:` store.
        let sqlite_yaml = format!(
            "database:\n  path: /data/app.db\nserver:\n  host: 127.0.0.1\n  port: 3100\n  api_prefix: /api\njwt:\n  secret: '{STRONG_SECRET}'\n  issuer: app\n  audience: app-api\n  access_token_expiry_hours: 24\n"
        );
        let cfg: ServerConfig =
            serde_norway::from_str(&sqlite_yaml).expect("sqlite app config parses");
        assert!(cfg.postgresql.is_none());
        assert!(postgresql_block_refusal(&cfg).is_none());
    }

    #[test]
    fn env_override_is_honored_byte_for_byte() {
        let _guard = ENV_LOCK.lock().unwrap();
        let yaml = app_yaml("");
        let cfg: ServerConfig = serde_norway::from_str(&yaml).expect("app config parses");
        // An operator override spelled as a plain path must pass through
        // unchanged — the bootstrap accepts both spellings.
        std::env::set_var(DATABASE_URL_ENV, "/var/lib/txr/app.db");
        let resolved = resolve_database_target(&cfg, std::path::Path::new("/data/app"));
        std::env::remove_var(DATABASE_URL_ENV);
        assert_eq!(resolved, "/var/lib/txr/app.db");
    }

    /// The three actually-shipped configs parse through the app's loader in
    /// their post-flip shape: `database:` present (example values null, pool
    /// defaults), NO `postgresql:` block — ITEM-12's flip dropped it
    /// (PROV-sqlite-store-7, DEC-17), and ITEM-26 makes a lurking one a hard
    /// refusal rather than a warning.
    #[test]
    fn shipped_configs_parse_sqlite_shaped_after_the_flip() {
        for rel in [
            "config/dev.example.yaml",
            "config/dev-live.yaml",
            "config/e2e.yaml",
        ] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
            let cfg = ServerConfig::load_from(&path)
                .unwrap_or_else(|e| panic!("shipped config {rel} fails to parse: {e}"));
            let db = cfg.database.as_ref().unwrap_or_else(|| {
                panic!("shipped config {rel} must carry the database: block")
            });
            assert!(db.url.is_none() && db.path.is_none(), "{rel}: example values are null");
            assert_eq!(db.pool.max_connections, 10, "{rel}");
            assert!(
                cfg.postgresql.is_none(),
                "{rel}: the postgresql block is dropped by the flip"
            );
        }
    }
}
