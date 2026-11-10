//! ITEM-3 — the matching engine (PROV-MC-5/7): the standard-id rule port
//! (data.py `parse_standard_ids` / `is_companion` / `required_marker_match`,
//! DEC-5/INV-2) and the app-level eligibility engine over the typed inventory
//! and preview requests.
//!
//! ## The rule port (DEC-5)
//!
//! `dev/code/benchmark/runner/data.py` lines 131-160 are the reference; the
//! regexes below are verbatim copies and the match function mirrors its
//! `required_marker_match` (the same `ok / matched_ids / missing_ids /
//! features / fraction / reason` shape). Port fidelity is locked by unit
//! fixtures whose expected values were produced by running data.py on the same
//! strings (TEST-MC-1/2/3). Two deliberate input-contract notes:
//!
//! - the port takes a [`UnitMarkerRow`] whose `dataset_features` are the
//!   unit's candidate features, ALREADY stripped of companions
//!   (`__detected`/`__lod`) — data.py's caller filters `is_companion` before
//!   calling the match, so the filter lives on the caller side here too
//!   ([`is_companion`] is the port of that predicate);
//! - the port's `features` argument is the unit's candidate feature list, not
//!   the whole file (a row of another modality is excluded, exactly like the
//!   reference).
//!
//! ## The eligibility engine (DEC-6, PROV-MC-5)
//!
//! Pure functions over [`Catalogue`] + request; no I/O (the module is
//! stateless, DEC-9, and the engine is replayed in-process by the execution
//! engine — one code path with the HTTP surface, ITEM-5) plus ONE runtime
//! stage: [`with_runtime_env`] rejoins the pure verdicts with the app's
//! published environment set ([`runtime_env_available`] — the manifest's
//! host-arch entry), because a method with no published environment can never
//! start (CM-1) and the screens must not offer it. The production entry
//! points ([`eligibility`], [`eligibility_for_runtime`]) apply the stage; the
//! pure engines are the test seam and the provider bedrock.
//!
//! Status lattice per method:
//! - `cannot_run` when a hard requirement fails: not runnable
//!   ([`ReasonCode::NotRunnable`]) or no published environment
//!   ([`ReasonCode::EnvImageMissing`], the runtime stage), a required marker
//!   absent ([`ReasonCode::RequiredMarkerMissing`]) or an unchecked board
//!   group (preview only, [`ReasonCode::MarkerGroupMissing`]), the detection
//!   call absent ([`ReasonCode::DetectionCallMissing`]), the required
//!   covariate block absent ([`ReasonCode::CovariateRequiredUnmet`]), a
//!   present marker's unit family differs from the vocabulary's
//!   ([`ReasonCode::UnitMismatch`]), the outcome availability checks fail
//!   ([`ReasonCode::ResponseLabelMissing`] /
//!   [`ReasonCode::SurvivalOutcomeMissing`] / [`ReasonCode::TaskIncompatible`]),
//!   or NO patient is eligible (the draw coverage leaves nobody — CM-6's
//!   "0 of N" is a Cannot run, never a selectable Can run for some).
//! - `can_run_some` when the markers are there but the draw coverage leaves
//!   patients out ([`ReasonCode::MinDrawsUnmet`] /
//!   [`ReasonCode::DecisionDayUnmet`]).
//! - `can_run` when every patient of the file meets the method's draw rule.
//!
//! Two interpretation notes (recorded in the PLAN's implementation notes, see
//! DRIFT-1 ITEM-3):
//!
//! - **Coverage is draw-presence based on the inventory's per-patient counts.**
//!   The inventory carries per-MARKER counts (`baseline_draws` +
//!   `ontreatment_draws` per patient), not per-day unions, so the engine's
//!   per-patient draw count across the method's markers is the MAX of the
//!   markers' counts (a visit row carries every marker measured at that
//!   visit, so method markers coincide; the max is the least-committal union).
//!   A patient whose values are all after the decision day has (0, 0) counts
//!   (or no entry at all) and is counted by the decision-day reason. When the
//!   per-patient lists are omitted, the engine falls back to the marker-level
//!   counts and reports the draw-PRESENCE cohort (baseline + at least one
//!   on-treatment value) as the eligible set — the exactly-N-draws part needs
//!   the per-patient lists and is not verified in the fallback. The
//!   (validator-built) inventory always carries the lists; the fallback
//!   exists for truncated posts.
//! - **`COVARIATE_MISSING` has no distinct trigger with the current facts.**
//!   The catalogue facts name covariate MODE only (`none` / `optional` /
//!   `required`) — no method fact names a specific covariate column — so a
//!   file posting an empty covariate block IS the required-covariate absence
//!   case ([`ReasonCode::CovariateRequiredUnmet`]); the code stays in the
//!   closed PROV-MC-5 vocabulary and its trigger lands with a covariate-name
//!   fact. (The reason-code contract is fixed at 13; a consumer renderer can
//!   still switch over all of them exhaustively.)
//!
//! `estimated_seconds`/`estimate_quality` on each method verdict use the
//! DEC-7 estimate shape (`base_seconds_per_fold × patients/150 × 4/cpus`,
//! with the eligibility path resolving the same effective CPU count the run
//! will use — [`estimate::host_cpus`], the ONE source of CM-7; the estimate
//! endpoint's cpus parameter is ITEM-4's surface, built on the same
//! [`estimate_seconds_for`] helper).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::modules::method_catalogue::calibration;
use crate::modules::method_catalogue::estimate::host_cpus;
use crate::modules::method_catalogue::types::{
    Catalogue, CovariateMode, Coverage, EligibilityRequest, EligibilityResponse,
    EligibilityStatus, FileOutcomes, InventoryEligibilityRequest, InventoryMarker, MatchMode,
    Method, MethodEligibility, MinDraws, MissingGroup, MissingMarker, PreviewEligibilityRequest,
    Reason, ReasonCode, RequiredMarker, RequiredMarkers, TimingQuality, UnitFamily,
    DEFAULT_ESTIMATE_CPUS,
};

/// The estimate reference cohort (DEC-7: the board's example cohort).
pub const REFERENCE_PATIENTS: u32 = 150;

/// The estimate reference CPU count (DEC-7: the standard per-job cap; the
/// eligibility path's own rows now resolve the host count through
/// [`estimate::host_cpus`] — the same ONE source the run uses — while this
/// reference constant stays the estimate helper's zero/undefined guard and
/// the model-list paths' documented reference).
pub const REFERENCE_CPUS: u32 = 4;

/// The data.py reason string for an unmatched required-marker set — kept
/// verbatim: the port's `reason` field is that module's string, and a
/// consumer that needs copy renders its own text (DEC-6).
pub const REQUIRED_MARKERS_NOT_MEASURED: &str = "required markers not measured";

// ─────────────────────────────────────────────────────────────────────────────
// The rule port (data.py lines 131-160, copied verbatim — the regexes are the
// contract, see DEC-5/INV-2)
// ─────────────────────────────────────────────────────────────────────────────

const LOINC_KEY_PATTERN: &str = r"(?i)\bLOINC\b";
const LOINC_CODE_PATTERN: &str = r"\b\d{2,6}-\d{1,2}\b";
const HGNC_PATTERN: &str = r"(?i)\bHGNC\b\s*:?\s*([A-Za-z0-9][A-Za-z0-9_.\-]*)";
const GENE_PATTERN: &str = r"(?i)\bgene\b\s*:?\s*([A-Z][A-Z0-9][A-Z0-9_.\-]*)";
const UNIPROT_PATTERN: &str =
    r"(?i)\bUniProt\b\s*\(?\s*([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9][A-Z0-9]{2}[0-9])";
const UNIPROT_ACC_PATTERN: &str =
    r"\b[OPQ][0-9][A-Z0-9]{3}[0-9]\b|\b[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9][A-Z0-9]{2}[0-9]\b";
const HMDB_PATTERN: &str = r"(?i)\bHMDB\d{6,8}\b";
const MIRBASE_PATTERN: &str = r"(?i)\b(MIMAT\d{5,}|MI\d{7})\b";
const NO_HGNC_PATTERN: &str = r"(?i)\bno\s+HGNC\b";
const UNIPROT_ANY_PATTERN: &str = r"(?i)uniprot";
/// The clause separator of a `standard_id` text (data.py line 149).
const CLAUSE_SEPARATOR_PATTERN: &str = r"[;()\[\]{}]";

/// The `_HGNC_STOP` list — words that follow "HGNC" but are not identifiers.
const HGNC_STOP: [&str; 7] = [
    "term",
    "id",
    "identifier",
    "symbol",
    "name",
    "gene",
    "genes",
];

fn re(pattern: &'static str) -> &'static Regex {
    // The patterns are compile-time constants; a panic is a build-time bug
    // (they are validated by the unit suite on first use).
    static CACHE: OnceLock<BTreeMap<&str, Regex>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mut m = BTreeMap::new();
        for p in [
            LOINC_KEY_PATTERN,
            LOINC_CODE_PATTERN,
            HGNC_PATTERN,
            GENE_PATTERN,
            UNIPROT_PATTERN,
            UNIPROT_ACC_PATTERN,
            HMDB_PATTERN,
            MIRBASE_PATTERN,
            NO_HGNC_PATTERN,
            UNIPROT_ANY_PATTERN,
            CLAUSE_SEPARATOR_PATTERN,
        ] {
            m.insert(p, Regex::new(p).expect("static pattern"));
        }
        m
    })
    .get(pattern)
    .expect("pattern is in the cache")
}

/// The standard ids in a `standard_id` text (lower-cased set) — the port of
/// data.py `parse_standard_ids`: LOINC codes, HGNC symbols/ids, UniProt
/// accessions, HMDB ids, miRBase accessions; matching is case-insensitive.
/// The returned set semantics match data.py's set exactly (EXAMPLE-E6).
pub fn parse_standard_ids(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if text.is_empty() {
        return out;
    }
    // LOINC codes of one clause travel together (dot, comma, slash); the
    // clause split is data.py's `re.split(r"[;()\[\]{}]", t)`.
    for clause in re(CLAUSE_SEPARATOR_PATTERN).split(text) {
        if re(LOINC_KEY_PATTERN).is_match(clause) {
            for m in re(LOINC_CODE_PATTERN).find_iter(clause) {
                out.insert(m.as_str().to_string());
            }
        }
    }
    let hg = re(NO_HGNC_PATTERN).replace_all(text, " no-hgnc ");
    for caps in re(HGNC_PATTERN).captures_iter(&hg) {
        let x = caps.get(1).expect("capture 1").as_str();
        if !HGNC_STOP.contains(&x.to_ascii_lowercase().as_str()) {
            out.insert(x.to_ascii_lowercase());
        }
    }
    for caps in re(GENE_PATTERN).captures_iter(text) {
        out.insert(caps.get(1).expect("capture 1").as_str().to_ascii_lowercase());
    }
    for caps in re(UNIPROT_PATTERN).captures_iter(text) {
        out.insert(caps.get(1).expect("capture 1").as_str().to_ascii_lowercase());
    }
    if re(UNIPROT_ANY_PATTERN).is_match(text) {
        for m in re(UNIPROT_ACC_PATTERN).find_iter(text) {
            out.insert(m.as_str().to_ascii_lowercase());
        }
    }
    for m in re(HMDB_PATTERN).find_iter(text) {
        out.insert(m.as_str().to_ascii_lowercase());
    }
    for caps in re(MIRBASE_PATTERN).captures_iter(text) {
        out.insert(caps.get(1).expect("capture 1").as_str().to_ascii_lowercase());
    }
    out
}

