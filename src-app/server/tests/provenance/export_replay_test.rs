//! **TEST-EXPORT-REPLAY** [acceptance] [invariant: INV-1, INV-9]
//! [covers: ITEM-1, ITEM-2, ITEM-3, ITEM-19] — the un-gameable acceptance test for
//! G3: *the exported capsule must carry the run's real scientific params.*
//!
//! A REAL `cell.filter` run whose criteria keep a STRICT SUBSET (K of N true,
//! `0 < K < N`) on the pbmc3k fixture is exported as an RO-Crate bundle, and the
//! bundle is EXECUTED through the EXISTING capsule harness
//! (`hardening_common::reproduce_capsule` — staged CAS inputs + the pulled code
//! blob + the capsule-regenerated `/inputs/{inputs,params}.json` + each
//! `environments.json` rootfs provisioned from the running server). Then BOTH:
//!
//!   (b) the STRICTER scientific assertion — the replayed keep-mask column
//!       has EXACTLY K true values and is element-wise equal to the original,
//!       with the negative control that the replayed count is **NOT** N
//!       (all-true); and
//!   (a) `assert_reproduced()` — every original output `content_hash` reappears
//!       among what the capsule regenerated, hash-for-hash.
//!
//! (b) is retained ON TOP of (a) and is NOT replaced by it: `assert_reproduced`
//! only checks that recorded hashes REAPPEAR, so it could not have caught the
//! all-true regression had the keep-mask column been absent from the run's
//! recorded signature. (b) is asserted FIRST purely so a RED run reports the
//! SCIENTIFIC failure ("replayed N of N — the predicate was dropped") rather
//! than an opaque hash mismatch.
//!
//! **RED on the base commit `9b479e73`**: `reproduce_script.rs::render_step`
//! regenerated `/inputs/params.json` as `printf '%s\n' '{ "seed": N }'` — the
//! seed and NOTHING else. Replaying therefore re-ran `cell.filter` with no
//! `criteria`, the mask logic yielded all-true, and the capsule produced a
//! silently DIFFERENT result that looked successful. That is precisely the
//! negative control below.
//!
//! ROOTFS + FIXTURE gated with a printed self-skip (the
//! `hardening_common::gate()` idiom), never the compile-time ignore attribute; a
//! SKIP is recorded as SKIP, never a PASS — and the skip is written to the SKIP
//! LEDGER (`hardening_common::record_skip`, `target/test-skip-ledger.tsv`) so it
//! can be counted without `--nocapture`, which libtest's default capture would
//! otherwise hide.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::common::zarr;
use crate::common::TestServer;

use super::setup_admin;
use crate::dataset::hardening_common::{
    assert_capsule_steps_executed, assert_reproduced, attach_dataset, create_project, download_zip,
    export_bundle, gate, pinned_env_digest, pool_for, process_and_wait, reproduce_capsule,
    server_store, upload_fixture, PBMC3K,
};

/// The run LABEL → since the filter package 0.9.0 the committed column IS this string,
/// verbatim (no `keep_` prefix, no slug). A DISTINCT, non-empty label still matters, and
/// for a sharper reason than before: the label is what the capsule has to carry, and a
/// params-less replay now has NO label at all — `mask_column_name` refuses a blank one, so
/// such a capsule fails outright instead of quietly committing the old `keep_all`.
const LABEL: &str = "subset";

/// The criteria recipe: keep only cells with `total_counts >= 1500`. `total_counts`
/// is computed on the fly by `cell-filter.py` when absent, and on pbmc3k this keeps
/// a strict subset (asserted, not assumed).
fn subset_criteria() -> Value {
    json!([{ "column": "total_counts", "min": 1500 }])
}

/// Decode a keep-mask artifact → its values.
///
/// The artifact is a STORE, not a document: ITEM-25/26/27 moved `write_keep_mask` onto
/// the shared output adapter, so what used to be one JSON blob carrying
/// `{name, n, values:[bool]}` is now a directory of metadata + a compressed member.
/// This file did not move with it and kept parsing the blob, which is why it panicked
/// on the FIRST read and never reached the replay comparison it exists for. The
/// declared length is checked against the decoded member, so a store that decodes
/// short fails here rather than silently shortening the comparison.
fn parse_keep_mask(store: &zarr::Store, what: &str) -> Vec<bool> {
    let declared = zarr::declaration(store);
    let values = zarr::read_bools(store, zarr::VALUES);
    let n = declared["n"].as_u64().unwrap_or_default() as usize;
    assert_eq!(
        n,
        values.len(),
        "{what}: the declared length matches the decoded member"
    );
    values
}

