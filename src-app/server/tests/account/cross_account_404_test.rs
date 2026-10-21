//! A3 TEST-6 [acceptance, INV-1] — THE cross-account-404 proof. A user requesting
//! another account's project (or dataset) by id gets a response BYTE-IDENTICAL to a
//! genuinely-nonexistent id: same status (404), same body — never 403, never the row
//! (the existence-oracle guard, AC-INV-3). Driven through the real HTTP surface.

use serde_json::{json, Value};

use super::{create_user, login, make_org_account, move_project_to_account, pool_for, setup_admin};
use crate::common::TestServer;

async fn create_project_http(server: &TestServer, token: &str, name: &str) -> Value {
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(resp.status().as_u16(), 201, "create project {name}");
    resp.json().await.expect("project json")
}

#[tokio::test]
async fn cross_account_project_is_byte_identical_to_nonexistent_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice_id = create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let carol_id = create_user(&server, &admin, "carol", "carol@x.test").await;
    let carol = login(&server, "carol").await;
    let pool = pool_for(&server).await;

    // A project alice owns in an ORG account carol is NOT a member of.
    let p = create_project_http(&server, &alice, "atlas").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let org = make_org_account(&pool, "Lab", alice_id).await;
    move_project_to_account(&pool, pid.parse().unwrap(), org).await;
    // (sanity: carol holds projects::use via the Users group; it is membership, not
    // capability, that denies her — proven separately in rbac_composition_test.)
    let _ = carol_id;

    // A genuinely-nonexistent random id.
    let ghost = uuid::Uuid::new_v4().to_string();

    // GET: cross-account and nonexistent are byte-identical.
    let cross = server
        .client
        .get(server.api_url(&format!("/projects/{pid}")))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap();
    let ghost_resp = server
        .client
        .get(server.api_url(&format!("/projects/{ghost}")))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap();
    assert_eq!(
        cross.status().as_u16(),
        404,
        "cross-account GET → 404, never 403"
    );
    assert_eq!(ghost_resp.status().as_u16(), 404, "nonexistent GET → 404");
    let cross_body = cross.text().await.unwrap();
    let ghost_body = ghost_resp.text().await.unwrap();
    assert_eq!(
        cross_body, ghost_body,
        "cross-account 404 body must be BYTE-IDENTICAL to a nonexistent id (no existence oracle)"
    );

    // PUT (update) + DELETE: same 404, never the row / 403.
    let put = server
        .client
        .post(server.api_url(&format!("/projects/{pid}")))
        .bearer_auth(&carol)
        .json(&json!({ "name": "hijack" }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        put.status().as_u16(),
        404,
        "cross-account PUT → 404, never 403/200"
    );
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{pid}")))
        .bearer_auth(&carol)
        .send()
        .await
        .unwrap();
    assert_eq!(
        del.status().as_u16(),
        404,
        "cross-account DELETE → 404, never 403/204"
    );

    // The owner still reaches it (the guard denies cross-account, not the resource).
    let owner_get = server
        .client
        .get(server.api_url(&format!("/projects/{pid}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(
        owner_get.status().as_u16(),
        200,
        "the account member still reaches it"
    );
    assert_eq!(
        owner_get.json::<Value>().await.unwrap()["owner_id"],
        json!(alice_id)
    );
}
