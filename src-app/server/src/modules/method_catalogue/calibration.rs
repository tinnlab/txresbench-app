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
//! ## Nearby facts the ten lines above keep
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
use crate::modules::method_catalogue::types::{Method, TimingQuality};

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

/// The pure calibration snapshot: per method, its measured reference
/// seconds (the median carries the estimate; the raw vectors are how the
/// median is robust against an outlier run).
#[derive(Debug, Clone, Default)]
pub struct TimingCalibration {
    samples: HashMap<String, Vec<f64>>,
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
        let mut out: HashMap<String, Vec<f64>> = HashMap::new();
        for s in samples {
            if let Some(secs) = s.reference_seconds() {
                out.entry(s.method_id.clone()).or_default().push(secs);
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
        let mut values = self.samples.get(method_id)?.clone();
        if values.is_empty() {
            return None;
        }
        values.sort_by(|a, b| a.total_cmp(b));
        Some(values[values.len() / 2])
    }

    /// Whether any measurement exists at all (the estimate's quality fold:
    /// a run's estimate is only "measured" when at least one leg's base is
    /// an app measurement).
    pub fn is_empty(&self) -> bool {
        self.samples.values().all(|v| v.is_empty())
    }
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
    base
        * (patients as f64 / REFERENCE_PATIENTS as f64)
        * (REFERENCE_CPUS as f64 / cpus as f64)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, ms: u64, patients: u32, cpus: u32) -> TimingSample {
        TimingSample {
            method_id: id.to_string(),
            measured_ms: ms,
            patients,
            cpus,
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
    fn an_empty_calibration_leaves_the_generated_facts_untouched() {
        let cal = TimingCalibration::empty();
        assert!(cal.is_empty());
        let cat = crate::modules::method_catalogue::catalogue::catalogue();
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
    }
}
