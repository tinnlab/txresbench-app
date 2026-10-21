//! Features permission vocabulary (#40).
//!
//! `features::manage` gates the runtime feature-flags admin surface
//! (`/api/admin/features` — list flags + effective state, set the global default
//! or a per-account override). It is an ADMIN-ONLY key: like `admin::accounts` and
//! `jobs::settings::manage` it is NOT granted to any group by a migration — the root
//! administrator holds it via the `is_admin` short-circuit / the `*` wildcard, and an
//! admin console may later delegate it to a non-root group at runtime (never a
//! Users-group grant, which would let any user flip deployment features).
//!
//! Binding a route to this perm (via `with_permission::<(FeaturesManage,)>` in the
//! route docs) is what lands `Permissions.FeaturesManage` in the generated FE
//! vocabulary; the string here is the single source of truth for that binding.
//!
//! Mirrors `jobs/permissions.rs` + `admin/permissions.rs` (the `perm!` macro).

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "features";
        }
    };
}

perm!(
    FeaturesManage,
    "FeaturesManage",
    "features::manage",
    "List and set runtime feature flags (global defaults + per-account overrides)"
);

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-7 [covers: ITEM-2]: drift-guard. This string backs the
    // `/api/admin/features` route binding + the generated FE `Permissions.FeaturesManage`;
    // a rename here silently unwires the admin surface's authz and the FE gate.
    #[test]
    fn features_manage_permission_string_is_stable() {
        assert_eq!(FeaturesManage::PERMISSION, "features::manage");
        assert_eq!(FeaturesManage::MODULE, "features");
    }
}
