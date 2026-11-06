//! ITEM-5 — the per-model eligibility engine (PROV-PC-8 / DEC-10): a
//! pretrained catalogue entry's RECORDED `needs` against the file's inventory
//! — the D list's "Can run / Can run for some patients / Cannot run" per
//! model, computed from the catalogue's declared facts, NEVER invented.
//!
//! ## The verdict is about the entry's declared needs
//!
//! The inputs are the entry's `needs` block (marker facts, required markers,
//! covariates, decision day, task) plus the current method catalogue only
//! where the plan names it: the runnable check (`NOT_RUNNABLE` — a method no
//! longer runnable in the current catalogue, PROV-PC-8) and the timing
//! estimator (`estimate_seconds_for` / `estimate_quality_for` — PROV-MC-6's
//! one formula; an entry whose method is absent still gets a verdict, without
//! a time). The method's marker-facts vocabulary and the draw-count
//! interpretation are the provider's, so a pretrained model's "Can run" means
//! the same thing as the method's (DEC-10).
//!
//! ## The matching binds the provider's own rules (PROV-MC-7)
//!
//! - A recorded `required_markers` rule (a `single`/`panel` published rule
//!   names its markers) is matched with `required_marker_match` over rows
//!   built from the inventory exactly as `model_store`'s saved-model engine
//!   builds them — the two paths are the ONE matching rule, so the same
//!   inventory against the installed row and against the catalogue entry
//!   answers identically (TEST-PC-14's parity, for the rule-carrying entries
//!   both providers share).
//! - An entry WITHOUT a fixed list (`any`/`multi`) consumes the file's value
//!   markers as candidates — the catalogue method inventory engine's rule
//!   (the recorded `needs` carry no instance feature list, so the D-list
//!   verdict cannot bind one; the installed row's feature list is the
//!   store-side record, a different surface).
//! - Every other check (detection call, covariate block, unit families on the
//!   matched markers, draw coverage, the decision-day window) mirrors the
//!   catalogue + model-store inventory semantics verbatim — the SAME
//!   interpretation notes (coverage is the MAX per-marker per-patient count;
//!   a (0,0)-counted or absent patient has values only after the decision
//!   day → `DECISION_DAY_UNMET`; the fallback marker-level counts when the
//!   per-patient lists are omitted; a model's decision day beyond the file's
//!   window end means the counts do not cover the model's requirements →
//!   empty eligible set).
//!
//! ## The two pretrained-only rules
//!
//! - **`NOT_RUNNABLE`** — the entry's method is absent from the current
//!   method catalogue or no longer runnable (a live catalogue may be newer
//!   than this build — CONS-PC-2's exclusion — so the verdict answers it
//!   instead of a whole-catalogue degrade).
//! - **`ASSET_NOT_AVAILABLE`** — the entry's asset is neither present as a
//!   verified bundle nor downloadable (its URL outside the host policy).
//!   Never emitted by the generator (the build gate + the live validator
//!   refuse such entries) — DEFENSIVE in the runtime verdict, pinned by the
//!   unit suite's handcrafted entry. The bundle-presence input is the
//!   route's file check; everything here is pure (no I/O).
//!
//! ## The verdict lattice
//!
//! The catalogue's own lattice, verbatim (PROV-MC-5): a hard reason
//! (`REQUIRED_MARKER_MISSING`, `DETECTION_CALL_MISSING`,
//! `COVARIATE_REQUIRED_UNMET`, `UNIT_MISMATCH`, `TASK_INCOMPATIBLE`,
//! `RESPONSE_LABEL_MISSING`, `SURVIVAL_OUTCOME_MISSING`, `NOT_RUNNABLE`,
//! `ASSET_NOT_AVAILABLE`) is `cannot_run`; otherwise the draw coverage
//! decides `can_run_some` vs `can_run`. `MIN_DRAWS_UNMET` /
//! `DECISION_DAY_UNMET` are the soft reasons the D list renders with the
//! coverage counts.

use std::collections::BTreeMap;

use crate::modules::method_catalogue::catalogue as method_catalogue_catalog;
use crate::modules::method_catalogue::eligibility::{
    estimate_quality_for, estimate_seconds_for, required_marker_match, UnitMarkerRow,
};
use crate::modules::method_catalogue::types::{
    CovariateMode, Coverage, EligibilityStatus, InventoryEligibilityRequest, InventoryMarker,
    MinDraws, MissingMarker, RequiredMarkers, TimingQuality, UnitFamily, DEFAULT_ESTIMATE_CPUS,
};
use crate::modules::pretrained_catalogue::catalogue::host_allowed;
use crate::modules::pretrained_catalogue::types::{
    PretrainedEligibilityEntry, PretrainedEligibilityResponse, PretrainedModel, PretrainedReason,
    PretrainedReasonCode, PretrainedTask,
};

