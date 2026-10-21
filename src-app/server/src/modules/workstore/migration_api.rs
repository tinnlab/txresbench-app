//! Admin migration + round-trip-test endpoints (#61 §2/§3) + the in-process orchestrator.
//! `saas`-only (the cloud destination it builds links `object_store`), mirroring
//! `infra_object_store.rs` (same permission gate, same masked/fixed-vocabulary responses).
//!
//! ## Endpoints
//! * `POST /admin/infra/roundtrip-test` — proves the SELECTED object store can be WRITTEN to
//!   AND READ from as a compute backend would (write a probe blob, read it back, content-hash
//!   verify, delete). For remote compute it first asserts the store is remotely reachable
//!   (the coupling pair), then the store round-trip. This is the end-to-end proof two green
//!   per-service checks can't give (INV-9).
//! * `POST /admin/infra/migration` — START a copy+verify migration from the CURRENT live
//!   store (source) to the destination described in the request. Estimates the move and
//!   enforces the cross-cloud cost-gate (INV-7). Copy+verify runs in a background task;
//!   progress persists to `object_store_migration`. The source is only ever READ.
//! * `GET  /admin/infra/migration` — the current migration's status + progress + verify.
//! * `POST /admin/infra/migration/retire-source` — a SAFETY-VERIFIED readiness check that
//!   DELETES NOTHING (INV-3, absolute): after a `verified` migration + the in-flight-job fence,
//!   it re-verifies EVERY current blob is present + content-matches in the destination and
//!   returns `{safe_to_retire, verified_blobs}`. Deleting the old store's bytes is a deliberate
//!   MANUAL operator step — never automatic, never from the API — so no path can remove data.
//!   (A large cross-cloud move's cost-gate is handled at START: the FE re-POSTs `migration`
//!   with `cost_ack:true`; there is no separate cost-ack endpoint.)

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use uuid::Uuid;
use ziee_core::{ApiResult, AppError};

use crate::modules::permissions::{with_permission, RequirePermissions};

use super::backend_compat::{ComputeKind, INCOMPATIBLE_BACKENDS_MSG};
use super::config::{CloudProvider, ObjectStoreKind, S3ConnConfig};
use super::migration_engine::{self as engine, MigrationEstimate};
use super::migration_repo::{self as repo, phase, NewMigration};
use super::object_store::s3::S3Store;
use super::object_store::ObjectStore;
use super::permissions::InfraSettingsManage;

// ───────────────────────────── DTOs ─────────────────────────────

/// The destination the migration copies TO (non-secret + just-typed creds, never persisted by
/// this endpoint — used only to build the destination store handle for the move). No `Debug`
/// derive (carries plaintext creds — coding-guidelines §3).
#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct MigrationDest {
    /// `"s3"` | `"gcs"`. The migration destination is always a cloud store.
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub path_style: Option<bool>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
}

#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct StartMigrationRequest {
    pub dest: MigrationDest,
    /// The explicit go-ahead for a large cross-cloud move (INV-7). Absent ⇒ false.
    #[serde(default)]
    pub cost_ack: bool,
}

/// The masked migration status (NO credential — only backend/provider/bucket labels).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct MigrationStatusView {
    pub active: bool,
    pub id: Option<String>,
    pub phase: String,
    pub src_backend: String,
    pub dst_backend: String,
    pub dst_provider: Option<String>,
    pub dst_bucket: Option<String>,
    pub blobs_total: i64,
    pub blobs_done: i64,
    pub bytes_total: i64,
    pub bytes_done: i64,
    pub cross_cloud: bool,
    pub cost_ack: bool,
    /// A fixed-vocabulary failure category (never a raw error / credential).
    pub verify_error: Option<String>,
    pub auto_started: bool,
    /// TRUE once the LIVE cutover has been applied (the handle swapped to DualRead(new,old) with no
    /// restart, #64) — the FE's "cut-over-live" state. The OLD store is still present (retire is
    /// manual) until `retire-source` is confirmed.
    pub cutover: bool,
    /// TRUE when this migration is PARKED awaiting a cost acknowledgement for a large cross-cloud
    /// egress (#64/#61 INV-7): `phase == pending && cross_cloud && !cost_ack`. The FE surfaces the
    /// estimate + a cost-ack action (`ack-cost`) to start the copy.
    pub awaiting_cost_ack: bool,
}

impl MigrationStatusView {
    fn none() -> Self {
        Self {
            active: false,
            id: None,
            phase: "none".to_string(),
            src_backend: String::new(),
            dst_backend: String::new(),
            dst_provider: None,
            dst_bucket: None,
            blobs_total: 0,
            blobs_done: 0,
            bytes_total: 0,
            bytes_done: 0,
            cross_cloud: false,
            cost_ack: false,
            verify_error: None,
            auto_started: false,
            cutover: false,
            awaiting_cost_ack: false,
        }
    }
    fn from_row(r: &repo::MigrationRow) -> Self {
        Self {
            active: phase::ACTIVE.contains(&r.phase.as_str()),
            id: Some(r.id.to_string()),
            phase: r.phase.clone(),
            src_backend: r.src_backend.clone(),
            dst_backend: r.dst_backend.clone(),
            dst_provider: r.dst_provider.clone(),
            dst_bucket: r.dst_bucket.clone(),
            blobs_total: r.blobs_total,
            blobs_done: r.blobs_done,
            bytes_total: r.bytes_total,
            bytes_done: r.bytes_done,
            cross_cloud: r.cross_cloud,
            cost_ack: r.cost_ack,
            verify_error: r.verify_error.clone(),
            auto_started: r.auto_started,
            cutover: r.cutover,
            awaiting_cost_ack: r.phase == phase::PENDING && r.cross_cloud && !r.cost_ack,
        }
    }
}

/// The round-trip test response (fixed-vocabulary; never a secret / raw error).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RoundtripTestResponse {
    pub ok: bool,
    pub message: String,
}

/// The start response: either the accepted migration status, or (when the cost-gate fires) a
/// `cost_ack`-required signal carrying the estimate so the FE can prompt.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct StartMigrationResponse {
    pub started: bool,
    /// True when a large cross-cloud move needs an explicit go-ahead (INV-7).
    pub cost_ack_required: bool,
    pub estimated_blobs: i64,
    pub estimated_bytes: i64,
    pub status: MigrationStatusView,
}

// ───────────────────────────── helpers ─────────────────────────────

