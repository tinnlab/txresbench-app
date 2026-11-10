//! The problem catalogue — the ONE table the Help page's troubleshooting
//! list is generated from (qa-fixes2 ITEM-3, R2-H8).
//!
//! The file validator's problem-code vocabulary is closed (`ProblemCode::ALL`,
//! 28 codes) and every code's REPORT severity + applicability is now declared
//! in one place: [`rules::RULES`] (the 21 tidy-rule ids) and
//! [`rules::APP_RULES`] (the 7 app-only ids A01–A07). This module folds both
//! tables into the catalogue the UI consumes — a committed JSON copy in
//! `src-app/ui/src/modules/txrhelp/validator-catalog.json`, imported by the
//! Help content and rendered as the troubleshooting entries' severity groups
//! and "not reported by the app" marker.
//!
//! The drift contract is two-sided:
//!
//! 1. **Rust → UI.** [`catalog_matches_committed_ui_copy`] regenerates the
//!    catalogue in memory and byte-compares it with the committed copy
//!    (`include_str!`), so a code/severity/applicability change in the
//!    validator fails the server test until the copy is regenerated — the
//!    same regen-with-parity shape as the OpenAPI client.
//! 2. **UI → Rust.** The UI test (`txrhelp/content.test.ts`) reads the SAME
//!    committed copy (not a second table), so the two sides share one byte
//!    file; the authored prose (meaning, action, plain title) lives beside it
//!    in `content.ts` keyed by code, and a code the catalogue does not have
//!    is a TypeScript error.
//!
//! Regeneration (the only writer):
//!
//! ```text
//! TXRESBENCH_CATALOG_REGEN=1 cargo test -p cytoanalyst --lib \
//!   -- file_validator::catalog::catalog_roundtrip_and_committed_copy
//! ```
//! (the `scripts/file-validator/gen_help_catalog.sh` wrapper — every process
//! through `ops/cap.sh` with CAP_CPUS=2 on the shared box).

use serde::{Deserialize, Serialize};

use super::rules::{app_rule_declarations, rule_declarations};
use super::types::ProblemSeverity;

/// The severity the Help page presents a code under. The two wire severities
/// plus the one DUAL code (A04: mixed units is the error, a scale that
/// differs or cannot be classed is the warning — `units.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogSeverity {
    Error,
    Warning,
    ErrorOrWarning,
}

/// Whether the app ever reports the code (the Help page's "not reported by
/// the app" group): `reported` = an emit, `holds_by_construction` = the
/// check runs and no problem can fire, `not_applicable` = the rule has no
/// object in the app's shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogApplicability {
    Reported,
    HoldsByConstruction,
    NotApplicable,
}

impl From<super::rules::RuleApplicability> for CatalogApplicability {
    fn from(value: super::rules::RuleApplicability) -> Self {
        match value {
            super::rules::RuleApplicability::Implemented => CatalogApplicability::Reported,
            super::rules::RuleApplicability::HoldsByConstruction(_) => {
                CatalogApplicability::HoldsByConstruction
            },
            super::rules::RuleApplicability::NotApplicable(_) => CatalogApplicability::NotApplicable,
        }
    }
}

/// One catalogue entry — the machine facts of one problem code. The prose
/// (plain title, meaning, action) is authored in the UI's `content.ts`;
/// every fact that must not drift lives here, generated from the validator's
/// own declaration tables.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// The wire code (`"R03"`).
    pub code: String,
    /// The tidy rule id for R-codes (`"R02_required_columns"`); `null` for
    /// the app-only codes.
    pub rule_id: Option<String>,
    /// The severity presented in Help.
    pub severity: CatalogSeverity,
    /// Whether the app reports the code.
    pub applicability: CatalogApplicability,
}

fn severity_of(problem: ProblemSeverity) -> CatalogSeverity {
    match problem {
        ProblemSeverity::Error => CatalogSeverity::Error,
        ProblemSeverity::Warning => CatalogSeverity::Warning,
    }
}

/// The full catalogue, in `ProblemCode::ALL` order (R01–R21 then A01–A07) —
/// one entry per closed code, derived entirely from the declaration tables.
pub fn catalog() -> Vec<CatalogEntry> {
    let mut out = Vec::with_capacity(28);
    for rule in rule_declarations() {
        out.push(CatalogEntry {
            code: rule.code.code().to_string(),
            rule_id: Some(rule.rule_id.to_string()),
            severity: severity_of(rule.severity),
            applicability: rule.applicability.clone().into(),
        });
    }
    for rule in app_rule_declarations() {
        out.push(CatalogEntry {
            code: rule.code.code().to_string(),
            rule_id: None,
            severity: if rule.dual_severity {
                CatalogSeverity::ErrorOrWarning
            } else {
                severity_of(rule.severity.expect("a non-dual code has one severity"))
            },
            applicability: rule.applicability.clone().into(),
        });
    }
    out
}

