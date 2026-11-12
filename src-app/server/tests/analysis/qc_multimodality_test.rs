//! TEST-28 [covers: ITEM-16, ITEM-17] — ONE run over TWO bindings of the list slot emits
//! a PREFIXED metric column for each, both declared against the SHARED first axis.
//!
//! ## The property, and why it is one test rather than two
//!
//! DEC-6 chose one job over every selected input rather than one job each: the first axis
//! is shared, so a joint predicate over `<a>:<metric>` AND `<b>:<metric>` is only
//! meaningful if ONE run writes both onto it. DEC-7 then made the prefix come from the
//! ARTIFACT's own declared key rather than from a control, because the retired control
//! offered a closed three-value list and an input outside it had no correct answer — the
//! wrong pick silently became the emitted column's prefix.
//!
//! Those two decisions are only jointly observable: a per-input run would still emit
//! prefixed columns, and a shared-axis run with one prefix would still emit two columns.
//! What tells the shipped behaviour apart from both is a SINGLE run whose outputs are two
//! DIFFERENTLY-prefixed columns declaring the SAME axis and the SAME length.
//!
//! ## What this adds over the compute's own suite
//!
//! `packages/qc/tests/test_modality_open_set.py` asserts the same property with the
//! package's pytest harness, including the per-input VALUE fidelity this file does not
//! reach (it reads only the emitted DECLARATION). This is the Rust tier of it: it stages
//! its inputs through [`StagedProcessor`], i.e. through the CONVERTER's own writers
//! resolved out of a `/code` dir assembled by production's own resolver — so the artifact
//! shape under test is the one production emits, and a change to the writer moves this
//! fixture in the same commit. The list slot is bound TWICE here, which no other Rust case
//! in this module does.
//!
//! Mount names are meaningless (`in0`/`in1`) on purpose: the runner derives them from the
//! artifact (ITEM-23) and the SLOT is the entry's whole contract, so an entry resolving by
//! filename could not pass. SELF-SKIPS when the numeric stack is absent (rootfs-only).

use serde_json::{json, Value};

use super::{
    binding, python_stack_ready, stage_processor, tmp_dir, AXIS_KEYS, AXIS_LABELS, METRIC_ENTRY,
    SLOT_LABELS, SLOT_MATRIX,
};
use crate::dataset::hardening_common::record_skip;

/// The two prefix keys the run declares, one per binding. Deliberately OUTSIDE any
/// vocabulary the app or its packages know: DEC-7's classifier is open by construction, so
/// a test drawn from a fixed list would prove the closed-list behaviour it replaced.
const KEY_A: &str = "alpha";
const KEY_B: &str = "beta";

/// The metric selected for the run — a `sum` over the whole label set, so the emitted set
/// is exactly one column per binding.
///
/// It used to be a BUILTIN (`{name, builtin: true}`), computed directly off the block, and
/// the run therefore bound no label input at all. The builtin special case is deleted:
/// every metric selects a label SET now, `.*` included, so a run that emits any column
/// binds one [`SLOT_LABELS`] artifact per matrix. The labels themselves are irrelevant
/// here — `.*` matches whatever they are — but the BINDING is part of the contract.
const METRIC: &str = "total_counts";

/// Every entry of the emitted `outputs/manifest.json`.
fn emitted_outputs(outputs: &std::path::Path) -> Vec<Value> {
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(outputs.join("manifest.json")).expect("the run emitted a manifest"),
    )
    .expect("the emitted manifest is valid json");
    manifest["outputs"]
        .as_array()
        .expect("the manifest declares an outputs array")
        .iter()
        .cloned()
        .collect()
}

/// The emitted PER-ENTITY columns — selected by the STRUCTURE they declare (an entry aligned
/// to an axis), not by a hardcoded datatype id.
///
/// That is deliberate and it is the stronger predicate. The datatype vocabulary belongs to
/// the contributed package, not to this suite, and an assertion spelled in it would pass or
/// fail on a rename rather than on the property. What the design actually claims here is
/// about ALIGNMENT — columns landing on a shared axis — so alignment is what selects them.
/// The run's other outputs are opaque report blobs declaring no axis at all, and the
/// discrimination check below requires at least one of them to be excluded, so this filter
/// cannot silently degrade into "everything".
fn axis_aligned(outputs: &[Value]) -> Vec<&Value> {
    outputs
        .iter()
        .filter(|e| e["structure"]["axis"].is_string())
        .collect()
}

