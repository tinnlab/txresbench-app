//! The demo eligibility + estimate arms (demo-mode ITEM-3): the bundle-backed
//! answers of `/methods/eligibility`, `/methods/estimate`,
//! `/txr/models/eligibility` and `/txr/pretrained/eligibility`.
//!
//! ## The demo verdicts
//!
//! The demo offers only what the bundle contains: a RECORDED method (one
//! with a recorded train column for a recorded configuration) is
//! `can_run`; every other catalogue method is `cannot_run` +
//! `NOT_RUNNABLE` ("not one of the methods the demo recorded"). The estimate
//! arm answers the recorded seconds / `demo.replay_speed` for recorded
//! methods and a plain 400 (`UNKNOWN_METHOD` / `DEMO_NOT_RECORDED`) for an
//! unrecorded one.
//!
//! ## Facts vs derivations
//!
//! The verdicts' display facts are the bundle's recorded ones (coverage
//! scored/eligible, seconds); the `min_draws`/`coverage` aggregates are
//! derived from them — the eligibility count a recorded result carries IS
//! the count of patients that met the method's needs on the recorded data,
//! so `met = eligible`, `unmet = 0` (the recording never ran the method on
//! an unmet patient). The estimate quality is `measured` — the recorded
//! seconds ARE measured seconds.

use std::collections::BTreeMap;

use uuid::Uuid;

use axum::http::StatusCode;
use sqlx::SqlitePool;

use txresbench_core::AppError;

use crate::modules::method_catalogue::types::{
    Coverage, EligibilityResponse, EligibilityStatus, EstimateRequest, EstimateResponse,
    MethodEligibility, MethodEstimate, MinDraws, Reason, TimingQuality,
};
use crate::modules::model_store::repository::ModelStoreRepository;
use crate::modules::model_store::types::{
    ModelEligibility, ModelEligibilityResponse, ModelReason, ModelReasonCode,
};
use crate::modules::pretrained_catalogue::types::{
    PretrainedEligibilityEntry, PretrainedEligibilityResponse, PretrainedReason,
    PretrainedReasonCode,
};

use super::bundle::{BundleConfiguration, DemoBundle};
use super::replay::{lpt_schedule_seconds, replay_seconds};

/// The replay speed (the recorded seconds' divisor).
fn speed() -> f64 {
    super::replay::replay_speed()
}

/// The recorded (method, configuration) the demo answers for — the FIRST
/// configuration that records the method (the wire bodies of
/// `/methods/estimate` and the eligibility endpoints carry no configuration,
/// so the primary recorded setup is the reference — DRIFT-1 ITEM-3).
fn record_for_first<'b>(
    bundle: &'b DemoBundle,
    method_id: &str,
) -> Option<(&'b BundleConfiguration, &'b super::bundle::BundleMethodRecord)> {
    for method in &bundle.methods {
        if method.method_id != method_id {
            continue;
        }
        for record in &method.records {
            let config = bundle
                .configurations
                .iter()
                .find(|c| c.id == record.configuration_id)?;
            return Some((config, record));
        }
    }
    None
}

/// The reason "not recorded in the demo" (the honest refusal of an
/// unrecorded method on every eligibility surface).
fn not_recorded_reason() -> Vec<Reason> {
    vec![Reason {
        code: crate::modules::method_catalogue::types::ReasonCode::NotRunnable,
        params: BTreeMap::from([(
            "detail".to_string(),
            serde_json::json!("not one of the methods the demo recorded"),
        )]),
        group_id: None,
    }]
}

fn model_not_recorded_reason() -> Vec<ModelReason> {
    vec![ModelReason {
        code: ModelReasonCode::NotRunnable,
        params: BTreeMap::from([(
            "detail".to_string(),
            serde_json::json!("not one of the methods the demo recorded"),
        )]),
    }]
}

