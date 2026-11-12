//! #65 — abandon a verified migration + revert to the OLD store, proven against a REAL second store
//! (floci S3): the cross-backend data-loss proof of the guarantees the local-fs suite proves
//! in-process. A local→floci copy+verify+cutover, then ABANDON: the live primary reverts to the
//! LOCAL old store (every local blob readable), the FLOCI copy is still fully intact (NO blob
//! deleted from the new store), and `latest_unretired` is `None` (the store is reconfigurable).
//!
//! Env-gated on the floci substrate (`S3_ENDPOINT` + AWS creds + bucket, from
//! `scripts/cloud-sim-floci.sh`); self-skips via the skip ledger (never a bare pass / ignore) when
//! the emulator is absent. Runs under the no-REAL-cloud-credentials guard, so a green run is a
//! genuine portability proof. `saas`-only.

#![cfg(feature = "saas")]

use std::sync::Arc;

use txresbench::modules::workstore::config::{CloudProvider, S3ConnConfig};
use txresbench::modules::workstore::cutover;
use txresbench::modules::workstore::migration_api;
use txresbench::modules::workstore::migration_repo::{self as repo, phase, NewMigration};
use txresbench::modules::workstore::object_store::s3::S3Store;
use txresbench::modules::workstore::object_store::{LocalFsStore, ObjectStore};
use txresbench::modules::workstore::{get_object_store, swap_object_store};
use uuid::Uuid;

use crate::account::pool_for;
use crate::common::{TestOptions, TestServer};
use crate::infra::record_skip;

const STORAGE_KEY: &str = "migration-abandon-floci-storage-key-0123456789ab";

/// Serializes the process-global store-handle swaps in this file (shared across the test binary).
static GLOBAL_HANDLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn assert_no_cloud_credentials() {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/cloud-sim-guard.sh");
    let out = std::process::Command::new("bash").arg(script).output().expect("run cloud-sim-guard.sh");
    assert!(
        out.status.success(),
        "guard FAILED — a real cloud credential/endpoint is present; the abandon acceptance run must \
         be credential-free. stdout: {} stderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

fn env_nonempty(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|s| !s.is_empty())
}

fn floci_conn() -> Option<S3ConnConfig> {
    Some(S3ConnConfig {
        provider: CloudProvider::S3,
        bucket: env_nonempty("TXR_WORKSTORE_S3_BUCKET")?,
        region: env_nonempty("AWS_REGION").unwrap_or_else(|| "us-east-1".to_string()),
        endpoint: Some(env_nonempty("S3_ENDPOINT")?),
        access_key_id: env_nonempty("AWS_ACCESS_KEY_ID"),
        secret_access_key: env_nonempty("AWS_SECRET_ACCESS_KEY"),
        path_style: true,
        multipart_threshold: 16 * 1024 * 1024,
        part_size: 8 * 1024 * 1024,
    })
}

fn tmp() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("ws-abandon-floci-{}", Uuid::new_v4()))
}

/// TEST-5 [acceptance] [invariant: INV-1, INV-3] — abandon over a REAL floci S3 second store.
#[tokio::test]
async fn abandon_reverts_to_local_and_leaves_the_floci_copy_intact() {
    let _guard = GLOBAL_HANDLE_LOCK.lock().await;
    let conn = match floci_conn() {
        Some(c) => c,
        None => {
            record_skip(
                "workstore::abandon_reverts_to_local_and_leaves_the_floci_copy_intact",
                "floci S3 substrate not up (S3_ENDPOINT/AWS_*/TXR_WORKSTORE_S3_BUCKET unset); run `just cloud-sim-test-floci`",
            );
            return;
        }
    };
    assert_no_cloud_credentials();

    let server = TestServer::spawn_with(TestOptions {
        secret_storage_key: Some(STORAGE_KEY.to_string()),
        ..Default::default()
    })
    .await;
    let pool = pool_for(&server).await;
    let actor = Uuid::new_v4();

    // OLD = local; NEW = floci S3. Seed OLD, copy+verify OLD→NEW, add an OLD-only window straggler.
    let od = tmp();
    let old: Arc<dyn ObjectStore> = Arc::new(LocalFsStore::new(&od));
    let new: Arc<dyn ObjectStore> = Arc::new(S3Store::from_conn(&conn).expect("floci store"));

    let mut keys = Vec::new();
    for i in 0..5u32 {
        keys.push(old.put(format!("abandon-floci-{}-{i}", Uuid::new_v4()).as_bytes()).await.unwrap());
    }
    cutover::catch_up(&old, &new).await.expect("copy+verify OLD→floci");
    let straggler = old.put(format!("abandon-floci-straggler-{}", Uuid::new_v4()).as_bytes()).await.unwrap();
    keys.push(straggler.clone());
    // Every seeded blob is present in floci now (except the straggler, which is OLD-only).
    for k in &keys[..keys.len() - 1] {
        assert!(new.exists(k).await.unwrap(), "precondition: the copied blob is in floci");
    }

    // Post-cutover LIVE state: DualRead(floci, local).
    cutover::install_dual_read(new.clone(), old.clone());

    let row0 = repo::create(
        &pool,
        &NewMigration {
            src_backend: "local".to_string(),
            src_provider: None,
            src_bucket: None,
            dst_backend: "s3".to_string(),
            dst_provider: Some("s3".to_string()),
            dst_bucket: Some(conn.bucket.clone()),
            cross_cloud: false,
            cost_ack: false,
            auto_started: true,
            blobs_total: 0,
            bytes_total: 0,
            src_config_ciphertext: None,
        },
        actor,
    )
    .await
    .unwrap();
    repo::set_phase(&pool, row0.id, phase::VERIFIED).await.unwrap();
    let row = repo::by_id(&pool, row0.id).await.unwrap().unwrap();

    // Count the floci copy right before abandon — the no-loss oracle for the NEW store.
    let floci_before: std::collections::HashSet<String> =
        new.list_keys().await.unwrap().iter().map(|k| k.as_str().to_string()).collect();

    // ABANDON.
    let outcome = migration_api::abandon_to_old(&pool, &row, actor).await.expect("abandon");
    assert_eq!(outcome.reverted_to, "local");

    // (a) the LIVE primary is the LOCAL old store now — every OLD blob incl. the straggler is readable.
    let live = get_object_store();
    assert!(live.as_dual_read().is_none(), "reverted to the bare local OLD store");
    for k in &keys {
        assert!(live.get(k).await.is_ok(), "every OLD blob is served after the revert");
    }

    // (b) the FLOCI copy is STILL fully intact — NOT a single blob deleted from the new store.
    let floci_after: std::collections::HashSet<String> =
        new.list_keys().await.unwrap().iter().map(|k| k.as_str().to_string()).collect();
    for k in &floci_before {
        assert!(floci_after.contains(k), "INV-1: abandon deleted a blob from the floci NEW store: {k}");
    }
    assert_eq!(floci_before.len(), floci_after.len(), "INV-1: the floci copy is left exactly in place");

    // (c) reconfigurable — the migration is abandoned, the 409 is cleared.
    assert_eq!(repo::by_id(&pool, row.id).await.unwrap().unwrap().phase, "abandoned");
    assert!(repo::latest_unretired(&pool).await.unwrap().is_none(), "INV-3: reconfigurable after abandon");

    // Clean up: delete only the blobs THIS test wrote to floci (leave the bucket usable), restore global.
    for k in &keys {
        let _ = new.delete(k).await;
    }
    swap_object_store(Arc::new(LocalFsStore::new(&tmp())));
    let _ = std::fs::remove_dir_all(&od);
}
