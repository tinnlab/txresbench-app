//! A4 TEST-2 — the account read REST surface (`GET /api/accounts` +
//! `GET /api/accounts/{id}/members`): owner-filtering, the 401/403 gate, and the
//! non-member 404 on the members endpoint.

use serde_json::Value;

use crate::account::{
    add_member, create_user, create_user_without_projects, login, make_org_account, pool_for,
    setup_admin,
};
use crate::common::TestServer;

#[tokio::test]
async fn list_accounts_is_owner_filtered_and_gated() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let alice_id = create_user(&server, &admin, "acc_alice", "acc_alice@cyto.test").await;
    let alice = login(&server, "acc_alice").await;
    let pool = pool_for(&server).await;

    // An org account alice is NOT a member of (owned by a different user).
    let bob_id = create_user(&server, &admin, "acc_bob", "acc_bob@cyto.test").await;
    let foreign_org = make_org_account(&pool, "bobs-org", bob_id).await;

    // GET /api/accounts as alice → exactly her memberships (her personal account),
    // and NOT the foreign org (owner-filtered — no cross-account leak).
    let resp = server
        .client
        .get(server.api_url("/accounts"))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("list accounts");
    assert_eq!(resp.status().as_u16(), 200, "list accounts 200");
    let body: Value = resp.json().await.expect("accounts json");
    let accounts = body["accounts"].as_array().expect("accounts array");
    assert!(
        accounts.iter().any(|a| a["kind"] == "personal"),
        "alice sees her personal account"
    );
    assert!(
        !accounts.iter().any(|a| a["id"] == foreign_org.to_string()),
        "alice must NOT see an account she is not a member of"
    );
    let before = accounts.len();

    // Add alice to the org → it now appears.
    add_member(&pool, foreign_org, alice_id, "member").await;
    let resp = server
        .client
        .get(server.api_url("/accounts"))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("list accounts 2");
    let body: Value = resp.json().await.expect("accounts json 2");
    let accounts = body["accounts"].as_array().expect("accounts array 2");
    assert_eq!(accounts.len(), before + 1, "the org is now a membership");
    assert!(accounts.iter().any(|a| a["id"] == foreign_org.to_string()));

    // 401 unauth.
    let un = server
        .client
        .get(server.api_url("/accounts"))
        .send()
        .await
        .expect("unauth");
    assert_eq!(un.status().as_u16(), 401, "unauth → 401");

    // 403 for a user lacking `account::read` (stripped from the Users group, which
    // grants it).
    create_user_without_projects(&server, &admin, "acc_norg", "acc_norg@cyto.test").await;
    let norg = login(&server, "acc_norg").await;
    let deny = server
        .client
        .get(server.api_url("/accounts"))
        .bearer_auth(&norg)
        .send()
        .await
        .expect("deny");
    assert_eq!(deny.status().as_u16(), 403, "no account::read → 403");
}

#[tokio::test]
async fn list_members_gated_by_membership_404s_non_member() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let owner_id = create_user(&server, &admin, "mem_owner", "mem_owner@cyto.test").await;
    let owner = login(&server, "mem_owner").await;
    let pool = pool_for(&server).await;
    let org = make_org_account(&pool, "members-org", owner_id).await;

    // A member (the owner) can page the members list.
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{org}/members")))
        .bearer_auth(&owner)
        .send()
        .await
        .expect("members");
    assert_eq!(resp.status().as_u16(), 200, "member lists members");
    let body: Value = resp.json().await.expect("members json");
    assert_eq!(body["total"].as_i64().unwrap(), 1, "one member (the owner)");
    let members = body["members"].as_array().unwrap();
    assert_eq!(members.len(), 1);
    // TEST-3 [covers ITEM-3] (#51): the paged members list (the personal
    // /settings/accounts data path) carries each member's human identity —
    // username/email (NOT NULL) present, so the UI renders a person, not a UUID.
    let m = &members[0];
    assert_eq!(m["user_id"].as_str().unwrap(), owner_id.to_string());
    assert_eq!(m["username"], "mem_owner", "member row carries username");
    assert_eq!(m["email"], "mem_owner@cyto.test", "member row carries email");
    assert!(m.get("display_name").is_some(), "display_name key present (null when unset)");

    // A NON-member's request to the same org → 404 (existence oracle — never 403,
    // never member data).
    create_user(&server, &admin, "mem_stranger", "mem_stranger@cyto.test").await;
    let stranger = login(&server, "mem_stranger").await;
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{org}/members")))
        .bearer_auth(&stranger)
        .send()
        .await
        .expect("stranger members");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a non-member gets 404, byte-identical to a nonexistent account"
    );
}
