//! Provenance graph facade over P1's `workstore` catalog (ITEM-1). P1 stores only
//! the GENERATED edge (`artifacts.run_id`) and no backward walk; this module adds
//! the typed views + the backward-reachability walk (pure, unit-testable) + the
//! DEC-OWN facade WRITE path (`write_generated_artifact` wraps
//! `CatalogRepository::insert_artifact`).

use std::collections::{HashMap, HashSet, VecDeque};

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::dataset::repository::{DatasetRepository, MAX_PER_PAGE};
use crate::modules::workstore::catalog::models::{Artifact, ArtifactFilter, NewArtifact};
use crate::modules::workstore::catalog::repository::CatalogRepository;

use super::export::readiness::{self, RunReadiness};
use super::models::{
    ArtifactNodeDto, ForwardGraphDto, GraphDto, ReadinessDto, RunNodeDto, UsedEdgeDto,
};
use super::repository::{ProvenanceRepository, RunReproRow};

/// A run vertex for the pure walk (its authoritative USED-edge input hashes).
#[derive(Debug, Clone)]
pub struct WalkRun {
    pub run_id: Uuid,
    pub input_hashes: Vec<String>,
}

/// An artifact vertex for the pure walk (its content identity + producing run).
#[derive(Debug, Clone)]
pub struct WalkArtifact {
    pub content_hash: String,
    /// The producing run; `None` for a source/upload/reference root.
    pub run_id: Option<Uuid>,
}

/// The backward-closure result: the reachable run set + the terminating roots +
/// every content-hash the walk followed (the carried-data set — a sibling output
/// the walk never followed is therefore excluded).
#[derive(Debug, Clone, Default)]
pub struct WalkResult {
    pub runs: HashSet<Uuid>,
    pub root_hashes: HashSet<String>,
    pub used_hashes: HashSet<String>,
}

/// Backward-reachability walk P1 does not provide: from `targets`, follow
/// `run → used content_hashes → producing artifacts → their runs` to the roots
/// (an input whose producing artifact has `run_id = NULL`, or that no run
/// produced, terminates the walk as a root hash).
pub fn backward_reachable(
    targets: &[Uuid],
    runs: &[WalkRun],
    artifacts: &[WalkArtifact],
) -> WalkResult {
    let run_by_id: HashMap<Uuid, &WalkRun> = runs.iter().map(|r| (r.run_id, r)).collect();
    // content_hash -> the runs that produced an artifact with that hash.
    let mut producers: HashMap<&str, Vec<Uuid>> = HashMap::new();
    // content_hash -> did a run-less (root) artifact carry it?
    let mut root_producing: HashSet<&str> = HashSet::new();
    for a in artifacts {
        match a.run_id {
            Some(rid) => producers.entry(a.content_hash.as_str()).or_default().push(rid),
            None => {
                root_producing.insert(a.content_hash.as_str());
            }
        }
    }

    let mut result = WalkResult::default();
    let mut queue: VecDeque<Uuid> = targets.iter().copied().collect();
    while let Some(run_id) = queue.pop_front() {
        if !result.runs.insert(run_id) {
            continue; // already visited
        }
        let Some(run) = run_by_id.get(&run_id) else {
            continue;
        };
        for hash in &run.input_hashes {
            result.used_hashes.insert(hash.clone());
            let produced_by = producers.get(hash.as_str());
            let has_producer = produced_by.map(|v| !v.is_empty()).unwrap_or(false);
            if let Some(rids) = produced_by {
                for &rid in rids {
                    if !result.runs.contains(&rid) {
                        queue.push_back(rid);
                    }
                }
            }
            // A hash produced by a run-less artifact, or produced by nothing
            // (a reference/external root), terminates the walk.
            if root_producing.contains(hash.as_str()) || !has_producer {
                result.root_hashes.insert(hash.clone());
            }
        }
    }
    result
}

/// The forward-closure result: the runs derived from the start node + every
/// output content-hash they produced (the "everything derived from THIS" set).
#[derive(Debug, Clone, Default)]
pub struct ForwardResult {
    pub runs: HashSet<Uuid>,
    pub output_hashes: HashSet<String>,
}

/// Forward-reachability walk (the inverse of [`backward_reachable`] over the SAME
/// `inputs_json` edges, ITEM-21 / DEC-20): from `start_hashes` (e.g. a dataset's
/// content hash), follow `hash → runs that USED it → their produced outputs →
/// recurse`. Returns the derived runs + their output hashes. A viz-only
/// intermediate (an output no run consumes) is a leaf — it appears in
/// `output_hashes` but drives no further runs.
pub fn forward_reachable(
    start_hashes: &[String],
    runs: &[WalkRun],
    artifacts: &[WalkArtifact],
) -> ForwardResult {
    // content_hash -> the runs that consumed it (as an input).
    let mut consumers: HashMap<&str, Vec<Uuid>> = HashMap::new();
    for r in runs {
        for h in &r.input_hashes {
            consumers.entry(h.as_str()).or_default().push(r.run_id);
        }
    }
    // run_id -> the content hashes it produced.
    let mut outputs_by_run: HashMap<Uuid, Vec<&str>> = HashMap::new();
    for a in artifacts {
        if let Some(rid) = a.run_id {
            outputs_by_run.entry(rid).or_default().push(a.content_hash.as_str());
        }
    }

    let mut result = ForwardResult::default();
    let mut visited_hashes: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = start_hashes.iter().cloned().collect();
    while let Some(hash) = queue.pop_front() {
        if !visited_hashes.insert(hash.clone()) {
            continue; // already expanded this hash
        }
        let Some(consuming) = consumers.get(hash.as_str()) else {
            continue; // a leaf hash (nothing consumes it)
        };
        for &rid in consuming {
            let newly = result.runs.insert(rid);
            if !newly {
                continue;
            }
            // Push this derived run's outputs forward (recurse).
            if let Some(outs) = outputs_by_run.get(&rid) {
                for &out in outs {
                    result.output_hashes.insert(out.to_string());
                    queue.push_back(out.to_string());
                }
            }
        }
    }
    result
}

/// Project a sidecar row onto its wire DTO (parsing `inputs_json`).
pub fn run_to_dto(row: &RunReproRow) -> RunNodeDto {
    let inputs: Vec<UsedEdgeDto> = parse_inputs_or_log(&row.inputs_json, row.run_id);
    RunNodeDto {
        run_id: row.run_id,
        // A project-scoped run carries its project id; a dataset-scoped run node
        // (owner processing / promote) has none. Such nodes ARE surfaced — the
        // forward-lineage endpoint (`read_forward_graph`) projects dataset-scoped
        // runs — so `project_id` here is the nil UUID as an explicit "not
        // project-scoped" wire sentinel (the DTO field stays non-optional to keep
        // the generated wire type stable; a nil id means "no project").
        project_id: row.project_id.unwrap_or_default(),
        kind: row.kind.clone(),
        status: row.status.clone(),
        generator_id: row.generator_id.clone(),
        generator_version: row.generator_version.clone(),
        code_sha256: row.code_sha256.clone(),
        env_rootfs_sha256: row.env_rootfs_sha256.clone(),
        seed: row.seed,
        // DEC-1 = BOTH. (a) The SCIENTIFIC params, promoted into the column by
        // `recorder::build_new_run` (no `language`/`arch` — runtime metadata is not
        // science). (b) The re-run envelope as its own field, so a reviewer can
        // inspect the full replay spec (and a PRE-promotion run's science) without
        // reverse-engineering it out of `params`.
        params: Some(row.params.clone()),
        // …REDACTED before it leaves the DTO (`redact_rerun_spec`): the raw
        // `rerun_spec_json` is a full `AnalysisSpec` carrying HOST filesystem paths,
        // and this DTO is served to every project VIEWER.
        rerun_spec: row.rerun_spec_json.as_ref().map(redact_rerun_spec),
        inputs,
        acting_user: row.acting_user,
        started_at: row.started_at,
        finished_at: row.finished_at,
        captured_at: row.captured_at,
    }
}

/// Spec keys removed WHOLESALE from a wire `rerun_spec` — every value under them
/// is a HOST filesystem path.
///
/// `extra_mounts` is a list of admin-allowlisted host reference-mount roots
/// (`ExtraMountDecl.host_path`); there is no non-host content in it.
const RERUN_SPEC_DROP_KEYS: [&str; 1] = ["extra_mounts"];

