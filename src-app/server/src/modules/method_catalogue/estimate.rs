//! ITEM-4 — the time-estimate engine (PROV-MC-6/7): per-method seconds via the
//! DEC-7 shape and the run-N-at-a-time schedule total (the bottom-bar "about X
//! minutes in total").
//!
//! ## The estimate model (DEC-7)
//!
//! `estimated_seconds = base_seconds_per_fold × (patients / REFERENCE_PATIENTS)
//! × (REFERENCE_CPUS / cpus)` — the ONE formula of the node, shared with the
//! eligibility verdicts: [`eligibility::estimate_seconds_for`] (defined with
//! ITEM-3 so the eligibility response carries the same fact) is the only
//! implementation; this module composes it, never re-derives it (PLAN note `o`:
//! one formula, no drift). `base_seconds_per_fold` + the quality fact are the
//! GENERATED [`types::Timing`] of the method — a script-generated table
//! (INV-3, TEST-MC-14: the fixture `base_seconds_per_fold` IS the fixture
//! `runs.csv` median), never a hardcoded constant and never re-derived in the
//! engine. The generator's rule: any `status==ok` per-fold row ⇒
//! `quality: "measured"` with `benchmarked_units` = the distinct benchmarked
//! units (R 60 s / Python 120 s declared-language fallback defaults with
//! `quality: "estimate"` otherwise — DEC-7); on the shipped catalogue that is
//! exactly the plan's "≥ 1 benchmarked unit ⇒ measured" (244 measured / 115
//! estimate, zero entries where quality and the unit count disagree).
//!
//! ## The schedule total
//!
//! `schedule_seconds` = the makespan of a greedy longest-processing-time
//! packing onto `at_a_time` lanes: the per-method seconds are sorted
//! descending and each is placed on the currently least-loaded lane (ties to
//! the lower lane index); the schedule time is the maximum lane load. LPT is
//! the standard 2-approximation of the optimal parallel schedule and is fully
//! deterministic (pure arithmetic over the embedded facts — the TEST-MC-14
//! "same input ⇒ same seconds, no wall-clock dependence" property). One lane
//! (`at_a_time: 1`) is the plain sum — for that case `schedule_seconds` IS
//! `total_seconds`, bitwise, not merely the same real number: LPT would
//! accumulate the sorted-descending values, and a sorted-order sum of the
//! same f64 values can differ from the request-order sum by 1 ULP (addition
//! is non-associative; measured on the shipped bases at 151 patients:
//! 46.40733333333333 vs 46.407333333333334 — DRIFT-1 ITEM-5 #9). `at_a_time ≥
//! method count` is a single wave (the max). NOTE: this packs run TIME only —
//! the two-level schedule
//! (the decision to run the first `at_a_time` methods while the rest wait) is
//! the execution engine's; the estimate's LPT makespan is the promise the bar
//! renders (D20: simple sum of estimates + the schedule total).
//!
//! ## Errors and edge semantics (deterministic, first failure wins)
//!
//! - `cpus == 0` (a POSTED zero; absent is the omission path) / `at_a_time ==
//!   0` are rejected FIRST (named validation errors — they are not defaults
//!   here; the serde default 3 is at_a_time's omission path, and the cpus
//!   omission path is the run's own resolution, [`host_cpus`], the same count
//!   the run will start with — CM-7's one source of truth; the zero-default of
//!   [`eligibility::estimate_seconds_for`] serves the pure eligibility helper).
//! - `method_ids` are then resolved IN REQUEST ORDER; the first unknown id is
//!   [`EstimateError::UnknownMethod`], the first non-runnable id is
//!   [`EstimateError::MethodNotRunnable`] (`400 METHOD_NOT_RUNNABLE` on the
//!   wire — plan-named; the runtime surface adds the no-published-environment
//!   refusal there too ([`estimate_for_runtime`]) — the E screen never asks
//!   (its rows are disabled), a stray id is refused, never summed).
//! - The response `methods[]` is in request order; duplicates are estimated as
//!   posted (the consumer posts a selection SET, so this is a caller bug's
//!   shape, not a silent dedup — the totals count what was asked).
//! - `patients: 0` yields 0 seconds per method and total/schedule 0 (empty
//!   selection: `method_ids: []` likewise yields 0/0 — the bar renders "no
//!   methods selected"; a zero-cohort estimate is not an error).
//! - No rounding at this boundary: seconds are `f64` facts; the display
//!   buckets ("under 1 min", "about N min") are the consumers' formatting
//!   (DEC-7, D38).

