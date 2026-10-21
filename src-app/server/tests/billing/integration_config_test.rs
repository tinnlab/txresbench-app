//! Billing-integration config acceptance tests (#60) — the SECURITY anchor.
//!
//! Proves the non-negotiable contract end-to-end against a real spawned server in
//! ENCRYPTED mode (the `secret_storage_key` harness knob):
//!  - INV-1: the DB column stores CIPHERTEXT (not plaintext), and `decrypt_secret`
//!    round-trips it back to the original.
//!  - INV-2: the GET returns a MASKED view (configured/last4) and its body contains
//!    NO plaintext secret.
//!  - INV-4: `resolve_secret` returns the DECRYPTED DB value (DB wins).
//!  - INV-6: a caller without `billing::admin` gets 403 on GET/PUT/POST (A9 deny).
//!  - A price-only PUT leaves the stored secret ciphertext UNCHANGED.

use serde_json::json;

use crate::account::{create_user, login, pool_for, setup_admin};
use crate::common::{TestOptions, TestServer};

/// A ≥32-char at-rest storage key — set both on the spawned server (via the harness
/// knob → `CYTO_SECRET_STORAGE_KEY`) and, for the in-process resolver leg, on the test
/// process's own global.
const STORAGE_KEY: &str = "billing-integration-test-storage-key-0123456789";
const SECRET: &str = "sk_live_TESTSECRET_abcdefgh4242";
const WEBHOOK: &str = "whsec_TESTWEBHOOK_zyxw";

fn encrypted_opts() -> TestOptions {
    TestOptions {
        secret_storage_key: Some(STORAGE_KEY.to_string()),
        ..Default::default()
    }
}

/// TEST-1 [acceptance] [invariant: INV-1] + TEST-2 [acceptance] [invariant: INV-2]:
/// after a `billing::admin` PUT of a Stripe secret, the DB column is CIPHERTEXT (not
/// the plaintext bytes) and decrypts back to the original; the GET returns a masked
/// view whose body contains NO plaintext secret.
#[tokio::test]
async fn put_stores_ciphertext_and_get_is_masked() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    // PUT the secret + webhook + a price mapping as the root admin.
    let put = server
        .client
        .put(server.api_url("/admin/billing/integration"))
        .bearer_auth(&admin)
        .json(&json!({
            "stripe_secret": SECRET,
            "webhook_secret": WEBHOOK,
            "prices": { "STRIPE_PRICE_PRO_BASE": "price_admin_pro_base" }
        }))
        .send()
        .await
        .expect("PUT integration");
    assert_eq!(put.status().as_u16(), 200, "PUT should succeed");
    let put_body = put.text().await.expect("put body");
    // INV-2: even the PUT response is the masked view — no plaintext echoed back.
    assert!(
        !put_body.contains(SECRET) && !put_body.contains(WEBHOOK),
        "PUT response must not echo the plaintext secret"
    );

    // INV-1: inspect the raw DB column — it must be non-null ciphertext, NOT the
    // plaintext bytes, and must decrypt back to the exact plaintext.
    let pool = pool_for(&server).await;
    let row = sqlx::query!(
        r#"SELECT stripe_secret_ciphertext, webhook_secret_ciphertext, price_ids
           FROM billing_integration WHERE singleton = true"#
    )
    .fetch_one(&pool)
    .await
    .expect("read integration row");
    let ct = row
        .stripe_secret_ciphertext
        .expect("stripe secret ciphertext stored");
    assert_ne!(
        ct.as_slice(),
        SECRET.as_bytes(),
        "stored column must be CIPHERTEXT, never the plaintext bytes"
    );
    assert!(
        !ct.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()),
        "the plaintext must not appear anywhere in the ciphertext bytes"
    );
    let decrypted =
        ziee_framework::secret::decrypt_secret(&pool, &ct, STORAGE_KEY)
            .await
            .expect("decrypt round-trip");
    assert_eq!(decrypted, SECRET, "decrypt must round-trip to the original");
    // The webhook secret is likewise ciphertext.
    assert!(row.webhook_secret_ciphertext.is_some(), "webhook ct stored");
    // The price mapping is plaintext operator config (not secret).
    assert_eq!(row.price_ids["STRIPE_PRICE_PRO_BASE"], "price_admin_pro_base");

    // INV-2: the GET returns a masked view — configured/last4, NO plaintext anywhere.
    let get = server
        .client
        .get(server.api_url("/admin/billing/integration"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET integration");
    assert_eq!(get.status().as_u16(), 200);
    let body = get.text().await.expect("get body");
    assert!(
        !body.contains(SECRET) && !body.contains(WEBHOOK),
        "GET body must NEVER contain the plaintext secret; got: {body}"
    );
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["configured"], json!(true));
    assert_eq!(v["last4"], json!("4242"), "last4 is the tail of the key");
    assert_eq!(v["webhook_configured"], json!(true));
    assert_eq!(v["connected"], json!("database"));
}

/// TEST-4 [acceptance] [invariant: INV-4]: `resolve_secret` returns the DECRYPTED DB
/// value when a storage key + ciphertext are present (DB wins). Run in-process against
/// the same per-test DB, with the test process's storage-key global initialized to the
/// same key the server used.
#[tokio::test]
async fn resolve_secret_prefers_decrypted_db_value() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    server
        .client
        .put(server.api_url("/admin/billing/integration"))
        .bearer_auth(&admin)
        .json(&json!({ "stripe_secret": SECRET }))
        .send()
        .await
        .expect("PUT secret");

    // Initialize the in-process storage key (idempotent; only this test uses it) so the
    // resolver takes the DB branch, exactly as the server subprocess does.
    ziee_framework::secrets::init_storage_key(Some(STORAGE_KEY.to_string()));
    let pool = pool_for(&server).await;
    let resolved = cytoanalyst::modules::billing::client::resolve_secret(&pool)
        .await
        .expect("resolve")
        .expect("a secret is configured");
    assert_eq!(resolved, SECRET, "resolve_secret returns the decrypted DB value");
}

