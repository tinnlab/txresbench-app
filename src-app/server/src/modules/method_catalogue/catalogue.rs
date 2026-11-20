//! The catalogue loader and its checks: [`parse_catalogue`] and the named
//! [`CatalogueLoadError`] refusals (PROV-MC-7's catalogue half).
//!
//! The catalogue is the `catalogue` half of the method list (`method_list`):
//! the app embeds only the method list's built-in copy (generated from the
//! benchmark tree by `scripts/method-catalogue/gen_method_catalogue.py` and
//! assembled in the methods repository, never read from the benchmark tree
//! at run time — INV-1) and may replace it, between runs, with a newer signed
//! list. A request or a run asks one `MethodList` snapshot for its methods
//! and markers (`MethodList::method`, `marker_vocabulary`,
//! `vocabulary_marker`). A first-party catalogue that fails to parse or
//! validate is a BOOT FAILURE (the extensions `_checked` posture, DEC-15):
//! the server refuses to serve rather than run with a silently empty or
//! half-understood catalogue.

use std::fmt;

use crate::modules::method_catalogue::types::{
    Catalogue, DiseaseScope, TreatmentConfidence, CATALOGUE_SCHEMA_VERSION,
};
use crate::modules::sandbox::env_id::is_valid_env_id;

/// The longest method id or group id (a method id is also an image repository component).
const MAX_ID_LEN: usize = 128;
/// The longest marker id (marker ids are free text of the source: names, codes).
const MAX_MARKER_ID_LEN: usize = 512;

/// A named catalogue load failure. Every variant carries a stable code (the
/// `as_str` below) so a boot refusal is a testable, typed report — the
/// first-party-data posture: a file we shipped that we cannot interpret is a
/// build/dep bug, never something to degrade around.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogueLoadError {
    /// The bytes are not the catalogue JSON (parse error; message carries the
    /// parser's line/column report).
    EmbedParse { message: String },
    /// The `schema_version` differs from [`CATALOGUE_SCHEMA_VERSION`].
    SchemaVersion { found: u32 },
    /// The `methods[]` set is empty — never serve a catalogue without methods.
    EmptyMethods,
    /// Two methods share an id — the id is the identity key a consumer binds.
    DuplicateMethodId { id: String },
    /// Two vocabulary markers share `(system, id)`.
    DuplicateMarkerId { system: String, id: String },
    /// Two marker groups share an id.
    DuplicateGroupId { id: String },
    /// A runnable method carries an empty env field — the runnable contract is
    /// non-empty image + digest + contract (PROV-MC-1 acceptance).
    RunnableMissingEnv { id: String, field: &'static str },
    /// A method id is not an env-id (`sandbox::env_id::is_valid_env_id`), is all dots, or is
    /// too long: it names run folders and image repositories.
    InvalidMethodId { id: String },
    /// A marker id is empty, too long, or holds a control character or a backslash.
    InvalidMarkerId { id: String },
    /// A group id is not a short slug of the env-id characters.
    InvalidGroupId { id: String },
    /// Two `study_options.disease_categories` share an id.
    DuplicateDiseaseCategory { id: String },
    /// Two diseases (across categories) share an id.
    DuplicateDisease { id: String },
    /// A disease's child appears under two diseases (each child is exactly one
    /// disease's).
    DuplicateChild { id: String },
    /// A disease's child is also a disease (the child level is below the
    /// disease level, never the same name).
    ChildIsAlsoDisease { id: String },
    /// Two `study_options.treatment_classes` share an id.
    DuplicateTreatmentClass { id: String },
    /// A method's `disease` scope and groups disagree: `group` needs a
    /// non-empty `groups`, the coarser scopes an empty one.
    DiseaseScopeGroupsMismatch { method: String, scope: String },
    /// A method's `treatment` classes and confidence disagree: `not-stated`
    /// needs an empty `classes`, `stated`/`inferred` a non-empty one.
    TreatmentClassesConfidenceMismatch { method: String, confidence: String },
    /// A method names a disease group that is not a disease or a child in
    /// `study_options`.
    UnknownDiseaseGroup { method: String, group: String },
    /// A method names a treatment class that is not an id in
    /// `study_options.treatment_classes`.
    UnknownTreatmentClass { method: String, class_id: String },
}

impl CatalogueLoadError {
    /// The stable machine code of the failure (the boot report's code).
    pub fn code(&self) -> &'static str {
        match self {
            CatalogueLoadError::EmbedParse { .. } => "CATALOGUE_EMBED_INVALID",
            CatalogueLoadError::SchemaVersion { .. } => "CATALOGUE_SCHEMA_VERSION",
            CatalogueLoadError::EmptyMethods => "CATALOGUE_EMPTY",
            CatalogueLoadError::DuplicateMethodId { .. } => "CATALOGUE_DUPLICATE_METHOD_ID",
            CatalogueLoadError::DuplicateMarkerId { .. } => "CATALOGUE_DUPLICATE_MARKER_ID",
            CatalogueLoadError::DuplicateGroupId { .. } => "CATALOGUE_DUPLICATE_GROUP_ID",
            CatalogueLoadError::RunnableMissingEnv { .. } => "CATALOGUE_RUNNABLE_MISSING_ENV",
            CatalogueLoadError::InvalidMethodId { .. } => "CATALOGUE_INVALID_METHOD_ID",
            CatalogueLoadError::InvalidMarkerId { .. } => "CATALOGUE_INVALID_MARKER_ID",
            CatalogueLoadError::InvalidGroupId { .. } => "CATALOGUE_INVALID_GROUP_ID",
            CatalogueLoadError::DuplicateDiseaseCategory { .. } => "CATALOGUE_DUPLICATE_DISEASE_CATEGORY",
            CatalogueLoadError::DuplicateDisease { .. } => "CATALOGUE_DUPLICATE_DISEASE",
            CatalogueLoadError::DuplicateChild { .. } => "CATALOGUE_DUPLICATE_CHILD",
            CatalogueLoadError::ChildIsAlsoDisease { .. } => "CATALOGUE_CHILD_IS_ALSO_DISEASE",
            CatalogueLoadError::DuplicateTreatmentClass { .. } => "CATALOGUE_DUPLICATE_TREATMENT_CLASS",
            CatalogueLoadError::DiseaseScopeGroupsMismatch { .. } => "CATALOGUE_DISEASE_SCOPE_GROUPS_MISMATCH",
            CatalogueLoadError::TreatmentClassesConfidenceMismatch { .. } => {
                "CATALOGUE_TREATMENT_CONFIDENCE_MISMATCH"
            }
            CatalogueLoadError::UnknownDiseaseGroup { .. } => "CATALOGUE_UNKNOWN_DISEASE_GROUP",
            CatalogueLoadError::UnknownTreatmentClass { .. } => "CATALOGUE_UNKNOWN_TREATMENT_CLASS",
        }
    }
}

