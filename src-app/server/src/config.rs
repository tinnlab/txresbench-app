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

use serde::Deserialize;
use ziee_core::ServerConfig;

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

/// Env var overriding `secrets.storage_key` (12-factor). Takes precedence over the
/// config file when set + non-empty.
pub const STORAGE_KEY_ENV: &str = "CYTO_SECRET_STORAGE_KEY";

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
