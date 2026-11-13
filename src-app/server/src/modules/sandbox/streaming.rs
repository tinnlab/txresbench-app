//! The progress/milestone FIFO line codecs (the kept half).
//!
//! strip-single-cell ITEM-3: the streaming sandbox SPAWN (run_analysis_streaming,
//! `StreamGuards`) was removed with the processor pipeline; the shared line
//! codecs [`parse_progress_line`]/[`parse_milestone_line`] stay — the stacked
//! method run's FIFO drain (service.rs) parses with them, and so does the macOS
//! method VM's run seam (mac_vm_run.rs), which receives the same lines from the
//! guest agent. Built on every platform for that reason.

use super::backend::{MilestoneFrame, ProgressFrame};


/// Parse a progress line `phase|pct|message` (pct + message optional). Returns
/// `None` for an empty line. Pure + unit-testable.
pub fn parse_progress_line(line: &str) -> Option<ProgressFrame> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.splitn(3, '|');
    let phase = parts.next().unwrap_or("").trim().to_string();
    if phase.is_empty() {
        return None;
    }
    let pct = parts.next().and_then(|p| p.trim().parse::<f32>().ok());
    let message = parts.next().map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    Some(ProgressFrame { phase, pct, message })
}

/// Parse a milestone line `milestone|<id>|<status>[|<detail-json>]` (ITEM-24).
/// The literal `milestone` tag distinguishes it from a `phase|pct|message`
/// progress line; `status` MUST be one of `started|done|failed`. The optional 4th
/// field is a JSON payload the script emits as it inspects the data — a missing or
/// unparseable payload degrades to `Value::Null` (never fails the line). Returns
/// `None` for a non-milestone / malformed line. Pure + unit-testable.
pub fn parse_milestone_line(line: &str) -> Option<MilestoneFrame> {
    let line = line.trim();
    // splitn(4): the detail JSON may itself contain '|', so keep it whole.
    let mut parts = line.splitn(4, '|');
    if parts.next()?.trim() != "milestone" {
        return None;
    }
    let id = parts.next().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return None;
    }
    let status = parts.next().unwrap_or("").trim().to_string();
    if !matches!(status.as_str(), "started" | "done" | "failed") {
        return None;
    }
    let detail = parts
        .next()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty())
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or(serde_json::Value::Null);
    Some(MilestoneFrame { id, status, detail })
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-5 (progress parse leg): the FIFO line codec.
    #[test]
    fn parse_progress_line_variants() {
        let f = parse_progress_line("normalizing|40|scaling counts").unwrap();
        assert_eq!(f.phase, "normalizing");
        assert_eq!(f.pct, Some(40.0));
        assert_eq!(f.message.as_deref(), Some("scaling counts"));

        let bare = parse_progress_line("clustering").unwrap();
        assert_eq!(bare.phase, "clustering");
        assert_eq!(bare.pct, None);
        assert_eq!(bare.message, None);

        let no_msg = parse_progress_line("embedding|75").unwrap();
        assert_eq!(no_msg.pct, Some(75.0));
        assert_eq!(no_msg.message, None);

        assert!(parse_progress_line("").is_none(), "empty → None");
        assert!(parse_progress_line("   ").is_none(), "whitespace → None");
        assert!(parse_progress_line("|50|x").is_none(), "empty phase → None");
    }

    // TEST-5 (milestone parse leg): the FIFO milestone codec (ITEM-24).
    #[test]
    fn parse_milestone_line_variants() {
        // Full form with a structured detail payload (the data-determined finding).
        let f = parse_milestone_line("milestone|embeddings|done|{\"count\":3,\"names\":[\"UMAP\",\"PCA\"]}")
            .unwrap();
        assert_eq!(f.id, "embeddings");
        assert_eq!(f.status, "done");
        assert_eq!(f.detail["count"], serde_json::json!(3));
        assert_eq!(f.detail["names"][0], serde_json::json!("UMAP"));

        // No detail → Null.
        let started = parse_milestone_line("milestone|read|started").unwrap();
        assert_eq!(started.id, "read");
        assert_eq!(started.status, "started");
        assert!(started.detail.is_null());

        // A detail JSON containing '|' survives (splitn keeps the 4th field whole).
        let piped = parse_milestone_line("milestone|detect|done|{\"note\":\"a|b\"}").unwrap();
        assert_eq!(piped.detail["note"], serde_json::json!("a|b"));

        // An unparseable detail degrades to Null (never fails the line).
        let bad_detail = parse_milestone_line("milestone|meta|done|not json").unwrap();
        assert!(bad_detail.detail.is_null());

        // Not a milestone → None (routes to progress instead).
        assert!(parse_milestone_line("normalizing|40|scaling").is_none(), "non-tag → None");
        // Malformed / invalid status → None.
        assert!(parse_milestone_line("milestone|read|bogus").is_none(), "bad status → None");
        assert!(parse_milestone_line("milestone||done").is_none(), "empty id → None");
        assert!(parse_milestone_line("milestone|read").is_none(), "missing status → None");
        assert!(parse_milestone_line("").is_none(), "empty → None");
    }
}