impl fmt::Display for CatalogueLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CatalogueLoadError::EmbedParse { message } => {
                write!(f, "CATALOGUE_EMBED_INVALID: the catalogue is not valid schema-1 JSON: {message}")
            }
            CatalogueLoadError::SchemaVersion { found } => write!(
                f,
                "CATALOGUE_SCHEMA_VERSION: the catalogue declares schema_version {found}, \
                 this build understands {CATALOGUE_SCHEMA_VERSION}"
            ),
            CatalogueLoadError::EmptyMethods => write!(
                f,
                "CATALOGUE_EMPTY: the catalogue carries zero methods"
            ),
            CatalogueLoadError::DuplicateMethodId { id } => write!(
                f,
                "CATALOGUE_DUPLICATE_METHOD_ID: method id `{id}` appears twice"
            ),
            CatalogueLoadError::DuplicateMarkerId { system, id } => write!(
                f,
                "CATALOGUE_DUPLICATE_MARKER_ID: marker ({system}, {id}) appears twice"
            ),
            CatalogueLoadError::DuplicateGroupId { id } => write!(
                f,
                "CATALOGUE_DUPLICATE_GROUP_ID: marker group `{id}` appears twice"
            ),
            CatalogueLoadError::RunnableMissingEnv { id, field } => write!(
                f,
                "CATALOGUE_RUNNABLE_MISSING_ENV: runnable method `{id}` carries an empty env.{field}"
            ),
            CatalogueLoadError::InvalidMethodId { id } => write!(
                f,
                "CATALOGUE_INVALID_METHOD_ID: method id {id:?} is not a lowercase env-id of at most \
                 {MAX_ID_LEN} characters"
            ),
            CatalogueLoadError::InvalidMarkerId { id } => write!(
                f,
                "CATALOGUE_INVALID_MARKER_ID: marker id {id:?} is empty, over {MAX_MARKER_ID_LEN} \
                 characters, or holds a control character or a backslash"
            ),
            CatalogueLoadError::InvalidGroupId { id } => write!(
                f,
                "CATALOGUE_INVALID_GROUP_ID: group id {id:?} is not a lowercase slug of at most \
                 {MAX_ID_LEN} characters"
            ),
            CatalogueLoadError::DuplicateDiseaseCategory { id } => write!(
                f,
                "CATALOGUE_DUPLICATE_DISEASE_CATEGORY: disease category `{id}` appears twice"
            ),
            CatalogueLoadError::DuplicateDisease { id } => write!(
                f,
                "CATALOGUE_DUPLICATE_DISEASE: disease `{id}` appears twice (across categories)"
            ),
            CatalogueLoadError::DuplicateChild { id } => write!(
                f,
                "CATALOGUE_DUPLICATE_CHILD: disease child `{id}` appears under two diseases \
                 (a child is exactly one disease's)"
            ),
            CatalogueLoadError::ChildIsAlsoDisease { id } => write!(
                f,
                "CATALOGUE_CHILD_IS_ALSO_DISEASE: `{id}` is both a disease and a child of one \
                 (the child level is below the disease level)"
            ),
            CatalogueLoadError::DuplicateTreatmentClass { id } => write!(
                f,
                "CATALOGUE_DUPLICATE_TREATMENT_CLASS: treatment class `{id}` appears twice"
            ),
            CatalogueLoadError::DiseaseScopeGroupsMismatch { method, scope } => write!(
                f,
                "CATALOGUE_DISEASE_SCOPE_GROUPS_MISMATCH: method `{method}` has disease.scope \
                 {scope:?}, whose groups must be {}; they are not",
                if scope == "group" { "non-empty" } else { "empty" }
            ),
            CatalogueLoadError::TreatmentClassesConfidenceMismatch { method, confidence } => write!(
                f,
                "CATALOGUE_TREATMENT_CONFIDENCE_MISMATCH: method `{method}` has \
                 treatment.confidence {confidence:?}, whose classes must be {}; they are not",
                if confidence == "not-stated" { "empty" } else { "non-empty" }
            ),
            CatalogueLoadError::UnknownDiseaseGroup { method, group } => write!(
                f,
                "CATALOGUE_UNKNOWN_DISEASE_GROUP: method `{method}` names disease group \
                 {group:?}, which is not a disease or a child in study_options"
            ),
            CatalogueLoadError::UnknownTreatmentClass { method, class_id } => write!(
                f,
                "CATALOGUE_UNKNOWN_TREATMENT_CLASS: method `{method}` names treatment class \
                 {class_id:?}, which is not an id of study_options.treatment_classes"
            ),
        }
    }
}

impl std::error::Error for CatalogueLoadError {}

/// Parse + validate the catalogue from arbitrary bytes (the unit-test seam and
/// the boot path share it — a corrupted-byte test exercises the REAL loader).
pub fn parse_catalogue(bytes: &[u8]) -> Result<Catalogue, CatalogueLoadError> {
    let catalogue: Catalogue =
        serde_json::from_slice(bytes).map_err(|e| CatalogueLoadError::EmbedParse {
            message: e.to_string(),
        })?;
    validate_catalogue(&catalogue)?;
    Ok(catalogue)
}

