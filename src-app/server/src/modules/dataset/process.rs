//! `POST /datasets/{id}/process` — run a processor on a dataset (owner/dataset-
//! scoped, NO project; DEC-5/DEC-6). This is the data-prep analog of the workbench
//! `compute.run` project-scoped launch: it REUSES the SAME jobs/sandbox launch path
//! (a `job_type:"analysis"` job whose `params` is an [`AnalysisSpec`], created via
//! [`JobRepository::create`]), only scoped to a **dataset** instead of a project.
//!
//! What it adds over a bare `POST /jobs`: it resolves the dataset's one-or-many
//! ziee-file file(s) into `dataset_file_ref` sandbox inputs server-side (the
//! caller never handles raw `files.id`s), folds them into the processor's spec,
//! and stamps `CreateJobRequest.dataset_id = {id}` so the finalize ingest tags the
//! produced `artifacts.dataset_id` with this dataset (ITEM-23 — already wired in
//! `jobs::seams::WorkstoreIngestSink`). The model reads the exact slot→subpath
//! mapping from the path-agnostic `inputs.json` the runner materializes.

use aide::transform::TransformOperation;
use axum::extract::Path;
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};

use crate::modules::jobs::models::{CreateJobRequest, Job};
use crate::modules::jobs::repository::JobRepository;
use crate::modules::jobs::seams;
use crate::modules::permissions::{active_group_ids, with_permission, RequirePermissions};
use crate::modules::project::ProjectsUse;
use crate::modules::sandbox::backend::PriorityClass;
use crate::modules::sandbox::spec::{
    resolve_resource_class, AnalysisSpec, DatasetAxisIndexRef, InputDecl,
};

use super::models::{Dataset, DatasetFile};
use super::repository::{DatasetRepository, MAX_PER_PAGE};

/// Hard cap on supporting files per dataset (DEC-12) — a safety guardrail against a
/// pathological add-many, not an operational per-deployment knob.
pub const MAX_SUPPORTING_FILES_PER_DATASET: usize = 50;

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// Request body for `POST /datasets/{id}/process`.
///
/// `spec` is the processor's compute spec — an [`AnalysisSpec`]-shaped object
/// (`language`, `script` **or** `code_ref`, optional `produces`, `schedule`,
/// `extra_mounts`, `arch`, `timeout_secs`, `seed`, and any NON-dataset `inputs`
/// such as prior-step artifacts for a chained step). It is passed opaque (like
/// `CreateJobRequest.params`) so the sandbox's `AnalysisSpec` stays the single
/// owner of the compute-spec schema + validation. The endpoint APPENDS the
/// dataset's file(s) as `dataset_file_ref` inputs, so the spec must NOT declare
/// them itself.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ProcessDatasetRequest {
    /// The processor's `AnalysisSpec`-shaped compute spec (opaque object).
    pub spec: serde_json::Value,
    /// The logical slot the dataset's file(s) bind under (default `dataset`). A
    /// single-file dataset → one input at this slot; a multi-file dataset → one
    /// input per file at `{slot}_{ordinal}`.
    #[serde(default)]
    pub dataset_slot: Option<String>,
    /// Optional job name (defaults to the dataset's name).
    #[serde(default)]
    pub name: Option<String>,
    /// Optional explicit priority class (`interactive|normal|batch`); else the
    /// spec's `schedule.class`, else `normal`.
    #[serde(default)]
    pub priority_class: Option<String>,
}

/// The `/inputs`-relative subpath a dataset file binds at: its basename, or a
/// deterministic fallback for a filename with no usable basename (`.`/`..`/empty).
/// The final `AnalysisSpec::parse` re-validates every subpath (path-injection
/// guard), so this only needs to produce a sane, collision-free default.
fn safe_basename(filename: &str, fallback_idx: usize) -> String {
    std::path::Path::new(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("input_{fallback_idx}.bin"))
}

