//! TEST-106 (`.lifecycle/workbench-analysis/TESTS.md`, covers ITEM-4) — the W1
//! context-gating backend deltas over the merged capability catalogs:
//!
//! - `list_capabilities` reflects EXACTLY the committed manifest. The FE
//!   collector (`scripts/collect-actions.mjs`) already EXCLUDES
//!   `surfaces.ai:false` actions from `frontend-actions.json` and emits no
//!   `surfaces` key at all, so the server never sees an ai-hidden action — it
//!   needs (and does) NO server-side ai filtering. Every manifest action the
//!   caller is permitted to run appears; the server invents nothing the
//!   manifest omits.
//! - `describe_capability` surfaces each capability's `context` precondition
//!   (so the agent navigates to that context first).
//! - an `invoke_capability` for a context-inactive action RELAYS the engine's
//!   `CONTEXT_INACTIVE` verdict as an `isError` tool result — the backend never
//!   judges context itself (this mirrors the `STALE_STATE` relay in
//!   `instance_actions.rs`; ARCHITECTURE.md Layer 5/6: permission =
//!   backend-enforced trust, context/staleness = engine-enforced correctness).

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    create_user, login, next_sse_event, open_agent_stream, post_agent_result, setup_admin,
    tools_call,
};
use crate::common::TestServer;

/// The committed APP-OWNED manifest, embedded at compile time from the SAME file
/// the server bakes in via `frontend_catalog::MANIFEST_JSON`.
const MANIFEST_JSON: &str = include_str!("../../src/modules/mcp/frontend-actions.json");

/// All action ids declared in the committed app-owned manifest.
fn app_owned_ids() -> BTreeSet<String> {
    let manifest: Value = serde_json::from_str(MANIFEST_JSON).expect("committed manifest parses");
    manifest["actions"]
        .as_array()
        .expect("manifest.actions is an array")
        .iter()
        .map(|a| a["id"].as_str().expect("action id is a string").to_string())
        .collect()
}

/// The FULL source-of-truth `list_capabilities` reflects for a caller with NO
/// controlled browser session: the app-owned manifest, and nothing else.
///
/// The VIEW-SCOPED half used to be added here, derived by calling the server's
/// own `scan_view_spec_actions` over `packages/`. That projection is gone —
/// the server no longer parses a view_spec; the controlled session REPORTS what
/// it registered. So the view-scoped half is no longer a function of the repo,
/// it is a function of a live session, and it is proved where it now lives:
/// `view_capabilities.rs`.
fn manifest_ids() -> BTreeSet<String> {
    app_owned_ids()
}

// ------------------------------- TEST-106 (a) -------------------------------

/// `list_capabilities` reflects exactly the committed manifest, with NO
/// server-side ai filtering: the collector already stripped `surfaces.ai:false`
/// upstream, so the server has no `surfaces` notion to filter on.
#[tokio::test]
async fn list_capabilities_reflects_the_committed_manifest_no_server_ai_filtering() {
    // SOURCE-LEVEL: the manifest the server embeds carries NO `surfaces` key
    // and NO `ai` flag — the FE collector excluded every `surfaces.ai:false`
    // action and emitted only ai-visible ones. So there is nothing for the
    // server to ai-filter; it simply surfaces the manifest verbatim.
    assert!(
        !MANIFEST_JSON.contains("\"surfaces\""),
        "the collector must strip `surfaces` from the server manifest (ai-visibility is resolved upstream)"
    );
    assert!(
        !MANIFEST_JSON.contains("\"ai\""),
        "no `ai` flag should reach the server manifest — ai:false actions are pre-excluded by the collector"
    );

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // A full Users-group member holds mcp::use + jobs::use, so they see the
    // manifest's mcp/jobs-scoped actions — the shape the existing
    // `frontend_actions.rs` TEST-8 already proves fits under the list cap.
    // (The project/dataset actions were exercised here before the strip;
    // their `projects::use` grant went with the removed project module, so a
    // Users member no longer sees them — the positive control now uses kept
    // actions the caller IS permitted to run.)
    create_user(&server, &admin, "ctxlister", "ctxlister@x.test").await;
    let user = login(&server, "ctxlister").await;

    let result = tools_call(&server, &user, "list_capabilities", json!({})).await;
    let ops = result["structuredContent"]["operations"]
        .as_array()
        .expect("operations array");
    let frontend_ids: BTreeSet<String> = ops
        .iter()
        .filter(|o| o["kind"] == "frontend")
        .map(|o| o["operation_id"].as_str().unwrap().to_string())
        .collect();

    // Every frontend action the server lists exists in the committed manifest —
    // the server invents nothing and applies no ai-magic of its own.
    let manifest = manifest_ids();
    for id in &frontend_ids {
        assert!(
            manifest.contains(id),
            "list_capabilities returned a frontend id absent from the manifest: {id}"
        );
    }

    // Non-vacuous positive control: kept actions the permitted caller can run —
    // an mcp::use-gated global one, a jobs::use-gated global one, and a
    // jobs::use-gated context-bearing one (`workbench.openJobs`, context
    // "workbench") — are present, so the list is a real reflection of the
    // manifest, not empty.
    for expected in ["app.navigate", "job.create", "workbench.openJobs"] {
        assert!(
            frontend_ids.contains(expected),
            "expected manifest action `{expected}` present for a Users member: {frontend_ids:?}"
        );
    }

    // This caller has NO controlled browser session, so nothing VIEW-SCOPED is
    // invokable and nothing view-scoped may be advertised. (The other half —
    // that a reported view action DOES reach the agent — is
    // `view_capabilities.rs`.)
    let view_scoped: Vec<&String> = frontend_ids.iter().filter(|id| id.contains("::")).collect();
    assert!(
        view_scoped.is_empty(),
        "with no controlled window bound, a view-scoped capability cannot be invoked and must \
         not be listed: {view_scoped:?}"
    );
}

