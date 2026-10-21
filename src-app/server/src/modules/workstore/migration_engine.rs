//! The data-migration ENGINE (#61 §2) — ONE implementation, shared by the manual
//! "Migrate data" action and the auto-move orchestrator.
//!
//! It is PURE over two `Arc<dyn ObjectStore>` (source, destination): no DB, no env, no
//! process globals — so its data-integrity properties are unit-testable with local-fs (and,
//! floci-gated, a real cloud store) as the two ends.
//!
//! ## The data-loss safety contract (the load-bearing part)
//!
//! * **Copy** every source blob to the destination under the IDENTICAL content-addressed
//!   key (`sha256:<hex>` is portable — INV-2). The source is only ever READ; the engine
//!   never writes to or deletes it.
//! * **Verify by content hash** — after writing a blob to the destination, RE-READ it from
//!   the destination and assert `sha256(dest.get(key)) == key.hex()`. Content-addressing
//!   makes a corrupted/short/rerouted write detectable. A mismatch HALTS immediately with
//!   [`MigrationError::VerifyMismatch`] (INV-4) — the caller marks the migration `failed`
//!   and stays on the old store (auto-rollback). A corrupt destination is never certified.
//! * **Idempotent / resumable** — a blob already present AND content-verified in the
//!   destination is skipped, so a re-run (after a restart) resumes rather than re-copies.
//! * [`verify_all`] is the retire-time gate: it proves EVERY source key is present and
//!   content-matches in the destination BEFORE any source deletion is permitted. This is the
//!   ultimate safety net — a source blob can never be retired unless proven safe in dest.

use std::sync::Arc;

use ziee_core::AppError;

use super::object_store::{sha256_hex, ContentKey, ObjectStore};

/// A count + byte estimate of a move (the cost-gate input, INV-7).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MigrationEstimate {
    pub blob_count: u64,
    pub total_bytes: u64,
}

/// Live progress of a copy pass — updated after every blob so an admin sees N/M + bytes +
/// the current phase. Cloned into the orchestrator's shared state for the status endpoint.
#[derive(Debug, Clone, Default)]
pub struct CopyProgress {
    pub blobs_total: u64,
    pub blobs_done: u64,
    pub bytes_total: u64,
    pub bytes_done: u64,
    /// The most recently copied/verified key (`sha256:…`), for a "currently moving" display.
    pub current_key: Option<String>,
}

/// The outcome of a completed, fully-verified copy pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CopyReport {
    pub copied: u64,
    pub skipped_already_present: u64,
    pub verified: u64,
    pub bytes_copied: u64,
}

/// Why a migration halted. `VerifyMismatch` is the data-integrity stop: it means a blob read
/// back from the destination did NOT hash to its own key — the destination is not
/// trustworthy, so the migration must NOT cut over.
#[derive(Debug)]
pub enum MigrationError {
    /// A destination blob's content hash did not equal its content-address key. HALT.
    VerifyMismatch {
        key: String,
        expected_hex: String,
        got_hex: String,
    },
    /// A blob enumerated in the source could not be read back from the destination during a
    /// verify pass (missing after a claimed copy). HALT.
    DestMissing { key: String },
    /// A source read / enumeration failed.
    Source(AppError),
    /// A destination write / read failed (not a content mismatch — a transport/IO error).
    Dest(AppError),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::VerifyMismatch { key, expected_hex, got_hex } => write!(
                f,
                "content-hash VERIFY MISMATCH for {key}: destination bytes hash to {got_hex} \
                 but the key demands {expected_hex} — migration halted, staying on the old store"
            ),
            MigrationError::DestMissing { key } => {
                write!(f, "destination is missing an already-copied blob {key} — migration halted")
            }
            MigrationError::Source(e) => write!(f, "source read failed: {e}"),
            MigrationError::Dest(e) => write!(f, "destination write/read failed: {e}"),
        }
    }
}

