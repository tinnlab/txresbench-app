//! The REAL provenance `RunRecorder` (P4 ITEM-1/3) — the compute chokepoint.
//!
//! Installed by `ProvenanceModule::init` via `jobs::seams::install_recorder`, so
//! the jobs executor's `finalize_analysis` (after a successful ingest) records
//! every analysis run as a provenance run node in the merged graph: it hashes +
//! stores the entry script as a content-addressed code blob, computes the env
//! digest, derives the authoritative used-edges from the spec's inputs (pinned by
//! the catalog's content hash), and inserts the `provenance_run_repro` sidecar
//! with `run_id = job.run_id.unwrap_or(job.id)` — IDENTICAL to the ingest sink's
//! run_id, so the catalog artifacts' `run_id` lines up for the verify signature.
//!
//! `record_run` is fire-and-forget from the executor: every failure is logged and
//! swallowed, never panics, never fails the job.

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::modules::jobs::models::Job;
use crate::modules::jobs::repository::JobRepository;
use crate::modules::jobs::seams::{PeakMetrics, RunRecorder};
use crate::modules::sandbox::outputs::ProducedOutput;
use crate::modules::sandbox::spec::AnalysisSpec;
use crate::modules::workstore::catalog::models::Artifact;
use crate::modules::workstore::catalog::repository::CatalogRepository;

use super::capture;
use super::models::UsedEdgeDto;
use super::repository::{NewRun, ProvenanceRepository};

/// The reserved output id a run uses to report the environment it actually executed
/// against (#80).
///
/// Kept in lockstep with `_lib/cyto_deps.py::OUTPUT_ID` — the python side writes it, this
/// side looks for it, and a divergence would silently mean every run records `None`. The
/// well-known-id shape is the one already used to lift other per-run records off the
/// outputs the recorder is handed.
pub const RUN_ENVIRONMENT_OUTPUT_ID: &str = "run-environment";

/// A cap on the environment record read back off disk. The record is a small object
/// (a declaration list, a digest, an interpreter version); anything larger is not one,
/// and the recorder must not load an arbitrary blob a compute wrote under this id into
/// a database column.
const MAX_RUN_ENVIRONMENT_BYTES: u64 = 256 * 1024;

/// The run's environment record, read off the reserved output the compute declared, or
/// `None` when the run emitted none.
///
/// Every failure path here yields `None` and a log line rather than failing the run.
/// That is deliberate, and it is the one place in this whole mechanism where a soft failure is
/// right: by the time this executes the outputs are already CATALOGED, so refusing to
/// record provenance would discard a completed, ingested run over a metadata read. The
/// hard enforcement lives where it can still change the outcome — the build gate refuses
/// an unsatisfiable declaration, and the in-sandbox check refuses the run itself before
/// it produces anything. What is left for this function is transcription.
async fn read_run_environment(outputs: &[ProducedOutput]) -> Option<serde_json::Value> {
    let out = outputs.iter().find(|o| o.id == RUN_ENVIRONMENT_OUTPUT_ID)?;
    match tokio::fs::metadata(&out.host_path).await {
        Ok(meta) if meta.len() > MAX_RUN_ENVIRONMENT_BYTES => {
            tracing::warn!(
                path = %out.host_path.display(),
                len = meta.len(),
                "provenance: the run environment record exceeds the size cap; not recorded"
            );
            return None;
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(
                path = %out.host_path.display(),
                "provenance: cannot stat the run environment record ({e}); not recorded"
            );
            return None;
        }
    }
    let bytes = match tokio::fs::read(&out.host_path).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(
                path = %out.host_path.display(),
                "provenance: cannot read the run environment record ({e}); not recorded"
            );
            return None;
        }
    };
    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(v) if v.is_object() => Some(v),
        Ok(_) => {
            tracing::warn!(
                path = %out.host_path.display(),
                "provenance: the run environment record is not a JSON object; not recorded"
            );
            None
        }
        Err(e) => {
            tracing::warn!(
                path = %out.host_path.display(),
                "provenance: the run environment record is not valid JSON ({e}); not recorded"
            );
            None
        }
    }
}

/// The provenance recorder — holds the pool (baked in at install).
pub struct ProvenanceRunRecorder {
    pool: PgPool,
}

