//! Admin user-list read projection (#43). Drives the REAL spawned server + per-test DB.

use serde_json::{json, Value};

use crate::account::{create_user, login, pool_for, setup_admin};
use crate::common::TestServer;

/// `GET /api/users` with an optional bearer → the raw response.
async fn list_users(server: &TestServer, token: Option<&str>) -> reqwest::Response {
    let mut req = server.client.get(server.api_url("/users"));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("GET /users")
}

/// Locate a user row by username in the `users` array.
fn find_user<'a>(body: &'a Value, username: &str) -> &'a Value {
    body["users"]
        .as_array()
        .expect("users is an array")
        .iter()
        .find(|u| u["username"] == username)
        .unwrap_or_else(|| panic!("user {username} present in the list"))
}

/// The personal account id of `user_id` (fails if none) — the expected value.
async fn personal_acct(pool: &sqlx::PgPool, user_id: uuid::Uuid) -> uuid::Uuid {
    sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal account exists")
}

/// Create a user in a fresh group holding EXACTLY `permissions` (no `is_admin`, no `*`), then log
/// them in. Mirrors `billing::helpers::create_billing_admin_holder`, generalized to any perm set —
/// lets us mint a `users::read`-only caller (the no-billing-leak control).
async fn create_group_holder(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
    permissions: &[&str],
) -> String {
    let id = create_user(server, admin, username, email).await;
    let group = server
        .client
        .post(server.api_url("/groups"))
        .bearer_auth(admin)
        .json(&json!({
            "name": format!("grp-{username}"),
            "description": "",
            "permissions": permissions,
        }))
        .send()
        .await
        .expect("create group");
    assert_eq!(group.status().as_u16(), 201, "create group");
    let group_id = group.json::<Value>().await.expect("group json")["id"]
        .as_str()
        .expect("group id")
        .to_string();
    let assign = server
        .client
        .post(server.api_url("/groups/assign"))
        .bearer_auth(admin)
        .json(&json!({ "user_id": id, "group_id": group_id }))
        .send()
        .await
        .expect("assign group");
    assert!(assign.status().is_success(), "assign group");
    login(server, username).await
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-6 [covers: ITEM-2, ITEM-5] — an is_admin `GET /api/users` returns each row with a
// `personal_account_id` (present for a user WITH a personal account, `null` for one WITHOUT), and a
// caller lacking `users::read` gets 403 (A9 endpoint gate). Non-saas leg — runs in BOTH builds.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn user_list_reports_personal_account_id_and_gates_non_reader() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Alice keeps her hook-provisioned personal account.
    let alice_id = create_user(&server, &admin, "ul_alice", "ul_alice@x.test").await;
    // Bob: delete his personal account to simulate a legacy user without one (the `None` branch).
    let _bob_id = create_user(&server, &admin, "ul_bob", "ul_bob@x.test").await;
    sqlx::query(
        "DELETE FROM accounts WHERE kind='personal'
           AND personal_user_id=(SELECT id FROM users WHERE username='ul_bob')",
    )
    .execute(&pool)
    .await
    .expect("drop bob's personal account");

    let resp = list_users(&server, Some(&admin)).await;
    assert_eq!(resp.status().as_u16(), 200, "admin lists users → 200");
    let body: Value = resp.json().await.expect("users json");

    let alice = find_user(&body, "ul_alice");
    let expected = personal_acct(&pool, alice_id).await.to_string();
    assert_eq!(
        alice["personal_account_id"].as_str(),
        Some(expected.as_str()),
        "alice's personal_account_id is resolved + correct"
    );

    let bob = find_user(&body, "ul_bob");
    assert!(
        bob["personal_account_id"].is_null(),
        "bob (no personal account) → null, got {}",
        bob["personal_account_id"]
    );

    // A9 — a plain user does NOT hold `users::read` (admin-only, not group-granted) → 403.
    let _c = create_user(&server, &admin, "ul_carol", "ul_carol@x.test").await;
    let carol = login(&server, "ul_carol").await;
    assert_eq!(
        list_users(&server, Some(&carol)).await.status().as_u16(),
        403,
        "a non-users::read caller is 403 on GET /users"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-7 [acceptance][invariant: INV-1] [covers: ITEM-2, ITEM-5] — the saas `billing` sub-object is
// visible ONLY to a `is_admin || billing::admin` caller: an is_admin lister sees it POPULATED for a
// user whose personal account has seeded state; a `users::read`-ONLY lister (NOT billing::admin, NOT
// is_admin) sees `billing: null` for EVERY row — the read does not widen the premium/credit audience
// beyond what the design gates. saas-only.
// ─────────────────────────────────────────────────────────────────────────────────
#[cfg(feature = "saas")]
#[tokio::test]
async fn user_list_billing_visible_only_to_billing_admin() {
    use crate::billing::helpers::{grant_credit, put_premium};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Dave's personal account gets a premium override + a 400¢ active grant.
    let dave_id = create_user(&server, &admin, "ulb_dave", "ulb_dave@x.test").await;
    let acct = personal_acct(&pool, dave_id).await.to_string();
    assert_eq!(
        put_premium(&server, Some(&admin), &acct, true, None)
            .await
            .status()
            .as_u16(),
        200,
        "seed premium"
    );
    assert_eq!(
        grant_credit(&server, Some(&admin), &acct, 400, "comp", None)
            .await
            .status()
            .as_u16(),
        200,
        "seed grant"
    );

    // (a) is_admin lister → billing POPULATED for dave's row.
    let body: Value = list_users(&server, Some(&admin))
        .await
        .json()
        .await
        .expect("json");
    let dave = find_user(&body, "ulb_dave");
    assert_eq!(
        dave["billing"]["premium"].as_bool(),
        Some(true),
        "admin sees dave's premium override"
    );
    assert_eq!(
        dave["billing"]["credit_balance_cents"].as_i64(),
        Some(400),
        "admin sees dave's credit balance"
    );
    assert!(
        dave["billing"]["plan_id"].is_string(),
        "admin sees dave's plan_id"
    );

    // (b) no-leak control: a users::read-ONLY caller (no billing::admin, no is_admin) sees
    // `billing: null` for EVERY row — including dave's, whose state IS set.
    let reader = create_group_holder(
        &server,
        &admin,
        "ulb_reader",
        "ulb_reader@x.test",
        &["users::read"],
    )
    .await;
    let body2: Value = list_users(&server, Some(&reader))
        .await
        .json()
        .await
        .expect("json");
    let rows = body2["users"].as_array().expect("users array");
    assert!(!rows.is_empty(), "the reader can list users");
    for u in rows {
        assert!(
            u["billing"].is_null(),
            "a non-billing-admin must see billing=null for every row (no info-leak), got {} for {}",
            u["billing"],
            u["username"]
        );
    }
    // And dave's row specifically is null for this caller even though his state is set.
    assert!(
        find_user(&body2, "ulb_dave")["billing"].is_null(),
        "dave's seeded billing is hidden from a non-billing-admin lister"
    );
}
