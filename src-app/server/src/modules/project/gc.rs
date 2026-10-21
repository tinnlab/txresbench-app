//! Blob-GC seam — the **P10-owned, P1-consumed** contract for freeing
//! content-addressed object-store blobs when a project is deleted.
//!
//! **Why a seam and not an in-tx delete (DEC-5).** `on_project_deleted` runs inside
//! the project-delete transaction, so it can only touch DB rows — it CANNOT (and
//! must not) unlink object-store blobs in-tx: a file delete can't roll back, and
//! a content-addressed blob may be shared with another project/dataset. So the
//! delete path is split:
//!
//! - **collect-in-tx (P10):** each extension's `on_project_deleted` `mark()`s the
//!   blob refs its project-scoped rows pointed at into a [`GcManifest`], which
//!   `delete_project_with_extensions` returns. Atomicity is preserved — the DB rolls
//!   back on any hook error and no blob is touched.
//! - **free-post-commit (P1):** the content-address REFCOUNT sweep that actually
//!   frees a blob (only when its hash has no surviving storage-ref) runs AFTER the
//!   commit succeeds. [`sweep_gc_manifest`] is that seam — a no-op stub here that
//!   P1 replaces with the refcount-gated free + a background orphan-reaper.
//!
//! P10 decides WHAT to GC (collect); P1 decides HOW/WHEN to free (refcounted).

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

/// A content-addressed blob reference an extension marks for post-commit GC.
///
/// `hash` is the CAS key (the only thing the refcount sweep needs); `source` is a
/// static provenance tag for logging/debugging (e.g. `"dataset"`, `"catalog"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobRef {
    pub hash: String,
    pub source: &'static str,
}

/// The collector threaded through the `on_project_deleted` hooks. Extensions push
/// the blob refs their deleted rows referenced; the project-delete chokepoint hands
/// the populated manifest to [`sweep_gc_manifest`] AFTER commit.
#[derive(Debug, Clone, Default)]
pub struct GcManifest {
    /// The project being deleted (provenance; `None` for a bare/test manifest).
    pub project_id: Option<Uuid>,
    pub refs: Vec<BlobRef>,
}

impl GcManifest {
    /// A manifest scoped to one project delete.
    pub fn for_project(project_id: Uuid) -> Self {
        Self { project_id: Some(project_id), refs: Vec::new() }
    }

    /// Mark a blob (by content hash) for post-commit GC.
    pub fn mark(&mut self, hash: impl Into<String>, source: &'static str) {
        self.refs.push(BlobRef { hash: hash.into(), source });
    }

    pub fn is_empty(&self) -> bool {
        self.refs.is_empty()
    }

    pub fn len(&self) -> usize {
        self.refs.len()
    }
}

/// **Post-commit blob-GC sweep — P1 OWNS the implementation.**
///
/// Called by `delete_project_with_extensions` AFTER the delete tx commits. This is
/// the seam P10 hands the collected manifest to; P10 must NOT free blobs here
/// (dedup-unsafe without the content-address refcount). Default: a no-op that
/// logs the marked count. P1 replaces the body with a refcount-gated free (free a
/// blob only when its hash has no surviving storage-ref) + a background
/// orphan-reaper as the crash backstop.
pub async fn sweep_gc_manifest(pool: &PgPool, manifest: &GcManifest) -> Result<(), AppError> {
    // P1 (workstore) OWNS the post-commit refcount free: a marked blob is freed
    // only when its content hash has no surviving storage-ref (shared blobs
    // survive — the dedup guard). Delegated so the project module stays free of
    // object-store internals.
    crate::modules::workstore::gc::sweep_marked_manifest(pool, manifest).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_marks_and_counts() {
        let sid = Uuid::new_v4();
        let mut m = GcManifest::for_project(sid);
        assert!(m.is_empty());
        assert_eq!(m.len(), 0);
        m.mark("hash-a", "dataset");
        m.mark("hash-b", "catalog");
        assert!(!m.is_empty());
        assert_eq!(m.len(), 2);
        assert_eq!(m.project_id, Some(sid));
        assert_eq!(
            m.refs[0],
            BlobRef { hash: "hash-a".to_string(), source: "dataset" }
        );
        assert_eq!(m.refs[1].source, "catalog");
    }

    #[test]
    fn default_manifest_has_no_project_and_no_refs() {
        // A bare manifest (used by the registry mock-thread test) starts empty and
        // project-less. The `sweep_gc_manifest` no-op contract (always Ok) needs a
        // PgPool, so it is exercised on the real delete path at the integration
        // tier (TEST-12), not here.
        let mut m = GcManifest::default();
        assert!(m.is_empty());
        assert_eq!(m.project_id, None);
        m.mark("h", "x");
        assert_eq!(m.len(), 1);
    }
}
