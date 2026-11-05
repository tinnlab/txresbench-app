//! ITEM-6 — the per-model eligibility engine (PROV-MS-9): a saved model's
//! RECORDED requirements against the file's inventory — the I screen's "Can
//! run / Can run for some patients / Cannot run" per model (FLOW's shared
//! list component; the same `InventoryEligibilityRequest` one component feeds
//! both eligibility providers, PROV-MC-5 verbatim).
//!
//! ## The verdict is about the MODEL, never the catalogue entry alone
//!
//! The requirements are the row's RECORDED facts (DEC-6 — recorded at save
//! time, never re-derived): the run's endpoint / decision day / horizon /
//! task, the bundle's recorded `features` (contract 2.0's params.json
//! `markers` — the instance's selected marker set) and the catalogue facts
//! the run recorded (`marker_facts`, `covariates`, `required_markers`). The
//! catalogue's CURRENT method entry is consulted only where the plan names
//! it: the vocabulary for unit families / display names (`vocabulary_marker`)
//! and the timing estimator (`estimate_seconds_for` / `estimate_quality_for`
//! — PROV-MC-6's one formula; an imported model of a method the app no
//! longer ships still gets a verdict, without a time).
//!
//! ## The matching binds the provider's own rules (PROV-MC-7)
//!
//! - A model with a recorded `required_markers` rule (every `single`/`panel`
//!   method that names its markers) is matched with the catalogue's
//!   `required_marker_match` over rows built from the inventory (the data.py
//!   port; the rule's own match mode + min_fraction semantics decide the
//!   verdict, and the rule's missing ids are the `REQUIRED_MARKER_MISSING`
//!   set).
//! - A model without a fixed list (`any`/`multi`) is matched by its recorded
//!   feature names: `parse_standard_ids` on the feature text (a feature key
//!   that IS a standard-id text, e.g. "LOINC 2039-6 CEA") + case-insensitive
//!   name equality against the inventory marker's key/display name + the
//!   vocabulary's name/alias surface (the catalogue engine's `other`-system
//!   fallback names — never an app-side marker list).
//! - Every other check (detection call, covariate block, unit families,
//!   draw coverage) mirrors the catalogue engine's inventory semantics
//!   verbatim — the SAME interpretation notes (coverage is the MAX per-marker
//!   per-patient count; a (0,0)-counted or absent patient has values only
//!   after the decision day → `DECISION_DAY_UNMET`; the fallback
//!   patient-level counts when the per-patient lists are omitted).
//!
//! ## Two model-only rules (the plan's gap)
//!
//! - **The requirement guard** (DEC-6 / TEST-MS-12): a row with no recorded
//!   requirement fact at all is `cannot_run` + `MODEL_REQUIREMENTS_UNRECORDED`
//!   — the store never invents requirements, and never presents an
//!   unverifiable model as runnable. This is the ONE added reason code; the
//!   other twelve are the catalogue's, mapped exhaustively by
//!   [`ModelReasonCode::from_catalogue`].
//! - **The decision-day window** (EXAMPLES-MS-3's decision-day rule): the
//!   per-patient counts are windowed at the FILE's own parameters
//!   (`inventory.decision_day` / `baseline_max_day`; the validator's
//!   counts). The model's recorded decision day must fall INSIDE that
//!   window: a model whose decision day is later than the file's recorded
//!   window end needs measurements in days the inventory does not count
//!   (`(file_decision_day, model_decision_day]`), so its coverage cannot be
//!   certified from those counts — the whole file answers
//!   `DECISION_DAY_UNMET` with an EMPTY eligible set (the counts are about a
//!   window the model does not fit). When the windows agree (model day ≤ file
//!   day) the counts cover the model's window and the (0,0)/absent patients
//!   are the decision-day set, exactly as the catalogue engine counts them.
//!
//! ## The verdict lattice
//!
//! The catalogue's own lattice, verbatim (PROV-MC-5): a hard reason
//! (`REQUIRED_MARKER_MISSING`, `DETECTION_CALL_MISSING`,
//! `COVARIATE_REQUIRED_UNMET`, `UNIT_MISMATCH`, the outcome codes, …) is
//! `cannot_run`; otherwise the draw coverage decides `can_run_some` vs
//! `can_run`. `MIN_DRAWS_UNMET` / `DECISION_DAY_UNMET` are the soft reasons
//! the I list renders with the coverage counts.
//!
//! `estimated_seconds` is the catalogue estimator's value for the model's
//! method at the file's patient count (PROV-MC-6; the eligibility path uses
//! the default CPU count, exactly as the catalogue inventory path does);
//! null + the weaker `estimate` quality when the method is absent from the
//! compiled catalogue (the verdict stands, the time is not promised).

use std::collections::{BTreeMap, BTreeSet};

use axum::http::StatusCode;
use serde_json::Value as Json;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::repository::{ModelRow, ModelStoreRepository};
use super::store::{parse_endpoint, parse_task, requirements_unrecorded};
use super::types::{
    CovariateFacts, MarkerFacts, ModelEligibility, ModelEligibilityResponse, ModelReason,
    ModelReasonCode,
};
use crate::modules::execution_engine::types::{TxrEndpoint, TxrTask};
use crate::modules::method_catalogue::catalogue;
use crate::modules::method_catalogue::eligibility::{
    estimate_quality_for, estimate_seconds_for, parse_standard_ids, required_marker_match,
    UnitMarkerRow,
};
use crate::modules::method_catalogue::types::{
    CovariateMode, Coverage, EligibilityStatus, InventoryEligibilityRequest, InventoryMarker,
    MinDraws, MissingMarker, RequiredMarkers, TimingQuality, UnitFamily, DEFAULT_ESTIMATE_CPUS,
};

