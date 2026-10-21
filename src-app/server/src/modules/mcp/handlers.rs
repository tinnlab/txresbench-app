//! JSON-RPC handler for `POST /api/mcp`. Gated on `mcp::use`
//! ([`RequirePermissions`]). Three tools (from the SDK's
//! `ziee_control_mcp::tools::tool_list()`): `list_capabilities` /
//! `describe_capability` / `invoke_capability`, dispatched over the MERGE of
//! two capability catalogs:
//! - the REST/OpenAPI catalog (`ziee_control_mcp::catalog`), ported verbatim
//!   from ziee's `modules/control_mcp` — `invoke_capability` of a REST op
//!   dispatches to the real route over loopback, forwarding the caller's JWT
//!   so the target route's own `RequirePermissions` re-authorizes from the DB
//!   (no authz reimplemented here);
//! - the frontend-action catalog ([`frontend_catalog`]) — `invoke_capability`
//!   of a frontend action checks `principal_holds` against the manifest's
//!   declared permission BEFORE relay, then dispatches over the
//!   [`agent_channel`] to the user's controlled browser session.
//!
//! CONTRACT.md: "All errors [from a frontend-action invoke] surface as the
//! MCP tool result `isError`" — so `NOT_PERMITTED` /
//! `FRONTEND_NOT_CONNECTED` / `FRONTEND_RELOADED` / `FRONTEND_UNRESPONSIVE`
//! are returned as `Ok(<isError tool result>)`, never a JSON-RPC-level error.
//! REST-kind failures keep ziee `control_mcp`'s original behavior (an unknown
//! or forbidden `operation_id` is a JSON-RPC-level error; an HTTP-level
//! failure from the dispatched route is an `isError` tool result) — this
//! module was NOT asked to change that half, only to add the frontend one.

use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use axum::{
    debug_handler,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use ziee_auth::{Group, User};
use ziee_control_mcp::catalog::{self, ControlCatalog, Operation};
use ziee_control_mcp::{policy, tools};
use ziee_core::AppError;
use ziee_framework::mcp::{JsonRpcError, JsonRpcRequest, JsonRpcResponse};

use crate::modules::permissions::{principal_holds, RequirePermissions};

use super::agent_channel::{self, DispatchError};
use super::frontend_catalog::{self, FrontendActionCatalog, FrontendActionEntry};
use super::permissions::McpUse;

// The REST-invoke result-byte ceiling (`MAX_RESULT_BYTES`, 1 MiB — a footgun/OOM
// guard on the body relayed back to the model) and the `list_capabilities`
// truncation cap (`MAX_LIST_RESULTS`, 200) used to be bare consts here. They are
// now the admin settings `max_result_bytes` / `max_list_results` (issue #54),
// read-at-use via `settings_cache::snapshot()`. The settings defaults EQUAL the old
// consts (byte-preserving, INV-1); `max_result_bytes` is SAFETY-BOUNDED (DEC-3):
// admin-tunable only within a bounded range, never raised unbounded.

/// The loopback base URL (`http://127.0.0.1:<port>`) the REST-kind invoke
/// dispatch targets, and the base the pairing `mcp_url` is built from. Set
/// once at module init (`mod.rs::init`), never model/operator-supplied.
static MCP_BASE_URL: OnceLock<String> = OnceLock::new();

pub fn set_base_url(base: String) {
    let _ = MCP_BASE_URL.set(base);
}

/// `pairing.rs`'s `pair_start` reads this to build `mcp_url`.
pub(super) fn base_url() -> Option<&'static str> {
    MCP_BASE_URL.get().map(String::as_str)
}

/// One shared client for the loopback dispatch (mirrors ziee `control_mcp`).
/// Loopback only, but still bounded + no redirects.
static HTTP_CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            tracing::error!(error = %e, "mcp: failed to build loopback HTTP client");
        })
        .ok()
});

