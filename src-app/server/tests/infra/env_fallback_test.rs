//! TEST-16 [acceptance INV-5] — env stays the FALLBACK: (a) an unconfigured DB row is the
//! empty override (compat, byte-identical to env-only resolution); (b) a PUT carrying a
//! secret while `secrets.storage_key` is UNSET is refused with a clean 400 (never stores
//! plaintext).

use serde_json::json;

use crate::account::{pool_for, setup_admin};
use crate::common::{TestOptions, TestServer};
use crate::infra::encrypted_opts;

/// TEST-16a [acceptance] [invariant: INV-5] [covers: ITEM-5]: with no configured DB row,
/// `load_db_config` yields the EMPTY override — so `resolve_with_db` == `resolve_for`
/// (byte-identical env-only resolution, compat mode).
#[tokio::test]
async fn unconfigured_row_is_the_empty_override() {
    // A default server (no storage key) — the seeded singleton row is all-NULL.
    let server = TestServer::spawn_with(TestOptions::default()).await;
    let _admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let db = cytoanalyst::modules::workstore::infra_object_store::load_db_config(&pool).await;
    assert!(
        db.is_empty(),
        "an unconfigured row must be the empty override (env-only, byte-identical): {db:?}"
    );
}

/// TEST-16b [acceptance] [invariant: INV-5] [covers: ITEM-5]: a PUT carrying a secret while
/// `secrets.storage_key` is UNSET returns a clean 400 `SECRET_STORAGE_DISABLED` and stores
/// nothing (never plaintext).
#[tokio::test]
async fn put_secret_without_storage_key_is_refused_400() {
    let server = TestServer::spawn_with(TestOptions::default()).await; // NO storage key
    let admin = setup_admin(&server).await;

    let resp = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "access_key_id": "AKIA_would_be_plaintext" }))
        .send()
        .await
        .expect("PUT");
    assert_eq!(
        resp.status().as_u16(),
        400,
        "storing a secret with no storage key must be refused, never stored plaintext"
    );
    let body = resp.text().await.expect("body");
    assert!(
        body.contains("SECRET_STORAGE_DISABLED"),
        "the refusal must name the disabled-storage error; got: {body}"
    );

    // Nothing was written.
    let pool = pool_for(&server).await;
    let ct = sqlx::query_scalar!(
        r#"SELECT access_key_ciphertext FROM infra_object_store WHERE singleton = true"#
    )
    .fetch_one(&pool)
    .await
    .expect("row");
    assert!(ct.is_none(), "a refused PUT must not have stored anything");
}

/// TEST-16c [covers: ITEM-3]: with encryption ENABLED, the same PUT succeeds (the 400 is
/// specifically the no-key path, not a broken endpoint) — the positive control for 16b.
#[tokio::test]
async fn put_secret_with_storage_key_succeeds() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    let resp = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "access_key_id": "AKIAIOSFODNN7EXAMPLE" }))
        .send()
        .await
        .expect("PUT");
    assert_eq!(resp.status().as_u16(), 200, "with a storage key, the PUT succeeds");
}
