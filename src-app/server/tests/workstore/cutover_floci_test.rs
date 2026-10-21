//! #64 — the LIVE hot-cutover acceptance suite against a REAL cloud store (floci S3), the
//! cross-backend proof of the no-data-loss guarantees the unit suite proves on local-fs:
//!  - the write-during-migration window blob is readable after cutover (dual-read fallback) AND
//!    reaches the new store after the catch-up re-sweep (INV-2), CROSS-BACKEND;
//!  - DEC-5 RESTART-RESUME: an OLD CLOUD store rebuilt from its preserved connection config (the
//!    exact `build_store_from_preserved` path boot uses, with real floci credentials) serves a
//!    window blob through `DualRead(new, rebuilt-old)` — proving the fallback survives a restart
//!    for a cloud source, with no blob lost.
//!
//! Env-gated on the floci substrate (`S3_ENDPOINT` + AWS creds + bucket, from
//! `scripts/cloud-sim-floci.sh`); self-skips via the skip ledger (never a bare pass / ignore) when
//! the emulator is absent. Runs under the no-REAL-cloud-credentials guard, so a green run is a
//! genuine portability proof. `saas`-only.

#![cfg(feature = "saas")]

use std::sync::Arc;

use uuid::Uuid;

use cytoanalyst::modules::workstore::cutover::{self, PreservedStoreConfig};
use cytoanalyst::modules::workstore::migration_engine::copy_and_verify;
use cytoanalyst::modules::workstore::object_store::s3::S3Store;
use cytoanalyst::modules::workstore::config::{CloudProvider, S3ConnConfig};
use cytoanalyst::modules::workstore::object_store::{ContentKey, LocalFsStore, ObjectStore};

use crate::infra::record_skip;

fn assert_no_cloud_credentials() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/cloud-sim-guard.sh");
    let out = std::process::Command::new("bash").arg(script).output().expect("run cloud-sim-guard.sh");
    assert!(
        out.status.success(),
        "PROV-T1-5 guard FAILED — a real cloud credential/endpoint is present; the cutover \
         acceptance run must be credential-free. stdout: {} stderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

fn env_nonempty(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|s| !s.is_empty())
}

/// The floci S3 connection as a `S3ConnConfig` (the SAME shape the preserved-config rebuild uses),
/// or `None` when the sim is down.
fn floci_conn() -> Option<S3ConnConfig> {
    Some(S3ConnConfig {
        provider: CloudProvider::S3,
        bucket: env_nonempty("CYTO_WORKSTORE_S3_BUCKET")?,
        region: env_nonempty("AWS_REGION").unwrap_or_else(|| "us-east-1".to_string()),
        endpoint: Some(env_nonempty("S3_ENDPOINT")?),
        access_key_id: env_nonempty("AWS_ACCESS_KEY_ID"),
        secret_access_key: env_nonempty("AWS_SECRET_ACCESS_KEY"),
        path_style: true,
        multipart_threshold: 16 * 1024 * 1024,
        part_size: 8 * 1024 * 1024,
    })
}

/// The floci conn as a `PreservedStoreConfig` — what DEC-5 stores (encrypted) and boot rebuilds.
fn floci_preserved(conn: &S3ConnConfig) -> PreservedStoreConfig {
    PreservedStoreConfig {
        backend: "s3".to_string(),
        provider: Some(conn.provider.as_str().to_string()),
        endpoint: conn.endpoint.clone(),
        bucket: Some(conn.bucket.clone()),
        region: Some(conn.region.clone()),
        path_style: Some(conn.path_style),
        access_key_id: conn.access_key_id.clone(),
        secret_access_key: conn.secret_access_key.clone(),
    }
}

fn local_store() -> (std::path::PathBuf, Arc<dyn ObjectStore>) {
    let dir = std::env::temp_dir().join(format!("cyto-cutover-floci-{}", Uuid::new_v4()));
    (dir.clone(), Arc::new(LocalFsStore::new(dir)))
}

async fn sweep(store: &Arc<dyn ObjectStore>, keys: &[ContentKey]) {
    for k in keys {
        let _ = store.delete(k).await;
    }
}