#[debug_handler]
pub async fn jsonrpc_handler(
    auth: RequirePermissions<(McpUse,)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let req: JsonRpcRequest = match serde_json::from_slice::<Value>(&body)
        .map_err(|e| JsonRpcError::parse_error(e.to_string()))
        .and_then(|raw| {
            serde_json::from_value(raw).map_err(|e| JsonRpcError::invalid_request(e.to_string()))
        }) {
        Ok(r) => r,
        Err(err) => return error_response(None, StatusCode::BAD_REQUEST, err),
    };

    // Notifications (no id) are intentionally ACKed without dispatch, per
    // JSON-RPC 2.0 (a notification has no response by definition) — matches
    // the ziee reference `control_mcp` handler. None of our methods have a
    // side effect that a notification-form call would need to trigger, so
    // there's nothing to lose by not processing the body.
    if req.id.is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = req.id.clone();

    match req.method.as_str() {
        "initialize" => ok_response(
            id,
            json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "cytoanalyst-mcp", "version": env!("CARGO_PKG_VERSION") },
            }),
        ),
        "tools/list" => ok_response(id, tools::tool_list()),
        "ping" => ok_response(id, json!({})),
        "tools/call" => {
            let call: ToolCallParams = match serde_json::from_value(req.params.clone()) {
                Ok(c) => c,
                Err(e) => {
                    return error_response(
                        id,
                        StatusCode::OK,
                        JsonRpcError::invalid_params(format!("tools/call params: {e}")),
                    );
                }
            };
            let control = catalog::catalog();
            // Held for the whole dispatch: the frontend catalog is a snapshot
            // `Arc` built for THIS caller (its app-owned half plus whatever its
            // own controlled session reported), so one request sees ONE
            // consistent capability set even if the browser re-reports or
            // disconnects mid-flight.
            let frontend_snapshot = frontend_catalog::catalog_for(auth.user.id);
            let frontend = frontend_snapshot.as_deref();
            let result = match call.name.as_str() {
                tools::LIST_CAPABILITIES => {
                    list_capabilities(&auth.user, &auth.groups, control, frontend, &call.arguments)
                }
                tools::DESCRIBE_CAPABILITY => describe_capability(
                    &auth.user,
                    &auth.groups,
                    control,
                    frontend,
                    &call.arguments,
                ),
                tools::INVOKE_CAPABILITY => {
                    invoke_capability(
                        &auth.user,
                        &auth.groups,
                        control,
                        frontend,
                        &headers,
                        &call.arguments,
                    )
                    .await
                }
                other => Err(AppError::bad_request(
                    "UNKNOWN_TOOL",
                    format!("mcp tool: {other}"),
                )),
            };
            match result {
                Ok(value) => ok_response(id, value),
                Err(e) => error_response(id, StatusCode::OK, JsonRpcError::from_app_error(&e)),
            }
        }
        _ => error_response(
            id,
            StatusCode::OK,
            JsonRpcError::method_not_found(&req.method),
        ),
    }
}

#[derive(Debug, Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

// ── REST-catalog permission filter (mirrors ziee control_mcp) ───────────────

/// An op is offered to the model only when it is not policy-denied AND the
/// user is permitted to run it. `principal_holds` already short-circuits
/// admins, so unlike ziee's `control_mcp` there's no separate `user_may_run`.
fn op_available(user: &User, groups: &[Group], op: &Operation) -> bool {
    if policy::is_denied(op) {
        return false;
    }
    // ALL-of semantics. An operation may require SEVERAL permissions, and
    // holding only the first is not authorization — `required_permission` is
    // the display-only first entry (the SDK's `Operation` docs say so
    // outright), so gating on it under-gates every multi-permission route.
    //
    // Fall back to the singular field only when the list is empty, so a
    // catalog built before the list was populated still gates. Both empty →
    // the route declares no permission (rare: health, login).
    let mut required: Vec<&str> = op.required_permissions.iter().map(String::as_str).collect();
    if required.is_empty() {
        if let Some(perm) = op.required_permission.as_deref() {
            required.push(perm);
        }
    }
    required
        .iter()
        .all(|perm| principal_holds(user, groups, perm))
}

// ── list_capabilities ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
struct ListArgs {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    tag: Option<String>,
}