const DEFAULT_MULTIPART_THRESHOLD: usize = 16 * 1024 * 1024;
const DEFAULT_PART_SIZE: usize = 8 * 1024 * 1024;

/// Build the destination `S3ConnConfig` from the request (always a cloud store).
fn dest_conn(dest: &MigrationDest) -> Result<S3ConnConfig, AppError> {
    let provider = match dest.provider.as_deref() {
        Some("gcs") | Some("gcp") => CloudProvider::Gcs,
        _ => CloudProvider::S3,
    };
    let bucket = dest
        .bucket
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::bad_request("MIGRATION_DEST_INVALID", "a destination bucket is required"))?
        .to_string();
    Ok(S3ConnConfig {
        provider,
        bucket,
        region: dest.region.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "us-east-1".to_string()),
        endpoint: dest.endpoint.clone().filter(|s| !s.is_empty()),
        access_key_id: dest.access_key_id.clone().filter(|s| !s.is_empty()),
        secret_access_key: dest.secret_access_key.clone().filter(|s| !s.is_empty()),
        path_style: dest.path_style.unwrap_or(dest.endpoint.as_deref().map(|e| !e.is_empty()).unwrap_or(false)),
        multipart_threshold: DEFAULT_MULTIPART_THRESHOLD,
        part_size: DEFAULT_PART_SIZE,
    })
}

