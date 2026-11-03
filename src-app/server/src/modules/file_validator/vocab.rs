//! Marker vocabulary matching and spelling-variant grouping — `vocab.rs`
//! (ITEM-4; PROV-FV-5's `marker_matches`) — the join-offer half of the file
//! layer, over the provider's vocabulary ([`method_catalogue`]'s
//! `marker_vocabulary()`, CONS-FV-1).
//!
//! Two facts this module owns:
//!
//! - **The matching ladder is exact → alias → standard id → fuzzy** (DEC-12).
//!   Each vocabulary entry appears at most once per name, with its
//!   highest-precedence match kind; fuzzy is a capped suggestion list (A05
//!   truncation), never a match of the same standing.
//! - **Matching is descriptive only.** A [`MarkerMatchSet`] answers "this file
//!   column LOOKS LIKE X". There is no apply function in this module at all:
//!   the user's confirmation travels as `joins[]` / `mapping[]` in the
//!   validate request and is applied by the validate engine (ITEM-5). A wrong
//!   auto-join silently changes the data a method sees, so the design makes
//!   the join impossible to mistake for a match (DEC-12).
//!
//! ## Standard-id detection in the raw name
//!
//! CONS-FV-1's `parse_standard_ids` is the provider's port of the benchmark's
//! `data.py` function: LOINC codes are extracted from clauses that carry the
//! `LOINC` keyword (data.py's own rule — a curated `standard_id` text says
//! "LOINC 2039-6"). A clinician's marker name is free text and usually carries
//! no keyword, so this module complements the provider call with a bare
//! LOINC-code scan of the raw name (`"CEA (2039-6)"` → `2039-6`). Both sets
//! are matched case-insensitively against the vocabulary ids (the provider's
//! own "matching is case-insensitive" rule). The complement is recorded in
//! DRIFT-1 ITEM-4: the provider function alone does not extract the bare
//! parenthesized code.
//!
//! ## Fuzzy containment
//!
//! A fuzzy suggestion is a vocabulary entry whose *display name* contains the
//! file name (or is contained by it), with the file name at least
//! [`Limits::MIN_FUZZY_MATCH_LEN`] characters long; at most
//! [`Limits::MAX_FUZZY_CANDIDATES`] are returned and the truncation is
//! reported (`A05`). Aliases are exact-alias territory, not fuzzy targets.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::modules::file_validator::types::{Limits, MarkerMatch, MatchKind};
use crate::modules::method_catalogue::catalogue::marker_vocabulary;
use crate::modules::method_catalogue::eligibility::parse_standard_ids;
use crate::modules::method_catalogue::types::VocabularyMarker;

/// A LOINC-code-shaped token (`NNNNN-N`) in a raw marker name — the bare scan
/// complement of the provider's keyword-gated extraction (see the module doc;
/// the shape is the provider's own `LOINC_CODE_PATTERN`).
const BARE_LOINC_CODE_PATTERN: &str = r"\b\d{2,6}-\d{1,2}\b";

static BARE_LOINC_CODE: OnceLock<Regex> = OnceLock::new();

