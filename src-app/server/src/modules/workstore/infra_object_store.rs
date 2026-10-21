//! Admin object-store backend config (#63) — the deployment-level, ENCRYPTED-at-rest
//! config + test-connection for the S3/GCS `ObjectStore`.
//!
//! SECURITY (the #60 no-leak contract, mirrored from `billing/integration.rs`):
//!  - The S3 access-key-id + secret-access-key are stored ENCRYPTED (`bytea`
//!    ciphertext via `ziee_framework::secret::encrypt_secret`, pgcrypto), NEVER
//!    plaintext (INV-1). The GET returns a MASKED view only
//!    (`configured`/`access_key_last4`/`bucket`/`status`) — no endpoint, log, or
//!    error carries the plaintext (INV-2).
//!  - Any in-memory secret is wrapped in `SecretView<String>` at the boundary (INV-3).
//!  - The Test action builds an `S3Store` from the resolved (or a just-typed,
//!    un-persisted) config and runs a lightweight put→get→delete round-trip; it
//!    returns `{ok,message}` from a PURE classifier that emits a fixed-vocabulary
//!    message and NEVER echoes the raw error/credentials (INV-4).
//!  - `#[cfg(feature = "saas")]` (the whole module) + gated on
//!    `infra::settings::manage` (403 otherwise).
//!
//! Env stays the FALLBACK: the DB row is layered over the existing env resolution
//! (`WorkstoreConfig::resolve_with_db`), byte-identical when unconfigured (INV-5).

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::{ApiResult, AppError, ServerConfig};
use ziee_framework::secret::{encrypt_secret, resolve_optional_secret, SecretView};

use crate::modules::permissions::{with_permission, RequirePermissions};

use super::config::{
    resolve_backend_and_s3, ObjectStoreDbConfig, ObjectStoreKind, S3ConnConfig, WorkstoreConfig,
};
use super::object_store::s3::S3Store;
use super::object_store::ObjectStore;
use super::permissions::InfraSettingsManage;

// ───────────────────────────── DTOs ─────────────────────────────

/// The MASKED read view (GET response). Contains NO plaintext secret — only whether
/// each credential is configured, the last-4 of the access key, the non-secret
/// connection config, and the resolved source. The plaintext NEVER appears here.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct InfraObjectStoreView {
    /// Effective backend selection: `"local"` or `"s3"`.
    pub backend: String,
    /// Cloud provider when `backend == "s3"`: `"s3"` or `"gcs"` (else empty).
    pub provider: String,
    /// Endpoint override, or empty for the provider default. Not a secret.
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub path_style: bool,
    /// True when a static access key is resolvable (DB row OR env). Ambient-identity
    /// deployments (no static key) are `false` — that is normal, not "unconfigured".
    pub access_key_configured: bool,
    /// The last 4 chars of the resolved access key (display only), or `None`. NEVER the full key.
    pub access_key_last4: Option<String>,
    /// True when a static secret key is resolvable (DB OR env).
    pub secret_key_configured: bool,
    /// Where the resolved static access key comes from: `"database"`, `"environment"`,
    /// or `"unconfigured"` (ambient identity / none). An operator status, never the value.
    pub status: String,
}

/// PUT request: set/rotate the config. A blank/absent secret field ⇒ leave the stored
/// secret unchanged (a non-secret edit never wipes a credential). A blank/absent
/// non-secret field ⇒ leave that column unchanged.
///
/// No `Debug` derive: it carries the just-typed plaintext credentials, so a `{:?}` must
/// never print them (coding-guidelines §3). The handlers never format the request.
#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateInfraObjectStoreRequest {
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub bucket: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub path_style: Option<bool>,
    /// A NEW access key to store (encrypted). Absent/blank ⇒ unchanged.
    #[serde(default)]
    pub access_key_id: Option<String>,
    /// A NEW secret key to store (encrypted). Absent/blank ⇒ unchanged.
    #[serde(default)]
    pub secret_access_key: Option<String>,
}