/// TEST-6 [acceptance] [invariant: INV-6] — A9 deny: a caller holding `billing::manage`
/// (the default Users grant) but NOT `billing::admin` is refused 403 on GET/PUT/POST.
#[tokio::test]
async fn non_billing_admin_is_denied_403_on_all_verbs() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    // A normal user: holds billing::read/manage via the Users group, NOT billing::admin.
    create_user(&server, &admin, "manager", "manager@cyto.test").await;
    let user = login(&server, "manager").await;

    let get = server
        .client
        .get(server.api_url("/admin/billing/integration"))
        .bearer_auth(&user)
        .send()
        .await
        .expect("GET");
    assert_eq!(get.status().as_u16(), 403, "GET denied without billing::admin");

    let put = server
        .client
        .put(server.api_url("/admin/billing/integration"))
        .bearer_auth(&user)
        .json(&json!({ "stripe_secret": "sk_nope" }))
        .send()
        .await
        .expect("PUT");
    assert_eq!(put.status().as_u16(), 403, "PUT denied without billing::admin");

    let test = server
        .client
        .post(server.api_url("/admin/billing/integration/test"))
        .bearer_auth(&user)
        .json(&json!({}))
        .send()
        .await
        .expect("POST test");
    assert_eq!(test.status().as_u16(), 403, "POST denied without billing::admin");

    // Sanity: the stored secret was never written by the denied PUT.
    let pool = pool_for(&server).await;
    let ct = sqlx::query_scalar!(
        r#"SELECT stripe_secret_ciphertext FROM billing_integration WHERE singleton = true"#
    )
    .fetch_one(&pool)
    .await
    .expect("row");
    assert!(ct.is_none(), "a denied PUT must not have stored anything");
}

/// TEST-15 [covers: ITEM-5] (round-1 audit regression): a stored ciphertext that CANNOT
/// be decrypted (a wrong storage key after a rotation / corrupted bytes) must NOT 500 the
/// GET — it degrades gracefully (falls back to env; masked view shows unconfigured), so a
/// mis-rotated key never bricks the admin page.
#[tokio::test]
async fn undecryptable_ciphertext_does_not_500_the_get() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    // Inject garbage bytes directly into the ciphertext column (not produced by the
    // server's storage key) — pgp_sym_decrypt will fail on it.
    let pool = pool_for(&server).await;
    sqlx::query!(
        r#"UPDATE billing_integration SET stripe_secret_ciphertext = $1 WHERE singleton = true"#,
        &b"not-a-valid-pgp-message"[..]
    )
    .execute(&pool)
    .await
    .expect("inject bogus ciphertext");

    // The GET must return 200 (graceful), never 500, and never leak.
    let get = server
        .client
        .get(server.api_url("/admin/billing/integration"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET integration");
    assert_eq!(
        get.status().as_u16(),
        200,
        "an undecryptable stored secret must degrade gracefully, not 500"
    );
    let body = get.text().await.expect("body");
    // The injected bytes never appear in the response (no leak).
    assert!(!body.contains("not-a-valid-pgp-message"), "no leak of the stored bytes");
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    // The undecryptable ciphertext must NEVER be reported as a working DB secret — it
    // degrades to the env fallback (env-robust: `environment` when STRIPE_SECRET_KEY is
    // set, e.g. under the billing-sim recipe; `unconfigured` when it is not). Either way
    // it is never a false `"database"`.
    assert_ne!(
        v["connected"], json!("database"),
        "an undecryptable ciphertext must not be reported as a working DB secret"
    );
}

/// TEST-10 [covers: ITEM-3]: a PUT that sets only `prices` (no secret) leaves the
/// previously-stored secret ciphertext UNCHANGED (a price-only edit never wipes it).
#[tokio::test]
async fn price_only_edit_preserves_stored_secret() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    // First store a secret.
    server
        .client
        .put(server.api_url("/admin/billing/integration"))
        .bearer_auth(&admin)
        .json(&json!({ "stripe_secret": SECRET }))
        .send()
        .await
        .expect("PUT secret");
    let pool = pool_for(&server).await;
    let before = sqlx::query_scalar!(
        r#"SELECT stripe_secret_ciphertext FROM billing_integration WHERE singleton = true"#
    )
    .fetch_one(&pool)
    .await
    .expect("before")
    .expect("secret present");

    // Now a price-only edit (blank secret ⇒ leave unchanged).
    let put = server
        .client
        .put(server.api_url("/admin/billing/integration"))
        .bearer_auth(&admin)
        .json(&json!({ "stripe_secret": "", "prices": { "STRIPE_PRICE_FREE_BASE": "price_x" } }))
        .send()
        .await
        .expect("price-only PUT");
    assert_eq!(put.status().as_u16(), 200);

    let after = sqlx::query!(
        r#"SELECT stripe_secret_ciphertext, price_ids FROM billing_integration WHERE singleton = true"#
    )
    .fetch_one(&pool)
    .await
    .expect("after");
    assert_eq!(
        after.stripe_secret_ciphertext.expect("secret still present"),
        before,
        "a price-only edit must not change the stored secret ciphertext"
    );
    assert_eq!(after.price_ids["STRIPE_PRICE_FREE_BASE"], "price_x");
}
