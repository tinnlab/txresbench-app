//! The compiled flag registry — the source of truth for WHICH runtime feature
//! flags exist and each one's COMPILED DEFAULT.
//!
//! The `feature_flags` table records only DEVIATIONS from these defaults (a global
//! row overrides the compiled default; a per-account row overrides the global). A
//! flag with no row anywhere resolves to its compiled `default_enabled` here
//! (`is_feature_enabled`, INV-2) — never an error. A `flag_key` NOT in this registry
//! is unknown: the guard fails CLOSED (`false`) and the admin `PUT` refuses it (404
//! `UNKNOWN_FLAG`), so the registry is also the allow-list of settable keys.
//!
//! To add a runtime-togglable feature, add a `FlagSpec` here. Other modules consult
//! it through `is_feature_enabled(pool, key, account_id)`; they never read the table
//! directly.

/// A single known runtime feature flag: its stable key, a human description (shown
/// on the admin surface), and the default that applies when no DB row overrides it.
#[derive(Debug, Clone, Copy)]
pub struct FlagSpec {
    pub key: &'static str,
    pub description: &'static str,
    pub default_enabled: bool,
}

/// Every known runtime feature flag. Keep keys `snake_case`/`dotted` and stable
/// (they are persisted in `feature_flags.flag_key` and surfaced to the FE).
pub const KNOWN_FLAGS: &[FlagSpec] = &[
    // A demonstration flag proving the whole subsystem end-to-end (the guard helper,
    // the global/per-account override layers, and the admin GET/PUT). Its default is
    // OFF; an admin can turn it on globally or per-account. It gates no production
    // behaviour yet — it is the worked example the design promises other modules will
    // follow by adding their own `FlagSpec` and calling `is_feature_enabled`.
    FlagSpec {
        key: "demo.runtime_flag",
        description: "Demonstration runtime flag (proves the feature-flags seam end-to-end)",
        default_enabled: false,
    },
];

/// Look up a flag spec by key. `None` ⇒ the key is not a known flag.
pub fn lookup(flag_key: &str) -> Option<&'static FlagSpec> {
    KNOWN_FLAGS.iter().find(|f| f.key == flag_key)
}

/// The compiled default for `flag_key`. An UNKNOWN key fails CLOSED (`false`) — it is
/// never treated as enabled, so a typo or a removed flag can never silently turn a
/// gate on.
pub fn compiled_default(flag_key: &str) -> bool {
    lookup(flag_key).map(|f| f.default_enabled).unwrap_or(false)
}

/// Is `flag_key` a known, settable flag?
pub fn is_known(flag_key: &str) -> bool {
    lookup(flag_key).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-6 [covers: ITEM-3]: the registry enumerates the demonstration flag with a
    // compiled default, and an unknown key fails closed rather than erroring.
    #[test]
    fn registry_lookup_and_default() {
        assert!(is_known("demo.runtime_flag"));
        assert_eq!(compiled_default("demo.runtime_flag"), false);
        assert!(!is_known("nope.not_a_flag"));
        // Unknown ⇒ fail-closed default, never a panic/error.
        assert_eq!(compiled_default("nope.not_a_flag"), false);
    }

    // Keys must be unique (the registry is an allow-list keyed by `key`).
    #[test]
    fn registry_keys_are_unique() {
        let mut keys: Vec<&str> = KNOWN_FLAGS.iter().map(|f| f.key).collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(before, keys.len(), "duplicate flag key in KNOWN_FLAGS");
    }
}
