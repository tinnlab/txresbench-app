//! `method_catalogue` — the measured-time calibration of the DEC-7 estimate
//! (qa-fixes2 ITEM-6, R2-3). The estimate was 2 to 7 times too high against
//! the seconds the app records after real runs (`duration_ms` on the run's
//! method rows); the app's own measurements are the evidence the estimate
//! promises, so the estimate engine scales each method's per-fold base with
//! the median of the app-measured runs for that method.
//!
//! ## The model
//!
//! The DEC-7 estimate is `base_seconds_per_fold × (patients / 150) ×
//! (4 / cpus)` ([`eligibility::estimate_seconds_for`] — the ONE formula,
//! still untouched). A measured run of `m` milliseconds on `p` patients
//! with `c` CPUs normalizes back to the reference shape:
//!
//! `measured_reference_seconds = (m / 1000) × (150 / p) × (c / 4)`
//!
//! The calibration for a method is the MEDIAN of its measured reference
//! seconds (the robust aggregate — one outlier run — a machine hiccup, a
//! cold cache — never swings the estimate), and a calibrated estimate is the
//! same formula with that median in place of the generated
//! `base_seconds_per_fold`. The quality fact ([`TimingQuality`]) reads
//! `measured` for a method the app has measured itself (the number is THIS
//! app's own measurement), and stays the generated fact otherwise (the
//! benchmark's measured per-fold seconds / the language-fallback estimate) —
//! the honest "measured vs estimate" label the run header renders.
//!
//! ## The cross-check factor (crosschecked-chances)
//!
//! A learning run cross-checks its chances: a method that learns is fitted
//! [`CROSS_FIT_FOLDS`](crate::modules::execution_engine::predictions::CROSS_FIT_FOLDS)
//! more times (one fit + predict per fold, each on ~2/3 of the cohort), so
//! its UNCALIBRATED estimate is about three times a single fit+predict —
//! [`CROSSCHECK_TIME_FACTOR`]. Two rules keep measured numbers honest:
//!
//! - A measured sample already includes the folds that ran when it was
//!   recorded, so a calibrated value is NEVER factor-multiplied again (the
//!   measured seconds are the real total, not a reference base).
//! - Samples recorded before the cross-check was added measure the OLD
//!   one-fit cost for methods that then ran no folds at all (the
//!   own-probability learners: `fitted` with no conversion need). They are
//!   kept in the store (never deleted) but marked `crosschecked: false`, and
//!   a train-mode median for a `fitted` method uses the TAGGED samples only —
//!   an untagged sample for a method whose run cost has since changed must
//!   not drag the median down. The estimate engine cannot tell from the
//!   catalogue whether a particular run needed a conversion (that depends on
//!   the file's outcomes), so it treats EVERY `fitted` method that way in
//!   train mode — the safe side: an untagged measured value for a method
//!   whose cost did not change is dropped, and the generated base × 3 takes
//!   over instead.
//!
//! ## Who feeds it
//!
//! The samples are recorded by the execution engine (the only place the
//! measured `duration_ms` exists) into `txr_timing_samples`
//! (train-mode finished methods only — a reuse run predicts alone and would
//! skew the per-fold base). The estimate routes and the engine load the
//! samples and build a [`TimingCalibration`] — a pure snapshot — before the
//! pure engine runs, so the estimate engine itself stays DB-free and
//! deterministic per request (DEC-9's statelessness holds for the engine;
//! the calibration is its INPUT, like the catalogue). A load failure fails
//! OPEN ([`TimingCalibration::empty`] — the estimate is a display fact,
//! never a run error).
//!
//! ## Nearby facts the lines above keep
//!
//! - The normalization constants ARE [`eligibility::REFERENCE_PATIENTS`] /
//!   [`eligibility::REFERENCE_CPUS`] — one reference, no drift.
//! - A zero-cohort run (patients 0) never yields a sample (a divide by zero
//!   would produce an infinite base, and a zero-patient run measures
//!   nothing anyway).
//! - `TimingCalibration::from_samples` keeps every sample; `empty` is the
//!   no-samples state (estimate = the generated facts, byte-identical to
//!   the pre-calibration engine — the existing pins stay).

use std::collections::HashMap;

use crate::modules::method_catalogue::eligibility::{REFERENCE_CPUS, REFERENCE_PATIENTS};
use crate::modules::method_catalogue::types::{EstimateMode, Method, TimingQuality};