/// Turn a dataset's linked files into `dataset_file_ref` input declarations. A
/// single-file dataset binds at `slot`; a multi-file dataset binds each file at
/// `{slot}_{ordinal}` with an ordinal-prefixed subpath (collision-free). Files are
/// taken in the order `list_files` returns them (by `ordinal`). Pure + unit-testable.
pub fn build_dataset_inputs(files: &[DatasetFile], slot: &str) -> Vec<InputDecl> {
    let multi = files.len() > 1;
    files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let base = safe_basename(&f.filename, i);
            let (slot, subpath) = if multi {
                (format!("{slot}_{i}"), format!("{i}_{base}"))
            } else {
                (slot.to_string(), base)
            };
            InputDecl {
                slot,
                artifact_ref: None,
                dataset_file_ref: Some(f.file_id),
                dataset_axis_index: None,
                host_path: None,
                draft_ref: None,
                sandbox_subpath: subpath,
                // ITEM-17: a server-derived input has no CHOOSER — the dataset's own
                // files are not a value anyone picked from candidates — so its origin
                // is UNSTATED, never `user`.
                bound_by: None,
            }
        })
        .collect()
}

/// Run a processor on a dataset: resolve its file(s) as sandbox inputs, fold them
/// into the processor's spec, and enqueue a dataset-scoped `analysis` job.
pub async fn process_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
    Json(req): Json<ProcessDatasetRequest>,
) -> ApiResult<Json<Job>> {
    let repo = DatasetRepository::new(pool.clone());

    // MUTATION gate (ITEM-2 role enforcement): a dataset-scoped run WRITES
    // artifacts into the OWNER's dataset scope, so it requires owner ∪ `edit`-role
    // sharee. A read-only `view` sharee is visible but must NOT process → **403**;
    // a foreign/nonexistent dataset → **404** (no existence oracle).
    repo.require_can_edit(id, auth.user.id, &active_group_ids(&auth.groups))
        .await
        .map_err(e)?;
    let dataset = repo
        .get(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Dataset")))?;

    // The dataset must have at least one file to feed the processor.
    let files = repo.list_files(id, 1, MAX_PER_PAGE).await.map_err(e)?;
    if files.is_empty() {
        return Err(e(AppError::unprocessable_entity(
            "NO_FILES",
            "Dataset has no files to process",
        )));
    }

    // Deserialize the processor's compute spec, append the dataset's file(s) as
    // `dataset_file_ref` inputs, then re-serialize + validate the COMPLETE spec
    // (script/code_ref presence + the path-injection guard) via the SAME codec the
    // runner uses — so a bad spec is rejected here at create, not at dispatch.
    let mut spec: AnalysisSpec = serde_json::from_value(req.spec.clone()).map_err(|err| {
        e(AppError::bad_request(
            "INVALID_SPEC",
            format!("malformed processor spec: {err}"),
        ))
    })?;
    let slot = req
        .dataset_slot
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("dataset");
    spec.inputs.extend(build_dataset_inputs(&files, slot));
    // #189 / DEC-4 — `req.spec` is CLIENT-SUPPLIED, so its `env` is re-derived from the
    // registry for the named `analysis_id` and the caller's value discarded. Same
    // boundary, same reasoning as `POST /jobs`: the env registry is open, so trusting a
    // request-body env-id would let a caller select any image it serves.
    let spec = spec.with_declared_env();
    let params = serde_json::to_value(&spec)
        .map_err(|err| e(AppError::internal_error(format!("serialize spec: {err}"))))?;
    let validated = AnalysisSpec::parse(&params).map_err(e)?;

    // Resolve the scheduling fields the runner/scheduler read: an explicit request
    // priority wins, else the spec's schedule.class, else normal (mirrors the jobs
    // create handler's `infer_priority`). Resource class defaults to cpu-sandbox.
    let priority = match req
        .priority_class
        .as_deref()
        .or(validated.schedule.class.as_deref())
    {
        Some(s) => PriorityClass::clamped(s),
        None => PriorityClass::Normal,
    };
    let resource = resolve_resource_class(None);

    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| dataset.name.clone());

    // Enqueue through the SAME jobs launch path the project flow uses — only the
    // scope differs: `dataset_id` (owner processing) instead of `project_id`.
    let create = CreateJobRequest {
        job_type: "analysis".to_string(),
        name: Some(name),
        params: Some(params),
        priority_class: Some(priority.as_str().to_string()),
        resource_class: Some(resource.as_str().to_string()),
        project_id: None,
        dataset_id: Some(id),
    };
    let job = JobRepository::new(pool)
        .create(auth.user.id, &create)
        .await
        .map_err(e)?;

    // Tell the owner's OTHER devices a job appeared (owner-scoped). The scheduler
    // picks it up on its next tick (no start action for the user).
    seams::sync_sink().publish_job_changed(auth.user.id, seams::JobChange::Created, job.id);

    Ok((StatusCode::CREATED, Json(job)))
}

