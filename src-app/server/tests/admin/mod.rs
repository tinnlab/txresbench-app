//! Admin module (#31/#32) integration tests — the cross-account admin surface, driven
//! through a real spawned server + real Postgres (per-test DB). These are the
//! executable ACCEPTANCE contracts for the four security invariants (INV-1..INV-4)
//! and the seam Tier-1 (#33/#34/#35/#36) builds on.
//!
//! Reuses the `tests/account` helpers (setup_admin / create_user / login /
//! make_org_account / pool_for) — the account tenancy fixtures this surface acts over.

use serde_json::{json, Value};

use crate::account::{create_user, login};
use crate::common::TestServer;

mod admin_account_scope_test;
mod admin_gating_test;
mod admin_route_authn_test;
mod admin_suspend_test;
mod list_all_accounts_test;
mod member_crud_test;
mod no_info_leak_test;
mod self_serve_unchanged_test;

// -------- Tier-1 (#33/#34/#35) request helpers --------

/// `GET /api/admin/accounts{query}` (e.g. `""` or `"?kind=organization&page=2"`).
pub async fn admin_list_accounts(
    server: &TestServer,
    token: Option<&str>,
    query: &str,
) -> (u16, Value) {
    let mut req = server
        .client
        .get(server.api_url(&format!("/admin/accounts{query}")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("admin list accounts");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// `POST /api/admin/accounts/{account_id}/members` — add `user_id` with `role`.
pub async fn admin_add_member(
    server: &TestServer,
    token: Option<&str>,
    account_id: &str,
    user_id: uuid::Uuid,
    role: &str,
) -> (u16, Value) {
    let mut req = server
        .client
        .post(server.api_url(&format!("/admin/accounts/{account_id}/members")))
        .json(&json!({ "user_id": user_id, "role": role }));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("admin add member");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// `DELETE /api/admin/accounts/{account_id}/members/{user_id}` → status code.
pub async fn admin_remove_member(
    server: &TestServer,
    token: Option<&str>,
    account_id: &str,
    user_id: uuid::Uuid,
) -> u16 {
    let mut req = server
        .client
        .delete(server.api_url(&format!("/admin/accounts/{account_id}/members/{user_id}")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send()
        .await
        .expect("admin remove member")
        .status()
        .as_u16()
}

/// `PATCH /api/admin/accounts/{account_id}/members/{user_id}` — set `role`.
pub async fn admin_set_role(
    server: &TestServer,
    token: Option<&str>,
    account_id: &str,
    user_id: uuid::Uuid,
    role: &str,
) -> (u16, Value) {
    let mut req = server
        .client
        .patch(server.api_url(&format!("/admin/accounts/{account_id}/members/{user_id}")))
        .json(&json!({ "role": role }));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("admin set role");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// Create a NON-admin user who holds `admin::accounts` via a dedicated group (NOT the
/// Users group — so the perm is isolated to this user and does not leak to the other
/// test users). Returns their access token. This is the "grant-holder" half of INV-2:
/// cross-account admin reachable by the grant, not only by `is_admin`.
pub async fn create_admin_accounts_holder(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = create_user(server, admin, username, email).await;

    let group = server
        .client
        .post(server.api_url("/groups"))
        .bearer_auth(admin)
        .json(&json!({
            "name": format!("admin-accounts-{username}"),
            "description": "",
            "permissions": ["admin::accounts"],
        }))
        .send()
        .await
        .expect("create admin-accounts group");
    assert_eq!(group.status().as_u16(), 201, "create admin-accounts group");
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
        .expect("assign admin-accounts group");
    assert!(
        assign.status().is_success(),
        "assign admin-accounts group: {}",
        assign.status()
    );

    login(server, username).await
}

/// `POST /api/admin/accounts/{account_id}/suspend` with an optional bearer + optional reason.
pub async fn admin_suspend(
    server: &TestServer,
    token: Option<&str>,
    account_id: &str,
    reason: Option<&str>,
) -> (u16, Value) {
    let body = match reason {
        Some(r) => json!({ "reason": r }),
        None => json!({}),
    };
    let mut req = server
        .client
        .post(server.api_url(&format!("/admin/accounts/{account_id}/suspend")))
        .json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("admin suspend");
    let status = resp.status().as_u16();
    let b: Value = resp.json().await.unwrap_or(Value::Null);
    (status, b)
}

/// `POST /api/admin/accounts/{account_id}/reactivate` with an optional bearer.
pub async fn admin_reactivate(
    server: &TestServer,
    token: Option<&str>,
    account_id: &str,
) -> (u16, Value) {
    let mut req = server
        .client
        .post(server.api_url(&format!("/admin/accounts/{account_id}/reactivate")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("admin reactivate");
    let status = resp.status().as_u16();
    let b: Value = resp.json().await.unwrap_or(Value::Null);
    (status, b)
}

/// `GET /api/admin/accounts/{account_id}/status` with an optional bearer.
pub async fn admin_account_status(
    server: &TestServer,
    token: Option<&str>,
    account_id: &str,
) -> (u16, Value) {
    let mut req = server
        .client
        .get(server.api_url(&format!("/admin/accounts/{account_id}/status")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("admin status");
    let status = resp.status().as_u16();
    let b: Value = resp.json().await.unwrap_or(Value::Null);
    (status, b)
}

/// GET `/api/admin/accounts/{account_id}` with an optional bearer → (status, body).
pub async fn admin_get_account(
    server: &TestServer,
    token: Option<&str>,
    account_id: &str,
) -> (u16, String) {
    let mut req = server
        .client
        .get(server.api_url(&format!("/admin/accounts/{account_id}")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("admin get account");
    let status = resp.status().as_u16();
    let body = resp.text().await.expect("admin get body");
    (status, body)
}
