//! Persistence for the object-store data migration (#61 §2) over the
//! `object_store_migration` table — so a migration survives a restart, is resumable, and the
//! admin surface can show live progress + verify status + the confirm-before-retire step.
//!
//! This layer only records STATE; it never moves or deletes a blob (that is
//! `migration_engine.rs`). Profile-agnostic (plain sqlx) so a local→local migration is
//! exercisable in both builds; the cloud ends live behind the saas orchestrator/endpoints.
//!
//! SQLite port (record; sqlite-store): the 13 dynamic `sqlx::query` sites become
//! single-driver — `map_row` reads `SqliteRow` (the DEC-8 map: Uuid←BLOB, bool←
//! INTEGER, i64←INTEGER, JSON/BLOB TEXT), `now()` is the canonical RFC3339
//! `strftime` clock, `GREATEST` is `MAX`, and the PG `is_unique_violation()`
//! (23505) re-keys to the sqlite extended codes 2067/1555 (ITEM-18's map). The
//! `encrypt_secret`/`decrypt_secret` calls keep their shape: the SDK
//! `txresbench_framework::secret` sqlite branch (owner decision D02 — the secret
//! feature stays dormant and returns the explicit "secrets unavailable" error)
//! takes the app's `&SqlitePool` through the `DbPool` alias.

use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

/// A migration row (non-secret descriptors + lifecycle + progress). Serialized (masked) to
/// the admin status endpoint — it carries NO credential, only bucket/provider/backend labels.
#[derive(Debug, Clone, Serialize)]
pub struct MigrationRow {
    pub id: Uuid,
    pub src_backend: String,
    pub src_provider: Option<String>,
    pub src_bucket: Option<String>,
    pub dst_backend: String,
    pub dst_provider: Option<String>,
    pub dst_bucket: Option<String>,
    pub phase: String,
    pub blobs_total: i64,
    pub blobs_done: i64,
    pub bytes_total: i64,
    pub bytes_done: i64,
    pub cross_cloud: bool,
    pub cost_ack: bool,
    pub verify_error: Option<String>,
    pub auto_started: bool,
    /// TRUE once the live cutover was applied (the process-global handle swapped to
    /// `DualRead(new, old)` with no restart, #64). Only ever set on a `verified` row.
    pub cutover: bool,
    /// The OLD store's full connection config, ENCRYPTED AT REST (#64 DEC-5), so boot can rebuild
    /// the dual-read fallback for ANY pair. `#[serde(skip)]` — this is ciphertext holding cloud
    /// credentials; it must NEVER reach the masked status view or any response body.
    #[serde(skip)]
    pub src_config_ciphertext: Option<Vec<u8>>,
}

/// The descriptors needed to create a migration (the two ends + cost-gate facts).
pub struct NewMigration {
    pub src_backend: String,
    pub src_provider: Option<String>,
    pub src_bucket: Option<String>,
    pub dst_backend: String,
    pub dst_provider: Option<String>,
    pub dst_bucket: Option<String>,
    pub cross_cloud: bool,
    pub cost_ack: bool,
    pub auto_started: bool,
    pub blobs_total: i64,
    pub bytes_total: i64,
    /// The OLD store's connection config, ENCRYPTED AT REST (#64 DEC-5). `None` for a local source
    /// with no secret (rebuilt from the local root at boot).
    pub src_config_ciphertext: Option<Vec<u8>>,
}

/// Phases a migration can be in (kept as string constants matching the table CHECK).
pub mod phase {
    pub const PENDING: &str = "pending";
    pub const COPYING: &str = "copying";
    pub const VERIFYING: &str = "verifying";
    pub const VERIFIED: &str = "verified";
    pub const FAILED: &str = "failed";
    pub const RETIRED: &str = "retired";
    /// The operator ABANDONED a verified migration (#65) and reverted the primary to the intact
    /// OLD store. A distinct terminal phase (NOT `failed`, which `latest_unretired` includes so a
    /// genuine copy-failure keeps its OLD fallback; NOT `retired`, which asserts NEW ⊇ OLD was
    /// re-proved and OLD released). Excluded from `latest_unretired` so the store is reconfigurable
    /// and boot-resume stops re-establishing the dual-read fallback.
    pub const ABANDONED: &str = "abandoned";
    /// The RUNNING set — at most one such row exists at a time (the partial unique index).
    /// `VERIFIED` is deliberately EXCLUDED: a verified migration is a completed copy awaiting the
    /// operator's manual retire, and must not block a fresh migration from being started.
    pub const ACTIVE: [&str; 3] = [PENDING, COPYING, VERIFYING];
}