fn list_capabilities(
    user: &User,
    groups: &[Group],
    control: Option<&ControlCatalog>,
    frontend: Option<&FrontendActionCatalog>,
    args: &Value,
) -> Result<Value, AppError> {
    let args: ListArgs = serde_json::from_value(args.clone()).unwrap_or_default();
    let query = args.query.as_deref().map(str::to_lowercase);
    let tag = args.tag.as_deref();

    let mut items: Vec<Value> = Vec::new();

    if let Some(catalog) = control {
        let mut matched: Vec<&Operation> = catalog
            .iter()
            .filter(|op| op_available(user, groups, op))
            .filter(|op| {
                tag.map(|t| op.tags.iter().any(|opt| opt.eq_ignore_ascii_case(t)))
                    .unwrap_or(true)
            })
            .filter(|op| {
                query
                    .as_deref()
                    .map(|q| {
                        op.operation_id.to_lowercase().contains(q)
                            || op.summary.to_lowercase().contains(q)
                            || op.tags.iter().any(|t| t.to_lowercase().contains(q))
                    })
                    .unwrap_or(true)
            })
            .collect();
        matched.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        for op in matched {
            items.push(json!({
                "operation_id": op.operation_id,
                "kind": "rest",
                "method": op.method,
                "summary": op.summary,
                "required_permission": op.required_permission,
                "mutating": policy::is_mutating(&op.method),
            }));
        }
    }

    if let Some(catalog) = frontend {
        // Frontend actions have no `tags`; an explicit `tag` filter excludes
        // them all (they never match a REST tag, so this is a filter, not a
        // special case).
        if tag.is_none() {
            let mut matched: Vec<&FrontendActionEntry> = catalog
                .iter()
                .filter(|a| principal_holds(user, groups, &a.permission))
                .filter(|a| {
                    query
                        .as_deref()
                        // richer-actions ITEM-4: match on the id/title AND the
                        // discoverability metadata (group/aliases/keywords/
                        // description) so the agent can find an action by intent.
                        .map(|q| a.matches_query(q))
                        .unwrap_or(true)
                })
                .collect();
            matched.sort_by(|a, b| a.id.cmp(&b.id));
            for a in matched {
                items.push(json!({
                    "operation_id": a.id,
                    "kind": "frontend",
                    "method": Value::Null,
                    "summary": a.title,
                    // richer-actions ITEM-4: surface the description so the agent
                    // sees what the action does at list time (null when absent).
                    "description": a.description,
                    "required_permission": a.permission,
                    "mutating": a.mutating,
                }));
            }
        }
    }

    // Read-at-use (issue #54): admin-tunable `max_list_results`, compiled default 200.
    let max_list = super::settings_cache::snapshot().max_list_results_usize();
    let total = items.len();
    let truncated = total > max_list;
    items.truncate(max_list);

    let structured = json!({
        "operations": items,
        "returned": items.len(),
        "total": total,
        "truncated": truncated,
    });
    let mut text = format!(
        "{} operation(s) you can run{}:\n",
        total,
        if truncated {
            format!(" (showing first {max_list})")
        } else {
            String::new()
        }
    );
    for op in &items {
        text.push_str(&format!(
            "- {} [{}/{}] — {}\n",
            op["operation_id"].as_str().unwrap_or(""),
            op["kind"].as_str().unwrap_or(""),
            op["method"].as_str().unwrap_or("-"),
            op["summary"].as_str().unwrap_or("")
        ));
    }
    Ok(text_result(text, Some(structured)))
}

// ── describe_capability ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct DescribeArgs {
    operation_id: String,
}

fn describe_capability(
    user: &User,
    groups: &[Group],
    control: Option<&ControlCatalog>,
    frontend: Option<&FrontendActionCatalog>,
    args: &Value,
) -> Result<Value, AppError> {
    let args: DescribeArgs = serde_json::from_value(args.clone())
        .map_err(|e| AppError::bad_request("INVALID_PARAMS", format!("describe args: {e}")))?;

    if let Some(catalog) = control {
        if let Some(op) = catalog.get(&args.operation_id) {
            if op_available(user, groups, op) {
                let structured = json!({
                    "operation_id": op.operation_id,
                    "kind": "rest",
                    "method": op.method,
                    "path_template": op.path_template,
                    "required_permission": op.required_permission,
                    "mutating": policy::is_mutating(&op.method),
                    "path_params": op.path_params,
                    "parameters": op.parameters,
                    "request_schema": op.request_schema,
                    "summary": op.summary,
                });
                let text = serde_json::to_string_pretty(&structured).unwrap_or_default();
                return Ok(text_result(text, Some(structured)));
            }
        }
    }

    if let Some(catalog) = frontend {
        if let Some(entry) = catalog.get(&args.operation_id) {
            if principal_holds(user, groups, &entry.permission) {
                let mut structured = json!({
                    "operation_id": entry.id,
                    "kind": "frontend",
                    // `entry.kind` ("global"/"instance") under a DISTINCT key —
                    // "kind" above is the top-level rest-vs-frontend
                    // discriminator, not the action's own global/instance kind.
                    "frontend_kind": entry.kind,
                    "title": entry.title,
                    "required_permission": entry.permission,
                    "mutating": entry.mutating,
                    "stateful": entry.stateful,
                    // W1 context gating (workbench-analysis PLAN.md ITEM-4):
                    // surface the action's CONTEXT precondition so the agent
                    // knows WHERE it must be before invoking. `"global"` = always
                    // available; any other value names the active-context the
                    // engine's `CONTEXT_INACTIVE` guard requires. The ENGINE
                    // enforces the guard (this handler only ADVERTISES it — same
                    // Layer 5/6 split as `stateful`: the backend never judges
                    // context, it relays the engine's verdict on invoke).
                    "context": entry.context,
                    // richer-actions ITEM-4: surface the discoverability metadata
                    // so the agent can understand + pick the action by intent
                    // (group/description shown; aliases are alternative names it
                    // may have searched by). Null/empty when the action omits them.
                    "group": entry.group,
                    "description": entry.description,
                    "aliases": entry.aliases,
                    "params_schema": entry.params_schema,
                });
                if entry.context != "global" {
                    // A non-global action is a PRECONDITION: the named context
                    // must be active first, else invoke relays `CONTEXT_INACTIVE`.
                    structured["context_required"] = json!(true);
                }
                if entry.kind == "instance" {
                    // ai-actions slice 3 (PLAN.md ITEM-8): an instance
                    // action's describe reports its `view_id` input is
                    // always required, and `expected_token` is required
                    // exactly when the action is mutating+stateful
                    // (ARCHITECTURE.md Layer 6).
                    structured["view_id_required"] = json!(true);
                    structured["expected_token_required"] = json!(entry.mutating && entry.stateful);
                }
                let text = serde_json::to_string_pretty(&structured).unwrap_or_default();
                return Ok(text_result(text, Some(structured)));
            }
        }
    }

    Err(AppError::forbidden(
        "NOT_PERMITTED",
        format!("operation '{}' is not available to you", args.operation_id),
    ))
}

