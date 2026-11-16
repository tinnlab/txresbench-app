//! The demo model seams (demo-mode ITEM-3): `models/save` and the example
//! set of a demo server.
//!
//! A demo run replays RECORDED results — its method rows carry the recorded
//! column facts, and a method the recorded run saved a model for carries the
//! recorded model facts + a stub tree in the run dir (`models/<method>/`).
//! The bundle's model METADATA (name, version, group, task, trained-on,
//! size, AUC, decision day, endpoint, horizon) is the record's truth; the
//! stub tree exists so the content-addressed tree seam (copy + resolve's
//! verify-before-bind) reads a real directory with a real digest — a demo
//! model is never a broken reference.
//!
//! ## `models/save` (demo arm)
//!
//! The save of a demo run's finished methods creates rows pointing at the
//! bundle's model metadata — the same shape `store::save_from_run` writes
//! (the requirement facts come from the shipped catalogue + the example
//! data's own inventory, never invented), provenance `run`, no training
//! files, no export. A method the recorded run did NOT save a model for is
//! refused the same way the engine refuses (`METHOD_NOT_FINISHED` — the
//! honest "the recorded results carry no model").
//!
//! ## `models/example` (demo arm)
//!
//! The example saved set of a demo deployment: seeded from the bundle's
//! recorded models (every model the recording produced) into a set named
//! "Example models" — the same name the desktop example uses, so the
//! saved-model flow path is identical. Idempotent: a second call returns the
//! existing set.

use std::path::Path;

use axum::http::StatusCode;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::AppError;

use crate::modules::execution_engine::repository::TxrRepository;
use crate::modules::execution_engine::types::{CreateRunRequest, TxrMethodState, TxrRunMode};
use crate::modules::method_catalogue::catalogue;
use crate::modules::model_store::repository::{ExampleStateRow, ModelStoreRepository, NewModel};
use crate::modules::model_store::types::{
    CovariateFacts, ExampleSetResponse, ExampleSetState, ModelProvenance, ModelSaveResponse,
    SaveModelsRequest, SaveTarget,
};
use crate::modules::model_store::store;

use super::bundle::BundleModel;

/// The reserved set name of the demo example set (the desktop name —
/// qa-fixes3 ITEM-3's "named 'Example models'").
pub const EXAMPLE_SET_NAME: &str = "Example models";

/// The recorded input of a demo run (the rerun record — the one durable copy
/// of the run's request).
fn recorded_input(run_dir: &Path) -> Result<CreateRunRequest, AppError> {
    let bytes = std::fs::read(run_dir.join("input").join("run-input.json")).map_err(|e| {
        AppError::internal_error(format!("demo run input record: {e}"))
    })?;
    let record: crate::modules::execution_engine::types::RunInputRecord =
        serde_json::from_slice(&bytes).map_err(|e| {
            AppError::internal_error(format!("demo run input record unreadable: {e}"))
        })?;
    Ok(CreateRunRequest {
        mode: record.mode,
        input: record.input,
        config: record.config,
        method_ids: record.method_ids,
        model_ids: record.model_ids,
    })
}

/// The example data's own marker column keys (the marker facts a recorded
/// model was trained on — the validator's inventory over the recorded input;
/// the example data's column keys are its stable markers).
fn example_marker_ids(
    run_dir: &Path,
    config: &crate::modules::execution_engine::types::RunConfig,
    mode: TxrRunMode,
) -> Vec<String> {
    fn keys_of(
        input: &crate::modules::execution_engine::types::TxrRunInput,
        config: &crate::modules::execution_engine::types::RunConfig,
        mode: TxrRunMode,
    ) -> Vec<String> {
        crate::modules::execution_engine::orchestrator::validate_run(input, config, mode)
            .map(|v| v.inventory.markers.iter().map(|m| m.key.clone()).collect())
            .unwrap_or_default()
    }
    let Ok(req) = recorded_input(run_dir) else {
        return Vec::new();
    };
    keys_of(&req.input, config, mode)
}