fn map_row(r: sqlx::sqlite::SqliteRow) -> MigrationRow {
    use sqlx::Row;
    MigrationRow {
        id: r.get("id"),
        src_backend: r.get("src_backend"),
        src_provider: r.get("src_provider"),
        src_bucket: r.get("src_bucket"),
        dst_backend: r.get("dst_backend"),
        dst_provider: r.get("dst_provider"),
        dst_bucket: r.get("dst_bucket"),
        phase: r.get("phase"),
        blobs_total: r.get("blobs_total"),
        blobs_done: r.get("blobs_done"),
        bytes_total: r.get("bytes_total"),
        bytes_done: r.get("bytes_done"),
        cross_cloud: r.get("cross_cloud"),
        cost_ack: r.get("cost_ack"),
        verify_error: r.get("verify_error"),
        auto_started: r.get("auto_started"),
        cutover: r.get("cutover"),
        src_config_ciphertext: r.get("src_config_ciphertext"),
    }
}

const SELECT_COLS: &str = "id, src_backend, src_provider, src_bucket, dst_backend, dst_provider, \
     dst_bucket, phase, blobs_total, blobs_done, bytes_total, bytes_done, cross_cloud, \
     cost_ack, verify_error, auto_started, cutover, src_config_ciphertext";

/// The newest migration row (the one the status endpoint shows), or `None` if never started.
pub async fn latest(pool: &SqlitePool) -> Result<Option<MigrationRow>, AppError> {
    let q = format!("SELECT {SELECT_COLS} FROM object_store_migration ORDER BY created_at DESC LIMIT 1");
    let row = sqlx::query(&q)
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(row.map(map_row))
}

/// The single ACTIVE (non-terminal) migration, if any (there is at most one, enforced by the
/// partial unique index).
pub async fn active(pool: &SqlitePool) -> Result<Option<MigrationRow>, AppError> {
    let q = format!(
        "SELECT {SELECT_COLS} FROM object_store_migration \
         WHERE phase IN ('pending','copying','verifying') ORDER BY created_at DESC LIMIT 1"
    );
    let row = sqlx::query(&q)
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(row.map(map_row))
}

/// Create a new migration row. Fails (unique-violation → a clean 409) if an active migration
/// already exists — a second switch cannot race a running move.
///
/// **The id is bound app-side** (the first column, `$1`): the SQLite chain has
/// no SQL uuid generator (the PG baseline's `DEFAULT gen_random_uuid()` is
/// gone — the ITEM-17-recorded default gap, this module's instance of DEC-12's
/// "gen_random_uuid() → Rust `Uuid::new_v4()` bind" rule).
pub async fn create(pool: &SqlitePool, n: &NewMigration, created_by: Uuid) -> Result<MigrationRow, AppError> {
    let q = format!(
        "INSERT INTO object_store_migration \
          (id, src_backend, src_provider, src_bucket, dst_backend, dst_provider, dst_bucket, \
           cross_cloud, cost_ack, auto_started, blobs_total, bytes_total, created_by, \
           src_config_ciphertext) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING {SELECT_COLS}"
    );
    let row = sqlx::query(&q)
        .bind(Uuid::new_v4())
        .bind(&n.src_backend)
        .bind(&n.src_provider)
        .bind(&n.src_bucket)
        .bind(&n.dst_backend)
        .bind(&n.dst_provider)
        .bind(&n.dst_bucket)
        .bind(n.cross_cloud)
        .bind(n.cost_ack)
        .bind(n.auto_started)
        .bind(n.blobs_total)
        .bind(n.bytes_total)
        .bind(created_by)
        .bind(&n.src_config_ciphertext)
        .fetch_one(pool)
        .await
        .map_err(|e| match e {
            // SQLite port (record; the ITEM-18 error-key re-map): the PG `23505`
            // unique violation surfaces as the sqlx-sqlite extended codes
            // `2067` (SQLITE_CONSTRAINT_UNIQUE) / `1555` (PRIMARYKEY — the same
            // race in the other order); `is_unique_violation()` is PG-only.
            sqlx::Error::Database(db)
                if matches!(db.code().as_deref(), Some("2067") | Some("1555")) =>
            {
                AppError::conflict("an object-store migration is already in progress")
            }
            other => AppError::database_error(other),
        })?;
    Ok(map_row(row))
}