// ── invoke_capability ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
struct InvokeArgs {
    operation_id: String,
    #[serde(default)]
    path_params: std::collections::HashMap<String, String>,
    #[serde(default)]
    query: Option<Value>,
    #[serde(default)]
    body: Option<Value>,
}

async fn invoke_capability(
    user: &User,
    groups: &[Group],
    control: Option<&ControlCatalog>,
    frontend: Option<&FrontendActionCatalog>,
    headers: &HeaderMap,
    args: &Value,
) -> Result<Value, AppError> {
    let args: InvokeArgs = serde_json::from_value(args.clone())
        .map_err(|e| AppError::bad_request("INVALID_PARAMS", format!("invoke args: {e}")))?;

    if let Some(catalog) = control {
        if let Some(op) = catalog.get(&args.operation_id) {
            if !op_available(user, groups, op) {
                return Err(AppError::forbidden(
                    "NOT_PERMITTED",
                    format!("operation '{}' is not available to you", args.operation_id),
                ));
            }
            return invoke_rest(op, catalog, headers, &args).await;
        }
    }

    if let Some(catalog) = frontend {
        if let Some(entry) = catalog.get(&args.operation_id) {
            return Ok(invoke_frontend(user, groups, entry, &args).await);
        }
    }

    Err(AppError::forbidden(
        "NOT_PERMITTED",
        format!("operation '{}' is not available to you", args.operation_id),
    ))
}

/// REST-kind dispatch: real REST route over loopback, forwarding the caller's
/// bearer so the target route's own `RequirePermissions` re-authorizes from
/// the DB. Ported near-verbatim from ziee `modules/control_mcp::handlers`.
async fn invoke_rest(
    op: &Operation,
    catalog: &ControlCatalog,
    headers: &HeaderMap,
    args: &InvokeArgs,
) -> Result<Value, AppError> {
    if let (Some(schema), Some(body)) = (&op.request_schema, &args.body) {
        if let Err(msg) = validate_body(schema, body, catalog.components()) {
            return Err(AppError::bad_request("INVALID_BODY", msg));
        }
    }

    let path = substitute_path(&op.path_template, &op.path_params, &args.path_params)?;

    let base =
        base_url().ok_or_else(|| AppError::internal_error("mcp base url not initialized"))?;
    let mut url = reqwest::Url::parse(&format!("{base}{path}"))
        .map_err(|e| AppError::internal_with_id(format!("parse loopback url: {e}")))?;

    if let Some(Value::Object(q)) = &args.query {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in q {
            let vs = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            pairs.append_pair(k, &vs);
        }
    }

    let method = reqwest::Method::from_bytes(op.method.as_bytes())
        .map_err(|e| AppError::internal_with_id(format!("parse method: {e}")))?;
    let client = HTTP_CLIENT
        .as_ref()
        .ok_or_else(|| AppError::internal_error("mcp loopback client unavailable"))?;
    let mut request = client.request(method, url);

    // Forward the caller's bearer so the real route re-authorizes as this
    // user. NOTE: we intentionally do NOT forward `x-sync-connection-id` — an
    // AI-driven mutation SHOULD reach the acting user's other open devices
    // (co-drive via sync, ARCHITECTURE.md).
    if let Some(auth_header) = headers
        .get("authorization")
        .or_else(|| headers.get("Authorization"))
    {
        request = request.header(reqwest::header::AUTHORIZATION, auth_header);
    }
    if let Some(body) = &args.body {
        request = request.json(body);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| AppError::internal_with_id(format!("loopback dispatch: {e}")))?;

    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::internal_with_id(format!("read loopback response: {e}")))?;

    // Read-at-use (issue #54): admin-tunable `max_result_bytes`, compiled default 1 MiB.
    let max_bytes = super::settings_cache::snapshot().max_result_bytes_usize();
    let (text_body, truncated) = if bytes.len() > max_bytes {
        (
            String::from_utf8_lossy(&bytes[..max_bytes]).to_string(),
            true,
        )
    } else {
        (String::from_utf8_lossy(&bytes).to_string(), false)
    };
    let parsed: Option<Value> = serde_json::from_str(&text_body).ok();

    let is_error = !status.is_success();
    let structured = json!({
        "operation_id": op.operation_id,
        "kind": "rest",
        "status": status.as_u16(),
        "ok": status.is_success(),
        "truncated": truncated,
        "response": parsed.clone().unwrap_or(Value::Null),
    });
    let summary = if is_error {
        format!(
            "{} {} → HTTP {} (error). Response:\n{}",
            op.method, op.path_template, status, text_body
        )
    } else {
        format!(
            "{} {} → HTTP {} (ok). Response:\n{}",
            op.method, op.path_template, status, text_body
        )
    };

    let mut result = text_result(summary, Some(structured));
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    Ok(result)
}