impl ProvenanceRunRecorder {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The fallible body, so `record_run` can log-and-swallow.
    async fn record(
        &self,
        job: &Job,
        outputs: &[ProducedOutput],
        exit_code: i32,
        workspace_root: &std::path::Path,
    ) -> Result<(), ziee_core::AppError> {
        // ITEM-68: a run is scoped to a project (workbench) OR a dataset (owner
        // processing) — a job carries no scope column, so resolve the scope from the
        // single-source-of-truth `job_scope` table. The run_repro schema carries a
        // nullable project_id + dataset_id (202607250007), so a dataset-scoped run
        // node is written directly. PROPAGATE a lookup error (via `?`) instead of
        // collapsing it to `None`: a swallowed DB error would silently drop a
        // legitimately-scoped run from lineage. `record_run` logs the propagated
        // error, so a real fault is surfaced, not vanished. A scope-less job (no row)
        // has nowhere to attach provenance.
        let (project_scope, dataset_scope) =
            match JobRepository::job_scope(&self.pool, job.id).await? {
                Some(scope) => scope.split(),
                None => return Ok(()),
            };
        let spec = AnalysisSpec::parse(&job.params)?;
        let run_id = job.run_id.unwrap_or(job.id);

        // Hash + store the EXECUTED entry script as a content-addressed code blob
        // (so even a later template change can't alter this captured run's code).
        // Resolve the SAME entry the runner staged — an inline `script` OR a builtin
        // `code_ref` (baked processor); a `code_ref` run used to record NO code.
        // NOTE (fidelity): `rerun_spec_json` stores `job.params` (the `code_ref`, not
        // the bytes), so a `POST /provenance/verify` re-run re-resolves the `code_ref`
        // against the CURRENT binary's baked script. Verify compares OUTPUT SIGNATURES,
        // not `code_sha256`, so a later binary that tweaks a builtin re-runs the new
        // bytes without a false "verified" — but the pinned `code_sha256` is the record
        // of what THIS run executed. Inline-script runs pin their bytes in `rerun_spec_json`.
        // Hash the bytes that ACTUALLY RAN (M4): prefer the entry staged into the run
        // workspace at spawn (`<root>/code/entry.*`), so a mid-run on-disk edit to a
        // folder `code_ref` can't make the recorded hash a different script than the one
        // executed (bytes RUN == bytes RECORDED). Fall back to a re-resolve only when the
        // workspace is already gone (best-effort, e.g. a foreign/legacy finalize).
        let code_sha256 = match staged_entry(workspace_root) {
            Some((bytes, lang)) if !bytes.trim().is_empty() => {
                Some(capture::store_code(&self.pool, &bytes, lang).await?)
            }
            _ => match spec.resolve_entry() {
                Ok(entry) if !entry.script.trim().is_empty() => Some(
                    capture::store_code(&self.pool, entry.script.as_ref(), entry.language.as_str())
                        .await?,
                ),
                _ => None,
            },
        };

        // Derive the authoritative used-edges from the spec's inputs (resolved
        // within the run's OWN scope — project or dataset). A genuine DB fault
        // PROPAGATES (`?`): a run asserting a complete closure it does not have is
        // worse than a missing run, and `record_run` logs the propagated error.
        // `job.owner_id` is the ACTING USER (the same id `build_new_run` stamps as
        // `acting_user`) — an AUTHORIZATION input to the widened dataset arm, not
        // telemetry. See `resolve_used_edges`.
        let inputs = self
            .resolve_used_edges(project_scope, dataset_scope, job.owner_id, &spec)
            .await?;

        // Where each input was ACTUALLY bound, read back off the run's own
        // `/inputs/inputs.json` — the very document the sandbox saw (M4's rule applied to
        // the mount names: record what ran, do not re-derive it later). See
        // [`build_new_run`]'s `input_mounts` note for why a re-derivation is not
        // equivalent.
        let recorded_mounts =
            crate::modules::sandbox::inputs::recorded_mount_names(&workspace_root.join("inputs"));

        // #80 — the RESOLVED library versions this run actually executed against.
        //
        // `env_digest_rootfs` below identifies the environment IMAGE; this identifies what
        // was inside it, at the granularity a reader can act on. The two answer different
        // questions and the row has always had a column for the second one — it was simply
        // never written, so every run recorded "which image" and nothing about which
        // library versions produced the numbers.
        let lockfile_json = read_run_environment(outputs).await;

        // #189 / INV-3 — the digest of the image THIS RUN mounted, read off the run's own
        // workspace (written by the backend at `provide()` time), NOT from the
        // process-global "most recently resolved" slot.
        //
        // The global was survivable only while exactly one env existed. With two, two
        // concurrent runs on different envs race it, and the loser records the OTHER
        // run's image — a confident, wrong reference in the reproduce path, which is
        // worse than none. There is deliberately NO fallback to the global here: a run
        // with no sidecar mounted no env image (an in-app interaction run, a
        // promote/byte-copy run) or ran under a seam that could not name a digest, and
        // `None` is the honest record for each. This also closes the second window
        // `env_image`'s DEC-O note called out, where such a run inherited a previous
        // run's digest.
        let env_digest = crate::modules::sandbox::env_image::read_run_env_digest(workspace_root);

        let new_run = build_new_run(
            job,
            &spec,
            run_id,
            project_scope,
            dataset_scope,
            code_sha256,
            env_digest,
            inputs,
            exit_code,
            recorded_mounts,
            lockfile_json,
        );
        ProvenanceRepository::new(self.pool.clone())
            .insert_run(&new_run)
            .await?;
        Ok(())
    }

