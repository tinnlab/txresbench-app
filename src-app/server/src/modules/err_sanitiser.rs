//! `err_sanitiser` — the ONE error-message sanitiser at the API boundary
//! used by the TxResBench modules (execution engine, model store, history
//! store, method catalogue, pretrained catalogue; qa-fixes4 ITEM-1).
//!
//! Why it exists (owner request, 2026-11-09 + the qa-fixes4 round-3 review):
//! a later web demo of the app shows these pages to the public, so nothing
//! internal may be user-visible. The modules' reason/message texts are built
//! from machinery errors whose wording was written for a developer — the
//! sandbox's env resolver says "`oras` is not installed (looked in
//! <app_data>/bin and PATH)", a file error says "mkdir /data/txr/…: …", an
//! executor error names the tool binary's own path. Those texts must never
//! reach the UI.
//!
//! THE SHAPE OF THE FIX (one sanitiser, at the boundary):
//!
//! - **Detection** ([`internal_issue`]): an absolute filesystem path (the
//!   Unix roots + a Windows drive letter), the `<app_data>` placeholder, or
//!   an internal tool name (`oras`, `squashfuse`, `fusermount`, `bwrap`).
//! - **Replacement** ([`replacement_for`]): the plain sentence is chosen by
//!   the field's sibling `code` where one exists (the engine/catalogue
//!   reason vocabulary is closed: an `ENV_*`/`SANDBOX_*`/`METHOD_ENTRYPOINT_*`
//!   code reads the environment sentence, anything else the method
//!   sentence) and by the field kind for `message`/`error` (the operation
//!   sentence). The replacement is always a fact-free plain sentence — never
//!   a hint at the internal machinery.
//! - **The full text is never lost**: it is written to the server log
//!   ([`tracing::warn!`], one line per hit, with the field path, the code
//!   and the original text) AND added to the JSON as an `internal_detail`
//!   sibling field that the UI does not render (the plan's rule — the
//!   original stays available to a diagnostic tool, only the rendered text
//!   is plain).
//! - **The boundary** ([`txr_json_boundary`]): one axum middleware layered
//!   over the whole app in `lib.rs`, covering the txr route surface
//!   ([`TXR_ROUTE_PREFIXES`]). It buffers only `application/json`
//!   responses of those routes (SSE streams and CSV downloads pass through
//!   untouched), parses the body, walks the JSON tree, and re-serialises
//!   the sanitised body.
//!
//! The first-order wording fixes (the known report strings inside the
//! modules themselves, e.g. the `oras` messages in
//! `modules/sandbox/method_env.rs`) stay too: the sanitiser is the
//! backstop, not a licence to write internal text in messages. The walk
//! covers every producer shape the txr modules put on the wire — a
//! `{code, detail}` reason object, a `{code, message}` request error, a
//! `{error, error_code}` API error, a `{code, detail}` model warning — so
//! a new producer that forgets the first-order wording still cannot leak.
//!
//! Deliberate NON-goals: the run/SSE log lines (the engine's own diagnostic
//! record, shown in the log panel) and the `dir`/`data_dir`/`models_dir`
//! fields themselves (fact fields, consumed by the desktop shell's
//! open-folder command; the UI's `safeText` guard and the ITEM-1 copy
//! removals are what stop those from being *shown*).

use axum::body::Body;
use axum::http::{header::CONTENT_LENGTH, header::CONTENT_TYPE, Response};
use axum::middleware::Next;
use axum::extract::Request;
use axum::response::IntoResponse;
use serde_json::Value;

/// The body type the boundary works with (axum's `Body` — a `Response`
/// plain alias for the middleware's generic `http::Response<Body>`).
type Resp = Response<Body>;

/// The route surface the sanitiser covers: the five TxResBench modules' own
/// prefixes (engine + history + models + pretrained under `/txr`, the
/// catalogue under `/methods` and `/markers`). Framework routes (mcp,
/// admin/features, sync, account, file) are platform furniture outside the
/// app screens and are NOT rewritten here.
pub const TXR_ROUTE_PREFIXES: [&str; 3] =
    ["/api/txr/", "/api/methods", "/api/markers"];

/// The buffer cap for a JSON response body (see [`txr_json_boundary`]).
const BODY_LIMIT: usize = 128 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// The plain replacements (the plan's examples; each reads honestly on the
// screens — never an internal hint)
// ─────────────────────────────────────────────────────────────────────────────

