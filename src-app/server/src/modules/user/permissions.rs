//! User + group management permission keys. Held by the Administrators group
//! via its `*` wildcard (seeded by ziee-auth), so no separate grant migration is
//! needed. Self-service `Profile*` keys are re-exported from ziee-auth.

use crate::modules::permissions::PermissionCheck;

pub use ziee_auth::user::permissions::{ProfileEdit, ProfileRead};

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "user";
        }
    };
}

perm!(UsersRead, "UsersRead", "users::read", "View and list users");
perm!(UsersCreate, "UsersCreate", "users::create", "Create new user accounts");
perm!(UsersEdit, "UsersEdit", "users::edit", "Edit existing users");
perm!(UsersDelete, "UsersDelete", "users::delete", "Delete user accounts");
perm!(
    UsersResetPassword,
    "UsersResetPassword",
    "users::reset_password",
    "Reset another user's password"
);
perm!(
    UsersToggleStatus,
    "UsersToggleStatus",
    "users::toggle_status",
    "Activate or deactivate users"
);

perm!(GroupsRead, "GroupsRead", "groups::read", "View and list groups");
perm!(GroupsCreate, "GroupsCreate", "groups::create", "Create groups");
perm!(GroupsEdit, "GroupsEdit", "groups::edit", "Edit groups");
perm!(GroupsDelete, "GroupsDelete", "groups::delete", "Delete groups");
perm!(
    GroupsAssignUsers,
    "GroupsAssignUsers",
    "groups::assign_users",
    "Assign users to / remove users from groups"
);
