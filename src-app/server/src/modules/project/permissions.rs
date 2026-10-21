//! Project permission keys. `projects::use` gates all project CRUD (ownership + the
//! per-project resource ACL govern edit/delete, not a second RBAC verb — DEC-3).
//! `project::settings::{read,manage}` gate the deployment transfer toggle (held by
//! Administrators via `*`). `projects::use` is granted to the Users group by
//! migration `202608030003_project_baseline.sql`.

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "project";
        }
    };
}

perm!(
    ProjectsUse,
    "ProjectsUse",
    "projects::use",
    "Create, view, and manage your projects"
);
// NOTE: reading project_settings is gated by `projects::use` (the transfer_enabled
// flag drives the client's Transfer gate for every user); only MANAGE is admin.
perm!(
    ProjectSettingsManage,
    "ProjectSettingsManage",
    "project::settings::manage",
    "Change deployment-wide project settings"
);
// Admin cross-user project governance (NOT granted to any group — held by
// administrators via the `is_admin` short-circuit / `*` wildcard). `read` gates
// the cross-user list + detail; `manage` gates every admin mutation.
perm!(
    ProjectAdminRead,
    "ProjectAdminRead",
    "project::admin::read",
    "View all projects across all users (admin)"
);
perm!(
    ProjectAdminManage,
    "ProjectAdminManage",
    "project::admin::manage",
    "Change owner, share, delete, or reassign any project (admin)"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_strings_are_stable() {
        // Drift-guard: these strings back the migration grant + the sync
        // audiences + the FE `hasPermissionNow` gates.
        assert_eq!(ProjectsUse::PERMISSION, "projects::use");
        assert_eq!(ProjectSettingsManage::PERMISSION, "project::settings::manage");
        assert_eq!(ProjectAdminRead::PERMISSION, "project::admin::read");
        assert_eq!(ProjectAdminManage::PERMISSION, "project::admin::manage");
    }
}