    /// Resolve each declared input to a `UsedEdgeDto` (ITEM-3). An `artifact_ref`
    /// resolves to the catalog artifact's content hash + source kind; a
    /// `host_path` (transition form) is best-effort file-hashed at record time.
    ///
    /// **Two failure classes, deliberately different (ERROR-HANDLING-3 / F2-12).**
    /// Round 1 fixed the misleading MESSAGE on these arms but not the OUTCOME: every
    /// failure still dropped its edge and the run was committed as complete, with the
    /// loss invisible downstream (readiness even answered `inputs_checksummed: true`
    /// over the resulting empty edge list). Now:
    ///
    ///  * a genuine **DB fault** (`catalog.get`, `dataset_ids_for_project`,
    ///    `dataset_scope_for_file`) is NOT "an unresolvable input" — it PROPAGATES, so
    ///    `record()` aborts and no run is written asserting a closure it never had. A
    ///    missing run is honest; a false-complete one is not.
    ///  * a genuinely **unresolvable** input (not in the catalog, out of the run's
    ///    tenancy scope, no dataset content hash yet, an unreadable `host_path`) still
    ///    does not block the run — but it is recorded as an [`unresolved_edge`] rather
    ///    than dropped, so the loss is PERSISTED in `inputs_json`, visible on the run
    ///    node, and demotes `readiness.inputs_checksummed` (`export::readiness::
    ///    inputs_checksummed_flag`) instead of living only in a log line whoever reads
    ///    the run never opens.
    ///
    /// **`caller_id` is an AUTHORIZATION input, not telemetry** — the exact rule
    /// `inputs::resolve_input` applies at the capture chokepoint (ROUND-4 / R3-14).
    /// The WIDENED arm below admits an artifact on the project ATTACHMENT alone; a
    /// dataset is a separately-permissioned resource, so the attachment says the
    /// PROJECT may use it, not that every project collaborator may. Without the
    /// per-user gate a project Editor's run node would echo a private dataset
    /// artifact's `ref_id` + pinned `content_hash` straight back to him
    /// (CODING_GUIDELINES §1). Only the widened arm is gated: a direct
    /// project-scope / dataset-scope match is in-scope by construction.
    async fn resolve_used_edges(
        &self,
        project_scope: Option<Uuid>,
        dataset_scope: Option<Uuid>,
        caller_id: Uuid,
        spec: &AnalysisSpec,
    ) -> Result<Vec<UsedEdgeDto>, ziee_core::AppError> {
        let catalog = CatalogRepository::new(self.pool.clone());
        // The datasets ATTACHED to the run's project (lazily, only if a candidate
        // artifact misses the direct scope match). A PROJECT-scoped (workbench) run over
        // an uploaded dataset consumes a DATASET-scoped artifact (`project_id = NULL`),
        // so it legitimately reads outside its own scope column — see
        // `inputs::artifact_in_project_scope`. Without this the `used` edge for the
        // commonest workbench run was silently dropped and the backward walk had no
        // terminus. (DATASET-scoped runs were never affected: their `art.dataset_id ==
        // dataset_scope` arm already matched.)
        let mut attached: Option<Vec<Uuid>> = None;
        let mut edges = Vec::with_capacity(spec.inputs.len());
        for input in &spec.inputs {
            // ITEM-18 / INV-3 — the origin is stamped at ONE funnel, not at each arm.
            //
            // Every `edges.push` in this loop goes through `push_edge`, so the origin
            // reaches the artifact arm, the dataset arm, the host-path arm AND every
            // `unresolved_edge` fallback without any of them opting in. That is
            // deliberate structure, not tidiness: the defect this change exists to fix
            // is a fact that survives at one site and evaporates at the others, and a
            // per-arm `bound_by:` assignment would reproduce it the moment a new arm is
            // added. TEST-25 asserts the class rather than the reported arm.
            let bound_by = input.bound_by.map(|o| o.as_str().to_string());
            let mut push_edge = |mut e: UsedEdgeDto| {
                e.bound_by = bound_by.clone();
                edges.push(e);
            };
            if let Some(art_id) = input.artifact_ref {
                match catalog.get_any_status(art_id).await {
                    // ITEM-23 + Task-B: an input artifact must belong to the run's
                    // OWN tenancy scope — the project (workbench, incl. its ATTACHED
                    // datasets) OR the dataset (owner processing).
                    // `Artifact.project_id`/`dataset_id` are both `Option<Uuid>`.
                    Ok(Some(art)) => {
                        let mut in_scope = (project_scope.is_some()
                            && art.project_id == project_scope)
                            || (dataset_scope.is_some() && art.dataset_id == dataset_scope);
                        if !in_scope && art.project_id.is_none() && art.dataset_id.is_some() {
                            if let Some(project_id) = project_scope {
                                if attached.is_none() {
                                    // A LOOKUP FAILURE IS NOT AN EMPTY ATTACHMENT SET, and it is
                                    // not an out-of-scope input either — it is a DB fault, so it
                                    // propagates and the run is not recorded at all rather than
                                    // recorded with a lineage this error silently truncated.
                                    let ids = ProvenanceRepository::new(self.pool.clone())
                                        .dataset_ids_for_project(project_id)
                                        .await
                                        .map_err(|e| {
                                            tracing::error!(
                                                %project_id, %art_id, slot = %input.slot, error = %e,
                                                "provenance recorder: could not read the project's attached \
                                                 datasets; refusing to record a run with a truncated closure"
                                            );
                                            e
                                        })?;
                                    attached = Some(ids);
                                }
                                if let Some(ids) = attached.as_deref() {
                                    in_scope = super::inputs::artifact_in_project_scope(
                                        art.project_id,
                                        art.dataset_id,
                                        project_id,
                                        ids,
                                    );
                                }
                                // R3-14, recorder half — the ATTACHMENT is not a
                                // per-user grant. Same gate, and the same
                                // 404-means-not-visible / anything-else-PROPAGATES
                                // split, as `inputs::resolve_input`: a DB blip must
                                // never degrade into "out of scope" (that would drop a
                                // legitimate edge and read as a tenancy violation).
                                if let (true, Some(ds)) = (in_scope, art.dataset_id) {
                                    match crate::modules::workstore::authz::require_dataset_read(
                                        &self.pool, ds, caller_id,
                                    )
                                    .await
                                    {
                                        Ok(()) => {}
                                        Err((_, err)) if err.status_code() == 404 => {
                                            tracing::warn!(
                                                %project_id, %caller_id, dataset_id = %ds, %art_id,
                                                slot = %input.slot,
                                                "provenance recorder: refused an input artifact from \
                                                 a dataset the acting user cannot read (the project \
                                                 attachment is not a per-user grant); recording it as \
                                                 an UNRESOLVED used-edge"
                                            );
                                            in_scope = false;
                                        }
                                        Err((_, err)) => return Err(err),
                                    }
                                }
                            }
                        }
                        if in_scope {
                            push_edge(edge_from_artifact(&input.slot, &art));
                        } else {
                            tracing::warn!(
                                %art_id, slot = %input.slot,
                                "provenance recorder: input artifact not found in run scope; \
                                 recording it as an UNRESOLVED used-edge"
                            );
                            // Deliberately `ref_id: None` — the artifact is outside this run's
                            // tenancy scope, so its id must not be echoed into the run's lineage.
                            push_edge(unresolved_edge(&input.slot));
                        }
                    }
                    Ok(None) => {
                        tracing::warn!(
                            %art_id, slot = %input.slot,
                            "provenance recorder: input artifact not found in the catalog; \
                             recording it as an UNRESOLVED used-edge"
                        );
                        push_edge(unresolved_edge(&input.slot));
                    }
                    Err(e) => {
                        tracing::error!(
                            %art_id, slot = %input.slot, error = %e,
                            "provenance recorder: input artifact lookup failed; refusing to record \
                             a run with a truncated closure"
                        );
                        return Err(e);
                    }
                }
            } else if let Some(file_id) = input.dataset_file_ref {
                // ITEM-20 / DEC-20: a Dataset (ziee-file) input. Resolve the file to
                // its dataset + the dataset's merkle content hash (the provenance
                // link key), so the run pins its SOURCE dataset as a `dataset`
                // used-edge and the backward walk terminates at (or crosses) it.
                match ProvenanceRepository::new(self.pool.clone())
                    .dataset_scope_for_file(file_id)
                    .await
                {
                    Ok(Some((dataset_id, Some(hash)))) => {
                        push_edge(dataset_edge(&input.slot, dataset_id, &hash))
                    }
                    Ok(Some((dataset_id, None))) => {
                        tracing::warn!(
                            %dataset_id, slot = %input.slot,
                            "provenance recorder: dataset input has no content_hash yet; \
                             recording it as an UNRESOLVED used-edge"
                        );
                        push_edge(unresolved_edge(&input.slot));
                    }
                    Ok(None) => {
                        tracing::warn!(
                            %file_id, slot = %input.slot,
                            "provenance recorder: dataset file not linked to a dataset; \
                             recording it as an UNRESOLVED used-edge"
                        );
                        push_edge(unresolved_edge(&input.slot));
                    }
                    Err(e) => {
                        tracing::error!(
                            %file_id, slot = %input.slot, error = %e,
                            "provenance recorder: dataset lookup failed; refusing to record a run \
                             with a truncated closure"
                        );
                        return Err(e);
                    }
                }
            } else if let Some(host) = input.host_path.as_deref() {
                match host_path_edge(&input.slot, host).await {
                    Some(edge) => push_edge(edge),
                    None => {
                        tracing::warn!(
                            slot = %input.slot, path = %host,
                            "provenance recorder: host_path input unreadable; recording it as an \
                             UNRESOLVED used-edge"
                        );
                        push_edge(unresolved_edge(&input.slot));
                    }
                }
            }
        }
        Ok(edges)
    }
}