use std::fmt;

use crate::modules::method_catalogue::eligibility::{estimate_quality_for, estimate_seconds_for};
use crate::modules::method_catalogue::types::{
    Catalogue, EstimateRequest, EstimateResponse, Method, MethodEstimate, DEFAULT_ESTIMATE_CPUS,
};

/// The effective CPU count the run uses when the user leaves CPUs at Auto
/// (DEC-12's detect-at-run-start; the E screen's `cpus: null`): the machine's
/// available parallelism, [`DEFAULT_ESTIMATE_CPUS`] when it cannot be read.
/// This is the ONE implementation — the execution engine's run-start
/// detection delegates here, and the estimate endpoint's omission path
/// resolves through the same call, so the bottom bar, the per-method rows and
/// the running header always employ the same count (CM-7).
pub fn host_cpus() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(DEFAULT_ESTIMATE_CPUS)
}

/// Named estimate failures — the engine's closed error vocabulary. The wire
/// mapping (400 for every variant; the codes below) is ITEM-5's routes layer;
/// the engine itself is HTTP-free (PROV-MC-7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EstimateError {
    /// A `method_ids` entry is not a catalogue id.
    UnknownMethod { method_id: String },
    /// A `method_ids` entry is a catalogue method but is not runnable (no env
    /// image) — the PROV-MC-6 `METHOD_NOT_RUNNABLE` case. Covers BOTH the
    /// catalogue's `runnable: false` shape and the runtime no-published-
    /// environment verdict ([`eligibility::runtime_env_available`]) — the
    /// estimate of a method the app cannot start is never a promising number.
    MethodNotRunnable { method_id: String },
    /// `cpus` is 0 (a posted 0 is not a request for "default CPUs"; absent
    /// means the run's own resolution — [`host_cpus`]).
    InvalidCpus { value: u32 },
    /// `at_a_time` is 0 (the serde default 3 is the omission path).
    InvalidAtATime { value: u32 },
}

impl EstimateError {
    /// The stable machine code of the failure (the 400 `{error.error_code}`).
    pub fn code(&self) -> &'static str {
        match self {
            EstimateError::UnknownMethod { .. } => "UNKNOWN_METHOD",
            EstimateError::MethodNotRunnable { .. } => "METHOD_NOT_RUNNABLE",
            EstimateError::InvalidCpus { .. } => "INVALID_CPUS",
            EstimateError::InvalidAtATime { .. } => "INVALID_AT_A_TIME",
        }
    }
}

impl fmt::Display for EstimateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EstimateError::UnknownMethod { method_id } => write!(
                f,
                "UNKNOWN_METHOD: the catalogue has no method `{method_id}`"
            ),
            EstimateError::MethodNotRunnable { method_id } => write!(
                f,
                "METHOD_NOT_RUNNABLE: method `{method_id}` carries no runnable env image"
            ),
            EstimateError::InvalidCpus { value } => {
                write!(f, "INVALID_CPUS: cpus must be > 0, got {value}")
            }
            EstimateError::InvalidAtATime { value } => {
                write!(f, "INVALID_AT_A_TIME: at_a_time must be > 0, got {value}")
            }
        }
    }
}

impl std::error::Error for EstimateError {}

/// Run the estimate over the embedded catalogue — the runtime surface (the
/// no-published-environment refusal + the pure core; PROV-MC-7's in-process
/// seam — the execution engine's create-time estimate goes through the same
/// path, one code system).
pub fn estimate(req: &EstimateRequest) -> Result<EstimateResponse, EstimateError> {
    estimate_for_runtime(crate::modules::method_catalogue::catalogue::catalogue(), req)
}