/// The cross-check's time factor for a learning run: a method that learns
/// from the cohort is also fitted [`CROSS_FIT_FOLDS`]
/// (crate::modules::execution_engine::predictions::CROSS_FIT_FOLDS) more
/// times — one fit + predict per fold, each on ~2/3 of the data — to check
/// its chances, so its uncalibrated estimate is about 3x the single
/// fit+predict in total. Applied ONLY to the generated-base estimate of a
/// `fitted` method in [`EstimateMode::Train`]: a measured sample already
/// includes the folds that ran when it was recorded, so a calibrated value
/// is never multiplied again.
pub const CROSSCHECK_TIME_FACTOR: f64 = 3.0;

/// One measured method run, as the estimate engine needs it (the repository
/// row's facts — see the `txr_timing_samples` migration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimingSample {
    pub method_id: String,
    /// The method row's `duration_ms` (the wall time of the sandbox run).
    pub measured_ms: u64,
    /// The training cohort the run fitted on (`input_summary.patients`).
    pub patients: u32,
    /// The run's detected CPU count.
    pub cpus: u32,
    /// Whether the measured run INCLUDED the cross-check folds (a train-mode
    /// `fitted` method after the cross-check — its seconds already carry the
    /// three extra fits). Samples recorded before the change are `false`:
    /// they measured the old one-fit cost, and a train-mode median for a
    /// method that learns must not mix them in.
    pub crosschecked: bool,
}

impl TimingSample {
    /// The measured seconds normalized to the DEC-7 reference shape
    /// (150 patients / 4 CPUs): `seconds × (REFERENCE_PATIENTS / patients)
    /// × (cpus / REFERENCE_CPUS)`. `None` for a zero-cohort sample (nothing
    /// to normalize — the engine never records one, defensive here).
    pub fn reference_seconds(&self) -> Option<f64> {
        if self.patients == 0 {
            return None;
        }
        Some(
            self.measured_ms as f64 / 1000.0
                * (REFERENCE_PATIENTS as f64 / self.patients as f64)
                * (self.cpus as f64 / REFERENCE_CPUS as f64),
        )
    }
}

/// One normalized sample inside the snapshot, with the cross-check marker
/// the median selectors read (see the module doc).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeasuredSample {
    /// The measured seconds normalized to the DEC-7 reference shape.
    pub reference_seconds: f64,
    /// The run included the cross-check folds ([`TimingSample::crosschecked`]
    /// normalized through).
    pub crosschecked: bool,
}

/// The pure calibration snapshot: per method, its measured reference
/// seconds (the median carries the estimate; the raw vectors are how the
/// median is robust against an outlier run).
#[derive(Debug, Clone, Default)]
pub struct TimingCalibration {
    samples: HashMap<String, Vec<MeasuredSample>>,
}

impl TimingCalibration {
    /// The no-measurements state — the estimate engine with an empty
    /// calibration is byte-identical to the pre-calibration engine.
    pub fn empty() -> Self {
        Self {
            samples: HashMap::new(),
        }
    }

    /// Build the snapshot from the recorded samples (sample entries with a
    /// zero cohort are dropped — the measured reference is undefined).
    pub fn from_samples(samples: &[TimingSample]) -> Self {
        let mut out: HashMap<String, Vec<MeasuredSample>> = HashMap::new();
        for s in samples {
            if let Some(secs) = s.reference_seconds() {
                out.entry(s.method_id.clone()).or_default().push(MeasuredSample {
                    reference_seconds: secs,
                    crosschecked: s.crosschecked,
                });
            }
        }
        Self { samples: out }
    }

    /// Whether the app has measured the method itself.
    pub fn is_measured(&self, method_id: &str) -> bool {
        self.samples.get(method_id).is_some_and(|v| !v.is_empty())
    }

    /// The method's measured reference seconds: the MEDIAN of its samples
    /// (sorted middle; the even case is the upper middle — the estimate
    /// leans to the slower half on a tie, the honest side for a promise).
    pub fn reference_seconds_of(&self, method_id: &str) -> Option<f64> {
        median_of(self.samples.get(method_id)?.iter().map(|s| s.reference_seconds))
    }

    /// The method's measured reference seconds over the samples that
    /// INCLUDED the cross-check folds only (the train-mode median for a
    /// method that learns — see the module doc). `None` when the method has
    /// no such sample: the measured evidence predates the cross-check, and
    /// the train mode falls back to the generated base ×
    /// [`CROSSCHECK_TIME_FACTOR`] instead of trusting an old one-fit number.
    pub fn crosschecked_reference_seconds_of(&self, method_id: &str) -> Option<f64> {
        median_of(
            self.samples
                .get(method_id)?
                .iter()
                .filter(|s| s.crosschecked)
                .map(|s| s.reference_seconds),
        )
    }