fn pretrained_not_recorded_reason() -> Vec<PretrainedReason> {
    vec![PretrainedReason {
        code: PretrainedReasonCode::NotRunnable,
        params: BTreeMap::from([(
            "detail".to_string(),
            serde_json::json!("not one of the methods the demo recorded"),
        )]),
        group_id: None,
    }]
}

/// `POST /api/methods/eligibility` (demo): recorded methods → can_run with
/// the bundle's facts; everything else → cannot_run + NOT_RUNNABLE. The body
/// is the tagged `preview`/`inventory` shape — the demo answer is the same
/// for both (the recorded setup IS the example setup).
pub fn methods_eligibility(bundle: &DemoBundle, body: &crate::modules::method_catalogue::types::EligibilityRequest) -> EligibilityResponse {
    let speed = speed();
    // Demo mode never moves off the built-in list (its recordings were made
    // against it).
    let list = crate::modules::method_list::builtin();
    let mut methods_out = Vec::with_capacity(list.catalogue.methods.len());
    let mut total_fit = 0;
    let mut total_cannot = 0;
    let _ = body;
    for m in list.catalogue.methods.iter() {
        if let Some((_config, record)) = record_for_first(bundle, &m.id) {
            let second = record.seconds / speed.max(0.01);
            methods_out.push(MethodEligibility {
                id: m.id.clone(),
                status: EligibilityStatus::CanRun,
                reasons: Vec::new(),
                missing_markers: Vec::new(),
                missing_groups: Vec::new(),
                coverage: Coverage {
                    eligible: record.train.coverage.eligible,
                    total: record.train.coverage.eligible,
                    fraction: record.train.coverage.fraction,
                },
                min_draws: MinDraws {
                    required: m.min_draws,
                    met: record.train.coverage.eligible,
                    unmet_patients: 0,
                },
                estimated_seconds: second.max(super::replay::MIN_METHOD_SECONDS),
                estimate_quality: TimingQuality::Measured,
            });
            total_fit += 1;
        } else {
            methods_out.push(MethodEligibility {
                id: m.id.clone(),
                status: EligibilityStatus::CannotRun,
                reasons: not_recorded_reason(),
                missing_markers: Vec::new(),
                missing_groups: Vec::new(),
                coverage: Coverage {
                    eligible: 0,
                    total: 0,
                    fraction: 0.0,
                },
                min_draws: MinDraws {
                    required: m.min_draws,
                    met: 0,
                    unmet_patients: 0,
                },
                estimated_seconds: 0.0,
                estimate_quality: TimingQuality::Estimate,
            });
            total_cannot += 1;
        }
    }
    EligibilityResponse {
        methods: methods_out,
        total_fit,
        total_some: 0,
        total_cannot,
        total_no_env: 0,
        method_list_sequence: Some(list.sequence),
    }
}

/// `POST /api/methods/estimate` (demo): the recorded seconds / replay speed;
/// an unrecorded method is a plain 400.
pub fn methods_estimate(
    bundle: &DemoBundle,
    req: &EstimateRequest,
) -> Result<EstimateResponse, AppError> {
    let speed = speed();
    let mut seconds = Vec::with_capacity(req.method_ids.len());
    for id in &req.method_ids {
        let Some((_config, record)) = record_for_first(bundle, id) else {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "DEMO_NOT_RECORDED",
                format!(
                    "the demo has no recorded results for method {id:?} — it estimates the \
                     recorded methods only"
                ),
            ));
        };
        seconds.push(replay_seconds(record.seconds, speed));
    }
    let total: f64 = seconds.iter().sum();
    Ok(EstimateResponse {
        methods: req
            .method_ids
            .iter()
            .enumerate()
            .map(|(i, id)| MethodEstimate {
                id: id.clone(),
                estimated_seconds: seconds[i],
                estimate_quality: TimingQuality::Measured,
            })
            .collect(),
        total_seconds: total,
        schedule_seconds: lpt_schedule_seconds(&seconds, req.at_a_time.max(1) as usize),
        at_a_time: req.at_a_time,
        cpus: req.cpus.unwrap_or_else(crate::modules::method_catalogue::estimate::host_cpus),
    })
}