pub fn process_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Run a processor on a dataset (owner or edit-role sharee) — enqueues a dataset-scoped analysis job")
        .id("Dataset.process")
        .tag("dataset")
        .response::<201, Json<Job>>()
        .response_with::<400, (), _>(|r| r.description("Malformed processor spec"))
        .response_with::<403, (), _>(|r| r.description("A view-only sharee cannot process"))
        .response_with::<404, (), _>(|r| r.description("Dataset not found or not visible"))
        .response_with::<422, (), _>(|r| r.description("Dataset has no files to process"))
}

/// Build the TWO inputs an `annotation_table` integrate job binds (ITEM-12 / DEC-7):
/// (i) the supporting annotation-table file itself, as a `dataset_file_ref` at slot
/// `annotation`; (ii) the dataset's target-axis entity-index, as a
/// `dataset_axis_index` at slot `axis_index` (resolved at run time to the import's
/// `<axis>_index` `metadata-column` artifact — the cheap single-file index, not the
/// primary store). Pure + unit-testable.
pub fn build_integrate_inputs(dataset_id: Uuid, file: &DatasetFile, axis: &str) -> Vec<InputDecl> {
    let annotation_subpath = safe_basename(&file.filename, 0);
    vec![
        InputDecl {
            slot: "annotation".to_string(),
            artifact_ref: None,
            dataset_file_ref: Some(file.file_id),
            dataset_axis_index: None,
            host_path: None,
            draft_ref: None,
            // See `build_dataset_inputs`: server-derived, so unstated.
            bound_by: None,
            sandbox_subpath: annotation_subpath,
        },
        InputDecl {
            slot: "axis_index".to_string(),
            artifact_ref: None,
            dataset_file_ref: None,
            dataset_axis_index: Some(DatasetAxisIndexRef {
                dataset_id,
                axis: axis.to_string(),
            }),
            host_path: None,
            draft_ref: None,
            // `<axis>_index.zarr` — ITEM-26 made an axis index a Zarr STORE, so what
            // gets staged here is a DIRECTORY, not a file. The extension is cosmetic to
            // the machinery (`stage_artifact` joins this subpath verbatim and the slot
            // map reports `/inputs/<subpath>`), but it is load-bearing documentation:
            // this read `…_index.json` until 2026-07-29, which described a single-file
            // JSON index that no producer has emitted since ITEM-26 — a directory
            // wearing a `.json` name. The consumer resolves by SLOT (`inputs.json` IS
            // mounted — `sandbox::inputs::DERIVED_INPUT_FILES`); its glob is only a
            // fallback, and it accepts both spellings.
            sandbox_subpath: format!("{axis}_index.zarr"),
            // See `build_dataset_inputs`: server-derived, so unstated.
            bound_by: None,
        },
    ]
}