/// Every regenerated keep-mask the replay DECLARED, as
/// `(store path, declared name, store)` — read out of the `outputs/manifest.json` each
/// step wrote, so the NAME is the producer's own declaration rather than something
/// inferred from a path. (It is NOT inside the store: the writer's member is called
/// `values` for every column, and the label rides the manifest entry into the artifact
/// row's `meta`.)
fn replayed_keep_masks(dir: &Path) -> Vec<(PathBuf, String, zarr::Store)> {
    fn walk(d: &Path, out: &mut Vec<(PathBuf, String, zarr::Store)>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
                continue;
            }
            if p.file_name().and_then(|n| n.to_str()) != Some("manifest.json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&p) else {
                continue;
            };
            let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            for entry in v["outputs"].as_array().into_iter().flatten() {
                let name = entry["meta"]["name"].as_str().unwrap_or_default();
                let Some(rel) = entry["path"].as_str() else {
                    continue;
                };
                let store_dir = p.parent().unwrap_or(&p).join(rel);
                // Selected by SHAPE, not by a name prefix: the committed column is named
                // by the user now, so prefix matching would find nothing. A step's other
                // output is a JSON report, which is a file rather than a store directory —
                // so "declares a name AND is a store" already selects exactly the columns,
                // and the caller asserts how many it expected.
                if !name.is_empty() && store_dir.join("zarr.json").is_file() {
                    let store = zarr::load_dir(&store_dir);
                    out.push((store_dir, name.to_string(), store));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&dir.join("work"), &mut out);
    out
}

/// A flat listing of the capsule's step working dirs — the diagnostic that makes a
/// "no mask produced" failure legible (which step ran, what it wrote) instead of an
/// opaque empty vec.
fn work_tree(dir: &Path) -> String {
    fn walk(d: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, root, out);
            } else {
                let rel = p.strip_prefix(root).unwrap_or(&p).display().to_string();
                let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                out.push(format!("  {rel} ({len} bytes)"));
            }
        }
    }
    let mut out = Vec::new();
    walk(&dir.join("work"), dir, &mut out);
    if out.is_empty() {
        return "  (no work/ output files at all)".to_string();
    }
    out.join("\n")
}