/// Object keys whose VALUE is a host path wherever it appears in the spec tree
/// (`InputDecl.host_path`, and any future carrier spelled the same).
const RERUN_SPEC_HOST_PATH_KEYS: [&str; 1] = ["host_path"];

/// Redact the re-run envelope for the WIRE.
///
/// ## Why (the leak)
///
/// `rerun_spec_json` is the run's full `sandbox::spec::AnalysisSpec`. Surfacing it
/// on `RunNodeDto` (DEC-1 = BOTH) was an owner decision so a reviewer can inspect
/// the replay envelope — but `RunNodeDto` is served by `read_graph` / `list_runs` /
/// `get_run` to **every project VIEWER** (`authz::require_project_read`), and the
/// raw spec carries `InputDecl.host_path` + `extra_mounts[].host_path`, i.e. server
/// filesystem layout. That is the same disclosure the module already refuses
/// elsewhere (`verify::runner::redact_host_paths` scrubs host paths out of an error
/// string before it reaches a viewer or an export bundle).
///
/// ## What survives
///
/// Everything a reviewer needs to read the SCIENCE and the re-run identity:
/// `params` (the FE's only consumer — `predicatePreview.ts` reads
/// `rerun_spec.params`), `language`, `script`/`code_ref`/`package`, `produces`,
/// `schedule`, `arch`, `seed`, `timeout_secs`, `analysis_id`, and each input's
/// logical `slot` / `sandbox_subpath` / declared refs.
///
/// ## What is removed
///
/// * every `host_path` value, at any depth;
/// * `extra_mounts` in full (a pure host-path list);
/// * as a backstop, any REMAINING string leaf that looks like an absolute path is
///   replaced token-wise with `<path>` (the `verify::runner` posture), so a host
///   path smuggled through an unforeseen key does not reach a reader either.
///   The inline `script` is EXEMPT from that backstop: it executes INSIDE the
///   sandbox, so every absolute path in it is a sandbox-internal `/inputs`,
///   `/outputs` or `/code` path (never host layout), and scrubbing them would
///   destroy the reviewer value the field exists for.
///
/// ## Who can see the UNREDACTED spec
///
/// Nobody, over any wire. The re-run path reads `rerun_spec_json` from the
/// repository IN-PROCESS (`ProvenanceRepository::get_rerun_spec` →
/// `verify::runner`), never from this DTO, so verification/replay is unaffected.
/// A manage-gated "raw spec" endpoint was deliberately NOT added: no consumer
/// needs it, and an unused privileged disclosure route is a liability, not a
/// feature. If one is ever needed it belongs behind
/// `provenance::settings::manage` as its own endpoint.
pub fn redact_rerun_spec(spec: &serde_json::Value) -> serde_json::Value {
    /// Keys whose string value is the run's OWN sandbox-internal code — exempt
    /// from the absolute-path backstop (see the doc comment above).
    const VERBATIM_KEYS: [&str; 1] = ["script"];

    fn walk(v: &serde_json::Value, verbatim: bool) -> serde_json::Value {
        match v {
            serde_json::Value::Object(o) => {
                let mut out = serde_json::Map::with_capacity(o.len());
                for (k, val) in o {
                    if RERUN_SPEC_DROP_KEYS.contains(&k.as_str())
                        || RERUN_SPEC_HOST_PATH_KEYS.contains(&k.as_str())
                    {
                        continue;
                    }
                    out.insert(k.clone(), walk(val, VERBATIM_KEYS.contains(&k.as_str())));
                }
                serde_json::Value::Object(out)
            }
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.iter().map(|e| walk(e, verbatim)).collect())
            }
            serde_json::Value::String(s) if !verbatim => {
                serde_json::Value::String(scrub_absolute_paths(s))
            }
            other => other.clone(),
        }
    }
    walk(spec, false)
}

