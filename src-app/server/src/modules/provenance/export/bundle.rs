//! Export bundle assembler (ITEM-19 / DEC-9). Builds a downloadable BagIt-RO
//! `.zip` under a per-export temp dir with a RAII cleanup guard (removed on every
//! exit path), keyed by an `export_id` in a process-local store. Over-cap objects
//! become a `fetch.txt` hole (per the `export_bundle_max_bytes` setting).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::provenance::graph::{WalkArtifact, WalkRun};
use crate::modules::provenance::models::UsedEdgeDto;
use crate::modules::provenance::repository::ProvenanceRepository;
use crate::modules::workstore::catalog::models::Artifact;
use crate::modules::workstore::object_store::{sha256_hex, ContentKey};

use super::{manifest, methods, reproduce_script, scope};

/// A built bundle held for download (ownership-scoped by `project_id`).
#[derive(Debug, Clone)]
pub struct ExportRecord {
    pub project_id: Uuid,
    pub bytes: Vec<u8>,
}

/// Cap on the number of built bundles held in memory at once. Bundles hold full
/// zip bytes, so an unbounded map is a memory-DoS vector; the oldest is
/// FIFO-evicted on insert and a served bundle is removed on download.
const MAX_EXPORTS: usize = 8;

/// A bounded, FIFO-evicting store of built bundles.
#[derive(Default)]
struct ExportStore {
    map: HashMap<Uuid, ExportRecord>,
    order: VecDeque<Uuid>,
}

/// Process-local export store. Bundles are transient (removed on download);
/// `export_retention_days` governs on-disk retention in a future slice.
static EXPORTS: OnceLock<Mutex<ExportStore>> = OnceLock::new();

fn exports() -> &'static Mutex<ExportStore> {
    EXPORTS.get_or_init(|| Mutex::new(ExportStore::default()))
}

/// Insert a built bundle, FIFO-evicting the oldest to stay within `MAX_EXPORTS`.
fn store_bundle(export_id: Uuid, record: ExportRecord) {
    let mut s = exports().lock().unwrap_or_else(|p| p.into_inner());
    while s.order.len() >= MAX_EXPORTS {
        match s.order.pop_front() {
            Some(oldest) => {
                s.map.remove(&oldest);
            }
            None => break,
        }
    }
    s.order.push_back(export_id);
    s.map.insert(export_id, record);
}

/// Fetch a built bundle by id (for the download route). Peek — does not remove;
/// the handler calls [`remove_bundle`] once ownership is authorized.
pub fn read_bundle(export_id: Uuid) -> Option<ExportRecord> {
    exports()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .map
        .get(&export_id)
        .cloned()
}

/// Remove a bundle from the store (a successful, authorized download consumes it).
pub fn remove_bundle(export_id: Uuid) {
    let mut s = exports().lock().unwrap_or_else(|p| p.into_inner());
    s.map.remove(&export_id);
    if let Some(pos) = s.order.iter().position(|&x| x == export_id) {
        s.order.remove(pos);
    }
}

/// RAII temp-dir guard — removed on every exit path (success/error/panic).
struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Build a reproducibility bundle for a scope and stash it under a fresh
/// `export_id`. Returns the id for the download route.
pub async fn build_bundle(
    pool: &PgPool,
    project_id: Uuid,
    target: Option<Uuid>,
    scope_str: &str,
    caller_id: Uuid,
    group_ids: &[Uuid],
) -> Result<Uuid, AppError> {
    let settings = super::super::settings_cache::get(pool).await;
    let cap: u64 = settings.export_bundle_max_bytes.max(0) as u64;

    let repo = ProvenanceRepository::new(pool.clone());
    // Load the project's node set + fold in its attached datasets' owner-scoped
    // processing lineage + dataset graph nodes (ITEM-20), so a dataset-rooted
    // chain's runs/artifacts/roots are all in the closure. Datasets the caller
    // cannot see are filtered out of the fold (cross-user over-disclosure guard).
    let ctx =
        super::super::graph::load_project_walk_context(pool, project_id, caller_id, group_ids).await?;
    let artifacts = &ctx.artifacts;

    // Build the walk inputs (datasets included as content-hashed nodes) + resolve.
    let walk_runs: Vec<WalkRun> = ctx.walk_runs();
    let walk_artifacts: Vec<WalkArtifact> = ctx.walk_artifacts();
    let all_run_ids: Vec<Uuid> = ctx.runs.iter().map(|r| r.run_id).collect();
    let export_scope = scope::parse_scope(scope_str, target)?;
    let subdag = scope::resolve(&export_scope, &all_run_ids, &walk_runs, &walk_artifacts);

    // Artifact lookup by content hash (first wins).
    let mut by_hash: HashMap<&str, &Artifact> = HashMap::new();
    for a in artifacts {
        by_hash.entry(a.content_hash.as_str()).or_insert(a);
    }
    // Dataset lookup by content hash — a carried root hash that is a DATASET (not a
    // workstore artifact) has its ziee-file bytes fetched into `data/<hash>` (ITEM-21).
    let mut dataset_by_hash: HashMap<&str, &super::super::graph::DatasetNode> = HashMap::new();
    for d in &ctx.dataset_nodes {
        dataset_by_hash.entry(d.content_hash.as_str()).or_insert(d);
    }
    // Which run produced which output hashes (for the manifest/scripts).
    let mut outputs_by_run: HashMap<Uuid, Vec<String>> = HashMap::new();
    for a in artifacts {
        if let Some(rid) = a.run_id {
            if subdag.carried_hashes.contains(&a.content_hash) {
                outputs_by_run.entry(rid).or_default().push(a.content_hash.clone());
            }
        }
    }

    // ROUND-4 (R3-24): carried hashes belonging to MULTIFILE artifacts — their
    // recorded `content_hash` is a merkle root over a directory, not any file's
    // sha256, so `verify_outputs.sh` must not compare them per file.
    let multifile_hashes: std::collections::HashSet<String> = artifacts
        .iter()
        .filter(|a| a.is_multifile && subdag.carried_hashes.contains(&a.content_hash))
        .map(|a| a.content_hash.clone())
        .collect();

    // Included runs (sub-DAG).
    let included: Vec<_> = ctx
        .runs
        .iter()
        .filter(|r| subdag.runs.contains(&r.run_id))
        .collect();

    // RunSpecs for the reproduce script — thread the per-run environment
    // (`env_rootfs_sha256`), language, arch, seed, and the original input subpaths
    // (from the stashed re-run spec) so `run.sh` runs each step INSIDE its pinned
    // rootfs at the same bind paths (ITEM-22).
    let mut run_specs: Vec<reproduce_script::RunSpec> = Vec::with_capacity(included.len());
    // **ITEM-7/ITEM-8 (DEC-9)** — the SCIENTIFIC params to narrate per run, resolved
    // once here (promoted column first, re-run spec second) and reused by BOTH the
    // manifest's `FormalParameter`s and the methods prose below.
    let mut science_by_run: HashMap<Uuid, serde_json::Value> = HashMap::new();
    for r in included.iter().copied() {
        // ITEM-6: the re-run spec rides the widened `RunReproRow` the walk already
        // loaded, so the export no longer issues a per-run `get_rerun_spec` (an N+1
        // over the exported closure).
        let rerun = r.rerun_spec_json.clone();
        let language = run_language(r, &rerun);
        science_by_run.insert(r.run_id, science_params(&r.params, &rerun));
        // ROUND-19 (R19-03): read off the SAME already-fetched spec — no new query.
        let staged_shared_helpers = run_staged_shared_helpers(&language, &rerun);
        run_specs.push(reproduce_script::RunSpec {
            run_id: r.run_id,
            kind: r.kind.clone(),
            code_sha256: r.code_sha256.clone(),
            inputs: parse_inputs(&r.inputs_json),
            output_hashes: outputs_by_run.get(&r.run_id).cloned().unwrap_or_default(),
            language,
            env_rootfs_sha256: r.env_rootfs_sha256.clone(),
            arch: run_arch(r),
            seed: r.seed,
            input_subpaths: input_subpaths_from_rerun(&rerun),
            // ITEM-2: the scientific params ride the SAME already-fetched spec.
            params: params_from_rerun(&rerun),
            staged_shared_helpers,
        });
    }
    let repro = reproduce_script::build(&run_specs, 0);

    // Methods + manifest (topological order).
    let order = reproduce_script::topo_order(&run_specs);
    let by_id: HashMap<Uuid, &reproduce_script::RunSpec> =
        run_specs.iter().map(|s| (s.run_id, s)).collect();
    let included_by_id: HashMap<Uuid, &super::super::repository::RunReproRow> =
        included.iter().map(|r| (r.run_id, *r)).collect();

    let method_runs: Vec<methods::MethodRun> = order
        .iter()
        .filter_map(|id| included_by_id.get(id))
        .map(|r| methods::MethodRun {
            kind: r.kind.clone(),
            generator_id: r.generator_id.clone(),
            generator_version: r.generator_version.clone(),
            seed: r.seed,
            // ITEM-8 (DEC-9): the SCIENTIFIC params (promoted column, else the
            // re-run spec for a pre-promotion run) — never `language`/`arch`.
            params: science_by_run.get(&r.run_id).cloned().unwrap_or_else(|| serde_json::json!({})),
            // F2-15: an allow-list slot intersects into an analysis' result and is
            // recorded ONLY as a used edge — the prose must name the slot or it
            // describes a laxer method than the one that ran.
            input_slots: by_id
                .get(&r.run_id)
                .map(|s| s.inputs.iter().map(|e| e.slot.clone()).collect())
                .unwrap_or_default(),
            // ITEM-20: the slots this run consumed that NOBODY chose. Matched on the
            // exact recorded string, so an unstated origin (`None`, which is every run
            // predating this change) contributes nothing — the prose stays silent
            // rather than claiming a review that never happened (DEC-7).
            auto_bound_slots: by_id
                .get(&r.run_id)
                .map(|s| {
                    s.inputs
                        .iter()
                        .filter(|e| e.bound_by.as_deref() == Some("auto"))
                        .map(|e| e.slot.clone())
                        .collect()
                })
                .unwrap_or_default(),
            // S3: the narration is DECLARED by the analysis' own package
            // (`contributes.analyses[<generator_id>].methods`), resolved here so
            // `methods_text` stays pure. `None` ⇒ the generic sentence.
            narration: crate::modules::extensions::methods_narration_for(&r.generator_id),
            // #77: the rootfs digest is already loaded on this row (it is what
            // `reproduce_script::RunSpec` hands `ensure_env`), and it was the one field
            // the methods text asserted was shipped without ever printing. Reusing the
            // already-fetched row means no new query.
            env_rootfs_sha256: r.env_rootfs_sha256.clone(),
        })
        .collect();
    let methods_md = methods::methods_text(&method_runs);

    let manifest_runs: Vec<manifest::ManifestRun> = order
        .iter()
        .filter_map(|id| by_id.get(id).map(|s| (id, s)))
        .filter_map(|(id, s)| included_by_id.get(id).map(|r| (r, s)))
        .map(|(r, s)| manifest::ManifestRun {
            run_id: s.run_id,
            kind: s.kind.clone(),
            generator_id: r.generator_id.clone(),
            // ITEM-7 (DEC-9): same resolved SCIENTIFIC params the prose narrates, so
            // an exported crate documents what was filtered on — not `language`/`arch`.
            params: science_by_run.get(&r.run_id).cloned().unwrap_or_else(|| serde_json::json!({})),
            input_hashes: s.inputs.iter().map(|e| e.content_hash.clone()).collect(),
            output_hashes: s.output_hashes.clone(),
        })
        .collect();
    let mut manifest_roots: Vec<manifest::ManifestRoot> = artifacts
        .iter()
        .filter(|a| a.run_id.is_none() && subdag.carried_hashes.contains(&a.content_hash))
        .map(|a| manifest::ManifestRoot {
            content_hash: a.content_hash.clone(),
            datatype: a.datatype.clone(),
        })
        .collect();
    // Dataset roots (uploaded datasets in the closure) are graph roots too (ITEM-20).
    manifest_roots.extend(
        ctx.dataset_nodes
            .iter()
            .filter(|d| d.run_id.is_none() && subdag.carried_hashes.contains(&d.content_hash))
            .map(|d| manifest::ManifestRoot {
                content_hash: d.content_hash.clone(),
                datatype: d.datatype.clone().unwrap_or_else(|| "dataset".to_string()),
            }),
    );
    // Fold in reproducibility-verification claims (ITEM-14): the latest terminal
    // verification per included run, fetched in ONE batched query (no N+1). Its
    // certificate is written verbatim as a bundle member so the claim is
    // inspectable + machine-readable.
    let included_run_ids: Vec<Uuid> = included.iter().map(|r| r.run_id).collect();
    let latest = repo.latest_verifications_for_runs(&included_run_ids).await?;
    let mut manifest_verifications: Vec<manifest::ManifestVerification> = Vec::new();
    let mut verification_certs: Vec<serde_json::Value> = Vec::new();
    for r in &included {
        if let Some(v) = latest.get(&r.run_id) {
            let verified_at = v.verified_at.map(|t| t.to_rfc3339());
            // Prefer the claim stored on the certificate (it already reflects the
            // env-changed caveat); fall back to a rebuilt line if absent.
            let claim = v
                .cert_json
                .as_ref()
                .and_then(|c| c.get("claim"))
                .and_then(|c| c.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    super::super::verify::certificate::claim_line(
                        &v.status,
                        v.rootfs_digest.as_deref(),
                        false,
                        verified_at.as_deref().unwrap_or("an unknown time"),
                    )
                });
            manifest_verifications.push(manifest::ManifestVerification {
                run_id: v.target_run_id,
                status: v.status.clone(),
                tolerance_mode: v.tolerance_mode.clone(),
                rootfs_digest: v.rootfs_digest.clone(),
                verified_at,
                claim,
            });
            if let Some(cert) = v.cert_json.clone() {
                verification_certs.push(cert);
            }
        }
    }

    let manifest_json =
        manifest::build_manifest(&manifest_runs, &manifest_roots, &manifest_verifications);
    let manifest_bytes = serde_json::to_vec_pretty(&manifest_json)
        .map_err(|e| AppError::internal_error(format!("serialize manifest: {e}")))?;

    // ---- stage members under a RAII temp dir ----
    let staging_root = std::env::temp_dir().join(format!("prov-export-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| AppError::internal_error(format!("mkdir export staging: {e}")))?;
    let _guard = TempDir(staging_root.clone());

    let mut members: Vec<(String, Vec<u8>)> = Vec::new();

    // data/ — carried artifact bytes from P1's object store; over-cap → fetch.txt.
    let mut fetch_txt = String::new();
    let mut used_bytes: u64 = 0;
    // ROUND-4b (R4B-01) — the staging loop's BYTE LEDGER.
    //
    // Round 4 closed ONE way a root can end up with no bytes (an unknown source) by
    // threading a bespoke `unsourced_roots` list into the readiness verdict. Every
    // OTHER hole in this loop stayed open: an object-store read error, a dataset file
    // row that is gone, a size-stat failure, an over-cap or multi-file deferral, or no
    // object store configured at all each wrote a `fetch.txt` line and NO
    // `data/<hash>` member, while the verdict still shipped `ready: true` and a
    // README claiming the capsule "passes every condition" — over a capsule that
    // aborts at `stage_input`.
    //
    // So the verdict is no longer derived from an enumeration of failure MODES (which
    // is exactly what left a sibling arm open). It is derived from the OUTCOME:
    // `staged` holds every carried hash whose bytes are genuinely in this bundle, and
    // `holes` holds the reason for each one that is not. `derive_roots_without_bytes`
    // (ROUND-6/A1) folds the two, taking `holes` itself as a candidate source so a
    // recorded hole cannot be discarded by any classification.
    let mut staged: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut holes: HashMap<String, String> = HashMap::new();
    let store = crate::modules::workstore::try_get_object_store();
    for hash in &subdag.carried_hashes {
        // Bundle-relative data name — the bare-hex form `reproduce_script` and
        // `inputs.json` reference (NO `sha256:` prefix; a `:` is illegal in a zip
        // entry name on Windows). Keep these in lockstep or scripts/inputs.json
        // resolve to nonexistent files.
        let name = format!("data/{}", reproduce_script::data_filename(hash));
        if let Some(a) = by_hash.get(hash.as_str()) {
            // ITEM-16 — a GATHERED artifact has no blob to embed or to fetch. The bundle
            // already has the exact idiom for "cannot embed this, and here is why": a
            // HOLE. Using it is real handling rather than a placeholder — the export
            // stays valid and self-describing, and the reader is told what would be
            // needed. Recording a hole is also the only honest option: the bytes are
            // reproducible only by resolving the alignment against its sources, which is
            // what OQ-5 (what provenance records for a virtual input) decides.
            //
            // Deliberately NOT `continue`-with-silence and NOT a fetch.txt line: there is
            // no URL to fetch, so a fetch line would send the reader after bytes that do
            // not exist anywhere.
            let Some(a_object_key) = a.object_key.as_deref() else {
                holes.insert(
                    hash.clone(),
                    format!(
                        "artifact {} is GATHERED — it has no stored bytes and no blob to \
                         fetch. Its values are produced by resolving `structure.gathered_from` \
                         against the alignment's source datasets; recording those sources in \
                         an export is owed by OQ-5.",
                        a.id
                    ),
                );
                continue;
            };
            // A workstore artifact root/output — fetch its content-addressed blob.
            let size = a.stored_bytes.max(0) as u64;
            let over_cap = cap > 0 && (used_bytes.saturating_add(size) > cap);
            if a.is_multifile || over_cap || store.is_none() {
                fetch_txt.push_str(&format!("{name}\t{}\t{}\n", a_object_key, a.stored_bytes));
                holes.insert(
                    hash.clone(),
                    if a.is_multifile {
                        format!(
                            "a MULTI-FILE artifact — no single blob to embed; fetch \
                             {} from the object store (see fetch.txt)",
                            a_object_key
                        )
                    } else if over_cap {
                        format!(
                            "over this deployment's export size cap ({size} bytes); fetch {} \
                             from the object store (see fetch.txt)",
                            a_object_key
                        )
                    } else {
                        format!(
                            "no object store is configured in this deployment; fetch {} \
                             yourself (see fetch.txt)",
                            a_object_key
                        )
                    },
                );
                continue;
            }
            match store.as_ref().unwrap().get(&ContentKey::parse(&a_object_key)).await {
                Ok(bytes) => {
                    used_bytes = used_bytes.saturating_add(bytes.len() as u64);
                    staged.insert(hash.clone());
                    members.push((name, bytes));
                }
                Err(e) => {
                    tracing::warn!("provenance export: blob {hash} unreadable ({e}); recorded as a hole");
                    fetch_txt.push_str(&format!("{name}\t{}\t{}\n", a_object_key, a.stored_bytes));
                    // ROUND-4b (R4B-01) — THE SIBLING ARM round 4 left open: the
                    // artifact row EXISTS (so the hash is in `manifest_roots` and the
                    // old `.all(non-empty)` fold answered green) but the object store
                    // could not produce its bytes.
                    holes.insert(
                        hash.clone(),
                        format!(
                            "the object store could not read {}: {e}; fetch it yourself \
                             (see fetch.txt)",
                            a_object_key
                        ),
                    );
                }
            }
        } else if let Some(d) = dataset_by_hash.get(hash.as_str()) {
            // A DATASET root (ziee-file, ITEM-21). A single-file dataset's merkle
            // hash == its file's sha256, so `data/<hash>` holds that file's bytes.
            // A multi-file dataset's merkle root maps to no single file → a hole.
            match d.file_ids.as_slice() {
                // STAT the DB-recorded size FIRST and check the cap BEFORE reading
                // any bytes — never materialize an oversize dataset root into
                // memory (OOM guard; mirrors the workstore-artifact branch above,
                // which caps on `a.stored_bytes`).
                [file_id] => match dataset_file_size(pool, *file_id).await {
                    Ok(Some(size)) => {
                        let over_cap = cap > 0 && (used_bytes.saturating_add(size) > cap);
                        if over_cap {
                            fetch_txt.push_str(&format!("{name}\tdataset:{}\t{}\n", d.dataset_id, size));
                            holes.insert(hash.clone(), format!(
                                "over this deployment's export size cap ({size} bytes); fetch \
                                 dataset {} from ziee-file (see fetch.txt)", d.dataset_id));
                        } else {
                            match fetch_dataset_file_bytes(pool, *file_id).await {
                                Ok(bytes) => {
                                    used_bytes = used_bytes.saturating_add(bytes.len() as u64);
                                    staged.insert(hash.clone());
                                    members.push((name, bytes));
                                }
                                Err(e) => {
                                    tracing::warn!("provenance export: dataset {} bytes unreadable ({e}); recorded as a hole", d.dataset_id);
                                    fetch_txt.push_str(&format!("{name}\tdataset:{}\t?\n", d.dataset_id));
                                    holes.insert(hash.clone(), format!(
                                        "dataset {}'s file bytes could not be read: {e}",
                                        d.dataset_id));
                                }
                            }
                        }
                    }
                    Ok(None) => {
                        tracing::warn!("provenance export: dataset {} file {file_id} not found; recorded as a hole", d.dataset_id);
                        fetch_txt.push_str(&format!("{name}\tdataset:{}\t?\n", d.dataset_id));
                        holes.insert(hash.clone(), format!(
                            "dataset {}'s file record is gone, so its bytes have no source",
                            d.dataset_id));
                    }
                    Err(e) => {
                        tracing::warn!("provenance export: dataset {} size stat failed ({e}); recorded as a hole", d.dataset_id);
                        fetch_txt.push_str(&format!("{name}\tdataset:{}\t?\n", d.dataset_id));
                        holes.insert(hash.clone(), format!(
                            "dataset {}'s file size could not be read: {e}", d.dataset_id));
                    }
                },
                _ => {
                    // Multi-file (or file-less) dataset — no single-file byte source.
                    fetch_txt.push_str(&format!(
                        "{name}\tdataset:{} (multi-file — fetch each file from ziee-file)\t?\n",
                        d.dataset_id
                    ));
                    holes.insert(hash.clone(), format!(
                        "dataset {} is MULTI-FILE (or file-less), so its merkle root maps to no \
                         single blob; fetch each file from ziee-file (see fetch.txt)",
                        d.dataset_id));
                }
            }
        } else {
            // ROUND-4 (R3-22) — a carried hash with NO known source (a
            // reference-resource root, a pruned artifact, a foreign hash). It used to
            // be skipped SILENTLY: no `data/<hash>` member, no `fetch.txt` line, and —
            // because `manifest_roots` is built by filtering the walk's artifacts +
            // datasets — no entry in the very list `roots_have_provenance` folds over.
            // The bundle shipped `ready: true` and the capsule aborted at
            // `stage_input`. It is now recorded as an explicit hole — which is both
            // what the reader sees and (ROUND-6/A1) what feeds the readiness verdict.
            holes.insert(
                hash.clone(),
                "no source in this deployment — a reference-resource root, a pruned artifact, \
                 or a foreign hash; obtain the bytes and place them under data/"
                    .to_string(),
            );
            fetch_txt.push_str(&format!(
                "{name}\t(no source in this deployment — a reference-resource root or a pruned \
                 artifact; obtain the bytes for {hash} and place them here)\t?\n"
            ));
        }
    }
    if !fetch_txt.is_empty() {
        members.push(("fetch.txt".to_string(), fetch_txt.into_bytes()));
    }

    let roots_without_bytes = derive_roots_without_bytes(&manifest_roots, &holes, &staged);

    // scripts/ — per-step code blobs pulled by code_sha256 (never regenerated).
    //
    // **F2-16** — a step whose blob is ABSENT (pruned / never written / a foreign
    // hash) used to get a `# code blob <sha> not found` COMMENT that `run.sh` still
    // invoked: the capsule printed `Reproduce capsule complete.`, exited 0, and
    // produced ZERO files. A capsule that reports success having computed nothing is
    // strictly worse than one that refuses. So the substitute is now a hard-failing
    // stub in the step's own language: the step aborts the capsule (`set -e`) with a
    // message naming the run + the missing hash, the gap is recorded in
    // `PROVENANCE-GAPS.md`, and it reddens `readiness.json` → `REPRODUCING.md`.
    let mut blob_len_by_run: HashMap<Uuid, Option<usize>> = HashMap::new();
    let mut code_gaps: Vec<(Uuid, String)> = Vec::new();
    for step in &repro.steps {
        let source = match &step.code_sha256 {
            Some(sha) => {
                let blob = repo.get_code(sha).await?.map(|b| b.source).filter(|s| !s.is_empty());
                blob_len_by_run.insert(step.run_id, blob.as_ref().map(String::len));
                match blob {
                    Some(source) => source,
                    None => {
                        tracing::error!(
                            run_id = %step.run_id,
                            "provenance export: code blob {sha} is MISSING; the capsule step will \
                             hard-fail instead of silently computing nothing"
                        );
                        code_gaps.push((step.run_id, sha.clone()));
                        missing_code_stub(&step.language, step.run_id, sha)
                    }
                }
            }
            None => {
                blob_len_by_run.insert(step.run_id, None);
                "# manual step — no captured code\n".to_string()
            }
        };
        members.push((step.script_name.clone(), source.into_bytes()));
    }

    // scripts/helpers/ + readiness.json — the shared runtime modules and the verdict
    // on them, assembled by ONE function so a test can drive the whole data flow with
    // a failing reader and read the emitted member BYTES. See [`assemble_readiness`]
    // for what the members are, why a read failure is recorded rather than fatal, and
    // (ROUND-19) what it cost to have that flow inline in a `PgPool`-bound async fn.
    let assembled = assemble_readiness(
        &repro.steps,
        &crate::modules::sandbox::processors::staged_python_helpers,
        &included,
        &blob_len_by_run,
        &manifest_roots,
        &roots_without_bytes,
    )?;
    members.extend(assembled.helper_members);
    let helper_gap_reason = assembled.helper_gap_reason;
    let readiness_dto = assembled.readiness_dto;
    let readiness_gaps = assembled.readiness_gaps;
    let readiness_bytes = assembled.readiness_bytes;

    // environments.json — the distinct rootfs digests the closure needs, each with
    // its arch + placement + obtain instructions + an obtainability flag (resolved
    // via the `env_obtain` seam) so a reproducer knows which rootfs to place where
    // and the readiness check can flag a GC'd env (ITEM-22 / DEC-32).
    let env_json = reproduce_script::environments_json(&repro.environments, &|d| {
        super::super::env_obtain::obtainability().has_digest(d)
    });

    // **F2-18** — `run.sh` re-runs every step but never compared the regenerated
    // outputs to the recorded hashes, and printed a success line regardless: the
    // capsule's only verdict was "the script did not crash". `verify_outputs.sh`
    // does the comparison and is invoked as run.sh's last act, so the capsule's
    // exit status now reflects REPRODUCED / NOT REPRODUCED.
    let mut run_sh = repro.run_sh;
    run_sh.push_str(OUTPUT_VERIFICATION_TAIL);
    members.push(("run.sh".to_string(), run_sh.into_bytes()));
    members.push((
        "verify_outputs.sh".to_string(),
        verify_outputs_sh(&repro.steps, &outputs_by_run, &multifile_hashes).into_bytes(),
    ));
    members.push(("readiness.json".to_string(), readiness_bytes));
    if !code_gaps.is_empty() || helper_gap_reason.is_some() {
        members.push((
            "PROVENANCE-GAPS.md".to_string(),
            provenance_gaps_md(&code_gaps, helper_gap_reason.as_deref()).into_bytes(),
        ));
    }
    members.push(("inputs.json".to_string(), repro.inputs_json.into_bytes()));
    members.push(("environments.json".to_string(), env_json.into_bytes()));
    members.push(("methods.md".to_string(), methods_md.into_bytes()));
    members.push(("manifest.json".to_string(), manifest_bytes.clone()));
    // The reproducibility certificate(s) — one per verified run in the scope.
    if !verification_certs.is_empty() {
        let cert_bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "verifications": verification_certs,
        }))
        .map_err(|e| AppError::internal_error(format!("serialize verification cert: {e}")))?;
        members.push(("verification.json".to_string(), cert_bytes));
    }
    members.push((
        "REPRODUCING.md".to_string(),
        reproducing_readme(
            !verification_certs.is_empty(),
            &readiness_dto,
            &readiness_gaps,
        )
        .into_bytes(),
    ));
    members.push((
        "manifest-sha256.txt".to_string(),
        format!("{}  manifest.json\n", sha256_hex(&manifest_bytes)).into_bytes(),
    ));

    // Stage to disk (honors the temp-dir contract) then assemble the zip.
    for (name, bytes) in &members {
        let path = staging_root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::internal_error(format!("mkdir staging member: {e}")))?;
        }
        std::fs::write(&path, bytes)
            .map_err(|e| AppError::internal_error(format!("write staging member: {e}")))?;
    }

    let mut zip = zipstore::ZipBuilder::new();
    for (name, bytes) in &members {
        zip.add(name, bytes);
    }
    let zip_bytes = zip.finish();

    let export_id = Uuid::new_v4();
    store_bundle(export_id, ExportRecord { project_id, bytes: zip_bytes });
    // `_guard` drops here → staging dir removed on every exit path.
    Ok(export_id)
}

