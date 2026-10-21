//! User/group request/response DTOs. The wire types are re-exported from
//! ziee-auth (single source of truth); only the pagination query is app-local.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use ziee_auth::user::types::{
    AssignUserToGroupRequest, CreateGroupRequest, CreateUserRequest, GroupListResponse,
    ResetPasswordRequest, UpdateGroupRequest, UpdateUserRequest, UserActiveStatusResponse,
    UserListResponse,
};

/// The per-account billing PROJECTION carried per user in the admin user list (#43): the
/// comp/premium override, the plan/tier id, and the effective credit balance. `saas`-only — the
/// whole struct (and the `AdminUserListItem::billing` field that holds it) is compiled OUT of the
/// desktop/default binary and its openapi spec (INV-1). Present iff the caller holds
/// `is_admin || billing::admin` AND the user has a personal account with resolvable billing state;
/// otherwise the holding field is `null`.
#[cfg(feature = "saas")]
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct UserBillingSummary {
    /// The comp/premium allowance override on the personal account (`account_quota_override.premium`).
    pub premium: bool,
    /// The account's plan/tier id (`accounts.plan_id`; the catalog key, default `free`).
    pub plan_id: String,
    /// The effective credit balance in integer cents (active `credit_grants` sum).
    pub credit_balance_cents: i64,
}

/// One row of the admin user list (#43): the frozen `ziee_auth::User` (flattened, so every existing
/// user key is preserved at the top level — an additive, backward-compatible superset) PLUS the
/// admin projections. `ziee_auth::User`/`UserListResponse` are SDK types we cannot extend, so we
/// wrap. `personal_account_id` is a plain account concept (unconditional); `billing` is
/// `saas`-gated (absent on desktop, INV-1) and populated only for a `billing::admin` caller.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AdminUserListItem {
    /// The wrapped user — flattened so its keys sit at the item's top level (unchanged wire shape).
    #[serde(flatten)]
    pub user: ziee_auth::User,
    /// The user's personal account id, or `null` if none exists yet (read-only; never ensured).
    pub personal_account_id: Option<Uuid>,
    /// The user's personal-account billing state (`saas`-only). `null` when the caller lacks
    /// `is_admin || billing::admin`, or the user has no personal account / no resolvable state.
    #[cfg(feature = "saas")]
    pub billing: Option<UserBillingSummary>,
}

/// The admin user-list response (#43) — the app-local augmentation of the frozen
/// `ziee_auth::UserListResponse`: identical pagination envelope, `users` widened to
/// [`AdminUserListItem`].
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AdminUserListResponse {
    pub users: Vec<AdminUserListItem>,
    pub total: i64,
    pub page: i32,
    pub per_page: i32,
    pub total_pages: i64,
}

/// Pagination query (`?page=&per_page=`). Defaults 1 / 20; clamped on read.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PaginationQuery {
    #[serde(default = "default_page")]
    pub page: i32,
    #[serde(default = "default_per_page")]
    pub per_page: i32,
}

fn default_page() -> i32 {
    1
}
fn default_per_page() -> i32 {
    20
}

impl PaginationQuery {
    /// (page ≥ 1, per_page in 1..=100).
    pub fn clamped(&self) -> (i32, i32) {
        (self.page.max(1), self.per_page.clamp(1, 100))
    }
}

pub fn total_pages(total: i64, per_page: i32) -> i64 {
    if per_page > 0 {
        (total + per_page as i64 - 1) / per_page as i64
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_user() -> ziee_auth::User {
        let now = chrono::Utc::now();
        ziee_auth::User {
            id: Uuid::new_v4(),
            username: "alice".into(),
            email: "alice@example.test".into(),
            email_verified: true,
            password_hash: None,
            display_name: Some("Alice".into()),
            avatar_url: None,
            is_active: true,
            is_admin: false,
            permissions: vec![],
            created_at: now,
            updated_at: now,
            last_login_at: None,
            password_changed_at: None,
        }
    }

    /// TEST-8 [acceptance] [invariant: INV-1] [covers: ITEM-2]: in the desktop/default build the
    /// `billing` field is compiled OUT — a serialized `AdminUserListItem` has NO `billing` key at
    /// all (not a null), while the flattened user keys + `personal_account_id` are present. Pins
    /// INV-1's "the whole surface is saas-gated and compiled OUT of the desktop/default binary":
    /// flipping the cfg off must make the key VANISH, not become null.
    #[cfg(not(feature = "saas"))]
    #[test]
    fn admin_user_list_item_omits_billing_on_desktop() {
        let item = AdminUserListItem {
            user: sample_user(),
            personal_account_id: Some(Uuid::new_v4()),
        };
        let v = serde_json::to_value(&item).expect("serialize AdminUserListItem");
        assert!(
            v.get("billing").is_none(),
            "desktop build must not carry a `billing` key at all (saas compiled out), got: {v}"
        );
        assert!(
            v.get("personal_account_id").is_some(),
            "personal_account_id is unconditional"
        );
        // Flattened user keys sit at the top level (backward-compatible superset).
        assert_eq!(v["username"], "alice");
    }

    /// TEST-8 (saas side): under `--features saas` the `billing` key EXISTS (nullable) and the
    /// flatten + `personal_account_id` still hold — the presence half of the cfg contract.
    #[cfg(feature = "saas")]
    #[test]
    fn admin_user_list_item_carries_billing_on_saas() {
        let item = AdminUserListItem {
            user: sample_user(),
            personal_account_id: Some(Uuid::new_v4()),
            billing: Some(UserBillingSummary {
                premium: true,
                plan_id: "pro".into(),
                credit_balance_cents: 500,
            }),
        };
        let v = serde_json::to_value(&item).expect("serialize AdminUserListItem");
        assert_eq!(v["billing"]["premium"], serde_json::json!(true));
        assert_eq!(v["billing"]["plan_id"], "pro");
        assert_eq!(v["billing"]["credit_balance_cents"], serde_json::json!(500));
        assert!(v.get("personal_account_id").is_some());
        assert_eq!(v["username"], "alice");
    }
}
