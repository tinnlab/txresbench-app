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

/// The acting user's ACTIVE group ids — the `group_ids` argument every
/// share/visibility resolver takes (`DatasetRepository::{access, is_visible_to,
/// require_can_edit}`).
///
/// One definition, because the inactive-group filter is a security predicate: a
/// deactivated group must not confer a share. Two hand-copies already existed
/// (`dataset::routes`, `dataset::process`) and a third was about to be written for
/// the jobs create path; the moment one copy forgets `.is_active` the endpoints that
/// use it silently honour shares through disabled groups.
pub fn active_group_ids(groups: &[Group]) -> Vec<uuid::Uuid> {
    groups
        .iter()
        .filter(|g| g.is_active)
        .map(|g| g.id)
        .collect()
}

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

#[cfg(test)]
mod tests {
    use super::perm_matches;

    #[test]
    fn wildcard_matching() {
        assert!(perm_matches("*", "users::read"));
        assert!(perm_matches("users::read", "users::read"));
        assert!(perm_matches("users::*", "users::read"));
        assert!(!perm_matches("users::read", "users::edit"));
        assert!(!perm_matches("groups::*", "users::read"));
    }
}