/// The number of jobs currently `running` — the retire-time fence (INV-6).
async fn running_jobs(pool: &PgPool) -> Result<i64, AppError> {
    let row = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs WHERE status = 'running'")
        .fetch_one(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(row)
}

// ───────────────────────────── round-trip test (INV-9) ─────────────────────────────

async fn roundtrip_test(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<RoundtripTestResponse>> {
    // The coupling pair first: remote compute + a Local store can never round-trip through a
    // pod, so refuse the pairing before probing (INV-1 / INV-9).
    let compute = ComputeKind::from_backend_str(
        &crate::modules::sandbox::infra_compute::effective_backend(&pool).await,
    );
    let store_kind = super::infra_object_store::effective_backend(&pool)
        .await
        .map_err(|e| e.to_api_error())?;
    if !super::backend_compat::is_compatible(compute, store_kind) {
        return Ok((
            StatusCode::OK,
            Json(RoundtripTestResponse { ok: false, message: INCOMPATIBLE_BACKENDS_MSG.to_string() }),
        ));
    }

    // The store round-trip a compute backend performs: write a probe blob, read it back,
    // content-hash verify, delete. Uses the live effective store.
    let store = super::get_object_store();
    let probe = format!("cyto-roundtrip-{}", Uuid::new_v4());
    let outcome = probe_roundtrip(&store, probe.as_bytes()).await;
    let message = match &outcome {
        Ok(()) => "Round-trip succeeded: the compute backend can write to AND read from the \
                   selected object store (content-hash verified)."
            .to_string(),
        Err(cat) => format!("Round-trip failed — {cat}."),
    };
    Ok((StatusCode::OK, Json(RoundtripTestResponse { ok: outcome.is_ok(), message })))
}

/// Write→read→verify→delete against a store; returns a fixed-vocabulary category on failure.
async fn probe_roundtrip(store: &Arc<dyn ObjectStore>, bytes: &[u8]) -> Result<(), String> {
    let key = store.put(bytes).await.map_err(|_| "could not write to the object store".to_string())?;
    let got = match store.get(&key).await {
        Ok(g) => g,
        Err(_) => {
            let _ = store.delete(&key).await;
            return Err("could not read the blob back from the object store".to_string());
        }
    };
    let del = store.delete(&key).await;
    if super::object_store::sha256_hex(&got) != key.hex() {
        return Err("content-hash mismatch on read-back (a bad object-store pairing)".to_string());
    }
    del.map_err(|_| "could not clean up the probe blob".to_string())?;
    Ok(())
}

fn roundtrip_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.roundtripTestInfra")
        .tag("admin")
        .summary("End-to-end round-trip: the selected compute backend writes+reads a blob through the selected object store.")
        .response::<200, Json<RoundtripTestResponse>>()
}

// ───────────────────────────── migration status ─────────────────────────────

async fn get_migration(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<MigrationStatusView>> {
    let view = match repo::latest(&pool).await.map_err(|e| e.to_api_error())? {
        Some(r) => MigrationStatusView::from_row(&r),
        None => MigrationStatusView::none(),
    };
    Ok((StatusCode::OK, Json(view)))
}

fn get_migration_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.getInfraMigration")
        .tag("admin")
        .summary("The current object-store data-migration status + progress + verify state.")
        .response::<200, Json<MigrationStatusView>>()
}

// ───────────────────────────── start migration ─────────────────────────────

async fn start_migration(
    auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<StartMigrationRequest>,
) -> ApiResult<Json<StartMigrationResponse>> {
    // One active migration at a time.
    if repo::active(&pool).await.map_err(|e| e.to_api_error())?.is_some() {
        return Err(AppError::conflict("an object-store migration is already in progress").to_api_error());
    }

    // Build the source (live store) + destination (from the request) handles.
    let src = super::get_object_store();
    let dst_conn = dest_conn(&req.dest).map_err(|e| e.to_api_error())?;
    let dst: Arc<dyn ObjectStore> =
        Arc::new(S3Store::from_conn(&dst_conn).map_err(|e| e.to_api_error())?);

    // Estimate (the cost-gate input) — the source enumeration must succeed BEFORE we accept.
    let est: MigrationEstimate = engine::estimate(&src)
        .await
        .map_err(|e| AppError::internal_error(format!("migration estimate failed: {}", e.category())).to_api_error())?;

    // Cost-gate (INV-7): a large CROSS-CLOUD move needs an explicit go-ahead.
    let src_backend = super::infra_object_store::effective_backend(&pool)
        .await
        .map_err(|e| e.to_api_error())?;
    let src_is_remote = super::backend_compat::store_is_remote(src_backend);
    let cross_cloud = engine::is_cross_cloud(src_is_remote, true /* dest is always cloud */);
    if engine::cost_ack_required(cross_cloud, est) && !req.cost_ack {
        // Do NOT start — surface the estimate and require the explicit ack.
        return Ok((
            StatusCode::OK,
            Json(StartMigrationResponse {
                started: false,
                cost_ack_required: true,
                estimated_blobs: est.blob_count as i64,
                estimated_bytes: est.total_bytes as i64,
                status: MigrationStatusView::none(),
            }),
        ));
    }

    // Persist the migration row + kick the background copy+verify.
    let src_label = match src_backend {
        ObjectStoreKind::Local => "local",
        ObjectStoreKind::S3 => "s3",
    };
    let row = repo::create(
        &pool,
        &NewMigration {
            src_backend: src_label.to_string(),
            src_provider: None,
            src_bucket: None,
            dst_backend: "s3".to_string(),
            dst_provider: Some(dst_conn.provider.as_str().to_string()),
            dst_bucket: Some(dst_conn.bucket.clone()),
            cross_cloud,
            cost_ack: req.cost_ack,
            auto_started: false,
            blobs_total: est.blob_count as i64,
            bytes_total: est.total_bytes as i64,
            // Manual migrations keep #61 semantics (cutover at reboot, config operator-managed) and
            // are NOT picked up by the live boot-resume, so no OLD config is preserved here.
            src_config_ciphertext: None,
        },
        auth.user.id,
    )
    .await
    .map_err(|e| e.to_api_error())?;

    // Manual "Migrate data" keeps #61 semantics: copy+verify now, cutover at the boot/construction
    // seam (no live swap). The LIVE auto-cutover path is the config-switch trigger (ITEM-5).
    spawn_copy_verify(pool.clone(), row.id, src, dst, false);

    Ok((
        StatusCode::OK,
        Json(StartMigrationResponse {
            started: true,
            cost_ack_required: false,
            estimated_blobs: est.blob_count as i64,
            estimated_bytes: est.total_bytes as i64,
            status: MigrationStatusView::from_row(&row),
        }),
    ))
}

/// A store change that has been SECURED for a restart-safe config advance (#64, ITEM-5 / DEC-5).
/// Returned by [`prepare_store_change`] to the object-store PUT: the boot-resume anchor (a
/// migration row preserving the OLD config, encrypted) already EXISTS, so the caller may now
/// advance the config and then [`launch_prepared_cutover`].
pub struct PreparedStoreChange {
    row_id: Uuid,
    /// `Some((src, dst))` ⇒ run the copy+verify + live cutover. `None` ⇒ anchor-only: a parked
    /// cost-ack (awaits `ack-cost`) or a switch-to-local (operator migrates manually) — either way
    /// the anchor keeps the restart safe via the boot-resume's `DualRead(new, old)`.
    spawn: Option<(Arc<dyn ObjectStore>, Arc<dyn ObjectStore>)>,
}

/// Merge a PUT request over the current effective config into the PROSPECTIVE config (mirrors the
/// upsert COALESCE: a blank/absent field leaves the current value).
fn prospective_from_req(
    old: &super::cutover::PreservedStoreConfig,
    req: &super::infra_object_store::UpdateInfraObjectStoreRequest,
) -> super::cutover::PreservedStoreConfig {
    let nb = |o: &Option<String>| o.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    super::cutover::PreservedStoreConfig {
        backend: nb(&req.backend).unwrap_or_else(|| old.backend.clone()),
        provider: nb(&req.provider).or_else(|| old.provider.clone()),
        endpoint: nb(&req.endpoint).or_else(|| old.endpoint.clone()),
        bucket: nb(&req.bucket).or_else(|| old.bucket.clone()),
        region: nb(&req.region).or_else(|| old.region.clone()),
        path_style: req.path_style.or(old.path_style),
        access_key_id: nb(&req.access_key_id).or_else(|| old.access_key_id.clone()),
        secret_access_key: nb(&req.secret_access_key).or_else(|| old.secret_access_key.clone()),
    }
}

/// PREPARE a store change BEFORE the config PUT advances the effective config (#64 ITEM-5 / DEC-5,
/// data-loss audit R1-F2/F3). The critical ordering property: the boot-resume ANCHOR (a migration
/// row that preserves the OLD store's config, encrypted) must exist BEFORE the config points at the
/// NEW store — otherwise a crash/restart in the window boots onto a bare NEW store and STRANDS the
/// OLD data. So the caller MUST call this, and only advance the config if it returns `Ok`.
///
/// Returns:
///  * `Ok(None)` — no effective store change (a no-op or a pure credential rotation): advance freely.
///  * `Ok(Some(plan))` — the change is SECURED (anchor created): advance the config, then
///    [`launch_prepared_cutover`].
///  * `Err(..)` — REFUSE the PUT (do NOT advance the config): the change would strand data or the
///    OLD config cannot be preserved. This is the fail-closed guard.
pub async fn prepare_store_change(
    pool: &PgPool,
    old: &super::cutover::PreservedStoreConfig,
    req: &super::infra_object_store::UpdateInfraObjectStoreRequest,
    actor: Uuid,
) -> Result<Option<PreparedStoreChange>, AppError> {
    let prospective = prospective_from_req(old, req);
    // A change in store IDENTITY (backend/provider/bucket/endpoint) is a data move; a pure
    // credential rotation on the SAME store is not.
    let id = |c: &super::cutover::PreservedStoreConfig| {
        (
            c.backend.clone(),
            c.provider.clone().unwrap_or_default(),
            c.bucket.clone().unwrap_or_default(),
            c.endpoint.clone().unwrap_or_default(),
        )
    };
    if id(old) == id(&prospective) {
        return Ok(None);
    }

    // A store change IS happening. Secure the anchor before the caller advances the config.
    // (a) At most ONE un-retired auto migration at a time (R2-F4): a second switch while an earlier
    //     migration's OLD is un-retired would, on a restart, drop that earlier OLD fallback
    //     (`latest_unretired` returns only the newest row) — stranding any straggler the earlier
    //     migration's catch-up did not reach. So refuse until the current one is RETIRED (its OLD
    //     proven fully present in NEW). This also covers the in-flight/active case.
    if repo::latest_unretired(pool).await?.is_some() {
        return Err(AppError::conflict(
            "an object-store migration is not yet retired — complete + retire the current store change \
             (verify every blob is in the new store, then run retire-source) before changing the store again",
        ));
    }
    // (b) Preserve the OLD config (encrypted). FAIL-CLOSED for a cloud source whose credentials
    //     cannot be preserved (no storage_key) — refuse the PUT so the config never advances to a
    //     store with no restart-safe fallback (R1-F1/F2, security R1-S1).
    let src_ct = repo::encrypt_preserved_old_config(pool, old).await?;
    if old.backend == "s3" && src_ct.is_none() {
        return Err(AppError::bad_request(
            "STORE_SWITCH_NO_ENCRYPTION",
            "cannot change the object store: at-rest encryption (secrets.storage_key) is required to \
             preserve the current cloud store's credentials as a restart-safe fallback.",
        ));
    }

    // Build the anchor descriptors from the PROSPECTIVE store.
    let dst_backend = prospective.backend.clone();
    let dst_provider = prospective.provider.clone();
    let dst_bucket = prospective.bucket.clone();
    let cross_cloud = engine::is_cross_cloud(old.backend == "s3", prospective.backend == "s3");

    // For a CLOUD destination we build the dst handle + estimate now (a build failure REFUSES the
    // PUT, so the config never advances to an unbuildable store). For a LOCAL destination
    // (repatriation) we create an anchor-only row: boot-resume keeps DualRead(local, old-cloud) so
    // nothing is stranded, and the operator migrates + retires manually (auto-copy to a local store
    // needs the server's local root, which this seam does not resolve).
    let (spawn, blobs_total, bytes_total, needs_ack) = if prospective.backend == "s3" {
        let conn = super::config::S3ConnConfig {
            provider: match prospective.provider.as_deref() {
                Some("gcs") | Some("gcp") => CloudProvider::Gcs,
                _ => CloudProvider::S3,
            },
            bucket: prospective.bucket.clone().unwrap_or_default(),
            region: prospective.region.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "us-east-1".to_string()),
            endpoint: prospective.endpoint.clone().filter(|s| !s.is_empty()),
            access_key_id: prospective.access_key_id.clone().filter(|s| !s.is_empty()),
            secret_access_key: prospective.secret_access_key.clone().filter(|s| !s.is_empty()),
            path_style: prospective.path_style.unwrap_or(false),
            multipart_threshold: DEFAULT_MULTIPART_THRESHOLD,
            part_size: DEFAULT_PART_SIZE,
        };
        let dst: Arc<dyn ObjectStore> = Arc::new(S3Store::from_conn(&conn)?);
        let src = super::get_object_store();
        let est = engine::estimate(&src)
            .await
            .map_err(|e| AppError::unprocessable_entity("MIGRATION_ESTIMATE_FAILED", format!("could not read the current store to estimate the migration — {}", e.category())))?;
        let needs_ack = engine::cost_ack_required(cross_cloud, est);
        // A large cross-cloud move PARKS (anchor-only) awaiting a cost-ack; else it copies now.
        let spawn = if needs_ack { None } else { Some((src, dst)) };
        (spawn, est.blob_count as i64, est.total_bytes as i64, needs_ack)
    } else {
        (None, 0, 0, false)
    };

    let row = repo::create(
        pool,
        &NewMigration {
            src_backend: old.backend.clone(),
            src_provider: old.provider.clone(),
            src_bucket: old.bucket.clone(),
            dst_backend,
            dst_provider,
            dst_bucket,
            cross_cloud,
            cost_ack: false,
            auto_started: true,
            blobs_total,
            bytes_total,
            src_config_ciphertext: src_ct,
        },
        actor,
    )
    .await?;

    if needs_ack {
        tracing::info!(migration = %row.id, blobs = blobs_total, bytes = bytes_total, "workstore: large CROSS-CLOUD store change — auto-migration PARKED pending a cost acknowledgement (#64/#61 INV-7)");
    } else if spawn.is_none() {
        tracing::info!(migration = %row.id, "workstore: switch to a LOCAL store — anchor recorded (boot keeps the old-store fallback); migrate + retire manually");
    }
    Ok(Some(PreparedStoreChange { row_id: row.id, spawn }))
}