impl UpdateInfraObjectStoreRequest {
    /// The access key to store, trimmed, iff a non-blank value was supplied.
    pub fn access_key_to_store(&self) -> Option<&str> {
        self.access_key_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
    /// The secret key to store, iff a non-blank value was supplied.
    pub fn secret_key_to_store(&self) -> Option<&str> {
        self.secret_access_key.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
}

/// POST /test request: validate the STORED/effective config, optionally overriding the
/// two credentials with just-typed candidates WITHOUT persisting them. No `Debug` derive
/// (carries plaintext candidates — coding-guidelines §3).
#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct TestObjectStoreRequest {
    #[serde(default)]
    pub access_key_id: Option<String>,
    #[serde(default)]
    pub secret_access_key: Option<String>,
}

/// POST /test response. Carries a generic operator-facing message — NEVER the secret
/// or the raw backend error (which could name the endpoint/URL).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ObjectStoreTestResponse {
    pub ok: bool,
    pub message: String,
}

// ───────────────────────────── masking ─────────────────────────────

/// The last 4 chars of a secret (UTF-8-safe, never byte-indexed). NEVER the full key.
fn last4_of(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    let start = chars.len().saturating_sub(4);
    chars[start..].iter().collect()
}

// ───────────────────────────── repository ─────────────────────────────

/// The raw `infra_object_store` singleton row. The ciphertext bytes never leave this
/// layer un-decrypted.
#[derive(Debug, Clone)]
pub struct InfraObjectStoreRow {
    pub backend: Option<String>,
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub path_style: Option<bool>,
    pub access_key_ciphertext: Option<Vec<u8>>,
    pub secret_key_ciphertext: Option<Vec<u8>>,
}

/// Read the `infra_object_store` singleton (seeded by the migration, always exactly one row).
pub async fn get_row(pool: &PgPool) -> Result<InfraObjectStoreRow, AppError> {
    let row = sqlx::query!(
        r#"SELECT backend, provider, endpoint, bucket, region, path_style,
                  access_key_ciphertext, secret_key_ciphertext
           FROM infra_object_store WHERE singleton = true"#,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(InfraObjectStoreRow {
        backend: row.backend,
        provider: row.provider,
        endpoint: row.endpoint,
        bucket: row.bucket,
        region: row.region,
        path_style: row.path_style,
        access_key_ciphertext: row.access_key_ciphertext,
        secret_key_ciphertext: row.secret_key_ciphertext,
    })
}

/// Persist a PARTIAL update, stamping the audit `updated_by`/`updated_at`. Each field is
/// applied via SQL `COALESCE($n, col)` so an absent field (`None`) is LEFT UNCHANGED —
/// a non-secret edit never wipes a stored credential. Ciphertexts are pre-encrypted.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_row(
    pool: &PgPool,
    backend: Option<String>,
    provider: Option<String>,
    endpoint: Option<String>,
    bucket: Option<String>,
    region: Option<String>,
    path_style: Option<bool>,
    access_key_ciphertext: Option<Vec<u8>>,
    secret_key_ciphertext: Option<Vec<u8>>,
    updated_by: Uuid,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"UPDATE infra_object_store
           SET backend               = COALESCE($1, backend),
               provider              = COALESCE($2, provider),
               endpoint              = COALESCE($3, endpoint),
               bucket                = COALESCE($4, bucket),
               region                = COALESCE($5, region),
               path_style            = COALESCE($6, path_style),
               access_key_ciphertext = COALESCE($7, access_key_ciphertext),
               secret_key_ciphertext = COALESCE($8, secret_key_ciphertext),
               updated_by            = $9,
               updated_at            = now()
           WHERE singleton = true"#,
        backend,
        provider,
        endpoint,
        bucket,
        region,
        path_style,
        access_key_ciphertext,
        secret_key_ciphertext,
        updated_by,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

