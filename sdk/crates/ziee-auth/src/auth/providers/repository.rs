// Provider lookup helpers. OAuth session + auth-link mutations live
// on `AuthRepository` (see ../repository.rs) — this file is just
// for lightweight by-name lookups used during the OAuth callback
// and admin CRUD flows.

use uuid::Uuid;

use super::models::AuthProvider;
use ziee_core::AppError;
use ziee_framework::secret::{encrypt_secret, resolve_optional_secret};

/// JSONB key inside `auth_providers.config` that holds the OAuth login secret.
const CLIENT_SECRET_KEY: &str = "client_secret";

/// Raw row shape including the dual-column secret, before the encrypted column
/// is resolved back into `config`. Mirrors the mcp repository's row→model
/// assembly (see `assemble_mcp_server`).
///
/// The `config` column is `jsonb` on Postgres and JSON TEXT on SQLite
/// (DEC-8); the SQLite leg merges the JSON value into the model field through
/// the `JsonValue` transport type (see `assemble_provider`).
struct AuthProviderRow {
    id: Uuid,
    name: String,
    provider_type: String,
    enabled: bool,
    #[cfg(not(feature = "sqlite-backend"))]
    config: serde_json::Value,
    #[cfg(feature = "sqlite-backend")]
    config: crate::sqlite_types::JsonValue<serde_json::Value>,
    client_secret_encrypted: Option<Vec<u8>>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    last_test_at: Option<chrono::DateTime<chrono::Utc>>,
    last_test_ok: Option<bool>,
    last_test_message: Option<String>,
}

/// Resolve the client_secret from the encrypted column (preferred) with a
/// fallback to the plaintext value still embedded in `config` (legacy /
/// not-yet-re-encrypted rows), then inject the resolved value back into
/// `config["client_secret"]`. This keeps the returned `AuthProvider.config`
/// identical in shape to the pre-encryption behavior, so every downstream
/// consumer (oauth2.rs `serde_json::from_value`, the handlers' secret-preserve
/// path) works unchanged. The API response layer masks the secret separately
/// (handlers::mask_provider_config).
async fn assemble_provider(pool: &ziee_core::DbPool, row: AuthProviderRow) -> AuthProvider {
    // `row.config` is the model's `serde_json::Value` on the postgres leg and
    // the `JsonValue` transport on the sqlite leg; `.into()` normalizes both
    // to the plain value before any manipulation.
    let mut config: serde_json::Value = row.config.into();
    // Plaintext fallback: the secret still sitting in config on legacy rows.
    let plaintext = config
        .get(CLIENT_SECRET_KEY)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(resolved) =
        resolve_optional_secret(pool, row.client_secret_encrypted, plaintext).await
        && let serde_json::Value::Object(map) = &mut config
    {
        map.insert(
            CLIENT_SECRET_KEY.to_string(),
            serde_json::Value::String(resolved),
        );
    }
    AuthProvider {
        id: row.id,
        name: row.name,
        provider_type: row.provider_type,
        enabled: row.enabled,
        config,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_test_at: row.last_test_at,
        last_test_ok: row.last_test_ok,
        last_test_message: row.last_test_message,
    }
}

/// Split a `config` JSONB into the value to persist + the encrypted secret blob.
/// When a non-empty `client_secret` is present AND a storage key is configured,
/// the secret is encrypted into the returned blob and BLANKED inside the stored
/// config (the read path re-injects it from the encrypted column). With no
/// storage key (dev / unconfigured), it stays plaintext in config and the blob
/// is None — the dual-column compat mode, mirroring mcp + web_search.
async fn prepare_config_for_write(
    pool: &ziee_core::DbPool,
    config: &serde_json::Value,
    storage_key: Option<&str>,
) -> Result<(serde_json::Value, Option<Vec<u8>>), AppError> {
    let secret = config
        .get(CLIENT_SECRET_KEY)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let Some(secret) = secret else {
        // No secret to protect (e.g. ldap/apple rows, or a blank OAuth row):
        // store config as-is, no encrypted blob.
        return Ok((config.clone(), None));
    };
    match encrypt_secret(pool, secret, storage_key).await? {
        Some(blob) => {
            // Blank the plaintext copy in the stored config; the read path
            // re-injects the real value from the encrypted column.
            let mut stored = config.clone();
            if let serde_json::Value::Object(map) = &mut stored {
                map.insert(
                    CLIENT_SECRET_KEY.to_string(),
                    serde_json::Value::String(String::new()),
                );
            }
            Ok((stored, Some(blob)))
        }
        // No storage key → compat mode: keep plaintext in config.
        None => Ok((config.clone(), None)),
    }
}