#[test]
fn one_run_over_two_bindings_emits_a_prefixed_column_for_each_on_the_shared_axis() {
    if !python_stack_ready() {
        record_skip(
            "TEST-28",
            "the numeric stack is not importable on this host — this compute is rootfs-only \
             (sandbox env-image); a self-skip, not the ignore attribute",
        );
        return;
    }

    let root = tmp_dir("txr-qc28");
    let inputs = root.join("inputs");
    let outputs = root.join("outputs");
    std::fs::create_dir_all(&inputs).unwrap();
    std::fs::create_dir_all(&outputs).unwrap();
    let staged = stage_processor("qc", METRIC_ENTRY);

    // Two blocks over the SAME first-axis length (4) and DIFFERENT second-axis widths, so
    // "one artifact read twice" is not a shape the fixture accidentally permits, and the
    // shared-length assertion below is a real agreement rather than a tautology of one
    // input being read once.
    let block_a: &[&[u32]] = &[&[10, 0, 5, 5], &[5, 5, 0, 0], &[2, 2, 0, 6], &[8, 8, 2, 0]];
    let block_b: &[&[u32]] = &[&[1, 2, 3], &[4, 5, 6], &[7, 8, 9], &[0, 1, 0]];
    let shared_len = block_a.len();
    assert_eq!(
        block_b.len(),
        shared_len,
        "both inputs must span the same first axis, or DEC-6's shared-axis claim is not \
         what this test is exercising"
    );

    staged.write_matrix(&inputs.join("in0"), block_a);
    staged.write_matrix(&inputs.join("in1"), block_b);
    // One label artifact per matrix, list-ALIGNED with the bindings below — see `METRIC`.
    let labels_a: Vec<String> = (0..block_a[0].len()).map(|i| format!("g{i}")).collect();
    let labels_b: Vec<String> = (0..block_b[0].len()).map(|i| format!("g{i}")).collect();
    staged.write_column(
        &inputs.join("in2"),
        "values",
        &serde_json::to_string(&labels_a).unwrap(),
        AXIS_LABELS,
    );
    staged.write_column(
        &inputs.join("in3"),
        "values",
        &serde_json::to_string(&labels_b).unwrap(),
        AXIS_LABELS,
    );

    // BOTH matrix bindings sit on the ONE list slot — that is the arrangement under test. A
    // second slot name would be a different (and unsupported) contract.
    std::fs::write(
        inputs.join("inputs.json"),
        json!({ "inputs": [
            binding(SLOT_MATRIX, "in0"),
            binding(SLOT_MATRIX, "in1"),
            binding(SLOT_LABELS, "in2"),
            binding(SLOT_LABELS, "in3"),
        ] })
        .to_string(),
    )
    .unwrap();
    // The prefixes travel positionally, aligned with the bindings above.
    std::fs::write(
        inputs.join("params.json"),
        json!({
            "qc_metrics": [{ "name": METRIC, "pattern": ".*", "aggregation": "sum" }],
            "matrix_modalities": [KEY_A, KEY_B],
        })
        .to_string(),
    )
    .unwrap();

    // ONE run. Everything below is read out of its single output set.
    staged.run(&inputs, &outputs);

    let all = emitted_outputs(&outputs);
    let emitted = axis_aligned(&all);
    let names: std::collections::BTreeSet<String> = emitted
        .iter()
        .map(|e| {
            e["meta"]["name"]
                .as_str()
                .expect("an emitted column declares its name")
                .to_string()
        })
        .collect();

    // (1) ONE prefixed column per binding, and EXACTLY those two. An unprefixed column
    // would mean the two were folded together (one name, two meanings, the second silently
    // replacing the first); a missing one would mean a binding was dropped.
    let want: std::collections::BTreeSet<String> =
        [format!("{KEY_A}:{METRIC}"), format!("{KEY_B}:{METRIC}")]
            .into_iter()
            .collect();
    assert_eq!(
        names, want,
        "one run over two bindings must emit one prefixed column for each and nothing else"
    );

    // (2) …declared against the SHARED first axis, at the SAME length. This is what makes a
    // joint predicate across the two prefixes meaningful (DEC-6) — two columns on two
    // different axes could not be ANDed per entity.
    assert_eq!(
        emitted.len(),
        2,
        "the name set above is deduped; the row count is not"
    );
    for e in &emitted {
        assert_eq!(
            e["structure"]["axis"],
            json!(AXIS_KEYS),
            "an emitted column declares a different axis than the shared one: {e}"
        );
        assert_eq!(
            e["structure"]["n"],
            json!(shared_len),
            "an emitted column declares a length the run's inputs do not share: {e}"
        );
    }

    // (3) NON-VACUITY / discrimination, on BOTH the selector and the prefix.
    //
    // The selector: the run emits outputs that are NOT axis-aligned (its report blobs), so a
    // filter that had degraded into "everything" is caught here rather than silently making
    // (1) an assertion about the whole output set.
    assert!(
        all.len() > emitted.len(),
        "every emitted output is axis-aligned, so the selector above is not selecting — (1) \
         would then be a claim about the whole output set: {all:?}"
    );
    // The prefix: two genuinely different keys, neither of them a value the retired closed
    // list could have supplied, so a prefix derived from a constant — or folded onto a
    // privileged default — fails (1) rather than passing it by coincidence.
    assert_ne!(KEY_A, KEY_B);
    for name in &names {
        assert!(
            name.contains(':'),
            "an emitted column carries no prefix at all: {name}"
        );
    }

    let _ = std::fs::remove_dir_all(&root);
}
