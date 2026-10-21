//! TEST-13 [acceptance INV-2] + TEST-14 [acceptance INV-3] — the masked GET never carries
//! a plaintext secret (both surfaces), and the emitted `access_key_last4` is exactly the
//! tail of the stored key (the SecretView boundary emits only last4).

use serde_json::json;

use crate::account::setup_admin;
use crate::common::TestServer;
use crate::infra::encrypted_opts;

const ACCESS_KEY: &str = "AKIA_SECRET_ACCESS_KEY_9999XYZW"; // last4 = XYZW
const SECRET_KEY: &str = "super/secret+object+store+key+shh";
const KUBECONFIG: &str = "apiVersion: v1\nkind: Config\nusers:\n- name: u\n  user:\n    token: SECRETKUBETOKEN\n";
const TOKEN: &str = "cluster-token-plaintext-NEVERSHOWN";

/// TEST-13 [acceptance] [invariant: INV-2] [covers: ITEM-3, ITEM-7]: after storing real
/// secrets on BOTH surfaces, neither GET body contains any plaintext secret literal.
#[tokio::test]
async fn masked_get_never_contains_plaintext_secret() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        // #61 coupling guard: a cloud (s3) store makes the remote (kubernetes) compute PUT
        // below a VALID pair; without it the compute PUT is (correctly) refused 422.
        .json(&json!({ "backend": "s3", "provider": "s3", "bucket": "cyto-worklab", "region": "us-east-1", "access_key_id": ACCESS_KEY, "secret_access_key": SECRET_KEY }))
        .send()
        .await
        .expect("PUT object-store creds");
    server
        .client
        .put(server.api_url("/admin/infra/compute"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "kubernetes", "kubeconfig": KUBECONFIG, "token": TOKEN }))
        .send()
        .await
        .expect("PUT compute creds");

    for path in ["/admin/infra/object-store", "/admin/infra/compute"] {
        let body = server
            .client
            .get(server.api_url(path))
            .bearer_auth(&admin)
            .send()
            .await
            .expect("GET")
            .text()
            .await
            .expect("body");
        for secret in [ACCESS_KEY, SECRET_KEY, KUBECONFIG, TOKEN, "SECRETKUBETOKEN"] {
            assert!(
                !body.contains(secret),
                "GET {path} leaked a plaintext secret ({secret:?}); body: {body}"
            );
        }
    }
}

/// TEST-14 [acceptance] [invariant: INV-3] [covers: ITEM-3]: the masked GET emits an
/// `access_key_last4` equal to the LAST 4 chars of the stored access key and nothing
/// longer — proving the plaintext is resolved-then-masked via the SecretView boundary,
/// never returned.
#[tokio::test]
async fn masked_last4_is_the_tail_only() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;
    server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "access_key_id": ACCESS_KEY }))
        .send()
        .await
        .expect("PUT access key");

    let v: serde_json::Value = server
        .client
        .get(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET")
        .json()
        .await
        .expect("json");
    let last4 = v["access_key_last4"].as_str().expect("last4 present");
    assert_eq!(last4, "XYZW", "last4 must be exactly the tail of the key");
    assert!(last4.len() <= 4, "last4 must never be longer than 4 chars");
    assert!(ACCESS_KEY.ends_with(last4), "last4 is the tail of the stored key");
}
