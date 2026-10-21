//! Billing permission keys (ITEM-2).
//!
//! `billing::read` + `billing::manage` are granted to the default Users group by
//! the module's migration (`202608260003_billing_accounts_columns.sql`) — a user
//! acts WITHIN an account context (the `X-Account-Id` `ActiveAccount` extractor),
//! so account-scope (cross-account → 404) is enforced there, not by RBAC.
//! Administrators hold both via the `*` wildcard. Mirrors `jobs/permissions.rs`.
//!
//! Least-privilege: a read endpoint (usage/status) takes [`BillingRead`]; a
//! mutation (checkout / portal) takes [`BillingManage`].

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "billing";
        }
    };
}

perm!(
    BillingRead,
    "BillingRead",
    "billing::read",
    "View your account's billing status and usage"
);
perm!(
    BillingManage,
    "BillingManage",
    "billing::manage",
    "Start checkout and manage your account's subscription"
);
// Cross-account admin billing (#32) — read/override ANY account's plan, usage, and
// credits. DISTINCT from the self-serve manage key above (which acts only WITHIN the
// caller's own account context). Admin-only: NOT group-granted (Administrators hold it
// via `*` / `is_admin`), bound by the Tier-2 admin-billing routes. Its `admin` action
// is deliberately not a user-facing use/read/manage verb — it gates an admin surface,
// not a user one.
perm!(
    BillingAdmin,
    "BillingAdmin",
    "billing::admin",
    "Read and override any account's plan, usage, and credits (cross-account admin)"
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::permissions::PermissionCheck;

    // The two permission strings are exactly as gated (mirrors jobs' test).
    #[test]
    fn permission_strings() {
        assert_eq!(BillingRead::PERMISSION, "billing::read");
        assert_eq!(BillingManage::PERMISSION, "billing::manage");
    }

    // TEST-2 [covers: ITEM-1]: the cross-account admin billing key is stable AND
    // DISTINCT from the self-serve manage key — they must never collapse into one, or
    // a self-serve user would inherit cross-account billing power.
    #[test]
    fn billing_admin_is_stable_and_distinct_from_manage() {
        assert_eq!(BillingAdmin::PERMISSION, "billing::admin");
        assert_ne!(BillingAdmin::PERMISSION, BillingManage::PERMISSION);
    }
}