#[async_trait]
impl RunRecorder for ProvenanceRunRecorder {
    async fn record_run(
        &self,
        job: &Job,
        outputs: &[ProducedOutput],
        exit_code: i32,
        _peak: PeakMetrics,
        workspace_root: &std::path::Path,
    ) {
        if let Err(e) = self.record(job, outputs, exit_code, workspace_root).await {
            tracing::error!(job_id = %job.id, error = %e, "provenance recorder: record_run failed");
        }
    }
}

/// The bytes + language tag that ACTUALLY RAN, read from the per-job workspace the runner
/// staged at spawn (`<workspace_root>/code/entry.{py,R,sh}`) — resolved ONCE at spawn, so
/// a mid-run on-disk edit to a folder-discovered `code_ref` can NOT change what provenance
/// records (M4). Exactly one `entry.*` is staged per job; `None` if the workspace was
/// already reclaimed (the caller then falls back to a re-resolve for back-compat).
fn staged_entry(workspace_root: &std::path::Path) -> Option<(String, &'static str)> {
    for (file, lang) in [
        ("entry.py", "python"),
        ("entry.R", "r"),
        ("entry.sh", "bash"),
    ] {
        let p = workspace_root.join("code").join(file);
        if let Ok(bytes) = std::fs::read_to_string(&p) {
            return Some((bytes, lang));
        }
    }
    None
}

/// The `kind` of a used-edge for an input that was DECLARED by the run's spec but
/// could not be resolved to a content identity.
pub const UNRESOLVED_EDGE_KIND: &str = "unresolved";

/// A used-edge for a declared-but-unresolvable input (ERROR-HANDLING-3 / F2-12).
///
/// It carries NO `content_hash` and NO `ref_id`, which is the whole point: the
/// alternative — dropping the input — made the loss invisible (a run with a
/// truncated, or entirely empty, `inputs_json` read as an ordinary complete run,
/// and the readiness projection even answered `inputs_checksummed: true` over the
/// empty set). Recorded this way the gap is PERSISTED, surfaces on the run node,
/// and demotes `readiness.inputs_checksummed` via `export::readiness::inputs_checksummed_flag`.
///
/// It is not a graph vertex: `graph::WalkContext::walk_runs` filters hash-less
/// edges out of the backward/forward walk, so it can never masquerade as a root.
pub fn unresolved_edge(slot: &str) -> UsedEdgeDto {
    UsedEdgeDto {
        slot: slot.to_string(),
        kind: UNRESOLVED_EDGE_KIND.to_string(),
        ref_id: None,
        content_hash: String::new(),
        // The origin is stamped by `resolve_used_edges`' single funnel, never here:
        // a constructor that guessed one would be the second source of truth.
        bound_by: None,
    }
}

