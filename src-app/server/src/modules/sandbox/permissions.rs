//! Sandbox module permissions.
//!
//! `PermissionCheck` impls (mirror `ziee-hardware/permissions.rs`). The
//! `NAME` becomes the emitted FE `Permissions.<Name>` constant (via the 403
//! example the framework's `with_permission` documents); the `PERMISSION`
//! string is what `RequirePermissions` checks. Admin-only this round (admins
//! hold `*`), so no group-grant migration is needed (DEC — admin-only).

use ziee_identity::PermissionCheck;

/// Read the sandbox settings + status.
pub struct SandboxSettingsRead;
impl PermissionCheck for SandboxSettingsRead {
    const NAME: &'static str = "SandboxSettingsRead";
    const PERMISSION: &'static str = "sandbox::settings::read";
    const DESCRIPTION: &'static str = "View sandbox resource limits and rootfs status";
    const MODULE: &'static str = "sandbox";
}

/// Manage (update) the sandbox settings.
pub struct SandboxSettingsManage;
impl PermissionCheck for SandboxSettingsManage {
    const NAME: &'static str = "SandboxSettingsManage";
    const PERMISSION: &'static str = "sandbox::settings::manage";
    const DESCRIPTION: &'static str = "Change sandbox resource limits";
    const MODULE: &'static str = "sandbox";
}

/// Run an analysis job in the sandbox.
pub struct SandboxExecute;
impl PermissionCheck for SandboxExecute {
    const NAME: &'static str = "SandboxExecute";
    const PERMISSION: &'static str = "sandbox::execute";
    const DESCRIPTION: &'static str = "Run an analysis job in the sandbox";
    const MODULE: &'static str = "sandbox";
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-13: the permission constants are exactly the intended strings/names.
    #[test]
    fn permission_constants_are_stable() {
        assert_eq!(SandboxSettingsRead::PERMISSION, "sandbox::settings::read");
        assert_eq!(SandboxSettingsRead::NAME, "SandboxSettingsRead");
        assert_eq!(SandboxSettingsManage::PERMISSION, "sandbox::settings::manage");
        assert_eq!(SandboxSettingsManage::NAME, "SandboxSettingsManage");
        assert_eq!(SandboxExecute::PERMISSION, "sandbox::execute");
        assert_eq!(SandboxExecute::NAME, "SandboxExecute");
    }
}
