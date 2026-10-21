//! Draft permission keys. `drafts::use` gates all draft CRUD + freeze (project
//! ownership + the per-project resource ACL govern edit/delete, not a second RBAC
//! verb — mirrors `projects::use`). Granted to the Users group by migration
//! `202608240001_drafts_baseline.sql`.

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "drafts";
        }
    };
}

perm!(
    DraftsUse,
    "DraftsUse",
    "drafts::use",
    "Create, edit, and freeze draftable entities in your projects"
);

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-11: the `drafts::use` permission string is stable — it backs the migration
    // grant, the sync audience, and the FE `hasPermissionNow` gate (mirrors
    // `project::permission_strings_are_stable`).
    #[test]
    fn permission_strings_are_stable() {
        assert_eq!(DraftsUse::PERMISSION, "drafts::use");
        assert_eq!(DraftsUse::NAME, "DraftsUse");
    }
}