/// The catalogue as the committed JSON bytes (pretty, trailing newline).
pub fn catalog_json() -> String {
    let mut json = serde_json::to_string_pretty(&catalog()).expect("catalogue serializes");
    json.push('\n');
    json
}

/// The committed copy's path (the UI's own file — regenerated, never edited
/// by hand).
fn committed_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../ui/src/modules/txrhelp/validator-catalog.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::file_validator::types::ProblemCode;

    /// TEST-QF2-2 (node half): the catalogue covers the closed vocabulary in
    /// order, every code once, and every code's severity/applicability is the
    /// declared one.
    #[test]
    fn catalog_is_the_closed_vocabulary_in_order() {
        let entries = catalog();
        let expected: Vec<&str> = ProblemCode::ALL.iter().map(|c| c.code()).collect();
        let codes: Vec<&str> = entries.iter().map(|e| e.code.as_str()).collect();
        assert_eq!(codes, expected, "28 codes, in ProblemCode::ALL order");
        assert_eq!(entries.len(), 28);
        // The by-construction / not-applicable set — the Help page's "not
        // reported by the app" group (R2-H8: R10 is by construction, the
        // feature list is folded from the measurement rows themselves).
        let never: Vec<&str> = entries
            .iter()
            .filter(|e| e.applicability != CatalogApplicability::Reported)
            .map(|e| e.code.as_str())
            .collect();
        assert_eq!(
            never,
            vec!["R01", "R09", "R10", "R11", "R16", "R17", "R21"]
        );
        // A04 is the one dual-severity code (mixed units error, scale
        // mismatch warning — units.rs), the rest carry one severity.
        let dual: Vec<&str> = entries
            .iter()
            .filter(|e| e.severity == CatalogSeverity::ErrorOrWarning)
            .map(|e| e.code.as_str())
            .collect();
        assert_eq!(dual, vec!["A04"]);
        let errors: Vec<&str> = entries
            .iter()
            .filter(|e| e.severity == CatalogSeverity::Error && e.applicability == CatalogApplicability::Reported)
            .map(|e| e.code.as_str())
            .collect();
        assert_eq!(
            errors,
            vec![
                "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R12", "R13",
                "R15", "R18", "A01", "A02"
            ]
        );
        let warnings: Vec<&str> = entries
            .iter()
            .filter(|e| e.severity == CatalogSeverity::Warning && e.applicability == CatalogApplicability::Reported)
            .map(|e| e.code.as_str())
            .collect();
        assert_eq!(
            warnings,
            vec!["R14", "R19", "R20", "A03", "A05", "A06", "A07"]
        );
    }

    /// The two-sided drift pin: the committed UI copy IS the catalogue —
    /// regenerate with `TXRESBENCH_CATALOG_REGEN=1` (the
    /// `scripts/file-validator/gen_help_catalog.sh` wrapper) after a
    /// validator declaration change, then commit both; the failure message
    /// says exactly that.
    #[test]
    fn catalog_roundtrip_and_committed_copy() {
        let generated = catalog_json();
        let committed = include_str!(
            "../../../../ui/src/modules/txrhelp/validator-catalog.json"
        );
        if std::env::var_os("TXRESBENCH_CATALOG_REGEN").is_some() {
            std::fs::write(committed_path(), &generated).expect("write the catalogue copy");
            return;
        }
        assert_eq!(
            generated,
            committed,
            "the committed Help catalogue drifted from the validator's \
             declaration tables — run \
             scripts/file-validator/gen_help_catalog.sh and commit the \
             regenerated src-app/ui/src/modules/txrhelp/validator-catalog.json \
             with the validator change"
        );
    }

    /// The catalogue serializes deterministically (a rerun's bytes equal the
    /// first run's — the committed copy cannot churn).
    #[test]
    fn catalog_json_is_deterministic() {
        assert_eq!(catalog_json(), catalog_json());
        let parsed: Vec<CatalogEntry> =
            serde_json::from_str(&catalog_json()).expect("the catalogue parses back");
        assert_eq!(parsed, catalog());
    }
}