/// Look up an auth provider by its `name` column (the identifier
/// in the URL path).
#[cfg(not(feature = "sqlite-backend"))]
pub async fn get_provider_by_name(
    pool: &ziee_core::DbPool,
    name: &str,
) -> Result<Option<AuthProvider>, AppError> {
    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id, name, provider_type, enabled, config,
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok,
               last_test_message
        FROM auth_providers
        WHERE name = $1
        "#,
        name
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    match row {
        Some(r) => Ok(Some(assemble_provider(pool, r).await)),
        None => Ok(None),
    }
}

#[cfg(feature = "sqlite-backend")]
pub async fn get_provider_by_name(
    pool: &ziee_core::DbPool,
    name: &str,
) -> Result<Option<AuthProvider>, AppError> {
    use crate::sqlite_types::JsonValue;

    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id as "id: _", name, provider_type,
               enabled as "enabled: _",
               config as "config!: JsonValue<serde_json::Value>",
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok as "last_test_ok: _",
               last_test_message
        FROM auth_providers
        WHERE name = $1
        "#,
        name
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    match row {
        Some(r) => Ok(Some(assemble_provider(pool, r).await)),
        None => Ok(None),
    }
}

/// Look up an auth provider by id. Used by the admin CRUD handlers.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn get_provider_by_id(
    pool: &ziee_core::DbPool,
    id: Uuid,
) -> Result<Option<AuthProvider>, AppError> {
    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id, name, provider_type, enabled, config,
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok,
               last_test_message
        FROM auth_providers
        WHERE id = $1
        "#,
        id
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    match row {
        Some(r) => Ok(Some(assemble_provider(pool, r).await)),
        None => Ok(None),
    }
}

#[cfg(feature = "sqlite-backend")]
pub async fn get_provider_by_id(
    pool: &ziee_core::DbPool,
    id: Uuid,
) -> Result<Option<AuthProvider>, AppError> {
    use crate::sqlite_types::JsonValue;

    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id as "id: _", name, provider_type,
               enabled as "enabled: _",
               config as "config!: JsonValue<serde_json::Value>",
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok as "last_test_ok: _",
               last_test_message
        FROM auth_providers
        WHERE id = $1
        "#,
        id
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    match row {
        Some(r) => Ok(Some(assemble_provider(pool, r).await)),
        None => Ok(None),
    }
}

/// List all configured auth providers (admin view — returns ALL
/// rows including disabled ones; secret-masking happens at the
/// response-building layer in handlers.rs).
#[cfg(not(feature = "sqlite-backend"))]
pub async fn list_providers(pool: &ziee_core::DbPool) -> Result<Vec<AuthProvider>, AppError> {
    let rows = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id, name, provider_type, enabled, config,
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok,
               last_test_message
        FROM auth_providers
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(assemble_provider(pool, r).await);
    }
    Ok(out)
}

#[cfg(feature = "sqlite-backend")]
pub async fn list_providers(pool: &ziee_core::DbPool) -> Result<Vec<AuthProvider>, AppError> {
    use crate::sqlite_types::JsonValue;

    let rows = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id as "id: _", name, provider_type,
               enabled as "enabled: _",
               config as "config!: JsonValue<serde_json::Value>",
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok as "last_test_ok: _",
               last_test_message
        FROM auth_providers
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(assemble_provider(pool, r).await);
    }
    Ok(out)
}

/// List enabled auth providers — the subset surfaced on the
/// `/login` page via `GET /api/auth/providers` (public, no auth).
/// Excludes the built-in `local` provider since the username/password
/// form is rendered statically.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn list_public_providers(pool: &ziee_core::DbPool) -> Result<Vec<AuthProvider>, AppError> {
    let rows = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id, name, provider_type, enabled, config,
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok,
               last_test_message
        FROM auth_providers
        WHERE enabled = true AND provider_type <> 'local'
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(assemble_provider(pool, r).await);
    }
    Ok(out)
}