    /// Whether any measurement exists at all (the estimate's quality fold:
    /// a run's estimate is only "measured" when at least one leg's base is
    /// an app measurement).
    pub fn is_empty(&self) -> bool {
        self.samples.values().all(|v| v.is_empty())
    }
}

/// The median of an iterator of f64 (sorted middle; the even case is the
/// upper middle — the estimate leans to the slower half on a tie, the
/// honest side for a promise). `None` for an empty input.
fn median_of(values: impl Iterator<Item = f64>) -> Option<f64> {
    let mut values: Vec<f64> = values.collect();
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    Some(values[values.len() / 2])
}

/// The DEC-7 estimate seconds for a method with the calibration applied:
/// the same formula whose reference base is the app's measured median when
/// the app has measured the method, else the generated
/// `base_seconds_per_fold` (the pre-calibration byte — `estimate_seconds_for`
/// stays the ONE formula; this is the base selection, never a second model).
pub fn calibrated_estimate_seconds_for(
    method: &Method,
    patients: u32,
    cpus: u32,
    calibration: &TimingCalibration,
) -> f64 {
    let base = calibration
        .reference_seconds_of(&method.id)
        .unwrap_or(method.timing.base_seconds_per_fold);
    scaled_seconds(base, patients, cpus)
}

/// The estimate seconds for one method with the calibration applied AND the
/// run's mode (crosschecked-chances):
///
/// - `None` or [`EstimateMode::Reuse`] — exactly [`calibrated_estimate_seconds_for`]
///   (the pre-cross-check numbers; a reuse run predicts with the saved model
///   and fits nothing).
/// - [`EstimateMode::Train`] — a learning run. A `fitted` method is
///   cross-fitted: its measured median takes the CROSS-CHECKED samples only
///   (a measured value already includes the folds — never factor a
///   measurement), and with no such sample the generated base carries
///   [`CROSSCHECK_TIME_FACTOR`]. A fixed-rule method is unchanged (its run
///   cost did not change; the conversion cross-check is local arithmetic,
///   no extra container call).
pub fn calibrated_estimate_seconds_for_mode(
    method: &Method,
    patients: u32,
    cpus: u32,
    calibration: &TimingCalibration,
    mode: Option<EstimateMode>,
) -> f64 {
    match mode {
        None | Some(EstimateMode::Reuse) => {
            calibrated_estimate_seconds_for(method, patients, cpus, calibration)
        }
        Some(EstimateMode::Train) => {
            if method.fitted {
                // A learning method's fitted runs after the cross-check
                // include the folds — a measured value is the real total,
                // never factor-multiplied again. Only the tagged samples
                // count (an untagged one measured the old one-fit cost);
                // with no tagged sample the generated base carries the factor.
                match calibration.crosschecked_reference_seconds_of(&method.id) {
                    Some(seconds) => scaled_seconds(seconds, patients, cpus),
                    None => scaled_seconds(
                        method.timing.base_seconds_per_fold * CROSSCHECK_TIME_FACTOR,
                        patients,
                        cpus,
                    ),
                }
            } else {
                // A fixed-rule method's run cost never changed (no fold
                // calls; the conversion cross-check is local arithmetic) —
                // today's calibrated base, no factor.
                let base = calibration
                    .reference_seconds_of(&method.id)
                    .unwrap_or(method.timing.base_seconds_per_fold);
                scaled_seconds(base, patients, cpus)
            }
        }
    }
}

/// The estimate's honest quality with the calibration applied: `measured`
/// when the app has measured the method (its own duration backs the number),
/// else the GENERATED fact (the benchmark's measured per-fold seconds, or
/// the language-fallback `estimate`) — the header renders the word as found.
pub fn calibrated_estimate_quality_for(
    method: &Method,
    calibration: &TimingCalibration,
) -> TimingQuality {
    if calibration.is_measured(&method.id) {
        TimingQuality::Measured
    } else {
        method.timing.quality
    }
}