/// The pure core over a given catalogue (no runtime-env stage — the test seam:
/// a handcrafted catalogue can exercise the METHOD_NOT_RUNNABLE case the
/// shipped runnable-only set never triggers — DEC-2, same posture as
/// `eligibility_for`). Production consumers call [`estimate`] or
/// [`estimate_for_runtime`]. `cpus: None` resolves through [`host_cpus`].
pub fn estimate_for(
    cat: &Catalogue,
    req: &EstimateRequest,
) -> Result<EstimateResponse, EstimateError> {
    let cpus = validate_estimate_request(req)?;
    // Resolve the requested methods in order; the FIRST failure is reported
    // (deterministic: the same request always names the same problem).
    let mut methods: Vec<&Method> = Vec::with_capacity(req.method_ids.len());
    for id in &req.method_ids {
        let m = cat
            .method(id)
            .ok_or_else(|| EstimateError::UnknownMethod {
                method_id: id.clone(),
            })?;
        if !m.runnable {
            return Err(EstimateError::MethodNotRunnable {
                method_id: id.clone(),
            });
        }
        methods.push(m);
    }
    let per_method: Vec<MethodEstimate> = methods
        .iter()
        .map(|m| MethodEstimate {
            id: m.id.clone(),
            estimated_seconds: estimate_seconds_for(m, req.patients, cpus),
            estimate_quality: estimate_quality_for(m),
        })
        .collect();
    let seconds: Vec<f64> = per_method.iter().map(|m| m.estimated_seconds).collect();
    let total_seconds: f64 = seconds.iter().sum();
    // One lane is the plain sum — the EXACT `total_seconds` f64, not merely
    // the same real number: LPT accumulates in sorted-descending order, and a
    // sorted-order sum of the same values can differ from the request-order
    // sum by 1 ULP (f64 addition is non-associative; measured on the shipped
    // bases at 151 patients: 46.40733333333333 vs 46.407333333333334). The
    // wire promise "at_a_time 1 ⇒ schedule == total" is bitwise, so the
    // route-level exact assert (TEST-MC-14) stays bitwise (DRIFT-1 ITEM-5 #9).
    let schedule_seconds = if req.at_a_time == 1 {
        total_seconds
    } else {
        lpt_schedule_seconds(&seconds, req.at_a_time)
    };
    Ok(EstimateResponse {
        methods: per_method,
        total_seconds,
        schedule_seconds,
        at_a_time: req.at_a_time,
        cpus,
    })
}

/// The structural validation of one estimate request — the documented order
/// ("cpus/at_a_time rejected first, then method resolution — the first
/// failure wins", the route's contract): a posted 0 is refused before ANY
/// method is resolved, so the runtime stage cannot shadow it. ONE
/// implementation: the pure core and the runtime stage share it.
fn validate_estimate_request(req: &EstimateRequest) -> Result<u32, EstimateError> {
    let cpus = req.cpus.unwrap_or_else(host_cpus);
    if cpus == 0 {
        return Err(EstimateError::InvalidCpus { value: req.cpus.unwrap_or(0) });
    }
    if req.at_a_time == 0 {
        return Err(EstimateError::InvalidAtATime {
            value: req.at_a_time,
        });
    }
    Ok(cpus)
}

/// The runtime-availability refusal stage over the pure core: a catalogue
/// method with no published environment is never estimated
/// (the honest answer to "how long will it take" is that it will not start —
/// the E screen's rows are disabled on this verdict, so the UI never asks;
/// a stray id is refused, never summed). The HTTP surface's seat.
pub fn estimate_for_runtime(
    cat: &Catalogue,
    req: &EstimateRequest,
) -> Result<EstimateResponse, EstimateError> {
    // Structural validation first (see the shared validator), then name the
    // REAL method problem, in request order (the pure core's own
    // first-failure-wins convention): an id the catalogue does not know is
    // UNKNOWN_METHOD even when it also has no published environment; a known
    // id with no env is METHOD_NOT_RUNNABLE.
    validate_estimate_request(req)?;
    for id in &req.method_ids {
        if cat.method(id).is_none() {
            return Err(EstimateError::UnknownMethod {
                method_id: id.clone(),
            });
        }
        if !crate::modules::method_catalogue::eligibility::runtime_env_available(id) {
            return Err(EstimateError::MethodNotRunnable {
                method_id: id.clone(),
            });
        }
    }
    estimate_for(cat, req)
}

