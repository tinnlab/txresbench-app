//! #61 — the two-store data-migration ENGINE acceptance suite, proving the data-loss
//! guarantees with a REAL cloud store (floci S3) as one end and local-fs as the other.
//! The engine's guarantees are also proven exhaustively at the unit level (local↔local) in
//! `migration_engine.rs`; this suite proves they hold CROSS-BACKEND against a live cloud store.
//!
//! Env-gated on the floci substrate (`S3_ENDPOINT` + AWS creds + bucket, written by
//! `scripts/cloud-sim-floci.sh` / `just cloud-sim-test-floci`); self-skips (via the skip
//! ledger, never a bare pass or an ignore attribute) when the emulator is absent. Runs under
//! the no-REAL-cloud-credentials guard so a green run is a genuine portability proof.
#![cfg(feature = "saas")]

use std::collections::HashSet;
use std::sync::Arc;

use uuid::Uuid;

use cytoanalyst::modules::workstore::config::{CloudProvider, S3ConnConfig};
use cytoanalyst::modules::workstore::migration_engine::{
    copy_and_verify, verify_all, MigrationError,
};
use cytoanalyst::modules::workstore::object_store::s3::S3Store;
use cytoanalyst::modules::workstore::object_store::{
    ByteStream, ContentKey, DualReadStore, GcReport, LocalFsStore, MultiFilePut, ObjectStat,
    ObjectStore,
};

use crate::infra::record_skip;

// ── the no-REAL-cloud-credentials guard (PROV-T1-5) ─────────────────────────────────
fn assert_no_cloud_credentials() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/cloud-sim-guard.sh");
    let out = std::process::Command::new("bash")
        .arg(script)
        .output()
        .expect("run cloud-sim-guard.sh");
    assert!(
        out.status.success(),
        "PROV-T1-5 guard FAILED — a real cloud credential/endpoint is present; the migration \
         acceptance run must be credential-free. stdout: {} stderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

fn env_nonempty(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|s| !s.is_empty())
}

/// A floci `S3Store`, or `None` (sim down ⇒ self-skip).
fn floci_store(prefix: &str) -> Option<(Arc<dyn ObjectStore>, String)> {
    // A per-test bucket-key PREFIX is not available (content-addressed keys are bucket-global),
    // so each run uses the shared bucket but content-addressed keys never collide destructively
    // (identical bytes ⇒ identical key ⇒ one object). We sweep our own probe keys at the end.
    let _ = prefix;
    let cfg = S3ConnConfig {
        provider: CloudProvider::S3,
        bucket: env_nonempty("CYTO_WORKSTORE_S3_BUCKET")?,
        region: env_nonempty("AWS_REGION").unwrap_or_else(|| "us-east-1".to_string()),
        endpoint: Some(env_nonempty("S3_ENDPOINT")?),
        access_key_id: env_nonempty("AWS_ACCESS_KEY_ID"),
        secret_access_key: env_nonempty("AWS_SECRET_ACCESS_KEY"),
        path_style: true,
        multipart_threshold: 16 * 1024 * 1024,
        part_size: 8 * 1024 * 1024,
    };
    let bucket = cfg.bucket.clone();
    Some((Arc::new(S3Store::from_conn(&cfg).ok()?), bucket))
}

fn local_store() -> (std::path::PathBuf, Arc<dyn ObjectStore>) {
    let dir = std::env::temp_dir().join(format!("cyto-mig-floci-{}", Uuid::new_v4()));
    (dir.clone(), Arc::new(LocalFsStore::new(dir)))
}

/// Sweep the blobs we wrote to the shared floci bucket (hygiene — never leave probe objects).
async fn sweep(store: &Arc<dyn ObjectStore>, keys: &[ContentKey]) {
    for k in keys {
        let _ = store.delete(k).await;
    }
}

