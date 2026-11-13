//! Jobs permission keys.
//!
//! `jobs::use` is granted to the default Users group (migration
//! `202608030001_jobs_baseline.sql`) — it gates the execution engine's job
//! admission surfaces. The Administrators group holds everything via its `*`
//! wildcard, so no separate admin grant is needed. Mirrors
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::permissions::PermissionCheck;

    #[test]
    fn permission_strings() {
        assert_eq!(JobsUse::PERMISSION, "jobs::use");
    }
}