/// The structural boot checks over a parsed catalogue. This is what makes the
/// embed a VALIDATED load (not just a parse): duplicate ids would silently make
/// `method(id)` return the wrong entry, an empty set would silently serve an
/// empty method list, and a runnable method without env facts would silently
/// break the run contract downstream.
fn validate_catalogue(c: &Catalogue) -> Result<(), CatalogueLoadError> {
    if c.schema_version != CATALOGUE_SCHEMA_VERSION {
        return Err(CatalogueLoadError::SchemaVersion {
            found: c.schema_version,
        });
    }
    if c.methods.is_empty() {
        return Err(CatalogueLoadError::EmptyMethods);
    }
    let mut method_ids: Vec<&str> = Vec::with_capacity(c.methods.len());
    for m in &c.methods {
        if !valid_slug(&m.id) {
            return Err(CatalogueLoadError::InvalidMethodId { id: m.id.clone() });
        }
        if method_ids.contains(&m.id.as_str()) {
            return Err(CatalogueLoadError::DuplicateMethodId { id: m.id.clone() });
        }
        method_ids.push(&m.id);
        if m.runnable {
            if m.env.image.is_empty() {
                return Err(CatalogueLoadError::RunnableMissingEnv {
                    id: m.id.clone(),
                    field: "image",
                });
            }
            if m.env.digest.is_empty() {
                return Err(CatalogueLoadError::RunnableMissingEnv {
                    id: m.id.clone(),
                    field: "digest",
                });
            }
            if m.env.contract.is_empty() {
                return Err(CatalogueLoadError::RunnableMissingEnv {
                    id: m.id.clone(),
                    field: "contract",
                });
            }
        }
    }
    let mut marker_ids: Vec<(&str, &str)> = Vec::with_capacity(c.markers.len());
    for marker in &c.markers {
        if !valid_marker_id(&marker.id) {
            return Err(CatalogueLoadError::InvalidMarkerId { id: marker.id.clone() });
        }
        let key = (marker.system.as_str(), marker.id.as_str());
        if marker_ids.contains(&key) {
            return Err(CatalogueLoadError::DuplicateMarkerId {
                system: marker.system.as_str().to_string(),
                id: marker.id.clone(),
            });
        }
        marker_ids.push(key);
    }
    let mut group_ids: Vec<&str> = Vec::with_capacity(c.groups.len());
    for g in &c.groups {
        if !valid_slug(&g.id) {
            return Err(CatalogueLoadError::InvalidGroupId { id: g.id.clone() });
        }
        if group_ids.contains(&g.id.as_str()) {
            return Err(CatalogueLoadError::DuplicateGroupId { id: g.id.clone() });
        }
        group_ids.push(&g.id);
    }
    validate_study_options(c)?;
    Ok(())
}

/// The schema-2 `study_options` checks (the vocabulary every method row
/// references): ids are unique, a child is exactly one disease's and is never
/// also a disease, and each method's `disease`/`treatment` facts are
/// consistent and name known entries.
fn validate_study_options(c: &Catalogue) -> Result<(), CatalogueLoadError> {
    let mut category_ids: Vec<&str> = Vec::new();
    let mut disease_ids: Vec<&str> = Vec::new();
    let mut child_ids: Vec<&str> = Vec::new();
    for category in &c.study_options.disease_categories {
        if category_ids.contains(&category.id.as_str()) {
            return Err(CatalogueLoadError::DuplicateDiseaseCategory {
                id: category.id.clone(),
            });
        }
        category_ids.push(&category.id);
        for disease in &category.diseases {
            if disease_ids.contains(&disease.id.as_str()) {
                return Err(CatalogueLoadError::DuplicateDisease {
                    id: disease.id.clone(),
                });
            }
            disease_ids.push(&disease.id);
            for child in &disease.children {
                if child_ids.contains(&child.as_str()) {
                    return Err(CatalogueLoadError::DuplicateChild {
                        id: child.clone(),
                    });
                }
                child_ids.push(child);
            }
        }
    }
    for child in &child_ids {
        if disease_ids.contains(child) {
            return Err(CatalogueLoadError::ChildIsAlsoDisease {
                id: (*child).to_string(),
            });
        }
    }
    let mut treatment_ids: Vec<&str> = Vec::new();
    for treatment in &c.study_options.treatment_classes {
        if treatment_ids.contains(&treatment.id.as_str()) {
            return Err(CatalogueLoadError::DuplicateTreatmentClass {
                id: treatment.id.clone(),
            });
        }
        treatment_ids.push(&treatment.id);
    }
    for m in &c.methods {
        match m.disease.scope {
            DiseaseScope::Group => {
                if m.disease.groups.is_empty() {
                    return Err(CatalogueLoadError::DiseaseScopeGroupsMismatch {
                        method: m.id.clone(),
                        scope: DiseaseScope::Group.as_str().to_string(),
                    });
                }
                for group in &m.disease.groups {
                    if !disease_ids.contains(&group.as_str())
                        && !child_ids.contains(&group.as_str())
                    {
                        return Err(CatalogueLoadError::UnknownDiseaseGroup {
                            method: m.id.clone(),
                            group: group.clone(),
                        });
                    }
                }
            }
            scope => {
                if !m.disease.groups.is_empty() {
                    return Err(CatalogueLoadError::DiseaseScopeGroupsMismatch {
                        method: m.id.clone(),
                        scope: scope.as_str().to_string(),
                    });
                }
            }
        }
        match m.treatment.confidence {
            TreatmentConfidence::NotStated => {
                if !m.treatment.classes.is_empty() {
                    return Err(CatalogueLoadError::TreatmentClassesConfidenceMismatch {
                        method: m.id.clone(),
                        confidence: TreatmentConfidence::NotStated.as_str().to_string(),
                    });
                }
            }
            confidence => {
                if m.treatment.classes.is_empty() {
                    return Err(CatalogueLoadError::TreatmentClassesConfidenceMismatch {
                        method: m.id.clone(),
                        confidence: confidence.as_str().to_string(),
                    });
                }
                for class in &m.treatment.classes {
                    if !treatment_ids.contains(&class.as_str()) {
                        return Err(CatalogueLoadError::UnknownTreatmentClass {
                            method: m.id.clone(),
                            class_id: class.clone(),
                        });
                    }
                }
            }
        }
    }
    Ok(())
}

