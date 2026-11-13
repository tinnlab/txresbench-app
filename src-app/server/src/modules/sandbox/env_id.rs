//! The env-id GRAMMAR — single-sourced between the runtime and the build lint.
//!
//! WHY ITS OWN MODULE: `env:` (an env-id) is read in more than one place and each
//! must spell the grammar identically — the runtime resolver here, the settings
//! validator, the method-env manager's id checks. If each spelled the grammar
//! itself they would drift, and the drift direction that matters is the silent
//! one: an id one site accepts and another rejects fails late, not loud.
//!
//! So the predicate lives here, in a module with NO dependencies beyond `core`.
//! One definition, every reader, no mirror to drift.
//!
//! There is deliberately NO allowlist of known env names here. Any well-formed id maps
//! to its own per-env image repo; the set of envs is deployment DATA, never a list the
//! app core carries (INV-4).

/// Whether `env_id` is a valid OCI repository PATH COMPONENT (lowercase
/// alphanumerics + `.` `_` `-`, non-empty).
///
/// This is the one grammar `env_image::resolve` enforces, exposed so the settings
/// `validate()` can reject a malformed admin-supplied `default_env_id` up front (#54),
/// so the analysis/converter contribution can reject a malformed declared `env` at
/// PARSE time, and so the build lint can reject it before a package is ever staged.
///
/// A value failing this check would otherwise resolve to a broken pull ref, or smuggle
/// a `:tag` / `@digest` / registry host into the reference the provider pulls — which
/// is why the check is a hard rejection everywhere it is applied, never a warn-and-skip.
pub fn is_valid_env_id(env_id: &str) -> bool {
    !env_id.is_empty()
        && env_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grammar's ACCEPT side, stated over shapes rather than over any particular
    /// env name — naming a real env here would put an env-name literal in the app core,
    /// which is exactly what INV-4 forbids (and what `env_image_test.rs`'s R3-F2
    /// discipline already established for this module's sibling tests).
    /// Lifecycle id: **TEST-6** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn accepts_lowercase_digits_dot_underscore_hyphen() {
        for ok in ["a", "a1", "a-b", "a_b", "a.b", "0", "x-y.z_9"] {
            assert!(is_valid_env_id(ok), "{ok:?} is a legal repo path component");
        }
    }

    /// The REJECT side is the security-relevant half: every one of these would, if it
    /// reached `resolve`, either break the pull ref or inject a second reference
    /// component (a tag, a digest, a registry host, a repo path separator).
    /// Lifecycle id: **TEST-6** (see `.lifecycle/analysis-env-selection/TESTS.md`).
    #[test]
    fn rejects_empty_uppercase_and_reference_separators() {
        for bad in [
            "",           // empty — no repo component at all
            "UPPER",      // OCI repo components are lowercase
            "MixedCase",  //
            "a/b",        // a path separator — a SECOND repo component
            "x:tag",      // a tag
            "y@sha256:0", // a digest
            "has space",  //
            "reg.io/a",   // a registry host
            "a\nb",       // a control character
            "café",       // non-ASCII
        ] {
            assert!(!is_valid_env_id(bad), "{bad:?} must be rejected");
        }
    }
}