/// Encrypt the OLD store's preserved connection config (#64 DEC-5) for storage. A LOCAL source
/// carries no secret and returns `Ok(None)` (stored NULL; boot rebuilds from the local root). A
/// cloud source is serialized to JSON and encrypted at rest; if at-rest encryption is not
/// configured (`storage_key` unset) it returns `Ok(None)` — the CALLER (the auto-trigger) treats a
/// cloud source with no ciphertext as a FAIL-CLOSED refusal to cut over (a restart could not
/// rebuild the cloud fallback), never a silent unsafe proceed.
pub async fn encrypt_preserved_old_config(
    pool: &SqlitePool,
    cfg: &super::cutover::PreservedStoreConfig,
) -> Result<Option<Vec<u8>>, AppError> {
    if cfg.backend == "local" {
        return Ok(None);
    }
    let json = serde_json::to_string(cfg)
        .map_err(|e| AppError::internal_error(format!("serialize preserved OLD config: {e}")))?;
    txresbench_framework::secret::encrypt_secret(pool, &json, txresbench_framework::secrets::storage_key()).await
}

/// Decrypt the preserved OLD-store config (#64 DEC-5) for a row, for boot-resume / the retire
/// gate. Returns the reconstructable config: the decrypted cloud config for a cloud source,
/// `PreservedStoreConfig::local()` for a local source (NULL ciphertext), or `None` when a cloud
/// source's ciphertext is missing/undecryptable (missing or wrong `storage_key`) — the caller then
/// stays on the NEW store only and logs loudly (fail-closed, never a silent wrong-store read).
pub async fn decrypt_preserved_old_config(
    pool: &SqlitePool,
    row: &MigrationRow,
) -> Option<super::cutover::PreservedStoreConfig> {
    match &row.src_config_ciphertext {
        None => {
            if row.src_backend == "local" {
                Some(super::cutover::PreservedStoreConfig::local())
            } else {
                None
            }
        }
        Some(ct) => {
            let key = txresbench_framework::secrets::storage_key()?;
            match txresbench_framework::secret::decrypt_secret(pool, ct, key).await {
                Ok(json) => serde_json::from_str(&json).ok(),
                Err(e) => {
                    tracing::error!(error = ?e, "workstore: could not decrypt preserved OLD-store config (#64)");
                    None
                }
            }
        }
    }
}