// ------------------------------- TEST-106 (b) -------------------------------

/// `describe_capability` surfaces the action's `context` precondition so the AI
/// knows to navigate to that context before invoking.
#[tokio::test]
async fn describe_capability_surfaces_the_context_precondition() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ctxdescriber", "ctxdescriber@x.test").await;
    let user = login(&server, "ctxdescriber").await;

    // A non-global action names its required context AND flags it as a
    // precondition. `workbench.openJobs` (permission `jobs::use`, held by
    // Users) is context `"workbench"` — the kept vehicle for the context
    // bearing shape the stripped `dataset.process` used to play.
    let open_jobs = tools_call(
        &server,
        &user,
        "describe_capability",
        json!({ "operation_id": "workbench.openJobs" }),
    )
    .await;
    let structured = &open_jobs["structuredContent"];
    assert_eq!(structured["context"], "workbench", "{structured}");
    assert_eq!(structured["context_required"], true, "{structured}");

    // A `"global"` action carries its context but is NOT a precondition (no
    // `context_required` flag) — it is invokable from anywhere.
    let navigate = tools_call(
        &server,
        &user,
        "describe_capability",
        json!({ "operation_id": "app.navigate" }),
    )
    .await;
    let structured = &navigate["structuredContent"];
    assert_eq!(structured["context"], "global", "{structured}");
    assert!(
        structured.get("context_required").is_none(),
        "a global action must not be flagged as a context precondition: {structured}"
    );
}

// ------------------------------- TEST-106 (c) -------------------------------

/// A context-gated action invoked while its context is inactive: the ENGINE
/// (here a simulated one) plays the `CONTEXT_INACTIVE` rejection verbatim, and
/// the backend RELAYS it as an `isError` tool result WITHOUT judging context
/// itself — exactly the shape the `STALE_STATE` relay proves for staleness.
#[tokio::test]
async fn invoke_context_inactive_action_relays_context_inactive_as_iserror() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ctxdriver", "ctxdriver@x.test").await;
    let driver = login(&server, "ctxdriver").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &driver, session_id).await;

    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({
                // A `context:"workbench"` instance action; the caller is NOT on
                // a workbench surface, so the engine will reject it as inactive.
                "operation_id": "workbench.openJobs",
                "body": { "view_id": "v1" }
            }),
        ),
        async {
            let invoke_frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
                .await
                .expect("agent_invoke frame arrives over the real SSE channel");
            assert_eq!(invoke_frame["type"], "agent_invoke");
            assert_eq!(invoke_frame["action_id"], "workbench.openJobs");
            assert_eq!(invoke_frame["view_id"], "v1", "{invoke_frame}");
            let request_id = invoke_frame["request_id"].clone();

            // The simulated engine plays the real `./engine.ts` context-guard's
            // rejection shape verbatim (PLAN.md ITEM-4): `ok: false` with a
            // `CONTEXT_INACTIVE`-prefixed error naming the context, no `result`.
            // The backend does NOT judge context — it only relays this verdict.
            post_agent_result(
                &server,
                &driver,
                request_id,
                false,
                Value::Null,
                Some("CONTEXT_INACTIVE: context \"workbench\" is not active; navigate there first, then retry"),
            )
            .await;
        }
    );

    assert_eq!(invoke_result["isError"], true, "{invoke_result}");
    let structured = &invoke_result["structuredContent"];
    assert_eq!(structured["kind"], "frontend");
    assert_eq!(structured["ok"], false);
    assert!(
        structured["error"]
            .as_str()
            .unwrap_or_default()
            .starts_with("CONTEXT_INACTIVE"),
        "the engine's CONTEXT_INACTIVE verdict is relayed faithfully: {structured}"
    );
}
