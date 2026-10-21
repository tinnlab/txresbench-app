//! Jobs permission keys.
//!
//! `jobs::use` is granted to the default Users group (migration
//! `202608030001_jobs_baseline.sql`) — it gates create / list-own / stop-own. The
//! admin-only `jobs::settings::{read,manage}` are held by the Administrators
//! group via its `*` wildcard, so no separate grant is needed. Mirrors
//! `modules/user/permissions.rs`.

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "jobs";
        }
    };
}

perm!(
    JobsUse,
    "JobsUse",
    "jobs::use",
    "Create, view, and stop your own analysis jobs"
);
perm!(
    JobsSettingsRead,
    "JobsSettingsRead",
    "jobs::settings::read",
    "View the jobs concurrency settings"
);
perm!(
    JobsSettingsManage,
    "JobsSettingsManage",
    "jobs::settings::manage",
    "Change the jobs concurrency settings"
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::permissions::PermissionCheck;

    // TEST-1 (partial): the three permission strings are exactly as gated.
    #[test]
    fn permission_strings() {
        assert_eq!(JobsUse::PERMISSION, "jobs::use");
        assert_eq!(JobsSettingsRead::PERMISSION, "jobs::settings::read");
        assert_eq!(JobsSettingsManage::PERMISSION, "jobs::settings::manage");
    }
}