// ───────────────────────────── effective config (INV-5) ─────────────────────────────

/// Load the admin DB config (decrypting the two secrets), for layering over env. A DB
/// error or a decrypt failure degrades each affected field to `None` (env fallback),
/// never erroring — exactly as `resolve_optional_secret` does.
pub async fn load_db_config(pool: &PgPool) -> ObjectStoreDbConfig {
    let Ok(row) = get_row(pool).await else {
        return ObjectStoreDbConfig::default();
    };
    let access_key_id = resolve_optional_secret(pool, row.access_key_ciphertext, None).await;
    let secret_access_key = resolve_optional_secret(pool, row.secret_key_ciphertext, None).await;
    ObjectStoreDbConfig {
        backend: row.backend,
        provider: row.provider,
        endpoint: row.endpoint,
        bucket: row.bucket,
        region: row.region,
        path_style: row.path_style,
        access_key_id,
        secret_access_key,
    }
}

/// Resolve the effective `WorkstoreConfig` from the admin DB row layered over env
/// (INV-5). Called at boot (`lib.rs`) so a PUT takes effect at the store-construction
/// seam. An unconfigured row yields byte-identical output to `resolve_for`.
pub async fn resolve_effective_object_store(
    pool: &PgPool,
    config: &ServerConfig,
) -> Result<WorkstoreConfig, AppError> {
    let db = load_db_config(pool).await;
    // FAIL-CLOSED (#69): a bad env backend propagates as Err so boot refuses rather than
    // silently resolving to Local.
    WorkstoreConfig::resolve_with_db(config, &db)
}

/// The effective object-store backend KIND (DB row layered over env) — the coupling-matrix
/// input (#61 INV-1). Used by the compute PUT to refuse a remote-compute + local-store pair.
pub async fn effective_backend(pool: &PgPool) -> Result<ObjectStoreKind, AppError> {
    let db = load_db_config(pool).await;
    let (backend, _s3) = resolve_backend_and_s3(&db)?;
    Ok(backend)
}

/// Capture the CURRENT effective store config as a `PreservedStoreConfig` (#64 DEC-5), INCLUDING
/// the decrypted cloud credentials, BEFORE a PUT overwrites it — so the auto-cutover can preserve
/// it (encrypted at rest) as the restart-safe `DualRead` fallback for ANY pair. The plaintext
/// credentials live only in the returned struct (non-`Debug`) and are dropped after encryption;
/// they are NEVER logged.
pub async fn current_preserved_store_config(
    pool: &PgPool,
) -> Result<super::cutover::PreservedStoreConfig, AppError> {
    let db = load_db_config(pool).await;
    let (backend, s3) = resolve_backend_and_s3(&db)?;
    Ok(match (backend, s3) {
        (ObjectStoreKind::S3, Some(c)) => super::cutover::PreservedStoreConfig {
            backend: "s3".to_string(),
            provider: Some(c.provider.as_str().to_string()),
            endpoint: c.endpoint.clone(),
            bucket: Some(c.bucket.clone()),
            region: Some(c.region.clone()),
            path_style: Some(c.path_style),
            access_key_id: c.access_key_id.clone(),
            secret_access_key: c.secret_access_key.clone(),
        },
        // Local (or an S3 backend with no resolvable conn — treated as local for preservation:
        // there is nothing secret to preserve, and boot rebuilds from the local root).
        _ => super::cutover::PreservedStoreConfig::local(),
    })
}

