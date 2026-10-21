//! Rootfs-obtainability seam (ITEM-22 / DEC-32).
//!
//! The reproducibility-readiness layer must know whether a run's PINNED
//! `env_rootfs_sha256` is still **obtainable** — present in the digest-keyed
//! rootfs cache (or servable by a running deployment). A GC'd / never-cached
//! historical digest makes the chain NOT reproducible (`readiness.env_pinned`
//! flips false — TEST-70).
//!
//! Ownership split: this module (`provenance`, order 35) DEFINES the seam; the
//! sibling `rootfs` module (order 60, owns the content-digest-keyed cache)
//! installs the real check from its `init` via [`install_rootfs_obtainability`],
//! backed by `rootfs::cache::has_digest(digest) -> bool` (the agreed CONTRACT
//! signature). Until it does, the [`Default`][DefaultObtainability] fallback
//! treats only the CURRENTLY-embedded rootfs digest as obtainable (the embedded
//! bytes are always present in this binary) — so a fresh, un-updated deployment
//! reports its own runs reproducible and any archived-away digest not.

use std::sync::{Arc, OnceLock};

/// Answers "is this rootfs content digest obtainable here?" for the readiness
/// obtainability check. `digest` is the bare lowercase-hex form stored in
/// `provenance_run_repro.env_rootfs_sha256` (NO `sha256:` prefix); an impl MUST
/// tolerate a `sha256:`-prefixed input defensively.
pub trait RootfsObtainability: Send + Sync {
    fn has_digest(&self, digest: &str) -> bool;
}

/// Fallback used before the `rootfs` module installs the cache-backed check:
/// only the digest of the rootfs embedded in THIS binary is obtainable.
pub struct DefaultObtainability;

impl RootfsObtainability for DefaultObtainability {
    fn has_digest(&self, digest: &str) -> bool {
        let want = normalize_digest(digest);
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        !embedded.is_empty() && embedded == want
    }
}

/// Strip a `sha256:` scheme prefix (if present) + lowercase — the canonical
/// bare-hex digest form used across the cache key, serve endpoint, and
/// `environments.json` placement.
pub fn normalize_digest(digest: &str) -> String {
    digest.strip_prefix("sha256:").unwrap_or(digest).trim().to_ascii_lowercase()
}

static OBTAIN: OnceLock<Arc<dyn RootfsObtainability>> = OnceLock::new();

/// Install the process-wide obtainability check (called once from the `rootfs`
/// module's `init`). Idempotent — a second install is ignored.
pub fn install_rootfs_obtainability(check: Arc<dyn RootfsObtainability>) {
    let _ = OBTAIN.set(check);
}

/// The installed obtainability check (the embedded-only default if never
/// installed).
pub fn obtainability() -> Arc<dyn RootfsObtainability> {
    OBTAIN.get().cloned().unwrap_or_else(|| Arc::new(DefaultObtainability))
}

/// Convenience: is a pinned rootfs digest obtainable? (`None` — an in-app
/// interaction/promote run with no rootfs — is vacuously obtainable: nothing to
/// obtain.)
pub fn is_env_obtainable(env_rootfs_sha256: Option<&str>) -> bool {
    match env_rootfs_sha256 {
        Some(d) => obtainability().has_digest(d),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_scheme_and_lowercases() {
        assert_eq!(normalize_digest("sha256:ABCD"), "abcd");
        assert_eq!(normalize_digest("  deadBEEF "), "deadbeef");
        assert_eq!(normalize_digest("abc"), "abc");
    }

    // A `None` env (interaction/promote run) is always obtainable — nothing to
    // fetch. The default getter returns a usable check (embedded-only).
    #[test]
    fn none_env_is_vacuously_obtainable() {
        assert!(is_env_obtainable(None), "no pinned rootfs → nothing to obtain");
        // The default check is usable + deterministic for an unknown digest.
        let seam = obtainability();
        assert!(!seam.has_digest("sha256:0000000000000000000000000000000000000000000000000000000000000000"));
    }
}
