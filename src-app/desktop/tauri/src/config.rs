//! The desktop's embedded-server config, built in code.
//!
//! Single-user desktop: embedded Postgres under the OS home dir, an ephemeral
//! HTTP port (bound with `:0`, the real port read back from `local_addr`), and a
//! per-install JWT secret persisted next to the data dir.

use ziee_core::config::{
    EmbeddedPostgreSqlConfig, HttpServerConfig, JwtConfig, LoggingConfigPostgres, PoolConfig,
    PostgreSqlConfig, ServerConfig,
};

/// Per-install data directory (`~/.cytoanalyst`).
fn data_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{home}/.cytoanalyst")
}

/// Read (or generate + persist) a strong per-install JWT secret. `JwtService`
/// refuses secrets < 32 chars or matching a shipped placeholder, so a
/// UUID-derived 64-hex-char string is used.
fn jwt_secret() -> String {
    let dir = data_dir();
    let path = format!("{dir}/jwt.secret");
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

/// Build the desktop `ServerConfig` (embedded PG, ephemeral HTTP port).
pub fn desktop_config() -> ServerConfig {
    let dir = data_dir();
    ServerConfig {
        postgresql: Some(PostgreSqlConfig {
            use_embedded: true,
            embedded: Some(EmbeddedPostgreSqlConfig {
                version: "18.3.0".to_string(),
                // Fixed loopback port for the single desktop instance (a real
                // port is needed because database_url() is built from it — port
                // 0 auto-select would leave the pool URL pointing at :0).
                port: 54355,
                bind_address: "127.0.0.1".to_string(),
                username: "postgres".to_string(),
                password: "postgres".to_string(),
                database: "postgres".to_string(),
                installation_dir: Some(format!("{dir}/postgres")),
                data_dir: Some(format!("{dir}/postgres-data")),
                timezone: "UTC".to_string(),
                log_timezone: "UTC".to_string(),
                logging: LoggingConfigPostgres {
                    collector: true,
                    directory: "log".to_string(),
                    filename: "postgresql-%Y-%m-%d_%H%M%S.log".to_string(),
                    statement: "all".to_string(),
                },
            }),
            external: None,
            pool: Some(PoolConfig {
                max_connections: 10,
                min_connections: 1,
                acquire_timeout_secs: 5,
                idle_timeout_secs: Some(30),
                max_lifetime_secs: Some(300),
            }),
        }),
        database: None,
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
            issuer: "cytoanalyst".to_string(),
            audience: "cytoanalyst-api".to_string(),
            access_token_expiry_hours: 24,
            refresh_token_expiry_days: 30,
            access_token_expiry_seconds: None,
        },
    }
}
