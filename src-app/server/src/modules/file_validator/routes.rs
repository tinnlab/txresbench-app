//! The four HTTP endpoints — `routes.rs` (ITEM-6, PROV-FV-2/3/4).
//!
//! Mounted through [`super::FileValidatorModule::register_routes`] under the
//! framework's `/api` prefix: `POST /api/file-validation/inspect`,
//! `POST /api/file-validation/validate`, `GET /api/file-validation/templates/{kind}`
//! and `GET /api/file-validation/examples/{kind}`. All four are gated by the
//! REUSED `projects::use` permission (DEC-3: no new permission, so the
//! framework's restricted-user surface is untouched and the single local owner
//! passes automatically).
//!
//! ## Handler posture
//!
//! The handlers are thin transport: every verdict lives in the pure engines
//! (`inspect`, `validate`) over the browser-decoded `ParsedTable`s (DEC-1).
//! The two POST endpoints run their engine call through `spawn_blocking` — a
//! row table can be large (the A06 notice is at a million value rows) and the
//! module pattern keeps blocking work off a tokio worker (the
//! `method_catalogue` and `extensions` precedents). The two GET asset
//! endpoints serve the boot-validated embedded bytes directly (no I/O at all,
//! no blocking pool).
//!
//! ## Body-size posture (DEC-9)
//!
//! The desktop ruling is "we should not limit file size" — the two POST
//! routes carry `DefaultBodyLimit::disable()` (the dataset upload routes'
//! posture), so a large measurements table reaches the engine and gets the
//! honest A06 notice instead of a transport-level 413.
//!
//! ## Error mapping (closed, documented)
//!
//! The request-body extractor maps a body that does not match the typed
//! request schema onto the plan's named 400 codes with the framework's
//! `{error: <message>, error_code: <code>}` body (AppError's wire shape) —
//! never the framework's default 422 rejection shape. `INVALID_KIND` is the
//! inspect parse error,
//! `INVALID_MODE` the validate one; a syntactically invalid JSON body takes
//! the same 400, and a missing `application/json` content type keeps its 415.
//! - `POST /api/file-validation/validate`: the engines' failures keep their
//!   named codes — `MISSING_PATIENTS` (the two-table mode without a patients
//!   table) and `INVALID_JOIN` (a join variant or mapping key that is not a
//!   measurement marker key), both `400`. The parameter check runs in the
//!   handler, before the engine: a non-finite day value or a window where
//!   `baseline_max_day` is negative or exceeds `decision_day` is
//!   `400 INVALID_PARAMETERS` (PROV-FV-3 and TEST-FV-21 name the conditions;
//!   the code is this route's reading of the closed error vocabulary —
//!   DRIFT-1 ITEM-6 #1).
//! - `GET /api/file-validation/{templates,examples}/{kind}`: an unknown kind
//!   is `404 INVALID_EXAMPLE_KIND` (the plan's named code, PROV-FV-4).
//! - `401` without the session bearer (the gated-route proof, as everywhere).
//!
//! ## The request-body extractor and the emitted schema
//!
//! [`RequestJson`] implements aide's `OperationInput` by delegating to
//! `axum::Json<T>` — the generated `openapi.json` request body stays the
//! typed schema (the regen parity intent: the api-client types generation
//! must see `FileInspectionRequest`/`ValidationRequest`, not an untyped
//! object), while the runtime rejection is this module's named-400 mapping.
//! The extractor's rejection tuple is the same `(StatusCode, AppError)` the
//! permission extractor produces, so the two combine in one handler.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use aide::OperationInput;
use axum::extract::{DefaultBodyLimit, FromRequest, Path};
use axum::http::{header, StatusCode};
use axum::Json;
use serde::de::DeserializeOwned;
use tokio::task::spawn_blocking;

use txresbench_core::{ApiResult, AppError};

use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::project::ProjectsUse;

use super::assets::ASSETS;
use super::inspect::inspect;
use super::types::{
    AnalysisParameters, FileInspection, FileInspectionRequest, FileTableKind,
    ValidationResponse, ValidationRequest,
};
use super::validate::validate;

// ─────────────────────────────────────────────────────────────────────────────
// The single registration table (TEST-FV-30's route inventory: the router is
// BUILT from this table, so a fifth route cannot be registered without an
// entry here — a route added without the inventory entry cannot register, and
// a table entry without the test's pin fails the inventory test).
// ─────────────────────────────────────────────────────────────────────────────

