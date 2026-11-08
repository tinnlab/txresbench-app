//! Unit normalization, family classification and vocabulary comparison —
//! `units.rs` (ITEM-4; PROV-FV-5's `infer_unit_family`) — the unit half of the
//! file layer (DEC-10).
//!
//! The unit family vocabulary is the PROVIDER's own closed enum (PROV-MC-4:
//! `concentration_mass`, `concentration_molar`, `count`, `percent`, `ratio`,
//! `detection`, `none`); the classifier below emits only those values and
//! never declares a family of its own. `none` is the honest no-claim:
//! both sides of the eligibility engine's UNIT_MISMATCH check must be KNOWN
//! families, so an unclassifiable unit cannot cause a false mismatch — the
//! file layer reports a warning instead (DEC-10).
//!
//! ## The four unit checks (EXAMPLE-FV-2 / TEST-FV-8's unit path)
//!
//! 1. **Constant column.** A marker's unit column must be one unit
//!    (normalization folds case, whitespace and `µ`/`μ` → `u`, so `U/L` and
//!    ` u/L ` are one unit) — else the A04 ERROR naming every row of every
//!    spelling ([`unit_mixed_problem`]).
//! 2. **Absent column.** No unit cell at all → A07 (the vocabulary scale
//!    cannot be checked — [`unit_absent_problem`]; the A07 check applies to a
//!    vocabulary-matched marker, per the closed A07 definition).
//! 3. **Vocabulary comparison.** For a vocabulary-matched marker the
//!    `canonical_unit` + `unit_family` of the entry are authoritative; the
//!    user unit compares to them — textual equality is `Matches` (no
//!    problem), the same known family is `Family`, anything else `Unknown`.
//!    Every non-`Matches` verdict is the A04 WARNING
//!    ([`unit_mismatch_problem`]): the closed problem-code set carries ONE
//!    unit-difference code (A04), so the mixed case is A04-error and the
//!    mismatch case is A04-warning, distinguished by severity and message.
//! 4. **Unclassifiable unit.** An unmapped marker whose unit the classifier
//!    cannot place gets family `none` + the A04 warning
//!    ([`unit_unclassified_problem`]) — no scale is assumed, so no false
//!    mismatch.
//!
//! All functions are pure and deterministic (input order in, output order
//! out).

use crate::modules::file_validator::types::{FileProblem, ProblemCode, ProblemSeverity, UnitFamily};

/// A volume denominator symbol (normalized): the `/L`-family scale
/// denominators of clinical measurements.
const VOLUME_SYMBOLS: &[&str] = &["l", "ml", "dl", "ul", "cl"];

/// A mass numerator symbol (normalized; `mcg` is the `µg` spelling).
const MASS_SYMBOLS: &[&str] = &["g", "mg", "ug", "mcg", "ng", "pg", "fg", "kg"];

/// A molar numerator symbol (normalized).
const MOLAR_SYMBOLS: &[&str] = &["mol", "mmol", "umol", "nmol", "pmol", "fmol"];

/// The exact normalized spellings of a detection-call unit column.
const DETECTION_SPELLINGS: &[&str] = &[
    "present",
    "absent",
    "detected",
    "not detected",
    "positive",
    "negative",
    "det",
    "pos",
    "neg",
];

/// The exact normalized spellings of a ratio/dimensionless unit column.
const RATIO_SPELLINGS: &[&str] = &[
    "ratio",
    "fold change",
    "fold-change",
    "fold",
    "relative change",
    "relative",
    "unitless",
    "dimensionless",
];

// ─────────────────────────────────────────────────────────────────────────────
// Normalization (DEC-10: case, whitespace, µ-vs-u)
// ─────────────────────────────────────────────────────────────────────────────