/// Frontend-kind dispatch. Per CONTRACT.md every outcome here — including
/// `NOT_PERMITTED`, checked BEFORE relay — surfaces as an `isError` MCP tool
/// result, never a JSON-RPC-level error (this fn always returns `Ok`).
async fn invoke_frontend(
    user: &User,
    groups: &[Group],
    entry: &FrontendActionEntry,
    args: &InvokeArgs,
) -> Value {
    if !principal_holds(user, groups, &entry.permission) {
        return frontend_error_result(
            entry,
            "NOT_PERMITTED",
            "you do not have permission to run this action",
        );
    }

    let params = args.body.clone().unwrap_or_else(|| json!({}));
    if let Err(msg) = validate_body(&entry.params_schema, &params, &Value::Null) {
        return frontend_error_result(entry, "INVALID_PARAMS", &msg);
    }

    // ai-actions slice 3 (PLAN.md ITEM-8): a `kind == "instance"` action
    // addresses a runtime `view_id` — extract it (+ `expected`, the
    // read-before-write guard's claimed token) from the ALREADY-VALIDATED
    // body and thread both through to the agent channel as distinct
    // `DownFrame::AgentInvoke` fields, alongside the full `params` (which
    // already contains them too — the engine's stale-token guard reads the
    // dedicated fields for clarity/testability rather than reaching back
    // into `params`).
    //
    // `validate_body` only checks required-presence + additionalProperties,
    // NOT JSON-Schema `type` — so a caller sending `{"view_id": 123}` (or
    // omitting it despite the manifest's `view_id_required: true`) would
    // otherwise pass validation and silently coerce to `None` here, which
    // would either dispatch to the wrong (unaddressed) instance or panic
    // downstream. For `kind == "instance"` we therefore REQUIRE `view_id`
    // to be present AND a string, hard-failing with a clear isError instead
    // of silently dropping it. `expected`, when present, must also be a
    // string (a non-string `expected` is likewise rejected rather than
    // silently ignored); its ABSENCE is still fine — that's the engine's
    // `READ_REQUIRED` call (Layer 5/6 split: permission = backend-enforced
    // trust, staleness = engine-enforced correctness).
    let (view_id, expected_token) = if entry.kind == "instance" {
        let view_id = match params.get("view_id") {
            None => {
                return frontend_error_result(
                    entry,
                    "MISSING_VIEW_ID",
                    "this instance action requires 'view_id' identifying the target instance",
                );
            }
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                return frontend_error_result(
                    entry,
                    "INVALID_VIEW_ID",
                    "'view_id' must be a string",
                );
            }
        };
        let expected_token = match params.get("expected") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                return frontend_error_result(
                    entry,
                    "INVALID_EXPECTED",
                    "'expected' must be a string when present",
                );
            }
        };
        (Some(view_id), expected_token)
    } else {
        (None, None)
    };

    match agent_channel::dispatch(user.id, &entry.id, params, view_id, expected_token).await {
        Ok(frame) => frontend_success_result(entry, frame),
        Err(DispatchError::NotConnected) => frontend_error_result(
            entry,
            "FRONTEND_NOT_CONNECTED",
            "no controlled TxResBench window is currently connected; ask the user to open TxResBench and reconnect",
        ),
        Err(DispatchError::Reloaded) => frontend_error_result(
            entry,
            "FRONTEND_RELOADED",
            "the controlled window reloaded mid-action; re-read current state before retrying",
        ),
        Err(DispatchError::Unresponsive) => {
            frontend_error_result(entry, "FRONTEND_UNRESPONSIVE", "the controlled window stopped responding")
        }
        Err(DispatchError::TooManyInflight) => frontend_error_result(
            entry,
            "TOO_MANY_INFLIGHT",
            "too many frontend actions are already in flight for this session; wait for one to finish before invoking another",
        ),
    }
}

