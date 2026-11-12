//! TEST-17 / TEST-18 / TEST-19 (ITEM-9 / ITEM-10 / ITEM-11) — the builtin sandbox
//! processors RUN END-TO-END through the **product path**
//! (`POST /datasets/{id}/process` → an `analysis` job → the sandbox runner →
//! typed workstore outputs) on the REAL `pbmc3k_raw.h5ad` fixture.
//!
//! These are NOT inline-script substitutes: the runner resolves the FE-sent
//! `code_ref` (e.g. `"compute/import-h5ad.py"`) to the BAKED processor script
//! (`sandbox::processors`, the ITEM-18 last mile), stages the dataset's file as a
//! `dataset_file_ref` input, runs scanpy inside the rootfs, and ingests the real
//! `role`-tagged outputs. Asserting the emitted `output_id`s + content-addressing
//! proves the whole wiring — the exact gap the audit flagged (the scripts never
//! reached the sandbox).
//!
//! ROOTFS + FIXTURE gated: self-skips at runtime when the analysis sandbox is not
//! executable (the fresh `/proc` PID-ns mount needs `CAP_SYS_ADMIN`) OR the fixture
//! is not fetched (`bash tests/dataset/fixtures/fetch.sh pbmc3k`). It is RUN FOR
//! REAL on a `CAP_SYS_ADMIN` host — see `.lifecycle/.../TEST_RESULTS.md` + the
//! captured `processor-run-*.log` artifact. A self-skip is NEVER reported as a PASS.

use std::collections::HashSet;

use serde_json::{json, Value};

use txresbench::modules::workstore::object_store::{ContentKey, ObjectStore};

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn import_h5ad_runs_end_to_end_on_pbmc3k() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = gate(&server, &admin, "import_h5ad_runs_end_to_end_on_pbmc3k").await else {
        return;
    };
    let pool = pool_for(&server).await;

    let dataset_id = upload_fixture(&server, &admin, PBMC3K, bytes).await;
    // The FE `code_ref` (NOT an inline script) — the runner resolves it to the baked
    // `import-h5ad.py`. Empty params → the script's defaults.
    let (_run, sig) = process_and_wait(
        &server,
        &admin,
        &pool,
        dataset_id,
        json!({ "language": "python", "code_ref": "compute/import-h5ad.py", "params": {} }),
    )
    .await;

    let ids: HashSet<&str> = sig.iter().map(|(id, _)| id.as_str()).collect();
    assert!(
        !sig.is_empty(),
        "import-h5ad produced typed outputs — got none"
    );
    assert!(
        ids.contains("expression"),
        "import-h5ad emits an `expression` artifact — got {ids:?}"
    );
    assert!(
        sig.iter()
            .any(|(id, _)| id == "inspect" || id.starts_with("metadata")),
        "import-h5ad emits the inspect/metadata outputs — got {ids:?}"
    );
    assert!(
        sig.iter().all(|(_, h)| h.starts_with("sha256:")),
        "every output is content-addressed — got {sig:?}"
    );
}

#[tokio::test]
async fn qc_10x_runs_end_to_end_on_pbmc3k() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = gate(&server, &admin, "qc_10x_runs_end_to_end_on_pbmc3k").await else {
        return;
    };
    let pool = pool_for(&server).await;

    let dataset_id = upload_fixture(&server, &admin, PBMC3K, bytes).await;
    // Real QC params flow through /inputs/params.json (the fix that stopped params
    // being dropped) — a light gene filter + a mito ceiling.
    let (_run, sig) = process_and_wait(
        &server,
        &admin,
        &pool,
        dataset_id,
        json!({
            "language": "python",
            "code_ref": "compute/qc-10x.py",
            "params": { "fileType": "h5ad", "min_genes": 200, "max_pct_mito": 15, "min_cells": 3, "strategy": "fixed" }
        }),
    )
    .await;

    // `qc.10x` is ANNOTATE-ONLY (DEC-13, `packages/qc/manifest.yaml`:
    // `produces: [metadata-column, report/qc]` + the comment "NO filtered matrix"):
    // it adds per-cell metric COLUMNS and a QC report, and never modifies the
    // matrix. This assertion previously demanded a filtered `expression` output —
    // a contract that predates DEC-13 and no longer exists; the mismatch stayed
    // dormant because the test self-skips on any host with no analysis rootfs.
    let ids: HashSet<&str> = sig.iter().map(|(id, _)| id.as_str()).collect();
    assert!(
        !ids.contains("expression"),
        "qc-10x is annotate-only (DEC-13) and must NOT emit a filtered matrix — got {ids:?}"
    );
    // The DEFAULT metric set's emitted column names — each the row's own `name` verbatim
    // (DEC-1), with no `pct_counts_` decoration for a consumer to predict.
    for metric in ["total_counts", "n_genes", "pct_mito", "pct_ribo"] {
        assert!(
            ids.contains(format!("metadata-column:{metric}").as_str()),
            "qc-10x emits the per-cell metric column `{metric}` — got {ids:?}"
        );
    }
    assert!(
        ids.iter()
            .any(|id| id.starts_with("report") || id.starts_with("qc")),
        "qc-10x emits a QC report/density output — got {ids:?}"
    );
}