/// One entry's D-list verdict (the pure core — entry + inventory + the
/// method-catalogue lookup, no HTTP, no I/O). `bundled_available` is the
/// route's file check: a verified bundled file IS the asset (INV-8) until
/// then the verdict treats the asset as downloadable when its URL is in the
/// host policy (the only two sources the plan names — PROV-PC-8).
pub fn eligible(
    entry: &PretrainedModel,
    inv: &InventoryEligibilityRequest,
    bundled_available: bool,
) -> PretrainedEligibilityEntry {
    let method = method_catalogue_catalog::method(&entry.method_id);
    let (estimated_seconds, estimate_quality) = match method {
        Some(m) => (
            Some(estimate_seconds_for(m, inv.patients, DEFAULT_ESTIMATE_CPUS)),
            estimate_quality_for(m),
        ),
        None => (None, TimingQuality::Estimate),
    };

    let mut reasons: Vec<PretrainedReason> = Vec::new();
    let mut missing_markers: Vec<MissingMarker> = Vec::new();

    // PROV-PC-8's NOT_RUNNABLE: a method no longer runnable in the current
    // catalogue (absent or not runnable — the same branch the method engine
    // draws for `!runnable`).
    if method.is_none_or(|m| !m.runnable) {
        reasons.push(reason(PretrainedReasonCode::NotRunnable));
    }

    // ASSET_NOT_AVAILABLE (defensive): neither a verified bundled file nor a
    // downloadable URL.
    if !(bundled_available || host_allowed(&entry.asset.url)) {
        reasons.push(reason(PretrainedReasonCode::AssetNotAvailable));
    }

    // Outcome availability (the inventory carries the file's outcome columns
    // when the consumer knows them; absence skips the checks entirely). The
    // task class is the recorded one; a null class means unclassified — no
    // outcome verdict is emitted (mirror of the catalogue's empty-tasks
    // rule).
    if let Some(outcomes) = &inv.outcomes {
        outcome_reasons(entry, outcomes, &mut reasons);
    }

    // Marker presence: the recorded required rule (when present) through the
    // provider's matcher; else the file's value markers are the candidates.
    let resolved = match &entry.needs.required_markers {
        Some(rule) => required_resolution(inv, rule),
        None => open_resolution(inv),
    };
    if !resolved.missing.is_empty() {
        reasons.push(PretrainedReason {
            code: PretrainedReasonCode::RequiredMarkerMissing,
            params: BTreeMap::from([
                (
                    "missing".to_string(),
                    serde_json::Value::Array(
                        resolved
                            .missing
                            .iter()
                            .map(|id| serde_json::Value::String(id.clone()))
                            .collect(),
                    ),
                ),
                ("fraction".to_string(), serde_json::Value::from(resolved.fraction)),
            ]),
            group_id: None,
        });
        missing_markers = resolved.missing_markers.clone();
    }

    // A model that consumed the detection call needs the file to carry one.
    if entry.needs.marker_facts.needs_detection_call
        && !inv
            .markers
            .iter()
            .any(|mk| mk.is_detection_call || mk.has_detection_companion)
    {
        reasons.push(reason(PretrainedReasonCode::DetectionCallMissing));
    }

    // The covariate block: the recorded mode (not names — the facts carry
    // the mode, the file posts the block or not).
    if matches!(entry.needs.covariates, CovariateMode::Required) && inv.covariates.is_empty() {
        reasons.push(reason(PretrainedReasonCode::CovariateRequiredUnmet));
    }

    // Unit-family compatibility for the match. The catalogue engine applies
    // it to a FIXED rule's matched markers only (a rule-less `any` method
    // consumes whatever the file carries — an unrelated mismatched marker
    // must not fail the whole verdict).
    if entry.needs.required_markers.is_some() {
        unit_mismatches(&resolved.used, &mut reasons);
    }

    // Draw coverage + the decision-day rule over the used markers.
    let (mut coverage, mut min_draws, no_value) =
        draw_coverage(inv, &entry.needs.marker_facts, &resolved.used);
    if no_value > 0 {
        reasons.push(PretrainedReason {
            code: PretrainedReasonCode::DecisionDayUnmet,
            params: BTreeMap::from([("patients".to_string(), serde_json::Value::from(no_value))]),
            group_id: None,
        });
    }
    if min_draws.unmet_patients > 0 {
        reasons.push(PretrainedReason {
            code: PretrainedReasonCode::MinDrawsUnmet,
            params: BTreeMap::from([
                ("required".to_string(), serde_json::Value::from(min_draws.required)),
                ("met".to_string(), serde_json::Value::from(min_draws.met)),
                (
                    "unmet_patients".to_string(),
                    serde_json::Value::from(min_draws.unmet_patients),
                ),
            ]),
            group_id: None,
        });
    }
    // The model's own window (the model-store rule, parity-bound): a
    // decision day beyond the file's recorded window end means the counts do
    // not cover the model's requirements — the coverage is not certifiable
    // for ANY patient, so the verdict answers the soft code with an empty
    // eligible set.
    if entry.needs.decision_day > inv.decision_day {
        reasons.push(PretrainedReason {
            code: PretrainedReasonCode::DecisionDayUnmet,
            params: BTreeMap::from([
                ("patients".to_string(), serde_json::Value::from(inv.patients)),
            ]),
            group_id: None,
        });
        coverage.eligible = 0;
        coverage.fraction = 0.0;
        min_draws.met = 0;
        min_draws.unmet_patients = inv.patients;
    }

    let status = verdict(&reasons, coverage.eligible, coverage.total);
    PretrainedEligibilityEntry {
        id: entry.id.clone(),
        status,
        reasons,
        missing_markers,
        coverage,
        min_draws,
        estimated_seconds,
        estimate_quality,
    }
}