/// A used-edge for a Dataset (ziee-file) input — kind `dataset`, pinned by the
/// dataset's merkle `content_hash` (the provenance link key, ITEM-20 / DEC-20).
/// `ref_id` is the dataset id (not the file id), so the walk terminates at — or
/// crosses (a promoted dataset) — the dataset node keyed by that same hash.
pub fn dataset_edge(slot: &str, dataset_id: Uuid, content_hash: &str) -> UsedEdgeDto {
    UsedEdgeDto {
        slot: slot.to_string(),
        kind: "dataset".to_string(),
        ref_id: Some(dataset_id),
        content_hash: content_hash.to_string(),
        bound_by: None,
    }
}

/// A used-edge from a resolved catalog artifact. `kind` is `upload` for a
/// run-less root (a source/upload) else `artifact` (a prior analysis output).
pub fn edge_from_artifact(slot: &str, art: &Artifact) -> UsedEdgeDto {
    UsedEdgeDto {
        slot: slot.to_string(),
        kind: if art.run_id.is_some() {
            "artifact"
        } else {
            "upload"
        }
        .to_string(),
        ref_id: Some(art.id),
        content_hash: art.content_hash.clone(),
        bound_by: None,
    }
}

/// A used-edge for a `host_path` (transition/test-form) input — best-effort
/// hashed at record time. Returns `None` if the file is unreadable.
async fn host_path_edge(slot: &str, host: &str) -> Option<UsedEdgeDto> {
    let bytes = tokio::fs::read(host).await.ok()?;
    Some(UsedEdgeDto {
        slot: slot.to_string(),
        kind: "host".to_string(),
        ref_id: None,
        content_hash: crate::modules::workstore::object_store::ContentKey::from_hex(
            &crate::modules::workstore::object_store::sha256_hex(&bytes),
        )
        .as_str()
        .to_string(),
        bound_by: None,
    })
}

/// The `rerun_spec_json` key carrying WHERE each input was actually bound (see
/// [`build_new_run`]). A sibling of the verbatim `inputs` array, never a rewrite of it.
pub const RERUN_INPUT_MOUNTS_KEY: &str = "input_mounts";

/// Build the `NewRun` for a finished analysis run (pure — no DB). `params` is a
/// MINIMAL scientific-params object (the code blob IS the params, DEC-CODE-SOURCE);
/// the full spec is stashed in `rerun_spec_json` for the verify re-run (DEC-2).
///
/// `input_mounts` is `(slot, /inputs-relative mount NAME)` read back off the run's own
/// `/inputs/inputs.json` — see the `rerun_spec_json` note in the body for what it is for
/// and why it is not re-derived. `None` = no record was readable (a reclaimed workspace,
/// a legacy finalize); the key is then omitted and the reader falls back.
#[allow(clippy::too_many_arguments)]
pub fn build_new_run(
    job: &Job,
    spec: &AnalysisSpec,
    run_id: Uuid,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    code_sha256: Option<String>,
    env_rootfs_sha256: Option<String>,
    inputs: Vec<UsedEdgeDto>,
    exit_code: i32,
    input_mounts: Option<Vec<(String, String)>>,
    lockfile_json: Option<serde_json::Value>,
) -> NewRun {
    // Serializing a Vec of plain DTOs is effectively infallible; log (never
    // silently empty) on the unreachable failure so a dropped closure is visible.
    let inputs_json = serde_json::to_value(&inputs).unwrap_or_else(|e| {
        tracing::error!(run_id = %run_id, "provenance recorder: serialize used-edges failed: {e}");
        serde_json::json!([])
    });
    NewRun {
        run_id,
        project_id,
        dataset_id,
        kind: "compute".to_string(),
        status: if exit_code == 0 {
            "completed"
        } else {
            "failed"
        }
        .to_string(),
        generator_id: spec
            .analysis_id
            .clone()
            .unwrap_or_else(|| "analysis".to_string()),
        generator_version: env!("CARGO_PKG_VERSION").to_string(),
        code_sha256,
        env_rootfs_sha256,
        // #80 — the run's RESOLVED library versions, or `None` when the run emitted no
        // environment record. `None` is an honest "this run did not report one", which is
        // the correct answer for an entry that declares no dependencies and for every run
        // recorded before the mechanism existed; it is never a fabricated placeholder.
        lockfile_json,
        seed: spec.seed,
        // **ITEM-5 / DEC-1 = BOTH, DEC-14** — the trust-view `params` carries the
        // run's SCIENTIFIC parameters (the filter criteria, the thresholds, the mask
        // label …), not runtime metadata. It is the SAME object the sandbox wrote to
        // `/inputs/params.json` for this run — built by the very same function
        // (`sandbox::inputs::params_json_value`, i.e. `RunSpec.params ∪ {seed}`) — so
        // the promoted column and the capsule's regenerated params agree BY
        // CONSTRUCTION, which is what makes `readiness::params_captured` a decidable
        // flag rather than a heuristic.
        //
        // `language` and `arch` are deliberately DROPPED: they are runtime facts, not
        // science, and each keeps its own carrier — the language is declared in the
        // re-run spec (`export::bundle::run_language` reads it there), and the
        // execution environment is pinned by `env_rootfs_sha256`.
        params: crate::modules::sandbox::inputs::params_json_value(&spec.params, spec.seed),
        inputs_json,
        acting_user: Some(job.owner_id),
        // The full spec (script + pinned inputs) → the verify re-run source, PLUS the
        // record of where each input was actually bound.
        rerun_spec_json: Some(with_input_mounts(job.params.clone(), input_mounts, run_id)),
    }
}