/// REVERT the persisted `infra_object_store` config to a preserved OLD store config (#65 abandon,
/// DEC-2), stamping the audit `updated_by`. Used when an operator abandons a verified migration: the
/// live handle is already swapped back to the OLD store; this makes the PERSISTED config match, so
/// the primary IS the old store across a restart with zero operator follow-up.
///
/// A LOCAL old store sets `backend='local'` and CLEARS the s3 columns + ciphertexts to NULL (env
/// fallback). A CLOUD old store re-encrypts its credentials and writes every connection field.
/// Returns `Ok(true)` when reverted; `Ok(false)` when a cloud credential could not be re-encrypted
/// (no `storage_key`) — the caller then LEAVES the config for the operator to PUT (the abandon has
/// already cleared the 409), never storing a plaintext credential.
///
/// CRITICAL — this is an ABSOLUTE overwrite (SET col = $n), NOT the COALESCE `upsert_row`: the OLD
/// store must be able to CLEAR a field the NEW store set but the OLD store legitimately leaves unset
/// (e.g. a default-endpoint OLD reverting off a custom-endpoint NEW). A COALESCE merge would retain
/// the NEW endpoint/provider and persist a broken effective config (OLD bucket + NEW host) that a
/// restart would adopt — with `abandoned` excluded from `latest_unretired`, nothing would rescue it.
pub async fn revert_config_to_preserved(
    pool: &PgPool,
    cfg: &super::cutover::PreservedStoreConfig,
    actor: Uuid,
) -> Result<bool, AppError> {
    let storage_key = ziee_framework::secrets::storage_key();
    let nb = |o: &Option<String>| o.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    // Cloud creds must be RE-ENCRYPTED (never stored plaintext). If the old store carried a
    // credential but at-rest encryption is unavailable, refuse the config-revert (Ok(false)); the
    // live handle is already the old store and the 409 is already cleared, so the operator can PUT.
    let (access_ct, secret_ct) = if cfg.backend == "s3" {
        let ak = cfg.access_key_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let sk = cfg.secret_access_key.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let a = match ak {
            Some(p) => encrypt_secret(pool, p, storage_key).await?,
            None => None,
        };
        let s = match sk {
            Some(p) => encrypt_secret(pool, p, storage_key).await?,
            None => None,
        };
        // A cloud old store that carried a credential we could NOT re-encrypt ⇒ refuse the revert
        // (never store plaintext); the caller leaves the config for the operator to PUT.
        if (ak.is_some() && a.is_none()) || (sk.is_some() && s.is_none()) {
            return Ok(false);
        }
        (a, s)
    } else {
        // LOCAL old store: clear the s3 columns + ciphertexts to NULL so no stale NEW-cloud field
        // (endpoint/bucket/creds) survives to break resolution or linger at rest.
        (None, None)
    };
    // ABSOLUTE overwrite — every column is set to the OLD value (NULL where OLD is unset), so a NEW
    // field the OLD store leaves unset is CLEARED, never retained.
    sqlx::query!(
        r#"UPDATE infra_object_store
           SET backend               = $1,
               provider              = $2,
               endpoint              = $3,
               bucket                = $4,
               region                = $5,
               path_style            = $6,
               access_key_ciphertext = $7,
               secret_key_ciphertext = $8,
               updated_by            = $9,
               updated_at            = now()
           WHERE singleton = true"#,
        cfg.backend,
        nb(&cfg.provider),
        nb(&cfg.endpoint),
        nb(&cfg.bucket),
        nb(&cfg.region),
        cfg.path_style,
        access_ct,
        secret_ct,
        actor,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(true)
}

// ───────────────────────────── masked view ─────────────────────────────

/// Build the MASKED view: derive `access_key_last4`/status from the effective secret
/// source WITHOUT ever emitting plaintext. The resolved plaintext is held in a
/// `SecretView<String>` and dropped here.
pub async fn build_view(pool: &PgPool) -> Result<InfraObjectStoreView, AppError> {
    let db = load_db_config(pool).await;
    let (backend, s3) = resolve_backend_and_s3(&db)?;

    // The effective static access key + its source (DB row wins over env), so `status`
    // reflects what the resolver would actually USE.
    let env_ak = std::env::var("AWS_ACCESS_KEY_ID").ok().filter(|s| !s.is_empty());
    let env_sk = std::env::var("AWS_SECRET_ACCESS_KEY").ok().filter(|s| !s.is_empty());
    // The effective access key + its source (DB row wins over env), for last4/flags.
    let (access_key_last4, access_key_configured, secret_key_configured, key_source) =
        if let Some(ak) = db.access_key_id.as_deref() {
            let sv = SecretView::new(ak.to_string());
            (Some(last4_of(sv.expose_secret())), true, db.secret_access_key.is_some(), "database")
        } else if let Some(ak) = env_ak {
            let sv = SecretView::new(ak);
            (Some(last4_of(sv.expose_secret())), true, env_sk.is_some(), "environment")
        } else {
            (None, false, false, "none")
        };
    // Status reflects WHERE the effective config comes from — any DB-row config
    // (backend/bucket/creds) is "database" even under ambient identity (no static key),
    // mirroring the compute surface; else the env fallback; else unconfigured.
    let status = if !db.is_empty() {
        "database"
    } else if key_source == "environment" {
        "environment"
    } else {
        "unconfigured"
    };

    let (provider, endpoint, bucket, region, path_style) = match &s3 {
        Some(s3) => (
            s3.provider.as_str().to_string(),
            s3.endpoint.clone().unwrap_or_default(),
            s3.bucket.clone(),
            s3.region.clone(),
            s3.path_style,
        ),
        None => (String::new(), String::new(), String::new(), String::new(), false),
    };

    let backend_label = match backend {
        ObjectStoreKind::Local => "local",
        ObjectStoreKind::S3 => "s3",
    };
    Ok(InfraObjectStoreView {
        backend: backend_label.to_string(),
        provider,
        endpoint,
        bucket,
        region,
        path_style,
        access_key_configured,
        access_key_last4,
        secret_key_configured,
        status: status.to_string(),
    })
}

// ───────────────────────────── test-connection ─────────────────────────────

/// PURE classifier: map a probe outcome to `{ok,message}`. A failure emits a
/// FIXED-VOCABULARY category derived from the error KIND — it NEVER echoes the raw
/// error string or any credential (INV-4). Only the derived category is logged server-side;
/// the raw error is DISCARDED, never logged or returned.
pub fn classify_object_store_test(outcome: Result<(), String>) -> ObjectStoreTestResponse {
    match outcome {
        Ok(()) => ObjectStoreTestResponse {
            ok: true,
            message: "Connection succeeded: put/get/delete round-trip against the configured object store.".to_string(),
        },
        Err(reason) => ObjectStoreTestResponse {
            ok: false,
            message: format!("Connection failed — {}.", failure_category(&reason)),
        },
    }
}

/// Map a raw backend error to a FIXED category string (no raw text, no secret ever).
fn failure_category(reason: &str) -> &'static str {
    let r = reason.to_ascii_lowercase();
    if r.contains("403")
        || r.contains("forbidden")
        || r.contains("signature")
        || r.contains("access denied")
        || r.contains("invalidaccesskey")
        || r.contains("unauthorized")
    {
        "authentication rejected (check the access key and secret)"
    } else if r.contains("nosuchbucket") || r.contains("bucket") || r.contains("404") {
        "bucket not found (check the bucket name and region)"
    } else if r.contains("timed out") || r.contains("timeout") {
        "connection timed out (check the endpoint and network)"
    } else if r.contains("dns")
        || r.contains("resolve")
        || r.contains("connection refused")
        || r.contains("connect")
        || r.contains("no route")
    {
        "endpoint unreachable (check the endpoint URL)"
    } else {
        "check the endpoint, bucket, region, and credentials"
    }
}