/// A short, fixed-vocabulary category for the operator-facing status (never a raw error /
/// credential). `VerifyMismatch` / `DestMissing` are the data-integrity stops.
impl MigrationError {
    pub fn category(&self) -> &'static str {
        match self {
            MigrationError::VerifyMismatch { .. } => "content-hash verification failed",
            MigrationError::DestMissing { .. } => "a copied blob was missing on re-read",
            MigrationError::Source(_) => "could not read from the source store",
            MigrationError::Dest(_) => "could not write to the destination store",
        }
    }
}

/// The cross-cloud cost-gate threshold (INV-7): a CROSS-CLOUD move at/above this many bytes
/// requires an explicit operator go-ahead (`cost_ack`) rather than silently running egress.
///
/// A named constant, not an inline magic number, so it is promotable to an admin-configurable
/// `WorkstoreLimits`-style row later without a rewrite (same deferral rationale as the other
/// workstore tunables — see `config.rs` `WorkstoreLimits`). 1 GiB default: small enough that a
/// real bucket-to-bucket move (which bills egress) is gated, large enough that a trivial move
/// is not nagged.
pub const COST_GATE_BYTES: u64 = 1024 * 1024 * 1024;

/// A move is CROSS-CLOUD when BOTH ends are remote (cloud) stores — the case that bills
/// egress (e.g. GCS→AWS). A `local→cloud` upload is NOT cross-cloud (no source egress bill).
pub fn is_cross_cloud(src_is_remote: bool, dst_is_remote: bool) -> bool {
    src_is_remote && dst_is_remote
}

/// The cost-gate decision (INV-7): a cross-cloud move at/above [`COST_GATE_BYTES`] requires an
/// explicit `cost_ack`. Pure, so both the manual-start endpoint and the auto-move orchestrator
/// gate identically — a large cross-cloud AUTO move parks needing an ack, never silently runs.
pub fn cost_ack_required(cross_cloud: bool, est: MigrationEstimate) -> bool {
    cross_cloud && est.total_bytes >= COST_GATE_BYTES
}

/// Estimate the move: blob count + total bytes over the SOURCE (the cost-gate input, INV-7).
pub async fn estimate(src: &Arc<dyn ObjectStore>) -> Result<MigrationEstimate, MigrationError> {
    let keys = src.list_keys().await.map_err(MigrationError::Source)?;
    let mut total_bytes = 0u64;
    for k in &keys {
        // A blob that vanishes between listing and stat (a concurrent GC) is simply not
        // counted — the estimate is advisory. A transport error, however, is surfaced.
        match src.stat(k).await {
            Ok(s) => total_bytes += s.len,
            Err(e) if e.status_code() == 404 => {}
            Err(e) => return Err(MigrationError::Source(e)),
        }
    }
    Ok(MigrationEstimate {
        blob_count: keys.len() as u64,
        total_bytes,
    })
}

/// Re-read a single blob from `store` and confirm it hashes to its own content-address key.
/// The one place the content-hash verification is expressed.
async fn verify_blob_in(store: &Arc<dyn ObjectStore>, key: &ContentKey) -> Result<u64, MigrationError> {
    let bytes = match store.get(key).await {
        Ok(b) => b,
        Err(e) if e.status_code() == 404 => {
            return Err(MigrationError::DestMissing { key: key.as_str().to_string() })
        }
        Err(e) => return Err(MigrationError::Dest(e)),
    };
    let got = sha256_hex(&bytes);
    if got != key.hex() {
        return Err(MigrationError::VerifyMismatch {
            key: key.as_str().to_string(),
            expected_hex: key.hex().to_string(),
            got_hex: got,
        });
    }
    Ok(bytes.len() as u64)
}