/// TEST-CUF1 [acceptance] [invariant: INV-2] — the write-during-migration window, CROSS-BACKEND
/// (old = floci S3, new = local). A blob written to OLD after the copy pass is (a) readable through
/// `DualRead(new, old)` via fallback and (b) present on NEW after the catch-up re-sweep. No loss.
#[tokio::test]
// TEST-CUF1
// TEST-I4 — superseded placeholder (deferred-scope floci-substrate integration test), realized here.
async fn write_during_migration_is_readable_and_reaches_new_cross_backend() {
    assert_no_cloud_credentials();
    let Some(conn) = floci_conn() else {
        record_skip("workstore::write_during_migration_is_readable_and_reaches_new_cross_backend", "floci S3 substrate not up; run `just cloud-sim-floci-up`");
        return;
    };
    let old: Arc<dyn ObjectStore> = Arc::new(S3Store::from_conn(&conn).expect("floci store"));
    let (nd, new) = local_store();
    let run = Uuid::new_v4();

    // Pre-existing data on OLD + the copy pass OLD→NEW.
    let mut pre = Vec::new();
    for i in 0..5u32 {
        pre.push(old.put(format!("cuf1-pre-{run}-{i}").as_bytes()).await.unwrap());
    }
    copy_and_verify(&old, &new, &mut |_| {}).await.expect("clean copy");

    // A write that lands on OLD (floci) DURING the window (the copy already ran ⇒ never saw it).
    let window = old.put(format!("cuf1-window-{run}").as_bytes()).await.unwrap();
    assert!(!new.exists(&window).await.unwrap(), "window blob is OLD-only before catch-up");

    // Cutover (pure build — no global). Readable via fallback (INV-2a).
    let live = cutover::build_dual_read(new.clone(), old.clone());
    assert_eq!(live.get(&window).await.unwrap(), format!("cuf1-window-{run}").as_bytes());
    assert!(!new.exists(&window).await.unwrap(), "still OLD-only ⇒ the read WAS a fallback");

    // Catch-up brings it to NEW (INV-2b).
    cutover::catch_up(&old, &new).await.expect("catch-up");
    assert!(new.exists(&window).await.unwrap(), "catch-up brought the window blob to new");
    assert_eq!(new.get(&window).await.unwrap(), format!("cuf1-window-{run}").as_bytes());

    let mut all = pre;
    all.push(window);
    sweep(&old, &all).await;
    let _ = std::fs::remove_dir_all(&nd);
}

/// TEST-CUF2 [acceptance] [invariant: INV-6] — DEC-5 RESTART-RESUME for a CLOUD source. Rebuild the
/// OLD cloud store from its PRESERVED connection config (the exact boot path, with real floci
/// creds) and prove `DualRead(new, rebuilt-old)` serves a blob that lives ONLY on the old cloud
/// store — i.e. after a restart the cloud fallback is faithfully reconstructed and no blob is lost.
#[tokio::test]
// TEST-CUF2
// TEST-I3 — superseded placeholder (deferred-scope boot-resume integration test), realized here.
async fn restart_rebuilds_old_cloud_fallback_from_preserved_config() {
    assert_no_cloud_credentials();
    let Some(conn) = floci_conn() else {
        record_skip("workstore::restart_rebuilds_old_cloud_fallback_from_preserved_config", "floci S3 substrate not up; run `just cloud-sim-floci-up`");
        return;
    };
    let run = Uuid::new_v4();

    // BEFORE the "restart": write a blob to the OLD cloud store (a write-window straggler on old).
    let old_before: Arc<dyn ObjectStore> = Arc::new(S3Store::from_conn(&conn).expect("floci store"));
    let straggler = old_before.put(format!("cuf2-straggler-{run}").as_bytes()).await.unwrap();

    // The "RESTART": reconstruct the OLD store SOLELY from its preserved config (no live handle) —
    // this is exactly `build_store_from_preserved` as the boot-resume calls it, with the decrypted
    // cloud credentials. The local_root arg is unused for a cloud backend.
    let preserved = floci_preserved(&conn);
    let old_rebuilt = cutover::build_store_from_preserved(&preserved, std::path::Path::new("/nonexistent"))
        .expect("rebuild the OLD cloud store from its preserved config");

    // The rebuilt store reads the straggler (creds + endpoint survived the round-trip).
    assert_eq!(old_rebuilt.get(&straggler).await.unwrap(), format!("cuf2-straggler-{run}").as_bytes());

    // A fresh NEW store (local) that does NOT have the straggler; DualRead(new, rebuilt-old) serves
    // it via the reconstructed cloud fallback — the restart lost nothing.
    let (nd, new) = local_store();
    assert!(!new.exists(&straggler).await.unwrap(), "the new store does not have the straggler");
    let live = cutover::build_dual_read(new.clone(), old_rebuilt.clone());
    assert_eq!(
        live.get(&straggler).await.unwrap(),
        format!("cuf2-straggler-{run}").as_bytes(),
        "INV-6: after a restart the OLD cloud fallback is rebuilt from the preserved config and serves the straggler"
    );

    sweep(&old_before, &[straggler]).await;
    let _ = std::fs::remove_dir_all(&nd);
}