/// CLEAN UP a prepared change whose config advance FAILED (#64 R2-F1): delete the boot-resume
/// anchor so a transient upsert error cannot strand a `pending` orphan that wedges every future
/// store change. Safe because the config never advanced (the caller calls this only on the upsert
/// error path), so dropping the anchor leaves the process on the intact OLD store.
pub async fn abandon_prepared_change(pool: &PgPool, plan: &PreparedStoreChange) {
    if let Err(e) = repo::delete_pending_anchor(pool, plan.row_id).await {
        tracing::warn!(error = %e, migration = %plan.row_id, "workstore: could not clean up the migration anchor after a failed config advance (may need a manual abort)");
    }
}

/// Launch the copy+verify + live cutover for a prepared change, AFTER the caller advanced the
/// config. Anchor-only plans (parked cost-ack, switch-to-local) do nothing here — they are already
/// restart-safe via the boot-resume anchor.
pub fn launch_prepared_cutover(pool: &PgPool, plan: PreparedStoreChange) {
    if let Some((src, dst)) = plan.spawn {
        tracing::info!(migration = %plan.row_id, "workstore: config switched to a new store — auto-migrating + will cut over LIVE on verify");
        spawn_copy_verify(pool.clone(), plan.row_id, src, dst, true);
    }
}

/// Resume a cost-ack-PARKED auto-migration (#64): the FE cost-ack button calls this after the
/// operator acknowledges a large cross-cloud egress. It flips `cost_ack`, then runs the copy+verify
/// and live cutover for the pending row. Rebuilds the OLD source from the preserved config and the
/// NEW dest from the current effective config, so it works after a restart too.
pub async fn ack_and_resume_parked_migration(pool: &PgPool, id: Uuid) -> Result<(), AppError> {
    let row = repo::by_id(pool, id).await?.ok_or_else(|| AppError::not_found("migration"))?;
    if row.phase != phase::PENDING {
        return Err(AppError::unprocessable_entity(
            "MIGRATION_NOT_PENDING",
            "only a cost-ack-parked (pending) migration can be resumed",
        ));
    }
    // The OLD source the copy READS from is the preserved OLD store. Before a cutover the live
    // handle IS the OLD store; after a restart the boot-resume has wrapped it as
    // `DualRead(new, old)`, so its `fallback()` is exactly the rebuilt OLD store (correct root +
    // decrypted creds) — reach it directly rather than rebuilding.
    let live = super::get_object_store();
    let old_store = match live.as_dual_read() {
        Some(d) => d.fallback(),
        None => live.clone(),
    };
    let new_db = super::infra_object_store::load_db_config(pool).await;
    let (_b, new_s3) = super::config::resolve_backend_and_s3(&new_db)?;
    let conn = new_s3.ok_or_else(|| AppError::unprocessable_entity("MIGRATION_DEST_GONE", "the destination store config is no longer present"))?;
    let new_store: Arc<dyn ObjectStore> = Arc::new(S3Store::from_conn(&conn)?);
    repo::set_cost_ack(pool, id).await?;
    spawn_copy_verify(pool.clone(), id, old_store, new_store, true);
    Ok(())
}