/// `POST /api/txr/models/eligibility` (demo): per-model verdicts from the
/// bundle — a model whose method is recorded is can_run with the recorded
/// seconds; anything else is cannot_run + NOT_RUNNABLE.
pub async fn models_eligibility(
    pool: &SqlitePool,
    bundle: &DemoBundle,
    req: &crate::modules::model_store::types::ModelEligibilityRequest,
) -> Result<ModelEligibilityResponse, AppError> {
    let repo = ModelStoreRepository::new(pool.clone());
    let speed = speed();
    let mut output = Vec::with_capacity(req.model_ids.len());
    let mut total_fit = 0;
    let mut total_cannot = 0;
    for id in &req.model_ids {
        let model_id = Uuid::parse_str(id).map_err(|_| {
            AppError::new(StatusCode::NOT_FOUND, "MODEL_NOT_FOUND", format!("no model {id}"))
        })?;
        let model = repo.get_model(model_id).await?.ok_or_else(|| {
            AppError::new(StatusCode::NOT_FOUND, "MODEL_NOT_FOUND", format!("no model {id}"))
        })?;
        // The model's recorded (endpoint, decision day, horizon, covariates)
        // select the recorded configuration.
        let task = crate::modules::model_store::store::parse_task(&model.task)?;
        let endpoint = crate::modules::model_store::store::parse_endpoint(&model.endpoint)?;
        let used: Option<crate::modules::model_store::types::CovariateFacts> =
            serde_json::from_value(model.covariates.clone()).ok();
        let used_covariates = used.map(|c| c.used).unwrap_or(false);
        let mut method_record: Option<&super::bundle::BundleMethodRecord> = None;
        for cfg in &bundle.configurations {
            if (cfg.endpoint == endpoint)
                && (cfg.decision_day - model.decision_day).abs() < 1e-9
                && (cfg.look_ahead_day - model.horizon).abs() < 1e-9
                && cfg.covariates == used_covariates
            {
                method_record = super::replay::method_record(bundle, &cfg.id, &model.method_id);
                break;
            }
        }
        if method_record.is_none() {
            method_record = record_for_first(bundle, &model.method_id).map(|(_, r)| r);
        }
        if let Some(record) = method_record {
            let seconds = record.seconds / speed.max(0.01);
            output.push(ModelEligibility {
                id: id.clone(),
                task,
                endpoint,
                status: crate::modules::method_catalogue::types::EligibilityStatus::CanRun,
                reasons: Vec::new(),
                missing_markers: Vec::new(),
                coverage: Coverage {
                    eligible: record.train.coverage.eligible,
                    total: record.train.coverage.eligible,
                    fraction: record.train.coverage.fraction,
                },
                min_draws: MinDraws {
                    required: 0,
                    met: record.train.coverage.eligible,
                    unmet_patients: 0,
                },
                estimated_seconds: Some(seconds.max(super::replay::MIN_METHOD_SECONDS)),
                estimate_quality: TimingQuality::Measured,
            });
            total_fit += 1;
        } else {
            output.push(ModelEligibility {
                id: id.clone(),
                task,
                endpoint,
                status: crate::modules::method_catalogue::types::EligibilityStatus::CannotRun,
                reasons: model_not_recorded_reason(),
                missing_markers: Vec::new(),
                coverage: Coverage {
                    eligible: 0,
                    total: 0,
                    fraction: 0.0,
                },
                min_draws: MinDraws {
                    required: 0,
                    met: 0,
                    unmet_patients: 0,
                },
                estimated_seconds: None,
                estimate_quality: TimingQuality::Estimate,
            });
            total_cannot += 1;
        }
    }
    Ok(ModelEligibilityResponse {
        models: output,
        total_fit,
        total_some: 0,
        total_cannot,
    })
}