/// PROV-MS-9 / PROV-MS-10's seam — the per-model verdicts for one inventory.
/// Unknown or unparseable ids answer 404 `MODEL_NOT_FOUND` (the caller's
/// selection should be re-read; a model deleted between list and check is
/// not secretly a `cannot_run` row). The ids' order is the response's order.
pub async fn eligible(
    pool: &SqlitePool,
    ids: &[String],
    inventory: &InventoryEligibilityRequest,
) -> Result<ModelEligibilityResponse, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    let mut models = Vec::with_capacity(ids.len());
    for id in ids {
        let uuid = Uuid::parse_str(id).map_err(|_| model_not_found(id))?;
        let row = repo
            .get_model(uuid)
            .await?
            .ok_or_else(|| model_not_found(id))?;
        models.push(model_verdict(&row, inventory)?);
    }
    let total_fit = models
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRun)
        .count() as u32;
    let total_some = models
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRunSome)
        .count() as u32;
    let total_cannot = models
        .iter()
        .filter(|m| m.status == EligibilityStatus::CannotRun)
        .count() as u32;
    Ok(ModelEligibilityResponse {
        models,
        total_fit,
        total_some,
        total_cannot,
    })
}

fn model_not_found(id: &str) -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "MODEL_NOT_FOUND",
        format!("no model {id}"),
    )
}

/// A stored JSON cell of the row (the facts were typed at save/import; a cell
/// that no longer parses is a local defect, never a client input).
fn parse_cell<T: serde::de::DeserializeOwned>(v: &Json, what: &str) -> Result<T, AppError> {
    serde_json::from_value(v.clone())
        .map_err(|e| AppError::internal_error(format!("{what}: {e}")))
}

/// The catalogue estimator's value + quality for the model's method at the
/// file's patient count (the one PROV-MC-6 formula; the eligibility path uses
/// the default CPU count, exactly as the catalogue inventory path does). An
/// absent method: no seconds, the weaker `estimate` quality (the pairing only
/// renders when seconds are present).
fn estimate_for(row: &ModelRow, patients: u32) -> (Option<f64>, TimingQuality) {
    match catalogue::method(&row.method_id) {
        Some(m) => (
            Some(estimate_seconds_for(m, patients, DEFAULT_ESTIMATE_CPUS)),
            estimate_quality_for(m),
        ),
        None => (None, TimingQuality::Estimate),
    }
}

/// One model's verdict (the pure core — row + inventory, no HTTP, no I/O).
fn model_verdict(
    row: &ModelRow,
    inv: &InventoryEligibilityRequest,
) -> Result<ModelEligibility, AppError> {
    let task = parse_task(&row.task)?;
    let endpoint = parse_endpoint(&row.endpoint)?;
    let (estimated_seconds, estimate_quality) = estimate_for(row, inv.patients);

    // The requirement guard (DEC-6): a model with no recorded requirement at
    // all is cannot_run + MODEL_REQUIREMENTS_UNRECORDED — never a silent
    // "looks fine" on absent facts.
    if requirements_unrecorded(row) {
        return Ok(ModelEligibility {
            id: row.id.to_string(),
            task,
            endpoint,
            status: EligibilityStatus::CannotRun,
            reasons: vec![ModelReason {
                code: ModelReasonCode::ModelRequirementsUnrecorded,
                params: BTreeMap::new(),
            }],
            missing_markers: Vec::new(),
            coverage: Coverage {
                eligible: 0,
                total: inv.patients,
                fraction: 0.0,
            },
            min_draws: MinDraws {
                required: 0,
                met: 0,
                unmet_patients: 0,
            },
            estimated_seconds,
            estimate_quality,
        });
    }

    let marker_facts: MarkerFacts = parse_cell(&row.marker_facts, "txr_models.marker_facts")?;
    let covariate_facts: CovariateFacts = parse_cell(&row.covariates, "txr_models.covariates")?;
    let features: Vec<String> = parse_cell(&row.features, "txr_models.features")?;
    let required: Option<RequiredMarkers> = match &row.required_markers {
        Some(cell) => Some(parse_cell(cell, "txr_models.required_markers")?),
        None => None,
    };

    let mut reasons: Vec<ModelReason> = Vec::new();
    let mut missing_markers: Vec<MissingMarker> = Vec::new();

    // The file's outcome columns vs the model's recorded task (the same
    // outcome-availability verdicts the catalogue engine emits — the
    // inventory carries them when the consumer knows them; absence skips
    // the checks entirely, never a misclassification).
    if let Some(outcomes) = &inv.outcomes {
        outcome_reasons(task, *outcomes, &mut reasons);
    }

    // Marker presence: the required rule (when recorded) with the provider's
    // matcher; else the recorded features (the instance's marker set).
    let resolved = match &required {
        Some(rule) => required_resolution(inv, rule),
        None => features_resolution(inv, &features),
    };
    if !resolved.missing.is_empty() {
        reasons.push(ModelReason {
            code: ModelReasonCode::RequiredMarkerMissing,
            params: BTreeMap::from([
                (
                    "missing".to_string(),
                    Json::Array(
                        resolved
                            .missing
                            .iter()
                            .map(|id| Json::String(id.clone()))
                            .collect(),
                    ),
                ),
                ("fraction".to_string(), Json::from(resolved.fraction)),
            ]),
        });
        missing_markers = resolved.missing_markers.clone();
    }

    // A model that consumed the detection call needs the file to carry one.
    if marker_facts.needs_detection_call
        && !inv
            .markers
            .iter()
            .any(|mk| mk.is_detection_call || mk.has_detection_companion)
    {
        reasons.push(reason(ModelReasonCode::DetectionCallMissing));
    }

    // The covariate block: the recorded mode + whether the run used
    // covariates — either makes the block part of the model's input schema.
    if (matches!(covariate_facts.catalogue, CovariateMode::Required)
        && inv.covariates.is_empty())
        || (covariate_facts.used && inv.covariates.is_empty())
    {
        reasons.push(reason(ModelReasonCode::CovariateRequiredUnmet));
    }

    // Unit-family compatibility for the matched markers (the vocabulary's
    // family vs the inventory marker's — a percent value never satisfies a
    // concentration-family model; unknown on either side is not a mismatch).
    unit_mismatches(&resolved.used, &mut reasons);

    // Draw coverage + the decision-day rule over the model's used markers.
    let (mut coverage, mut min_draws, no_value) = draw_coverage(inv, &marker_facts, &resolved.used);
    if no_value > 0 {
        reasons.push(ModelReason {
            code: ModelReasonCode::DecisionDayUnmet,
            params: BTreeMap::from([("patients".to_string(), Json::from(no_value))]),
        });
    }
    if min_draws.unmet_patients > 0 {
        reasons.push(ModelReason {
            code: ModelReasonCode::MinDrawsUnmet,
            params: BTreeMap::from([
                ("required".to_string(), Json::from(min_draws.required)),
                ("met".to_string(), Json::from(min_draws.met)),
                (
                    "unmet_patients".to_string(),
                    Json::from(min_draws.unmet_patients),
                ),
            ]),
        });
    }
    // The model's own window: a decision day beyond the file's recorded
    // window end means the counts do not cover the model's requirements — the
    // coverage is not certifiable for ANY patient, so the verdict answers the
    // soft code with an empty eligible set (the counts are about a window the
    // model does not fit).
    if row.decision_day > inv.decision_day {
        reasons.push(ModelReason {
            code: ModelReasonCode::DecisionDayUnmet,
            params: BTreeMap::from([("patients".to_string(), Json::from(inv.patients))]),
        });
        coverage.eligible = 0;
        coverage.fraction = 0.0;
        min_draws.met = 0;
        min_draws.unmet_patients = inv.patients;
    }

    let status = verdict(&reasons, coverage.eligible, coverage.total);
    Ok(ModelEligibility {
        id: row.id.to_string(),
        task,
        endpoint,
        status,
        reasons,
        missing_markers,
        coverage,
        min_draws,
        estimated_seconds,
        estimate_quality,
    })
}

