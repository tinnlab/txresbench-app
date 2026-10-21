//! `DualReadStore` — the migration TRANSITION read decorator (#61 §2 / INV-5).
//!
//! During a data migration (after copy begins, until the source is explicitly retired) the
//! app's effective store is a `DualReadStore { primary, fallback }`:
//!
//! * **Reads** (`get`, `get_range`, `get_stream`, `stat`, `exists`, `resolve_member`) try
//!   the `primary` (the NEW store) first and fall back to the `fallback` (the OLD store) on
//!   ANY failure. Because keys are content-addressed, the fallback is byte-authoritative —
//!   so a blob the copy has not reached yet (or one written to the old store during the copy
//!   window) is STILL served, never surfaced as a spurious absence. This is the invariant
//!   that stops a partially-migrated read looking like data loss.
//! * **Writes** (`put`, `put_prefix`) go to the `primary` only — new data accumulates in the
//!   store we are moving to. (The old store is never mutated by the transition; it is only
//!   ever read from, and is deleted only by the separate, explicitly-confirmed retire step.)
//! * `delete` / `gc` operate on the `primary` only — the transition never reclaims from the
//!   fallback, so the old copy stays intact as the safety net until retire.
//!
//! It is applied ONLY at the store-construction seam (`build_store`), never hot-swapped into
//! a running process, so it introduces no concurrency hazard on the write-once store handle
//! (see the workstore module DEC on cutover applying at the boot/construction seam).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use ziee_core::AppError;

use super::{
    BlobLink, ByteStream, ContentKey, GcReport, MultiFilePut, ObjectStat, ObjectStore,
};

/// A read-through decorator: new store first, old store as the fallback.
pub struct DualReadStore {
    /// The NEW store (post-switch primary): all reads try here first; all writes land here.
    primary: Arc<dyn ObjectStore>,
    /// The OLD store: read-only fallback for blobs the copy has not yet reached. Never
    /// written to, never reclaimed by the transition.
    fallback: Arc<dyn ObjectStore>,
}

impl DualReadStore {
    pub fn new(primary: Arc<dyn ObjectStore>, fallback: Arc<dyn ObjectStore>) -> Self {
        Self { primary, fallback }
    }

    /// The NEW store (post-cutover primary): reads try here first; writes land here.
    ///
    /// The cutover/catch-up + retire paths (#64) need the two ends SEPARATELY — the live
    /// handle's own `list_keys` forwards to the primary (NEW), so enumerating OLD-only
    /// stragglers (the write-during-migration window) requires reaching the fallback
    /// DIRECTLY. Exposed as plain accessors rather than re-deriving config, so the exact Arcs
    /// the cutover installed are the ones re-verified before any retire.
    pub fn primary(&self) -> Arc<dyn ObjectStore> {
        self.primary.clone()
    }

    /// The OLD store: the read-only fallback + the retire-gate's enumeration source. Retained
    /// intact until an explicit operator retire (INV-5); never written to, never reclaimed by
    /// the transition.
    pub fn fallback(&self) -> Arc<dyn ObjectStore> {
        self.fallback.clone()
    }
}

#[async_trait]
impl ObjectStore for DualReadStore {
    fn store_root(&self) -> Option<&Path> {
        // The transition's local root (for a GC ownership check) is the PRIMARY's — the
        // fallback is read-only and never swept here.
        self.primary.store_root()
    }

    async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError> {
        // New data lands in the new store. (Content-addressed ⇒ idempotent.)
        self.primary.put(bytes).await
    }

    async fn put_prefix(&self, members: &[(String, Vec<u8>)]) -> Result<MultiFilePut, AppError> {
        self.primary.put_prefix(members).await
    }