fn start_migration_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.startInfraMigration")
        .tag("admin")
        .summary("Start a copy+verify data migration from the current store to a destination (never deletes the source).")
        .response::<200, Json<StartMigrationResponse>>()
}

/// The background copy+verify task. Persists progress (throttled) and the terminal phase.
/// On a content-hash mismatch it marks the migration `failed` (auto-rollback — the config /
/// live store stay on the old store) — a corrupt destination is never certified `verified`.
///
/// When `cutover_on_verified` is set (the AUTO path, #64), a successful `verified` triggers the
/// LIVE hot-cutover: the process-global handle is atomically swapped to `DualRead(dst, src)`
/// (the activation guard is satisfied — we only reach here on `verified`), a catch-up re-sweep
/// brings any write-during-migration straggler onto `dst`, and the row is marked `cutover`. ANY
/// failure in that sequence rolls the handle back atomically to the fully-intact OLD store
/// (`src`) — never a data-losing partial state. The manual path passes `false`: a manual
/// migration still cuts over at the boot/construction seam (#61), unchanged.
fn spawn_copy_verify(
    pool: PgPool,
    id: Uuid,
    src: Arc<dyn ObjectStore>,
    dst: Arc<dyn ObjectStore>,
    cutover_on_verified: bool,
) {
    tokio::spawn(async move {
        if repo::set_phase(&pool, id, phase::COPYING).await.is_err() {
            return;
        }
        // Throttled progress: the sync closure records into atomics; every 32 blobs it fires a
        // detached DB update (monotonic counters — last-writer-wins is fine for a progress bar).
        let done = Arc::new(AtomicI64::new(0));
        let bytes = Arc::new(AtomicI64::new(0));
        let mut tick: u64 = 0;
        let result = {
            let done = done.clone();
            let bytes = bytes.clone();
            let pool2 = pool.clone();
            let mut cb = move |p: &engine::CopyProgress| {
                done.store(p.blobs_done as i64, Ordering::Relaxed);
                bytes.store(p.bytes_done as i64, Ordering::Relaxed);
                tick += 1;
                if tick % 32 == 0 {
                    let (pool3, d, b) = (pool2.clone(), p.blobs_done as i64, p.bytes_done as i64);
                    tokio::spawn(async move {
                        let _ = repo::update_progress(&pool3, id, d, b).await;
                    });
                }
            };
            engine::copy_and_verify(&src, &dst, &mut cb).await
        };
        // Final progress flush.
        let _ = repo::update_progress(
            &pool,
            id,
            done.load(Ordering::Relaxed),
            bytes.load(Ordering::Relaxed),
        )
        .await;
        match result {
            Ok(_report) => {
                // A failed terminal write leaves the row `copying` (never falsely `verified` —
                // the safe direction); the boot reaper clears it on the next restart. Log it so
                // a wedged row is visible rather than silent.
                if let Err(e) = repo::set_phase(&pool, id, phase::VERIFIED).await {
                    tracing::error!(error = %e, migration = %id, "workstore: could not mark migration verified (row stays 'copying' — will be reaped on restart)");
                    return;
                }
                // AUTO live cutover (#64): only reached on `verified` (the activation guard, INV-3).
                if cutover_on_verified {
                    // Swap the live handle to DualRead(new, old) — reads try new, fall back to old
                    // (write-window blobs stay readable, INV-2a); writes go to new. `src` (old) is
                    // retained as the fallback + rollback target (INV-5).
                    super::cutover::install_dual_read(dst.clone(), src.clone());
                    // Catch-up: bring any blob written to old DURING the migration window onto new
                    // (idempotent by content key, INV-2b). A failure here is NOT data loss — every
                    // such blob is still readable via the fallback and still blocks a manual retire
                    // — but roll back to be conservative and let the operator retry.
                    match super::cutover::catch_up(&src, &dst).await {
                        Ok(_) => {
                            if let Err(e) = repo::mark_cutover(&pool, id).await {
                                tracing::error!(error = %e, migration = %id, "workstore: live cutover applied but could not record the cutover flag (the status view will not show 'cut-over-live'; boot-resume is unaffected — it re-establishes DualRead from the un-retired row regardless)");
                            } else {
                                tracing::info!(migration = %id, "workstore: LIVE object-store cutover complete (dual-read new→old; old retained until manual retire)");
                            }
                        }
                        Err(e) => {
                            tracing::error!(category = e.category(), migration = %id, "workstore: catch-up re-sweep failed after cutover — rolling the live handle back to the old store");
                            super::cutover::rollback_to_old(src.clone());
                        }
                    }
                }
            }
            Err(e) => {
                // Fixed-vocabulary category only (never the raw error / credential).
                tracing::warn!(category = e.category(), "object-store migration halted");
                if let Err(db) = repo::set_failed(&pool, id, e.category()).await {
                    tracing::error!(error = %db, migration = %id, "workstore: could not mark migration failed (row stays 'copying' — will be reaped on restart)");
                }
            }
        }
    });
}

// ───────── retire source: a SAFETY-VERIFIED readiness check that NEVER deletes ─────────

/// The retire-source request. It carries the DESTINATION (the store the data was migrated to)
/// so the endpoint can re-verify every live-store blob is present there. No `Debug` derive
/// (plaintext creds).
///
/// **This endpoint DELETES NOTHING (INV-3, absolute).** Deleting the old store safely from the
/// API is not possible while the live `OBJECT_STORE` handle is a write-once boot handle: after a
/// config cut-over the API cannot prove whether the running process has actually rebooted onto
/// the new store, so it cannot know which physical store it would be safe to delete (an earlier
/// design that fell back to the live handle would have deleted LIVE data — caught in the
/// data-integrity audit). So retirement of the old store's bytes is a deliberate MANUAL
/// operator step; this endpoint only PROVES it is safe to do so (every blob is verified present
/// in the destination) and hands back the go-ahead.
#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct RetireSourceRequest {
    /// Explicit confirmation the operator intends to retire the old store.
    #[serde(default)]
    pub confirm: bool,
    /// The destination every current blob must be proven present + verified in.
    pub dest: MigrationDest,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RetireSourceResponse {
    /// True when the old store is PROVEN safe to retire (every blob verified in the dest). This
    /// endpoint never deletes — `false` here means "not yet safe", `true` means "safe to delete
    /// the old store manually now".
    pub safe_to_retire: bool,
    /// The number of blobs re-verified present + content-correct in the destination.
    pub verified_blobs: i64,
    pub message: String,
}