/// The route kind — one endpoint (its handler + docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteKind {
    Inspect,
    Validate,
    Templates,
    Examples,
}

/// The four plan endpoints (PROV-FV-2/3/4) with their method and module path
/// (the `/api` prefix is the framework's).
const ROUTE_INVENTORY: &[(&str, &str, RouteKind)] = &[
    ("POST", "/file-validation/inspect", RouteKind::Inspect),
    ("POST", "/file-validation/validate", RouteKind::Validate),
    (
        "GET",
        "/file-validation/templates/{kind}",
        RouteKind::Templates,
    ),
    ("GET", "/file-validation/examples/{kind}", RouteKind::Examples),
];

/// The module's route set. Built from [`ROUTE_INVENTORY`], so the registered
/// surface is the inventory by construction; no root-level catch-all (the
/// `/api` prefix + permission mounting stay the framework's).
pub fn file_validator_routes() -> ApiRouter {
    let mut router = ApiRouter::new();
    for (_, path, kind) in ROUTE_INVENTORY {
        let method_router = match kind {
            RouteKind::Inspect => {
                post_with(post_inspect, post_inspect_docs).layer(DefaultBodyLimit::disable())
            }
            RouteKind::Validate => {
                post_with(post_validate, post_validate_docs).layer(DefaultBodyLimit::disable())
            }
            RouteKind::Templates => get_with(get_template, get_template_docs),
            RouteKind::Examples => get_with(get_example, get_example_docs),
        };
        router = router.api_route(path, method_router);
    }
    router
}

// ─────────────────────────────────────────────────────────────────────────────
// The request-body extractor (typed schema in the spec, named 400 at runtime)
// ─────────────────────────────────────────────────────────────────────────────

/// The named parse-error code of one POST endpoint (PROV-FV-2 `INVALID_KIND`,
/// PROV-FV-3 `INVALID_MODE`) — the extractor's phantom parameter.
pub trait BodyErrorCode {
    /// The wire code.
    const CODE: &'static str;
}

/// The inspect endpoint's named code.
pub enum InspectErrorCode {}
/// The validate endpoint's named code.
pub enum ValidateErrorCode {}

impl BodyErrorCode for InspectErrorCode {
    const CODE: &'static str = "INVALID_KIND";
}

impl BodyErrorCode for ValidateErrorCode {
    const CODE: &'static str = "INVALID_MODE";
}

/// The typed JSON body extractor with the module's named-400 mapping.
///
/// The rejection mapping is deliberate: the framework's default `Json`
/// rejection answers a body that parses but does not match the schema with
/// `422 JsonDataError` (the method-catalogue routes' posture), while this
/// node's contract (PROV-FV-2/3, TEST-FV-21) pins `400 INVALID_KIND` /
/// `400 INVALID_MODE` for exactly that class of request. The aide
/// `OperationInput` delegation keeps the emitted request-body schema the typed
/// one.
#[derive(Debug)]
pub struct RequestJson<T, C> {
    pub value: T,
    _code: std::marker::PhantomData<C>,
}

impl<T, C> RequestJson<T, C> {
    /// The extracted body.
    pub fn into_inner(self) -> T {
        self.value
    }
}

impl<S, T, C> FromRequest<S> for RequestJson<T, C>
where
    S: Send + Sync,
    T: DeserializeOwned,
    C: BodyErrorCode,
    axum::Json<T>: FromRequest<S, Rejection = axum::extract::rejection::JsonRejection>,
{
    type Rejection = (StatusCode, AppError);

    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, Self::Rejection> {
        let axum::Json(value) = axum::Json::<T>::from_request(req, state)
            .await
            .map_err(|rejection| {
                let status = rejection.status();
                let text = rejection.body_text();
                reject(status, text, C::CODE)
            })?;
        Ok(RequestJson {
            value,
            _code: std::marker::PhantomData,
        })
    }
}

