//! The desktop's embedded-server config, built in code.
//!
//! Single-user desktop: the SQLite store under the OS home dir (`~/.txresbench`
//! — the SDK derives the default app-data dir from the app name set here; the
//! stale `~/.cytoanalyst` branding is gone), an ephemeral HTTP port (bound with
//! `:0`, the real port read back from `local_addr`), and a per-install JWT
//! secret persisted next to the data dir.
//!
//! No Postgres fields are built at all (sqlite-store PROV-sqlite-store-8): the
//! `postgresql` block is `None`, the `database` block names the store file, and
//! the server boots through the SQLite seam — no version, no port, no
//! `installation_dir`, no pg logging.

use ziee_core::app_state::{get_app_data_dir, set_app_name};
use ziee_core::config::{DatabaseConfig, HttpServerConfig, JwtConfig, ServerConfig};

/// The app name the SDK derives the default app-data dir from (DEC-13 —
/// `~/.txresbench`, the user-visible location the node's consumers bind).
/// `set_app_name` is set-once (first caller wins), so this must run before any
/// other `get_app_data_dir()` call in the process.
pub const APP_NAME: &str = "txresbench";

/// Point the SDK's app-data default at TxResBench — the DB target, the JWT
/// secret and the workstore/files roots all derive from the data dir, so this
/// is the first call of the desktop boot (mirrors ziee's `"ziee"` precedent).
pub fn init_app_name() {
    set_app_name(APP_NAME);
}

/// Read (or generate + persist) a strong per-install JWT secret. `JwtService`
/// refuses secrets < 32 chars or matching a shipped placeholder, so a
/// UUID-derived 64-hex-char string is used. Stored next to the DB file, under
/// the app-data dir.
fn jwt_secret() -> String {
    let dir = get_app_data_dir();
    let path = dir.join("jwt.secret");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim().to_string();
        if s.len() >= 32 {
            return s;
        }
    }
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&path, &secret);
    secret
}

/// Build the desktop `ServerConfig` (SQLite store, ephemeral HTTP port).
pub fn desktop_config() -> ServerConfig {
    init_app_name();
    let dir = get_app_data_dir();
    ServerConfig {
        postgresql: None,
        database: Some(DatabaseConfig {
            // DEC-13's default location made explicit: the single DB file next
            // to the JWT secret; `CYTO_DATABASE_URL` still overrides it
            // (env > url > path > default, src/config.rs).
            path: Some(dir.join("txresbench.db").to_string_lossy().into_owned()),
            ..DatabaseConfig::default()
        }),
        server: HttpServerConfig {
            host: "127.0.0.1".to_string(),
            // Ephemeral — the real port is read from local_addr and exposed to
            // the webview via the get_server_port IPC command.
            port: 0,
            api_prefix: "/api".to_string(),
            cors: None,
            // Embedded/local webview only — no rate limiter (matches app#1's
            // desktop posture; None absent-default → no limiter installed).
            rate_limit: None,
            trust_forwarded_headers: false,
            max_file_upload_mb: 128,
        },
        logging: None,
        jwt: JwtConfig {
            secret: jwt_secret(),
            // The app-wide token identity (same as the shipped configs /
            // workstore defaults) — the desktop mints + verifies its own
            // tokens, so keeping the identity consistent across modes is what
            // matters, not the branding.
            issuer: "cytoanalyst".to_string(),
            audience: "cytoanalyst-api".to_string(),
            access_token_expiry_hours: 24,
            refresh_token_expiry_days: 30,
            access_token_expiry_seconds: None,
        },
    }
}