#[tokio::test]
async fn cell_filter_runs_end_to_end_on_pbmc3k() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = gate(&server, &admin, "cell_filter_runs_end_to_end_on_pbmc3k").await else {
        return;
    };
    let pool = pool_for(&server).await;

    let dataset_id = upload_fixture(&server, &admin, PBMC3K, bytes).await;
    // A criteria recipe (min total_counts) + a mask LABEL — cell-filter computes the metric on
    // the fly when absent, ANDs the criteria into a keep-mask, and (ITEM-25/27, DEC-18) emits
    // ONLY a per-cell boolean keep-mask metadata-column, NAMED BY THE LABEL verbatim, + a
    // delta report. It is
    // NON-DESTRUCTIVE: no filtered `expression` matrix is written.
    let (_run, sig) = process_and_wait(
        &server,
        &admin,
        &pool,
        dataset_id,
        json!({
            "language": "python",
            "code_ref": "compute/cell-filter.py",
            "params": {
                "thresholds": [{ "metric": "total_counts", "min": 100 }],
                "label": "min_counts",
                "seed": 0
            }
        }),
    )
    .await;

    let ids: HashSet<&str> = sig.iter().map(|(id, _)| id.as_str()).collect();
    // The primary output is the keep-mask metadata-column — NOT a filtered matrix (ITEM-27).
    assert!(
        ids.iter().any(|id| id.contains("metadata-column:min_counts")),
        "cell-filter emits the keep-mask metadata-column, NAMED BY THE LABEL verbatim \
         (no `keep_` prefix since 0.9.0) — got {ids:?}"
    );
    assert!(
        !ids.contains("expression"),
        "cell-filter is NON-DESTRUCTIVE — it must NOT emit a filtered `expression` matrix — got {ids:?}"
    );
    assert!(
        ids.iter().any(|id| id.contains("report")),
        "cell-filter emits a filter/delta report — got {ids:?}"
    );
}

/// REGRESSION (the params-mount bug), at the PRODUCT level: a real processor run
/// must SEE its params.
///
/// The sandbox binds `/inputs` file-by-file, so the derived `params.json` that
/// `materialize_inputs` writes was never mounted: every entry script's
/// `read_json(/inputs/params.json, {})` returned `{}` and the run silently
/// executed on defaults. For `cell-filter` that meant an all-keep mask committed
/// on EVERY live run — the persisted artifact kept every cell while the
/// client-side preview looked correct.
///
/// This drives the same product path as the sibling test but with a threshold the
/// pbmc3k fixture actually bites on, and reads the run's OWN `filter-report`
/// artifact back out of the workstore. Without the derived bind the report reads
/// `thresholds: []` and `n_cells_out == n_cells_in`; with it the criteria are
/// present and cells are actually removed.
#[tokio::test]
async fn cell_filter_run_sees_its_params_not_an_empty_object() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = gate(
        &server,
        &admin,
        "cell_filter_run_sees_its_params_not_an_empty_object",
    )
    .await
    else {
        return;
    };
    let pool = pool_for(&server).await;

    let dataset_id = upload_fixture(&server, &admin, PBMC3K, bytes).await;
    let (_run, sig) = process_and_wait(
        &server,
        &admin,
        &pool,
        dataset_id,
        json!({
            "language": "python",
            "code_ref": "compute/cell-filter.py",
            // A threshold the fixture bites on: a `{}` params run keeps all 2700
            // cells, a params-honoring run keeps strictly fewer.
            "params": { "thresholds": [{ "metric": "total_counts", "min": 1500 }], "seed": 0 }
        }),
    )
    .await;

    // Read the run's OWN filter-report out of the content-addressed store.
    let (_, hash) = sig
        .iter()
        .find(|(id, _)| id == "filter-report")
        .unwrap_or_else(|| panic!("cell-filter emits `filter-report` — got {sig:?}"));
    let raw = server_store(&server)
        .get(&workstore_key(hash))
        .await
        .expect("read filter-report blob");
    let report: Value = serde_json::from_slice(&raw).expect("filter-report is json");

    // 1. The CRITERIA crossed the sandbox boundary (this is the bind).
    let thresholds = report["thresholds"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        thresholds.len(),
        1,
        "the run's thresholds reached /inputs/params.json — report={report}"
    );
    assert_eq!(thresholds[0]["metric"], json!("total_counts"));
    assert_eq!(thresholds[0]["min"].as_f64(), Some(1500.0));

    // 2. They were LOAD-BEARING: the committed artifact really is a subset.
    let n_in = report["n_cells_in"].as_i64().expect("n_cells_in");
    let n_out = report["n_cells_out"].as_i64().expect("n_cells_out");
    assert!(n_in > 0, "the fixture has cells — report={report}");
    assert!(
        n_out < n_in,
        "a params-honoring run removes cells (K={n_out} of N={n_in}); an all-keep \
         mask means /inputs/params.json was never mounted — report={report}"
    );
    eprintln!("cell-filter params-mount proof: K={n_out} of N={n_in}, thresholds={thresholds:?}");
}

/// A catalog `content_hash` → the workstore key (stored with or without prefix).
fn workstore_key(content_hash: &str) -> ContentKey {
    if content_hash.starts_with("sha256:") {
        ContentKey::parse(content_hash)
    } else {
        ContentKey::from_hex(content_hash)
    }
}

// ── cellranger: honestly scoped ──────────────────────────────────────────────
// A full `cellranger count` run needs (a) the `cellranger` binary in the rootfs and
// (b) the ~10 GB `refdata-gex-GRCh38-2024-A` reference genome bound RO at /refdata —
// neither is feasible in an integration test. The WIRING that this round fixed is
// covered without the genome:
//   * registry resolution + the DECLARED host-resource requirement (S7) —
//     `sandbox::processors::host_resources_come_from_the_declaration_not_from_the_server`.
//   * the runner emits the allowlisted RO mount at the DECLARED path and refuses
//     (clear error) when unconfigured — `jobs::runner::
//     a_declared_host_resource_refuses_without_config_and_binds_when_allowlisted`.
// A full cellranger run is an operator/ops validation (documented in STATUS.md), not
// a CI/integration test.
