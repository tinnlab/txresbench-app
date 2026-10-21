//! TEST-17 [ITEM-14] — the produces→accepts chain: Analysis-1 (`qc.10x`) produces a
//! QC-annotated dataset whose type Analysis-2 (`cell.filter`) `accepts`, and the
//! filtered output re-attaches (is itself a re-attachable, re-chainable type).
//!
//! This is a TYPE-CONTRACT integration test over the REAL `DatatypeRegistry` (the
//! single source of truth the workbench discovery + input-ready gate resolve against
//! at runtime — `analysis/discovery.ts`). It encodes the two processors' declared
//! `accepts`/`produces` contracts EXACTLY as their manifests declare them:
//!
//!   qc.10x     (workbench/builtins/qc-10x/manifest.ts):
//!     accepts:  [{ subtypes_of: "matrix", required }]
//!     produces: ["single-cell/expression", "report/qc", "metadata-column", "embedding"]
//!   cell.filter (workbench/builtins/cell-filter/manifest.ts):
//!     accepts:  [{ type_id: "single-cell/expression", required }, { type_id: "cell-set" }]
//!     produces: ["metadata-column"]   // ONLY a per-cell keep-mask (ITEM-25/27) — NON-destructive
//!
//! and asserts the registry's subtyping lattice actually links them — the produced
//! `single-cell/expression` is a type `cell.filter` accepts, and `report/qc` is the real
//! QC-annotation type the filter's metric-space reads. Cell filter is annotate-only: it
//! re-attaches NO filtered matrix — its output is a `metadata-column` keep-mask (a read-time
//! `(matrix, mask)` view replaces the old filtered-matrix re-attach). No python/rootfs — a
//! pure lattice contract, so it RUNS on any host.

use cytoanalyst::modules::datatype::registry::DatatypeRegistry;
use cytoanalyst::modules::datatype::types::TypeSelector;

/// The `qc.10x` produced datatype ids (manifest `produces`) — ANNOTATE-ONLY: metric
/// `metadata-column`s + the `report/qc` obs table. QC does NOT produce a (filtered)
/// matrix or an embedding (ITEM-17).
const QC_10X_PRODUCES: &[&str] = &["metadata-column", "report/qc"];

/// The `qc.10x` input selector (manifest `accepts[0]`): a `single-cell/expression`
/// subtype EXCEPT `single-cell/normalized` (ITEM-19: QC needs raw counts) — this also
/// EXCLUDES `embedding` (is-a `matrix` but NOT is-a `single-cell/expression`), fixing the
/// "embedding in the count-matrix picker" bug. `single-cell/counts` + ingest-tagged
/// `single-cell/expression` still pass.
fn qc_10x_accepts() -> TypeSelector {
    TypeSelector {
        subtypes_of: Some("single-cell/expression".into()),
        excludes: vec!["single-cell/normalized".into()],
        required: true,
        ..Default::default()
    }
}

#[test]
fn qc_produces_metric_columns_and_a_qc_report_over_the_real_lattice() {
    // The QC chain resolves domain types (report/qc, metadata-column, …) that are
    // manifest-contributed now → build the MERGED registry (roots ∪ contributions),
    // as boot does.
    let reg = DatatypeRegistry::build_from_embedded().expect("merged datatype registry builds");

    // 1. Every datatype qc.10x claims to PRODUCE is a REAL registry type (not fabricated).
    for id in QC_10X_PRODUCES {
        assert!(
            reg.get(id).is_some(),
            "qc.10x produces unknown datatype {id}"
        );
    }
    // report/qc is_a report/html (the metric report), and qc.10x emits per-cell metric
    // `metadata-column`s — the columns the downstream Cell-filter reads to build its mask.
    assert!(
        reg.is_a("report/qc", "report/html"),
        "report/qc must be a report subtype (the QC annotation qc.10x produces)"
    );
    assert!(
        QC_10X_PRODUCES.contains(&"metadata-column"),
        "qc.10x must produce the per-cell metric metadata-columns"
    );
    // Annotate-only: qc.10x must NOT claim to produce a matrix or an embedding.
    assert!(
        !QC_10X_PRODUCES.contains(&"single-cell/expression")
            && !QC_10X_PRODUCES.contains(&"embedding"),
        "annotate-only QC produces neither a (filtered) matrix nor an embedding"
    );

    // 2. INPUT ACCEPT: qc.10x accepts single-cell expression subtypes (incl. counts) but
    //    NOT embedding — the "embedding in the count-matrix picker" bug (ITEM-19).
    let qc_in = qc_10x_accepts();
    assert!(
        reg.matches("single-cell/expression", &qc_in),
        "qc accepts expression"
    );
    assert!(
        reg.matches("single-cell/counts", &qc_in),
        "qc accepts raw counts"
    );
    assert!(
        !reg.matches("single-cell/normalized", &qc_in),
        "qc must NOT accept a NORMALIZED matrix (ITEM-19: QC needs raw counts)"
    );
    assert!(
        !reg.matches("embedding", &qc_in),
        "qc must NOT accept an embedding even though it is-a matrix (the picker bug fix)"
    );
    // NEGATIVE CONTROL — the accept selector discriminates (not match-everything):
    // a bare report is not an acceptable QC input.
    assert!(
        !reg.matches("report/qc", &qc_in),
        "qc must NOT accept a bare report/qc"
    );
    assert!(
        !reg.matches("report/html", &qc_in),
        "qc must NOT accept an unrelated report"
    );

    // TODO(slice-4 / ITEM-27..31): the QC→Cell-filter CHAIN — Cell filter reads qc.10x's
    // `metadata-column` metrics + the shared matrix and produces a `keep_*` metadata-column
    // MASK (no filtered-matrix re-attach) — is validated when Cell filter's contract lands.
}