/// Build a demo model row (`NewModel`) from the bundle's recorded model
/// metadata + the catalogue facts. The stub tree's digest is the row's
/// `tree_sha256`; the tree is copied into the content-addressed store so the
/// record is a reference that RESOLVES (a demo model is reusable, like any
/// saved model).
fn new_model_from_bundle(
    method_id: &str,
    method_version: &str,
    group: &str,
    group_label: &str,
    model: &BundleModel,
    marker_ids: &[String],
    stored_tree: &Path,
    digest: &str,
    trained_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<NewModel, AppError> {
    let cat = catalogue::method(method_id).ok_or_else(|| {
        AppError::new(
            StatusCode::CONFLICT,
            "METHOD_NOT_IN_CATALOGUE",
            format!("method {method_id:?} is not in the shipped catalogue"),
        )
    })?;
    let marker_facts = crate::modules::model_store::types::MarkerFacts {
        kind: cat.markers.kind.clone(),
        count: cat.markers.count,
        min_draws: cat.min_draws,
        needs_baseline: cat.needs_baseline,
        uses_history: cat.uses_history,
        needs_detection_call: cat.needs_detection_call,
        marker_groups_required: cat.marker_groups_required.clone(),
    };
    let covariates = CovariateFacts {
        catalogue: cat.covariates.clone(),
        used: model.uses_covariates,
    };
    let endpoint = super::replay::endpoint_wire(model.endpoint);
    Ok(NewModel {
        set_id: None, // the caller sets the target set
        name: model.name.clone(),
        method_id: method_id.to_string(),
        method_version: method_version.to_string(),
        group: group.to_string(),
        group_label: group_label.to_string(),
        task: model.task.map(|t| t.as_str().to_string()),
        provenance: ModelProvenance::Run.as_str().to_string(),
        imported_from: None,
        pretrained_catalogue_id: None,
        pretrained_catalogue_version: None,
        licence: None,
        tree_sha256: digest.to_string(),
        dir: stored_tree.display().to_string(),
        size_bytes: model.size_bytes as i64,
        contract: cat.env.contract.clone(),
        env_base_digest: Some("recorded".to_string()),
        env_layer_digest: Some("recorded".to_string()),
        trained_on_patients: model.trained_on_patients.map(|v| v as i64),
        trained_at: trained_at.or(model.trained_at),
        decision_day: model.decision_day,
        endpoint: endpoint.to_string(),
        horizon: model.horizon,
        features: serde_json::to_value(marker_ids)
            .map_err(|e| AppError::internal_error(format!("marker facts: {e}")))?,
        required_markers: cat
            .required_markers
            .clone()
            .map(|rm| {
                serde_json::to_value(rm)
                    .map_err(|e| AppError::internal_error(format!("required markers: {e}")))
            })
            .transpose()?,
        marker_facts: serde_json::to_value(&marker_facts)
            .map_err(|e| AppError::internal_error(format!("marker facts: {e}")))?,
        covariates: serde_json::to_value(&covariates)
            .map_err(|e| AppError::internal_error(format!("covariates: {e}")))?,
        embeds_training_data: model.embeds_training_data,
        own_auc: model.own_auc,
        own_c: None,
        conversions: serde_json::json!({}),
        env_method_version: None,
        env_arch: None,
        env_layer_tag: None,
        env_base_tag: None,
    })
}

/// The stub model tree for a recorded model: ONE json file carrying the
/// recorded metadata. The tree's digest is the row's `tree_sha256`; the
/// resolve seam verifies the files against it, so the demo's saved models
/// resolve and reuse like any other. The recorded size/AUC are the manifest
/// facts, never recomputed from this stub.
fn write_stub_model_tree(tree: &Path, model: &BundleModel) -> Result<(), AppError> {
    let mut text = serde_json::to_string_pretty(&serde_json::json!({
        "format": "txresbench-demo-recorded-model",
        "recorded_name": model.name,
        "recorded_method_version": model.method_version,
    }))
    .map_err(|e| AppError::internal_error(format!("stub model tree: {e}")))?;
    text.push('\n');
    std::fs::write(tree.join("demo-model.json"), text)
        .map_err(|e| AppError::internal_error(format!("write stub model tree: {e}")))
}

/// `POST /api/txr/models/save` in demo mode when the run is a demo run: the
/// records point at the bundle's model metadata.
pub async fn save_from_bundle(
    pool: &SqlitePool,
    req: &SaveModelsRequest,
) -> Result<ModelSaveResponse, AppError> {
    req.validate().map_err(|e| AppError::bad_request(e.code.code(), e.to_string()))?;
    let engine = TxrRepository::new(pool.clone());
    let run = engine
        .get_run(req.run_id)
        .await?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "RUN_NOT_FOUND", format!("no run {}", req.run_id)))?;
    let bundle = super::bundle().ok_or_else(|| {
        AppError::internal_error("a demo save was requested outside demo mode")
    })?;
    let run_dir = Path::new(&run.dir);
    let config = crate::modules::execution_engine::repository::parse_config(&run.config)
        .map_err(|e| AppError::database_error(format!("demo run config: {e}")))?;
    let config_id = super::replay::match_configuration(bundle, &config)?.id.clone();
    let marker_ids = example_marker_ids(run_dir, &config, run.mode()?);

    let repo = ModelStoreRepository::new(pool.clone());
    let (set_row, set_name) = match &req.target {
        SaveTarget::NewSet { set_name } => (
            repo.insert_set(
                set_name,
                Some(run.id),
                req.source_label.as_deref().or(Some("example")),
                false,
                None,
            )
            .await?,
            set_name.clone(),
        ),
        SaveTarget::ExistingSet { set_id } => {
            let row = repo.get_set(*set_id).await?.ok_or_else(|| {
                AppError::new(StatusCode::NOT_FOUND, "SET_NOT_FOUND", format!("no set {set_id}"))
            })?;
            let name = row.name.clone();
            (row, name)
        }
    };
    let set_id = set_row.id;

    let mut saved_rows = Vec::with_capacity(req.method_ids.len());
    for mid in &req.method_ids {
        let method_row = engine
            .get_method(req.run_id, mid)
            .await?
            .ok_or_else(|| {
                AppError::new(
                    StatusCode::NOT_FOUND,
                    "MODEL_ASSET_UNKNOWN",
                    format!("the run has no method row for {mid}"),
                )
            })?;
        if method_row.state()? != TxrMethodState::Finished {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "METHOD_NOT_FINISHED",
                format!(
                    "method {mid} is not finished in the recorded results; only finished \
                     methods are savable in the demo"
                ),
            ));
        }
        let record = super::replay::method_record(bundle, &config_id, mid).ok_or_else(|| {
            AppError::new(
                StatusCode::CONFLICT,
                "METHOD_NOT_FINISHED",
                format!(
                    "the recorded results carry no model for method {mid}; only the methods \
                     the recording saved are savable in the demo"
                ),
            )
        })?;
        let bundle_model = record.model.as_ref().ok_or_else(|| {
            AppError::new(
                StatusCode::CONFLICT,
                "METHOD_NOT_FINISHED",
                format!(
                    "the recorded results carry no model for method {mid}; only the methods \
                     the recording saved are savable in the demo"
                ),
            )
        })?;

        // The stub tree written at replay create; copied into the store.
        let src_tree = run_dir.join("models").join(mid);
        let digest = crate::modules::sandbox::stack::tree_sha256(&src_tree)
            .map_err(|e| AppError::internal_error(format!("recorded model tree digest: {e}")))?;
        if repo.model_ref_exists(Some(set_id), &digest, mid).await? {
            saved_rows.push(
                repo.get_model_by_ref(Some(set_id), &digest, mid)
                    .await?
                    .expect("checked above"),
            );
            continue;
        }
        let stored = store::copy_tree(&src_tree, &digest)?;
        let facts = crate::modules::execution_engine::envmanifest::facts_for(mid);
        let mut model = new_model_from_bundle(
            mid,
            &facts.map(|f| f.version.clone()).unwrap_or_else(|| method_row.version.clone()),
            &facts.map(|f| f.group.as_str().to_string()).unwrap_or_else(|| method_row.group.clone()),
            &facts.map(|f| f.group_label.clone()).unwrap_or_else(|| method_row.group.clone()),
            bundle_model,
            &marker_ids,
            &stored,
            &digest,
            run.finished_at,
        )?;
        model.set_id = Some(set_id);
        saved_rows.push(repo.insert_model(&model).await?);
    }

    let set_summary_row = repo
        .get_set_with_counts(set_id)
        .await?
        .ok_or_else(|| AppError::internal_error("the saved set is gone after the save"))?;
    let mut models = Vec::with_capacity(saved_rows.len());
    for row in &saved_rows {
        models.push(store::summary_from(row, Some(&set_name))?);
    }
    // ITEM-4: after every model-set insert the shared-pool retention may
    // evict the oldest non-pinned sets (fire-and-forget; the new set is the
    // newest, so it can never be the evictee).
    super::retention::enforce_limits_detached(pool.clone());
    Ok(ModelSaveResponse {
        set: store::set_summary_from(&set_summary_row),
        models,
        export: None,
    })
}

