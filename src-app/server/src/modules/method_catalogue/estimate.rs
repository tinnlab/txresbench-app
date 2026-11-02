//! ITEM-4 — the time-estimate engine (PROV-MC-6/7): per-method seconds via the
//! DEC-7 shape and the run-N-at-a-time schedule total (the bottom-bar "about X
//! minutes in total on this computer").
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
//! (`at_a_time: 1`) is the plain sum; `at_a_time ≥ method count` is a single
//! wave (the max). NOTE: this packs run TIME only — the two-level schedule
//! (the decision to run the first `at_a_time` methods while the rest wait) is
//! the execution engine's; the estimate's LPT makespan is the promise the bar
//! renders (D20: simple sum of estimates + the schedule total).
//!
//! ## Errors and edge semantics (deterministic, first failure wins)
//!
//! - `cpus == 0` / `at_a_time == 0` are rejected FIRST (named validation
//!   errors — they are not defaults here; the serde defaults, 4 and 3, are the
//!   omission path; the zero-default of
//!   [`eligibility::estimate_seconds_for`] serves the eligibility path, which
//!   never posts a user CPU count).
//! - `method_ids` are then resolved IN REQUEST ORDER; the first unknown id is
//!   [`EstimateError::UnknownMethod`], the first non-runnable id is
//!   [`EstimateError::MethodNotRunnable`] (`400 METHOD_NOT_RUNNABLE` on the
//!   wire — plan-named; unreachable for the shipped runnable-only set, DEC-2,
//!   hence the handcrafted-catalogue test seam, like eligibility's NOT_RUNNABLE
//!   note, PLAN `p`).
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
    Catalogue, EstimateRequest, EstimateResponse, Method, MethodEstimate,
};

/// A named estimate failure — the engine's closed error vocabulary. The wire
/// mapping (400 for every variant; the codes below) is ITEM-5's routes layer;
/// the engine itself is HTTP-free (PROV-MC-7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EstimateError {
    /// A `method_ids` entry is not a catalogue id.
    UnknownMethod { method_id: String },
    /// A `method_ids` entry is a catalogue method but is not runnable (no env
    /// image) — the PROV-MC-6 `METHOD_NOT_RUNNABLE` case.
    MethodNotRunnable { method_id: String },
    /// `cpus` is 0 (the serde default 4 is the omission path; a posted 0 is
    /// not a request for "default CPUs").
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

/// Run the estimate over the embedded catalogue (the PROV-MC-7 in-process seam;
/// TEST-MC-31 name-checks it).
pub fn estimate(req: &EstimateRequest) -> Result<EstimateResponse, EstimateError> {
    estimate_for(crate::modules::method_catalogue::catalogue::catalogue(), req)
}