/// ITEM-12 — the on-INTEGRATE trigger. If an `on-integrate` converter accepts the
/// supporting file's `supporting_datatype` (the generic axis-agnostic integrate
/// converter), enqueue a kind-processor job that aligns the
/// annotation-table onto the dataset's `axis` entity-index. Mirrors
/// [`super::routes::maybe_autoconvert_on_ingest`]: build the converter's
/// `AnalysisSpec` (`code_ref = run.entry`, `language = run.runtime`, `params = {}`),
/// append the two integrate inputs, validate through the runner's codec, and create
/// the job. `deps` chains it in the upload DAG (Phase A: `blocked` on the import
/// job); Phase B (add-later) passes `&[]` so it runs immediately (the import is
/// already complete). Stores the integrate job id on the file so its
/// `integration_status` DERIVES from the job's live status.
/// Returns the integrate job id, or `None` when no `on-integrate` converter matches.
pub async fn maybe_integrate_on_add(
    pool: &PgPool,
    owner_id: Uuid,
    dataset: &Dataset,
    supporting_datatype: &str,
    file: &DatasetFile,
    axis: &str,
    deps: &[Uuid],
) -> Result<Option<Uuid>, (StatusCode, AppError)> {
    // A recognized on-integrate converter for this supporting datatype (else nothing).
    //
    // S10 — this arm is the SILENT half. `Ok(None)` leaves the file linked with
    // `integration_status = NULL` forever: no job, no error and (before this) no log,
    // so an operator missing the integrating package saw an upload that simply never
    // integrated with nothing anywhere naming the reason. It stays non-fatal (the
    // file IS attached, and a package installed later integrates it), but it is now
    // ANNOUNCED — the datatype that found no converter is named.
    let Some(converter) =
        crate::modules::extensions::find_on_integrate_converter(supporting_datatype)
    else {
        tracing::warn!(
            dataset_id = %dataset.id,
            file_id = %file.file_id,
            supporting_datatype,
            axis,
            "no installed package declares an `on-integrate` converter accepting this \
             supporting datatype; the file is attached but will NOT be integrated until \
             one is installed"
        );
        return Ok(None);
    };

    // The params bag the integrate entry reads from `/inputs/params.json`:
    // the target `axis` name, plus the MODULAR per-axis key-normalization pipeline the
    // extension DECLARES in its manifest `alignment` (DEC-18) — threaded here so a new
    // supporting type designs its own normalization without a core edit. When the
    // manifest declares none (or a non-key_join strategy), the align engine's axis-aware
    // default governs.
    let mut params_bag = serde_json::Map::new();
    params_bag.insert("axis".to_string(), serde_json::json!(axis));
    if let Some(crate::modules::datatype::types::Alignment::KeyJoin {
        normalize,
        key_column,
        ..
    }) = crate::modules::extensions::resolve_alignment(supporting_datatype, axis)
    {
        if !normalize.is_empty() {
            params_bag.insert("normalize".to_string(), serde_json::json!(normalize));
        }
        if let Some(key) = key_column {
            params_bag.insert("key_column".to_string(), serde_json::json!(key));
        }
    }

    // Build the converter's spec + append the annotation + axis-index inputs.
    let mut spec: AnalysisSpec = serde_json::from_value(serde_json::json!({
        "language": converter.runtime,
        "code_ref": converter.entry,
        // M3: thread the owning package so `code_ref` resolves in the CORRECT package.
        "package": converter.extension_id,
        // #189: the converter's DECLARED env (server-derived, see the on-ingest twin).
        "env": converter.env,
        "params": serde_json::Value::Object(params_bag),
    }))
    .map_err(|err| {
        e(AppError::internal_error(format!(
            "build integrate spec: {err}"
        )))
    })?;
    spec.inputs
        .extend(build_integrate_inputs(dataset.id, file, axis));

    // Re-serialize + validate the COMPLETE spec through the runner's codec (a bad
    // spec fails here at create, not at dispatch).
    let params = serde_json::to_value(&spec).map_err(|err| {
        e(AppError::internal_error(format!(
            "serialize integrate spec: {err}"
        )))
    })?;
    AnalysisSpec::parse(&params).map_err(e)?;

    // Enqueue a dataset-scoped `analysis` job, chained on `deps` (ITEM-19/20 DAG).
    let create = CreateJobRequest {
        job_type: "analysis".to_string(),
        name: Some(format!("Integrate {} → {}", file.filename, dataset.name)),
        params: Some(params),
        priority_class: Some(PriorityClass::Normal.as_str().to_string()),
        resource_class: Some(resolve_resource_class(None).as_str().to_string()),
        project_id: None,
        dataset_id: Some(dataset.id),
    };
    let job = JobRepository::new(pool.clone())
        .create_with_deps(owner_id, &create, deps)
        .await
        .map_err(e)?;

    // Point the supporting file at its integrate job so its per-file
    // `integration_status` DERIVES from the job's live status (the single source of
    // truth, ITEM-11/20) — `pending` while blocked/queued, advanced to
    // running/integrated/failed as the job runs, and `failed` on a cascade-failure
    // (the job row is failed) with no completion hook needed for status.
    DatasetRepository::new(pool.clone())
        .set_integration_job(dataset.id, file.file_id, job.id)
        .await
        .map_err(e)?;

    seams::sync_sink().publish_job_changed(owner_id, seams::JobChange::Created, job.id);
    tracing::info!(
        dataset_id = %dataset.id, file_id = %file.file_id, %axis, %supporting_datatype,
        extension = %converter.extension_id, converter = %converter.converter_id,
        job_id = %job.id, deps = deps.len(),
        "on-integrate converter enqueued for supporting file"
    );
    Ok(Some(job.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(name: &str, ordinal: i32) -> DatasetFile {
        DatasetFile {
            file_id: Uuid::new_v4(),
            filename: name.to_string(),
            file_size: 10,
            ordinal,
            role: "primary".to_string(),
            kind: None,
            integration_status: None,
            integration_summary: None,
        }
    }

    #[test]
    fn single_file_binds_at_the_slot_basename() {
        let f = file("PBMC_donor1.h5ad", 0);
        let inputs = build_dataset_inputs(std::slice::from_ref(&f), "dataset");
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].slot, "dataset");
        assert_eq!(inputs[0].sandbox_subpath, "PBMC_donor1.h5ad");
        assert_eq!(inputs[0].dataset_file_ref, Some(f.file_id));
        assert!(inputs[0].artifact_ref.is_none() && inputs[0].host_path.is_none());
    }

    #[test]
    fn multi_file_binds_per_file_collision_free() {
        let files = vec![
            file("matrix.mtx.gz", 0),
            file("barcodes.tsv.gz", 1),
            file("features.tsv.gz", 2),
        ];
        let inputs = build_dataset_inputs(&files, "dataset");
        assert_eq!(inputs.len(), 3);
        assert_eq!(inputs[0].slot, "dataset_0");
        assert_eq!(inputs[0].sandbox_subpath, "0_matrix.mtx.gz");
        assert_eq!(inputs[2].slot, "dataset_2");
        assert_eq!(inputs[2].sandbox_subpath, "2_features.tsv.gz");
        // Every subpath is unique (ordinal-prefixed).
        let subs: std::collections::HashSet<_> =
            inputs.iter().map(|i| i.sandbox_subpath.as_str()).collect();
        assert_eq!(subs.len(), 3, "no subpath collisions");
    }

    #[test]
    fn odd_filename_falls_back_to_safe_subpath() {
        // A dot/dot-dot/empty basename yields a deterministic fallback that passes
        // the sandbox subpath guard.
        assert_eq!(safe_basename("..", 0), "input_0.bin");
        assert_eq!(safe_basename("", 1), "input_1.bin");
        assert_eq!(safe_basename("a/b/c.txt", 2), "c.txt");
    }

    // ITEM-12: the integrate job binds exactly two inputs — the annotation-table
    // (dataset_file_ref @ `annotation`) + the target axis index (dataset_axis_index
    // @ `axis_index`) — and the pair validates through the AnalysisSpec codec.
    #[test]
    fn integrate_inputs_bind_annotation_and_axis_index() {
        let ds_id = Uuid::new_v4();
        let f = file("donor_meta.csv", 1);
        let inputs = build_integrate_inputs(ds_id, &f, "cells");
        assert_eq!(inputs.len(), 2);

        let ann = inputs
            .iter()
            .find(|i| i.slot == "annotation")
            .expect("annotation slot");
        assert_eq!(ann.dataset_file_ref, Some(f.file_id));
        assert_eq!(ann.sandbox_subpath, "donor_meta.csv");
        assert!(ann.dataset_axis_index.is_none());

        let axi = inputs
            .iter()
            .find(|i| i.slot == "axis_index")
            .expect("axis_index slot");
        let axis_ref = axi.dataset_axis_index.as_ref().expect("axis ref present");
        assert_eq!(axis_ref.dataset_id, ds_id);
        assert_eq!(axis_ref.axis, "cells");
        assert!(axi.dataset_file_ref.is_none());

        // The two integrate inputs validate on an otherwise-minimal spec.
        let mut spec: AnalysisSpec = serde_json::from_value(json!({
            "language": "python",
            "code_ref": "annotation-integrate/annotation_integrate.py",
            "params": {}
        }))
        .unwrap();
        spec.inputs.extend(inputs);
        let value = serde_json::to_value(&spec).unwrap();
        AnalysisSpec::parse(&value).expect("integrate inputs validate");
    }

    #[test]
    fn appended_dataset_inputs_pass_analysis_spec_validation() {
        // A processor spec with NO inputs + the appended dataset files parses clean
        // (the full path-injection + source-exactly-one guard runs).
        let mut spec: AnalysisSpec = serde_json::from_value(json!({
            "language": "python",
            "script": "print('ok')"
        }))
        .unwrap();
        let files = vec![file("expr.h5ad", 0)];
        spec.inputs.extend(build_dataset_inputs(&files, "dataset"));
        let value = serde_json::to_value(&spec).unwrap();
        let parsed = AnalysisSpec::parse(&value).expect("spec with dataset inputs validates");
        assert_eq!(parsed.inputs.len(), 1);
        assert!(parsed.inputs[0].dataset_file_ref.is_some());
    }
}