/// Set the phase (and clear/keep the error). A terminal phase is final except that `retired`
/// may only follow `verified` (enforced by the caller/endpoint, not here).
pub async fn set_phase(pool: &SqlitePool, id: Uuid, phase: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE object_store_migration SET phase = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1")
        .bind(id)
        .bind(phase)
        .execute(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(())
}

/// Record that the LIVE cutover was applied (#64): the process-global handle was swapped to
/// `DualRead(new, old)` with no restart. Guarded to a `verified` row (the activation guard,
/// INV-3) — a cutover can never be recorded against a non-verified migration. Idempotent.
pub async fn mark_cutover(pool: &SqlitePool, id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE object_store_migration SET cutover = true, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = $1 AND phase = 'verified'",
    )
    .bind(id)
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// The newest migration that has NOT been retired (#64 boot-resume, ITEM-7 / DEC-5) — for ANY
/// store pair. When the effective config is the NEW store but a migration to it is still
/// un-retired, the OLD store holds data (pre-switch blobs + write-during-migration blobs) that the
/// NEW copy may not — so boot re-establishes `DualRead(new, old)` to keep every such blob readable
/// across a restart, rebuilding OLD from `src_config_ciphertext` (decrypted) for a cloud source or
/// from the local root for a local source. Includes `pending`/`copying`/`verifying`/`verified`/
/// `failed` (all need the OLD fallback); EXCLUDES `retired` (the operator proved every blob is in
/// NEW and released OLD) AND `abandoned` (#65 — the operator reverted the primary to the OLD store,
/// so keeping it here would re-fire the config-change 409 and re-establish a pointless dual-read).
pub async fn latest_unretired(pool: &SqlitePool) -> Result<Option<MigrationRow>, AppError> {
    // AUTO migrations only: an auto (config-switch) migration ADVANCED the effective config to its
    // dst, so at boot the config store IS this migration's NEW and DualRead(new, old) is correct. A
    // MANUAL migration (#61) does not advance the config, so its dst is NOT the boot store and it
    // must not trigger boot-resume — it keeps reboot-cutover semantics.
    let q = format!(
        "SELECT {SELECT_COLS} FROM object_store_migration \
         WHERE phase NOT IN ('retired','abandoned') AND auto_started = true ORDER BY created_at DESC LIMIT 1"
    );
    let row = sqlx::query(&q)
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(row.map(map_row))
}

/// Fetch a single migration by id (used by the cost-ack resume path, #64) — includes the
/// (skipped-from-serialization) `src_config_ciphertext`.
pub async fn by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<MigrationRow>, AppError> {
    let q = format!("SELECT {SELECT_COLS} FROM object_store_migration WHERE id = $1");
    let row = sqlx::query(&q)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(row.map(map_row))
}

/// Mark a migration failed with a FIXED-VOCABULARY category (never a raw error / credential).
pub async fn set_failed(pool: &SqlitePool, id: Uuid, category: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE object_store_migration SET phase = 'failed', verify_error = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1",
    )
    .bind(id)
    .bind(category)
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// Mark a verified migration ABANDONED (#65) with a FIXED-VOCABULARY reason. Guarded to a
/// `verified` row (mirrors `mark_cutover`'s activation guard) so an abandon can only close a
/// verified migration — a `copying`/`failed`/`retired` row is untouched. This is the DB half of
/// the abandon: once the row is `abandoned`, `latest_unretired` excludes it, which clears the
/// config-change 409 and stops boot-resume. NEVER a raw error / credential in the reason. Returns
/// the number of rows updated (0 ⇒ the row was not `verified`, so the caller must not treat the
/// abandon as complete).
pub async fn set_abandoned(pool: &SqlitePool, id: Uuid, reason: &str) -> Result<u64, AppError> {
    let res = sqlx::query(
        "UPDATE object_store_migration SET phase = 'abandoned', verify_error = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = $1 AND phase = 'verified'",
    )
    .bind(id)
    .bind(reason)
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}

/// Delete a migration row (#64 R2-F1): used to CLEAN UP a boot-resume anchor when the config PUT
/// that was supposed to advance the config FAILED after the anchor was created — so a transient
/// upsert error can never strand a `pending` orphan that wedges every future store change.
/// Guarded to a `pending` row (an anchor that never started); a running/verified row is untouched.
pub async fn delete_pending_anchor(pool: &SqlitePool, id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM object_store_migration WHERE id = $1 AND phase = 'pending'")
        .bind(id)
        .execute(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(())
}

/// Flip `cost_ack` true (the operator acknowledged a large cross-cloud egress, #64). Idempotent.
pub async fn set_cost_ack(pool: &SqlitePool, id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE object_store_migration SET cost_ack = true, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(())
}

/// Update the live progress counters (called from the copy loop). MONOTONIC: the progress
/// updater fires throttled, unordered detached tasks, so a late one carrying an older (smaller)
/// count could otherwise overwrite the true final count on a `verified` row. `MAX` (the
/// SQLite-spelled `GREATEST`, per the DEC-12 non-literal list — the ITEM-18 record) makes
/// the counters non-decreasing, so a stale write can never regress the displayed progress.
pub async fn update_progress(
    pool: &SqlitePool,
    id: Uuid,
    blobs_done: i64,
    bytes_done: i64,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE object_store_migration \
         SET blobs_done = MAX(blobs_done, $2), bytes_done = MAX(bytes_done, $3), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = $1",
    )
    .bind(id)
    .bind(blobs_done)
    .bind(bytes_done)
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// Fail-SAFE boot reaper: any migration left in a non-terminal RUNNING phase
/// (`copying`/`verifying`) by a process that died mid-copy is marked `failed` at boot. This
/// never turns an incomplete migration into `verified` (the safe direction) and clears the
/// single-active-migration index so a new migration can be started after a restart. Returns the
/// number of rows reaped. Idempotent.
pub async fn reap_interrupted(pool: &SqlitePool) -> Result<u64, AppError> {
    let res = sqlx::query(
        "UPDATE object_store_migration \
         SET phase = 'failed', verify_error = 'interrupted by a restart (start the migration again)', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE phase IN ('copying','verifying')",
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(res.rows_affected())
}