/// The port of data.py `is_companion`: a `__detected`/`__lod` column travels
/// with its marker and never ranks or matches.
pub fn is_companion(name: &str) -> bool {
    name.ends_with("__detected") || name.ends_with("__lod")
}

/// One mapping-row-shaped input of the port (data.py's row dict): the fields
/// `required_marker_match` reads. `dataset_features` are the row's feature
/// list (already normalized by the caller — the reference's `_strlist`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitMarkerRow {
    pub marker: String,
    pub standard_id: String,
    pub dataset_features: Vec<String>,
    pub status: String,
}

/// The port's result shape (data.py's return dict of `required_marker_match`):
/// `features` = the dataset features of the matched rows that are in the
/// unit; `reason` = `None` when ok, else the reference's reason string.
#[derive(Debug, Clone)]
pub struct RequiredMarkerMatch {
    pub ok: bool,
    pub matched_ids: Vec<String>,
    pub missing_ids: Vec<String>,
    pub features: Vec<String>,
    pub fraction: f64,
    pub reason: Option<String>,
    pub required: Option<RequiredMarkers>,
}

impl RequiredMarkerMatch {
    /// The reference's result for an empty required list (the port's shape).
    pub fn not_measured(required: &RequiredMarkers) -> Self {
        Self {
            ok: false,
            matched_ids: Vec::new(),
            missing_ids: Vec::new(),
            features: Vec::new(),
            fraction: 0.0,
            reason: Some(REQUIRED_MARKERS_NOT_MEASURED.to_string()),
            required: Some(required.clone()),
        }
    }
}

