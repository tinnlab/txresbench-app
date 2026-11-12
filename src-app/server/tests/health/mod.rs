//! Health liveness surface (adopted `txresbench-health`) — the DB-free `GET /health`
//! must answer 200 `{ "status": "ok" }` WITHOUT authentication.

use serde_json::Value;

use crate::common::TestServer;

#[tokio::test]
async fn health_endpoint_returns_ok_without_auth() {
    let server = TestServer::spawn().await;

    // No bearer token — the liveness probe is unauthenticated.
    let resp = server
        .client
        .get(server.api_url("/health"))
        .send()
        .await
        .expect("GET /health");
    assert_eq!(resp.status().as_u16(), 200, "health is reachable + 200");

    let body: Value = resp.json().await.expect("health json");
    assert_eq!(body["status"], "ok");
}