/// Copy every source blob to the destination and verify each by content hash. HALTS on the
/// first verify mismatch (INV-4). Never writes to or deletes the source (INV-3). Idempotent:
/// a blob already present + verified in the destination is skipped (resumable after a
/// restart). `progress` is invoked after every blob so the caller can persist N/M + bytes.
pub async fn copy_and_verify(
    src: &Arc<dyn ObjectStore>,
    dst: &Arc<dyn ObjectStore>,
    // `+ Send` so the copy can run inside a spawned background task (the orchestrator).
    progress: &mut (dyn FnMut(&CopyProgress) + Send),
) -> Result<CopyReport, MigrationError> {
    let keys = src.list_keys().await.map_err(MigrationError::Source)?;

    // Pre-size the progress totals from a stat pass (best-effort bytes).
    let est = estimate(src).await?;
    let mut prog = CopyProgress {
        blobs_total: keys.len() as u64,
        bytes_total: est.total_bytes,
        ..Default::default()
    };
    let mut report = CopyReport {
        copied: 0,
        skipped_already_present: 0,
        verified: 0,
        bytes_copied: 0,
    };

    for key in &keys {
        // Resume / dedup: if the destination already has this blob AND it verifies, skip the
        // re-copy but STILL count it as verified (so a resumed run still proves the whole set).
        let already = match dst.exists(key).await {
            Ok(present) => present,
            Err(e) => return Err(MigrationError::Dest(e)),
        };
        if already {
            let len = verify_blob_in(dst, key).await?; // a corrupt pre-existing dest blob HALTS
            report.skipped_already_present += 1;
            report.verified += 1;
            prog.blobs_done += 1;
            prog.bytes_done += len;
            prog.current_key = Some(key.as_str().to_string());
            progress(&prog);
            continue;
        }

        // Read from source (never mutated) and write to destination under the SAME key.
        let bytes = match src.get(key).await {
            Ok(b) => b,
            // A blob that vanished from the source since listing (concurrent GC of an
            // unreferenced blob) is not an error to migrate — skip it.
            Err(e) if e.status_code() == 404 => {
                prog.blobs_done += 1;
                progress(&prog);
                continue;
            }
            Err(e) => return Err(MigrationError::Source(e)),
        };
        // Sanity: the source bytes must themselves match the key (a corrupt SOURCE blob must
        // not be silently propagated as if verified).
        if sha256_hex(&bytes) != key.hex() {
            return Err(MigrationError::VerifyMismatch {
                key: key.as_str().to_string(),
                expected_hex: key.hex().to_string(),
                got_hex: sha256_hex(&bytes),
            });
        }
        dst.put(&bytes).await.map_err(MigrationError::Dest)?;

        // VERIFY: re-read from the DESTINATION and confirm the content hash. This is the
        // check that catches a bad write / a bad pairing — a mismatch HALTS.
        let len = verify_blob_in(dst, key).await?;

        report.copied += 1;
        report.verified += 1;
        report.bytes_copied += len;
        prog.blobs_done += 1;
        prog.bytes_done += len;
        prog.current_key = Some(key.as_str().to_string());
        progress(&prog);
    }

    Ok(report)
}

