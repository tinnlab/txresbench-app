//! Storage byte-delta accounting (ITEM-5 / PROV-T2-2).
//!
//! T2 EMITS a raw, append-only `storage_meter` signal — one signed byte-delta per event —
//! and does NOT aggregate it: the deferred T5 rollup sums it into per-account GB-months and
//! maps `project_id -> account` (§7.3 / DEC-5). Two emit sites, mirroring the two moments a
//! blob's physical footprint changes:
//!
//!  * **+delta at ingest** — in the SAME transaction as the artifact-row insert
//!    (`ingest.rs`, INV-6), keyed by the artifact's `content_hash` + `stored_bytes`.
//!  * **−delta at GC** — at the refcount-gated unlink (`gc.rs`), keyed by the freed blob's
//!    hash + its byte length.
//!
//! For a SINGLE-FILE artifact the signed sum over its `content_hash` returns to 0 after a
//! full delete (its `content_hash` IS its one blob's key). This is the shape TEST-4 proves.
//!
//! **This is a RAW signal, not a balanced ledger — three caveats the T5 rollup reconciles,
//! NOT this module (DEC-5):**
//! - **Multi-file artifacts don't self-reconcile per `content_hash`.** Ingest emits ONE
//!   +delta keyed by the artifact's merkle `content_hash` (a synthetic identity, not a stored
//!   blob) with `Σ member bytes`; GC emits a −delta per FREED blob keyed by that blob's own
//!   hash. The keys differ, so the per-`content_hash` sum does not cancel for a Zarr artifact —
//!   T5 reconciles member-blob deltas against the artifact identity.
//! - **The full orphan sweep emits no −delta.** Only the refcount-gated project-delete path
//!   (`gc::sweep_marked`) records a −delta; the periodic crash/orphan backstop
//!   (`gc::sweep` → `ObjectStore::gc`) unlinks internally and cannot (it has no
//!   `project_id`/hash list). A committed artifact reclaimed by that backstop leaves its
//!   +delta unmatched — T5 reconciles the raw signal against live store contents. (Known
//!   follow-up: have `ObjectStore::gc` report freed keys so the backstop can emit deltas too.)
//! - **Dedup (§7.3):** two ingests of the SAME bytes emit two +deltas under one hash for one
//!   physical copy — again the rollup's job.

use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
use ziee_core::AppError;

/// Why a byte-delta row was written. A TYPED reason (not a bare `&str`) so a caller can NEVER
/// pass a value outside the migration's `CHECK (reason IN ('ingest','gc'))` — a stray string
/// would make the INSERT violate the CHECK, and because the ingest +delta runs inside the ingest
/// transaction and propagates, that would fail the whole data-plane ingest, not just drop a row.
/// The `&str` mapping is the single source shared with the migration's CHECK.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeterReason {
    /// A +delta recorded when an artifact's bytes are ingested.
    Ingest,
    /// A −delta recorded when a blob is reclaimed by GC.
    Gc,
}

impl MeterReason {
    pub fn as_str(self) -> &'static str {
        match self {
            MeterReason::Ingest => "ingest",
            MeterReason::Gc => "gc",
        }
    }
}

/// Record one byte-delta inside an EXISTING transaction — the ingest +delta path, so the
/// meter row and the artifact row commit atomically (INV-6). A failure PROPAGATES: the
/// meter write is part of the ingest txn's contract here, and a partial commit would
/// mis-state the signal.
pub async fn record_delta_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    project_id: Option<Uuid>,
    account_id: Option<Uuid>,
    content_hash: &str,
    delta_bytes: i64,
    logical_bytes: Option<i64>,
    reason: MeterReason,
) -> Result<(), AppError> {
    sqlx::query!(
        "INSERT INTO storage_meter \
         (project_id, account_id, content_hash, delta_bytes, logical_bytes, reason) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        project_id,
        account_id,
        content_hash,
        delta_bytes,
        logical_bytes,
        reason.as_str(),
    )
    .execute(&mut **tx)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// Record one byte-delta against the pool — the GC −delta path, emitted at the unlink
/// (there is no surrounding txn). A failure is LOGGED, never propagated: GC correctness
/// must not depend on the metering write, so a DB hiccup drops a meter row rather than
/// wedging a reclamation. (In the reconciliation test the write succeeds, so the signed
/// sum still returns to 0.)
pub async fn record_gc_delta(
    pool: &PgPool,
    project_id: Option<Uuid>,
    account_id: Option<Uuid>,
    content_hash: &str,
    freed_bytes: u64,
) {
    let delta = -(freed_bytes as i64);
    // logical_bytes is SIGNED like delta_bytes on a GC -delta: a reclaim credits the freed
    // blob's logical footprint DOWN (DEC-9, revised R1). For a file-owning artifact the freed
    // physical bytes equal the logical bytes it contributed, so the per-hash logical sum
    // reconciles to 0 after a full delete — otherwise a fold that bills on logical_bytes would
    // bill a deleted artifact's logical footprint forever. (A virtual/multi-file artifact owns
    // no blob and emits no GC -delta; its logical reconciliation is the rollup's job — see the
    // module doc caveats.)
    let logical_delta = -(freed_bytes as i64);
    if let Err(e) = sqlx::query!(
        "INSERT INTO storage_meter \
         (project_id, account_id, content_hash, delta_bytes, logical_bytes, reason) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        project_id,
        account_id,
        content_hash,
        delta,
        logical_delta,
        MeterReason::Gc.as_str(),
    )
    .execute(pool)
    .await
    {
        tracing::error!(
            error = %e,
            content_hash,
            "workstore.meter: failed to record GC byte-delta (metering only; GC unaffected)"
        );
    }
}
