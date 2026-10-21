//! **TEST-10 / INV-10 — axis membership is attributed by DIGEST, never by label (ITEM-10).**
//!
//! An artifact's row-space membership is DECIDABLE from its content-identity digest, not INFERRED
//! from an axis label. An artifact carrying a matching axis LABEL (`axis: "rows"`) but no
//! `structure.key_sequence_digest` and no `structure.aligned_to` is REFUSED where a positional
//! read must attribute it — "unknown is never a match" (INV-5). DEC-9 retains INV-10 as exactly
//! this digest-over-label PRINCIPLE (attachment itself carries no attribution gate).
//!
//! This drives the SAME two things the gather's leaf-attribution does at
//! `gather_exec::plan_chain::expand`: (1) the extraction — read `key_sequence_digest`, falling
//! back to `aligned_to`; (2) the guard — `verify_leaf_digest`. A source that declares only a
//! label produces no digest and is refused; one whose `aligned_to` equals the pinned digest is
//! accepted.

use serde_json::{json, Value};

use cytoanalyst::modules::workstore::gathered::verify_leaf_digest;

/// The gather's leaf-digest extraction, replicated verbatim from the `expand` call site: the
/// identity lives in ONE of two fields (`key_sequence_digest` on the artifact that CARRIES the
/// axis's keys; `aligned_to` on a table merely LIVING on that axis), and an empty string is not a
/// digest.
fn declared_digest(structure: &Value) -> Option<&str> {
    structure
        .get("key_sequence_digest")
        .or_else(|| structure.get("aligned_to"))
        .and_then(|v| v.as_str())
        .filter(|d| !d.is_empty())
}

/// **A label without a digest is refused as a mask/alignment target.**
///
/// nc: change `verify_leaf_digest`'s `(Some(_), None)` arm to `Ok(())` and a label-only artifact
/// is admitted onto the row space — a positional gather then returns the right number of the
/// WRONG rows with nothing to indicate it.
#[test]
fn an_artifact_with_a_matching_label_but_no_digest_is_refused() {
    let pinned = "sha256:the-mask-row-space-digest";

    // Carries the axis LABEL `rows`, but declares NEITHER identity field. Attribution by label
    // would treat it as row-indexed; attribution by digest refuses it.
    let label_only = json!({
        "axis": "rows",
        "kind": "table",
        "columns": [{ "name": "values", "axis": "rows" }],
    });
    assert!(
        declared_digest(&label_only).is_none(),
        "a matching axis label is NOT a digest — the row space cannot be read off a label"
    );

    let err = verify_leaf_digest("leaf-rows", Some(pinned), declared_digest(&label_only))
        .expect_err("a label-only artifact must be refused as a mask target");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("SOURCE_DIGEST_UNKNOWN"),
        "the refusal is about a MISSING identity, not a mismatched one: {msg}"
    );
}

/// **An artifact whose digest EQUALS the mask's row-space digest is accepted.**
///
/// The positive control: the same shape, now declaring `aligned_to` equal to the pinned digest,
/// passes — proving the refusal above is the missing digest, not the label.
#[test]
fn an_artifact_whose_digest_matches_is_accepted() {
    let pinned = "sha256:the-mask-row-space-digest";

    let aligned = json!({
        "axis": "rows",
        "kind": "table",
        "aligned_to": pinned,
        "columns": [{ "name": "values", "axis": "rows" }],
    });
    assert_eq!(declared_digest(&aligned), Some(pinned));
    verify_leaf_digest("leaf-rows", Some(pinned), declared_digest(&aligned))
        .expect("a source whose digest equals the row-space digest is accepted");

    // And a DIFFERENT digest is a mismatch, not a match (the label is identical throughout).
    let moved = json!({ "axis": "rows", "aligned_to": "sha256:a-different-row-space" });
    let err = verify_leaf_digest("leaf-rows", Some(pinned), declared_digest(&moved))
        .expect_err("a different digest under the same label is a mismatch");
    assert!(format!("{err:?}").contains("SOURCE_DIGEST_MISMATCH"));
}
