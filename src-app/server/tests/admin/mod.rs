//! TxResBench strip: the `/api/admin/accounts/*` HTTP surface (and the `admin` module
//! it belonged to) was removed, so the tests that used these three helpers now drive
//! the SAME repository operations the remaining self-service routes (#142) reach,
//! through the `AccountRepository` directly, with the same `ActorCeiling::PlatformStaff`
//! principal the removed admin handler used. Refusals are returned in the same wire
//! shape the admin handler produced (`AppError` serializes as
//! `{status_code, error_code, message, details}`), so existing assertions keep binding
//! to the refusal CODE rather than to the route.
//!
//! What the HTTP layer previously contributed that a direct call does not — the
//! `admin::accounts` + `account::manage` permission gate and the authorization oracle
//! around it — is covered nowhere in this build, because the admin surface is gone;
//! these wrappers make no claim about it.

use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use uuid::Uuid;
use ziee_core::AppError;

use cytoanalyst::modules::account::{AccountRepository, AccountRole, ActorCeiling};

use crate::common::TestServer;

/// The repo-backed equivalents of the removed catalog helpers: the
/// `ActorCeiling::PlatformStaff` principal the removed admin handler acted under.
fn staff() -> ActorCeiling {
    ActorCeiling::PlatformStaff {
        staff_user_id: Uuid::nil(),
    }
}

fn repo(server: &TestServer) -> AccountRepository {
    let pool = SqlitePoolOptions::new()
        .connect_lazy(server.database_url())
        .expect("lazy pool");
    AccountRepository::new(pool)
}

fn err_body(err: &AppError) -> Value {
    serde_json::to_value(err).unwrap_or_else(|_| json!({ "error_code": err.error_code() }))
}

/// Add `user_id` with `role` to `account_id` — the shape of the removed
/// `POST /api/admin/accounts/{id}/members`.
pub async fn admin_add_member(
    server: &TestServer,
    _token: Option<&str>,
    account_id: &str,
    user_id: Uuid,
    role: &str,
) -> (u16, Value) {
    let account_id: Uuid = account_id.parse().expect("account id uuid");
    let role: AccountRole = AccountRole::from_str(role).expect("known role");
    match repo(server)
        .add_member(account_id, user_id, role, staff())
        .await
    {
        Ok(_) => (201, json!({})),
        Err(err) => (err.status_code(), err_body(&err)),
    }
}

/// Remove `user_id` from `account_id` — the shape of the removed
/// `DELETE /api/admin/accounts/{id}/members/{user_id}`.
pub async fn admin_remove_member(
    server: &TestServer,
    _token: Option<&str>,
    account_id: &str,
    user_id: Uuid,
) -> u16 {
    let account_id: Uuid = account_id.parse().expect("account id uuid");
    match repo(server)
        .remove_member(account_id, user_id, staff())
        .await
    {
        Ok(_) => 204,
        Err(err) => err.status_code(),
    }
}

/// Set `user_id`'s role in `account_id` to `role` — the shape of the removed
/// `PATCH /api/admin/accounts/{id}/members/{user_id}`.
pub async fn admin_set_role(
    server: &TestServer,
    _token: Option<&str>,
    account_id: &str,
    user_id: Uuid,
    role: &str,
) -> (u16, Value) {
    let account_id: Uuid = account_id.parse().expect("account id uuid");
    let role: AccountRole = AccountRole::from_str(role).expect("known role");
    match repo(server)
        .set_role(account_id, user_id, role, staff())
        .await
    {
        Ok(_) => (200, json!({})),
        Err(err) => (err.status_code(), err_body(&err)),
    }
}