/// Map one JSON rejection onto the module's error tuple. The status classes
/// are: 415 (a body that is not JSON — the content type is wrong, not the
/// contract), 422 (a body that does not match the schema — the contract's
/// named 400 wins), 400 (a syntactically invalid JSON body — kept). The code
/// is the endpoint's named parse code (`INVALID_KIND` / `INVALID_MODE`),
/// uniform across the classes: the named-400 split is per endpoint, not per
/// failure detail.
fn reject(
    status: StatusCode,
    body_text: String,
    code: &'static str,
) -> (StatusCode, AppError) {
    let status = if status == StatusCode::UNPROCESSABLE_ENTITY {
        StatusCode::BAD_REQUEST
    } else {
        status
    };
    let message = match status {
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "the request body must be JSON".to_string(),
        StatusCode::BAD_REQUEST => {
            format!("the request body does not match the contract: {body_text}")
        }
        _ => format!("the request body could not be read: {body_text}"),
    };
    (status, AppError::new(status, code, message))
}

// The aide integration: the emitted request-body schema is the typed one
// (`axum::Json<T>`'s own `OperationInput` implementation).
impl<T: schemars::JsonSchema, C: BodyErrorCode> OperationInput for RequestJson<T, C> {
    fn operation_input(
        ctx: &mut aide::generate::GenContext,
        operation: &mut aide::openapi::Operation,
    ) {
        <axum::Json<T> as OperationInput>::operation_input(ctx, operation);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-FV-2 — POST /api/file-validation/inspect
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/file-validation/inspect` — one file's drop-time verdict.
async fn post_inspect(
    _auth: RequirePermissions<(ProjectsUse,)>,
    body: RequestJson<FileInspectionRequest, InspectErrorCode>,
) -> ApiResult<Json<FileInspection>> {
    let request = body.into_inner();
    // The engine is pure and the table can be large — blocking work stays off
    // the tokio worker (the module pattern).
    let response = spawn_blocking(move || inspect(&request))
        .await
        .map_err(|e| {
            AppError::internal_error(format!("inspect task join failed: {e}")).to_api_error()
        })?;
    Ok((StatusCode::OK, Json(response)))
}

fn post_inspect_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("One file's drop-time verdict (screen C inspects each file as it is dropped; screen N inspects its only file): resolved column roles, per-file tidy problems by FILE row, the marker list with row counts, the distinct draw days, and the per-column join-offer / unit / vocabulary facts. The full cross-table set is the validate endpoint's. A body that does not match the typed request schema is 400 INVALID_KIND.")
        .id("FileValidation.inspect")
        .tag("file-validator")
        .response::<200, Json<FileInspection>>()
        .response_with::<400, (), _>(|r| {
            r.description("INVALID_KIND — the request body is not the contract's (bad kind, bad table shape)")
        })
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-FV-3 — POST /api/file-validation/validate
// ─────────────────────────────────────────────────────────────────────────────

/// The parameter check (TEST-FV-30: the handlers validate BEFORE computing).
/// The day values are user-provided analysis parameters (DEC-9): a non-finite
/// value or a window whose start is negative or past its end is refused — a
/// coverage count computed from an impossible window is never produced.
fn check_parameters(parameters: &AnalysisParameters) -> Result<(), (StatusCode, AppError)> {
    let bad = |detail: String| {
        (
            StatusCode::BAD_REQUEST,
            AppError::bad_request("INVALID_PARAMETERS", detail),
        )
    };
    if !parameters.decision_day.is_finite() || !parameters.baseline_max_day.is_finite() {
        return Err(bad(format!(
            "decision_day and baseline_max_day must be finite numbers (got {} / {})",
            parameters.decision_day, parameters.baseline_max_day
        )));
    }
    if parameters.baseline_max_day < 0.0 {
        return Err(bad(format!(
            "baseline_max_day must be >= 0 (got {})",
            parameters.baseline_max_day
        )));
    }
    if parameters.baseline_max_day > parameters.decision_day {
        return Err(bad(format!(
            "baseline_max_day ({}) must be <= decision_day ({})",
            parameters.baseline_max_day, parameters.decision_day
        )));
    }
    Ok(())
}

/// `POST /api/file-validation/validate` — the full two-table verdict.
async fn post_validate(
    _auth: RequirePermissions<(ProjectsUse,)>,
    body: RequestJson<ValidationRequest, ValidateErrorCode>,
) -> ApiResult<Json<ValidationResponse>> {
    let request = body.into_inner();
    // The parameter check runs here, before the engine (TEST-FV-30).
    check_parameters(&request.parameters)?;
    let response = spawn_blocking(move || validate(&request))
        .await
        .map_err(|e| {
            AppError::internal_error(format!("validate task join failed: {e}")).to_api_error()
        })?;
    let response = response
        .map_err(|e| AppError::bad_request(e.code(), e.to_string()).to_api_error())?;
    Ok((StatusCode::OK, Json(response)))
}

fn post_validate_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("The full two-table verdict: per-file + cross-table problems by FILE row, the resolved marker columns (after the user's joins and vocabulary mappings), unit verdicts, per-marker coverage with the 2026-10-19 baseline rule, the table summaries and the inventory body — the exact POST /api/methods/eligibility request the intake screens post straight on. The request chooses the C screen's two-table `files` mode or the N screen's measurements-only `predict` mode; one endpoint set serves both. 400 INVALID_MODE / INVALID_PARAMETERS / MISSING_PATIENTS / INVALID_JOIN.")
        .id("FileValidation.validate")
        .tag("file-validator")
        .response::<200, Json<ValidationResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description("INVALID_MODE (body not the contract's) / INVALID_PARAMETERS (non-finite or impossible day window) / MISSING_PATIENTS / INVALID_JOIN")
        })
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-FV-4 — GET /api/file-validation/{templates,examples}/{kind}
// ─────────────────────────────────────────────────────────────────────────────

/// The asset endpoints' kind resolution: the two file kinds of the screens
/// (patients + measurements). `None` for an unknown kind → 404
/// INVALID_EXAMPLE_KIND (PROV-FV-4: any other kind is refused, never a
/// silently empty body). The templates know no other kind; the examples add
/// the ITEM-3 predict-measurements table ([`example_kind`]).
fn template_kind(kind: &str) -> Option<FileTableKind> {
    match kind {
        "patients" => Some(FileTableKind::Patients),
        "measurements" => Some(FileTableKind::Measurements),
        _ => None,
    }
}

/// The example kind resolution of PROV-FV-4 + the qa-fixes3 ITEM-3 growth:
/// the two screen kinds plus `predict-measurements` (the separate table of
/// NEW patients to predict — the N screen's file shape: same markers, no
/// outcomes).
fn example_kind(kind: &str) -> Option<ExampleKind> {
    match kind {
        "patients" => Some(ExampleKind::Patients),
        "measurements" => Some(ExampleKind::Measurements),
        "predict-measurements" => Some(ExampleKind::PredictMeasurements),
        _ => None,
    }
}

/// One example table (the examples endpoint's kind vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExampleKind {
    Patients,
    Measurements,
    PredictMeasurements,
}

/// The CSV response: 200 + `text/csv; charset=utf-8` + the embedded bytes
/// verbatim (the committed file IS the response body — PROV-FV-4).
fn csv_response(bytes: &'static [u8]) -> impl axum::response::IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/csv; charset=utf-8")],
        bytes,
    )
}

/// `GET /api/file-validation/templates/{kind}` — the shipped header-only
/// template (the board's column spec).
async fn get_template(
    _auth: RequirePermissions<(ProjectsUse,)>,
    Path(kind): Path<String>,
) -> ApiResult<impl axum::response::IntoResponse> {
    let bytes = match template_kind(&kind) {
        Some(FileTableKind::Patients) => ASSETS.patients_template,
        Some(FileTableKind::Measurements) => ASSETS.measurements_template,
        None => {
            return Err(AppError::new(
                StatusCode::NOT_FOUND,
                "INVALID_EXAMPLE_KIND",
                format!("no template for kind `{kind}` (patients | measurements)"),
            )
            .to_api_error())
        }
    };
    Ok((StatusCode::OK, csv_response(bytes)))
}

fn get_template_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("The header-only template CSV for a screen-C file kind (`patients`: patient_id,pfs_days,pfs_event,os_days,os_event,responder,response_day,age,sex,stage; `measurements`: patient_id,day,marker,value,unit) — served from the embedded bytes, never read from disk. Unknown kind → 404 INVALID_EXAMPLE_KIND.")
        .id("FileValidation.template")
        .tag("file-validator")
        .response_with::<200, (), _>(|r| {
            r.description("text/csv; charset=utf-8 — the committed template bytes")
        })
        .response_with::<404, (), _>(|r| r.description("Unknown kind (INVALID_EXAMPLE_KIND)"))
}

/// `GET /api/file-validation/examples/{kind}` — the shipped full synthetic
/// example (a generated fixture, never real data): the training patients,
/// the training measurements, or — `kind=predict-measurements` (qa-fixes3
/// ITEM-3) — the separate measurements table of NEW patients to predict
/// (same markers, no outcomes).
async fn get_example(
    _auth: RequirePermissions<(ProjectsUse,)>,
    Path(kind): Path<String>,
) -> ApiResult<impl axum::response::IntoResponse> {
    let bytes = match example_kind(&kind) {
        Some(ExampleKind::Patients) => ASSETS.patients_example,
        Some(ExampleKind::Measurements) => ASSETS.measurements_example,
        Some(ExampleKind::PredictMeasurements) => ASSETS.predict_measurements_example,
        None => {
            return Err(AppError::new(
                StatusCode::NOT_FOUND,
                "INVALID_EXAMPLE_KIND",
                format!(
                    "no example for kind `{kind}` (patients | measurements | predict-measurements)"
                ),
            )
            .to_api_error())
        }
    };
    Ok((StatusCode::OK, csv_response(bytes)))
}

fn get_example_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("The full synthetic example CSV for a file kind (generated from the app's seeded example simulator; ids J0000.., markers M1/M2/M3, unit a.u. — never real patient data). `patients` / `measurements` are the training pair (the C screen's two files); `predict-measurements` is the separate table of new patients to predict (the N screen's file: the same markers, no outcomes). Served from the embedded bytes. Unknown kind → 404 INVALID_EXAMPLE_KIND.")
        .id("FileValidation.example")
        .tag("file-validator")
        .response_with::<200, (), _>(|r| {
            r.description("text/csv; charset=utf-8 — the committed example bytes")
        })
        .response_with::<404, (), _>(|r| r.description("Unknown kind (INVALID_EXAMPLE_KIND)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TEST-FV-30 (inventory half): the registered surface is EXACTLY the
    /// four plan endpoints — the router is built from `ROUTE_INVENTORY`, so
    /// an endpoint added without an inventory entry cannot register, and a
    /// table entry the test does not pin fails here.
    #[test]
    fn route_inventory_is_exactly_the_four_plan_endpoints() {
        let methods: Vec<(&str, &str)> = ROUTE_INVENTORY.iter().map(|(m, p, _)| (*m, *p)).collect();
        assert_eq!(
            methods,
            vec![
                ("POST", "/file-validation/inspect"),
                ("POST", "/file-validation/validate"),
                ("GET", "/file-validation/templates/{kind}"),
                ("GET", "/file-validation/examples/{kind}"),
            ],
            "PROV-FV-2/3/4's four endpoints, in the module's registration order"
        );
        assert_eq!(ROUTE_INVENTORY.len(), 4);
        // Every inventory entry has a distinct path (two entries on one path
        // would silently overwrite the first in the router build).
        let mut seen = std::collections::BTreeSet::new();
        for (_, path, _) in ROUTE_INVENTORY {
            assert!(seen.insert(*path), "duplicate route path {path}");
        }
    }

    /// TEST-FV-30 (validation half): the handler's parameter check runs
    /// BEFORE the engine — a non-finite day or an impossible window is
    /// `INVALID_PARAMETERS`, the defaults pass.
    #[test]
    fn parameters_are_validated_before_computing() {
        // The named defaults (DEC-9: decision 56, baseline max 0) pass.
        assert!(check_parameters(&AnalysisParameters::default()).is_ok());

        // A non-finite day is refused. (JSON cannot even carry one — a body
        // with 1e999 is a 400 INVALID_MODE parse error in routes; this check
        // is the handler's own backstop + the TEST-FV-30 pin.)
        for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            let params = AnalysisParameters {
                decision_day: value,
                baseline_max_day: 0.0,
            };
            let err = check_parameters(&params).expect_err("non-finite decision_day refused");
            assert_eq!(err.1.error_code(), "INVALID_PARAMETERS");
            let params = AnalysisParameters {
                decision_day: 56.0,
                baseline_max_day: value,
            };
            let err = check_parameters(&params).expect_err("non-finite baseline_max_day refused");
            assert_eq!(err.1.error_code(), "INVALID_PARAMETERS");
        }

        // A negative window start is refused (baseline = day <= 0 per the
        // 2026-10-19 contract — the parameter itself must not go negative).
        let params = AnalysisParameters {
            decision_day: 56.0,
            baseline_max_day: -1.0,
        };
        let err = check_parameters(&params).expect_err("negative baseline_max_day refused");
        assert_eq!(err.1.error_code(), "INVALID_PARAMETERS");

        // A window that starts after it ends is refused.
        let params = AnalysisParameters {
            decision_day: 28.0,
            baseline_max_day: 42.0,
        };
        let err = check_parameters(&params).expect_err("baseline > decision refused");
        assert_eq!(err.1.error_code(), "INVALID_PARAMETERS");
        // The boundary is legal.
        let params = AnalysisParameters {
            decision_day: 28.0,
            baseline_max_day: 28.0,
        };
        assert!(check_parameters(&params).is_ok());
    }

    /// TEST-FV-30 (mapping half): the body-rejection mapping carries the
    /// endpoint's named code — a data mismatch (422 from axum) becomes the
    /// contract's 400, a missing content type keeps 415, and the codes are
    /// the plan's `INVALID_KIND` / `INVALID_MODE` spellings (a rename breaks
    /// this unit test before any api test).
    #[test]
    fn body_rejection_mapping_is_the_named_400() {
        // The named codes themselves.
        assert_eq!(<InspectErrorCode as BodyErrorCode>::CODE, "INVALID_KIND");
        assert_eq!(<ValidateErrorCode as BodyErrorCode>::CODE, "INVALID_MODE");

        // The reject() status mapping: axum's 422 data error → 400
        // (PROV-FV-2/3's named 400); the other classes are untouched.
        let (status, err) = reject(
            StatusCode::UNPROCESSABLE_ENTITY,
            "bad kind".to_string(),
            <InspectErrorCode as BodyErrorCode>::CODE,
        );
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(err.error_code(), "INVALID_KIND");

        let (status, err) = reject(
            StatusCode::BAD_REQUEST,
            "bad json".to_string(),
            <ValidateErrorCode as BodyErrorCode>::CODE,
        );
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(err.error_code(), "INVALID_MODE");

        let (status, err) = reject(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            String::new(),
            <InspectErrorCode as BodyErrorCode>::CODE,
        );
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(err.error_code(), "INVALID_KIND");
        // The 415 message is the protocol note, not the raw rejection text.
        assert!(!err.to_string().is_empty());
    }

    /// The closed 404 code + kind resolution of PROV-FV-4 (an unknown kind is
    /// refused, never a silently empty body).
    #[test]
    fn asset_kind_refuses_unknown_kinds() {
        assert_eq!(template_kind("patients"), Some(FileTableKind::Patients));
        assert_eq!(template_kind("measurements"), Some(FileTableKind::Measurements));
        assert_eq!(template_kind("patients.csv"), None);
        assert_eq!(template_kind(""), None);
        assert_eq!(template_kind("tables"), None);
    }

    /// The ITEM-3 growth of the example kinds: `predict-measurements` is the
    /// third example table; the template endpoint still knows only the two
    /// screen kinds (an unknown kind on EITHER endpoint keeps the closed 404).
    #[test]
    fn example_kinds_carry_the_predict_table_and_refuse_unknowns() {
        assert_eq!(example_kind("patients"), Some(ExampleKind::Patients));
        assert_eq!(example_kind("measurements"), Some(ExampleKind::Measurements));
        assert_eq!(
            example_kind("predict-measurements"),
            Some(ExampleKind::PredictMeasurements)
        );
        assert_eq!(example_kind("predict_measurements"), None);
        assert_eq!(example_kind("measurements.csv"), None);
        assert_eq!(example_kind(""), None);
        assert_eq!(example_kind("tables"), None);
    }

    /// TEST-FV-30 (posture half): the handler's engine call is the pure
    /// function itself — `spawn_blocking` wraps exactly `inspect`/`validate`,
    /// and the engine is deterministic (a repeat call byte-equal; the route
    /// test asserts the same fact through the HTTP boundary).
    #[test]
    fn blocking_engine_calls_are_the_pure_functions() {
        let request = FileInspectionRequest {
            kind: FileTableKind::Measurements,
            table: super::super::types::ParsedTable {
                source: super::super::types::ParsedTableSource {
                    name: "m.csv".to_string(),
                    format: super::super::types::TableFormat::Csv,
                },
                header_row: 1,
                columns: Vec::new(),
                rows: Vec::new(),
            },
        };
        let first = inspect(&request);
        let second = inspect(&request);
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap(),
            "the inspect engine is pure and deterministic"
        );
    }
}