/// The ORIGINAL run's committed keep-mask, as `(output id, declared name, store)`.
///
/// The bytes come out of the server's own content-addressed blob store by the
/// artifact's `object_key` — which now addresses the member MANIFEST of a store rather
/// than a single blob — and the NAME out of the row's `meta`, the producer declaration
/// ingest carries through verbatim.
async fn original_keep_mask(
    server: &TestServer,
    pool: &PgPool,
    run_id: Uuid,
) -> (String, String, zarr::Store) {
    let rows: Vec<(String, String, Value)> = sqlx::query_as(
        "SELECT output_id, object_key, meta FROM artifacts WHERE run_id = $1 ORDER BY output_id",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .expect("run artifacts");
    let (output_id, object_key, meta) = rows
        .into_iter()
        .find(|(id, ..)| id.starts_with("metadata-column:"))
        .unwrap_or_else(|| panic!("the run committed a metadata-column artifact"));
    let name = meta["name"]
        .as_str()
        .unwrap_or_else(|| panic!("the committed artifact declares a name: {meta}"))
        .to_string();
    let store = zarr::load_artifact(&server_store(server), &object_key).await;
    (output_id, name, store)
}

#[tokio::test]
async fn exported_capsule_replays_the_real_filter_predicate() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(bytes) = gate(&server, &admin, "exported_capsule_replays_the_real_filter_predicate").await
    else {
        return;
    };
    let pool = pool_for(&server).await;

    // A project + the REAL pbmc3k fixture attached to it, so the dataset-scoped
    // processing run lands in the project's export closure.
    let project = create_project(&server, &admin, "filter replay project").await;
    let dataset_id = upload_fixture(&server, &admin, PBMC3K, bytes).await;
    attach_dataset(&server, &admin, project, dataset_id).await;

    // ── the REAL cell.filter run, through the product path ────────────────────
    let (run_id, signature) = process_and_wait(
        &server,
        &admin,
        &pool,
        dataset_id,
        json!({
            "language": "python",
            "code_ref": "compute/cell-filter.py",
            "params": { "criteria": subset_criteria(), "label": LABEL, "seed": 0 },
        }),
    )
    .await;
    assert!(!signature.is_empty(), "the filter run cataloged its outputs");

    let (output_id, orig_col, original) = original_keep_mask(&server, &pool, run_id).await;
    let orig_values = parse_keep_mask(&original, "the original keep-mask");
    let n = orig_values.len();
    let k = orig_values.iter().filter(|v| **v).count();

    // The precondition the whole test rests on: the predicate keeps a STRICT
    // SUBSET. Without it, "all-true" and "correct" are indistinguishable.
    assert!(n > 0, "the fixture has cells (got n={n})");
    assert!(
        0 < k && k < n,
        "the criteria must keep a STRICT SUBSET so all-true is distinguishable — got K={k} of N={n} \
         (output {output_id}, column {orig_col})"
    );
    assert_eq!(orig_col, LABEL, "the committed column IS the label, verbatim");
    eprintln!("[export-replay] original run kept K={k} of N={n} cells in column {orig_col}");

    // ── the SECOND gate: can a capsule EXECUTE here at all? ───────────────────
    // A capsule step runs only inside the run's PINNED rootfs digest — see
    // `pinned_env_digest` for what pins one and what to set when nothing does. The
    // digest is KEPT: it is what `assert_capsule_steps_executed` proves the steps
    // actually ran in.
    let Some(env_digest) =
        pinned_env_digest(&pool, run_id, "exported_capsule_replays_the_real_filter_predicate").await
    else {
        return;
    };

    // ── export → EXECUTE the capsule ─────────────────────────────────────────
    let export_id = export_bundle(&server, &admin, project, Some(run_id), "single").await;
    let zip = download_zip(&server, &admin, &export_id).await;
    let (dir, out) = reproduce_capsule(&server, &admin, &zip, "filter-replay").await;
    assert!(
        out.status.success(),
        "the capsule run.sh executed successfully: status={:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    // A step that is NOT executed (no pinned environment / no captured code) exits
    // 0 too — assert STRUCTURALLY that every announced step really ran inside the
    // run's pinned rootfs, so an unexecuted capsule can never read as a PASS. The
    // guard is shared (`hardening_common`) and positive, so a reword of the
    // producer's message cannot silently make it vacuous.
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_capsule_steps_executed(&stdout, &env_digest, "filter-replay");

    // ── (b) the STRICTER scientific assertion ────────────────────────────────
    let masks = replayed_keep_masks(&dir);
    assert_eq!(
        masks.len(),
        1,
        "the replay produced exactly ONE keep-mask column; got {:?}\n--- capsule work tree ---\n{}\n--- run.sh stdout ---\n{}\n--- run.sh stderr ---\n{}",
        masks.iter().map(|(p, ..)| p.display().to_string()).collect::<Vec<_>>(),
        work_tree(&dir),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let (mask_path, replay_col, mask_store) = &masks[0];
    let replay_values = parse_keep_mask(mask_store, "the replayed keep-mask");
    let replay_k = replay_values.iter().filter(|v| **v).count();

    // The negative control — this is EXACTLY what a params-less capsule produces.
    assert_ne!(
        replay_k, n,
        "REGRESSION (G3): the replayed keep-mask is ALL-TRUE ({replay_k} of {n} kept) — the capsule \
         re-ran cell.filter with NO criteria, i.e. the exported /inputs/params.json dropped the \
         predicate. Original kept K={k} of N={n}. Mask at {}",
        mask_path.display()
    );
    assert_eq!(
        replay_col.as_str(), LABEL,
        "the replayed column IS the run's LABEL, verbatim — the capsule carried the label through \
         (a params-less replay has none at all, and `mask_column_name` refuses a blank one)"
    );
    assert_eq!(
        replay_values.len(),
        n,
        "the replayed mask is obs-aligned over all {n} input cells"
    );
    assert_eq!(
        replay_k, k,
        "the replayed keep-mask keeps EXACTLY K={k} of N={n} cells — got {replay_k}"
    );
    assert_eq!(
        replay_values, orig_values,
        "the replayed keep-mask is ELEMENT-WISE equal to the original (same cells kept, not just \
         the same count)"
    );

    // ── (a) hash-for-hash, retained (NOT replaced by (b)) ────────────────────
    assert_reproduced(&dir, &signature).await;
}