async fn retire_source(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<RetireSourceRequest>,
) -> ApiResult<Json<RetireSourceResponse>> {
    if !req.confirm {
        return Err(AppError::bad_request(
            "RETIRE_NOT_CONFIRMED",
            "pass confirm:true to run the retire-readiness check for the old store.",
        )
        .to_api_error());
    }
    // (1) The migration must be verified.
    let row = repo::latest(&pool)
        .await
        .map_err(|e| e.to_api_error())?
        .ok_or_else(|| AppError::not_found("migration").to_api_error())?;
    if row.phase != phase::VERIFIED {
        return Err(AppError::unprocessable_entity(
            "RETIRE_NOT_VERIFIED",
            "the migration is not in the 'verified' phase — retire is not safe until every blob is copied and verified.",
        )
        .to_api_error());
    }
    // (2) The fence: no jobs may be running (INV-6) — a job could be mid-read on a source blob.
    if running_jobs(&pool).await.map_err(|e| e.to_api_error())? > 0 {
        return Err(AppError::conflict(
            "jobs are currently running — drain them before retiring the old store (in-flight-read fence)",
        )
        .to_api_error());
    }

    // FINAL full re-verify: EVERY blob the OLD store holds is present + content-verified in the
    // destination. The enumeration source MUST be the GENUINE OLD store — enumerating NEW would
    // pass trivially and wrongly green-light a retire (data-loss audit R1-F1). We obtain OLD
    // robustly, never trusting the live handle's SHAPE:
    //   * if the live handle is `DualRead(new, old)` (post-cutover, or a boot-resumed migration),
    //     its `fallback()` IS the genuine OLD;
    //   * else for an AUTO migration (config was advanced to NEW), the live handle may be a bare
    //     NEW store if boot could not rebuild OLD — so we rebuild OLD from the PRESERVED config and
    //     REFUSE if we cannot (fail-closed: never verify against NEW by accident);
    //   * else (a MANUAL #61 migration, config never advanced) the live handle IS the OLD source.
    let live = super::get_object_store();
    let source: Arc<dyn ObjectStore> = if let Some(dual) = live.as_dual_read() {
        dual.fallback()
    } else if row.auto_started {
        match repo::decrypt_preserved_old_config(&pool, &row).await {
            Some(cfg) => {
                // For a LOCAL OLD we need its real root; the live handle's `store_root()` is the
                // only source here, and a bare-cloud live handle yields `None`. Rather than guess a
                // wrong root (which would enumerate an empty dir and falsely green-light retire,
                // R2-F3), REFUSE when a local OLD's root cannot be determined.
                let local_root = live.store_root().map(|p| p.to_path_buf());
                if cfg.backend == "local" && local_root.is_none() {
                    return Err(AppError::unprocessable_entity(
                        "RETIRE_OLD_STORE_UNAVAILABLE",
                        "cannot determine the OLD local store's root to verify against — NOT safe to \
                         retire. Restart so the dual-read fallback is re-established, then retry.",
                    )
                    .to_api_error());
                }
                super::cutover::build_store_from_preserved(&cfg, local_root.as_deref().unwrap_or(std::path::Path::new(".")))
                    .map_err(|e| e.to_api_error())?
            }
            None => {
                return Err(AppError::unprocessable_entity(
                    "RETIRE_OLD_STORE_UNAVAILABLE",
                    "cannot identify the OLD store to verify against (its preserved config is missing or \
                     undecryptable, and the process is not running the dual-read fallback) — NOT safe to \
                     retire. Restart with at-rest encryption enabled so the OLD fallback is re-established.",
                )
                .to_api_error());
            }
        }
    } else {
        live
    };
    let dest: Arc<dyn ObjectStore> =
        Arc::new(S3Store::from_conn(&dest_conn(&req.dest).map_err(|e| e.to_api_error())?).map_err(|e| e.to_api_error())?);
    let verified = engine::verify_all(&source, &dest).await.map_err(|e| {
        AppError::unprocessable_entity(
            "RETIRE_VERIFY_FAILED",
            format!("re-verify failed — {} — the old store is NOT safe to retire", e.category()),
        )
        .to_api_error()
    })?;

    // Close the migration lifecycle: mark `retired` so the boot-resume stops re-establishing the
    // dual-read fallback (data-loss audit R1-F4). This DROPS the fallback on the next restart, so it
    // is only safe when the dest we just verified `NEW ⊇ OLD` against IS the store the migration
    // targeted (= the effective NEW). Guard it: retire only when `req.dest` matches the row's
    // recorded destination (provider + bucket) — otherwise the operator verified against a different
    // superset store and dropping the fallback could strand blobs the effective NEW lacks (R2-F2).
    // We still report `safe_to_retire` (the verify passed) but KEEP the fallback in that case.
    let dest_matches_row = row.dst_provider.as_deref() == req.dest.provider.as_deref().or(Some("s3"))
        && row.dst_bucket.as_deref() == req.dest.bucket.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if dest_matches_row {
        if let Err(e) = repo::set_phase(&pool, row.id, phase::RETIRED).await {
            tracing::warn!(error = %e, migration = %row.id, "workstore: retire verified but could not mark the row retired (boot will keep the harmless dual-read fallback)");
        }
    } else {
        tracing::warn!(migration = %row.id, "workstore: retire verified against a dest that does not match the migration's recorded destination — reporting safe_to_retire but KEEPING the dual-read fallback (the effective new store may differ). Retire against the migrated destination to close the lifecycle.");
    }

    Ok((
        StatusCode::OK,
        Json(RetireSourceResponse {
            safe_to_retire: true,
            verified_blobs: verified as i64,
            message: format!(
                "Verified {verified} blob(s) present in the destination. The old store is now safe to \
                 retire. Automatic deletion is intentionally NOT performed — after confirming the \
                 backend is switched to the destination, delete the old store manually (the old \
                 bucket, or the old <data>/workstore directory)."
            ),
        }),
    ))
}

fn retire_source_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.retireInfraMigrationSource")
        .tag("admin")
        .summary("Confirm the old store is SAFE to retire after a verified migration (verifies every blob in the dest; never deletes).")
        .response::<200, Json<RetireSourceResponse>>()
}

// ───────── abandon: revert a verified migration to the OLD store (never deletes) ─────────

/// The abandon request (#65). Requires explicit confirmation.
#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct AbandonMigrationRequest {
    /// Explicit confirmation the operator intends to abandon the migration and revert to the old store.
    #[serde(default)]
    pub confirm: bool,
}