/// Run the round-trip probe against a resolved config. Local backend ⇒ `Ok(())` (the
/// caller renders the local-noop message). S3 ⇒ put a tiny probe blob, read it back,
/// assert the bytes match, delete it.
async fn probe_object_store(
    backend: ObjectStoreKind,
    s3: Option<&S3ConnConfig>,
) -> Result<(), String> {
    match backend {
        ObjectStoreKind::Local => Ok(()),
        ObjectStoreKind::S3 => {
            let s3cfg =
                s3.ok_or_else(|| "s3 backend selected but no connection config".to_string())?;
            let store = S3Store::from_conn(s3cfg).map_err(|e| e.to_string())?;
            let probe = format!("cyto-infra-probe-{}", Uuid::new_v4());
            let key = store.put(probe.as_bytes()).await.map_err(|e| e.to_string())?;
            // Once the probe blob is written, delete it on EVERY exit path (get failure,
            // byte mismatch, success) so a failed probe never orphans an object.
            let got = match store.get(&key).await {
                Ok(g) => g,
                Err(e) => {
                    let _ = store.delete(&key).await;
                    return Err(e.to_string());
                }
            };
            let del = store.delete(&key).await;
            if got != probe.as_bytes() {
                return Err("round-trip byte mismatch".to_string());
            }
            del.map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

// ───────────────────────────── handlers ─────────────────────────────

async fn get_object_store(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<InfraObjectStoreView>> {
    let view = build_view(&pool).await.map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(view)))
}

fn get_object_store_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.getInfraObjectStore")
        .tag("admin")
        .summary("Read the masked object-store backend config (no plaintext secret).")
        .response::<200, Json<InfraObjectStoreView>>()
}

async fn put_object_store(
    auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<UpdateInfraObjectStoreRequest>,
) -> ApiResult<Json<InfraObjectStoreView>> {
    // FAIL-CLOSED (#70): VALIDATE the backend override at the boundary BEFORE any persistence.
    // An unrecognized value (e.g. a mis-typed "gcs") is refused with a clean 422 here, so it can
    // never be stored and later silently resolve to the local-fs store (the #69 data-loss hazard
    // on the admin-override path). Absent/blank ⇒ leave the stored backend unchanged.
    super::config::validate_admin_backend(req.backend.as_deref()).map_err(|e| e.to_api_error())?;
    // COUPLING GUARD (#61 INV-1): refuse a PUT that would select an object store INCOMPATIBLE
    // with the effective compute backend BEFORE persisting. The one invalid pairing is remote
    // (kubernetes) compute + a Local object store — a cluster pod cannot read the host FS.
    // The prospective store backend is this PUT's `backend` override else the stored/env one.
    {
        let current = load_db_config(&pool).await;
        let prospective_backend = req
            .backend
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or(current.backend);
        let store_kind = super::config::merge_backend(
            super::config::backend_from_env(std::env::var("CYTO_WORKSTORE_BACKEND").ok().as_deref())
                .map_err(|e| e.to_api_error())?,
            prospective_backend.as_deref(),
        )
        .map_err(|e| e.to_api_error())?;
        let compute = super::backend_compat::ComputeKind::from_backend_str(
            &crate::modules::sandbox::infra_compute::effective_backend(&pool).await,
        );
        super::backend_compat::check_backend_compat_api(compute, store_kind)
            .map_err(|e| e.to_api_error())?;
    }
    // Capture the effective store config (incl. decrypted creds) BEFORE the upsert — the
    // auto-cutover (#64 DEC-5) preserves it (encrypted) as the restart-safe fallback.
    let old_store_cfg = current_preserved_store_config(&pool).await.map_err(|e| e.to_api_error())?;
    let storage_key = ziee_framework::secrets::storage_key();
    let access_ct = match req.access_key_to_store() {
        Some(p) => Some(encrypt_or_refuse(&pool, p, storage_key).await?),
        None => None,
    };
    let secret_ct = match req.secret_key_to_store() {
        Some(p) => Some(encrypt_or_refuse(&pool, p, storage_key).await?),
        None => None,
    };
    // #64 DEC-5 (data-loss audit R1-F2/F3): if this PUT CHANGES the effective store, SECURE the
    // boot-resume anchor (a migration row preserving the OLD config, encrypted) BEFORE advancing the
    // config — and REFUSE the PUT (config unchanged) if the change cannot be made restart-safe. This
    // is the ordering that guarantees a crash/restart mid-switch never boots onto a bare NEW store
    // that strands the OLD data.
    let prepared = super::migration_api::prepare_store_change(&pool, &old_store_cfg, &req, auth.user.id)
        .await
        .map_err(|e| e.to_api_error())?;
    let non_empty = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Err(e) = upsert_row(
        &pool,
        non_empty(req.backend),
        non_empty(req.provider),
        non_empty(req.endpoint),
        non_empty(req.bucket),
        non_empty(req.region),
        req.path_style,
        access_ct,
        secret_ct,
        auth.user.id,
    )
    .await
    {
        // The config did NOT advance — clean up the boot-resume anchor prepared above so a transient
        // upsert failure cannot strand a `pending` orphan that would wedge every future store change.
        if let Some(plan) = &prepared {
            super::migration_api::abandon_prepared_change(&pool, plan).await;
        }
        return Err(e.to_api_error());
    }
    // The config is now advanced AND the boot-resume anchor is secured (or there was no change).
    // Launch the copy+verify + live cutover for a prepared change (anchor-only plans — a parked
    // cost-ack or a switch-to-local — do nothing here; they are already restart-safe).
    if let Some(plan) = prepared {
        super::migration_api::launch_prepared_cutover(&pool, plan);
    }
    let view = build_view(&pool).await.map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(view)))
}

