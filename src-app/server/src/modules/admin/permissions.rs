//! Admin permission vocabulary (#32).
//!
//! `admin::accounts` gates the cross-account admin surface (`/api/admin/accounts/*`
//! — list / read / suspend any account, regardless of membership). It is an
//! ADMIN-ONLY key: like the `provenance` settings perms it is NOT granted to any
//! group by a migration — the root administrator holds it via the `is_admin`
//! short-circuit / the `*` wildcard, and an admin console may later delegate it to a
//! non-root group at runtime (never a Users-group grant, which would be a
//! cross-account privilege escalation — DEC-8).
//!
//! Binding a route to this perm (via `with_permission::<(AdminAccounts,)>` in the
//! route docs) is what lands `Permissions.AdminAccounts` in the generated FE
//! vocabulary; the string here is the single source of truth for that binding.
//!
//! Mirrors `account/permissions.rs` + `billing/permissions.rs` (the `perm!` macro).

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "admin";
        }
    };
}

perm!(
    AdminAccounts,
    "AdminAccounts",
    "admin::accounts",
    "List, read, and suspend any account (cross-account admin)"
);

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1 [covers: ITEM-1]: drift-guard. This string backs the `/api/admin/accounts`
    // route binding + the generated FE `Permissions.AdminAccounts`; a rename here
    // silently unwires the admin surface's authz and the FE gate.
    #[test]
    fn admin_accounts_permission_string_is_stable() {
        assert_eq!(AdminAccounts::PERMISSION, "admin::accounts");
        assert_eq!(AdminAccounts::MODULE, "admin");
    }
}