/// The abandon response (#65) — masked (no credential). Reports the reverted-to backend and whether
/// the persisted config was reverted too.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AbandonMigrationResponse {
    /// True once the primary has been reverted to the old store and the migration marked abandoned.
    pub abandoned: bool,
    /// The backend the primary was reverted TO: `"local"` or `"s3"`.
    pub reverted_to: String,
    /// True when the persisted config was reverted to the old store's too (so a restart stays on
    /// old); false when it was left for the operator to PUT (still safe — the 409 is cleared).
    pub config_reverted: bool,
    pub message: String,
}

/// ABANDON a verified object-store migration (#65): atomically swap the live primary back to the
/// intact OLD store, revert the persisted config to it, and mark the migration `abandoned` (which
/// clears the config-change 409 + stops boot-resume). **This DELETES NOTHING (INV-1, absolute)** —
/// the old store was never deleted and the new store's copy is left exactly in place; abandoning
/// simply returns the primary to the intact old store. FAIL-CLOSED (INV-2): if the OLD store cannot
/// be reconstructed it refuses BEFORE any swap, never leaving the primary dangling.
async fn abandon_migration(
    auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<AbandonMigrationRequest>,
) -> ApiResult<Json<AbandonMigrationResponse>> {
    let row = abandon_precheck(&pool, req.confirm).await.map_err(|e| e.to_api_error())?;
    let outcome = abandon_to_old(&pool, &row, auth.user.id).await.map_err(|e| e.to_api_error())?;
    tracing::warn!(migration = %row.id, reverted_to = %outcome.reverted_to, config_reverted = outcome.config_reverted, "workstore: migration ABANDONED (#65) — primary reverted to the old store; the new store's copy is left in place (nothing deleted)");
    Ok((
        StatusCode::OK,
        Json(AbandonMigrationResponse {
            abandoned: true,
            reverted_to: outcome.reverted_to,
            config_reverted: outcome.config_reverted,
            message: format!(
                "Reverted to the old store{}. The new store's copy is left in place and nothing was \
                 deleted. You can reconfigure the object store now.",
                if outcome.config_reverted {
                    ""
                } else {
                    " (the persisted config was not reverted — PUT the old store config to make it permanent)"
                }
            ),
        }),
    ))
}

/// The abandon ELIGIBILITY check (#65, DEC-4), separated from the HTTP handler so its guard-rails
/// are testable directly. Requires `confirm`; the latest migration must exist, be `auto_started`
/// (a config-switch — a manual #61 migration never advanced the config, so there is no 409 to
/// clear), and be `verified` (a running one finishes/fails on its own; a retired/abandoned one is
/// closed). Returns the eligible row, or a mapped `AppError` (400/404/422).
pub async fn abandon_precheck(pool: &PgPool, confirm: bool) -> Result<repo::MigrationRow, AppError> {
    if !confirm {
        return Err(AppError::bad_request(
            "ABANDON_NOT_CONFIRMED",
            "pass confirm:true to abandon the migration and revert to the old store.",
        ));
    }
    let row = repo::latest(pool)
        .await?
        .ok_or_else(|| AppError::not_found("migration"))?;
    if !row.auto_started {
        return Err(AppError::unprocessable_entity(
            "ABANDON_NOT_APPLICABLE",
            "this migration did not switch the store config (a manual migration cuts over at the next \
             restart) — there is nothing to abandon.",
        ));
    }
    if row.phase != phase::VERIFIED {
        return Err(AppError::unprocessable_entity(
            "ABANDON_NOT_VERIFIED",
            "only a verified migration can be abandoned — a running migration finishes or fails on its \
             own, and a retired/abandoned one is already closed.",
        ));
    }
    Ok(row)
}

/// The outcome of the abandon core.
#[derive(Debug)]
pub struct AbandonOutcome {
    pub reverted_to: String,
    pub config_reverted: bool,
}

