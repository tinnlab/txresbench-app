//! #64 DEC-5 — the OLD-store config preservation SECURITY anchor, end-to-end against a real
//! spawned server in ENCRYPTED mode (pgcrypto). Proves the non-negotiable no-leak-but-recoverable
//! contract that makes a cloud→cloud LIVE cutover restart-safe:
//!  - the OLD store's full connection config (INCLUDING cloud credentials) is stored as CIPHERTEXT
//!    (never plaintext) in `object_store_migration.src_config_ciphertext`;
//!  - it decrypts back byte-identically, so boot can rebuild the DualRead fallback for ANY pair;
//!  - a LOCAL source has no secret and stores NULL, rebuilding from the local root;
//!  - a masked status view (`MigrationStatusView`) never carries the ciphertext (it is
//!    `#[serde(skip)]`), so no endpoint body leaks it.
//!
//! `saas`-only (the whole cutover/migration surface is). Needs a reachable Postgres (the shared
//! build cluster) — it does NOT need the cloud-sim; it exercises the encryption + persistence.

#![cfg(feature = "saas")]

use cytoanalyst::modules::workstore::cutover::PreservedStoreConfig;
use cytoanalyst::modules::workstore::migration_repo as repo;
use uuid::Uuid;

use crate::account::pool_for;
use crate::common::{TestOptions, TestServer};

const STORAGE_KEY: &str = "cutover-old-config-test-storage-key-0123456789abcdef";

fn new_migration(src_ct: Option<Vec<u8>>, src_backend: &str) -> repo::NewMigration {
    repo::NewMigration {
        src_backend: src_backend.to_string(),
        src_provider: Some("gcs".to_string()),
        src_bucket: Some("old-bucket".to_string()),
        dst_backend: "s3".to_string(),
        dst_provider: Some("s3".to_string()),
        dst_bucket: Some("new-bucket".to_string()),
        cross_cloud: true,
        cost_ack: false,
        auto_started: true,
        blobs_total: 0,
        bytes_total: 0,
        src_config_ciphertext: src_ct,
    }
}

/// TEST-I5 [acceptance] [invariant: INV-6] — a CLOUD OLD config round-trips through
/// encrypt→store→read→decrypt with credentials intact, and the ciphertext contains NO plaintext
/// secret. This is the DEC-5 security anchor: flip the encryption off and the ciphertext would
/// carry the plaintext key — the `!contains` assertions would fail — so it is a real no-leak proof.
#[tokio::test]
async fn preserved_cloud_config_is_ciphertext_and_recovers_byte_identically() {
    let server =
        TestServer::spawn_with(TestOptions { secret_storage_key: Some(STORAGE_KEY.to_string()), ..Default::default() })
            .await;
    // The in-process resolver leg reads the PROCESS storage key (the harness sets it on the
    // spawned server subprocess; this sets it for the test process's own encrypt/decrypt calls).
    ziee_framework::secrets::init_storage_key(Some(STORAGE_KEY.to_string()));
    let pool = pool_for(&server).await;

    let cloud = PreservedStoreConfig {
        backend: "s3".to_string(),
        provider: Some("gcs".to_string()),
        endpoint: Some("https://storage.example.com".to_string()),
        bucket: Some("old-bucket".to_string()),
        region: Some("us-east-1".to_string()),
        path_style: Some(true),
        access_key_id: Some("AKIA_OLD_ACCESS_KEY".to_string()),
        secret_access_key: Some("super-secret-OLD-value-42".to_string()),
    };

    // Encrypt → the result is real ciphertext, NOT the plaintext.
    let ct = repo::encrypt_preserved_old_config(&pool, &cloud)
        .await
        .expect("encrypt ok")
        .expect("a cloud config with a storage key yields ciphertext");
    let ct_lossy = String::from_utf8_lossy(&ct);
    assert!(
        !ct_lossy.contains("super-secret-OLD-value-42") && !ct_lossy.contains("AKIA_OLD_ACCESS_KEY"),
        "INV: the stored ciphertext must NOT contain the plaintext credentials"
    );

    // Persist it in a REAL migration row, read it back, decrypt → credentials recovered intact.
    let row = repo::create(&pool, &new_migration(Some(ct), "s3"), Uuid::new_v4())
        .await
        .expect("create migration row");
    let fetched = repo::by_id(&pool, row.id).await.expect("by_id").expect("row present");
    let recovered = repo::decrypt_preserved_old_config(&pool, &fetched)
        .await
        .expect("decrypts back to a usable config");
    assert_eq!(recovered.backend, "s3");
    assert_eq!(recovered.access_key_id.as_deref(), Some("AKIA_OLD_ACCESS_KEY"));
    assert_eq!(recovered.secret_access_key.as_deref(), Some("super-secret-OLD-value-42"));
    assert_eq!(recovered.bucket.as_deref(), Some("old-bucket"));
    assert_eq!(recovered.region.as_deref(), Some("us-east-1"));
    assert_eq!(recovered.path_style, Some(true));

    // The masked status endpoint NEVER carries the ciphertext (serde-skipped): the GET body has
    // no trace of the secret, and no `src_config` field at all.
    let admin = crate::account::setup_admin(&server).await;
    let body = server
        .client
        .get(server.api_url("/admin/infra/migration"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET migration")
        .text()
        .await
        .expect("body");
    assert!(!body.contains("super-secret-OLD-value-42"), "status body must not leak the plaintext");
    assert!(!body.contains("src_config"), "status body must not carry the preserved config field");
}

/// TEST-I6 [acceptance] [invariant: INV-6] — a LOCAL source carries no secret: it stores NULL
/// ciphertext and decrypts to a local config (rebuilt from the local root at boot), so the
/// no-secret path is never mistaken for an undecryptable one.
#[tokio::test]
async fn preserved_local_config_stores_null_and_recovers_as_local() {
    let server = TestServer::spawn_with(TestOptions::default()).await;
    let pool = pool_for(&server).await;

    let local = PreservedStoreConfig::local();
    assert!(!local.has_secret());
    let ct = repo::encrypt_preserved_old_config(&pool, &local).await.expect("ok");
    assert!(ct.is_none(), "a local source has no secret to preserve ⇒ NULL ciphertext");

    let row = repo::create(&pool, &new_migration(None, "local"), Uuid::new_v4())
        .await
        .expect("create");
    let fetched = repo::by_id(&pool, row.id).await.expect("by_id").expect("row");
    let recovered = repo::decrypt_preserved_old_config(&pool, &fetched)
        .await
        .expect("a NULL-ciphertext local row rebuilds as local");
    assert_eq!(recovered.backend, "local");
    assert!(!recovered.has_secret());
}
