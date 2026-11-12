//! TEST-15 [ITEM-13] — `qc-10x.py` with a configurable `qc_metrics` set emits the
//! per-cell `/obs` metric artifact.
//!
//! Runs the REAL processor on a TINY synthetic matrix carrying an MT- gene, an RPS
//! gene, and an HBA gene, with `qc_metrics:[{mito},{ribo},{custom hb ^HB[AB]}]`, and
//! asserts the emitted `obs.json` has `pct_mito/pct_ribo/pct_hb` columns, the right
//! `matched_genes` per metric, correct per-cell percentages, and NA→0 (DEC-3) for a
//! zero-count cell. SELF-SKIPS when the numeric stack is absent (rootfs-only).
//!
//! ## The input contract these stage (ITEM-24)
//!
//! Every input is resolved by SLOT out of `/inputs/inputs.json`, and each is a separate
//! ARTIFACT — three where one opaque upload used to carry everything. The slot names
//! are the constants next door, so this reads them rather than re-spelling them:
//!
//!   * [`SLOT_MATRIX`] — the counts, a CSC Zarr store declaring `kind: sparse_csc`;
//!   * [`SLOT_LABELS`] — the labels a PATTERN metric matches against, list-aligned with
//!                       the matrix slot. Binding it is not decoration: the compute
//!                       REFUSES a run whose pattern metrics have no labels to ask
//!                       about, because the two answers tried before it (match the axis
//!                       index, which is an accession on a real dataset → a silent 0 %;
//!                       or drop the metric with a warning buried inside the artifact)
//!                       both reported something other than "you did not get what you
//!                       asked for";
//!   * [`SLOT_KEYS`]   — the axis keys, i.e. the emitted per-entity `id` values.
//!                       Absent ⇒ positional ids, recorded as such in `id_source`.
//!
//! All three are staged by `StagedProcessor`'s writers, which are the converter's own —
//! see its header for why a hand-built store is the thing that goes stale.

use std::path::Path;

use serde_json::{json, Value};

use super::{
    binding, python_stack_ready, stage_processor, tmp_dir, AXIS_KEYS, AXIS_LABELS, METRIC_ENTRY,
    SLOT_KEYS, SLOT_LABELS, SLOT_MATRIX,
};
use crate::dataset::hardening_common::record_skip;

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-3
}

/// The emitted per-entity metric table (`report/qc`), parsed.
fn read_metric_table(outputs: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(outputs.join("obs.json")).expect("obs.json emitted"))
        .expect("obs.json is valid json")
}