/// Stamp the run's ACTUAL `(slot, mount name)` bindings onto the stashed re-run
/// envelope, under [`RERUN_INPUT_MOUNTS_KEY`], as a SIBLING of the verbatim spec.
///
/// ## The fidelity gap this closes
///
/// The provenance export binds each capsule step's inputs at "the subpath the original
/// run used", and it read that from the envelope's `inputs[].sandbox_subpath`. Since
/// ITEM-23 that field is IGNORED for an artifact-backed input — the runner derives the
/// mount name from the artifact — so the exported capsule declared a path the run never
/// used. Capsules stayed internally consistent (a compute resolves by slot), which is
/// why it read as cosmetic; but a capsule is this product's OUT-OF-APP trust artifact,
/// and one that states a path the run did not take is a provenance lie regardless of
/// whether anything downstream trips over it.
///
/// ## Why a RECORD and not a re-derivation
///
/// `derive_artifact_mount_name` could be called again at export time, and that was the
/// obvious fix. It is the worse one, on three counts:
///
///  1. **It cannot see the run's inputs.** The derivation needs the artifact's
///     `structure.encoding`, which the envelope does not carry — only the artifact ID.
///     Export would have to re-read the catalog row, whose `structure` may have been
///     rewritten (or the row deleted) since the run, so the "reconstruction" could
///     disagree with what was mounted and there would be no way to tell.
///  2. **It cannot see the run's DISAMBIGUATION.** A repeated slot's second binding is
///     staged under an ordinal (`unique_mount_name`), which is a property of the whole
///     input list at staging time, not of any one artifact. A per-input re-derivation
///     reproduces the COLLIDING name for every binding.
///  3. **It can drift again.** A re-derivation is a second implementation of the runner's
///     naming that nothing forces to agree; this whole item exists because exactly that
///     kind of parallel assumption went stale. A recorded fact cannot drift.
///
/// The source is `<workspace>/inputs/inputs.json` — the document the sandbox itself read
/// — which is the same "record what ran, do not re-resolve it" rule the recorder already
/// applies to the entry script's bytes (M4).
///
/// The submitted spec is left BYTE-VERBATIM: `inputs[]` still shows what the caller
/// declared (including a `sandbox_subpath` the runner ignored), and the record of what
/// happened sits beside it. Rewriting the declaration in place would trade one
/// misstatement for another.
fn with_input_mounts(
    mut spec_json: serde_json::Value,
    mounts: Option<Vec<(String, String)>>,
    run_id: Uuid,
) -> serde_json::Value {
    let Some(mounts) = mounts else {
        // No readable record. Omit the key rather than write an empty one: the reader
        // distinguishes "not recorded" (fall back to the declaration, the legacy answer)
        // from "recorded, and this run bound nothing".
        tracing::debug!(
            run_id = %run_id,
            "provenance recorder: no /inputs/inputs.json to read the run's mount names \
             from; the capsule will fall back to the declared subpaths"
        );
        return spec_json;
    };
    let recorded = serde_json::Value::Array(
        mounts
            .into_iter()
            .map(|(slot, subpath)| serde_json::json!({ "slot": slot, "subpath": subpath }))
            .collect(),
    );
    match spec_json.as_object_mut() {
        Some(map) => {
            map.insert(RERUN_INPUT_MOUNTS_KEY.to_string(), recorded);
        }
        // A non-object spec cannot be re-run either; nothing to attach to.
        None => tracing::warn!(
            run_id = %run_id,
            "provenance recorder: the re-run spec is not a JSON object, so the run's \
             mount names could not be recorded onto it"
        ),
    }
    spec_json
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::spec::Language;

    fn sample_job(params: serde_json::Value, run_id: Option<Uuid>) -> Job {
        Job {
            id: Uuid::new_v4(),
            owner_id: Uuid::new_v4(),
            job_type: "analysis".into(),
            name: "t".into(),
            status: "completed".into(),
            params,
            created_at: chrono::Utc::now(),
            started_at: None,
            finished_at: None,
            exit_code: Some(0),
            error: None,
            pid: None,
            priority_class: "normal".into(),
            resource_class: "cpu-sandbox".into(),
            req_cpu: None,
            req_mem_bytes: None,
            run_id,
        }
    }

    fn sample_spec() -> AnalysisSpec {
        AnalysisSpec {
            language: Language::Python,
            script: Some("import scanpy\n".into()),
            code_ref: None,
            package: None,
            // #189: no per-job env ⇒ the deployment default (INV-1).
            env: None,
            inputs: vec![],
            produces: vec![],
            schedule: Default::default(),
            extra_mounts: vec![],
            arch: vec![],
            timeout_secs: Some(300),
            seed: Some(42),
            params: serde_json::Value::Null,
            analysis_id: None,
        }
    }

    // TEST-1: build_new_run derives run_id (job.run_id ?? job.id), kind/status,
    // the PROMOTED scientific params, and stashes the full spec for re-run.
    #[test]
    fn build_new_run_shapes_the_sidecar() {
        let params =
            serde_json::json!({ "language": "python", "script": "import scanpy\n", "seed": 42 });
        // No explicit run_id → falls back to job.id. Scope is passed EXPLICITLY into
        // build_new_run now (the job carries none — ITEM-68; the recorder resolves it
        // from `job_scope` before calling this pure builder).
        let job = sample_job(params.clone(), None);
        let project = Uuid::new_v4();
        let nr = build_new_run(
            &job,
            &sample_spec(),
            job.id,
            Some(project),
            None,
            Some("sha256:abc".into()),
            Some("rootfs-digest".into()),
            vec![],
            0,
            None,
            None,
        );
        assert_eq!(nr.run_id, job.id, "run_id falls back to job.id");
        assert_eq!(
            nr.project_id,
            Some(project),
            "project scope threads through"
        );
        assert_eq!(
            nr.dataset_id, None,
            "a project-scoped run has no dataset scope"
        );
        assert_eq!(nr.kind, "compute");
        assert_eq!(nr.status, "completed");
        assert_eq!(nr.seed, Some(42));
        assert_eq!(
            nr.params["seed"], 42,
            "the seed IS a scientific parameter (DEC-1)"
        );
        assert!(
            nr.params.get("script").is_none(),
            "the script is NOT duplicated into params"
        );
        assert_eq!(
            nr.rerun_spec_json.as_ref().unwrap()["script"],
            "import scanpy\n",
            "the full spec is stashed for re-run"
        );

        // **ITEM-5 (DEC-1 = BOTH, DEC-14)** — the trust-view `params` carries the
        // run's SCIENCE (byte-identical to the `/inputs/params.json` the sandbox
        // wrote), and the runtime metadata that used to occupy it is gone.
        let mut filter_spec = sample_spec();
        filter_spec.analysis_id = Some("cell.filter".into());
        filter_spec.params = serde_json::json!({
            "criteria": [{ "column": "pct_counts_mito", "control": "range", "max": 10 }],
            "label": "lowqc",
        });
        let nr3 = build_new_run(
            &job,
            &filter_spec,
            job.id,
            Some(project),
            None,
            None,
            None,
            vec![],
            0,
            None,
            None,
        );
        assert_eq!(
            nr3.generator_id, "cell.filter",
            "the processor id is the generator id"
        );
        assert_eq!(
            nr3.params["criteria"][0]["column"], "pct_counts_mito",
            "the predicate is promoted"
        );
        assert_eq!(nr3.params["criteria"][0]["max"], 10, "…threshold and all");
        assert_eq!(nr3.params["label"], "lowqc");
        assert_eq!(
            nr3.params["seed"], 42,
            "the seed is merged in (the live params.json contract)"
        );
        assert!(
            nr3.params.get("language").is_none(),
            "`language` is no longer in the trust view"
        );
        assert!(
            nr3.params.get("arch").is_none(),
            "`arch` is no longer in the trust view"
        );
        assert_eq!(
            nr3.params,
            crate::modules::sandbox::inputs::params_json_value(
                &filter_spec.params,
                filter_spec.seed
            ),
            "the promoted column IS the object the sandbox wrote to /inputs/params.json"
        );

        // An explicit run_id (a P3 job.run_id) wins over job.id.
        let rid = Uuid::new_v4();
        let job2 = sample_job(params, Some(rid));
        let nr2 = build_new_run(
            &job2,
            &sample_spec(),
            job2.run_id.unwrap_or(job2.id),
            Some(project),
            None,
            None,
            None,
            vec![],
            1,
            None,
            None,
        );
        assert_eq!(nr2.run_id, rid, "explicit run_id wins");
        assert_eq!(nr2.status, "failed", "nonzero exit → failed");
    }

    // ERROR-HANDLING-3 (F2-12), half (a): a genuine DB fault while resolving the
    // declared inputs must PROPAGATE, so `record()` aborts instead of committing a
    // run whose `inputs_json` was silently truncated (or emptied) by the error.
    //
    // RED ON REVERT: turn the `catalog.get` Err arm back into
    // `Err(e) => tracing::warn!(…)` + continue and this returns `Ok(vec![])`.
    #[tokio::test]
    async fn a_db_fault_resolving_inputs_propagates_instead_of_truncating_the_closure() {
        use crate::modules::sandbox::spec::InputDecl;
        use sqlx::postgres::PgPoolOptions;

        // A lazily-connected pool at a closed port: the catalog lookup errors.
        let unreachable = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(2))
            .connect_lazy("postgres://nobody:nobody@127.0.0.1:1/nowhere")
            .expect("build a lazy pool");

        let mut spec = sample_spec();
        spec.inputs = vec![InputDecl {
            slot: "expression".into(),
            artifact_ref: Some(Uuid::new_v4()),
            dataset_file_ref: None,
            dataset_axis_index: None,
            host_path: None,
            draft_ref: None,
            sandbox_subpath: "expression.h5ad".into(),
            bound_by: None,
        }];

        let err = ProvenanceRunRecorder::new(unreachable)
            .resolve_used_edges(Some(Uuid::new_v4()), None, Uuid::new_v4(), &spec)
            .await
            .expect_err("a DB fault while resolving inputs must not read as 'no inputs'");
        assert!(
            !err.to_string().is_empty(),
            "the propagated error carries the real cause: {err}"
        );
    }

    // ERROR-HANDLING-3 (F2-12), half (b): a declared-but-unresolvable input is
    // RECORDED as a hash-less `unresolved` edge, so the loss is persisted + visible
    // and demotes readiness — never a bare log line over a silently shorter list.
    #[test]
    fn an_unresolved_input_is_a_visible_hashless_edge_that_demotes_readiness() {
        use crate::modules::provenance::export::readiness::inputs_checksummed_flag;

        let e = unresolved_edge("expression");
        assert_eq!(e.kind, UNRESOLVED_EDGE_KIND);
        assert_eq!(e.slot, "expression");
        assert!(
            e.content_hash.is_empty(),
            "an unresolved input pins nothing"
        );
        assert!(
            e.ref_id.is_none(),
            "no id is echoed (it may be out of the run's scope)"
        );

        // The readiness projection must NOT call this run's inputs checksummed…
        assert!(
            !inputs_checksummed_flag("compute", Some(&[e.clone()])),
            "an unresolved edge demotes inputs_checksummed"
        );
        assert!(
            !inputs_checksummed_flag("selection", Some(&[e.clone()])),
            "…on every run kind — the marker pins nothing, so no kind is exempt"
        );
        // …nor a compute run whose whole edge list was lost (the vacuous-`all()`
        // bug: an EMPTY conjunction used to answer TRUE).
        assert!(
            !inputs_checksummed_flag("compute", Some(&[])),
            "an empty input set is not a satisfied conjunction for a compute run"
        );
        // …while a genuinely resolved edge still passes.
        let ok = dataset_edge("expression", Uuid::new_v4(), "sha256:ds");
        assert!(
            inputs_checksummed_flag("compute", Some(&[ok.clone()])),
            "a pinned edge is checksummed"
        );
        assert!(
            !inputs_checksummed_flag("compute", Some(&[ok, e])),
            "ONE unresolved input is enough to demote the run"
        );
    }

    // TEST-2: edge_from_artifact maps a run-less artifact → `upload` and a
    // run-produced one → `artifact`, pinning its content hash.
    #[test]
    fn edge_from_artifact_maps_source_kind() {
        let mut art = Artifact {
            id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            run_id: None,
            output_id: "upload".into(),
            datatype: "single-cell/expression".into(),
            object_key: Some("sha256:root".into()),
            is_multifile: false,
            content_hash: "sha256:root".into(),
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({}),
            role: "artifact".into(),
            status: "ready".into(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            hidden: false,
            representation_of: None,
        };
        let root_edge = edge_from_artifact("expression", &art);
        assert_eq!(
            root_edge.kind, "upload",
            "run-less artifact is an upload root"
        );
        assert_eq!(root_edge.content_hash, "sha256:root");
        assert_eq!(root_edge.ref_id, Some(art.id));

        art.run_id = Some(Uuid::new_v4());
        art.content_hash = "sha256:derived".into();
        let derived_edge = edge_from_artifact("input", &art);
        assert_eq!(
            derived_edge.kind, "artifact",
            "run-produced artifact is a prior output"
        );
        assert_eq!(derived_edge.content_hash, "sha256:derived");
    }

    // TEST-35 [ITEM-20]: `dataset_edge` maps a dataset input → `{kind:'dataset',
    // ref_id, content_hash}`; and `backward_reachable`, fed a promoted dataset
    // (a WalkArtifact carrying the promote run), crosses from a downstream
    // consumer → the promote run → the source artifact's run → the upload root.
    #[test]
    fn dataset_edge_maps_kind_and_backward_crosses_promote() {
        // The pure used-edge shape (kind=dataset, ref_id=dataset id, pinned hash).
        let dataset_id = Uuid::new_v4();
        let e = dataset_edge("expression", dataset_id, "sha256:ds");
        assert_eq!(e.kind, "dataset");
        assert_eq!(e.ref_id, Some(dataset_id));
        assert_eq!(e.content_hash, "sha256:ds");

        use crate::modules::provenance::graph::{backward_reachable, WalkArtifact, WalkRun};
        let source_run = Uuid::new_v4(); // consumed root → produced artifact A (sha256:a)
        let promote_run = Uuid::new_v4(); // consumed A → produced dataset D (sha256:ds)
        let consumer = Uuid::new_v4(); // consumed dataset D
        let runs = vec![
            WalkRun {
                run_id: source_run,
                input_hashes: vec!["sha256:root".into()],
            },
            WalkRun {
                run_id: promote_run,
                input_hashes: vec!["sha256:a".into()],
            },
            WalkRun {
                run_id: consumer,
                input_hashes: vec!["sha256:ds".into()],
            },
        ];
        let artifacts = vec![
            WalkArtifact {
                content_hash: "sha256:root".into(),
                run_id: None,
            },
            WalkArtifact {
                content_hash: "sha256:a".into(),
                run_id: Some(source_run),
            },
            // The promoted dataset as a graph node produced by the promote run.
            WalkArtifact {
                content_hash: "sha256:ds".into(),
                run_id: Some(promote_run),
            },
        ];
        let walk = backward_reachable(&[consumer], &runs, &artifacts);
        assert!(walk.runs.contains(&consumer));
        assert!(walk.runs.contains(&promote_run), "crosses the promote node");
        assert!(
            walk.runs.contains(&source_run),
            "reaches the source artifact's run"
        );
        assert!(
            walk.root_hashes.contains("sha256:root"),
            "terminates at the upload root"
        );
    }
}
