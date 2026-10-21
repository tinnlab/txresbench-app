//! The reproducibility certificate (P4 ITEM-15) — a deterministic,
//! `codecheck.yml`-style record of a verification, PURE + unit-testable. Stored on
//! the verification row (`cert_json`) and written as the `verification.json`
//! member of the export bundle (ITEM-14).

use serde_json::{json, Value};
use uuid::Uuid;

/// A one-line honest human claim for a terminal status. `env_changed` = the
/// re-run rootfs differs from the run's RECORDED rootfs — appended as an honest
/// caveat so a Reproduced claim never hides that the environment moved.
pub fn claim_line(status: &str, rootfs_digest: Option<&str>, env_changed: bool, verified_at: &str) -> String {
    let env = rootfs_digest
        .map(|d| format!("rootfs {}", short_digest(d)))
        .unwrap_or_else(|| "the recorded environment".to_string());
    let base = match status {
        "reproduced" => {
            format!("Reproduced ✓ — bit-identical outputs regenerated against {env} on {verified_at}")
        }
        "inconclusive" => format!(
            "Inconclusive — the same outputs regenerated against {env} on {verified_at}, but \
             byte-differ; numeric equivalence not verified"
        ),
        "diverged" => {
            format!("Diverged ✗ — the re-run against {env} on {verified_at} did not reproduce the outputs")
        }
        "error" => format!("Error — the re-run could not complete on {verified_at}"),
        _ => format!("{status} on {verified_at}"),
    };
    if env_changed {
        format!("{base} (NOTE: the environment changed since recording — re-run rootfs ≠ recorded rootfs)")
    } else {
        base
    }
}

/// Build the certificate payload for a completed verification.
pub fn build_certificate(
    target_run_id: Uuid,
    status: &str,
    tolerance_mode: &str,
    diff_report: &Value,
    rootfs_digest: Option<&str>,
    env_changed: bool,
    verified_at: &str,
) -> Value {
    json!({
        "certificate": "codecheck-style-reproducibility",
        "target_run_id": target_run_id,
        "status": status,
        "tolerance_mode": tolerance_mode,
        "environment": {
            "rootfs_sha256": rootfs_digest,
            "env_changed": env_changed,
        },
        "verified_at": verified_at,
        "claim": claim_line(status, rootfs_digest, env_changed, verified_at),
        "outputs": diff_report,
    })
}

fn short_digest(d: &str) -> String {
    let hex = d.strip_prefix("sha256:").unwrap_or(d);
    hex.chars().take(12).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-6: the certificate is deterministic and carries status/mode/rootfs/diff.
    #[test]
    fn certificate_carries_status_mode_rootfs_diff() {
        let run = Uuid::new_v4();
        let diff = json!({ "outputs_total": 2, "outputs_matched": 2 });
        let a = build_certificate(run, "reproduced", "tolerant", &diff, Some("sha256:abcdef0123456789"), false, "2026-07-17T00:00:00Z");
        let b = build_certificate(run, "reproduced", "tolerant", &diff, Some("sha256:abcdef0123456789"), false, "2026-07-17T00:00:00Z");
        assert_eq!(a, b, "certificate is deterministic");
        assert_eq!(a["status"], "reproduced");
        assert_eq!(a["tolerance_mode"], "tolerant");
        assert_eq!(a["environment"]["rootfs_sha256"], "sha256:abcdef0123456789");
        assert_eq!(a["outputs"]["outputs_total"], 2);
        assert!(a["claim"].as_str().unwrap().contains("Reproduced"));
        assert!(a["claim"].as_str().unwrap().contains("abcdef012345"), "short rootfs digest in the claim");
    }

    #[test]
    fn inconclusive_claim_is_honest() {
        let c = build_certificate(Uuid::new_v4(), "inconclusive", "tolerant", &json!({}), None, false, "2026-07-17T00:00:00Z");
        let claim = c["claim"].as_str().unwrap();
        assert!(claim.contains("numeric equivalence not verified"), "never overclaims");
    }

    #[test]
    fn env_changed_is_flagged_in_the_claim() {
        let c = build_certificate(Uuid::new_v4(), "reproduced", "exact", &json!({}), Some("sha256:new"), true, "2026-07-17T00:00:00Z");
        assert_eq!(c["environment"]["env_changed"], true);
        assert!(
            c["claim"].as_str().unwrap().contains("environment changed since recording"),
            "a changed rootfs is disclosed even on a reproduced claim"
        );
    }
}