fn put_object_store_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.putInfraObjectStore")
        .tag("admin")
        .summary("Set/rotate the object-store backend config (secrets encrypted at rest).")
        .response::<200, Json<InfraObjectStoreView>>()
        .response_with::<400, (), _>(|r| r.description("At-rest encryption not configured"))
}

async fn test_object_store(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<TestObjectStoreRequest>,
) -> ApiResult<Json<ObjectStoreTestResponse>> {
    // Effective config = the stored/env config, with the two credentials optionally
    // overridden by just-typed candidates (tested WITHOUT persisting).
    let mut db = load_db_config(&pool).await;
    if let Some(ak) = req.access_key_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        db.access_key_id = Some(ak.to_string());
    }
    if let Some(sk) = req.secret_access_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        db.secret_access_key = Some(sk.to_string());
    }
    let (backend, s3) = resolve_backend_and_s3(&db).map_err(|e| e.to_api_error())?;

    if backend == ObjectStoreKind::Local {
        return Ok((
            StatusCode::OK,
            Json(ObjectStoreTestResponse {
                ok: true,
                message: "Using the local filesystem store; no cloud connection to test.".to_string(),
            }),
        ));
    }

    let outcome = probe_object_store(backend, s3.as_ref()).await;
    if let Err(ref reason) = outcome {
        // Log the derived CATEGORY server-side (not the raw error, not the secret).
        tracing::warn!(category = failure_category(reason), "object-store test-connection failed");
    }
    Ok((StatusCode::OK, Json(classify_object_store_test(outcome))))
}

