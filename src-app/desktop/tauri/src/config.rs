//! The desktop's embedded-server config, built in code.
//!
//! Single-user desktop: the SQLite store under the OS home dir (`~/.txresbench`
//! — the SDK derives the default app-data dir from the app name set here; the
//! stale `~/.txresbench` branding is gone), an ephemeral HTTP port (bound with
//! `:0`, the real port read back from `local_addr`), and a per-install JWT
//! secret persisted next to the data dir.
//!
//! No Postgres fields are built at all (sqlite-store PROV-sqlite-store-8): the
//! `postgresql` block is `None`, the `database` block names the store file, and
//! the server boots through the SQLite seam — no version, no port, no
//! `installation_dir`, no pg logging.

use txresbench_core::app_state::{get_app_data_dir, set_app_name};
use txresbench::modules::local_api_lock::{allowed_origins, generate_secret, KEY_ENV, KEY_HEADER, MIN_KEY_LEN};
use txresbench_core::config::{CorsConfig, DatabaseConfig, HttpServerConfig, JwtConfig, ServerConfig};

/// The app name the SDK derives the default app-data dir from (DEC-13 —
/// `~/.txresbench`, the user-visible location the node's consumers bind).
/// `set_app_name` is set-once (first caller wins), so this must run before any
/// other `get_app_data_dir()` call in the process.
pub const APP_NAME: &str = "txresbench";

/// Point the SDK's app-data default at TxResBench — the DB target, the JWT
/// secret and the workstore/files roots all derive from the data dir, so this
/// is the first call of the desktop boot (mirrors txresbench's `"txresbench"` precedent).
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

/// The per-run local-API key: 32 random bytes, hex, made once at start. It lives
/// in memory only (never written, never logged) and reaches the webview over
/// the `get_api_secret` IPC command. Debug builds honor `TXR_LOCAL_API_KEY`
/// (>= 16 characters) so the dev scripts can curl the embedded server; a
/// release build ignores it.
pub fn api_secret() -> String {
    api_secret_from(std::env::var(KEY_ENV).ok().as_deref(), cfg!(debug_assertions))
}

fn api_secret_from(env: Option<&str>, debug: bool) -> String {
    match env.map(str::trim) {
        Some(v) if debug && v.len() >= MIN_KEY_LEN => v.to_string(),
        _ => generate_secret(),
    }
}

/// The CORS block: ONLY the webview's own origins (never `*`; the framework
/// turns an absent or empty origin list into "any origin"), the methods the app
/// uses, and an explicit header list that includes the local-API key header.
/// The Vite dev origin is allowed in debug builds only.
fn cors_config(debug: bool) -> CorsConfig {
    CorsConfig {
        allow_origins: allowed_origins(debug).into_iter().map(String::from).collect(),
        allow_methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
            .map(String::from)
            .to_vec(),
        allow_headers: [
            "content-type",
            "authorization",
            "accept",
            "x-refresh-cookie",
            "x-sync-connection-id",
            KEY_HEADER,
        ]
        .map(String::from)
        .to_vec(),
    }
}

/// Build the desktop `ServerConfig` (SQLite store, ephemeral HTTP port).
pub fn desktop_config() -> ServerConfig {
    init_app_name();
    let dir = get_app_data_dir();
    ServerConfig {
        postgresql: None,
        database: Some(DatabaseConfig {
            // DEC-13's default location made explicit: the single DB file next
            // to the JWT secret; `TXR_DATABASE_URL` still overrides it
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
            cors: Some(cors_config(cfg!(debug_assertions))),
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
            issuer: "txresbench".to_string(),
            audience: "txresbench-api".to_string(),
            access_token_expiry_hours: 24,
            refresh_token_expiry_days: 30,
            access_token_expiry_seconds: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The framework reads an absent block, an empty origin list or a `*` as "any
    /// origin, any method, any header". Any of those reopens the hole (a web page
    /// could call the API), so the desktop config must never be one.
    #[test]
    fn cors_is_an_explicit_webview_only_list() {
        for debug in [false, true] {
            let c = cors_config(debug);
            assert!(!c.allow_origins.is_empty());
            for list in [&c.allow_origins, &c.allow_methods, &c.allow_headers] {
                assert!(!list.is_empty() && !list.iter().any(|v| v == "*"), "{list:?}");
            }
            for o in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
                assert!(c.allow_origins.iter().any(|v| v == o), "{o}");
            }
            assert!(c.allow_headers.iter().any(|h| h == "x-txr-local-key"));
            assert!(c.allow_headers.iter().any(|h| h == "authorization"));
        }
    }

    #[test]
    fn the_vite_dev_origin_is_debug_only() {
        let dev = "http://localhost:5173".to_string();
        assert!(cors_config(true).allow_origins.contains(&dev));
        assert!(!cors_config(false).allow_origins.contains(&dev));
    }

    #[test]
    fn the_desktop_config_carries_the_cors_block() {
        // The block must reach `server.cors`; `None` is the open-to-any-origin default.
        let cors = desktop_config().server.cors.expect("the desktop config must set server.cors");
        assert_eq!(cors.allow_origins, cors_config(cfg!(debug_assertions)).allow_origins);
    }

    #[test]
    fn the_secret_is_random_and_only_debug_builds_take_the_env_override() {
        let a = api_secret_from(None, false);
        assert_eq!(a.len(), 64);
        assert_ne!(a, api_secret_from(None, false));
        let chosen = "chosen-by-the-dev-script-0123456789";
        assert_eq!(api_secret_from(Some(chosen), true), chosen);
        assert_ne!(api_secret_from(Some(chosen), false), chosen, "a release build ignores the env var");
        assert_ne!(api_secret_from(Some("short"), true), "short", "a short override is ignored");
    }
}
