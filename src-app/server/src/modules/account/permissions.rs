//! Account permission keys. `account::read` gates viewing accounts + membership
//! (the switcher list / active-account context, A4); it is granted to the `Users`
//! group by the baseline migration (the `projects::use` / "drafts::use-style"
//! grant pattern). `account::manage` gates org management (A3, `saas`) and is held
//! by Administrators via the `*` wildcard — NOT group-granted.
//!
//! In A1 neither perm gates a reachable route or UI (the first gated surface is
//! A4's `/api/accounts` + the FE `Accounts` store) — DEC-4. A1 provides the
//! vocabulary + the grant landing (pinned by TEST-3 + TEST-5).

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "account";
        }
    };
}

perm!(
    AccountRead,
    "AccountRead",
    "account::read",
    "View your accounts and their membership"
);
// Admin / org management (NOT granted to any group — held by administrators via
// the `is_admin` short-circuit / `*` wildcard). Org creation + member management
// (A3, `saas`) bind this.
perm!(
    AccountManage,
    "AccountManage",
    "account::manage",
    "Create and manage organizations and their members"
);

// #139 — the ACCOUNT-SCOPED capability. Factor (a) of the two-factor
// authorization in `member_scope.rs`: the operator kill switch and the codegen
// anchor. Granted to the `Users` group by 202609040001 so self-service is ON by
// default; revoking it there turns self-service off deployment-wide.
//
// It is deliberately a NEW key rather than a reuse of `account::manage`. Granting
// `account::manage` to the Users group would, in one step, open `POST /api/accounts`
// to every user with an attacker-chosen `owner_id`, universally satisfy the second
// factor on the `/api/admin/accounts/*` member-CRUD routes, and make the FE's
// `admin.account.*` actions MCP-invocable for everyone. A new key has zero blast
// radius: exactly one route consumes it, and that route ALSO requires account
// membership at `admin` or above, so the grant alone confers nothing.
//
// It carries NO account identity and is NEVER authority — see `member_scope.rs`.
perm!(
    AccountMembersManage,
    "AccountMembersManage",
    "account::members::manage",
    "Manage the members of accounts you administer"
);

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-3: drift-guard — these strings back the migration grant + the sync
    // audiences + the FE `hasPermissionNow` gates. A rename here silently unwires
    // A4's `/api/accounts` self-gate.
    #[test]
    fn permission_strings_are_stable() {
        assert_eq!(AccountRead::PERMISSION, "account::read");
        assert_eq!(AccountManage::PERMISSION, "account::manage");
        // TEST-3 [covers: ITEM-2] (#139): the account-scoped capability key. A rename
        // here silently unwires the 202609040001 Users-group grant, the OpenAPI
        // binding that lands `Permissions.AccountMembersManage` in BOTH generated FE
        // enums, and #149's `<Can>` / `defineAction({ permission })` gates — none of
        // which would fail to compile. Pinned as a literal so the break is loud.
        assert_eq!(
            AccountMembersManage::PERMISSION,
            "account::members::manage"
        );
    }
}