#[cfg(feature = "sqlite-backend")]
pub async fn list_public_providers(pool: &ziee_core::DbPool) -> Result<Vec<AuthProvider>, AppError> {
    use crate::sqlite_types::JsonValue;

    let rows = sqlx::query_as!(
        AuthProviderRow,
        r#"
        SELECT id as "id: _", name, provider_type,
               enabled as "enabled: _",
               config as "config!: JsonValue<serde_json::Value>",
               client_secret_encrypted,
               created_at as "created_at: _",
               updated_at as "updated_at: _",
               last_test_at as "last_test_at: _",
               last_test_ok as "last_test_ok: _",
               last_test_message
        FROM auth_providers
        WHERE enabled = true AND provider_type <> 'local'
        ORDER BY name ASC
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(assemble_provider(pool, r).await);
    }
    Ok(out)
}

/// Create a new auth_providers row.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn create_provider(
    pool: &ziee_core::DbPool,
    name: &str,
    provider_type: &str,
    enabled: bool,
    config: &serde_json::Value,
    storage_key: Option<&str>,
) -> Result<AuthProvider, AppError> {
    // Encrypt the client_secret at rest: store it in client_secret_encrypted
    // and blank the plaintext copy inside config (compat: stays plaintext when
    // no storage key is configured).
    let (stored_config, encrypted) = prepare_config_for_write(pool, config, storage_key).await?;
    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        INSERT INTO auth_providers (name, provider_type, enabled, config, client_secret_encrypted)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (name) DO NOTHING
        RETURNING id, name, provider_type, enabled, config,
                  client_secret_encrypted,
                  created_at as "created_at: _",
                  updated_at as "updated_at: _",
                  last_test_at as "last_test_at: _",
                  last_test_ok,
                  last_test_message
        "#,
        name,
        provider_type,
        enabled,
        stored_config,
        encrypted,
    )
    // `auth_providers_name_key` is UNIQUE on (name); reusing an existing
    // provider name used to raise a 23505 that `database_error` flattened into
    // a generic 500 SYSTEM_DATABASE_ERROR. ON CONFLICT DO NOTHING is preferred
    // over a SELECT-then-INSERT pre-check because the guarded write is race-safe
    // (CODING_GUIDELINES §4 — no TOCTOU); a swallowed row (`None`) is
    // unambiguously the name conflict.
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?
    .ok_or_else(|| AppError::conflict("Auth provider name"))?;
    Ok(assemble_provider(pool, row).await)
}

#[cfg(feature = "sqlite-backend")]
pub async fn create_provider(
    pool: &ziee_core::DbPool,
    name: &str,
    provider_type: &str,
    enabled: bool,
    config: &serde_json::Value,
    storage_key: Option<&str>,
) -> Result<AuthProvider, AppError> {
    use crate::sqlite_types::JsonValue;

    // Encrypt the client_secret at rest — same as the postgres leg (see
    // above); the storage-key-less compat mode is unchanged (D02: with a key
    // configured on the sqlite store, `encrypt_secret` reports the secret
    // feature unavailable — the dormant-secret stance).
    let (stored_config, encrypted) = prepare_config_for_write(pool, config, storage_key).await?;
    let stored_config_json = ::sqlx::types::Json(&stored_config);
    // Explicit id bind (no SQL-side UUID generator, DEC-12); created_at /
    // updated_at come from the schema DEFAULTs.
    let provider_id = Uuid::new_v4();
    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        INSERT INTO auth_providers (id, name, provider_type, enabled, config, client_secret_encrypted)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (name) DO NOTHING
        RETURNING id as "id: _", name, provider_type,
                  enabled as "enabled: _",
                  config as "config!: JsonValue<serde_json::Value>",
                  client_secret_encrypted,
                  created_at as "created_at: _",
                  updated_at as "updated_at: _",
                  last_test_at as "last_test_at: _",
                  last_test_ok as "last_test_ok: _",
                  last_test_message
        "#,
        provider_id,
        name,
        provider_type,
        enabled,
        stored_config_json,
        encrypted,
    )
    // `auth_providers_name_key` is UNIQUE on (name) — same swallowed-row
    // contract as the postgres leg (see above).
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?
    .ok_or_else(|| AppError::conflict("Auth provider name"))?;
    Ok(assemble_provider(pool, row).await)
}

