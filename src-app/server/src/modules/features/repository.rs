//! `feature_flags` persistence.
//!
//! Mirrors `jobs/settings.rs` (`struct { pool }`, compile-time `query_*!`, errors
//! mapped to `AppError::database_error`). Two independent write paths — the GLOBAL
//! default row (`account_id IS NULL`) and a PER-ACCOUNT override — each an idempotent
//! UPSERT keyed by a distinct unique index, so setting one never disturbs the other
//! (INV-3) and a repeat write UPDATEs rather than inserting a duplicate (INV-5).
//! Single-driver SQLite (sqlite-store, ITEM-23): the DEC-8 map applies (uuid →
//! BLOB, `timestamptz` → RFC3339-UTC TEXT via the canonical `strftime` clock, the
//! `id` bind replaces the dropped `gen_random_uuid()` default); the partial-index
//! `ON CONFLICT (flag_key) WHERE account_id IS NULL` target is kept VERBATIM —
//! SQLite 3.46 accepts conflict targets with a predicate (the account port's
//! `ON CONFLICT (personal_user_id) WHERE kind = 'personal'` precedent, probed there).

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use super::models::FeatureFlagRow;

pub struct FeatureFlagRepository {
    pool: SqlitePool,
}

impl FeatureFlagRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The GLOBAL default for `flag_key` (`account_id IS NULL`), if a global row
    /// exists. `None` ⇒ no global row → the compiled registry default applies.
    pub async fn global_enabled(&self, flag_key: &str) -> Result<Option<bool>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT enabled as "enabled: bool" FROM feature_flags
               WHERE flag_key = $1 AND account_id IS NULL"#,
            flag_key
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The PER-ACCOUNT override for `(flag_key, account_id)`, if one exists.
    pub async fn account_enabled(
        &self,
        flag_key: &str,
        account_id: Uuid,
    ) -> Result<Option<bool>, AppError> {
        sqlx::query_scalar!(
            r#"SELECT enabled as "enabled: bool" FROM feature_flags
               WHERE flag_key = $1 AND account_id = $2"#,
            flag_key,
            account_id
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Set (upsert) the GLOBAL default for `flag_key`. Idempotent on the partial
    /// unique index `(flag_key) WHERE account_id IS NULL`: a repeat write UPDATEs the
    /// single global row. Does not touch any per-account override.
    pub async fn set_global(
        &self,
        flag_key: &str,
        enabled: bool,
    ) -> Result<FeatureFlagRow, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            FeatureFlagRow,
            r#"INSERT INTO feature_flags (id, flag_key, account_id, enabled)
               VALUES ($1, $2, NULL, $3)
               ON CONFLICT (flag_key) WHERE account_id IS NULL
               DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               RETURNING id as "id: Uuid",
                         flag_key,
                         account_id as "account_id: Uuid",
                         enabled as "enabled: bool",
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            flag_key,
            enabled
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Set (upsert) a PER-ACCOUNT override for `(flag_key, account_id)`. Idempotent on
    /// the composite unique index `(flag_key, account_id)`. Does not touch the global
    /// default or any other account's override.
    pub async fn set_account(
        &self,
        flag_key: &str,
        account_id: Uuid,
        enabled: bool,
    ) -> Result<FeatureFlagRow, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            FeatureFlagRow,
            r#"INSERT INTO feature_flags (id, flag_key, account_id, enabled)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (flag_key, account_id)
               DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               RETURNING id as "id: Uuid",
                         flag_key,
                         account_id as "account_id: Uuid",
                         enabled as "enabled: bool",
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            flag_key,
            account_id,
            enabled
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Clear (DELETE) the PER-ACCOUNT override for `(flag_key, account_id)` so the account
    /// reverts to inheriting the global default (or the compiled default). Idempotent:
    /// returns the number of rows removed (0 when no override existed — NOT an error, and
    /// no row is fabricated). Scoped to exactly one `(flag_key, account_id)` row by the
    /// composite unique index, so it never touches the GLOBAL row (`account_id IS NULL`)
    /// or any OTHER account's override (INV-3).
    pub async fn clear_account(
        &self,
        flag_key: &str,
        account_id: Uuid,
    ) -> Result<u64, AppError> {
        let result = sqlx::query!(
            r#"DELETE FROM feature_flags
               WHERE flag_key = $1 AND account_id = $2"#,
            flag_key,
            account_id
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(result.rows_affected())
    }

    /// Does `account_id` name a real account? Used by the admin PUT to 404 a
    /// per-account write against a non-existent account (rather than lean on the FK
    /// error).
    pub async fn account_exists(&self, account_id: Uuid) -> Result<bool, AppError> {
        let exists = sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM accounts WHERE id = $1) as "exists!: bool""#,
            account_id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(exists)
    }
}