/// ACC-F1 [acceptance] [invariant: INV-2, INV-3] — copy+verify local-fs → floci S3 moves EVERY
/// blob under the identical content key, VERIFIES each by content hash, and leaves the SOURCE
/// fully intact (nothing deleted). `verify_all` (the retire gate) then passes over the pair.
#[tokio::test]
    // TEST-CMF1
    async fn copy_verify_local_to_floci_keeps_source_intact() {
    assert_no_cloud_credentials();
    let Some((dst, _bucket)) = floci_store("acc1") else {
        record_skip(
            "workstore::copy_verify_local_to_floci_keeps_source_intact",
            "floci S3 substrate not up; run `just cloud-sim-floci-up`",
        );
        return;
    };
    let (sd, src) = local_store();

    // Seed unique-per-run blobs into the LOCAL source (unique so the shared bucket sweep is clean).
    let run = Uuid::new_v4();
    let mut keys = Vec::new();
    for i in 0..12u32 {
        keys.push(src.put(format!("floci-mig-{run}-{i}").as_bytes()).await.unwrap());
    }
    let src_before: HashSet<String> = src.list_keys().await.unwrap().iter().map(|k| k.as_str().to_string()).collect();

    let report = copy_and_verify(&src, &dst, &mut |_| {}).await.expect("clean cross-backend migration");
    assert_eq!(report.copied, 12);
    assert_eq!(report.verified, 12);

    // Every blob present + byte-identical in the REAL cloud store.
    for (i, k) in keys.iter().enumerate() {
        assert_eq!(dst.get(k).await.unwrap(), format!("floci-mig-{run}-{i}").as_bytes());
    }
    // INV-3: the SOURCE is untouched — every seeded blob still present.
    let src_after: HashSet<String> = src.list_keys().await.unwrap().iter().map(|k| k.as_str().to_string()).collect();
    assert!(src_before.is_subset(&src_after), "no source blob may be deleted by a migration");
    // The retire gate passes over the (now complete) pair.
    assert!(verify_all(&src, &dst).await.is_ok(), "verify_all must confirm every source blob in the dest");

    sweep(&dst, &keys).await;
    let _ = std::fs::remove_dir_all(&sd);
}

/// ACC-F2 [acceptance] [invariant: INV-4] — a forced content-hash MISMATCH on the floci
/// destination HALTS the migration (VerifyMismatch) and leaves the SOURCE intact; `verify_all`
/// (the retire gate) likewise refuses, so no source blob could ever be retired over a corrupt
/// destination. Cross-backend proof of rollback-safety.
#[tokio::test]
    // TEST-CMF2
    async fn a_forced_mismatch_halts_cross_backend_and_keeps_source() {
    assert_no_cloud_credentials();
    let Some((real_dst, _b)) = floci_store("acc2") else {
        record_skip(
            "workstore::a_forced_mismatch_halts_cross_backend_and_keeps_source",
            "floci S3 substrate not up; run `just cloud-sim-floci-up`",
        );
        return;
    };
    let (sd, src) = local_store();
    let run = Uuid::new_v4();
    let mut keys = Vec::new();
    for i in 0..4u32 {
        keys.push(src.put(format!("floci-tamper-{run}-{i}").as_bytes()).await.unwrap());
    }
    // The destination corrupts bytes on read-back — the content-hash verify must catch it.
    let tamper: Arc<dyn ObjectStore> = Arc::new(TamperReadStore { inner: real_dst.clone() });

    let err = copy_and_verify(&src, &tamper, &mut |_| {})
        .await
        .expect_err("a corrupt destination read-back must halt the migration");
    assert!(matches!(err, MigrationError::VerifyMismatch { .. }), "expected VerifyMismatch, got {err:?}");
    // Source fully intact after the halt (auto-rollback).
    assert_eq!(src.list_keys().await.unwrap().len(), 4);
    assert!(verify_all(&src, &tamper).await.is_err(), "retire gate must refuse a corrupt dest");

    sweep(&real_dst, &keys).await;
    let _ = std::fs::remove_dir_all(&sd);
}