/// Update an auth_providers row. Pass `None` for fields you want to
/// leave unchanged.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn update_provider(
    pool: &ziee_core::DbPool,
    id: Uuid,
    name: Option<&str>,
    enabled: Option<bool>,
    config: Option<&serde_json::Value>,
    storage_key: Option<&str>,
) -> Result<AuthProvider, AppError> {
    // Only touch the secret columns when `config` is being patched. When it is,
    // encrypt the client_secret + blank its plaintext copy; the encrypted column
    // is set to the new blob (which is NULL in compat mode, intentionally
    // clearing any stale ciphertext so the now-plaintext config is the source).
    // When config is None, both `config` and `client_secret_encrypted` are left
    // untouched via the `config_provided` guard.
    let config_provided = config.is_some();
    let (stored_config, encrypted): (Option<serde_json::Value>, Option<Vec<u8>>) = match config {
        Some(c) => {
            let (sc, enc) = prepare_config_for_write(pool, c, storage_key).await?;
            (Some(sc), enc)
        }
        None => (None, None),
    };
    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        UPDATE auth_providers
        SET name = COALESCE($2, name),
            enabled = COALESCE($3, enabled),
            config = COALESCE($4, config),
            client_secret_encrypted = CASE
                WHEN $5 THEN $6
                ELSE client_secret_encrypted
            END
        WHERE id = $1
        RETURNING id, name, provider_type, enabled, config,
                  client_secret_encrypted,
                  created_at as "created_at: _",
                  updated_at as "updated_at: _",
                  last_test_at as "last_test_at: _",
                  last_test_ok,
                  last_test_message
        "#,
        id,
        name,
        enabled,
        stored_config,
        config_provided,
        encrypted,
    )
    .fetch_one(pool)
    .await
    // Renaming a provider onto a name another provider already holds violates
    // `auth_providers_name_key`. UPDATE has no ON CONFLICT form, so map the
    // unique violation to a 409 here (the idiom used by the user / knowledge_base
    // / citations repositories) instead of a generic 500.
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::conflict("Auth provider name")
        }
        other => AppError::database_error(other),
    })?;
    Ok(assemble_provider(pool, row).await)
}

#[cfg(feature = "sqlite-backend")]
pub async fn update_provider(
    pool: &ziee_core::DbPool,
    id: Uuid,
    name: Option<&str>,
    enabled: Option<bool>,
    config: Option<&serde_json::Value>,
    storage_key: Option<&str>,
) -> Result<AuthProvider, AppError> {
    use crate::sqlite_types::JsonValue;

    // Same config-provided guard as the postgres leg (see above). The
    // optional json value is pre-serialized: a bound `Json(None)` would store
    // the JSON text `null`, not SQL NULL — and `COALESCE($4, config)` needs a
    // real NULL to mean "leave untouched".
    let config_provided = config.is_some();
    let (stored_config, encrypted): (Option<serde_json::Value>, Option<Vec<u8>>) = match config {
        Some(c) => {
            let (sc, enc) = prepare_config_for_write(pool, c, storage_key).await?;
            (Some(sc), enc)
        }
        None => (None, None),
    };
    let stored_config_bind: Option<String> =
        stored_config.map(|c| serde_json::to_string(&c).unwrap());
    let stored_config_bind: Option<&str> = stored_config_bind.as_deref();
    let row = sqlx::query_as!(
        AuthProviderRow,
        r#"
        UPDATE auth_providers
        SET name = COALESCE($2, name),
            enabled = COALESCE($3, enabled),
            config = COALESCE($4, config),
            client_secret_encrypted = CASE
                WHEN $5 THEN $6
                ELSE client_secret_encrypted
            END
        WHERE id = $1
        RETURNING id as "id: _", name, provider_type,
                  enabled as "enabled: _",
                  config as "config!: JsonValue<serde_json::Value>",
                  client_secret_encrypted,
                  created_at as "created_at: _",
                  updated_at as "updated_at: _",
                  last_test_at as "last_test_at: _",
                  last_test_ok as "last_test_ok: _",
                  last_test_message
        "#,
        id,
        name,
        enabled,
        stored_config_bind,
        config_provided,
        encrypted,
    )
    .fetch_one(pool)
    .await
    // Same unique-violation → 409 mapping as the postgres leg (see above).
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::conflict("Auth provider name")
        }
        other => AppError::database_error(other),
    })?;
    Ok(assemble_provider(pool, row).await)
}