/// A method or group id: the env-id grammar (lowercase, digits, `.` `_` `-`), bounded, and
/// not made only of dots (`.` and `..` would be path components).
fn valid_slug(id: &str) -> bool {
    is_valid_env_id(id) && id.len() <= MAX_ID_LEN && !id.chars().all(|c| c == '.')
}

/// A marker id is free text of its source (names with spaces and `/` exist), so it is only
/// bounded and kept free of control characters and backslashes.
fn valid_marker_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_MARKER_ID_LEN
        && !id.chars().any(|c| c.is_control() || c == '\\')
}

// The TEST-MC-7 / TEST-MC-19 / TEST-MC-9(unit half) suite: the embedded file
// parses + validates; `method`/`env_for` resolve a real runnable entry; a
// corrupted or nonsense catalogue is a NAMED boot refusal, never a silent
// empty load; and the load reads nothing from the environment or filesystem
// (INV-1 — see the module doc: the loader has no env/fs access at all).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::types::{
        MarkerGroup, Method, MethodEnv, MethodGroup, TimingQuality, UnitFamily,
        VocabularyMarker, CATALOGUE_SCHEMA_VERSION,
    };

    // The shipped catalogue is the built-in method list's `catalogue` half; these read
    // it the way a request reads one list snapshot.
    fn ensure_loaded() -> Result<&'static Catalogue, CatalogueLoadError> {
        Ok(&crate::modules::method_list::builtin().catalogue)
    }
    fn method(id: &str) -> Option<&'static Method> {
        crate::modules::method_list::builtin().method(id)
    }
    fn env_for(id: &str) -> Option<MethodEnv> {
        let m = method(id)?;
        Some(MethodEnv {
            image: m.env.image.clone(),
            version: m.version.clone(),
            digest: m.env.digest.clone(),
            contract: m.env.contract.clone(),
        })
    }
    fn marker_vocabulary() -> &'static [VocabularyMarker] {
        crate::modules::method_list::builtin().marker_vocabulary()
    }
    fn marker_groups() -> &'static [MarkerGroup] {
        &crate::modules::method_list::builtin().catalogue.groups
    }
    fn vocabulary_marker(system: &str, id: &str) -> Option<&'static VocabularyMarker> {
        crate::modules::method_list::builtin().vocabulary_marker(system, id)
    }

    /// TEST-MC-7: the shipped (built-in) catalogue parses + validates; a real runnable
    /// method resolves; `env_for` returns the image/digest/contract + version.
    #[test]
    fn embedded_catalogue_loads_and_resolves_a_runnable_method() {
        let c = ensure_loaded().expect("the committed catalogue must parse + validate");

        assert_eq!(c.schema_version, CATALOGUE_SCHEMA_VERSION);
        // PROV-MC-1 acceptance facts the boot check enforces: a runnable entry
        // carries non-empty env image/digest/contract — enforced at load, so a
        // re-assert here pins the DATA the load accepted.
        assert!(!c.methods.is_empty(), "catalogue methods must not be empty");
        // The built-in catalogue is the benchmark's usable-method list: 429
        // rows, of which 359 are runnable and 70 are kept with
        // `runnable: false` (retired — they stay so saved models and history
        // of them keep their facts; the counts are pinned AND derived from
        // the data, so a drift in either direction fails).
        let runnable = c.methods.iter().filter(|m| m.runnable).count();
        let retired = c.methods.len() - runnable;
        assert_eq!(c.methods.len(), 429, "the shipped catalogue has 429 rows");
        assert_eq!(runnable, 359, "runnable rows (DEC-2's number)");
        assert_eq!(retired, 70, "retired rows kept with their facts");
        // PROV-MC-1 acceptance facts the boot check enforces: a RUNNABLE entry
        // carries non-empty env image/digest/contract — enforced at load, so a
        // re-assert here pins the DATA the load accepted (a retired row keeps
        // its env facts but is not offered).
        for m in c.methods.iter().filter(|m| m.runnable) {
            assert!(!m.env.image.is_empty());
            assert!(!m.env.digest.is_empty());
            assert!(!m.env.contract.is_empty());
        }
        assert_eq!(c.groups.len(), 7, "the 7 board marker groups");
        assert!(!c.markers.is_empty());

        let m = method("landmark-cox-current")
            .expect("a named runnable method of the real catalogue resolves");
        assert_eq!(m.group, MethodGroup::DynamicRisk);
        assert!(m.runnable);
        assert_eq!(m.min_draws, 1);
        assert!(m.needs_baseline);
        assert_eq!(m.timing.quality, TimingQuality::Measured);

        let env = env_for("landmark-cox-current").expect("env facts for a runnable method");
        assert_eq!(
            env.image, "ghcr.io/tinnlab/txresbench-landmark-cox-current:2.0.0",
            "the build_index-style reference with the method version as tag"
        );
        assert_eq!(env.version, "2.0.0");
        assert!(env.digest.starts_with("sha256:"), "the gate digest form");
        assert_eq!(env.contract, "2.0");

        // A RETIRED row still loads with its facts (it stays reachable by id
        // so saved models and history of it keep their facts) and reports
        // itself as not runnable.
        let retired = method("nn-3layer-ctdna-pr")
            .expect("a retired named method of the real catalogue still resolves");
        assert!(!retired.runnable, "the retired row is marked not runnable");
        assert_eq!(retired.version, "1.0.0");
        assert_eq!(retired.group, MethodGroup::ResponseProbability);
        assert_eq!(retired.min_draws, 6);
        assert!(retired.tasks.is_empty(), "the retired method is task-less");
        let retired_env =
            env_for("nn-3layer-ctdna-pr").expect("a retired row keeps its env facts");
        assert_eq!(
            retired_env.image, "ghcr.io/tinnlab/txresbench-nn-3layer-ctdna-pr:1.0.0",
            "the retired row's recorded image"
        );
        assert_eq!(retired_env.version, "1.0.0");
        assert!(retired_env.digest.starts_with("sha256:"), "the gate digest form");
        assert_eq!(retired_env.contract, "2.0");

        // The vocabulary resolves the panel's HGNC markers and reports groups.
        let eya4 = vocabulary_marker("HGNC", "EYA4").expect("EYA4 is in the vocabulary");
        assert!(!eya4.groups.is_empty());
    }

    /// TEST-MC-9 (unit half): the load path is self-contained — nothing here
    /// reads a benchmark tree or any env var; a load succeeds regardless of
    /// whether `SIGTRANS_ROOT` (the GENERATOR's build-time root) exists. The
    /// HTTP half of TEST-MC-9 (a server spawn without `SIGTRANS_ROOT` still
    /// serves `GET /api/methods`) lands with the routes (ITEM-5).
    #[test]
    fn embedded_load_needs_no_benchmark_tree() {
        // `SIGTRANS_ROOT` is the generator's build-time env var, used ONLY at
        // generation time; this loader never consults it or the filesystem.
        // The assertion is that the load succeeds in this (bare) test
        // environment — no bench tree is present or needed at run time (INV-1).
        let c = ensure_loaded().expect("load must not depend on the benchmark tree");
        assert!(!c.methods.is_empty());
    }

    /// TEST-MC-28 (qa-fixes3 ITEM-1): every shipped method carries the
    /// human-name fields — a non-empty `title` within
    /// [`MAX_METHOD_TITLE_CHARS`], a non-empty `summary` within
    /// [`MAX_METHOD_SUMMARY_CHARS`], and `paper_title` either absent (the
    /// generator's "when known" honesty) or non-empty. A generated file that
    /// regresses (an empty title, an over-long summary) fails HERE, not at a
    /// render.
    #[test]
    fn every_method_carries_human_name_fields_within_the_caps() {
        use crate::modules::method_catalogue::types::{
            MAX_METHOD_SUMMARY_CHARS, MAX_METHOD_TITLE_CHARS,
        };
        let c = ensure_loaded().expect("the committed catalogue must parse + validate");
        let mut out_of_contract: Vec<String> = Vec::new();
        for m in &c.methods {
            if m.title.trim().is_empty() || m.title.chars().count() > MAX_METHOD_TITLE_CHARS {
                out_of_contract.push(format!("{}: title {:?}", m.id, m.title));
            }
            if m.summary.trim().is_empty() || m.summary.chars().count() > MAX_METHOD_SUMMARY_CHARS {
                out_of_contract.push(format!("{}: summary {:?}", m.id, m.summary));
            }
            if let Some(t) = &m.paper_title {
                if t.trim().is_empty() {
                    out_of_contract.push(format!("{}: empty paper_title", m.id));
                }
            }
        }
        assert!(
            out_of_contract.is_empty(),
            "human-name fields out of contract:\n{}",
            out_of_contract.join("\n")
        );
    }

    /// TEST-MC-19: a corrupted / diverging first-party catalogue fails with a
    /// NAMED error — never a silently empty catalogue. The corrupted-byte case
    /// exercises the REAL loader (parse_catalogue is the boot path).
    #[test]
    fn corrupted_catalogue_fails_with_named_error() {
        let err = parse_catalogue(b"{ not json").unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_EMBED_INVALID");
        assert!(format!("{err}").starts_with("CATALOGUE_EMBED_INVALID"));
    }

    #[test]
    fn unknown_schema_version_fails_with_named_error() {
        let json = br#"{
            "schema_version": 3,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [], "markers": [], "groups": [],
            "study_options": {"disease_categories": [], "treatment_classes": []}
        }"#;
        let err = parse_catalogue(json).unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_SCHEMA_VERSION");
        assert!(format!("{err}").contains("declares schema_version 3"));
    }

    #[test]
    fn empty_catalogue_fails_with_named_error() {
        let json = br#"{
            "schema_version": 2,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [], "markers": [], "groups": [],
            "study_options": {"disease_categories": [], "treatment_classes": []}
        }"#;
        let err = parse_catalogue(json).unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_EMPTY");
    }

    /// A schema-2 `study_options` block whose entries the method fixtures may
    /// reference (disease `lung cancer` + its child, category `Solid tumours`,
    /// one treatment class).
    fn study_options_json() -> &'static str {
        r#"{
            "disease_categories": [
                {"id": "Solid tumours", "diseases": [
                    {"id": "lung cancer", "children": ["non-small cell lung cancer"]}
                ]}
            ],
            "treatment_classes": [
                {"id": "chemotherapy", "label": "Chemotherapy"}
            ]
        }"#
    }

    /// One-runnable-method catalogue, constructed by hand to hit each
    /// validation check (the fixture registry's expected-catalogue.json is not
    /// the embedded file, so the checks are asserted over minimal handcrafted
    /// JSON here).
    fn minimal_catalogue_bytes(method_json: &str) -> Vec<u8> {
        catalogue_doc(method_json, study_options_json())
    }

    /// A schema-2 catalogue body with one method entry and the given
    /// `study_options` (markers/groups empty).
    fn catalogue_doc(methods: &str, study_options: &str) -> Vec<u8> {
        format!(
            r#"{{
                "schema_version": 2,
                "generated_from": {{"registry_name":"r","methods_commit":"m",
                    "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"}},
                "methods": [{methods}],
                "markers": [],
                "groups": [],
                "study_options": {study_options}
            }}"#
        )
        .into_bytes()
    }

    fn runnable_method_json(id: &str, image: &str, digest: &str) -> String {
        format!(
            r#"{{
                "id": "{id}", "version": "1.0.0", "group": "response-call",
                "group_label": "Response call", "title": "Rule", "summary": "A rule.",
                "paper_title": null,
                "journal": "J", "year": 2026,
                "citations": 0, "language": "R", "paper_doi": "", "spec_status": "draft",
                "frozen_model": false, "container": false, "runnable": true,
                "gate": {{"pass": true, "report_name": "{id}.report.md"}},
                "env": {{"image": "{image}", "digest": "{digest}", "contract": "2.0"}},
                "markers": {{"kind": "any", "count": 0}}, "covariates": "none",
                "min_draws": 1, "needs_baseline": false, "uses_history": "landmark",
                "fitted": false, "saves_model": false, "own_outputs": [], "tasks": [],
                "required_markers": null, "needs_detection_call": false,
                "marker_groups_required": [],
                "disease": {{"scope": "group", "groups": ["lung cancer"]}},
                "treatment": {{"classes": ["chemotherapy"], "confidence": "stated"}},
                "description": "d",
                "timing": {{"base_seconds_per_fold": 1.0, "benchmarked_units": 0, "quality": "estimate"}},
                "performance": null,
                "embeds_training_data": false,
                "software": {{"language": "R 4.4.2", "packages": {{}}}},
                "licence": "MIT", "references": [], "params": {{}}
            }}"#
        )
    }

    #[test]
    fn duplicate_method_id_fails_with_named_error() {
        let m = runnable_method_json("dup", "ghcr.io/tinnlab/txresbench-dup:1.0.0", "sha256:aa");
        let json = minimal_catalogue_bytes(&format!("{m},{m}"));
        let err = parse_catalogue(&json).unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DUPLICATE_METHOD_ID");
    }

    #[test]
    fn runnable_without_env_fails_with_named_error() {
        // A runnable method with an empty image: the PROV-MC-1 acceptance that
        // every runnable method has a non-empty env reference is enforced AT
        // BOOT, so a generator regression cannot ship a silently broken env.
        let m = runnable_method_json("badenv", "", "sha256:aa");
        let json = minimal_catalogue_bytes(&m);
        let err = parse_catalogue(&json).unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_RUNNABLE_MISSING_ENV");
        assert!(format!("{err}").contains("badenv"));
    }

    #[test]
    fn method_ids_must_pass_the_env_id_grammar() {
        let long = "a".repeat(MAX_ID_LEN + 1);
        for bad in ["", "..", ".", "a/b", "../x", "Upper", "a b", "a:b", "a@sha256", long.as_str()] {
            let m = runnable_method_json(bad, "ghcr.io/tinnlab/txresbench-x:1.0.0", "sha256:aa");
            let err = parse_catalogue(&minimal_catalogue_bytes(&m)).unwrap_err();
            assert_eq!(err.code(), "CATALOGUE_INVALID_METHOD_ID", "{bad:?}: {err}");
        }
    }

    fn catalogue_with(markers: &str, groups: &str) -> Vec<u8> {
        let m = runnable_method_json("ok", "ghcr.io/tinnlab/txresbench-ok:1.0.0", "sha256:aa");
        let text = String::from_utf8(minimal_catalogue_bytes(&m)).unwrap();
        text.replace(r#""markers": [],"#, &format!(r#""markers": {markers},"#))
            .replace(r#""groups": []"#, &format!(r#""groups": {groups}"#))
            .into_bytes()
    }

    fn marker_json(id: &str) -> String {
        format!(
            r#"{{"id":{},"system":"LOINC","display_name":"d","aliases":[],"groups":[],
                "unit_family":"count","canonical_unit":"","n_methods":0}}"#,
            serde_json::to_string(id).unwrap()
        )
    }

    #[test]
    fn marker_ids_are_bounded_and_clean() {
        let long = "m".repeat(MAX_MARKER_ID_LEN + 1);
        for bad in ["", "a\\b", "a\u{0}b", "a\nb", long.as_str()] {
            let err = parse_catalogue(&catalogue_with(&format!("[{}]", marker_json(bad)), "[]")).unwrap_err();
            assert_eq!(err.code(), "CATALOGUE_INVALID_MARKER_ID", "{bad:?}: {err}");
        }
        // Names with spaces and a slash are real marker ids.
        let ok = marker_json("AST/ALT ratio");
        parse_catalogue(&catalogue_with(&format!("[{ok}]"), "[]")).expect("a free-text id is fine");
    }

    #[test]
    fn group_ids_are_short_slugs() {
        let long = "g".repeat(MAX_ID_LEN + 1);
        for bad in ["", "..", "a/b", "Upper", "a b", long.as_str()] {
            let g = format!(r#"[{{"id":{},"display_name":"d"}}]"#, serde_json::to_string(bad).unwrap());
            let err = parse_catalogue(&catalogue_with("[]", &g)).unwrap_err();
            assert_eq!(err.code(), "CATALOGUE_INVALID_GROUP_ID", "{bad:?}: {err}");
        }
        let g = r#"[{"id":"tumour-markers","display_name":"d"}]"#;
        parse_catalogue(&catalogue_with("[]", g)).expect("a slug is fine");
    }

    #[test]
    fn valid_catalogue_passes_and_looks_up() {
        let m = runnable_method_json("ok", "ghcr.io/tinnlab/txresbench-ok:1.0.0", "sha256:aa");
        let json = minimal_catalogue_bytes(&m);
        let c = parse_catalogue(&json).expect("the minimal valid catalogue loads");
        assert_eq!(c.methods.len(), 1);
        assert!(c.method("ok").is_some());
        assert!(c.method("nope").is_none());
        // The schema-2 facts parsed into the typed model.
        assert_eq!(c.study_options.disease_categories.len(), 1);
        assert_eq!(c.study_options.disease_categories[0].diseases[0].id, "lung cancer");
        assert_eq!(c.study_options.treatment_classes[0].id, "chemotherapy");
        let m = c.method("ok").expect("method");
        assert_eq!(m.disease.scope, DiseaseScope::Group);
        assert_eq!(m.disease.groups, vec!["lung cancer"]);
        assert_eq!(m.treatment.confidence, TreatmentConfidence::Stated);
        assert_eq!(m.treatment.classes, vec!["chemotherapy"]);
    }

    /// A schema 1 catalogue (the previous format line) is the named
    /// `CATALOGUE_SCHEMA_VERSION` refusal — never a silent re-read.
    #[test]
    fn schema_1_catalogue_is_refused_with_schema_version() {
        let json = br#"{
            "schema_version": 1,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [], "markers": [], "groups": [],
            "study_options": {"disease_categories": [], "treatment_classes": []}
        }"#;
        let err = parse_catalogue(json).unwrap_err();
        assert_eq!(
            err,
            CatalogueLoadError::SchemaVersion { found: 1 },
            "{err}"
        );
    }

    /// The schema-1 shape of the new facts is refused too: `disease.scope`
    /// holds the old free-text form on a schema-2 catalogue.
    #[test]
    fn disease_scope_is_the_closed_kebab_case_vocabulary() {
        let m = serde_json::json!({
            "id": "ok", "version": "1.0.0", "group": "response-call",
            "group_label": "Response call", "title": "Rule", "summary": "A rule.",
            "paper_title": null, "journal": "J", "year": 2026,
            "citations": 0, "language": "R", "paper_doi": "", "spec_status": "draft",
            "frozen_model": false, "container": false, "runnable": true,
            "gate": {"pass": true, "report_name": "ok.report.md"},
            "env": {"image": "ghcr.io/tinnlab/txresbench-ok:1.0.0", "digest": "sha256:aa", "contract": "2.0"},
            "markers": {"kind": "any", "count": 0}, "covariates": "none",
            "min_draws": 1, "needs_baseline": false, "uses_history": "landmark",
            "fitted": false, "saves_model": false, "own_outputs": [], "tasks": [],
            "required_markers": null, "needs_detection_call": false,
            "marker_groups_required": [],
            "disease": {"scope": "all tumours", "groups": []},
            "treatment": {"classes": ["chemotherapy"], "confidence": "stated"},
            "description": "d",
            "timing": {"base_seconds_per_fold": 1.0, "benchmarked_units": 0, "quality": "estimate"},
            "performance": null, "embeds_training_data": false,
            "software": {"language": "R 4.4.2", "packages": {}},
            "licence": "MIT", "references": [], "params": {}
        });
        let doc = serde_json::json!({
            "schema_version": 2,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [m], "markers": [], "groups": [],
            "study_options": serde_json::from_str::<serde_json::Value>(study_options_json()).unwrap()
        });
        let err = parse_catalogue(serde_json::to_vec(&doc).unwrap().as_slice()).unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_EMBED_INVALID");
    }

    /// The schema-2 row builder: the minimal runnable row (valid
    /// disease/treatment facts), with fields replaced by `overrides`.
    fn method_value(id: &str, overrides: &[(&str, serde_json::Value)]) -> serde_json::Value {
        let mut m: serde_json::Value = serde_json::from_str(&runnable_method_json(
            id,
            "ghcr.io/tinnlab/txresbench-x:1.0.0",
            "sha256:aa",
        ))
        .expect("method JSON");
        for (k, v) in overrides {
            m[(*k).to_string()] = v.clone();
        }
        m
    }

    /// `parse_catalogue` over one method with the given overrides and the
    /// fixture `study_options` (disease `lung cancer` + its child
    /// `non-small cell lung cancer`, treatment class `chemotherapy`).
    fn parse_override(method_overrides: &[(&str, serde_json::Value)]) -> Result<Catalogue, CatalogueLoadError> {
        let doc = serde_json::json!({
            "schema_version": 2,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [method_value("ok", method_overrides)],
            "markers": [], "groups": [],
            "study_options": serde_json::from_str::<serde_json::Value>(study_options_json()).unwrap()
        });
        parse_catalogue(serde_json::to_vec(&doc).unwrap().as_slice())
    }

    #[test]
    fn unknown_disease_group_fails_with_named_error() {
        let err = parse_override(&[(
            "disease",
            serde_json::json!({"scope": "group", "groups": ["no such disease"]}),
        )])
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_UNKNOWN_DISEASE_GROUP");
        assert!(format!("{err}").contains("no such disease"));
        // A child of a disease may be named.
        let ok = parse_override(&[(
            "disease",
            serde_json::json!({"scope": "group", "groups": ["non-small cell lung cancer"]}),
        )]);
        ok.expect("a disease child is a valid group");
    }

    #[test]
    fn unknown_treatment_class_fails_with_named_error() {
        let err = parse_override(&[(
            "treatment",
            serde_json::json!({"classes": ["statins"], "confidence": "stated"}),
        )])
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_UNKNOWN_TREATMENT_CLASS");
        assert!(format!("{err}").contains("statins"));
    }

    fn with_study_options(study_options: serde_json::Value) -> Vec<u8> {
        let doc = serde_json::json!({
            "schema_version": 2,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [method_value("ok", &[])],
            "markers": [], "groups": [],
            "study_options": study_options
        });
        serde_json::to_vec(&doc).unwrap()
    }

    #[test]
    fn duplicate_study_option_ids_fail_with_named_errors() {
        let err = parse_catalogue(&with_study_options(serde_json::json!({
            "disease_categories": [
                {"id": "Solid tumours", "diseases": []},
                {"id": "Solid tumours", "diseases": []}
            ],
            "treatment_classes": []
        })))
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DUPLICATE_DISEASE_CATEGORY");

        let err = parse_catalogue(&with_study_options(serde_json::json!({
            "disease_categories": [
                {"id": "Solid tumours", "diseases": [
                    {"id": "lung cancer", "children": []},
                    {"id": "lung cancer", "children": []}
                ]}
            ],
            "treatment_classes": []
        })))
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DUPLICATE_DISEASE");

        let err = parse_catalogue(&with_study_options(serde_json::json!({
            "disease_categories": [
                {"id": "Solid tumours", "diseases": [
                    {"id": "lung cancer", "children": []},
                    {"id": "breast cancer", "children": []}
                ]},
                {"id": "Liquid tumours", "diseases": [{"id": "lung cancer", "children": []}]}
            ],
            "treatment_classes": []
        })))
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DUPLICATE_DISEASE", "across categories too");

        let err = parse_catalogue(&with_study_options(serde_json::json!({
            "disease_categories": [{
                "id": "Solid tumours", "diseases": [
                    {"id": "lung cancer", "children": ["non-small cell lung cancer"]},
                    {"id": "breast cancer", "children": ["non-small cell lung cancer"]}
                ]
            }],
            "treatment_classes": []
        })))
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DUPLICATE_CHILD");

        let err = parse_catalogue(&with_study_options(serde_json::json!({
            "disease_categories": [{
                "id": "Solid tumours", "diseases": [
                    {"id": "lung cancer", "children": ["breast cancer"]},
                    {"id": "breast cancer", "children": []}
                ]
            }],
            "treatment_classes": []
        })))
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_CHILD_IS_ALSO_DISEASE");

        let err = parse_catalogue(&with_study_options(serde_json::json!({
            "disease_categories": [],
            "treatment_classes": [
                {"id": "chemotherapy", "label": "Chemotherapy"},
                {"id": "chemotherapy", "label": "Chemo"}
            ]
        })))
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DUPLICATE_TREATMENT_CLASS");
    }

    #[test]
    fn disease_scope_groups_mismatch_fails_with_named_error() {
        // scope `group` with an empty groups list.
        let err = parse_override(&[(
            "disease",
            serde_json::json!({"scope": "group", "groups": []}),
        )])
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DISEASE_SCOPE_GROUPS_MISMATCH");
        assert!(format!("{err}").contains("group"));
        // A coarser scope with a non-empty groups list.
        let err = parse_override(&[(
            "disease",
            serde_json::json!({"scope": "any", "groups": ["lung cancer"]}),
        )])
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_DISEASE_SCOPE_GROUPS_MISMATCH");
    }

    #[test]
    fn treatment_classes_confidence_mismatch_fails_with_named_error() {
        // `not-stated` with classes.
        let err = parse_override(&[(
            "treatment",
            serde_json::json!({"classes": ["chemotherapy"], "confidence": "not-stated"}),
        )])
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_TREATMENT_CONFIDENCE_MISMATCH");
        assert!(format!("{err}").contains("not-stated"));
        // `stated` with no classes.
        let err = parse_override(&[(
            "treatment",
            serde_json::json!({"classes": [], "confidence": "stated"}),
        )])
        .unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_TREATMENT_CONFIDENCE_MISMATCH");
        // `inferred` with classes loads.
        parse_override(&[(
            "treatment",
            serde_json::json!({"classes": ["chemotherapy"], "confidence": "inferred"}),
        )])
        .expect("inferred with classes");
        // `not-stated` with no classes loads.
        parse_override(&[(
            "treatment",
            serde_json::json!({"classes": [], "confidence": "not-stated"}),
        )])
        .expect("not-stated with no classes");
    }

    /// The `UnitFamily` deserialization is the closed PROV-MC-1 vocabulary; a
    /// catalogue marker outside it is a schema disagreement, not a shorthand
    /// (the loader refuses — see the module doc).
    #[test]
    fn unknown_unit_family_is_a_parse_refusal() {
        let json = r#"{
            "schema_version": 2,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [], "markers": [
                {"id":"x","system":"LOINC","display_name":"d","aliases":[],
                 "groups":[],"unit_family":"nanodaltons","canonical_unit":"",
                 "n_methods":0}
            ], "groups": [],
            "study_options": {"disease_categories": [], "treatment_classes": []}
        }"#;
        let err = parse_catalogue(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_EMBED_INVALID");
    }

    /// The in-process accessor contract: page-slice facts (`marker_vocabulary`,
    /// `marker_groups`) derive from the loaded catalogue.
    #[test]
    fn vocabulary_and_groups_are_the_loaded_facts() {
        let c = ensure_loaded().expect("loaded");
        assert_eq!(marker_vocabulary().len(), c.markers.len());
        assert_eq!(marker_groups().len(), 7);
        for g in marker_groups() {
            let _ = c.group(&g.id); // every id resolves
        }
        // A real unit-family fact parsed into the closed enum.
        let ctdna = marker_vocabulary()
            .iter()
            .find(|m| m.id == "2039-6")
            .expect("the CEA LOINC code is in the vocabulary");
        assert_eq!(ctdna.system.as_str(), "LOINC");
        let _ = ctdna.unit_family; // enum parsed
        assert_eq!(ctdna.unit_family, UnitFamily::ConcentrationMass);
    }

    /// Unknown fields are refused: the model is the exact schema-2 contract
    /// (a generator field the code does not know is a boot failure, not a
    /// silent drop — first-party posture).
    #[test]
    fn unknown_field_is_a_parse_refusal() {
        let json = r#"{
            "schema_version": 2,
            "generated_from": {"registry_name":"r","methods_commit":"m",
                "manifest_commit":"m","results_commit":"m","generated_at":"2026-01-01T00:00:00Z"},
            "methods": [], "markers": [], "groups": [],
            "study_options": {"disease_categories": [], "treatment_classes": []},
            "future_field": 1
        }"#;
        let err = parse_catalogue(json.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "CATALOGUE_EMBED_INVALID");
    }
}