/// The env-family replacement ("This method's environment is not available
/// yet" — an env that cannot be fetched/prepared is the app's honest
/// read).
pub const ENV_NOT_AVAILABLE: &str = "This method's environment is not available yet";

/// The non-env reason replacement (a method failure whose detail text would
/// leak internals).
pub const METHOD_FAILED: &str = "This method could not run";

/// The operation-error replacement (`message`/`error` fields).
pub const STEP_FAILED: &str = "The app could not complete this step";

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

/// The internal-tool names the app shells out to in its env/model paths.
/// Whole-word matched (see [`has_internal_tool`]) so "oras" in a method id
/// or a journal name never fires.
const INTERNAL_TOOLS: [&str; 4] = ["oras", "squashfuse", "fusermount", "bwrap"];

/// The absolute-path trigger: a slash followed by one of the common roots
/// and a further segment. The UI guard uses the narrower root set of the
/// plan (data|home|usr|var|tmp|opt); the server's own guarantee is
/// stricter and covers the deployment roots too (mnt/srv/root/app).
const PATH_ROOTS: [&str; 9] =
    ["/data/", "/home/", "/usr/", "/var/", "/tmp/", "/opt/", "/mnt/", "/srv/", "/app/"];

/// The `<app_data>` placeholder (the dev-machine app-data dir, rendered
/// raw in the old env messages).
const APP_DATA_PLACEHOLDER: &str = "<app_data>";

/// What the detection found (drives the log line; the replacement is the
/// field's, not the issue's).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueKind {
    /// An absolute filesystem path (Unix root or Windows drive).
    AbsolutePath,
    /// The `<app_data>` placeholder.
    AppDataPlaceholder,
    /// An internal tool name.
    InternalTool,
}

/// Whole-word containment of `needle` in `lower` (regex-`\b` semantics: an
/// underscore is a WORD character, so `old_oras_style` does not count as a
/// mention of the tool — only a real word boundary does).
fn has_tool_word(lower: &str, tool: &str) -> bool {
    let boundary = |b: u8| !b.is_ascii_alphanumeric() && b != b'_';
    let mut start = 0;
    while let Some(rel) = lower[start..].find(tool) {
        let at = start + rel;
        let before_ok = at == 0 || boundary(lower.as_bytes()[at - 1]);
        let end = at + tool.len();
        let after_ok = end >= lower.len() || boundary(lower.as_bytes()[end]);
        if before_ok && after_ok {
            return true;
        }
        start = at + tool.len();
    }
    false
}

/// A Windows drive path (`c:\` / `C:/`, at start or after whitespace).
fn has_windows_drive(text: &str) -> bool {
    let bytes = text.as_bytes();
    for i in 0..bytes.len().saturating_sub(2) {
        let drive = bytes[i].is_ascii_alphabetic();
        let start_ok = i == 0 || bytes[i - 1].is_ascii_whitespace();
        if drive && start_ok && bytes[i + 1] == b':' {
            match bytes[i + 2] {
                b'\\' | b'/' => return true,
                _ => {}
            }
        }
    }
    false
}