/// The response over a request-ordered id list (the route validated the ids'
/// presence + bounds first — an id unseen here is a caller bug, never a
/// silently dropped row).
pub fn eligibility_response(
    active: &[PretrainedModel],
    ids: &[String],
    inv: &InventoryEligibilityRequest,
    bundled_available: &BTreeMap<String, bool>,
) -> PretrainedEligibilityResponse {
    let entries: Vec<PretrainedEligibilityEntry> = ids
        .iter()
        .filter_map(|id| {
            active
                .iter()
                .find(|m| m.id == *id)
                .map(|m| eligible(m, inv, bundled_available.get(id).copied().unwrap_or(false)))
        })
        .collect();
    finish(entries, ids.len())
}

/// The totals (each = the count of that status; the sum is the request's
/// length — the route's unknown-id disagreement is a caller bug).
fn finish(entries: Vec<PretrainedEligibilityEntry>, total: usize) -> PretrainedEligibilityResponse {
    let total_fit = entries
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRun)
        .count() as u32;
    let total_some = entries
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRunSome)
        .count() as u32;
    let total_cannot = entries
        .iter()
        .filter(|m| m.status == EligibilityStatus::CannotRun)
        .count() as u32;
    debug_assert_eq!(
        total_fit + total_some + total_cannot,
        total as u32,
        "every requested id yields exactly one verdict"
    );
    PretrainedEligibilityResponse {
        models: entries,
        total_fit,
        total_some,
        total_cannot,
    }
}