fn test_object_store_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.testInfraObjectStore")
        .tag("admin")
        .summary("Test the object-store connection (put/get/delete round-trip). Returns {ok,message}.")
        .response::<200, Json<ObjectStoreTestResponse>>()
}

/// Encrypt a supplied plaintext secret, or refuse with a clean 400 when at-rest
/// encryption is not configured (`secrets.storage_key` unset) — NEVER store plaintext.
async fn encrypt_or_refuse(
    pool: &PgPool,
    plain: &str,
    storage_key: Option<&str>,
) -> Result<Vec<u8>, (StatusCode, AppError)> {
    match encrypt_secret(pool, plain, storage_key).await {
        Ok(Some(ct)) => Ok(ct),
        Ok(None) => Err(AppError::bad_request(
            "SECRET_STORAGE_DISABLED",
            "At-rest secret encryption is not configured (set secrets.storage_key). \
             Cannot store an object-store credential; use the AWS_* env vars instead.",
        )
        .to_api_error()),
        Err(e) => Err(e.to_api_error()),
    }
}

/// The `/api/admin/infra/object-store*` routes (mounted only in a saas binary).
pub fn routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/admin/infra/object-store",
            get_with(get_object_store, get_object_store_docs)
                .put_with(put_object_store, put_object_store_docs),
        )
        .api_route(
            "/admin/infra/object-store/test",
            post_with(test_object_store, test_object_store_docs),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1 [covers: ITEM-2]: the masked view serializes with NO secret field.
    #[test]
    fn view_has_no_secret_field() {
        let view = InfraObjectStoreView {
            backend: "s3".into(),
            provider: "s3".into(),
            endpoint: "http://minio:9000".into(),
            bucket: "cyto-worklab".into(),
            region: "us-east-1".into(),
            path_style: true,
            access_key_configured: true,
            access_key_last4: Some("AKIA".into()),
            secret_key_configured: true,
            status: "database".into(),
        };
        let json = serde_json::to_string(&view).unwrap();
        assert!(json.contains("\"access_key_last4\":\"AKIA\""));
        assert!(!json.contains("ciphertext"));
        assert!(!json.contains("secret_access_key"));
        assert!(!json.contains("access_key_id"));
    }

    // TEST-3 [covers: ITEM-2]: blank/absent secret ⇒ leave-unchanged (None).
    #[test]
    fn blank_secret_is_leave_unchanged() {
        let absent: UpdateInfraObjectStoreRequest =
            serde_json::from_str(r#"{"bucket":"b"}"#).unwrap();
        assert!(absent.access_key_to_store().is_none());
        assert!(absent.secret_key_to_store().is_none());

        let blank: UpdateInfraObjectStoreRequest =
            serde_json::from_str(r#"{"access_key_id":"   ","secret_access_key":""}"#).unwrap();
        assert!(blank.access_key_to_store().is_none());
        assert!(blank.secret_key_to_store().is_none());

        let set: UpdateInfraObjectStoreRequest =
            serde_json::from_str(r#"{"access_key_id":" AKIA123 ","secret_access_key":"shh"}"#).unwrap();
        assert_eq!(set.access_key_to_store(), Some("AKIA123"));
        assert_eq!(set.secret_key_to_store(), Some("shh"));
    }

    // TEST-5 [covers: ITEM-4] [invariant: INV-4]: the classifier maps Ok/Err → {ok,message}
    // and the failure message NEVER contains the raw error text or any credential — it is a
    // fixed-vocabulary category. Feeding an error that embeds a secret proves the no-leak
    // contract: flip the promise (echo the raw error) and this assertion goes red.
    #[test]
    fn classifier_never_leaks_the_secret_or_raw_error() {
        let ok = classify_object_store_test(Ok(()));
        assert!(ok.ok);

        let leaky = "SignatureDoesNotMatch: key=AKIAEXAMPLESECRET123 secret=TOPSECRETshh";
        let bad = classify_object_store_test(Err(leaky.to_string()));
        assert!(!bad.ok);
        assert!(!bad.message.contains("AKIAEXAMPLESECRET123"), "access key leaked: {}", bad.message);
        assert!(!bad.message.contains("TOPSECRETshh"), "secret leaked: {}", bad.message);
        // The category is derived (authentication) but carries none of the raw text.
        assert!(bad.message.to_lowercase().contains("authentication"));

        // A generic unknown error still yields a fixed message with no raw text.
        let generic = classify_object_store_test(Err("weird internal thing xyzzy".to_string()));
        assert!(!generic.message.contains("xyzzy"));
    }

    // last4 shows the tail only.
    #[test]
    fn last4_shows_tail_only() {
        assert_eq!(last4_of("AKIAIOSFODNN7EXAMPLE"), "MPLE");
        assert_eq!(last4_of("ab"), "ab");
        assert_eq!(last4_of(""), "");
    }
}