/// The port of data.py `required_marker_match`: match a method's required
/// markers against the rows of one unit. Only rows whose first status word is
/// `mapped`/`partly` and whose features intersect the unit's candidate
/// `features` belong to the unit; a required id is present when a row's
/// `standard_id` parses to it (case-insensitive), and for the `other` system
/// the row's marker/feature names also count (when no standard id parses).
pub fn required_marker_match(
    rows: &[UnitMarkerRow],
    features: &[String],
    required: &RequiredMarkers,
) -> RequiredMarkerMatch {
    let req: Vec<(String, String)> = required
        .markers
        .iter()
        .filter(|m| !m.id.is_empty())
        .map(|m| (m.id_system.to_ascii_lowercase(), m.id.trim().to_ascii_lowercase()))
        .collect();
    let match_all = matches!(required.match_mode, MatchMode::All);
    let frac = required.min_fraction.max(0.0);
    if req.is_empty() {
        return RequiredMarkerMatch::not_measured(required);
    }
    let feats: Vec<String> = features.to_vec();
    let mut unit_rows: Vec<(&UnitMarkerRow, Vec<String>)> = Vec::new();
    for r in rows {
        let status = r.status.split(' ').next().unwrap_or("");
        if status != "mapped" && status != "partly" {
            continue;
        }
        let rf: Vec<String> = r
            .dataset_features
            .iter()
            .map(|f| f.trim().to_string())
            .filter(|f| !f.is_empty())
            .collect();
        if !rf.is_empty() && !feats.is_empty() && !rf.iter().any(|f| feats.contains(f)) {
            continue; // a row of another modality of the dataset
        }
        unit_rows.push((r, rf));
    }
    let mut hit: Vec<Vec<(&UnitMarkerRow, Vec<String>)>> = vec![Vec::new(); req.len()];
    for (r, rf) in &unit_rows {
        let ids = parse_standard_ids(&r.standard_id);
        let mut names = BTreeSet::new();
        names.insert(r.marker.trim().to_ascii_lowercase());
        for f in rf {
            names.insert(f.to_ascii_lowercase());
        }
        for (i, (system, rid)) in req.iter().enumerate() {
            if ids.contains(rid) || (system == "other" && names.contains(rid) && !ids.contains(rid))
            {
                hit[i].push((r, rf.clone()));
            }
        }
    }
    let present: Vec<usize> = (0..req.len()).filter(|i| !hit[*i].is_empty()).collect();
    let fraction = present.len() as f64 / req.len() as f64;
    let ok = fraction >= if match_all { 1.0 } else { frac - 1e-9 };
    let mut got: Vec<String> = Vec::new();
    for i in &present {
        for (_r, rf) in &hit[*i] {
            for f in rf {
                if feats.is_empty() || feats.contains(f) {
                    got.push(f.clone());
                }
            }
        }
    }
    let features: Vec<String> = got.into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    RequiredMarkerMatch {
        ok,
        matched_ids: present.iter().map(|i| req[*i].1.clone()).collect(),
        missing_ids: (0..req.len())
            .filter(|i| !present.contains(i))
            .map(|i| req[i].1.clone())
            .collect(),
        features,
        fraction,
        reason: if ok { None } else { Some(REQUIRED_MARKERS_NOT_MEASURED.to_string()) },
        required: Some(required.clone()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The estimate helper (DEC-7; the eligibility response carries the per-method
// seconds, and ITEM-4's estimates endpoint is built on the same shape)
// ─────────────────────────────────────────────────────────────────────────────

/// The per-method estimate seconds (DEC-7): `base_seconds_per_fold ×
/// (patients / REFERENCE_PATIENTS) × (REFERENCE_CPUS / cpus)`.
pub fn estimate_seconds_for(method: &Method, patients: u32, cpus: u32) -> f64 {
    let cpus = if cpus == 0 { DEFAULT_ESTIMATE_CPUS } else { cpus };
    method.timing.base_seconds_per_fold
        * (patients as f64 / REFERENCE_PATIENTS as f64)
        * (REFERENCE_CPUS as f64 / cpus as f64)
}

/// The per-method estimate quality — the timing fact's quality, verbatim.
pub fn estimate_quality_for(method: &Method) -> TimingQuality {
    method.timing.quality
}

// ─────────────────────────────────────────────────────────────────────────────
// The eligibility engine (pure; no I/O) + the runtime-env stage
// ─────────────────────────────────────────────────────────────────────────────

/// Whether `method_id` has a published environment for THIS computer — the
/// app's env manifest host-arch entry ([`execution_engine::envmanifest::env_for`]).
/// This is the ONE runtime-env predicate: the eligibility stage below and the
/// engine's run-start classification ([`execution_engine::orchestrator::classify`])
/// look at the same manifest entry, so a method the screens mark cannot-run is
/// exactly a method the engine will not start, and vice versa.
///
/// Module note: `method_catalogue` is a provider of the execution engine, and
/// this accessor reads the engine module's embedded manifest (the same crate,
/// no runtime init order dependency — the manifest is a compile-time embed).
/// The alternative — a predicate parameter at every call site — would let a
/// consumer forget the runtime check (the original CM-1 defect was exactly a
/// consumer that only ever saw marker verdicts); the cycle is deliberate and
/// documented here so the two classifiers cannot drift.
pub fn runtime_env_available(method_id: &str) -> bool {
    crate::modules::execution_engine::envmanifest::env_for(method_id).is_some()
}

/// Run eligibility over the embedded catalogue (PROV-MC-7's in-process seam):
/// the pure verdicts + the runtime-env stage ([`with_runtime_env`]).
pub fn eligibility(req: &EligibilityRequest) -> EligibilityResponse {
    with_runtime_env(eligibility_for(
        crate::modules::method_catalogue::catalogue::catalogue(),
        req,
    ))
}

/// Run eligibility over a given catalogue — the PURE engine (no runtime-env
/// stage; the test seam: handcrafted catalogues can exercise every rule,
/// including the NOT_RUNNABLE case the shipped runnable-only set never
/// triggers — DEC-2). Production consumers call [`eligibility`] or
/// [`eligibility_for_runtime`], never this directly.
pub fn eligibility_for(cat: &Catalogue, req: &EligibilityRequest) -> EligibilityResponse {
    eligibility_for_calibrated(cat, req, &calibration::TimingCalibration::empty())
}

/// The PURE engine with the app's measured-time calibration applied
/// (qa-fixes2 ITEM-6, R2-3): the E-screen rows' `estimated_seconds` come
/// from the calibrated reference base ([`calibration::calibrated_estimate_seconds_for`])
/// — the same seconds the estimate endpoint and the run's own estimate use,
/// so the row times, the bottom bar and the running header can never drift
/// apart. An empty calibration is byte-identical to [`eligibility_for`].
pub fn eligibility_for_calibrated(
    cat: &Catalogue,
    req: &EligibilityRequest,
    calibration: &calibration::TimingCalibration,
) -> EligibilityResponse {
    match req {
        EligibilityRequest::Preview { preview } => preview_eligibility(cat, preview),
        EligibilityRequest::Inventory { inventory } => {
            inventory_eligibility(cat, inventory, calibration)
        }
    }
}

/// The pure verdicts plus the runtime-env stage — the HTTP surface's seat
/// (the engine's in-process seam is [`eligibility`], the same two steps).
pub fn eligibility_for_runtime(
    cat: &Catalogue,
    req: &EligibilityRequest,
) -> EligibilityResponse {
    eligibility_for_runtime_calibrated(cat, req, &calibration::TimingCalibration::empty())
}

/// The runtime stage with the calibration applied (the eligibility route's
/// seat: the handler loads the calibration snapshot and passes it in — the
/// engine itself stays DB-free).
pub fn eligibility_for_runtime_calibrated(
    cat: &Catalogue,
    req: &EligibilityRequest,
    calibration: &calibration::TimingCalibration,
) -> EligibilityResponse {
    with_runtime_env(eligibility_for_calibrated(cat, req, calibration))
}

/// The RUNTIME-ENV stage (CM-1's fix): a catalogue method with no published
/// environment can never start (the engine's run-start
/// `ENV_UNKNOWN`), so every such verdict is reclassified to `cannot_run` with
/// [`ReasonCode::EnvImageMissing`] pushed FIRST (the first reason is the row's
/// one detail line + the engine's run-row reason), the totals are recomputed,
/// and `total_no_env` counts them (the catalogue still lists them; the count
/// is the "N are not installed" fact the list header needs).
fn with_runtime_env(mut resp: EligibilityResponse) -> EligibilityResponse {
    for m in &mut resp.methods {
        if runtime_env_available(&m.id) {
            continue;
        }
        m.status = EligibilityStatus::CannotRun;
        m.reasons.insert(
            0,
            Reason {
                code: ReasonCode::EnvImageMissing,
                params: BTreeMap::new(),
                group_id: None,
            },
        );
    }
    let total_fit = resp
        .methods
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRun)
        .count() as u32;
    let total_some = resp
        .methods
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRunSome)
        .count() as u32;
    let total_cannot = resp
        .methods
        .iter()
        .filter(|m| m.status == EligibilityStatus::CannotRun)
        .count() as u32;
    let total_no_env = resp
        .methods
        .iter()
        .filter(|m| m.reasons.iter().any(|r| r.code == ReasonCode::EnvImageMissing))
        .count() as u32;
    EligibilityResponse {
        methods: resp.methods,
        total_fit,
        total_some,
        total_cannot,
        total_no_env,
    }
}

/// Screen B's request (the PREVIEW body): the panel is answered from the
/// schedule + marker-group answers, without any patient data.
fn preview_eligibility(cat: &Catalogue, req: &PreviewEligibilityRequest) -> EligibilityResponse {
    let schedule_draws = req
        .draws_during_treatment
        .saturating_add(if req.before_treatment == "always" { 1 } else { 0 });
    let mut methods = Vec::with_capacity(cat.methods.len());
    for m in &cat.methods {
        let mut reasons: Vec<Reason> = Vec::new();
        let mut missing_groups: Vec<MissingGroup> = Vec::new();
        if !m.runnable {
            reasons.push(Reason {
                code: ReasonCode::NotRunnable,
                params: BTreeMap::new(),
                group_id: None,
            });
        }
        for gid in &m.marker_groups_required {
            if !req.marker_groups.get(gid).copied().unwrap_or(false) {
                let label = cat
                    .group(gid)
                    .map(|g| g.display_name.clone())
                    .unwrap_or_else(|| gid.clone());
                missing_groups.push(MissingGroup {
                    group_id: gid.clone(),
                    display_name: label,
                });
                reasons.push(Reason {
                    code: ReasonCode::MarkerGroupMissing,
                    params: BTreeMap::from([(
                        "group_id".to_string(),
                        serde_json::Value::String(gid.clone()),
                    )]),
                    group_id: Some(gid.clone()),
                });
            }
        }
        let schedule_ok = m.min_draws <= schedule_draws;
        if !schedule_ok {
            reasons.push(Reason {
                code: ReasonCode::MinDrawsUnmet,
                params: BTreeMap::from([
                    ("required".to_string(), serde_json::Value::from(m.min_draws)),
                    ("planned".to_string(), serde_json::Value::from(schedule_draws)),
                ]),
                group_id: None,
            });
        }
        // The schedule's patient split: a "sometimes" before-treatment answer
        // means some patients have no baseline draw.
        let some_baseline = m.needs_baseline && req.before_treatment != "always";
        let status = if !m.runnable || !missing_groups.is_empty() || !schedule_ok {
            EligibilityStatus::CannotRun
        } else if some_baseline {
            EligibilityStatus::CanRunSome
        } else {
            EligibilityStatus::CanRun
        };
        methods.push(MethodEligibility {
            id: m.id.clone(),
            status,
            reasons,
            missing_markers: Vec::new(),
            missing_groups,
            coverage: Coverage {
                eligible: if schedule_ok { 1 } else { 0 },
                total: 1,
                fraction: if schedule_ok { 1.0 } else { 0.0 },
            },
            min_draws: MinDraws {
                required: m.min_draws,
                met: if schedule_ok { 1 } else { 0 },
                unmet_patients: 0,
            },
            // No patients at screen B: the estimate is the raw reference
            // cohort value scaled to zero patients (0 — the B panel does not
            // promise a time yet; the E-screen inventory carries the count).
            estimated_seconds: estimate_seconds_for(m, 0, DEFAULT_ESTIMATE_CPUS),
            estimate_quality: estimate_quality_for(m),
        });
    }
    finish(methods)
}

/// The inventory path (screens C/N/E — the consumer that holds the file posts
/// the validated inventory), with the measured-time calibration applied to
/// the rows' `estimated_seconds`/`estimate_quality`.
fn inventory_eligibility(
    cat: &Catalogue,
    inv: &InventoryEligibilityRequest,
    calibration: &calibration::TimingCalibration,
) -> EligibilityResponse {
    let mut methods = Vec::with_capacity(cat.methods.len());
    for m in &cat.methods {
        methods.push(inventory_method(cat, inv, m, calibration));
    }
    finish(methods)
}

fn finish(methods: Vec<MethodEligibility>) -> EligibilityResponse {
    let total_fit = methods
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRun)
        .count() as u32;
    let total_some = methods
        .iter()
        .filter(|m| m.status == EligibilityStatus::CanRunSome)
        .count() as u32;
    let total_cannot = methods
        .iter()
        .filter(|m| m.status == EligibilityStatus::CannotRun)
        .count() as u32;
    EligibilityResponse {
        methods,
        total_fit,
        total_some,
        total_cannot,
        // The pure core carries no env facts; the runtime-env stage
        // (with_runtime_env) fills the count.
        total_no_env: 0,
    }
}

/// One method verdict for an inventory request.
fn inventory_method(
    cat: &Catalogue,
    inv: &InventoryEligibilityRequest,
    m: &Method,
    calibration: &calibration::TimingCalibration,
) -> MethodEligibility {
    let mut reasons: Vec<Reason> = Vec::new();
    let mut missing_markers: Vec<MissingMarker> = Vec::new();

    if !m.runnable {
        reasons.push(Reason {
            code: ReasonCode::NotRunnable,
            params: BTreeMap::new(),
            group_id: None,
        });
    }

    // Outcome availability (the reconcile-grown codes; the request carries
    // them when the consumer knows the file's outcome columns).
    if let Some(outcomes) = &inv.outcomes {
        outcome_reasons(m, outcomes, &mut reasons);
    }

    // Required markers: the engine resolves the method's fixed marker list
    // against the file's RESOLVED inventory (parsed standard ids), applying
    // data.py's matching rules — case-insensitive (system, id) equality plus
    // the `other`-system name/alias fallback (the vocabulary resolution gives
    // the names set; the join offer's alias surface counts).
    let resolved = if let Some(req) = &m.required_markers {
        let r = inventory_required_match(cat, inv, req);
        if !r.ok {
            reasons.push(Reason {
                code: ReasonCode::RequiredMarkerMissing,
                params: BTreeMap::from([
                    (
                        "missing".to_string(),
                        serde_json::Value::Array(
                            r.missing_ids
                                .iter()
                                .map(|s| serde_json::Value::String(s.clone()))
                                .collect(),
                        ),
                    ),
                    ("fraction".to_string(), serde_json::Value::from(r.fraction)),
                ]),
                group_id: None,
            });
            for id in &r.missing_ids {
                let orig = req
                    .markers
                    .iter()
                    .find(|rm| rm.id.trim().to_ascii_lowercase() == *id)
                    .cloned()
                    .unwrap_or(RequiredMarker {
                        name: String::new(),
                        id_system: String::new(),
                        id: id.clone(),
                    });
                let vocab = cat.markers.iter().find(|v| {
                    v.system.as_str().eq_ignore_ascii_case(&orig.id_system)
                        && v.id.eq_ignore_ascii_case(&orig.id)
                });
                missing_markers.push(MissingMarker {
                    id: orig.id.clone(),
                    id_system: orig.id_system.clone(),
                    display_name: vocab
                        .map(|v| v.display_name.clone())
                        .filter(|d| !d.is_empty())
                        .unwrap_or_else(|| orig.name.clone()),
                    group_id: vocab.and_then(|v| v.groups.first().cloned()),
                });
            }
        }
        r.used
    } else {
        // No fixed marker list: the method consumes markers of the file (any /
        // single / multi kind); every measure column is a candidate —
        // detection-call columns are a signal, not a value.
        inv.markers
            .iter()
            .filter(|mk| !mk.is_detection_call)
            .collect::<Vec<_>>()
    };

    // Detection call: a method that consumes the detectability call needs a
    // detection-call marker or a marker with a __detected/__lod companion in
    // the file.
    if m.needs_detection_call
        && !inv
            .markers
            .iter()
            .any(|mk| mk.is_detection_call || mk.has_detection_companion)
    {
        reasons.push(Reason {
            code: ReasonCode::DetectionCallMissing,
            params: BTreeMap::new(),
            group_id: None,
        });
    }

    // Covariate requirement — the method facts carry the mode, not names (see
    // the module doc): the required-covariate condition is unmet exactly when
    // the file posts no covariate block at all.
    if matches!(m.covariates, CovariateMode::Required) && inv.covariates.is_empty() {
        reasons.push(Reason {
            code: ReasonCode::CovariateRequiredUnmet,
            params: BTreeMap::new(),
            group_id: None,
        });
    }

    // Unit-family compatibility: a present required marker must be measured in
    // the vocabulary's family (a percent CEA never satisfies a
    // concentration-family method; an unknown family on either side is not a
    // mismatch, and `other`-system markers have no canonical family).
    if let Some(r) = &m.required_markers {
        for mk in &resolved {
            for rm in &r.markers {
                if rm.id_system.eq_ignore_ascii_case("other") {
                    continue;
                }
                if !mk.standard_ids.iter().any(|sid| {
                    sid.system.eq_ignore_ascii_case(&rm.id_system) && sid.id.eq_ignore_ascii_case(&rm.id)
                }) {
                    continue;
                }
                if let Some(vocab) = cat.markers.iter().find(|v| {
                    v.system.as_str().eq_ignore_ascii_case(&rm.id_system)
                        && v.id.eq_ignore_ascii_case(&rm.id)
                }) {
                    if vocab.unit_family != UnitFamily::None
                        && mk.unit_family != UnitFamily::None
                        && vocab.unit_family != mk.unit_family
                    {
                        reasons.push(Reason {
                            code: ReasonCode::UnitMismatch,
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

    // Coverage (draw rule) over the method's markers.
    let (coverage, min_draws, no_value) = draw_coverage(inv, m, &resolved);
    if no_value > 0 {
        reasons.push(Reason {
            code: ReasonCode::DecisionDayUnmet,
            params: BTreeMap::from([("patients".to_string(), serde_json::Value::from(no_value))]),
            group_id: None,
        });
    }
    if min_draws.unmet_patients > 0 {
        reasons.push(Reason {
            code: ReasonCode::MinDrawsUnmet,
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

    let status = verdict(&reasons, coverage.eligible, coverage.total);
    MethodEligibility {
        id: m.id.clone(),
        status,
        reasons,
        missing_markers,
        missing_groups: Vec::new(),
        coverage,
        min_draws,
        // The row's time is the run's time: the same effective CPU count the
        // run will use (Auto = the host's detected CPUs — CM-7's one source;
        // the estimate endpoint's omission path resolves the same count) and
        // the app's measured-time calibration (R2-3 — a method the app has
        // already run estimates with its own measured per-fold seconds).
        estimated_seconds: calibration::calibrated_estimate_seconds_for(
            m,
            inv.patients,
            host_cpus(),
            calibration,
        ),
        estimate_quality: calibration::calibrated_estimate_quality_for(m, calibration),
    }
}

/// The structured required-marker resolution of the ENGINE (over the
/// inventory's parsed standard ids — data.py's rules: case-insensitive
/// (system, id) equality, plus the `other`-system name/alias fallback).
struct InventoryResolution<'a> {
    ok: bool,
    matched_ids: Vec<String>,
    missing_ids: Vec<String>,
    fraction: f64,
    /// The inventory markers that satisfied a required entry (the method's
    /// used markers).
    used: Vec<&'a InventoryMarker>,
}

fn inventory_required_match<'a>(
    cat: &Catalogue,
    inv: &'a InventoryEligibilityRequest,
    required: &RequiredMarkers,
) -> InventoryResolution<'a> {
    let req: Vec<&RequiredMarker> = required.markers.iter().filter(|m| !m.id.is_empty()).collect();
    let match_all = matches!(required.match_mode, MatchMode::All);
    let frac = required.min_fraction.max(0.0);
    if req.is_empty() {
        return InventoryResolution {
            ok: false,
            matched_ids: Vec::new(),
            missing_ids: Vec::new(),
            fraction: 0.0,
            used: Vec::new(),
        };
    }
    let mut hit = vec![None::<&'a InventoryMarker>; req.len()];
    for (i, rm) in req.iter().enumerate() {
        let sys = rm.id_system.to_ascii_lowercase();
        let rid = rm.id.trim().to_ascii_lowercase();
        for mk in &inv.markers {
            let ids: BTreeSet<(String, String)> = mk
                .standard_ids
                .iter()
                .map(|sid| (sid.system.to_ascii_lowercase(), sid.id.to_ascii_lowercase()))
                .collect();
            if ids.iter().any(|(s, id)| s == &sys && id == &rid) {
                hit[i] = Some(mk);
                break;
            }
            if sys == "other" && !ids.contains(&(sys.clone(), rid.clone())) {
                // The `other`-system name/alias fallback: the required id is
                // the canonical feature name; the file column answers to it by
                // name (its own names plus the resolved vocabulary marker's
                // names and aliases).
                let names = inventory_names(cat, mk);
                if names.contains(&rid) {
                    hit[i] = Some(mk);
                    break;
                }
            }
        }
    }
    let present: Vec<usize> = (0..req.len()).filter(|i| hit[*i].is_some()).collect();
    let fraction = present.len() as f64 / req.len() as f64;
    let ok = fraction >= if match_all { 1.0 } else { frac - 1e-9 };
    // Pointer-identity dedup (two required entries can resolve to the same
    // file marker via the name/alias fallback; the used set is a set).
    let mut used: Vec<&'a InventoryMarker> = Vec::new();
    for i in &present {
        let mk = hit[*i].expect("present");
        if !used.iter().any(|u| std::ptr::eq(*u, mk)) {
            used.push(mk);
        }
    }
    InventoryResolution {
        ok,
        matched_ids: present
            .iter()
            .map(|i| req[*i].id.trim().to_ascii_lowercase())
            .collect(),
        missing_ids: (0..req.len())
            .filter(|i| !present.contains(i))
            .map(|i| req[i].id.trim().to_ascii_lowercase())
            .collect(),
        fraction,
        used,
    }
}

/// The names a file marker answers to for the `other`-system fallback: the
/// column's own names plus the resolved vocabulary marker's names/aliases.
fn inventory_names(cat: &Catalogue, mk: &InventoryMarker) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    names.insert(mk.key.trim().to_ascii_lowercase());
    names.insert(mk.display_name.trim().to_ascii_lowercase());
    for sid in &mk.standard_ids {
        if let Some(v) = cat.markers.iter().find(|v| {
            v.system.as_str().eq_ignore_ascii_case(&sid.system) && v.id.eq_ignore_ascii_case(&sid.id)
        }) {
            names.insert(v.id.to_ascii_lowercase());
            names.insert(v.display_name.trim().to_ascii_lowercase());
            for a in &v.aliases {
                names.insert(a.trim().to_ascii_lowercase());
            }
        }
    }
    names
}

/// The outcome-availability verdicts (the reconcile-grown codes; the priority
/// keeps at most the specific missing-column code and the task-vs-file
/// mismatch from stacking).
fn outcome_reasons(m: &Method, outcomes: &FileOutcomes, reasons: &mut Vec<Reason>) {
    let has_response = outcomes.has_responder && outcomes.has_response_day;
    let has_survival = outcomes.has_event && outcomes.has_survival_day;
    let task_response = m.tasks.iter().any(|t| t.eq_ignore_ascii_case("response"));
    let task_survival = m.tasks.iter().any(|t| t.eq_ignore_ascii_case("survival"));
    // No declared task = any outcome the file carries (the owner's
    // 2026-10-20 rule: task/endpoint are not part of a run — every method
    // runs on every outcome the patients table supports; the earlier
    // "a task-less method covers no file outcome" verdict bases a mismatch
    // on a fact never curated for the real registry — 343 of 359 catalogue
    // methods carry `tasks: []` — see execution-engine DRIFT-1 ITEM-4 #5).
    if m.tasks.is_empty() {
        return;
    }
    if task_response && !has_response {
        reasons.push(Reason {
            code: ReasonCode::ResponseLabelMissing,
            params: BTreeMap::from([(
                "required".to_string(),
                serde_json::Value::String("responder,response_day".to_string()),
            )]),
            group_id: None,
        });
    } else if task_survival && !has_survival {
        reasons.push(Reason {
            code: ReasonCode::SurvivalOutcomeMissing,
            params: BTreeMap::from([(
                "required".to_string(),
                serde_json::Value::String("event,survival_day".to_string()),
            )]),
            group_id: None,
        });
    } else if (has_response || has_survival)
        && !((task_response && has_response) || (task_survival && has_survival))
    {
        reasons.push(Reason {
            code: ReasonCode::TaskIncompatible,
            params: BTreeMap::from([
                (
                    "tasks".to_string(),
                    serde_json::Value::Array(
                        m.tasks.iter().map(|t| serde_json::Value::String(t.clone())).collect(),
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

/// The draw coverage per method: the per-patient draw count across the
/// method's markers is the MAX per-marker count (the inventory counts are per
/// marker, and a visit row carries every marker measured that visit);
/// `needs_baseline` requires a baseline draw of at least one method marker.
/// Returns (coverage, min_draws verdict, patients with no value at all ≤
/// decision day).
fn draw_coverage(
    inv: &InventoryEligibilityRequest,
    m: &Method,
    used: &[&InventoryMarker],
) -> (Coverage, MinDraws, u32) {
    let mut per_patient: BTreeMap<&str, u32> = BTreeMap::new(); // key -> max draws
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
            let meets_draws = m.min_draws == 0 || *draws >= m.min_draws;
            if meets_draws && (!m.needs_baseline || has_baseline) {
                eligible_count += 1;
            }
        }
        // Patients outside the per-patient lists have no value of ANY of the
        // method's markers; entries with (0, 0) have values only after the
        // decision day — both fail the decision-day rule.
        let absent = total.saturating_sub(per_patient.len() as u32);
        let no_value_count = zero_draws.saturating_add(absent).min(total);
        let eligible = eligible_count.min(total);
        (
            eligible,
            no_value_count,
            MinDraws {
                required: m.min_draws,
                met: eligible,
                unmet_patients: total - eligible,
            },
        )
    } else {
        // Fallback: marker-level counts only — the draw-PRESENCE cohort
        // (baseline + at least one on-treatment value) is the eligible set;
        // the exactly-N-draws part is not verifiable without per-patient
        // entries (see the module doc; the validator always builds them).
        let mut best_value: u32 = 0;
        let mut best_cohort: u32 = 0;
        for mk in used {
            let cohort = if m.needs_baseline {
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
                required: m.min_draws,
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
/// from `eligible`/`total`; consumers format the display copy themselves —
/// DEC-6 keeps the server text-free).
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// The status lattice: a hard reason is `cannot_run`; otherwise the draw
/// coverage decides `can_run_some` vs `can_run`. A method with ZERO eligible
/// patients is `cannot_run` (the board's "0 of 94 have them" — a method
/// nobody can run for is not offered at all; the coverage reasons already on
/// the verdict explain WHY), `can_run` only when every patient is eligible.
fn verdict(reasons: &[Reason], eligible: u32, total: u32) -> EligibilityStatus {
    let hard = reasons.iter().any(|r| {
        matches!(
            r.code,
            ReasonCode::NotRunnable
                | ReasonCode::EnvImageMissing
                | ReasonCode::RequiredMarkerMissing
                | ReasonCode::MarkerGroupMissing
                | ReasonCode::DetectionCallMissing
                | ReasonCode::CovariateMissing
                | ReasonCode::CovariateRequiredUnmet
                | ReasonCode::UnitMismatch
                | ReasonCode::TaskIncompatible
                | ReasonCode::ResponseLabelMissing
                | ReasonCode::SurvivalOutcomeMissing
        )
    });
    if hard || (total > 0 && eligible == 0) {
        EligibilityStatus::CannotRun
    } else if eligible < total {
        EligibilityStatus::CanRunSome
    } else {
        EligibilityStatus::CanRun
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-1/2/3/4 + TEST-MC-27 — the port fixtures' expected values were
// produced by running data.py on the same strings (INV-2); the lattice cases
// are pinned over handcrafted catalogues so every rule can be exercised
// (the shipped catalogue is the runnable set — DEC-2 — and never triggers
// NOT_RUNNABLE).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::catalogue::parse_catalogue;
    use crate::modules::method_catalogue::types::{
        MatchMode, PatientDrawCounts, StandardId, UnitFamily,
    };

    // ---- TEST-MC-1: parse_standard_ids (data.py goldens) ------------------

    #[test]
    fn parse_standard_ids_matches_data_py_goldens() {
        fn set(text: &str) -> Vec<String> {
            parse_standard_ids(text).into_iter().collect()
        }
        // The EXAMPLE-E6 string.
        assert_eq!(
            set("LOINC 2039-6 CEA; gene: VEGFA; UniProt P05109 gene S100A8"),
            vec!["2039-6", "p05109", "s100a8", "vegfa"]
        );
        // TEST-MC-1's fixture texts.
        assert_eq!(set("LOINC 2039-6 CEA"), vec!["2039-6"]);
        assert_eq!(
            set("LOINC 24467-3 CD3+CD4+ (T4 helper) cells [#/volume] in Blood (verified 2026-10-21)"),
            vec!["24467-3"]
        );
        assert_eq!(set("gene: VEGFA"), vec!["vegfa"]);
        assert_eq!(
            set("UniProt P05109 gene S100A8, P06702 gene S100A9"),
            vec!["p05109", "p06702", "s100a8", "s100a9"]
        );
        assert_eq!(set("HMDB0000045"), vec!["hmdb0000045"]);
        assert_eq!(set("MIMAT0000021"), vec!["mimat0000021"]);
        assert_eq!(set("no HGNC term"), Vec::<String>::new());
        // Additional cases the same reference produced (the clause-split, the
        // comma-joined LOINC clause, the stop-word path, the gene fallback).
        assert_eq!(set("LOINC 2039-6, LOINC 2039-7 CEA"), vec!["2039-6", "2039-7"]);
        assert_eq!(set("HGNC: EYA4"), vec!["eya4"]);
        assert_eq!(set("no HGNC id; gene: VEGFA"), vec!["vegfa"]);
        // The clause + stop-word interplay (the "no HGNC term" substitution,
        // the semicolon clause split, the `55-95` LOINC-shaped token inside
        // the LOINC clause).
        assert_eq!(
            set("HGNC term; UniProt P02671; HMDB0000045"),
            vec!["hmdb0000045", "p02671"]
        );
        assert_eq!(set("LOINC 24467-3 CD3+CD4+ 55-95%"), vec!["24467-3", "55-95"]);
        // The adversarial battery (each value is data.py's own output).
        assert_eq!(set("UNIPROT P02671 & UniProt: P02671"), vec!["p02671"]);
        assert_eq!(set("HGNC:0000036"), vec!["0000036"]);
        assert_eq!(set("HGNC 2039-6"), vec!["2039-6"]);
        assert_eq!(set("gene: MIMAT0000021"), vec!["mimat0000021"]);
        assert_eq!(set("LOINC 2039-6;LOINC 2039-6"), vec!["2039-6"]);
        assert_eq!(set("CEA (2039-6)"), Vec::<String>::new()); // no LOINC key in the clause
        assert_eq!(set("UniProt (P05109)"), vec!["p05109"]);
        assert_eq!(set("uniprot P05109 gene S100A8"), vec!["p05109", "s100a8"]);
        assert_eq!(set("HGNC: EYA4 HGNC: GRIA4"), vec!["eya4", "gria4"]);
        assert_eq!(set("HMDB0000045 HMDB0000000045"), vec!["hmdb0000045"]);
        assert_eq!(set("no HGNC gene; UniProt P02671"), vec!["p02671"]);
        assert_eq!(
            set("HGNC id EYA4; HGNC gene GRIA4; MIMAT-0000021"),
            vec!["gria4"]
        );
        assert_eq!(set("LOINC 2039-6; gene: VEGFA; no HGNC id"), vec!["2039-6", "vegfa"]);
        assert_eq!(
            set("gene EYA4 (HGNC EYA4; Eya transcriptional coactivator and phosphatase 4)"),
            vec!["eya4"]
        );
        assert_eq!(set("gene MAP3K14-AS1 (HGNC MAP3K14-AS1; MAP3K14 antisense RNA 1)"), vec!["map3k14-as1"]);
        assert_eq!(set(""), Vec::<String>::new());
    }

    // ---- TEST-MC-2: required_marker_match (data.py goldens) ---------------

    fn req_asm() -> RequiredMarkers {
        RequiredMarkers {
            markers: vec!["EYA4", "GRIA4", "ITGA4", "MAP3K14-AS1", "MSC"]
                .into_iter()
                .map(|id| RequiredMarker {
                    name: format!("{id} cfDNA methylation (%)"),
                    id_system: "HGNC".to_string(),
                    id: id.to_string(),
                })
                .collect(),
            match_mode: MatchMode::All,
            min_fraction: 0.0,
            list_source: "test".to_string(),
        }
    }

    fn asm_row(marker: &str, id: &str, feature: &str, status: &str) -> UnitMarkerRow {
        UnitMarkerRow {
            marker: marker.to_string(),
            standard_id: format!("gene {id} (HGNC {id}; the fixture row)"),
            dataset_features: vec![feature.to_string()],
            status: status.to_string(),
        }
    }

    fn asm_rows() -> Vec<UnitMarkerRow> {
        vec![
            asm_row("EYA4 cfDNA methylation (%)", "EYA4", "EYA4_methylation_percent", "mapped"),
            asm_row("GRIA4 cfDNA methylation (%)", "GRIA4", "GRIA4_methylation_percent", "partly mapped"),
            asm_row("ITGA4 cfDNA methylation (%)", "ITGA4", "ITGA4_methylation_percent", "mapped"),
            asm_row("MAP3K14-AS1 cfDNA methylation (%)", "MAP3K14-AS1", "MAP3K14_AS1_methylation_percent", "mapped"),
            asm_row("MSC cfDNA methylation (%)", "MSC", "MSC_methylation_percent", "mapped"),
        ]
    }

    fn feats(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn required_match_all_five_present_is_ok() {
        // TEST-MC-2: the asm panel all-ok case — every row mapped/partly, all
        // ids in the unit's features.
        let r = required_marker_match(&asm_rows(), &feats(&[
            "EYA4_methylation_percent",
            "GRIA4_methylation_percent",
            "ITGA4_methylation_percent",
            "MAP3K14_AS1_methylation_percent",
            "MSC_methylation_percent",
        ]), &req_asm());
        assert!(r.ok);
        assert_eq!(r.matched_ids, vec!["eya4", "gria4", "itga4", "map3k14-as1", "msc"]);
        assert!(r.missing_ids.is_empty());
        assert_eq!(r.features, feats(&[
            "EYA4_methylation_percent",
            "GRIA4_methylation_percent",
            "ITGA4_methylation_percent",
            "MAP3K14_AS1_methylation_percent",
            "MSC_methylation_percent",
        ]));
        assert_eq!(r.fraction, 1.0);
        assert_eq!(r.reason, None);
    }

    #[test]
    fn required_match_two_of_five_is_not_ok() {
        // TEST-MC-2: EYA4 + GRIA4 only (the other rows belong to another
        // modality of the same dataset in data.py terms).
        let r = required_marker_match(
            &asm_rows(),
            &feats(&["EYA4_methylation_percent", "GRIA4_methylation_percent"]),
            &req_asm(),
        );
        assert!(!r.ok);
        assert_eq!(r.matched_ids, vec!["eya4", "gria4"]);
        assert_eq!(r.missing_ids, vec!["itga4", "map3k14-as1", "msc"]);
        assert_eq!(r.fraction, 0.4);
        assert_eq!(r.reason.as_deref(), Some(REQUIRED_MARKERS_NOT_MEASURED));
        assert_eq!(r.features, feats(&["EYA4_methylation_percent", "GRIA4_methylation_percent"]));
    }

    #[test]
    fn required_match_other_system_name_fallback() {
        // TEST-MC-2: the `id_system: other` name/feature fallback — the id is
        // the canonical feature name and the standard_id text parses to no
        // standard id (the "168-gene panel" capture stays irrelevant).
        let req = RequiredMarkers {
            markers: vec![RequiredMarker {
                name: "maximum mutant allele fraction".to_string(),
                id_system: "other".to_string(),
                id: "cfTL_max_maf".to_string(),
            }],
            match_mode: MatchMode::All,
            min_fraction: 0.0,
            list_source: "test".to_string(),
        };
        let rows = vec![UnitMarkerRow {
            marker: "cfTL_max_maf".to_string(),
            standard_id: "max allele fraction of ctDNA by the 168-gene panel (no standard id)"
                .to_string(),
            dataset_features: vec!["cfTL_max_maf".to_string()],
            status: "mapped".to_string(),
        }];
        let r = required_marker_match(&rows, &feats(&["cfTL_max_maf"]), &req);
        assert!(r.ok);
        assert_eq!(r.matched_ids, vec!["cftl_max_maf"]);
        assert_eq!(r.fraction, 1.0);
        // A row of another marker cannot satisfy it.
        let other = vec![UnitMarkerRow {
            marker: "CEA".to_string(),
            standard_id: "LOINC 2039-6 CEA".to_string(),
            dataset_features: vec!["CEA_ng_per_mL".to_string()],
            status: "mapped".to_string(),
        }];
        let r2 = required_marker_match(&other, &feats(&["CEA_ng_per_mL"]), &req);
        assert!(!r2.ok);
        assert_eq!(r2.missing_ids, vec!["cftl_max_maf"]);
    }

    // ---- TEST-MC-3: min_fraction + is_companion ---------------------------

    #[test]
    fn required_match_min_fraction_three_of_five_ok() {
        let req = RequiredMarkers {
            markers: req_asm().markers,
            match_mode: MatchMode::MinFraction,
            min_fraction: 0.5,
            list_source: "test".to_string(),
        };
        let r = required_marker_match(
            &asm_rows(),
            &feats(&[
                "EYA4_methylation_percent",
                "GRIA4_methylation_percent",
                "ITGA4_methylation_percent",
            ]),
            &req,
        );
        assert!(r.ok, "fraction 0.6 >= 0.5");
        assert_eq!(r.fraction, 0.6);
        assert_eq!(r.matched_ids, vec!["eya4", "gria4", "itga4"]);
        assert_eq!(r.missing_ids, vec!["map3k14-as1", "msc"]);
        // And the 0.4 case stays below the bar.
        let r2 = required_marker_match(
            &asm_rows(),
            &feats(&["EYA4_methylation_percent", "GRIA4_methylation_percent"]),
            &req,
        );
        assert!(!r2.ok);
        assert_eq!(r2.fraction, 0.4);
    }

    #[test]
    fn is_companion_matches_the_reference_predicate() {
        assert!(!is_companion("CEA"));
        assert!(is_companion("CEA__detected"));
        assert!(is_companion("CEA__lod"));
        assert!(is_companion("__lod"));
        assert!(!is_companion("x__detected_"));
        // The caller side (data.py's unit feature list) strips companions:
        // the engine's inventory only ever carries measure columns, and the
        // __detected/__lod rows travel as the marker's own companion facts
        // (has_detection_companion) — asserted by the engine test below.
    }

    /// The row-status rule of the port: only rows whose FIRST status word is
    /// `mapped`/`partly` belong to the unit. A row carrying the same standard
    /// id but a status that says the curated marker was NOT mapped is not a
    /// match (data.py skips it the same way — the row is not evidence the
    /// unit measures the marker). The fixture is a ONE-marker required list
    /// (`match: all`), so a single row decides the verdict.
    #[test]
    fn required_match_skips_rows_that_are_not_mapped() {
        fn one_req() -> RequiredMarkers {
            RequiredMarkers {
                markers: vec![RequiredMarker {
                    name: "EYA4 cfDNA methylation (%)".to_string(),
                    id_system: "HGNC".to_string(),
                    id: "EYA4".to_string(),
                }],
                match_mode: MatchMode::All,
                min_fraction: 0.0,
                list_source: "test".to_string(),
            }
        }
        let rows = vec![asm_row(
            "EYA4 cfDNA methylation (%)",
            "EYA4",
            "EYA4_methylation_percent",
            "not mapped",
        )];
        let r = required_marker_match(&rows, &feats(&["EYA4_methylation_percent"]), &one_req());
        assert!(!r.ok);
        assert!(r.matched_ids.is_empty());
        assert_eq!(r.missing_ids, vec!["eya4"]);
        assert_eq!(r.fraction, 0.0);
        assert_eq!(r.reason.as_deref(), Some(REQUIRED_MARKERS_NOT_MEASURED));
        // "partly mapped" IS a unit row (the reference keeps it); the first
        // status word is the discriminator, not the whole string.
        let partly = vec![asm_row(
            "EYA4 cfDNA methylation (%)",
            "EYA4",
            "EYA4_methylation_percent",
            "partly mapped",
        )];
        let r2 = required_marker_match(&partly, &feats(&["EYA4_methylation_percent"]), &one_req());
        assert!(r2.ok, "a partly-mapped row is a unit row");
    }

    /// The empty-required rule of the port: a method whose required list
    /// resolves to no ids is NOT ok (data.py returns
    /// `{ok: false, reason: "required markers not measured"}` — a "no required
    /// markers measured" verdict, never a vacuous pass). The caller rule is
    /// `not m.id` (data.py's `if not m or not m.get("id")`), so an EMPTY id
    /// (not a blank-string one) triggers it.
    #[test]
    fn required_match_empty_required_is_not_measured() {
        let req = RequiredMarkers {
            markers: vec![RequiredMarker {
                name: "no id".to_string(),
                id_system: "HGNC".to_string(),
                id: String::new(),
            }],
            match_mode: MatchMode::All,
            min_fraction: 0.0,
            list_source: "test".to_string(),
        };
        let r = required_marker_match(&asm_rows(), &feats(&["EYA4_methylation_percent"]), &req);
        assert!(!r.ok);
        assert!(r.matched_ids.is_empty());
        assert!(r.missing_ids.is_empty());
        assert_eq!(r.fraction, 0.0);
        assert_eq!(r.reason.as_deref(), Some(REQUIRED_MARKERS_NOT_MEASURED));
        // The engine's inventory resolution carries the same empty-id rule:
        // an all-empty required list is a hard cannot-run, not a vacuous pass.
        let cat = one_method_catalogue(method_json(
            "fx-empty-req",
            &[(
                "required_markers",
                serde_json::json!({
                    "markers": [{"name": "x", "id_system": "HGNC", "id": ""}],
                    "match": "all", "min_fraction": 0.0, "list_source": "t"}),
            )],
        ));
        let v = verdict_of(&cat, &inventory_req(1, vec![], vec![]), "fx-empty-req");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v
            .reasons
            .iter()
            .any(|r| r.code == ReasonCode::RequiredMarkerMissing));
    }

    // ---- catalogue + inventory builders -----------------------------------

    fn groups_json() -> serde_json::Value {
        serde_json::json!([
            {"id": "ctdna", "display_name": "Tumour DNA in blood (ctDNA)"},
            {"id": "methylation-sequencing", "display_name": "Methylation or other sequencing"},
            {"id": "tumour-markers", "display_name": "Tumour markers (CEA, CA 19-9, CA-125, PSA)"}
        ])
    }

    /// A vocabulary marker JSON (the loader's shape).
    fn vocab_json(id: &str, system: &str, unit: &str, groups: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "system": system,
            "display_name": format!("{id} display name"),
            "aliases": [format!("{id}_alias")],
            "groups": groups,
            "unit_family": unit,
            "canonical_unit": "%",
            "n_methods": 1
        })
    }

    /// A full methods[] entry JSON; `overrides` replace the base fields.
    fn method_json(id: &str, overrides: &[(&str, serde_json::Value)]) -> serde_json::Value {
        let mut m = serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "group": "response-call",
            "group_label": "Response call",
            "journal": "J",
            "year": 2026,
            "citations": 0,
            "language": "Python",
            "paper_doi": "",
            "spec_status": "verified",
            "frozen_model": false,
            "container": false,
            "runnable": true,
            "gate": {"pass": true, "report_name": format!("{id}.report.md")},
            "env": {"image": format!("ghcr.io/tinnlab/txresbench-{id}:1.0.0"),
                    "digest": "sha256:aa", "contract": "2.0"},
            "markers": {"kind": "any", "count": 0},
            "covariates": "none",
            "min_draws": 1,
            "needs_baseline": false,
            "uses_history": "landmark",
            "fitted": false,
            "saves_model": false,
            "own_outputs": [],
            "tasks": [],
            "required_markers": null,
            "needs_detection_call": false,
            "marker_groups_required": [],
            "description": "d",
            "timing": {"base_seconds_per_fold": 60.0, "benchmarked_units": 1, "quality": "measured"},
            "performance": null,
            "embeds_training_data": false,
            "software": {"language": "R", "packages": {}},
            "licence": "MIT",
            "references": [],
            "params": {}
        });
        for (k, v) in overrides {
            m[(*k).to_string()] = v.clone();
        }
        m
    }

    /// A catalogue with one method, one vocabulary marker and the 3 groups
    /// above (the loader's validation runs, so the entry must be complete).
    fn catalogue_with(methods: serde_json::Value, markers: serde_json::Value) -> Catalogue {
        let doc = serde_json::json!({
            "schema_version": 1,
            "generated_from": {"registry_name": "t", "methods_commit": "t",
                "manifest_commit": "t", "results_commit": "t",
                "generated_at": "2026-01-01T00:00:00Z"},
            "methods": methods,
            "markers": markers,
            "groups": groups_json()
        });
        parse_catalogue(serde_json::to_vec(&doc).unwrap().as_slice()).expect("test catalogue")
    }

    fn one_method_catalogue(m: serde_json::Value) -> Catalogue {
        catalogue_with(serde_json::json!([m]), serde_json::json!([]))
    }

    fn sid(system: &str, id: &str) -> StandardId {
        StandardId {
            system: system.to_string(),
            id: id.to_string(),
        }
    }

    fn inv_marker(
        key: &str,
        unit: &str,
        standard_ids: Vec<StandardId>,
        per_patient: Option<Vec<PatientDrawCounts>>,
    ) -> InventoryMarker {
        let n = per_patient.as_ref().map(|p| p.len()).unwrap_or(0) as u32;
        InventoryMarker {
            key: key.to_string(),
            display_name: format!("{key} display name"),
            unit_family: match unit {
                "percent" => UnitFamily::Percent,
                "concentration_mass" => UnitFamily::ConcentrationMass,
                _ => UnitFamily::None,
            },
            standard_ids,
            is_detection_call: false,
            has_detection_companion: false,
            n_patients_with_value: n,
            n_patients_with_baseline: n,
            n_patients_with_ontreatment: n,
            per_patient,
        }
    }

    fn pat(key: &str, baseline: u32, ontreatment: u32) -> PatientDrawCounts {
        PatientDrawCounts {
            patient_key: key.to_string(),
            baseline_draws: baseline,
            ontreatment_draws: ontreatment,
        }
    }

    fn inventory_req(
        patients: u32,
        markers: Vec<InventoryMarker>,
        covariates: Vec<crate::modules::method_catalogue::types::InventoryCovariate>,
    ) -> InventoryEligibilityRequest {
        InventoryEligibilityRequest {
            patients,
            decision_day: 56.0,
            baseline_max_day: 0.0,
            markers,
            covariates,
            outcomes: None,
        }
    }

    fn verdict_of(cat: &Catalogue, req: &InventoryEligibilityRequest, id: &str) -> MethodEligibility {
        let resp = eligibility_for(cat, &EligibilityRequest::Inventory {
            inventory: req.clone(),
        });
        resp.methods
            .into_iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("method {id} not found"))
    }

    // ---- TEST-MC-4: the status lattice ------------------------------------

    /// The fixture-world panel method (EYA4 + GRIA4 HGNC, match all,
    /// min_draws 2, needs_baseline) over an inventory that carries the two
    /// methylation markers for 120 of 151 patients (3 draw-days each) and
    /// 2-draw entries for the remaining 31.
    #[test]
    fn lattice_can_run_some_when_draws_leave_patients_out() {
        let m = method_json("fx-panel", &[
            ("required_markers", serde_json::json!({
                "markers": [
                    {"name": "EYA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "EYA4"},
                    {"name": "GRIA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "GRIA4"}
                ],
                "match": "all", "min_fraction": 0.0, "list_source": "t"})),
            ("min_draws", serde_json::json!(3)),
            ("needs_baseline", serde_json::json!(true)),
            ("marker_groups_required", serde_json::json!(["methylation-sequencing"])),
        ]);
        let cat = one_method_catalogue(m);
        let mut entries: Vec<PatientDrawCounts> = Vec::new();
        for i in 0..120 {
            entries.push(pat(&format!("p{i}"), 1, 2));
        }
        for i in 120..151 {
            entries.push(pat(&format!("p{i}"), 1, 1)); // 2 draws < 3
        }
        let markers = vec![
            inv_marker("EYA4", "percent", vec![sid("HGNC", "EYA4")], Some(entries.clone())),
            inv_marker("GRIA4", "percent", vec![sid("HGNC", "GRIA4")], Some(entries)),
        ];
        let req = inventory_req(151, markers, vec![]);
        let v = verdict_of(&cat, &req, "fx-panel");
        // EXAMPLE-E3's numbers.
        assert_eq!(v.status, EligibilityStatus::CanRunSome);
        assert_eq!(v.coverage.eligible, 120);
        assert_eq!(v.coverage.total, 151);
        assert_eq!(v.coverage.fraction, 0.795);
        assert_eq!(v.min_draws.required, 3);
        assert_eq!(v.min_draws.met, 120);
        assert_eq!(v.min_draws.unmet_patients, 31);
        let codes: Vec<_> = v.reasons.iter().map(|r| r.code).collect();
        assert!(codes.contains(&ReasonCode::MinDrawsUnmet), "{codes:?}");
        assert!(!codes.contains(&ReasonCode::DecisionDayUnmet), "{codes:?}");
        // The estimate is the DEC-7 shape on the run's own CPU count (CM-7:
        // the row time and the run are one number — Auto resolves the host).
        assert_eq!(
            v.estimated_seconds,
            60.0 * 151.0 / 150.0 * 4.0 / host_cpus() as f64
        );
    }

    #[test]
    fn lattice_can_run_when_every_patient_meets_the_rule() {
        let m = method_json("fx-panel", &[
            ("required_markers", serde_json::json!({
                "markers": [
                    {"name": "EYA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "EYA4"},
                    {"name": "GRIA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "GRIA4"}
                ],
                "match": "all", "min_fraction": 0.0, "list_source": "t"})),
            ("min_draws", serde_json::json!(2)),
            ("needs_baseline", serde_json::json!(true)),
        ]);
        let cat = one_method_catalogue(m);
        let entries = vec![
            pat("p0", 1, 1),
            pat("p1", 1, 2),
            pat("p2", 0, 0), // values only after the decision day
        ];
        let markers = vec![
            inv_marker("EYA4", "percent", vec![sid("HGNC", "EYA4")], Some(entries.clone())),
            inv_marker("GRIA4", "percent", vec![sid("HGNC", "GRIA4")], Some(entries)),
        ];
        let req = inventory_req(3, markers, vec![]);
        let v = verdict_of(&cat, &req, "fx-panel");
        assert_eq!(v.status, EligibilityStatus::CanRunSome);
        assert_eq!(v.coverage.eligible, 2);
        assert_eq!(v.coverage.total, 3);
        assert!(v.coverage.fraction > 0.665 && v.coverage.fraction < 0.668);
        let codes: Vec<_> = v.reasons.iter().map(|r| r.code).collect();
        assert!(codes.contains(&ReasonCode::DecisionDayUnmet), "{codes:?}");

        // All patients covered -> can_run.
        let entries2 = vec![pat("p0", 1, 1), pat("p1", 1, 2), pat("p2", 1, 1)];
        let markers2 = vec![
            inv_marker("EYA4", "percent", vec![sid("HGNC", "EYA4")], Some(entries2.clone())),
            inv_marker("GRIA4", "percent", vec![sid("HGNC", "GRIA4")], Some(entries2)),
        ];
        let req2 = inventory_req(3, markers2, vec![]);
        let v2 = verdict_of(&cat, &req2, "fx-panel");
        assert_eq!(v2.status, EligibilityStatus::CanRun);
        assert_eq!(v2.coverage.eligible, 3);
        assert_eq!(v2.coverage.total, 3);
        assert_eq!(v2.coverage.fraction, 1.0);
        assert!(v2.reasons.is_empty());
    }

    #[test]
    fn lattice_cannot_run_when_a_required_marker_is_absent() {
        let m = method_json("fx-panel", &[
            ("required_markers", serde_json::json!({
                "markers": [
                    {"name": "EYA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "EYA4"},
                    {"name": "GRIA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "GRIA4"}
                ],
                "match": "all", "min_fraction": 0.0, "list_source": "t"})),
        ]);
        let markers = serde_json::json!([vocab_json("EYA4", "HGNC", "percent", &["methylation-sequencing"])]);
        let cat = catalogue_with(serde_json::json!([m]), markers);
        let entries = vec![pat("p0", 1, 1)];
        let req = inventory_req(1, vec![inv_marker("EYA4", "percent", vec![sid("HGNC", "EYA4")], Some(entries))], vec![]);
        let v = verdict_of(&cat, &req, "fx-panel");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v
            .reasons
            .iter()
            .any(|r| r.code == ReasonCode::RequiredMarkerMissing));
        // The missing entry carries the required marker's name (no vocabulary
        // entry of the fixture catalogue resolves GRIA4) and no group.
        assert_eq!(v.missing_markers.len(), 1);
        assert_eq!(v.missing_markers[0].id, "GRIA4");
        assert_eq!(v.missing_markers[0].id_system, "HGNC");
        assert_eq!(v.missing_markers[0].display_name, "GRIA4 cfDNA methylation (%)");
        assert_eq!(v.missing_markers[0].group_id.as_deref(), None);
    }

    #[test]
    fn lattice_cannot_run_when_required_covariates_absent() {
        let m = method_json("fx-signature", &[
            ("required_markers", serde_json::json!({
                "markers": [{"name": "CEA", "id_system": "LOINC", "id": "2039-6"}],
                "match": "all", "min_fraction": 0.0, "list_source": "t"})),
            ("covariates", serde_json::json!("required")),
        ]);
        let cat = one_method_catalogue(m);
        let entries = vec![pat("p0", 1, 1)];
        let req = inventory_req(
            1,
            vec![inv_marker("CEA", "concentration_mass", vec![sid("LOINC", "2039-6")], Some(entries))],
            vec![],
        );
        let v = verdict_of(&cat, &req, "fx-signature");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v
            .reasons
            .iter()
            .any(|r| r.code == ReasonCode::CovariateRequiredUnmet));
    }

    #[test]
    fn lattice_cannot_run_on_unit_mismatch() {
        let m = method_json("fx-signature", &[
            ("required_markers", serde_json::json!({
                "markers": [{"name": "CEA", "id_system": "LOINC", "id": "2039-6"}],
                "match": "all", "min_fraction": 0.0, "list_source": "t"})),
        ]);
        let markers = serde_json::json!([
            vocab_json("2039-6", "LOINC", "concentration_mass", &["tumour-markers"])
        ]);
        let cat = catalogue_with(serde_json::json!([m]), markers);
        let entries = vec![pat("p0", 1, 1)];
        // The file measured CEA as a percent — a different family than the
        // vocabulary's concentration_mass.
        let req = inventory_req(
            1,
            vec![inv_marker("CEA", "percent", vec![sid("LOINC", "2039-6")], Some(entries))],
            vec![],
        );
        let v = verdict_of(&cat, &req, "fx-signature");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v.reasons.iter().any(|r| r.code == ReasonCode::UnitMismatch));
        // Same family is fine.
        let req_ok = inventory_req(
            1,
            vec![inv_marker(
                "CEA",
                "concentration_mass",
                vec![sid("LOINC", "2039-6")],
                Some(vec![pat("p0", 1, 1)]),
            )],
            vec![],
        );
        let v_ok = verdict_of(&cat, &req_ok, "fx-signature");
        assert_eq!(v_ok.status, EligibilityStatus::CanRun);
    }

    #[test]
    fn lattice_cannot_run_when_detection_call_absent() {
        let m = method_json("fx-detect", &[
            ("needs_detection_call", serde_json::json!(true)),
        ]);
        let cat = one_method_catalogue(m);
        let req = inventory_req(
            1,
            vec![inv_marker("measured", "percent", vec![sid("LOINC", "2039-6")], Some(vec![pat("p0", 1, 1)]))],
            vec![],
        );
        let v = verdict_of(&cat, &req, "fx-detect");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v.reasons.iter().any(|r| r.code == ReasonCode::DetectionCallMissing));
        // A companion marker satisfies the call requirement.
        let mut mk = inv_marker("measured", "percent", vec![sid("LOINC", "2039-6")], Some(vec![pat("p0", 1, 1)]));
        mk.has_detection_companion = true;
        let req2 = inventory_req(1, vec![mk], vec![]);
        let v2 = verdict_of(&cat, &req2, "fx-detect");
        assert_eq!(v2.status, EligibilityStatus::CanRun);
    }

    #[test]
    fn lattice_not_runnable_without_env_image() {
        // The shipped catalogue never carries one (DEC-2, boot-validated), so
        // the rule is exercised through the handcrafted-catalogue seam.
        let m = method_json("fx-not-runnable", &[
            ("runnable", serde_json::json!(false)),
        ]);
        let cat = one_method_catalogue(m);
        let req = inventory_req(1, vec![], vec![]);
        let v = verdict_of(&cat, &req, "fx-not-runnable");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v.reasons.iter().any(|r| r.code == ReasonCode::NotRunnable));
    }

    /// The engine's OWN min_fraction resolution (TEST-MC-3's engine half; the
    /// row-port case above is the data.py-shape seam): a method declaring
    /// `match: "min_fraction"` with 2 required markers is runnable when the
    /// file carries 1 of them (fraction 0.5 ≥ 0.5) — the verdict is the draw
    /// coverage, not a marker failure.
    #[test]
    fn engine_min_fraction_partial_set_is_ok() {
        let m = method_json("fx-panel-minfrac", &[
            ("required_markers", serde_json::json!({
                "markers": [
                    {"name": "EYA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "EYA4"},
                    {"name": "GRIA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "GRIA4"}
                ],
                "match": "min_fraction", "min_fraction": 0.5, "list_source": "t"})),
        ]);
        let markers = serde_json::json!([
            vocab_json("EYA4", "HGNC", "percent", &["methylation-sequencing"])
        ]);
        let cat = catalogue_with(serde_json::json!([m]), markers.clone());
        let entries = vec![pat("p0", 1, 1)];
        let req = inventory_req(
            1,
            vec![inv_marker("EYA4", "percent", vec![sid("HGNC", "EYA4")], Some(entries))],
            vec![],
        );
        let v = verdict_of(&cat, &req, "fx-panel-minfrac");
        assert_eq!(v.status, EligibilityStatus::CanRun);
        assert!(
            !v.reasons.iter().any(|r| r.code == ReasonCode::RequiredMarkerMissing),
            "min_fraction 0.5 with 1-of-2 present is ok: {:?}",
            v.reasons
        );
        // The same method with `match: "all"` fails on the missing second.
        let m2 = method_json("fx-panel-all", &[
            ("required_markers", serde_json::json!({
                "markers": [
                    {"name": "EYA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "EYA4"},
                    {"name": "GRIA4 cfDNA methylation (%)", "id_system": "HGNC", "id": "GRIA4"}
                ],
                "match": "all", "min_fraction": 0.0, "list_source": "t"})),
        ]);
        let cat2 = catalogue_with(serde_json::json!([m2]), markers);
        let req2 = inventory_req(
            1,
            vec![inv_marker("EYA4", "percent", vec![sid("HGNC", "EYA4")], Some(vec![pat("p0", 1, 1)]))],
            vec![],
        );
        let v2 = verdict_of(&cat2, &req2, "fx-panel-all");
        assert_eq!(v2.status, EligibilityStatus::CannotRun);
        assert!(v2.reasons.iter().any(|r| r.code == ReasonCode::RequiredMarkerMissing));
    }

    /// The engine's `other`-system name/alias fallback (TEST-MC-2's engine
    /// half): a required marker with an assay-defined id (`id_system: "other"`)
    /// is answered by a file marker whose RESOLVED VOCABULARY entry carries the
    /// required id as an ALIAS — the column name and id alone do not match.
    #[test]
    fn engine_other_system_fallback_uses_vocabulary_aliases() {
        let m = method_json("fx-other", &[
            ("required_markers", serde_json::json!({
                "markers": [{"name": "maximum mutant allele fraction",
                             "id_system": "other", "id": "max_maf"}],
                "match": "all", "min_fraction": 0.0, "list_source": "t"})),
        ]);
        // The vocabulary entry's id is the canonical feature name; the
        // REQUIRED id is only one of its aliases (the join-offer surface).
        let markers = serde_json::json!([{
            "id": "cfTL_max_maf",
            "system": "OTHER",
            "display_name": "maximum mutant allele fraction",
            "aliases": ["max_maf", "cfTL_max_maf"],
            "groups": ["ctdna"],
            "unit_family": "percent",
            "canonical_unit": "%",
            "n_methods": 1
        }]);
        let cat = catalogue_with(serde_json::json!([m]), markers);
        // The file marker is named nothing like the required id and its own
        // standard id is the canonical name (not the alias): only the alias
        // surface of the vocabulary entry answers the required id.
        let marker = InventoryMarker {
            key: "mut_af".to_string(),
            display_name: "mutant allele fraction".to_string(),
            unit_family: UnitFamily::Percent,
            standard_ids: vec![sid("OTHER", "cfTL_max_maf")],
            is_detection_call: false,
            has_detection_companion: false,
            n_patients_with_value: 1,
            n_patients_with_baseline: 1,
            n_patients_with_ontreatment: 1,
            per_patient: Some(vec![pat("p0", 1, 1)]),
        };
        let req = inventory_req(1, vec![marker], vec![]);
        let v = verdict_of(&cat, &req, "fx-other");
        assert_eq!(
            v.status,
            EligibilityStatus::CanRun,
            "the vocabulary alias resolves the other-system id: {:?}",
            v.reasons
        );
        // Without the vocabulary entry (no alias to resolve) the same column
        // is NOT a match — the required id never appears in any name set.
        let cat2 = one_method_catalogue(m);
        let req2 = inventory_req(1, vec![InventoryMarker {
            key: "mut_af".to_string(),
            display_name: "mutant allele fraction".to_string(),
            unit_family: UnitFamily::Percent,
            standard_ids: vec![sid("OTHER", "cfTL_max_maf")],
            is_detection_call: false,
            has_detection_companion: false,
            n_patients_with_value: 1,
            n_patients_with_baseline: 1,
            n_patients_with_ontreatment: 1,
            per_patient: Some(vec![pat("p0", 1, 1)]),
        }], vec![]);
        let v2 = verdict_of(&cat2, &req2, "fx-other");
        assert_eq!(v2.status, EligibilityStatus::CannotRun);
        assert!(v2
            .reasons
            .iter()
            .any(|r| r.code == ReasonCode::RequiredMarkerMissing));
    }

    // ---- preview (screen B) -------------------------------------------------

    #[test]
    fn preview_reports_groups_and_draws() {
        let m = method_json("fx-panel", &[
            ("marker_groups_required", serde_json::json!(["methylation-sequencing", "ctdna"])),
            ("min_draws", serde_json::json!(3)),
            ("needs_baseline", serde_json::json!(true)),
        ]);
        let methods = serde_json::json!([m, method_json("fx-free", &[]), method_json("fx-nope", &[("runnable", serde_json::json!(false))])]);
        let cat = catalogue_with(methods, serde_json::json!([]));
        let preview = PreviewEligibilityRequest {
            marker_groups: BTreeMap::from([("methylation-sequencing".to_string(), true)]),
            before_treatment: "always".to_string(),
            draws_during_treatment: 2,
            last_draw_day: 56.0,
        };
        let resp = eligibility_for(&cat, &EligibilityRequest::Preview { preview });
        let v = resp.methods.iter().find(|m| m.id == "fx-panel").unwrap();
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v.reasons.iter().any(|r| r.code == ReasonCode::MarkerGroupMissing));
        assert_eq!(v.missing_groups.len(), 1);
        assert_eq!(v.missing_groups[0].group_id, "ctdna");
        let vfree = resp.methods.iter().find(|m| m.id == "fx-free").unwrap();
        assert_eq!(vfree.status, EligibilityStatus::CanRun);
        assert_eq!(resp.total_fit, 1);
        assert_eq!(resp.total_cannot, 2);
        assert_eq!(resp.total_some, 0);
    }

    #[test]
    fn preview_sometimes_baseline_is_some() {
        let m = method_json("fx-baseline", &[("needs_baseline", serde_json::json!(true))]);
        let cat = one_method_catalogue(m);
        let preview = PreviewEligibilityRequest {
            marker_groups: BTreeMap::new(),
            before_treatment: "sometimes".to_string(),
            draws_during_treatment: 2,
            last_draw_day: 56.0,
        };
        let resp = eligibility_for(&cat, &EligibilityRequest::Preview { preview });
        assert_eq!(resp.methods[0].status, EligibilityStatus::CanRunSome);
        assert_eq!(resp.total_some, 1);
    }

    // ---- TEST-MC-27: the reason-code vocabulary + the outcome codes --------

    #[test]
    fn reason_code_vocabulary_is_the_closed_thirteen() {
        assert_eq!(
            ReasonCode::ALL.map(|c| c.as_str()).to_vec(),
            vec![
                "REQUIRED_MARKER_MISSING",
                "MARKER_GROUP_MISSING",
                "DETECTION_CALL_MISSING",
                "MIN_DRAWS_UNMET",
                "COVARIATE_MISSING",
                "COVARIATE_REQUIRED_UNMET",
                "UNIT_MISMATCH",
                "DECISION_DAY_UNMET",
                "NOT_RUNNABLE",
                "ENV_IMAGE_MISSING",
                "TASK_INCOMPATIBLE",
                "RESPONSE_LABEL_MISSING",
                "SURVIVAL_OUTCOME_MISSING",
            ]
        );
    }

    fn resp_method(m: serde_json::Value, outcomes: Option<FileOutcomes>) -> (MethodEligibility, Catalogue) {
        let cat = one_method_catalogue(m);
        // The outcome checks do not need patient data — use an empty file
        // (0 patients) so the draw coverage contributes no facts.
        let req = inventory_req(0, vec![], vec![]);
        let mut req2 = req;
        req2.outcomes = outcomes;
        let v = verdict_of(&cat, &req2, &cat.methods[0].id.clone());
        (v, cat)
    }

    #[test]
    fn outcome_availability_codes() {
        let response_method = method_json("fx-response-task", &[("tasks", serde_json::json!(["response"]))]);
        let survival_method = method_json("fx-surv-task", &[("tasks", serde_json::json!(["survival"]))]);

        // A response method on a file without responder/response_day.
        let (v, _c) = resp_method(
            response_method.clone(),
            Some(FileOutcomes { has_responder: false, has_response_day: false, has_event: true, has_survival_day: true }),
        );
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v.reasons.iter().any(|r| {
            r.code == ReasonCode::ResponseLabelMissing
                && r.params.get("required").is_some()
        }));

        // A survival method on a file with neither event nor survival day.
        let (v, _c) = resp_method(
            survival_method.clone(),
            Some(FileOutcomes { has_responder: true, has_response_day: true, has_event: false, has_survival_day: false }),
        );
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v.reasons.iter().any(|r| r.code == ReasonCode::SurvivalOutcomeMissing));

        // Task/outcome mismatch: the registry's non-outcome task vocabulary
        // (the fixture methods carry "none"/"optional"/"required" — a task
        // spelling that names no outcome kind) on a file carrying an outcome
        // column: the declared tasks exclude the file's outcome kind.
        let odd_task = method_json("fx-odd-task", &[("tasks", serde_json::json!(["none"]))]);
        let (v, _c) = resp_method(
            odd_task,
            Some(FileOutcomes { has_responder: true, has_response_day: true, has_event: false, has_survival_day: false }),
        );
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert!(v
            .reasons
            .iter()
            .any(|r| r.code == ReasonCode::TaskIncompatible && r.params.get("tasks").is_some()));

        // Both outcomes present -> the survival method runs.
        let (v, _c) = resp_method(
            survival_method,
            Some(FileOutcomes { has_responder: true, has_response_day: true, has_event: true, has_survival_day: true }),
        );
        assert_eq!(v.status, EligibilityStatus::CanRun);

        // A response-on-response match runs, and the outcome block absent
        // skips the outcome checks entirely.
        let (v, _c) = resp_method(
            response_method.clone(),
            Some(FileOutcomes { has_responder: true, has_response_day: true, has_event: false, has_survival_day: false }),
        );
        assert_eq!(v.status, EligibilityStatus::CanRun);
    }

    #[test]
    fn taskless_method_is_compatible_with_any_file_outcome() {
        // The shipped catalogue carries `tasks: []` for 343 of 359 methods
        // (execution-engine DRIFT-1 ITEM-4 #5); the owner's rule (2026-10-20:
        // task/endpoint are not part of a run — every method runs on every
        // outcome the patients table supports) makes the empty list mean
        // "any outcome", never a TASK_INCOMPATIBLE.
        for outcomes in [
            Some(FileOutcomes { has_responder: true, has_response_day: true, has_event: true, has_survival_day: true }),
            Some(FileOutcomes { has_responder: false, has_response_day: false, has_event: true, has_survival_day: true }),
            Some(FileOutcomes { has_responder: true, has_response_day: true, has_event: false, has_survival_day: false }),
            Some(FileOutcomes { has_responder: false, has_response_day: false, has_event: false, has_survival_day: false }),
            None,
        ] {
            let (v, _c) = resp_method(
                method_json("fx-taskless", &[("tasks", serde_json::json!([]))]),
                outcomes,
            );
            assert!(
                !v.reasons.iter().any(|r| {
                    matches!(r.code, ReasonCode::TaskIncompatible | ReasonCode::ResponseLabelMissing | ReasonCode::SurvivalOutcomeMissing)
                }),
                "task-less method must carry no outcome verdict: {v:?}"
            );
        }
    }

    #[test]
    fn outcome_block_absent_skips_outcome_checks() {
        let m = method_json("fx-response-task", &[("tasks", serde_json::json!(["response"]))]);
        let cat = one_method_catalogue(m);
        let req = inventory_req(0, vec![], vec![]);
        let v = verdict_of(&cat, &req, "fx-response-task");
        // No outcome facts posted -> no outcome-availability verdict (the
        // consumer did not carry them; decode awaits file-validator's grow).
        assert!(v.reasons.is_empty());
        assert_eq!(v.status, EligibilityStatus::CanRun);
    }

    /// The estimation helper is the DEC-7 shape (ITEM-4's endpoint reuses it).
    #[test]
    fn estimate_helper_is_the_dec7_shape() {
        let m = method_json("fx-timing", &[("timing", serde_json::json!({
            "base_seconds_per_fold": 60.0, "benchmarked_units": 1, "quality": "measured"}))]);
        let cat = one_method_catalogue(m);
        let mm = cat.method("fx-timing").unwrap();
        assert_eq!(estimate_seconds_for(mm, 300, 8), 60.0 * 2.0 * 0.5);
        assert_eq!(estimate_seconds_for(mm, 300, 0), 60.0 * 2.0 * 1.0); // 0 -> default
        assert_eq!(estimate_seconds_for(mm, 150, 4), 60.0);
        assert_eq!(estimate_quality_for(mm), TimingQuality::Measured);
    }

    // ---- QA-fixes ITEM-2: the runtime-env stage + the 0-eligible verdict ----

    /// CM-6: a method NO patient is eligible for is `cannot_run` (its
    /// coverage reasons already explain why) — never a selectable
    /// "Can run for some patients" row with 0 coverage.
    #[test]
    fn lattice_zero_eligible_patients_is_cannot_run() {
        let m = method_json("fx-nowhere", &[("min_draws", serde_json::json!(3))]);
        let cat = one_method_catalogue(m);
        // All 94 patients have 2 draws (baseline + one) < 3.
        let entries: Vec<PatientDrawCounts> = (0..94).map(|i| pat(&format!("p{i}"), 1, 1)).collect();
        let markers = vec![
            inv_marker("M1", "percent", vec![sid("HGNC", "M1")], Some(entries.clone())),
            inv_marker("M2", "percent", vec![sid("HGNC", "M2")], Some(entries)),
        ];
        let req = inventory_req(94, markers, vec![]);
        let v = verdict_of(&cat, &req, "fx-nowhere");
        assert_eq!(v.status, EligibilityStatus::CannotRun);
        assert_eq!(v.coverage.eligible, 0);
        assert!(v.reasons.iter().any(|r| r.code == ReasonCode::MinDrawsUnmet));
        assert!(!v.reasons.is_empty(), "the why is on the verdict");
    }

    /// CM-1: the runtime-env stage reclassifies every catalogue method with no
    /// published environment to `cannot_run`, pushes
    /// `ENV_IMAGE_MISSING` FIRST (the row's one detail line + the engine's
    /// run-row reason), and counts them in `total_no_env` — the pure engine
    /// (the test seam) carries no env facts. The two ids are REAL manifest
    /// membership facts: `asm-best-change-rule` is one of the 94 published
    /// envs, `bjm` is not.
    #[test]
    fn runtime_env_stage_marks_and_counts_missing_published_envs() {
        let methods = serde_json::json!([
            method_json("asm-best-change-rule", &[]),
            method_json("bjm", &[]),
        ]);
        let cat = catalogue_with(methods, serde_json::json!([]));
        let entries = vec![pat("p0", 1, 1)];
        let markers = vec![
            inv_marker("M1", "percent", vec![sid("HGNC", "M1")], Some(entries.clone())),
            inv_marker("M2", "percent", vec![sid("HGNC", "M2")], Some(entries)),
        ];
        let req = inventory_req(1, markers, vec![]);
        let req = EligibilityRequest::Inventory { inventory: req };

        let pure = eligibility_for(&cat, &req);
        assert_eq!(pure.total_fit, 2, "the pure engine knows no env facts");
        assert_eq!(pure.total_no_env, 0);

        let staged = eligibility_for_runtime(&cat, &req);
        assert_eq!(staged.total_fit, 1, "only the published-env method fits");
        assert_eq!(staged.total_some, 0);
        assert_eq!(staged.total_cannot, 1);
        assert_eq!(staged.total_no_env, 1);

        let ok = staged.methods.iter().find(|m| m.id == "asm-best-change-rule").unwrap();
        assert_eq!(ok.status, EligibilityStatus::CanRun);
        let noenv = staged.methods.iter().find(|m| m.id == "bjm").unwrap();
        assert_eq!(noenv.status, EligibilityStatus::CannotRun);
        assert_eq!(
            noenv.reasons.first().map(|r| r.code),
            Some(ReasonCode::EnvImageMissing),
            "the env fact is the FIRST reason (the row's one detail line)"
        );
    }
}
