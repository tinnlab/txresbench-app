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

/// Manage the deployment INFRASTRUCTURE backend config (#63) — the object-store
/// (S3/GCS) + compute (Kubernetes) admin config surfaces (`/api/admin/infra/*`).
///
/// **saas-only** (`#[cfg(feature = "saas")]`): the struct + every route reference it
/// are compiled only under `saas`, so it lands ONLY in the saas OpenAPI spec / FE
/// saas permissions enum — hiding the Infrastructure settings page on desktop exactly
/// like `billing::admin`. Admin-only (held via `*`/`is_admin`; no group-grant
/// migration). A single "infrastructure admin" capability spanning both surfaces
/// (the compute surface, in `modules/sandbox`, `use`s this same type). `MODULE` is
/// the display grouping label `"infra"`, not a rust-module dir.
#[cfg(feature = "saas")]
pub struct InfraSettingsManage;
#[cfg(feature = "saas")]
impl PermissionCheck for InfraSettingsManage {
    const NAME: &'static str = "InfraSettingsManage";
    const PERMISSION: &'static str = "infra::settings::manage";
    const DESCRIPTION: &'static str =
        "Configure and test the object-store and compute backends";
    const MODULE: &'static str = "infra";
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

    // TEST-7 [covers: ITEM-10]: the new saas-only infra permission is stable + distinct
    // from the per-module settings perms (never collapse — an infra admin is not a
    // workstore-GC admin).
    #[cfg(feature = "saas")]
    #[test]
    fn infra_settings_manage_is_stable_and_distinct() {
        assert_eq!(InfraSettingsManage::PERMISSION, "infra::settings::manage");
        assert_eq!(InfraSettingsManage::NAME, "InfraSettingsManage");
        assert_eq!(InfraSettingsManage::MODULE, "infra");
        assert_ne!(InfraSettingsManage::PERMISSION, WorkstoreSettingsManage::PERMISSION);
    }
}