fn frontend_error_result(entry: &FrontendActionEntry, code: &str, message: &str) -> Value {
    let structured = json!({
        "operation_id": entry.id,
        "kind": "frontend",
        "ok": false,
        "error_code": code,
        "error": message,
    });
    let mut result = text_result(format!("{code}: {message}"), Some(structured));
    result["isError"] = Value::Bool(true);
    result
}

fn frontend_success_result(
    entry: &FrontendActionEntry,
    frame: agent_channel::AgentResultFrame,
) -> Value {
    let structured = json!({
        "operation_id": entry.id,
        "kind": "frontend",
        "ok": frame.ok,
        "result": frame.result.clone().unwrap_or(Value::Null),
        "error": frame.error,
        "logs": frame.logs,
    });
    let mut text = if frame.ok {
        format!("{} → ok.", entry.id)
    } else {
        format!(
            "{} → error: {}",
            entry.id,
            frame.error.clone().unwrap_or_default()
        )
    };
    if !frame.logs.is_empty() {
        text.push_str("\nlogs:\n");
        for l in &frame.logs {
            text.push_str(&format!("- {l}\n"));
        }
    }
    let mut result = text_result(text, Some(structured));
    if !frame.ok {
        result["isError"] = Value::Bool(true);
    }
    result
}

// ── shared helpers (ported from ziee control_mcp) ────────────────────────────

/// Substitute `{name}` path params. Each value must be present and contain
/// only URL-path-safe characters (blocks path traversal + host injection).
fn substitute_path(
    template: &str,
    expected: &[String],
    provided: &std::collections::HashMap<String, String>,
) -> Result<String, AppError> {
    let mut path = template.to_string();
    for name in expected {
        let value = provided.get(name).ok_or_else(|| {
            AppError::bad_request(
                "MISSING_PATH_PARAM",
                format!("path parameter '{name}' is required"),
            )
        })?;
        if value.is_empty() || value == "." || value == ".." || !value.chars().all(is_path_safe) {
            return Err(AppError::bad_request(
                "INVALID_PATH_PARAM",
                format!("path parameter '{name}' is empty or contains disallowed characters"),
            ));
        }
        path = path.replace(&format!("{{{name}}}"), value);
    }
    Ok(path)
}

fn is_path_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~')
}

/// Deterministic, shallow body validation: `required` fields present + (when
/// `additionalProperties: false`) no unknown keys. Used for BOTH REST bodies
/// (with `components` for `$ref` resolution) and frontend `params_schema`
/// (self-contained, `components` is `Value::Null`).
fn validate_body(schema: &Value, body: &Value, components: &Value) -> Result<(), String> {
    let resolved = resolve_schema_ref(schema, components);
    let Some(obj) = resolved.as_object() else {
        return Ok(());
    };
    if obj.get("type").and_then(|t| t.as_str()) != Some("object") {
        return Ok(());
    }
    let body_obj = match body {
        Value::Object(m) => m,
        Value::Null => return Ok(()),
        _ => return Err("request body must be a JSON object".to_string()),
    };

    if let Some(required) = obj.get("required").and_then(|r| r.as_array()) {
        for field in required.iter().filter_map(|f| f.as_str()) {
            if !body_obj.contains_key(field) {
                return Err(format!("missing required field '{field}'"));
            }
        }
    }
    if obj.get("additionalProperties") != Some(&Value::Bool(false)) {
        return Ok(());
    }
    if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
        if let Some(key) = body_obj.keys().find(|k| !props.contains_key(*k)) {
            return Err(format!("unknown field '{key}'"));
        }
    }
    Ok(())
}