fn reason(code: ModelReasonCode) -> ModelReason {
    ModelReason {
        code,
        params: BTreeMap::new(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The outcome-availability verdicts (the catalogue engine's, by task)
// ─────────────────────────────────────────────────────────────────────────────

fn outcome_reasons(
    task: Option<TxrTask>,
    outcomes: crate::modules::method_catalogue::types::FileOutcomes,
    reasons: &mut Vec<ModelReason>,
) {
    let task_response = task == Some(TxrTask::Response);
    let task_survival = matches!(task, Some(TxrTask::Pfs) | Some(TxrTask::Os));
    let has_response = outcomes.has_responder && outcomes.has_response_day;
    let has_survival = outcomes.has_event && outcomes.has_survival_day;
    if task_response && !has_response {
        reasons.push(ModelReason {
            code: ModelReasonCode::ResponseLabelMissing,
            params: BTreeMap::from([(
                "required".to_string(),
                Json::String("responder,response_day".to_string()),
            )]),
        });
    } else if task_survival && !has_survival {
        reasons.push(ModelReason {
            code: ModelReasonCode::SurvivalOutcomeMissing,
            params: BTreeMap::from([(
                "required".to_string(),
                Json::String("event,survival_day".to_string()),
            )]),
        });
    } else if task_survival
        || task_response
    {
        if (has_response || has_survival)
            && !((task_response && has_response) || (task_survival && has_survival))
        {
            reasons.push(ModelReason {
                code: ModelReasonCode::TaskIncompatible,
                params: BTreeMap::from([
                    (
                        "task".to_string(),
                        Json::String(task.map(|t| t.as_str().to_string()).unwrap_or_default()),
                    ),
                    (
                        "file_outcome".to_string(),
                        Json::String(
                            if has_response && has_survival {
                                "response,survival"
                            } else if has_response {
                                "response"
                            } else {
                                "survival"
                            }
                            .to_string(),
                        ),
                    ),
                ]),
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker presence (the provider's rules)
// ─────────────────────────────────────────────────────────────────────────────

/// The resolution of a model's marker requirements in the inventory.
struct Resolution<'a> {
    /// The inventory markers the model consumes (the coverage surface).
    used: Vec<&'a InventoryMarker>,
    /// The missing marker ids (the rule's vocabulary / the feature names).
    missing: Vec<String>,
    /// The matched fraction (`matched / required`).
    fraction: f64,
    /// The display rows for [`super::types::MissingMarker`].
    missing_markers: Vec<MissingMarker>,
}

/// A recorded `required_markers` rule against the inventory, through the
/// catalogue's OWN matcher (`required_marker_match` — the data.py port): the
/// inventory's value markers become the port's rows (the standard-id text is
/// the marker's recorded id set re-spelled in the systems' canonical text
/// forms, so `parse_standard_ids` round-trips it exactly; the `other`-system
/// name/feature fallback rides the row's marker + dataset features).
fn required_resolution<'a>(
    inv: &'a InventoryEligibilityRequest,
    required: &RequiredMarkers,
) -> Resolution<'a> {
    let rows: Vec<UnitMarkerRow> = inv
        .markers
        .iter()
        .filter(|mk| !mk.is_detection_call)
        .map(|mk| UnitMarkerRow {
            marker: mk.key.clone(),
            standard_id: standard_id_text(mk),
            dataset_features: vec![mk.key.clone(), mk.display_name.clone()],
            status: "mapped".to_string(),
        })
        .collect();
    let features: Vec<String> = rows
        .iter()
        .flat_map(|r| r.dataset_features.iter().cloned())
        .collect();
    let matched = required_marker_match(&rows, &features, required);
    let used: Vec<&InventoryMarker> = inv
        .markers
        .iter()
        .filter(|mk| !mk.is_detection_call)
        .filter(|mk| {
            matched.features.iter().any(|f| {
                f.eq_ignore_ascii_case(&mk.key) || f.eq_ignore_ascii_case(&mk.display_name)
            })
        })
        .collect();
    let missing_markers = matched
        .missing_ids
        .iter()
        .map(|id| {
            let orig = required
                .markers
                .iter()
                .find(|rm| rm.id.trim().to_ascii_lowercase() == *id)
                .cloned()
                .unwrap_or(crate::modules::method_catalogue::types::RequiredMarker {
                    name: String::new(),
                    id_system: String::new(),
                    id: id.clone(),
                });
            display_of(orig.id_system.as_str(), &orig.id, &orig.name)
        })
        .collect();
    Resolution {
        used,
        missing: matched.missing_ids,
        fraction: matched.fraction,
        missing_markers,
    }
}

/// A recorded-feature model (no fixed rule — `any`/`multi`): every recorded
/// feature must resolve in the inventory (name equality, standard-id text,
/// vocabulary names — see the module doc).
fn features_resolution<'a>(
    inv: &'a InventoryEligibilityRequest,
    features: &[String],
) -> Resolution<'a> {
    let mut used: Vec<&InventoryMarker> = Vec::new();
    let mut missing = Vec::new();
    let mut missing_markers = Vec::new();
    let mut matched = 0usize;
    for feature in features {
        match inv
            .markers
            .iter()
            .filter(|mk| !mk.is_detection_call)
            .find(|mk| feature_matches(mk, feature))
        {
            Some(mk) => {
                if !used.iter().any(|u| std::ptr::eq(*u, mk)) {
                    used.push(mk);
                }
                matched += 1;
            }
            None => {
                missing.push(feature.trim().to_ascii_lowercase());
                missing_markers.push(display_of("other", feature.trim(), feature.trim()));
            }
        }
    }
    Resolution {
        used,
        missing,
        fraction: if features.is_empty() {
            0.0
        } else {
            matched as f64 / features.len() as f64
        },
        missing_markers,
    }
}

/// Whether a recorded feature resolves in an inventory marker: case-
/// insensitive equality against the marker's key/display name, a standard-id
/// text of the feature against the marker's recorded ids, or the marker's
/// vocabulary name/alias surface (the provider's `other`-system fallback).
fn feature_matches(mk: &InventoryMarker, feature: &str) -> bool {
    let f = feature.trim();
    if mk.key.eq_ignore_ascii_case(f) || mk.display_name.eq_ignore_ascii_case(f) {
        return true;
    }
    let ids = parse_standard_ids(f);
    if !ids.is_empty() {
        for sid in &mk.standard_ids {
            if ids.contains(&sid.id.to_ascii_lowercase()) {
                return true;
            }
        }
    }
    names_of(mk).contains(&f.to_ascii_lowercase())
}

/// The vocabulary entry for a `(system, id)` pair — the catalogue engine's
/// own comparison (case-insensitive on both; the validator's resolved ids are
/// canonical-cased, a foreign inventory must not silently skip the
/// vocabulary checks). One definition for the unit-family, name and display
/// lookups below.
fn vocab_marker(system: &str, id: &str) -> Option<&'static crate::modules::method_catalogue::types::VocabularyMarker> {
    catalogue::marker_vocabulary()
        .iter()
        .find(|v| v.system.as_str().eq_ignore_ascii_case(system) && v.id.eq_ignore_ascii_case(id))
}

/// The names a file marker answers to (its own + the resolved vocabulary
/// marker's names/aliases — the definition the catalogue engine uses; the
/// store binds it, never re-derives a marker list).
fn names_of(mk: &InventoryMarker) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    names.insert(mk.key.trim().to_ascii_lowercase());
    names.insert(mk.display_name.trim().to_ascii_lowercase());
    for sid in &mk.standard_ids {
        if let Some(v) = vocab_marker(&sid.system, &sid.id) {
            names.insert(v.id.to_ascii_lowercase());
            names.insert(v.display_name.trim().to_ascii_lowercase());
            for a in &v.aliases {
                names.insert(a.trim().to_ascii_lowercase());
            }
        }
    }
    names
}

/// The row's standard-id text for the provider's `parse_standard_ids` — each
/// recorded `(system, id)` re-spelled in the system's canonical text form
/// (the parser's clause vocabulary). LOINC codes travel one clause per code
/// (the parser's `[...]`-clause split joins on separators, not commas).
fn standard_id_text(mk: &InventoryMarker) -> String {
    let mut parts: Vec<String> = Vec::new();
    for sid in &mk.standard_ids {
        let sys = sid.system.to_ascii_lowercase();
        let clause = match sys.as_str() {
            "loinc" => format!("LOINC {}", sid.id),
            "hgnc" => format!("HGNC: {}", sid.id),
            "uniprot" => format!("UniProt {}", sid.id),
            "hmdb" => format!("HMDB{}", sid.id),
            "mirbase" => format!("MIMAT{}", sid.id.trim_start_matches("MIMAT")),
            _ => continue,
        };
        parts.push(clause);
    }
    parts.join("; ")
}

/// The `MissingMarker` row for a required id/feature — the display name from
/// the vocabulary, the group id from the vocabulary's first group (the
/// catalogue engine's construction).
fn display_of(id_system: &str, id: &str, name: &str) -> MissingMarker {
    let vocab = vocab_marker(id_system, id);
    MissingMarker {
        id: id.to_string(),
        id_system: id_system.to_string(),
        display_name: vocab
            .map(|v| v.display_name.clone())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| name.to_string()),
        group_id: vocab.and_then(|v| v.groups.first().cloned()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit mismatch + draw coverage (the catalogue engine's semantics)
// ─────────────────────────────────────────────────────────────────────────────

/// The unit-family verdicts for the matched markers (a present required
/// marker must be measured in the vocabulary's family; an unknown family on
/// either side is not a mismatch, and `other`-system markers have no
/// canonical family).
fn unit_mismatches(used: &[&InventoryMarker], reasons: &mut Vec<ModelReason>) {
    for mk in used {
        for sid in &mk.standard_ids {
            if sid.system.eq_ignore_ascii_case("other") {
                continue;
            }
            if let Some(vocab) = vocab_marker(&sid.system, &sid.id) {
                if vocab.unit_family != UnitFamily::None
                    && mk.unit_family != UnitFamily::None
                    && vocab.unit_family != mk.unit_family
                {
                    reasons.push(ModelReason {
                        code: ModelReasonCode::UnitMismatch,
                        params: BTreeMap::from([
                            ("marker".to_string(), Json::String(vocab.id.clone())),
                            (
                                "method_family".to_string(),
                                Json::String(format!("{:?}", vocab.unit_family)),
                            ),
                            (
                                "file_family".to_string(),
                                Json::String(format!("{:?}", mk.unit_family)),
                            ),
                        ]),
                    });
                }
            }
        }
    }
}

/// The draw coverage over the model's used markers (the catalogue engine's
/// rule): the per-patient draw count is the MAX per-marker count (a visit row
/// carries every marker measured that visit); `needs_baseline` requires a
/// baseline draw of at least one used marker; (0,0)-counted and absent
/// patients are the ones with no value at all ≤ the decision day.
fn draw_coverage(
    inv: &InventoryEligibilityRequest,
    facts: &MarkerFacts,
    used: &[&InventoryMarker],
) -> (Coverage, MinDraws, u32) {
    let mut per_patient: BTreeMap<&str, u32> = BTreeMap::new();
    let mut baseline: BTreeMap<&str, bool> = BTreeMap::new();
    let mut exact = true;
    for mk in used {
        match &mk.per_patient {
            Some(entries) => {
                for e in entries {
                    let draws = e.baseline_draws + e.ontreatment_draws;
                    let cur = per_patient.get(e.patient_key.as_str()).copied().unwrap_or(0);
                    if draws > cur {
                        per_patient.insert(&e.patient_key, draws);
                    }
                    if e.baseline_draws > 0 {
                        baseline.insert(&e.patient_key, true);
                    }
                }
            }
            None => {
                exact = false;
                break;
            }
        }
    }
    let total = inv.patients;
    let (eligible, no_value, min_draws) = if exact {
        let mut eligible_count: u32 = 0;
        let mut zero_draws: u32 = 0;
        for (key, draws) in &per_patient {
            if *draws == 0 {
                zero_draws += 1;
                continue;
            }
            let has_baseline = baseline.get(key).copied().unwrap_or(false);
            let meets_draws = facts.min_draws == 0 || *draws >= facts.min_draws;
            if meets_draws && (!facts.needs_baseline || has_baseline) {
                eligible_count += 1;
            }
        }
        let absent = total.saturating_sub(per_patient.len() as u32);
        let no_value_count = zero_draws.saturating_add(absent).min(total);
        let eligible = eligible_count.min(total);
        (
            eligible,
            no_value_count,
            MinDraws {
                required: facts.min_draws,
                met: eligible,
                unmet_patients: total - eligible,
            },
        )
    } else {
        let mut best_value: u32 = 0;
        let mut best_cohort: u32 = 0;
        for mk in used {
            let cohort = if facts.needs_baseline {
                mk.n_patients_with_baseline.min(mk.n_patients_with_ontreatment)
            } else {
                mk.n_patients_with_ontreatment
            };
            if mk.n_patients_with_value > best_value {
                best_value = mk.n_patients_with_value;
                best_cohort = cohort;
            }
        }
        let eligible = best_cohort.min(total);
        let no_value = best_value.saturating_sub(best_cohort).min(total);
        (
            eligible,
            no_value,
            MinDraws {
                required: facts.min_draws,
                met: eligible,
                unmet_patients: total - eligible,
            },
        )
    };
    let fraction = if total == 0 {
        0.0
    } else {
        round3(eligible as f64 / total as f64)
    };
    (
        Coverage {
            eligible,
            total,
            fraction,
        },
        min_draws,
        no_value,
    )
}

/// The wire fraction is rounded to 3 decimals (the format's own
/// round — the catalogue engine's `round3`).
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// The catalogue's verdict lattice, verbatim: a hard reason is `cannot_run`;
/// otherwise the draw coverage decides `can_run_some` vs `can_run`.
fn verdict(reasons: &[ModelReason], eligible: u32, total: u32) -> EligibilityStatus {
    let hard = reasons.iter().any(|r| {
        matches!(
            r.code,
            ModelReasonCode::NotRunnable
                | ModelReasonCode::RequiredMarkerMissing
                | ModelReasonCode::MarkerGroupMissing
                | ModelReasonCode::DetectionCallMissing
                | ModelReasonCode::CovariateMissing
                | ModelReasonCode::CovariateRequiredUnmet
                | ModelReasonCode::UnitMismatch
                | ModelReasonCode::TaskIncompatible
                | ModelReasonCode::ResponseLabelMissing
                | ModelReasonCode::SurvivalOutcomeMissing
        )
    });
    if hard {
        EligibilityStatus::CannotRun
    } else if eligible < total {
        EligibilityStatus::CanRunSome
    } else {
        EligibilityStatus::CanRun
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MS-11 / TEST-MS-12 — the per-model verdict matrix over synthetic rows +
// inventories (patient ids S0000.., markers M1/M2 — never real patient data;
// every verdict's reason code is the PROV-MC-5 vocabulary spelled identically
// + the one store code).
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::types::{FileOutcomes, PatientDrawCounts, StandardId};
    use chrono::{DateTime, Utc};
    use serde_json::json;

    fn base_row(method_id: &str) -> ModelRow {
        ModelRow {
            id: Uuid::new_v4(),
            set_id: None,
            name: format!("{method_id} trained model"),
            method_id: method_id.to_string(),
            method_version: "2.0.0".to_string(),
            group: "landmark".to_string(),
            group_label: "Landmark stats".to_string(),
            task: Some("pfs".to_string()),
            provenance: "run".to_string(),
            imported_from: None,
            pretrained_catalogue_id: None,
            pretrained_catalogue_version: None,
            licence: None,
            tree_sha256: "0".repeat(64),
            dir: "/data/models/trees/x".to_string(),
            size_bytes: 4096,
            contract: "2.0".to_string(),
            env_base_digest: Some("sha256:base0000".to_string()),
            env_layer_digest: Some("sha256:layer000".to_string()),
            trained_on_patients: Some(151),
            trained_at: Some(
                "2026-10-19T14:30:00+00:00"
                    .parse::<DateTime<Utc>>()
                    .expect("fixture timestamp parses"),
            ),
            decision_day: 56.0,
            endpoint: "pfs".to_string(),
            horizon: 238.0,
            features: json!(["M1"]),
            required_markers: None,
            marker_facts: json!({"kind": "single", "count": 1, "min_draws": 1, "needs_baseline": false, "uses_history": "landmark", "needs_detection_call": false, "marker_groups_required": []}),
            covariates: json!({"catalogue": "none", "used": false}),
            embeds_training_data: false,
            own_auc: Some(0.66),
            own_c: Some(0.63),
            created_at: "2026-10-19T15:00:00+00:00"
                .parse::<DateTime<Utc>>()
                .expect("fixture timestamp parses"),
        }
    }

    fn marker(
        key: &str,
        display: &str,
        family: UnitFamily,
        stds: Vec<&str>,
        per: Vec<(&str, u32, u32)>,
        detection: bool,
    ) -> InventoryMarker {
        InventoryMarker {
            key: key.to_string(),
            display_name: display.to_string(),
            unit_family: family,
            standard_ids: stds
                .iter()
                .map(|s| {
                    let (system, id) = s.split_once(':').expect("system:id fixture");
                    StandardId {
                        system: system.to_string(),
                        id: id.to_string(),
                    }
                })
                .collect(),
            is_detection_call: detection,
            has_detection_companion: false,
            n_patients_with_value: per.len() as u32,
            n_patients_with_baseline: per.iter().filter(|(_, b, _)| *b > 0).count() as u32,
            n_patients_with_ontreatment: per.iter().filter(|(_, _, o)| *o > 0).count() as u32,
            per_patient: Some(
                per.iter()
                    .map(|(p, b, o)| PatientDrawCounts {
                        patient_key: p.to_string(),
                        baseline_draws: *b,
                        ontreatment_draws: *o,
                    })
                    .collect(),
            ),
        }
    }

    fn inventory(markers: Vec<InventoryMarker>, patients: u32, decision_day: f64) -> InventoryEligibilityRequest {
        InventoryEligibilityRequest {
            patients,
            decision_day,
            baseline_max_day: 0.0,
            markers,
            covariates: Vec::new(),
            outcomes: Some(FileOutcomes {
                has_responder: false,
                has_response_day: false,
                has_event: true,
                has_survival_day: true,
            }),
        }
    }

    fn code_names(v: &ModelEligibility) -> Vec<&'static str> {
        v.reasons.iter().map(|r| r.code.as_str()).collect()
    }

    /// TEST-MS-11 (acceptance, INV-4) — the happy path: all recorded
    /// requirements met → `can_run` with NO reason; the estimate is the
    /// catalogue estimator's value for the model's method at the file's
    /// patient count (a REAL catalogue method — the one PROV-MC-6 formula).
    #[test]
    fn verdict_can_run_with_the_catalogue_estimate() {
        let row = base_row("cox-cutpoint-risk");
        let inv = inventory(
            vec![
                marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2), ("S0002", 1, 3)], false),
            ],
            2,
            56.0,
        );
        let v = model_verdict(&row, &inv).expect("verdict");
        assert_eq!(v.status, EligibilityStatus::CanRun);
        assert!(v.reasons.is_empty(), "{:?}", code_names(&v));
        assert_eq!(v.task, Some(TxrTask::Pfs));
        assert_eq!(v.endpoint, TxrEndpoint::Pfs);
        assert_eq!(v.coverage.eligible, 2);
        assert_eq!(v.coverage.total, 2);
        assert_eq!(v.coverage.fraction, 1.0);
        assert_eq!(v.min_draws.required, 1);
        assert_eq!(v.min_draws.unmet_patients, 0);
        let m = catalogue::method("cox-cutpoint-risk").expect("catalogue method");
        assert_eq!(
            v.estimated_seconds,
            Some(estimate_seconds_for(m, 2, DEFAULT_ESTIMATE_CPUS)),
            "the catalogue estimator's value"
        );
        assert_eq!(v.estimate_quality, estimate_quality_for(m));
    }

    /// TEST-MS-11 — a model of a method the app no longer ships (absent from
    /// the compiled catalogue): the verdict stands (recorded facts are the
    /// check), the time is NOT promised — seconds null, the weaker `estimate`
    /// quality.
    #[test]
    fn absent_method_verdict_stands_without_a_time() {
        let row = base_row("retired-imported-method");
        let inv = inventory(
            vec![marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let v = model_verdict(&row, &inv).expect("verdict");
        assert_eq!(v.status, EligibilityStatus::CanRun);
        assert!(v.estimated_seconds.is_none());
        assert_eq!(v.estimate_quality, TimingQuality::Estimate);
    }

    /// TEST-MS-11 — `can_run_some` with `MIN_DRAWS_UNMET` + the coverage
    /// counts (2 of 4 patients meet the recorded draw rule).
    #[test]
    fn verdict_can_run_some_with_min_draws_unmet() {
        let mut row = base_row("landmark-cox-current");
        row.marker_facts = json!({"kind": "single", "count": 1, "min_draws": 2, "needs_baseline": true, "uses_history": "landmark", "needs_detection_call": false, "marker_groups_required": []});
        let inv = inventory(
            vec![
                marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2), ("S0002", 0, 3), ("S0003", 1, 0), ("S0004", 0, 0)], false),
            ],
            4,
            56.0,
        );
        let v = model_verdict(&row, &inv).expect("verdict");
        assert_eq!(v.status, EligibilityStatus::CanRunSome);
        assert!(
            v.reasons.iter().any(|r| r.code == ModelReasonCode::MinDrawsUnmet),
            "{:?}",
            code_names(&v)
        );
        assert_eq!(v.coverage.eligible, 1);
        assert_eq!(v.coverage.total, 4);
        assert_eq!(v.coverage.fraction, 0.25);
        assert_eq!(v.min_draws.required, 2);
        assert_eq!(v.min_draws.unmet_patients, 3);
        // The (0,0) patient has values only after the decision day.
        assert!(v
            .reasons
            .iter()
            .any(|r| r.code == ModelReasonCode::DecisionDayUnmet));
    }

    /// TEST-MS-11 — the hard refusals, each with the PROV-MC-5 code spelled
    /// identically: a recorded marker absent from the file's vocabulary
    /// (REQUIRED_MARKER_MISSING), a unit-family mismatch for a present marker,
    /// a missing detection call, a recorded decision day beyond the file's
    /// window (DECISION_DAY_UNMET), and a required covariate block absent.
    #[test]
    fn verdict_cannot_run_reasons_are_typed() {
        // A fixed-rule panel model (the data.py port's own match semantics):
        // LOINC 2039-6 recorded as required, absent from the file.
        let mut row = base_row("glmnet-cph");
        row.features = json!(["CEA_serum"]);
        row.required_markers = Some(json!({"markers": [{"name": "CEA", "id_system": "LOINC", "id": "2039-6"}], "match": "all", "min_fraction": 0.0, "list_source": "catalogue"}));
        let inv = inventory(
            vec![marker("LDH", "LDH", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let v = model_verdict(&row, &inv).expect("verdict");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v
            .reasons
            .iter()
            .any(|r| r.code == ModelReasonCode::RequiredMarkerMissing));
        assert_eq!(v.missing_markers.len(), 1);
        assert_eq!(v.missing_markers[0].id, "2039-6");
        assert_eq!(
            v.missing_markers[0].display_name,
            "carcinoembryonic antigen (CEA, ng/mL)",
            "the vocabulary display name"
        );
        assert_eq!(
            v.missing_markers[0].group_id.as_deref(),
            Some("tumour-markers"),
            "the vocabulary group id"
        );

        // Unit family: the file's CEA column is a percent — the vocabulary's
        // family is concentration-mass → UNIT_MISMATCH.
        let mut row2 = base_row("glmnet-cph");
        row2.features = json!(["CEA_serum"]);
        row2.required_markers = Some(json!({"markers": [{"name": "CEA", "id_system": "LOINC", "id": "2039-6"}], "match": "all", "min_fraction": 0.0, "list_source": "catalogue"}));
        let inv2 = inventory(
            vec![marker("CEA_serum", "CEA", UnitFamily::Percent, vec!["LOINC:2039-6"], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let v2 = model_verdict(&row2, &inv2).expect("verdict");
        assert!(v2
            .reasons
            .iter()
            .any(|r| r.code == ModelReasonCode::UnitMismatch));
        assert_eq!(v2.status, EligibilityStatus::CannotRun);

        // Detection call: the model consumed it; the file carries none.
        let mut row3 = base_row("glmnet-cph");
        row3.features = json!(["M1"]);
        row3.marker_facts = json!({"kind": "single", "count": 1, "min_draws": 1, "needs_baseline": false, "uses_history": "landmark", "needs_detection_call": true, "marker_groups_required": []});
        let inv3 = inventory(
            vec![marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let v3 = model_verdict(&row3, &inv3).expect("verdict");
        assert!(v3
            .reasons
            .iter()
            .any(|r| r.code == ModelReasonCode::DetectionCallMissing));
        assert_eq!(v3.status, EligibilityStatus::CannotRun);

        // Decision-day window: the model's recorded 84 is beyond the file's
        // recorded 42 — its coverage cannot be certified from those counts.
        let mut row4 = base_row("glmnet-cph");
        row4.features = json!(["M1"]);
        row4.decision_day = 84.0;
        let inv4 = inventory(
            vec![marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            42.0,
        );
        let v4 = model_verdict(&row4, &inv4).expect("verdict");
        assert!(v4
            .reasons
            .iter()
            .any(|r| r.code == ModelReasonCode::DecisionDayUnmet));
        assert_eq!(v4.status, EligibilityStatus::CanRunSome, "the soft lattice code");

        // Covariates: the model consumed the covariate block; the file posts
        // none.
        let mut row5 = base_row("glmnet-cph");
        row5.covariates = json!({"catalogue": "optional", "used": true});
        let inv5 = inventory(
            vec![marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let v5 = model_verdict(&row5, &inv5).expect("verdict");
        assert!(v5
            .reasons
            .iter()
            .any(|r| r.code == ModelReasonCode::CovariateRequiredUnmet));
        assert_eq!(v5.status, EligibilityStatus::CannotRun);
    }

    /// TEST-MS-11 — the features path: a model without a fixed rule is
    /// matched by its recorded feature names (the instance's marker set), and
    /// a feature that IS a standard-id text resolves through the parser.
    #[test]
    fn verdict_features_presence_resolves_by_name_and_standard_id() {
        let row = base_row("landmark-cox-current");
        // "LOINC 2039-6 CEA" is a standard-id text: parses to 2039-6 → the
        // file marker carrying that id satisfies it (the name M1 too).
        let mut frow = row.clone();
        frow.features = json!(["LOINC 2039-6 CEA", "M1"]);
        let inv = inventory(
            vec![
                marker("CEA_serum", "CEA", UnitFamily::None, vec!["LOINC:2039-6"], vec![("S0001", 1, 2)], false),
                marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false),
            ],
            1,
            56.0,
        );
        let v = model_verdict(&frow, &inv).expect("verdict");
        assert_eq!(v.status, EligibilityStatus::CanRun);
        assert!(
            !v.reasons.iter().any(|r| r.code == ModelReasonCode::RequiredMarkerMissing),
            "both features resolved"
        );

        // A missing feature → REQUIRED_MARKER_MISSING with the feature name.
        let mut grow = frow.clone();
        grow.features = json!(["M1", "LDH"]);
        let inv2 = inventory(
            vec![marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let v2 = model_verdict(&grow, &inv2).expect("verdict");
        assert!(v2
            .reasons
            .iter()
            .any(|r| r.code == ModelReasonCode::RequiredMarkerMissing));
        assert_eq!(v2.missing_markers[0].id, "LDH");
        assert_eq!(v2.missing_markers[0].id_system, "other");
        assert_eq!(v2.status, EligibilityStatus::CannotRun);
    }

    /// TEST-MS-12 (acceptance, INV-4) — the endpoint never returns a verdict
    /// without a computed reason: a model whose requirements cannot be
    /// transcribed (no rule, no feature list — even with marker facts) is
    /// `cannot_run` + `MODEL_REQUIREMENTS_UNRECORDED`, never `can_run` on
    /// absent facts.
    #[test]
    fn never_can_run_on_absent_facts() {
        let mut row = base_row("glmnet-cph");
        row.features = json!([]);
        let inv = inventory(
            vec![marker("M1", "M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let v = model_verdict(&row, &inv).expect("verdict");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert_eq!(v.reasons.len(), 1);
        assert_eq!(v.reasons[0].code, ModelReasonCode::ModelRequirementsUnrecorded);
        assert_eq!(v.coverage.eligible, 0);
        // No second reason: the ONE added code carries the verdict.
        assert_eq!(v.missing_markers.len(), 0);
    }

    /// TEST-MS-12 — the marker matching IS the catalogue's
    /// `required_marker_match`: the store's row-building + the port's result
    /// agree for the same rows/features, so a drift in the provider's
    /// semantics cannot pass silently.
    #[test]
    fn marker_matching_is_the_catalogue_port() {
        let required: RequiredMarkers = serde_json::from_value(json!({
            "markers": [{"name": "CEA", "id_system": "LOINC", "id": "2039-6"}],
            "match": "all",
            "min_fraction": 0.0,
            "list_source": "catalogue",
        }))
        .expect("required parses");
        let inv = inventory(
            vec![
                marker("CEA_serum", "CEA", UnitFamily::None, vec!["LOINC:2039-6"], vec![("S0001", 1, 2)], false),
                marker("LDH", "LDH", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false),
            ],
            1,
            56.0,
        );
        let port_rows: Vec<UnitMarkerRow> = inv
            .markers
            .iter()
            .map(|mk| UnitMarkerRow {
                marker: mk.key.clone(),
                standard_id: standard_id_text(mk),
                dataset_features: vec![mk.key.clone(), mk.display_name.clone()],
                status: "mapped".to_string(),
            })
            .collect();
        let features: Vec<String> = port_rows
            .iter()
            .flat_map(|r| r.dataset_features.iter().cloned())
            .collect();
        let port = required_marker_match(&port_rows, &features, &required);
        assert!(port.ok, "the port resolves the recorded id");
        assert_eq!(port.matched_ids, vec!["2039-6"]);

        // The store's required_resolution reports the SAME matched set (the
        // used marker is the CEA column, the missing set is empty).
        let r = required_resolution(&inv, &required);
        assert!(r.missing.is_empty());
        assert_eq!(r.used.len(), 1);
        assert_eq!(r.used[0].key, "CEA_serum");
        assert_eq!(r.fraction, 1.0);

        // A missing required id is the port's own missing set, verbatim.
        let inv2 = inventory(
            vec![marker("LDH", "LDH", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
        );
        let r2 = required_resolution(&inv2, &required);
        assert_eq!(r2.missing, vec!["2039-6"]);
        assert_eq!(r2.fraction, 0.0);
        assert!(r2.used.is_empty());
    }
}