/// Run the estimate over a given catalogue — the same engine as [`estimate`]
/// with the catalogue passed in (the test seam: a handcrafted catalogue can
/// exercise the METHOD_NOT_RUNNABLE case the shipped runnable-only set never
/// triggers — DEC-2, same posture as `eligibility_for`).
pub fn estimate_for(
    cat: &Catalogue,
    req: &EstimateRequest,
) -> Result<EstimateResponse, EstimateError> {
    if req.cpus == 0 {
        return Err(EstimateError::InvalidCpus { value: req.cpus });
    }
    if req.at_a_time == 0 {
        return Err(EstimateError::InvalidAtATime {
            value: req.at_a_time,
        });
    }
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
            estimated_seconds: estimate_seconds_for(m, req.patients, req.cpus),
            estimate_quality: estimate_quality_for(m),
        })
        .collect();
    let seconds: Vec<f64> = per_method.iter().map(|m| m.estimated_seconds).collect();
    let total_seconds: f64 = seconds.iter().sum();
    let schedule_seconds = lpt_schedule_seconds(&seconds, req.at_a_time);
    Ok(EstimateResponse {
        methods: per_method,
        total_seconds,
        schedule_seconds,
        at_a_time: req.at_a_time,
    })
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

    fn req(ids: &[&str], patients: u32, cpus: u32, at_a_time: u32) -> EstimateRequest {
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
        let r = estimate_for(&cat, &req(&["fx-timing"], 300, 8, 3)).unwrap();
        assert_eq!(r.methods[0].estimated_seconds, 60.0); // x 2 x 0.5
        let r = estimate_for(&cat, &req(&["fx-timing"], 300, 2, 3)).unwrap();
        assert_eq!(r.methods[0].estimated_seconds, 240.0); // x 2 x 2
        let r = estimate_for(&cat, &req(&["fx-timing"], 150, 4, 3)).unwrap();
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
        let r = estimate_for(&cat, &req(&["fx-measured", "fx-fallback"], 150, 4, 3)).unwrap();
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
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, 4, 3)).unwrap();
        assert_eq!(r.total_seconds, 660.0);
        assert_eq!(r.schedule_seconds, 300.0);
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, 4, 2)).unwrap();
        assert_eq!(r.schedule_seconds, 360.0);
        // One lane is the plain sum; more lanes than methods is the single wave.
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, 4, 1)).unwrap();
        assert_eq!(r.schedule_seconds, 660.0);
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, 4, 9)).unwrap();
        assert_eq!(r.schedule_seconds, 300.0);
        // The response mirrors the requested order exactly.
        assert_eq!(
            r.methods.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["fx-a", "fx-b", "fx-c"]
        );
        // Unscaled 2-lane packing keeps the same shape under a 2x scale
        // (patients 150, cpus 2 -> factor 4/2 = 2).
        let r = estimate_for(&cat, &req(&["fx-a", "fx-b", "fx-c"], 150, 2, 2)).unwrap();
        assert_eq!(r.schedule_seconds, 720.0); // [600]|[480,240] -> 720
    }

    #[test]
    fn unknown_method_and_not_runnable_are_named_errors() {
        // TEST-MC-6: unknown id -> the error VARIANT (the 400 surface binds at
        // ITEM-5); the not-runnable case is PROV-MC-6's METHOD_NOT_RUNNABLE
        // (unreachable in the shipped runnable set, so driven via the seam).
        let mut not_runnable = method_json("fx-blocked", 60.0, "estimate", 0);
        not_runnable["runnable"] = serde_json::json!(false);
        let cat = catalogue_with(serde_json::json!([not_runnable]));
        let err = estimate_for(&cat, &req(&["nope"], 150, 4, 3)).unwrap_err();
        assert_eq!(err, EstimateError::UnknownMethod { method_id: "nope".into() });
        assert_eq!(err.code(), "UNKNOWN_METHOD");
        let err = estimate_for(&cat, &req(&["fx-blocked"], 150, 4, 3)).unwrap_err();
        assert_eq!(
            err,
            EstimateError::MethodNotRunnable { method_id: "fx-blocked".into() }
        );
        assert_eq!(err.code(), "METHOD_NOT_RUNNABLE");
        // First failure wins, in request order.
        let err = estimate_for(&cat, &req(&["nope", "fx-blocked"], 150, 4, 3)).unwrap_err();
        assert_eq!(err.code(), "UNKNOWN_METHOD");
    }

    #[test]
    fn zero_cpus_and_zero_lanes_are_rejected() {
        // TEST-MC-6: cpus 0 / at_a_time 0 are named-validation errors (the 400
        // surface is TEST-MC-13's; the serde defaults 4/3 are the omission
        // path). Validation runs before method resolution.
        let cat = catalogue_with(serde_json::json!([method_json("fx-a", 60.0, "measured", 1)]));
        let err = estimate_for(&cat, &req(&["fx-a"], 150, 0, 3)).unwrap_err();
        assert_eq!(err, EstimateError::InvalidCpus { value: 0 });
        assert_eq!(err.code(), "INVALID_CPUS");
        let err = estimate_for(&cat, &req(&["fx-a"], 150, 4, 0)).unwrap_err();
        assert_eq!(err, EstimateError::InvalidAtATime { value: 0 });
        assert_eq!(err.code(), "INVALID_AT_A_TIME");
        let err = estimate_for(&cat, &req(&["fx-a"], 150, 0, 0)).unwrap_err();
        assert_eq!(err.code(), "INVALID_CPUS");
    }

    #[test]
    fn empty_selection_and_zero_patients_are_zero_totals() {
        let cat = catalogue_with(serde_json::json!([method_json("fx-a", 60.0, "measured", 1)]));
        let r = estimate_for(&cat, &req(&[], 150, 4, 3)).unwrap();
        assert!(r.methods.is_empty());
        assert_eq!(r.total_seconds, 0.0);
        assert_eq!(r.schedule_seconds, 0.0);
        let r = estimate_for(&cat, &req(&["fx-a"], 0, 4, 3)).unwrap();
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
        let r1 = estimate_for(cat, &req(&ids, 150, 4, 3)).unwrap();
        let r2 = estimate_for(cat, &req(&ids, 150, 4, 3)).unwrap();
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
}