/// The greedy LPT makespan: per-method seconds sorted descending, each placed
/// on the currently least-loaded lane (ties to the lower lane index), schedule
/// = the maximum lane load. Pure, deterministic, O(n log n + n × lanes) over
/// the bounded (≤ ~400) method set (DEC-4/11).
fn lpt_schedule_seconds(seconds: &[f64], at_a_time: u32) -> f64 {
    if seconds.is_empty() {
        return 0.0;
    }
    let lanes = at_a_time.max(1) as usize; // callers validate > 0; defensive
    let mut loads = vec![0.0f64; lanes];
    let mut sorted = seconds.to_vec();
    sorted.sort_by(|a, b| b.total_cmp(a)); // longest processing time first
    for s in sorted {
        let idx = loads
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| a.total_cmp(b))
            .expect("at least one lane")
            .0;
        loads[idx] += s;
    }
    loads.into_iter().fold(0.0f64, f64::max)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-5 / TEST-MC-6 / TEST-MC-14(unit half) — the estimate engine facts.
// The DEC-7 formula itself was pinned at ITEM-3 (`estimate_helper_is_the_dec7_shape`);
// the endpoint-level determinism + TIMING-table provenance bind with the routes
// (ITEM-5's api_test.rs).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::catalogue::parse_catalogue;
    use crate::modules::method_catalogue::types::{TimingQuality, CATALOGUE_SCHEMA_VERSION};

    /// A full methods[] entry JSON with the timing overridden (the loader's
    /// shape, same base as the eligibility tests' builder).
    fn method_json(id: &str, base_seconds: f64, quality: &str, units: u32) -> serde_json::Value {
        serde_json::json!({
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
            "timing": {"base_seconds_per_fold": base_seconds,
                       "benchmarked_units": units, "quality": quality},
            "performance": null,
            "embeds_training_data": false,
            "software": {"language": "Python", "packages": {}},
            "licence": "MIT",
            "references": [],
            "params": {}
        })
    }

    fn catalogue_with(methods: serde_json::Value) -> Catalogue {
        let doc = serde_json::json!({
            "schema_version": CATALOGUE_SCHEMA_VERSION,
            "generated_from": {"registry_name": "t", "methods_commit": "t",
                "manifest_commit": "t", "results_commit": "t",
                "generated_at": "2026-01-01T00:00:00Z"},
            "methods": methods,
            "markers": [],
            "groups": [{"id": "ctdna", "display_name": "Tumour DNA in blood (ctDNA)"}]
        });
        parse_catalogue(serde_json::to_vec(&doc).unwrap().as_slice()).expect("test catalogue")
    }

    fn req(ids: &[&str], patients: u32, cpus: Option<u32>, at_a_time: u32) -> EstimateRequest {
        EstimateRequest {
            method_ids: ids.iter().map(|s| s.to_string()).collect(),
            patients,
            cpus,
            at_a_time,
        }
    }

    #[test]
    fn estimate_scales_by_patients_and_cpus_dec7() {
        // The plan's TEST-MC-5 fixture: base 60 s. DEC-7 says
        // base x (patients/150) x (4/cpus); the TESTS.md draft wrote
        // "patients 300, cpus 8 -> 240" but the formula gives 60 — the
        // 240 case is cpus 2. Both are pinned here (DRIFT-1 ITEM-4 #1).
        let cat = catalogue_with(serde_json::json!([
            method_json("fx-timing", 60.0, "measured", 1)
        ]));
        let r = estimate_for(&cat, &req(&["fx-timing"], 300, Some(8), 3)).unwrap();
        assert_eq!(r.methods[0].estimated_seconds, 60.0); // x 2 x 0.5
        let r = estimate_for(&cat, &req(&["fx-timing"], 300, Some(2), 3)).unwrap();
        assert_eq!(r.methods[0].estimated_seconds, 240.0); // x 2 x 2
        let r = estimate_for(&cat, &req(&["fx-timing"], 150, Some(4), 3)).unwrap();
        assert_eq!(r.methods[0].estimated_seconds, 60.0); // the reference point
        assert_eq!(r.total_seconds, r.methods[0].estimated_seconds);
        assert_eq!(r.schedule_seconds, r.methods[0].estimated_seconds);
    }

    #[test]
    fn estimate_reports_the_generated_quality_fact() {
        // quality/seconds are the GENERATED timing facts (INV-3), reported
        // verbatim: measured when the method has benchmarked units, else the
        // language-fallback "estimate" default — the generator's rule.
        let cat = catalogue_with(serde_json::json!([
            method_json("fx-measured", 60.0, "measured", 2),
            method_json("fx-fallback", 120.0, "estimate", 0)
        ]));
        let r = estimate_for(&cat, &req(&["fx-measured", "fx-fallback"], 150, Some(4), 3)).unwrap();
        assert_eq!(r.methods[0].estimate_quality, TimingQuality::Measured);
        assert_eq!(r.methods[0].estimated_seconds, 60.0);
        assert_eq!(r.methods[1].estimate_quality, TimingQuality::Estimate);
        assert_eq!(r.methods[1].estimated_seconds, 120.0);
    }

    #[test]
    fn lpt_schedule_packs_longest_first() {
        // TEST-MC-5 (EXAMPLE-E5): A 120, B 240, C 300 seconds at the reference
        // patients/CPUs; at_a_time 3 is one wave (300); at_a_time 2 is LPT
        // [300]|[240,120] -> 360. The plan text said 480 — impossible for
        // these loads (any assignment makespan is 360/420/540/660); the
        // standard LPT makespan is 360 (DRIFT-1 ITEM-4 #1).
        let cat = catalogue_with(serde_json::json!([
            method_json("fx-a", 120.0, "measured", 1),
            method_json("fx-b", 240.0, "measured", 1),
            method_json("fx-c", 300.0, "measured", 1)
        ]));
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, Some(4), 3)).unwrap();
        assert_eq!(r.total_seconds, 660.0);
        assert_eq!(r.schedule_seconds, 300.0);
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, Some(4), 2)).unwrap();
        assert_eq!(r.schedule_seconds, 360.0);
        // One lane is the plain sum; more lanes than methods is the single wave.
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, Some(4), 1)).unwrap();
        assert_eq!(r.schedule_seconds, 660.0);
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, Some(4), 9)).unwrap();
        assert_eq!(r.schedule_seconds, 300.0);
        // The response mirrors the requested order exactly.
        assert_eq!(
            r.methods.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["fx-a", "fx-b", "fx-c"]
        );
        // Unscaled 2-lane packing keeps the same shape under a 2x scale
        // (patients 150, cpus 2 -> factor 4/2 = 2).
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, Some(2), 2)).unwrap();
        assert_eq!(r.schedule_seconds, 720.0); // [600]|[480,240] -> 720
    }

    #[test]
    fn one_lane_schedule_is_bitwise_the_total() {
        // TEST-MC-14's exactness corner found by ITEM-5's route test: the
        // shipped bases (8.9 / 11.6 / 25.6 s) at 151 patients sum to a
        // DIFFERENT f64 in request order (46.40733333333333) than in the LPT's
        // sorted-descending order (46.407333333333334) — f64 addition is not
        // associative, so "one lane = the plain sum" has to be implemented,
        // not trusted to the sum order. The engine returns `total_seconds`
        // verbatim for at_a_time == 1; pinned here bitwise.
        let cat = catalogue_with(serde_json::json!([
            method_json("fx-a", 8.9, "measured", 1),
            method_json("fx-b", 11.6, "measured", 1),
            method_json("fx-c", 25.6, "measured", 1)
        ]));
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 151, Some(4), 1)).unwrap();
        assert_eq!(r.schedule_seconds, r.total_seconds);
        // The ULP split really exists in these facts (the reason the exact
        // equality is a deliberate branch, not an accident of order).
        let vals: Vec<f64> = r.methods.iter().map(|m| m.estimated_seconds).collect();
        let request_order: f64 = vals.iter().sum();
        let mut sorted = vals.clone();
        sorted.sort_by(|a, b| b.total_cmp(a));
        let sorted_order: f64 = sorted.iter().sum();
        assert_ne!(request_order, sorted_order, "the split is observable");
        assert_eq!(request_order, r.total_seconds);
        assert_eq!(sorted_order, 46.407333333333334_f64);
        assert_eq!(r.total_seconds, 46.40733333333333_f64);
    }

    #[test]
    fn unknown_method_and_not_runnable_are_named_errors() {
        // TEST-MC-6: unknown id -> the error VARIANT (the 400 surface binds at
        // ITEM-5); the not-runnable case is PROV-MC-6's METHOD_NOT_RUNNABLE
        // (unreachable in the shipped runnable set, so driven via the seam).
        let mut not_runnable = method_json("fx-blocked", 60.0, "estimate", 0);
        not_runnable["runnable"] = serde_json::json!(false);
        let cat = catalogue_with(serde_json::json!([not_runnable]));
        let err = estimate_for(&cat, &req(&["nope"], 150, Some(4), 3)).unwrap_err();
        assert_eq!(err, EstimateError::UnknownMethod { method_id: "nope".into() });
        assert_eq!(err.code(), "UNKNOWN_METHOD");
        let err = estimate_for(&cat, &req(&["fx-blocked"], 150, Some(4), 3)).unwrap_err();
        assert_eq!(
            err,
            EstimateError::MethodNotRunnable { method_id: "fx-blocked".into() }
        );
        assert_eq!(err.code(), "METHOD_NOT_RUNNABLE");
        // First failure wins, in request order.
        let err = estimate_for(&cat, &req(&["nope", "fx-blocked"], 150, Some(4), 3)).unwrap_err();
        assert_eq!(err.code(), "UNKNOWN_METHOD");
    }

    #[test]
    fn zero_cpus_and_zero_lanes_are_rejected() {
        // TEST-MC-6: cpus 0 / at_a_time 0 are named-validation errors (the 400
        // surface is TEST-MC-13's; the serde defaults 4/3 are the omission
        // path). Validation runs before method resolution.
        let cat = catalogue_with(serde_json::json!([method_json("fx-a", 60.0, "measured", 1)]));
        let err = estimate_for(&cat, &req(&["fx-a"], 150, Some(0), 3)).unwrap_err();
        assert_eq!(err, EstimateError::InvalidCpus { value: 0 });
        assert_eq!(err.code(), "INVALID_CPUS");
        let err = estimate_for(&cat, &req(&["fx-a"], 150, Some(4), 0)).unwrap_err();
        assert_eq!(err, EstimateError::InvalidAtATime { value: 0 });
        assert_eq!(err.code(), "INVALID_AT_A_TIME");
        let err = estimate_for(&cat, &req(&["fx-a"], 150, Some(0), 0)).unwrap_err();
        assert_eq!(err.code(), "INVALID_CPUS");
    }

    #[test]
    fn empty_selection_and_zero_patients_are_zero_totals() {
        let cat = catalogue_with(serde_json::json!([method_json("fx-a", 60.0, "measured", 1)]));
        let r = estimate_for(&cat, &req(&[], 150, Some(4), 3)).unwrap();
        assert!(r.methods.is_empty());
        assert_eq!(r.total_seconds, 0.0);
        assert_eq!(r.schedule_seconds, 0.0);
        let r = estimate_for(&cat, &req(&["fx-a"], 0, Some(4), 3)).unwrap();
        assert_eq!(r.methods[0].estimated_seconds, 0.0);
        assert_eq!(r.total_seconds, 0.0);
        assert_eq!(r.schedule_seconds, 0.0);
    }

    #[test]
    fn embedded_catalogue_estimate_is_deterministic() {
        // TEST-MC-14's unit half: the estimate is pure arithmetic over the
        // committed timing facts — the identical request yields the identical
        // response every time (no wall-clock, no random source), and the
        // reference-point seconds equal the base facts (INV-3: the base IS the
        // generated runs.csv median).
        let cat = crate::modules::method_catalogue::catalogue::ensure_loaded()
            .expect("the committed catalogue loads");
        let ids: Vec<&str> = vec!["landmark-cox-current", "asm-best-change-rule"];
        let r1 = estimate_for(cat, &req(&ids, 150, Some(4), 3)).unwrap();
        let r2 = estimate_for(cat, &req(&ids, 150, Some(4), 3)).unwrap();
        assert_eq!(r1.total_seconds, r2.total_seconds);
        assert_eq!(r1.schedule_seconds, r2.schedule_seconds);
        assert_eq!(r1.methods.len(), 2);
        for m in &r1.methods {
            let entry = cat.method(&m.id).expect("resolved id is a catalogue method");
            assert_eq!(
                m.estimated_seconds,
                entry.timing.base_seconds_per_fold,
                "reference patients/CPUs => the base fact unchanged"
            );
            assert_eq!(m.estimate_quality, entry.timing.quality);
        }
    }

    #[test]
    fn omitted_cpus_resolve_the_runs_own_count() {
        // CM-7's one source of truth: the estimate request with NO cpus (the
        // E screen's Auto) resolves through host_cpus() — the same count the
        // engine's run-start detection uses — and the response reports it, so
        // the bar and the running header always agree. A posted count is used
        // as posted (never silently replaced).
        let cat = catalogue_with(serde_json::json!([method_json("fx-timing", 60.0, "measured", 1)]));
        let r = estimate_for(&cat, &req(&["fx-timing"], 150, None, 3)).unwrap();
        assert_eq!(r.cpus, host_cpus());
        assert_eq!(r.methods[0].estimated_seconds, 60.0 * 4.0 / host_cpus() as f64);
        let r = estimate_for(&cat, &req(&["fx-timing"], 150, Some(2), 3)).unwrap();
        assert_eq!(r.cpus, 2);
        assert_eq!(r.methods[0].estimated_seconds, 120.0, "posted cpus scale as posted");
    }

    #[test]
    fn runtime_surface_refuses_methods_without_a_published_environment() {
        // The CM-1 refusal: the estimate of a known catalogue method with no
        // published environment is METHOD_NOT_RUNNABLE (the
        // E screen never asks — its rows are disabled — a stray id is refused,
        // never summed). `crp-flare-response-kinetics` is a committed
        // catalogue method NOT in the embedded manifest; `asm-best-change-rule`
        // IS (the manifest has 94 entries); `fx-noenv` is handcrafted and the
        // real catalogue does not know it — that refusal is UNKNOWN_METHOD
        // (the error names the real problem: no catalogue method at all).
        let cat = crate::modules::method_catalogue::catalogue::ensure_loaded()
            .expect("the committed catalogue loads");
        let err =
            estimate_for_runtime(&cat, &req(&["crp-flare-response-kinetics"], 150, Some(4), 3))
                .unwrap_err();
        assert_eq!(
            err,
            EstimateError::MethodNotRunnable {
                method_id: "crp-flare-response-kinetics".into()
            }
        );
        assert_eq!(err.code(), "METHOD_NOT_RUNNABLE");
        let err = estimate_for_runtime(&cat, &req(&["fx-noenv"], 150, Some(4), 3)).unwrap_err();
        assert_eq!(
            err,
            EstimateError::UnknownMethod { method_id: "fx-noenv".into() }
        );
        assert_eq!(err.code(), "UNKNOWN_METHOD");
        let ok = estimate_for_runtime(&cat, &req(&["asm-best-change-rule"], 150, Some(4), 3));
        assert!(ok.is_ok(), "a manifest method estimates: {:?}", ok.err());
        // The pure core does not consult the manifest: the same id on a
        // handcrafted catalogue stays estimable (refusal is a property of
        // the runtime surface, never of the catalogue fact itself), and the
        // runtime surface refuses it on that handcrafted catalogue too —
        // the manifest check is the whole gate.
        let cat_h = catalogue_with(serde_json::json!([method_json("fx-noenv", 60.0, "measured", 1)]));
        assert!(estimate_for(&cat_h, &req(&["fx-noenv"], 150, Some(4), 3)).is_ok());
        assert!(estimate_for_runtime(&cat_h, &req(&["fx-noenv"], 150, Some(4), 3)).is_err());
    }
}
