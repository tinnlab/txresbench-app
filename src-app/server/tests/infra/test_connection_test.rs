//! TEST-15 [acceptance INV-4] — a BAD credential on either test-connection endpoint is a
//! clean 200 `{ok:false}` (NEVER a 500), and the message contains none of the supplied
//! secret bytes.

use serde_json::json;

use crate::account::setup_admin;
use crate::common::TestServer;
use crate::infra::encrypted_opts;

const BAD_SECRET: &str = "TOPSECRET-should-never-appear-in-a-message";

/// A valid-YAML kubeconfig pointing at an unreachable API server, carrying a secret token
/// that must never surface in the classifier message.
const BAD_KUBECONFIG: &str = "apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://127.0.0.1:1
contexts:
- name: ctx
  context:
    cluster: c
    user: u
current-context: ctx
users:
- name: u
  user:
    token: TOPSECRET-should-never-appear-in-a-message
";

/// TEST-15 [acceptance] [invariant: INV-4] [covers: ITEM-4, ITEM-8]: object-store AND
/// compute test-connection with a bad/unreachable credential return 200 `{ok:false}`
/// (never 500), and the message never contains the supplied secret.
#[tokio::test]
async fn bad_credential_is_clean_ok_false_never_leaks() {
    let server = TestServer::spawn_with(encrypted_opts()).await;
    let admin = setup_admin(&server).await;

    // ── object store: an unreachable endpoint + a candidate secret ──
    server
        .client
        .put(server.api_url("/admin/infra/object-store"))
        .bearer_auth(&admin)
        .json(&json!({
            "backend": "s3",
            "provider": "s3",
            "endpoint": "http://127.0.0.1:1",
            "bucket": "cyto-worklab",
            "region": "us-east-1",
            "path_style": true,
        }))
        .send()
        .await
        .expect("PUT object-store");
    let resp = server
        .client
        .post(server.api_url("/admin/infra/object-store/test"))
        .bearer_auth(&admin)
        .json(&json!({ "access_key_id": "AKIA_bad", "secret_access_key": BAD_SECRET }))
        .send()
        .await
        .expect("POST object-store test");
    assert_eq!(resp.status().as_u16(), 200, "a bad cred is a clean 200, not a 500");
    let body = resp.text().await.expect("body");
    assert!(!body.contains(BAD_SECRET), "object-store test message leaked the secret: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["ok"], json!(false), "an unreachable store fails cleanly");

    // ── compute: a valid-YAML but unreachable kubeconfig carrying a secret token ──
    server
        .client
        .put(server.api_url("/admin/infra/compute"))
        .bearer_auth(&admin)
        .json(&json!({ "backend": "kubernetes" }))
        .send()
        .await
        .expect("PUT compute backend");
    let resp = server
        .client
        .post(server.api_url("/admin/infra/compute/test"))
        .bearer_auth(&admin)
        .json(&json!({ "kubeconfig": BAD_KUBECONFIG }))
        .send()
        .await
        .expect("POST compute test");
    assert_eq!(resp.status().as_u16(), 200, "a bad kubeconfig is a clean 200, not a 500");
    let body = resp.text().await.expect("body");
    assert!(!body.contains(BAD_SECRET), "compute test message leaked the token: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).expect("json");
    assert_eq!(v["ok"], json!(false), "an unreachable cluster fails cleanly");
}