/// Follow a single top-level `$ref: #/components/schemas/Name` into shared
/// components. A no-op when `components` has no such schema (e.g. `Value::Null`
/// for frontend-action schemas, which never use `$ref`).
fn resolve_schema_ref(schema: &Value, components: &Value) -> Value {
    let Some(reference) = schema.get("$ref").and_then(|r| r.as_str()) else {
        return schema.clone();
    };
    let Some(name) = reference.strip_prefix("#/components/schemas/") else {
        return schema.clone();
    };
    components
        .get("schemas")
        .and_then(|s| s.get(name))
        .cloned()
        .unwrap_or_else(|| schema.clone())
}

fn text_result(text: impl Into<String>, structured: Option<Value>) -> Value {
    let mut obj = json!({ "content": [{ "type": "text", "text": text.into() }] });
    if let Some(s) = structured {
        obj["structuredContent"] = s;
    }
    obj
}

fn ok_response(id: Option<Value>, result: Value) -> Response {
    (
        StatusCode::OK,
        Json(JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }),
    )
        .into_response()
}

fn error_response(id: Option<Value>, http: StatusCode, err: JsonRpcError) -> Response {
    (
        http,
        Json(JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(err),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema_obj() -> Value {
        json!({
            "type": "object",
            "required": ["username"],
            "additionalProperties": false,
            "properties": {
                "username": { "type": "string" },
                "email": { "type": "string" }
            }
        })
    }

    #[test]
    fn validate_body_accepts_valid() {
        let c = json!({});
        assert!(validate_body(&schema_obj(), &json!({"username": "a"}), &c).is_ok());
        assert!(validate_body(&schema_obj(), &json!({"username": "a", "email": "x"}), &c).is_ok());
    }

    #[test]
    fn validate_body_rejects_missing_required() {
        let c = json!({});
        let err = validate_body(&schema_obj(), &json!({"email": "x"}), &c).unwrap_err();
        assert!(err.contains("username"));
    }

    #[test]
    fn validate_body_rejects_unknown_field() {
        let c = json!({});
        let err = validate_body(
            &schema_obj(),
            &json!({"username": "a", "role": "admin"}),
            &c,
        )
        .unwrap_err();
        assert!(err.contains("role"));
    }

    #[test]
    fn validate_body_resolves_ref() {
        let components = json!({ "schemas": { "UserCreate": schema_obj() } });
        let schema = json!({ "$ref": "#/components/schemas/UserCreate" });
        assert!(validate_body(&schema, &json!({"username": "a"}), &components).is_ok());
        assert!(validate_body(&schema, &json!({"email": "x"}), &components)
            .unwrap_err()
            .contains("username"));
    }

    #[test]
    fn validate_body_null_components_is_a_noop_ref_passthrough() {
        // Frontend-action `params_schema`s are self-contained (no `$ref`), so
        // this is the shape `invoke_frontend` calls with.
        assert!(validate_body(&schema_obj(), &json!({"username": "a"}), &Value::Null).is_ok());
    }

    #[test]
    fn substitute_path_replaces_and_validates() {
        let expected = vec!["user_id".to_string()];
        let mut provided = std::collections::HashMap::new();
        provided.insert("user_id".to_string(), "abc-123".to_string());
        assert_eq!(
            substitute_path("/api/users/{user_id}", &expected, &provided).unwrap(),
            "/api/users/abc-123"
        );
    }

    #[test]
    fn substitute_path_rejects_traversal_and_missing() {
        let expected = vec!["id".to_string()];
        let mut bad = std::collections::HashMap::new();
        bad.insert("id".to_string(), "../secret".to_string());
        assert!(substitute_path("/api/x/{id}", &expected, &bad).is_err());

        let empty = std::collections::HashMap::new();
        assert!(substitute_path("/api/x/{id}", &expected, &empty).is_err());

        let mut slash = std::collections::HashMap::new();
        slash.insert("id".to_string(), "a/b".to_string());
        assert!(substitute_path("/api/x/{id}", &expected, &slash).is_err());

        for bad in [".", ".."] {
            let mut m = std::collections::HashMap::new();
            m.insert("id".to_string(), bad.to_string());
            assert!(
                substitute_path("/api/projects/{id}/files", &expected, &m).is_err(),
                "path param '{bad}' must be rejected"
            );
        }
    }

    #[test]
    fn is_path_safe_blocks_dangerous_chars() {
        assert!("abc-123_x.y~z".chars().all(is_path_safe));
        assert!(!is_path_safe('/'));
        assert!(!is_path_safe('?'));
        assert!(!is_path_safe('@'));
        assert!(!is_path_safe(' '));
    }

    fn test_user(is_admin: bool, perms: &[&str]) -> User {
        User {
            id: uuid::Uuid::new_v4(),
            username: "u".into(),
            email: "u@x.y".into(),
            email_verified: true,
            password_hash: None,
            display_name: None,
            avatar_url: None,
            is_active: true,
            is_admin,
            permissions: perms.iter().map(|s| s.to_string()).collect(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            last_login_at: None,
            password_changed_at: None,
        }
    }

    #[test]
    fn frontend_error_result_is_marked_is_error() {
        let entry = FrontendActionEntry {
            id: "project.openProject".to_string(),
            title: "Open a project".to_string(),
            kind: "global".to_string(),
            mutating: true,
            stateful: false,
            context: "global".to_string(),
            permission: "projects::use".to_string(),
            params_schema: json!({}),
            group: None,
            description: None,
            aliases: vec![],
            keywords: vec![],
        };
        let v = frontend_error_result(&entry, "NOT_PERMITTED", "nope");
        assert_eq!(v["isError"], true);
        assert_eq!(v["structuredContent"]["error_code"], "NOT_PERMITTED");
        assert_eq!(v["structuredContent"]["ok"], false);
    }

    #[test]
    fn frontend_success_result_reflects_engine_ok_flag() {
        let entry = FrontendActionEntry {
            id: "app.navigate".to_string(),
            title: "Navigate".to_string(),
            kind: "global".to_string(),
            mutating: true,
            stateful: false,
            context: "global".to_string(),
            permission: "mcp::use".to_string(),
            params_schema: json!({}),
            group: None,
            description: None,
            aliases: vec![],
            keywords: vec![],
        };
        let ok_frame = agent_channel::AgentResultFrame {
            ok: true,
            result: Some(json!({"navigated": true})),
            error: None,
            logs: vec!["did it".to_string()],
        };
        let v = frontend_success_result(&entry, ok_frame);
        assert!(v.get("isError").is_none());
        assert_eq!(v["structuredContent"]["ok"], true);

        let fail_frame = agent_channel::AgentResultFrame {
            ok: false,
            result: None,
            error: Some("boom".to_string()),
            logs: vec![],
        };
        let v = frontend_success_result(&entry, fail_frame);
        assert_eq!(v["isError"], true);
        assert_eq!(v["structuredContent"]["error"], "boom");
    }

    // list_capabilities / describe_capability / invoke_capability's frontend
    // branch: permission filtering happens WITHOUT needing a live agent
    // channel (dispatch is only reached once permission is confirmed).

    #[test]
    fn op_available_denies_denylisted_ops_regardless_of_permission() {
        let user = test_user(false, &["users::create"]);
        let op = Operation {
            operation_id: "Auth.login".to_string(),
            method: "POST".to_string(),
            path_template: "/api/auth/login".to_string(),
            tags: vec![],
            summary: String::new(),
            required_permission: None,
            required_permissions: vec![],
            path_params: vec![],
            request_schema: None,
            json_body: true,
            has_secret_field: false,
            parameters: vec![],
        };
        assert!(!op_available(&user, &[], &op));
    }

    #[test]
    fn op_available_admin_bypasses_permission_but_not_denylist() {
        let admin = test_user(true, &[]);
        let allowed = Operation {
            operation_id: "User.create".to_string(),
            method: "POST".to_string(),
            path_template: "/api/users".to_string(),
            tags: vec![],
            summary: String::new(),
            required_permission: Some("users::create".to_string()),
            required_permissions: vec!["users::create".to_string()],
            path_params: vec![],
            request_schema: None,
            json_body: true,
            has_secret_field: false,
            parameters: vec![],
        };
        assert!(op_available(&admin, &[], &allowed));
    }

    /// ALL-of gating. An operation declaring SEVERAL permissions is available
    /// only to a principal holding EVERY one of them; holding just the first —
    /// which is all the display-only `required_permission` field reports — is
    /// not authorization.
    #[test]
    fn op_available_requires_every_declared_permission() {
        let two = Operation {
            operation_id: "User.create".to_string(),
            method: "POST".to_string(),
            path_template: "/api/users".to_string(),
            tags: vec![],
            summary: String::new(),
            // The display-only FIRST entry, exactly as the catalog stamps it.
            required_permission: Some("users::create".to_string()),
            required_permissions: vec!["users::create".to_string(), "groups::edit".to_string()],
            path_params: vec![],
            request_schema: None,
            json_body: true,
            has_secret_field: false,
            parameters: vec![],
        };

        // Holds only the first of the two → denied.
        let partial = test_user(false, &["users::create"]);
        assert!(
            !op_available(&partial, &[], &two),
            "holding only the first declared permission is not authorization"
        );

        // Holds both → allowed.
        let full = test_user(false, &["users::create", "groups::edit"]);
        assert!(op_available(&full, &[], &two));
    }
}
