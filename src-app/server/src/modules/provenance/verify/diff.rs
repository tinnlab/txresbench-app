//! The re-run comparison engine (P4 ITEM-6 / DEC-4) — PURE, unit-testable.
//!
//! Compares a recorded run's **set-valued output signature**
//! `{(output_id, content_hash)}` to the re-run's, and derives a verification
//! status. R7 (all-N): a partial re-run that regenerates only SOME outputs must
//! NEVER pass. Honest framing (DEC-VERIFY): `tolerant` mode reports
//! `inconclusive` on a byte-diff — it never claims a numeric equivalence it did
//! not compute.

use std::collections::BTreeMap;

use serde_json::{json, Value};

/// The requested comparison strictness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToleranceMode {
    /// Bit-identical outputs required — any byte-diff → `diverged`.
    Exact,
    /// Structural: the same output SET must regenerate; a byte-diff on a present
    /// output → `inconclusive` (never `reproduced`).
    Tolerant,
}

impl ToleranceMode {
    /// Parse a request string; unknown / absent → `Tolerant` (the honest default,
    /// bit-exact being unachievable for seeded pipelines — DEC-4).
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("exact") => ToleranceMode::Exact,
            _ => ToleranceMode::Tolerant,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ToleranceMode::Exact => "exact",
            ToleranceMode::Tolerant => "tolerant",
        }
    }
}

/// The verification statuses this engine emits (terminal, non-`pending`) — the
/// single vocabulary in `super::status`.
pub use super::status::{DIVERGED, INCONCLUSIVE, REPRODUCED};

/// The comparison outcome: a terminal status + an itemized diff report (the
/// certificate payload).
#[derive(Debug, Clone)]
pub struct DiffOutcome {
    pub status: String,
    pub diff_report: Value,
}

/// Compare a recorded signature to a re-run signature under `mode`.
///
/// - a MISSING or EXTRA output id → `diverged` (R7 — a partial re-run never passes);
/// - all ids present + all hashes equal → `reproduced` (bit-exact);
/// - a byte-diff on a present id → `diverged` under `Exact`, `inconclusive` under
///   `Tolerant`.
pub fn compare(
    recorded: &[(String, String)],
    rerun: &[(String, String)],
    mode: ToleranceMode,
) -> DiffOutcome {
    let rec: BTreeMap<&str, &str> =
        recorded.iter().map(|(id, h)| (id.as_str(), h.as_str())).collect();
    let run: BTreeMap<&str, &str> =
        rerun.iter().map(|(id, h)| (id.as_str(), h.as_str())).collect();

    let mut matched: Vec<Value> = Vec::new();
    let mut mismatched: Vec<Value> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut extra: Vec<String> = Vec::new();

    for (id, rec_hash) in &rec {
        match run.get(id) {
            Some(run_hash) if run_hash == rec_hash => {
                matched.push(json!({ "id": id, "content_hash": rec_hash }));
            }
            Some(run_hash) => mismatched.push(json!({
                "id": id, "recorded_hash": rec_hash, "rerun_hash": run_hash,
            })),
            None => missing.push((*id).to_string()),
        }
    }
    for id in run.keys() {
        if !rec.contains_key(id) {
            extra.push((*id).to_string());
        }
    }

    let set_differs = !missing.is_empty() || !extra.is_empty();
    let status = if set_differs {
        DIVERGED
    } else if mismatched.is_empty() {
        REPRODUCED
    } else {
        match mode {
            ToleranceMode::Exact => DIVERGED,
            ToleranceMode::Tolerant => INCONCLUSIVE,
        }
    };

    let n_total = rec.len();
    let n_matched = matched.len();
    let summary = match status {
        REPRODUCED => format!("all {n_total} outputs regenerated bit-identically"),
        INCONCLUSIVE => format!(
            "{n_matched}/{n_total} outputs bit-identical; {} byte-differ — same outputs \
             regenerated but numeric equivalence NOT verified",
            mismatched.len()
        ),
        _ if set_differs => format!(
            "output set differs ({} missing, {} extra) — a partial re-run never passes",
            missing.len(),
            extra.len()
        ),
        _ => format!("{} of {n_total} outputs byte-differ (exact mode)", mismatched.len()),
    };

    DiffOutcome {
        status: status.to_string(),
        diff_report: json!({
            "mode": mode.as_str(),
            "outputs_total": n_total,
            "outputs_matched": n_matched,
            "matched": matched,
            "mismatched": mismatched,
            "missing": missing,
            "extra": extra,
            "summary": summary,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    // TEST-4: match / missing / extra / exact-vs-tolerant byte-diff.
    #[test]
    fn identical_signature_reproduces() {
        let rec = sig(&[("a", "sha256:1"), ("b", "sha256:2")]);
        let out = compare(&rec, &rec, ToleranceMode::Exact);
        assert_eq!(out.status, REPRODUCED);
        assert_eq!(out.diff_report["outputs_matched"], 2);
    }

    #[test]
    fn missing_output_diverges_r7() {
        let rec = sig(&[("a", "sha256:1"), ("b", "sha256:2")]);
        let run = sig(&[("a", "sha256:1")]); // regenerated only a subset
        // A partial re-run must NEVER pass, even in tolerant mode (R7).
        assert_eq!(compare(&rec, &run, ToleranceMode::Tolerant).status, DIVERGED);
        assert_eq!(compare(&rec, &run, ToleranceMode::Exact).status, DIVERGED);
    }

    #[test]
    fn extra_output_diverges() {
        let rec = sig(&[("a", "sha256:1")]);
        let run = sig(&[("a", "sha256:1"), ("b", "sha256:2")]);
        let out = compare(&rec, &run, ToleranceMode::Tolerant);
        assert_eq!(out.status, DIVERGED);
        assert_eq!(out.diff_report["extra"][0], "b");
    }

    #[test]
    fn byte_diff_is_exact_diverged_but_tolerant_inconclusive() {
        let rec = sig(&[("a", "sha256:1"), ("b", "sha256:2")]);
        let run = sig(&[("a", "sha256:1"), ("b", "sha256:CHANGED")]);
        assert_eq!(compare(&rec, &run, ToleranceMode::Exact).status, DIVERGED);
        let tol = compare(&rec, &run, ToleranceMode::Tolerant);
        assert_eq!(tol.status, INCONCLUSIVE, "tolerant never claims reproduced on a byte-diff");
        assert_eq!(tol.diff_report["mismatched"][0]["id"], "b");
    }

    #[test]
    fn mode_parse_defaults_tolerant() {
        assert_eq!(ToleranceMode::parse(Some("exact")), ToleranceMode::Exact);
        assert_eq!(ToleranceMode::parse(Some("EXACT")), ToleranceMode::Exact);
        assert_eq!(ToleranceMode::parse(Some("tolerant")), ToleranceMode::Tolerant);
        assert_eq!(ToleranceMode::parse(None), ToleranceMode::Tolerant);
        assert_eq!(ToleranceMode::parse(Some("bogus")), ToleranceMode::Tolerant);
    }
}