/// ACC-F3 [acceptance] [invariant: INV-5] — DUAL-READ over (primary=floci S3, fallback=local)
/// serves a blob that lives ONLY in the fallback (un-migrated) — a partially-migrated read is
/// never surfaced as an absence.
#[tokio::test]
    // TEST-CMF3
    async fn dual_read_serves_unmigrated_blob_from_fallback_cross_backend() {
    assert_no_cloud_credentials();
    let Some((primary, _b)) = floci_store("acc3") else {
        record_skip(
            "workstore::dual_read_serves_unmigrated_blob_from_fallback_cross_backend",
            "floci S3 substrate not up; run `just cloud-sim-floci-up`",
        );
        return;
    };
    let (sd, fallback) = local_store();
    let run = Uuid::new_v4();
    // A blob only in the OLD (local, fallback) store — NOT copied to the new (floci) primary.
    let only_old = fallback.put(format!("floci-dual-{run}").as_bytes()).await.unwrap();

    let dual = DualReadStore::new(primary.clone(), fallback.clone());
    // Read through the dual-read decorator resolves it from the fallback (INV-5).
    assert_eq!(dual.get(&only_old).await.unwrap(), format!("floci-dual-{run}").as_bytes());
    assert!(dual.exists(&only_old).await.unwrap());
    // A write through the dual store lands in the PRIMARY (floci), not the fallback.
    let fresh = dual.put(format!("floci-dual-fresh-{run}").as_bytes()).await.unwrap();
    assert!(primary.exists(&fresh).await.unwrap(), "a post-switch write lands in the new store");
    assert!(!fallback.exists(&fresh).await.unwrap(), "a post-switch write must not touch the old store");

    sweep(&primary, &[fresh]).await;
    let _ = std::fs::remove_dir_all(&sd);
}

// A destination that corrupts bytes on read (a stand-in for a bad backend / bad pairing).
struct TamperReadStore {
    inner: Arc<dyn ObjectStore>,
}
#[async_trait::async_trait]
impl ObjectStore for TamperReadStore {
    async fn put(&self, bytes: &[u8]) -> Result<ContentKey, ziee_core::AppError> {
        self.inner.put(bytes).await
    }
    async fn put_prefix(&self, m: &[(String, Vec<u8>)]) -> Result<MultiFilePut, ziee_core::AppError> {
        self.inner.put_prefix(m).await
    }
    async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, ziee_core::AppError> {
        let mut b = self.inner.get(key).await?;
        b.push(0xFF); // one extra byte ⇒ a different sha256
        Ok(b)
    }
    async fn get_range(&self, key: &ContentKey, o: u64, l: u64) -> Result<Vec<u8>, ziee_core::AppError> {
        self.inner.get_range(key, o, l).await
    }
    async fn get_stream(&self, key: &ContentKey, o: u64, l: u64) -> Result<ByteStream, ziee_core::AppError> {
        self.inner.get_stream(key, o, l).await
    }
    async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, ziee_core::AppError> {
        self.inner.stat(key).await
    }
    async fn exists(&self, key: &ContentKey) -> Result<bool, ziee_core::AppError> {
        self.inner.exists(key).await
    }
    async fn delete(&self, key: &ContentKey) -> Result<(), ziee_core::AppError> {
        self.inner.delete(key).await
    }
    async fn resolve_member(&self, m: &ContentKey, p: &str) -> Result<ContentKey, ziee_core::AppError> {
        self.inner.resolve_member(m, p).await
    }
    async fn gc(&self, keep: &HashSet<String>, age: u64) -> Result<GcReport, ziee_core::AppError> {
        self.inner.gc(keep, age).await
    }
    async fn list_keys(&self) -> Result<Vec<ContentKey>, ziee_core::AppError> {
        self.inner.list_keys().await
    }
}
