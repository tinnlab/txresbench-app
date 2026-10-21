//! A3 TEST-7 [acceptance, INV-2] — membership ∧ RBAC composition. Access requires
//! BOTH the RBAC capability AND account membership:
//!   (a) an account MEMBER LACKING `projects::use` → 403 (the outer RBAC gate fires);
//!   (b) a NON-member HOLDING `projects::use` → 404 (the mid membership rung);
//!   (c) a member holding the capability in the right account → passes.
//! A right-role-wrong-account and a right-account-wrong-role are each denied.

use serde_json::{json, Value};

use super::{
    add_member, create_user, create_user_without_projects, login, make_org_account,
    move_project_to_account, pool_for, setup_admin,
};
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

async fn get_status(server: &TestServer, token: &str, pid: &str) -> u16 {
    server
        .client
        .get(server.api_url(&format!("/projects/{pid}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn membership_and_rbac_both_must_pass() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // alice owns a project living in an ORG account.
    let alice_id = create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let p = create_project_http(&server, &alice, "atlas").await;
    let pid = p["id"].as_str().unwrap().to_string();
    let pool = pool_for(&server).await;
    let org = make_org_account(&pool, "Lab", alice_id).await;
    move_project_to_account(&pool, pid.parse().unwrap(), org).await;

    // (a) an account MEMBER who LACKS `projects::use` (stripped from Users) → 403.
    //     The outer RBAC extractor fires BEFORE the membership rung is even resolved.
    let nocap_id = create_user_without_projects(&server, &admin, "nocap", "nocap@x.test").await;
    add_member(&pool, org, nocap_id, "member").await;
    let nocap = login(&server, "nocap").await;
    assert_eq!(
        get_status(&server, &nocap, &pid).await,
        403,
        "member lacking projects::use → 403 (RBAC gate), NOT 404"
    );

    // (b) a NON-member who HOLDS `projects::use` (default Users member) → 404.
    create_user(&server, &admin, "haspermnonmember", "hp@x.test").await;
    let nonmember = login(&server, "haspermnonmember").await;
    assert_eq!(
        get_status(&server, &nonmember, &pid).await,
        404,
        "non-member holding the capability → 404 (membership rung), NOT 200/403"
    );

    // (c) a MEMBER who HOLDS the capability, in the right account → passes.
    let member_id = create_user(&server, &admin, "goodmember", "gm@x.test").await;
    add_member(&pool, org, member_id, "member").await;
    let member = login(&server, "goodmember").await;
    assert_eq!(
        get_status(&server, &member, &pid).await,
        200,
        "member + capability + right account → passes (both gates satisfied)"
    );
}
