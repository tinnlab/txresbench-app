//! Draft wire + DB types. Core interprets NOTHING about `kind` or `data` (INV-1):
//! `kind` is an opaque, package-owned string; `data` is opaque, package-owned jsonb.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Global cap on the serialized `data` jsonb blob (DEC-5). A typical draft body is a
/// few KiB; 256 KiB leaves headroom for a larger opaque `kind` without being unbounded.
/// Enforced in the create/put handler BEFORE the write.
pub const DRAFT_DATA_MAX_BYTES: usize = 256 * 1024;

/// Per-project draft count cap (bounded-write §4). A `drafts::use` holder cannot create
/// unbounded rows in an editable project — mirrors the `project_files` 100-cap pattern,
/// sized up for the draftable use-case (a project may curate many draftable collections).
/// Enforced in the create handler; over the cap → 422.
pub const DRAFT_MAX_PER_PROJECT: i64 = 500;

/// The `status` vocabulary. A bare `text` column (like `artifacts.status`); this
/// `const` is the single source of the two legal values (never `unwrap()` an enum
/// from the DB — the column CHECK constraint keeps it honest). `OPEN` is the DB
/// default + the status create/edit lands on, written as a SQL literal in the
/// repository (so it has no production Rust reader — it documents the pole whose
/// sibling `FROZEN` the freeze idempotency check reads).
#[allow(dead_code)]
pub const DRAFT_STATUS_OPEN: &str = "open";
pub const DRAFT_STATUS_FROZEN: &str = "frozen";

/// A draft row (opaque `kind` + `data`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct Draft {
    pub id: Uuid,
    /// OPAQUE, package-owned. Core never branches on it.
    pub kind: String,
    pub project_id: Uuid,
    /// OPAQUE, package-owned schema. Core never parses it.
    pub data: serde_json::Value,
    /// `open` | `frozen` (bare text — see [`DRAFT_STATUS_OPEN`]).
    pub status: String,
    /// The latest frozen immutable artifact (NULL until first freeze; SET NULL if
    /// that artifact is deleted).
    pub frozen_artifact_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Create a draft. `data` optional (absent → `{}`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateDraftRequest {
    /// OPAQUE, package-owned.
    pub kind: String,
    pub project_id: Uuid,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    /// The frozen artifact this draft is a FORK of (INV-7 / DEC-11). When set, the new draft
    /// is born (still `open`) with its `frozen_artifact_id` pointing at this prior version, so
    /// the next freeze records it as the new artifact's `parent_artifact_id` — the SAME edge
    /// the freeze-completion hook reads for a reopened draft. This is what makes the frozen-view
    /// "Edit → new version" fork link into the lineage chain (the editor forks a NEW draft rather
    /// than reopening the source, so the parent must be threaded explicitly). Must reference an
    /// artifact in `project_id` (a foreign/nonexistent artifact → 422). Absent for a fresh
    /// New-collection draft (version 1, no parent).
    #[serde(default)]
    pub parent_frozen_artifact_id: Option<Uuid>,
}

/// Replace a draft's `data` (LWW — DEC-4). Editing a `frozen` draft flips it back to
/// `open` server-side (DEC-3); the next freeze forks a new artifact.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateDraftRequest {
    pub data: serde_json::Value,
}

/// Query params for the drafts list (`?project_id&kind`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct DraftListQuery {
    pub project_id: Uuid,
    /// Optional opaque `kind` filter (absent → every kind in the project).
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DraftListResponse {
    pub drafts: Vec<Draft>,
}

/// The `POST /drafts/{id}/freeze` response (DEC-2 final). The freeze producer runs
/// asynchronously as a background job, so the freeze is ACCEPTED (202) with the current
/// (still-open) `draft` + the `freeze_job_id` the client can poll; the draft flips to
/// `frozen` when that job completes (refetch on the `Draft/Update` sync, or poll). For an
/// already-frozen unchanged draft it returns 200 with `freeze_job_id: null` (INV-5
/// idempotent — no new job).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct FreezeResponse {
    pub draft: Draft,
    /// The enqueued freeze producer job to poll (null when the draft was already frozen).
    pub freeze_job_id: Option<Uuid>,
}

/// One frozen-artifact version in a draft's lineage chain (INV-7 / GS-INV-6). Recorded by
/// the freeze-completion hook when a draft is stamped `frozen` at a newly-minted artifact:
/// a first freeze is `version = 1` with `parent_artifact_id = None`; a re-freeze after an
/// edit forks a new artifact stamped `parent_artifact_id = <the prior frozen artifact>` +
/// `version = parent.version + 1`. Domain-free — the drafts module records only the fork
/// EDGE, never anything about the artifact's `kind`/content.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct DraftLineageEntry {
    /// The frozen artifact this version IS.
    pub artifact_id: Uuid,
    /// The draft whose freeze minted `artifact_id`.
    pub draft_id: Uuid,
    /// The prior frozen artifact this version forked from (`null` for a first freeze).
    pub parent_artifact_id: Option<Uuid>,
    /// Monotone version number (1 for a first freeze, +1 per re-freeze).
    pub version: i32,
    pub created_at: DateTime<Utc>,
}

/// The lineage chain for one frozen artifact — the chain walked from the requested artifact
/// UP its `parent_artifact_id` links, NEWEST-first (the requested version at index 0, its
/// root last). Empty when the artifact has no lineage row (never froze through a draft, or
/// its row was GC'd). The FE renders `v3←v2←v1` + the per-version membership delta from it.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DraftLineageResponse {
    pub chain: Vec<DraftLineageEntry>,
}

/// Validate the serialized size of a `data` blob against the global cap (DEC-5).
/// `Err` carries a user-facing message → 422.
pub fn validate_data_size(data: &serde_json::Value) -> Result<(), &'static str> {
    // The serialized byte length is what the DB stores + what the cap is stated in;
    // a compact re-serialize is the honest measure of the blob's on-wire size.
    let len = serde_json::to_vec(data)
        .map(|v| v.len())
        .unwrap_or(usize::MAX);
    if len > DRAFT_DATA_MAX_BYTES {
        return Err("draft data is too long (max 256 KiB)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_size_cap() {
        assert!(validate_data_size(&serde_json::json!({"a": 1})).is_ok());
        // Just under the cap succeeds; just over is rejected.
        let big = "x".repeat(DRAFT_DATA_MAX_BYTES - 32);
        assert!(validate_data_size(&serde_json::json!({ "v": big })).is_ok());
        let too_big = "x".repeat(DRAFT_DATA_MAX_BYTES + 1);
        assert!(validate_data_size(&serde_json::json!({ "v": too_big })).is_err());
    }

    #[test]
    fn status_vocabulary_is_two_values() {
        assert_eq!(DRAFT_STATUS_OPEN, "open");
        assert_eq!(DRAFT_STATUS_FROZEN, "frozen");
    }
}