/// The metric column names the run emitted, in emission order.
fn columns(table: &Value) -> Vec<String> {
    table["columns"]
        .as_array()
        .expect("columns array")
        .iter()
        .map(|c| c.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn qc_metrics_emit_per_cell_obs_artifact() {
    if !python_stack_ready() {
        // The ledger key is the TEST ID, not the fn name, and the reason names the
        // MISSING DEPENDENCY rather than the test: `domain_surface`'s vocabulary ratchet
        // is SHRINK-ONLY per file, so re-spelling the fn name (or an install hint naming
        // the packages) in a string literal GROWS this file's counts and fails that
        // guard. The install command is in this module's header doc, which is where it
        // belongs.
        record_skip(
            "TEST-15",
            "the numeric stack is not importable on this host — the QC compute is \
             rootfs-only (sandbox env-image); a self-skip, not the ignore attribute",
        );
        return;
    }

    let root = tmp_dir("txr-qc15");
    let inputs = root.join("inputs");
    let outputs = root.join("outputs");
    std::fs::create_dir_all(&inputs).unwrap();
    std::fs::create_dir_all(&outputs).unwrap();
    let staged = stage_processor("qc", METRIC_ENTRY);

    // Label order is load-bearing (matched_genes preserves the axis order).
    //           0       1       2        3        4       5       6      7
    let labels = [
        "GAPDH", "ACTB", "MT-CO1", "MT-ND1", "RPS12", "RPL13", "HBA1", "CD3D",
    ];
    let rows: &[&[u32]] = &[
        &[10, 0, 5, 5, 0, 0, 0, 0], // 0: total 20, mito 10 → 50%
        &[5, 5, 0, 0, 4, 4, 0, 0],  // 1: total 18, ribo 8 → 44.44%
        &[2, 2, 0, 0, 0, 0, 6, 0],  // 2: total 10, hb 6 → 60%
        &[8, 8, 2, 0, 2, 0, 0, 4],  // 3: total 24, mito 2 → 8.33%
        &[0, 0, 0, 0, 0, 0, 0, 0],  // 4: total 0 → NA→0 (DEC-3)
    ];
    let keys: Vec<String> = (0..rows.len()).map(|i| format!("k{i}")).collect();

    // Mount names are MEANINGLESS on purpose (`in0`…): the runner derives them from the
    // artifact, so a name says nothing about a format and the SLOT is the whole contract.
    staged.write_matrix(&inputs.join("in0"), rows);
    staged.write_column(
        &inputs.join("in1"),
        "values",
        &serde_json::to_string(&labels).unwrap(),
        AXIS_LABELS,
    );
    staged.write_column(
        &inputs.join("in2"),
        "values",
        &serde_json::to_string(&keys).unwrap(),
        AXIS_KEYS,
    );
    std::fs::write(
        inputs.join("inputs.json"),
        json!({ "inputs": [
            binding(SLOT_MATRIX, "in0"),
            binding(SLOT_LABELS, "in1"),
            binding(SLOT_KEYS, "in2"),
        ] })
        .to_string(),
    )
    .unwrap();
    // ITEM-18: metrics are per-run OPTIONAL, and now UNIFORM — every row is a label SET
    // (a regex) plus an AGGREGATION, and the emitted column is named by the row VERBATIM.
    // The first two rows are what the deleted `builtin: true` selections were: `sum` and
    // `count` over `.*`. (A run that drops them is covered below.)
    std::fs::write(
        inputs.join("params.json"),
        json!({
            "qc_metrics": [
                { "name": "total_counts", "pattern": ".*", "aggregation": "sum" },
                { "name": "n_genes", "pattern": ".*", "aggregation": "count" },
                { "name": "pct_mito", "pattern": "^MT-|^mt-", "aggregation": "percentage" },
                { "name": "pct_ribo", "pattern": "^RP[SL]", "aggregation": "percentage" },
                { "name": "pct_hb",   "pattern": "^HB[AB]", "aggregation": "percentage" }
            ],
            "min_genes": 0,
            "min_cells": 0
        })
        .to_string(),
    )
    .unwrap();

    staged.run(&inputs, &outputs);

    let table = read_metric_table(&outputs);

    // Columns: id + one per configured metric. Annotate-only
    // QC emits NO `ident`/sample column (grouping is a viz-time choice over dataset metadata).
    let cols = columns(&table);
    assert!(
        !cols.contains(&"ident".to_string()),
        "QC must NOT emit an ident/sample column"
    );
    for expected in ["id", "total_counts", "n_genes", "pct_mito", "pct_ribo", "pct_hb"] {
        assert!(
            cols.contains(&expected.to_string()),
            "columns missing {expected}: {cols:?}"
        );
    }
    assert_eq!(table["n_cells"], json!(5));

    // matched_genes lists exactly the regex-matched labels, in axis order.
    let mg = &table["matched_genes"];
    let list = |k: &str| -> Vec<String> {
        mg[k]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g.as_str().unwrap().to_string())
            .collect()
    };
    // Keyed by the emitted COLUMN name, which is the row's own name verbatim (DEC-1) —
    // there is no stem the compute decorates any more, so these keys ARE the metric names.
    assert_eq!(list("pct_mito"), vec!["MT-CO1", "MT-ND1"], "mito labels");
    assert_eq!(list("pct_ribo"), vec!["RPS12", "RPL13"], "ribo labels");
    assert_eq!(list("pct_hb"), vec!["HBA1"], "custom hb labels");

    // Per-entity percentages + the NA→0 rule (DEC-3).
    let pct = |name: &str, i: usize| -> f64 {
        table["obs"][name].as_array().unwrap()[i].as_f64().unwrap()
    };
    assert!(
        approx(pct("pct_mito", 0), 50.0),
        "pct_mito[0]={}",
        pct("pct_mito", 0)
    );
    assert!(
        approx(pct("pct_ribo", 1), 44.444),
        "pct_ribo[1]={}",
        pct("pct_ribo", 1)
    );
    assert!(
        approx(pct("pct_hb", 2), 60.0),
        "pct_hb[2]={}",
        pct("pct_hb", 2)
    );
    assert!(
        approx(pct("pct_mito", 3), 8.333),
        "pct_mito[3]={}",
        pct("pct_mito", 3)
    );
    // Row 4 has zero counts → every metric is NA→0, not NaN/1.
    assert_eq!(pct("pct_mito", 4), 0.0, "zero-count mito NA→0");
    assert_eq!(pct("pct_ribo", 4), 0.0, "zero-count ribo NA→0");
    assert_eq!(pct("pct_hb", 4), 0.0, "zero-count hb NA→0");

    // The ids ARE the bound axis keys, in input order — the matrix is NOT reordered or
    // filtered, and the run says WHERE the ids came from rather than passing a position
    // off as a key. (Asserting the LENGTH alone, as this did, is satisfied by the
    // positional fallback, so it could not tell the two apart.)
    assert_eq!(
        table["obs"]["id"].as_array().unwrap(),
        &keys.iter().map(|k| json!(k)).collect::<Vec<_>>(),
        "ids are the bound axis keys, in order"
    );
    assert_eq!(
        table["id_source"],
        json!(SLOT_KEYS),
        "the ids are declared to come from the key artifact"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// TEST-15b [ITEM-18] — every metric is OPTIONAL: a run selecting ONLY a custom metric emits
/// ONLY that column — NO `total_counts` / `n_genes` / `pct_mito`.
/// This is the ITEM-18 headline, proven against the REAL processor (not just the helper units).
///
/// It binds NO key artifact — the property here is the emitted column SET, and leaving the
/// keys unbound exercises the other half of the id contract TEST-15 pins (positional ids).
#[test]
fn qc_only_custom_metric_emits_only_that_column() {
    if !python_stack_ready() {
        record_skip(
            "TEST-15b",
            "the numeric stack is not importable — QC compute is rootfs-only",
        );
        return;
    }

    let root = tmp_dir("txr-qc15b");
    let inputs = root.join("inputs");
    let outputs = root.join("outputs");
    std::fs::create_dir_all(&inputs).unwrap();
    std::fs::create_dir_all(&outputs).unwrap();
    let staged = stage_processor("qc", METRIC_ENTRY);

    let labels = ["GAPDH", "ACTB", "MT-CO1", "HBA1"];
    let rows: &[&[u32]] = &[&[2, 2, 0, 6], &[5, 5, 0, 0]];
    staged.write_matrix(&inputs.join("in0"), rows);
    staged.write_column(
        &inputs.join("in1"),
        "values",
        &serde_json::to_string(&labels).unwrap(),
        AXIS_LABELS,
    );
    std::fs::write(
        inputs.join("inputs.json"),
        json!({ "inputs": [binding(SLOT_MATRIX, "in0"), binding(SLOT_LABELS, "in1")] }).to_string(),
    )
    .unwrap();
    // ONLY a custom hb metric — none of the four defaults.
    std::fs::write(
        inputs.join("params.json"),
        json!({
            "qc_metrics": [{ "name": "pct_hb", "pattern": "^HB[AB]", "aggregation": "percentage" }],
            "min_genes": 0,
            "min_cells": 0
        })
        .to_string(),
    )
    .unwrap();

    staged.run(&inputs, &outputs);

    let table = read_metric_table(&outputs);
    let cols = columns(&table);
    // ONLY id + pct_hb — the forced builtins are gone (the ITEM-18 fix). The column is
    // named by the ROW, verbatim (DEC-1): there is no `pct_` the compute prepends any more,
    // so `pct_hb` is what the row asked to be called.
    assert_eq!(
        cols,
        vec!["id".to_string(), "pct_hb".to_string()],
        "cols={cols:?}"
    );
    for forced in ["total_counts", "n_genes", "pct_mito", "pct_ribo"] {
        assert!(
            !cols.contains(&forced.to_string()),
            "unexpected forced column {forced}: {cols:?}"
        );
    }
    // The unbound-key half of the id contract: positional ids, DECLARED as positional.
    assert_eq!(
        table["id_source"],
        json!("position"),
        "with no key artifact bound the ids are positions, and say so"
    );

    let _ = std::fs::remove_dir_all(&root);
}
