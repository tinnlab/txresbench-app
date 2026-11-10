//! ITEM-5 — the five HTTP endpoints of the method catalogue (PROV-MC-2..6).
//!
//! All endpoints mount through [`super::MethodCatalogueModule::register_routes`]
//! under the framework's `/api` prefix — `/api/methods`, `/api/methods/{id}`,
//! `/api/markers`, `/api/methods/eligibility`, `/api/methods/estimate` — and are
//! gated by the REUSED `projects::use` permission (DEC-10: no new permission, so
//! the framework's restricted-user surface is untouched and the single local
//! owner passes automatically).
//!
//! ## Handler posture
//!
//! The handlers are thin transport: every decision lives in the engines over
//! the boot-validated embedded catalogue ([`super::catalogue`]). The two POST
//! endpoints run their engine call through `spawn_blocking` — the engine is
//! pure and CPU-cheap (a bounded ≤ ~400-method set), but the module pattern
//! keeps blocking work off a tokio worker (the `extensions::reload_processors`
//! precedent). The two GET-list/detail/vocabulary handlers are plain reads of
//! the already-loaded static catalogue (no I/O at all, so no blocking pool).
//!
//! ## Error mapping (closed, documented)
//!
//! - `GET /api/methods/{id}`: an unknown id is `404 METHOD_NOT_FOUND` (the
//!   framework's `{error:{error, error_code, details?}}` body — the plan's
//!   named `code` is the `error_code` field, the app's uniform wire shape).
//! - `POST /api/methods/estimate`: every engine failure is a `400` carrying
//!   the engine's named code (`UNKNOWN_METHOD` — the first unknown id in
//!   request order, `METHOD_NOT_RUNNABLE`, `INVALID_CPUS`, `INVALID_AT_A_TIME`).
//!   `METHOD_NOT_RUNNABLE` is unreachable on the shipped runnable-only set
//!   (DEC-2) and is exercised through the engine's handcrafted-catalogue seam
//!   (ITEM-4's unit tests) — never silently dropped here.
//! - `POST /api/methods/eligibility`: a body that is syntactically invalid JSON
//!   is the framework's `400` (JsonSyntaxError); a body that parses but does
//!   not match the schema is the framework's `422` (JsonDataError). The
//!   eligibility engine itself has no failure variant — a request always
//!   yields a verdict per method (the reason codes are the contract, not the
//!   HTTP status).
//! - unused query values would be silently ignored, so every query field is
//!   TYPED (`MethodGroup`, `bool`) — a value that does not parse is the
//!   framework's `400` (FailedToDeserializeQueryString) rather than a silent
//!   empty filter.
//!
//! ## Note on the row payload
//!
//! The list response is deliberately UNPAGED (DEC-11): the runnable set is
//! bounded (~ ≤ 400 rows — 359 in the shipped file) and the list screen
//! filters client-side.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Extension, Path, Query};
use axum::http::StatusCode;
use axum::Json;
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::SqlitePool;

use ziee_core::{ApiResult, AppError};

use crate::modules::execution_engine::repository::TxrRepository;
use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::project::ProjectsUse;

use super::catalogue;
use super::calibration::TimingCalibration;
use super::eligibility::eligibility_for_runtime_calibrated;
use super::estimate::estimate_for_runtime_calibrated;
use super::types::{
    Catalogue, EligibilityRequest, EligibilityResponse, EstimateRequest, EstimateResponse,
    MarkerVocabularyResponse, Method, MethodDetail, MethodGroup, MethodListResponse,
    MethodSummary,
};

/**
 * The measured-time calibration snapshot (qa-fixes2 ITEM-6, R2-3): the
 * estimate's per-method bases are scaled with THIS app's own recorded
 * durations. The load FAILS OPEN — the estimate is a display fact, never a
 * run error; an empty calibration is byte-identical to the uncalibrated
 * engine.
 */
async fn load_calibration(pool: &SqlitePool) -> TimingCalibration {
    match TxrRepository::new(pool.clone()).timing_samples().await {
        Ok(samples) => TimingCalibration::from_samples(&samples),
        Err(e) => {
            tracing::warn!(error = %e, "method catalogue: timing calibration read failed; estimating uncalibrated");
            TimingCalibration::empty()
        }
    }
}

/// The module's route set (registered by `register_routes`; no root-level
/// catch-all — the `/api` prefix + permission mouting stay the framework's).
pub fn method_catalogue_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/methods", get_with(list_methods, list_methods_docs))
        .api_route(
            "/methods/{method_id}",
            get_with(get_method_detail, get_method_detail_docs),
        )
        .api_route(
            "/markers",
            get_with(get_marker_vocabulary, get_marker_vocabulary_docs),
        )
        .api_route(
            "/methods/eligibility",
            post_with(post_eligibility, post_eligibility_docs),
        )
        .api_route(
            "/methods/estimate",
            post_with(post_estimate, post_estimate_docs),
        )
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-2 — GET /api/methods
// ─────────────────────────────────────────────────────────────────────────────

