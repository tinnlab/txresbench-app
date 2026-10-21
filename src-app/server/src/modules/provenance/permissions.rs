//! Provenance permission keys (ITEM-29 / DEC-10). `provenance::read` +
//! `provenance::export` are granted to the Users group by
//! `202608030005_provenance_baseline.sql` (the per-project role via
//! `effective_permission` gates the specific project); `provenance::settings::{read,
//! manage}` get NO grant — Administrators hold them via the `*` wildcard.

use crate::modules::permissions::PermissionCheck;

macro_rules! perm {
    ($ident:ident, $name:literal, $perm:literal, $desc:literal) => {
        pub struct $ident;
        impl PermissionCheck for $ident {
            const NAME: &'static str = $name;
            const PERMISSION: &'static str = $perm;
            const DESCRIPTION: &'static str = $desc;
            const MODULE: &'static str = "provenance";
        }
    };
}

perm!(
    ProvenanceRead,
    "ProvenanceRead",
    "provenance::read",
    "View provenance / reproducibility lineage for projects you can access"
);
perm!(
    ProvenanceExport,
    "ProvenanceExport",
    "provenance::export",
    "Build + download reproducibility export bundles"
);
perm!(
    ProvenanceSettingsRead,
    "ProvenanceSettingsRead",
    "provenance::settings::read",
    "View deployment-wide provenance settings (admin)"
);
perm!(
    ProvenanceSettingsManage,
    "ProvenanceSettingsManage",
    "provenance::settings::manage",
    "Change deployment-wide provenance settings (admin)"
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_strings_are_stable() {
        // Drift-guard: these strings back the migration grant + the sync
        // audiences + the FE `hasPermissionNow` gates.
        assert_eq!(ProvenanceRead::PERMISSION, "provenance::read");
        assert_eq!(ProvenanceExport::PERMISSION, "provenance::export");
        assert_eq!(ProvenanceSettingsRead::PERMISSION, "provenance::settings::read");
        assert_eq!(ProvenanceSettingsManage::PERMISSION, "provenance::settings::manage");
        assert_eq!(ProvenanceRead::MODULE, "provenance");
    }
}
