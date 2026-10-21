//! Workstore module permissions.
//!
//! `PermissionCheck` impls (mirror `modules/sandbox/permissions.rs`). The `NAME`
//! becomes the emitted FE `Permissions.<Name>` constant (via the 403 example the
//! framework's `with_permission` documents); the `PERMISSION` string is what
//! `RequirePermissions` checks. Admin-only this round (admins hold `*`), so no
//! group-grant migration is needed (DEC-4).

use ziee_identity::PermissionCheck;

/// Read the workstore settings (GC policy + ingest size caps).
pub struct WorkstoreSettingsRead;
impl PermissionCheck for WorkstoreSettingsRead {
    const NAME: &'static str = "WorkstoreSettingsRead";
    const PERMISSION: &'static str = "workstore::settings::read";
    const DESCRIPTION: &'static str = "View the workstore GC policy and ingest size caps";
    const MODULE: &'static str = "workstore";
}

/// Manage (update) the workstore settings.
pub struct WorkstoreSettingsManage;
impl PermissionCheck for WorkstoreSettingsManage {
    const NAME: &'static str = "WorkstoreSettingsManage";
    const PERMISSION: &'static str = "workstore::settings::manage";
    const DESCRIPTION: &'static str = "Change the workstore GC policy and ingest size caps";
    const MODULE: &'static str = "workstore";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_constants_are_stable() {
        assert_eq!(WorkstoreSettingsRead::PERMISSION, "workstore::settings::read");
        assert_eq!(WorkstoreSettingsRead::NAME, "WorkstoreSettingsRead");
        assert_eq!(WorkstoreSettingsManage::PERMISSION, "workstore::settings::manage");
        assert_eq!(WorkstoreSettingsManage::NAME, "WorkstoreSettingsManage");
    }

}
