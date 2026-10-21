//! **TEST-33** [acceptance] [invariant: INV-9] [covers: ITEM-20] — the `qc.10x`
//! sibling of `TEST-EXPORT-REPLAY`: the FIRST time the executable-capsule harness
//! is pointed at the first analysis a user actually runs.
//!
//! A REAL `qc.10x` run on the pbmc3k fixture is recorded, exported as an RO-Crate
//! bundle, and its capsule is EXECUTED through
//! `hardening_common::reproduce_capsule()` (staged CAS inputs + the pulled code
//! blob + the capsule-regenerated `/inputs/{inputs,params}.json` + each
//! `environments.json` rootfs provisioned from the running server). Then
//! `assert_reproduced()` must hold for EVERY output in the recorded signature —
//! the declared per-cell metric COLUMNS plus the QC report (`qc.10x` is
//! ANNOTATE-ONLY per DEC-13: NO filtered `expression` matrix; see the note at the
//! signature assertion below) — hash-for-hash.
//!
//! **The params must be ones the processor actually READS.** The run drives a
//! RESTRICTED `qc_metrics` set — one metric where the default is four — which is
//! the whole point: `qc-10x.py`'s real param vocabulary is
//! `fileType`/`assay`/`qc_metrics` (`packages/qc/manifest.yaml`), and a capsule
//! that regenerates `/inputs/params.json` WITHOUT the scientific params (the G3
//! defect: `{"seed": N}` and nothing else) then replays with the DEFAULT metric
//! set and emits different bytes. Driving dead keys instead (`min_genes` /
//! `max_pct_mito` / `min_cells` / `strategy` — nowhere in the processor or its
//! manifest) made this test structurally unable to see that: dropping the whole
//! params object changed no output byte, so it stayed green while its
//! `export_replay_test` sibling went red.
//!
//! Every prior capsule-execution test pointed the harness at a synthetic inline
//! `DET_SCRIPT`, which is deterministic by construction; this one drives a real
//! scientific processor, so it is the test that can actually discover a
//! NON-deterministic analysis. A failure here is a real determinism finding about
//! `qc-10x.py`, not a harness defect — read the reported mismatch, do not soften
//! the assertion.
//!
//! ROOTFS + FIXTURE gated with a printed self-skip (the `gate()` idiom) plus the
//! pinned-env gate (`pinned_env_digest`); never the compile-time ignore attribute,
//! and a SKIP is recorded as SKIP, never as a PASS — in the SKIP LEDGER
//! (`hardening_common::record_skip`) as well as on stderr, so it survives
//! libtest's default output capture.

use std::collections::HashSet;
use std::path::Path;

use serde_json::{json, Value};

use super::hardening_common::{
    assert_capsule_steps_executed, assert_reproduced, attach_dataset, create_project, download_zip,
    export_bundle, gate, pinned_env_digest, pool_for, process_and_wait, reproduce_capsule,
    upload_fixture, PBMC3K,
};
use super::setup_admin;
use crate::common::TestServer;

/// The RESTRICTED metric set this run selects — TWO rows, where `qc-10x.py`'s default
/// (`DEFAULT_QC_METRICS`, used whenever `params.json` omits `qc_metrics`) is FOUR:
/// `total_counts` + `n_genes` + `pct_mito` + `pct_ribo`. These are params the processor
/// genuinely reads (`parse_qc_metrics`), so a capsule that regenerated
/// `/inputs/params.json` without them replays with a DIFFERENT column set and
/// different bytes — which is what makes this test able to go red on the G3 class
/// of defect at all.
///
/// Every row states its label SET and its AGGREGATION, and the emitted column is named by
/// the row VERBATIM (DEC-1). `total_counts` is what the deleted `{builtin: true}` selection
/// was: `sum` over `.*`.
fn restricted_qc_metrics() -> Value {
    json!([
        { "name": "total_counts", "pattern": ".*", "aggregation": "sum" },
        { "name": "pct_mito", "pattern": "^MT-|^mt-", "aggregation": "percentage" },
    ])
}

/// The metric columns the restricted set must emit, and the ones the DEFAULT set
/// would add — the discriminator between "the capsule carried the params" and
/// "the capsule replayed with defaults".
const SELECTED_COLUMNS: [&str; 2] = ["total_counts", "pct_mito"];
const DEFAULT_ONLY_COLUMNS: [&str; 2] = ["n_genes", "pct_ribo"];

/// The output ids the REPLAY actually emitted, read out of the capsule's own
/// regenerated `work/NN/outputs/manifest.json` — what the capsule's run produced,
/// never what the test expects.
fn replayed_output_ids(dir: &Path) -> HashSet<String> {
    fn walk(d: &Path, out: &mut HashSet<String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.file_name().and_then(|n| n.to_str()) == Some("manifest.json") {
                let Ok(bytes) = std::fs::read(&p) else {
                    continue;
                };
                let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
                    continue;
                };
                for o in v["outputs"].as_array().into_iter().flatten() {
                    if let Some(id) = o["id"].as_str() {
                        out.insert(id.to_string());
                    }
                }
            }
        }
    }
    let mut out = HashSet::new();
    walk(&dir.join("work"), &mut out);
    out
}