fn reason(code: PretrainedReasonCode) -> PretrainedReason {
    PretrainedReason {
        code,
        params: BTreeMap::new(),
        group_id: None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The outcome-availability verdicts (the catalogue engine's, by the recorded
// task class)
// ─────────────────────────────────────────────────────────────────────────────

fn outcome_reasons(
    entry: &PretrainedModel,
    outcomes: &crate::modules::method_catalogue::types::FileOutcomes,
    reasons: &mut Vec<PretrainedReason>,
) {
    let task_response = entry.needs.task == Some(PretrainedTask::Response);
    let task_survival = entry.needs.task == Some(PretrainedTask::Survival);
    if !task_response && !task_survival {
        return; // Unclassified — the file's columns cannot be judged.
    }
    let has_response = outcomes.has_responder && outcomes.has_response_day;
    let has_survival = outcomes.has_event && outcomes.has_survival_day;
    if task_response && !has_response {
        reasons.push(PretrainedReason {
            code: PretrainedReasonCode::ResponseLabelMissing,
            params: BTreeMap::from([(
                "required".to_string(),
                serde_json::Value::String("responder,response_day".to_string()),
            )]),
            group_id: None,
        });
    } else if task_survival && !has_survival {
        reasons.push(PretrainedReason {
            code: PretrainedReasonCode::SurvivalOutcomeMissing,
            params: BTreeMap::from([(
                "required".to_string(),
                serde_json::Value::String("event,survival_day".to_string()),
            )]),
            group_id: None,
        });
    } else if (has_response || has_survival)
        && !((task_response && has_response) || (task_survival && has_survival))
    {
        reasons.push(PretrainedReason {
            code: PretrainedReasonCode::TaskIncompatible,
            params: BTreeMap::from([
                (
                    "task".to_string(),
                    serde_json::Value::String(
                        entry
                            .needs
                            .task
                            .map(|t| match t {
                                PretrainedTask::Survival => "survival",
                                PretrainedTask::Response => "response",
                            })
                            .unwrap_or_default()
                            .to_string(),
                    ),
                ),
                (
                    "file_outcome".to_string(),
                    serde_json::Value::String(
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
            group_id: None,
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker presence (the provider's rules — the matching rule is ONE function,
// `required_marker_match`, never reimplemented)
// ─────────────────────────────────────────────────────────────────────────────

/// The resolution of a rule's requirement in the inventory.
struct Resolution<'a> {
    /// The inventory markers the model consumes (the coverage surface).
    used: Vec<&'a InventoryMarker>,
    /// The missing marker ids (the rule's vocabulary).
    missing: Vec<String>,
    /// The matched fraction (`matched / required`).
    fraction: f64,
    /// The display rows for [`MissingMarker`].
    missing_markers: Vec<MissingMarker>,
}

/// The recorded `required_markers` rule against the inventory, through the
/// catalogue's OWN matcher — the exact construction `model_store`'s engine
/// uses, so the installed row and the catalogue entry answer identically
/// (TEST-PC-14).
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

/// A rule-less entry (`any`/`multi` — no fixed marker list): every value
/// marker of the file is a candidate; nothing is missing by construction
/// (the catalogue method engine's rule; the draw coverage then binds).
fn open_resolution<'a>(inv: &'a InventoryEligibilityRequest) -> Resolution<'a> {
    Resolution {
        used: inv
            .markers
            .iter()
            .filter(|mk| !mk.is_detection_call)
            .collect(),
        missing: Vec::new(),
        fraction: 1.0,
        missing_markers: Vec::new(),
    }
}

/// The row's standard-id text for the provider's `parse_standard_ids` — each
/// recorded `(system, id)` re-spelled in the system's canonical text form
/// (the parser's clause vocabulary; the store's definition, one source).
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

/// The vocabulary entry for a `(system, id)` pair — the catalogue engine's
/// own comparison (case-insensitive on both; a foreign inventory must not
/// silently skip the vocabulary checks).
fn vocab_marker(
    system: &str,
    id: &str,
) -> Option<&'static crate::modules::method_catalogue::types::VocabularyMarker> {
    method_catalogue_catalog::marker_vocabulary()
        .iter()
        .find(|v| v.system.as_str().eq_ignore_ascii_case(system) && v.id.eq_ignore_ascii_case(id))
}

/// The `MissingMarker` row for a required id — the display name from the
/// vocabulary, the group id from the vocabulary's first group (the catalogue
/// engine's construction).
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
fn unit_mismatches(used: &[&InventoryMarker], reasons: &mut Vec<PretrainedReason>) {
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
                    reasons.push(PretrainedReason {
                        code: PretrainedReasonCode::UnitMismatch,
                        params: BTreeMap::from([
                            ("marker".to_string(), serde_json::Value::String(vocab.id.clone())),
                            (
                                "method_family".to_string(),
                                serde_json::Value::String(format!("{:?}", vocab.unit_family)),
                            ),
                            (
                                "file_family".to_string(),
                                serde_json::Value::String(format!("{:?}", mk.unit_family)),
                            ),
                        ]),
                        group_id: None,
                    });
                }
            }
        }
    }
}

/// The draw coverage over the entry's used markers (the catalogue engine's
/// rule): the per-patient draw count is the MAX per-marker count (a visit
/// row carries every marker measured that visit); `needs_baseline` requires a
/// baseline draw of at least one used marker; (0,0)-counted and absent
/// patients are the ones with no value at all ≤ the decision day.
fn draw_coverage(
    inv: &InventoryEligibilityRequest,
    facts: &crate::modules::pretrained_catalogue::types::PretrainedMarkerFacts,
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

/// The wire fraction is rounded to 3 decimals (the exact ratio is derivable
/// from `eligible`/`total`; consumers format the display copy themselves).
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// The status lattice: a hard reason is `cannot_run`; otherwise the draw
/// coverage decides `can_run_some` vs `can_run`.
fn verdict(reasons: &[PretrainedReason], eligible: u32, total: u32) -> EligibilityStatus {
    let hard = reasons.iter().any(|r| {
        matches!(
            r.code,
            PretrainedReasonCode::NotRunnable
                | PretrainedReasonCode::RequiredMarkerMissing
                | PretrainedReasonCode::MarkerGroupMissing
                | PretrainedReasonCode::DetectionCallMissing
                | PretrainedReasonCode::CovariateMissing
                | PretrainedReasonCode::CovariateRequiredUnmet
                | PretrainedReasonCode::UnitMismatch
                | PretrainedReasonCode::TaskIncompatible
                | PretrainedReasonCode::ResponseLabelMissing
                | PretrainedReasonCode::SurvivalOutcomeMissing
                | PretrainedReasonCode::AssetNotAvailable
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
// The TEST-PC-31 (engine half) suite: handcrafted catalogue entries (card
// facts synthetic; patient ids S0000.., markers M1/M2 — never real data)
// over the provider's real matchers, pinning every verdict rule against an
// inventory, plus the totals arithmetic and the response over the real
// embedded method catalogue (the one PROV-MC-6 estimator formula).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::types::{
        FileOutcomes, MarkerKind, PatientDrawCounts, StandardId, UsesHistory,
    };
    use crate::modules::pretrained_catalogue::types::{
        PretrainedAsset, PretrainedEndpoint, PretrainedEnv, PretrainedKind,
        PretrainedMarkerFacts, PretrainedModel, PretrainedNeeds,
    };

    fn marker(
        key: &str,
        family: UnitFamily,
        stds: Vec<&str>,
        per: Vec<(&str, u32, u32)>,
        detection: bool,
    ) -> InventoryMarker {
        InventoryMarker {
            key: key.to_string(),
            display_name: key.to_string(),
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

    fn inventory(
        markers: Vec<InventoryMarker>,
        patients: u32,
        decision_day: f64,
        outcomes: Option<FileOutcomes>,
    ) -> InventoryEligibilityRequest {
        InventoryEligibilityRequest {
            patients,
            decision_day,
            baseline_max_day: 0.0,
            markers,
            covariates: Vec::new(),
            outcomes,
        }
    }

    fn survival_outcomes() -> FileOutcomes {
        FileOutcomes {
            has_responder: false,
            has_response_day: false,
            has_event: true,
            has_survival_day: true,
        }
    }

    fn entry(
        id: &str,
        method_id: &str,
        required: Option<RequiredMarkers>,
        facts: PretrainedMarkerFacts,
        decision_day: f64,
        task: Option<PretrainedTask>,
        url: &str,
        bundled: bool,
    ) -> PretrainedModel {
        PretrainedModel {
            id: id.to_string(),
            version: "1.0.0".to_string(),
            kind: PretrainedKind::PublishedRule,
            name: "Synthetic rule".to_string(),
            description: "A synthetic card fact set.".to_string(),
            method_id: method_id.to_string(),
            method_version: "2.0.0".to_string(),
            group: "response-call".to_string(),
            group_label: "Response call".to_string(),
            paper: None,
            needs: PretrainedNeeds {
                marker_facts: facts,
                required_markers: required,
                covariates: CovariateMode::None,
                decision_day,
                endpoint: PretrainedEndpoint::Pfs,
                horizon: 180.0,
                task,
            },
            env: PretrainedEnv {
                base_digest: format!("sha256:{}", "aa".repeat(32)),
                layer_digest: format!("sha256:{}", "bb".repeat(32)),
            },
            contract: "2.0".to_string(),
            embeds_training_data: false,
            transfer: None,
            assay_warnings: vec![],
            research_notice: true,
            licence: "CC0 1.0".to_string(),
            data_sources: vec![],
            asset: PretrainedAsset {
                bundled,
                file: format!("{id}@1.0.0.txr"),
                url: url.to_string(),
                size_bytes: 8,
                sha256: "ab".repeat(32),
                signature: String::new(),
            },
        }
    }

    fn facts(min_draws: u32, needs_baseline: bool, detection: bool) -> PretrainedMarkerFacts {
        PretrainedMarkerFacts {
            kind: MarkerKind::Single,
            count: 1,
            min_draws,
            needs_baseline,
            uses_history: UsesHistory::Landmark,
            needs_detection_call: detection,
            marker_groups_required: vec![],
        }
    }

    fn code_names(v: &PretrainedEligibilityEntry) -> Vec<&'static str> {
        v.reasons.iter().map(|r| r.code.as_str()).collect()
    }

    /// TEST-PC-31 — the happy path: a rule whose marker (LOINC 2532-0, one
    /// draw, no baseline) is measured for every patient on the file's window
    /// → `can_run`, no reason, the coverage 3/3, the estimate the catalogue
    /// estimator's value for the entry's method ("cox-cutpoint-risk" — a
    /// REAL runnable method, one PROV-MC-6 formula).
    #[test]
    fn verdict_can_run_with_the_catalogue_estimate() {
        let e = entry(
            "fx-rule-001",
            "cox-cutpoint-risk",
            Some(RequiredMarkers {
                markers: vec![crate::modules::method_catalogue::types::RequiredMarker {
                    name: "LDH".to_string(),
                    id_system: "LOINC".to_string(),
                    id: "2532-0".to_string(),
                }],
                match_mode: crate::modules::method_catalogue::types::MatchMode::All,
                min_fraction: 0.0,
                list_source: "test".to_string(),
            }),
            facts(1, false, false),
            56.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-001@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec!["LOINC:2532-0"], vec![("S0001", 1, 2), ("S0002", 1, 3), ("S0003", 1, 1)], false)],
            3,
            56.0,
            Some(survival_outcomes()),
        );
        let v = eligible(&e, &inv, false);
        assert_eq!(v.status, EligibilityStatus::CanRun);
        assert!(v.reasons.is_empty(), "{:?}", code_names(&v));
        assert_eq!(v.coverage.eligible, 3);
        assert_eq!(v.coverage.total, 3);
        assert_eq!(v.coverage.fraction, 1.0);
        assert_eq!(v.min_draws.required, 1);
        assert_eq!(v.min_draws.unmet_patients, 0);
        assert!(v.missing_markers.is_empty());
        let m = method_catalogue_catalog::method("cox-cutpoint-risk").expect("method");
        assert_eq!(
            v.estimated_seconds,
            Some(estimate_seconds_for(m, 3, DEFAULT_ESTIMATE_CPUS)),
            "the catalogue estimator's value"
        );
        assert_eq!(v.estimate_quality, estimate_quality_for(m));
    }

    /// TEST-PC-31 — the missing-marker arm: a required marker the file does
    /// not carry → `cannot_run` + `REQUIRED_MARKER_MISSING` with the missing
    /// id + the display row (the vocabulary's display name).
    #[test]
    fn verdict_missing_required_marker_is_cannot_run() {
        let e = entry(
            "fx-rule-002",
            "cox-cutpoint-risk",
            Some(RequiredMarkers {
                markers: vec![
                    crate::modules::method_catalogue::types::RequiredMarker {
                        name: "LDH".to_string(),
                        id_system: "LOINC".to_string(),
                        id: "2532-0".to_string(),
                    },
                    crate::modules::method_catalogue::types::RequiredMarker {
                        name: "CEA".to_string(),
                        id_system: "LOINC".to_string(),
                        id: "2039-6".to_string(),
                    },
                ],
                match_mode: crate::modules::method_catalogue::types::MatchMode::All,
                min_fraction: 0.0,
                list_source: "test".to_string(),
            }),
            facts(1, false, false),
            56.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-002@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec!["LOINC:2532-0"], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            Some(survival_outcomes()),
        );
        let v = eligible(&e, &inv, false);
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(code_names(&v).contains(&"REQUIRED_MARKER_MISSING"));
        assert_eq!(v.missing_markers.len(), 1);
        assert_eq!(v.missing_markers[0].id, "2039-6");
        assert_eq!(v.missing_markers[0].id_system, "LOINC");
    }

    /// TEST-PC-31 — the soft coverage arms: 2 of 4 patients meet a 2-draw +
    /// baseline rule → `can_run_some` with `MIN_DRAWS_UNMET` + the coverage
    /// counts; a patient with (0,0) counts (values only after the decision
    /// day) carries the `DECISION_DAY_UNMET` count.
    #[test]
    fn verdict_can_run_some_with_min_draws_unmet() {
        let e = entry(
            "fx-rule-003",
            "landmark-cox-current",
            None,
            facts(2, true, false),
            56.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-003@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![
                marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2), ("S0002", 0, 3), ("S0003", 0, 1), ("S0004", 0, 0)], false),
            ],
            4,
            56.0,
            Some(survival_outcomes()),
        );
        let v = eligible(&e, &inv, false);
        assert_eq!(v.status, EligibilityStatus::CanRunSome);
        assert_eq!(v.coverage.eligible, 1);
        assert_eq!(v.coverage.total, 4);
        assert_eq!(v.coverage.fraction, 0.25);
        let names = code_names(&v);
        assert!(names.contains(&"MIN_DRAWS_UNMET"), "{names:?}");
        assert!(names.contains(&"DECISION_DAY_UNMET"), "{names:?}");
    }

    /// TEST-PC-31 — a model whose method is no longer runnable (absent from
    /// the current catalogue): `NOT_RUNNABLE` + `cannot_run`, and the time is
    /// NOT promised (null seconds, the weaker `estimate` quality).
    #[test]
    fn absent_method_verdict_is_not_runnable_without_a_time() {
        let e = entry(
            "fx-rule-004",
            "retired-imported-method",
            None,
            facts(1, false, false),
            56.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-004@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            Some(survival_outcomes()),
        );
        let v = eligible(&e, &inv, false);
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(code_names(&v).contains(&"NOT_RUNNABLE"));
        assert!(v.estimated_seconds.is_none());
        assert_eq!(v.estimate_quality, TimingQuality::Estimate);
    }

    /// TEST-PC-31 — the ASSET_NOT_AVAILABLE arm (defensive): an entry whose
    /// asset is neither a verified bundle nor a downloadable URL (a host
    /// outside the policy — the validator never admits such an entry, so the
    /// verdict is unreachable on validated catalogues and pinned here).
    #[test]
    fn asset_never_available_is_cannot_run() {
        let e = entry(
            "fx-rule-005",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            56.0,
            Some(PretrainedTask::Survival),
            "https://evil.example.com/assets/fx-rule-005@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            None,
        );
        let v = eligible(&e, &inv, false);
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(code_names(&v).contains(&"ASSET_NOT_AVAILABLE"));

        // The same entry WITH a verified bundle available is NOT
        // asset-unavailable (the bundle is the asset — INV-8).
        let v = eligible(&e, &inv, true);
        assert!(!code_names(&v).contains(&"ASSET_NOT_AVAILABLE"));
    }

    /// The outcome-availability codes by the recorded task class: response
    /// without the file's responder columns → `RESPONSE_LABEL_MISSING`;
    /// survival without event/survival_day → `SURVIVAL_OUTCOME_MISSING`; an
    /// unclassified entry emits no outcome verdict.
    #[test]
    fn outcome_codes_follow_the_recorded_task_class() {
        let e = entry(
            "fx-rule-006",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            56.0,
            Some(PretrainedTask::Response),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-006@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            Some(survival_outcomes()),
        );
        let v = eligible(&e, &inv, false);
        assert!(code_names(&v).contains(&"RESPONSE_LABEL_MISSING"), "{:?}", code_names(&v));

        let e_survival = entry(
            "fx-rule-007",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            56.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-007@1.0.0.txr",
            false,
        );
        let missing = FileOutcomes {
            has_responder: true,
            has_response_day: true,
            has_event: false,
            has_survival_day: false,
        };
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            Some(missing),
        );
        let v = eligible(&e_survival, &inv, false);
        assert!(
            code_names(&v).contains(&"SURVIVAL_OUTCOME_MISSING"),
            "{:?}",
            code_names(&v)
        );

        let e_unclassified = entry(
            "fx-rule-008",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            56.0,
            None,
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-008@1.0.0.txr",
            false,
        );
        let v = eligible(&e_unclassified, &inv, false);
        assert!(
            !code_names(&v).iter().any(|c| {
                matches!(
                    *c,
                    "RESPONSE_LABEL_MISSING" | "SURVIVAL_OUTCOME_MISSING" | "TASK_INCOMPATIBLE"
                )
            }),
            "{:?}",
            code_names(&v)
        );
    }

    /// The detection-call + covariate-block arms.
    #[test]
    fn detection_call_and_covariate_blocks_are_checked() {
        let e = entry(
            "fx-rule-009",
            "cox-cutpoint-risk",
            None,
            facts(1, false, true),
            56.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-009@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            None,
        );
        let v = eligible(&e, &inv, false);
        assert!(code_names(&v).contains(&"DETECTION_CALL_MISSING"), "{:?}", code_names(&v));

        let mut e = entry(
            "fx-rule-010",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            56.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-010@1.0.0.txr",
            false,
        );
        e.needs.covariates = CovariateMode::Required;
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            None,
        );
        let v = eligible(&e, &inv, false);
        assert!(
            code_names(&v).contains(&"COVARIATE_REQUIRED_UNMET"),
            "{:?}",
            code_names(&v)
        );
    }

    /// The unit-family arm: the matched marker's recorded family vs the
    /// vocabulary's (HGNC:1001 is a count-family marker in the shipped
    /// vocabulary) — a concentration value never satisfies a count-family
    /// rule.
    #[test]
    fn unit_mismatch_on_the_matched_marker_is_hard() {
        let e = entry(
            "fx-rule-011",
            "cox-cutpoint-risk",
            Some(RequiredMarkers {
                markers: vec![crate::modules::method_catalogue::types::RequiredMarker {
                    name: "BCL6".to_string(),
                    id_system: "HGNC".to_string(),
                    id: "1001".to_string(),
                }],
                match_mode: crate::modules::method_catalogue::types::MatchMode::All,
                min_fraction: 0.0,
                list_source: "test".to_string(),
            }),
            facts(1, false, false),
            56.0,
            None,
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-011@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::ConcentrationMass, vec!["HGNC:1001"], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            None,
        );
        let v = eligible(&e, &inv, false);
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(code_names(&v).contains(&"UNIT_MISMATCH"), "{:?}", code_names(&v));
    }

    /// The decision-day window rule (the model-store rule, parity-bound): a
    /// model whose decision day is beyond the file's window end cannot have
    /// its coverage certified from those counts — the soft code answers with
    /// an empty eligible set.
    #[test]
    fn decision_day_beyond_the_file_window_empties_the_coverage() {
        let e = entry(
            "fx-rule-012",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            90.0,
            Some(PretrainedTask::Survival),
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-012@1.0.0.txr",
            false,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            None,
        );
        let v = eligible(&e, &inv, false);
        assert!(code_names(&v).contains(&"DECISION_DAY_UNMET"), "{:?}", code_names(&v));
        assert_eq!(v.coverage.eligible, 0);
        assert_eq!(v.coverage.fraction, 0.0);
        assert_eq!(v.min_draws.unmet_patients, 1);
    }

    /// The response builder: request order preserved, every id answered, the
    /// totals arithmetic exact (sum == the request length).
    #[test]
    fn response_keeps_request_order_and_sums_the_totals() {
        let ok = entry(
            "fx-rule-013",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            56.0,
            None,
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-013@1.0.0.txr",
            false,
        );
        let nope = entry(
            "fx-rule-014",
            "cox-cutpoint-risk",
            None,
            facts(1, false, true),
            56.0,
            None,
            "https://github.com/tinnlab/txresbench-models/releases/download/x/fx-rule-014@1.0.0.txr",
            false,
        );
        let active = vec![ok, nope];
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            None,
        );
        let bundled = BTreeMap::new();
        let r = eligibility_response(
            &active,
            &["fx-rule-014".to_string(), "fx-rule-013".to_string()],
            &inv,
            &bundled,
        );
        assert_eq!(r.models.len(), 2, "one verdict per requested id");
        assert_eq!(r.models[0].id, "fx-rule-014", "request order");
        assert_eq!(r.models[1].id, "fx-rule-013");
        assert_eq!(r.total_cannot, 1);
        assert_eq!(r.total_fit, 1);
        assert_eq!(r.total_some, 0);
        assert_eq!(r.total_fit + r.total_some + r.total_cannot, 2);
        assert_eq!(r.models[0].status, EligibilityStatus::CannotRun);
        assert_eq!(r.models[1].status, EligibilityStatus::CanRun);
    }

    /// The bundled-availability input: an entry whose verified bundle is
    /// present is NOT asset-unavailable, and the verdict can still run (the
    /// D list may offer it offline — INV-8).
    #[test]
    fn verified_bundle_makes_the_asset_available() {
        let e = entry(
            "fx-rule-015",
            "cox-cutpoint-risk",
            None,
            facts(1, false, false),
            56.0,
            None,
            "https://evil.example.com/assets/fx-rule-015@1.0.0.txr",
            true,
        );
        let inv = inventory(
            vec![marker("M1", UnitFamily::None, vec![], vec![("S0001", 1, 2)], false)],
            1,
            56.0,
            None,
        );
        let v = eligible(&e, &inv, true);
        assert_eq!(v.status, EligibilityStatus::CanRun);
        assert!(!code_names(&v).contains(&"ASSET_NOT_AVAILABLE"));
    }
}
