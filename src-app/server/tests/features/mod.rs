//! Features module (#40) integration tests — the runtime feature-flags subsystem,
//! driven through a real spawned server + real Postgres (per-test DB). These are the
//! executable ACCEPTANCE contracts for the five invariants (INV-1..INV-5): the
//! 3-layer resolution of `is_feature_enabled`, the admin GET/PUT gating, the
//! global/per-account independence, and the unique-constraint dedup.
//!
//! Reuses the `tests/account` helpers (setup_admin / create_user / login / pool_for).

use serde_json::{json, Value};

use crate::account::{create_user, login};
use crate::common::TestServer;

mod delete_test;
mod features_authz_test;
mod features_put_test;
mod independence_test;
mod no_row_default_test;
mod resolution_precedence_test;
mod unique_constraint_test;

/// The demonstration flag shipped in the compiled registry (default OFF).
pub const DEMO_FLAG: &str = "demo.runtime_flag";

/// `GET /api/admin/features[?account_id=]` with an optional bearer → (status, body).
pub async fn features_get(
    server: &TestServer,
    token: Option<&str>,
    account_id: Option<&str>,
) -> (u16, Value) {
    let path = match account_id {
        Some(a) => format!("/admin/features?account_id={a}"),
        None => "/admin/features".to_string(),
    };
    let mut req = server.client.get(server.api_url(&path));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("features get");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// `PUT /api/admin/features/{flag_key}` with an optional bearer + body → (status, body).
pub async fn features_put(
    server: &TestServer,
    token: Option<&str>,
    flag_key: &str,
    body: Value,
) -> (u16, Value) {
    let mut req = server
        .client
        .put(server.api_url(&format!("/admin/features/{flag_key}")))
        .json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("features put");
    let status = resp.status().as_u16();
    let out: Value = resp.json().await.unwrap_or(Value::Null);
    (status, out)
}

/// Create a plain (non-admin) user and log them in. They are auto-joined to the Users
/// group, which does NOT hold `features::manage`, so they are the "lacks the perm"
/// subject for the deny-path tests.
pub async fn create_plain_user(server: &TestServer, admin: &str, username: &str) -> String {
    let email = format!("{username}@txresbench.test");
    let _id = create_user(server, admin, username, &email).await;
    login(server, username).await
}

/// `DELETE /api/admin/features/{flag_key}/account/{account_id}` with an optional bearer →
/// (status, body). The account is a PATH segment (DEC-2); `account_id = None` drives a
/// DELETE against the base `/admin/features/{flag_key}` (which has no DELETE handler → 405).
pub async fn features_delete(
    server: &TestServer,
    token: Option<&str>,
    flag_key: &str,
    account_id: Option<&str>,
) -> (u16, Value) {
    let path = match account_id {
        Some(a) => format!("/admin/features/{flag_key}/account/{a}"),
        None => format!("/admin/features/{flag_key}"),
    };
    let mut req = server.client.delete(server.api_url(&path));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("features delete");
    let status = resp.status().as_u16();
    let out: Value = resp.json().await.unwrap_or(Value::Null);
    (status, out)
}

/// Convenience: the `enabled` bool set body for a GLOBAL flag.
pub fn global_body(enabled: bool) -> Value {
    json!({ "enabled": enabled })
}

/// Convenience: the `enabled` bool set body for a PER-ACCOUNT flag.
pub fn account_body(enabled: bool, account_id: &str) -> Value {
    json!({ "enabled": enabled, "account_id": account_id })
}