fn parse_inputs(v: &serde_json::Value) -> Vec<UsedEdgeDto> {
    parse_inputs_checked(v).unwrap_or_default()
}

/// `parse_inputs` that DISTINGUISHES a malformed `inputs_json` (`None`) from a run
/// with genuinely no inputs (`Some(vec![])`).
///
/// **F2-17** — collapsing the two is what let a corrupt provenance record score
/// GREENER than a complete one: `readiness`'s `inputs.iter().all(..)` over the
/// `Vec::new()` fallback answered `true`. The staging path keeps degrading softly
/// (a step with no resolvable inputs still renders); only the readiness verdict
/// needs the distinction.
fn parse_inputs_checked(v: &serde_json::Value) -> Option<Vec<UsedEdgeDto>> {
    match serde_json::from_value(v.clone()) {
        Ok(list) => Some(list),
        Err(e) => {
            tracing::error!("provenance: malformed inputs_json in export bundle: {e}");
            None
        }
    }
}

/// A hard-failing substitute for a MISSING code blob, in the step's own language
/// (F2-16). `run.sh` runs this under `set -euo pipefail`, so a non-zero exit aborts
/// the capsule AT THE STEP with a message naming the run and the absent hash —
/// instead of the old comment-only stub that "succeeded" and wrote nothing.
fn missing_code_stub(language: &str, run_id: Uuid, sha: &str) -> String {
    let msg = format!(
        "PROVENANCE GAP: the captured code for run {run_id} (sha256:{sha}) is NOT in this \
         bundle, so this step cannot be reproduced. Refusing to continue: a capsule that \
         exits 0 having computed nothing would misreport this analysis as reproducible. \
         See PROVENANCE-GAPS.md and readiness.json."
    );
    match language {
        "python" => format!(
            "import sys\nsys.stderr.write({:?} + \"\\n\")\nsys.exit(1)\n",
            msg
        ),
        "r" | "R" => format!("write({:?}, stderr())\nquit(status = 1)\n", msg),
        _ => format!("echo {} >&2\nexit 1\n", sh_squote(&msg)),
    }
}

/// Single-quote a value for safe interpolation into a generated shell script (the
/// same posture as `reproduce_script::sh_squote`).
fn sh_squote(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}

/// A per-run readiness verdict, serialized into the bundle's `readiness.json` so a
/// third party can see WHICH run failed WHICH condition (F2-17).
#[derive(Debug, Clone, serde::Serialize)]
struct RunVerdict {
    run_id: Uuid,
    kind: String,
    has_seed: bool,
    env_pinned: bool,
    inputs_checksummed: bool,
    code_captured: bool,
    params_captured: bool,
}

/// **ROUND-4b (R4B-01)** — a carried ROOT hash whose BYTES are not in this bundle,
/// with the reason the staging loop recorded. `roots_have_provenance` is false
/// whenever this list is non-empty, whatever the reason: a root with no bytes makes
/// the capsule abort at `stage_input` identically in every case.
#[derive(Debug, Clone, serde::Serialize)]
struct RootGap {
    hash: String,
    reason: String,
}

/// **ROUND-18 (R18-01)** — the shared runtime modules could not be READ at export
/// time, so `scripts/helpers/` is empty and the `/code` dir of every Python step is
/// incomplete: the step dies at process start on `ModuleNotFoundError`.
///
/// It carries the reason AND the runs it breaks because the verdict must name both.
/// The sibling gap class — an absent code BLOB — reddens `code_captured` through
/// `blob_len_by_run` and makes the step refuse to run with a message naming the run;
/// this class has the strictly worse failure mode (an opaque import error inside a
/// rootfs) and reached `PROVENANCE-GAPS.md` alone, so a bundle the exporter KNEW
/// could not start a single Python step still shipped `ready: true`, `gaps: []`,
/// `code_captured: true` and REPRODUCING.md's affirmative banner. That is the same
/// vacuous-`ready: true` family this file closed in R3-22 / R4B-01 / ROUND-6 A2 /
/// R4B-09, re-opened one gap class over.
#[derive(Debug, Clone)]
struct HelperGap {
    /// Why they could not be read — the string the seed extractor returned.
    reason: String,
    /// The runs whose steps would have received them (`step_stages_helpers`), so the
    /// verdict can never redden a run the capsule stages nothing into.
    runs: Vec<Uuid>,
}

/// What [`assemble_readiness`] hands `build_bundle`: the members it must write, plus
/// the verdict values `PROVENANCE-GAPS.md` and REPRODUCING.md reuse.
struct ReadinessAssembly {
    /// `scripts/helpers/<name>` members — EMPTY when the read failed (or when no step
    /// in this closure stages them at all).
    helper_members: Vec<(String, Vec<u8>)>,
    /// Why the read failed (`None` = nothing to report), for `PROVENANCE-GAPS.md`.
    helper_gap_reason: Option<String>,
    readiness_dto: crate::modules::provenance::models::ReadinessDto,
    /// `readiness.json`'s `gaps` AND REPRODUCING.md's banner — the same list by
    /// contract (R4B-09); two independent calls are how they drift.
    readiness_gaps: Vec<String>,
    /// The serialized `readiness.json` member.
    readiness_bytes: Vec<u8>,
}

/// The `scripts/helpers/` members and the machine-readable verdict ON them, as ONE
/// unit — lifted out of `build_bundle` so a test can drive the whole flow with a
/// failing reader and assert the EMITTED bytes.
///
/// **ROUND-19 (R19-01) — why this is a function and not eight inline statements.**
/// R18-01's fix was exactly the two `helper_gap` arguments below, and NOTHING
/// observed it: the test that shipped with it called `evaluate_bundle_readiness` /
/// `readiness_gap_lines` DIRECTLY with a hand-built [`HelperGap`], so no test reached
/// the assembler's own data flow. Both mutations that undo the fix were measured
/// GREEN at `39b308e9` — passing `None` at the two call sites (byte-for-byte the
/// pre-fix state, i.e. the `ready: true`-over-a-broken-capsule defect r18 filed as
/// its only MEDIUM: `cargo test --lib` 537/0), and emptying [`HelperGap::runs`],
/// which reddens no run so `code_captured` and `ready` return to `true` (19/0 over
/// this module). A fix whose only witness reconstructs its inputs by hand is
/// unguarded; this seam exists so the witness reads the OUTPUT instead, and
/// `an_unstageable_helper_seed_reddens_the_emitted_readiness_json` is that witness.
///
/// `read_helpers` is the seam and nothing more. Production passes
/// `processors::staged_python_helpers` — the SAME function the live sandbox path uses
/// (one table, `PY_HELPER_FILES`), never a second list here, because a divergent copy
/// is how a helper added for the sandbox silently stops reaching capsules — and a
/// test passes a closure that fails.
///
/// **What the members are.** Without them a capsule could not re-run a single shipped
/// Python processor: the sandbox assembles `/code` from the entry script PLUS
/// `staged_python_helpers()`, while the capsule staged the entry ALONE, so a step
/// whose script begins `import cyto_columns` died at process start on
/// `ModuleNotFoundError` — the recorded blob is faithful, the code DIR was not. It
/// went unnoticed while no shipped entry imported a staged module; every migrated one
/// does now, which is what turned the reproduce guarantee from partial into empty.
/// They are staged under `scripts/` because that prefix is already the capsule's
/// "code that was carried in, not produced" namespace: `run.sh` copies from there
/// into each step's `/code`, and a reader diffing regenerated outputs skips the whole
/// prefix.
///
/// **A read failure is NOT fatal to the export** — the seed may be unextractable on a
/// stripped deployment, and a capsule missing its helpers is still worth more than no
/// capsule — but it is a RECORDED gap, not a silent one, and (ROUND-18/R18-01) it is
/// recorded on BOTH surfaces: `PROVENANCE-GAPS.md` + the log for a reader, and
/// `readiness.json` → `REPRODUCING.md` for a machine, exactly as the sibling
/// missing-code-blob class does. The steps it breaks die at process start on an
/// opaque import error, so a bundle that shipped `ready: true` over it was asserting
/// reproducibility it knew to be false.
fn assemble_readiness(
    steps: &[reproduce_script::Step],
    read_helpers: &dyn Fn() -> Result<Vec<(&'static str, Vec<u8>)>, String>,
    included: &[&super::super::repository::RunReproRow],
    blob_len_by_run: &HashMap<Uuid, Option<usize>>,
    manifest_roots: &[manifest::ManifestRoot],
    roots_without_bytes: &[RootGap],
) -> Result<ReadinessAssembly, AppError> {
    let mut helper_members: Vec<(String, Vec<u8>)> = Vec::new();
    let mut helper_gap: Option<HelperGap> = None;
    let stages_helpers = reproduce_script::step_stages_helpers;
    if steps.iter().any(stages_helpers) {
        match read_helpers() {
            Ok(helpers) => {
                for (name, bytes) in helpers {
                    let prefix = reproduce_script::HELPER_MEMBER_PREFIX;
                    helper_members.push((format!("{prefix}{name}"), bytes));
                }
            }
            Err(e) => {
                tracing::error!(
                    "provenance export: the shared runtime helper modules could not be read \
                     ({e}); capsule steps that import one will fail at process start"
                );
                helper_gap = Some(HelperGap {
                    reason: e,
                    // Exactly the steps that would have received them — the same
                    // predicate the staging decision is made with, so the verdict can
                    // never redden a run the capsule stages nothing into.
                    runs: steps
                        .iter()
                        .filter(|s| stages_helpers(s))
                        .map(|s| s.run_id)
                        .collect::<std::collections::BTreeSet<Uuid>>()
                        .into_iter()
                        .collect(),
                });
            }
        }
    }

    // **F2-17** — the readiness verdict TRAVELS WITH THE BUNDLE. `build_bundle` used
    // to never consult readiness at all, so a closure with a ghost code blob / no
    // used-edges / an unpinned compute run / uncaptured params exported a zip whose
    // REPRODUCING.md asserted it "contains everything needed to re-run". The verdict
    // is recomputed HERE (not read from the graph facade) because only the assembler
    // knows which code blobs were actually retrievable.
    let (readiness_dto, run_verdicts) = evaluate_bundle_readiness(
        included,
        blob_len_by_run,
        manifest_roots,
        roots_without_bytes,
        helper_gap.as_ref(),
    );
    // Computed ONCE: `readiness.json`'s `gaps` and REPRODUCING.md's banner are the
    // same list by contract (R4B-09), and two independent calls are how they drift.
    let readiness_gaps = readiness_gap_lines(
        &readiness_dto,
        &run_verdicts,
        roots_without_bytes,
        manifest_roots.len(),
        helper_gap.as_ref(),
    );
    let readiness_bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "ready": readiness_dto.ready,
        "flags": {
            "seeds_set": readiness_dto.seeds_set,
            "env_pinned": readiness_dto.env_pinned,
            "inputs_checksummed": readiness_dto.inputs_checksummed,
            "code_captured": readiness_dto.code_captured,
            "params_captured": readiness_dto.params_captured,
            "roots_have_provenance": readiness_dto.roots_have_provenance,
        },
        "runs": run_verdicts,
        "gaps": readiness_gaps,
    }))
    .map_err(|e| AppError::internal_error(format!("serialize readiness: {e}")))?;

    Ok(ReadinessAssembly {
        helper_members,
        helper_gap_reason: helper_gap.map(|g| g.reason),
        readiness_dto,
        readiness_gaps,
        readiness_bytes,
    })
}

impl RootGap {
    /// Test/constructor shorthand for the "no byte source at all" arm.
    #[cfg(test)]
    fn unsourced(hash: &str) -> Self {
        Self { hash: hash.to_string(), reason: "no source in this deployment".to_string() }
    }
}