fn bare_loinc_code() -> &'static Regex {
    BARE_LOINC_CODE.get_or_init(|| {
        Regex::new(BARE_LOINC_CODE_PATTERN).expect("static bare-LOINC pattern is valid")
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Name folding (DEC-12: trim, collapse whitespace, case-fold)
// ─────────────────────────────────────────────────────────────────────────────

/// Fold a marker name for spelling-variant grouping and vocabulary comparison:
/// trim, collapse whitespace runs, case-fold. Deliberately does NOT fold
/// `_`/`-` (unlike the header alias folding in `rules.rs`): marker names are
/// identifiers, and `ctDNA__detected` is not `ctDNA detected`.
pub fn normalize_marker_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_space = false;
    for c in name.chars() {
        if c.is_whitespace() {
            if !out.is_empty() {
                pending_space = true;
            }
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            for lower in c.to_lowercase() {
                out.push(lower);
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Spelling-variant grouping (A03, EXAMPLE-FV-1)
// ─────────────────────────────────────────────────────────────────────────────

/// One marker spelling of a file's marker column, with the FILE rows that
/// carry it (the A03 message's row evidence).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerSpelling {
    pub spelling: String,
    pub rows: Vec<u32>,
}

/// Group the marker spellings of one measurements table by normalized identity
/// (DEC-12): `ldh` and ` LDH ` are ONE logical marker column — the A03
/// variant group whose join is offered, never applied. Only groups with more
/// than one distinct raw spelling are returned (a single-spelling marker is
/// not a join offer); groups keep first-appearance order, as do the spellings
/// inside a group, and each spelling's rows are ascending.
///
/// Blank cells are skipped: a missing marker is the R04 report, not a spelling
/// variant. The input is expected in FILE row order.
pub fn marker_spelling_groups<'a, I>(markers: I) -> Vec<Vec<MarkerSpelling>>
where
    I: IntoIterator<Item = (&'a str, u32)>,
{
    let mut groups: Vec<(String, Vec<MarkerSpelling>)> = Vec::new();
    for (raw, row) in markers {
        let normalized = normalize_marker_name(raw);
        if normalized.is_empty() {
            continue;
        }
        match groups.iter_mut().find(|(key, _)| key == &normalized) {
            Some((_, spellings)) => {
                // Rows of the SAME raw spelling accumulate on that spelling
                // (a spelling interrupted by its variant stays one entry).
                if let Some(spelling) = spellings.iter_mut().find(|s| s.spelling == raw) {
                    spelling.rows.push(row);
                } else {
                    spellings.push(MarkerSpelling {
                        spelling: raw.to_string(),
                        rows: vec![row],
                    });
                }
            }
            None => groups.push((
                normalized,
                vec![MarkerSpelling {
                    spelling: raw.to_string(),
                    rows: vec![row],
                }],
            )),
        }
    }
    groups
        .into_iter()
        .filter(|(_, spellings)| spellings.len() > 1)
        .map(|(_, spellings)| {
            let mut spellings = spellings;
            for spelling in &mut spellings {
                spelling.rows.sort_unstable();
            }
            spellings
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// The match ladder (DEC-12: exact → alias → standard id → fuzzy)
// ─────────────────────────────────────────────────────────────────────────────

/// The complete candidate set for one file marker name: the ladder matches
/// first (exact, then alias, then standard id — each entry at most once, with
/// its best kind), then the capped fuzzy suggestions. `fuzzy_total` /
/// `fuzzy_truncated` carry the A05 fact (more fuzzy candidates existed than
/// [`Limits::MAX_FUZZY_CANDIDATES`]).
#[derive(Debug, Clone, serde::Serialize)]
pub struct MarkerMatchSet {
    pub matches: Vec<MarkerMatch>,
    /// How many fuzzy candidates existed before the cap.
    pub fuzzy_total: usize,
    /// More fuzzy candidates were cut than returned (the A05 condition).
    pub fuzzy_truncated: bool,
}

/// The vocabulary candidates for a marker name (PROV-FV-5's in-process seam) —
/// the provider's loaded vocabulary, one call from the join-offer rendering.
/// Suggestions only; nothing is applied (see the module doc).
pub fn marker_matches(name: &str) -> Vec<MarkerMatch> {
    marker_matches_set(name).matches
}

/// [`marker_matches`] plus the A05 truncation facts.
pub fn marker_matches_set(name: &str) -> MarkerMatchSet {
    marker_matches_in(marker_vocabulary(), name)
}

/// The pure core: the ladder over an explicit vocabulary slice (the fixture
/// tests bind it to a hermetic vocabulary; `marker_matches_set` passes the
/// provider's loaded one).
pub fn marker_matches_in(vocabulary: &[VocabularyMarker], name: &str) -> MarkerMatchSet {
    let normalized = normalize_marker_name(name);
    let std_ids = standard_ids_in(name);

    let mut exact: Vec<&VocabularyMarker> = Vec::new();
    let mut aliases: Vec<&VocabularyMarker> = Vec::new();
    let mut std: Vec<&VocabularyMarker> = Vec::new();
    let mut fuzzy: Vec<&VocabularyMarker> = Vec::new();

    for entry in vocabulary {
        let display = normalize_marker_name(&entry.display_name);
        if display == normalized {
            exact.push(entry);
        } else if entry
            .aliases
            .iter()
            .any(|alias| normalize_marker_name(alias) == normalized)
        {
            aliases.push(entry);
        } else if entry_has_standard_id(entry, &std_ids) {
            std.push(entry);
        } else if is_fuzzy_candidate(&normalized, &display) {
            fuzzy.push(entry);
        }
    }

    let mut matches = Vec::with_capacity(
        exact.len() + aliases.len() + std.len() + Limits::MAX_FUZZY_CANDIDATES,
    );
    matches.extend(exact.into_iter().map(|e| to_match(e, MatchKind::Exact)));
    matches.extend(aliases.into_iter().map(|e| to_match(e, MatchKind::Alias)));
    matches.extend(std.into_iter().map(|e| to_match(e, MatchKind::StandardId)));

    let fuzzy_total = fuzzy.len();
    matches.extend(
        fuzzy
            .iter()
            .take(Limits::MAX_FUZZY_CANDIDATES)
            .map(|e| to_match(e, MatchKind::Fuzzy)),
    );
    MarkerMatchSet {
        matches,
        fuzzy_total,
        fuzzy_truncated: fuzzy_total > Limits::MAX_FUZZY_CANDIDATES,
    }
}

/// The standard ids of a raw marker name: the provider's `parse_standard_ids`
/// (the keyword-gated parses of LOINC/HGNC/UniProt/HMDB/miRBase) plus the bare
/// LOINC-code scan (see the module doc). Everything is lower-cased for the
/// case-insensitive vocabulary id comparison.
fn standard_ids_in(name: &str) -> BTreeSet<String> {
    let mut ids: BTreeSet<String> = parse_standard_ids(name)
        .into_iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    for m in bare_loinc_code().find_iter(name) {
        ids.insert(m.as_str().to_ascii_lowercase());
    }
    ids
}

fn entry_has_standard_id(entry: &VocabularyMarker, ids: &BTreeSet<String>) -> bool {
    ids.contains(&entry.id.to_ascii_lowercase())
}

/// A fuzzy suggestion: the folded name is at least
/// [`Limits::MIN_FUZZY_MATCH_LEN`] characters long and one of the two folded
/// strings contains the other. An empty display (or an empty name) is never a
/// candidate.
fn is_fuzzy_candidate(name: &str, display: &str) -> bool {
    !name.is_empty()
        && !display.is_empty()
        && name.chars().count() >= Limits::MIN_FUZZY_MATCH_LEN
        && (name.contains(display) || display.contains(name))
}

fn to_match(entry: &VocabularyMarker, kind: MatchKind) -> MarkerMatch {
    MarkerMatch {
        marker_id: entry.id.clone(),
        system: entry.system.as_str().to_string(),
        display_name: entry.display_name.clone(),
        unit_family: entry.unit_family,
        canonical_unit: entry.canonical_unit.clone(),
        n_methods: entry.n_methods,
        match_kind: kind,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-FV-13 (the ITEM-4 matching suite). The vocabulary fixtures
// below are hermetic (the provider's real vocabulary is exercised by the
// smoke tests at the end, which bind CONS-FV-1's "carries 2039-6" to the
// shipped data).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::types::{MarkerSystem, UnitFamily};

    fn marker(
        id: &str,
        system: MarkerSystem,
        display_name: &str,
        aliases: &[&str],
        family: UnitFamily,
        canonical_unit: &str,
        n_methods: u32,
    ) -> VocabularyMarker {
        VocabularyMarker {
            id: id.to_string(),
            system,
            display_name: display_name.to_string(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            groups: Vec::new(),
            unit_family: family,
            canonical_unit: canonical_unit.to_string(),
            n_methods,
        }
    }

    fn fixture_vocabulary() -> Vec<VocabularyMarker> {
        vec![
            marker(
                "2039-6",
                MarkerSystem::Loinc,
                "carcinoembryonic antigen (CEA, ng/mL)",
                &["CEA", "serum_CEA"],
                UnitFamily::ConcentrationMass,
                "ng/mL",
                9,
            ),
            marker(
                "14804-9",
                MarkerSystem::Loinc,
                "LDH",
                &["serum lactate dehydrogenase (U/L)"],
                UnitFamily::None,
                "U/L",
                5,
            ),
            marker(
                "VEGFA",
                MarkerSystem::Hgnc,
                "vascular endothelial growth factor A",
                &["VEGF"],
                UnitFamily::None,
                "",
                3,
            ),
            marker(
                "CRP-MASS",
                MarkerSystem::Loinc,
                "c-reactive protein (CRP)",
                &["CRP"],
                UnitFamily::ConcentrationMass,
                "mg/L",
                2,
            ),
            marker(
                "9999-1",
                MarkerSystem::Other,
                "random marker alpha",
                &[],
                UnitFamily::None,
                "",
                0,
            ),
        ]
    }

    #[test]
    fn test_fv13_name_normalization_folds_case_and_space_only() {
        assert_eq!(normalize_marker_name("  LDH "), "ldh");
        assert_eq!(normalize_marker_name("ldh"), "ldh");
        assert_eq!(normalize_marker_name("cTDNA__detected"), "ctdna__detected");
        assert_eq!(
            normalize_marker_name("CEA   (ng/mL)"),
            "cea (ng/ml)"
        );
        // The underscore is an identifier character, never folded into a space.
        assert_ne!(normalize_marker_name("ctDNA__detected"), "ctdna  detected");
    }

    #[test]
    fn test_fv13_exact_display_name_match_is_case_folded() {
        let set = marker_matches_in(&fixture_vocabulary(), "ldh");
        assert_eq!(set.matches.len(), 1, "one exact entry: {set:?}");
        assert_eq!(set.matches[0].marker_id, "14804-9");
        assert_eq!(set.matches[0].system, "LOINC");
        assert_eq!(set.matches[0].match_kind, MatchKind::Exact);
        assert_eq!(set.matches[0].unit_family, UnitFamily::None);
        assert_eq!(set.matches[0].canonical_unit, "U/L");
        assert_eq!(set.matches[0].n_methods, 5);
    }

    #[test]
    fn test_fv13_alias_match_for_cea_spelling() {
        // "CEA" is an alias of 2039-6; folded case and surrounding spaces
        // must not defeat it.
        let set = marker_matches_in(&fixture_vocabulary(), "  cea ");
        assert_eq!(set.matches.len(), 1);
        assert_eq!(set.matches[0].marker_id, "2039-6");
        assert_eq!(set.matches[0].match_kind, MatchKind::Alias);
    }

    #[test]
    fn test_fv13_standard_id_in_parenthesized_name_via_bare_loinc_scan() {
        // "CEA (2039-6)" carries no LOINC keyword: the provider's
        // parse_standard_ids extracts nothing (pinned below), so the module's
        // bare scan is the path that finds the vocabulary id 2039-6.
        let via_provider = parse_standard_ids("CEA (2039-6)");
        assert!(
            via_provider.is_empty(),
            "the provider's parse needs the LOINC keyword — the bare scan is the complement: {via_provider:?}"
        );
        let set = marker_matches_in(&fixture_vocabulary(), "CEA (2039-6)");
        assert_eq!(set.matches.len(), 1, "one standard-id entry: {set:?}");
        assert_eq!(set.matches[0].marker_id, "2039-6");
        assert_eq!(set.matches[0].match_kind, MatchKind::StandardId);
    }

    #[test]
    fn test_fv13_standard_id_via_the_provider_parse_loinc_and_gene_clauses() {
        // The provider's own extraction path: the LOINC keyword makes the
        // code visible, and the `gene:` clause yields an HGNC id.
        let set = marker_matches_in(&fixture_vocabulary(), "CEA (LOINC 2039-6)");
        assert_eq!(set.matches.len(), 1);
        assert_eq!(set.matches[0].marker_id, "2039-6");
        assert_eq!(set.matches[0].match_kind, MatchKind::StandardId);

        let set = marker_matches_in(&fixture_vocabulary(), "gene: VEGFA");
        assert_eq!(set.matches.len(), 1, "gene clause: {set:?}");
        assert_eq!(set.matches[0].marker_id, "VEGFA");
        assert_eq!(set.matches[0].match_kind, MatchKind::StandardId);
    }

    #[test]
    fn test_fv13_spelling_variant_groups_ldh_and_LDH_with_rows() {
        let groups = marker_spelling_groups(vec![
            ("ldh", 3),
            ("LDH", 4),
            ("ldh", 5),
            ("M1", 6),
            ("ldh", 7),
        ]);
        assert_eq!(groups.len(), 1, "only the variant group is a join offer: {groups:?}");
        let group = &groups[0];
        assert_eq!(
            group.iter().map(|s| s.spelling.as_str()).collect::<Vec<_>>(),
            vec!["ldh", "LDH"],
            "first-appearance order, distinct raw spellings"
        );
        assert_eq!(group[0].rows, vec![3, 5, 7], "rows ascending");
        assert_eq!(group[1].rows, vec![4]);
    }

    #[test]
    fn test_fv13_fuzzy_requires_min_length_four_and_containment() {
        // "crp" is 3 characters — below MIN_FUZZY_MATCH_LEN — and the entry
        // has an alias match anyway; use a marker with no ladder match.
        let no_fuzzy = marker_matches_in(&fixture_vocabulary(), "mar");
        assert!(
            no_fuzzy.matches.iter().all(|m| m.match_kind != MatchKind::Fuzzy),
            "3-char names are never fuzzy suggestions: {no_fuzzy:?}"
        );

        let fuzzy = marker_matches_in(&fixture_vocabulary(), "marker");
        assert_eq!(fuzzy.matches.len(), 1);
        assert_eq!(fuzzy.matches[0].match_kind, MatchKind::Fuzzy);
        assert_eq!(fuzzy.matches[0].marker_id, "9999-1");
        assert!(!fuzzy.fuzzy_truncated);
    }

    #[test]
    fn test_fv13_fuzzy_containment_works_both_directions() {
        // The file name contains the display name ("c-reactive protein (CRP)"
        // inside "my c-reactive protein (CRP) today").
        let contained = marker_matches_in(&fixture_vocabulary(), "my c-reactive protein (CRP) today");
        assert!(
            contained.matches.iter().any(|m| m.marker_id == "CRP-MASS"
                && m.match_kind == MatchKind::Fuzzy),
            "containment either way: {contained:?}"
        );
    }

    #[test]
    fn test_fv13_fuzzy_list_is_capped_at_five_and_reports_truncation() {
        let mut vocabulary = fixture_vocabulary();
        // Seven entries whose display names contain "alpha" (plus the
        // fixture's "random marker alpha" — eight candidates for "alpha").
        for i in 0..7 {
            vocabulary.push(marker(
                &format!("ALPHA-{i}"),
                MarkerSystem::Other,
                &format!("alpha-marker number {i}"),
                &[],
                UnitFamily::None,
                "",
                0,
            ));
        }
        let set = marker_matches_in(&vocabulary, "alpha");
        assert!(
            set.fuzzy_total > Limits::MAX_FUZZY_CANDIDATES,
            "more candidates than the cap: {set:?}"
        );
        assert_eq!(set.matches.len(), Limits::MAX_FUZZY_CANDIDATES);
        assert!(set.fuzzy_truncated);
        assert!(set.matches.iter().all(|m| m.match_kind == MatchKind::Fuzzy));
    }

    #[test]
    fn test_fv13_a_matcher_is_pure_and_applies_nothing() {
        // A fuzzy suggestion is descriptive output: the same call twice is
        // byte-equal (no hidden state, no side effect), and the suggestion
        // carries `Fuzzy` — distinguishable from a ladder match, so the
        // caller's mapping gate stays the only applier. There is no function
        // in this module that takes a mapping (the module doc states it).
        let first = marker_matches_in(&fixture_vocabulary(), "marker");
        let second = marker_matches_in(&fixture_vocabulary(), "marker");
        // The wire rendering of the two calls is byte-equal (no hidden state,
        // no side effect).
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&second).unwrap()
        );
        assert!(first.matches[0].match_kind == MatchKind::Fuzzy);
    }

    #[test]
    fn test_fv13_one_entry_appears_once_with_its_best_kind() {
        // "CRP" is an alias AND the display "c-reactive protein (CRP)" contains
        // "crp"; the ladder must give the alias (not a fuzzy) and only once.
        let set = marker_matches_in(&fixture_vocabulary(), "CRP");
        assert_eq!(set.matches.len(), 1);
        assert_eq!(set.matches[0].marker_id, "CRP-MASS");
        assert_eq!(set.matches[0].match_kind, MatchKind::Alias);
    }

    /// Smoke tests against the provider's SHIPPED vocabulary (CONS-FV-1's
    /// assumed facts, bound to data): the real catalogue carries LOINC 2039-6
    /// and the LDH entry, and the file-layer entry points resolve them.
    #[test]
    fn test_fv13_real_vocabulary_carries_the_assumed_markers() {
        let cea = marker_matches("CEA (2039-6)");
        assert!(
            cea.iter().any(|m| m.marker_id == "2039-6"
                && m.system == "LOINC"
                && m.match_kind == MatchKind::StandardId),
            "2039-6 must be found in the shipped vocabulary: {cea:?}"
        );
        let ldh = marker_matches("ldh");
        assert!(
            ldh.iter()
                .any(|m| m.marker_id == "14804-9" && m.match_kind == MatchKind::Exact),
            "the board's LDH marker must resolve exactly: {ldh:?}"
        );
    }
}