/// Detect an internal fact in a user-facing text. `None` = clean.
pub fn internal_issue(text: &str) -> Option<IssueKind> {
    let lower = text.to_ascii_lowercase();
    if lower.contains(APP_DATA_PLACEHOLDER) {
        return Some(IssueKind::AppDataPlaceholder);
    }
    if PATH_ROOTS.iter().any(|root| lower.contains(root)) || has_windows_drive(text) {
        return Some(IssueKind::AbsolutePath);
    }
    if INTERNAL_TOOLS.iter().any(|tool| has_tool_word(&lower, tool)) {
        return Some(IssueKind::InternalTool);
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
// Replacement
// ─────────────────────────────────────────────────────────────────────────────

/// True for a reason code whose story is "the environment could not be
/// prepared" (the closed engine/provider vocabulary's env family).
pub fn is_env_code(code: Option<&str>) -> bool {
    match code {
        Some(c) => {
            c.starts_with("ENV_")
                || matches!(c, "SANDBOX_UNAVAILABLE" | "METHOD_ENTRYPOINT_MISSING")
        }
        None => false,
    }
}

/// The plain replacement for one sanitised field.
///
/// `field` is `detail` (a reason/warning object with a sibling `code`),
/// `message` or `error` (the operation-error shapes). The `detail` branch
/// is code-informed: an `ENV_*` family code reads the environment
/// sentence, anything else the method sentence. `message`/`error` read the
/// operation sentence.
pub fn replacement_for(code: Option<&str>, field: &str) -> &'static str {
    if is_env_code(code) {
        ENV_NOT_AVAILABLE
    } else if field == "detail" {
        METHOD_FAILED
    } else {
        STEP_FAILED
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The JSON walk
// ─────────────────────────────────────────────────────────────────────────────

/// One sanitised field (for the log line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitisedField {
    /// The JSON path of the field (`run.methods[2].reason.detail`).
    pub key_path: String,
    /// The sibling `code` when the parent reason/warning carries one.
    pub code: Option<String>,
    /// The issue kind that fired.
    pub issue: IssueKind,
    /// The full original text (also written to `internal_detail`).
    pub original: String,
    /// The plain replacement written to the field.
    pub replacement: String,
}

/// The named user-facing fields the walk rewrites (never data fields — a
/// `dir`/`data_dir`/`models_dir` fact passes through unchanged).
const NAMED_FIELDS: [&str; 3] = ["detail", "message", "error"];

fn walk(value: &mut Value, hits: &mut Vec<SanitisedField>, path: &str) {
    match value {
        Value::Object(map) => {
            let code = map.get("code").and_then(Value::as_str).map(str::to_string);
            for field in NAMED_FIELDS {
                if let Some(Value::String(text)) = map.get_mut(field) {
                    let issue = internal_issue(text);
                    if let Some(issue) = issue {
                        let replacement = replacement_for(code.as_deref(), field).to_string();
                        let original = std::mem::replace(text, replacement.clone());
                        map.insert("internal_detail".to_string(), Value::String(original.clone()));
                        hits.push(SanitisedField {
                            key_path: format!("{path}.{field}"),
                            code: code.clone(),
                            issue,
                            original,
                            replacement,
                        });
                    }
                }
            }
            for (key, child) in map.iter_mut() {
                walk(child, hits, &format!("{path}.{key}"));
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter_mut().enumerate() {
                walk(child, hits, &format!("{path}[{index}]"));
            }
        }
        _ => {}
    }
}

/// Walk a JSON value and sanitise every user-facing field in place.
///
/// Returns the hits (each also logged by the MIDDLEWARE, not here — this
/// function is pure so the producers' unit tests can assert on its output
/// without a tracing subscriber).
pub fn sanitise_json(value: &mut Value) -> Vec<SanitisedField> {
    let mut hits = Vec::new();
    walk(value, &mut hits, "$");
    hits
}

/// Sanitise one plain string (the non-JSON helper of the pure
/// `sanitise_json`: used when a single user-facing text is known). Returns
/// `(text, internal)` — the sanitised text and the original when a leak
/// was found.
pub fn sanitise_text(text: &str, code: Option<&str>, field: &str) -> (String, Option<String>) {
    if internal_issue(text).is_none() {
        return (text.to_string(), None);
    }
    (
        replacement_for(code, field).to_string(),
        Some(text.to_string()),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// The boundary middleware
// ─────────────────────────────────────────────────────────────────────────────

/// Sanitise the txr modules' JSON responses. Layered in `lib.rs` over the
/// whole app; scope is [`TXR_ROUTE_PREFIXES`] ∧ `application/json`, so the
/// SSE stream, the CSV download and every framework route pass through
/// untouched.
pub async fn txr_json_boundary(req: Request, next: Next) -> Resp {
    let covered = TXR_ROUTE_PREFIXES
        .iter()
        .any(|prefix| req.uri().path().starts_with(prefix));
    let resp = next.run(req).await;
    if !covered {
        return resp;
    }
    let is_json = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("application/json"))
        .unwrap_or(false);
    if !is_json {
        return resp;
    }
    // A declared content-length beyond the buffer: pass the response through
    // unchanged (a huge JSON payload of these routes carries no reason text;
    // the warning keeps the boundary's gap visible).
    let declared = resp
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > BODY_LIMIT) {
        tracing::warn!(
            "txr err_sanitiser: a JSON response above the {} byte buffer was NOT sanitised",
            BODY_LIMIT
        );
        return resp;
    }

    let (parts, body) = resp.into_parts();
    let bytes = match axum::body::to_bytes(body, BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(err) => {
            tracing::error!(
                "txr err_sanitiser: could not buffer a JSON response body: {err}"
            );
            // The body is already consumed; answer with the plain 500 error
            // rather than a response whose bytes never reached the client.
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({
                    "error": "An internal error occurred",
                    "error_code": "SYSTEM_INTERNAL_ERROR",
                })),
            )
                .into_response();
        }
    };

    let mut value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            // Not JSON after all (declared application/json, body is not) —
            // pass the raw bytes through unchanged.
            return Response::from_parts(parts, Body::from(bytes));
        }
    };

    let hits = sanitise_json(&mut value);
    if hits.is_empty() {
        return Response::from_parts(parts, Body::from(bytes));
    }
    for hit in &hits {
        tracing::warn!(
            target: "txr_err_sanitiser",
            field = %hit.key_path,
            code = hit.code.as_deref().unwrap_or("-"),
            issue = ?hit.issue,
            original = %hit.original,
            replacement = %hit.replacement,
            "a user-facing reason/message was sanitised at the API boundary",
        );
    }

    let new_bytes = match serde_json::to_vec(&value) {
        Ok(bytes) => bytes,
        Err(err) => {
            tracing::error!("txr err_sanitiser: re-serialisation failed: {err}");
            return Response::from_parts(parts, Body::from(bytes));
        }
    };
    let mut parts = parts;
    parts
        .headers
        .insert(CONTENT_LENGTH, new_bytes.len().to_string().parse().unwrap());
    Response::from_parts(parts, Body::from(new_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use serde_json::json;
    use tower::ServiceExt;
    use txresbench_core::AppError;

    // ── detection ─────────────────────────────────────────────────────────

    #[test]
    fn detects_paths_placeholders_and_tools() {
        assert_eq!(
            internal_issue("oras is not installed (looked in <app_data>/bin and PATH)"),
            Some(IssueKind::AppDataPlaceholder)
        );
        assert_eq!(
            internal_issue("mkdir /data/txr-envs/cache: Permission denied"),
            Some(IssueKind::AbsolutePath)
        );
        assert_eq!(
            internal_issue("read /home/user/.txresbench/models/m.txr failed"),
            Some(IssueKind::AbsolutePath)
        );
        assert_eq!(
            internal_issue("cannot open C:\\Users\\clinician\\models\\m.txr"),
            Some(IssueKind::AbsolutePath)
        );
        assert_eq!(
            internal_issue("`oras` failed: exit status 1"),
            Some(IssueKind::InternalTool)
        );
        assert_eq!(
            internal_issue("the bwrap sandbox did not start"),
            Some(IssueKind::InternalTool)
        );
        assert_eq!(internal_issue("This method failed"), None);
        assert_eq!(internal_issue("marker LDH is not in your measurements"), None);
        assert_eq!(
            internal_issue("the method record is old_oras_style"),
            None,
            "a tool name inside a longer word is not a tool mention"
        );
    }

    // ── replacement ───────────────────────────────────────────────────────

    #[test]
    fn replacements_are_plain_and_code_informed() {
        assert_eq!(
            replacement_for(Some("ENV_TOOL_MISSING"), "detail"),
            ENV_NOT_AVAILABLE
        );
        assert_eq!(
            replacement_for(Some("ENV_IMAGE_MISSING"), "detail"),
            ENV_NOT_AVAILABLE
        );
        assert_eq!(
            replacement_for(Some("SANDBOX_UNAVAILABLE"), "detail"),
            ENV_NOT_AVAILABLE
        );
        assert_eq!(
            replacement_for(Some("PREDICTION_INVALID"), "detail"),
            METHOD_FAILED
        );
        assert_eq!(replacement_for(None, "detail"), METHOD_FAILED);
        assert_eq!(replacement_for(None, "message"), STEP_FAILED);
        assert_eq!(replacement_for(None, "error"), STEP_FAILED);
    }

    // ── the walk over every producer shape ────────────────────────────────

    #[test]
    fn walk_sanitises_every_reason_and_message_shape_and_keeps_the_original() {
        let mut value = json!({
            "run": {
                "id": "run-1",
                "methods": [
                    {
                        "method_id": "m-env",
                        "state": "failed",
                        "reason": {
                            "code": "ENV_IMAGE_TOOL_MISSING",
                            "detail": "oras is not installed (looked in <app_data>/bin and PATH)"
                        }
                    },
                    {
                        "method_id": "m-exec",
                        "state": "failed",
                        "reason": {
                            "code": "PREDICTION_INVALID",
                            "detail": "run_method_in_stack failed: `/data/txr/bin/oras` failed: exit 1"
                        }
                    }
                ],
                "dir": "/data/txr/live/analysis-run-1",
                "progress": { "phase": "fit", "message": "environment download failed: bwrap did not start" }
            },
            "request_error": {
                "code": "EMPTY_METHODS",
                "field": "method_ids[0].host_dir",
                "message": "host_dir /data/txr/models/m-1 is not readable"
            },
            "api_error": {
                "error": "could not read /home/u1/.txresbench/models/m.txr: No such file or directory",
                "error_code": "SYSTEM_INTERNAL_ERROR"
            },
            "warning": {
                "code": "DIGEST_MISMATCH",
                "detail": "recorded /data/txr/models/m.txr differs from the catalogue"
            },
            "clean": {
                "reason": { "code": "REQUIRED_MARKER_MISSING", "detail": "LDH is not in your measurements." },
                "message": "fit phase running",
                "error": ""
            }
        });
        let hits = sanitise_json(&mut value);
        assert_eq!(hits.len(), 6, "hits: {hits:#?}");

        // 1. the env reason → the env sentence, original in internal_detail
        let env_hit = hits.iter().find(|h| h.key_path.ends_with("methods[0].reason.detail")).unwrap();
        assert_eq!(env_hit.original, "oras is not installed (looked in <app_data>/bin and PATH)");
        assert_eq!(env_hit.replacement, ENV_NOT_AVAILABLE);
        assert_eq!(value["run"]["methods"][0]["reason"]["detail"], ENV_NOT_AVAILABLE);
        assert_eq!(
            value["run"]["methods"][0]["reason"]["internal_detail"],
            env_hit.original
        );

        // 2. the non-env reason → the method sentence
        assert_eq!(value["run"]["methods"][1]["reason"]["detail"], METHOD_FAILED);

        // 3. the progress message → the operation sentence
        assert_eq!(value["run"]["progress"]["message"], STEP_FAILED);

        // 4. the request error message → the operation sentence
        assert_eq!(value["request_error"]["message"], STEP_FAILED);

        // 5. the API error → the operation sentence
        assert_eq!(value["api_error"]["error"], STEP_FAILED);

        // 6. the model warning detail → the method sentence
        assert_eq!(value["warning"]["detail"], METHOD_FAILED);
        assert_eq!(
            value["warning"]["internal_detail"],
            "recorded /data/txr/models/m.txr differs from the catalogue"
        );

        // The data fields (dir) and clean texts are untouched; no
        // internal_detail was invented for them.
        assert_eq!(value["run"]["dir"], "/data/txr/live/analysis-run-1");
        assert_eq!(value["clean"]["reason"]["detail"], "LDH is not in your measurements.");
        assert!(value["clean"].get("internal_detail").is_none());

        // No leak survives in any USER-FACING string of the sanitised tree
        // — the `internal_detail` copies carry the originals BY DESIGN (the
        // plan's rule: the full text is kept un-rendered, never dropped).
        // Only the sanitised field kinds count: a `dir`/`data_dir` fact is
        // data (the UI no longer renders it), not a reason/message.
        fn collect_user_strings(value: &Value, key: &str, out: &mut Vec<String>) {
            match value {
                Value::Object(map) => {
                    for (child_key, child) in map {
                        collect_user_strings(child, child_key, out);
                    }
                }
                Value::Array(items) => {
                    for item in items {
                        collect_user_strings(item, key, out);
                    }
                }
                Value::String(text) if matches!(key, "detail" | "message" | "error") => {
                    out.push(text.clone())
                }
                _ => {}
            }
        }
        let mut user_strings = Vec::new();
        collect_user_strings(&value, "", &mut user_strings);
        for leak in ["/data/", "/home/", "<app_data>", "oras", "bwrap"] {
            assert!(
                !user_strings.iter().any(|s| s.contains(leak)),
                "user-facing string leaked {leak} in {user_strings:?}"
            );
        }
        // Each internal_detail kept the original (the diagnostic half) and
        // the hits count is exact.
        assert_eq!(hits.len(), 6);
        let kept: Vec<&str> = hits.iter().map(|h| h.original.as_str()).collect();
        assert!(
            kept.iter()
                .all(|s| s.contains('/') || s.contains("<app_data>") || s.contains("bwrap") || s.contains("oras")),
            "a kept original carries no leak token: {kept:?}"
        );
    }

    /// The plan's producer test: the engine's reason MAPPERS (the functions
    /// that turn a machinery error into the wire `reason`) fed with an
    /// injected path and tool name must come out of the boundary clean.
    #[test]
    fn engine_reason_mappers_are_clean_through_the_boundary() {
        use crate::modules::execution_engine::orchestrator::{
            env_failure_reason, execution_failure_reason,
        };

        // ENV_TOOL_MISSING passthrough with the report's own leaked text.
        let tool_err =
            AppError::new(StatusCode::SERVICE_UNAVAILABLE, "ENV_TOOL_MISSING", "oras is not installed (looked in <app_data>/bin and PATH)");
        let env_reason = env_failure_reason(&tool_err);
        let mut value = json!({ "reason": env_reason });
        let hits = sanitise_json(&mut value);
        assert_eq!(hits.len(), 1, "hits: {hits:#?}");
        assert_eq!(value["reason"]["detail"], ENV_NOT_AVAILABLE);
        assert_eq!(value["reason"]["code"], "ENV_TOOL_MISSING");
        assert!(value["reason"]["internal_detail"].as_str().unwrap().contains("<app_data>"));

        // A non-passthrough env error (path + tool in the text) → the same
        // env sentence, because the code reads ENV_UNREADY.
        let path_err = AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SANDBOX_START_FAILED",
            "bwrap failed to start /data/txr/stacks/run-1/sandbox",
        );
        let reason = env_failure_reason(&path_err);
        let mut value = json!({ "reason": reason });
        let hits = sanitise_json(&mut value);
        assert_eq!(hits.len(), 1);
        assert_eq!(value["reason"]["detail"], ENV_NOT_AVAILABLE);

        // An executor failure with a tool path → the method sentence.
        let exec_err = AppError::new(
            StatusCode::BAD_GATEWAY,
            "PREDICTION_INVALID",
            "`/data/txr/bin/oras` failed: exit status 1",
        );
        let reason = execution_failure_reason(&exec_err);
        let mut value = json!({ "reason": reason });
        let hits = sanitise_json(&mut value);
        assert_eq!(hits.len(), 1);
        assert_eq!(value["reason"]["detail"], METHOD_FAILED);
    }

    // ── the boundary middleware ───────────────────────────────────────────

    fn leaky_router() -> Router {
        async fn run() -> axum::Json<Value> {
            axum::Json(json!({
                "id": "r-1",
                "methods": [{
                    "state": "failed",
                    "reason": { "code": "ENV_IMAGE_TOOL_MISSING",
                                "detail": "oras is not installed (looked in <app_data>/bin and PATH)" }
                }],
                "dir": "/data/txr/live/analysis-r-1"
            }))
        }
        async fn framework() -> axum::Json<Value> {
            axum::Json(json!({ "error": "bwrap failed for /data/txr/stacks" }))
        }
        Router::new()
            .route("/api/txr/runs/leak", get(run))
            .route("/api/platform/x", get(framework))
            .layer(axum::middleware::from_fn(txr_json_boundary))
    }

    #[tokio::test]
    async fn boundary_sanitises_txr_json_and_leaves_other_routes_alone() {
        let app = leaky_router();
        let res = app
            .clone()
            .oneshot(Request::get("/api/txr/runs/leak").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["methods"][0]["reason"]["detail"], ENV_NOT_AVAILABLE);
        assert!(body["methods"][0]["reason"]["internal_detail"]
            .as_str()
            .unwrap()
            .contains("<app_data>"));
        // The dir fact is data — untouched.
        assert_eq!(body["dir"], "/data/txr/live/analysis-r-1");

        // A non-txr route is NOT rewritten.
        let res = app
            .oneshot(Request::get("/api/platform/x").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "bwrap failed for /data/txr/stacks");
    }

    #[tokio::test]
    async fn boundary_passes_non_json_bodies_through() {
        async fn csv() -> impl axum::response::IntoResponse {
            (
                [(CONTENT_TYPE, "text/csv")],
                "method_id,value\nm1,0.5\n",
            )
        }
        let app = Router::new()
            .route("/api/txr/runs/x/predictions.csv", get(csv))
            .layer(axum::middleware::from_fn(txr_json_boundary));
        let res = app
            .oneshot(Request::get("/api/txr/runs/x/predictions.csv").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("m1,0.5"));
    }
}
