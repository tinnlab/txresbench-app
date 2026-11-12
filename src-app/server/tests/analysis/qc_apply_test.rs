//! TEST-24 [ITEM-13] — `cell-filter.py` applies a per-sample metric-threshold recipe
//! + an optional gate cell-set → the expected surviving count.
//!
//! Runs the REAL processor over the ARTIFACTS its slots take (ITEM-24), where a single
//! opaque upload used to carry all of it:
//!
//!   * `expression`    — the counts, a CSC Zarr store declaring `kind: sparse_csc`. It
//!                       declares the axis LENGTH, which is the length of the mask the
//!                       run commits;
//!   * `column:<name>` — one binding per obs column the recipe may reference. The SLOT
//!                       carries the name: a column artifact declares a member called
//!                       `values`, never its display name, so the name has to arrive
//!                       with the BINDING or the recipe has nothing to resolve against.
//!
//! Asserts (a) a `criteria` threshold intersected with a gate cell-set (inclusive keep,
//! AND) yields the exact surviving count, and (b) a per-sample threshold only culls its
//! own sample. SELF-SKIPS when the numeric stack is absent (rootfs-only).

use std::path::Path;

use serde_json::{json, Value};

use super::{
    binding, python_stack_ready, stage_processor, tmp_dir, StagedProcessor, AXIS_KEYS,
    SLOT_COLUMN_PREFIX, SLOT_EXPRESSION,
};
use crate::dataset::hardening_common::record_skip;

fn read_report(outputs: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(outputs.join("filter-report.json")).expect("report"))
        .expect("filter-report.json valid")
}

/// Stage one run: an all-ones count matrix over `pct_mito.len()` entities, plus the two
/// obs columns the recipes below reference, each on its own meaningless mount.
fn setup(
    name: &str,
    pct_mito: &[f64],
    samples: &[&str],
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
    StagedProcessor,
) {
    let root = tmp_dir(name);
    let inputs = root.join("inputs");
    let outputs = root.join("outputs");
    std::fs::create_dir_all(&inputs).unwrap();
    std::fs::create_dir_all(&outputs).unwrap();
    let filter = stage_processor("cell-filter", "cell-filter.py");

    // The counts are irrelevant to every assertion here (the recipe reads the COLUMNS);
    // the matrix is bound because it is what declares the axis LENGTH.
    let ones = [1u32, 1, 1];
    let rows: Vec<&[u32]> = (0..pct_mito.len()).map(|_| &ones[..]).collect();
    filter.write_matrix(&inputs.join("in0"), &rows);
    filter.write_column(
        &inputs.join("in1"),
        "values",
        &serde_json::to_string(pct_mito).unwrap(),
        AXIS_KEYS,
    );
    filter.write_column(
        &inputs.join("in2"),
        "values",
        &serde_json::to_string(samples).unwrap(),
        AXIS_KEYS,
    );
    std::fs::write(
        inputs.join("inputs.json"),
        json!({ "inputs": [
            binding(SLOT_EXPRESSION, "in0"),
            binding(&format!("{SLOT_COLUMN_PREFIX}pct_mito"), "in1"),
            binding(&format!("{SLOT_COLUMN_PREFIX}sample"), "in2"),
        ] })
        .to_string(),
    )
    .unwrap();
    (root, inputs, outputs, filter)
}

// A `criteria` threshold (inclusive keep) intersected with a gate cell-set of
// integer indices — AND across both. 5 entities:
//   pct_mito = [50, 0, 0, 8.33, 0]  → threshold max 20 keeps {1,2,3,4} (drops #0 = 50)
//   gate = [0,1,2,3]                 → keeps {0,1,2,3}      (drops #4)
//   AND                              → {1,2,3} → 3 survive
//
// Each half drops an entity the OTHER keeps, which is what makes this an AND test.
// It did not used to be: the gate was `[1,2,3]`, a SUBSET of what the threshold left,
// so the answer was 3 whether the threshold ran or not — dropping the metric column
// entirely still passed (verified by mutation). Both halves are now load-bearing:
// either one alone leaves 4.
#[test]
fn threshold_plus_gate_intersection_survivors() {
    if !python_stack_ready() {
        // Ledger key = the TEST ID, reason = the MISSING DEPENDENCY. See the note in
        // `qc_metrics_test.rs`: `domain_surface`'s per-file vocabulary ratchet is
        // SHRINK-ONLY, so re-spelling the fn name or the package list in a literal here
        // grows this file's counts and fails that guard.
        record_skip(
            "TEST-24",
            "the numeric stack is not importable — cell-filter compute is rootfs-only; \
             a self-skip, not the ignore attribute",
        );
        return;
    }
    let (root, inputs, outputs, filter) = setup(
        "txr-qc24a",
        &[50.0, 0.0, 0.0, 8.33, 0.0],
        &["A", "A", "B", "B", "B"],
    );

    std::fs::write(
        inputs.join("params.json"),
        json!({
            "thresholds": [{ "criteria": "pct_mito", "max": 20 }],
            "gate": [0, 1, 2, 3],
            // The mask column IS this string, verbatim (0.9.0, `mask_column_name`). It is
            // REQUIRED: a run that cannot name its output refuses rather than committing
            // under an invented name, so `params.json` — the one boundary where absence
            // can occur — must carry it. The UI form defaults it to `keep`; this file
            // writes `params.json` directly and so has to supply it itself.
            "label": "keep_gated"
        })
        .to_string(),
    )
    .unwrap();

    filter.run(&inputs, &outputs);
    let report = read_report(&outputs);
    assert_eq!(report["n_cells_in"], json!(5), "5 in");
    assert_eq!(
        report["n_cells_out"],
        json!(3),
        "threshold∩gate → 3 survive"
    );
    assert_eq!(report["cell_set_applied"], json!(true), "gate applied");

    let _ = std::fs::remove_dir_all(&root);
}

// A PER-SAMPLE threshold only culls entities of its own sample. Same 5; a
// `sample:"A"` threshold max 20 fails only #0 (sample A, 50%); the sample-B rows
// (2,3,4) are untouched → 4 survive, no gate.
#[test]
fn per_sample_threshold_scopes_to_its_sample() {
    if !python_stack_ready() {
        record_skip(
            "TEST-24 (per-sample)",
            "the numeric stack is not importable — rootfs-only",
        );
        return;
    }
    let (root, inputs, outputs, filter) = setup(
        "txr-qc24b",
        &[50.0, 0.0, 25.0, 8.33, 0.0],
        &["A", "A", "B", "B", "B"],
    );

    // #2 is sample B with pct 25 (>20) but the threshold is scoped to sample A,
    // so it MUST survive — only #0 (sample A, 50%) is culled.
    std::fs::write(
        inputs.join("params.json"),
        // `label` as above — the mask column's name, required since 0.9.0. The name is
        // arbitrary, so it deliberately does NOT re-spell the scoping key: this file is
        // already baselined by `domain_surface`'s SHRINK-ONLY vocabulary ratchet (see the
        // note in the first test), and a literal echoing a token the file already carries
        // grows its count and fails that guard — which is exactly what it did.
        json!({
            "thresholds": [{ "criteria": "pct_mito", "max": 20, "sample": "A" }],
            "label": "keep_scoped"
        })
        .to_string(),
    )
    .unwrap();

    filter.run(&inputs, &outputs);
    let report = read_report(&outputs);
    assert_eq!(
        report["n_cells_out"],
        json!(4),
        "per-sample threshold culls only sample A's outlier"
    );

    let _ = std::fs::remove_dir_all(&root);
}