/// Every hash whose bytes are absent from this bundle, with the reason the staging
/// loop recorded.
///
/// **ROUND-6 (A1) — the candidate set is the OUTCOME LEDGER, not a classification.**
/// Round 4b derived only the STAGED side from the outcome; candidates were still
/// `manifest_roots` (built by FILTERING the walk's artifacts + dataset nodes for
/// `run_id.is_none()`) UNION `unsourced_roots` (by construction only hashes with no
/// source row). A carried hash with an artifact row produced by a run OUTSIDE the
/// walked subdag is in neither, so the hole the staging loop recorded for it was
/// discarded at the set difference and the bundle shipped `ready: true, gaps: []`
/// with no bytes for it.
///
/// The two candidate sources are now `holes` (so a recorded hole can never be
/// dropped, whatever produced the hash — `unsourced_roots` was folded away, since
/// every push to it also inserted a hole) and `manifest_roots` (so a declared root
/// the staging loop never VISITED, and therefore recorded no hole for, still
/// surfaces under the `unwrap_or_else` reason below). Both are filtered against
/// `staged`; `holes` and `staged` are disjoint as the assembler builds them, so that
/// filter is a backstop, not a load-bearing step.
///
/// This is a SUPERSET of "roots": a carried INTERMEDIATE output with no bytes lands
/// here too, reddening `roots_have_provenance` for an output a runnable upstream step
/// would have regenerated. That is the deliberate fail-closed cost of not deciding,
/// by classification, which recorded holes may be forgotten.
fn derive_roots_without_bytes(
    manifest_roots: &[manifest::ManifestRoot],
    holes: &HashMap<String, String>,
    staged: &std::collections::HashSet<String>,
) -> Vec<RootGap> {
    holes
        .keys()
        .cloned()
        .chain(manifest_roots.iter().map(|r| r.content_hash.clone()))
        .filter(|h| !staged.contains(h))
        .collect::<std::collections::BTreeSet<String>>()
        .into_iter()
        .map(|hash| {
            let reason = holes.get(&hash).cloned().unwrap_or_else(|| {
                // The staging loop never even VISITED this root (it is not among the
                // walk's carried hashes). No mode above explains it, and the fold must
                // still redden: an unexplained root is exactly the state that shipped
                // `ready: true` over a capsule with no bytes.
                "no data/ member was written for this root and the export recorded no reason; \
                 its bytes are absent from this bundle"
                    .to_string()
            });
            RootGap { hash, reason }
        })
        .collect()
}

/// Recompute the readiness checklist over the runs THIS BUNDLE actually carries,
/// using the strict (non-vacuous) flags — including `code_captured` derived from
/// the blobs that were genuinely retrievable during staging (F2-16/F2-17) and, since
/// ROUND-18 (R18-01), from whether the SHARED runtime modules the step's `/code`
/// also needs could be staged (`helper_gap`).
///
/// `code_captured` is the flag for "the code this step needs is in this bundle", and
/// a step whose `/code` holds its entry but not the modules that entry imports does
/// not satisfy it: it stops at process start. Both gap classes therefore fold into
/// the SAME flag rather than one of them reaching only the human-readable member.
fn evaluate_bundle_readiness(
    included: &[&super::super::repository::RunReproRow],
    blob_len_by_run: &HashMap<Uuid, Option<usize>>,
    roots: &[manifest::ManifestRoot],
    roots_without_bytes: &[RootGap],
    helper_gap: Option<&HelperGap>,
) -> (crate::modules::provenance::models::ReadinessDto, Vec<RunVerdict>) {
    let mut facts: Vec<super::readiness::RunReadiness> = Vec::with_capacity(included.len());
    let mut verdicts: Vec<RunVerdict> = Vec::with_capacity(included.len());
    for r in included {
        let inputs = parse_inputs_checked(&r.inputs_json);
        // ROUND-18 (R18-01) — this run's step was to receive the shared runtime
        // modules and the export could not read them, so its `/code` is incomplete
        // whatever its entry blob says.
        let helpers_missing = helper_gap.is_some_and(|g| g.runs.contains(&r.run_id));
        let fact = super::readiness::RunReadiness {
            has_seed: r.seed.is_some(),
            env_pinned: super::readiness::env_pinned_flag_for_kind(
                &r.kind,
                r.env_rootfs_sha256.as_deref(),
                &r.generator_version,
                super::super::env_obtain::is_env_obtainable(r.env_rootfs_sha256.as_deref()),
            ),
            inputs_checksummed: super::readiness::inputs_checksummed_flag(
                &r.kind,
                inputs.as_deref(),
            ),
            code_captured: !helpers_missing
                && super::readiness::code_captured_flag(
                    &r.kind,
                    r.code_sha256.as_deref(),
                    // A run with no step (never staged) contributes no blob evidence;
                    // fall back to "no blob", which the flag reads as a gap only when a
                    // hash IS recorded — or, since R4B-10, when the run is a COMPUTE run
                    // that recorded no hash at all.
                    blob_len_by_run.get(&r.run_id).copied().flatten(),
                ),
            params_captured: super::readiness::params_captured_flag(
                &r.kind,
                super::super::graph::rerun_params_object(r),
            ),
        };
        verdicts.push(RunVerdict {
            run_id: r.run_id,
            kind: r.kind.clone(),
            has_seed: fact.has_seed,
            env_pinned: fact.env_pinned,
            inputs_checksummed: fact.inputs_checksummed,
            code_captured: fact.code_captured,
            params_captured: fact.params_captured,
        });
        facts.push(fact);
    }
    // ROUND-4 (R3-22) — `roots` is `manifest_roots`, which `build_bundle` derives by
    // FILTERING the walk's artifacts + dataset nodes. A carried root hash matching
    // NEITHER (a reference-resource root, a pruned artifact, a foreign hash) is
    // therefore absent from this list, and folding `.all()` over it EXCLUDED the one
    // case the flag exists for: the bundle shipped `ready: true`, `data/<hash>` was
    // never written (the staging loop skips an unknown source), and the capsule then
    // aborted at `stage_input`.
    //
    // ROUND-4b (R4B-01) — round 4 supplied only the UNKNOWN-SOURCE arm, so the sibling
    // arms stayed green: an artifact row that exists but whose object-store `get`
    // FAILS is in `roots`, passes `.all(non-empty hash)`, and shipped `ready: true,
    // gaps: []` over a capsule with no bytes for its only root. `roots_without_bytes`
    // is now derived from the staging loop's OUTCOME (`derive_roots_without_bytes`,
    // whose candidate set is the recorded holes themselves), so no arm of that loop
    // can leave a byte-less hash out of this check.
    //
    // ROUND-6 (A2) — `!roots.is_empty()` is the EMPTY-SLICE guard. `.all()` over an
    // empty slice is `true`, so a bundle declaring NO root input asserted that its
    // roots have provenance and, with nothing else red, shipped `ready: true` over a
    // capsule with nothing to reproduce FROM. This is the same vacuity R4B-08 closed
    // for `runs` inside `readiness::evaluate`; `roots` is not run-derived, so its
    // guard belongs here, at the only place `roots` is folded.
    let roots_have_provenance = !roots.is_empty()
        && roots.iter().all(|r| !r.content_hash.trim().is_empty())
        && roots_without_bytes.is_empty();
    (
        super::super::graph::evaluate_closure(&facts, roots_have_provenance),
        verdicts,
    )
}