/// The optional list filters. Every field is typed so an unparseable value is
/// a framework 400, never a silently-ignored filter (all four are optional —
/// their absence is the full list).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct MethodListQuery {
    /// Filter to one method group (`response-call | response-probability |
    /// static-risk | dynamic-risk`).
    #[serde(default)]
    pub group: Option<MethodGroup>,
    /// Filter to runnable / non-runnable entries. (The shipped catalogue is the
    /// runnable set — DEC-2 — so this is a contract future for the fixture
    /// world and for consumers that must reason about both.)
    #[serde(default)]
    pub runnable: Option<bool>,
    /// Filter to frozen-model entries.
    #[serde(default)]
    pub frozen: Option<bool>,
    /// Case-insensitive substring on the method id.
    #[serde(default)]
    pub q: Option<String>,
}

/// The pure filter — the one place the query semantics live (unit-tested;
/// the handler is a thin projection over it).
fn filter_methods<'a>(cat: &'a Catalogue, q: &MethodListQuery) -> Vec<&'a Method> {
    let needle = q
        .q
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    cat.methods
        .iter()
        .filter(|m| q.group.map_or(true, |g| m.group == g))
        .filter(|m| q.runnable.map_or(true, |r| m.runnable == r))
        .filter(|m| q.frozen.map_or(true, |f| m.frozen_model == f))
        .filter(|m| needle.as_deref().map_or(true, |n| m.id.to_ascii_lowercase().contains(n)))
        .collect()
}

/// `GET /api/methods` — the full (unpaged) runnable set as list rows, in the
/// catalogue's stable order.
async fn list_methods(
    _auth: RequirePermissions<(ProjectsUse,)>,
    Query(q): Query<MethodListQuery>,
) -> ApiResult<Json<MethodListResponse>> {
    let cat = catalogue::catalogue();
    let methods: Vec<MethodSummary> = filter_methods(cat, &q)
        .into_iter()
        .map(MethodSummary::from_method)
        .collect();
    let total = methods.len() as u32;
    Ok((StatusCode::OK, Json(MethodListResponse { methods, total })))
}

fn list_methods_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("List the method catalogue rows (unpaged — the bounded runnable set; the list screen filters client-side). Optional `group`/`runnable`/`frozen`/`q` filters; `q` is a case-insensitive substring on the method id.")
        .id("MethodCatalogue.list")
        .tag("method-catalogue")
        .response::<200, Json<MethodListResponse>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-3 — GET /api/methods/{method_id}
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/methods/{method_id}` — one method's full fact set (the About
/// dialog + screen H facts; `MethodDetail` IS the catalogue entry).
async fn get_method_detail(
    _auth: RequirePermissions<(ProjectsUse,)>,
    Path(method_id): Path<String>,
) -> ApiResult<Json<MethodDetail>> {
    let m = catalogue::method(&method_id).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            "METHOD_NOT_FOUND",
            format!("method `{method_id}` not found"),
        )
        .to_api_error()
    })?;
    Ok((StatusCode::OK, Json(m.clone())))
}

fn get_method_detail_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("One method's full fact set (description, software, licence, references, params, timing, performance). Unknown id → 404 METHOD_NOT_FOUND.")
        .id("MethodCatalogue.detail")
        .tag("method-catalogue")
        .response::<200, Json<MethodDetail>>()
        .response_with::<404, (), _>(|r| r.description("Unknown method id (METHOD_NOT_FOUND)"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-4 — GET /api/markers
// ─────────────────────────────────────────────────────────────────────────────

/// `GET /api/markers` — the marker vocabulary + the 7 board groups (the
/// join-offer + screen-B checkbox set).
async fn get_marker_vocabulary(
    _auth: RequirePermissions<(ProjectsUse,)>,
) -> ApiResult<Json<MarkerVocabularyResponse>> {
    let cat = catalogue::catalogue();
    let vocab = MarkerVocabularyResponse {
        markers: cat.markers.clone(),
        groups: cat.groups.clone(),
    };
    Ok((StatusCode::OK, Json(vocab)))
}

fn get_marker_vocabulary_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("The marker vocabulary (standard-id markers with aliases, unit families, board groups) and the 7 marker groups — the upload screen's join offer and its group-panel checkbox set.")
        .id("MethodCatalogue.markers")
        .tag("method-catalogue")
        .response::<200, Json<MarkerVocabularyResponse>>()
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-5 — POST /api/methods/eligibility
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/methods/eligibility` — the per-method verdicts against a file
/// inventory (screens C/N/E) or an early schedule preview (screen B), plus
/// the runtime-env stage: a catalogue method with no published environment is
/// `cannot_run` + `ENV_IMAGE_MISSING` (the count of them is
/// `total_no_env` — the catalogue still lists them).
async fn post_eligibility(
    _auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(body): Json<EligibilityRequest>,
) -> ApiResult<Json<EligibilityResponse>> {
    let calibration = load_calibration(&pool).await;
    let response = tokio::task::spawn_blocking(move || {
        eligibility_for_runtime_calibrated(catalogue::catalogue(), &body, &calibration)
    })
    .await
    .map_err(|e| {
        AppError::internal_error(format!("eligibility task join failed: {e}")).to_api_error()
    })?;
    Ok((StatusCode::OK, Json(response)))
}