/// Token-wise absolute-path scrub — the same rule as
/// `verify::runner::redact_host_paths` (over-redacting a rare non-path token is
/// acceptable; disclosing a host path is not), applied LINE BY LINE so a
/// multi-line value keeps its structure. A string with no absolute-path token is
/// returned byte-identical, so ordinary values (`python`, `cell.filter`,
/// `sha256:...`, `expression.h5ad`) are untouched.
fn scrub_absolute_paths(s: &str) -> String {
    fn is_path(tok: &str) -> bool {
        let trimmed = tok.trim_matches(|c| c == '(' || c == ')' || c == '"' || c == ':' || c == ',');
        trimmed.starts_with('/') && trimmed.len() > 1
    }
    if !s.contains('/') || !s.split_whitespace().any(is_path) {
        return s.to_string();
    }
    s.split('\n')
        .map(|line| {
            if !line.split_whitespace().any(is_path) {
                return line.to_string();
            }
            line.split_whitespace()
                .map(|tok| if is_path(tok) { "<path>" } else { tok })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn artifact_to_node(a: &Artifact) -> ArtifactNodeDto {
    ArtifactNodeDto {
        id: a.id,
        content_hash: a.content_hash.clone(),
        datatype: a.datatype.clone(),
        run_id: a.run_id,
        output_id: a.output_id.clone(),
        promotable: crate::modules::extensions::is_dataset_input(&a.datatype),
    }
}

/// Parse a run's `inputs_json`, logging a malformed payload. `None` means the
/// payload FAILED TO PARSE — which is NOT the same fact as "this run declared no
/// inputs", and `readiness::inputs_checksummed_flag` scores the two differently.
fn parse_inputs_checked(
    inputs_json: &serde_json::Value,
    run_id: Uuid,
) -> Option<Vec<UsedEdgeDto>> {
    match serde_json::from_value(inputs_json.clone()) {
        Ok(v) => Some(v),
        Err(err) => {
            tracing::error!(run_id = %run_id, "provenance: malformed inputs_json: {err}");
            None
        }
    }
}

/// Parse a run's `inputs_json`, logging (not silently swallowing) a malformed
/// payload before falling back to no inputs. For the DISPLAY/walk paths, where a
/// corrupt payload and an empty one are equivalent (neither yields edges).
fn parse_inputs_or_log(inputs_json: &serde_json::Value, run_id: Uuid) -> Vec<UsedEdgeDto> {
    parse_inputs_checked(inputs_json, run_id).unwrap_or_default()
}

/// The stashed re-run spec's `params` OBJECT (ITEM-4/ITEM-6) — `None` unless the
/// spec carries a JSON object there. A missing row / NULL spec / non-object
/// `params` all read as "not captured".
pub fn rerun_params_object(row: &RunReproRow) -> Option<&serde_json::Value> {
    row.rerun_spec_json.as_ref()?.get("params").filter(|p| p.is_object())
}

/// The per-run readiness facts. The params-fidelity input (ITEM-4) is read
/// straight off the WIDENED row (ITEM-6 / DEC-1), so evaluating the flag for every
/// run in a closure costs no query at all — not even the batched one it replaces.
fn run_readiness(row: &RunReproRow, code_blob_len: Option<usize>) -> RunReadiness {
    let rerun_params = rerun_params_object(row);
    // ERROR-HANDLING-3 (F2-12): this was `inputs.iter().all(|i| !i.content_hash
    // .is_empty())` over a Vec that a malformed payload degraded to `Vec::new()`,
    // i.e. VACUOUSLY TRUE — a compute run whose whole lineage was lost (or whose
    // `inputs_json` was corrupt) affirmatively reported "inputs checksummed" on the
    // readiness checklist. The flag now goes through the SAME strict, kind-aware
    // predicate the export bundle uses (`readiness::inputs_checksummed_flag`), so
    // `GET /provenance/graph` and an exported crate can never disagree about the
    // same run. It also reddens on the recorder's hash-less UNRESOLVED marker edge
    // (`recorder::unresolved_edge`), which is how a declared-but-unresolvable input
    // becomes visible instead of vanishing into a log line.
    let parsed = parse_inputs_checked(&row.inputs_json, row.run_id);
    // ITEM-22: env-pinned now REQUIRES the pinned rootfs digest to still be
    // obtainable (present in the digest-keyed cache / servable). An archived-away
    // digest flips readiness false before an export can claim success (TEST-70).
    let obtainable = super::env_obtain::is_env_obtainable(row.env_rootfs_sha256.as_deref());
    RunReadiness {
        has_seed: row.seed.is_some(),
        // ROUND-3 (F3-1): this was the kind-BLIND `env_pinned_flag`, whose `None`
        // arm ("an interaction run pins its emitter version") is ALSO taken by a
        // COMPUTE run that never resolved a rootfs — so the in-app checklist
        // reported "environment pinned" for exactly the runs the exported
        // `readiness.json` reports unpinned, and whose capsule step renders as
        // `no pinned environment (not executed; provenance-only node)`. Both
        // surfaces now go through the SAME kind-aware predicate, which is what the
        // comment above this function has always claimed.
        env_pinned: readiness::env_pinned_flag_for_kind(
            &row.kind,
            row.env_rootfs_sha256.as_deref(),
            &row.generator_version,
            obtainable,
        ),
        inputs_checksummed: readiness::inputs_checksummed_flag(&row.kind, parsed.as_deref()),
        // ROUND-4 (R3-30): this was the bare `row.code_sha256.is_some()` — a HASH,
        // not the blob — while the export used `code_captured_flag(sha, blob_len)`.
        // A run whose `provenance_code_blobs` row is pruned/absent therefore read
        // `code_captured: true` on the in-app badge and `false` in the exported
        // `readiness.json` for the SAME run: the exact split F3-1 closed for
        // `env_pinned` and `inputs_checksummed`, one flag over. Both surfaces now go
        // through the one predicate, fed by the caller's blob evidence.
        //
        // ROUND-4b (R4B-10): that one predicate is now KIND-aware too — its `None`
        // arm ("a manual node captured no code by design") was being taken by COMPUTE
        // runs that recorded no code, whose capsule step `render_step` emits as
        // `no captured code (not executed; manual step)`. Same vacuous-truth shape as
        // the `env_pinned` `None` arm, so it takes `kind` for the same reason.
        code_captured: readiness::code_captured_flag(
            &row.kind,
            row.code_sha256.as_deref(),
            code_blob_len,
        ),
        params_captured: readiness::params_captured_flag(&row.kind, rerun_params),
    }
}

/// **ROUND-4 (R3F-03)** — the closure-level readiness BOTH surfaces publish (the
/// in-app badge via [`read_graph`], the exported `readiness.json` via
/// `export::bundle::evaluate_bundle_readiness`). Call this, never
/// [`readiness::evaluate`] directly.
///
/// `readiness::evaluate` is the pure fold: five `.all()`s over the per-run facts.
/// Over an EMPTY run set every one of them is VACUOUSLY TRUE, so a closure with no
/// run at all folded to `ready: true` — the export shipped REPRODUCING.md's "passes
/// every condition" over a zip with no runs and no data, and the badge rendered
/// "✓ Reproducible" for a project with roots but nothing recorded.
///
/// Round 3 tried `!runs.is_empty() && …` on `ready` alone and reverted it: flipping
/// only `ready` leaves all six flags true, which renders `LineagePane`'s literal
/// nonsense "⚠ 0 issues" (the badge counts FALSE flags) and makes the export print
/// "the failing conditions are:" followed by nothing. Both objections are about the
/// FLAGS. An empty closure has no evidence for the five RUN-derived conditions, so
/// reporting them as satisfied is the actual error; reporting them false is what
/// lets both surfaces render a coherent, causal "not ready".
///
/// `roots_have_provenance` is NOT run-derived and is passed through unchanged.
///
/// **ROUND-4b (R4B-08)** — the empty-closure guard now lives INSIDE
/// [`readiness::evaluate`], which is no longer `pub` outside
/// `crate::modules::provenance`. Round 4 implemented the guard HERE, in the wrapper,
/// and moved the two known call sites onto it — fixing the callers rather than the
/// function, so a third caller reintroduced the bug by calling the obvious name.
/// This is now a thin delegate, kept as the documented entry point for both surfaces.
pub fn evaluate_closure(runs: &[RunReadiness], roots_have_provenance: bool) -> ReadinessDto {
    readiness::evaluate(runs, roots_have_provenance)
}

/// The in-app `roots_have_provenance` fact: "every root records a content hash".
///
/// ROUND-6 (F1) — `!root_nodes.is_empty()` is the EMPTY-SLICE guard, the same rule
/// the sibling sites carry. `.all()` over an empty slice is `true`, so a closure
/// declaring NO root asserted that its roots have provenance and rendered the
/// readiness badge's "Source data has provenance" over a project with nothing to
/// reproduce FROM. This is the third and last instance of the vacuity R4B-08 closed
/// for `runs` inside `readiness::evaluate` and R6/A2 closed for the export's `roots`
/// in `evaluate_bundle_readiness`; `root_nodes` is not run-derived, so its guard
/// belongs here, at the only place `root_nodes` is folded.
fn roots_have_provenance_flag(root_nodes: &[ArtifactNodeDto]) -> bool {
    !root_nodes.is_empty() && root_nodes.iter().all(|a| !a.content_hash.is_empty())
}

/// **ROUND-4 (R3-30)** — byte length per recorded `code_sha256`, in ONE query, so
/// the graph facade can feed `readiness::code_captured_flag` the same blob evidence
/// the export assembler has. An absent key means the blob is GONE (pruned / never
/// written / a foreign hash).
///
/// NOTE (CODING_GUIDELINES §9): business SQL belongs in `repository.rs`. It sits
/// here because round 4 split file ownership across concurrent workers and
/// `repository.rs` was owned by no one this round — the per-sha `get_code` loop
/// that would have avoided it is an N+1 on a UI endpoint, which is worse. Move it
/// to `ProvenanceRepository` (as `code_blob_lens`) when that file is next touched.
async fn code_blob_lens(
    pool: &PgPool,
    shas: &[String],
) -> Result<HashMap<String, usize>, AppError> {
    if shas.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query!(
        r#"SELECT sha256, byte_len FROM provenance_code_blobs WHERE sha256 = ANY($1)"#,
        shas,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(rows
        .into_iter()
        .map(|r| (r.sha256, r.byte_len.max(0) as usize))
        .collect())
}

/// A dataset graph node loaded into a walk context: the dataset's merkle
/// `content_hash` (the link key), its producing promote run (or `None` for an
/// uploaded root), and its file id(s) for byte staging on export (ITEM-20/21).
#[derive(Debug, Clone)]
pub struct DatasetNode {
    pub dataset_id: Uuid,
    pub datatype: Option<String>,
    pub content_hash: String,
    pub run_id: Option<Uuid>,
    pub file_ids: Vec<Uuid>,
}

impl DatasetNode {
    /// As a walk vertex (content identity + producing run).
    pub fn as_walk_artifact(&self) -> WalkArtifact {
        WalkArtifact { content_hash: self.content_hash.clone(), run_id: self.run_id }
    }
}

/// The loaded provenance node set for a project graph read: the project's runs +
/// artifacts, PLUS the project's attached datasets (as graph nodes) and their
/// dataset-scoped processing/promote runs + artifacts, folded in via a bounded
/// fixpoint over the dataset ids reached through `dataset` used-edges (ITEM-20).
/// Datasets the caller cannot see are filtered out of the fold (they are
/// separately permissioned resources — a project viewer is not automatically a
/// dataset sharee), so a project graph read never over-discloses a private
/// dataset's owner-lineage.
pub struct WalkContext {
    pub runs: Vec<RunReproRow>,
    pub artifacts: Vec<Artifact>,
    pub dataset_nodes: Vec<DatasetNode>,
}

impl WalkContext {
    /// The run vertices for the pure walk.
    pub(crate) fn walk_runs(&self) -> Vec<WalkRun> {
        self.runs
            .iter()
            .map(|r| WalkRun {
                run_id: r.run_id,
                // An UNRESOLVED marker edge carries no content identity (empty
                // hash), so it is not walkable: it would otherwise enter the walk
                // as a `""` root hash and be carried into an export bundle. It
                // still rides `inputs_json` (and so demotes `inputs_checksummed`
                // + shows on the run node) — it just isn't a graph vertex.
                input_hashes: parse_inputs_or_log(&r.inputs_json, r.run_id)
                    .into_iter()
                    .map(|e| e.content_hash)
                    .filter(|h| !h.is_empty())
                    .collect(),
            })
            .collect()
    }

    /// The artifact vertices for the pure walk — catalog artifacts PLUS the
    /// datasets fed as content-hashed nodes (uploaded → root; promoted → the
    /// promote run).
    pub(crate) fn walk_artifacts(&self) -> Vec<WalkArtifact> {
        let mut v: Vec<WalkArtifact> = self
            .artifacts
            .iter()
            .map(|a| WalkArtifact { content_hash: a.content_hash.clone(), run_id: a.run_id })
            .collect();
        v.extend(self.dataset_nodes.iter().map(DatasetNode::as_walk_artifact));
        v
    }
}

/// Load the project's provenance graph node set + fold in its attached datasets'
/// owner-scoped processing lineage (ITEM-20). Bounded: a fixpoint over the
/// dataset ids reachable through the project's attach list + `dataset` used-edges.
pub(crate) async fn load_project_walk_context(
    pool: &PgPool,
    project_id: Uuid,
    caller_id: Uuid,
    group_ids: &[Uuid],
) -> Result<WalkContext, AppError> {
    let prov = ProvenanceRepository::new(pool.clone());
    let catalog = CatalogRepository::new(pool.clone());
    let dataset_repo = DatasetRepository::new(pool.clone());

    let mut runs = prov.runs_for_project(project_id).await?;
    let mut artifacts = catalog
        .list_by_project(project_id, &ArtifactFilter::default(), None)
        .await?;

    // Seed the dataset frontier: attached datasets + any dataset a loaded run used.
    let mut queue: VecDeque<Uuid> =
        prov.dataset_ids_for_project(project_id).await?.into_iter().collect();
    for r in &runs {
        for e in parse_inputs_or_log(&r.inputs_json, r.run_id) {
            if e.kind == "dataset" {
                if let Some(id) = e.ref_id {
                    queue.push_back(id);
                }
            }
        }
    }

    let mut seen: HashSet<Uuid> = HashSet::new();
    let mut dataset_nodes: Vec<DatasetNode> = Vec::new();
    while let Some(did) = queue.pop_front() {
        if !seen.insert(did) {
            continue;
        }
        // Per-dataset visibility filter (do NOT authorize-once): a dataset the
        // caller cannot see — even one merely referenced by a `dataset` used-edge
        // — contributes NO node/runs/artifacts to the project graph, and the walk
        // does not traverse through it (cross-user over-disclosure guard).
        if !dataset_repo.is_visible_to(did, caller_id, group_ids).await? {
            continue;
        }
        if let Some(ds) = dataset_repo.get(did).await? {
            if let Some(hash) = ds.content_hash.clone() {
                let promote_run = prov.promote_run_for_dataset(did).await?;
                // Provenance nodes need the dataset's full file set; a single-cell
                // dataset is well under the page cap (§4 bounded select).
                let files = dataset_repo.list_files(did, 1, MAX_PER_PAGE).await?;
                dataset_nodes.push(DatasetNode {
                    dataset_id: did,
                    datatype: ds.datatype.clone(),
                    content_hash: hash,
                    run_id: promote_run,
                    file_ids: files.iter().map(|f| f.file_id).collect(),
                });
            }
        }
        // Fold the dataset-scoped runs + artifacts + discover further datasets.
        for r in prov.runs_for_dataset(did).await? {
            for e in parse_inputs_or_log(&r.inputs_json, r.run_id) {
                if e.kind == "dataset" {
                    if let Some(id) = e.ref_id {
                        queue.push_back(id);
                    }
                }
            }
            runs.push(r);
        }
        artifacts.extend(prov.artifacts_for_dataset(did).await?);
    }

    Ok(WalkContext { runs, artifacts, dataset_nodes })
}

/// Project an uploaded-dataset root as an artifact-shaped graph node (its id is
/// the dataset id; `run_id=None` marks it a true root).
fn dataset_root_node(dn: &DatasetNode) -> ArtifactNodeDto {
    ArtifactNodeDto {
        id: dn.dataset_id,
        content_hash: dn.content_hash.clone(),
        datatype: dn.datatype.clone().unwrap_or_else(|| "dataset".to_string()),
        run_id: None,
        output_id: "dataset".to_string(),
        // A dataset root is already a dataset — never a promote target.
        promotable: false,
    }
}

/// Load + walk the graph for a project (or a target's backward closure) and compute
/// readiness (ITEM-1/20/21). Datasets attached to the project are fed as
/// content-hashed graph nodes (uploaded → root; promoted → the promote run), so
/// the chain traces final-output → … → dataset → promote-run → source artifact →
/// … → an uploaded-dataset root (ITEM-20).
pub async fn read_graph(
    pool: &PgPool,
    project_id: Uuid,
    target: Option<Uuid>,
    caller_id: Uuid,
    group_ids: &[Uuid],
) -> Result<GraphDto, AppError> {
    let ctx = load_project_walk_context(pool, project_id, caller_id, group_ids).await?;
    let walk_runs = ctx.walk_runs();
    let walk_artifacts = ctx.walk_artifacts();

    let (included_runs, root_nodes): (Vec<&RunReproRow>, Vec<ArtifactNodeDto>) = match target {
        Some(t) => {
            // Resolve the target to a run id (a run, the run that produced an
            // artifact, or the promote run that produced a dataset with that id).
            let target_run = if ctx.runs.iter().any(|r| r.run_id == t) {
                Some(t)
            } else if let Some(a) = ctx.artifacts.iter().find(|a| a.id == t) {
                a.run_id
            } else {
                ctx.dataset_nodes.iter().find(|d| d.dataset_id == t).and_then(|d| d.run_id)
            };
            let walk = match target_run {
                Some(tr) => backward_reachable(&[tr], &walk_runs, &walk_artifacts),
                None => WalkResult::default(),
            };
            let runs: Vec<&RunReproRow> =
                ctx.runs.iter().filter(|r| walk.runs.contains(&r.run_id)).collect();
            let mut roots: Vec<ArtifactNodeDto> = ctx
                .artifacts
                .iter()
                .filter(|a| a.run_id.is_none() && walk.root_hashes.contains(&a.content_hash))
                .map(artifact_to_node)
                .collect();
            roots.extend(
                ctx.dataset_nodes
                    .iter()
                    .filter(|d| d.run_id.is_none() && walk.root_hashes.contains(&d.content_hash))
                    .map(dataset_root_node),
            );
            (runs, roots)
        }
        None => {
            let runs: Vec<&RunReproRow> = ctx.runs.iter().collect();
            let mut roots: Vec<ArtifactNodeDto> = ctx
                .artifacts
                .iter()
                .filter(|a| a.run_id.is_none())
                .map(artifact_to_node)
                .collect();
            roots.extend(
                ctx.dataset_nodes.iter().filter(|d| d.run_id.is_none()).map(dataset_root_node),
            );
            (runs, roots)
        }
    };

    // ITEM-4/ITEM-6: the params-fidelity input rides the widened `RunReproRow` the
    // walk already loaded — zero extra queries (no per-run read, no batch).
    //
    // ROUND-4 (R3-30): the `code_captured` flag needs the BLOB, not just the hash —
    // fetched for every included run's distinct sha in ONE query (never per run).
    let mut shas: Vec<String> = included_runs
        .iter()
        .filter_map(|r| r.code_sha256.clone())
        .collect();
    shas.sort();
    shas.dedup();
    let blob_lens = code_blob_lens(pool, &shas).await?;
    let run_facts: Vec<RunReadiness> = included_runs
        .iter()
        .map(|r| {
            let len = r.code_sha256.as_deref().and_then(|s| blob_lens.get(s).copied());
            run_readiness(r, len)
        })
        .collect();
    // ROUND-4b (R4B-09) — a DELIBERATE, documented asymmetry with the export's
    // `roots_have_provenance`, recorded here so it is not mistaken for the empty-
    // closure asymmetry that round 4b closed.
    //
    // Both surfaces now derive their issue set from the SAME `ReadinessDto` fold
    // (`evaluate_closure`), so the badge's "⚠ N issues" and the export's N gap
    // bullets always agree in COUNT and CAUSE for the five run-derived flags. This
    // ONE flag answers a different question on each surface, because the surfaces
    // have different evidence: in-app it means "every root records a content hash"
    // (all the graph facade can know without statting the object store per root, an
    // N-query on a page load); in the exported bundle it means "every root's BYTES
    // are in this zip" (R4B-01), which only the assembler can know. A project can
    // therefore read green in-app and redden on export — that is the honest reading
    // of two different claims, not a fold that disagrees with itself.
    let roots_have_provenance = roots_have_provenance_flag(&root_nodes);
    let readiness: ReadinessDto = evaluate_closure(&run_facts, roots_have_provenance);

    Ok(GraphDto {
        runs: included_runs.iter().map(|r| run_to_dto(r)).collect(),
        roots: root_nodes,
        readiness,
    })
}

/// Load + FORWARD-walk from a dataset (ITEM-21 / DEC-20): "everything derived from
/// THIS dataset until the end", across promote boundaries, both branches of a
/// fan-out. Bounded by the dataset's processing lineage + any datasets promoted
/// from its artifacts (discovered via the owner's promote runs), but each
/// downstream dataset is folded in ONLY if the CALLER can see it — a view-sharee
/// of the start dataset must never learn the runs (code/params/acting_user) or
/// artifact hashes of a PRIVATE downstream dataset (cross-user leak guard). The
/// forward walk therefore filters per dataset; it does not authorize once at the
/// start and then trust the whole downstream closure.
pub async fn read_forward_graph(
    pool: &PgPool,
    dataset_id: Uuid,
    caller_id: Uuid,
    group_ids: &[Uuid],
) -> Result<ForwardGraphDto, AppError> {
    let prov = ProvenanceRepository::new(pool.clone());
    let dataset_repo = DatasetRepository::new(pool.clone());

    let dataset = dataset_repo
        .get(dataset_id)
        .await?
        .ok_or_else(|| AppError::not_found("Dataset"))?;
    let Some(start_hash) = dataset.content_hash.clone() else {
        // A dataset with no files/hash yet has no forward lineage.
        return Ok(ForwardGraphDto {
            dataset_id,
            content_hash: String::new(),
            runs: Vec::new(),
            outputs: Vec::new(),
        });
    };

    // Promote runs owned by the dataset owner — used to cross the promote boundary
    // forward (a downstream promoted dataset consumed one of this chain's artifacts).
    let promote_runs = prov.promote_runs_for_user(dataset.owner_id).await?;

    let mut runs: Vec<RunReproRow> = Vec::new();
    let mut artifacts: Vec<Artifact> = Vec::new();
    let mut dataset_nodes: Vec<DatasetNode> = Vec::new();
    let mut seen: HashSet<Uuid> = HashSet::new();
    let mut queue: VecDeque<Uuid> = VecDeque::from([dataset_id]);

    while let Some(did) = queue.pop_front() {
        if !seen.insert(did) {
            continue;
        }
        // Per-dataset visibility filter (do NOT authorize-once): a downstream
        // dataset the caller cannot see contributes NO runs/artifacts/node to the
        // forward graph, and the walk does not cross through it. The start dataset
        // was pre-authorized by the handler; this re-check is the leak guard for
        // every dataset the walk discovers past the promote boundary.
        if !dataset_repo.is_visible_to(did, caller_id, group_ids).await? {
            continue;
        }
        if let Some(ds) = dataset_repo.get(did).await? {
            if let Some(hash) = ds.content_hash.clone() {
                let promote_run = prov.promote_run_for_dataset(did).await?;
                // Provenance nodes need the dataset's full file set; a single-cell
                // dataset is well under the page cap (§4 bounded select).
                let files = dataset_repo.list_files(did, 1, MAX_PER_PAGE).await?;
                dataset_nodes.push(DatasetNode {
                    dataset_id: did,
                    datatype: ds.datatype.clone(),
                    content_hash: hash,
                    run_id: promote_run,
                    file_ids: files.iter().map(|f| f.file_id).collect(),
                });
            }
        }
        let ds_arts = prov.artifacts_for_dataset(did).await?;
        let art_hashes: HashSet<String> =
            ds_arts.iter().map(|a| a.content_hash.clone()).collect();
        // Any dataset promoted FROM one of this dataset's artifacts is downstream.
        for pr in &promote_runs {
            for e in parse_inputs_or_log(&pr.inputs_json, pr.run_id) {
                if art_hashes.contains(&e.content_hash) {
                    if let Some(new_ds) = pr.dataset_id {
                        queue.push_back(new_ds);
                    }
                }
            }
        }
        runs.extend(prov.runs_for_dataset(did).await?);
        artifacts.extend(ds_arts);
    }

    let ctx = WalkContext { runs, artifacts, dataset_nodes };
    let walk_runs = ctx.walk_runs();
    let walk_artifacts = ctx.walk_artifacts();
    let fwd = forward_reachable(&[start_hash.clone()], &walk_runs, &walk_artifacts);

    let out_runs: Vec<RunNodeDto> = ctx
        .runs
        .iter()
        .filter(|r| fwd.runs.contains(&r.run_id))
        .map(run_to_dto)
        .collect();
    let outputs: Vec<ArtifactNodeDto> = ctx
        .artifacts
        .iter()
        .filter(|a| fwd.output_hashes.contains(&a.content_hash))
        .map(artifact_to_node)
        .collect();

    Ok(ForwardGraphDto { dataset_id, content_hash: start_hash, runs: out_runs, outputs })
}

/// **ROUND-4 (R3-01)** — the interaction chokepoint's two DB writes as ONE
/// transaction: the generated cell-set artifact and the run node that produced it.
///
/// They used to be two independent pool writes (artifact, then run) with a
/// compensating delete on the run-insert error arm. That arm covers a FAILED
/// insert; it does not cover a **dropped future** — a client disconnect, an axum
/// handler cancellation, a losing `select!` arm — which can land between the two
/// commits and never runs the compensation. The artifact stayed committed in P1's
/// catalog with `run_id` naming a run that was never inserted and never would be,
/// and `artifacts.run_id` has no FK, so nothing reclaimed it: the graph walk saw a
/// cell-set produced by a nonexistent run. Inside one transaction, a dropped future
/// drops the connection and Postgres rolls the whole capture back.
///
/// The object-store `put` still happens before this (no transaction can span it),
/// which is fine and unchanged: the recipe blob is content-addressed, so a retry
/// re-uses it and the workstore GC reclaims an unreferenced one.
///
/// NOTE (CODING_GUIDELINES §9): the run INSERT below is the transaction-scoped twin
/// of `repository::ProvenanceRepository::insert_run`, and business SQL belongs in
/// `repository.rs`. It sits here because round 4 split file ownership across
/// concurrent workers and `repository.rs` was owned by no one; both statements are
/// `query_as!`-checked against the same `RunReproRow`, so a schema change breaks the
/// build rather than letting them silently diverge. Fold them into a single
/// `ProvenanceRepository::insert_run_in_tx` when `repository.rs` is next touched.
pub async fn write_capture_atomically(
    pool: &PgPool,
    artifact: &NewArtifact,
    run: &super::repository::NewRun,
) -> Result<(Artifact, RunReproRow), AppError> {
    let mut tx = pool.begin().await.map_err(AppError::database_error)?;
    let art = CatalogRepository::insert_artifact_in_tx(&mut tx, artifact).await?;
    let row = sqlx::query_as!(
        RunReproRow,
        r#"INSERT INTO provenance_run_repro
             (run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
              code_sha256, env_rootfs_sha256, lockfile_json, seed, params,
              inputs_json, acting_user, rerun_spec_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                     code_sha256, env_rootfs_sha256,
                     lockfile_json as "lockfile_json?: serde_json::Value",
                     seed,
                     params as "params: serde_json::Value",
                     inputs_json as "inputs_json: serde_json::Value",
                     rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                     acting_user,
                     started_at as "started_at?: chrono::DateTime<chrono::Utc>",
                     finished_at as "finished_at?: chrono::DateTime<chrono::Utc>",
                     captured_at as "captured_at: chrono::DateTime<chrono::Utc>""#,
        run.run_id,
        run.project_id,
        run.dataset_id,
        run.kind,
        run.status,
        run.generator_id,
        run.generator_version,
        run.code_sha256,
        run.env_rootfs_sha256,
        run.lockfile_json,
        run.seed,
        run.params,
        run.inputs_json,
        run.acting_user,
        run.rerun_spec_json,
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::database_error)?;
    tx.commit().await.map_err(AppError::database_error)?;
    Ok((art, row))
}

/// The DEC-OWN facade WRITE path into P1's generated-edge graph: write one
/// generated artifact via `CatalogRepository::insert_artifact`. P4 never creates
/// a parallel catalog table.
#[allow(clippy::too_many_arguments)]
pub async fn write_generated_artifact(
    pool: &PgPool,
    project_id: Uuid,
    run_id: Option<Uuid>,
    output_id: &str,
    datatype: &str,
    object_key: &str,
    content_hash: &str,
    stored_bytes: i64,
    created_by: Option<Uuid>,
) -> Result<Artifact, AppError> {
    let catalog = CatalogRepository::new(pool.clone());
    catalog
        .insert_artifact(&NewArtifact {
            project_id: Some(project_id), // ITEM-23: project/dataset scope is now nullable
            dataset_id: None,
            run_id,
            output_id: output_id.to_string(),
            datatype: datatype.to_string(),
            // Real handling: a server-authored artifact writes its blob here, so it
            // always has a key. Gathered artifacts are produced only by the alignment
            // analysis, never by this path.
            object_key: Some(object_key.to_string()),
            is_multifile: false,
            content_hash: content_hash.to_string(),
            // Server-authored artifact: the server is the producer here, so it
            // declares explicitly rather than defaulting (INV-2). Opaque bytes
            // carry no array structure; the meaning is its provenance role.
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({ "origin": "provenance" }),
            // A server-authored provenance artifact is a first-class, exportable one.
            role: crate::modules::sandbox::outputs::ROLE_ARTIFACT.to_string(),
            stored_bytes,
            // This path WRITES the blob, so the two quantities coincide exactly.
            logical_bytes: Some(stored_bytes),
            created_by,
            hidden: false,
            representation_of: None,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // ERROR-HANDLING-3 (F2-12): the readiness the GRAPH endpoint publishes was a
    // bare `.all()` over the parsed used-edges, which is VACUOUSLY TRUE for an empty
    // vec — a compute run whose lineage was entirely lost affirmatively reported
    // "inputs checksummed" — and a MALFORMED `inputs_json` took the same path, so
    // corrupt provenance scored greener than complete provenance. `run_readiness`
    // now routes through the strict kind-aware `readiness::inputs_checksummed_flag`
    // (the same predicate the export bundle uses, so the two surfaces cannot
    // disagree), fed a `None` on a parse failure.
    //
    // RED ON REVERT: restore `inputs_checksummed: inputs.iter().all(|i| !i
    // .content_hash.is_empty())` over `parse_inputs_or_log(..)` and both the
    // empty-compute and the malformed case come back true.
    #[test]
    fn graph_readiness_is_not_vacuously_checksummed() {
        let row = |kind: &str, inputs: serde_json::Value| RunReproRow {
            run_id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            kind: kind.to_string(),
            status: "completed".into(),
            generator_id: "cell.filter".into(),
            generator_version: "0.0.0".into(),
            code_sha256: Some("sha256:code".into()),
            env_rootfs_sha256: None,
            lockfile_json: None,
            seed: Some(0),
            params: serde_json::json!({}),
            inputs_json: inputs,
            rerun_spec_json: None,
            acting_user: None,
            started_at: None,
            finished_at: None,
            captured_at: chrono::Utc::now(),
        };
        let pinned = serde_json::json!([
            { "slot": "expression", "kind": "upload", "ref_id": null, "content_hash": "sha256:root" }
        ]);
        let unresolved =
            serde_json::to_value(vec![super::super::recorder::unresolved_edge("expression")])
                .unwrap();

        assert!(
            run_readiness(&row("compute", pinned.clone()), Some(1)).inputs_checksummed,
            "a pinned edge is checksummed"
        );
        assert!(
            !run_readiness(&row("compute", serde_json::json!([])), Some(1)).inputs_checksummed,
            "a COMPUTE run with zero used-edges is a gap — an empty conjunction is \
             not a satisfied one (this is the exact row the auditor inserted)"
        );
        assert!(
            !run_readiness(&row("compute", serde_json::json!("not-a-list")), Some(1)).inputs_checksummed,
            "a MALFORMED inputs_json is corruption, not 'no inputs'"
        );
        assert!(
            !run_readiness(&row("compute", unresolved.clone()), Some(1)).inputs_checksummed,
            "a declared-but-unresolved input demotes the flag"
        );
        assert!(
            !run_readiness(&row("selection", unresolved), Some(1)).inputs_checksummed,
            "…on every run kind, since the marker pins nothing"
        );
    }

    // ROUND-3 / F3-1. `run_readiness` is the checklist `GET /provenance/graph`
    // publishes; `export::bundle::evaluate_bundle_readiness` is the checklist the
    // exported `readiness.json` publishes. They MUST agree about a given run —
    // the comment above `run_readiness` asserts exactly that. `inputs_checksummed`
    // was brought onto the shared strict predicate; `env_pinned` was not, and stayed
    // on the kind-BLIND `env_pinned_flag`, whose `None` arm reads "an interaction
    // run pins its emitter version" — TRUE for a COMPUTE run that never resolved a
    // rootfs. So the in-app badge said "environment pinned" for precisely the runs
    // whose export says the opposite, and whose capsule renders the step as
    // `no pinned environment (not executed; provenance-only node)`.
    //
    // RED ON REVERT: restore `env_pinned: readiness::env_pinned_flag(row
    // .env_rootfs_sha256.as_deref(), &row.generator_version, obtainable)` and the
    // compute-with-no-digest case flips back to `true`.
    #[test]
    fn graph_env_pinned_agrees_with_the_export_checklist() {
        let row = |kind: &str, digest: Option<&str>| RunReproRow {
            run_id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            kind: kind.to_string(),
            status: "completed".into(),
            generator_id: "cell.filter".into(),
            generator_version: "0.0.0".into(),
            code_sha256: Some("sha256:code".into()),
            env_rootfs_sha256: digest.map(str::to_string),
            lockfile_json: None,
            seed: Some(0),
            params: serde_json::json!({}),
            inputs_json: serde_json::json!([]),
            rerun_spec_json: None,
            acting_user: None,
            started_at: None,
            finished_at: None,
            captured_at: chrono::Utc::now(),
        };

        // The defect: a COMPUTE run that pinned no rootfs.
        let compute = row("compute", None);
        let graph_flag = run_readiness(&compute, Some(1)).env_pinned;
        let export_flag = readiness::env_pinned_flag_for_kind(
            &compute.kind,
            compute.env_rootfs_sha256.as_deref(),
            &compute.generator_version,
            crate::modules::provenance::env_obtain::is_env_obtainable(compute.env_rootfs_sha256.as_deref()),
        );
        assert_eq!(
            graph_flag, export_flag,
            "the graph checklist and the export checklist must agree about the same run"
        );
        assert!(
            !graph_flag,
            "a compute run with no rootfs digest is NOT env-pinned — its replay is a no-op"
        );

        // An in-app interaction/promote run legitimately pins the emitter version,
        // not a rootfs: the kind-aware form must NOT regress that to false.
        for kind in ["selection.column", "promote", "selection.polygon"] {
            let r = row(kind, None);
            assert!(
                run_readiness(&r, Some(1)).env_pinned,
                "{kind}: an in-app run pins the emitter version, not a rootfs"
            );
            assert_eq!(
                run_readiness(&r, Some(1)).env_pinned,
                readiness::env_pinned_flag_for_kind(
                    &r.kind,
                    None,
                    &r.generator_version,
                    crate::modules::provenance::env_obtain::is_env_obtainable(None),
                ),
                "{kind}: still agrees with the export checklist"
            );
        }
    }

    /// ROUND-4 / R3-30 — the `code_captured` half of the F3-1 split.
    ///
    /// F3-1 moved `env_pinned` and `inputs_checksummed` onto the SAME predicates the
    /// export uses, but left `code_captured` as the bare `row.code_sha256.is_some()`
    /// — a hash, not the blob. The export uses `code_captured_flag(sha, blob_len)`,
    /// which reads a PRUNED / never-written / foreign hash as a gap. So a run whose
    /// `provenance_code_blobs` row is gone reported `code_captured: true` on the
    /// in-app badge and `false` in the exported `readiness.json` for the same run —
    /// the identical split F3-1 was written to close, one flag over.
    ///
    /// RED BEFORE THE FIX: `run_readiness` took no blob evidence at all, so the
    /// ghost-blob run answered `true` while the export answered `false`.
    #[test]
    fn graph_code_captured_agrees_with_the_export_checklist() {
        let row = |code: Option<&str>| RunReproRow {
            run_id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            kind: "compute".into(),
            status: "completed".into(),
            generator_id: "cell.filter".into(),
            generator_version: "0.0.0".into(),
            code_sha256: code.map(str::to_string),
            env_rootfs_sha256: Some("deadbeef".into()),
            lockfile_json: None,
            seed: Some(0),
            params: serde_json::json!({}),
            inputs_json: serde_json::json!([]),
            rerun_spec_json: None,
            acting_user: None,
            started_at: None,
            finished_at: None,
            captured_at: chrono::Utc::now(),
        };

        // The defect: a recorded hash whose BLOB is gone (pruned / never written).
        let ghost = row(Some("deadbeef"));
        let graph_flag = run_readiness(&ghost, None).code_captured;
        let export_flag =
            readiness::code_captured_flag(&ghost.kind, ghost.code_sha256.as_deref(), None);
        assert_eq!(
            graph_flag, export_flag,
            "the graph checklist and the export checklist must agree about the same run"
        );
        assert!(!graph_flag, "a hash with no blob is NOT captured code — the capsule refuses to run");

        // An EMPTY blob is equally not captured code.
        assert!(!run_readiness(&ghost, Some(0)).code_captured);
        // A present, non-empty blob is.
        assert!(run_readiness(&ghost, Some(120)).code_captured);
        // ROUND-4b (R4B-10) — **this assertion was FLIPPED.** It used to read
        // `assert!(run_readiness(&row(None), None).code_captured)` under the comment
        // "a node that captured no code BY DESIGN keeps its green flag". But `row`
        // builds a `kind: "compute"` run, so what it actually pinned was a COMPUTE
        // run with NO recorded code reporting `code_captured: true` — a readiness
        // surface asserting a capture that never happened, over a step
        // `render_step` emits as `no captured code (not executed; manual step)`.
        // The by-design rationale is real but belongs to NON-compute runs, which is
        // now where the green flag lives.
        let manual_compute = row(None);
        assert!(
            !run_readiness(&manual_compute, None).code_captured,
            "a COMPUTE run that recorded no code is a gap, not a by-design manual node"
        );
        // The by-design arm, on the kinds it was always about (DEC-9 §5).
        for kind in ["selection", "annotation", "group", "promote", "interaction"] {
            let mut manual = row(None);
            manual.kind = kind.into();
            assert!(
                run_readiness(&manual, None).code_captured,
                "{kind} captured no code BY DESIGN — no false reddening"
            );
            assert_eq!(
                run_readiness(&manual, None).code_captured,
                readiness::code_captured_flag(kind, None, None),
                "the manual-node arm agrees too"
            );
        }
        // A blank hash is not a pin either (R3-28's shape, via the shared predicate).
        let blank = row(Some("   "));
        assert_eq!(
            run_readiness(&blank, Some(9)).code_captured,
            readiness::code_captured_flag(&blank.kind, Some("   "), Some(9)),
        );
    }

    /// ROUND-4 / R3F-03 — what readiness MEANS for a closure with no runs.
    ///
    /// `readiness::evaluate` folds five `.all()`s, every one of which is VACUOUSLY
    /// TRUE over an empty run set, so a closure containing no run at all answered
    /// `ready: true`: the export shipped REPRODUCING.md's "passes every condition"
    /// over a zip with no runs and no data, and the in-app badge rendered
    /// "✓ Reproducible" for a project with roots but nothing recorded.
    ///
    /// Round 3 tried the one-line `!runs.is_empty() &&` guard on `ready` and reverted
    /// it, because flipping ONLY `ready` leaves all six flags true — which renders
    /// `LineagePane`'s literal nonsense "⚠ 0 issues" (the badge counts FALSE flags)
    /// and makes `readiness_gap_lines` print "the failing conditions are:" followed
    /// by nothing. Both objections are about the FLAGS, not about `ready`: an empty
    /// closure has not SATISFIED the five run-derived conditions, it has no evidence
    /// for them. Reporting them false is what makes both surfaces render coherently
    /// ("⚠ 5 issues", and a gap list with a cause in it).
    ///
    /// `roots_have_provenance` is NOT run-derived, so it stays honest.
    ///
    /// RED BEFORE THE FIX: `readiness::evaluate(&[], true).ready == true`.
    #[test]
    fn a_closure_with_no_runs_is_not_reported_reproducible() {
        let d = evaluate_closure(&[], true);
        assert!(
            !d.ready,
            "a closure with no captured run cannot be 'reproducible' — there is nothing to re-run"
        );
        assert!(
            !d.seeds_set
                && !d.env_pinned
                && !d.inputs_checksummed
                && !d.code_captured
                && !d.params_captured,
            "the five RUN-derived flags have no evidence, so they are not satisfied; leaving \
             them vacuously true is what renders the badge's '0 issues' nonsense"
        );
        assert!(
            d.roots_have_provenance,
            "the roots fact is not run-derived and stays honest"
        );

        // …and an empty closure whose roots are ALSO broken says so on both counts.
        let d = evaluate_closure(&[], false);
        assert!(!d.roots_have_provenance && !d.ready);

        // A non-empty closure is byte-identical to the pure fold — this changes the
        // EMPTY case only.
        let ok = RunReadiness {
            has_seed: true,
            env_pinned: true,
            inputs_checksummed: true,
            code_captured: true,
            params_captured: true,
        };
        let mine = evaluate_closure(&[ok], true);
        let pure = readiness::evaluate(&[ok], true);
        assert_eq!(
            (mine.ready, mine.seeds_set, mine.env_pinned, mine.inputs_checksummed, mine.code_captured, mine.params_captured, mine.roots_have_provenance),
            (pure.ready, pure.seeds_set, pure.env_pinned, pure.inputs_checksummed, pure.code_captured, pure.params_captured, pure.roots_have_provenance),
            "a closure WITH runs is unchanged"
        );
        assert!(mine.ready);
        let broken = RunReadiness { has_seed: false, ..ok };
        assert!(!evaluate_closure(&[broken], true).ready);
    }

    /// ROUND-6 (F1) — the THIRD instance of the empty-slice vacuity class, at the
    /// surface the in-app readiness badge reads.
    ///
    /// `root_nodes.iter().all(..)` is VACUOUSLY TRUE over a closure with ZERO roots,
    /// so a project declaring no source data at all affirmatively reported "source
    /// data has provenance" — reproducibility evidence it does not have. R4B-08
    /// closed this for `runs` inside `readiness::evaluate`; the round-6 sibling closed
    /// it for the export's `roots` in `evaluate_bundle_readiness`. `root_nodes` is not
    /// run-derived, so its guard belongs here, at the only place it is folded.
    ///
    /// RED BEFORE THE FIX: `roots_have_provenance_flag(&[]) == true`.
    #[test]
    fn a_closure_with_no_roots_does_not_claim_root_provenance() {
        let root = |hash: &str| ArtifactNodeDto {
            id: Uuid::nil(),
            content_hash: hash.to_string(),
            datatype: "t".into(),
            run_id: None,
            output_id: "o".into(),
            promotable: false,
        };
        assert!(
            !roots_have_provenance_flag(&[]),
            "a closure with NO root cannot claim its roots have provenance — there is \
             nothing to reproduce FROM"
        );
        // The non-empty cases are unchanged: this closes the empty hole only, and
        // preserves the in-app meaning ("every root records a content hash"), which is
        // deliberately NOT the export's ("every root's BYTES are in this zip").
        assert!(roots_have_provenance_flag(&[root("sha256:aa")]));
        assert!(!roots_have_provenance_flag(&[root("sha256:aa"), root("")]));
    }

    // The unresolved marker rides `inputs_json` (so it is visible + demotes
    // readiness) but must never enter the WALK as a `""` root hash, or an export
    // would carry a nonexistent blob name.
    #[test]
    fn an_unresolved_edge_is_not_a_walk_vertex() {
        let run_id = Uuid::new_v4();
        let inputs = serde_json::to_value(vec![
            UsedEdgeDto {
                slot: "expression".into(),
                kind: "upload".into(),
                ref_id: None,
                content_hash: "sha256:root".into(),
                bound_by: None,
            },
            super::super::recorder::unresolved_edge("aux"),
        ])
        .unwrap();
        let hashes: Vec<String> = parse_inputs_or_log(&inputs, run_id)
            .into_iter()
            .map(|e| e.content_hash)
            .filter(|h| !h.is_empty())
            .collect();
        assert_eq!(hashes, vec!["sha256:root".to_string()], "the hash-less edge is not walkable");

        let walk = backward_reachable(
            &[run_id],
            &[WalkRun { run_id, input_hashes: hashes }],
            &[WalkArtifact { content_hash: "sha256:root".into(), run_id: None }],
        );
        assert!(walk.root_hashes.contains("sha256:root"));
        assert!(!walk.root_hashes.contains(""), "an empty hash never becomes a graph root");
    }

    // FINDING 3 — `RunNodeDto.rerun_spec` shipped the FULL `AnalysisSpec` to every
    // project VIEWER, including `InputDecl.host_path` and `extra_mounts[].host_path`
    // (server filesystem layout). The DTO is now redacted at the projection.
    // RED ON REVERT: restore `rerun_spec: row.rerun_spec_json.clone()` and the
    // host-path assertions fail.
    #[test]
    fn rerun_spec_is_redacted_of_host_paths_but_keeps_the_science() {
        let raw = serde_json::json!({
            "language": "python",
            "analysis_id": "cell.filter",
            "seed": 7,
            "params": { "criteria": [{ "column": "pct_counts_mito", "max": 10 }] },
            "produces": [{ "output_id": "keep_lowqc", "path": "outputs/keep.csv" }],
            "inputs": [
                {
                    "slot": "expression",
                    "sandbox_subpath": "expression.h5ad",
                    "host_path": "/var/lib/cytoanalyst/workspaces/9f2/inputs/expression.h5ad",
                    "artifact_ref": "11111111-1111-1111-1111-111111111111"
                }
            ],
            "extra_mounts": [
                { "host_path": "/srv/refs/GRCh38", "sandbox_path": "/refs", "mode": "ReadOnly" }
            ],
            "script": "import scanpy as sc\nad = sc.read_h5ad('/inputs/expression.h5ad')\n"
        });
        let red = redact_rerun_spec(&raw);
        let text = red.to_string();

        // 1. no host path survives, in any form.
        assert!(!text.contains("/var/lib/cytoanalyst"), "input host path leaked: {text}");
        assert!(!text.contains("/srv/refs"), "reference-mount host path leaked: {text}");
        assert!(!text.contains("host_path"), "the carrier key itself is gone: {text}");
        assert!(red.get("extra_mounts").is_none(), "extra_mounts is dropped wholesale");

        // 2. the SCIENCE — the reason the field was surfaced at all (DEC-1 = BOTH),
        //    and the ONLY thing the FE reads (`predicatePreview.ts` -> rerun_spec.params).
        assert_eq!(red["params"]["criteria"][0]["column"], "pct_counts_mito");
        assert_eq!(red["language"], "python");
        assert_eq!(red["analysis_id"], "cell.filter");
        assert_eq!(red["seed"], 7);
        assert_eq!(red["produces"][0]["output_id"], "keep_lowqc");
        // the input's LOGICAL identity survives; only its host location is gone.
        assert_eq!(red["inputs"][0]["slot"], "expression");
        assert_eq!(red["inputs"][0]["sandbox_subpath"], "expression.h5ad");

        // 3. the inline script keeps its exact bytes — it executes INSIDE the
        //    sandbox, so its `/inputs` paths are sandbox-internal, not host layout.
        assert_eq!(red["script"], raw["script"], "the script is not mangled");
    }

    #[test]
    fn the_absolute_path_backstop_leaves_ordinary_values_byte_identical() {
        for benign in ["python", "cell.filter", "sha256:abc", "expression.h5ad", "a b c"] {
            assert_eq!(scrub_absolute_paths(benign), benign, "{benign}");
        }
        assert_eq!(scrub_absolute_paths("read /srv/refs/x now"), "read <path> now");
        // multi-line values keep their line structure.
        assert_eq!(scrub_absolute_paths("a\n/srv/x\nb"), "a\n<path>\nb");
    }

    // TEST-1: the backward-reachability walk returns the minimal sub-DAG
    // terminating at root artifacts (run_id NULL) — logic P1 does not provide.
    #[test]
    fn backward_walk_terminates_at_roots() {
        let root_hash = "sha256:root".to_string();
        let mid_hash = "sha256:mid".to_string();
        let leaf_hash = "sha256:leaf".to_string();

        let run_a = Uuid::new_v4(); // consumes root -> produces mid
        let run_b = Uuid::new_v4(); // consumes mid  -> produces leaf
        let unrelated = Uuid::new_v4(); // not in the closure

        let runs = vec![
            WalkRun { run_id: run_a, input_hashes: vec![root_hash.clone()] },
            WalkRun { run_id: run_b, input_hashes: vec![mid_hash.clone()] },
            WalkRun { run_id: unrelated, input_hashes: vec![root_hash.clone()] },
        ];
        let artifacts = vec![
            WalkArtifact { content_hash: root_hash.clone(), run_id: None }, // the root
            WalkArtifact { content_hash: mid_hash.clone(), run_id: Some(run_a) },
            WalkArtifact { content_hash: leaf_hash.clone(), run_id: Some(run_b) },
        ];

        let walk = backward_reachable(&[run_b], &runs, &artifacts);
        assert!(walk.runs.contains(&run_b));
        assert!(walk.runs.contains(&run_a), "walk follows mid back to run_a");
        assert!(!walk.runs.contains(&unrelated), "unrelated run excluded (minimal sub-DAG)");
        assert!(walk.root_hashes.contains(&root_hash), "terminates at the run-less root");
        assert!(!walk.root_hashes.contains(&mid_hash), "an intermediate is not a root");
    }

    // TEST-37 [ITEM-21]: forward_reachable returns EXACTLY the runs + outputs
    // derived from a start hash (the inverse of backward); a branch fans out; a
    // viz-only intermediate (consumed by nothing) is a leaf.
    #[test]
    fn forward_walk_returns_derived_and_stops_at_leaves() {
        let ds = "sha256:dataset".to_string(); // the source dataset hash (start)
        let a1 = "sha256:a1".to_string(); // qc output (consumed by a2 + branch)
        let a2 = "sha256:a2".to_string(); // filtered output (a leaf here)
        let viz = "sha256:viz".to_string(); // a viz-only intermediate (consumed by nothing)
        let branch = "sha256:branch".to_string(); // a second pipeline's output

        let run_qc = Uuid::new_v4(); // consumes dataset → produces a1 + viz
        let run_filter = Uuid::new_v4(); // consumes a1 → produces a2
        let run_branch = Uuid::new_v4(); // consumes dataset → produces branch (fan-out)
        let unrelated = Uuid::new_v4(); // consumes some other hash (not reachable)

        let runs = vec![
            WalkRun { run_id: run_qc, input_hashes: vec![ds.clone()] },
            WalkRun { run_id: run_filter, input_hashes: vec![a1.clone()] },
            WalkRun { run_id: run_branch, input_hashes: vec![ds.clone()] },
            WalkRun { run_id: unrelated, input_hashes: vec!["sha256:other".into()] },
        ];
        let artifacts = vec![
            WalkArtifact { content_hash: a1.clone(), run_id: Some(run_qc) },
            WalkArtifact { content_hash: viz.clone(), run_id: Some(run_qc) },
            WalkArtifact { content_hash: a2.clone(), run_id: Some(run_filter) },
            WalkArtifact { content_hash: branch.clone(), run_id: Some(run_branch) },
        ];

        let fwd = forward_reachable(&[ds.clone()], &runs, &artifacts);
        // Both downstream pipelines are derived (branching forward lineage).
        assert!(fwd.runs.contains(&run_qc) && fwd.runs.contains(&run_filter));
        assert!(fwd.runs.contains(&run_branch), "fan-out branch included");
        assert!(!fwd.runs.contains(&unrelated), "an unrelated run is not derived");
        // Every produced output appears; the viz-only intermediate is a leaf.
        assert!(fwd.output_hashes.contains(&a1) && fwd.output_hashes.contains(&a2));
        assert!(fwd.output_hashes.contains(&viz), "the viz intermediate is a produced leaf");
        assert!(fwd.output_hashes.contains(&branch));
        // The start hash itself is not an "output".
        assert!(!fwd.output_hashes.contains(&ds), "the source dataset is the root, not an output");
    }
}
