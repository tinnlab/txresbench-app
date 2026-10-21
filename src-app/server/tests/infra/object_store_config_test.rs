//! TEST-10 + TEST-12 [acceptance INV-1] — object-store config PUT → masked GET, and the
//! stored credential column is CIPHERTEXT (not plaintext), decrypting back to the original.

use serde_json::json;

use crate::account::{pool_for, setup_admin};
use crate::common::TestServer;
use crate::infra::{encrypted_opts, STORAGE_KEY};

const ACCESS_KEY: &str = "AKIAIOSFODNN7EXAMPLE"; // last4 = MPLE
const SECRET_KEY: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/// TEST-10 [covers: ITEM-1, ITEM-3]: PUT the object-store config, then GET returns the
/// masked view with the new non-secret config + `access_key_last4` + `secret_key_configured`
/// and NO secret field.
#[tokio::test]
async fn put_then_get_is_masked() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    let put = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({
            "backend": "s3",
            "provider": "s3",
            "endpoint": "http://s3.internal:9000",
            "bucket": "cyto-worklab",
            "region": "us-west-2",
            "path_style": true,
            "access_key_id": ACCESS_KEY,
            "secret_access_key": SECRET_KEY,
        }))
        .send()
        .await
        .expect("PUT object-store");
    assert_eq!(put.status().as_u16(), 200, "PUT should succeed");
    let put_body = put.text().await.expect("put body");
    assert!(
        !put_body.contains(ACCESS_KEY) && !put_body.contains(SECRET_KEY),
        "PUT response must not echo the plaintext credentials"
    );

    let get = server
        .client
        .get(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET object-store");
    assert_eq!(get.status().as_u16(), 200);
    let body = get.text().await.expect("get body");
    assert!(
        !body.contains(ACCESS_KEY) && !body.contains(SECRET_KEY),
        "GET body must NEVER contain the plaintext credentials; got: {body}"
    );
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["backend"], json!("s3"));
    assert_eq!(v["bucket"], json!("cyto-worklab"));
    assert_eq!(v["region"], json!("us-west-2"));
    assert_eq!(v["access_key_last4"], json!("MPLE"), "last4 is the tail of the access key");
    assert_eq!(v["secret_key_configured"], json!(true));
    assert_eq!(v["status"], json!("database"));
    // No secret field of any kind is present.
    assert!(v.get("access_key_id").is_none());
    assert!(v.get("secret_access_key").is_none());
}

/// TEST-12 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-3]: after a PUT with a
/// secret + `storage_key` set, the raw `secret_key_ciphertext` column is CIPHERTEXT (not
/// the plaintext bytes, and does not CONTAIN the plaintext), and decrypts back exactly.
#[tokio::test]
async fn put_stores_ciphertext_at_rest() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "access_key_id": ACCESS_KEY, "secret_access_key": SECRET_KEY }))
        .send()
        .await
        .expect("PUT creds");

    let pool = pool_for(&server).await;
    let row = sqlx::query!(
        r#"SELECT access_key_ciphertext, secret_key_ciphertext
           FROM infra_object_store WHERE singleton = true"#
    )
    .fetch_one(&pool)
    .await
    .expect("read row");
    let ak_ct = row.access_key_ciphertext.expect("access key ciphertext stored");
    let sk_ct = row.secret_key_ciphertext.expect("secret key ciphertext stored");
    assert_ne!(ak_ct.as_slice(), ACCESS_KEY.as_bytes(), "access key column must be CIPHERTEXT");
    assert_ne!(sk_ct.as_slice(), SECRET_KEY.as_bytes(), "secret key column must be CIPHERTEXT");
    assert!(
        !sk_ct.windows(SECRET_KEY.len()).any(|w| w == SECRET_KEY.as_bytes()),
        "the plaintext secret must not appear anywhere in the ciphertext bytes"
    );
    let dec_ak = ziee_framework::secret::decrypt_secret(&pool, &ak_ct, STORAGE_KEY)
        .await
        .expect("decrypt access key");
    let dec_sk = ziee_framework::secret::decrypt_secret(&pool, &sk_ct, STORAGE_KEY)
        .await
        .expect("decrypt secret key");
    assert_eq!(dec_ak, ACCESS_KEY, "decrypt round-trips the access key");
    assert_eq!(dec_sk, SECRET_KEY, "decrypt round-trips the secret key");
}

/// TEST-2 (#70) [acceptance] [invariant: INV-1] [covers: ITEM-5]: the admin object-store PUT
/// FAILS CLOSED on an unrecognized `backend` — a mis-typed value (e.g. `gcs`) is refused with
/// a **422** at the boundary (naming the bad value + the valid set), is NOT persisted, and
/// never silently resolves to the local-fs store (the #69 data-loss class, on the admin path).
/// Recognized backends (`s3`, `local`) still succeed. This proves the validator is actually
/// WIRED at the endpoint, not merely unit-callable.
#[tokio::test]
async fn put_rejects_unrecognized_backend_with_422() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    // A typo'd/unsupported backend is refused 422 — and does NOT touch the local-fs store.
    let bad = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "gcs" }))
        .send()
        .await
        .expect("PUT bad backend");
    assert_eq!(bad.status().as_u16(), 422, "an unrecognized backend must be a 422");
    let body = bad.text().await.expect("422 body");
    assert!(body.contains("gcs"), "422 must name the offending value: {body}");
    assert!(
        body.contains("local | local-fs | s3"),
        "422 must list the valid backend set: {body}"
    );

    // It was NOT persisted: the effective config is still the unconfigured/local default.
    let get = server
        .client
        .get(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET after bad PUT");
    assert_eq!(get.status().as_u16(), 200);
    let v: serde_json::Value = get.json().await.expect("get json");
    assert_ne!(v["backend"], json!("gcs"), "the bad backend must not have been stored");

    // A recognized backend (`local`; compute is local by default so the coupling guard is
    // satisfied) still succeeds — the validator refuses only UNrecognized values. (A full
    // `s3` config → 200 is covered by `put_then_get_is_masked`.)
    let ok = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "local" }))
        .send()
        .await
        .expect("PUT good backend");
    assert_eq!(ok.status().as_u16(), 200, "a recognized backend must be accepted");
}