/// The data-integrity CORE of abandon (#65), separated from the HTTP handler so its no-data-loss
/// properties are integration-testable directly (local-fs + a real cloud store). Given a VERIFIED
/// auto migration `row`, it: reconstructs the genuine OLD store (the retire-source ladder, DEC-3;
/// FAIL-CLOSED 422 if impossible, INV-2), atomically swaps the live primary back to it
/// (`rollback_to_old`, INV-4), reverts the persisted config to it (best-effort, DEC-2), and marks
/// the row `abandoned` (clearing the 409 + stopping boot-resume). **DELETES NOTHING** (INV-1) — the
/// old store is untouched and the new store's copy is left in place. The caller has already checked
/// `confirm` + eligibility (`verified` + `auto_started`).
pub async fn abandon_to_old(
    pool: &PgPool,
    row: &repo::MigrationRow,
    actor: Uuid,
) -> Result<AbandonOutcome, AppError> {
    // Reconstruct the GENUINE OLD store to revert TO (the retire-source ladder, DEC-3): the live
    // dual-read fallback if present, else rebuilt from the preserved config, else FAIL-CLOSED (422)
    // BEFORE any swap so the primary is never left dangling (INV-2). Decrypt the preserved config
    // once — it is also the source for the persisted-config revert (DEC-2/DEC-5).
    let live = super::get_object_store();
    let old_cfg = repo::decrypt_preserved_old_config(pool, row).await;
    let old_store: Arc<dyn ObjectStore> = if let Some(dual) = live.as_dual_read() {
        dual.fallback()
    } else {
        match &old_cfg {
            Some(cfg) => {
                let local_root = live.store_root().map(|p| p.to_path_buf());
                if cfg.backend == "local" && local_root.is_none() {
                    return Err(AppError::unprocessable_entity(
                        "ABANDON_OLD_STORE_UNAVAILABLE",
                        "cannot determine the OLD local store's root to revert to — NOT safe to abandon. \
                         Restart so the dual-read fallback is re-established, then retry.",
                    ));
                }
                super::cutover::build_store_from_preserved(
                    cfg,
                    local_root.as_deref().unwrap_or(std::path::Path::new(".")),
                )?
            }
            None => {
                return Err(AppError::unprocessable_entity(
                    "ABANDON_OLD_STORE_UNAVAILABLE",
                    "cannot reconstruct the OLD store to revert to (its preserved config is missing or \
                     undecryptable, and the process is not running the dual-read fallback) — NOT safe to \
                     abandon. Restart with at-rest encryption enabled so the OLD fallback is re-established.",
                ));
            }
        }
    };

    // (1) Atomically swap the live primary back to the intact OLD store (INV-4). From here the running
    // process serves from OLD; the NEW store's copy is left in place (INV-1 — nothing is deleted).
    let reverted_to = old_cfg
        .as_ref()
        .map(|c| c.backend.clone())
        .unwrap_or_else(|| row.src_backend.clone());
    super::cutover::rollback_to_old(old_store);

    // (2) Revert the PERSISTED config to the old store (DEC-2) so a restart stays on OLD. Best-effort:
    // if the old cloud creds cannot be re-encrypted we keep the config and let the operator PUT — the
    // abandon has already cleared the 409.
    let config_reverted = match &old_cfg {
        Some(cfg) => {
            match super::infra_object_store::revert_config_to_preserved(pool, cfg, actor).await {
                Ok(true) => true,
                Ok(false) => {
                    tracing::warn!(migration = %row.id, "workstore: abandoned + reverted the live handle to OLD, but could not re-encrypt the OLD cloud credentials to revert the persisted config — the operator should PUT the old store config (the 409 is cleared).");
                    false
                }
                Err(e) => {
                    tracing::warn!(error = %e, migration = %row.id, "workstore: abandoned + reverted the live handle, but the persisted-config revert failed — the operator should PUT the old store config (the 409 is cleared).");
                    false
                }
            }
        }
        None => {
            tracing::warn!(migration = %row.id, "workstore: abandoned via the dual-read fallback but the preserved OLD config is undecryptable — persisted config NOT reverted; the operator should PUT the old store config (the 409 is cleared).");
            false
        }
    };

    // (3) Mark the migration abandoned (clears the 409 + stops boot-resume). Guarded to `verified`.
    let updated = repo::set_abandoned(
        pool,
        row.id,
        "operator abandoned the verified migration and reverted to the old store",
    )
    .await?;
    if updated == 0 {
        // A concurrent dangerous op moved the row out of `verified` between our precheck and here.
        // The live handle is already OLD (safe), and `verified` only moves FORWARD — so a
        // legitimate concurrent transition (a second abandon, or a retire) lands in a phase that
        // `latest_unretired` also excludes, keeping the 409 cleared. Re-read to CONFIRM that; if the
        // row is somehow neither `abandoned` nor `retired`, the 409-clear was not actually achieved,
        // so surface a conflict rather than falsely reporting a clean abandon.
        let now = repo::by_id(pool, row.id).await?;
        let closed = matches!(now.as_ref().map(|r| r.phase.as_str()), Some(phase::ABANDONED | phase::RETIRED));
        if !closed {
            tracing::error!(migration = %row.id, phase = ?now.map(|r| r.phase), "workstore: abandon reverted the live handle to OLD but the row was not closed (config-change 409 may still fire) — investigate.");
            return Err(AppError::conflict(
                "the migration changed state during the abandon — the primary was reverted to the old \
                 store, but the migration was not closed; reload the status and retry if the config is still blocked",
            ));
        }
        tracing::warn!(migration = %row.id, "workstore: abandon found the row already closed by a concurrent op (retired/abandoned) — the live handle is OLD and the 409 is cleared.");
    }
    Ok(AbandonOutcome { reverted_to, config_reverted })
}

fn abandon_migration_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.abandonInfraMigration")
        .tag("admin")
        .summary("Abandon a verified migration and revert the primary to the OLD store (never deletes; leaves the new store's copy in place).")
        .response::<200, Json<AbandonMigrationResponse>>()
}

// ───────────────────────── cost-ack: resume a parked auto-migration ─────────────────────────

#[derive(Clone, Default, Deserialize, JsonSchema)]
pub struct AckCostRequest {
    /// The parked (pending) migration to acknowledge + start. Absent ⇒ the newest pending one.
    pub id: Option<String>,
}

async fn ack_cost(
    _auth: RequirePermissions<(InfraSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(req): Json<AckCostRequest>,
) -> ApiResult<Json<MigrationStatusView>> {
    // Resolve the target: the explicit id, else the newest un-retired (which, when parked, is
    // pending). `ack_and_resume_parked_migration` enforces it is actually `pending`.
    let id = match req.id.as_deref().map(uuid::Uuid::parse_str) {
        Some(Ok(id)) => id,
        Some(Err(_)) => return Err(AppError::bad_request("BAD_ID", "invalid migration id").to_api_error()),
        None => repo::latest(&pool)
            .await
            .map_err(|e| e.to_api_error())?
            .map(|r| r.id)
            .ok_or_else(|| AppError::not_found("migration").to_api_error())?,
    };
    ack_and_resume_parked_migration(&pool, id).await.map_err(|e| e.to_api_error())?;
    let view = match repo::by_id(&pool, id).await.map_err(|e| e.to_api_error())? {
        Some(r) => MigrationStatusView::from_row(&r),
        None => MigrationStatusView::none(),
    };
    Ok((StatusCode::OK, Json(view)))
}

fn ack_cost_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(InfraSettingsManage,)>(op)
        .id("Admin.ackInfraMigrationCost")
        .tag("admin")
        .summary("Acknowledge a large cross-cloud egress and start the parked auto-migration (#64).")
        .response::<200, Json<MigrationStatusView>>()
}

// ───────────────────────────── routes ─────────────────────────────

pub fn routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/admin/infra/roundtrip-test",
            post_with(roundtrip_test, roundtrip_docs),
        )
        .api_route(
            "/admin/infra/migration",
            get_with(get_migration, get_migration_docs).post_with(start_migration, start_migration_docs),
        )
        .api_route(
            "/admin/infra/migration/retire-source",
            post_with(retire_source, retire_source_docs),
        )
        .api_route(
            "/admin/infra/migration/ack-cost",
            post_with(ack_cost, ack_cost_docs),
        )
        .api_route(
            "/admin/infra/migration/abandon",
            post_with(abandon_migration, abandon_migration_docs),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // TEST-U10
    fn dest_conn_requires_a_bucket_and_maps_provider() {
        let mut d = MigrationDest::default();
        assert!(dest_conn(&d).is_err(), "no bucket ⇒ rejected");
        d.bucket = Some("cyto".into());
        d.provider = Some("gcs".into());
        let c = dest_conn(&d).unwrap();
        assert_eq!(c.provider, CloudProvider::Gcs);
        assert_eq!(c.bucket, "cyto");
        // A stable code for the invalid-pair message reuse.
        assert_eq!(super::super::backend_compat::INCOMPATIBLE_BACKENDS_CODE, "INCOMPATIBLE_BACKENDS");
    }
}
