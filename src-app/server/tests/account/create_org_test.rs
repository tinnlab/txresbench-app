//! TEST-2 [acceptance, INV-2] — `POST /api/accounts` (#34) creates an ORGANIZATION
//! account + its owner membership in ONE transaction.
//!
//! An admin (holds `account::manage` via `*`) creates an org; the caller (or a
//! supplied `owner_id`) becomes its `owner` member and can then act on it. A phantom
//! owner → 404 and leaves NO orphan account row (atomicity). A user lacking
//! `account::manage` → 403; unauthenticated → 401; an empty name → 400.

use serde_json::{json, Value};

use crate::account::{create_user, login, pool_for, post_accounts, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn admin_creates_org_with_owner_membership_atomically() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // --- INV-2: create an org (name trimmed) → 201, admin is the owner member.
    let (status, body) = post_accounts(&server, Some(&admin), json!({ "name": "  Acme  " })).await;
    assert_eq!(status, 201, "create org: {body}");
    assert_eq!(body["kind"], "organization");
    assert_eq!(body["name"], "Acme", "the name is trimmed");
    assert!(
        body["personal_user_id"].is_null(),
        "an org has no personal user"
    );
    let org_id: uuid::Uuid = body["id"].as_str().unwrap().parse().unwrap();

    let members: Vec<(uuid::Uuid, String)> =
        sqlx::query_as("SELECT user_id, role FROM account_members WHERE account_id = $1")
            .bind(org_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(members.len(), 1, "exactly one member — the owner");
    assert_eq!(members[0].1, "owner");
    // The admin caller (who set up the server) is that owner.
    let admin_uid: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(members[0].0, admin_uid, "the creator is the owner");

    // --- a supplied owner_id: an admin creates an org owned by alice.
    let alice_id = create_user(&server, &admin, "co_alice", "co_alice@x.test").await;
    let (status, body) = post_accounts(
        &server,
        Some(&admin),
        json!({ "name": "Alice Org", "owner_id": alice_id }),
    )
    .await;
    assert_eq!(status, 201, "create org for a named owner: {body}");
    let alice_org: uuid::Uuid = body["id"].as_str().unwrap().parse().unwrap();
    let owner: (uuid::Uuid, String) =
        sqlx::query_as("SELECT user_id, role FROM account_members WHERE account_id = $1")
            .bind(alice_org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, (alice_id, "owner".to_string()), "alice is the owner");

    // …and alice (now a member) can act on it — it shows in her account switcher list.
    let alice = login(&server, "co_alice").await;
    let resp = server
        .client
        .get(server.api_url("/accounts"))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("alice lists accounts");
    let list: Value = resp.json().await.unwrap();
    assert!(
        list["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == alice_org.to_string()),
        "the creator-designated owner can then act on the org"
    );

    // --- atomicity: a phantom owner_id → 404 AND leaves NO orphan account row.
    let (status, _) = post_accounts(
        &server,
        Some(&admin),
        json!({ "name": "Phantom Org", "owner_id": uuid::Uuid::new_v4() }),
    )
    .await;
    assert_eq!(status, 404, "an unknown owner is 404");
    let orphans: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM accounts WHERE name = 'Phantom Org'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(orphans, 0, "a failed create rolls back — no orphan account");

    // --- an empty / whitespace name → 400 (validated before any DB write).
    let (status, _) = post_accounts(&server, Some(&admin), json!({ "name": "   " })).await;
    assert_eq!(status, 400, "an empty name is 400");

    // --- a user lacking account::manage → 403; unauthenticated → 401.
    create_user(&server, &admin, "co_bob", "co_bob@x.test").await;
    let bob = login(&server, "co_bob").await;
    let (status, _) = post_accounts(&server, Some(&bob), json!({ "name": "Bob Org" })).await;
    assert_eq!(status, 403, "a non-manager cannot create an org");
    let (status, _) = post_accounts(&server, None, json!({ "name": "Nope" })).await;
    assert_eq!(status, 401, "unauthenticated is 401");
}