    async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError> {
        match self.primary.get(key).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.get(key).await,
        }
    }

    async fn get_range(
        &self,
        key: &ContentKey,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, AppError> {
        match self.primary.get_range(key, offset, length).await {
            Ok(v) => Ok(v),
            Err(_) => self.fallback.get_range(key, offset, length).await,
        }
    }

    async fn get_stream(
        &self,
        key: &ContentKey,
        offset: u64,
        length: u64,
    ) -> Result<ByteStream, AppError> {
        // Existence is resolved eagerly by each backend, so a missing-in-primary blob returns
        // an Err here (before any byte is streamed) and we can cleanly fall back to the old
        // store — never a mid-stream failure masquerading as a short read.
        match self.primary.get_stream(key, offset, length).await {
            Ok(s) => Ok(s),
            Err(_) => self.fallback.get_stream(key, offset, length).await,
        }
    }

    async fn link_blob(&self, key: &ContentKey, dest: &Path) -> BlobLink {
        // Hardlink out of the primary's pool when it can; the caller copies otherwise. We do
        // not attempt a fallback hardlink — a mixed-pool link is exactly the drift the
        // content-addressed pool exists to avoid; a copy (via get) is the safe degrade.
        self.primary.link_blob(key, dest).await
    }

    async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, AppError> {
        match self.primary.stat(key).await {
            Ok(s) => Ok(s),
            Err(_) => self.fallback.stat(key).await,
        }
    }

    async fn exists(&self, key: &ContentKey) -> Result<bool, AppError> {
        match self.primary.exists(key).await {
            Ok(true) => Ok(true),
            Ok(false) => self.fallback.exists(key).await,
            // A primary error is not "absent" — consult the fallback before concluding.
            Err(_) => self.fallback.exists(key).await,
        }
    }

    async fn delete(&self, key: &ContentKey) -> Result<(), AppError> {
        // Reclamation touches the primary only; the old copy stays until explicit retire.
        self.primary.delete(key).await
    }

    async fn resolve_member(
        &self,
        manifest_key: &ContentKey,
        member_path: &str,
    ) -> Result<ContentKey, AppError> {
        match self.primary.resolve_member(manifest_key, member_path).await {
            Ok(k) => Ok(k),
            Err(_) => self.fallback.resolve_member(manifest_key, member_path).await,
        }
    }

    async fn gc(
        &self,
        keep: &std::collections::HashSet<String>,
        min_age_secs: u64,
    ) -> Result<GcReport, AppError> {
        // Sweep the primary only. The fallback is the migration safety net and is reclaimed
        // only by the explicit retire step, never by a background sweep during transition.
        self.primary.gc(keep, min_age_secs).await
    }

    async fn list_keys(&self) -> Result<Vec<ContentKey>, AppError> {
        // Not a migration END; forwards to the primary for completeness.
        self.primary.list_keys().await
    }

    // TEST-U9 covers the dual-read fallback semantics this decorator provides (see the #[cfg(test)]
    // module below); still green after the primary()/fallback()/as_dual_read() accessor additions.
    fn as_dual_read(&self) -> Option<&DualReadStore> {
        Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workstore::object_store::LocalFsStore;

    fn tmp() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ws-dual-{}", uuid::Uuid::new_v4()))
    }

    /// The core INV-5 property: a blob present ONLY in the fallback (old) store is still
    /// served through the dual-read decorator — a partially-migrated read is never an
    /// absence. And a blob present only in the primary (new) is also served.
    #[tokio::test]
    // TEST-U9
    async fn reads_fall_back_to_old_store_and_new_store_alike() {
        let old_dir = tmp();
        let new_dir = tmp();
        let old = Arc::new(LocalFsStore::new(&old_dir)) as Arc<dyn ObjectStore>;
        let new = Arc::new(LocalFsStore::new(&new_dir)) as Arc<dyn ObjectStore>;

        // A blob only in OLD (not yet copied), and a blob only in NEW (freshly written).
        let only_old = old.put(b"lives only in the old store").await.unwrap();
        let dual = DualReadStore::new(new.clone(), old.clone());
        let only_new = dual.put(b"written after the switch").await.unwrap();

        // Fallback serves the un-copied blob (INV-5: not an absence).
        assert_eq!(dual.get(&only_old).await.unwrap(), b"lives only in the old store");
        assert!(dual.exists(&only_old).await.unwrap());
        // Primary serves the new blob, and it landed in NEW, not OLD.
        assert_eq!(dual.get(&only_new).await.unwrap(), b"written after the switch");
        assert!(new.exists(&only_new).await.unwrap());
        assert!(!old.exists(&only_new).await.unwrap(), "a post-switch write must NOT touch the old store");

        // A genuinely absent blob is absent in BOTH ⇒ still reported absent.
        let ghost = ContentKey::from_hex(&"ab".repeat(32));
        assert!(!dual.exists(&ghost).await.unwrap());
        assert!(dual.get(&ghost).await.is_err());

        let _ = tokio::fs::remove_dir_all(&old_dir).await;
        let _ = tokio::fs::remove_dir_all(&new_dir).await;
    }
}