fn post_eligibility_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Per-method eligibility verdicts (can_run / can_run_some / cannot_run) with structured reason codes, missing markers/groups and per-patient coverage aggregates. A method with no published environment available is cannot_run + ENV_IMAGE_MISSING (total_no_env counts them). The body is a tagged union: `preview` (screen-B schedule answers) or `inventory` (the file validator's inventory). The inventory rows' `estimated_seconds` are calibrated with the app's own measured run durations when such exist (the same seconds the estimate endpoint and the run's stored estimate use).")
        .id("MethodCatalogue.eligibility")
        .tag("method-catalogue")
        .response::<200, Json<EligibilityResponse>>()
        .response_with::<400, (), _>(|r| r.description("Malformed JSON body"))
        .response_with::<422, (), _>(|r| r.description("JSON body that does not match the request schema"))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-6 — POST /api/methods/estimate
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/methods/estimate` — per-method seconds (the DEC-7 shape) plus
/// the plain sum and the run-N-at-a-time LPT schedule total (the bottom bar).
/// Absent `cpus` resolves the run's own count ([`estimate::host_cpus`]); a
/// method with no published environment is refused (`METHOD_NOT_RUNNABLE`).
async fn post_estimate(
    _auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(body): Json<EstimateRequest>,
) -> ApiResult<Json<EstimateResponse>> {
    let calibration = load_calibration(&pool).await;
    let response = tokio::task::spawn_blocking(move || {
        estimate_for_runtime_calibrated(catalogue::catalogue(), &body, &calibration)
    })
    .await
    .map_err(|e| {
        AppError::internal_error(format!("estimate task join failed: {e}")).to_api_error()
    })?
    .map_err(|e| AppError::bad_request(e.code(), e.to_string()).to_api_error())?;
    Ok((StatusCode::OK, Json(response)))
}

fn post_estimate_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Per-method estimated seconds (base per-fold seconds scaled by patients and CPUs — 150 reference patients; an absent `cpus` uses the run's own detected count), the plain sum, and the greedy longest-processing-time schedule total over `at_a_time` lanes (the run-N-at-a-time bar). A method the app has measured itself estimates with its own median measured per-fold seconds (quality `measured`), the generated facts otherwise — the honest estimate-vs-measured label. Validation order: cpus/at_a_time (a posted 0 rejected) first, then method resolution — the first failure wins; a method with no published environment is METHOD_NOT_RUNNABLE.")
        .id("MethodCatalogue.estimate")
        .tag("method-catalogue")
        .response::<200, Json<EstimateResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description("UNKNOWN_METHOD / METHOD_NOT_RUNNABLE / INVALID_CPUS / INVALID_AT_A_TIME")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::catalogue;

    /// The pure query-filter semantics (no HTTP): group + q + boolean filters
    /// and their combination, over the REAL embedded catalogue.
    #[test]
    fn list_query_filters_are_the_query_semantics() {
        let cat = catalogue::catalogue();
        let all = filter_methods(cat, &MethodListQuery::default());
        assert_eq!(all.len(), cat.methods.len(), "no filters = the full set");

        let dynamic = filter_methods(
            cat,
            &MethodListQuery {
                group: Some(MethodGroup::DynamicRisk),
                ..Default::default()
            },
        );
        assert_eq!(dynamic.len(), cat.methods.iter().filter(|m| m.group == MethodGroup::DynamicRisk).count());
        assert!(!dynamic.is_empty(), "non-vacuity: dynamic-risk methods exist");
        assert!(dynamic.iter().all(|m| m.group == MethodGroup::DynamicRisk));

        // `q` is a case-insensitive substring on the id.
        let q = filter_methods(
            cat,
            &MethodListQuery {
                q: Some("ASM-BEST".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(q.len(), 1, "the asm-best-change-rule row matches case-insensitively");
        assert_eq!(q[0].id, "asm-best-change-rule");

        // Combined filters compound (group + q).
        let combined = filter_methods(
            cat,
            &MethodListQuery {
                group: Some(MethodGroup::DynamicRisk),
                q: Some("cox".to_string()),
                ..Default::default()
            },
        );
        assert!(combined.iter().all(|m| m.group == MethodGroup::DynamicRisk && m.id.contains("cox")));

        // The runnable/frozen booleans are contract filters; on the shipped
        // runnable-only set the runnable=true filter is the whole set.
        let runnable = filter_methods(
            cat,
            &MethodListQuery {
                runnable: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(runnable.len(), all.len());
    }

    /// TEST-MC-26 (unit half): the `MethodSummary` JSON-schema surface carries
    /// EXACTLY the named PROV-MC-2 fact set (the openapi emitter derives the
    /// client contract from this same schemars schema, so a field drop here is
    /// a client-contract break). Plus the HTTP half in the routes suite.
    #[test]
    fn method_summary_schema_carries_the_named_fact_set() {
        // schemars 0.9's `Schema` is a thin wrapper over a JSON value; the
        // generated object carries `type` + `properties` (+ `definitions`).
        let schema = schemars::schema_for!(MethodSummary);
        let value = serde_json::to_value(schema).expect("schema serializes");
        let props = value["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("MethodSummary schema must be an object: {value}"));
        let mut names: Vec<&str> = props.keys().map(|k| k.as_str()).collect();
        names.sort_unstable();
        let expected: Vec<&str> = vec![
            "container",
            "covariates",
            "embeds_training_data",
            "frozen_model",
            "group",
            "group_label",
            "id",
            "journal",
            "language",
            "marker_groups_required",
            "markers",
            "min_draws",
            "needs_baseline",
            "needs_detection_call",
            "paper_doi",
            "performance",
            "required_markers",
            "runnable",
            "spec_status",
            "tasks",
            "timing",
            "uses_history",
            "year",
        ];
        assert_eq!(names, expected, "MethodSummary property set");
        // The list-query struct is a separate schema — a query field (`q`) must
        // never leak into the response schema.
        assert!(!names.contains(&"q"), "query params are not response fields");
    }

    /// The names a consumer renders (the E-row performance text, the
    /// models-dialog warning) must deserialize off the wire round-trip — the
    /// summary's optional performance block + timing block are populated.
    #[test]
    fn summary_round_trips_with_timing_and_performance() {
        let cat = catalogue::catalogue();
        let m = cat.method("asm-best-change-rule").expect("fixture method");
        let summary = MethodSummary::from_method(m);
        let json = serde_json::to_value(&summary).expect("serialize");
        assert_eq!(json["id"], "asm-best-change-rule");
        assert_eq!(json["timing"]["quality"], "measured");
        assert!(json["timing"]["base_seconds_per_fold"].is_number());
        assert_eq!(json["tasks"].as_array().expect("tasks").len(), 0);
        assert_eq!(json["embeds_training_data"], false);
        let _: MethodSummary = serde_json::from_value(json).expect("deserialize");
    }

    /// The estimate endpoint's 400 mapping must carry the ENGINE's named code
    /// verbatim (the consumer switches on it) — the mapping itself is the
    /// `EstimateError::code()` → `error_code` translation.
    #[test]
    fn estimate_error_mapping_carries_the_named_code() {
        let err = super::super::estimate::EstimateError::UnknownMethod {
            method_id: "nope".to_string(),
        };
        let mapped = AppError::bad_request(err.code(), err.to_string());
        assert_eq!(mapped.error_code(), "UNKNOWN_METHOD");
        let err = super::super::estimate::EstimateError::InvalidCpus { value: 0 };
        let mapped = AppError::bad_request(err.code(), err.to_string());
        assert_eq!(mapped.error_code(), "INVALID_CPUS");
    }

    /// A DEFENSIVE non-regression: the estimate handler must never post a
    /// seconds value for an unknown method — the documented DEC-7 helper is
    /// only ever called on catalogued methods via the engine's resolution.
    #[test]
    fn estimate_seconds_helper_is_defined_for_any_patient_count() {
        let cat = catalogue::catalogue();
        let m = cat.method("asm-best-change-rule").expect("method");
        let at_reference = super::super::eligibility::estimate_seconds_for(m, 150, 4);
        let scaled = super::super::eligibility::estimate_seconds_for(m, 300, 8);
        assert_eq!(at_reference, m.timing.base_seconds_per_fold, "reference cohort = the fact");
        assert_eq!(scaled, at_reference, "300 patients on 8 CPUs = the reference (DEC-7 linear shape)");
    }
}