/// Human-readable gap lines (flag → the run ids that fail it) for `readiness.json`
/// and the README's incomplete-provenance banner.
///
/// **ROUND-4b (R4B-09) — the two surfaces now report the SAME issue set.**
///
/// The in-app badge (`LineagePane::ReadinessBadge`) renders "⚠ N issues" where N is
/// the count of FALSE flags on the very `ReadinessDto` this function is handed. The
/// export used to derive its bullets from a different rule: on an EMPTY closure it
/// short-circuited to a single `no_runs:` line while the DTO carried FIVE false
/// flags — so the same closure read "⚠ 5 issues" in the app and shipped one bullet
/// in `readiness.json` / `REPRODUCING.md`, and `readiness.json`'s own `flags` block
/// contradicted its own `gaps` block.
///
/// The invariant is now: **exactly one line per false flag, in every case** (asserted
/// by `gap_lines_are_symmetric_with_the_badges_issue_count`). The empty-closure fact
/// is carried as the REASON inside each of those five lines instead of as a sixth
/// pseudo-flag the badge has no counterpart for. Consequences, both of which were the
/// stated objections to round 3's reverted one-liner:
///   - `ready: true` ⇒ zero false flags ⇒ zero lines, and the README prints its
///     affirmative banner (never "the failing conditions are:" followed by nothing);
///   - an empty closure ⇒ five false flags ⇒ five lines with a cause in each (never
///     the warning-toned "0 issues").
fn readiness_gap_lines(
    d: &crate::modules::provenance::models::ReadinessDto,
    runs: &[RunVerdict],
    roots_without_bytes: &[RootGap],
    // How many ROOT inputs the bundle declares. ROUND-6 (A2): zero is itself a cause
    // of `roots_have_provenance: false`, and a different one from "a declared root
    // carries no content hash".
    root_count: usize,
    // ROUND-18 (R18-01): the second cause of `code_captured: false`. One flag ⇒ one
    // line (R4B-09), so it is the REASON inside that line, never a bullet of its own
    // — a seventh bullet with no flag behind it is precisely the badge-vs-export
    // disagreement R4B-09 closed.
    helper_gap: Option<&HelperGap>,
) -> Vec<String> {
    let mut out = Vec::new();
    // ROUND-4 (R3F-03): every per-flag line is derived from the RUNS that fail it, so
    // over an EMPTY closure they would each render "(runs: )" — a bullet that names no
    // cause. The cause of all five is the same single fact, so it is spelled out in
    // place of the run list rather than dropped.
    const NO_RUNS: &str = "no captured run in this closure establishes it — the closure \
                           contains no run at all, so there is nothing to re-run (an export \
                           scope that resolved to nothing, or a project whose lineage has \
                           roots but no recorded run)";
    let mut push = |ok: bool, flag: &str, what: &str, pick: fn(&RunVerdict) -> bool| {
        if ok {
            return;
        }
        if runs.is_empty() {
            out.push(format!("{flag}: {NO_RUNS}"));
            return;
        }
        let ids: Vec<String> =
            runs.iter().filter(|r| !pick(r)).map(|r| r.run_id.to_string()).collect();
        out.push(format!("{flag}: {what} (runs: {})", ids.join(", ")));
    };
    push(d.seeds_set, "seeds_set", "a run recorded no RNG seed, so a randomised step cannot be reproduced exactly", |r| r.has_seed);
    push(d.env_pinned, "env_pinned", "a run pins no obtainable environment; the capsule cannot execute it", |r| r.env_pinned);
    push(d.inputs_checksummed, "inputs_checksummed", "a run's inputs are unrecorded, unparseable, or unchecksummed", |r| r.inputs_checksummed);
    // ROUND-18 (R18-01) — `code_captured` has TWO independent causes and one flag, so
    // they share one line, the way `roots_have_provenance` below shares its two. The
    // distinction is load-bearing for whoever acts on it: an absent code BLOB makes
    // the step refuse to run naming its own hash, while absent shared runtime MODULES
    // let it start and die on an import the reader has no other clue about.
    let code_what = match helper_gap {
        None => "the captured code is MISSING from this bundle; that step will refuse to run"
            .to_string(),
        Some(g) => format!(
            "the code this bundle carries for that step is INCOMPLETE — the shared runtime \
             modules could not be read at export ({}), so `scripts/helpers/` is empty and a \
             step importing one stops at process start with an import error (a step whose \
             captured code blob is itself absent instead refuses to run); see PROVENANCE-GAPS.md",
            g.reason
        ),
    };
    push(d.code_captured, "code_captured", &code_what, |r| r.code_captured);
    push(d.params_captured, "params_captured", "a compute run's scientific parameters were never captured; it would replay on processor DEFAULTS", |r| r.params_captured);
    if !d.roots_have_provenance {
        // The flag is one flag, so it gets exactly one line (R4B-09) — and the two
        // ways it can be false are independent, so when both hold they share it.
        let mut why: Vec<String> = Vec::new();
        if root_count == 0 {
            // ROUND-6 (A2): the empty-roots case. Reported as itself, never as the
            // "carries no content hash" case — there is no root to carry one.
            why.push(
                "this bundle declares no root input at all, so there is nothing to \
                 reproduce FROM"
                    .to_string(),
            );
        } else if roots_without_bytes.is_empty() {
            why.push("a root input carries no content hash".to_string());
        }
        if !roots_without_bytes.is_empty() {
            // ROUND-4b (R4B-01): naming EVERY byte-less hash and WHY — an over-cap
            // deferral (recoverable via fetch.txt) and an unreadable blob (not
            // recoverable here) are both fatal to the capsule but call for different
            // action, so the reason travels with the hash.
            why.push(format!(
                "{} carried hash(es) have no bytes in this bundle, so the capsule aborts \
                 at stage_input: {}",
                roots_without_bytes.len(),
                roots_without_bytes
                    .iter()
                    .map(|g| format!("{} ({})", g.hash, g.reason))
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        out.push(format!("roots_have_provenance: {}", why.join("; ")));
    }
    out
}

/// The `PROVENANCE-GAPS.md` member — emitted when a code blob was absent, or when
/// the shared runtime helper modules could not be staged.
fn provenance_gaps_md(code_gaps: &[(Uuid, String)], helper_gap: Option<&str>) -> String {
    let mut s = String::from(
        "# Provenance gaps in this bundle\n\n\
         This bundle could NOT be assembled completely. Each gap below is a place \
         where the recorded analysis cannot be reproduced from these files.\n\n",
    );
    if !code_gaps.is_empty() {
        s.push_str(
            "## Missing captured code\n\n\
             The run's code hash is recorded but the code blob itself is not in the \
             provenance store, so no script could be included. The corresponding step in \
             `run.sh` is a stub that exits non-zero: the capsule REFUSES to run rather \
             than completing with exit 0 having computed nothing.\n\n",
        );
        for (run_id, sha) in code_gaps {
            s.push_str(&format!(
                "- run `{run_id}` — code `sha256:{sha}` not found\n"
            ));
        }
        s.push('\n');
    }
    if let Some(reason) = helper_gap {
        s.push_str(&format!(
            "## Missing shared runtime modules\n\n\
             The modules this deployment stages into the code dir of every Python entry \
             could not be read ({reason}), so `scripts/helpers/` is empty. A step whose \
             script imports one of them will stop at process start with an import error \
             rather than running.\n\n"
        ));
    }
    s.push_str("See `readiness.json` for the full checklist.\n");
    s
}

/// The script language for a run's reproduce step: the recorded `params.language`
/// (set by the recorder), else the captured code blob's language isn't available
/// here without a fetch, so default to `bash` (a CLI-glue / manual step).
fn run_language(
    r: &super::super::repository::RunReproRow,
    rerun: &Option<serde_json::Value>,
) -> String {
    if let Some(lang) = r.params.get("language").and_then(|l| l.as_str()) {
        return lang.to_string();
    }
    // Fall back to the re-run spec's declared language.
    if let Some(lang) = rerun
        .as_ref()
        .and_then(|s| s.get("language"))
        .and_then(|l| l.as_str())
    {
        return lang.to_string();
    }
    "bash".to_string()
}

/// **ROUND-19 (R19-03)** — did the RECORDED run's `/code` hold the shared runtime
/// modules? Read off the stashed re-run spec (the SAME already-fetched value
/// `run_language` / `params_from_rerun` / `input_subpaths_from_rerun` read, so this
/// introduces no query), never inferred from the language.
///
/// Two live paths, and only one of them stages:
///   - a spec carrying `code_ref` resolves through `processors::resolve_in`, which
///     stages `PY_HELPER_FILES` for a `Language::Python` entry → **true**;
///   - a spec carrying an INLINE `script` returns `helpers: Vec::new()` from
///     `AnalysisSpec::resolve_entry` and never consults `resolve_in` at all, so its
///     `/code` held the entry ALONE → **false**, whatever the language says.
///
/// A run with NO recorded spec (a legacy row, or an in-app node) cannot be answered
/// from the record, so it keeps the historical answer — the language. That is the
/// conservative direction for THAT case specifically: the only runs it can affect are
/// `code_ref` runs old enough to predate the stash, and under-staging them re-opens
/// the `ModuleNotFoundError` class `c38a4355` closed, while over-staging them is the
/// (smaller) class this round closes.
fn run_staged_shared_helpers(language: &str, rerun: &Option<serde_json::Value>) -> bool {
    if reproduce_script::lang_ext_interp(language).0 != "py" {
        return false;
    }
    let Some(spec) = rerun.as_ref() else { return true };
    // `"script": null` is a `code_ref` spec serialized with its empty option, so the
    // discriminator is a STRING script, not the key's presence.
    !spec.get("script").is_some_and(|s| s.is_string())
}

/// **ITEM-2** — the run's SCIENTIFIC params from its stashed re-run spec, so the
/// capsule's `/inputs/params.json` carries the predicate the run actually executed
/// (the filter criteria, the thresholds, the mask label …) instead of the seed
/// alone. The exact behavioural sibling of [`input_subpaths_from_rerun`] below,
/// reading the SAME spec — so this introduces **no new query** (ITEM-6: the spec
/// now rides the `RunReproRow` `build_bundle` already loaded).
///
/// DEC-9 / DEC-14: the source is the sandbox `RunSpec.params` object that
/// `recorder.rs` stashes verbatim — the same object `sandbox/inputs.rs` merges the
/// seed into at run time, which is what makes the regenerated `params.json`
/// byte-compatible. This is ALSO the legacy fallback: a PRE-promotion run whose
/// `params` column holds `{seed,language,arch}` still renders its real science from
/// here. There is deliberately NO backfill migration — a run whose spec carries no
/// params is reported not-reproducible-ready by `readiness::params_captured` (ITEM-4)
/// rather than silently replayed as though complete.
///
/// A missing / non-object / `params`-less spec yields `{}` — non-fatal, mirroring
/// `run_language`'s degradation policy (a `get_rerun_spec` failure is already
/// warn-logged and treated as `None` at the call site).
fn params_from_rerun(rerun: &Option<serde_json::Value>) -> serde_json::Value {
    let Some(v) = rerun else {
        return serde_json::json!({});
    };
    match v.get("params") {
        Some(p @ serde_json::Value::Object(_)) => p.clone(),
        Some(other) => {
            tracing::warn!(
                "provenance export: rerun spec `params` is not an object ({other}); the capsule \
                 will regenerate seed-only params for this step"
            );
            serde_json::json!({})
        }
        None => serde_json::json!({}),
    }
}

/// Runtime metadata that is NOT a scientific parameter and must never be rendered
/// as one (DEC-1/DEC-9 §2) — in a `FormalParameter`, or named in methods prose,
/// from EITHER source. Present only on runs recorded before DEC-1's promotion.
const RUNTIME_META_KEYS: [&str; 2] = ["language", "arch"];

/// True when `obj` carries at least one key that is a real scientific parameter —
/// i.e. something other than the seed (which has its own column + narration) and
/// the runtime metadata above. `{seed, language, arch}` — the legacy shape — is
/// therefore NOT science, which is exactly what triggers the DEC-9 fallback.
fn has_science(obj: &serde_json::Value) -> bool {
    obj.as_object().is_some_and(|m| {
        m.keys().any(|k| k != "seed" && !RUNTIME_META_KEYS.contains(&k.as_str()))
    })
}

/// `params` with the runtime-metadata keys removed (a non-object yields `{}`).
fn strip_runtime_meta(params: &serde_json::Value) -> serde_json::Value {
    let Some(map) = params.as_object() else {
        return serde_json::json!({});
    };
    serde_json::Value::Object(
        map.iter()
            .filter(|(k, _)| !RUNTIME_META_KEYS.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

/// **ITEM-7/ITEM-8 (DEC-9)** — the SCIENTIFIC params to render in the export's
/// out-of-app trust surfaces (`manifest.json`'s `FormalParameter`s + `methods.md`
/// prose): the PROMOTED `params` column first, the stashed re-run spec's `params`
/// second, with `language`/`arch` never emitted from either source.
///
/// The fallback is what keeps a PRE-promotion run honest: its column holds only
/// `{seed, language, arch}`, so rendering it verbatim would present runtime
/// metadata as though it were science. There is deliberately NO backfill migration
/// (DEC-9 §4) — a run carrying science in NEITHER place renders just its seed (or
/// nothing), and `readiness::params_captured` is what reports it not-ready.
fn science_params(recorded: &serde_json::Value, rerun: &Option<serde_json::Value>) -> serde_json::Value {
    let promoted = strip_runtime_meta(recorded);
    if has_science(&promoted) {
        return promoted;
    }
    let fallback = strip_runtime_meta(&params_from_rerun(rerun));
    if !has_science(&fallback) {
        // Nothing to fall back to — return the promoted view (a seed, or nothing).
        // Never invent a parameter the run did not record.
        return promoted;
    }
    // Carry the recorded seed across so the fallback view is not less complete
    // than the promoted one.
    let mut out = fallback;
    if let (Some(map), Some(seed)) = (out.as_object_mut(), promoted.get("seed")) {
        map.entry("seed".to_string()).or_insert_with(|| seed.clone());
    }
    out
}

/// The CPU arch a run executed on, for the capsule's `environments.json` (ITEM-22).
///
/// DEC-1/DEC-14 dropped `arch` from the trust-view `params`, so this reads it from
/// there only for a PRE-promotion run. For a promoted run the arch is recovered
/// from the environment the run pinned: when `env_rootfs_sha256` is the digest of
/// the rootfs embedded in THIS binary, the run executed on this binary's arch.
/// Anything else stays `None` → `environments.json` reports `"unknown"` rather
/// than asserting an arch it cannot know (a WRONG arch would misdirect the reader
/// obtaining the rootfs; the digest is the authoritative pin either way).
fn run_arch(r: &super::super::repository::RunReproRow) -> Option<String> {
    run_arch_with(r, &crate::modules::rootfs::embedded::content_sha256_full())
}

/// [`run_arch`] with the embedded-rootfs digest INJECTED (F2-19).
///
/// The embedded rootfs asset is a permanent 0-byte fail-soft stub in every ordinary
/// dev/CI build, so `content_sha256_full()` returns `""` and the embedded-digest
/// branch is unreachable from a test that reads it. The only assertion covering that
/// branch therefore sat behind `if !embedded.is_empty()` and never executed, while
/// the test reported `ok` — the round-1 "green while asserting nothing" shape. Taking
/// the digest as a parameter (like `env_pinned_flag` takes `obtainable`) makes all
/// three arms testable unconditionally.
fn run_arch_with(r: &super::super::repository::RunReproRow, embedded: &str) -> Option<String> {
    if let Some(a) = r.params.get("arch").and_then(|a| a.as_str()) {
        return Some(a.to_string());
    }
    let digest = super::super::env_obtain::normalize_digest(r.env_rootfs_sha256.as_deref()?);
    (!embedded.is_empty() && embedded == digest).then(|| std::env::consts::ARCH.to_string())
}

/// The `(slot, /inputs-relative subpath)` pairs from a run's stashed re-run spec,
/// so `run.sh` binds each input at the SAME path the original run saw (ITEM-22).
///
/// **Read the RECORD first, the DECLARATION only as a fallback.** `input_mounts` is what
/// the run actually bound, stamped on at record time from its own `/inputs/inputs.json`
/// (`recorder::with_input_mounts`, which documents why this is not re-derived here).
/// `inputs[].sandbox_subpath` is only what the CALLER asked for, and since ITEM-23 the
/// runner ignores it for every artifact-backed input — so reading it made the capsule
/// claim a bind path the run never used. It survives as the answer for runs recorded
/// before the record existed, where a declaration is the only evidence there is; those
/// runs' artifact inputs are the ones whose capsules can still misstate a path, and
/// there is deliberately no backfill (the same posture as DEC-9's params fallback —
/// invent nothing that was not recorded).
fn input_subpaths_from_rerun(rerun: &Option<serde_json::Value>) -> Vec<(String, String)> {
    let Some(v) = rerun else { return Vec::new() };
    if let Some(arr) = v
        .get(super::super::recorder::RERUN_INPUT_MOUNTS_KEY)
        .and_then(|m| m.as_array())
    {
        return arr
            .iter()
            .filter_map(|m| {
                let slot = m.get("slot")?.as_str()?.to_string();
                let sub = m.get("subpath")?.as_str()?.to_string();
                Some((slot, sub))
            })
            .collect();
    }
    v.get("inputs")
        .and_then(|i| i.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|inp| {
                    let slot = inp.get("slot")?.as_str()?.to_string();
                    let sub = inp.get("sandbox_subpath")?.as_str()?.to_string();
                    Some((slot, sub))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The DB-recorded byte size of a Dataset file (a STAT via the `files` row — never
/// loads the bytes). Consulted BEFORE `fetch_dataset_file_bytes` so the export cap
/// is enforced without materializing an oversize root in memory (OOM guard).
/// `Ok(None)` = the file row is gone.
async fn dataset_file_size(pool: &PgPool, file_id: Uuid) -> Result<Option<u64>, AppError> {
    Ok(ziee_file::FileRepository::new(pool.clone())
        .get_by_id(file_id)
        .await?
        .map(|f| f.file_size.max(0) as u64))
}

/// Load a Dataset file's bytes from ziee-file (mirrors `sandbox/inputs.rs`'s
/// `stage_dataset_file`) — the byte source for a `data/<hash>` dataset root on
/// export (ITEM-21).
async fn fetch_dataset_file_bytes(pool: &PgPool, file_id: Uuid) -> Result<Vec<u8>, AppError> {
    let file = ziee_file::FileRepository::new(pool.clone())
        .get_by_id(file_id)
        .await?
        .ok_or_else(|| AppError::not_found("dataset file"))?;
    let extension = file.filename.rsplit('.').next().unwrap_or("bin").to_lowercase();
    ziee_file::get_file_storage()
        .load_original(file.user_id, file.blob_version_id, &extension)
        .await
        .map_err(|e| AppError::internal_error(format!("load dataset file {file_id}: {e}")))
}

/// Appended to the generated `run.sh` so the capsule's LAST act is the output
/// comparison (F2-18). `run.sh` runs under `set -e`, so a non-zero
/// `verify_outputs.sh` makes the whole capsule exit non-zero.
const OUTPUT_VERIFICATION_TAIL: &str = r#"
# ---- output verification (appended by the bundle assembler — F2-18) ----
# NOTE: the "Reproduce capsule complete." line above means ONLY that no step exited
# non-zero. It is not a reproducibility verdict. The check below is: it compares the
# outputs this capsule just regenerated against the content hashes recorded when the
# analysis was originally captured.
bash "$HERE/verify_outputs.sh"
"#;

/// Generate `verify_outputs.sh` — the capsule's actual reproducibility verdict.
///
/// **F2-18** — `run.sh` re-ran every step and then printed `Reproduce capsule
/// complete.` unconditionally; the recorded `output_hashes` appeared in it only as
/// `stage_input` arguments for downstream steps, never as an EXPECTATION. A capsule
/// whose only verdict is "the script did not crash" cannot tell a third party
/// whether the analysis reproduced (and, combined with F2-16, that success line was
/// unfalsifiable).
///
/// The comparison re-hashes each step's `work/NN/outputs` tree — NOT the `.cas`,
/// which `run.sh` pre-seeds from the bundled `data/` and therefore already contains
/// every recorded output hash (checking it would pass vacuously).
fn verify_outputs_sh(
    steps: &[reproduce_script::Step],
    outputs_by_run: &HashMap<Uuid, Vec<String>>,
    multifile_hashes: &std::collections::HashSet<String>,
) -> String {
    let mut s = String::from(
        r#"#!/usr/bin/env bash
# Output verification for this reproducibility capsule (generated by CytoAnalyst).
#
# WHAT A `REPRODUCED` VERDICT PROVES: every output content hash recorded when this
# analysis was captured was regenerated BYTE-IDENTICALLY by this capsule, on this
# machine, in the pinned environment.
#
# WHAT IT DOES NOT PROVE: that the science is correct; that steps which recorded no
# outputs behaved identically; or anything about files the original run did not
# record as outputs. Steps that this capsule did not execute (no pinned environment
# / no captured code) are reported UNVERIFIED, never as reproduced.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RC=0; CHECKED=0; FAILED=0; UNVERIFIED=0; UNVERIFIED_NEVER=0; UNVERIFIED_HOST=0; UNVERIFIED_UNSUPPORTED=0

# verify_step <nn> <run_id> <work-dir> <expected-hash...>
verify_step() {
  local nn="$1" run="$2" wd="$3"; shift 3
  local dir="$HERE/$wd/outputs" got h
  # The step IS executable (the recorded run pinned an environment AND captured
  # code), so an ABSENT output tree means THIS HOST did not execute it — run.sh
  # aborted earlier, or this verifier was invoked standalone. That is a different
  # fact from "the recorded output was not regenerated", and reporting it as the
  # latter accuses the analysis of irreproducibility on no evidence.
  if [ ! -d "$dir" ]; then
    UNVERIFIED=$((UNVERIFIED+$#)); UNVERIFIED_HOST=$((UNVERIFIED_HOST+$#))
    echo "[verify] step $nn UNVERIFIED — this host did not execute it (no $wd/outputs); $# recorded output(s) unchecked (run $run)" >&2
    return
  fi
  got="$(find "$dir" -type f -exec sha256sum {} + 2>/dev/null | cut -d' ' -f1 | sort -u)"
  for h in "$@"; do
    CHECKED=$((CHECKED+1))
    # -F (FIXED STRING), not a regex: ROUND-6 (A4) — `grep -qx` treated the recorded
    # hash as a BASIC REGULAR EXPRESSION, so a hash of 64 '.' characters matched the
    # sha256 of whatever the step actually produced and the capsule reported OK /
    # REPRODUCED / exit 0 for an output that was never regenerated.
    if printf '%s\n' "$got" | grep -qxF -- "$h"; then
      echo "[verify] step $nn OK              sha256:$h"
    else
      echo "[verify] step $nn NOT REGENERATED sha256:$h (run $run)" >&2
      FAILED=$((FAILED+1)); RC=1
    fi
  done
}

# skip_step <nn> <run_id> <reason> <n-recorded-outputs> <class>
#
# <class> is the round-4 per-step EXECUTABILITY reason, and it is what makes the
# exit status derivable instead of a guess:
#   never — the RECORDED RUN pinned no environment / captured no code. No host,
#           ever, can execute this step; an in-app selection closure is entirely
#           made of these BY CONSTRUCTION (`interaction.rs` records
#           `env_rootfs_sha256: None`) while still carrying recorded output
#           hashes. Nothing failed; there was never anything to run.
#   host  — the step is executable, but this machine did not run it.
#   unsupported — the recorded hash is a MULTIFILE artifact's MERKLE ROOT over a
#           directory. This verifier compares per-file sha256sums, which can never
#           equal it, so comparing at all produces a guaranteed false NOT
#           REPRODUCED for an output that may have reproduced perfectly. It is
#           reported unchecked rather than failed (ROUND-4, R3-24).
skip_step() {
  UNVERIFIED=$((UNVERIFIED+$4))
  case "$5" in
    never)       UNVERIFIED_NEVER=$((UNVERIFIED_NEVER+$4)) ;;
    unsupported) UNVERIFIED_UNSUPPORTED=$((UNVERIFIED_UNSUPPORTED+$4)) ;;
    *)           UNVERIFIED_HOST=$((UNVERIFIED_HOST+$4)) ;;
  esac
  echo "[verify] step $1 UNVERIFIED — $3; $4 recorded output(s) unchecked (run $2)" >&2
}

"#,
    );
    for (n, step) in steps.iter().enumerate() {
        let nn = format!("{n:02}");
        let recorded: Vec<&String> =
            outputs_by_run.get(&step.run_id).map(|hs| hs.iter().collect()).unwrap_or_default();
        // ROUND-4 (R3-24): a MULTIFILE artifact's recorded `content_hash` is a merkle
        // root over its directory, not any file's sha256, so it is not comparable by
        // this verifier at all. Split it out BEFORE deciding the step's verdict —
        // folding it into `verify_step` guaranteed a false NOT REPRODUCED.
        let (multi, single): (Vec<&String>, Vec<&String>) =
            recorded.iter().partition(|h| multifile_hashes.contains(**h));
        let hashes: Vec<String> =
            single.iter().map(|h| reproduce_script::data_filename(h)).collect();
        if !multi.is_empty() {
            s.push_str(&format!(
                "skip_step {} {} {} {} 'unsupported'\n",
                sh_squote(&nn),
                sh_squote(&step.run_id.to_string()),
                sh_squote(
                    "multi-file output: the recorded hash is a merkle root over a directory, \
                     which per-file sha256 cannot reproduce — not compared"
                ),
                multi.len()
            ));
        }
        let runnable = step.env_digest.is_some() && step.code_sha256.is_some();
        if hashes.is_empty() {
            if multi.is_empty() {
                s.push_str(&format!(
                    "# step {nn} (run {}) recorded no outputs — nothing to compare.\n",
                    step.run_id
                ));
            }
            continue;
        }
        if runnable {
            s.push_str(&format!(
                "verify_step {} {} {} {}\n",
                sh_squote(&nn),
                sh_squote(&step.run_id.to_string()),
                sh_squote(&step.work_dir),
                hashes.iter().map(|h| sh_squote(h)).collect::<Vec<_>>().join(" ")
            ));
        } else {
            // ROUND-4 (R3F-02): both generation-time skips are properties of the
            // RECORDED RUN, not of this host — so both are class `never`. A step
            // that IS executable and simply was not run here is detected at
            // RUNTIME by `verify_step`'s absent-output-tree branch (class `host`).
            let reason = if step.env_digest.is_none() {
                "never executable: the recorded run pinned no environment (provenance-only node)"
            } else {
                "never executable: the recorded run captured no code (manual step)"
            };
            s.push_str(&format!(
                "skip_step {} {} {} {} 'never'\n",
                sh_squote(&nn),
                sh_squote(&step.run_id.to_string()),
                sh_squote(reason),
                hashes.len()
            ));
        }
    }
    s.push_str(
        r#"
# ROUND-4 (R3F-02) — the verdict, derived from the per-step executability class.
#
# Round 3 had to GUESS the exit status for "nothing was checked" because every skip
# looked alike: making it `exit 1` regressed the feature's headline artifact (an
# in-app selection closure is unrunnable BY CONSTRUCTION yet always carries recorded
# output hashes, so CHECKED==0 && UNVERIFIED>0 is its NORMAL state), and leaving it
# `exit 0` let a capsule that could have verified something, and did not, pass. With
# `never` vs `host` on each unverified output the two are no longer the same case:
#
#   something was checked and mismatched      -> NOT REPRODUCED, exit 1
#   something was runnable here and was not run      -> NOT VERIFIED, exit 1
#   everything checkable was checked and matched     -> REPRODUCED/PARTIAL, exit 0
#   nothing was checkable, and nothing ever could be -> NOT VERIFIED, exit 0
#   nothing recorded at all                          -> NOT VERIFIED, exit 0
#
# ROUND-4b (R4B-04) — THE ARM ORDER IS THE VERDICT. Round 4 put the `CHECKED -gt 0`
# arm SECOND, above the host arm, so in a MIXTURE the wrong signal won: a capsule in
# which step 0 verified and step 1 was executable-but-not-run-here printed
# "PARTIALLY VERIFIED" and exited 0 — while the SAME unrun step alone exits 1. An
# unrelated success silently downgraded a real "this could have been verified and was
# not". The arms are now ordered strictly by signal strength:
#
#   1. a MISMATCH anywhere            (dominates everything)      -> exit 1
#   2. an executable step not run here (would change the verdict) -> exit 1
#   3. everything checkable checked + matched                     -> exit 0
#   4. nothing was CHECKABLE (never-executable / multi-file)      -> exit 0
#   5. nothing was RECORDED                                       -> exit 0
#
# Arms 4 and 5 are the only ones that may pass without having verified anything, and
# neither can be reached while a mismatch or an unrun executable step exists.
if [ "$RC" -ne 0 ]; then
  echo "NOT REPRODUCED: $FAILED of $CHECKED recorded outputs were not regenerated." >&2
  exit 1
fi
if [ "$UNVERIFIED_HOST" -gt 0 ]; then
  echo "NOT VERIFIED: $UNVERIFIED_HOST recorded output(s) belong to step(s) that ARE" >&2
  echo "              executable, but this host did not execute them — so they were not" >&2
  echo "              compared. Run ./run.sh (see environments.json for the rootfs each" >&2
  echo "              step needs), then re-run this verifier." >&2
  if [ "$CHECKED" -gt 0 ]; then
    echo "              ($CHECKED other recorded output(s) DID regenerate byte-identically." >&2
    echo "               That is not a verdict for the closure as a whole.)" >&2
  fi
  exit 1
fi
if [ "$CHECKED" -gt 0 ]; then
  if [ "$UNVERIFIED" -gt 0 ]; then
    # Every remaining unverified output is UNCHECKABLE (never-executable or a
    # multi-file merkle root) — the host class exited above — so say which.
    echo "PARTIALLY VERIFIED: all $CHECKED checked outputs regenerated byte-identically; $UNVERIFIED recorded output(s) could not be checked at all ($UNVERIFIED_NEVER from step(s) no host can execute, $UNVERIFIED_UNSUPPORTED multi-file merkle root(s))."
  else
    echo "REPRODUCED: all $CHECKED recorded output hashes regenerated byte-identically."
  fi
  exit 0
fi
if [ "$UNVERIFIED_NEVER" -gt 0 ] || [ "$UNVERIFIED_UNSUPPORTED" -gt 0 ]; then
  # ROUND-4b (R4B-04): round 4 handled `unsupported` and `never` as two exclusive
  # arms (`UNSUPPORTED>0 && NEVER==0`), so a closure carrying BOTH fell through to
  # the `never` arm and printed the false claim "every step in this closure is never
  # executable" while silently dropping the multi-file count. One arm, both counts.
  echo "NOT VERIFIED: nothing in this closure was checkable, so nothing was compared." >&2
  echo "              $UNVERIFIED_NEVER recorded output(s) belong to step(s) that are never executable" >&2
  echo "              (the recorded runs pinned no environment / captured no code) — expected" >&2
  echo "              for a provenance-only closure, e.g. an in-app selection." >&2
  echo "              $UNVERIFIED_UNSUPPORTED recorded output(s) are MULTI-FILE artifacts whose recorded hash" >&2
  echo "              is a merkle root over a directory; this verifier compares per-file" >&2
  echo "              sha256sums, so it cannot check them." >&2
  echo "              Neither is a reproducibility failure, and neither is a reproducibility" >&2
  echo "              claim." >&2
  exit 0
fi
echo "NOT VERIFIED: this closure recorded no output hashes, so nothing could be compared." >&2
echo "              This capsule proves only that no step exited non-zero." >&2
exit 0
"#,
    );
    s
}

fn reproducing_readme(
    has_verification: bool,
    readiness: &crate::modules::provenance::models::ReadinessDto,
    gaps: &[String],
) -> String {
    let verification_note = if has_verification {
        "\n     - `verification.json` — the reproducibility certificate(s): the app \
        re-ran the captured code against the pinned rootfs and compared the \
        regenerated outputs' content hashes to the recorded ones (see \
        `manifest.json`'s ControlAction for the claim + honest status).\n"
    } else {
        ""
    };
    // **F2-17** — the completeness claim is now CONDITIONAL on the checklist this
    // bundle actually shipped. It used to be an unconditional "contains everything
    // needed to re-run" over closures with ghost code blobs, unrecorded params, or
    // no pinned environment — an assertion the export had never checked.
    // **ROUND-6 (A5)** — the affirmative banner used to enumerate the six flags as
    // properties of the CAPSULE ("passes every condition: … environments pinned +
    // obtainable, … code captured"). Those flags are KIND-SCOPED: an
    // interaction/selection run pins no rootfs and captures no code, and
    // `env_pinned_flag_for_kind` / `code_captured_flag` answer true for it on the
    // generator version alone. The same zip's `verify_outputs.sh` then reports `NOT
    // VERIFIED: nothing in this closure was checkable` — so the deliverable
    // contradicted itself about whether the capsule had been verified. The banner
    // now claims only what the export can know (what was RECORDED) and points at the
    // one thing that produces a verification verdict.
    let banner = if readiness.ready {
        "This BagIt-RO bundle carries the captured analysis. Its reproducibility \
         checklist (`readiness.json`) reports no gap: for every run in this closure — \
         in the form that run's kind admits — a seed, an environment, checksummed \
         inputs, code and scientific parameters were RECORDED at capture time, and \
         every carried hash's bytes are in `data/`.\n\n\
         That is a statement about what was captured, and not a verification: nothing \
         in this bundle has been re-executed. The verification verdict is whatever \
         `verify_outputs.sh` prints when you run this capsule — including `NOT \
         VERIFIED: nothing in this closure was checkable`, which a provenance-only \
         closure (an in-app selection pins no environment and captures no code) \
         legitimately produces without contradicting the checklist above.\n\n"
            .to_string()
    } else {
        let mut b = String::from(
            "> **INCOMPLETE PROVENANCE — this bundle does NOT contain everything \
             needed to re-run the captured analysis.**\n>\n\
             > `readiness.json` reports `ready: false`. Re-running it will not \
             reproduce the recorded results; the failing conditions are:\n>\n",
        );
        for g in gaps {
            b.push_str(&format!("> - {g}\n"));
        }
        b.push_str(
            ">\n> The steps affected by a MISSING code blob refuse to run (they exit \
             non-zero) rather than completing with exit 0 having computed nothing.\n\n",
        );
        b
    };
    format!("{}{}{}{}",
     "# Reproducing this analysis\n\n",
     banner,
     "Contents:\n\n\
     - `data/` — content-addressed input + output artifacts (large objects are \
       listed in `fetch.txt`).\n\
     - `scripts/` — the per-step code, pulled verbatim from the captured code \
       blobs (never regenerated).\n\
     - `run.sh` — the driver that runs every step in topological order with a \
       pinned seed + single-threaded BLAS, then runs `verify_outputs.sh`.\n\
     - `verify_outputs.sh` — the reproducibility VERDICT: it re-hashes each step's \
       regenerated outputs and compares them to the hashes recorded at capture time. \
       A `REPRODUCED` line proves every recorded output hash was regenerated \
       byte-identically here; it does NOT prove the science is correct, and steps \
       this capsule could not execute are reported `UNVERIFIED`, never reproduced. \
       (`Reproduce capsule complete.` on its own means only that no step crashed.)\n\
     - `readiness.json` — the reproducibility checklist for exactly these runs, \
       per-flag and per-run.\n\
     - `inputs.json` — the bundle-relative slot→data mapping.\n\
     - `methods.md` — a deterministic methods narrative + Key Resources Table.\n\
     - `manifest.json` — an RO-Crate-shaped provenance manifest.\n\
     - `manifest-sha256.txt` — the manifest checksum.\n\n\
     Run `bash run.sh` inside the pinned environment; its exit status is the \
     verification verdict.\n",
     verification_note)
}

/// A minimal STORE-method (uncompressed) ZIP writer — no external `zip` crate is
/// available, so a genuinely-valid `.zip` is assembled here (local headers +
/// central directory + EOCD, with a runtime CRC-32).
mod zipstore {
    pub struct ZipBuilder {
        buf: Vec<u8>,
        central: Vec<u8>,
        count: u16,
    }

    impl ZipBuilder {
        pub fn new() -> Self {
            Self { buf: Vec::new(), central: Vec::new(), count: 0 }
        }

        pub fn add(&mut self, name: &str, data: &[u8]) {
            let offset = self.buf.len() as u32;
            let crc = crc32(data);
            let name_bytes = name.as_bytes();
            let nlen = name_bytes.len() as u16;
            let size = data.len() as u32;

            // Local file header.
            self.buf.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            self.buf.extend_from_slice(&20u16.to_le_bytes()); // version needed
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // flags
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // method: store
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // mod time
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // mod date
            self.buf.extend_from_slice(&crc.to_le_bytes());
            self.buf.extend_from_slice(&size.to_le_bytes()); // comp size
            self.buf.extend_from_slice(&size.to_le_bytes()); // uncomp size
            self.buf.extend_from_slice(&nlen.to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // extra len
            self.buf.extend_from_slice(name_bytes);
            self.buf.extend_from_slice(data);

            // Central directory header.
            self.central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            self.central.extend_from_slice(&20u16.to_le_bytes()); // version made by
            self.central.extend_from_slice(&20u16.to_le_bytes()); // version needed
            self.central.extend_from_slice(&0u16.to_le_bytes()); // flags
            self.central.extend_from_slice(&0u16.to_le_bytes()); // method
            self.central.extend_from_slice(&0u16.to_le_bytes()); // time
            self.central.extend_from_slice(&0u16.to_le_bytes()); // date
            self.central.extend_from_slice(&crc.to_le_bytes());
            self.central.extend_from_slice(&size.to_le_bytes());
            self.central.extend_from_slice(&size.to_le_bytes());
            self.central.extend_from_slice(&nlen.to_le_bytes());
            self.central.extend_from_slice(&0u16.to_le_bytes()); // extra len
            self.central.extend_from_slice(&0u16.to_le_bytes()); // comment len
            self.central.extend_from_slice(&0u16.to_le_bytes()); // disk number
            self.central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            self.central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            self.central.extend_from_slice(&offset.to_le_bytes());
            self.central.extend_from_slice(name_bytes);

            self.count += 1;
        }

        pub fn finish(mut self) -> Vec<u8> {
            let cd_offset = self.buf.len() as u32;
            let cd_size = self.central.len() as u32;
            self.buf.extend_from_slice(&self.central);
            // End of central directory record.
            self.buf.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // disk number
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // cd disk
            self.buf.extend_from_slice(&self.count.to_le_bytes());
            self.buf.extend_from_slice(&self.count.to_le_bytes());
            self.buf.extend_from_slice(&cd_size.to_le_bytes());
            self.buf.extend_from_slice(&cd_offset.to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes()); // comment len
            self.buf
        }
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn crc32_known_vector() {
            // CRC-32 of "123456789" is 0xCBF43926.
            assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        }

        #[test]
        fn zip_has_valid_structure() {
            let mut z = ZipBuilder::new();
            z.add("a.txt", b"hello");
            z.add("data/dir/b.bin", &[0u8, 1, 2, 3, 255]);
            let bytes = z.finish();

            // Leads with a local file header signature.
            assert_eq!(&bytes[0..4], &0x0403_4b50u32.to_le_bytes());

            // Locate the fixed 22-byte EOCD record (no zip comment).
            let eocd = bytes.len() - 22;
            assert_eq!(
                &bytes[eocd..eocd + 4],
                &0x0605_4b50u32.to_le_bytes(),
                "EOCD signature at the tail"
            );

            let total = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]) as usize;
            let cd_size = u32::from_le_bytes([
                bytes[eocd + 12],
                bytes[eocd + 13],
                bytes[eocd + 14],
                bytes[eocd + 15],
            ]) as usize;
            let cd_offset = u32::from_le_bytes([
                bytes[eocd + 16],
                bytes[eocd + 17],
                bytes[eocd + 18],
                bytes[eocd + 19],
            ]) as usize;

            // The EOCD entry count matches the number of local file headers.
            let local_headers =
                bytes.windows(4).filter(|w| *w == 0x0403_4b50u32.to_le_bytes()).count();
            assert_eq!(total, 2, "EOCD records two entries");
            assert_eq!(local_headers, 2, "two local file headers present");

            // The central directory sits at cd_offset, spans cd_size up to the
            // EOCD, and each entry has a CEN header.
            assert_eq!(
                &bytes[cd_offset..cd_offset + 4],
                &0x0201_4b50u32.to_le_bytes(),
                "central-directory signature at cd_offset"
            );
            assert_eq!(cd_offset + cd_size, eocd, "central directory spans exactly up to the EOCD");
            let cen_headers = bytes[cd_offset..eocd]
                .windows(4)
                .filter(|w| *w == 0x0201_4b50u32.to_le_bytes())
                .count();
            assert_eq!(cen_headers, 2, "one central-directory header per entry");
        }
    }
}

#[cfg(test)]
mod science_params_tests {
    use super::*;
    use serde_json::json;

    fn row(params: serde_json::Value, env: Option<&str>) -> super::super::super::repository::RunReproRow {
        super::super::super::repository::RunReproRow {
            run_id: Uuid::nil(),
            project_id: None,
            dataset_id: None,
            kind: "compute".into(),
            status: "completed".into(),
            generator_id: "cell.filter".into(),
            generator_version: "0.1.0".into(),
            code_sha256: None,
            env_rootfs_sha256: env.map(str::to_string),
            lockfile_json: None,
            seed: Some(7),
            params,
            inputs_json: json!([]),
            rerun_spec_json: None,
            acting_user: None,
            started_at: None,
            finished_at: None,
            captured_at: chrono::Utc::now(),
        }
    }

    // TEST-11 (the fallback half) [ITEM-7/ITEM-8, DEC-9]: the export's trust
    // surfaces read the PROMOTED params first and the re-run spec second, and never
    // render `language`/`arch` as science from EITHER source.
    #[test]
    fn science_params_prefers_the_promoted_column_then_falls_back_to_the_rerun_spec() {
        let promoted = json!({ "criteria": [{ "column": "pct_counts_mito", "max": 10 }], "seed": 7 });
        let rerun = Some(json!({ "params": { "criteria": [{ "column": "stale", "max": 1 }] } }));
        let out = science_params(&promoted, &rerun);
        assert_eq!(out["criteria"][0]["column"], "pct_counts_mito", "the promoted column WINS");
        assert_eq!(out["seed"], 7);

        // A PRE-promotion run: its column is only `{seed, language, arch}` — not
        // science — so the science comes from the stashed re-run spec instead, and
        // the runtime metadata is dropped rather than presented as a parameter.
        let legacy = json!({ "seed": 7, "language": "python", "arch": "x86_64" });
        let out = science_params(&legacy, &rerun);
        assert_eq!(out["criteria"][0]["column"], "stale", "legacy run renders science via the fallback");
        assert_eq!(out["seed"], 7, "the recorded seed is carried across the fallback");
        assert!(out.get("language").is_none() && out.get("arch").is_none(), "no runtime metadata");

        // Neither source carries science → the seed alone. Nothing is invented, and
        // `readiness::params_captured` is what reports such a run not-ready.
        let out = science_params(&legacy, &None);
        assert_eq!(out, json!({ "seed": 7 }), "no science anywhere → seed only, nothing invented");

        // A run whose spec params are a non-object degrades the same way.
        let out = science_params(&legacy, &Some(json!({ "params": "not-an-object" })));
        assert_eq!(out, json!({ "seed": 7 }));
    }

    // The capsule's `environments.json` arch source after DEC-1 dropped `arch` from
    // the trust-view params: a PRE-promotion run still reports its recorded arch; a
    // promoted run reports one only when it pinned the rootfs embedded in THIS
    // binary (else `None` → "unknown", never a guessed arch).
    ///
    /// **F2-19** — every arm is asserted UNCONDITIONALLY. The embedded-digest leg
    /// used to sit behind `if !embedded.is_empty()` over a staged rootfs asset that
    /// is a permanent 0-byte fail-soft stub, so the branch this test exists to cover
    /// never executed in ANY normal build while the test reported `ok`. The digest is
    /// now injected via `run_arch_with`.
    #[test]
    fn run_arch_reads_the_legacy_column_then_the_pinned_environment() {
        // A fixed, non-empty stand-in for "the rootfs embedded in THIS binary".
        const EMBEDDED: &str = "a1b2c3d4e5f6000000000000000000000000000000000000000000000000beef";

        let legacy = row(json!({ "seed": 7, "arch": "aarch64" }), Some("deadbeef"));
        assert_eq!(
            run_arch_with(&legacy, EMBEDDED).as_deref(),
            Some("aarch64"),
            "pre-promotion run keeps its arch"
        );

        let promoted = row(json!({ "criteria": [], "seed": 7 }), Some("not-the-embedded-digest"));
        assert_eq!(run_arch_with(&promoted, EMBEDDED), None, "a foreign pinned digest yields no arch claim");

        let no_env = row(json!({ "criteria": [], "seed": 7 }), None);
        assert_eq!(run_arch_with(&no_env, EMBEDDED), None, "no pinned environment → no arch claim");

        // THE BRANCH THAT NEVER RAN: a run pinning THIS binary's embedded rootfs
        // executed on this binary's arch. Asserted for the bare-hex form AND the
        // `sha256:`-prefixed form (`normalize_digest`'s job), and in the UPPERCASE
        // spelling a hand-written digest can arrive in.
        for spelling in [EMBEDDED.to_string(), format!("sha256:{EMBEDDED}"), EMBEDDED.to_uppercase()] {
            let local = row(json!({ "criteria": [], "seed": 7 }), Some(&spelling));
            assert_eq!(
                run_arch_with(&local, EMBEDDED).as_deref(),
                Some(std::env::consts::ARCH),
                "a run pinning the embedded rootfs ({spelling}) reports this arch"
            );
        }

        // A build with NO embedded rootfs (the 0-byte stub) must never claim an arch
        // — the empty digest must not match an empty/blank pin.
        let stubbed = row(json!({ "criteria": [], "seed": 7 }), Some(EMBEDDED));
        assert_eq!(run_arch_with(&stubbed, ""), None, "no embedded rootfs → no arch claim");

        // And the production wrapper still resolves the real embedded digest.
        let real = crate::modules::rootfs::embedded::content_sha256_full();
        assert_eq!(
            run_arch(&row(json!({ "criteria": [], "seed": 7 }), Some("not-the-embedded-digest"))),
            None,
            "wrapper delegates (embedded digest here = {:?})",
            real.is_empty()
        );
    }

    fn compute_row(
        run_id: Uuid,
        code: Option<&str>,
        env: Option<&str>,
        inputs: serde_json::Value,
        rerun: Option<serde_json::Value>,
    ) -> super::super::super::repository::RunReproRow {
        let mut r = row(json!({ "criteria": [{ "column": "n", "min": 1 }], "seed": 7 }), env);
        r.run_id = run_id;
        r.code_sha256 = code.map(str::to_string);
        r.inputs_json = inputs;
        r.rerun_spec_json = rerun;
        r
    }

    fn good_rerun() -> serde_json::Value {
        json!({ "params": { "criteria": [{ "column": "n", "min": 1 }] } })
    }

    // F2-17 (LEDGER reproducibility-6/-10/-11): the export computes a readiness
    // verdict over the runs it actually carries, using the STRICT flags — the four
    // incomplete-provenance closures the auditor built (a ghost code blob, zero
    // used-edges, an unpinned compute run, uncaptured params) all reported
    // `ready: true` before this, and none of that verdict travelled in the bundle.
    #[test]
    fn bundle_readiness_reddens_the_closures_that_cannot_reproduce() {
        let root = vec![manifest::ManifestRoot {
            content_hash: "sha256:aa".into(),
            datatype: "expression".into(),
        }];
        let edges = json!([{ "slot": "expression", "kind": "artifact", "content_hash": "sha256:aa" }]);

        // A complete compute run: pinned+obtainable env, real code blob, checksummed
        // inputs, captured params → ready.
        let id = Uuid::new_v4();
        let ok = compute_row(id, Some("cafe"), None, edges.clone(), Some(good_rerun()));
        let mut ok = ok;
        // env_pinned for a compute run needs an OBTAINABLE digest; the default
        // obtainability seam answers for the embedded digest only, so use it.
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        ok.env_rootfs_sha256 = Some(if embedded.is_empty() { "deadbeef".into() } else { embedded });
        let blobs: HashMap<Uuid, Option<usize>> = [(id, Some(42usize))].into_iter().collect();
        let (dto, verdicts) = evaluate_bundle_readiness(&[&ok], &blobs, &root, &[], None);
        let env_ok = dto.env_pinned; // false on a stubbed-rootfs build (no obtainable digest)
        assert!(dto.code_captured && dto.inputs_checksummed && dto.params_captured && dto.seeds_set);
        assert_eq!(verdicts.len(), 1);
        assert_eq!(dto.ready, env_ok, "ready iff every flag incl. env_pinned passes");

        // (1) GHOST code blob: the hash is recorded, the blob is absent.
        let ghost: HashMap<Uuid, Option<usize>> = [(id, None)].into_iter().collect();
        let (d, _) = evaluate_bundle_readiness(&[&ok], &ghost, &root, &[], None);
        assert!(!d.code_captured && !d.ready, "a ghost code blob is NOT ready");

        // (2) zero used-edges on a compute run (and a MALFORMED inputs_json).
        for broken_inputs in [json!([]), json!("not-a-list"), json!({ "oops": 1 })] {
            let r = compute_row(id, Some("cafe"), ok.env_rootfs_sha256.as_deref(), broken_inputs.clone(), Some(good_rerun()));
            let (d, _) = evaluate_bundle_readiness(&[&r], &blobs, &root, &[], None);
            assert!(!d.inputs_checksummed && !d.ready, "inputs {broken_inputs} must not be ready");
        }

        // (3) an UNPINNED compute run — the capsule renders it as a no-op.
        let unpinned = compute_row(id, Some("cafe"), None, edges.clone(), Some(good_rerun()));
        let (d, _) = evaluate_bundle_readiness(&[&unpinned], &blobs, &root, &[], None);
        assert!(!d.env_pinned && !d.ready, "an unpinned compute run is NOT ready");

        // (4) uncaptured scientific params → replays on processor DEFAULTS.
        let paramless = compute_row(id, Some("cafe"), ok.env_rootfs_sha256.as_deref(), edges.clone(), None);
        let (d, _) = evaluate_bundle_readiness(&[&paramless], &blobs, &root, &[], None);
        assert!(!d.params_captured && !d.ready, "a params-less compute run is NOT ready");

        // (5) a root with no content hash.
        let (d, _) = evaluate_bundle_readiness(
            &[&ok],
            &blobs,
            &[manifest::ManifestRoot { content_hash: "  ".into(), datatype: "x".into() }],
            &[],
            None,
        );
        assert!(!d.roots_have_provenance && !d.ready);

        // The gap lines name the FLAG and the offending RUN so a third party can act.
        let (d, v) = evaluate_bundle_readiness(&[&paramless], &blobs, &root, &[], None);
        let gaps = readiness_gap_lines(&d, &v, &[], root.len(), None);
        assert!(gaps.iter().any(|g| g.starts_with("params_captured:")), "{gaps:?}");
        assert!(gaps.iter().any(|g| g.contains(&id.to_string())), "the run id is named: {gaps:?}");
    }

    /// ROUND-4 / R3-22 — the `roots_have_provenance` check could not see the ONE
    /// case it exists for.
    ///
    /// `build_bundle` builds `manifest_roots` by FILTERING the walk's artifacts +
    /// dataset nodes, so a carried root hash matching NEITHER (a reference-resource
    /// root, a pruned artifact, a hash from another tenant's store) is absent from
    /// that list — and `roots_have_provenance` folds over exactly that list. An
    /// unsourced root was therefore excluded from the very check meant to detect it:
    /// the bundle shipped `ready: true`, `data/<hash>` was never written (the
    /// staging loop skips an unknown source silently), and the capsule aborted at
    /// `stage_input` with "input object sha256:… is not available".
    ///
    /// RED BEFORE THE FIX: `evaluate_bundle_readiness` had no way to be told, so
    /// `[sourced_root].all(non-empty)` answered `true` and the closure was `ready`.
    #[test]
    fn a_carried_root_with_no_known_source_reddens_readiness() {
        let id = Uuid::new_v4();
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        let env = if embedded.is_empty() { "deadbeef".to_string() } else { embedded };
        // A run consuming TWO roots: one the bundle can source, one it cannot.
        let edges = json!([
            { "slot": "expression", "kind": "artifact", "content_hash": "sha256:aa" },
            { "slot": "reference", "kind": "reference", "content_hash": "sha256:orphan" },
        ]);
        let mut ok = compute_row(id, Some("cafe"), Some(&env), edges, Some(good_rerun()));
        ok.env_rootfs_sha256 = Some(env);
        let blobs: HashMap<Uuid, Option<usize>> = [(id, Some(42usize))].into_iter().collect();
        // Exactly what build_bundle passes today: only the SOURCED root made it into
        // `manifest_roots`; the unsourced hash is simply not there.
        let sourced_only = vec![manifest::ManifestRoot {
            content_hash: "sha256:aa".into(),
            datatype: "expression".into(),
        }];

        let (d, _) = evaluate_bundle_readiness(
            &[&ok],
            &blobs,
            &sourced_only,
            &[RootGap::unsourced("sha256:orphan")],
            None,
        );
        assert!(
            !d.roots_have_provenance,
            "a carried root the bundle has NO source for is precisely what this flag \
             exists to catch — it must not be excluded from its own check"
        );
        assert!(!d.ready, "…and such a bundle is not ready: the capsule aborts at stage_input");

        // The gap line names the offending hash so a reader can go find it.
        let (d, v) = evaluate_bundle_readiness(
            &[&ok],
            &blobs,
            &sourced_only,
            &[RootGap::unsourced("sha256:orphan")],
            None,
        );
        let gaps = readiness_gap_lines(&d, &v, &[RootGap::unsourced("sha256:orphan")], sourced_only.len(), None);
        assert!(
            gaps.iter().any(|g| g.starts_with("roots_have_provenance:") && g.contains("sha256:orphan")),
            "the unsourced root is named: {gaps:?}"
        );

        // Control: with every carried root sourced, the flag is unaffected.
        let (d, _) = evaluate_bundle_readiness(&[&ok], &blobs, &sourced_only, &[], None);
        assert!(d.roots_have_provenance, "a fully-sourced closure keeps its green flag");
    }

    /// ROUND-4b / R4B-01 — **the sibling arm round 4 left open.**
    ///
    /// Round 4 fixed the UNKNOWN-SOURCE arm by threading a bespoke `unsourced_roots`
    /// list in. The other arms of the same staging loop were untouched: when the
    /// artifact ROW EXISTS the hash IS in `manifest_roots`, so
    /// `roots.all(|r| !r.content_hash.is_empty())` answered TRUE and the bundle
    /// shipped `ready: true, gaps: []` plus a README claiming it "passes every
    /// condition" — over a capsule whose only root has NO BYTES, which then aborts at
    /// `stage_input`. The auditor reproduced this on a real exported bundle.
    ///
    /// The verdict is now derived from the staging OUTCOME (`roots_without_bytes`),
    /// so every arm is one check. This test drives the arms as the assembler builds
    /// them.
    ///
    /// RED BEFORE THE FIX: `evaluate_bundle_readiness(&[&ok], &blobs, &sourced_root,
    /// &[])` — which is exactly what the assembler passed for an unreadable blob —
    /// returned `roots_have_provenance: true, ready: true`.
    #[test]
    fn a_root_with_no_bytes_reddens_readiness_whatever_the_reason() {
        let id = Uuid::new_v4();
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        let env = if embedded.is_empty() { "deadbeef".to_string() } else { embedded };
        let edges = json!([{ "slot": "expression", "kind": "artifact", "content_hash": "sha256:aa" }]);
        let mut ok = compute_row(id, Some("cafe"), Some(&env), edges, Some(good_rerun()));
        ok.env_rootfs_sha256 = Some(env);
        let blobs: HashMap<Uuid, Option<usize>> = [(id, Some(42usize))].into_iter().collect();
        // The root IS in `manifest_roots` — the artifact row exists — so the old
        // non-empty-hash fold could never see any of these.
        let sourced = vec![manifest::ManifestRoot {
            content_hash: "sha256:aa".into(),
            datatype: "expression".into(),
        }];

        // Every way the staging loop can leave a ROOT without bytes. Each reason is
        // the string the assembler records; the flag must not care which one it is.
        for reason in [
            "the object store could not read work/aa: connection refused; fetch it yourself (see fetch.txt)",
            "over this deployment's export size cap (9999 bytes); fetch work/aa from the object store (see fetch.txt)",
            "no object store is configured in this deployment; fetch work/aa yourself (see fetch.txt)",
            "a MULTI-FILE artifact — no single blob to embed; fetch work/aa from the object store (see fetch.txt)",
            "dataset 00000000-0000-0000-0000-000000000000's file record is gone, so its bytes have no source",
            "dataset 00000000-0000-0000-0000-000000000000's file bytes could not be read: io error",
            "dataset 00000000-0000-0000-0000-000000000000's file size could not be read: io error",
            "dataset 00000000-0000-0000-0000-000000000000 is MULTI-FILE (or file-less), so its merkle root maps to no single blob; fetch each file from ziee-file (see fetch.txt)",
            "no source in this deployment — a reference-resource root, a pruned artifact, or a foreign hash; obtain the bytes and place them under data/",
            "no data/ member was written for this root and the export recorded no reason; its bytes are absent from this bundle",
        ] {
            let gap = RootGap { hash: "sha256:aa".into(), reason: reason.to_string() };
            let (d, v) = evaluate_bundle_readiness(&[&ok], &blobs, &sourced, &[gap.clone()], None);
            assert!(
                !d.roots_have_provenance,
                "a root with no bytes must redden readiness whatever the reason ({reason})"
            );
            assert!(!d.ready, "…and the bundle is NOT ready ({reason})");
            // …and the gap line is coherent: it names the hash AND why.
            let gaps = readiness_gap_lines(&d, &v, &[gap], sourced.len(), None);
            let line = gaps
                .iter()
                .find(|g| g.starts_with("roots_have_provenance:"))
                .unwrap_or_else(|| panic!("a roots gap line for {reason}: {gaps:?}"));
            assert!(line.contains("sha256:aa"), "names the hash: {line}");
            assert!(line.contains(reason), "names the reason: {line}");
            assert!(line.contains("stage_input"), "names the consequence: {line}");
        }

        // Control: a root whose bytes ARE staged keeps the flag green. (`ready` also
        // needs an OBTAINABLE env digest, which a stubbed-rootfs build does not have —
        // same caveat as `bundle_readiness_reddens_the_closures_that_cannot_reproduce`.)
        let (d, _) = evaluate_bundle_readiness(&[&ok], &blobs, &sourced, &[], None);
        assert!(d.roots_have_provenance, "a staged root keeps its green flag");
        assert_eq!(d.ready, d.env_pinned, "…and nothing else in this fixture is red");
    }

    /// ROUND-6 / A1 + A3 — **a recorded hole must never be DISCARDED, and this test
    /// drives the real derivation rather than a hand-built `RootGap`.**
    ///
    /// `a_root_with_no_bytes_reddens_readiness_whatever_the_reason` hands
    /// `evaluate_bundle_readiness` `RootGap`s it built itself, so it never touched
    /// [`derive_roots_without_bytes`] — the code that decides which of the staging
    /// loop's recorded holes reach the verdict at all. Round 4b derived only the
    /// STAGED side from the outcome; the CANDIDATE side stayed a classification
    /// (`manifest_roots`, built by filtering the walk's artifacts for
    /// `run_id.is_none()`, UNION `unsourced_roots`, which by construction holds only
    /// hashes with NO source row). A carried hash that has an artifact row but was
    /// produced by a run OUTSIDE the walked subdag is in neither: nothing in this
    /// bundle regenerates it, yet `manifest_roots` excludes it (its `run_id` is
    /// `Some`) and `unsourced_roots` excludes it (`by_hash` found it). Its recorded
    /// hole was silently dropped at the set difference and the bundle shipped
    /// `ready: true, gaps: []` with no bytes for it.
    ///
    /// RED BEFORE THE FIX: with the candidate set = `manifest_roots ∪
    /// unsourced_roots`, `derive_roots_without_bytes` returns an EMPTY vec for the
    /// ledger below and `roots_have_provenance` comes back true.
    #[test]
    fn a_recorded_hole_is_never_discarded_by_the_candidate_set() {
        let id = Uuid::new_v4();
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        let env = if embedded.is_empty() { "deadbeef".to_string() } else { embedded };
        let edges = json!([{ "slot": "expression", "kind": "artifact", "content_hash": "sha256:foreign" }]);
        let mut ok = compute_row(id, Some("cafe"), Some(&env), edges, Some(good_rerun()));
        ok.env_rootfs_sha256 = Some(env);
        let blobs: HashMap<Uuid, Option<usize>> = [(id, Some(42usize))].into_iter().collect();

        // The ledger the staging loop produces for a carried hash whose artifact row
        // exists but whose producing run is NOT in this subdag, and whose blob the
        // object store could not read.
        let holes: HashMap<String, String> = [(
            "sha256:foreign".to_string(),
            "the object store could not read work/foreign: connection refused; fetch it \
             yourself (see fetch.txt)"
                .to_string(),
        )]
        .into_iter()
        .collect();
        let staged: std::collections::HashSet<String> = std::collections::HashSet::new();
        // `run_id.is_none()` excluded it from `manifest_roots`; `by_hash` found it, so
        // the unsourced arm never ran. Both candidate lists are therefore EMPTY.
        let gaps = derive_roots_without_bytes(&[], &holes, &staged);

        assert_eq!(
            gaps.len(),
            1,
            "a hash the export RECORDED A HOLE for must survive into the verdict: {gaps:?}"
        );
        assert_eq!(gaps[0].hash, "sha256:foreign");
        assert!(gaps[0].reason.contains("connection refused"), "{:?}", gaps[0]);

        let (d, _) = evaluate_bundle_readiness(&[&ok], &blobs, &[], &gaps, None);
        assert!(
            !d.roots_have_provenance,
            "…and it reddens readiness, instead of shipping ready:true over a capsule \
             that aborts at stage_input"
        );
        assert!(!d.ready);

        // Control: the same hash, actually staged, is NOT a gap. (`holes` and `staged`
        // are disjoint in the assembler; the filter is the fail-closed backstop.)
        let mut staged_now = std::collections::HashSet::new();
        staged_now.insert("sha256:foreign".to_string());
        assert!(
            derive_roots_without_bytes(&[], &holes, &staged_now).is_empty(),
            "a staged hash is not a gap"
        );
    }

    /// ROUND-6 / A2 — **`roots_have_provenance` was vacuously TRUE on an EMPTY roots
    /// slice**, the identical `.all()`-over-nothing vacuity round 4b moved a guard
    /// INTO `readiness::evaluate` to close for `runs`, left open one field over.
    ///
    /// `roots.iter().all(|r| !r.content_hash.trim().is_empty())` is `true` for
    /// `roots == []`, so a bundle that declares NO root input at all asserted that its
    /// roots have provenance — and, with nothing else red, shipped `ready: true` over
    /// a capsule with nothing to reproduce FROM.
    ///
    /// RED BEFORE THE FIX: `evaluate_bundle_readiness(&[&ok], &blobs, &[], &[])`
    /// returned `roots_have_provenance: true`, and the gap list was empty.
    #[test]
    fn an_empty_roots_slice_is_not_provenance() {
        let id = Uuid::new_v4();
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        let env = if embedded.is_empty() { "deadbeef".to_string() } else { embedded };
        let edges = json!([{ "slot": "expression", "kind": "artifact", "content_hash": "sha256:aa" }]);
        let mut ok = compute_row(id, Some("cafe"), Some(&env), edges, Some(good_rerun()));
        ok.env_rootfs_sha256 = Some(env);
        let blobs: HashMap<Uuid, Option<usize>> = [(id, Some(42usize))].into_iter().collect();

        let (d, v) = evaluate_bundle_readiness(&[&ok], &blobs, &[], &[], None);
        assert!(
            !d.roots_have_provenance,
            "a bundle that declares NO root input has nothing to reproduce FROM; \
             `.all()` over an empty slice must not assert otherwise"
        );
        assert!(!d.ready, "…so it is not ready");

        // …and the reader is told WHICH of the two roots failures it is: no root at
        // all, not "a root carries no content hash" (there is no root to carry one).
        let gaps = readiness_gap_lines(&d, &v, &[], 0, None);
        let line = gaps
            .iter()
            .find(|g| g.starts_with("roots_have_provenance:"))
            .unwrap_or_else(|| panic!("a roots gap line: {gaps:?}"));
        assert!(line.contains("no root input"), "names the real cause: {line}");
        assert!(
            !line.contains("carries no content hash"),
            "…and not the other cause, which did not happen: {line}"
        );

        // Control: one real, staged root keeps the flag green.
        let sourced = vec![manifest::ManifestRoot {
            content_hash: "sha256:aa".into(),
            datatype: "expression".into(),
        }];
        let (d, _) = evaluate_bundle_readiness(&[&ok], &blobs, &sourced, &[], None);
        assert!(d.roots_have_provenance, "a real staged root keeps its green flag");
    }

    /// ROUND-4b / R4B-09 — the in-app badge and the export must report the SAME
    /// issue set.
    ///
    /// `LineagePane::ReadinessBadge` renders "⚠ N issues" where N counts the FALSE
    /// flags on this same `ReadinessDto`. The export used to derive its bullets by a
    /// different rule: an EMPTY closure short-circuited to one `no_runs:` line while
    /// the DTO carried five false flags, so the same closure read "⚠ 5 issues" in the
    /// app and shipped one bullet in `readiness.json` — whose own `flags` block then
    /// contradicted its own `gaps` block.
    ///
    /// The invariant: **exactly one gap line per false flag, in every case.**
    ///
    /// RED BEFORE THE FIX: the empty-closure case yields `gaps.len() == 1` against
    /// `false_flags == 5`.
    #[test]
    fn gap_lines_are_symmetric_with_the_badges_issue_count() {
        let count_false = |d: &crate::modules::provenance::models::ReadinessDto| {
            [
                d.code_captured,
                d.env_pinned,
                d.inputs_checksummed,
                d.params_captured,
                d.roots_have_provenance,
                d.seeds_set,
            ]
            .iter()
            .filter(|f| !**f)
            .count()
        };

        let id = Uuid::new_v4();
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        let env = if embedded.is_empty() { "deadbeef".to_string() } else { embedded };
        let edges = json!([{ "slot": "expression", "kind": "artifact", "content_hash": "sha256:aa" }]);
        let mut ok = compute_row(id, Some("cafe"), Some(&env), edges.clone(), Some(good_rerun()));
        ok.env_rootfs_sha256 = Some(env.clone());
        let blobs: HashMap<Uuid, Option<usize>> = [(id, Some(42usize))].into_iter().collect();
        let ghost: HashMap<Uuid, Option<usize>> = [(id, None)].into_iter().collect();
        let root = vec![manifest::ManifestRoot {
            content_hash: "sha256:aa".into(),
            datatype: "expression".into(),
        }];
        let orphan = [RootGap::unsourced("sha256:orphan")];
        let paramless = compute_row(id, Some("cafe"), Some(&env), edges, None);

        type Row<'a> = &'a crate::modules::provenance::repository::RunReproRow;
        let cases: Vec<(&str, Vec<Row<'_>>, &HashMap<Uuid, Option<usize>>, &[RootGap])> = vec![
            ("EMPTY closure", vec![], &blobs, &[]),
            ("EMPTY closure + an unsourced root", vec![], &blobs, &orphan),
            ("a complete run", vec![&ok], &blobs, &[]),
            ("a ghost code blob", vec![&ok], &ghost, &[]),
            ("a byte-less root", vec![&ok], &blobs, &orphan),
            ("a params-less run AND a byte-less root", vec![&paramless], &ghost, &orphan),
        ];
        for (name, runs, blob_map, gaps_in) in cases {
            let (d, v) = evaluate_bundle_readiness(&runs, blob_map, &root, gaps_in, None);
            let lines = readiness_gap_lines(&d, &v, gaps_in, root.len(), None);
            assert_eq!(
                lines.len(),
                count_false(&d),
                "[{name}] the export must print exactly one bullet per FALSE flag — the \
                 badge counts the same flags, so any other count makes the two surfaces \
                 disagree about the same closure.\nflags = {d:?}\nlines = {lines:#?}"
            );
            // Coherence in BOTH directions: never a warning banner with no cause, and
            // never a green claim with an outstanding bullet.
            assert_eq!(
                lines.is_empty(),
                d.ready,
                "[{name}] `ready` and 'no gaps' are the same fact: an empty bullet list under \
                 'the failing conditions are:' and a '0 issues' warning are the two nonsense \
                 renderings this invariant prevents.\nflags = {d:?}\nlines = {lines:#?}"
            );
            for l in &lines {
                assert!(!l.ends_with("(runs: )"), "[{name}] a bullet that names no cause: {l}");
            }
        }

        // The empty closure specifically: five bullets, each stating the ONE cause.
        let (d, v) = evaluate_bundle_readiness(&[], &blobs, &root, &[], None);
        let lines = readiness_gap_lines(&d, &v, &[], root.len(), None);
        assert_eq!(lines.len(), 5, "{lines:#?}");
        for l in &lines {
            assert!(
                l.contains("no captured run in this closure establishes it"),
                "every empty-closure bullet names the single cause: {l}"
            );
        }
        // …and the README renders them, never "the failing conditions are:" + nothing.
        let readme = reproducing_readme(false, &d, &lines);
        assert!(readme.contains("INCOMPLETE PROVENANCE"), "{readme}");
        assert_eq!(
            readme.matches("\n> - ").count(),
            5,
            "the banner lists every bullet: {readme}"
        );
    }

    // F2-17(c): REPRODUCING.md must not assert completeness it has not checked.
    #[test]
    fn reproducing_readme_claims_completeness_only_when_readiness_passes() {
        let ready = crate::modules::provenance::models::ReadinessDto {
            seeds_set: true,
            env_pinned: true,
            inputs_checksummed: true,
            code_captured: true,
            params_captured: true,
            roots_have_provenance: true,
            ready: true,
        };
        let text = reproducing_readme(false, &ready, &[]);
        assert!(text.contains("reports no gap"), "{text}");
        assert!(!text.contains("INCOMPLETE PROVENANCE"));

        let not_ready = crate::modules::provenance::models::ReadinessDto {
            code_captured: false,
            ready: false,
            ..ready
        };
        let gaps = vec!["code_captured: the captured code is MISSING (runs: r1)".to_string()];
        let text = reproducing_readme(false, &not_ready, &gaps);
        assert!(
            !text.contains("contains everything needed to re-run"),
            "an unchecked completeness claim must not ship: {text}"
        );
        assert!(text.contains("INCOMPLETE PROVENANCE"), "{text}");
        assert!(text.contains("code_captured"), "the failing flag is named: {text}");
        assert!(text.contains("(runs: r1)"), "the affected run is named: {text}");
    }

    /// ROUND-6 / A5 — **the affirmative banner contradicted the same bundle's own
    /// verifier.**
    ///
    /// The banner asserted the closure "passes every condition: seeds recorded,
    /// environments pinned + obtainable, inputs checksummed, code captured, and
    /// scientific parameters captured" — over flags that are KIND-SCOPED: an
    /// interaction/selection run pins no rootfs and captures no code at all, and
    /// `env_pinned_flag_for_kind` / `code_captured_flag` answer true for it on the
    /// generator version alone. So a provenance-only closure shipped that banner in
    /// the SAME zip as a `verify_outputs.sh` that reports `NOT VERIFIED: nothing in
    /// this closure was checkable, so nothing was compared.` The third-party-facing
    /// deliverable contradicted itself about whether the capsule was verified.
    ///
    /// The banner now says only what the export can know — what was RECORDED — and
    /// names `verify_outputs.sh` as the sole source of a verification verdict.
    ///
    /// RED BEFORE THE FIX: the affirmative banner enumerated the kind-scoped flags as
    /// satisfied conditions and never mentioned that nothing had been re-executed.
    #[test]
    fn the_ready_banner_does_not_assert_a_verification_it_did_not_perform() {
        let ready = crate::modules::provenance::models::ReadinessDto {
            seeds_set: true,
            env_pinned: true,
            inputs_checksummed: true,
            code_captured: true,
            params_captured: true,
            roots_have_provenance: true,
            ready: true,
        };
        let text = reproducing_readme(false, &ready, &[]);
        let banner = text.split("Contents:").next().expect("the banner precedes Contents");

        assert!(
            !banner.contains("passes every condition"),
            "the checklist records what was CAPTURED; it does not certify the closure: {banner}"
        );
        assert!(
            !banner.contains("environments pinned + obtainable"),
            "…and it must not enumerate a kind-scoped flag as an unqualified property \
             of the capsule (an interaction run pins no rootfs at all): {banner}"
        );
        assert!(
            banner.contains("not a verification"),
            "the banner must say that nothing has been re-executed: {banner}"
        );
        assert!(
            banner.contains("verify_outputs.sh"),
            "…and name the one thing that DOES produce a verification verdict: {banner}"
        );
        assert!(
            banner.contains("NOT VERIFIED"),
            "…including the verdict a provenance-only closure legitimately gets, so \
             the reader does not read it as a contradiction: {banner}"
        );
    }

    // F2-16: a MISSING code blob becomes a stub that REFUSES to run, in the step's
    // own language — never a comment the capsule executes to a silent exit 0.
    #[test]
    fn a_missing_code_blob_becomes_a_hard_failing_stub() {
        let id = Uuid::new_v4();
        let py = missing_code_stub("python", id, "d0d0");
        assert!(py.contains("sys.exit(1)"), "python stub exits non-zero: {py}");
        assert!(py.contains(&id.to_string()) && py.contains("d0d0"), "names the gap: {py}");
        assert!(!py.trim_start().starts_with('#'), "never a comment-only stub: {py}");

        let r = missing_code_stub("r", id, "d0d0");
        assert!(r.contains("quit(status = 1)"), "R stub exits non-zero: {r}");

        let sh = missing_code_stub("bash", id, "d0d0");
        assert!(sh.contains("exit 1"), "bash stub exits non-zero: {sh}");
        // A crafted hash can't break out of the generated shell command.
        let evil = missing_code_stub("bash", id, "'; rm -rf /; echo '");
        assert!(!evil.contains("; rm -rf /; echo ;"), "single-quoted: {evil}");
        assert!(evil.contains("'\\''"), "quotes are escaped: {evil}");

        // PROVENANCE-GAPS.md records it for the reader.
        let md = provenance_gaps_md(&[(id, "d0d0".to_string())], None);
        assert!(md.contains(&id.to_string()) && md.contains("sha256:d0d0"), "{md}");
        assert!(md.contains("REFUSES to run"), "{md}");
    }

    /// The capsule stages the shared runtime modules the sandbox stages into every
    /// Python entry's code dir — and says so when it could not.
    ///
    /// RED BEFORE THE FIX in the harshest way available: `grep` over the whole of
    /// `export/` returned ZERO references to any of them, so a capsule's `/code` held
    /// the recorded entry and nothing else. Every migrated entry in the shipped tree
    /// imports one, so the reproduce guarantee was not degraded — it was empty, and it
    /// failed with an import error inside a rootfs rather than anywhere a reader looks.
    ///
    /// Asserted as separate properties because they fail for different reasons: the
    /// member PREFIX the two files must agree on, the per-step decision (what the
    /// RECORDED run staged — see the R19-03 arm below), and the gap being RECORDED
    /// when the modules cannot be read rather than silently producing a broken capsule.
    ///
    /// **ROUND-19 (R19-03) — the per-step decision was widened, and the claim it used
    /// to make was false.** It read `language == python`, on the stated ground that
    /// "the live sandbox stages them for PYTHON entries only". That is the `code_ref`
    /// branch; an INLINE-SCRIPT run resolves to `helpers: Vec::new()` and its `/code`
    /// held the entry alone — so the capsule copied six modules into a step that never
    /// had them, which is the same "different run" this module refuses R18-02's cheap
    /// fix by. The decision now reads `Step::staged_shared_helpers`, derived from the
    /// recorded spec by `run_staged_shared_helpers` (whose own arms are pinned by
    /// `the_capsule_stages_only_what_the_recorded_run_staged`).
    #[test]
    fn the_capsule_stages_the_shared_runtime_modules_for_python_steps() {
        let step =
            |lang: &str, code: Option<&str>, env: Option<&str>, staged: bool| reproduce_script::Step {
                run_id: Uuid::new_v4(),
                kind: "compute".into(),
                code_sha256: code.map(str::to_string),
                script_name: "scripts/step_00_x.py".into(),
                language: lang.into(),
                env_digest: env.map(str::to_string),
                arch: Some("x86_64".into()),
                seed: Some(0),
                params: serde_json::json!({}),
                work_dir: "work/00".into(),
                inputs: vec![],
                staged_shared_helpers: staged,
            };

        assert!(
            reproduce_script::step_stages_helpers(&step("python", Some("aa"), Some("bb"), true)),
            "an executable Python step whose run HAD them needs them — its entry alone \
             does not import"
        );
        assert!(
            !reproduce_script::step_stages_helpers(&step("bash", Some("aa"), Some("bb"), false)),
            "a shell step must NOT get files its recorded run never had in /code"
        );
        assert!(
            !reproduce_script::step_stages_helpers(&step("python", None, Some("bb"), true)),
            "a step with no captured code is never executed, so it stages nothing"
        );
        assert!(
            !reproduce_script::step_stages_helpers(&step("python", Some("aa"), None, true)),
            "…nor is a step with no pinned environment"
        );
        // R19-03: a PYTHON step whose recorded run staged nothing (an inline-script
        // job) stages nothing here either — the language does not decide this.
        assert!(
            !reproduce_script::step_stages_helpers(&step("python", Some("aa"), Some("bb"), false)),
            "an inline-script run's /code held its entry ALONE; a capsule that adds six \
             modules to it is a different run, not a safer one"
        );

        // The prefix is agreed on by NAME, not by two spellings that happen to match.
        assert!(
            reproduce_script::HELPER_MEMBER_PREFIX.starts_with("scripts/"),
            "staged under the prefix `capsule_regenerated_hashes` treats as carried-in \
             code, so it is never mistaken for a regenerated output: {}",
            reproduce_script::HELPER_MEMBER_PREFIX
        );

        // …and the gap is recorded when they cannot be read.
        let md = provenance_gaps_md(&[], Some("seed not extractable"));
        assert!(
            md.contains("seed not extractable") && md.contains("import error"),
            "a capsule that could not stage them says so, naming the symptom: {md}"
        );
    }

    /// ROUND-19 / R19-03 — **the capsule stages what the RECORDED run staged, and the
    /// discriminator is in the recorded spec, not in the language.**
    ///
    /// The predicate this feeds used to be `language == python`, citing
    /// `processors::resolve_in`'s `Language::Python` gate. `resolve_in` is the
    /// `code_ref` branch: `AnalysisSpec::resolve_entry` short-circuits an INLINE
    /// `script` to `helpers: Vec::new()` and never consults it, and `jobs::runner`
    /// stages exactly `resolved.helpers`. So a `jobs::use` user's inline-python run —
    /// which the branch's own `dataset::capsule_multistep_test` performs twice — had
    /// `entry.py` alone in `/code` while its capsule got six modules beside it.
    ///
    /// RED BEFORE THE FIX: the first assertion below, which is the inline arm.
    ///
    /// This is the one direction the exporter can answer from what is already
    /// recorded. The other — a `code_ref` run's package-DECLARED siblings (R18-02) —
    /// still cannot be expressed by one shared `scripts/helpers/`, so the bound the
    /// pair now holds is one-directional: the capsule's `/code` may be SHORT of the
    /// recorded run's, never a superset of it.
    #[test]
    fn the_capsule_stages_only_what_the_recorded_run_staged() {
        let inline = json!({ "language": "python", "script": "print(1)\n", "seed": 0 });
        let by_ref = json!({ "language": "python", "code_ref": "compute/x.py", "seed": 0 });
        // A `code_ref` spec serialized with its empty option — the key is present and
        // null, which is NOT an inline script.
        let null_script = json!({ "language": "python", "script": null, "code_ref": "compute/x.py" });

        assert!(
            !run_staged_shared_helpers("python", &Some(inline)),
            "an inline-script run's /code held its entry ALONE"
        );
        assert!(
            run_staged_shared_helpers("python", &Some(by_ref)),
            "a code_ref python run resolved through resolve_in, which stages them"
        );
        assert!(
            run_staged_shared_helpers("python", &Some(null_script)),
            "`script: null` is a code_ref spec, not an inline one"
        );
        assert!(
            run_staged_shared_helpers("python", &None),
            "no recorded spec ⇒ the historical answer, so a pre-stash code_ref run does \
             not silently lose the modules `c38a4355` restored"
        );
        for lang in ["bash", "r", "sh", "", "unknown"] {
            assert!(
                !run_staged_shared_helpers(lang, &None),
                "{lang}: a non-Python entry never received them on any path"
            );
        }
        assert!(
            !run_staged_shared_helpers("r", &Some(json!({ "code_ref": "compute/x.R" }))),
            "…and a code_ref spec does not override that"
        );
    }

    /// ROUND-18 / R18-01 — **the helper gap must reach the MACHINE-readable verdict,
    /// not only `PROVENANCE-GAPS.md`.**
    ///
    /// The commit that introduced the gap wired it into the human-readable member
    /// alone: `evaluate_bundle_readiness` and `readiness_gap_lines` took no helper
    /// argument, so a bundle whose `scripts/helpers/` the exporter KNEW to be empty —
    /// i.e. one that cannot start a single Python step — still shipped
    /// `readiness.json` = `{"ready": true, "code_captured": true, "gaps": []}` and
    /// REPRODUCING.md's affirmative "reports no gap" banner. The weaker treatment
    /// landed on the WORSE failure mode: an absent code blob makes the step refuse to
    /// run naming its own hash, while absent shared modules let it start and die on an
    /// opaque `ModuleNotFoundError` inside a rootfs.
    ///
    /// RED BEFORE THE FIX: the assertions below on the SECOND arm — `code_captured`
    /// and `ready` were both `true`, and `readiness_gap_lines` returned no line.
    ///
    /// **ROUND-19 (R19-01) — what this test does NOT guard, stated because it was
    /// mistaken for a guard it is not.** It hands both functions a [`HelperGap`] it
    /// BUILT, so it pins their contract and nothing about the assembler that has to
    /// build one. Both mutations that undo the wiring were green with it passing (see
    /// [`assemble_readiness`]). The wiring's guard is the sibling test below, which
    /// reads the emitted `readiness.json`; this one is the contract underneath it, and
    /// the two are not interchangeable.
    #[test]
    fn an_unstageable_helper_seed_reddens_the_machine_readable_verdict() {
        let staged = Uuid::new_v4();
        let untouched = Uuid::new_v4();
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        let env = if embedded.is_empty() { "deadbeef".to_string() } else { embedded };
        let edges = json!([{ "slot": "expression", "kind": "artifact", "content_hash": "sha256:aa" }]);
        // Two complete compute runs: real code blob, checksummed inputs, captured
        // params, pinned env. Only the first one's step stages the shared modules.
        let a = compute_row(staged, Some("cafe"), Some(&env), edges.clone(), Some(good_rerun()));
        let b = compute_row(untouched, Some("f00d"), Some(&env), edges, Some(good_rerun()));
        let blobs: HashMap<Uuid, Option<usize>> =
            [(staged, Some(42usize)), (untouched, Some(42usize))].into_iter().collect();
        let root = vec![manifest::ManifestRoot {
            content_hash: "sha256:aa".into(),
            datatype: "expression".into(),
        }];
        let count_false = |d: &crate::modules::provenance::models::ReadinessDto| {
            [
                d.code_captured,
                d.env_pinned,
                d.inputs_checksummed,
                d.params_captured,
                d.roots_have_provenance,
                d.seeds_set,
            ]
            .iter()
            .filter(|f| !**f)
            .count()
        };

        // NEGATIVE CONTROL — the helpers WERE staged. The flag this gap moves is
        // green, the bundle carries no code bullet, and the verdict is as ready as
        // this build allows. (`env_pinned` needs an OBTAINABLE rootfs digest, which a
        // stubbed-rootfs build has not got — the same caveat
        // `bundle_readiness_reddens_the_closures_that_cannot_reproduce` carries — so
        // "complete ⇒ ready" is asserted as `ready == env_pinned`, which is the whole
        // claim on a real build and an honest one on a stub.)
        let (base, base_v) = evaluate_bundle_readiness(&[&a, &b], &blobs, &root, &[], None);
        let base_lines = readiness_gap_lines(&base, &base_v, &[], root.len(), None);
        assert!(base.code_captured, "control: both entry blobs are present");
        assert_eq!(base.ready, base.env_pinned, "control: nothing else in this fixture is red");
        assert!(
            !base_lines.iter().any(|l| l.starts_with("code_captured:")),
            "control: a complete capsule ships no code bullet: {base_lines:?}"
        );
        assert!(base_v.iter().all(|v| v.code_captured), "control: {base_v:?}");

        // THE GAP — the seed could not be read, so `scripts/helpers/` is empty.
        let gap = HelperGap {
            reason: "extract seed package: permission denied".to_string(),
            runs: vec![staged],
        };
        let (d, v) = evaluate_bundle_readiness(&[&a, &b], &blobs, &root, &[], Some(&gap));
        assert!(
            !d.code_captured,
            "a step whose /code holds its entry but not the modules that entry IMPORTS \
             does not have its code captured in this bundle: {d:?}"
        );
        assert!(
            !d.ready,
            "…so the capsule is NOT ready — this is the exact `ready: true`-over-a-broken \
             -capsule state the file has closed four times: {d:?}"
        );
        // Exactly one flag moves, and it moves for exactly the run whose step would
        // have received them — never for a run the capsule stages nothing into.
        assert_eq!(
            (d.seeds_set, d.env_pinned, d.inputs_checksummed, d.params_captured, d.roots_have_provenance),
            (
                base.seeds_set,
                base.env_pinned,
                base.inputs_checksummed,
                base.params_captured,
                base.roots_have_provenance
            ),
            "the helper gap moves `code_captured` and nothing else"
        );
        let verdict = |id: Uuid| v.iter().find(|r| r.run_id == id).expect("a verdict per run");
        assert!(!verdict(staged).code_captured, "the run that needed them is red");
        assert!(
            verdict(untouched).code_captured,
            "…and a run outside the gap's list keeps its green flag: {v:?}"
        );

        // The bullet SAYS SO: it names the flag, the reason, the affected run, and the
        // symptom — a reader of `readiness.json` alone must not have to guess why.
        let lines = readiness_gap_lines(&d, &v, &[], root.len(), Some(&gap));
        let line = lines
            .iter()
            .find(|l| l.starts_with("code_captured:"))
            .unwrap_or_else(|| panic!("a code_captured bullet: {lines:?}"));
        assert!(line.contains("extract seed package: permission denied"), "names why: {line}");
        assert!(line.contains(&staged.to_string()), "names the run: {line}");
        assert!(!line.contains(&untouched.to_string()), "…and only that run: {line}");
        assert!(line.contains("process start"), "names the symptom: {line}");

        // R4B-09's invariant survives the new cause: ONE bullet per false flag, so the
        // in-app badge's "⚠ N issues" and the export still count the same closure the
        // same way — the helper gap is a REASON inside the `code_captured` line, never
        // a seventh bullet with no flag behind it.
        assert_eq!(lines.len(), count_false(&d), "flags = {d:?}\nlines = {lines:#?}");
        assert_eq!(lines.is_empty(), d.ready, "flags = {d:?}\nlines = {lines:#?}");

        // …and REPRODUCING.md must not print its affirmative banner over it.
        let readme = reproducing_readme(false, &d, &lines);
        assert!(readme.contains("INCOMPLETE PROVENANCE"), "{readme}");
        assert!(!readme.contains("reports no gap"), "{readme}");
        assert!(
            !readme.contains("contains everything needed to re-run"),
            "an unchecked completeness claim must not ship over an empty helpers dir: {readme}"
        );
    }

    /// ROUND-19 / R19-01 — **the gap must reach the EMITTED `readiness.json`, over the
    /// assembler's own data flow.**
    ///
    /// The sibling test above hands `evaluate_bundle_readiness` / `readiness_gap_lines`
    /// a `HelperGap` it built, so it observes their contract and NOTHING about the code
    /// that has to build one. That left R18-01's actual fix — the two `helper_gap`
    /// arguments, and the `runs` list derived from `step_stages_helpers` — asserted by
    /// nothing, which was measured, not inferred: at `39b308e9`, passing `None` at both
    /// call sites (byte-for-byte the pre-fix data flow) gave `cargo test --lib` **537
    /// passed / 0 failed**, and replacing the `runs` derivation with `Vec::new()` gave
    /// **19 / 0** over this module. A recorded oracle claiming otherwise shipped in that
    /// commit message; it is corrected in `TEST_RESULTS.md`.
    ///
    /// So this test drives [`assemble_readiness`] — the whole flow from "the reader
    /// failed" to the member bytes — and reads the JSON it emits. It is RED under both
    /// mutations by construction:
    ///   - `helper_gap.as_ref()` → `None` at either call site: `flags.code_captured`
    ///     stays `true` and no `code_captured:` bullet is emitted;
    ///   - `runs: Vec::new()`: the gap reddens no run, so the flag, the per-run verdict
    ///     and the bullet all revert — while the SUCCEEDING arm below stays green, so a
    ///     mutation cannot be mistaken for a broken fixture.
    ///
    /// The reader is the ONLY thing faked. Everything downstream of it — the predicate
    /// deciding which steps stage, the gap's run list, the verdict, the bullets, the
    /// serialization — is the production path `build_bundle` runs.
    #[test]
    fn an_unstageable_helper_seed_reddens_the_emitted_readiness_json() {
        let staged = Uuid::new_v4();
        let untouched = Uuid::new_v4();
        let embedded = crate::modules::rootfs::embedded::content_sha256_full();
        let env = if embedded.is_empty() { "deadbeef".to_string() } else { embedded };
        let step = |run_id: Uuid, lang: &str| reproduce_script::Step {
            run_id,
            kind: "compute".into(),
            code_sha256: Some("cafe".into()),
            script_name: format!("scripts/step_00_x.{}", reproduce_script::lang_ext_interp(lang).0),
            language: lang.into(),
            env_digest: Some(env.clone()),
            arch: Some("x86_64".into()),
            seed: Some(7),
            params: json!({}),
            work_dir: "work/00".into(),
            inputs: vec![],
            // R19-03: what the RECORDED run's /code held — a `code_ref` python run
            // got them, a shell run did not.
            staged_shared_helpers: lang == "python",
        };
        // One step that stages the shared modules and one that does not — so an
        // over-broad `runs` list (every step, ignoring the predicate) is caught too,
        // not only an empty one.
        let steps = vec![step(staged, "python"), step(untouched, "bash")];

        let edges = json!([{ "slot": "expression", "kind": "artifact", "content_hash": "sha256:aa" }]);
        let a = compute_row(staged, Some("cafe"), Some(&env), edges.clone(), Some(good_rerun()));
        let b = compute_row(untouched, Some("f00d"), Some(&env), edges, Some(good_rerun()));
        let rows = [&a, &b];
        let blobs: HashMap<Uuid, Option<usize>> =
            [(staged, Some(42usize)), (untouched, Some(42usize))].into_iter().collect();
        let roots = vec![manifest::ManifestRoot {
            content_hash: "sha256:aa".into(),
            datatype: "expression".into(),
        }];
        let assemble = |read: &dyn Fn() -> Result<Vec<(&'static str, Vec<u8>)>, String>| {
            assemble_readiness(&steps, read, &rows, &blobs, &roots, &[])
                .expect("the assembler serializes its own verdict")
        };
        let emitted = |a: &ReadinessAssembly| -> serde_json::Value {
            serde_json::from_slice(&a.readiness_bytes).expect("readiness.json is valid JSON")
        };

        // ── NEGATIVE CONTROL: the reader SUCCEEDS ────────────────────────────────
        // The members are written under the agreed prefix, no gap is reported, and the
        // verdict is as ready as this build allows (`env_pinned` needs an OBTAINABLE
        // digest, which a stubbed-rootfs build has not got — the same caveat the
        // sibling tests carry — so "complete ⇒ ready" is asserted as
        // `ready == env_pinned`).
        let ok = assemble(&|| Ok(vec![("cyto_columns.py", b"# helper\n".to_vec())]));
        let ok_json = emitted(&ok);
        assert_eq!(
            ok.helper_members,
            vec![(
                format!("{}cyto_columns.py", reproduce_script::HELPER_MEMBER_PREFIX),
                b"# helper\n".to_vec()
            )],
            "the read modules are written under the prefix run.sh copies from"
        );
        assert!(ok.helper_gap_reason.is_none(), "control: nothing to report");
        assert_eq!(ok_json["flags"]["code_captured"], json!(true), "control: {ok_json:#}");
        assert_eq!(
            ok_json["ready"], ok_json["flags"]["env_pinned"],
            "control: nothing but the obtainability of the pinned rootfs is red here: {ok_json:#}"
        );
        let ok_gaps: Vec<String> = serde_json::from_value(ok_json["gaps"].clone()).unwrap();
        assert!(
            !ok_gaps.iter().any(|l| l.starts_with("code_captured:")),
            "control: a capsule whose helpers were staged ships no code bullet: {ok_gaps:?}"
        );

        // ── THE GAP: the reader FAILS ────────────────────────────────────────────
        let why = "extract seed package: permission denied";
        let gap = assemble(&|| Err(why.to_string()));
        let gap_json = emitted(&gap);
        assert!(gap.helper_members.is_empty(), "nothing was read, so nothing is written");
        assert_eq!(gap.helper_gap_reason.as_deref(), Some(why), "PROVENANCE-GAPS.md's reason");

        // The EMITTED verdict — this is the artifact a third party reads, and it is
        // what the two mutations restore to green.
        assert_eq!(
            gap_json["flags"]["code_captured"],
            json!(false),
            "a step whose /code holds its entry but not the modules that entry IMPORTS \
             does not have its code captured in this bundle: {gap_json:#}"
        );
        assert_eq!(
            gap_json["ready"],
            json!(false),
            "…so the capsule is NOT ready — the `ready: true`-over-a-broken-capsule state \
             this file has closed five times: {gap_json:#}"
        );
        // Exactly one flag moves, and only for the run whose step would have received
        // them: an over-broad or empty `runs` list fails one of these two.
        let untouched_flags =
            ["seeds_set", "env_pinned", "inputs_checksummed", "params_captured", "roots_have_provenance"];
        for flag in untouched_flags {
            assert_eq!(
                gap_json["flags"][flag], ok_json["flags"][flag],
                "the helper gap moves `code_captured` and nothing else; {flag} moved: {gap_json:#}"
            );
        }
        let verdict = |json: &serde_json::Value, id: Uuid| -> bool {
            json["runs"]
                .as_array()
                .expect("per-run verdicts")
                .iter()
                .find(|v| v["run_id"] == json!(id.to_string()))
                .unwrap_or_else(|| panic!("a verdict for {id}"))["code_captured"]
                .as_bool()
                .expect("a bool flag")
        };
        assert!(!verdict(&gap_json, staged), "the run that needed them is red: {gap_json:#}");
        assert!(
            verdict(&gap_json, untouched),
            "…and the run whose step stages nothing keeps its green flag: {gap_json:#}"
        );

        // The bullet SAYS SO: flag, reason, the affected run, and the symptom.
        let gaps: Vec<String> = serde_json::from_value(gap_json["gaps"].clone()).unwrap();
        let line = gaps
            .iter()
            .find(|l| l.starts_with("code_captured:"))
            .unwrap_or_else(|| panic!("a code_captured bullet: {gaps:?}"));
        assert!(line.contains(why), "names why: {line}");
        assert!(line.contains(&staged.to_string()), "names the run: {line}");
        assert!(!line.contains(&untouched.to_string()), "…and only that run: {line}");
        assert!(line.contains("process start"), "names the symptom: {line}");

        // The two surfaces stay one list (R4B-09), through the assembler as well.
        assert_eq!(gaps, gap.readiness_gaps, "readiness.json's `gaps` IS the returned list");
        assert!(
            reproducing_readme(false, &gap.readiness_dto, &gap.readiness_gaps)
                .contains("INCOMPLETE PROVENANCE"),
            "the README banner is driven by the same verdict"
        );

        // A closure whose steps stage nothing never reads, so it never reports a gap —
        // the guard against reddening a capsule the modules were irrelevant to.
        let none = assemble_readiness(
            &[step(untouched, "bash")],
            &|| Err(why.to_string()),
            &rows,
            &blobs,
            &roots,
            &[],
        )
        .expect("serializes");
        assert!(none.helper_gap_reason.is_none(), "no python step ⇒ no read ⇒ no gap");
        assert_eq!(
            emitted(&none)["flags"]["code_captured"],
            json!(true),
            "a shell-only closure is not reddened by modules it never wanted"
        );
    }

    // F2-18: `verify_outputs.sh` compares REGENERATED outputs against the recorded
    // hashes and drives the capsule's exit status. It must re-hash each step's
    // `work/NN/outputs` — NOT the `.cas`, which run.sh pre-seeds from the bundled
    // `data/` and therefore already contains every recorded output hash.
    #[test]
    fn verify_outputs_compares_regenerated_outputs_not_the_preseeded_cas() {
        let run_a = Uuid::new_v4();
        let run_b = Uuid::new_v4();
        let step = |run_id: Uuid, env: Option<&str>, code: Option<&str>, n: usize| {
            reproduce_script::Step {
                run_id,
                kind: "compute".into(),
                code_sha256: code.map(str::to_string),
                script_name: format!("scripts/step_{n:02}_x.py"),
                language: "python".into(),
                env_digest: env.map(str::to_string),
                arch: None,
                seed: Some(7),
                params: json!({}),
                work_dir: format!("work/{n:02}"),
                inputs: Vec::new(),
                staged_shared_helpers: true,
            }
        };
        let outputs: HashMap<Uuid, Vec<String>> = [
            (run_a, vec!["sha256:aaa".to_string(), "sha256:bbb".to_string()]),
            (run_b, vec!["sha256:ccc".to_string()]),
        ]
        .into_iter()
        .collect();

        let sh = verify_outputs_sh(
            &[step(run_a, Some("deadbeef"), Some("cafe"), 0), step(run_b, None, None, 1)],
            &outputs,
            &Default::default(),
        );

        // The recorded hashes are EXPECTATIONS, per executed step, over its work dir.
        assert!(sh.contains("verify_step '00'"), "{sh}");
        assert!(sh.contains("'aaa'") && sh.contains("'bbb'"), "both recorded hashes checked: {sh}");
        assert!(sh.contains("'work/00'"), "the step's work dir: {sh}");
        assert!(sh.contains("$HERE/$wd/outputs"), "re-hashes the REGENERATED outputs: {sh}");
        assert!(!sh.contains("$CAS"), "never the pre-seeded CAS (it would pass vacuously): {sh}");

        // A step the capsule cannot execute is UNVERIFIED, never reproduced — and
        // carries the round-4 executability CLASS (`never` = no host can run it).
        assert!(sh.contains("skip_step '01'"), "{sh}");
        assert!(sh.contains("never executable: the recorded run pinned no environment"), "{sh}");
        assert!(sh.contains("'never'"), "the skip carries its executability class: {sh}");

        // The verdict + exit status.
        assert!(sh.contains("NOT REPRODUCED:") && sh.contains("REPRODUCED:"), "{sh}");
        assert!(sh.contains("PARTIALLY VERIFIED:"), "{sh}");
        assert!(sh.contains("exit 1"), "a mismatch exits non-zero: {sh}");
        assert!(sh.contains("WHAT IT DOES NOT PROVE"), "states its own limits: {sh}");

        // And run.sh's appended tail actually invokes it.
        assert!(OUTPUT_VERIFICATION_TAIL.contains("bash \"$HERE/verify_outputs.sh\""));
        assert!(
            OUTPUT_VERIFICATION_TAIL.contains("not a reproducibility verdict"),
            "the bare `complete` line is disclaimed"
        );

        // An empty closure says so rather than claiming a pass.
        let none = verify_outputs_sh(&[], &HashMap::new(), &Default::default());
        assert!(none.contains("NOT VERIFIED:"), "{none}");
    }

    /// ROUND-3 / F3-4 — EXECUTE the generated verifier. The defect is in shell
    /// control flow, so only running it can catch it.
    ///
    /// `REPRODUCING.md` tells the reader "its exit status is the verification
    /// verdict". The `CHECKED -eq 0` arm was evaluated FIRST and `exit 0`, so a
    /// capsule in which every step was skipped — recorded output hashes present,
    /// none of them checkable — printed the factually FALSE line "this closure
    /// recorded no output hashes, so nothing could be compared", discarded a
    /// non-zero `UNVERIFIED`, and reported SUCCESS on the one channel a CI wrapper
    /// reads. The `elif [ "$UNVERIFIED" -gt 0 ]` arm below it was unreachable
    /// whenever `CHECKED` was 0.
    ///
    /// RED ON REVERT: restore the unconditional `exit 0` under `[ "$CHECKED" -eq 0 ]`
    /// and the all-skipped case exits 0 while asserting it recorded no hashes.
    #[test]
    fn an_all_skipped_capsule_does_not_report_success() {
        use std::io::Write as _;
        let run = Uuid::new_v4();
        let step = reproduce_script::Step {
            run_id: run,
            kind: "compute".into(),
            code_sha256: None, // → not runnable → skip_step
            script_name: "scripts/step_00_x.py".into(),
            language: "python".into(),
            env_digest: None,
            arch: None,
            seed: Some(7),
            params: json!({}),
            work_dir: "work/00".into(),
            inputs: Vec::new(),
            staged_shared_helpers: true,
        };
        // Recorded output hashes DO exist — they simply could not be checked.
        let outputs: HashMap<Uuid, Vec<String>> =
            [(run, vec!["sha256:aaa".to_string()])].into_iter().collect();
        let sh = verify_outputs_sh(&[step], &outputs, &Default::default());

        let run_sh = |body: &str| -> (Option<i32>, String, String) {
            let dir = std::env::temp_dir().join(format!("cyto-verify-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            let path = dir.join("verify_outputs.sh");
            std::fs::File::create(&path)
                .expect("create verify_outputs.sh")
                .write_all(body.as_bytes())
                .expect("write verify_outputs.sh");
            let out = std::process::Command::new("bash")
                .arg(&path)
                .current_dir(&dir)
                .output()
                .expect("bash is required to run the generated verifier");
            let _ = std::fs::remove_dir_all(&dir);
            (
                out.status.code(),
                String::from_utf8_lossy(&out.stdout).to_string(),
                String::from_utf8_lossy(&out.stderr).to_string(),
            )
        };

        let (code, stdout, stderr) = run_sh(&sh);
        // The MESSAGE is the part this round fixes: it must not deny that hashes were
        // recorded, because one was.
        assert!(
            !stderr.contains("recorded no output hashes"),
            "the message must not deny that hashes were recorded — 1 was.\nstderr: {stderr}"
        );
        // The EXIT STATUS is 0 — and as of ROUND 4 that is DERIVED, not a tradeoff.
        // Every unverified output here is class `never` (the recorded run pinned no
        // environment and captured no code), so no host could ever have executed this
        // step: there is nothing to fail. The sibling case — a step that IS executable
        // and simply was not run here — now exits 1, and is covered by
        // `unverified_steps_distinguish_never_executable_from_this_host`.
        assert_eq!(
            code,
            Some(0),
            "nothing in this closure was EVER executable, so it cannot have failed.\n\
             stdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            stderr.contains("never executable"),
            "…and the report says WHY nothing ran.\nstderr: {stderr}"
        );
        assert!(
            stderr.contains("UNVERIFIED") || stdout.contains("UNVERIFIED"),
            "the unverified count is the fact to report.\nstdout: {stdout}\nstderr: {stderr}"
        );

        // The genuinely-empty closure (no steps, no recorded hashes) is a DIFFERENT
        // fact and keeps its honest exit 0 — it claims nothing.
        let (empty_code, _, empty_err) = run_sh(&verify_outputs_sh(&[], &HashMap::new(), &Default::default()));
        assert_eq!(
            empty_code, Some(0),
            "an empty closure records nothing and claims nothing: {empty_err}"
        );
    }

    /// Build a `Step` for the verifier tests.
    fn vstep(run_id: Uuid, n: usize, env: Option<&str>, code: Option<&str>) -> reproduce_script::Step {
        reproduce_script::Step {
            run_id,
            kind: "compute".into(),
            code_sha256: code.map(str::to_string),
            script_name: format!("scripts/step_{n:02}_x.py"),
            language: "python".into(),
            env_digest: env.map(str::to_string),
            arch: None,
            seed: Some(7),
            params: serde_json::json!({}),
            work_dir: format!("work/{n:02}"),
            inputs: Vec::new(),
            staged_shared_helpers: true,
        }
    }

    /// Write `verify_outputs.sh` into a fresh temp dir, optionally pre-populating
    /// per-step `work/NN/outputs` files, run it, and return (exit code, stdout, stderr).
    fn exec_verifier(body: &str, outputs_on_disk: &[(&str, &str)]) -> (Option<i32>, String, String) {
        use std::io::Write as _;
        let dir = std::env::temp_dir().join(format!("cyto-verify-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for (rel, contents) in outputs_on_disk {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir work dir");
            std::fs::File::create(&p)
                .expect("create output file")
                .write_all(contents.as_bytes())
                .expect("write output file");
        }
        let path = dir.join("verify_outputs.sh");
        std::fs::File::create(&path)
            .expect("create verify_outputs.sh")
            .write_all(body.as_bytes())
            .expect("write verify_outputs.sh");
        let out = std::process::Command::new("bash")
            .arg(&path)
            .current_dir(&dir)
            .output()
            .expect("bash is required to run the generated verifier");
        let _ = std::fs::remove_dir_all(&dir);
        (
            out.status.code(),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    }

    /// ROUND-4 / R3F-02 — the real fix round 3 filed: a PER-STEP reason that
    /// distinguishes **never executable** (the recorded run pinned no environment /
    /// captured no code — no host can ever execute it) from **this host did not
    /// execute it** (the step IS executable by construction, but no regenerated
    /// output tree exists here). Round 3 could only guess at the exit status because
    /// the generator carried no such reason; with it, the status is derivable.
    ///
    /// This is also the coverage gap that let the F3-4 regression through: all eight
    /// `reproduce_capsule` call sites are rootfs-gated COMPUTE capsules, so the
    /// in-app-selection path the fix changed was executed by no test at all.
    ///
    /// RED BEFORE THE FIX: arm (B) prints `NOT REPRODUCED: 1 of 1 recorded outputs
    /// were not regenerated` — a false claim that the science failed to reproduce,
    /// when in fact this host executed nothing — and arms (A)/(B) carry no class.
    #[test]
    fn unverified_steps_distinguish_never_executable_from_this_host() {
        // (A) NEVER executable: an in-app selection run pins no environment, yet
        //     always carries a recorded output hash. No host can execute it.
        let sel = Uuid::new_v4();
        let outputs: HashMap<Uuid, Vec<String>> =
            [(sel, vec!["sha256:aaa".to_string()])].into_iter().collect();
        let sh = verify_outputs_sh(&[vstep(sel, 0, None, Some("cafe"))], &outputs, &Default::default());
        let (code, stdout, stderr) = exec_verifier(&sh, &[]);
        assert_eq!(
            code,
            Some(0),
            "nothing was EVER executable, so there is nothing to fail.\n{stdout}\n{stderr}"
        );
        assert!(
            stderr.contains("never executable") || stdout.contains("never executable"),
            "the skip must be classified as never-executable, not left ambiguous.\n\
             stdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            !stderr.contains("NOT REPRODUCED"),
            "a provenance-only closure is not an irreproducible one.\nstderr: {stderr}"
        );

        // (B) EXECUTABLE by construction, but this host executed nothing (no
        //     `work/00/outputs` tree — run.sh aborted, or the verifier was invoked
        //     standalone). That is NOT "the recorded output was not regenerated".
        let comp = Uuid::new_v4();
        let outputs: HashMap<Uuid, Vec<String>> =
            [(comp, vec!["sha256:aaa".to_string()])].into_iter().collect();
        let sh = verify_outputs_sh(&[vstep(comp, 0, Some("deadbeef"), Some("cafe"))], &outputs, &Default::default());
        let (code, stdout, stderr) = exec_verifier(&sh, &[]);
        assert!(
            !stdout.contains("NOT REPRODUCED") && !stderr.contains("NOT REPRODUCED"),
            "this host ran nothing; claiming the outputs 'were not regenerated' accuses \
             the analysis of irreproducibility on no evidence.\nstdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            stderr.contains("did not execute") || stdout.contains("did not execute"),
            "the honest fact is that THIS HOST executed the step.\n\
             stdout: {stdout}\nstderr: {stderr}"
        );
        assert_ne!(
            code,
            Some(0),
            "a step that COULD have been verified here and was not must not pass.\n\
             stdout: {stdout}\nstderr: {stderr}"
        );

        // (C) positive control — executed and MISMATCHED is a genuine failure.
        let sh = verify_outputs_sh(&[vstep(comp, 0, Some("deadbeef"), Some("cafe"))], &outputs, &Default::default());
        let (code, stdout, stderr) = exec_verifier(&sh, &[("work/00/outputs/o.txt", "wrong bytes")]);
        assert_eq!(code, Some(1), "a mismatch is a failure.\n{stdout}\n{stderr}");
        assert!(
            stderr.contains("NOT REPRODUCED"),
            "…and it says so.\nstdout: {stdout}\nstderr: {stderr}"
        );

        // (C2) ROUND-4 / R3-24 — a MULTIFILE artifact's recorded `content_hash` is a
        //      MERKLE ROOT over its directory. `verify_step` compares per-file
        //      `sha256sum`s, which can never equal it, so a byte-perfect directory
        //      output was reported NOT REGENERATED -> NOT REPRODUCED -> exit 1: a
        //      total false negative on the capsule's only verdict channel.
        //
        //      RED BEFORE THE FIX: exit 1 with "NOT REPRODUCED: 1 of 1 recorded
        //      outputs were not regenerated" for a step that reproduced perfectly.
        let merkle = format!("sha256:{}", "e".repeat(64));
        let outputs: HashMap<Uuid, Vec<String>> =
            [(comp, vec![merkle.clone()])].into_iter().collect();
        let multifile: std::collections::HashSet<String> = [merkle.clone()].into_iter().collect();
        let sh = verify_outputs_sh(
            &[vstep(comp, 0, Some("deadbeef"), Some("cafe"))],
            &outputs,
            &multifile,
        );
        let (code, stdout, stderr) = exec_verifier(
            &sh,
            &[("work/00/outputs/a.txt", "part a"), ("work/00/outputs/b.txt", "part b")],
        );
        assert!(
            !stdout.contains("NOT REPRODUCED") && !stderr.contains("NOT REPRODUCED"),
            "a MULTIFILE output's recorded hash is a merkle root over the directory; per-file \
             sha256 can never equal it, so declaring the analysis irreproducible is a total \
             false negative.\nstdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            stderr.contains("multi-file") || stdout.contains("multi-file"),
            "…and the reason is stated.\nstdout: {stdout}\nstderr: {stderr}"
        );
        assert_eq!(
            code,
            Some(0),
            "the capsule proved nothing about this output, but it did not fail either.\n\
             stdout: {stdout}\nstderr: {stderr}"
        );

        // (D) positive control — executed and MATCHED reproduces.
        let body = "regenerated bytes";
        let hash = sha256_hex(body.as_bytes());
        let outputs: HashMap<Uuid, Vec<String>> =
            [(comp, vec![format!("sha256:{hash}")])].into_iter().collect();
        let sh = verify_outputs_sh(&[vstep(comp, 0, Some("deadbeef"), Some("cafe"))], &outputs, &Default::default());
        let (code, stdout, stderr) = exec_verifier(&sh, &[("work/00/outputs/o.txt", body)]);
        assert_eq!(code, Some(0), "a byte-identical regeneration reproduces.\n{stdout}\n{stderr}");
        assert!(stdout.contains("REPRODUCED:"), "…and it says so.\nstdout: {stdout}");
    }

    /// ROUND-4b / R4B-04 — **the arm ORDER of the verdict fold, executed.**
    ///
    /// Round 4 put the `CHECKED -gt 0` arm above the `UNVERIFIED_HOST` arm, so in a
    /// MIXTURE the wrong signal won: a capsule where step 0 verified and step 1 was
    /// executable-but-not-run-here printed `PARTIALLY VERIFIED` and exited **0**,
    /// while the SAME unrun step ALONE exits 1. An unrelated success silently
    /// downgraded a real "this could have been verified here and was not" — on the one
    /// channel a CI wrapper reads. The sibling defect: `unsupported` and `never` were
    /// two mutually-exclusive arms, so a closure carrying BOTH printed the false claim
    /// "every step in this closure is never executable" and dropped the multi-file
    /// count entirely.
    ///
    /// Every assertion below runs the REAL generated script under bash and reads its
    /// REAL exit code.
    ///
    /// RED BEFORE THE FIX: `(c)+(b)` exits 0 with `PARTIALLY VERIFIED`;
    /// `never+unsupported` prints "every step in this closure is never executable".
    #[test]
    fn the_verdict_fold_lets_the_strongest_signal_win() {
        let matched = "regenerated bytes";
        let matched_hash = format!("sha256:{}", sha256_hex(matched.as_bytes()));
        let never = Uuid::new_v4();
        let ran = Uuid::new_v4();

        // (e) a MATCHED step mixed with a NEVER-executable one: nothing failed and
        //     nothing was skippable-here → PARTIALLY VERIFIED, exit 0.
        let outputs: HashMap<Uuid, Vec<String>> = [
            (ran, vec![matched_hash.clone()]),
            (never, vec!["sha256:aaa".to_string()]),
        ]
        .into_iter()
        .collect();
        let sh = verify_outputs_sh(
            &[vstep(ran, 0, Some("deadbeef"), Some("cafe")), vstep(never, 1, None, None)],
            &outputs,
            &Default::default(),
        );
        let (code, stdout, stderr) = exec_verifier(&sh, &[("work/00/outputs/o.txt", matched)]);
        assert_eq!(code, Some(0), "(e) matched + never-executable is not a failure.\n{stdout}\n{stderr}");
        assert!(stdout.contains("PARTIALLY VERIFIED"), "(e) {stdout}");
        assert!(
            stdout.contains("could not be checked at all"),
            "(e) the unchecked outputs are UNCHECKABLE, not merely 'not executed here': {stdout}"
        );

        // (f) a MISMATCHED step mixed with a NEVER-executable one: the mismatch
        //     DOMINATES — "nothing checkable" must never mask it.
        let (code, stdout, stderr) = exec_verifier(&sh, &[("work/00/outputs/o.txt", "wrong bytes")]);
        assert_eq!(code, Some(1), "(f) a mismatch anywhere dominates.\n{stdout}\n{stderr}");
        assert!(stderr.contains("NOT REPRODUCED"), "(f) {stderr}");

        // THE ROUND-4 BUG: a MATCHED step mixed with an executable-but-not-run-here
        // one. Alone the unrun step exits 1; mixed with a success it exited 0.
        let unrun = Uuid::new_v4();
        let outputs: HashMap<Uuid, Vec<String>> = [
            (ran, vec![matched_hash.clone()]),
            (unrun, vec!["sha256:aaa".to_string()]),
        ]
        .into_iter()
        .collect();
        let sh = verify_outputs_sh(
            &[
                vstep(ran, 0, Some("deadbeef"), Some("cafe")),
                vstep(unrun, 1, Some("deadbeef"), Some("cafe")),
            ],
            &outputs,
            &Default::default(),
        );
        let (code, stdout, stderr) = exec_verifier(&sh, &[("work/00/outputs/o.txt", matched)]);
        assert_eq!(
            code,
            Some(1),
            "a step that COULD have been verified here and was not must not be downgraded to \
             a pass by an unrelated success.\n{stdout}\n{stderr}"
        );
        assert!(
            stderr.contains("this host did not execute them"),
            "…and the reason is the honest one: {stderr}"
        );
        assert!(
            stderr.contains("DID regenerate byte-identically"),
            "…while still crediting what DID verify: {stderr}"
        );
        assert!(
            !stdout.contains("PARTIALLY VERIFIED"),
            "a partial success must not be the headline when a verifiable step was skipped: {stdout}"
        );

        // The SIBLING ARM: `never` AND `unsupported` in one closure. Round 4's arms
        // were exclusive, so this printed "every step ... is never executable" (false
        // — the multi-file step IS executable) and dropped the unsupported count.
        let merkle = format!("sha256:{}", "e".repeat(64));
        let both = Uuid::new_v4();
        let outputs: HashMap<Uuid, Vec<String>> =
            [(both, vec![merkle.clone(), "sha256:aaa".to_string()])].into_iter().collect();
        let multifile: std::collections::HashSet<String> = [merkle].into_iter().collect();
        let sh = verify_outputs_sh(&[vstep(both, 0, None, None)], &outputs, &multifile);
        let (code, stdout, stderr) = exec_verifier(&sh, &[]);
        assert_eq!(code, Some(0), "neither class is a failure.\n{stdout}\n{stderr}");
        assert!(
            !stderr.contains("every step"),
            "the closure carries BOTH classes, so 'every step ... is never executable' is \
             false: {stderr}"
        );
        assert!(
            stderr.contains("never executable") && stderr.contains("MULTI-FILE"),
            "both classes are counted in the verdict, not just the winner: {stderr}"
        );
    }
}