/// Atomically delete a provider and return its name + the number of
/// `user_auth_links` that were cascade-removed.
///
/// All three steps (existence-lock, link count, delete) run inside ONE
/// transaction with the provider row locked `FOR UPDATE`. This replaces the
/// previous get→count→delete sequence of three separate, non-atomic queries:
///   - Concurrent deletes both passed the standalone existence check, then
///     one DELETE affected 0 rows → a confusing 404 to the loser. Under the
///     row lock the second deleter now blocks until the first commits, then
///     observes the row already gone and gets a clean `Ok(None)` (→ 404,
///     which is correct: the provider genuinely no longer exists).
///   - `affected_user_links` could be stale (links added/removed between the
///     count and the delete). Taken under the lock in the same tx, the count
///     now exactly matches what the FK cascade removes.
///
/// Returns `Ok(None)` when the provider does not exist.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn delete_provider_with_link_count(
    pool: &ziee_core::DbPool,
    id: Uuid,
) -> Result<Option<(String, i64)>, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::database_error)?;

    // Lock the row for the duration of the tx; serializes concurrent deletes.
    let Some(row) = sqlx::query!(
        r#"SELECT name FROM auth_providers WHERE id = $1 FOR UPDATE"#,
        id,
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::database_error)?
    else {
        tx.rollback().await.map_err(AppError::database_error)?;
        return Ok(None);
    };

    let affected = sqlx::query!(
        r#"SELECT COUNT(*) as "count!" FROM user_auth_links WHERE provider_id = $1"#,
        id,
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::database_error)?
    .count;

    sqlx::query!(r#"DELETE FROM auth_providers WHERE id = $1"#, id)
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

    tx.commit().await.map_err(AppError::database_error)?;
    Ok(Some((row.name, affected)))
}

#[cfg(feature = "sqlite-backend")]
pub async fn delete_provider_with_link_count(
    pool: &ziee_core::DbPool,
    id: Uuid,
) -> Result<Option<(String, i64)>, AppError> {
    let mut tx = pool.begin().await.map_err(AppError::database_error)?;

    // No `FOR UPDATE` on SQLite — the single-writer model serializes the
    // transaction from its first write (the DELETE below), and this SELECT
    // only needs to decide exist/not-exist. The concurrent-delete race the
    // postgres leg's row lock closes resolves the same way here: a
    // concurrent deleter's write waits on this transaction's lock (or vice
    // versa) and then observes the row already gone → clean `Ok(None)`.
    let Some(row) = sqlx::query!(
        r#"SELECT name FROM auth_providers WHERE id = $1"#,
        id,
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(AppError::database_error)?
    else {
        tx.rollback().await.map_err(AppError::database_error)?;
        return Ok(None);
    };

    let affected = sqlx::query!(
        r#"SELECT COUNT(*) as "count!" FROM user_auth_links WHERE provider_id = $1"#,
        id,
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::database_error)?
    .count;

    sqlx::query!(r#"DELETE FROM auth_providers WHERE id = $1"#, id)
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

    tx.commit().await.map_err(AppError::database_error)?;
    Ok(Some((row.name, affected)))
}

/// Flip `enabled` to false on the row. Called by the health-enforcement
/// layer when an enable-transition probe fails or a manual Test of an
/// enabled row turns up failing. Touches `updated_at` so frontend
/// caches see the row as fresh.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn set_enabled_false(pool: &ziee_core::DbPool, id: Uuid) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE auth_providers SET enabled = FALSE, updated_at = NOW() WHERE id = $1",
        id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

#[cfg(feature = "sqlite-backend")]
pub async fn set_enabled_false(pool: &ziee_core::DbPool, id: Uuid) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE auth_providers SET enabled = FALSE, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1",
        id,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// Record the outcome of a test_connection call on the row.
/// Updates last_test_at/ok/message so the admin UI can show the
/// result on the next list refresh.
#[cfg(not(feature = "sqlite-backend"))]
pub async fn record_test_result(
    pool: &ziee_core::DbPool,
    id: Uuid,
    ok: bool,
    message: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"
        UPDATE auth_providers
        SET last_test_at = NOW(),
            last_test_ok = $2,
            last_test_message = $3
        WHERE id = $1
        "#,
        id,
        ok,
        message,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

#[cfg(feature = "sqlite-backend")]
pub async fn record_test_result(
    pool: &ziee_core::DbPool,
    id: Uuid,
    ok: bool,
    message: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"
        UPDATE auth_providers
        SET last_test_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            last_test_ok = $2,
            last_test_message = $3
        WHERE id = $1
        "#,
        id,
        ok,
        message,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}