/// The example set of a demo deployment (the demo arm of
/// `POST /api/txr/models/example`): seeded from the bundle's recorded
/// models, idempotent.
pub async fn ensure_example_set(pool: &SqlitePool) -> Result<ExampleSetResponse, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    if let Some(state) = repo.example_state().await? {
        if state.state == ExampleSetState::Ready.as_str() {
            return Ok(example_ready(state.set_id));
        }
    }
    // An existing set named "Example models" with models is the answer too
    // (a second call after the first seed).
    for set in repo.list_sets().await? {
        if set.name == EXAMPLE_SET_NAME && set.model_count > 0 {
            let _ = repo
                .upsert_example_state(&ExampleStateRow {
                    state: ExampleSetState::Ready.as_str().to_string(),
                    run_id: None,
                    set_id: Some(set.id),
                    error: None,
                })
                .await;
            return Ok(example_ready(Some(set.id)));
        }
    }

    let bundle = super::bundle().ok_or_else(|| {
        AppError::internal_error("the example set was requested outside demo mode")
    })?;

    // Seed: every recorded model (one row per (method, configuration)).
    let mut methods = Vec::new();
    let mut set_row = None;
    let mut inserted = 0usize;
    for method in &bundle.methods {
        for record in &method.records {
            let Some(model) = &record.model else { continue };
            let facts = crate::modules::execution_engine::envmanifest::facts_for(&method.method_id);
            let tree_dir = crate::modules::rootfs::data_root()
                .join("demo-example-models")
                .join(&method.method_id);
            std::fs::create_dir_all(&tree_dir).map_err(|e| {
                AppError::internal_error(format!("create example model tree: {e}"))
            })?;
            write_stub_model_tree(&tree_dir, model)?;
            let digest = crate::modules::sandbox::stack::tree_sha256(&tree_dir)
                .map_err(|e| AppError::internal_error(format!("example model tree digest: {e}")))?;
            if set_row.is_none() {
                set_row = Some(repo.insert_set(EXAMPLE_SET_NAME, None, Some("example"), false, None).await?);
            }
            let stored = store::copy_tree(&tree_dir, &digest)?;
            let mut row = new_model_from_bundle(
                &method.method_id,
                &facts.map(|f| f.version.clone()).unwrap_or_default(),
                &facts.map(|f| f.group.as_str().to_string()).unwrap_or_default(),
                &facts.map(|f| f.group_label.clone()).unwrap_or_default(),
                model,
                &[],
                &stored,
                &digest,
                None,
            )?;
            row.set_id = Some(set_row.as_ref().expect("created above").id);
            let inserted_row = repo.insert_model(&row).await?;
            methods.push(inserted_row.method_id);
            inserted += 1;
        }
    }
    if inserted == 0 {
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXAMPLE_EMPTY",
            "the demo bundle records no saved model; the example set cannot be seeded",
        ));
    }
    let set_row = set_row.expect("at least one model was inserted");
    let _ = repo
        .upsert_example_state(&ExampleStateRow {
            state: ExampleSetState::Ready.as_str().to_string(),
            run_id: None,
            set_id: Some(set_row.id),
            error: None,
        })
        .await;
    // ITEM-4: the example set is the PINNED one (the state row's set id is
    // the pin derivation) — the retention pass runs anyway so the other
    // (non-pinned) sets beyond the limit are swept now, and the pass proves
    // the pinned set survives.
    super::retention::enforce_limits_detached(pool.clone());
    Ok(example_ready(Some(set_row.id)))
}

fn example_ready(set_id: Option<Uuid>) -> ExampleSetResponse {
    ExampleSetResponse {
        state: ExampleSetState::Ready,
        set_id,
        run_id: None,
        run_status: None,
        methods: Vec::new(),
        error: None,
    }
}