/// The RETIRE-time gate (INV-3): prove EVERY source blob is present AND content-verified in
/// the destination. Returns the count verified, or the first `VerifyMismatch`/`DestMissing`.
/// The source is NEVER touched. A caller may delete the source ONLY after this returns `Ok`.
pub async fn verify_all(
    src: &Arc<dyn ObjectStore>,
    dst: &Arc<dyn ObjectStore>,
) -> Result<u64, MigrationError> {
    let keys = src.list_keys().await.map_err(MigrationError::Source)?;
    let mut verified = 0u64;
    for key in &keys {
        // Every source key must be present + correct in the destination.
        verify_blob_in(dst, key).await?;
        verified += 1;
    }
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workstore::object_store::LocalFsStore;

    fn tmp() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ws-mig-{}", uuid::Uuid::new_v4()))
    }
    fn store(dir: &std::path::Path) -> Arc<dyn ObjectStore> {
        Arc::new(LocalFsStore::new(dir)) as Arc<dyn ObjectStore>
    }

    /// The happy path: every blob copies, verifies by content hash, and the SOURCE is
    /// untouched (still holds every blob afterward) — INV-2 + INV-3.
    #[tokio::test]
    // TEST-U4
    async fn copy_verify_moves_every_blob_and_never_touches_source() {
        let (sd, dd) = (tmp(), tmp());
        let src = store(&sd);
        let dst = store(&dd);
        let mut keys = Vec::new();
        for i in 0..25u32 {
            keys.push(src.put(format!("blob-{i}").as_bytes()).await.unwrap());
        }
        let src_before = src.list_keys().await.unwrap().len();

        let mut seen = 0u64;
        let report = copy_and_verify(&src, &dst, &mut |p| { seen = p.blobs_done; })
            .await
            .expect("clean migration");
        assert_eq!(report.copied, 25);
        assert_eq!(report.verified, 25);
        assert_eq!(seen, 25, "progress reached the final blob");

        // Every blob is in the destination under the same key, byte-identical.
        for (i, k) in keys.iter().enumerate() {
            assert_eq!(dst.get(k).await.unwrap(), format!("blob-{i}").as_bytes());
        }
        // The SOURCE is untouched — INV-3 (nothing deleted).
        assert_eq!(src.list_keys().await.unwrap().len(), src_before);
        assert_eq!(src.list_keys().await.unwrap().len(), 25);

        // verify_all passes ⇒ retire would be permitted.
        assert_eq!(verify_all(&src, &dst).await.unwrap(), 25);

        let _ = std::fs::remove_dir_all(&sd);
        let _ = std::fs::remove_dir_all(&dd);
    }

    /// Idempotent / resumable: a second pass copies nothing new but still verifies the whole
    /// set (a blob already present + verified is skipped, not re-copied).
    #[tokio::test]
    // TEST-U6
    async fn second_pass_is_idempotent_and_still_verifies() {
        let (sd, dd) = (tmp(), tmp());
        let src = store(&sd);
        let dst = store(&dd);
        for i in 0..10u32 {
            src.put(format!("x-{i}").as_bytes()).await.unwrap();
        }
        let r1 = copy_and_verify(&src, &dst, &mut |_| {}).await.unwrap();
        assert_eq!(r1.copied, 10);
        let r2 = copy_and_verify(&src, &dst, &mut |_| {}).await.unwrap();
        assert_eq!(r2.copied, 0, "nothing re-copied");
        assert_eq!(r2.skipped_already_present, 10);
        assert_eq!(r2.verified, 10, "the whole set is still proven on a resumed run");
        let _ = std::fs::remove_dir_all(&sd);
        let _ = std::fs::remove_dir_all(&dd);
    }

    /// A destination store that CORRUPTS bytes on read — a stand-in for a bad backend / a
    /// bad pairing where a write does not round-trip. Its `get` returns tampered bytes so the
    /// content-hash verify must catch it.
    struct TamperReadStore {
        inner: Arc<dyn ObjectStore>,
    }
    #[async_trait::async_trait]
    impl ObjectStore for TamperReadStore {
        async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError> {
            self.inner.put(bytes).await
        }
        async fn put_prefix(
            &self,
            members: &[(String, Vec<u8>)],
        ) -> Result<super::super::object_store::MultiFilePut, AppError> {
            self.inner.put_prefix(members).await
        }
        async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError> {
            // Return bytes that do NOT hash to the key (a corrupt read-back).
            let mut b = self.inner.get(key).await?;
            b.push(0xFF); // one extra byte ⇒ a different sha256
            Ok(b)
        }
        async fn get_range(&self, key: &ContentKey, o: u64, l: u64) -> Result<Vec<u8>, AppError> {
            self.inner.get_range(key, o, l).await
        }
        async fn get_stream(
            &self,
            key: &ContentKey,
            o: u64,
            l: u64,
        ) -> Result<super::super::object_store::ByteStream, AppError> {
            self.inner.get_stream(key, o, l).await
        }
        async fn stat(&self, key: &ContentKey) -> Result<super::super::object_store::ObjectStat, AppError> {
            self.inner.stat(key).await
        }
        async fn exists(&self, key: &ContentKey) -> Result<bool, AppError> {
            self.inner.exists(key).await
        }
        async fn delete(&self, key: &ContentKey) -> Result<(), AppError> {
            self.inner.delete(key).await
        }
        async fn resolve_member(&self, m: &ContentKey, p: &str) -> Result<ContentKey, AppError> {
            self.inner.resolve_member(m, p).await
        }
        async fn gc(
            &self,
            keep: &std::collections::HashSet<String>,
            age: u64,
        ) -> Result<super::super::object_store::GcReport, AppError> {
            self.inner.gc(keep, age).await
        }
        async fn list_keys(&self) -> Result<Vec<ContentKey>, AppError> {
            self.inner.list_keys().await
        }
    }

    /// INV-4 (the data-integrity STOP): a destination that fails the content-hash verify
    /// causes the migration to HALT with `VerifyMismatch`, and the SOURCE is left fully
    /// intact (every blob still present) — the caller stays on the old store (auto-rollback).
    /// Flip the verify off and this test goes green with a corrupt destination — that is what
    /// makes it a real proof of INV-4.
    #[tokio::test]
    // TEST-U5
    async fn a_verify_mismatch_halts_and_leaves_the_source_intact() {
        let (sd, dd) = (tmp(), tmp());
        let src = store(&sd);
        let real_dst = store(&dd);
        for i in 0..5u32 {
            src.put(format!("v-{i}").as_bytes()).await.unwrap();
        }
        let tamper_dst = Arc::new(TamperReadStore { inner: real_dst.clone() }) as Arc<dyn ObjectStore>;

        let err = copy_and_verify(&src, &tamper_dst, &mut |_| {})
            .await
            .expect_err("a corrupt destination read must halt the migration");
        assert!(
            matches!(err, MigrationError::VerifyMismatch { .. }),
            "expected a content-hash VerifyMismatch, got {err:?}"
        );
        assert_eq!(err.category(), "content-hash verification failed");

        // AUTO-ROLLBACK safety: the source is untouched — every blob still present.
        assert_eq!(src.list_keys().await.unwrap().len(), 5, "source must be fully intact after a halt");

        // And verify_all (the retire gate) also refuses over the corrupt destination, so a
        // retire could NEVER delete a source blob here.
        assert!(verify_all(&src, &tamper_dst).await.is_err(), "retire gate must refuse a corrupt dest");

        let _ = std::fs::remove_dir_all(&sd);
        let _ = std::fs::remove_dir_all(&dd);
    }

    /// INV-7 — the cost-gate: a large CROSS-CLOUD move needs an explicit ack; a local→cloud
    /// move (no source egress bill) and a small cross-cloud move do not. Pure.
    #[test]
    // TEST-U7
    fn cost_gate_requires_ack_only_for_large_cross_cloud() {
        let big = MigrationEstimate { blob_count: 100, total_bytes: COST_GATE_BYTES };
        let small = MigrationEstimate { blob_count: 3, total_bytes: 10 };
        // cross-cloud (cloud→cloud), big ⇒ ack required.
        assert!(cost_ack_required(is_cross_cloud(true, true), big));
        // cross-cloud but small ⇒ no ack.
        assert!(!cost_ack_required(is_cross_cloud(true, true), small));
        // local→cloud (source not remote) big ⇒ not cross-cloud ⇒ no ack (no egress bill).
        assert!(!cost_ack_required(is_cross_cloud(false, true), big));
        // cloud→local is not cross-cloud either.
        assert!(!cost_ack_required(is_cross_cloud(true, false), big));
        assert!(!is_cross_cloud(false, true));
        assert!(is_cross_cloud(true, true));
    }

    /// The estimate reflects blob count + total bytes (the cost-gate input, INV-7).
    #[tokio::test]
    async fn estimate_counts_blobs_and_bytes() {
        let sd = tmp();
        let src = store(&sd);
        src.put(b"aaaa").await.unwrap(); // 4 bytes
        src.put(b"bbbbbb").await.unwrap(); // 6 bytes
        let est = estimate(&src).await.unwrap();
        assert_eq!(est.blob_count, 2);
        assert_eq!(est.total_bytes, 10);
        let _ = std::fs::remove_dir_all(&sd);
    }
}