#[tokio::test]
async fn exported_capsule_reproduces_a_real_qc_10x_run() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = gate(
        &server,
        &admin,
        "exported_capsule_reproduces_a_real_qc_10x_run",
    )
    .await
    else {
        return;
    };
    let pool = pool_for(&server).await;

    // A project + the REAL pbmc3k fixture, so the dataset-scoped run lands in the
    // project's export closure.
    let project = create_project(&server, &admin, "qc capsule project").await;
    let dataset_id = upload_fixture(&server, &admin, PBMC3K, bytes).await;
    attach_dataset(&server, &admin, project, dataset_id).await;

    // ── the REAL qc.10x run, through the product path ────────────────────────
    let (run_id, signature) = process_and_wait(
        &server,
        &admin,
        &pool,
        dataset_id,
        json!({
            "language": "python",
            "code_ref": "compute/qc-10x.py",
            // Params `qc-10x.py` genuinely READS (`fileType` + `qc_metrics`); the
            // restricted metric set is the discriminator — see
            // `restricted_qc_metrics`.
            "params": {
                "fileType": "h5ad",
                "qc_metrics": restricted_qc_metrics(),
            },
        }),
    )
    .await;
    assert!(
        !signature.is_empty(),
        "the qc.10x run cataloged its outputs"
    );

    // The signature must contain the real scientific outputs — otherwise
    // `assert_reproduced` would be vacuously satisfiable by a run that emitted
    // nothing of substance. `qc.10x` is ANNOTATE-ONLY (DEC-13,
    // `packages/qc/manifest.yaml`: `produces: [metadata-column, report/qc]`,
    // "NO filtered matrix"), so the substance is the declared per-cell metric
    // COLUMNS plus the QC report — NOT a filtered `expression` matrix. (TESTS.md's
    // TEST-33 text says "including the `expression` output"; that predates DEC-13
    // and is corrected here against the manifest, which is the contract.)
    //
    // …and the run emitted EXACTLY the metrics its params selected: the two
    // default-only columns must be ABSENT, which is what proves the params reached
    // the processor in the first place (so the same check on the REPLAY below is
    // measuring params carriage, not a processor default).
    let ids: HashSet<&str> = signature.iter().map(|(id, _)| id.as_str()).collect();
    for metric in SELECTED_COLUMNS {
        assert!(
            ids.contains(format!("metadata-column:{metric}").as_str()),
            "the recorded signature includes the SELECTED per-cell metric column \
             `{metric}` — got {ids:?}"
        );
    }
    for metric in DEFAULT_ONLY_COLUMNS {
        assert!(
            !ids.contains(format!("metadata-column:{metric}").as_str()),
            "the original run honored its `qc_metrics` params: `{metric}` is in the processor's \
             DEFAULT set but was NOT selected, so it must not be emitted — got {ids:?}"
        );
    }
    assert!(
        ids.iter()
            .any(|id| id.starts_with("report") || id.starts_with("qc")),
        "the recorded signature includes the QC report/density output — got {ids:?}"
    );
    eprintln!(
        "[qc-capsule] original run {run_id} cataloged {} outputs: {:?}",
        signature.len(),
        signature
    );

    // ── the SECOND gate: can a capsule EXECUTE here at all? ──────────────────
    // The digest is KEPT: it is what `assert_capsule_steps_executed` proves the
    // capsule's steps actually ran in.
    let Some(env_digest) = pinned_env_digest(
        &pool,
        run_id,
        "exported_capsule_reproduces_a_real_qc_10x_run",
    )
    .await
    else {
        return;
    };

    // ── export → EXECUTE the capsule ─────────────────────────────────────────
    let export_id = export_bundle(&server, &admin, project, Some(run_id), "single").await;
    let zip = download_zip(&server, &admin, &export_id).await;
    let (dir, out) = reproduce_capsule(&server, &admin, &zip, "qc-replay").await;
    assert!(
        out.status.success(),
        "the capsule run.sh executed successfully: status={:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    // The steps really ran inside the pinned rootfs (a step that is NOT executed
    // exits 0 too — this is what stops that from reading as a PASS). Shared +
    // structural, so a reword of the producer's message cannot make it vacuous.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_capsule_steps_executed(&stdout, &env_digest, "qc-replay");

    // ── (b) PARAMS CARRIAGE — the discriminating assertion ───────────────────
    // `assert_reproduced` below checks only that the recorded hashes REAPPEAR, and
    // it is asserted on top. This one names the SCIENTIFIC failure directly: a
    // capsule that regenerated `/inputs/params.json` without the run's params (the
    // G3 defect — `{"seed": N}` and nothing else) replays with the processor's
    // DEFAULT four-metric set, so the default-only columns show up in the replay's
    // own manifest. Asserted FIRST so a RED run says "the capsule dropped the
    // params" rather than reporting an opaque hash mismatch.
    let replayed = replayed_output_ids(&dir);
    assert!(
        !replayed.is_empty(),
        "the capsule replay wrote an outputs manifest\n--- stdout ---\n{stdout}"
    );
    for metric in SELECTED_COLUMNS {
        assert!(
            replayed.contains(&format!("metadata-column:{metric}")),
            "the REPLAY emitted the selected metric column `{metric}` — got {replayed:?}"
        );
    }
    for metric in DEFAULT_ONLY_COLUMNS {
        assert!(
            !replayed.contains(&format!("metadata-column:{metric}")),
            "REGRESSION (G3): the replay emitted `{metric}`, which is in `qc-10x.py`'s DEFAULT \
             metric set but was NOT selected by this run's `qc_metrics` — the exported \
             /inputs/params.json dropped the run's scientific params, so the capsule re-ran QC \
             with defaults. Replay emitted {replayed:?}"
        );
    }

    // ── (a) hash-for-hash over the FULL recorded signature, retained ─────────
    assert_reproduced(&dir, &signature).await;
}