/// `POST /api/txr/pretrained/eligibility` (demo): an entry whose catalogue
/// method is recorded is can_run with the recorded seconds; every other
/// entry is cannot_run + NOT_RUNNABLE.
pub fn pretrained_eligibility(
    bundle: &DemoBundle,
    entries: &[crate::modules::pretrained_catalogue::types::PretrainedModel],
) -> PretrainedEligibilityResponse {
    let speed = speed();
    let mut output = Vec::with_capacity(entries.len());
    let mut total_fit = 0;
    let mut total_cannot = 0;
    for entry in entries {
        if let Some((_, record)) = record_for_first(bundle, &entry.method_id) {
            let seconds = record.seconds / speed.max(0.01);
            output.push(PretrainedEligibilityEntry {
                id: entry.id.clone(),
                status: crate::modules::method_catalogue::types::EligibilityStatus::CanRun,
                reasons: Vec::new(),
                missing_markers: Vec::new(),
                coverage: Coverage {
                    eligible: record.train.coverage.eligible,
                    total: record.train.coverage.eligible,
                    fraction: record.train.coverage.fraction,
                },
                min_draws: MinDraws {
                    required: entry.needs.marker_facts.min_draws,
                    met: record.train.coverage.eligible,
                    unmet_patients: 0,
                },
                estimated_seconds: Some(seconds.max(super::replay::MIN_METHOD_SECONDS)),
                estimate_quality: TimingQuality::Measured,
            });
            total_fit += 1;
        } else {
            output.push(PretrainedEligibilityEntry {
                id: entry.id.clone(),
                status: crate::modules::method_catalogue::types::EligibilityStatus::CannotRun,
                reasons: pretrained_not_recorded_reason(),
                missing_markers: Vec::new(),
                coverage: Coverage {
                    eligible: 0,
                    total: 0,
                    fraction: 0.0,
                },
                min_draws: MinDraws {
                    required: entry.needs.marker_facts.min_draws,
                    met: 0,
                    unmet_patients: 0,
                },
                estimated_seconds: None,
                estimate_quality: TimingQuality::Estimate,
            });
            total_cannot += 1;
        }
    }
    PretrainedEligibilityResponse {
        models: output,
        total_fit,
        total_some: 0,
        total_cannot,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — the verdict/estimate arms against a minimal bundle
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_bundle() -> DemoBundle {
        let json = serde_json::json!({
            "format": "txresbench-demo-bundle",
            "version": 1,
            "generated_at": "2026-11-14T00:00:00Z",
            "dataset_id": "example",
            "tables": {
                "patients": {"content_hash": format!("sha256:{}", "a".repeat(64)), "rows": 94, "columns": []},
                "measurements": {"content_hash": format!("sha256:{}", "b".repeat(64)), "rows": 630, "columns": []},
                "predict_measurements": {"content_hash": format!("sha256:{}", "c".repeat(64)), "rows": 15, "columns": []},
            },
            "configurations": [{
                "id": "pfs_d56_h238", "endpoint": "pfs", "decision_day": 56.0,
                "look_ahead_day": 238.0, "covariates": false, "logs": [],
            }],
            "methods": [{
                "method_id": "kelim",
                "records": [{
                    "configuration_id": "pfs_d56_h238",
                    "seconds": 12.5,
                    "train": {"table": "train/pfs_d56_h238/kelim.csv", "label": "kelim",
                              "group": "kinetics", "group_label": "Kinetics", "task": "pfs",
                              "prob_source": "native", "flat_conversion": false,
                              "coverage": {"scored": 94, "eligible": 94, "fraction": 1.0},
                              "rows": 94},
                    "model": null,
                    "reuse": null,
                }],
            }],
        });
        let mut bundle: DemoBundle =
            serde_json::from_value(json).expect("the test manifest parses");
        bundle.bundle_dir = PathBuf::from("/nonexistent");
        bundle
    }

    #[test]
    fn methods_eligibility_marks_recorded_can_run_and_others_not() {
        let bundle = test_bundle();
        let body = crate::modules::method_catalogue::types::EligibilityRequest::Inventory {
            inventory: crate::modules::method_catalogue::types::InventoryEligibilityRequest {
                patients: 94,
                decision_day: 56.0,
                baseline_max_day: 0.0,
                markers: vec![],
                covariates: vec![],
                outcomes: None,
                filters: None,
            },
        };
        let resp = methods_eligibility(&bundle, &body);
        assert_eq!(resp.total_fit, 1, "exactly the recorded method fits");
        assert!(resp.total_cannot > 100, "the unrecorded catalogue is cannot_run");
        let kelim = resp
            .methods
            .iter()
            .find(|m| m.id == "kelim")
            .expect("kelim is a method");
        assert_eq!(kelim.status, EligibilityStatus::CanRun);
        assert_eq!(kelim.coverage.eligible, 94);
        assert_eq!(kelim.estimated_seconds, 1.5, "12.5 s at speed 10 floors at 1.5");
        let other = resp
            .methods
            .iter()
            .find(|m| m.id != "kelim")
            .expect("the catalogue has other methods");
        assert_eq!(other.status, EligibilityStatus::CannotRun);
        assert_eq!(other.reasons[0].code, crate::modules::method_catalogue::types::ReasonCode::NotRunnable);
    }

    #[test]
    fn methods_estimate_is_recorded_only() {
        let bundle = test_bundle();
        let req = EstimateRequest {
            method_ids: vec!["kelim".to_string()],
            patients: 94,
            cpus: Some(4),
            at_a_time: 2,
        };
        let resp = methods_estimate(&bundle, &req).expect("recorded method estimates");
        assert_eq!(resp.methods.len(), 1);
        assert_eq!(resp.methods[0].estimated_seconds, 1.5);
        assert_eq!(resp.methods[0].estimate_quality, TimingQuality::Measured);
        assert_eq!(resp.total_seconds, 1.5);
        assert_eq!(resp.schedule_seconds, 1.5);

        let bad = EstimateRequest {
            method_ids: vec!["not-recorded".to_string()],
            ..req.clone()
        };
        let err = methods_estimate(&bundle, &bad).expect_err("unrecorded refused");
        assert_eq!(err.status_code(), 400);
        assert!(err.to_string().contains("no recorded results"), "{}", err);
    }

    #[test]
    fn pretrained_eligibility_marks_recorded_methods_only() {
        let bundle = test_bundle();
        let entry_json = serde_json::json!({
            "id": "p-kelim",
            "version": "1.0.0",
            "kind": "published-rule",
            "name": "Kelim",
            "description": "x",
            "method_id": "kelim",
            "method_version": "1.0.0",
            "group": "kinetics",
            "group_label": "Kinetics",
            "needs": {
                "marker_facts": {"kind": "any", "count": 0, "min_draws": 1,
                                 "needs_baseline": false, "uses_history": "landmark",
                                 "needs_detection_call": false, "marker_groups_required": []},
                "covariates": "optional", "decision_day": 56.0, "endpoint": "pfs",
                "horizon": 238.0, "task": "survival",
            },
            "env": {"base_digest": "x", "layer_digest": "y"},
            "contract": "2.0",
            "embeds_training_data": false,
            "research_notice": true,
            "licence": "MIT",
            "data_sources": [],
            "asset": {"bundled": false, "file": "p-kelim-1.0.0.txr", "url": "", "size_bytes": 0, "sha256": "0".repeat(64), "signature": ""},
        });
        let recorded: crate::modules::pretrained_catalogue::types::PretrainedModel =
            serde_json::from_value(entry_json).expect("entry parses");
        let mut not_recorded = recorded.clone();
        not_recorded.id = "p-other".to_string();
        not_recorded.method_id = "not-recorded".to_string();
        let resp = pretrained_eligibility(&bundle, &[recorded, not_recorded]);
        assert_eq!(resp.total_fit, 1);
        assert_eq!(resp.models[0].status, EligibilityStatus::CanRun);
        assert_eq!(resp.models[1].status, EligibilityStatus::CannotRun);
    }
}
