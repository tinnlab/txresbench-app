//! TEST-11 — compute config PUT → masked GET (namespace/image + token_last4 +
//! kubeconfig_configured, no secret field).

use serde_json::json;

use crate::account::setup_admin;
use crate::common::TestServer;
use crate::infra::encrypted_opts;

const KUBECONFIG: &str = "apiVersion: v1\nkind: Config\nclusters: []\n";
const TOKEN: &str = "cluster-bearer-token-abcd6789"; // last4 = 6789

/// TEST-11 [covers: ITEM-7]: PUT the compute config, then GET returns the masked view with
/// the new namespace/worker-image + `token_last4` + `kubeconfig_configured` and NO secret.
#[tokio::test]
async fn put_then_get_is_masked() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    // #61 coupling guard: remote (kubernetes) compute REQUIRES a remote object store, so
    // configure a cloud (s3) store FIRST — else the compute PUT below is (correctly) refused
    // 422 INCOMPATIBLE_BACKENDS. This is the valid remote+cloud pairing.
    let store = server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "s3", "provider": "s3", "bucket": "cyto-worklab", "region": "us-east-1" }))
        .send()
        .await
        .expect("PUT object-store");
    assert_eq!(store.status().as_u16(), 200, "cloud store PUT should succeed");

    let put = server
        .client
        .put(server.api_url("/admin/infra/compute"))
        .bearer_auth(&admin)
        .json(&json!({
            "backend": "kubernetes",
            "cluster_endpoint": "https://api.my-cluster:6443",
            "namespace": "cyto-jobs",
            "worker_image": "cytoanalyst-worker:v2",
            "kubeconfig": KUBECONFIG,
            "token": TOKEN,
        }))
        .send()
        .await
        .expect("PUT compute");
    assert_eq!(put.status().as_u16(), 200, "PUT should succeed");
    let put_body = put.text().await.expect("put body");
    assert!(
        !put_body.contains(KUBECONFIG) && !put_body.contains(TOKEN),
        "PUT response must not echo the plaintext credentials"
    );

    let get = server
        .client
        .get(server.api_url("/admin/infra/compute"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET compute");
    assert_eq!(get.status().as_u16(), 200);
    let body = get.text().await.expect("get body");
    assert!(
        !body.contains(KUBECONFIG) && !body.contains(TOKEN),
        "GET body must NEVER contain the plaintext credentials; got: {body}"
    );
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["backend"], json!("kubernetes"));
    assert_eq!(v["namespace"], json!("cyto-jobs"));
    assert_eq!(v["worker_image"], json!("cytoanalyst-worker:v2"));
    assert_eq!(v["cluster_endpoint"], json!("https://api.my-cluster:6443"));
    assert_eq!(v["token_last4"], json!("6789"), "last4 is the tail of the token");
    assert_eq!(v["kubeconfig_configured"], json!(true));
    assert_eq!(v["status"], json!("database"));
    assert!(v.get("kubeconfig").is_none());
    assert!(v.get("token").is_none());
}