/// Fold a unit string for comparison: trim, collapse whitespace runs,
/// case-fold, and fold the two Unicode micro spellings (`µ` U+00B5 and `μ`
/// U+03BC) onto `u` — `U/L` and ` u/L ` read `u/l`; `µg/mL` and `ug/ml` read
/// `ug/ml`.
pub fn normalize_unit(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        match c {
            '\u{00B5}' | '\u{03BC}' => {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push('u');
            }
            c if c.is_whitespace() => {
                if !out.is_empty() {
                    pending_space = true;
                }
            }
            c => {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                for lower in c.to_lowercase() {
                    out.push(lower);
                }
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// The family classifier (PROV-MC-4's seven families; conservative by design)
// ─────────────────────────────────────────────────────────────────────────────

/// The small family classifier (DEC-10, PROV-FV-5's seam). Recognition rule,
/// on the normalized string: a `%`-bearing or percent word is `percent`; an
/// exact detection spelling is `detection`; an exact ratio spelling is
/// `ratio`; a `<numerator>/<volume>` concentration is `concentration_molar`
/// (molar numerator), `concentration_mass` (mass numerator) or `count` (any
/// other per-volume numerator — enzyme activity `U/L` is the board's case);
/// everything else is `none` (no family claim).
pub fn infer_unit_family(unit: &str) -> UnitFamily {
    let normalized = normalize_unit(unit);
    if normalized.is_empty() {
        return UnitFamily::None;
    }
    if normalized.contains('%') || matches!(normalized.as_str(), "percent" | "pct" | "percentage")
    {
        return UnitFamily::Percent;
    }
    if DETECTION_SPELLINGS.contains(&normalized.as_str()) {
        return UnitFamily::Detection;
    }
    if RATIO_SPELLINGS.contains(&normalized.as_str()) {
        return UnitFamily::Ratio;
    }
    let parts: Vec<&str> = normalized.split('/').map(str::trim).collect();
    match parts.as_slice() {
        [numerator, denominator] if VOLUME_SYMBOLS.contains(denominator) => {
            if MOLAR_SYMBOLS.contains(numerator) {
                UnitFamily::ConcentrationMolar
            } else if MASS_SYMBOLS.contains(numerator) {
                UnitFamily::ConcentrationMass
            } else {
                // Per-volume activity/count/other (U/L, IU/L, cells/µL,
                // 10^9/L): things per litre.
                UnitFamily::Count
            }
        }
        // A bare "/L" (per litre) reaches the count arm above (empty
        // numerator, volume denominator).
        ["count"] | ["counts"] | ["cells"] | ["number"] => UnitFamily::Count,
        // A bare mass/molar/volume symbol is a quantity, not a concentration;
        // a rate (ml/min) or a mixed form (mg/g) is not a known family
        // either — no family claim.
        _ => UnitFamily::None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary comparison (DEC-10: matches / family / unknown)
// ─────────────────────────────────────────────────────────────────────────────

/// The agreement between a file's unit and the vocabulary's unit facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitAgreement {
    /// The normalized texts are equal.
    Matches,
    /// The texts differ but both sides classify to the same KNOWN family
    /// (the family is the classifier's verdict).
    Family(UnitFamily),
    /// Text differs and no common known family exists (a different known
    /// family, an unclassifiable side, or no canonical unit): the honest
    /// no-claim verdict.
    Unknown,
}

/// Compare a file's unit to a vocabulary entry's unit facts (DEC-10: the
/// entry is authoritative). The family compare uses the entry's declared
/// family when it is known; when the entry declares `none` with a
/// `canonical_unit`, the classifier runs on the canonical unit (the board's
/// LDH entry declares `none` + `U/L` — the family compare must still work).
pub fn compare_unit_to_canonical(
    user_unit: &str,
    canonical_unit: &str,
    canonical_family: UnitFamily,
) -> UnitAgreement {
    let user = normalize_unit(user_unit);
    let canonical = normalize_unit(canonical_unit);
    if !user.is_empty() && !canonical.is_empty() && user == canonical {
        return UnitAgreement::Matches;
    }
    let user_family = infer_unit_family(user_unit);
    let effective_canonical_family = if canonical_family != UnitFamily::None {
        canonical_family
    } else {
        infer_unit_family(canonical_unit)
    };
    if user_family != UnitFamily::None
        && effective_canonical_family != UnitFamily::None
        && user_family == effective_canonical_family
    {
        return UnitAgreement::Family(user_family);
    }
    UnitAgreement::Unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-marker column facts (the A04/A07 inputs)
// ─────────────────────────────────────────────────────────────────────────────

/// One distinct normalized unit spelling of a marker column, with the FILE
/// rows that carry it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitSpelling {
    /// The FIRST raw spelling seen (the message copy).
    pub spelling: String,
    pub normalized: String,
    pub rows: Vec<u32>,
}

/// The unit facts of one marker column (DEC-10's constant-absent-classify
/// inputs; blank cells are skipped — a nullable unit cell is not a spelling).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerUnitFacts {
    /// Distinct normalized units, first-appearance order.
    pub distinct: Vec<UnitSpelling>,
    /// Non-blank unit cells.
    pub non_null: u32,
}

impl MarkerUnitFacts {
    /// No unit cell at all (the A07 condition).
    pub fn is_absent(&self) -> bool {
        self.distinct.is_empty()
    }

    /// Zero or one distinct unit (zero is absent; one is constant).
    pub fn is_constant(&self) -> bool {
        self.distinct.len() <= 1
    }

    /// The single unit spelling when the column is constant (absent and mixed
    /// return `None`).
    pub fn the_unit(&self) -> Option<&UnitSpelling> {
        if self.distinct.len() == 1 {
            Some(&self.distinct[0])
        } else {
            None
        }
    }
}

/// Collect one marker column's unit cells (raw text, FILE row) into
/// [`MarkerUnitFacts`]; input order expected in FILE row order.
pub fn marker_unit_facts<'a, I>(cells: I) -> MarkerUnitFacts
where
    I: IntoIterator<Item = (&'a str, u32)>,
{
    let mut distinct: Vec<UnitSpelling> = Vec::new();
    let mut non_null = 0u32;
    for (raw, row) in cells {
        let normalized = normalize_unit(raw);
        if normalized.is_empty() {
            continue;
        }
        non_null += 1;
        match distinct.iter_mut().find(|u| u.normalized == normalized) {
            Some(u) => u.rows.push(row),
            None => distinct.push(UnitSpelling {
                spelling: raw.to_string(),
                normalized,
                rows: vec![row],
            }),
        }
    }
    for spelling in &mut distinct {
        spelling.rows.sort_unstable();
    }
    MarkerUnitFacts { distinct, non_null }
}

// ─────────────────────────────────────────────────────────────────────────────
// The problems (A04 error / A04 warning / A07 warning; the closed code set
// keeps ONE unit-difference code — see the module doc)
// ─────────────────────────────────────────────────────────────────────────────

fn join_rows(rows: &[u32]) -> String {
    let mut out = String::new();
    for (i, r) in rows.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&r.to_string());
    }
    out
}

/// The A04 ERROR for a marker column that mixes units: every distinct spelling
/// and its rows are named (EXAMPLE-FV-2). `None` for a constant/absent column.
pub fn unit_mixed_problem(column: &str, facts: &MarkerUnitFacts) -> Option<FileProblem> {
    if facts.distinct.len() <= 1 {
        return None;
    }
    let list = facts
        .distinct
        .iter()
        .map(|u| format!("'{}' (rows {})", u.spelling, join_rows(&u.rows)))
        .collect::<Vec<_>>()
        .join("; ");
    Some(FileProblem::new(
        ProblemCode::A04UnitDiffers,
        ProblemSeverity::Error,
        None,
        Some(column.to_string()),
        format!(
            "column `{column}` mixes units: {list} — one marker column carries one unit"
        ),
    ))
}

/// The A04 WARNING for a vocabulary-matched marker whose unit does not match
/// the vocabulary's unit (DEC-10: `family` and no-agreement verdicts are
/// warnings; the message says which).
pub fn unit_mismatch_problem(
    column: &str,
    user_unit: &str,
    canonical_unit: &str,
    agreement: UnitAgreement,
) -> FileProblem {
    let agreement_text = match agreement {
        UnitAgreement::Family(_) => "the unit agrees only by unit family",
        UnitAgreement::Unknown => "the unit has no unit-family agreement",
        UnitAgreement::Matches => {
            "the unit matches — no problem"
        }
    };
    // The vocabulary entry's canonical unit is not always recorded: an empty
    // string rendered inside the quotes would read "vocabulary unit ''" — a
    // bug-shaped blank (qa-fixes ITEM-5, RES-24). The empty case names the
    // vocabulary without quoting a non-fact.
    let message = if canonical_unit.trim().is_empty() {
        format!(
            "column `{column}` unit '{user_unit}' differs from the vocabulary unit: {agreement_text}"
        )
    } else {
        format!(
            "column `{column}` unit '{user_unit}' differs from the vocabulary unit '{canonical_unit}': {agreement_text}"
        )
    };
    FileProblem::new(
        ProblemCode::A04UnitDiffers,
        ProblemSeverity::Warning,
        None,
        Some(column.to_string()),
        message,
    )
}

/// The A04 WARNING for a unit the classifier cannot place (the unmapped-marker
/// path: family `none`, no scale assumed — DEC-10).
pub fn unit_unclassified_problem(column: &str, unit: &str) -> FileProblem {
    FileProblem::new(
        ProblemCode::A04UnitDiffers,
        ProblemSeverity::Warning,
        None,
        Some(column.to_string()),
        format!(
            "column `{column}` unit '{unit}' is not a recognizable unit family — no scale assumption is made"
        ),
    )
}

/// The A07 WARNING for a vocabulary-matched marker whose unit column is empty
/// (the vocabulary scale cannot be checked — DEC-10's never-silent rule).
pub fn unit_absent_problem(column: &str) -> FileProblem {
    FileProblem::new(
        ProblemCode::A07UnitAbsent,
        ProblemSeverity::Warning,
        None,
        Some(column.to_string()),
        format!(
            "column `{column}` carries no unit — the scale cannot be checked against the vocabulary"
        ),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the unit path (TEST-FV-8's unit facts, pinned hermetically)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fv8_unit_normalization_folds_case_space_and_micro() {
        assert_eq!(normalize_unit("U/L"), "u/l");
        assert_eq!(normalize_unit(" u/L "), "u/l");
        assert_eq!(normalize_unit("µg/mL"), "ug/ml");
        assert_eq!(normalize_unit("μg/mL"), "ug/ml"); // U+03BC
        assert_eq!(normalize_unit("u g / m L"), "u g / m l");
    }

    #[test]
    fn test_fv8_family_classifier_covers_the_board_cases() {
        use UnitFamily::*;
        for (unit, expect) in [
            ("ng/mL", ConcentrationMass),
            ("mg/dL", ConcentrationMass),
            ("g/L", ConcentrationMass),
            ("µg/mL", ConcentrationMass),
            ("mmol/L", ConcentrationMolar),
            ("umol/L", ConcentrationMolar),
            ("U/L", Count),
            ("U/mL", Count),
            ("cells/µL", Count),
            ("10^9/L", Count),
            ("/L", Count),
            ("%", Percent),
            ("percent", Percent),
            ("ratio", Ratio),
            ("fold change", Ratio),
            ("detected", Detection),
            ("positive", Detection),
            ("a.u.", None),
            ("furlongs", None),
            ("", None),
        ] {
            assert_eq!(infer_unit_family(unit), expect, "unit {unit:?}");
        }
    }

    #[test]
    fn test_fv8_ldh_u_per_l_matches_and_u_per_ml_is_family() {
        // The board's LDH case against the vocabulary entry facts (family
        // `none` + canonical `U/L` — the LDH entry's actual declared facts).
        assert_eq!(
            compare_unit_to_canonical("U/L", "U/L", UnitFamily::None),
            UnitAgreement::Matches
        );
        assert_eq!(
            compare_unit_to_canonical("U/mL", "U/L", UnitFamily::None),
            UnitAgreement::Family(UnitFamily::Count)
        );
    }

    #[test]
    fn test_fv8_ng_per_ml_family_matches_against_the_declared_family() {
        assert_eq!(
            compare_unit_to_canonical(
                "µg/mL",
                "ng/mL",
                UnitFamily::ConcentrationMass
            ),
            UnitAgreement::Family(UnitFamily::ConcentrationMass)
        );
        assert_eq!(
            compare_unit_to_canonical("%", "ng/mL", UnitFamily::ConcentrationMass),
            UnitAgreement::Unknown,
            "a different known family is the no-claim verdict"
        );
        assert_eq!(
            compare_unit_to_canonical("ng/mL", "", UnitFamily::None),
            UnitAgreement::Unknown,
            "no canonical unit and no family → no claim"
        );
    }

    #[test]
    fn test_fv8_constant_check_folds_spellings_and_reports_mixed_rows() {
        let constant = marker_unit_facts(vec![("U/L", 3), (" u/L ", 4), ("U/l", 5)]);
        assert!(constant.is_constant());
        assert_eq!(constant.non_null, 3);
        assert!(constant.the_unit().is_some());
        assert_eq!(
            constant.the_unit().unwrap().rows,
            vec![3, 4, 5],
            "case variants are ONE unit"
        );

        let mixed = marker_unit_facts(vec![("U/L", 3), ("U/mL", 4), ("U/L", 5), ("", 6)]);
        assert!(!mixed.is_constant());
        assert_eq!(mixed.distinct.len(), 2);
        assert_eq!(mixed.distinct[0].rows, vec![3, 5]);
        assert_eq!(mixed.distinct[1].rows, vec![4]);
        // The blank cell is not a unit spelling.
        assert_eq!(mixed.non_null, 3);
    }

    #[test]
    fn test_fv8_absent_column_is_absent_without_distinct_spellings() {
        let absent = marker_unit_facts(vec![("", 3), ("", 4)]);
        assert!(absent.is_absent());
        assert!(absent.is_constant());
        assert!(absent.the_unit().is_none());
    }

    #[test]
    fn test_fv8_mixed_problem_is_a04_error_naming_the_rows() {
        let mixed = marker_unit_facts(vec![("U/L", 3), ("U/mL", 4), ("U/L", 5)]);
        let problem = unit_mixed_problem("unit", &mixed).expect("mixed column reports");
        assert_eq!(problem.code, ProblemCode::A04UnitDiffers);
        assert_eq!(problem.severity, ProblemSeverity::Error);
        assert_eq!(problem.column.as_deref(), Some("unit"));
        assert!(problem.message.contains("rows 3, 5"), "{}", problem.message);
        assert!(problem.message.contains("rows 4"), "{}", problem.message);
        assert!(problem.message.contains("'U/L'"), "{}", problem.message);

        let constant = marker_unit_facts(vec![("U/L", 3)]);
        assert!(unit_mixed_problem("unit", &constant).is_none());
    }

    #[test]
    fn test_fv8_mismatch_and_unclassified_warnings_are_a04_warning() {
        let family = unit_mismatch_problem(
            "unit",
            "U/mL",
            "U/L",
            UnitAgreement::Family(UnitFamily::Count),
        );
        assert_eq!(family.code, ProblemCode::A04UnitDiffers);
        assert_eq!(family.severity, ProblemSeverity::Warning);
        assert!(family.message.contains("U/mL"), "{}", family.message);
        assert!(family.message.contains("only by unit family"), "{}", family.message);

        let unknown = unit_mismatch_problem(
            "unit",
            "%",
            "ng/mL",
            UnitAgreement::Unknown,
        );
        assert_eq!(unknown.code, ProblemCode::A04UnitDiffers);
        assert!(unknown.message.contains("no unit-family agreement"), "{}", unknown.message);

        let unclassified = unit_unclassified_problem("unit", "furlongs");
        assert_eq!(unclassified.code, ProblemCode::A04UnitDiffers);
        assert_eq!(unclassified.severity, ProblemSeverity::Warning);
        assert!(unclassified.message.contains("furlongs"), "{}", unclassified.message);
    }

    #[test]
    fn test_fv8_mismatch_with_unrecorded_canonical_unit_quotes_nothing() {
        // A vocabulary-matched marker whose vocabulary entry records no
        // canonical unit: the message must not quote a blank ('' — the
        // qa-fixes ITEM-5 RES-24 shape); it names the vocabulary without
        // a non-fact and keeps the agreement verdict.
        let problem = unit_mismatch_problem("ctdna", "ng/mL", "", UnitAgreement::Unknown);
        assert_eq!(problem.code, ProblemCode::A04UnitDiffers);
        assert_eq!(problem.severity, ProblemSeverity::Warning);
        assert!(
            problem.message.contains("unit 'ng/mL' differs from the vocabulary unit"),
            "{}",
            problem.message
        );
        assert!(
            problem.message.contains("no unit-family agreement"),
            "{}",
            problem.message
        );
        assert!(!problem.message.contains("''"), "{}", problem.message);
    }

    #[test]
    fn test_fv8_absent_unit_of_a_vocabulary_matched_marker_is_a07() {
        let problem = unit_absent_problem("unit");
        assert_eq!(problem.code, ProblemCode::A07UnitAbsent);
        assert_eq!(problem.severity, ProblemSeverity::Warning);
        assert_eq!(problem.row, None);
    }

    #[test]
    fn test_fv8_unit_facts_are_deterministic() {
        let cells = vec![("U/L", 3), ("U/mL", 4), ("U/L", 5)];
        assert_eq!(marker_unit_facts(cells.iter().copied()), marker_unit_facts(cells));
    }
}
