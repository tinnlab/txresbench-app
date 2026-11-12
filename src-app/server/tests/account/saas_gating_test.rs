//! TEST-12 [acceptance, INV-3, PROV-A1-7]: the account model exists in BOTH builds
//! — no `cfg(feature = "saas")` wraps the account module's tables / migration /
//! models / `AccountRole` / permissions / the `SyncEntity::Account`/`::AccountMember`
//! variants. Only org/billing *surfaces* (A3) are saas-gated; the account graph +
//! the `account_id` ownership key are UNCONDITIONAL (§13 AC-INV-6).
//!
//! A source-grep proof (mirrors the codebase's removal-proof pattern), plus a live
//! assertion that the two SyncEntity variants serialize to their frozen wire keys.

use std::path::PathBuf;

use txresbench::modules::sync::SyncEntity;

fn read(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Normalize whitespace so `cfg(feature="saas")` and `cfg(feature = "saas")` both
/// match.
fn has_saas_cfg(src: &str) -> bool {
    let squashed: String = src.chars().filter(|c| !c.is_whitespace()).collect();
    squashed.contains("cfg(feature=\"saas\")")
}

// TEST-12: no A1 account item is saas-gated.
#[test]
fn account_model_is_never_saas_gated() {
    // Every A1-owned source file (the tables live in the migration; the models,
    // roles, permissions, repository + module registration in these .rs files).
    for f in [
        "src/modules/account/mod.rs",
        "src/modules/account/models.rs",
        "src/modules/account/permissions.rs",
        "src/modules/account/repository.rs",
        "src/modules/account/scope.rs",
        "src/modules/account/migrations/202608040012_account_baseline.sql",
    ] {
        let src = read(f);
        assert!(
            !has_saas_cfg(&src),
            "{f} must NOT be wrapped in cfg(feature = \"saas\") — the account model \
             exists in BOTH builds (INV-3 / AC-INV-6)"
        );
    }

    // The two SyncEntity variants must not be saas-gated in sync/event.rs. We can't
    // grep the whole file (it may legitimately mention saas elsewhere in future), so
    // assert the variants exist + are usable unconditionally by constructing them.
    let event_src = read("src/modules/sync/event.rs");
    assert!(
        event_src.contains("Account,") && event_src.contains("AccountMember,"),
        "SyncEntity::Account/::AccountMember declared in sync/event.rs"
    );
    assert!(
        !has_saas_cfg(&event_src),
        "sync/event.rs carries no cfg(feature=\"saas\") gate (the account variants are unconditional)"
    );
}

// PROV-A1-7: the two variants serialize to the frozen wire keys the FE
// `sync:<entity>` subscriptions bind to. A rename silently unwires A4's store.
#[test]
fn sync_entity_variants_serialize_to_frozen_keys() {
    assert_eq!(
        serde_json::to_string(&SyncEntity::Account).unwrap(),
        "\"account\""
    );
    assert_eq!(
        serde_json::to_string(&SyncEntity::AccountMember).unwrap(),
        "\"account_member\""
    );
}