/// The estimate's honest quality with the calibration AND the run's mode
/// applied (the same sample selection as
/// [`calibrated_estimate_seconds_for_mode`]): a train-mode `fitted` method
/// is only "measured" when a CROSS-CHECKED sample backs the number — an
/// untagged (pre-cross-check) measurement is not the run's cost and must not
/// wear the measured label.
pub fn calibrated_estimate_quality_for_mode(
    method: &Method,
    calibration: &TimingCalibration,
    mode: Option<EstimateMode>,
) -> TimingQuality {
    match mode {
        None | Some(EstimateMode::Reuse) => calibrated_estimate_quality_for(method, calibration),
        Some(EstimateMode::Train) => {
            if method.fitted {
                if calibration.crosschecked_reference_seconds_of(&method.id).is_some() {
                    TimingQuality::Measured
                } else {
                    method.timing.quality
                }
            } else {
                calibrated_estimate_quality_for(method, calibration)
            }
        }
    }
}

/// The DEC-7 scaling of one reference base (the ONE formula — the same
/// product `eligibility::estimate_seconds_for` computes; callers here only
/// select the base, never re-derive the model).
fn scaled_seconds(base: f64, patients: u32, cpus: u32) -> f64 {
    base
        * (patients as f64 / REFERENCE_PATIENTS as f64)
        * (REFERENCE_CPUS as f64 / cpus as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, ms: u64, patients: u32, cpus: u32) -> TimingSample {
        TimingSample {
            method_id: id.to_string(),
            measured_ms: ms,
            patients,
            cpus,
            crosschecked: false,
        }
    }

    fn crosschecked_sample(id: &str, ms: u64, patients: u32, cpus: u32) -> TimingSample {
        TimingSample {
            crosschecked: true,
            ..sample(id, ms, patients, cpus)
        }
    }

    #[test]
    fn a_sample_normalizes_to_the_reference_shape() {
        // 12.8 s measured on 94 patients with 2 CPUs → 12.8 × 150/94 × 2/4.
        let s = sample("cox-baseline-delta", 12_800, 94, 2);
        let reference = s.reference_seconds().expect("normalizes");
        assert!((reference - 10.21).abs() < 0.01, "got {reference}");
        // The reference-point run stays itself: 150 patients, 4 CPUs.
        let s = sample("m", 60_000, 150, 4);
        assert_eq!(s.reference_seconds(), Some(60.0));
        // A zero cohort is nothing to normalize.
        assert_eq!(sample("m", 1000, 0, 4).reference_seconds(), None);
    }

    #[test]
    fn the_calibration_is_the_median_and_the_estimate_uses_the_measured_base() {
        let cal = TimingCalibration::from_samples(&[
            sample("m", 10_000, 150, 4),
            sample("m", 20_000, 150, 4),
            sample("m", 30_000, 150, 4),
            sample("m", 40_000, 150, 4),
        ]);
        assert!(cal.is_measured("m"));
        assert_eq!(cal.reference_seconds_of("m"), Some(30.0));
        assert!(!cal.is_measured("other"));
        assert_eq!(cal.reference_seconds_of("other"), None);
    }

    #[test]
    fn crosschecked_median_takes_tagged_samples_only() {
        let cal = TimingCalibration::from_samples(&[
            // The old cost: one fit, no folds.
            sample("m", 10_000, 150, 4),
            sample("m", 20_000, 150, 4),
            // The new cost (folds included).
            crosschecked_sample("m", 70_000, 150, 4),
            crosschecked_sample("m", 80_000, 150, 4),
            crosschecked_sample("m", 90_000, 150, 4),
        ]);
        // The ALL-samples median would be 70 s (old 10/20 + new 70/80/90) —
        // mixing the pre-cross-check cost down.
        assert_eq!(cal.reference_seconds_of("m"), Some(70.0));
        // The train-mode median for a learner is the tagged median: 80 s.
        assert_eq!(cal.crosschecked_reference_seconds_of("m"), Some(80.0));
        // A method with tagged samples only: both medians agree.
        let cal2 = TimingCalibration::from_samples(&[crosschecked_sample("m", 60_000, 150, 4)]);
        assert_eq!(cal2.reference_seconds_of("m"), Some(60.0));
        assert_eq!(cal2.crosschecked_reference_seconds_of("m"), Some(60.0));
        // A method with no tagged sample: the tagged median is None (the
        // sample stays in the store — never deleted).
        let cal3 = TimingCalibration::from_samples(&[sample("m", 10_000, 150, 4)]);
        assert_eq!(cal3.reference_seconds_of("m"), Some(10.0));
        assert_eq!(cal3.crosschecked_reference_seconds_of("m"), None);
        assert_eq!(cal3.crosschecked_reference_seconds_of("other"), None);
    }

    #[test]
    fn an_empty_calibration_leaves_the_generated_facts_untouched() {
        let cal = TimingCalibration::empty();
        assert!(cal.is_empty());
        let cat = &crate::modules::method_list::builtin().catalogue;
        let m = cat.method("cox-baseline-delta").expect("catalogue method");
        assert_eq!(
            calibrated_estimate_seconds_for(m, 150, 4, &cal),
            m.timing.base_seconds_per_fold,
            "no samples = the DEC-7 formula byte"
        );
        assert_eq!(
            calibrated_estimate_quality_for(m, &cal),
            m.timing.quality,
            "no samples = the generated quality"
        );
        // The mode-aware mirror: absent/reuse = the same bytes.
        assert_eq!(
            calibrated_estimate_seconds_for_mode(m, 150, 4, &cal, None),
            m.timing.base_seconds_per_fold
        );
        assert_eq!(
            calibrated_estimate_seconds_for_mode(m, 150, 4, &cal, Some(EstimateMode::Reuse)),
            m.timing.base_seconds_per_fold
        );
    }

    #[test]
    fn a_calibrated_value_is_never_factor_multiplied_but_an_unmeasured_learner_is() {
        let cat = &crate::modules::method_list::builtin().catalogue;
        let learner = cat.method("landmark-cox-current").expect("a fitted method");
        assert!(learner.fitted, "the fixture is a learning method");
        let fixed = cat.method("asm-best-change-rule").expect("a fixed-rule method");
        assert!(!fixed.fitted, "the fixture is a fixed-rule method");

        // Unmeasured, train mode: the learner is ×3, the fixed-rule is not.
        let empty = TimingCalibration::empty();
        assert_eq!(
            calibrated_estimate_seconds_for_mode(learner, 150, 4, &empty, Some(EstimateMode::Train)),
            learner.timing.base_seconds_per_fold * CROSSCHECK_TIME_FACTOR
        );
        assert_eq!(
            calibrated_estimate_seconds_for_mode(learner, 150, 4, &empty, None),
            learner.timing.base_seconds_per_fold,
            "absent mode = today's number"
        );
        assert_eq!(
            calibrated_estimate_seconds_for_mode(learner, 150, 4, &empty, Some(EstimateMode::Reuse)),
            learner.timing.base_seconds_per_fold,
            "reuse mode = today's number"
        );
        assert_eq!(
            calibrated_estimate_seconds_for_mode(fixed, 150, 4, &empty, Some(EstimateMode::Train)),
            fixed.timing.base_seconds_per_fold,
            "fixed-rule methods are unchanged in train mode"
        );

        // Measured (tagged) train mode: the measured seconds already include
        // the folds — the value is used as-is, never ×3.
        let measured = TimingCalibration::from_samples(&[crosschecked_sample(
            "landmark-cox-current",
            45_000,
            150,
            4,
        )]);
        assert_eq!(
            calibrated_estimate_seconds_for_mode(learner, 150, 4, &measured, Some(EstimateMode::Train)),
            45.0,
            "a measured learner is not factored"
        );
        assert_eq!(
            calibrated_estimate_quality_for_mode(learner, &measured, Some(EstimateMode::Train)),
            TimingQuality::Measured
        );

        // Untagged-only (pre-cross-check) measurement: train mode ignores it
        // (never deletes) and falls back to the generated base × 3, and the
        // quality is not allowed to claim Measured.
        let old = TimingCalibration::from_samples(&[sample("landmark-cox-current", 15_000, 150, 4)]);
        assert_eq!(
            calibrated_estimate_seconds_for_mode(learner, 150, 4, &old, Some(EstimateMode::Train)),
            learner.timing.base_seconds_per_fold * CROSSCHECK_TIME_FACTOR,
            "an untagged sample is ignored, not factored on top"
        );
        assert_eq!(
            calibrated_estimate_quality_for_mode(learner, &old, Some(EstimateMode::Train)),
            learner.timing.quality,
            "an untagged sample does not claim Measured in train mode"
        );
        // The same old sample still calibrates the absent-mode and fixed-rule
        // numbers (today's behavior).
        assert_eq!(
            calibrated_estimate_seconds_for_mode(learner, 150, 4, &old, None),
            15.0,
            "absent mode keeps the full median, exactly as before"
        );
        assert_eq!(
            calibrated_estimate_seconds_for_mode(fixed, 150, 4, &old, Some(EstimateMode::Train)),
            fixed.timing.base_seconds_per_fold,
            "a fixed-rule method never reads a learner's sample anyway"
        );
    }
}
