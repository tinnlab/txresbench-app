//! Permission enforcement wiring — fixes the framework's generic
//! `RequirePermissions` to TxResBench's concrete `CytoIdentityResolver`, and a
//! small wildcard-aware self-escalation guard.

pub use txresbench_framework::permissions::with_permission;
pub use txresbench_identity::{PermissionCheck, PermissionList};

use txresbench_auth::auth::DefaultIdentityResolver;
use txresbench_auth::user::{Group, User};

/// Permission extractor fixed to the SDK's `DefaultIdentityResolver` (was a
/// hand-written `CytoIdentityResolver` — SDK_GAPS G1, now SDK-provided). Use in
/// handler signatures as `RequirePermissions<(UsersRead,)>` (single or tuple,
/// AND logic). Exposes `.user: User` + `.groups: Vec<Group>`.
pub type RequirePermissions<Perms> =
    txresbench_framework::permissions::RequirePermissions<DefaultIdentityResolver, Perms>;

/// Root-admin-only extractor fixed to the SDK's `DefaultIdentityResolver` (mirrors
/// [`RequirePermissions`]). Use in a handler signature as `_auth: RequireAdmin` to
/// gate an operation to the root administrator only (401 unauthenticated, 403 for a
/// non-admin). Exposes `.user: User`.
pub type RequireAdmin = txresbench_framework::permissions::RequireAdmin<DefaultIdentityResolver>;

/// True if the acting principal holds `perm` (wildcard-aware). Admins hold
/// everything; otherwise any of the user's direct permissions or active-group
/// permissions must match `perm` exactly, via `*`, or via a `resource::*`
/// hierarchical prefix. Backs the self-escalation guard (a non-admin can't grant
/// a permission they don't themselves hold).
pub fn principal_holds(user: &User, groups: &[Group], perm: &str) -> bool {
    if user.is_admin {
        return true;
    }
    let mut held: Vec<&str> = user.permissions.iter().map(String::as_str).collect();
    for g in groups {
        if g.is_active {
            held.extend(g.permissions.iter().map(String::as_str));
        }
    }
    held.iter().any(|h| perm_matches(h, perm))
}

fn perm_matches(held: &str, wanted: &str) -> bool {
    if held == "*" || held == wanted {
        return true;
    }
    if let Some(prefix) = held.strip_suffix("::*") {
        return wanted == prefix || wanted.starts_with(&format!("{prefix}::"));
    }
    false
}

/// `projects::use` — the permission key reused by the kept txr catalogue routes
/// (`/api/methods*`, `/api/file-validation*`) as their gate ("no new permission").
///
/// Re-homed here from the removed `project` module (strip-single-cell ITEM-3,
/// owner verdict: small seam edit, no behaviour change): the constant is
/// byte-identical — same `NAME`, `PERMISSION`, `DESCRIPTION` and `MODULE` — so
/// held-permission rows, the sync audiences and the FE
/// `Permissions.ProjectsUse` constant all keep resolving. The module's own
/// migration grant was removed with it; the app's single user is the admin
/// (`"*"` wildcard), so the gate passes exactly as before.
pub struct ProjectsUse;
impl PermissionCheck for ProjectsUse {
    const NAME: &'static str = "ProjectsUse";
    const PERMISSION: &'static str = "projects::use";
    const DESCRIPTION: &'static str = "Create, view, and manage your projects";
    const MODULE: &'static str = "project";
}

#[cfg(test)]
mod tests {
    use super::perm_matches;

    // The re-homed permission is defined in this module (ITEM-3); bring it in
    // for the wire-string pin below, together with the trait that exposes the
    // associated consts.
    use super::ProjectsUse;
    use txresbench_identity::PermissionCheck;

    #[test]
    fn wildcard_matching() {
        assert!(perm_matches("*", "users::read"));
        assert!(perm_matches("users::read", "users::read"));
        assert!(perm_matches("users::*", "users::read"));
        assert!(!perm_matches("users::read", "users::edit"));
        assert!(!perm_matches("groups::*", "users::read"));
    }

    // The re-homed permission keeps its wire bytes (strip-single-cell ITEM-3):
    // the scraper emits `Permissions.ProjectsUse` and held permissions / sync
    // audiences match on the exact string.
    #[test]
    fn projects_use_keeps_its_wire_strings() {
        assert_eq!(ProjectsUse::NAME, "ProjectsUse");
        assert_eq!(ProjectsUse::PERMISSION, "projects::use");
        assert_eq!(ProjectsUse::MODULE, "project");
    }
}
